/**
 * C3-F1: Authenticated control-center UI bridge.
 * Injectable pure aggregation + projections over one pinned revision tuple.
 * Reuses C1/C2: classification, computeRollupV3, bucket precedence, G5,
 * dispatch-plan NEXT, decisions order, cursor pagination, account masking.
 * No client recomputation of readiness / buckets / priority / G5 / NEXT.
 */

import type {
  G5DomainRecord,
  G5Evaluation,
  PinnedRevisionTuple,
  PrimaryBucket,
  PriorityAllocationResult,
  PriorityFrontierState,
  RollupV3Result,
  StaleOverlayKind,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import { DomainError, isStaleFamilyOverlay } from '#/lib/control-plane-types'
import {
  meanReadinessOneDecimal,
  taskStageWeight,
} from '#/lib/readiness-policy'
import {
  compareDecisionsV3,
  isVisibleInInbox,
  type DecisionV3Record,
} from './decisions-v3'
import { evaluateG5 } from './g5'
import { maskAccountId, maskAccountRef } from './public-snapshot'
import { evaluateClassification } from './classification'
import {
  computePriorityAllocation,
  computeRollupV3,
  type PriorityPacket,
  type RollupTaskInput,
} from './rollup-v3'
import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  paginateDesc,
  type PageParams,
} from './cursor'
import { contributesUsableCapacity, type MaskedAccountStatus } from './account-sync'
import {
  resolveOwnerHumanDisplay,
  type HumanDisplayCitation,
  type HumanDisplayEntityKind,
  type HumanDisplayLivePin,
  type HumanDisplayMissionQuestionLink,
  type HumanDisplayAcceptanceLink,
  type HumanDisplayReviewStatus,
  type HumanDisplayV1,
} from './human-display'

// ---------------------------------------------------------------------------
// Schema / pin / envelope
// ---------------------------------------------------------------------------

export const CONTROL_CENTER_UI_SCHEMA = 'TM_PINNED_ENVELOPE_V1' as const
export const CONTROL_CENTER_UI_SURFACE_VERSION = 'CC_UI_V1' as const

export type ControlCenterSurface =
  | 'overview'
  | 'work'
  | 'priority'
  | 'projects'
  | 'features'
  | 'agents'
  | 'ops'
  | 'decisions'
  | 'evidence'

export type UiSurfaceState =
  | 'populated'
  | 'empty'
  | 'partial'
  | 'stale'
  | 'disconnected'
  | 'error'
  | 'loading'
  | 'forbidden'
  | 'zero-results'
  | 'needs-human'

export interface ControlCenterPin {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  taskHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
}

export interface PinnedEnvelopeError {
  code: string
  message: string
  details?: Readonly<Record<string, unknown>>
}

/** Common authenticated read envelope (API_CONTRACT §3). */
export interface PinnedEnvelope<T = unknown> {
  schemaVersion: typeof CONTROL_CENTER_UI_SCHEMA
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
  data: T
  nextCursor: string | null
  /** UI state for the surface (safe shapes). */
  surfaceState: UiSurfaceState
  surface: ControlCenterSurface | 'common' | null
  error: PinnedEnvelopeError | null
}

export function pinToTuple(pin: ControlCenterPin): PinnedRevisionTuple {
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
  }
}

export function assertPinComplete(pin: ControlCenterPin): void {
  if (
    !pin.boardId ||
    !pin.canonicalSnapshotId ||
    !pin.canonicalHash ||
    !pin.taskHash ||
    typeof pin.boardRev !== 'number' ||
    typeof pin.lifecycleRev !== 'number' ||
    !pin.generatedAt
  ) {
    throw new DomainError('INVALID_INPUT', 'control-center pin incomplete', { pin })
  }
}

export function createPinnedEnvelope<T>(
  pin: ControlCenterPin,
  data: T,
  opts: {
    nextCursor?: string | null
    surfaceState?: UiSurfaceState
    surface?: ControlCenterSurface | 'common' | null
    error?: PinnedEnvelopeError | null
  } = {},
): PinnedEnvelope<T> {
  assertPinComplete(pin)
  const stale = pin.stale || opts.surfaceState === 'stale'
  let surfaceState = opts.surfaceState
  if (!surfaceState) {
    if (opts.error) surfaceState = 'error'
    else if (stale) surfaceState = 'stale'
    else surfaceState = 'populated'
  }
  return {
    schemaVersion: CONTROL_CENTER_UI_SCHEMA,
    boardId: pin.boardId,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    generatedAt: pin.generatedAt,
    freshnessAgeSeconds: pin.freshnessAgeSeconds,
    stale,
    staleReason: pin.staleReason,
    data,
    nextCursor: opts.nextCursor ?? null,
    surfaceState,
    surface: opts.surface ?? null,
    error: opts.error ?? null,
  }
}

/** Safe shapes for transport / partial failure — never invent green numbers. */
export function envelopeError(
  pin: ControlCenterPin | null,
  code: string,
  message: string,
  surface: ControlCenterSurface | 'common' = 'common',
  details?: Record<string, unknown>,
): PinnedEnvelope<null> {
  const fallbackPin: ControlCenterPin = pin ?? {
    boardId: '',
    canonicalSnapshotId: '',
    canonicalHash: '',
    taskHash: '',
    boardRev: 0,
    lifecycleRev: 0,
    generatedAt: new Date(0).toISOString(),
    freshnessAgeSeconds: 0,
    stale: true,
    staleReason: code,
  }
  // Allow empty pin fields only for hard error envelopes (no invent success).
  return {
    schemaVersion: CONTROL_CENTER_UI_SCHEMA,
    boardId: fallbackPin.boardId,
    canonicalSnapshotId: fallbackPin.canonicalSnapshotId,
    canonicalHash: fallbackPin.canonicalHash,
    boardRev: fallbackPin.boardRev,
    lifecycleRev: fallbackPin.lifecycleRev,
    generatedAt: fallbackPin.generatedAt,
    freshnessAgeSeconds: fallbackPin.freshnessAgeSeconds,
    stale: true,
    staleReason: fallbackPin.staleReason ?? code,
    data: null,
    nextCursor: null,
    surfaceState: code === 'DISCONNECTED' ? 'disconnected' : code === 'FORBIDDEN' ? 'forbidden' : 'error',
    surface,
    error: { code, message, ...(details ? { details } : {}) },
  }
}

export function envelopeDisconnected(
  pin: ControlCenterPin | null,
  surface: ControlCenterSurface | 'common' = 'common',
): PinnedEnvelope<null> {
  return envelopeError(pin, 'DISCONNECTED', 'transport disconnected', surface)
}

export function envelopeForbidden(
  pin: ControlCenterPin | null,
  surface: ControlCenterSurface | 'common' = 'common',
): PinnedEnvelope<null> {
  return envelopeError(pin, 'FORBIDDEN', 'authorization required', surface)
}

// ---------------------------------------------------------------------------
// Input shapes (injectable — no I/O)
// ---------------------------------------------------------------------------

export type ProductiveSubstate = 'PRODUCTIVE' | 'IDLE' | 'STALLED'

/**
 * Owner-facing humanDisplay projection for control-center DTOs.
 * Fail-closed: when primary is null, ownerPrimaryTitle/statusSentence/… come from
 * blockedShell (CONTENT_REVIEW_REQUIRED) — never from raw technical title alone.
 */
export interface OwnerHumanDisplayUiProjection {
  /** REVIEWED+fresh owner primary copy; null when content review required. */
  primary: HumanDisplayV1 | null
  /** Always present shell for list visibility (CONTENT_REVIEW_REQUIRED). */
  blockedShell: HumanDisplayV1
  effectiveReviewStatus: HumanDisplayReviewStatus
  contentReviewRequired: boolean
  /**
   * Owner-facing primary title. From primary when ready; otherwise blockedShell.title.
   * NEVER the raw technical task/decision title.
   */
  ownerPrimaryTitle: string
  /** Status sentence from owner-facing copy (primary.current or blockedShell.current). */
  statusSentence: string
  ownerAction: string
  whyItMatters: string
  next: string
  blocker: string
  citations: ReadonlyArray<HumanDisplayCitation>
  acceptanceLinks: ReadonlyArray<HumanDisplayAcceptanceLink>
  missionQuestionLinks: ReadonlyArray<HumanDisplayMissionQuestionLink>
  /** Pin bindings from owner-facing display (snapshot/hash/revs/sourceHash). */
  pin: {
    snapshotId: string | null
    boardRev: number | null
    lifecycleRev: number | null
    canonicalHash: string | null
    sourceHash: string
  }
}

