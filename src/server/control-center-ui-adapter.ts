/**
 * C3-W1: Load board source objects → one ControlCenterAggregation pin.
 * Fail-closed: missing V3 classification/receipt → UNCLASSIFIED (never invent PRODUCT
 * from phase/progress/pct). Reuses C1/C2 rollup/priority/G5/dispatch via control-center-ui.
 * Account IDs masked; no tokens/private decision bodies/secrets in aggregation inputs.
 *
 * Durable truth (runtime context): V3 runs/accounts/active plan, DecisionV3, G5,
 * classifications, material audit — loaded in parallel. Active ownership is derived
 * from durable run registry only (never legacy embedded claimState / board.runs).
 */

import { createHash } from 'node:crypto'

import { buildModel } from '#/lib/model'
import type {
  ClassificationReceipt,
  G5DomainRecord,
  PrimaryOwnership,
  TaskClassificationRecord,
  TaskClass,
  TaskDisposition,
} from '#/lib/control-plane-types'
import { TASK_CLASSES, TASK_DISPOSITIONS } from '#/lib/control-plane-types'
import type { Decision, DecisionOptionV3Carrier, RawBoard, Run, WorkTask } from '#/lib/types'
import {
  isPinComplete,
  isSyntheticCanonicalSnapshotId,
  tryLoadPinnedDefinitionReadModel,
  type CanonicalDefinitionProjection,
  type CanonicalDefinitionReadModel,
} from '#/server/canonical-read-model'
import {
  boardHash,
  listBoards,
  readBoard,
  readOps,
  readTasks,
  type ControlPlaneAuditEvent,
} from '#/server/board-store'
import { parseValidClaimState, type ValidClaimState } from '#/server/tasks-store'
import {
  selectNextFromActivePlan,
  getSharedDispatchPlanStore,
  projectDispatchNextFields,
  type DispatchPlanRecord,
} from '#/server/control-plane-ingest'
import { createSystemClock } from '#/server/board-store'
import { db } from '#/server/db'
import type { DecisionV3Record, DecisionSeverity, DecisionV3Status } from '#/server/decisions-v3'
import {
  projectAccountSyncCcReadModel,
  readLatestAccountSyncSnapshot,
  type AccountSyncCcReadModel,
  type AccountSyncSnapshot,
  type MaskedAccountRecord,
} from '#/server/account-sync'
import {
  loadPinnedAuthoritativeAccountSnapshot,
  readAuthenticatedUiAccountSourceService,
} from '#/server/account-surface-readers'
import {
  aggregateControlCenter,
  attachOwnerHumanDisplayToWorkSurfaces,
  humanDisplayEntityKey,
  livePinFromControlCenter,
  maskAccountForUi,
  projectOwnerHumanDisplayUi,
  type AccountSyncUiMeta,
  type AccountUiSummary,
  type AuditUiEvent,
  type ControlCenterAggregation,
  type ControlCenterAggregationInput,
  type ControlCenterPin,
  type ControlCenterTaskInput,
  type DispatchNextUi,
  type FeatureUiSummary,
  type OwnerHumanDisplayUiProjection,
  type ProjectUiSummary,
  type ProductiveSubstate,
  type RunUiSummary,
} from '#/server/control-center-ui'
import type { HumanDisplayRecord } from '#/server/human-display-persistence'
import {
  getControlPlaneRuntimeContext,
  type ControlPlaneRuntimeContext,
} from '#/server/control-plane-runtime-context'
import {
  LEASED_RUN_STATES,
  RUN_LEASE_MS,
  RUN_RECONCILIATION_GRACE_MS,
  TERMINAL_RUN_STATES,
  type RunRecord,
  type RunState,
} from '#/server/run-registry'
import type { PriorityPacket } from '#/server/rollup-v3'
import type { ClaimState, RunLiveness } from '#/server/rollup-v3'

/** Optional run-registry / extended fields never mirrored from heartbeat alone. */
type RunSourceExt = Run & {
  heartbeatAt?: string | null
  materialProgressAt?: string | null
  claimState?: string | null
  collisionScopeLockIds?: string[] | null
  controllerRunId?: string | null
  parentRunId?: string | null
  targetGate?: string | null
  fencingToken?: string | null
  leaseExpiresAt?: string | null
  leaseExpiresAtMs?: number | null
}

export {
  CONTROL_CENTER_BOARD_IDS,
  CONTROL_CENTER_PRIMARY_NAV_IDS,
  isControlCenterBoard,
  type ControlCenterPrimaryNavId,
} from '#/lib/control-center-query'

function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function isTaskClass(v: unknown): v is TaskClass {
  return typeof v === 'string' && (TASK_CLASSES as ReadonlyArray<string>).includes(v)
}

function isDisposition(v: unknown): v is TaskDisposition {
  return typeof v === 'string' && (TASK_DISPOSITIONS as ReadonlyArray<string>).includes(v)
}

/**
 * Map a persisted task to V3 classification for rollup.
 * NEVER promotes PRODUCT from phase/scope/mappingPct/status.
 * Missing receipt → UNCLASSIFIED + null receipt → DATA_INTEGRITY via C1.
 */
export function mapTaskClassification(
  task: WorkTask,
  _pin: Pick<
    ControlCenterPin,
    'canonicalSnapshotId' | 'canonicalHash' | 'taskHash' | 'boardRev' | 'lifecycleRev'
  >,
): TaskClassificationRecord {
  void _pin
  const raw = task as WorkTask & {
    taskClass?: unknown
    disposition?: unknown
    classification?: {
      taskClass?: unknown
      disposition?: unknown
      receipt?: ClassificationReceipt | null
      controlPlaneTargetGate?: string | null
      controlPlaneGateVerifiedPass?: boolean
      controlPlaneRootAccepted?: boolean
    }
    classificationReceipt?: ClassificationReceipt | null
    classificationReceiptId?: string | null
    classificationReceiptHash?: string | null
  }

  const nested = raw.classification
  const taskClass = isTaskClass(nested?.taskClass)
    ? nested!.taskClass
    : isTaskClass(raw.taskClass)
      ? raw.taskClass
      : null
  const disposition = isDisposition(nested?.disposition)
    ? nested!.disposition
    : isDisposition(raw.disposition)
      ? raw.disposition
      : null
  const receipt: ClassificationReceipt | null =
    (nested?.receipt && typeof nested.receipt === 'object' ? nested.receipt : null) ??
    (raw.classificationReceipt && typeof raw.classificationReceipt === 'object'
      ? raw.classificationReceipt
      : null)

  // Fail-closed: without both class+disposition+receipt, stay UNCLASSIFIED.
  if (
    !taskClass ||
    !disposition ||
    taskClass === 'UNCLASSIFIED' ||
    disposition === 'UNCLASSIFIED' ||
    !receipt
  ) {
    return {
      taskId: task.id,
      taskClass: 'UNCLASSIFIED',
      disposition: 'UNCLASSIFIED',
      receipt: null,
    }
  }

  // Bind receipt to current pin only when caller already persisted matching fields;
  // do not rewrite receipt to invent validity.
  return {
    taskId: task.id,
    taskClass,
    disposition,
    receipt,
    controlPlaneTargetGate: nested?.controlPlaneTargetGate ?? null,
    controlPlaneGateVerifiedPass: nested?.controlPlaneGateVerifiedPass,
    controlPlaneRootAccepted: nested?.controlPlaneRootAccepted,
  }
}

const PRODUCT_STAGE_MODES = new Set(['STAGE_1', 'STAGE_2'])
const DECISION_V3_STATUSES = new Set<string>([
  'OPEN',
  'ACKNOWLEDGED',
  'RESOLVED',
  'REJECTED',
  'EXPIRED',
  'CANCELLED',
])
const DECISION_SEVERITIES = new Set<string>(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])
const LEASED_SET = new Set<string>(LEASED_RUN_STATES as ReadonlyArray<string>)
const TERMINAL_SET = new Set<string>(TERMINAL_RUN_STATES as ReadonlyArray<string>)

/** Safe subject/canonical hash shape (matches classification receipt hash bounds). */
export const SAFE_CANONICAL_HASH_RE = /^[a-f0-9]{16,128}$/i
/** Bounded non-empty snapshot id (alphanumeric + common separators). */
export const SAFE_SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

// ---------------------------------------------------------------------------
// Durable ownership / claim derivation (V3 run registry — not embedded claims)
// ---------------------------------------------------------------------------

/** Minimal task facts needed for beyond-stage detection. */
export type OwnershipTaskHint = {
  taskId: string
  lifecycleStage?: string | null
  productStageMode?: 'STAGE_1' | 'STAGE_2' | null
}

export type DurableTaskOwnership = {
  taskId: string
  /** Active primary owner (agent) when unique + valid. */
  ownerId: string | null
  claimState: ClaimState
  runLiveness: RunLiveness
  /** Conflicting primary owners for same task → rollup BLOCKED:DATA_INTEGRITY. */
  conflicting: boolean
  conflictOwnerIds: string[]
  primaryRun: RunRecord | null
  /** All non-terminal durable runs for this task (sorted by recency). */
  runs: RunRecord[]
}

export type DurableOwnershipResult = {
  byTaskId: Map<string, DurableTaskOwnership>
  /** Distinct non-conflicting primary ownership edges for rollup join check. */
  primaryOwnership: PrimaryOwnership[]
  /** Task IDs with multi-owner conflict → forced DATA_INTEGRITY. */
  conflictTaskIds: string[]
}

function isLeasedState(state: string): boolean {
  return LEASED_SET.has(state)
}

function isTerminalState(state: string): boolean {
  return TERMINAL_SET.has(state)
}

function isProductStageDone(
  stage: string | null | undefined,
  mode: 'STAGE_1' | 'STAGE_2' = 'STAGE_2',
): boolean {
  if (!stage) return false
  if (mode === 'STAGE_1') {
    return stage === 'MAP_VERIFIED' || stage === 'PROD_READY' || stage === 'LIVE_VERIFIED'
  }
  return stage === 'PROD_READY' || stage === 'LIVE_VERIFIED'
}

function runRecencyMs(rec: RunRecord): number {
  return (
    rec.heartbeatAtMs ??
    rec.materialProgressAtMs ??
    rec.registeredAtMs ??
    rec.leaseExpiresAtMs ??
    0
  )
}

function mapRunStateToLiveness(state: RunState, stalled: boolean): RunLiveness {
  if (state === 'STARTING' || state === 'RESERVED') return 'STARTING'
  if (state === 'RUNNING' || state === 'WAITING_HUMAN') {
    return stalled ? 'STALLED' : 'RUNNING'
  }
  if (state === 'STALE' || state === 'FAILED') return 'EXPIRED'
  return 'NONE'
}

/**
 * Pure: derive claim/ownership for one durable RunRecord.
 * Never reads WorkTask.claimState or legacy board.runs claim embeds.
 */
