# Design Decisions & FABLE Finding Ledger (C0)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0
**Schema version:** `TM_DESIGN_DECISIONS_V1`
**Source SHA:** `3c8a855dabd68a1d8a701597da16969756ee6511`

## DESIGN CONTRACT vs IMPLEMENTATION PROOF

| Layer | Status in this document |
|---|---|
| **DESIGN CONTRACT** | Binding for implementers. Normative. |
| **Implemented / runtime proof** | **Not claimed.** Later C1–C5 workers produce evidence. |

### Explicit non-claims (retain until proven elsewhere)

| Token | Value |
|---|---|
| Staging gate | `TASK_MANAGER_STAGING_VERIFIED` **only** (not live P0) |
| Live status | `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK` |
| Live P0 PASS | **Forbidden claim** from design or staging |
| Mass-refill unlock | **Not granted** |
| FABLE PASS | **Not claimed** (advisory ledger only) |
| Production / public-consumer writes | **Excluded** |
| Synthetic staging data | Required absent separate `productionReadApprovalId` + `stagingLoadApprovalId` |
| Production observed facts (G0) | UI/MCP **HTTP 502**, app process absent; open-read MCP baseline historically; **not** current implementation success |

Source SHA for this freeze: `3c8a855dabd68a1d8a701597da16969756ee6511`
Spec: `AGENT_TASK_ORCHESTRATOR.md` (2774 lines, sha256 `b7e6c69484952d9fd3ada6d13c4b7b32a829187b6e9117c9c32f5bde7419f29d`)
Board: `mfs-rebuild`


## 1. Allowed finding statuses (only)

| Status | Meaning |
|---|---|
| `ACCEPTED_PENDING_IMPLEMENTATION` | Spec patch accepted; product code not yet proven |
| `IMPLEMENTED_PENDING_VERIFICATION` | Docs/evidence artifact exists for design input; independent runtime verifier not claimed |

**Forbidden in this ledger:** `RESOLVED_AFTER_VERIFICATION`, any FABLE PASS claim, live P0 PASS, mass-refill unlock.

## 2. Portable FABLE receipt integrity

| Receipt | Path | SHA-256 (must match RESOLVED_TARGET) |
|---|---|---|
| Review | `.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-review.json` | `eadae4e7306aa677e7c460744807934e29df856fac75a01f1321714c556b8d51` |
| Delta | `.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-delta-review.json` | `eeb9af48651b3c31e1e97933ed55e0ac52aed09731b30d246f2df5c1eefa45db` |

Review verdict (advisory): **REQUIRES_REVISION** (pre-V3 candidate).
Delta outcome (advisory): **HANDABLE_PASS** for V3 candidate — **not** product FABLE PASS.

## 3. Finding ledger (both receipts)

