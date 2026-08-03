/**
 * A stand-in for the monday.com API.
 *
 * It answers the documents this server sends and records every request, so
 * a test can assert the exact column_values JSON that went over the wire.
 */

export interface RecordedCall {
  operation: string;
  query: string;
  variables: Record<string, unknown>;
}

const BOARD = {
  id: "111",
  name: "Roadmap",
  description: "Work in flight",
  state: "active",
  board_kind: "public",
  items_count: 2,
  workspace: { id: "9", name: "Product" },
  groups: [
    { id: "topics", title: "This month", color: "#037f4c", position: "1" },
    { id: "group_two", title: "Later", color: "#579bfc", position: "2" },
  ],
  columns: [
    {
      id: "status",
      title: "Status",
      type: "status",
      settings_str: JSON.stringify({
        labels: { "0": "Working on it", "1": "Done", "5": "Stuck" },
      }),
    },
    { id: "text_1", title: "Notes", type: "text", settings_str: null },
    { id: "date_1", title: "Due date", type: "date", settings_str: null },
    { id: "formula_1", title: "Score", type: "formula", settings_str: null },
  ],
  tags: [],
};

const ITEM = {
  id: "555",
  name: "Ship the thing",
  state: "active",
  url: "https://example.monday.com/boards/111/pulses/555",
  created_at: "2026-08-01T10:00:00Z",
  updated_at: "2026-08-02T10:00:00Z",
  board: { id: "111", name: "Roadmap" },
  group: { id: "topics", title: "This month" },
  creator: { id: "7", name: "Ashley" },
  column_values: [
    {
      id: "status",
      type: "status",
      text: "Working on it",
      value: '{"index":0}',
      column: { id: "status", title: "Status" },
    },
    {
      id: "text_1",
      type: "text",
      text: "needs review",
      value: '"needs review"',
      column: { id: "text_1", title: "Notes" },
    },
    {
      id: "formula_1",
      type: "formula",
      text: null,
      value: null,
      display_value: "8.5",
      column: { id: "formula_1", title: "Score" },
    },
  ],
  subitems: [],
};

export class FakeMonday {
  readonly calls: RecordedCall[] = [];
  /** Set to make the next call answer with this error message. */
  nextError: string | undefined;

  readonly fetch: typeof fetch = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body)) as {
      query: string;
      variables: Record<string, unknown>;
    };
    const operation = /(?:query|mutation)\s+(\w+)/.exec(body.query)?.[1] ?? "anonymous";
    this.calls.push({ operation, query: body.query, variables: body.variables });

    if (this.nextError) {
      const message = this.nextError;
      this.nextError = undefined;
      return new Response(JSON.stringify({ errors: [{ message }] }), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }

    return new Response(JSON.stringify({ data: this.answer(operation, body.variables) }), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  }) as unknown as typeof fetch;

  /** The last call recorded, for an assertion on what went over the wire. */
  lastCall(operation: string): RecordedCall | undefined {
    return [...this.calls].reverse().find((call) => call.operation === operation);
  }

  private answer(operation: string, variables: Record<string, unknown>): unknown {
    switch (operation) {
      case "Me":
        return {
          me: {
            id: "7",
            name: "Ashley",
            email: "ashley@example.com",
            is_admin: true,
            is_guest: false,
            account: { id: "1", name: "Astriata", slug: "astriata", tier: "pro" },
          },
        };
      case "ListBoards":
        return { boards: [{ ...BOARD, owners: [{ id: "7", name: "Ashley" }] }] };
      case "GetBoard":
        return { boards: [BOARD] };
      case "ListItems":
        return { boards: [{ id: "111", name: "Roadmap", items_page: { cursor: "c1", items: [ITEM] } }] };
      case "NextItemsPage":
        return { next_items_page: { cursor: null, items: [ITEM] } };
      case "GetItems":
        return { items: [ITEM] };
      case "GetItemBoards":
        return { items: [{ id: String(variables.ids), board: { id: "111" } }] };
      case "GetItemUpdates":
        return {
          items: [
            {
              id: "555",
              name: "Ship the thing",
              updates: [
                {
                  id: "u1",
                  body: "<p>looks good</p>",
                  text_body: "looks good",
                  created_at: "2026-08-02T11:00:00Z",
                  creator: { id: "7", name: "Ashley" },
                  replies: [],
                },
              ],
            },
          ],
        };
      case "ListUsers":
        return {
          users: [
            { id: "7", name: "Ashley", email: "ashley@example.com", enabled: true },
            { id: "8", name: "Ben", email: "ben@example.com", enabled: true },
          ],
        };
      case "ListWorkspaces":
        return { workspaces: [{ id: "9", name: "Product", kind: "open" }] };
      case "CreateItem":
        return {
          create_item: {
            id: "556",
            name: String(variables.itemName),
            url: "https://example.monday.com/boards/111/pulses/556",
            group: { id: "topics", title: "This month" },
          },
        };
      case "CreateSubitem":
        return {
          create_subitem: {
            id: "600",
            name: String(variables.itemName),
            board: { id: "222", name: "Subitems of Roadmap" },
          },
        };
      case "ChangeColumnValues":
        return { change_multiple_column_values: ITEM };
      case "ChangeItemName":
        return { change_simple_column_value: { id: "555", name: String(variables.value) } };
      case "MoveItemToGroup":
        return { move_item_to_group: { id: "555", name: ITEM.name, group: { id: "group_two", title: "Later" } } };
      case "ArchiveItem":
        return { archive_item: { id: "555", name: ITEM.name, state: "archived" } };
      case "DeleteItem":
        return { delete_item: { id: "555", name: ITEM.name, state: "deleted" } };
      case "CreateUpdate":
        return { create_update: { id: "u2", body: "hi", created_at: "2026-08-03T09:00:00Z" } };
      default:
        return { ok: true };
    }
  }
}
