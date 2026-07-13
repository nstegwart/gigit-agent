// Server functions — the read/write API the UI (via TanStack Query) and SSR loaders call.
// Every board mutation is boardId-scoped and returns the fresh raw board.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  addComment,
  addDesignLink,
  clearBlocked,
  createBoard,
  decideDecision,
  listBoards,
  openDecision,
  readBoard,
  readGuide,
  readOps,
  readProd,
  readTask,
  readTasks,
  setBlocked,
  setFeaturePhase,
  setRunStatus,
  toggleCheckpoint,
  toggleTask,
  upsertRun,
} from './board-store'
import { advanceTask, computeRollup, readLifecycle, writeLifecycle } from './lifecycle-store'
import { taskLifecycle } from './tasks-store'
import { currentUser, requireAdminWrite, requireView } from './auth'
import { resolveSharedDispatchNext } from './control-plane-ingest'

const board = z.string().min(1)

// NEXT sole source = shared process dispatch-plan store (same instance as MCP publish/get_next).

// ---- boards ----
// Visibility is enforced here: a member sees only allowlisted boards; admin sees all.
// admin session maps to OWNER (rbac); never silently ROOT/AGENT/INTEGRATOR.
export const listBoardsFn = createServerFn({ method: 'GET' }).handler(async () => {
  const me = await currentUser()
  if (!me) return []
  const boards = await listBoards()
  return me.role === 'admin' ? boards : boards.filter((b) => me.boards.includes(b.id))
})

export const createBoardFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), name: z.string().min(1), description: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return createBoard(data.id, data.name, data.description)
  })

// ---- board data ----
export const getBoardFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readBoard(data.boardId)
  })

export const toggleTaskFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), index: z.number().int(), done: z.boolean().optional() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return toggleTask(data.boardId, data.featureId, data.index, data.done)
  })

export const setFeaturePhaseFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), fase: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return setFeaturePhase(data.boardId, data.featureId, data.fase)
  })

export const upsertRunFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      boardId: board,
      id: z.string(),
      agent: z.string().optional(),
      role: z.string().optional(),
      agentType: z.string().optional(),
      model: z.string().optional(),
      effort: z.string().optional(),
      task: z.string().optional(),
      feature: z.string().nullable().optional(),
      project: z.string().nullable().optional(),
      status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']).optional(),
      note: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdminWrite()
    const { boardId, ...run } = data
    return upsertRun(boardId, run as never)
  })

export const setRunStatusFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return setRunStatus(data.boardId, data.id, data.status)
  })

// ---- design links ----
export const addDesignLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, scope: z.enum(['project', 'feature']), id: z.string(), label: z.string().optional(), url: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return addDesignLink(data.boardId, data.scope, data.id, { label: data.label, url: data.url })
  })

// ---- collaboration ----
export const addCommentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), author: z.string(), authorType: z.enum(['human', 'agent']).default('human'), text: z.string().min(1) }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return addComment(data.boardId, data.featureId, data.author, data.authorType, data.text)
  })

export const openDecisionFn = createServerFn({ method: 'POST' })
  .validator(
    z.object({
      boardId: board,
      featureId: z.string(),
      question: z.string().min(1),
      options: z.array(z.object({ key: z.string(), label: z.string(), rekomendasi: z.boolean().optional() })).optional(),
      openedBy: z.string().optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return openDecision(data.boardId, data.featureId, data.question, data.options, data.openedBy)
  })

export const decideDecisionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, id: z.string(), answer: z.string(), keputusan: z.string().optional(), decidedBy: z.string().optional() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return decideDecision(data.boardId, data.id, data.answer, data.keputusan, data.decidedBy)
  })

export const setBlockedFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), reason: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return setBlocked(data.boardId, data.featureId, data.reason)
  })

export const clearBlockedFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return clearBlocked(data.boardId, data.featureId)
  })

// ---- adaptive views: tasks / ops / prod / guide ----
export const getTasksFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readTasks(data.boardId)
  })

// full single task (heavy 20-point mapping) — detail page only
export const getTaskFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board, taskId: z.string() }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readTask(data.boardId, data.taskId)
  })

// ---- lifecycle engine (read paths for the UI) ----
export const getLifecycleFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readLifecycle(data.boardId)
  })

export const getRollupFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return computeRollup(data.boardId)
  })

export const getTaskLifecycleFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board, taskId: z.string() }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return taskLifecycle(data.boardId, data.taskId)
  })

const stageSchema = z.object({
  key: z.string(), label: z.string(), color: z.string().optional(), group: z.string().optional(),
  gated: z.boolean().optional(), requiresEvidence: z.array(z.string()).optional(), verifierRole: z.string().optional(),
  readiness: z.number().optional(), milestone: z.boolean().optional(),
})
export const setLifecycleFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, stages: z.array(stageSchema).min(1) }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return writeLifecycle(data.boardId, data.stages)
  })

export const advanceTaskFn = createServerFn({ method: 'POST' })
  .validator(z.object({
    boardId: board, taskId: z.string(), toStage: z.string(), byRunId: z.string().optional(), role: z.string().optional(),
    evidence: z.record(z.string(), z.any()).optional(), verdict: z.string().optional(), commitSha: z.string().optional(),
    deployReceipt: z.string().optional(), blocker: z.string().optional(), expectedRev: z.number().int().optional(),
  }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return advanceTask(data.boardId, data.taskId, data)
  })

export const getOpsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readOps(data.boardId)
  })

export const getProdFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readProd(data.boardId)
  })

export const getGuideFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return readGuide(data.boardId)
  })

/**
 * Sole NEXT source = active dispatch plan selection (no UI heuristic).
 * Reads the process-wide shared plan store (publish + MCP + this Fn share one).
 * Returns empty selection when no active plan / expired / superseded.
 */
export const getNextFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return resolveSharedDispatchNext(data.boardId)
  })

export const toggleCheckpointFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, taskId: z.string(), checkpointId: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return toggleCheckpoint(data.boardId, data.taskId, data.checkpointId)
  })
