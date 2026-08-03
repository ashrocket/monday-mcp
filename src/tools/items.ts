import { z } from "zod";
import { MondayApiError } from "../client.js";
import {
  ColumnValueError,
  buildColumnValues,
  resolveColumn,
  statusIndexFor,
  statusLabels,
} from "../columns.js";
import type { BoardColumn } from "../columns.js";
import {
  ARCHIVE_ITEM,
  CHANGE_COLUMN_VALUES,
  CHANGE_ITEM_NAME,
  CREATE_ITEM,
  CREATE_SUBITEM,
  DELETE_ITEM,
  GET_ITEMS,
  LIST_ITEMS,
  MOVE_ITEM_TO_GROUP,
  NEXT_ITEMS_PAGE,
} from "../graphql.js";
import { compactItem, detailedItem, guard, ok } from "../format.js";
import type { RawItem } from "../format.js";
import type { ToolContext } from "./context.js";

const FILTER_OPERATORS = [
  "any_of",
  "not_any_of",
  "is_empty",
  "is_not_empty",
  "contains_text",
  "not_contains_text",
  "starts_with",
  "ends_with",
  "greater_than",
  "greater_than_or_equals",
  "lower_than",
  "lower_than_or_equal",
  "between",
] as const;

const TEXT_OPERATORS = new Set([
  "contains_text",
  "not_contains_text",
  "starts_with",
  "ends_with",
]);

const EMPTY_OPERATORS = new Set(["is_empty", "is_not_empty"]);

const filterSchema = z.object({
  column: z
    .string()
    .describe('Column id or column title. Use "name" for the item name.'),
  operator: z
    .enum(FILTER_OPERATORS)
    .optional()
    .describe("Default any_of, which means an exact match on one of the values."),
  value: z
    .union([z.string(), z.number(), z.boolean(), z.array(z.union([z.string(), z.number()]))])
    .optional()
    .describe("The value to compare. Omit it for is_empty and is_not_empty."),
});

type Filter = z.infer<typeof filterSchema>;

/**
 * Builds one monday.com query rule.
 *
 * A status column compares on the numeric label index, not on the label
 * text, so a plain label gets translated here.
 */
export function buildRule(
  columns: BoardColumn[],
  filter: Filter,
): Record<string, unknown> {
  const operator = filter.operator ?? "any_of";

  if (filter.column.toLowerCase() === "name") {
    if (EMPTY_OPERATORS.has(operator)) {
      return { column_id: "name", compare_value: [""], operator };
    }
    return {
      column_id: "name",
      compare_value: TEXT_OPERATORS.has(operator)
        ? String(filter.value ?? "")
        : [String(filter.value ?? "")],
      operator: TEXT_OPERATORS.has(operator) ? operator : "contains_text",
    };
  }

  const column = resolveColumn(columns, filter.column);

  if (EMPTY_OPERATORS.has(operator)) {
    return { column_id: column.id, compare_value: [""], operator };
  }

  if (filter.value === undefined) {
    throw new ColumnValueError(
      `The filter on "${filter.column}" needs a value for operator ${operator}.`,
    );
  }

  if (TEXT_OPERATORS.has(operator)) {
    return { column_id: column.id, compare_value: String(filter.value), operator };
  }

  const values = Array.isArray(filter.value) ? filter.value : [filter.value];

  // A status column compares on the label index, not on the label text.
  if (column.type === "status" || column.type === "color") {
    const indexes = values.map((entry) => {
      if (typeof entry === "number") return entry;
      const index = statusIndexFor(column, String(entry));
      if (index === undefined) {
        const labels = statusLabels(column);
        throw new ColumnValueError(
          `Column "${column.title}" has no status "${String(entry)}". ` +
            `It accepts: ${labels.map((label) => `"${label}"`).join(", ")}.`,
        );
      }
      return index;
    });
    return { column_id: column.id, compare_value: indexes, operator };
  }

  return { column_id: column.id, compare_value: values.map(String), operator };
}

