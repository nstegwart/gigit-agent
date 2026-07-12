import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { uiStore } from '#/store/ui'
import { Timeline } from '#/components/Timeline'

export const Route = createFileRoute('/b/$boardId/log')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
  const m = useBoard()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()
  const ls = q ? m.log.filter((l) => l.teks.toLowerCase().includes(q)) : m.log

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Activity log</h2>
          <span className="count">{ls.length}</span>
        </div>
        <Timeline log={ls} />
      </section>
    </div>
  )
}
