import { describe, expect, it } from 'vitest'

import {
  advanceTaskV3,
  buildLifecycleReadback,
  computeStageReceiptHash,
  createMemoryLifecycleV3Storage,
  evaluateLifecycleEnumMapping,
  planLifecycleEnumMigration,
  LifecycleV3Error,
  LIFECYCLE_MAPPING_TYPES,
  V3_IDENTITY_LIFECYCLE_CONFIG,
  V3_LIFECYCLE_RAIL,
  type LifecycleMappingRow,
  type RegisteredRun,
  type StageReceipt,
  type TaskLifecycleV3State,
} from '#/server/lifecycle-store'
import {
  computeTaskHash,
  createMemoryTaskV3Store,
  legacyTaskToV3Defaults,
  taskV3ToWorkTask,
  upsertTaskV3,
  TaskV3Error,
} from '#/server/tasks-store'
import type { LifecycleStageKey } from '#/lib/control-plane-types'
import type { WorkTask } from '#/lib/types'

const BOARD = 'mfs-rebuild'
const TASK = 'task-1'
const CANON = 'canon-hash-aaa'
const SNAP = 'snap-v3-1'
const TASK_HASH = 'task-hash-bbb'

function baseTask(stage: LifecycleStageKey | null = null): TaskLifecycleV3State {
  return {
    taskId: TASK,
    stage,
    entityRev: 0,
    boardRev: 1,
    lifecycleRev: 1,
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
  opts: {
    authorRunId?: string | null
    verifierRunId?: string | null
    verdict?: string | null
    boardRev?: number
    lifecycleRev?: number
    taskHash?: string
    canonicalHash?: string
    programmatic?: boolean
    receiptId?: string
  } = {},
): StageReceipt {
  const partial = {
    receiptId: opts.receiptId ?? `rcpt-${stage}`,
    programmatic: opts.programmatic ?? true,
    taskHash: opts.taskHash ?? TASK_HASH,
    canonicalHash: opts.canonicalHash ?? CANON,
    boardRev: opts.boardRev ?? 1,
    lifecycleRev: opts.lifecycleRev ?? 1,
    fields,
    authorRunId: opts.authorRunId ?? null,
    verifierRunId: opts.verifierRunId ?? null,
    verdict: opts.verdict ?? null,
    issuedAt: '2026-07-13T10:00:00.000Z',
  }
  return {
    ...partial,
    receiptHash: computeStageReceiptHash(partial),
  }
}

function storageFor(
  task: TaskLifecycleV3State,
  runs: Array<RegisteredRun>,
  boardRev = 1,
  lifecycleRev = 1,
) {
  return createMemoryLifecycleV3Storage({
    pin: {
      boardId: BOARD,
      boardRev,
      lifecycleRev,
      canonicalSnapshotId: SNAP,
      canonicalHash: CANON,
    },
    tasks: [task],
    runs,
  })
}

const STAGE_FIELDS: Record<LifecycleStageKey, Record<string, unknown>> = {
  MAPPING: {},
  MAPPED: { mappingStructuralReceipt: 'map-struct-1' },
  MAP_VERIFIED: { mappingReceipt: 'map-1', verifierVerdict: 'PASS' },
  BUILT: {
    implementationReceipt: 'impl-1',
    intendedChangedPaths: ['src/server/lifecycle-store.ts'],
  },
  FUNCTIONAL: {
    runtimePositive: 'pos',
    runtimeNegative: 'neg',
    runtimeRegression: 'reg',
    verifierVerdict: 'PASS',
  },
  INTEGRATED: {
    integrateReceipt: 'int-1',
    repo: 'gigit-project-orchestration',
    trackingBranch: 'main',
    fullSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    shortSha: 'e04b7e6',
    pathspecs: ['src/server/lifecycle-store.ts'],
    push: 'OK',
  },
  STAGING_PROVEN: {
    stagingApi: 'ok',
    stagingUi: 'ok',
    stagingDb: 'ok',
    stagingReadback: 'ok',
    deployedSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    verifierVerdict: 'PASS',
  },
  PROD_READY: { g5EvidenceComplete: true, verifierVerdict: 'PASS' },
  LIVE_VERIFIED: {
    productionApprovalId: 'owner-prod-appr-1',
    deployReceipt: 'deploy-1',
    liveReadback: 'live-ok',
    verifierVerdict: 'PASS',
  },
}

const VERIFIER_STAGES = new Set<LifecycleStageKey>([
  'MAP_VERIFIED',
  'FUNCTIONAL',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
])

describe('V3 lifecycle rail identity + legacy compatibility', () => {
  it('exposes identity-mapped nine-stage rail matching live enum', () => {
    expect([...V3_LIFECYCLE_RAIL]).toEqual([
      'MAPPING',
      'MAPPED',
      'MAP_VERIFIED',
      'BUILT',
      'FUNCTIONAL',
      'INTEGRATED',
      'STAGING_PROVEN',
      'PROD_READY',
      'LIVE_VERIFIED',
    ])
    expect(V3_IDENTITY_LIFECYCLE_CONFIG.allowSkip).toBe(false)
    expect(V3_IDENTITY_LIFECYCLE_CONFIG.stages.map((s) => s.key)).toEqual([...V3_LIFECYCLE_RAIL])
  })
})

describe('V3 ordered stage receipts — full rail advance', () => {
  it('advances through every ordered stage with exact receipts', async () => {
    let task = baseTask(null)
    const author = run({ runId: 'run-author', role: 'implementer', agentId: 'agent-a', model: 'grok-4.5', threadId: 'th-a' })
    const verifier = run({
      runId: 'run-verifier',
      role: 'verifier',
      agentId: 'agent-v',
      model: 'claude-opus',
      threadId: 'th-v',
    })
    // role-specific verifiers
    const mappingVerifier = run({
      runId: 'run-map-v',
      role: 'mapping-verifier',
      agentId: 'agent-mv',
      model: 'claude-opus',
      threadId: 'th-mv',
    })
    const funcVerifier = run({
      runId: 'run-func-v',
      role: 'functional-verifier',
      agentId: 'agent-fv',
      model: 'claude-opus',
      threadId: 'th-fv',
    })
    const stagingVerifier = run({
      runId: 'run-stg-v',
      role: 'staging-verifier',
      agentId: 'agent-sv',
      model: 'claude-opus',
      threadId: 'th-sv',
    })
    const prodVerifier = run({
      runId: 'run-prod-v',
      role: 'product-readiness-verifier',
      agentId: 'agent-pv',
      model: 'claude-opus',
      threadId: 'th-pv',
    })
    const liveVerifier = run({
      runId: 'run-live-v',
      role: 'live-verifier',
      agentId: 'agent-lv',
      model: 'claude-opus',
      threadId: 'th-lv',
    })

    let boardRev = 1
    let lifecycleRev = 1
    let entityRev = 0

    const runs = [
      author,
      verifier,
      mappingVerifier,
      funcVerifier,
      stagingVerifier,
      prodVerifier,
      liveVerifier,
    ]

    for (const stage of V3_LIFECYCLE_RAIL) {
      const store = storageFor(task, runs, boardRev, lifecycleRev)
      const isVer = VERIFIER_STAGES.has(stage)
      const byRunId = isVer
        ? stage === 'MAP_VERIFIED'
          ? mappingVerifier.runId
          : stage === 'FUNCTIONAL'
            ? funcVerifier.runId
            : stage === 'STAGING_PROVEN'
              ? stagingVerifier.runId
              : stage === 'PROD_READY'
                ? prodVerifier.runId
                : liveVerifier.runId
        : author.runId

      const receipt = makeReceipt(stage, STAGE_FIELDS[stage], {
        boardRev,
        lifecycleRev,
        authorRunId: author.runId,
        verifierRunId: isVer ? byRunId : null,
        verdict: isVer ? 'PASS' : null,
      })

      const result = await advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: stage,
        byRunId,
        entityExpectedRev: entityRev,
        expectedBoardRev: boardRev,
        expectedLifecycleRev: lifecycleRev,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        productionApprovalId: stage === 'LIVE_VERIFIED' ? 'owner-prod-appr-1' : null,
        now: '2026-07-13T12:00:00.000Z',
      })

      expect(result.ok).toBe(true)
      expect(result.stage).toBe(stage)
      expect(result.pin.canonicalSnapshotId).toBe(SNAP)
      expect(result.pin.canonicalHash).toBe(CANON)
      expect(result.pin.taskHash).toBe(TASK_HASH)
      expect(result.readback.boardRev).toBe(boardRev + 1)
      expect(result.readback.lifecycleRev).toBe(lifecycleRev + 1)

      boardRev = result.boardRev
      lifecycleRev = result.lifecycleRev
      entityRev = result.entityRev
      task = (await store.getTask(BOARD, TASK))!
    }

    expect(task.stage).toBe('LIVE_VERIFIED')
    expect(task.history).toHaveLength(9)
    expect(Object.keys(task.stageReceipts).sort()).toHaveLength(9)
  })
})

