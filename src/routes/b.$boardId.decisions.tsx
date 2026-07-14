// Decisions layout — inbox at index, ART decision detail at $decisionId.
// Re-exports owner mutation helpers from server-fn module (not route body).
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

// Do not re-export createServerFn handles from this layout — re-exports pull the
// server-fn module into the shared client index graph and can retain server deps.
// Consumers import from #/server/decisions-owner-fns (handles) or
// #/server/decisions-owner-runtime (helpers, server/tests only).
