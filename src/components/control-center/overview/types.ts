/**
 * Prop contracts for C3 Overview presentational components.
 * All counts/membership/truth fields are server-derived; UI never recomputes them.
 * Schema aligned with UI_CONTRACT §3–§12 and API common envelope fields.
 */

import type {
  G5DomainId,
  PrimaryBucket,
  PriorityFrontierState,
  RollupV3BucketCounts,
  StaleOverlayKind,
} from '#/lib/control-plane-types'
import type { MappingVersionBannerView } from '#/lib/mapping-version-view'

/** UI_CONTRACT §5 surface states. */
export type OverviewSurfaceState =
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

export type ConnectionStatus = 'live' | 'stale' | 'disconnected' | 'unknown'

export type DecisionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export type ProductiveState = 'PRODUCTIVE' | 'IDLE' | 'STALLED'

export type PriorityNonPriorityReason =
  | 'STRICT_DIRECT_DEPENDENCY'
  | 'NON_DELAYING_SPARE_CAPACITY'
  | 'PRIORITY_FRONTIER_BLOCKED'
  | 'PRIORITY_FRONTIER_EXHAUSTED'

export interface TypedErrorShape {
  code: string
  message: string
}

export interface OverviewAppSummary {
  boardId: string
  boardLabel?: string
  liveStage: string
  /** Preformatted relative age, e.g. "12s ago" (formatting only). */
  freshnessLabel: string
  freshnessAgeSeconds?: number
  connection: ConnectionStatus
  stale?: boolean
  staleReason?: string | null
  schemaVersion?: string
  boardRev?: number
  lifecycleRev?: number
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  /**
   * Adaptive mapping version + live progress (addendum B).
   * mappingIsNotReadiness is always true — never treat as delivery readiness.
   */
  mappingVersion?: MappingVersionBannerView | null
}

/** Envelope pin for DOM data attrs — never invent. */
export interface OverviewPinMeta {
  canonicalSnapshotId: string | null
  canonicalHash: string | null
  boardRev: number | null
  lifecycleRev: number | null
}

/**
 * Overview top decision item.
 * Owner primary copy comes only from projected humanDisplay fields
 * (ownerPrimaryTitle / ownerAction / why / next / blocker / citations).
 * Missing/unreviewed → CONTENT_REVIEW_REQUIRED shell; never invent ownerAction
 * from blocking status, and never use raw technical title as owner primary.
 */
export interface OverviewDecisionItem extends OverviewOwnerHumanFields {
  decisionId: string
  /** Technical/system title — secondary only; never owner primary. */
  title: string
  /** Real question when present; null when absent (never copy title). */
  question: string | null
  severity: DecisionSeverity
  blocking: boolean
  /**
   * Owner action from projected humanDisplay only (may be empty string when
   * absent). Presentation must not invent "Resolve blocking decision" etc.
   */
  ownerAction: string
  status?: string
  dueAtLabel?: string | null
  options?: Array<{ optionId: string; label: string }>
}

export interface OverviewDecisionSection {
  count: number
  topSeverity: DecisionSeverity | null
  topItem: OverviewDecisionItem | null
  items?: OverviewDecisionItem[]
}

export interface OverviewPriorityCard {
  portfolioId: 'SALES_WEB_RELATED_BACKEND'
  membershipDenominator: number
  productDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  g5Pass: boolean
  complete: boolean
  priorityCapacityShare: number | null
  majorityAllocationPass: boolean | null
  frontierState: PriorityFrontierState
  /** Exact N-A semantics when capacity=0 or frontier empty — server string. */
  capacityShareDisplay: string
  majorityDisplay: string
  dispatchReason?: string | null
  nonPriorityReason?: PriorityNonPriorityReason | null
  /** Plain-language (id-ID) sentences — never a raw `CODE: message` string. */
  blockers?: string[]
  /** Raw code/message pairs backing `blockers`, for technical disclosure only. */
  blockersDetail?: TypedErrorShape[]
}

export interface OverviewGlobalCard {
  trackedWorkDenominator: number
  productDenominator: number
  stageProdReady: number
  prodReadyWithEvidence: number
  g5Pass: boolean
  complete: boolean
  boardReadinessPercent: number | null
  cappedBy?: string | null
}

