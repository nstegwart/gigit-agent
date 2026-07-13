/**
 * Prop-driven Work UI types (C3-F3).
 *
 * Display-only: every bucket / overlay / reason / reconciliation field is
 * server-sourced. Components never classify, assign buckets, or recompute
 * readiness. Route wiring and query layers live outside this package.
 */
import type {
  BlockReasonCode,
  PinnedRevisionTuple,
  PrimaryBucket,
  StaleOverlayKind,
} from '#/lib/control-plane-types'

// Re-export domain enums for consumers without pulling server code.
export type {
  BlockReasonCode,
  PinnedRevisionTuple,
  PrimaryBucket,
  StaleOverlayKind,
} from '#/lib/control-plane-types'

/** Six primary Work tabs — mutually exclusive; STALE is not a tab. */
export const WORK_PRIMARY_BUCKETS: ReadonlyArray<PrimaryBucket> = [
  'DONE',
  'RECONCILIATION_PENDING',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const

/** UI surface states required on every primary screen (UI_CONTRACT §5). */
export type WorkSurfaceState =
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

/** Server-reported run liveness for ONGOING zero-click (UI_CONTRACT §7). */
export type WorkRunLiveness = 'PRODUCTIVE' | 'IDLE' | 'STALLED' | 'EXPIRED' | string

/**
 * Reconciliation drilldown fields for RECONCILIATION_PENDING rows
 * and DONE rows with reconciliation/stale/beyond-stage overlays.
 * All values are server-supplied; UI only formats.
 */
export interface WorkReconciliationDisplay {
  runId?: string | null
  claimId?: string | null
  claimState?: string | null
  lockId?: string | null
  lockOwner?: string | null
  /** Server-labelled action, e.g. RECLAIM | RELEASE | FENCE */
  action?: string | null
  dryRun?: boolean | null
  /** ISO timestamp or server-formatted age string */
  age?: string | null
  ageSeconds?: number | null
  ownerAgentId?: string | null
  ownerRole?: string | null
  ownerMaskedAccount?: string | null
}

/** ONGOING zero-click fields (UI_CONTRACT §7) — server envelope only. */
export interface WorkOngoingDisplay {
  targetGate?: string | null
  agentId?: string | null
  role?: string | null
  model?: string | null
  effort?: string | null
  maskedAccount?: string | null
  startedAge?: string | null
  startedAgeSeconds?: number | null
  heartbeatAge?: string | null
  heartbeatAgeSeconds?: number | null
  materialProgressAge?: string | null
  materialProgressAgeSeconds?: number | null
  liveness?: WorkRunLiveness | null
  evidenceLink?: string | null
}

/** Owner humanDisplay citation (presentation wire only). */
export interface WorkOwnerCitation {
  field: string
  path: string
  note?: string
}

/**
 * Owner humanDisplay fields projected by route adapters.
 * Primary owner copy never invents; missing/unreviewed → CONTENT_REVIEW_REQUIRED shell.
 */
export interface WorkOwnerHumanFields {
  ownerPrimaryTitle?: string | null
  statusSentence?: string | null
  ownerAction?: string | null
  whyItMatters?: string | null
  next?: string | null
  blocker?: string | null
  contentReviewRequired?: boolean
  effectiveReviewStatus?: string | null
  citations?: ReadonlyArray<WorkOwnerCitation> | null
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
    citations?: ReadonlyArray<WorkOwnerCitation> | null
  } | null
}

/**
 * One work list row as served by list_work_items (or equivalent).
 * `bucket`, `overlays`, `blockReason` MUST come from the server assignment.
 */
export interface WorkItemRow extends WorkOwnerHumanFields {
  taskId: string
  /**
   * Technical/system title — secondary only.
   * Owner primary is ownerPrimaryTitle (or CONTENT_REVIEW_REQUIRED shell).
   */
  title: string
  /** Server primary bucket — never computed in the client. */
  bucket: PrimaryBucket
  /** Server overlay kinds (may include STALE_* / RECONCILIATION_DRILLDOWN / BEYOND_STAGE_ONGOING). */
  overlays: ReadonlyArray<StaleOverlayKind>
  blockReason?: BlockReasonCode | null
  /** Free-text or code reason string from server (e.g. dispatch why). */
  reason?: string | null
  projectId?: string | null
  featureContractId?: string | null
  lifecycleStage?: string | null
  updatedAt?: string | null
  /** Server-provided readiness percent string/number for display only — never recompute. */
  readinessDisplay?: string | number | null
  reconciliation?: WorkReconciliationDisplay | null
  ongoing?: WorkOngoingDisplay | null
  /** Opaque href or path for drill-down; parent supplies. */
  detailHref?: string | null
}

/** Server page / cursor state for Work list (API_CONTRACT §4). */
export interface WorkPageState {
  /** Opaque server cursor for the current page start (null = first page). */
  cursor: string | null
  nextCursor: string | null
  pageSize: number
  /** Optional server total for the active filter; null when unknown. */
  totalCount?: number | null
  /** 1-based page index when server provides it; display-only. */
  pageIndex?: number | null
  hasMore: boolean
  hasPrev?: boolean
}

/** Deep-link filter state (UI_CONTRACT §6) — boardId, bucket, overlay, cursor, pin. */
export interface WorkDeepLinkFilters {
  boardId: string
  bucket: PrimaryBucket
  /** When true, filter rows that have any STALE-family overlay (server re-validates). */
  staleOverlay: boolean
  /** Optional specific overlay kind filter (server-validated). */
  overlayKind?: StaleOverlayKind | null
  cursor: string | null
  /** Pinned revision as served (display + pin transport). */
  pinned: PinnedRevisionTuple | null
}

/** Bucket tab counts from the pinned common envelope (server rollup). */
export type WorkBucketCounts = Readonly<Record<PrimaryBucket, number>>

export interface WorkStaleOverlaySummary {
  /** Total rows with any stale-family overlay (server). */
  total: number
  byKind?: Partial<Record<StaleOverlayKind, number>>
}

export interface WorkScreenError {
  code?: string | null
  message: string
  /** Field path for field-linked errors (e.g. "filters.cursor"). */
  field?: string | null
  retryable?: boolean
}

export interface WorkScreenProps {
  /** Required surface state — parent derives from query/transport, not this package. */
  state: WorkSurfaceState
  boardId: string
  /** Active exclusive primary tab (controlled). */
  activeBucket: PrimaryBucket
  /** Server bucket counts for tab badges. */
  bucketCounts?: WorkBucketCounts | null
  staleOverlayActive: boolean
  staleSummary?: WorkStaleOverlaySummary | null
  items: ReadonlyArray<WorkItemRow>
  page: WorkPageState
  pinned: PinnedRevisionTuple | null
  /** Envelope-level stale (API common envelope). */
  envelopeStale?: boolean
  envelopeStaleReason?: string | null
  /** Partial-failure banner message when state is partial. */
  partialMessage?: string | null
  error?: WorkScreenError | null
  /** Elevated needs-human decision blurb (server). */
  needsHumanMessage?: string | null
  /** Live region announcement text (coalesced by parent if desired). */
  liveMessage?: string | null

  onBucketChange?: (bucket: PrimaryBucket) => void
  onStaleOverlayChange?: (active: boolean) => void
  onNextPage?: () => void
  onPrevPage?: () => void
  onRetry?: () => void
  onRefresh?: () => void
  onReconnect?: () => void
  onRowActivate?: (item: WorkItemRow) => void
  className?: string
}
