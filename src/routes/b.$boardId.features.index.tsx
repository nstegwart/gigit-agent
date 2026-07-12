// All-features route — typed React port of the prototype `vFeatures(m)` view.
// The page body is a single `.wrap` containing the shared `FeaturesTable`,
// which already renders the "All features" section header + count, the
// project/status filter chips, and the sortable feature table.
import { createFileRoute } from '@tanstack/react-router'

import { boardQueryOptions, useBoard } from '#/lib/board-query'
import { FeaturesTable } from '#/components/FeaturesTable'

export const Route = createFileRoute('/b/$boardId/features/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
  const m = useBoard()
  return (
    <div className="wrap">
      <FeaturesTable model={m} />
    </div>
  )
}