export function deriveClaimStateFromRunRecord(
  rec: RunRecord,
  nowMs: number,
  taskHint?: OwnershipTaskHint | null,
): { claimState: ClaimState; runLiveness: RunLiveness } {
  const runLiveness = mapRunStateToLiveness(rec.state, rec.stalled)

  if (rec.state === 'QUEUED') {
    return { claimState: 'NONE', runLiveness: 'NONE' }
  }
  if (rec.state === 'STALE') {
    return { claimState: 'STALE', runLiveness: 'EXPIRED' }
  }
  if (rec.state === 'SUPERSEDED') {
    return { claimState: 'FENCED', runLiveness: 'NONE' }
  }
  if (isTerminalState(rec.state)) {
    // Terminal history only — no active claim (completed linger handled by overlays when set elsewhere).
    return { claimState: 'NONE', runLiveness: 'NONE' }
  }

  // Orphan: leased-ish but missing agent / fence
  if (!rec.agentId || rec.fencingToken == null) {
    return { claimState: 'ORPHAN', runLiveness }
  }

  const leaseExpired =
    rec.leaseExpiresAtMs != null &&
    rec.leaseExpiresAtMs + RUN_RECONCILIATION_GRACE_MS <= nowMs
  const neverHeartbeated =
    rec.registeredAtMs != null &&
    rec.heartbeatAtMs == null &&
    nowMs - rec.registeredAtMs > RUN_LEASE_MS + RUN_RECONCILIATION_GRACE_MS

  if (leaseExpired) {
    return { claimState: 'EXPIRED', runLiveness: 'EXPIRED' }
  }
  if (neverHeartbeated) {
    return { claimState: 'ORPHAN', runLiveness }
  }

  // Ambiguous fence recovery → FENCED
  if (
    rec.fencingVersion > 1 &&
    rec.heartbeatAtMs != null &&
    nowMs - rec.heartbeatAtMs > RUN_LEASE_MS
  ) {
    return { claimState: 'FENCED', runLiveness: 'STALLED' }
  }

  const mode = taskHint?.productStageMode === 'STAGE_1' ? 'STAGE_1' : 'STAGE_2'
  const productDone = isProductStageDone(taskHint?.lifecycleStage, mode)
  if (productDone && isLeasedState(rec.state)) {
    // Valid claim after current-stage completion → beyond-stage ongoing overlay path.
    return { claimState: 'BEYOND_STAGE', runLiveness }
  }

  if (isLeasedState(rec.state)) {
    return { claimState: 'VALID_CURRENT', runLiveness }
  }

  return { claimState: 'STALE', runLiveness }
}

/**
 * Deterministic multi-run ownership rollup per task.
 * Conflicting distinct agent owners on non-terminal runs → conflicting=true
 * (caller forces BLOCKED:DATA_INTEGRITY; does not pass multi-owner edges to rollup).
 */
export function deriveDurableOwnership(
  runs: ReadonlyArray<RunRecord>,
  nowMs: number,
  taskHints: ReadonlyArray<OwnershipTaskHint> = [],
): DurableOwnershipResult {
  const hintById = new Map(taskHints.map((t) => [t.taskId, t] as const))
  const byTask = new Map<string, RunRecord[]>()
  for (const r of runs) {
    if (!r.taskId) continue
    const list = byTask.get(r.taskId) ?? []
    list.push(r)
    byTask.set(r.taskId, list)
  }

  const byTaskId = new Map<string, DurableTaskOwnership>()
  const primaryOwnership: PrimaryOwnership[] = []
  const conflictTaskIds: string[] = []

  for (const [taskId, taskRuns] of byTask) {
    const sorted = [...taskRuns].sort((a, b) => runRecencyMs(b) - runRecencyMs(a))
    const active = sorted.filter((r) => !isTerminalState(r.state) && r.state !== 'QUEUED')
    const owners = new Set(
      active
        .map((r) => (r.agentId && r.agentId.trim() ? r.agentId.trim() : ''))
        .filter(Boolean),
    )
    const conflicting = owners.size > 1
    if (conflicting) conflictTaskIds.push(taskId)

    const hint = hintById.get(taskId) ?? { taskId }
    const primaryRun = conflicting ? null : (active[0] ?? null)
    let claimState: ClaimState = 'NONE'
    let runLiveness: RunLiveness = 'NONE'
    if (conflicting) {
      // Integrity failure — not a valid claim state for ONGOING.
      claimState = 'NONE'
      runLiveness = 'NONE'
    } else if (primaryRun) {
      const d = deriveClaimStateFromRunRecord(primaryRun, nowMs, hint)
      claimState = d.claimState
      runLiveness = d.runLiveness
    }

    const ownerId =
      !conflicting && primaryRun?.agentId && primaryRun.agentId.trim()
        ? primaryRun.agentId.trim()
        : null

    byTaskId.set(taskId, {
      taskId,
      ownerId,
      claimState,
      runLiveness,
      conflicting,
      conflictOwnerIds: [...owners].sort(),
      primaryRun,
      runs: sorted,
    })

    if (ownerId && !conflicting) {
      primaryOwnership.push({ taskId, ownerId })
    }
  }

  primaryOwnership.sort((a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : a.ownerId < b.ownerId ? -1 : 1,
  )
  conflictTaskIds.sort()

  return { byTaskId, primaryOwnership, conflictTaskIds }
}

/** Map durable RunRecord → board Run shape used by UI projection helpers. */
export function mapRunRecordToBoardRun(rec: RunRecord): Run & RunSourceExt {
  const started =
    rec.registeredAtMs != null ? new Date(rec.registeredAtMs).toISOString() : null
  const heartbeatAt =
    rec.heartbeatAtMs != null ? new Date(rec.heartbeatAtMs).toISOString() : null
  const materialProgressAt =
    rec.materialProgressAtMs != null
      ? new Date(rec.materialProgressAtMs).toISOString()
      : null
  const statusMap: Record<string, Run['status']> = {
    QUEUED: 'queued',
    RESERVED: 'running',
    STARTING: 'running',
    RUNNING: 'running',
    WAITING_HUMAN: 'blocked',
    SUCCEEDED: 'done',
    FAILED: 'failed',
    CANCELLED: 'done',
    STALE: 'failed',
    SUPERSEDED: 'failed',
  }
  return {
    id: rec.runId,
    agent: rec.agentId,
    agentType: 'other',
    model: rec.model,
    effort: rec.effort,
    task: rec.taskId,
    taskId: rec.taskId,
    status: statusMap[rec.state] ?? 'running',
    started: started ?? '',
    updated: heartbeatAt ?? started ?? '',
    role: rec.role,
    account: rec.maskedAccountRef ?? undefined,
    heartbeatAt,
    materialProgressAt,
    collisionScopeLockIds: rec.collisionScopeLockIds,
    controllerRunId: rec.controllerRunId,
    parentRunId: rec.parentRunId,
    targetGate: rec.targetGate,
    fencingToken: rec.fencingToken,
    leaseExpiresAtMs: rec.leaseExpiresAtMs,
  }
}

/**
 * Build PriorityPacket[] from active plan + live durable runs.
 * Empty when no plan items / live reserved capacity — never invent majority PASS.
 */
export function buildPriorityPacketsFromDurable(opts: {
  plan: DispatchPlanRecord | null
  runs: ReadonlyArray<RunRecord>
  membershipTaskIds: ReadonlySet<string>
  pinCanonicalHash: string
  nowMs: number
}): PriorityPacket[] {
  const packets: PriorityPacket[] = []
  const seen = new Set<string>()

  const push = (p: PriorityPacket) => {
    if (seen.has(p.packetId)) return
    seen.add(p.packetId)
    packets.push(p)
  }

  const plan = opts.plan
  if (plan && plan.status === 'ACTIVE' && plan.expiresAtMs > opts.nowMs) {
    const hashOk =
      typeof plan.canonicalHash === 'string' &&
      plan.canonicalHash.length > 0 &&
      (plan.canonicalHash === opts.pinCanonicalHash || opts.pinCanonicalHash.length === 0)
    for (const it of plan.items) {
      const depOk = it.dependencyProof == null || it.dependencyProof.satisfied === true
      const isPriority =
        it.priorityPortfolioId === 'SALES_WEB_RELATED_BACKEND' ||
        opts.membershipTaskIds.has(it.taskId)
      push({
        packetId: `plan:${plan.planId}:${it.rank}:${it.taskId}`,
        taskId: it.taskId,
        liveOrReserved: true,
        genuine: true,
        unique: true,
        currentHash: hashOk,
        dependencyReady: depOk,
        collisionSafe: true,
        advancesOpenClosureGate: depOk,
        isPriorityPortfolio: isPriority,
      })
    }
  }

  for (const rec of opts.runs) {
    if (!isLeasedState(rec.state) && rec.state !== 'QUEUED') continue
    if (isTerminalState(rec.state)) continue
    const liveOrReserved = isLeasedState(rec.state) || rec.state === 'QUEUED'
    const hashOk =
      rec.canonicalHash == null ||
      rec.canonicalHash === opts.pinCanonicalHash ||
      opts.pinCanonicalHash.length === 0
    const isPriority = opts.membershipTaskIds.has(rec.taskId)
    push({
      packetId: `run:${rec.runId}`,
      taskId: rec.taskId,
      liveOrReserved,
      genuine: Boolean(rec.agentId),
      unique: true,
      currentHash: hashOk,
      dependencyReady: true,
      collisionSafe: (rec.collisionScopeLockIds?.length ?? 0) >= 0,
      advancesOpenClosureGate: isLeasedState(rec.state),
      isPriorityPortfolio: isPriority,
      excluded: rec.state === 'QUEUED' ? true : undefined,
    })
  }

  packets.sort((a, b) => (a.packetId < b.packetId ? -1 : a.packetId > b.packetId ? 1 : 0))
  return packets
}

/** Prefer durable classification store row; fail-closed UNCLASSIFIED when missing/invalid. */
export function resolveTaskClassification(
  task: WorkTask,
  pin: Pick<
    ControlCenterPin,
    'canonicalSnapshotId' | 'canonicalHash' | 'taskHash' | 'boardRev' | 'lifecycleRev'
  >,
  durableByTaskId?: ReadonlyMap<string, TaskClassificationRecord> | null,
): TaskClassificationRecord {
  const fromStore = durableByTaskId?.get(task.id)
  if (fromStore) {
    // Re-validate via same fail-closed rules as embedded path.
    if (
      !fromStore.taskClass ||
      !fromStore.disposition ||
      fromStore.taskClass === 'UNCLASSIFIED' ||
      fromStore.disposition === 'UNCLASSIFIED' ||
      !fromStore.receipt
    ) {
      return {
        taskId: task.id,
        taskClass: 'UNCLASSIFIED',
        disposition: 'UNCLASSIFIED',
        receipt: null,
      }
    }
    return {
      ...fromStore,
      taskId: task.id,
    }
  }
  return mapTaskClassification(task, pin)
}

/** Map ControlPlane material audit → UI audit event (bounded summary). */
export function mapMaterialAuditToUiEvent(
  ev: ControlPlaneAuditEvent,
): AuditUiEvent {
  const summaryParts = [
    ev.kind,
    ev.subjectType,
    ev.subjectId,
    typeof ev.detail?.reason === 'string' ? ev.detail.reason : null,
  ].filter(Boolean)
  return {
    id: ev.eventId,
    createdAt: ev.atISO,
    kind: ev.kind,
    actorId: ev.actorId,
    subjectId: ev.subjectId,
    summary: summaryParts.join(' ').slice(0, 500),
    materialHash: typeof ev.detail?.materialHash === 'string' ? ev.detail.materialHash : null,
    boardRev:
      typeof ev.detail?.boardRev === 'number' && Number.isFinite(ev.detail.boardRev)
        ? ev.detail.boardRev
        : null,
  }
}

export function mapImportAuditToUiEvent(row: {
  auditId: string
  capturedAt: string
  event: string
  actorId: string | null
  importId: string | null
  contentHash: string | null
  boardRev: number | null
}): AuditUiEvent {
  return {
    id: row.auditId,
    createdAt: row.capturedAt,
    kind: row.event || 'import_audit',
    actorId: row.actorId,
    subjectId: row.importId,
    summary: `${row.event}${row.importId ? ` import=${row.importId}` : ''}`.slice(0, 500),
    materialHash: row.contentHash,
    boardRev: row.boardRev,
  }
}

function coerceIsoMs(value: unknown): { iso: string | null; ms: number | null } {
  if (typeof value !== 'string' || !value.trim()) return { iso: null, ms: null }
  const ms = Date.parse(value)
  if (!Number.isFinite(ms)) return { iso: null, ms: null }
  return { iso: new Date(ms).toISOString(), ms }
}

function coerceNonNegInt(value: unknown, fallback: number): number {
  const n = Number(value)
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < 0) return fallback
  return n
}