/** Zero-click ONGOING row fields (UI_CONTRACT §7) — server-derived ages. */
export interface OngoingUiRow {
  taskId: string
  title: string
  targetGate: string
  agentId: string
  role: string
  model: string | null
  effort: string | null
  maskedAccount: string | null
  startedAt: string | null
  startedAgeSeconds: number | null
  heartbeatAt: string | null
  heartbeatAgeSeconds: number | null
  materialProgressAt: string | null
  materialProgressAgeSeconds: number | null
  productiveSubstate: ProductiveSubstate
  evidenceLink: string | null
  bucket: 'ONGOING'
  overlays: Array<StaleOverlayKind>
  /** Owner humanDisplay projection (fail-closed when missing/unreviewed). */
  ownerHumanDisplay?: OwnerHumanDisplayUiProjection | null
}

export interface WorkTaskUiRow {
  taskId: string
  title: string
  projectId: string | null
  featureId: string | null
  bucket: PrimaryBucket | null
  overlays: Array<StaleOverlayKind>
  blockReason: string | null
  outsideTracked: boolean
  lifecycleStage: string | null
  targetGate: string | null
  /**
   * Current claim enum for RECON/ownership drilldown (metadata only).
   * Sourced only from validated ControlCenterTaskInput.claimState — never
   * recomputed client-side and never used as bucket authority.
   * null when source claim is missing/invalid.
   */
  claimState: string | null
  /** Stable cursor keys */
  createdAt: string
  id: string
  /** Owner humanDisplay projection (fail-closed when missing/unreviewed). */
  ownerHumanDisplay?: OwnerHumanDisplayUiProjection | null
}

/**
 * Task detail DTO — owner humanDisplay + technical identifiers demoted.
 * Primary owner surface uses ownerHumanDisplay.ownerPrimaryTitle, never raw title alone.
 */
export interface TaskDetailUiDto {
  taskId: string
  /** Technical title (secondary / technical mode only). */
  technicalTitle: string
  projectId: string | null
  featureId: string | null
  bucket: PrimaryBucket | null
  overlays: Array<StaleOverlayKind>
  blockReason: string | null
  lifecycleStage: string | null
  targetGate: string | null
  claimState: string | null
  ownerHumanDisplay: OwnerHumanDisplayUiProjection
}

export interface ProjectUiSummary {
  id: string
  name: string | null
  status: string | null
  taskCount: number
  /**
   * Distinct DONE task IDs under this project from current rollup assignments.
   * 0 when none are DONE; never invents DONE from phase/pct alone.
   */
  doneCount: number
  blockedCount: number
  /**
   * Mean readiness over distinct PRODUCT-class tasks with proven lifecycle stage.
   * null when no valid proof (never fake 0/100).
   */
  readinessPercent?: number | null
  /** Highest-weight proven lifecycle stage among PRODUCT tasks; null without proof. */
  readinessStage?: string | null
  /**
   * true when every readiness-eligible PRODUCT task carries pin-bound stage evidence;
   * false when any eligible task lacks evidence; null when no eligible tasks.
   */
  readinessEvidenceOk?: boolean | null
}

export interface FeatureUiSummary {
  id: string
  projectId: string | null
  name: string | null
  phase: string | null
  flowBranch: 'success' | 'fail' | 'expired' | 'open' | null
  taskCount: number
  /** Optional server-derived context — null/omit when source truth absent (never invent). */
  pageRoutes?: string[] | null
  apiEndpoints?: string[] | null
  logicRules?: string[] | null
  styleContext?: string[] | null
  dataContext?: string[] | null
  geoVariants?: string[] | null
  providerVariants?: string[] | null
  sideEffectsReadback?: string[] | null
}

export interface RunUiSummary {
  runId: string
  taskId: string | null
  agentId: string | null
  role: string | null
  model: string | null
  effort: string | null
  maskedAccount: string | null
  status: string | null
  startedAt: string | null
  heartbeatAt: string | null
  /** Distinct from heartbeat — null when only heartbeat timestamp exists (never mirrored for shape). */
  materialProgressAt: string | null
  productiveSubstate: ProductiveSubstate | null
  createdAt: string
  id: string
  /** Optional evidence path when present on run source. */
  evidenceLink?: string | null
  claimState?: string | null
  lockIds?: string[] | null
  controllerRunId?: string | null
  parentRunId?: string | null
}

export interface AccountUiSummary {
  maskedAccountId: string
  status: string | null
  providerKind: string | null
  effectiveInUse: number
  effectiveCap: number
  physicalSlotsDisplay: string | null
  quarantine: boolean
  reason: string | null
}

/**
 * Account-sync authority meta for Ops projection (C2).
 * Never uses boardRev as sourceRevision. No tokens/raw identity.
 */
export interface AccountSyncUiMeta {
  /** True only when a C2 AccountSyncSnapshot was the account source. */
  authoritative: boolean
  sourceRevision: number | null
  generatedAt: string | null
  stale: boolean
  staleReason: string | null
  /** Snapshot usableCapacity when authoritative; null when missing. */
  usableCapacity: number | null
  /** Multi-surface same-revision readback parity when known; null when unknown. */
  readbackParityOk: boolean | null
}

export interface AuditUiEvent {
  id: string
  createdAt: string
  kind: string
  actorId: string | null
  subjectId: string | null
  summary: string | null
  materialHash: string | null
  boardRev: number | null
}

export interface DispatchNextUi {
  selectedForNextDispatch: Array<{
    taskId: string
    rank: number
    selectionReason: string
    targetGate: string
    role: string
    priorityPortfolioId: string | null
  }>
  planId: string | null
  blockedReason: string | null
  soleSource: 'active_dispatch_plan'
}

export interface ControlCenterTaskInput extends RollupTaskInput {
  title?: string | null
  projectId?: string | null
  featureId?: string | null
  targetGate?: string | null
  agentId?: string | null
  role?: string | null
  model?: string | null
  effort?: string | null
  /** Raw account id — always masked before leaving this module. */
  accountRef?: string | null
  startedAt?: string | null
  heartbeatAt?: string | null
  materialProgressAt?: string | null
  evidenceLink?: string | null
  createdAt?: string | null
  priorityMembership?: boolean
}

export interface ControlCenterAggregationInput {
  pin: ControlCenterPin
  tasks: ReadonlyArray<ControlCenterTaskInput>
  g5Domains?: ReadonlyArray<G5DomainRecord>
  priorityPackets?: ReadonlyArray<PriorityPacket>
  projects?: ReadonlyArray<ProjectUiSummary>
  features?: ReadonlyArray<FeatureUiSummary>
  runs?: ReadonlyArray<RunUiSummary>
  accounts?: ReadonlyArray<AccountUiSummary>
  decisions?: ReadonlyArray<DecisionV3Record>
  auditEvents?: ReadonlyArray<AuditUiEvent>
  dispatchNext?: DispatchNextUi | null
  /** C2 account-sync authority for Ops fail-closed capacity (not boardRev). */
  accountSyncMeta?: AccountSyncUiMeta | null
  /** ISO now for classification expiry + age calc (injectable for tests). */
  now?: string
  /** Optional join graphs (fail-closed via computeRollupV3). */
  featureContractJoins?: RollupV3Result extends never ? never : Parameters<typeof computeRollupV3>[0]['featureContractJoins']
  nodeJoins?: Parameters<typeof computeRollupV3>[0]['nodeJoins']
  dependencyJoins?: Parameters<typeof computeRollupV3>[0]['dependencyJoins']
  primaryOwnership?: Parameters<typeof computeRollupV3>[0]['primaryOwnership']
  evidenceCompleteOverride?: boolean
  /** Section-level failures → partial surfaceState. */
  sectionErrors?: ReadonlyArray<{ section: string; code: string; message: string }>
  frontierStateWhenEmpty?: PriorityFrontierState
}

