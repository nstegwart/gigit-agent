# Before / After — Task Manager ART Foundation

**Document class:** BEFORE / AFTER MATCHED-VIEW COMPARISON
**Authority:** ART-UX-DIRECTION 01B § REQUIRED ARTIFACTS
**Related:** `BRAND_DESIGN_SYSTEM_AUDIT.md`, `ART_DIRECTION.md`, `RESPONSIVE_SCREENSHOT_MANIFEST.md`
**Status:** Design-system + capture-era comparison. Not a claim that Part 1 human content is done.

## 1. Comparison axis

| Axis                  | BEFORE (pre–ART foundation)                   | AFTER (foundation + S01–S24 captures)                          |
| --------------------- | --------------------------------------------- | -------------------------------------------------------------- |
| Action color          | Purple accent `#4f3fd4` dominant              | ART fallback blue `#175CD3` (`--accent`)                       |
| Color mode            | Incomplete dark + `prefers-color-scheme` risk | Light-first reasserted for all themes                          |
| Body type             | Historically ~14px dense                      | **16px / 1.5** body contract (`ART_DIRECTION.md`)              |
| Canvas                | Mixed / hero gradient risk                    | `#F7F8FA` canvas; `--bg-hero: none`                            |
| Status language       | Color-heavy / possible lone dots              | Token FG/BG pairs + documented four-cue (shape residual)       |
| Brand kit             | Sample TanStack logos + invented BrandMark    | Fail-closed: **no approved MFS/Cairn kit**; no logo alteration |
| Token source of truth | Ad-hoc CSS vars only                          | `design/tokens/task-manager.tokens.json` + CSS map             |
| Screenshot matrix     | Missing / partial narrative                   | **24/24 S-ids** unified in `RESPONSIVE_SCREENSHOT_MANIFEST.md` |
| Route map ART↔product | Unclear gaps claimed                          | Board-scoped aliases documented; S12–S17 routes proven live    |

## 2. Matched views (same product surface)

### 2.1 Overview — desktop (S01)

|                | BEFORE                                    | AFTER (evidence)                                                                                   |
| -------------- | ----------------------------------------- | -------------------------------------------------------------------------------------------------- |
| Surface        | Generic admin density risk; purple chrome | Light editorial control center; blue action                                                        |
| Proof          | No matrix ID                              | `.artifact/art-screenshots-2026-07-14/S01-overview-1440x900.png`                                   |
| Residual after | —                                         | Technical enums still leak into owner copy (`CONTENT_REVIEW_REQUIRED`, `DATA_INTEGRITY` sentences) |

### 2.2 Overview — mobile (S02)

|          | BEFORE                                     | AFTER                                      |
| -------- | ------------------------------------------ | ------------------------------------------ |
| Layout   | Product shell @900/560; risk of dense rail | Captured 390×844 reflow; stacked narrative |
| Proof    | —                                          | `S02-overview-390x844.png`                 |
| Residual | ART 767 breakpoint ≠ product 900           | Documented in `RESPONSIVE_BEHAVIOR.md`     |

### 2.3 Work — BLOCKED vs empty buckets

| View                          | BEFORE risk              | AFTER capture                                | Residual                                  |
| ----------------------------- | ------------------------ | -------------------------------------------- | ----------------------------------------- |
| BLOCKED (S07)                 | Color-only status        | Icon + pill + label (partial four-cue)       | Shape left-rule incomplete in places      |
| ONGOING/NEXT/QUEUED (S04–S06) | Fake populated mock risk | Honest **empty** buckets on pin              | Fail-closed DATA_INTEGRITY classification |
| RECONCILIATION (S08)          | Route/alias ambiguity    | Product `RECONCILIATION_PENDING` + ART alias | Empty on pin                              |

### 2.4 Task detail human vs technical (S09 / S10)

|           | BEFORE                           | AFTER                                       |
| --------- | -------------------------------- | ------------------------------------------- |
| Default   | Technical IDs compete with title | Human-first default captured                |
| Technical | Unclear mode path                | `?mode=technical` expands IDs (S10)         |
| Residual  | —                                | Titles may still show review-required enums |

### 2.5 Decisions (S11 / S12)

|               | BEFORE                | AFTER                                             |
| ------------- | --------------------- | ------------------------------------------------- |
| Inbox         | Present in nine-IA    | S11 desktop capture                               |
| Detail mobile | Often claimed missing | S12 route **exists**; 390 capture                 |
| Residual      | —                     | Card titles/pills may still show raw review codes |

### 2.6 Knowledge / Search / Documentation (S13–S17)

|         | BEFORE (doc claim)               | AFTER (live + PNG)                                        |
| ------- | -------------------------------- | --------------------------------------------------------- |
| Routes  | Often “route gap” in older notes | Product routes HTTP 200; PNGs on disk                     |
| Content | n/a                              | AFFILIATE domain **unavailable** honestly (not mock-rich) |
| Search  | gap                              | S15 semantic + S16 technical alias captures               |

### 2.7 System states (S18–S20, S24)

