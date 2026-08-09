# monday.com Interface Map & Three‑Mode Execution Design

> Goal: let the MCP **talk directly to a specified location** in monday.com — a board,
> view, item, update, group, or column — **without any discovery round‑trips**, by
> resolving a single address into the right transport.
>
> Status of evidence is tagged throughout: **[LIVE]** = verified first‑hand in a
> logged‑in browser against `<slug>.monday.com` on 2026‑08‑08; **[DECOMPILED]** =
> read from the desktop app bundle; **[DOC]** = monday/Cloudflare official docs;
> **[3P]** = maintained third‑party integrations (reverse‑engineered, no contract);
> **[UNRESOLVED]** = could not confirm, listed explicitly in §9.

---

## 0. TL;DR / decisions

1. **There are three transports, not three equals.** The **API (Mode 3)** is the only
   one that is complete, stable, and contract‑backed. The two browser transports exist
   for the ~10% of actions the API can't do (pure‑UI operations, visual verification,
   things gated behind the app) and for when no token is available.

2. **The hard ceiling on the user's stated goal:** only **board / view / item / update**
   (plus `?asset_id=` / `?doc_id=&blockId=`) are **URL‑addressable**. **Groups and columns
   are NOT addressable by URL at all** — there is no `group_id` anchor and no `column_id`
   anchor in any monday URL. This is the solid, sourced claim and it bounds everything below.
   A weaker, separate claim — that group/column ids are obtainable *only* via the API — does
   **not** fully hold: the board DOM carries **`data-group-id`** on group headers [LIVE], so
   **group** ids are harvestable in a browser (see §3.3). **Column** ids still appear to be
   API‑only (zero `data-column-id` in every live probe). So: for column granularity in a
   browser mode, resolve through **Mode 3** first; for group granularity, the DOM may suffice.

3. **KiteSurf is real but disqualified for this use case.** Cloudflare KiteSurf (launched
   6–7 Aug 2026) is CDP‑reachable but **cannot hold an authenticated session** by
   Cloudflare's own docs. The remote‑browser path is therefore Cloudflare **Browser Run
   (Chromium)** with `storageState` re‑injection + Human‑in‑the‑Loop login — not KiteSurf.
   The local browser path is **Claude‑in‑Chrome**, riding the user's existing session.

4. **The modern board grid is a `<canvas>` [LIVE].** Item rows, cells, names, and status
   pills are painted, not DOM. DOM automation can address the **board** and open the
   **item card** (real DOM), but cannot select individual grid cells. This kills the
   "read/write any cell via selectors" assumption for the newest board renderer.

5. **The desktop app has no deep‑link scheme [DECOMPILED].** No `monday://`. It is an
   Electron shell around a `<webview>`; the only external control handle is launching it
   with `--remote-debugging-port` (Electron fuses permit it) and driving the webview over
   CDP — a **user‑run probe**, because that port exposes the logged‑in session on localhost.

---

## 1. The unified locator schema (the thing all three modes consume)

Every mode is a function of one address object. This is the contract that makes
"no discovery spend" possible: resolve once, dispatch anywhere.

```ts
interface MondayLocator {
  account_slug: string;   // "<slug>" -> https://<slug>.monday.com   (REQUIRED for URL modes)
  board_id?: string;      // "<board_id>"
  view_id?: string;       // board view (tab)
  item_id?: string;       // a.k.a. pulse id
  update_id?: string;     // an update/post on an item
  reply_id?: string;      // [UNRESOLVED] whether replies have their own anchor
  asset_id?: string;      // file on an item (opens file viewer over the item)
  doc_id?: string;        // workdoc, or a doc column on an item
  block_id?: string;      // a block inside a doc
  workspace_id?: string;
  dashboard_id?: string;  // "overview" id  [LIKELY /overviews/<id>]
  // NOT URL-addressable. group_id also harvestable from board DOM (data-group-id, strip
  // "<board_id>_" prefix) [LIVE, unverified vs API]. column_id appears API-only.
  group_id?: string;      // e.g. "topics", "new_group"; API, or DOM data-group-id
  column_id?: string;     // e.g. "status", "date4"; from the API (no data-column-id seen)
}
```

**URL builder (Mode 2, and the desktop webview target for Mode 1):**