function mapDecisionOptions(
  d: Decision | (Decision & Record<string, unknown>),
): DecisionV3Record['options'] {
  const rawOptions = (d as Decision).options
  if (Array.isArray(rawOptions) && rawOptions.length > 0) {
    const mapped: DecisionV3Record['options'] = []
    for (const o of rawOptions) {
      if (!o || typeof o !== 'object') continue
      const carrier = o as DecisionOptionV3Carrier
      const optionId = String(carrier.optionId ?? carrier.id ?? carrier.key ?? '').trim()
      const label = String(carrier.label ?? '').trim()
      if (!optionId || !label) continue
      // Refuse authority-broadening option flags if present on carrier.
      const broad = o as DecisionOptionV3Carrier & {
        requestsProductionAuthority?: boolean
        requestsHoldAuthority?: boolean
        requestsProviderAuthority?: boolean
      }
      if (
        broad.requestsProductionAuthority ||
        broad.requestsHoldAuthority ||
        broad.requestsProviderAuthority
      ) {
        continue
      }
      mapped.push({
        optionId: optionId.slice(0, 80),
        label: label.slice(0, 400),
        declining: carrier.declining === true ? true : undefined,
        tradeoffs:
          typeof carrier.tradeoffs === 'string' && carrier.tradeoffs.trim()
            ? carrier.tradeoffs.slice(0, 800)
            : null,
      })
    }
    if (mapped.length > 0) return mapped
  }
  // Legacy opsi array
  const opsi = (d as Decision).opsi
  if (Array.isArray(opsi) && opsi.length > 0) {
    const mapped = opsi
      .map((o) => {
        const optionId = String(o?.key ?? '').trim()
        const label = String(o?.label ?? '').trim()
        if (!optionId || !label) return null
        return { optionId: optionId.slice(0, 80), label: label.slice(0, 400), tradeoffs: null }
      })
      .filter((x): x is NonNullable<typeof x> => x !== null)
    if (mapped.length > 0) return mapped
  }
  return [{ optionId: 'ack', label: 'Acknowledge' }]
}

function mapEvidenceStringRefs(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const item of value) {
    if (typeof item !== 'string') continue
    const s = item.trim()
    if (!s) continue
    out.push(s.slice(0, 500))
    if (out.length >= 32) break
  }
  return out
}

export function mapWorkTaskToControlCenterInput(
  task: WorkTask,
  pin: ControlCenterPin,
  opts: {
    selectedForNextDispatch?: boolean
    hasBlockingDecision?: boolean
    hasNonBlockingDecision?: boolean
    run?: Run | null
    /**
     * When set (durable ownership path), supersedes WorkTask.claimState and
     * legacy run-status liveness inference.
     */
    durableOwnership?: DurableTaskOwnership | null
    /** Durable classification store row (preferred over embedded task fields). */
    durableClassification?: TaskClassificationRecord | null
    /** Force DATA_INTEGRITY (e.g. conflicting primary ownership). */
    forceDataIntegrity?: boolean
  } = {},
): ControlCenterTaskInput {
  const classification =
    opts.durableClassification != null
      ? resolveTaskClassification(
          task,
          pin,
          new Map([[task.id, opts.durableClassification]]),
        )
      : mapTaskClassification(task, pin)
  const run = opts.run
  const hardBlocker = Boolean(
    task.blockedReason ||
      (Array.isArray(task.blockers) && task.blockers.length > 0) ||
      task.status === 'blocked',
  )
  const productStageMode =
    typeof task.productStageMode === 'string' && PRODUCT_STAGE_MODES.has(task.productStageMode)
      ? (task.productStageMode as 'STAGE_1' | 'STAGE_2')
      : 'STAGE_2'

  // Durable ownership is sole authority when provided — never legacy embedded claimState.
  let claimState: ValidClaimState | ClaimState | undefined
  let runLiveness: RunLiveness | undefined
  if (opts.durableOwnership) {
    claimState =
      opts.durableOwnership.claimState === 'NONE'
        ? undefined
        : (opts.durableOwnership.claimState as ValidClaimState)
    runLiveness = opts.durableOwnership.runLiveness
  } else {
    // Fixture / unit path only — production load always supplies durableOwnership when runs exist.
    claimState = parseValidClaimState(task.claimState)
    runLiveness =
      run?.status === 'running'
        ? 'RUNNING'
        : run?.status === 'blocked'
          ? 'STALLED'
          : run?.status === 'failed'
            ? 'EXPIRED'
            : run?.status === 'queued'
              ? 'STARTING'
              : run?.status === 'done'
                ? 'NONE'
                : undefined
  }

  // Task decision flags may only SUPPLEMENT open Decision source (opts), never clear it.
  const hasBlockingDecision =
    Boolean(opts.hasBlockingDecision) || task.hasBlockingDecision === true
  const hasNonBlockingDecision =
    Boolean(opts.hasNonBlockingDecision) || task.hasNonBlockingDecision === true
  // targetGate / evidence only from explicit source truth — never invent from heartbeat.
  const durableGate =
    opts.durableOwnership?.primaryRun?.targetGate &&
    opts.durableOwnership.primaryRun.targetGate.trim()
      ? opts.durableOwnership.primaryRun.targetGate.trim()
      : null
  const targetGate =
    durableGate ??
    (typeof task.targetGate === 'string' && task.targetGate.trim()
      ? task.targetGate.trim()
      : null) ??
    task.lifecycleStage ??
    null

  const durableRun = opts.durableOwnership?.primaryRun
  const agentId = durableRun?.agentId ?? run?.agent ?? null
  const role = durableRun?.role ?? run?.role ?? null
  const model = durableRun?.model ?? run?.model ?? null
  const effort = durableRun?.effort ?? run?.effort ?? null
  const accountRef = durableRun?.maskedAccountRef ?? run?.account ?? null
  const startedAt =
    durableRun?.registeredAtMs != null
      ? new Date(durableRun.registeredAtMs).toISOString()
      : (run?.started ?? null)
  const heartbeatAt =
    durableRun?.heartbeatAtMs != null
      ? new Date(durableRun.heartbeatAtMs).toISOString()
      : ((run as RunSourceExt | null | undefined)?.heartbeatAt ?? run?.updated ?? null)
  const materialProgressAt =
    durableRun?.materialProgressAtMs != null
      ? new Date(durableRun.materialProgressAtMs).toISOString()
      : ((run as RunSourceExt | null | undefined)?.materialProgressAt ?? null)

  return {
    taskId: task.id,
    title: task.title,
    projectId: task.projectId ?? null,
    featureId: task.featureContractId ?? null,
    classification,
    lifecycleStage: task.lifecycleStage ?? null,
    // No fabricated stage evidence — only when explicitly present as V3 binding (not here).
    evidence: null,
    claimState,
    runLiveness,
    hasBlockingDecision,
    hasNonBlockingDecision,
    hardBlocker,
    // NEXT solely from active root dispatch plan (opts) — ignore any task-level selection.
    selectedForNextDispatch: opts.selectedForNextDispatch ?? false,
    // Without classification proof, eligibility must not invent QUEUED capacity.
    eligible: classification.taskClass === 'PRODUCT' && classification.disposition === 'ACTIVE',
    staleDataSource: task.staleDataSource === true,
    staleDispatchPlan: task.staleDispatchPlan === true,
    staleAccountSync: task.staleAccountSync === true,
    productStageMode,
    p0Blocker: opts.forceDataIntegrity === true || task.p0Blocker === true,
    targetGate,
    agentId,
    role,
    model,
    effort,
    accountRef,
    startedAt,
    // Distinct fields only — never set materialProgressAt = heartbeat for shape.
    heartbeatAt,
    materialProgressAt,
    evidenceLink: task.evidence_path ?? run?.evidencePath ?? null,
    createdAt: task.updated ? new Date(task.updated).toISOString() : pin.generatedAt,
    // Priority membership only when receipt proves portfolio — never from title/phase.
    priorityMembership: Boolean(
      classification.receipt?.membershipPortfolioId === 'SALES_WEB_RELATED_BACKEND' &&
        classification.receipt?.membershipProofHash,
    ),
  }
}

/**
 * Map legacy collab decision → DecisionV3.
 * When V3-shaped fields are present, map them conservatively; never invent PASS/authority.
 * Never maps body / privateNote / comment / credentials into the public projection.
 */
