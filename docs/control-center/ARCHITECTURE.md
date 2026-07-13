# Control Center Architecture (C0 Design Freeze)

**Document class:** DESIGN CONTRACT
**Checkpoint:** C0 — Design and threat model
**Schema version:** `TM_CONTROL_CENTER_ARCHITECTURE_V1`
**Author role:** CONTROL_PLANE_DESIGN_AUTHOR
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


## 1. Purpose

Human-first task-manager / MCP control center for board `mfs-rebuild` so the owner answers eight mission questions without raw JSON:

1. What is DONE for the current stage?
2. What is ONGOING now and which agent/model/account owns it?
3. What is NEXT and why?
4. What is QUEUED and why?
5. What is BLOCKED and who can unblock it?
6. What decision needs the owner?
7. Is `SALES_WEB_RELATED_BACKEND` receiving correct priority?
8. Is global legacy-to-rebuild readiness honest and evidence-backed?

## 2. Current system vs target system

### 2.1 Current (as of source SHA; Gate 1 evidence)

| Layer | Current behavior | Anchor / evidence |
|---|---|---|
| Stack | TanStack Start/Router/Query + React 19 + Vite + MySQL + MCP SDK | package.json / Gate1 codemap |
| UI IA | Adaptive board views; home KPIs; not V3 Overview/Work/Priority/Evidence | AppShell / board routes |
| Lifecycle | Per-board rail in `board_docs.kind=lifecycle`; 9 live stage names already match V3 | LIVE_LIFECYCLE_ENUM / LIFECYCLE_MAPPING_V1 |
| Revisions | **No** `boardRev` / `lifecycleRev` | LIVE_DB_READ / LIFECYCLE_ENUM_DIFF |
| Auth UI | Cookie session; roles `admin` \| `member` | src/server/auth.ts |
| Auth MCP | Optional write token; **sensitive reads open** when process up | LIVE_AUTH_PREFLIGHT; docs/MCP.md |
| Production | `https://task-manager.mfsdev.net/` HTTP **502**, app process absent | RESOLVED_TARGET.production |
| Public consumer | `http://34.50.66.172/` EXCLUDED write authority | RESOLVED_TARGET.publicConsumer |
| Staging | Isolated Docker loopback `127.0.0.1:33211`, synthetic DB only | RESOLVED_TARGET.staging |
| Aggregation | Client/model recompute possible; rollup mean over non-HOLD | lifecycle-store computeRollup |

### 2.2 Target (V3)

| Capability | Target behavior |
|---|---|
| Single pinned aggregation | Server materializes one result at `canonicalSnapshotId/hash` + `boardRev` + `lifecycleRev`; UI/MCP/public never recompute readiness/buckets |
| Classification | `taskClass` PRODUCT \| CONTROL_PLANE \| UNCLASSIFIED; `disposition` ACTIVE \| HOLD \| EXCLUDE \| UNCLASSIFIED; contribution derived |
| Readiness | Policy `MFS_DELIVERY_READINESS_V1` + board cap `MFS_BOARD_READINESS_G5_CAP_V1` |
| Lifecycle rail | Ordered 9 stages; stage receipts; role/model separation; fencing |
| G5 | Nine domains; server-derived read-only `g5Pass` |
| Buckets | Six primary + STALE overlay; 10-rule precedence |
| Ingestion | `MFS_CONTROL_PLANE_SYNC_API_V1` dispatch/run/account |
| Locks | Collision scope + single integrator per `repoId+trackingBranch` |
| Public | Allowlisted snapshot, ETag/304, rate limit 60/min burst 20 |
| RBAC | Five roles; scopes; CSRF on browser writes |
| Deploy boundary | Staging implement/prove only; live P0 owner-gated |

## 3. Trust, data, and deploy boundaries

```text
+------------------+     read-only     +---------------------------+
| Owner laptop     | <---------------> | Production TM host        |
| source workspace |                   | task-manager.mfsdev.net   |
| (authoritative)  |                   | class=PRODUCTION          |
+--------+---------+                   | authority=READ ONLY       |
         |                             | gate=AWAITING_PRODUCTION… |
         | C0–C5 source edits          +---------------------------+
         v
+------------------+   deploy/migrate  +---------------------------+
| Staging isolated | ----------------> | 127.0.0.1:33211 tunnel    |
| Docker + MySQL   |                   | cairn_tm_v3_staging       |
| synthetic data   |                   | gate=TASK_MANAGER_        |
+--------+---------+                   |   STAGING_VERIFIED only   |
         |                             +---------------------------+
         | contract-only handoff
         v
+------------------+   EXCLUDED writes +---------------------------+
| MFS sync worker  | - - - - - - - - > | Public consumer           |
| (separate auth)  |                   | 34.50.66.172 / CONTRACT   |
+------------------+                   +---------------------------+
```