| Target | URL (all under `https://<slug>.monday.com`) | Evidence |
|---|---|---|
| Board | `/boards/<board_id>` | [LIVE] |
| Board view (tab) | `/boards/<board_id>/views/<view_id>` | [DOC] |
| Item (pulse) — opens card overlay on the board | `/boards/<board_id>/pulses/<item_id>` | **[LIVE]** confirmed: clicking the item's conversation icon set exactly this URL |
| Update on an item | `/boards/<board_id>/pulses/<item_id>/posts/<update_id>` | [DOC] |
| File/asset over an item | `/boards/<board_id>/pulses/<item_id>?asset_id=<asset_id>` | [DOC] |
| Doc column over an item | `/boards/<board_id>/pulses/<item_id>?doc_id=<doc_id>&blockId=<uuid>` | [DOC] |
| Standalone workdoc | `/docs/<doc_id>` | [DOC] |
| Workspace | `/workspaces/<workspace_id>` | [DOC] |
| Dashboard | `/overviews/<dashboard_id>` | [LIKELY] — API param is `overview_id`; path segment not printed anywhere public |
| My Work | `/my_work` | [LIKELY] |
| Public board view (no login) | `https://view.monday.com/<hash>` (add `/embed/` for embeddable) | [DOC] — **different host** |
| Public form | `https://forms.monday.com/forms/<token>` | [LIKELY] |
| Central login | `monday.com/login` → `auth.monday.com/login` → `auth.monday.com/auth/login_monday` | [DOC] |
| Account login wall | `<slug>.monday.com/users/sign_in` → `/auth/login_monday/email_password` | [DOC] |

**Behavioral facts that matter for automation:**
- Visiting a `/pulses/<item_id>` URL opens the board with the **item card as an overlay** — it is *not* a standalone page, and **the board does not scroll to the item** [DOC]. So "navigate to item" ≠ "item is visible in grid."
- **Logged out, every path 302s to `/users/sign_in`** and sets a `go_back_to=<path>` cookie (Max‑Age 600) [DOC]. Deep links survive the auth wall, but **the auth wall fires before route validation**, so you cannot probe whether a route/board exists while unauthenticated.
- A wrong/nonexistent slug 302s to `monday.com/slug_not_found`; a slug‑less `monday.com/boards/<id>` is 404 — **the account subdomain is mandatory** [DOC].

---

## 2. Mode 3 — Direct API (`api.monday.com/v2`, GraphQL) — the primary path

This is what the existing server already speaks (see `src/client.ts`, `src/tools/*`). It is
the only mode that needs **zero discovery** for the full CRUD surface and is the only one
that can address **groups and columns**. Pin an API version (`--api-version`, default
`2026-07`); a stale version is silently downgraded [DOC].

### 2.1 Reads by known id (cheapest first)

```graphql
# Single column of a single item — the minimal read. items(ids:) is ROOT-ONLY.
query { items(ids: <ITEM_ID>) { column_values(ids: ["<COLUMN_ID>"]) { id type text value } } }

# Typed parse without decoding raw JSON:
query { items(ids: <ID>) { column_values(ids: ["status"]) { ... on StatusValue { label update_id } } } }
```

- `items(ids:)` takes **max 100 ids**; `limit` defaults to **25**, so to pass >25 ids you
  must also set `limit: 100` [DOC]. `exclude_nonactive: true` skips deleted/archived ids
  when replaying stored ids.
- `column_values(ids: [...])` returns only the columns you ask for.
- **Bulk / paged reads:** `boards(ids:){ items_page(limit:≤500, query_params:{...}) { cursor items {...} } }`,
  then **root‑level** `next_items_page(cursor:, limit:)` to avoid the nesting complexity
  multiplier. **Cursors expire 60 minutes** after the initial request; `query_params` and
  `cursor` are **mutually exclusive** [DOC].
- **Exact‑value lookup without discovery:** `items_page_by_column_values(board_id:, columns:[{column_id, column_values:[...]}])`
  (root‑only; supports Text/Status/Checkbox/Date/Dropdown/Email/Numbers/People/Phone/Timeline/etc.;
  **not** Formula/Mirror/File/Location/Tags/Rating) [DOC].

### 2.2 Writes by known id

```graphql
# Multiple columns at once (preferred; column_values is a JSON-encoded STRING):
mutation { change_multiple_column_values(item_id: <ID>, board_id: <BID>,
  column_values: "{\"status\":{\"index\":1},\"date4\":{\"date\":\"2026-08-14\"}}") { id } }

# Single cell, lightest payload for status/text:
mutation { change_simple_column_value(board_id: <BID>, item_id: <ID>, column_id: "status", value: "Done") { id } }

# Create directly into a group (no lookup needed):
mutation { create_item(board_id: <BID>, group_id: "topics", item_name: "New", column_values: "{...}") { id } }

# Move directly (group_id only; no board_id needed):
mutation { move_item_to_group(item_id: <ID>, group_id: "topics") { id } }
```

