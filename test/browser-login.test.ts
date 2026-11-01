import { EventEmitter } from "node:events";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";
import { afterEach, expect, it, vi } from "vitest";
import { browserLogin } from "../src/browser-login.js";
import { loadConfig } from "../src/config.js";

vi.mock("node:readline/promises", () => ({ createInterface: vi.fn() }));
const directories: string[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(directories.splice(0).map(path => rm(path,{recursive:true,force:true})));
});

async function fixture() {
  const directory = await mkdtemp(join(tmpdir(),"monday-login-lifecycle-"));
  directories.push(directory);
  const path = join(directory,"new.storage-state.json");
  const config = loadConfig(["--browser-only","--account-slug","fixture","--browser-state",path],{});
  let entered!: () => void;
  let answer!: () => void;
  const waiting = new Promise<void>(resolve => { entered=resolve; });
  const input = Object.assign(new EventEmitter(),{
    question:vi.fn((_prompt:string, options:{signal:AbortSignal}) => new Promise<string>((resolve,reject) => {
      answer=()=>resolve("");
      if(options.signal.aborted) reject(options.signal.reason);
      else options.signal.addEventListener("abort",()=>reject(options.signal.reason),{once:true});
      entered();
    })),
    close:vi.fn(),
  });
  const page = Object.assign(new EventEmitter(),{
    goto:vi.fn().mockResolvedValue(undefined),
    bringToFront:vi.fn().mockResolvedValue(undefined),
    url:()=>"https://fixture.monday.com/my_work",
  });
  const context = {newPage:vi.fn().mockResolvedValue(page),storageState:vi.fn().mockResolvedValue({cookies:[],origins:[]})};
  const browser = Object.assign(new EventEmitter(),{newContext:vi.fn().mockResolvedValue(context),close:vi.fn().mockResolvedValue(undefined)});
  vi.mocked(createInterface).mockReturnValue(input as unknown as ReturnType<typeof createInterface>);
  vi.spyOn(chromium,"launch").mockResolvedValue(browser as unknown as Awaited<ReturnType<typeof chromium.launch>>);
  return {config,path,input,page,context,browser,waiting,answer:()=>answer()};
}

it.each(["browser","page","input"] as const)("ends the login instead of hanging when %s closes", async kind => {
  const f=await fixture();
  const outcome=browserLogin(f.config);
  const rejected=expect(outcome).rejects.toThrow(/closed before login was saved/);
  await f.waiting;
  if(kind==="browser") f.browser.emit("disconnected");
  else if(kind==="page") f.page.emit("close");
  else f.input.emit("close");
  await rejected;
  expect(f.context.storageState).not.toHaveBeenCalled();
  await expect(readFile(f.path)).rejects.toThrow();
  expect(f.input.close).toHaveBeenCalledOnce();
  expect(f.browser.close).toHaveBeenCalledOnce();
});

it("activates the login tab before prompting and saves only after the answer", async () => {
  const f=await fixture();
  const outcome=browserLogin(f.config);
  await f.waiting;
  expect(f.page.bringToFront.mock.invocationCallOrder[0]).toBeLessThan(f.input.question.mock.invocationCallOrder[0]!);
  expect(f.context.storageState).not.toHaveBeenCalled();
  f.answer(); await outcome;
  expect(JSON.parse(await readFile(f.path,"utf8"))).toEqual({cookies:[],origins:[]});
  expect(f.browser.close).toHaveBeenCalledOnce();
});
