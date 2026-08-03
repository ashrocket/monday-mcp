#!/usr/bin/env node
/** Empties dist/, so a stale artefact from an older build cannot ship. */
import { rm } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
await rm(dist, { recursive: true, force: true });