// ---------------------------------------------------------------------------
// Age / productive helpers (server clocks only — client may format relative)
// ---------------------------------------------------------------------------

export function ageSeconds(
  iso: string | null | undefined,
  nowMs: number,
): number | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (!Number.isFinite(ms)) return null
  return Math.max(0, Math.floor((nowMs - ms) / 1000))
}

/**
 * PRODUCTIVE / IDLE / STALLED from run liveness + material-progress age.
 * Thresholds are presentation policy only; bucket membership stays in rollup-v3.
 */
export function deriveProductiveSubstate(opts: {
  runLiveness?: RollupTaskInput['runLiveness']
  materialProgressAgeSeconds: number | null
  heartbeatAgeSeconds: number | null
  stalledMaterialAgeSeconds?: number
  idleHeartbeatAgeSeconds?: number
}): ProductiveSubstate {
  const stalledAt = opts.stalledMaterialAgeSeconds ?? 900
  const idleAt = opts.idleHeartbeatAgeSeconds ?? 120
  if (
    opts.runLiveness === 'STALLED' ||
    opts.runLiveness === 'EXPIRED' ||
    (opts.materialProgressAgeSeconds != null &&
      opts.materialProgressAgeSeconds >= stalledAt)
  ) {
    return 'STALLED'
  }
  if (
    opts.runLiveness === 'RUNNING' ||
    opts.runLiveness === 'STARTING'
  ) {
    if (
      opts.heartbeatAgeSeconds != null &&
      opts.heartbeatAgeSeconds >= idleAt &&
      (opts.materialProgressAgeSeconds == null ||
        opts.materialProgressAgeSeconds >= idleAt)
    ) {
      return 'IDLE'
    }
    return 'PRODUCTIVE'
  }
  if (
    opts.materialProgressAgeSeconds != null &&
    opts.materialProgressAgeSeconds >= idleAt
  ) {
    return 'IDLE'
  }
  return 'PRODUCTIVE'
}

/** Sort: stalled first → oldest material-progress age → task ID. */
export function compareOngoingZeroClick(a: OngoingUiRow, b: OngoingUiRow): number {
  const rank = (s: ProductiveSubstate) =>
    s === 'STALLED' ? 0 : s === 'IDLE' ? 1 : 2
  const ra = rank(a.productiveSubstate)
  const rb = rank(b.productiveSubstate)
  if (ra !== rb) return ra - rb
  const ma = a.materialProgressAgeSeconds
  const mb = b.materialProgressAgeSeconds
  // oldest material-progress first (larger age first); null ages last
  if (ma == null && mb != null) return 1
  if (ma != null && mb == null) return -1
  if (ma != null && mb != null && ma !== mb) return mb - ma
  return a.taskId.localeCompare(b.taskId)
}

// ---------------------------------------------------------------------------
// Sensitive field stripping (public-shaped subsets never carry secrets)
// ---------------------------------------------------------------------------

const FORBIDDEN_KEY_RE =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|rawIdentity|raw_identity|privateKey|clientSecret|bearer|x-cairn-token|credentials)$/i

/** Private decision bodies / free-text comments never ship on CC public-shaped rows. */
const PRIVATE_DECISION_KEYS = new Set([
  'comment',
  'privateComment',
  'decisionText',
  'ownerComment',
  'privateNotes',
])

export function stripSensitiveFields<T>(value: T, depth = 0): T {
  if (depth > 12) return value
  if (value == null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v) => stripSensitiveFields(v, depth + 1)) as T
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (FORBIDDEN_KEY_RE.test(k)) continue
    if (PRIVATE_DECISION_KEYS.has(k)) continue
    if (k === 'accountRef' || k === 'accountId' || k === 'rawAccount') {
      // force mask if residual
      out.maskedAccount =
        typeof v === 'string' ? maskAccountId(v) : v == null ? null : 'acc_****'
      continue
    }
    out[k] = stripSensitiveFields(v, depth + 1)
  }
  return out as T
}

export function maskAccountForUi(raw: string | null | undefined): string | null {
  return maskAccountRef(raw)
}

// ---------------------------------------------------------------------------
// Aggregation (single pin → all projections)
// ---------------------------------------------------------------------------

export interface ControlCenterAggregation {
  pin: ControlCenterPin
  tuple: PinnedRevisionTuple
  rollup: RollupV3Result
  priority: PriorityAllocationResult
  g5: G5Evaluation
  assignmentsByTaskId: Map<string, RollupV3Result['assignments'][number]>
  workRows: Array<WorkTaskUiRow>
  ongoing: Array<OngoingUiRow>
  decisions: Array<DecisionV3Record>
  projects: Array<ProjectUiSummary>
  features: Array<FeatureUiSummary>
  runs: Array<RunUiSummary>
  accounts: Array<AccountUiSummary>
  auditEvents: Array<AuditUiEvent>
  dispatchNext: DispatchNextUi
  sectionErrors: Array<{ section: string; code: string; message: string }>
  nowMs: number
  /** C2 account-sync authority meta (Ops); null when producer omitted. */
  accountSyncMeta: AccountSyncUiMeta | null
  /**
   * Pre-resolved owner humanDisplay by entity key `${kind}:${id}` (usually task:taskId).
   * Absent key → projectors fail-closed via resolveOwnerHumanDisplayUi(null, …).
   */
  humanDisplayByEntityKey?: Map<string, OwnerHumanDisplayUiProjection>
}

function emptyDispatchNext(): DispatchNextUi {
  return {
    selectedForNextDispatch: [],
    planId: null,
    blockedReason: null,
    soleSource: 'active_dispatch_plan',
  }
}

/**
 * Derive per-project doneCount + readiness from distinct task IDs + rollup assignments.
 * Never invents readiness 0/100 without pin-valid PRODUCT classification + lifecycle proof.
 */
export function enrichProjectsFromRollup(
  projects: ReadonlyArray<ProjectUiSummary>,
  tasks: ReadonlyArray<ControlCenterTaskInput>,
  assignmentsByTaskId: Map<string, RollupV3Result['assignments'][number]>,
  pin: PinnedRevisionTuple,
  now?: string,
): Array<ProjectUiSummary> {
  const tasksByProject = new Map<string, ControlCenterTaskInput[]>()
  for (const t of tasks) {
    const pid = t.projectId
    if (!pid) continue
    const list = tasksByProject.get(pid) ?? []
    list.push(t)
    tasksByProject.set(pid, list)
  }

  return projects.map((p) => {
    const projTasks = tasksByProject.get(p.id) ?? []
    const distinctIds = new Set(projTasks.map((t) => t.taskId))
    if (distinctIds.size === 0) {
      return {
        ...p,
        doneCount: p.doneCount,
        readinessPercent: p.readinessPercent ?? null,
        readinessStage: p.readinessStage ?? null,
        readinessEvidenceOk: p.readinessEvidenceOk ?? null,
      }
    }

    const doneIds = new Set<string>()
    for (const id of distinctIds) {
      if (assignmentsByTaskId.get(id)?.primary === 'DONE') doneIds.add(id)
    }

    const productWeights: number[] = []
    let maxStage: string | null = null
    let maxWeight = -1
    let evidenceOk: boolean | null = null
    for (const id of distinctIds) {
      const t = projTasks.find((x) => x.taskId === id)
      if (!t) continue
      // Pin-valid PRODUCT only — never treat invalid/mismatched receipts as readiness proof.
      const evaluation = evaluateClassification(t.classification, pin, { now })
      if (!evaluation.isFullyClassifiedValid || evaluation.taskClass !== 'PRODUCT') {
        continue
      }
      if (!t.lifecycleStage) continue
      const w = taskStageWeight(t.lifecycleStage)
      productWeights.push(w)
      if (w > maxWeight) {
        maxWeight = w
        maxStage = t.lifecycleStage
      }
      const hasEvidence = Boolean(t.evidence)
      if (evidenceOk === null) evidenceOk = hasEvidence
      else evidenceOk = evidenceOk && hasEvidence
    }

    return {
      ...p,
      doneCount: doneIds.size,
      readinessPercent: meanReadinessOneDecimal(productWeights),
      readinessStage: maxStage,
      readinessEvidenceOk: productWeights.length === 0 ? null : evidenceOk,
    }
  })
}

