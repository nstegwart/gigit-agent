/**
 * MySQL repository foundation for control-plane runtime persistence (F2).
 * Durable stores for: dispatch plans, V3 runs, collision/integration locks,
 * account sync/readbacks, reconciler leader/dryrun/apply, retention policy.
 * Uses entity_rev + fencing_token columns; soft board_id isolation.
 * No board-mcp wiring. Injectable SqlExecutor — unit tests use memory backend.
 */
import { AsyncLocalStorage } from 'node:async_hooks'

import type {
  AccountSyncSnapshot,
  AccountSyncStore,
  MaskedAccountRecord,
  CapacityPolicyResult,
} from './account-sync'
import type {
  BoardPolicyRetention,
  HotRunState,
  AuditRecord,
  RetentionStore,
  AuditEventClass,
  RetentionEnvironment,
} from './audit-retention'
import type {
  DispatchPlanItem,
  DispatchPlanRecord,
  DispatchPlanStore,
  DispatchPlanStatus,
} from './control-plane-ingest'
import type {
  CollisionLockRecord,
  IntegrationLockRecord,
  LockStore,
  CollisionLockState,
  LockRole,
} from './locks'
import type {
  ReconcileDryRunResult,
  ReconcilerLeaderState,
  ReconcilerStore,
  ReconcileItemDiff,
  ReconcileClass,
} from './reconciler'
import type {
  RunHistoryEntry,
  RunRecord,
  RunRegistryStore,
  RunState,
  HeartbeatRunResult,
} from './run-registry'
import { evaluateCas, type CasMutationRequest, type CasResult, type RevisionState } from './revisions'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const RUNTIME_PERSISTENCE_MIGRATION_FILE =
  'migrations/005_control_plane_runtime_persistence.sql' as const

export const RUNTIME_PERSISTENCE_TABLES = [
  'control_plane_dispatch_plans',
  'control_plane_dispatch_plan_items',
  'control_plane_runs',
  'control_plane_collision_locks',
  'control_plane_integration_locks',
  'control_plane_account_snapshots',
  'control_plane_account_readbacks',
  'control_plane_reconciler_leaders',
  'control_plane_reconciler_dryruns',
  'control_plane_reconciler_apply',
  'control_plane_reconciler_task_flags',
  'control_plane_retention_policies',
  'control_plane_retention_hot_state',
  'control_plane_retention_audit_sample',
] as const

export type RuntimePersistenceTable = (typeof RUNTIME_PERSISTENCE_TABLES)[number]

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type RuntimePersistenceErrorCode =
  | 'STALE_REVISION'
  | 'FENCED'
  | 'NOT_FOUND'
  | 'DATA_INTEGRITY'
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'
  | 'CLAIM_COLLISION'

export class RuntimePersistenceError extends Error {
  readonly code: RuntimePersistenceErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: RuntimePersistenceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'RuntimePersistenceError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// SqlExecutor + connection-pinned contract (mysql2-compatible subset)
// ---------------------------------------------------------------------------

export interface SqlExecuteResult<T = Record<string, unknown>> {
  rows: Array<T>
  affectedRows: number
}

/**
 * Minimal SQL surface. Real MySQL: wrap mysql2 pool/connection.
 * Tests: createMemorySqlExecutor().
 *
 * GET_LOCK / RELEASE_LOCK are **connection-scoped**. When using MySQL named
 * locks, the executor MUST expose getConnection() so acquire + release share
 * one pinned connection (see withMysqlNamedLock).
 */
export interface SqlExecutor {
  execute<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<SqlExecuteResult<T>>
  /**
   * Optional: acquire a connection-pinned executor.
   * Required when useNamedLock=true (MySQL multi-process board locks).
   */
  getConnection?(): Promise<PinnedSqlExecutor>
}

/**
 * Single physical connection. GET_LOCK and RELEASE_LOCK must both run here.
 * Call release() exactly once in finally after the critical section.
 */
export interface PinnedSqlExecutor extends SqlExecutor {
  /** Stable id for the physical connection (tests assert acquire/release match). */
  readonly connectionId: string
  release(): void
}

function executeFromQueryFn(
  query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>,
): SqlExecutor['execute'] {
  return async <T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<SqlExecuteResult<T>> => {
    const [result] = await query(sql, [...params])
    if (Array.isArray(result)) {
      return { rows: result as Array<T>, affectedRows: result.length }
    }
    const hdr = result as { affectedRows?: number }
    return { rows: [] as Array<T>, affectedRows: Number(hdr.affectedRows ?? 0) }
  }
}

/** Wrap mysql2 pool or connection: query → { rows, affectedRows }. */
export function createMysqlPoolExecutor(pool: {
  query: (
    sql: string,
    params?: unknown[],
  ) => Promise<[unknown, unknown]>
  getConnection?: () => Promise<{
    query: (sql: string, params?: unknown[]) => Promise<[unknown, unknown]>
    release: () => void
    threadId?: number
  }>
}): SqlExecutor {
  let anonSeq = 0
  const exec: SqlExecutor = {
    execute: executeFromQueryFn((sql, params) => pool.query(sql, params)),
  }
  if (typeof pool.getConnection === 'function') {
    exec.getConnection = async () => {
      const conn = await pool.getConnection!()
      const connectionId =
        conn.threadId != null ? `mysql-thread-${conn.threadId}` : `mysql-conn-${++anonSeq}`
      return {
        connectionId,
        execute: executeFromQueryFn((sql, params) => conn.query(sql, params)),
        release: () => {
          conn.release()
        },
      }
    }
  }
  return exec
}

// ---------------------------------------------------------------------------
// JSON / cell helpers
// ---------------------------------------------------------------------------

export function parseJsonCell(value: unknown): unknown {
  if (value == null) return null
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8'))
    } catch {
      return null
    }
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t === 'null') return null
    try {
      return JSON.parse(t)
    } catch {
      return null
    }
  }
  return value
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  return String(v)
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'bigint') return v !== 0n
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
  return false
}

function msToDatetime(ms: number | null | undefined): string | null {
  if (ms == null || !Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ')
}

// ---------------------------------------------------------------------------
// Board lock helper (MySQL named lock + in-process chain fallback)
// ---------------------------------------------------------------------------

function createBoardLockChain() {
  const chains = new Map<string, Promise<unknown>>()
  return async function withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T> {
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
  }
}

/**
 * Async call-context for nested withMysqlNamedLock reentrancy.
 *
 * Nested register → acquireCollisionLocks (and heartbeat → renew, terminate →
 * release) re-enter the same board lockName on the same SqlExecutor. Without
 * reentrancy, each call pins a *different* pool connection and the inner
 * GET_LOCK waits 10s on the outer pin → deterministic self-deadlock.
 *
 * Keyed by executor identity + lockName so:
 * - same async context + same exec + same name → reuse outer pin (no 2nd GET_LOCK)
 * - different lock names → independent acquire (still process-exclusive)
 * - independent async roots → separate ALS stores (no cross-request sharing)
 */
type MysqlNamedLockHeld = {
  exec: SqlExecutor
  lockName: string
  pinned: PinnedSqlExecutor
  depth: number
}

const mysqlNamedLockAls = new AsyncLocalStorage<Map<string, MysqlNamedLockHeld>>()
const mysqlNamedLockExecIds = new WeakMap<SqlExecutor, number>()
let mysqlNamedLockExecSeq = 0

function mysqlNamedLockContextKey(exec: SqlExecutor, lockName: string): string {
  let id = mysqlNamedLockExecIds.get(exec)
  if (id == null) {
    id = ++mysqlNamedLockExecSeq
    mysqlNamedLockExecIds.set(exec, id)
  }
  return `${id}\0${lockName}`
}

/**
 * MySQL named lock on a **pinned connection**.
 * GET_LOCK and RELEASE_LOCK are connection-scoped; both MUST run on the same
 * physical connection, and RELEASE is guaranteed in finally before release().
 *
 * Re-entrant within the same async context for the same executor + lockName:
 * nested calls execute under the outer pin without a second GET_LOCK/RELEASE.
 * Only the outermost frame acquires, releases, and returns the pin.
 *
 * Requires SqlExecutor.getConnection (connection-pinned contract).
 * Exported for unit tests that assert acquire/release connection identity.
 */
export async function withMysqlNamedLock<T>(
  exec: SqlExecutor,
  boardId: string,
  fn: () => Promise<T> | T,
): Promise<T> {
  if (typeof exec.getConnection !== 'function') {
    throw new RuntimePersistenceError(
      'INVALID_INPUT',
      'withMysqlNamedLock requires connection-pinned SqlExecutor.getConnection()',
      { boardId },
    )
  }
  const lockName = `cp_rt_${boardId}`.slice(0, 64)
  const key = mysqlNamedLockContextKey(exec, lockName)
  const store = mysqlNamedLockAls.getStore()
  const held = store?.get(key)
  if (held) {
    // Same async context + same executor + same lockName: reenter outer pin.
    held.depth += 1
    try {
      return await fn()
    } finally {
      held.depth -= 1
    }
  }

  const pinned = await exec.getConnection()
  let acquired = false
  try {
    const acq = await pinned.execute<{ l: number }>('SELECT GET_LOCK(?, 10) AS l', [lockName])
    const ok = asNumber(acq.rows[0]?.l, 0) === 1
    if (!ok) {
      throw new RuntimePersistenceError('DATA_INTEGRITY', 'failed to acquire board named lock', {
        boardId,
        lockName,
        connectionId: pinned.connectionId,
      })
    }
    acquired = true
    const entry: MysqlNamedLockHeld = { exec, lockName, pinned, depth: 1 }

    const runCritical = async (): Promise<T> => {
      const active = mysqlNamedLockAls.getStore()
      if (!active) {
        // Defensive: ALS must be established by the outer run() below.
        throw new RuntimePersistenceError(
          'DATA_INTEGRITY',
          'withMysqlNamedLock missing async lock context',
          { boardId, lockName },
        )
      }
      active.set(key, entry)
      try {
        return await fn()
      } finally {
        active.delete(key)
        if (acquired) {
          // Same pinned connection as GET_LOCK — never use the pool here.
          await pinned.execute('SELECT RELEASE_LOCK(?) AS r', [lockName])
          acquired = false
        }
      }
    }

    // Reuse parent ALS map when nesting a *different* lockName under an outer hold;
    // otherwise establish a fresh map for this independent async root.
    if (store) {
      return await runCritical()
    }
    return await mysqlNamedLockAls.run(new Map<string, MysqlNamedLockHeld>(), runCritical)
  } finally {
    pinned.release()
  }
}

// ---------------------------------------------------------------------------
// Revision / fencing helpers (pure)
// ---------------------------------------------------------------------------

export function evaluateRuntimeCas(
  current: RevisionState,
  req: CasMutationRequest,
): CasResult {
  return evaluateCas(current, req)
}

export function assertFencingMatch(opts: {
  currentToken: string | null | undefined
  expectedToken: string
  entityId: string
  kind: string
}): void {
  if (!opts.currentToken || opts.currentToken !== opts.expectedToken) {
    throw new RuntimePersistenceError(
      'FENCED',
      `${opts.kind} fencing token invalid or superseded`,
      {
        entityId: opts.entityId,
        expected: opts.expectedToken,
        current: opts.currentToken ?? null,
      },
    )
  }
}

/**
 * Reject stale/fenced put overwrites for entity_rev + fencing CAS.
 * Insert path: existing == null (caller performs INSERT).
 * Update path: next.fencing must match current; next.entityRev must be strictly greater.
 */
export function assertCasMutationAllowed(opts: {
  existing: { fencingToken: string | null | undefined; entityRev: number } | null
  next: { fencingToken: string | null | undefined; entityRev: number }
  entityId: string
  kind: string
}): void {
  if (!opts.existing) return
  const curFence = opts.existing.fencingToken ?? null
  const nextFence = opts.next.fencingToken ?? null
  if (curFence !== nextFence) {
    throw new RuntimePersistenceError(
      'FENCED',
      `${opts.kind} fencing token invalid or superseded`,
      {
        entityId: opts.entityId,
        expected: curFence,
        attempted: nextFence,
        currentEntityRev: opts.existing.entityRev,
        nextEntityRev: opts.next.entityRev,
      },
    )
  }
  if (opts.next.entityRev <= opts.existing.entityRev) {
    throw new RuntimePersistenceError(
      'STALE_REVISION',
      `${opts.kind} entity_rev is stale (got ${opts.next.entityRev}, current ${opts.existing.entityRev})`,
      {
        entityId: opts.entityId,
        currentEntityRev: opts.existing.entityRev,
        nextEntityRev: opts.next.entityRev,
      },
    )
  }
}

/** MySQL ER_DUP_ENTRY / memory-executor equivalent (errno 1062). */
export function classifyMysqlDuplicateKey(err: unknown): { key: string } | null {
  if (err == null) return null
  const e = err as { errno?: number; code?: string; message?: string }
  const msg = String(e.message ?? (err instanceof Error ? err.message : err))
  const isDup =
    e.errno === 1062 ||
    e.code === 'ER_DUP_ENTRY' ||
    /Duplicate entry/i.test(msg)
  if (!isDup) return null
  const m = msg.match(/for key ['`]([^'`]+)['`]/i)
  return { key: m?.[1] ?? 'UNKNOWN' }
}

/** Canonical field equality for collision lock insert-idempotency. */
export function collisionLockCanonicalEqual(
  a: CollisionLockRecord,
  b: CollisionLockRecord,
): boolean {
  return (
    a.boardId === b.boardId &&
    a.lockId === b.lockId &&
    a.scopeId === b.scopeId &&
    a.taskId === b.taskId &&
    a.runId === b.runId &&
    a.agentId === b.agentId &&
    a.role === b.role &&
    a.fencingToken === b.fencingToken &&
    a.fencingVersion === b.fencingVersion &&
    a.state === b.state &&
    a.leaseExpiresAtMs === b.leaseExpiresAtMs &&
    a.acquiredAtMs === b.acquiredAtMs &&
    a.releasedAtMs === b.releasedAtMs &&
    a.supersededByLockId === b.supersededByLockId &&
    a.supersedesLockId === b.supersedesLockId &&
    a.entityRev === b.entityRev
  )
}

/** Canonical field equality for integration lock insert-idempotency. */
export function integrationLockCanonicalEqual(
  a: IntegrationLockRecord,
  b: IntegrationLockRecord,
): boolean {
  if (
    a.boardId !== b.boardId ||
    a.lockId !== b.lockId ||
    a.repoId !== b.repoId ||
    a.trackingBranch !== b.trackingBranch ||
    a.runId !== b.runId ||
    a.agentId !== b.agentId ||
    a.integratorModel !== b.integratorModel ||
    a.rootAcceptanceId !== b.rootAcceptanceId ||
    a.checkpointId !== b.checkpointId ||
    a.fencingToken !== b.fencingToken ||
    a.fencingVersion !== b.fencingVersion ||
    a.state !== b.state ||
    a.leaseExpiresAtMs !== b.leaseExpiresAtMs ||
    a.acquiredAtMs !== b.acquiredAtMs ||
    a.releasedAtMs !== b.releasedAtMs ||
    a.entityRev !== b.entityRev
  ) {
    return false
  }
  if (a.pathspecs.length !== b.pathspecs.length) return false
  for (let i = 0; i < a.pathspecs.length; i++) {
    if (a.pathspecs[i] !== b.pathspecs[i]) return false
  }
  return true
}

// ---------------------------------------------------------------------------
// Codecs — Dispatch plan
// ---------------------------------------------------------------------------

export function encodeDispatchPlanRecord(rec: DispatchPlanRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    plan_id: rec.planId,
    plan_version: rec.planVersion,
    plan_hash: rec.planHash,
    canonical_snapshot_id: rec.canonicalSnapshotId,
    canonical_hash: rec.canonicalHash,
    board_rev_at_publish: rec.boardRevAtPublish,
    issued_at: msToDatetime(rec.issuedAtMs) ?? rec.issuedAt,
    issued_at_ms: rec.issuedAtMs,
    expires_at: msToDatetime(rec.expiresAtMs) ?? rec.expiresAt,
    expires_at_ms: rec.expiresAtMs,
    stage: rec.stage,
    status: rec.status,
    generated_at: msToDatetime(rec.generatedAtMs) ?? rec.generatedAt,
    generated_at_ms: rec.generatedAtMs,
    superseded_by_plan_id: rec.supersededByPlanId,
    entity_rev: rec.entityRev,
    items_json: rec.items,
    record_json: rec,
  }
}

