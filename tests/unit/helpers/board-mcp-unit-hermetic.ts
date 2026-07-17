/**
 * Hermetic in-memory adapters for board-MCP / MCP-auth unit suites.
 *
 * Purpose: intercept ambient MySQL producers (board-store + tasks-store rows/audit)
 * so default `vitest` unit runs never require 127.0.0.1:3306.
 *
 * Covers inventory UNIT-DB-HERMETIC cases 1–12 (mapper MANIFEST2).
 * Not a product DI surface — unit-test only.
 */
import { createHash } from 'node:crypto'

import type {
  ActivityEvent,
  Actor,
  BoardMeta,
  CollabOverlay,
  Comment,
  RawBoard,
  RawFeature,
  Run,
} from '#/lib/types'

type HermeticBoard = {
  id: string
  name: string
  description: string
  plan: {
    fase_label: Record<string, string>
    fase_persen: Record<string, number>
    projects: Array<Record<string, unknown>>
    features: Array<RawFeature>
    decisions: Array<Record<string, unknown>>
    log: Array<Record<string, unknown>>
    queue: { now: Array<string>; next: Array<string> }
    docs: Array<Record<string, unknown>>
    updated?: string
  }
  runs: Array<Run>
  collab: CollabOverlay
}

const DEFAULT_FASE_LABEL: Record<string, string> = {
  backlog: 'Backlog',
  spec: 'Spec',
  design: 'Desain',
  'review-owner': 'Review Owner',
  build: 'Build',
  qa: 'QA',
  uat: 'UAT',
  done: 'Done',
}

const DEFAULT_FASE_PERSEN: Record<string, number> = {
  backlog: 0,
  spec: 15,
  design: 35,
  'review-owner': 45,
  build: 65,
  qa: 80,
  uat: 90,
  done: 100,
}

const boards = new Map<string, HermeticBoard>()

function nowISO(): string {
  return new Date().toISOString()
}

function todayISO(): string {
  return nowISO().slice(0, 10)
}

function emptyCollab(): CollabOverlay {
  return { comments: {}, activity: [] }
}

function makeBoard(id: string, name: string, description = ''): HermeticBoard {
  return {
    id,
    name,
    description,
    plan: {
      fase_label: { ...DEFAULT_FASE_LABEL },
      fase_persen: { ...DEFAULT_FASE_PERSEN },
      projects: [],
      features: [],
      decisions: [],
      log: [],
      queue: { now: [], next: [] },
      docs: [],
      updated: todayISO(),
    },
    runs: [],
    collab: emptyCollab(),
  }
}

/** Soft-empty board view for ids never created (matches readDoc defaults without MySQL). */
function viewOrEmpty(boardId: string): HermeticBoard {
  return boards.get(boardId) ?? makeBoard(boardId, boardId)
}

function stableStringify(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  if (v && typeof v === 'object') {
    const o = v as Record<string, unknown>
    return `{${Object.keys(o)
      .sort()
      .map((k) => `${JSON.stringify(k)}:${stableStringify(o[k])}`)
      .join(',')}}`
  }
  return JSON.stringify(v) ?? 'null'
}

function toRawBoard(b: HermeticBoard): RawBoard {
  return {
    fase_label: b.plan.fase_label,
    fase_persen: b.plan.fase_persen,
    // Hermetic plan rows are soft-shaped; coerce through unknown for RawBoard consumers.
    projects: b.plan.projects as unknown as RawBoard['projects'],
    features: b.plan.features,
    decisions: b.plan.decisions as unknown as RawBoard['decisions'],
    log: b.plan.log as unknown as RawBoard['log'],
    queue: b.plan.queue,
    docs: b.plan.docs as unknown as RawBoard['docs'],
    updated: b.plan.updated,
    runs: b.runs,
    conventions: {},
    design: { projects: {}, features: {} },
    collab: {
      comments: { ...b.collab.comments },
      activity: [...b.collab.activity],
    },
  }
}

function listMeta(): Array<BoardMeta> {
  return [...boards.values()].map((b) => ({
    id: b.id,
    name: b.name,
    description: b.description,
  }))
}

/** Clear all hermetic boards between unit tests. */
export function resetHermeticBoardStore(): void {
  boards.clear()
}

