/**
 * Control-center Priority components (C3-F4).
 * Prop-driven SALES_WEB_RELATED_BACKEND surfaces — no route wiring.
 */

export { PRIORITY_PORTFOLIO_ID, NON_PRIORITY_REASON_ALLOWLIST, PRIORITY_UI_STATES } from './constants'
export type { NonPriorityReasonCode, PriorityUiState } from './constants'

export {
  formatMajorityAllocationPass,
  formatCapacityShare,
  formatReadinessPercent,
  formatCappedBy,
  formatBoolean,
  isAllowlistedNonPriorityReason,
  filterAllowlistedReasons,
  majoritySemanticClass,
  humanPortfolioLabel,
  humanFrontierState,
  humanCappedBy,
  humanCapacityReason,
  humanMajorityAllocation,
  humanG5Status,
  humanG5DomainLabel,
  NA_TOKEN,
  PORTFOLIO_HUMAN_LABEL,
  G5_DOMAIN_HUMAN_LABELS,
} from './display'

export type {
  PriorityPinProps,
  PriorityMembershipProps,
  PriorityRollupDenominatorsProps,
  PriorityReadinessProps,
  PriorityG5DomainRow,
  PriorityG5Props,
  PriorityCapacityProps,
  NonPriorityReasonItem,
  NonPriorityReasonsProps,
  PriorityScreenProps,
} from './types'

export { PriorityScreen } from './PriorityScreen'
export { PriorityStateShell } from './PriorityStateShell'
export { PriorityMembershipPanel } from './PriorityMembershipPanel'
export { PriorityDenominatorsPanel } from './PriorityDenominatorsPanel'
export { PriorityReadinessPanel } from './PriorityReadinessPanel'
export { PriorityG5Panel } from './PriorityG5Panel'
export { PriorityCapacityPanel } from './PriorityCapacityPanel'
export { NonPriorityReasonsPanel } from './NonPriorityReasonsPanel'
