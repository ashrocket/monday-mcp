import { mkdir, rmdir } from "node:fs/promises";
import { userInfo } from "node:os";
import { join } from "node:path";

/**
 * Drives the monday.com macOS desktop app (an Electron shell hosting the web
 * app in a <webview>) over the Chrome DevTools Protocol.
 *
 * scripts/cdp-desktop.mjs imports the built package implementation so the CLI
 * shares the same discovery checks, cross-process lock, and deadlines.
 *
 * SECURITY: this talks to a port opened by `--remote-debugging-port`, which is
 * UNAUTHENTICATED. Any local process can drive that logged-in session. The
 * server never launches the app; it only attaches to a port the user chose to
 * open.
 */

/** Raised when the desktop app cannot be reached or driven. */
export class DesktopError extends Error {
  override name = "DesktopError";
}

interface CdpTarget {
  type: string;
  url: string;
  title?: string;
  webSocketDebuggerUrl?: string;
}

interface CdpMessage {
  id?: number;
  error?: { message?: string };
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    data?: string;
  };
}

export interface DesktopOptions {
  port: number;
  /** Selects one discovered target by socket URL; cannot bypass discovery checks. */
  wsUrl?: string;
  /** How long to wait for the socket to open. */
  connectTimeoutMs?: number;
  /** Exact account hostname. Discovery rejects other accounts and ambiguous targets. */
  expectedHost?: string;
  discoveryTimeoutMs?: number;
  commandTimeoutMs?: number;
  operationTimeoutMs?: number;
  lockTimeoutMs?: number;
  /** Cancels discovery, queued lock acquisition, and active commands. */
  signal?: AbortSignal;
}

/**
 * Node gained a global WebSocket in 22. package.json declares engines >=20, so
 * detect rather than widen the engine range and break API-only installs.
 */
export function desktopRuntimeProblem(): string | null {
  if (typeof (globalThis as { WebSocket?: unknown }).WebSocket === "undefined") {
    return (
      "The desktop tools need Node 22 or newer, because they use the built-in " +
      `WebSocket. This process runs ${process.version}. The API tools are unaffected.`
    );
  }
  return null;
}

function duration(value: number | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value < 1 || value > 300_000) {
    throw new DesktopError("Desktop deadlines must be integer milliseconds between 1 and 300000.");
  }
  return value;
}

function checkOptions(options: DesktopOptions): void {
  for (const value of [options.discoveryTimeoutMs, options.connectTimeoutMs,
    options.commandTimeoutMs, options.operationTimeoutMs, options.lockTimeoutMs]) duration(value, 5_000);
  if (!Number.isInteger(options.port) || options.port < 1 || options.port > 65535) {
    throw new DesktopError("The desktop debug port must be between 1 and 65535.");
  }
  if (options.expectedHost !== undefined && !/^[a-z0-9][a-z0-9-]*\.monday\.com$/.test(options.expectedHost)) {
    throw new DesktopError("expectedHost must be an exact monday.com account hostname.");
  }
}

function accountUrl(raw: string, expectedHost?: string): URL {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DesktopError("Invalid desktop target URL."); }
  if (url.protocol !== "https:" || url.username || url.password || url.port ||
      !/^[a-z0-9][a-z0-9-]*\.monday\.com$/.test(url.hostname) ||
      (expectedHost && url.hostname !== expectedHost)) {
    throw new DesktopError("Desktop target does not match the permitted monday.com account origin.");
  }
  return url;
}

function socketUrl(raw: string, port: number): string {
  let url: URL;
  try { url = new URL(raw); } catch { throw new DesktopError("Invalid desktop socket URL."); }
  if (url.protocol !== "ws:" || !["localhost", "127.0.0.1", "[::1]"].includes(url.hostname) ||
      Number(url.port || 80) !== port || url.username || url.password || url.hash || url.search ||
      !/^\/devtools\/page\/[^/]+$/.test(url.pathname)) {
    throw new DesktopError("Desktop socket must use the configured loopback debug port and a page target.");
  }
  return url.href;
}

