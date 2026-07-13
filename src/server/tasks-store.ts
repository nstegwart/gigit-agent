// Tasks stored as REAL rows (not one giant JSON blob). Each task is a row in `tasks`
// with indexed columns (board_id, project_id, feature_contract_id, phase…), a small
// `summary` JSON for list views, and the heavy 20-point mapping in `data` JSON — read
// only on the detail page. This keeps list/detail reads tiny instead of pulling the
// whole ~17MB collection every time. Server-only.
// V3 classification/revision/hash metadata is migration-backed (001 expand) and
// exposed via pure helpers + in-memory store for unit tests — no ad-hoc DDL here.
import { createHash } from 'node:crypto'
import { db, readDoc } from './db'
import type { Json, WorkTask } from '#/lib/types'
import type {
  ClassificationReceipt,
  PinnedRevisionTuple,
  TaskClass,
  TaskDisposition,
} from '#/lib/control-plane-types'
import { TASK_CLASSES, TASK_DISPOSITIONS } from '#/lib/control-plane-types'
import { evaluateClassification } from '#/server/classification'
import { subjectHashOf } from '#/server/revisions'

let schemaReady: Promise<void> | null = null
/** Run an idempotent ALTER (MySQL lacks ADD COLUMN/KEY IF NOT EXISTS). */
async function addCol(sql: string): Promise<void> {
  try { await db().query(sql) } catch (e) {
    const errno = (e as { errno?: number }).errno
    if (errno !== 1060 && errno !== 1061) throw e // 1060 = duplicate column, 1061 = duplicate key
  }
}
async function buildSchema(): Promise<void> {
  await db().query(`CREATE TABLE IF NOT EXISTS tasks (
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
  // lifecycle + optimistic-lock columns (added idempotently for existing tables)
  await addCol('ALTER TABLE tasks ADD COLUMN lifecycle_stage VARCHAR(64) NULL')
  await addCol('ALTER TABLE tasks ADD COLUMN implementer_run VARCHAR(160) NULL')
  await addCol('ALTER TABLE tasks ADD COLUMN rev INT NOT NULL DEFAULT 0')
  await addCol('ALTER TABLE tasks ADD COLUMN lifecycle JSON NULL')
  await addCol('ALTER TABLE tasks ADD COLUMN blocked_reason VARCHAR(400) NULL')
  await addCol('ALTER TABLE tasks ADD COLUMN last_receipt_at VARCHAR(40) NULL')
  await addCol('ALTER TABLE tasks ADD KEY idx_stage (board_id, lifecycle_stage)')
  await db().query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    board_id VARCHAR(64) NOT NULL,
    ts VARCHAR(40) NOT NULL,
    actor VARCHAR(160) NULL,
    action VARCHAR(64) NOT NULL,
    task_id VARCHAR(160) NULL,
    from_stage VARCHAR(64) NULL,
    to_stage VARCHAR(64) NULL,
    detail JSON NULL,
    KEY idx_board (board_id, id),
    KEY idx_task (board_id, task_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}
export function ensureTaskSchema(): Promise<void> {
  if (!schemaReady) {
    schemaReady = buildSchema().catch((e) => { schemaReady = null; throw e })
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
    lifecycleStage: (r.lifecycle_stage as string) ?? null,
    blockedReason: (r.blocked_reason as string) ?? null,
    lastReceiptAt: (r.last_receipt_at as string) ?? null,
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
  const sql = `SELECT id, project_id, feature_contract_id, grp, phase, scope, title, updated, lifecycle_stage, blocked_reason, last_receipt_at, summary FROM tasks WHERE board_id=?${projectId ? ' AND project_id=?' : ''}`
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
const CONTENT_UPDATE = `project_id=VALUES(project_id), feature_contract_id=VALUES(feature_contract_id), grp=VALUES(grp), phase=VALUES(phase), scope=VALUES(scope), title=VALUES(title), updated=VALUES(updated), summary=VALUES(summary), data=VALUES(data), rev=rev+1`
/** Upsert content only — lifecycle_stage/lifecycle/implementer_run are preserved
 *  (managed by advanceTask). expectedRev guards against a concurrent lost update. */
export async function upsertTaskRow(boardId: string, task: WorkTask, opts: { expectedRev?: number } = {}): Promise<{ created: boolean; rev: number }> {
  await ensureBackfilled(boardId)
  const [ex] = await db().query('SELECT rev FROM tasks WHERE board_id=? AND id=? LIMIT 1', [boardId, task.id])
  const row = (ex as Array<{ rev: number }>)[0]
  const created = !row
  if (!created && opts.expectedRev !== undefined && row.rev !== opts.expectedRev) {
    throw new Error(`rev mismatch on ${task.id}: expected ${opts.expectedRev}, current ${row.rev}. Re-read get_task and retry.`)
  }
  await db().query(`INSERT INTO tasks ${COLS} VALUES (?,?,?,?,?,?,?,?,?,?,?) ON DUPLICATE KEY UPDATE ${CONTENT_UPDATE}`, rowValues(boardId, task))
  const [after] = await db().query('SELECT rev FROM tasks WHERE board_id=? AND id=?', [boardId, task.id])
  return { created, rev: (after as Array<{ rev: number }>)[0]?.rev ?? 0 }
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
  await db().query('UPDATE tasks SET summary=?, data=?, rev=rev+1 WHERE board_id=? AND id=?', [
    JSON.stringify(summaryOf(t)), JSON.stringify(t), boardId, taskId,
  ])
  return t
}
/** Replace ALL tasks for a board in one transaction (bulk snapshot import).
 *  Lifecycle state is PRESERVED for ids that survive the re-import. */
export async function replaceTaskRows(boardId: string, tasks: Array<WorkTask>): Promise<number> {
  await ensureTaskSchema()
  migrated.add(boardId)
  const [prevRows] = await db().query('SELECT id, lifecycle_stage, rev, implementer_run, lifecycle FROM tasks WHERE board_id=?', [boardId])
  const keep = new Map((prevRows as Array<Record<string, unknown>>).map((r) => [r.id as string, r]))
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
  for (const t of tasks) {
    const k = keep.get(t.id)
    if (k && (k.lifecycle_stage || k.lifecycle)) {
      await db().query('UPDATE tasks SET lifecycle_stage=?, rev=?, implementer_run=?, lifecycle=? WHERE board_id=? AND id=?', [
        k.lifecycle_stage ?? null, k.rev ?? 0, k.implementer_run ?? null, k.lifecycle ? JSON.stringify(k.lifecycle) : null, boardId, t.id,
      ])
    }
  }
  return tasks.length
}

// ---- lifecycle row state (managed by lifecycle-store) ----
export interface TaskLifecycleRow { stage: string | null; rev: number; implementerRun: string | null; lifecycle: Json | null }
export async function taskLifecycle(boardId: string, id: string): Promise<TaskLifecycleRow | null> {
  await ensureBackfilled(boardId)
  const [rows] = await db().query('SELECT lifecycle_stage, rev, implementer_run, lifecycle FROM tasks WHERE board_id=? AND id=?', [boardId, id])
  const r = (rows as Array<Record<string, unknown>>)[0]
  if (!r) return null
  return { stage: (r.lifecycle_stage as string) ?? null, rev: (r.rev as number) ?? 0, implementerRun: (r.implementer_run as string) ?? null, lifecycle: (r.lifecycle as Json) ?? null }
}
export async function setTaskLifecycle(boardId: string, id: string, next: { stage: string; implementerRun?: string | null; history: unknown; blockedReason?: string | null; lastReceiptAt?: string | null; expectedRev?: number }): Promise<number> {
  await ensureBackfilled(boardId)
  const setCols = 'lifecycle_stage=?, implementer_run=COALESCE(?, implementer_run), lifecycle=?, blocked_reason=?, last_receipt_at=?, rev=rev+1'
  const vals = [next.stage, next.implementerRun ?? null, JSON.stringify(next.history), next.blockedReason ?? null, next.lastReceiptAt ?? null]
  if (next.expectedRev !== undefined) {
    const [r] = await db().query(
      `UPDATE tasks SET ${setCols} WHERE board_id=? AND id=? AND rev=?`,
      [...vals, boardId, id, next.expectedRev],
    )
    if ((r as { affectedRows: number }).affectedRows === 0) throw new Error(`rev mismatch on ${id}: expected ${next.expectedRev}. Re-read and retry.`)
  } else {
    await db().query(
      `UPDATE tasks SET ${setCols} WHERE board_id=? AND id=?`,
      [...vals, boardId, id],
    )
  }
  const [after] = await db().query('SELECT rev FROM tasks WHERE board_id=? AND id=?', [boardId, id])
  return (after as Array<{ rev: number }>)[0]?.rev ?? 0
}
/** Bulk-initialize task stages in ONE atomic UPDATE (backfill/migration). */
export async function initLifecycle(boardId: string, stage: string, onlyUninitialized = true): Promise<number> {
  await ensureBackfilled(boardId)
  const where = onlyUninitialized ? ' AND lifecycle_stage IS NULL' : ''
  const [r] = await db().query(`UPDATE tasks SET lifecycle_stage=?, rev=rev+1 WHERE board_id=?${where}`, [stage, boardId])
  return (r as { affectedRows: number }).affectedRows
}
/** Per-task (stage, project, feature, scope, mapping progress, blocked) — for rollups. */
export async function taskStageRows(boardId: string): Promise<Array<{ id: string; stage: string | null; project: string | null; feature: string | null; scope: string | null; ckDone: number; ckTotal: number; blocked: boolean }>> {
  await ensureBackfilled(boardId)
  const [rows] = await db().query('SELECT id, lifecycle_stage, project_id, feature_contract_id, scope, blocked_reason, summary FROM tasks WHERE board_id=?', [boardId])
  return (rows as Array<Record<string, unknown>>).map((r) => {
    const cps = (((r.summary ?? {}) as { checkpoints?: Array<{ done?: boolean }> }).checkpoints) ?? []
    return {
      id: r.id as string, stage: (r.lifecycle_stage as string) ?? null,
      project: (r.project_id as string) ?? null, feature: (r.feature_contract_id as string) ?? null, scope: (r.scope as string) ?? null,
      ckDone: cps.filter((c) => c.done).length, ckTotal: cps.length, blocked: !!r.blocked_reason,
    }
  })
}

// ---- audit log ----
export async function writeAudit(boardId: string, e: { ts: string; actor?: string | null; action: string; taskId?: string | null; fromStage?: string | null; toStage?: string | null; detail?: unknown }): Promise<void> {
  await ensureTaskSchema()
  await db().query('INSERT INTO audit_log (board_id, ts, actor, action, task_id, from_stage, to_stage, detail) VALUES (?,?,?,?,?,?,?,?)', [
    boardId, e.ts, e.actor ?? null, e.action, e.taskId ?? null, e.fromStage ?? null, e.toStage ?? null, e.detail ? JSON.stringify(e.detail) : null,
  ])
}
export async function readAudit(boardId: string, opts: { taskId?: string; limit?: number } = {}): Promise<Array<Record<string, unknown>>> {
  await ensureTaskSchema()
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const sql = `SELECT ts, actor, action, task_id, from_stage, to_stage, detail FROM audit_log WHERE board_id=?${opts.taskId ? ' AND task_id=?' : ''} ORDER BY id DESC LIMIT ${limit}`
  const [rows] = await db().query(sql, opts.taskId ? [boardId, opts.taskId] : [boardId])
  return rows as Array<Record<string, unknown>>
}

// =============================================================================
// V3 task metadata (migration-backed columns; pure + injectable store)
// Never guess PRODUCT from legacy fase/progress/pct. Late/fenced/stale actors rejected.
// =============================================================================

export type TaskV3ErrorCode =
  | 'STALE_REVISION'
  | 'STALE_HASH'
  | 'FENCED'
  | 'LEASE_EXPIRED'
  | 'RUN_NOT_REGISTERED'
  | 'INVALID_CLASSIFICATION'
  | 'TASK_NOT_FOUND'
  | 'AUTHORIZATION_REQUIRED'

export class TaskV3Error extends Error {
  readonly code: TaskV3ErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(code: TaskV3ErrorCode, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'TaskV3Error'
    this.code = code
    this.details = details
  }
}

/** V3 columns from migrations/001 (not applied here — pure model). */
export interface TaskV3Record {
  boardId: string
  taskId: string
  title: string
  projectId: string | null
  featureContractId: string | null
  /** Legacy fields — non-authoritative for classification/readiness. */
  phase: string | null
  scope: string | null
  mappingPct: number | null
  status: string | null
  /** Migration-backed classification — default UNCLASSIFIED. */
  taskClass: TaskClass
  disposition: TaskDisposition
  classificationReceiptId: string | null
  classificationReceiptHash: string | null
  classificationReceipt: ClassificationReceipt | null
  boardRev: number
  lifecycleRev: number
  entityRev: number
  subjectHash: string
  taskHash: string
  canonicalSnapshotId: string | null
  canonicalHash: string | null
  evidenceMeta: Record<string, unknown> | null
  lifecycleStage: string | null
  createdAt: string
  updatedAt: string
  /** Actor fence / lease gates for mutations. */
  fenced: boolean
}

export interface TaskV3Actor {
  runId: string
  registered: boolean
  fenced: boolean
  expiresAt: string
}

export interface TaskV3UpsertInput {
  boardId: string
  task: {
    id: string
    title?: string | null
    projectId?: string | null
    featureContractId?: string | null
    phase?: string | null
    scope?: string | null
    mappingPct?: number | null
    status?: string | null
    objective?: string | null
    next?: string | null
    checkpoints?: WorkTask['checkpoints']
    dependencies?: WorkTask['dependencies']
    impacts?: WorkTask['impacts']
  }
  entityExpectedRev?: number
  expectedBoardRev: number
  expectedLifecycleRev: number
  expectedSubjectHash?: string
  /** Optional classification — never inferred from phase/scope/mappingPct. */
  classification?: {
    taskClass: TaskClass
    disposition: TaskDisposition
    receipt: ClassificationReceipt | null
  }
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  actor: TaskV3Actor
  now?: string
}

export interface TaskV3UpsertResult {
  created: boolean
  record: TaskV3Record
  pin: PinnedRevisionTuple
}

export interface TaskV3BoardState {
  boardId: string
  boardRev: number
  lifecycleRev: number
  canonicalSnapshotId: string | null
  canonicalHash: string | null
}

/** Content hash for task definition (excludes lifecycle evidence). */
export function computeTaskHash(task: {
  id: string
  title?: string | null
  projectId?: string | null
  featureContractId?: string | null
  objective?: string | null
  checkpoints?: unknown
  dependencies?: unknown
}): string {
  return subjectHashOf({
    id: task.id,
    title: task.title ?? '',
    projectId: task.projectId ?? null,
    featureContractId: task.featureContractId ?? null,
    objective: task.objective ?? null,
    checkpoints: task.checkpoints ?? [],
    dependencies: task.dependencies ?? [],
  })
}

/**
 * Map legacy WorkTask → V3 record defaults.
 * NEVER promotes PRODUCT from fase/progress/pct/scope.
 */
export function legacyTaskToV3Defaults(
  boardId: string,
  task: WorkTask,
  board: TaskV3BoardState,
): TaskV3Record {
  const taskHash = computeTaskHash(task)
  const now = new Date(0).toISOString()
  return {
    boardId,
    taskId: task.id,
    title: task.title ?? '',
    projectId: task.projectId ?? null,
    featureContractId: task.featureContractId ?? null,
    phase: task.phase ?? null,
    scope: task.scope ?? null,
    mappingPct: task.mappingPct ?? null,
    status: task.status ?? null,
    taskClass: 'UNCLASSIFIED',
    disposition: 'UNCLASSIFIED',
    classificationReceiptId: null,
    classificationReceiptHash: null,
    classificationReceipt: null,
    boardRev: board.boardRev,
    lifecycleRev: board.lifecycleRev,
    entityRev: 0,
    subjectHash: taskHash,
    taskHash,
    canonicalSnapshotId: board.canonicalSnapshotId,
    canonicalHash: board.canonicalHash,
    evidenceMeta: null,
    lifecycleStage: task.lifecycleStage ?? null,
    createdAt: now,
    updatedAt: now,
    fenced: false,
  }
}

function assertActorMayMutate(actor: TaskV3Actor, now: string): void {
  if (!actor.runId) {
    throw new TaskV3Error('AUTHORIZATION_REQUIRED', 'actor runId required')
  }
  if (!actor.registered) {
    throw new TaskV3Error('RUN_NOT_REGISTERED', `run not registered: ${actor.runId}`, {
      runId: actor.runId,
    })
  }
  if (actor.fenced) {
    throw new TaskV3Error('FENCED', `run is fenced: ${actor.runId}`, { runId: actor.runId })
  }
  if (actor.expiresAt <= now) {
    throw new TaskV3Error('LEASE_EXPIRED', `run lease expired: ${actor.runId}`, {
      runId: actor.runId,
      expiresAt: actor.expiresAt,
    })
  }
}

function assertValidClassification(
  c: NonNullable<TaskV3UpsertInput['classification']>,
  pin: PinnedRevisionTuple,
  taskId: string,
  now: string,
): void {
  if (!(TASK_CLASSES as ReadonlyArray<string>).includes(c.taskClass)) {
    throw new TaskV3Error('INVALID_CLASSIFICATION', `invalid taskClass ${String(c.taskClass)}`)
  }
  if (!(TASK_DISPOSITIONS as ReadonlyArray<string>).includes(c.disposition)) {
    throw new TaskV3Error('INVALID_CLASSIFICATION', `invalid disposition ${String(c.disposition)}`)
  }
  // evaluate against pin when receipt present; still allow UNCLASSIFIED without receipt
  if (c.taskClass !== 'UNCLASSIFIED' || c.disposition !== 'UNCLASSIFIED') {
    const evaled = evaluateClassification(
      {
        taskId,
        taskClass: c.taskClass,
        disposition: c.disposition,
        receipt: c.receipt,
      },
      pin,
      { now },
    )
    if (!evaled.valid && c.taskClass !== 'UNCLASSIFIED') {
      // Allow storing UNCLASSIFIED repair rows; reject claiming PRODUCT/CONTROL_PLANE without valid receipt.
      if (c.taskClass === 'PRODUCT' || c.taskClass === 'CONTROL_PLANE') {
        throw new TaskV3Error(
          'INVALID_CLASSIFICATION',
          `classification invalid: ${evaled.reasons.join(',')}`,
          { reasons: evaled.reasons },
        )
      }
    }
  }
}

export interface TaskV3Store {
  getBoard(boardId: string): Promise<TaskV3BoardState | null>
  getTask(boardId: string, taskId: string): Promise<TaskV3Record | null>
  listTasks(boardId: string): Promise<Array<TaskV3Record>>
  saveTask(record: TaskV3Record, nextBoardRev: number): Promise<TaskV3Record>
}

/**
 * Upsert task with V3 optimistic concurrency + classification.
 * Does not apply migrations / DDL. Injected store for unit tests.
 */
export async function upsertTaskV3(
  store: TaskV3Store,
  inp: TaskV3UpsertInput,
): Promise<TaskV3UpsertResult> {
  const now = inp.now ?? new Date().toISOString()
  assertActorMayMutate(inp.actor, now)

  const board = await store.getBoard(inp.boardId)
  if (!board) {
    throw new TaskV3Error('TASK_NOT_FOUND', `board not found: ${inp.boardId}`)
  }
  if (board.boardRev !== inp.expectedBoardRev) {
    throw new TaskV3Error('STALE_REVISION', `board rev mismatch: expected ${inp.expectedBoardRev}, current ${board.boardRev}`, {
      expectedBoardRev: inp.expectedBoardRev,
      current: board.boardRev,
    })
  }
  if (board.lifecycleRev !== inp.expectedLifecycleRev) {
    throw new TaskV3Error('STALE_REVISION', `lifecycle rev mismatch: expected ${inp.expectedLifecycleRev}, current ${board.lifecycleRev}`, {
      expectedLifecycleRev: inp.expectedLifecycleRev,
      current: board.lifecycleRev,
    })
  }

  const existing = await store.getTask(inp.boardId, inp.task.id)
  const created = !existing

  if (!created) {
    if (existing.fenced) {
      throw new TaskV3Error('FENCED', `task is fenced: ${inp.task.id}`)
    }
    if (inp.entityExpectedRev !== undefined && existing.entityRev !== inp.entityExpectedRev) {
      throw new TaskV3Error(
        'STALE_REVISION',
        `entity rev mismatch on ${inp.task.id}: expected ${inp.entityExpectedRev}, current ${existing.entityRev}`,
        { entityExpectedRev: inp.entityExpectedRev, current: existing.entityRev },
      )
    }
    if (
      inp.expectedSubjectHash !== undefined &&
      existing.subjectHash !== inp.expectedSubjectHash
    ) {
      throw new TaskV3Error('STALE_HASH', 'subject hash mismatch', {
        expected: inp.expectedSubjectHash,
        current: existing.subjectHash,
      })
    }
  }

  const taskHash = computeTaskHash(inp.task)
  const pin: PinnedRevisionTuple = {
    canonicalSnapshotId:
      inp.canonicalSnapshotId ?? board.canonicalSnapshotId ?? existing?.canonicalSnapshotId ?? '',
    canonicalHash: inp.canonicalHash ?? board.canonicalHash ?? existing?.canonicalHash ?? '',
    taskHash,
    boardRev: board.boardRev + 1,
    lifecycleRev: board.lifecycleRev,
  }

  let taskClass: TaskClass = existing?.taskClass ?? 'UNCLASSIFIED'
  let disposition: TaskDisposition = existing?.disposition ?? 'UNCLASSIFIED'
  let classificationReceipt: ClassificationReceipt | null =
    existing?.classificationReceipt ?? null
  let classificationReceiptId: string | null = existing?.classificationReceiptId ?? null
  let classificationReceiptHash: string | null = existing?.classificationReceiptHash ?? null

  if (inp.classification) {
    assertValidClassification(inp.classification, {
      ...pin,
      // validate against current board pin before bump for receipt currency
      boardRev: board.boardRev,
      lifecycleRev: board.lifecycleRev,
      taskHash: inp.classification.receipt?.taskHash ?? taskHash,
      canonicalHash: inp.classification.receipt?.canonicalHash ?? pin.canonicalHash,
      canonicalSnapshotId:
        inp.classification.receipt?.canonicalSnapshotId ?? pin.canonicalSnapshotId,
    }, inp.task.id, now)
    taskClass = inp.classification.taskClass
    disposition = inp.classification.disposition
    classificationReceipt = inp.classification.receipt
    classificationReceiptId = inp.classification.receipt?.receiptId ?? null
    classificationReceiptHash = inp.classification.receipt?.receiptHash ?? null
  }

  // Never trust legacy phase/scope/mappingPct for class
  void existing?.phase
  void existing?.mappingPct

  const subjectHash = subjectHashOf({
    taskId: inp.task.id,
    title: inp.task.title,
    taskHash,
    taskClass,
    disposition,
    classificationReceiptHash,
  })

  const record: TaskV3Record = {
    boardId: inp.boardId,
    taskId: inp.task.id,
    title: inp.task.title ?? '',
    projectId: inp.task.projectId ?? null,
    featureContractId: inp.task.featureContractId ?? null,
    phase: inp.task.phase ?? null,
    scope: inp.task.scope ?? null,
    mappingPct: inp.task.mappingPct ?? null,
    status: inp.task.status ?? null,
    taskClass,
    disposition,
    classificationReceiptId,
    classificationReceiptHash,
    classificationReceipt,
    boardRev: board.boardRev + 1,
    lifecycleRev: board.lifecycleRev,
    entityRev: created ? 1 : (existing?.entityRev ?? 0) + 1,
    subjectHash,
    taskHash,
    canonicalSnapshotId: pin.canonicalSnapshotId || null,
    canonicalHash: pin.canonicalHash || null,
    evidenceMeta: existing?.evidenceMeta ?? null,
    lifecycleStage: existing?.lifecycleStage ?? null,
    createdAt: existing?.createdAt ?? now,
    updatedAt: now,
    fenced: false,
  }

  const saved = await store.saveTask(record, board.boardRev + 1)
  return {
    created,
    record: saved,
    pin: {
      canonicalSnapshotId: saved.canonicalSnapshotId ?? '',
      canonicalHash: saved.canonicalHash ?? '',
      taskHash: saved.taskHash,
      boardRev: saved.boardRev,
      lifecycleRev: saved.lifecycleRev,
    },
  }
}

/** Convert V3 record → list-compatible WorkTask (legacy callers). */
export function taskV3ToWorkTask(r: TaskV3Record): WorkTask {
  return {
    id: r.taskId,
    title: r.title,
    projectId: r.projectId,
    featureContractId: r.featureContractId,
    phase: r.phase,
    scope: r.scope ?? undefined,
    mappingPct: r.mappingPct,
    status: r.status,
    lifecycleStage: r.lifecycleStage,
    updated: r.updatedAt,
    checkpoints: [],
    dependencies: [],
    impacts: [],
  }
}

/** In-memory TaskV3 store for unit tests — no real DB. */
export function createMemoryTaskV3Store(seed: {
  board: TaskV3BoardState
  tasks?: Array<TaskV3Record>
}): TaskV3Store & {
  board: () => TaskV3BoardState
  all: () => Array<TaskV3Record>
} {
  let board = { ...seed.board }
  const tasks = new Map((seed.tasks ?? []).map((t) => [t.taskId, { ...t }]))

  return {
    board: () => ({ ...board }),
    all: () => [...tasks.values()].map((t) => ({ ...t })),
    async getBoard(boardId) {
      return board.boardId === boardId ? { ...board } : null
    },
    async getTask(boardId, taskId) {
      if (board.boardId !== boardId) return null
      const t = tasks.get(taskId)
      return t ? { ...t } : null
    },
    async listTasks(boardId) {
      if (board.boardId !== boardId) return []
      return [...tasks.values()].map((t) => ({ ...t })).sort((a, b) =>
        a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0,
      )
    },
    async saveTask(record, nextBoardRev) {
      board = { ...board, boardRev: nextBoardRev }
      const saved = { ...record, boardRev: nextBoardRev }
      tasks.set(saved.taskId, saved)
      // Sync boardRev on siblings for pin consistency
      for (const [id, t] of tasks) {
        if (id === saved.taskId) continue
        tasks.set(id, { ...t, boardRev: nextBoardRev })
      }
      return { ...saved }
    },
  }
}

/** Stable content fingerprint helper (debug/tests). */
export function taskContentFingerprint(t: WorkTask): string {
  return createHash('sha256').update(JSON.stringify({
    id: t.id,
    title: t.title,
    projectId: t.projectId ?? null,
    featureContractId: t.featureContractId ?? null,
  })).digest('hex')
}
