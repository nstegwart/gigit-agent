import { describe, expect, it } from 'vitest'

import type {
  ClassificationReceipt,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import {
  buildDirectMembershipAllowlist,
  contributesToProductReadiness,
  evaluateClassification,
  isPriorityPortfolioMembership,
  isProductDenominatorMember,
  isTaskClass,
  isTaskDisposition,
  isTrackedWork,
  stripSelfAssertedMembershipFields,
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

describe('AC-PRIORITY-01 isPriorityPortfolioMembership product-line gate', () => {
  function directAllow(
    byTaskId: ReadonlyMap<string, string>,
    pin: typeof PIN = PIN,
  ) {
    return {
      canonicalSnapshotId: pin.canonicalSnapshotId,
      canonicalHash: pin.canonicalHash,
      taskHash: pin.taskHash,
      boardRev: pin.boardRev,
      lifecycleRev: pin.lifecycleRev,
      byTaskId,
    }
  }

  it('rejects portfolio-id + truthy non-hex proof alone', () => {
    expect(
      isPriorityPortfolioMembership(
        receipt('M1', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'proof',
        }),
      ),
    ).toBe(false)
  })

  it('rejects sales-rebuild self-assert (product-line + hex) without allowlist (R2)', () => {
    expect(
      isPriorityPortfolioMembership(
        receipt('M2', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'sales-rebuild',
        }),
      ),
    ).toBe(false)
  })

  it('rejects mfs-web-original-upgrade self-assert without allowlist (R2)', () => {
    expect(
      isPriorityPortfolioMembership(
        receipt('M3', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'mfs-web-original-upgrade',
        }),
      ),
    ).toBe(false)
  })

  it('accepts sales-rebuild only with pin-bound direct membership allowlist (R2)', () => {
    const r = receipt('M2', 'PRODUCT', 'ACTIVE', {
      // Caller fields optional — allowlist is authority
      membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipProofHash: 'deadbeefdeadbeefdeadbeef',
      membershipProductLine: 'sales-rebuild',
    })
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: directAllow(new Map([['M2', 'sales-rebuild']])),
      }),
    ).toBe(true)
    // Allowlist alone (no self-asserted product line) still grants
    expect(
      isPriorityPortfolioMembership(
        receipt('M2b', 'PRODUCT', 'ACTIVE'),
        {
          pin: PIN,
          directMembershipAllowlist: directAllow(new Map([['M2b', 'sales-rebuild']])),
        },
      ),
    ).toBe(true)
  })

  it('accepts mfs-web-original-upgrade only with pin-bound allowlist (R2)', () => {
    expect(
      isPriorityPortfolioMembership(
        receipt('M3a', 'PRODUCT', 'ACTIVE'),
        {
          pin: PIN,
          directMembershipAllowlist: directAllow(
            new Map([['M3a', 'mfs-web-original-upgrade']]),
          ),
        },
      ),
    ).toBe(true)
  })

  it('backend rejects satisfied:true without refs (security M1)', () => {
    expect(
      isPriorityPortfolioMembership(
        receipt('M4', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'backend',
        }),
      ),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(
        receipt('M5', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'sales-rebuild',
          },
        }),
      ),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(
        receipt('M5b', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'sales-rebuild',
            refs: [],
          },
        }),
      ),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(
        receipt('M6', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: false,
            targetOutcome: 'sales-rebuild',
            refs: ['SALES-1'],
          },
        }),
      ),
    ).toBe(false)
  })

  it('backend accepts non-empty refs + pin-bound outcome membership map', () => {
    const r = receipt('BE-1', 'PRODUCT', 'ACTIVE', {
      membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipProofHash: 'abcdef0123456789abcdef01',
      membershipProductLine: 'backend',
      membershipDirectDependencyProof: {
        satisfied: true,
        targetOutcome: 'sales-rebuild',
        refs: ['SALES-1'],
      },
    })
    const salesMap = new Map([['SALES-1', 'sales-rebuild']])
    const boundSalesMap = {
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      byTaskId: salesMap,
    }
    // Missing graph → fail closed
    expect(isPriorityPortfolioMembership(r)).toBe(false)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [],
        directDependencyTargets: [],
        outcomeMembershipMap: boundSalesMap,
      }),
    ).toBe(false)
    // Ref not on graph → fail closed
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'OTHER' }],
        outcomeMembershipMap: boundSalesMap,
      }),
    ).toBe(false)
    // Valid edge WITHOUT outcome map → fail closed (map required)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
      }),
    ).toBe(false)
    // Valid edge + empty outcome map → fail closed
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeProductLinesByTaskId: new Map(),
      }),
    ).toBe(false)
    // Valid edge + pin-bound outcome map
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeMembershipMap: boundSalesMap,
      }),
    ).toBe(true)
    // Edge key form + bound map
    expect(
      isPriorityPortfolioMembership(
        receipt('BE-2', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'mfs-web-original-upgrade',
            refs: ['BE-2->MFS-1'],
          },
        }),
        {
          pin: PIN,
          dependencyJoins: [{ fromTaskId: 'BE-2', toTaskId: 'MFS-1' }],
          outcomeMembershipMap: {
            canonicalSnapshotId: PIN.canonicalSnapshotId,
            canonicalHash: PIN.canonicalHash,
            boardRev: PIN.boardRev,
            lifecycleRev: PIN.lifecycleRev,
            byTaskId: new Map([['MFS-1', 'mfs-web-original-upgrade']]),
          },
        },
      ),
    ).toBe(true)
    // Outcome product-line map rejects wrong line
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeMembershipMap: {
          ...boundSalesMap,
          byTaskId: new Map([['SALES-1', 'mfs-web-original-upgrade']]),
        },
      }),
    ).toBe(false)
    // Outcome product-line map accepts matching line (convenience unbound + pin)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeProductLinesByTaskId: new Map([['SALES-1', 'sales-rebuild']]),
      }),
    ).toBe(true)
    // Stale outcome map pin binding (boardRev) → fail closed
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeMembershipMap: {
          ...boundSalesMap,
          boardRev: PIN.boardRev + 1,
        },
      }),
    ).toBe(false)
    // Stale outcome map pin binding (canonicalHash) → fail closed
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        dependencyJoins: [{ fromTaskId: 'BE-1', toTaskId: 'SALES-1' }],
        outcomeMembershipMap: {
          ...boundSalesMap,
          canonicalHash: 'stalehashcccccccccccccccc',
        },
      }),
    ).toBe(false)
  })

  it('backend rejects forgeable structural ROOT authority without graph+map', () => {
    const proof = 'abcdef0123456789abcdef99'
    const rootAuth = {
      issuerRole: 'ROOT_ORCHESTRATOR' as const,
      signature: 'fedcba9876543210fedcba98',
      coversMembershipProofHash: proof,
      canonicalHash: PIN.canonicalHash,
    }
    // Structural ROOT alone (no refs / no map) → false (bypass removed)
    expect(
      isPriorityPortfolioMembership(
        receipt('BE-ROOT', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: proof,
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'sales-rebuild',
          },
          membershipRootAuthority: rootAuth,
        }),
        { pin: PIN },
      ),
    ).toBe(false)
    // ROOT fields + refs but no outcome map → still false
    expect(
      isPriorityPortfolioMembership(
        receipt('BE-ROOT2', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: proof,
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'sales-rebuild',
            refs: ['SALES-1'],
          },
          membershipRootAuthority: rootAuth,
        }),
        {
          pin: PIN,
          dependencyJoins: [{ fromTaskId: 'BE-ROOT2', toTaskId: 'SALES-1' }],
        },
      ),
    ).toBe(false)
    // Graph + map path still works even if forgeable ROOT fields present (ignored)
    expect(
      isPriorityPortfolioMembership(
        receipt('BE-ROOT3', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: proof,
          membershipProductLine: 'backend',
          membershipDirectDependencyProof: {
            satisfied: true,
            targetOutcome: 'sales-rebuild',
            refs: ['SALES-1'],
          },
          membershipRootAuthority: rootAuth,
        }),
        {
          pin: PIN,
          dependencyJoins: [{ fromTaskId: 'BE-ROOT3', toTaskId: 'SALES-1' }],
          outcomeMembershipMap: {
            canonicalSnapshotId: PIN.canonicalSnapshotId,
            canonicalHash: PIN.canonicalHash,
            boardRev: PIN.boardRev,
            lifecycleRev: PIN.lifecycleRev,
            byTaskId: new Map([['SALES-1', 'sales-rebuild']]),
          },
        },
      ),
    ).toBe(true)
  })

  it('backend rejects stale pin when graph context pin mismatches receipt', () => {
    const r = receipt('BE-STALE', 'PRODUCT', 'ACTIVE', {
      membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipProofHash: 'abcdef0123456789abcdef01',
      membershipProductLine: 'backend',
      membershipDirectDependencyProof: {
        satisfied: true,
        targetOutcome: 'sales-rebuild',
        refs: ['SALES-1'],
      },
    })
    expect(
      isPriorityPortfolioMembership(r, {
        pin: { ...PIN, boardRev: PIN.boardRev + 1 },
        dependencyJoins: [{ fromTaskId: 'BE-STALE', toTaskId: 'SALES-1' }],
        outcomeProductLinesByTaskId: new Map([['SALES-1', 'sales-rebuild']]),
      }),
    ).toBe(false)
    // Absent pin → fail closed even with graph + map
    expect(
      isPriorityPortfolioMembership(r, {
        dependencyJoins: [{ fromTaskId: 'BE-STALE', toTaskId: 'SALES-1' }],
        outcomeProductLinesByTaskId: new Map([['SALES-1', 'sales-rebuild']]),
      }),
    ).toBe(false)
  })

  it('sales/mfs direct membership requires allowlist, not dependency proof (R2)', () => {
    // Self-assert without allowlist → false
    expect(
      isPriorityPortfolioMembership(
        receipt('S1', 'PRODUCT', 'ACTIVE', {
          membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
          membershipProofHash: 'abcdef0123456789abcdef01',
          membershipProductLine: 'sales-rebuild',
        }),
      ),
    ).toBe(false)
    // Allowlist + pin, no dep proof → true
    expect(
      isPriorityPortfolioMembership(
        receipt('S1', 'PRODUCT', 'ACTIVE'),
        {
          pin: PIN,
          directMembershipAllowlist: directAllow(new Map([['S1', 'sales-rebuild']])),
        },
      ),
    ).toBe(true)
    expect(
      isPriorityPortfolioMembership(
        receipt('M1m', 'PRODUCT', 'ACTIVE'),
        {
          pin: PIN,
          directMembershipAllowlist: directAllow(
            new Map([['M1m', 'mfs-web-original-upgrade']]),
          ),
        },
      ),
    ).toBe(true)
  })

  it('R2 adversarial: arbitrary hex + product-line never grants without allowlist', () => {
    for (const hex of [
      'deadbeefdeadbeefdeadbeef',
      'ffffffffffffffff',
      'abcdef0123456789abcdef01',
    ]) {
      expect(
        isPriorityPortfolioMembership(
          receipt('ADV-HEX', 'PRODUCT', 'ACTIVE', {
            membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
            membershipProofHash: hex,
            membershipProductLine: 'sales-rebuild',
          }),
        ),
      ).toBe(false)
      expect(
        isPriorityPortfolioMembership(
          receipt('ADV-HEX-MFS', 'PRODUCT', 'ACTIVE', {
            membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
            membershipProofHash: hex,
            membershipProductLine: 'mfs-web-original-upgrade',
          }),
          { pin: PIN },
        ),
      ).toBe(false)
    }
  })

  it('R2 adversarial: stale pin on allowlist fails closed', () => {
    const r = receipt('STALE-D', 'PRODUCT', 'ACTIVE')
    const allow = directAllow(new Map([['STALE-D', 'sales-rebuild']]))
    expect(
      isPriorityPortfolioMembership(r, {
        pin: { ...PIN, boardRev: PIN.boardRev + 1 },
        directMembershipAllowlist: allow,
      }),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: { ...allow, boardRev: PIN.boardRev + 1 },
      }),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: {
          ...allow,
          canonicalHash: 'stalehashcccccccccccccccc',
        },
      }),
    ).toBe(false)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: { ...allow, taskHash: 'staletaskhashhhhhhhhhhh' },
      }),
    ).toBe(false)
    // Absent pin → false even with allowlist
    expect(
      isPriorityPortfolioMembership(r, {
        directMembershipAllowlist: allow,
      }),
    ).toBe(false)
  })

  it('R2 adversarial: allowlist task miss / wrong line / claimed mismatch fail closed', () => {
    const r = receipt('MISS', 'PRODUCT', 'ACTIVE', {
      membershipProductLine: 'sales-rebuild',
    })
    // Task not on allowlist
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: directAllow(new Map([['OTHER', 'sales-rebuild']])),
      }),
    ).toBe(false)
    // Allowlist maps to backend (invalid for direct)
    expect(
      isPriorityPortfolioMembership(r, {
        pin: PIN,
        directMembershipAllowlist: directAllow(new Map([['MISS', 'backend']])),
      }),
    ).toBe(false)
    // Claimed product line disagrees with derived
    expect(
      isPriorityPortfolioMembership(
        receipt('MISS2', 'PRODUCT', 'ACTIVE', {
          membershipProductLine: 'mfs-web-original-upgrade',
        }),
        {
          pin: PIN,
          directMembershipAllowlist: directAllow(new Map([['MISS2', 'sales-rebuild']])),
        },
      ),
    ).toBe(false)
  })

  it('R2 buildDirectMembershipAllowlist derives from project/repo/feature identity only', () => {
    const allow = buildDirectMembershipAllowlist(
      PIN,
      [
        { id: 'T-sales', projectId: 'sales-rebuild' },
        { id: 'T-mfs', featureContractId: 'mfs-web-original-upgrade' },
        { id: 'T-repo', repository: 'sales-rebuild' },
        { id: 'T-other', projectId: 'proj-sales-web' },
        { id: 'T-via-proj', projectId: 'p1' },
      ],
      {
        projects: [
          { id: 'p1', nama: 'sales-rebuild' },
          { id: 'proj-sales-web', nama: 'Sales Web' },
        ],
        features: [{ id: 'f1', projectId: 'p1' }],
      },
    )
    expect(allow.byTaskId.get('T-sales')).toBe('sales-rebuild')
    expect(allow.byTaskId.get('T-mfs')).toBe('mfs-web-original-upgrade')
    expect(allow.byTaskId.get('T-repo')).toBe('sales-rebuild')
    // Arbitrary project id is NOT a product line
    expect(allow.byTaskId.get('T-other')).toBeUndefined()
    // Project nama maps to product line → tasks under that project id get line
    expect(allow.byTaskId.get('T-via-proj')).toBe('sales-rebuild')
    expect(allow.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(allow.taskHash).toBe(PIN.taskHash)
  })

  it('R2 stripSelfAssertedMembershipFields removes sales/mfs self-assert and root authority', () => {
    const stripped = stripSelfAssertedMembershipFields(
      receipt('X', 'PRODUCT', 'ACTIVE', {
        membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipProofHash: 'deadbeefdeadbeefdeadbeef',
        membershipProductLine: 'sales-rebuild',
        membershipRootAuthority: {
          issuerRole: 'ROOT_ORCHESTRATOR',
          signature: 'fedcba9876543210fedcba98',
          coversMembershipProofHash: 'deadbeefdeadbeefdeadbeef',
        },
      }),
    )
    expect(stripped.membershipProductLine).toBeUndefined()
    expect(stripped.membershipProofHash).toBeUndefined()
    expect(stripped.membershipPortfolioId).toBeUndefined()
    expect(stripped.membershipRootAuthority).toBeUndefined()
    // Backend fields preserved
    const be = stripSelfAssertedMembershipFields(
      receipt('B', 'PRODUCT', 'ACTIVE', {
        membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipProofHash: 'abcdef0123456789abcdef01',
        membershipProductLine: 'backend',
        membershipDirectDependencyProof: {
          satisfied: true,
          targetOutcome: 'sales-rebuild',
          refs: ['SALES-1'],
        },
      }),
    )
    expect(be.membershipProductLine).toBe('backend')
    expect(be.membershipProofHash).toBe('abcdef0123456789abcdef01')
    expect(be.membershipDirectDependencyProof?.refs).toEqual(['SALES-1'])
  })
})
