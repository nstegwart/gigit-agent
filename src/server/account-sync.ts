/**
 * Masked account sync + exact capacity policy (AC-ACCOUNT / AC-CAP).
 * Never stores tokens/raw identity. Miss/stale → ACCOUNT_SYNC_STALE,
 * usableCapacity=0, blocks new dispatch until same-revision readback parity.
 */
import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  IdempotencyError,
} from './idempotency'
import type { IdempotencyStorage } from './idempotency'

export const ACCOUNT_PUBLISH_SLA_MS = 30_000
export const ACCOUNT_PERIODIC_HEALTH_MS = 60_000
export const ACCOUNT_PROBE_MAX_AGE_SECONDS = 300

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
  /** CP0 eligibility evidence. Identity remains masked. */
  expiresAt?: string | null
  quotaRemaining?: number | null
  quotaVerdict?: 'PASS' | 'FAIL' | 'SKIP' | 'UNKNOWN'
  chatVerdict?: 'PASS' | 'FAIL' | 'SKIP' | 'UNKNOWN'
  probedAt?: string | null
  probeAgeSeconds?: number | null
  adaptiveCap?: number
  quarantineReason?: string | null
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
  /**
   * Create (no prior snapshot) requires 0. Update CAS current snapshot.entityRev.
   * Never silently defaulted.
   */
  entityExpectedRev: number
  expectedBoardRev: number
  /** Current subject/canonical hash (pin). Required non-empty. */
  canonicalHash: string
  /** When set (MCP pin), must equal canonicalHash. */
  currentPinHash?: string | null
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
    expiresAt?: string | null
    quotaRemaining?: number | null
    quotaVerdict?: 'PASS' | 'FAIL' | 'SKIP' | 'UNKNOWN'
    chatVerdict?: 'PASS' | 'FAIL' | 'SKIP' | 'UNKNOWN'
    probedAt?: string | null
    probeAgeSeconds?: number | null
    adaptiveCap?: number
    quarantineReason?: string | null
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
  memAvailableGiB?: number
  observedWorkerRssP95MiB?: number
  cpuOver95Samples?: number
  hostLoad1m?: number
  pidCount?: number
  acceptedTerminalYieldPercent?: number
  missingHeartbeatPercent?: number
  infrastructureFailurePercent?: number
  collisionDetected?: boolean
}

/**
 * Explicit capacity dispatch mode — do not overload a single boolean.
 * - OPEN: Grok majority holds; any provider may receive new work (subject to caps/fail-safes).
 * - GROK_ONLY: Grok not majority yet, but healthy Grok usable capacity exists (bootstrap/recovery).
 * - BLOCKED: no new assignment (majority fail-closed, CPU, stale, accounts-all, filler, etc.).
 */
export type CapacityDispatchMode = 'OPEN' | 'GROK_ONLY' | 'BLOCKED'

/**
 * Fail-closed operator action descriptors for CPU drain + LIMIT requeue/rotate.
 * Pure policy only — does not mutate runners/accounts. Consumers must honor or
 * remain blocked; inventing external runner mutation outside these codes is forbidden.
 */
export type CapacityFailSafeActionKind =
  | 'STOP_NEW_DISPATCH'
  | 'BOUNDED_DRAIN_REDUCE'
  | 'STOP_LIMIT_ASSIGNMENT'
  | 'PRESERVE_REQUEUE_UNFINISHED'
  | 'ROTATE_LIMIT_ACCOUNT'

export interface CapacityFailSafeAction {
  action: CapacityFailSafeActionKind
  reason: string
  /** Present for LIMIT-account scoped actions. */
  maskedAccountId?: string
  /**
   * BOUNDED_DRAIN_REDUCE: suggested upper bound on live slots after this drain step.
   * Never invents runner kill — fail-closed hint only.
   */
  targetLiveSlots?: number
  /** BOUNDED_DRAIN_REDUCE: max slots to reduce this cycle (bounded, not full fleet kill). */
  maxReduceSlots?: number
  /** Always true: action is mandatory fail-closed policy, not advisory telemetry. */
  failClosed: true
}

/** Exact fraction of controller-owned live slots reduced by a qualifying CPU drain. */
export const CPU_BOUNDED_DRAIN_FRACTION = 0.25 as const

/**
 * @deprecated CPU drains have no absolute slot cap; use CPU_BOUNDED_DRAIN_FRACTION.
 * Null is retained as an explicit compatibility value for legacy policy readers.
 */
export const CPU_BOUNDED_DRAIN_MAX_REDUCE_SLOTS = null

/**
 * Internal schedule-able fail-safe intent derived from CapacityFailSafeAction.
 * Pure bookkeeping for register/scheduler boundaries — never carries runner
 * kill / external API mutation fields.
 */
export type CapacityFailSafeScheduleTrigger = Extract<
  AccountSyncTrigger,
  'REQUEUE' | 'ROTATION' | 'LIMIT_TRANSITION' | 'PERIODIC_HEALTH'
>

export interface CapacityFailSafeIntent {
  action: CapacityFailSafeActionKind
  /** Account-sync trigger to schedule internally; null when assignment-block only. */
  scheduleTrigger: CapacityFailSafeScheduleTrigger | null
  reason: string
  maskedAccountId?: string
  maxReduceSlots?: number
  targetLiveSlots?: number
  failClosed: true
  /** When true, register/dispatch must deny new assignment. */
  blocksAssignment: boolean
}

export interface CapacityFailSafeAssignmentGate {
  blocked: boolean
  reason: string | null
  action: CapacityFailSafeActionKind | null
  maskedAccountId?: string
}

