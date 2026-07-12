// Server-only data store — MySQL-backed (cairn_taskmanager). Each board's data lives as
// JSON docs in board_docs (kind = plan/runs/design/collab/tasks/accounts); conventions in
// globals; the board index in boards. Same JSON shapes as before, so buildModel() is
// unchanged. All functions are async. Imported ONLY by server functions + the MCP route.
import { createHash } from 'node:crypto'
import { db, readDoc, readGlobal, writeDoc, writeDocsTx } from './db'
import {
  deleteTaskRow,
  replaceTaskRows,
  taskCount,
  taskFull,
  taskSummaries,
  toggleCheckpointRow,
  upsertTaskRow,
} from './tasks-store'

import type {
  ActivityEvent,
  Actor,
  BoardMeta,
  CollabOverlay,
  Comment,
  Conventions,
  Decision,
  DecisionOption,
  DesignOverlay,
  FeatureLink,
  GuideData,
  GuideSection,
  OpsData,
  ProdData,
  ProdGate,
  RawBoard,
  RawFeature,
  RawProject,
  Run,
  TasksFile,
  WorkTask,
} from '#/lib/types'

type PlanDoc = Omit<RawBoard, 'runs' | 'conventions' | 'design' | 'collab'>
interface RunsDoc {
  runs: Array<Run>
}

const DEFAULT_PLAN: PlanDoc = {
  fase_label: {
    backlog: 'Backlog', spec: 'Spec', design: 'Desain', 'review-owner': 'Review Owner',
    build: 'Build', qa: 'QA', uat: 'UAT', done: 'Done',
  },
  fase_persen: { backlog: 0, spec: 15, design: 35, 'review-owner': 45, build: 65, qa: 80, uat: 90, done: 100 },
  projects: [],
  features: [],
  decisions: [],
  log: [],
  queue: { now: [], next: [] },
  docs: [],
}
const DEFAULT_VIEWS = ['board', 'agents', 'projects', 'features', 'map', 'design', 'decisions', 'log']

const readPlan = (b: string) => readDoc<PlanDoc>(b, 'plan', DEFAULT_PLAN)
const readRunsDoc = (b: string) => readDoc<RunsDoc>(b, 'runs', { runs: [] })
const readDesign = (b: string) => readDoc<DesignOverlay>(b, 'design', { projects: {}, features: {} })
const readCollab = (b: string) => readDoc<CollabOverlay>(b, 'collab', { comments: {}, activity: [] })

export function readConventions(): Promise<Conventions> {
  return readGlobal<Conventions>('conventions', {})
}

// ---- board index (boards table) ----
export async function listBoards(): Promise<Array<BoardMeta>> {
  const [rows] = await db().query('SELECT id, name, description, views, created_at FROM boards')
  return (rows as Array<{ id: string; name: string; description: string; views: unknown; created_at: string }>).map(
    (r) => ({ id: r.id, name: r.name, description: r.description ?? '', views: (r.views as Array<string>) ?? undefined, createdAt: r.created_at ?? undefined }),
  )
}
export async function boardExists(boardId: string): Promise<boolean> {
  const [rows] = await db().query('SELECT 1 FROM boards WHERE id=? LIMIT 1', [boardId])
  return (rows as Array<unknown>).length > 0
}
export async function defaultBoardId(): Promise<string> {
  const [rows] = await db().query('SELECT id FROM boards ORDER BY created_at IS NULL, created_at, id LIMIT 1')
  return (rows as Array<{ id: string }>)[0]?.id ?? 'demo'
}

