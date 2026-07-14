/**
 * ART top-level alias S11 → board-prefixed Decisions inbox.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'

export const Route = createFileRoute('/decisions')({
  beforeLoad: ({ context, search, location }) => {
    if (!context.me) throw redirect({ to: '/login' })
    // Parent of /decisions/$decisionId — only redirect the list alias.
    const path = location.pathname.replace(/\/$/, '') || '/'
    if (path !== '/decisions') return
    throw redirect({
      to: '/b/$boardId/decisions',
      params: { boardId: DEFAULT_CONTROL_CENTER_BOARD_ID },
      search: search as Record<string, unknown>,
    })
  },
})
