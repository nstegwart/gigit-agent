import { createFileRoute } from '@tanstack/react-router'
import { guideQueryOptions, useGuide } from '#/lib/board-query'
import { GuideView } from '#/components/GuideView'

export const Route = createFileRoute('/b/$boardId/guide')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(guideQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
  const guide = useGuide()
  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Guide</h2>
        </div>
        <GuideView guide={guide} />
      </section>
    </div>
  )
}
