# Testing monday-mcp

The automated checks use synthetic data. They do not require a monday.com token
and must not use a personal browser profile or customer account.

```bash
npm ci
npm run typecheck
npm test -- --maxWorkers=1
npm run build
node --test .github/ci/tests/scope-check.mjs
node scripts/stress.mjs --agents 8 --requests 100 --concurrency 8
```

The stress harness starts separate MCP stdio child processes and a loopback
HTTP fixture. It checks response isolation, overlapping requests, bounded read
retries, and single-attempt mutations when the response is lost. It uses
synthetic tokens and never loads `.env`. `--output <path>` saves JSON results.

## Browser fixture

The ordinary suite skips real Chrome unless an executable is explicitly given:

```bash
MONDAY_TEST_BROWSER_EXECUTABLE=/absolute/path/to/chrome npm test -- --maxWorkers=1
```

The fixture starts dedicated headless browser processes, intercepts page
requests with synthetic content, and checks reuse, isolation, redirect rejection,
cancellation, and shutdown. `MONDAY_TEST_BROWSER_REPORT=<absolute-path>` saves a
JSON receipt. It does not test a real login-state snapshot. Cold startup can
take several seconds on a busy machine; the integration fixture allows 20
seconds per operation, while the production default is 60 seconds.

## Recorded local results

On 2026-11-01, the macOS run passed all 244 tests in 14 files, including
the real Chrome fixture. Typecheck, build, and all three CI scope checks passed.
The full dependency audit reported zero known vulnerabilities.

| Fixture | Reads | HTTP requests | Peak concurrent HTTP | Assertion failures | Duplicate commits |
| --- | ---: | ---: | ---: | ---: | ---: |
| Four MCP processes, four in-flight calls each | 400 | 448 | 16 | 0 | 0 |
| Eight MCP processes, eight in-flight calls each | 800 | 896 | 56 | 0 | 0 |

The eight-process run completed in 8.784 seconds. Read latency was 65.74 ms p50
and 875.27 ms p95. Expected error responses from the injected failure scenarios
were checked as part of the test, not counted as successful writes.

Two independent real Chrome instances completed 20 interleaved reads with zero
mixed results. Cold startup took 6,089.28 ms; warm reads including queue time
measured 21.70 ms p50 and 62.63 ms p95. All owned browsers closed.

These are one-run measurements of local fixtures on a shared machine. They do
not measure monday.com latency, account quota capacity, live login acceptance,
or performance relative to the desktop app. Separate agents still share the
upstream account's data and limits. See [SECURITY.md](../SECURITY.md) for the
remaining authorization and lifecycle limits.
