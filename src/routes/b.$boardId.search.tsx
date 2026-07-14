/**
 * ART S15–S16 board search over pinned control-center data.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'

import { SearchScreen } from '#/components/control-center/search'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import { coerceControlCenterSearchString } from '#/lib/control-center-search'
import { searchEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import type { PinnedEnvelope } from '#/lib/control-center-query'
import { getControlCenterSearchFn } from '#/server/control-center-ui-fns'

const searchSchema = z.object({
  q: z.preprocess((v) => coerceControlCenterSearchString(v), z.string().optional()),
})

export const Route = createFileRoute('/b/$boardId/search')({
  validateSearch: (search) => {
    const r = searchSchema.safeParse(search ?? {})
    return r.success ? r.data : {}
  },
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: SearchRoute,
})

function SearchRoute() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const q = search.q ?? ''
  const qc = useQueryClient()

  const query = useQuery({
    queryKey: ['control-center', 'search', boardId, q],
    queryFn: async () => {
      const wire = await getControlCenterSearchFn({ data: { boardId, q } })
      return wire as PinnedEnvelope<unknown>
    },
  })

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'search', boardId, q] })
  }, [qc, boardId, q])

  const vm = useMemo(
    () => searchEnvelopeToViewModel(query.data, { boardId, query: q }),
    [query.data, boardId, q],
  )

  const surfaceState =
    query.isLoading && !query.data ? 'loading' : query.isError ? 'error' : vm.surfaceState

  return (
    <div className="wrap" data-testid="control-center-search-route">
      <SearchScreen {...vm} surfaceState={surfaceState} onRetry={onRetry} />
    </div>
  )
}
