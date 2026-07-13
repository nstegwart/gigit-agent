/**
 * C3-W1: Load board source objects → one ControlCenterAggregation pin.
 * Fail-closed: missing V3 classification/receipt → UNCLASSIFIED (never invent PRODUCT
 * from phase/progress/pct). Reuses C1/C2 rollup/priority/G5/dispatch via control-center-ui.
 * Account IDs masked; no tokens/private decision bodies/secrets in aggregation inputs.
 */

import { createHash } from 'node:crypto'

import { buildModel } from '#/lib/model'
import type {
  ClassificationReceipt,
  G5DomainRecord,
  PrimaryBucket,
  StaleOverlayKind,
  TaskClassificationRecord,
  TaskClass,
  TaskDisposition,
} from '#/lib/control-plane-types'
import { TASK_CLASSES, TASK_DISPOSITIONS } from '#/lib/control-plane-types'
import type { Decision, DecisionOptionV3Carrier, RawBoard, Run, WorkTask } from '#/lib/types'
import {
  boardHash,
  listBoards,
  readBoard,
  readOps,
  readTasks,
} from '#/server/board-store'
import { parseValidClaimState } from '#/server/tasks-store'
import {
  selectNextFromActivePlan,
  getSharedDispatchPlanStore,
  projectDispatchNextFields,
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
  aggregateControlCenter,
  maskAccountForUi,
  type AccountSyncUiMeta,
  type AccountUiSummary,
  type AuditUiEvent,
  type ControlCenterAggregation,
  type ControlCenterAggregationInput,
  type ControlCenterPin,
  type ControlCenterTaskInput,
  type DispatchNextUi,
  type FeatureUiSummary,
  type ProjectUiSummary,
  type ProductiveSubstate,
  type RunUiSummary,
} from '#/server/control-center-ui'

