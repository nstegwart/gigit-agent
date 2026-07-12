// Server-only data store — boardId-aware. Each board = its own scope under
// data/boards/<boardId>/ (plan.json + runs.json + design.json + collab.json).
// Conventions + the board index are global (data/conventions.json, data/boards.json).
// Imported ONLY by server functions + the MCP route — never by client components.
//
// CAIRN_DATA_DIR overrides the data root (tests point it at a temp copy).
import fs from 'node:fs'
import path from 'node:path'

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
  OpsData,
  ProdData,
  RawBoard,
  RawFeature,
  Run,
  TasksFile,
} from '#/lib/types'

function dataRoot(): string {
  return process.env.CAIRN_DATA_DIR || path.join(process.cwd(), 'data')
}
const boardsRoot = () => path.join(dataRoot(), 'boards')
const boardDir = (boardId: string) => path.join(boardsRoot(), boardId)
const planPath = (b: string) => path.join(boardDir(b), 'plan.json')
const runsPath = (b: string) => path.join(boardDir(b), 'runs.json')
const designPath = (b: string) => path.join(boardDir(b), 'design.json')
const collabPath = (b: string) => path.join(boardDir(b), 'collab.json')
const conventionsPath = () => path.join(dataRoot(), 'conventions.json')
const boardsIndexPath = () => path.join(dataRoot(), 'boards.json')
const tasksPath = (b: string) => path.join(boardDir(b), 'tasks.json')
const accountsPath = (b: string) => path.join(boardDir(b), 'accounts.json')
const prodPath = (b: string) => path.join(boardDir(b), 'prod.json')
const guidePath = (b: string) => path.join(boardDir(b), 'guide.json')

function readJSON<T>(p: string): T {
  return JSON.parse(fs.readFileSync(p, 'utf8')) as T
}
function writeJSON(p: string, obj: unknown): void {
  // Atomic write: a concurrent reader (UI/MCP) sees either the old or the new
  // complete file, never a half-written one. Same-dir temp keeps rename atomic.
  const tmp = `${p}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2) + '\n', 'utf8')
  fs.renameSync(tmp, p)
}

type PlanFile = Omit<RawBoard, 'runs'>
interface RunsFile {
  runs: Array<Run>
  [k: string]: unknown
}

// ---- board index ----
interface BoardsIndex {
  boards: Array<BoardMeta>
  [k: string]: unknown
}
function readIndex(): BoardsIndex {
  try {
    const idx = readJSON<Partial<BoardsIndex>>(boardsIndexPath())
    return { boards: idx.boards ?? [] }
  } catch {
    return { boards: [] }
  }
}
export function listBoards(): Array<BoardMeta> {
  return readIndex().boards
}
export function boardExists(boardId: string): boolean {
  return fs.existsSync(planPath(boardId))
}
export function defaultBoardId(): string {
  return readIndex().boards[0]?.id ?? 'ibils'
}

const DEFAULT_PLAN: PlanFile = {
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

/** Create a new (empty) board. Returns the updated board index. */
export function createBoard(
  id: string,
  name: string,
  description = '',
  views?: Array<string>,
): Array<BoardMeta> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid board id: ${id} (use kebab-case)`)
  if (boardExists(id)) throw new Error(`board already exists: ${id}`)
  fs.mkdirSync(boardDir(id), { recursive: true })
  writeJSON(planPath(id), { ...DEFAULT_PLAN, updated: todayISO() })
  writeJSON(runsPath(id), { runs: [] })
  writeJSON(designPath(id), { projects: {}, features: {} })
  writeJSON(collabPath(id), { comments: {}, activity: [] })
  const idx = readIndex()
  idx.boards.push({ id, name, description, createdAt: todayISO(), views: views ?? DEFAULT_VIEWS })
  writeJSON(boardsIndexPath(), idx)
  return idx.boards
}

// ---- per-board readers ----
function readPlan(b: string): PlanFile {
  return readJSON<PlanFile>(planPath(b))
}
function readRunsFile(b: string): RunsFile {
  try {
    return readJSON<RunsFile>(runsPath(b))
  } catch {
    return { runs: [] }
  }
}
function readDesign(b: string): DesignOverlay {
  try {
    const d = readJSON<Partial<DesignOverlay>>(designPath(b))
    return { projects: d.projects ?? {}, features: d.features ?? {} }
  } catch {
    return { projects: {}, features: {} }
  }
}
function readCollab(b: string): CollabOverlay {
  try {
    const c = readJSON<Partial<CollabOverlay>>(collabPath(b))
    return { comments: c.comments ?? {}, activity: c.activity ?? [] }
  } catch {
    return { comments: {}, activity: [] }
  }
}
export function readConventions(): Conventions {
  try {
    return readJSON<Conventions>(conventionsPath())
  } catch {
    return {}
  }
}

