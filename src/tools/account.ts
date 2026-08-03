import { z } from "zod";
import { LIST_USERS, LIST_WORKSPACES, ME } from "../graphql.js";
import { guard, ok } from "../format.js";
import type { ToolContext } from "./context.js";

export function registerAccountTools({ server, client, config }: ToolContext): void {
  server.registerTool(
    "monday_get_me",
    {
      title: "Who am I on monday.com",
      description:
        "Returns the user behind the API token and the account it belongs to. " +
        "Call this first to prove the connection works and to learn the account slug.",
      inputSchema: {},
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async () =>
      guard(async () => {
        const data = await client.query<{ me: Record<string, unknown> }>(ME, {}, {
          label: "monday_get_me",
        });
        return ok({
          ...data.me,
          server: {
            read_only: config.readOnly,
            allowed_boards:
              config.allowedBoards.size > 0 ? [...config.allowedBoards] : "all",
            api_version: config.apiVersion,
          },
        });
      }),
  );

  server.registerTool(
    "monday_list_users",
    {
      title: "List monday.com users",
      description:
        "Lists people in the account. Use it to turn a name into the numeric " +
        "user id that a people column needs.",
      inputSchema: {
        name: z
          .string()
          .optional()
          .describe("Filter by a part of the name or the email, ignoring letter case."),
        kind: z
          .enum(["all", "non_guests", "guests", "non_pending"])
          .optional()
          .describe("Which class of user to return. The default is all."),
        limit: z.number().int().min(1).max(500).optional().describe("Default 100."),
        page: z.number().int().min(1).optional().describe("1 based page number. Default 1."),
        all_pages: z
          .boolean()
          .optional()
          .describe(
            "True walks every page until the name matches or the list ends. " +
              "Use it when searching a large account.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ name, kind, limit, page, all_pages }) =>
      guard(async () => {
        const pageSize = limit ?? 100;
        const wanted = name?.toLowerCase();
        const matches = (user: Record<string, unknown>): boolean =>
          !wanted ||
          [user.name, user.email]
            .map((field) => String(field ?? "").toLowerCase())
            .some((field) => field.includes(wanted));

        let pageNumber = page ?? 1;
        const collected: Record<string, unknown>[] = [];
        let scanned = 0;
        let lastPageSize = 0;

        // A name search filters client side, so stopping at page one would
        // hide everyone past the first 100 users.
        const walk = all_pages === true && wanted !== undefined;
        do {
          const data = await client.query<{ users: Record<string, unknown>[] }>(
            LIST_USERS,
            {
              limit: pageSize,
              page: pageNumber,
              ids: null,
              kind: kind === "all" ? null : (kind ?? null),
            },
            { label: "monday_list_users" },
          );
          const users = data.users ?? [];
          lastPageSize = users.length;
          scanned += users.length;
          collected.push(...users.filter(matches));
          pageNumber += 1;
        } while (walk && collected.length === 0 && lastPageSize === pageSize);

        const hasMore = lastPageSize === pageSize;
        return ok({
          count: collected.length,
          scanned,
          has_more: hasMore,
          ...(hasMore && collected.length === 0 && wanted
            ? { next: "No match yet. Call again with all_pages true, or advance page." }
            : {}),
          users: collected,
        });
      }),
  );

  server.registerTool(
    "monday_list_workspaces",
    {
      title: "List monday.com workspaces",
      description:
        "Lists the workspaces in the account. Use a workspace id to narrow monday_list_boards.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional().describe("Default 50."),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ limit }) =>
      guard(async () => {
        const data = await client.query<{ workspaces: Record<string, unknown>[] }>(
          LIST_WORKSPACES,
          { limit: limit ?? 50 },
          { label: "monday_list_workspaces" },
        );
        return ok(data.workspaces ?? []);
      }),
  );
}
