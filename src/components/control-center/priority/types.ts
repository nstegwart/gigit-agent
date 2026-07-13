/**
 * Prop contracts for Priority screen components.
 * All truth fields are server-derived envelopes — UI never recomputes
 * readiness, majority, share, denominators, or G5 (UI_CONTRACT §12).
 */
import type {
  BoardCappedBy,
  G5DomainId,
  G5DomainStatus,
  PriorityFrontierState,
} from '#/lib/control-plane-types'
import type { NonPriorityReasonCode, PriorityUiState } from './constants'
import { PRIORITY_PORTFOLIO_ID } from './constants'

export type { PriorityUiState, NonPriorityReasonCode }

export interface PriorityPinProps {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  taskHash?: string | null
  generatedAt?: string | null
  freshnessAgeSeconds?: number | null
  stale?: boolean
  staleReason?: string | null
}

/** Receipt-valid ACTIVE PRODUCT membership proof (server only). */
export interface PriorityMembershipProps {
  portfolioId: typeof PRIORITY_PORTFOLIO_ID
  membershipDenominator: number
  membershipTaskIds: ReadonlyArray<string>
  /** Explicit server proof that each member carried a valid classification receipt. */
  receiptValid: boolean
  /** Optional server-provided rejection counts (non-members filtered server-side). */
  excludedInvalidReceiptCount?: number | null
  excludedNonProductCount?: number | null
}

/** DISTINCT product/tracked denominators + readiness fields from rollup envelope. */
export interface PriorityRollupDenominatorsProps {
  productDenominator: number
  trackedWorkDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  unclassifiedCount: number
  productTaskIds?: ReadonlyArray<string>
  trackedTaskIds?: ReadonlyArray<string>
}

export interface PriorityReadinessProps {
  /** Server board readiness percent — null when N-A (e.g. empty product scope). */
  boardReadinessPercent: number | null
  rawTaskReadinessPercent: number | null
  complete: boolean
  cappedBy: BoardCappedBy
  g5Pass: boolean
  taskReadinessPolicyVersion?: string | null
  boardReadinessPolicyVersion?: string | null
}

export interface PriorityG5DomainRow {
  domainId: G5DomainId
  label?: string
  status: G5DomainStatus
  pass: boolean
  reason?: string | null
  evidenceReceiptIds?: ReadonlyArray<string>
  blocker?: string | null
}

export interface PriorityG5Props {
  g5Pass: boolean
  domains: ReadonlyArray<PriorityG5DomainRow>
  missingDomains?: ReadonlyArray<G5DomainId>
}

/** All-role capacity + majority share — exact false/null/N-A from server. */
export interface PriorityCapacityProps {
  portfolioId: typeof PRIORITY_PORTFOLIO_ID
  priorityClosureCapacity: number
  allClosureCapacity: number
  /** null = N-A (zero capacity / empty frontier). Never invent a number. */
  priorityCapacityShare: number | null
  /** true only when server says majority; false/null must not render as PASS. */
  majorityAllocationPass: boolean | null
  frontierState: PriorityFrontierState | string
  reason: string | null
}

export interface NonPriorityReasonItem {
  reason: string
  taskId?: string | null
  title?: string | null
  /** Server proof link / receipt id / dependency edge id. */
  proof?: string | null
  /** Optional free-text server explanation. */
  detail?: string | null
}

export interface NonPriorityReasonsProps {
  items: ReadonlyArray<NonPriorityReasonItem>
}

export interface PriorityScreenProps {
  uiState: PriorityUiState
  pin?: PriorityPinProps | null
  membership?: PriorityMembershipProps | null
  denominators?: PriorityRollupDenominatorsProps | null
  readiness?: PriorityReadinessProps | null
  g5?: PriorityG5Props | null
  capacity?: PriorityCapacityProps | null
  nonPriorityReasons?: NonPriorityReasonsProps | null
  /** Hard-failure / partial banner code from transport or authz. */
  errorCode?: string | null
  errorMessage?: string | null
  onRetry?: () => void
  /** Live region announcement coalescing key (optional). */
  liveMessage?: string | null
}
