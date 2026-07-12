// Task detail (Batch 5) — first-class WorkTask view for /b/$boardId/tasks/$taskId.
// Hero + objective/next + story + CheckpointList + dependencies (BoardLinks) + impacts + refs.
// Board-scoped: data via useTasks() (tasksQueryOptions loader); AppShell provides the chrome.
import { createFileRoute } from '@tanstack/react-router'
import { BoardLink as Link } from '#/components/BoardLink'

import { boardQueryOptions, lifecycleQueryOptions, tasksQueryOptions, useBoard, useLifecycle, useTaskLazy, useTaskLifecycle, useTasks } from '#/lib/board-query'
import { stageReadiness } from '#/lib/readiness'
import { fmtDate } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { EmptyState, ProgressBar } from '#/components/primitives'
import { LifecycleRail } from '#/components/LifecycleRail'
import { RunCard } from '#/components/RunCard'
import { TaskMapping } from '#/components/TaskMapping'
import { TaskSections } from '#/components/TaskSections'

export const Route = createFileRoute('/b/$boardId/tasks/$taskId')({
  // Light summary + board + rail load in the loader; the heavy 20-point mapping
  // (~MBs) is fetched lazily on the client so first paint is instant.
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

function BackLink() {
  return (
    <Link to="/tasks" className="back">
      <Icon name="chevL" /> Back
    </Link>
  )
}

function View() {
  const { byId } = useTasks() // light summaries — instant shell + dependency titles
  const m = useBoard()
  const cfg = useLifecycle()
  const { taskId } = Route.useParams()
  const { data: lc } = useTaskLifecycle(taskId)
  const { data: full, isLoading: loadingFull } = useTaskLazy(taskId) // heavy mapping, lazy
  const agents = m.runsByTask[taskId] ?? []

  const base = full ?? byId[taskId] // render the shell from the light summary immediately
  if (!base) {
    return (
      <>
        <BackLink />
        {loadingFull ? <EmptyState icon="clock">Loading…</EmptyState> : <EmptyState icon="alert">Task not found.</EmptyState>}
      </>
    )
  }
  const total = base.checkpoints.length
  const done = base.checkpoints.filter((c) => c.done).length
  const t = { ...base, total, done, pct: total ? Math.round((done / total) * 100) : 0 }
  const readyPct = stageReadiness(cfg, lc?.stage)

  const story = full?.story
  const hasStory = !!(story && (story.userStory || story.currentGap || story.targetScope))
  const refs = full?.refs
  const api = refs?.api ?? []
  const pages = refs?.pages ?? []
  const hasRefs = !!(refs && (refs.evidence || api.length || pages.length))

  return (
    <>
      <BackLink />
      <div className="detail-head">
        <div className="detail-title">
          <div style={{ flex: 1 }}>
            <h1>{t.title}</h1>
            <div className="detail-sub">
              <span className="chip chip-mono task-id">{t.id}</span>
              {lc?.stage ? <span className="task-phase">{lc.stage}</span> : t.phase ? <span className="task-phase">{t.phase}</span> : null}
              {t.projectId ? <span className="chip">{t.projectId}</span> : null}
              {t.scope ? <span className="chip">{t.scope}</span> : null}
            </div>
            <div style={{ marginTop: 12, maxWidth: 340 }}>
              <ProgressBar pct={readyPct} ok={readyPct >= 100} right={`${readyPct}% ready-production`} />
            </div>
          </div>
        </div>
      </div>

      <LifecycleRail taskId={taskId} checkpoints={t.checkpoints} />

      <TaskSections sections={full?.sections} />

      <div className="grid-2">
        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          {agents.length > 0 ? (
            <div className="card">
              <div className="card-head">
                <Icon name="agents" className="nav-ico" />
                <h3>Agents on this task</h3>
                <span className="count">{agents.length}</span>
              </div>
              <div
                className="card-body"
                style={{ display: 'flex', flexDirection: 'column', gap: 10, paddingTop: 12 }}
              >
                {agents.map((r) => (
                  <RunCard key={r.id} run={r} model={m} taskTitle={t.title} />
                ))}
              </div>
            </div>
          ) : null}
          {t.objective || t.next ? (
            <div className="card">
              <div className="card-head">
                <Icon name="flag" className="nav-ico" />
                <h3>Objective</h3>
              </div>
              <div className="card-body">
                {t.objective ? (
                  <p className="note" style={{ border: 0, padding: '4px 0' }}>
                    {t.objective}
                  </p>
                ) : null}
                {t.next ? (
                  <div className="meta-row">
                    <span className="k">Next</span>
                    <span className="v">{t.next}</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}

          {hasStory ? (
            <div className="card">
              <div className="card-head">
                <Icon name="inbox" className="nav-ico" />
                <h3>Story</h3>
              </div>
              <div className="card-body">
                {story?.userStory ? (
                  <div className="meta-row">
                    <span className="k">User story</span>
                    <span className="v">{story.userStory}</span>
                  </div>
                ) : null}
                {story?.currentGap ? (
                  <div className="meta-row">
                    <span className="k">Current gap</span>
                    <span className="v">{story.currentGap}</span>
                  </div>
                ) : null}
                {story?.targetScope ? (
                  <div className="meta-row">
                    <span className="k">Target scope</span>
                    <span className="v">{story.targetScope}</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>

        <div style={{ display: 'flex', flexDirection: 'column', gap: 16 }}>
          <div className="card">
            <div className="card-head">
              <Icon name="layers" className="nav-ico" />
              <h3>Details</h3>
            </div>
            <div className="card-body">
              <div className="meta-row">
                <span className="k">Progress</span>
                <span className="v" style={{ flex: 1 }}>
                  <ProgressBar pct={t.pct} ok={t.pct === 100} />
                </span>
              </div>
              {t.group ? (
                <div className="meta-row">
                  <span className="k">Group</span>
                  <span className="v">
                    <span className="chip">{t.group}</span>
                  </span>
                </div>
              ) : null}
              {t.status ? (
                <div className="meta-row">
                  <span className="k">Status</span>
                  <span className="v">{t.status}</span>
                </div>
              ) : null}
              {typeof t.mappingPct === 'number' ? (
                <div className="meta-row">
                  <span className="k">Mapping</span>
                  <span className="v">{t.mappingPct}%</span>
                </div>
              ) : null}
              {t.featureContractId ? (
                <div className="meta-row">
                  <span className="k">Contract</span>
                  <span className="v">
                    <span className="chip chip-mono">{t.featureContractId}</span>
                  </span>
                </div>
              ) : null}
              {t.updated ? (
                <div className="meta-row">
                  <span className="k">Updated</span>
                  <span className="v">{fmtDate(t.updated)}</span>
                </div>
              ) : null}
            </div>
          </div>

          {t.dependencies.length ? (
            <div className="card">
              <div className="card-head">
                <Icon name="branch" className="nav-ico" />
                <h3>Dependencies</h3>
                <span className="count">{t.dependencies.length}</span>
              </div>
              <div className="card-body">
                <div className="meta-row">
                  <span className="v">
                    {t.dependencies.map((d) => (
                      <Link
                        key={d}
                        to="/tasks/$taskId"
                        params={{ taskId: d }}
                        className="chip"
                        style={{ color: 'var(--warn)', background: 'var(--warn-bg)' }}
                      >
                        <Icon name="lock" />
                        {byId[d]?.title ?? d}
                      </Link>
                    ))}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {t.impacts.length ? (
            <div className="card">
              <div className="card-head">
                <Icon name="bolt" className="nav-ico" />
                <h3>Impacts</h3>
                <span className="count">{t.impacts.length}</span>
              </div>
              <div className="card-body">
                <div className="meta-row">
                  <span className="v">
                    {t.impacts.map((x) => (
                      <span className="chip" key={x}>
                        {x}
                      </span>
                    ))}
                  </span>
                </div>
              </div>
            </div>
          ) : null}

          {hasRefs ? (
            <div className="card">
              <div className="card-head">
                <Icon name="link" className="nav-ico" />
                <h3>References</h3>
              </div>
              <div className="card-body">
                {api.length ? (
                  <div className="meta-row">
                    <span className="k">API</span>
                    <span className="v">
                      {api.map((x) => (
                        <span className="chip chip-mono" key={x}>
                          {x}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
                {pages.length ? (
                  <div className="meta-row">
                    <span className="k">Pages</span>
                    <span className="v">
                      {pages.map((x) => (
                        <span className="chip chip-mono" key={x}>
                          {x}
                        </span>
                      ))}
                    </span>
                  </div>
                ) : null}
                {refs?.evidence ? (
                  <div className="meta-row">
                    <span className="k">Evidence</span>
                    <span className="v">{refs.evidence}</span>
                  </div>
                ) : null}
              </div>
            </div>
          ) : null}
        </div>
      </div>

      {full ? (
        <TaskMapping task={t} />
      ) : loadingFull ? (
        <section className="section">
          <div className="sec-head"><h2>Rebuild mapping</h2><span className="desc">loading…</span></div>
          <div className="map-skeleton">
            <span className="spinner" />
            <span className="page-loading-txt">Loading the 20-point mapping…</span>
          </div>
        </section>
      ) : null}
    </>
  )
}
