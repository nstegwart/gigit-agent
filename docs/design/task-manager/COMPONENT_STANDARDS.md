# Component Standards — Task Manager

**Document class:** COMPONENT STANDARDS (+ interaction notes)
**Authority:** ART-UX-DIRECTION + UI_CONTRACT
**Tokens:** `design/tokens/task-manager.tokens.json`
**CSS class API:** preserved in `src/styles.css` (do not rename public classes without a migration task)

## 1. Principles

1. **Class API stability** — existing selectors (`.card`, `.btn`, `.tag`, `.run`, `.nav-item`, …) keep names; only token values and foundation type/weight/gradient policy change.
2. **Token-only color** — no new ad-hoc hex in product CSS; use `var(--*)` from the foundation map.
3. **Four-cue status** — text + icon + color pair + shape; never a lone colored dot.
4. **Human first** — primary copy is human title/outcome; technical IDs in quiet footer/expander.
5. **One primary action** per card.
6. **No decorative gradients / glass / pulse** as status language.

## 2. Surface hierarchy

| Layer | Token | Typical classes |
|---|---|---|
| Canvas | `--bg` | `body`, `.main`, `.home` |
| Surface | `--surface` | `.card`, `.sidebar`, `.topbar`, tables hover |
| Subtle | `--surface-2` | nested panels, form fields, chips |
| Chrome | `--surface-3` | counts, tags default |
| Border | `--border` / `--border-soft` | 1px rules |

Nested card-on-card depth **≤ 2** visual surfaces.

## 3. Controls

| Control | Radius | Min target | Focus |
|---|---|---|---|
| Buttons `.btn` / `.icon-btn` | `--r-sm` (8px) | 44×44 mobile; 36 desktop icon | `--focus-ring` outline |
| Inputs `.field` / `.search` | `--r-sm` | 36–44 height | border + soft ring |
| Pills `.tag` / status badges | pill radius | text ≥ 11px chrome only | not sole status signal |
| Nav items | `--r-sm` | 44×44 @ ≤900px | visible focus |

Weights: UI emphasis 500–600; never >600.

## 4. Cards & tables

- **Cards** for narrative decisions/outcomes (flexible height; never truncate blocker/owner action).
- **Tables** for repeated comparable fields: sticky headers, keyboard sort state, pagination, horizontal containment.
- At ≤767px: core rows → labelled key-value cards; wide technical tables → explicit contained scroller.

## 5. Status components

| Bucket | FG/BG tokens | Left-rule / shape (CSS target) |
|---|---|---|
| DONE / Selesai | `--done` / `--done-bg` | solid 3px left |
| ONGOING | `--ongoing` / `--ongoing-bg` | double left |
| NEXT | `--next` / `--next-bg` | outlined / notch |
| QUEUED | `--queued` / `--queued-bg` | dashed left |
| BLOCKED | `--blocked` / `--blocked-bg` | solid border + reason text |
| RECONCILIATION | `--reconcile` / `--reconcile-bg` | striped / outlined |

Aliases preserved: `--ok`→done, `--info`→ongoing, `--parked`→queued, `--warn`→reconcile.

## 6. Interaction notes (microinteraction)

| Event | Duration | Easing |
|---|---|---|
| hover / focus / press | 120–160ms | ease-out entry |
| expand / collapse | 160–200ms | ease |
| drawer / page context | 200–240ms | ease |
| max without functional reason | ≤300ms | — |

`prefers-reduced-motion: reduce` → transitions 0–80ms / no transform; kill `.blink` / pulse animations (shell rules already present).

**Forbidden motion:** pulsing live status as permanent language, parallax, shimmer after load, confetti, auto-carousel.

## 7. Empty / loading / error / stale

| State | Standard |
|---|---|
| Empty | explain no work vs no result vs no permission + safe action |
| Loading | skeleton matching final layout; no fake metrics |
| Error | human cause/impact/retry; trace ID secondary |
| Stale | amber banner (`--warn` / `--warn-bg`) with last valid time + refresh |
| Conflict | both sources; block certainty |

## 8. Out of scope this foundation

Component TSX files are **not** modified. Module CSS hex cleanup is residual. Four-cue shapes need component pass.
