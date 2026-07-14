/**
 * ART S17 documentation domain export preview from pinned data + HD citations.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import { DocumentationDomainScreen } from '#/components/control-center/documentation'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import { documentationDomainEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import type { PinnedEnvelope } from '#/lib/control-center-query'
import { getControlCenterDocumentationDomainFn } from '#/server/control-center-ui-fns'

export const Route = createFileRoute('/b/$boardId/documentation/domains/$domain')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: DocumentationDomainRoute,
})

function DocumentationDomainRoute() {
  const boardId = useBoardId()
  const { domain } = Route.useParams()
  const qc = useQueryClient()

  const q = useQuery({
    queryKey: ['control-center', 'documentation', boardId, domain],
    queryFn: async () => {
      const wire = await getControlCenterDocumentationDomainFn({
        data: { boardId, domain },
      })
      return wire as PinnedEnvelope<unknown>
    },
  })

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: ['control-center', 'documentation', boardId, domain],
    })
  }, [qc, boardId, domain])

  const vm = useMemo(
    () => documentationDomainEnvelopeToViewModel(q.data, { boardId, domain }),
    [q.data, boardId, domain],
  )

  const surfaceState =
    q.isLoading && !q.data ? 'loading' : q.isError ? 'error' : vm.surfaceState

  return (
    <div className="wrap" data-testid="control-center-documentation-route">
      <DocumentationDomainScreen {...vm} surfaceState={surfaceState} onRetry={onRetry} />
    </div>
  )
}