export async function createBoard(
  id: string,
  name: string,
  description = '',
  views?: Array<string>,
): Promise<Array<BoardMeta>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid board id: ${id} (use kebab-case)`)
  if (await boardExists(id)) throw new Error(`board already exists: ${id}`)
  await db().query('INSERT INTO boards (id, name, description, views, created_at) VALUES (?,?,?,?,?)', [
    id, name, description, JSON.stringify(views ?? DEFAULT_VIEWS), todayISO(),
  ])
  await writeDoc(id, 'plan', { ...DEFAULT_PLAN, updated: todayISO() })
  await writeDoc(id, 'runs', { runs: [] })
  await writeDoc(id, 'design', { projects: {}, features: {} })
  await writeDoc(id, 'collab', { comments: {}, activity: [] })
  return listBoards()
}

/** Full raw board = plan + runs + overlays, merged. */
export async function readBoard(boardId: string): Promise<RawBoard> {
  const [plan, runsDoc, conventions, design, collab] = await Promise.all([
    readPlan(boardId), readRunsDoc(boardId), readConventions(), readDesign(boardId), readCollab(boardId),
  ])
  return { ...plan, runs: runsDoc.runs ?? [], conventions, design, collab }
}

// ---- feature mutations (plan doc) ----
export async function toggleTask(boardId: string, featureId: string, index: number, done?: boolean): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId) as RawFeature | undefined
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  const task = feat.checklist?.[index]
  if (!task) throw new Error(`task ${index} not found on ${featureId}`)
  task.done = done ?? !task.done
  feat.updated = todayISO()
  await writeDoc(boardId, 'plan', plan)
  return readBoard(boardId)
}
export async function setFeaturePhase(boardId: string, featureId: string, fase: string): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.fase = fase
  feat.updated = todayISO()
  await writeDoc(boardId, 'plan', plan)
  return readBoard(boardId)
}

// ---- runs (runs doc) ----
export async function upsertRun(boardId: string, run: Partial<Run> & { id: string }): Promise<RawBoard> {
  const doc = await readRunsDoc(boardId)
  const runs = doc.runs ?? []
  const i = runs.findIndex((r) => r.id === run.id)
  const now = nowISO()
  if (i >= 0) runs[i] = { ...runs[i], ...run, updated: run.updated ?? now }
  else
    runs.push({
      role: 'Worker', status: 'running', started: now, updated: now, model: '', effort: 'medium',
      task: '', agent: run.id, agentType: 'claude', ...run,
    } as Run)
  await writeDoc(boardId, 'runs', { runs })
  return readBoard(boardId)
}
export async function setRunStatus(boardId: string, id: string, status: Run['status']): Promise<RawBoard> {
  const doc = await readRunsDoc(boardId)
  const run = (doc.runs ?? []).find((r) => r.id === id)
  if (!run) throw new Error(`run not found: ${id}`)
  run.status = status
  run.updated = nowISO()
  await writeDoc(boardId, 'runs', doc)
  return readBoard(boardId)
}

// ---- design overlay ----
export async function addDesignLink(boardId: string, scope: 'project' | 'feature', id: string, link: FeatureLink): Promise<RawBoard> {
  const d = await readDesign(boardId)
  const bucket = scope === 'project' ? d.projects : d.features
  ;(bucket[id] ??= []).push({ label: link.label, url: link.url })
  await writeDoc(boardId, 'design', d)
  return readBoard(boardId)
}

// ---- collab ----
export async function appendActivity(boardId: string, ev: Omit<ActivityEvent, 'ts'> & { ts?: string }): Promise<void> {
  const c = await readCollab(boardId)
  c.activity.unshift({ ts: ev.ts ?? nowISO(), actor: ev.actor, actorType: ev.actorType, kind: ev.kind, text: ev.text, featureId: ev.featureId, projectId: ev.projectId })
  await writeDoc(boardId, 'collab', c)
}
export async function addComment(boardId: string, featureId: string, author: string, authorType: Actor, text: string): Promise<RawBoard> {
  const c = await readCollab(boardId)
  const comment: Comment = { id: `c-${Date.now()}`, featureId, author, authorType, text, ts: nowISO() }
  ;(c.comments[featureId] ??= []).push(comment)
  c.activity.unshift({ ts: comment.ts, actor: author, actorType: authorType, kind: 'comment', text, featureId })
  await writeDoc(boardId, 'collab', c)
  return readBoard(boardId)
}

// ---- decisions (two-way) ----
export async function openDecision(boardId: string, featureId: string, question: string, options?: Array<DecisionOption>, openedBy = 'agent'): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const decisions = (plan.decisions ??= [])
  const nextN = decisions.reduce((m, d) => { const x = /^D(\d+)$/.exec(d.id); return x ? Math.max(m, Number(x[1])) : m }, 0) + 1
  const id = `D${nextN}`
  decisions.push({ id, teks: question, status: 'open', opsi: options, featureId, openedBy } as Decision)
  const feat = plan.features.find((f) => f.id === featureId)
  if (feat) feat.blocked = `Waiting on decision ${id}`
  await writeDoc(boardId, 'plan', plan)
  await appendActivity(boardId, { actor: openedBy, actorType: 'agent', kind: 'decision', text: `opened ${id}: ${question}`, featureId })
  return readBoard(boardId)
}
export async function decideDecision(boardId: string, id: string, answer: string, keputusan?: string, decidedBy = 'human'): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const d = plan.decisions?.find((x) => x.id === id)
  if (!d) throw new Error(`decision not found: ${id}`)
  d.status = 'decided'; d.jawaban = answer; d.keputusan = keputusan ?? answer; d.tanggal_putus = todayISO()
  if (d.featureId) { const feat = plan.features.find((f) => f.id === d.featureId); if (feat && String(feat.blocked ?? '').includes(id)) feat.blocked = null }
  await writeDoc(boardId, 'plan', plan)
  await appendActivity(boardId, { actor: decidedBy, actorType: 'human', kind: 'decision', text: `decided ${id}: ${d.keputusan}`, featureId: d.featureId })
  return readBoard(boardId)
}
export async function setBlocked(boardId: string, featureId: string, reason: string, by = 'agent'): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.blocked = reason
  await writeDoc(boardId, 'plan', plan)
  await appendActivity(boardId, { actor: by, kind: 'blocked', text: `blocked: ${reason}`, featureId })
  return readBoard(boardId)
}
export async function clearBlocked(boardId: string, featureId: string, by = 'human'): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.blocked = null
  await writeDoc(boardId, 'plan', plan)
  await appendActivity(boardId, { actor: by, kind: 'blocked', text: 'unblocked', featureId })
  return readBoard(boardId)
}

// ---- system design upload (komponen catalog / architecture / design-system links / pages) ----
export interface ProjectDesignPatch {
  arsitektur?: string
  baseline?: Array<string>
  komponen?: Array<Record<string, unknown>>
  foundationUrl?: string
  componentsUrl?: string
  pagesUrl?: string
  pages?: Array<Record<string, unknown>>
}
export async function setProjectDesign(boardId: string, projectId: string, patch: ProjectDesignPatch): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const p = plan.projects.find((x) => x.id === projectId) as Record<string, unknown> | undefined
  if (!p) throw new Error(`project not found: ${projectId}`)
  if (patch.komponen !== undefined) p.komponen = patch.komponen
  if (patch.foundationUrl !== undefined) p.design_foundation = patch.foundationUrl
  if (patch.componentsUrl !== undefined) p.design_components = patch.componentsUrl
  if (patch.pagesUrl !== undefined) p.design_pages = patch.pagesUrl
  if (patch.arsitektur !== undefined || patch.baseline !== undefined || patch.pages !== undefined) {
    const docs = { ...((p.docs as Record<string, unknown>) ?? {}) }
    if (patch.arsitektur !== undefined) docs.arsitektur = patch.arsitektur
    if (patch.baseline !== undefined) docs.baseline = patch.baseline
    if (patch.pages !== undefined) docs.pages = patch.pages
    p.docs = docs
  }
  await writeDoc(boardId, 'plan', plan)
  return readBoard(boardId)
}
/** Append one component to a project's catalog. */
export async function addComponent(boardId: string, projectId: string, komponen: Record<string, unknown>): Promise<RawBoard> {
  const plan = await readPlan(boardId)
  const p = plan.projects.find((x) => x.id === projectId) as Record<string, unknown> | undefined
  if (!p) throw new Error(`project not found: ${projectId}`)
  const list = (Array.isArray(p.komponen) ? p.komponen : []) as Array<Record<string, unknown>>
  list.push(komponen)
  p.komponen = list
  await writeDoc(boardId, 'plan', plan)
  return readBoard(boardId)
}

// ---- adaptive views: tasks / ops / prod / guide ----
// Tasks live in the `tasks` table (row per task). List reads return LIGHT summaries
// (no heavy 20-point mapping); the detail page pulls one full row via readTask().
export async function readTasks(boardId: string): Promise<TasksFile> {
  return { tasks: await taskSummaries(boardId) }
}
export async function readTaskSummaries(boardId: string, projectId?: string): Promise<Array<WorkTask>> {
  return taskSummaries(boardId, projectId)
}
export function readTask(boardId: string, id: string): Promise<WorkTask | null> {
  return taskFull(boardId, id)
}
export async function readOps(boardId: string): Promise<OpsData> {
  const o = await readDoc<Partial<OpsData>>(boardId, 'accounts', { vault: {}, accounts: [] })
  return { vault: o.vault ?? {}, accounts: o.accounts ?? [], alert: o.alert }
}
export async function readProd(boardId: string): Promise<ProdData> {
  const p = await readDoc<Partial<ProdData>>(boardId, 'prod', { gates: [] })
  return { mockLabel: p.mockLabel, headline: p.headline, gates: p.gates ?? [] }
}
export async function readGuide(boardId: string): Promise<GuideData> {
  const g = await readDoc<Partial<GuideData>>(boardId, 'guide', { sections: [] })
  return { sections: g.sections ?? [] }
}
export async function toggleCheckpoint(boardId: string, taskId: string, checkpointId: string): Promise<TasksFile> {
  await toggleCheckpointRow(boardId, taskId, checkpointId)
  return { tasks: await taskSummaries(boardId) }
}

// ---- write suite: granular upsert/delete + set + bulk snapshot ----
/** Ensure the array fields the UI/readers assume always exist (tolerant import). */
function normTask(t: WorkTask): WorkTask {
  return { ...t, checkpoints: t.checkpoints ?? [], dependencies: t.dependencies ?? [], impacts: t.impacts ?? [] }
}
function normFeature(f: RawFeature): RawFeature {
  return { ...f, checklist: f.checklist ?? [] }
}
export async function upsertTask(boardId: string, task: WorkTask, expectedRev?: number): Promise<{ ok: true; id: string; created: boolean; rev: number; total: number }> {
  const { created, rev } = await upsertTaskRow(boardId, normTask(task), { expectedRev })
  return { ok: true, id: task.id, created, rev, total: await taskCount(boardId) }
}
export async function deleteTask(boardId: string, taskId: string): Promise<{ ok: true; removed: number; total: number }> {
  const removed = await deleteTaskRow(boardId, taskId)
  return { ok: true, removed, total: await taskCount(boardId) }
}
export async function upsertFeature(boardId: string, feature: RawFeature): Promise<{ ok: true; id: string; created: boolean; total: number }> {
  const plan = await readPlan(boardId)
  const i = plan.features.findIndex((f) => f.id === feature.id)
  const next = normFeature({ ...feature, updated: feature.updated ?? todayISO() })
  if (i >= 0) plan.features[i] = normFeature({ ...plan.features[i], ...next })
  else plan.features.push(next)
  await writeDoc(boardId, 'plan', plan)
  return { ok: true, id: feature.id, created: i < 0, total: plan.features.length }
}
export async function deleteFeature(boardId: string, featureId: string): Promise<{ ok: true; removed: number; total: number }> {
  const plan = await readPlan(boardId)
  const before = plan.features.length
  plan.features = plan.features.filter((f) => f.id !== featureId)
  await writeDoc(boardId, 'plan', plan)
  return { ok: true, removed: before - plan.features.length, total: plan.features.length }
}
export async function setProd(boardId: string, prod: ProdData): Promise<ProdData> {
  await writeDoc(boardId, 'prod', prod)
  return readProd(boardId)
}
export async function setGuide(boardId: string, guide: GuideData): Promise<GuideData> {
  await writeDoc(boardId, 'guide', guide)
  return readGuide(boardId)
}
export async function replaceAccounts(boardId: string, ops: OpsData): Promise<OpsData> {
  await writeDoc(boardId, 'accounts', ops)
  return readOps(boardId)
}

// ---- bulk snapshot (transactional, dry-run + hash guard) ----
export interface BoardSnapshot {
  projects?: Array<RawProject>
  features?: Array<RawFeature>
  tasks?: Array<WorkTask>
  productionGates?: Array<ProdGate>
  prodMockLabel?: string
  prodHeadline?: string
  guide?: Array<GuideSection>
  accounts?: OpsData
  runs?: Array<Run>
}
interface BoardCounts {
  projects: number
  features: number
  tasks: number
  productionGates: number
  guideSections: number
  accounts: number
  runs: number
}
/** Deterministic stringify (sorted keys) — stable hash regardless of key order. */
function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o).sort().map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`).join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}
async function boardShape(boardId: string) {
  const [plan, tasks, prod, guide, ops, runsDoc] = await Promise.all([
    readPlan(boardId), readTasks(boardId), readProd(boardId), readGuide(boardId), readOps(boardId), readRunsDoc(boardId),
  ])
  return { plan, tasks, prod, guide, ops, runsDoc }
}
function countsOf(s: Awaited<ReturnType<typeof boardShape>>): BoardCounts {
  return {
    projects: s.plan.projects.length,
    features: s.plan.features.length,
    tasks: s.tasks.tasks.length,
    productionGates: s.prod.gates.length,
    guideSections: s.guide.sections.length,
    accounts: s.ops.accounts.length,
    runs: s.runsDoc.runs.length,
  }
}
/** 16-char content hash of the 7 board collections — used for optimistic concurrency. */
export async function boardHash(boardId: string): Promise<string> {
  const s = await boardShape(boardId)
  const shape = {
    projects: s.plan.projects, features: s.plan.features, tasks: s.tasks.tasks,
    gates: s.prod.gates, guide: s.guide.sections, accounts: s.ops, runs: s.runsDoc.runs,
  }
  return createHash('sha256').update(stableStringify(shape)).digest('hex').slice(0, 16)
}
export interface SnapshotReceipt {
  ok: boolean
  dryRun: boolean
  boardId: string
  applied: Array<string>
  before: BoardCounts
  after: BoardCounts
  fromHash: string
  toHash: string | null
}
/** Replace whole collections in one transaction. Only provided fields change;
 *  replacing an array upserts new + drops stale. dryRun returns the diff without
 *  writing. expectedHash (from boardHash) guards against concurrent edits. */
