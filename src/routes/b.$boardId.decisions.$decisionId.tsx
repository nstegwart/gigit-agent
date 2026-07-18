/**
 * ART S12 board-scoped decision detail from pinned decisions envelope.
 * Canon-v3: control-center boards demote to /alur before decision detail loaders run.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { DecisionDetailScreen } from '#/components/control-center/decisions/DecisionDetailScreen'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  decisionsQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  type DecisionsData,
  type PinnedEnvelope,
} from '#/lib/control-center-query'
import { decisionDetailFromEnvelope } from '#/lib/control-center-route-adapters'

export const Route = createFileRoute('/b/$boardId/decisions/$decisionId')({
  beforeLoad: ({ params }) => {
    if (isControlCenterBoard(params.boardId)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: params.boardId },
        replace: true,
      })
    }
  },
  loader: async ({ context, params }) => {
    // Control-center boards never reach here (beforeLoad → /alur).
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: DecisionDetailRoute,
})

function DecisionDetailRoute() {
  const boardId = useBoardId()
  const { decisionId } = Route.useParams()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()

  const q = useQuery(
    decisionsQueryOptions(boardId, {}, fetchers.decisions),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'decisions', boardId] })
  }, [qc, boardId])

  const vm = useMemo(
    () =>
      decisionDetailFromEnvelope(q.data as PinnedEnvelope<DecisionsData> | undefined, {
        boardId,
        decisionId,
      }),
    [q.data, boardId, decisionId],
  )

  const surfaceState =
    q.isLoading && !q.data ? 'loading' : q.isError ? 'error' : vm.surfaceState

  return (
    <div className="wrap" data-testid="control-center-decision-detail-route">
      <DecisionDetailScreen {...vm} surfaceState={surfaceState} onRetry={onRetry} />
    </div>
  )
}
