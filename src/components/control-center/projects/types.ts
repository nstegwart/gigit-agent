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
