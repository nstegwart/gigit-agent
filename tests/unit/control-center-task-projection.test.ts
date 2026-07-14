/**
 * C3-R1A: light-task classification projection + adapter mapping.
 * Proves valid receipts survive list path; invalid/missing stay fail-closed.
 * Support evidence only (LOCAL ONLY).
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { ClassificationReceipt } from '#/lib/control-plane-types'
import type { WorkTask } from '#/lib/types'
import {
  buildControlCenterAggregationFromSources,
  mapTaskClassification,
  mapWorkTaskToControlCenterInput,
} from '#/server/control-center-ui-adapter'
import { projectWork, type ControlCenterPin } from '#/server/control-center-ui'
import {
  lightFromRow,
  projectLightTaskClassification,
  taskV3ToWorkTask,
  type TaskV3Record,
} from '#/server/tasks-store'
import { assignBucket } from '#/server/rollup-v3'

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'cc-mfs-test',
  canonicalHash: 'hash_aaaaaaaaaaaaaaaa',
  taskHash: 'taskhash_bbbbbbbbbbbb',
  boardRev: 1,
  lifecycleRev: 0,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 0,
  stale: false,
  staleReason: null,
}

function boardTaskHash(ids: string[]): string {
  return createHash('sha256')
    .update([...ids].sort().join('|') || 'empty-tasks')
    .digest('hex')
}

function makeReceipt(
  taskId: string,
  pin: Pick<
    ControlCenterPin,
    'canonicalSnapshotId' | 'canonicalHash' | 'taskHash' | 'boardRev' | 'lifecycleRev'
  >,
  overrides: Partial<ClassificationReceipt> = {},
): ClassificationReceipt {
  return {
    receiptId: `rcp-${taskId}`,
    receiptHash: 'abcdef0123456789abcdef01',
    taskId,
    taskClass: 'PRODUCT',
    disposition: 'ACTIVE',
    membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
    membershipProofHash: 'abcdef0123456789ccccdddd',
    membershipProductLine: 'sales-rebuild',
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function bareTask(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Task ${id}`,
    dependencies: [],
    impacts: [],
    checkpoints: [],
    ...extra,
  }
}

const SAMPLE_RECEIPT = makeReceipt('task-classified-ok', PIN)

describe('projectLightTaskClassification / lightFromRow', () => {
  it('projects data.classification JSON extract (C3-V1 failing case)', () => {
    const projected = projectLightTaskClassification({
      dataClassification: {
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        receipt: SAMPLE_RECEIPT,
      },
    })
    expect(projected.taskClass).toBe('PRODUCT')
    expect(projected.disposition).toBe('ACTIVE')
    expect(projected.classificationReceipt?.receiptId).toBe('rcp-task-classified-ok')
    expect(projected.classification?.receipt?.receiptHash).toBe(SAMPLE_RECEIPT.receiptHash)
  })

  it('lightFromRow attaches classification from data_* extract columns', () => {
    const row = lightFromRow({
      id: 'task-classified-ok',
      title: 'Classified OK',
      project_id: 'p1',
      feature_contract_id: null,
      grp: null,
      phase: 'build',
      scope: null,
      updated: '2026-07-13',
      lifecycle_stage: 'BUILT',
      blocked_reason: null,
      last_receipt_at: null,
      summary: {
        checkpoints: [],
        dependencies: [],
        impacts: [],
        // intentionally NO classification in summary — only in data extract
      },
      data_classification: JSON.stringify({
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        receipt: SAMPLE_RECEIPT,
      }),
    })
    const cls = mapTaskClassification(row, PIN)
    expect(cls.taskClass).toBe('PRODUCT')
    expect(cls.disposition).toBe('ACTIVE')
    expect(cls.receipt?.receiptId).toBe('rcp-task-classified-ok')
  })

  it('missing classification → adapter UNCLASSIFIED (no PRODUCT from phase/pct)', () => {
    const row = lightFromRow({
      id: 'task-missing-proof',
      title: 'No proof',
      summary: {
        checkpoints: [],
        mappingPct: 100,
        status: 'done',
      },
      phase: 'PROD_READY',
      data_classification: null,
    })
    const cls = mapTaskClassification(row, PIN)
    expect(cls.taskClass).toBe('UNCLASSIFIED')
    expect(cls.disposition).toBe('UNCLASSIFIED')
    expect(cls.receipt).toBeNull()
  })

  it('summary-stored classification also projects', () => {
    const holdReceipt = makeReceipt('t-sum', PIN, {
      taskClass: 'CONTROL_PLANE',
      disposition: 'HOLD',
    })
    const row = lightFromRow({
      id: 't-sum',
      title: 'From summary',
      summary: {
        checkpoints: [],
        dependencies: [],
        impacts: [],
        classification: {
          taskClass: 'CONTROL_PLANE',
          disposition: 'HOLD',
          receipt: holdReceipt,
        },
      },
    })
    const cls = mapTaskClassification(row, PIN)
    expect(cls.taskClass).toBe('CONTROL_PLANE')
    expect(cls.disposition).toBe('HOLD')
  })
})

describe('valid vs invalid classification projection through aggregation', () => {
  const raw = {
    id: 'mfs-rebuild',
    name: 'MFS',
    projects: [{ id: 'p1', nama: 'P1' }],
    features: [{ id: 'f1', nama: 'F1', projectId: 'p1', fase: 'build', checklist: [] }],
    runs: [],
    decisions: [],
    log: [],
    collab: { comments: {}, activity: [] },
  } as never

  it('valid current receipt reaches adapter and is not forced DATA_INTEGRITY alone', () => {
    const ok = bareTask('task-classified-ok') as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    ok.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt: SAMPLE_RECEIPT,
    }
    const input = mapWorkTaskToControlCenterInput(ok, PIN)
    expect(input.classification.taskClass).toBe('PRODUCT')
    expect(input.classification.receipt?.receiptId).toBe('rcp-task-classified-ok')

    const assignment = assignBucket(
      {
        taskId: ok.id,
        classification: input.classification,
        lifecycleStage: 'BUILT',
        productStageMode: 'STAGE_2',
      },
      {
        canonicalSnapshotId: PIN.canonicalSnapshotId,
        canonicalHash: PIN.canonicalHash,
        taskHash: PIN.taskHash,
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
      },
      '2026-07-13T12:00:00.000Z',
    )
    expect(assignment.blockReason).not.toBe('DATA_INTEGRITY')
    expect(assignment.primary).not.toBeNull()
  })

  it('missing / invalid / UNCLASSIFIED / bad HOLD stay fail-closed once as DATA_INTEGRITY', () => {
    const missing = bareTask('t-missing')
    const unclassified = bareTask('t-unclass') as WorkTask & {
      classification: { taskClass: 'UNCLASSIFIED'; disposition: 'UNCLASSIFIED'; receipt: null }
    }
    unclassified.classification = {
      taskClass: 'UNCLASSIFIED',
      disposition: 'UNCLASSIFIED',
      receipt: null,
    }
    const badHold = bareTask('t-bad-hold') as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'HOLD'
        receipt: ClassificationReceipt
      }
    }
    badHold.classification = {
      taskClass: 'PRODUCT',
      disposition: 'HOLD',
      receipt: makeReceipt('t-bad-hold', PIN, {
        disposition: 'HOLD',
        boardRev: 999, // stale vs pin
      }),
    }
    const conflicting = bareTask('t-conflict') as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    conflicting.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt: makeReceipt('t-conflict', PIN, {
        taskId: 't-other', // RECEIPT_TASK_MISMATCH
      }),
    }

    const tasks = [missing, unclassified, badHold, conflicting]
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks,
      opsAccounts: [],
      runs: [],
      boardContentHash: PIN.canonicalHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      now: PIN.generatedAt,
    })

    // All four fail closed into BLOCKED (repair) — each task once
    expect(agg.rollup.buckets.BLOCKED).toBe(4)
    const workBlocked = projectWork(agg, { bucket: 'BLOCKED' })
    const ids = workBlocked.data.items.map((i) => i.taskId)
    expect(new Set(ids).size).toBe(ids.length)
    for (const id of ['t-missing', 't-unclass', 't-bad-hold', 't-conflict']) {
      expect(ids).toContain(id)
      expect(agg.assignmentsByTaskId.get(id)?.blockReason).toBe('DATA_INTEGRITY')
    }
    // Board-level DATA_INTEGRITY section note only when ZERO tasks carry class+disposition+receipt objects.
    // Here badHold/conflict still carry receipt objects (invalid at rollup) so section note may be absent;
    // per-task blockReason above is the fail-closed contract.
    const onlyMissing = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [missing, unclassified],
      opsAccounts: [],
      runs: [],
      boardContentHash: PIN.canonicalHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      now: PIN.generatedAt,
    })
    expect(onlyMissing.sectionErrors.some((e) => e.code === 'DATA_INTEGRITY')).toBe(true)
  })

  it('mixed board: valid light-projected receipt survives; missing still integrity-blocked; no static phase readiness', () => {
    const okId = 'task-classified-ok'
    const missId = 'task-no-proof'
    // Aggregation recomputes pin.taskHash from sorted task ids — receipts must bind to that.
    const computedTaskHash = boardTaskHash([okId, missId])
    const pinFields = {
      canonicalSnapshotId: `cc-mfs-rebuild-${PIN.canonicalHash.slice(0, 16)}`,
      // buildControlCenterAggregationFromSources uses boardContentHash as canonicalHash
      canonicalHash: 'contenthash_mixed_board_01',
      taskHash: computedTaskHash,
      boardRev: 1,
      lifecycleRev: 0,
    }
    // But wait — pin.canonicalSnapshotId is `cc-${boardId}-${hash.slice(0,16)}`
    const boardContentHash = 'contenthash_mixed_board_01'
    const expectedPin = {
      canonicalSnapshotId: `cc-mfs-rebuild-${boardContentHash.slice(0, 16)}`,
      canonicalHash: boardContentHash,
      taskHash: computedTaskHash,
      boardRev: 1,
      lifecycleRev: 0,
    }

    const okLight = lightFromRow({
      id: okId,
      title: 'Classified OK',
      phase: 'todo',
      summary: { checkpoints: [], dependencies: [], impacts: [], mappingPct: 0 },
      data_classification: {
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        receipt: makeReceipt(okId, expectedPin),
      },
    })
    const missing = bareTask(missId, {
      phase: 'PROD_READY',
      mappingPct: 100,
      status: 'done',
    })

    const okCls = mapTaskClassification(okLight, expectedPin)
    expect(okCls.taskClass).toBe('PRODUCT')
    expect(okCls.receipt?.receiptId).toBe(`rcp-${okId}`)

    const missCls = mapTaskClassification(missing, expectedPin)
    expect(missCls.taskClass).toBe('UNCLASSIFIED')

    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [okLight, missing],
      opsAccounts: [],
      runs: [],
      boardContentHash,
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })

    expect(agg.pin.taskHash).toBe(computedTaskHash)
    expect(agg.pin.canonicalHash).toBe(boardContentHash)

    const okAssign = agg.assignmentsByTaskId.get(okId)
    const missAssign = agg.assignmentsByTaskId.get(missId)
    expect(okAssign?.blockReason).not.toBe('DATA_INTEGRITY')
    expect(okAssign?.primary).not.toBeNull()
    expect(missAssign?.primary).toBe('BLOCKED')
    expect(missAssign?.blockReason).toBe('DATA_INTEGRITY')

    // Board has at least one valid classified task → no blanket DATA_INTEGRITY section note
    expect(agg.sectionErrors.some((e) => e.code === 'DATA_INTEGRITY')).toBe(false)
    // phase/pct on missing must not promote to PRODUCT readiness
    const missInput = mapWorkTaskToControlCenterInput(missing, { ...PIN, ...expectedPin })
    expect(missInput.eligible).toBe(false)
    expect(missInput.priorityMembership).toBe(false)

    void pinFields
  })
})

describe('taskV3ToWorkTask preserves classification', () => {
  it('forwards V3 receipt onto list WorkTask shape', () => {
    const rec: TaskV3Record = {
      boardId: 'mfs-rebuild',
      taskId: 'task-classified-ok',
      title: 'OK',
      projectId: null,
      featureContractId: null,
      phase: null,
      scope: null,
      mappingPct: null,
      status: null,
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      classificationReceiptId: SAMPLE_RECEIPT.receiptId,
      classificationReceiptHash: SAMPLE_RECEIPT.receiptHash,
      classificationReceipt: SAMPLE_RECEIPT,
      boardRev: 1,
      lifecycleRev: 0,
      entityRev: 1,
      subjectHash: 'subj',
      taskHash: PIN.taskHash,
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      evidenceMeta: null,
      lifecycleStage: 'BUILT',
      createdAt: PIN.generatedAt,
      updatedAt: PIN.generatedAt,
      fenced: false,
    }
    const wt = taskV3ToWorkTask(rec)
    const cls = mapTaskClassification(wt, PIN)
    expect(cls.taskClass).toBe('PRODUCT')
    expect(cls.receipt?.receiptId).toBe('rcp-task-classified-ok')
  })
})
