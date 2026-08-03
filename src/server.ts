import { createRequire } from "node:module";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { MondayClient } from "./client.js";
import type { Config } from "./config.js";
import { BoardSchemaCache } from "./schema-cache.js";
import { registerAccountTools } from "./tools/account.js";
import { registerBoardTools } from "./tools/boards.js";
import { registerItemTools } from "./tools/items.js";
import { registerRawTool } from "./tools/raw.js";
import { registerUpdateTools } from "./tools/updates.js";
import type { ToolContext } from "./tools/context.js";

export const SERVER_NAME = "monday-mcp";

// Read the version rather than repeating it, so it cannot drift on a bump.
const require = createRequire(import.meta.url);
export const SERVER_VERSION = (
  require("../package.json") as { version: string }
).version;

const READ_STEPS = `
1. monday_list_boards finds the board and its id.
2. monday_get_board returns the groups, the columns and the labels each
   status or dropdown column accepts.
3. monday_list_items reads a page of items. monday_get_items reads one item
   in full.
`.trim();

const WRITE_STEPS = `
4. monday_create_item and monday_update_item write. Pass column values in
   plain form, keyed by column id or column title. This server converts
   them to the JSON that monday.com stores.
`.trim();

/** The server description an MCP client shows to the model. */
export function buildInstructions(config: Config): string {
  const parts = ["Tools for a monday.com account.", "", "Work in this order:", READ_STEPS];

  if (!config.readOnly) parts.push(WRITE_STEPS);

  parts.push(
    "",
    config.readOnly
      ? "This server runs in read-only mode. No tool can change anything in " +
          "monday.com, so do not promise the user a change."
      : "Two rules save most failures. Read the board layout before a write, " +
          "because a value must match its column type. Use the ids from a tool " +
          "result, never an id from memory.",
  );

  if (config.allowedBoards.size > 0) {
    parts.push(
      "",
      `This server is limited to these boards: ${[...config.allowedBoards].join(", ")}. ` +
        "Every other board is invisible and cannot be reached.",
    );
  }

  return parts.join("\n");
}

/** Builds the MCP server with every tool the configuration allows. */
export function createServer(config: Config, fetchImpl?: typeof fetch): McpServer {
  const server = new McpServer(
    { name: SERVER_NAME, version: SERVER_VERSION },
    { instructions: buildInstructions(config), capabilities: { tools: {} } },
  );

  const client = new MondayClient(config, fetchImpl);
  const schemas = new BoardSchemaCache(client);
  const context: ToolContext = { server, client, schemas, config };

  registerAccountTools(context);
  registerBoardTools(context);
  registerItemTools(context);
  registerUpdateTools(context);
  registerRawTool(context);

  return server;
}