export function mapLegacyDecisionToV3(
  boardId: string,
  d: Decision | {
    id: string
    teks: string
    featureId?: string | null
    status?: string
    keputusan?: string
    tanggal_putus?: string
    openedBy?: string
    [key: string]: unknown
  },
  boardRev: number,
): DecisionV3Record {
  const raw = d as Decision & Record<string, unknown>
  const statusRaw = String(raw.status ?? '').trim()
  const statusUpper = statusRaw.toUpperCase()
  const legacyOpen =
    !statusRaw || statusRaw === 'open' || statusUpper === 'OPEN' || statusRaw === 'blocked'
  let status: DecisionV3Status
  if (DECISION_V3_STATUSES.has(statusUpper)) {
    status = statusUpper as DecisionV3Status
  } else if (statusRaw === 'rejected' || statusUpper === 'REJECTED') {
    status = 'REJECTED'
  } else if (legacyOpen) {
    status = 'OPEN'
  } else {
    status = 'RESOLVED'
  }
  const openish = status === 'OPEN' || status === 'ACKNOWLEDGED'

  // Title/question from V3 fields when present, else collab teks — never private body.
  const text = String(raw.teks ?? raw.id)
  const titleSrc =
    typeof raw.title === 'string' && raw.title.trim() ? raw.title.trim() : text
  const questionSrc =
    typeof raw.question === 'string' && raw.question.trim() ? raw.question.trim() : text

  const severityRaw = typeof raw.severity === 'string' ? raw.severity.trim().toUpperCase() : ''
  const severity: DecisionSeverity = DECISION_SEVERITIES.has(severityRaw)
    ? (severityRaw as DecisionSeverity)
    : openish
      ? 'HIGH'
      : 'LOW'

  const blocking =
    typeof raw.blocking === 'boolean' ? raw.blocking : openish && status === 'OPEN'

  const createdSrc =
    (typeof raw.createdAt === 'string' && raw.createdAt) ||
    (typeof raw.created === 'string' && raw.created) ||
    (typeof raw.tanggal_putus === 'string' && raw.tanggal_putus) ||
    null
  const created =
    coerceIsoMs(createdSrc).iso ??
    (raw.tanggal_putus
      ? new Date(String(raw.tanggal_putus)).toISOString()
      : new Date(0).toISOString())
  const createdAtMs = Date.parse(created) || 0

  const due = coerceIsoMs(raw.dueAt ?? raw.due)
  const snooze = coerceIsoMs(raw.snoozedUntil)
  const exp = coerceIsoMs(raw.expiresAt)

  const decisionId =
    typeof raw.decisionId === 'string' && raw.decisionId.trim()
      ? raw.decisionId.trim()
      : String(raw.id)

  const type =
    typeof raw.type === 'string' && raw.type.trim() ? raw.type.trim().slice(0, 64) : 'owner'

  const recommendation =
    (typeof raw.agentRecommendation === 'string' && raw.agentRecommendation.trim()
      ? raw.agentRecommendation.trim().slice(0, 800)
      : null) ??
    (typeof raw.recommendation === 'string' && raw.recommendation.trim()
      ? raw.recommendation.trim().slice(0, 800)
      : null)

  const ownerId =
    (typeof raw.ownerId === 'string' && raw.ownerId.trim() ? raw.ownerId.trim() : null) ??
    (typeof raw.openedBy === 'string' && raw.openedBy.trim() ? raw.openedBy.trim() : null)

  const resolverId =
    typeof raw.resolverId === 'string' && raw.resolverId.trim()
      ? raw.resolverId.trim()
      : null

  const selectedOptionId =
    typeof raw.selectedOptionId === 'string' && raw.selectedOptionId.trim()
      ? raw.selectedOptionId.trim()
      : null

  const projectId =
    typeof raw.projectId === 'string' && raw.projectId.trim() ? raw.projectId.trim() : null
  const featureId =
    typeof raw.featureId === 'string' && raw.featureId.trim() ? raw.featureId.trim() : null
  const taskId =
    typeof raw.taskId === 'string' && raw.taskId.trim() ? raw.taskId.trim() : null
  const runId =
    typeof raw.runId === 'string' && raw.runId.trim() ? raw.runId.trim() : null

  const auditIds = Array.isArray(raw.auditIds)
    ? raw.auditIds
        .filter((x): x is string => typeof x === 'string' && x.trim().length > 0)
        .map((x) => x.slice(0, 120))
        .slice(0, 32)
    : []

  const scopedApprovalId =
    typeof raw.scopedApprovalId === 'string' && raw.scopedApprovalId.trim()
      ? raw.scopedApprovalId.trim().slice(0, 120)
      : null

  // Explicitly ignore private carriers — never copy into public projection.
  void raw.body
  void raw.privateNote
  void raw.comment

  return {
    decisionId,
    boardId,
    projectId,
    featureId,
    taskId,
    runId,
    type,
    severity,
    title: titleSrc.slice(0, 200),
    question: questionSrc.slice(0, 2000),
    evidence: mapEvidenceStringRefs(raw.evidence),
    options: mapDecisionOptions(raw as Decision),
    agentRecommendation: recommendation,
    blocking,
    dueAt: due.iso,
    dueAtMs: due.ms,
    createdAt: created,
    createdAtMs,
    snoozedUntil: snooze.iso,
    snoozedUntilMs: snooze.ms,
    status,
    ownerId,
    resolverId,
    selectedOptionId,
    // Never ship private decision comments / raw credentials.
    comment: null,
    expectedRev: coerceNonNegInt(raw.expectedRev, boardRev),
    boardRev: coerceNonNegInt(raw.boardRev, boardRev),
    entityRev: coerceNonNegInt(raw.entityRev, 0),
    scopedApprovalId,
    auditIds,
    expiresAt: exp.iso,
    expiresAtMs: exp.ms,
  }
}

export interface ControlCenterSourceBundle {
  boardId: string
  raw: RawBoard
  tasks: WorkTask[]
  opsAccounts: Array<{
    id?: string
    label?: string
    status?: string
    usable?: boolean
    inUse?: number
    cap?: number
  }>
  /**
   * Legacy board.runs projection only — NEVER used for active ownership when
   * `durableRuns` is provided (load path always prefers durable).
   */
  runs: Run[]
  boardContentHash: string
  boardRev: number
  lifecycleRev: number
  /**
   * Authoritative pin identity from complete board_revisions row
   * (subject_hash + canonical_snapshot_id). When complete, these win over
   * live boardContentHash — never rewrite classification receipts.
   */
  authorityCanonicalHash?: string | null
  authorityCanonicalSnapshotId?: string | null
  /** True only when revs + subject_hash + snapshot id all validated. */
  pinAuthorityComplete?: boolean
  now?: string
  /** Optional injectable G5 domain rows (persisted). Empty = honest incomplete G5. */
  g5Domains?: ReadonlyArray<G5DomainRecord>
  dispatchNext?: DispatchNextUi | null
  sectionErrors?: Array<{ section: string; code: string; message: string }>
  /**
   * C2 account-sync authoritative snapshot (or pre-projected read model).
   * When absent, Ops fails closed (stale + usableCapacity=0); never uses boardRev
   * or optimistic legacy ops capacity as account sourceRevision/capacity.
   */
  accountSyncSnapshot?: AccountSyncSnapshot | AccountSyncCcReadModel | null
  /**
   * Durable V3 run-registry rows (control_plane_runs). When present, sole
   * source of active ownership / claimState / run liveness.
   */
  durableRuns?: ReadonlyArray<RunRecord> | null
  /** Durable DecisionV3 store rows — preferred over legacy board.decisions. */
  durableDecisions?: ReadonlyArray<DecisionV3Record> | null
  /** Durable classification store by taskId. */
  durableClassifications?: ReadonlyArray<TaskClassificationRecord> | null
  /**
   * When true, classification store was loaded (even if empty) — missing rows
   * are fail-closed UNCLASSIFIED (no legacy embedded promotion).
   */
  durableClassificationsLoaded?: boolean
  /** Active root dispatch plan (for priority packets + NEXT already in dispatchNext). */
  activePlan?: DispatchPlanRecord | null
  /** Pre-built priority packets; when omitted, derived from activePlan + durableRuns. */
  priorityPackets?: ReadonlyArray<PriorityPacket> | null
  /** Material audit events (atomic listAudit + import audit). */
  materialAuditEvents?: ReadonlyArray<AuditUiEvent> | null
  /** When true, ownership was loaded from durable registry (even if empty). */
  durableOwnershipLoaded?: boolean
  /**
   * Durable humanDisplay rows for this board (from HumanDisplayStore.list).
   * Absent/empty → owner surfaces fail-closed CONTENT_REVIEW_REQUIRED.
   * Never invents PRODUCT or promotes raw technical titles.
   */
  humanDisplayRecords?: ReadonlyArray<HumanDisplayRecord> | null
  /** True when store list was attempted (even if empty). */
  humanDisplayLoaded?: boolean
}

const FLOW_BRANCHES = new Set(['success', 'fail', 'expired', 'open'])

function uniqNonEmpty(values: Array<string | null | undefined>): string[] | null {
  const out: string[] = []
  const seen = new Set<string>()
  for (const v of values) {
    if (typeof v !== 'string') continue
    const s = v.trim()
    if (!s || seen.has(s)) continue
    seen.add(s)
    out.push(s)
  }
  return out.length > 0 ? out : null
}

/**
 * Derive flow branch only from explicit source truth.
 * Never invents success from not-blocked; null when unknown.
 */
export function deriveFeatureFlowBranch(
  feature: {
    isBlocked?: boolean
    blocked?: string | null
    branch?: string | null
    fase?: string | null
    bucket?: string | null
  },
  featureTasks: ReadonlyArray<WorkTask>,
): FeatureUiSummary['flowBranch'] {
  if (feature.isBlocked || (feature.blocked && String(feature.blocked).trim())) {
    return 'fail'
  }
  const explicit = String(feature.branch ?? feature.bucket ?? '').toLowerCase()
  if (FLOW_BRANCHES.has(explicit)) {
    return explicit as NonNullable<FeatureUiSummary['flowBranch']>
  }
  // Task/run terminal outcomes when present (distinct ids).
  let anyExpired = false
  let anySuccess = false
  let anyFail = false
  for (const t of featureTasks) {
    const st = String(t.status ?? '').toLowerCase()
    if (st === 'expired' || st === 'failed' || st === 'fail') anyFail = true
    if (st === 'expired') anyExpired = true
    if (
      st === 'done' &&
      (t.lifecycleStage === 'PROD_READY' || t.lifecycleStage === 'LIVE_VERIFIED')
    ) {
      anySuccess = true
    }
  }
  if (anyExpired) return 'expired'
  if (anyFail) return 'fail'
  if (anySuccess && featureTasks.length > 0) {
    const allTerminalSuccess = featureTasks.every((t) => {
      const st = String(t.status ?? '').toLowerCase()
      return (
        st === 'done' &&
        (t.lifecycleStage === 'PROD_READY' || t.lifecycleStage === 'LIVE_VERIFIED')
      )
    })
    if (allTerminalSuccess) return 'success'
  }
  // Not blocked alone ≠ open/success — leave null when no explicit truth.
  return null
}

function mapMaskedAccountRecordToUi(a: MaskedAccountRecord): AccountUiSummary {
  return {
    maskedAccountId: a.maskedAccountId.startsWith('acc_')
      ? a.maskedAccountId
      : maskAccountForUi(a.maskedAccountId) ?? `acc_${a.maskedAccountId.slice(-4)}`,
    status: a.status,
    providerKind: a.providerKind,
    effectiveInUse: a.effectiveInUse,
    effectiveCap: a.effectiveCap,
    physicalSlotsDisplay: a.physicalSlotsDisplay,
    quarantine:
      a.tombstone ||
      a.status === 'quarantine' ||
      a.status === 'REMOVED' ||
      a.status === 'BAN' ||
      a.status === '403' ||
      a.status === 'AUTH_EXPIRED',
    reason: a.reason,
  }
}

function resolveAccountSyncReadModel(
  src: ControlCenterSourceBundle,
): AccountSyncCcReadModel | null {
  if (!src.accountSyncSnapshot) return null
  const snap = src.accountSyncSnapshot
  if ('readbackParityOk' in snap && typeof (snap as AccountSyncCcReadModel).readbackParityOk === 'boolean') {
    // Already projected read model
    return snap as AccountSyncCcReadModel
  }
  return projectAccountSyncCcReadModel(snap as AccountSyncSnapshot)
}

/**
 * Build pin + aggregation input from already-loaded sources (injectable / testable).
 * Does not recompute readiness formulas beyond C1/C2 aggregateControlCenter.
 * When durableRuns/durableClassifications present, those are sole ownership/class authority.
 */
