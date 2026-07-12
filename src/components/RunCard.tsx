// Card for a single agent run. §6 of the readiness contract: shows role, account,
// task/FC/project, current task stage, target gate, heartbeat, evidence path, and
// terminal verdict. The card links to its task; a run with no task/gate/receipt is
// visibly UNPRODUCTIVE (contributes 0 progress).
import { BoardLink } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { AGENT_ICON, fmtDate } from '#/lib/format'
import { Chip, EffortChip, ModelChip, RunStatusPill, TypeTag } from '#/components/primitives'
import type { Model, Run } from '#/lib/types'

export interface RunTaskInfo { stage?: string | null; nextGate?: string | null; readinessPercent?: number }

export function RunCard({
  run: r,
  model: m,
  taskTitle,
  taskInfo,
}: {
  run: Run
  model: Model
  taskTitle?: string
  taskInfo?: RunTaskInfo
}) {
  const featureName = r.feature ? m.featById[r.feature]?.nama : undefined
  const projectName = r.project ? (m.projById[r.project]?.nama ?? r.project) : undefined
  const targetGate = r.targetGate ?? taskInfo?.nextGate ?? null
  const unproductive = !r.taskId || (r.status === 'running' && !targetGate && !r.verdict)

  const body = (
    <>
      <div className="run-top">
        <div className={`run-avatar ag-${r.agentType}`}>
          <Icon name={(AGENT_ICON[r.agentType] ?? 'dot') as never} />
        </div>
        <div className="run-id">
          <div className="run-name">{r.agent}</div>
          <div className="run-role">{r.role || r.agentType}</div>
        </div>
        {unproductive ? <span className="run-unprod">UNPRODUCTIVE</span> : null}
        <RunStatusPill status={r.status} />
      </div>
      <p className="run-task">{r.task}</p>
      <div className="run-meta">
        <TypeTag type={r.agentType} />
        <ModelChip model={r.model} />
        <EffortChip effort={r.effort} />
        {projectName ? <Chip><Icon name="folder" /> {projectName}</Chip> : null}
        {r.account ? <Chip className="chip-mono">{r.account}</Chip> : null}
      </div>

      {r.taskId ? (
        <div className="run-gate">
          <span className="run-stage">{taskInfo?.stage ?? '—'}</span>
          <Icon name="arrow" size={12} />
          <span className="run-target">{targetGate ?? 'no gate'}</span>
          {typeof taskInfo?.readinessPercent === 'number' ? <span className="run-ready">{taskInfo.readinessPercent}%</span> : null}
        </div>
      ) : null}

      {r.evidencePath || r.verdict ? (
        <div className="run-receipt">
          {r.verdict ? <span className={`run-verdict ${/fail|reject/i.test(r.verdict) ? 'is-fail' : 'is-pass'}`}>{r.verdict}</span> : null}
          {r.evidencePath ? <span className="run-ev"><Icon name="link" size={11} /> {r.evidencePath}</span> : null}
        </div>
      ) : null}

      <div className="run-foot">
        {taskTitle ? <span className="run-tasktitle"><Icon name="check" size={11} /> {taskTitle}</span> : featureName ? <span className="run-tasktitle">{featureName}</span> : <span />}
        {r.updated ? <span className="run-hb" title="last heartbeat"><Icon name="clock" size={11} /> {fmtDate(r.updated)}</span> : null}
      </div>
    </>
  )

  const cls = `run s-${r.status}${unproductive ? ' is-unproductive' : ''}`
  return r.taskId ? (
    <BoardLink to="/tasks/$taskId" params={{ taskId: r.taskId }} className={`${cls} run-link`}>{body}</BoardLink>
  ) : (
    <div className={cls}>{body}</div>
  )
}
