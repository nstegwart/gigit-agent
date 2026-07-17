/**
 * Prop contracts for Agents/Runs (UI_CONTRACT §2 screen 6, §7 zero-click).
 * Presentation-only: server order preserved; no client stall re-sort.
 */

export type AgentsSurfaceState =
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

export type ProductiveSubstateView = 'PRODUCTIVE' | 'IDLE' | 'STALLED' | null

export interface AgentsPinView {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
}

/**
 * Owner humanDisplay projection (fail-closed).
 * Adapter may leave fields null — screen falls back cleanly; never invents copy.
 */
export interface AgentOwnerHumanDisplayView {
  ownerPrimaryTitle?: string | null
  statusSentence?: string | null
  ownerAction?: string | null
  whyItMatters?: string | null
  next?: string | null
  blocker?: string | null
  contentReviewRequired?: boolean
  effectiveReviewStatus?: string | null
}

/** Zero-click ONGOING row — ages already formatted from server seconds. */
export interface AgentOngoingRowView extends AgentOwnerHumanDisplayView {
  taskId: string
  title: string
  targetGate: string
  agentId: string
  role: string
  model: string | null
  effort: string | null
  maskedAccount: string
  startedAge: string
  heartbeatAge: string
  materialProgressAge: string
  productiveSubstate: ProductiveSubstateView
  evidenceLink: string | null
  taskHref: string
  overlays: string[]
}

export interface AgentRunRowView {
  runId: string
  taskId: string | null
  agentId: string | null
  role: string | null
  model: string | null
  effort: string | null
  maskedAccount: string
  status: string | null
  startedAt: string | null
  heartbeatAt: string | null
  materialProgressAt: string | null
  productiveSubstate: ProductiveSubstateView
  taskHref: string | null
  /** Server claim authority when present on RunUiSummary. */
  claimState: string | null
  /** Collision-scope lock ids from durable ownership (never invent). */
  lockIds: string[]
  controllerRunId: string | null
  parentRunId: string | null
}

export interface AgentsScreenProps {
  surfaceState: AgentsSurfaceState
  boardId: string
  ongoing: AgentOngoingRowView[]
  runs: AgentRunRowView[]
  pageSize: number
  nextCursor: string | null
  pin: AgentsPinView | null
  error?: { code: string; message: string } | null
  projectionGaps?: string[]
  liveMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  onNextPage?: () => void
  className?: string
}
