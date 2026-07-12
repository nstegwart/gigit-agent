// Board scope layout: /b/$boardId/* — ensures the board's data, wraps children in AppShell.
import { Outlet, createFileRoute, notFound } from '@tanstack/react-router'

import { AppShell } from '#/components/AppShell'
import { boardQueryOptions, boardsQueryOptions } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardsQueryOptions())
    try {
      await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    } catch {
      throw notFound()
    }
  },
  component: BoardLayout,
})

function BoardLayout() {
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
