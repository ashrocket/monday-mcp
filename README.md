# monday-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for
[monday.com](https://monday.com) — plus a documented, reverse‑engineered map of
**three ways an agent can reach a monday.com location without any discovery spend**:
the GraphQL API, the web app in a browser, and the native desktop app over the Chrome
DevTools Protocol.

It runs on your machine and speaks straight to the monday.com GraphQL API. Your token
stays on your machine. No relay, no hosted middle layer, no telemetry.

> **Unofficial.** This project is not built by monday.com, and it carries no
> endorsement from monday.com. "monday.com" is a trademark of monday.com Ltd.

```
Claude, Cursor, or any MCP client
        |  stdio
   monday-mcp  (this server, on your machine)
        |  HTTPS
   api.monday.com
```

---

## Contents

- [Why another monday.com server](#why-another-mondaycom-server)
- [Three ways to reach monday.com](#three-ways-to-reach-mondaycom)
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

## Three ways to reach monday.com

The API server (Mode 3) is the primary, complete, contract‑backed path. The other two
exist for the roughly ten percent of tasks the API can't do — pure‑UI actions, visual
verification, or working with **no API token at all** by riding a session you're already
logged into. All three are documented in depth in **[`docs/interface-map.md`](docs/interface-map.md)**.

| | **Mode 3 — API** | **Mode 2 — Web app** | **Mode 1 — Desktop app** |
|---|---|---|---|
| Transport | `api.monday.com/v2` GraphQL | Chrome (local) or Cloudflare Browser Run (remote), driven by DOM/CDP | Electron webview over CDP (`--remote-debugging-port`) |
| Needs an API token | **Yes** | No (rides your login) | No (rides your login) |
| Reads/writes any column type | ✅ (with shape translation) | ⚠️ item‑card / canvas‑limited | ⚠️ same |
| Address group / column | ✅ | group via DOM, column API‑only | same |
| Visual verification | ❌ | ✅ | ✅ |
| Works headless / on a server | ✅ | remote only | ❌ |
| Best for | all data CRUD | UI‑only actions, screenshots, no‑token | desktop‑specific, no‑token |

**Rule of thumb:** *data* → Mode 3; *pixels or UI‑only* → Mode 2 (local Chrome);
*desktop‑specific or no token on a workstation* → Mode 1; *headless with no local Chrome*
→ Mode 2 (Cloudflare Browser Run).

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

1. Open monday.com.
2. Click your avatar at the bottom left.
3. Choose **Developers**, then **My access tokens**, then **Show**.
4. Copy the token.

An admin may prefer the account token at **Administration > API**.

The token carries your own permissions. It sees the boards you see.

### Connect it

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

The write cycle archives the item that it makes, so it leaves no clutter.

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

In read-only mode only the eight read tools register, plus `monday_graphql`, which
stays but refuses any mutation. If a board allow list is set, `monday_graphql` is not
registered at all, because a raw document cannot honour the list — so read-only **and**
an allow list together leave just the eight read tools.

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
| `--boards 111,222` or `MONDAY_ALLOWED_BOARDS=111,222` | Every other board becomes invisible. `monday_graphql` is not registered at all, because a raw document cannot honour the list. |
| `mode: "delete"` | Needs `confirm: true`. The default mode archives instead, which a person can undo. |

The token never appears in a tool result or an error message. The client
redacts it before anything leaves the process.

### Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--token` | `MONDAY_API_TOKEN` | none, and the server refuses to start |
| `--token-file` | `MONDAY_API_TOKEN_FILE` | none |
| `--read-only` | `MONDAY_READ_ONLY` | off |
| `--boards` | `MONDAY_ALLOWED_BOARDS` | all boards |
| `--api-version` | `MONDAY_API_VERSION` | `2026-07` |
| `--api-url` | `MONDAY_API_URL` | `https://api.monday.com/v2` |
| | `MONDAY_TIMEOUT_MS` | `30000` |
| | `MONDAY_MAX_RETRIES` | `3` |

A flag always wins over the matching environment variable.

**About the API version.** monday.com retires an API version every quarter, and a
request that names a retired version quietly gets the maintenance version instead. That
makes a stale default worse than no default, so this server pins a current one and you can
override it. Check the
[versioning page](https://developer.monday.com/api-reference/docs/api-versioning)
when you upgrade.

### Rate limits

monday.com meters a complexity budget, not a request count. The client reads
the reset hint from the throttle response, whether it arrives in the
`retry-after` header or in the message body, and waits for that long. Other
transient failures use exponential backoff.

Retrying stops after about 45 seconds in total. A complexity window can be a
full minute, and waiting three of them outlasts every MCP client, so the
server reports the throttle and lets the caller decide to try again.

Board layouts stay in a cache for one minute, which keeps a run of writes off
the budget.

---

## Mode 1 — the desktop app over CDP (no API token)

The monday.com macOS desktop app is an Electron shell that hosts the web app in a
`<webview>`. It registers **no** custom URL scheme (there is no `monday://`), but its
Electron fuses leave remote debugging open — so you can attach a CDP client and drive the
**real, already‑logged‑in web app with no API token**. This was verified end‑to‑end:
launching with a debug port exposes a `webview` target already signed in, and a
zero‑dependency Node client can navigate it and read the item‑card DOM.

`scripts/cdp-desktop.mjs` is that client (uses Node's native `WebSocket`; Node ≥ 22, no
`npm install`). Claude‑in‑Chrome **cannot** attach here — it pairs with the Chrome
extension only — which is why a small CDP client is used instead.

```bash
# 1. Quit any running instance (single-instance lock ignores the flag otherwise)
osascript -e 'quit app "monday.com"'

# 2. Launch with the debug port (launch the binary directly; `open -a --args` is unreliable)
/Applications/monday.com.app/Contents/MacOS/monday.com --remote-debugging-port=9222 &

# 3. Drive it — no token, rides your session
node scripts/cdp-desktop.mjs targets                          # list debug targets
node scripts/cdp-desktop.mjs open <slug> <board_id> <item_id> # jump straight to an item card
node scripts/cdp-desktop.mjs nav  '<url>'                      # any deep link
node scripts/cdp-desktop.mjs eval '<js>'                       # read/drive the DOM
node scripts/cdp-desktop.mjs shot out.png                      # screenshot the webview
```

> ⚠️ **Security — read before using.** `--remote-debugging-port` opens an **unauthenticated**
> port on `localhost`. While it is open, *any* local process can read and drive your
> logged‑in monday.com session — no password required. Only run it when you want this, and
> **quit the app when done** (`osascript -e 'quit app "monday.com"'`) to close the port.
> Launching also restarts the app, losing any unsaved in‑app state.

Notes learned while building this: a cold `Page.navigate` to `/boards/<id>/pulses/<item_id>`
**does** open the item card (deep links only appear to "hang" under drivers that wait for
document‑idle; poll for an element instead); `Page.navigate` destroys the JS execution
context, so re‑evaluate after navigating. The board grid is a `<canvas>` (see Mode 2), so
individual cells aren't DOM‑selectable — reach a cell through the item card or the API.

---

## Mode 2 — the web app in a browser

For UI‑only actions, screenshots, or working with no token. Two sub‑modes share the URL
builder above.

**Local Chrome** (rides your existing login). Drive the DOM with a browser‑automation
tool. Two gotchas, both verified live and documented in
[`docs/interface-map.md`](docs/interface-map.md):

- **The board grid is a `<canvas>`.** Item names, cell values, and status pills are painted,
  not DOM — you cannot select a cell by selector on the current renderer. Reach a cell by
  opening the item card (real DOM), by coordinate click, or via the API. There is also a
  legacy DOM‑grid renderer still in the wild; detect which is active by checking whether a
  known item name appears in `document.body.innerText`.
- **Cold deep‑link navigation can stall** under idle‑waiting drivers; navigate to the account
  root and click through in‑app, or use raw CDP and poll for a target element.

App chrome, dialogs, menus, and the item card use monday's open‑source **Vibe** design
system, which puts a stable `data-vibe="…"` (component type) and `data-testid` on every
component root. Prefer `[data-vibe="Modal"]`, `role="dialog"`, `[data-testid="…"]`, and
`data-group-id` over hashed CSS‑module class names. Selector conventions are catalogued in
the interface map.

**Remote — Cloudflare Browser Run.** For headless/server contexts, connect
`playwright-core` / `puppeteer-core` over CDP to Browser Run (Chromium), persist login with
Playwright `storageState`, and do first login via the Human‑in‑the‑Loop Live View handoff.

> Cloudflare **KiteSurf** is CDP‑reachable but, per Cloudflare's own docs, **cannot hold an
> authenticated session** — so it is unsuitable for a logged‑in monday.com. Use Browser Run's
> default Chromium instead. All Cloudflare browsers egress from datacenter IPs flagged as bot
> traffic, so logins may be challenged.

---

## Security & privacy

- **Your token stays local.** The API server talks straight to `api.monday.com` over HTTPS.
  No relay, no telemetry. The token is redacted before anything leaves the process, and
  never appears in a tool result or error.
- **Never commit a token.** `.env`, `*.token`, and friends are gitignored; only
  `.env.example` (a placeholder) is tracked.
- **Read‑only and board‑allowlist** modes cap what the API server can touch (see
  [Safety](#safety)).
- **The desktop CDP debug port is unauthenticated** — see the boxed warning in
  [Mode 1](#mode-1--the-desktop-app-over-cdp-no-api-token). Treat it as a temporary,
  cons&#8288;ent‑gated handle and close it when done.
- **Same‑origin authenticated `fetch` from a browser mode is intentionally out of scope** —
  use the API for data.

---

## How this was mapped

The three‑mode design and every URL/DOM/API detail come from first‑hand investigation, not
guesswork, and each claim in [`docs/interface-map.md`](docs/interface-map.md) is tagged with
how it was verified: live in a logged‑in browser, by decompiling the desktop app bundle, from
official monday.com / Cloudflare docs, or from maintained third‑party integrations. The
document also lists, verbatim, everything that could **not** be resolved, so the boundaries of
what's known are explicit. Start there if you want to extend any mode.

---

## Develop

```bash
npm test          # tests, no network
npm run typecheck # source and tests
npm run build
npm run dev       # rebuild on save
```

The tests run the real MCP server against a fake monday.com API over an
in-memory transport. They assert the exact JSON that goes over the wire.
`test/regressions.test.ts` holds one test per defect found so far, named
after the behaviour that was wrong.

---

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md). To report a security problem, see
[SECURITY.md](SECURITY.md).

## Licence

MIT. See [LICENSE](LICENSE).
