/**
 * ART top-level alias S17 → board documentation domain.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'

export const Route = createFileRoute('/documentation/domains/$domain')({
  beforeLoad: ({ context, params }) => {
    if (!context.me) throw redirect({ to: '/login' })
    throw redirect({
      to: '/b/$boardId/documentation/domains/$domain',
      params: {
        boardId: DEFAULT_CONTROL_CENTER_BOARD_ID,
        domain: params.domain,
      },
    })
  },
})
