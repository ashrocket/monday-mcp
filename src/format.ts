import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodeColumnValue } from "./columns.js";

/** Wraps any value as a successful tool result. */
export function ok(data: unknown): CallToolResult {
  // JSON.stringify(undefined) is undefined, and the SDK rejects a text
  // part with no text.
  const text =
    typeof data === "string" ? data : (JSON.stringify(data, null, 2) ?? "null");
  return { content: [{ type: "text", text }] };
}

/** Wraps a message as a failed tool result the model can read and correct. */
export function fail(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

/** Runs a tool body and turns any throw into a readable tool error. */
export async function guard(
  run: () => Promise<CallToolResult>,
): Promise<CallToolResult> {
  try {
    return await run();
  } catch (error) {
    return fail((error as Error).message ?? String(error));
  }
}

export interface RawColumnValue {
  id: string;
  type: string;
  text?: string | null;
  value?: string | null;
  display_value?: string | null;
  linked_item_ids?: string[] | null;
  column?: { id: string; title: string } | null;
}

export interface RawItem {
  id: string;
  name: string;
  state?: string;
  url?: string;
  created_at?: string;
  updated_at?: string;
  board?: { id: string; name: string } | null;
  group?: { id: string; title: string } | null;
  creator?: { id: string; name: string } | null;
  column_values?: RawColumnValue[];
  subitems?: { id: string; name: string; state?: string }[] | null;
}

/** Picks the best human readable text for one column value. */
function displayText(column: RawColumnValue): string | null {
  if (column.display_value !== undefined && column.display_value !== null) {
    return column.display_value === "" ? null : column.display_value;
  }
  if (column.text !== undefined && column.text !== null) {
    return column.text === "" ? null : column.text;
  }
  return null;
}

/**
 * A short item shape for list results. Column values collapse to a map of
 * column title to display text, which keeps a 50 item page small.
 */
export function compactItem(item: RawItem): Record<string, unknown> {
  const values: Record<string, string | null> = {};
  for (const column of item.column_values ?? []) {
    const title = column.column?.title ?? column.id;
    const text = displayText(column);
    if (text === null) continue;
    // Duplicate column titles are legal on a board. Fall back to the column
    // id for the second one, so neither value disappears.
    values[title in values ? column.id : title] = text;
  }
  return {
    id: item.id,
    name: item.name,
    ...(item.state && item.state !== "active" ? { state: item.state } : {}),
    ...(item.group ? { group: item.group.title } : {}),
    ...(item.board ? { board: { id: item.board.id, name: item.board.name } } : {}),
    ...(item.updated_at ? { updated_at: item.updated_at } : {}),
    values,
  };
}

/**
 * The full item shape for detail results. It keeps column ids and the
 * stored JSON, which a caller needs before it writes the column back.
 */
export function detailedItem(item: RawItem): Record<string, unknown> {
  return {
    id: item.id,
    name: item.name,
    state: item.state,
    url: item.url,
    board: item.board,
    group: item.group,
    creator: item.creator,
    created_at: item.created_at,
    updated_at: item.updated_at,
    columns: (item.column_values ?? []).map((column) => ({
      id: column.id,
      title: column.column?.title ?? column.id,
      type: column.type,
      text: displayText(column),
      value: decodeColumnValue(column.value),
      ...(column.linked_item_ids ? { linked_item_ids: column.linked_item_ids } : {}),
    })),
    ...(item.subitems && item.subitems.length > 0 ? { subitems: item.subitems } : {}),
  };
}
