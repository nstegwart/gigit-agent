/**
 * Prop contracts for Features list (UI_CONTRACT §2 screen 5).
 * Presentation-only: order/pagination from pinned features envelope.
 */

export type FeaturesSurfaceState =
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

export type FeatureFlowBranch = 'success' | 'fail' | 'expired' | 'open' | null

export interface FeaturesPinView {
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

export interface FeatureRowView {
  featureId: string
  projectId: string | null
  name: string
  phase: string | null
  flowBranch: FeatureFlowBranch
  taskCount: number
  detailHref: string
  projectHref: string | null
  /** Server-derived flow context — empty when source truth absent (never invent). */
  pageRoutes: string[]
  apiEndpoints: string[]
  logicRules: string[]
  dataContext: string[]
  geoVariants: string[]
  providerVariants: string[]
  sideEffectsReadback: string[]
  /** Always empty when projector has no style source (honest null → []). */
  styleContext: string[]
}

export interface FeaturesScreenProps {
  surfaceState: FeaturesSurfaceState
  boardId: string
  features: FeatureRowView[]
  pageSize: number
  nextCursor: string | null
  pin: FeaturesPinView | null
  error?: { code: string; message: string } | null
  projectionGaps?: string[]
  liveMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  onNextPage?: () => void
  className?: string
}
