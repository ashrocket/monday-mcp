import type { MondayClient } from "./client.js";
import { MondayApiError } from "./client.js";
import type { BoardColumn } from "./columns.js";
import { GET_BOARD, GET_ITEM_BOARDS } from "./graphql.js";

export interface BoardGroup {
  id: string;
  title: string;
  color?: string;
  position?: string;
}

export interface BoardSchema {
  id: string;
  name: string;
  description?: string | null;
  state?: string;
  board_kind?: string;
  items_count?: number;
  permissions?: string;
  workspace?: { id: string; name: string } | null;
  groups: BoardGroup[];
  columns: BoardColumn[];
  tags?: { id: string; name: string }[];
}

const TTL_MS = 60_000;

/**
 * Holds board schemas for a minute.
 *
 * A write tool needs the column list to translate a value, and an agent
 * often writes several items in a row. Without this cache each write costs
 * an extra round trip and burns the account complexity budget.
 */
export class BoardSchemaCache {
  private readonly client: MondayClient;
  private readonly entries = new Map<string, { at: number; schema: BoardSchema }>();
  private readonly itemBoards = new Map<string, string>();
  private readonly now: () => number;

  constructor(client: MondayClient, now: () => number = Date.now) {
    this.client = client;
    this.now = now;
  }

  /** Drops every cached schema. Used after a board changes shape. */
  clear(boardId?: string): void {
    if (boardId) this.entries.delete(String(boardId));
    else this.entries.clear();
  }

  /** Fetches a board schema, from the cache when it is fresh. */
  async get(boardId: string | number, force = false): Promise<BoardSchema> {
    const key = String(boardId);
    this.client.assertBoardAllowed(key);

    const cached = this.entries.get(key);
    if (!force && cached && this.now() - cached.at < TTL_MS) return cached.schema;

    const data = await this.client.query<{ boards: BoardSchema[] }>(
      GET_BOARD,
      { ids: [key] },
      { label: `board ${key}` },
    );
    const board = data.boards?.[0];
    if (!board) {
      throw new MondayApiError(
        `Board ${key} does not exist, or this token cannot see it.`,
      );
    }
    this.entries.set(key, { at: this.now(), schema: board });
    return board;
  }

  /** Finds which board holds an item. The answer never changes, so it stays. */
  async boardIdForItem(itemId: string | number): Promise<string> {
    const key = String(itemId);
    const known = this.itemBoards.get(key);
    if (known) {
      this.client.assertBoardAllowed(known);
      return known;
    }

    const data = await this.client.query<{
      items: { id: string; board: { id: string } | null }[];
    }>(GET_ITEM_BOARDS, { ids: [key] }, { label: `item ${key}` });

    const boardId = data.items?.[0]?.board?.id;
    if (!boardId) {
      throw new MondayApiError(
        `Item ${key} does not exist, or this token cannot see it.`,
      );
    }
    this.client.assertBoardAllowed(boardId);
    this.itemBoards.set(key, boardId);
    return boardId;
  }

  /** Finds a group by id or by title, so a caller may use either. */
  resolveGroupId(schema: BoardSchema, key: string): string {
    const byId = schema.groups.find((group) => group.id === key);
    if (byId) return byId.id;
    const wanted = key.toLowerCase().trim();
    const byTitle = schema.groups.find(
      (group) => group.title.toLowerCase().trim() === wanted,
    );
    if (byTitle) return byTitle.id;
    throw new MondayApiError(
      `Board "${schema.name}" has no group "${key}". Groups: ` +
        schema.groups.map((group) => `${group.id} = "${group.title}"`).join(", "),
    );
  }
}
