import { describe, expect, it } from 'vitest'

import { LIFECYCLE_STAGE_ORDER } from '#/lib/control-plane-types'
import {
  applyBoardReadinessCap,
  BOARD_READINESS_POLICY_VERSION,
  isBoardComplete,
  meanReadinessOneDecimal,
  MFS_DELIVERY_READINESS_V1_WEIGHT_LIST,
  MFS_DELIVERY_READINESS_V1_WEIGHTS,
  TASK_READINESS_POLICY_VERSION,
  taskStageWeight,
} from '#/lib/readiness-policy'

describe('AC-READY-01 exact MFS_DELIVERY_READINESS_V1 weights', () => {
  it('weights are exactly 0/10/20/45/65/75/90/100/100', () => {
    expect(TASK_READINESS_POLICY_VERSION).toBe('MFS_DELIVERY_READINESS_V1')
    expect(MFS_DELIVERY_READINESS_V1_WEIGHT_LIST).toEqual([
      0, 10, 20, 45, 65, 75, 90, 100, 100,
    ])
    expect(LIFECYCLE_STAGE_ORDER.map((k) => MFS_DELIVERY_READINESS_V1_WEIGHTS[k])).toEqual([
      0, 10, 20, 45, 65, 75, 90, 100, 100,
    ])
  })
})

describe('AC-READY-05 mapping 20/20 at MAPPED is 10', () => {
  it('MAPPED stays 10 even with full mapping checkpoints', () => {
    expect(taskStageWeight('MAPPED', 20, 20)).toBe(10)
    expect(taskStageWeight('MAPPED', 0, 20)).toBe(10)
    expect(taskStageWeight('MAPPING', 20, 20)).toBe(0)
  })
})

describe('AC-READY-02 one-decimal mean preserves task weights', () => {
  it('mean of DISTINCT weights is one decimal', () => {
    // 10 + 20 + 45 = 75 / 3 = 25.0
    expect(meanReadinessOneDecimal([10, 20, 45])).toBe(25)
    // 100 + 90 = 95.0
    expect(meanReadinessOneDecimal([100, 90])).toBe(95)
    // 10 + 20 = 15.0
    expect(meanReadinessOneDecimal([10, 20])).toBe(15)
    // 65 + 75 + 90 = 230 / 3 = 76.666… → 76.7
    expect(meanReadinessOneDecimal([65, 75, 90])).toBe(76.7)
  })

  it('empty weights → null (not 0, not 100)', () => {
    expect(meanReadinessOneDecimal([])).toBeNull()
  })
})

describe('AC-READY-07 productDenominator=0 null readiness never 100', () => {
  it('empty product scope caps with EMPTY_PRODUCT_SCOPE', () => {
    const cap = applyBoardReadinessCap({
      rawTaskReadinessPercent: null,
      g5Pass: false,
      evidenceComplete: false,
      hasUnclassifiedOrP0: false,
      productDenominator: 0,
    })
    expect(cap.boardReadinessPercent).toBeNull()
    expect(cap.cappedBy).toBe('EMPTY_PRODUCT_SCOPE')
    expect(cap.boardReadinessPolicyVersion).toBe('MFS_BOARD_READINESS_G5_CAP_V1')
    expect(BOARD_READINESS_POLICY_VERSION).toBe('MFS_BOARD_READINESS_G5_CAP_V1')
  })
})

describe('AC-READY-03 board 99 cap versioned cappedBy', () => {
  it('raw 100 + g5Pass=false → 99.0 cappedBy=G5', () => {
    const cap = applyBoardReadinessCap({
      rawTaskReadinessPercent: 100,
      g5Pass: false,
      evidenceComplete: true,
      hasUnclassifiedOrP0: false,
      productDenominator: 2,
    })
    expect(cap.boardReadinessPercent).toBe(99.0)
    expect(cap.cappedBy).toBe('G5')
  })

  it('raw 100 + incomplete evidence → 99.0 cappedBy=EVIDENCE', () => {
    const cap = applyBoardReadinessCap({
      rawTaskReadinessPercent: 100,
      g5Pass: true,
      evidenceComplete: false,
      hasUnclassifiedOrP0: false,
      productDenominator: 1,
    })
    expect(cap.boardReadinessPercent).toBe(99.0)
    expect(cap.cappedBy).toBe('EVIDENCE')
  })

  it('raw 100 + UNCLASSIFIED/P0 → 99.0 cappedBy=DATA_INTEGRITY_OR_P0', () => {
    const cap = applyBoardReadinessCap({
      rawTaskReadinessPercent: 100,
      g5Pass: true,
      evidenceComplete: true,
      hasUnclassifiedOrP0: true,
      productDenominator: 1,
    })
    expect(cap.boardReadinessPercent).toBe(99.0)
    expect(cap.cappedBy).toBe('DATA_INTEGRITY_OR_P0')
  })

  it('partial raw never rounds to 100', () => {
    const cap = applyBoardReadinessCap({
      rawTaskReadinessPercent: 99.95,
      g5Pass: false,
      evidenceComplete: false,
      hasUnclassifiedOrP0: false,
      productDenominator: 3,
    })
    expect(cap.boardReadinessPercent).not.toBe(100)
    expect(cap.boardReadinessPercent).toBe(99.95)
  })
})

describe('AC-READY-04 complete blockers', () => {
  it('complete false when g5Pass false even if stage counts match', () => {
    expect(
      isBoardComplete({
        productDenominator: 2,
        stageProdReady: 2,
        prodReadyWithEvidence: 2,
        g5Pass: false,
        unclassifiedCount: 0,
        hasP0OrDataIntegrityBlocker: false,
      }),
    ).toBe(false)
  })

  it('complete false when unclassifiedCount > 0', () => {
    expect(
      isBoardComplete({
        productDenominator: 1,
        stageProdReady: 1,
        prodReadyWithEvidence: 1,
        g5Pass: true,
        unclassifiedCount: 1,
        hasP0OrDataIntegrityBlocker: false,
      }),
    ).toBe(false)
  })

  it('complete false when productDenominator=0', () => {
    expect(
      isBoardComplete({
        productDenominator: 0,
        stageProdReady: 0,
        prodReadyWithEvidence: 0,
        g5Pass: true,
        unclassifiedCount: 0,
        hasP0OrDataIntegrityBlocker: false,
      }),
    ).toBe(false)
  })

  it('complete true only when all predicates hold', () => {
    expect(
      isBoardComplete({
        productDenominator: 2,
        stageProdReady: 2,
        prodReadyWithEvidence: 2,
        g5Pass: true,
        unclassifiedCount: 0,
        hasP0OrDataIntegrityBlocker: false,
      }),
    ).toBe(true)
  })
})

describe('unknown stages fail closed to 0', () => {
  it('null/unknown stage weight is 0', () => {
    expect(taskStageWeight(null)).toBe(0)
    expect(taskStageWeight('NOT_A_STAGE')).toBe(0)
  })
})