| Boundary | Rule |
|---|---|
| Source host | Authoritative checkout only: this repo, `main` → `origin/main`, pathspecs in RESOLVED_TARGET |
| Production | No deploy, restart, migration, or DB write without exact owner approval |
| Staging | Full create/deploy/migrate/test/rollback; synthetic fixtures default |
| Public consumer | No mutation from this task; adapter contract + future worker packet only |
| Secrets | Never copy Cairn secrets, tokens, raw account identity into docs, logs, or public snapshot |

## 4. Pinned aggregation model

1. **Canonical snapshot** schema `MFS_CANONICAL_TASK_SNAPSHOT_V1` imported with hash validation, DISTINCT ID checks, cycle/dup rejection.
2. **Aggregation service** (server-only) joins classification, lifecycle, runs, locks, dispatch plan, accounts, G5, decisions at one pinned revision tuple.
3. **Consumers** (authenticated MCP/API, UI loaders, public materializer) read the pinned envelope; **no client recomputation** of counts/readiness/buckets/G5.
4. **Freshness:** `generatedAt`, `freshnessAgeSeconds`, `stale`, `staleReason` on every envelope.

## 5. Versioned canonical snapshot

| Manifest field | Required |
|---|---|
| schemaVersion | `MFS_CANONICAL_TASK_SNAPSHOT_V1` |
| boardId | e.g. `mfs-rebuild` |
| snapshotId | UUID/stable id |
| sourceRepoId | binding |
| sourceCommitSha | full SHA |
| generatedAt | server clock |
| canonicalizationAlgorithm | documented |
| payloadSha256 | SHA-256 of deterministic JSON |
| DISTINCT counts | program-emitted |
| producerVersion | string |

Payload: projects, Feature Flows/nodes, tasks, dependencies, classifications, anchors, acceptance/evidence paths. **No secrets.**

Importer fail-closed: schema/hash fail, duplicate FC/node/dependency joins, cycles, stale revisions, missing idempotency key → typed errors; **cannot fabricate lifecycle evidence**.

## 6. Distinct-count and readiness semantics

### 6.1 Denominators (DISTINCT current-hash/revision task IDs)

| Field | Definition |
|---|---|
| `trackedWorkDenominator` | ACTIVE dispositions + UNCLASSIFIED/missing/stale classification-repair rows (once; forced BLOCKED:DATA_INTEGRITY) |
| `productDenominator` | PRODUCT + ACTIVE + valid classification/membership receipt |
| `stageProdReady` | productDenominator at PROD_READY or LIVE_VERIFIED |
| `prodReadyWithEvidence` | stageProdReady with valid evidence/verifier/boardRev/lifecycleRev |
| `unclassifiedCount` | tracked rows with UNCLASSIFIED/missing/stale classification |
| `g5Pass` | derived read-only (see §7) |
| `complete` | productDenominator>0 AND all stage/evidence equal productDenominator AND g5Pass AND unclassifiedCount=0 AND no P0/data-integrity blocker |

### 6.2 Weights (`taskReadinessPolicyVersion` = `MFS_DELIVERY_READINESS_V1`)

| Stage | Weight |
|---|---:|
| `MAPPING` | 0 |
| `MAPPED` | 10 |
| `MAP_VERIFIED` | 20 |
| `BUILT` | 45 |
| `FUNCTIONAL` | 65 |
| `INTEGRATED` | 75 |
| `STAGING_PROVEN` | 90 |
| `PROD_READY` | 100 |
| `LIVE_VERIFIED` | 100 |

- Task readiness = exact stage weight.
- Rollup `rawTaskReadinessPercent` = one-decimal mean over DISTINCT `productDenominator`.
- `productDenominator=0` → readiness null, `cappedBy=EMPTY_PRODUCT_SCOPE`, `complete=false`, **never 100**.
- Mapping 20/20 at MAPPED remains **10**. Static fase/pct never drives readiness.

