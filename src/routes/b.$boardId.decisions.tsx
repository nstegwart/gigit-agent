// Decisions layout — inbox at index, ART decision detail at $decisionId.
// Re-exports owner mutation helpers from server-fn module (not route body).
// Canon-v3: control-center boards demote to /alur before decisions loaders run.
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { boardQueryOptions } from '#/lib/board-query'
import { isControlCenterBoard } from '#/lib/control-center-query'

export const Route = createFileRoute('/b/$boardId/decisions')({
  beforeLoad: ({ params }) => {
    if (isControlCenterBoard(params.boardId)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: params.boardId },
        replace: true,
      })
    }
  },
  loader: async ({ context, params }) => {
    // Control-center boards never reach here (beforeLoad → /alur).
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
