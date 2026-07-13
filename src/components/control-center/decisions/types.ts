/**
 * Prop contracts for Decisions inbox (UI_CONTRACT §5, §9).
 * Presentation-only: order and membership come from the pinned decisions envelope.
 * Optional richer fields may be absent when genuinely missing on the source record —
 * render honest partial slots; never invent epoch/placeholder values.
 */

export type DecisionsSurfaceState =
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

export type DecisionSeverity = 'CRITICAL' | 'HIGH' | 'MEDIUM' | 'LOW'

export type DecisionStatus =
  | 'OPEN'
  | 'ACKNOWLEDGED'
  | 'RESOLVED'
  | 'REJECTED'
  | 'EXPIRED'
  | 'CANCELLED'
  | string

export interface DecisionOptionView {
  optionId: string
  label: string
  tradeoffs?: string | null
  /** Declining option selected ⇒ status RESOLVED, not REJECTED. */
  declining?: boolean
}

/** Owner humanDisplay projection (fail-closed CONTENT_REVIEW_REQUIRED). */
export interface DecisionOwnerHumanDisplayView {
  contentReviewRequired: boolean
  effectiveReviewStatus: string
  ownerPrimaryTitle: string
  statusSentence: string
  ownerAction: string
  whyItMatters: string
  next: string
  blocker: string
}

export type DecisionActionKind =
  | 'acknowledge'
  | 'resolve'
  | 'reject'
  | 'snooze'

export interface DecisionActionError {
  code: string
  message: string
  action?: DecisionActionKind
}

/** Payload for owner decision mutations (CAS revs from the row/pin + full envelope). */
export interface DecisionActionPayload {
  boardId: string
  decisionId: string
  /** CAS on decision.entityRev (entityExpectedRev alias on server). */
  expectedRev: number
  expectedBoardRev: number
  /**
   * Pin hash from the decisions envelope when the owner acted.
   * Route injects when absent; server compares to current pin.
   */
  canonicalHash?: string
  /**
   * 24h stable idempotency key for this action intent.
   * Route emits when absent (unique per action + revs + hash).
   */
  idempotencyKey?: string
  selectedOptionId?: string
  snoozedUntil?: string
  comment?: string | null
}

export interface DecisionActionHandlers {
  onAcknowledge?: (payload: DecisionActionPayload) => void | Promise<void>
  onResolve?: (payload: DecisionActionPayload) => void | Promise<void>
  onReject?: (payload: DecisionActionPayload) => void | Promise<void>
  onSnooze?: (payload: DecisionActionPayload) => void | Promise<void>
}

export interface DecisionItemView {
  decisionId: string
  title: string
  /** When null, UI shows honest "not projected" partial. */
  question: string | null
  severity: DecisionSeverity
  blocking: boolean
  status: DecisionStatus
  dueAt: string | null
  createdAt: string
  snoozedUntil: string | null
  type: string
  /** Evidence receipt ids or labels from server; empty = honest empty. */
  evidence: string[]
  options: DecisionOptionView[]
  recommendation: string | null
  ownerId: string | null
  resolverId: string | null
  selectedOptionId: string | null
  expectedRev: number | null
  boardRev: number | null
  entityRev: number | null
  scopedApprovalId: string | null
  auditIds: string[]
  projectId?: string | null
  featureId?: string | null
  taskId?: string | null
  runId?: string | null
  /** Presentational owner action labels (not authority grants). */
  ownerActions: string[]
  /** True when one or more rich public fields are genuinely absent. */
  partialFields: boolean
  /** Which fields are absent (for diagnostics); empty when complete. */
  absentFields?: string[]
  /** Owner humanDisplay from DTO; fail closed when missing. */
  ownerHumanDisplay?: DecisionOwnerHumanDisplayView | null
  ownerPrimaryTitle?: string | null
  statusSentence?: string | null
  whyItMatters?: string | null
  next?: string | null
  blocker?: string | null
  contentReviewRequired?: boolean
  effectiveReviewStatus?: string
}

export interface DecisionsPinView {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  stale: boolean
  staleReason: string | null
}

export interface DecisionsScreenProps {
  surfaceState: DecisionsSurfaceState
  boardId: string
  items: DecisionItemView[]
  openCount: number
  blockingCount: number
  pageSize: number
  nextCursor: string | null
  pin: DecisionsPinView | null
  error?: { code: string; message: string } | null
  /** Server contract gaps the UI is honestly exposing (not invented fields). */
  projectionGaps?: string[]
  liveMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  className?: string
  /** When false, action buttons render disabled (read-only principal). */
  canAct?: boolean
  /** Which decisionId is currently mutating (pending UI). */
  pendingDecisionId?: string | null
  pendingAction?: DecisionActionKind | null
  /** Per-decision last action error (forbidden/stale/invalid). */
  actionErrors?: Readonly<Record<string, DecisionActionError>>
  actions?: DecisionActionHandlers
}
