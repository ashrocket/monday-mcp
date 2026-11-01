import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { FakeMonday } from "./fake-monday.js";

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => { await Promise.all(cleanup.splice(0).map((close) => close())); });

function textOf(result: CallToolResult): string {
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

async function connect(
  override?: (query: string) => Response | undefined,
  overrides: Partial<Config> = {},
) {
  const config: Config = {
    token: "partial-write-fixture", apiUrl: "https://api.monday.test/v2", apiVersion: "2026-07",
    readOnly: false, allowedBoards: new Set(), timeoutMs: 1_000, maxRetries: 2,
    ...overrides,
  };
  const api = new FakeMonday();
  const queries: string[] = [];
  const fetchImpl: typeof fetch = async (url, init) => {
    const { query } = JSON.parse(String(init?.body)) as { query: string };
    queries.push(query);
    return override?.(query) ?? api.fetch(url, init);
  };
  const server = createServer(config, fetchImpl);
  const client = new Client({ name: "partial-write-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return {
    api, queries,
    call: async (name: string, args: Record<string, unknown>) =>
      await client.callTool({ name, arguments: args }) as CallToolResult,
  };
}

describe("subitem partial-success receipts", () => {
  it("retains the created subitem after the schema lookup fails", async () => {
    const { api, call } = await connect();
    api.errorOnOperation = { operation: "GetBoard", message: "Schema temporarily unavailable" };
    const result = await call("monday_create_subitem", {
      parent_item_id: "555", name: "A step", values: { Notes: "detail" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "partial_success", created: { id: "600" }, column_values_status: "not_applied",
    });
    expect(textOf(result)).toMatch(/Subitem 600 was created successfully\. Do not recreate it/);
    expect(api.calls.filter((entry) => entry.operation === "CreateSubitem")).toHaveLength(1);
    expect(api.lastCall("ChangeColumnValues")).toBeUndefined();
  });

  it("retains the created subitem after local column validation fails", async () => {
    const { api, call } = await connect();
    const result = await call("monday_create_subitem", {
      parent_item_id: "555", name: "A step", values: { "No such column": "detail" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({ created: { id: "600" }, column_values_status: "not_applied" });
    expect(api.lastCall("ChangeColumnValues")).toBeUndefined();
    expect(textOf(result)).toMatch(/Do not recreate it/);
  });

  it.each(["network", "503"])("reports an ambiguous %s failure after creation without replaying either mutation", async (failure) => {
    let writes = 0;
    const { api, call } = await connect((query) => {
      if (!query.includes("mutation ChangeColumnValues")) return undefined;
      writes += 1;
      if (failure === "network") throw new Error("socket disconnected after commit");
      return new Response("{}", { status: 503 });
    });
    const result = await call("monday_create_subitem", {
      parent_item_id: "555", name: "A step", values: { Notes: "detail" },
    });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "partial_success", created: { id: "600" }, column_values_status: "unknown",
    });
    expect(textOf(result)).toMatch(/Check its current column values/);
    expect(writes).toBe(1);
    expect(api.calls.filter((entry) => entry.operation === "CreateSubitem")).toHaveLength(1);
  });
});

describe("rename and column update ordering", () => {
  it("does not rename when the column schema cannot be loaded", async () => {
    const { api, call } = await connect();
    api.errorOnOperation = { operation: "GetBoard", message: "Schema lookup denied" };
    const result = await call("monday_update_item", { item_id: "555", name: "Renamed", values: { Notes: "detail" } });
    expect(result.isError).toBe(true);
    expect(api.lastCall("ChangeItemName")).toBeUndefined();
    expect(api.lastCall("ChangeColumnValues")).toBeUndefined();
    expect(textOf(result)).not.toMatch(/DID succeed/);
  });

  it("does not rename when a column value is invalid", async () => {
    const { api, call } = await connect();
    const result = await call("monday_update_item", { item_id: "555", name: "Renamed", values: { Status: "Unknown label" } });
    expect(result.isError).toBe(true);
    expect(api.lastCall("ChangeItemName")).toBeUndefined();
    expect(api.lastCall("ChangeColumnValues")).toBeUndefined();
  });

  it("preserves the applied rename receipt after an ambiguous column-write error", async () => {
    const { api, call } = await connect((query) => query.includes("mutation ChangeColumnValues")
      ? new Response("{}", { status: 503 }) : undefined);
    const result = await call("monday_update_item", { item_id: "555", name: "Renamed", values: { Notes: "detail" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "partial_success", item_id: "555", renamed: { name: "Renamed" }, column_values_status: "unknown",
    });
    expect(textOf(result)).toMatch(/rename to "Renamed" DID succeed/);
    expect(api.calls.map((entry) => entry.operation).slice(-2)).toEqual(["GetBoard", "ChangeItemName"]);
  });

  it("preserves the rename even if formatting the acknowledged column response fails", async () => {
    const { call } = await connect((query) => query.includes("mutation ChangeColumnValues")
      ? response({ change_multiple_column_values: null }) : undefined);
    const result = await call("monday_update_item", { item_id: "555", name: "Renamed", values: { Notes: "detail" } });
    expect(result.isError).toBe(true);
    expect(result.structuredContent).toMatchObject({
      status: "partial_success", item_id: "555", renamed: { name: "Renamed" }, column_values_status: "unknown",
    });
  });
});

describe("update response membership", () => {
  it.each([
    { label: "moved board", id: "555", board: { id: "999" } },
    { label: "foreign item", id: "777", board: { id: "111" } },
    { label: "missing board", id: "555", board: null },
  ])("rejects $label despite an allowed preflight lookup", async ({ id, board }) => {
    const { api, call } = await connect((query) => query.includes("query GetItemUpdates")
      ? response({ items: [{ id, board, name: "private item", updates: [{ body: "private conversation" }] }] })
      : undefined, { allowedBoards: new Set(["111"]) });
    const result = await call("monday_list_updates", { item_id: "555" });
    expect(api.lastCall("GetItemBoards")).toBeDefined();
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/private item|private conversation/);
  });

  it("requires the requested item even without an allowlist", async () => {
    const { call } = await connect((query) => query.includes("query GetItemUpdates")
      ? response({ items: [{ id: "777", board: { id: "111" }, updates: [{ body: "private conversation" }] }] })
      : undefined);
    expect((await call("monday_list_updates", { item_id: "555" })).isError).toBe(true);
  });

  it("requests membership with updates and returns the authorized conversation", async () => {
    const { call, queries } = await connect(undefined, { allowedBoards: new Set(["111"]) });
    const result = await call("monday_list_updates", { item_id: "555" });
    expect(result.isError).toBeFalsy();
    expect(queries.find((query) => query.includes("query GetItemUpdates"))).toMatch(/board\s*\{\s*id\s*\}/);
    expect(JSON.parse(textOf(result)).updates[0].text_body).toBe("looks good");
  });
});
