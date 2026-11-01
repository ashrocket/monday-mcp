import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MondayClient } from "../src/client.js";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { looksLikeMutation } from "../src/tools/raw.js";
import { FakeMonday } from "./fake-monday.js";

function config(overrides: Partial<Config> = {}): Config {
  return {
    token: "security-test-token",
    apiUrl: "https://api.monday.test/v2",
    apiVersion: "2026-07",
    readOnly: false,
    allowedBoards: new Set(),
    timeoutMs: 1_000,
    maxRetries: 0,
    ...overrides,
  };
}

function response(data: unknown): Response {
  return new Response(JSON.stringify({ data }), { status: 200 });
}

function textOf(result: CallToolResult): string {
  return result.content.flatMap((part) => part.type === "text" ? [part.text] : []).join("\n");
}

const cleanup: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((close) => close()));
});

async function connect(settings: Config, fetchImpl: typeof fetch) {
  const server = createServer(settings, fetchImpl);
  const client = new Client({ name: "security-test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  cleanup.push(async () => { await client.close(); await server.close(); });
  return async (name: string, args: Record<string, unknown>) =>
    await client.callTool({ name, arguments: args }) as CallToolResult;
}

describe("GraphQL operation authorization", () => {
  it.each(["\r", "\r\n", "\n"])("blocks mutation after a comment terminated by %j", async (newline) => {
    const api = new FakeMonday();
    const call = await connect(config({ readOnly: true }), api.fetch);
    const result = await call("monday_graphql", {
      query: `# harmless comment${newline}mutation { delete_item(item_id: 555) { id } }`,
    });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/read-only/);
    expect(api.calls).toHaveLength(0);
  });

  it("recognizes query strings, block strings, fragments, and mutation field names", () => {
    expect(looksLikeMutation(`query { search(text: "# mutation") { ...Result } }
      fragment Result on Item { mutation: id }`)).toBe(false);
    expect(looksLikeMutation('query { search(text: """mutation # text""") { id } }')).toBe(false);
  });

  it.each([
    "# only a comment",
    "mutation {",
    "query A { me { id } } mutation B { delete_item(item_id: 555) { id } }",
    "fragment F on Item { id }",
    "subscription { updates { id } }",
  ])("rejects unsupported or ambiguous documents before network: %s", async (query) => {
    const api = new FakeMonday();
    const call = await connect(config(), api.fetch);
    expect((await call("monday_graphql", { query })).isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("also enforces read-only at the transport boundary", async () => {
    const fetchMock = vi.fn();
    const client = new MondayClient(config({ readOnly: true }), fetchMock as typeof fetch);
    await expect(client.query("# comment\rmutation { x }")).rejects.toThrow(/read-only/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    `query { me { id } } #${"a".repeat(128 * 1024)}`,
    `query { ${"id ".repeat(10_000)} }`,
  ])("bounds raw GraphQL parsing before any network request", async (query) => {
    const api = new FakeMonday();
    const call = await connect(config(), api.fetch);
    const result = await call("monday_graphql", { query });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/limit|complex/);
    expect(api.calls).toHaveLength(0);
  });
});

describe("board authorization", () => {
  it.each(["999", "222", null])("rejects a cursor page whose board is %j, without exposing item content", async (actualBoard) => {
    const fetchMock = vi.fn(async () => response({
      next_items_page: {
        cursor: "private-next-cursor",
        items: [{ id: "555", name: "private-item-content", board: actualBoard ? { id: actualBoard, name: "private" } : null }],
      },
    }));
    // Even another allowed board must not be misrepresented as board 111.
    const call = await connect(config({ allowedBoards: new Set(["111", "222"]) }), fetchMock as typeof fetch);
    const result = await call("monday_list_items", { board_id: "111", cursor: "foreign-cursor" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/private-item-content|private-next-cursor/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("allows a cursor page whose returned items belong to the requested board", async () => {
    const api = new FakeMonday();
    const call = await connect(config({ allowedBoards: new Set(["111"]) }), api.fetch);
    const result = await call("monday_list_items", { board_id: "111", cursor: "c1" });
    expect(result.isError).toBeFalsy();
    expect(JSON.parse(textOf(result)).items[0].board.id).toBe("111");
  });

  it("rechecks membership before a write after a previously allowed item moves", async () => {
    const api = new FakeMonday();
    let currentBoard = "111";
    let membershipReads = 0;
    const fetchImpl: typeof fetch = async (url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("query GetItemBoards")) {
        membershipReads += 1;
        return response({ items: [{ id: "555", board: { id: currentBoard } }] });
      }
      return api.fetch(url, init);
    };
    const call = await connect(config({ allowedBoards: new Set(["111"]) }), fetchImpl);
    expect((await call("monday_list_updates", { item_id: "555" })).isError).toBeFalsy();
    currentBoard = "999";
    const result = await call("monday_delete_item", { item_id: "555" });
    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outside the allowed board list/);
    expect(membershipReads).toBe(2);
    expect(api.lastCall("ArchiveItem")).toBeUndefined();
  });

  it("validates the board carried by detail results before exposing their content", async () => {
    const fetchImpl: typeof fetch = async (_url, init) => {
      const { query } = JSON.parse(String(init?.body));
      if (query.includes("query GetItemBoards")) {
        return response({ items: [{ id: "555", board: { id: "111" } }] });
      }
      return response({ items: [{ id: "555", name: "private-item-content", board: { id: "999", name: "private" } }] });
    };
    const call = await connect(config({ allowedBoards: new Set(["111"]) }), fetchImpl);
    const result = await call("monday_get_items", { item_ids: ["555"] });
    expect(result.isError).toBe(true);
    expect(textOf(result)).not.toMatch(/private-item-content/);
  });
});
