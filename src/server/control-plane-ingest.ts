/**
 * publish_dispatch_plan — root-only, revision/hash/expiry bound, ranked unique
 * items, dependency/collision proof, idempotency, sole source of NEXT.
 * Stale/expired/superseded plans cannot select work.
 */
import { createHash } from 'node:crypto'

import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import {
  beginIdempotent,
  completeIdempotent,
  type IdempotencyStorage,
  IdempotencyError,
} from './idempotency'
import { scopesCollide } from './locks'

export const DISPATCH_CALLER_ROOT = 'ROOT_ORCHESTRATOR' as const

export type DispatchPlanStatus = 'ACTIVE' | 'SUPERSEDED' | 'EXPIRED' | 'STALE'

export interface DependencyProof {
  satisfied: boolean
  refs?: Array<string>
}

export interface DispatchPlanItem {
  rank: number
  taskId: string
  targetGate: string
  role: string
  selectionReason: string
  priorityPortfolioId?: string | null
  dependencyProof?: DependencyProof | null
  collisionScopeLockIds?: Array<string>
  expectedEntityRev: number
  expectedBoardRev: number
}

export interface DispatchPlanRecord {
  boardId: string
  planId: string
  planVersion: number
  planHash: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRevAtPublish: number
  issuedAt: string
  expiresAt: string
  issuedAtMs: number
  expiresAtMs: number
  stage: string | null
  items: Array<DispatchPlanItem>
  status: DispatchPlanStatus
  generatedAt: string
  generatedAtMs: number
  supersededByPlanId: string | null
  entityRev: number
}

export interface PublishDispatchPlanRequest {
  boardId: string
  planId: string
  planVersion: number
  planHash: string
  canonicalSnapshotId: string
  canonicalHash: string
  expectedBoardRev: number
  issuedAt: string
  expiresAt: string
  stage?: string | null
  items: Array<DispatchPlanItem>
  idempotencyKey: string
  /** Must be ROOT_ORCHESTRATOR. */
  callerRole: string
  actorId?: string
}

export interface PublishDispatchPlanResult {
  planId: string
  planVersion: number
  planHash: string
  itemCount: number
  boardRev: number
  generatedAt: string
  status: DispatchPlanStatus
  selectedForNextDispatch: Array<SelectedNextItem>
  replayed: boolean
}

export interface SelectedNextItem {
  rank: number
  taskId: string
  targetGate: string
  role: string
  selectionReason: string
  priorityPortfolioId: string | null
  planId: string
  planVersion: number
  planHash: string
  expectedEntityRev: number
  expectedBoardRev: number
  collisionScopeLockIds: Array<string>
}

export type IngestErrorCode =
  | 'AUTHORIZATION_REQUIRED'
  | 'STALE_REVISION'
  | 'DATA_INTEGRITY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'DISPATCH_BLOCKED'
  | 'PLAN_EXPIRED'
  | 'PLAN_SUPERSEDED'
  | 'INVALID_INPUT'

export class IngestError extends Error {
  readonly code: IngestErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: IngestErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'IngestError'
    this.code = code
    this.details = details
  }
}

export interface DispatchPlanStore {
  get(boardId: string, planId: string): Promise<DispatchPlanRecord | null>
  put(plan: DispatchPlanRecord): Promise<void>
  list(boardId: string): Promise<Array<DispatchPlanRecord>>
  getActive(boardId: string): Promise<DispatchPlanRecord | null>
  withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T>
}

export interface IngestDeps {
  clock: ControlPlaneClock
  plans: DispatchPlanStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
}

