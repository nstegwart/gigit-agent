// Decisions layout — inbox at index, ART decision detail at $decisionId.
// Re-exports owner mutation helpers from index for stable import path.
import { Outlet, createFileRoute } from '@tanstack/react-router'

import { boardQueryOptions } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId/decisions')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: DecisionsLayout,
})

function DecisionsLayout() {
  return <Outlet />
}

export {
  decisionDeps,
  resolveCurrentDecisionPinHash,
  prepareDecisionOwnerEnvelope,
  acknowledgeDecisionOwnerFn,
  resolveDecisionOwnerFn,
  rejectDecisionOwnerFn,
  snoozeDecisionOwnerFn,
} from '#/routes/b.$boardId.decisions.index'
export type { DecisionMutationResult } from '#/routes/b.$boardId.decisions.index'
