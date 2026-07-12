// Tasks list route (board-scoped) — a table (like the Features table) of first-class
// WorkTasks. Filters + search + sortable columns live in <TasksTable>.
import { createFileRoute } from '@tanstack/react-router'
import { useState } from 'react'

import { TasksTable } from '#/components/TasksTable'
import { RollupBar } from '#/components/RollupBar'
import { LifecycleEditor } from '#/components/LifecycleEditor'
import { Icon } from '#/lib/icons'
import { boardQueryOptions, lifecycleQueryOptions, rollupQueryOptions, tasksQueryOptions, useBoard, useLifecycle, useRollup, useTasks } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId/tasks/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

function View() {
  const { tasks } = useTasks()
  const m = useBoard()
  const rollup = useRollup()
  const cfg = useLifecycle()
  const [editRail, setEditRail] = useState(false)
  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Tasks</h2>
          <span className="count">{tasks.length}</span>
          <span className="desc">first-class tasks — click a row for the full checkpoint map</span>
          <button className="rail-edit-btn" onClick={() => setEditRail(true)}>
            <Icon name="branch" size={13} /> Edit rail
          </button>
        </div>
        <RollupBar />
        <TasksTable tasks={tasks} runsByTask={m.runsByTask} readinessByGroup={rollup.byFeature} milestone={rollup.milestone} cfg={cfg} />
      </section>
      {editRail ? <LifecycleEditor onClose={() => setEditRail(false)} /> : null}
    </div>
  )
}