/** Statuses that must not contribute to usableCapacity for new dispatch. */
function accountStatusUsableForDispatch(status: string | null | undefined): boolean {
  if (!status) return false
  return contributesUsableCapacity(status as MaskedAccountStatus)
}

export function aggregateControlCenter(
  input: ControlCenterAggregationInput,
): ControlCenterAggregation {
  assertPinComplete(input.pin)
  const pin = input.pin
  const tuple = pinToTuple(pin)
  const nowIso = input.now ?? pin.generatedAt
  const nowMs = Date.parse(nowIso)
  const nowMsSafe = Number.isFinite(nowMs) ? nowMs : Date.now()

  const rollupTasks: Array<RollupTaskInput> = input.tasks.map((t) => ({
    taskId: t.taskId,
    classification: t.classification,
    lifecycleStage: t.lifecycleStage,
    evidence: t.evidence,
    claimState: t.claimState,
    runLiveness: t.runLiveness,
    hasBlockingDecision: t.hasBlockingDecision,
    hasNonBlockingDecision: t.hasNonBlockingDecision,
    hardBlocker: t.hardBlocker,
    selectedForNextDispatch: t.selectedForNextDispatch,
    eligible: t.eligible,
    staleDataSource: t.staleDataSource,
    staleDispatchPlan: t.staleDispatchPlan,
    staleAccountSync: t.staleAccountSync,
    productStageMode: t.productStageMode,
    p0Blocker: t.p0Blocker,
  }))

  const rollup = computeRollupV3({
    pin: tuple,
    tasks: rollupTasks,
    g5Domains: input.g5Domains ?? [],
    featureContractJoins: input.featureContractJoins,
    nodeJoins: input.nodeJoins,
    dependencyJoins: input.dependencyJoins,
    primaryOwnership: input.primaryOwnership,
    now: nowIso,
    evidenceCompleteOverride: input.evidenceCompleteOverride,
  })

  const assignmentsByTaskId = new Map(
    rollup.assignments.map((a) => [a.taskId, a] as const),
  )

  const priority = computePriorityAllocation({
    pin: tuple,
    tasks: input.tasks.map((t) => ({
      taskId: t.taskId,
      classification: t.classification,
      priorityMembership: t.priorityMembership,
    })),
    packets: input.priorityPackets ?? [],
    frontierStateWhenEmpty: input.frontierStateWhenEmpty,
    now: nowIso,
  })

  const g5 = evaluateG5(input.g5Domains ?? [], tuple)

  const taskById = new Map(input.tasks.map((t) => [t.taskId, t] as const))

  const workRows: Array<WorkTaskUiRow> = []
  for (const taskId of rollup.trackedTaskIds) {
    const t = taskById.get(taskId)
    const a = assignmentsByTaskId.get(taskId)
    // claimState is drilldown metadata only — never a client bucket authority.
    // Validated enum or null (missing/invalid already fail-closed upstream).
    const claimState =
      typeof t?.claimState === 'string' && t.claimState.length > 0 ? t.claimState : null
    workRows.push({
      taskId,
      title: t?.title ?? taskId,
      projectId: t?.projectId ?? null,
      featureId: t?.featureId ?? null,
      bucket: a?.primary ?? null,
      overlays: a ? [...a.overlays] : [],
      blockReason: a?.blockReason ?? null,
      outsideTracked: a?.outsideTracked ?? false,
      lifecycleStage: t?.lifecycleStage ?? null,
      targetGate: t?.targetGate ?? null,
      claimState,
      createdAt: t?.createdAt ?? pin.generatedAt,
      id: taskId,
    })
  }
  // Deterministic work order by taskId for stable cursor when createdAt ties.
  workRows.sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })

  const ongoing: Array<OngoingUiRow> = []
  for (const a of rollup.assignments) {
    if (a.primary !== 'ONGOING') continue
    const t = taskById.get(a.taskId)
    const heartbeatAge = ageSeconds(t?.heartbeatAt, nowMsSafe)
    const materialAge = ageSeconds(t?.materialProgressAt, nowMsSafe)
    const startedAge = ageSeconds(t?.startedAt, nowMsSafe)
    const productiveSubstate = deriveProductiveSubstate({
      runLiveness: t?.runLiveness,
      materialProgressAgeSeconds: materialAge,
      heartbeatAgeSeconds: heartbeatAge,
    })
    ongoing.push({
      taskId: a.taskId,
      title: t?.title ?? a.taskId,
      targetGate: t?.targetGate ?? t?.lifecycleStage ?? 'UNKNOWN',
      agentId: t?.agentId ?? 'unknown',
      role: t?.role ?? 'unknown',
      model: t?.model ?? null,
      effort: t?.effort ?? null,
      maskedAccount: maskAccountForUi(t?.accountRef),
      startedAt: t?.startedAt ?? null,
      startedAgeSeconds: startedAge,
      heartbeatAt: t?.heartbeatAt ?? null,
      heartbeatAgeSeconds: heartbeatAge,
      materialProgressAt: t?.materialProgressAt ?? null,
      materialProgressAgeSeconds: materialAge,
      productiveSubstate,
      evidenceLink: t?.evidenceLink ?? null,
      bucket: 'ONGOING',
      overlays: [...a.overlays],
    })
  }
  ongoing.sort(compareOngoingZeroClick)

  const decisions = [...(input.decisions ?? [])]
    .filter((d) => isVisibleInInbox(d, nowMsSafe))
    .sort(compareDecisionsV3)

  const accounts = (input.accounts ?? []).map((a) => ({
    ...a,
    // Re-mask even if caller already sent masked id (defense in depth).
    maskedAccountId:
      a.maskedAccountId.startsWith('acc_')
        ? a.maskedAccountId
        : maskAccountId(a.maskedAccountId),
  }))

  const runs = (input.runs ?? []).map((r) => ({
    ...r,
    maskedAccount: r.maskedAccount
      ? r.maskedAccount.startsWith('acc_')
        ? r.maskedAccount
        : maskAccountId(r.maskedAccount)
      : null,
    id: r.id || r.runId,
    createdAt: r.createdAt || r.startedAt || pin.generatedAt,
  }))

  const auditEvents = [...(input.auditEvents ?? [])].sort((a, b) => {
    if (a.createdAt !== b.createdAt) return a.createdAt < b.createdAt ? 1 : -1
    return a.id < b.id ? 1 : a.id > b.id ? -1 : 0
  })

  const projects = enrichProjectsFromRollup(
    input.projects ?? [],
    input.tasks,
    assignmentsByTaskId,
    tuple,
    nowIso,
  )

  return {
    pin,
    tuple,
    rollup,
    priority,
    g5,
    assignmentsByTaskId,
    workRows,
    ongoing,
    decisions,
    projects,
    features: [...(input.features ?? [])],
    runs,
    accounts,
    auditEvents,
    dispatchNext: input.dispatchNext ?? emptyDispatchNext(),
    sectionErrors: [...(input.sectionErrors ?? [])],
    nowMs: nowMsSafe,
    accountSyncMeta: input.accountSyncMeta ?? null,
  }
}

// ---------------------------------------------------------------------------
// Owner humanDisplay projection (fail-closed CONTENT_REVIEW_REQUIRED)
// ---------------------------------------------------------------------------

export function humanDisplayEntityKey(
  entityKind: HumanDisplayEntityKind,
  entityId: string,
): string {
  return `${entityKind}:${entityId}`
}

/**
 * Project resolveOwnerHumanDisplay into a UI DTO field set.
 * Never promotes raw technical title as owner primary.
 */