The existing server's whole value‑add is translating plain values → these JSON shapes
(see `src/columns.ts`, README "Column values" table). Keep that; Modes 1–2 should reuse it.

### 2.3 Complexity & limits [DOC]
- Single query capped at **5,000,000** complexity. Per‑minute budget **10M** (paid personal
  token), **1M** (trial/free), **5M read + 5M write** (app tokens).
- **Reads by id are cheap** (hundreds of points). **Item mutations are expensive and flat** —
  official app docs say **~10,000/create_item** (~160/min); community measurements report
  **~30,001**. **[UNRESOLVED]** without a live token; introspect per‑call cost with
  `query { complexity { before query after reset_in_x_seconds } }`.
- Daily call limits 1k–25k by plan; 5,000 req/10s per IP; 429s carry `retry_in_seconds`.
  The server already reads throttle hints and backs off (`src/client.ts`).

### 2.4 Things the API needs a different endpoint / handshake for
- **Files:** multipart to `https://api.monday.com/v2/file` (max 500 MB); `add_file_to_column(item_id:, column_id:"files", file:$file)` **appends** (does not replace); `add_file_to_update(update_id:, file:)`. The current server deliberately does **not** expose this (README).
- **Webhooks:** `create_webhook(board_id:, url:, event:, config:)` with a challenge‑echo handshake (monday POSTs `{challenge}`, you echo it). Events include `change_column_value`, `change_status_column_value`, `create_item`, `item_moved_to_specific_group` (`config {groupId}`), update/subitem variants; failed deliveries retry 1/min for 30 min.
- **Emails & Activities timeline** (CRM‑gated) and **audit_logs** (Enterprise‑admin‑gated) are out of scope for general addressing.

---

## 3. Mode 2 — the web app

Two sub‑modes share the URL builder of §1 but differ in **where the browser runs** and
**whose session it uses**.

### 3.0 The single most important web finding: the board grid is a canvas [LIVE]

On the current renderer (micro‑frontend **`mf-table`**, wrapper `_boardCanvasWrapper`,
element `_stickyCanvas`, 2280×984 on this display):

- `document.body.innerText` **contained** the group‑header names and column‑header names
  but **did NOT contain** any item name or status‑label text. There is exactly **one
  `<canvas>`** and the cells live on it.
- **Implication:** you **cannot** target a cell / row / status pill with a DOM selector on
  this board. Cell‑level interaction options are: (a) **coordinate** clicks (computer‑use /
  Playwright mouse at x,y — clicking a name cell promotes it to a real `<input>`, so text
  then appears in the DOM), (b) **open the item card** (real DOM — see §3.3), or (c) the
  **API** (Mode 3).
- **Two board‑renderer generations exist and you must detect which is active:**
  - **Canvas grid (new)** — confirmed live here; `document.querySelector('#mf-board ._boardCanvasWrapper canvas')` exists; cell text absent from DOM.
  - **Legacy DOM grid (old)** — still targeted by maintained extensions (TMetric, Clockify) via `.pulse-component`, `id="row-pulse-<boardId>-<itemId>"`, `.board-cell-component`, `.name-cell-text`, `col-identifier-<columnId>`, `.status-cell-inner` [3P]. If those nodes exist, the account/board is on the DOM renderer.
  - **Detection rule (renderer‑agnostic — test the symptom, not a class name):** take one known item name (from the API, or from the captured `board_data`) and check `document.body.innerText.includes(name)`. **Present ⇒ DOM grid** (cells are selectable — use `col-identifier-*` + `row-pulse-*`); **absent ⇒ canvas grid** (cells not in DOM — coordinate‑click or Mode 3). This was the actual live symptom (item names and status labels were absent from `innerText`). The `._boardCanvasWrapper` / `_stickyCanvas` canvas is **corroborating** evidence, not the test: its class semantics were not independently verified, and the sampled canvas was 1140×492 CSS — narrower than the visible grid — so it may be only a sticky/frozen‑region painter that could exist on either generation. Do not key detection on it.

### 3.1 Cold deep‑link navigation: hangs under the CIC harness, WORKS under raw CDP [LIVE]

**Correction (verified 2026‑08‑08 via desktop CDP):** cold navigation to a deep link is
**not** a routing failure — it only *appears* to hang because the Claude‑in‑Chrome harness
waits for **document‑idle**, which the always‑busy SPA never signals. A driver that instead
**polls for a target element** navigates deep links fine:
- Raw CDP `Page.navigate` to `/boards/<id>` **and** to `/boards/<id>/pulses/<item_id>` both
  succeeded in the desktop webview; the pulse URL **opened the item card overlay** on cold
  load (no in‑app click, no coordinates), and its real DOM read back (`new-post-update-*`,
  3× `post-component`). So **id‑based item addressing works** if your driver polls for the
  card element rather than network‑idle.

