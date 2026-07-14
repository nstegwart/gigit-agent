// Pure V3 rollup (C1 domain). No I/O / DB / scheduler / account ingestion.
// Single pinned aggregation over DISTINCT task IDs.

import type {
  BlockReasonCode,
  BucketAssignment,
  DependencyJoin,
  FeatureContractJoin,
  G5DomainRecord,
  LifecycleStageKey,
  NodeJoin,
  PinnedRevisionTuple,
  PrimaryOwnership,
  PriorityAllocationResult,
  PriorityFrontierState,
  RollupV3BucketCounts,
  RollupV3Result,
  StageEvidenceBinding,
  StaleOverlayKind,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import { DomainError, LIFECYCLE_STAGE_ORDER } from '#/lib/control-plane-types'
import {
  applyBoardReadinessCap,
  isBoardComplete,
  meanReadinessOneDecimal,
  taskStageWeight,
  BOARD_READINESS_POLICY_VERSION,
  TASK_READINESS_POLICY_VERSION,
} from '#/lib/readiness-policy'
import {
  evaluateClassification,
  isProductDenominatorMember,
  isTrackedWork,
} from './classification'
import { deriveG5Pass } from './g5'

// ---- public input shapes (pure, defensive) ----

export type ProductStageMode = 'STAGE_1' | 'STAGE_2'

export type ClaimState =
  | 'NONE'
  | 'VALID_CURRENT'
  | 'STALE'
  | 'ORPHAN'
  | 'EXPIRED'
  | 'FENCED'
  | 'BEYOND_STAGE'

export type RunLiveness = 'NONE' | 'STARTING' | 'RUNNING' | 'STALLED' | 'EXPIRED'

export interface RollupTaskInput {
  taskId: string
  classification: TaskClassificationRecord
  /** Current proven lifecycle stage (null = uninitialized → not DONE). */
  lifecycleStage: LifecycleStageKey | string | null
  /** Stage evidence valid for current pin (prodReadyWithEvidence). */
  evidence?: StageEvidenceBinding | null
  claimState?: ClaimState
  runLiveness?: RunLiveness
  /** Open blocking human decision on this task. */
  hasBlockingDecision?: boolean
  /** Non-blocking decision present (must NOT demote ONGOING). */
  hasNonBlockingDecision?: boolean
  hardBlocker?: boolean
  /** Root-published dispatch plan selection for NEXT. */
  selectedForNextDispatch?: boolean
  /** Eligible for work (capacity/deps ok) → QUEUED if not selected. */
  eligible?: boolean
  staleDataSource?: boolean
  staleDispatchPlan?: boolean
  staleAccountSync?: boolean
  /** Product DONE mode: Stage 1 = MAP_VERIFIED; Stage 2 = PROD_READY|LIVE_VERIFIED. */
  productStageMode?: ProductStageMode
  /** P0-class data integrity beyond classification. */
  p0Blocker?: boolean
}

export interface RollupInput {
  pin: PinnedRevisionTuple
  tasks: ReadonlyArray<RollupTaskInput>
  g5Domains: ReadonlyArray<G5DomainRecord>
  featureContractJoins?: ReadonlyArray<FeatureContractJoin>
  nodeJoins?: ReadonlyArray<NodeJoin>
  dependencyJoins?: ReadonlyArray<DependencyJoin>
  primaryOwnership?: ReadonlyArray<PrimaryOwnership>
  now?: string
  /** Evidence completeness for board cap (defaults from prodReadyWithEvidence equality). */
  evidenceCompleteOverride?: boolean
}

// ---- join / ownership rejection (AC-COUNT-02) ----

export function assertDistinctJoins(input: {
  featureContractJoins?: ReadonlyArray<FeatureContractJoin>
  nodeJoins?: ReadonlyArray<NodeJoin>
  dependencyJoins?: ReadonlyArray<DependencyJoin>
  primaryOwnership?: ReadonlyArray<PrimaryOwnership>
}): void {
  const fc = input.featureContractJoins ?? []
  const seenFc = new Set<string>()
  for (const j of fc) {
    if (!j.featureContractId || !j.taskId) {
      throw new DomainError('INVALID_INPUT', 'feature contract join missing ids', { join: j })
    }
    // Duplicate FC join that multiplies a task (same FC paired more than once).
    if (seenFc.has(j.featureContractId)) {
      throw new DomainError(
        'DUPLICATE_FC_JOIN',
        `duplicate feature-contract join multiplies tasks: ${j.featureContractId}`,
        { featureContractId: j.featureContractId },
      )
    }
    seenFc.add(j.featureContractId)
  }

  const nodes = input.nodeJoins ?? []
  const seenNode = new Set<string>()
  for (const j of nodes) {
    if (!j.nodeId || !j.taskId) {
      throw new DomainError('INVALID_INPUT', 'node join missing ids', { join: j })
    }
    if (seenNode.has(j.nodeId)) {
      throw new DomainError(
        'DUPLICATE_NODE_JOIN',
        `duplicate node join multiplies tasks: ${j.nodeId}`,
        { nodeId: j.nodeId },
      )
    }
    seenNode.add(j.nodeId)
  }

  const deps = input.dependencyJoins ?? []
  const seenDep = new Set<string>()
  for (const j of deps) {
    if (!j.fromTaskId || !j.toTaskId) {
      throw new DomainError('INVALID_INPUT', 'dependency join missing ids', { join: j })
    }
    const key = `${j.fromTaskId}->${j.toTaskId}`
    if (seenDep.has(key)) {
      throw new DomainError(
        'DUPLICATE_DEPENDENCY_JOIN',
        `duplicate dependency join multiplies rows: ${key}`,
        { fromTaskId: j.fromTaskId, toTaskId: j.toTaskId },
      )
    }
    seenDep.add(key)
  }

  const owners = input.primaryOwnership ?? []
  const ownerByTask = new Map<string, string>()
  for (const o of owners) {
    if (!o.taskId || !o.ownerId) {
      throw new DomainError('INVALID_INPUT', 'primary ownership missing ids', { ownership: o })
    }
    const prev = ownerByTask.get(o.taskId)
    if (prev != null && prev !== o.ownerId) {
      throw new DomainError(
        'CONFLICTING_PRIMARY_OWNERSHIP',
        `conflicting primary ownership for task ${o.taskId}`,
        { taskId: o.taskId, owners: [prev, o.ownerId] },
      )
    }
    ownerByTask.set(o.taskId, o.ownerId)
  }
}

// ---- stage helpers ----

function stageIndex(stage: string | null | undefined): number {
  if (!stage) return -1
  return (LIFECYCLE_STAGE_ORDER as ReadonlyArray<string>).indexOf(stage)
}

function isProductDone(
  stage: string | null | undefined,
  mode: ProductStageMode,
): boolean {
  if (!stage) return false
  if (mode === 'STAGE_1') return stage === 'MAP_VERIFIED' || stageIndex(stage) > stageIndex('MAP_VERIFIED')
  // STAGE_2
  return stage === 'PROD_READY' || stage === 'LIVE_VERIFIED'
}

function isStageProdReady(stage: string | null | undefined): boolean {
  return stage === 'PROD_READY' || stage === 'LIVE_VERIFIED'
}

function evidenceValidForPin(
  evidence: StageEvidenceBinding | null | undefined,
  pin: PinnedRevisionTuple,
  stage: string | null | undefined,
): boolean {
  if (!evidence || !stage) return false
  if (evidence.stage !== stage) return false
  if (!evidence.receiptId || !evidence.receiptHash) return false
  if (!evidence.independentVerifier) return false
  if (evidence.boardRev !== pin.boardRev) return false
  if (evidence.lifecycleRev !== pin.lifecycleRev) return false
  if (evidence.taskHash !== pin.taskHash) return false
  if (evidence.canonicalHash !== pin.canonicalHash) return false
  if (
    evidence.authorRunId &&
    evidence.verifierRunId &&
    evidence.authorRunId === evidence.verifierRunId
  ) {
    return false
  }
  return true
}

// ---- bucket precedence (10 rules, AC-BUCKET-*) ----

export function assignBucket(task: RollupTaskInput, pin: PinnedRevisionTuple, now?: string): BucketAssignment {
  const evaluation = evaluateClassification(task.classification, pin, { now })
  const overlays: Array<StaleOverlayKind> = []
  const mode: ProductStageMode = task.productStageMode ?? 'STAGE_2'

  if (task.staleDataSource) overlays.push('STALE_DATA_SOURCE')
  if (task.staleDispatchPlan) overlays.push('STALE_DISPATCH_PLAN')
  if (task.staleAccountSync) overlays.push('STALE_ACCOUNT_SYNC')
  if (task.runLiveness === 'STALLED' || task.runLiveness === 'EXPIRED') {
    overlays.push('EXPIRED_STALLED_RUN')
  }

  // Rule 1: UNCLASSIFIED / missing invalid stale classification → BLOCKED:DATA_INTEGRITY
  if (evaluation.isClassificationRepair) {
    return {
      taskId: task.taskId,
      primary: 'BLOCKED',
      outsideTracked: false,
      blockReason: 'DATA_INTEGRITY',
      overlays,
      ruleIndex: 1,
    }
  }

  // Rule 2: fully classified HOLD/EXCLUDE → outside tracked buckets
  if (evaluation.isOutsideTrackedWork) {
    return {
      taskId: task.taskId,
      primary: null,
      outsideTracked: true,
      blockReason: null,
      overlays,
      ruleIndex: 2,
    }
  }

  // CONTROL_PLANE DONE (AC-BUCKET-04) — outside product progress, still tracked DONE
  if (evaluation.taskClass === 'CONTROL_PLANE') {
    const cpDone =
      !!task.classification.controlPlaneTargetGate &&
      task.classification.controlPlaneGateVerifiedPass === true &&
      task.classification.controlPlaneRootAccepted === true
    if (cpDone) {
      // lingering claim → overlay, stay DONE
      if (task.claimState === 'STALE' || task.claimState === 'ORPHAN' || task.claimState === 'EXPIRED') {
        overlays.push('STALE_CLAIM')
        overlays.push('RECONCILIATION_DRILLDOWN')
      }
      if (task.claimState === 'BEYOND_STAGE') {
        overlays.push('BEYOND_STAGE_ONGOING')
      }
      return {
        taskId: task.taskId,
        primary: 'DONE',
        outsideTracked: false,
        blockReason: null,
        overlays,
        ruleIndex: 3,
      }
    }
  }

  // Rule 3: current-stage DONE
  const productDone =
    evaluation.taskClass === 'PRODUCT' && isProductDone(task.lifecycleStage, mode)
  if (productDone) {
    if (task.claimState === 'STALE' || task.claimState === 'ORPHAN' || task.claimState === 'EXPIRED') {
      overlays.push('STALE_CLAIM')
      overlays.push('RECONCILIATION_DRILLDOWN')
    }
    if (task.claimState === 'BEYOND_STAGE') {
      overlays.push('BEYOND_STAGE_ONGOING')
    }
    return {
      taskId: task.taskId,
      primary: 'DONE',
      outsideTracked: false,
      blockReason: null,
      overlays,
      ruleIndex: 3,
    }
  }

  // Rule 4: stale/orphan/expired/fenced ownership → RECONCILIATION_PENDING
  // (only when not already DONE — completed-task exception above)
  // STALE chip family (ARCHITECTURE §9.1 "claim awaiting reconciliation") must
  // include incomplete recon ownership via STALE_CLAIM so rows remain primary
  // RECONCILIATION_PENDING while still matching staleFamily / STALE chip filter.
  if (
    task.claimState === 'STALE' ||
    task.claimState === 'ORPHAN' ||
    task.claimState === 'EXPIRED' ||
    task.claimState === 'FENCED' ||
    task.claimState === 'BEYOND_STAGE'
  ) {
    if (
      task.claimState === 'STALE' ||
      task.claimState === 'ORPHAN' ||
      task.claimState === 'EXPIRED' ||
      task.claimState === 'FENCED'
    ) {
      overlays.push('STALE_CLAIM')
    }
    if (task.claimState === 'BEYOND_STAGE') {
      overlays.push('BEYOND_STAGE_ONGOING')
    }
    overlays.push('RECONCILIATION_DRILLDOWN')
    return {
      taskId: task.taskId,
      primary: 'RECONCILIATION_PENDING',
      outsideTracked: false,
      blockReason: null,
      overlays,
      ruleIndex: 4,
    }
  }

  // Rule 5: blocking human decision → BLOCKED (non-blocking does NOT demote)
  if (task.hasBlockingDecision) {
    return {
      taskId: task.taskId,
      primary: 'BLOCKED',
      outsideTracked: false,
      blockReason: 'BLOCKING_DECISION',
      overlays,
      ruleIndex: 5,
    }
  }

  // Rule 6: valid current-stage claim + STARTING/RUNNING → ONGOING
  if (
    task.claimState === 'VALID_CURRENT' &&
    (task.runLiveness === 'STARTING' || task.runLiveness === 'RUNNING')
  ) {
    return {
      taskId: task.taskId,
      primary: 'ONGOING',
      outsideTracked: false,
      blockReason: null,
      overlays,
      ruleIndex: 6,
    }
  }

  // Rule 7: hard blocker → BLOCKED
  if (task.hardBlocker || task.p0Blocker) {
    return {
      taskId: task.taskId,
      primary: 'BLOCKED',
      outsideTracked: false,
      blockReason: task.p0Blocker ? 'DATA_INTEGRITY' : 'HARD_BLOCKER',
      overlays,
      ruleIndex: 7,
    }
  }

  // Rule 8: active dispatch-plan selection → NEXT
  if (task.selectedForNextDispatch) {
    return {
      taskId: task.taskId,
      primary: 'NEXT',
      outsideTracked: false,
      blockReason: null,
      overlays,
      ruleIndex: 8,
    }
  }

  // Rule 9: eligible → QUEUED
  if (task.eligible) {
    return {
      taskId: task.taskId,
      primary: 'QUEUED',
      outsideTracked: false,
      blockReason: null,
      overlays,
      ruleIndex: 9,
    }
  }

  // Rule 10: other malformed → BLOCKED:DATA_INTEGRITY
  return {
    taskId: task.taskId,
    primary: 'BLOCKED',
    outsideTracked: false,
    blockReason: 'MALFORMED' as BlockReasonCode,
    overlays,
    ruleIndex: 10,
  }
}

// ---- main rollup ----

function emptyBuckets(): RollupV3BucketCounts {
  return {
    DONE: 0,
    RECONCILIATION_PENDING: 0,
    ONGOING: 0,
    NEXT: 0,
    QUEUED: 0,
    BLOCKED: 0,
  }
}

function emptyOverlays(): Record<StaleOverlayKind, number> {
  return {
    STALE_DATA_SOURCE: 0,
    EXPIRED_STALLED_RUN: 0,
    STALE_CLAIM: 0,
    STALE_DISPATCH_PLAN: 0,
    STALE_ACCOUNT_SYNC: 0,
    BEYOND_STAGE_ONGOING: 0,
    RECONCILIATION_DRILLDOWN: 0,
  }
}

/**
 * Compute pure V3 rollup bound to one snapshot/hash/task hash/boardRev/lifecycleRev.
 * Rejects duplicate joins / conflicting ownership (AC-COUNT-01/02).
 */
export function computeRollupV3(input: RollupInput): RollupV3Result {
  const { pin } = input
  if (
    !pin ||
    typeof pin.boardRev !== 'number' ||
    typeof pin.lifecycleRev !== 'number' ||
    !pin.canonicalSnapshotId ||
    !pin.canonicalHash ||
    !pin.taskHash
  ) {
    throw new DomainError('INVALID_INPUT', 'pinned revision tuple incomplete', { pin })
  }

  assertDistinctJoins({
    featureContractJoins: input.featureContractJoins,
    nodeJoins: input.nodeJoins,
    dependencyJoins: input.dependencyJoins,
    primaryOwnership: input.primaryOwnership,
  })

  // DISTINCT by taskId — last occurrence wins (deterministic sort after).
  const byId = new Map<string, RollupTaskInput>()
  for (const t of input.tasks) {
    if (!t.taskId) {
      throw new DomainError('INVALID_INPUT', 'task missing taskId')
    }
    if (!t.classification || t.classification.taskId !== t.taskId) {
      // Normalize classification taskId to task.taskId for fail-closed consistency.
      const classification: TaskClassificationRecord = {
        ...(t.classification ?? {
          taskId: t.taskId,
          taskClass: 'UNCLASSIFIED',
          disposition: 'UNCLASSIFIED',
          receipt: null,
        }),
        taskId: t.taskId,
      }
      byId.set(t.taskId, { ...t, classification })
    } else {
      byId.set(t.taskId, t)
    }
  }

  const sortedIds = [...byId.keys()].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0))
  const assignments: Array<BucketAssignment> = []
  const buckets = emptyBuckets()
  const overlays = emptyOverlays()

  const trackedTaskIds: Array<string> = []
  const productTaskIds: Array<string> = []
  const productWeights: Array<number> = []
  let stageProdReady = 0
  let prodReadyWithEvidence = 0
  let unclassifiedCount = 0
  let hasP0OrDataIntegrityBlocker = false

  for (const taskId of sortedIds) {
    const task = byId.get(taskId)!
    const evaluation = evaluateClassification(task.classification, pin, {
      now: input.now,
    })
    const assignment = assignBucket(task, pin, input.now)
    assignments.push(assignment)

    for (const o of assignment.overlays) {
      overlays[o] = (overlays[o] ?? 0) + 1
    }

    if (assignment.outsideTracked) continue

    if (!isTrackedWork(evaluation) && !evaluation.isClassificationRepair) {
      // Should not happen if assignBucket agrees; treat as non-tracked.
      continue
    }

    trackedTaskIds.push(taskId)
    if (assignment.primary) {
      buckets[assignment.primary] += 1
    }

    if (evaluation.isClassificationRepair) {
      unclassifiedCount += 1
      hasP0OrDataIntegrityBlocker = true
    }
    if (task.p0Blocker) hasP0OrDataIntegrityBlocker = true
    if (assignment.blockReason === 'DATA_INTEGRITY') {
      hasP0OrDataIntegrityBlocker = true
    }

    if (isProductDenominatorMember(evaluation)) {
      productTaskIds.push(taskId)
      productWeights.push(taskStageWeight(task.lifecycleStage))
      if (isStageProdReady(task.lifecycleStage)) {
        stageProdReady += 1
        if (evidenceValidForPin(task.evidence ?? null, pin, task.lifecycleStage)) {
          prodReadyWithEvidence += 1
        }
      }
    }
  }

  const productDenominator = productTaskIds.length
  const trackedWorkDenominator = trackedTaskIds.length

  // Coverage invariant over DISTINCT IDs (AC-BUCKET-01).
  const bucketSum =
    buckets.DONE +
    buckets.RECONCILIATION_PENDING +
    buckets.ONGOING +
    buckets.NEXT +
    buckets.QUEUED +
    buckets.BLOCKED
  if (bucketSum !== trackedWorkDenominator) {
    throw new DomainError(
      'DATA_INTEGRITY',
      `bucket coverage mismatch: sum=${bucketSum} tracked=${trackedWorkDenominator}`,
      { buckets, trackedWorkDenominator },
    )
  }

  const g5Pass = deriveG5Pass(input.g5Domains, pin)
  const rawTaskReadinessPercent = meanReadinessOneDecimal(productWeights)

  const evidenceComplete =
    input.evidenceCompleteOverride ??
    (productDenominator > 0 && prodReadyWithEvidence === productDenominator)

  const complete = isBoardComplete({
    productDenominator,
    stageProdReady,
    prodReadyWithEvidence,
    g5Pass,
    unclassifiedCount,
    hasP0OrDataIntegrityBlocker,
  })

  const cap = applyBoardReadinessCap({
    rawTaskReadinessPercent,
    g5Pass,
    evidenceComplete: evidenceComplete && complete ? true : evidenceComplete,
    hasUnclassifiedOrP0: hasP0OrDataIntegrityBlocker || unclassifiedCount > 0,
    productDenominator,
  })

  // When fully complete, board readiness equals raw (100.0) with cappedBy null.
  let boardReadinessPercent = cap.boardReadinessPercent
  let cappedBy = cap.cappedBy
  if (complete && rawTaskReadinessPercent != null) {
    boardReadinessPercent = rawTaskReadinessPercent
    cappedBy = null
  }

  // Immutable / pure output — freeze shallow structures via plain return (callers treat as RO).
  const result: RollupV3Result = {
    schemaVersion: 'MFS_ROLLUP_V3',
    taskReadinessPolicyVersion: TASK_READINESS_POLICY_VERSION,
    boardReadinessPolicyVersion: BOARD_READINESS_POLICY_VERSION,
    pin: { ...pin },
    trackedWorkDenominator,
    productDenominator,
    stageProdReady,
    prodReadyWithEvidence,
    unclassifiedCount,
    g5Pass,
    complete,
    rawTaskReadinessPercent,
    boardReadinessPercent,
    cappedBy,
    buckets: { ...buckets },
    overlays: { ...overlays },
    trackedTaskIds: [...trackedTaskIds],
    productTaskIds: [...productTaskIds],
    assignments: assignments.map((a) => ({
      ...a,
      overlays: [...a.overlays],
    })),
    hasP0OrDataIntegrityBlocker,
  }

  return result
}

