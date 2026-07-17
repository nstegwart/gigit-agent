/**
 * Compatibility alias for operators that probe `/healthz`.
 *
 * Keep one implementation and one auth/readback contract: this route delegates
 * directly to the canonical authenticated `/api/healthz` handler.
 */
import { createFileRoute } from '@tanstack/react-router'

import { healthzGetHandler } from './api.healthz'

export const Route = createFileRoute('/healthz')({
  server: {
    handlers: {
      GET: ({ request }) => healthzGetHandler(request),
    },
  },
})
