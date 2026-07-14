/**
 * Pure deep-link encode/decode for Work filters (UI_CONTRACT §6).
 * Parent route owns URL search params; this module only serializes state.
 * Server re-validates every filter — client never invents membership.
 */
import type { PrimaryBucket, PinnedRevisionTuple, StaleOverlayKind } from '#/lib/control-plane-types'
import { WORK_PRIMARY_BUCKETS, type WorkDeepLinkFilters } from './types'

const BUCKET_SET = new Set<string>(WORK_PRIMARY_BUCKETS)

export interface WorkSearchParamsLike {
  bucket?: string | null
  overlay?: string | null
  stale?: string | null
  cursor?: string | null
  boardRev?: string | null
  lifecycleRev?: string | null
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  taskHash?: string | null
  /** S24 free-text work query (client display filter; server re-validates membership). */
  query?: string | null
}

/**
 * S08: ART token RECONCILIATION maps to product primary bucket RECONCILIATION_PENDING.
 * Mirrors human-display normalizeStatusBucket — never invents a 7th primary tab.
 */
export function normalizeWorkBucketToken(value: unknown): string | null {
  if (typeof value !== 'string' || value.length === 0) return null
  const upper = value.toUpperCase()
  if (upper === 'RECONCILIATION') return 'RECONCILIATION_PENDING'
  return value
}

export function isPrimaryBucket(value: unknown): value is PrimaryBucket {
  if (typeof value !== 'string') return false
  const normalized = normalizeWorkBucketToken(value)
  return normalized != null && BUCKET_SET.has(normalized)
}

export function parseWorkDeepLink(
  boardId: string,
  params: WorkSearchParamsLike,
  defaults: { bucket?: PrimaryBucket } = {},
): WorkDeepLinkFilters {
  const normalizedBucket = normalizeWorkBucketToken(params.bucket)
  const bucket =
    normalizedBucket && isPrimaryBucket(normalizedBucket)
      ? normalizedBucket
      : (defaults.bucket ?? 'ONGOING')
  const staleRaw = params.stale
  const staleOverlay =
    staleRaw === '1' ||
    staleRaw === 'true' ||
    staleRaw === 'STALE' ||
    (typeof params.overlay === 'string' && params.overlay.toUpperCase().startsWith('STALE'))

  const overlayKind =
    typeof params.overlay === 'string' && params.overlay.length > 0
      ? (params.overlay as StaleOverlayKind)
      : null

  let pinned: PinnedRevisionTuple | null = null
  const boardRev = params.boardRev != null ? Number(params.boardRev) : NaN
  const lifecycleRev = params.lifecycleRev != null ? Number(params.lifecycleRev) : NaN
  if (
    params.canonicalSnapshotId &&
    params.canonicalHash &&
    params.taskHash &&
    Number.isFinite(boardRev) &&
    Number.isFinite(lifecycleRev)
  ) {
    pinned = {
      canonicalSnapshotId: params.canonicalSnapshotId,
      canonicalHash: params.canonicalHash,
      taskHash: params.taskHash,
      boardRev,
      lifecycleRev,
    }
  }

  const query =
    typeof params.query === 'string' && params.query.trim().length > 0
      ? params.query.trim()
      : null

  return {
    boardId,
    bucket,
    staleOverlay,
    overlayKind,
    cursor: params.cursor && params.cursor.length > 0 ? params.cursor : null,
    pinned,
    query,
  }
}

/** Encode Work deep-link filters into a plain search-param record (no `?`). */
export function encodeWorkDeepLink(filters: WorkDeepLinkFilters): Record<string, string> {
  const out: Record<string, string> = {
    bucket: filters.bucket,
  }
  if (filters.staleOverlay) out.stale = '1'
  if (filters.overlayKind) out.overlay = filters.overlayKind
  if (filters.cursor) out.cursor = filters.cursor
  if (filters.query) out.query = filters.query
  if (filters.pinned) {
    out.boardRev = String(filters.pinned.boardRev)
    out.lifecycleRev = String(filters.pinned.lifecycleRev)
    out.canonicalSnapshotId = filters.pinned.canonicalSnapshotId
    out.canonicalHash = filters.pinned.canonicalHash
    out.taskHash = filters.pinned.taskHash
  }
  return out
}

/** Build a relative path for deep-linking (parent may wrap with router). */
export function workDeepLinkPath(filters: WorkDeepLinkFilters): string {
  const q = new URLSearchParams(encodeWorkDeepLink(filters))
  return `/b/${encodeURIComponent(filters.boardId)}/work?${q.toString()}`
}
