/**
 * Prop contracts for Projects list (UI_CONTRACT §2 screen 4).
 * Presentation-only: counts/order come from the pinned projects envelope.
 */

export type ProjectsSurfaceState =
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

export interface ProjectsPinView {
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

export interface ProjectRowView {
  projectId: string
  name: string
  status: string | null
  taskCount: number
  doneCount: number
  blockedCount: number
  /**
   * Server mean readiness over PRODUCT tasks with proven stage (null = no proof).
   * Never client-computed.
   */
  readinessPercent: number | null
  /** Server highest-weight proven lifecycle stage; null without proof. */
  readinessStage: string | null
  /**
   * true when every readiness-eligible PRODUCT task has pin-bound stage evidence;
   * false when any lacks evidence; null when no eligible tasks.
   */
  readinessEvidenceOk: boolean | null
  /** Legacy detail route — must keep working. */
  detailHref: string
}

export interface ProjectsScreenProps {
  surfaceState: ProjectsSurfaceState
  boardId: string
  projects: ProjectRowView[]
  productDenominator: number | null
  bucketCounts: Readonly<Record<string, number>> | null
  pin: ProjectsPinView | null
  error?: { code: string; message: string } | null
  projectionGaps?: string[]
  liveMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  className?: string
}
