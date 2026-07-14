/**
 * ART S13–S14 / S21 knowledge domain from pinned board data only.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { KnowledgeDomainScreen } from '#/components/control-center/knowledge'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import { knowledgeDomainEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import type { PinnedEnvelope } from '#/lib/control-center-query'
import { getControlCenterKnowledgeDomainFn } from '#/server/control-center-ui-fns'

export const Route = createFileRoute('/b/$boardId/knowledge/domains/$domain')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: KnowledgeDomainRoute,
})

function KnowledgeDomainRoute() {
  const boardId = useBoardId()
  const { domain } = Route.useParams()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['control-center', 'knowledge', boardId, domain],
    queryFn: async () => {
      const wire = await getControlCenterKnowledgeDomainFn({
        data: { boardId, domain },
      })
      return wire as PinnedEnvelope<unknown>
    },
  })

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: ['control-center', 'knowledge', boardId, domain],
    })
  }, [qc, boardId, domain])

  const vm = useMemo(
    () => knowledgeDomainEnvelopeToViewModel(q.data, { boardId, domain }),
    [q.data, boardId, domain],
  )

  const surfaceState =
    q.isLoading && !q.data ? 'loading' : q.isError ? 'error' : vm.surfaceState

  return (
    <div className="wrap" data-testid="control-center-knowledge-route">
      <KnowledgeDomainScreen {...vm} surfaceState={surfaceState} onRetry={onRetry} />
    </div>
  )
}
