// Control-center Work surface — six exclusive buckets + STALE overlay + deep links.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState } from 'react'
import { z } from 'zod'

import {
  WorkScreen,
  parseWorkDeepLink,
  isPrimaryBucket,
  type WorkItemRow,
  type WorkBucketCounts,
} from '#/components/control-center/work'
import type { PrimaryBucket } from '#/components/control-center/work'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  overviewQueryOptions,
  workQueryOptions,
} from '#/lib/control-center-query'
import { workEnvelopeToProps } from '#/lib/control-center-route-adapters'
import type { StaleOverlayKind } from '#/lib/control-plane-types'

/**
 * Coerce raw URL search values so `?stale=1` (number) does not crash zod string schemas.
 * Invalid shapes → undefined (deterministic omit), never throw.
 * Canonical UI truth for stale remains boolean via parseWorkDeepLink — not client buckets.
 */
export function coerceWorkSearchString(value: unknown): string | undefined {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return String(value)
  if (typeof value === 'boolean') return value ? 'true' : 'false'
  // bigint / other primitives that string cleanly
  if (typeof value === 'bigint') return String(value)
  return undefined
}

const optionalWorkSearchString = z.preprocess(
  (v) => coerceWorkSearchString(v),
  z.string().optional(),
)

export const workSearchSchema = z.object({
  bucket: optionalWorkSearchString,
  overlay: optionalWorkSearchString,
  stale: optionalWorkSearchString,
  cursor: optionalWorkSearchString,
  boardRev: optionalWorkSearchString,
  lifecycleRev: optionalWorkSearchString,
  canonicalSnapshotId: optionalWorkSearchString,
  canonicalHash: optionalWorkSearchString,
  taskHash: optionalWorkSearchString,
  pin: optionalWorkSearchString,
  /** S24 ART free-text query; empty match → zero-results surface. */
  query: optionalWorkSearchString,
})

export type WorkRouteSearch = z.infer<typeof workSearchSchema>

/**
 * Deterministic Work search parse for route validateSearch + unit tests.
 * Never throws on raw URL shapes (`?stale=1`, absent, invalid).
 */
export function parseWorkRouteSearch(search: unknown): WorkRouteSearch {
  const raw =
    search && typeof search === 'object' && !Array.isArray(search)
      ? (search as Record<string, unknown>)
      : {}
  const result = workSearchSchema.safeParse(raw)
  if (result.success) return result.data
  // Fail-soft: empty search rather than error-boundary crash
  return {}
}

/**
 * Smart default bucket when URL omits `?bucket` (W-FIX-WORK / W-AUD-P0 §2).
 * Prefer largest non-empty count; ties break by needs-action priority
 * BLOCKED > NEXT > QUEUED > ONGOING > RECONCILIATION_PENDING > DONE.
 * Never land on empty ONGOING while another bucket has inventory.
 * Explicit `?bucket=` from the user always wins (caller responsibility).
 */
export function selectDefaultWorkBucket(
  counts: Partial<WorkBucketCounts> | null | undefined,
): PrimaryBucket {
  const priority: ReadonlyArray<PrimaryBucket> = [
    'BLOCKED',
    'NEXT',
    'QUEUED',
    'ONGOING',
    'RECONCILIATION_PENDING',
    'DONE',
  ]
  if (!counts) return 'ONGOING'
  let best: PrimaryBucket = 'ONGOING'
  let bestCount = -1
  for (const b of priority) {
    const c = typeof counts[b] === 'number' ? (counts[b] as number) : 0
    if (c > bestCount) {
      bestCount = c
      best = b
    }
  }
  return bestCount > 0 ? best : 'ONGOING'
}

export const Route = createFileRoute('/b/$boardId/work/')({
  validateSearch: (search) => parseWorkRouteSearch(search),
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: WorkRoute,
})

