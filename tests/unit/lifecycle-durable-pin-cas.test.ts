/**
 * Packet A — durable lifecycle pin CAS (board_revisions.lifecycle_rev authority).
 *
 * Proves D1 fix LOCAL-ONLY (memory SQL / memory atomic; no live DB claim):
 * - Non-lifecycle bumpBoardRev freezes lifecycle_rev (documents pre-fix defect surface)
 * - advance_task dual-bump increments board_rev + lifecycle_rev exactly once
 * - Response pin tuple equals durable getBoardPinRevs re-read
 * - Idempotent replay does not second-bump
 * - Stale loser sees current pin (board + lifecycle)
 * - Snapshot import path still preserves lifecycle_rev (seed + ON DUPLICATE shape)
 *
 * Hermetic: no MySQL process required.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMemoryControlPlaneRuntimeContext,
  resetControlPlaneRuntimeContextForTests,
  setTestControlPlaneRuntimeContext,
} from '#/server/control-plane-runtime-context'
import {
  ATOMIC_SQL,
  ControlPlaneAtomicError,
  createMemoryAtomicSqlExecutor,
  createMysqlControlPlaneAtomicStore,
} from '#/server/mysql-control-plane-atomic'
import {
  runMutationGate,
  McpMutationError,
  setProductLifecycleV3StorageFactory,
  resetMcpControlPlaneDeps,
  toLegacyAdvanceCompatibilityResponse,
} from '#/server/board-mcp'
import {
  advanceTaskV3,
  computeStageReceiptHash,
  createMemoryLifecycleV3Storage,
  type RegisteredRun,
  type StageReceipt,
  type TaskLifecycleV3State,
} from '#/server/lifecycle-store'
import type { LifecycleStageKey } from '#/lib/control-plane-types'
import { seedBoardRevision } from '#/server/control-data-persistence'

const BOARD = 'life-pin-cas-board'
const TASK = 'task-pin-1'
const CANON = 'c'.repeat(64)
const SNAP = 'snap-life-pin-1'
const TASK_HASH = 'task-hash-pin-1'

function baseTask(
  stage: LifecycleStageKey | null = null,
  boardRev = 3,
  lifecycleRev = 5,
): TaskLifecycleV3State {
  return {
    taskId: TASK,
    stage,
    entityRev: 0,
    boardRev,
    lifecycleRev,
    taskHash: TASK_HASH,
    canonicalSnapshotId: SNAP,
    canonicalHash: CANON,
    implementerRunId: null,
    implementerAgentId: null,
    implementerModel: null,
    implementerThreadId: null,
    history: [],
    stageReceipts: {},
    blockedReason: null,
  }
}

function run(over: Partial<RegisteredRun> & Pick<RegisteredRun, 'runId' | 'role'>): RegisteredRun {
  return {
    agentId: `agent-${over.runId}`,
    model: 'grok-4.5',
    threadId: `thread-${over.runId}`,
    expiresAt: '2099-01-01T00:00:00.000Z',
    fenced: false,
    registered: true,
    ...over,
  }
}

function makeReceipt(
  stage: LifecycleStageKey,
  fields: Record<string, unknown>,
  boardRev: number,
  lifecycleRev: number,
): StageReceipt {
  const partial = {
    receiptId: `rcpt-${stage}`,
    programmatic: true as const,
    taskHash: TASK_HASH,
    canonicalHash: CANON,
    boardRev,
    lifecycleRev,
    fields,
    authorRunId: 'run-impl' as string | null,
    verifierRunId: null as string | null,
    verdict: null as string | null,
    issuedAt: '2026-07-18T10:00:00.000Z',
  }
  return { ...partial, receiptHash: computeStageReceiptHash(partial) }
}

describe('durable lifecycle pin SQL authority (Packet A)', () => {
  let exec: ReturnType<typeof createMemoryAtomicSqlExecutor>
  let store: ReturnType<typeof createMysqlControlPlaneAtomicStore>

  beforeEach(() => {
    exec = createMemoryAtomicSqlExecutor()
    store = createMysqlControlPlaneAtomicStore(exec, { useNamedLock: false })
  })

  it('D1 surface: bumpBoardRev freezes lifecycle_rev (non-lifecycle mutation)', async () => {
    // Seed via ensure + direct SQL-shaped insert path
    await store.bumpBoardRev(BOARD) // creates row, board=1, life=0
    // Force lifecycle to a non-zero pin (as import/seed would)
    const row = exec.boards.get(BOARD)!
    row.lifecycle_rev = 5
    row.board_rev = 3

    const afterBoardOnly = await store.bumpBoardRev(BOARD)
    expect(afterBoardOnly).toBe(4)
    expect(exec.boards.get(BOARD)!.lifecycle_rev).toBe(5) // frozen — D1 surface for non-advance
    expect(exec.boards.get(BOARD)!.board_rev).toBe(4)

    const pin = await store.getBoardPinRevs(BOARD)
    expect(pin).toEqual({ boardRev: 4, lifecycleRev: 5 })
  })

  it('post-fix: bumpBoardAndLifecycleRev increments both exactly once', async () => {
    await store.bumpBoardRev(BOARD)
    const row = exec.boards.get(BOARD)!
    row.board_rev = 3
    row.lifecycle_rev = 5

    const next = await store.bumpBoardAndLifecycleRev(BOARD)
    expect(next).toEqual({ boardRev: 4, lifecycleRev: 6 })
    expect(exec.boards.get(BOARD)!.board_rev).toBe(4)
    expect(exec.boards.get(BOARD)!.lifecycle_rev).toBe(6)

    const reread = await store.getBoardPinRevs(BOARD)
    expect(reread).toEqual(next)
  })

  it('casBumpBoardAndLifecycleRev rejects stale loser with current pin', async () => {
    await store.bumpBoardRev(BOARD)
    const row = exec.boards.get(BOARD)!
    row.board_rev = 3
    row.lifecycle_rev = 5

    const ok = await store.casBumpBoardAndLifecycleRev(BOARD, 3, 5)
    expect(ok).toEqual({ boardRev: 4, lifecycleRev: 6 })

    await expect(store.casBumpBoardAndLifecycleRev(BOARD, 3, 5)).rejects.toMatchObject({
      name: 'ControlPlaneAtomicError',
      code: 'STALE_REVISION',
      details: expect.objectContaining({
        currentBoardRev: 4,
        currentLifecycleRev: 6,
      }),
    })
    // Loser did not double-bump
    expect(await store.getBoardPinRevs(BOARD)).toEqual({ boardRev: 4, lifecycleRev: 6 })
  })

  it('SQL constants expose dual-bump authority (no migration — column exists)', () => {
    expect(ATOMIC_SQL.bumpBoardAndLifecycleRev).toMatch(/lifecycle_rev\s*=\s*lifecycle_rev\s*\+\s*1/i)
    expect(ATOMIC_SQL.bumpBoardRev).not.toMatch(/lifecycle_rev/i)
    expect(ATOMIC_SQL.getBoardPinRevs).toMatch(/lifecycle_rev/i)
  })
})

/** Seed atomic pin with lifecycle (boardRev 0 keeps revision-store CAS aligned). */
function seedPinRuntime(boardRev: number, lifecycleRev: number) {
  const ctx = createMemoryControlPlaneRuntimeContext({
    seedBoards: [
      {
        boardId: BOARD,
        boardRev,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
        lifecycleRev,
      },
    ],
  })
  setTestControlPlaneRuntimeContext(ctx)
  return ctx
}