/** Canonical plan hash over ranked items (server-side integrity check). */
export function computePlanHash(input: {
  boardId: string
  planId: string
  planVersion: number
  canonicalSnapshotId: string
  canonicalHash: string
  items: Array<DispatchPlanItem>
}): string {
  const payload = {
    boardId: input.boardId,
    planId: input.planId,
    planVersion: input.planVersion,
    canonicalSnapshotId: input.canonicalSnapshotId,
    canonicalHash: input.canonicalHash,
    items: [...input.items]
      .sort((a, b) => a.rank - b.rank)
      .map((it) => ({
        rank: it.rank,
        taskId: it.taskId,
        targetGate: it.targetGate,
        role: it.role,
        selectionReason: it.selectionReason,
        priorityPortfolioId: it.priorityPortfolioId ?? null,
        dependencyProof: it.dependencyProof ?? null,
        collisionScopeLockIds: [...(it.collisionScopeLockIds ?? [])].sort(),
        expectedEntityRev: it.expectedEntityRev,
        expectedBoardRev: it.expectedBoardRev,
      })),
  }
  return createHash('sha256').update(stableStringify(payload)).digest('hex')
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

function validateItems(items: Array<DispatchPlanItem>): void {
  if (!Array.isArray(items)) {
    throw new IngestError('DATA_INTEGRITY', 'items must be an array')
  }
  const ranks = new Set<number>()
  const tasks = new Set<string>()
  for (const it of items) {
    if (!Number.isInteger(it.rank) || it.rank < 1) {
      throw new IngestError('DATA_INTEGRITY', `invalid rank: ${String(it.rank)}`)
    }
    if (ranks.has(it.rank)) {
      throw new IngestError('DATA_INTEGRITY', `duplicate rank: ${it.rank}`)
    }
    ranks.add(it.rank)
    if (!it.taskId) throw new IngestError('DATA_INTEGRITY', 'taskId required on item')
    if (tasks.has(it.taskId)) {
      throw new IngestError('DATA_INTEGRITY', `duplicate taskId in plan: ${it.taskId}`)
    }
    tasks.add(it.taskId)
    if (!it.targetGate) throw new IngestError('DATA_INTEGRITY', 'targetGate required')
    if (!it.role) throw new IngestError('DATA_INTEGRITY', 'role required')
    if (!it.selectionReason) throw new IngestError('DATA_INTEGRITY', 'selectionReason required')
    if (it.dependencyProof && it.dependencyProof.satisfied === false) {
      throw new IngestError(
        'DATA_INTEGRITY',
        `dependency unsatisfied for ${it.taskId}`,
        { taskId: it.taskId, refs: it.dependencyProof.refs ?? [] },
      )
    }
  }
  // Cross-item collision proof: ranked unique items must not claim overlapping scopes
  for (let i = 0; i < items.length; i++) {
    const a = items[i]!
    const aScopes = a.collisionScopeLockIds ?? []
    for (let j = i + 1; j < items.length; j++) {
      const b = items[j]!
      const bScopes = b.collisionScopeLockIds ?? []
      for (const sa of aScopes) {
        for (const sb of bScopes) {
          if (scopesCollide(sa, sb)) {
            throw new IngestError(
              'DATA_INTEGRITY',
              `collision proof failed: rank ${a.rank} and ${b.rank} overlap on ${sa} / ${sb}`,
              { taskA: a.taskId, taskB: b.taskId, sa, sb },
            )
          }
        }
      }
    }
  }
}

function toSelected(plan: DispatchPlanRecord): Array<SelectedNextItem> {
  return [...plan.items]
    .sort((a, b) => a.rank - b.rank)
    .map((it) => ({
      rank: it.rank,
      taskId: it.taskId,
      targetGate: it.targetGate,
      role: it.role,
      selectionReason: it.selectionReason,
      priorityPortfolioId: it.priorityPortfolioId ?? null,
      planId: plan.planId,
      planVersion: plan.planVersion,
      planHash: plan.planHash,
      expectedEntityRev: it.expectedEntityRev,
      expectedBoardRev: it.expectedBoardRev,
      collisionScopeLockIds: [...(it.collisionScopeLockIds ?? [])],
    }))
}

/**
 * Sole source of selectedForNextDispatch / NEXT.
 * Stale, expired, or superseded plans return empty selection.
 */
export async function selectNextFromActivePlan(
  deps: Pick<IngestDeps, 'clock' | 'plans'>,
  boardId: string,
): Promise<{
  plan: DispatchPlanRecord | null
  selectedForNextDispatch: Array<SelectedNextItem>
  blockedReason: string | null
}> {
  const plan = await deps.plans.getActive(boardId)
  if (!plan) {
    return { plan: null, selectedForNextDispatch: [], blockedReason: 'NO_ACTIVE_PLAN' }
  }
  const now = deps.clock.nowMs()
  if (plan.status !== 'ACTIVE') {
    return {
      plan,
      selectedForNextDispatch: [],
      blockedReason: `PLAN_${plan.status}`,
    }
  }
  if (plan.expiresAtMs <= now) {
    // Mark expired (lazy)
    const expired: DispatchPlanRecord = { ...plan, status: 'EXPIRED' }
    await deps.plans.put(expired)
    return {
      plan: expired,
      selectedForNextDispatch: [],
      blockedReason: 'PLAN_EXPIRED',
    }
  }
  return {
    plan,
    selectedForNextDispatch: toSelected(plan),
    blockedReason: null,
  }
}

export async function publishDispatchPlan(
  deps: IngestDeps,
  req: PublishDispatchPlanRequest,
): Promise<PublishDispatchPlanResult> {
  if (req.callerRole !== DISPATCH_CALLER_ROOT) {
    throw new IngestError(
      'AUTHORIZATION_REQUIRED',
      'publish_dispatch_plan is ROOT_ORCHESTRATOR only',
      { callerRole: req.callerRole },
    )
  }
  if (!req.planId || !req.planHash || !req.canonicalSnapshotId || !req.canonicalHash) {
    throw new IngestError('INVALID_INPUT', 'planId, planHash, canonicalSnapshotId, canonicalHash required')
  }
  if (!req.idempotencyKey) {
    throw new IngestError('INVALID_INPUT', 'idempotencyKey required')
  }

  validateItems(req.items)

  const computed = computePlanHash({
    boardId: req.boardId,
    planId: req.planId,
    planVersion: req.planVersion,
    canonicalSnapshotId: req.canonicalSnapshotId,
    canonicalHash: req.canonicalHash,
    items: req.items,
  })
  if (computed !== req.planHash) {
    throw new IngestError('DATA_INTEGRITY', 'planHash mismatch vs canonical ranked items', {
      expected: req.planHash,
      computed,
    })
  }

  const issuedAtMs = Date.parse(req.issuedAt)
  const expiresAtMs = Date.parse(req.expiresAt)
  if (!Number.isFinite(issuedAtMs) || !Number.isFinite(expiresAtMs)) {
    throw new IngestError('INVALID_INPUT', 'issuedAt/expiresAt must be ISO timestamps')
  }
  if (expiresAtMs <= issuedAtMs) {
    throw new IngestError('INVALID_INPUT', 'expiresAt must be after issuedAt')
  }
  if (expiresAtMs <= deps.clock.nowMs()) {
    throw new IngestError('PLAN_EXPIRED', 'cannot publish already-expired plan')
  }

  // Idempotency before revision checks so exact replays do not require re-CAS.
  const begin = await beginIdempotent(deps.idempotency, {
    scope: {
      actorId: req.actorId ?? DISPATCH_CALLER_ROOT,
      boardId: req.boardId,
      endpoint: 'publish_dispatch_plan',
      key: req.idempotencyKey,
    },
    requestBody: {
      planId: req.planId,
      planVersion: req.planVersion,
      planHash: req.planHash,
      items: req.items,
    },
    nowMs: deps.clock.nowMs(),
  })

  if (begin.kind === 'REPLAY' && begin.record) {
    const body = begin.record.responseBody as PublishDispatchPlanResult
    return { ...body, replayed: true }
  }

  const board = await deps.atomic.getBoardState(req.boardId)
  if (board.dispatchBlocked) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw new IngestError(
      'DISPATCH_BLOCKED',
      board.dispatchBlockedReason ?? 'account sync stale; usableCapacity=0',
    )
  }
  if (req.expectedBoardRev !== board.boardRev) {
    try {
      await deps.idempotency.delete(begin.scopeHash)
    } catch {
      /* ignore */
    }
    throw new IngestError('STALE_REVISION', `expectedBoardRev ${req.expectedBoardRev} != ${board.boardRev}`, {
      expectedBoardRev: req.expectedBoardRev,
      currentBoardRev: board.boardRev,
    })
  }

  try {
    const result = await deps.plans.withBoardLock(req.boardId, async () => {
      const now = deps.clock.nowMs()
      const existingSame = await deps.plans.get(req.boardId, req.planId)
      if (existingSame && existingSame.planHash === req.planHash && existingSame.status === 'ACTIVE') {
        // Exact same plan republish
        const selected = toSelected(existingSame)
        return {
          planId: existingSame.planId,
          planVersion: existingSame.planVersion,
          planHash: existingSame.planHash,
          itemCount: existingSame.items.length,
          boardRev: existingSame.boardRevAtPublish,
          generatedAt: existingSame.generatedAt,
          status: existingSame.status,
          selectedForNextDispatch: selected,
          replayed: true,
        } satisfies PublishDispatchPlanResult
      }

      // Supersede previous ACTIVE plan
      const prevActive = await deps.plans.getActive(req.boardId)
      if (prevActive && prevActive.planId !== req.planId) {
        await deps.plans.put({
          ...prevActive,
          status: 'SUPERSEDED',
          supersededByPlanId: req.planId,
          entityRev: prevActive.entityRev + 1,
        })
        await deps.atomic.appendAudit({
          boardId: req.boardId,
          kind: 'PLAN_SUPERSEDED',
          atMs: now,
          atISO: deps.clock.nowISO(),
          actorId: req.actorId ?? DISPATCH_CALLER_ROOT,
          subjectType: 'dispatch_plan',
          subjectId: prevActive.planId,
          detail: { supersededBy: req.planId },
          material: true,
        })
      }

      const boardRev = await deps.atomic.bumpBoardRev(req.boardId)
      const rec: DispatchPlanRecord = {
        boardId: req.boardId,
        planId: req.planId,
        planVersion: req.planVersion,
        planHash: req.planHash,
        canonicalSnapshotId: req.canonicalSnapshotId,
        canonicalHash: req.canonicalHash,
        boardRevAtPublish: boardRev,
        issuedAt: req.issuedAt,
        expiresAt: req.expiresAt,
        issuedAtMs,
        expiresAtMs,
        stage: req.stage ?? null,
        items: req.items.map((it) => ({
          ...it,
          collisionScopeLockIds: [...(it.collisionScopeLockIds ?? [])],
          dependencyProof: it.dependencyProof
            ? { satisfied: it.dependencyProof.satisfied, refs: [...(it.dependencyProof.refs ?? [])] }
            : null,
        })),
        status: 'ACTIVE',
        generatedAt: deps.clock.nowISO(),
        generatedAtMs: now,
        supersededByPlanId: null,
        entityRev: 1,
      }
      await deps.plans.put(rec)
      await deps.atomic.appendAudit({
        boardId: req.boardId,
        kind: 'PLAN_PUBLISHED',
        atMs: now,
        atISO: deps.clock.nowISO(),
        actorId: req.actorId ?? DISPATCH_CALLER_ROOT,
        subjectType: 'dispatch_plan',
        subjectId: rec.planId,
        detail: {
          planVersion: rec.planVersion,
          planHash: rec.planHash,
          itemCount: rec.items.length,
          boardRev,
        },
        material: true,
      })

      return {
        planId: rec.planId,
        planVersion: rec.planVersion,
        planHash: rec.planHash,
        itemCount: rec.items.length,
        boardRev,
        generatedAt: rec.generatedAt,
        status: rec.status,
        selectedForNextDispatch: toSelected(rec),
        replayed: false,
      } satisfies PublishDispatchPlanResult
    })

    await completeIdempotent(deps.idempotency, begin.scopeHash, 200, result, begin.requestHash)
    return result
  } catch (e) {
    if (e instanceof IngestError) {
      try {
        await deps.idempotency.delete(begin.scopeHash)
      } catch {
        /* ignore */
      }
    }
    if (e instanceof IdempotencyError) {
      throw new IngestError('IDEMPOTENCY_CONFLICT', e.message)
    }
    throw e
  }
}

