/**
 * ART top-level alias S12 → board-prefixed decision detail.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'

export const Route = createFileRoute('/decisions/$decisionId')({
  beforeLoad: ({ context, params }) => {
    if (!context.me) throw redirect({ to: '/login' })
    throw redirect({
      to: '/b/$boardId/decisions/$decisionId',
      params: {
        boardId: DEFAULT_CONTROL_CENTER_BOARD_ID,
        decisionId: params.decisionId,
      },
    })
  },
})
