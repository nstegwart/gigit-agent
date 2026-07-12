// Agents route — who is moving which gate (§6). Top summary (live / blocked /
// unproductive / done + account capacity), runs grouped by status, each card
// linking to its task with its current stage → target gate, evidence, verdict,
// and heartbeat.
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'

import { boardQueryOptions, lifecycleQueryOptions, opsQueryOptions, tasksQueryOptions, useBoard, useLifecycle, useOps, useTasks } from '#/lib/board-query'
import { nextStage, stageReadiness } from '#/lib/readiness'
import { uiStore } from '#/store/ui'
import { RunCard, type RunTaskInfo } from '#/components/RunCard'
import { EmptyState } from '#/components/primitives'
import type { Run } from '#/lib/types'

export const Route = createFileRoute('/b/$boardId/agents')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(opsQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

const GROUPS: Array<[string, Run['status']]> = [
  ['Running', 'running'],
  ['Blocked', 'blocked'],
  ['Queued', 'queued'],
  ['Done', 'done'],
  ['Failed', 'failed'],
]

function View() {
  const m = useBoard()
  const { byId: taskById } = useTasks()
  const cfg = useLifecycle()
  const ops = useOps()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  const info = (r: Run): RunTaskInfo | undefined => {
    const t = r.taskId ? taskById[r.taskId] : null
    if (!t) return undefined
    return { stage: t.lifecycleStage ?? null, nextGate: nextStage(cfg, t.lifecycleStage)?.key ?? null, readinessPercent: stageReadiness(cfg, t.lifecycleStage) }
  }

  let runs = m.runs
  if (q) runs = runs.filter((r) => `${r.agent} ${r.task} ${r.model} ${r.agentType} ${r.effort}`.toLowerCase().includes(q))
  const groups = GROUPS.map(([t, s]) => [t, runs.filter((r) => r.status === s)] as [string, Array<Run>]).filter((g) => g[1].length)

  const live = m.runningAgents.length
  const blocked = m.runs.filter((r) => r.status === 'blocked').length
  const done = m.runs.filter((r) => r.status === 'done').length
  const unproductive = m.runs.filter((r) => r.status === 'running' && (!r.taskId || (!r.targetGate && !r.verdict))).length
  const usable = ops.accounts.filter((a) => a.usable).length
  const limited = ops.accounts.filter((a) => !a.usable).length

  const tiles: Array<[string, number | string, string]> = [
    ['Live runs', live, 'ok'],
    ['Blocked', blocked, blocked ? 'warn' : ''],
    ['Unproductive', unproductive, unproductive ? 'blocked' : ''],
    ['Done', done, ''],
    ['Accounts usable', `${usable}/${usable + limited}`, limited ? 'warn' : 'ok'],
  ]

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Agents</h2>
          <span className="count">{m.runs.length}</span>
          <span className="live"><span className="blink" />{live} live</span>
          <span className="desc">who is moving which gate — not the source of progress</span>
        </div>

        <div className="agsum">
          {tiles.map(([lbl, val, tone]) => (
            <div className={`agsum-tile ${tone ? `t-${tone}` : ''}`} key={lbl}>
              <div className="agsum-n">{val}</div>
              <div className="agsum-l">{lbl}</div>
            </div>
          ))}
        </div>

        {groups.length ? (
          groups.map(([t, rs]) => (
            <div key={t}>
              <div className="queue-rail" style={{ marginTop: 8 }}>
                <span className={`queue-lbl ${t === 'Running' ? 'ql-now' : t === 'Blocked' || t === 'Failed' ? 'ql-blocked' : 'ql-next'}`}>{t}</span>
                <span className="line" />
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rs.length}</span>
              </div>
              <div className="runs-grid" style={{ marginBottom: 16 }}>
                {rs.map((r) => (
                  <RunCard key={r.id} run={r} model={m} taskTitle={r.taskId ? taskById[r.taskId]?.title : undefined} taskInfo={info(r)} />
                ))}
              </div>
            </div>
          ))
        ) : (
          <EmptyState icon="agents">No agents.</EmptyState>
        )}
      </section>
    </div>
  )
}
