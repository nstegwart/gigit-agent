/**
 * ART top-level alias S03–S08 / S19–S20 / S24 → board-prefixed Work.
 * Default board: mfs-rebuild. S08 RECONCILIATION normalized in search.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import {
  DEFAULT_CONTROL_CENTER_BOARD_ID,
  normalizeArtWorkSearch,
} from '#/lib/control-center-default-board'

export const Route = createFileRoute('/work')({
  validateSearch: (search: Record<string, unknown>) => normalizeArtWorkSearch(search),
  beforeLoad: ({ context, search, location }) => {
    if (!context.me) throw redirect({ to: '/login' })
    // Parent of /work/$taskId — only redirect the list alias, not detail children.
    const path = location.pathname.replace(/\/$/, '') || '/'
    if (path !== '/work') return
    throw redirect({
      to: '/b/$boardId/work',
      params: { boardId: DEFAULT_CONTROL_CENTER_BOARD_ID },
      search: (prev) => ({ ...prev, ...search }),
    })
  },
})