export function decodeDispatchPlanRecord(row: Record<string, unknown>): DispatchPlanRecord {
  const fromJson = parseJsonCell(row.record_json) as DispatchPlanRecord | null
  if (fromJson && typeof fromJson === 'object' && fromJson.planId) {
    return {
      ...fromJson,
      items: Array.isArray(fromJson.items)
        ? fromJson.items.map((i) => ({ ...i }))
        : decodePlanItems(parseJsonCell(row.items_json)),
    }
  }
  return {
    boardId: asString(row.board_id),
    planId: asString(row.plan_id),
    planVersion: asNumber(row.plan_version, 1),
    planHash: asString(row.plan_hash),
    canonicalSnapshotId: asString(row.canonical_snapshot_id),
    canonicalHash: asString(row.canonical_hash),
    boardRevAtPublish: asNumber(row.board_rev_at_publish),
    issuedAt: asString(row.issued_at),
    expiresAt: asString(row.expires_at),
    issuedAtMs: asNumber(row.issued_at_ms),
    expiresAtMs: asNumber(row.expires_at_ms),
    stage: row.stage == null ? null : asString(row.stage),
    items: decodePlanItems(parseJsonCell(row.items_json)),
    status: asString(row.status) as DispatchPlanStatus,
    generatedAt: asString(row.generated_at),
    generatedAtMs: asNumber(row.generated_at_ms),
    supersededByPlanId: row.superseded_by_plan_id == null ? null : asString(row.superseded_by_plan_id),
    entityRev: asNumber(row.entity_rev, 1),
  }
}

function decodePlanItems(raw: unknown): Array<DispatchPlanItem> {
  if (!Array.isArray(raw)) return []
  return raw.map((it) => {
    const o = it as Record<string, unknown>
    return {
      rank: asNumber(o.rank),
      taskId: asString(o.taskId ?? o.task_id),
      targetGate: asString(o.targetGate ?? o.target_gate),
      role: asString(o.role),
      selectionReason: asString(o.selectionReason ?? o.selection_reason),
      priorityPortfolioId: (o.priorityPortfolioId ?? o.priority_portfolio_id ?? null) as string | null,
      dependencyProof: (o.dependencyProof ?? o.dependency_proof_json ?? null) as DispatchPlanItem['dependencyProof'],
      collisionScopeLockIds: Array.isArray(o.collisionScopeLockIds)
        ? (o.collisionScopeLockIds as Array<string>)
        : Array.isArray(o.collision_scope_lock_ids)
          ? (o.collision_scope_lock_ids as Array<string>)
          : [],
      expectedEntityRev: asNumber(o.expectedEntityRev ?? o.expected_entity_rev),
      expectedBoardRev: asNumber(o.expectedBoardRev ?? o.expected_board_rev),
    }
  })
}

// ---------------------------------------------------------------------------
// Codecs — Run
// ---------------------------------------------------------------------------

export function encodeRunRecord(rec: RunRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    run_id: rec.runId,
    state: rec.state,
    plan_id: rec.planId,
    plan_item_rank: rec.planItemRank,
    task_id: rec.taskId,
    target_gate: rec.targetGate,
    role: rec.role,
    agent_id: rec.agentId,
    model: rec.model,
    effort: rec.effort,
    masked_account_ref: rec.maskedAccountRef,
    canonical_hash: rec.canonicalHash,
    collision_scope_lock_ids_json: rec.collisionScopeLockIds,
    fencing_token: rec.fencingToken,
    fencing_version: rec.fencingVersion,
    registered_at_ms: rec.registeredAtMs,
    heartbeat_at_ms: rec.heartbeatAtMs,
    lease_expires_at_ms: rec.leaseExpiresAtMs,
    material_progress_at_ms: rec.materialProgressAtMs,
    heartbeat_sequence: rec.heartbeatSequence,
    expected_entity_rev: rec.expectedEntityRev,
    expected_board_rev: rec.expectedBoardRev,
    entity_rev: rec.entityRev,
    board_rev: rec.boardRev,
    stalled: rec.stalled ? 1 : 0,
    history_json: rec.history,
    last_heartbeat_response_json: rec.lastHeartbeatResponse,
    controller_run_id: rec.controllerRunId,
    parent_run_id: rec.parentRunId,
    idempotency_key: rec.idempotencyKey,
    record_json: rec,
  }
}

export function decodeRunRecord(row: Record<string, unknown>): RunRecord {
  const fromJson = parseJsonCell(row.record_json) as RunRecord | null
  if (fromJson && typeof fromJson === 'object' && fromJson.runId) {
    return {
      ...fromJson,
      history: Array.isArray(fromJson.history) ? fromJson.history.map((h) => ({ ...h })) : [],
      collisionScopeLockIds: Array.isArray(fromJson.collisionScopeLockIds)
        ? [...fromJson.collisionScopeLockIds]
        : [],
      lastHeartbeatResponse: fromJson.lastHeartbeatResponse
        ? { ...fromJson.lastHeartbeatResponse }
        : null,
    }
  }
  const hist = parseJsonCell(row.history_json)
  const locks = parseJsonCell(row.collision_scope_lock_ids_json)
  const hb = parseJsonCell(row.last_heartbeat_response_json)
  return {
    boardId: asString(row.board_id),
    runId: asString(row.run_id),
    state: asString(row.state) as RunState,
    planId: row.plan_id == null ? null : asString(row.plan_id),
    planItemRank: row.plan_item_rank == null ? null : asNumber(row.plan_item_rank),
    taskId: asString(row.task_id),
    targetGate: asString(row.target_gate),
    role: asString(row.role),
    agentId: asString(row.agent_id),
    model: asString(row.model),
    effort: asString(row.effort),
    maskedAccountRef: row.masked_account_ref == null ? null : asString(row.masked_account_ref),
    canonicalHash: row.canonical_hash == null ? null : asString(row.canonical_hash),
    collisionScopeLockIds: Array.isArray(locks) ? (locks as Array<string>) : [],
    fencingToken: row.fencing_token == null ? null : asString(row.fencing_token),
    fencingVersion: asNumber(row.fencing_version),
    registeredAtMs: row.registered_at_ms == null ? null : asNumber(row.registered_at_ms),
    heartbeatAtMs: row.heartbeat_at_ms == null ? null : asNumber(row.heartbeat_at_ms),
    leaseExpiresAtMs: row.lease_expires_at_ms == null ? null : asNumber(row.lease_expires_at_ms),
    materialProgressAtMs:
      row.material_progress_at_ms == null ? null : asNumber(row.material_progress_at_ms),
    heartbeatSequence: asNumber(row.heartbeat_sequence),
    expectedEntityRev: asNumber(row.expected_entity_rev),
    expectedBoardRev: asNumber(row.expected_board_rev),
    entityRev: asNumber(row.entity_rev, 1),
    boardRev: asNumber(row.board_rev),
    stalled: asBool(row.stalled),
    history: Array.isArray(hist) ? (hist as Array<RunHistoryEntry>) : [],
    lastHeartbeatResponse: hb && typeof hb === 'object' ? (hb as HeartbeatRunResult) : null,
    controllerRunId: row.controller_run_id == null ? null : asString(row.controller_run_id),
    parentRunId: row.parent_run_id == null ? null : asString(row.parent_run_id),
    idempotencyKey: row.idempotency_key == null ? null : asString(row.idempotency_key),
  }
}

// ---------------------------------------------------------------------------
// Codecs — Locks
// ---------------------------------------------------------------------------

export function encodeCollisionLock(rec: CollisionLockRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    lock_id: rec.lockId,
    scope_id: rec.scopeId,
    task_id: rec.taskId,
    run_id: rec.runId,
    agent_id: rec.agentId,
    role: rec.role,
    fencing_token: rec.fencingToken,
    fencing_version: rec.fencingVersion,
    state: rec.state,
    lease_expires_at_ms: rec.leaseExpiresAtMs,
    acquired_at_ms: rec.acquiredAtMs,
    released_at_ms: rec.releasedAtMs,
    superseded_by_lock_id: rec.supersededByLockId,
    supersedes_lock_id: rec.supersedesLockId,
    entity_rev: rec.entityRev,
    record_json: rec,
  }
}

export function decodeCollisionLock(row: Record<string, unknown>): CollisionLockRecord {
  const fromJson = parseJsonCell(row.record_json) as CollisionLockRecord | null
  if (fromJson && fromJson.lockId) return { ...fromJson }
  return {
    boardId: asString(row.board_id),
    lockId: asString(row.lock_id),
    scopeId: asString(row.scope_id),
    taskId: asString(row.task_id),
    runId: asString(row.run_id),
    agentId: asString(row.agent_id),
    role: asString(row.role) as LockRole,
    fencingToken: asString(row.fencing_token),
    fencingVersion: asNumber(row.fencing_version, 1),
    state: asString(row.state) as CollisionLockState,
    leaseExpiresAtMs: asNumber(row.lease_expires_at_ms),
    acquiredAtMs: asNumber(row.acquired_at_ms),
    releasedAtMs: row.released_at_ms == null ? null : asNumber(row.released_at_ms),
    supersededByLockId:
      row.superseded_by_lock_id == null ? null : asString(row.superseded_by_lock_id),
    supersedesLockId: row.supersedes_lock_id == null ? null : asString(row.supersedes_lock_id),
    entityRev: asNumber(row.entity_rev, 1),
  }
}

export function encodeIntegrationLock(rec: IntegrationLockRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    lock_id: rec.lockId,
    repo_id: rec.repoId,
    tracking_branch: rec.trackingBranch,
    run_id: rec.runId,
    agent_id: rec.agentId,
    integrator_model: rec.integratorModel,
    root_acceptance_id: rec.rootAcceptanceId,
    checkpoint_id: rec.checkpointId,
    pathspecs_json: rec.pathspecs,
    fencing_token: rec.fencingToken,
    fencing_version: rec.fencingVersion,
    state: rec.state,
    lease_expires_at_ms: rec.leaseExpiresAtMs,
    acquired_at_ms: rec.acquiredAtMs,
    released_at_ms: rec.releasedAtMs,
    entity_rev: rec.entityRev,
    record_json: rec,
  }
}

export function decodeIntegrationLock(row: Record<string, unknown>): IntegrationLockRecord {
  const fromJson = parseJsonCell(row.record_json) as IntegrationLockRecord | null
  if (fromJson && fromJson.lockId) {
    return { ...fromJson, pathspecs: [...fromJson.pathspecs] }
  }
  const pathspecs = parseJsonCell(row.pathspecs_json)
  return {
    boardId: asString(row.board_id),
    lockId: asString(row.lock_id),
    repoId: asString(row.repo_id),
    trackingBranch: asString(row.tracking_branch),
    runId: asString(row.run_id),
    agentId: asString(row.agent_id),
    integratorModel: asString(row.integrator_model),
    rootAcceptanceId: asString(row.root_acceptance_id),
    checkpointId: asString(row.checkpoint_id),
    pathspecs: Array.isArray(pathspecs) ? (pathspecs as Array<string>) : [],
    fencingToken: asString(row.fencing_token),
    fencingVersion: asNumber(row.fencing_version, 1),
    state: asString(row.state) as CollisionLockState,
    leaseExpiresAtMs: asNumber(row.lease_expires_at_ms),
    acquiredAtMs: asNumber(row.acquired_at_ms),
    releasedAtMs: row.released_at_ms == null ? null : asNumber(row.released_at_ms),
    entityRev: asNumber(row.entity_rev, 1),
  }
}

// ---------------------------------------------------------------------------
// Codecs — Account sync
// ---------------------------------------------------------------------------

export function encodeAccountSyncSnapshot(snap: AccountSyncSnapshot): Record<string, unknown> {
  return {
    board_id: snap.boardId,
    source_revision: snap.sourceRevision,
    generated_at: msToDatetime(snap.generatedAtMs) ?? snap.generatedAt,
    generated_at_ms: snap.generatedAtMs,
    published_at_ms: snap.publishedAtMs,
    last_periodic_health_at_ms: snap.lastPeriodicHealthAtMs,
    stale: snap.stale ? 1 : 0,
    stale_reason: snap.staleReason,
    usable_capacity: snap.usableCapacity,
    entity_rev: snap.entityRev,
    accounts_json: snap.accounts,
    capacity_json: snap.capacity,
    readback_surfaces_json: snap.readbackSurfaces,
    record_json: snap,
  }
}

