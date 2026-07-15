/**
 * Run registry: exact states/defaults, register + heartbeat with fencing,
 * lease, monotonic sequence, terminal/history preservation.
 * Heartbeats update hot state only — no immutable audit per heartbeat.
 */
import { createHash, randomUUID } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  acquireCollisionLocks,
  releaseCollisionLocks,
  renewCollisionLocks,
  type LockStore,
  LockError,
} from './locks'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'
import {
  authorizeProviderAssignment,
  evaluateFailSafeAssignmentGate,
  hasCompleteFamilyRemainings,
  planCapacityFailSafeIntents,
  type CapacityFailSafeAction,
  type CapacityFailSafeIntent,
  type CapacityPolicyResult,
  CAP_REASON_FAMILY_REMAINING_REQUIRED,
  CAP_REASON_FAIL_SAFE_STOP_DISPATCH,
  CAP_REASON_FAIL_SAFE_STOP_LIMIT,
} from './account-sync'
import {
  applyHeartbeatWithOptionalCompaction,
  applyHeartbeatWithOptionalCompactionAsync,
  type BoardPolicyRetention,
  type CompactionResult,
  type HeartbeatApplyResult,
  type RetentionAsyncStore,
  type RetentionStore,
} from './audit-retention'

// ---- constants (V3 defaults) ----

export const RUN_VISIBLE_SLA_MS = 30_000
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000
export const RUN_LEASE_MS = 60_000
export const RUN_RECONCILIATION_GRACE_MS = 30_000
export const RUN_STALL_MS = 10 * 60_000
export const CP0_CONTROL_PLANE_VERSION = 'CP0_CONTROL_PLANE_V1' as const

export type RunHierarchyLevel = 'L0' | 'L1' | 'L2'
export type ControlPlaneAckType = 'REGISTRATION' | 'SPAWN_BUDGET' | 'LEASE_RENEWAL' | 'TERMINAL' | 'RELEASE'
export interface ControlPlaneAck {
  version: typeof CP0_CONTROL_PLANE_VERSION
  ackType: ControlPlaneAckType
  ackId: string
  runId: string
  at: string
  entityRev: number
  boardRev: number
}

export type RunState =
  | 'QUEUED'
  | 'RESERVED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING_HUMAN'
  | 'SUCCEEDED'
  | 'FAILED'
  | 'CANCELLED'
  | 'STALE'
  | 'SUPERSEDED'

export const TERMINAL_RUN_STATES: ReadonlyArray<RunState> = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
  'SUPERSEDED',
] as const

export const LEASED_RUN_STATES: ReadonlyArray<RunState> = [
  'RESERVED',
  'STARTING',
  'RUNNING',
  'WAITING_HUMAN',
] as const

export type RunErrorCode =
  | 'STALE_REVISION'
  | 'FENCED'
  | 'LEASE_EXPIRED'
  | 'RUN_NOT_REGISTERED'
  | 'CLAIM_COLLISION'
  | 'IDEMPOTENCY_CONFLICT'
  | 'AUTHORIZATION_REQUIRED'
  | 'INVALID_INPUT'
  | 'DISPATCH_BLOCKED'
  | 'INVALID_STATE'
  | 'ACCOUNT_SYNC_STALE'

export class RunRegistryError extends Error {
  readonly code: RunErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: RunErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'RunRegistryError'
    this.code = code
    this.details = details
  }
}

export interface RunRecord {
  boardId: string
  runId: string
  state: RunState
  planId: string | null
  planItemRank: number | null
  taskId: string
  targetGate: string
  role: string
  agentId: string
  model: string
  effort: string
  maskedAccountRef: string | null
  canonicalHash: string | null
  collisionScopeLockIds: Array<string>
  fencingToken: string | null
  fencingVersion: number
  /** QUEUED has no lease/claim. */
  registeredAtMs: number | null
  heartbeatAtMs: number | null
  leaseExpiresAtMs: number | null
  materialProgressAtMs: number | null
  heartbeatSequence: number
  expectedEntityRev: number
  expectedBoardRev: number
  entityRev: number
  boardRev: number
  stalled: boolean
  history: Array<RunHistoryEntry>
  /** Last heartbeat response for duplicate sequence replay. */
  lastHeartbeatResponse: HeartbeatRunResult | null
  controllerRunId: string | null
  parentRunId: string | null
  controlPlaneVersion?: typeof CP0_CONTROL_PLANE_VERSION | 'LEGACY_V3'
  hierarchyLevel?: RunHierarchyLevel | null
  spawnBudgetMax?: number
  spawnAuthorizationId?: string | null
  registrationAck?: ControlPlaneAck | null
  budgetAck?: ControlPlaneAck | null
  terminalAck?: ControlPlaneAck | null
  releaseAck?: ControlPlaneAck | null
  idempotencyKey: string | null
}

export interface RunHistoryEntry {
  atMs: number
  atISO: string
  fromState: RunState | null
  toState: RunState
  reason: string
  actorId: string | null
}