| State       | BEFORE   | AFTER                           |
| ----------- | -------- | ------------------------------- |
| Stale       | Unproven | S18 fixture + banner            |
| Loading     | Unproven | S19 skeleton under throttle     |
| Error       | Unproven | S20 safe error + code secondary |
| Empty query | Unproven | S24 @ 320×568                   |

### 2.8 A11y interaction shots (S22 / S23)

|           | BEFORE   | AFTER               | Residual                     |
| --------- | -------- | ------------------- | ---------------------------- |
| Keyboard  | Unproven | S22 Tab×8 end-state | No multi-frame filmstrip     |
| Zoom 200% | Unproven | S23 CSS zoom=2      | Not full browser chrome zoom |

## 3. Token / contrast before → after

| Pair class             | BEFORE                             | AFTER (foundation program)                                                                   |
| ---------------------- | ---------------------------------- | -------------------------------------------------------------------------------------------- |
| Body text on surface   | Mixed / unaudited                  | ≥4.5:1 program PASS (`.artifact/art-token-contrast-proof.json`)                              |
| Status FG on status BG | Incomplete pairs                   | done/ongoing/next/queued/blocked/reconcile pairs                                             |
| Focus ring             | Variable                           | `#2E90FA` ≥3:1 non-text UI                                                                   |
| Token enforcement      | No deterministic repo-wide scanner | Scanner covers all `src/**/*.css`; 19 contrast pairs and exact residuals are program-emitted |

Reviewer metadata on tokens remains **`pending`**.

## 4. IA / copy before → after

| Topic             | BEFORE                            | AFTER                                                                    |
| ----------------- | --------------------------------- | ------------------------------------------------------------------------ |
| Primary nav       | Nine English IA (parent contract) | **Unchanged** (no silent five-nav collapse)                              |
| ART id-ID aliases | Scattered                         | Documented in audit + `SCREEN_COPY_INVENTORY.md`                         |
| humanDisplay      | Missing → raw IDs                 | Still incomplete → CONTENT_REVIEW_REQUIRED fallbacks visible in captures |

**Important:** Visual token AFTER does **not** equal content-contract AFTER. Captures deliberately show remaining content gaps.

## 5. Artifact completeness before → after

| ART required path                        | BEFORE this task (TM-09)                | AFTER TM-09                         |
| ---------------------------------------- | --------------------------------------- | ----------------------------------- |
| `BRAND_DESIGN_SYSTEM_AUDIT.md`           | present                                 | present                             |
| `ART_DIRECTION.md`                       | present (path map pointed at stand-ins) | present                             |
| `design/tokens/task-manager.tokens.json` | present                                 | present                             |
| `COMPONENT_INVENTORY.md`                 | **missing** (mapped to standards only)  | **written**                         |
| `INTERACTION_NOTES.md`                   | **missing** (section only)              | **written**                         |
| `RESPONSIVE_SCREENSHOT_MANIFEST.md`      | **missing** (split folder MANIFESTs)    | **unified S01–S24**                 |
| `BEFORE_AFTER.md`                        | **missing**                             | **written**                         |
| `SCREENSHOT_SPEC.md`                     | present partial                         | updated pointer to unified manifest |

## 6. Explicit non-claims

- Not FABLE xhigh resolution.
- Not independent visual/accessibility verifier PASS on HEAD.
- Not production / `task-manager.mfsdev.net`.
- Not single-SHA full matrix recapture (prior `e23ff1cc…` + wave1 `867b9b57…`).
- Not “human content DONE” — enum leaks and empty buckets are residual.
- Not dark-mode ship.
- Not zero token drift: **1,245** exact residuals remain, including **747** in nine CSS paths forbidden to UI-B6.

## 7. Summary sentence

**Before:** purple/incomplete-dark admin foundation, partial or absent ART required docs, screenshots split without a single S01–S24 machine index.
**After:** light editorial tokens, required ART design docs present, unified responsive screenshot manifest indexing 24/24 real PNGs with honest content residuals.

## 8. UI-B6 delta (2026-07-15)

| Item                 | Before UI-B6                                 | After UI-B6                                                   | Proof / residual                                                   |
| -------------------- | -------------------------------------------- | ------------------------------------------------------------- | ------------------------------------------------------------------ |
| Authority binding    | Human-readable file reference                | Exact SHA-256 in token metadata                               | `4eca14e115223ca4be02ec767dca0a32fb3e104dc4a512ebbc99374f93cddcee` |
| Type / motion tokens | JSON scale without complete CSS variable map | Paired type variables and 120/140/180/220/300/80ms motion map | token lint PASS                                                    |
| Focus                | mixed accent/focus usage                     | shell focus uses `--focus-ring`; 3.24:1 non-text contrast     | contrast program                                                   |
| Status motion        | global pulse keyframe                        | stable double-outline cue; no global pulse                    | global lint residual 0                                             |
| Decorative gradient  | editorial headers used gradients             | global editorial headers use opaque token surfaces            | global lint residual 0                                             |
| Raw colors           | raw literals outside token block             | zero raw-color findings in `src/styles.css`                   | lint                                                               |
| Full CSS adoption    | uncounted                                    | 1,245 exact numeric/color/motion residuals                    | default lint exits non-zero; no suppression                        |

NOT SHIPPABLE: no visual proof
