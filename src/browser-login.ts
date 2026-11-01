import { constants } from "node:fs";
import { mkdir, open, lstat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { createInterface } from "node:readline/promises";
import { chromium } from "playwright-core";
import type { Config } from "./config.js";
import { resolveLocation } from "./locator.js";

/** Save a new credential file without following or replacing an existing path. */
export async function saveBrowserState(path: string, state: unknown): Promise<void> {
  const output = resolve(path);
  const content = JSON.stringify(state);
  if (Buffer.byteLength(content) > 5 * 1024 * 1024) throw new Error("Login state exceeds 5 MiB.");
  await mkdir(dirname(output), {recursive:true,mode:0o700});
  const file = await open(output, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL, 0o600);
  try { await file.writeFile(content); } finally { await file.close(); }
}

/** User-driven login in an empty, dedicated browser. Never reads a personal profile. */
export async function browserLogin(config: Config): Promise<void> {
  if (!config.browserState) throw new Error("--browser-login requires --browser-state <new private file>.");
  const target = resolveLocation({account_slug:config.accountSlug}).url;
  try {
    await lstat(config.browserState);
    throw new Error("The login-state path already exists. Choose a new file for this login.");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const browser = await chromium.launch({headless:false,
    ...(config.browserExecutable ? {executablePath:config.browserExecutable} : {channel:"chrome"})});
  const input = createInterface({input:process.stdin,output:process.stderr});
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    await page.goto(target,{waitUntil:"domcontentloaded",timeout:60_000});
    await input.question("Sign in yourself in this dedicated browser. Once your account is open, press Enter here to save its login state. ");
    const actual = new URL(page.url());
    if (actual.origin !== new URL(target).origin || /\/(login|auth|sso|sign[-_]?in)(\/|$)/i.test(actual.pathname)) {
      throw new Error("The requested account is not open. Login state was not saved.");
    }
    await saveBrowserState(config.browserState,await context.storageState({indexedDB:true}));
    process.stderr.write("Saved the private login-state file. A browser tool call still needs to verify that the session works.\n");
  } finally { input.close(); await browser.close(); }
}
