// Features list — control-center boards use pinned features envelope; others keep FeaturesTable.
// Canon-v3: control-center boards demote to /alur before features loaders run.
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { boardQueryOptions, useBoard, useBoardId } from '#/lib/board-query'
import {
  featuresQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { featuresEnvelopeToProps } from '#/lib/control-center-secondary-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'
import { FeaturesScreen } from '#/components/control-center/features'
import { FeaturesTable } from '#/components/FeaturesTable'

export const Route = createFileRoute('/b/$boardId/features/')({
  validateSearch: (search) => parseControlCenterCursorSearch(search),
  beforeLoad: ({ params }) => {
    if (isControlCenterBoard(params.boardId)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: params.boardId },
        replace: true,
      })
    }
  },
  loader: async ({ context, params, location }) => {
    // Control-center boards never reach here (beforeLoad → /alur).
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      const search = parseControlCenterCursorSearch(location.search)
      await context.queryClient.ensureQueryData(
        featuresQueryOptions(
          params.boardId,
          { cursor: search.cursor ?? null, pageSize: null },
          getDefaultControlCenterFetchers().features,
        ),
      )
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterFeatures />
  }
  return <LegacyFeatures />
}

function ControlCenterFeatures() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/b/$boardId/features/' })
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    featuresQueryOptions(
      boardId,
      { cursor: search.cursor ?? null, pageSize: null },
      fetchers.features,
    ),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'features', boardId] })
  }, [qc, boardId])

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (!next) return
    void navigate({
      search: (prev) => ({ ...prev, cursor: next }),
      replace: true,
    })
  }, [navigate, q.data?.nextCursor])

  const props = featuresEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
    onNextPage,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-features-route">
      <FeaturesScreen {...props} surfaceState={surfaceState} />
    </div>
  )
}

function LegacyFeatures() {
  const m = useBoard()
  return (
    <div className="wrap">
      <FeaturesTable model={m} />
    </div>
  )
}
