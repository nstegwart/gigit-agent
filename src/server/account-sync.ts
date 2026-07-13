/**
 * Masked account sync + exact capacity policy (AC-ACCOUNT / AC-CAP).
 * Never stores tokens/raw identity. Miss/stale → ACCOUNT_SYNC_STALE,
 * usableCapacity=0, blocks new dispatch until same-revision readback parity.
 */
import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'

export const ACCOUNT_PUBLISH_SLA_MS = 30_000
export const ACCOUNT_PERIODIC_HEALTH_MS = 60_000

export type MaskedAccountStatus =
  | 'ACTIVE'
  | 'OK'
  | 'LIMIT'
  | 'BAN'
  | '403'
  | 'AUTH_EXPIRED'
  | 'quarantine'
  | 'REMOVED'

export type AccountProviderKind = 'GROK' | 'SPARK' | 'SOL' | 'OTHER'

export type AccountSyncTrigger =
  | 'ORCHESTRATOR_LAUNCH'
  | 'WAVE_LAUNCH'
  | 'AGENT_LAUNCH'
  | 'HEARTBEAT'
  | 'MATERIAL_ASSIGNMENT'
  | 'STATUS_TRANSITION'
  | 'LIMIT_TRANSITION'
  | 'BAN_TRANSITION'
  | 'AUTH_EXPIRED_TRANSITION'
  | 'ROTATION'
  | 'REQUEUE'
  | 'INTEGRATION_CHECKPOINT'
  | 'WAVE_CLOSE'
  | 'PERIODIC_HEALTH'

export interface MaskedAccountRecord {
  maskedAccountId: string
  status: MaskedAccountStatus
  providerKind: AccountProviderKind
  effectiveInUse: number
  effectiveCap: number
  /** Display-only physical slots e.g. "2/20" — never dispatch authorization. */
  physicalSlotsDisplay: string | null
  adaptiveQuotaState: string | null
  reason: string | null
  statusChangedAt: string | null
  /** True when tombstone/REMOVED. */
  tombstone: boolean
}

export interface AccountSyncSnapshot {
  boardId: string
  sourceRevision: number
  generatedAt: string
  generatedAtMs: number
  accounts: Array<MaskedAccountRecord>
  /** Surfaces that confirmed same revision/generatedAt readback. */
  readbackSurfaces: {
    mcp: { sourceRevision: number; generatedAt: string } | null
    api: { sourceRevision: number; generatedAt: string } | null
    ui: { sourceRevision: number; generatedAt: string } | null
    ops: { sourceRevision: number; generatedAt: string } | null
  }
  publishedAtMs: number
  lastPeriodicHealthAtMs: number | null
  stale: boolean
  staleReason: string | null
  usableCapacity: number
  capacity: CapacityPolicyResult
  entityRev: number
}

export interface SyncAccountsRequest {
  boardId: string
  sourceRevision: number
  generatedAt: string
  expectedBoardRev: number
  accounts: Array<{
    maskedAccountId: string
    status: MaskedAccountStatus
    providerKind?: AccountProviderKind
    effectiveInUse: number
    effectiveCap: number
    physicalSlotsDisplay?: string | null
    adaptiveQuotaState?: string | null
    reason?: string | null
    statusChangedAt?: string | null
  }>
  trigger: AccountSyncTrigger
  idempotencyKey: string
  callerRole: 'ROOT_ORCHESTRATOR' | 'MFS_SYNC' | string
  actorId?: string
  /** Optional live system health inputs for capacity policy. */
  health?: CapacityHealthInput
  /** Genuine unique ready collision-safe packet count (program-emitted). */
  genuineReadyPacketCount?: number
  /** Forbidden: never set --accounts all (always rejected if true). */
  accountsAllFlag?: boolean
}

export interface SyncAccountsResult {
  sourceRevision: number
  generatedAt: string
  acceptedCount: number
  usableCapacity: number
  stale: boolean
  staleReason: string | null
  capacity: CapacityPolicyResult
  boardRev: number
  replayed: boolean
}

export interface CapacityHealthInput {
  cpuPercent: number
  ramHealthy?: boolean
  loadHealthy?: boolean
}

/**
 * Explicit capacity dispatch mode — do not overload a single boolean.
 * - OPEN: Grok majority holds; any provider may receive new work (subject to caps/fail-safes).
 * - GROK_ONLY: Grok not majority yet, but healthy Grok usable capacity exists (bootstrap/recovery).
 * - BLOCKED: no new assignment (majority fail-closed, CPU, stale, accounts-all, filler, etc.).
 */
