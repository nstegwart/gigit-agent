// Board home / Overview — control-center boards use pinned Overview; others keep adaptive Board.
import { Navigate, createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'
import { useStore } from '@tanstack/react-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useState } from 'react'

import { ActivityFeed } from '#/components/ActivityFeed'
import { KpiStrip, type KpiItem } from '#/components/KpiStrip'
import { ProjectCard } from '#/components/ProjectCard'
import { QueueCard } from '#/components/QueueCard'
import { RunCard } from '#/components/RunCard'
import { EmptyState } from '#/components/primitives'
import { Overview } from '#/components/control-center/overview'
import {
  boardQueryOptions,
  useBoard,
  useBoardId,
  useBoardViews,
  useCurrentBoard,
} from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  overviewQueryOptions,
} from '#/lib/control-center-query'
import { overviewEnvelopeToProps } from '#/lib/control-center-route-adapters'
import { Icon } from '#/lib/icons'
import { uiStore } from '#/store/ui'
import type { PrimaryBucket } from '#/lib/control-plane-types'

export const Route = createFileRoute('/b/$boardId/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        overviewQueryOptions(params.boardId, getDefaultControlCenterFetchers().overview),
      )
    }
  },
  component: View,
})

function View() {
  const views = useBoardViews()
  const boardId = useBoardId()

  if (isControlCenterBoard(boardId)) {
    return <ControlCenterOverview />
  }

  // adaptive: boards without a 'board' view land on their first enabled view
  if (!views.includes('board')) {
    const first = views.find((v) => v !== 'board') ?? 'tasks'
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    return <Navigate {...({ to: `/b/$boardId/${first}`, params: { boardId }, replace: true } as any)} />
  }
  return <BoardHome />
}

function ControlCenterOverview() {
  const boardId = useBoardId()
  const boardMeta = useCurrentBoard()
  const qc = useQueryClient()
  // Controlled sticky pill: child IntersectionObserver calls these when the
  // decision card leaves/enters the #view scroll root (must not skip IO).
  const [pillCollapsed, setPillCollapsed] = useState(false)
  const onPillExpand = useCallback(() => setPillCollapsed(false), [])
  const onPillCollapse = useCallback(() => setPillCollapsed(true), [])
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(overviewQueryOptions(boardId, fetchers.overview))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'overview', boardId] })
  }, [qc, boardId])

  const onSelectBucket = useCallback(
    (bucket: PrimaryBucket) => {
      // Deep-link to Work with server-validated bucket filter + pin when known.
      const params = new URLSearchParams({ bucket })
      const env = q.data
      if (env) {
        params.set('boardRev', String(env.boardRev))
        params.set('lifecycleRev', String(env.lifecycleRev))
        if (env.canonicalSnapshotId) params.set('canonicalSnapshotId', env.canonicalSnapshotId)
        if (env.canonicalHash) params.set('canonicalHash', env.canonicalHash)
      }
      window.location.assign(
        `/b/${encodeURIComponent(boardId)}/work?${params.toString()}`,
      )
    },
    [boardId, q.data],
  )

  const onToggleStale = useCallback(() => {
    // AC-BUCKET-05: STALE chip → Work with stale family filter (not a 7th bucket).
    const params = new URLSearchParams({ stale: '1' })
    const env = q.data
    if (env) {
      params.set('boardRev', String(env.boardRev))
      params.set('lifecycleRev', String(env.lifecycleRev))
      if (env.canonicalSnapshotId) params.set('canonicalSnapshotId', env.canonicalSnapshotId)
      if (env.canonicalHash) params.set('canonicalHash', env.canonicalHash)
    }
    window.location.assign(
      `/b/${encodeURIComponent(boardId)}/work?${params.toString()}`,
    )
  }, [boardId, q.data])

  const props = overviewEnvelopeToProps(q.data, {
    boardLabel: boardMeta?.name,
    liveStage: 'mfs-rebuild control center',
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onReconnect: onRetry,
    onSelectBucket,
    onToggleStale,
    pillCollapsed,
    onPillExpand,
    onPillCollapse,
  })

  // Loading surface when no data yet
  const surfaceProps =
    q.isLoading && !q.data
      ? { ...props, surfaceState: 'loading' as const }
      : props

  return (
    <div className="wrap" data-testid="control-center-overview-route">
      <Overview {...surfaceProps} />
    </div>
  )
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
