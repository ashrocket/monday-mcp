# monday-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for
[monday.com](https://monday.com), with direct GraphQL tools and optional local
browser and desktop access.

It runs on your machine and speaks straight to the monday.com GraphQL API. You
supply the token locally; the server sends it to the configured API endpoint.
The connector adds no hosted relay or telemetry.

The connector is free software under the MIT License; there is no license fee to
use monday-mcp. A monday.com account, its plan features, API limits, and any
applicable monday.com charges are separate. This does not make every monday.com
plan free or remove its rate limits. See [LICENSE](LICENSE) and
[`docs/architecture.md`](docs/architecture.md).

> **Unofficial.** This project is not built by monday.com, and it carries no
> endorsement from monday.com. "monday.com" is a trademark of monday.com Ltd.

```
Codex or any MCP client
        |  stdio
   monday-mcp  (this server, on your machine)
        |  HTTPS
   api.monday.com
```

The server uses MCP over standard input/output between the client and the local
process, then HTTPS GraphQL requests to monday.com. See the detailed
[architecture and multi-agent diagrams](docs/architecture.md).

---

## Contents

- [Why another monday.com server](#why-another-mondaycom-server)
- [Ways to reach monday.com](#ways-to-reach-mondaycom)
- [The addressing model](#the-addressing-model)
- [Mode 3 — the API server (start here)](#mode-3--the-api-server-start-here)
  - [Install](#install) · [Get a token](#get-an-api-token) · [Connect it](#connect-it) · [Prove it works](#prove-it-works)
  - [Tools](#tools) · [Column values](#column-values) · [Safety](#safety) · [Options](#options) · [Rate limits](#rate-limits)
- [Mode 1 — the desktop app over CDP (no API token)](#mode-1--the-desktop-app-over-cdp-no-api-token)
- [Mode 2 — the web app in a browser](#mode-2--the-web-app-in-a-browser)
- [Security & privacy](#security--privacy)
- [How this was mapped](#how-this-was-mapped)
- [Develop](#develop) · [Contributing](#contributing) · [Licence](#licence)

---

## Why another monday.com server

Most failures with the monday.com API come from one thing: every column type
stores a different JSON shape. A model that writes `"Done"` into a status
column gets a silent no-op or an error with no clue in it.

This server does the translation. You send a plain value, and the server
converts it to the shape monday.com stores.

```jsonc
// what the model sends
{ "Status": "Done", "Due date": "2026-08-14", "Owner": [12345678] }

// what monday.com receives
{
  "status":  { "index": 1 },
  "date_1":  { "date": "2026-08-14" },
  "person":  { "personsAndTeams": [{ "id": 12345678, "kind": "person" }] }
}
```

The server also refuses a bad value **before** it sends a request, and the
refusal names the labels the column accepts:

```
Column "Status" has no status "Shipped".
It accepts: "Working on it", "Done", "Stuck".
Send create_labels_if_missing true to add it.
```

Three more things this server does:

- **Column titles work as keys.** Use `"Due date"` or `date_1`. Letter case,
  spaces, hyphens and underscores do not matter.
- **Status filters translate too.** A filter on `"Stuck"` becomes the numeric
  label index that the API needs.
- **Safety rails.** A read-only mode, a board allow list, and a permanent
  delete that needs explicit confirmation.

---

## Ways to reach monday.com

The API is the data path. Optional browser and desktop paths support opening
locations and reading a bounded item-card snapshot. They do not provide general
board-cell access or UI posting. See [the interface map](docs/interface-map.md)
for the separate historical investigation of monday.com's web surfaces.

| Path | Connection | Capabilities |
|---|---|---|
| GraphQL API | Token from local environment or token file; HTTPS to monday.com | Supported data tools and raw GraphQL when policy permits |
| Dedicated browser | Optional headless Chrome process with explicit saved login state | Open supported locations; read a bounded item-card snapshot |
| Browser handoff | Another browser tool controlled by the client | Returns a URL and instructions; monday-mcp does not control that browser |
| Desktop app | Optional local desktop app debug port | Open supported locations; read a bounded item-card snapshot |

Use the API for board data and mutations. Browser and desktop tools are limited
to location navigation and item-card reading; posting updates is available
through `monday_create_update` on the API path.

---

## The addressing model

Every mode is a function of one address. Resolve it once, dispatch anywhere:

```ts
interface MondayLocator {
  account_slug: string;   // "acme" -> https://acme.monday.com   (required for URL modes)
  board_id?: string;      // e.g. "9876543210"
  view_id?: string;       // a board view (tab)
  item_id?: string;       // a.k.a. pulse id
  update_id?: string;     // an update/post on an item
  asset_id?: string;      // a file on an item
  doc_id?: string; block_id?: string;   // a workdoc / a block in it
  workspace_id?: string; dashboard_id?: string;
  group_id?: string;      // NOT URL-addressable — from the API (or a board's data-group-id)
  column_id?: string;     // NOT URL-addressable — from the API
}
```

**The hard ceiling.** Only **board / view / item / update** (plus `?asset_id=` and
`?doc_id=&blockId=`) are URL‑addressable. **Groups and columns have no URL anchor at all** —
resolve them through the API before any browser‑mode step that needs them.

| Target | URL (under `https://<slug>.monday.com`) |
|---|---|
| Board | `/boards/<board_id>` |
| Board view | `/boards/<board_id>/views/<view_id>` |
| Item (opens the card overlay) | `/boards/<board_id>/pulses/<item_id>` |
| Update on an item | `/boards/<board_id>/pulses/<item_id>/posts/<update_id>` |
| File over an item | `/boards/<board_id>/pulses/<item_id>?asset_id=<asset_id>` |
| Standalone workdoc | `/docs/<doc_id>` |
| Workspace | `/workspaces/<workspace_id>` |
| Public board view (no login) | `https://view.monday.com/<hash>` |

---

## Mode 3 — the API server (start here)

This is the MCP server. Node 20 or newer.

### Install

```bash
git clone https://github.com/ashrocket/monday-mcp.git
cd monday-mcp
npm install          # this also builds, through the prepare script
```

### Get an API token

1. Open monday.com and click your profile picture at the top right.
2. Select **Developers**, then **API token > Show**.
3. Copy your personal token.

Account admins can also find their personal API token under
**Administration > Connections > Personal API token**. Personal tokens mirror
the user's monday.com permissions. See monday.com's current
[authentication documentation](https://developer.monday.com/api-reference/docs/authentication).

### Connect it

**Codex** — add a local MCP server in Codex's MCP server settings. Use `node`
as the command and the absolute path to `dist/index.js` as its argument; provide
`MONDAY_API_TOKEN` in that server's environment. The exact settings location
depends on whether you use the Codex app or CLI; consult the MCP settings shown
by your installed Codex version.

**Claude Code**

```bash
claude mcp add monday --env MONDAY_API_TOKEN=your-token -- node /full/path/to/monday-mcp/dist/index.js
```

**Claude Desktop, Cursor, and other clients** — add this to the MCP server configuration file:

```json
{
  "mcpServers": {
    "monday": {
      "command": "node",
      "args": ["/full/path/to/monday-mcp/dist/index.js"],
      "env": { "MONDAY_API_TOKEN": "your-token" }
    }
  }
}
```

To keep the token out of the configuration file, put it in a file and point
at the file instead:

```json
{
  "mcpServers": {
    "monday": {
      "command": "node",
      "args": [
        "/full/path/to/monday-mcp/dist/index.js",
        "--token-file",
        "~/.config/monday/token"
      ]
    }
  }
}
```

The server takes its configuration from the environment that the MCP client
gives it. It does **not** read a `.env` file by itself. For local work, use
Node's own flag: `node --env-file=.env dist/index.js`.

### Prove it works

```bash
cp .env.example .env      # then put your token in .env
npm run smoke             # read-only checks against your account
npm run smoke -- --write  # adds a create, update, comment and archive cycle
```

The default smoke test forces read-only mode. The optional write cycle creates
real account data and attempts to archive its test item; inspect the result if
any step fails.

### Tools

| Tool | What it does |
| --- | --- |
| `monday_get_me` | The user behind the token, and the account. Prove the connection. |
| `monday_list_boards` | List or search boards. Returns the board ids. |
| `monday_get_board` | Groups, columns, and the labels each status or dropdown accepts. |
| `monday_list_items` | A page of items, filtered, with readable column text. |
| `monday_get_items` | Full detail for up to 100 items, with column ids and stored JSON. |
| `monday_create_item` | Create an item, with plain column values. |
| `monday_update_item` | Change columns, the name, or both. |
| `monday_move_item` | Move an item to another group. |
| `monday_create_subitem` | Create a subitem, with column values. |
| `monday_delete_item` | Archive by default. Permanent delete needs `confirm: true`. |
| `monday_list_updates` | Read the conversation on an item. |
| `monday_create_update` | Post a comment on an item. |
| `monday_list_users` | Find the numeric user id a people column needs. |
| `monday_list_workspaces` | List the workspaces. |
| `monday_graphql` | An escape hatch for anything the other tools miss. |

In read-only mode the API read tools remain available, and `monday_graphql`
accepts queries but refuses mutations. If a board allow list is set,
`monday_graphql` is omitted because arbitrary documents cannot honor that list.
Account-level tools may still return account metadata.

Three more tools address and drive the other modes. They register in **every** mode,
including with no token at all:

| Tool | What it does |
| --- | --- |
| `monday_resolve_location` | Turns ids into the URL that addresses them, plus the `group_id` / `column_id` no URL can carry. Resolve once, dispatch to any mode. |
| `monday_open` | Opens a location in the configured background browser or desktop app. `mode: "chrome"` returns a URL and instructions for a separate browser tool. |
| `monday_ui_action` | `read_card` returns a bounded snapshot from an item card. UI posting is disabled; use `monday_create_update` with an API token to post. |

Board **grid cells are not reachable by these UI tools** — the grid is a canvas,
not DOM. Item-card snapshots are bounded and may be incomplete. Switching a
board view and running the Excel export are not implemented.

### Column values

Pass `values` keyed by column id or column title. Use the plain form below.
An object value passes through untouched, so you keep control when you need
the exact API shape.

| Column type | Send this | Server sends this |
| --- | --- | --- |
| `text`, `name` | `"some text"` | `"some text"` |
| `long_text` | `"a paragraph"` | `{"text": "a paragraph"}` |
| `numbers` | `42` | `"42"` |
| `status` | `"Done"` | `{"index": 1}` |
| `dropdown` | `["Design", "Build"]` | `{"labels": ["Design", "Build"]}` |
| `date` | `"2026-08-14 09:30"` | `{"date": "2026-08-14", "time": "09:30:00"}` |
| `timeline` | `["2026-08-01", "2026-08-31"]` | `{"from": "...", "to": "..."}` |
| `people` | `[12345678, "team:99"]` | `{"personsAndTeams": [...]}` |
| `checkbox` | `true` | `{"checked": "true"}` |
| `link` | `"https://example.com"` | `{"url": "...", "text": "..."}` |
| `email` | `"a@b.com"` | `{"email": "a@b.com", "text": "a@b.com"}` |
| `phone` | `"+442071234567"` or `["07700900123", "GB"]` | `{"phone": "...", "countryShortName": "GB"}` |
| `tags` | `[1234]` | `{"tag_ids": [1234]}` |
| `board_relation` | `[987654321]` | `{"item_ids": [987654321]}` |
| `dependency` | `[987654321]` | `{"item_ids": [987654321]}` |
| `hour` | `"14:30"` | `{"hour": 14, "minute": 30}` |
| `rating` | `4` | `{"rating": 4}` |
| `country` | `"GB"` | `{"countryCode": "GB", "countryName": "United Kingdom"}` |
| `week` | `["2026-08-03", "2026-08-09"]` | `{"week": {"startDate": "...", "endDate": "..."}}` |
| `world_clock` | `"Europe/London"` | `{"timezone": "Europe/London"}` |
| `location` | `{"lat": "51.5", "lng": "-0.12", "address": "London"}` | the same object |

Send `null` to clear a column.

Three notes on the awkward ones:

- **`phone`** needs a country as well as a number. An international number
  carries one, so `"+442071234567"` works. A local number does not, so send
  `["07700900123", "GB"]`.
- **`location`** stores coordinates. monday.com does not turn an address into
  coordinates, and neither does this server, so send `lat` and `lng`.
- **`status` and `dropdown`** reject a label the board does not have. Pass
  `create_labels_if_missing: true` to add it instead.

These types are not writable, because monday.com computes them:
`auto_number`, `button`, `creation_log`, `formula`, `integration`, `item_id`,
`last_updated`, `mirror`, `progress`, `subtasks`, `time_tracking`, `vote`.

A `file` or `doc` column needs the separate upload endpoint, which this
server does not expose.

### Safety

| Setting | Effect |
| --- | --- |
| `--read-only` or `MONDAY_READ_ONLY=1` | Only read tools get registered. A raw mutation is refused. |
| `--boards 111,222` or `MONDAY_ALLOWED_BOARDS=111,222` | Board-scoped API tools enforce the list. Browser and desktop access are disabled because a signed-in UI session cannot enforce the list. Raw GraphQL is omitted. Account-level tools may still expose account metadata; this is not a tenant security boundary. |
| `mode: "delete"` | Needs `confirm: true`. The default mode archives instead, which a person can undo. |

The API client redacts the configured token from its API error text. Tool
results can still contain account and board data returned by monday.com; treat
that content as sensitive and untrusted.

### Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--token` | `MONDAY_API_TOKEN` | none, and the server refuses to start |
| `--token-file` | `MONDAY_API_TOKEN_FILE` | none |
| `--read-only` | `MONDAY_READ_ONLY` | off |
| `--boards` | `MONDAY_ALLOWED_BOARDS` | all boards |
| `--api-version` | `MONDAY_API_VERSION` | `2026-07` |
| `--api-url` | `MONDAY_API_URL` | `https://api.monday.com/v2` |
| `--desktop-only` | `MONDAY_DESKTOP_ONLY` | off |
| `--browser` | `MONDAY_BROWSER` | off |
| `--browser-only` | `MONDAY_BROWSER_ONLY` | off |
| `--browser-state` | `MONDAY_BROWSER_STATE` | none |
| `--browser-executable` | `MONDAY_BROWSER_EXECUTABLE` | installed Chrome |
| | `MONDAY_BROWSER_TIMEOUT_MS` | `60000` (maximum `120000`) |
| `--account-slug` | `MONDAY_ACCOUNT_SLUG` | read from the token |
| `--debug-port` | `MONDAY_DEBUG_PORT` | `9222` |
| | `MONDAY_TIMEOUT_MS` | `30000` |
| | `MONDAY_MAX_RETRIES` | `3` |

A flag always wins over the matching environment variable.

Boolean environment values must be `true`/`false`, `yes`/`no`, `on`/`off`, or
`1`/`0`; malformed values stop startup. If using `--boards` or
`MONDAY_ALLOWED_BOARDS`, supply one or more numeric ids. Omit the setting for
unrestricted board scope; an empty or malformed allow-list is rejected.

### Dedicated browser setup

The optional browser is a private headless Chrome process owned by one
monday-mcp process. It does not attach to a personal Chrome profile or use a
remote-debugging port. By default it launches installed Chrome; use
`--browser-executable <path>` to select another compatible binary.

Create a new login-state snapshot with an interactive login window. Choose a
private absolute path outside the repository; the example below is under the
user's config directory:

```bash
node dist/index.js --browser-login --account-slug <slug> --browser-state /Users/<your-user>/.config/monday/work.storage-state.json
```

Sign in yourself in the dedicated window and press Enter in the terminal when
the account is open. The file is credential material: keep it private and do
not commit or share it. The command requests owner-only permissions (`0600` on
macOS/Linux) and refuses to replace an existing path. On Windows, protect the
parent directory with account-specific access permissions. A successful save does not prove the
session will still authenticate later; make a browser tool call to verify it.

Enable browser tools alongside API tools with `--browser --browser-state
<same-path>`. To run browser tools without an API token, use
`--browser-only --account-slug <slug> --browser-state <same-path>`. Each MCP
process owns one browser, context, and page. The page is reused while warm and
operations are serialized, with at most 32 operations queued or active;
each operation has a deadline. Browser targets are restricted to supported
HTTPS monday.com account URLs, and the requested account and target are checked
before results are returned. A board allow list disables browser and desktop
access because a logged-in UI session cannot enforce board scoping.

Cancellation closes the owned browser. Playwright can take up to an additional
30 seconds to finish process cleanup after an operation deadline.

**Running without an API token.** `--browser-only` starts the server without an
API token and uses the dedicated browser state; `--desktop-only` uses the
already signed-in desktop app. The API tools are absent. These modes must be
asked for explicitly — a
missing token is otherwise still a hard failure, so a typo in `MONDAY_API_TOKEN` fails
loudly instead of quietly booting a server that cannot see your data.

```bash
claude mcp add monday-desktop -- node /full/path/to/monday-mcp/dist/index.js \
  --desktop-only --account-slug <your-slug>
```

`--account-slug` matters here: every monday.com URL needs the account subdomain, and
without a token there is nothing to read it from. `monday_resolve_location` fails with
a clear message rather than emitting a slug-less URL, which would 404.

**About the API version.** monday.com retires an API version every quarter, and a
request that names a retired version quietly gets the maintenance version instead. That
makes a stale default worse than no default, so this server pins a current one and you can
override it. Check the
[versioning page](https://developer.monday.com/api-reference/docs/api-versioning)
when you upgrade.

### Rate limits

monday.com applies complexity, daily call, concurrency, and other limits. The client reads
the reset hint from the throttle response, whether it arrives in the
`retry-after` header or in the message body, and waits for that long. Other
transient failures use exponential backoff.

Only reads retry, for recognized transient and throttling failures, within the
configured retry count and a total request deadline of 45 seconds. A
complexity window can be a full minute, so the server reports the throttle and
lets the caller decide to try again. Mutations never retry automatically: after
a failed response, the server cannot know whether monday.com applied the
change. Check current state before deciding whether to resubmit.

Board layouts stay in a cache for one minute, which keeps a run of writes off
the budget.

See monday.com's [rate-limit documentation](https://developer.monday.com/api-reference/docs/rate-limits)
for current account and plan limits. When a multi-step write partly succeeds,
the tool returns an error with a structured receipt of the acknowledged changes.
Use that receipt and read the current item before retrying.

---

## Mode 1 — the desktop app over CDP (no API token)

The legacy desktop path attaches to the monday.com desktop app over its local
debug port. The port is unauthenticated and exposes the logged-in session to
local processes while open; use this path only when needed and close the app
afterward. Its UI tools open locations and read bounded item-card snapshots.
UI posting is disabled because composer and draft behavior can cross item
boundaries. To post, use `monday_create_update` through the API. A configured
board allow list disables this desktop path.

---

## Mode 2 — the web app in a browser

For opening a location or reading an item-card snapshot without API access, use
the dedicated headless browser described in [Dedicated browser setup](#dedicated-browser-setup).
The browser is owned by this MCP process and uses an explicit login-state file.
It does not reuse a personal browser profile or remote-debugging port.

**External browser handoff.** `monday_open` can return a URL and instructions
for another browser tool. monday-mcp does not control that browser. A configured
board allow list disables the integrated browser and desktop paths.

The board grid has renderer-specific behavior documented in
[`docs/interface-map.md`](docs/interface-map.md). On the current renderer, grid
cells are painted on a canvas rather than exposed as DOM elements. UI snapshots
are not a substitute for API data reads and are explicitly incomplete. UI
posting is unavailable; use the API tool for updates.

---

## Security & privacy

- **Credentials stay in local configuration.** The API token is sent to monday.com over
  HTTPS. The optional browser state file contains login credentials and must be protected.
  The connector does not add a hosted relay; tool results can include account data.
- **Never commit a token.** `.env`, `*.token`, and friends are gitignored; only
  `.env.example` (a placeholder) is tracked.
- **Read-only and board allow-list** modes constrain API tools. The allow list also disables
  browser and desktop access, but account-level tools can still return metadata. These are
  operational controls, not a tenant isolation boundary (see [Safety](#safety)).
- **The desktop CDP debug port is unauthenticated** and exposes the signed-in session to
  local processes while open. Close the desktop app when finished with that path.
- Browser snapshots may contain private board content. Treat results as sensitive and
  untrusted input.

---

## How this was mapped

[`docs/interface-map.md`](docs/interface-map.md) records a historical investigation of
monday.com URL, API, and UI behavior, with evidence labels and unresolved questions. Some
browser findings describe earlier external-browser workflows; the implemented local browser
contract is documented above and in [`docs/architecture.md`](docs/architecture.md).

---

## Develop

```bash
npm test          # tests, no network
npm run typecheck # source and tests
npm run build
npm run stress    # real MCP child processes against a local fake API
npm run dev       # rebuild on save
```

The tests run the real MCP server against a fake monday.com API over an
in-memory transport. They assert the exact JSON that goes over the wire.
See [test instructions and recorded local results](docs/testing.md) for the
multi-process stress and real-browser fixtures.
`test/regressions.test.ts` holds one test per defect found so far, named
after the behaviour that was wrong.

`scripts/cdp-desktop.mjs` imports the built desktop implementation used by the
MCP tools, so discovery checks, locking, and deadlines share one code path.
Run the build before using the CLI. Separate processes serialize access to the
same desktop debug port with a shared lock; an abandoned lock fails closed.

The real Chrome fixture is opt-in. Set `MONDAY_TEST_BROWSER_EXECUTABLE` to the
absolute browser executable path before running `test/browser.test.ts`. It
launches dedicated headless processes and intercepts page requests with
synthetic fixtures. A skipped test is not browser verification.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