// ---- adaptive views: tasks / ops / prod / guide (per board, lazy-read) ----
export function readTasks(boardId: string): TasksFile {
  try {
    const t = readJSON<Partial<TasksFile>>(tasksPath(boardId))
    return { tasks: t.tasks ?? [] }
  } catch {
    return { tasks: [] }
  }
}
export function readOps(boardId: string): OpsData {
  try {
    const o = readJSON<Partial<OpsData>>(accountsPath(boardId))
    return { vault: o.vault ?? {}, accounts: o.accounts ?? [], alert: o.alert }
  } catch {
    return { vault: {}, accounts: [] }
  }
}
export function readProd(boardId: string): ProdData {
  try {
    const p = readJSON<Partial<ProdData>>(prodPath(boardId))
    return { mockLabel: p.mockLabel, headline: p.headline, gates: p.gates ?? [] }
  } catch {
    return { gates: [] }
  }
}
export function readGuide(boardId: string): GuideData {
  try {
    const g = readJSON<Partial<GuideData>>(guidePath(boardId))
    return { sections: g.sections ?? [] }
  } catch {
    return { sections: [] }
  }
}

/** Toggle a task checkpoint's done flag. Returns the fresh tasks file. */
export function toggleCheckpoint(boardId: string, taskId: string, checkpointId: string): TasksFile {
  const file = readTasks(boardId)
  const task = file.tasks.find((t) => t.id === taskId)
  if (!task) throw new Error(`task not found: ${taskId}`)
  const cp = task.checkpoints.find((c) => c.id === checkpointId)
  if (!cp) throw new Error(`checkpoint not found: ${checkpointId}`)
  cp.done = !cp.done
  writeJSON(tasksPath(boardId), file)
  return file
}

/** Full raw board = plan + runs + overlays, merged. */
export function readBoard(boardId: string): RawBoard {
  const plan = readPlan(boardId)
  const { runs } = readRunsFile(boardId)
  return {
    ...plan,
    runs: runs ?? [],
    conventions: readConventions(),
    design: readDesign(boardId),
    collab: readCollab(boardId),
  }
}

/** Toggle (or set) a checklist task's done flag. */
export function toggleTask(boardId: string, featureId: string, index: number, done?: boolean): RawBoard {
  const plan = readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId) as RawFeature | undefined
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  const task = feat.checklist?.[index]
  if (!task) throw new Error(`task ${index} not found on ${featureId}`)
  task.done = done ?? !task.done
  feat.updated = todayISO()
  writeJSON(planPath(boardId), plan)
  return readBoard(boardId)
}

export function setFeaturePhase(boardId: string, featureId: string, fase: string): RawBoard {
  const plan = readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.fase = fase
  feat.updated = todayISO()
  writeJSON(planPath(boardId), plan)
  return readBoard(boardId)
}

/** Insert or update an agent run (the write path an agent uses to report itself). */
export function upsertRun(boardId: string, run: Partial<Run> & { id: string }): RawBoard {
  const file = readRunsFile(boardId)
  const runs = file.runs ?? []
  const i = runs.findIndex((r) => r.id === run.id)
  const now = nowISO()
  if (i >= 0) {
    runs[i] = { ...runs[i], ...run, updated: run.updated ?? now }
  } else {
    runs.push({
      role: 'Worker', status: 'running', started: now, updated: now,
      model: '', effort: 'medium', task: '', agent: run.id, agentType: 'claude',
      ...run,
    } as Run)
  }
  writeJSON(runsPath(boardId), { ...file, runs })
  return readBoard(boardId)
}

export function setRunStatus(boardId: string, id: string, status: Run['status']): RawBoard {
  const file = readRunsFile(boardId)
  const runs = file.runs ?? []
  const run = runs.find((r) => r.id === id)
  if (!run) throw new Error(`run not found: ${id}`)
  run.status = status
  run.updated = nowISO()
  writeJSON(runsPath(boardId), { ...file, runs })
  return readBoard(boardId)
}