export type CapacityDispatchMode = 'OPEN' | 'GROK_ONLY' | 'BLOCKED'

export interface CapacityPolicyResult {
  sparkLive: number
  sparkCap: number
  solLive: number
  solCap: number
  grokLive: number
  grokPerAccount: Array<{ maskedAccountId: string; inUse: number; cap: number; healthy: boolean }>
  /** True when grokLive > sparkLive + solLive (strict majority of safe live). */
  grokMajority: boolean
  /** Remaining assignable slots on healthy Grok accounts only. */
  healthyGrokUsableCapacity: number
  combinedLive: number
  combinedCap: number
  floorTarget: number
  floorMet: boolean
  belowFloor: boolean
  belowFloorReason: string | null
  /** Remaining capacity that may receive new work under the current dispatchMode. */
  usableCapacity: number
  /**
   * True when at least some new assignment may proceed (OPEN or GROK_ONLY with usable > 0
   * after fail-safes). Not a substitute for provider-level authorizeProviderAssignment.
   */
  dispatchAllowed: boolean
  dispatchMode: CapacityDispatchMode
  /** True only in OPEN mode when fail-safes permit. */
  nonGrokAssignmentAllowed: boolean
  /** True in OPEN or GROK_ONLY when fail-safes permit and healthy Grok usable remains (or OPEN). */
  grokAssignmentAllowed: boolean
  limitingReasons: Array<string>
  /** Policy constants (versioned). */
  policy: {
    sparkMax: 10
    solMax: 10
    grokStartPerAccount: 5
    grokMaxPerAccount: 10
    combinedMax: 200
    floorMin: 60
    physicalSlotsDisplayOnly: true
    neverAccountsAll: true
    neverFiller: true
  }
}

export interface ProviderAssignmentDecision {
  allowed: boolean
  providerKind: AccountProviderKind
  dispatchMode: CapacityDispatchMode
  reason: string | null
}

/** Exact limiting / auth reason codes for Grok majority enforcement. */
export const CAP_REASON_GROK_ONLY_RECOVERY = 'GROK_ONLY_RECOVERY'
export const CAP_REASON_GROK_MAJORITY_NO_RECOVERY = 'GROK_MAJORITY_NO_RECOVERY'
export const CAP_REASON_NON_GROK_DENIED_GROK_ONLY = 'NON_GROK_DENIED_GROK_ONLY'
export const CAP_REASON_ASSIGNMENT_BLOCKED = 'ASSIGNMENT_BLOCKED'
export const CAP_REASON_PROVIDER_NOT_ALLOWED = 'PROVIDER_NOT_ALLOWED'

export type AccountSyncErrorCode =
  | 'AUTHORIZATION_REQUIRED'
  | 'STALE_REVISION'
  | 'DATA_INTEGRITY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_INPUT'
  | 'ACCOUNTS_ALL_FORBIDDEN'
  | 'FILLER_FORBIDDEN'

export class AccountSyncError extends Error {
  readonly code: AccountSyncErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: AccountSyncErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'AccountSyncError'
    this.code = code
    this.details = details
  }
}