// ---- priority / capacity pure calc (AC-PRIORITY-01/02; not scheduler) ----

/** Stage-1/Stage-2 closure roles that count toward all/priority capacity. */
export const PRIORITY_CLOSURE_ROLES = new Set([
  // Stage 1
  'INVENTORY',
  'TASK_AUTHOR',
  'FC_LINKER',
  'MAPPING_VERIFY',
  'REPAIR_FILL',
  'MERGE_PUBLISH',
  // Stage 2
  'ANALYZE',
  'PRODUCT',
  'VERIFY',
  'COMMIT_INTEGRATE',
  'STAGING_PROOF',
  'G5',
  'G5_CLOSURE',
  // Common agent aliases mapped in isAllowedClosureRole
  'IMPLEMENTER',
  'VERIFIER',
  'ANALYZER',
])

/** Roles never counted as schedulable closure capacity. */
export const PRIORITY_EXCLUDED_ROLES = new Set([
  'ROOT',
  'IDLE',
  'IDLE_CONTROLLER',
  'CONTROLLER',
  'HEALTH',
  'HEALTH_ONLY',
  'FILLER',
  'NON_RUNNABLE',
  'DUPLICATE',
  'EXPIRED',
  'FENCED',
])

export function normalizeClosureRole(role: string | null | undefined): string {
  return String(role ?? '')
    .trim()
    .toUpperCase()
    .replace(/[\s-]+/g, '_')
}

