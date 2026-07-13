/**
 * Atomic collision-scope locks + integration locks (C2 control plane).
 * Acquire-all-or-none, leased + fencing, author/verifier conflict reject,
 * exactly one live COMMIT_INTEGRATE per repoId+trackingBranch.
 * Memory-safe; DB wiring is C1 migration tables via injected store.
 */
import { createHash, randomUUID } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'

// ---- constants ----

export const DEFAULT_LOCK_LEASE_MS = 60_000

export type LockRole = 'AUTHOR' | 'VERIFIER' | 'INTEGRATOR' | 'OTHER' | string

export type CollisionLockState = 'HELD' | 'RELEASED' | 'SUPERSEDED' | 'EXPIRED'

export interface CollisionLockRecord {
  boardId: string
  lockId: string
  /** Canonical collision scope id (deterministic). */
  scopeId: string
  taskId: string
  runId: string
  agentId: string
  role: LockRole
  fencingToken: string
  fencingVersion: number
  state: CollisionLockState
  leaseExpiresAtMs: number
  acquiredAtMs: number
  releasedAtMs: number | null
  /** Supersession pointer: next lock that replaced this one. */
  supersededByLockId: string | null
  /** History preserved: prior lock this supersedes. */
  supersedesLockId: string | null
  entityRev: number
}

export interface IntegrationLockRecord {
  boardId: string
  lockId: string
  repoId: string
  trackingBranch: string
  runId: string
  agentId: string
  /** Dedicated Grok integrator identity. */
  integratorModel: string
  rootAcceptanceId: string
  checkpointId: string
  pathspecs: Array<string>
  fencingToken: string
  fencingVersion: number
  state: CollisionLockState
  leaseExpiresAtMs: number
  acquiredAtMs: number
  releasedAtMs: number | null
  entityRev: number
}

export type LockErrorCode =
  | 'CLAIM_COLLISION'
  | 'FENCED'
  | 'LEASE_EXPIRED'
  | 'INTEGRATION_LOCKED'
  | 'AUTHOR_VERIFIER_CONFLICT'
  | 'INVALID_INPUT'
  | 'LOCK_NOT_FOUND'
  | 'STALE_REVISION'
  | 'IDEMPOTENCY_CONFLICT'

export class LockError extends Error {
  readonly code: LockErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: LockErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'LockError'
    this.code = code
    this.details = details
  }
}

