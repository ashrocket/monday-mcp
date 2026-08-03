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

/** Error codes that a second attempt can fix. */
const RETRYABLE_CODES = new Set([
  "ComplexityException",
  "RateLimitExceeded",
  "Internal Server Error",
  "InternalServerError",
]);

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);

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

  constructor(config: Config, fetchImpl: typeof fetch = fetch) {
    this.config = config;
    this.fetchImpl = fetchImpl;
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
    let lastError: MondayApiError | undefined;

    for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
      try {
        return await this.attempt<T>(document, variables);
      } catch (error) {
        const apiError =
          error instanceof MondayApiError
            ? error
            : new MondayApiError(
                redact((error as Error).message, this.config.token),
                { cause: error },
              );
        lastError = apiError;

        if (attempt === maxRetries || !this.isRetryable(apiError)) break;
        await sleep(this.backoffMs(apiError, attempt));
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
    if (error.errorCode && RETRYABLE_CODES.has(error.errorCode)) return true;
    // A socket hang-up or a DNS blip has no status at all.
    return error.status === 0 && /fetch|network|socket|ECONN|timeout/i.test(error.message);
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
    const timer = setTimeout(() => controller.abort(), this.config.timeoutMs);

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
    } finally {
      clearTimeout(timer);
    }

    const rawBody = await response.text();
    let body: Record<string, unknown> = {};
    if (rawBody.length > 0) {
      try {
        body = JSON.parse(rawBody) as Record<string, unknown>;
      } catch {
        throw new MondayApiError(
          `The API answered with HTTP ${response.status} and a body that is not JSON: ` +
            redact(rawBody.slice(0, 400), this.config.token),
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

    // monday.com puts the retry hint in a header on a hard throttle.
    if (response.status === 429) {
      const retryAfter = response.headers.get("retry-after");
      throw new MondayApiError(
        `Rate limited by monday.com${retryAfter ? `, reset in ${retryAfter} seconds` : ""}.`,
        { status: 429, errorCode: "RateLimitExceeded" },
      );
    }

    const errors = this.collectErrors(body);
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
          redact(rawBody.slice(0, 400), this.config.token),
        { status: response.status },
      );
    }

    if (body.data === undefined || body.data === null) {
      throw new MondayApiError(
        "The API answered without a data object. " +
          redact(rawBody.slice(0, 400), this.config.token),
        { status: response.status },
      );
    }

    return body.data as T;
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
