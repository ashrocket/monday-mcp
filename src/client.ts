import type { Config } from "./config.js";

/** A GraphQL error as monday.com returns it. */
export interface GraphQLError {
  message: string;
  extensions?: Record<string, unknown>;
  path?: (string | number)[];
}

/** A failure from the monday.com API, already made readable. */
export class MondayApiError extends Error {
  override name = "MondayApiError";
  readonly status: number;
  readonly errorCode: string | undefined;
  readonly errors: GraphQLError[];

  constructor(
    message: string,
    options: {
      status?: number;
      errorCode?: string;
      errors?: GraphQLError[];
      cause?: unknown;
    } = {},
  ) {
    super(message, { cause: options.cause });
    this.status = options.status ?? 0;
    this.errorCode = options.errorCode;
    this.errors = options.errors ?? [];
  }
}

/**
 * Error codes that a second attempt can fix. monday.com has changed these
 * spellings over the years, so the comparison is normalised rather than
 * exact.
 */
const RETRYABLE_CODES = new Set([
  "complexitybudgetexhausted",
  "complexityexception",
  "ratelimitexceeded",
  "internalservererror",
  "maxconcurrencyexceeded",
]);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

/** Total time the retry loop may spend before it gives up and reports. */
const RETRY_DEADLINE_MS = 45_000;

function normaliseCode(code: string | undefined): string {
  return (code ?? "").toLowerCase().replace(/[^a-z]/g, "");
}

/** Reads the "reset in N seconds" hint out of a complexity message. */
export function parseResetSeconds(message: string): number | undefined {
  const match = /reset in (\d+) seconds?/i.exec(message);
  if (!match?.[1]) return undefined;
  return Number.parseInt(match[1], 10);
}

/** Removes a token from text so it never reaches a log or a tool result. */
export function redact(text: string, token: string): string {
  if (!token) return text;
  return text.split(token).join("<redacted-token>");
}

/**
 * Redacts first, then truncates. The other order can cut a token in half
 * and leave the first part of it in the message.
 */
function safeExcerpt(text: string, token: string, limit = 400): string {
  return redact(text, token).slice(0, limit);
}

const sleep = (ms: number): Promise<void> =>
  new Promise((done) => setTimeout(done, ms));

export interface QueryOptions {
  /** Name shown in an error message, to say which tool failed. */
  label?: string;
  /** Overrides the retry count for this call. */
  maxRetries?: number;
}

/**
 * A small GraphQL client for monday.com.
 *
 * It handles the two things that break naive clients: monday.com answers
 * with HTTP 200 and an `errors` array, and it throttles on a complexity
 * budget instead of a simple request count.
 */
export class MondayClient {
  private readonly config: Config;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;

  constructor(
    config: Config,
    fetchImpl: typeof fetch = fetch,
    now: () => number = Date.now,
  ) {
    this.config = config;
    this.fetchImpl = fetchImpl;
    this.now = now;
  }

  get readOnly(): boolean {
    return this.config.readOnly;
  }

  get allowedBoards(): Set<string> {
    return this.config.allowedBoards;
  }

  /** Rejects a board id that the allow list does not contain. */
  assertBoardAllowed(boardId: string | number): void {
    const allowed = this.config.allowedBoards;
    if (allowed.size === 0) return;
    if (!allowed.has(String(boardId))) {
      throw new MondayApiError(
        `Board ${boardId} is outside the allowed board list. ` +
          `This server may use these boards only: ${[...allowed].join(", ")}.`,
      );
    }
  }

  /** Rejects a write while the server runs in read-only mode. */
  assertWritable(action: string): void {
    if (this.config.readOnly) {
      throw new MondayApiError(
        `The server runs in read-only mode, so it cannot ${action}. ` +
          "Remove MONDAY_READ_ONLY or the --read-only flag to allow writes.",
      );
    }
  }

