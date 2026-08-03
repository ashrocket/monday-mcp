import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MondayClient } from "../client.js";
import type { Config } from "../config.js";
import type { BoardSchemaCache } from "../schema-cache.js";

/** What every tool module needs to do its work. */
export interface ToolContext {
  server: McpServer;
  client: MondayClient;
  schemas: BoardSchemaCache;
  config: Config;
}
