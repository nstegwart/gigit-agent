// Project detail — ported from prototype `vProject(m, id)` (docs/plan/assets/app.js).
// Same markup/classes as a typed React page body; AppShell provides the chrome.
// W-FIX-PROJECTS: compact Runs (pageSize 6–12, status-priority), tasks via TasksTable
// (human titles / domain groups / page 20), hydration-safe client-only WireGraph.
import { useEffect, useMemo, useState, type ReactNode } from 'react'
import { createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'

import { boardQueryOptions, lifecycleQueryOptions, rollupQueryOptions, tasksQueryOptions, useBoard, useLifecycle, useRollup, useTasks } from '#/lib/board-query'
import { PROJ_STATUS } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { Collapsible } from '#/components/Collapsible'
import { EmptyState } from '#/components/primitives'
import {
  countAttentionRuns,
  PROJECT_RUNS_PAGE_SIZE,
  RunCard,
  sortProjectRuns,
} from '#/components/RunCard'
import { FeatureRow } from '#/components/FeatureRow'
import { Architecture } from '#/components/Architecture'
import { DesignLinks } from '#/components/DesignLinks'
import { WireGraph } from '#/components/WireGraph'
import { resolveTaskDisplayTitle, TasksTable } from '#/components/TasksTable'
import type { Feature } from '#/lib/types'

/**
 * SSR-safe client gate: server + first client paint render the same fallback,
 * then mount children. Used to avoid React #418 from browser-only dependency map.
 */
function ClientOnly({
  children,
  fallback,
}: {
  children: ReactNode
  fallback: ReactNode
}) {
  const [ready, setReady] = useState(false)
  useEffect(() => {
    setReady(true)
  }, [])
  return ready ? <>{children}</> : <>{fallback}</>
}

export const Route = createFileRoute('/b/$boardId/projects/$projectId')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

function BackLink() {
  return (
    <Link to="/projects" className="back">
      <Icon name="chevL" /> Back
    </Link>
  )
}

function View() {
  const m = useBoard()
  const { tasks: allTasks, byId: taskById } = useTasks()
  const rollup = useRollup()
  const cfg = useLifecycle()
  const { projectId } = Route.useParams()
  const p = m.projById[projectId]
  const [showAllRuns, setShowAllRuns] = useState(false)

  // Hooks before any early return (Rules of Hooks) — empty when project missing
  const runs = useMemo(
    () => (p ? sortProjectRuns(m.runs.filter((r) => r.project === p.id)) : []),
    [m.runs, p],
  )
  const projTasks = useMemo(
    () =>
      p
        ? allTasks.filter((t) => t.projectId === p.id).slice().sort((a, b) => a.id.localeCompare(b.id))
        : [],
    [allTasks, p],
  )

  if (!p) {
    return (
      <>
        <BackLink />
        <EmptyState icon="alert">Project not found.</EmptyState>
      </>
    )
  }

  const [scls, slbl] = PROJ_STATUS[p.status] ?? ['st-planned', p.status]
  const activeFeatures = p.features.filter((f) => !f.parked)
  const attention = countAttentionRuns(runs)
  const visibleRuns = showAllRuns ? runs : runs.slice(0, PROJECT_RUNS_PAGE_SIZE)
  const hiddenRunCount = Math.max(0, runs.length - PROJECT_RUNS_PAGE_SIZE)

  const groups: Array<[string, Array<Feature>]> = [
    ['Blocked', p.features.filter((f) => f.blocked)],
    ['In progress', p.features.filter((f) => !f.blocked && !f.parked && f.fase !== 'backlog')],
    ['Backlog', p.features.filter((f) => !f.blocked && !f.parked && f.fase === 'backlog')],
    ['Parked for later', p.features.filter((f) => f.parked)],
  ].filter((g): g is [string, Array<Feature>] => g[1].length > 0)

  return (
    <>
      <BackLink />
      <div className="detail-head">
        <div className="detail-title">
          <div className="proj-ico" style={{ background: `${p.color}22`, color: p.color }}>
            <Icon name="folder" />
          </div>
          <div style={{ flex: 1 }}>
            <h1>{p.nama}</h1>
            <div className="detail-sub">
              <span className={`tag ${scls}`} style={{ fontWeight: 600 }}>
                {slbl}
              </span>
              <span>
                Stage: <b style={{ color: 'var(--text)' }}>{p.stage || p.status}</b>
              </span>
              <span>·</span>
              <span>{activeFeatures.length} active features</span>
              <span>·</span>
              <span><b style={{ color: 'var(--text)' }}>{rollup.byProject[p.id]?.readinessPercent ?? 0}%</b> ready-production</span>
              {rollup.byProject[p.id] ? <><span>·</span><span>floor {rollup.byProject[p.id].floor ?? '—'}</span></> : null}
            </div>
          </div>
        </div>
        {p.ringkas ? (
          <p className="note" style={{ marginTop: 16, borderLeftColor: `${p.color}66` }}>
            {p.ringkas}
          </p>
        ) : null}
      </div>

      {/* Tasks first (owner priority) — runs are secondary chrome, not the wall above work */}
      {projTasks.length ? (
        <section className="section">
          <div className="sec-head">
            <h2>Tasks</h2>
            <span className="count">{projTasks.length}</span>
            <span className="desc">tasks in this project</span>
          </div>
          <TasksTable tasks={projTasks} runsByTask={m.runsByTask} readinessByGroup={rollup.byFeature} milestone={rollup.milestone} cfg={cfg} />
        </section>
      ) : null}

      {runs.length ? (
        <section className="section" data-testid="project-runs-section">
          <div className="sec-head">
            <h2>Runs ({runs.length})</h2>
            <span className="count">{runs.length}</span>
            {attention > 0 ? (
              <span className="desc" style={{ color: 'var(--blocked)' }}>
                {attention} running/failed
              </span>
            ) : (
              <span className="desc">compact · running/failed first</span>
            )}
          </div>
          <div className="runs-grid" data-testid="project-runs-grid" data-visible={visibleRuns.length}>
            {visibleRuns.map((r) => {
              const bound = r.taskId ? taskById[r.taskId] : undefined
              const humanTask = bound ? resolveTaskDisplayTitle(bound) : undefined
              return (
                <RunCard
                  key={r.id}
                  run={r}
                  model={m}
                  taskTitle={humanTask}
                />
              )
            })}
          </div>
          {!showAllRuns && hiddenRunCount > 0 ? (
            <div style={{ marginTop: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' }}>
              <button
                type="button"
                className="fbtn"
                data-testid="project-runs-show-all"
                onClick={() => setShowAllRuns(true)}
              >
                Lihat semua ({runs.length})
              </button>
              <span style={{ fontSize: 12, color: 'var(--text-faint)' }}>
                Menampilkan {PROJECT_RUNS_PAGE_SIZE} dari {runs.length} · sisanya disembunyikan
              </span>
            </div>
          ) : null}
          {showAllRuns && runs.length > PROJECT_RUNS_PAGE_SIZE ? (
            <div style={{ marginTop: 12 }}>
              <button
                type="button"
                className="fbtn"
                data-testid="project-runs-collapse"
                onClick={() => setShowAllRuns(false)}
              >
                Ciutkan runs
              </button>
            </div>
          ) : null}
        </section>
      ) : null}

      {groups.map(([title, feats]) => (
        <Collapsible
          key={title}
          title={title}
          count={feats.length}
          defaultOpen={title !== 'Parked for later'}
        >
          {[...feats]
            .sort((a, b) => {
              const d = (b.pct ?? 0) - (a.pct ?? 0)
              if (d !== 0) return d
              return a.id.localeCompare(b.id)
            })
            .map((f) => (
              <FeatureRow key={f.id} feature={f} model={m} />
            ))}
        </Collapsible>
      ))}

      <section className="section">
        <div className="sec-head">
          <h2>Architecture</h2>
        </div>
        <Architecture project={p} />
        <DesignLinks scope="project" id={p.id} links={p.design} />
      </section>

      {p.features.length > 0 ? (
        <section className="section">
          <div className="sec-head">
            <h2>Dependency map</h2>
          </div>
          <ClientOnly
            fallback={
              <div
                className="note"
                data-testid="dependency-map-ssr-placeholder"
                style={{ marginTop: 8 }}
              >
                Memuat peta ketergantungan…
              </div>
            }
          >
            <WireGraph features={p.features} />
          </ClientOnly>
        </section>
      ) : null}
    </>
  )
}
