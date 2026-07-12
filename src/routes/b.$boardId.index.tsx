// Board (home) view — ported from prototype `vBoard(m)` (docs/plan/assets/app.js).
// Renders the page body only; AppShell provides sidebar/topbar/search/theme.
import { Navigate, createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'
import { useStore } from '@tanstack/react-store'

import { ActivityFeed } from '#/components/ActivityFeed'
import { KpiStrip, type KpiItem } from '#/components/KpiStrip'
import { ProjectCard } from '#/components/ProjectCard'
import { QueueCard } from '#/components/QueueCard'
import { RunCard } from '#/components/RunCard'
import { EmptyState } from '#/components/primitives'
import { boardQueryOptions, useBoard, useBoardId, useBoardViews } from '#/lib/board-query'
import { Icon } from '#/lib/icons'
import { uiStore } from '#/store/ui'

export const Route = createFileRoute('/b/$boardId/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
  const views = useBoardViews()
  const boardId = useBoardId()
  // adaptive: boards without a 'board' view land on their first enabled view
  if (!views.includes('board')) {
    const first = views.find((v) => v !== 'board') ?? 'tasks'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <Navigate {...({ to: `/b/$boardId/${first}`, params: { boardId }, replace: true } as any)} />
  }
  return <BoardHome />
}

function BoardHome() {
  const m = useBoard()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  const filt = <T,>(arr: T[], get: (x: T) => string): T[] =>
    q ? arr.filter((x) => get(x).toLowerCase().includes(q)) : arr

  const runs = filt(m.runs, (r) => `${r.agent} ${r.task} ${r.model} ${r.agentType}`)
  const running = runs.filter((r) => r.status === 'running')
  const otherRuns = runs.filter((r) => r.status !== 'running')

  const kpis: KpiItem[] = [
    { tone: 'accent', icon: 'agents', num: m.runningAgents.length, label: 'Agents active' },
    { tone: 'info', icon: 'features', num: m.active.length, label: 'In progress' },
    { tone: 'ok', icon: 'play', num: m.queue.now.length, label: 'In queue now' },
    { tone: 'blocked', icon: 'lock', num: m.blocked.length, label: 'Blocked' },
    { tone: 'warn', icon: 'projects', num: m.projects.length, label: 'Projects' },
  ]

  const now = filt(m.queue.now, (f) => f.nama)
  const next = filt(m.queue.next, (f) => f.nama)
  const blocked = filt(m.blocked, (f) => f.nama)

  return (
    <div className="wrap" data-testid="board-smoke">
      <KpiStrip items={kpis} />

      {m.openDecisions.length ? (
        <section className="section">
          <div className="sec-head">
            <h2>Decisions waiting on you</h2>
            <span className="count">{m.openDecisions.length}</span>
          </div>
          <div className="timeline">
            {m.openDecisions.map((d) =>
              d.featureId ? (
                <Link key={d.id} to="/features/$featureId" params={{ featureId: d.featureId }} className="tl-item">
                  <div className="tl-text">{d.teks}</div>
                </Link>
              ) : (
                <Link key={d.id} to="/decisions" className="tl-item">
                  <div className="tl-text">{d.teks}</div>
                </Link>
              ),
            )}
          </div>
        </section>
      ) : null}

      <section className="section">
        <div className="sec-head">
          <h2>Agents at work</h2>
          <span className="count">{running.length}</span>
          <span className="live">
            <span className="blink" />
            live
          </span>
          <span className="desc">who is running, on what model, effort &amp; task</span>
        </div>
        <div className="runs-grid">
          {running.length ? (
            running.map((r) => <RunCard key={r.id} run={r} model={m} />)
          ) : (
            <EmptyState icon="agents">No agents running right now.</EmptyState>
          )}
        </div>
        {otherRuns.length ? (
          <div className="runs-grid" style={{ marginTop: 12 }}>
            {otherRuns.map((r) => (
              <RunCard key={r.id} run={r} model={m} />
            ))}
          </div>
        ) : null}
      </section>

      <section className="section">
        <div className="sec-head">
          <h2>Work queue</h2>
          <span className="desc">{m.queue.catatan || ''}</span>
        </div>
        <div className="queue-rail">
          <span className="queue-lbl ql-now">Now</span>
          <span className="line" />
        </div>
        <div className="qgrid">
          {now.length ? (
            now.map((f) => <QueueCard key={f.id} feature={f} model={m} />)
          ) : (
            <div className="empty">Nothing active.</div>
          )}
        </div>
        {next.length ? (
          <>
            <div className="queue-rail" style={{ marginTop: 20 }}>
              <span className="queue-lbl ql-next">Next</span>
              <span className="line" />
            </div>
            <div className="qgrid">
              {next.map((f) => (
                <QueueCard key={f.id} feature={f} model={m} gate />
              ))}
            </div>
          </>
        ) : null}
        {blocked.length ? (
          <>
            <div className="queue-rail" style={{ marginTop: 20 }}>
              <span className="queue-lbl ql-blocked">Blocked · waiting on you</span>
              <span className="line" />
            </div>
            <div className="qgrid">
              {blocked.map((f) => (
                <QueueCard key={f.id} feature={f} model={m} />
              ))}
            </div>
          </>
        ) : null}
      </section>

      <section className="section">
        <div className="sec-head">
          <h2>Projects</h2>
          <Link to="/projects" className="more">
            all projects <Icon name="arrow" />
          </Link>
        </div>
        <div className="proj-grid">
          {m.projects.map((p) => (
            <ProjectCard key={p.id} project={p} />
          ))}
        </div>
      </section>

      <section className="section">
        <div className="sec-head">
          <h2>Recent activity</h2>
        </div>
        <ActivityFeed activity={m.activity} limit={8} />
      </section>
    </div>
  )
}
