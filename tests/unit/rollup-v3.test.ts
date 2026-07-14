import { describe, expect, it } from 'vitest'

import type {
  ClassificationReceipt,
  G5DomainRecord,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import { DomainError, G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import { makePassingDomain } from '#/server/g5'
import { deriveG5Pass, evaluateG5 } from '#/server/g5'
import {
  assertDistinctJoins,
  assignBucket,
  computePriorityAllocation,
  computeRollupV3,
  isAllowedClosureRole,
  type RollupTaskInput,
} from '#/server/rollup-v3'

const PIN: PinnedRevisionTuple = {
  canonicalSnapshotId: 'snap-rollup-1',
  canonicalHash: 'canonhashaaaaaaaaaaaaaaaa',
  taskHash: 'taskhashbbbbbbbbbbbbbbbb',
  boardRev: 11,
  lifecycleRev: 5,
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

function cls(
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

function productTask(
  taskId: string,
  stage: string,
  extra: Partial<RollupTaskInput> = {},
): RollupTaskInput {
  return {
    taskId,
    classification: cls(taskId, 'PRODUCT', 'ACTIVE'),
    lifecycleStage: stage,
    productStageMode: 'STAGE_2',
    eligible: true,
    ...extra,
  }
}

function allG5Pass(pin: PinnedRevisionTuple = PIN): Array<G5DomainRecord> {
  return G5_REQUIRED_DOMAINS.map((id) => makePassingDomain(id, pin))
}

function evidence(stage: RollupTaskInput['lifecycleStage']) {
  return {
    stage: stage as 'PROD_READY',
    receiptId: 'ev-1',
    receiptHash: 'evhashcccccccccccccccccc',
    independentVerifier: true,
    verifierRunId: 'v1',
    authorRunId: 'a1',
    boardRev: PIN.boardRev,
    lifecycleRev: PIN.lifecycleRev,
    taskHash: PIN.taskHash,
    canonicalHash: PIN.canonicalHash,
  }
}

describe('AC-COUNT-01 DISTINCT task IDs', () => {
  it('duplicate task rows collapse to one DISTINCT id', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('T-A', 'MAPPED'),
        productTask('T-A', 'BUILT'), // same id — last wins, still one
        productTask('T-B', 'MAPPED'),
      ],
      g5Domains: [],
    })
    expect(result.productDenominator).toBe(2)
    expect(result.trackedWorkDenominator).toBe(2)
    expect(result.productTaskIds).toEqual(['T-A', 'T-B'])
  })
})

describe('AC-COUNT-02 duplicate join / conflicting ownership rejection', () => {
  it('rejects duplicate FC joins', () => {
    expect(() =>
      assertDistinctJoins({
        featureContractJoins: [
          { featureContractId: 'FC1', taskId: 'T1' },
          { featureContractId: 'FC1', taskId: 'T2' },
        ],
      }),
    ).toThrow(DomainError)
    try {
      assertDistinctJoins({
        featureContractJoins: [
          { featureContractId: 'FC1', taskId: 'T1' },
          { featureContractId: 'FC1', taskId: 'T2' },
        ],
      })
    } catch (e) {
      expect(e).toBeInstanceOf(DomainError)
      expect((e as DomainError).code).toBe('DUPLICATE_FC_JOIN')
    }
  })

  it('rejects duplicate node joins', () => {
    try {
      assertDistinctJoins({
        nodeJoins: [
          { nodeId: 'N1', taskId: 'T1' },
          { nodeId: 'N1', taskId: 'T2' },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as DomainError).code).toBe('DUPLICATE_NODE_JOIN')
    }
  })

  it('rejects duplicate dependency joins', () => {
    try {
      assertDistinctJoins({
        dependencyJoins: [
          { fromTaskId: 'T1', toTaskId: 'T2' },
          { fromTaskId: 'T1', toTaskId: 'T2' },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as DomainError).code).toBe('DUPLICATE_DEPENDENCY_JOIN')
    }
  })

  it('rejects conflicting primary ownership', () => {
    try {
      assertDistinctJoins({
        primaryOwnership: [
          { taskId: 'T1', ownerId: 'agent-a' },
          { taskId: 'T1', ownerId: 'agent-b' },
        ],
      })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as DomainError).code).toBe('CONFLICTING_PRIMARY_OWNERSHIP')
    }
  })

  it('computeRollupV3 surfaces join rejection', () => {
    expect(() =>
      computeRollupV3({
        pin: PIN,
        tasks: [productTask('T1', 'MAPPED')],
        g5Domains: [],
        featureContractJoins: [
          { featureContractId: 'FC', taskId: 'T1' },
          { featureContractId: 'FC', taskId: 'T1' },
        ],
      }),
    ).toThrow(/duplicate feature-contract/)
  })
})

