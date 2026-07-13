/**
 * C3-W1: Authenticated server functions for control-center surfaces.
 * One load → one pin → surface projection. Client never recomputes truth.
 * Returns JSON-serializable wire envelopes (TanStack Start server-fn constraint).
 */

import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { requireView, AuthError } from '#/server/auth'
import { loadControlCenterAggregation } from '#/server/control-center-ui-adapter'
import {
  envelopeError,
  envelopeForbidden,
  projectAgents,
  projectDecisions,
  projectEvidence,
  projectFeatures,
  projectOps,
  projectOverview,
  projectPriority,
  projectProjects,
  projectWork,
  type ControlCenterSurface,
  type PinnedEnvelope,
  type UiSurfaceState,
} from '#/server/control-center-ui'
import type { PrimaryBucket, StaleOverlayKind } from '#/lib/control-plane-types'
import type { Json } from '#/lib/types'

const board = z.string().min(1)
const cursorSchema = z.string().nullable().optional()
const pageSizeSchema = z.number().int().min(1).max(200).nullable().optional()

const PRIMARY_BUCKETS = [
  'DONE',
  'RECONCILIATION_PENDING',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const

const workArgs = z.object({
  boardId: board,
  bucket: z.enum(PRIMARY_BUCKETS).nullable().optional(),
  overlay: z.string().nullable().optional(),
  staleFamily: z.boolean().nullable().optional(),
  cursor: cursorSchema,
  pageSize: pageSizeSchema,
})

const cursorArgs = z.object({
  boardId: board,
  cursor: cursorSchema,
  pageSize: pageSizeSchema,
})

const boardArgs = z.object({ boardId: board })

/**
 * Wire shape for server-fn transport.
 * Drops non-serializable `error.details` (`unknown` index signature fails Start ValidateSerializable).
 * Client query types still accept this as PinnedEnvelope structurally for data fields.
 */
export type ControlCenterWireEnvelope = {
  schemaVersion: 'TM_PINNED_ENVELOPE_V1'
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
  /** JSON-serializable surface payload (Start ValidateSerializable). */
  data: Json
  nextCursor: string | null
  surfaceState: UiSurfaceState
  surface: ControlCenterSurface | 'common' | null
  error: { code: string; message: string } | null
}

function toWireEnvelope(env: PinnedEnvelope<unknown>): ControlCenterWireEnvelope {
  // Round-trip guarantees JSON-serializable data for Start server-fn transport.
  const data = JSON.parse(JSON.stringify(env.data ?? null)) as Json
  return {
    schemaVersion: env.schemaVersion,
    boardId: env.boardId,
    canonicalSnapshotId: env.canonicalSnapshotId,
    canonicalHash: env.canonicalHash,
    boardRev: env.boardRev,
    lifecycleRev: env.lifecycleRev,
    generatedAt: env.generatedAt,
    freshnessAgeSeconds: env.freshnessAgeSeconds,
    stale: env.stale,
    staleReason: env.staleReason,
    data,
    nextCursor: env.nextCursor,
    surfaceState: env.surfaceState,
    surface: env.surface,
    error: env.error
      ? { code: env.error.code, message: env.error.message }
      : null,
  }
}

function mapAuthError(e: unknown, surface: ControlCenterSurface): ControlCenterWireEnvelope {
  if (e instanceof AuthError) {
    if (e.status === 401 || e.status === 403) {
      return toWireEnvelope(envelopeForbidden(null, surface))
    }
  }
  const message = e instanceof Error ? e.message : String(e)
  return toWireEnvelope(envelopeError(null, 'DATA_INTEGRITY', message, surface))
}

async function withBoardAgg(
  boardId: string,
  surface: ControlCenterSurface,
  project: (agg: Awaited<ReturnType<typeof loadControlCenterAggregation>>) => PinnedEnvelope<unknown>,
): Promise<ControlCenterWireEnvelope> {
  try {
    await requireView(boardId)
    const agg = await loadControlCenterAggregation(boardId)
    return toWireEnvelope(project(agg))
  } catch (e) {
    return mapAuthError(e, surface)
  }
}

export const getControlCenterOverviewFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'overview', (agg) => projectOverview(agg))
  })

export const getControlCenterWorkFn = createServerFn({ method: 'GET' })
  .validator(workArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'work', (agg) =>
      projectWork(agg, {
        bucket: (data.bucket as PrimaryBucket | null | undefined) ?? null,
        overlay: (data.overlay as StaleOverlayKind | null | undefined) ?? null,
        staleFamily: data.staleFamily ?? null,
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterPriorityFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'priority', (agg) => projectPriority(agg))
  })

export const getControlCenterProjectsFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'projects', (agg) => projectProjects(agg))
  })

export const getControlCenterFeaturesFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'features', (agg) =>
      projectFeatures(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterAgentsFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'agents', (agg) =>
      projectAgents(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterOpsFn = createServerFn({ method: 'GET' })
  .validator(boardArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'ops', (agg) => projectOps(agg))
  })

export const getControlCenterDecisionsFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'decisions', (agg) =>
      projectDecisions(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })

export const getControlCenterEvidenceFn = createServerFn({ method: 'GET' })
  .validator(cursorArgs)
  .handler(async ({ data }): Promise<ControlCenterWireEnvelope> => {
    return withBoardAgg(data.boardId, 'evidence', (agg) =>
      projectEvidence(agg, {
        cursor: data.cursor ?? null,
        pageSize: data.pageSize ?? null,
      }),
    )
  })