export function buildControlCenterAggregationFromSources(
  src: ControlCenterSourceBundle,
): ControlCenterAggregation {
  const generatedAt = src.now ?? new Date().toISOString()
  const nowMs = Date.parse(generatedAt)
  const nowMsSafe = Number.isFinite(nowMs) ? nowMs : Date.now()
  const taskHash = sha256Hex(
    src.tasks
      .map((t) => t.id)
      .sort()
      .join('|') || 'empty-tasks',
  )
  // Authoritative pin: complete board_revisions subject_hash + snapshot wins over live boardHash.
  // Do not synthesize/rewrite classification receipts to match either pin.
  const pinAuthorityComplete = Boolean(
    src.pinAuthorityComplete &&
      typeof src.authorityCanonicalHash === 'string' &&
      src.authorityCanonicalHash &&
      typeof src.authorityCanonicalSnapshotId === 'string' &&
      src.authorityCanonicalSnapshotId,
  )
  const canonicalHash = pinAuthorityComplete
    ? (src.authorityCanonicalHash as string)
    : src.boardContentHash
  const canonicalSnapshotId = pinAuthorityComplete
    ? (src.authorityCanonicalSnapshotId as string)
    : `cc-${src.boardId}-${src.boardContentHash.slice(0, 16)}`
  const pin: ControlCenterPin = {
    boardId: src.boardId,
    canonicalSnapshotId,
    canonicalHash,
    taskHash,
    boardRev: src.boardRev,
    lifecycleRev: src.lifecycleRev,
    generatedAt,
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
  }

  const model = buildModel(src.raw)
  const nextIds = new Set(
    (src.dispatchNext?.selectedForNextDispatch ?? []).map((x) => x.taskId),
  )

  // Prefer durable DecisionV3 store; else project legacy collab decisions.
  const decisions: DecisionV3Record[] =
    src.durableDecisions && src.durableDecisions.length > 0
      ? [...src.durableDecisions].sort((a, b) => {
          // Blocking open first, then severity, then createdAtMs desc (stable).
          const aOpen = a.status === 'OPEN' || a.status === 'ACKNOWLEDGED' ? 1 : 0
          const bOpen = b.status === 'OPEN' || b.status === 'ACKNOWLEDGED' ? 1 : 0
          if (a.blocking !== b.blocking) return a.blocking ? -1 : 1
          if (aOpen !== bOpen) return bOpen - aOpen
          if (a.createdAtMs !== b.createdAtMs) return b.createdAtMs - a.createdAtMs
          return a.decisionId < b.decisionId ? -1 : a.decisionId > b.decisionId ? 1 : 0
        })
      : model.decisions.map((d) => mapLegacyDecisionToV3(src.boardId, d, src.boardRev))

  const blockingDecisionTaskIds = new Set<string>()
  const nonBlockingDecisionTaskIds = new Set<string>()
  const openBlockingFeatureIds = new Set<string>()
  for (const d of decisions) {
    // Only non-terminal open-ish statuses contribute; resolved/rejected never force blocking.
    if (d.status !== 'OPEN' && d.status !== 'ACKNOWLEDGED') continue
    if (d.blocking) {
      if (d.taskId) blockingDecisionTaskIds.add(d.taskId)
      if (d.featureId) openBlockingFeatureIds.add(d.featureId)
    } else {
      if (d.taskId) nonBlockingDecisionTaskIds.add(d.taskId)
    }
  }
  // Legacy open decisions (status === 'open') without V3 blocking flag still mark features.
  if (!(src.durableDecisions && src.durableDecisions.length > 0)) {
    for (const d of model.openDecisions) {
      if (d.featureId) openBlockingFeatureIds.add(d.featureId)
    }
  }

  // Durable classification map (fail-closed UNCLASSIFIED when missing).
  const durableClassByTask = new Map<string, TaskClassificationRecord>()
  if (src.durableClassifications) {
    for (const c of src.durableClassifications) {
      if (c.taskId) durableClassByTask.set(c.taskId, c)
    }
  }
  const useDurableClassification =
    src.durableClassificationsLoaded === true ||
    (src.durableClassifications != null && Array.isArray(src.durableClassifications))

  // Durable ownership — sole claim authority when durableRuns provided (incl. empty list).
  const useDurableOwnership =
    src.durableOwnershipLoaded === true ||
    (src.durableRuns != null && Array.isArray(src.durableRuns))
  const taskHints: OwnershipTaskHint[] = src.tasks.map((t) => ({
    taskId: t.id,
    lifecycleStage: t.lifecycleStage ?? null,
    productStageMode:
      typeof t.productStageMode === 'string' && PRODUCT_STAGE_MODES.has(t.productStageMode)
        ? (t.productStageMode as 'STAGE_1' | 'STAGE_2')
        : 'STAGE_2',
  }))
  const ownership = useDurableOwnership
    ? deriveDurableOwnership(src.durableRuns ?? [], nowMsSafe, taskHints)
    : null

  // Legacy board.runs only as fallback projection when no durable runs.
  const runByTask = new Map<string, Run>()
  if (!useDurableOwnership) {
    for (const r of src.runs) {
      const tid = r.taskId || r.task
      if (tid && !runByTask.has(String(tid))) runByTask.set(String(tid), r)
    }
  } else {
    for (const rec of src.durableRuns ?? []) {
      if (rec.taskId && !runByTask.has(rec.taskId)) {
        runByTask.set(rec.taskId, mapRunRecordToBoardRun(rec))
      }
    }
  }

  const tasks: ControlCenterTaskInput[] = src.tasks.map((t) => {
    const hasBlocking =
      Boolean(t.featureContractId && openBlockingFeatureIds.has(t.featureContractId)) ||
      blockingDecisionTaskIds.has(t.id)
    // Non-blocking: explicit open Decision on task only (does not demote ONGOING).
    const hasNonBlocking = nonBlockingDecisionTaskIds.has(t.id)
    const own = ownership?.byTaskId.get(t.id) ?? null
    const forceDi = own?.conflicting === true
    // When classification store loaded: missing row → explicit UNCLASSIFIED (not embedded).
    const durableCls = useDurableClassification
      ? (durableClassByTask.get(t.id) ?? {
          taskId: t.id,
          taskClass: 'UNCLASSIFIED' as const,
          disposition: 'UNCLASSIFIED' as const,
          receipt: null,
        })
      : null
    return mapWorkTaskToControlCenterInput(t, pin, {
      // NEXT solely from active root dispatch plan — never task.selectedForNextDispatch.
      selectedForNextDispatch: nextIds.has(t.id),
      hasBlockingDecision: hasBlocking,
      hasNonBlockingDecision: hasNonBlocking,
      run: runByTask.get(t.id) ?? null,
      durableOwnership: useDurableOwnership ? own : null,
      durableClassification: durableCls,
      forceDataIntegrity: forceDi,
    })
  })

  // Tasks that only exist as durable runs with conflict but no WorkTask row are ignored
  // (rollup is task-keyed). Conflicting ownership on mapped tasks already force p0Blocker.

  const projects: ProjectUiSummary[] = model.projects.map((p) => {
    const projTasks = src.tasks.filter((t) => t.projectId === p.id)
    return {
      id: p.id,
      name: p.nama,
      status: p.status,
      taskCount: projTasks.length,
      // Seed 0; aggregateControlCenter enriches from rollup DONE distinct IDs.
      doneCount: 0,
      blockedCount: projTasks.filter((t) => t.status === 'blocked' || t.blockedReason).length,
      readinessPercent: null,
      readinessStage: null,
      readinessEvidenceOk: null,
    }
  })

  const features: FeatureUiSummary[] = model.features.map((f) => {
    const featureTasks = src.tasks.filter((t) => t.featureContractId === f.id)
    const pageRoutes = uniqNonEmpty([
      ...featureTasks.flatMap((t) => t.page_routes ?? []),
      ...featureTasks.flatMap((t) => t.refs?.pages ?? []),
    ])
    const apiEndpoints = uniqNonEmpty([
      ...featureTasks.flatMap((t) => t.api_endpoints ?? []),
      ...featureTasks.flatMap((t) => t.refs?.api ?? []),
    ])
    const logicRules = uniqNonEmpty(featureTasks.flatMap((t) => t.logic_rules ?? []))
    const dataContext = uniqNonEmpty(featureTasks.flatMap((t) => t.sales_table_fields ?? []))
    const geoVariants = uniqNonEmpty(
      featureTasks.flatMap((t) =>
        (t.geo_variants ?? []).map((v) => v.when ?? v.id ?? v.expect ?? '').filter(Boolean),
      ),
    )
    const providerVariants = uniqNonEmpty(
      featureTasks.flatMap((t) =>
        (t.provider_variants ?? []).map((v) => v.when ?? v.id ?? v.expect ?? '').filter(Boolean),
      ),
    )
    const sideEffectsReadback = uniqNonEmpty(
      featureTasks.flatMap((t) => t.side_effects_readback ?? []),
    )
    // style context: no first-class WorkTask field — leave null (never invent).
    return {
      id: f.id,
      projectId: f.projectId,
      name: f.nama,
      phase: String(f.fase ?? ''),
      flowBranch: deriveFeatureFlowBranch(f, featureTasks),
      taskCount: featureTasks.length,
      pageRoutes,
      apiEndpoints,
      logicRules,
      styleContext: null,
      dataContext,
      geoVariants,
      providerVariants,
      sideEffectsReadback,
    }
  })

  // Prefer durable run registry for Agents/Runs surface; legacy board.runs only as fixture fallback.
  const runs: RunUiSummary[] = useDurableOwnership
    ? (src.durableRuns ?? []).map((rec) => {
        const own = ownership?.byTaskId.get(rec.taskId)
        const startedAt =
          rec.registeredAtMs != null ? new Date(rec.registeredAtMs).toISOString() : null
        const heartbeatAt =
          rec.heartbeatAtMs != null ? new Date(rec.heartbeatAtMs).toISOString() : null
        const materialProgressAt =
          rec.materialProgressAtMs != null
            ? new Date(rec.materialProgressAtMs).toISOString()
            : null
        let productiveSubstate: ProductiveSubstate | null = null
        if (rec.state === 'RUNNING' || rec.state === 'STARTING' || rec.state === 'RESERVED') {
          productiveSubstate = rec.stalled ? 'STALLED' : 'PRODUCTIVE'
        } else if (rec.state === 'WAITING_HUMAN' || rec.state === 'STALE') {
          productiveSubstate = 'STALLED'
        }
        const claimForRun =
          own?.primaryRun?.runId === rec.runId
            ? own.claimState === 'NONE'
              ? null
              : own.claimState
            : null
        return {
          runId: rec.runId,
          taskId: rec.taskId,
          agentId: rec.agentId,
          role: rec.role,
          model: rec.model,
          effort: rec.effort,
          maskedAccount: maskAccountForUi(rec.maskedAccountRef),
          status: rec.state,
          startedAt,
          heartbeatAt,
          materialProgressAt,
          productiveSubstate,
          createdAt: startedAt ?? generatedAt,
          id: rec.runId,
          evidenceLink: null,
          claimState: claimForRun,
          lockIds: rec.collisionScopeLockIds ?? null,
          controllerRunId: rec.controllerRunId,
          parentRunId: rec.parentRunId,
        }
      })
    : src.runs.map((r) => {
        const ext = r as RunSourceExt
        const heartbeatAt = ext.heartbeatAt ?? r.updated ?? null
        // Never mirror heartbeat into materialProgressAt merely for shape.
        const materialProgressAt = ext.materialProgressAt ?? null
        let productiveSubstate: ProductiveSubstate | null = null
        if (r.status === 'running') productiveSubstate = 'PRODUCTIVE'
        else if (r.status === 'blocked') productiveSubstate = 'STALLED'
        return {
          runId: r.id,
          taskId: r.taskId ?? r.task ?? null,
          agentId: r.agent ?? null,
          role: r.role ?? null,
          model: r.model ?? null,
          effort: r.effort ?? null,
          maskedAccount: maskAccountForUi(r.account ?? null),
          status: r.status ?? null,
          startedAt: r.started ?? null,
          heartbeatAt,
          materialProgressAt,
          productiveSubstate,
          createdAt: r.started ?? r.updated ?? generatedAt,
          id: r.id,
          evidenceLink: r.evidencePath ?? null,
          claimState: ext.claimState ?? null,
          lockIds: ext.collisionScopeLockIds ?? null,
          controllerRunId: ext.controllerRunId ?? null,
          parentRunId: ext.parentRunId ?? null,
        }
      })

  // Prefer C2 account-sync snapshot; never treat legacy ops as capacity authority.
  const accountRead = resolveAccountSyncReadModel(src)
  let accounts: AccountUiSummary[]
  let accountSyncMeta: AccountSyncUiMeta
  if (accountRead) {
    accounts = accountRead.accounts.map(mapMaskedAccountRecordToUi)
    accountSyncMeta = {
      authoritative: true,
      sourceRevision: accountRead.sourceRevision,
      generatedAt: accountRead.generatedAt,
      stale: accountRead.stale,
      staleReason: accountRead.staleReason,
      usableCapacity: accountRead.usableCapacity,
      readbackParityOk: accountRead.readbackParityOk,
    }
  } else {
    // Fail-closed: no authoritative snapshot → empty accounts, stale, capacity 0.
    // Do not project legacy opsAccounts into capacity (optimistic fallback banned).
    accounts = []
    accountSyncMeta = {
      authoritative: false,
      sourceRevision: null,
      generatedAt: null,
      stale: true,
      staleReason: 'ACCOUNT_SYNC_MISSING',
      usableCapacity: 0,
      readbackParityOk: null,
    }
    if ((src.opsAccounts?.length ?? 0) > 0) {
      // Honest residual: legacy ops rows present but not used as account authority.
      // (sectionErrors appended below)
    }
  }

  // Propagate account-sync stale onto tasks for rollup STALE_ACCOUNT_SYNC overlay.
  if (accountSyncMeta.stale || !accountSyncMeta.authoritative) {
    for (const t of tasks) {
      t.staleAccountSync = true
    }
  }

  // Material events: prefer durable atomic/import audit; else collab activity feed.
  let auditEvents: AuditUiEvent[]
  if (src.materialAuditEvents && src.materialAuditEvents.length > 0) {
    auditEvents = [...src.materialAuditEvents]
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 200)
  } else {
    auditEvents = (model.activity ?? []).slice(0, 200).map((ev, i) => ({
      id: `act-${i}-${String(ev.ts ?? i)}`,
      createdAt: ev.ts ? new Date(ev.ts).toISOString() : generatedAt,
      kind: ev.kind || 'activity',
      actorId: ev.actor ?? null,
      subjectId: ev.featureId ?? null,
      summary: String(ev.text ?? '').slice(0, 500),
      materialHash: null,
      boardRev: src.boardRev,
    }))
  }

  const sectionErrors = [...(src.sectionErrors ?? [])]
  if (ownership && ownership.conflictTaskIds.length > 0) {
    sectionErrors.push({
      section: 'ownership',
      code: 'DATA_INTEGRITY',
      message: `Conflicting primary ownership for task(s): ${ownership.conflictTaskIds.join(', ')} → BLOCKED:DATA_INTEGRITY`,
    })
  }
  // Honest pin-authority fallback documentation (do not rebind receipts to live boardHash).
  if (!pinAuthorityComplete) {
    const already = sectionErrors.some(
      (e) =>
        e.code === 'PIN_AUTHORITY_FALLBACK' ||
        e.code === 'REVISION_AUTHORITY_MISSING' ||
        e.code === 'PIN_AUTHORITY_INCOMPLETE',
    )
    if (!already) {
      sectionErrors.push({
        section: 'revisions',
        code: 'PIN_AUTHORITY_FALLBACK',
        message:
          'board_revisions pin incomplete or absent; pin.canonicalHash uses live boardContentHash fallback; classification receipts are not rebound to synthesized authority',
      })
    }
  }
  // Honest signal: live board has no V3 classification receipts → data integrity section note.
  const hasAnyClassified = tasks.some(
    (t) =>
      t.classification.taskClass !== 'UNCLASSIFIED' &&
      t.classification.disposition !== 'UNCLASSIFIED' &&
      t.classification.receipt,
  )
  if (tasks.length > 0 && !hasAnyClassified) {
    sectionErrors.push({
      section: 'classification',
      code: 'DATA_INTEGRITY',
      message:
        'No valid V3 classification receipts on board tasks; fail-closed UNCLASSIFIED → BLOCKED:DATA_INTEGRITY',
    })
  }
  if (!accountRead) {
    sectionErrors.push({
      section: 'accounts',
      code: 'ACCOUNT_SYNC_MISSING',
      message:
        'No authoritative C2 AccountSyncSnapshot; Ops fail-closed (stale=true, usableCapacity=0); legacy ops not used as capacity authority',
    })
  } else if (accountRead.stale) {
    sectionErrors.push({
      section: 'accounts',
      code: 'ACCOUNT_SYNC_STALE',
      message: accountRead.staleReason
        ? `Account sync stale: ${accountRead.staleReason}`
        : 'Account sync stale',
    })
  }

  // Priority membership set from receipt-proven tasks (before packets).
  const membershipTaskIds = new Set(
    tasks.filter((t) => t.priorityMembership).map((t) => t.taskId),
  )
  const priorityPackets: PriorityPacket[] =
    src.priorityPackets != null
      ? [...src.priorityPackets]
      : buildPriorityPacketsFromDurable({
          plan: src.activePlan ?? null,
          runs: src.durableRuns ?? [],
          membershipTaskIds,
          pinCanonicalHash: canonicalHash,
          nowMs: nowMsSafe,
        })

  if (src.humanDisplayLoaded === false) {
    sectionErrors.push({
      section: 'human_display',
      code: 'PARTIAL_SOURCE',
      message:
        'HumanDisplayStore list failed or unavailable; owner primary surfaces fail-closed CONTENT_REVIEW_REQUIRED',
    })
  }

  const input: ControlCenterAggregationInput = {
    pin,
    tasks,
    g5Domains: src.g5Domains ?? [],
    priorityPackets,
    projects,
    features,
    runs,
    accounts,
    decisions,
    auditEvents,
    dispatchNext: src.dispatchNext ?? null,
    accountSyncMeta,
    now: generatedAt,
    sectionErrors,
    // Distinct non-conflicting ownership only (conflicts already p0Blocker).
    primaryOwnership: ownership?.primaryOwnership ?? [],
    frontierStateWhenEmpty: 'PRIORITY_FRONTIER_EMPTY',
  }

  const agg = aggregateControlCenter(input)
  const humanDisplayByEntityKey = buildHumanDisplayProjectionMap(
    pin,
    src.humanDisplayRecords,
  )
  return attachOwnerHumanDisplayToWorkSurfaces({
    ...agg,
    humanDisplayByEntityKey,
  })
}

