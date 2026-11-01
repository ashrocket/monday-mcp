import { mkdtemp, readFile, stat, symlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, it, expect } from "vitest";
import { loadConfig } from "../src/config.js";
import { resolveLocation } from "../src/locator.js";
import { createServer } from "../src/server.js";
import { saveBrowserState } from "../src/browser-login.js";

describe("UI policy and configuration", () => {
  it.each(["tru", "", "disabled", "ture"])("rejects an invalid read-only policy: %s", value => {
    expect(() => loadConfig(["--desktop-only"],{MONDAY_READ_ONLY:value})).toThrow(/Boolean/);
  });
  it.each(["", ",,", "111,not-a-board"])("rejects a malformed board policy: %s", value => {
    expect(() => loadConfig(["--desktop-only"],{MONDAY_ALLOWED_BOARDS:value})).toThrow(/allow list/);
  });
  it("rejects a missing board policy argument", () => {
    expect(() => loadConfig(["--desktop-only","--boards"],{})).toThrow(/--boards needs/);
  });
  it("supports explicit browser-only mode without a token", () => {
    const config = loadConfig(["--browser-only","--account-slug","fixture"],{});
    expect(config.browser).toBe(true); expect(config.desktopOnly).toBe(true); expect(config.token).toBe("");
  });
  it("browser-only does not inherit or read API credentials", async () => {
    const config = loadConfig(["--browser-only","--account-slug","fixture"],{
      MONDAY_API_TOKEN:"must-not-be-used",MONDAY_API_TOKEN_FILE:"/does/not/exist",
    });
    expect(config.token).toBe("");
    const fileOnly = loadConfig(["--browser-only"],{MONDAY_API_TOKEN_FILE:"/does/not/exist"});
    expect(fileOnly.token).toBe("");
    const server=createServer(config);
    const client=new Client({name:"browser-only-policy",version:"1"});
    const [a,b]=InMemoryTransport.createLinkedPair();
    await server.connect(b);await client.connect(a);
    try {
      expect((await client.listTools()).tools.map(t=>t.name).sort()).toEqual([
        "monday_open","monday_resolve_location","monday_ui_action",
      ]);
    } finally {await client.close();await server.close();}
  });
  it.each(["../222", "%2e%2e%2f222", "111/../../222", "111?view=222", "111#222", "111\\222"])("rejects a path injection: %s", board_id => {
    expect(() => resolveLocation({account_slug:"fixture",board_id})).toThrow(/single id/);
  });
  it("blocks actual UI access even for an allowed board, and never advertises UI posting", async () => {
    const server = createServer(loadConfig(["--desktop-only","--boards","111","--account-slug","fixture"],{}));
    const client = new Client({name:"policy-test",version:"1"});
    const [a,b] = InMemoryTransport.createLinkedPair();
    await server.connect(b); await client.connect(a);
    try {
      for (const name of ["monday_open","monday_ui_action"]) {
        const result = await client.callTool({name,arguments:{board_id:"111",item_id:"1",action:"read_card",mode:"desktop"}});
        expect(result.isError).toBe(true);
        expect(JSON.stringify(result)).toContain("disabled with a board allow list");
      }
      const tools = (await client.listTools()).tools;
      const action = tools.find(t => t.name === "monday_ui_action")!;
      expect(JSON.stringify(action.inputSchema)).not.toContain("post_update");
      const denied = await client.callTool({name:"monday_resolve_location",arguments:{board_id:"222"}});
      expect(denied.isError).toBe(true);
    } finally {await client.close();await server.close();}
  });
});

describe("private login-state output", () => {
  it("creates a private file and refuses overwrites or symlinks", async () => {
    const directory = await mkdtemp(join(tmpdir(),"monday-login-test-"));
    const path = join(directory,"state.storage-state.json");
    await saveBrowserState(path,{cookies:[],origins:[]});
    if (process.platform !== "win32") expect((await stat(path)).mode & 0o777).toBe(0o600);
    await expect(saveBrowserState(path,{cookies:["overwrite"]})).rejects.toThrow();
    expect(JSON.parse(await readFile(path,"utf8"))).toEqual({cookies:[],origins:[]});
    if (process.platform !== "win32") {
      const link = join(directory,"link"); await symlink(path,link);
      await expect(saveBrowserState(link,{})).rejects.toThrow();
    }
  });
});