export interface AccountSyncStore {
  get(boardId: string): Promise<AccountSyncSnapshot | null>
  put(snap: AccountSyncSnapshot): Promise<void>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

export interface AccountSyncDeps {
  clock: ControlPlaneClock
  accounts: AccountSyncStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
}

const USABLE_STATUSES: ReadonlySet<MaskedAccountStatus> = new Set(['ACTIVE', 'OK'])
const QUARANTINE_STATUSES: ReadonlySet<MaskedAccountStatus> = new Set([
  'BAN',
  '403',
  'AUTH_EXPIRED',
  'quarantine',
  'REMOVED',
])

export function isTombstone(status: MaskedAccountStatus): boolean {
  return status === 'REMOVED'
}

export function contributesUsableCapacity(status: MaskedAccountStatus): boolean {
  if (isTombstone(status)) return false
  if (QUARANTINE_STATUSES.has(status)) return false
  if (status === 'LIMIT') return false // LIMIT stops assignment
  return USABLE_STATUSES.has(status)
}

/**
 * Exact capacity policy AC-CAP-01..03.
 * No tokens/raw identity — maskedAccountId only.
 */
export function evaluateCapacityPolicy(input: {
  accounts: Array<MaskedAccountRecord>
  health?: CapacityHealthInput
  genuineReadyPacketCount?: number
  accountsAllFlag?: boolean
  /** When true, force usableCapacity=0 (stale fail-closed). */
  forceZero?: boolean
  /** Fabricated filler work indicator — forbidden. */
  fillerDetected?: boolean
}): CapacityPolicyResult {
  const policy = {
    sparkMax: 10 as const,
    solMax: 10 as const,
    grokStartPerAccount: 5 as const,
    grokMaxPerAccount: 10 as const,
    combinedMax: 200 as const,
    floorMin: 60 as const,
    physicalSlotsDisplayOnly: true as const,
    neverAccountsAll: true as const,
    neverFiller: true as const,
  }
  const limitingReasons: Array<string> = []

  if (input.accountsAllFlag) {
    limitingReasons.push('ACCOUNTS_ALL_FORBIDDEN')
  }
  if (input.fillerDetected) {
    limitingReasons.push('FILLER_FORBIDDEN')
  }

  let sparkLive = 0
  let solLive = 0
  let grokLive = 0
  const grokPerAccount: CapacityPolicyResult['grokPerAccount'] = []

  for (const a of input.accounts) {
    const usable = contributesUsableCapacity(a.status)
    const inUse = usable ? Math.max(0, a.effectiveInUse) : 0
    if (a.providerKind === 'SPARK') {
      sparkLive += inUse
    } else if (a.providerKind === 'SOL') {
      solLive += inUse
    } else if (a.providerKind === 'GROK') {
      const healthy = usable
      // Grok starts 5, remains 5–10 per healthy account
      let cap = a.effectiveCap
      if (healthy) {
        if (cap < policy.grokStartPerAccount) cap = policy.grokStartPerAccount
        if (cap > policy.grokMaxPerAccount) cap = policy.grokMaxPerAccount
      } else {
        cap = 0
      }
      const clamped = Math.min(inUse, cap)
      grokLive += clamped
      grokPerAccount.push({
        maskedAccountId: a.maskedAccountId,
        inUse: clamped,
        cap,
        healthy,
      })
    }
  }

  if (sparkLive > policy.sparkMax) {
    limitingReasons.push(`SPARK_OVER_CAP:${sparkLive}>${policy.sparkMax}`)
    sparkLive = policy.sparkMax
  }
  if (solLive > policy.solMax) {
    limitingReasons.push(`SOL_OVER_CAP:${solLive}>${policy.solMax}`)
    solLive = policy.solMax
  }

  let combinedLive = sparkLive + solLive + grokLive
  if (combinedLive > policy.combinedMax) {
    limitingReasons.push(`COMBINED_OVER_CAP:${combinedLive}>${policy.combinedMax}`)
    combinedLive = policy.combinedMax
  }

  const nonGrok = sparkLive + solLive
  // Strict majority of safe live. Zero-live is NOT majority (bootstrap uses GROK_ONLY).
  const grokMajority = combinedLive > 0 && grokLive > nonGrok

  // Floor >=60 iff genuine unique ready collision-safe packets + health permit
  const packets = input.genuineReadyPacketCount ?? 0
  const cpu = input.health?.cpuPercent ?? 0
  const ramOk = input.health?.ramHealthy !== false
  const loadOk = input.health?.loadHealthy !== false
  let floorMet = false
  let belowFloor = false
  let belowFloorReason: string | null = null

  if (cpu >= 90) {
    limitingReasons.push('CPU_GTE_90')
  }

  if (packets >= policy.floorMin && ramOk && loadOk && cpu < 90) {
    floorMet = combinedLive >= policy.floorMin
    if (!floorMet) {
      belowFloor = true
      belowFloorReason = `BELOW_FLOOR live=${combinedLive} packets=${packets} need>=${policy.floorMin}`
      limitingReasons.push(belowFloorReason)
    }
  } else {
    // Floor does not apply — publish BELOW_FLOOR with exact reason when live target requested
    if (packets < policy.floorMin) {
      belowFloor = true
      belowFloorReason = `BELOW_FLOOR packets=${packets}<${policy.floorMin}`
      limitingReasons.push(belowFloorReason)
    } else if (cpu >= 90) {
      belowFloor = true
      belowFloorReason = `BELOW_FLOOR cpu=${cpu}`
      limitingReasons.push(belowFloorReason)
    } else if (!ramOk || !loadOk) {
      belowFloor = true
      belowFloorReason = `BELOW_FLOOR health ram=${ramOk} load=${loadOk}`
      limitingReasons.push(belowFloorReason)
    }
  }

  // Remaining capacity split by provider family (healthy / contributes only).
  let healthyGrokUsableCapacity = 0
  let nonGrokUsableCapacity = 0
  for (const a of input.accounts) {
    if (!contributesUsableCapacity(a.status)) continue
    if (a.providerKind === 'GROK') {
      const row = grokPerAccount.find((g) => g.maskedAccountId === a.maskedAccountId)
      if (row) healthyGrokUsableCapacity += Math.max(0, row.cap - row.inUse)
    } else if (a.providerKind === 'SPARK') {
      nonGrokUsableCapacity += Math.max(
        0,
        Math.min(a.effectiveCap, policy.sparkMax) - a.effectiveInUse,
      )
    } else if (a.providerKind === 'SOL') {
      nonGrokUsableCapacity += Math.max(
        0,
        Math.min(a.effectiveCap, policy.solMax) - a.effectiveInUse,
      )
    } else {
      nonGrokUsableCapacity += Math.max(0, a.effectiveCap - a.effectiveInUse)
    }
  }
  const rawUsableOpen = healthyGrokUsableCapacity + nonGrokUsableCapacity

  // Hard fail-safes that fully block new assignment (independent of majority).
  const hardBlocked =
    Boolean(input.forceZero) ||
    Boolean(input.accountsAllFlag) ||
    Boolean(input.fillerDetected) ||
    cpu >= 90

  if (input.forceZero) {
    limitingReasons.push('ACCOUNT_SYNC_STALE')
  }

  // Grok majority enforcement at assignment (AC-CAP-01):
  // - majority → OPEN
  // - not majority + healthy Grok usable → GROK_ONLY (bootstrap / recovery; avoid zero-live deadlock)
  // - not majority + no healthy Grok usable → BLOCKED (usable=0)
  let dispatchMode: CapacityDispatchMode
  let usableCapacity = 0
  let nonGrokAssignmentAllowed = false
  let grokAssignmentAllowed = false

  if (hardBlocked) {
    dispatchMode = 'BLOCKED'
    usableCapacity = 0
    nonGrokAssignmentAllowed = false
    grokAssignmentAllowed = false
  } else if (grokMajority) {
    dispatchMode = 'OPEN'
    usableCapacity = Math.max(0, rawUsableOpen)
    // Family-level: only claim allowed when remaining slots exist for that family.
    nonGrokAssignmentAllowed = nonGrokUsableCapacity > 0
    grokAssignmentAllowed = healthyGrokUsableCapacity > 0
  } else if (healthyGrokUsableCapacity > 0) {
    dispatchMode = 'GROK_ONLY'
    usableCapacity = Math.max(0, healthyGrokUsableCapacity)
    nonGrokAssignmentAllowed = false
    grokAssignmentAllowed = true
    if (!limitingReasons.includes(CAP_REASON_GROK_ONLY_RECOVERY)) {
      limitingReasons.push(CAP_REASON_GROK_ONLY_RECOVERY)
    }
  } else {
    dispatchMode = 'BLOCKED'
    usableCapacity = 0
    nonGrokAssignmentAllowed = false
    grokAssignmentAllowed = false
    if (!limitingReasons.includes(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)) {
      limitingReasons.push(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)
    }
  }

  // dispatchAllowed = some new assignment may proceed (not a provider-level gate).
  const dispatchAllowedFinal =
    dispatchMode !== 'BLOCKED' &&
    usableCapacity > 0 &&
    (nonGrokAssignmentAllowed || grokAssignmentAllowed)

  return {
    sparkLive,
    sparkCap: policy.sparkMax,
    solLive,
    solCap: policy.solMax,
    grokLive,
    grokPerAccount,
    grokMajority,
    healthyGrokUsableCapacity: Math.max(0, healthyGrokUsableCapacity),
    combinedLive,
    combinedCap: policy.combinedMax,
    floorTarget: policy.floorMin,
    floorMet,
    belowFloor,
    belowFloorReason,
    usableCapacity,
    dispatchAllowed: dispatchAllowedFinal,
    dispatchMode,
    nonGrokAssignmentAllowed,
    grokAssignmentAllowed,
    limitingReasons,
    policy,
  }
}

/**
 * Pure authorization helper: decide whether a requested provider may receive
 * new work from a capacity report. Callers (C2A register/dispatch wiring) MUST
 * call this at the real assignment boundary — this module does not wire it.
 *
 * Model strings may be supplied for convenience; providerKind wins when both set.
 */
export function authorizeProviderAssignment(
  capacity: Pick<
    CapacityPolicyResult,
    | 'dispatchMode'
    | 'dispatchAllowed'
    | 'usableCapacity'
    | 'nonGrokAssignmentAllowed'
    | 'grokAssignmentAllowed'
    | 'limitingReasons'
  >,
  request: {
    providerKind?: AccountProviderKind
    /** Optional model id; mapped when providerKind omitted. */
    model?: string
  },
): ProviderAssignmentDecision {
  const providerKind =
    request.providerKind ??
    (request.model != null ? resolveProviderKindFromModel(request.model) : 'OTHER')

  if (capacity.dispatchMode === 'BLOCKED' || !capacity.dispatchAllowed) {
    const preferred =
      capacity.limitingReasons.find((r) => r === CAP_REASON_GROK_MAJORITY_NO_RECOVERY) ??
      capacity.limitingReasons.find((r) => r === 'CPU_GTE_90') ??
      capacity.limitingReasons.find((r) => r === 'ACCOUNT_SYNC_STALE') ??
      capacity.limitingReasons.find((r) => r === 'ACCOUNTS_ALL_FORBIDDEN') ??
      capacity.limitingReasons.find((r) => r === 'FILLER_FORBIDDEN') ??
      capacity.limitingReasons[0] ??
      CAP_REASON_ASSIGNMENT_BLOCKED
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: preferred,
    }
  }