export function projectOwnerHumanDisplayUi(
  display: HumanDisplayV1 | null | undefined,
  live: HumanDisplayLivePin,
  opts: { entityKind: HumanDisplayEntityKind; entityId: string },
): OwnerHumanDisplayUiProjection {
  const resolved = resolveOwnerHumanDisplay(display, live, opts)
  const contentReviewRequired =
    resolved.evaluation.releaseBlocker === 'CONTENT_REVIEW_REQUIRED' ||
    resolved.primary == null
  const ownerFacing = resolved.primary ?? resolved.blockedShell
  return {
    primary: resolved.primary,
    blockedShell: resolved.blockedShell,
    effectiveReviewStatus: resolved.evaluation.effectiveReviewStatus,
    contentReviewRequired,
    ownerPrimaryTitle: ownerFacing.title,
    statusSentence: ownerFacing.current,
    ownerAction: ownerFacing.ownerAction,
    whyItMatters: ownerFacing.why,
    next: ownerFacing.next,
    blocker: ownerFacing.blocker,
    citations: [...ownerFacing.citations],
    acceptanceLinks: [...ownerFacing.acceptanceLinks],
    missionQuestionLinks: [...ownerFacing.missionQuestionLinks],
    pin: {
      snapshotId: ownerFacing.snapshotId ?? live.canonicalSnapshotId ?? null,
      boardRev:
        typeof ownerFacing.boardRev === 'number'
          ? ownerFacing.boardRev
          : (live.boardRev ?? null),
      lifecycleRev:
        typeof ownerFacing.lifecycleRev === 'number'
          ? ownerFacing.lifecycleRev
          : (live.lifecycleRev ?? null),
      canonicalHash:
        ownerFacing.canonicalHash ?? live.canonicalHash ?? null,
      sourceHash: ownerFacing.sourceHash || live.liveSourceHash || '',
    },
  }
}

/** Live pin from control-center pin + optional live source hash. */
export function livePinFromControlCenter(
  pin: ControlCenterPin,
  liveSourceHash?: string | null,
): HumanDisplayLivePin {
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    liveSourceHash:
      (typeof liveSourceHash === 'string' && liveSourceHash.length > 0
        ? liveSourceHash
        : null) ??
      pin.canonicalHash ??
      '',
  }
}

/**
 * Lookup or fail-closed owner HD for a task entity.
 * Missing map / missing key → CONTENT_REVIEW_REQUIRED blockedShell (never technical title).
 */
export function resolveTaskOwnerHumanDisplay(
  agg: Pick<ControlCenterAggregation, 'pin' | 'humanDisplayByEntityKey'>,
  taskId: string,
): OwnerHumanDisplayUiProjection {
  const key = humanDisplayEntityKey('task', taskId)
  const hit = agg.humanDisplayByEntityKey?.get(key)
  if (hit) return hit
  return projectOwnerHumanDisplayUi(null, livePinFromControlCenter(agg.pin), {
    entityKind: 'task',
    entityId: taskId,
  })
}

/**
 * Attach ownerHumanDisplay onto work + ongoing rows (mutates copies).
 * Technical `title` remains for technical mode; owner primary uses ownerHumanDisplay.
 */
export function attachOwnerHumanDisplayToWorkSurfaces(
  agg: ControlCenterAggregation,
): ControlCenterAggregation {
  const workRows = agg.workRows.map((row) => ({
    ...row,
    ownerHumanDisplay: resolveTaskOwnerHumanDisplay(agg, row.taskId),
  }))
  const ongoing = agg.ongoing.map((row) => ({
    ...row,
    ownerHumanDisplay: resolveTaskOwnerHumanDisplay(agg, row.taskId),
  }))
  return { ...agg, workRows, ongoing }
}

/** Task detail DTO for a single task id (fail-closed humanDisplay). */
export function projectTaskDetail(
  agg: ControlCenterAggregation,
  taskId: string,
): TaskDetailUiDto | null {
  const row =
    agg.workRows.find((r) => r.taskId === taskId) ??
    null
  const ownerHumanDisplay = resolveTaskOwnerHumanDisplay(agg, taskId)
  if (!row) {
    // Task may only appear on ongoing / outside work list — still project fail-closed HD.
    const ongoing = agg.ongoing.find((o) => o.taskId === taskId)
    if (!ongoing && !agg.assignmentsByTaskId.has(taskId)) return null
    return {
      taskId,
      technicalTitle: ongoing?.title ?? taskId,
      projectId: null,
      featureId: null,
      bucket: ongoing ? 'ONGOING' : (agg.assignmentsByTaskId.get(taskId)?.primary ?? null),
      overlays: ongoing
        ? [...ongoing.overlays]
        : [...(agg.assignmentsByTaskId.get(taskId)?.overlays ?? [])],
      blockReason: agg.assignmentsByTaskId.get(taskId)?.blockReason ?? null,
      lifecycleStage: null,
      targetGate: ongoing?.targetGate ?? null,
      claimState: null,
      ownerHumanDisplay,
    }
  }
  return {
    taskId: row.taskId,
    technicalTitle: row.title,
    projectId: row.projectId,
    featureId: row.featureId,
    bucket: row.bucket,
    overlays: [...row.overlays],
    blockReason: row.blockReason,
    lifecycleStage: row.lifecycleStage,
    targetGate: row.targetGate,
    claimState: row.claimState,
    ownerHumanDisplay,
  }
}

// ---------------------------------------------------------------------------
// Surface data shapes
// ---------------------------------------------------------------------------

export interface OverviewLifecycleStageCount {
  stage: string
  count: number
}

export interface OverviewData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  buckets: RollupV3Result['buckets']
  overlays: RollupV3Result['overlays']
  trackedWorkDenominator: number
  productDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  unclassifiedCount: number
  g5Pass: boolean
  complete: boolean
  rawTaskReadinessPercent: number | null
  boardReadinessPercent: number | null
  cappedBy: RollupV3Result['cappedBy']
  priority: PriorityAllocationResult
  g5: Pick<G5Evaluation, 'g5Pass' | 'domainResults' | 'missingDomains'>
  dispatchNext: DispatchNextUi
  ongoing: Array<OngoingUiRow>
  decisionCount: number
  topDecision: {
    decisionId: string
    severity: string
    blocking: boolean
    title: string
    status: string
    /** Real DecisionV3.question when present — never synthesized from title. */
    question: string | null
  } | null
  needsHuman: boolean
  projects: Array<ProjectUiSummary>
  sectionErrors: Array<{ section: string; code: string; message: string }>
  /**
   * Lifecycle stage histogram for Overview lower panel (server-built).
   * Prefer over client re-derivation when present (may be empty honestly).
   */
  lifecycle?: Array<OverviewLifecycleStageCount>
  /**
   * Material audit/events for Overview lower panel (from durable audit sources).
   * Empty array = honestly empty; never invents activity.
   */
  materialEvents?: Array<AuditUiEvent>
  /** Alias wire for older projectors — same rows as materialEvents. */
  auditEvents?: Array<AuditUiEvent>
}

export interface WorkData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  buckets: RollupV3Result['buckets']
  overlays: RollupV3Result['overlays']
  trackedWorkDenominator: number
  filter: {
    bucket: PrimaryBucket | null
    overlay: StaleOverlayKind | null
    staleFamily: boolean | null
  }
  items: Array<WorkTaskUiRow>
  pageSize: number
  dispatchNext: DispatchNextUi
}

export interface PriorityData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  priority: PriorityAllocationResult
  /** Exact N-A presentation when majority/share null. */
  majorityAllocationDisplay: 'true' | 'false' | 'N-A'
  priorityCapacityShareDisplay: string
  g5Pass: boolean
  productDenominator: number
  membershipDenominator: number
  nonPriorityAllowedReasons: ReadonlyArray<string>
}

export interface ProjectsData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  projects: Array<ProjectUiSummary>
  productDenominator: number
  buckets: RollupV3Result['buckets']
}

export interface FeaturesData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  features: Array<FeatureUiSummary>
  items: Array<FeatureUiSummary>
  pageSize: number
}

export interface AgentsData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  runs: Array<RunUiSummary>
  items: Array<RunUiSummary>
  pageSize: number
  ongoing: Array<OngoingUiRow>
}

export interface OpsData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  accounts: Array<AccountUiSummary>
  usableCapacity: number
  quarantineCount: number
  accountSyncStale: boolean
  /** Never includes tokens / raw identity. */
  capacityNote: string | null
  /**
   * C2 AccountSyncSnapshot.sourceRevision — never boardRev.
   * null when no authoritative account-sync snapshot.
   */
  sourceRevision?: number | null
  /** Account-sync generatedAt (distinct from board pin generatedAt). */
  accountGeneratedAt?: string | null
  /** Age of account-sync generatedAt vs pin now; null when unknown. */
  accountFreshnessAgeSeconds?: number | null
  accountStaleReason?: string | null
  /** Multi-surface same-revision parity when known. */
  readbackParityOk?: boolean | null
}

