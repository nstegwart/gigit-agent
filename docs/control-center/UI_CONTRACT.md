# UI Contract (C0 Design Freeze)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0
**Schema version:** `TM_UI_CONTRACT_V1`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Binding. Normative for C3 UI workers. |
| **Implemented / runtime proof** | **Not claimed** by C0 docs alone. |

### Explicit non-claims

- Staging gate only: `TASK_MANAGER_STAGING_VERIFIED`
- Live: `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`
- No live P0 PASS, no mass-refill unlock, no FABLE PASS
- Production / public-consumer writes excluded
- Synthetic staging default without dual approvals
- Production HTTP 502 / historical open-read MCP = G0 **observed facts**, not implementation success
- No client-side recomputation of readiness, buckets, G5, NEXT, denominators, or priority majority

Board: `mfs-rebuild`
Spec: `AGENT_TASK_ORCHESTRATOR.md` (sha256 `b7e6c69484952d9fd3ada6d13c4b7b32a829187b6e9117c9c32f5bde7419f29d`)


## 1. Mission questions (exactly eight)

| # | Mission question | Primary surface | Supporting surfaces |
|---:|---|---|---|
| Q1 | What is DONE for the current stage? | Overview + Work DONE | Task detail lifecycle |
| Q2 | What is ONGOING now and which agent/model/account owns it? | Overview zero-click ONGOING | Agents/Runs |
| Q3 | What is NEXT and why? | Work NEXT | Priority (dispatch reason) |
| Q4 | What is QUEUED and why? | Work QUEUED | Priority capacity |
| Q5 | What is BLOCKED and who can unblock it? | Work BLOCKED | Decisions |
| Q6 | What decision needs the owner? | Decisions + Overview decision card/pill | — |
| Q7 | Is SALES_WEB_RELATED_BACKEND receiving correct priority? | Priority | Overview PRIORITY card |
| Q8 | Is global legacy-to-rebuild readiness honest and evidence-backed? | Overview GLOBAL | G5 + Evidence/Audit |

Delta erratum absorbed: always **eight** mission questions (never seven).


## 2. Nine IA screens (primary navigation)

Desktop order (stable):

| # | Screen | Route pattern (design) | Purpose |
|---:|---|---|---|
| 1 | Overview | `/b/$boardId/` | Mission truth, decision, priority/global, buckets+STALE, zero-click ONGOING, health |
| 2 | Work | `/b/$boardId/work` | Six primary bucket tabs + STALE filter + server pagination |
| 3 | Priority | `/b/$boardId/priority` | SALES_WEB_RELATED_BACKEND membership, rollups, G5, capacity, non-priority reasons |
| 4 | Projects | `/b/$boardId/projects` (+ detail) | Source-derived project rollups |
| 5 | Features / Flows | `/b/$boardId/features` (+ detail) | Full Feature Flow branches (success/fail/expired) |
| 6 | Agents / Runs | `/b/$boardId/agents` | Agent/model/account, claims, ages, productive states |
| 7 | Ops / Accounts | `/b/$boardId/ops` | Masked capacity, quarantine, sync audit |
| 8 | Decisions | `/b/$boardId/decisions` | Deterministic inbox order, snooze rules, audit |
| 9 | Evidence / Audit | `/b/$boardId/evidence` (or `/log` alias) | Immutable material events, hashes, verifier |

Task detail is a drill-down (not a 10th primary nav item): `/b/$boardId/tasks/$taskId`.
Sanitized public view is separate: public snapshot route/consumer (allowlisted; no private fields).

### Adaptive views policy

For board `mfs-rebuild`, the nine primary screens **must be enabled**. Hiding Overview/Priority/Decisions/Evidence via adaptive view lists is a contract violation for this board.


## 3. Desktop Overview layout (wireframe contract)

1. App bar: board | live stage | freshness | connection | search | owner
2. NEEDS YOUR DECISION: ordered top item + exact owner action
3. PRIORITY card: denominator, PROD_READY evidence, G5, complete, capacity share, dispatch reason, blockers
4. GLOBAL card: denominator, PROD_READY evidence, G5, complete
5. Bucket strip: DONE | RECONCILIATION_PENDING | ONGOING | NEXT | QUEUED | BLOCKED | **STALE overlay chip**
6. Zero-click ONGOING list (stalled first)
7. Projects | lifecycle | G5 | decisions | material events