export interface OverviewBucketStrip {
  /** Server DISTINCT counts for the six exclusive primaries. */
  counts: RollupV3BucketCounts
  /** Active tab (mutually exclusive). */
  activeBucket?: PrimaryBucket | null
  /** STALE is overlay, not a primary. */
  staleCount: number
  staleActive?: boolean
  overlayBreakdown?: Partial<Record<StaleOverlayKind, number>>
  onSelectBucket?: (bucket: PrimaryBucket) => void
  onToggleStale?: () => void
}

/** Owner humanDisplay citation (presentation wire only). */
export interface OverviewOwnerCitation {
  field: string
  path: string
  note?: string
}

/**
 * Owner humanDisplay fields projected by route adapters.
 * Primary owner copy never invents; missing/unreviewed → CONTENT_REVIEW_REQUIRED shell.
 */
export interface OverviewOwnerHumanFields {
  ownerPrimaryTitle?: string | null
  statusSentence?: string | null
  ownerAction?: string | null
  whyItMatters?: string | null
  next?: string | null
  blocker?: string | null
  contentReviewRequired?: boolean
  effectiveReviewStatus?: string | null
  citations?: ReadonlyArray<OverviewOwnerCitation> | null
  /** Nested projection wire when adapter attaches full ownerHumanDisplay object. */
  ownerHumanDisplay?: {
    ownerPrimaryTitle?: string | null
    statusSentence?: string | null
    ownerAction?: string | null
    whyItMatters?: string | null
    next?: string | null
    blocker?: string | null
    contentReviewRequired?: boolean
    effectiveReviewStatus?: string | null
    citations?: ReadonlyArray<OverviewOwnerCitation> | null
  } | null
}

export interface OverviewOngoingItem extends OverviewOwnerHumanFields {
  taskId: string
  /**
   * Technical/system title — secondary only.
   * Owner primary is ownerPrimaryTitle (or CONTENT_REVIEW_REQUIRED shell).
   */
  title: string
  targetGate: string
  agentId: string
  role: string
  model: string
  effort: string
  /** Masked only — never credential. */
  maskedAccount: string
  startedAge: string
  heartbeatAge: string
  materialProgressAge: string
  productiveState: ProductiveState
  evidenceLabel: string
  evidenceHref?: string | null
}

export interface OverviewProjectSummary {
  projectId: string
  name: string
  statusLabel?: string
  bucketHint?: string
  count?: number
}

export interface OverviewLifecycleSummary {
  stage: string
  count: number
}

export interface OverviewG5Summary {
  g5Pass: boolean
  domains: Array<{
    domainId: G5DomainId | string
    label: string
    status: string
    pass: boolean
  }>
}

export interface OverviewMaterialEvent {
  eventId: string
  atLabel: string
  kind: string
  summary: string
  actor?: string
}

export interface OverviewLowerPanels {
  projects: OverviewProjectSummary[]
  lifecycle: OverviewLifecycleSummary[]
  g5: OverviewG5Summary | null
  decisionCount: number
  materialEvents: OverviewMaterialEvent[]
}

export interface OverviewProps {
  surfaceState: OverviewSurfaceState
  appSummary: OverviewAppSummary | null
  /** Envelope pin meta for root data attrs (browser evidence). */
  pin?: OverviewPinMeta | null
  decision: OverviewDecisionSection | null
  priority: OverviewPriorityCard | null
  global: OverviewGlobalCard | null
  buckets: OverviewBucketStrip | null
  /** Server-ordered ONGOING list (stalled first already applied). */
  ongoing: OverviewOngoingItem[]
  lower: OverviewLowerPanels | null
  partialErrors?: TypedErrorShape[]
  error?: TypedErrorShape | null
  onRetry?: () => void
  onReconnect?: () => void
  /** Controlled sticky pill collapse (mobile). */
  pillCollapsed?: boolean
  onPillExpand?: () => void
  onPillCollapse?: () => void
  enableStickyPill?: boolean
  /** Live region announcements — coalesced by parent if needed. */
  liveMessage?: string | null
  className?: string
}

export const PRIMARY_BUCKETS: ReadonlyArray<PrimaryBucket> = [
  'DONE',
  'RECONCILIATION_PENDING',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const

export const BUCKET_LABELS: Readonly<Record<PrimaryBucket, string>> = {
  DONE: 'DONE',
  RECONCILIATION_PENDING: 'RECONCILIATION_PENDING',
  ONGOING: 'ONGOING',
  NEXT: 'NEXT',
  QUEUED: 'QUEUED',
  BLOCKED: 'BLOCKED',
}
