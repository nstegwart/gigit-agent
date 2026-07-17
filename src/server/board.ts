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
import type { RawBoard, RawFeature, RawProject, Run } from '#/lib/types'
import { computeRollup, readLifecycle, writeLifecycle } from './lifecycle-store'
import { taskLifecycle } from './tasks-store'
import { currentUser, requireAdminWrite, requireView } from './auth'
import {
  projectDispatchNextFields,
  resolveSharedDispatchNext,
  selectNextFromActivePlan,
} from './control-plane-ingest'
import { peekControlPlaneRuntimeContext } from './control-plane-runtime-context'

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

/**
 * W-PERF-1: shell/meta board projection for layout + control-center nav.
 * Same RawBoard keys as full readBoard — strips checklist bodies, design/collab/
 * conventions overlays, and caps runs. Non-breaking shape for buildModel / shell
 * crumbs; pages that need full checklists/design/collab must use mode:'full'
 * (default) or keep calling getBoardFn without mode.
 *
 * Residual: boardQueryOptions / route loaders still default to full until the UI
 * package opts into mode:'shell' for CC overview/work/agents.
 */
export function toBoardShell(raw: RawBoard): RawBoard {
  const projects: Array<RawProject> = (raw.projects ?? []).map((p) => ({
    ...p,
    // Keep identity + tracks for breadcrumb / project grouping; drop free-form bulk.
  }))
  const features: Array<RawFeature> = (raw.features ?? []).map((f) => {
    const { checklist: _checklist, ...rest } = f as RawFeature & {
      checklist?: unknown
    }
    return {
      ...rest,
      // Empty checklist keeps taskTotal/taskDone at 0 in buildModel — shell only.
      checklist: [],
    }
  })
  // Cap runs for shell badge/model; full history stays on full board / agents envelope.
  const runs: Array<Run> = (raw.runs ?? [])
    .filter((r) => r.status === 'running' || r.status === 'blocked' || r.status === 'queued')
    .slice(0, 50)
  return {
    fase_label: raw.fase_label,
    fase_persen: raw.fase_persen,
    projects,
    features,
    decisions: raw.decisions ?? [],
    log: raw.log ?? [],
    queue: raw.queue,
    runs,
    docs: raw.docs,
    updated: raw.updated,
    // Heavy overlays omitted (undefined) — buildModel treats as empty.
  }
}

export const getBoardFn = createServerFn({ method: 'GET' })
  .validator(
    z.object({
      boardId: board,
      /** 'full' (default) = legacy complete RawBoard; 'shell' = narrow transport. */
      mode: z.enum(['full', 'shell']).optional(),
    }),
  )
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    const raw = await readBoard(data.boardId)
    if (data.mode === 'shell') return toBoardShell(raw)
    return raw
  })

/** Explicit shell board fetch (same as getBoardFn mode:'shell'). */
export const getBoardShellFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    return toBoardShell(await readBoard(data.boardId))
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
    return upsertRun(boardId, run)
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

/**
 * HTTP advance input — product path is always Lifecycle V3 (same as MCP advanceTaskProduct).
 * Envelope fields (entity/board revs, canonical hash, idempotencyKey) are required at the
 * product layer via parseMutationEnvelope (no silent rev defaults).
 */
export const advanceTaskHttpInputSchema = z.object({
  boardId: board,
  taskId: z.string().min(1),
  toStage: z.string().min(1),
  byRunId: z.string().optional(),
  role: z.string().optional(),
  evidence: z.record(z.string(), z.any()).optional(),
  verdict: z.string().optional(),
  commitSha: z.string().optional(),
  deployReceipt: z.string().optional(),
  blocker: z.string().optional(),
  /** Legacy alias for entityExpectedRev (parseMutationEnvelope). */
  expectedRev: z.number().int().optional(),
  entityExpectedRev: z.number().int().optional(),
  expectedEntityRev: z.number().int().optional(),
  expectedBoardRev: z.number().int().optional(),
  expectedLifecycleRev: z.number().int().optional(),
  expectedTaskHash: z.string().optional(),
  canonicalHash: z.string().optional(),
  subjectHash: z.string().optional(),
  idempotencyKey: z.string().optional(),
  receipt: z.record(z.string(), z.any()).optional(),
  productionApprovalId: z.string().optional(),
  authorRunId: z.string().optional(),
  verifierRunId: z.string().optional(),
  requireOppositeModel: z.boolean().optional(),
})

export type AdvanceTaskHttpInput = z.infer<typeof advanceTaskHttpInputSchema>

/**
 * Product HTTP advance: ordered nine-stage V3 rail via advanceTaskProduct.
 * Maps taskId → MCP `id`. Does not call legacy advanceTask.
 * Auth/CSRF stay on the createServerFn boundary (requireAdminWrite + csrfServerCall).
 * Dynamic import of board-mcp keeps MCP product graph off the client board-query chunk.
 */
