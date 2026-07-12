// Project card — ported from prototype `projCard(m, p)` (app.js).
import { BoardLink as Link } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { PROJ_STATUS } from '#/lib/format'
import { ProgressBar } from '#/components/primitives'
import type { GroupReadiness, Project } from '#/lib/types'

export function ProjectCard({ project, readiness }: { project: Project; readiness?: GroupReadiness }) {
  const [scls, slbl] = PROJ_STATUS[project.status] ?? ['st-planned', project.status]
  const activeFeatures = project.features.filter((f) => !f.parked)
  const blockedFeatures = project.features.filter((f) => f.blocked)
  const pct = readiness ? readiness.readinessPercent : project.progress

  return (
    <Link to="/projects/$projectId" params={{ projectId: project.id }} className="proj">
      <span className={`proj-statusdot ${scls}`}>
        <Icon name="dot" />
        {slbl}
      </span>
      <div className="proj-ico" style={{ background: `${project.color}22`, color: project.color }}>
        <Icon name="folder" />
      </div>
      <div>
        <h3>{project.nama}</h3>
        <div className="proj-stage">
          {readiness ? <>Floor: {readiness.floor ?? '—'}</> : <>Stage: {project.stage || project.status}</>}
        </div>
      </div>
      <div style={{ '--accent': project.color } as React.CSSProperties}>
        <ProgressBar pct={pct} right={readiness ? `${pct}% ready` : undefined} />
        {readiness ? (
          <>
            <div className="proj-ready">{readiness.atMilestone}/{readiness.total} production-ready</div>
            <div className="proj-stages">
              {Object.entries(readiness.counts).filter(([, n]) => n).map(([k, n]) => (
                <span className="proj-stage-c" key={k}>{k}<b>{n}</b></span>
              ))}
              {readiness.uninitialized ? <span className="proj-stage-c is-uninit">uninit<b>{readiness.uninitialized}</b></span> : null}
            </div>
          </>
        ) : null}
      </div>
      <div className="proj-meta">
        <span>
          <b>{activeFeatures.length}</b> features
        </span>
        <span>
          <b>{project.activeAgents}</b> agents
        </span>
        <span>
          <b>{blockedFeatures.length}</b> blocked
        </span>
      </div>
    </Link>
  )
}