export interface LockStore {
  listCollision(boardId: string): Promise<Array<CollisionLockRecord>>
  getCollision(boardId: string, lockId: string): Promise<CollisionLockRecord | null>
  getCollisionByScope(
    boardId: string,
    scopeId: string,
  ): Promise<CollisionLockRecord | null>
  putCollision(rec: CollisionLockRecord): Promise<void>
  listIntegration(boardId: string): Promise<Array<IntegrationLockRecord>>
  getIntegration(
    boardId: string,
    repoId: string,
    trackingBranch: string,
  ): Promise<IntegrationLockRecord | null>
  putIntegration(rec: IntegrationLockRecord): Promise<void>
  /** Board-level mutex for atomic multi-lock ops. */
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

// ---- pure helpers ----

/** Deterministic canonical lock id from scope string. */
export function canonicalLockId(scopeId: string): string {
  return createHash('sha256').update(scopeId.trim()).digest('hex').slice(0, 32)
}

/**
 * Parse scope forms:
 * - repo:<repoId>:<path>
 * - path:<path>
 * - resources:<name>
 * - integration:<repoId>:<branch>
 * - bare string → resources domain
 */
export function parseScope(scopeId: string): {
  domain: 'repo' | 'path' | 'resources' | 'integration' | 'other'
  repoId?: string
  path?: string
  resource?: string
  branch?: string
  raw: string
} {
  const raw = scopeId.trim()
  if (raw.startsWith('repo:')) {
    const rest = raw.slice(5)
    const idx = rest.indexOf(':')
    if (idx < 0) return { domain: 'repo', repoId: rest, path: '', raw }
    return { domain: 'repo', repoId: rest.slice(0, idx), path: rest.slice(idx + 1), raw }
  }
  if (raw.startsWith('path:')) {
    return { domain: 'path', path: raw.slice(5), raw }
  }
  if (raw.startsWith('resources:')) {
    return { domain: 'resources', resource: raw.slice(10), raw }
  }
  if (raw.startsWith('integration:')) {
    const rest = raw.slice(12)
    const idx = rest.indexOf(':')
    if (idx < 0) return { domain: 'integration', repoId: rest, branch: '', raw }
    return {
      domain: 'integration',
      repoId: rest.slice(0, idx),
      branch: rest.slice(idx + 1),
      raw,
    }
  }
  return { domain: 'other', resource: raw, raw }
}

/**
 * Reject absolute, dot-dot, NUL, and non-canonical path scopes before any lock.
 * Allowed: relative repo/path pathspecs with optional trailing `/*` or `/**`.
 */
export function assertSafeLockPath(p: string, label = 'path'): void {
  if (typeof p !== 'string') {
    throw new LockError('INVALID_INPUT', `${label} must be a string`, { path: p })
  }
  if (p.includes('\0')) {
    throw new LockError('INVALID_INPUT', `${label} must not contain NUL`, { path: p })
  }
  const raw = p.trim()
  if (!raw) {
    throw new LockError('INVALID_INPUT', `${label} must not be empty`, { path: p })
  }
  // Windows drive / UNC absolute forms before slash normalize
  if (/^[A-Za-z]:[\\/]/.test(raw) || raw.startsWith('\\\\') || raw.startsWith('//')) {
    throw new LockError('INVALID_INPUT', `${label} must not be absolute`, { path: p })
  }
  let s = raw.replace(/\\/g, '/')
  if (s.startsWith('/')) {
    throw new LockError('INVALID_INPUT', `${label} must not be absolute`, { path: p })
  }
  // Strip allowed trailing globs for segment validation only
  let body = s
  if (body.endsWith('/**')) body = body.slice(0, -3)
  else if (body.endsWith('/*')) body = body.slice(0, -2)
  while (body.endsWith('/')) body = body.slice(0, -1)
  if (!body) {
    // bare `/**` or `/*` is non-canonical (no relative root)
    throw new LockError('INVALID_INPUT', `${label} must be a relative non-empty path`, { path: p })
  }
  if (body.startsWith('/')) {
    throw new LockError('INVALID_INPUT', `${label} must not be absolute`, { path: p })
  }
  const segs = body.split('/')
  for (const seg of segs) {
    if (seg === '') {
      throw new LockError('INVALID_INPUT', `${label} must be canonical (no empty segments)`, {
        path: p,
      })
    }
    if (seg === '..') {
      throw new LockError('INVALID_INPUT', `${label} must not contain '..'`, { path: p })
    }
    if (seg === '.') {
      throw new LockError('INVALID_INPUT', `${label} must be canonical (no '.' segments)`, {
        path: p,
      })
    }
  }
}

/** Normalize path for prefix overlap (strip trailing /** and /). Fail-closed on unsafe paths. */
export function normalizePath(p: string): string {
  assertSafeLockPath(p)
  let s = p.replace(/\\/g, '/').trim()
  if (s.endsWith('/**')) s = s.slice(0, -3)
  if (s.endsWith('/*')) s = s.slice(0, -2)
  while (s.endsWith('/')) s = s.slice(0, -1)
  return s
}

/** Validate path-bearing collision/integration scope ids before lock acquire. */
export function assertSafeScopeId(scopeId: string): void {
  if (typeof scopeId !== 'string' || !scopeId.trim()) {
    throw new LockError('INVALID_INPUT', 'scopeId must be a non-empty string', { scopeId })
  }
  if (scopeId.includes('\0')) {
    throw new LockError('INVALID_INPUT', 'scopeId must not contain NUL', { scopeId })
  }
  const parsed = parseScope(scopeId)
  if (parsed.domain === 'path') {
    assertSafeLockPath(parsed.path ?? '', 'collision path scope')
    return
  }
  if (parsed.domain === 'repo') {
    const path = parsed.path ?? ''
    if (path.length > 0) {
      assertSafeLockPath(path, 'collision repo path scope')
    }
    return
  }
  // resources / integration / other: no filesystem path component at scope parse
}

/** True when two paths overlap (equal or prefix). Empty path = whole-repo sentinel (equal only). */
export function pathsOverlap(a: string, b: string): boolean {
  const aEmpty = !a || !String(a).trim()
  const bEmpty = !b || !String(b).trim()
  if (aEmpty || bEmpty) return aEmpty && bEmpty
  const na = normalizePath(a)
  const nb = normalizePath(b)
  if (na === nb) return true
  return na.startsWith(nb + '/') || nb.startsWith(na + '/')
}

/** Cross-task repo/path collision between two scope ids. */
export function scopesCollide(a: string, b: string): boolean {
  if (a === b) return true
  const pa = parseScope(a)
  const pb = parseScope(b)
  if (pa.domain === 'resources' && pb.domain === 'resources') {
    return (pa.resource ?? '') === (pb.resource ?? '')
  }
  if (pa.domain === 'repo' && pb.domain === 'repo') {
    if ((pa.repoId ?? '') !== (pb.repoId ?? '')) return false
    return pathsOverlap(pa.path ?? '', pb.path ?? '')
  }
  if (pa.domain === 'path' && pb.domain === 'path') {
    return pathsOverlap(pa.path ?? '', pb.path ?? '')
  }
  // integration keys collide only on exact repo+branch (handled separately)
  if (pa.domain === 'integration' && pb.domain === 'integration') {
    return (pa.repoId ?? '') === (pb.repoId ?? '') && (pa.branch ?? '') === (pb.branch ?? '')
  }
  return false
}

function isAuthorVerifierConflict(a: LockRole, b: LockRole): boolean {
  const A = String(a).toUpperCase()
  const B = String(b).toUpperCase()
  return (
    (A === 'AUTHOR' && B === 'VERIFIER') ||
    (A === 'VERIFIER' && B === 'AUTHOR') ||
    (A.includes('AUTHOR') && B.includes('VERIFIER')) ||
    (A.includes('VERIFIER') && B.includes('AUTHOR'))
  )
}

function isLiveCollision(rec: CollisionLockRecord, nowMs: number): boolean {
  if (rec.state !== 'HELD') return false
  if (rec.leaseExpiresAtMs <= nowMs) return false
  return true
}

function isLiveIntegration(rec: IntegrationLockRecord, nowMs: number): boolean {
  if (rec.state !== 'HELD') return false
  if (rec.leaseExpiresAtMs <= nowMs) return false
  return true
}

export interface AcquireCollisionRequest {
  boardId: string
  taskId: string
  runId: string
  agentId: string
  role: LockRole
  collisionScopeLockIds: Array<string>
  leaseMs?: number
  /** Optional fencing token to renew / re-enter. */
  fencingToken?: string
}

export interface AcquireCollisionResult {
  locks: Array<CollisionLockRecord>
  fencingToken: string
  fencingVersion: number
}

/**
 * Atomic acquire-all-or-none for collisionScopeLockIds.
 * Rejects overlapping cross-task holds and author/verifier conflicts.
 */
export async function acquireCollisionLocks(
  store: LockStore,
  clock: ControlPlaneClock,
  req: AcquireCollisionRequest,
): Promise<AcquireCollisionResult> {
  const scopes = [...new Set(req.collisionScopeLockIds.map((s) => s.trim()).filter(Boolean))]
  if (!scopes.length) {
    return { locks: [], fencingToken: '', fencingVersion: 0 }
  }
  // Reject absolute / .. / NUL / non-canonical path scopes BEFORE any lock mutation.
  for (const scopeId of scopes) {
    assertSafeScopeId(scopeId)
  }
  // Intra-request uniqueness + self-overlap
  for (let i = 0; i < scopes.length; i++) {
    for (let j = i + 1; j < scopes.length; j++) {
      if (scopesCollide(scopes[i]!, scopes[j]!)) {
        throw new LockError('CLAIM_COLLISION', `duplicate/overlapping scopes in request: ${scopes[i]} vs ${scopes[j]}`, {
          a: scopes[i],
          b: scopes[j],
        })
      }
    }
  }

  return store.withBoardLock(req.boardId, async () => {
    const now = clock.nowMs()
    const existing = await store.listCollision(req.boardId)
    const leaseMs = req.leaseMs ?? DEFAULT_LOCK_LEASE_MS
    const fencingToken = req.fencingToken ?? `fence-${randomUUID()}`
    const fencingVersion = 1
    const toWrite: Array<CollisionLockRecord> = []

    for (const scopeId of scopes) {
      for (const held of existing) {
        if (!isLiveCollision(held, now)) continue
        if (!scopesCollide(scopeId, held.scopeId)) continue
        // same run may re-acquire same scopes
        if (held.runId === req.runId && held.scopeId === scopeId) {
          // renew path handled below
          continue
        }
        if (held.taskId !== req.taskId && scopesCollide(scopeId, held.scopeId)) {
          throw new LockError(
            'CLAIM_COLLISION',
            `overlapping cross-task path collision: ${scopeId} conflicts with held ${held.scopeId} (task ${held.taskId})`,
            { scopeId, heldScopeId: held.scopeId, heldTaskId: held.taskId, heldRunId: held.runId },
          )
        }
        if (held.taskId === req.taskId && held.runId !== req.runId) {
          if (isAuthorVerifierConflict(held.role, req.role)) {
            throw new LockError(
              'AUTHOR_VERIFIER_CONFLICT',
              `author/verifier conflict on ${scopeId}: held by ${held.role} run ${held.runId}`,
              { scopeId, heldRole: held.role, role: req.role },
            )
          }
          throw new LockError(
            'CLAIM_COLLISION',
            `lock held by another run on same task: ${held.runId}`,
            { scopeId, heldRunId: held.runId },
          )
        }
      }

      const prior = existing.find((e) => e.scopeId === scopeId && isLiveCollision(e, now) && e.runId === req.runId)
      if (prior) {
        const renewed: CollisionLockRecord = {
          ...prior,
          leaseExpiresAtMs: now + leaseMs,
          fencingToken: prior.fencingToken,
          fencingVersion: prior.fencingVersion,
          entityRev: prior.entityRev + 1,
        }
        toWrite.push(renewed)
        continue
      }

      const rec: CollisionLockRecord = {
        boardId: req.boardId,
        lockId: `clk-${canonicalLockId(scopeId)}-${req.runId}`,
        scopeId,
        taskId: req.taskId,
        runId: req.runId,
        agentId: req.agentId,
        role: req.role,
        fencingToken,
        fencingVersion,
        state: 'HELD',
        leaseExpiresAtMs: now + leaseMs,
        acquiredAtMs: now,
        releasedAtMs: null,
        supersededByLockId: null,
        supersedesLockId: null,
        entityRev: 1,
      }
      toWrite.push(rec)
    }

    for (const rec of toWrite) {
      await store.putCollision(rec)
    }
    return {
      locks: toWrite,
      fencingToken: toWrite[0]?.fencingToken ?? fencingToken,
      fencingVersion: toWrite[0]?.fencingVersion ?? fencingVersion,
    }
  })
}

export async function renewCollisionLocks(
  store: LockStore,
  clock: ControlPlaneClock,
  opts: {
    boardId: string
    runId: string
    fencingToken: string
    leaseMs?: number
  },
): Promise<Array<CollisionLockRecord>> {
  return store.withBoardLock(opts.boardId, async () => {
    const now = clock.nowMs()
    const held = (await store.listCollision(opts.boardId)).filter(
      (l) => l.runId === opts.runId && l.state === 'HELD',
    )
    if (!held.length) return []
    const out: Array<CollisionLockRecord> = []
    for (const rec of held) {
      if (rec.fencingToken !== opts.fencingToken) {
        throw new LockError('FENCED', `fencing token mismatch for lock ${rec.lockId}`, {
          lockId: rec.lockId,
        })
      }
      if (rec.leaseExpiresAtMs <= now) {
        const expired: CollisionLockRecord = {
          ...rec,
          state: 'EXPIRED',
          releasedAtMs: now,
          entityRev: rec.entityRev + 1,
        }
        await store.putCollision(expired)
        throw new LockError('LEASE_EXPIRED', `lock lease expired: ${rec.lockId}`, {
          lockId: rec.lockId,
        })
      }
      const renewed: CollisionLockRecord = {
        ...rec,
        leaseExpiresAtMs: now + (opts.leaseMs ?? DEFAULT_LOCK_LEASE_MS),
        entityRev: rec.entityRev + 1,
      }
      await store.putCollision(renewed)
      out.push(renewed)
    }
    return out
  })
}

export async function releaseCollisionLocks(
  store: LockStore,
  clock: ControlPlaneClock,
  opts: {
    boardId: string
    runId: string
    fencingToken: string
  },
): Promise<Array<CollisionLockRecord>> {
  return store.withBoardLock(opts.boardId, async () => {
    const now = clock.nowMs()
    const held = (await store.listCollision(opts.boardId)).filter(
      (l) => l.runId === opts.runId && l.state === 'HELD',
    )
    const out: Array<CollisionLockRecord> = []
    for (const rec of held) {
      if (rec.fencingToken !== opts.fencingToken) {
        throw new LockError('FENCED', `fencing token mismatch on release: ${rec.lockId}`, {
          lockId: rec.lockId,
        })
      }
      const released: CollisionLockRecord = {
        ...rec,
        state: 'RELEASED',
        releasedAtMs: now,
        entityRev: rec.entityRev + 1,
      }
      await store.putCollision(released)
      out.push(released)
    }
    return out
  })
}

/**
 * Atomic supersession: fencing check + current-pointer flip.
 * Old history remains immutable (SUPERSEDED, supersededByLockId set).
 */
export async function supersedeCollisionLock(
  store: LockStore,
  clock: ControlPlaneClock,
  opts: {
    boardId: string
    scopeId: string
    expectedFencingToken: string
    newRunId: string
    newTaskId: string
    newAgentId: string
    newRole: LockRole
    leaseMs?: number
  },
): Promise<{ previous: CollisionLockRecord; next: CollisionLockRecord }> {
  return store.withBoardLock(opts.boardId, async () => {
    const now = clock.nowMs()
    const all = await store.listCollision(opts.boardId)
    const current = all.find(
      (l) => l.scopeId === opts.scopeId && l.state === 'HELD' && l.leaseExpiresAtMs > now,
    )
    if (!current) {
      throw new LockError('LOCK_NOT_FOUND', `no live lock for scope ${opts.scopeId}`, {
        scopeId: opts.scopeId,
      })
    }
    if (current.fencingToken !== opts.expectedFencingToken) {
      throw new LockError('FENCED', 'supersession fencing check failed', {
        expected: opts.expectedFencingToken,
        current: current.fencingToken,
      })
    }
    const next: CollisionLockRecord = {
      boardId: opts.boardId,
      lockId: `clk-${canonicalLockId(opts.scopeId)}-${opts.newRunId}`,
      scopeId: opts.scopeId,
      taskId: opts.newTaskId,
      runId: opts.newRunId,
      agentId: opts.newAgentId,
      role: opts.newRole,
      fencingToken: `fence-${randomUUID()}`,
      fencingVersion: current.fencingVersion + 1,
      state: 'HELD',
      leaseExpiresAtMs: now + (opts.leaseMs ?? DEFAULT_LOCK_LEASE_MS),
      acquiredAtMs: now,
      releasedAtMs: null,
      supersededByLockId: null,
      supersedesLockId: current.lockId,
      entityRev: 1,
    }
    const previous: CollisionLockRecord = {
      ...current,
      state: 'SUPERSEDED',
      releasedAtMs: now,
      supersededByLockId: next.lockId,
      entityRev: current.entityRev + 1,
    }
    // pointer flip atomic within board lock
    await store.putCollision(previous)
    await store.putCollision(next)
    return { previous, next }
  })
}

export interface AcquireIntegrationRequest {
  boardId: string
  repoId: string
  trackingBranch: string
  runId: string
  agentId: string
  integratorModel: string
  rootAcceptanceId: string
  checkpointId: string
  pathspecs: Array<string>
  leaseMs?: number
  /** Create requires 0; renew CAS current lock entityRev. */
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  currentPinHash?: string | null
  idempotencyKey: string
}

export interface IntegrationLockGateDeps {
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
}

/**
 * Material request envelope for integration_lock idempotency hashing.
 *
 * Every material field must participate so same-key body mutations conflict
 * (approval/model/repo/branch/run/agent/checkpoint/pathspecs/revs/hash/leaseMs).
 * Board/actor/endpoint/key live in idempotency *scope* (not this body).
 * Non-material: currentPinHash (pin probe only), idempotencyKey (scope key).
 *
 * leaseMs is material: it controls leaseExpiresAtMs on create/renew. Same key
 * with a different lease duration must IDEMPOTENCY_CONFLICT — never silently
 * replay a shorter/longer lease. Omitted leaseMs is canonicalized to
 * DEFAULT_LOCK_LEASE_MS so default and explicit-default are equivalent.
 *
 * Independent verifiers previously observed rootAcceptanceId + integratorModel
 * missing from the hash body — that allowed silent approval/model drift under
 * the same key. Both remain required here. leaseMs was later added after a
 * follow-on finding that lease duration could drift under the same key.
 */
export function integrationLockIdempotencyRequestBody(
  req: AcquireIntegrationRequest,
): Readonly<{
  repoId: string
  trackingBranch: string
  runId: string
  agentId: string
  integratorModel: string
  rootAcceptanceId: string
  checkpointId: string
  pathspecs: ReadonlyArray<string>
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  leaseMs: number
}> {
  return {
    repoId: req.repoId,
    trackingBranch: req.trackingBranch,
    runId: req.runId,
    agentId: req.agentId,
    integratorModel: req.integratorModel,
    rootAcceptanceId: req.rootAcceptanceId,
    checkpointId: req.checkpointId,
    // Copy; array order is material (stableStringify preserves array order).
    pathspecs: [...req.pathspecs],
    entityExpectedRev: req.entityExpectedRev,
    expectedBoardRev: req.expectedBoardRev,
    canonicalHash: req.canonicalHash,
    // Effective lease duration (create/renew both use the same default).
    leaseMs: req.leaseMs ?? DEFAULT_LOCK_LEASE_MS,
  }
}

/** Exactly one live COMMIT_INTEGRATE per repoId+trackingBranch. */
export async function acquireIntegrationLock(
  store: LockStore,
  clock: ControlPlaneClock,
  req: AcquireIntegrationRequest,
  gate: IntegrationLockGateDeps,
): Promise<IntegrationLockRecord> {
  if (!req.rootAcceptanceId) {
    throw new LockError('INVALID_INPUT', 'rootAcceptanceId required for integration lock')
  }
  if (!req.checkpointId) {
    throw new LockError('INVALID_INPUT', 'checkpointId required for integration lock')
  }
  if (!req.pathspecs?.length) {
    throw new LockError('INVALID_INPUT', 'pathspecs required for integration lock')
  }
  if (typeof req.entityExpectedRev !== 'number' || !Number.isInteger(req.entityExpectedRev)) {
    throw new LockError(
      'INVALID_INPUT',
      'entityExpectedRev is required (create=0, renew=current) — no silent default',
    )
  }
  if (typeof req.expectedBoardRev !== 'number' || !Number.isInteger(req.expectedBoardRev)) {
    throw new LockError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!req.canonicalHash || !String(req.canonicalHash).trim()) {
    throw new LockError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!req.idempotencyKey || !String(req.idempotencyKey).trim()) {
    throw new LockError('INVALID_INPUT', 'idempotencyKey is required')
  }
  if (
    req.currentPinHash != null &&
    req.currentPinHash !== '' &&
    req.currentPinHash !== req.canonicalHash
  ) {
    throw new LockError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: req.canonicalHash,
      currentPinHash: req.currentPinHash,
    })
  }
  // Exact supported Grok integrator identity only (no substring /grok/i).
  if (req.integratorModel.trim() !== 'grok-4.5') {
    throw new LockError(
      'INVALID_INPUT',
      'integration lock requires dedicated Grok integrator model (grok-4.5)',
      { model: req.integratorModel },
    )
  }
  // Reject absolute / .. / NUL / non-canonical pathspecs BEFORE any lock mutation.
  for (const ps of req.pathspecs) {
    assertSafeLockPath(ps, 'integration pathspec')
  }

  // Do NOT bind runId on begin: register_run owns unique runId binding; integration
  // create/renew are separate endpoints that would false-conflict on the same runId.
  let begin
  try {
    begin = await beginIdempotent(gate.idempotency, {
      scope: {
        actorId: req.agentId,
        boardId: req.boardId,
        endpoint: 'integration_lock',
        key: req.idempotencyKey.trim(),
      },
      requestBody: integrationLockIdempotencyRequestBody(req),
      nowMs: clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new LockError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
  if (begin.kind === 'REPLAY' && begin.record) {
    return begin.record.responseBody as IntegrationLockRecord
  }

  try {
    const board = await gate.atomic.getBoardState(req.boardId)
    if (req.expectedBoardRev !== board.boardRev) {
      throw new LockError('STALE_REVISION', 'board rev mismatch on integration_lock', {
        expectedBoardRev: req.expectedBoardRev,
        currentBoardRev: board.boardRev,
      })
    }

    const rec = await store.withBoardLock(req.boardId, async () => {
      const now = clock.nowMs()
      const existing = await store.getIntegration(req.boardId, req.repoId, req.trackingBranch)
      if (existing && isLiveIntegration(existing, now) && existing.runId !== req.runId) {
        throw new LockError(
          'INTEGRATION_LOCKED',
          `exactly one live COMMIT_INTEGRATE per repoId+trackingBranch; held by ${existing.runId}`,
          {
            repoId: req.repoId,
            trackingBranch: req.trackingBranch,
            heldByRunId: existing.runId,
          },
        )
      }
      if (existing && isLiveIntegration(existing, now) && existing.runId === req.runId) {
        // Renew: CAS current entity rev; no board-rev bump on renew.
        if (req.entityExpectedRev !== existing.entityRev) {
          throw new LockError('STALE_REVISION', 'entity rev mismatch on integration_lock renew', {
            entityExpectedRev: req.entityExpectedRev,
            currentEntityRev: existing.entityRev,
          })
        }
        const renewed: IntegrationLockRecord = {
          ...existing,
          leaseExpiresAtMs: now + (req.leaseMs ?? DEFAULT_LOCK_LEASE_MS),
          entityRev: existing.entityRev + 1,
        }
        await store.putIntegration(renewed)
        return renewed
      }
      // Create: entityExpectedRev must be 0.
      if (req.entityExpectedRev !== 0) {
        throw new LockError(
          'STALE_REVISION',
          'integration_lock create requires entityExpectedRev 0',
          { entityExpectedRev: req.entityExpectedRev, currentEntityRev: 0 },
        )
      }
      const next: IntegrationLockRecord = {
        boardId: req.boardId,
        lockId: `ilk-${req.repoId}-${req.trackingBranch}-${req.runId}`,
        repoId: req.repoId,
        trackingBranch: req.trackingBranch,
        runId: req.runId,
        agentId: req.agentId,
        integratorModel: req.integratorModel,
        rootAcceptanceId: req.rootAcceptanceId,
        checkpointId: req.checkpointId,
        pathspecs: [...req.pathspecs],
        fencingToken: `fence-int-${randomUUID()}`,
        fencingVersion: 1,
        state: 'HELD',
        leaseExpiresAtMs: now + (req.leaseMs ?? DEFAULT_LOCK_LEASE_MS),
        acquiredAtMs: now,
        releasedAtMs: null,
        entityRev: 1,
      }
      await store.putIntegration(next)
      // Single board-rev bump on create only (not renew / not replay).
      await gate.atomic.bumpBoardRev(req.boardId)
      return next
    })
    await completeIdempotent(gate.idempotency, begin.scopeHash, 200, rec, begin.requestHash)
    return rec
  } catch (e) {
    try {
      await gate.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    if (e instanceof IdempotencyError) {
      throw new LockError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export async function releaseIntegrationLock(
  store: LockStore,
  clock: ControlPlaneClock,
  opts: {
    boardId: string
    repoId: string
    trackingBranch: string
    runId: string
    fencingToken: string
  },
): Promise<IntegrationLockRecord> {
  return store.withBoardLock(opts.boardId, async () => {
    const now = clock.nowMs()
    const existing = await store.getIntegration(opts.boardId, opts.repoId, opts.trackingBranch)
    if (!existing || existing.runId !== opts.runId) {
      throw new LockError('LOCK_NOT_FOUND', 'integration lock not found for run', opts)
    }
    if (existing.fencingToken !== opts.fencingToken) {
      throw new LockError('FENCED', 'integration release fencing mismatch')
    }
    const released: IntegrationLockRecord = {
      ...existing,
      state: 'RELEASED',
      releasedAtMs: now,
      entityRev: existing.entityRev + 1,
    }
    await store.putIntegration(released)
    return released
  })
}

/** Expire live locks past lease (reconciler helper). Does not delete history. */
export async function markExpiredLocks(
  store: LockStore,
  clock: ControlPlaneClock,
  boardId: string,
): Promise<{ collision: number; integration: number }> {
  return store.withBoardLock(boardId, async () => {
    const now = clock.nowMs()
    let collision = 0
    let integration = 0
    for (const rec of await store.listCollision(boardId)) {
      if (rec.state === 'HELD' && rec.leaseExpiresAtMs <= now) {
        await store.putCollision({
          ...rec,
          state: 'EXPIRED',
          releasedAtMs: now,
          entityRev: rec.entityRev + 1,
        })
        collision++
      }
    }
    for (const rec of await store.listIntegration(boardId)) {
      if (rec.state === 'HELD' && rec.leaseExpiresAtMs <= now) {
        await store.putIntegration({
          ...rec,
          state: 'EXPIRED',
          releasedAtMs: now,
          entityRev: rec.entityRev + 1,
        })
        integration++
      }
    }
    return { collision, integration }
  })
}

export function createMemoryLockStore(): LockStore & {
  snapshot(): {
    collision: Array<CollisionLockRecord>
    integration: Array<IntegrationLockRecord>
  }
} {
  const collision = new Map<string, CollisionLockRecord>() // boardId::lockId
  const integration = new Map<string, IntegrationLockRecord>() // boardId::repo::branch
  const chains = new Map<string, Promise<unknown>>()

  const ck = (boardId: string, lockId: string) => `${boardId}::${lockId}`
  const ik = (boardId: string, repoId: string, branch: string) =>
    `${boardId}::${repoId}::${branch}`

  return {
    snapshot() {
      return {
        collision: [...collision.values()].map((r) => ({ ...r })),
        integration: [...integration.values()].map((r) => ({ ...r })),
      }
    },
    async listCollision(boardId) {
      return [...collision.values()].filter((r) => r.boardId === boardId).map((r) => ({ ...r }))
    },
    async getCollision(boardId, lockId) {
      const r = collision.get(ck(boardId, lockId))
      return r ? { ...r } : null
    },
    async getCollisionByScope(boardId, scopeId) {
      const live = [...collision.values()].find(
        (r) => r.boardId === boardId && r.scopeId === scopeId && r.state === 'HELD',
      )
      return live ? { ...live } : null
    },
    async putCollision(rec) {
      collision.set(ck(rec.boardId, rec.lockId), { ...rec })
    },
    async listIntegration(boardId) {
      return [...integration.values()].filter((r) => r.boardId === boardId).map((r) => ({ ...r }))
    },
    async getIntegration(boardId, repoId, trackingBranch) {
      const r = integration.get(ik(boardId, repoId, trackingBranch))
      return r ? { ...r } : null
    },
    async putIntegration(rec) {
      integration.set(ik(rec.boardId, rec.repoId, rec.trackingBranch), { ...rec })
    },
    async withBoardLock(boardId, fn) {
      const prev = chains.get(boardId) ?? Promise.resolve()
      let release!: () => void
      const gate = new Promise<void>((r) => {
        release = r
      })
      const next = prev.then(() => gate)
      chains.set(boardId, next)
      await prev
      try {
        return await fn()
      } finally {
        release()
      }
    },
  }
}