/**
 * Fail-closed closure-role gate for all-role / priority capacity.
 * Missing role → allowed (pure unit packets / reserved plan rows without role).
 * Explicit excluded roles → false. Known Stage1/2 (+aliases) → true.
 * Unknown non-empty role → false (do not invent capacity for arbitrary labels).
 */
export function isAllowedClosureRole(role: string | null | undefined): boolean {
  if (role == null || String(role).trim() === '') return true
  const n = normalizeClosureRole(role)
  if (PRIORITY_EXCLUDED_ROLES.has(n)) return false
  if (PRIORITY_CLOSURE_ROLES.has(n)) return true
  // Partial aliases
  if (n.includes('IDLE') || n.includes('HEALTH') || n === 'ROOT') return false
  return false
}

export interface PriorityPacket {
  packetId: string
  taskId: string
  /** Live or reserved schedulable closure packet. */
  liveOrReserved: boolean
  genuine: boolean
  unique: boolean
  currentHash: boolean
  dependencyReady: boolean
  collisionSafe: boolean
  advancesOpenClosureGate: boolean
  /** Portfolio membership (priority) vs other closure. */
  isPriorityPortfolio: boolean
  /** Filler/root/idle/health-only/non-runnable/expired → excluded. */
  excluded?: boolean
  /** Optional Stage1/Stage2 role for closure-role filter. */
  closureRole?: string | null
}

