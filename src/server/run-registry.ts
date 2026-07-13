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
  type CapacityPolicyResult,
} from './account-sync'

// ---- constants (V3 defaults) ----

export const RUN_VISIBLE_SLA_MS = 30_000
export const RUN_HEARTBEAT_INTERVAL_MS = 15_000
export const RUN_LEASE_MS = 60_000
export const RUN_RECONCILIATION_GRACE_MS = 30_000
export const RUN_STALL_MS = 10 * 60_000

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
  /**
   * Capacity snapshot for provider assignment authorization.
   * Always evaluated before any lock/claim mutation (no optional bypass).
   * Prefer deps.getCapacity; explicit req.capacity overrides for tests.
   * Missing/null/stale capacity → BLOCKED / zero usable (AUTHORIZATION_REQUIRED).
   */
  capacity?: Pick<
    CapacityPolicyResult,
    | 'dispatchMode'
    | 'dispatchAllowed'
    | 'usableCapacity'
    | 'nonGrokAssignmentAllowed'
    | 'grokAssignmentAllowed'
    | 'limitingReasons'
  > | null
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
}

export interface RunRegistryDeps {
  clock: ControlPlaneClock
  runs: RunRegistryStore
  locks: LockStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
  /**
   * Capacity loader for provider assignment gate. Always consulted when
   * req.capacity is undefined. Missing loader + missing req.capacity = fail closed.
   */
  getCapacity?: (
    boardId: string,
  ) => Promise<RegisterRunRequest['capacity']> | RegisterRunRequest['capacity']
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

/**
 * Canonical idempotency request body for register_run.
 * Covers every material request/envelope field except idempotencyKey itself.
 * Same key + any material difference (incl. initialState/role/revisions) →
 * IDEMPOTENCY_CONFLICT; exact same → replay / no board-rev bump.
 */
export function canonicalRegisterRunRequestBody(req: RegisterRunRequest): Record<string, unknown> {
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
    // Capacity snapshot is material: different usable/mode with same key must conflict.
    capacity: req.capacity ?? null,
  }
}

/**
 * Fail-closed usableCapacity gate: missing/undefined/NaN/non-finite/negative
 * never proceeds to authorizeProviderAssignment (W15-09 residual).
 */
export function isFiniteNonNegativeCapacity(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0
}

async function resolveCapacitySource(
  deps: RunRegistryDeps,
  req: RegisterRunRequest,
): Promise<RegisterRunRequest['capacity']> {
  if (Object.prototype.hasOwnProperty.call(req, 'capacity')) {
    return req.capacity
  }
  if (deps.getCapacity) {
    return deps.getCapacity(req.boardId)
  }
  return null
}

/**
 * Capacity + provider authorization BEFORE idempotency / board lock / claim / audit.
 * Throws RunRegistryError AUTHORIZATION_REQUIRED on every fail-closed path.
 */
async function authorizeRegisterCapacity(
  deps: RunRegistryDeps,
  req: RegisterRunRequest,
): Promise<NonNullable<RegisterRunRequest['capacity']>> {
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

  // Stale / zero usable / blocked mode is fail-closed even if flags look OPEN.
  if (
    usable <= 0 ||
    !capacitySource.dispatchAllowed ||
    capacitySource.dispatchMode === 'BLOCKED'
  ) {
    const decision = authorizeProviderAssignment(
      { ...capacitySource, usableCapacity: usable },
      { model: req.model },
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

  const decision = authorizeProviderAssignment(
    { ...capacitySource, usableCapacity: usable },
    { model: req.model },
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
        controllerRunId: null,
        parentRunId: null,
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

export async function terminateRun(
  deps: RunRegistryDeps,
  opts: {
    boardId: string
    runId: string
    agentId: string
    fencingToken: string
    toState: 'SUCCEEDED' | 'FAILED' | 'CANCELLED' | 'STALE' | 'SUPERSEDED'
    reason: string
  },
): Promise<RunRecord> {
  return deps.runs.withBoardLock(opts.boardId, async () => {
    const rec = await deps.runs.get(opts.boardId, opts.runId)
    if (!rec) throw new RunRegistryError('RUN_NOT_REGISTERED', `run not registered: ${opts.runId}`)
    if (isTerminal(rec.state)) {
      // preserve history; idempotent terminal
      return rec
    }
    if (rec.fencingToken && rec.fencingToken !== opts.fencingToken) {
      throw new RunRegistryError('FENCED', 'terminal fencing mismatch')
    }
    const now = deps.clock.nowMs()
    if (rec.collisionScopeLockIds.length && rec.fencingToken) {
      try {
        await releaseCollisionLocks(deps.locks, deps.clock, {
          boardId: opts.boardId,
          runId: opts.runId,
          fencingToken: rec.fencingToken,
        })
      } catch (e) {
        if (!(e instanceof LockError)) throw e
      }
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
      detail: { toState: opts.toState, reason: opts.reason },
      material: true,
    })
    return next
  })
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
