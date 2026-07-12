// Project card — ported from prototype `projCard(m, p)` (app.js).
import { BoardLink as Link } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { PROJ_STATUS } from '#/lib/format'
import { ProgressBar } from '#/components/primitives'
import type { Project } from '#/lib/types'

export function ProjectCard({ project }: { project: Project }) {
  const [scls, slbl] = PROJ_STATUS[project.status] ?? ['st-planned', project.status]
  const activeFeatures = project.features.filter((f) => !f.parked)
  const blockedFeatures = project.features.filter((f) => f.blocked)

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
        <div className="proj-stage">Stage: {project.stage || project.status}</div>
      </div>
      <div style={{ '--accent': project.color } as React.CSSProperties}>
        <ProgressBar pct={project.progress} />
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
