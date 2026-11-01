import { afterEach, describe, expect, it, vi } from "vitest";
import { MondayClient } from "../src/client.js";
import type { Config } from "../src/config.js";

const config = (timeoutMs = 30_000): Config => ({
  token: "fixture-token", desktopOnly: false, debugPort: 9222,
  apiUrl: "http://127.0.0.1/fixture", apiVersion: "2026-07",
  readOnly: false, allowedBoards: new Set(), timeoutMs, maxRetries: 3,
});
const abortError = () => new DOMException("Aborted", "AbortError");
const query = "query Read { me { id } }";

afterEach(() => vi.useRealTimers());

describe("total request deadline", () => {
  it("caps a retry at the remaining budget after an initial request timeout and backoff", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    const aborted: number[] = [];
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => {
        aborted.push(Date.now() - started);
        reject(abortError());
      }, { once: true });
    }));
    const client = new MondayClient(config(), fetchImpl, () => Date.now());
    const outcome = client.query(query).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(44_999);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(aborted).toEqual([30_000]);
    await vi.advanceTimersByTimeAsync(1);
    expect(String(await outcome)).toMatch(/request timed out after 14500 ms.*total request deadline of 45000 ms/i);
    expect(aborted).toEqual([30_000, 45_000]);
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("keeps the remaining-budget timer active while the response body stalls", async () => {
    vi.useFakeTimers();
    const started = Date.now();
    let calls = 0;
    const fetchImpl: typeof fetch = async (_url, init) => {
      calls += 1;
      if (calls === 1) {
        await new Promise((resolve) => setTimeout(resolve, 20_000));
        return new Response("{}", { status: 503 });
      }
      return new Response(new ReadableStream({
        start(controller) {
          init!.signal!.addEventListener("abort", () => controller.error(abortError()), { once: true });
        },
      }), { status: 200 });
    };
    const client = new MondayClient(config(), fetchImpl, () => Date.now());
    const outcome = client.query(query).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(String(await outcome)).toMatch(/response body timed out after 24500 ms.*total request deadline of 45000 ms/i);
    expect(Date.now() - started).toBe(45_000);
    expect(calls).toBe(2);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("caps even the first attempt when its configured timeout exceeds the total budget", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn<typeof fetch>(async (_url, init) => new Promise<Response>((_resolve, reject) => {
      init!.signal!.addEventListener("abort", () => reject(abortError()), { once: true });
    }));
    const client = new MondayClient(config(120_000), fetchImpl, () => Date.now());
    const outcome = client.query(query).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(45_000);
    expect(String(await outcome)).toMatch(/request timed out after 45000 ms/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it("does not start another request when scheduling delay exhausts the budget during backoff", async () => {
    vi.useFakeTimers();
    let elapsed = 0;
    const fetchImpl = vi.fn<typeof fetch>(async () => new Response("{}", { status: 503 }));
    const client = new MondayClient(config(), fetchImpl, () => elapsed);
    const outcome = client.query(query).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(0);
    elapsed = 45_001;
    await vi.advanceTimersByTimeAsync(500);
    expect(String(await outcome)).toMatch(/total request deadline of 45000 ms/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("explains the uncertain outcome of a failed mutation without replaying it", async () => {
    const fetchImpl = vi.fn<typeof fetch>(async () => { throw new TypeError("fetch failed"); });
    const client = new MondayClient(config(), fetchImpl);
    await expect(client.query("mutation Write { create_item(board_id: 111, item_name: \"x\") { id } }"))
      .rejects.toThrow(/mutation was sent once and may have committed\. Check the current state before manually retrying/);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
