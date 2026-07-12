import { createFileRoute } from '@tanstack/react-router'

import { ProdGates } from '#/components/ProdGates'
import { prodQueryOptions, useProd } from '#/lib/board-query'

export const Route = createFileRoute('/b/$boardId/prod')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(prodQueryOptions(params.boardId))
  },
  component: ProdView,
})

function ProdView() {
  const prod = useProd()

  return (
    <div className="wrap">
      <div className="sec-head">
        <h2>Path to production</h2>
      </div>
      <ProdGates prod={prod} />
    </div>
  )
}