All counts and percentages come from the **pinned common envelope** (`get_overview` / aliases). UI never recomputes.


## 4. Mobile order and decision sticky behavior

Mobile order:

1. Board/stage/freshness app bar
2. Needs Your Decision card
3. Priority
4. Global
5. Bucket tabs including RECONCILIATION_PENDING + STALE chip
6. ONGOING cards
7. Projects
8. G5
9. Events

**Sticky decision pill:** On scroll, the decision card collapses to a one-line sticky pill showing:

- decision count
- top severity
- expand action

Rules:

- Sticky stack must not obscure primary content (>~30% of 390×844 is a design defect).
- Pill expands on tap to full decision card.
- Blocking decisions cannot be dismissed by snooze.
- Severity→color: hard/blocking-human = **red**; awaiting-reconciliation/stale = **amber**.


## 5. Required UI states (every primary screen)

| State | Meaning | UI requirement |
|---|---|---|
| `populated` | Valid data | Full content |
| `loading` / skeleton | In-flight | Skeleton; no fake numbers |
| `empty` | Legitimate zero | Explicit empty copy |
| `zero-results` | Filter matches none | Distinct from empty board |
| `partial` | Some sections failed | Show partial + error banner |
| `stale` | Envelope `stale=true` | Stale badge + reason + refresh |
| `disconnected` | Transport down | Offline/reconnect affordance |
| `error` / retry | Hard failure | Error + retry; quote typed code when present |
| `forbidden` | Authz deny | Clear 401/403 surface |
| `needs-human` | Open blocking decision | Decision card/pill elevated |

Never render static fase/progress as readiness.


## 6. Work buckets UI

Primary tabs (mutually exclusive):

`DONE` · `RECONCILIATION_PENDING` · `ONGOING` · `NEXT` · `QUEUED` · `BLOCKED`

**STALE** is an overlay filter/chip, not a sixth primary bucket.

Bucket precedence and membership are **server-derived** (see ARCHITECTURE §9). UI displays `bucket` + `overlays[]` from the envelope only.

Deep-link filters must encode: boardId, bucket, overlay, cursor, pinned revision (as served).


## 7. Zero-click ONGOING

Every ONGOING row/card displays **without opening detail**:

| Field | Required |
|---|---|
| task ID / title | yes |
| target gate | yes |
| agent ID | yes |
| role | yes |
| model / effort | yes |
| masked account | yes (never credential) |
| started age | yes |
| heartbeat age | yes |
| material-progress age | yes |
| PRODUCTIVE / IDLE / STALLED | yes (icon + text, not color alone) |
| evidence link | yes |

Sort: stalled first → oldest material-progress age → task ID.

Substate rendering: PRODUCTIVE = pulse icon; IDLE/STALLED = hollow icon + age.


## 8. Priority portfolio truth

Portfolio ID: `SALES_WEB_RELATED_BACKEND`.

UI must display:

- membership proof counts (ACTIVE PRODUCT only, receipt-valid)
- DISTINCT rollups / denominators from server
- G5 status
- all-role capacity fields
- `majorityAllocationPass` / `priorityCapacityShare` with **exact N-A semantics** when capacity=0 or frontier empty
- non-priority allowed reasons only when listed: `STRICT_DIRECT_DEPENDENCY`, `NON_DELAYING_SPARE_CAPACITY`, `PRIORITY_FRONTIER_BLOCKED`, `PRIORITY_FRONTIER_EXHAUSTED`

UI must never invent majority PASS.


## 9. Decisions UI

Server order (display must match):

1. blocking desc
2. severity CRITICAL > HIGH > MEDIUM > LOW
3. dueAt asc (null last)
4. createdAt asc
5. decisionId asc

Statuses: OPEN, ACKNOWLEDGED, RESOLVED, REJECTED, EXPIRED, CANCELLED.

