import { z } from "zod";
import { MondayApiError } from "../client.js";
import { guard, ok } from "../format.js";
import type { ToolContext } from "./context.js";

/**
 * True when the document contains a mutation. The check is deliberately
 * blunt, because a read-only server must never let one through.
 */
export function looksLikeMutation(document: string): boolean {
  const withoutComments = document.replace(/#[^\n]*/g, "");
  return /(^|[\s{(])mutation\b/i.test(withoutComments);
}

export function registerRawTool({ server, client }: ToolContext): void {
  server.registerTool(
    "monday_graphql",
    {
      title: "Run a raw monday.com GraphQL document",
      description:
        "Sends a GraphQL query or mutation straight to the monday.com API. " +
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
      annotations: { readOnlyHint: false, destructiveHint: true, openWorldHint: true },
    },
    async ({ query, variables }) =>
      guard(async () => {
        if (client.readOnly && looksLikeMutation(query)) {
          throw new MondayApiError(
            "The server runs in read-only mode, so it refuses a mutation. " +
              "Remove MONDAY_READ_ONLY or the --read-only flag to allow writes.",
          );
        }
        if (client.allowedBoards.size > 0) {
          throw new MondayApiError(
            "This server limits itself to an allowed board list, which a raw " +
              "GraphQL call cannot honour. Use the named tools instead.",
          );
        }
        const data = await client.query(query, variables ?? {}, {
          label: "monday_graphql",
        });
        return ok(data);
      }),
  );
}
