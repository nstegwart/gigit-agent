// Tasks list route (board-scoped) — a table (like the Features table) of first-class
// WorkTasks. Filters + search + sortable columns live in <TasksTable>.
import { createFileRoute } from '@tanstack/react-router'

import { TasksTable } from '#/components/TasksTable'
import { RollupBar } from '#/components/RollupBar'
import { boardQueryOptions, rollupQueryOptions, tasksQueryOptions, useBoard, useTasks } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId/tasks/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

function View() {
  const { tasks } = useTasks()
  const m = useBoard()
  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Tasks</h2>
          <span className="count">{tasks.length}</span>
          <span className="desc">first-class tasks — click a row for the full checkpoint map</span>
        </div>
        <RollupBar />
        <TasksTable tasks={tasks} runsByTask={m.runsByTask} />
      </section>
    </div>
  )
}
