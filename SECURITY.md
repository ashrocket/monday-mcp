# Security

## Report a problem

Do not open a public issue for a security problem. Use GitHub's private
report form instead:

<https://github.com/ashrocket/monday-mcp/security/advisories/new>

Expect an answer within seven days.

## What this server touches

The server holds a monday.com API token and sends it to `api.monday.com`
over HTTPS. It makes no other network call. It writes nothing to disk. It
sends no telemetry.

The token carries the permissions of the person who made it. A token from
**Administration > API** carries account-wide permissions, so prefer a
personal token from **Developers > My access tokens** unless you need more.

## How the token is protected

- The token is read from an environment variable, a command line flag, or a
  file. It never gets written anywhere.
- Every error message and every tool result passes through a redaction step
  before it leaves the process. Redaction runs before truncation, so a token
  cut in half by a length limit cannot survive in the output.
- `.env`, `*.token` and `.monday-token` are in `.gitignore`.

## Reducing what an agent can do

An MCP server gives a language model real permissions. Two flags narrow them:

```bash
# Read tools only. No write tool gets registered.
monday-mcp --read-only

# Two boards, and nothing else in the account is reachable.
monday-mcp --boards 1234567890,9876543210
```

With a board allow list in force, `monday_graphql` is not registered at all,
because a raw GraphQL document can name any board and so cannot honour the
list.

A permanent delete needs `confirm: true`. The default mode archives, which a
person can undo in the monday.com interface.

## Known limits

- The read-only guard inspects the GraphQL document for the `mutation`
  keyword. It handles comments and the comma that GraphQL treats as
  whitespace. It is a text check, not a parser. `--read-only` reduces the
  blast radius; it is not a security boundary against a determined caller
  who controls the document.
- A board allow list is enforced by this server, not by monday.com. Anyone
  who can run their own client with the same token can reach every board that
  token can see. Use a token with narrower permissions when that matters.
