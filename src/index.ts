#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { ConfigError, loadConfig } from "./config.js";
import { SERVER_VERSION, createServer } from "./server.js";
import { browserLogin } from "./browser-login.js";

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
  --api-version <date>   The monday.com API version. Default 2026-07.
  --api-url <url>        A different endpoint, for a proxy or a test.
  --desktop-only        Run without an API token (UI reads and locations only).
  --account-slug <slug>  Account subdomain used by UI tools.
  --debug-port <port>    Legacy desktop debug port. Default 9222.
  --browser             Use a dedicated headless Chrome for UI tools.
  --browser-only        Use headless Chrome without API tools or an API token.
  --browser-state <file> Private login-state snapshot (never a personal profile).
  --browser-executable <path> Optional Chromium/Chrome binary; defaults to Chrome.
  --browser-login       Open a dedicated window for manual login and save state.
  --help                 Show this text.
  --version              Show the version.

Environment variables:
  MONDAY_API_TOKEN, MONDAY_API_TOKEN_FILE, MONDAY_READ_ONLY,
  MONDAY_ALLOWED_BOARDS, MONDAY_API_VERSION, MONDAY_API_URL,
  MONDAY_TIMEOUT_MS, MONDAY_MAX_RETRIES, MONDAY_DESKTOP_ONLY,
  MONDAY_ACCOUNT_SLUG, MONDAY_DEBUG_PORT, MONDAY_BROWSER, MONDAY_BROWSER_ONLY,
  MONDAY_BROWSER_STATE, MONDAY_BROWSER_EXECUTABLE, MONDAY_BROWSER_TIMEOUT_MS

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

  if (argv.includes("--browser-login")) {
    await browserLogin(loadConfig([...argv,"--browser-only"]));
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
