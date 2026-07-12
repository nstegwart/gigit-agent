// Projects grid — typed React port of the prototype `vProjects(m)` view (app.js).
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'

import { boardQueryOptions, rollupQueryOptions, useBoard, useRollup } from '#/lib/board-query'
import { uiStore } from '#/store/ui'
import { ProjectCard } from '#/components/ProjectCard'

export const Route = createFileRoute('/b/$boardId/projects/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

function View() {
  const m = useBoard()
  const rollup = useRollup()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()
  const projects = q
    ? m.projects.filter((p) => `${p.nama} ${p.id}`.toLowerCase().includes(q))
    : m.projects

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Projects</h2>
          <span className="count">{projects.length}</span>
          <span className="desc">readiness = lifecycle stage rollup (not legacy phase)</span>
        </div>
        <div className="proj-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} readiness={rollup.byProject[p.id]} />
          ))}
        </div>
      </section>
    </div>
  )
}