describe('V3 transition rejections', () => {
  it('rejects stage skip when allowSkip=false', async () => {
    const store = storageFor(baseTask(null), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPED', STAGE_FIELDS.MAPPED)
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED', // skips MAPPING
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('rejects stale entity rev', async () => {
    const store = storageFor(baseTask('MAPPING'), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPED', STAGE_FIELDS.MAPPED)
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED',
        byRunId: 'r1',
        entityExpectedRev: 99,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('rejects stale board rev', async () => {
    const store = storageFor(baseTask('MAPPING'), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPED', STAGE_FIELDS.MAPPED)
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('rejects stale task/canonical hash', async () => {
    const store = storageFor(baseTask('MAPPING'), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPED', STAGE_FIELDS.MAPPED, { taskHash: 'wrong' })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: 'wrong',
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_HASH' })
  })

  it('rejects missing stage evidence', async () => {
    const store = storageFor(baseTask('MAPPING'), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPED', {}) // missing mappingStructuralReceipt
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('rejects self-verification', async () => {
    const author = run({ runId: 'run-a', role: 'implementer', agentId: 'same', model: 'm1', threadId: 't1' })
    const task = {
      ...baseTask('MAPPED'),
      implementerRunId: 'run-a',
      implementerAgentId: 'same',
      implementerModel: 'm1',
      implementerThreadId: 't1',
      entityRev: 1,
    }
    const store = storageFor(task, [author], 1, 1)
    const receipt = makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
      authorRunId: 'run-a',
      verifierRunId: 'run-a',
      verdict: 'PASS',
    })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAP_VERIFIED',
        byRunId: 'run-a',
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'SELF_VERIFICATION' })
  })

  it('rejects invalid verifier role', async () => {
    const author = run({ runId: 'run-a', role: 'implementer', agentId: 'a', model: 'm1', threadId: 't1' })
    const badVerifier = run({
      runId: 'run-v',
      role: 'implementer', // wrong
      agentId: 'b',
      model: 'm2',
      threadId: 't2',
    })
    const task = {
      ...baseTask('MAPPED'),
      implementerRunId: 'run-a',
      implementerAgentId: 'a',
      implementerModel: 'm1',
      implementerThreadId: 't1',
      entityRev: 1,
    }
    const store = storageFor(task, [author, badVerifier])
    const receipt = makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
      authorRunId: 'run-a',
      verifierRunId: 'run-v',
      verdict: 'PASS',
    })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAP_VERIFIED',
        byRunId: 'run-v',
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_VERIFIER_ROLE' })
  })

  it('rejects same-model pairing when opposite model required', async () => {
    const author = run({ runId: 'run-a', role: 'implementer', agentId: 'a', model: 'same-model', threadId: 't1' })
    const verifier = run({
      runId: 'run-v',
      role: 'mapping-verifier',
      agentId: 'b',
      model: 'same-model',
      threadId: 't2',
    })
    const task = {
      ...baseTask('MAPPED'),
      implementerRunId: 'run-a',
      implementerAgentId: 'a',
      implementerModel: 'same-model',
      implementerThreadId: 't1',
      entityRev: 1,
    }
    const store = storageFor(task, [author, verifier])
    const receipt = makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
      authorRunId: 'run-a',
      verifierRunId: 'run-v',
      verdict: 'PASS',
    })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAP_VERIFIED',
        byRunId: 'run-v',
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        requireOppositeModel: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_MODEL_PAIRING' })
  })

  it('rejects same thread as author', async () => {
    const author = run({ runId: 'run-a', role: 'implementer', agentId: 'a', model: 'm1', threadId: 'shared' })
    const verifier = run({
      runId: 'run-v',
      role: 'mapping-verifier',
      agentId: 'b',
      model: 'm2',
      threadId: 'shared',
    })
    const task = {
      ...baseTask('MAPPED'),
      implementerRunId: 'run-a',
      implementerAgentId: 'a',
      implementerModel: 'm1',
      implementerThreadId: 'shared',
      entityRev: 1,
    }
    const store = storageFor(task, [author, verifier])
    const receipt = makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
      authorRunId: 'run-a',
      verifierRunId: 'run-v',
      verdict: 'PASS',
    })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAP_VERIFIED',
        byRunId: 'run-v',
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_THREAD' })
  })

  it('rejects unregistered run', async () => {
    const store = storageFor(baseTask(null), [
      run({ runId: 'r1', role: 'implementer', registered: false }),
    ])
    const receipt = makeReceipt('MAPPING', {})
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' })
  })

  it('rejects expired run lease', async () => {
    const store = storageFor(baseTask(null), [
      run({ runId: 'r1', role: 'implementer', expiresAt: '2020-01-01T00:00:00.000Z' }),
    ])
    const receipt = makeReceipt('MAPPING', {})
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
  })

  it('rejects fenced run', async () => {
    const store = storageFor(baseTask(null), [
      run({ runId: 'r1', role: 'implementer', fenced: true }),
    ])
    const receipt = makeReceipt('MAPPING', {})
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
  })

  it('LIVE_VERIFIED requires owner productionApprovalId', async () => {
    const author = run({ runId: 'run-a', role: 'implementer', agentId: 'a', model: 'm1', threadId: 't1' })
    const liveV = run({
      runId: 'run-lv',
      role: 'live-verifier',
      agentId: 'lv',
      model: 'm2',
      threadId: 't2',
    })
    const task = {
      ...baseTask('PROD_READY'),
      implementerRunId: 'run-a',
      implementerAgentId: 'a',
      implementerModel: 'm1',
      implementerThreadId: 't1',
      entityRev: 8,
    }
    const store = storageFor(task, [author, liveV])
    const fields = { ...STAGE_FIELDS.LIVE_VERIFIED }
    delete fields.productionApprovalId
    const receipt = makeReceipt('LIVE_VERIFIED', fields, {
      authorRunId: 'run-a',
      verifierRunId: 'run-lv',
      verdict: 'PASS',
    })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'LIVE_VERIFIED',
        byRunId: 'run-lv',
        entityExpectedRev: 8,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        productionApprovalId: null,
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('rejects non-programmatic hand-typed PASS', async () => {
    const store = storageFor(baseTask(null), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPING', {}, { programmatic: false })
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('rejects tampered receipt hash', async () => {
    const store = storageFor(baseTask(null), [run({ runId: 'r1', role: 'implementer' })])
    const receipt = makeReceipt('MAPPING', {})
    receipt.receiptHash = '0'.repeat(64)
    await expect(
      advanceTaskV3(store, {
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: 'r1',
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
      }),
    ).rejects.toMatchObject({ code: 'STALE_HASH' })
  })
})

describe('lifecycle readback pin binding for rollup', () => {
  it('binds canonicalSnapshotId/hash, taskHash, boardRev, lifecycleRev', () => {
    const task = {
      ...baseTask('BUILT'),
      entityRev: 4,
      boardRev: 10,
      lifecycleRev: 10,
      stageReceipts: {
        MAPPING: makeReceipt('MAPPING', {}),
        MAPPED: makeReceipt('MAPPED', STAGE_FIELDS.MAPPED),
      },
    }
    const rb = buildLifecycleReadback(task, SNAP, CANON)
    expect(rb).toMatchObject({
      taskId: TASK,
      stage: 'BUILT',
      canonicalSnapshotId: SNAP,
      canonicalHash: CANON,
      taskHash: TASK_HASH,
      boardRev: 10,
      lifecycleRev: 10,
      entityRev: 4,
    })
    expect(rb.stageReceiptIds.length).toBe(2)
  })
})

describe('tasks-store V3 integration — classification + concurrency (no real DB)', () => {
  const actor = {
    runId: 'run-task-1',
    registered: true,
    fenced: false,
    expiresAt: '2099-01-01T00:00:00.000Z',
  }

  it('creates task as UNCLASSIFIED without guessing PRODUCT from phase/pct', async () => {
    const store = createMemoryTaskV3Store({
      board: {
        boardId: BOARD,
        boardRev: 1,
        lifecycleRev: 1,
        canonicalSnapshotId: SNAP,
        canonicalHash: CANON,
      },
    })
    const wt: WorkTask = {
      id: 't-new',
      title: 'Legacy-looking',
      phase: 'PRODUCT',
      scope: 'ACTIVE',
      mappingPct: 100,
      status: 'done',
      checkpoints: [],
      dependencies: [],
      impacts: [],
    }
    // defaults never promote
    const defaults = legacyTaskToV3Defaults(BOARD, wt, store.board())
    expect(defaults.taskClass).toBe('UNCLASSIFIED')
    expect(defaults.disposition).toBe('UNCLASSIFIED')

    const result = await upsertTaskV3(store, {
      boardId: BOARD,
      task: wt,
      expectedBoardRev: 1,
      expectedLifecycleRev: 1,
      actor,
      now: '2026-07-13T12:00:00.000Z',
    })
    expect(result.created).toBe(true)
    expect(result.record.taskClass).toBe('UNCLASSIFIED')
    expect(result.record.disposition).toBe('UNCLASSIFIED')
    expect(result.pin.boardRev).toBe(2)
    expect(result.pin.lifecycleRev).toBe(1)
    // legacy list shape still works
    const light = taskV3ToWorkTask(result.record)
    expect(light.id).toBe('t-new')
    expect(light.title).toBe('Legacy-looking')
  })

  it('optimistic concurrency rejects stale entity rev', async () => {
    const store = createMemoryTaskV3Store({
      board: {
        boardId: BOARD,
        boardRev: 1,
        lifecycleRev: 1,
        canonicalSnapshotId: SNAP,
        canonicalHash: CANON,
      },
    })
    await upsertTaskV3(store, {
      boardId: BOARD,
      task: { id: 't-1', title: 'A' },
      expectedBoardRev: 1,
      expectedLifecycleRev: 1,
      actor,
    })
    await expect(
      upsertTaskV3(store, {
        boardId: BOARD,
        task: { id: 't-1', title: 'B' },
        entityExpectedRev: 0, // stale — should be 1
        expectedBoardRev: 2,
        expectedLifecycleRev: 1,
        actor,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('rejects fenced / expired / unregistered actors', async () => {
    const store = createMemoryTaskV3Store({
      board: {
        boardId: BOARD,
        boardRev: 1,
        lifecycleRev: 1,
        canonicalSnapshotId: null,
        canonicalHash: null,
      },
    })
    await expect(
      upsertTaskV3(store, {
        boardId: BOARD,
        task: { id: 't-1', title: 'A' },
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        actor: { ...actor, fenced: true },
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })

    await expect(
      upsertTaskV3(store, {
        boardId: BOARD,
        task: { id: 't-1', title: 'A' },
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        actor: { ...actor, registered: false },
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' })

    await expect(
      upsertTaskV3(store, {
        boardId: BOARD,
        task: { id: 't-1', title: 'A' },
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        actor: { ...actor, expiresAt: '2000-01-01T00:00:00.000Z' },
        now: '2026-07-13T00:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })
  })

  it('rejects PRODUCT classification without valid receipt', async () => {
    const store = createMemoryTaskV3Store({
      board: {
        boardId: BOARD,
        boardRev: 1,
        lifecycleRev: 1,
        canonicalSnapshotId: SNAP,
        canonicalHash: CANON,
      },
    })
    await expect(
      upsertTaskV3(store, {
        boardId: BOARD,
        task: { id: 't-1', title: 'A' },
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        actor,
        classification: {
          taskClass: 'PRODUCT',
          disposition: 'ACTIVE',
          receipt: null,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_CLASSIFICATION' })
  })

  it('computeTaskHash is deterministic', () => {
    const a = computeTaskHash({ id: 't', title: 'x', projectId: 'p' })
    const b = computeTaskHash({ id: 't', title: 'x', projectId: 'p' })
    expect(a).toBe(b)
  })
})

describe('LifecycleV3Error is typed', () => {
  it('exposes code', () => {
    const e = new LifecycleV3Error('INVALID_TRANSITION', 'x')
    expect(e.code).toBe('INVALID_TRANSITION')
    expect(e).toBeInstanceOf(Error)
  })
  it('TaskV3Error exposes code', () => {
    const e = new TaskV3Error('STALE_REVISION', 'x')
    expect(e.code).toBe('STALE_REVISION')
  })
})

describe('AC-LIFE-02 lifecycle enum mapping pre-migration guard (no DB)', () => {
  const identityNine: Array<LifecycleMappingRow> = [
    'MAPPING',
    'MAPPED',
    'MAP_VERIFIED',
    'BUILT',
    'FUNCTIONAL',
    'INTEGRATED',
    'STAGING_PROVEN',
    'PROD_READY',
    'LIVE_VERIFIED',
  ].map((live) => ({
    live,
    canonical: live,
    type: 'IDENTITY' as const,
  }))

  it('exports exact mapping type enum', () => {
    expect([...LIFECYCLE_MAPPING_TYPES]).toEqual([
      'IDENTITY',
      'RENAME',
      'SPLIT',
      'MERGE',
      'LEGACY_ONLY',
      'UNMAPPED',
    ])
  })

  it('IDENTITY rows yield deterministic approved plan (preserve, no rewrite)', () => {
    const result = evaluateLifecycleEnumMapping({
      schemaVersion: 'LIFECYCLE_MAPPING_V1',
      boardId: BOARD,
      mapping: identityNine,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.approved).toBe(true)
    expect(result.blockingDecisionRequired).toBe(false)
    expect(result.decisionCode).toBeNull()
    expect(result.identityCount).toBe(9)
    expect(result.renameCount).toBe(0)
    expect(result.legacyOnlyCount).toBe(0)
    expect(result.steps.map((s) => s.live)).toEqual(identityNine.map((r) => r.live))
    for (const step of result.steps) {
      expect(step.type).toBe('IDENTITY')
      expect(step.action).toBe('PRESERVE')
      expect(step.canonical).toBe(step.live)
    }
  })

  it('RENAME rows yield approved dual-write plan (no ad-hoc rewrite)', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'REVIEW', canonical: 'FUNCTIONAL', type: 'RENAME' },
      { live: 'DONE', canonical: 'PROD_READY', type: 'RENAME' },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.renameCount).toBe(2)
    expect(result.steps[0]).toMatchObject({
      live: 'REVIEW',
      canonical: 'FUNCTIONAL',
      type: 'RENAME',
      action: 'RENAME_DUAL_WRITE',
    })
    expect(result.steps[0].migration).toMatch(/dual-write|explicit rename/i)
  })

  it('LEGACY_ONLY rows yield approved retain plan (no ad-hoc invent)', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'PARKED_LEGACY', type: 'LEGACY_ONLY', canonical: null },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.legacyOnlyCount).toBe(1)
    expect(result.steps[0]).toMatchObject({
      live: 'PARKED_LEGACY',
      type: 'LEGACY_ONLY',
      action: 'RETAIN_LEGACY_ONLY',
      canonical: null,
    })
  })

  it('SPLIT fails closed with DECISION_LIFECYCLE_SPLIT + exact state ids', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'DOING', canonical: null, type: 'SPLIT', ambiguity: 'maps to BUILT|FUNCTIONAL' },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.approved).toBe(false)
    expect(result.blockingDecisionRequired).toBe(true)
    expect(result.decisionCode).toBe('DECISION_LIFECYCLE_SPLIT')
    expect(result.ambiguousStateIds).toEqual(['DOING'])
    expect(result.blockingRows[0].type).toBe('SPLIT')
  })

  it('MERGE fails closed with DECISION_LIFECYCLE_MERGE + exact state ids', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'BUILT_A', type: 'MERGE', ambiguity: 'collapses with BUILT_B' },
      { live: 'BUILT_B', type: 'MERGE', ambiguity: 'collapses with BUILT_A' },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.decisionCode).toBe('DECISION_LIFECYCLE_MERGE')
    expect(result.ambiguousStateIds).toEqual(['BUILT_A', 'BUILT_B'])
    expect(result.blockingRows.map((r) => r.live)).toEqual(['BUILT_A', 'BUILT_B'])
  })

  it('UNMAPPED fails closed with DECISION_LIFECYCLE_UNMAPPED', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'MYSTERY', type: 'UNMAPPED' },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.decisionCode).toBe('DECISION_LIFECYCLE_UNMAPPED')
    expect(result.ambiguousStateIds).toEqual(['MYSTERY'])
  })

  it('mixed SPLIT+UNMAPPED uses aggregate DECISION_LIFECYCLE_MAPPING_AMBIGUITY', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'A', type: 'IDENTITY', canonical: 'A' },
      { live: 'B', type: 'SPLIT' },
      { live: 'C', type: 'UNMAPPED' },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.decisionCode).toBe('DECISION_LIFECYCLE_MAPPING_AMBIGUITY')
    expect(result.ambiguousStateIds).toEqual(['B', 'C'])
    // source order retained on blockingRows
    expect(result.blockingRows.map((r) => r.live)).toEqual(['B', 'C'])
  })

  it('preserves source ordering in approved plan (no reorder rewrite)', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'Z_LAST', type: 'LEGACY_ONLY' },
      { live: 'A_FIRST', type: 'IDENTITY', canonical: 'A_FIRST' },
      { live: 'M_MID', type: 'RENAME', canonical: 'MAPPED' },
    ])
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.steps.map((s) => s.live)).toEqual(['Z_LAST', 'A_FIRST', 'M_MID'])
  })

  it('rejects duplicate live keys (malformed, fail closed)', () => {
    const result = evaluateLifecycleEnumMapping([
      { live: 'MAPPING', type: 'IDENTITY', canonical: 'MAPPING' },
      { live: 'MAPPING', type: 'RENAME', canonical: 'MAPPED' },
    ])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.decisionCode).toBe('DECISION_LIFECYCLE_MAPPING_MALFORMED')
    expect(result.reasons.some((r) => r.includes('DUPLICATE_LIVE:MAPPING'))).toBe(true)
  })

  it('rejects malformed rows / unknown types / RENAME without canonical / IDENTITY rewrite', () => {
    const empty = evaluateLifecycleEnumMapping([])
    expect(empty.ok).toBe(false)
    if (!empty.ok) {
      expect(empty.decisionCode).toBe('DECISION_LIFECYCLE_MAPPING_MALFORMED')
      expect(empty.reasons).toContain('EMPTY_OR_MISSING_MAPPING')
    }

    const badType = evaluateLifecycleEnumMapping([
      { live: 'X', type: 'NOT_A_TYPE' as 'IDENTITY' },
    ])
    expect(badType.ok).toBe(false)
    if (!badType.ok) {
      expect(badType.decisionCode).toBe('DECISION_LIFECYCLE_MAPPING_MALFORMED')
    }

    const renameNoCanon = evaluateLifecycleEnumMapping([
      { live: 'OLD', type: 'RENAME', canonical: null },
    ])
    expect(renameNoCanon.ok).toBe(false)

    // IDENTITY with different canonical would be ad-hoc rewrite → refuse
    const identityRewrite = evaluateLifecycleEnumMapping([
      { live: 'MAPPING', type: 'IDENTITY', canonical: 'MAPPED' },
    ])
    expect(identityRewrite.ok).toBe(false)
    if (!identityRewrite.ok) {
      expect(identityRewrite.reasons.some((r) => r.startsWith('IDENTITY_CANONICAL_MISMATCH'))).toBe(
        true,
      )
    }
  })

  it('planLifecycleEnumMigration is alias of evaluateLifecycleEnumMapping (no DB mutate)', () => {
    const a = evaluateLifecycleEnumMapping(identityNine)
    const b = planLifecycleEnumMigration(identityNine)
    expect(b).toEqual(a)
    expect(a.ok).toBe(true)
  })
})
