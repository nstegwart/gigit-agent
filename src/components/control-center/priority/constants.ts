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

/**
 * Owner-facing id-ID sentences for allowlisted non-priority dispatch reasons
 * (UI_CONTRACT §8). Raw codes remain secondary (title / Detail teknis).
 */
export const NON_PRIORITY_REASON_LABELS: Readonly<Record<NonPriorityReasonCode, string>> = {
  STRICT_DIRECT_DEPENDENCY:
    'Dikerjakan di luar prioritas karena ketergantungan langsung yang ketat ke tugas prioritas.',
  NON_DELAYING_SPARE_CAPACITY:
    'Dikerjakan dari kapasitas cadangan yang tidak menunda pekerjaan prioritas.',
  PRIORITY_FRONTIER_BLOCKED:
    'Dikerjakan di luar prioritas karena frontier prioritas sedang terhambat.',
  PRIORITY_FRONTIER_EXHAUSTED:
    'Dikerjakan di luar prioritas karena frontier prioritas sudah habis.',
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
