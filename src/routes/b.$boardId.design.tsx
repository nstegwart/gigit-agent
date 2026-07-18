// Canon-v3: control-center boards demote to /alur before design loaders run.
import { createFileRoute, redirect } from '@tanstack/react-router'

import { Architecture } from '#/components/Architecture'
import { BoardLink as Link } from '#/components/BoardLink'
import { DesignLinks } from '#/components/DesignLinks'
import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { isControlCenterBoard } from '#/lib/control-center-query'
import { PROJ_STATUS } from '#/lib/format'
import { Icon } from '#/lib/icons'

export const Route = createFileRoute('/b/$boardId/design')({
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
  component: DesignView,
})

function DesignView() {
  const m = useBoard()

  return (
    <div className="wrap">
      {m.docs.length > 0 && (
        <section className="section">
          <div className="sec-head">
            <h2>Dokumen desain</h2>
            <span className="count">{m.docs.length}</span>
            <span className="desc">rencana &amp; katalog journey untuk seluruh board</span>
          </div>
          <div className="link-list">
            {m.docs.map((d, i) => (
              <a key={d.path ?? i} href={d.path} target="_blank" rel="noreferrer">
                <Icon name="ext" size={14} />
                <span>
                  {d.judul}
                  {d.desc ? <span className="doc-desc">{d.desc}</span> : null}
                </span>
              </a>
            ))}
          </div>
        </section>
      )}

      <div className="sec-head" style={{ marginTop: 4 }}>
        <h2>Desain sistem per proyek</h2>
        <span className="count">{m.projects.length}</span>
      </div>

      <div className="design-list">
        {m.projects.map((p) => {
          const [scls, slbl] = PROJ_STATUS[p.status] ?? ['st-planned', p.status]
          const hasDesign =
            (p.komponen?.length ?? 0) > 0 ||
            !!p.design_foundation ||
            !!p.design_components ||
            !!p.design_pages
          return (
            <div className="design-proj card" key={p.id}>
              <div className="design-proj-head" style={{ borderColor: p.color }}>
                <div className="design-proj-ico" style={{ background: `${p.color}22`, color: p.color }}>
                  <Icon name="folder" size={18} />
                </div>
                <div className="design-proj-title">
                  <Link to="/projects/$projectId" params={{ projectId: p.id }} className="design-proj-name">
                    {p.nama}
                  </Link>
                  <div className="design-proj-meta">
                    <span className={`tag ${scls}`}>{slbl}</span>
                    <span>·</span>
                    <span>Tahap: {p.stage ?? p.status}</span>
                    <span>·</span>
                    <span>{p.features.filter((f) => !f.parked).length} fitur</span>
                  </div>
                </div>
              </div>
              <div className="card-body design-proj-body">
                {p.ringkas ? <p className="design-desc">{p.ringkas}</p> : null}
                {hasDesign ? (
                  <Architecture project={p} />
                ) : (
                  <div className="design-empty">Belum ada katalog desain sistem untuk proyek ini.</div>
                )}
                <div className="arch-block">
                  <div className="block-label">Tautan desain</div>
                  <DesignLinks scope="project" id={p.id} links={p.design} />
                </div>
              </div>
            </div>
          )
        })}
      </div>
    </div>
  )
}
