# Screenshot Spec — Task Manager (ART S01–S24)

**Document class:** SCREENSHOT / VISUAL PROOF SPEC
**Authority:** ART-UX-DIRECTION § EXACT STAGING SCREENSHOT MATRIX
**Status:** SPEC ONLY this task — **no captures** → `NOT SHIPPABLE: no visual proof`

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

## 5. This task

- **Zero** screenshots captured.
- Token/CSS foundation only.
- Final status must remain **LOCAL ONLY** with literal `NOT SHIPPABLE: no visual proof`.
