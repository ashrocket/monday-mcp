import { createServer, type Server, type ServerResponse } from "node:http";
import { spawn } from "node:child_process";
import { join } from "node:path";
import { userInfo } from "node:os";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopEvaluate, desktopNavigate, desktopTargets, withDesktop, type DesktopOptions } from "../src/desktop.js";

// Real loopback HTTP discovery; the socket double deterministically injects protocol failures.
// No real desktop, profile, credentials, or remote endpoint is used.
class FakeSocket extends EventTarget {
  static OPEN = 1;
  static sockets: FakeSocket[] = [];
  static open = true;
  static behavior: (socket: FakeSocket, message: any) => void;
  readyState = 0;
  closed = false;
  constructor(readonly url: string) {
    super();
    FakeSocket.sockets.push(this);
    if (FakeSocket.open) queueMicrotask(() => {
      if (!this.closed) { this.readyState = 1; this.dispatchEvent(new Event("open")); }
    });
  }
  send(raw: string) { FakeSocket.behavior(this, JSON.parse(raw)); }
  reply(raw: unknown) {
    const event = new Event("message");
    Object.defineProperty(event, "data", { value: typeof raw === "string" ? raw : JSON.stringify(raw) });
    queueMicrotask(() => this.dispatchEvent(event));
  }
  close() {
    if (this.closed) return;
    this.closed = true; this.readyState = 3;
    queueMicrotask(() => this.dispatchEvent(new Event("close")));
  }
}
const servers: Server[] = [];
let responseHandler: ((response: ServerResponse, port: number) => void) | undefined;
let urls: string[];
let advertisedSocket: string | undefined;
let pageUrl: string;
async function fixture(): Promise<DesktopOptions> {
  const server = createServer((_, response) => {
    const port = (server.address() as { port: number }).port;
    if (responseHandler) { responseHandler(response, port); return; }
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify(urls.map((url, index) => ({
      type: "page", url,
      webSocketDebuggerUrl: advertisedSocket ?? `ws://127.0.0.1:${port}/devtools/page/${index}`,
    }))));
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return {
    port: (server.address() as { port: number }).port,
    expectedHost: "test.monday.com", discoveryTimeoutMs: 100,
    connectTimeoutMs: 100, commandTimeoutMs: 100, operationTimeoutMs: 200, lockTimeoutMs: 80,
  };
}
function successful(socket: FakeSocket, message: any) {
  const value = message.params?.expression?.endsWith("\n1") ? 1 : { url: pageUrl };
  socket.reply({ id: message.id, result: message.method === "Runtime.evaluate" ? { result: { value } } : {} });
}
beforeEach(() => {
  urls = ["https://test.monday.com/boards/1/pulses/2"];
  pageUrl = urls[0]!;
  responseHandler = undefined; advertisedSocket = undefined;
  FakeSocket.sockets = []; FakeSocket.open = true; FakeSocket.behavior = successful;
  vi.stubGlobal("WebSocket", FakeSocket);
});
afterEach(async () => {
  for (const socket of FakeSocket.sockets) socket.close();
  await Promise.all(servers.splice(0).map((server) => new Promise<void>((resolve) => {
    server.closeAllConnections(); server.close(() => resolve());
  })));
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
});

describe("desktop target boundaries", () => {
  it.each([
    "https://test.monday.com.evil.example/", "https://evil.example/?monday.com",
    "https://other.monday.com/", "http://test.monday.com/", "https://user@test.monday.com/",
  ])("rejects an untrusted account target %s before opening a socket", async (url) => {
    urls = [url];
    await expect(desktopEvaluate(await fixture(), "1")).rejects.toThrow(/exactly one/);
    expect(FakeSocket.sockets).toHaveLength(0);
  });
  it("rejects ambiguous matching windows", async () => {
    urls.push(urls[0]!);
    await expect(desktopEvaluate(await fixture(), "1")).rejects.toThrow(/found 2/);
  });
  it.each(["ws://example.com:9222/devtools/page/1", "ws://127.0.0.1:1/devtools/page/1", "ws://user@localhost:9222/devtools/page/1"])("rejects advertised socket %s", async (url) => {
    advertisedSocket = url;
    await expect(desktopEvaluate(await fixture(), "1")).rejects.toThrow(/loopback/);
    expect(FakeSocket.sockets).toHaveLength(0);
  });
  it("does not let a websocket override bypass target discovery", async () => {
    const options = await fixture();
    options.wsUrl = `ws://127.0.0.1:${options.port}/devtools/page/unknown`;
    await expect(desktopEvaluate(options, "1")).rejects.toThrow(/found 0/);
  });
  it("rejects cross-account navigation and exact-URL mismatch", async () => {
    const options = await fixture();
    await expect(desktopNavigate(options, "https://other.monday.com/boards/1")).rejects.toThrow(/account origin/);
    pageUrl = "https://test.monday.com/boards/3/pulses/4";
    await expect(desktopNavigate(options, urls[0]!)).rejects.toThrow(/different location/);
  });
});

describe("desktop bounded failure and cleanup", () => {
  it("times out a stalled discovery response body", async () => {
    responseHandler = (response) => { response.writeHead(200); response.write("["); };
    await expect(desktopTargets(await fixture())).rejects.toThrow(/deadline/);
  });
  it("refuses discovery redirects", async () => {
    responseHandler = (response) => { response.writeHead(302, { Location: "http://127.0.0.1:1/" }); response.end(); };
    await expect(desktopTargets(await fixture())).rejects.toThrow(/discover/);
  });
  it("closes a socket that never opens", async () => {
    FakeSocket.open = false;
    await expect(desktopEvaluate(await fixture(), "1")).rejects.toThrow(/did not open/);
    expect(FakeSocket.sockets[0]?.closed).toBe(true);
  });
  it.each(["silent", "close", "error", "malformed", "protocol error"])("rejects pending commands on %s and releases the lock", async (mode) => {
    const options = await fixture();
    FakeSocket.behavior = (socket, message) => {
      if (mode === "close") socket.close();
      if (mode === "error") socket.dispatchEvent(new Event("error"));
      if (mode === "malformed") socket.reply("not JSON");
      if (mode === "protocol error") socket.reply({ id: message.id, error: { message: "bad method" } });
    };
    await expect(desktopEvaluate(options, "1")).rejects.toThrow();
    expect(FakeSocket.sockets[0]?.closed).toBe(true);
    FakeSocket.behavior = successful;
    await expect(desktopEvaluate(options, "1")).resolves.toBe(1);
  });
  it("bounds an arbitrary unfinished operation", async () => {
    const options = await fixture();
    await expect(withDesktop(options, () => new Promise(() => {}))).rejects.toThrow(/deadline/);
    expect(FakeSocket.sockets[0]?.closed).toBe(true);
    await expect(desktopEvaluate(options, "1")).resolves.toBe(1);
  });
  it("bounds viewport cleanup even when the command timeout is longer", async () => {
    const options = { ...await fixture(), operationTimeoutMs: 3_000, commandTimeoutMs: 5_000 };
    FakeSocket.behavior = (socket, message) => {
      if (message.method !== "Emulation.clearDeviceMetricsOverride") successful(socket, message);
    };
    await expect(withDesktop(options, async (session) => { await session.setViewport(100, 100); })).rejects.toThrow(/cleanup timed out/);
    expect(FakeSocket.sockets[0]?.closed).toBe(true);
  });
});

describe("desktop exclusion and cancellation", () => {
  it("rejects contention across processes without deleting the other owner's lock", async () => {
    const options = await fixture();
    const lockRoot = process.platform === "win32" ? userInfo().homedir
      : process.platform === "darwin" ? "/private/tmp" : "/tmp";
    const path = join(lockRoot, `monday-mcp-desktop-${process.getuid?.() ?? "user"}-${options.port}.lock`);
    vi.stubEnv("TMPDIR", "/different-agent-temp");
    vi.stubEnv("TMP", "/different-agent-temp");
    vi.stubEnv("TEMP", "/different-agent-temp");
    const child = spawn(process.execPath, ["-e", `const fs=require('node:fs'); const p=process.argv[1]; fs.mkdirSync(p,{mode:448}); process.stdout.write('ready\\n'); process.stdin.once('data',()=>{fs.rmdirSync(p);process.exit(0)});`, path], { stdio: ["pipe", "pipe", "pipe"] });
    try {
      await new Promise<void>((resolve, reject) => { child.stdout.once("data", () => resolve()); child.once("error", reject); child.once("exit", (code) => { if(code) reject(new Error(`child failed ${code}`)); }); });
      await expect(desktopEvaluate(options, "1")).rejects.toThrow(/busy/);
      expect(FakeSocket.sockets).toHaveLength(0);
    } finally {
      const ended = new Promise<void>((resolve) => child.once("exit", () => resolve()));
      child.stdin.write("release"); await ended;
    }
    await expect(desktopEvaluate(options, "1")).resolves.toBe(1);
  });
  it("cancels queued work before it can open a second socket", async () => {
    const options = await fixture();
    let release!: () => void;
    let entered!: () => void;
    const inside = new Promise<void>((resolve) => { entered = resolve; });
    const first = withDesktop(options, async () => { entered(); await new Promise<void>((resolve) => { release = resolve; }); });
    await inside;
    const controller = new AbortController();
    const queued = desktopEvaluate({ ...options, signal: controller.signal }, "1");
    controller.abort();
    await expect(queued).rejects.toThrow(/cancelled/);
    expect(FakeSocket.sockets).toHaveLength(1);
    release(); await first;
    await expect(desktopEvaluate(options, "1")).resolves.toBe(1);
  });
  it("cancels active work and prevents further commands from its session", async () => {
    const options = await fixture();
    const controller = new AbortController();
    let saved: any;
    const result = withDesktop({ ...options, signal: controller.signal }, async (session) => {
      saved = session; controller.abort(); await new Promise(() => {});
    });
    await expect(result).rejects.toThrow(/cancelled/);
    await expect(saved.evaluate("1")).rejects.toThrow();
    expect(FakeSocket.sockets[0]?.closed).toBe(true);
    await expect(desktopEvaluate(options, "1")).resolves.toBe(1);
  });
});
