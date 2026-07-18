// Rebuild dashboard route — control-center boards (mfs-rebuild) only.
// SPEC-TM-KOMPAT-VISUAL-V1 §3.A + §4 + ADDENDUM V1.1 §B · FAN-REBUILD Direction B.
// Presentation lives in control-center/rebuild/*; this route only wires data.
// Canon-v3: control-center boards demote to /alur before rebuild loaders run.
import { Navigate, createFileRoute, redirect } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { RebuildDashboardScreen } from '#/components/control-center/rebuild'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  rebuildQueryOptions,
} from '#/lib/control-center-query'

export const Route = createFileRoute('/b/$boardId/rebuild')({
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
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        rebuildQueryOptions(
          params.boardId,
          getDefaultControlCenterFetchers().rebuild,
        ),
      )
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (!isControlCenterBoard(boardId)) {
    // Non control-center boards: no Rebuild surface — send home.
    return (
      <Navigate
        {...({
          to: '/b/$boardId',
          params: { boardId },
          replace: true,
        } as any)}
      />
    )
  }
  return <ControlCenterRebuild />
}

function ControlCenterRebuild() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(rebuildQueryOptions(boardId, fetchers.rebuild))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'rebuild', boardId] })
  }, [qc, boardId])

  const data = q.data ?? null
  let surfaceState: 'loading' | 'populated' | 'empty' | 'error' | 'forbidden' | 'disconnected' =
    'loading'
  if (q.isError) {
    surfaceState = 'disconnected'
  } else if (q.isLoading && !data) {
    surfaceState = 'loading'
  } else if (data && !data.available && data.reason === 'FORBIDDEN') {
    surfaceState = 'forbidden'
  } else if (data && !data.available) {
    surfaceState = 'empty'
  } else if (data?.available) {
    surfaceState = 'populated'
  }

  return (
    <div className="wrap" data-testid="control-center-rebuild-route">
      <RebuildDashboardScreen
        boardId={boardId}
        data={data}
        surfaceState={surfaceState}
        errorMessage={
          q.isError
            ? 'Koneksi terputus — tidak dapat memuat data rebuild.'
            : data && !data.available && data.reason === 'FORBIDDEN'
              ? 'Anda tidak memiliki akses ke papan ini.'
              : null
        }
        onRetry={onRetry}
      />
    </div>
  )
}
