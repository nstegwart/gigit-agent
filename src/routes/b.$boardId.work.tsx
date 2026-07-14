// Work layout — list at index, ART task detail at $taskId.
import { Outlet, createFileRoute } from '@tanstack/react-router'

import { boardQueryOptions } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId/work')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: WorkLayout,
})

function WorkLayout() {
  return <Outlet />
}