**Under the Claude‑in‑Chrome MCP specifically**, a **direct** `navigate` to `/boards/<id>`
**never reaches document‑idle** — `get_page_text` times out (45s), screenshots time out (5s),
every time. There, use the **in‑app recipe**:

1. `navigate` to `https://<slug>.monday.com/` (the root **does** idle).
2. `find` the target board link (it carries `href="/boards/<id>"`) and **click** it — client‑side
   routing keeps the already‑idle document, and from there `find` / clicks / screenshots / JS
   all work.
3. To reach an **item**, once on the board click its conversation/expand icon; the URL becomes
   `/pulses/<item_id>` and the card opens. (In‑app clicks drive the SPA router; typing a
   `/pulses/...` URL cold does not.)

Also note: **same‑origin authenticated `fetch(..., {credentials:'include'})` is blocked by the
harness** (`[BLOCKED: Cookie/query string data]`) — so you cannot shortcut to the private
board endpoints from page JS. Use Mode 3 for data.

### 3.2 What the web app actually calls (observed, private, do not build on) [LIVE]

The SPA does **not** use `api.monday.com/v2` to render a board. It uses undocumented,
cookie‑authed internal endpoints — captured live:
`GET /boards/<id>/board_data?...&pulse_ids_only=true`, `GET /boards/<id>/board_init`,
`POST /board-app/boards/<id>/items`, `GET /boards/<id>/board_data_extended`,
`GET /boards/<id>/relations/metadata`, `GET /board-app/boards/<id>/preferences`,
`POST /boards/<id>/get_overview_section_by_type`, plus **Pusher** websockets
(`/pusher/auth-batch`) for realtime, and a micro‑frontend fleet
(`mf-board`, `mf-table`, `mf-header`, `mf-objects`, `mf-leftpane`, `mf-topbar`) loaded from
`microfrontends.monday.com`. These have no contract and the harness blocks credentialed
fetch anyway — documented only so nobody mistakes them for a supported API.

### 3.3 DOM selector reference (for the parts that *are* DOM)

monday's UI is two layers: **Vibe** (open‑source `@vibe/core`) for chrome widgets, and
**proprietary app code** for the board.

**Vibe convention [3P, source‑verified]:** every Vibe component root emits two attributes:
- `data-testid` — value from `getTestId(elementType, id)` = `elementType` or `elementType_id`
  (underscore‑joined); **overridable** by a caller‑passed `data-testid`.
- `data-vibe` — the component *type* (PascalCase, e.g. `"Button"`, `"Modal"`, `"Menu"`);
  **NOT overridable**, mandated on every component — the most robust Vibe hook.

**Selector priority ladder:**
1. `[data-vibe="Button|Modal|Menu|Dropdown|Search|TextField|Checkbox|DatePicker|…"]` (framework‑guaranteed, type‑level) + visible text/`aria-label` to disambiguate.
2. ARIA role + accessible name: `role="dialog"` (modals/cards), `role="menuitem"`, `getByRole("option",{name})` (dropdown options), `role="grid"` (board container) — the pattern Vibe's own testkit uses.
3. Vibe default `data-testid` strings (e.g. `modal-close-button`, `clean-search-button`, `menu-item_<index>`) — good but app may override.
4. **Legacy board classes** (DOM‑grid boards only): `.pulse-component`, `id^="row-pulse-"`, `.board-cell-component`, `col-identifier-<realColumnId>`, `.status-cell-inner`, `.group-header-component`.
5. **Never:** CSS‑module hash fragments (`chips-list-module_chips__CTQcD`, `_Icon_1xian_55`, `styles-module__x___PHPe6`) — regenerated every build — or positional/index chains.

**Live‑observed stable hooks on this account [LIVE]:** app chrome mounts into same‑document
divs by id — `#mf-board`, `#mf-topbar`, `#mf-leftpane`, `#mf-header` (not iframes). Stable
`data-testid`s seen: `topbar-search-everything-button`, `topbar-notifications-button`,
`left_pane_home_button`, `left_pane_my_work_button`, `board-info-container`, `object-name`
(board title), `virtualized-list`, `pinned-tabs-group`, `regular-tabs-group`. Group headers
carry **`data-group-id`** — observed value `<board_id>_topics` on the first group header,
i.e. shaped `<board_id>_<group_id>`. Stripping the `<board_id>_` prefix
appears to yield the API's `group_id` (`topics` is monday's default first‑group id), which
would make **group ids DOM‑harvestable without a token** — **[UNVERIFIED]** against a
`boards{groups{id}}` response (no token this session); confirm before relying on it. Status
pill inner wrapper class is a plain `status-wrapper` (not hashed).