async function listTargets(options: DesktopOptions): Promise<CdpTarget[]> {
  checkOptions(options);
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) controller.abort();
  const timer = setTimeout(abort, duration(options.discoveryTimeoutMs, 5_000));
  try {
    const response = await fetch(`http://127.0.0.1:${options.port}/json`, {
      signal: controller.signal, redirect: "error",
    });
    if (!response.ok) throw new DesktopError(`The debug port answered ${response.status} for /json.`);
    if (Number(response.headers.get("content-length")) > 1_048_576) {
      controller.abort();
      throw new DesktopError("The debug target list exceeds its size limit.");
    }
    const reader = response.body?.getReader();
    if (!reader) throw new DesktopError("The debug target list has no body.");
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 1_048_576) {
          controller.abort();
          throw new DesktopError("The debug target list exceeds its size limit.");
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    const targets: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
    if (!Array.isArray(targets) || targets.length > 1000 || targets.some((target) =>
      !target || typeof target !== "object" || typeof target.type !== "string" ||
      typeof target.url !== "string" ||
      (target.webSocketDebuggerUrl !== undefined && typeof target.webSocketDebuggerUrl !== "string"))) {
      throw new DesktopError("The debug endpoint returned invalid targets.");
    }
    return targets as CdpTarget[];
  } catch (error) {
    if (error instanceof DesktopError) throw error;
    throw new DesktopError(
      `Cannot discover desktop targets on localhost:${options.port}. Start the app with ` +
      `--remote-debugging-port=${options.port}; discovery must answer within its deadline.`,
    );
  } finally { clearTimeout(timer); options.signal?.removeEventListener("abort", abort); }
}

/** Never choose an account or window merely because it was listed first. */
async function findWebview(options: DesktopOptions): Promise<{ wsUrl: string; host: string }> {
  checkOptions(options);
  const override = options.wsUrl ? socketUrl(options.wsUrl, options.port) : undefined;
  const targets = await listTargets(options);
  const candidates = targets.filter((target) => {
    if (!["webview", "page"].includes(target.type)) return false;
    try { accountUrl(target.url, options.expectedHost); } catch { return false; }
    return true;
  }).filter((target) => !override || target.webSocketDebuggerUrl === override);
  if (candidates.length !== 1) {
    throw new DesktopError(`Expected exactly one matching monday.com desktop target; found ${candidates.length}.`);
  }
  const target = candidates[0]!;
  if (!target.webSocketDebuggerUrl) throw new DesktopError("The desktop target has no socket URL.");
  return { wsUrl: socketUrl(target.webSocketDebuggerUrl, options.port), host: accountUrl(target.url).hostname };
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<CdpMessage>;

interface Session {
  send: Send;
  close: () => void;
}

async function connect(wsUrl: string, connectTimeoutMs: number, commandTimeoutMs: number, signal?: AbortSignal): Promise<Session> {
  const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketCtor) throw new DesktopError(desktopRuntimeProblem() ?? "No WebSocket.");
  const socket = new WebSocketCtor(wsUrl);
  let nextId = 0;
  let failure: DesktopError | undefined;
  let opened = false;
  const pending = new Map<number, {
    resolve: (message: CdpMessage) => void;
    reject: (error: DesktopError) => void;
    timer: ReturnType<typeof setTimeout>;
  }>();
  let rejectOpen: (error: DesktopError) => void = () => {};
  const stop = (error: DesktopError): void => {
    if (failure) return;
    failure = error;
    signal?.removeEventListener("abort", abort);
    rejectOpen(error);
    for (const entry of pending.values()) { clearTimeout(entry.timer); entry.reject(error); }
    pending.clear();
    try { socket.close(); } catch { /* Already disconnected. */ }
  };
  const abort = () => stop(new DesktopError("The desktop operation was cancelled."));
  socket.addEventListener("message", (event: MessageEvent) => {
    let message: CdpMessage;
    try {
      const raw = String(event.data);
      if (raw.length > 16_777_216) throw new Error();
      const parsed: unknown = JSON.parse(raw);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error();
      message = parsed as CdpMessage;
      if (message.id !== undefined && (!Number.isSafeInteger(message.id) || message.id < 1)) throw new Error();
    } catch { stop(new DesktopError("The debug socket returned a malformed message.")); return; }
    if (message.id === undefined) return; // CDP event.
    const entry = pending.get(message.id);
    if (!entry) return;
    clearTimeout(entry.timer);
    pending.delete(message.id);
    if (message.error) {
      const contextGone = typeof message.error.message === "string" &&
        /Cannot find context|Execution context was destroyed/i.test(message.error.message);
      entry.reject(new DesktopError(contextGone
        ? "The execution context was destroyed."
        : "The debug socket rejected a CDP command."));
    } else if (!message.result || typeof message.result !== "object") {
      entry.reject(new DesktopError("The debug socket returned an invalid command result."));
    } else { entry.resolve(message); }
  });
  socket.addEventListener("error", () => stop(new DesktopError("The debug socket connection failed.")));
  socket.addEventListener("close", () => stop(new DesktopError("The debug socket closed.")));
  await new Promise<void>((resolve, reject) => {
    rejectOpen = reject;
    const timer = setTimeout(() => stop(new DesktopError(`The debug socket did not open within ${connectTimeoutMs}ms.`)), connectTimeoutMs);
    socket.addEventListener("open", () => { opened = true; clearTimeout(timer); resolve(); }, { once: true });
    // Ensure failure also clears the connect timer.
    rejectOpen = (error) => { clearTimeout(timer); reject(error); };
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
  });
  const send: Send = (method, params = {}) => new Promise((resolve, reject) => {
    if (failure || !opened || socket.readyState !== WebSocketCtor.OPEN) {
      reject(failure ?? new DesktopError("The debug socket is not open.")); return;
    }
    const id = ++nextId;
    const timer = setTimeout(() => stop(new DesktopError(`The debug command timed out after ${commandTimeoutMs}ms.`)), commandTimeoutMs);
    pending.set(id, { resolve, reject, timer });
    try { socket.send(JSON.stringify({ id, method, params })); }
    catch { stop(new DesktopError("Could not send the debug command.")); }
  });
  return { send, close: () => stop(new DesktopError("The desktop session has ended.")) };
}

