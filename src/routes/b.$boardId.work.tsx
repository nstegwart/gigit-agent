// Control-center Work surface — six exclusive buckets + STALE overlay + deep links.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'

import { WorkScreen, parseWorkDeepLink, isPrimaryBucket } from '#/components/control-center/work'
import type { PrimaryBucket } from '#/components/control-center/work'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
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

export const Route = createFileRoute('/b/$boardId/work')({
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
      }),
    [boardId, search],
  )

  const activeBucket: PrimaryBucket = isPrimaryBucket(filters.bucket)
    ? filters.bucket
    : 'ONGOING'
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

  const patchSearch = useCallback(
    (patch: Record<string, string | undefined>) => {
      void navigate({
        search: (prev) => {
          const next: Record<string, string | undefined> = { ...prev, ...patch }
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

  const onBucketChange = useCallback(
    (bucket: PrimaryBucket) => {
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

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (next) patchSearch({ cursor: next })
  }, [q.data?.nextCursor, patchSearch])

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'work', boardId] })
  }, [qc, boardId])

  const props = workEnvelopeToProps(q.data, {
    boardId,
    activeBucket,
    staleOverlayActive,
    overlayKind: overlayKind as StaleOverlayKind | null,
    transport: q.isError ? 'offline' : 'online',
    onBucketChange,
    onStaleOverlayChange,
    onNextPage,
    onRetry,
    onRefresh: onRetry,
    onReconnect: onRetry,
  })

  const state = q.isLoading && !q.data ? 'loading' : props.state

  return (
    <div className="wrap" data-testid="control-center-work-route">
      <WorkScreen {...props} state={state} />
    </div>
  )
}
