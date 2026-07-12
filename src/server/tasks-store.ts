// Tasks stored as REAL rows (not one giant JSON blob). Each task is a row in `tasks`
// with indexed columns (board_id, project_id, feature_contract_id, phase…), a small
// `summary` JSON for list views, and the heavy 20-point mapping in `data` JSON — read
// only on the detail page. This keeps list/detail reads tiny instead of pulling the
// whole ~17MB collection every time. Server-only.
import { db, readDoc } from './db'
import type { WorkTask } from '#/lib/types'

let schemaReady: Promise<void> | null = null
export function ensureTaskSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = db()
      .query(`CREATE TABLE IF NOT EXISTS tasks (
        board_id VARCHAR(64) NOT NULL,
        id VARCHAR(160) NOT NULL,
        project_id VARCHAR(64) NULL,
        feature_contract_id VARCHAR(160) NULL,
        grp VARCHAR(191) NULL,
        phase VARCHAR(191) NULL,
        scope VARCHAR(64) NULL,
        title TEXT NULL,
        updated VARCHAR(40) NULL,
        summary JSON NULL,
        data JSON NULL,
        PRIMARY KEY (board_id, id),
        KEY idx_bp (board_id, project_id),
        KEY idx_bf (board_id, feature_contract_id)
      ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
      .then(() => undefined)
      .catch((e) => { schemaReady = null; throw e })
  }
  return schemaReady
}

/** Fields the list views (TasksTable, project page, list_tasks) need — no heavy mapping. */
function summaryOf(t: WorkTask) {
  return {
    checkpoints: t.checkpoints ?? [],
    dependencies: t.dependencies ?? [],
    impacts: t.impacts ?? [],
    mappingPct: t.mappingPct ?? null,
    status: t.status ?? null,
    objective: t.objective ?? null,
    next: t.next ?? null,
  }
}
function rowValues(boardId: string, t: WorkTask): Array<unknown> {
  return [
    boardId, t.id, t.projectId ?? null, t.featureContractId ?? null, t.group ?? null,
    t.phase ?? null, t.scope ?? null, t.title ?? null, t.updated ?? null,
    JSON.stringify(summaryOf(t)), JSON.stringify(t),
  ]
}
const COLS = '(board_id, id, project_id, feature_contract_id, grp, phase, scope, title, updated, summary, data)'

/** Reconstruct a light WorkTask (list shape) from a summary row. */
function lightFromRow(r: Record<string, unknown>): WorkTask {
  const s = (r.summary ?? {}) as Record<string, unknown>
  return {
    id: r.id as string,
    title: (r.title as string) ?? '',
    projectId: (r.project_id as string) ?? null,
    featureContractId: (r.feature_contract_id as string) ?? null,
    group: (r.grp as string) ?? null,
    phase: (r.phase as string) ?? null,
    scope: (r.scope as string) ?? undefined,
    updated: (r.updated as string) ?? null,
    checkpoints: (s.checkpoints as WorkTask['checkpoints']) ?? [],
    dependencies: (s.dependencies as Array<string>) ?? [],
    impacts: (s.impacts as Array<string>) ?? [],
    mappingPct: (s.mappingPct as number) ?? null,
    status: (s.status as string) ?? null,
    objective: (s.objective as string) ?? null,
    next: (s.next as string) ?? null,
  }
}

// ---- lazy backfill from the old board_docs 'tasks' blob (non-destructive) ----
const migrated = new Set<string>()
async function insertIgnore(boardId: string, tasks: Array<WorkTask>): Promise<void> {
  for (let i = 0; i < tasks.length; i += 200) {
    const chunk = tasks.slice(i, i + 200)
    await db().query(`INSERT IGNORE INTO tasks ${COLS} VALUES ?`, [chunk.map((t) => rowValues(boardId, t))])
  }
}
export async function ensureBackfilled(boardId: string): Promise<void> {
  if (migrated.has(boardId)) return
  await ensureTaskSchema()
  const [rows] = await db().query('SELECT COUNT(*) c FROM tasks WHERE board_id=?', [boardId])
  if ((rows as Array<{ c: number }>)[0].c > 0) { migrated.add(boardId); return }
  const doc = await readDoc<{ tasks?: Array<WorkTask> }>(boardId, 'tasks', { tasks: [] })
  if (doc.tasks?.length) await insertIgnore(boardId, doc.tasks)
  migrated.add(boardId)
}

// ---- reads ----
export async function taskSummaries(boardId: string, projectId?: string): Promise<Array<WorkTask>> {
  await ensureBackfilled(boardId)
  const sql = `SELECT id, project_id, feature_contract_id, grp, phase, scope, title, updated, summary FROM tasks WHERE board_id=?${projectId ? ' AND project_id=?' : ''}`
  const [rows] = await db().query(sql, projectId ? [boardId, projectId] : [boardId])
  return (rows as Array<Record<string, unknown>>).map(lightFromRow)
}
export async function taskFull(boardId: string, id: string): Promise<WorkTask | null> {
  await ensureBackfilled(boardId)
  const [rows] = await db().query('SELECT data FROM tasks WHERE board_id=? AND id=?', [boardId, id])
  const r = (rows as Array<{ data: unknown }>)[0]
  return r ? (r.data as WorkTask) : null
}
export async function taskCount(boardId: string): Promise<number> {
  await ensureBackfilled(boardId)
  const [rows] = await db().query('SELECT COUNT(*) c FROM tasks WHERE board_id=?', [boardId])
  return (rows as Array<{ c: number }>)[0].c
}

// ---- writes ----
export async function upsertTaskRow(boardId: string, task: WorkTask): Promise<boolean> {
  await ensureBackfilled(boardId)
  const [ex] = await db().query('SELECT 1 FROM tasks WHERE board_id=? AND id=? LIMIT 1', [boardId, task.id])
  const created = (ex as Array<unknown>).length === 0
  await db().query(`REPLACE INTO tasks ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?)`, rowValues(boardId, task))
  return created
}
export async function deleteTaskRow(boardId: string, id: string): Promise<number> {
  await ensureBackfilled(boardId)
  const [r] = await db().query('DELETE FROM tasks WHERE board_id=? AND id=?', [boardId, id])
  return (r as { affectedRows: number }).affectedRows
}
export async function toggleCheckpointRow(boardId: string, taskId: string, checkpointId: string): Promise<WorkTask> {
  const t = await taskFull(boardId, taskId)
  if (!t) throw new Error(`task not found: ${taskId}`)
  const cp = (t.checkpoints ?? []).find((c) => c.id === checkpointId)
  if (!cp) throw new Error(`checkpoint not found: ${checkpointId}`)
  cp.done = !cp.done
  await db().query(`REPLACE INTO tasks ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?)`, rowValues(boardId, t))
  return t
}
/** Replace ALL tasks for a board in one transaction (bulk snapshot import). */
export async function replaceTaskRows(boardId: string, tasks: Array<WorkTask>): Promise<number> {
  await ensureTaskSchema()
  migrated.add(boardId)
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM tasks WHERE board_id=?', [boardId])
    for (let i = 0; i < tasks.length; i += 200) {
      const chunk = tasks.slice(i, i + 200)
      await conn.query(`INSERT INTO tasks ${COLS} VALUES ?`, [chunk.map((t) => rowValues(boardId, t))])
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
  return tasks.length
}
