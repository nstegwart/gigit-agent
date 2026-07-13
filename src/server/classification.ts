// Pure classification domain (C1). No I/O / DB.
// contributesToProductReadiness is ALWAYS server-derived — never trust caller write.

import type {
  ClassificationEvaluation,
  ClassificationInvalidReason,
  ClassificationReceipt,
  PinnedRevisionTuple,
  TaskClass,
  TaskClassificationRecord,
  TaskDisposition,
} from '#/lib/control-plane-types'
import {
  TASK_CLASSES,
  TASK_DISPOSITIONS,
} from '#/lib/control-plane-types'

const RECEIPT_HASH_RE = /^[a-f0-9]{16,128}$/i

export function isTaskClass(value: unknown): value is TaskClass {
  return typeof value === 'string' && (TASK_CLASSES as ReadonlyArray<string>).includes(value)
}

export function isTaskDisposition(value: unknown): value is TaskDisposition {
  return (
    typeof value === 'string' &&
    (TASK_DISPOSITIONS as ReadonlyArray<string>).includes(value)
  )
}

function pinMatches(
  receipt: ClassificationReceipt,
  pin: PinnedRevisionTuple,
  reasons: Array<ClassificationInvalidReason>,
): void {
  if (receipt.canonicalSnapshotId !== pin.canonicalSnapshotId) {
    reasons.push('STALE_CANONICAL_SNAPSHOT')
  }
  if (receipt.canonicalHash !== pin.canonicalHash) {
    reasons.push('STALE_CANONICAL_HASH')
  }
  if (receipt.taskHash !== pin.taskHash) {
    reasons.push('STALE_TASK_HASH')
  }
  if (receipt.boardRev !== pin.boardRev) {
    reasons.push('STALE_BOARD_REV')
  }
  if (receipt.lifecycleRev !== pin.lifecycleRev) {
    reasons.push('STALE_LIFECYCLE_REV')
  }
}

/**
 * Resolve evaluation clock.
 * - Default: real current server time (epoch / disable-expiry is forbidden).
 * - Deterministic tests may inject `opts.now` as an ISO timestamp.
 * - Invalid injected time → null (caller must fail closed).
 */
function resolveEvaluationNow(opts: { now?: string } = {}): string | null {
  if (opts.now !== undefined) {
    if (typeof opts.now !== 'string' || opts.now.trim() === '') return null
    const ms = Date.parse(opts.now)
    if (Number.isNaN(ms)) return null
    return new Date(ms).toISOString()
  }
  return new Date().toISOString()
}

/**
 * Fail-closed classification evaluation (AC-CLASS-01..05).
 * Missing/stale/invalid receipt → repair row, tracked once as BLOCKED:DATA_INTEGRITY.
 * Only fully valid classified HOLD/EXCLUDE is outside tracked work.
 * Receipt expiry is checked against real server time by default.
 */