export function decodeAccountSyncSnapshot(row: Record<string, unknown>): AccountSyncSnapshot {
  const fromJson = parseJsonCell(row.record_json) as AccountSyncSnapshot | null
  if (fromJson && fromJson.boardId) {
    return {
      ...fromJson,
      accounts: fromJson.accounts.map((a) => ({ ...a })),
      readbackSurfaces: { ...fromJson.readbackSurfaces },
      capacity: { ...fromJson.capacity },
    }
  }
  const accounts = parseJsonCell(row.accounts_json)
  const capacity = parseJsonCell(row.capacity_json)
  const surfaces = parseJsonCell(row.readback_surfaces_json) as AccountSyncSnapshot['readbackSurfaces'] | null
  return {
    boardId: asString(row.board_id),
    sourceRevision: asNumber(row.source_revision),
    generatedAt: asString(row.generated_at),
    generatedAtMs: asNumber(row.generated_at_ms),
    accounts: Array.isArray(accounts) ? (accounts as Array<MaskedAccountRecord>) : [],
    readbackSurfaces: surfaces ?? { mcp: null, api: null, ui: null, ops: null },
    publishedAtMs: asNumber(row.published_at_ms),
    lastPeriodicHealthAtMs:
      row.last_periodic_health_at_ms == null ? null : asNumber(row.last_periodic_health_at_ms),
    stale: asBool(row.stale),
    staleReason: row.stale_reason == null ? null : asString(row.stale_reason),
    usableCapacity: asNumber(row.usable_capacity),
    capacity: (capacity ?? {
      sparkLive: 0,
      sparkCap: 0,
      solLive: 0,
      solCap: 0,
      grokLive: 0,
      grokPerAccount: [],
      grokMajority: false,
      healthyGrokUsableCapacity: 0,
      sparkUsableCapacity: 0,
      solUsableCapacity: 0,
      otherUsableCapacity: 0,
      combinedLive: 0,
      combinedCap: 0,
      floorTarget: 60,
      floorMet: false,
      belowFloor: true,
      belowFloorReason: null,
      usableCapacity: 0,
      dispatchAllowed: false,
      dispatchMode: 'BLOCKED',
      nonGrokAssignmentAllowed: false,
      grokAssignmentAllowed: false,
      limitingReasons: [],
      failSafeActions: [],
      policy: {
        sparkMax: 10,
        solMax: 10,
        grokStartPerAccount: 5,
        grokMaxPerAccount: 10,
        combinedMax: 200,
        floorMin: 60,
        physicalSlotsDisplayOnly: true,
        neverAccountsAll: true,
        neverFiller: true,
        cpuBoundedDrainMaxReduceSlots: 10,
      },
    }) as CapacityPolicyResult,
    entityRev: asNumber(row.entity_rev, 1),
  }
}

// ---------------------------------------------------------------------------
// Codecs — Reconciler
// ---------------------------------------------------------------------------

export function encodeReconcilerLeader(state: ReconcilerLeaderState): Record<string, unknown> {
  return {
    board_id: state.boardId,
    leader_id: state.leaderId,
    fencing_token: state.fencingToken,
    lease_expires_at_ms: state.leaseExpiresAtMs,
  }
}

export function decodeReconcilerLeader(row: Record<string, unknown>): ReconcilerLeaderState {
  return {
    boardId: asString(row.board_id),
    leaderId: asString(row.leader_id),
    fencingToken: asString(row.fencing_token),
    leaseExpiresAtMs: asNumber(row.lease_expires_at_ms),
  }
}

export function encodeReconcileDryRun(result: ReconcileDryRunResult): Record<string, unknown> {
  return {
    board_id: result.boardId,
    dry_run_hash: result.dryRunHash,
    dry_run_id: result.dryRunId,
    board_rev: result.boardRev,
    leader_token: result.leaderToken,
    cursor_val: result.cursor,
    next_cursor: result.nextCursor,
    max_actions: result.maxActions,
    time_budget_ms: result.timeBudgetMs,
    items_json: result.items,
    counts_json: result.counts,
    generated_at_ms: result.generatedAtMs,
    generated_at: msToDatetime(result.generatedAtMs) ?? result.generatedAt,
    record_json: result,
  }
}

export function decodeReconcileDryRun(row: Record<string, unknown>): ReconcileDryRunResult {
  const fromJson = parseJsonCell(row.record_json) as ReconcileDryRunResult | null
  if (fromJson && fromJson.dryRunHash) {
    return {
      ...fromJson,
      items: fromJson.items.map((i) => ({ ...i })),
      counts: { ...fromJson.counts },
    }
  }
  const items = parseJsonCell(row.items_json)
  const counts = parseJsonCell(row.counts_json) as Record<ReconcileClass, number> | null
  return {
    dryRunId: asString(row.dry_run_id),
    dryRunHash: asString(row.dry_run_hash),
    boardId: asString(row.board_id),
    boardRev: asNumber(row.board_rev),
    leaderToken: asString(row.leader_token),
    cursor: row.cursor_val == null ? null : asString(row.cursor_val),
    nextCursor: row.next_cursor == null ? null : asString(row.next_cursor),
    maxActions: asNumber(row.max_actions),
    timeBudgetMs: asNumber(row.time_budget_ms),
    items: Array.isArray(items) ? (items as Array<ReconcileItemDiff>) : [],
    counts: counts ?? {
      LIVE: 0,
      TERMINAL: 0,
      STALE: 0,
      ORPHAN: 0,
      REQUEUE: 0,
      MANUAL: 0,
    },
    generatedAtMs: asNumber(row.generated_at_ms),
    generatedAt: asString(row.generated_at),
  }
}

// ---------------------------------------------------------------------------
// Codecs — Retention
// ---------------------------------------------------------------------------

export function encodeRetentionPolicy(
  boardId: string,
  policy: BoardPolicyRetention,
  entityRev = 1,
): Record<string, unknown> {
  return {
    board_id: boardId,
    policy_id: policy.policyId,
    policy_version: policy.policyVersion,
    heartbeat_sample_interval: policy.heartbeatSampleInterval,
    hot_state_retention_ms: policy.hotStateRetentionMs,
    sampled_event_retention_ms: policy.sampledEventRetentionMs,
    rollup_retention_ms: policy.rollupRetentionMs,
    compaction_interval_ms: policy.compactionIntervalMs,
    approved_for_json: policy.approvedFor,
    entity_rev: entityRev,
    record_json: policy,
  }
}

export function decodeRetentionPolicy(row: Record<string, unknown>): BoardPolicyRetention {
  const fromJson = parseJsonCell(row.record_json) as BoardPolicyRetention | null
  if (fromJson && fromJson.policyId) {
    return { ...fromJson, approvedFor: [...fromJson.approvedFor] }
  }
  const approved = parseJsonCell(row.approved_for_json)
  return {
    policyId: asString(row.policy_id),
    policyVersion: asString(row.policy_version),
    heartbeatSampleInterval: asNumber(row.heartbeat_sample_interval),
    hotStateRetentionMs: asNumber(row.hot_state_retention_ms),
    sampledEventRetentionMs: asNumber(row.sampled_event_retention_ms),
    rollupRetentionMs: asNumber(row.rollup_retention_ms),
    compactionIntervalMs: asNumber(row.compaction_interval_ms),
    approvedFor: Array.isArray(approved)
      ? (approved as Array<Exclude<RetentionEnvironment, 'UNRESOLVED'>>)
      : (['LOCAL', 'TEST'] as Array<Exclude<RetentionEnvironment, 'UNRESOLVED'>>),
  }
}

export function encodeHotRunState(state: HotRunState): Record<string, unknown> {
  return {
    board_id: state.boardId,
    run_id: state.runId,
    last_heartbeat_at_ms: state.lastHeartbeatAtMs,
    heartbeat_sequence: state.heartbeatSequence,
    status: state.status,
    material_progress_at_ms: state.materialProgressAtMs,
    record_json: state,
  }
}

export function decodeHotRunState(row: Record<string, unknown>): HotRunState {
  const fromJson = parseJsonCell(row.record_json) as HotRunState | null
  if (fromJson && fromJson.runId) return { ...fromJson }
  return {
    runId: asString(row.run_id),
    boardId: asString(row.board_id),
    lastHeartbeatAtMs: asNumber(row.last_heartbeat_at_ms),
    heartbeatSequence: asNumber(row.heartbeat_sequence),
    status: asString(row.status),
    materialProgressAtMs:
      row.material_progress_at_ms == null ? null : asNumber(row.material_progress_at_ms),
  }
}

export function encodeAuditRecord(rec: AuditRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    audit_id: rec.id,
    run_id: rec.runId ?? null,
    event_class: rec.eventClass,
    event_type: rec.eventType,
    at_ms: rec.atMs,
    immutable: rec.immutable ? 1 : 0,
    payload_json: rec.payload,
  }
}

export function decodeAuditRecord(row: Record<string, unknown>): AuditRecord {
  const payload = parseJsonCell(row.payload_json)
  return {
    id: asString(row.audit_id),
    boardId: asString(row.board_id),
    runId: row.run_id == null ? null : asString(row.run_id),
    eventClass: asString(row.event_class) as AuditEventClass,
    eventType: asString(row.event_type),
    atMs: asNumber(row.at_ms),
    immutable: asBool(row.immutable),
    payload: (payload && typeof payload === 'object' ? payload : {}) as Record<string, unknown>,
  }
}

// ---------------------------------------------------------------------------
// SQL statement constants (foundation; inspected by unit tests)
// ---------------------------------------------------------------------------