| Finding ID | Source | Receipt | Severity | Finding summary | Accepted specification patch | Target checkpoint | Implementation evidence placeholder | Status |
|---|---|---|---|---|---|---|---|---|
| `FABLE-REVIEW-B1` | review | `eadae4e7306a…` | BLOCKER | Write scope never granted; target repo unknown; detached HEAD risk | G0 RESOLVED_TARGET supplies repo/host/branch/upstream/pathspecs; implementer cannot self-grant; AC-TARGET-01..03 | G0 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-B2` | review | `eadae4e7306a…` | BLOCKER | Environment taxonomy undefined; terminal gate may be unreachable | ENVIRONMENT AUTHORITY TABLE + gate split STAGING_VERIFIED vs AWAITING_PRODUCTION…; AC-GATE-01..03 AC-ENV-01 | G0 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-B3` | review | `eadae4e7306a…` | BLOCKER | Ingestion contracts missing for NEXT/capacity/Runs/Ops | MFS_CONTROL_PLANE_SYNC_API_V1 publish_dispatch_plan/register_run/heartbeat_run/sync_accounts; adapter when excluded; AC-INGEST-01..05 | C0/C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-B4` | review | `eadae4e7306a…` | BLOCKER | FABLE gate can deadlock assignment | Portable receipts SHA-locked as design input; future unavailability → BLOCKED_FABLE_UNAVAILABLE; FABLE advisory not independent verifier | G0/C0/C5 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-REVIEW-B5` | review | `eadae4e7306a…` | BLOCKER | Auth/RBAC required but undecided | Reuse proven session; else DECISION_AUTH_MECHANISM_REQUIRED; five-role matrix + scopes + CSRF; AC-AUTH-03..04 | C0/C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H1` | review | `eadae4e7306a…` | HIGH | Sub-delegation bypasses fleet accounting; WORKER_CONTRACT missing | WORKER_CONTRACT v1 mandatory; no unaccounted fleet spawn; capacity policy AC-CAP-01..03 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H2` | review | `eadae4e7306a…` | HIGH | Public-dashboard parity needs edits neither granted nor forbidden | Path boundary excludes CONTRACT/www/nginx; deliver schema+fixtures+conformance+MFS_SYNC_WORKER_PACKET; AC-PUBLIC-* adapter handoff | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-REVIEW-H3` | review | `eadae4e7306a…` | HIGH | ONGOING/DONE/BLOCKED internal inconsistencies | Blocking-only demotes ONGOING; DONE precedes lingering claim; beyond-stage overlays; AC-BUCKET-02/03/07 | C1/C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H4` | review | `eadae4e7306a…` | HIGH | CONTROL_PLANE tasks lack bucket/rail definition | CONTROL_PLANE DONE = controlPlaneTargetGate verified PASS + root acceptance; outside product readiness; AC-BUCKET-04 | C1 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H5` | review | `eadae4e7306a…` | HIGH | Staging data provenance/privacy unspecified | Dual approvals + redactionPolicyVersion + export manifest; else synthetic only; AC-DATA-01/02 | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H6` | review | `eadae4e7306a…` | HIGH | Existing-board regression suite unnamed | Locate ibils suite or DECISION_IBILS_CHARACTERIZATION_AUTHORITY; AC-IBILS-01 | C4/C5 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H7` | review | `eadae4e7306a…` | HIGH | Control plane lacks observability requirements | /healthz SHA/schema; structured logs; metrics/alerts/runbook; AC-OPS-01..03 | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H8` | review | `eadae4e7306a…` | HIGH | Heartbeat volume vs immutable audit unbounded | Heartbeat mutates hot state only; material events immutable; BoardPolicy retention; AC-OPS-04/05 | C2/C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-H9` | review | `eadae4e7306a…` | HIGH | Proposed 9-stage rail vs live lifecycle enum | Live enum IDENTITY match; LIFECYCLE_MAPPING_V1; SPLIT/MERGE blocks; AC-LIFE-01/02 | G0/C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-REVIEW-M1` | review | `eadae4e7306a…` | MEDIUM | Label collision G1–G9 vs G5 domain gate | Acceptance rows named AC-UI-*; G5 reserved for nine-domain gate only | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-REVIEW-M2` | review | `eadae4e7306a…` | MEDIUM | Pagination underspecified | Cursor createdAt,id default 50 max 200; AC-API-01 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M3` | review | `eadae4e7306a…` | MEDIUM | Idempotency replay semantics undefined | Same key+hash replay; different hash 409 IDEMPOTENCY_CONFLICT; 24h TTL; AC-API-02 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M4` | review | `eadae4e7306a…` | MEDIUM | Decision snooze state/fields missing | snoozedUntil; REJECTED vs RESOLVED-with-declining-option; UI_CONTRACT + API | C2/C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M5` | review | `eadae4e7306a…` | MEDIUM | Usability check not operationalized | Eight mission questions → screenshot manifest + AC-UI-07 | C3/C5 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M6` | review | `eadae4e7306a…` | MEDIUM | productionReadinessPercent edge behavior implicit | raw one-decimal mean; board 99.0 cap versioned cappedBy; AC-READY-02/03/07 | C1 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M7` | review | `eadae4e7306a…` | MEDIUM | claim-audit missing | Root verifier runs claim-audit on VPS against portable terminal receipt; implementer does not edit CONTRACT; AC-CLAIM-01/02 | C5 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M8` | review | `eadae4e7306a…` | MEDIUM | Public rate limit numbers/acceptance missing | 60/min/IP burst20 429 Retry-After; AC-AUTH-05 AC-PUBLIC-* | C2/C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M9` | review | `eadae4e7306a…` | MEDIUM | A11y/measurement gaps (zoom, breakpoint, LCP, freshness clocks) | 200% zoom; table→card ≤768; LCP/Overview-ready ≤2.5s; server clock deltas; AC-UI-05/06 AC-PERF-01 | C3/C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-REVIEW-M10` | review | `eadae4e7306a…` | MEDIUM | Wording root orchestrator / BLOCKED color semantics | Root orchestrator (Codex or Claude per CLAUDE.md); hard BLOCKED red; reconciliation/stale amber | C0/C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-B1` | delta | `eeb9af48651b…` | DELTA | B1 disposition: RESOLVED_TARGET mechanism accepted | Same as FABLE-REVIEW-B1; delta HANDABLE_PASS for authority model | G0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-B2` | delta | `eeb9af48651b…` | DELTA | B2 disposition: environment + gate truth accepted | Same as FABLE-REVIEW-B2 | G0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-B3` | delta | `eeb9af48651b…` | DELTA | B3 disposition: ingestion contract accepted | Same as FABLE-REVIEW-B3; C0 delivers OpenAPI + worker packet | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-B4` | delta | `eeb9af48651b…` | DELTA | B4 disposition: FABLE input receipts accepted | SHA-locked portable receipts verified this session | G0/C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-B5` | delta | `eeb9af48651b…` | DELTA | B5 disposition: auth/RBAC matrix accepted | Same as FABLE-REVIEW-B5 | C0/C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H1` | delta | `eeb9af48651b…` | DELTA | H1 disposition accepted in V3 WORKER AND VERIFIER AUTHORITY | See FABLE-REVIEW-H1 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H2` | delta | `eeb9af48651b…` | DELTA | H2 disposition accepted path exclusions + adapter handoff | See FABLE-REVIEW-H2 | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-H3` | delta | `eeb9af48651b…` | DELTA | H3 disposition accepted bucket precedence | See FABLE-REVIEW-H3 | C1 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H4` | delta | `eeb9af48651b…` | DELTA | H4 disposition accepted CONTROL_PLANE DONE | See FABLE-REVIEW-H4 | C1 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H5` | delta | `eeb9af48651b…` | DELTA | H5 disposition accepted staging provenance | See FABLE-REVIEW-H5 | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H6` | delta | `eeb9af48651b…` | DELTA | H6 disposition accepted ibils authority Decision path | See FABLE-REVIEW-H6 | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H7` | delta | `eeb9af48651b…` | DELTA | H7 disposition accepted observability section | See FABLE-REVIEW-H7 | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H8` | delta | `eeb9af48651b…` | DELTA | H8 disposition accepted heartbeat retention | See FABLE-REVIEW-H8 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-H9` | delta | `eeb9af48651b…` | DELTA | H9 disposition accepted live enum diff artifacts | Evidence LIFECYCLE_* JSON identity | G0/C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-M1` | delta | `eeb9af48651b…` | DELTA | M1 AC-UI naming accepted | See FABLE-REVIEW-M1 | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-M2` | delta | `eeb9af48651b…` | DELTA | M2 cursor defaults accepted | See FABLE-REVIEW-M2 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M3` | delta | `eeb9af48651b…` | DELTA | M3 idempotency accepted | See FABLE-REVIEW-M3 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M4` | delta | `eeb9af48651b…` | DELTA | M4 decision snooze accepted | See FABLE-REVIEW-M4 | C2/C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M5` | delta | `eeb9af48651b…` | DELTA | M5 mission-question evidence map accepted | Eight questions (delta erratum fixes seven→eight) | C3 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M6` | delta | `eeb9af48651b…` | DELTA | M6 readiness edges accepted | See FABLE-REVIEW-M6 | C1 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M7` | delta | `eeb9af48651b…` | DELTA | M7 claim-audit accepted | See FABLE-REVIEW-M7 | C5 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M8` | delta | `eeb9af48651b…` | DELTA | M8 rate limit accepted | See FABLE-REVIEW-M8 | C2 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M9` | delta | `eeb9af48651b…` | DELTA | M9 a11y/measurement accepted | See FABLE-REVIEW-M9 | C3/C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-M10` | delta | `eeb9af48651b…` | DELTA | M10 wording accepted | See FABLE-REVIEW-M10 | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-E1` | delta | `eeb9af48651b…` | ERRATUM | Seven vs eight mission questions count | Absorb: mission list is **eight** questions; screenshot/AC-UI-07 map all eight | C0 | `_pending_` | `IMPLEMENTED_PENDING_VERIFICATION` |
| `FABLE-DELTA-N1` | delta | `eeb9af48651b…` | NIT | Integrator dispatch omits 'immediately' | Design: root dispatches integrator immediately after verifier PASS + root accept (per checkpoint) | integrator | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-N2` | delta | `eeb9af48651b…` | NIT | claim-audit receipt transport unstated | Portable evidence locator + hash bind; root verifier fetches read-only from laptop evidence root | C5 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |
| `FABLE-DELTA-N3` | delta | `eeb9af48651b…` | NIT | AC-DATA-02 phrasing awkward | Interpret as: absent dual approvals, synthetic fixtures only (no production copy) | C4 | `_pending_` | `ACCEPTED_PENDING_IMPLEMENTATION` |

**Ledger row count:** 52

## 4. Cross-cutting accepted design decisions (summary)

1. **Authority:** Root supplies RESOLVED_TARGET; workers never self-grant pathspecs/branches.
2. **Gates:** Staging terminal `TASK_MANAGER_STAGING_VERIFIED`; live remains `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`.
3. **Truth:** One pinned server aggregation; no client recomputation.
4. **Classification:** Never guess PRODUCT; UNCLASSIFIED blocks complete.
5. **NEXT:** Only root `publish_dispatch_plan`.
6. **Public/MFS:** Contract-only in this repo; separate future MFS worker.
7. **FABLE:** Advisory; independent verifier is root-dispatched opposite-model/runtime verifier.
8. **Mission questions:** Exactly **eight** (delta erratum).

## 5. Acceptance mapping

All 90 AC IDs are crosswalked in ARCHITECTURE.md §16 and UI_CONTRACT appendix. This ledger does not re-PASS acceptance rows.