export interface RunRegistryStore {
  get(boardId: string, runId: string): Promise<RunRecord | null>
  put(rec: RunRecord): Promise<void>
  list(boardId: string): Promise<Array<RunRecord>>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

/**
 * Capacity snapshot shape used by provider-assignment authorization.
 * Production loads this exclusively via RunRegistryDeps.getCapacity (M2).
 * Unit tests may supply a fixed snapshot only through
 * {@link createTestCapacityInjection} on RunRegistryDeps — never via request body.
 */
export type RegisterRunCapacity =
  | (Pick<
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
      >)
  | null

/**
 * Symbol brand for test-only capacity injection (R3).
 * Symbol keys do not survive JSON/MCP serialization, so untrusted request
 * bodies cannot forge this capability even if they nest a look-alike object.
 */
export const TEST_CAPACITY_INJECTION = Symbol.for(
  'cairn.runRegistry.testCapacityInjection',
)

/**
 * Explicit internal test capability. Construct only via
 * {@link createTestCapacityInjection} / {@link withTestCapacityInjection}.
 * Must never be populated from HTTP/MCP/serialized request deserialization.
 */
export type TestCapacityInjectionCapability = {
  readonly [TEST_CAPACITY_INJECTION]: true
  readonly capacity: RegisterRunCapacity
}

export function createTestCapacityInjection(
  capacity: RegisterRunCapacity,
): TestCapacityInjectionCapability {
  return {
    [TEST_CAPACITY_INJECTION]: true,
    capacity,
  }
}

export function isTestCapacityInjectionCapability(
  value: unknown,
): value is TestCapacityInjectionCapability {
  return (
    typeof value === 'object' &&
    value !== null &&
    (value as Record<PropertyKey, unknown>)[TEST_CAPACITY_INJECTION] === true &&
    'capacity' in value
  )
}

/** Clone deps with a Symbol-branded test capacity inject (unit tests only). */
export function withTestCapacityInjection(
  deps: RunRegistryDeps,
  capacity: RegisterRunCapacity,
): RunRegistryDeps {
  return {
    ...deps,
    testCapacityInjection: createTestCapacityInjection(capacity),
  }
}

/**
 * Public register_run request. Intentionally omits capacity / inject flags:
 * those must never be forwarded from runtime API/MCP/serialized untrusted input (R3).
 * Capacity source = deps.getCapacity, or deps.testCapacityInjection in unit tests.
 */
export interface RegisterRunRequest {
  boardId: string
  runId: string
  planId?: string | null
  planItemRank?: number | null
  taskId: string
  targetGate: string
  role?: string
  agentId: string
  model: string
  effort?: string
  maskedAccountRef?: string | null
  /** Required pin/canonical subject hash (full envelope). */
  canonicalHash: string
  /** When set (MCP pin), must equal canonicalHash. */
  currentPinHash?: string | null
  collisionScopeLockIds?: Array<string>
  /** Create requires 0 — no silent default. */
  expectedEntityRev: number
  expectedBoardRev: number
  idempotencyKey: string
  /** Initial state: QUEUED (no lease) or RESERVED/STARTING (with lease). Default STARTING. */
  initialState?: 'QUEUED' | 'RESERVED' | 'STARTING' | 'RUNNING'
  actorRole?: 'AGENT' | 'ROOT_ORCHESTRATOR' | string
  controlPlaneVersion?: typeof CP0_CONTROL_PLANE_VERSION
  hierarchyLevel?: RunHierarchyLevel
  controllerRunId?: string | null
  parentRunId?: string | null
  spawnBudgetMax?: number
  spawnAuthorizationId?: string | null
}

export interface RegisterRunResult {
  runId: string
  state: RunState
  fencingToken: string | null
  leaseExpiresAt: string | null
  registeredAt: string | null
  entityRev: number
  boardRev: number
  replayed: boolean
  visibleWithinMs: number
  controlPlaneVersion: typeof CP0_CONTROL_PLANE_VERSION | 'LEGACY_V3'
  hierarchyLevel: RunHierarchyLevel | null
  controllerRunId: string | null
  parentRunId: string | null
  spawnBudgetMax: number
  registrationAck: ControlPlaneAck | null
  budgetAck: ControlPlaneAck | null
}

export interface HeartbeatRunRequest {
  boardId: string
  runId: string
  agentId: string
  fencingToken: string
  heartbeatSequence: number
  materialProgressAt?: string | null
  expectedEntityRev: number
  expectedBoardRev: number
  /** 24h idempotency — required for full AC-API-03 enforcement. */
  idempotencyKey: string
  /** Required pin/canonical subject hash (full envelope). */
  canonicalHash: string
  currentPinHash?: string | null
}

export interface HeartbeatRunResult {
  runId: string
  state: RunState
  leaseExpiresAt: string | null
  heartbeatAt: string
  heartbeatSequence: number
  replayed: boolean
  stalled: boolean
  materialProgressAt: string | null
  entityRev: number
  boardRev: number
  leaseAck?: ControlPlaneAck
}

/**
 * Optional BoardPolicy retention binding for live heartbeat path (AC-OPS-04/05).
 * Absent/null → skip domain retention (never invent production policy here).
 * Ordinary heartbeats update hot/sampled state only; materialProgress → immutable
 * MATERIAL in RetentionStore. Compaction runs on policy.compactionIntervalMs.
 * Memory/test only — MySQL must use retentionAsync (no process-local invent).
 */
export interface RunRegistryRetentionBinding {
  store: RetentionStore
  policy: BoardPolicyRetention
  /** Mutable compaction watermark (ms). Updated after successful compaction. */
  lastCompactionAtMs?: number
  /** Optional observer for compaction results (metrics/tests). */
  onCompacted?: (result: CompactionResult) => void
  /** Optional observer for domain applyHeartbeat results (tests). */
  onHeartbeatRetention?: (result: HeartbeatApplyResult) => void
}

/**
 * Durable MySQL retention binding for heartbeatRun (async).
 * Uses RetentionAsyncStore (runtime.retentionAsync) — no process-local Maps.
 * Compaction watermark is durable (multi-instance); deletions are bounded + idempotent.
 * Never invents policy — caller supplies already-resolved BoardPolicy.
 */
export interface RunRegistryRetentionAsyncBinding {
  store: RetentionAsyncStore
  policy: BoardPolicyRetention
  /**
   * Optional process hint only; durable watermark in store wins when higher.
   * Prefer omitting so multi-instance does not diverge on process memory.
   */
  lastCompactionAtMs?: number
  /** Cap deletions per compaction pass (default 100). */
  maxCompactionActions?: number
  onCompacted?: (
    result: CompactionResult & { truncated: boolean; maxActionsPerRun: number },
  ) => void
  onHeartbeatRetention?: (result: HeartbeatApplyResult) => void
}

export interface RunRegistryDeps {
  clock: ControlPlaneClock
  runs: RunRegistryStore
  locks: LockStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
  /**
   * Capacity loader for provider assignment gate. Production ALWAYS uses this (M2).
   * Missing loader without test inject = fail closed.
   */
  getCapacity?: (
    boardId: string,
  ) => Promise<RegisterRunCapacity> | RegisterRunCapacity
  /**
   * Test-only capacity inject. Must be a Symbol-branded capability from
   * {@link createTestCapacityInjection}. Never deserialize from request JSON/MCP.
   * Production defaultRunDeps / MCP wire MUST leave this undefined.
   */
  testCapacityInjection?: TestCapacityInjectionCapability
  /**
   * Sync domain retention (memory/test). Not for MySQL multi-instance.
   * PRODUCTION without DECISION_HEARTBEAT_RETENTION_POLICY stays fail-closed.
   */
  retention?: RunRegistryRetentionBinding | null
  /**
   * Durable async retention (MySQL retentionAsync path). Preferred for mysql mode.
   * When both retention and retentionAsync are set, retentionAsync wins.
   */
  retentionAsync?: RunRegistryRetentionAsyncBinding | null
}

function isTerminal(s: RunState): boolean {
  return (TERMINAL_RUN_STATES as ReadonlyArray<string>).includes(s)
}

function isLeased(s: RunState): boolean {
  return (LEASED_RUN_STATES as ReadonlyArray<string>).includes(s)
}

function requestHash(body: unknown): string {
  const stable = (v: unknown): string => {
    if (v === null || typeof v !== 'object') return JSON.stringify(v)
    if (Array.isArray(v)) return `[${v.map(stable).join(',')}]`
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stable(o[k])}`)
      .join(',')}}`
  }
  return createHash('sha256').update(stable(body)).digest('hex')
}

function controlPlaneAck(
  ackType: ControlPlaneAckType,
  runId: string,
  at: string,
  entityRev: number,
  boardRev: number,
): ControlPlaneAck {
  const ackId = `ack-${createHash('sha256')
    .update(`${CP0_CONTROL_PLANE_VERSION}\0${ackType}\0${runId}\0${entityRev}\0${boardRev}`)
    .digest('hex')
    .slice(0, 32)}`
  return { version: CP0_CONTROL_PLANE_VERSION, ackType, ackId, runId, at, entityRev, boardRev }
}

