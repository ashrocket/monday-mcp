# monday-mcp development

This is a local stdio MCP server. Keep stdout reserved for the protocol and keep
tokens, login-state snapshots, private profiles, and account data out of Git and
logs. Browser tests must use synthetic fixtures and intercept external requests.

Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build`, and
`node --test .github/ci/tests/scope-check.mjs`. Run `npm run stress` after a build
for protocol concurrency changes. Browser integration tests require an explicit
`MONDAY_TEST_BROWSER_EXECUTABLE`; a skipped test is not browser verification.

Each agent gets its own MCP process. Background browser instances own private
contexts and serialize operations. Legacy desktop calls require a shared lock.
Do not bypass locks or attach to a user's everyday browser profile. A shared
monday account still has shared upstream limits and concurrent business writes.

Read-only and board restrictions are enforced in code. UI posting is disabled;
use API mutations. Do not retry ambiguous mutations. UI access is disabled with
board restrictions because the logged-in UI session has broader authority.

Use local fake API/CDP fixtures for stress and adversarial checks. Live writes,
blog publication, package releases, and deployment require their own task scope.

Normal development here does not require AWS. In a shared workspace with an
AWS account controller, follow its host-level instructions before AWS access.
