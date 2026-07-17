# AGENT_TASK_ORCHESTRATOR_COMBINED.md
# CUMULATIVE CANONICAL EXECUTION CONTRACT
# Generated mechanically by qa/cp0/generate-combined-spec.mjs; do not hand-edit.

## COMBINED_META

- document_id: AGENT_TASK_ORCHESTRATOR_COMBINED
- task_id: TM-P0-ULTIMATE-CONTROL-CENTER-V3
- generation_mode: deterministic_verbatim_embed_v2
- authority_model: cumulative parent plus addendum
- parent_sha256: b7e6c69484952d9fd3ada6d13c4b7b32a829187b6e9117c9c32f5bde7419f29d
- addendum_sha256: 4eca14e115223ca4be02ec767dca0a32fb3e104dc4a512ebbc99374f93cddcee
- retired_offline_provenance_sha256: 4330d6e6d34e209acc1e54a4f42127cdf39363bd6428267a3031ad1744c78091

## CURRENT PUBLICATION AUTHORITY

App-only Task Manager production publication is pre-authorized only after exact current-SHA
staging PASS, an independent verifier PASS bound to that SHA, root acceptance, backup and
rollback proof, authenticated UI/MCP plus sanitized public parity, zero effective sync backlog,
and lifecycle/audit/rollup/hash/freshness readback. Publication uses --no-migrate. Production
schema migration remains separately owner-gated; a schema-incompatible candidate returns
SCHEMA_AUTH_REQUIRED and is not published. MFS production remains outside this contract.

## INTEGRITY RULES

- Each pinned source appears exactly once between its BEGIN/END markers.
- Text inside each verbatim block is byte-identical to the named pinned source.
- Metadata resolves later owner authority only; it does not rewrite either source body.
- Run this generator with --check before accepting a candidate.

## VERBATIM_PARENT: AGENT_TASK_ORCHESTRATOR.md

<<<BEGIN_VERBATIM_SOURCE:AGENT_TASK_ORCHESTRATOR.md>>>
01-TASK-MANAGER-AGENT — EXECUTION SPEC V3
=========================================

MISSION
-------

Implement and prove a human-first task-manager/MCP control center for board:

  mfs-rebuild

Known entrypoints, all rechecked live:

  Task-manager UI:
    https://task-manager.mfsdev.net/

  Task-manager MCP:
    https://task-manager.mfsdev.net/mcp

  VPS public consumer:
    http://34.50.66.172/

The owner must answer without opening raw JSON:

  - What is DONE for the current stage?
  - What is ONGOING now and which agent/model/account owns it?
  - What is NEXT and why?
  - What is QUEUED and why?
  - What is BLOCKED and who can unblock it?
  - What decision needs the owner?
  - Is SALES_WEB_RELATED_BACKEND receiving correct priority?
  - Is global legacy-to-rebuild readiness honest and evidence-backed?

This is an execute-not-audit assignment.
Continue through source implementation, independent verification,
checkpoint integration, staging deploy, rollback rehearsal, and staging proof.

Do not deploy production without separate exact owner approval.
Do not claim live P0 PASS from staging.
Do not claim FABLE PASS.


PACKET AND TERMINAL GATES
-------------------------

TASK_ID:
  TM-P0-ULTIMATE-CONTROL-CENTER-V3

ROLE:
  CONTROL_PLANE_IMPLEMENTER

IMPLEMENTATION TARGET:
  TASK_MANAGER_STAGING_VERIFIED

LIVE TARGET:
  P0_TASK_MANAGER_MCP_PUBLIC_DASHBOARD_PASS

EVIDENCE ROOT:
  .artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/

EXACT TERMINAL RECEIPT:
  .artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/WORKER_RESULT_TM_P0_ULTIMATE_CONTROL_CENTER_V3.md

All task-manager evidence paths are relative to the authoritative source repo.
Do not assume authoritative source lives on the MFS VPS.


INPUT FABLE REVIEW RECEIPT
--------------------------

Existing program-emitted receipt:

  path:
    /tmp/01-task-manager-fable5-xhigh-review.json

  sha256:
    eadae4e7306aa677e7c460744807934e29df856fac75a01f1321714c556b8d51

  model:
    claude-fable-5

  effort:
    xhigh

  verdict:
    REQUIRES_REVISION

  runtime result:
    success

Existing program-emitted delta receipt:

  path on MFS VPS:
    /tmp/01-task-manager-fable5-xhigh-delta-review.json

  sha256:
    eeb9af48651b3c31e1e97933ed55e0ac52aed09731b30d246f2df5c1eefa45db

  model/effort:
    claude-fable-5 / xhigh

  advisory verdict:
    HANDABLE_PASS

The delta verdict is a successful advisory design review.
It is not independent implementation/runtime verification.

Before external implementation dispatch, recipient root copies both raw JSON
receipts byte-for-byte to an approved portable evidence locator, records their
portable URIs in RESOLVED_TARGET, and re-verifies both SHA-256 values.
The implementation host must fetch them read-only and verify the same hashes.
Never assume that /tmp is shared between the MFS VPS and external source host.

This proves current FABLE authentication/model invocation.
Do not report a current FABLE-auth blocker.

The review found required revisions for:

  - root-resolved target/write authority;
  - environment/gate taxonomy;
  - scheduler/runner/account ingestion;
  - FABLE failure handling;
  - authentication/RBAC;
  - worker-contract/root verifier dispatch;
  - MFS/public asset boundaries;
  - bucket/control-plane semantics;
  - staging-data provenance;
  - ibils regression authority;
  - observability;
  - heartbeat retention;
  - live lifecycle enum mapping;
  - UI stale/ongoing/decision/mobile/zoom behavior;
  - API pagination/idempotency/rate-limit/revision details;
  - acceptance, claim-audit, and actual rollback rehearsal.

Treat each as ACCEPTED_PENDING_IMPLEMENTATION.
This V3 incorporates the specification changes.
It does not claim implementation resolution.

If a required future FABLE execution fails programmatically:

  - capture exact command/error/model/effort;
  - create a blocking Decision;
  - use code BLOCKED_FABLE_UNAVAILABLE;
  - stop design-dependent implementation;
  - never bypass or substitute the mandatory design gate.

FABLE is advisory.
It is not independent code/runtime verification.


GATE TRUTH
==========

TASK_MANAGER_STAGING_VERIFIED requires:

  - root-resolved source/write target;
  - source implementation;
  - independent current-SHA verification;
  - staging schema/migration/backfill proof;
  - staging API/MCP/UI proof;
  - staging rollback and recovery proof;
  - accessibility/security/performance proof;
  - verified commits pushed.

TASK_MANAGER_STAGING_VERIFIED does not mean:

  - production task-manager deployed;
  - production DB migrated;
  - live MCP uses the release;
  - VPS public consumer uses the release;
  - live P0 passed;
  - mass refill unlocked.

Until separately approved production deployment and live readback:

  P0_TASK_MANAGER_MCP_PUBLIC_DASHBOARD_PASS:
    AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK

Live P0 requires:

  - exact owner approval;
  - approved production release SHA;
  - approved production migration;
  - deploy receipt;
  - task-manager UI/MCP live readback;
  - VPS public consumer readback;
  - revision/hash/count/freshness parity;
  - independent live verifier PASS;
  - root acceptance.

Staging PASS never unlocks live mass dispatch.


G0 — ROOT-SUPPLIED RESOLVED_TARGET
==================================

Before worker dispatch, the recipient root performs read-only discovery and
produces a populated, signed/versioned RESOLVED_TARGET artifact at an approved
portable evidence locator. The implementer consumes it read-only and cannot
populate, amend, or self-grant missing scope.

Required fields:

  resolvedTargetVersion
  issuedAt
  issuedBy
  taskId
  boardId
  portable FABLE review receipt URI and SHA
  portable FABLE delta receipt URI and SHA
  authoritative repoId
  authoritative source host
  authoritative checkout path
  remote identifier
  current checked-out branch
  upstream tracking ref
  integration branch
  starting full SHA
  allowed source pathspecs
  forbidden pathspecs
  staging URL
  staging database identifier
  staging deploy mechanism
  staging TLS status
  production URL
  production deploy mechanism
  public-consumer URL
  public-consumer source/deploy owner
  included additional repos, if any
  external adapter scope
  ibils regression suite path or decision
  evidence root

Root must resolve exact source repos and pathspecs.
The implementer cannot discover facts and self-grant write authority.

Execution is blocked before source edits when:

  - RESOLVED_TARGET is absent/incomplete;
  - source checkout is detached;
  - current branch has no upstream;
  - current branch differs from authorized integration branch;
  - allowed pathspec is unknown;
  - a dirty overlap exists;
  - an extra repo is needed but not granted;
  - deploy environment/authority is unresolved.

Create blocking Decision:

  DECISION_RESOLVED_TARGET_REQUIRED

The implementer may report discovered facts.
It may not switch branches or expand scope.
An absent, unreadable, hash-mismatched, or otherwise unverifiable artifact
returns DECISION_RESOLVED_TARGET_REQUIRED before any source write.


ENVIRONMENT AUTHORITY TABLE
===========================

Preflight must emit a completed table with observedAt.

Surface: task-manager production UI
  known URL: https://task-manager.mfsdev.net/
  class: PRODUCTION
  TLS: HTTPS baseline; validate certificate live
  default authority: read-only
  deploy mechanism: RESOLVED_TARGET
  gate closed: live P0 only after approved deploy/readback

Surface: task-manager production MCP
  known URL: https://task-manager.mfsdev.net/mcp
  class: PRODUCTION
  TLS: HTTPS baseline; validate certificate live
  default authority: read-only security probe
  deploy mechanism: same authoritative production release
  gate closed: live P0 only after approved deploy/readback

Surface: task-manager staging
  URL: exact RESOLVED_TARGET.stagingUrl
  class: STAGING
  TLS: exact RESOLVED_TARGET value, verified
  authority: staging source deploy/migration/test only
  deploy mechanism: exact RESOLVED_TARGET value
  gate closed: TASK_MANAGER_STAGING_VERIFIED only

Surface: VPS public consumer
  known URL: http://34.50.66.172/
  class: LIVE PUBLIC CONSUMER
  TLS baseline: HTTP/no TLS; recheck and record
  write authority: excluded unless exact additional repo/path granted
  deploy mechanism: discover and bind through RESOLVED_TARGET
  gate closed: participates in live P0 only

Surface: local/test
  URL: repo-defined
  class: TEST
  authority: disposable fixtures
  gate closed: checkpoint tests only

If staging is unnamed or inaccessible:

  BLOCKED_EXTERNAL_STAGING_DEPLOY_ACCESS

If production deployment is needed to close live P0:

  terminal live status remains
  AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK

No staging proof may be reported as live proof.


KNOWN SECURITY BASELINE TO RECHECK
==================================

Prior observed behavior, not guaranteed current:

  - unauthenticated UI redirected to /login;
  - unauthenticated MCP tools/list/read calls exposed
    board, lifecycle, run, and account data.

Preflight must:

  - record observedAt;
  - repeat UI unauthenticated probe;
  - repeat MCP initialize/tools/list/read probes;
  - capture status codes and sanitized response shapes;
  - avoid recording secrets;
  - compare against this baseline;
  - open P0 security blocker if exposure remains.

Threat-model remediation must make:

  unauthenticated access =
    sanitized allowlisted public snapshot only

No unauthenticated sensitive MCP board/lifecycle/run/account reads.


AUTHORITATIVE SOURCE AND PATH BOUNDARY
======================================

Default included scope:

  - exact authoritative task-manager source repo;
  - only RESOLVED_TARGET.allowedPathspecs;
  - source migrations;
  - source tests;
  - source documentation/contracts;
  - source staging deploy configuration when granted.

