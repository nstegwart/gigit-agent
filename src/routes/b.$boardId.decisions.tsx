// Control-center Decisions inbox — pinned decisions envelope for CC boards.
// Non-CC boards keep legacy collab DecidePanel / DecisionCard surfaces.
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { DecidePanel } from '#/components/DecidePanel'
import { DecisionCard } from '#/components/DecisionCard'
import { DecisionsScreen } from '#/components/control-center/decisions'
import { boardQueryOptions, useBoard, useBoardId } from '#/lib/board-query'
import {
  decisionsQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { decisionsEnvelopeToProps } from '#/lib/control-center-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'
import { uiStore } from '#/store/ui'

export const Route = createFileRoute('/b/$boardId/decisions')({
  validateSearch: (search) => parseControlCenterCursorSearch(search),
  loader: async ({ context, params, location }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      const search = parseControlCenterCursorSearch(location.search)
      await context.queryClient.ensureQueryData(
        decisionsQueryOptions(
          params.boardId,
          { cursor: search.cursor ?? null, pageSize: null },
          getDefaultControlCenterFetchers().decisions,
        ),
      )
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterDecisions />
  }
  return <LegacyDecisions />
}

function ControlCenterDecisions() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    decisionsQueryOptions(
      boardId,
      { cursor: search.cursor ?? null, pageSize: null },
      fetchers.decisions,
    ),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'decisions', boardId] })
  }, [qc, boardId])

  const props = decisionsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-decisions-route">
      <DecisionsScreen {...props} surfaceState={surfaceState} />
    </div>
  )
}

function LegacyDecisions() {
  const m = useBoard()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  const matches = (d: { id: string; teks: string; keputusan?: string }) =>
    !q || `${d.id} ${d.teks} ${d.keputusan ?? ''}`.toLowerCase().includes(q)

  const open = m.openDecisions.filter(matches)
  const openIds = new Set(open.map((d) => d.id))
  const decided = m.decisions.filter((d) => !openIds.has(d.id) && matches(d))

  return (
    <>
      <section className="section">
        <div className="sec-head">
          <h2>Open — waiting on you</h2>
          <span className="count">{open.length}</span>
          <span className="desc">owner calls that unblock the work</span>
        </div>
        {open.length === 0 ? (
          <p className="desc">Nothing waiting on you right now.</p>
        ) : (
          open.map((d) => <DecidePanel key={d.id} decision={d} />)
        )}
      </section>

      <section className="section">
        <div className="sec-head">
          <h2>Decided</h2>
          <span className="count">{decided.length}</span>
        </div>
        {decided.map((d) => (
          <DecisionCard key={d.id} decision={d} />
        ))}
      </section>
    </>
  )
}
