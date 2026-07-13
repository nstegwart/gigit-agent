// Canonical readiness policy versions (V3).
// Pure constants + pure functions — no I/O, no caller-writable contribution.

import type {
  BoardCappedBy,
  BoardReadinessPolicyVersion,
  LifecycleStageKey,
  TaskReadinessPolicyVersion,
} from './control-plane-types'
import { LIFECYCLE_STAGE_ORDER } from './control-plane-types'

export const TASK_READINESS_POLICY_VERSION: TaskReadinessPolicyVersion =
  'MFS_DELIVERY_READINESS_V1'

export const BOARD_READINESS_POLICY_VERSION: BoardReadinessPolicyVersion =
  'MFS_BOARD_READINESS_G5_CAP_V1'

/**
 * Exact stage weights for MFS_DELIVERY_READINESS_V1 (AC-READY-01).
 * MAPPING 0, MAPPED 10, MAP_VERIFIED 20, BUILT 45, FUNCTIONAL 65,
 * INTEGRATED 75, STAGING_PROVEN 90, PROD_READY 100, LIVE_VERIFIED 100.
 */
export const MFS_DELIVERY_READINESS_V1_WEIGHTS: Readonly<
  Record<LifecycleStageKey, number>
> = {
  MAPPING: 0,
  MAPPED: 10,
  MAP_VERIFIED: 20,
  BUILT: 45,
  FUNCTIONAL: 65,
  INTEGRATED: 75,
  STAGING_PROVEN: 90,
  PROD_READY: 100,
  LIVE_VERIFIED: 100,
} as const

/** Ordered weight list matching LIFECYCLE_STAGE_ORDER (for AC assertions). */
export const MFS_DELIVERY_READINESS_V1_WEIGHT_LIST: ReadonlyArray<number> =
  LIFECYCLE_STAGE_ORDER.map((k) => MFS_DELIVERY_READINESS_V1_WEIGHTS[k])

export function isLifecycleStageKey(value: string): value is LifecycleStageKey {
  return (LIFECYCLE_STAGE_ORDER as ReadonlyArray<string>).includes(value)
}

/**
 * Exact task readiness weight for a stage under MFS_DELIVERY_READINESS_V1.
 * Unknown / null stage → 0 (fail-closed; does not invent progress).
 * MAPPED stays 10 even if mapping checkpoints are 20/20 (AC-READY-05).
 */
export function taskStageWeight(
  stage: string | null | undefined,
  _checkpointDone = 0,
  _checkpointTotal = 0,
): number {
  if (!stage || !isLifecycleStageKey(stage)) return 0
  // Explicit: checkpoint ratios never alter MAPPED (or any stage) weight under V1.
  return MFS_DELIVERY_READINESS_V1_WEIGHTS[stage]
}

/**
 * One-decimal mean over DISTINCT product task weights (AC-READY-02).
 * Empty set → null (caller maps to EMPTY_PRODUCT_SCOPE).
 * Never rounds a partial mean to 100 unless every weight is exactly 100
 * (display path still applies board cap separately).
 */
export function meanReadinessOneDecimal(
  weights: ReadonlyArray<number>,
): number | null {
  if (weights.length === 0) return null
  const sum = weights.reduce((a, b) => a + b, 0)
  const mean = sum / weights.length
  // One decimal place, half-up via integer math to stay deterministic.
  const oneDecimal = Math.round(mean * 10) / 10
  return oneDecimal
}

export interface BoardCapInput {
  rawTaskReadinessPercent: number | null
  g5Pass: boolean
  evidenceComplete: boolean
  hasUnclassifiedOrP0: boolean
  productDenominator: number
}

export interface BoardCapResult {
  boardReadinessPercent: number | null
  cappedBy: BoardCappedBy
  boardReadinessPolicyVersion: BoardReadinessPolicyVersion
}

/**
 * MFS_BOARD_READINESS_G5_CAP_V1 (AC-READY-03/04/07).
 * productDenominator=0 → null + EMPTY_PRODUCT_SCOPE, never 100.
 * raw would-be 100 with incomplete G5/evidence/data integrity → 99.0 + cappedBy.
 * Never round non-complete values to 100.
 */
export function applyBoardReadinessCap(input: BoardCapInput): BoardCapResult {
  const version = BOARD_READINESS_POLICY_VERSION
  if (input.productDenominator === 0 || input.rawTaskReadinessPercent == null) {
    return {
      boardReadinessPercent: null,
      cappedBy: 'EMPTY_PRODUCT_SCOPE',
      boardReadinessPolicyVersion: version,
    }
  }

  const raw = input.rawTaskReadinessPercent
  // Cap only when raw would render as 100.0 (exact complete-looking mean).
  const wouldRender100 = raw >= 100

  if (wouldRender100 && input.hasUnclassifiedOrP0) {
    return {
      boardReadinessPercent: 99.0,
      cappedBy: 'DATA_INTEGRITY_OR_P0',
      boardReadinessPolicyVersion: version,
    }
  }
  if (wouldRender100 && !input.evidenceComplete) {
    return {
      boardReadinessPercent: 99.0,
      cappedBy: 'EVIDENCE',
      boardReadinessPolicyVersion: version,
    }
  }
  if (wouldRender100 && !input.g5Pass) {
    return {
      boardReadinessPercent: 99.0,
      cappedBy: 'G5',
      boardReadinessPolicyVersion: version,
    }
  }

  // Never inflate partial readiness to 100; clamp display at raw one-decimal.
  // If raw is e.g. 99.95 but complete is false, still do not round to 100.
  let display = raw
  if (display >= 100 && !(input.g5Pass && input.evidenceComplete && !input.hasUnclassifiedOrP0)) {
    display = 99.0
  }

  return {
    boardReadinessPercent: display,
    cappedBy: null,
    boardReadinessPolicyVersion: version,
  }
}

/**
 * complete predicate (AC-READY-04 + ARCHITECTURE §6.1).
 */
export function isBoardComplete(input: {
  productDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  g5Pass: boolean
  unclassifiedCount: number
  hasP0OrDataIntegrityBlocker: boolean
}): boolean {
  return (
    input.productDenominator > 0 &&
    input.stageProdReady === input.productDenominator &&
    input.prodReadyWithEvidence === input.productDenominator &&
    input.g5Pass === true &&
    input.unclassifiedCount === 0 &&
    input.hasP0OrDataIntegrityBlocker === false
  )
}