/**
 * Build entity-key → owner HD projection map from durable HumanDisplay records.
 * Uses stored sourceHash as liveSourceHash when full source recompute is not available
 * (pin revs/snapshot still applied). Missing records are NOT invented here — callers
 * fail-closed via resolveTaskOwnerHumanDisplay.
 */
export function buildHumanDisplayProjectionMap(
  pin: ControlCenterPin,
  records: ReadonlyArray<HumanDisplayRecord> | null | undefined,
): Map<string, OwnerHumanDisplayUiProjection> {
  const map = new Map<string, OwnerHumanDisplayUiProjection>()
  if (!records) return map
  for (const rec of records) {
    if (
      rec.entityKind !== 'task' &&
      rec.entityKind !== 'project' &&
      rec.entityKind !== 'feature'
    ) {
      continue
    }
    const entityId = String(rec.entityId ?? '').trim()
    if (!entityId) continue
    const proj = projectOwnerHumanDisplayUi(
      rec.content,
      livePinFromControlCenter(pin, rec.sourceHash),
      { entityKind: rec.entityKind, entityId },
    )
    map.set(humanDisplayEntityKey(rec.entityKind, entityId), proj)
  }
  return map
}

/**
 * Parsed board_revisions authority for control-center pin.
 * complete=true only when revs + subject_hash + canonical_snapshot_id all validate.
 * Partial/invalid authority is fail-closed (complete=false + reason) — never treated as verified.
 */
export type PersistedBoardRevisionAuthority = {
  boardRev: number
  lifecycleRev: number
  subjectHash: string | null
  canonicalSnapshotId: string | null
  complete: boolean
  incompleteReason: string | null
}

/**
 * Pure row parser (unit-testable). Invalid revs → null. Invalid/partial hash/snapshot →
 * complete=false with explicit incompleteReason (fail closed, not silent verified authority).
 */
export function parsePersistedBoardRevisionRow(
  row:
    | {
        board_rev?: unknown
        lifecycle_rev?: unknown
        subject_hash?: unknown
        canonical_snapshot_id?: unknown
      }
    | null
    | undefined,
): PersistedBoardRevisionAuthority | null {
  if (!row) return null
  const br = Number(row.board_rev)
  const lr = Number(row.lifecycle_rev)
  // Accept only finite non-negative integers; refuse NaN/float/negative fabrications.
  if (!Number.isFinite(br) || !Number.isInteger(br) || br < 0) return null
  if (!Number.isFinite(lr) || !Number.isInteger(lr) || lr < 0) return null

  const hashRaw =
    row.subject_hash == null ? '' : String(row.subject_hash).trim()
  const snapRaw =
    row.canonical_snapshot_id == null ? '' : String(row.canonical_snapshot_id).trim()

  let subjectHash: string | null = null
  let canonicalSnapshotId: string | null = null
  const reasons: string[] = []

  if (!hashRaw) {
    reasons.push('subject_hash_absent')
  } else if (!SAFE_CANONICAL_HASH_RE.test(hashRaw)) {
    reasons.push('subject_hash_invalid_shape')
  } else {
    subjectHash = hashRaw.toLowerCase()
  }

  if (!snapRaw) {
    reasons.push('canonical_snapshot_id_absent')
  } else if (!SAFE_SNAPSHOT_ID_RE.test(snapRaw)) {
    reasons.push('canonical_snapshot_id_invalid_shape')
  } else {
    canonicalSnapshotId = snapRaw
  }

  const complete = subjectHash !== null && canonicalSnapshotId !== null
  return {
    boardRev: br,
    lifecycleRev: lr,
    subjectHash,
    canonicalSnapshotId,
    complete,
    incompleteReason: complete ? null : reasons.join(',') || 'incomplete',
  }
}

/**
 * Read persisted board/lifecycle revision + pin identity from `board_revisions` when present.
 * Returns null when table/row missing or revs non-integral — never synthesizes positive revs.
 * Fail-soft: query errors → null (caller keeps honest 0).
 */
export async function readPersistedBoardRevisions(
  boardId: string,
): Promise<PersistedBoardRevisionAuthority | null> {
  try {
    const [rows] = await db().query(
      'SELECT board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id FROM board_revisions WHERE board_id=? LIMIT 1',
      [boardId],
    )
    const rev = (
      rows as Array<{
        board_rev: number | string
        lifecycle_rev: number | string
        subject_hash?: string | null
        canonical_snapshot_id?: string | null
      }>
    )[0]
    return parsePersistedBoardRevisionRow(rev)
  } catch {
    return null
  }
}

/**
 * Resolve runtime context without throwing hard on missing test config —
 * returns null + section error so partial board load can still fail closed.
 */
function tryGetRuntimeContext(): {
  ctx: ControlPlaneRuntimeContext | null
  error: string | null
} {
  try {
    return { ctx: getControlPlaneRuntimeContext(), error: null }
  } catch (e) {
    return {
      ctx: null,
      error: e instanceof Error ? e.message : 'runtime context unavailable',
    }
  }
}

/**
 * Build RawBoard from pinned canonical projection (projects + flows as features).
 * Uses track=projectId so buildModel associates features to projects.
 * Never fabricates lifecycle/readiness on features/tasks.
 */
export function rawBoardFromCanonicalProjection(
  projection: CanonicalDefinitionProjection,
): RawBoard {
  return {
    projects: projection.projects.map((p) => ({
      id: p.id,
      nama: (typeof p.name === 'string' && p.name) || p.id,
      status: typeof p.status === 'string' ? p.status : 'active',
      tracks: [p.id],
      stage: typeof p.stage === 'string' ? p.stage : undefined,
    })),
    features: projection.flows.map((f) => ({
      id: f.id,
      nama: (typeof f.name === 'string' && f.name) || f.id,
      projectId: f.projectId,
      track: f.projectId,
      fase: typeof f.fase === 'string' ? f.fase : 'backlog',
      checklist: [],
    })),
    decisions: [],
    log: [],
    queue: { now: [], next: [] },
    runs: [],
    docs: [],
  }
}