describe('AC-READY-06/07 + rollup fields pin binding', () => {
  it('productDenominator=0 → null readiness, EMPTY_PRODUCT_SCOPE, complete false', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        {
          taskId: 'H1',
          classification: cls('H1', 'PRODUCT', 'HOLD'),
          lifecycleStage: 'PROD_READY',
        },
      ],
      g5Domains: allG5Pass(),
    })
    expect(result.productDenominator).toBe(0)
    expect(result.rawTaskReadinessPercent).toBeNull()
    expect(result.boardReadinessPercent).toBeNull()
    expect(result.cappedBy).toBe('EMPTY_PRODUCT_SCOPE')
    expect(result.complete).toBe(false)
    expect(result.trackedWorkDenominator).toBe(0)
    expect(result.pin).toEqual(PIN)
  })

  it('raw mean one-decimal over DISTINCT product stages', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [productTask('T1', 'MAPPED'), productTask('T2', 'MAP_VERIFIED')],
      g5Domains: [],
    })
    // (10+20)/2 = 15.0
    expect(result.rawTaskReadinessPercent).toBe(15)
    expect(result.productDenominator).toBe(2)
    expect(result.taskReadinessPolicyVersion).toBe('MFS_DELIVERY_READINESS_V1')
    expect(result.boardReadinessPolicyVersion).toBe('MFS_BOARD_READINESS_G5_CAP_V1')
  })

  it('stale classification hash excludes from productDenominator', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('T1', 'PROD_READY'),
        {
          taskId: 'T2',
          classification: cls('T2', 'PRODUCT', 'ACTIVE', {
            receipt: receipt('T2', 'PRODUCT', 'ACTIVE', {
              canonicalHash: 'staleeeeeeeeeeeeeeeeeee',
            }),
          }),
          lifecycleStage: 'PROD_READY',
        },
      ],
      g5Domains: [],
    })
    expect(result.productDenominator).toBe(1)
    expect(result.unclassifiedCount).toBe(1)
    expect(result.trackedWorkDenominator).toBe(2)
    expect(result.complete).toBe(false)
  })
})

describe('AC-LIFE-05 g5Pass derived nine domains', () => {
  it('all nine PASS current → g5Pass true', () => {
    expect(deriveG5Pass(allG5Pass(), PIN)).toBe(true)
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('T1', 'PROD_READY', { evidence: evidence('PROD_READY') }),
      ],
      g5Domains: allG5Pass(),
    })
    expect(result.g5Pass).toBe(true)
  })

  it('any missing domain → false', () => {
    const domains = allG5Pass().slice(0, 8)
    expect(deriveG5Pass(domains, PIN)).toBe(false)
    expect(evaluateG5(domains, PIN).missingDomains).toHaveLength(1)
  })

  it('stale boardRev domain → false', () => {
    const domains = allG5Pass().map((d, i) =>
      i === 0 ? { ...d, boardRev: PIN.boardRev - 1 } : d,
    )
    expect(deriveG5Pass(domains, PIN)).toBe(false)
  })

  it('non-PASS / non-programmatic / self-verify → false', () => {
    expect(
      deriveG5Pass(
        allG5Pass().map((d, i) => (i === 1 ? { ...d, status: 'FAIL' as const } : d)),
        PIN,
      ),
    ).toBe(false)
    expect(
      deriveG5Pass(
        allG5Pass().map((d, i) =>
          i === 2 ? { ...d, programmaticEvidence: false } : d,
        ),
        PIN,
      ),
    ).toBe(false)
    expect(
      deriveG5Pass(
        allG5Pass().map((d, i) =>
          i === 3
            ? { ...d, verifierRunId: 'same', authorRunId: 'same' }
            : d,
        ),
        PIN,
      ),
    ).toBe(false)
  })

  it('raw 100 + g5Pass false → board 99 cappedBy G5', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('T1', 'PROD_READY', { evidence: evidence('PROD_READY') }),
        productTask('T2', 'LIVE_VERIFIED', { evidence: evidence('LIVE_VERIFIED') }),
      ],
      g5Domains: [], // g5Pass false
    })
    expect(result.rawTaskReadinessPercent).toBe(100)
    expect(result.g5Pass).toBe(false)
    expect(result.boardReadinessPercent).toBe(99.0)
    expect(result.cappedBy).toBe('G5')
    expect(result.complete).toBe(false)
  })
})