function WorkRoute() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/b/$boardId/work' })
  const qc = useQueryClient()

  /** Explicit `?bucket=` only — absent means smart default may apply. */
  const explicitBucket: PrimaryBucket | null = isPrimaryBucket(search.bucket)
    ? search.bucket
    : null

  /**
   * Remember last smart pick so a second fetch (after counts arrive) does not
   * snap back to empty ONGOING while the BLOCKED query is in flight.
   */
  const [resolvedDefaultBucket, setResolvedDefaultBucket] =
    useState<PrimaryBucket | null>(null)

  const filters = useMemo(
    () =>
      parseWorkDeepLink(boardId, {
        bucket: search.bucket,
        overlay: search.overlay,
        stale: search.stale,
        cursor: search.cursor,
        boardRev: search.boardRev,
        lifecycleRev: search.lifecycleRev,
        canonicalSnapshotId: search.canonicalSnapshotId ?? search.pin,
        canonicalHash: search.canonicalHash,
        taskHash: search.taskHash,
        query: search.query,
      }),
    [boardId, search],
  )

  const activeBucket: PrimaryBucket =
    explicitBucket ?? resolvedDefaultBucket ?? 'ONGOING'
  const overlayKind = filters.overlayKind ?? null
  const staleOverlayActive = filters.staleOverlay

  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    workQueryOptions(
      boardId,
      {
        bucket: activeBucket,
        overlay: overlayKind,
        staleFamily: staleOverlayActive,
        cursor: filters.cursor,
        pageSize: null,
      },
      fetchers.work,
    ),
  )

  // Pin-matched Overview ongoing for Work zero-click join (same aggregation source).
  // Only used when work envelope items need ONGOING fields and pins match.
  const overviewQ = useQuery(overviewQueryOptions(boardId, fetchers.overview))

  const ongoingJoin = useMemo(() => {
    const workEnv = q.data
    const overviewEnv = overviewQ.data
    if (!workEnv?.data || !overviewEnv?.data?.ongoing?.length) return null
    if (
      workEnv.canonicalSnapshotId !== overviewEnv.canonicalSnapshotId ||
      workEnv.boardRev !== overviewEnv.boardRev ||
      workEnv.lifecycleRev !== overviewEnv.lifecycleRev ||
      workEnv.canonicalHash !== overviewEnv.canonicalHash
    ) {
      return null
    }
    return overviewEnv.data.ongoing
  }, [q.data, overviewQ.data])

  const routePinned = useMemo(() => {
    if (filters.pinned) return filters.pinned
    // Partial pin fields from URL even when taskHash incomplete (still preserve what we have).
    if (
      search.taskHash ||
      search.canonicalHash ||
      search.boardRev ||
      search.lifecycleRev ||
      search.canonicalSnapshotId ||
      search.pin
    ) {
      return {
        taskHash: search.taskHash ?? null,
        canonicalHash: search.canonicalHash ?? null,
        canonicalSnapshotId: search.canonicalSnapshotId ?? search.pin ?? null,
        boardRev: search.boardRev != null ? Number(search.boardRev) : null,
        lifecycleRev: search.lifecycleRev != null ? Number(search.lifecycleRev) : null,
      }
    }
    return null
  }, [filters.pinned, search])

  const patchSearch = useCallback(
    (patch: Record<string, string | undefined>) => {
      void navigate({
        search: (prev) => {
          const next: Record<string, string | undefined> = { ...prev, ...patch }
          // Preserve pin tuple keys unless explicitly cleared by patch.
          for (const k of Object.keys(next)) {
            if (next[k] === undefined || next[k] === '') delete next[k]
          }
          return next
        },
        replace: true,
      })
    },
    [navigate],
  )

  /**
   * When URL omits bucket: after first envelope, pick largest/needs-action
   * non-empty bucket and pin it into the URL (replace). Honors explicit ?bucket=.
   */
  useEffect(() => {
    if (explicitBucket != null) return
    const counts = q.data?.data?.buckets as WorkBucketCounts | undefined
    if (!counts) return
    const smart = selectDefaultWorkBucket(counts)
    setResolvedDefaultBucket(smart)
    // Pin into URL so refresh/share and tab state stay aligned with inventory.
    if (search.bucket !== smart) {
      patchSearch({ bucket: smart, cursor: undefined })
    }
  }, [explicitBucket, q.data, patchSearch, search.bucket])

  const onBucketChange = useCallback(
    (bucket: PrimaryBucket) => {
      setResolvedDefaultBucket(bucket)
      patchSearch({ bucket, cursor: undefined })
    },
    [patchSearch],
  )

  const onStaleOverlayChange = useCallback(
    (active: boolean) => {
      patchSearch({
        stale: active ? '1' : undefined,
        overlay: active ? search.overlay : undefined,
        cursor: undefined,
      })
    },
    [patchSearch, search.overlay],
  )

  const onTextQueryChange = useCallback(
    (query: string) => {
      const qtrim = query.trim()
      patchSearch({ query: qtrim ? query : undefined, cursor: undefined })
    },
    [patchSearch],
  )

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (next) patchSearch({ cursor: next })
  }, [q.data?.nextCursor, patchSearch])

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'work', boardId] })
    void qc.invalidateQueries({ queryKey: ['control-center', 'overview', boardId] })
  }, [qc, boardId])

  const onRowActivate = useCallback(
    (item: WorkItemRow) => {
      const taskId = item.taskId
      // ART path: /b/$boardId/work/$taskId (top-level /work/$taskId aliases here).
      void navigate({
        to: '/b/$boardId/work/$taskId',
        params: { boardId, taskId },
      })
    },
    [navigate, boardId],
  )

  const props = workEnvelopeToProps(q.data, {
    boardId,
    activeBucket,
    staleOverlayActive,
    overlayKind: overlayKind as StaleOverlayKind | null,
    transport: q.isError ? 'offline' : 'online',
    ongoingJoin,
    routePinned,
    /** S24 display filter — never invents buckets; empty match → zero-results. */
    textQuery: filters.query ?? null,
    onBucketChange,
    onStaleOverlayChange,
    onNextPage,
    onRetry,
    onRefresh: onRetry,
    onReconnect: onRetry,
    onRowActivate,
  })

  const state = q.isLoading && !q.data ? 'loading' : props.state

  // Presentation lives in WorkScreen (Direction B kit). Route owns query + deep-link only.
  return (
    <div className="wrap" data-testid="control-center-work-route">
      <WorkScreen
        {...props}
        state={state}
        textQuery={filters.query ?? null}
        onTextQueryChange={onTextQueryChange}
      />
    </div>
  )
}
