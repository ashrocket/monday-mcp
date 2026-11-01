import { chmod, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium, type Browser } from "playwright-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { BackgroundBrowser, type BrowserSession } from "../src/browser.js";

const TARGET = "https://test.monday.com/boards/111";
const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
  vi.restoreAllMocks();
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function fakeBrowser() {
  let url = "about:blank";
  const page = {
    url: () => url,
    goto: vi.fn(async (target: string) => { url = target; }),
    evaluate: vi.fn(async (_expression: string): Promise<unknown> => "fixture"),
    setViewportSize: vi.fn(async () => {}),
    on: vi.fn(),
  };
  const context = { route: vi.fn(async () => {}), newPage: vi.fn(async () => page) };
  const browser = { newContext: vi.fn(async () => context), close: vi.fn(async () => {}) };
  const launch = vi.spyOn(chromium, "launch").mockResolvedValue(browser as unknown as Browser);
  const driver = new BackgroundBrowser({ timeoutMs: 2_000 });
  cleanups.push(() => driver.close());
  return { driver, page, context, browser, launch, redirect: (target: string) => { url = target; } };
}

describe("private background browser", () => {
  it("reuses one private browser/page and avoids navigating an already warm target", async () => {
    const { driver, page, launch, browser } = fakeBrowser();
    expect(await driver.navigate(TARGET)).toBe("fixture");
    expect(await driver.navigate(TARGET)).toBe("fixture");
    expect(launch).toHaveBeenCalledTimes(1);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ headless: true, channel: "chrome" }));
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ serviceWorkers: "block", acceptDownloads: false }));
    expect(page.goto).toHaveBeenCalledTimes(1);
    expect(page.goto).toHaveBeenCalledWith(TARGET, expect.objectContaining({ waitUntil: "domcontentloaded" }));
  });

  it("serializes complete operations and invalidates a retained session", async () => {
    const { driver } = fakeBrowser();
    const started = deferred<void>();
    const release = deferred<void>();
    let retained!: BrowserSession;
    const events: string[] = [];
    const first = driver.run(TARGET, async (session) => {
      retained = session; events.push("first"); started.resolve();
      await release.promise;
      events.push("first done"); return 1;
    });
    await started.promise;
    const second = driver.run(TARGET, async () => { events.push("second"); return 2; });
    expect(events).toEqual(["first"]);
    release.resolve();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
    expect(events).toEqual(["first", "first done", "second"]);
    await expect(retained.evaluate("1")).rejects.toThrow(/ended/);
  });

  it.each([
    "http://test.monday.com/boards/1", "https://test.monday.com:443/boards/1",
    "https://user@test.monday.com/boards/1", "https://test.monday.com.evil.test/boards/1",
    "https://test.monday.com/boards/1/../2", "https://test.monday.com/boards/%31",
    "https://test.monday.com/login", "https://test.monday.com/boards/1?redirect=https://evil.test",
  ])("rejects unsafe target before browser launch: %s", async (target) => {
    const { driver, launch } = fakeBrowser();
    await expect(driver.navigate(target)).rejects.toThrow(/target/);
    expect(launch).not.toHaveBeenCalled();
  });

  it("permits safe workdoc identifiers and pins the first account", async () => {
    const { driver } = fakeBrowser();
    await driver.navigate("https://test.monday.com/docs/d-b");
    await driver.navigate("https://test.monday.com/boards/1/pulses/2?doc_id=d&blockId=b");
    await expect(driver.navigate("https://other.monday.com/boards/1")).rejects.toThrow(/another account/);
  });

  it.each([
    "https://test.monday.com/login", "https://evil.test/boards/111",
    "https://test.monday.com/boards/222", `${TARGET}?doc_id=wrong`,
  ])("does not extract a redirected target: %s", async (redirected) => {
    const { driver, page, browser, redirect } = fakeBrowser();
    page.goto.mockImplementation(async () => { redirect(redirected); });
    await expect(driver.navigate(TARGET)).rejects.toThrow(/redirected/);
    expect(page.evaluate).not.toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("rejects a full queue and rejects all pending operations on shutdown", async () => {
    const { driver, browser } = fakeBrowser();
    const started = deferred<void>();
    const active = driver.run(TARGET, async () => { started.resolve(); return new Promise(() => {}); });
    await started.promise;
    const pending = Array.from({ length: 31 }, () => driver.navigate(TARGET));
    const outcomes = Promise.allSettled([active, ...pending]);
    await expect(driver.navigate(TARGET)).rejects.toThrow(/queue is full/);
    await driver.close();
    expect((await outcomes).every((result) => result.status === "rejected")).toBe(true);
    expect(browser.close).toHaveBeenCalledTimes(1);
    await expect(driver.navigate(TARGET)).rejects.toThrow(/closed/);
  });

  it("closes the browser to terminate evaluation when the operation times out", async () => {
    const { page, browser } = fakeBrowser();
    const driver = new BackgroundBrowser({ timeoutMs: 25 });
    cleanups.push(() => driver.close());
    const evaluation = deferred<unknown>();
    page.evaluate.mockImplementation(() => evaluation.promise);
    browser.close.mockImplementation(async () => { evaluation.reject(new Error("Page closed")); });
    await expect(driver.navigate(TARGET)).rejects.toThrow(/timed out/);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("interrupts context initialization before waiting for it to settle", async () => {
    const { browser } = fakeBrowser();
    const driver = new BackgroundBrowser({ timeoutMs: 25 });
    cleanups.push(() => driver.close());
    const initialization = deferred<Awaited<ReturnType<typeof browser.newContext>>>();
    browser.newContext.mockImplementation(() => initialization.promise);
    browser.close.mockImplementation(async () => { initialization.reject(new Error("Browser closed")); });
    await expect(driver.navigate(TARGET)).rejects.toThrow(/timed out/);
    expect(browser.close).toHaveBeenCalledTimes(1);
  });

  it("closes resources on body failure and relaunches for the next operation", async () => {
    const { driver, browser, launch } = fakeBrowser();
    await expect(driver.run(TARGET, async () => { throw new Error("fixture failed"); })).rejects.toThrow("fixture failed");
    expect(browser.close).toHaveBeenCalledTimes(1);
    await driver.navigate(TARGET);
    expect(launch).toHaveBeenCalledTimes(2);
  });

  it("closes a browser that finishes launching after shutdown", async () => {
    const { driver, browser, launch } = fakeBrowser();
    const launching = deferred<Browser>();
    launch.mockReturnValue(launching.promise);
    const result = driver.navigate(TARGET);
    const outcome = Promise.allSettled([result]);
    await Promise.resolve();
    const closing = driver.close();
    launching.resolve(browser as unknown as Browser);
    await closing;
    expect((await outcome)[0]?.status).toBe("rejected");
    expect(browser.close).toHaveBeenCalledTimes(1);
  });
});

describe("read-only authentication snapshot", () => {
  async function snapshot(content: string, mode = 0o600) {
    const dir = await mkdtemp(join(tmpdir(), "monday-browser-state-"));
    cleanups.push(() => rm(dir, { recursive: true, force: true }));
    const path = join(dir, "state.json");
    await writeFile(path, content, { mode });
    return path;
  }

  it("loads explicit private storage state without rewriting it", async () => {
    const { browser, launch } = fakeBrowser();
    const content = JSON.stringify({ cookies: [], origins: [] });
    const path = await snapshot(content);
    const driver = new BackgroundBrowser({ statePath: path, executablePath: "/explicit/test/chrome" });
    cleanups.push(() => driver.close());
    await driver.navigate(TARGET);
    expect(launch).toHaveBeenCalledWith(expect.objectContaining({ executablePath: "/explicit/test/chrome" }));
    expect(launch.mock.calls[0]?.[0]).not.toHaveProperty("channel");
    expect(browser.newContext).toHaveBeenCalledWith(expect.objectContaining({ storageState: { cookies: [], origins: [] } }));
    expect(await readFile(path, "utf8")).toBe(content);
  });

  it.each(["not json", "{}", "[]", "x".repeat(5 * 1024 * 1024 + 1)])("rejects an invalid or oversized snapshot", async (content) => {
    const { launch } = fakeBrowser();
    const driver = new BackgroundBrowser({ statePath: await snapshot(content) });
    cleanups.push(() => driver.close());
    await expect(driver.navigate(TARGET)).rejects.toThrow();
    expect(launch).not.toHaveBeenCalled();
  });

  it.skipIf(process.platform === "win32")("rejects credentials readable by other users", async () => {
    const { launch } = fakeBrowser();
    const path = await snapshot('{"cookies":[],"origins":[]}');
    await chmod(path, 0o644);
    const driver = new BackgroundBrowser({ statePath: path });
    cleanups.push(() => driver.close());
    await expect(driver.navigate(TARGET)).rejects.toThrow(/0600/);
    expect(launch).not.toHaveBeenCalled();
  });
});

// Explicit opt-in: launches a fresh process, never a normal browser profile.
// Every browser request is fulfilled or aborted in memory; no live account traffic.
it.skipIf(!process.env.MONDAY_TEST_BROWSER_EXECUTABLE)("isolated Chromium fixture: warm reuse, serialization, redirects, and cancellation", async () => {
  const realLaunch = chromium.launch.bind(chromium);
  const launched: Browser[] = [];
  let pageLoads = 0;
  vi.spyOn(chromium, "launch").mockImplementation(async (options) => {
    const browser = await realLaunch(options);
    launched.push(browser);
    const newContext = browser.newContext.bind(browser);
    vi.spyOn(browser, "newContext").mockImplementation(async (contextOptions) => {
      const context = await newContext(contextOptions);
      // Install before newPage resolves: no fixture navigation can outrun interception.
      const newPage = context.newPage.bind(context);
      vi.spyOn(context, "newPage").mockImplementation(async () => {
        const page = await newPage();
        await page.route("**/*", async (route) => {
          const url = new URL(route.request().url());
          if (url.origin !== "https://test.monday.com") { await route.abort(); return; }
          if (url.pathname === "/boards/redirect") {
            await route.fulfill({ contentType: "text/html", body: '<script>history.replaceState({}, "", "/login")</script>' });
            return;
          }
          pageLoads += 1;
          await route.fulfill({ contentType: "text/html", body: '<html><head><title>Local fixture</title></head><body><div id="value">fixture</div></body></html>' });
        });
        return page;
      });
      return context;
    });
    return browser;
  });
  // Cold browser startup is slower on shared hosts; the production default is
  // 60 seconds. Short operation deadlines are covered by the unit fixtures.
  const driver = new BackgroundBrowser({ executablePath: process.env.MONDAY_TEST_BROWSER_EXECUTABLE, timeoutMs: 20_000 });
  cleanups.push(() => driver.close());
  const coldStarted = performance.now();
  expect(await driver.run(TARGET, (session) => session.evaluate('document.querySelector("#value").textContent'))).toBe("fixture");
  const coldStartMs = performance.now() - coldStarted;
  const loaded = pageLoads;
  await driver.navigate(TARGET);
  expect(pageLoads).toBe(loaded);
  const values = await Promise.all([1, 2, 3].map((n) => driver.run(TARGET, (session) => session.evaluate(`new Promise(resolve => setTimeout(() => resolve(${n}), 10))`))));
  expect(values).toEqual([1, 2, 3]);
  expect(launched).toHaveLength(1);
  const second = new BackgroundBrowser({executablePath:process.env.MONDAY_TEST_BROWSER_EXECUTABLE,timeoutMs:20_000});
  cleanups.push(() => second.close());
  await Promise.all([
    driver.run(TARGET,s => s.evaluate('globalThis.agentMarker = "agent-a"')),
    second.run(TARGET,s => s.evaluate('globalThis.agentMarker = "agent-b"')),
  ]);
  const measurements:number[]=[];
  const isolated = await Promise.all(Array.from({length:20},(_,i) => {
    const started=performance.now();
    return (i%2 ? second : driver).run(TARGET,s => s.evaluate('globalThis.agentMarker')).then(value => {
      measurements.push(performance.now()-started);return value;
    });
  }));
  expect(isolated).toEqual(Array.from({length:20},(_,i)=>i%2 ? "agent-b" : "agent-a"));
  measurements.sort((a,b)=>a-b);
  const report = {fixture:"isolated-headless-browser",instances:2,reads:20,
    mismatches:0,coldStartMs,warmQueueP50Ms:measurements[9],warmQueueP95Ms:measurements[18]};
  await second.close();
  await expect(driver.navigate("https://test.monday.com/boards/redirect")).rejects.toThrow();
  expect(launched[0]?.isConnected()).toBe(false);
  const timeoutDriver = new BackgroundBrowser({ executablePath: process.env.MONDAY_TEST_BROWSER_EXECUTABLE, timeoutMs: 20_000 });
  cleanups.push(() => timeoutDriver.close());
  await timeoutDriver.navigate(TARGET);
  const hanging = timeoutDriver.run(TARGET, (session) => session.evaluate("new Promise(() => {})"));
  const failed = expect(hanging).rejects.toThrow(/closed/);
  await new Promise((resolve) => setTimeout(resolve, 50));
  await timeoutDriver.close();
  await failed;
  expect(launched.every((browser) => !browser.isConnected())).toBe(true);
  if (process.env.MONDAY_TEST_BROWSER_REPORT) {
    await writeFile(process.env.MONDAY_TEST_BROWSER_REPORT, JSON.stringify({ passed:true, ...report,
      scope:"Synthetic intercepted pages; no live account or personal browser profile", allBrowsersClosed:true }, null, 2) + "\n");
  }
}, 90_000);
