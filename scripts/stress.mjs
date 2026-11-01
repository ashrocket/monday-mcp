#!/usr/bin/env node
/**
 * Local-only stress check: build first, then `node scripts/stress.mjs`.
 * Optional: --agents 4 --requests 16 --concurrency 4 --output report.json
 * Uses real MCP stdio processes and an HTTP fixture bound to loopback. Never
 * reads .env or uses a real monday.com token. A failed invariant exits 1.
 * Latencies include MCP + fixture work, excluding process startup; they are
 * not monday.com production performance measurements.
 */
import assert from "node:assert/strict";
import { existsSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";

const entry = fileURLToPath(new URL("../dist/index.js", import.meta.url));
const args = process.argv.slice(2);
const options = { agents: 4, requests: 16, concurrency: 4, output: undefined };
for (let i = 0; i < args.length; i += 2) {
  const key = args[i]?.replace(/^--/, "");
  const value = args[i + 1];
  if (!Object.hasOwn(options, key ?? "") || value === undefined) {
    throw new Error("Usage: node scripts/stress.mjs [--agents 2..8] [--requests 1..100] [--concurrency 1..8] [--output path]");
  }
  options[key] = key === "output" ? value : Number(value);
}
for (const [key, min, max] of [["agents", 2, 8], ["requests", 1, 100], ["concurrency", 1, 8]]) {
  assert(Number.isInteger(options[key]) && options[key] >= min && options[key] <= max, `${key} must be ${min}..${max}`);
}
assert(existsSync(entry), "Run npm run build before the stress check.");

const attempts = new Map();
const commits = new Map();
const httpCounts = {};
const metrics = {};
const failures = [];
const agents = [];
const abort = new AbortController();
const maxElapsedMs = 60_000;
let activeHttp = 0;
let peakHttp = 0;
let requests = 0;
let httpErrors = 0;
let fixtureErrors = 0;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const keyFor = (agent, marker) => `${agent}:${marker}`;
const fixture = createServer(async (req, res) => {
  activeHttp += 1;
  peakHttp = Math.max(peakHttp, activeHttp);
  requests += 1;
  try {
    let raw = "";
    for await (const chunk of req) raw += chunk;
    const { query, variables = {} } = JSON.parse(raw);
    const agent = String(req.headers.authorization).replace(/^fixture-agent-/, "");
    assert(/^\d+$/.test(agent), "fixture accepts synthetic agent tokens only");
    const operation = /(?:query|mutation)\s+(\w+)/.exec(query)?.[1];
    httpCounts[operation] = (httpCounts[operation] ?? 0) + 1;
    const marker = variables.marker ?? variables.itemName ?? "schema";
    const key = keyFor(agent, marker);
    const attempt = (attempts.get(key) ?? 0) + 1;
    attempts.set(key, attempt);
    // Different delays force responses to arrive out of request order.
    await delay(5 + (Number(variables.sequence ?? agent) % 4) * 8);
    const json = (status, body) => {
      if (status >= 400) httpErrors += 1;
      res.writeHead(status, { "content-type": "application/json", ...(status === 429 ? { "retry-after": "0" } : {}) });
      res.end(JSON.stringify(body));
    };
    if (operation === "GetBoard") {
      json(200, { data: { boards: [{ id: "111", name: "Fixture", groups: [], columns: [] }] } });
    } else if (operation === "StressEcho") {
      if (marker === "exhaust" || (marker === "recover" && attempt <= 2)) {
        json(429, { errors: [{ message: "Rate limited, reset in 0 seconds" }] });
      } else {
        json(200, { data: { agent, marker, sequence: variables.sequence } });
      }
    } else if (operation === "CreateItem" || operation === "StressMutation") {
      // Record the committed write BEFORE the proxy/socket loses its reply.
      commits.set(key, (commits.get(key) ?? 0) + 1);
      if (String(marker).includes("ambiguous-http")) {
        json(503, { errors: [{ message: "upstream reply lost after commit" }] });
      } else if (String(marker).includes("ambiguous-socket")) {
        httpErrors += 1;
        res.destroy();
      } else {
        json(200, { data: { create_item: { id: key, name: marker } } });
      }
    } else {
      fixtureErrors += 1;
      json(400, { errors: [{ message: `Unexpected fixture operation ${operation}` }] });
    }
  } catch (error) {
    fixtureErrors += 1;
    res.writeHead(500).end(JSON.stringify({ errors: [{ message: String(error) }] }));
  } finally {
    activeHttp -= 1;
  }
});
await new Promise((resolve, reject) => {
  fixture.once("error", reject);
  fixture.listen(0, "127.0.0.1", resolve);
});
const apiUrl = `http://127.0.0.1:${fixture.address().port}`;
const started = performance.now();
const deadline = setTimeout(() => abort.abort(new Error("stress run exceeded 60 seconds")), maxElapsedMs);
const interrupted = () => abort.abort(new Error("stress run interrupted"));
process.once("SIGINT", interrupted);
process.once("SIGTERM", interrupted);

function decode(result) {
  return JSON.parse(result.content.filter((part) => part.type === "text").map((part) => part.text).join("\n"));
}

async function check(agent, scenario, name, parameters, verify) {
  const stat = metrics[scenario] ??= { calls: 0, toolErrors: 0, transportErrors: 0, failures: 0, latencies: [] };
  stat.calls += 1;
  const start = performance.now();
  let received = false;
  try {
    const result = await agent.client.callTool({ name, arguments: parameters }, undefined, { timeout: 8_000, signal: abort.signal });
    received = true;
    if (result.isError) stat.toolErrors += 1;
    verify(result);
  } catch (error) {
    if (!received) stat.transportErrors += 1;
    stat.failures += 1;
    failures.push({ agent: agent.id, scenario, message: String(error.message ?? error).slice(0, 800) });
  } finally {
    stat.latencies.push(performance.now() - start);
  }
}

async function pooled(count, concurrency, run) {
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(count, concurrency) }, async () => {
    while (next < count && !abort.signal.aborted) await run(next++);
  }));
}

