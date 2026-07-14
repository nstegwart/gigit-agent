/**
 * DecisionV3 owner mutation runtime helpers (server-only).
 *
 * Imported only by createServerFn handlers in decisions-owner-fns.ts and by unit tests.
 * Never import this module from routes/components/lib — it pulls control-plane + board-store.
 */
import {
  buildDecisionOwnerIdempotencyKey,
} from '#/components/control-center/decisions/decisionActions'
import type { DecisionActionKind } from '#/components/control-center/decisions'
import { AuthError } from '#/server/auth'
import { boardHash, createSystemClock } from '#/server/board-store'
import { getControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'
import {
  DecisionV3Error,
  type DecisionV3Deps,
} from '#/server/decisions-v3'

export type DecisionMutationResult =
  | {
      ok: true
      decisionId: string
      status: string
      entityRev: number
      boardRev: number
      selectedOptionId?: string | null
      snoozedUntil?: string | null
      /** Echo of the stable key used (replay-safe). */
      idempotencyKey?: string
    }
  | { ok: false; code: string; message: string }

/** Runtime DecisionV3 deps including shared 24h idempotency authority. */
export function decisionDeps(): DecisionV3Deps {
  const ctx = getControlPlaneRuntimeContext()
  return {
    clock: createSystemClock(),
    decisions: ctx.controlData.decisions,
    atomic: ctx.atomic,
    idempotency: ctx.idempotency,
  }
}

/**
 * Resolve current pin/canonical hash for the board (server truth).
 * Prefer durable import pin; fall back to live board content hash.
 */
export async function resolveCurrentDecisionPinHash(boardId: string): Promise<string> {
  const ctx = getControlPlaneRuntimeContext()
  try {
    const importState = await ctx.controlData.imports.getBoardState(boardId)
    if (importState) {
      const h =
        (importState.canonicalHash && String(importState.canonicalHash).trim()) ||
        (importState.subjectHash && String(importState.subjectHash).trim()) ||
        null
      if (h) return h
    }
  } catch {
    /* fall through to live boardHash */
  }
  return boardHash(boardId)
}

/**
 * Prepare full owner mutation envelope: pin CAS + unique stable 24h idempotency key.
 */
export async function prepareDecisionOwnerEnvelope(input: {
  action: DecisionActionKind
  boardId: string
  decisionId: string
  expectedRev: number
  expectedBoardRev: number
  canonicalHash?: string | null
  idempotencyKey?: string | null
  selectedOptionId?: string | null
  snoozedUntil?: string | null
}): Promise<{
  canonicalHash: string
  currentPinHash: string
  idempotencyKey: string
}> {
  const currentPinHash = await resolveCurrentDecisionPinHash(input.boardId)
  const clientHash =
    input.canonicalHash && String(input.canonicalHash).trim()
      ? String(input.canonicalHash).trim()
      : null
  // When client omits hash, bind to current pin (server is source of truth for pin).
  const canonicalHash = clientHash ?? currentPinHash
  const idempotencyKey =
    input.idempotencyKey && String(input.idempotencyKey).trim()
      ? String(input.idempotencyKey).trim()
      : buildDecisionOwnerIdempotencyKey({
          action: input.action,
          boardId: input.boardId,
          decisionId: input.decisionId,
          expectedRev: input.expectedRev,
          expectedBoardRev: input.expectedBoardRev,
          canonicalHash,
          selectedOptionId: input.selectedOptionId,
          snoozedUntil: input.snoozedUntil,
        })
  return { canonicalHash, currentPinHash, idempotencyKey }
}

export function mapDecisionMutationError(e: unknown): DecisionMutationResult {
  if (e instanceof AuthError) {
    return {
      ok: false,
      code: e.status === 401 || e.status === 403 ? 'FORBIDDEN' : e.code || 'AUTH_ERROR',
      message: e.message,
    }
  }
  if (e instanceof DecisionV3Error) {
    return { ok: false, code: e.code, message: e.message }
  }
  if (e && typeof e === 'object' && 'code' in e && 'message' in e) {
    const err = e as { code: unknown; message: unknown }
    return {
      ok: false,
      code: String(err.code ?? 'UNKNOWN'),
      message: String(err.message ?? 'Decision mutation failed'),
    }
  }
  return {
    ok: false,
    code: 'UNKNOWN',
    message: e instanceof Error ? e.message : String(e),
  }
}
