# Brand & Design-System Audit — Task Manager

**Document class:** BRAND AUDIT (ART gate 1)
**Authority:** `ART-UX-DIRECTION.md` § BRAND AND DESIGN-SYSTEM AUDIT
**Workspace:** `gigit-project-orchestration`
**Audit date:** 2026-07-15 reconciliation
**Status:** FALLBACK DECISION COMPLETE; TOKEN CLEANUP BLOCKED BY WRITE FENCE

## 1. Purpose

Inspect approved Myfitsociety / Cairn brand assets and current task-manager design primitives before applying tokens. Record source path, owner, version/hash, license, approved use, accessibility finding, reuse decision, and gap.

## 2. Inventory

| Asset / area            | Source path                                         | Owner / system      | Version / hash (this audit)                    | License | A11y finding                                                               | Reuse decision                                                                  |
| ----------------------- | --------------------------------------------------- | ------------------- | ---------------------------------------------- | ------- | -------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| Task-manager CSS tokens | `src/styles.css`                                    | this repo           | live file; remapped 2026-07-14 to ART fallback | product | Prior purple action `#4f3fd4`; body 14px; hero gradient; incomplete dark   | **Replace with ART fallback** (see tokens JSON)                                 |
| Token JSON              | `design/tokens/task-manager.tokens.json`            | this repo           | `1.1.0-ui-b6`; authority SHA `4eca14e1…`       | product | Programmatic contrast metadata checked                                     | **Reuse + reconcile**                                                           |
| UI font                 | system stack in CSS                                 | OS                  | n/a                                            | system  | Inter named but system-first historically                                  | **ART fallback stack:** Inter, ui-sans-serif, system-ui…                        |
| Icons                   | `src/lib/icons.tsx`, `SemanticIcon.tsx`             | this repo           | product                                        | product | Inline SVG; theme-aware strokes                                            | **Reuse** shapes; color via tokens only                                         |
| lucide-react            | `package.json`                                      | dependency          | installed                                      | ISC     | **0 product imports** (audit)                                              | Do not introduce without inventory update                                       |
| BrandMark               | `src/lib/icons.tsx` `BrandMark`                     | invented SVG        | product                                        | product | Not an approved logo                                                       | **Do not treat as approved logo**; do not recolor/crop                          |
| Public logos            | `public/logo192.png`, `logo512.png`, `favicon.ico`  | CRA/TanStack sample | sample                                         | sample  | Manifest title “Create TanStack App Sample”                                | **Not approved MFS/Cairn** — gap                                                |
| Myfitsociety brand kit  | **not in this workspace**                           | external            | unknown                                        | unknown | n/a                                                                        | **Cannot reuse** — fail closed to fallback                                      |
| Cairn brand kit         | **not in this workspace**                           | external            | unknown                                        | unknown | n/a                                                                        | **Cannot reuse** — fail closed to fallback                                      |
| Tailwind v4             | `@import "tailwindcss"` in `styles.css`             | dependency          | ^4.1.18                                        | MIT     | Class-CSS dominant over utility                                            | Keep import; product chrome stays CSS vars                                      |
| Theme state             | `src/store/ui.ts`; AppShell `initTheme()` boot call | product             | product                                        | product | Store supports persisted/URL/auto modes; AppShell renders no theme control | **Light-first lock in CSS**; document initialization without inventing a toggle |
| Breakpoints (product)   | `styles.css` `@media (max-width: 900px)`, `560px`   | product             | product                                        | product | Mobile shell 44×44 targets present                                         | Document vs ART 767/1199/1200 grid                                              |
| Status semantics        | CSS `--ok/--blocked/--warn/--info/--done/--parked`  | product             | pre-ART                                        | product | Color-only risk if icons missing                                           | Map to ART FG/BG pairs + four-cue note                                          |

## 3. Conflicts (fail closed)

