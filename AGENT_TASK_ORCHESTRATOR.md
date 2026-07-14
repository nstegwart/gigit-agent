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