/** Cross-process exclusion. An abandoned lock requires explicit operator recovery. */
async function lockDesktop(options: DesktopOptions): Promise<() => Promise<void>> {
  checkOptions(options);
  // All processes controlling this port must agree even when their temporary
  // directory environment differs. userInfo reads the OS account on Windows.
  const lockRoot = process.platform === "win32" ? userInfo().homedir
    : process.platform === "darwin" ? "/private/tmp" : "/tmp";
  const lock = join(lockRoot, `monday-mcp-desktop-${process.getuid?.() ?? "user"}-${options.port}.lock`);
  const deadline = Date.now() + duration(options.lockTimeoutMs, 5_000);
  for (;;) {
    if (options.signal?.aborted) throw new DesktopError("The queued desktop operation was cancelled.");
    try {
      await mkdir(lock, { mode: 0o700 });
      if (options.signal?.aborted) {
        await rmdir(lock);
        throw new DesktopError("The queued desktop operation was cancelled.");
      }
      return async () => { await rmdir(lock); };
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline) {
        throw new DesktopError(`Desktop port ${options.port} is busy or has an abandoned lock. No lock was removed.`);
      }
      await sleep(Math.min(50, Math.max(1, deadline - Date.now())));
    }
  }
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

/**
 * Waits for a live JS execution context.
 *
 * Page.navigate destroys the old context, so an evaluate issued straight after
 * it runs against a dead one and comes back null — which reads exactly like "the
 * page loaded but the element is missing". Probe with a trivial expression until
 * the new context answers, then run the real one.
 */
async function waitForContext(send: Send, timeoutMs = 15_000): Promise<void> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try {
      if ((await evaluate(send, "1")) === 1) return;
    } catch (error) {
      // Retry only context teardown, never a closed/timed-out/cancelled session.
      if (!(error instanceof DesktopError) || !/execution context|context.*destroyed|Cannot find context/i.test(error.message)) throw error;
    }
    await sleep(300);
  }
  throw new DesktopError(
    `No live JS context ${timeoutMs}ms after navigating. The webview may still be loading.`,
  );
}

