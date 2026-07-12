// Agents route — typed React port of the prototype `vAgents(m)` view
// (docs/plan/assets/app.js). Groups every run by status (Running / Blocked /
// Queued / Done / Failed) into `.runs-grid` sections, with a live count and
// a per-agent-type summary in the section description. Respects global search.
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'

import { boardQueryOptions, tasksQueryOptions, useBoard, useTasks } from '#/lib/board-query'
import { uiStore } from '#/store/ui'
import { RunCard } from '#/components/RunCard'
import { EmptyState } from '#/components/primitives'
import type { Run } from '#/lib/types'

export const Route = createFileRoute('/b/$boardId/agents')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
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
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  let runs = m.runs
  if (q) {
    runs = runs.filter((r) =>
      `${r.agent} ${r.task} ${r.model} ${r.agentType} ${r.effort}`.toLowerCase().includes(q),
    )
  }

  const groups = GROUPS.map(([t, s]) => [t, runs.filter((r) => r.status === s)] as [string, Run[]]).filter(
    (g) => g[1].length,
  )

  const byType: Record<string, number> = {}
  for (const r of m.runs) byType[r.agentType] = (byType[r.agentType] ?? 0) + 1

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Agents</h2>
          <span className="count">{m.runs.length}</span>
          <span className="live">
            <span className="blink" />
            {m.runningAgents.length} live
          </span>
          <span className="desc">
            {Object.entries(byType)
              .map(([t, n]) => `${n} ${t}`)
              .join(' · ')}
          </span>
        </div>
        {groups.length ? (
          groups.map(([t, rs]) => (
            <div key={t}>
              <div className="queue-rail" style={{ marginTop: 8 }}>
                <span
                  className={`queue-lbl ${t === 'Running' ? 'ql-now' : t === 'Blocked' || t === 'Failed' ? 'ql-blocked' : 'ql-next'}`}
                >
                  {t}
                </span>
                <span className="line" />
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rs.length}</span>
              </div>
              <div className="runs-grid" style={{ marginBottom: 16 }}>
                {rs.map((r) => (
                  <RunCard
                    key={r.id}
                    run={r}
                    model={m}
                    taskTitle={r.taskId ? taskById[r.taskId]?.title : undefined}
                  />
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
