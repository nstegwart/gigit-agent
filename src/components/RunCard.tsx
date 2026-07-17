// Card for a single agent run. §6 of the readiness contract: shows role, account,
// task/FC/project, current task stage, target gate, heartbeat, evidence path, and
// terminal verdict. The card links to its task; a run with no task/gate/receipt is
// visibly UNPRODUCTIVE (contributes 0 progress).
// W-FIX-PROJECTS: primary line prefers human task title over internal agent/run-id.
import { BoardLink } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { AGENT_ICON, fmtDate } from '#/lib/format'
import { Chip, EffortChip, ModelChip, RunStatusPill, TypeTag } from '#/components/primitives'
import type { Model, Run, RunStatus } from '#/lib/types'

export interface RunTaskInfo { stage?: string | null; nextGate?: string | null; readinessPercent?: number }

/** Visible runs before "lihat semua" on project detail (V1.2 G-B / W-FIX-PROJECTS A). */
export const PROJECT_RUNS_PAGE_SIZE = 8

const RUN_STATUS_PRIORITY: Readonly<Record<RunStatus, number>> = {
  running: 0,
  failed: 1,
  blocked: 2,
  queued: 3,
  done: 4,
}

/**
 * Sort project runs for owner scan: running/failed first, then blocked/queued/done;
 * stable secondary by updated desc + id.
 */
export function sortProjectRuns(runs: ReadonlyArray<Run>): Array<Run> {
  return runs.slice().sort((a, b) => {
    const pa = RUN_STATUS_PRIORITY[a.status] ?? 9
    const pb = RUN_STATUS_PRIORITY[b.status] ?? 9
    if (pa !== pb) return pa - pb
    const ta = a.updated || a.started || ''
    const tb = b.updated || b.started || ''
    if (ta !== tb) return ta < tb ? 1 : -1
    return (a.id || '').localeCompare(b.id || '')
  })
}

/** Count of runs in attention statuses (running/failed) for the compact header. */
export function countAttentionRuns(runs: ReadonlyArray<Run>): number {
  return runs.filter((r) => r.status === 'running' || r.status === 'failed').length
}

/** True when a string looks like an internal worker/run id (not owner-facing). */
export function looksLikeRunId(raw: string | null | undefined): boolean {
  const s = (raw ?? '').trim()
  if (!s) return true
  if (/^w-stage\d/i.test(s)) return true
  if (/^(run|agent|acc|cairn)[-_]/i.test(s) && s.length > 24) return true
  if (/\d{8}T\d{4}Z/i.test(s)) return true
  if (/-[a-z]\d{2}-s\d{2}$/i.test(s)) return true
  return false
}

/**
 * Owner-facing primary label for a run card.
 * Prefer bound task title → descriptive r.task → cleaned agent name (never raw run-id alone when better text exists).
 */
export function runCardPrimaryLabel(opts: {
  agent: string
  task: string
  taskTitle?: string | null
}): string {
  const title = (opts.taskTitle ?? '').trim()
  if (title && !looksLikeRunId(title)) return title
  const task = (opts.task ?? '').trim()
  if (task && !looksLikeRunId(task)) return task
  const agent = (opts.agent ?? '').trim()
  if (agent && !looksLikeRunId(agent)) return agent
  // Last resort: truncate long run-id so the card is not a wall of mono text
  if (agent.length > 36) return `${agent.slice(0, 20)}…${agent.slice(-8)}`
  return agent || task || title || 'Run'
}

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
  const primary = runCardPrimaryLabel({ agent: r.agent, task: r.task, taskTitle })
  const showAgentSecondary = r.agent && primary !== r.agent && looksLikeRunId(r.agent)

  const body = (
    <>
      <div className="run-top">
        <div className={`run-avatar ag-${r.agentType}`}>
          <Icon name={(AGENT_ICON[r.agentType] ?? 'dot') as never} />
        </div>
        <div className="run-id">
          <div className="run-name" title={r.agent}>{primary}</div>
          <div className="run-role">
            {r.role || r.agentType}
            {showAgentSecondary ? (
              <span className="run-agent-id" title={r.agent} style={{ display: 'block', fontSize: 10.5, opacity: 0.65, fontFamily: 'var(--font-mono, ui-monospace, monospace)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 220 }}>
                {r.agent.length > 36 ? `${r.agent.slice(0, 18)}…${r.agent.slice(-10)}` : r.agent}
              </span>
            ) : null}
          </div>
        </div>
        {unproductive ? <span className="run-unprod">UNPRODUCTIVE</span> : null}
        <RunStatusPill status={r.status} />
      </div>
      {/* Avoid duplicating primary when r.task was promoted to the title line */}
      {r.task && r.task.trim() !== primary ? <p className="run-task">{r.task}</p> : null}
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
        {taskTitle && taskTitle !== primary ? (
          <span className="run-tasktitle"><Icon name="check" size={11} /> {taskTitle}</span>
        ) : featureName ? (
          <span className="run-tasktitle">{featureName}</span>
        ) : (
          <span />
        )}
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