/** Optional run-registry / extended fields never mirrored from heartbeat alone. */
type RunSourceExt = Run & {
  heartbeatAt?: string | null
  materialProgressAt?: string | null
  claimState?: string | null
  collisionScopeLockIds?: string[] | null
  controllerRunId?: string | null
  parentRunId?: string | null
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

/** Safe subject/canonical hash shape (matches classification receipt hash bounds). */
export const SAFE_CANONICAL_HASH_RE = /^[a-f0-9]{16,128}$/i
/** Bounded non-empty snapshot id (alphanumeric + common separators). */
export const SAFE_SNAPSHOT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/

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
  } = {},
): ControlCenterTaskInput {
  const classification = mapTaskClassification(task, pin)
  const run = opts.run
  const hardBlocker = Boolean(
    task.blockedReason ||
      (Array.isArray(task.blockers) && task.blockers.length > 0) ||
      task.status === 'blocked',
  )
  // Valid claim enum only — invalid/absent → undefined (fail-closed, never trusted).
  const claimState = parseValidClaimState(task.claimState)
  const productStageMode =
    typeof task.productStageMode === 'string' && PRODUCT_STAGE_MODES.has(task.productStageMode)
      ? (task.productStageMode as 'STAGE_1' | 'STAGE_2')
      : 'STAGE_2'
  // Task decision flags may only SUPPLEMENT open Decision source (opts), never clear it.
  const hasBlockingDecision =
    Boolean(opts.hasBlockingDecision) || task.hasBlockingDecision === true
  const hasNonBlockingDecision =
    Boolean(opts.hasNonBlockingDecision) || task.hasNonBlockingDecision === true
  // targetGate / evidence only from explicit source truth — never invent from heartbeat.
  const targetGate =
    (typeof task.targetGate === 'string' && task.targetGate.trim()
      ? task.targetGate.trim()
      : null) ??
    task.lifecycleStage ??
    null
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
    runLiveness:
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
                : undefined,
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
    p0Blocker: task.p0Blocker === true,
    targetGate,
    agentId: run?.agent ?? null,
    role: run?.role ?? null,
    model: run?.model ?? null,
    effort: run?.effort ?? null,
    accountRef: run?.account ?? null,
    startedAt: run?.started ?? null,
    // Distinct fields only — never set materialProgressAt = heartbeat for shape.
    heartbeatAt: (run as RunSourceExt | null | undefined)?.heartbeatAt ?? run?.updated ?? null,
    materialProgressAt: (run as RunSourceExt | null | undefined)?.materialProgressAt ?? null,
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
 */
export function buildControlCenterAggregationFromSources(
  src: ControlCenterSourceBundle,
): ControlCenterAggregation {
  const generatedAt = src.now ?? new Date().toISOString()
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

  // Project decisions first so open Decision source drives blocking mapping.
  const decisions = model.decisions.map((d) =>
    mapLegacyDecisionToV3(src.boardId, d, src.boardRev),
  )

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
  for (const d of model.openDecisions) {
    if (d.featureId) openBlockingFeatureIds.add(d.featureId)
  }

  const runByTask = new Map<string, Run>()
  for (const r of src.runs) {
    const tid = r.taskId || r.task
    if (tid && !runByTask.has(String(tid))) runByTask.set(String(tid), r)
  }

  const tasks: ControlCenterTaskInput[] = src.tasks.map((t) => {
    const hasBlocking =
      Boolean(t.featureContractId && openBlockingFeatureIds.has(t.featureContractId)) ||
      blockingDecisionTaskIds.has(t.id)
    // Non-blocking: explicit open Decision on task only (does not demote ONGOING).
    const hasNonBlocking = nonBlockingDecisionTaskIds.has(t.id)
    return mapWorkTaskToControlCenterInput(t, pin, {
      // NEXT solely from active root dispatch plan — never task.selectedForNextDispatch.
      selectedForNextDispatch: nextIds.has(t.id),
      hasBlockingDecision: hasBlocking,
      hasNonBlockingDecision: hasNonBlocking,
      run: runByTask.get(t.id) ?? null,
    })
  })

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

  const runs: RunUiSummary[] = src.runs.map((r) => {
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

  // Material events from activity feed only (summary strings already on Model).
  const auditEvents: AuditUiEvent[] = (model.activity ?? []).slice(0, 200).map((ev, i) => ({
    id: `act-${i}-${String(ev.ts ?? i)}`,
    createdAt: ev.ts ? new Date(ev.ts).toISOString() : generatedAt,
    kind: ev.kind || 'activity',
    actorId: ev.actor ?? null,
    subjectId: ev.featureId ?? null,
    summary: String(ev.text ?? '').slice(0, 500),
    materialHash: null,
    boardRev: src.boardRev,
  }))

  const sectionErrors = [...(src.sectionErrors ?? [])]
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

  const input: ControlCenterAggregationInput = {
    pin,
    tasks,
    g5Domains: src.g5Domains ?? [],
    priorityPackets: [],
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
    frontierStateWhenEmpty: 'PRIORITY_FRONTIER_EMPTY',
  }

  return aggregateControlCenter(input)
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
 * Authenticated board load → single aggregation.
 * Partial source failures become sectionErrors / empty sections (never fabricated PASS).
 */
export async function loadControlCenterAggregation(
  boardId: string,
  opts: { now?: string } = {},
): Promise<ControlCenterAggregation> {
  const boards = await listBoards()
  if (!boards.some((b) => b.id === boardId)) {
    throw new Error(`board not found: ${boardId}`)
  }

  const sectionErrors: Array<{ section: string; code: string; message: string }> = []
  let raw: RawBoard
  let tasks: WorkTask[] = []
  let opsAccounts: ControlCenterSourceBundle['opsAccounts'] = []
  let runs: Run[] = []
  let hash = ''
  // Honest zero until board_revisions row is proven; never invent positive pins.
  let boardRev = 0
  let lifecycleRev = 0
  let authorityCanonicalHash: string | null = null
  let authorityCanonicalSnapshotId: string | null = null
  let pinAuthorityComplete = false
  let dispatchNext: DispatchNextUi | null = null

  try {
    ;[raw, hash] = await Promise.all([readBoard(boardId), boardHash(boardId)])
    runs = (raw.runs ?? []) as Run[]
  } catch (e) {
    throw e
  }

  const persistedRev = await readPersistedBoardRevisions(boardId)
  if (persistedRev) {
    boardRev = persistedRev.boardRev
    lifecycleRev = persistedRev.lifecycleRev
    if (persistedRev.complete) {
      authorityCanonicalHash = persistedRev.subjectHash
      authorityCanonicalSnapshotId = persistedRev.canonicalSnapshotId
      pinAuthorityComplete = true
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

  let accountSyncSnapshot: AccountSyncSnapshot | null = null
  try {
    accountSyncSnapshot = await readLatestAccountSyncSnapshot(boardId)
  } catch (e) {
    sectionErrors.push({
      section: 'accounts',
      code: 'PARTIAL_SOURCE',
      message: e instanceof Error ? e.message : 'account-sync snapshot read failed',
    })
    accountSyncSnapshot = null
  }

  try {
    const selected = await selectNextFromActivePlan(
      { clock: createSystemClock(), plans: getSharedDispatchPlanStore() },
      boardId,
    )
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

  return buildControlCenterAggregationFromSources({
    boardId,
    raw,
    tasks,
    opsAccounts,
    runs,
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
  })
}

export type { PrimaryBucket, StaleOverlayKind }