  if (providerKind === 'GROK') {
    if (!capacity.grokAssignmentAllowed) {
      return {
        allowed: false,
        providerKind,
        dispatchMode: capacity.dispatchMode,
        reason: CAP_REASON_PROVIDER_NOT_ALLOWED,
      }
    }
    return {
      allowed: true,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: capacity.dispatchMode === 'GROK_ONLY' ? CAP_REASON_GROK_ONLY_RECOVERY : null,
    }
  }

  // Spark / SOL / OTHER
  if (capacity.dispatchMode === 'GROK_ONLY' || !capacity.nonGrokAssignmentAllowed) {
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason:
        capacity.dispatchMode === 'GROK_ONLY'
          ? CAP_REASON_NON_GROK_DENIED_GROK_ONLY
          : CAP_REASON_PROVIDER_NOT_ALLOWED,
    }
  }

  return {
    allowed: true,
    providerKind,
    dispatchMode: capacity.dispatchMode,
    reason: null,
  }
}

/**
 * Exact supported model identities → provider kind (no substring heuristics).
 * Contractual identities only (AC-CAP / orchestrator):
 *   grok-4.5, gpt-5.3-codex-spark, gpt-5.6-sol
 * Any other string (including names containing "grok"/"spark"/"sol") → OTHER.
 */
