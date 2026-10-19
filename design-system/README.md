# monday-mcp design system

The patch bay is the concept. An MCP server is a cable between an agent and monday.com, so the identity uses jacks, cables and plain type. The project runs on the user's machine, and the look shows that: it is a tool you connect, not a site you visit. The landing page has one job: explain what the cable does and send the reader to the setup steps.

> **Unofficial. Not affiliated with monday.com.** This system uses no monday.com logo, no monday.com purple and no monday.com coloured dots. "monday.com" is a trademark of monday.com Ltd.

Status: **new**. No visual identity existed in the repository before this system. Every value below comes from the owner brief of 2026-10-18 (`design-systems/profiles/monday-mcp.json`, `identity`). The repository has no CSS, fonts, logo files or design tokens.

## Voice

1. **Say what runs where.** "It runs on your machine and speaks straight to the monday.com GraphQL API." (`README.md:9`)
2. **Keep the token claim plain.** "Your token stays on your machine." (`README.md:9-10`)
3. **Name what is absent.** "No relay, no hosted middle layer, no telemetry." (`README.md:10`)
4. **State the trademark once, in full.** "This project is not built by monday.com, and it carries no endorsement from monday.com." (`README.md:12-13`)
5. **Use short sentences and active verbs.** "npm install          # this also builds, through the prepare script" (`README.md:150`). Avoid marketing words.

## Colour

| Token | Value | Role | Contrast |
|---|---|---|---|
| `paper` | #f5f6f8 | Page ground | Ground for all text pairs |
| `ink` | #1d2433 | Headings and body text | 14.4:1 on `paper` |
| `cable-teal` | #1f6f78 | Primary action fill, link text | 5.4:1 on `paper` |
| `patch-orange` | #d9661f | Patch-bay jacks, orange block. Non-text only | 3.3:1 on `paper` (non-text only) |
| `orange-ink` | #9c4310 | Unofficial notice text | 6.0:1 on `paper` |
| `muted` | #5b6474 | Secondary text | 5.5:1 on `paper` |
| `rule` | #d5d9e0 | Hairlines between blocks. Non-text only | 1.3:1 on `paper` (non-text only) |

Text pairs meet 4.5:1. `patch-orange` and `rule` fall below 4.5:1, so they are used for non-text only. Action text on `cable-teal` uses `paper`. Check: `python3 -I ~/ashcode/design-systems/extract/contrast.py design-system`.

## Type

- **Display and text:** Schibsted Grotesk, weights 700 and 400. Hosted by Google Fonts, so there is no font file in the system. Source: https://fonts.google.com/specimen/Schibsted+Grotesk
- **Code:** JetBrains Mono, weight 400. Used for commands only. Source: https://fonts.google.com/specimen/JetBrains+Mono

| Style | Family | Size / line | Weight | Used for |
|---|---|---|---|---|
| `display` | sans | 64 / 68 px | 700 | Hero name, cover name |
| `heading` | sans | 28 / 34 px | 700 | Section headings |
| `body` | sans | 18 / 28 px | 400 | Hero sub-line, body copy |
| `small` | sans | 14 / 22 px | 400 | Cover tagline, notices, footer |
| `wordmark` | sans | 22 / 26 px | 700 | Lowercase `monday-mcp` wordmark |
| `command` | mono | 15 / 22 px | 400 | Shell commands such as `npm install` |

## Layout and spacing

- Maximum content width: 1040 px for the Hero. The cover is fixed at 960 px.
- Phone width: 16 px side gutter, no horizontal scroll.
- Spacing steps: `space-1` 8 px, `space-2` 16 px, `space-3` 24 px, `space-4` 40 px.
- Radius: `radius-sm` 4 px (command panel), `radius-md` 8 px (panels), `radius-pill` 999 px (renders as half the short side; used for jacks and buttons).

## Logo and wordmark

- **No logo file exists.** The repository has no image files (`README.md`, `package.json`, `src/`, `test/` checked). `assets/Logos/` therefore holds only its README.
- **Wordmark:** the lowercase text `monday-mcp`, Schibsted Grotesk 700, no tracking, in `ink` on `paper`.
- **Clear space:** one width of the letter `m` on every side.
- **Minimum size:** 16 px tall text. Below that, use the command style for the name.
- **Do not:** add a monday.com logo, purple, coloured dots, a shadow, or a gradient to the wordmark. Do not set it in capitals.

## Landing page anatomy

The landing page is the README front door. This system defines its first screen only.

1. **Bar:** the wordmark at left, one `cable-teal` text link to the setup at right.
2. **Hero:** name in `display`, the promise in `body`, one action "Read the setup" as a `cable-teal` pill.
3. **Cable diagram:** three `radius-pill` jacks joined by one rule line: MCP client, `monday-mcp`, `api.monday.com`. Labels use the `small` style. Source: `README.md:16-20`.
4. **Command panel:** the two setup commands from `README.md:149-150` (`cd monday-mcp`, `npm install`, after the clone at `README.md:148`) in `command` on `paper`, inside a `rule` border with `radius-sm`.
5. **Footer:** the unofficial notice in `orange-ink`, and the licence (MIT, `package.json:5`).

See `components/Hero/README.md` for the component and `components/Cover/preview.html` for the cover card.

## Status

`new`. No visual identity existed before this system. The identity follows the owner brief of 2026-10-18. Sources are listed in `SOURCES.md`.