**Item card = the real‑DOM write surface [LIVE].** Opening `/pulses/<id>` renders a right‑side
panel (`role="dialog"`) with tabs **Updates / Files / Item Card / <custom views>** and stable
testids: `new-post-update-placeholder`, `new-post-update-MfExternalComponent`,
`post-header-container`, `reply-button`, `new-reply-component`, `editable-heading`,
`editable-text`, plus a `contenteditable` composer. So **posting an update/reply and editing
the item name are DOM‑drivable**; the Files tab embeds a cross‑origin `onedrive.monday.com`
iframe; the "Item Card" tab is a **configurable widget board** and may be empty (it was here).
Column‑value editors appear in the card's details/widget layout, not guaranteed present.

**Anti‑automation [3P, probe‑verified]:** the choke point is **login**, not the board. The
auth host injects Cloudflare **JSD** (`/cdn-cgi/challenge-platform/scripts/jsd/main.js`) —
browser fingerprinting feeding Bot Management; headless logins are risk‑scored and can be
challenged. No CAPTCHA/PerimeterX/DataDome seen in the login HTML. The board DOM itself is
freely scriptable **once authenticated**. Login form has clean ids: `#user_email`,
`#user_password`, `button[aria-label="Log in"]`.

### 3.4 Mode 2A — local Chrome via Claude‑in‑Chrome MCP (the working browser path)

- **Runs in the user's own Chrome, on the user's existing monday session** → sidesteps the
  Cloudflare login challenge entirely (no fresh headless login).
- Tooling: `mcp__claude-in-chrome__*` — `navigate`, `find` (NL element search), `computer`
  (coordinate clicks/screenshots — needed for the canvas grid), `javascript_tool` (DOM read
  + selector detection), `read_network_requests`, `read_page` (a11y tree).
- **Playbook per locator:**
  1. `navigate` account root → `find` board link → click (never cold‑navigate a deep link).
  2. Board‑level ops (search, filter, sort, view switch, group collapse): DOM via Vibe hooks / `data-group-id`.
  3. Item ops: click conversation icon → card overlay (`/pulses/<id>`) → drive Updates/Files/name via testids in §3.3.
  4. Cell read/write on the grid: **detect renderer (§3.0)**; canvas ⇒ coordinate click or fall back to Mode 3; legacy DOM ⇒ `col-identifier-*` cell.
- **Constraint:** the CIC extension needs the tab in a real Chrome the user has connected; two
  browsers were connected this session, so the caller must select one (this session used
  "Browser 1").

### 3.5 Mode 2B — remote Cloudflare Browser Run (Chromium) + storageState + HITL

For headless/server contexts with no local Chrome. **[DOC]**

- **KiteSurf is disqualified:** CDP‑reachable via `?browser=kitesurf` on the Browser Run wss
  endpoint, but "not yet the right option" for long‑running authenticated sessions (per‑page
  cookie jar, every load fresh). Use it only for stateless public scrapes.
- **Use Browser Run's default Chromium.** Connect a local Node process over CDP:

  ```js
  import { chromium } from "playwright-core";
  const browser = await chromium.connectOverCDP(
    "wss://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-rendering/devtools/browser?keep_alive=600000",
    { headers: { Authorization: `Bearer ${CF_API_TOKEN}` } } // token needs "Browser Rendering - Edit"
  );
  const ctx = browser.contexts()[0];
  ```
  (Puppeteer equivalent: `puppeteer.connect({ browserWSEndpoint, headers })`. The `/browser-run/`
  and legacy `/browser-rendering/` paths both currently work.)