try {
  const connections = await Promise.allSettled(Array.from({ length: options.agents }, async (_, index) => {
    const id = String(index);
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [entry],
      env: {
        MONDAY_API_TOKEN: `fixture-agent-${id}`,
        MONDAY_API_TOKEN_FILE: "",
        MONDAY_API_URL: apiUrl,
        MONDAY_MAX_RETRIES: "2",
        MONDAY_TIMEOUT_MS: "1000",
        MONDAY_DESKTOP_ONLY: "false",
        MONDAY_READ_ONLY: "false",
      },
      stderr: "pipe",
      maxBufferSize: 1024 * 1024,
    });
    const client = new Client({ name: `stress-agent-${id}`, version: "1.0.0" });
    const agent = { id, client, transport, stderr: "" };
    agents.push(agent);
    transport.stderr?.on("data", (chunk) => { agent.stderr = (agent.stderr + chunk).slice(-4_000); });
    await client.connect(transport, { timeout: 10_000, signal: abort.signal });
  }));
  const failedConnection = connections.find((result) => result.status === "rejected");
  if (failedConnection) throw failedConnection.reason;

  await Promise.all(agents.map((agent) => pooled(options.requests, options.concurrency, async (sequence) => {
    const marker = `read-${sequence}`;
    await check(agent, "concurrent_reads", "monday_graphql", {
      query: "query StressEcho($marker: String!, $sequence: Int!) { me { id } }",
      variables: { marker, sequence },
    }, (result) => {
      assert(!result.isError, "read failed");
      assert.deepEqual(decode(result), { agent: agent.id, marker, sequence }, "response leaked across requests or agents");
      assert.equal(attempts.get(keyFor(agent.id, marker)), 1);
    });
  })));

  await Promise.all(agents.flatMap((agent) => ["recover", "exhaust"].map((marker) =>
    check(agent, `rate_limit_${marker}`, "monday_graphql", {
      query: "query StressEcho($marker: String!) { me { id } }", variables: { marker },
    }, (result) => {
      assert.equal(Boolean(result.isError), marker === "exhaust");
      assert.equal(attempts.get(keyFor(agent.id, marker)), 3, "retry count must be initial request plus two retries");
      if (marker === "recover") assert.deepEqual(decode(result), { agent: agent.id, marker });
    }))));

  await Promise.all(agents.map((agent) => check(agent, "successful_mutation", "monday_create_item", {
    board_id: "111", name: "success",
  }, (result) => {
    assert(!result.isError, "create failed");
    assert.deepEqual(decode(result).created, { id: keyFor(agent.id, "success"), name: "success" });
    assert.equal(commits.get(keyFor(agent.id, "success")), 1);
  })));

  for (const mode of ["http", "socket"]) {
    await Promise.all(agents.flatMap((agent) => ["tool", "raw"].map((kind) => {
      const marker = `ambiguous-${mode}-${kind}`;
      return check(agent, marker, kind === "tool" ? "monday_create_item" : "monday_graphql",
        kind === "tool" ? { board_id: "111", name: marker } : {
          query: "mutation StressMutation($itemName: String!) { create_item(board_id: 111, item_name: $itemName) { id } }",
          variables: { itemName: marker },
        }, (result) => {
          assert(result.isError, "an ambiguous reply must be surfaced to the caller");
          assert.equal(commits.get(keyFor(agent.id, marker)), 1, "ambiguous mutation was committed more than once");
        });
    })));
  }
  assert(peakHttp >= 2, "fixture saw no overlapping HTTP requests");
  assert.equal(fixtureErrors, 0, "fixture could not understand a server request");
  assert(!abort.signal.aborted, "stress run exceeded its deadline or was interrupted");
} catch (error) {
  failures.push({ scenario: "harness", message: String(error.message ?? error) });
} finally {
  clearTimeout(deadline);
  await Promise.allSettled(agents.map(async ({ client, transport }) => {
    try { await client.close(); } finally { await transport.close(); }
  }));
  fixture.closeAllConnections();
  await new Promise((resolve) => fixture.close(resolve));
  process.removeListener("SIGINT", interrupted);
  process.removeListener("SIGTERM", interrupted);
}

