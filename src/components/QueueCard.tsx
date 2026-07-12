// Card for a feature in a work-queue rail (Now / Next / Blocked). Ported from prototype
// `qcard(m, f, gate)` (docs/plan/assets/app.js) — same markup/classes, as a typed block Link.
import { BoardLink as Link } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { PhaseBadge, ProjectPill, ProgressBar, MiniAgent } from '#/components/primitives'
import type { Feature, Model } from '#/lib/types'

export function QueueCard({
  feature: f,
  model: m,
  gate = false,
}: {
  feature: Feature
  model: Model
  gate?: boolean
}) {
  const nextTask = (f.checklist ?? []).find((c) => !c.done)
  const ag = f.runs.filter((r) => r.status === 'running')
  const project = f.projectId ? m.projById[f.projectId] : undefined

  return (
    <Link to="/features/$featureId" params={{ featureId: f.id }} className="qcard">
      <div className="qcard-top">
        <div className="qcard-name">{f.nama}</div>
        <PhaseBadge feature={f} />
      </div>
      <div
        className="qcard-proj-row"
        style={{ display: 'flex', alignItems: 'center', gap: 10, justifyContent: 'space-between' }}
      >
        <ProjectPill project={project} />
        <span className="chip">
          {f.taskDone}/{f.taskTotal} tasks
        </span>
      </div>
      <ProgressBar pct={f.pct ?? 0} />
      {gate && f.deps && f.deps.length ? (
        <div className="qcard-gate">
          <Icon name="lock" />
          unlocks after <b>{f.deps.map((d) => m.featById[d]?.nama ?? d).join(', ')}</b>
        </div>
      ) : nextTask ? (
        <div className="qcard-next">
          <span className="play">
            <Icon name="play" />
          </span>
          {nextTask.teks}
        </div>
      ) : null}
      {ag.length ? (
        <div className="qcard-agents">
          {ag.map((run) => (
            <MiniAgent key={run.id} run={run} />
          ))}
          <span style={{ fontSize: 11, color: 'var(--text-faint)', marginLeft: 8 }}>
            {ag.length} agent{ag.length > 1 ? 's' : ''} working
          </span>
        </div>
      ) : null}
    </Link>
  )
}