/** Public option subset for authenticated Decisions UI (no authority-broadening flags). */
export interface DecisionOptionUiRow {
  optionId: string
  label: string
  tradeoffs: string | null
  /** Declining option selected ⇒ RESOLVED, not REJECTED. */
  declining: boolean
}

/**
 * Authenticated owner DecisionV3 projection row.
 * Never includes private `comment` / secrets. Absent fields are null/[] — never invented.
 */
export interface DecisionUiRow {
  decisionId: string
  severity: string
  blocking: boolean
  title: string
  status: string
  dueAt: string | null
  createdAt: string
  snoozedUntil: string | null
  type: string
  question: string | null
  evidence: string[]
  options: DecisionOptionUiRow[]
  agentRecommendation: string | null
  ownerId: string | null
  resolverId: string | null
  selectedOptionId: string | null
  expectedRev: number | null
  boardRev: number | null
  entityRev: number | null
  scopedApprovalId: string | null
  auditIds: string[]
  projectId: string | null
  featureId: string | null
  taskId: string | null
  runId: string | null
  /**
   * Owner humanDisplay for the decision surface (fail-closed shell when no
   * reviewed content). Never promotes raw technical decision title as owner primary.
   */
  ownerHumanDisplay?: OwnerHumanDisplayUiProjection | null
}

export interface DecisionsData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  decisions: Array<DecisionUiRow>
  items: Array<DecisionUiRow & { id: string }>
  pageSize: number
  openCount: number
  blockingCount: number
}

export interface EvidenceData {
  surfaceVersion: typeof CONTROL_CENTER_UI_SURFACE_VERSION
  events: Array<AuditUiEvent>
  items: Array<AuditUiEvent>
  pageSize: number
}

// ---------------------------------------------------------------------------
// Projectors (same pin identity on every surface)
// ---------------------------------------------------------------------------

function baseSurfaceState(agg: ControlCenterAggregation): UiSurfaceState {
  if (agg.sectionErrors.length > 0) return 'partial'
  if (agg.pin.stale) return 'stale'
  return 'populated'
}

function withEmptyIfZero(
  state: UiSurfaceState,
  count: number,
  filterActive: boolean,
): UiSurfaceState {
  if (state === 'error' || state === 'disconnected' || state === 'forbidden') {
    return state
  }
  if (count === 0) return filterActive ? 'zero-results' : 'empty'
  return state
}

/**
 * Build lifecycle stage counts from project readinessStage (+ taskCount weight).
 * Empty when no proven stages — never invents MAP_VERIFIED/etc.
 * Prefer buildOverviewLifecycleFromTasks for owner progress visibility.
 */
export function buildOverviewLifecycleFromProjects(
  projects: ReadonlyArray<ProjectUiSummary>,
): Array<OverviewLifecycleStageCount> {
  const counts = new Map<string, number>()
  for (const pr of projects) {
    const stage =
      typeof pr.readinessStage === 'string' && pr.readinessStage.length > 0
        ? pr.readinessStage
        : null
    if (!stage) continue
    const weight =
      typeof pr.taskCount === 'number' && Number.isFinite(pr.taskCount) ? pr.taskCount : 1
    counts.set(stage, (counts.get(stage) ?? 0) + weight)
  }
  return [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => a.stage.localeCompare(b.stage))
}

/**
 * Build lifecycle stage histogram from distinct work-row lifecycle stages.
 * This is the owner-visible mapping/delivery progress (MAPPED, MAP_VERIFIED, …).
 * Empty when no task carries a proven stage — never invents stages.
 */
export function buildOverviewLifecycleFromTasks(
  rows: ReadonlyArray<{ lifecycleStage?: string | null }>,
): Array<OverviewLifecycleStageCount> {
  const counts = new Map<string, number>()
  for (const row of rows) {
    const stage =
      typeof row.lifecycleStage === 'string' && row.lifecycleStage.length > 0
        ? row.lifecycleStage
        : null
    if (!stage) continue
    counts.set(stage, (counts.get(stage) ?? 0) + 1)
  }
  return [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => a.stage.localeCompare(b.stage))
}

/**
 * Prefer task-stage histogram (lifecycle truth) over project PRODUCT readinessStage.
 * Project-only readiness is often empty while Stage-1 MAP_VERIFIED advances, which
 * previously rendered Overview as "No lifecycle rollup" despite real progress.
 */
export function buildOverviewLifecycle(
  agg: Pick<ControlCenterAggregation, 'workRows' | 'projects'>,
): Array<OverviewLifecycleStageCount> {
  const fromTasks = buildOverviewLifecycleFromTasks(agg.workRows)
  if (fromTasks.length > 0) return fromTasks
  return buildOverviewLifecycleFromProjects(agg.projects)
}

export function projectOverview(
  agg: ControlCenterAggregation,
): PinnedEnvelope<OverviewData> {
  const top = agg.decisions[0] ?? null
  const needsHuman = agg.decisions.some(
    (d) => d.blocking && (d.status === 'OPEN' || d.status === 'ACKNOWLEDGED'),
  )
  const lifecycle = buildOverviewLifecycle(agg)
  const materialEvents = agg.auditEvents.map((e) => ({ ...e }))
  const data: OverviewData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    buckets: { ...agg.rollup.buckets },
    overlays: { ...agg.rollup.overlays },
    trackedWorkDenominator: agg.rollup.trackedWorkDenominator,
    productDenominator: agg.rollup.productDenominator,
    stageProdReady: agg.rollup.stageProdReady,
    prodReadyWithEvidence: agg.rollup.prodReadyWithEvidence,
    unclassifiedCount: agg.rollup.unclassifiedCount,
    g5Pass: agg.rollup.g5Pass,
    complete: agg.rollup.complete,
    rawTaskReadinessPercent: agg.rollup.rawTaskReadinessPercent,
    boardReadinessPercent: agg.rollup.boardReadinessPercent,
    cappedBy: agg.rollup.cappedBy,
    priority: { ...agg.priority, membershipTaskIds: [...agg.priority.membershipTaskIds] },
    g5: {
      g5Pass: agg.g5.g5Pass,
      domainResults: agg.g5.domainResults.map((d) => ({ ...d })),
      missingDomains: [...agg.g5.missingDomains],
    },
    dispatchNext: agg.dispatchNext,
    ongoing: agg.ongoing.map((o) => ({
      ...o,
      overlays: [...o.overlays],
      ownerHumanDisplay:
        o.ownerHumanDisplay ?? resolveTaskOwnerHumanDisplay(agg, o.taskId),
    })),
    decisionCount: agg.decisions.length,
    topDecision: top
      ? {
          decisionId: top.decisionId,
          severity: top.severity,
          blocking: top.blocking,
          title: top.title,
          status: top.status,
          question: top.question ? top.question : null,
        }
      : null,
    needsHuman,
    projects: agg.projects.map((p) => ({ ...p })),
    sectionErrors: [...agg.sectionErrors],
    lifecycle,
    materialEvents,
    auditEvents: materialEvents,
  })
  let surfaceState = baseSurfaceState(agg)
  if (needsHuman && surfaceState === 'populated') surfaceState = 'needs-human'
  if (
    !needsHuman &&
    agg.rollup.trackedWorkDenominator === 0 &&
    agg.decisions.length === 0 &&
    agg.ongoing.length === 0
  ) {
    surfaceState = surfaceState === 'partial' || surfaceState === 'stale' ? surfaceState : 'empty'
  }
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'overview',
    surfaceState,
    nextCursor: null,
  })
}

