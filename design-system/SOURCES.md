# Sources

Every file read to build this system, and what came from it. Project root: `monday-mcp` (repo root).

| File | Lines read | What came from it |
|---|---|---|
| `design-systems/profiles/monday-mcp.json` | all | Scope, audience, no existing identity, no logo files, classification `new_needed` |
| `design-systems/SPEC.md` | all | Layout rules, tokens.json grammar, preview contract, ashcode build rules |
| `README.md` | 1-40, 141-150, 473-478 | Concept (no visual identity), product facts (lines 9-10), unofficial notice (lines 12-13), the cable diagram (lines 16-20), the install command (line 150), the security claim (line 475) |
| `package.json` | 1-20 | Package name, description, MIT licence (line 5), CLI bin (lines 11-12) |
| `src/config.ts` | 35-42 | API base URL `https://api.monday.com/v2` (line 39). Used only as a product fact |
| `LICENSE` | 1 | MIT licence name |
| `design-systems/evidence/monday-mcp.json` via `extract/digest.py` | digest output | 29 files scanned. No colours, fonts, logos or design files in the project |

## Values from the owner brief (not from code)

These come from the owner brief of 2026-10-18, not from project files:

- Colours: `paper`, `ink`, `cable-teal`, `patch-orange`, `orange-ink`, `muted`, `rule`.
- Type: Schibsted Grotesk (700, 400) and JetBrains Mono (400). Concept and wordmark.
- Spacing and radii: four spacing steps and three radii, chosen to fit the pill motif.
- Cover pattern: pills (patch-bay jacks in rows, radius half the short side).

## Not used

- `test/fake-monday.ts:23-24` holds two test hex values (`#037f4c`, `#579bfc`). These are fixture data, not brand colours. Not used.
- No secrets, `.env` files, tokens, personal data or account data were read or copied.