| Conflict                                                      | Parties                                                          | Resolution                                                                  |
| ------------------------------------------------------------- | ---------------------------------------------------------------- | --------------------------------------------------------------------------- |
| Purple action vs ART blue action                              | Prior `--accent: #4f3fd4` vs ART `#175CD3`                       | **ART fallback wins** — no approved purple brand source                     |
| Persisted/URL/auto theme state vs light-first incomplete dark | `initTheme` / `applyTheme` vs ART COLOR_MODE; no AppShell toggle | **Light tokens reasserted** for all theme states until full parity          |
| Sample TanStack logos vs “approved logo”                      | public/* vs ART logo rule                                        | **No logo alteration**; mark as non-brand sample                            |
| ART 5-nav id-ID vs parent nine-IA English                     | ART shell vs `UI_CONTRACT` / AppShell                            | **Documented conflict** — see §5 and `ART_DIRECTION.md`; no silent collapse |

## 4. Gap list (open)

1. No approved MFS/Cairn binary brand kit / hashes / licenses in tree.
2. BrandMark is invented; public icons are framework samples.
3. Deterministic lint reports **747 exact residuals across nine module CSS files outside the UI-B6 write fence**; no suppression was added.
4. Dark mode product parity (routes, charts, evidence, focus, screenshots) **not** proven.
5. Reviewer field on all fallback tokens remains **`pending`**.
6. Four-cue status (text+icon+color+shape) not fully implemented in components (CSS foundation only).
7. `src/styles.css` retains **498** legacy numeric declarations: 178 off-scale type sizes, 296 off-scale spacing values, and 24 off-scale radii. Its raw colors, decorative gradients, pulsing statuses, and motion-over-300ms residuals are zero.

## 5. Nine-IA vs id-ID owner aliases (explicit conflict)

**Parent UI contract (authoritative IA for control-center board `mfs-rebuild`):** nine English primary screens — Overview, Work, Priority, Projects, Features/Flows, Agents/Runs, Ops/Accounts, Decisions, Evidence/Audit (`docs/control-center/UI_CONTRACT.md` §2; `AppShell.tsx` `CONTROL_CENTER_NAV_LABELS`).

**ART-UX shell (owner language direction):** five id-ID destinations — Ringkasan, Pekerjaan, Keputusan, Pengetahuan, Operasi (`ART-UX-DIRECTION.md` APP SHELL).

| ART id-ID alias | Closest nine-IA English surface(s)               | Notes                                                                        |
| --------------- | ------------------------------------------------ | ---------------------------------------------------------------------------- |
| Ringkasan       | Overview                                         | 1:1 intent                                                                   |
| Pekerjaan       | Work (+ task detail drill-down)                  | ART buckets map to Work tabs                                                 |
| Keputusan       | Decisions                                        | 1:1 intent                                                                   |
| Pengetahuan     | _no dedicated nav item_                          | Knowledge/domain is ART route; parent may host under Features/docs — **gap** |
| Operasi         | Ops / Accounts (+ Agents/Runs, Evidence partial) | Split across multiple nine-IA items                                          |

**Decision for this foundation task:** preserve existing **nine-IA class/route API** (no AppShell edit). id-ID labels are **owner aliases** for copy and future i18n — not a silent nav reduction. SCOPE_CONTRADICTION recorded for orchestrator: ART five-nav is additive documentation, not a replace of parent nine-IA without a separate IA change task.

## 6. Reuse decision summary

| Decision                                              | Rationale                                   |
| ----------------------------------------------------- | ------------------------------------------- |
| Apply ART **fallback** color/type/space/radius tokens | No approved brand tokens found              |
| Keep CSS variable **names** used by class API         | Avoid component blast radius                |
| Light-first; neutralize incomplete dark               | ART COLOR_MODE                              |
| Do not invent/alter logo assets                       | ART brand rule                              |
| reviewer / replacementOwner / reviewDate              | **pending** until independent design review |

## 7. Evidence pointers

- Token file: `design/tokens/task-manager.tokens.json`
- Deterministic lint: `node scripts/design-token-lint.mjs --tokens-only --summary`
- Exact unsuppressed residual list: `node scripts/design-token-lint.mjs` (non-zero until the scope contradiction is resolved)
- Unit contract: `node --test tests/unit/design-token-lint.test.ts`
- CSS entry: `src/styles.css`
- Authority: `ART-UX-DIRECTION.md` L527–616

## 8. UI-B6 deterministic reconciliation receipt

Program output on 2026-07-15:

| Check                                                                              | Result                                                                   |
| ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------ |
| Pinned authority SHA-256                                                           | `4eca14e115223ca4be02ec767dca0a32fb3e104dc4a512ebbc99374f93cddcee`       |
| Token issues                                                                       | **0**                                                                    |
| Contrast pairs recomputed                                                          | **19**; normal text or non-text UI threshold satisfied per declared role |
| Global stylesheet raw color / decorative gradient / pulsing status / >300ms motion | **0 / 0 / 0 / 0**                                                        |
| Global numeric scale residuals                                                     | **498** exact rows                                                       |
| Out-of-fence module residuals                                                      | **747** exact rows across nine files                                     |

`SCOPE_CONTRADICTION: CSS_PATHS_OUTSIDE_UI_B6_WRITE_FENCE` — achieving repo-wide zero requires edits to `src/components/control-center/**/*.css`, which this packet explicitly forbids.
