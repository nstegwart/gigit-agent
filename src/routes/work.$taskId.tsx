/**
 * ART top-level alias S09–S10 / S22–S23 → board-prefixed work task detail.
 * Preserves ?mode=technical.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'
import { coerceControlCenterSearchString } from '#/lib/control-center-search'

const modeSchema = z.object({
  mode: z.preprocess(
    (v) => coerceControlCenterSearchString(v),
    z.string().optional(),
  ),
})

export const Route = createFileRoute('/work/$taskId')({
  validateSearch: (search) => {
    const r = modeSchema.safeParse(search ?? {})
    return r.success ? r.data : {}
  },
  beforeLoad: ({ context, params, search }) => {
    if (!context.me) throw redirect({ to: '/login' })
    throw redirect({
      to: '/b/$boardId/work/$taskId',
      params: {
        boardId: DEFAULT_CONTROL_CENTER_BOARD_ID,
        taskId: params.taskId,
      },
      search: {
        mode: search.mode === 'technical' ? 'technical' : undefined,
      },
    })
  },
})
