// Board scope layout: /b/$boardId/* — ensures the board's data, wraps children in AppShell.
import { Outlet, createFileRoute, notFound, redirect } from '@tanstack/react-router'

import { AppShell } from '#/components/AppShell'
import { boardQueryOptions, boardsQueryOptions } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId')({
  beforeLoad: ({ context }) => {
    if (!context.me) throw redirect({ to: '/login' })
  },
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
