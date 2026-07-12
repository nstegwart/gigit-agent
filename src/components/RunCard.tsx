// Card for a single agent run (running/blocked/queued/done/failed). Ported from prototype
// `runCard(m, r)` — same markup/classes, as a typed block. Links agent → task/feature,
// and shows the project + agent-account it uses (interconnect).
import { Icon } from '#/lib/icons'
import { AGENT_ICON } from '#/lib/format'
import {
  Chip,
  EffortChip,
  ModelChip,
  RunFooter,
  RunStatusPill,
  TypeTag,
} from '#/components/primitives'
import type { Model, Run } from '#/lib/types'

export function RunCard({
  run: r,
  model: m,
  taskTitle,
}: {
  run: Run
  model: Model
  taskTitle?: string
}) {
  const featureName = r.feature ? m.featById[r.feature]?.nama : undefined
  const projectName = r.project ? (m.projById[r.project]?.nama ?? r.project) : undefined

  return (
    <div className={`run s-${r.status}`}>
      <div className="run-top">
        <div className={`run-avatar ag-${r.agentType}`}>
          <Icon name={(AGENT_ICON[r.agentType] ?? 'dot') as never} />
        </div>
        <div className="run-id">
          <div className="run-name">{r.agent}</div>
          <div className="run-role">{r.role || r.agentType}</div>
        </div>
        <RunStatusPill status={r.status} />
      </div>
      <p className="run-task">{r.task}</p>
      <div className="run-meta">
        <TypeTag type={r.agentType} />
        <ModelChip model={r.model} />
        <EffortChip effort={r.effort} />
        {projectName ? (
          <Chip>
            <Icon name="folder" /> {projectName}
          </Chip>
        ) : null}
        {r.account ? <Chip className="chip-mono">{r.account}</Chip> : null}
      </div>
      <RunFooter run={r} featureName={featureName} taskTitle={taskTitle} />
    </div>
  )
}