export const SUPPORTED_MODEL_PROVIDER: Readonly<Record<string, AccountProviderKind>> = {
  'grok-4.5': 'GROK',
  'gpt-5.3-codex-spark': 'SPARK',
  'gpt-5.6-sol': 'SOL',
}

/** Exact model → provider mapping; unknown/partial/substring names never become Grok. */
export function resolveProviderKindFromModel(model: string): AccountProviderKind {
  if (typeof model !== 'string') return 'OTHER'
  const key = model.trim()
  return SUPPORTED_MODEL_PROVIDER[key] ?? 'OTHER'
}

function normalizeAccount(
  a: SyncAccountsRequest['accounts'][number],
): MaskedAccountRecord {
  // Reject secret-like fields if sneaked into reason (masked only contract)
  if (a.maskedAccountId && /token|password|secret/i.test(a.maskedAccountId)) {
    throw new AccountSyncError('DATA_INTEGRITY', 'maskedAccountId must not look like a secret')
  }
  const status = a.status
  return {
    maskedAccountId: a.maskedAccountId,
    status,
    providerKind: a.providerKind ?? 'OTHER',
    effectiveInUse: Math.max(0, a.effectiveInUse),
    effectiveCap: Math.max(0, a.effectiveCap),
    physicalSlotsDisplay: a.physicalSlotsDisplay ?? null,
    adaptiveQuotaState: a.adaptiveQuotaState ?? null,
    reason: a.reason ?? null,
    statusChangedAt: a.statusChangedAt ?? null,
    tombstone: isTombstone(status),
  }
}

/**
 * Record multi-surface readback parity. All four surfaces must match
 * sourceRevision+generatedAt or stale fail-closed remains.
 */