export function registerItemTools(context: ToolContext): void {
  const { server, client, schemas } = context;

  server.registerTool(
    "monday_list_items",
    {
      title: "List or search items on a board",
      description:
        "Returns a page of items from one board, with each column value as " +
        "readable text. Filter with `filters`, and follow `cursor` for the next " +
        "page. Call monday_get_board first to learn the column ids and labels.",
      inputSchema: {
        board_id: z.string().describe("The numeric board id, as a string."),
        search: z
          .string()
          .optional()
          .describe("Keep only items whose name holds this text."),
        group: z.string().optional().describe("Group id or group title to read."),
        filters: z
          .array(filterSchema)
          .optional()
          .describe("Column rules. All rules must match."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
        cursor: z
          .string()
          .optional()
          .describe(
            "The cursor from an earlier call. It carries the earlier filters, " +
              "so send board_id and cursor only.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ board_id, search, group, filters, limit, cursor }) =>
      guard(async () => {
        client.assertBoardAllowed(board_id);
        const pageSize = limit ?? 25;

        if (cursor) {
          const data = await client.query<{
            next_items_page: { cursor: string | null; items: RawItem[] };
          }>(NEXT_ITEMS_PAGE, { cursor, limit: pageSize }, { label: "monday_list_items" });
          const page = data.next_items_page;
          return ok({
            items: (page?.items ?? []).map(compactItem),
            cursor: page?.cursor ?? null,
          });
        }

        const board = await schemas.get(board_id);
        const rules: Record<string, unknown>[] = [];

        if (search) {
          rules.push(buildRule(board.columns, {
            column: "name",
            operator: "contains_text",
            value: search,
          }));
        }
        if (group) {
          rules.push({
            column_id: "group",
            compare_value: [schemas.resolveGroupId(board, group)],
            operator: "any_of",
          });
        }
        for (const filter of filters ?? []) {
          rules.push(buildRule(board.columns, filter));
        }

        const data = await client.query<{
          boards: {
            items_page: { cursor: string | null; items: RawItem[] };
          }[];
        }>(
          LIST_ITEMS,
          {
            boardId: board_id,
            limit: pageSize,
            queryParams: rules.length > 0 ? { rules, operator: "and" } : null,
          },
          { label: "monday_list_items" },
        );

        const page = data.boards?.[0]?.items_page;
        return ok({
          board: { id: board.id, name: board.name },
          items: (page?.items ?? []).map(compactItem),
          cursor: page?.cursor ?? null,
          ...(page?.cursor
            ? { next: "Call this tool again with the same board_id and this cursor." }
            : {}),
        });
      }),
  );

  server.registerTool(
    "monday_get_items",
    {
      title: "Get full item detail",
      description:
        "Returns every column of one or more items, with the column id, the " +
        "readable text and the stored JSON. Use it before you change an item.",
      inputSchema: {
        item_ids: z
          .array(z.string())
          .min(1)
          .max(100)
          .describe("Numeric item ids, as strings."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ item_ids }) =>
      guard(async () => {
        if (client.allowedBoards.size > 0) {
          for (const id of item_ids) await schemas.boardIdForItem(id);
        }
        const data = await client.query<{ items: RawItem[] }>(
          GET_ITEMS,
          { ids: item_ids },
          { label: "monday_get_items" },
        );
        const items = data.items ?? [];
        if (items.length === 0) {
          throw new MondayApiError(
            `No item found for ${item_ids.join(", ")}. Check the ids, or the token may not see the board.`,
          );
        }
        return ok(items.map(detailedItem));
      }),
  );

  if (client.readOnly) return;

  server.registerTool(
    "monday_create_item",
    {
      title: "Create an item",
      description:
        "Creates one item on a board. Give `values` keyed by column id or " +
        "column title, with plain values such as \"Done\" for a status or " +
        '"2026-08-14" for a date. This server converts them to the JSON that ' +
        "monday.com stores. Call monday_get_board first to see the columns.",
      inputSchema: {
        board_id: z.string().describe("The numeric board id, as a string."),
        name: z.string().min(1).describe("The item name."),
        group: z
          .string()
          .optional()
          .describe("Group id or group title. The default is the top group."),
        values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe(
            'Column values, for example {"Status": "Working on it", "Owner": [12345678]}.',
          ),
        create_labels_if_missing: z
          .boolean()
          .optional()
          .describe("True adds a status or dropdown label that does not exist yet."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ board_id, name, group, values, create_labels_if_missing }) =>
      guard(async () => {
        client.assertWritable("create an item");
        const board = await schemas.get(board_id);
        const groupId = group ? schemas.resolveGroupId(board, group) : null;
        const columnValues = values ? buildColumnValues(board.columns, values) : null;

        const data = await client.query<{ create_item: Record<string, unknown> }>(
          CREATE_ITEM,
          {
            boardId: board_id,
            groupId,
            itemName: name,
            columnValues: columnValues ? JSON.stringify(columnValues) : null,
            createLabels: create_labels_if_missing ?? false,
          },
          { label: "monday_create_item" },
        );
        return ok({ created: data.create_item, sent_column_values: columnValues });
      }),
  );

  server.registerTool(
    "monday_update_item",
    {
      title: "Change item columns",
      description:
        "Changes the columns of one item, and the item name when `name` is " +
        "given. Values use the same plain form as monday_create_item.",
      inputSchema: {
        item_id: z.string().describe("The numeric item id, as a string."),
        values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Column values keyed by column id or column title."),
        name: z.string().optional().describe("A new item name."),
        board_id: z
          .string()
          .optional()
          .describe("The board id. The server finds it when you leave this out."),
        create_labels_if_missing: z
          .boolean()
          .optional()
          .describe("True adds a status or dropdown label that does not exist yet."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true },
    },
    async ({ item_id, values, name, board_id, create_labels_if_missing }) =>
      guard(async () => {
        client.assertWritable("change an item");
        if (!values && name === undefined) {
          throw new MondayApiError("Give `values`, or `name`, or both.");
        }

        const boardId = board_id ?? (await schemas.boardIdForItem(item_id));
        client.assertBoardAllowed(boardId);
        const result: Record<string, unknown> = { item_id, board_id: boardId };

        if (name !== undefined) {
          const renamed = await client.query<{ change_simple_column_value: unknown }>(
            CHANGE_ITEM_NAME,
            { boardId, itemId: item_id, value: name },
            { label: "monday_update_item (name)" },
          );
          result.renamed = renamed.change_simple_column_value;
        }

        if (values) {
          const board = await schemas.get(boardId);
          const columnValues = buildColumnValues(board.columns, values);
          const changed = await client.query<{
            change_multiple_column_values: RawItem;
          }>(
            CHANGE_COLUMN_VALUES,
            {
              boardId,
              itemId: item_id,
              columnValues: JSON.stringify(columnValues),
              createLabels: create_labels_if_missing ?? false,
            },
            { label: "monday_update_item" },
          );
          result.sent_column_values = columnValues;
          result.item = detailedItem(changed.change_multiple_column_values);
        }

        return ok(result);
      }),
  );

  server.registerTool(
    "monday_move_item",
    {
      title: "Move an item to a group",
      description: "Moves one item into another group on the same board.",
      inputSchema: {
        item_id: z.string().describe("The numeric item id, as a string."),
        group: z.string().describe("The target group id or group title."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true },
    },
    async ({ item_id, group }) =>
      guard(async () => {
        client.assertWritable("move an item");
        const boardId = await schemas.boardIdForItem(item_id);
        const board = await schemas.get(boardId);
        const data = await client.query<{ move_item_to_group: unknown }>(
          MOVE_ITEM_TO_GROUP,
          { itemId: item_id, groupId: schemas.resolveGroupId(board, group) },
          { label: "monday_move_item" },
        );
        return ok(data.move_item_to_group);
      }),
  );

  server.registerTool(
    "monday_create_subitem",
    {
      title: "Create a subitem",
      description:
        "Creates a subitem under a parent item. Column values apply in a " +
        "second step, because a subitem lives on its own hidden board.",
      inputSchema: {
        parent_item_id: z.string().describe("The numeric id of the parent item."),
        name: z.string().min(1).describe("The subitem name."),
        values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Column values keyed by subitem column id or title."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ parent_item_id, name, values }) =>
      guard(async () => {
        client.assertWritable("create a subitem");
        await schemas.boardIdForItem(parent_item_id);

        const created = await client.query<{
          create_subitem: { id: string; name: string; board: { id: string; name: string } };
        }>(
          CREATE_SUBITEM,
          { parentItemId: parent_item_id, itemName: name, columnValues: null, createLabels: false },
          { label: "monday_create_subitem" },
        );
        const subitem = created.create_subitem;
        if (!values) return ok({ created: subitem });

        const subBoard = await schemas.get(subitem.board.id, true);
        const columnValues = buildColumnValues(subBoard.columns, values);
        await client.query(
          CHANGE_COLUMN_VALUES,
          {
            boardId: subitem.board.id,
            itemId: subitem.id,
            columnValues: JSON.stringify(columnValues),
            createLabels: false,
          },
          { label: "monday_create_subitem (values)" },
        );
        return ok({ created: subitem, sent_column_values: columnValues });
      }),
  );

  server.registerTool(
    "monday_delete_item",
    {
      title: "Archive or delete an item",
      description:
        "Archives an item by default, which a person can undo in the monday.com " +
        'interface. Mode "delete" removes the item for good and needs confirm true.',
      inputSchema: {
        item_id: z.string().describe("The numeric item id, as a string."),
        mode: z
          .enum(["archive", "delete"])
          .optional()
          .describe("Default archive. Use delete only when the user asks for it."),
        confirm: z
          .boolean()
          .optional()
          .describe("Must be true for mode delete."),
      },
      annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false },
    },
    async ({ item_id, mode, confirm }) =>
      guard(async () => {
        const action = mode ?? "archive";
        client.assertWritable(`${action} an item`);
        if (action === "delete" && confirm !== true) {
          throw new MondayApiError(
            "Deletion is permanent. Send confirm true, or use mode archive instead.",
          );
        }
        await schemas.boardIdForItem(item_id);
        const data = await client.query<Record<string, unknown>>(
          action === "delete" ? DELETE_ITEM : ARCHIVE_ITEM,
          { itemId: item_id },
          { label: `monday_delete_item (${action})` },
        );
        return ok({ action, result: data.delete_item ?? data.archive_item });
      }),
  );
}
