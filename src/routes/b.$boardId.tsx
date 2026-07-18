// Board scope layout: /b/$boardId/* — ensures the board's data.
// Classic / non-alur children wrap in AppShell; Alur is shell-less full-viewport primary.
import { Outlet, createFileRoute, notFound, redirect, useRouterState } from '@tanstack/react-router'

import { AppShell } from '#/components/AppShell'
import { boardQueryOptions, boardsQueryOptions } from '#/lib/board-query'

/**
 * True when the pathname is the board Alur canvas (`/b/$boardId/alur`).
 * Used to isolate primary flow chrome from AppShell sidebar/topbar/search/nav.
 */
export function isAlurBoardPath(pathname: string): boolean {
  return /^\/b\/[^/]+\/alur\/?$/.test(pathname)
}

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
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  // Primary Flow Ultimate: no AppShell sidebar, topbar, command search, or nine-IA nav.
  if (isAlurBoardPath(pathname)) {
    return (
      <div
        className="alur-primary-shell"
        data-shell="alur"
        data-testid="alur-primary-shell"
      >
        <Outlet />
      </div>
    )
  }
  return (
    <AppShell>
      <Outlet />
    </AppShell>
  )
}
