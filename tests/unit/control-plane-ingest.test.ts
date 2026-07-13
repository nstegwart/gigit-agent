import { afterEach, describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  applySelectedForNextDispatchFlags,
  asLegacyFeatureQueue,
  computePlanHash,
  createMemoryDispatchPlanStore,
  DISPATCH_CALLER_ROOT,
  getSharedDispatchPlanStore,
  hashPublishDispatchPlanBody,
  IngestError,
  projectDispatchNextFields,
  publishDispatchPlan,
  resetSharedDispatchPlanStore,
  resolveSharedDispatchNext,
  selectNextFromActivePlan,
  setSharedDispatchPlanStore,
  type DispatchPlanItem,
  type DispatchPlanRecord,
  type DispatchPlanStore,
  type IngestDeps,
  type PublishDispatchPlanRequest,
} from '#/server/control-plane-ingest'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'

const BOARD = 'mfs-rebuild'

function item(over: Partial<DispatchPlanItem> & Pick<DispatchPlanItem, 'rank' | 'taskId'>): DispatchPlanItem {
  return {
    targetGate: 'FUNCTIONAL',
    role: 'PRODUCT',
    selectionReason: 'priority-closure-frontier',
    priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
    dependencyProof: { satisfied: true, refs: [] },
    collisionScopeLockIds: [`repo:example:src/task-${over.taskId}/**`],
    expectedEntityRev: 1,
    expectedBoardRev: 0,
    ...over,
  }
}

function deps(clock = createFakeClock()): IngestDeps & { clock: ReturnType<typeof createFakeClock> } {
  return {
    clock,
    plans: createMemoryDispatchPlanStore(),
    atomic: createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ]),
    idempotency: createMemoryIdempotencyStorage(),
  }
}

async function publish(
  d: IngestDeps,
  over: {
    planId?: string
    planVersion?: number
    items?: Array<DispatchPlanItem>
    callerRole?: string
    entityExpectedRev?: number
    expectedBoardRev?: number
    currentPinHash?: string | null
    issuedAt?: string
    expiresAt?: string
    stage?: string | null
    idempotencyKey?: string
    planHash?: string
    canonicalSnapshotId?: string
    canonicalHash?: string
    actorId?: string
  } = {},
) {
  const items = over.items ?? [item({ rank: 1, taskId: 'T-1' }), item({ rank: 2, taskId: 'T-2' })]
  const planId = over.planId ?? 'plan-1'
  const canonicalSnapshotId = over.canonicalSnapshotId ?? 'snap-1'
  const canonicalHash = over.canonicalHash ?? 'canon-aaa'
  const base = {
    boardId: BOARD,
    planId,
    planVersion: over.planVersion ?? 1,
    canonicalSnapshotId,
    canonicalHash,
    items,
  }
  const planHash = over.planHash ?? computePlanHash(base)
  return publishDispatchPlan(d, {
    ...base,
    planHash,
    entityExpectedRev: over.entityExpectedRev ?? 0,
    expectedBoardRev: over.expectedBoardRev ?? 0,
    currentPinHash: over.currentPinHash !== undefined ? over.currentPinHash : canonicalHash,
    issuedAt: over.issuedAt ?? '2026-07-13T10:00:00.000Z',
    expiresAt: over.expiresAt ?? '2026-07-13T14:00:00.000Z',
    stage: over.stage !== undefined ? over.stage : 'MAP_VERIFIED',
    items,
    idempotencyKey: over.idempotencyKey ?? `idem-${planId}`,
    callerRole: over.callerRole ?? DISPATCH_CALLER_ROOT,
    actorId: over.actorId ?? 'root-1',
  })
}