export async function replaceBoardSnapshot(
  boardId: string,
  snap: BoardSnapshot,
  opts: { dryRun?: boolean; expectedHash?: string } = {},
): Promise<SnapshotReceipt> {
  const cur = await boardShape(boardId)
  const before = countsOf(cur)
  const fromHash = await boardHash(boardId)
  if (opts.expectedHash && opts.expectedHash !== fromHash) {
    throw new Error(`hash mismatch: board changed since read (expected ${opts.expectedHash}, current ${fromHash}). Re-read get_board_hash and retry.`)
  }
  // build next docs (mutate copies from current)
  const plan = cur.plan
  if (snap.projects !== undefined) plan.projects = snap.projects
  if (snap.features !== undefined) plan.features = snap.features.map(normFeature)
  const nextTaskRows = snap.tasks !== undefined ? snap.tasks.map(normTask) : null // tasks live in their own table
  const nextProd: ProdData = {
    mockLabel: snap.prodMockLabel ?? cur.prod.mockLabel,
    headline: snap.prodHeadline ?? cur.prod.headline,
    gates: snap.productionGates ?? cur.prod.gates,
  }
  const nextGuide: GuideData = snap.guide !== undefined ? { sections: snap.guide } : cur.guide
  const nextOps: OpsData = snap.accounts ?? cur.ops
  const nextRuns = snap.runs !== undefined ? { runs: snap.runs } : cur.runsDoc

  const applied: Array<string> = []
  const docs: Record<string, unknown> = {}
  if (snap.projects !== undefined || snap.features !== undefined) { docs.plan = plan; applied.push(snap.projects !== undefined ? 'projects' : '', snap.features !== undefined ? 'features' : '') }
  if (nextTaskRows !== null) applied.push('tasks') // tasks go to the tasks table, not a doc
  if (snap.productionGates !== undefined || snap.prodMockLabel !== undefined || snap.prodHeadline !== undefined) { docs.prod = nextProd; applied.push('productionGates') }
  if (snap.guide !== undefined) { docs.guide = nextGuide; applied.push('guide') }
  if (snap.accounts !== undefined) { docs.accounts = nextOps; applied.push('accounts') }
  if (snap.runs !== undefined) { docs.runs = nextRuns; applied.push('runs') }
  const appliedClean = applied.filter(Boolean)

  const after: BoardCounts = {
    projects: (snap.projects ?? cur.plan.projects).length,
    features: (snap.features ?? cur.plan.features).length,
    tasks: nextTaskRows ? nextTaskRows.length : cur.tasks.tasks.length,
    productionGates: nextProd.gates.length,
    guideSections: nextGuide.sections.length,
    accounts: nextOps.accounts.length,
    runs: nextRuns.runs.length,
  }
  if (opts.dryRun) {
    return { ok: true, dryRun: true, boardId, applied: appliedClean, before, after, fromHash, toHash: null }
  }
  if (Object.keys(docs).length) await writeDocsTx(boardId, docs)
  if (nextTaskRows !== null) await replaceTaskRows(boardId, nextTaskRows)
  const toHash = await boardHash(boardId)
  return { ok: true, dryRun: false, boardId, applied: appliedClean, before, after, fromHash, toHash }
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function nowISO(): string {
  return new Date().toISOString()
}
