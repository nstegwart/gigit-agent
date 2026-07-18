/**
 * ART S15–S16 board search + W-UI-5 entity-grouped results.
 * Pin-flat path remains for decisions/evidence; product path supplies Fitur/Tugas/Unit/Dokumen.
 * Canon-v3: control-center boards demote to /alur before search loaders run.
 */
import { createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'

import { SearchScreen } from '#/components/control-center/search'
import { safeBoardReturnHref } from '#/components/control-center/search/CommandSearch'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  groupedSearchQueryKey,
  isControlCenterBoard,
  searchQueryKey,
} from '#/lib/control-center-query'
import { coerceControlCenterSearchString } from '#/lib/control-center-search'
import { searchEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import { getControlCenterGroupedSearchFn } from '#/server/control-center-rebuild-fns'
import { getControlCenterSearchFn } from '#/server/control-center-ui-fns'

const searchSchema = z.object({
  q: z.preprocess(
    (v) => coerceControlCenterSearchString(v),
    z.string().optional(),
  ),
  returnTo: z.string().startsWith('/').max(2048).optional(),
})

export const Route = createFileRoute('/b/$boardId/search')({
  validateSearch: (search) => {
    const r = searchSchema.safeParse(search ?? {})
    return r.success ? r.data : {}
  },
  beforeLoad: ({ params }) => {
    if (isControlCenterBoard(params.boardId)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: params.boardId },
        replace: true,
      })
    }
  },
  loader: async ({ context, params }) => {
    // Control-center boards never reach here (beforeLoad → /alur).
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: SearchRoute,
})

function SearchRoute() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const q = search.q ?? ''
  const qc = useQueryClient()

  const pinQuery = useQuery({
    queryKey: searchQueryKey(boardId, q),
    queryFn: async () => {
      const wire = await getControlCenterSearchFn({ data: { boardId, q } })
      return wire
    },
  })

  const groupedQuery = useQuery({
    queryKey: groupedSearchQueryKey(boardId, q),
    queryFn: async () => {
      return await getControlCenterGroupedSearchFn({ data: { boardId, q } })
    },
  })

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: searchQueryKey(boardId, q) })
    void qc.invalidateQueries({ queryKey: groupedSearchQueryKey(boardId, q) })
  }, [qc, boardId, q])

  const pinVm = useMemo(
    () => searchEnvelopeToViewModel(pinQuery.data, { boardId, query: q }),
    [pinQuery.data, boardId, q],
  )

  const grouped = groupedQuery.data ?? null
  const productCount =
    grouped && grouped.available === true ? grouped.totalCount : 0
  const pinCount = pinVm.results.length
  const hasAny = productCount + pinCount > 0

  const surfaceState =
    (pinQuery.isLoading || groupedQuery.isLoading) &&
    !pinQuery.data &&
    !groupedQuery.data
      ? 'loading'
      : pinQuery.isError && groupedQuery.isError
        ? 'error'
        : q.trim().length === 0
          ? 'empty'
          : hasAny
            ? pinVm.surfaceState === 'stale'
              ? 'stale'
              : 'populated'
            : 'zero-results'

  const error =
    pinQuery.isError && groupedQuery.isError
      ? pinVm.error ?? { code: 'SEARCH_ERROR', message: 'Pencarian gagal' }
      : pinVm.error

  return (
    <div className="wrap" data-testid="control-center-search-route">
      <SearchScreen
        surfaceState={surfaceState}
        boardId={boardId}
        query={q}
        results={pinVm.results}
        grouped={grouped}
        pin={pinVm.pin}
        error={error}
        dataGaps={
          grouped && grouped.available === true
            ? grouped.dataGaps
            : grouped && grouped.available === false
              ? grouped.dataGaps
              : undefined
        }
        onRetry={onRetry}
        returnHref={
          search.returnTo
            ? safeBoardReturnHref(boardId, search.returnTo)
            : undefined
        }
      />
    </div>
  )
}