export function evaluateClassification(
  record: TaskClassificationRecord | null | undefined,
  pin: PinnedRevisionTuple,
  opts: { now?: string } = {},
): ClassificationEvaluation {
  const now = resolveEvaluationNow(opts)
  const clockInvalid = now === null

  if (!record) {
    return {
      taskId: '',
      taskClass: 'UNCLASSIFIED',
      disposition: 'UNCLASSIFIED',
      contributesToProductReadiness: false,
      isFullyClassifiedValid: false,
      isClassificationRepair: true,
      isOutsideTrackedWork: false,
      valid: false,
      reasons: ['MISSING_RECORD'],
      blockReason: 'DATA_INTEGRITY',
    }
  }

  const taskId = record.taskId
  const reasons: Array<ClassificationInvalidReason> = []

  // Invalid injected clock fails closed (no silent epoch / open window).
  if (clockInvalid) {
    reasons.push('STALE_RECEIPT_EXPIRED')
  }

  if (!isTaskClass(record.taskClass)) {
    reasons.push('INVALID_TASK_CLASS')
  }
  if (!isTaskDisposition(record.disposition)) {
    reasons.push('INVALID_DISPOSITION')
  }

  const taskClass: TaskClass = isTaskClass(record.taskClass)
    ? record.taskClass
    : 'UNCLASSIFIED'
  const disposition: TaskDisposition = isTaskDisposition(record.disposition)
    ? record.disposition
    : 'UNCLASSIFIED'

  if (taskClass === 'UNCLASSIFIED') reasons.push('UNCLASSIFIED_TASK_CLASS')
  if (disposition === 'UNCLASSIFIED') reasons.push('UNCLASSIFIED_DISPOSITION')

  const receipt = record.receipt
  if (!receipt) {
    reasons.push('MISSING_RECEIPT')
  } else {
    if (!receipt.receiptId || !receipt.receiptHash) {
      reasons.push('INVALID_RECEIPT_HASH')
    } else if (!RECEIPT_HASH_RE.test(receipt.receiptHash)) {
      reasons.push('INVALID_RECEIPT_HASH')
    }
    if (receipt.taskId !== taskId) reasons.push('RECEIPT_TASK_MISMATCH')
    if (receipt.taskClass !== taskClass) reasons.push('RECEIPT_CLASS_MISMATCH')
    if (receipt.disposition !== disposition) reasons.push('RECEIPT_DISPOSITION_MISMATCH')
    pinMatches(receipt, pin, reasons)
    // Compare against real (or injected-valid) server time — never epoch-disable.
    if (!clockInvalid && receipt.expiresAt) {
      const expMs = Date.parse(receipt.expiresAt)
      if (Number.isNaN(expMs) || expMs < Date.parse(now!)) {
        reasons.push('STALE_RECEIPT_EXPIRED')
      }
    }
  }

  // Deduplicate reasons while preserving order
  const uniqReasons = [...new Set(reasons)]
  const valid = uniqReasons.length === 0

  const isFullyClassifiedValid =
    valid && taskClass !== 'UNCLASSIFIED' && disposition !== 'UNCLASSIFIED'

  // AC-CLASS-05: any UNCLASSIFIED or invalid receipt is classification repair
  // even when disposition is HOLD/EXCLUDE.
  const isClassificationRepair = !isFullyClassifiedValid

  const isOutsideTrackedWork =
    isFullyClassifiedValid && (disposition === 'HOLD' || disposition === 'EXCLUDE')

  // Membership proof required for product contribution (AC-CLASS-03 / PRIORITY-01).
  // PRODUCT+ACTIVE needs valid receipt; membership hash optional unless portfolio-bound.
  // contributesToProductReadiness NEVER accepts caller-written value.
  const contributesToProductReadiness =
    isFullyClassifiedValid &&
    taskClass === 'PRODUCT' &&
    disposition === 'ACTIVE'

  return {
    taskId,
    taskClass,
    disposition,
    contributesToProductReadiness,
    isFullyClassifiedValid,
    isClassificationRepair,
    isOutsideTrackedWork,
    valid,
    reasons: uniqReasons,
    blockReason: isClassificationRepair ? 'DATA_INTEGRITY' : null,
  }
}

/**
 * Server-derived contribution flag (AC-CLASS-03).
 * Explicitly ignores any caller-supplied contributesToProductReadiness.
 */
export function contributesToProductReadiness(
  record: TaskClassificationRecord | null | undefined,
  pin: PinnedRevisionTuple,
  opts: { now?: string } = {},
): boolean {
  // Strip caller write before evaluation — contribution is read-only derived.
  if (record && 'contributesToProductReadiness' in record) {
    const { contributesToProductReadiness: _ignored, ...rest } = record
    return evaluateClassification(rest, pin, opts).contributesToProductReadiness
  }
  return evaluateClassification(record, pin, opts).contributesToProductReadiness
}

/**
 * Whether a task enters trackedWorkDenominator (AC-BUCKET-06 / AC-CLASS-05).
 * ACTIVE dispositions + classification-repair rows once; valid HOLD/EXCLUDE out.
 */
export function isTrackedWork(
  evaluation: ClassificationEvaluation,
): boolean {
  if (evaluation.isOutsideTrackedWork) return false
  if (evaluation.isClassificationRepair) return true
  return evaluation.disposition === 'ACTIVE'
}

/**
 * productDenominator membership (AC-CLASS-04).
 */
export function isProductDenominatorMember(
  evaluation: ClassificationEvaluation,
): boolean {
  return evaluation.contributesToProductReadiness
}
