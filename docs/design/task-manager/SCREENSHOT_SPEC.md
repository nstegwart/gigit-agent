# Screenshot Spec — Task Manager (ART S01–S24)

**Document class:** SCREENSHOT / VISUAL PROOF SPEC
**Authority:** ART-UX-DIRECTION § EXACT STAGING SCREENSHOT MATRIX
**Status:** PARTIAL→NEAR-COMPLETE real capture (2026-07-14 wave1) — **24/24 S-ids** have at least one
real PNG against live staging at HEAD `867b9b57cccfe79aebbd6b8858aac52e624241f4`.
Prior folder: `.artifact/art-screenshots-2026-07-14/` (S01,S02,S03,S07,S11 + 3 nine-IA extras).
Wave1 folder: `.artifact/art-screenshots-wave1/` (S04–S06,S08–S10,S12–S24 + MANIFEST.md).
Content-quality gaps remain (empty buckets under DATA_INTEGRITY fail-closed, AFFILIATE domain
unavailable, S21 conflict UI not distinct) — see residual notes below. Status is **FUNCTIONAL
visual proof of routes**, not “content-complete / ship-ready UX”.

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

| ID | ART URL | Product route (board-scoped) | Viewport | Intent | Capture status |
|---|---|---|---|---|---|
| S01 | `/` | `/b/{board}/` | 1440×900 | Overview fresh | CAPTURED (2026-07-14 prior) |
| S02 | `/` | `/b/{board}/` | 390×844 | Overview mobile | CAPTURED (prior) |
| S03 | `/work?bucket=DONE` | `/b/{board}/work?bucket=DONE` | 1280×800 | Selesai | CAPTURED (prior) |
| S04 | `/work?bucket=ONGOING` | `/b/{board}/work?bucket=ONGOING` | 1280×800 | Active owner | CAPTURED wave1 (empty bucket — all tracked → BLOCKED) |
| S05 | `/work?bucket=NEXT` | `/b/{board}/work?bucket=NEXT` | 1280×800 | Next + reason | CAPTURED wave1 (empty bucket) |
| S06 | `/work?bucket=QUEUED` | `/b/{board}/work?bucket=QUEUED` | 1280×800 | Queue | CAPTURED wave1 (empty bucket) |
| S07 | `/work?bucket=BLOCKED` | `/b/{board}/work?bucket=BLOCKED` | 1280×800 | Blocker | CAPTURED (prior) |
| S08 | `/work?bucket=RECONCILIATION` | `/b/{board}/work?bucket=RECONCILIATION_PENDING` (alias `RECONCILIATION` also accepted) | 390×844 | Reconcile | CAPTURED wave1 (empty bucket) |
| S09 | `/work/<taskId>` | `/b/{board}/work/<taskId>` | 1280×800 | Human detail | CAPTURED wave1 |
| S10 | `/work/<taskId>?mode=technical` | `/b/{board}/work/<taskId>?mode=technical` | 1280×800 | Technical expand | CAPTURED wave1 (`mode=technical` works) |
| S11 | `/decisions` | `/b/{board}/decisions` | 1280×800 | Decision inbox | CAPTURED (prior) |
| S12 | `/decisions/<id>` | `/b/{board}/decisions/<id>` | 390×844 | Decision actions | CAPTURED wave1 — **route gap CLOSED** |
| S13 | `/knowledge/domains/AFFILIATE` | `/b/{board}/knowledge/domains/AFFILIATE` | 1440×900 | Domain knowledge | CAPTURED wave1 — **route gap CLOSED** (content unavailable) |
| S14 | same | same | 390×844 | Domain mobile | CAPTURED wave1 — **route gap CLOSED** |
| S15 | `/search?q=…` | `/b/{board}/search?q=…` | 1280×800 | Semantic result | CAPTURED wave1 — **route gap CLOSED** |
| S16 | `/search?q=T-…` | `/b/{board}/search?q=…` | 1280×800 | Technical alias | CAPTURED wave1 — **route gap CLOSED** |
| S17 | `/documentation/domains/AFFILIATE` | `/b/{board}/documentation/domains/AFFILIATE` | 1280×800 | Export preview | CAPTURED wave1 — **route gap CLOSED** |
| S18 | `/` stale | `/b/{board}/` + stale fixture | 1280×800 | Stale banner | CAPTURED wave1 (Playwright SSR/`_serverFn` rewrite) |
| S19 | `/work` loading | work + throttle | 1280×800 | Skeleton | CAPTURED wave1 (fetch delay) |
| S20 | `/work` error | work + API fail | 1280×800 | Safe error | CAPTURED wave1 (`envelope.error` seroval fixture) |
| S21 | knowledge conflict | `/b/{board}/knowledge/domains/AFFILIATE` | 1280×800 | Conflict/redact | CAPTURED wave1 as domain surface only — **no dedicated conflict UI** |
| S22 | task keyboard | task detail | 1280×800 | Focus sequence | CAPTURED wave1 (Tab×8 end-state, not filmstrip) |
| S23 | task zoom 200% | task detail | 1280×800 | Zoom | CAPTURED wave1 (CSS zoom=2) |
| S24 | `/work?query=zero` | work empty query | 320×568 | Empty | CAPTURED wave1 |