/**
 * Canonical idempotency request body for register_run.
 * Covers every material request/envelope field except idempotencyKey itself.
 * Same key + any material difference (incl. initialState/role/revisions) →
 * IDEMPOTENCY_CONFLICT; exact same → replay / no board-rev bump.
 */
export function canonicalRegisterRunRequestBody(req: RegisterRunRequest): Record<string, unknown> {
  // R3: capacity / allowTestCapacityInjection are intentionally excluded — they are
  // not part of the public request surface and must not affect idempotency hashes
  // from untrusted serialized bodies.
  return {
    boardId: req.boardId,
    runId: req.runId,
    planId: req.planId ?? null,
    planItemRank: req.planItemRank ?? null,
    taskId: req.taskId,
    targetGate: req.targetGate,
    role: req.role ?? null,
    agentId: req.agentId,
    model: req.model,
    effort: req.effort ?? 'medium',
    maskedAccountRef: req.maskedAccountRef ?? null,
    canonicalHash: req.canonicalHash ?? null,
    currentPinHash: req.currentPinHash ?? null,
    collisionScopeLockIds: [...(req.collisionScopeLockIds ?? [])].sort(),
    expectedEntityRev: req.expectedEntityRev,
    expectedBoardRev: req.expectedBoardRev,
    initialState: req.initialState ?? 'STARTING',
    actorRole: req.actorRole ?? null,
    controlPlaneVersion: req.controlPlaneVersion ?? null,
    hierarchyLevel: req.hierarchyLevel ?? null,
    controllerRunId: req.controllerRunId ?? null,
    parentRunId: req.parentRunId ?? null,
    spawnBudgetMax: req.spawnBudgetMax ?? null,
    spawnAuthorizationId: req.spawnAuthorizationId ?? null,
  }
}

/**
 * Fail-closed usableCapacity gate: missing/undefined/NaN/non-finite/negative
 * never proceeds to authorizeProviderAssignment (W15-09 residual).
 */
export function isFiniteNonNegativeCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

/**
 * M2 + R3: production always uses deps.getCapacity.
 * Request-body capacity / allowTestCapacityInjection are NEVER honored (not on type).
 * Test inject is ONLY via Symbol-branded deps.testCapacityInjection from
 * createTestCapacityInjection — JSON/MCP cannot forge the brand.
 */
export async function resolveCapacitySource(
  deps: RunRegistryDeps,
  req: RegisterRunRequest,
): Promise<RegisterRunCapacity> {
  if (isTestCapacityInjectionCapability(deps.testCapacityInjection)) {
    return deps.testCapacityInjection.capacity
  }
  if (deps.getCapacity) {
    return deps.getCapacity(req.boardId)
  }
  return null
}

/**
 * M4: plan fail-safe intents from capacity (pure; no external side effects).
 * Exposed for register/scheduler tests and ops inspection.
 */
export function planRegisterFailSafeIntents(
  capacity: RegisterRunCapacity | null | undefined,
): Array<CapacityFailSafeIntent> {
  const actions = (capacity as { failSafeActions?: Array<CapacityFailSafeAction> } | null | undefined)
    ?.failSafeActions
  if (!actions || actions.length === 0) return []
  return planCapacityFailSafeIntents(actions)
}

/**
 * Capacity + provider authorization BEFORE idempotency / board lock / claim / audit.
 * Throws RunRegistryError AUTHORIZATION_REQUIRED on every fail-closed path.
 */
async function authorizeRegisterCapacity(
  deps: RunRegistryDeps,
  req: RegisterRunRequest,
): Promise<NonNullable<RegisterRunCapacity>> {
  const capacitySource = await resolveCapacitySource(deps, req)

  if (!capacitySource) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      'provider assignment denied: capacity unavailable',
      {
        reason: 'CAPACITY_UNAVAILABLE',
        dispatchMode: 'BLOCKED',
        usableCapacity: 0,
      },
    )
  }

  const usable = (capacitySource as { usableCapacity?: unknown }).usableCapacity
  // missing / undefined / NaN / Infinity / negative → fail closed (not `<= 0` alone)
  if (!isFiniteNonNegativeCapacity(usable)) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      'provider assignment denied: usableCapacity invalid',
      {
        reason: 'CAPACITY_INVALID',
        dispatchMode: capacitySource.dispatchMode ?? 'BLOCKED',
        usableCapacity: 0,
      },
    )
  }

  // M4: honor STOP_NEW_DISPATCH / BOUNDED_DRAIN / STOP_LIMIT_ASSIGNMENT at boundary.
  const failSafeActions = (capacitySource as { failSafeActions?: Array<CapacityFailSafeAction> })
    .failSafeActions
  const failSafeGate = evaluateFailSafeAssignmentGate(failSafeActions, {
    maskedAccountRef: req.maskedAccountRef,
  })
  if (failSafeGate.blocked) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      `provider assignment denied: ${failSafeGate.reason ?? CAP_REASON_FAIL_SAFE_STOP_DISPATCH}`,
      {
        reason:
          failSafeGate.action === 'STOP_LIMIT_ASSIGNMENT'
            ? CAP_REASON_FAIL_SAFE_STOP_LIMIT
            : failSafeGate.reason ?? CAP_REASON_FAIL_SAFE_STOP_DISPATCH,
        action: failSafeGate.action,
        maskedAccountId: failSafeGate.maskedAccountId,
        dispatchMode: capacitySource.dispatchMode ?? 'BLOCKED',
        usableCapacity: usable,
        failSafeIntents: planRegisterFailSafeIntents(capacitySource),
      },
    )
  }

  // Stale / zero usable / blocked mode is fail-closed even if flags look OPEN.
  if (
    usable <= 0 ||
    !capacitySource.dispatchAllowed ||
    capacitySource.dispatchMode === 'BLOCKED'
  ) {
    const decision = authorizeProviderAssignment(
      { ...capacitySource, usableCapacity: usable },
      { model: req.model, maskedAccountRef: req.maskedAccountRef },
    )
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      `provider assignment denied: ${decision.reason ?? capacitySource.dispatchMode ?? 'BLOCKED'}`,
      {
        reason: decision.reason ?? 'CAPACITY_BLOCKED',
        providerKind: decision.providerKind,
        dispatchMode: capacitySource.dispatchMode,
        usableCapacity: usable,
      },
    )
  }

  // M2: dispatchAllowed requires complete family remainings (fail closed).
  if (!hasCompleteFamilyRemainings(capacitySource)) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      'provider assignment denied: family remainings required',
      {
        reason: CAP_REASON_FAMILY_REMAINING_REQUIRED,
        dispatchMode: capacitySource.dispatchMode ?? 'BLOCKED',
        usableCapacity: usable,
      },
    )
  }

  const decision = authorizeProviderAssignment(
    { ...capacitySource, usableCapacity: usable },
    { model: req.model, maskedAccountRef: req.maskedAccountRef },
  )
  if (!decision.allowed) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      `provider assignment denied: ${decision.reason ?? decision.dispatchMode}`,
      {
        reason: decision.reason,
        providerKind: decision.providerKind,
        dispatchMode: decision.dispatchMode,
        usableCapacity: usable,
      },
    )
  }

  return capacitySource
}

