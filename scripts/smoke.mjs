#!/usr/bin/env node
/**
 * Live smoke test.
 *
 * It starts the built server as a real child process, speaks MCP over stdio
 * and calls the tools against your own monday.com account.
 *
 *   node scripts/smoke.mjs                 read-only checks
 *   node scripts/smoke.mjs --write         adds a create, update, comment
 *                                          and archive cycle on a test board
 *   node scripts/smoke.mjs --board 12345   pick the board to use
 *
 * The write cycle archives the item it makes, so it leaves no clutter.
 */
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const entry = join(root, "dist", "index.js");

const args = process.argv.slice(2);
const wantsWrite = args.includes("--write");
const boardArg = args[args.indexOf("--board") + 1];
const chosenBoard = args.includes("--board") ? boardArg : undefined;

// A .env file in the repo root is the easiest local setup.
const envPath = join(root, ".env");
if (existsSync(envPath)) {
  for (const line of readFileSync(envPath, "utf8").split("\n")) {
    const match = /^\s*([A-Z_]+)\s*=\s*(.*)\s*$/.exec(line);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].trim();
  }
}

if (!process.env.MONDAY_API_TOKEN && !process.env.MONDAY_API_TOKEN_FILE) {
  console.error("Set MONDAY_API_TOKEN, or put it in a .env file in the repo root.");
  process.exit(2);
}
if (!existsSync(entry)) {
  console.error("Run `npm run build` first.");
  process.exit(2);
}

let passed = 0;
let failed = 0;

function report(name, detail) {
  passed += 1;
  console.log(`  PASS  ${name}${detail ? ` - ${detail}` : ""}`);
}

function reportFailure(name, error) {
  failed += 1;
  console.log(`  FAIL  ${name} - ${error}`);
}

async function step(name, run) {
  try {
    const detail = await run();
    report(name, detail);
    return true;
  } catch (error) {
    reportFailure(name, error.message ?? String(error));
    return false;
  }
}

/** Calls a tool and throws when the server marks the result as an error. */
async function call(client, name, args = {}) {
  const result = await client.callTool({ name, arguments: args });
  const text = (result.content ?? [])
    .filter((part) => part.type === "text")
    .map((part) => part.text)
    .join("\n");
  if (result.isError) throw new Error(text);
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

const transport = new StdioClientTransport({
  command: process.execPath,
  args: [entry],
  env: process.env,
  stderr: "inherit",
});
const client = new Client({ name: "monday-mcp-smoke", version: "1.0.0" });

console.log("monday-mcp live smoke test\n");
await client.connect(transport);

const tools = (await client.listTools()).tools;
report("connected", `${tools.length} tools`);

let boardId = chosenBoard;
let itemId;

await step("monday_get_me", async () => {
  const me = await call(client, "monday_get_me");
  return `${me.name} <${me.email}> on account ${me.account?.name}`;
});

await step("monday_list_boards", async () => {
  const result = await call(client, "monday_list_boards", { limit: 10 });
  if (result.boards.length === 0) throw new Error("no boards visible to this token");
  boardId ??= result.boards[0].id;
  return `${result.boards.length} boards, using ${boardId}`;
});

let board;
await step("monday_get_board", async () => {
  board = await call(client, "monday_get_board", { board_id: boardId });
  const writable = board.columns.filter((column) => column.writable).length;
  return `"${board.name}", ${board.groups.length} groups, ${board.columns.length} columns (${writable} writable)`;
});

await step("monday_list_items", async () => {
  const result = await call(client, "monday_list_items", { board_id: boardId, limit: 5 });
  itemId = result.items[0]?.id;
  return `${result.items.length} items${result.cursor ? ", more pages follow" : ""}`;
});

if (itemId) {
  await step("monday_get_items", async () => {
    const items = await call(client, "monday_get_items", { item_ids: [itemId] });
    return `"${items[0].name}" with ${items[0].columns.length} columns`;
  });

  await step("monday_list_updates", async () => {
    const result = await call(client, "monday_list_updates", { item_id: itemId, limit: 3 });
    return `${result.updates.length} updates`;
  });
}

await step("monday_list_users", async () => {
  const users = await call(client, "monday_list_users", { limit: 5 });
  return `${users.length} users`;
});

await step("bad status is refused with the real labels", async () => {
  const statusColumn = board?.columns.find((column) => column.type === "status");
  if (!statusColumn) return "skipped, this board has no status column";
  const result = await client.callTool({
    name: "monday_create_item",
    arguments: {
      board_id: boardId,
      name: "monday-mcp validation probe",
      values: { [statusColumn.id]: "definitely-not-a-real-label" },
    },
  });
  if (!result.isError) throw new Error("the server accepted a bad status label");
  return "rejected before the API call";
});

if (wantsWrite) {
  console.log("\n  write cycle");
  let created;

  await step("monday_create_item", async () => {
    const statusColumn = board.columns.find((column) => column.type === "status");
    const values = {};
    if (statusColumn?.options?.length) values[statusColumn.id] = statusColumn.options[0];
    const result = await call(client, "monday_create_item", {
      board_id: boardId,
      name: `monday-mcp smoke ${new Date().toISOString()}`,
      values,
    });
    created = result.created.id;
    return `created item ${created}`;
  });

  if (created) {
    await step("monday_update_item", async () => {
      const textColumn = board.columns.find(
        (column) => column.type === "text" && column.writable,
      );
      const values = textColumn ? { [textColumn.id]: "written by the smoke test" } : undefined;
      await call(client, "monday_update_item", {
        item_id: created,
        name: "monday-mcp smoke (renamed)",
        ...(values ? { values } : {}),
      });
      return "renamed and column written";
    });

    await step("monday_create_update", async () => {
      await call(client, "monday_create_update", {
        item_id: created,
        body: "<p>Posted by the monday-mcp smoke test.</p>",
      });
      return "comment posted";
    });

    await step("monday_delete_item (archive)", async () => {
      const result = await call(client, "monday_delete_item", { item_id: created });
      return `state now ${result.result?.state ?? "archived"}`;
    });
  }
}

await client.close();

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed === 0 ? 0 : 1);
