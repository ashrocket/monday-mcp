/**
 * Drives the monday.com macOS desktop app (an Electron shell hosting the web
 * app in a <webview>) over the Chrome DevTools Protocol.
 *
 * This is the in-package twin of scripts/cdp-desktop.mjs, which the README
 * documents as a standalone CLI. The logic is duplicated on purpose: `scripts/`
 * is not in package.json "files", so a published install cannot reach it. Keep
 * the two in step, or delete one.
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
  result?: {
    result?: { value?: unknown };
    exceptionDetails?: { text?: string; exception?: { description?: string } };
    data?: string;
  };
}

export interface DesktopOptions {
  port: number;
  /** Overrides target discovery. Mirrors the WS env var on the CLI twin. */
  wsUrl?: string;
  /** How long to wait for the socket to open. */
  connectTimeoutMs?: number;
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

async function listTargets(port: number): Promise<CdpTarget[]> {
  let response: Response;
  try {
    response = await fetch(`http://localhost:${port}/json`);
  } catch (error) {
    throw new DesktopError(
      `Nothing is listening on localhost:${port}. Start the desktop app with ` +
        "a debug port:\n" +
        "  osascript -e 'quit app \"monday.com\"'\n" +
        `  /Applications/monday.com.app/Contents/MacOS/monday.com --remote-debugging-port=${port} &\n` +
        `(${(error as Error).message})`,
    );
  }
  if (!response.ok) {
    throw new DesktopError(`The debug port answered ${response.status} for /json.`);
  }
  return (await response.json()) as CdpTarget[];
}

/** Finds the webview that hosts monday.com. */
async function findWebview(options: DesktopOptions): Promise<string> {
  if (options.wsUrl) return options.wsUrl;
  const targets = await listTargets(options.port);
  const wanted =
    targets.find((t) => t.type === "webview" && /monday\.com/.test(t.url)) ??
    targets.find((t) => t.type === "page" && /monday\.com/.test(t.url));
  if (!wanted?.webSocketDebuggerUrl) {
    throw new DesktopError(
      "The debug port is open but no monday.com webview is attached. Is the " +
        "app signed in and showing a monday.com view? Use list_targets to see " +
        `what is there (${targets.length} target(s) found).`,
    );
  }
  return wanted.webSocketDebuggerUrl;
}

type Send = (method: string, params?: Record<string, unknown>) => Promise<CdpMessage>;

interface Session {
  send: Send;
  close: () => void;
}

async function connect(wsUrl: string, connectTimeoutMs: number): Promise<Session> {
  const WebSocketCtor = (globalThis as { WebSocket?: typeof WebSocket }).WebSocket;
  if (!WebSocketCtor) throw new DesktopError(desktopRuntimeProblem() ?? "No WebSocket.");

  const socket = new WebSocketCtor(wsUrl);
  let nextId = 0;
  const pending = new Map<number, (message: CdpMessage) => void>();

  socket.addEventListener("message", (event: MessageEvent) => {
    const message = JSON.parse(String(event.data)) as CdpMessage;
    if (message.id !== undefined && pending.has(message.id)) {
      pending.get(message.id)?.(message);
      pending.delete(message.id);
    }
  });

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new DesktopError(`The debug socket did not open within ${connectTimeoutMs}ms.`));
    }, connectTimeoutMs);
    socket.addEventListener("open", () => {
      clearTimeout(timer);
      resolve();
    });
    socket.addEventListener("error", () => {
      clearTimeout(timer);
      reject(new DesktopError("The debug socket refused the connection."));
    });
  });

  const send: Send = (method, params = {}) =>
    new Promise((resolve) => {
      const id = (nextId += 1);
      pending.set(id, resolve);
      socket.send(JSON.stringify({ id, method, params }));
    });

  return { send, close: () => socket.close() };
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
    } catch {
      // The context is still being torn down or rebuilt.
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
  const wsUrl = await findWebview(options);
  const session = await connect(wsUrl, options.connectTimeoutMs ?? 5_000);
  try {
    return await body(session.send);
  } finally {
    session.close();
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
        return evaluate(send, POLL_CARD);
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
      if (viewportOverridden) await send("Emulation.clearDeviceMetricsOverride");
    }
  });
}

/** Lists what the debug port exposes. Useful when discovery fails. */
export async function desktopTargets(options: DesktopOptions): Promise<CdpTarget[]> {
  const problem = desktopRuntimeProblem();
  if (problem) throw new DesktopError(problem);
  return listTargets(options.port);
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
    return evaluate(send, POLL_CARD);
  });
}

/** Evaluates an expression in the already-open webview. */
export async function desktopEvaluate(
  options: DesktopOptions,
  expression: string,
): Promise<unknown> {
  return withSession(options, (send) => evaluate(send, expression));
}