export async function recordAccountReadback(
  deps: AccountSyncDeps,
  opts: {
    boardId: string
    surface: 'mcp' | 'api' | 'ui' | 'ops'
    sourceRevision: number
    generatedAt: string
  },
): Promise<AccountSyncSnapshot> {
  return deps.accounts.withBoardLock(opts.boardId, async () => {
    const snap = await deps.accounts.get(opts.boardId)
    if (!snap) {
      throw new AccountSyncError('INVALID_INPUT', 'no account snapshot to read back')
    }
    const nextSurfaces = {
      ...snap.readbackSurfaces,
      [opts.surface]: {
        sourceRevision: opts.sourceRevision,
        generatedAt: opts.generatedAt,
      },
    }
    const parity = surfacesHaveParity(nextSurfaces, snap.sourceRevision, snap.generatedAt)
    const now = deps.clock.nowMs()
    // Fail-closed only after SLA window without full multi-surface parity (AC-ACCOUNT-07).
    // Within 30s, incomplete readback is still warming — not stale yet.
    const pastSla = now - snap.publishedAtMs > ACCOUNT_PUBLISH_SLA_MS
    let stale = pastSla && !parity
    let staleReason: string | null = null
    if (stale) staleReason = 'SLA_MISS_30S_NO_PARITY'
    if (parity) {
      stale = false
      staleReason = null
    }

    const capacity = evaluateCapacityPolicy({
      accounts: snap.accounts,
      forceZero: stale,
    })

    const next: AccountSyncSnapshot = {
      ...snap,
      readbackSurfaces: nextSurfaces,
      stale,
      staleReason,
      usableCapacity: capacity.usableCapacity,
      capacity,
      entityRev: snap.entityRev + 1,
    }
    await deps.accounts.put(next)
    await applyDispatchBlock(deps, opts.boardId, next)
    return next
  })
}

function surfacesHaveParity(
  surfaces: AccountSyncSnapshot['readbackSurfaces'],
  sourceRevision: number,
  generatedAt: string,
): boolean {
  const keys: Array<keyof typeof surfaces> = ['mcp', 'api', 'ui', 'ops']
  for (const k of keys) {
    const s = surfaces[k]
    if (!s) return false
    if (s.sourceRevision !== sourceRevision || s.generatedAt !== generatedAt) return false
  }
  return true
}

async function applyDispatchBlock(
  deps: AccountSyncDeps,
  boardId: string,
  snap: AccountSyncSnapshot,
): Promise<void> {
  const board = await deps.atomic.getBoardState(boardId)
  if (snap.stale || snap.usableCapacity === 0 && snap.staleReason) {
    await deps.atomic.setBoardState({
      ...board,
      dispatchBlocked: snap.stale,
      dispatchBlockedReason: snap.stale
        ? `ACCOUNT_SYNC_STALE: ${snap.staleReason}`
        : board.dispatchBlockedReason,
    })
  } else if (!snap.stale) {
    await deps.atomic.setBoardState({
      ...board,
      dispatchBlocked: false,
      dispatchBlockedReason: null,
    })
  }
}

