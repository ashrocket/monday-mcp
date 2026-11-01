import { afterEach, describe, expect, it, vi } from "vitest";
import { MondayClient } from "../src/client.js";
import type { Config } from "../src/config.js";
import { FakeMonday } from "./fake-monday.js";

const config = (token: string): Config => ({
  token, desktopOnly: false, debugPort: 9222,
  apiUrl: "http://127.0.0.1/fixture", apiVersion: "2026-07",
  readOnly: false, allowedBoards: new Set(), timeoutMs: 1_000, maxRetries: 2,
});
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), {
  status, headers: { "content-type": "application/json", "retry-after": "0" },
});

afterEach(() => vi.useRealTimers());

describe("concurrent requests and write ambiguity", () => {
  it("keeps variables and responses isolated when two clients finish requests in reverse order", async () => {
    const fixture = new FakeMonday();
    const pending: Array<() => void> = [];
    const ids = Array.from({ length: 12 }, (_, i) => String(100 + i));
    let allArrived!: () => void;
    const ready = new Promise<void>((resolve) => { allArrived = resolve; });
    const fetchImpl: typeof fetch = async (url, init) => {
      const response = await fixture.fetch(url, init);
      await new Promise<void>((resolve) => {
        pending.push(resolve);
        if (pending.length === ids.length) allArrived();
      });
      return response;
    };
    const clients = [new MondayClient(config("agent-0"), fetchImpl), new MondayClient(config("agent-1"), fetchImpl)];
    const work = ids.map((id, i) => clients[i % 2]!.query<{ items: Array<{ id: string; name: string }> }>(
      "query GetItems($ids: [ID!]!) { items(ids: $ids) { id name } }", { ids: [id], limit: 1 },
    ));
    await ready;
    for (const resolve of [...pending].reverse()) resolve();
    const responses = await Promise.all(work);
    expect(responses.map((response) => response.items[0]?.id)).toEqual(ids);
    expect(fixture.calls.map((call) => call.variables.ids)).toEqual(ids.map((id) => [id]));
    expect(fixture.calls).toHaveLength(ids.length);
  });

  it("bounds retry counts independently for concurrent rate-limited calls", async () => {
    vi.useFakeTimers();
    const attempts = new Map<string, number>();
    const client = new MondayClient(config("test"), async (_url, init) => {
      const { variables } = JSON.parse(String(init?.body)) as { variables: { marker: string } };
      const count = (attempts.get(variables.marker) ?? 0) + 1;
      attempts.set(variables.marker, count);
      return variables.marker === "recover" && count === 3
        ? json({ data: { marker: variables.marker } })
        : json({ errors: [{ message: "Rate limited" }] }, 429);
    });
    const outcomes = Promise.allSettled(["recover", "exhaust"].map((marker) =>
      client.query("query Read { me { id } }", { marker })));
    await vi.runAllTimersAsync();
    const results = await outcomes;
    expect(results[0]).toEqual({ status: "fulfilled", value: { marker: "recover" } });
    expect(results[1]?.status).toBe("rejected");
    expect(Object.fromEntries(attempts)).toEqual({ recover: 3, exhaust: 3 });
  });

  it.each(["503", "network"])("does not repeat a committed mutation after an ambiguous %s failure", async (failure) => {
    vi.useFakeTimers();
    let committed = 0;
    const client = new MondayClient(config("test"), async () => {
      committed += 1;
      if (failure === "network") throw new TypeError("fetch failed: socket closed after commit");
      return json({ errors: [{ message: "reply lost after commit" }] }, 503);
    });
    const outcome = client.query("mutation CreateItem { create_item(board_id: 111, item_name: \"x\") { id } }")
      .then(() => ({ rejected: false }), () => ({ rejected: true }));
    await vi.runAllTimersAsync();
    expect(await outcome).toEqual({ rejected: true });
    expect(committed).toBe(1);
  });
});
