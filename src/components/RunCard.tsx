// Card for a single agent run — Direction B (FAN-PROJECTS).
// Logic preserved; presentation via UI kit Card / StatusChip / Badge / Disclosure.
import type { CSSProperties } from 'react'
import { BoardLink } from '#/components/BoardLink'
import { Icon } from '#/lib/icons'
import { AGENT_ICON, fmtDate } from '#/lib/format'
import {
  Badge,
  Card,
  Disclosure,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import type { Model, Run, RunStatus } from '#/lib/types'

export interface RunTaskInfo {
  stage?: string | null
  nextGate?: string | null
  readinessPercent?: number
}

/** Visible runs before "lihat semua" on project detail (V1.2 G-B / W-FIX-PROJECTS A). */
export const PROJECT_RUNS_PAGE_SIZE = 8

const RUN_STATUS_PRIORITY: Readonly<Record<RunStatus, number>> = {
  running: 0,
  failed: 1,
  blocked: 2,
  queued: 3,
  done: 4,
}

const STATUS_LABEL_ID: Readonly<Record<RunStatus, string>> = {
  running: 'Berjalan',
  blocked: 'Terhambat',
  queued: 'Antri',
  done: 'Selesai',
  failed: 'Gagal',
}

function runStatusVariant(status: RunStatus): StatusChipVariant {
  if (status === 'done') return 'done'
  if (status === 'running') return 'ongoing'
  if (status === 'failed' || status === 'blocked') return 'blocked'
  if (status === 'queued') return 'pending'
  return 'pending'
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

const topStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'flex-start',
  gap: 'var(--sp-2)',
  minWidth: 0,
}

const avatarStyle: CSSProperties = {
  width: 28,
  height: 28,
  borderRadius: 'var(--r-sm, 6px)',
  border: '1px solid var(--border)',
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  flexShrink: 0,
  background: 'var(--surface-2, var(--bg))',
  color: 'var(--text-dim)',
}

const nameStyle: CSSProperties = {
  fontWeight: 500,
  color: 'var(--text)',
  fontSize: 'var(--type-small-size, 13px)',
  lineHeight: 1.35,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const roleStyle: CSSProperties = {
  fontSize: 'var(--type-caption-size, 12px)',
  color: 'var(--text-dim)',
}

const monoStyle: CSSProperties = {
  fontFamily: 'var(--mono, ui-monospace, monospace)',
  fontSize: 10.5,
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
  maxWidth: 220,
  display: 'block',
}

const metaStyle: CSSProperties = {
  display: 'flex',
  flexWrap: 'wrap',
  gap: 6,
  marginTop: 'var(--sp-2)',
}

const footStyle: CSSProperties = {
  display: 'flex',
  justifyContent: 'space-between',
  alignItems: 'center',
  gap: 8,
  marginTop: 'var(--sp-2)',
  fontSize: 11.5,
  color: 'var(--text-faint)',
}

const techDlStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '4px 12px',
  margin: 0,
  fontSize: 12,
}

const linkReset: CSSProperties = {
  textDecoration: 'none',
  color: 'inherit',
  display: 'block',
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
  const statusLabel = STATUS_LABEL_ID[r.status] ?? r.status

  const body = (
    <Card
      as="article"
      data-run-id={r.id}
      data-run-status={r.status}
      data-unproductive={unproductive ? 'true' : undefined}
      style={{
        borderColor: unproductive ? 'var(--blocked)' : undefined,
      }}
      headerActions={
        <span style={{ display: 'inline-flex', gap: 6, alignItems: 'center' }}>
          {unproductive ? (
            <Badge variant="neutral">Tidak produktif</Badge>
          ) : null}
          <StatusChip variant={runStatusVariant(r.status)}>{statusLabel}</StatusChip>
        </span>
      }
      title={
        <span style={topStyle}>
          <span style={avatarStyle} className={`ag-${r.agentType}`} aria-hidden>
            <Icon name={(AGENT_ICON[r.agentType] ?? 'dot') as never} size={14} />
          </span>
          <span style={{ minWidth: 0, flex: 1 }}>
            <span style={nameStyle} title={r.agent}>
              {primary}
            </span>
            <span style={roleStyle}>
              {r.role || r.agentType}
              {showAgentSecondary ? (
                <span style={monoStyle} title={r.agent}>
                  {r.agent.length > 36 ? `${r.agent.slice(0, 18)}…${r.agent.slice(-10)}` : r.agent}
                </span>
              ) : null}
            </span>
          </span>
        </span>
      }
    >
      {r.task && r.task.trim() !== primary ? (
        <p style={{ margin: '0 0 8px', fontSize: 13, color: 'var(--text-dim)' }}>{r.task}</p>
      ) : null}

      <div style={metaStyle}>
        <Badge>{r.agentType}</Badge>
        {r.model ? <Badge mono>{r.model}</Badge> : null}
        {r.effort ? <Badge>effort {r.effort}</Badge> : null}
        {projectName ? (
          <Badge>
            <Icon name="folder" size={11} /> {projectName}
          </Badge>
        ) : null}
        {r.account ? <Badge mono>{r.account}</Badge> : null}
      </div>

      {r.taskId ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 6,
            marginTop: 'var(--sp-2)',
            fontSize: 12,
            color: 'var(--text-dim)',
          }}
        >
          <span>{taskInfo?.stage ?? '—'}</span>
          <Icon name="arrow" size={12} />
          <span style={{ color: targetGate ? 'var(--accent)' : 'var(--text-faint)' }}>
            {targetGate ?? 'tanpa gate'}
          </span>
          {typeof taskInfo?.readinessPercent === 'number' ? (
            <Badge mono>{taskInfo.readinessPercent}%</Badge>
          ) : null}
        </div>
      ) : null}

      {(r.verdict || r.evidencePath || r.id || r.account) && (
        <div style={{ marginTop: 'var(--sp-2)' }}>
          <Disclosure summary="Detail teknis">
            <dl style={techDlStyle}>
              {r.verdict ? (
                <>
                  <dt>Verdict</dt>
                  <dd
                    style={{
                      margin: 0,
                      color: /fail|reject/i.test(r.verdict) ? 'var(--blocked)' : 'var(--done)',
                      fontWeight: 500,
                    }}
                  >
                    {r.verdict}
                  </dd>
                </>
              ) : null}
              {r.evidencePath ? (
                <>
                  <dt>Evidence</dt>
                  <dd style={{ ...monoStyle, maxWidth: '100%', whiteSpace: 'normal', wordBreak: 'break-all' }}>
                    {r.evidencePath}
                  </dd>
                </>
              ) : null}
              <dt>Run id</dt>
              <dd style={{ ...monoStyle, maxWidth: '100%' }}>{r.id}</dd>
              {r.agent ? (
                <>
                  <dt>Agent</dt>
                  <dd style={{ ...monoStyle, maxWidth: '100%' }}>{r.agent}</dd>
                </>
              ) : null}
              {r.account ? (
                <>
                  <dt>Akun</dt>
                  <dd style={{ ...monoStyle, maxWidth: '100%' }}>{r.account}</dd>
                </>
              ) : null}
            </dl>
          </Disclosure>
        </div>
      )}

      <div style={footStyle}>
        {taskTitle && taskTitle !== primary ? (
          <span>
            <Icon name="check" size={11} /> {taskTitle}
          </span>
        ) : featureName ? (
          <span>{featureName}</span>
        ) : (
          <span />
        )}
        {r.updated ? (
          <span title="detak terakhir">
            <Icon name="clock" size={11} /> {fmtDate(r.updated)}
          </span>
        ) : null}
      </div>
    </Card>
  )

  return r.taskId ? (
    <BoardLink to="/tasks/$taskId" params={{ taskId: r.taskId }} style={linkReset} className="run-link">
      {body}
    </BoardLink>
  ) : (
    body
  )
}