export function projectWork(
  agg: ControlCenterAggregation,
  opts: {
    bucket?: PrimaryBucket | null
    overlay?: StaleOverlayKind | null
    staleFamily?: boolean | null
    cursor?: string | null
    pageSize?: number | null
  } = {},
): PinnedEnvelope<WorkData> {
  const bucket = opts.bucket ?? null
  const overlay = opts.overlay ?? null
  const staleFamily = opts.staleFamily ?? null
  let filtered = agg.workRows
  if (bucket) filtered = filtered.filter((r) => r.bucket === bucket)
  if (staleFamily) filtered = filtered.filter((r) => r.overlays.some(isStaleFamilyOverlay))
  if (overlay) filtered = filtered.filter((r) => r.overlays.includes(overlay))

  const page = paginateDesc(filtered, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
    expectedBoardRev: agg.pin.boardRev,
    expectedSnapshotRev: agg.pin.canonicalSnapshotId,
  })

  const data: WorkData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    buckets: { ...agg.rollup.buckets },
    overlays: { ...agg.rollup.overlays },
    trackedWorkDenominator: agg.rollup.trackedWorkDenominator,
    filter: { bucket, overlay, staleFamily },
    items: page.items.map((i) => ({
      ...i,
      overlays: [...i.overlays],
      ownerHumanDisplay:
        i.ownerHumanDisplay ?? resolveTaskOwnerHumanDisplay(agg, i.taskId),
    })),
    pageSize: page.pageSize,
    dispatchNext: agg.dispatchNext,
  })

  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(
    surfaceState,
    page.items.length,
    bucket != null || overlay != null || staleFamily === true,
  )
  if (agg.workRows.length === 0 && !bucket && !overlay && !staleFamily) {
    surfaceState = surfaceState === 'partial' || surfaceState === 'stale' ? surfaceState : 'empty'
  }

  return createPinnedEnvelope(agg.pin, data, {
    surface: 'work',
    surfaceState,
    nextCursor: page.nextCursor,
  })
}

const NON_PRIORITY_ALLOWED_REASONS = [
  'STRICT_DIRECT_DEPENDENCY',
  'NON_DELAYING_SPARE_CAPACITY',
  'PRIORITY_FRONTIER_BLOCKED',
  'PRIORITY_FRONTIER_EXHAUSTED',
] as const

export function projectPriority(
  agg: ControlCenterAggregation,
): PinnedEnvelope<PriorityData> {
  const p = agg.priority
  const majorityAllocationDisplay: PriorityData['majorityAllocationDisplay'] =
    p.majorityAllocationPass === null
      ? 'N-A'
      : p.majorityAllocationPass
        ? 'true'
        : 'false'
  const priorityCapacityShareDisplay =
    p.priorityCapacityShare === null
      ? 'N-A'
      : String(p.priorityCapacityShare)

  const data: PriorityData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    priority: {
      ...p,
      membershipTaskIds: [...p.membershipTaskIds],
    },
    majorityAllocationDisplay,
    priorityCapacityShareDisplay,
    g5Pass: agg.rollup.g5Pass,
    productDenominator: agg.rollup.productDenominator,
    membershipDenominator: p.membershipDenominator,
    nonPriorityAllowedReasons: [...NON_PRIORITY_ALLOWED_REASONS],
  })

  let surfaceState = baseSurfaceState(agg)
  if (p.membershipDenominator === 0 && surfaceState === 'populated') {
    surfaceState = 'empty'
  }

  return createPinnedEnvelope(agg.pin, data, {
    surface: 'priority',
    surfaceState,
    nextCursor: null,
  })
}

export function projectProjects(
  agg: ControlCenterAggregation,
): PinnedEnvelope<ProjectsData> {
  const data: ProjectsData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    projects: agg.projects.map((p) => ({ ...p })),
    productDenominator: agg.rollup.productDenominator,
    buckets: { ...agg.rollup.buckets },
  })
  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(surfaceState, agg.projects.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'projects',
    surfaceState,
    nextCursor: null,
  })
}

export function projectFeatures(
  agg: ControlCenterAggregation,
  opts: { cursor?: string | null; pageSize?: number | null } = {},
): PinnedEnvelope<FeaturesData> {
  const rows = agg.features.map((f) => ({
    ...f,
    createdAt: agg.pin.generatedAt,
    id: f.id,
  }))
  const page = paginateDesc(rows, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
    expectedBoardRev: agg.pin.boardRev,
    expectedSnapshotRev: agg.pin.canonicalSnapshotId,
  })
  const data: FeaturesData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    features: agg.features.map((f) => ({ ...f })),
    items: page.items.map(({ createdAt: _c, id: _i, ...rest }) => rest as FeatureUiSummary),
    pageSize: page.pageSize,
  })
  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(surfaceState, page.items.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'features',
    surfaceState,
    nextCursor: page.nextCursor,
  })
}

export function projectAgents(
  agg: ControlCenterAggregation,
  opts: { cursor?: string | null; pageSize?: number | null } = {},
): PinnedEnvelope<AgentsData> {
  const page = paginateDesc(agg.runs, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
    expectedBoardRev: agg.pin.boardRev,
    expectedSnapshotRev: agg.pin.canonicalSnapshotId,
  })
  const data: AgentsData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    runs: page.items.map((r) => ({ ...r })),
    items: page.items.map((r) => ({ ...r })),
    pageSize: page.pageSize,
    ongoing: agg.ongoing.map((o) => ({
      ...o,
      overlays: [...o.overlays],
      ownerHumanDisplay:
        o.ownerHumanDisplay ?? resolveTaskOwnerHumanDisplay(agg, o.taskId),
    })),
  })
  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(surfaceState, page.items.length + agg.ongoing.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'agents',
    surfaceState,
    nextCursor: page.nextCursor,
  })
}

export function projectOps(
  agg: ControlCenterAggregation,
): PinnedEnvelope<OpsData> {
  const quarantineCount = agg.accounts.filter(
    (a) =>
      a.quarantine ||
      a.status === 'QUARANTINED' ||
      a.status === 'REMOVED' ||
      a.status === 'quarantine',
  ).length

  const meta = agg.accountSyncMeta
  // Fail-closed: missing authority, stale snapshot, invalid parity, or STALE_ACCOUNT_SYNC overlay.
  const noAuthority = !meta || !meta.authoritative
  const parityInvalid = meta?.readbackParityOk === false
  const accountSyncStale =
    noAuthority ||
    Boolean(meta?.stale) ||
    parityInvalid ||
    Boolean(agg.rollup.overlays.STALE_ACCOUNT_SYNC)

  let usableCapacity = 0
  if (!accountSyncStale) {
    if (typeof meta?.usableCapacity === 'number' && Number.isFinite(meta.usableCapacity)) {
      // Prefer C2 snapshot usableCapacity when authoritative and fresh.
      usableCapacity = Math.max(0, meta.usableCapacity)
    } else {
      // Sum only ACTIVE/OK (exclude LIMIT/BAN/403/AUTH_EXPIRED/quarantine/REMOVED).
      usableCapacity = agg.accounts.reduce((sum, a) => {
        if (a.quarantine) return sum
        if (!accountStatusUsableForDispatch(a.status)) return sum
        return sum + Math.max(0, a.effectiveCap - a.effectiveInUse)
      }, 0)
    }
  }

  const accountFreshnessAgeSeconds =
    meta?.generatedAt != null ? ageSeconds(meta.generatedAt, agg.nowMs) : null

  const data: OpsData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    accounts: agg.accounts.map((a) => ({ ...a })),
    usableCapacity,
    quarantineCount,
    accountSyncStale,
    capacityNote: accountSyncStale
      ? meta?.staleReason ??
        (noAuthority ? 'ACCOUNT_SYNC_MISSING' : parityInvalid ? 'ACCOUNT_SYNC_PARITY_INVALID' : null)
      : null,
    sourceRevision: meta?.sourceRevision ?? null,
    accountGeneratedAt: meta?.generatedAt ?? null,
    accountFreshnessAgeSeconds,
    accountStaleReason: accountSyncStale
      ? meta?.staleReason ?? (noAuthority ? 'ACCOUNT_SYNC_MISSING' : null)
      : meta?.staleReason ?? null,
    readbackParityOk: meta?.readbackParityOk ?? null,
  })
  let surfaceState = baseSurfaceState(agg)
  if (accountSyncStale && surfaceState === 'populated') {
    surfaceState = 'stale'
  }
  surfaceState = withEmptyIfZero(surfaceState, agg.accounts.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'ops',
    surfaceState,
    nextCursor: null,
  })
}

