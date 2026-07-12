// TanStack Query wiring, boardId-scoped. queryKey ['board', boardId] holds the raw
// board; useBoard() reads the current route's boardId and builds the derived Model.
// Mutations write the returned raw board straight back into the cache.
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useMemo } from 'react'

import { buildModel } from './model'
import { buildTasks } from './tasks'
import {
  addCommentFn,
  addDesignLinkFn,
  clearBlockedFn,
  decideDecisionFn,
  getBoardFn,
  getGuideFn,
  getOpsFn,
  getLifecycleFn,
  getProdFn,
  getRollupFn,
  getTaskFn,
  getTaskLifecycleFn,
  getTasksFn,
  advanceTaskFn,
  setLifecycleFn,
  listBoardsFn,
  openDecisionFn,
  toggleCheckpointFn,
  toggleTaskFn,
} from '#/server/board'
import type { BoardMeta, GuideData, LifecycleConfig, Model, OpsData, ProdData, RawBoard, Rollup, TasksFile, TaskLifecycleState, WorkTask } from './types'

const DEFAULT_VIEWS = ['board', 'agents', 'projects', 'features', 'map', 'design', 'decisions', 'log']

/** boardId from the current /b/$boardId route (empty on the boards-home route). */
export function useBoardId(): string {
  const params = useParams({ strict: false }) as { boardId?: string }
  return params.boardId ?? ''
}

export const boardQueryOptions = (boardId: string) =>
  queryOptions<RawBoard>({
    queryKey: ['board', boardId],
    queryFn: () => getBoardFn({ data: { boardId } }),
    staleTime: 5_000,
  })

export const boardsQueryOptions = () =>
  queryOptions<Array<BoardMeta>>({
    queryKey: ['boards'],
    queryFn: () => listBoardsFn(),
    staleTime: 5_000,
  })

export function useBoard(): Model {
  const boardId = useBoardId()
  const { data } = useSuspenseQuery(boardQueryOptions(boardId))
  return useMemo(() => buildModel(data), [data])
}

export function useBoards(): Array<BoardMeta> {
  const { data } = useSuspenseQuery(boardsQueryOptions())
  return data
}

export function useCurrentBoard(): BoardMeta | undefined {
  const boards = useBoards()
  const id = useBoardId()
  return boards.find((b) => b.id === id)
}

/** Adaptive nav — the current board's enabled views (default = all standard). */
export function useBoardViews(): Array<string> {
  return useCurrentBoard()?.views ?? DEFAULT_VIEWS
}

// ---- adaptive view queries ----
export const tasksQueryOptions = (boardId: string) =>
  queryOptions<TasksFile>({ queryKey: ['tasks', boardId], queryFn: () => getTasksFn({ data: { boardId } }), staleTime: 5_000 })
export const taskQueryOptions = (boardId: string, taskId: string) =>
  queryOptions<WorkTask | null>({ queryKey: ['task', boardId, taskId], queryFn: () => getTaskFn({ data: { boardId, taskId } }), staleTime: 5_000 })
export const lifecycleQueryOptions = (boardId: string) =>
  queryOptions<LifecycleConfig>({ queryKey: ['lifecycle', boardId], queryFn: () => getLifecycleFn({ data: { boardId } }), staleTime: 30_000 })
export const rollupQueryOptions = (boardId: string) =>
  queryOptions<Rollup>({ queryKey: ['rollup', boardId], queryFn: () => getRollupFn({ data: { boardId } }), staleTime: 5_000 })
export const taskLifecycleQueryOptions = (boardId: string, taskId: string) =>
  queryOptions<TaskLifecycleState | null>({ queryKey: ['task-lc', boardId, taskId], queryFn: () => getTaskLifecycleFn({ data: { boardId, taskId } }), staleTime: 5_000 })
export const opsQueryOptions = (boardId: string) =>
  queryOptions<OpsData>({ queryKey: ['ops', boardId], queryFn: () => getOpsFn({ data: { boardId } }), staleTime: 5_000 })
export const prodQueryOptions = (boardId: string) =>
  queryOptions<ProdData>({ queryKey: ['prod', boardId], queryFn: () => getProdFn({ data: { boardId } }), staleTime: 5_000 })
export const guideQueryOptions = (boardId: string) =>
  queryOptions<GuideData>({ queryKey: ['guide', boardId], queryFn: () => getGuideFn({ data: { boardId } }), staleTime: 5_000 })

