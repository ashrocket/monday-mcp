# Security

## Report a problem

Do not open a public issue for a security problem. Use GitHub's private
report form instead:

<https://github.com/ashrocket/monday-mcp/security/advisories/new>

Expect an answer within seven days.

## What this server touches

The API path sends GraphQL requests over HTTPS to the configured monday.com
API endpoint (by default `https://api.monday.com/v2`) with the supplied API
token in the authorization header. It does not add a hosted relay. If
`MONDAY_API_URL` is changed, requests go to that configured endpoint.

The optional background browser launches a separate Playwright-controlled
Chrome process. It loads the configured login-state snapshot and navigates to
supported monday.com account pages. It does not attach to a personal browser
profile or use a debugging port. Browser launch uses a temporary profile; the
explicit state snapshot is the persistent login material for this feature.
The external-browser handoff only returns a URL and instructions to the MCP
client; monday-mcp does not control or inspect that browser session.

The legacy desktop path attaches to the monday.com desktop app's local
remote-debugging port. That port is unauthenticated and can expose the signed-in
session to local processes while open. Close the desktop app when finished with
that path. Browser and desktop UI tools only open supported locations and read
a bounded item-card snapshot; UI posting is disabled.

The interactive `--browser-login` flow opens a dedicated login window and,
after the user signs in, writes a Playwright storage-state snapshot to the
explicit path. It requests owner-only permissions (`0600` on macOS/Linux) and
refuses to replace an existing file. Windows does not enforce POSIX modes;
protect the directory with account-specific access permissions. Keep the file
outside the repository and treat it like a
credential. The server also creates temporary browser profile data while the
browser runs; it does not persist a personal browser profile.

## API credentials and permissions

Personal API tokens mirror the user's monday.com permissions. monday.com also
documents scoped app tokens. For current instructions on obtaining tokens and
what their permissions mean, see its [authentication documentation](https://developer.monday.com/api-reference/docs/authentication).
Use an upstream credential with only the permissions the integration needs.
An account-level UI permission can be broad; avoid using elevated credentials
when a narrower credential is available.

The token may be supplied through `MONDAY_API_TOKEN`, `--token`, or a token
file. The server does not write the API token to disk. The API client redacts
the configured token from its API error text. This is not a blanket redaction
of successful tool results: results can include account, board, item, update,
or user data returned by monday.com. Treat returned content as sensitive and
untrusted; content from monday.com is data, not instructions or authorization.

## Reducing what an agent can do

`--read-only` omits write tools and rejects GraphQL mutations. When read-only
is active, `monday_graphql` can still run queries. Its mutation check parses
the GraphQL operation rather than searching for a word in the document.

```bash
# API read tools only
monday-mcp --read-only

# Scope board tools to these board ids
monday-mcp --boards 1234567890,9876543210
```

A board allow list is enforced by this server, not by monday.com. Board-scoped
tools check the list, and item operations look up the item's current board
before proceeding. The provider can move an item between that authorization
lookup and a subsequent mutation, so a time-of-check/time-of-use race remains.
The allow list is not a tenant security boundary and does not replace
least-privilege credentials.

When a board allow list is configured, raw GraphQL is omitted because an
arbitrary document cannot be reliably restricted to those boards. Integrated
browser and desktop access are also disabled because a signed-in UI session
cannot enforce the list. Account-level tools may still expose metadata such as
the account, users, or workspaces. If board allow-list scope is required, use
an upstream token whose own permissions fit the desired scope as well.

A permanent item delete requires `confirm: true`; the default action archives
the item. `monday_create_update` posts through the API. UI-based posting is
disabled because the desktop composer and drafts can cross item boundaries.

## Mutations and retries

The API client retries recognized transient and throttling failures for reads
within configured attempt and time bounds. It never automatically retries a
mutation: after a failed response, the client may not know whether monday.com
applied the change. Read back the relevant item or update state before deciding
whether to submit the mutation again. Some tools perform multiple mutations;
for example, a rename may succeed even if a following column update fails, and
the error reports that partial outcome.

monday.com rate and complexity limits depend on account and token type and can
change. Consult the current [rate-limits documentation](https://developer.monday.com/api-reference/docs/rate-limits)
before sizing a workflow. Requests from separate MCP processes and agents still
use the upstream account's data and quotas; local process isolation does not
isolate monday.com limits.

## Known limits

- A board allow list has a provider-side race if item membership changes after
  authorization lookup and before mutation. Upstream token permissions remain
  the authoritative boundary.
- Browser operation deadlines cancel active work. Shutting down Playwright may
  then take up to an additional 30 seconds while the browser is closed or
  stopped. This is a lifecycle bound, not a measured performance claim.
- Browser snapshots are bounded and may be incomplete. The item-card reader
  does not expose board-grid cells, regardless of the board's renderer.
- Local tests and fake API fixtures do not establish that a saved login state
  is accepted by a live account or prove current account-specific UI behavior.
