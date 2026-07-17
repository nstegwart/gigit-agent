// Product feature directory — control-center boards only (W-UI-2).
// SPEC-TM-KOMPAT-VISUAL-V1 §1 IA, §3.B, §4.3 + ADDENDUM V1.1 §B.
import { Navigate, createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { FeatureDirectoryScreen } from '#/components/control-center/fitur'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  featureDirectoryQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'

export const Route = createFileRoute('/b/$boardId/fitur/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        featureDirectoryQueryOptions(
          params.boardId,
          getDefaultControlCenterFetchers().featureDirectory,
        ),
      )
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (!isControlCenterBoard(boardId)) {
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
  return <ControlCenterFiturDirectory />
}

function ControlCenterFiturDirectory() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    featureDirectoryQueryOptions(boardId, fetchers.featureDirectory),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({
      queryKey: ['control-center', 'feature-directory', boardId],
    })
  }, [qc, boardId])

  const data = q.data ?? null
  let surfaceState:
    | 'loading'
    | 'populated'
    | 'empty'
    | 'error'
    | 'forbidden'
    | 'disconnected' = 'loading'
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
    <div className="wrap" data-testid="control-center-fitur-directory-route">
      <FeatureDirectoryScreen
        boardId={boardId}
        data={data}
        surfaceState={surfaceState}
        errorMessage={
          q.isError
            ? 'Koneksi terputus — tidak dapat memuat direktori fitur.'
            : data && !data.available && data.reason === 'FORBIDDEN'
              ? 'Anda tidak memiliki akses ke papan ini.'
              : null
        }
        onRetry={onRetry}
      />
    </div>
  )
}