### 6.3 Board cap (`boardReadinessPolicyVersion` = `MFS_BOARD_READINESS_G5_CAP_V1`)

When raw would be 100.0 but g5Pass=false → `boardReadinessPercent=99.0`, `cappedBy=G5`.
Evidence incomplete → 99.0 `cappedBy=EVIDENCE`.
UNCLASSIFIED/P0 → 99.0 `cappedBy=DATA_INTEGRITY_OR_P0`.
Cap is displayed; never silently relabeled as task readiness.

## 7. Lifecycle / evidence rail

Ordered rail (allowSkip=false):

`MAPPING`, `MAPPED`, `MAP_VERIFIED`, `BUILT`, `FUNCTIONAL`, `INTEGRATED`, `STAGING_PROVEN`, `PROD_READY`, `LIVE_VERIFIED`

Every transition requires: fresh `entityExpectedRev`, fresh `boardRev`, current canonical/task/evidence hashes, registered unexpired unfenced author/verifier runs, valid role/model separation, immutable audit receipt.

| Stage | Stage-specific receipt (summary) |
|---|---|
| MAPPED | mappingStructuralReceipt |
| MAP_VERIFIED | independent mapping-verifier verdict |
| BUILT | implementation/buildReceipt + intended paths |
| FUNCTIONAL | positive/negative/regression + independent functional verifier |
| INTEGRATED | dedicated Grok COMMIT/INTEGRATE receipt (branch, full/short SHA, pathspecs, push: OK) |
| STAGING_PROVEN | staging API/UI/DB/readback + independent staging verifier on deployed SHA |
| PROD_READY | target/staging + complete nine-domain G5 + product-readiness verifier |
| LIVE_VERIFIED | owner `productionApprovalId` + deploy receipt + live verifier |

Reject: skip, stale rev/hash, missing receipt, same author/verifier agent/thread, invalid model pairing, expired/fenced run, self-verify, hand-typed PASS.

Live enum identity evidence (G0): all nine states IDENTITY; `blockingAmbiguity=false`; no production lifecycle rewrite authorized.

## 8. G5 contract (exactly nine domains)

| # | Domain |
|---:|---|
| 1 | security |
| 2 | performance/capacity |
| 3 | migration/data integrity |
| 4 | rollback/restore |
| 5 | backup/DR |
| 6 | monitoring/alerts/runbooks |
| 7 | config/secrets |
| 8 | cutover rehearsal |
| 9 | dependency/provider readiness |

Per-domain record: scope, required, status, evidence receipt IDs/hashes, verifier agent/model/run, subject revision/hash, findings, blocker, capturedAt, expectedRev, boardRev, subject lifecycleRev.

Status enum: `NOT_STARTED` | `IN_PROGRESS` | `PASS` | `FAIL` | `BLOCKED`.

`g5Pass=true` iff **all nine** required domains are current-revision, current-hash, programmatically evidenced PASS with independent verifier receipts. Any other state → false. **Not writable** by client/import/human.

`DESIGN_ONLY:10M_CAPACITY` is not measured capacity.

## 9. Buckets and overlays

### 9.1 Primary buckets (mutually exclusive)

`DONE`, `RECONCILIATION_PENDING`, `ONGOING`, `NEXT`, `QUEUED`, `BLOCKED`

**STALE** is an overlay/drilldown, **not** a sixth primary bucket. STALE includes: stale data source; expired/stalled run; claim awaiting reconciliation; stale dispatch plan; stale account sync.

### 9.2 DONE definitions

| Class | DONE when |
|---|---|
| PRODUCT Stage 1 | MAP_VERIFIED |
| PRODUCT Stage 2 | PROD_READY or LIVE_VERIFIED |
| CONTROL_PLANE | `controlPlaneTargetGate` independently verified PASS + root acceptance (outside product readiness) |
| UNCLASSIFIED | **never DONE** → BLOCKED:DATA_INTEGRITY |

### 9.3 Precedence (10 rules)

1. UNCLASSIFIED / missing invalid stale classification → BLOCKED:DATA_INTEGRITY (tracked once)
2. Fully classified HOLD/EXCLUDE with current receipt → outside tracked buckets
3. Current-stage DONE
4. Stale/orphan/expired/fenced ownership → RECONCILIATION_PENDING
5. Blocking human decision → BLOCKED
6. Valid current-stage claim → ONGOING
7. Hard blocker → BLOCKED
8. Active dispatch-plan selection → NEXT
9. Eligible → QUEUED
10. Other malformed → BLOCKED:DATA_INTEGRITY

