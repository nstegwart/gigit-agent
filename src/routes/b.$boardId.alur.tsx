// Alur — full-viewport interactive workflow canvas (Flow Ultimate).
// Data via server-fn reading public/flow-data (no mysql on client graph).
import { createFileRoute } from '@tanstack/react-router'
import { useEffect } from 'react'

import { FlowUltimateScreen } from '#/components/flow-ultimate'
import type { FlowDataBundle } from '#/components/flow-ultimate/types'
import { getFlowDataBundleFn } from '#/server/flow-data-fns'

export const Route = createFileRoute('/b/$boardId/alur')({
  loader: async ({ params }) => {
    const data = (await getFlowDataBundleFn({
      data: { boardId: params.boardId },
    })) as FlowDataBundle
    return { data }
  },
  component: AlurView,
})

function AlurView() {
  const { boardId } = Route.useParams()
  const { data } = Route.useLoaderData()

  // Full-bleed content pane: mark shell so padding can collapse if present.
  useEffect(() => {
    document.documentElement.setAttribute('data-page', 'alur')
    document.body.setAttribute('data-page', 'alur')
    return () => {
      document.documentElement.removeAttribute('data-page')
      document.body.removeAttribute('data-page')
    }
  }, [])

  return <FlowUltimateScreen data={data} boardId={boardId} />
}
