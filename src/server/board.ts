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
  readTasks,
  setBlocked,
  setFeaturePhase,
  setRunStatus,
  toggleCheckpoint,
  toggleTask,
  upsertRun,
} from './board-store'

const board = z.string().min(1)

// ---- boards ----
export const listBoardsFn = createServerFn({ method: 'GET' }).handler(async () => listBoards())

export const createBoardFn = createServerFn({ method: 'POST' })
  .validator(z.object({ id: z.string(), name: z.string().min(1), description: z.string().optional() }))
  .handler(async ({ data }) => createBoard(data.id, data.name, data.description))

// ---- board data ----
export const getBoardFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => readBoard(data.boardId))

export const toggleTaskFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), index: z.number().int(), done: z.boolean().optional() }))
  .handler(async ({ data }) => toggleTask(data.boardId, data.featureId, data.index, data.done))

export const setFeaturePhaseFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), fase: z.string() }))
  .handler(async ({ data }) => setFeaturePhase(data.boardId, data.featureId, data.fase))

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
    const { boardId, ...run } = data
    return upsertRun(boardId, run as never)
  })

export const setRunStatusFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) }))
  .handler(async ({ data }) => setRunStatus(data.boardId, data.id, data.status))

// ---- design links ----
export const addDesignLinkFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, scope: z.enum(['project', 'feature']), id: z.string(), label: z.string().optional(), url: z.string() }))
  .handler(async ({ data }) => addDesignLink(data.boardId, data.scope, data.id, { label: data.label, url: data.url }))

// ---- collaboration ----
export const addCommentFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), author: z.string(), authorType: z.enum(['human', 'agent']).default('human'), text: z.string().min(1) }))
  .handler(async ({ data }) => addComment(data.boardId, data.featureId, data.author, data.authorType, data.text))

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
  .handler(async ({ data }) => openDecision(data.boardId, data.featureId, data.question, data.options, data.openedBy))

export const decideDecisionFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, id: z.string(), answer: z.string(), keputusan: z.string().optional(), decidedBy: z.string().optional() }))
  .handler(async ({ data }) => decideDecision(data.boardId, data.id, data.answer, data.keputusan, data.decidedBy))

export const setBlockedFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string(), reason: z.string() }))
  .handler(async ({ data }) => setBlocked(data.boardId, data.featureId, data.reason))

export const clearBlockedFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, featureId: z.string() }))
  .handler(async ({ data }) => clearBlocked(data.boardId, data.featureId))

// ---- adaptive views: tasks / ops / prod / guide ----
export const getTasksFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => readTasks(data.boardId))

export const getOpsFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => readOps(data.boardId))

export const getProdFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => readProd(data.boardId))

export const getGuideFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => readGuide(data.boardId))

export const toggleCheckpointFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, taskId: z.string(), checkpointId: z.string() }))
  .handler(async ({ data }) => toggleCheckpoint(data.boardId, data.taskId, data.checkpointId))
