/**
 * ART top-level alias S13–S14 / S21 → board knowledge domain.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'

export const Route = createFileRoute('/knowledge/domains/$domain')({
  beforeLoad: ({ context, params }) => {
    if (!context.me) throw redirect({ to: '/login' })
    throw redirect({
      to: '/b/$boardId/knowledge/domains/$domain',
      params: {
        boardId: DEFAULT_CONTROL_CENTER_BOARD_ID,
        domain: params.domain,
      },
    })
  },
})
