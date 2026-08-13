/**
 * The unified locator: one address object that every mode consumes.
 *
 * Mode 3 (API) works from ids alone, but the browser and desktop modes need a
 * URL, and a URL cannot carry a group or a column. Resolving once here is what
 * lets a caller dispatch to any mode without paying for discovery twice.
 *
 * See docs/interface-map.md §1 for the evidence behind each URL shape.
 */

export interface MondayLocator {
  /** Account subdomain. Mandatory for every URL: a slug-less URL is a 404. */
  account_slug?: string;
  board_id?: string;
  view_id?: string;
  /** Also called the pulse id. */
  item_id?: string;
  update_id?: string;
  asset_id?: string;
  doc_id?: string;
  block_id?: string;
  workspace_id?: string;
  dashboard_id?: string;
  /** Not URL-addressable. Carried so browser modes can act once resolved. */
  group_id?: string;
  /** Not URL-addressable, and API-only — no data-column-id exists in the DOM. */
  column_id?: string;
}

/** What a locator resolves to. */
export interface ResolvedLocation {
  url: string;
  /** Which row of the §1 URL table produced the url. */
  target: LocationTarget;
  /** Ids that no URL can carry, echoed for the mode that can use them. */
  api_targets: { group_id?: string; column_id?: string };
  /** Set when the url points at a board rather than the thing asked for. */
  notes: string[];
}

export type LocationTarget =
  | "update"
  | "item_asset"
  | "item_doc"
  | "item"
  | "board_view"
  | "board"
  | "doc"
  | "workspace"
  | "dashboard"
  | "my_work";

/** Raised when a locator cannot become a URL. */
export class LocatorError extends Error {
  override name = "LocatorError";
}

const SLUG_PATTERN = /^[a-z0-9][a-z0-9-]*$/i;

/**
 * Builds the URL for a locator, most specific target first.
 *
 * Throws rather than emitting a slug-less URL: `monday.com/boards/<id>` without
 * the account subdomain is a hard 404, so a missing slug is a caller error, not
 * something to paper over.
 */
export function resolveLocation(locator: MondayLocator): ResolvedLocation {
  const slug = (locator.account_slug ?? "").trim();
  if (!slug) {
    throw new LocatorError(
      "No account slug. Every monday.com URL needs the account subdomain — " +
        "a slug-less URL is a 404. Pass account_slug, set MONDAY_ACCOUNT_SLUG " +
        "or --account-slug, or call monday_get_me to read it from the token.",
    );
  }
  if (!SLUG_PATTERN.test(slug)) {
    throw new LocatorError(
      `"${slug}" is not a usable account slug. Use the subdomain only, ` +
        "for example mycompany, not the whole host name.",
    );
  }

  const origin = `https://${slug}.monday.com`;
  const notes: string[] = [];
  const api_targets = {
    ...(locator.group_id ? { group_id: locator.group_id } : {}),
    ...(locator.column_id ? { column_id: locator.column_id } : {}),
  };
  if (locator.group_id || locator.column_id) {
    notes.push(
      "group_id and column_id are not URL-addressable. They are returned for " +
        "the API mode, or for a browser step that acts after the page loads.",
    );
  }

  const done = (url: string, target: LocationTarget): ResolvedLocation => ({
    url,
    target,
    api_targets,
    notes,
  });

  if (locator.item_id) {
    if (!locator.board_id) {
      throw new LocatorError(
        "An item URL needs board_id as well as item_id — the item path is " +
          "nested under its board. monday_get_items returns the board for an item.",
      );
    }
    const item = `${origin}/boards/${locator.board_id}/pulses/${locator.item_id}`;
    notes.push(
      "An item URL opens the board with the item card as an overlay. It is not " +
        "a standalone page, and the board does not scroll to the item.",
    );
    if (locator.update_id) return done(`${item}/posts/${locator.update_id}`, "update");
    if (locator.asset_id) {
      return done(`${item}?asset_id=${encodeURIComponent(locator.asset_id)}`, "item_asset");
    }
    if (locator.doc_id) {
      const block = locator.block_id
        ? `&blockId=${encodeURIComponent(locator.block_id)}`
        : "";
      return done(`${item}?doc_id=${encodeURIComponent(locator.doc_id)}${block}`, "item_doc");
    }
    return done(item, "item");
  }

  if (locator.board_id) {
    if (locator.view_id) {
      return done(`${origin}/boards/${locator.board_id}/views/${locator.view_id}`, "board_view");
    }
    return done(`${origin}/boards/${locator.board_id}`, "board");
  }

  if (locator.doc_id) return done(`${origin}/docs/${locator.doc_id}`, "doc");
  if (locator.workspace_id) return done(`${origin}/workspaces/${locator.workspace_id}`, "workspace");
  if (locator.dashboard_id) {
    notes.push(
      "The /overviews/ path segment is inferred from the API's overview_id and " +
        "is not documented publicly. Treat a failure here as expected.",
    );
    return done(`${origin}/overviews/${locator.dashboard_id}`, "dashboard");
  }

  notes.push("No id was given, so this is the account's My Work page.");
  return done(`${origin}/my_work`, "my_work");
}
