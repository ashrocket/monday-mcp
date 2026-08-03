import { describe, expect, it, vi } from "vitest";
import { MondayApiError, MondayClient, parseResetSeconds, redact } from "../src/client.js";
import type { Config } from "../src/config.js";

function makeConfig(overrides: Partial<Config> = {}): Config {
  return {
    token: "secret-token",
    apiUrl: "https://api.monday.test/v2",
    apiVersion: "2024-10",
    readOnly: false,
    allowedBoards: new Set<string>(),
    timeoutMs: 1_000,
    maxRetries: 2,
    ...overrides,
  };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json", ...headers },
  });
}

describe("redact and parseResetSeconds", () => {
  it("hides the token in any text", () => {
    expect(redact("bad token secret-token here", "secret-token")).toBe(
      "bad token <redacted-token> here",
    );
  });

  it("reads the complexity reset hint", () => {
    expect(parseResetSeconds("Complexity budget exhausted, reset in 27 seconds")).toBe(27);
    expect(parseResetSeconds("nothing here")).toBeUndefined();
  });
});

describe("MondayClient.query", () => {
  it("sends the token and the API version, and returns data", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { me: { id: "1" } } }));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    const data = await client.query<{ me: { id: string } }>("query { me { id } }");

    expect(data.me.id).toBe("1");
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe("https://api.monday.test/v2");
    const headers = init.headers as Record<string, string>;
    expect(headers.Authorization).toBe("secret-token");
    expect(headers["API-Version"]).toBe("2024-10");
  });

  it("turns a GraphQL error array into a readable failure", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      jsonResponse({ errors: [{ message: "Field 'nope' does not exist" }] }),
    );
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(client.query("query { nope }", {}, { label: "test" })).rejects.toThrow(
      /test: Field 'nope' does not exist/,
    );
  });

  it("handles the older error_message envelope", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ error_message: "Board not found", status_code: 200 }));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(client.query("query { boards { id } }")).rejects.toThrow(/Board not found/);
  });

  it("handles an errors array of plain strings", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: ["bad request"] }));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(client.query("query { x }")).rejects.toThrow(/bad request/);
  });

  it("explains a rejected token instead of showing it", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({}, 401));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    const error = await client.query("query { me { id } }").catch((caught) => caught);
    expect(error).toBeInstanceOf(MondayApiError);
    expect(String(error.message)).toMatch(/rejected the token/);
    expect(String(error.message)).not.toMatch(/secret-token/);
  });

  it("retries a complexity failure and then succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(
        jsonResponse({
          errors: [{ message: "Complexity budget exhausted, reset in 0 seconds" }],
          error_code: "ComplexityException",
        }),
      )
      .mockResolvedValueOnce(jsonResponse({ data: { ok: true } }));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(client.query("query { ok }")).resolves.toEqual({ ok: true });
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("does not retry a plain validation error", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "Invalid column id" }] }));
    const client = new MondayClient(makeConfig(), fetchMock as unknown as typeof fetch);

    await expect(client.query("mutation { x }")).rejects.toThrow(/Invalid column id/);
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("stops after the retry budget runs out", async () => {
    // A fresh Response each call. A body may be read only once.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}, 503));
    const client = new MondayClient(
      makeConfig({ maxRetries: 1 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(client.query("query { ok }")).rejects.toThrow(/HTTP 503/);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("reports a body that is not JSON", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response("<html>gateway</html>", { status: 502 }));
    const client = new MondayClient(
      makeConfig({ maxRetries: 0 }),
      fetchMock as unknown as typeof fetch,
    );

    await expect(client.query("query { ok }")).rejects.toThrow(/not JSON/);
  });
});

describe("guards", () => {
  it("blocks a write in read-only mode", () => {
    const client = new MondayClient(makeConfig({ readOnly: true }));
    expect(() => client.assertWritable("create an item")).toThrow(/read-only mode/);
  });

  it("allows every board when the allow list is empty", () => {
    const client = new MondayClient(makeConfig());
    expect(() => client.assertBoardAllowed("999")).not.toThrow();
  });

  it("blocks a board outside the allow list", () => {
    const client = new MondayClient(makeConfig({ allowedBoards: new Set(["1", "2"]) }));
    expect(() => client.assertBoardAllowed(2)).not.toThrow();
    expect(() => client.assertBoardAllowed("999")).toThrow(/outside the allowed board list/);
  });
});