/** Runs an expression in the webview and returns its value. */
async function evaluate(send: Send, expression: string): Promise<unknown> {
  await send("Runtime.enable");
  const reply = await send("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
    allowUnsafeEvalBlockedByCSP: true,
  });
  const failure = reply.result?.exceptionDetails;
  if (failure) {
    throw new DesktopError(
      failure.exception?.description ?? failure.text ?? "The expression threw.",
    );
  }
  return reply.result?.result?.value ?? null;
}

/**
 * Waits for an item card after navigation.
 *
 * A cold deep-link to /pulses/<id> only appears to hang: it hangs under drivers
 * that wait for document-idle, because the SPA never goes idle. Polling for the
 * element works. See docs/interface-map.md §3.1.
 */
const POLL_CARD = `(async () => {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const start = Date.now();
  // A cold board load is slow: 18s was not enough here and produced a false
  // "the card did not open" on a page that was merely still mounting.
  while (Date.now() - start < 45000) {
    if (location.pathname.includes('/pulses/') &&
        document.querySelector('[data-testid="new-post-update-placeholder"],[data-testid="posts-list-container"]')) break;
    await sleep(400);
  }
  await sleep(600);
  return {
    url: location.href,
    title: document.title,
    posts: document.querySelectorAll('[data-testid="post-component"]').length,
    has_composer: !!document.querySelector('[data-testid="new-post-update-placeholder"]'),
  };
})()`;

/** Opens a session, runs the body, and always closes the socket. */
async function withSession<T>(
  options: DesktopOptions,
  body: (send: Send) => Promise<T>,
): Promise<T> {
  const problem = desktopRuntimeProblem();
  if (problem) throw new DesktopError(problem);
  const release = await lockDesktop(options);
  let session: Session | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let abort: (() => void) | undefined;
  try {
    const target = await findWebview(options);
    session = await connect(target.wsUrl, duration(options.connectTimeoutMs, 5_000), duration(options.commandTimeoutMs, 60_000), options.signal);
    const active = session;
    const send: Send = (method, params) => {
      if (method === "Page.navigate") accountUrl(String(params?.url ?? ""), target.host);
      if (method === "Runtime.evaluate" && typeof params?.expression === "string") {
        // The origin check executes in the same JavaScript task as the expression.
        // A manual navigation after discovery must not expose a different account.
        params = { ...params, expression:
          `if (globalThis.location.origin !== ${JSON.stringify(`https://${target.host}`)}) ` +
          `{ throw new Error("Desktop account origin changed."); }\n${params.expression}` };
      }
      return active.send(method, params);
    };
    const deadline = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        active.close();
        reject(new DesktopError("The desktop operation exceeded its deadline."));
      }, duration(options.operationTimeoutMs, 90_000));
    });
    const cancelled = new Promise<never>((_, reject) => {
      abort = () => {
        active.close();
        reject(new DesktopError("The desktop operation was cancelled."));
      };
      options.signal?.addEventListener("abort", abort, { once: true });
      if (options.signal?.aborted) abort();
    });
    return await Promise.race([body(send), deadline, cancelled]);
  } finally {
    if (timer) clearTimeout(timer);
    if (abort) options.signal?.removeEventListener("abort", abort);
    session?.close();
    await release();
  }
}

/** Navigate and evaluate against one connection. */
export interface DesktopSession {
  navigate: (url: string) => Promise<unknown>;
  evaluate: (expression: string) => Promise<unknown>;
  /**
   * Types text through the browser's own input pipeline.
   *
   * document.execCommand("insertText") only mutates the DOM, so a rich-text
   * editor that keeps its own model never sees the change and its submit
   * control stays inert. Input.insertText goes through the real pipeline, which
   * those editors do observe.
   */
  insertText: (text: string) => Promise<void>;
  /**
   * Clicks at viewport coordinates with real mouse events.
   *
   * monday's submit control is a DIV whose handler does not always run from a
   * synthetic element.click(). Dispatching through the input pipeline does.
   */
  clickAt: (x: number, y: number) => Promise<void>;
  /**
   * Overrides the rendered viewport size.
   *
   * The item card is a right-anchored panel that can extend past the window:
   * measured live, its submit control sat at x=1813 in a 1360px viewport, so no
   * pointer event could reach it. Widening pulls the whole panel into the
   * addressable area. Call before navigating so layout settles at the new size.
   * The override is cleared when the session closes.
   */
  setViewport: (width: number, height: number) => Promise<void>;
}

