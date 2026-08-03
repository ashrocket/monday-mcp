# Contributing

Thank you for looking. Small, focused pull requests are the easiest to
review.

## Set up

```bash
git clone https://github.com/ashrocket/monday-mcp.git
cd monday-mcp
npm install
npm test
```

The tests need no network and no monday.com token.

## Before you open a pull request

```bash
npm run typecheck   # source and tests
npm test
npm run build
```

CI runs the same three commands on Node 20, 22 and 24, and on Linux, macOS
and Windows.

## How the tests work

`test/fake-monday.ts` stands in for the monday.com API. It answers the
GraphQL documents this server sends and records every request, so a test can
assert the exact JSON that went over the wire. The server runs for real, over
an in-memory MCP transport, so a test exercises the same path a client does.

`test/regressions.test.ts` holds one test per defect found so far. Each test
is named after the behaviour that was wrong, so a failure reads as a plain
sentence. Add to this file when you fix a bug.

## Checking against the real API

The single largest source of bugs here is a wrong assumption about the
monday.com API. Please check the reference page for anything you change:

- <https://developer.monday.com/api-reference/reference/items>
- <https://developer.monday.com/api-reference/reference/columns>
- One page per column type, for example
  <https://developer.monday.com/api-reference/reference/status>

Two traps that have already caught this project:

- `change_simple_column_value` takes `value: String!`, not `JSON!`.
- `compare_value` in a query rule is always an array, the text operators
  included.

To try a change against your own account:

```bash
cp .env.example .env      # add your token
npm run build
npm run smoke             # read-only
npm run smoke -- --write  # creates and then archives one item
```

## Adding a column type

`src/columns.ts` holds the translation. To add a type:

1. Add a `case` to `formatColumnValue`, and cite the reference page in a
   comment when the shape is surprising.
2. Add an entry to `writeExample` in `src/tools/boards.ts`, so
   `monday_get_board` shows a model what to send.
3. Add a test to `test/columns.test.ts`.
4. Add a row to the column table in `README.md`.

## Style

- Match the surrounding code. There is no linter to argue with.
- Write an error message that names the fix, not just the failure. Compare
  "invalid status" against `has no status "Shipped". It accepts: ...`.
- Keep comments for the surprising parts. The obvious parts need none.

## Licence

By contributing you agree that your work ships under the MIT licence in
[LICENSE](LICENSE).
