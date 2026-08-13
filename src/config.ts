import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";

/** Everything the server needs to know before it starts. */
export interface Config {
  /**
   * The monday.com personal API token. Empty only in desktop-only mode, where
   * no API tool is registered and nothing ever reads it.
   */
  token: string;
  /**
   * True runs without a token: the API tools are absent and only the
   * addressing and desktop tools load. Must be asked for explicitly, so a
   * mistyped token still fails loudly instead of silently degrading.
   */
  desktopOnly: boolean;
  /**
   * Account subdomain, needed to build any URL. With a token the server can
   * read it from me{account{slug}}; without one this is the only source.
   */
  accountSlug?: string;
  /** Port that the desktop app's --remote-debugging-port opened. */
  debugPort: number;
  /** GraphQL endpoint. Override only for a proxy or a test double. */
  apiUrl: string;
  /** API version header. monday.com pins behaviour to this date string. */
  apiVersion: string;
  /** True blocks every write tool. Read tools stay available. */
  readOnly: boolean;
  /** Board ids the server may touch. An empty set means all boards. */
  allowedBoards: Set<string>;
  /** Timeout for a single HTTP call, in milliseconds. */
  timeoutMs: number;
  /** How many times to retry a rate-limited or transient call. */
  maxRetries: number;
}

export const DEFAULT_API_URL = "https://api.monday.com/v2";
// monday.com retires a version every quarter. A deprecated version is
// silently served as the maintenance version, so an out-of-date pin here
// means the code targets one API and talks to another. Check
// https://developer.monday.com/api-reference/docs/api-versioning
export const DEFAULT_API_VERSION = "2026-07";

/** Thrown when the server cannot start. The message goes to stderr. */
export class ConfigError extends Error {
  override name = "ConfigError";
}

/** Reads a token from a file and strips whitespace. */
function readTokenFile(path: string): string {
  const expanded =
    path === "~"
      ? homedir()
      : path.startsWith("~/")
        ? resolve(homedir(), path.slice(2))
        : path;
  try {
    return readFileSync(expanded, "utf8").trim();
  } catch (error) {
    throw new ConfigError(
      `Cannot read the token file at ${expanded}: ${(error as Error).message}`,
    );
  }
}

function parseBoards(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  return new Set(
    raw
      .split(",")
      .map((id) => id.trim())
      .filter((id) => id.length > 0),
  );
}

function parseBool(raw: string | undefined): boolean {
  if (!raw) return false;
  return ["1", "true", "yes", "on"].includes(raw.trim().toLowerCase());
}

function parseInteger(
  raw: string | undefined,
  fallback: number,
  minimum = 1,
): number {
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number.parseInt(raw, 10);
  return Number.isFinite(value) && value >= minimum ? value : fallback;
}

export interface CliOptions {
  token?: string;
  tokenFile?: string;
  readOnly?: boolean;
  apiUrl?: string;
  apiVersion?: string;
  allowedBoards?: string;
  desktopOnly?: boolean;
  accountSlug?: string;
  debugPort?: string;
}

/**
 * Reads command line flags. Flags win over environment variables.
 * Supported: --token, --token-file, --read-only, --api-url,
 * --api-version, --boards. Each flag also accepts --flag=value.
 */
export function parseArgs(argv: string[]): CliOptions {
  const options: CliOptions = {};
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index] as string;
    if (!arg.startsWith("--")) continue;
    const equals = arg.indexOf("=");
    const name = equals === -1 ? arg.slice(2) : arg.slice(2, equals);
    const inlineValue = equals === -1 ? undefined : arg.slice(equals + 1);
    const nextValue = (): string | undefined => {
      if (inlineValue !== undefined) return inlineValue;
      const next = argv[index + 1];
      if (next === undefined || next.startsWith("--")) return undefined;
      index += 1;
      return next;
    };

    switch (name) {
      case "token":
        options.token = nextValue();
        break;
      case "token-file":
        options.tokenFile = nextValue();
        break;
      case "read-only":
        options.readOnly = inlineValue === undefined ? true : parseBool(inlineValue);
        break;
      case "api-url":
        options.apiUrl = nextValue();
        break;
      case "api-version":
        options.apiVersion = nextValue();
        break;
      case "boards":
        options.allowedBoards = nextValue();
        break;
      case "desktop-only":
        options.desktopOnly = inlineValue === undefined ? true : parseBool(inlineValue);
        break;
      case "account-slug":
        options.accountSlug = nextValue();
        break;
      case "debug-port":
        options.debugPort = nextValue();
        break;
      default:
        break;
    }
  }
  return options;
}

/**
 * Builds the configuration from CLI flags and environment variables.
 * Throws a ConfigError when the token is absent.
 */
export function loadConfig(
  argv: string[] = process.argv.slice(2),
  env: NodeJS.ProcessEnv = process.env,
): Config {
  const options = parseArgs(argv);

  let token = options.token ?? env.MONDAY_API_TOKEN ?? "";
  const tokenFile = options.tokenFile ?? env.MONDAY_API_TOKEN_FILE;
  if (!token && tokenFile) token = readTokenFile(tokenFile);
  token = token.trim();

  const desktopOnly = options.desktopOnly ?? parseBool(env.MONDAY_DESKTOP_ONLY);

  // A missing token stays a hard failure unless desktop-only was asked for.
  // Otherwise a typo in MONDAY_API_TOKEN would quietly boot a server with no
  // API tools, which reads like a broken account rather than a broken config.
  if (!token && !desktopOnly) {
    throw new ConfigError(
      [
        "No monday.com API token found.",
        "",
        "Set one of these:",
        "  MONDAY_API_TOKEN=<token>",
        "  MONDAY_API_TOKEN_FILE=<path to a file that holds the token>",
        "  --token <token>",
        "  --token-file <path>",
        "",
        "Get a token in monday.com:",
        "  Avatar (bottom left) > Developers > My access tokens > Show",
        "",
        "Or run without a token, exposing only the addressing and desktop",
        "tools, which ride the session in the monday.com desktop app:",
        "  --desktop-only   (or MONDAY_DESKTOP_ONLY=1)",
      ].join("\n"),
    );
  }

  return {
    token,
    desktopOnly,
    accountSlug: (options.accountSlug ?? env.MONDAY_ACCOUNT_SLUG)?.trim() || undefined,
    debugPort: parseInteger(options.debugPort ?? env.MONDAY_DEBUG_PORT, 9_222),
    apiUrl: options.apiUrl ?? env.MONDAY_API_URL ?? DEFAULT_API_URL,
    apiVersion: options.apiVersion ?? env.MONDAY_API_VERSION ?? DEFAULT_API_VERSION,
    readOnly: options.readOnly ?? parseBool(env.MONDAY_READ_ONLY),
    allowedBoards: parseBoards(options.allowedBoards ?? env.MONDAY_ALLOWED_BOARDS),
    timeoutMs: parseInteger(env.MONDAY_TIMEOUT_MS, 30_000),
    maxRetries: parseInteger(env.MONDAY_MAX_RETRIES, 3, 0),
  };
}
