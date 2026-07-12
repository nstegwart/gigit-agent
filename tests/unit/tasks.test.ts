// Unit tests for the Tasks adapter (buildTasks in src/lib/tasks.ts). Reads the
// real mfs-rebuild board tasks.json from disk (node:fs) and asserts the derived
// done/total/pct fields, a known task's counts, and byId lookup. Pure — no
// server, no temp dir; the SSOT file is only read, never written.
import fs from 'node:fs'
import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { buildTasks } from '#/lib/tasks'
import type { WorkTask } from '#/lib/types'

const tasksFile = path.resolve(
  process.cwd(),
  'data/boards/mfs-rebuild/tasks.json',
)

const raw = JSON.parse(fs.readFileSync(tasksFile, 'utf8')) as {
  tasks: Array<WorkTask>
}
const rawTasks = raw.tasks

const { tasks, byId } = buildTasks(rawTasks)

describe('buildTasks', () => {
  it('returns a view for every task with done/total/pct fields', () => {
    expect(tasks.length).toBe(rawTasks.length)
    expect(tasks.length).toBeGreaterThan(0)
    for (const t of tasks) {
      expect(typeof t.done).toBe('number')
      expect(typeof t.total).toBe('number')
      expect(typeof t.pct).toBe('number')
      // total equals the checkpoint count; done never exceeds total
      expect(t.total).toBe(t.checkpoints.length)
      expect(t.done).toBeGreaterThanOrEqual(0)
      expect(t.done).toBeLessThanOrEqual(t.total)
      // pct is a rounded 0..100 percentage of done/total
      expect(t.pct).toBeGreaterThanOrEqual(0)
      expect(t.pct).toBeLessThanOrEqual(100)
      const expectedPct = t.total ? Math.round((t.done / t.total) * 100) : 0
      expect(t.pct).toBe(expectedPct)
    }
  })

  it('derives total===checkpoints.length and done===completed count for a known task', () => {
    const t = byId['T-AFF-INTEGRATION-E2E']
    expect(t).toBeDefined()
    const src = rawTasks.find((x) => x.id === 'T-AFF-INTEGRATION-E2E')
    expect(src).toBeDefined()
    expect(t.total).toBe(src!.checkpoints.length)
    expect(t.done).toBe(src!.checkpoints.filter((c) => c.done).length)
    expect(t.pct).toBe(Math.round((t.done / t.total) * 100))
  })

  it('byId lookup resolves every task id back to its view', () => {
    for (const t of rawTasks) {
      expect(byId[t.id]).toBeDefined()
      expect(byId[t.id].id).toBe(t.id)
    }
    expect(byId['does-not-exist']).toBeUndefined()
  })
})