/**
 * Map DecisionV3 → authenticated public UI row.
 * Omits private comment and authority-broadening option flags. Never invents dates/ids.
 * Owner humanDisplay: fail-closed CONTENT_REVIEW_REQUIRED shell when no reviewed copy —
 * never promotes raw technical decision title as owner primary.
 */
export function projectDecisionUiRow(
  d: DecisionV3Record,
  opts?: {
    pin?: ControlCenterPin
    humanDisplayByEntityKey?: Map<string, OwnerHumanDisplayUiProjection>
  },
): DecisionUiRow {
  const question =
    typeof d.question === 'string' && d.question.length > 0 ? d.question : null
  const agentRecommendation =
    typeof d.agentRecommendation === 'string' && d.agentRecommendation.length > 0
      ? d.agentRecommendation
      : d.agentRecommendation === null || d.agentRecommendation === undefined
        ? null
        : String(d.agentRecommendation)

  // Prefer linked task HD when present; else fail-closed shell for decision id.
  let ownerHumanDisplay: OwnerHumanDisplayUiProjection | null = null
  if (opts?.pin) {
    const taskId =
      typeof d.taskId === 'string' && d.taskId.length > 0 ? d.taskId : null
    if (taskId) {
      const key = humanDisplayEntityKey('task', taskId)
      ownerHumanDisplay =
        opts.humanDisplayByEntityKey?.get(key) ??
        projectOwnerHumanDisplayUi(null, livePinFromControlCenter(opts.pin), {
          entityKind: 'task',
          entityId: taskId,
        })
    } else {
      ownerHumanDisplay = projectOwnerHumanDisplayUi(
        null,
        livePinFromControlCenter(opts.pin),
        { entityKind: 'task', entityId: d.decisionId },
      )
    }
  }

  return {
    decisionId: d.decisionId,
    severity: d.severity,
    blocking: d.blocking,
    title: d.title,
    status: d.status,
    dueAt: d.dueAt ?? null,
    createdAt: d.createdAt,
    snoozedUntil: d.snoozedUntil ?? null,
    type: d.type ?? '',
    question,
    evidence: Array.isArray(d.evidence) ? d.evidence.map(String) : [],
    options: (d.options ?? []).map((o) => ({
      optionId: o.optionId,
      label: o.label,
      tradeoffs: o.tradeoffs ?? null,
      declining: Boolean(o.declining),
    })),
    agentRecommendation,
    ownerId: d.ownerId ?? null,
    resolverId: d.resolverId ?? null,
    selectedOptionId: d.selectedOptionId ?? null,
    expectedRev: typeof d.expectedRev === 'number' ? d.expectedRev : null,
    boardRev: typeof d.boardRev === 'number' ? d.boardRev : null,
    entityRev: typeof d.entityRev === 'number' ? d.entityRev : null,
    scopedApprovalId: d.scopedApprovalId ?? null,
    auditIds: Array.isArray(d.auditIds) ? d.auditIds.map(String) : [],
    projectId: d.projectId ?? null,
    featureId: d.featureId ?? null,
    taskId: d.taskId ?? null,
    runId: d.runId ?? null,
    ownerHumanDisplay,
  }
}

export function projectDecisions(
  agg: ControlCenterAggregation,
  opts: { cursor?: string | null; pageSize?: number | null } = {},
): PinnedEnvelope<DecisionsData> {
  const rows: Array<DecisionUiRow & { id: string }> = agg.decisions.map((d) => ({
    ...projectDecisionUiRow(d, {
      pin: agg.pin,
      humanDisplayByEntityKey: agg.humanDisplayByEntityKey,
    }),
    id: d.decisionId,
  }))
  // Decision order is compareDecisionsV3 (not createdAt DESC). Paginate by array index
  // using opaque cursor still pinned to boardRev/snapshot — encode position via createdAt+id
  // of last served row but slice in decision order.
  const pageSize =
    opts.pageSize === undefined || opts.pageSize === null
      ? DEFAULT_PAGE_SIZE
      : opts.pageSize
  if (
    typeof pageSize !== 'number' ||
    !Number.isInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > MAX_PAGE_SIZE
  ) {
    throw new DomainError('INVALID_INPUT', `pageSize must be integer 1..${MAX_PAGE_SIZE}`)
  }

  // Use paginateDesc on a synthetic createdAt that preserves decision order:
  // reverse-index so earlier (higher priority) rows have "newer" synthetic timestamps.
  const ordered = rows.map((r, index) => ({
    ...r,
    // Higher priority → larger synthetic createdAt for DESC page walks.
    createdAt: `${String(1_000_000_000 - index).padStart(12, '0')}`,
  }))
  const page = paginateDesc(ordered, {
    cursor: opts.cursor,
    pageSize,
    expectedBoardRev: agg.pin.boardRev,
    expectedSnapshotRev: agg.pin.canonicalSnapshotId,
  })

  const items = page.items.map(({ id: _id, createdAt: synth, ...rest }) => {
    const original = rows.find((r) => r.decisionId === rest.decisionId)!
    return {
      ...rest,
      createdAt: original.createdAt,
      id: rest.decisionId,
    }
  })

  const data: DecisionsData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    decisions: rows.map(({ id: _i, ...d }) => d),
    items,
    pageSize: page.pageSize,
    openCount: agg.decisions.filter(
      (d) => d.status === 'OPEN' || d.status === 'ACKNOWLEDGED',
    ).length,
    blockingCount: agg.decisions.filter((d) => d.blocking).length,
  })

  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(surfaceState, items.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'decisions',
    surfaceState,
    nextCursor: page.nextCursor,
  })
}

export function projectEvidence(
  agg: ControlCenterAggregation,
  opts: { cursor?: string | null; pageSize?: number | null } = {},
): PinnedEnvelope<EvidenceData> {
  const page = paginateDesc(agg.auditEvents, {
    cursor: opts.cursor,
    pageSize: opts.pageSize,
    expectedBoardRev: agg.pin.boardRev,
    expectedSnapshotRev: agg.pin.canonicalSnapshotId,
  })
  const data: EvidenceData = stripSensitiveFields({
    surfaceVersion: CONTROL_CENTER_UI_SURFACE_VERSION,
    events: page.items.map((e) => ({ ...e })),
    items: page.items.map((e) => ({ ...e })),
    pageSize: page.pageSize,
  })
  let surfaceState = baseSurfaceState(agg)
  surfaceState = withEmptyIfZero(surfaceState, page.items.length, false)
  return createPinnedEnvelope(agg.pin, data, {
    surface: 'evidence',
    surfaceState,
    nextCursor: page.nextCursor,
  })
}

/** Project all nine surfaces from one aggregation (identical pin tuple). */
export function projectAllSurfaces(agg: ControlCenterAggregation): {
  overview: PinnedEnvelope<OverviewData>
  work: PinnedEnvelope<WorkData>
  priority: PinnedEnvelope<PriorityData>
  projects: PinnedEnvelope<ProjectsData>
  features: PinnedEnvelope<FeaturesData>
  agents: PinnedEnvelope<AgentsData>
  ops: PinnedEnvelope<OpsData>
  decisions: PinnedEnvelope<DecisionsData>
  evidence: PinnedEnvelope<EvidenceData>
} {
  return {
    overview: projectOverview(agg),
    work: projectWork(agg),
    priority: projectPriority(agg),
    projects: projectProjects(agg),
    features: projectFeatures(agg),
    agents: projectAgents(agg),
    ops: projectOps(agg),
    decisions: projectDecisions(agg),
    evidence: projectEvidence(agg),
  }
}

/** Pin fields shared across envelopes — for identity equality checks. */
export function envelopePinIdentity(env: PinnedEnvelope<unknown>): {
  schemaVersion: typeof CONTROL_CENTER_UI_SCHEMA
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
} {
  return {
    schemaVersion: env.schemaVersion,
    boardId: env.boardId,
    canonicalSnapshotId: env.canonicalSnapshotId,
    canonicalHash: env.canonicalHash,
    boardRev: env.boardRev,
    lifecycleRev: env.lifecycleRev,
    generatedAt: env.generatedAt,
  }
}

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE }
export type { PageParams, TaskClassificationRecord }