**SCOPE_CONTRADICTION:** ART top-level `/work`, `/knowledge`, `/search` vs product `/b/$boardId/*` nine-IA. Capture uses the board-scoped map above (foundation).

### Route-gap verification (wave1, live stack)

Old matrix rows claiming “route gap / no product route” for S12–S17/S21 were **stale**. Verified on
`http://127.0.0.1:33211` (SHA `867b9b57…`) with authenticated session:

| ID | Route file | Live proof |
|---|---|---|
| S12 | `src/routes/b.$boardId.decisions.$decisionId.tsx` | HTTP 200 + decision detail UI for `dec-v3-001` |
| S13/S14/S21 | `src/routes/b.$boardId.knowledge.domains.$domain.tsx` | HTTP 200 + domain surface (honest unavailable for AFFILIATE) |
| S15/S16 | `src/routes/b.$boardId.search.tsx` | HTTP 200 + search results for `q=checkout` / `q=task-ongoing-1` |
| S17 | `src/routes/b.$boardId.documentation.domains.$domain.tsx` | HTTP 200 + documentation domain surface |
| S09/S10 | `src/routes/b.$boardId.work.$taskId.tsx` | HTTP 200; `?mode=technical` expands technical fields |

## 3. Additional product surfaces (nine-IA, not ART S-ids)

Capture when visual gate expands:

| Surface | Route | Viewports | Status |
|---|---|---|---|
| Priority | `/b/{board}/priority` | 1440, 390 | 1440 captured prior |
| Projects | `/b/{board}/projects` | 1440, 390 | 1440 captured prior |
| Features | `/b/{board}/features` | 1440, 390 | not this pass |
| Agents | `/b/{board}/agents` | 1440, 390 | 1440 captured prior |
| Ops | `/b/{board}/ops` | 1440, 390 | not this pass |
| Evidence | `/b/{board}/evidence` | 1440, 390 | not this pass |

## 4. Visual regression gates

- Pinned Chromium / fonts / OS.
- Unexpected `maxDiffPixelRatio` > **0.002** fails.
- Baseline replace only with reviewer receipt.
- Pair proof: Figma/reference path + device/browser shot path (VISUAL_GATE v1).

## 5. This task (2026-07-14 wave1 update)

- **24 of 24** S-ids now have real PNGs across two evidence folders:
  - Prior: S01, S02, S03, S07, S11 (+ Priority/Projects/Agents extras) in
    `.artifact/art-screenshots-2026-07-14/`
  - Wave1: S04–S06, S08–S10, S12–S24 in `.artifact/art-screenshots-wave1/`
    (MANIFEST.md with §1 capture params, fixture methods/hashes for S18–S20).
- **Route-gap claims for S12–S17/S21 are obsolete** — product routes exist and were exercised live
  (see §2 verification table). Residual issues are **content/data**, not missing routers.
- **Residual gaps (honest):**
  1. Work buckets ONGOING/NEXT/QUEUED/RECONCILIATION are empty on this pin because fail-closed
     `DATA_INTEGRITY` maps all 8 synth tasks into BLOCKED (S04–S06/S08 show empty-bucket UI).
  2. AFFILIATE knowledge/documentation domains report unavailable (no pinned domain data).
  3. S21 has no distinct conflict/redact surface beyond the knowledge domain shell.
  4. S22 is a single Tab×8 end-state, not a multi-frame focus filmstrip.
  5. Human-facing copy still leaks technical enums (`CONTENT_REVIEW_REQUIRED`, `MISSING_DISPLAY`) —
     same content-contract gap as the prior pass.
- Status language: use `FUNCTIONAL: 24/24 routes captured; content residual on buckets/domains/S21`
  rather than “NOT SHIPPABLE: no visual proof”.