Coverage invariant (DISTINCT):
`trackedWorkDenominator = DONE + RECONCILIATION_PENDING + ONGOING + NEXT + QUEUED + BLOCKED`

Completed task + lingering claim → stays DONE + STALE_CLAIM overlay.
Beyond-stage claim on completed → DONE + BEYOND_STAGE_ONGOING overlay (no double-count ONGOING).

## 10. Decisions

Statuses: OPEN, ACKNOWLEDGED, RESOLVED, REJECTED, EXPIRED, CANCELLED.
Order: blocking desc → severity CRITICAL>HIGH>MEDIUM>LOW → dueAt asc (null last) → createdAt asc → decisionId.
Blocking decisions cannot be snoozed away. Decision never broadens production/HOLD/provider authority.

## 11. Ingestion, run, account, lock, reconciler model

### 11.1 Ingestion (`MFS_CONTROL_PLANE_SYNC_API_V1`)

| Operation | Caller | Notes |
|---|---|---|
| `publish_dispatch_plan` | ROOT_ORCHESTRATOR only | **Sole** NEXT source |
| `register_run` | AGENT | Idempotent on runId + key |
| `heartbeat_run` | owning AGENT | Fencing + sequence; duplicate seq = replay |
| `sync_accounts` | ROOT or authorized MFS sync | Masked only; never tokens |

Account publish SLA: triggered state to MCP/API/UI/Ops within **30s** same revision/generatedAt; periodic health ≥ every **60s**. Miss → stale, ACCOUNT_SYNC_STALE, usableCapacity=0, fail-closed until readback parity.

### 11.2 Run states

QUEUED, RESERVED, STARTING, RUNNING, WAITING_HUMAN, SUCCEEDED, FAILED, CANCELLED, STALE, SUPERSEDED.

Defaults: visible ≤30s; heartbeat ≤15s; lease 60s; reconciliation grace 30s; stalled after 10m without material progress. Heartbeat ≠ productivity/completion.

### 11.3 Locks

- Task/write: `collisionScopeLockIds` acquired atomically; lease+fence; release at terminal.
- Integration: key `repoId + trackingBranch` → exactly one live COMMIT_INTEGRATE; requires root acceptance + checkpoint + pathspecs + dedicated Grok integrator.

### 11.4 Reconciler

Leader/fencing lease; maxActionsPerRun default 100; bounded cursor/time; dry-run with dryRunHash; apply requires same hash + current revs; item-level before/after; idempotent rerun proof.

## 12. Public snapshot

Materialized once from pinned aggregation. ETag = SHA-256(revision tuple + payload). If-None-Match → 304.
Rate: `PUBLIC_SNAPSHOT_RATE_LIMIT_V1` — 60/min/IP sustained, burst 20 → 429 + Retry-After.
Unauthenticated sensitive MCP board/lifecycle/run/account reads **forbidden**.

## 13. Observability

Authenticated `/healthz`: service status, deployed full SHA, schema version, migration status, canonical snapshot ID, board/lifecycle revision, dependency health.
Structured logs (no secrets): timestamp, requestId, boardId, actor role/ID, endpoint/event, result/error, latency, revisions.
Metrics/alerts per V3 OBSERVABILITY section (dispatch age, heartbeat lag, reconciler failures, account-sync stale, unauthorized exposure, etc.).

## 14. Source-host / staging / public-consumer boundaries

| Surface | Class | Authority | Gate closed by |
|---|---|---|---|
| task-manager.mfsdev.net UI/MCP | PRODUCTION | read-only | live P0 only after approved deploy/readback |
| 127.0.0.1:33211 staging | STAGING | deploy/migrate/test | `TASK_MANAGER_STAGING_VERIFIED` only |
| 34.50.66.172 public | LIVE_PUBLIC_CONSUMER | writes excluded | participates in live P0 only |
| local/test | TEST | disposable fixtures | checkpoint tests only |

## 15. Rollout / rollback gates

Checkpoints: G0 → C0 → C1 → C2 → C3 → C4 → C5 → terminal `TASK_MANAGER_STAGING_VERIFIED` with live status still `AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK`.

Migration classification: REVERSIBLE | EXPAND_CONTRACT_BACKWARD_COMPATIBLE | FORWARD_FIX_ONLY.
Staging rehearsal must redeploy **actual previous full SHA** and recover current SHA (document-only rollback ≠ proof).