function assertCp0HierarchyRequest(req: RegisterRunRequest): void {
  if (req.controlPlaneVersion !== CP0_CONTROL_PLANE_VERSION) return
  const level = req.hierarchyLevel
  if (!level) throw new RunRegistryError('INVALID_INPUT', 'CP0 hierarchyLevel is required')
  const max = req.spawnBudgetMax ?? 0
  if (!Number.isInteger(max) || max < 0 || max > 20) {
    throw new RunRegistryError('INVALID_INPUT', 'spawnBudgetMax must be an integer from 0 to 20')
  }
  if (level === 'L0') {
    if (req.actorRole !== 'ROOT_ORCHESTRATOR') {
      throw new RunRegistryError('AUTHORIZATION_REQUIRED', 'L0 registration requires ROOT_ORCHESTRATOR')
    }
    if ((req.controllerRunId ?? req.runId) !== req.runId || req.parentRunId) {
      throw new RunRegistryError('INVALID_INPUT', 'L0 must self-control and have no parent')
    }
    return
  }
  if (!req.controllerRunId || !req.parentRunId || !req.spawnAuthorizationId) {
    throw new RunRegistryError(
      'AUTHORIZATION_REQUIRED',
      'L1/L2 registration requires controllerRunId, parentRunId, and spawnAuthorizationId',
    )
  }
  if (level === 'L2' && max !== 0) {
    throw new RunRegistryError('INVALID_INPUT', 'L2 cannot receive a descendant spawn budget')
  }
}