export async function advanceTaskHttp(data: AdvanceTaskHttpInput) {
  const { advanceTaskProduct, parseMutationEnvelope } = await import('./board-mcp')
  const args: Record<string, unknown> = {
    id: data.taskId,
    toStage: data.toStage,
    byRunId: data.byRunId,
    role: data.role,
    evidence: data.evidence,
    verdict: data.verdict,
    commitSha: data.commitSha,
    deployReceipt: data.deployReceipt,
    blocker: data.blocker,
    expectedRev: data.expectedRev,
    entityExpectedRev: data.entityExpectedRev,
    expectedEntityRev: data.expectedEntityRev,
    expectedBoardRev: data.expectedBoardRev,
    expectedLifecycleRev: data.expectedLifecycleRev,
    expectedTaskHash: data.expectedTaskHash,
    canonicalHash: data.canonicalHash,
    subjectHash: data.subjectHash,
    idempotencyKey: data.idempotencyKey,
    receipt: data.receipt,
    productionApprovalId: data.productionApprovalId,
    authorRunId: data.authorRunId,
    verifierRunId: data.verifierRunId,
    requireOppositeModel: data.requireOppositeModel,
  }
  for (const key of Object.keys(args)) {
    if (args[key] === undefined) delete args[key]
  }
  const envelope = parseMutationEnvelope(args)
  return advanceTaskProduct(data.boardId, args, envelope)
}

/**
 * Server-fn serializable advance result (receipt.fields must not be `unknown`
 * for TanStack Start ValidateSerializableMapped).
 */
export type AdvanceTaskHttpSerializableResult = {
  ok: true
  taskId: string
  fromStage: string | null
  stage: string
  rev: number
  implementer: string | null
  boardRev: number
  lifecycleRev: number
  entityRev: number
  taskHash: string
  canonicalHash: string
  canonicalSnapshotId: string
  receipt: {
    receiptId: string
    programmatic: boolean
    taskHash: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    fields: Record<string, string | number | boolean | null>
    authorRunId: string | null
    verifierRunId: string | null
    verdict: string | null
    issuedAt: string
    receiptHash: string
  }
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    taskHash: string
    boardRev: number
    lifecycleRev: number
  }
  readback: {
    taskId: string
    stage: string
    canonicalSnapshotId: string
    canonicalHash: string
    taskHash: string
    boardRev: number
    lifecycleRev: number
    entityRev: number
    stageReceiptIds: Array<string>
  }
  engine: 'advanceTaskV3'
}

function toSerializableAdvanceResult(
  result: Awaited<ReturnType<typeof advanceTaskHttp>>,
): AdvanceTaskHttpSerializableResult {
  // Round-trip strips non-JSON values and satisfies server-fn serializability.
  return JSON.parse(JSON.stringify(result)) as AdvanceTaskHttpSerializableResult
}

export const advanceTaskFn = createServerFn({ method: 'POST' })
  .validator(advanceTaskHttpInputSchema)
  .handler(async ({ data }): Promise<AdvanceTaskHttpSerializableResult> => {
    await requireAdminWrite()
    return toSerializableAdvanceResult(await advanceTaskHttp(data))
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
 * Prefer durable control-plane runtime context plans (same authority as MCP publish)
 * when context is installed; otherwise fall back to process shared plan store.
 * Returns empty selection when no active plan / expired / superseded.
 */
/** Adaptive mapping version + live progress (addendum B) — read-only, pin-derived. */
export const getAdaptiveMappingVersionFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    const { loadBoardAdaptiveMappingSurface } = await import('#/server/mapping-version-loader')
    return loadBoardAdaptiveMappingSurface(data.boardId)
  })

export const getNextFn = createServerFn({ method: 'GET' })
  .validator(z.object({ boardId: board }))
  .handler(async ({ data }) => {
    await requireView(data.boardId)
    const ctx = peekControlPlaneRuntimeContext()
    if (ctx) {
      const selected = await selectNextFromActivePlan(
        { clock: ctx.clock, plans: ctx.runtime.plans },
        data.boardId,
      )
      const projected = projectDispatchNextFields(selected)
      return {
        boardId: data.boardId,
        ...projected,
        generatedAt: ctx.clock.nowISO(),
      }
    }
    return resolveSharedDispatchNext(data.boardId)
  })

export const toggleCheckpointFn = createServerFn({ method: 'POST' })
  .validator(z.object({ boardId: board, taskId: z.string(), checkpointId: z.string() }))
  .handler(async ({ data }) => {
    await requireAdminWrite()
    return toggleCheckpoint(data.boardId, data.taskId, data.checkpointId)
  })
