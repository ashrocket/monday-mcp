import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { beforeEach, describe, expect, it } from "vitest";
import type { Config } from "../src/config.js";
import { createServer } from "../src/server.js";
import { FakeMonday } from "./fake-monday.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "test-token",
    apiUrl: "https://api.monday.test/v2",
    apiVersion: "2024-10",
    readOnly: false,
    allowedBoards: new Set<string>(),
    timeoutMs: 5_000,
    maxRetries: 0,
    ...overrides,
  };
}

async function connect(config: Config = makeConfig()) {
  const api = new FakeMonday();
  const server = createServer(config, api.fetch);
  const client = new Client({ name: "test", version: "1.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)]);
  return { api, client, server };
}

/** Reads the text payload of a tool result. */
function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): any {
  return JSON.parse(textOf(result));
}

describe("tool registration", () => {
  it("offers the full tool set when writes are allowed", async () => {
    const { client } = await connect();
    const names = (await client.listTools()).tools.map((tool) => tool.name).sort();

    expect(names).toEqual([
      "monday_create_item",
      "monday_create_subitem",
      "monday_create_update",
      "monday_delete_item",
      "monday_get_board",
      "monday_get_items",
      "monday_get_me",
      "monday_graphql",
      "monday_list_boards",
      "monday_list_items",
      "monday_list_updates",
      "monday_list_users",
      "monday_list_workspaces",
      "monday_move_item",
      "monday_update_item",
    ]);
  });

  it("hides every write tool in read-only mode", async () => {
    const { client } = await connect(makeConfig({ readOnly: true }));
    const names = (await client.listTools()).tools.map((tool) => tool.name);

    expect(names).not.toContain("monday_create_item");
    expect(names).not.toContain("monday_update_item");
    expect(names).not.toContain("monday_delete_item");
    expect(names).toContain("monday_list_items");
    expect(names).toContain("monday_graphql");
  });

  it("marks the read tools as read-only for the client", async () => {
    const { client } = await connect();
    const tools = (await client.listTools()).tools;
    const listItems = tools.find((tool) => tool.name === "monday_list_items");
    expect(listItems?.annotations?.readOnlyHint).toBe(true);
  });
});

describe("read tools", () => {
  let context: Awaited<ReturnType<typeof connect>>;
  beforeEach(async () => {
    context = await connect();
  });

  it("reports the identity and the server mode", async () => {
    const result = (await context.client.callTool({
      name: "monday_get_me",
      arguments: {},
    })) as CallToolResult;

    const body = jsonOf(result);
    expect(body.name).toBe("Ashley");
    expect(body.account.slug).toBe("astriata");
    expect(body.server.read_only).toBe(false);
    expect(body.server.allowed_boards).toBe("all");
  });

  it("returns the board layout with the status labels a write may use", async () => {
    const result = (await context.client.callTool({
      name: "monday_get_board",
      arguments: { board_id: "111" },
    })) as CallToolResult;

    const board = jsonOf(result);
    expect(board.groups).toEqual([
      { id: "topics", title: "This month" },
      { id: "group_two", title: "Later" },
    ]);
    const status = board.columns.find((column: any) => column.id === "status");
    expect(status.options).toEqual(["Working on it", "Done", "Stuck"]);
    expect(status.writable).toBe(true);
    const formula = board.columns.find((column: any) => column.id === "formula_1");
    expect(formula.writable).toBe(false);
  });

  it("collapses a list result to readable column text", async () => {
    const result = (await context.client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111" },
    })) as CallToolResult;

    const body = jsonOf(result);
    expect(body.items[0].name).toBe("Ship the thing");
    expect(body.items[0].values).toEqual({
      Status: "Working on it",
      Notes: "needs review",
      Score: "8.5",
    });
    expect(body.cursor).toBe("c1");
  });

  it("turns a status filter into the numeric label index", async () => {
    await context.client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111", filters: [{ column: "Status", value: "Stuck" }] },
    });

    const call = context.api.lastCall("ListItems");
    expect((call?.variables.queryParams as any).rules).toEqual([
      { column_id: "status", compare_value: [5], operator: "any_of" },
    ]);
  });

  it("turns a search into a name rule", async () => {
    await context.client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111", search: "ship" },
    });

    const call = context.api.lastCall("ListItems");
    expect((call?.variables.queryParams as any).rules[0]).toEqual({
      column_id: "name",
      compare_value: "ship",
      operator: "contains_text",
    });
  });

  it("follows a cursor without repeating the filters", async () => {
    const result = (await context.client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111", cursor: "c1" },
    })) as CallToolResult;

    expect(context.api.lastCall("NextItemsPage")?.variables.cursor).toBe("c1");
    expect(jsonOf(result).cursor).toBeNull();
  });

  it("names the valid groups when the group is wrong", async () => {
    const result = (await context.client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111", group: "Backlog" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no group "Backlog"/);
    expect(textOf(result)).toMatch(/topics = "This month"/);
  });

  it("returns column ids and stored JSON in the detail view", async () => {
    const result = (await context.client.callTool({
      name: "monday_get_items",
      arguments: { item_ids: ["555"] },
    })) as CallToolResult;

    const item = jsonOf(result)[0];
    expect(item.url).toContain("/pulses/555");
    const status = item.columns.find((column: any) => column.id === "status");
    expect(status.value).toEqual({ index: 0 });
    expect(status.text).toBe("Working on it");
  });

  it("filters users by name in the tool, not on the server", async () => {
    const result = (await context.client.callTool({
      name: "monday_list_users",
      arguments: { name: "ben" },
    })) as CallToolResult;

    expect(jsonOf(result)).toHaveLength(1);
    expect(jsonOf(result)[0].name).toBe("Ben");
  });
});