/**
 * Runs several steps over a single CDP connection.
 *
 * A caller that navigates and then inspects must do both here: separate calls
 * would reconnect between steps, so the check would observe a different
 * session than the navigation it is meant to be checking.
 */
export async function withDesktop<T>(
  options: DesktopOptions,
  body: (session: DesktopSession) => Promise<T>,
): Promise<T> {
  return withSession(options, async (send) => {
    let viewportOverridden = false;
    const session: DesktopSession = {
      setViewport: async (width, height) => {
        await send("Emulation.setDeviceMetricsOverride", {
          width,
          height,
          deviceScaleFactor: 1,
          mobile: false,
        });
        viewportOverridden = true;
      },
      navigate: async (url) => {
        await send("Page.enable");
        await send("Page.navigate", { url });
        await waitForContext(send);
        return verifyNavigation(send, url);
      },
      evaluate: (expression) => evaluate(send, expression),
      insertText: async (text) => {
        await send("Input.insertText", { text });
      },
      clickAt: async (x, y) => {
        await send("Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
        await send("Input.dispatchMouseEvent", {
          type: "mousePressed",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
        await send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          x,
          y,
          button: "left",
          clickCount: 1,
        });
      },
    };
    try {
      return await body(session);
    } finally {
      // Never leave the user's window rendering at an emulated size.
      if (viewportOverridden) {
        let cleanupTimer: ReturnType<typeof setTimeout> | undefined;
        try {
          await Promise.race([
            send("Emulation.clearDeviceMetricsOverride"),
            new Promise<never>((_, reject) => {
              cleanupTimer = setTimeout(() => reject(new DesktopError("Desktop viewport cleanup timed out.")), 1_000);
            }),
          ]);
        } finally { if (cleanupTimer) clearTimeout(cleanupTimer); }
      }
    }
  });
}

/** Lists what the debug port exposes. Useful when discovery fails. */
export async function desktopTargets(options: DesktopOptions): Promise<CdpTarget[]> {
  const problem = desktopRuntimeProblem();
  if (problem) throw new DesktopError(problem);
  return listTargets(options);
}

/** Navigates the webview and waits for the card to settle. */
export async function desktopNavigate(
  options: DesktopOptions,
  url: string,
): Promise<unknown> {
  return withSession(options, async (send) => {
    await send("Page.enable");
    await send("Page.navigate", { url });
    await waitForContext(send);
    return verifyNavigation(send, url);
  });
}

/** Evaluates an expression in the already-open webview. */
export async function desktopEvaluate(
  options: DesktopOptions,
  expression: string,
): Promise<unknown> {
  return withSession(options, (send) => evaluate(send, expression));
}

/** Refuse redirects or navigation races instead of reporting the requested location as loaded. */
async function verifyNavigation(send: Send, url: string): Promise<unknown> {
  const page = await evaluate(send, POLL_CARD);
  if (!page || typeof page !== "object" || !("url" in page) ||
      page.url !== new URL(url).href) {
    throw new DesktopError("The desktop loaded a different location than requested. No action was performed.");
  }
  return page;
}

/** CLI screenshot support shares discovery, exclusion, and deadlines with all other operations. */
export async function desktopScreenshot(options: DesktopOptions): Promise<string> {
  return withSession(options, async (send) => {
    await send("Page.enable");
    const reply = await send("Page.captureScreenshot", { format: "png" });
    if (typeof reply.result?.data !== "string") throw new DesktopError("The desktop returned no screenshot.");
    return reply.result.data;
  });
}