describe('AC-BUCKET-01 coverage equality over DISTINCT IDs', () => {
  it('trackedWorkDenominator equals sum of six primary buckets', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('D1', 'PROD_READY', { productStageMode: 'STAGE_2' }),
        productTask('O1', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
        }),
        productTask('N1', 'BUILT', {
          selectedForNextDispatch: true,
          eligible: true,
        }),
        productTask('Q1', 'MAPPED', { eligible: true }),
        productTask('B1', 'MAPPED', {
          hasBlockingDecision: true,
          eligible: true,
        }),
        productTask('R1', 'FUNCTIONAL', {
          claimState: 'STALE',
          eligible: false,
        }),
        {
          taskId: 'U1',
          classification: cls('U1', 'UNCLASSIFIED', 'ACTIVE'),
          lifecycleStage: null,
        },
        // valid HOLD outside tracked
        {
          taskId: 'H1',
          classification: cls('H1', 'PRODUCT', 'HOLD'),
          lifecycleStage: 'MAPPED',
        },
      ],
      g5Domains: [],
    })
    const sum =
      result.buckets.DONE +
      result.buckets.RECONCILIATION_PENDING +
      result.buckets.ONGOING +
      result.buckets.NEXT +
      result.buckets.QUEUED +
      result.buckets.BLOCKED
    expect(sum).toBe(result.trackedWorkDenominator)
    expect(result.buckets.DONE).toBe(1)
    expect(result.buckets.ONGOING).toBe(1)
    expect(result.buckets.NEXT).toBe(1)
    expect(result.buckets.QUEUED).toBe(1)
    expect(result.buckets.RECONCILIATION_PENDING).toBe(1)
    // B1 blocking + U1 data integrity
    expect(result.buckets.BLOCKED).toBe(2)
    expect(result.trackedWorkDenominator).toBe(7)
  })
})

describe('AC-BUCKET-02 only blocking decisions demote ONGOING', () => {
  it('non-blocking decision keeps ONGOING', () => {
    const a = assignBucket(
      productTask('O1', 'BUILT', {
        claimState: 'VALID_CURRENT',
        runLiveness: 'RUNNING',
        hasNonBlockingDecision: true,
        hasBlockingDecision: false,
      }),
      PIN,
    )
    expect(a.primary).toBe('ONGOING')
    expect(a.ruleIndex).toBe(6)
  })

  it('blocking decision → BLOCKED', () => {
    const a = assignBucket(
      productTask('O2', 'BUILT', {
        claimState: 'VALID_CURRENT',
        runLiveness: 'RUNNING',
        hasBlockingDecision: true,
      }),
      PIN,
    )
    expect(a.primary).toBe('BLOCKED')
    expect(a.blockReason).toBe('BLOCKING_DECISION')
    expect(a.ruleIndex).toBe(5)
  })
})

