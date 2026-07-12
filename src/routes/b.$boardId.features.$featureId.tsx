// Feature detail — ported from prototype `vFeature(m, id)` (docs/plan/assets/app.js).
// Same markup/classes as a typed React page body; AppShell provides the chrome.
import { createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'

import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { fmtDate } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { EmptyState } from '#/components/primitives'
import { Checklist } from '#/components/Checklist'
import { RunCard } from '#/components/RunCard'
import { DecidePanel } from '#/components/DecidePanel'
import { DesignLinks } from '#/components/DesignLinks'
import { CommentThread } from '#/components/CommentThread'

export const Route = createFileRoute('/b/$boardId/features/$featureId')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: View,
})

function BackLink() {
  return (
    <Link to="/features" className="back">
      <Icon name="chevL" /> Back
    </Link>
  )
}

const linkIcon = (u: string) =>
  /^https?:/.test(u) ? 'ext' : /^file:/.test(u) ? 'folder' : 'link'

function View() {
  const m = useBoard()
  const { featureId } = Route.useParams()
  const f = m.featById[featureId]

  if (!f) {
    return (
      <>
        <BackLink />
        <EmptyState icon="alert">Feature not found.</EmptyState>
      </>
    )
  }

  const p = f.projectId ? m.projById[f.projectId] : undefined
  const ag = f.runs
  const open = m.openDecisions.find((d) => d.featureId === f.id)

  return (
    <>
      <BackLink />
      <div className="detail-head">
        <div className="detail-title">
          <div style={{ flex: 1 }}>
            <h1>{f.nama}</h1>
            <div className="detail-sub">
              {p ? (
                <>
                  <Link
                    to="/projects/$projectId"
                    params={{ projectId: p.id }}
                    className="qcard-proj"
                  >
                    <span className="pdot" style={{ background: p.color }} />
                    {p.nama}
                  </Link>
                  <span>·</span>
                </>
              ) : null}
              <span className={`phase ${f.phaseCls}`}>{f.phaseLabel}</span>
              <span className="chip chip-mono">{f.id}</span>
              {f.parked ? <span className="phase ph-parked">Parked</span> : null}
            </div>
          </div>
        </div>
        {f.blocked ? (
          <div className="banner blocked">
            <Icon name="lock" />
            <div>
              <b>Blocked.</b> {f.blocked}
            </div>
          </div>
        ) : null}
      </div>

      {open ? (
        <div style={{ marginBottom: 16 }}>
          <DecidePanel decision={open} />
        </div>
      ) : null}

      <div className="grid-2">
        <div>
          <Checklist feature={f} />
          {f.catatan ? (
            <div className="card" style={{ marginTop: 16 }}>
              <div className="card-head">
                <Icon name="inbox" className="nav-ico" />
                <h3>Notes</h3>
              </div>
              <div className="card-body">
                <p className="note" style={{ border: 0, padding: '4px 0' }}>
                  {f.catatan}
                </p>
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {ag.length ? (
            <div className="card">
              <div className="card-head">
                <Icon name="agents" className="nav-ico" />
                <h3>Agents on this feature</h3>
                <span className="count">{ag.length}</span>
              </div>
              <div
                className="card-body"
                style={{
                  display: 'flex',
                  flexDirection: 'column',
                  gap: 10,
                  paddingTop: 12,
                }}
              >
                {ag.map((r) => (
                  <RunCard key={r.id} run={r} model={m} />
                ))}
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <Icon name="layers" className="nav-ico" />
              <h3>Details</h3>
            </div>
            <div className="card-body">
              <div className="meta-row">
                <span className="k">Progress</span>
                <span className="v" style={{ flex: 1 }}>
                  <div className="progress" style={{ width: '100%' }}>
                    <div className="bar">
                      <span style={{ width: `${f.pct || 0}%` }} />
                    </div>
                    <span className="pct">{f.pct || 0}%</span>
                  </div>
                </span>
              </div>
              {f.track ? (
                <div className="meta-row">
                  <span className="k">Track</span>
                  <span className="v">
                    <span className="chip">{f.track}</span>
                  </span>
                </div>
              ) : null}
              {f.kelompok ? (
                <div className="meta-row">
                  <span className="k">Group</span>
                  <span className="v">
                    <span className="chip">{f.kelompok}</span>
                  </span>
                </div>
              ) : null}
              {f.tier && !/^—/.test(f.tier) ? (
                <div className="meta-row">
                  <span className="k">Tier</span>
                  <span className="v">{f.tier}</span>
                </div>
              ) : null}
              {f.impact && f.impact.length ? (
                <div className="meta-row">
                  <span className="k">Impact</span>
                  <span className="v">
                    {f.impact.map((x) => (
                      <span className="chip" key={x}>
                        {x}
                      </span>
                    ))}
                  </span>
                </div>
              ) : null}
              {f.deps && f.deps.length ? (
                <div className="meta-row">
                  <span className="k">Depends on</span>
                  <span className="v">
                    {f.deps.map((d) => (
                      <Link
                        key={d}
                        to="/features/$featureId"
                        params={{ featureId: d }}
                        className="chip"
                        style={{ color: 'var(--warn)', background: 'var(--warn-bg)' }}
                      >
                        <Icon name="lock" />
                        {m.featById[d]?.nama ?? d}
                      </Link>
                    ))}
                  </span>
                </div>
              ) : null}
              {f.branch ? (
                <div className="meta-row">
                  <span className="k">Branch</span>
                  <span className="v">
                    <span className="chip chip-mono">
                      <Icon name="branch" />
                      {f.branch}
                    </span>
                  </span>
                </div>
              ) : null}
              {f.updated ? (
                <div className="meta-row">
                  <span className="k">Updated</span>
                  <span className="v">{fmtDate(f.updated)}</span>
                </div>
              ) : null}
            </div>
          </div>

          {f.links && f.links.length ? (
            <div className="card">
              <div className="card-head">
                <Icon name="link" className="nav-ico" />
                <h3>Links &amp; artifacts</h3>
                <span className="count">{f.links.length}</span>
              </div>
              <div className="card-body">
                <div className="link-list">
                  {f.links.map((l, i) => (
                    <a key={i} href={l.url} target="_blank" rel="noopener">
                      <Icon name={linkIcon(l.url) as never} />
                      {l.label ?? l.url}
                    </a>
                  ))}
                </div>
              </div>
            </div>
          ) : null}

          <div className="card">
            <div className="card-head">
              <Icon name="sparkles" className="nav-ico" />
              <h3>Design</h3>
            </div>
            <div className="card-body">
              <DesignLinks scope="feature" id={f.id} links={f.design} />
            </div>
          </div>

          <div className="card">
            <div className="card-head">
              <Icon name="users" className="nav-ico" />
              <h3>Comments</h3>
              {f.comments.length ? (
                <span className="count">{f.comments.length}</span>
              ) : null}
            </div>
            <div className="card-body">
              <CommentThread feature={f} />
            </div>
          </div>
        </div>
      </div>
    </>
  )
}
