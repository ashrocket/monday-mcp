import { z } from "zod";
import { MondayApiError } from "../client.js";
import { guard, ok } from "../format.js";
import type { ToolContext } from "./context.js";

/**
 * True when the document contains a mutation. The check is deliberately
 * blunt, because a read-only server must never let one through.
 *
 * The GraphQL spec counts the comma as an ignored token, exactly like
 * whitespace, so `,mutation {...}` is a valid document. Any character that
 * cannot be part of a GraphQL name therefore has to count as a boundary.
 */
export function looksLikeMutation(document: string): boolean {
  const withoutComments = document.replace(/#[^\n]*/g, "");
  return /(^|[^A-Za-z0-9_])mutation(?![A-Za-z0-9_])/i.test(withoutComments);
}

export function registerRawTool({ server, client }: ToolContext): void {
  // A raw document can name any board, so an allow list cannot be honoured.
  // Registering a tool that always fails only wastes a model's turn.
  if (client.allowedBoards.size > 0) return;

  server.registerTool(
    "monday_graphql",
    {
      title: "Run a raw monday.com GraphQL document",
      description:
        (client.readOnly
          ? "Sends a GraphQL query straight to the monday.com API. This server " +
            "is read-only, so a mutation is refused. "
          : "Sends a GraphQL query or mutation straight to the monday.com API. ") +
        "Use it only for something the other tools do not cover, such as " +
        "boards, docs or webhooks. The other tools handle column value " +
        "translation for you, so prefer them for item work.",
      inputSchema: {
        query: z.string().min(1).describe("The GraphQL document."),
        variables: z
          .record(z.string(), z.unknown())
          .optional()
          .describe("Variables for the document."),
      },
      annotations: {
        readOnlyHint: client.readOnly,
        destructiveHint: !client.readOnly,
        openWorldHint: true,
      },
    },
    async ({ query, variables }) =>
      guard(async () => {
        if (client.readOnly && looksLikeMutation(query)) {
          throw new MondayApiError(
            "The server runs in read-only mode, so it refuses a mutation. " +
              "Remove MONDAY_READ_ONLY or the --read-only flag to allow writes.",
          );
        }
        const data = await client.query(query, variables ?? {}, {
          label: "monday_graphql",
        });
        return ok(data);
      }),
  );
}
