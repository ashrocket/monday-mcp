import { z } from "zod";
import { ME } from "../graphql.js";
import { fail, guard, ok } from "../format.js";
import { resolveLocation, type MondayLocator } from "../locator.js";
import {
  DesktopError,
  desktopNavigate,
  desktopRuntimeProblem,
  withDesktop,
  type DesktopOptions,
} from "../desktop.js";
import type { LocateContext } from "./context.js";

/** The locator fields, as an MCP input schema. */
const locatorShape = {
  account_slug: z
    .string()
    .optional()
    .describe(
      "Account subdomain, for example astriata. Defaults to the configured " +
        "slug, or the token's own account. Every URL needs it.",
    ),
  board_id: z.string().optional().describe("Board id."),
  view_id: z.string().optional().describe("Board view (tab) id."),
  item_id: z.string().optional().describe("Item id, also called the pulse id. Needs board_id."),
  update_id: z.string().optional().describe("An update on the item."),
  asset_id: z.string().optional().describe("A file on the item."),
  doc_id: z.string().optional().describe("A workdoc, or a doc column on the item."),
  block_id: z.string().optional().describe("A block inside a doc."),
  workspace_id: z.string().optional(),
  dashboard_id: z.string().optional().describe("An overview id."),
  group_id: z
    .string()
    .optional()
    .describe("Carried through, but no URL can address a group."),
  column_id: z
    .string()
    .optional()
    .describe("Carried through, but no URL can address a column."),
};

/** The recipe that actually works for a browser the caller drives itself. */
const CHROME_RECIPE = [
  "Open https://<slug>.monday.com first and let it finish loading.",
  "Then find the board or item link on that page and click it.",
  "Do not navigate straight to the deep link: the board never reaches",
  "document-idle, so a driver that waits for idle times out even though the",
  "page is fine. In-app navigation keeps the already-idle document.",
].join(" ");