## 16. Acceptance checkpoint crosswalk (all 90 AC IDs)

| AC ID | Checkpoint | One-liner (spec) | Implementation evidence placeholder |
|---|---|---|---|
| `AC-GATE-01` | C5 / terminal | staging PASS emits TASK_MANAGER_STAGING_VERIFIED | _pending C* worker_ |
| `AC-GATE-02` | C5 / terminal | staging never emits live P0 PASS/unlock | _pending C* worker_ |
| `AC-GATE-03` | C5 / terminal | live remains AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK | _pending C* worker_ |
| `AC-TARGET-01` | G0 / C0 | RESOLVED_TARGET repo/branch/upstream/pathspecs proven | _pending C* worker_ |
| `AC-TARGET-02` | C0 | detached/unknown target blocks before edits | _pending C* worker_ |
| `AC-TARGET-03` | G0 / C0 | no compiled/nginx/public asset patch | _pending C* worker_ |
| `AC-TARGET-04` | G0 / C0 | root-produced RESOLVED_TARGET and both portable FABLE receipt hashes verify | _pending C* worker_ |
| `AC-ENV-01` | G0 | all known URLs/classes/TLS/deploy mechanisms/gates recorded with observedAt | _pending C* worker_ |
| `AC-AUTH-01` | G0 / C2 | unauth UI/MCP baseline rechecked | _pending C* worker_ |
| `AC-AUTH-02` | C2 | unauthenticated access reaches sanitized public snapshot only | _pending C* worker_ |
| `AC-AUTH-03` | C2 | OWNER/ROOT/AGENT/INTEGRATOR/PUBLIC matrix enforced | _pending C* worker_ |
| `AC-AUTH-04` | C2 | read/write scopes and CSRF enforced | _pending C* worker_ |
| `AC-AUTH-05` | C2 | public 60/min/IP burst20 limit and 429 tested | _pending C* worker_ |
| `AC-CLASS-01` | C1 | PRODUCT/CONTROL_PLANE/UNCLASSIFIED valid | _pending C* worker_ |
| `AC-CLASS-02` | C1 | ACTIVE/HOLD/EXCLUDE/UNCLASSIFIED valid | _pending C* worker_ |
| `AC-CLASS-03` | C1 | contribution derived/read-only | _pending C* worker_ |
| `AC-CLASS-04` | C1 | UNCLASSIFIED outside denominator and blocks complete | _pending C* worker_ |
| `AC-CLASS-05` | C1 | cross-product fixtures prove taskClass=UNCLASSIFIED with disposition=HOLD and EXCLUDE, plus PRODUCT/CONTROL_PLANE with disposition=UNCLASSIFIED, and any HOLD/EXCLUDE row with missing/stale classification receipt are each tracked once as BLOCKED:DATA_INTEGRITY; only fully classified, current-receipt-valid HOLD/EXCLUDE fixtures remain outside tracked buckets | _pending C* worker_ |
| `AC-COUNT-01` | C1 | all rollups count DISTINCT task IDs | _pending C* worker_ |
| `AC-COUNT-02` | C1 | duplicate FC/node/dependency joins are rejected | _pending C* worker_ |
| `AC-READY-01` | C1 | weights exactly 0/10/20/45/65/75/90/100 | _pending C* worker_ |
| `AC-READY-02` | C1 | rawTaskReadinessPercent preserves task weights | _pending C* worker_ |
| `AC-READY-03` | C1 | board 99 cap is versioned and displays cappedBy | _pending C* worker_ |
| `AC-READY-04` | C1 | G5/evidence/data blockers prevent complete | _pending C* worker_ |
| `AC-READY-05` | C1 | mapping 20/20 at MAPPED is 10 | _pending C* worker_ |
| `AC-READY-06` | C1 | all readiness fields use DISTINCT current-hash/revision task IDs | _pending C* worker_ |
| `AC-READY-07` | C1 | productDenominator=0 returns null readiness, complete=false, never 100 | _pending C* worker_ |
| `AC-LIFE-01` | G0 / C0 | live enum diff/mapping exists | _pending C* worker_ |
| `AC-LIFE-02` | C0 / C1 | ambiguous split/merge blocks migration | _pending C* worker_ |
| `AC-LIFE-03` | C1 / C2 | skip/stale hash/missing evidence/self-verify rejected | _pending C* worker_ |
| `AC-LIFE-04` | C1 / C2 | every ordered stage enforces its exact current receipt and fresh revisions | _pending C* worker_ |
| `AC-LIFE-05` | C1 | g5Pass is read-only and false unless all nine current domains independently and programmatically PASS | _pending C* worker_ |
| `AC-BUCKET-01` | C1 / C3 | DISTINCT active bucket sum holds across all taskClass values | _pending C* worker_ |
| `AC-BUCKET-02` | C1 / C3 | only blocking Decision blocks ONGOING | _pending C* worker_ |
| `AC-BUCKET-03` | C1 / C3 | completed task stays DONE with stale/beyond-stage overlay | _pending C* worker_ |
| `AC-BUCKET-04` | C1 / C3 | CONTROL_PLANE verified gate maps to DONE without product progress | _pending C* worker_ |
| `AC-BUCKET-05` | C1 / C3 | STALE chip/drilldown matches overlay rows | _pending C* worker_ |
| `AC-BUCKET-06` | C1 / C3 | trackedWorkDenominator includes ACTIVE plus UNCLASSIFIED repair rows once | _pending C* worker_ |
| `AC-BUCKET-07` | C1 / C3 | incomplete stale/orphan ownership maps to RECONCILIATION_PENDING while a completed task stays DONE with reconciliation overlay | _pending C* worker_ |
| `AC-INGEST-01` | C2 | publish_dispatch_plan is sole NEXT source | _pending C* worker_ |
| `AC-INGEST-02` | C2 | dispatch rank/reason/revisions match NEXT in MCP/API/UI | _pending C* worker_ |
| `AC-INGEST-03` | C2 | real authorized runner registration appears <=30 seconds | _pending C* worker_ |
| `AC-INGEST-04` | C2 | register/heartbeat idempotency works | _pending C* worker_ |
| `AC-INGEST-05` | C2 | masked account sync matches authorized pool state | _pending C* worker_ |
| `AC-ACCOUNT-01` | C2 | launch publishes masked account state to MCP/API/UI/Ops within SLA | _pending C* worker_ |
| `AC-ACCOUNT-02` | C2 | heartbeat/material assignment/status transition publishes within SLA | _pending C* worker_ |
| `AC-ACCOUNT-03` | C2 | LIMIT/BAN/403/AUTH_EXPIRED transition publishes within SLA | _pending C* worker_ |
| `AC-ACCOUNT-04` | C2 | rotation/requeue publishes within SLA | _pending C* worker_ |
| `AC-ACCOUNT-05` | C2 | integration/wave close publishes within SLA | _pending C* worker_ |
| `AC-ACCOUNT-06` | C2 | periodic health checkpoint publishes at least every 60 seconds | _pending C* worker_ |
| `AC-ACCOUNT-07` | C2 | source revision/generatedAt parity is exact; missed/stale publication alerts, sets usableCapacity=0, fails closed, and leaves no server-local-only state | _pending C* worker_ |
| `AC-LOCK-01` | C2 | overlapping cross-task path collision is atomically rejected | _pending C* worker_ |
| `AC-LOCK-02` | C2 | collision lock lease/fence/terminal release works | _pending C* worker_ |
| `AC-LOCK-03` | C2 | repoId+trackingBranch permits exactly one integrator | _pending C* worker_ |
| `AC-LOCK-04` | C2 | supersession pointer+fencing is atomic | _pending C* worker_ |
| `AC-API-01` | C2 / C3 | cursor createdAt,id default50/max200 is stable | _pending C* worker_ |
| `AC-API-02` | C2 / C3 | idempotency replay/conflict/24h TTL works | _pending C* worker_ |
| `AC-API-03` | C2 / C3 | entityExpectedRev+expectedBoardRev mismatch returns STALE_REVISION | _pending C* worker_ |
| `AC-API-04` | C2 / C3 | all canonical authenticated reads return the common pinned envelope, aliases, filters, and cursor semantics | _pending C* worker_ |
| `AC-CAP-01` | C2 / C3 | Spark<=10, SOL<=10 global, Grok starts5 and remains5–10/healthy account, Grok majority, combined<=200 | _pending C* worker_ |
| `AC-CAP-02` | C2 / C3 | >=60 applies iff >=60 genuine unique ready collision-safe packets and health permit; otherwise exact BELOW_FLOOR count/reason | _pending C* worker_ |
| `AC-CAP-03` | C2 / C3 | CPU/LIMIT/quarantine/tombstone/physical20/accounts-all/filler rules enforce the full fail-safe policy | _pending C* worker_ |
| `AC-PRIORITY-01` | C3 | membership contains current receipt-valid ACTIVE PRODUCT task IDs only | _pending C* worker_ |
| `AC-PRIORITY-02` | C3 | zero allClosureCapacity and no-frontier cases return exact false/null/N-A semantics and never majority PASS | _pending C* worker_ |
| `AC-PUBLIC-01` | C3 | snapshot is pinned/materialized once | _pending C* worker_ |
| `AC-PUBLIC-02` | C3 | ETag matches revision/payload hash and 304 works | _pending C* worker_ |
| `AC-PUBLIC-03` | C3 | redaction excludes private/sensitive fields | _pending C* worker_ |
| `AC-DATA-01` | C4 | production-read/staging-load approvals and redaction provenance enforced | _pending C* worker_ |
| `AC-DATA-02` | C4 | no authority uses synthetic fixtures only | _pending C* worker_ |
| `AC-IBILS-01` | C4 / C5 | located suite passes or characterization Decision blocks final gate | _pending C* worker_ |
| `AC-OPS-01` | C2 / C4 | /healthz full SHA/schema matches deploy | _pending C* worker_ |
| `AC-OPS-02` | C2 / C4 | structured logs omit secrets | _pending C* worker_ |
| `AC-OPS-03` | C2 / C4 | required metrics/alerts/runbook tested | _pending C* worker_ |
| `AC-OPS-04` | C2 / C4 | heartbeat is not immutable per-event audit | _pending C* worker_ |
| `AC-OPS-05` | C2 / C4 | retention/compaction and bounded reconciler tested | _pending C* worker_ |
| `AC-UI-01` | C3 / C5 | all nine IA screens and states exist | _pending C* worker_ |
| `AC-UI-02` | C3 / C5 | ONGOING zero-click fields/ages present | _pending C* worker_ |
| `AC-UI-03` | C3 / C5 | Decision order and mobile sticky pill deterministic | _pending C* worker_ |
| `AC-UI-04` | C3 / C5 | 1440/1024/390/360 viewports pass | _pending C* worker_ |
| `AC-UI-05` | C3 / C5 | 200 percent zoom/reflow passes | _pending C* worker_ |
| `AC-UI-06` | C3 / C5 | keyboard/axe/WCAG checks pass | _pending C* worker_ |
| `AC-UI-07` | C3 / C5 | all declared mission questions map to annotated screenshots/evidence | _pending C* worker_ |
| `AC-PERF-01` | C4 | stated staging scale/latency/freshness budgets pass programmatically | _pending C* worker_ |
| `AC-ROLL-01` | C5 | actual previous SHA redeploy is rehearsed | _pending C* worker_ |
| `AC-ROLL-02` | C5 | rollback/forward-fix criteria and current-SHA recovery proven | _pending C* worker_ |
| `AC-GIT-01` | integrator | integrator identity is exact | _pending C* worker_ |
| `AC-GIT-02` | integrator post C* | each verified checkpoint has branch/full+short SHA/push: OK | _pending C* worker_ |
| `AC-GIT-03` | all checkpoints | no unrelated paths/worktree/branch switch/force/no-verify | _pending C* worker_ |
| `AC-CLAIM-01` | C5 root verifier | claim-audit self-test passes | _pending C* worker_ |
| `AC-CLAIM-02` | C5 root verifier | terminal receipt claim-audit passes with program output | _pending C* worker_ |

**Count:** 90 (must equal 90). Design freeze maps rows to checkpoints; **does not** mark rows implemented or PASS.

## 17. Related design documents

| Doc | Role |
|---|---|
| DESIGN_DECISIONS.md | FABLE finding ledger |
| THREAT_MODEL.md | STRIDE + mitigations |
| API_CONTRACT.md | Authenticated API/MCP |
| MIGRATION_PLAN.md | Versioned non-destructive sequence |
| UI_CONTRACT.md | Nine IA screens + states |
| MFS_CONTROL_PLANE_SYNC_API_V1.md | Adapter narrative |
| MFS_CONTROL_PLANE_SYNC_API_V1.openapi.yaml | Adapter OpenAPI |
| MFS_SYNC_WORKER_PACKET.md | Future MFS mutation packet (not current auth) |
