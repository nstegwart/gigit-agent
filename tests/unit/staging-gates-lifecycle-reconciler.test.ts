/**
 * Staging gate lifecycle negatives + one valid MAPPING evidence + reconciler
 * dry-run/apply idempotency against product engines (memory stores).
 * LOCAL ONLY — no staging mutation.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'
import {
  advanceTaskV3,
  computeStageReceiptHash,
  createMemoryLifecycleV3Storage,
  submitStageEvidence,
  type RegisteredRun,
  type StageReceipt,
  type TaskLifecycleV3State,
} from '#/server/lifecycle-store'
import {
  applyReconcile,
  claimReconcilerLeadership,
  createMemoryReconcilerStore,
  dryRunReconcile,
  type ReconcilerDeps,
} from '#/server/reconciler'
import {
  createMemoryRunRegistryStore,
  registerRun,
  type RunRegistryDeps,
  type RegisterRunCapacity,
} from '#/server/run-registry'
import type { LifecycleStageKey } from '#/lib/control-plane-types'

const __dirname = dirname(fileURLToPath(import.meta.url))
const GATES = join(__dirname, '../../qa/fixtures/staging/gates')

function readJson<T>(rel: string): T {
  return JSON.parse(readFileSync(join(GATES, rel), 'utf8')) as T
}

const BOARD = 'mfs-rebuild'
const CANON = 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab'
const SNAP = 'synth-gate-snap-001'
const TASK_HASH = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08'
const BOARD_REV = 7
const LIFE_REV = 3

function makeReceipt(
  stage: LifecycleStageKey,
  fields: Record<string, unknown>,
  opts: {
    authorRunId?: string | null
    verifierRunId?: string | null
    programmatic?: boolean
    receiptId?: string
    verdict?: string | null
  } = {},
): StageReceipt {
  const partial = {
    receiptId: opts.receiptId ?? `synth-gate-rcpt-${stage}`,
    programmatic: opts.programmatic ?? true,
    taskHash: TASK_HASH,
    canonicalHash: CANON,
    boardRev: BOARD_REV,
    lifecycleRev: LIFE_REV,
    fields,
    authorRunId: opts.authorRunId ?? null,
    verifierRunId: opts.verifierRunId ?? null,
    verdict: opts.verdict ?? null,
    issuedAt: '2026-07-13T10:00:00.000Z',
  }
  return { ...partial, receiptHash: computeStageReceiptHash(partial) }
}

function baseTask(over: Partial<TaskLifecycleV3State> = {}): TaskLifecycleV3State {
  return {
    taskId: 'synth-gate-life-neg-1',
    stage: 'MAPPING',
    entityRev: 1,
    boardRev: BOARD_REV,
    lifecycleRev: LIFE_REV,
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
    ...over,
  }
}

function run(
  over: Partial<RegisteredRun> & Pick<RegisteredRun, 'runId' | 'role'>,
): RegisteredRun {
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

function storageFor(task: TaskLifecycleV3State, runs: RegisteredRun[]) {
  return createMemoryLifecycleV3Storage({
    pin: {
      boardId: BOARD,
      boardRev: BOARD_REV,
      lifecycleRev: LIFE_REV,
      canonicalSnapshotId: SNAP,
      canonicalHash: CANON,
    },
    tasks: [task],
    runs,
  })
}

async function advanceWithEvidence(
  store: ReturnType<typeof storageFor>,
  inp: Parameters<typeof advanceTaskV3>[1],
) {
  await store.putStageEvidence({
    boardId: inp.boardId,
    taskId: inp.taskId,
    toStage: inp.toStage,
    receipt: inp.receipt,
    emittingRunId: inp.byRunId,
    registeredAt: inp.receipt.issuedAt,
  })
  return advanceTaskV3(store, inp)
}

describe('lifecycle mapping valid + negatives from gate fixtures', () => {
  it('fixture declares valid MAPPING + skip/stale/self-verify/fence negatives', () => {
    const valid = readJson<{ expect: { toStage: string; ok: boolean } }>(
      'lifecycle/mapping-valid.json',
    )
    expect(valid.expect.toStage).toBe('MAPPING')
    expect(valid.expect.ok).toBe(true)

    const neg = readJson<{ cases: Array<{ id: string; kind: string; expectErrorCode: string }> }>(
      'lifecycle/negatives.json',
    )
    const kinds = new Set(neg.cases.map((c) => c.kind))
    expect(kinds.has('skip')).toBe(true)
    expect(kinds.has('stale')).toBe(true)
    expect(kinds.has('self-verify')).toBe(true)
    expect(kinds.has('fence')).toBe(true)
    expect(neg.cases.some((c) => c.expectErrorCode === 'INVALID_TRANSITION')).toBe(true)
    expect(neg.cases.some((c) => c.expectErrorCode === 'STALE_REVISION')).toBe(true)
    expect(neg.cases.some((c) => c.expectErrorCode === 'SELF_VERIFICATION')).toBe(true)
    expect(neg.cases.some((c) => c.expectErrorCode === 'FENCED')).toBe(true)
  })

  it('valid MAPPING evidence via submitStageEvidence + advanceTaskV3', async () => {
    const fixture = readJson<{
      task: { taskId: string }
      authorRun: { runId: string }
      evidence: { fields: Record<string, unknown> }
    }>('lifecycle/mapping-valid.json')

    const author = run({ runId: fixture.authorRun.runId, role: 'implementer' })
    const task = baseTask({
      taskId: fixture.task.taskId,
      stage: null,
      entityRev: 0,
    })
    const store = storageFor(task, [author])

    const submitted = await submitStageEvidence(store, {
      boardId: BOARD,
      taskId: fixture.task.taskId,
      toStage: 'MAPPING',
      byRunId: author.runId,
      fields: fixture.evidence.fields,
      taskHash: TASK_HASH,
      canonicalHash: CANON,
      boardRev: BOARD_REV,
      lifecycleRev: LIFE_REV,
      entityExpectedRev: 0,
      now: '2026-07-13T10:00:00.000Z',
    })
    expect(submitted.receipt.programmatic).toBe(true)

    const advanced = await advanceTaskV3(store, {
      boardId: BOARD,
      taskId: fixture.task.taskId,
      toStage: 'MAPPING',
      byRunId: author.runId,
      entityExpectedRev: 0,
      expectedBoardRev: BOARD_REV,
      expectedLifecycleRev: LIFE_REV,
      expectedTaskHash: TASK_HASH,
      expectedCanonicalHash: CANON,
      receipt: submitted.receipt,
      now: '2026-07-13T10:00:00.000Z',
    })
    expect(advanced.stage).toBe('MAPPING')
  })

  it('skip stage → INVALID_TRANSITION', async () => {
    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-skip', role: 'implementer' }),
    ])
    const receipt = makeReceipt('BUILT', {
      implementationReceipt: 'impl-1',
      intendedChangedPaths: ['x.ts'],
    })
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: 'BUILT',
        byRunId: 'r-skip',
        entityExpectedRev: 1,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('stale board rev → STALE_REVISION', async () => {
    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-stale', role: 'implementer' }),
    ])
    const receipt = makeReceipt('MAPPED', { mappingStructuralReceipt: 'map-struct-1' })
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: 'MAPPED',
        byRunId: 'r-stale',
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('stale_lifecycle_rev → STALE_REVISION (fixture-bound)', async () => {
    const neg = readJson<{
      cases: Array<{
        id: string
        toStage: string
        expectedLifecycleRev?: number
        expectErrorCode: string
      }>
    }>('lifecycle/negatives.json')
    const c = neg.cases.find((x) => x.id === 'stale_lifecycle_rev')
    expect(c?.expectErrorCode).toBe('STALE_REVISION')
    expect(c?.expectedLifecycleRev).toBe(1)

    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-stale-life', role: 'implementer' }),
    ])
    const receipt = makeReceipt('MAPPED', { mappingStructuralReceipt: 'map-struct-1' })
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: (c!.toStage as 'MAPPED'),
        byRunId: 'r-stale-life',
        entityExpectedRev: 1,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: c!.expectedLifecycleRev!,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('stale_entity_rev → STALE_REVISION (fixture-bound)', async () => {
    const neg = readJson<{
      cases: Array<{
        id: string
        toStage: string
        entityExpectedRev?: number
        expectErrorCode: string
      }>
    }>('lifecycle/negatives.json')
    const c = neg.cases.find((x) => x.id === 'stale_entity_rev')
    expect(c?.expectErrorCode).toBe('STALE_REVISION')
    expect(c?.entityExpectedRev).toBe(99)

    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-stale-ent', role: 'implementer' }),
    ])
    const receipt = makeReceipt('MAPPED', { mappingStructuralReceipt: 'map-struct-1' })
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: (c!.toStage as 'MAPPED'),
        byRunId: 'r-stale-ent',
        entityExpectedRev: c!.entityExpectedRev!,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('missing_evidence_fields → MISSING_EVIDENCE (fixture-bound)', async () => {
    const neg = readJson<{
      cases: Array<{
        id: string
        toStage: string
        fields?: Record<string, unknown>
        expectErrorCode: string
      }>
    }>('lifecycle/negatives.json')
    const c = neg.cases.find((x) => x.id === 'missing_evidence_fields')
    expect(c?.expectErrorCode).toBe('MISSING_EVIDENCE')
    expect(c?.fields).toEqual({})

    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-miss-fields', role: 'implementer' }),
    ])
    const receipt = makeReceipt('MAPPED', c!.fields ?? {})
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: (c!.toStage as 'MAPPED'),
        byRunId: 'r-miss-fields',
        entityExpectedRev: 1,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('self-verify → SELF_VERIFICATION', async () => {
    const author = run({
      runId: 'run-same',
      role: 'implementer',
      agentId: 'same',
      model: 'm1',
      threadId: 't1',
    })
    const task = {
      ...baseTask({ stage: 'MAPPED', entityRev: 2 }),
      implementerRunId: 'run-same',
      implementerAgentId: 'same',
      implementerModel: 'm1',
      implementerThreadId: 't1',
    }
    const store = storageFor(task, [author])
    const receipt = makeReceipt(
      'MAP_VERIFIED',
      { mappingReceipt: 'map-1', verifierVerdict: 'PASS' },
      {
        authorRunId: 'run-same',
        verifierRunId: 'run-same',
        verdict: 'PASS',
      },
    )
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: task.taskId,
        toStage: 'MAP_VERIFIED',
        byRunId: 'run-same',
        entityExpectedRev: 2,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'SELF_VERIFICATION' })
  })

  it('fenced run → FENCED on submitStageEvidence', async () => {
    const fenced = run({
      runId: 'run-fenced',
      role: 'implementer',
      fenced: true,
    })
    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [fenced])
    await expect(
      submitStageEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: 'MAPPED',
        byRunId: 'run-fenced',
        fields: { mappingStructuralReceipt: 'x' },
        taskHash: TASK_HASH,
        canonicalHash: CANON,
        boardRev: BOARD_REV,
        lifecycleRev: LIFE_REV,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
  })

  it('hand-typed non-programmatic → MISSING_EVIDENCE', async () => {
    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [
      run({ runId: 'r-hand', role: 'implementer' }),
    ])
    const receipt = makeReceipt(
      'MAPPED',
      { mappingStructuralReceipt: 'map-struct-1' },
      { programmatic: false },
    )
    await expect(
      advanceWithEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: 'MAPPED',
        byRunId: 'r-hand',
        entityExpectedRev: 1,
        expectedBoardRev: BOARD_REV,
        expectedLifecycleRev: LIFE_REV,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON,
        receipt,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('unregistered run → RUN_NOT_REGISTERED', async () => {
    const unreg = run({
      runId: 'run-unreg',
      role: 'implementer',
      registered: false,
    })
    const store = storageFor(baseTask({ stage: 'MAPPING', entityRev: 1 }), [unreg])
    await expect(
      submitStageEvidence(store, {
        boardId: BOARD,
        taskId: 'synth-gate-life-neg-1',
        toStage: 'MAPPED',
        byRunId: 'run-unreg',
        fields: { mappingStructuralReceipt: 'x' },
        taskHash: TASK_HASH,
        canonicalHash: CANON,
        boardRev: BOARD_REV,
        lifecycleRev: LIFE_REV,
        now: '2026-07-13T10:00:00.000Z',
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' })
  })
})

describe('reconciler dry-run/apply idempotency from gate fixture', () => {
  function openCapacity(): NonNullable<RegisterRunCapacity> {
    return {
      dispatchMode: 'OPEN',
      dispatchAllowed: true,
      usableCapacity: 100,
      nonGrokAssignmentAllowed: true,
      grokAssignmentAllowed: true,
      limitingReasons: [],
      // M2: dispatchAllowed requires complete family remainings (fail closed without these).
      sparkUsableCapacity: 10,
      solUsableCapacity: 10,
      otherUsableCapacity: 10,
      healthyGrokUsableCapacity: 70,
      failSafeActions: [],
    }
  }

  function harness(startMs = Date.parse('2026-07-13T10:00:00.000Z')) {
    const clock = createFakeClock(startMs)
    const locks = createMemoryLockStore()
    const runs = createMemoryRunRegistryStore()
    const atomic = createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ])
    const idempotency = createMemoryIdempotencyStorage()
    const reconciler = createMemoryReconcilerStore()
    const runDeps: RunRegistryDeps = {
      clock,
      runs,
      locks,
      atomic,
      idempotency,
      getCapacity: async () => openCapacity(),
    }
    const recDeps: ReconcilerDeps = {
      clock,
      runs,
      locks,
      reconciler,
      atomic,
      idempotency,
    }
    return { clock, runDeps, recDeps }
  }

  it('fixture documents maxActions=100 + idempotent re-apply + negative codes', () => {
    const fixture = readJson<{
      scenarios: Array<{
        id: string
        expect?: {
          maxActions: number
          applySecondIdempotentReplay: boolean
          wrongHashCode?: string
          notLeaderCode?: string
        }
      }>
    }>('reconciler/dry-run-apply.json')
    const s = fixture.scenarios.find((x) => x.id === 'dry_run_apply_idempotent')
    expect(s?.expect?.maxActions).toBe(100)
    expect(s?.expect?.applySecondIdempotentReplay).toBe(true)
    expect(s?.expect?.wrongHashCode).toBe('DRY_RUN_HASH_MISMATCH')
    expect(s?.expect?.notLeaderCode).toBe('NOT_LEADER')
  })

  it('dry-run → apply → re-apply idempotent (memory harness)', async () => {
    const h = harness()
    await registerRun(h.runDeps, {
      canonicalHash: 'canon-run',
      boardId: BOARD,
      runId: 'synth-gate-run-orphan-1',
      taskId: 'synth-gate-recon-task-1',
      targetGate: 'FUNCTIONAL',
      agentId: 'synth-gate-agent-rec',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'synth-gate-reg-rec',
      initialState: 'RUNNING',
    })
    h.clock.advance(60_000 + 30_000 + 1)

    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
    })
    const dry = await dryRunReconcile(h.recDeps, {
      entityExpectedRev: 0,
      canonicalHash: 'canon-run',
      idempotencyKey: 'synth-gate-dry-1',
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
      fencingToken: leader.fencingToken,
      expectedBoardRev: 0,
      maxActions: 100,
    })
    expect(dry.dryRunHash).toBeTruthy()
    expect(dry.maxActions).toBe(100)

    const apply1 = await applyReconcile(h.recDeps, {
      entityExpectedRev: 0,
      canonicalHash: 'canon-run',
      idempotencyKey: 'synth-gate-apply-1',
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
      fencingToken: leader.fencingToken,
      dryRunHash: dry.dryRunHash,
      expectedBoardRev: 0,
    })
    expect(apply1.applied).toBe(true)
    expect(apply1.idempotentReplay).toBe(false)

    const apply2 = await applyReconcile(h.recDeps, {
      entityExpectedRev: 0,
      canonicalHash: 'canon-run',
      idempotencyKey: 'synth-gate-apply-2',
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
      fencingToken: leader.fencingToken,
      dryRunHash: dry.dryRunHash,
      expectedBoardRev: apply1.boardRev,
    })
    expect(apply2.idempotentReplay).toBe(true)
  })

  it('wrong dryRunHash → DRY_RUN_HASH_MISMATCH (fixture-bound)', async () => {
    const fixture = readJson<{
      scenarios: Array<{
        id: string
        expect?: { wrongHashCode?: string }
      }>
    }>('reconciler/dry-run-apply.json')
    const s = fixture.scenarios.find((x) => x.id === 'dry_run_apply_idempotent')
    expect(s?.expect?.wrongHashCode).toBe('DRY_RUN_HASH_MISMATCH')

    const h = harness()
    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
    })
    const dry = await dryRunReconcile(h.recDeps, {
      entityExpectedRev: 0,
      canonicalHash: 'canon-run',
      idempotencyKey: 'synth-gate-dry-wronghash',
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
      fencingToken: leader.fencingToken,
      expectedBoardRev: 0,
      maxActions: 100,
    })
    await expect(
      applyReconcile(h.recDeps, {
        entityExpectedRev: 0,
        canonicalHash: 'canon-run',
        idempotencyKey: 'synth-gate-apply-wronghash',
        boardId: BOARD,
        leaderId: 'synth-gate-reconciler-leader',
        fencingToken: leader.fencingToken,
        dryRunHash: `deadbeef${dry.dryRunHash.slice(8)}`,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'DRY_RUN_HASH_MISMATCH' })
  })

  it('not leader fencing → NOT_LEADER (fixture-bound)', async () => {
    const fixture = readJson<{
      scenarios: Array<{
        id: string
        expect?: { notLeaderCode?: string }
      }>
    }>('reconciler/dry-run-apply.json')
    const s = fixture.scenarios.find((x) => x.id === 'dry_run_apply_idempotent')
    expect(s?.expect?.notLeaderCode).toBe('NOT_LEADER')

    const h = harness()
    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'synth-gate-reconciler-leader',
    })
    await expect(
      dryRunReconcile(h.recDeps, {
        entityExpectedRev: 0,
        canonicalHash: 'canon-run',
        idempotencyKey: 'synth-gate-dry-notleader',
        boardId: BOARD,
        leaderId: 'synth-gate-reconciler-leader',
        fencingToken: 'wrong-fence-token',
        expectedBoardRev: 0,
        maxActions: 100,
      }),
    ).rejects.toMatchObject({ code: 'NOT_LEADER' })

    // Second claim while first lease holds
    h.clock.advance(1)
    await expect(
      claimReconcilerLeadership(h.recDeps, {
        boardId: BOARD,
        leaderId: 'synth-gate-reconciler-leader-2',
      }),
    ).rejects.toMatchObject({ code: 'NOT_LEADER' })
    expect(leader.fencingToken).toBeTruthy()
  })
})
