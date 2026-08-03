#!/usr/bin/env node
/**
 * Marks the built entry point executable.
 *
 * `chmod` in an npm script fails on Windows, where cmd.exe has no such
 * command, so the whole build breaks on a platform CI never tests.
 */
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const entry = join(dirname(fileURLToPath(import.meta.url)), "..", "dist", "index.js");

if (process.platform === "win32") {
  // Windows has no executable bit. npm writes its own shim for the bin.
  process.exit(0);
}

try {
  await chmod(entry, 0o755);
} catch (error) {
  console.error(`Could not mark ${entry} executable: ${error.message}`);
  process.exit(1);
}