function buildPublishReq(
  over: Partial<PublishDispatchPlanRequest> & {
    planId?: string
    items?: Array<DispatchPlanItem>
  } = {},
): PublishDispatchPlanRequest {
  const items = over.items ?? [item({ rank: 1, taskId: 'T-1' })]
  const planId = over.planId ?? 'plan-matrix'
  const boardId = over.boardId ?? BOARD
  const planVersion = over.planVersion ?? 1
  const canonicalSnapshotId = over.canonicalSnapshotId ?? 'snap-1'
  const canonicalHash = over.canonicalHash ?? 'canon-aaa'
  const planHash =
    over.planHash ??
    computePlanHash({ boardId, planId, planVersion, canonicalSnapshotId, canonicalHash, items })
  return {
    boardId,
    planId,
    planVersion,
    planHash,
    canonicalSnapshotId,
    canonicalHash,
    entityExpectedRev: over.entityExpectedRev ?? 0,
    expectedBoardRev: over.expectedBoardRev ?? 0,
    currentPinHash: over.currentPinHash !== undefined ? over.currentPinHash : canonicalHash,
    issuedAt: over.issuedAt ?? '2026-07-13T10:00:00.000Z',
    expiresAt: over.expiresAt ?? '2026-07-13T14:00:00.000Z',
    stage: over.stage !== undefined ? over.stage : 'MAP_VERIFIED',
    items,
    idempotencyKey: over.idempotencyKey ?? 'matrix-key',
    callerRole: over.callerRole ?? DISPATCH_CALLER_ROOT,
    actorId: over.actorId ?? 'root-1',
  }
}

