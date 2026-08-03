import { z } from "zod";
import { CREATE_UPDATE, GET_ITEM_UPDATES } from "../graphql.js";
import { guard, ok } from "../format.js";
import type { ToolContext } from "./context.js";

export function registerUpdateTools({ server, client, schemas }: ToolContext): void {
  server.registerTool(
    "monday_list_updates",
    {
      title: "Read the conversation on an item",
      description:
        "Returns the updates, which monday.com calls the item conversation, " +
        "newest first, with their replies.",
      inputSchema: {
        item_id: z.string().describe("The numeric item id, as a string."),
        limit: z.number().int().min(1).max(100).optional().describe("Default 25."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ item_id, limit }) =>
      guard(async () => {
        if (client.allowedBoards.size > 0) await schemas.boardIdForItem(item_id);
        const data = await client.query<{
          items: { id: string; name: string; updates: Record<string, unknown>[] }[];
        }>(
          GET_ITEM_UPDATES,
          { ids: [item_id], limit: limit ?? 25 },
          { label: "monday_list_updates" },
        );
        const item = data.items?.[0];
        return ok({
          item: item ? { id: item.id, name: item.name } : null,
          updates: item?.updates ?? [],
        });
      }),
  );

  if (client.readOnly) return;

  server.registerTool(
    "monday_create_update",
    {
      title: "Post an update on an item",
      description:
        "Adds an update to the item conversation. The body accepts simple HTML, " +
        "such as <p> and <b>. Everyone who follows the item gets a notification.",
      inputSchema: {
        item_id: z.string().describe("The numeric item id, as a string."),
        body: z.string().min(1).describe("The update text. Simple HTML is allowed."),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false },
    },
    async ({ item_id, body }) =>
      guard(async () => {
        client.assertWritable("post an update");
        await schemas.boardIdForItem(item_id);
        const data = await client.query<{ create_update: unknown }>(
          CREATE_UPDATE,
          { itemId: item_id, body },
          { label: "monday_create_update" },
        );
        return ok(data.create_update);
      }),
  );
}