export function createMemoryDispatchPlanStore(): DispatchPlanStore & {
  snapshot(): Array<DispatchPlanRecord>
} {
  const plans = new Map<string, DispatchPlanRecord>()
  const chains = new Map<string, Promise<unknown>>()
  const key = (b: string, id: string) => `${b}::${id}`
  return {
    snapshot() {
      return [...plans.values()].map((p) => ({
        ...p,
        items: p.items.map((i) => ({ ...i })),
      }))
    },
    async get(boardId, planId) {
      const p = plans.get(key(boardId, planId))
      return p ? { ...p, items: p.items.map((i) => ({ ...i })) } : null
    },
    async put(plan) {
      plans.set(key(plan.boardId, plan.planId), {
        ...plan,
        items: plan.items.map((i) => ({ ...i })),
      })
    },
    async list(boardId) {
      return [...plans.values()]
        .filter((p) => p.boardId === boardId)
        .map((p) => ({ ...p, items: p.items.map((i) => ({ ...i })) }))
    },
    async getActive(boardId) {
      const active = [...plans.values()].filter((p) => p.boardId === boardId && p.status === 'ACTIVE')
      if (!active.length) return null
      // newest by generatedAtMs
      active.sort((a, b) => b.generatedAtMs - a.generatedAtMs)
      const p = active[0]!
      return { ...p, items: p.items.map((i) => ({ ...i })) }
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
// Process-wide shared plan store (sole NEXT wiring)
// Root publish, board server Fn, and MCP selectors MUST share one instance.
// ---------------------------------------------------------------------------

let sharedProcessPlanStore: DispatchPlanStore | null = null

/** Shared singleton used by board.ts getNextFn + board-mcp publish/get_next. */
export function getSharedDispatchPlanStore(): DispatchPlanStore {
  if (!sharedProcessPlanStore) {
    sharedProcessPlanStore = createMemoryDispatchPlanStore()
  }
  return sharedProcessPlanStore
}

/** Inject store (tests) or clear (null → next get recreates empty memory store). */
export function setSharedDispatchPlanStore(store: DispatchPlanStore | null): void {
  sharedProcessPlanStore = store
}

export function resetSharedDispatchPlanStore(): void {
  sharedProcessPlanStore = null
}

/** Explicit legacy feature-queue shape — NOT control-plane NEXT. C3 may drop the visual label. */
export type LegacyFeatureQueue = {
  kind: 'legacy_feature_queue'
  now: Array<string | { id: string; nama?: string | null }>
  next: Array<string | { id: string; nama?: string | null }>
  catatan: string | null
}

export function asLegacyFeatureQueue(q: {
  now: Array<string | { id: string; nama?: string | null }>
  next: Array<string | { id: string; nama?: string | null }>
  catatan?: string | null
}): LegacyFeatureQueue {
  return {
    kind: 'legacy_feature_queue',
    now: q.now,
    next: q.next,
    catatan: q.catatan ?? null,
  }
}

export interface DispatchNextMembershipItem {
  taskId: string
  rank: number
  selectionReason: string
  targetGate: string
  role: string
  priorityPortfolioId: string | null
}

/**
 * Project active-plan NEXT into overview/work/pinned envelope fields.
 * Membership/reason/rank come ONLY from selectNextFromActivePlan — never queue.next.
 */
export function projectDispatchNextFields(result: {
  plan: DispatchPlanRecord | null
  selectedForNextDispatch: Array<SelectedNextItem>
  blockedReason: string | null
}): {
  selectedForNextDispatch: Array<SelectedNextItem>
  planId: string | null
  blockedReason: string | null
  soleSource: 'active_dispatch_plan'
  next: {
    membership: Array<DispatchNextMembershipItem>
    planId: string | null
    blockedReason: string | null
    soleSource: 'active_dispatch_plan'
  }
} {
  const membership: Array<DispatchNextMembershipItem> = result.selectedForNextDispatch.map((s) => ({
    taskId: s.taskId,
    rank: s.rank,
    selectionReason: s.selectionReason,
    targetGate: s.targetGate,
    role: s.role,
    priorityPortfolioId: s.priorityPortfolioId,
  }))
  return {
    selectedForNextDispatch: result.selectedForNextDispatch,
    planId: result.plan?.planId ?? null,
    blockedReason: result.blockedReason,
    soleSource: 'active_dispatch_plan',
    next: {
      membership,
      planId: result.plan?.planId ?? null,
      blockedReason: result.blockedReason,
      soleSource: 'active_dispatch_plan',
    },
  }
}

/**
 * Mark rollup/task inputs selectedForNextDispatch ONLY from active-plan membership.
 * Producer contract for rollup NEXT bucket (never eligibility / queue.next).
 */
export function applySelectedForNextDispatchFlags<T extends { taskId: string }>(
  tasks: Array<T>,
  selected: Array<SelectedNextItem>,
): Array<T & { selectedForNextDispatch: boolean }> {
  const set = new Set(selected.map((s) => s.taskId))
  return tasks.map((t) => ({
    ...t,
    selectedForNextDispatch: set.has(t.taskId),
  }))
}

/**
 * Shared-path NEXT resolution used by board server Fn (and tests).
 * Always reads getSharedDispatchPlanStore — same store as MCP publish.
 */
export async function resolveSharedDispatchNext(
  boardId: string,
  clock: ControlPlaneClock = {
    nowMs: () => Date.now(),
    nowISO: () => new Date().toISOString(),
  },
): Promise<{
  boardId: string
  selectedForNextDispatch: Array<SelectedNextItem>
  planId: string | null
  blockedReason: string | null
  soleSource: 'active_dispatch_plan'
  next: ReturnType<typeof projectDispatchNextFields>['next']
  generatedAt: string
}> {
  const selected = await selectNextFromActivePlan(
    { clock, plans: getSharedDispatchPlanStore() },
    boardId,
  )
  const projected = projectDispatchNextFields(selected)
  return {
    boardId,
    ...projected,
    generatedAt: clock.nowISO(),
  }
}
