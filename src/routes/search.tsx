/**
 * ART top-level alias S15–S16 → board search.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { z } from 'zod'

import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'
import { coerceControlCenterSearchString } from '#/lib/control-center-search'

const searchSchema = z.object({
  q: z.preprocess(
    (v) => coerceControlCenterSearchString(v),
    z.string().optional(),
  ),
  returnTo: z.string().startsWith('/').max(2048).optional(),
})

export const Route = createFileRoute('/search')({
  validateSearch: (search) => {
    const r = searchSchema.safeParse(search ?? {})
    return r.success ? r.data : {}
  },
  beforeLoad: ({ context, search }) => {
    if (!context.me) throw redirect({ to: '/login' })
    throw redirect({
      to: '/b/$boardId/search',
      params: { boardId: DEFAULT_CONTROL_CENTER_BOARD_ID },
      search: { q: search.q, returnTo: search.returnTo },
    })
  },
})
