// Work layout — list at index, ART task detail at $taskId.
// Canon-v3: control-center boards demote to /alur before work loaders run.
import { Outlet, createFileRoute, redirect } from '@tanstack/react-router'

import { boardQueryOptions } from '#/lib/board-query'
import { isControlCenterBoard } from '#/lib/control-center-query'

export const Route = createFileRoute('/b/$boardId/work')({
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
  component: WorkLayout,
})

function WorkLayout() {
  return <Outlet />
}
