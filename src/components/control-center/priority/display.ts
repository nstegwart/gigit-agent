/**
 * Presentation-only helpers. Never invent majority PASS, readiness 100, or complete=true.
 */
import {
  NON_PRIORITY_REASON_ALLOWLIST,
  NON_PRIORITY_REASON_LABELS,
  type NonPriorityReasonCode,
} from './constants'

/** Literal N-A token for null/undefined capacity share and majority. */
export const NA_TOKEN = 'N-A' as const

/**
 * Majority display: true → "PASS", false → "FAIL", null/undefined → "N-A".
 * Never maps null/false to PASS.
 */
export function formatMajorityAllocationPass(
  value: boolean | null | undefined,
): 'PASS' | 'FAIL' | typeof NA_TOKEN {
  if (value === true) return 'PASS'
  if (value === false) return 'FAIL'
  return NA_TOKEN
}

/**
 * Share display: null → N-A; number → fixed fraction (server exact, no recompute).
 */
export function formatCapacityShare(
  share: number | null | undefined,
  fractionDigits = 4,
): string {
  if (share === null || share === undefined || Number.isNaN(share)) return NA_TOKEN
  return share.toFixed(fractionDigits)
}

/**
 * Readiness percent: null → N-A; never coerce empty-scope null into 100.
 */
export function formatReadinessPercent(
  value: number | null | undefined,
  fractionDigits = 1,
): string {
  if (value === null || value === undefined || Number.isNaN(value)) return NA_TOKEN
  return value.toFixed(fractionDigits)
}

export function formatCappedBy(cappedBy: string | null | undefined): string {
  if (cappedBy === null || cappedBy === undefined || cappedBy === '') return NA_TOKEN
  return cappedBy
}

export function formatBoolean(value: boolean | null | undefined): string {
  if (value === true) return 'true'
  if (value === false) return 'false'
  return NA_TOKEN
}

export function isAllowlistedNonPriorityReason(
  reason: string,
): reason is NonPriorityReasonCode {
  return (NON_PRIORITY_REASON_ALLOWLIST as ReadonlyArray<string>).includes(reason)
}

export function labelNonPriorityReason(reason: string): string {
  if (isAllowlistedNonPriorityReason(reason)) {
    return NON_PRIORITY_REASON_LABELS[reason]
  }
  return reason
}

/**
 * Filter to allowlisted reasons only — unknown codes are excluded from UI proof list
 * (server must not emit them; UI fail-closes by not rendering as justified).
 */
export function filterAllowlistedReasons<T extends { reason: string }>(
  items: ReadonlyArray<T>,
): { allowed: T[]; rejected: T[] } {
  const allowed: T[] = []
  const rejected: T[] = []
  for (const item of items) {
    if (isAllowlistedNonPriorityReason(item.reason)) allowed.push(item)
    else rejected.push(item)
  }
  return { allowed, rejected }
}

export function majoritySemanticClass(
  value: boolean | null | undefined,
): 'pass' | 'fail' | 'na' {
  if (value === true) return 'pass'
  if (value === false) return 'fail'
  return 'na'
}
