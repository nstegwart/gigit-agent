import { describe, expect, it } from 'vitest'

import type {
  ClassificationReceipt,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import {
  contributesToProductReadiness,
  evaluateClassification,
  isProductDenominatorMember,
  isTaskClass,
  isTaskDisposition,
  isTrackedWork,
} from '#/server/classification'

const PIN: PinnedRevisionTuple = {
  canonicalSnapshotId: 'snap-1',
  canonicalHash: 'canonhashaaaaaaaaaaaaaaaa',
  taskHash: 'taskhashbbbbbbbbbbbbbbbb',
  boardRev: 7,
  lifecycleRev: 3,
}

function receipt(
  taskId: string,
  taskClass: ClassificationReceipt['taskClass'],
  disposition: ClassificationReceipt['disposition'],
  overrides: Partial<ClassificationReceipt> = {},
): ClassificationReceipt {
  return {
    receiptId: `rcpt-${taskId}`,
    receiptHash: 'abcdef0123456789abcdef01',
    taskId,
    taskClass,
    disposition,
    canonicalSnapshotId: PIN.canonicalSnapshotId,
    canonicalHash: PIN.canonicalHash,
    taskHash: PIN.taskHash,
    boardRev: PIN.boardRev,
    lifecycleRev: PIN.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function record(
  taskId: string,
  taskClass: TaskClassificationRecord['taskClass'],
  disposition: TaskClassificationRecord['disposition'],
  overrides: Partial<TaskClassificationRecord> = {},
): TaskClassificationRecord {
  const { receipt: rOverride, ...rest } = overrides
  return {
    taskId,
    taskClass,
    disposition,
    receipt:
      rOverride === null
        ? null
        : receipt(taskId, taskClass, disposition, rOverride ?? undefined),
    ...rest,
  }
}

describe('AC-CLASS-01 taskClass enum', () => {
  it('accepts PRODUCT / CONTROL_PLANE / UNCLASSIFIED only', () => {
    expect(isTaskClass('PRODUCT')).toBe(true)
    expect(isTaskClass('CONTROL_PLANE')).toBe(true)
    expect(isTaskClass('UNCLASSIFIED')).toBe(true)
    expect(isTaskClass('OTHER')).toBe(false)
    expect(isTaskClass(null)).toBe(false)
  })
})

describe('AC-CLASS-02 disposition enum', () => {
  it('accepts ACTIVE / HOLD / EXCLUDE / UNCLASSIFIED only', () => {
    expect(isTaskDisposition('ACTIVE')).toBe(true)
    expect(isTaskDisposition('HOLD')).toBe(true)
    expect(isTaskDisposition('EXCLUDE')).toBe(true)
    expect(isTaskDisposition('UNCLASSIFIED')).toBe(true)
    expect(isTaskDisposition('PARKED')).toBe(false)
  })
})

describe('AC-CLASS-03 contributesToProductReadiness derived/read-only', () => {
  it('true only for PRODUCT+ACTIVE+valid receipt', () => {
    const r = record('T1', 'PRODUCT', 'ACTIVE')
    expect(contributesToProductReadiness(r, PIN)).toBe(true)
    expect(evaluateClassification(r, PIN).contributesToProductReadiness).toBe(true)
  })

  it('ignores caller-written contributesToProductReadiness=true on invalid row', () => {
    const r = record('T2', 'PRODUCT', 'HOLD', {
      contributesToProductReadiness: true,
    })
    expect(contributesToProductReadiness(r, PIN)).toBe(false)
  })

  it('ignores caller-written true when class is CONTROL_PLANE', () => {
    const r = record('T3', 'CONTROL_PLANE', 'ACTIVE', {
      contributesToProductReadiness: true,
    })
    expect(contributesToProductReadiness(r, PIN)).toBe(false)
  })

  it('false when receipt missing even if PRODUCT+ACTIVE claimed', () => {
    const r = record('T4', 'PRODUCT', 'ACTIVE', { receipt: null })
    expect(contributesToProductReadiness(r, PIN)).toBe(false)
  })
})

describe('AC-CLASS-04 UNCLASSIFIED outside productDenominator blocks complete path', () => {
  it('UNCLASSIFIED is not product member but is tracked repair', () => {
    const r = record('U1', 'UNCLASSIFIED', 'ACTIVE')
    const ev = evaluateClassification(r, PIN)
    expect(isProductDenominatorMember(ev)).toBe(false)
    expect(isTrackedWork(ev)).toBe(true)
    expect(ev.isClassificationRepair).toBe(true)
    expect(ev.blockReason).toBe('DATA_INTEGRITY')
  })
})

describe('AC-CLASS-05 cross-product precedence', () => {
  it('taskClass=UNCLASSIFIED + disposition=HOLD tracked once as DATA_INTEGRITY', () => {
    const ev = evaluateClassification(record('X1', 'UNCLASSIFIED', 'HOLD'), PIN)
    expect(ev.isClassificationRepair).toBe(true)
    expect(ev.isOutsideTrackedWork).toBe(false)
    expect(isTrackedWork(ev)).toBe(true)
    expect(ev.blockReason).toBe('DATA_INTEGRITY')
  })

  it('taskClass=UNCLASSIFIED + disposition=EXCLUDE tracked once as DATA_INTEGRITY', () => {
    const ev = evaluateClassification(record('X2', 'UNCLASSIFIED', 'EXCLUDE'), PIN)
    expect(ev.isClassificationRepair).toBe(true)
    expect(isTrackedWork(ev)).toBe(true)
    expect(ev.isOutsideTrackedWork).toBe(false)
  })

  it('PRODUCT + disposition=UNCLASSIFIED tracked once as DATA_INTEGRITY', () => {
    const ev = evaluateClassification(record('X3', 'PRODUCT', 'UNCLASSIFIED'), PIN)
    expect(ev.isClassificationRepair).toBe(true)
    expect(isTrackedWork(ev)).toBe(true)
  })

  it('CONTROL_PLANE + disposition=UNCLASSIFIED tracked once as DATA_INTEGRITY', () => {
    const ev = evaluateClassification(record('X4', 'CONTROL_PLANE', 'UNCLASSIFIED'), PIN)
    expect(ev.isClassificationRepair).toBe(true)
    expect(isTrackedWork(ev)).toBe(true)
  })

  it('HOLD with missing receipt tracked as repair, not outside work', () => {
    const ev = evaluateClassification(
      record('X5', 'PRODUCT', 'HOLD', { receipt: null }),
      PIN,
    )
    expect(ev.reasons).toContain('MISSING_RECEIPT')
    expect(ev.isOutsideTrackedWork).toBe(false)
    expect(isTrackedWork(ev)).toBe(true)
    expect(ev.blockReason).toBe('DATA_INTEGRITY')
  })

  it('EXCLUDE with stale boardRev tracked as repair', () => {
    const ev = evaluateClassification(
      record('X6', 'PRODUCT', 'EXCLUDE', {
        receipt: receipt('X6', 'PRODUCT', 'EXCLUDE', { boardRev: PIN.boardRev - 1 }),
      }),
      PIN,
    )
    expect(ev.reasons).toContain('STALE_BOARD_REV')
    expect(ev.isOutsideTrackedWork).toBe(false)
    expect(isTrackedWork(ev)).toBe(true)
  })

  it('EXCLUDE with stale lifecycleRev / hash tracked as repair', () => {
    const staleLife = evaluateClassification(
      record('X7', 'PRODUCT', 'EXCLUDE', {
        receipt: receipt('X7', 'PRODUCT', 'EXCLUDE', { lifecycleRev: 0 }),
      }),
      PIN,
    )
    expect(staleLife.reasons).toContain('STALE_LIFECYCLE_REV')
    expect(isTrackedWork(staleLife)).toBe(true)

    const staleHash = evaluateClassification(
      record('X8', 'PRODUCT', 'EXCLUDE', {
        receipt: receipt('X8', 'PRODUCT', 'EXCLUDE', {
          canonicalHash: 'stalehashcccccccccccccccc',
        }),
      }),
      PIN,
    )
    expect(staleHash.reasons).toContain('STALE_CANONICAL_HASH')
    expect(isTrackedWork(staleHash)).toBe(true)
  })

  it('only fully classified current-receipt HOLD/EXCLUDE is outside tracked work', () => {
    const hold = evaluateClassification(record('H1', 'PRODUCT', 'HOLD'), PIN)
    expect(hold.isFullyClassifiedValid).toBe(true)
    expect(hold.isOutsideTrackedWork).toBe(true)
    expect(isTrackedWork(hold)).toBe(false)

    const exclude = evaluateClassification(record('E1', 'CONTROL_PLANE', 'EXCLUDE'), PIN)
    expect(exclude.isOutsideTrackedWork).toBe(true)
    expect(isTrackedWork(exclude)).toBe(false)
  })

  it('expired receipt fails closed', () => {
    const ev = evaluateClassification(
      record('X9', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('X9', 'PRODUCT', 'ACTIVE', {
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      }),
      PIN,
      { now: '2026-07-13T00:00:00.000Z' },
    )
    expect(ev.reasons).toContain('STALE_RECEIPT_EXPIRED')
    expect(ev.contributesToProductReadiness).toBe(false)
  })

  it('rejects known-expired receipt when caller omits now (real server clock)', () => {
    // expiresAt far in the past relative to any real wall clock in this century
    const ev = evaluateClassification(
      record('X9-REAL', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('X9-REAL', 'PRODUCT', 'ACTIVE', {
          expiresAt: '2020-01-01T00:00:00.000Z',
        }),
      }),
      PIN,
      // intentionally omit opts.now — must not use epoch-disable default
    )
    expect(ev.reasons).toContain('STALE_RECEIPT_EXPIRED')
    expect(ev.valid).toBe(false)
    expect(ev.contributesToProductReadiness).toBe(false)
    expect(ev.isClassificationRepair).toBe(true)
  })

  it('accepts future-dated receipt when caller omits now (real server clock)', () => {
    const ev = evaluateClassification(
      record('X9-FUTURE', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('X9-FUTURE', 'PRODUCT', 'ACTIVE', {
          expiresAt: '2099-12-31T23:59:59.000Z',
        }),
      }),
      PIN,
    )
    expect(ev.reasons).not.toContain('STALE_RECEIPT_EXPIRED')
    expect(ev.valid).toBe(true)
    expect(ev.contributesToProductReadiness).toBe(true)
  })

  it('invalid injected now fails closed', () => {
    const ev = evaluateClassification(
      record('X9-BADNOW', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('X9-BADNOW', 'PRODUCT', 'ACTIVE', {
          expiresAt: '2099-12-31T23:59:59.000Z',
        }),
      }),
      PIN,
      { now: 'not-a-timestamp' },
    )
    expect(ev.reasons).toContain('STALE_RECEIPT_EXPIRED')
    expect(ev.valid).toBe(false)
    expect(ev.contributesToProductReadiness).toBe(false)
  })
})

describe('classification validity fail-closed matrix', () => {
  it('missing record is repair', () => {
    const ev = evaluateClassification(null, PIN)
    expect(ev.reasons).toContain('MISSING_RECORD')
    expect(ev.isClassificationRepair).toBe(true)
  })

  it('invalid receipt hash fails closed', () => {
    const ev = evaluateClassification(
      record('Z1', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('Z1', 'PRODUCT', 'ACTIVE', { receiptHash: '!!' }),
      }),
      PIN,
    )
    expect(ev.reasons).toContain('INVALID_RECEIPT_HASH')
  })

  it('receipt task mismatch fails closed', () => {
    const ev = evaluateClassification(
      record('Z2', 'PRODUCT', 'ACTIVE', {
        receipt: receipt('OTHER', 'PRODUCT', 'ACTIVE'),
      }),
      PIN,
    )
    expect(ev.reasons).toContain('RECEIPT_TASK_MISMATCH')
  })
})
