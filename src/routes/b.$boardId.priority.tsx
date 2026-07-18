// Control-center Priority surface — SALES_WEB_RELATED_BACKEND envelope only.
// Canon-v3: control-center boards demote to /alur before priority loaders run.
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { PriorityScreen } from '#/components/control-center/priority'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  priorityQueryOptions,
  overviewQueryOptions,
} from '#/lib/control-center-query'
import { priorityEnvelopeToProps } from '#/lib/control-center-route-adapters'

export const Route = createFileRoute('/b/$boardId/priority')({
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
    const fetchers = getDefaultControlCenterFetchers()
    await Promise.all([
      context.queryClient.ensureQueryData(
        priorityQueryOptions(params.boardId, fetchers.priority),
      ),
      context.queryClient.ensureQueryData(
        overviewQueryOptions(params.boardId, fetchers.overview),
      ),
    ])
  },
  component: PriorityRoute,
})

function PriorityRoute() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const priorityQ = useQuery(priorityQueryOptions(boardId, fetchers.priority))
  const overviewQ = useQuery(overviewQueryOptions(boardId, fetchers.overview))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'priority', boardId] })
    void qc.invalidateQueries({ queryKey: ['control-center', 'overview', boardId] })
  }, [qc, boardId])

  const ov = overviewQ.data?.data
  const props = priorityEnvelopeToProps(priorityQ.data, {
    transport: priorityQ.isError ? 'offline' : 'online',
    onRetry,
    productDenominator: ov?.productDenominator,
    trackedWorkDenominator: ov?.trackedWorkDenominator,
    stageProdReady: ov?.stageProdReady,
    prodReadyWithEvidence: ov?.prodReadyWithEvidence,
    unclassifiedCount: ov?.unclassifiedCount,
    boardReadinessPercent: ov?.boardReadinessPercent ?? null,
    rawTaskReadinessPercent: ov?.rawTaskReadinessPercent ?? null,
    complete: ov?.complete,
    cappedBy: ov?.cappedBy ?? undefined,
  })

  const uiState =
    priorityQ.isLoading && !priorityQ.data ? 'loading' : props.uiState

  return (
    <div className="wrap" data-testid="control-center-priority-route">
      <PriorityScreen {...props} uiState={uiState} />
    </div>
  )
}