- REJECTED = whole request rejected.
- Declining option = RESOLVED with selected option.
- `snoozedUntil` for non-blocking only; blocking unhideable.
- Decision never broadens production / HOLD / provider authority (UI copy must not imply it does).


## 10. Semantic colors (text + icon + color)

| Semantic | Color intent | Icon intent |
|---|---|---|
| DONE | green | check |
| ONGOING | blue | activity |
| NEXT | violet | forward |
| QUEUED | slate | queue |
| hard/blocking BLOCKED | red | stop |
| awaiting-reconciliation / STALE | amber | warning |
| HOLD | amber | pause |
| EXCLUDE | muted | excluded |

No decorative false progress bars. No color-only status.


## 11. Responsive viewports and zoom

| Viewport | Size |
|---|---|
| Desktop wide | 1440×900 |
| Desktop narrow | 1024×768 |
| Mobile large | 390×844 |
| Mobile small | 360×800 |
| Zoom | **200%** browser zoom on core flows |

Requirements:

- No accidental page overflow
- Table→card reflow at **≤768 CSS px**
- 44×44 touch targets
- Visible focus rings
- Keyboard-only flows for all primary actions
- WCAG 2.2 AA
- axe zero critical/serious
- `prefers-reduced-motion` respected
- Native semantics before ARIA
- Coalesced screen-reader live updates
- Field-linked errors


## 12. Data binding rule (no client recomputation)

| Truth | Source of truth |
|---|---|
| Readiness / complete / cappedBy | Server envelope only |
| Bucket membership / STALE overlay | Server envelope only |
| g5Pass / domain statuses | Server `get_g5` only |
| NEXT selection | Server from root dispatch plan only |
| Priority majority / capacity share | Server portfolio only |
| Ages (heartbeat/material) | Server timestamps; client may format relative age only |

Allowed client work: presentation formatting, local UI expand/collapse, filter parameter construction that the server re-validates.


## 13. Screenshot manifest schema

Each row in the C3/C5 screenshot evidence set:

| Field | Required |
|---|---|
| `route` | yes |
| `state` | yes (from §5) |
| `viewport` or `zoom` | yes |
| `stagingUrl` | yes |
| `fullSha` | yes |
| `schemaVersion` | yes |
| `canonicalSnapshotId` | yes |
| `canonicalHash` | yes |
| `boardRev` | yes |
| `lifecycleRev` | yes |
| `capturedAt` | yes |
| `browserTestId` | yes |
| `visualDiff` | optional path |
| `accessibilityResult` | yes (axe summary path) |
| `missionQuestionLink` | Q1–Q8 where applicable |

### Routes that must appear in the manifest

Overview; each Work bucket; Priority; Projects; Feature Flow; Task detail; Agents/Runs; Ops/Accounts; Decisions list/detail; Evidence/Audit; sanitized public view.


## 14. Performance presentation budgets (UI-facing)

(Server still owns measurement; UI must not mask failures.)

- LCP or explicit Overview-ready marker ≤ 2.5s (staging synthetic scale)
- Filter feedback ≤ 200ms after data present
- Freshness ages from server clocks only


## 15. Acceptance rows owned by UI path

| AC ID | Checkpoint | Contract section |
|---|---|---|
| AC-UI-01 | C3/C5 | §2 nine screens + §5 states |
| AC-UI-02 | C3/C5 | §7 zero-click ONGOING |
| AC-UI-03 | C3/C5 | §4 sticky + §9 order |
| AC-UI-04 | C3/C5 | §11 viewports |
| AC-UI-05 | C3/C5 | §11 200% zoom |
| AC-UI-06 | C3/C5 | §11 a11y |
| AC-UI-07 | C3/C5 | §1 + §13 mission→screenshot map |

Related: AC-BUCKET-*, AC-PRIORITY-*, AC-READY-*, AC-PUBLIC-*, AC-PERF-01.


## 16. Related documents

- ARCHITECTURE.md — aggregation, buckets, readiness
- API_CONTRACT.md — envelopes and reads
- DESIGN_DECISIONS.md — FABLE IA findings
- THREAT_MODEL.md — XSS / malicious agent text
