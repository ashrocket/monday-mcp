import { mkdtempSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { ConfigError, loadConfig, parseArgs } from "../src/config.js";

describe("parseArgs", () => {
  it("reads a value that follows the flag", () => {
    expect(parseArgs(["--token", "abc"])).toEqual({ token: "abc" });
  });

  it("reads a value joined by an equals sign", () => {
    expect(parseArgs(["--token=abc"])).toEqual({ token: "abc" });
  });

  it("treats a bare --read-only as true", () => {
    expect(parseArgs(["--read-only"]).readOnly).toBe(true);
  });

  it("does not eat the next flag as a value", () => {
    expect(parseArgs(["--token", "--read-only"])).toEqual({
      token: undefined,
      readOnly: true,
    });
  });

  it("reads several flags at once", () => {
    expect(parseArgs(["--token", "t", "--boards", "1,2", "--api-version", "2025-01"])).toEqual({
      token: "t",
      allowedBoards: "1,2",
      apiVersion: "2025-01",
    });
  });
});

describe("loadConfig", () => {
  it("fails with instructions when no token exists", () => {
    expect(() => loadConfig([], {})).toThrow(ConfigError);
    expect(() => loadConfig([], {})).toThrow(/My access tokens/);
  });

  it("prefers a flag over the environment", () => {
    const config = loadConfig(["--token", "from-flag"], { MONDAY_API_TOKEN: "from-env" });
    expect(config.token).toBe("from-flag");
  });

  it("reads a token from a file and strips whitespace", () => {
    const dir = mkdtempSync(join(tmpdir(), "monday-mcp-"));
    const path = join(dir, "token");
    writeFileSync(path, "  file-token\n");
    expect(loadConfig(["--token-file", path], {}).token).toBe("file-token");
  });

  it("parses the board allow list", () => {
    const config = loadConfig([], {
      MONDAY_API_TOKEN: "t",
      MONDAY_ALLOWED_BOARDS: " 1 , 2 ,",
    });
    expect([...config.allowedBoards]).toEqual(["1", "2"]);
  });

  it("reads read-only from the environment", () => {
    expect(loadConfig([], { MONDAY_API_TOKEN: "t", MONDAY_READ_ONLY: "true" }).readOnly).toBe(
      true,
    );
    expect(loadConfig([], { MONDAY_API_TOKEN: "t", MONDAY_READ_ONLY: "0" }).readOnly).toBe(false);
    expect(loadConfig([], { MONDAY_API_TOKEN: "t" }).readOnly).toBe(false);
  });

  it("treats MONDAY_MAX_RETRIES=0 as a real choice, not a missing value", () => {
    expect(loadConfig([], { MONDAY_API_TOKEN: "t", MONDAY_MAX_RETRIES: "0" }).maxRetries).toBe(0);
  });

  it("expands a tilde in a token file path", () => {
    // The separator differs by platform, so assert the expansion itself.
    let message = "";
    try {
      loadConfig(["--token-file", "~/definitely-not-here"], {});
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toContain("Cannot read the token file at");
    expect(message).toContain(homedir());
    expect(message).not.toContain("~");
  });

  it("uses sane defaults", () => {
    const config = loadConfig([], { MONDAY_API_TOKEN: "t" });
    expect(config.apiUrl).toBe("https://api.monday.com/v2");
    expect(config.apiVersion).toBe("2026-07");
    expect(config.maxRetries).toBe(3);
    expect(config.timeoutMs).toBe(30_000);
  });
});