export const RUNTIME_SQL = {
  putDispatchPlan: `
    INSERT INTO control_plane_dispatch_plans (
      board_id, plan_id, plan_version, plan_hash, canonical_snapshot_id, canonical_hash,
      board_rev_at_publish, issued_at, issued_at_ms, expires_at, expires_at_ms, stage,
      status, generated_at, generated_at_ms, superseded_by_plan_id, entity_rev,
      items_json, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      plan_version=VALUES(plan_version), plan_hash=VALUES(plan_hash),
      canonical_snapshot_id=VALUES(canonical_snapshot_id), canonical_hash=VALUES(canonical_hash),
      board_rev_at_publish=VALUES(board_rev_at_publish), issued_at=VALUES(issued_at),
      issued_at_ms=VALUES(issued_at_ms), expires_at=VALUES(expires_at),
      expires_at_ms=VALUES(expires_at_ms), stage=VALUES(stage), status=VALUES(status),
      generated_at=VALUES(generated_at), generated_at_ms=VALUES(generated_at_ms),
      superseded_by_plan_id=VALUES(superseded_by_plan_id), entity_rev=VALUES(entity_rev),
      items_json=VALUES(items_json), record_json=VALUES(record_json)
  `,
  getDispatchPlan: `SELECT * FROM control_plane_dispatch_plans WHERE board_id=? AND plan_id=? LIMIT 1`,
  listDispatchPlans: `SELECT * FROM control_plane_dispatch_plans WHERE board_id=?`,
  getActiveDispatchPlan: `
    SELECT * FROM control_plane_dispatch_plans
    WHERE board_id=? AND status='ACTIVE'
    ORDER BY generated_at_ms DESC LIMIT 1
  `,
  putRun: `
    INSERT INTO control_plane_runs (
      board_id, run_id, state, plan_id, plan_item_rank, task_id, target_gate, role,
      agent_id, model, effort, masked_account_ref, canonical_hash,
      collision_scope_lock_ids_json, fencing_token, fencing_version,
      registered_at_ms, heartbeat_at_ms, lease_expires_at_ms, material_progress_at_ms,
      heartbeat_sequence, expected_entity_rev, expected_board_rev, entity_rev, board_rev,
      stalled, history_json, last_heartbeat_response_json, controller_run_id, parent_run_id,
      idempotency_key, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      state=VALUES(state), plan_id=VALUES(plan_id), plan_item_rank=VALUES(plan_item_rank),
      task_id=VALUES(task_id), target_gate=VALUES(target_gate), role=VALUES(role),
      agent_id=VALUES(agent_id), model=VALUES(model), effort=VALUES(effort),
      masked_account_ref=VALUES(masked_account_ref), canonical_hash=VALUES(canonical_hash),
      collision_scope_lock_ids_json=VALUES(collision_scope_lock_ids_json),
      fencing_token=VALUES(fencing_token), fencing_version=VALUES(fencing_version),
      registered_at_ms=VALUES(registered_at_ms), heartbeat_at_ms=VALUES(heartbeat_at_ms),
      lease_expires_at_ms=VALUES(lease_expires_at_ms),
      material_progress_at_ms=VALUES(material_progress_at_ms),
      heartbeat_sequence=VALUES(heartbeat_sequence),
      expected_entity_rev=VALUES(expected_entity_rev), expected_board_rev=VALUES(expected_board_rev),
      entity_rev=VALUES(entity_rev), board_rev=VALUES(board_rev), stalled=VALUES(stalled),
      history_json=VALUES(history_json),
      last_heartbeat_response_json=VALUES(last_heartbeat_response_json),
      controller_run_id=VALUES(controller_run_id), parent_run_id=VALUES(parent_run_id),
      idempotency_key=VALUES(idempotency_key), record_json=VALUES(record_json)
  `,
  casPutRunByFence: `
    UPDATE control_plane_runs SET
      state=?, plan_id=?, plan_item_rank=?, task_id=?, target_gate=?, role=?,
      agent_id=?, model=?, effort=?, masked_account_ref=?, canonical_hash=?,
      collision_scope_lock_ids_json=?, fencing_token=?, fencing_version=?,
      registered_at_ms=?, heartbeat_at_ms=?, lease_expires_at_ms=?, material_progress_at_ms=?,
      heartbeat_sequence=?, expected_entity_rev=?, expected_board_rev=?, entity_rev=?, board_rev=?,
      stalled=?, history_json=?, last_heartbeat_response_json=?, controller_run_id=?, parent_run_id=?,
      idempotency_key=?, record_json=?
    WHERE board_id=? AND run_id=? AND fencing_token<=>? AND entity_rev=?
  `,
  getRun: `SELECT * FROM control_plane_runs WHERE board_id=? AND run_id=? LIMIT 1`,
  listRuns: `SELECT * FROM control_plane_runs WHERE board_id=?`,
  /** Insert-only — never ODKU (secondary unique held_scope must not hijack PK row). */
  putCollisionLock: `
    INSERT INTO control_plane_collision_locks (
      board_id, lock_id, scope_id, task_id, run_id, agent_id, role,
      fencing_token, fencing_version, state, lease_expires_at_ms, acquired_at_ms,
      released_at_ms, superseded_by_lock_id, supersedes_lock_id, entity_rev, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
  casPutCollisionByFence: `
    UPDATE control_plane_collision_locks SET
      scope_id=?, task_id=?, run_id=?, agent_id=?, role=?, fencing_token=?, fencing_version=?,
      state=?, lease_expires_at_ms=?, acquired_at_ms=?, released_at_ms=?,
      superseded_by_lock_id=?, supersedes_lock_id=?, entity_rev=?, record_json=?
    WHERE board_id=? AND lock_id=? AND fencing_token<=>? AND entity_rev=?
  `,
  getCollisionLock: `SELECT * FROM control_plane_collision_locks WHERE board_id=? AND lock_id=? LIMIT 1`,
  getCollisionByScope: `
    SELECT * FROM control_plane_collision_locks
    WHERE board_id=? AND scope_id=? AND state='HELD' LIMIT 1
  `,
  listCollisionLocks: `SELECT * FROM control_plane_collision_locks WHERE board_id=?`,
  /** Insert-only — never ODKU (secondary unique held repo+branch must not hijack PK row). */
  putIntegrationLock: `
    INSERT INTO control_plane_integration_locks (
      board_id, lock_id, repo_id, tracking_branch, run_id, agent_id, integrator_model,
      root_acceptance_id, checkpoint_id, pathspecs_json, fencing_token, fencing_version,
      state, lease_expires_at_ms, acquired_at_ms, released_at_ms, entity_rev, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
  `,
  casPutIntegrationByFence: `
    UPDATE control_plane_integration_locks SET
      repo_id=?, tracking_branch=?, run_id=?, agent_id=?, integrator_model=?,
      root_acceptance_id=?, checkpoint_id=?, pathspecs_json=?, fencing_token=?, fencing_version=?,
      state=?, lease_expires_at_ms=?, acquired_at_ms=?, released_at_ms=?, entity_rev=?, record_json=?
    WHERE board_id=? AND lock_id=? AND fencing_token<=>? AND entity_rev=?
  `,
  /** Live (HELD) integration lock for repo+branch — multi-process single-holder read. */
  getIntegrationLock: `
    SELECT * FROM control_plane_integration_locks
    WHERE board_id=? AND repo_id=? AND tracking_branch=? AND state='HELD' LIMIT 1
  `,
  getIntegrationLockById: `
    SELECT * FROM control_plane_integration_locks
    WHERE board_id=? AND lock_id=? LIMIT 1
  `,
  listIntegrationLocks: `SELECT * FROM control_plane_integration_locks WHERE board_id=?`,
  putAccountSnapshot: `
    INSERT INTO control_plane_account_snapshots (
      board_id, source_revision, generated_at, generated_at_ms, published_at_ms,
      last_periodic_health_at_ms, stale, stale_reason, usable_capacity, entity_rev,
      accounts_json, capacity_json, readback_surfaces_json, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      source_revision=VALUES(source_revision), generated_at=VALUES(generated_at),
      generated_at_ms=VALUES(generated_at_ms), published_at_ms=VALUES(published_at_ms),
      last_periodic_health_at_ms=VALUES(last_periodic_health_at_ms), stale=VALUES(stale),
      stale_reason=VALUES(stale_reason), usable_capacity=VALUES(usable_capacity),
      entity_rev=VALUES(entity_rev), accounts_json=VALUES(accounts_json),
      capacity_json=VALUES(capacity_json), readback_surfaces_json=VALUES(readback_surfaces_json),
      record_json=VALUES(record_json)
  `,
  getAccountSnapshot: `SELECT * FROM control_plane_account_snapshots WHERE board_id=? LIMIT 1`,
  putAccountReadback: `
    INSERT INTO control_plane_account_readbacks (
      board_id, surface, source_revision, generated_at, generated_at_ms, recorded_at_ms, entity_rev
    ) VALUES (?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      source_revision=VALUES(source_revision), generated_at=VALUES(generated_at),
      generated_at_ms=VALUES(generated_at_ms), recorded_at_ms=VALUES(recorded_at_ms),
      entity_rev=VALUES(entity_rev)
  `,
  putReconcilerLeader: `
    INSERT INTO control_plane_reconciler_leaders (
      board_id, leader_id, fencing_token, lease_expires_at_ms, entity_rev
    ) VALUES (?,?,?,?,1)
    ON DUPLICATE KEY UPDATE
      leader_id=VALUES(leader_id), fencing_token=VALUES(fencing_token),
      lease_expires_at_ms=VALUES(lease_expires_at_ms), entity_rev=entity_rev+1
  `,
  casPutReconcilerLeader: `
    UPDATE control_plane_reconciler_leaders
    SET leader_id=?, fencing_token=?, lease_expires_at_ms=?, entity_rev=entity_rev+1
    WHERE board_id=? AND fencing_token=?
  `,
  getReconcilerLeader: `SELECT * FROM control_plane_reconciler_leaders WHERE board_id=? LIMIT 1`,
  putReconcilerDryRun: `
    INSERT INTO control_plane_reconciler_dryruns (
      board_id, dry_run_hash, dry_run_id, board_rev, leader_token, cursor_val, next_cursor,
      max_actions, time_budget_ms, items_json, counts_json, generated_at_ms, generated_at,
      entity_rev, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,1,?)
    ON DUPLICATE KEY UPDATE
      dry_run_id=VALUES(dry_run_id), board_rev=VALUES(board_rev), leader_token=VALUES(leader_token),
      cursor_val=VALUES(cursor_val), next_cursor=VALUES(next_cursor),
      max_actions=VALUES(max_actions), time_budget_ms=VALUES(time_budget_ms),
      items_json=VALUES(items_json), counts_json=VALUES(counts_json),
      generated_at_ms=VALUES(generated_at_ms), generated_at=VALUES(generated_at),
      record_json=VALUES(record_json)
  `,
  getReconcilerDryRun: `
    SELECT * FROM control_plane_reconciler_dryruns WHERE board_id=? AND dry_run_hash=? LIMIT 1
  `,
  putLastApplyHash: `
    INSERT INTO control_plane_reconciler_apply (
      board_id, last_apply_dry_run_hash, applied_at_ms, entity_rev
    ) VALUES (?,?,?,1)
    ON DUPLICATE KEY UPDATE
      last_apply_dry_run_hash=VALUES(last_apply_dry_run_hash),
      applied_at_ms=VALUES(applied_at_ms), entity_rev=entity_rev+1
  `,
  getLastApplyHash: `SELECT last_apply_dry_run_hash FROM control_plane_reconciler_apply WHERE board_id=? LIMIT 1`,
  putTaskCompleted: `
    INSERT INTO control_plane_reconciler_task_flags (board_id, task_id, completed, entity_rev)
    VALUES (?,?,?,1)
    ON DUPLICATE KEY UPDATE completed=VALUES(completed), entity_rev=entity_rev+1
  `,
  getTaskCompleted: `
    SELECT completed FROM control_plane_reconciler_task_flags WHERE board_id=? AND task_id=? LIMIT 1
  `,
  putRetentionPolicy: `
    INSERT INTO control_plane_retention_policies (
      board_id, policy_id, policy_version, heartbeat_sample_interval, hot_state_retention_ms,
      sampled_event_retention_ms, rollup_retention_ms, compaction_interval_ms,
      approved_for_json, entity_rev, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,1,?)
    ON DUPLICATE KEY UPDATE
      policy_id=VALUES(policy_id), policy_version=VALUES(policy_version),
      heartbeat_sample_interval=VALUES(heartbeat_sample_interval),
      hot_state_retention_ms=VALUES(hot_state_retention_ms),
      sampled_event_retention_ms=VALUES(sampled_event_retention_ms),
      rollup_retention_ms=VALUES(rollup_retention_ms),
      compaction_interval_ms=VALUES(compaction_interval_ms),
      approved_for_json=VALUES(approved_for_json), entity_rev=entity_rev+1,
      record_json=VALUES(record_json)
  `,
  getRetentionPolicy: `SELECT * FROM control_plane_retention_policies WHERE board_id=? LIMIT 1`,
  putHotState: `
    INSERT INTO control_plane_retention_hot_state (
      board_id, run_id, last_heartbeat_at_ms, heartbeat_sequence, status,
      material_progress_at_ms, entity_rev, record_json
    ) VALUES (?,?,?,?,?,?,1,?)
    ON DUPLICATE KEY UPDATE
      last_heartbeat_at_ms=VALUES(last_heartbeat_at_ms),
      heartbeat_sequence=VALUES(heartbeat_sequence), status=VALUES(status),
      material_progress_at_ms=VALUES(material_progress_at_ms), entity_rev=entity_rev+1,
      record_json=VALUES(record_json)
  `,
  getHotState: `SELECT * FROM control_plane_retention_hot_state WHERE board_id=? AND run_id=? LIMIT 1`,
  listHotState: `SELECT * FROM control_plane_retention_hot_state WHERE board_id=?`,
  deleteHotState: `DELETE FROM control_plane_retention_hot_state WHERE board_id=? AND run_id=?`,
  appendAuditSample: `
    INSERT INTO control_plane_retention_audit_sample (
      board_id, audit_id, run_id, event_class, event_type, at_ms, immutable, payload_json, entity_rev
    ) VALUES (?,?,?,?,?,?,?,?,1)
  `,
  listAuditSample: `SELECT * FROM control_plane_retention_audit_sample WHERE board_id=?`,
  deleteAuditSample: `DELETE FROM control_plane_retention_audit_sample WHERE board_id=? AND audit_id=?`,
} as const

// ---------------------------------------------------------------------------
// Retention policy store interface (board-scoped durable policy)
// ---------------------------------------------------------------------------

export interface RetentionPolicyStore {
  get(boardId: string): Promise<BoardPolicyRetention | null>
  put(boardId: string, policy: BoardPolicyRetention): Promise<void>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

// ---------------------------------------------------------------------------
// Bundle type
// ---------------------------------------------------------------------------

export interface ControlPlaneRuntimePersistence {
  plans: DispatchPlanStore
  runs: RunRegistryStore
  locks: LockStore
  accounts: AccountSyncStore
  reconciler: ReconcilerStore
  /**
   * Sync RetentionStore (domain applyHeartbeat).
   * - memory mode: in-process durable-for-process map (tests / local).
   * - mysql mode: fail-closed stub — live mutations MUST use retentionAsync.
   */
  retention: RetentionStore
  retentionPolicy: RetentionPolicyStore
  /**
   * Durable async hot/audit path (MySQL tables; memory SQL in tests).
   * heartbeatRun binds via RunRegistryDeps.retentionAsync + applyHeartbeatAsync
   * (sample/material/compaction). No process-local dual-model invent.
   */
  retentionAsync: ReturnType<typeof createMysqlRetentionAsyncStore>
  /** mysql = multi-process named-lock required; memory = explicit test factory. */
  mode: 'mysql' | 'memory'
}

// ---------------------------------------------------------------------------
// MySQL store factories
// ---------------------------------------------------------------------------

export function createMysqlDispatchPlanStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): DispatchPlanStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async get(boardId, planId) {
      const res = await exec.execute(RUNTIME_SQL.getDispatchPlan, [boardId, planId])
      const row = res.rows[0]
      return row ? decodeDispatchPlanRecord(row) : null
    },
    async put(plan) {
      const e = encodeDispatchPlanRecord(plan)
      await exec.execute(RUNTIME_SQL.putDispatchPlan, [
        e.board_id,
        e.plan_id,
        e.plan_version,
        e.plan_hash,
        e.canonical_snapshot_id,
        e.canonical_hash,
        e.board_rev_at_publish,
        e.issued_at,
        e.issued_at_ms,
        e.expires_at,
        e.expires_at_ms,
        e.stage,
        e.status,
        e.generated_at,
        e.generated_at_ms,
        e.superseded_by_plan_id,
        e.entity_rev,
        jsonParam(e.items_json),
        jsonParam(e.record_json),
      ])
      // Best-effort item rows (denormalized for query); full fidelity in items_json/record_json.
      for (const it of plan.items) {
        await exec.execute(
          `INSERT INTO control_plane_dispatch_plan_items (
            board_id, plan_id, rank_n, task_id, target_gate, role, selection_reason,
            priority_portfolio_id, dependency_proof_json, collision_scope_lock_ids_json,
            expected_entity_rev, expected_board_rev
          ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)
          ON DUPLICATE KEY UPDATE
            task_id=VALUES(task_id), target_gate=VALUES(target_gate), role=VALUES(role),
            selection_reason=VALUES(selection_reason),
            priority_portfolio_id=VALUES(priority_portfolio_id),
            dependency_proof_json=VALUES(dependency_proof_json),
            collision_scope_lock_ids_json=VALUES(collision_scope_lock_ids_json),
            expected_entity_rev=VALUES(expected_entity_rev),
            expected_board_rev=VALUES(expected_board_rev)`,
          [
            plan.boardId,
            plan.planId,
            it.rank,
            it.taskId,
            it.targetGate,
            it.role,
            it.selectionReason,
            it.priorityPortfolioId ?? null,
            jsonParam(it.dependencyProof ?? null),
            jsonParam(it.collisionScopeLockIds ?? []),
            it.expectedEntityRev,
            it.expectedBoardRev,
          ],
        )
      }
    },
    async list(boardId) {
      const res = await exec.execute(RUNTIME_SQL.listDispatchPlans, [boardId])
      return res.rows.map((r) => decodeDispatchPlanRecord(r))
    },
    async getActive(boardId) {
      const res = await exec.execute(RUNTIME_SQL.getActiveDispatchPlan, [boardId])
      const row = res.rows[0]
      return row ? decodeDispatchPlanRecord(row) : null
    },
    withBoardLock: lock,
  }
}

function runPutParams(rec: RunRecord): Array<unknown> {
  const e = encodeRunRecord(rec)
  return [
    e.board_id,
    e.run_id,
    e.state,
    e.plan_id,
    e.plan_item_rank,
    e.task_id,
    e.target_gate,
    e.role,
    e.agent_id,
    e.model,
    e.effort,
    e.masked_account_ref,
    e.canonical_hash,
    jsonParam(e.collision_scope_lock_ids_json),
    e.fencing_token,
    e.fencing_version,
    e.registered_at_ms,
    e.heartbeat_at_ms,
    e.lease_expires_at_ms,
    e.material_progress_at_ms,
    e.heartbeat_sequence,
    e.expected_entity_rev,
    e.expected_board_rev,
    e.entity_rev,
    e.board_rev,
    e.stalled,
    jsonParam(e.history_json),
    jsonParam(e.last_heartbeat_response_json),
    e.controller_run_id,
    e.parent_run_id,
    e.idempotency_key,
    jsonParam(e.record_json),
  ]
}

function runCasUpdateParams(
  rec: RunRecord,
  expectedFencingToken: string | null | undefined,
  expectedEntityRev: number,
): Array<unknown> {
  const e = encodeRunRecord(rec)
  return [
    e.state,
    e.plan_id,
    e.plan_item_rank,
    e.task_id,
    e.target_gate,
    e.role,
    e.agent_id,
    e.model,
    e.effort,
    e.masked_account_ref,
    e.canonical_hash,
    jsonParam(e.collision_scope_lock_ids_json),
    e.fencing_token,
    e.fencing_version,
    e.registered_at_ms,
    e.heartbeat_at_ms,
    e.lease_expires_at_ms,
    e.material_progress_at_ms,
    e.heartbeat_sequence,
    e.expected_entity_rev,
    e.expected_board_rev,
    e.entity_rev,
    e.board_rev,
    e.stalled,
    jsonParam(e.history_json),
    jsonParam(e.last_heartbeat_response_json),
    e.controller_run_id,
    e.parent_run_id,
    e.idempotency_key,
    jsonParam(e.record_json),
    rec.boardId,
    rec.runId,
    expectedFencingToken,
    expectedEntityRev,
  ]
}

export function createMysqlRunRegistryStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): RunRegistryStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async get(boardId, runId) {
      const res = await exec.execute(RUNTIME_SQL.getRun, [boardId, runId])
      const row = res.rows[0]
      return row ? decodeRunRecord(row) : null
    },
    async put(rec) {
      const existingRes = await exec.execute(RUNTIME_SQL.getRun, [rec.boardId, rec.runId])
      const existing = existingRes.rows[0] ? decodeRunRecord(existingRes.rows[0]) : null
      assertCasMutationAllowed({
        existing: existing
          ? { fencingToken: existing.fencingToken, entityRev: existing.entityRev }
          : null,
        next: { fencingToken: rec.fencingToken, entityRev: rec.entityRev },
        entityId: rec.runId,
        kind: 'run',
      })
      if (!existing) {
        await exec.execute(RUNTIME_SQL.putRun, runPutParams(rec))
        return
      }
      // Existing row: fencing + expected entity_rev CAS (no unconditional LWW).
      const cas = await casUpdateRunWithFencing(
        exec,
        rec,
        existing.fencingToken,
        existing.entityRev,
      )
      if (!cas.ok) {
        throw new RuntimePersistenceError(cas.code, `run CAS put rejected: ${cas.code}`, {
          runId: rec.runId,
          expectedFencingToken: existing.fencingToken,
          expectedEntityRev: existing.entityRev,
          nextEntityRev: rec.entityRev,
        })
      }
    },
    async list(boardId) {
      const res = await exec.execute(RUNTIME_SQL.listRuns, [boardId])
      return res.rows.map((r) => decodeRunRecord(r))
    },
    withBoardLock: lock,
  }
}

/**
 * CAS update for run mutations: requires matching fencing_token + expected entity_rev.
 * Full-row UPDATE (not LWW upsert). 0 affected → FENCED or STALE_REVISION.
 */
export async function casUpdateRunWithFencing(
  exec: SqlExecutor,
  rec: RunRecord,
  expectedFencingToken: string | null | undefined,
  expectedEntityRev: number,
): Promise<{ ok: true } | { ok: false; code: 'FENCED' | 'STALE_REVISION' }> {
  const res = await exec.execute(
    RUNTIME_SQL.casPutRunByFence,
    runCasUpdateParams(rec, expectedFencingToken ?? null, expectedEntityRev),
  )
  if (res.affectedRows >= 1) return { ok: true }
  // Distinguish fence vs revision when possible.
  const curRes = await exec.execute(RUNTIME_SQL.getRun, [rec.boardId, rec.runId])
  const cur = curRes.rows[0] ? decodeRunRecord(curRes.rows[0]) : null
  if (!cur) return { ok: false, code: 'FENCED' }
  if ((cur.fencingToken ?? null) !== (expectedFencingToken ?? null)) {
    return { ok: false, code: 'FENCED' }
  }
  return { ok: false, code: 'STALE_REVISION' }
}

export function createMysqlLockStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): LockStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async listCollision(boardId) {
      const res = await exec.execute(RUNTIME_SQL.listCollisionLocks, [boardId])
      return res.rows.map((r) => decodeCollisionLock(r))
    },
    async getCollision(boardId, lockId) {
      const res = await exec.execute(RUNTIME_SQL.getCollisionLock, [boardId, lockId])
      const row = res.rows[0]
      return row ? decodeCollisionLock(row) : null
    },
    async getCollisionByScope(boardId, scopeId) {
      const res = await exec.execute(RUNTIME_SQL.getCollisionByScope, [boardId, scopeId])
      const row = res.rows[0]
      return row ? decodeCollisionLock(row) : null
    },
    async putCollision(rec) {
      const existingRes = await exec.execute(RUNTIME_SQL.getCollisionLock, [
        rec.boardId,
        rec.lockId,
      ])
      const existing = existingRes.rows[0] ? decodeCollisionLock(existingRes.rows[0]) : null

      // Same PK + same canonical content: idempotent replay (explicit read, no write).
      if (existing && collisionLockCanonicalEqual(existing, rec)) {
        return
      }

      if (existing) {
        // Different payload: only fence/revision CAS may update; never ODKU overwrite.
        const sameFence =
          (existing.fencingToken ?? null) === (rec.fencingToken ?? null)
        if (!sameFence) {
          throw new RuntimePersistenceError(
            'FENCED',
            'collision_lock fencing token invalid or superseded',
            {
              entityId: rec.lockId,
              expected: existing.fencingToken,
              attempted: rec.fencingToken,
              currentEntityRev: existing.entityRev,
              nextEntityRev: rec.entityRev,
            },
          )
        }
        if (rec.entityRev <= existing.entityRev) {
          throw new RuntimePersistenceError(
            'IDEMPOTENCY_CONFLICT',
            'collision lock PK exists with different payload (insert-only; no overwrite)',
            {
              boardId: rec.boardId,
              lockId: rec.lockId,
              existingRunId: existing.runId,
              attemptedRunId: rec.runId,
              existingEntityRev: existing.entityRev,
              attemptedEntityRev: rec.entityRev,
            },
          )
        }
        // Multi-process invariant on CAS update path too.
        if (rec.state === 'HELD') {
          const heldRes = await exec.execute(RUNTIME_SQL.getCollisionByScope, [
            rec.boardId,
            rec.scopeId,
          ])
          const held = heldRes.rows[0] ? decodeCollisionLock(heldRes.rows[0]) : null
          if (held && held.lockId !== rec.lockId) {
            throw new RuntimePersistenceError(
              'CLAIM_COLLISION',
              'collision scope already HELD by another lock (uq_collision_held_scope)',
              {
                boardId: rec.boardId,
                scopeId: rec.scopeId,
                existingLockId: held.lockId,
                attemptedLockId: rec.lockId,
                existingTaskId: held.taskId,
                attemptedTaskId: rec.taskId,
              },
            )
          }
        }
        const cas = await casUpdateCollisionWithFencing(
          exec,
          rec,
          existing.fencingToken,
          existing.entityRev,
        )
        if (!cas.ok) {
          throw new RuntimePersistenceError(
            cas.code,
            `collision lock CAS put rejected: ${cas.code}`,
            {
              lockId: rec.lockId,
              expectedFencingToken: existing.fencingToken,
              expectedEntityRev: existing.entityRev,
            },
          )
        }
        return
      }

      // Insert-only path: plain INSERT; never ON DUPLICATE KEY UPDATE.
      // Pre-check is best-effort; unique index is the multi-process authority.
      if (rec.state === 'HELD') {
        const heldRes = await exec.execute(RUNTIME_SQL.getCollisionByScope, [
          rec.boardId,
          rec.scopeId,
        ])
        const held = heldRes.rows[0] ? decodeCollisionLock(heldRes.rows[0]) : null
        if (held && held.lockId !== rec.lockId) {
          throw new RuntimePersistenceError(
            'CLAIM_COLLISION',
            'collision scope already HELD by another lock (uq_collision_held_scope)',
            {
              boardId: rec.boardId,
              scopeId: rec.scopeId,
              existingLockId: held.lockId,
              attemptedLockId: rec.lockId,
              existingTaskId: held.taskId,
              attemptedTaskId: rec.taskId,
            },
          )
        }
      }
      const e = encodeCollisionLock(rec)
      try {
        await exec.execute(RUNTIME_SQL.putCollisionLock, [
          e.board_id,
          e.lock_id,
          e.scope_id,
          e.task_id,
          e.run_id,
          e.agent_id,
          e.role,
          e.fencing_token,
          e.fencing_version,
          e.state,
          e.lease_expires_at_ms,
          e.acquired_at_ms,
          e.released_at_ms,
          e.superseded_by_lock_id,
          e.supersedes_lock_id,
          e.entity_rev,
          jsonParam(e.record_json),
        ])
      } catch (err) {
        await resolveCollisionInsertDuplicate(exec, rec, err)
      }
    },
    async listIntegration(boardId) {
      const res = await exec.execute(RUNTIME_SQL.listIntegrationLocks, [boardId])
      return res.rows.map((r) => decodeIntegrationLock(r))
    },
    async getIntegration(boardId, repoId, trackingBranch) {
      const res = await exec.execute(RUNTIME_SQL.getIntegrationLock, [
        boardId,
        repoId,
        trackingBranch,
      ])
      const row = res.rows[0]
      return row ? decodeIntegrationLock(row) : null
    },
    async putIntegration(rec) {
      // Identity is lock_id (history rows share repo+branch; only one may be HELD).
      const existingRes = await exec.execute(RUNTIME_SQL.getIntegrationLockById, [
        rec.boardId,
        rec.lockId,
      ])
      const existing = existingRes.rows[0] ? decodeIntegrationLock(existingRes.rows[0]) : null

      // Same PK + same canonical content: idempotent replay (explicit read, no write).
      if (existing && integrationLockCanonicalEqual(existing, rec)) {
        return
      }

      if (existing) {
        // Different payload: only fence/revision CAS may update; never ODKU overwrite.
        const sameFence =
          (existing.fencingToken ?? null) === (rec.fencingToken ?? null)
        if (!sameFence) {
          throw new RuntimePersistenceError(
            'FENCED',
            'integration_lock fencing token invalid or superseded',
            {
              entityId: rec.lockId,
              expected: existing.fencingToken,
              attempted: rec.fencingToken,
              currentEntityRev: existing.entityRev,
              nextEntityRev: rec.entityRev,
            },
          )
        }
        if (rec.entityRev <= existing.entityRev) {
          throw new RuntimePersistenceError(
            'IDEMPOTENCY_CONFLICT',
            'integration lock PK exists with different payload (insert-only; no overwrite)',
            {
              boardId: rec.boardId,
              lockId: rec.lockId,
              existingRunId: existing.runId,
              attemptedRunId: rec.runId,
              existingEntityRev: existing.entityRev,
              attemptedEntityRev: rec.entityRev,
            },
          )
        }
        if (rec.state === 'HELD') {
          const heldRes = await exec.execute(RUNTIME_SQL.getIntegrationLock, [
            rec.boardId,
            rec.repoId,
            rec.trackingBranch,
          ])
          const held = heldRes.rows[0] ? decodeIntegrationLock(heldRes.rows[0]) : null
          if (held && held.lockId !== rec.lockId) {
            throw new RuntimePersistenceError(
              'CLAIM_COLLISION',
              'integration repo+branch already HELD by another lock (uq_integration_held_repo_branch)',
              {
                boardId: rec.boardId,
                repoId: rec.repoId,
                trackingBranch: rec.trackingBranch,
                existingLockId: held.lockId,
                attemptedLockId: rec.lockId,
                existingRunId: held.runId,
                attemptedRunId: rec.runId,
              },
            )
          }
        }
        const cas = await casUpdateIntegrationWithFencing(
          exec,
          rec,
          existing.fencingToken,
          existing.entityRev,
        )
        if (!cas.ok) {
          throw new RuntimePersistenceError(
            cas.code,
            `integration lock CAS put rejected: ${cas.code}`,
            {
              lockId: rec.lockId,
              expectedFencingToken: existing.fencingToken,
              expectedEntityRev: existing.entityRev,
            },
          )
        }
        return
      }

      // Insert-only path: plain INSERT; never ON DUPLICATE KEY UPDATE.
      if (rec.state === 'HELD') {
        const heldRes = await exec.execute(RUNTIME_SQL.getIntegrationLock, [
          rec.boardId,
          rec.repoId,
          rec.trackingBranch,
        ])
        const held = heldRes.rows[0] ? decodeIntegrationLock(heldRes.rows[0]) : null
        if (held && held.lockId !== rec.lockId) {
          throw new RuntimePersistenceError(
            'CLAIM_COLLISION',
            'integration repo+branch already HELD by another lock (uq_integration_held_repo_branch)',
            {
              boardId: rec.boardId,
              repoId: rec.repoId,
              trackingBranch: rec.trackingBranch,
              existingLockId: held.lockId,
              attemptedLockId: rec.lockId,
              existingRunId: held.runId,
              attemptedRunId: rec.runId,
            },
          )
        }
      }
      const e = encodeIntegrationLock(rec)
      try {
        await exec.execute(RUNTIME_SQL.putIntegrationLock, [
          e.board_id,
          e.lock_id,
          e.repo_id,
          e.tracking_branch,
          e.run_id,
          e.agent_id,
          e.integrator_model,
          e.root_acceptance_id,
          e.checkpoint_id,
          jsonParam(e.pathspecs_json),
          e.fencing_token,
          e.fencing_version,
          e.state,
          e.lease_expires_at_ms,
          e.acquired_at_ms,
          e.released_at_ms,
          e.entity_rev,
          jsonParam(e.record_json),
        ])
      } catch (err) {
        await resolveIntegrationInsertDuplicate(exec, rec, err)
      }
    },
    withBoardLock: lock,
  }
}

/**
 * After plain INSERT race: same PK + same content → replay; same PK different payload →
 * IDEMPOTENCY_CONFLICT; held-scope unique → CLAIM_COLLISION. Never update existing row.
 */
async function resolveCollisionInsertDuplicate(
  exec: SqlExecutor,
  rec: CollisionLockRecord,
  err: unknown,
): Promise<void> {
  const dup = classifyMysqlDuplicateKey(err)
  if (!dup) throw err
  const againRes = await exec.execute(RUNTIME_SQL.getCollisionLock, [rec.boardId, rec.lockId])
  const again = againRes.rows[0] ? decodeCollisionLock(againRes.rows[0]) : null
  if (again) {
    if (collisionLockCanonicalEqual(again, rec)) return
    throw new RuntimePersistenceError(
      'IDEMPOTENCY_CONFLICT',
      'collision lock PK exists with different payload (insert-only; no overwrite)',
      {
        boardId: rec.boardId,
        lockId: rec.lockId,
        existingRunId: again.runId,
        attemptedRunId: rec.runId,
        existingEntityRev: again.entityRev,
        attemptedEntityRev: rec.entityRev,
        duplicateKey: dup.key,
      },
    )
  }
  // PK not present for this lock_id → secondary unique (held_scope) collision.
  throw new RuntimePersistenceError(
    'CLAIM_COLLISION',
    'collision scope already HELD by another lock (unique insert race; row not updated)',
    {
      boardId: rec.boardId,
      scopeId: rec.scopeId,
      attemptedLockId: rec.lockId,
      attemptedRunId: rec.runId,
      duplicateKey: dup.key,
    },
  )
}

/**
 * After plain INSERT race: same PK + same content → replay; same PK different payload →
 * IDEMPOTENCY_CONFLICT; held repo+branch unique → CLAIM_COLLISION. Never update existing row.
 */
async function resolveIntegrationInsertDuplicate(
  exec: SqlExecutor,
  rec: IntegrationLockRecord,
  err: unknown,
): Promise<void> {
  const dup = classifyMysqlDuplicateKey(err)
  if (!dup) throw err
  const againRes = await exec.execute(RUNTIME_SQL.getIntegrationLockById, [
    rec.boardId,
    rec.lockId,
  ])
  const again = againRes.rows[0] ? decodeIntegrationLock(againRes.rows[0]) : null
  if (again) {
    if (integrationLockCanonicalEqual(again, rec)) return
    throw new RuntimePersistenceError(
      'IDEMPOTENCY_CONFLICT',
      'integration lock PK exists with different payload (insert-only; no overwrite)',
      {
        boardId: rec.boardId,
        lockId: rec.lockId,
        existingRunId: again.runId,
        attemptedRunId: rec.runId,
        existingEntityRev: again.entityRev,
        attemptedEntityRev: rec.entityRev,
        duplicateKey: dup.key,
      },
    )
  }
  throw new RuntimePersistenceError(
    'CLAIM_COLLISION',
    'integration repo+branch already HELD by another lock (unique insert race; row not updated)',
    {
      boardId: rec.boardId,
      repoId: rec.repoId,
      trackingBranch: rec.trackingBranch,
      attemptedLockId: rec.lockId,
      attemptedRunId: rec.runId,
      duplicateKey: dup.key,
    },
  )
}

/** CAS update collision lock: matching fencing_token + expected entity_rev. */
export async function casUpdateCollisionWithFencing(
  exec: SqlExecutor,
  rec: CollisionLockRecord,
  expectedFencingToken: string,
  expectedEntityRev: number,
): Promise<{ ok: true } | { ok: false; code: 'FENCED' | 'STALE_REVISION' }> {
  const e = encodeCollisionLock(rec)
  const res = await exec.execute(RUNTIME_SQL.casPutCollisionByFence, [
    e.scope_id,
    e.task_id,
    e.run_id,
    e.agent_id,
    e.role,
    e.fencing_token,
    e.fencing_version,
    e.state,
    e.lease_expires_at_ms,
    e.acquired_at_ms,
    e.released_at_ms,
    e.superseded_by_lock_id,
    e.supersedes_lock_id,
    e.entity_rev,
    jsonParam(e.record_json),
    rec.boardId,
    rec.lockId,
    expectedFencingToken,
    expectedEntityRev,
  ])
  if (res.affectedRows >= 1) return { ok: true }
  const curRes = await exec.execute(RUNTIME_SQL.getCollisionLock, [rec.boardId, rec.lockId])
  const cur = curRes.rows[0] ? decodeCollisionLock(curRes.rows[0]) : null
  if (!cur || cur.fencingToken !== expectedFencingToken) return { ok: false, code: 'FENCED' }
  return { ok: false, code: 'STALE_REVISION' }
}

/** CAS update integration lock by lock_id: matching fencing_token + expected entity_rev. */
export async function casUpdateIntegrationWithFencing(
  exec: SqlExecutor,
  rec: IntegrationLockRecord,
  expectedFencingToken: string,
  expectedEntityRev: number,
): Promise<{ ok: true } | { ok: false; code: 'FENCED' | 'STALE_REVISION' }> {
  const e = encodeIntegrationLock(rec)
  const res = await exec.execute(RUNTIME_SQL.casPutIntegrationByFence, [
    e.repo_id,
    e.tracking_branch,
    e.run_id,
    e.agent_id,
    e.integrator_model,
    e.root_acceptance_id,
    e.checkpoint_id,
    jsonParam(e.pathspecs_json),
    e.fencing_token,
    e.fencing_version,
    e.state,
    e.lease_expires_at_ms,
    e.acquired_at_ms,
    e.released_at_ms,
    e.entity_rev,
    jsonParam(e.record_json),
    rec.boardId,
    rec.lockId,
    expectedFencingToken,
    expectedEntityRev,
  ])
  if (res.affectedRows >= 1) return { ok: true }
  const curRes = await exec.execute(RUNTIME_SQL.getIntegrationLockById, [
    rec.boardId,
    rec.lockId,
  ])
  const cur = curRes.rows[0] ? decodeIntegrationLock(curRes.rows[0]) : null
  if (!cur || cur.fencingToken !== expectedFencingToken) return { ok: false, code: 'FENCED' }
  return { ok: false, code: 'STALE_REVISION' }
}

export function createMysqlAccountSyncStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): AccountSyncStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async get(boardId) {
      const res = await exec.execute(RUNTIME_SQL.getAccountSnapshot, [boardId])
      const row = res.rows[0]
      return row ? decodeAccountSyncSnapshot(row) : null
    },
    async put(snap) {
      const e = encodeAccountSyncSnapshot(snap)
      await exec.execute(RUNTIME_SQL.putAccountSnapshot, [
        e.board_id,
        e.source_revision,
        e.generated_at,
        e.generated_at_ms,
        e.published_at_ms,
        e.last_periodic_health_at_ms,
        e.stale,
        e.stale_reason,
        e.usable_capacity,
        e.entity_rev,
        jsonParam(e.accounts_json),
        jsonParam(e.capacity_json),
        jsonParam(e.readback_surfaces_json),
        jsonParam(e.record_json),
      ])
      // Persist each surface readback row for SQL-side parity queries.
      for (const surface of ['mcp', 'api', 'ui', 'ops'] as const) {
        const rb = snap.readbackSurfaces[surface]
        if (!rb) continue
        const generatedAtMs = Date.parse(rb.generatedAt)
        await exec.execute(RUNTIME_SQL.putAccountReadback, [
          snap.boardId,
          surface,
          rb.sourceRevision,
          msToDatetime(Number.isFinite(generatedAtMs) ? generatedAtMs : snap.generatedAtMs) ??
            rb.generatedAt,
          Number.isFinite(generatedAtMs) ? generatedAtMs : snap.generatedAtMs,
          Date.now(),
          snap.entityRev,
        ])
      }
    },
    withBoardLock: lock,
  }
}

export function createMysqlReconcilerStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): ReconcilerStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async getLeader(boardId) {
      const res = await exec.execute(RUNTIME_SQL.getReconcilerLeader, [boardId])
      const row = res.rows[0]
      return row ? decodeReconcilerLeader(row) : null
    },
    async putLeader(state) {
      const curRes = await exec.execute(RUNTIME_SQL.getReconcilerLeader, [state.boardId])
      const cur = curRes.rows[0] ? decodeReconcilerLeader(curRes.rows[0]) : null
      const e = encodeReconcilerLeader(state)
      if (!cur) {
        await exec.execute(RUNTIME_SQL.putReconcilerLeader, [
          e.board_id,
          e.leader_id,
          e.fencing_token,
          e.lease_expires_at_ms,
        ])
        return
      }
      // Same fencing token → renew via CAS helper (reject fenced/stale actors).
      if (cur.fencingToken === state.fencingToken) {
        const cas = await casRenewReconcilerLeader(exec, state, cur.fencingToken)
        if (!cas.ok) {
          throw new RuntimePersistenceError('FENCED', 'reconciler leader CAS renew rejected', {
            boardId: state.boardId,
            expected: cur.fencingToken,
            attempted: state.fencingToken,
          })
        }
        return
      }
      // Different fencing = leadership transfer. Only when current lease expired.
      const now = Date.now()
      if (cur.leaseExpiresAtMs > now) {
        throw new RuntimePersistenceError(
          'FENCED',
          'reconciler leader fencing token invalid or superseded',
          {
            boardId: state.boardId,
            expected: cur.fencingToken,
            attempted: state.fencingToken,
            leaseExpiresAtMs: cur.leaseExpiresAtMs,
            now,
          },
        )
      }
      await exec.execute(RUNTIME_SQL.putReconcilerLeader, [
        e.board_id,
        e.leader_id,
        e.fencing_token,
        e.lease_expires_at_ms,
      ])
    },
    async getDryRun(boardId, dryRunHash) {
      const res = await exec.execute(RUNTIME_SQL.getReconcilerDryRun, [boardId, dryRunHash])
      const row = res.rows[0]
      return row ? decodeReconcileDryRun(row) : null
    },
    async putDryRun(result) {
      const e = encodeReconcileDryRun(result)
      await exec.execute(RUNTIME_SQL.putReconcilerDryRun, [
        e.board_id,
        e.dry_run_hash,
        e.dry_run_id,
        e.board_rev,
        e.leader_token,
        e.cursor_val,
        e.next_cursor,
        e.max_actions,
        e.time_budget_ms,
        jsonParam(e.items_json),
        jsonParam(e.counts_json),
        e.generated_at_ms,
        e.generated_at,
        jsonParam(e.record_json),
      ])
    },
    async getLastApplyHash(boardId) {
      const res = await exec.execute<{ last_apply_dry_run_hash: string }>(
        RUNTIME_SQL.getLastApplyHash,
        [boardId],
      )
      const row = res.rows[0]
      return row ? asString(row.last_apply_dry_run_hash) : null
    },
    async putLastApplyHash(boardId, dryRunHash) {
      await exec.execute(RUNTIME_SQL.putLastApplyHash, [boardId, dryRunHash, Date.now()])
    },
    async isTaskCompleted(boardId, taskId) {
      const res = await exec.execute<{ completed: number }>(RUNTIME_SQL.getTaskCompleted, [
        boardId,
        taskId,
      ])
      const row = res.rows[0]
      return row ? asBool(row.completed) : false
    },
    async setTaskCompleted(boardId, taskId, completed) {
      await exec.execute(RUNTIME_SQL.putTaskCompleted, [boardId, taskId, completed ? 1 : 0])
    },
    withBoardLock: lock,
  }
}

/**
 * CAS renew leader only when fencing_token matches (multi-writer safe).
 */
export async function casRenewReconcilerLeader(
  exec: SqlExecutor,
  state: ReconcilerLeaderState,
  expectedFencingToken: string,
): Promise<{ ok: true } | { ok: false; code: 'FENCED' }> {
  const res = await exec.execute(RUNTIME_SQL.casPutReconcilerLeader, [
    state.leaderId,
    state.fencingToken,
    state.leaseExpiresAtMs,
    state.boardId,
    expectedFencingToken,
  ])
  if (res.affectedRows < 1) return { ok: false, code: 'FENCED' }
  return { ok: true }
}

export function createMysqlRetentionPolicyStore(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): RetentionPolicyStore {
  const chainLock = createBoardLockChain()
  const lock = async <T>(boardId: string, fn: () => Promise<T> | T) =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, boardId, fn) : chainLock(boardId, fn)

  return {
    async get(boardId) {
      const res = await exec.execute(RUNTIME_SQL.getRetentionPolicy, [boardId])
      const row = res.rows[0]
      return row ? decodeRetentionPolicy(row) : null
    },
    async put(boardId, policy) {
      const e = encodeRetentionPolicy(boardId, policy)
      await exec.execute(RUNTIME_SQL.putRetentionPolicy, [
        e.board_id,
        e.policy_id,
        e.policy_version,
        e.heartbeat_sample_interval,
        e.hot_state_retention_ms,
        e.sampled_event_retention_ms,
        e.rollup_retention_ms,
        e.compaction_interval_ms,
        jsonParam(e.approved_for_json),
        jsonParam(e.record_json),
      ])
    },
    withBoardLock: lock,
  }
}

/**
 * MySQL-backed RetentionStore is intentionally not provided as the domain
 * RetentionStore (sync) interface (M3).
 *
 * Live durable path: createMysqlRetentionAsyncStore / runtime.retentionAsync +
 * applyHeartbeatWithOptionalCompactionAsync on heartbeatRun (RunRegistryDeps.retentionAsync).
 * Sync RetentionStore is only safe for memory/test modes. Never invent process-local
 * createMemoryRetentionStore() in mysql mode (multi-instance diverge).
 *
 * This factory is the fail-closed sync surface (throws on every method).
 */
export function createMysqlRetentionStore(): RetentionStore {
  const fail = (method: string): never => {
    throw new RuntimePersistenceError(
      'INVALID_INPUT',
      `createMysqlRetentionStore.${method} is sync-incompatible with MySQL; use createMysqlRetentionAsyncStore (retentionAsync) or memory-mode RetentionStore — do not invent process-local sync memory in mysql mode`,
    )
  }
  return {
    getHot: () => fail('getHot'),
    putHot: () => fail('putHot'),
    listHot: () => fail('listHot'),
    deleteHot: () => fail('deleteHot'),
    appendAudit: () => fail('appendAudit'),
    listAudit: () => fail('listAudit'),
    deleteAudit: () => fail('deleteAudit'),
  }
}

/**
 * Async MySQL retention accessors (preferred over sync RetentionStore for DB).
 * Satisfies audit-retention RetentionAsyncStore — bind on RunRegistryDeps.retentionAsync.
 */
export function createMysqlRetentionAsyncStore(exec: SqlExecutor) {
  return {
    async getHot(boardId: string, runId: string): Promise<HotRunState | null> {
      const res = await exec.execute(RUNTIME_SQL.getHotState, [boardId, runId])
      const row = res.rows[0]
      return row ? decodeHotRunState(row) : null
    },
    async putHot(state: HotRunState): Promise<void> {
      const e = encodeHotRunState(state)
      await exec.execute(RUNTIME_SQL.putHotState, [
        e.board_id,
        e.run_id,
        e.last_heartbeat_at_ms,
        e.heartbeat_sequence,
        e.status,
        e.material_progress_at_ms,
        jsonParam(e.record_json),
      ])
    },
    async listHot(boardId: string): Promise<Array<HotRunState>> {
      const res = await exec.execute(RUNTIME_SQL.listHotState, [boardId])
      return res.rows.map((r) => decodeHotRunState(r))
    },
    async deleteHot(boardId: string, runId: string): Promise<void> {
      await exec.execute(RUNTIME_SQL.deleteHotState, [boardId, runId])
    },
    async appendAudit(record: AuditRecord): Promise<void> {
      const e = encodeAuditRecord(record)
      await exec.execute(RUNTIME_SQL.appendAuditSample, [
        e.board_id,
        e.audit_id,
        e.run_id,
        e.event_class,
        e.event_type,
        e.at_ms,
        e.immutable,
        jsonParam(e.payload_json),
      ])
    },
    async listAudit(
      boardId: string,
      filter?: { eventClass?: AuditEventClass; immutable?: boolean },
    ): Promise<Array<AuditRecord>> {
      const res = await exec.execute(RUNTIME_SQL.listAuditSample, [boardId])
      return res.rows
        .map((r) => decodeAuditRecord(r))
        .filter((r) => {
          if (filter?.eventClass && r.eventClass !== filter.eventClass) return false
          if (filter?.immutable != null && r.immutable !== filter.immutable) return false
          return true
        })
    },
    async deleteAudit(boardId: string, auditId: string): Promise<void> {
      await exec.execute(RUNTIME_SQL.deleteAuditSample, [boardId, auditId])
    },
  }
}

// ---------------------------------------------------------------------------
// Memory SQL executor — table-oriented fake for unit tests (no real MySQL)
// ---------------------------------------------------------------------------

type MemRow = Record<string, unknown>

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * Lightweight in-memory SQL executor that understands the RUNTIME_SQL patterns
 * used by this module. Not a general SQL engine.
 *
 * Exposes getConnection() so named-lock tests can prove GET_LOCK/RELEASE_LOCK
 * share one pinned connectionId.
 */
export function createMemorySqlExecutor(): SqlExecutor & {
  tables: Map<string, Map<string, MemRow>>
  calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }>
  /** Named locks held: lockName → connectionId that acquired it. */
  heldNamedLocks: Map<string, string>
} {
  const tables = new Map<string, Map<string, MemRow>>()
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }> = []
  const heldNamedLocks = new Map<string, string>()
  let connSeq = 0
  const POOL_ID = 'memory-pool'

  const table = (name: string) => {
    let t = tables.get(name)
    if (!t) {
      t = new Map()
      tables.set(name, t)
    }
    return t
  }

  const pk = (...parts: Array<unknown>) => parts.map((p) => String(p ?? '')).join('::')

  const nullSafeEq = (a: unknown, b: unknown) =>
    a == null && b == null ? true : a === b

  /** mysql2-shaped ER_DUP_ENTRY so put* insert-conflict resolvers exercise real paths. */
  function throwDupEntry(key: string): never {
    const err = new Error(`Duplicate entry for key '${key}'`) as Error & {
      errno: number
      code: string
    }
    err.errno = 1062
    err.code = 'ER_DUP_ENTRY'
    throw err
  }

  async function executeOn(
    connectionId: string,
    sql: string,
    params: ReadonlyArray<unknown> = [],
  ): Promise<SqlExecuteResult> {
      calls.push({ sql, params, connectionId })
      const s = normalizeSql(sql)

      // Named locks — connection-scoped (must acquire+release on same connectionId)
      if (s.startsWith('SELECT GET_LOCK')) {
        const lockName = String(params[0] ?? '')
        const holder = heldNamedLocks.get(lockName)
        if (holder && holder !== connectionId) {
          return { rows: [{ l: 0 }], affectedRows: 1 }
        }
        heldNamedLocks.set(lockName, connectionId)
        return { rows: [{ l: 1 }], affectedRows: 1 }
      }
      if (s.startsWith('SELECT RELEASE_LOCK')) {
        const lockName = String(params[0] ?? '')
        const holder = heldNamedLocks.get(lockName)
        if (!holder) {
          return { rows: [{ r: 0 }], affectedRows: 1 }
        }
        if (holder !== connectionId) {
          // Wrong connection cannot release — proves pin requirement.
          return { rows: [{ r: 0 }], affectedRows: 1 }
        }
        heldNamedLocks.delete(lockName)
        return { rows: [{ r: 1 }], affectedRows: 1 }
      }

      // Dispatch plans
      if (s.includes('INTO control_plane_dispatch_plans')) {
        const row: MemRow = {
          board_id: params[0],
          plan_id: params[1],
          plan_version: params[2],
          plan_hash: params[3],
          canonical_snapshot_id: params[4],
          canonical_hash: params[5],
          board_rev_at_publish: params[6],
          issued_at: params[7],
          issued_at_ms: params[8],
          expires_at: params[9],
          expires_at_ms: params[10],
          stage: params[11],
          status: params[12],
          generated_at: params[13],
          generated_at_ms: params[14],
          superseded_by_plan_id: params[15],
          entity_rev: params[16],
          items_json: params[17],
          record_json: params[18],
        }
        table('control_plane_dispatch_plans').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_dispatch_plans') && s.includes('plan_id=?')) {
        const row = table('control_plane_dispatch_plans').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_dispatch_plans') && s.includes("status='ACTIVE'")) {
        const rows = [...table('control_plane_dispatch_plans').values()]
          .filter((r) => r.board_id === params[0] && r.status === 'ACTIVE')
          .sort((a, b) => asNumber(b.generated_at_ms) - asNumber(a.generated_at_ms))
        const top = rows[0]
        return { rows: top ? [top] : [], affectedRows: top ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_dispatch_plans') && s.includes('board_id=?')) {
        const rows = [...table('control_plane_dispatch_plans').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }
      if (s.includes('INTO control_plane_dispatch_plan_items')) {
        const row: MemRow = {
          board_id: params[0],
          plan_id: params[1],
          rank_n: params[2],
          task_id: params[3],
        }
        table('control_plane_dispatch_plan_items').set(
          pk(params[0], params[1], params[2]),
          row,
        )
        return { rows: [], affectedRows: 1 }
      }

      // Runs
      if (s.includes('INTO control_plane_runs')) {
        const row: MemRow = {
          board_id: params[0],
          run_id: params[1],
          state: params[2],
          plan_id: params[3],
          plan_item_rank: params[4],
          task_id: params[5],
          target_gate: params[6],
          role: params[7],
          agent_id: params[8],
          model: params[9],
          effort: params[10],
          masked_account_ref: params[11],
          canonical_hash: params[12],
          collision_scope_lock_ids_json: params[13],
          fencing_token: params[14],
          fencing_version: params[15],
          registered_at_ms: params[16],
          heartbeat_at_ms: params[17],
          lease_expires_at_ms: params[18],
          material_progress_at_ms: params[19],
          heartbeat_sequence: params[20],
          expected_entity_rev: params[21],
          expected_board_rev: params[22],
          entity_rev: params[23],
          board_rev: params[24],
          stalled: params[25],
          history_json: params[26],
          last_heartbeat_response_json: params[27],
          controller_run_id: params[28],
          parent_run_id: params[29],
          idempotency_key: params[30],
          record_json: params[31],
        }
        table('control_plane_runs').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.startsWith('UPDATE control_plane_runs SET')) {
        // Full CAS put: 30 SET fields + board_id, run_id, fencing, entity_rev
        const key = pk(params[30], params[31])
        const existing = table('control_plane_runs').get(key)
        if (!existing) return { rows: [], affectedRows: 0 }
        if (
          !nullSafeEq(existing.fencing_token, params[32]) ||
          asNumber(existing.entity_rev) !== asNumber(params[33])
        ) {
          return { rows: [], affectedRows: 0 }
        }
        Object.assign(existing, {
          state: params[0],
          plan_id: params[1],
          plan_item_rank: params[2],
          task_id: params[3],
          target_gate: params[4],
          role: params[5],
          agent_id: params[6],
          model: params[7],
          effort: params[8],
          masked_account_ref: params[9],
          canonical_hash: params[10],
          collision_scope_lock_ids_json: params[11],
          fencing_token: params[12],
          fencing_version: params[13],
          registered_at_ms: params[14],
          heartbeat_at_ms: params[15],
          lease_expires_at_ms: params[16],
          material_progress_at_ms: params[17],
          heartbeat_sequence: params[18],
          expected_entity_rev: params[19],
          expected_board_rev: params[20],
          entity_rev: params[21],
          board_rev: params[22],
          stalled: params[23],
          history_json: params[24],
          last_heartbeat_response_json: params[25],
          controller_run_id: params[26],
          parent_run_id: params[27],
          idempotency_key: params[28],
          record_json: params[29],
        })
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_runs') && s.includes('run_id=?')) {
        const row = table('control_plane_runs').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_runs') && s.includes('board_id=?')) {
        const rows = [...table('control_plane_runs').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }

      // Collision locks — PK (board, lock_id); UNIQUE active HELD scope (held_scope_key)
      // Insert-only: never overwrite existing PK (mirrors plain INSERT, not ODKU).
      if (s.includes('INTO control_plane_collision_locks')) {
        const key = pk(params[0], params[1])
        if (table('control_plane_collision_locks').has(key)) {
          throwDupEntry('PRIMARY')
        }
        const row: MemRow = {
          board_id: params[0],
          lock_id: params[1],
          scope_id: params[2],
          task_id: params[3],
          run_id: params[4],
          agent_id: params[5],
          role: params[6],
          fencing_token: params[7],
          fencing_version: params[8],
          state: params[9],
          lease_expires_at_ms: params[10],
          acquired_at_ms: params[11],
          released_at_ms: params[12],
          superseded_by_lock_id: params[13],
          supersedes_lock_id: params[14],
          entity_rev: params[15],
          record_json: params[16],
          held_scope_key: params[9] === 'HELD' ? params[2] : null,
        }
        if (row.state === 'HELD') {
          const clash = [...table('control_plane_collision_locks').values()].find(
            (r) =>
              r.board_id === row.board_id &&
              r.scope_id === row.scope_id &&
              r.state === 'HELD' &&
              r.lock_id !== row.lock_id,
          )
          if (clash) {
            throwDupEntry('uq_collision_held_scope')
          }
        }
        table('control_plane_collision_locks').set(key, row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.startsWith('UPDATE control_plane_collision_locks SET')) {
        const key = pk(params[15], params[16])
        const existing = table('control_plane_collision_locks').get(key)
        if (!existing) return { rows: [], affectedRows: 0 }
        if (
          !nullSafeEq(existing.fencing_token, params[17]) ||
          asNumber(existing.entity_rev) !== asNumber(params[18])
        ) {
          return { rows: [], affectedRows: 0 }
        }
        const nextState = params[7]
        const nextScope = params[0]
        if (nextState === 'HELD') {
          const clash = [...table('control_plane_collision_locks').values()].find(
            (r) =>
              r.board_id === existing.board_id &&
              r.scope_id === nextScope &&
              r.state === 'HELD' &&
              r.lock_id !== existing.lock_id,
          )
          if (clash) {
            throw new RuntimePersistenceError(
              'CLAIM_COLLISION',
              'Duplicate entry for key uq_collision_held_scope',
              {
                boardId: existing.board_id,
                scopeId: nextScope,
                existingLockId: clash.lock_id,
              },
            )
          }
        }
        Object.assign(existing, {
          scope_id: params[0],
          task_id: params[1],
          run_id: params[2],
          agent_id: params[3],
          role: params[4],
          fencing_token: params[5],
          fencing_version: params[6],
          state: params[7],
          lease_expires_at_ms: params[8],
          acquired_at_ms: params[9],
          released_at_ms: params[10],
          superseded_by_lock_id: params[11],
          supersedes_lock_id: params[12],
          entity_rev: params[13],
          record_json: params[14],
          held_scope_key: nextState === 'HELD' ? nextScope : null,
        })
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_collision_locks') && s.includes('lock_id=?')) {
        const row = table('control_plane_collision_locks').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_collision_locks') && s.includes('scope_id=?')) {
        const row = [...table('control_plane_collision_locks').values()].find(
          (r) => r.board_id === params[0] && r.scope_id === params[1] && r.state === 'HELD',
        )
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_collision_locks') && s.includes('board_id=?')) {
        const rows = [...table('control_plane_collision_locks').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }

      // Integration locks — PK (board, lock_id); UNIQUE active HELD repo+branch
      // Insert-only: never overwrite existing PK (mirrors plain INSERT, not ODKU).
      if (s.includes('INTO control_plane_integration_locks')) {
        const key = pk(params[0], params[1])
        if (table('control_plane_integration_locks').has(key)) {
          throwDupEntry('PRIMARY')
        }
        const row: MemRow = {
          board_id: params[0],
          lock_id: params[1],
          repo_id: params[2],
          tracking_branch: params[3],
          run_id: params[4],
          agent_id: params[5],
          integrator_model: params[6],
          root_acceptance_id: params[7],
          checkpoint_id: params[8],
          pathspecs_json: params[9],
          fencing_token: params[10],
          fencing_version: params[11],
          state: params[12],
          lease_expires_at_ms: params[13],
          acquired_at_ms: params[14],
          released_at_ms: params[15],
          entity_rev: params[16],
          record_json: params[17],
          held_repo_id: params[12] === 'HELD' ? params[2] : null,
          held_tracking_branch: params[12] === 'HELD' ? params[3] : null,
        }
        if (row.state === 'HELD') {
          const clash = [...table('control_plane_integration_locks').values()].find(
            (r) =>
              r.board_id === row.board_id &&
              r.repo_id === row.repo_id &&
              r.tracking_branch === row.tracking_branch &&
              r.state === 'HELD' &&
              r.lock_id !== row.lock_id,
          )
          if (clash) {
            throwDupEntry('uq_integration_held_repo_branch')
          }
        }
        table('control_plane_integration_locks').set(key, row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.startsWith('UPDATE control_plane_integration_locks SET')) {
        // WHERE board_id, lock_id, fencing, entity_rev (params 16..19)
        const key = pk(params[16], params[17])
        const existing = table('control_plane_integration_locks').get(key)
        if (!existing) return { rows: [], affectedRows: 0 }
        if (
          !nullSafeEq(existing.fencing_token, params[18]) ||
          asNumber(existing.entity_rev) !== asNumber(params[19])
        ) {
          return { rows: [], affectedRows: 0 }
        }
        const nextState = params[10]
        const nextRepo = params[0]
        const nextBranch = params[1]
        if (nextState === 'HELD') {
          const clash = [...table('control_plane_integration_locks').values()].find(
            (r) =>
              r.board_id === existing.board_id &&
              r.repo_id === nextRepo &&
              r.tracking_branch === nextBranch &&
              r.state === 'HELD' &&
              r.lock_id !== existing.lock_id,
          )
          if (clash) {
            throw new RuntimePersistenceError(
              'CLAIM_COLLISION',
              'Duplicate entry for key uq_integration_held_repo_branch',
              {
                boardId: existing.board_id,
                repoId: nextRepo,
                trackingBranch: nextBranch,
                existingLockId: clash.lock_id,
              },
            )
          }
        }
        Object.assign(existing, {
          repo_id: params[0],
          tracking_branch: params[1],
          run_id: params[2],
          agent_id: params[3],
          integrator_model: params[4],
          root_acceptance_id: params[5],
          checkpoint_id: params[6],
          pathspecs_json: params[7],
          fencing_token: params[8],
          fencing_version: params[9],
          state: params[10],
          lease_expires_at_ms: params[11],
          acquired_at_ms: params[12],
          released_at_ms: params[13],
          entity_rev: params[14],
          record_json: params[15],
          held_repo_id: nextState === 'HELD' ? nextRepo : null,
          held_tracking_branch: nextState === 'HELD' ? nextBranch : null,
        })
        return { rows: [], affectedRows: 1 }
      }
      // HELD-only live lookup: board + repo + tracking_branch + state='HELD'
      if (
        s.includes('FROM control_plane_integration_locks') &&
        s.includes('tracking_branch=?') &&
        s.includes("state='HELD'")
      ) {
        const row = [...table('control_plane_integration_locks').values()].find(
          (r) =>
            r.board_id === params[0] &&
            r.repo_id === params[1] &&
            r.tracking_branch === params[2] &&
            r.state === 'HELD',
        )
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_integration_locks') && s.includes('lock_id=?')) {
        const row = table('control_plane_integration_locks').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_integration_locks') && s.includes('board_id=?')) {
        const rows = [...table('control_plane_integration_locks').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }

      // Account snapshots
      if (s.includes('INTO control_plane_account_snapshots')) {
        const row: MemRow = {
          board_id: params[0],
          source_revision: params[1],
          generated_at: params[2],
          generated_at_ms: params[3],
          published_at_ms: params[4],
          last_periodic_health_at_ms: params[5],
          stale: params[6],
          stale_reason: params[7],
          usable_capacity: params[8],
          entity_rev: params[9],
          accounts_json: params[10],
          capacity_json: params[11],
          readback_surfaces_json: params[12],
          record_json: params[13],
        }
        table('control_plane_account_snapshots').set(pk(params[0]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_account_snapshots')) {
        const row = table('control_plane_account_snapshots').get(pk(params[0]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('INTO control_plane_account_readbacks')) {
        const row: MemRow = {
          board_id: params[0],
          surface: params[1],
          source_revision: params[2],
          generated_at: params[3],
          generated_at_ms: params[4],
          recorded_at_ms: params[5],
          entity_rev: params[6],
        }
        table('control_plane_account_readbacks').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }

      // Reconciler
      if (s.includes('INTO control_plane_reconciler_leaders')) {
        const row: MemRow = {
          board_id: params[0],
          leader_id: params[1],
          fencing_token: params[2],
          lease_expires_at_ms: params[3],
          entity_rev: 1,
        }
        table('control_plane_reconciler_leaders').set(pk(params[0]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.startsWith('UPDATE control_plane_reconciler_leaders')) {
        const existing = table('control_plane_reconciler_leaders').get(pk(params[3]))
        if (!existing || existing.fencing_token !== params[4]) {
          return { rows: [], affectedRows: 0 }
        }
        existing.leader_id = params[0]
        existing.fencing_token = params[1]
        existing.lease_expires_at_ms = params[2]
        existing.entity_rev = asNumber(existing.entity_rev) + 1
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_reconciler_leaders')) {
        const row = table('control_plane_reconciler_leaders').get(pk(params[0]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('INTO control_plane_reconciler_dryruns')) {
        const row: MemRow = {
          board_id: params[0],
          dry_run_hash: params[1],
          dry_run_id: params[2],
          board_rev: params[3],
          leader_token: params[4],
          cursor_val: params[5],
          next_cursor: params[6],
          max_actions: params[7],
          time_budget_ms: params[8],
          items_json: params[9],
          counts_json: params[10],
          generated_at_ms: params[11],
          generated_at: params[12],
          record_json: params[13],
        }
        table('control_plane_reconciler_dryruns').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_reconciler_dryruns')) {
        const row = table('control_plane_reconciler_dryruns').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('INTO control_plane_reconciler_apply')) {
        const row: MemRow = {
          board_id: params[0],
          last_apply_dry_run_hash: params[1],
          applied_at_ms: params[2],
          entity_rev: 1,
        }
        table('control_plane_reconciler_apply').set(pk(params[0]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_reconciler_apply')) {
        const row = table('control_plane_reconciler_apply').get(pk(params[0]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('INTO control_plane_reconciler_task_flags')) {
        const row: MemRow = {
          board_id: params[0],
          task_id: params[1],
          completed: params[2],
          entity_rev: 1,
        }
        table('control_plane_reconciler_task_flags').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_reconciler_task_flags')) {
        const row = table('control_plane_reconciler_task_flags').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }

      // Retention policy
      if (s.includes('INTO control_plane_retention_policies')) {
        const row: MemRow = {
          board_id: params[0],
          policy_id: params[1],
          policy_version: params[2],
          heartbeat_sample_interval: params[3],
          hot_state_retention_ms: params[4],
          sampled_event_retention_ms: params[5],
          rollup_retention_ms: params[6],
          compaction_interval_ms: params[7],
          approved_for_json: params[8],
          record_json: params[9],
        }
        table('control_plane_retention_policies').set(pk(params[0]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('FROM control_plane_retention_policies')) {
        const row = table('control_plane_retention_policies').get(pk(params[0]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }

      // Hot state
      if (s.includes('INTO control_plane_retention_hot_state')) {
        const row: MemRow = {
          board_id: params[0],
          run_id: params[1],
          last_heartbeat_at_ms: params[2],
          heartbeat_sequence: params[3],
          status: params[4],
          material_progress_at_ms: params[5],
          record_json: params[6],
        }
        table('control_plane_retention_hot_state').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      // DELETE must be checked before SELECT: "DELETE FROM … WHERE run_id=?" also
      // matches includes('FROM …') && includes('run_id=?') and would no-op as a get.
      if (s.includes('DELETE FROM control_plane_retention_hot_state')) {
        const ok = table('control_plane_retention_hot_state').delete(pk(params[0], params[1]))
        return { rows: [], affectedRows: ok ? 1 : 0 }
      }
      if (
        s.includes('FROM control_plane_retention_hot_state') &&
        s.includes('run_id=?') &&
        s.startsWith('SELECT')
      ) {
        const row = table('control_plane_retention_hot_state').get(pk(params[0], params[1]))
        return { rows: row ? [row] : [], affectedRows: row ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_retention_hot_state') && s.startsWith('SELECT')) {
        const rows = [...table('control_plane_retention_hot_state').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }

      // Audit sample
      if (s.includes('INTO control_plane_retention_audit_sample')) {
        const row: MemRow = {
          board_id: params[0],
          audit_id: params[1],
          run_id: params[2],
          event_class: params[3],
          event_type: params[4],
          at_ms: params[5],
          immutable: params[6],
          payload_json: params[7],
        }
        table('control_plane_retention_audit_sample').set(pk(params[0], params[1]), row)
        return { rows: [], affectedRows: 1 }
      }
      if (s.includes('DELETE FROM control_plane_retention_audit_sample')) {
        const ok = table('control_plane_retention_audit_sample').delete(pk(params[0], params[1]))
        return { rows: [], affectedRows: ok ? 1 : 0 }
      }
      if (s.includes('FROM control_plane_retention_audit_sample') && s.startsWith('SELECT')) {
        const rows = [...table('control_plane_retention_audit_sample').values()].filter(
          (r) => r.board_id === params[0],
        )
        return { rows, affectedRows: rows.length }
      }

      throw new RuntimePersistenceError('INVALID_INPUT', `memory sql not handled: ${s.slice(0, 120)}`)
  }

  const root: SqlExecutor & {
    tables: Map<string, Map<string, MemRow>>
    calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }>
    heldNamedLocks: Map<string, string>
  } = {
    tables,
    calls,
    heldNamedLocks,
    async execute<T = Record<string, unknown>>(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<SqlExecuteResult<T>> {
      const res = await executeOn(POOL_ID, sql, params)
      return res as SqlExecuteResult<T>
    },
    async getConnection(): Promise<PinnedSqlExecutor> {
      const connectionId = `memory-conn-${++connSeq}`
      return {
        connectionId,
        async execute<T = Record<string, unknown>>(
          sql: string,
          params: ReadonlyArray<unknown> = [],
        ): Promise<SqlExecuteResult<T>> {
          const res = await executeOn(connectionId, sql, params)
          return res as SqlExecuteResult<T>
        },
        release() {
          // Drop any locks still held by this connection (disconnect semantics).
          for (const [name, holder] of [...heldNamedLocks.entries()]) {
            if (holder === connectionId) heldNamedLocks.delete(name)
          }
        },
      }
    },
  }
  return root
}

// ---------------------------------------------------------------------------
// Bundle factories
// ---------------------------------------------------------------------------

function createInProcessRetentionStore(): RetentionStore {
  const hot = new Map<string, HotRunState>()
  const audit: Array<AuditRecord> = []
  return {
    getHot: (runId) => hot.get(runId) ?? null,
    putHot: (state) => {
      hot.set(state.runId, state)
    },
    listHot: (boardId) =>
      [...hot.values()].filter((h) => (boardId ? h.boardId === boardId : true)),
    deleteHot: (runId) => {
      hot.delete(runId)
    },
    appendAudit: (record) => {
      audit.push(record)
    },
    listAudit: (filter) =>
      audit.filter((r) => {
        if (filter?.boardId && r.boardId !== filter.boardId) return false
        if (filter?.eventClass && r.eventClass !== filter.eventClass) return false
        if (filter?.immutable != null && r.immutable !== filter.immutable) return false
        return true
      }),
    deleteAudit: (id) => {
      const idx = audit.findIndex((r) => r.id === id)
      if (idx >= 0) audit.splice(idx, 1)
    },
  }
}

function buildControlPlaneRuntimePersistenceBundle(
  exec: SqlExecutor,
  opts: { useNamedLock: boolean; mode: 'mysql' | 'memory' },
): ControlPlaneRuntimePersistence {
  const storeOpts = { useNamedLock: opts.useNamedLock }
  // MySQL multi-process (M3): never attach process-local sync retention
  // (misleading "durable" / dual-model diverge). Sync surface is fail-closed stub;
  // live durable mutations use retentionAsync only. Memory/test factory may keep
  // in-process RetentionStore for applyHeartbeat unit tests.
  const retention: RetentionStore =
    opts.mode === 'mysql' ? createMysqlRetentionStore() : createInProcessRetentionStore()

  return {
    mode: opts.mode,
    plans: createMysqlDispatchPlanStore(exec, storeOpts),
    runs: createMysqlRunRegistryStore(exec, storeOpts),
    locks: createMysqlLockStore(exec, storeOpts),
    accounts: createMysqlAccountSyncStore(exec, storeOpts),
    reconciler: createMysqlReconcilerStore(exec, storeOpts),
    retention,
    retentionPolicy: createMysqlRetentionPolicyStore(exec, storeOpts),
    retentionAsync: createMysqlRetentionAsyncStore(exec),
  }
}

/**
 * Multi-process MySQL runtime bundle.
 * Fail-closed: requires connection-pinned named locks (useNamedLock: true + getConnection).
 * Live retention mutations use retentionAsync (durable); sync retention is fail-closed.
 */
export function createMysqlControlPlaneRuntimePersistence(
  exec: SqlExecutor,
  opts?: { useNamedLock?: boolean },
): ControlPlaneRuntimePersistence {
  if (opts?.useNamedLock !== true) {
    throw new RuntimePersistenceError(
      'INVALID_INPUT',
      'createMysqlControlPlaneRuntimePersistence requires useNamedLock: true (connection-pinned GET_LOCK/RELEASE_LOCK). Use createMemoryControlPlaneRuntimePersistence() for in-process tests.',
      { receivedUseNamedLock: opts?.useNamedLock ?? null },
    )
  }
  if (typeof exec.getConnection !== 'function') {
    throw new RuntimePersistenceError(
      'INVALID_INPUT',
      'createMysqlControlPlaneRuntimePersistence requires SqlExecutor.getConnection() for connection-pinned named locks',
      {},
    )
  }
  return buildControlPlaneRuntimePersistenceBundle(exec, {
    useNamedLock: true,
    mode: 'mysql',
  })
}

/**
 * Explicit test / local foundation: MySQL repository code paths over memory SQL.
 * In-process board lock chain (useNamedLock false). Sync retention is memory-local;
 * durable hot/audit path remains retentionAsync (same memory executor tables).
 */
export function createMemoryControlPlaneRuntimePersistence(): ControlPlaneRuntimePersistence & {
  exec: ReturnType<typeof createMemorySqlExecutor>
} {
  const exec = createMemorySqlExecutor()
  const bundle = buildControlPlaneRuntimePersistenceBundle(exec, {
    useNamedLock: false,
    mode: 'memory',
  })
  return { ...bundle, exec }
}
