import { describe, expect, it } from "vitest";
import { LocatorError, resolveLocation } from "../src/locator.js";

const slug = "astriata";

describe("resolveLocation", () => {
  it("builds a board url", () => {
    const r = resolveLocation({ account_slug: slug, board_id: "18422658738" });
    expect(r.url).toBe("https://astriata.monday.com/boards/18422658738");
    expect(r.target).toBe("board");
  });

  it("prefers a view over the bare board", () => {
    const r = resolveLocation({ account_slug: slug, board_id: "1", view_id: "9" });
    expect(r.url).toBe("https://astriata.monday.com/boards/1/views/9");
    expect(r.target).toBe("board_view");
  });

  it("builds an item url and warns that it is an overlay", () => {
    const r = resolveLocation({ account_slug: slug, board_id: "1", item_id: "2" });
    expect(r.url).toBe("https://astriata.monday.com/boards/1/pulses/2");
    expect(r.target).toBe("item");
    expect(r.notes.join(" ")).toMatch(/overlay/);
  });

  it("puts an update under its item", () => {
    const r = resolveLocation({
      account_slug: slug,
      board_id: "1",
      item_id: "2",
      update_id: "3",
    });
    expect(r.url).toBe("https://astriata.monday.com/boards/1/pulses/2/posts/3");
    expect(r.target).toBe("update");
  });

  it("passes an asset as a query parameter", () => {
    const r = resolveLocation({ account_slug: slug, board_id: "1", item_id: "2", asset_id: "7" });
    expect(r.url).toBe("https://astriata.monday.com/boards/1/pulses/2?asset_id=7");
    expect(r.target).toBe("item_asset");
  });

  it("adds blockId only when a block is named", () => {
    const withBlock = resolveLocation({
      account_slug: slug,
      board_id: "1",
      item_id: "2",
      doc_id: "d",
      block_id: "b",
    });
    expect(withBlock.url).toContain("?doc_id=d&blockId=b");
    const withoutBlock = resolveLocation({
      account_slug: slug,
      board_id: "1",
      item_id: "2",
      doc_id: "d",
    });
    expect(withoutBlock.url).toContain("?doc_id=d");
    expect(withoutBlock.url).not.toContain("blockId");
  });

  it("builds the id-less targets", () => {
    expect(resolveLocation({ account_slug: slug, doc_id: "d" }).url).toBe(
      "https://astriata.monday.com/docs/d",
    );
    expect(resolveLocation({ account_slug: slug, workspace_id: "w" }).url).toBe(
      "https://astriata.monday.com/workspaces/w",
    );
    expect(resolveLocation({ account_slug: slug, dashboard_id: "o" }).url).toBe(
      "https://astriata.monday.com/overviews/o",
    );
    expect(resolveLocation({ account_slug: slug }).target).toBe("my_work");
  });

  it("returns group and column as api targets, never in the url", () => {
    const r = resolveLocation({
      account_slug: slug,
      board_id: "1",
      group_id: "topics",
      column_id: "status",
    });
    expect(r.api_targets).toEqual({ group_id: "topics", column_id: "status" });
    expect(r.url).not.toContain("topics");
    expect(r.url).not.toContain("status");
  });

  // A slug-less monday.com URL is a hard 404, so guessing is worse than failing.
  it("refuses to build a url without a slug", () => {
    expect(() => resolveLocation({ board_id: "1" })).toThrow(LocatorError);
    expect(() => resolveLocation({ board_id: "1" })).toThrow(/account slug/i);
  });

  it("rejects a whole host name given as the slug", () => {
    expect(() => resolveLocation({ account_slug: "astriata.monday.com", board_id: "1" })).toThrow(
      /subdomain only/,
    );
  });

  it("refuses an item without its board", () => {
    expect(() => resolveLocation({ account_slug: slug, item_id: "2" })).toThrow(/board_id/);
  });
});