Default excluded scope:

  - all legacy repos;
  - all Myfitsociety product repos;
  - /opt/mfs/workspace/CONTRACT/**;
  - /var/www/contract/**;
  - /etc/nginx/** runtime files;
  - tools/grok-account-pool/**;
  - Grok/Spark/SOL runner source;
  - MFS sync adapters;
  - compiled bundles;
  - generated static output;
  - deployed vendor assets;
  - container layers;
  - ad hoc clones/copies.

An MFS consumer/adapter source repo is included only when:

  - separately listed in RESOLVED_TARGET;
  - exact source pathspecs are granted;
  - applicable instructions are read;
  - it receives a separate checkpoint/commit.

Never patch compiled public/nginx output.
Never use /var/www as source.
Runtime nginx mutation is outside this staging implementation task.

If public-consumer changes are excluded:

  - deliver MFS_CONTROL_PLANE_SYNC_API_V1;
  - deliver fixtures and conformance tests;
  - return a packet for a separately authorized MFS sync worker.

If authoritative external repo access is absent:

  BLOCKED_EXTERNAL_REPO_ACCESS

Do not clone an unapproved substitute.


CAIRN SECRET BOUNDARY
=====================

Canonical Cairn secret location on the MFS VPS only:

  /opt/mfs/secrets/cairn.env

Required mode:

  0600

Only an authorized MFS mutation worker may source it without printing:

  set -a
  source /opt/mfs/secrets/cairn.env
  set +a

Never copy the secret to:

  - external task-manager host;
  - source repo;
  - prompts;
  - FABLE bundle;
  - artifacts;
  - logs;
  - screenshots;
  - Git;
  - memory.

Every authorized Cairn mutation requires:

  - fresh entity expectedRev;
  - fresh boardRev;
  - mutation receipt;
  - lifecycle readback;
  - audit readback;
  - rollup readback.

This assignment does not authorize production mutation.


WORKER AND VERIFIER AUTHORITY
=============================

Every root-dispatched worker packet embeds WORKER_CONTRACT v1 verbatim.

Every packet includes:

  task/role ID
  exact model/effort
  finite scope
  target gate
  evidence/receipt paths
  allowed/forbidden paths
  Git boundary
  capacity reservation
  collisionScopeLockIds
  current source SHA

No worker self-spawns an unaccounted fleet.

The implementer:

  - does not select its verifier;
  - does not spawn its verifier;
  - does not instruct its verifier;
  - requests root to dispatch independent verification.

Root dispatches verifier under:

  - Spark max 10 live;
  - SOL max 10 global live/reserved;
  - Grok max 10 per healthy account;
  - total max 200;
  - conditional genuine-work floor 60;
  - CPU >=90 percent stop/drain.

Root immediately dispatches the integrator after verifier PASS and root
acceptance.


GIT INTEGRATION IDENTITY
========================

Dedicated Grok integrator identity:

  Gian Rhamadhan | nstegwart
  gian.devx@gmail.com

Integrator must prove/configure repo-local identity if incorrect.

Integrator:

  - uses current tracking branch;
  - stages explicit intended pathspecs;
  - excludes unrelated dirty paths;
  - commits conventionally;
  - pushes origin current HEAD;
  - returns full/short SHA and push: OK.

No worktree.
No branch switch.
No force push.
No no-verify.


PHASE 0 PREFLIGHT
=================

Read applicable source/deploy/security instructions completely.

Record:

  - RESOLVED_TARGET validation;
  - repo/branch/upstream/HEAD/dirty/remotes;
  - source/deploy host separation;
  - environment authority table;
  - TLS/certificate status;
  - database/migration system;
  - existing auth/session/identity mechanism;
  - existing design system;
  - live board/schema/lifecycle revisions;
  - live lifecycle enum;
  - current UI and MCP auth behavior;
  - existing ibils regression suite;
  - existing health/log/metric facilities;
  - existing pagination/idempotency/rate limits;
  - old runs/claims/locks/account state;
  - current stage with observedAt.

Read equivalent current MCP surfaces:

  get_board_hash
  get_rollup
  get_lifecycle
  list_tasks/get_task
  list_projects
  list_features
  list_runs
  list_accounts
  list_audit
  get_prod
  get_guide

All counts/hashes/times are program-emitted now.
Historical counts are not current truth.


LIVE LIFECYCLE ENUM DIFF
========================

Do not assume the proposed rail matches live enum.

Preflight emits:

  LIVE_LIFECYCLE_ENUM.json
  PROPOSED_LIFECYCLE_ENUM.json
  LIFECYCLE_ENUM_DIFF.json
  LIFECYCLE_MAPPING_V1.json

For every live state record:

  - exact live value;
  - current semantic meaning;
  - current evidence requirement;
  - proposed canonical state;
  - mapping type;
  - migration action;
  - rollback action;
  - ambiguity/blocker.

Mapping types:

  IDENTITY
  RENAME
  SPLIT
  MERGE
  LEGACY_ONLY
  UNMAPPED

SPLIT/MERGE/UNMAPPED requires a blocking root Decision.
No ad hoc lifecycle rewrite.


FABLE DESIGN DECISION LEDGER
============================

Copy only sanitized receipt content into repo-relative evidence.
Verify its SHA.

Create DESIGN_DECISIONS.md.

For each FABLE finding record:

  finding ID
  REQUIRES_REVISION source
  accepted specification patch
  target checkpoint
  implementation evidence
  status

Allowed status:

  ACCEPTED_PENDING_IMPLEMENTATION
  IMPLEMENTED_PENDING_VERIFICATION
  RESOLVED_AFTER_VERIFICATION
  REJECTED_WITH_ROOT_EVIDENCE

Do not mark resolved from prompt text.


INFORMATION ARCHITECTURE
========================

Primary navigation:

  1. Overview
  2. Work
  3. Priority
  4. Projects
  5. Features / Flows
  6. Agents / Runs
  7. Ops / Accounts
  8. Decisions
  9. Evidence / Audit

All counts use server filters and deep-link URLs.

Desktop Overview:

  +---------------------------------------------------------------+
  | board | live stage | freshness | connection | search | owner  |
  +---------------------------------------------------------------+
  | NEEDS YOUR DECISION | ordered top item | exact owner action    |
  +---------------------------------------------------------------+
  | PRIORITY | denominator | PROD_READY evidence | G5 | complete  |
  | capacity share | dispatch reason | blockers                   |
  +---------------------------------------------------------------+
  | GLOBAL | denominator | PROD_READY evidence | G5 | complete    |
  +---------------------------------------------------------------+
  | DONE | RECONCILIATION_PENDING | ONGOING | NEXT | QUEUED       |
  | BLOCKED | STALE overlay                                      |
  +---------------------------------------------------------------+
  | zero-click ONGOING agent/model/account/heartbeat/material age  |
  +---------------------------------------------------------------+
  | projects | lifecycle | G5 | decisions | material events       |
  +---------------------------------------------------------------+

Mobile order:

  1. board/stage/freshness app bar;
  2. Needs Your Decision card;
  3. priority;
  4. global;
  5. bucket tabs including RECONCILIATION_PENDING plus STALE chip;
  6. ONGOING cards;
  7. projects;
  8. G5;
  9. events.

On scroll, the decision card collapses to a sticky one-line pill:

  decision count
  top severity
  expand action

The sticky stack must not obscure content.


VISUAL, RESPONSIVE, AND ACCESSIBILITY
=====================================

Style:

  - polished operational control center;
  - calm neutral surfaces;
  - strong hierarchy;
  - high density without clutter;
  - semantic text+icon+color;
  - no raw generic admin table;
  - no decorative false progress.

Semantic colors:

  DONE:
    green + check + text

  ONGOING:
    blue + activity + text

  NEXT:
    violet + forward + text

  QUEUED:
    slate + queue + text

  hard/blocking-human BLOCKED:
    red + stop + text

  awaiting-reconciliation/stale:
    amber + warning + text

  HOLD:
    amber + pause + text

  EXCLUDE:
    muted + excluded + text

Required states:

  populated
  loading/skeleton
  empty
  zero-results
  partial
  stale
  disconnected
  error/retry
  forbidden
  needs-human

Viewports:

  1440x900
  1024x768
  390x844
  360x800

Required:

  - no accidental page overflow;
  - table-to-card/reflow at <=768 CSS px;
  - 200 percent browser zoom/reflow;
  - WCAG 2.2 AA;
  - 44x44 touch targets;
  - visible focus;
  - keyboard-only flows;
  - native semantics before ARIA;
  - reduced motion;
  - non-color-only status;
  - field-linked errors;
  - coalesced screen-reader live updates;
  - axe zero critical/serious.


CLASSIFICATION AND DISTINCT DENOMINATORS
========================================

taskClass:

  PRODUCT
  CONTROL_PLANE
  UNCLASSIFIED

disposition:

  ACTIVE
  HOLD
  EXCLUDE
  UNCLASSIFIED

contributesToProductReadiness is derived, never writable.

It is true only when:

  taskClass = PRODUCT
  and disposition = ACTIVE
  and classification proof is valid

UNCLASSIFIED:

  - migration default when proof is absent;
  - outside PRODUCT denominator;
  - visible DATA_INTEGRITY blocker;
  - prevents complete=true;
  - never guessed into PRODUCT.

All readiness fields and counts use DISTINCT task IDs bound to the same current
canonicalSnapshotId/hash, task hash, boardRev, and lifecycleRev. Stale or
superseded task revisions never enter a current rollup.

Reject aggregation when:

  - duplicate FC joins multiply a task;
  - duplicate node joins multiply a task;
  - duplicate dependency joins multiply a task;
  - one canonical task ID has conflicting primary ownership.

Required rollup fields:

  trackedWorkDenominator
  productDenominator
  stageProdReady
  prodReadyWithEvidence
  unclassifiedCount
  g5Pass
  complete

No ambiguous numerator field.

trackedWorkDenominator:

  DISTINCT current task IDs whose disposition is ACTIVE, plus DISTINCT
  classification-repair rows where taskClass or disposition is UNCLASSIFIED,
  or the required classification receipt is missing, invalid, or stale.
  Classification repair outranks disposition: these rows are included exactly
  once and forced to BLOCKED:DATA_INTEGRITY even when the other field says
  HOLD or EXCLUDE. Only fully classified, current-receipt-valid HOLD/EXCLUDE
  rows are visible outside tracked work.

productDenominator:

  DISTINCT current task IDs with taskClass=PRODUCT, disposition=ACTIVE, and a
  current-hash/revision valid classification/membership receipt.

stageProdReady:

  DISTINCT productDenominator task IDs whose current lifecycle stage is
  PROD_READY or LIVE_VERIFIED.

prodReadyWithEvidence:

  DISTINCT stageProdReady task IDs whose current task/evidence hashes,
  stage-specific receipts, independent verifier verdict, boardRev, and
  lifecycleRev are all valid.

unclassifiedCount:

  DISTINCT trackedWorkDenominator task IDs whose taskClass/disposition or
  required classification receipt is missing, invalid, stale, or UNCLASSIFIED.


CANONICAL READINESS POLICY
==========================

taskReadinessPolicyVersion:

  MFS_DELIVERY_READINESS_V1

Canonical task-stage weights:

  MAPPING          0
  MAPPED          10
  MAP_VERIFIED    20
  BUILT           45
  FUNCTIONAL      65
  INTEGRATED      75
  STAGING_PROVEN  90
  PROD_READY     100
  LIVE_VERIFIED  100 plus LIVE badge

rawTaskReadinessPercent:

  - task: exact stage weight;
  - rollup: one-decimal mean over DISTINCT productDenominator task IDs.

If productDenominator=0:

  rawTaskReadinessPercent=null
  boardReadinessPercent=null
  cappedBy=EMPTY_PRODUCT_SCOPE
  complete=false

Zero product scope never renders 100 and always fails closed pending an exact
scope/classification decision.

Do not alter task-stage weights for G5.

Board/portfolio numeric policy:

  boardReadinessPolicyVersion:
    MFS_BOARD_READINESS_G5_CAP_V1

  boardReadinessPercent:
    rawTaskReadinessPercent by default

  when rawTaskReadinessPercent would render 100.0
  and g5Pass=false:
    boardReadinessPercent=99.0
    cappedBy=G5

  when raw is 100 but current evidence is incomplete:
    boardReadinessPercent=99.0
    cappedBy=EVIDENCE

  when raw is 100 but UNCLASSIFIED/P0 blocker remains:
    boardReadinessPercent=99.0
    cappedBy=DATA_INTEGRITY_OR_P0

The cap is explicit, versioned, and displayed.
Never silently relabel it as task readiness.
99.95 or another boundary may not round to 100 unless complete=true.

complete is true only when:

  productDenominator > 0
  stageProdReady = productDenominator
  prodReadyWithEvidence = productDenominator
  g5Pass = true
  unclassifiedCount = 0
  no P0/data-integrity blocker

Mapping 20/20 at MAPPED remains 10.
Static fase/progress/pct never drives readiness.


ORDERED LIFECYCLE EVIDENCE RAIL
===============================

Canonical ordered rail:

  MAPPING
  MAPPED
  MAP_VERIFIED
  BUILT
  FUNCTIONAL
  INTEGRATED
  STAGING_PROVEN
  PROD_READY
  LIVE_VERIFIED

Every transition enforces:

  allowSkip=false
  fresh entity expectedRev
  fresh boardRev
  current canonical snapshot/task hash
  current evidence/receipt hashes
  registered, unexpired, unfenced author/verifier runs
  valid role/model separation
  immutable transition/audit receipt

MAPPED requires:

  mappingStructuralReceipt bound to current task/canonical hash.

MAP_VERIFIED requires:

  mappingReceipt plus an independent mapping-verifier verdict bound to current
  task/canonical/evidence hashes.

BUILT requires:

  implementationReceipt/buildReceipt and explicit intended changed source
  paths, all bound to the current task revision.

FUNCTIONAL requires:

  real runtime positive, negative, and regression proof plus independent
  functional-verifier receipt.

INTEGRATED requires:

  dedicated Grok COMMIT/INTEGRATE receipt containing repo, proven current
  tracking branch, full SHA, short SHA, explicit pathspecs, and push: OK.

STAGING_PROVEN requires:

  real staging API, UI, database, and readback evidence plus an independent
  staging verifier bound to the deployed SHA/schema/revisions.

PROD_READY requires:

  current target/staging evidence, complete current programmatic G5 evidence
  across all nine required domains, and an independent product-readiness
  verifier receipt.

LIVE_VERIFIED is separate and requires:

  exact owner productionApprovalId, approved deploy receipt, and independent
  live verification/readback bound to the live release and revisions.

Reject:

  skipped stages
  stale expectedRev or boardRev
  stale canonical/task/evidence hash
  missing/malformed/stale stage receipt
  same author/verifier agent or thread
  same-model pairing when the current lane requires an opposite model
  any other invalid role/model pairing
  expired, fenced, or unregistered run
  self-verification
  hand-typed/non-programmatic PASS


G5 CONTRACT
===========

Domains:

  security
  performance/capacity
  migration/data integrity
  rollback/restore
  backup/DR
  monitoring/alerts/runbooks
  config/secrets
  cutover rehearsal
  dependency/provider readiness

Each domain records:

  scope
  required
  status
  evidence receipt IDs/hashes
  verifier agent/model/run
  subject revision/hash
  findings
  blocker
  capturedAt
  expectedRev
  boardRev
  subject lifecycleRev

Status:

  NOT_STARTED
  IN_PROGRESS
  PASS
  FAIL
  BLOCKED

DESIGN_ONLY:10M_CAPACITY is not measured capacity.

g5Pass is server-derived and read-only. It is true if and only if all nine
required domains for the exact scope are current-revision, current-hash,
programmatically evidenced PASS with valid independent verifier receipts.
NOT_STARTED, IN_PROGRESS, FAIL, BLOCKED, missing, stale, superseded, or
unverified domain state makes g5Pass=false. No client, import, or human may
write g5Pass directly.


BUCKET TRUTH WITH OVERLAYS
==========================

Main work buckets are mutually exclusive:

  DONE
  RECONCILIATION_PENDING
  ONGOING
  NEXT
  QUEUED
  BLOCKED

STALE is an overlay/drilldown, not a sixth bucket.

STALE overlay includes:

  - stale data source;
  - expired/stalled run;
  - claim awaiting reconciliation;
  - stale dispatch plan;
  - stale account sync.

Product DONE:

  Stage 1:
    MAP_VERIFIED

  Stage 2:
    PROD_READY or LIVE_VERIFIED

CONTROL_PLANE DONE:

  current controlPlaneTargetGate has:
    independently verified PASS
    and root acceptance

CONTROL_PLANE remains outside PRODUCT readiness.

UNCLASSIFIED can never be DONE.
It is BLOCKED:DATA_INTEGRITY.

ONGOING requires:

  - task is not already DONE for current stage;
  - valid current-stage claim;
  - STARTING/RUNNING;
  - unexpired/fenced-valid lease;
  - no open blocking human decision.

A non-blocking decision does not demote ONGOING.

A completed task with lingering/stale claim:

  - remains DONE;
  - receives STALE_CLAIM overlay;
  - exposes reconciliation drilldown.

A valid claim targeting a gate beyond current-stage completion:

  - task remains DONE for current stage;
  - receives BEYOND_STAGE_ONGOING overlay;
  - run appears in Agents/Runs;
  - does not double-count ONGOING.

RECONCILIATION_PENDING:

  - deterministic primary bucket for a not-yet-completed tracked task whose
    ownership is stale, orphaned, expired, fenced, or otherwise awaiting the
    bounded reconciler;
  - includes a beyond-stage/mismatched-gate claim only when current-stage DONE
    is not already satisfied;
  - exposes exact run/claim/lock, dry-run action, age, and reconciliation owner;
  - cannot be treated as NEXT, QUEUED, ONGOING, or product progress.

The completed-task exception is deterministic: if current-stage completion is
already satisfied, primary bucket remains DONE and the reconciliation issue is
an overlay/drilldown rather than RECONCILIATION_PENDING.

NEXT requires:

  - active root-published dispatch plan item;
  - dependencies/stage satisfied;
  - no claim/blocker;
  - exact rank/reason/current revisions.

QUEUED:

  - eligible but not root-selected;
  - or waiting only for healthy capacity.

BLOCKED:

  dependency
  blocking decision
  rejected evidence
  collision
  missing access
  data-integrity failure

Precedence:

  1. taskClass/disposition UNCLASSIFIED or missing/invalid/stale required
     classification receipt -> BLOCKED:DATA_INTEGRITY and tracked once,
     regardless of the other field or HOLD/EXCLUDE value;
  2. only fully classified, current-receipt-valid HOLD/EXCLUDE stays outside
     active tracked buckets;
  3. current-stage DONE;
  4. stale/orphan/expired/fenced ownership -> RECONCILIATION_PENDING;
  5. blocking human decision -> BLOCKED;
  6. valid current-stage claim -> ONGOING;
  7. hard blocker -> BLOCKED;
  8. active dispatch-plan selection -> NEXT;
  9. eligible -> QUEUED;
 10. other malformed data -> BLOCKED:DATA_INTEGRITY.

Coverage uses DISTINCT current-hash/revision task IDs:

  trackedWorkDenominator =
    DONE + RECONCILIATION_PENDING + ONGOING + NEXT + QUEUED + BLOCKED

All ACTIVE PRODUCT/CONTROL_PLANE tasks plus UNCLASSIFIED classification-repair
rows are covered exactly once.


ONGOING ZERO-CLICK UI
=====================

Every ONGOING row/card displays without opening detail:

  task ID/title
  target gate
  agent ID
  role
  model/effort
  masked account
  started age
  heartbeat age
  material-progress age
  PRODUCTIVE/IDLE/STALLED
  evidence link

Sort:

  stalled first
  then oldest material-progress age
  then task ID

Never expose account credential.


DECISION INBOX
==============

Fields:

  decisionId
  board/project/feature/task/run IDs
  type/severity
  title/question
  evidence
  options/tradeoffs
  agent recommendation
  blocking
  dueAt
  createdAt
  snoozedUntil
  status
  owner/resolver
  selected option/comment
  expectedRev
  boardRev
  scoped approvalId
  audit IDs

Status:

  OPEN
  ACKNOWLEDGED
  RESOLVED
  REJECTED
  EXPIRED
  CANCELLED

Ordering:

  blocking descending
  severity CRITICAL > HIGH > MEDIUM > LOW
  dueAt ascending, null last
  createdAt ascending
  decisionId ascending

Snoozed non-blocking items re-surface at snoozedUntil.
Blocking decisions cannot be hidden by snooze.

REJECTED means the request itself was rejected.
A declining option is a RESOLVED request with selected option.

Decision does not broaden production/HOLD/provider authority.


CONTROL-PLANE INGESTION CONTRACT
================================

Contract version:

  MFS_CONTROL_PLANE_SYNC_API_V1

publish_dispatch_plan:

  caller:
    ROOT_ORCHESTRATOR only

  payload:
    boardId
    planId/version/hash
    canonicalSnapshotId/hash
    expectedBoardRev
    issuedAt/expiresAt
    stage
    ranked items

  each item:
    rank
    taskId
    targetGate
    role
    selectionReason
    priorityPortfolioId
    dependency proof
    collisionScopeLockIds
    expectedEntityRev
    expectedBoardRev

It is the sole source of selectedForNextDispatch and NEXT.
No UI/agent computes NEXT independently.

register_run:

  caller:
    AGENT

  binds:
    runId
    planId/item
    task/gate/role
    agent/model/effort
    masked account reference
    canonical hash
    collision locks
    expected revisions

  idempotent on:
    runId and idempotency key

heartbeat_run:

  caller:
    owning AGENT

  binds:
    runId
    fencing token
    heartbeat sequence
    materialProgressAt when material
    expected revisions

  duplicate sequence:
    replay prior response

sync_accounts:

  caller:
    ROOT_ORCHESTRATOR or separately authorized MFS sync identity

  payload:
    masked account ID
    ACTIVE/OK/LIMIT/BAN/403/AUTH_EXPIRED/quarantine/REMOVED
    effective in-use/cap
    physical slots/20 display-only
    adaptive quota state
    reason/time
    source revision/generatedAt

  mandatory publication triggers:
    orchestrator/wave/agent launch
    heartbeat or material assignment/status transition
    LIMIT/BAN/403/AUTH_EXPIRED transition
    account rotation or work requeue
    checkpoint integration or wave close
    periodic health checkpoint

  freshness:
    every triggered state reaches MCP, API, authenticated UI, and Ops with the
    same source revision/generatedAt within 30 seconds;
    heartbeat updates may be coalesced but the newest state is published within
    30 seconds;
    periodic health publication runs at least every 60 seconds.

No account transition may remain server-local. A missed/stale publication sets
stale=true, emits ACCOUNT_SYNC_STALE alert/audit, makes usableCapacity=0 for
new dispatch, and fails closed until a same-revision MCP/API/UI/Ops readback
passes.

Never transmit account tokens.

Pool/runner/MFS adapter edits are outside this task unless explicitly granted
in RESOLVED_TARGET.

When excluded, return:

  - versioned OpenAPI/MCP schema;
  - JSON examples;
  - conformance tests;
  - separate MFS sync-worker packet.


RUN, CLAIM, AND LOCK STATE
==========================

Run states:

  QUEUED
  RESERVED
  STARTING
  RUNNING
  WAITING_HUMAN
  SUCCEEDED
  FAILED
  CANCELLED
  STALE
  SUPERSEDED

QUEUED:

  - no heartbeat lease;
  - no task claim.

RESERVED:

  - reservation expiry;
  - fencing version;
  - temporary claim/locks.

STARTING/RUNNING/WAITING_HUMAN:

  - registeredAt;
  - heartbeatAt;
  - leaseExpiresAt;
  - controller/parent;
  - agent/model/effort/role;
  - task/gate;
  - plan item;
  - canonical hash;
  - expected revisions;
  - collision locks.

Defaults:

  visible <=30 seconds
  heartbeat <=15 seconds
  lease 60 seconds
  reconciliation grace 30 seconds
  stalled after 10 minutes without material progress

Heartbeat proves liveness only.
It does not prove productivity or completion.


ATOMIC COLLISION LOCKS
======================

Task/write locks:

  collisionScopeLockIds

Requirements:

  - deterministic canonical lock IDs;
  - include repo/path/resource collision domains;
  - acquire all atomically at register/reserve;
  - leased and fencing-token bound;
  - renew with valid heartbeat;
  - release atomically at terminal state;
  - late/fenced actor cannot mutate;
  - overlapping cross-task path scopes conflict;
  - conflicting author/verifier/write roles are rejected.

Supersession:

  - fencing check and current-pointer flip are atomic;
  - old history remains immutable.

Integration lock:

  key:
    repoId + trackingBranch

  invariant:
    exactly one live COMMIT_INTEGRATE per key

  requirements:
    root acceptance ID
    checkpoint ID
    explicit pathspecs
    lease/fencing
    dedicated Grok integrator

No second integrator starts until lock release.


HEARTBEAT RETENTION AND RECONCILIATION
======================================

Heartbeat updates latest run/lease state.
Every heartbeat is not an immutable audit event.

Immutable audit records only material events:

  registration
  first live
  material progress
  stalled transition
  recovered transition
  fence/supersede
  terminal state
  policy change

BoardPolicy exposes:

  heartbeat sample interval
  hot-state retention
  sampled-event retention
  rollup retention
  compaction schedule

Reuse existing retention policy.
If none exists:

  create DECISION_HEARTBEAT_RETENTION_POLICY
  test a proposed policy on staging
  do not invent production retention silently.

Reconciler:

  - one leader/fencing lease;
  - maxActionsPerRun default 100;
  - bounded cursor/time budget;
  - revision-bound dry-run;
  - persisted item-level before/after diff;
  - dryRunHash;
  - apply requires same dryRunHash/current revisions;
  - classify live/terminal/stale/orphan/requeue/manual;
  - preserve history;
  - emit counts and IDs;
  - rerun idempotency proof.


VERSIONED CANONICAL SNAPSHOT
============================

No direct cross-host CONTRACT filesystem read.

Schema:

  MFS_CANONICAL_TASK_SNAPSHOT_V1

Manifest:

  schemaVersion
  boardId
  snapshotId
  sourceRepoId
  sourceCommitSha
  generatedAt
  canonicalizationAlgorithm
  payloadSha256
  DISTINCT counts
  producerVersion

Payload:

  projects
  Feature Flows/nodes
  tasks
  dependencies
  classifications
  anchors
  acceptance/evidence paths

Producer:

  deterministic canonical JSON
  stable sorted IDs/relations
  schema validation
  SHA-256
  no secrets

Importer:

  authenticated import scope
  schema/hash validation
  DISTINCT ID validation
  duplicate FC/node join rejection
  dependency/reference/cycle validation
  entityExpectedRev
  expectedBoardRev
  idempotency key
  stale/out-of-order rejection
  immutable provenance
  audit/readback

Definition import cannot fabricate lifecycle evidence.


AUTHENTICATED READ API/MCP CONTRACT
===================================

Canonical authenticated read methods:

  get_overview
  list_work_items
  list_projects / get_project
  list_features / get_feature
  list_tasks / get_task
  list_runs / get_run
  list_accounts / get_account
  list_decisions / get_decision
  list_activity
  list_audit
  get_priority_portfolio
  get_g5
  get_prod
  get_guide

Existing names such as get_rollup, get_lifecycle, get_board_hash, and other
current aliases remain versioned compatibility aliases to the same
authorization, pinned aggregation, filters, cursor, and schema contract.

Every authenticated read uses an authorized scope, a pinned query/snapshot
revision, validated filters, and the stable cursor contract below.

Common envelope:

  schemaVersion
  boardId
  canonicalSnapshotId
  canonicalHash
  boardRev
  lifecycleRev
  generatedAt
  freshnessAgeSeconds
  stale
  staleReason
  data
  nextCursor

No read surface independently recomputes counts or readiness.


API REVISION, CURSOR, AND IDEMPOTENCY
====================================

Every mutation requires:

  entityExpectedRev
  expectedBoardRev
  subject/canonical hash
  idempotency key
  authorized role/scope

Revisions are monotonic integers.

If either revision mismatches:

  STALE_REVISION

Return current safe revision metadata.

Cursor pagination:

  stable key:
    createdAt, id

  default order:
    createdAt DESC, id DESC

  default page size:
    50

  maximum page size:
    200

  cursor:
    opaque encoding of last createdAt,id

Filtering uses a pinned query/snapshot revision.

Idempotency:

  scope:
    actor + board + endpoint + key

  TTL:
    24 hours

  same key + same canonical request hash:
    replay original status/body

  same key + different request hash:
    409 IDEMPOTENCY_CONFLICT

register_run is also unique/idempotent on runId.

Typed errors:

  STALE_REVISION
  INVALID_TRANSITION
  MISSING_EVIDENCE
  STALE_HASH
  SELF_VERIFICATION
  INVALID_VERIFIER_ROLE
  RUN_NOT_REGISTERED
  LEASE_EXPIRED
  FENCED
  CLAIM_COLLISION
  INTEGRATION_LOCKED
  HOLD_OR_EXCLUDE
  UNCLASSIFIED_SCOPE
  AUTHORIZATION_REQUIRED
  DECISION_EXPIRED
  IDEMPOTENCY_CONFLICT
  DATA_INTEGRITY


PINNED PUBLIC SNAPSHOT
======================

Materialize public output from one aggregation result at pinned:

  canonicalSnapshotId/hash
  boardRev
  lifecycleRev
  serializerVersion

ETag:

  SHA-256 of the pinned revision tuple and payload

Conditional GET:

  matching If-None-Match -> 304

Allowlisted fields:

  board/global rollup
  priority rollup
  explicit completion fields
  project/feature/task summaries
  bucket/STALE counts
  sanitized run summaries
  masked account summaries
  public decision count only
  G5
  revisions/hash/generatedAt/freshness

Exclude:

  tokens/secrets
  private decision titles/text
  owner comments
  raw environment/process data
  sensitive evidence bodies
  unmasked identity

Numeric public rate limit:

  policy:
    PUBLIC_SNAPSHOT_RATE_LIMIT_V1

  sustained:
    60 requests/minute/IP

  burst:
    20

  response:
    429 + Retry-After

The policy is configurable and tested.
Unauthenticated requests cannot reach sensitive MCP methods.


AUTH AND RBAC
=============

Reuse the existing proven task-manager auth/session mechanism.

If no adequate mechanism exists:

  - create blocking DECISION_AUTH_MECHANISM_REQUIRED;
  - provide threat-model options/tradeoffs;
  - do not invent production auth silently.

Roles:

  OWNER
  ROOT_ORCHESTRATOR
  AGENT
  INTEGRATOR
  PUBLIC

OWNER:

  - sensitive read;
  - resolve Decisions;
  - exact approvals/policy;
  - cannot impersonate agent evidence.

ROOT_ORCHESTRATOR:

  - publish dispatch plan;
  - lifecycle acceptance/transition;
  - reconciliation authorization;
  - account sync authorization;
  - dispatch verifier/integrator;
  - no owner-only production approval.

AGENT:

  - read assigned bounded context;
  - register/heartbeat own run;
  - submit evidence;
  - request Decision;
  - no dispatch plan;
  - no final acceptance;
  - no account raw data.

INTEGRATOR:

  - read accepted checkpoint/pathspecs;
  - acquire repo integration lock;
  - submit commit/push receipt;
  - no lifecycle self-acceptance.

PUBLIC:

  - sanitized public snapshot only.

Sensitive MCP read scopes:

  board:read
  task:read
  run:read
  account:read
  decision:read
  evidence:read
  audit:read

Write scopes:

  dispatch:write
  lifecycle:write
  run:write
  decision:write
  import:write
  reconcile:write
  account:sync
  integration:write
  policy:write

Browser writes require CSRF protection.
Owner/high-risk action uses step-up auth where existing mechanism supports it.


THREAT MODEL
============

Produce THREAT_MODEL.md.

Cover:

  actors/assets/trust boundaries
  external Cairn source/deploy host
  MFS VPS consumer
  UI/MCP/public entrypoints
  canonical import
  runner/account ingestion
  decisions/evidence
  deployment pipeline
  spoofing/tampering/repudiation/disclosure/DoS/elevation
  XSS/CSRF/SSRF/injection/path traversal
  replay/stale revision
  receipt forgery
  malicious agent text
  public data leakage
  known unauthenticated MCP baseline

Test mitigations and residual blockers.


FULL CAPACITY POLICY
====================

Represent and enforce the current versioned policy exactly:

  - exact gpt-5.3-codex-spark <=10 live;
  - exact gpt-5.6-sol <=10 live/reserved globally across all efforts;
  - Grok starts at 5 per healthy account and stays within 5–10/account;
  - Grok supplies the majority of safe live execution capacity;
  - combined Grok+Spark+SOL <=200;
  - maintain >=60 total live if and only if >=60 genuine, unique,
    dependency-ready, collision-safe packets exist and account/quota/CPU/RAM/
    load health permits;
  - otherwise publish BELOW_FLOOR with program-emitted live count and exact
    limiting reason;
  - CPU >=90 percent stops new dispatch and boundedly drains/reduces;
  - LIMIT stops assignment, preserves/requeues unfinished work, and rotates;
  - BAN, 403 permission-denied, and AUTH_EXPIRED quarantine without
    retry-hammering;
  - tombstone/removed accounts contribute zero usable capacity;
  - physical slots/20 is display-only, never dispatch authorization;
  - never use --accounts all;
  - never duplicate, fabricate, or artificially split filler work.

Process count and heartbeat count never equal product progress.


PRIORITY ALLOCATION
===================

Portfolio:

  SALES_WEB_RELATED_BACKEND

Membership:

  ACTIVE sales-rebuild PRODUCT with current receipt-valid membership
  ACTIVE mfs-web-original-upgrade PRODUCT with current receipt-valid membership
  ACTIVE backend PRODUCT with current receipt-valid strict direct dependency
  proof to either outcome

Exclude HOLD, EXCLUDE, UNCLASSIFIED, stale/superseded membership receipts, and
non-PRODUCT rows from portfolio membership and its product denominator.

schedulableClosurePacket:

  genuine
  unique
  current-hash
  dependency-ready
  collision-safe
  advances an open closure gate

Included closure roles:

  Stage 1:
    INVENTORY
    TASK_AUTHOR
    FC_LINKER
    MAPPING_VERIFY
    REPAIR_FILL
    MERGE_PUBLISH

  Stage 2:
    required ANALYZE
    PRODUCT
    VERIFY
    REPAIR_FILL
    COMMIT_INTEGRATE
    STAGING_PROOF
    G5 closure

Exclude:

  root
  idle controller
  health-only process
  non-runnable
  duplicate/filler
  expired/fenced

priorityClosureCapacity:

  live+reserved schedulable closure packets
  for portfolio or strict closure dependencies

allClosureCapacity:

  all live+reserved schedulable closure packets

majorityAllocationPass:

  priorityClosureCapacity / allClosureCapacity > 0.5
  when genuine priority frontier exists

Fail-closed/N-A semantics:

  - if allClosureCapacity=0 and a genuine runnable priority frontier exists:
    priorityCapacityShare=null, majorityAllocationPass=false, reason=
    ZERO_SCHEDULABLE_CAPACITY;
  - if no genuine runnable priority frontier exists:
    priorityCapacityShare=null and majorityAllocationPass=null, never PASS;
    publish exact state PRIORITY_FRONTIER_COMPLETE, PRIORITY_FRONTIER_BLOCKED,
    or PRIORITY_FRONTIER_EMPTY plus blockers/recheck;
  - no denominator, empty frontier, or stale receipt may be rendered as
    majority success or portfolio completion.

Non-priority allowed only if it cannot delay P0:

  STRICT_DIRECT_DEPENDENCY
  NON_DELAYING_SPARE_CAPACITY
  PRIORITY_FRONTIER_BLOCKED
  PRIORITY_FRONTIER_EXHAUSTED

Record proof.


STAGING DATA PROVENANCE
=======================

Production read authority and staging load authority are separate.

Before using production-derived data require:

  productionReadApprovalId
  stagingLoadApprovalId
  allowed fields
  redactionPolicyVersion
  purpose/expiry

Export manifest:

  source environment
  observedAt/exportedAt
  source revision/hash
  export tool/version
  field allowlist
  redaction policy
  record counts
  payload hash
  destination
  approvals

Never copy:

  tokens/secrets
  private decision text
  owner comments
  raw account identity
  production credentials
  unnecessary PII

If either authority is absent:

  use synthetic staging fixtures
  do not copy production data

Staging load is idempotent, isolated, reversible, and cleaned after tests.


IBILS REGRESSION AUTHORITY
==========================

Preflight locates:

  exact ibils suite path
  fixtures
  supported flows
  baseline command
  current program output

If absent:

  create DECISION_IBILS_CHARACTERIZATION_AUTHORITY

The Decision asks whether to:

  - authorize characterization tests from proven current behavior;
  - provide an external suite;
  - exclude an exact unsupported surface with owner reason.

Do not invent expected ibils behavior.
Absence blocks final staging verification, not safe preflight.


OBSERVABILITY
=============

Authenticated /healthz returns:

  service status
  deployed full SHA
  schema version
  migration status
  canonical snapshot ID
  board/lifecycle revision
  dependency health

Staging deploy passes only when /healthz SHA/schema match expected.

Structured logs:

  timestamp
  requestId
  boardId
  actor role/ID
  endpoint/event
  result/error code
  latency
  revisions

No secret/private payload.

Metrics:

  API latency/error rate
  auth denies
  dispatch-plan age
  runner registration latency
  heartbeat lag/error
  stalled runs
  claim/lock conflict
  reconciler actions/failures
  canonical import failures
  aggregation duration
  snapshot freshness/mismatch
  Decision backlog
  account-sync freshness
  duplicate-join rejection

Alerts:

  unhealthy release/schema mismatch
  public freshness >2 publication intervals
  repeated import/reconcile failure
  live MCP unauthorized exposure
  account sync stale
  claim-lock anomaly
  error/latency budget breach

Provide staging alert tests and runbook.


MIGRATION
=========

Use versioned non-destructive migrations.

Sequence:

  1. schema dry-run;
  2. live enum diff/mapping approval;
  3. UNCLASSIFIED fields;
  4. constraints/indexes;
  5. backfill dry-run;
  6. before snapshot;
  7. staging apply;
  8. source-grounded classification;
  9. duplicate-join validation;
 10. stale reconcile dry-run/apply;
 11. parity;
 12. idempotency rerun;
 13. prior-SHA rollback rehearsal;
 14. current-SHA restore/re-apply.

Never guess PRODUCT.
Legacy static fields remain namespaced and never drive readiness.
Preserve audit/receipts and tenant isolation.


ROLLBACK VERSUS FORWARD-FIX
===========================

Before deploy classify each migration:

  REVERSIBLE
  EXPAND_CONTRACT_BACKWARD_COMPATIBLE
  FORWARD_FIX_ONLY

Rollback trigger:

  - app/API/UI failure;
  - security regression;
  - schema compatible with prior release;
  - rollback does not lose accepted data.

Forward-fix trigger:

  - rollback would lose/corrupt data;
  - irreversible transform already applied;
  - prior release is incompatible with safe current schema.

Staging rehearsal always includes:

  - record current and actual previous full SHA;
  - deploy current;
  - apply migration;
  - execute smoke;
  - redeploy actual previous SHA;
  - use compatible schema or restored disposable DB snapshot;
  - run prior-SHA /healthz and smoke;
  - redeploy current SHA;
  - re-apply/forward-fix;
  - prove data/readiness integrity.

A document-only rollback plan is not proof.


UI SCREEN CONTRACT
==================

Overview:

  mission questions
  priority/global truth
  buckets+STALE
  zero-click ONGOING
  decision pill/card
  freshness/health

Work:

  DONE/RECONCILIATION_PENDING/ONGOING/NEXT/QUEUED/BLOCKED tabs
  STALE overlay filter
  server pagination
  deep-link filters

Priority:

  membership proof
  DISTINCT rollups
  G5
  all-role capacity
  non-priority reason

Projects/Features:

  source-derived rollups
  full Feature Flow
  success/fail/expired branches
  page/API/rule/style/data/geo/provider/readback

Task detail:

  legacy->rebuild anchors
  lifecycle/current stage
  bucket/overlays
  current/historical runs
  decisions
  evidence/verifier
  dependencies/collision locks
  commit/push proof

Agents/Runs:

  agent/model/account
  plan item
  claim/locks
  heartbeat/material ages
  productive/idle/stalled
  controller/parent
  terminal history

Ops/Accounts:

  masked status/capacity
  source revision/freshness
  LIMIT/quarantine/tombstone
  sync audit

Decisions:

  deterministic order
  blocking first
  options/tradeoffs/recommendation
  snooze rules
  audit

Evidence/Audit:

  immutable material events
  sampled heartbeat policy
  hashes/revisions
  verifier/integration


PERFORMANCE AND FRESHNESS
=========================

Use stack-supported SSE/WebSocket/bounded polling.

Measured programmatically:

  real authorized runner registration visible <=30 seconds
  authenticated material update <=30 seconds
  public staging snapshot <=60 seconds
  timestamps from server clocks

Handle:

  reconnect
  duplicate
  out-of-order
  stale plan/snapshot
  manual refresh

Synthetic staging scale:

  1,000 tasks
  200 live/reserved runs
  20 account/tombstone records
  100 open decisions

Budgets:

  warmed API p95 <=500ms
  20 heartbeat/register req/s for 10 minutes
  error <1 percent excluding expected validation
  LCP or explicit Overview-ready marker <=2.5s
  filter feedback <=200ms after data
  bounded payload/query
  no N+1

Not a 10M production claim.


CHECKPOINTS
===========

G0 — Authority resolution

  RESOLVED_TARGET
  environment table
  source/path boundary
  auth discovery
  ibils suite/Decision
  FABLE receipt SHA
  live auth baseline

Gate:

  root sign-off before source edits

C0 — Design and threat model

  FABLE ledger
  IA/UX
  threat model
  lifecycle enum diff/mapping
  schema/API/migration plan

C1 — Schema/readiness/import

  classification/UNCLASSIFIED
  exact weights
  explicit board cap
  DISTINCT rollups
  canonical snapshot/import
  revisions/idempotency

C2 — Ingestion/run/auth

  dispatch plan
  register/heartbeat/account sync contract
  claims/collision/integration locks
  stale reconciler
  RBAC/rate limit
  decisions/audit retention

C3 — Aggregation/public/UI

  one pinned aggregation
  buckets/overlays
  priority all-role allocation
  public snapshot/ETag
  nine screens
  responsive/accessibility

C4 — Staging data/migration/ops

  approved/synthetic provenance
  migration/backfill
  reconciliation
  ibils regression
  health/log/metrics/alerts
  performance/security

C5 — Rollback/FABLE/final staging verify

  actual prior-SHA redeploy
  current-SHA recovery
  post-staging FABLE critique
  repairs
  root-dispatched independent verifier
  checkpoint integration receipts

Terminal:

  TASK_MANAGER_STAGING_VERIFIED
  live P0 AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK


POST-STAGING FABLE GATE
=======================

Use exact claude-fable-5 xhigh non-interactive JSON.

Supply:

  screenshot manifest
  all declared mission questions mapped to evidence
  staging SHA/schema
  revisions/hash
  all responsive states
  prior review finding ledger

If unavailable:

  BLOCKED_FABLE_UNAVAILABLE

Do not substitute.
Do not mark resolved without program output and implementation proof.


ACCEPTANCE MATRIX
=================

AC-GATE-01:
  staging PASS emits TASK_MANAGER_STAGING_VERIFIED

AC-GATE-02:
  staging never emits live P0 PASS/unlock

AC-GATE-03:
  live remains AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK

AC-TARGET-01:
  RESOLVED_TARGET repo/branch/upstream/pathspecs proven

AC-TARGET-02:
  detached/unknown target blocks before edits

AC-TARGET-03:
  no compiled/nginx/public asset patch

AC-TARGET-04:
  root-produced RESOLVED_TARGET and both portable FABLE receipt hashes verify

AC-ENV-01:
  all known URLs/classes/TLS/deploy mechanisms/gates recorded with observedAt

AC-AUTH-01:
  unauth UI/MCP baseline rechecked

AC-AUTH-02:
  unauthenticated access reaches sanitized public snapshot only

AC-AUTH-03:
  OWNER/ROOT/AGENT/INTEGRATOR/PUBLIC matrix enforced

AC-AUTH-04:
  read/write scopes and CSRF enforced

AC-AUTH-05:
  public 60/min/IP burst20 limit and 429 tested

AC-CLASS-01:
  PRODUCT/CONTROL_PLANE/UNCLASSIFIED valid

AC-CLASS-02:
  ACTIVE/HOLD/EXCLUDE/UNCLASSIFIED valid

AC-CLASS-03:
  contribution derived/read-only

AC-CLASS-04:
  UNCLASSIFIED outside denominator and blocks complete

AC-CLASS-05:
  cross-product fixtures prove taskClass=UNCLASSIFIED with disposition=HOLD
  and EXCLUDE, plus PRODUCT/CONTROL_PLANE with disposition=UNCLASSIFIED, and
  any HOLD/EXCLUDE row with missing/stale classification receipt are each
  tracked once as BLOCKED:DATA_INTEGRITY; only fully classified,
  current-receipt-valid HOLD/EXCLUDE fixtures remain outside tracked buckets

AC-COUNT-01:
  all rollups count DISTINCT task IDs

AC-COUNT-02:
  duplicate FC/node/dependency joins are rejected

AC-READY-01:
  weights exactly 0/10/20/45/65/75/90/100

AC-READY-02:
  rawTaskReadinessPercent preserves task weights

AC-READY-03:
  board 99 cap is versioned and displays cappedBy

AC-READY-04:
  G5/evidence/data blockers prevent complete

AC-READY-05:
  mapping 20/20 at MAPPED is 10

AC-READY-06:
  all readiness fields use DISTINCT current-hash/revision task IDs

AC-READY-07:
  productDenominator=0 returns null readiness, complete=false, never 100

AC-LIFE-01:
  live enum diff/mapping exists

AC-LIFE-02:
  ambiguous split/merge blocks migration

AC-LIFE-03:
  skip/stale hash/missing evidence/self-verify rejected

AC-LIFE-04:
  every ordered stage enforces its exact current receipt and fresh revisions

AC-LIFE-05:
  g5Pass is read-only and false unless all nine current domains independently
  and programmatically PASS

AC-BUCKET-01:
  DISTINCT active bucket sum holds across all taskClass values

AC-BUCKET-02:
  only blocking Decision blocks ONGOING

AC-BUCKET-03:
  completed task stays DONE with stale/beyond-stage overlay

AC-BUCKET-04:
  CONTROL_PLANE verified gate maps to DONE without product progress

AC-BUCKET-05:
  STALE chip/drilldown matches overlay rows

AC-BUCKET-06:
  trackedWorkDenominator includes ACTIVE plus UNCLASSIFIED repair rows once

AC-BUCKET-07:
  incomplete stale/orphan ownership maps to RECONCILIATION_PENDING while a
  completed task stays DONE with reconciliation overlay

AC-INGEST-01:
  publish_dispatch_plan is sole NEXT source

AC-INGEST-02:
  dispatch rank/reason/revisions match NEXT in MCP/API/UI

AC-INGEST-03:
  real authorized runner registration appears <=30 seconds

AC-INGEST-04:
  register/heartbeat idempotency works

AC-INGEST-05:
  masked account sync matches authorized pool state

AC-ACCOUNT-01:
  launch publishes masked account state to MCP/API/UI/Ops within SLA

AC-ACCOUNT-02:
  heartbeat/material assignment/status transition publishes within SLA

AC-ACCOUNT-03:
  LIMIT/BAN/403/AUTH_EXPIRED transition publishes within SLA

AC-ACCOUNT-04:
  rotation/requeue publishes within SLA

AC-ACCOUNT-05:
  integration/wave close publishes within SLA

AC-ACCOUNT-06:
  periodic health checkpoint publishes at least every 60 seconds

AC-ACCOUNT-07:
  source revision/generatedAt parity is exact; missed/stale publication alerts,
  sets usableCapacity=0, fails closed, and leaves no server-local-only state

AC-LOCK-01:
  overlapping cross-task path collision is atomically rejected

AC-LOCK-02:
  collision lock lease/fence/terminal release works

AC-LOCK-03:
  repoId+trackingBranch permits exactly one integrator

AC-LOCK-04:
  supersession pointer+fencing is atomic

AC-API-01:
  cursor createdAt,id default50/max200 is stable

AC-API-02:
  idempotency replay/conflict/24h TTL works

AC-API-03:
  entityExpectedRev+expectedBoardRev mismatch returns STALE_REVISION

AC-API-04:
  all canonical authenticated reads return the common pinned envelope, aliases,
  filters, and cursor semantics

AC-CAP-01:
  Spark<=10, SOL<=10 global, Grok starts5 and remains5–10/healthy account,
  Grok majority, combined<=200

AC-CAP-02:
  >=60 applies iff >=60 genuine unique ready collision-safe packets and health
  permit; otherwise exact BELOW_FLOOR count/reason

AC-CAP-03:
  CPU/LIMIT/quarantine/tombstone/physical20/accounts-all/filler rules enforce
  the full fail-safe policy

AC-PRIORITY-01:
  membership contains current receipt-valid ACTIVE PRODUCT task IDs only

AC-PRIORITY-02:
  zero allClosureCapacity and no-frontier cases return exact false/null/N-A
  semantics and never majority PASS

AC-PUBLIC-01:
  snapshot is pinned/materialized once

AC-PUBLIC-02:
  ETag matches revision/payload hash and 304 works

AC-PUBLIC-03:
  redaction excludes private/sensitive fields

AC-DATA-01:
  production-read/staging-load approvals and redaction provenance enforced

AC-DATA-02:
  no authority uses synthetic fixtures only

AC-IBILS-01:
  located suite passes or characterization Decision blocks final gate

AC-OPS-01:
  /healthz full SHA/schema matches deploy

AC-OPS-02:
  structured logs omit secrets

AC-OPS-03:
  required metrics/alerts/runbook tested

AC-OPS-04:
  heartbeat is not immutable per-event audit

AC-OPS-05:
  retention/compaction and bounded reconciler tested

AC-UI-01:
  all nine IA screens and states exist

AC-UI-02:
  ONGOING zero-click fields/ages present

AC-UI-03:
  Decision order and mobile sticky pill deterministic

AC-UI-04:
  1440/1024/390/360 viewports pass

AC-UI-05:
  200 percent zoom/reflow passes

AC-UI-06:
  keyboard/axe/WCAG checks pass

AC-UI-07:
  all declared mission questions map to annotated screenshots/evidence

AC-PERF-01:
  stated staging scale/latency/freshness budgets pass programmatically

AC-ROLL-01:
  actual previous SHA redeploy is rehearsed

AC-ROLL-02:
  rollback/forward-fix criteria and current-SHA recovery proven

AC-GIT-01:
  integrator identity is exact

AC-GIT-02:
  each verified checkpoint has branch/full+short SHA/push: OK

AC-GIT-03:
  no unrelated paths/worktree/branch switch/force/no-verify

AC-CLAIM-01:
  claim-audit self-test passes

AC-CLAIM-02:
  terminal receipt claim-audit passes with program output


CLAIM-AUDIT
===========

On the MFS VPS, a root-dispatched verifier runs:

  node CONTRACT/qa/claim-audit.mjs --self-test

Then:

  node CONTRACT/qa/claim-audit.mjs
    --claim <terminal-receipt>
    --program-output <program-output>

The task-manager implementer does not edit CONTRACT to make this pass.
Fabricated PASS fails the terminal gate.
The root-dispatched verifier fetches the exact terminal receipt read-only from
the approved portable evidence locator, verifies its hash, and binds the
claim-audit program output to its read-only terminal verdict receipt.


SCREENSHOT MANIFEST
===================

Routes:

  Overview
  each Work bucket
  Priority
  Projects
  Feature Flow
  Task
  Agents/Runs
  Ops/Accounts
  Decisions list/detail
  Evidence/Audit
  sanitized public view

States:

  populated
  loading
  empty
  error
  stale/disconnected
  blocked
  needs-human

Viewports:

  1440x900
  1024x768
  390x844
  360x800
  200 percent zoom core flows

Each row:

  route
  state
  viewport/zoom
  staging URL
  full SHA/schema
  snapshot/hash/revisions
  capturedAt
  browser/test ID
  visual diff
  accessibility result
  mission-question link


INDEPENDENT VERIFICATION
========================

Root dispatches verifier.
Implementer never selects/spawns/instructs it.

Primary:

  exact gpt-5.3-codex-spark

Complexity-selected:

  exact gpt-5.6-sol
  low/medium/high
  global max 10

If author used Spark/SOL:

  root selects separate opposite-model verifier

Verifier checks current source SHA, staging deployed SHA, schema, snapshot,
runtime, auth, threat model, ingestion, locks, data provenance, UI,
accessibility, performance, rollback, and claim-audit.

Verifier execution is read-only except for its own hash-bound evidence,
claim-audit output, and terminal PASS/FAIL/BLOCKED verdict receipt.

FABLE is not this verifier.


TERMINAL RECEIPT
================

Return exactly:

  status
  TASK_MANAGER_STAGING_VERIFIED gate
  live P0 AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK
  RESOLVED_TARGET and environment table
  authoritative repo/host/branch/upstream/start/final SHA
  allowed/changed/forbidden path proof
  portable raw FABLE review+delta receipt URIs, preserved hashes, and advisory
  finding ledger
  live auth observedAt/readback
  lifecycle enum mapping
  threat model/RBAC
  canonical import, DISTINCT readiness fields, ordered lifecycle receipts,
  derived G5, and rollup evidence
  dispatch/runner/account conformance
  full capacity/priority fail-closed evidence
  collision/integration lock evidence
  migration/staging-data/reconciliation evidence
  health/log/metrics/alerts evidence
  UI/screenshots/accessibility
  performance/freshness
  actual prior-SHA rollback/current-SHA recovery
  ibils regression or exact blocker
  independent verifier receipt
  claim-audit output
  immediate per-checkpoint Grok integration receipts
  known residual risks
  no-production/no-secret/no-worktree statement

Do not claim live P0 PASS.
Do not unlock mass refill.
Do not deploy production.
Do not copy Cairn secret.
Do not patch excluded/compiled paths.
Do not return plan-only while safe authorized implementation remains.
<<<END_VERBATIM_SOURCE:AGENT_TASK_ORCHESTRATOR.md>>>

## VERBATIM_ADDENDUM: ART-UX-DIRECTION.md

<<<BEGIN_VERBATIM_SOURCE:ART-UX-DIRECTION.md>>>
01A — TASK MANAGER HUMAN UX + ART DIRECTION — COMBINED DELTA
===========================================================================
SEND THIS SINGLE FILE TO THE ALREADY-RUNNING 01-TASK-MANAGER AGENT.
This combined delta supersedes sending 01A and 01B separately.
ACKNOWLEDGE AND MERGE it into current checkpoints; never restart the run,
discard verified work, reset the source tree, or weaken the parent gates.

PART 1 — HUMAN-FIRST UI/UX, CONTENT, DOCUMENTATION, AND MCP KNOWLEDGE
====================================================================
01A — P0 HUMAN-FIRST UI/UX, CONTENT, DOCUMENTATION, AND MCP KNOWLEDGE ADDENDUM
================================================================================
SEND THIS ENTIRE FILE TO THE ALREADY-RUNNING 01-TASK-MANAGER AGENT NOW.
AUTHORITY
---------
This is a highest-priority in-session delta to:
  TM-P0-ULTIMATE-CONTROL-CENTER-V3
It is not a restart, new architecture, or permission to discard work.
Preserve every completed or independently verified checkpoint from the current run.
Merge this delta into the current schema, implementation, tests, evidence, and rollout
at the earliest collision-safe point. Do not silently defer it to another task.
The owner-facing defect is explicit:
  Current task data and titles are not reliably understandable to a human.
Do not claim otherwise. Machine-complete data is not automatically human-readable.
Default owner language is clear Bahasa Indonesia (`id-ID`). IDs, gates, repositories,
anchors, hashes, receipts, and raw data remain secondary progressive-disclosure detail.
This delta does not weaken SSOT, lifecycle, evidence, RBAC, revision consistency,
HOLD/EXCLUDE, independent verification, or the parent task's rollout gates.
No production deploy, production DB write, or provider mutation is authorized.
IMMEDIATE ACKNOWLEDGEMENT — CONTINUE, DO NOT START OVER
------------------------------------------------------
Reply in the existing agent thread before continuing:
  ADDENDUM_ACK: ACCEPTED | BLOCKED
  CURRENT_CHECKPOINT: <checkpoint and status>
  PRESERVED_WORK: <artifacts/migrations/tests/checkpoints kept>
  MERGE_POINTS: <current checkpoints receiving this delta>
  NEW_EVIDENCE_ROOT: <path>
  CONFLICTS: <NONE or exact collision and non-destructive resolution>
  NEXT_ACTION: <first implementation action>
`ACCEPTED` means merge this delta into the running work. Do not reset the source tree,
replace the established lifecycle model, discard evidence, or repeat passed work.
OWNER OUTCOME
-------------
Without opening JSON or knowing internal codes, the owner must immediately understand:
  - what is finished and what proof makes it finished;
  - what is being worked on now, by whom, and when it was last active;
  - what is next and why it has that priority;
  - what is valid but still queued;
  - what is blocked, why, impact, and who must unblock it;
  - what decision or action needs the owner;
  - whether Sales, web, and strictly related backend receive correct priority;
  - whether readiness comes from current evidence rather than static percentages.
The primary UI must not require decoding `T-*`, `FC-*`, enums, snake_case, hashes,
repository names, model names, API objects, or orchestration jargon.
KNOWN CONTENT DEBT AND RELEASE BLOCKER
--------------------------------------
The current pinned audit observed 639 tasks and title debt including:
  74 titles containing FC-oriented notation;
  57 titles led by or framed as "Parity";
  18 titles framed as "Integration closure";
  30 titles framed primarily as API work;
  32 titles framed primarily as E2E work.
These categories may overlap. Recompute them programmatically against the implementation
snapshot; never hard-code 639 or the audit counts as current truth.
All 639/current tasks require an honest `humanDisplay` state. The priority portfolio
currently contains 316 active PRODUCT rows; all 316/316 require independent content
review before the task-manager staging release can pass. Recompute both denominators
from the pinned canonical snapshot and emit exact coverage.
Missing, stale, conflicted, or unreviewed primary copy yields:
  CONTENT_REVIEW_REQUIRED
It is release-blocking for the affected required scope. Never fall back to a cryptic
technical title, raw objective, ID, enum, or JSON as primary owner copy. Keep the row
visible with a clear content-review warning and technical detail behind disclosure.
VERSIONED HUMAN DISPLAY CONTRACT
--------------------------------
Every owner-visible board, portfolio, domain, project, feature, flow, node, task, run,
blocker, decision, evidence item, and account requires a versioned `humanDisplay`:
  humanDisplay: {
    locale,
    title,
    outcome,
    whyItMatters,
    currentState,
    remainingWork,
    nextAction,
    blockerSummary,
    doneWhen,
    ownerAction,
    parentFeatureTitle,
    businessArea,
    actor,
    sourceHash,
    reviewedAt,
    reviewStatus
  }
Required semantics:
  locale: default `id-ID`; any fallback is explicit.
  title: concrete observable outcome; never begins with ID, FC code, repository,
    "Parity", "Integration closure", "Map", or an unexplained acronym.
  outcome: 1–3 short sentences explaining the user-visible/business result.
  whyItMatters: real user, money, operation, security, or dependency impact.
  currentState: what is true now, including incomplete or uncertain facts.
  remainingWork: bounded work still required; `Tidak ada` only with evidence.
  nextAction: one specific next action and its success condition.
  blockerSummary: `Tidak ada` or cause, impact, unblock condition, responsible role.
  doneWhen: evidence-based acceptance in plain language.
  ownerAction: `Tidak ada tindakan yang diperlukan` or one answerable request.
  parentFeatureTitle: human feature name, never only an FC/technical alias.
  businessArea: stable human business-domain label.
  actor: human-readable responsible role; technical agent details remain secondary.
  sourceHash: hash binding this copy to its canonical source facts.
  reviewedAt: independent review timestamp; absent until real review.
  reviewStatus: REVIEWED | GENERATED_NEEDS_REVIEW |
    BLOCKED_MISSING_SOURCE | CONFLICT | CONTENT_REVIEW_REQUIRED.
Also bind each `humanDisplay` to snapshot ID, board revision, content version, locale,
and resolvable source citations. A stale `sourceHash` invalidates `REVIEWED` and moves
the entity to `CONTENT_REVIEW_REQUIRED` until regenerated and independently reviewed.
Technical truth remains available under "Detail teknis":
  ID and aliases; lifecycle and next gate; repo/branch/SHA; source/target anchors;
  dependencies; API/routes/table.field/providers; agent/model/account/run/heartbeat;
  snapshot/revision/hash; evidence paths and independent verifier receipts.
Human copy may explain truth but may never replace, weaken, or fabricate it.
SOURCE-GROUNDED COMPLETE BACKFILL
--------------------------------
Pin a fresh canonical snapshot, then backfill every current task and hierarchy entity,
including active, HOLD, EXCLUDE, CONTROL_PLANE, and reconciliation records.
For every item:
  1. Read objective, user story, flow/nodes, anchors, rules, dependencies, lifecycle,
     acceptance, evidence, and disposition before writing human copy.
  2. Preserve technical facts and IDs; add a human projection, not a lossy rename.
  3. Cite the exact canonical fields/anchors supporting each non-trivial statement.
  4. Never infer behavior, readiness, priority, timing, dependency, or owner action.
  5. Insufficient source becomes `BLOCKED_MISSING_SOURCE` plus a specific gap.
  6. Conflicting sources become `CONFLICT` with both citations; never choose silently.
  7. Detect boilerplate and duplicate prose; content must be task-specific.
  8. A different role independently reviews before `reviewStatus=REVIEWED`.
  9. Emit totals by entity, locale, review state, priority, and omission reason.
 10. New/changed entities automatically re-enter review and fail closed when stale.
No entity disappears from UI, search, exports, or rollups due to weak human copy.
HUMAN TAXONOMY
--------------
Create stable source-grounded names for domain, project, feature, and end-to-end flow.
Do not collapse those distinct levels into a repository label. At minimum:
  SALES_WEB_RELATED_BACKEND:
    "Prioritas Utama — Panel Sales, Website, dan Backend Terkait"
  sales-rebuild: "Panel Sales"
  mfs-web-original-upgrade: "Website Publik dan Area Member"
  rebuild-backend: "Backend dan Layanan Inti"
  affiliate-rebuild: "Portal Affiliate"
`AFFILIATE` is a business domain across portal, Sales, backend, public web, payment,
and readbacks; it must not be treated as a synonym for one `projectId`.
REAL TITLE TRANSFORMATIONS — QUALITY FLOOR
------------------------------------------
Use these current-task transformations as a quality floor, not fixtures:

ID/current:
  T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE
  [FC-WEB-PREMIUM-E2E] Checkout quote / create pending invoice
Human title:
  Menampilkan harga checkout dan membuat tagihan yang menunggu pembayaran
Outcome:
  Pelanggan melihat rincian harga yang benar. Saat melanjutkan, sistem membuat satu
  tagihan menunggu pembayaran tanpa duplikasi.

ID/current:
  T-PANEL-SALES-LAND-99-INTEGRATION
  Integration/closure: landing price variants
Human title:
  Memastikan semua harga promo diteruskan dengan benar hingga checkout
Outcome:
  Harga promo harus sama pada kartu paket, checkout, tagihan, dan transaksi Sales.

ID/current:
  T-BE-ID-REFRESH-REVOKE
  Parity refresh_token + revoke
Human title:
  Memperbarui sesi login dan mencabut akses secara aman
Outcome:
  Sesi sah dapat diperbarui, sedangkan token yang dicabut tidak dapat dipakai lagi.

ID/current:
  T-AFF-N16-MONEY-EXPIRED-UNPAID
  Money tail expired/unpaid
Human title:
  Mencegah komisi dicairkan dari pembayaran kedaluwarsa atau belum dibayar
Outcome:
  Tagihan belum lunas atau kedaluwarsa tidak masuk ke komisi yang dapat ditarik.

Human title is primary. Original title and ID remain searchable secondary metadata.

WORK BUCKET IS NOT READINESS
----------------------------
Keep classification-relevant concepts separate in data, rollups, API/MCP, and UI:

  workBucket:
    DONE | ONGOING | NEXT | QUEUED | BLOCKED | RECONCILIATION | HOLD | EXCLUDE

  mappingReadiness:
    mapping lifecycle such as MAPPED -> MAP_VERIFIED

  productReadiness:
    delivery rail through target/staging evidence to PROD_READY

  programReadiness:
    scoped/global rollup plus applicable programmatic G5 gates

Examples:
  - a task may be QUEUED while already MAP_VERIFIED;
  - a mapping checkpoint may be DONE while product remains NOT READY;
  - a task cannot be ONGOING without a valid claim, lease, and fresh heartbeat;
  - portfolio 100% never implies global program 100%.
The UI must state this distinction in plain language, not merge it into one percent.

STATUS SENTENCE CONTRACT
------------------------
Never show a naked enum as the primary explanation. Derive sentences from current
lifecycle, dependency, claim, heartbeat, evidence, and decision truth:
  DONE:
    "Selesai untuk <gate> — <outcome> lolos pada <time>. Bukti diverifikasi oleh
    <independent role>. <Later readiness still required, if any>."
  ONGOING:
    "Sedang dikerjakan oleh <role> sejak <time>. Aktivitas terakhir <relative time>;
    langkah berikutnya <specific action>."
  NEXT:
    "Berikutnya — siap dimulai setelah <condition>. Diprioritaskan karena <reason>."
  QUEUED:
    "Menunggu giliran — pekerjaan valid tetapi belum dijadwalkan karena <reason>."
  BLOCKED:
    "Terhambat — <cause>. Agar terbuka, <role/person> perlu <action>. Dampak: <scope>."
  RECONCILIATION:
    "Sedang dicocokkan — klaim lama tidak memiliki heartbeat/lease valid. Sistem
    memastikan bukti dan kepemilikan sebelum menjadwalkan ulang."
  HOLD:
    "Ditahan berdasarkan keputusan owner; terlihat untuk dokumentasi tetapi tidak
    dikerjakan atau dihitung dalam progres aktif sampai dibuka."
  EXCLUDE:
    "Dikecualikan dari cakupan aktif karena <cited reason>; tetap terlihat agar
    cakupan tidak hilang diam-diam."
An orphan, stale claim, or expired lease is never ONGOING.

INFORMATION ARCHITECTURE
------------------------
1. OVERVIEW — "Ringkasan Program"
Primary order:
  freshness/environment; stage in plain language; priority portfolio; honest scoped
  readiness; Done/Ongoing/Next/Queued/Blocked counts; work active now with actor and
  heartbeat; next work and ordering reason; top blockers; Decision Inbox; lifecycle-
  derived domain/project progress. Never show static percentages as truth.

2. WORK — "Pekerjaan"
Navigate and group:
  Portfolio -> Domain -> Project -> Feature -> End-to-end Flow -> Task
Default cards/list show title, outcome, status sentence, why, remaining work, next,
blocker/owner action, freshness, and priority. Filters show active chips and reset.

3. TASK DETAIL — "Detail Pekerjaan"
Above fold:
  title; outcome; status/freshness; why; current state; remaining work; next action;
  done-when; blocker; owner action; dependencies in words; evidence summary.
Progressive disclosure:
  feature flow; acceptance; history; anchors; related work; run/heartbeat/lease;
  IDs, lifecycle, repo/SHA/hash/revision, raw read-only evidence.
Provide stable deep links; a modal cannot be the only detail or print surface.

OWNER MODE VS TECHNICAL MODE
----------------------------
Default is "Ringkas untuk Owner" in `id-ID`: human outcomes, decisions, risks, next
steps, and evidence summaries; jargon explained; no raw JSON/IDs/hashes primary.
"Detail Teknis" exposes all canonical identifiers, enums, anchors, routes, DB fields,
relations, receipts, logs, and raw authorized data. Both modes use the same snapshot.
Switching modes preserves route, selection, filters, and revision. RBAC still applies.

READABLE DECISION INBOX
-----------------------
Every decision states:
  what must be decided; why now; impact of no answer; blocked scope; requester/time;
  agent recommendation with reason/confidence; safe options and risks; reversibility;
  deadline; and cited evidence.
Actions are human: "Setujui", "Tolak", "Minta penjelasan", "Tunda". Never require
editing JSON or typing an enum. Preview the effect before confirmation. Audit actor,
reason, time, previous/new revision, and affected scope immutably.

NO RAW DATA AS PRIMARY UX
-------------------------
Raw JSON, payloads, stack traces, DB fields, route lists, and logs are technical detail,
not primary cards, errors, empty states, blockers, or decisions. Every error explains:
what happened, trustworthy scope, affected work, safe next action, retry/contact path;
trace ID is secondary.

SEARCH
------
Global search must resolve human Indonesian, English/synonyms, legacy/rebuild terms,
technical IDs/aliases, repositories, feature/flow/node, API route/symbol, table.field,
provider, job, email, webhook, and outcome. Support exact, keyword, alias, and semantic
search with visible match reason, pagination, totals, freshness, and redaction truth.
Results show human title/status first and matched technical alias second. A domain query
must not silently become a one-project filter.

DOMAIN KNOWLEDGE + MCP RETRIEVAL
--------------------------------
MCP must be a complete searchable knowledge/documentation layer for future agents,
not only task CRUD. Build a versioned graph connecting:
  board/portfolio/domain/project/repository/feature/flow/node/task;
  legacy+rebuild anchors; APIs/routes; rules/roles; DB table.field; providers;
  jobs/emails/webhooks; outcome variants; dependencies/relations; decisions;
  evidence; work bucket; mapping/product/program readiness.

Required versioned response contract:
  DomainKnowledgeBundle {
    domainId, humanDisplay, boundaries, projects, features, flows, entities, relations,
    statusRollup, blockers, decisions, evidence, knowledgeGaps, coverageManifest,
    citations, snapshotId, revision, sourceHash, generatedAt, freshness, redactions
  }

Every returned fact has a resolvable citation/anchor or inherited citation reference,
snapshot ID, hash, revision, and freshness. Knowledge state is:
  PROVEN | UNKNOWN | CONFLICT | STALE
Unknown/conflict becomes an explicit gap. Never hallucinate, silently choose a source,
mix revisions, or omit a known relation because traversal is difficult.

Required MCP read behaviors; names may version, behavior may not be omitted:
  search_knowledge — exact/keyword/semantic/alias search across authorized graph.
  get_domain_overview — human boundaries, coverage, status, gaps, freshness.
  list_domain_features — complete paginated cross-project inventory.
  get_feature_documentation — cited human docs plus technical appendix.
  get_feature_flow — ordered nodes, variants, dependencies, outcomes, readbacks.
  get_related_entities — typed incoming/outgoing relations and dependency graph.
  get_change_history — actor-attributed revision-consistent history/delta.
  export_documentation — deterministic snapshot-pinned export.
Require pagination, query limits, RBAC/redaction, stable aliases, and revision token
across multi-call retrieval. Stale or mixed-revision retrieval fails closed clearly.

AFFILIATE DOMAIN ACCEPTANCE
---------------------------
`domainId=AFFILIATE` traverses business relations, not `projectId=affiliate` only:
  affiliate registration/activation/login/profile/portal;
  Sales KYC, verification, contracts, invitations, and commission readback;
  backend referral attribution, commission, payout, webhook, and reconciliation;
  public `/a/{code}`, voucher persistence, web checkout, and provider payment paths;
  jobs/emails plus success/fail/expired/refund/revoke/recurring outcomes;
  member, admin, DB, email, provider, and audit readbacks.

Produce a deterministic comprehensive DomainKnowledgeBundle and knowledge pack with
human overview, full feature/flow inventory, cross-project graph, status/blockers/
decisions/evidence/gaps, citations, technical appendix, and coverage manifest:
  expected | included | redacted | unknown | conflict | omitted-with-reason.

Acceptance scenario: a newly authorized agent receives only:
  "bikinin dokumentasi fitur affiliate"
Using MCP discovery alone, it finds AFFILIATE, pins one revision, retrieves complete
authorized cross-project knowledge, creates cited human-readable MD/HTML/print-PDF,
lists gaps/status/evidence, and proves no known feature/flow was silently omitted.
Test alias + Indonesian/English keyword + semantic search, citation resolution,
pagination, RBAC/redaction, stale fail-closed, traversal, and revision consistency.

HUMAN DOCUMENTATION EXPORT
--------------------------
Export from pinned SSOT, never screen scraping or a second datastore. Support board,
portfolio, domain, project, feature, flow, task, and selected filters as:
  Markdown; semantic HTML; print-ready PDF; CSV; canonical JSON.
Human formats contain executive summary, scope/HOLD/EXCLUDE, readable hierarchy,
legacy-to-rebuild map, end-to-end flows/outcomes, current status buckets/readiness,
dependencies/decisions/gaps, evidence/citations, revision/snapshot/hash/freshness,
filters/redaction disclosure, deep links, and technical appendix. CSV/JSON retain stable
IDs and typed relations. Two snapshots export a human changelog and machine delta.
Deterministic input produces deterministic content except declared generation time.

ACCESSIBILITY AND RESPONSIVE UX
-------------------------------
Meet WCAG 2.2 AA: keyboard and visible focus; correct landmarks/headings/labels;
no color-only meaning; contrast in all states; restrained screen-reader live updates;
reduced motion; 44x44 touch targets; clear errors; 200% zoom without lost content or
page-level horizontal scroll. Prove at 320x568, 360x800, 390x844, 768x1024, 1280x800,
and 1440x900. Mobile prioritizes title, status sentence, owner action, blocker,
freshness, and next step; never compress the desktop table into tiny columns.

PLAIN-LANGUAGE RELEASE GATE
---------------------------
Add deterministic `id-ID` lint that blocks:
  title starts with ID/FC/repository; unexplained acronym/jargon; raw enum/snake_case;
  vague "integration/parity/mapping/fix/closure" without observable outcome;
  duplicated boilerplate; missing humanDisplay fields; unsupported certainty/percent/
  timing; excessive length; placeholder, uncited, fabricated, or stale content.
Exceptions require reason, reviewer, expiry, and audit; no blanket suppression.

COMPREHENSION ACCEPTANCE
------------------------
An independent non-implementing verifier uses staging owner mode without raw JSON.
Predefine a source-grounded sample spanning every work bucket, mapping/product state,
P0/non-P0, HOLD/EXCLUDE, reconciliation, and owner decision. From UI alone it answers:
what outcome, why, status, actor/heartbeat, remaining work, next action, blocker/unblock
owner, owner action, readiness distinction, and completion evidence.
Require >=90% correct, 100% owner-decision identification, and zero stale claims shown
as ongoing. Programmatically record sample, expected cited answers, actual answers,
timing, failures, repairs, and verdict. Do not hand-type PASS.

TESTS AND EVIDENCE
------------------
Automate and independently verify:
  humanDisplay schema/version/sourceHash invalidation;
  full current-snapshot backfill and P0 316/316 independent content review;
  content-debt recount, citations, conflict/unknown, lint, and no raw primary fallback;
  workBucket vs mapping/product/program readiness classification and rollups;
  lifecycle-to-status sentences; stale lease -> reconciliation, never ongoing;
  Overview/Work/Task Detail hierarchy and owner/technical truth parity;
  Decision Inbox; global human+technical search and match reason;
  DomainKnowledgeBundle, MCP tools, revision consistency, and coverage manifest;
  AFFILIATE cross-project retrieval/documentation scenario;
  deterministic exports/deltas, RBAC/redaction, pagination, no silent omission;
  responsive, keyboard, screen reader, contrast, zoom, axe, and safe state handling.

Capture staging—not mock-only—screenshots for:
  Overview desktop/mobile; every work bucket including reconciliation; P0 card;
  Work hierarchy/filter; human-first Task Detail; expanded technical detail;
  Decision Inbox/detail; Indonesian and technical-ID search; AFFILIATE domain graph/docs;
  documentation preview/export; stale/conflict/error/redaction; keyboard focus; 200% zoom.
Each screenshot record includes URL, viewport, snapshot/revision/hash, release SHA, time,
role/redaction state, and scenario. Screenshots supplement runtime assertions.

MERGE AND TERMINAL RECEIPT DELTA
--------------------------------
Merge into the existing checkpoints: schema/migration/projection; complete backfill;
UI hierarchy/modes/status/decisions; graph/MCP/search/export; responsive/accessibility;
lint/comprehension/runtime proof. Do not complete from prose, fixtures, screenshots, or
implementer assertion. Preserve parent task current-SHA independent verification,
dedicated integration/commit/push, staging deploy, and rollback requirements.

Extend the terminal receipt with:
  ADDENDUM_ACK and preserved-work list;
  pinned count/revision/hash and content-debt audit;
  coverage by entity/review state, including independently reviewed P0 count/total;
  knowledge graph coverage/omission manifest and AFFILIATE scenario receipt;
  lint, comprehension, accessibility, responsive, MCP, and export program output;
  screenshot manifest and unresolved gaps/conflicts;
  verifier verdict bound to current SHA; existing commit/push/deploy/rollback receipts.

DEFINITION OF DONE
------------------
Staging proof must show:
  - default id-ID UI is understandable without IDs or JSON;
  - every current task is visible with valid or explicit blocked humanDisplay state;
  - all P0 active PRODUCT content is independently reviewed (current baseline 316/316,
    exact live denominator recomputed);
  - owner instantly distinguishes Done/Ongoing/Next/Queued/Blocked/Reconciliation;
  - work bucket never masquerades as mapping/product/program readiness;
  - stale claims cannot appear ongoing;
  - title/outcome/why/current/remaining/next/blocker/done/owner action are cited;
  - Sales/Web/related-backend priority and Decision Inbox are human-readable;
  - technical truth is progressively available and same-revision searchable;
  - MCP returns complete cited cross-project DomainKnowledgeBundle data;
  - AFFILIATE scenario has no silent known omission;
  - MD/HTML/print-PDF/CSV/JSON exports are pinned, cited, deterministic, redacted;
  - accessibility, responsive, lint, comprehension, runtime, and screenshot gates pass;
  - independent verification and parent Git/staging/rollback gates remain satisfied;
  - no production authority was assumed.

Do not answer with another audit or design-only plan. Acknowledge, merge, implement,
independently verify, preserve prior verified work, and return the evidence-bound delta
receipt as part of the already-running task.

PART 2 — ART DIRECTION
======================

01B — P0 ART DIRECTION ADDENDUM
================================
SEND THIS ENTIRE FILE TO THE SAME ALREADY-RUNNING 01-TASK-MANAGER AGENT.

AUTHORITY AND MERGE RULE
------------------------
Parent task:
  TM-P0-ULTIMATE-CONTROL-CENTER-V3
Human-content delta:
  01A-TASK-MANAGER-HUMAN-UX-ADDENDUM

This is a release-blocking visual-design delta, not a restart or new architecture.
Preserve all completed and independently verified checkpoints. Merge this art direction
into current design-system, UI, test, evidence, and rollout checkpoints. Never reset,
discard, duplicate, or invalidate good work merely to apply the visual layer.

Reply in the existing agent thread before implementation:
  ART_DIRECTION_ACK: ACCEPTED | BLOCKED
  CURRENT_CHECKPOINT: <checkpoint/status>
  PRESERVED_WORK: <verified work retained>
  MERGE_POINTS: <existing checkpoints receiving this delta>
  BRAND_AUDIT_PATH: <planned path>
  ART_EVIDENCE_ROOT: <planned path>
  CONFLICTS: <NONE or exact conflict plus non-destructive resolution>
  NEXT_ACTION: <first concrete action>

This delta strengthens presentation only. It must preserve 01/01A lifecycle, SSOT,
humanDisplay, evidence, search, MCP, documentation, RBAC, accessibility, staging,
independent-verification, and Git requirements.
No production deployment, production DB write, or provider mutation is authorized.
Target remains staging-only until separate exact owner approval.

NAMED CONCEPT
-------------
  Human Operations Editorial Control Center

This is an editorial operations product: it explains a living program with the calm
hierarchy of a premium publication and the precision of a trusted control system.
It must feel:
  calm;
  trustworthy;
  premium;
  clear;
  humane;
  focused.

"Premium" comes from disciplined typography, spacing, alignment, language, and detail,
not visual effects. "Operations" comes from honest freshness, state, ownership, and
evidence, not a dense wall of telemetry.

EXPRESSLY REJECT
----------------
Do not ship any of these as the primary visual language:
  generic admin-dashboard template;
  cyberpunk, NOC, war-room, terminal, or hacker aesthetic;
  neon accents or glowing status lights;
  glassmorphism, translucent cards, or blurred backplates;
  decorative gradients;
  KPI-wall clutter or rows of equally loud metric tiles;
  tiny dense text presented as "power user" design;
  raw JSON, log stream, code editor, or database-table aesthetic;
  excessive pills, shadows, borders, icons, or competing accent colors;
  charts used as decoration when a sentence or ratio is clearer.

BRAND AND DESIGN-SYSTEM AUDIT — FIRST GATE
------------------------------------------
Before proposing tokens or high-fidelity screens, inspect and document:
  approved Myfitsociety and Cairn brand assets;
  current task-manager tokens, components, fonts, icons, and CSS framework;
  logo source files and usage rules;
  existing light/dark themes and accessibility behavior;
  current breakpoints, spacing, typography, and status semantics;
  reusable patterns from the authoritative product, not historical mockups;
  licensing and loading behavior for fonts/icons/assets.

Write the audit before implementation. Record source path, owner/system, version/hash,
license where relevant, approved use, accessibility finding, reuse decision, and gap.
Reuse approved Myfitsociety/Cairn tokens and assets when they exist and pass contrast.
Never redraw, recolor, crop, distort, animate, or invent a logo. Never infer brand colors
from a screenshot. When approved sources conflict, show the conflict and fail closed.

FALLBACK VISUAL TOKENS
----------------------
If the audit proves no approved token for a required role, use this documented light
fallback only until an approved replacement exists:
  canvas:             #F7F8FA
  surface:            #FFFFFF
  surfaceSubtle:      #F1F4F7
  textStrong:         #17202A
  textDefault:        #344054
  textMuted:          #52606D
  borderDefault:      #CDD5DF
  borderStrong:       #98A2B3
  action:             #175CD3
  actionHover:        #1849A9
  focusRing:          #2E90FA
  doneFg/doneBg:      #067647 / #ECFDF3
  ongoingFg/Bg:       #175CD3 / #EFF8FF
  nextFg/nextBg:      #6941C6 / #F4F3FF
  queuedFg/queuedBg:  #344054 / #F2F4F7
  blockedFg/Bg:       #B42318 / #FEF3F2
  reconcileFg/Bg:     #B54708 / #FFFAEB

Verify actual foreground/background contrast programmatically. Do not assume a hex pair
passes. Document every fallback in token metadata with source=`fallback`, reason,
contrast result, reviewer, replacement owner, and review date. No ad hoc colors in CSS.

COLOR MODE
----------
Light-first is required: quiet near-white canvas, opaque white surfaces, dark readable
text, restrained accent, and semantic color only where it carries meaning.
Dark mode is optional. Do not expose a dark-mode toggle unless every route, component,
state, chart, evidence view, focus state, screenshot, and contrast gate has full parity.
An incomplete dark theme is removed from release rather than presented as beta.

TYPOGRAPHY
----------
Use the approved brand UI font if audited and licensed; otherwise use:
  Inter, ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif
Required scale in CSS pixels with paired line-height:
  12/16 metadata only;
  14/20 secondary UI;
  16/24 body and controls;
  18/28 card/section lead;
  24/32 page title;
  32/40 overview headline;
  40/48 exceptional desktop program statement only.
Use 400 body, 500 UI emphasis, 600 headings/status; avoid 700 everywhere.
Primary owner content is never below 14px. Body defaults to 16px. IDs, hashes, and code
use an audited monospace at 12–14px only inside technical disclosure, never as headings.
Limit narrative lines to 65–75 characters where possible. Avoid all-caps paragraphs.

SPACING, GRID, AND CONTENT WIDTH
-------------------------------
Use a 4px base and only these standard spacing steps:
  4, 8, 12, 16, 24, 32, 48, 64.
Grid:
  desktop >=1200: 12 columns, 32px gutter, 32px outer margin;
  tablet 768–1199: 8 columns, 24px gutter/margin;
  mobile <=767: 4 columns, 16px gutter/margin.
App content max width is 1440px. Narrative/detail reading column max is 760px.
Overview working canvas may use 1200px before expanding to secondary operational detail.
Use whitespace to group meaning; do not fill empty space with extra cards.

SHAPE, BORDER, AND ELEVATION
----------------------------
  controls: 8px radius;
  cards: 12px radius;
  major editorial panels/drawers: 16px radius;
  pills: status, filters, and compact tags only;
  border: 1px `borderDefault`; stronger only for focus/selection;
  elevation: none by default; one restrained shadow token for floating menus/drawers.
No nested card-on-card stack deeper than two visual surfaces. Selected state uses border,
background, icon, and text—not a large shadow or color alone.

SEMANTIC STATUS SYSTEM
----------------------
Each state uses four redundant cues: plain text, stable icon, semantic color pair, and
shape/pattern. Never use a colored dot alone.
  Selesai: check icon, done colors, solid left rule.
  Sedang dikerjakan: progress icon, ongoing colors, double left rule.
  Berikutnya: forward icon, next colors, top notch/outlined marker.
  Menunggu giliran: queue icon, neutral colors, dashed left rule.
  Terhambat: stop icon, blocked colors, solid border plus reason.
  Sedang dicocokkan: reconcile icon, amber colors, striped/outlined marker.
HOLD and EXCLUDE remain explicit labelled dispositions, visually quieter but never hidden.
Work bucket is visually separate from mapping/product/program readiness. A mapped task
may still be queued; a finished mapping checkpoint may still be product-not-ready.

APP SHELL
---------
Use a quiet fixed shell with:
  approved logo at original colors/proportions;
  primary navigation: Ringkasan, Pekerjaan, Keputusan, Pengetahuan, Operasi;
  global search/command trigger;
  environment and freshness label;
  user/account menu;
  one restrained staging indicator.
Desktop navigation may be a 240px left rail. Tablet may collapse it. Mobile uses a top
bar plus accessible drawer or bottom destinations, never an icon-only mystery menu.
Keep control-plane health available but secondary to human work outcomes.

OVERVIEW — EDITORIAL NARRATIVE
------------------------------
The first viewport tells one story in this order:
  1. "Di mana posisi program sekarang?" human stage/readiness statement.
  2. Priority portfolio and evidence-derived progress.
  3. "Sedang dikerjakan sekarang" with owner, freshness, outcome, next action.
  4. "Berikutnya" and why it follows.
  5. Top blocker and owner decision, only when real.
  6. Five work-bucket summary with exact counts/denominators.
Do not open with six equal KPI cards. Give the primary narrative at least twice the visual
weight of secondary metrics. Technical capacity/hash/account data is quiet and expandable.

DECISION INBOX
--------------
Present decisions like an editorial briefing, not a ticket queue:
  question as heading;
  two-line context and why now;
  affected outcome/scope;
  recommendation and confidence;
  choices with consequence and reversibility;
  deadline/freshness/requester;
  evidence link;
  clear Setujui, Tolak, Minta penjelasan, Tunda actions.
Use blocked red only when work is actually blocked. High impact uses hierarchy and copy,
not flashing color. Confirmation previews the state change before write.

FIVE WORK BUCKETS
-----------------
Selesai, Sedang dikerjakan, Berikutnya, Menunggu giliran, and Terhambat each receive a
consistent section/list treatment, not unrelated dashboard widgets. Show count and honest
denominator, one explanatory sentence, then human task cards. Reconciliation is a separate
integrity exception rail; HOLD/EXCLUDE are explicit scope dispositions below active work.
Kanban is optional, never the only view, and must remain usable by keyboard and mobile.

HUMAN TASK CARD
---------------
Visible by default, in order:
  human title;
  outcome or why it matters;
  complete status sentence;
  current owner/role and heartbeat when genuinely active;
  remaining work and next action;
  blocker/owner action when applicable;
  human project/feature and freshness.
Technical ID is a quiet copyable footer/expander. Do not show repo, SHA, model, account,
or hash unless technical detail is opened. Cards use flexible height; never truncate the
blocker or owner request. One primary action maximum per card.

LIFECYCLE AND READINESS RAIL
----------------------------
Use a labelled step rail with separate rows for Mapping, Product delivery, and Program/G5.
Each step displays Passed, Current, Waiting, or Blocked using text+icon+shape. Explain why
the next gate is unavailable. Do not connect unrelated rails into a false single percent.
On mobile, stack the rail vertically. Every state and evidence link is keyboard reachable.

KNOWLEDGE / DOMAIN PAGE
-----------------------
Lead with human domain title, boundary, current outcome, project coverage, and known gaps.
Then show end-to-end flows, related projects, feature inventory, dependency map, decisions,
evidence, citations, and coverage manifest. `AFFILIATE` visibly spans portal, Sales,
backend, public web, payments, and readbacks. Never imply completeness when the omission
manifest is non-empty. Technical graph data is secondary to the readable narrative.

EVIDENCE AND CITATION DRAWER
----------------------------
Open from any evidence/citation link without losing page context. Show:
  plain-language proof summary;
  what claim it supports;
  independent verifier and time;
  freshness/revision/snapshot;
  source anchor and resolvable link;
  conflict/stale/redaction warning;
  raw receipt only under nested technical disclosure.
Drawer width is 480–640px desktop and full-screen mobile. It has focus trap, Escape/close,
focus return, deep link, copy citation, and printable route.

TABLES AND CARDS
----------------
Use cards for narrative decisions/outcomes and tables for repeated comparable fields.
Tables require sticky readable headers, row labels, keyboard sorting, visible sort state,
column controls, pagination/total, and horizontal containment. Freeze human title/status
before technical columns. At <=767px, convert core rows to labelled key-value cards;
technical wide tables use an explicit contained scroller, never page overflow.

SEARCH AND COMMAND PALETTE
--------------------------
Search is a generous primary field, not a tiny header icon. Results group Pekerjaan,
Fitur/Alur, Domain, Keputusan, and Bukti. Show human title and why matched; technical alias
is secondary. Command palette shortcut is `/` and platform-standard Cmd/Ctrl+K, with an
on-screen trigger, focus management, recent queries, keyboard selection, and Escape.
Commands cannot bypass RBAC or confirmation. Empty search teaches human and technical terms.

EMPTY, LOADING, ERROR, AND STALE STATES
---------------------------------------
Empty: explain whether there is no work, no result, or missing permission; give safe action.
Loading: skeleton matches final layout; no layout jump or fake metrics.
Error: human cause/impact/trust boundary/retry; trace ID secondary.
Stale: persistent amber banner with last valid time, affected scope, and refresh/reconcile.
Conflict: show both sources and block certainty. Partial redaction: explain hidden scope.
Never replace the page with JSON, spinner-only indefinite loading, or "Something went wrong".

CHARTS AND DATA VISUALIZATION
-----------------------------
Prefer a labelled ratio, progress bar, table, or sentence over a chart for one comparison.
Allowed: horizontal progress/bars, restrained trend line, lifecycle funnel only with honest
denominators. Reject 3D, gauges, decorative donuts, unlabeled pies, dual axes, truncated
misleading axes, animation-led charts, and rainbow categories.
Every chart has title, plain takeaway, exact values, denominator/unit, timeframe, freshness,
source, accessible table, and non-color encoding. Zero/missing/not-applicable differ.

DEPENDENCY FLOW
---------------
Use left-to-right desktop and top-to-bottom mobile flow. Node shape encodes type; border
encodes state; arrows are directional and labelled with dependency meaning. Highlight the
selected path and quiet unrelated nodes. Provide zoom, pan, reset, keyboard navigation,
text outline/tree alternative, cycle/conflict warnings, and "why blocked" explanation.
Collapse large graphs by feature/domain with counts; never render an unreadable hairball.

MICROINTERACTION
----------------
Use motion only for causality and orientation:
  hover/focus/press: 120–160ms;
  expand/collapse: 160–200ms;
  drawer/page context: 200–240ms;
  toast: no blocking animation; remains readable and dismissible.
Use ease-out for entry and ease-in for exit. Nothing exceeds 300ms without a functional
reason. `prefers-reduced-motion` reduces transitions to 0–80ms fades/no transform.
No pulsing status, parallax, shimmer after loading, celebratory confetti, or auto-carousel.

MOBILE, TABLET, AND id-ID CONTENT
--------------------------------
Prove 320, 360, 390, 768, 1280, and 1440 widths plus 200% zoom. On mobile:
  stack narrative before metrics;
  preserve title/status/blocker/owner action/next/freshness;
  use one-column cards and vertical readiness rail;
  make drawers full-screen and tables explicit contained scrollers/cards;
  keep 44x44 touch targets and sticky actions from covering content.
At 768px use two columns only when each remains readable. Indonesian copy gets flexible
height and 30% expansion allowance. Never ellipsize decisions, blockers, evidence meaning,
or status sentences. Dates use `id-ID`, absolute time in detail, relative time in summary.

ACCESSIBILITY RELEASE GATE
--------------------------
Meet WCAG 2.2 AA across all named routes/states: contrast, keyboard, visible focus,
landmarks/headings, names/roles/states, screen-reader updates, errors, reduced motion,
touch targets, reflow, and 200% zoom. Color is never the sole signal. Focus order follows
the visual narrative. Dynamic freshness does not repeatedly steal screen-reader attention.
Automated axe/contrast checks supplement manual keyboard and screen-reader verification.

REQUIRED ARTIFACTS
------------------
Commit approved source artifacts under the authoritative repo:
  docs/design/task-manager/BRAND_DESIGN_SYSTEM_AUDIT.md
  docs/design/task-manager/ART_DIRECTION.md
  design/tokens/task-manager.tokens.json
  docs/design/task-manager/COMPONENT_INVENTORY.md
  docs/design/task-manager/INTERACTION_NOTES.md
  docs/design/task-manager/RESPONSIVE_SCREENSHOT_MANIFEST.md
  docs/design/task-manager/BEFORE_AFTER.md

Evidence under the parent task evidence root `/art-direction/`:
  low-fi source and exports for all primary routes;
  high-fi source and exports for all primary routes;
  token lint/contrast output;
  component/state inventory with coverage;
  responsive/runtime screenshot files and machine manifest;
  interaction/reduced-motion recordings or traces;
  before/after matched-view comparison;
  FABLE raw critique and resolution matrix;
  independent visual/accessibility verdict bound to current release SHA.
If repo conventions require alternate paths, record a one-to-one path map in
`ART_DIRECTION.md`; do not omit any artifact.

EXACT STAGING SCREENSHOT MATRIX
-------------------------------
Use these canonical routes. If existing routing differs, implement stable aliases or record
the exact one-to-one route in the manifest before capture. Pin one staging release SHA,
snapshot/revision/hash, Chromium version, font set, timezone, locale, and test role.

  S01 `/`                         1440x900  Overview / fresh populated
  S02 `/`                          390x844  Overview / fresh populated
  S03 `/work?bucket=DONE`         1280x800  Selesai / evidence summary
  S04 `/work?bucket=ONGOING`      1280x800  Active owner + fresh heartbeat
  S05 `/work?bucket=NEXT`         1280x800  Next + ordering reason
  S06 `/work?bucket=QUEUED`       1280x800  Queue + wait reason
  S07 `/work?bucket=BLOCKED`      1280x800  Blocker + unblock owner
  S08 `/work?bucket=RECONCILIATION` 390x844 Stale/orphan reconciliation
  S09 `/work/<taskId>`            1280x800  Human-first task detail
  S10 `/work/<taskId>?mode=technical` 1280x800 Expanded technical detail
  S11 `/decisions`                1280x800  Decision Inbox populated
  S12 `/decisions/<decisionId>`    390x844  Decision detail/actions
  S13 `/knowledge/domains/AFFILIATE` 1440x900 Cross-project domain
  S14 `/knowledge/domains/AFFILIATE` 390x844  Cross-project domain mobile
  S15 `/search?q=pembayaran%20affiliate` 1280x800 Human semantic result
  S16 `/search?q=T-AFF-N16-MONEY-EXPIRED-UNPAID` 1280x800 Technical alias result
  S17 `/documentation/domains/AFFILIATE` 1280x800 Export preview/citations
  S18 `/`                         1280x800  Persistent stale-data banner
  S19 `/work`                     1280x800  Loading skeleton under throttled response
  S20 `/work`                     1280x800  Safe API error and recovery
  S21 `/knowledge/domains/AFFILIATE` 1280x800 Knowledge conflict/redaction
  S22 `/work/<taskId>`            1280x800  Keyboard focus sequence
  S23 `/work/<taskId>`            1280x800  Browser zoom 200%
  S24 `/work?query=<zero-result>`  320x568  Honest empty result

Populated views use real staging data. Loading/error/stale/conflict may use deterministic
Playwright network/state injection only when the manifest records method and payload hash;
never present a component mock as staging proof. Each receipt records URL, state, viewport,
release SHA, snapshot/revision/hash, time, locale, role/redaction, and scenario.

FABLE 5 xhigh ART CRITIQUE
--------------------------
After high-fidelity direction exists and before visual acceptance, run exact
`claude-fable-5` with effort `xhigh` against audit, tokens, low/high-fi screens, 01A human
content, and screenshot matrix. Ask specifically about:
  5-second hierarchy and human comprehension;
  editorial calm/premium/trust qualities;
  owner action and blocker salience;
  distinction between work bucket and readiness;
  information density and technical-metadata quietness;
  id-ID readability;
  responsive/mobile hierarchy;
  status ambiguity and accessibility;
  generic-template/cyberpunk/NOC drift;
  missing components/states and implementation risk.
Preserve raw program output, exact model/effort/runtime, prompt, timestamp, and SHA-256.
Create finding -> decision -> change -> screenshot/test -> resolved/open matrix. Resolve all
release-relevant findings or expose a precise blocker. FABLE is advisory, never the same
as independent code/runtime visual and accessibility verification.

RELEASE-BLOCKING ACCEPTANCE
---------------------------
An implementer cannot verify itself. A separate visual/accessibility verifier bound to the
current release SHA must prove:

  5-second scan:
    Three independent non-implementing reviewers see S01 for exactly five seconds, then
    identify stage, priority outcome, ongoing work, next work, and top blocker/decision.
    Each scores at least 4/5; aggregate is at least 90%. Record prompts/answers/timing.

  hierarchy:
    owner outcome/status/next/action dominate; technical IDs/hashes are not primary;
    Overview reads in the required narrative order at every matrix width.

  semantic clarity:
    every state uses text+icon+shape+color; no ambiguous color-only status; work bucket
    and readiness remain visually/data-semantically distinct.

  token consistency:
    token lint finds zero undocumented raw colors, spacing, radius, shadow, or type sizes;
    brand assets match approved source hashes and logo was not altered.

  responsive/reflow:
    zero clipped/truncated required human content and zero page-level unintended overflow
    across S01–S24, required widths, keyboard traversal, and 200% zoom.

  accessibility:
    WCAG 2.2 AA contrast/axe checks pass; manual keyboard, focus, screen-reader, reduced
    motion, touch target, error, and reflow checks pass with recorded evidence.

  visual regression:
    use pinned Chromium/fonts/OS settings. S01–S24 have reviewed baselines. Unexpected
    `maxDiffPixelRatio` above 0.002 fails; expected changes require reviewer-approved
    baseline receipt, never automatic baseline replacement.

  state completeness:
    populated, empty, loading, error, stale, conflict, redacted, five buckets,
    reconciliation, technical disclosure, and evidence/citation states all pass.

  FABLE resolution:
    every release-relevant xhigh finding is resolved with linked change and proof or the
    release remains explicitly blocked.

TERMINAL RECEIPT DELTA
----------------------
Extend the already-running parent receipt with:
  ART_DIRECTION_ACK and preserved-work list;
  brand/design-system audit and approved-asset hashes;
  final ART_DIRECTION and token-file hashes;
  component/state coverage inventory;
  low-fi/high-fi artifact manifest;
  exact S01–S24 responsive screenshot manifest;
  before/after comparison;
  token/contrast/accessibility/overflow/visual-regression program outputs;
  5-second scan receipt;
  raw FABLE xhigh receipt and complete resolution matrix;
  independent visual/accessibility verifier receipt bound to release SHA;
  unresolved conflicts/blockers;
  existing parent commit/push, staging deploy, and rollback receipts.

DONE means implemented and proven on staging—not a mood board, token proposal, Figma-only
mock, screenshot assertion, FABLE opinion, or implementer claim. Preserve the parent task's
independent verification and integration rules. Live production remains separately gated.

<<<END_VERBATIM_SOURCE:ART-UX-DIRECTION.md>>>

