import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'

import { DecidePanel } from '#/components/DecidePanel'
import { DecisionCard } from '#/components/DecisionCard'
import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { uiStore } from '#/store/ui'

export const Route = createFileRoute('/b/$boardId/decisions')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
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
