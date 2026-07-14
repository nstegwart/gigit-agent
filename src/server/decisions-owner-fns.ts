/**
 * DecisionV3 owner mutators — createServerFn handles ONLY (board.ts / auth-fns pattern).
 *
 * Client routes import ONLY these serializable server-fn handles (and types).
 * All board-store / control-plane / decisions-v3 usage is confined to handler bodies
 * via decisions-owner-runtime so the client transform can strip server deps.
 *
 * Do NOT re-export decisionDeps / prepareDecisionOwnerEnvelope from this file or from
 * route modules — that re-introduces mysql2 + safer-buffer into the browser graph.
 */
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import { requireAdminWrite } from '#/server/auth'
import {
  acknowledgeDecisionV3,
  rejectDecisionV3,
  resolveDecisionV3,
  snoozeDecisionV3,
} from '#/server/decisions-v3'
import {
  decisionDeps,
  mapDecisionMutationError,
  prepareDecisionOwnerEnvelope,
  type DecisionMutationResult,
} from '#/server/decisions-owner-runtime'

export type { DecisionMutationResult } from '#/server/decisions-owner-runtime'

const decisionMutationBase = z.object({
  boardId: z.string().min(1),
  decisionId: z.string().min(1),
  /** CAS on decision.entityRev (entityExpectedRev). */
  expectedRev: z.number().int(),
  expectedBoardRev: z.number().int(),
  /** Client pin hash; server compares to current pin. Optional if route injects. */
  canonicalHash: z.string().min(1).optional(),
  /** 24h stable key; server emits when absent. */
  idempotencyKey: z.string().min(1).max(191).optional(),
})

export const acknowledgeDecisionOwnerFn = createServerFn({ method: 'POST' })
  .validator(decisionMutationBase)
  .handler(async ({ data }): Promise<DecisionMutationResult> => {
    try {
      const actor = await requireAdminWrite()
      const env = await prepareDecisionOwnerEnvelope({
        action: 'acknowledge',
        boardId: data.boardId,
        decisionId: data.decisionId,
        expectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: data.canonicalHash,
        idempotencyKey: data.idempotencyKey,
      })
      const rec = await acknowledgeDecisionV3(decisionDeps(), {
        boardId: data.boardId,
        decisionId: data.decisionId,
        actorId: actor.id,
        expectedRev: data.expectedRev,
        entityExpectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: env.canonicalHash,
        currentPinHash: env.currentPinHash,
        idempotencyKey: env.idempotencyKey,
      })
      return {
        ok: true,
        decisionId: rec.decisionId,
        status: rec.status,
        entityRev: rec.entityRev,
        boardRev: rec.boardRev,
        idempotencyKey: env.idempotencyKey,
      }
    } catch (e) {
      return mapDecisionMutationError(e)
    }
  })

export const resolveDecisionOwnerFn = createServerFn({ method: 'POST' })
  .validator(
    decisionMutationBase.extend({
      selectedOptionId: z.string().min(1),
      comment: z.string().nullable().optional(),
    }),
  )
  .handler(async ({ data }): Promise<DecisionMutationResult> => {
    try {
      const actor = await requireAdminWrite()
      const env = await prepareDecisionOwnerEnvelope({
        action: 'resolve',
        boardId: data.boardId,
        decisionId: data.decisionId,
        expectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: data.canonicalHash,
        idempotencyKey: data.idempotencyKey,
        selectedOptionId: data.selectedOptionId,
      })
      const rec = await resolveDecisionV3(decisionDeps(), {
        boardId: data.boardId,
        decisionId: data.decisionId,
        actorId: actor.id,
        selectedOptionId: data.selectedOptionId,
        comment: data.comment ?? null,
        expectedRev: data.expectedRev,
        entityExpectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: env.canonicalHash,
        currentPinHash: env.currentPinHash,
        idempotencyKey: env.idempotencyKey,
      })
      return {
        ok: true,
        decisionId: rec.decisionId,
        status: rec.status,
        entityRev: rec.entityRev,
        boardRev: rec.boardRev,
        selectedOptionId: rec.selectedOptionId,
        idempotencyKey: env.idempotencyKey,
      }
    } catch (e) {
      return mapDecisionMutationError(e)
    }
  })

export const rejectDecisionOwnerFn = createServerFn({ method: 'POST' })
  .validator(
    decisionMutationBase.extend({
      comment: z.string().nullable().optional(),
    }),
  )
  .handler(async ({ data }): Promise<DecisionMutationResult> => {
    try {
      const actor = await requireAdminWrite()
      const env = await prepareDecisionOwnerEnvelope({
        action: 'reject',
        boardId: data.boardId,
        decisionId: data.decisionId,
        expectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: data.canonicalHash,
        idempotencyKey: data.idempotencyKey,
      })
      const rec = await rejectDecisionV3(decisionDeps(), {
        boardId: data.boardId,
        decisionId: data.decisionId,
        actorId: actor.id,
        comment: data.comment ?? null,
        expectedRev: data.expectedRev,
        entityExpectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: env.canonicalHash,
        currentPinHash: env.currentPinHash,
        idempotencyKey: env.idempotencyKey,
      })
      return {
        ok: true,
        decisionId: rec.decisionId,
        status: rec.status,
        entityRev: rec.entityRev,
        boardRev: rec.boardRev,
        idempotencyKey: env.idempotencyKey,
      }
    } catch (e) {
      return mapDecisionMutationError(e)
    }
  })

export const snoozeDecisionOwnerFn = createServerFn({ method: 'POST' })
  .validator(
    decisionMutationBase.extend({
      snoozedUntil: z.string().min(1),
    }),
  )
  .handler(async ({ data }): Promise<DecisionMutationResult> => {
    try {
      const actor = await requireAdminWrite()
      const env = await prepareDecisionOwnerEnvelope({
        action: 'snooze',
        boardId: data.boardId,
        decisionId: data.decisionId,
        expectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: data.canonicalHash,
        idempotencyKey: data.idempotencyKey,
        snoozedUntil: data.snoozedUntil,
      })
      const rec = await snoozeDecisionV3(decisionDeps(), {
        boardId: data.boardId,
        decisionId: data.decisionId,
        actorId: actor.id,
        snoozedUntil: data.snoozedUntil,
        expectedRev: data.expectedRev,
        entityExpectedRev: data.expectedRev,
        expectedBoardRev: data.expectedBoardRev,
        canonicalHash: env.canonicalHash,
        currentPinHash: env.currentPinHash,
        idempotencyKey: env.idempotencyKey,
      })
      return {
        ok: true,
        decisionId: rec.decisionId,
        status: rec.status,
        entityRev: rec.entityRev,
        boardRev: rec.boardRev,
        snoozedUntil: rec.snoozedUntil,
        idempotencyKey: env.idempotencyKey,
      }
    } catch (e) {
      return mapDecisionMutationError(e)
    }
  })