describe('AC-BUCKET-03 completed stays DONE with stale/beyond-stage overlay', () => {
  it('stale claim on completed → DONE + STALE_CLAIM', () => {
    const a = assignBucket(
      productTask('D1', 'PROD_READY', {
        claimState: 'STALE',
        productStageMode: 'STAGE_2',
      }),
      PIN,
    )
    expect(a.primary).toBe('DONE')
    expect(a.overlays).toContain('STALE_CLAIM')
    expect(a.overlays).toContain('RECONCILIATION_DRILLDOWN')
  })

  it('beyond-stage claim on completed → DONE + BEYOND_STAGE_ONGOING', () => {
    const a = assignBucket(
      productTask('D2', 'LIVE_VERIFIED', {
        claimState: 'BEYOND_STAGE',
        productStageMode: 'STAGE_2',
      }),
      PIN,
    )
    expect(a.primary).toBe('DONE')
    expect(a.overlays).toContain('BEYOND_STAGE_ONGOING')
  })

  it('Stage 1 DONE at MAP_VERIFIED', () => {
    const a = assignBucket(
      productTask('D3', 'MAP_VERIFIED', { productStageMode: 'STAGE_1' }),
      PIN,
    )
    expect(a.primary).toBe('DONE')
  })
})

describe('AC-BUCKET-04 CONTROL_PLANE DONE outside product progress', () => {
  it('verified control-plane gate → DONE without productDenominator', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        {
          taskId: 'CP1',
          classification: cls('CP1', 'CONTROL_PLANE', 'ACTIVE', {
            controlPlaneTargetGate: 'C1_DOMAIN_IMPLEMENTED',
            controlPlaneGateVerifiedPass: true,
            controlPlaneRootAccepted: true,
          }),
          lifecycleStage: null,
        },
      ],
      g5Domains: [],
    })
    expect(result.buckets.DONE).toBe(1)
    expect(result.productDenominator).toBe(0)
    expect(result.rawTaskReadinessPercent).toBeNull()
    expect(result.complete).toBe(false)
  })
})

describe('AC-BUCKET-05/07 STALE overlay + RECONCILIATION_PENDING', () => {
  it('incomplete stale ownership maps to RECONCILIATION_PENDING', () => {
    const a = assignBucket(
      productTask('R1', 'BUILT', { claimState: 'ORPHAN' }),
      PIN,
    )
    expect(a.primary).toBe('RECONCILIATION_PENDING')
    expect(a.overlays).toContain('STALE_CLAIM')
    expect(a.overlays).toContain('RECONCILIATION_DRILLDOWN')
  })

  it.each([
    ['STALE', 'STALE_CLAIM'],
    ['ORPHAN', 'STALE_CLAIM'],
    ['EXPIRED', 'STALE_CLAIM'],
    ['FENCED', 'STALE_CLAIM'],
  ] as const)(
    'incomplete %s ownership → RECONCILIATION_PENDING + STALE_CLAIM (STALE chip family)',
    (claimState, familyOverlay) => {
      const a = assignBucket(
        productTask(`R-${claimState}`, 'BUILT', { claimState }),
        PIN,
      )
      expect(a.primary).toBe('RECONCILIATION_PENDING')
      expect(a.ruleIndex).toBe(4)
      expect(a.overlays).toContain(familyOverlay)
      expect(a.overlays).toContain('RECONCILIATION_DRILLDOWN')
      // Mutual exclusivity: not also DONE
      expect(a.outsideTracked).toBe(false)
    },
  )

  it('incomplete BEYOND_STAGE → RECONCILIATION_PENDING + BEYOND_STAGE_ONGOING (not STALE_CLAIM)', () => {
    const a = assignBucket(
      productTask('R-BEYOND', 'BUILT', { claimState: 'BEYOND_STAGE' }),
      PIN,
    )
    expect(a.primary).toBe('RECONCILIATION_PENDING')
    expect(a.overlays).toContain('BEYOND_STAGE_ONGOING')
    expect(a.overlays).toContain('RECONCILIATION_DRILLDOWN')
    expect(a.overlays).not.toContain('STALE_CLAIM')
  })

  it('completed stays DONE with reconciliation overlay; incomplete STALE stays RECON not DONE', () => {
    const done = assignBucket(
      productTask('D-STALE', 'PROD_READY', {
        claimState: 'STALE',
        productStageMode: 'STAGE_2',
      }),
      PIN,
    )
    const recon = assignBucket(
      productTask('R-STALE', 'BUILT', { claimState: 'STALE' }),
      PIN,
    )
    expect(done.primary).toBe('DONE')
    expect(done.overlays).toContain('STALE_CLAIM')
    expect(done.overlays).toContain('RECONCILIATION_DRILLDOWN')
    expect(recon.primary).toBe('RECONCILIATION_PENDING')
    expect(recon.overlays).toContain('STALE_CLAIM')
    expect(recon.overlays).toContain('RECONCILIATION_DRILLDOWN')
  })

  it('rollup STALE_CLAIM count includes incomplete recon + completed linger; denom equality holds', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('D1', 'PROD_READY', {
          claimState: 'ORPHAN',
          productStageMode: 'STAGE_2',
        }),
        productTask('R1', 'BUILT', { claimState: 'STALE' }),
        productTask('R2', 'FUNCTIONAL', { claimState: 'FENCED' }),
        productTask('R3', 'MAPPED', { claimState: 'EXPIRED' }),
        productTask('Q1', 'MAPPED', { eligible: true }),
      ],
      g5Domains: [],
    })
    const sum =
      result.buckets.DONE +
      result.buckets.RECONCILIATION_PENDING +
      result.buckets.ONGOING +
      result.buckets.NEXT +
      result.buckets.QUEUED +
      result.buckets.BLOCKED
    expect(sum).toBe(result.trackedWorkDenominator)
    expect(result.buckets.DONE).toBe(1)
    expect(result.buckets.RECONCILIATION_PENDING).toBe(3)
    expect(result.buckets.QUEUED).toBe(1)
    // D1 + R1 + R2 + R3 all carry STALE_CLAIM
    expect(result.overlays.STALE_CLAIM).toBe(4)
    expect(result.overlays.RECONCILIATION_DRILLDOWN).toBe(4)
  })

  it('stale data/dispatch/account overlays recorded', () => {
    const a = assignBucket(
      productTask('Q1', 'MAPPED', {
        eligible: true,
        staleDataSource: true,
        staleDispatchPlan: true,
        staleAccountSync: true,
      }),
      PIN,
    )
    expect(a.primary).toBe('QUEUED')
    expect(a.overlays).toEqual(
      expect.arrayContaining([
        'STALE_DATA_SOURCE',
        'STALE_DISPATCH_PLAN',
        'STALE_ACCOUNT_SYNC',
      ]),
    )
  })
})

