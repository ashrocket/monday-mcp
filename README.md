# monday-mcp

A local [Model Context Protocol](https://modelcontextprotocol.io) server for
[monday.com](https://monday.com).

It runs on your machine and speaks straight to the monday.com GraphQL API.
Your token stays on your machine. No relay, no hosted middle layer, no
telemetry.

```
Claude, Cursor, or any MCP client
        |  stdio
   monday-mcp  (this server, on your machine)
        |  HTTPS
   api.monday.com
```

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
```

Three more things this server does:

- **Column titles work as keys.** Use `"Due date"` or `date_1`. Letter case,
  spaces, hyphens and underscores do not matter.
- **Status filters translate too.** A filter on `"Stuck"` becomes the numeric
  label index that the API needs.
- **Safety rails.** A read-only mode, a board allow list, and a permanent
  delete that needs explicit confirmation.

## Install

```bash
git clone https://github.com/ashrocket/monday-mcp.git
cd monday-mcp
npm install
npm run build
```

## Get an API token

1. Open monday.com.
2. Click your avatar at the bottom left.
3. Choose **Developers**, then **My access tokens**, then **Show**.
4. Copy the token.

An admin may prefer the account token at **Administration > API**.

The token carries your own permissions. It sees the boards you see.

## Connect it

### Claude Code

```bash
claude mcp add monday --env MONDAY_API_TOKEN=your-token -- node /full/path/to/monday-mcp/dist/index.js
```

### Claude Desktop, Cursor, and other clients

Add this to the MCP server configuration file:

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

## Prove it works

```bash
cp .env.example .env      # then put your token in .env
npm run smoke             # read-only checks against your account
npm run smoke -- --write  # adds a create, update, comment and archive cycle
```

The write cycle archives the item that it makes, so it leaves no clutter.

## Tools

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

A read-only server registers the read tools only. The model never sees a
tool that it cannot use.

## Column values

Pass `values` keyed by column id or column title. Use the plain form below.
An object value passes through untouched, so you keep control when you need
the exact API shape.

| Column type | Send this | Server sends this |
| --- | --- | --- |
| `text` | `"some text"` | `"some text"` |
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
| `phone` | `"+15551234567"` | `{"phone": "...", "countryShortName": "US"}` |
| `tags` | `[1234]` | `{"tag_ids": [1234]}` |
| `board_relation` | `[987654321]` | `{"item_ids": [987654321]}` |
| `hour` | `"14:30"` | `{"hour": 14, "minute": 30}` |
| `rating` | `4` | `{"rating": 4}` |
| `country` | `"US"` | `{"countryCode": "US", ...}` |
| `week` | `["2026-08-03", "2026-08-09"]` | `{"week": {"startDate": "...", "endDate": "..."}}` |
| `location` | `"10 Downing Street"` | `{"address": "10 Downing Street"}` |
| `world_clock` | `"Europe/London"` | `{"timezone": "Europe/London"}` |

Send `null` to clear a column.

A `formula`, `mirror`, `auto_number`, `creation_log`, `last_updated`,
`item_id`, `progress`, `vote` or `time_tracking` column is not writable.
monday.com computes it. The server says so instead of failing at the API.

A `file` or `doc` column needs the separate upload endpoint, which this
server does not expose.

## Safety

| Setting | Effect |
| --- | --- |
| `--read-only` or `MONDAY_READ_ONLY=1` | Only read tools get registered. A raw mutation is refused. |
| `--boards 111,222` or `MONDAY_ALLOWED_BOARDS=111,222` | Every other board becomes invisible. Raw GraphQL is refused, because it cannot honour the list. |
| `mode: "delete"` | Needs `confirm: true`. The default mode archives instead, which a person can undo. |

The token never appears in a tool result or an error message. The client
redacts it before anything leaves the process.

## Options

| Flag | Environment variable | Default |
| --- | --- | --- |
| `--token` | `MONDAY_API_TOKEN` | none, and the server refuses to start |
| `--token-file` | `MONDAY_API_TOKEN_FILE` | none |
| `--read-only` | `MONDAY_READ_ONLY` | off |
| `--boards` | `MONDAY_ALLOWED_BOARDS` | all boards |
| `--api-version` | `MONDAY_API_VERSION` | `2024-10` |
| `--api-url` | `MONDAY_API_URL` | `https://api.monday.com/v2` |
| | `MONDAY_TIMEOUT_MS` | `30000` |
| | `MONDAY_MAX_RETRIES` | `3` |

A flag always wins over the matching environment variable.

## Rate limits

monday.com meters a complexity budget, not a request count. The client reads
the reset hint out of a throttle message and waits for that long. Other
transient failures use exponential backoff. Board layouts stay in a cache for
one minute, which keeps a run of writes off the budget.

## Develop

```bash
npm test          # 79 tests, no network
npm run typecheck
npm run build
npm run dev       # rebuild on save
```

The tests run the real MCP server against a fake monday.com API over an
in-memory transport. They assert the exact JSON that goes over the wire.

## Licence

MIT. See [LICENSE](LICENSE).

This project is not built by monday.com and it carries no endorsement from
monday.com. "monday.com" belongs to monday.com Ltd.
