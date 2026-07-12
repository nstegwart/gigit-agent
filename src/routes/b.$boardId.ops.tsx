// Ops route — agent-vault accounts view. Batch 5: `useOps()` + `<AccountsGrid/>`.
import { createFileRoute } from '@tanstack/react-router'

import { opsQueryOptions, useOps } from '#/lib/board-query'
import { AccountsGrid } from '#/components/AccountsGrid'

export const Route = createFileRoute('/b/$boardId/ops')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(opsQueryOptions(params.boardId))
  },
  component: View,
})

function View() {
  const ops = useOps()

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Agent accounts</h2>
        </div>
        <AccountsGrid ops={ops} />
      </section>
    </div>
  )
}
