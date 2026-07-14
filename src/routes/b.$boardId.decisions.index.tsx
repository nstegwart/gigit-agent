// Control-center Decisions inbox — pinned decisions envelope for CC boards.
// Owner actions wire to authenticated DecisionV3 mutators (ack/resolve/reject/snooze).
// Non-CC boards keep legacy collab DecidePanel / DecisionCard surfaces.
//
// Client/server boundary: mutators live in #/server/decisions-owner-fns (createServerFn
// only). This route imports serializable handles only — never board-store/db runtime.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo, useState } from 'react'

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
import {
  acknowledgeDecisionOwnerFn,
  rejectDecisionOwnerFn,
  resolveDecisionOwnerFn,
  snoozeDecisionOwnerFn,
  type DecisionMutationResult,
} from '#/server/decisions-owner-fns'

// ---------------------------------------------------------------------------
// Route
// ---------------------------------------------------------------------------

export const Route = createFileRoute('/b/$boardId/decisions/')({
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
  const navigate = useNavigate({ from: '/b/$boardId/decisions' })
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

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (!next) return
    void navigate({
      search: (prev) => ({ ...prev, cursor: next }),
      replace: true,
    })
  }, [navigate, q.data?.nextCursor])

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
      {props.nextCursor ? (
        <div
          className="sec-head"
          style={{ marginTop: 12, gap: 8, alignItems: 'center' }}
          data-testid="decisions-next-page-bar"
        >
          <span className="desc">More pages available (server cursor)</span>
          <button
            type="button"
            className="btn"
            onClick={onNextPage}
            data-testid="decisions-next-page"
          >
            Next page
          </button>
        </div>
      ) : null}
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