export async function registerRun(
  deps: RunRegistryDeps,
  req: RegisterRunRequest,
): Promise<RegisterRunResult> {
  if (!req.runId || !req.taskId || !req.agentId || !req.model) {
    throw new RunRegistryError('INVALID_INPUT', 'runId, taskId, agentId, model required')
  }
  if (!req.idempotencyKey) {
    throw new RunRegistryError('INVALID_INPUT', 'idempotencyKey required')
  }
  if (typeof req.expectedEntityRev !== 'number' || !Number.isInteger(req.expectedEntityRev)) {
    throw new RunRegistryError(
      'INVALID_INPUT',
      'expectedEntityRev is required (create=0) — no silent default',
    )
  }
  if (typeof req.expectedBoardRev !== 'number' || !Number.isInteger(req.expectedBoardRev)) {
    throw new RunRegistryError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!req.canonicalHash || !String(req.canonicalHash).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (
    req.currentPinHash != null &&
    req.currentPinHash !== '' &&
    req.currentPinHash !== req.canonicalHash
  ) {
    throw new RunRegistryError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: req.canonicalHash,
      currentPinHash: req.currentPinHash,
    })
  }
  // Create semantics: entity must not yet exist → expectedEntityRev === 0
  if (req.expectedEntityRev !== 0) {
    throw new RunRegistryError(
      'STALE_REVISION',
      'register_run create requires expectedEntityRev 0',
      { expectedEntityRev: req.expectedEntityRev, currentEntityRev: 0 },
    )
  }
  assertCp0HierarchyRequest(req)

  // Provider assignment authorization BEFORE idempotency / board lock / claim / audit (R5-02).
  // Missing/stale/null/NaN/non-finite/negative usable → fail closed; no optional bypass.
  await authorizeRegisterCapacity(deps, req)

  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: req.agentId,
        boardId: req.boardId,
        endpoint: 'register_run',
        key: req.idempotencyKey,
      },
      // Full material envelope — omit only idempotencyKey (scope key).
      // Must include initialState/role/revisions so same key + any change conflicts.
      requestBody: canonicalRegisterRunRequestBody(req),
      // Unique runId binding is owned by register_run only (not heartbeat / locks).
      runId: req.runId,
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }

  if (begin.kind === 'REPLAY' && begin.record) {
    const body = begin.record.responseBody as RegisterRunResult
    return { ...body, replayed: true }
  }

  const board = await deps.atomic.getBoardState(req.boardId)
  if (board.dispatchBlocked) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw new RunRegistryError(
      'DISPATCH_BLOCKED',
      board.dispatchBlockedReason ?? 'dispatch blocked (account sync stale)',
      { reason: board.dispatchBlockedReason },
    )
  }
  if (req.expectedBoardRev !== board.boardRev) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw new RunRegistryError('STALE_REVISION', `board rev mismatch: expected ${req.expectedBoardRev}, current ${board.boardRev}`, {
      expectedBoardRev: req.expectedBoardRev,
      currentBoardRev: board.boardRev,
    })
  }

  try {
    const result = await deps.runs.withBoardLock(req.boardId, async () => {
      const existing = await deps.runs.get(req.boardId, req.runId)
      if (existing) {
        // Unique runId: same payload already handled via idempotency; different = conflict
        throw new RunRegistryError('IDEMPOTENCY_CONFLICT', `runId already registered: ${req.runId}`, {
          runId: req.runId,
        })
      }

      if (req.controlPlaneVersion === CP0_CONTROL_PLANE_VERSION && req.hierarchyLevel !== 'L0') {
        const parent = await deps.runs.get(req.boardId, req.parentRunId!)
        const controller = await deps.runs.get(req.boardId, req.controllerRunId!)
        const expectedParentLevel: RunHierarchyLevel = req.hierarchyLevel === 'L1' ? 'L0' : 'L1'
        if (
          !parent ||
          !controller ||
          parent.controlPlaneVersion !== CP0_CONTROL_PLANE_VERSION ||
          controller.hierarchyLevel !== 'L0' ||
          parent.hierarchyLevel !== expectedParentLevel ||
          parent.controllerRunId !== controller.runId
        ) {
          throw new RunRegistryError('AUTHORIZATION_REQUIRED', 'invalid CP0 parent/controller lineage')
        }
        const siblings = (await deps.runs.list(req.boardId)).filter(
          (r) => r.parentRunId === parent.runId && !isTerminal(r.state),
        )
        const parentBudget = parent.spawnBudgetMax ?? 0
        if (siblings.length >= parentBudget) {
          throw new RunRegistryError('DISPATCH_BLOCKED', 'parent spawn budget exhausted', {
            parentRunId: parent.runId,
            spawnBudgetMax: parentBudget,
            activeChildren: siblings.length,
          })
        }
      }

      const now = deps.clock.nowMs()
      const initial: RunState = req.initialState ?? 'STARTING'
      const leased = isLeased(initial)
      let fencingToken: string | null = null
      let fencingVersion = 0

      if (leased && (req.collisionScopeLockIds?.length ?? 0) > 0) {
        try {
          const acq = await acquireCollisionLocks(deps.locks, deps.clock, {
            boardId: req.boardId,
            taskId: req.taskId,
            runId: req.runId,
            agentId: req.agentId,
            role: req.role ?? 'OTHER',
            collisionScopeLockIds: req.collisionScopeLockIds ?? [],
            leaseMs: RUN_LEASE_MS,
          })
          fencingToken = acq.fencingToken
          fencingVersion = acq.fencingVersion
        } catch (e) {
          if (e instanceof LockError) {
            throw new RunRegistryError(
              e.code === 'AUTHOR_VERIFIER_CONFLICT' ? 'CLAIM_COLLISION' : (e.code as RunErrorCode),
              e.message,
              e.details as Record<string, unknown>,
            )
          }
          throw e
        }
      } else if (leased) {
        fencingToken = `fence-${randomUUID()}`
        fencingVersion = 1
      }

      // QUEUED: no lease, no claim
      const controlPlaneVersion =
        req.controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
          ? CP0_CONTROL_PLANE_VERSION
          : ('LEGACY_V3' as const)
      const hierarchyLevel = controlPlaneVersion === CP0_CONTROL_PLANE_VERSION ? req.hierarchyLevel! : null
      const controllerRunId =
        hierarchyLevel === 'L0' ? req.runId : (req.controllerRunId ?? null)
      const parentRunId = hierarchyLevel === 'L0' ? null : (req.parentRunId ?? null)
      const registrationAck =
        controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
          ? controlPlaneAck('REGISTRATION', req.runId, deps.clock.nowISO(), 1, board.boardRev)
          : null
      const budgetAck =
        controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
          ? controlPlaneAck('SPAWN_BUDGET', req.runId, deps.clock.nowISO(), 1, board.boardRev)
          : null
      const rec: RunRecord = {
        boardId: req.boardId,
        runId: req.runId,
        state: initial,
        planId: req.planId ?? null,
        planItemRank: req.planItemRank ?? null,
        taskId: req.taskId,
        targetGate: req.targetGate,
        role: req.role ?? 'PRODUCT',
        agentId: req.agentId,
        model: req.model,
        effort: req.effort ?? 'medium',
        maskedAccountRef: req.maskedAccountRef ?? null,
        canonicalHash: req.canonicalHash ?? null,
        collisionScopeLockIds: [...(req.collisionScopeLockIds ?? [])],
        fencingToken: leased ? fencingToken : null,
        fencingVersion: leased ? fencingVersion : 0,
        registeredAtMs: leased || initial !== 'QUEUED' ? now : null,
        heartbeatAtMs: null,
        leaseExpiresAtMs: leased ? now + RUN_LEASE_MS : null,
        materialProgressAtMs: null,
        heartbeatSequence: 0,
        expectedEntityRev: req.expectedEntityRev,
        expectedBoardRev: req.expectedBoardRev,
        entityRev: 1,
        boardRev: board.boardRev,
        stalled: false,
        history: [
          {
            atMs: now,
            atISO: deps.clock.nowISO(),
            fromState: null,
            toState: initial,
            reason: 'register_run',
            actorId: req.agentId,
          },
        ],
        lastHeartbeatResponse: null,
        controllerRunId,
        parentRunId,
        controlPlaneVersion,
        hierarchyLevel,
        spawnBudgetMax: req.spawnBudgetMax ?? 0,
        spawnAuthorizationId: req.spawnAuthorizationId ?? null,
        registrationAck,
        budgetAck,
        terminalAck: null,
        releaseAck: null,
        idempotencyKey: req.idempotencyKey,
      }

      await deps.runs.put(rec)
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'RUN_REGISTERED',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.agentId,
        subjectType: 'run',
        subjectId: req.runId,
        detail: {
          state: initial,
          taskId: req.taskId,
          planId: req.planId ?? null,
          model: req.model,
          maskedAccountRef: req.maskedAccountRef ?? null,
          controlPlaneVersion,
          hierarchyLevel,
          controllerRunId,
          parentRunId,
          spawnBudgetMax: rec.spawnBudgetMax,
          registrationAckId: registrationAck?.ackId ?? null,
        },
        material: true,
      })
      if (initial === 'RUNNING' || initial === 'STARTING') {
        await deps.atomic.appendAudit({
          boardId: req.boardId,
          kind: 'RUN_FIRST_LIVE',
          atMs: now,
          atISO: deps.clock.nowISO(),
          actorId: req.agentId,
          subjectType: 'run',
          subjectId: req.runId,
          detail: { state: initial },
          material: true,
        })
      }

      return {
        runId: rec.runId,
        state: rec.state,
        fencingToken: rec.fencingToken,
        leaseExpiresAt: rec.leaseExpiresAtMs != null ? new Date(rec.leaseExpiresAtMs).toISOString() : null,
        registeredAt: rec.registeredAtMs != null ? new Date(rec.registeredAtMs).toISOString() : null,
        entityRev: rec.entityRev,
        boardRev: rec.boardRev,
        replayed: false,
        visibleWithinMs: RUN_VISIBLE_SLA_MS,
        controlPlaneVersion,
        hierarchyLevel,
        controllerRunId,
        parentRunId,
        spawnBudgetMax: rec.spawnBudgetMax ?? 0,
        registrationAck,
        budgetAck,
      } satisfies RegisterRunResult
    })

    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, result, begin.requestHash)
    return result
  } catch (e) {
    // leave idempotency in-progress cleared by not completing — delete for clean retry on non-conflict
    if (e instanceof RunRegistryError && e.code !== 'IDEMPOTENCY_CONFLICT') {
      try {
        await deps.idempotency.delete(begin.scopeHash)
      } catch {
        /* ignore */
      }
    }
    if (e instanceof IdempotencyError) {
      throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export async function heartbeatRun(
  deps: RunRegistryDeps,
  req: HeartbeatRunRequest,
): Promise<HeartbeatRunResult> {
  if (!req.idempotencyKey || !String(req.idempotencyKey).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'idempotencyKey is required for heartbeat_run')
  }
  if (typeof req.expectedEntityRev !== 'number' || !Number.isInteger(req.expectedEntityRev)) {
    throw new RunRegistryError('INVALID_INPUT', 'expectedEntityRev is required — no silent default')
  }
  if (typeof req.expectedBoardRev !== 'number' || !Number.isInteger(req.expectedBoardRev)) {
    throw new RunRegistryError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!req.canonicalHash || !String(req.canonicalHash).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (
    req.currentPinHash != null &&
    req.currentPinHash !== '' &&
    req.currentPinHash !== req.canonicalHash
  ) {
    throw new RunRegistryError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: req.canonicalHash,
      currentPinHash: req.currentPinHash,
    })
  }

  // 24h idempotency before board lock — exact replay, conflict on different body.
  // Do NOT bind runId here: register_run already owns unique runId binding; heartbeats
  // are multi-shot with per-sequence keys and would false-conflict (scope mismatch).
  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: req.agentId,
        boardId: req.boardId,
        endpoint: 'heartbeat_run',
        key: req.idempotencyKey.trim(),
      },
      requestBody: {
        runId: req.runId,
        agentId: req.agentId,
        fencingToken: req.fencingToken,
        heartbeatSequence: req.heartbeatSequence,
        materialProgressAt: req.materialProgressAt ?? null,
        expectedEntityRev: req.expectedEntityRev,
        expectedBoardRev: req.expectedBoardRev,
        canonicalHash: req.canonicalHash,
      },
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
  if (begin.kind === 'REPLAY' && begin.record) {
    const body = begin.record.responseBody as HeartbeatRunResult
    return { ...body, replayed: true }
  }

  try {
    const response = await deps.runs.withBoardLock(req.boardId, async () => {
    const rec = await deps.runs.get(req.boardId, req.runId)
    if (!rec) {
      throw new RunRegistryError('RUN_NOT_REGISTERED', `run not registered: ${req.runId}`, {
        runId: req.runId,
      })
    }
    if (rec.agentId !== req.agentId) {
      throw new RunRegistryError('AUTHORIZATION_REQUIRED', 'heartbeat owning agent only', {
        owner: rec.agentId,
        actor: req.agentId,
      })
    }
    if (isTerminal(rec.state)) {
      throw new RunRegistryError('INVALID_STATE', `run is terminal: ${rec.state}`, {
        state: rec.state,
      })
    }
    if (rec.state === 'QUEUED') {
      throw new RunRegistryError('INVALID_STATE', 'QUEUED has no lease/heartbeat', {
        state: rec.state,
      })
    }

    // Duplicate sequence → replay prior response (no entity/board bump)
    if (req.heartbeatSequence === rec.heartbeatSequence && rec.lastHeartbeatResponse) {
      return { ...rec.lastHeartbeatResponse, replayed: true }
    }
    if (req.heartbeatSequence < rec.heartbeatSequence) {
      throw new RunRegistryError('INVALID_INPUT', 'heartbeat sequence must be monotonic', {
        got: req.heartbeatSequence,
        current: rec.heartbeatSequence,
      })
    }
    if (req.heartbeatSequence !== rec.heartbeatSequence + 1 && rec.heartbeatSequence !== 0) {
      // allow first heartbeat any positive start only if sequence is current+1 or 1 when 0
      if (!(rec.heartbeatSequence === 0 && req.heartbeatSequence === 1)) {
        throw new RunRegistryError('INVALID_INPUT', 'heartbeat sequence gap', {
          got: req.heartbeatSequence,
          expected: rec.heartbeatSequence + 1,
        })
      }
    }

    if (!rec.fencingToken || rec.fencingToken !== req.fencingToken) {
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'RUN_FENCED',
        atMs: deps.clock.nowMs(),
        atISO: deps.clock.nowISO(),
        actorId: req.agentId,
        subjectType: 'run',
        subjectId: req.runId,
        detail: { reason: 'fencing_token_mismatch' },
        material: true,
      })
      throw new RunRegistryError('FENCED', 'fencing token invalid or superseded', {
        runId: req.runId,
      })
    }

    const now = deps.clock.nowMs()
    if (rec.leaseExpiresAtMs != null && rec.leaseExpiresAtMs <= now) {
      throw new RunRegistryError('LEASE_EXPIRED', 'run lease expired', {
        leaseExpiresAtMs: rec.leaseExpiresAtMs,
        nowMs: now,
      })
    }

    const board = await deps.atomic.getBoardState(req.boardId)
    if (req.expectedBoardRev !== board.boardRev) {
      throw new RunRegistryError('STALE_REVISION', `board rev mismatch on heartbeat`, {
        expectedBoardRev: req.expectedBoardRev,
        currentBoardRev: board.boardRev,
      })
    }
    if (req.expectedEntityRev !== rec.entityRev) {
      throw new RunRegistryError('STALE_REVISION', `entity rev mismatch on heartbeat`, {
        expectedEntityRev: req.expectedEntityRev,
        currentEntityRev: rec.entityRev,
      })
    }

    // Renew locks with fencing
    if (rec.collisionScopeLockIds.length) {
      try {
        await renewCollisionLocks(deps.locks, deps.clock, {
          boardId: req.boardId,
          runId: req.runId,
          fencingToken: req.fencingToken,
          leaseMs: RUN_LEASE_MS,
        })
      } catch (e) {
        if (e instanceof LockError) {
          throw new RunRegistryError(e.code as RunErrorCode, e.message, e.details as Record<string, unknown>)
        }
        throw e
      }
    }

    let materialProgressAtMs = rec.materialProgressAtMs
    let materialEvent = false
    if (req.materialProgressAt) {
      const mp = Date.parse(req.materialProgressAt)
      if (!Number.isFinite(mp)) {
        throw new RunRegistryError('INVALID_INPUT', 'materialProgressAt invalid')
      }
      materialProgressAtMs = mp
      materialEvent = true
    }

    // Liveness vs material progress: stall if no material progress for 10m while heartbeats continue
    const progressAnchor = materialProgressAtMs ?? rec.registeredAtMs ?? now
    const wasStalled = rec.stalled
    const stalled = now - progressAnchor >= RUN_STALL_MS
    let nextState = rec.state
    if (rec.state === 'STARTING' || rec.state === 'RESERVED') {
      nextState = 'RUNNING'
    }

    const history = [...rec.history]
    if (nextState !== rec.state) {
      history.push({
        atMs: now,
        atISO: deps.clock.nowISO(),
        fromState: rec.state,
        toState: nextState,
        reason: 'heartbeat_live',
        actorId: req.agentId,
      })
    }
    if (stalled && !wasStalled) {
      history.push({
        atMs: now,
        atISO: deps.clock.nowISO(),
        fromState: nextState,
        toState: nextState,
        reason: 'stalled',
        actorId: null,
      })
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'RUN_STALLED',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.agentId,
        subjectType: 'run',
        subjectId: req.runId,
        detail: { progressAnchorMs: progressAnchor },
        material: true,
      })
    }
    if (!stalled && wasStalled) {
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'RUN_RECOVERED',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.agentId,
        subjectType: 'run',
        subjectId: req.runId,
        detail: {},
        material: true,
      })
    }
    if (materialEvent) {
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'RUN_MATERIAL_PROGRESS',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.agentId,
        subjectType: 'run',
        subjectId: req.runId,
        detail: { materialProgressAt: req.materialProgressAt },
        material: true,
      })
    }
    // NOTE: no immutable audit for ordinary heartbeat (coalesced hot state only)

    // Domain retention (optional): hot + sampled + material MATERIAL only.
    // Never invent a policy here — binding must supply already-resolved BoardPolicy.
    // Prefer durable retentionAsync (MySQL multi-instance); sync retention is memory/test only.
    if (deps.retentionAsync?.store && deps.retentionAsync.policy) {
      const binding = deps.retentionAsync
      const retentionResult = await applyHeartbeatWithOptionalCompactionAsync({
        input: {
          runId: req.runId,
          boardId: req.boardId,
          sequence: req.heartbeatSequence,
          atMs: now,
          status: nextState,
          materialProgress: materialEvent,
        },
        policy: binding.policy,
        store: binding.store,
        lastCompactionAtMs: binding.lastCompactionAtMs,
        maxCompactionActions: binding.maxCompactionActions,
      })
      binding.onHeartbeatRetention?.(retentionResult.apply)
      binding.lastCompactionAtMs = retentionResult.nextLastCompactionAtMs
      if (retentionResult.compaction) {
        binding.onCompacted?.(retentionResult.compaction)
      }
    } else if (deps.retention?.store && deps.retention.policy) {
      const binding = deps.retention
      const lastCompactionAtMs = binding.lastCompactionAtMs ?? 0
      const retentionResult = applyHeartbeatWithOptionalCompaction({
        input: {
          runId: req.runId,
          boardId: req.boardId,
          sequence: req.heartbeatSequence,
          atMs: now,
          status: nextState,
          materialProgress: materialEvent,
        },
        policy: binding.policy,
        store: binding.store,
        lastCompactionAtMs,
      })
      binding.onHeartbeatRetention?.(retentionResult.apply)
      if (retentionResult.compaction) {
        binding.lastCompactionAtMs = retentionResult.nextLastCompactionAtMs
        binding.onCompacted?.(retentionResult.compaction)
      } else {
        binding.lastCompactionAtMs = retentionResult.nextLastCompactionAtMs
      }
    }

    const response: HeartbeatRunResult = {
      runId: rec.runId,
      state: nextState,
      leaseExpiresAt: new Date(now + RUN_LEASE_MS).toISOString(),
      heartbeatAt: deps.clock.nowISO(),
      heartbeatSequence: req.heartbeatSequence,
      replayed: false,
      stalled,
      materialProgressAt:
        materialProgressAtMs != null ? new Date(materialProgressAtMs).toISOString() : null,
      entityRev: rec.entityRev + 1,
      boardRev: board.boardRev,
      ...(rec.controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
        ? {
            leaseAck: controlPlaneAck(
              'LEASE_RENEWAL',
              rec.runId,
              deps.clock.nowISO(),
              rec.entityRev + 1,
              board.boardRev,
            ),
          }
        : {}),
    }

    const next: RunRecord = {
      ...rec,
      state: nextState,
      heartbeatAtMs: now,
      leaseExpiresAtMs: now + RUN_LEASE_MS,
      materialProgressAtMs,
      heartbeatSequence: req.heartbeatSequence,
      entityRev: rec.entityRev + 1,
      stalled,
      history,
      lastHeartbeatResponse: response,
    }
    await deps.runs.put(next)
    // Heartbeat mutates entity rev only — never bumps board rev (no double-bump).
    return response
    })

    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, response, begin.requestHash)
    return response
  } catch (e) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore cleanup */
    }
    if (e instanceof IdempotencyError) {
      throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

/** Agent-allowed terminal states via MCP terminate_run (STALE/SUPERSEDED = ROOT/reconciler). */
export const AGENT_TERMINATE_TO_STATES = ['SUCCEEDED', 'FAILED', 'CANCELLED'] as const
export const ROOT_TERMINATE_TO_STATES = [
  'SUCCEEDED',
  'FAILED',
  'CANCELLED',
  'STALE',
  'SUPERSEDED',
] as const

export type TerminateToState = (typeof ROOT_TERMINATE_TO_STATES)[number]

/**
 * Full-envelope terminate request (MCP / production).
 * When all CAS/idempotency fields are present, domain enforces heartbeat-parity
 * entity+board CAS, canonical pin, idempotent replay/conflict, and owner match.
 * Legacy internal callers may omit envelope fields (fail-closed lock release still applies).
 */
export interface TerminateRunRequest {
  boardId: string
  runId: string
  agentId: string
  fencingToken: string
  toState: TerminateToState
  reason: string
  expectedEntityRev?: number
  expectedBoardRev?: number
  canonicalHash?: string
  idempotencyKey?: string
  currentPinHash?: string | null
}

export type TerminateRunResult = RunRecord & { replayed: boolean }

function terminateEnvelopePresent(opts: TerminateRunRequest): boolean {
  return (
    opts.expectedEntityRev !== undefined ||
    opts.expectedBoardRev !== undefined ||
    (opts.canonicalHash != null && String(opts.canonicalHash).length > 0) ||
    (opts.idempotencyKey != null && String(opts.idempotencyKey).length > 0)
  )
}

function assertFullTerminateEnvelope(opts: TerminateRunRequest): {
  expectedEntityRev: number
  expectedBoardRev: number
  canonicalHash: string
  idempotencyKey: string
} {
  if (typeof opts.expectedEntityRev !== 'number' || !Number.isInteger(opts.expectedEntityRev)) {
    throw new RunRegistryError('INVALID_INPUT', 'expectedEntityRev is required — no silent default')
  }
  if (typeof opts.expectedBoardRev !== 'number' || !Number.isInteger(opts.expectedBoardRev)) {
    throw new RunRegistryError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!opts.canonicalHash || !String(opts.canonicalHash).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!opts.idempotencyKey || !String(opts.idempotencyKey).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'idempotencyKey is required for terminate_run')
  }
  if (!opts.reason || !String(opts.reason).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'reason is required for terminate_run')
  }
  if (!opts.fencingToken || !String(opts.fencingToken).trim()) {
    throw new RunRegistryError('INVALID_INPUT', 'fencingToken is required for terminate_run')
  }
  if (
    opts.currentPinHash != null &&
    opts.currentPinHash !== '' &&
    opts.currentPinHash !== opts.canonicalHash
  ) {
    throw new RunRegistryError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: opts.canonicalHash,
      currentPinHash: opts.currentPinHash,
    })
  }
  return {
    expectedEntityRev: opts.expectedEntityRev,
    expectedBoardRev: opts.expectedBoardRev,
    canonicalHash: opts.canonicalHash.trim(),
    idempotencyKey: opts.idempotencyKey.trim(),
  }
}