export function useTasks() {
  const boardId = useBoardId()
  const { data } = useSuspenseQuery(tasksQueryOptions(boardId))
  return useMemo(() => buildTasks(data.tasks), [data])
}
export function useTask(taskId: string): WorkTask | null {
  const boardId = useBoardId()
  return useSuspenseQuery(taskQueryOptions(boardId, taskId)).data
}
/** Non-blocking full-task fetch — the heavy 20-point mapping loads after first paint. */
export function useTaskLazy(taskId: string) {
  const boardId = useBoardId()
  return useQuery(taskQueryOptions(boardId, taskId))
}
export function useLifecycle(): LifecycleConfig {
  const boardId = useBoardId()
  return useSuspenseQuery(lifecycleQueryOptions(boardId)).data
}
export function useRollup(): Rollup {
  const boardId = useBoardId()
  return useSuspenseQuery(rollupQueryOptions(boardId)).data
}
export function useTaskLifecycle(taskId: string) {
  const boardId = useBoardId()
  return useQuery(taskLifecycleQueryOptions(boardId, taskId))
}
export function useOps(): OpsData {
  const boardId = useBoardId()
  return useSuspenseQuery(opsQueryOptions(boardId)).data
}
export function useProd(): ProdData {
  const boardId = useBoardId()
  return useSuspenseQuery(prodQueryOptions(boardId)).data
}
export function useGuide(): GuideData {
  const boardId = useBoardId()
  return useSuspenseQuery(guideQueryOptions(boardId)).data
}
export function useToggleCheckpoint() {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (v: { taskId: string; checkpointId: string }) =>
      toggleCheckpointFn({ data: { ...v, boardId } }),
    onSuccess: (file) => {
      qc.setQueryData(tasksQueryOptions(boardId).queryKey, file)
    },
  })
}
export function useSetLifecycle() {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (stages: LifecycleConfig['stages']) => setLifecycleFn({ data: { boardId, stages } }),
    onSuccess: (cfg) => {
      qc.setQueryData(lifecycleQueryOptions(boardId).queryKey, cfg)
      void qc.invalidateQueries({ queryKey: ['rollup', boardId] })
    },
  })
}
export interface AdvancePayload {
  taskId: string
  toStage: string
  byRunId?: string
  verdict?: string
  commitSha?: string
  deployReceipt?: string
  evidence?: Record<string, unknown>
  blocker?: string
  expectedRev?: number
}
export function useAdvanceTask() {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (v: AdvancePayload) => advanceTaskFn({ data: { ...v, boardId } }),
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['task-lc', boardId, v.taskId] })
      void qc.invalidateQueries({ queryKey: ['rollup', boardId] })
    },
  })
}

/** Board mutations return the fresh raw board → replace the cache. boardId injected here. */
function useBoardMutation<V extends object>(
  send: (payload: V & { boardId: string }) => Promise<RawBoard>,
) {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (v: V) => send({ ...v, boardId }),
    onSuccess: (raw) => {
      qc.setQueryData(boardQueryOptions(boardId).queryKey, raw)
    },
  })
}

export function useToggleTask() {
  return useBoardMutation<{ featureId: string; index: number; done?: boolean }>((p) =>
    toggleTaskFn({ data: p }),
  )
}
export function useAddComment() {
  return useBoardMutation<{ featureId: string; author: string; authorType?: 'human' | 'agent'; text: string }>(
    (p) => addCommentFn({ data: p }),
  )
}
export function useAddDesignLink() {
  return useBoardMutation<{ scope: 'project' | 'feature'; id: string; label?: string; url: string }>(
    (p) => addDesignLinkFn({ data: p }),
  )
}
export function useOpenDecision() {
  return useBoardMutation<{
    featureId: string
    question: string
    options?: Array<{ key: string; label: string; rekomendasi?: boolean }>
    openedBy?: string
  }>((p) => openDecisionFn({ data: p }))
}
export function useDecideDecision() {
  return useBoardMutation<{ id: string; answer: string; keputusan?: string; decidedBy?: string }>(
    (p) => decideDecisionFn({ data: p }),
  )
}
export function useClearBlocked() {
  return useBoardMutation<{ featureId: string }>((p) => clearBlockedFn({ data: p }))
}
