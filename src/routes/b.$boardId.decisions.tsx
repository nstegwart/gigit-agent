// Control-center Decisions inbox — pinned decisions envelope for CC boards.
// Owner actions wire to authenticated DecisionV3 mutators (ack/resolve/reject/snooze).
// Non-CC boards keep legacy collab DecidePanel / DecisionCard surfaces.
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { createServerFn } from '@tanstack/react-start'
import { useCallback, useMemo, useState } from 'react'
import { z } from 'zod'

import { DecidePanel } from '#/components/DecidePanel'
import { DecisionCard } from '#/components/DecisionCard'
import {
  DecisionsScreen,
  type DecisionActionError,
  type DecisionActionKind,
  type DecisionActionPayload,
} from '#/components/control-center/decisions'
import {
  buildDecisionOwnerIdempotencyKey,
} from '#/components/control-center/decisions/decisionActions'
import { boardQueryOptions, useBoard, useBoardId, useCanEdit } from '#/lib/board-query'
import {
  decisionsQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { decisionsEnvelopeToProps } from '#/lib/control-center-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'
import { csrfServerCall } from '#/lib/csrf-client'
import { uiStore } from '#/store/ui'
import { AuthError, requireAdminWrite } from '#/server/auth'
import { boardHash, createSystemClock } from '#/server/board-store'
import { getControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'
import {
  acknowledgeDecisionV3,
  DecisionV3Error,
  rejectDecisionV3,
  resolveDecisionV3,
  snoozeDecisionV3,
  type DecisionV3Deps,
} from '#/server/decisions-v3'

// ---------------------------------------------------------------------------
// Authenticated DecisionV3 owner mutations (full envelope + CSRF + admin)
// ---------------------------------------------------------------------------

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
 * Exported for route-level behavioral tests.
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

function mapDecisionMutationError(e: unknown): DecisionMutationResult {
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

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/b/$boardId/decisions')({
  validateSearch: (search) => parseControlCenterCursorSearch(search),
  loader: async ({ context, params, location }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      const search = parseControlCenterCursorSearch(location.search)
      await context.queryClient.ensureQueryData(
        decisionsQueryOptions(
          params.boardId,
          { cursor: search.cursor ?? null, pageSize: null },
          getDefaultControlCenterFetchers().decisions,
        ),
      )
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterDecisions />
  }
  return <LegacyDecisions />
}

function ControlCenterDecisions() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const qc = useQueryClient()
  const canAct = useCanEdit()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    decisionsQueryOptions(
      boardId,
      { cursor: search.cursor ?? null, pageSize: null },
      fetchers.decisions,
    ),
  )

  const [pendingDecisionId, setPendingDecisionId] = useState<string | null>(null)
  const [pendingAction, setPendingAction] = useState<DecisionActionKind | null>(null)
  const [actionErrors, setActionErrors] = useState<Record<string, DecisionActionError>>({})
  const [liveMessage, setLiveMessage] = useState<string | null>(null)

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'decisions', boardId] })
  }, [qc, boardId])

  const clearActionError = useCallback((decisionId: string) => {
    setActionErrors((prev) => {
      if (!(decisionId in prev)) return prev
      const next = { ...prev }
      delete next[decisionId]
      return next
    })
  }, [])

  const applyResult = useCallback(
    (kind: DecisionActionKind, decisionId: string, result: DecisionMutationResult) => {
      if (result.ok) {
        clearActionError(decisionId)
        setLiveMessage(`${kind} ok · ${decisionId} → ${result.status}`)
        void qc.invalidateQueries({ queryKey: ['control-center', 'decisions', boardId] })
        return
      }
      setActionErrors((prev) => ({
        ...prev,
        [decisionId]: {
          code: result.code,
          message: result.message,
          action: kind,
        },
      }))
      setLiveMessage(`${kind} failed · ${result.code}`)
    },
    [boardId, clearActionError, qc],
  )

  const pinCanonicalHash =
    typeof q.data?.canonicalHash === 'string' && q.data.canonicalHash.trim()
      ? q.data.canonicalHash.trim()
      : null

  const mutation = useMutation({
    mutationFn: async (input: {
      kind: DecisionActionKind
      payload: DecisionActionPayload
    }): Promise<{ kind: DecisionActionKind; decisionId: string; result: DecisionMutationResult }> => {
      const { kind, payload } = input
      setPendingDecisionId(payload.decisionId)
      setPendingAction(kind)
      clearActionError(payload.decisionId)

      // Full envelope: entityExpectedRev + boardRev + pin hash + stable 24h key.
      const canonicalHash =
        (payload.canonicalHash && payload.canonicalHash.trim()) || pinCanonicalHash || ''
      const idempotencyKey =
        (payload.idempotencyKey && payload.idempotencyKey.trim()) ||
        (canonicalHash
          ? buildDecisionOwnerIdempotencyKey({
              action: kind,
              boardId: payload.boardId,
              decisionId: payload.decisionId,
              expectedRev: payload.expectedRev,
              expectedBoardRev: payload.expectedBoardRev,
              canonicalHash,
              selectedOptionId: payload.selectedOptionId,
              snoozedUntil: payload.snoozedUntil,
            })
          : '')

      const baseWire = {
        boardId: payload.boardId,
        decisionId: payload.decisionId,
        expectedRev: payload.expectedRev,
        expectedBoardRev: payload.expectedBoardRev,
        ...(canonicalHash ? { canonicalHash } : {}),
        ...(idempotencyKey ? { idempotencyKey } : {}),
      }

      let result: DecisionMutationResult
      if (kind === 'acknowledge') {
        result = await csrfServerCall(acknowledgeDecisionOwnerFn, baseWire)
      } else if (kind === 'resolve') {
        if (!payload.selectedOptionId) {
          result = {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'selectedOptionId required for resolve',
          }
        } else {
          result = await csrfServerCall(resolveDecisionOwnerFn, {
            ...baseWire,
            selectedOptionId: payload.selectedOptionId,
            comment: payload.comment ?? null,
          })
        }
      } else if (kind === 'reject') {
        result = await csrfServerCall(rejectDecisionOwnerFn, {
          ...baseWire,
          comment: payload.comment ?? null,
        })
      } else {
        if (!payload.snoozedUntil) {
          result = {
            ok: false,
            code: 'INVALID_INPUT',
            message: 'snoozedUntil required for snooze',
          }
        } else {
          result = await csrfServerCall(snoozeDecisionOwnerFn, {
            ...baseWire,
            snoozedUntil: payload.snoozedUntil,
          })
        }
      }
      return { kind, decisionId: payload.decisionId, result }
    },
    onSuccess: ({ kind, decisionId, result }) => {
      applyResult(kind, decisionId, result)
    },
    onError: (err, vars) => {
      setActionErrors((prev) => ({
        ...prev,
        [vars.payload.decisionId]: {
          code: 'TRANSPORT_ERROR',
          message: err instanceof Error ? err.message : String(err),
          action: vars.kind,
        },
      }))
      setLiveMessage(`${vars.kind} transport error`)
    },
    onSettled: () => {
      setPendingDecisionId(null)
      setPendingAction(null)
    },
  })

  const actions = useMemo(
    () => ({
      onAcknowledge: async (payload: DecisionActionPayload) => {
        await mutation.mutateAsync({ kind: 'acknowledge', payload })
      },
      onResolve: async (payload: DecisionActionPayload) => {
        await mutation.mutateAsync({ kind: 'resolve', payload })
      },
      onReject: async (payload: DecisionActionPayload) => {
        await mutation.mutateAsync({ kind: 'reject', payload })
      },
      onSnooze: async (payload: DecisionActionPayload) => {
        await mutation.mutateAsync({ kind: 'snooze', payload })
      },
    }),
    [mutation],
  )

  const props = decisionsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
  })

  let surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState
  if (q.isError && !q.data) {
    surfaceState = 'error'
  }

  return (
    <div className="wrap" data-testid="control-center-decisions-route">
      <DecisionsScreen
        {...props}
        surfaceState={surfaceState}
        canAct={canAct}
        pendingDecisionId={pendingDecisionId}
        pendingAction={pendingAction}
        actionErrors={actionErrors}
        actions={canAct ? actions : undefined}
        liveMessage={liveMessage ?? props.liveMessage}
      />
    </div>
  )
}

function LegacyDecisions() {
  const m = useBoard()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  const matches = (d: { id: string; teks: string; keputusan?: string }) =>
    !q || `${d.id} ${d.teks} ${d.keputusan ?? ''}`.toLowerCase().includes(q)

  const open = m.openDecisions.filter(matches)
  const openIds = new Set(open.map((d) => d.id))
  const decided = m.decisions.filter((d) => !openIds.has(d.id) && matches(d))

  return (
    <>
      <section className="section">
        <div className="sec-head">
          <h2>Open — waiting on you</h2>
          <span className="count">{open.length}</span>
          <span className="desc">owner calls that unblock the work</span>
        </div>
        {open.length === 0 ? (
          <p className="desc">Nothing waiting on you right now.</p>
        ) : (
          open.map((d) => <DecidePanel key={d.id} decision={d} />)
        )}
      </section>

      <section className="section">
        <div className="sec-head">
          <h2>Decided</h2>
          <span className="count">{decided.length}</span>
        </div>
        {decided.map((d) => (
          <DecisionCard key={d.id} decision={d} />
        ))}
      </section>
    </>
  )
}
