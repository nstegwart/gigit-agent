/**
 * Bounded single-leader reconciler: maxActions 100, cursor/time budget,
 * revision-bound dry-run item diffs + dryRunHash, same-hash apply,
 * classify live/terminal/stale/orphan/requeue/manual, preserve history,
 * idempotent rerun, RECONCILIATION_PENDING behavior.
 */
import { createHash, randomUUID } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'
import {
  RUN_LEASE_MS,
  RUN_RECONCILIATION_GRACE_MS,
  TERMINAL_RUN_STATES,
  type RunRecord,
  type RunRegistryStore,
  type RunState,
} from './run-registry'
import { markExpiredLocks, type LockStore } from './locks'

export const DEFAULT_MAX_ACTIONS_PER_RUN = 100
export const DEFAULT_TIME_BUDGET_MS = 5_000

export type ReconcileClass =
  | 'LIVE'
  | 'TERMINAL'
  | 'STALE'
  | 'ORPHAN'
  | 'REQUEUE'
  | 'MANUAL'

export interface ReconcileItemDiff {
  runId: string
  taskId: string
  classification: ReconcileClass
  beforeState: RunState
  afterState: RunState | null
  action: 'NONE' | 'MARK_STALE' | 'REQUEUE' | 'RELEASE_LOCKS' | 'MANUAL_REVIEW' | 'PRESERVE_TERMINAL'
  reason: string
  /** Incomplete stale/orphan ownership → RECONCILIATION_PENDING (AC-BUCKET-07). */
  reconciliationPending: boolean
  /** Completed task stays DONE with reconciliation overlay — not primary RECONCILIATION_PENDING. */
  doneWithReconciliationOverlay: boolean
}

export interface ReconcileDryRunResult {
  dryRunId: string
  dryRunHash: string
  boardId: string
  boardRev: number
  leaderToken: string
  cursor: string | null
  nextCursor: string | null
  maxActions: number
  timeBudgetMs: number
  items: Array<ReconcileItemDiff>
  counts: Record<ReconcileClass, number>
  generatedAtMs: number
  generatedAt: string
}

export interface ReconcileApplyResult {
  applied: boolean
  dryRunHash: string
  appliedCount: number
  skippedCount: number
  itemIds: Array<string>
  idempotentReplay: boolean
  boardRev: number
}

export type ReconcilerErrorCode =
  | 'NOT_LEADER'
  | 'STALE_REVISION'
  | 'DRY_RUN_HASH_MISMATCH'
  | 'BUDGET_EXCEEDED'
  | 'INVALID_INPUT'
  | 'IDEMPOTENCY_CONFLICT'

export class ReconcilerError extends Error {
  readonly code: ReconcilerErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: ReconcilerErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'ReconcilerError'
    this.code = code
    this.details = details
  }
}

export interface ReconcilerLeaderState {
  boardId: string
  leaderId: string
  fencingToken: string
  leaseExpiresAtMs: number
}