/**
 * WorkTask[] from DISTINCT canonical definition task IDs + lifecycle left-join by task id.
 * Never includes legacy-only tasks; never fabricates lifecycle stage;
 * never copies classification from lifecycle overlay (classification is left-joined
 * separately and missing → UNCLASSIFIED/DATA_INTEGRITY at aggregation).
 */
export function workTasksFromCanonicalProjection(
  projection: CanonicalDefinitionProjection,
  lifecycleByTaskId: Map<string, WorkTask> = new Map(),
): WorkTask[] {
  const fcByTask = new Map<string, string>()
  for (const j of projection.featureContractJoins) {
    if (!fcByTask.has(j.taskId)) fcByTask.set(j.taskId, j.featureContractId)
  }
  const depsByFrom = new Map<string, string[]>()
  for (const d of projection.dependencies) {
    const arr = depsByFrom.get(d.fromTaskId) ?? []
    arr.push(d.toTaskId)
    depsByFrom.set(d.fromTaskId, arr)
  }
  // Prefer distinctTaskIds (definition membership) over raw task array length.
  const distinctIds =
    projection.distinctTaskIds.length > 0
      ? projection.distinctTaskIds
      : [...new Set(projection.tasks.map((t) => t.id))]
  const byId = new Map(projection.tasks.map((t) => [t.id, t] as const))
  const out: WorkTask[] = []
  const seen = new Set<string>()
  for (const id of distinctIds) {
    if (!id || seen.has(id)) continue
    seen.add(id)
    const ct = byId.get(id)
    const overlay = lifecycleByTaskId.get(id)
    // Definition-only id without task row still counts as membership (title from id).
    const featureContractId =
      (ct && typeof ct.featureContractId === 'string' && ct.featureContractId) ||
      fcByTask.get(id) ||
      overlay?.featureContractId ||
      null
    const deps = depsByFrom.get(id) ?? overlay?.dependencies ?? []
    out.push({
      id,
      title:
        (ct && typeof ct.title === 'string' && ct.title) ||
        overlay?.title ||
        id,
      projectId: ct?.projectId ?? overlay?.projectId ?? null,
      featureContractId,
      objective:
        (ct && typeof ct.objective === 'string' && ct.objective) ||
        overlay?.objective ||
        null,
      dependencies: deps,
      impacts: overlay?.impacts ?? [],
      checkpoints: overlay?.checkpoints ?? [],
      // Left-join only — missing stage stays null (never inherit orphan lifecycle-only rows).
      lifecycleStage: overlay?.lifecycleStage ?? null,
      blockedReason: overlay?.blockedReason ?? null,
      lastReceiptAt: overlay?.lastReceiptAt ?? null,
      updated: overlay?.updated ?? null,
      phase: overlay?.phase ?? null,
      scope: overlay?.scope,
      status: overlay?.status ?? null,
    })
  }
  return out
}

export type ControlCenterDefinitionLoad =
  | {
      kind: 'canonical'
      model: CanonicalDefinitionReadModel
      raw: RawBoard
      tasks: WorkTask[]
      boardRev: number
      lifecycleRev: number
      authorityCanonicalHash: string
      authorityCanonicalSnapshotId: string
      pinAuthorityComplete: true
    }
  | {
      kind: 'mismatch'
      code: string
      message: string
      details: Readonly<Record<string, unknown>>
      boardRev: number
      lifecycleRev: number
      authorityCanonicalHash: string | null
      authorityCanonicalSnapshotId: string | null
      /** Pin identity known but definition refused — empty raw/tasks, never legacy merge. */
      raw: RawBoard
      tasks: WorkTask[]
      pinAuthorityComplete: false
    }
  | {
      kind: 'legacy'
      reason: 'PIN_MISSING' | 'PIN_INCOMPLETE' | 'PIN_SYNTHETIC' | 'NO_IMPORTS'
    }

/**
 * Resolve definition sources for control-center.
 * Pin-complete + valid snapshot → sole definition authority.
 * Pin-complete + mismatch → fail-closed empty definition (no legacy merge).
 * No pin → legacy path (caller loads board_docs/tasks).
 */
export async function resolveControlCenterDefinitionLoad(
  boardId: string,
  imports: NonNullable<ControlPlaneRuntimeContext['controlData']>['imports'],
  lifecycleTasks: WorkTask[] = [],
): Promise<ControlCenterDefinitionLoad> {
  const boardState = await imports.getBoardState(boardId)
  if (!boardState) {
    return { kind: 'legacy', reason: 'PIN_MISSING' }
  }
  if (!isPinComplete(boardState)) {
    return {
      kind: 'legacy',
      reason: isSyntheticCanonicalSnapshotId(boardId, boardState.canonicalSnapshotId)
        ? 'PIN_SYNTHETIC'
        : 'PIN_INCOMPLETE',
    }
  }

  const loaded = await tryLoadPinnedDefinitionReadModel(imports, boardId)
  const pinHash =
    (boardState.canonicalHash && String(boardState.canonicalHash).trim()) ||
    (boardState.subjectHash && String(boardState.subjectHash).trim()) ||
    null
  const pinSnap =
    boardState.canonicalSnapshotId && String(boardState.canonicalSnapshotId).trim()
      ? String(boardState.canonicalSnapshotId).trim()
      : null

  if (!loaded.ok) {
    return {
      kind: 'mismatch',
      code: loaded.code,
      message: loaded.message,
      details: loaded.details,
      boardRev: boardState.boardRev,
      lifecycleRev: boardState.lifecycleRev,
      authorityCanonicalHash: pinHash,
      authorityCanonicalSnapshotId: pinSnap,
      raw: { projects: [], features: [], decisions: [], log: [], queue: { now: [], next: [] }, runs: [] },
      tasks: [],
      pinAuthorityComplete: false,
    }
  }

  const lifecycleByTaskId = new Map<string, WorkTask>()
  for (const t of lifecycleTasks) {
    if (t?.id) lifecycleByTaskId.set(t.id, t)
  }
  return {
    kind: 'canonical',
    model: loaded.model,
    raw: rawBoardFromCanonicalProjection(loaded.model.projection),
    tasks: workTasksFromCanonicalProjection(loaded.model.projection, lifecycleByTaskId),
    boardRev: loaded.model.pin.boardRev,
    lifecycleRev: loaded.model.pin.lifecycleRev,
    authorityCanonicalHash: loaded.model.pin.canonicalHash,
    authorityCanonicalSnapshotId: loaded.model.pin.canonicalSnapshotId,
    pinAuthorityComplete: true,
  }
}

/**
 * Authenticated board load → single aggregation.
 * Loads durable V3 runs/accounts/active plan/DecisionV3/G5/classifications/audit
 * in parallel via control-plane-runtime-context. Partial source failures become
 * sectionErrors / empty sections (never fabricated PASS).
 * Active ownership is NEVER derived from legacy embedded claims/board.runs.
 *
 * Definition graph (projects/features/tasks): pinned snapshot is sole authority
 * when pin-complete; mismatch fails closed (no legacy merge). No pin → legacy
 * board_docs/tasks with PIN_AUTHORITY_INCOMPLETE honesty.
 */
