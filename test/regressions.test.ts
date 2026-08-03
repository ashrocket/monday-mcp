/**
 * One test per defect found in the pre-publication audit.
 *
 * Each name states the behaviour that was wrong, so a regression reads as
 * a plain English sentence rather than a line number.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { describe, expect, it, vi } from "vitest";
import { MondayClient } from "../src/client.js";
import {
  READ_ONLY_TYPES,
  buildColumnValues,
  formatColumnValue,
  type BoardColumn,
} from "../src/columns.js";
import type { Config } from "../src/config.js";
import { compactItem } from "../src/format.js";
import { createServer, buildInstructions } from "../src/server.js";
import { looksLikeMutation } from "../src/tools/raw.js";
import { buildRule } from "../src/tools/items.js";
import { FakeMonday } from "./fake-monday.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "test-token",
    apiUrl: "https://api.monday.test/v2",
    apiVersion: "2026-07",
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
  return { api, client };
}

function textOf(result: CallToolResult): string {
  return result.content
    .filter((part): part is { type: "text"; text: string } => part.type === "text")
    .map((part) => part.text)
    .join("\n");
}

function jsonOf(result: CallToolResult): any {
  return JSON.parse(textOf(result));
}

const status: BoardColumn = {
  id: "status",
  title: "Status",
  type: "status",
  settings_str: JSON.stringify({ labels: { "0": "Working on it", "1": "Done", "5": "Stuck" } }),
};

const dropdown: BoardColumn = {
  id: "dropdown_1",
  title: "Team",
  type: "dropdown",
  settings_str: JSON.stringify({ labels: [{ id: 1, name: "Design" }] }),
};

describe("column values", () => {
  it("does not silently truncate a date with trailing rubbish", () => {
    const date: BoardColumn = { id: "d", title: "Due", type: "date" };
    // The old unanchored pattern accepted this and threw the time away.
    expect(() => formatColumnValue(date, "2026-08-14 not-a-time")).toThrow(/not a date/);
    expect(() => formatColumnValue(date, "2026-08-14 09:30 extra")).toThrow(/not a date/);
    expect(formatColumnValue(date, "2026-08-14T09:30:15Z")).toEqual({
      date: "2026-08-14",
      time: "09:30:15",
    });
  });

  it("lets create_labels_if_missing send a brand new status label", () => {
    expect(() => formatColumnValue(status, "Blocked")).toThrow(/no status "Blocked"/);
    // The label form is the only one that can create a label. An index cannot.
    expect(formatColumnValue(status, "Blocked", true)).toEqual({ label: "Blocked" });
  });

  it("echoes the stored spelling of a known label, not the caller's casing", () => {
    // Sending "done" verbatim would make monday.com create a second label.
    expect(formatColumnValue(status, "done", true)).toEqual({ label: "Done" });
    expect(formatColumnValue(dropdown, "design")).toEqual({ labels: ["Design"] });
  });

  it("lets create_labels_if_missing add a dropdown option", () => {
    expect(() => formatColumnValue(dropdown, "Research")).toThrow(/no option "Research"/);
    expect(formatColumnValue(dropdown, ["Research"], true)).toEqual({
      labels: ["Research"],
    });
  });

  it("resolves a country code to the name monday.com stores", () => {
    const country: BoardColumn = { id: "c", title: "Country", type: "country" };
    expect(formatColumnValue(country, "gb")).toEqual({
      countryCode: "GB",
      countryName: "United Kingdom",
    });
    // ZZ is CLDR's "Unknown Region" and QQ is unassigned. Neither is a country.
    expect(() => formatColumnValue(country, "ZZ")).toThrow(/not a known ISO country code/);
    expect(() => formatColumnValue(country, "QQ")).toThrow(/not a known ISO country code/);
    expect(() => formatColumnValue(country, "United Kingdom")).toThrow(/two letter ISO code/);
  });

  it("derives the phone country instead of assuming the United States", () => {
    const phone: BoardColumn = { id: "p", title: "Phone", type: "phone" };
    expect(formatColumnValue(phone, "+442071234567")).toEqual({
      phone: "442071234567",
      countryShortName: "GB",
    });
    expect(formatColumnValue(phone, ["07700900123", "GB"])).toEqual({
      phone: "07700900123",
      countryShortName: "GB",
    });
    // A local number has no country in it, so guessing would be wrong.
    expect(() => formatColumnValue(phone, "07700900123")).toThrow(/two letter country code/);
  });

  it("refuses a location address rather than sending a payload monday.com rejects", () => {
    const location: BoardColumn = { id: "l", title: "Where", type: "location" };
    expect(() => formatColumnValue(location, "10 Downing Street")).toThrow(/coordinates/);
    const explicit = { lat: "51.5034", lng: "-0.1276", address: "10 Downing Street" };
    expect(formatColumnValue(location, explicit)).toBe(explicit);
  });

  it("treats the item name as writable, because monday.com does", () => {
    expect(READ_ONLY_TYPES.has("name")).toBe(false);
    const name: BoardColumn = { id: "name", title: "Name", type: "name" };
    expect(formatColumnValue(name, "New title")).toBe("New title");
  });

  it("rejects a non-numeric id in the object form of a people value", () => {
    const people: BoardColumn = { id: "person", title: "Owner", type: "people" };
    // The object branch used to pass this through as {"id": null}.
    expect(() => formatColumnValue(people, [{ id: "ashley", kind: "person" }])).toThrow(
      /not a user or team id/,
    );
    expect(() => formatColumnValue(people, [{ id: 12, kind: "robot" }])).toThrow(/not a valid kind/);
  });

  it("rejects a non-numeric rating instead of sending null", () => {
    const rating: BoardColumn = { id: "r", title: "Rating", type: "rating" };
    expect(() => formatColumnValue(rating, "great")).toThrow(/whole number/);
  });

  it("rejects an impossible time of day", () => {
    const hour: BoardColumn = { id: "h", title: "Hour", type: "hour" };
    expect(() => formatColumnValue(hour, "25:00")).toThrow(/valid time of day/);
    expect(formatColumnValue(hour, "14:30")).toEqual({ hour: 14, minute: 30 });
  });

  it("still handles the deprecated person and team column aliases", () => {
    for (const type of ["person", "team", "multiple-person"]) {
      const column: BoardColumn = { id: "x", title: "Owner", type };
      expect(formatColumnValue(column, [7])).toEqual({
        personsAndTeams: [{ id: 7, kind: "person" }],
      });
    }
  });

  it("threads create_labels_if_missing through buildColumnValues", () => {
    expect(buildColumnValues([status], { Status: "Blocked" }, true)).toEqual({
      status: { label: "Blocked" },
    });
  });
});

describe("tool counts the README states", () => {
  const namesFor = async (config: Config) =>
    (await connect(config)).client.listTools().then((list) =>
      list.tools.map((tool) => tool.name).sort(),
    );

  it("registers 15 tools normally and 9 in read-only mode", async () => {
    expect(await namesFor(makeConfig())).toHaveLength(15);
    const readOnly = await namesFor(makeConfig({ readOnly: true }));
    expect(readOnly).toHaveLength(9);
    expect(readOnly).toContain("monday_graphql");
  });

  it("drops only monday_graphql when a board allow list is set", async () => {
    const limited = await namesFor(makeConfig({ allowedBoards: new Set(["1"]) }));
    expect(limited).toHaveLength(14);
    expect(limited).not.toContain("monday_graphql");
  });
});

describe("read-only guard", () => {
  it("catches a mutation hidden behind a leading comma", () => {
    // GraphQL counts a comma as whitespace, so this is a valid document.
    expect(looksLikeMutation(",mutation { delete_item(item_id: 1) { id } }")).toBe(true);
    expect(looksLikeMutation("\n,\tmutation Foo { x }")).toBe(true);
    expect(looksLikeMutation("query { me { id } }")).toBe(false);
    // A field that merely starts with the word must not trip it.
    expect(looksLikeMutation("query { mutations { id } }")).toBe(false);
    expect(looksLikeMutation("# mutation in a comment\nquery { me { id } }")).toBe(false);
  });

  it("blocks the comma form end to end", async () => {
    const { client, api } = await connect(makeConfig({ readOnly: true }));
    const result = (await client.callTool({
      name: "monday_graphql",
      arguments: { query: ",mutation { delete_item(item_id: 1) { id } }" },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(api.calls).toHaveLength(0);
  });

  it("does not promise write tools in the read-only instructions", () => {
    const instructions = buildInstructions(makeConfig({ readOnly: true }));
    expect(instructions).not.toMatch(/monday_create_item/);
    expect(instructions).toMatch(/read-only mode/);
    expect(buildInstructions(makeConfig())).toMatch(/monday_create_item/);
  });

  it("names the board limit in the instructions when one is set", () => {
    expect(buildInstructions(makeConfig({ allowedBoards: new Set(["1", "2"]) }))).toMatch(
      /limited to these boards: 1, 2/,
    );
  });
});

describe("item tools", () => {
  it("asks for every id it was given, rather than the default page of 25", async () => {
    const { client, api } = await connect();
    const ids = Array.from({ length: 40 }, (_, index) => String(1000 + index));

    const result = (await client.callTool({
      name: "monday_get_items",
      arguments: { item_ids: ids },
    })) as CallToolResult;

    expect(api.lastCall("GetItems")?.variables.limit).toBe(40);
    expect(jsonOf(result)).toHaveLength(40);
  });

  it("names the ids that came back empty instead of dropping them quietly", async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: "monday_get_items",
      arguments: { item_ids: ["555", "999"] },
    })) as CallToolResult;

    const body = jsonOf(result);
    expect(body.missing_item_ids).toEqual(["999"]);
    expect(body.items).toHaveLength(1);
  });

  it("accepts a numeric id, because models emit ids unquoted", async () => {
    const { client } = await connect();
    const board = (await client.callTool({
      name: "monday_get_board",
      arguments: { board_id: 111 },
    })) as CallToolResult;
    expect(board.isError).toBeFalsy();

    const items = (await client.callTool({
      name: "monday_get_items",
      arguments: { item_ids: [555] },
    })) as CallToolResult;
    expect(items.isError).toBeFalsy();
  });

  it("refuses an unsupported operator on the name column instead of inverting it", () => {
    const columns: BoardColumn[] = [status];
    // The old code rewrote this to contains_text, returning exactly the rows
    // the caller asked to exclude.
    expect(buildRule(columns, { column: "name", operator: "not_any_of", value: "Draft" })).toEqual({
      column_id: "name",
      compare_value: ["Draft"],
      operator: "not_any_of",
    });
    expect(() =>
      buildRule(columns, { column: "name", operator: "greater_than", value: "5" }),
    ).toThrow(/does not support the greater_than operator/);
  });

  it("rejects a board_id that does not own the item", async () => {
    const { client, api } = await connect();
    const result = (await client.callTool({
      name: "monday_update_item",
      arguments: { item_id: "555", board_id: "999", values: { Notes: "x" } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/is on board 111, not board 999/);
    expect(api.lastCall("ChangeColumnValues")).toBeUndefined();
  });

  it("says the rename already succeeded when the column write then fails", async () => {
    const { client, api } = await connect();
    // The rename goes through, then the column write fails. Reporting a bare
    // failure would invite the caller to redo work that is already done.
    api.errorOnOperation = {
      operation: "ChangeColumnValues",
      message: "Column is locked",
    };

    const result = (await client.callTool({
      name: "monday_update_item",
      arguments: { item_id: "555", name: "Renamed", values: { Notes: "x" } },
    })) as CallToolResult;

    expect(result.isError).toBe(true);
    expect(textOf(result)).toMatch(/Column is locked/);
    expect(textOf(result)).toMatch(/rename to "Renamed" DID succeed/);
    expect(api.lastCall("ChangeItemName")?.variables.value).toBe("Renamed");
  });

  it("creates a subitem with values even under a board allow list", async () => {
    // The subitem board is monday.com's own hidden board, so it can never be
    // in a user supplied list.
    const { client, api } = await connect(makeConfig({ allowedBoards: new Set(["111"]) }));
    const result = (await client.callTool({
      name: "monday_create_subitem",
      arguments: { parent_item_id: "555", name: "A step", values: { Notes: "detail" } },
    })) as CallToolResult;

    expect(result.isError).toBeFalsy();
    expect(api.lastCall("ChangeColumnValues")?.variables.boardId).toBe("222");
  });

  it("tells a board search that more pages exist", async () => {
    const { client } = await connect();
    const result = (await client.callTool({
      name: "monday_list_boards",
      arguments: { name: "nothing-matches-this", limit: 1 },
    })) as CallToolResult;

    const body = jsonOf(result);
    expect(body.count).toBe(0);
    expect(body.scanned).toBe(1);
    expect(body.has_more).toBe(true);
    expect(body.next).toMatch(/Try page 2/);
  });
});

describe("result shaping", () => {
  it("keeps both values when two columns share a title", () => {
    const compact = compactItem({
      id: "1",
      name: "x",
      column_values: [
        { id: "person_a", type: "people", text: "Ashley", column: { id: "person_a", title: "Owner" } },
        { id: "person_b", type: "people", text: "Ben", column: { id: "person_b", title: "Owner" } },
      ],
    });
    expect(compact.values).toEqual({ Owner: "Ashley", person_b: "Ben" });
  });
});

describe("http client", () => {
  function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}) {
    return new Response(JSON.stringify(body), {
      status,
      headers: { "content-type": "application/json", ...headers },
    });
  }

  it("retries a request that timed out", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () => {
        const error = new Error("The operation was aborted");
        error.name = "AbortError";
        throw error;
      })
      .mockImplementationOnce(async () => jsonResponse({ data: { ok: true } }));
    const client = new MondayClient(
      makeConfig({ maxRetries: 1 }),
      fetchMock as unknown as typeof fetch,
    );

    // The message says "timed out"; the old retry test looked for "timeout".
    await expect(client.query("query { ok }")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("retries the complexity code the current API actually emits", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(async () =>
        jsonResponse({
          errors: [
            {
              message: "Complexity budget exhausted, reset in 0 seconds",
              extensions: { code: "COMPLEXITY_BUDGET_EXHAUSTED" },
            },
          ],
        }),
      )
      .mockImplementationOnce(async () => jsonResponse({ data: { ok: true } }));
    const client = new MondayClient(
      makeConfig({ maxRetries: 1 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(client.query("query { ok }")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reads the reset hint out of a 429 body, not only the header", async () => {
    const fetchMock = vi.fn().mockImplementation(async () =>
      jsonResponse({ errors: [{ message: "Complexity budget exhausted, reset in 30 seconds" }] }, 429),
    );
    const client = new MondayClient(
      makeConfig({ maxRetries: 0 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(client.query("query { ok }")).rejects.toThrow(/reset in 30 seconds/);
  });

  it("gives up rather than blocking for minutes on a long reset window", async () => {
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => jsonResponse({}, 429, { "retry-after": "60" }));
    // A fake clock, so the test does not really wait.
    let now = 0;
    const client = new MondayClient(
      makeConfig({ maxRetries: 3 }),
      fetchMock as unknown as typeof fetch,
      () => (now += 1_000),
    );

    await expect(client.query("query { ok }")).rejects.toThrow(/stopped retrying/);
    // One attempt, then the 60 s wait blows the deadline before a second.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("redacts the token before truncating, not after", async () => {
    const token = "z".repeat(40);
    const filler = "x".repeat(390);
    const fetchMock = vi
      .fn()
      .mockImplementation(async () => new Response(`${filler}${token}`, { status: 502 }));
    const client = new MondayClient(
      makeConfig({ token, maxRetries: 0 }),
      fetchMock as unknown as typeof fetch,
    );

    const error = await client.query("query { ok }").catch((caught) => caught);
    // Truncating first would leave the first 10 characters of the token.
    expect(String(error.message)).not.toMatch(/zzzzz/);
  });
});
