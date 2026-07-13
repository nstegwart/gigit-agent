/**
 * Prop contracts for Ops/Accounts (UI_CONTRACT §2 screen 7).
 * Masked identity only — never tokens/raw account secrets.
 */

export type OpsSurfaceState =
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

export interface OpsPinView {
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

export interface OpsAccountRowView {
  maskedAccountId: string
  status: string
  providerKind: string | null
  effectiveInUse: number
  effectiveCap: number
  physicalSlotsDisplay: string | null
  quarantine: boolean
  isLimit: boolean
  isTombstone: boolean
  reason: string | null
  capacityLabel: string
}

export interface OpsScreenProps {
  surfaceState: OpsSurfaceState
  boardId: string
  accounts: OpsAccountRowView[]
  usableCapacity: number | null
  quarantineCount: number | null
  accountSyncStale: boolean
  capacityNote: string | null
  /**
   * Account-sync sourceRevision from OpsData (never boardRev).
   * null/absent when server did not project an authoritative account-sync revision.
   */
  accountSourceRevision?: number | null
  pin: OpsPinView | null
  error?: { code: string; message: string } | null
  projectionGaps?: string[]
  liveMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  className?: string
}
