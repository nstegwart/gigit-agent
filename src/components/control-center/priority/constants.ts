/**
 * Priority portfolio constants (UI_CONTRACT §8, ARCHITECTURE AC-PRIORITY-*).
 * Display-only — never used to recompute majority/share/readiness.
 */

export const PRIORITY_PORTFOLIO_ID = 'SALES_WEB_RELATED_BACKEND' as const

/** Dispatch outside portfolio may only cite these reasons (UI_CONTRACT §8). */
export const NON_PRIORITY_REASON_ALLOWLIST = [
  'STRICT_DIRECT_DEPENDENCY',
  'NON_DELAYING_SPARE_CAPACITY',
  'PRIORITY_FRONTIER_BLOCKED',
  'PRIORITY_FRONTIER_EXHAUSTED',
] as const

export type NonPriorityReasonCode = (typeof NON_PRIORITY_REASON_ALLOWLIST)[number]

export const NON_PRIORITY_REASON_LABELS: Readonly<Record<NonPriorityReasonCode, string>> = {
  STRICT_DIRECT_DEPENDENCY: 'Strict direct dependency',
  NON_DELAYING_SPARE_CAPACITY: 'Non-delaying spare capacity',
  PRIORITY_FRONTIER_BLOCKED: 'Priority frontier blocked',
  PRIORITY_FRONTIER_EXHAUSTED: 'Priority frontier exhausted',
}

/** UI_CONTRACT §5 required screen states. */
export type PriorityUiState =
  | 'populated'
  | 'loading'
  | 'empty'
  | 'zero-results'
  | 'partial'
  | 'stale'
  | 'disconnected'
  | 'error'
  | 'forbidden'
  | 'needs-human'

export const PRIORITY_UI_STATES: ReadonlyArray<PriorityUiState> = [
  'populated',
  'loading',
  'empty',
  'zero-results',
  'partial',
  'stale',
  'disconnected',
  'error',
  'forbidden',
  'needs-human',
] as const