describe('MCP gate advance_task durable pin bump', () => {
  beforeEach(() => {
    resetMcpControlPlaneDeps()
    resetControlPlaneRuntimeContextForTests()
    setProductLifecycleV3StorageFactory(null)
    seedPinRuntime(0, 5)
  })

  afterEach(() => {
    setProductLifecycleV3StorageFactory(null)
    resetMcpControlPlaneDeps()
    resetControlPlaneRuntimeContextForTests()
  })

  it('one successful advance_task: board+lifecycle +1; response equals pin re-read; replay no second bump', async () => {
    // boardRev 0: memory revision store board map starts at 0 (aligned with first CAS).
    const boardRev = 0
    const lifecycleRev = 5
    const ctx = seedPinRuntime(boardRev, lifecycleRev)

    const impl = run({ runId: 'run-impl', role: 'implementer' })
    const task = baseTask(null, boardRev, lifecycleRev)
    const receipt = makeReceipt('MAPPING', {}, boardRev, lifecycleRev)

    const v3Store = createMemoryLifecycleV3Storage({
      pin: {
        boardId: BOARD,
        boardRev,
        lifecycleRev,
        canonicalSnapshotId: SNAP,
        canonicalHash: CANON,
      },
      tasks: [task],
      runs: [impl],
    })
    setProductLifecycleV3StorageFactory(() => v3Store)

    const envelope = {
      entityExpectedRev: 0,
      expectedBoardRev: boardRev,
      subjectHash: CANON,
      canonicalHash: CANON,
      idempotencyKey: 'adv-pin-once-1',
    }

    // Omit taskId so classification UNCLASSIFIED gate does not fire (Packet A pin only).
    const body = await runMutationGate(
      {
        toolName: 'advance_task',
        boardId: BOARD,
        actorId: 'root-pin-test',
        entityType: 'task',
        entityId: TASK,
        requestBody: {
          ...envelope,
          id: TASK,
          toStage: 'MAPPING',
          byRunId: 'run-impl',
          expectedLifecycleRev: lifecycleRev,
          expectedTaskHash: TASK_HASH,
          receipt: { receiptId: receipt.receiptId, receiptHash: receipt.receiptHash },
        },
        skipPinHashCheck: true,
      },
      async () => {
        await v3Store.putStageEvidence({
          boardId: BOARD,
          taskId: TASK,
          toStage: 'MAPPING',
          receipt,
          emittingRunId: 'run-impl',
          registeredAt: receipt.issuedAt,
        })
        const result = await advanceTaskV3(v3Store, {
          boardId: BOARD,
          taskId: TASK,
          toStage: 'MAPPING',
          byRunId: 'run-impl',
          entityExpectedRev: 0,
          expectedBoardRev: boardRev,
          expectedLifecycleRev: lifecycleRev,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON,
          receipt,
        })
        return toLegacyAdvanceCompatibilityResponse(result)
      },
    )

    expect(body.ok).toBe(true)
    expect(body.boardRev).toBe(boardRev + 1)
    expect(body.lifecycleRev).toBe(lifecycleRev + 1)
    expect(body.pin.boardRev).toBe(boardRev + 1)
    expect(body.pin.lifecycleRev).toBe(lifecycleRev + 1)

    const durable = await ctx.atomic.getBoardPinRevs!(BOARD)
    expect(durable).toEqual({ boardRev: boardRev + 1, lifecycleRev: lifecycleRev + 1 })
    // Response pin == durable re-read tuple
    expect({ boardRev: body.boardRev, lifecycleRev: body.lifecycleRev }).toEqual(durable)
    expect({ boardRev: body.pin.boardRev, lifecycleRev: body.pin.lifecycleRev }).toEqual(durable)

    // Idempotent replay: same key/body → no second bump
    const replay = await runMutationGate(
      {
        toolName: 'advance_task',
        boardId: BOARD,
        actorId: 'root-pin-test',
        entityType: 'task',
        entityId: TASK,
        requestBody: {
          ...envelope,
          id: TASK,
          toStage: 'MAPPING',
          byRunId: 'run-impl',
          expectedLifecycleRev: lifecycleRev,
          expectedTaskHash: TASK_HASH,
          receipt: { receiptId: receipt.receiptId, receiptHash: receipt.receiptHash },
        },
        skipPinHashCheck: true,
      },
      async (): Promise<typeof body> => {
        throw new Error('mutate must not re-run on REPLAY')
      },
    )
    expect(replay.replayed).toBe(true)
    expect(replay.boardRev).toBe(boardRev + 1)
    expect(replay.lifecycleRev).toBe(lifecycleRev + 1)
    expect(await ctx.atomic.getBoardPinRevs!(BOARD)).toEqual({
      boardRev: boardRev + 1,
      lifecycleRev: lifecycleRev + 1,
    })
  })

  it('non-lifecycle gate mutation bumps board only (lifecycle frozen)', async () => {
    const ctx = seedPinRuntime(0, 5)
    const before = await ctx.atomic.getBoardPinRevs!(BOARD)
    expect(before).toEqual({ boardRev: 0, lifecycleRev: 5 })

    await runMutationGate(
      {
        toolName: 'upsert_run',
        boardId: BOARD,
        actorId: 'root-pin-test',
        entityType: 'run',
        entityId: 'run-x',
        requestBody: {
          entityExpectedRev: 0,
          expectedBoardRev: 0,
          subjectHash: CANON,
          canonicalHash: CANON,
          idempotencyKey: 'non-life-bump-1',
        },
        skipPinHashCheck: true,
      },
      async () => ({ ok: true as const }),
    )

    const after = await ctx.atomic.getBoardPinRevs!(BOARD)
    expect(after.boardRev).toBe(1)
    expect(after.lifecycleRev).toBe(5) // frozen for non-advance
  })

  it('stale board loser reports current pin (board + lifecycle)', async () => {
    const ctx = seedPinRuntime(4, 6)

    await expect(
      runMutationGate(
        {
          toolName: 'advance_task',
          boardId: BOARD,
          actorId: 'root-pin-test',
          entityType: 'task',
          entityId: TASK,
          // no taskId → skip classification; fail on board CAS only
          requestBody: {
            entityExpectedRev: 0,
            expectedBoardRev: 3, // stale
            subjectHash: CANON,
            canonicalHash: CANON,
            idempotencyKey: 'stale-loser-1',
          },
          skipPinHashCheck: true,
        },
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({
      code: 'STALE_REVISION',
      details: expect.objectContaining({
        currentBoardRev: 4,
        currentLifecycleRev: 6,
      }),
    })
    // No bump on stale
    expect(await ctx.atomic.getBoardPinRevs!(BOARD)).toEqual({ boardRev: 4, lifecycleRev: 6 })
  })
})

describe('import snapshot preserves lifecycle_rev (collision boundary)', () => {
  it('production seedBoardRevision SQL omits lifecycle_rev from ON DUPLICATE UPDATE', () => {
    // Static contract: column exists; reseed must not rewrite lifecycle pin.
    // (Memory SQL mock overwrites full row on long INSERT; real SQL UPDATE list is authority.)
    const src = seedBoardRevision.toString()
    expect(src).toMatch(/ON DUPLICATE KEY UPDATE/)
    expect(src).toMatch(/board_rev=VALUES\(board_rev\)/)
    expect(src).not.toMatch(/lifecycle_rev=VALUES\(lifecycle_rev\)/)
  })

  it('first seed writes lifecycle_rev; durable import state carries it', async () => {
    const mem = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(mem)
    const sql = (mem.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
    expect(sql).toBeTruthy()

    await seedBoardRevision(sql!, {
      boardId: BOARD,
      boardRev: 1,
      lifecycleRev: 9,
      subjectHash: CANON,
      canonicalSnapshotId: SNAP,
      canonicalHash: CANON,
    })
    const mid = await mem.controlData.imports.getBoardState(BOARD)
    expect(mid!.lifecycleRev).toBe(9)
    expect(mid!.boardRev).toBe(1)

    resetControlPlaneRuntimeContextForTests()
  })
})

describe('ControlPlaneAtomicError typing for dual CAS', () => {
  it('is constructible for STALE_REVISION pin details', () => {
    const err = new ControlPlaneAtomicError('STALE_REVISION', 'stale', {
      currentBoardRev: 2,
      currentLifecycleRev: 3,
    })
    expect(err).toBeInstanceOf(ControlPlaneAtomicError)
    expect(err.details.currentLifecycleRev).toBe(3)
  })

  it('McpMutationError still used for gate STALE', () => {
    const err = new McpMutationError('STALE_REVISION', 'board rev mismatch', {
      currentBoardRev: 2,
      currentLifecycleRev: 3,
    })
    expect(err.code).toBe('STALE_REVISION')
  })
})