export async function loadControlCenterAggregation(
  boardId: string,
  opts: { now?: string; runtime?: ControlPlaneRuntimeContext | null } = {},
): Promise<ControlCenterAggregation> {
  const boards = await listBoards()
  if (!boards.some((b) => b.id === boardId)) {
    throw new Error(`board not found: ${boardId}`)
  }

  const sectionErrors: Array<{ section: string; code: string; message: string }> = []
  // Initialized before branch assignment so TS definite-assignment is satisfied.
  let raw: RawBoard = {
    projects: [],
    features: [],
    decisions: [],
    log: [],
    queue: { now: [], next: [] },
    runs: [],
  }
  let tasks: WorkTask[] = []
  let opsAccounts: ControlCenterSourceBundle['opsAccounts'] = []
  // Legacy board.runs kept only for residual diagnostic — ownership uses durableRuns.
  let legacyRuns: Run[] = []
  let hash = ''
  // Honest zero until board_revisions row is proven; never invent positive pins.
  let boardRev = 0
  let lifecycleRev = 0
  let authorityCanonicalHash: string | null = null
  let authorityCanonicalSnapshotId: string | null = null
  let pinAuthorityComplete = false
  let dispatchNext: DispatchNextUi | null = null
  let usedCanonicalDefinition = false

  // ---- Runtime context early (needed for import pin + durable V3) ----
  const ctxResultEarly =
    opts.runtime !== undefined
      ? { ctx: opts.runtime, error: opts.runtime ? null : 'runtime context not injected' }
      : tryGetRuntimeContext()
  const runtimeForDefinition = ctxResultEarly.ctx

  // Soft-load lifecycle rows for overlay (never definition authority).
  let lifecycleTasksForOverlay: WorkTask[] = []
  try {
    const tasksDoc = await readTasks(boardId)
    lifecycleTasksForOverlay = tasksDoc.tasks ?? []
  } catch {
    lifecycleTasksForOverlay = []
  }

  if (runtimeForDefinition?.controlData?.imports) {
    const defLoad = await resolveControlCenterDefinitionLoad(
      boardId,
      runtimeForDefinition.controlData.imports,
      lifecycleTasksForOverlay,
    )
    if (defLoad.kind === 'canonical') {
      usedCanonicalDefinition = true
      raw = defLoad.raw
      tasks = defLoad.tasks
      boardRev = defLoad.boardRev
      lifecycleRev = defLoad.lifecycleRev
      authorityCanonicalHash = defLoad.authorityCanonicalHash
      authorityCanonicalSnapshotId = defLoad.authorityCanonicalSnapshotId
      pinAuthorityComplete = true
      // Content hash is non-authority diagnostic; prefer live boardHash when available.
      try {
        hash = await boardHash(boardId)
      } catch {
        hash = defLoad.model.pin.payloadSha256.slice(0, 16)
      }
      // Preserve non-definition overlays (conventions/design/collab/runs) from board_docs
      // without reintroducing legacy projects/features/tasks as definition authority.
      try {
        const legacyRaw = await readBoard(boardId)
        legacyRuns = (legacyRaw.runs ?? []) as Run[]
        raw = {
          ...raw,
          conventions: legacyRaw.conventions,
          design: legacyRaw.design,
          collab: legacyRaw.collab,
          decisions: legacyRaw.decisions,
          log: legacyRaw.log,
          // queue intentionally from empty canonical (dispatch NEXT is durable plan)
        }
      } catch {
        legacyRuns = []
      }
    } else if (defLoad.kind === 'mismatch') {
      usedCanonicalDefinition = true // block legacy definition merge
      raw = defLoad.raw
      tasks = []
      boardRev = defLoad.boardRev
      lifecycleRev = defLoad.lifecycleRev
      // Pin identity from board_revisions for honesty; definition empty + stale section.
      authorityCanonicalHash = defLoad.authorityCanonicalHash
      authorityCanonicalSnapshotId = defLoad.authorityCanonicalSnapshotId
      pinAuthorityComplete = false
      sectionErrors.push({
        section: 'definition',
        code: defLoad.code,
        message: defLoad.message,
      })
      sectionErrors.push({
        section: 'definition',
        code: 'DEFINITION_AUTHORITY_STALE',
        message:
          'pinned snapshot missing/mismatched; refusing legacy board_docs/tasks merge for definition',
      })
      try {
        hash = await boardHash(boardId)
      } catch {
        hash = ''
      }
    }
  }

  if (!usedCanonicalDefinition) {
    try {
      ;[raw, hash] = await Promise.all([readBoard(boardId), boardHash(boardId)])
      legacyRuns = (raw.runs ?? []) as Run[]
    } catch (e) {
      throw e
    }

    const persistedRev = await readPersistedBoardRevisions(boardId)
    if (persistedRev) {
      boardRev = persistedRev.boardRev
      lifecycleRev = persistedRev.lifecycleRev
      if (persistedRev.complete) {
        // Pin row looks complete via SQL but ImportStorage path did not supply snapshot
        // (runtime missing / incomplete). Do NOT claim pinAuthorityComplete — definition
        // is legacy board_docs and must not rewrite classification receipts to pin hash.
        authorityCanonicalHash = null
        authorityCanonicalSnapshotId = null
        pinAuthorityComplete = false
        sectionErrors.push({
          section: 'definition',
          code: 'PIN_AUTHORITY_INCOMPLETE',
          message:
            'board_revisions pin present but canonical snapshot definition was not loaded via ImportStorage; serving legacy definition with incomplete pin authority',
        })
      } else {
        // Partial/invalid authority — fail closed: revs used, pin hash NOT treated as verified.
        sectionErrors.push({
          section: 'revisions',
          code: 'PIN_AUTHORITY_INCOMPLETE',
          message: `board_revisions row present but pin authority incomplete (${persistedRev.incompleteReason ?? 'unknown'}); canonicalHash falls back to live boardHash; classification receipts not rebound`,
        })
      }
    } else {
      sectionErrors.push({
        section: 'revisions',
        code: 'REVISION_AUTHORITY_MISSING',
        message:
          'board_revisions row absent or unreadable; pin boardRev/lifecycleRev left at honest 0 (not fabricated)',
      })
    }

    try {
      const tasksDoc = await readTasks(boardId)
      tasks = tasksDoc.tasks ?? []
    } catch (e) {
      sectionErrors.push({
        section: 'tasks',
        code: 'PARTIAL_SOURCE',
        message: e instanceof Error ? e.message : 'tasks load failed',
      })
    }
  }

  // Legacy ops is diagnostic only — never account capacity authority (C2 snapshot is).
  try {
    const ops = await readOps(boardId)
    opsAccounts = (ops.accounts ?? []) as ControlCenterSourceBundle['opsAccounts']
  } catch (e) {
    sectionErrors.push({
      section: 'accounts_legacy',
      code: 'PARTIAL_SOURCE',
      message: e instanceof Error ? e.message : 'legacy ops load failed',
    })
  }

  // ---- Durable V3 sources in parallel (runtime context) ----
  const ctx = runtimeForDefinition
  if (!ctx) {
    sectionErrors.push({
      section: 'runtime_context',
      code: 'PARTIAL_SOURCE',
      message: ctxResultEarly.error ?? 'control-plane runtime context unavailable',
    })
  }

  type Settled<T> = { ok: true; value: T } | { ok: false; error: string }
  const settle = async <T>(p: Promise<T>, label: string): Promise<Settled<T>> => {
    try {
      return { ok: true, value: await p }
    } catch (e) {
      return { ok: false, error: e instanceof Error ? e.message : `${label} failed` }
    }
  }

  const emptyRunList: RunRecord[] = []
  const emptyDecisions: DecisionV3Record[] = []
  const emptyG5: G5DomainRecord[] = []
  const emptyClass: TaskClassificationRecord[] = []

  const [
    durableRunsS,
    accountSnapS,
    activePlanS,
    decisionsS,
    g5S,
    classS,
    auditS,
    importAuditS,
    humanDisplayS,
  ] = await Promise.all([
    ctx
      ? settle(ctx.runtime.runs.list(boardId), 'runs')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    // Authenticated UI account source service path (real projection + schema identity).
    ctx
      ? settle(
          readAuthenticatedUiAccountSourceService({
            boardId,
            accounts: ctx.runtime.accounts,
            auth: { kind: 'system' },
          }).then(async (uiSrc) => {
            if (uiSrc?.readModel) return uiSrc.readModel
            // Fall back to raw pinned snapshot when projection null (missing).
            return loadPinnedAuthoritativeAccountSnapshot(boardId, ctx.runtime.accounts)
          }),
          'accounts',
        )
      : settle(readLatestAccountSyncSnapshot(boardId), 'accounts_fallback'),
    ctx
      ? settle(ctx.runtime.plans.getActive(boardId), 'active_plan')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx
      ? settle(ctx.controlData.decisions.list(boardId), 'decisions')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx
      ? settle(ctx.controlData.g5.list(boardId), 'g5')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx
      ? settle(ctx.controlData.classification.list(boardId), 'classification')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx
      ? settle(ctx.atomic.listAudit(boardId), 'material_audit')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx
      ? settle(ctx.controlData.imports.listImportAudit(boardId), 'import_audit')
      : Promise.resolve({ ok: false as const, error: 'no runtime context' }),
    ctx?.humanDisplay
      ? settle(ctx.humanDisplay.list(boardId), 'human_display')
      : Promise.resolve({
          ok: false as const,
          error: 'no humanDisplay store on runtime context',
        }),
  ])

  const durableRuns: RunRecord[] = durableRunsS.ok ? durableRunsS.value : emptyRunList
  if (!durableRunsS.ok) {
    sectionErrors.push({
      section: 'runs',
      code: 'PARTIAL_SOURCE',
      message: durableRunsS.error,
    })
  }

  let accountSyncSnapshot: AccountSyncSnapshot | AccountSyncCcReadModel | null = null
  if (accountSnapS.ok) {
    accountSyncSnapshot = accountSnapS.value
  } else {
    sectionErrors.push({
      section: 'accounts',
      code: 'PARTIAL_SOURCE',
      message: accountSnapS.error,
    })
  }

  let activePlan: DispatchPlanRecord | null = null
  if (activePlanS.ok) {
    activePlan = activePlanS.value
  } else {
    sectionErrors.push({
      section: 'dispatch',
      code: 'PARTIAL_SOURCE',
      message: activePlanS.error,
    })
  }

  const durableDecisions: DecisionV3Record[] = decisionsS.ok
    ? decisionsS.value
    : emptyDecisions
  if (!decisionsS.ok) {
    sectionErrors.push({
      section: 'decisions',
      code: 'PARTIAL_SOURCE',
      message: decisionsS.error,
    })
  }

  const g5Domains: G5DomainRecord[] = g5S.ok ? g5S.value : emptyG5
  if (!g5S.ok) {
    sectionErrors.push({
      section: 'g5',
      code: 'PARTIAL_SOURCE',
      message: g5S.error,
    })
  }

  const durableClassifications: TaskClassificationRecord[] = classS.ok
    ? classS.value
    : emptyClass
  if (!classS.ok) {
    sectionErrors.push({
      section: 'classification',
      code: 'PARTIAL_SOURCE',
      message: classS.error,
    })
  }

  const materialAuditEvents: AuditUiEvent[] = []
  if (auditS.ok) {
    for (const ev of auditS.value) {
      materialAuditEvents.push(mapMaterialAuditToUiEvent(ev))
    }
  } else {
    sectionErrors.push({
      section: 'audit',
      code: 'PARTIAL_SOURCE',
      message: auditS.error,
    })
  }
  if (importAuditS.ok) {
    for (const row of importAuditS.value) {
      materialAuditEvents.push(mapImportAuditToUiEvent(row))
    }
  } else if (ctx) {
    sectionErrors.push({
      section: 'import_audit',
      code: 'PARTIAL_SOURCE',
      message: importAuditS.error,
    })
  }

  // Dispatch NEXT from durable active plan store when available; else shared memory fallback.
  try {
    const planStore = ctx?.runtime.plans ?? getSharedDispatchPlanStore()
    const selected = await selectNextFromActivePlan(
      { clock: ctx?.clock ?? createSystemClock(), plans: planStore },
      boardId,
    )
    // Prefer already-fetched active plan when select used same store.
    if (!activePlan && selected.plan) activePlan = selected.plan
    const projected = projectDispatchNextFields(selected)
    dispatchNext = {
      selectedForNextDispatch: projected.selectedForNextDispatch.map((s) => ({
        taskId: s.taskId,
        rank: s.rank,
        selectionReason: s.selectionReason,
        targetGate: s.targetGate,
        role: s.role,
        priorityPortfolioId: s.priorityPortfolioId ?? null,
      })),
      planId: projected.planId,
      blockedReason: projected.blockedReason,
      soleSource: 'active_dispatch_plan',
    }
  } catch (e) {
    sectionErrors.push({
      section: 'dispatch',
      code: 'PARTIAL_SOURCE',
      message: e instanceof Error ? e.message : 'dispatch next load failed',
    })
    dispatchNext = {
      selectedForNextDispatch: [],
      planId: null,
      blockedReason: 'dispatch source unavailable',
      soleSource: 'active_dispatch_plan',
    }
  }

  // Prefer atomic board rev when available and higher-fidelity than partial parse.
  if (ctx) {
    try {
      const st = await ctx.atomic.getBoardState(boardId)
      if (typeof st.boardRev === 'number' && Number.isInteger(st.boardRev) && st.boardRev >= 0) {
        // Do not lower a proven persisted rev; only fill when still 0.
        if (boardRev === 0 && st.boardRev > 0) boardRev = st.boardRev
      }
    } catch {
      // ignore — board_revisions parse already recorded
    }
  }

  // Pin-complete: force classification fail-closed for DISTINCT definition tasks only.
  // Missing store row → UNCLASSIFIED/DATA_INTEGRITY; never promote legacy embedded class.
  // Even when classification store load fails, treat as loaded-empty under pin authority.
  const forceClassFailClosed = pinAuthorityComplete
  const classificationsForAgg: TaskClassificationRecord[] | null = classS.ok
    ? durableClassifications
    : forceClassFailClosed
      ? emptyClass
      : null

  const humanDisplayRecords: HumanDisplayRecord[] = humanDisplayS.ok
    ? humanDisplayS.value
    : []
  if (!humanDisplayS.ok) {
    sectionErrors.push({
      section: 'human_display',
      code: 'PARTIAL_SOURCE',
      message: humanDisplayS.error,
    })
  }

  return buildControlCenterAggregationFromSources({
    boardId,
    raw,
    tasks,
    opsAccounts,
    // Never use legacy embedded runs for ownership; keep only when durable failed entirely.
    runs: durableRunsS.ok ? [] : legacyRuns,
    boardContentHash: hash,
    boardRev,
    lifecycleRev,
    authorityCanonicalHash,
    authorityCanonicalSnapshotId,
    pinAuthorityComplete,
    now: opts.now,
    dispatchNext,
    sectionErrors,
    accountSyncSnapshot,
    durableRuns,
    durableOwnershipLoaded: durableRunsS.ok,
    durableDecisions: decisionsS.ok ? durableDecisions : null,
    durableClassifications: classificationsForAgg,
    durableClassificationsLoaded: classS.ok || forceClassFailClosed,
    g5Domains,
    activePlan,
    materialAuditEvents: materialAuditEvents.length > 0 ? materialAuditEvents : null,
    humanDisplayRecords,
    humanDisplayLoaded: humanDisplayS.ok,
  })
}

export type {
  PrimaryBucket,
  StaleOverlayKind,
} from '#/lib/control-plane-types'
