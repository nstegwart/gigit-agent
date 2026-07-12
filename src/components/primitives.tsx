// Small shared presentational primitives — used by every card/view. Authored centrally
// so leaf components never diverge on chip markup. Class names come from styles.css.
import { BoardLink } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { AGENT_ICON, STATUS_LBL, fmtDate } from '#/lib/format'
import type { Feature, Project, Run, RunStatus } from '#/lib/types'

export function Chip({
  children,
  className = '',
}: {
  children: React.ReactNode
  className?: string
}) {
  return <span className={`chip ${className}`}>{children}</span>
}

/** Phase pill (Build / QA / …). Shows "Parked" when the feature is bucketed. */
export function PhaseBadge({ feature }: { feature: Feature }) {
  if (feature.parked) return <span className="phase ph-parked">Parked</span>
  return <span className={`phase ${feature.phaseCls}`}>{feature.phaseLabel}</span>
}

export function EffortChip({ effort }: { effort?: string }) {
  if (!effort) return null
  return <span className={`chip chip-effort eff-${effort}`}>effort {effort}</span>
}

export function ModelChip({ model }: { model?: string }) {
  if (!model) return null
  return <span className="chip chip-model chip-mono">{model}</span>
}

export function TypeTag({ type }: { type: string }) {
  return (
    <span className={`tag tag-type tt-${type}`}>
      <Icon name={(AGENT_ICON[type] ?? 'dot') as never} />
      {type}
    </span>
  )
}

export function MiniAgent({ run }: { run: Run }) {
  return (
    <span
      className={`mini-ag ag-${run.agentType}`}
      title={`${run.agent} · ${run.model}`}
    >
      <Icon name={(AGENT_ICON[run.agentType] ?? 'dot') as never} />
    </span>
  )
}

export function RunStatusPill({ status }: { status: RunStatus }) {
  return (
    <span className={`run-status s-${status}`}>
      <span className="dot" />
      {STATUS_LBL[status] ?? status}
    </span>
  )
}

/** Progress bar with optional right-hand label (defaults to `${pct}%`). */
export function ProgressBar({
  pct,
  ok = false,
  right,
}: {
  pct: number
  ok?: boolean
  right?: React.ReactNode
}) {
  return (
    <div className="progress">
      <div className={`bar ${ok ? 'ok' : ''}`}>
        <span style={{ width: `${pct}%` }} />
      </div>
      <span className="pct">{right ?? `${pct}%`}</span>
    </div>
  )
}

/** Coloured project dot + name (links optional via wrapping). */
export function ProjectPill({ project }: { project?: Project }) {
  if (!project) return null
  return (
    <span className="qcard-proj">
      <span className="pdot" style={{ background: project.color }} />
      {project.nama}
    </span>
  )
}

export function EmptyState({
  icon = 'inbox',
  children,
}: {
  icon?: string
  children: React.ReactNode
}) {
  return (
    <div className="empty">
      <Icon name={icon as never} size={30} />
      <div>{children}</div>
    </div>
  )
}

/** Run footer (task/feature link + timing) reused by RunCard. Board-scoped. */
export function RunFooter({
  run,
  featureName,
  taskTitle,
}: {
  run: Run
  featureName?: string
  taskTitle?: string
}) {
  return (
    <div className="run-foot">
      {run.taskId ? (
        <BoardLink to="/tasks/$taskId" params={{ taskId: run.taskId }}>
          <Icon name="check" />
          {taskTitle ?? run.taskId}
        </BoardLink>
      ) : run.feature ? (
        <BoardLink to="/features/$featureId" params={{ featureId: run.feature }}>
          <Icon name="features" />
          {featureName ?? run.feature}
        </BoardLink>
      ) : (
        <span>
          <Icon name="sparkles" /> main thread
        </span>
      )}
      <span className="when">{fmtDate(run.updated)}</span>
    </div>
  )
}