  /** Sends one GraphQL document and returns the `data` object. */
  async query<T = Record<string, unknown>>(
    document: string,
    variables: Record<string, unknown> = {},
    options: QueryOptions = {},
  ): Promise<T> {
    const maxRetries = options.maxRetries ?? this.config.maxRetries;
    const startedAt = this.now();
    let lastError: MondayApiError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(document, variables);
      } catch (error) {
        const apiError =
          error instanceof MondayApiError
            ? error
            : new MondayApiError(redact((error as Error).message, this.config.token), {
                cause: error,
              });
        lastError = apiError;

        if (attempt === maxRetries || !this.isRetryable(apiError)) break;

        const wait = this.backoffMs(apiError, attempt);
        const elapsed = this.now() - startedAt;
        // A complexity window can be a full minute. Waiting three of them
        // outlasts every MCP client, so report instead and let the caller
        // decide to try again.
        if (elapsed + wait > RETRY_DEADLINE_MS) {
          lastError = new MondayApiError(
            `${apiError.message} The server stopped retrying after ` +
              `${Math.round(elapsed / 1000)} seconds. Wait for the reset, then try again.`,
            {
              status: apiError.status,
              errorCode: apiError.errorCode,
              errors: apiError.errors,
              cause: apiError,
            },
          );
          break;
        }
        await sleep(wait);
      }
    }

    const label = options.label ? `${options.label}: ` : "";
    throw new MondayApiError(`${label}${lastError?.message ?? "unknown error"}`, {
      status: lastError?.status,
      errorCode: lastError?.errorCode,
      errors: lastError?.errors,
      cause: lastError,
    });
  }

  private isRetryable(error: MondayApiError): boolean {
    if (RETRYABLE_STATUS.has(error.status)) return true;
    if (RETRYABLE_CODES.has(normaliseCode(error.errorCode))) return true;
    if (/complexity budget|rate limit/i.test(error.message)) return true;
    // A socket hang-up, a DNS blip or an abort has no status at all.
    return (
      error.status === 0 &&
      /fetch failed|network|socket|ECONN|ETIMEDOUT|EAI_AGAIN|timed out|timeout/i.test(
        error.message,
      )
    );
  }

  private backoffMs(error: MondayApiError, attempt: number): number {
    const reset = parseResetSeconds(error.message);
    if (reset !== undefined) return Math.min(reset * 1000 + 250, 60_000);
    return Math.min(500 * 2 ** attempt, 8_000);
  }

  private async attempt<T>(
    document: string,
    variables: Record<string, unknown>,
  ): Promise<T> {
    const controller = new AbortController();
    // The timer must cover reading the body as well. Clearing it as soon as
    // the headers arrive lets a stalled body hang the tool forever.
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

    try {
      let response: Response;
      try {
        response = await this.fetchImpl(this.config.apiUrl, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Authorization: this.config.token,
            "API-Version": this.config.apiVersion,
            "User-Agent": "monday-mcp (+https://github.com/ashrocket/monday-mcp)",
          },
          body: JSON.stringify({ query: document, variables }),
          signal: controller.signal,
        });
      } catch (error) {
        const reason =
          (error as Error).name === "AbortError"
            ? `The request timed out after ${this.config.timeoutMs} ms.`
            : `The request failed: ${(error as Error).message}`;
        throw new MondayApiError(redact(reason, this.config.token), { cause: error });
      }

      let rawBody: string;
      try {
        rawBody = await response.text();
      } catch (error) {
        const reason =
          (error as Error).name === "AbortError"
            ? `The response body timed out after ${this.config.timeoutMs} ms.`
            : `The response body could not be read: ${(error as Error).message}`;
        throw new MondayApiError(redact(reason, this.config.token), {
          status: response.status,
          cause: error,
        });
      }

      let body: Record<string, unknown> = {};
      if (rawBody.length > 0) {
        try {
          body = JSON.parse(rawBody) as Record<string, unknown>;
        } catch {
          throw new MondayApiError(
            `The API answered with HTTP ${response.status} and a body that is not JSON: ` +
              safeExcerpt(rawBody, this.config.token),
            { status: response.status },
          );
        }
      }

      if (response.status === 401 || response.status === 403) {
        throw new MondayApiError(
          "The API rejected the token. Check MONDAY_API_TOKEN. " +
            "A token from Developers > My access tokens works for your own user.",
          { status: response.status },
        );
      }

      const errors = this.collectErrors(body);

      // monday.com puts the reset hint in the body as often as in a header,
      // so read both before giving up on this attempt.
      if (response.status === 429) {
        const retryAfter = response.headers.get("retry-after");
        const fromBody = errors.map((item) => item.message).join("; ");
        const hint = retryAfter
          ? `reset in ${retryAfter} seconds`
          : (parseResetSeconds(fromBody) !== undefined ? fromBody : "");
        throw new MondayApiError(
          `Rate limited by monday.com${hint ? `, ${hint}` : ""}.`,
          { status: 429, errorCode: "RateLimitExceeded", errors },
        );
      }

      if (errors.length > 0) {
        const errorCode =
          typeof body.error_code === "string"
            ? body.error_code
            : (errors[0]?.extensions?.code as string | undefined);
        const message = errors.map((item) => item.message).join("; ");
        throw new MondayApiError(redact(message, this.config.token), {
          status: response.status,
          errorCode,
          errors,
        });
      }

      if (!response.ok) {
        throw new MondayApiError(
          `The API answered with HTTP ${response.status}: ` +
            safeExcerpt(rawBody, this.config.token),
          { status: response.status },
        );
      }

      if (body.data === undefined || body.data === null) {
        throw new MondayApiError(
          "The API answered without a data object. " +
            safeExcerpt(rawBody, this.config.token),
          { status: response.status },
        );
      }

      return body.data as T;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * monday.com reports failures in three shapes. This flattens all of them.
   *   1. `errors: [{ message }]`     - standard GraphQL
   *   2. `error_message: "..."`      - older REST-style envelope
   *   3. `errors: ["a string"]`      - some validation paths
   */
  private collectErrors(body: Record<string, unknown>): GraphQLError[] {
    const collected: GraphQLError[] = [];
    const raw = body.errors;

    if (Array.isArray(raw)) {
      for (const item of raw) {
        if (typeof item === "string") {
          collected.push({ message: item });
        } else if (item && typeof item === "object") {
          const entry = item as Record<string, unknown>;
          collected.push({
            message: String(entry.message ?? JSON.stringify(entry)),
            extensions: entry.extensions as Record<string, unknown> | undefined,
            path: entry.path as (string | number)[] | undefined,
          });
        }
      }
    }

    if (typeof body.error_message === "string" && body.error_message.length > 0) {
      collected.push({ message: body.error_message });
    }

    return collected;
  }
}