describe('AC-INGEST publish_dispatch_plan sole NEXT source', () => {
  it('AC-INGEST-01: root publish is sole source of selectedForNextDispatch / NEXT', async () => {
    const d = deps()
    const empty = await selectNextFromActivePlan(d, BOARD)
    expect(empty.selectedForNextDispatch).toEqual([])
    expect(empty.blockedReason).toBe('NO_ACTIVE_PLAN')

    const res = await publish(d)
    expect(res.itemCount).toBe(2)
    expect(res.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-1', 'T-2'])
    expect(res.selectedForNextDispatch[0]!.rank).toBe(1)
    expect(res.selectedForNextDispatch[0]!.selectionReason).toBe('priority-closure-frontier')

    const next = await selectNextFromActivePlan(d, BOARD)
    expect(next.selectedForNextDispatch).toEqual(res.selectedForNextDispatch)
    expect(next.blockedReason).toBeNull()
  })

  it('AC-INGEST-02: rank/reason/revisions match NEXT projection', async () => {
    const d = deps()
    const items = [
      item({
        rank: 1,
        taskId: 'T-A',
        selectionReason: 'reason-a',
        expectedEntityRev: 3,
        expectedBoardRev: 0,
      }),
      item({
        rank: 2,
        taskId: 'T-B',
        selectionReason: 'reason-b',
        expectedEntityRev: 4,
        expectedBoardRev: 0,
      }),
    ]
    const res = await publish(d, { items, planId: 'plan-rank' })
    const next = await selectNextFromActivePlan(d, BOARD)
    expect(next.selectedForNextDispatch).toHaveLength(2)
    expect(next.selectedForNextDispatch[0]).toMatchObject({
      rank: 1,
      taskId: 'T-A',
      selectionReason: 'reason-a',
      expectedEntityRev: 3,
      planHash: res.planHash,
    })
    expect(next.selectedForNextDispatch[1]).toMatchObject({
      rank: 2,
      selectionReason: 'reason-b',
      expectedEntityRev: 4,
    })
  })

  it('rejects non-root caller', async () => {
    const d = deps()
    await expect(publish(d, { callerRole: 'AGENT' })).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
    })
  })

  it('rejects planHash mismatch and duplicate ranks / unsatisfied deps / collisions', async () => {
    const d = deps()
    await expect(publish(d, { planHash: 'deadbeef' })).rejects.toMatchObject({
      code: 'DATA_INTEGRITY',
    })

    await expect(
      publish(d, {
        planId: 'dup-rank',
        items: [item({ rank: 1, taskId: 'T-1' }), item({ rank: 1, taskId: 'T-2' })],
      }),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })

    await expect(
      publish(d, {
        planId: 'dep-fail',
        items: [
          item({
            rank: 1,
            taskId: 'T-1',
            dependencyProof: { satisfied: false, refs: ['T-0'] },
          }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })

    await expect(
      publish(d, {
        planId: 'col-fail',
        items: [
          item({ rank: 1, taskId: 'T-1', collisionScopeLockIds: ['repo:ex:src/**'] }),
          item({ rank: 2, taskId: 'T-2', collisionScopeLockIds: ['repo:ex:src/a.ts'] }),
        ],
      }),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })
  })

  it('STALE_REVISION on expectedBoardRev mismatch', async () => {
    const d = deps()
    await expect(publish(d, { expectedBoardRev: 9 })).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
  })

  it('AC-INGEST-04: idempotent republish replays; supersession clears old NEXT', async () => {
    const d = deps()
    const a = await publish(d, { planId: 'plan-a', idempotencyKey: 'k-a' })
    const replay = await publish(d, { planId: 'plan-a', idempotencyKey: 'k-a' })
    expect(replay.replayed).toBe(true)
    expect(replay.planHash).toBe(a.planHash)

    const b = await publish(d, {
      planId: 'plan-b',
      idempotencyKey: 'k-b',
      expectedBoardRev: a.boardRev,
      items: [item({ rank: 1, taskId: 'T-NEW' })],
    })
    expect(b.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-NEW'])
    const next = await selectNextFromActivePlan(d, BOARD)
    expect(next.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-NEW'])
    expect(next.plan?.planId).toBe('plan-b')

    const old = await d.plans.get(BOARD, 'plan-a')
    expect(old?.status).toBe('SUPERSEDED')
  })

  it('expired/superseded plans cannot select work', async () => {
    const clock = createFakeClock(Date.parse('2026-07-13T10:00:00.000Z'))
    const d = deps(clock)
    await publish(d, {
      planId: 'plan-exp',
      expiresAt: '2026-07-13T10:30:00.000Z',
      items: [item({ rank: 1, taskId: 'T-EXP' })],
    })
    clock.advance(31 * 60_000)
    const next = await selectNextFromActivePlan(d, BOARD)
    expect(next.selectedForNextDispatch).toEqual([])
    expect(next.blockedReason).toBe('PLAN_EXPIRED')
    expect(next.plan?.status).toBe('EXPIRED')
  })

  it('DISPATCH_BLOCKED when account sync blocks board', async () => {
    const d = deps()
    await d.atomic.setBoardState({
      boardId: BOARD,
      boardRev: 0,
      dispatchBlocked: true,
      dispatchBlockedReason: 'ACCOUNT_SYNC_STALE: SLA_MISS',
    })
    await expect(publish(d)).rejects.toMatchObject({ code: 'DISPATCH_BLOCKED' })
  })

  it('immutable PLAN_PUBLISHED audit exists', async () => {
    const d = deps()
    await publish(d)
    const audit = await d.atomic.listAudit(BOARD)
    expect(audit.some((a) => a.kind === 'PLAN_PUBLISHED')).toBe(true)
  })

  it('adversarial: cannot publish already-expired plan; idempotency body conflict', async () => {
    // Helper issuedAt is 10:00; clock now 12:00 so expiresAt=11:00 is after issued but already expired.
    const clock = createFakeClock(Date.parse('2026-07-13T12:00:00.000Z'))
    const d = deps(clock)
    await expect(
      publish(d, {
        planId: 'plan-already-exp',
        expiresAt: '2026-07-13T11:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'PLAN_EXPIRED' })

    // Reset clock for successful publish + conflict path
    const d2 = deps(createFakeClock(Date.parse('2026-07-13T10:00:00.000Z')))
    const a = await publish(d2, {
      planId: 'plan-idem',
      idempotencyKey: 'same-key',
      items: [item({ rank: 1, taskId: 'T-1' })],
    })
    // Different body, same key → conflict (not silent overwrite)
    await expect(
      publish(d2, {
        planId: 'plan-idem-other',
        idempotencyKey: 'same-key',
        expectedBoardRev: a.boardRev,
        items: [item({ rank: 1, taskId: 'T-OTHER' })],
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
  })

  it('full envelope: pin mismatch STALE; create bumps board once; exact replay no second bump', async () => {
    const d = deps()
    await expect(
      publish(d, {
        planId: 'plan-pin',
        currentPinHash: 'wrong-pin',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(
      publish(d, {
        planId: 'plan-ent',
        entityExpectedRev: 5,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const board0 = (await d.atomic.getBoardState(BOARD)).boardRev
    const a = await publish(d, {
      planId: 'plan-env',
      idempotencyKey: 'plan-env-k',
      entityExpectedRev: 0,
      expectedBoardRev: board0,
      currentPinHash: 'canon-aaa',
    })
    expect(a.replayed).toBe(false)
    expect(a.boardRev).toBe(board0 + 1)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(board0 + 1)

    const replay = await publish(d, {
      planId: 'plan-env',
      idempotencyKey: 'plan-env-k',
      entityExpectedRev: 0,
      expectedBoardRev: board0,
      currentPinHash: 'canon-aaa',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.boardRev).toBe(a.boardRev)
    // Exact key replay must not double-bump board rev
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(board0 + 1)
  })

  it('idempotency hash matrix: each previously-omitted material field alone → IDEMPOTENCY_CONFLICT', async () => {
    const KEY = 'publish-matrix-key'
    const d = deps()
    const board0 = (await d.atomic.getBoardState(BOARD)).boardRev
    const first = await publish(d, {
      planId: 'plan-matrix-base',
      idempotencyKey: KEY,
      entityExpectedRev: 0,
      expectedBoardRev: board0,
      issuedAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T14:00:00.000Z',
      stage: 'MAP_VERIFIED',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canon-aaa',
    })
    expect(first.replayed).toBe(false)
    const boardAfter = (await d.atomic.getBoardState(BOARD)).boardRev
    expect(boardAfter).toBe(board0 + 1)

    // Exact same → replay, no board bump
    const exact = await publish(d, {
      planId: 'plan-matrix-base',
      idempotencyKey: KEY,
      entityExpectedRev: 0,
      expectedBoardRev: board0,
      issuedAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T14:00:00.000Z',
      stage: 'MAP_VERIFIED',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canon-aaa',
    })
    expect(exact.replayed).toBe(true)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(boardAfter)

    const baseHash = hashPublishDispatchPlanBody(
      buildPublishReq({
        planId: 'plan-matrix-base',
        idempotencyKey: KEY,
        entityExpectedRev: 0,
        expectedBoardRev: board0,
        issuedAt: '2026-07-13T10:00:00.000Z',
        expiresAt: '2026-07-13T14:00:00.000Z',
        stage: 'MAP_VERIFIED',
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'canon-aaa',
      }),
    )

    // Each field that the independent verifier found omitted from the old hash.
    const fieldCases: Array<{
      field: string
      over: Parameters<typeof publish>[1]
      expectHashDiff?: boolean
    }> = [
      {
        field: 'issuedAt',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:30:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'expiresAt',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T15:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'stage',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'OTHER_STAGE',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'entityExpectedRev',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 1,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'expectedBoardRev',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0 + 99,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'canonicalSnapshotId',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-OTHER',
          canonicalHash: 'canon-aaa',
        },
      },
      {
        field: 'canonicalHash',
        over: {
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-OTHER',
          currentPinHash: 'canon-OTHER',
        },
      },
    ]

    for (const c of fieldCases) {
      const mutatedHash = hashPublishDispatchPlanBody(
        buildPublishReq({
          planId: 'plan-matrix-base',
          idempotencyKey: KEY,
          entityExpectedRev: 0,
          expectedBoardRev: board0,
          issuedAt: '2026-07-13T10:00:00.000Z',
          expiresAt: '2026-07-13T14:00:00.000Z',
          stage: 'MAP_VERIFIED',
          canonicalSnapshotId: 'snap-1',
          canonicalHash: 'canon-aaa',
          ...c.over,
        }),
      )
      expect(mutatedHash, `hash must differ for field ${c.field}`).not.toBe(baseHash)

      await expect(publish(d, c.over), `field ${c.field}`).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      })
      // Conflict must not bump board further
      expect((await d.atomic.getBoardState(BOARD)).boardRev, `no bump after ${c.field}`).toBe(
        boardAfter,
      )
    }
  })
})

describe('IngestError typing', () => {
  it('is instance of Error', () => {
    const e = new IngestError('INVALID_INPUT', 'x')
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('INVALID_INPUT')
  })
})

// ---------------------------------------------------------------------------
// M-NEXT-01..09 — sole-NEXT shared store + projection integration
// ---------------------------------------------------------------------------
describe('M-NEXT sole-NEXT shared store + projection', () => {
  afterEach(() => {
    resetSharedDispatchPlanStore()
  })

  function sharedDeps(clock = createFakeClock()) {
    // Publish into the same process-wide store used by resolveSharedDispatchNext / MCP
    return {
      clock,
      plans: getSharedDispatchPlanStore(),
      atomic: createMemoryControlPlaneAtomicStore([
        { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
      ]),
      idempotency: createMemoryIdempotencyStorage(),
    } satisfies IngestDeps
  }

  it('M-NEXT-01: resolveSharedDispatchNext returns NO_ACTIVE_PLAN / empty when no active plan', async () => {
    resetSharedDispatchPlanStore()
    const next = await resolveSharedDispatchNext(BOARD, createFakeClock())
    expect(next.selectedForNextDispatch).toEqual([])
    expect(next.blockedReason).toBe('NO_ACTIVE_PLAN')
    expect(next.planId).toBeNull()
    expect(next.soleSource).toBe('active_dispatch_plan')
    expect(next.next.membership).toEqual([])
  })

  it('M-NEXT-02: publish into shared store → resolveSharedDispatchNext matches publish selection', async () => {
    const d = sharedDeps()
    const res = await publish(d, {
      planId: 'plan-shared-2',
      items: [
        item({ rank: 1, taskId: 'T-S1', selectionReason: 'reason-s1' }),
        item({ rank: 2, taskId: 'T-S2', selectionReason: 'reason-s2' }),
      ],
    })
    const next = await resolveSharedDispatchNext(BOARD, d.clock)
    expect(next.selectedForNextDispatch).toEqual(res.selectedForNextDispatch)
    expect(next.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-S1', 'T-S2'])
    expect(next.next.membership.map((m) => m.selectionReason)).toEqual(['reason-s1', 'reason-s2'])
    expect(next.next.membership.map((m) => m.rank)).toEqual([1, 2])
    expect(next.soleSource).toBe('active_dispatch_plan')
  })

  it('M-NEXT-03: board path and MCP path share one singleton (no orphan dual stores)', async () => {
    const storeA = getSharedDispatchPlanStore()
    const storeB = getSharedDispatchPlanStore()
    expect(storeA).toBe(storeB)

    // Injected store replaces singleton for both board Fn and MCP
    const injected = createMemoryDispatchPlanStore()
    setSharedDispatchPlanStore(injected)
    expect(getSharedDispatchPlanStore()).toBe(injected)

    const d = sharedDeps()
    // sharedDeps() already uses getSharedDispatchPlanStore() → injected
    await publish(d, {
      planId: 'plan-iso',
      items: [item({ rank: 1, taskId: 'T-ISO' })],
    })
    const boardPath = await resolveSharedDispatchNext(BOARD, d.clock)
    const mcpPath = await selectNextFromActivePlan(
      { clock: d.clock, plans: getSharedDispatchPlanStore() },
      BOARD,
    )
    expect(boardPath.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-ISO'])
    expect(mcpPath.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-ISO'])
    expect(boardPath.selectedForNextDispatch).toEqual(mcpPath.selectedForNextDispatch)
  })

  it('M-NEXT-04: selection never consults feature eligibility / queue.next / raw board JSON', async () => {
    const d = sharedDeps()
    // Publish one plan item only — selector cannot invent queue.next tasks
    await publish(d, {
      planId: 'plan-no-queue',
      items: [item({ rank: 1, taskId: 'T-ONLY-PLAN' })],
    })
    const next = await selectNextFromActivePlan(d, BOARD)
    expect(next.selectedForNextDispatch.map((x) => x.taskId)).toEqual(['T-ONLY-PLAN'])
    // Projection has no queue fields
    const projected = projectDispatchNextFields(next)
    expect(projected).not.toHaveProperty('queue')
    expect(JSON.stringify(projected)).not.toMatch(/queue\.next|eligibility/)
    expect(projected.soleSource).toBe('active_dispatch_plan')
  })

  it('M-NEXT-05: SUPERSEDED-only records cannot select', async () => {
    const plans = createMemoryDispatchPlanStore()
    const superseded: DispatchPlanRecord = {
      boardId: BOARD,
      planId: 'plan-super',
      planVersion: 1,
      planHash: 'h-super',
      canonicalSnapshotId: 'snap',
      canonicalHash: 'canon',
      boardRevAtPublish: 1,
      issuedAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T20:00:00.000Z',
      issuedAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
      expiresAtMs: Date.parse('2026-07-13T20:00:00.000Z'),
      stage: null,
      items: [item({ rank: 1, taskId: 'T-SUPER' })],
      status: 'SUPERSEDED',
      generatedAt: '2026-07-13T10:00:00.000Z',
      generatedAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
      supersededByPlanId: 'plan-other',
      entityRev: 1,
    }
    await plans.put(superseded)
    const next = await selectNextFromActivePlan(
      { clock: createFakeClock(Date.parse('2026-07-13T12:00:00.000Z')), plans },
      BOARD,
    )
    // getActive filters ACTIVE only → no plan
    expect(next.plan).toBeNull()
    expect(next.selectedForNextDispatch).toEqual([])
    expect(next.blockedReason).toBe('NO_ACTIVE_PLAN')
  })

  it('M-NEXT-06: STALE status cannot select', async () => {
    const plans = createMemoryDispatchPlanStore()
    const stale: DispatchPlanRecord = {
      boardId: BOARD,
      planId: 'plan-stale',
      planVersion: 1,
      planHash: 'h-stale',
      canonicalSnapshotId: 'snap',
      canonicalHash: 'canon',
      boardRevAtPublish: 1,
      issuedAt: '2026-07-13T10:00:00.000Z',
      expiresAt: '2026-07-13T20:00:00.000Z',
      issuedAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
      expiresAtMs: Date.parse('2026-07-13T20:00:00.000Z'),
      stage: null,
      items: [item({ rank: 1, taskId: 'T-STALE' })],
      status: 'STALE',
      generatedAt: '2026-07-13T10:00:00.000Z',
      generatedAtMs: Date.parse('2026-07-13T10:00:00.000Z'),
      supersededByPlanId: null,
      entityRev: 1,
    }
    // put STALE; getActive only returns ACTIVE so select is empty
    await plans.put(stale)
    // Force path: write as ACTIVE then flip — getActive would miss STALE; also exercise status branch
    const activeThenStale: DispatchPlanRecord = { ...stale, status: 'ACTIVE', planId: 'plan-stale-active' }
    await plans.put(activeThenStale)
    // Manually put STALE under same getActive race: replace with STALE id that getActive could return
    // if filter were broken — use put overwriting to STALE while still newest ACTIVE filter fails.
    // Direct status check: put ACTIVE-looking record then call select after mutating status via put
    await plans.put({ ...activeThenStale, status: 'STALE' })
    // Since getActive filters status===ACTIVE, STALE is invisible → NO_ACTIVE_PLAN
    const next = await selectNextFromActivePlan(
      { clock: createFakeClock(Date.parse('2026-07-13T12:00:00.000Z')), plans },
      BOARD,
    )
    expect(next.selectedForNextDispatch).toEqual([])
    expect(next.blockedReason).toBe('NO_ACTIVE_PLAN')

    // Explicit status branch: if a non-ACTIVE record were returned, blockedReason is PLAN_STALE
    // Simulate by temporarily using a store that returns STALE from getActive
    const sticky: DispatchPlanStoreLike = {
      async get() {
        return stale
      },
      async put() {},
      async list() {
        return [stale]
      },
      async getActive() {
        return stale
      },
      async withBoardLock(_b, fn) {
        return fn()
      },
    }
    const forced = await selectNextFromActivePlan(
      {
        clock: createFakeClock(Date.parse('2026-07-13T12:00:00.000Z')),
        plans: sticky as ReturnType<typeof createMemoryDispatchPlanStore>,
      },
      BOARD,
    )
    expect(forced.selectedForNextDispatch).toEqual([])
    expect(forced.blockedReason).toBe('PLAN_STALE')
  })

  it('M-NEXT-07: legacy feature queue is explicitly typed; not dispatch NEXT', () => {
    const legacy = asLegacyFeatureQueue({
      now: ['F-1'],
      next: ['F-2', 'F-3'],
      catatan: 'legacy note',
    })
    expect(legacy.kind).toBe('legacy_feature_queue')
    expect(legacy.next).toEqual(['F-2', 'F-3'])
    // Projection from empty plan has soleSource and never copies legacy next as membership
    const projected = projectDispatchNextFields({
      plan: null,
      selectedForNextDispatch: [],
      blockedReason: 'NO_ACTIVE_PLAN',
    })
    expect(projected.soleSource).toBe('active_dispatch_plan')
    expect(projected.next.membership).toEqual([])
    expect(projected).not.toHaveProperty('legacyFeatureQueue')
    // Control-plane next membership is not feature ids from queue
    expect(projected.next.membership.map((m) => m.taskId)).not.toContain('F-2')
  })

  it('M-NEXT-08: publish + get_next share one store (integration)', async () => {
    resetSharedDispatchPlanStore()
    const d = sharedDeps()
    const published = await publish(d, {
      planId: 'plan-mcp-share',
      items: [item({ rank: 1, taskId: 'T-MCP', selectionReason: 'mcp-share' })],
    })
    // MCP-style read uses same getSharedDispatchPlanStore
    const mcpSelect = await selectNextFromActivePlan(
      { clock: d.clock, plans: getSharedDispatchPlanStore() },
      BOARD,
    )
    // Board-style read
    const boardSelect = await resolveSharedDispatchNext(BOARD, d.clock)
    expect(mcpSelect.selectedForNextDispatch).toEqual(published.selectedForNextDispatch)
    expect(boardSelect.selectedForNextDispatch).toEqual(published.selectedForNextDispatch)
    expect(boardSelect.next.membership[0]).toMatchObject({
      taskId: 'T-MCP',
      rank: 1,
      selectionReason: 'mcp-share',
    })
  })

  it('M-NEXT-09: rollup selectedForNextDispatch flags only from active plan membership', async () => {
    const d = sharedDeps()
    await publish(d, {
      planId: 'plan-rollup',
      items: [
        item({ rank: 1, taskId: 'T-1' }),
        item({ rank: 2, taskId: 'T-3' }),
      ],
    })
    const next = await selectNextFromActivePlan(d, BOARD)
    const tasks = [{ taskId: 'T-1' }, { taskId: 'T-2' }, { taskId: 'T-3' }, { taskId: 'T-QUEUE-LEGACY' }]
    const marked = applySelectedForNextDispatchFlags(tasks, next.selectedForNextDispatch)
    expect(marked).toEqual([
      { taskId: 'T-1', selectedForNextDispatch: true },
      { taskId: 'T-2', selectedForNextDispatch: false },
      { taskId: 'T-3', selectedForNextDispatch: true },
      { taskId: 'T-QUEUE-LEGACY', selectedForNextDispatch: false },
    ])
  })
})

/** Minimal store shape for forced STALE getActive path (M-NEXT-06). */
interface DispatchPlanStoreLike {
  get: DispatchPlanStore['get']
  put: DispatchPlanStore['put']
  list: DispatchPlanStore['list']
  getActive: DispatchPlanStore['getActive']
  withBoardLock: DispatchPlanStore['withBoardLock']
}