export interface PriorityAllocationInput {
  pin: PinnedRevisionTuple
  /** Classification rows for membership filter. */
  tasks: ReadonlyArray<{
    taskId: string
    classification: TaskClassificationRecord
    /** Portfolio membership claim (sales-rebuild / mfs-web / backend dep). */
    priorityMembership?: boolean
  }>
  packets: ReadonlyArray<PriorityPacket>
  /** Explicit frontier state when no runnable frontier. */
  frontierStateWhenEmpty?: PriorityFrontierState
  now?: string
}

/**
 * Pure priority allocation semantics (AC-PRIORITY-01/02).
 * Process/physical slot count is NOT product progress.
 * Zero capacity / empty frontier → exact false/null/N-A, never majority PASS.
 */
export function computePriorityAllocation(
  input: PriorityAllocationInput,
): PriorityAllocationResult {
  // DISTINCT membership by taskId (AC-PRIORITY-01) — never count duplicate rows.
  const membershipSet = new Set<string>()
  for (const t of input.tasks) {
    if (!t.priorityMembership) continue
    const ev = evaluateClassification(t.classification, input.pin, { now: input.now })
    if (ev.contributesToProductReadiness) {
      membershipSet.add(t.taskId)
    }
  }
  const membershipTaskIds = [...membershipSet].sort((a, b) =>
    a < b ? -1 : a > b ? 1 : 0,
  )

  const schedulable = input.packets.filter(
    (p) =>
      !p.excluded &&
      p.liveOrReserved &&
      p.genuine &&
      p.unique &&
      p.currentHash &&
      p.dependencyReady &&
      p.collisionSafe &&
      p.advancesOpenClosureGate &&
      isAllowedClosureRole(p.closureRole),
  )

  // DISTINCT packet IDs
  const allIds = new Set(schedulable.map((p) => p.packetId))
  // Priority capacity only for packets whose task is in DISTINCT membership
  // (or explicitly flagged isPriorityPortfolio when membership already empty
  // for pure unit fixtures). Prefer membership-grounded priority when membership
  // is non-empty so plan-only tags cannot inflate priority under EMPTY frontier.
  const priorityIds = new Set(
    schedulable
      .filter((p) =>
        membershipSet.size > 0
          ? membershipSet.has(p.taskId) || p.isPriorityPortfolio
          : p.isPriorityPortfolio,
      )
      .map((p) => p.packetId),
  )
  // When no membership: fail-closed — do not report priority capacity > 0.
  const allClosureCapacity = allIds.size
  const priorityClosureCapacity =
    membershipSet.size === 0 ? 0 : priorityIds.size

  // Genuine runnable priority frontier = DISTINCT membership exists.
  // (Zero capacity still counts as frontier-for-N-A ZERO_SCHEDULABLE_CAPACITY.)
  const genuineRunnableFrontier = membershipTaskIds.length > 0

  let priorityCapacityShare: number | null
  let majorityAllocationPass: boolean | null
  let frontierState: PriorityFrontierState
  let reason: string | null

  if (!genuineRunnableFrontier) {
    // No genuine priority frontier — fail-closed N-A (never majority PASS).
    priorityCapacityShare = null
    majorityAllocationPass = null
    frontierState = input.frontierStateWhenEmpty ?? 'PRIORITY_FRONTIER_EMPTY'
    reason = frontierState
  } else if (allClosureCapacity === 0) {
    // Frontier exists, zero schedulable capacity
    priorityCapacityShare = null
    majorityAllocationPass = false
    frontierState = 'PRIORITY_FRONTIER_ACTIVE'
    reason = 'ZERO_SCHEDULABLE_CAPACITY'
  } else {
    priorityCapacityShare = priorityClosureCapacity / allClosureCapacity
    majorityAllocationPass = priorityCapacityShare > 0.5
    frontierState = 'PRIORITY_FRONTIER_ACTIVE'
    reason = null
  }

  return {
    portfolioId: 'SALES_WEB_RELATED_BACKEND',
    membershipTaskIds: [...membershipTaskIds],
    membershipDenominator: membershipTaskIds.length,
    priorityClosureCapacity,
    allClosureCapacity,
    priorityCapacityShare,
    majorityAllocationPass,
    frontierState,
    reason,
  }
}