describe('AC-BUCKET-06 trackedWorkDenominator includes ACTIVE + UNCLASSIFIED repair once', () => {
  it('counts ACTIVE product and repair UNCLASSIFIED; excludes valid HOLD', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('A1', 'MAPPED'),
        {
          taskId: 'U1',
          classification: cls('U1', 'UNCLASSIFIED', 'HOLD'),
          lifecycleStage: null,
        },
        {
          taskId: 'H1',
          classification: cls('H1', 'PRODUCT', 'HOLD'),
          lifecycleStage: 'MAPPED',
        },
      ],
      g5Domains: [],
    })
    expect(result.trackedWorkDenominator).toBe(2)
    expect(result.unclassifiedCount).toBe(1)
    expect(result.productDenominator).toBe(1)
  })
})

describe('AC-PRIORITY-01/02 membership + zero/null frontier semantics', () => {
  it('membership only ACTIVE PRODUCT with valid receipt', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
        {
          taskId: 'H1',
          classification: cls('H1', 'PRODUCT', 'HOLD'),
          priorityMembership: true,
        },
        {
          taskId: 'U1',
          classification: cls('U1', 'UNCLASSIFIED', 'ACTIVE'),
          priorityMembership: true,
        },
        {
          taskId: 'CP1',
          classification: cls('CP1', 'CONTROL_PLANE', 'ACTIVE'),
          priorityMembership: true,
        },
      ],
      packets: [],
    })
    expect(alloc.membershipTaskIds).toEqual(['P1'])
    expect(alloc.membershipDenominator).toBe(1)
  })

  it('zero allClosureCapacity with frontier → share null, majority false', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
      ],
      packets: [],
    })
    expect(alloc.allClosureCapacity).toBe(0)
    expect(alloc.priorityCapacityShare).toBeNull()
    expect(alloc.majorityAllocationPass).toBe(false)
    expect(alloc.reason).toBe('ZERO_SCHEDULABLE_CAPACITY')
  })

  it('empty frontier → majority null never PASS', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [],
      packets: [
        {
          packetId: 'pk1',
          taskId: 'X',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: true,
        },
      ],
    })
    expect(alloc.majorityAllocationPass).toBeNull()
    expect(alloc.priorityCapacityShare).toBeNull()
    expect(alloc.frontierState).toBe('PRIORITY_FRONTIER_EMPTY')
  })

  it('majority pass only when priority share > 0.5 and frontier active', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
      ],
      packets: [
        {
          packetId: 'pk1',
          taskId: 'P1',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: true,
        },
        {
          packetId: 'pk2',
          taskId: 'O1',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: false,
        },
      ],
    })
    expect(alloc.allClosureCapacity).toBe(2)
    expect(alloc.priorityClosureCapacity).toBe(1)
    expect(alloc.priorityCapacityShare).toBe(0.5)
    // > 0.5 required — equal 0.5 is not majority
    expect(alloc.majorityAllocationPass).toBe(false)
  })

  it('AC-PRIORITY-01 DISTINCT membership by taskId (duplicate rows → denom=1)', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
        {
          taskId: 'P2',
          classification: cls('P2', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
      ],
      packets: [],
    })
    expect(alloc.membershipTaskIds).toEqual(['P1', 'P2'])
    expect(alloc.membershipDenominator).toBe(2)
  })

  it('no membership → priorityClosureCapacity forced 0 (fail-closed EMPTY)', () => {
    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [],
      packets: [
        {
          packetId: 'pk1',
          taskId: 'X',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: true,
        },
      ],
    })
    expect(alloc.membershipDenominator).toBe(0)
    expect(alloc.priorityClosureCapacity).toBe(0)
    expect(alloc.allClosureCapacity).toBe(1)
    expect(alloc.majorityAllocationPass).toBeNull()
    expect(alloc.priorityCapacityShare).toBeNull()
    expect(alloc.frontierState).toBe('PRIORITY_FRONTIER_EMPTY')
  })

  it('closure-role filter excludes root/idle/health; allows Stage roles + implementer', () => {
    expect(isAllowedClosureRole('PRODUCT')).toBe(true)
    expect(isAllowedClosureRole('implementer')).toBe(true)
    expect(isAllowedClosureRole('INVENTORY')).toBe(true)
    expect(isAllowedClosureRole('root')).toBe(false)
    expect(isAllowedClosureRole('idle_controller')).toBe(false)
    expect(isAllowedClosureRole('health-only')).toBe(false)
    expect(isAllowedClosureRole('mystery-role')).toBe(false)
    expect(isAllowedClosureRole(null)).toBe(true)
    expect(isAllowedClosureRole('')).toBe(true)

    const alloc = computePriorityAllocation({
      pin: PIN,
      tasks: [
        {
          taskId: 'P1',
          classification: cls('P1', 'PRODUCT', 'ACTIVE'),
          priorityMembership: true,
        },
      ],
      packets: [
        {
          packetId: 'ok',
          taskId: 'P1',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: true,
          closureRole: 'PRODUCT',
        },
        {
          packetId: 'bad',
          taskId: 'P1',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: true,
          closureRole: 'root',
        },
      ],
    })
    expect(alloc.allClosureCapacity).toBe(1)
    expect(alloc.priorityClosureCapacity).toBe(1)
  })
})

describe('deterministic sorting', () => {
  it('trackedTaskIds sorted lexicographically regardless of input order', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [productTask('T-Z', 'MAPPED'), productTask('T-A', 'MAPPED')],
      g5Domains: [],
    })
    expect(result.trackedTaskIds).toEqual(['T-A', 'T-Z'])
    expect(result.productTaskIds).toEqual(['T-A', 'T-Z'])
  })
})

describe('stageProdReady / prodReadyWithEvidence', () => {
  it('counts PROD_READY/LIVE_VERIFIED and evidence-valid subset', () => {
    const result = computeRollupV3({
      pin: PIN,
      tasks: [
        productTask('T1', 'PROD_READY', { evidence: evidence('PROD_READY') }),
        productTask('T2', 'LIVE_VERIFIED'), // no evidence
        productTask('T3', 'STAGING_PROVEN'),
      ],
      g5Domains: [],
    })
    expect(result.stageProdReady).toBe(2)
    expect(result.prodReadyWithEvidence).toBe(1)
    expect(result.productDenominator).toBe(3)
  })
})
