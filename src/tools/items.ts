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

/**
 * monday.com ids are numeric, and a model often emits them unquoted. A
 * strict z.string() turns that into a hard protocol error, so accept both
 * and normalise to the string the GraphQL layer wants.
 */
const idSchema = z.union([z.string(), z.number()]).transform(String);

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

  // monday.com wants compare_value as an array for every operator, the text
  // operators included.
  if (filter.column.toLowerCase() === "name") {
    if (EMPTY_OPERATORS.has(operator)) {
      return { column_id: "name", compare_value: [""], operator };
    }
    // Rewriting an unsupported operator to contains_text would return the
    // exact rows the caller asked to exclude, so name the problem instead.
    const NAME_OPERATORS = new Set([...TEXT_OPERATORS, "any_of", "not_any_of"]);
    if (!NAME_OPERATORS.has(operator)) {
      throw new ColumnValueError(
        `The item name does not support the ${operator} operator. ` +
          `Use one of: ${[...NAME_OPERATORS].join(", ")}.`,
      );
    }
    return {
      column_id: "name",
      compare_value: [String(filter.value ?? "")],
      operator,
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
    return { column_id: column.id, compare_value: [String(filter.value)], operator };
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
        board_id: idSchema.describe("The numeric board id."),
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
          .array(idSchema)
          .min(1)
          .max(100)
          .describe("Numeric item ids. Up to 100 at a time."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ item_ids }) =>
      guard(async () => {
        if (client.allowedBoards.size > 0) {
          for (const id of item_ids) await schemas.boardIdForItem(id);
        }
        const wanted = [...new Set(item_ids)];
        const data = await client.query<{ items: RawItem[] }>(
          GET_ITEMS,
          // items() defaults to 25 rows, so a 40 id request would silently
          // lose 15 of them.
          { ids: wanted, limit: wanted.length },
          { label: "monday_get_items" },
        );
        const items = data.items ?? [];
        if (items.length === 0) {
          throw new MondayApiError(
            `No item found for ${wanted.join(", ")}. Check the ids, or the token may not see the board.`,
          );
        }
        const returned = new Set(items.map((item) => String(item.id)));
        const missing = wanted.filter((id) => !returned.has(id));
        const detailed = items.map(detailedItem);
        return ok(
          missing.length > 0
            ? {
                items: detailed,
                missing_item_ids: missing,
                note:
                  "These ids returned nothing. They may not exist, or the token " +
                  "may not see their board.",
              }
            : detailed,
        );
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
        board_id: idSchema.describe("The numeric board id."),
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
        const createLabels = create_labels_if_missing ?? false;
        const columnValues = values
          ? buildColumnValues(board.columns, values, createLabels)
          : null;

        const data = await client.query<{ create_item: Record<string, unknown> }>(
          CREATE_ITEM,
          {
            boardId: board_id,
            groupId,
            itemName: name,
            columnValues: columnValues ? JSON.stringify(columnValues) : null,
            createLabels,
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
        item_id: idSchema.describe("The numeric item id."),
        values: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Column values keyed by column id or column title."),
        name: z.string().optional().describe("A new item name."),
        board_id: idSchema
          .optional()
          .describe(
            "The board id. The server finds it when you leave this out, and " +
              "checks it when you supply it.",
          ),
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

        // Never trust a caller-supplied board id: it decides both the allow
        // list check and which column schema the values translate against.
        const realBoardId = await schemas.boardIdForItem(item_id);
        if (board_id !== undefined && String(board_id) !== realBoardId) {
          throw new MondayApiError(
            `Item ${item_id} is on board ${realBoardId}, not board ${board_id}. ` +
              "Leave board_id out and the server will find it.",
          );
        }
        const boardId = realBoardId;
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
          const columnValues = buildColumnValues(
            board.columns,
            values,
            create_labels_if_missing ?? false,
          );
          try {
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
          } catch (error) {
            // The rename may already have gone through. Saying "failed" alone
            // would invite the caller to redo work that is already done.
            const note =
              name !== undefined
                ? ` The rename to "${name}" DID succeed and does not need repeating.`
                : "";
            throw new MondayApiError(`${(error as Error).message}${note}`, { cause: error });
          }
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
        item_id: idSchema.describe("The numeric item id."),
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
        parent_item_id: idSchema.describe("The numeric id of the parent item."),
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

        // The subitem board is monday.com's own hidden board. It can never
        // appear in a user supplied allow list, so it is trusted by way of
        // the parent item, which was checked above.
        const subBoard = await schemas.get(subitem.board.id, true, true);
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
        item_id: idSchema.describe("The numeric item id."),
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
