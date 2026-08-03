#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { SERVER_VERSION, createServer } from "./server.js";

const HELP = `
monday-mcp ${SERVER_VERSION}
A local Model Context Protocol server for monday.com.

Usage:
  monday-mcp [options]

Options:
  --token <token>        The monday.com API token.
  --token-file <path>    A file that holds the token.
  --read-only            Register read tools only.
  --boards <id,id>       Limit the server to these board ids.
  --api-version <date>   The monday.com API version. Default 2024-10.
  --api-url <url>        A different endpoint, for a proxy or a test.
  --help                 Show this text.
  --version              Show the version.

Environment variables:
  MONDAY_API_TOKEN, MONDAY_API_TOKEN_FILE, MONDAY_READ_ONLY,
  MONDAY_ALLOWED_BOARDS, MONDAY_API_VERSION, MONDAY_API_URL,
  MONDAY_TIMEOUT_MS, MONDAY_MAX_RETRIES

The server speaks MCP over stdin and stdout. Point an MCP client at it.
`.trim();

async function main(): Promise<void> {
  const argv = process.argv.slice(2);

  if (argv.includes("--help") || argv.includes("-h")) {
    process.stdout.write(`${HELP}\n`);
    return;
  }
  if (argv.includes("--version") || argv.includes("-v")) {
    process.stdout.write(`${SERVER_VERSION}\n`);
    return;
  }

  const config = loadConfig(argv);
  const server = createServer(config);
  const transport = new StdioServerTransport();
  await server.connect(transport);

  // stdout carries the protocol, so every human message goes to stderr.
  process.stderr.write(
    `monday-mcp ${SERVER_VERSION} ready` +
      `${config.readOnly ? " (read-only)" : ""}` +
      `${config.allowedBoards.size > 0 ? ` (boards: ${[...config.allowedBoards].join(", ")})` : ""}\n`,
  );

  const shutdown = (): void => {
    void server.close().finally(() => process.exit(0));
  };
  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((error: unknown) => {
  if (error instanceof ConfigError) {
    process.stderr.write(`${error.message}\n`);
    process.exit(2);
  }
  process.stderr.write(`monday-mcp failed to start: ${(error as Error).message}\n`);
  process.exit(1);
});
