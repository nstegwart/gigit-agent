/**
 * HTTP lifecycle V3 wiring: advanceTaskHttp / advanceTaskFn product path.
 * Covers positive MAPPING advance + negative gates (envelope, skip, stale, self-verify,
 * unregistered, fenced, missing evidence). Auth boundary (requireAdminWrite) is not
 * exercised here — CSRF/auth remain on createServerFn + csrfServerCall.
 *
 * Advance accepts only registered receiptId+receiptHash (program-emitted registry).
 * Tests pre-register real stage receipts — never construct caller-promoted bodies.
 */
import { afterEach, describe, expect, it } from 'vitest'

import { advanceTaskHttp } from '#/server/board'
import {
  McpMutationError,
  setProductLifecycleV3StorageFactory,
  submitStageEvidenceProduct,
} from '#/server/board-mcp'
import {
  createMemoryLifecycleV3Storage,
  type RegisteredRun,
  type TaskLifecycleV3State,
} from '#/server/lifecycle-store'
import type { LifecycleStageKey } from '#/lib/control-plane-types'

const BOARD = 'board-http-life-v3'
const CANON = 'c'.repeat(64)
const SNAP = 'snap-http-life-v3'
const TASK_HASH = 'task-hash-http-1'
const TASK = 'task-http-life-v3-1'

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

