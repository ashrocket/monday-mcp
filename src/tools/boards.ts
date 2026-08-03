import { z } from "zod";
import {
  READ_ONLY_TYPES,
  UNSUPPORTED_WRITE_TYPES,
  dropdownLabels,
  statusLabels,
  type BoardColumn,
} from "../columns.js";
import { LIST_BOARDS } from "../graphql.js";
import { guard, ok } from "../format.js";
import type { ToolContext } from "./context.js";

/** A short note that shows a model exactly what to send for this column. */
function writeExample(column: BoardColumn): unknown {
  switch (column.type) {
    case "status": {
      const labels = statusLabels(column);
      return labels[0] ?? "a status label";
    }
    case "dropdown": {
      const labels = dropdownLabels(column);
      return labels.slice(0, 2);
    }
    case "date":
      return "2026-08-14";
    case "timeline":
      return ["2026-08-01", "2026-08-31"];
    case "people":
      return [12345678];
    case "checkbox":
      return true;
    case "numbers":
      return 42;
    case "link":
      return "https://example.com";
    case "email":
      return "someone@example.com";
    case "phone":
      return "+15551234567";
    case "tags":
      return [1234];
    case "board_relation":
    case "dependency":
      return [987654321];
    case "hour":
      return "14:30";
    case "rating":
      return 4;
    case "country":
      return "US";
    case "long_text":
    case "text":
      return "some text";
    default:
      return undefined;
  }
}

/** Turns a raw column into a description a model can act on. */
export function describeColumn(column: BoardColumn): Record<string, unknown> {
  const writable =
    !READ_ONLY_TYPES.has(column.type) && !UNSUPPORTED_WRITE_TYPES.has(column.type);
  const options =
    column.type === "status"
      ? statusLabels(column)
      : column.type === "dropdown"
        ? dropdownLabels(column)
        : [];

  return {
    id: column.id,
    title: column.title,
    type: column.type,
    writable,
    ...(options.length > 0 ? { options } : {}),
    ...(writable && writeExample(column) !== undefined
      ? { example_value: writeExample(column) }
      : {}),
  };
}

export function registerBoardTools({ server, client, schemas }: ToolContext): void {
  server.registerTool(
    "monday_list_boards",
    {
      title: "List monday.com boards",
      description:
        "Lists boards, newest use first. Use `name` to search by a part of the " +
        "board name. The result carries board ids, which every other tool needs.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Keep only boards whose name holds this text, ignoring letter case."),
        workspace_id: z
          .string()
          .optional()
          .describe("Keep only boards in this workspace."),
        limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
        page: z.number().int().min(1).optional().describe("1 based page number. Default 1."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, workspace_id, limit, page }) =>
      guard(async () => {
        const allowed = client.allowedBoards;
        const data = await client.query<{ boards: Record<string, unknown>[] }>(
          LIST_BOARDS,
          {
            limit: limit ?? 50,
            page: page ?? 1,
            ids: allowed.size > 0 ? [...allowed] : null,
            workspaceIds: workspace_id ? [workspace_id] : null,
          },
          { label: "monday_list_boards" },
        );

        let boards = data.boards ?? [];
        if (name) {
          const wanted = name.toLowerCase();
          boards = boards.filter((board) =>
            String(board.name ?? "").toLowerCase().includes(wanted),
          );
        }
        return ok({ count: boards.length, boards });
      }),
  );

  server.registerTool(
    "monday_get_board",
    {
      title: "Get a board layout",
      description:
        "Returns the groups and the columns of one board, with the labels each " +
        "status and dropdown column accepts. Call this before you create or " +
        "change an item, because a column value must match its column type.",
      inputSchema: {
        board_id: z.string().describe("The numeric board id, as a string."),
        refresh: z
          .boolean()
          .optional()
          .describe("True skips the one minute cache and reads the board again."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, refresh }) =>
      guard(async () => {
        const board = await schemas.get(board_id, refresh === true);
        return ok({
          id: board.id,
          name: board.name,
          description: board.description,
          state: board.state,
          board_kind: board.board_kind,
          items_count: board.items_count,
          workspace: board.workspace,
          groups: board.groups.map((group) => ({ id: group.id, title: group.title })),
          columns: board.columns.map(describeColumn),
          ...(board.tags && board.tags.length > 0 ? { tags: board.tags } : {}),
          hint:
            "Pass column values to monday_create_item or monday_update_item keyed by " +
            "column id or column title. Use the plain value shown in example_value.",
        });
      }),
  );
}