export interface ReconcilerStore {
  getLeader(boardId: string): Promise<ReconcilerLeaderState | null>
  putLeader(state: ReconcilerLeaderState): Promise<void>
  getDryRun(boardId: string, dryRunHash: string): Promise<ReconcileDryRunResult | null>
  putDryRun(result: ReconcileDryRunResult): Promise<void>
  getLastApplyHash(boardId: string): Promise<string | null>
  putLastApplyHash(boardId: string, dryRunHash: string): Promise<void>
  /** Task completion flags for AC-BUCKET-07 (taskId → completed). */
  isTaskCompleted(boardId: string, taskId: string): Promise<boolean>
  setTaskCompleted(boardId: string, taskId: string, completed: boolean): Promise<void>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

export interface ReconcilerDeps {
  clock: ControlPlaneClock
  runs: RunRegistryStore
  locks: LockStore
  reconciler: ReconcilerStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  return `{${Object.keys(obj)
    .sort()
    .map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`)
    .join(',')}}`
}

export function hashDryRunItems(items: Array<ReconcileItemDiff>, boardRev: number): string {
  return createHash('sha256')
    .update(stableStringify({ boardRev, items }))
    .digest('hex')
}

function isTerminal(s: RunState): boolean {
  return (TERMINAL_RUN_STATES as ReadonlyArray<string>).includes(s)
}

/**
 * Classify a single run for reconciliation (pure).
 */
export function classifyRunForReconcile(
  rec: RunRecord,
  nowMs: number,
  taskCompleted: boolean,
): ReconcileItemDiff {
  if (isTerminal(rec.state)) {
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'TERMINAL',
      beforeState: rec.state,
      afterState: rec.state,
      action: 'PRESERVE_TERMINAL',
      reason: 'terminal_history_preserved',
      reconciliationPending: false,
      doneWithReconciliationOverlay: taskCompleted && rec.state === 'SUCCEEDED',
    }
  }

  const leaseExpired =
    rec.leaseExpiresAtMs != null && rec.leaseExpiresAtMs + RUN_RECONCILIATION_GRACE_MS <= nowMs
  const neverHeartbeated =
    rec.registeredAtMs != null &&
    rec.heartbeatAtMs == null &&
    nowMs - rec.registeredAtMs > RUN_LEASE_MS + RUN_RECONCILIATION_GRACE_MS

  if (rec.state === 'QUEUED') {
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'LIVE',
      beforeState: rec.state,
      afterState: null,
      action: 'NONE',
      reason: 'queued_no_lease',
      reconciliationPending: false,
      doneWithReconciliationOverlay: false,
    }
  }

  // Orphan: leased state but no agent binding / missing fencing.
  // QUEUED already returned above (no claim/lease), so state is non-QUEUED here.
  if (!rec.agentId || rec.fencingToken == null) {
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'ORPHAN',
      beforeState: rec.state,
      afterState: taskCompleted ? rec.state : 'STALE',
      action: taskCompleted ? 'MANUAL_REVIEW' : 'MARK_STALE',
      reason: 'orphan_missing_owner_or_fence',
      reconciliationPending: !taskCompleted,
      doneWithReconciliationOverlay: taskCompleted,
    }
  }

  if (leaseExpired || neverHeartbeated) {
    if (taskCompleted) {
      return {
        runId: rec.runId,
        taskId: rec.taskId,
        classification: 'STALE',
        beforeState: rec.state,
        afterState: 'SUCCEEDED',
        action: 'PRESERVE_TERMINAL',
        reason: 'completed_task_stale_ownership_overlay',
        reconciliationPending: false,
        doneWithReconciliationOverlay: true,
      }
    }
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'STALE',
      beforeState: rec.state,
      afterState: 'STALE',
      action: 'MARK_STALE',
      reason: leaseExpired ? 'lease_expired_past_grace' : 'never_heartbeated',
      reconciliationPending: true,
      doneWithReconciliationOverlay: false,
    }
  }

  if (rec.stalled) {
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'REQUEUE',
      beforeState: rec.state,
      afterState: 'CANCELLED',
      action: 'REQUEUE',
      reason: 'stalled_requeue_candidate',
      reconciliationPending: false,
      doneWithReconciliationOverlay: false,
    }
  }

  // Ambiguous fence recovery → manual
  if (rec.fencingVersion > 1 && rec.heartbeatAtMs != null && nowMs - rec.heartbeatAtMs > RUN_LEASE_MS) {
    return {
      runId: rec.runId,
      taskId: rec.taskId,
      classification: 'MANUAL',
      beforeState: rec.state,
      afterState: null,
      action: 'MANUAL_REVIEW',
      reason: 'ambiguous_fence_recovery',
      reconciliationPending: true,
      doneWithReconciliationOverlay: false,
    }
  }

  return {
    runId: rec.runId,
    taskId: rec.taskId,
    classification: 'LIVE',
    beforeState: rec.state,
    afterState: null,
    action: 'NONE',
    reason: 'live_healthy',
    reconciliationPending: false,
    doneWithReconciliationOverlay: false,
  }
}

export async function claimReconcilerLeadership(
  deps: ReconcilerDeps,
  opts: { boardId: string; leaderId: string; leaseMs?: number },
): Promise<ReconcilerLeaderState> {
  return deps.reconciler.withBoardLock(opts.boardId, async () => {
    const now = deps.clock.nowMs()
    const cur = await deps.reconciler.getLeader(opts.boardId)
    if (cur && cur.leaseExpiresAtMs > now && cur.leaderId !== opts.leaderId) {
      throw new ReconcilerError('NOT_LEADER', `leader held by ${cur.leaderId}`, {
        leaderId: cur.leaderId,
      })
    }
    const next: ReconcilerLeaderState = {
      boardId: opts.boardId,
      leaderId: opts.leaderId,
      fencingToken: cur && cur.leaderId === opts.leaderId ? cur.fencingToken : `rleader-${randomUUID()}`,
      leaseExpiresAtMs: now + (opts.leaseMs ?? RUN_LEASE_MS),
    }
    await deps.reconciler.putLeader(next)
    return next
  })
}

async function assertLeader(
  deps: ReconcilerDeps,
  boardId: string,
  leaderId: string,
  fencingToken: string,
): Promise<void> {
  const cur = await deps.reconciler.getLeader(boardId)
  const now = deps.clock.nowMs()
  if (!cur || cur.leaderId !== leaderId || cur.fencingToken !== fencingToken || cur.leaseExpiresAtMs <= now) {
    throw new ReconcilerError('NOT_LEADER', 'reconciler leader fencing failed', {
      leaderId,
      current: cur,
    })
  }
}

/** Material request fields for reconcile_dry_run 24h idempotency (scope owns board/key). */
export type ReconcileDryRunIdempotencyOpts = {
  leaderId: string
  fencingToken: string
  maxActions?: number
  timeBudgetMs?: number
  cursor?: string | null
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
}

/**
 * Canonical material body for reconcile_dry_run idempotency.
 * Includes timeBudgetMs + every other material field/revision/hash.
 * Not hashed: boardId/actorId/endpoint/key (scope), idempotencyKey, currentPinHash (pin probe).
 */
export function reconcileDryRunIdempotencyRequestBody(
  opts: ReconcileDryRunIdempotencyOpts,
): Readonly<{
  leaderId: string
  fencingToken: string
  maxActions: number | null
  timeBudgetMs: number | null
  cursor: string | null
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
}> {
  return {
    leaderId: opts.leaderId,
    fencingToken: opts.fencingToken,
    maxActions: opts.maxActions ?? null,
    // Material: same key with a different time budget must IDEMPOTENCY_CONFLICT.
    timeBudgetMs: opts.timeBudgetMs ?? null,
    cursor: opts.cursor ?? null,
    entityExpectedRev: opts.entityExpectedRev,
    expectedBoardRev: opts.expectedBoardRev,
    canonicalHash: opts.canonicalHash,
  }
}

export async function dryRunReconcile(
  deps: ReconcilerDeps,
  opts: {
    boardId: string
    leaderId: string
    fencingToken: string
    maxActions?: number
    timeBudgetMs?: number
    cursor?: string | null
    /** Create dry-run entity: require 0 (no prior dry-run entity CAS on store). */
    entityExpectedRev: number
    expectedBoardRev: number
    canonicalHash: string
    currentPinHash?: string | null
    idempotencyKey: string
  },
): Promise<ReconcileDryRunResult> {
  if (typeof opts.entityExpectedRev !== 'number' || !Number.isInteger(opts.entityExpectedRev)) {
    throw new ReconcilerError(
      'INVALID_INPUT',
      'entityExpectedRev is required (create=0) — no silent default',
    )
  }
  if (typeof opts.expectedBoardRev !== 'number' || !Number.isInteger(opts.expectedBoardRev)) {
    throw new ReconcilerError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!opts.canonicalHash || !String(opts.canonicalHash).trim()) {
    throw new ReconcilerError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!opts.idempotencyKey || !String(opts.idempotencyKey).trim()) {
    throw new ReconcilerError('INVALID_INPUT', 'idempotencyKey is required')
  }
  if (
    opts.currentPinHash != null &&
    opts.currentPinHash !== '' &&
    opts.currentPinHash !== opts.canonicalHash
  ) {
    throw new ReconcilerError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: opts.canonicalHash,
      currentPinHash: opts.currentPinHash,
    })
  }
  // Dry-run is a create-side-effect (stores dry-run row); entityExpectedRev must be 0.
  if (opts.entityExpectedRev !== 0) {
    throw new ReconcilerError(
      'STALE_REVISION',
      'reconcile_dry_run create requires entityExpectedRev 0',
      { entityExpectedRev: opts.entityExpectedRev, currentEntityRev: 0 },
    )
  }

  await assertLeader(deps, opts.boardId, opts.leaderId, opts.fencingToken)

  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: opts.leaderId,
        boardId: opts.boardId,
        endpoint: 'reconcile_dry_run',
        key: opts.idempotencyKey.trim(),
      },
      requestBody: reconcileDryRunIdempotencyRequestBody(opts),
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new ReconcilerError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
  if (begin.kind === 'REPLAY' && begin.record) {
    return begin.record.responseBody as ReconcileDryRunResult
  }

  try {
    const board = await deps.atomic.getBoardState(opts.boardId)
    if (opts.expectedBoardRev !== board.boardRev) {
      throw new ReconcilerError('STALE_REVISION', 'board rev mismatch on dry-run', {
        expectedBoardRev: opts.expectedBoardRev,
        currentBoardRev: board.boardRev,
      })
    }

    const maxActions = opts.maxActions ?? DEFAULT_MAX_ACTIONS_PER_RUN
    if (maxActions > DEFAULT_MAX_ACTIONS_PER_RUN) {
      throw new ReconcilerError('BUDGET_EXCEEDED', `maxActions ${maxActions} > ${DEFAULT_MAX_ACTIONS_PER_RUN}`)
    }
    const timeBudgetMs = opts.timeBudgetMs ?? DEFAULT_TIME_BUDGET_MS
    const started = deps.clock.nowMs()
    const now = started

    const allRuns = (await deps.runs.list(opts.boardId)).sort((a, b) =>
      a.runId.localeCompare(b.runId),
    )
    let startIdx = 0
    if (opts.cursor) {
      const idx = allRuns.findIndex((r) => r.runId === opts.cursor)
      startIdx = idx >= 0 ? idx + 1 : 0
    }

    const items: Array<ReconcileItemDiff> = []
    let i = startIdx
    while (i < allRuns.length && items.length < maxActions) {
      if (deps.clock.nowMs() - started > timeBudgetMs) break
      const rec = allRuns[i]!
      const completed = await deps.reconciler.isTaskCompleted(opts.boardId, rec.taskId)
      items.push(classifyRunForReconcile(rec, now, completed))
      i++
    }

    const nextCursor = i < allRuns.length ? allRuns[i - 1]?.runId ?? null : null
    const counts: Record<ReconcileClass, number> = {
      LIVE: 0,
      TERMINAL: 0,
      STALE: 0,
      ORPHAN: 0,
      REQUEUE: 0,
      MANUAL: 0,
    }
    for (const it of items) counts[it.classification]++

    const dryRunHash = hashDryRunItems(items, board.boardRev)
    const result: ReconcileDryRunResult = {
      dryRunId: `dry-${randomUUID()}`,
      dryRunHash,
      boardId: opts.boardId,
      boardRev: board.boardRev,
      leaderToken: opts.fencingToken,
      cursor: opts.cursor ?? null,
      nextCursor,
      maxActions,
      timeBudgetMs,
      items,
      counts,
      generatedAtMs: deps.clock.nowMs(),
      generatedAt: deps.clock.nowISO(),
    }

    await deps.reconciler.putDryRun(result)
    // Dry-run does NOT bump board rev (read-ish side effect only).
    await deps.atomic.appendAudit({
      boardId: opts.boardId,
      kind: 'RECONCILER_DRY_RUN',
      atMs: result.generatedAtMs,
      atISO: result.generatedAt,
      actorId: opts.leaderId,
      subjectType: 'reconcile',
      subjectId: result.dryRunId,
      detail: { dryRunHash, counts, itemCount: items.length },
      material: true,
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
      throw new ReconcilerError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export async function applyReconcile(
  deps: ReconcilerDeps,
  opts: {
    boardId: string
    leaderId: string
    fencingToken: string
    dryRunHash: string
    /**
     * Strict entity CAS on every apply path (including already-applied dryRunHash + new key).
     * Apply entity is create-semantic: currentEntityRev is always 0 (domain already-applied
     * does not bump entity rev). Mismatch → STALE_REVISION. Exact same key+body still replays
     * via idempotency before this check.
     */
    entityExpectedRev: number
    expectedBoardRev: number
    canonicalHash: string
    currentPinHash?: string | null
    idempotencyKey: string
  },
): Promise<ReconcileApplyResult> {
  if (typeof opts.entityExpectedRev !== 'number' || !Number.isInteger(opts.entityExpectedRev)) {
    throw new ReconcilerError(
      'INVALID_INPUT',
      'entityExpectedRev is required — no silent default',
    )
  }
  if (typeof opts.expectedBoardRev !== 'number' || !Number.isInteger(opts.expectedBoardRev)) {
    throw new ReconcilerError('INVALID_INPUT', 'expectedBoardRev is required — no silent default')
  }
  if (!opts.canonicalHash || !String(opts.canonicalHash).trim()) {
    throw new ReconcilerError('INVALID_INPUT', 'canonicalHash is required (current pin hash)')
  }
  if (!opts.idempotencyKey || !String(opts.idempotencyKey).trim()) {
    throw new ReconcilerError('INVALID_INPUT', 'idempotencyKey is required')
  }
  if (
    opts.currentPinHash != null &&
    opts.currentPinHash !== '' &&
    opts.currentPinHash !== opts.canonicalHash
  ) {
    throw new ReconcilerError('STALE_REVISION', 'canonical hash mismatch vs current pin', {
      expectedCanonicalHash: opts.canonicalHash,
      currentPinHash: opts.currentPinHash,
    })
  }

  await assertLeader(deps, opts.boardId, opts.leaderId, opts.fencingToken)

  let begin
  try {
    begin = await beginIdempotent(deps.idempotency, {
      scope: {
        actorId: opts.leaderId,
        boardId: opts.boardId,
        endpoint: 'reconcile_apply',
        key: opts.idempotencyKey.trim(),
      },
      requestBody: {
        dryRunHash: opts.dryRunHash,
        entityExpectedRev: opts.entityExpectedRev,
        expectedBoardRev: opts.expectedBoardRev,
        canonicalHash: opts.canonicalHash,
      },
      nowMs: deps.clock.nowMs(),
    })
  } catch (e) {
    if (e instanceof IdempotencyError) {
      throw new ReconcilerError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
  if (begin.kind === 'REPLAY' && begin.record) {
    return begin.record.responseBody as ReconcileApplyResult
  }

  try {
  const result = await deps.reconciler.withBoardLock(opts.boardId, async () => {
    const last = await deps.reconciler.getLastApplyHash(opts.boardId)
    if (last === opts.dryRunHash) {
      // Domain-level already-applied: no mutation, no board/entity bump.
      // Entity CAS is still mandatory — create-semantic apply entity never bumps on
      // domain replay, so currentEntityRev remains 0. Arbitrary/stale rev → STALE_REVISION.
      // (Bug fix: prior empty branch accepted any entityExpectedRev and bypassed CAS.)
      const currentEntityRev = 0
      if (opts.entityExpectedRev !== currentEntityRev) {
        throw new ReconcilerError(
          'STALE_REVISION',
          'reconcile_apply requires exact current entity revision',
          { entityExpectedRev: opts.entityExpectedRev, currentEntityRev },
        )
      }
      const board = await deps.atomic.getBoardState(opts.boardId)
      if (opts.expectedBoardRev !== board.boardRev) {
        throw new ReconcilerError('STALE_REVISION', 'apply requires current board rev', {
          expectedBoardRev: opts.expectedBoardRev,
          currentBoardRev: board.boardRev,
        })
      }
      return {
        applied: true,
        dryRunHash: opts.dryRunHash,
        appliedCount: 0,
        skippedCount: 0,
        itemIds: [],
        idempotentReplay: true,
        boardRev: board.boardRev,
      }
    }

    // First apply for this hash: create semantics require entityExpectedRev 0.
    const currentEntityRev = 0
    if (opts.entityExpectedRev !== currentEntityRev) {
      throw new ReconcilerError(
        'STALE_REVISION',
        'reconcile_apply requires exact current entity revision',
        { entityExpectedRev: opts.entityExpectedRev, currentEntityRev },
      )
    }

    const dry = await deps.reconciler.getDryRun(opts.boardId, opts.dryRunHash)
    if (!dry) {
      throw new ReconcilerError('DRY_RUN_HASH_MISMATCH', 'unknown dryRunHash', {
        dryRunHash: opts.dryRunHash,
      })
    }
    if (dry.dryRunHash !== opts.dryRunHash) {
      throw new ReconcilerError('DRY_RUN_HASH_MISMATCH', 'dryRunHash mismatch')
    }

    const board = await deps.atomic.getBoardState(opts.boardId)
    if (opts.expectedBoardRev !== board.boardRev || dry.boardRev !== board.boardRev) {
      throw new ReconcilerError('STALE_REVISION', 'apply requires current board rev matching dry-run', {
        expectedBoardRev: opts.expectedBoardRev,
        dryBoardRev: dry.boardRev,
        currentBoardRev: board.boardRev,
      })
    }

    // Recompute hash against live classification at apply time must match
    const now = deps.clock.nowMs()
    const liveItems: Array<ReconcileItemDiff> = []
    for (const it of dry.items) {
      const rec = await deps.runs.get(opts.boardId, it.runId)
      if (!rec) {
        liveItems.push(it)
        continue
      }
      const completed = await deps.reconciler.isTaskCompleted(opts.boardId, rec.taskId)
      liveItems.push(classifyRunForReconcile(rec, now, completed))
    }
    const liveHash = hashDryRunItems(liveItems, board.boardRev)
    if (liveHash !== opts.dryRunHash) {
      throw new ReconcilerError(
        'DRY_RUN_HASH_MISMATCH',
        'live classification diverged from dry-run; re-run dry-run',
        { dryRunHash: opts.dryRunHash, liveHash },
      )
    }

    let appliedCount = 0
    let skippedCount = 0
    const itemIds: Array<string> = []

    for (const it of dry.items) {
      const rec = await deps.runs.get(opts.boardId, it.runId)
      if (!rec) {
        skippedCount++
        continue
      }
      if (it.action === 'NONE' || it.action === 'PRESERVE_TERMINAL' || it.action === 'MANUAL_REVIEW') {
        skippedCount++
        itemIds.push(it.runId)
        continue
      }
      if (it.action === 'MARK_STALE' && it.afterState) {
        const history = [
          ...rec.history,
          {
            atMs: now,
            atISO: deps.clock.nowISO(),
            fromState: rec.state,
            toState: it.afterState,
            reason: `reconcile:${it.reason}`,
            actorId: opts.leaderId,
          },
        ]
        await deps.runs.put({
          ...rec,
          state: it.afterState,
          leaseExpiresAtMs: null,
          entityRev: rec.entityRev + 1,
          history,
        })
        appliedCount++
        itemIds.push(it.runId)
        continue
      }
      if (it.action === 'REQUEUE' && it.afterState) {
        const history = [
          ...rec.history,
          {
            atMs: now,
            atISO: deps.clock.nowISO(),
            fromState: rec.state,
            toState: it.afterState,
            reason: `reconcile_requeue:${it.reason}`,
            actorId: opts.leaderId,
          },
        ]
        await deps.runs.put({
          ...rec,
          state: it.afterState,
          leaseExpiresAtMs: null,
          entityRev: rec.entityRev + 1,
          history,
        })
        appliedCount++
        itemIds.push(it.runId)
        continue
      }
      if (it.action === 'RELEASE_LOCKS') {
        appliedCount++
        itemIds.push(it.runId)
      }
    }

    await markExpiredLocks(deps.locks, deps.clock, opts.boardId)
    const boardRev = await deps.atomic.bumpBoardRev(opts.boardId)
    await deps.reconciler.putLastApplyHash(opts.boardId, opts.dryRunHash)
    await deps.atomic.appendAudit({
      boardId: opts.boardId,
      kind: 'RECONCILER_APPLY',
      atMs: now,
      atISO: deps.clock.nowISO(),
      actorId: opts.leaderId,
      subjectType: 'reconcile',
      subjectId: opts.dryRunHash,
      detail: { appliedCount, skippedCount, itemIds },
      material: true,
    })

    return {
      applied: true,
      dryRunHash: opts.dryRunHash,
      appliedCount,
      skippedCount,
      itemIds,
      idempotentReplay: false,
      boardRev,
    }
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
      throw new ReconcilerError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

/** Tasks that map to RECONCILIATION_PENDING primary bucket (incomplete stale/orphan). */
export function tasksWithReconciliationPending(items: Array<ReconcileItemDiff>): Array<string> {
  return items.filter((i) => i.reconciliationPending).map((i) => i.taskId)
}

export function createMemoryReconcilerStore(): ReconcilerStore & {
  snapshot(): {
    leaders: Array<ReconcilerLeaderState>
    dryRuns: Array<ReconcileDryRunResult>
    lastApply: Record<string, string>
  }
} {
  const leaders = new Map<string, ReconcilerLeaderState>()
  const dryRuns = new Map<string, ReconcileDryRunResult>()
  const lastApply = new Map<string, string>()
  const completed = new Map<string, boolean>()
  const chains = new Map<string, Promise<unknown>>()
  const dk = (boardId: string, hash: string) => `${boardId}::${hash}`
  const ck = (boardId: string, taskId: string) => `${boardId}::${taskId}`

  return {
    snapshot() {
      return {
        leaders: [...leaders.values()].map((l) => ({ ...l })),
        dryRuns: [...dryRuns.values()].map((d) => ({
          ...d,
          items: d.items.map((i) => ({ ...i })),
        })),
        lastApply: Object.fromEntries(lastApply),
      }
    },
    async getLeader(boardId) {
      const l = leaders.get(boardId)
      return l ? { ...l } : null
    },
    async putLeader(state) {
      leaders.set(state.boardId, { ...state })
    },
    async getDryRun(boardId, dryRunHash) {
      const d = dryRuns.get(dk(boardId, dryRunHash))
      return d ? { ...d, items: d.items.map((i) => ({ ...i })) } : null
    },
    async putDryRun(result) {
      dryRuns.set(dk(result.boardId, result.dryRunHash), {
        ...result,
        items: result.items.map((i) => ({ ...i })),
      })
    },
    async getLastApplyHash(boardId) {
      return lastApply.get(boardId) ?? null
    },
    async putLastApplyHash(boardId, dryRunHash) {
      lastApply.set(boardId, dryRunHash)
    },
    async isTaskCompleted(boardId, taskId) {
      return completed.get(ck(boardId, taskId)) ?? false
    },
    async setTaskCompleted(boardId, taskId, value) {
      completed.set(ck(boardId, taskId), value)
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
