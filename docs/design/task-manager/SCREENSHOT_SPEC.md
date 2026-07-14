# Screenshot Spec — Task Manager (ART S01–S24)

**Document class:** SCREENSHOT / VISUAL PROOF SPEC
**Authority:** ART-UX-DIRECTION § EXACT STAGING SCREENSHOT MATRIX
**Status:** PARTIAL real capture (2026-07-14) — 8/24 S-ids + 3 extra nine-IA surfaces
captured against live staging at current HEAD. Remaining 16 S-ids and the loading/error/
stale/keyboard/zoom states are still `NOT SHIPPABLE: no visual proof`. See
`.artifact/art-screenshots-2026-07-14/MANIFEST.md` for capture parameters and findings.

## 1. Capture rules

For each scenario record:

- URL (exact)
- State fixture method + payload hash (if injected)
- Viewport
- Release SHA
- Snapshot / revision / hash
- Time + timezone
- Locale (`id-ID`)
- Role / redaction
- Chromium version + font set

Populated views use **real staging data**. Loading/error/stale may use Playwright network injection only when method/hash are recorded. Component mocks ≠ staging proof.

## 2. Matrix (ART canonical → product route map)

| ID | ART URL | Product route (board-scoped) | Viewport | Intent |
|---|---|---|---|---|
| S01 | `/` | `/b/{board}/` | 1440×900 | Overview fresh |
| S02 | `/` | `/b/{board}/` | 390×844 | Overview mobile |
| S03 | `/work?bucket=DONE` | `/b/{board}/work?bucket=DONE` | 1280×800 | Selesai |
| S04 | `/work?bucket=ONGOING` | `/b/{board}/work?bucket=ONGOING` | 1280×800 | Active owner |
| S05 | `/work?bucket=NEXT` | `/b/{board}/work?bucket=NEXT` | 1280×800 | Next + reason |
| S06 | `/work?bucket=QUEUED` | `/b/{board}/work?bucket=QUEUED` | 1280×800 | Queue |
| S07 | `/work?bucket=BLOCKED` | `/b/{board}/work?bucket=BLOCKED` | 1280×800 | Blocker |
| S08 | `/work?bucket=RECONCILIATION` | `/b/{board}/work?bucket=RECONCILIATION_PENDING` **alias gap** | 390×844 | Reconcile |
| S09 | `/work/<taskId>` | `/b/{board}/tasks/<taskId>` | 1280×800 | Human detail |
| S10 | `/work/<taskId>?mode=technical` | `/b/{board}/tasks/<taskId>?mode=technical` **param gap** | 1280×800 | Technical expand |
| S11 | `/decisions` | `/b/{board}/decisions` | 1280×800 | Decision inbox |
| S12 | `/decisions/<id>` | `/b/{board}/decisions` + detail **route gap** | 390×844 | Decision actions |
| S13 | `/knowledge/domains/AFFILIATE` | **no product route** | 1440×900 | Domain knowledge |
| S14 | same | **no product route** | 390×844 | Domain mobile |
| S15 | `/search?q=…` | shell search only **route gap** | 1280×800 | Semantic result |
| S16 | `/search?q=T-…` | **route gap** | 1280×800 | Technical alias |
| S17 | `/documentation/domains/AFFILIATE` | **route gap** | 1280×800 | Export preview |
| S18 | `/` stale | `/b/{board}/` + stale fixture | 1280×800 | Stale banner |
| S19 | `/work` loading | work + throttle | 1280×800 | Skeleton |
| S20 | `/work` error | work + API fail | 1280×800 | Safe error |
| S21 | knowledge conflict | **route gap** | 1280×800 | Conflict/redact |
| S22 | task keyboard | task detail | 1280×800 | Focus sequence |
| S23 | task zoom 200% | task detail | 1280×800 | Zoom |
| S24 | `/work?query=zero` | work empty query | 320×568 | Empty |

**SCOPE_CONTRADICTION:** ART top-level `/work`, `/knowledge`, `/search` vs product `/b/$boardId/*` nine-IA. Capture only after stable aliases **or** one-to-one map recorded (this table is that map for foundation).

## 3. Additional product surfaces (nine-IA, not ART S-ids)

Capture when visual gate expands:

| Surface | Route | Viewports |
|---|---|---|
| Priority | `/b/{board}/priority` | 1440, 390 |
| Projects | `/b/{board}/projects` | 1440, 390 |
| Features | `/b/{board}/features` | 1440, 390 |
| Agents | `/b/{board}/agents` | 1440, 390 |
| Ops | `/b/{board}/ops` | 1440, 390 |
| Evidence | `/b/{board}/evidence` | 1440, 390 |

## 4. Visual regression gates

- Pinned Chromium / fonts / OS.
- Unexpected `maxDiffPixelRatio` > **0.002** fails.
- Baseline replace only with reviewer receipt.
- Pair proof: Figma/reference path + device/browser shot path (VISUAL_GATE v1).

## 5. This task (2026-07-14 update)

- **8 of 24** S-ids captured for real against live staging (current HEAD, authenticated
  session, real synthetic board data): S01, S02, S03, S07, S11, plus 3 additional nine-IA
  surfaces (Priority, Projects, Agents) from §3. Evidence:
  `.artifact/art-screenshots-2026-07-14/` (PNGs + MANIFEST.md with exact capture params
  per §1 capture rules: URL, release SHA, viewport, browser version, board/fixture).
- **Not captured this pass:** S04-S06, S08-S10, S12-S24 (decision detail, knowledge
  domains, search, documentation export, stale/loading/error network-injection states,
  keyboard focus sequence, 200% zoom, empty query) — most of these also have the
  documented **route gap** in §2 (no product route yet) and cannot be captured until that
  gap closes.
- Real finding from the captured set: the token/CSS/IA visual foundation is genuinely
  live and coherent (light-first, no reject-list violations, working id-ID aliases,
  clean 390px reflow). The visible gap is in **content**, not styling — raw technical
  enum/error strings (`CONTENT_REVIEW_REQUIRED`, `DATA_INTEGRITY: ...`,
  `productDenominator=0 ...`) render directly as primary user-facing copy on the
  Overview/Priority screens instead of going through the `humanDisplay` contract. See
  MANIFEST.md for the full finding.
- Status remains **LOCAL ONLY** overall (majority of matrix still has zero visual proof)
  but is no longer `NOT SHIPPABLE: no visual proof` in the literal zero-capture sense —
  use `PARTIAL: 8/24 real, remainder unproven` going forward.
