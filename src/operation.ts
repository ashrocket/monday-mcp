import { Kind, parse } from "graphql";

/** Classify the operation the request will execute, using GraphQL grammar. */
export function documentOperation(document: string): "query" | "mutation" {
  if (Buffer.byteLength(document, "utf8") > 128 * 1024) {
    throw new Error("GraphQL document exceeds the 128 KiB limit.");
  }
  let parsed;
  try {
    parsed = parse(document, { maxTokens: 10_000 });
  } catch {
    throw new Error("Invalid or overly complex GraphQL document. Send one query or mutation (at most 10000 tokens).");
  }
  const operations = parsed.definitions.filter(
    (definition) => definition.kind === Kind.OPERATION_DEFINITION,
  );
  // The transport does not send operationName, so multiple operations are
  // ambiguous. Schema definitions and subscriptions are unsupported as well.
  if (
    operations.length !== 1 ||
    parsed.definitions.some(
      (definition) => definition.kind !== Kind.OPERATION_DEFINITION &&
        definition.kind !== Kind.FRAGMENT_DEFINITION,
    )
  ) {
    throw new Error("Send exactly one GraphQL query or mutation, with optional fragments.");
  }
  const operation = operations[0]!.operation;
  if (operation !== "query" && operation !== "mutation") {
    throw new Error("GraphQL subscriptions are not supported. Send a query or mutation.");
  }
  return operation;
}
