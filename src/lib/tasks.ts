// Task adapter — derives checkpoint progress for the Tasks view. Pure.
import type { WorkTask } from './types'

export interface TaskView extends WorkTask {
  done: number
  total: number
  pct: number
}

export function buildTasks(tasks: Array<WorkTask>): {
  tasks: Array<TaskView>
  byId: Record<string, TaskView>
} {
  const out: Array<TaskView> = tasks.map((t) => {
    const total = t.checkpoints.length
    const done = t.checkpoints.filter((c) => c.done).length
    return { ...t, done, total, pct: total ? Math.round((done / total) * 100) : 0 }
  })
  const byId: Record<string, TaskView> = {}
  for (const t of out) byId[t.id] = t
  return { tasks: out, byId }
}