async function releaseCollisionLocksFailClosed(
  deps: RunRegistryDeps,
  opts: { boardId: string; runId: string; fencingToken: string },
): Promise<number> {
  try {
    const released = await releaseCollisionLocks(deps.locks, deps.clock, {
      boardId: opts.boardId,
      runId: opts.runId,
      fencingToken: opts.fencingToken,
    })
    return released.length
  } catch (e) {
    if (e instanceof LockError) {
      throw new RunRegistryError(e.code as RunErrorCode, e.message, e.details as Record<string, unknown>)
    }
    throw e
  }
}

/**
 * Terminal transition with collision-lock release.
 * Full envelope (MCP): entity+board CAS, pin, 24h idempotency, owner match, fail-closed release.
 * Legacy (no envelope fields): owner match + fence + fail-closed release; no CAS/idempotency store.
 * Already-terminal: preserves first toState (does not overwrite SUCCEEDED with FAILED).
 */
export async function terminateRun(
  deps: RunRegistryDeps,
  opts: TerminateRunRequest,
): Promise<TerminateRunResult> {
  const useFull = terminateEnvelopePresent(opts)
  let envelope: ReturnType<typeof assertFullTerminateEnvelope> | null = null
  let begin: Awaited<ReturnType<typeof beginIdempotent>> | null = null

  if (useFull) {
    envelope = assertFullTerminateEnvelope(opts)
    try {
      begin = await beginIdempotent(deps.idempotency, {
        scope: {
          actorId: opts.agentId,
          boardId: opts.boardId,
          endpoint: 'terminate_run',
          key: envelope.idempotencyKey,
        },
        requestBody: {
          runId: opts.runId,
          agentId: opts.agentId,
          fencingToken: opts.fencingToken,
          toState: opts.toState,
          reason: opts.reason,
          expectedEntityRev: envelope.expectedEntityRev,
          expectedBoardRev: envelope.expectedBoardRev,
          canonicalHash: envelope.canonicalHash,
        },
        nowMs: deps.clock.nowMs(),
      })
    } catch (e) {
      if (e instanceof IdempotencyError) {
        throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
      }
      throw e
    }
    if (begin.kind === 'REPLAY' && begin.record) {
      const body = begin.record.responseBody as TerminateRunResult
      return { ...body, replayed: true }
    }
  }

  try {
    const result = await deps.runs.withBoardLock(opts.boardId, async () => {
      const rec = await deps.runs.get(opts.boardId, opts.runId)
      if (!rec) {
        throw new RunRegistryError('RUN_NOT_REGISTERED', `run not registered: ${opts.runId}`, {
          runId: opts.runId,
        })
      }
      // Owning agent only (MCP forces principal/persisted agentId; ROOT uses owner id).
      if (rec.agentId !== opts.agentId) {
        throw new RunRegistryError('AUTHORIZATION_REQUIRED', 'terminate owning agent only', {
          owner: rec.agentId,
          actor: opts.agentId,
        })
      }
      if (isTerminal(rec.state)) {
        // preserve history; first terminal wins (no FAILED overwrite of SUCCEEDED)
        return { ...rec, replayed: true }
      }
      if (!rec.fencingToken || rec.fencingToken !== opts.fencingToken) {
        await deps.atomic.appendAudit({
          boardId: opts.boardId,
          kind: 'RUN_FENCED',
          atMs: deps.clock.nowMs(),
          atISO: deps.clock.nowISO(),
          actorId: opts.agentId,
          subjectType: 'run',
          subjectId: opts.runId,
          detail: { reason: 'terminal_fencing_mismatch' },
          material: true,
        })
        throw new RunRegistryError('FENCED', 'terminal fencing mismatch', {
          runId: opts.runId,
        })
      }

      if (envelope) {
        const board = await deps.atomic.getBoardState(opts.boardId)
        if (envelope.expectedBoardRev !== board.boardRev) {
          throw new RunRegistryError('STALE_REVISION', 'board rev mismatch on terminate', {
            expectedBoardRev: envelope.expectedBoardRev,
            currentBoardRev: board.boardRev,
          })
        }
        if (envelope.expectedEntityRev !== rec.entityRev) {
          throw new RunRegistryError('STALE_REVISION', 'entity rev mismatch on terminate', {
            expectedEntityRev: envelope.expectedEntityRev,
            currentEntityRev: rec.entityRev,
          })
        }
      }

      const now = deps.clock.nowMs()
      let releasedLockCount = 0
      // Fail-closed: never mark terminal if collision release fails.
      if (rec.collisionScopeLockIds.length && rec.fencingToken) {
        releasedLockCount = await releaseCollisionLocksFailClosed(deps, {
          boardId: opts.boardId,
          runId: opts.runId,
          fencingToken: rec.fencingToken,
        })
      }

      const next: RunRecord = {
        ...rec,
        state: opts.toState,
        leaseExpiresAtMs: null,
        entityRev: rec.entityRev + 1,
        history: [
          ...rec.history,
          {
            atMs: now,
            atISO: deps.clock.nowISO(),
            fromState: rec.state,
            toState: opts.toState,
            reason: opts.reason,
            actorId: opts.agentId,
          },
        ],
        terminalAck:
          rec.controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
            ? controlPlaneAck(
                'TERMINAL',
                rec.runId,
                deps.clock.nowISO(),
                rec.entityRev + 1,
                rec.boardRev,
              )
            : null,
        releaseAck:
          rec.controlPlaneVersion === CP0_CONTROL_PLANE_VERSION
            ? controlPlaneAck(
                'RELEASE',
                rec.runId,
                deps.clock.nowISO(),
                rec.entityRev + 1,
                rec.boardRev,
              )
            : null,
      }
      await deps.runs.put(next)
      await deps.atomic.appendAudit({
        boardId: opts.boardId,
        kind: opts.toState === 'SUPERSEDED' ? 'RUN_SUPERSEDED' : 'RUN_TERMINAL',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: opts.agentId,
        subjectType: 'run',
        subjectId: opts.runId,
        detail: {
          toState: opts.toState,
          reason: opts.reason,
          releasedLockCount,
          terminalAckId: next.terminalAck?.ackId ?? null,
          releaseAckId: next.releaseAck?.ackId ?? null,
        },
        material: true,
      })
      return { ...next, replayed: false }
    })

    if (begin && envelope) {
      await completeIdempotent(deps.idempotency, begin.scopeHash, 200, result, begin.requestHash)
    }
    return result
  } catch (e) {
    if (begin) {
      try {
        await deps.idempotency.delete(begin.scopeHash)
      } catch {
        /* ignore cleanup */
      }
    }
    if (e instanceof IdempotencyError) {
      throw new RunRegistryError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export function createMemoryRunRegistryStore(): RunRegistryStore & {
  snapshot(): Array<RunRecord>
} {
  const runs = new Map<string, RunRecord>()
  const chains = new Map<string, Promise<unknown>>()
  const key = (b: string, id: string) => `${b}::${id}`
  return {
    snapshot() {
      return [...runs.values()].map((r) => ({
        ...r,
        history: r.history.map((h) => ({ ...h })),
        collisionScopeLockIds: [...r.collisionScopeLockIds],
      }))
    },
    async get(boardId, runId) {
      const r = runs.get(key(boardId, runId))
      return r
        ? {
            ...r,
            history: r.history.map((h) => ({ ...h })),
            collisionScopeLockIds: [...r.collisionScopeLockIds],
            lastHeartbeatResponse: r.lastHeartbeatResponse
              ? { ...r.lastHeartbeatResponse }
              : null,
          }
        : null
    },
    async put(rec) {
      runs.set(key(rec.boardId, rec.runId), {
        ...rec,
        history: rec.history.map((h) => ({ ...h })),
        collisionScopeLockIds: [...rec.collisionScopeLockIds],
        lastHeartbeatResponse: rec.lastHeartbeatResponse
          ? { ...rec.lastHeartbeatResponse }
          : null,
      })
    },
    async list(boardId) {
      return [...runs.values()]
        .filter((r) => r.boardId === boardId)
        .map((r) => ({
          ...r,
          history: r.history.map((h) => ({ ...h })),
          collisionScopeLockIds: [...r.collisionScopeLockIds],
        }))
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

/** Exported for tests: pure stall classification. */
export function classifyRunProductivity(rec: RunRecord, nowMs: number): 'PRODUCTIVE' | 'IDLE' | 'STALLED' {
  if (rec.stalled || (rec.materialProgressAtMs != null && nowMs - rec.materialProgressAtMs >= RUN_STALL_MS)) {
    return 'STALLED'
  }
  if (rec.materialProgressAtMs != null && nowMs - rec.materialProgressAtMs < RUN_HEARTBEAT_INTERVAL_MS * 4) {
    return 'PRODUCTIVE'
  }
  return 'IDLE'
}

export function hashRegisterBody(req: RegisterRunRequest): string {
  return requestHash(canonicalRegisterRunRequestBody(req))
}