// ---- design overlay ----
export function addDesignLink(boardId: string, scope: 'project' | 'feature', id: string, link: FeatureLink): RawBoard {
  const d = readDesign(boardId)
  const bucket = scope === 'project' ? d.projects : d.features
  ;(bucket[id] ??= []).push({ label: link.label, url: link.url })
  writeJSON(designPath(boardId), d)
  return readBoard(boardId)
}

// ---- collab: comments + activity ----
export function addComment(boardId: string, featureId: string, author: string, authorType: Actor, text: string): RawBoard {
  const c = readCollab(boardId)
  const comment: Comment = { id: `c-${Date.now()}`, featureId, author, authorType, text, ts: nowISO() }
  ;(c.comments[featureId] ??= []).push(comment)
  c.activity.unshift({ ts: comment.ts, actor: author, actorType: authorType, kind: 'comment', text, featureId })
  writeJSON(collabPath(boardId), c)
  return readBoard(boardId)
}

export function appendActivity(boardId: string, ev: Omit<ActivityEvent, 'ts'> & { ts?: string }): RawBoard {
  const c = readCollab(boardId)
  c.activity.unshift({
    ts: ev.ts ?? nowISO(), actor: ev.actor, actorType: ev.actorType,
    kind: ev.kind, text: ev.text, featureId: ev.featureId, projectId: ev.projectId,
  })
  writeJSON(collabPath(boardId), c)
  return readBoard(boardId)
}

// ---- decisions (two-way) ----
export function openDecision(boardId: string, featureId: string, question: string, options?: Array<DecisionOption>, openedBy = 'agent'): RawBoard {
  const plan = readPlan(boardId)
  const decisions = (plan.decisions ??= [])
  const nextN = decisions.reduce((max, d) => {
    const m = /^D(\d+)$/.exec(d.id)
    return m ? Math.max(max, Number(m[1])) : max
  }, 0) + 1
  const id = `D${nextN}`
  const decision: Decision = { id, teks: question, status: 'open', opsi: options, featureId, openedBy }
  decisions.push(decision)
  const feat = plan.features.find((f) => f.id === featureId)
  if (feat) feat.blocked = `Waiting on decision ${id}`
  writeJSON(planPath(boardId), plan)
  appendActivity(boardId, { actor: openedBy, actorType: 'agent', kind: 'decision', text: `opened ${id}: ${question}`, featureId })
  return readBoard(boardId)
}

export function decideDecision(boardId: string, id: string, answer: string, keputusan?: string, decidedBy = 'human'): RawBoard {
  const plan = readPlan(boardId)
  const d = plan.decisions?.find((x) => x.id === id)
  if (!d) throw new Error(`decision not found: ${id}`)
  d.status = 'decided'
  d.jawaban = answer
  d.keputusan = keputusan ?? answer
  d.tanggal_putus = todayISO()
  if (d.featureId) {
    const feat = plan.features.find((f) => f.id === d.featureId)
    if (feat && String(feat.blocked ?? '').includes(id)) feat.blocked = null
  }
  writeJSON(planPath(boardId), plan)
  appendActivity(boardId, { actor: decidedBy, actorType: 'human', kind: 'decision', text: `decided ${id}: ${d.keputusan}`, featureId: d.featureId })
  return readBoard(boardId)
}

// ---- blocked ----
export function setBlocked(boardId: string, featureId: string, reason: string, by = 'agent'): RawBoard {
  const plan = readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.blocked = reason
  writeJSON(planPath(boardId), plan)
  appendActivity(boardId, { actor: by, kind: 'blocked', text: `blocked: ${reason}`, featureId })
  return readBoard(boardId)
}
export function clearBlocked(boardId: string, featureId: string, by = 'human'): RawBoard {
  const plan = readPlan(boardId)
  const feat = plan.features.find((f) => f.id === featureId)
  if (!feat) throw new Error(`feature not found: ${featureId}`)
  feat.blocked = null
  writeJSON(planPath(boardId), plan)
  appendActivity(boardId, { actor: by, kind: 'blocked', text: 'unblocked', featureId })
  return readBoard(boardId)
}

function todayISO(): string {
  return new Date().toISOString().slice(0, 10)
}
function nowISO(): string {
  return new Date().toISOString()
}