export async function hermeticBoardExists(boardId: string): Promise<boolean> {
  return boards.has(boardId)
}

export async function hermeticCreateBoard(
  id: string,
  name: string,
  description = '',
): Promise<Array<BoardMeta>> {
  if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) throw new Error(`invalid board id: ${id} (use kebab-case)`)
  if (boards.has(id)) throw new Error(`board already exists: ${id}`)
  boards.set(id, makeBoard(id, name, description))
  return listMeta()
}

export async function hermeticDeleteBoard(boardId: string): Promise<Array<BoardMeta>> {
  boards.delete(boardId)
  return listMeta()
}

export async function hermeticReadBoard(boardId: string): Promise<RawBoard> {
  return toRawBoard(viewOrEmpty(boardId))
}

export async function hermeticBoardHash(boardId: string): Promise<string> {
  const b = viewOrEmpty(boardId)
  const shape = {
    projects: b.plan.projects,
    features: b.plan.features,
    tasks: [] as unknown[],
    gates: [] as unknown[],
    guide: [] as unknown[],
    accounts: {},
    runs: b.runs,
  }
  return createHash('sha256').update(stableStringify(shape)).digest('hex').slice(0, 16)
}

export async function hermeticUpsertFeature(
  boardId: string,
  feature: RawFeature,
): Promise<{ ok: true; id: string; created: boolean; total: number }> {
  let b = boards.get(boardId)
  if (!b) {
    b = makeBoard(boardId, boardId)
    boards.set(boardId, b)
  }
  const i = b.plan.features.findIndex((f) => f.id === feature.id)
  const created = i < 0
  if (created) b.plan.features.push({ ...feature })
  else b.plan.features[i] = { ...b.plan.features[i], ...feature }
  b.plan.updated = todayISO()
  return { ok: true, id: feature.id, created, total: b.plan.features.length }
}

export async function hermeticAddComment(
  boardId: string,
  featureId: string,
  author: string,
  authorType: Actor,
  text: string,
): Promise<RawBoard> {
  let b = boards.get(boardId)
  if (!b) {
    b = makeBoard(boardId, boardId)
    boards.set(boardId, b)
  }
  const comment: Comment = {
    id: `c-${Date.now()}`,
    featureId,
    author,
    authorType,
    text,
    ts: nowISO(),
  }
  ;(b.collab.comments[featureId] ??= []).push(comment)
  const ev: ActivityEvent = {
    ts: comment.ts,
    actor: author,
    actorType: authorType,
    kind: 'comment',
    text,
    featureId,
  }
  b.collab.activity.unshift(ev)
  return toRawBoard(b)
}

export async function hermeticTaskStageRows(
  _boardId: string,
): Promise<
  Array<{
    id: string
    stage: string | null
    project: string | null
    feature: string | null
    scope: string | null
    ckDone: number
    ckTotal: number
    blocked: boolean
  }>
> {
  // Unit hermetic: empty lifecycle (case 9 + any init_lifecycle empty path).
  return []
}

export async function hermeticReadAudit(
  _boardId: string,
  _opts: { taskId?: string; limit?: number } = {},
): Promise<Array<Record<string, unknown>>> {
  return []
}

export async function hermeticWriteAudit(
  _boardId: string,
  _e: {
    ts: string
    actor?: string | null
    action: string
    taskId?: string | null
    fromStage?: string | null
    toStage?: string | null
    detail?: unknown
  },
): Promise<void> {
  /* no-op */
}

/** Partial board-store overrides for vi.mock spread. */
export const hermeticBoardStoreApi = {
  boardExists: hermeticBoardExists,
  createBoard: hermeticCreateBoard,
  deleteBoard: hermeticDeleteBoard,
  readBoard: hermeticReadBoard,
  boardHash: hermeticBoardHash,
  upsertFeature: hermeticUpsertFeature,
  addComment: hermeticAddComment,
} as const

/** Partial tasks-store overrides for vi.mock spread (static + dynamic import sites). */
export const hermeticTasksStoreApi = {
  taskStageRows: hermeticTaskStageRows,
  readAudit: hermeticReadAudit,
  writeAudit: hermeticWriteAudit,
} as const