- **Session limits:** idle timeout 60s default, `keep_alive` max **10 minutes**; **no
  cross‑session profile**. So persist login with Playwright **`storageState`** (cookies +
  localStorage + IndexedDB) and re‑inject each session (Cloudflare's documented KV pattern),
  or pin a browser in a Durable Object.
- **First login (the Google‑SSO / password problem):** use **Human‑in‑the‑Loop** — the script
  issues `Cloudflare.getLiveView` → surfaces a `live.browser.run` URL → the user logs in
  manually → `Cloudflare.handoffComplete` fires → save `storageState`. Caveats: **all Browser
  Run traffic egresses Cloudflare datacenter IPs and is flagged as bot traffic**; Google is
  known to refuse sign‑in in CDP‑attached headless Chrome, so **email+password monday login is
  the likelier‑to‑succeed path** than Google SSO, and monday's own IP/bot policy is unverified
  **[UNRESOLVED]**.
- **`@cloudflare/playwright-mcp`** exists (Worker + Durable Object, ~23 `browser_*` tools) but
  ships **no auth and no cross‑session state** — you'd fork it to add `storageState` + endpoint
  auth. The raw‑CDP‑plus‑your‑own‑storageState approach is the better fit.
- **Pricing:** Free 10 browser‑min/day, 3 concurrent; Paid 10 browser‑hours/mo then
  $0.09/hr, 10 concurrent then $2.00/browser.

---

## 4. Mode 1 — the native desktop app (macOS Electron) [DECOMPILED]

Decompiled from `/Applications/monday.com.app/Contents/Resources/app.asar` (app v1.0.45).

- **It is a thin Electron shell around a `<webview>`.** `main.js` loads a local `index.html`;
  the shell's React bundle resolves the webview URL as
  `window.electron.webviewUrl || localStorage["last_slug_visited"]` → `https://<slug>.monday.com/...`,
  login at `https://auth.monday.com/login`. Persists `last_slug_visited` / `last_monday_url_visited`.
  It authenticates via the **same web session** (cookies in the shell's Electron session), sets
  `Desktop-App-Version` / `Desktop-App-Platform` request headers, and opens external links via
  `shell.openExternal` restricted to an allow‑list (`http(s)`, `mailto`, `tel`, `slack:`, …).
- **No custom URL scheme.** `setAsDefaultProtocolClient` / protocol registration appear
  **nowhere** in the bundle — there is **no `monday://` deep link** and no CLI flag that injects
  a target URL into the production app. You cannot address the desktop app from outside; you
  must drive navigation **inside** the webview.
- **The automation handle: remote debugging — VERIFIED WORKING [LIVE 2026‑08‑08].** `npx
  @electron/fuses read` shows `RunAsNode`, `EnableNodeCliInspectArguments`,
  `EnableNodeOptionsEnvironmentVariable` **ENABLED** and `OnlyLoadAppFromAsar` /
  `EnableEmbeddedAsarIntegrityValidation` **DISABLED**. The full route was executed end‑to‑end:
  launching the binary directly with `--remote-debugging-port=9222` opened a CDP endpoint;
  `GET /json` listed a `type:"webview"` target at `https://<slug>.monday.com/` **already
  logged in** (no API key); attaching over the target's `webSocketDebuggerUrl` with a
  **zero‑dependency Node client** (Node's native `WebSocket`) allowed `Runtime.evaluate`,
  `Page.navigate`, `Page.captureScreenshot`, and `Input.dispatchMouseEvent`. Navigating to a
  board and cold‑navigating to `/pulses/<item_id>` both worked; the item card's real DOM
  (update composer, existing posts) read back. Notes learned live: **quit the running app
  first** (single‑instance lock ignores the flag otherwise); `open -a --args` is unreliable —
  **launch the binary directly**; `Page.navigate` destroys the JS execution context, so
  re‑evaluate after navigation (don't hold a stale context); coordinate `Input` clicks on the
  canvas grid are fragile (a cold `/pulses/` navigate is the robust way to reach an item).

  ```bash
  # USER-RUN PROBE (quits the running app first; opens an UNAUTHENTICATED CDP port on
  # localhost that exposes the logged-in monday session — run only when you accept that).
  osascript -e 'quit app "monday.com"'
  open -a "monday.com" --args --remote-debugging-port=9222
  # then, from an automation process:
  #   GET http://localhost:9222/json           -> list targets; pick the webview whose url is <slug>.monday.com
  #   attach Playwright/Puppeteer over that ws endpoint (connectOverCDP)
  #   in the webview target: location.href = "https://<slug>.monday.com/boards/<id>/pulses/<item_id>"
  ```

  Everything in §3 (canvas grid, in‑app‑navigation requirement, item‑card DOM, Vibe selectors)
  applies identically inside the webview, because it **is** the web app.
- **Why this is a user‑run probe, not a default:** it kills the user's running instance (possible
  unsaved state) and the debug port is unauthenticated. Do not relaunch a user's app without
  explicit in‑chat consent.
- **When Mode 1 is worth it over Mode 2A:** only when the task specifically needs the *desktop*
  app (desktop notifications, native window behavior, an OS‑integration under test). For plain
  "drive the web UI," Mode 2A (local Chrome) is strictly simpler.

---

## 5. Routing logic — given a `MondayLocator` + an operation, pick a mode

| Operation | Preferred | Fallback | Never |
|---|---|---|---|
| Read a cell / item / column value | **Mode 3** (`items(ids:){column_values(ids:)}`) | 2A open item card | 2B for a single read (cost/latency) |
| Write a cell / status / date | **Mode 3** (`change_*`) | 2A card (if API lacks the column type) | canvas coordinate typing if avoidable |
| Create / move / delete item | **Mode 3** | 2A UI | — |
| Post an update / reply | **Mode 3** (`create_update`) or 2A card (`new-post-update-*`) | — | — |
| Resolve a `column_id` | **Mode 3** (`boards{columns{id}}`) — only reliable source | — | any URL parse (impossible) |
| Resolve a `group_id` | **Mode 3** (`boards{groups{id}}`) | 2A board DOM `data-group-id` (strip `<board_id>_`) [unverified] | any URL parse (impossible) |
| Navigate a human to a location | **Mode 2** URL (§1) | Mode 1 webview | — |
| Visual verification / screenshot | **Mode 2A** | Mode 1 / 2B | Mode 3 (no pixels) |
| Pure‑UI action the API can't do (e.g. switch a view, run a board automation button) | **Mode 2A** | Mode 1 | — |
| Bulk export the UI produces (Excel w/ updates+subitems) | **Mode 2A** UI export | — | Mode 3 (different shape) |

**Rule of thumb:** *data* → Mode 3; *pixels or UI‑only* → Mode 2A; *desktop‑specific* → Mode 1;
*headless/no‑local‑Chrome* → Mode 2B. Groups/columns always resolve through Mode 3 before any
browser step that needs them.

---

## 6. Suggested MCP surface to expose these modes

Keep the existing API tools as Mode 3. Add a thin addressing + dispatch layer:

- `monday_resolve_location(locator) -> {url, api_targets}` — pure function: builds the §1 URL,
  and (given a token) fills `group_id`/`column_id` so browser modes have what URLs can't carry.
- `monday_open(locator, {mode: "auto"|"chrome"|"desktop"})` — navigates the chosen browser to the
  URL using the in‑app‑navigation recipe (§3.1); `auto` = chrome if a CIC browser is connected,
  else instructions for desktop/remote.
- `monday_ui_action(locator, action)` — the escape hatch for UI‑only ops (post update, switch
  view, export), with a **renderer‑detection** preflight (§3.0) so it fails loudly on canvas
  cells instead of clicking blind.
- Config additions: `account_slug` (needed for URL building — the token alone doesn't give it
  cheaply; `me{account{slug}}` does), and Cloudflare creds for Mode 2B.

---

## 7. What each mode can and cannot reach (capability matrix)

| Capability | Mode 3 API | Mode 2A local Chrome | Mode 2B Browser Run | Mode 1 desktop |
|---|---|---|---|---|
| Read/write any column type | ✅ (with shape translation) | ⚠️ card/canvas‑limited | ⚠️ same as 2A | ⚠️ same as 2A |
| Address group | ✅ | ⚠️ DOM `data-group-id` [unverified] | ⚠️ same | ⚠️ same |
| Address column | ✅ | ❌ (needs Mode 3) | ❌ | ❌ |
| Address board/view/item/update by URL | n/a | ✅ | ✅ | ✅ (webview) |
| Files upload | ✅ (`/v2/file`) | ✅ (UI) | ✅ (UI) | ✅ (UI) |
| Post updates/replies | ✅ | ✅ (card DOM) | ✅ | ✅ |
| Realtime subscribe | ✅ (webhooks) | observe Pusher only | observe only | observe only |
| Visual verification | ❌ | ✅ | ✅ | ✅ |
| Works with no API token | ❌ | ✅ (user session) | ⚠️ (needs login/HITL) | ✅ (user session) |
| Works headless / server | ✅ | ❌ | ✅ | ❌ |
| Auth challenge risk | none | none (rides session) | **high** (CF IP + JSD) | none |

---

## 8. Cloudflare integration quick reference [DOC]

- **Endpoint (external, from anywhere):** `wss://api.cloudflare.com/client/v4/accounts/<ACCOUNT_ID>/browser-rendering/devtools/browser?keep_alive=<ms>` — header `Authorization: Bearer <token>` (`Browser Rendering - Edit`). Add `?browser=kitesurf` to select KiteSurf (don't, for monday).
- **Packages:** `playwright-core` / `puppeteer-core` for external CDP; inside Workers `@cloudflare/playwright` (v1.3.x) / `@cloudflare/puppeteer` with a `browser` binding, `nodejs_compat`, `compatibility_date >= 2025-09-15`.
- **Session reuse:** `browser.disconnect()` (not `close()`), reconnect by `sessionId` (`acquire`/`connect`).
- **Quick Actions REST** (stateless, cookie/basic‑auth injectable): `POST /accounts/<ID>/browser-run/{screenshot,pdf,markdown,scrape,json,links}` — usable for monday reads if you already hold a valid session cookie.
- **HITL:** `Cloudflare.getLiveView` / `Cloudflare.handoff` / `Cloudflare.handoffComplete` / `Cloudflare.getHandoffState`; Live View at `live.browser.run`.

---

## 9. Unresolved / cannot‑resolve (carried forward verbatim, plus live resolutions)

**Resolved live this session:**
- ✅ Item/pulse deep‑link `/boards/<b>/pulses/<i>` — **confirmed live** (URL set on card open).
- ✅ Board grid renderer — **confirmed canvas** on this account; cells not in DOM.
- ✅ Web app does not use `/v2` GraphQL to render boards — **confirmed** (private endpoints observed).
- ✅ Desktop app has no URL scheme; fuses open — **confirmed by decompilation**.
- ✅ **Desktop CDP route works end‑to‑end without an API key** — **executed live**: launched
  with `--remote-debugging-port`, attached a zero‑dep Node client to the logged‑in webview,
  navigated to a board, cold‑navigated to a specific item (card opened), read its DOM.
- ✅ **Cold deep‑link navigation is not a real hang** — works under raw CDP (poll for an
  element, not idle); the CIC harness's idle‑wait is what times out.
- ✅ Session is live in Browser 1 — **confirmed** (Home + board loaded authenticated).

**Still unresolved:**

*URLs / web:*
- Exact dashboard path segment (`/overviews/<id>` strongly implied by API `overview_id`, not printed publicly).
- Whether `/my_work`, `/notifications`, a search‑results route are real navigable URLs (auth wall 302s every path when logged out; and the logged‑in SPA hangs on cold deep‑link navigation, so hard to probe).
- Direct URL of the Developer Center / API‑token page (candidates `<slug>.monday.com/apps/manage/tokens`) and admin subpages (`/admin/connections`) — only menu navigation is documented.
- Whether an update **reply** gets its own anchor (`reply_id`) beyond `/posts/<update_id>`.
- Whether a board URL with the *wrong* slug auto‑redirects to the correct slug for a logged‑in user (board ids are globally unique, so plausible).
- Whether `go_back_to` (Max‑Age 600) reliably returns the user to a deep link after SSO/2FA, not just email+password.
- Exact WorkForms public token shape on `forms.monday.com`.

*API:*
- No official per‑field complexity table; **`create_item` cost 10,000 (official) vs ~30,001 (community)** unconfirmed without a live token.
- Whether `column_values(ids:[...])` filtering reduces *complexity* or only payload.
- Cursor‑termination semantics (null on last page implied, not stated); whether `next_items_page` must re‑specify the field selection identically.

*Cloudflare / remote browser:*
- Whether Google SSO actually completes via Live View from Cloudflare datacenter IPs in a CDP‑attached browser (no public success/failure reports; email+password is the safer bet).
- Whether **monday.com specifically** challenges/blocks Cloudflare IP ranges (no public policy found).
- Whether the 10‑min `keep_alive` ceiling can be raised for Enterprise.
- Whether external `connectOverCDP` supports `newContext({storageState})` re‑injection or only the default context.
- `@cloudflare/playwright-mcp` auth posture (repo shows none; unclear if Cloudflare Access is recommended).
- Exact per‑account KiteSurf beta limits; whether KiteSurf will gain persistent‑session support; whether monday's SPA even renders under KiteSurf's Blitz/Stylo engine (no compatibility report covers monday.com).

*Board renderer:*
- Which accounts/boards are on the **legacy DOM grid** vs the **canvas grid**, and whether it's a per‑account rollout, a board setting, or A/B — only the runtime probe in §3.0 tells you. The `.pulse-component`/`col-identifier-*` selectors from third‑party extensions apply **only** to DOM‑grid boards.

---

## 10. Cross‑references
- Existing server & column‑shape translation: `src/client.ts`, `src/columns.ts`, `README.md`.
- Prior browser‑access constraints (in‑app‑nav requirement, blocked credentialed fetch, UI export path): project memory `monday-board-access-constraints`.
- Live verification (2026‑08‑08) was done against a real logged‑in account and board;
  the specific account slug, board id, and item id are omitted here on purpose.
