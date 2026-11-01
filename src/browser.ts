import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { chromium, type Browser, type BrowserContextOptions, type Page } from "playwright-core";

export interface BrowserOptions {
  statePath?: string;
  executablePath?: string;
  timeoutMs?: number;
}

export interface BrowserSession {
  evaluate(expression: string): Promise<unknown>;
  setViewport(width: number, height: number): Promise<void>;
}

export class BrowserError extends Error {
  override name = "BrowserError";
}

const MAX_STATE_BYTES = 5 * 1024 * 1024;
const MAX_PENDING = 32;
const PATH = /^\/(?:my_work|boards\/[A-Za-z0-9_-]+(?:\/(?:views\/[A-Za-z0-9_-]+|pulses\/[A-Za-z0-9_-]+(?:\/posts\/[A-Za-z0-9_-]+)?))?|docs\/[A-Za-z0-9_-]+|workspaces\/[A-Za-z0-9_-]+|overviews\/[A-Za-z0-9_-]+)\/?$/;

function targetUrl(raw: string): URL {
  // Check the original authority/path: URL normalizes :443 and dot segments.
  const parts = /^https:\/\/([a-z0-9](?:[a-z0-9-]*[a-z0-9])?)\.monday\.com(\/[^?#]*)(?:\?[^#]*)?$/.exec(raw);
  if (!parts || !PATH.test(parts[2]!) || /[\s\\]/.test(raw)) {
    throw new BrowserError("Browser target must be an exact HTTPS monday.com account URL with a supported path.");
  }
  const url = new URL(raw);
  const seen = new Set<string>();
  for (const [key, value] of url.searchParams) {
    if (seen.has(key) || !["asset_id", "doc_id", "blockId"].includes(key) ||
        !(key === "blockId" ? /^[A-Za-z0-9_-]{1,200}$/ : /^[A-Za-z0-9_-]+$/).test(value)) {
      throw new BrowserError("Browser target contains an unsupported query parameter.");
    }
    seen.add(key);
  }
  return url;
}

function sameTarget(actual: string, expected: URL): boolean {
  try {
    const url = targetUrl(actual);
    url.searchParams.sort();
    const wanted = new URL(expected.href);
    wanted.searchParams.sort();
    return url.href === wanted.href;
  } catch { return false; }
}

async function storageState(path: string): Promise<Exclude<BrowserContextOptions["storageState"], string | undefined>> {
  const file = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
  try {
    const stat = await file.stat();
    if (!stat.isFile() || stat.size > MAX_STATE_BYTES ||
        (process.platform !== "win32" && ((stat.mode & 0o777) !== 0o600 || stat.uid !== process.getuid?.()))) {
      throw new BrowserError("Browser state must be an owned regular file, at most 5 MiB, with permissions 0600.");
    }
    const bytes = Buffer.alloc(MAX_STATE_BYTES + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await file.read(bytes, length, bytes.length - length, null);
      if (read.bytesRead === 0) break;
      length += read.bytesRead;
    }
    if (length > MAX_STATE_BYTES) throw new BrowserError("Browser state exceeds 5 MiB.");
    let value: unknown;
    try { value = JSON.parse(bytes.subarray(0, length).toString("utf8")); }
    catch { throw new BrowserError("Browser state is not valid JSON."); }
    if (!value || typeof value !== "object" || Array.isArray(value) ||
        !Array.isArray((value as { cookies?: unknown }).cookies) ||
        !Array.isArray((value as { origins?: unknown }).origins)) {
      throw new BrowserError("Browser state must contain cookies and origins arrays.");
    }
    return value as Exclude<BrowserContextOptions["storageState"], string | undefined>;
  } finally { await file.close(); }
}

interface Job {
  target: URL;
  body: (session: BrowserSession) => Promise<unknown>;
  resolve: (value: unknown) => void;
  reject: (error: unknown) => void;
  deadline: number;
  timer: ReturnType<typeof setTimeout>;
  stopped: boolean;
  cancel: (error: Error) => void;
  cancelled: Promise<never>;
}

/** Owns a private headless process; never attaches to a browser or user profile. */
export class BackgroundBrowser {
  private readonly timeoutMs: number;
  private browser?: Browser;
  private page?: Page;
  private initializing?: Promise<void>;
  private origin?: string;
  private target?: URL;
  private closed = false;
  private active?: Job;
  private readonly queue: Job[] = [];
  private draining?: Promise<void>;
  private closing?: Promise<void>;

  constructor(private readonly options: BrowserOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    if (!Number.isSafeInteger(this.timeoutMs) || this.timeoutMs < 1 || this.timeoutMs > 300_000) {
      throw new BrowserError("Browser timeout must be integer milliseconds between 1 and 300000.");
    }
  }

  run<T>(url: string, body: (session: BrowserSession) => Promise<T>): Promise<T> {
    if (this.closed) return Promise.reject(new BrowserError("Background browser is closed."));
    let target: URL;
    try {
      target = targetUrl(url);
      if (this.origin && target.origin !== this.origin) throw new BrowserError("Browser target belongs to another account.");
    } catch (error) { return Promise.reject(error); }
    if (this.queue.length + (this.active ? 1 : 0) >= MAX_PENDING) {
      return Promise.reject(new BrowserError("Background browser queue is full (32 operations)."));
    }
    this.origin ??= target.origin;
    return new Promise<T>((resolve, reject) => {
      let cancel!: (error: Error) => void;
      const cancelled = new Promise<never>((_resolve, cancelReject) => { cancel = cancelReject; });
      // A queued cancellation can happen before the execution race is attached.
      void cancelled.catch(() => {});
      const job: Job = {
        target, body, resolve: (value) => resolve(value as T), reject,
        deadline: Date.now() + this.timeoutMs, stopped: false, cancel, cancelled,
        timer: setTimeout(() => {
          job.stopped = true;
          const error = new BrowserError(`Background browser operation timed out after ${this.timeoutMs}ms.`);
          job.cancel(error);
          if (this.active !== job) {
            const index = this.queue.indexOf(job);
            if (index !== -1) this.queue.splice(index, 1);
            job.reject(error);
          }
        }, this.timeoutMs),
      };
      this.queue.push(job);
      this.kick();
    });
  }

  navigate(url: string): Promise<unknown> {
    return this.run(url, (session) => session.evaluate("({ url: location.href, title: document.title })"));
  }

  close(): Promise<void> {
    this.closed = true;
    const error = new BrowserError("Background browser is closed.");
    for (const job of this.queue.splice(0)) {
      clearTimeout(job.timer); job.stopped = true; job.cancel(error); job.reject(error);
    }
    if (this.active) { this.active.stopped = true; this.active.cancel(error); }
    this.closing ??= (async () => {
      await this.draining;
      await this.dispose();
    })();
    return this.closing;
  }

  private check(job: Job): void {
    if (job.stopped || this.closed || Date.now() >= job.deadline) {
      throw new BrowserError("Background browser operation has ended.");
    }
  }

  private async dispose(): Promise<void> {
    const initializing = this.initializing;
    const closeCurrent = async () => {
      const browser = this.browser;
      this.browser = undefined;
      this.page = undefined;
      this.target = undefined;
      if (browser) await browser.close();
    };
    // Close first to interrupt a pending newContext/newPage call. If launch
    // itself is still pending, close its eventual process before proceeding.
    await closeCurrent();
    await initializing?.catch(() => {});
    await closeCurrent();
  }

  private async ensurePage(job: Job): Promise<Page> {
    if (!this.page) {
      this.initializing = (async () => {
        const state = this.options.statePath ? await storageState(this.options.statePath) : undefined;
        this.check(job);
        this.browser = await chromium.launch({
          headless: true,
          ...(this.options.executablePath ? { executablePath: this.options.executablePath } : { channel: "chrome" }),
          timeout: Math.max(1, job.deadline - Date.now()),
        });
        this.check(job);
        const context = await this.browser.newContext({ storageState: state, acceptDownloads: false, serviceWorkers: "block" });
        this.check(job);
        await context.route("**/*", async (route) => {
          const request = route.request();
          if (request.isNavigationRequest() && !request.frame().parentFrame() &&
              (!this.target || !sameTarget(request.url(), this.target))) {
            await route.abort("blockedbyclient");
          } else { await route.continue(); }
        });
        this.check(job);
        this.page = await context.newPage();
        this.page.on("popup", (popup) => { void popup.close().catch(() => {}); });
        this.check(job);
      })();
      try { await this.initializing; } finally { this.initializing = undefined; }
    }
    this.check(job);
    return this.page!;
  }

  private async execute(job: Job): Promise<unknown> {
    const page = await this.ensurePage(job);
    this.target = job.target;
    if (page.url() !== job.target.href) {
      await page.goto(job.target.href, { waitUntil: "domcontentloaded", timeout: Math.max(1, job.deadline - Date.now()) });
    }
    const verify = () => {
      this.check(job);
      if (!sameTarget(page.url(), job.target)) throw new BrowserError("Browser redirected away from the requested target; authentication may be required.");
    };
    verify();
    const session: BrowserSession = {
      evaluate: async (expression) => {
        verify();
        // Verify inside the execution context too, before and after awaiting an
        // expression, so a redirect cannot expose data from another location.
        const result = await page.evaluate(`(async () => {
          const expected = new URL(${JSON.stringify(job.target.href)});
          expected.searchParams.sort();
          const verify = () => {
            const actual = new URL(location.href); actual.searchParams.sort();
            if (actual.href !== expected.href) throw new Error("Browser target changed during evaluation.");
          };
          verify();
          const result = await (0, eval)(${JSON.stringify(expression)});
          verify();
          return result;
        })()`);
        verify();
        return result;
      },
      setViewport: async (width, height) => {
        verify();
        if (![width, height].every((n) => Number.isInteger(n) && n >= 1 && n <= 10_000)) {
          throw new BrowserError("Browser viewport dimensions must be integers from 1 to 10000.");
        }
        await page.setViewportSize({ width, height });
        verify();
      },
    };
    const result = await job.body(session);
    verify();
    return result;
  }

  private kick(): void {
    if (this.draining) return;
    this.draining = this.drain().finally(() => {
      this.draining = undefined;
      if (this.queue.length && !this.closed) this.kick();
    });
  }

  private async drain(): Promise<void> {
    while (this.queue.length > 0 && !this.closed) {
      const job = this.queue.shift()!;
      this.active = job;
      try {
        const value = await Promise.race([this.execute(job), job.cancelled]);
        this.check(job);
        job.resolve(value);
      } catch (error) {
        job.stopped = true;
        try { await this.dispose(); }
        catch { this.closed = true; }
        job.reject(error);
      } finally {
        job.stopped = true;
        clearTimeout(job.timer);
        this.active = undefined;
      }
    }
    if (this.closed) {
      for (const job of this.queue.splice(0)) {
        clearTimeout(job.timer); job.stopped = true;
        job.reject(new BrowserError("Background browser is closed."));
      }
    }
  }
}