export interface CapacityPolicyResult {
  sparkLive: number
  sparkCap: number
  solLive: number
  solCap: number
  grokLive: number
  grokPerAccount: Array<{
    maskedAccountId: string
    inUse: number
    cap: number
    healthy: boolean
  }>
  /** Eligible Grok placement order: nearest program-emitted expiry, then masked id. */
  grokPlacementOrder?: Array<string>
  /** True when grokLive > sparkLive + solLive (strict majority of safe live). */
  grokMajority: boolean
  /** Remaining assignable slots on healthy Grok accounts only. */
  healthyGrokUsableCapacity: number
  /**
   * Remaining assignable SPARK slots after global sparkMax clamp + combined budget.
   * SPARK must not consume SOL-only headroom (authorizeProviderAssignment uses this).
   */
  sparkUsableCapacity: number
  /**
   * Remaining assignable SOL slots after global solMax clamp + combined budget.
   * SOL must not consume SPARK-only headroom.
   */
  solUsableCapacity: number
  /** Remaining OTHER provider slots after combined budget (OPEN only). */
  otherUsableCapacity: number
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
  /** Host launch-batch pacing. RSS is telemetry only and never derives capacity. */
  launchBatchFraction?: 0 | 0.25 | 0.5 | 1
  /** True only in OPEN mode when fail-safes permit and some non-Grok family remaining > 0. */
  nonGrokAssignmentAllowed: boolean
  /** True in OPEN or GROK_ONLY when fail-safes permit and healthy Grok usable remains (or OPEN). */
  grokAssignmentAllowed: boolean
  limitingReasons: Array<string>
  /**
   * Exact fail-closed CPU drain / LIMIT requeue-rotate policy actions.
   * Empty when no fail-safe side-effect is required. Never mutates runners here.
   */
  failSafeActions: Array<CapacityFailSafeAction>
  /** Policy constants (versioned). */
  policy: {
    sparkMax: number
    solMax: number
    grokSoftPerAccount?: number
    /** Deprecated name retained for typed legacy readers; equals the soft cap. */
    grokStartPerAccount: number
    grokMaxPerAccount: number
    combinedMax: number
    floorMin: number
    physicalSlotsDisplayOnly: boolean
    neverAccountsAll: boolean
    neverFiller: boolean
    /** Exact fraction of controller-owned live slots reduced by a qualifying CPU drain. */
    cpuDrainFraction?: number
    /** @deprecated Null means no absolute slot cap; dispatch uses cpuDrainFraction. */
    cpuBoundedDrainMaxReduceSlots: number | null
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
export const CAP_REASON_SPARK_NO_REMAINING = 'SPARK_NO_REMAINING'
export const CAP_REASON_SOL_NO_REMAINING = 'SOL_NO_REMAINING'
export const CAP_REASON_OTHER_NO_REMAINING = 'OTHER_NO_REMAINING'
export const CAP_REASON_GROK_NO_REMAINING = 'GROK_NO_REMAINING'
/** Missing family remaining fields when dispatchAllowed — fail closed (M2). */
export const CAP_REASON_FAMILY_REMAINING_REQUIRED = 'FAMILY_REMAINING_REQUIRED'
/** Fail-safe STOP_NEW_DISPATCH / bounded drain blocks assignment (M4). */
export const CAP_REASON_FAIL_SAFE_STOP_DISPATCH = 'FAIL_SAFE_STOP_DISPATCH'
/** Fail-safe STOP_LIMIT_ASSIGNMENT for the requested masked account (M4). */
export const CAP_REASON_FAIL_SAFE_STOP_LIMIT = 'FAIL_SAFE_STOP_LIMIT'

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
  constructor(
    code: AccountSyncErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'AccountSyncError'
    this.code = code
    this.details = details
  }
}

export interface AccountSyncStore {
  get: (boardId: string) => Promise<AccountSyncSnapshot | null>
  put: (snap: AccountSyncSnapshot) => Promise<void>
  withBoardLock: <T>(boardId: string, fn: () => Promise<T> | T) => Promise<T>
}

export interface AccountSyncDeps {
  clock: ControlPlaneClock
  accounts: AccountSyncStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
}

const USABLE_STATUSES: ReadonlySet<MaskedAccountStatus> = new Set([
  'ACTIVE',
  'OK',
])
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

export function contributesUsableCapacity(
  status: MaskedAccountStatus,
): boolean {
  if (isTombstone(status)) return false
  if (QUARANTINE_STATUSES.has(status)) return false
  if (status === 'LIMIT') return false // LIMIT stops assignment
  return USABLE_STATUSES.has(status)
}

/** Status alone is insufficient: every Grok placement needs fresh quota + chat proof. */
export function isAccountEligible(
  account: MaskedAccountRecord,
  nowMs = Date.now(),
): boolean {
  if (!contributesUsableCapacity(account.status)) return false
  if (account.quotaVerdict !== 'PASS' || account.chatVerdict !== 'PASS')
    return false
  if (!account.probedAt || !account.expiresAt || account.quarantineReason)
    return false
  const probedAtMs = Date.parse(account.probedAt)
  const expiresAtMs = Date.parse(account.expiresAt)
  if (!Number.isFinite(probedAtMs) || !Number.isFinite(expiresAtMs))
    return false
  const ageSeconds = Math.max(0, (nowMs - probedAtMs) / 1000)
  return ageSeconds <= ACCOUNT_PROBE_MAX_AGE_SECONDS && expiresAtMs > nowMs
}

/**
 * Fail-closed placement frontier for Grok. The owner's expiry preference is an
 * authorization contract, not a UI sort: only currently eligible rows appear,
 * ordered by nearest future expiry and then stable masked account id.
 */
export function eligibleGrokAccountsForPlacement(
  accounts: ReadonlyArray<MaskedAccountRecord>,
  nowMs = Date.now(),
): Array<MaskedAccountRecord> {
  return accounts
    .filter(
      (account) =>
        account.providerKind === 'GROK' && isAccountEligible(account, nowMs),
    )
    .sort((left, right) => {
      const leftExpiry = Date.parse(left.expiresAt ?? '')
      const rightExpiry = Date.parse(right.expiresAt ?? '')
      if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry
      return left.maskedAccountId.localeCompare(right.maskedAccountId)
    })
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
  /** Deterministic eligibility clock for tests/readback. */
  nowMs?: number
}): CapacityPolicyResult {
  const nowMs = input.nowMs ?? Date.now()
  const policy = {
    sparkMax: 10 as const,
    solMax: 0 as const,
    grokSoftPerAccount: 10 as const,
    grokStartPerAccount: 10 as const,
    grokMaxPerAccount: 20 as const,
    combinedMax: 400 as const,
    floorMin: 60 as const,
    physicalSlotsDisplayOnly: true as const,
    neverAccountsAll: true as const,
    neverFiller: true as const,
    cpuDrainFraction: CPU_BOUNDED_DRAIN_FRACTION,
    cpuBoundedDrainMaxReduceSlots: CPU_BOUNDED_DRAIN_MAX_REDUCE_SLOTS,
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
    const usable = isAccountEligible(a, nowMs)
    const inUse = usable ? Math.max(0, a.effectiveInUse) : 0
    if (a.providerKind === 'SPARK') {
      sparkLive += inUse
    } else if (a.providerKind === 'SOL') {
      solLive += inUse
    } else if (a.providerKind === 'GROK') {
      const healthy = usable
      // Soft cap 10; adaptive placement may explicitly open slots 11-20.
      let cap = Math.min(
        a.effectiveCap,
        a.adaptiveCap ?? a.effectiveCap,
        policy.grokMaxPerAccount,
      )
      if (healthy) {
        if (cap < 0) cap = 0
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
  const grokPlacementOrder = eligibleGrokAccountsForPlacement(
    input.accounts,
    nowMs,
  ).map((account) => account.maskedAccountId)
  const grokPlacementRank = new Map(
    grokPlacementOrder.map((maskedAccountId, rank) => [maskedAccountId, rank]),
  )
  grokPerAccount.sort((left, right) => {
    const leftRank = grokPlacementRank.get(left.maskedAccountId)
    const rightRank = grokPlacementRank.get(right.maskedAccountId)
    if (leftRank != null || rightRank != null) {
      if (leftRank == null) return 1
      if (rightRank == null) return -1
      return leftRank - rightRank
    }
    return left.maskedAccountId.localeCompare(right.maskedAccountId)
  })

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
    limitingReasons.push(
      `COMBINED_OVER_CAP:${combinedLive}>${policy.combinedMax}`,
    )
    combinedLive = policy.combinedMax
  }

  const nonGrok = sparkLive + solLive
  // Strict majority of safe live. Zero-live is NOT majority (bootstrap uses GROK_ONLY).
  const grokMajority = combinedLive > 0 && grokLive > nonGrok

  // Floor >=60 iff genuine unique ready collision-safe packets + health permit
  const packets = input.genuineReadyPacketCount ?? 0
  const cpu = input.health?.cpuPercent ?? 0
  const memAvailableGiB = input.health?.memAvailableGiB
  const ramOk =
    input.health?.ramHealthy !== false &&
    (memAvailableGiB == null || memAvailableGiB >= 12)
  const loadOk = input.health?.loadHealthy !== false
  let floorMet = false
  let belowFloor = false
  let belowFloorReason: string | null = null

  if (cpu > 95) {
    limitingReasons.push('CPU_GT_95')
  }

  if (packets >= policy.floorMin && ramOk && loadOk && cpu <= 95) {
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
    } else if (cpu > 95) {
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
  // AC-CAP-01: per-account sums are then clamped to GLOBAL Spark/SOL ceilings
  // and combined<=200 remaining headroom (assignment-side, not report-only).
  let healthyGrokUsableCapacity = 0
  let sparkUsableCapacity = 0
  let solUsableCapacity = 0
  let otherUsableCapacity = 0
  for (const a of input.accounts) {
    if (!isAccountEligible(a, nowMs)) continue
    if (a.providerKind === 'GROK') {
      const row = grokPerAccount.find(
        (g) => g.maskedAccountId === a.maskedAccountId,
      )
      if (row) healthyGrokUsableCapacity += Math.max(0, row.cap - row.inUse)
    } else if (a.providerKind === 'SPARK') {
      sparkUsableCapacity += Math.max(
        0,
        Math.min(a.effectiveCap, policy.sparkMax) - a.effectiveInUse,
      )
    } else if (a.providerKind === 'SOL') {
      solUsableCapacity += Math.max(
        0,
        Math.min(a.effectiveCap, policy.solMax) - a.effectiveInUse,
      )
    } else {
      otherUsableCapacity += Math.max(0, a.effectiveCap - a.effectiveInUse)
    }
  }
  // Global Spark/SOL assignment remaining (not multi-account sum).
  const sparkGlobalRemaining = Math.max(0, policy.sparkMax - sparkLive)
  const solGlobalRemaining = Math.max(0, policy.solMax - solLive)
  if (sparkUsableCapacity > sparkGlobalRemaining) {
    limitingReasons.push(
      `SPARK_REMAINING_CLAMP:${sparkUsableCapacity}>${sparkGlobalRemaining}`,
    )
    sparkUsableCapacity = sparkGlobalRemaining
  }
  if (solUsableCapacity > solGlobalRemaining) {
    limitingReasons.push(
      `SOL_REMAINING_CLAMP:${solUsableCapacity}>${solGlobalRemaining}`,
    )
    solUsableCapacity = solGlobalRemaining
  }
  let nonGrokUsableCapacity =
    sparkUsableCapacity + solUsableCapacity + otherUsableCapacity

  // Combined assignment remaining: live + new must not exceed combinedMax.
  // observedWorkerRssP95MiB is retained in telemetry/idempotency only. Current
  // authority explicitly forbids deriving or reducing Grok capacity from RSS.
  const combinedRemaining = Math.max(0, policy.combinedMax - combinedLive)
  if (healthyGrokUsableCapacity + nonGrokUsableCapacity > combinedRemaining) {
    limitingReasons.push(
      `COMBINED_REMAINING_CLAMP:${healthyGrokUsableCapacity + nonGrokUsableCapacity}>${combinedRemaining}`,
    )
    // Prefer Grok remaining under the combined budget (majority recovery path).
    if (healthyGrokUsableCapacity > combinedRemaining) {
      healthyGrokUsableCapacity = combinedRemaining
      nonGrokUsableCapacity = 0
    } else {
      nonGrokUsableCapacity = Math.min(
        nonGrokUsableCapacity,
        Math.max(0, combinedRemaining - healthyGrokUsableCapacity),
      )
    }
  }

  // Keep family remainings consistent with post-combined nonGrok budget so SPARK
  // cannot claim SOL-only residual (and vice versa) after the combined clamp.
  ;({ sparkUsableCapacity, solUsableCapacity, otherUsableCapacity } =
    clampFamilyRemainingsToNonGrokBudget(
      sparkUsableCapacity,
      solUsableCapacity,
      otherUsableCapacity,
      nonGrokUsableCapacity,
    ))
  nonGrokUsableCapacity =
    sparkUsableCapacity + solUsableCapacity + otherUsableCapacity

  const rawUsableOpen = healthyGrokUsableCapacity + nonGrokUsableCapacity

  // Hard fail-safes that fully block new assignment (independent of majority).
  const hardBlocked =
    Boolean(input.forceZero) ||
    Boolean(input.accountsAllFlag) ||
    Boolean(input.fillerDetected) ||
    cpu > 95 ||
    (memAvailableGiB != null && memAvailableGiB < 12) ||
    (input.health?.acceptedTerminalYieldPercent != null &&
      input.health.acceptedTerminalYieldPercent < 50) ||
    (input.health?.missingHeartbeatPercent != null &&
      input.health.missingHeartbeatPercent > 20) ||
    (input.health?.infrastructureFailurePercent != null &&
      input.health.infrastructureFailurePercent > 15) ||
    input.health?.collisionDetected === true

  const cpuBatchFraction: 0 | 0.25 | 0.5 | 1 =
    cpu > 95 ? 0 : cpu >= 92 ? 0.25 : cpu >= 85 ? 0.5 : 1
  const memoryBatchFraction: 0 | 0.25 | 0.5 | 1 =
    memAvailableGiB == null
      ? 1
      : memAvailableGiB < 12
        ? 0
        : memAvailableGiB < 16
          ? 0.25
          : memAvailableGiB < 24
            ? 0.5
            : 1
  const launchBatchFraction = Math.min(
    cpuBatchFraction,
    memoryBatchFraction,
  ) as 0 | 0.25 | 0.5 | 1

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
  let finalSparkUsable = 0
  let finalSolUsable = 0
  let finalOtherUsable = 0
  let finalGrokUsable = 0

  if (hardBlocked) {
    dispatchMode = 'BLOCKED'
    usableCapacity = 0
    nonGrokAssignmentAllowed = false
    grokAssignmentAllowed = false
    finalSparkUsable = 0
    finalSolUsable = 0
    finalOtherUsable = 0
    finalGrokUsable = 0
  } else if (grokMajority) {
    dispatchMode = 'OPEN'
    usableCapacity = Math.max(0, rawUsableOpen)
    finalSparkUsable = Math.max(0, sparkUsableCapacity)
    finalSolUsable = Math.max(0, solUsableCapacity)
    finalOtherUsable = Math.max(0, otherUsableCapacity)
    finalGrokUsable = Math.max(0, healthyGrokUsableCapacity)
    // Family-level: only claim allowed when remaining slots exist for that family.
    nonGrokAssignmentAllowed =
      finalSparkUsable + finalSolUsable + finalOtherUsable > 0
    grokAssignmentAllowed = finalGrokUsable > 0
  } else if (healthyGrokUsableCapacity > 0) {
    dispatchMode = 'GROK_ONLY'
    usableCapacity = Math.max(0, healthyGrokUsableCapacity)
    finalSparkUsable = 0
    finalSolUsable = 0
    finalOtherUsable = 0
    finalGrokUsable = Math.max(0, healthyGrokUsableCapacity)
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
    finalSparkUsable = 0
    finalSolUsable = 0
    finalOtherUsable = 0
    finalGrokUsable = 0
    if (!limitingReasons.includes(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)) {
      limitingReasons.push(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)
    }
  }

  // dispatchAllowed = some new assignment may proceed (not a provider-level gate).
  const dispatchAllowedFinal =
    dispatchMode !== 'BLOCKED' &&
    usableCapacity > 0 &&
    (nonGrokAssignmentAllowed || grokAssignmentAllowed)

  const failSafeActions = evaluateCapacityFailSafeActions({
    accounts: input.accounts,
    cpuPercent: cpu,
    combinedLive,
    dispatchMode,
    memAvailableGiB,
    cpuOver95Samples: input.health?.cpuOver95Samples,
  })

  return {
    sparkLive,
    sparkCap: policy.sparkMax,
    solLive,
    solCap: policy.solMax,
    grokLive,
    grokPerAccount,
    grokPlacementOrder,
    grokMajority,
    healthyGrokUsableCapacity: finalGrokUsable,
    sparkUsableCapacity: finalSparkUsable,
    solUsableCapacity: finalSolUsable,
    otherUsableCapacity: finalOtherUsable,
    combinedLive,
    combinedCap: policy.combinedMax,
    floorTarget: policy.floorMin,
    floorMet,
    belowFloor,
    belowFloorReason,
    usableCapacity,
    dispatchAllowed: dispatchAllowedFinal,
    dispatchMode,
    launchBatchFraction,
    nonGrokAssignmentAllowed,
    grokAssignmentAllowed,
    limitingReasons,
    failSafeActions,
    policy,
  }
}

/**
 * Proportionally re-clamp SPARK/SOL/OTHER remainings so their sum equals the
 * post-combined nonGrok budget. Preserves family identity (no cross-family borrow).
 */
export function clampFamilyRemainingsToNonGrokBudget(
  spark: number,
  sol: number,
  other: number,
  nonGrokBudget: number,
): {
  sparkUsableCapacity: number
  solUsableCapacity: number
  otherUsableCapacity: number
} {
  const budget = Math.max(0, Math.floor(nonGrokBudget))
  const s0 = Math.max(0, Math.floor(spark))
  const l0 = Math.max(0, Math.floor(sol))
  const o0 = Math.max(0, Math.floor(other))
  const sum = s0 + l0 + o0
  if (sum <= budget) {
    return {
      sparkUsableCapacity: s0,
      solUsableCapacity: l0,
      otherUsableCapacity: o0,
    }
  }
  if (budget === 0 || sum === 0) {
    return {
      sparkUsableCapacity: 0,
      solUsableCapacity: 0,
      otherUsableCapacity: 0,
    }
  }
  // Integer proportional scale; distribute leftover by original rank (SPARK → SOL → OTHER).
  let s = Math.floor((s0 * budget) / sum)
  let l = Math.floor((l0 * budget) / sum)
  let o = Math.floor((o0 * budget) / sum)
  let leftover = budget - (s + l + o)
  const order: Array<'s' | 'l' | 'o'> = []
  if (s0 > 0) order.push('s')
  if (l0 > 0) order.push('l')
  if (o0 > 0) order.push('o')
  let i = 0
  while (leftover > 0 && order.length > 0) {
    const k = order[i % order.length]
    if (k === 's' && s < s0) {
      s += 1
      leftover -= 1
    } else if (k === 'l' && l < l0) {
      l += 1
      leftover -= 1
    } else if (k === 'o' && o < o0) {
      o += 1
      leftover -= 1
    } else {
      // Cap reached for this family; drop from rotation.
      order.splice(i % order.length, 1)
      continue
    }
    i += 1
  }
  return {
    sparkUsableCapacity: s,
    solUsableCapacity: l,
    otherUsableCapacity: o,
  }
}

/**
 * Pure fail-closed policy hooks for CPU/memory bounded drain/reduce and LIMIT
 * requeue/rotation. Does not mutate runners, accounts, or external systems —
 * only emits exact actions consumers must honor or stay blocked.
 */
export function evaluateCapacityFailSafeActions(input: {
  accounts: Array<
    Pick<MaskedAccountRecord, 'maskedAccountId' | 'status' | 'effectiveInUse'>
  >
  cpuPercent: number
  combinedLive: number
  dispatchMode: CapacityDispatchMode
  memAvailableGiB?: number
  cpuOver95Samples?: number
}): Array<CapacityFailSafeAction> {
  const actions: Array<CapacityFailSafeAction> = []
  const cpu = input.cpuPercent

  if (
    cpu > 95 ||
    (input.memAvailableGiB != null && input.memAvailableGiB < 12)
  ) {
    const reason = cpu > 95 ? 'CPU_GT_95' : 'MEM_AVAILABLE_LT_12_GIB'
    actions.push({
      action: 'STOP_NEW_DISPATCH',
      reason,
      failClosed: true,
    })
    const drain =
      cpu > 98 ||
      (cpu > 95 && (input.cpuOver95Samples ?? 0) >= 3) ||
      (input.memAvailableGiB != null && input.memAvailableGiB < 8)
    if (drain) {
      const maxReduce = Math.ceil(
        Math.max(0, input.combinedLive) * CPU_BOUNDED_DRAIN_FRACTION,
      )
      const targetLiveSlots = Math.max(0, input.combinedLive - maxReduce)
      actions.push({
        action: 'BOUNDED_DRAIN_REDUCE',
        reason,
        maxReduceSlots: maxReduce,
        targetLiveSlots,
        failClosed: true,
      })
    }
  }

  for (const a of input.accounts) {
    if (a.status !== 'LIMIT') continue
    actions.push({
      action: 'STOP_LIMIT_ASSIGNMENT',
      reason: 'LIMIT',
      maskedAccountId: a.maskedAccountId,
      failClosed: true,
    })
    // Preserve unfinished work for requeue even when inUse reports 0 (fail-closed
    // preserve path); rotation always required for LIMIT accounts.
    actions.push({
      action: 'PRESERVE_REQUEUE_UNFINISHED',
      reason: 'LIMIT',
      maskedAccountId: a.maskedAccountId,
      failClosed: true,
    })
    actions.push({
      action: 'ROTATE_LIMIT_ACCOUNT',
      reason: 'LIMIT',
      maskedAccountId: a.maskedAccountId,
      failClosed: true,
    })
  }

  return actions
}

/**
 * Map fail-safe policy actions → internal scheduler/register intents.
 * No external side effects (no runner kill, no provider API calls).
 */
export function planCapacityFailSafeIntents(
  actions: ReadonlyArray<CapacityFailSafeAction>,
): Array<CapacityFailSafeIntent> {
  const out: Array<CapacityFailSafeIntent> = []
  for (const a of actions) {
    switch (a.action) {
      case 'STOP_NEW_DISPATCH':
        out.push({
          action: a.action,
          scheduleTrigger: null,
          reason: a.reason,
          failClosed: true,
          blocksAssignment: true,
        })
        break
      case 'BOUNDED_DRAIN_REDUCE':
        out.push({
          action: a.action,
          scheduleTrigger: 'PERIODIC_HEALTH',
          reason: a.reason,
          maxReduceSlots: a.maxReduceSlots,
          targetLiveSlots: a.targetLiveSlots,
          failClosed: true,
          // Drain is bounded bookkeeping; assignment already blocked via
          // STOP_NEW_DISPATCH + dispatchMode BLOCKED. Still marks blocked so
          // partial capacity snapshots that only carry drain honor the stop.
          blocksAssignment: true,
        })
        break
      case 'STOP_LIMIT_ASSIGNMENT':
        out.push({
          action: a.action,
          scheduleTrigger: 'LIMIT_TRANSITION',
          reason: a.reason,
          maskedAccountId: a.maskedAccountId,
          failClosed: true,
          blocksAssignment: true,
        })
        break
      case 'PRESERVE_REQUEUE_UNFINISHED':
        out.push({
          action: a.action,
          scheduleTrigger: 'REQUEUE',
          reason: a.reason,
          maskedAccountId: a.maskedAccountId,
          failClosed: true,
          blocksAssignment: false,
        })
        break
      case 'ROTATE_LIMIT_ACCOUNT':
        out.push({
          action: a.action,
          scheduleTrigger: 'ROTATION',
          reason: a.reason,
          maskedAccountId: a.maskedAccountId,
          failClosed: true,
          blocksAssignment: false,
        })
        break
      default: {
        const _exhaustive: never = a.action
        void _exhaustive
      }
    }
  }
  return out
}

/**
 * Assignment-boundary gate for failSafeActions (register/dispatch).
 * Honors STOP_NEW_DISPATCH, BOUNDED_DRAIN_REDUCE, and STOP_LIMIT_ASSIGNMENT
 * for the requested masked account. Does not execute requeue/rotate.
 */
export function evaluateFailSafeAssignmentGate(
  actions: ReadonlyArray<CapacityFailSafeAction> | null | undefined,
  opts?: { maskedAccountRef?: string | null },
): CapacityFailSafeAssignmentGate {
  if (!actions || actions.length === 0) {
    return { blocked: false, reason: null, action: null }
  }
  const intents = planCapacityFailSafeIntents(actions)
  const stopDispatch = intents.find(
    (i) =>
      i.blocksAssignment &&
      (i.action === 'STOP_NEW_DISPATCH' || i.action === 'BOUNDED_DRAIN_REDUCE'),
  )
  if (stopDispatch) {
    return {
      blocked: true,
      reason: stopDispatch.reason || CAP_REASON_FAIL_SAFE_STOP_DISPATCH,
      action: stopDispatch.action,
    }
  }
  const ref = opts?.maskedAccountRef
  if (ref != null && String(ref).trim() !== '') {
    const stopLimit = intents.find(
      (i) =>
        i.action === 'STOP_LIMIT_ASSIGNMENT' &&
        i.maskedAccountId === ref &&
        i.blocksAssignment,
    )
    if (stopLimit) {
      return {
        blocked: true,
        reason: stopLimit.reason || CAP_REASON_FAIL_SAFE_STOP_LIMIT,
        action: stopLimit.action,
        maskedAccountId: stopLimit.maskedAccountId,
      }
    }
  }
  return { blocked: false, reason: null, action: null }
}

/**
 * True when all four family remaining fields are present as finite non-negative
 * numbers. Full CapacityPolicyResult always supplies them; partial caller
 * snapshots that omit them must fail closed when dispatch is allowed (M2).
 */
export function hasCompleteFamilyRemainings(capacity: unknown): boolean {
  if (capacity == null || typeof capacity !== 'object') return false
  const c = capacity as Record<string, unknown>
  return (
    isFiniteNonNegativeRemaining(c.sparkUsableCapacity) &&
    isFiniteNonNegativeRemaining(c.solUsableCapacity) &&
    isFiniteNonNegativeRemaining(c.otherUsableCapacity) &&
    isFiniteNonNegativeRemaining(c.healthyGrokUsableCapacity)
  )
}

function isFiniteNonNegativeRemaining(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * Pure authorization helper: decide whether a requested provider may receive
 * new work from a capacity report. Callers (C2A register/dispatch wiring) MUST
 * call this at the real assignment boundary — this module does not wire it.
 *
 * Model strings may be supplied for convenience; providerKind wins when both set.
 *
 * Provider-specific remaining headroom (AC-CAP residual repair):
 * - SPARK requires sparkUsableCapacity > 0 (cannot consume SOL-only residual)
 * - SOL requires solUsableCapacity > 0 (cannot consume SPARK-only residual)
 * - OTHER requires otherUsableCapacity > 0
 * - GROK requires grokAssignmentAllowed + healthyGrokUsableCapacity > 0
 * When dispatchAllowed is true, missing family remaining fields fail closed
 * (FAMILY_REMAINING_REQUIRED) — no soft flag-only path (M2). Present zero/NaN
 * still deny via the provider-specific remaining codes.
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
  > &
    Partial<
      Pick<
        CapacityPolicyResult,
        | 'sparkUsableCapacity'
        | 'solUsableCapacity'
        | 'otherUsableCapacity'
        | 'healthyGrokUsableCapacity'
        | 'failSafeActions'
      >
    >,
  request: {
    providerKind?: AccountProviderKind
    /** Optional model id; mapped when providerKind omitted. */
    model?: string
    /** When set, STOP_LIMIT_ASSIGNMENT for this masked account denies. */
    maskedAccountRef?: string | null
  },
): ProviderAssignmentDecision {
  const providerKind =
    request.providerKind ??
    (request.model != null
      ? resolveProviderKindFromModel(request.model)
      : 'OTHER')

  if (capacity.dispatchMode === 'BLOCKED' || !capacity.dispatchAllowed) {
    const preferred =
      [
        CAP_REASON_GROK_MAJORITY_NO_RECOVERY,
        'CPU_GT_95',
        'ACCOUNT_SYNC_STALE',
        'ACCOUNTS_ALL_FORBIDDEN',
        'FILLER_FORBIDDEN',
      ].find((reason) => capacity.limitingReasons.includes(reason)) ||
      capacity.limitingReasons[0] ||
      CAP_REASON_ASSIGNMENT_BLOCKED
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: preferred,
    }
  }

  // Fail-safe assignment gate (STOP_NEW_DISPATCH / BOUNDED_DRAIN / STOP_LIMIT).
  const failSafeGate = evaluateFailSafeAssignmentGate(
    capacity.failSafeActions,
    {
      maskedAccountRef: request.maskedAccountRef,
    },
  )
  if (failSafeGate.blocked) {
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason:
        failSafeGate.action === 'STOP_LIMIT_ASSIGNMENT'
          ? CAP_REASON_FAIL_SAFE_STOP_LIMIT
          : (failSafeGate.reason ?? CAP_REASON_FAIL_SAFE_STOP_DISPATCH),
    }
  }

  // M2: when dispatch is allowed, family remainings are mandatory (no soft path).
  if (!hasCompleteFamilyRemainings(capacity)) {
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: CAP_REASON_FAMILY_REMAINING_REQUIRED,
    }
  }

  const sparkRem = readOptionalRemaining(capacity.sparkUsableCapacity)
  const solRem = readOptionalRemaining(capacity.solUsableCapacity)
  const otherRem = readOptionalRemaining(capacity.otherUsableCapacity)
  const grokRem = readOptionalRemaining(capacity.healthyGrokUsableCapacity)

  if (providerKind === 'GROK') {
    if (!capacity.grokAssignmentAllowed) {
      return {
        allowed: false,
        providerKind,
        dispatchMode: capacity.dispatchMode,
        reason: CAP_REASON_PROVIDER_NOT_ALLOWED,
      }
    }
    if (grokRem !== null && grokRem <= 0) {
      return {
        allowed: false,
        providerKind,
        dispatchMode: capacity.dispatchMode,
        reason: CAP_REASON_GROK_NO_REMAINING,
      }
    }
    return {
      allowed: true,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason:
        capacity.dispatchMode === 'GROK_ONLY'
          ? CAP_REASON_GROK_ONLY_RECOVERY
          : null,
    }
  }

  // Spark / SOL / OTHER — GROK_ONLY or family flag still coarse-deny first.
  if (
    capacity.dispatchMode === 'GROK_ONLY' ||
    !capacity.nonGrokAssignmentAllowed
  ) {
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

  // Provider-specific remaining: SPARK cannot consume SOL-only headroom and vice versa.
  if (providerKind === 'SPARK') {
    if (sparkRem !== null && sparkRem <= 0) {
      return {
        allowed: false,
        providerKind,
        dispatchMode: capacity.dispatchMode,
        reason: CAP_REASON_SPARK_NO_REMAINING,
      }
    }
    return {
      allowed: true,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: null,
    }
  }

  if (providerKind === 'SOL') {
    if (solRem !== null && solRem <= 0) {
      return {
        allowed: false,
        providerKind,
        dispatchMode: capacity.dispatchMode,
        reason: CAP_REASON_SOL_NO_REMAINING,
      }
    }
    return {
      allowed: true,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: null,
    }
  }

  // OTHER
  if (otherRem !== null && otherRem <= 0) {
    return {
      allowed: false,
      providerKind,
      dispatchMode: capacity.dispatchMode,
      reason: CAP_REASON_OTHER_NO_REMAINING,
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
 * Finite remaining number, or null when field omitted.
 * Callers that require complete family fields must gate via
 * hasCompleteFamilyRemainings first (register path always does).
 */
function readOptionalRemaining(value: unknown): number | null {
  if (value === undefined || value === null) return null
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0
  return Math.max(0, value)
}

/**
 * Exact supported model identities → provider kind (no substring heuristics).
 * Contractual identities only (AC-CAP / orchestrator):
 *   grok-4.5, gpt-5.3-codex-spark, gpt-5.6-sol
 * Any other string (including names containing "grok"/"spark"/"sol") → OTHER.
 */
export const SUPPORTED_MODEL_PROVIDER: Readonly<
  Record<string, AccountProviderKind>
> = {
  'grok-4.5': 'GROK',
  'gpt-5.3-codex-spark': 'SPARK',
  'gpt-5.6-sol': 'SOL',
}

/** Exact model → provider mapping; unknown/partial/substring names never become Grok. */
export function resolveProviderKindFromModel(
  model: string,
): AccountProviderKind {
  if (typeof model !== 'string') return 'OTHER'
  const key = model.trim()
  return SUPPORTED_MODEL_PROVIDER[key] ?? 'OTHER'
}

function normalizeAccount(
  a: SyncAccountsRequest['accounts'][number],
): MaskedAccountRecord {
  // Reject secret-like fields if sneaked into reason (masked only contract)
  if (a.maskedAccountId && /token|password|secret/i.test(a.maskedAccountId)) {
    throw new AccountSyncError(
      'DATA_INTEGRITY',
      'maskedAccountId must not look like a secret',
    )
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
    expiresAt: a.expiresAt ?? null,
    quotaRemaining: a.quotaRemaining ?? null,
    quotaVerdict: a.quotaVerdict ?? 'UNKNOWN',
    chatVerdict: a.chatVerdict ?? 'UNKNOWN',
    probedAt: a.probedAt ?? null,
    probeAgeSeconds: a.probeAgeSeconds ?? null,
    adaptiveCap: Math.min(20, Math.max(0, a.adaptiveCap ?? a.effectiveCap)),
    quarantineReason: a.quarantineReason ?? null,
  }
}

/**
 * Normalize one masked account for sync_accounts idempotency hashing.
 * Includes every capacity-affecting field (status/provider/inUse/cap) plus
 * identity/display fields that define the published snapshot.
 */
export function normalizeMaskedAccountForHash(
  a: SyncAccountsRequest['accounts'][number] | MaskedAccountRecord,
): Record<string, unknown> {
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
    expiresAt: a.expiresAt ?? null,
    quotaRemaining: a.quotaRemaining ?? null,
    quotaVerdict: a.quotaVerdict ?? 'UNKNOWN',
    chatVerdict: a.chatVerdict ?? 'UNKNOWN',
    probedAt: a.probedAt ?? null,
    probeAgeSeconds: a.probeAgeSeconds ?? null,
    adaptiveCap: Math.min(20, Math.max(0, a.adaptiveCap ?? a.effectiveCap)),
    quarantineReason: a.quarantineReason ?? null,
  }
}

/**
 * Canonical material request body for sync_accounts idempotency.
 * Every field that affects capacity/result must be present:
 * health (cpu/ram/load), genuineReadyPacketCount, accounts (+ per-account caps),
 * trigger, revs, pin hash, callerRole. idempotencyKey is scope-only;
 * currentPinHash is CAS-only (not body-hashed).
 */
export function syncAccountsIdempotencyBody(
  req: SyncAccountsRequest,
): Record<string, unknown> {
  const health =
    req.health == null
      ? null
      : {
          cpuPercent: req.health.cpuPercent,
          ramHealthy: req.health.ramHealthy !== false,
          loadHealthy: req.health.loadHealthy !== false,
          memAvailableGiB: req.health.memAvailableGiB ?? null,
          observedWorkerRssP95MiB: req.health.observedWorkerRssP95MiB ?? null,
          cpuOver95Samples: req.health.cpuOver95Samples ?? null,
          hostLoad1m: req.health.hostLoad1m ?? null,
          pidCount: req.health.pidCount ?? null,
          acceptedTerminalYieldPercent:
            req.health.acceptedTerminalYieldPercent ?? null,
          missingHeartbeatPercent: req.health.missingHeartbeatPercent ?? null,
          infrastructureFailurePercent:
            req.health.infrastructureFailurePercent ?? null,
          collisionDetected: req.health.collisionDetected === true,
        }
  const compatibilityReq: Partial<SyncAccountsRequest> = req
  return {
    boardId: req.boardId,
    sourceRevision: req.sourceRevision,
    generatedAt: req.generatedAt,
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    canonicalHash: String(compatibilityReq.canonicalHash ?? '').trim(),
    accounts: (compatibilityReq.accounts ?? []).map(
      normalizeMaskedAccountForHash,
    ),
    trigger: req.trigger,
    callerRole: req.callerRole,
    actorId: req.actorId ?? null,
    health,
    genuineReadyPacketCount:
      req.genuineReadyPacketCount == null ? null : req.genuineReadyPacketCount,
    accountsAllFlag: !!req.accountsAllFlag,
  }
}

/**
 * True when snapshot is already fail-closed (stale + usableCapacity 0).
 * Reason-only / compound-reason re-evals must not bump entityRev.
 */
export function isFailClosedStable(snap: {
  stale: boolean
  usableCapacity: number
}): boolean {
  return snap.stale === true && snap.usableCapacity === 0
}

/**
 * Material capacity/freshness transition: stale flag or usableCapacity change.
 * staleReason-only compounds are NOT material (avoids thrash amplifier).
 */
export function isMaterialAccountSyncTransition(
  prev: { stale: boolean; usableCapacity: number },
  next: { stale: boolean; usableCapacity: number },
): boolean {
  return (
    prev.stale !== next.stale || prev.usableCapacity !== next.usableCapacity
  )
}

export type AccountReadbackSurfaceMap = Partial<
  Record<
    'mcp' | 'api' | 'ui' | 'ops',
    { sourceRevision: number; generatedAt: string }
  >
>

/**
 * Coalesce multi-surface readback into a single CAS put (at most +1 entityRev).
 * Preserves exact sourceRevision+generatedAt per surface for parity audit.
 * No-op (no entityRev bump) when surfaces already match and fail-closed is stable.
 */
export async function recordAccountReadbacks(
  deps: AccountSyncDeps,
  opts: {
    boardId: string
    surfaces: AccountReadbackSurfaceMap
  },
): Promise<AccountSyncSnapshot> {
  return deps.accounts.withBoardLock(opts.boardId, async () => {
    const snap = await deps.accounts.get(opts.boardId)
    if (!snap) {
      throw new AccountSyncError(
        'INVALID_INPUT',
        'no account snapshot to read back',
      )
    }

    const nextSurfaces = { ...snap.readbackSurfaces }
    let surfacesChanged = false
    for (const surface of ACCOUNT_SYNC_READBACK_SURFACES) {
      const incoming = opts.surfaces[surface]
      if (!incoming) continue
      const prev = nextSurfaces[surface]
      if (
        prev &&
        prev.sourceRevision === incoming.sourceRevision &&
        prev.generatedAt === incoming.generatedAt
      ) {
        continue
      }
      nextSurfaces[surface] = {
        sourceRevision: incoming.sourceRevision,
        generatedAt: incoming.generatedAt,
      }
      surfacesChanged = true
    }

    const parity = surfacesHaveParity(
      nextSurfaces,
      snap.sourceRevision,
      snap.generatedAt,
    )
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

    const material = isMaterialAccountSyncTransition(
      { stale: snap.stale, usableCapacity: snap.usableCapacity },
      { stale, usableCapacity: capacity.usableCapacity },
    )

    // No surface delta and no material transition → exact no-op (incl. already-stale).
    if (!surfacesChanged && !material) {
      return snap
    }

    // Already fail-closed with only non-material churn → still no entityRev put.
    if (
      !surfacesChanged &&
      isFailClosedStable(snap) &&
      isFailClosedStable({ stale, usableCapacity: capacity.usableCapacity })
    ) {
      return snap
    }

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

/**
 * Record one surface readback. Prefer recordAccountReadbacks for fan-out of all four
 * so entityRev churn is bounded to +1 per publish, not +4.
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
  return recordAccountReadbacks(deps, {
    boardId: opts.boardId,
    surfaces: {
      [opts.surface]: {
        sourceRevision: opts.sourceRevision,
        generatedAt: opts.generatedAt,
      },
    },
  })
}

/** Exact multi-surface parity: all four must match sourceRevision+generatedAt. */
export function surfacesHaveParity(
  surfaces: AccountSyncSnapshot['readbackSurfaces'],
  sourceRevision: number,
  generatedAt: string,
): boolean {
  const keys: Array<keyof typeof surfaces> = ['mcp', 'api', 'ui', 'ops']
  for (const k of keys) {
    const s = surfaces[k]
    if (!s) return false
    if (s.sourceRevision !== sourceRevision || s.generatedAt !== generatedAt)
      return false
  }
  return true
}

/** Canonical readback surface order for MCP/API/UI/Ops publication. */
export const ACCOUNT_SYNC_READBACK_SURFACES = [
  'mcp',
  'api',
  'ui',
  'ops',
] as const
export type AccountSyncReadbackSurface =
  (typeof ACCOUNT_SYNC_READBACK_SURFACES)[number]

/**
 * Triggers that may be coalesced by the publication scheduler.
 * Only HEARTBEAT may coalesce; newest must still publish within ACCOUNT_PUBLISH_SLA_MS.
 */
export function isCoalescableAccountSyncTrigger(
  trigger: AccountSyncTrigger,
): boolean {
  return trigger === 'HEARTBEAT'
}

/** Immediate (non-coalesced) mandatory publication triggers. */
export function isImmediateAccountSyncTrigger(
  trigger: AccountSyncTrigger,
): boolean {
  return !isCoalescableAccountSyncTrigger(trigger)
}

async function applyDispatchBlock(
  deps: AccountSyncDeps,
  boardId: string,
  snap: AccountSyncSnapshot,
): Promise<void> {
  const board = await deps.atomic.getBoardState(boardId)
  if (snap.stale || (snap.usableCapacity === 0 && snap.staleReason)) {
    await deps.atomic.setBoardState({
      ...board,
      dispatchBlocked: snap.stale,
      dispatchBlockedReason: snap.stale
        ? `ACCOUNT_SYNC_STALE: ${snap.staleReason}`
        : board.dispatchBlockedReason,
    })
  } else {
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
    throw new AccountSyncError(
      'INVALID_INPUT',
      'generatedAt must be ISO timestamp',
    )
  }
  if (!Number.isInteger(req.sourceRevision) || req.sourceRevision < 0) {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'sourceRevision must be non-negative integer',
    )
  }
  if (
    typeof req.entityExpectedRev !== 'number' ||
    !Number.isInteger(req.entityExpectedRev) ||
    req.entityExpectedRev < 0
  ) {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'entityExpectedRev is required (create=0, update=current) — no silent default',
    )
  }
  if (
    typeof req.expectedBoardRev !== 'number' ||
    !Number.isInteger(req.expectedBoardRev)
  ) {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'expectedBoardRev is required — no silent default',
    )
  }
  if (!req.canonicalHash || !String(req.canonicalHash).trim()) {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'canonicalHash is required (current pin hash)',
    )
  }
  if (!req.idempotencyKey || !String(req.idempotencyKey).trim()) {
    throw new AccountSyncError('INVALID_INPUT', 'idempotencyKey is required')
  }
  if (
    req.currentPinHash != null &&
    req.currentPinHash !== '' &&
    req.currentPinHash !== req.canonicalHash
  ) {
    throw new AccountSyncError(
      'STALE_REVISION',
      'canonical hash mismatch vs current pin',
      {
        expectedCanonicalHash: req.canonicalHash,
        currentPinHash: req.currentPinHash,
      },
    )
  }

  const accounts = req.accounts.map(normalizeAccount)

  // Idempotency first so exact replays succeed without re-CAS on boardRev.
  // Hash covers health + genuineReadyPacketCount + every capacity/result field.
  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: req.actorId ?? req.callerRole,
        boardId: req.boardId,
        endpoint: 'sync_accounts',
        key: req.idempotencyKey,
      },
      requestBody: syncAccountsIdempotencyBody(req),
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new AccountSyncError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }

  if (begin.kind === 'REPLAY' && begin.record) {
    return {
      ...(begin.record.responseBody as SyncAccountsResult),
      replayed: true,
    }
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
      const prev = await deps.accounts.get(req.boardId)
      // Create semantics: no prior snapshot → entityExpectedRev must be 0.
      // Update semantics: CAS current entityRev.
      if (!prev) {
        if (req.entityExpectedRev !== 0) {
          throw new AccountSyncError(
            'STALE_REVISION',
            'sync_accounts create requires entityExpectedRev 0',
            { entityExpectedRev: req.entityExpectedRev, currentEntityRev: 0 },
          )
        }
      } else if (req.entityExpectedRev !== prev.entityRev) {
        throw new AccountSyncError(
          'STALE_REVISION',
          'entity rev mismatch on sync_accounts',
          {
            entityExpectedRev: req.entityExpectedRev,
            currentEntityRev: prev.entityRev,
          },
        )
      }

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
        nowMs: generatedAtMs,
      })

      const snap: AccountSyncSnapshot = {
        boardId: req.boardId,
        sourceRevision: req.sourceRevision,
        generatedAt: req.generatedAt,
        generatedAtMs,
        accounts,
        readbackSurfaces: { mcp: null, api: null, ui: null, ops: null },
        publishedAtMs: now,
        lastPeriodicHealthAtMs: req.trigger === 'PERIODIC_HEALTH' ? now : null,
        stale: false,
        staleReason: null,
        usableCapacity: capacity.usableCapacity,
        capacity,
        entityRev: prev ? prev.entityRev + 1 : 1,
      }

      // Preserve lastPeriodic if not this trigger
      if (prev && req.trigger !== 'PERIODIC_HEALTH') {
        snap.lastPeriodicHealthAtMs = prev.lastPeriodicHealthAtMs
      }

      await deps.accounts.put(snap)
      // Single board-rev bump per successful non-replay write.
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

    await completeIdempotent(
      deps.idempotency,
      begin.scopeHash,
      200,
      result,
      begin.requestHash,
    )
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

    // Material transition only (stale flag / usableCapacity). Already stale+usable0
    // with only staleReason compound/repeat → no entityRev put (thrash amplifier fix).
    const material = isMaterialAccountSyncTransition(
      { stale: snap.stale, usableCapacity: snap.usableCapacity },
      { stale, usableCapacity: capacity.usableCapacity },
    )
    if (!material) {
      return snap
    }

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
  })
}

export function createMemoryAccountSyncStore(): AccountSyncStore & {
  snapshot: () => Array<AccountSyncSnapshot>
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
      chains.set(
        boardId,
        prev.then(() => gate),
      )
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

export function setSharedAccountSyncStore(
  store: AccountSyncStore | null,
): void {
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