export async function syncAccounts(
  deps: AccountSyncDeps,
  req: SyncAccountsRequest,
): Promise<SyncAccountsResult> {
  if (req.callerRole !== 'ROOT_ORCHESTRATOR' && req.callerRole !== 'MFS_SYNC') {
    throw new AccountSyncError(
      'AUTHORIZATION_REQUIRED',
      'sync_accounts requires ROOT_ORCHESTRATOR or MFS_SYNC',
      { callerRole: req.callerRole },
    )
  }
  if (req.accountsAllFlag) {
    throw new AccountSyncError(
      'ACCOUNTS_ALL_FORBIDDEN',
      'never use --accounts all',
    )
  }

  const generatedAtMs = Date.parse(req.generatedAt)
  if (!Number.isFinite(generatedAtMs)) {
    throw new AccountSyncError('INVALID_INPUT', 'generatedAt must be ISO timestamp')
  }
  if (!Number.isInteger(req.sourceRevision) || req.sourceRevision < 0) {
    throw new AccountSyncError('INVALID_INPUT', 'sourceRevision must be non-negative integer')
  }

  const accounts = req.accounts.map(normalizeAccount)

  // Idempotency first so exact replays succeed without re-CAS on boardRev.
  const begin = await beginIdempotent(deps.idempotency, {
    scope: {
      actorId: req.actorId ?? req.callerRole,
      boardId: req.boardId,
      endpoint: 'sync_accounts',
      key: req.idempotencyKey,
    },
    requestBody: {
      sourceRevision: req.sourceRevision,
      generatedAt: req.generatedAt,
      accounts,
      trigger: req.trigger,
    },
    nowMs: deps.clock.nowMs(),
  })

  if (begin.kind === 'REPLAY' && begin.record) {
    return { ...(begin.record.responseBody as SyncAccountsResult), replayed: true }
  }

  const board = await deps.atomic.getBoardState(req.boardId)
  if (req.expectedBoardRev !== board.boardRev) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw new AccountSyncError('STALE_REVISION', `board rev mismatch`, {
      expectedBoardRev: req.expectedBoardRev,
      currentBoardRev: board.boardRev,
    })
  }

  try {
    const result = await deps.accounts.withBoardLock(req.boardId, async () => {
      const now = deps.clock.nowMs()
      // Fresh publish: readbacks reset; parity not yet proven → temporarily not stale
      // until SLA window closes without parity. Immediately after publish we set
      // stale=false but dispatchAllowed uses capacity; evaluateSLA later may flip.
      // Contract: miss/stale → usableCapacity=0. On publish we assume surfaces will
      // catch up; if caller marks periodic and previous was stale without parity, keep blocked.
      const capacity = evaluateCapacityPolicy({
        accounts,
        health: req.health,
        genuineReadyPacketCount: req.genuineReadyPacketCount,
        accountsAllFlag: false,
        forceZero: false,
      })

      const snap: AccountSyncSnapshot = {
        boardId: req.boardId,
        sourceRevision: req.sourceRevision,
        generatedAt: req.generatedAt,
        generatedAtMs,
        accounts,
        readbackSurfaces: { mcp: null, api: null, ui: null, ops: null },
        publishedAtMs: now,
        lastPeriodicHealthAtMs:
          req.trigger === 'PERIODIC_HEALTH' ? now : null,
        stale: false,
        staleReason: null,
        usableCapacity: capacity.usableCapacity,
        capacity,
        entityRev: 1,
      }

      // Preserve lastPeriodic if not this trigger
      const prev = await deps.accounts.get(req.boardId)
      if (prev && req.trigger !== 'PERIODIC_HEALTH') {
        snap.lastPeriodicHealthAtMs = prev.lastPeriodicHealthAtMs
      }

      await deps.accounts.put(snap)
      const boardRev = await deps.atomic.bumpBoardRev(req.boardId)
      await deps.atomic.setBoardState({
        boardId: req.boardId,
        boardRev,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      })

      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'ACCOUNT_SYNC',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.actorId ?? req.callerRole,
        subjectType: 'account_sync',
        subjectId: String(req.sourceRevision),
        detail: {
          trigger: req.trigger,
          acceptedCount: accounts.length,
          usableCapacity: capacity.usableCapacity,
          sourceRevision: req.sourceRevision,
          generatedAt: req.generatedAt,
        },
        material: true,
      })

      return {
        sourceRevision: req.sourceRevision,
        generatedAt: req.generatedAt,
        acceptedCount: accounts.length,
        usableCapacity: capacity.usableCapacity,
        stale: false,
        staleReason: null,
        capacity,
        boardRev,
        replayed: false,
      } satisfies SyncAccountsResult
    })

    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, result, begin.requestHash)
    return result
  } catch (e) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    if (e instanceof IdempotencyError) {
      throw new AccountSyncError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

/**
 * Evaluate publication SLA: if surfaces lack same-revision parity after 30s,
 * or periodic health missed 60s, emit ACCOUNT_SYNC_STALE and usableCapacity=0.
 */
export async function evaluateAccountSyncFreshness(
  deps: AccountSyncDeps,
  boardId: string,
): Promise<AccountSyncSnapshot | null> {
  return deps.accounts.withBoardLock(boardId, async () => {
    const snap = await deps.accounts.get(boardId)
    if (!snap) return null
    const now = deps.clock.nowMs()
    const parity = surfacesHaveParity(
      snap.readbackSurfaces,
      snap.sourceRevision,
      snap.generatedAt,
    )
    const age = now - snap.publishedAtMs
    const slaMiss = age > ACCOUNT_PUBLISH_SLA_MS && !parity
    const periodicMiss =
      snap.lastPeriodicHealthAtMs != null &&
      now - snap.lastPeriodicHealthAtMs > ACCOUNT_PERIODIC_HEALTH_MS

    let stale = snap.stale
    let staleReason = snap.staleReason
    if (slaMiss) {
      stale = true
      staleReason = 'SLA_MISS_30S_NO_PARITY'
    }
    if (periodicMiss) {
      stale = true
      staleReason = staleReason
        ? `${staleReason}+PERIODIC_HEALTH_MISS_60S`
        : 'PERIODIC_HEALTH_MISS_60S'
    }

    if (!stale && parity) {
      stale = false
      staleReason = null
    }

    const capacity = evaluateCapacityPolicy({
      accounts: snap.accounts,
      forceZero: stale,
    })

    if (
      stale !== snap.stale ||
      capacity.usableCapacity !== snap.usableCapacity ||
      staleReason !== snap.staleReason
    ) {
      const next: AccountSyncSnapshot = {
        ...snap,
        stale,
        staleReason,
        usableCapacity: capacity.usableCapacity,
        capacity,
        entityRev: snap.entityRev + 1,
      }
      await deps.accounts.put(next)
      if (stale) {
        await deps.atomic.appendAudit({
          boardId,
          kind: 'ACCOUNT_SYNC_STALE',
          atMs: now,
          atISO: deps.clock.nowISO(),
          actorId: null,
          subjectType: 'account_sync',
          subjectId: String(snap.sourceRevision),
          detail: { staleReason, usableCapacity: 0 },
          material: true,
        })
        const board = await deps.atomic.getBoardState(boardId)
        await deps.atomic.setBoardState({
          ...board,
          dispatchBlocked: true,
          dispatchBlockedReason: `ACCOUNT_SYNC_STALE: ${staleReason}`,
        })
      } else {
        await applyDispatchBlock(deps, boardId, next)
      }
      return next
    }
    return snap
  })
}

export function createMemoryAccountSyncStore(): AccountSyncStore & {
  snapshot(): Array<AccountSyncSnapshot>
} {
  const map = new Map<string, AccountSyncSnapshot>()
  const chains = new Map<string, Promise<unknown>>()
  return {
    snapshot() {
      return [...map.values()].map((s) => ({
        ...s,
        accounts: s.accounts.map((a) => ({ ...a })),
      }))
    },
    async get(boardId) {
      const s = map.get(boardId)
      return s
        ? {
            ...s,
            accounts: s.accounts.map((a) => ({ ...a })),
            readbackSurfaces: { ...s.readbackSurfaces },
          }
        : null
    },
    async put(snap) {
      map.set(snap.boardId, {
        ...snap,
        accounts: snap.accounts.map((a) => ({ ...a })),
        readbackSurfaces: { ...snap.readbackSurfaces },
      })
    },
    async withBoardLock(boardId, fn) {
      const prev = chains.get(boardId) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      chains.set(boardId, prev.then(() => gate))
      await prev
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}

// ---------------------------------------------------------------------------
// Read-only control-center adapter (no mutation of authority/policy)
// ---------------------------------------------------------------------------

/** Process-wide account-sync store (same pattern as dispatch plan shared store). */
let sharedAccountSyncStore: AccountSyncStore | null = null

export function getSharedAccountSyncStore(): AccountSyncStore {
  if (!sharedAccountSyncStore) {
    sharedAccountSyncStore = createMemoryAccountSyncStore()
  }
  return sharedAccountSyncStore
}

export function setSharedAccountSyncStore(store: AccountSyncStore | null): void {
  sharedAccountSyncStore = store
}

export function resetSharedAccountSyncStore(): void {
  sharedAccountSyncStore = null
}

/**
 * Read-only latest snapshot for a board.
 * Does not mutate, re-evaluate freshness, or alter dispatch block state.
 */
export async function readLatestAccountSyncSnapshot(
  boardId: string,
  store?: AccountSyncStore | null,
): Promise<AccountSyncSnapshot | null> {
  const s = store ?? getSharedAccountSyncStore()
  return s.get(boardId)
}

/** UI/control-center read model — masked fields only, no tokens/raw identity. */
export interface AccountSyncCcReadModel {
  boardId: string
  sourceRevision: number
  generatedAt: string
  generatedAtMs: number
  stale: boolean
  staleReason: string | null
  usableCapacity: number
  accounts: Array<MaskedAccountRecord>
  publishedAtMs: number
  lastPeriodicHealthAtMs: number | null
  readbackParityOk: boolean
  readbackSurfaces: AccountSyncSnapshot['readbackSurfaces']
  entityRev: number
}

/**
 * Project authoritative snapshot → control-center read model (pure, no I/O).
 * null input → null (caller fail-closes usableCapacity=0 / stale).
 */
export function projectAccountSyncCcReadModel(
  snap: AccountSyncSnapshot | null | undefined,
): AccountSyncCcReadModel | null {
  if (!snap) return null
  const parity = surfacesHaveParity(
    snap.readbackSurfaces,
    snap.sourceRevision,
    snap.generatedAt,
  )
  return {
    boardId: snap.boardId,
    sourceRevision: snap.sourceRevision,
    generatedAt: snap.generatedAt,
    generatedAtMs: snap.generatedAtMs,
    stale: snap.stale,
    staleReason: snap.staleReason,
    usableCapacity: snap.usableCapacity,
    accounts: snap.accounts.map((a) => ({ ...a })),
    publishedAtMs: snap.publishedAtMs,
    lastPeriodicHealthAtMs: snap.lastPeriodicHealthAtMs,
    readbackParityOk: parity,
    readbackSurfaces: { ...snap.readbackSurfaces },
    entityRev: snap.entityRev,
  }
}
