import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { MondayClient } from "../client.js";
import type { Config } from "../config.js";
import type { BoardSchemaCache } from "../schema-cache.js";

/** What every API tool module needs to do its work. */
export interface ToolContext {
  server: McpServer;
  client: MondayClient;
  schemas: BoardSchemaCache;
  config: Config;
}

/**
 * What the addressing and desktop tools need. The client is optional because
 * these tools also run in desktop-only mode, where there is no token and so no
 * API client at all.
 */
export interface LocateContext {
  server: McpServer;
  config: Config;
  client?: MondayClient;
}
