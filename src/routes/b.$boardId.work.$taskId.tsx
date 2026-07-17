/**
 * ART S09–S10 board-scoped task detail via projectTaskDetail pin.
 * mode=technical expands technical identifiers; default is human-first.
 * W-UI-3: loads per-task lineage for Lineage Rebuild panel.
 */
import { createFileRoute } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'
import { z } from 'zod'

import { TaskDetailScreen } from '#/components/control-center/task-detail'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import { coerceControlCenterSearchString } from '#/lib/control-center-search'
import { taskDetailEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import type { PinnedEnvelope } from '#/lib/control-center-query'
import {
  getDefaultControlCenterFetchers,
  taskLineageQueryOptions,
} from '#/lib/control-center-query'
// Value import of control-center-ui-fns is dynamic below — that module
// static-imports control-center-ui-adapter → db/mysql2. Keep type-only
// rebuild-fns import so server store graph never enters the client chunk.
import type { TaskLineageData } from '#/server/control-center-rebuild-fns'

const taskSearchSchema = z.object({
  mode: z.preprocess(
    (v) => coerceControlCenterSearchString(v),
    z.string().optional(),
  ),
})

export const Route = createFileRoute('/b/$boardId/work/$taskId')({
  validateSearch: (search) => {
    const r = taskSearchSchema.safeParse(search ?? {})
    return r.success ? r.data : {}
  },
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
  },
  component: WorkTaskDetailRoute,
})

function WorkTaskDetailRoute() {
  const boardId = useBoardId()
  const { taskId } = Route.useParams()
  const search = Route.useSearch()
  const qc = useQueryClient()
  const mode = search.mode === 'technical' ? 'technical' : 'human'

  const q = useQuery({
    queryKey: ['control-center', 'task', boardId, taskId],
    queryFn: async () => {
      const { getControlCenterTaskFn } = await import(
        '#/server/control-center-ui-fns'
      )
      const wire = await getControlCenterTaskFn({ data: { boardId, taskId } })
      return wire as PinnedEnvelope<unknown>
    },
  })

  const lineageQ = useQuery(
    taskLineageQueryOptions(
      boardId,
      taskId,
      getDefaultControlCenterFetchers().taskLineage,
    ),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'task', boardId, taskId] })
    void qc.invalidateQueries({
      queryKey: ['control-center', 'task-lineage', boardId, taskId],
    })
  }, [qc, boardId, taskId])

  const vm = useMemo(
    () =>
      taskDetailEnvelopeToViewModel(q.data, {
        boardId,
        taskId,
        mode,
      }),
    [q.data, boardId, taskId, mode],
  )

  const surfaceState =
    q.isLoading && !q.data ? 'loading' : q.isError ? 'error' : vm.surfaceState

  const lineageData = (lineageQ.data ?? null) as TaskLineageData | null
  const lineageSurface =
    lineageQ.isLoading && !lineageQ.data
      ? ('loading' as const)
      : lineageData && lineageData.available
        ? ('ready' as const)
        : ('unavailable' as const)

  return (
    <div
      className="wrap"
      data-testid="control-center-work-task-route"
      data-direction="b"
    >
      <TaskDetailScreen
        {...vm}
        surfaceState={surfaceState}
        onRetry={onRetry}
        lineage={lineageData}
        lineageSurface={lineageSurface}
      />
    </div>
  )
}