function makeRun(over: Partial<RegisteredRun> & Pick<RegisteredRun, 'runId' | 'role'>): RegisteredRun {
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

function installMemoryProductStore(
  task: TaskLifecycleV3State,
  runs: Array<RegisteredRun>,
  boardRev = 1,
  lifecycleRev = 1,
) {
  const store = createMemoryLifecycleV3Storage({
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
  setProductLifecycleV3StorageFactory(() => store)
  return store
}

/** Program-emit stage evidence via product path (immutable registry) — required before advance. */
async function registerStageEvidence(
  stage: LifecycleStageKey,
  byRunId: string,
  fields: Record<string, unknown> = {},
  opts: {
    receiptId?: string
    authorRunId?: string | null
    verifierRunId?: string | null
    verdict?: string | null
    boardRev?: number
    lifecycleRev?: number
  } = {},
) {
  return submitStageEvidenceProduct(BOARD, {
    taskId: TASK,
    toStage: stage,
    byRunId,
    fields,
    taskHash: TASK_HASH,
    canonicalHash: CANON,
    boardRev: opts.boardRev ?? 1,
    lifecycleRev: opts.lifecycleRev ?? 1,
    receiptId: opts.receiptId ?? `rcpt-${stage}`,
    authorRunId: opts.authorRunId ?? null,
    verifierRunId: opts.verifierRunId ?? null,
    verdict: opts.verdict ?? null,
    now: '2026-07-13T10:00:00.000Z',
  })
}

function fullEnvelope(over: Record<string, unknown> = {}) {
  return {
    boardId: BOARD,
    taskId: TASK,
    entityExpectedRev: 0,
    expectedBoardRev: 1,
    expectedLifecycleRev: 1,
    expectedTaskHash: TASK_HASH,
    canonicalHash: CANON,
    idempotencyKey: 'idem-http-default',
    ...over,
  }
}

describe('HTTP LIFECYCLE V3 (advanceTaskHttp → advanceTaskProduct → advanceTaskV3)', () => {
  afterEach(() => {
    setProductLifecycleV3StorageFactory(null)
  })

  it('positive: advances MAPPING and returns V3 compatibility alias', async () => {
    const author = makeRun({ runId: 'run-author', role: 'implementer' })
    installMemoryProductStore(baseTask(null), [author])
    const registered = await registerStageEvidence('MAPPING', author.runId)
    const result = await advanceTaskHttp({
      ...fullEnvelope({ idempotencyKey: 'idem-http-mapping' }),
      toStage: 'MAPPING',
      byRunId: author.runId,
      receipt: {
        receiptId: registered.receipt.receiptId,
        receiptHash: registered.receipt.receiptHash,
      },
    })
    expect(result.ok).toBe(true)
    expect(result.engine).toBe('advanceTaskV3')
    expect(result.stage).toBe('MAPPING')
    expect(result.fromStage).toBeNull()
    expect(result.rev).toBe(1)
    expect(result.boardRev).toBe(2)
    expect(result.lifecycleRev).toBe(2)
    expect(result.readback.stage).toBe('MAPPING')
    expect(result.pin.canonicalHash).toBe(CANON)
    expect(result.receipt.receiptId).toBe(registered.receipt.receiptId)
  })

  it('negative: missing envelope fields → INVALID_INPUT (no silent rev default)', async () => {
    const author = makeRun({ runId: 'run-author', role: 'implementer' })
    installMemoryProductStore(baseTask(null), [author])
    await expect(
      advanceTaskHttp({
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPING',
        byRunId: author.runId,
        // no entityExpectedRev / expectedBoardRev / canonicalHash / idempotencyKey
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT', name: 'McpMutationError' })
  })

  it('negative: rejects stage skip (no legacy advanceTask path)', async () => {
    const author = makeRun({ runId: 'run-author', role: 'implementer' })
    installMemoryProductStore(baseTask(null), [author])
    const registered = await registerStageEvidence('MAPPED', author.runId, {
      mappingStructuralReceipt: 'x',
    })
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({ idempotencyKey: 'idem-http-skip' }),
        toStage: 'MAPPED',
        byRunId: author.runId,
        receipt: {
          receiptId: registered.receipt.receiptId,
          receiptHash: registered.receipt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })
  })

  it('negative: stale entity rev → STALE_REVISION', async () => {
    const author = makeRun({ runId: 'run-a', role: 'implementer' })
    installMemoryProductStore(
      {
        ...baseTask('MAPPED'),
        entityRev: 1,
        implementerRunId: 'run-a',
        implementerAgentId: 'same',
        implementerModel: 'm1',
        implementerThreadId: 't1',
      },
      [author],
    )
    const registered = await registerStageEvidence(
      'MAP_VERIFIED',
      author.runId,
      { mappingReceipt: 'm', verifierVerdict: 'PASS' },
      { authorRunId: 'run-a', verifierRunId: 'run-v', verdict: 'PASS' },
    )
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({
          entityExpectedRev: 99,
          idempotencyKey: 'idem-http-stale',
        }),
        toStage: 'MAP_VERIFIED',
        byRunId: author.runId,
        receipt: {
          receiptId: registered.receipt.receiptId,
          receiptHash: registered.receipt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('negative: self-verification → SELF_VERIFICATION', async () => {
    const author = makeRun({
      runId: 'run-a',
      role: 'implementer',
      agentId: 'same',
      model: 'm1',
      threadId: 't1',
    })
    installMemoryProductStore(
      {
        ...baseTask('MAPPED'),
        entityRev: 1,
        implementerRunId: 'run-a',
        implementerAgentId: 'same',
        implementerModel: 'm1',
        implementerThreadId: 't1',
      },
      [author],
    )
    const registered = await registerStageEvidence(
      'MAP_VERIFIED',
      author.runId,
      { mappingReceipt: 'm', verifierVerdict: 'PASS' },
      { authorRunId: 'run-a', verifierRunId: 'run-a', verdict: 'PASS' },
    )
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({
          entityExpectedRev: 1,
          idempotencyKey: 'idem-http-self',
        }),
        toStage: 'MAP_VERIFIED',
        byRunId: author.runId,
        receipt: {
          receiptId: registered.receipt.receiptId,
          receiptHash: registered.receipt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'SELF_VERIFICATION' })
  })

  it('negative: unregistered run → RUN_NOT_REGISTERED', async () => {
    const author = makeRun({ runId: 'run-a', role: 'implementer' })
    installMemoryProductStore({ ...baseTask('MAPPING'), entityRev: 1 }, [author])
    // Register evidence under the real author, but advance with a never-registered byRunId
    const registered = await registerStageEvidence('MAPPED', author.runId, {
      mappingStructuralReceipt: 'ms',
    })
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({
          entityExpectedRev: 1,
          idempotencyKey: 'idem-http-unreg',
        }),
        toStage: 'MAPPED',
        byRunId: 'never-registered',
        receipt: {
          receiptId: registered.receipt.receiptId,
          receiptHash: registered.receipt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' })
  })

  it('negative: fenced author → FENCED', async () => {
    const fenced = makeRun({ runId: 'run-fenced', role: 'implementer', fenced: true })
    installMemoryProductStore(baseTask(null), [fenced])
    // Pre-register would also FENCE at submit; advance path still FENCED when receipt
    // was somehow registered then run fenced — use skip-register style: put via store
    // is not used; submit itself rejects FENCED. Seed receipt via put for advance-only fence.
    const store = installMemoryProductStore(baseTask(null), [fenced])
    // Direct put bypasses emit gate so advance can observe FENCED on author run
    const { computeStageReceiptHash } = await import('#/server/lifecycle-store')
    const partial = {
      receiptId: 'rcpt-MAPPING',
      programmatic: true as const,
      taskHash: TASK_HASH,
      canonicalHash: CANON,
      boardRev: 1,
      lifecycleRev: 1,
      fields: {},
      authorRunId: null as string | null,
      verifierRunId: null as string | null,
      verdict: null as string | null,
      issuedAt: '2026-07-13T10:00:00.000Z',
    }
    const rcpt = { ...partial, receiptHash: computeStageReceiptHash(partial) }
    await store.putStageEvidence({
      boardId: BOARD,
      taskId: TASK,
      toStage: 'MAPPING',
      receipt: rcpt,
      emittingRunId: fenced.runId,
      registeredAt: rcpt.issuedAt,
    })
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({ idempotencyKey: 'idem-http-fence' }),
        toStage: 'MAPPING',
        byRunId: fenced.runId,
        receipt: {
          receiptId: rcpt.receiptId,
          receiptHash: rcpt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
  })

  it('negative: missing stage evidence → MISSING_EVIDENCE', async () => {
    const author = makeRun({ runId: 'run-a', role: 'implementer' })
    installMemoryProductStore({ ...baseTask('MAPPING'), entityRev: 1 }, [author])
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({
          entityExpectedRev: 1,
          idempotencyKey: 'idem-http-missing-ev',
        }),
        toStage: 'MAPPED',
        byRunId: author.runId,
        receipt: {
          receiptId: 'never-registered-rcpt',
          receiptHash: 'a'.repeat(64),
        },
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('negative: hand-typed programmatic:false evidence is rejected', async () => {
    const author = makeRun({ runId: 'run-a', role: 'implementer' })
    const store = installMemoryProductStore({ ...baseTask('MAPPING'), entityRev: 1 }, [author])
    const { computeStageReceiptHash } = await import('#/server/lifecycle-store')
    const partial = {
      receiptId: 'rcpt-handtyped',
      programmatic: false as const,
      taskHash: TASK_HASH,
      canonicalHash: CANON,
      boardRev: 1,
      lifecycleRev: 1,
      fields: { mappingStructuralReceipt: 'ms' },
      authorRunId: null as string | null,
      verifierRunId: null as string | null,
      verdict: null as string | null,
      issuedAt: '2026-07-13T10:00:00.000Z',
    }
    const rcpt = { ...partial, receiptHash: computeStageReceiptHash(partial) }
    // putStageEvidence may accept body; advance must still reject non-programmatic registry
    try {
      await store.putStageEvidence({
        boardId: BOARD,
        taskId: TASK,
        toStage: 'MAPPED',
        receipt: rcpt,
        emittingRunId: author.runId,
        registeredAt: rcpt.issuedAt,
      })
    } catch {
      // if store rejects non-programmatic at put, advance with fake id still MISSING_EVIDENCE
    }
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({
          entityExpectedRev: 1,
          idempotencyKey: 'idem-http-handtyped',
        }),
        toStage: 'MAPPED',
        byRunId: author.runId,
        receipt: {
          receiptId: rcpt.receiptId,
          receiptHash: rcpt.receiptHash,
        },
      }),
    ).rejects.toMatchObject({ code: 'MISSING_EVIDENCE' })
  })

  it('negative: unknown stage → UNKNOWN_STAGE / McpMutationError', async () => {
    const author = makeRun({ runId: 'run-a', role: 'implementer' })
    installMemoryProductStore(baseTask(null), [author])
    await expect(
      advanceTaskHttp({
        ...fullEnvelope({ idempotencyKey: 'idem-http-unknown' }),
        toStage: 'NOT_A_V3_STAGE',
        byRunId: author.runId,
      }),
    ).rejects.toBeInstanceOf(McpMutationError)
  })
})