export function registerLocateTools({ server, config, client }: LocateContext): void {
  const desktop = (): DesktopOptions => ({ port: config.debugPort });

  const actions: [string, ...string[]] = config.readOnly
    ? ["read_card"]
    : ["read_card", "post_update"];

  // The slug never changes for a token, so one lookup per process is enough.
  let cachedSlug: string | undefined = config.accountSlug;
  async function accountSlug(override?: string): Promise<string | undefined> {
    if (override?.trim()) return override.trim();
    if (cachedSlug) return cachedSlug;
    if (!client) return undefined;
    const data = await client.query<{ me: { account?: { slug?: string } } }>(
      ME,
      {},
      { label: "monday_resolve_location" },
    );
    cachedSlug = data.me?.account?.slug ?? undefined;
    return cachedSlug;
  }

  server.registerTool(
    "monday_resolve_location",
    {
      title: "Resolve a monday.com location",
      description:
        "Turns ids into the URL that addresses them, plus the ids no URL can " +
        "carry. Call this before any browser or desktop step, so the address is " +
        "resolved once and every mode can reuse it.",
      inputSchema: locatorShape,
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async (input) =>
      guard(async () => {
        const slug = await accountSlug(input.account_slug);
        const resolved = resolveLocation({ ...(input as MondayLocator), account_slug: slug });
        return ok(resolved);
      }),
  );

  server.registerTool(
    "monday_open",
    {
      title: "Open a monday.com location",
      description:
        "Navigates the monday.com desktop app to a location and reports what " +
        "loaded. Mode desktop drives the app over its debug port and needs no " +
        "API token. Mode chrome CANNOT navigate for you — this server cannot " +
        "reach your browser — so it returns the URL and the recipe for you to " +
        "follow with a browser tool.",
      inputSchema: {
        ...locatorShape,
        mode: z
          .enum(["auto", "desktop", "chrome"])
          .optional()
          .describe(
            "desktop drives the app. chrome returns instructions only. " +
              "auto uses desktop when its debug port answers, else chrome.",
          ),
      },
      annotations: { readOnlyHint: true, openWorldHint: true },
    },
    async ({ mode, ...locator }) =>
      guard(async () => {
        const slug = await accountSlug(locator.account_slug);
        const resolved = resolveLocation({ ...(locator as MondayLocator), account_slug: slug });
        const wanted = mode ?? "auto";

        if (wanted === "chrome") {
          return ok({
            next_step: "NOT NAVIGATED. Open this url yourself with a browser tool.",
            ...resolved,
            mode: "chrome",
            navigated: false,
            recipe: CHROME_RECIPE,
          });
        }

        try {
          const page = await desktopNavigate(desktop(), resolved.url);
          return ok({ ...resolved, mode: "desktop", navigated: true, page });
        } catch (error) {
          const message = (error as Error).message;
          if (wanted === "desktop") return fail(message);
          // auto: the desktop app is not listening, so hand back the browser
          // path. Lead with the fact that nothing moved — a caller that reads
          // only the status would otherwise carry on as if it had.
          return ok({
            next_step:
              "NOT NAVIGATED. The desktop app is not reachable, so open this url " +
              "yourself with a browser tool.",
            ...resolved,
            mode: "chrome",
            navigated: false,
            recipe: CHROME_RECIPE,
            desktop_unavailable: message,
          });
        }
      }),
  );

  server.registerTool(
    "monday_ui_action",
    {
      title: "Act on a monday.com item card",
      description:
        "Drives the item card in the desktop app, for things the API cannot " +
        "reach. read_card returns the card's updates. post_update writes an " +
        "update through the composer. Both need the desktop debug port and no " +
        "API token. Board grid cells are NOT reachable: the grid is a canvas, " +
        "not DOM. Switching views and running the Excel export are not implemented.",
      inputSchema: {
        ...locatorShape,
        // In read-only mode the write action is not offered at all, so the
        // tool is honestly read-only rather than accepting a write and
        // refusing it after the model has committed to the plan. The list is
        // built at runtime, so the handler sees a plain string.
        action: z.enum(actions).describe(
          config.readOnly
            ? "read_card reads the open card. This server is read-only, so " +
                "posting is not offered."
            : "read_card reads the open card. post_update posts text on it.",
        ),
        body: z.string().optional().describe("The update text. Required for post_update."),
      },
      annotations: { readOnlyHint: config.readOnly, openWorldHint: true },
    },
    async ({ action, body, ...locator }) =>
      guard(async () => {
        if (action === "post_update") {
          if (config.readOnly) {
            return fail(
              "The server runs in read-only mode, so it cannot post an update.",
            );
          }
          if (!body?.trim()) return fail("post_update needs body, the text to post.");
        }
        if (!locator.item_id) {
          return fail("This tool acts on an item card, so item_id is required.");
        }

        const problem = desktopRuntimeProblem();
        if (problem) return fail(problem);

        const slug = await accountSlug(locator.account_slug);
        const resolved = resolveLocation({ ...(locator as MondayLocator), account_slug: slug });

        // One session for every step: navigate, preflight and act must observe
        // the same page, not three separate connections.
        return withDesktop(desktop(), async (session) => {
        // Widen BEFORE navigating so the card lays out at the larger size. The
        // panel is right-anchored and its controls fall outside a normal window
        // otherwise — measured live at x=1813 in a 1360px viewport.
        await session.setViewport(2_400, 1_400);
        // Navigate: the card is only DOM once the deep link has settled.
        await session.navigate(resolved.url);

        // Preflight. The card is a real dialog; the grid behind it is a canvas.
        // Fail loudly here rather than clicking into pixels.
        // Patient, not one-shot: a cold board can still be mounting when the
        // navigation poll gives up, and a snapshot taken then reads as "the
        // card never opened" on a page that was simply slow.
        const ready = (await session.evaluate(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const look = () => ({
              on_item_url: location.pathname.includes('/pulses/'),
              has_dialog: !!document.querySelector('[role="dialog"]'),
              has_composer: !!document.querySelector('[data-testid="new-post-update-placeholder"]'),
              has_posts: !!document.querySelector('[data-testid="posts-list-container"]'),
            });
            let seen = look();
            for (let i = 0; i < 50 && !(seen.has_composer || seen.has_posts); i += 1) {
              await sleep(400);
              seen = look();
            }
            return seen;
          })()`,
        )) as Record<string, boolean>;

        if (!ready.on_item_url || (!ready.has_composer && !ready.has_posts)) {
          return fail(
            "The item card did not open, so there is nothing to act on. " +
              `Saw ${JSON.stringify(ready)}. The board grid itself is a canvas ` +
              "and cannot be read or clicked as DOM.",
          );
        }

        if (action === "read_card") {
          const card = await session.evaluate(
            `(async () => {
              const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
              const count = () => document.querySelectorAll('[data-testid="post-component"]').length;
              // The composer renders before the thread does, so the preflight
              // can pass while the posts are still loading. Wait for the count
              // to stop moving rather than reading the first value seen.
              let last = -1, stable = 0;
              for (let i = 0; i < 30 && stable < 3; i += 1) {
                await sleep(400);
                const now = count();
                stable = now === last ? stable + 1 : 0;
                last = now;
              }
              const posts = [...document.querySelectorAll('[data-testid="post-component"]')]
                .map((p) => (p.innerText || '').trim())
                .filter(Boolean);
              const heading = document.querySelector('[data-testid="editable-heading"]');
              return { url: location.href, name: heading ? heading.innerText.trim() : null,
                       post_count: posts.length, settled: stable >= 3, posts };
            })()`,
          );
          return ok({ ...resolved, action, card });
        }

        // post_update runs in three steps so the text can be typed through the
        // browser's real input pipeline between them: focus, type, then submit.
        const focused = (await session.evaluate(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            // Let the thread finish rendering BEFORE taking the baseline.
            // Counting straight after navigation reads 0, and the existing
            // posts arriving later then look like the post succeeded.
            const count = () => document.querySelectorAll('[data-testid="post-component"]').length;
            let last = -1, stable = 0;
            for (let i = 0; i < 30 && stable < 3; i += 1) {
              await sleep(400);
              const now = count();
              stable = now === last ? stable + 1 : 0;
              last = now;
            }
            const before = count();
            const placeholder = document.querySelector('[data-testid="new-post-update-placeholder"]');
            if (placeholder) { placeholder.click(); await sleep(800); }
            // The composer sits outside [role="dialog"], in its own
            // micro-frontend subtree. Verified live.
            const editor = document.querySelector('[data-testid="new-post-component-container"] [contenteditable="true"]')
              || document.querySelector('[contenteditable="true"]');
            if (!editor) return { ok: false, why: 'No update composer is present on this card.' };
            editor.focus();
            // Unsent text accumulates in the composer and survives a relaunch,
            // so start from empty rather than appending to someone's draft.
            document.execCommand('selectAll', false, null);
            document.execCommand('delete', false, null);
            const sel = window.getSelection();
            if (sel && editor.firstChild !== undefined) {
              const range = document.createRange();
              range.selectNodeContents(editor);
              range.collapse(false);
              sel.removeAllRanges();
              sel.addRange(range);
            }
            return { ok: true, before };
          })()`,
        )) as { ok?: boolean; why?: string; before?: number };

        if (!focused?.ok) {
          return fail(`Could not focus the composer. ${focused?.why ?? ""} Nothing was submitted.`);
        }

        // Real keystrokes, not a DOM mutation: see DesktopSession.insertText.
        await session.insertText(body ?? "");

        const ready2 = (await session.evaluate(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const before = ${focused.before ?? 0};

            // The text was typed through the real input pipeline before this
            // ran. Confirm it actually landed in the editor: if the editor
            // ignored it, submitting would post an empty update.
            const editor = document.querySelector('[data-testid="new-post-component-container"] [contenteditable="true"]')
              || document.querySelector('[contenteditable="true"]');
            if (!editor) return { ok: false, why: 'The composer disappeared before submitting.' };
            const text = (editor.innerText || '').trim();
            if (!text) return { ok: false, why: 'The composer stayed empty, so nothing was submitted.' };

            // The submit control is a DIV, not a <button> — verified live — so
            // a querySelectorAll('button') sweep never sees it. Its testid is
            // stable and specific, which beats matching on visible text.
            const submit = document.querySelector('[data-testid="post-editor-update-button"]')
              || [...document.querySelectorAll('[data-vibe="Button"], button, div[role="button"]')]
                   .find((b) => /^(update|post|send)$/i.test((b.innerText || '').trim()));
            if (!submit) return { ok: false, why: 'No update/submit control found on the composer.', text_present: true };

            // The card panel can extend past the webview: the submit control
            // was measured live at x=1813 in a 1360px viewport, so a mouse
            // event at its coordinates hit nothing at all. Scroll it in and
            // re-measure before trusting any coordinate.
            submit.scrollIntoView({ block: 'center', inline: 'center' });
            await sleep(400);
            const box = submit.getBoundingClientRect();
            const cx = box.left + box.width / 2;
            const cy = box.top + box.height / 2;
            const inViewport = cx >= 0 && cy >= 0 && cx <= innerWidth && cy <= innerHeight;
            const hit = inViewport ? document.elementFromPoint(cx, cy) : null;
            return {
              ok: true, before,
              submit_at: inViewport ? [cx, cy] : null,
              hittable: !!hit && (hit === submit || submit.contains(hit) || hit.contains(submit)),
              viewport: [innerWidth, innerHeight],
              measured: [box.left, box.top, box.width, box.height],
            };
          })()`,
        )) as {
          ok?: boolean;
          why?: string;
          before?: number;
          submit_at?: [number, number] | null;
          hittable?: boolean;
          viewport?: [number, number];
          measured?: number[];
        };

        if (!ready2?.ok) {
          return fail(
            `The update was not submitted. ${ready2?.why ?? ""} The card should be unchanged.`,
          );
        }

        if (ready2.submit_at && ready2.hittable) {
          // A real mouse click: submit is a DIV whose handler can ignore a
          // synthetic element.click().
          await session.clickAt(ready2.submit_at[0], ready2.submit_at[1]);
        } else {
          // The control could not be brought under the pointer, so fall back to
          // a synthetic click rather than clicking blank space.
          const clicked = await session.evaluate(
            `(() => {
              const b = document.querySelector('[data-testid="post-editor-update-button"]');
              if (!b) return false;
              b.click();
              return true;
            })()`,
          );
          if (clicked !== true) {
            return fail(
              "The submit control could not be reached. Measured at " +
                `${JSON.stringify(ready2.measured)} in a ${JSON.stringify(ready2.viewport)} viewport. ` +
                "Nothing was submitted, so the card should be unchanged.",
            );
          }
        }

        // Confirm by CONTENT, not by count. A count that merely rose can be the
        // existing thread finishing its render, which reads as a false success.
        const needle = (body ?? "").trim().slice(0, 40);
        const posted = await session.evaluate(
          `(async () => {
            const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
            const needle = ${JSON.stringify(needle)};
            for (let i = 0; i < 30; i += 1) {
              await sleep(500);
              const posts = [...document.querySelectorAll('[data-testid="post-component"]')]
                .map((p) => (p.innerText || ''));
              if (posts.some((t) => t.includes(needle))) {
                return { ok: true, posts_before: ${ready2.before ?? 0}, posts_after: posts.length };
              }
            }
            return { ok: false, submitted: true, posts_before: ${ready2.before ?? 0},
                     why: 'The submit was clicked but the new text never appeared in the thread within 15s.' };
          })()`,
        );

        const result = posted as { ok?: boolean; why?: string; submitted?: boolean };
        if (!result?.ok) {
          // "submitted" means the click landed and only the confirmation is
          // missing, so the update may well exist. Say so: a blind retry is
          // how a double post happens.
          return fail(
            `The update was not confirmed as posted. ${result?.why ?? ""} ` +
              (result?.submitted
                ? "The submit was clicked, so the update may have saved. Do NOT retry " +
                  "blindly — read the card first, and only repost if it is absent."
                : "Nothing was submitted, so the card should be unchanged."),
          );
        }
        return ok({ ...resolved, action, posted: result });
        });
      }),
  );
}

export { DesktopError };
