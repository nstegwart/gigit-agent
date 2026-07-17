// Ops route — control-center boards use pinned ops envelope; others keep AccountsGrid.
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { boardQueryOptions, opsQueryOptions, useBoardId, useOps } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  opsQueryOptions as controlCenterOpsQueryOptions,
} from '#/lib/control-center-query'
import { opsEnvelopeToProps } from '#/lib/control-center-secondary-route-adapters'
import { OpsScreen } from '#/components/control-center/ops'
import { AccountsGrid } from '#/components/AccountsGrid'

export const Route = createFileRoute('/b/$boardId/ops')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        controlCenterOpsQueryOptions(params.boardId, getDefaultControlCenterFetchers().ops),
      )
    } else {
      await context.queryClient.ensureQueryData(opsQueryOptions(params.boardId))
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterOps />
  }
  return <LegacyOps />
}

function ControlCenterOps() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(controlCenterOpsQueryOptions(boardId, fetchers.ops))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'ops', boardId] })
  }, [qc, boardId])

  const props = opsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-ops-route">
      <OpsScreen {...props} surfaceState={surfaceState} />
    </div>
  )
}

function LegacyOps() {
  const ops = useOps()

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Akun agen</h2>
        </div>
        <AccountsGrid ops={ops} />
      </section>
    </div>
  )
}
