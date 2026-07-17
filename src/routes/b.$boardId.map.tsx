// Peta ketergantungan — ART-022 interactive flow dengan filter proyek dan legenda id-ID.
// Route shell is fully deterministic (no window/Date). Graph hydration is handled inside
// DependencyFlow via clientReady gate (see React #418 fix).
import { useMemo, useState } from 'react'
import { createFileRoute } from '@tanstack/react-router'

import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { DependencyFlow } from '#/components/control-center/dependency'

export const Route = createFileRoute('/b/$boardId/map')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: MapView,
})

function MapView() {
  const m = useBoard()
  const [projectFilter, setProjectFilter] = useState<string>('')

  // Stable project list order (id) so filter chips never diverge SSR vs client.
  const projects = useMemo(
    () => [...m.projects].sort((a, b) => a.id.localeCompare(b.id, 'en')),
    [m.projects],
  )

  const features = projectFilter
    ? (m.projById[projectFilter]?.features ?? [])
    : m.features

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Peta ketergantungan</h2>
          <span className="count">{features.length}</span>
        </div>
        <p className="sec-lead" style={{ marginBottom: 12, fontSize: 14, color: 'var(--text-muted)' }}>
          Alur kiri→kanan menunjukkan prasyarat fitur. Ini progres pemetaan — bukan kesiapan produksi.
        </p>
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
            terhambat
          </span>
          <span>kiri→kanan = prasyarat selesai dulu</span>
        </div>
        <div className="filters">
          <button
            className={`fbtn ${projectFilter === '' ? 'on' : ''}`}
            onClick={() => setProjectFilter('')}
          >
            Semua proyek
          </button>
          {projects.map((p) => (
            <button
              key={p.id}
              className={`fbtn ${projectFilter === p.id ? 'on' : ''}`}
              onClick={() => setProjectFilter(p.id)}
            >
              {p.nama}
            </button>
          ))}
        </div>
        <DependencyFlow features={features} />
      </section>
    </div>
  )
}
