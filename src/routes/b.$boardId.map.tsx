// Dependency map route — typed React port of the prototype dependency graph view.
// Renders every feature's unlocks-after DAG via <WireGraph>, with project filter
// chips (reusing `.filters`/`.fbtn`) and a legend explaining edge colors.
import { useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { WireGraph } from '#/components/WireGraph'

export const Route = createFileRoute('/b/$boardId/map')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: MapView,
})

function MapView() {
  const m = useBoard()
  const [projectFilter, setProjectFilter] = useState<string>('')

  const features = projectFilter ? m.projById[projectFilter].features : m.features

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Dependency map</h2>
          <span className="count">{features.length}</span>
        </div>
        <div className="wire-legend">
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: '1.6px solid var(--border)',
              }}
            />
            normal
          </span>
          <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
            <span
              style={{
                width: 14,
                height: 0,
                borderTop: '1.6px dashed var(--blocked)',
              }}
            />
            blocked
          </span>
          <span>left→right = unlocks-after</span>
        </div>
        <div className="filters">
          <button
            className={`fbtn ${projectFilter === '' ? 'on' : ''}`}
            onClick={() => setProjectFilter('')}
          >
            All projects
          </button>
          {m.projects.map((p) => (
            <button
              key={p.id}
              className={`fbtn ${projectFilter === p.id ? 'on' : ''}`}
              onClick={() => setProjectFilter(p.id)}
            >
              {p.nama}
            </button>
          ))}
        </div>
        <WireGraph features={features} />
      </section>
    </div>
  )
}