describe("write tools", () => {
  let context: Awaited<ReturnType<typeof connect>>;
  beforeEach(async () => {
    context = await connect();
  });

  it("converts plain values into the JSON monday.com stores", async () => {
    const result = (await context.client.callTool({
      name: "monday_create_item",
      arguments: {
        board_id: "111",
        name: "New work",
        group: "Later",
        values: { Status: "Done", "due date": "2026-08-14", Notes: "from a test" },
      },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    const call = context.api.lastCall("CreateItem");
    expect(call?.variables.groupId).toBe("group_two");
    expect(JSON.parse(String(call?.variables.columnValues))).toEqual({
      status: { index: 1 },
      date_1: { date: "2026-08-14" },
      text_1: "from a test",
    });
    expect(jsonOf(result).created.id).toBe("556");
  });

  it("refuses a status the board does not have, before any request", async () => {
    const before = context.api.calls.length;
    const result = (await context.client.callTool({
      name: "monday_create_item",
      arguments: { board_id: "111", name: "New work", values: { Status: "Shipped" } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/no status "Shipped"/);
    expect(textOf(result)).toMatch(/"Working on it", "Done", "Stuck"/);
    // Only the board read happened. No create went out.
    expect(context.api.calls.slice(before).map((call) => call.operation)).toEqual(["GetBoard"]);
  });

  it("refuses to write a computed column", async () => {
    const result = (await context.client.callTool({
      name: "monday_create_item",
      arguments: { board_id: "111", name: "New work", values: { Score: 10 } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/monday.com computes/);
  });

  it("finds the board for an item so the caller need not pass it", async () => {
    await context.client.callTool({
      name: "monday_update_item",
      arguments: { item_id: "555", values: { Status: "Stuck" } },
    });

    expect(context.api.lastCall("GetItemBoards")).toBeDefined();
    const call = context.api.lastCall("ChangeColumnValues");
    expect(call?.variables.boardId).toBe("111");
    expect(JSON.parse(String(call?.variables.columnValues))).toEqual({ status: { index: 5 } });
  });

  it("renames an item and changes columns in one call", async () => {
    const result = (await context.client.callTool({
      name: "monday_update_item",
      arguments: { item_id: "555", name: "Renamed", values: { Notes: "x" } },
    })) as CallToolResult;

    expect(context.api.lastCall("ChangeItemName")?.variables.value).toBe("Renamed");
    expect(jsonOf(result).sent_column_values).toEqual({ text_1: "x" });
  });

  it("asks for values or a name", async () => {
    const result = (await context.client.callTool({
      name: "monday_update_item",
      arguments: { item_id: "555" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Give `values`, or `name`/);
  });

  it("archives by default", async () => {
    const result = (await context.client.callTool({
      name: "monday_delete_item",
      arguments: { item_id: "555" },
    })) as CallToolResult;

    expect(context.api.lastCall("ArchiveItem")).toBeDefined();
    expect(context.api.lastCall("DeleteItem")).toBeUndefined();
    expect(jsonOf(result).action).toBe("archive");
  });

  it("refuses a permanent delete without confirmation", async () => {
    const result = (await context.client.callTool({
      name: "monday_delete_item",
      arguments: { item_id: "555", mode: "delete" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Deletion is permanent/);
    expect(context.api.lastCall("DeleteItem")).toBeUndefined();
  });

  it("deletes when the caller confirms", async () => {
    await context.client.callTool({
      name: "monday_delete_item",
      arguments: { item_id: "555", mode: "delete", confirm: true },
    });

    expect(context.api.lastCall("DeleteItem")?.variables.itemId).toBe("555");
  });

  it("creates a subitem, then applies its values on the subitem board", async () => {
    const result = (await context.client.callTool({
      name: "monday_create_subitem",
      arguments: { parent_item_id: "555", name: "A step", values: { Notes: "detail" } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(context.api.lastCall("CreateSubitem")?.variables.itemName).toBe("A step");
    expect(context.api.lastCall("ChangeColumnValues")?.variables.boardId).toBe("222");
  });

  it("passes an API failure back as a readable tool error", async () => {
    context.api.nextError = "Column 'status' is not writable by this user";
    const result = (await context.client.callTool({
      name: "monday_list_boards",
      arguments: {},
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/not writable by this user/);
  });
});

describe("safety rails", () => {
  it("blocks a raw mutation in read-only mode", async () => {
    const { client, api } = await connect(makeConfig({ readOnly: true }));
    const result = (await client.callTool({
      name: "monday_graphql",
      arguments: { query: "mutation { delete_item(item_id: 1) { id } }" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/read-only mode/);
    expect(api.calls).toHaveLength(0);
  });

  it("allows a raw query in read-only mode", async () => {
    const { client } = await connect(makeConfig({ readOnly: true }));
    const result = (await client.callTool({
      name: "monday_graphql",
      arguments: { query: "query { me { id } }" },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
  });

  it("blocks a board outside the allow list", async () => {
    const { client, api } = await connect(makeConfig({ allowedBoards: new Set(["999"]) }));
    const result = (await client.callTool({
      name: "monday_list_items",
      arguments: { board_id: "111" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/outside the allowed board list/);
    expect(api.calls).toHaveLength(0);
  });

  it("refuses raw GraphQL while an allow list is in force", async () => {
    const { client } = await connect(makeConfig({ allowedBoards: new Set(["111"]) }));
    const result = (await client.callTool({
      name: "monday_graphql",
      arguments: { query: "query { boards { id } }" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/allowed board list/);
  });

  it("scopes monday_list_boards to the allow list", async () => {
    const { client, api } = await connect(makeConfig({ allowedBoards: new Set(["111"]) }));
    await client.callTool({ name: "monday_list_boards", arguments: {} });

    expect(api.lastCall("ListBoards")?.variables.ids).toEqual(["111"]);
  });
});
