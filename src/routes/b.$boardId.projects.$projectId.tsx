// Project detail — ported from prototype `vProject(m, id)` (docs/plan/assets/app.js).
// Same markup/classes as a typed React page body; AppShell provides the chrome.
import { createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'

import { boardQueryOptions, lifecycleQueryOptions, rollupQueryOptions, tasksQueryOptions, useBoard, useLifecycle, useRollup, useTasks } from '#/lib/board-query'
import { PROJ_STATUS } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { Collapsible } from '#/components/Collapsible'
import { EmptyState } from '#/components/primitives'
import { RunCard } from '#/components/RunCard'
import { FeatureRow } from '#/components/FeatureRow'
import { Architecture } from '#/components/Architecture'
import { DesignLinks } from '#/components/DesignLinks'
import { WireGraph } from '#/components/WireGraph'
import { TasksTable } from '#/components/TasksTable'
import type { Feature } from '#/lib/types'

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
  const runs = m.runs.filter((r) => r.project === p.id)
  const projTasks = allTasks.filter((t) => t.projectId === p.id)

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

      {runs.length ? (
        <section className="section">
          <div className="sec-head">
            <h2>Agents on this project</h2>
            <span className="count">{runs.length}</span>
          </div>
          <div className="runs-grid">
            {runs.map((r) => (
              <RunCard
                key={r.id}
                run={r}
                model={m}
                taskTitle={r.taskId ? taskById[r.taskId]?.title : undefined}
              />
            ))}
          </div>
        </section>
      ) : null}

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

      {groups.map(([title, feats]) => (
        <Collapsible
          key={title}
          title={title}
          count={feats.length}
          defaultOpen={title !== 'Parked for later'}
        >
          {[...feats]
            .sort((a, b) => (b.pct ?? 0) - (a.pct ?? 0))
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
          <WireGraph features={p.features} />
        </section>
      ) : null}
    </>
  )
}