const percentile = (sorted, p) => Math.round(sorted[Math.max(0, Math.ceil(sorted.length * p) - 1)] * 100) / 100;
const scenarios = Object.fromEntries(Object.entries(metrics).map(([name, stat]) => {
  const sorted = stat.latencies.sort((a, b) => a - b);
  const { latencies, ...counts } = stat;
  return [name, { ...counts, latencyMs: { p50: percentile(sorted, .5), p95: percentile(sorted, .95) } }];
}));
const report = {
  passed: failures.length === 0,
  scope: "Local loopback HTTP fixture; real MCP stdio child processes; no live account or browser exercised",
  options,
  maxElapsedMs,
  elapsedMs: Math.round(performance.now() - started),
  http: { requests, errorResponsesOrDisconnects: httpErrors, peakConcurrent: peakHttp, byOperation: httpCounts, fixtureErrors },
  mutations: { committed: [...commits.values()].reduce((sum, n) => sum + n, 0), duplicateCommits: [...commits.values()].reduce((sum, n) => sum + Math.max(0, n - 1), 0) },
  scenarios,
  failureCount: failures.length,
  failures: failures.slice(0, 100),
};
const json = JSON.stringify(report, null, 2) + "\n";
if (options.output) writeFileSync(options.output, json);
process.stdout.write(json);
process.exitCode = report.passed ? 0 : 1;
