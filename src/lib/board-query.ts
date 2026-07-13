// TanStack Query wiring, boardId-scoped. queryKey ['board', boardId] holds the raw
// board; useBoard() reads the current route's boardId and builds the derived Model.
// Mutations write the returned raw board straight back into the cache.
// Cookie-write mutations attach X-CSRF-Token via csrf-client (fail-closed).
import { queryOptions, useMutation, useQuery, useQueryClient, useSuspenseQuery } from '@tanstack/react-query'
import { useParams } from '@tanstack/react-router'
import { useMemo } from 'react'

import {
  clearCsrfTokenCache,
  csrfServerCall,
  csrfServerCallNoData,
  getCsrfToken,
} from './csrf-client'
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
import {
  bootstrapFn,
  createUserFn,
  deleteUserFn,
  listUsersFn,
  loginFn,
  logoutFn,
  meFn,
  resetPasswordFn,
  setUserBoardsFn,
  setUserRoleFn,
} from '#/server/auth-fns'
import type { BoardMeta, GuideData, LifecycleConfig, Model, OpsData, ProdData, RawBoard, Role, Rollup, SessionUser, TasksFile, TaskLifecycleState, UserRow, WorkTask } from './types'

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
      csrfServerCall(toggleCheckpointFn, { ...v, boardId }),
    onSuccess: (file) => {
      qc.setQueryData(tasksQueryOptions(boardId).queryKey, file)
    },
  })
}
export function useSetLifecycle() {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (stages: LifecycleConfig['stages']) =>
      csrfServerCall(setLifecycleFn, { boardId, stages }),
    onSuccess: (cfg) => {
      qc.setQueryData(lifecycleQueryOptions(boardId).queryKey, cfg)
      void qc.invalidateQueries({ queryKey: ['rollup', boardId] })
    },
  })
}
/**
 * Programmatic stage receipt for V3 HTTP advance. `programmatic: true` is required —
 * owner/human hand-typed evidence is authority-invalid.
 */
export type AdvanceProgrammaticReceipt = {
  programmatic: true
  receiptId?: string
  taskHash?: string
  canonicalHash?: string
  boardRev?: number
  lifecycleRev?: number
  fields?: Record<string, string | number | boolean | null>
  authorRunId?: string | null
  verifierRunId?: string | null
  verdict?: string | null
  issuedAt?: string
  receiptHash?: string
} & Record<string, unknown>

/**
 * Server-provided V3 advance packet (without target stage). UI must not invent revs,
 * hashes, run ids, or receipts — only an agent/server-emitted complete packet is valid.
 */
export interface AdvanceV3Packet {
  taskId: string
  entityExpectedRev: number
  expectedBoardRev: number
  expectedLifecycleRev: number
  expectedTaskHash: string
  canonicalHash: string
  idempotencyKey: string
  /** Registered implementer/author run id (never fabricated "human"). */
  byRunId: string
  authorRunId: string
  verifierRunId: string
  receipt: AdvanceProgrammaticReceipt
  role?: string
  evidence?: Record<string, unknown>
  verdict?: string
  commitSha?: string
  deployReceipt?: string
  blocker?: string
  productionApprovalId?: string
  requireOppositeModel?: boolean
  /** Optional aliases accepted by HTTP schema; prefer canonicalHash / entityExpectedRev. */
  subjectHash?: string
  expectedEntityRev?: number
  expectedRev?: number
}

/** Exact full V3 HTTP advance body (boardId injected by useAdvanceTask). */
export interface AdvancePayload extends AdvanceV3Packet {
  toStage: string
}

const FABRICATED_RUN_IDS = new Set(['human', 'owner', 'ui', 'manual', ''])

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isInt(v: unknown): v is number {
  return typeof v === 'number' && Number.isInteger(v)
}

/**
 * Fail-closed: true only when every required V3 field is present and no fabricated
 * owner/human run identity is used. Incomplete / legacy shapes are rejected.
 */
export function isCompleteAdvanceV3Packet(value: unknown): value is AdvanceV3Packet {
  if (value == null || typeof value !== 'object') return false
  const v = value as Record<string, unknown>
  if (!isNonEmptyString(v.taskId)) return false
  if (!isInt(v.entityExpectedRev) && !isInt(v.expectedEntityRev) && !isInt(v.expectedRev)) return false
  if (!isInt(v.expectedBoardRev)) return false
  if (!isInt(v.expectedLifecycleRev)) return false
  if (!isNonEmptyString(v.expectedTaskHash)) return false
  const hash = isNonEmptyString(v.canonicalHash)
    ? v.canonicalHash
    : isNonEmptyString(v.subjectHash)
      ? v.subjectHash
      : ''
  if (!hash) return false
  if (!isNonEmptyString(v.idempotencyKey)) return false
  if (!isNonEmptyString(v.byRunId) || FABRICATED_RUN_IDS.has(v.byRunId.trim().toLowerCase())) return false
  if (!isNonEmptyString(v.authorRunId) || FABRICATED_RUN_IDS.has(v.authorRunId.trim().toLowerCase())) {
    return false
  }
  if (
    !isNonEmptyString(v.verifierRunId) ||
    FABRICATED_RUN_IDS.has(v.verifierRunId.trim().toLowerCase())
  ) {
    return false
  }
  const receipt = v.receipt
  if (receipt == null || typeof receipt !== 'object') return false
  if ((receipt as { programmatic?: unknown }).programmatic !== true) return false
  return true
}

/** Build mutation payload from a validated packet + target stage. Does not invent fields. */
export function toAdvancePayload(packet: AdvanceV3Packet, toStage: string): AdvancePayload {
  if (!isNonEmptyString(toStage)) {
    throw new Error('toStage is required for V3 advance')
  }
  if (!isCompleteAdvanceV3Packet(packet)) {
    throw new Error('incomplete V3 advance packet — refuse mutation')
  }
  return { ...packet, toStage }
}

export function useAdvanceTask() {
  const qc = useQueryClient()
  const boardId = useBoardId()
  return useMutation({
    mutationFn: (v: AdvancePayload) => {
      // Runtime fail-closed: never forward legacy / partial / fabricated payloads.
      if (!isCompleteAdvanceV3Packet(v) || !isNonEmptyString(v.toStage)) {
        return Promise.reject(
          new Error(
            'AdvancePayload incomplete or authority-invalid — full V3 packet required (entityExpectedRev, expectedBoardRev, expectedLifecycleRev, hashes, idempotencyKey, registered runs, programmatic receipt)',
          ),
        )
      }
      return csrfServerCall(advanceTaskFn, { ...v, boardId })
    },
    onSuccess: (_r, v) => {
      void qc.invalidateQueries({ queryKey: ['task-lc', boardId, v.taskId] })
      void qc.invalidateQueries({ queryKey: ['rollup', boardId] })
    },
  })
}

/** Board mutations return the fresh raw board → replace the cache. boardId injected here. CSRF on every write. */
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
    csrfServerCall(toggleTaskFn, p),
  )
}
export function useAddComment() {
  return useBoardMutation<{ featureId: string; author: string; authorType?: 'human' | 'agent'; text: string }>(
    (p) => csrfServerCall(addCommentFn, p),
  )
}
export function useAddDesignLink() {
  return useBoardMutation<{ scope: 'project' | 'feature'; id: string; label?: string; url: string }>(
    (p) => csrfServerCall(addDesignLinkFn, p),
  )
}
export function useOpenDecision() {
  return useBoardMutation<{
    featureId: string
    question: string
    options?: Array<{ key: string; label: string; rekomendasi?: boolean }>
    openedBy?: string
  }>((p) => csrfServerCall(openDecisionFn, p))
}
export function useDecideDecision() {
  return useBoardMutation<{ id: string; answer: string; keputusan?: string; decidedBy?: string }>(
    (p) => csrfServerCall(decideDecisionFn, p),
  )
}
export function useClearBlocked() {
  return useBoardMutation<{ featureId: string }>((p) => csrfServerCall(clearBlockedFn, p))
}

// ---- auth: the signed-in human + user management ----
export const meQueryOptions = () =>
  queryOptions<SessionUser | null>({ queryKey: ['me'], queryFn: () => meFn(), staleTime: 60_000 })
/** The current human (null when anonymous). */
export function useMe(): SessionUser | null {
  return useQuery(meQueryOptions()).data ?? null
}
/** Edit controls render only for admins — members are read-only. */
export function useCanEdit(): boolean {
  return useMe()?.role === 'admin'
}

export function useLogin() {
  const qc = useQueryClient()
  return useMutation({
    // Origin-only: no session CSRF yet (server assertRequestOrigin).
    mutationFn: (v: { username: string; password: string }) => loginFn({ data: v }),
    onSuccess: (user) => {
      // New session cookie — drop any prior cache, then warm the new token.
      clearCsrfTokenCache()
      void getCsrfToken().catch(() => {
        /* warm is best-effort; mutations still fail-closed on demand */
      })
      qc.setQueryData(meQueryOptions().queryKey, user)
      void qc.invalidateQueries({ queryKey: ['boards'] })
    },
  })
}
export function useBootstrap() {
  const qc = useQueryClient()
  return useMutation({
    // Origin-only: first-admin unauthenticated POST (server assertRequestOrigin).
    mutationFn: (v: { username: string; password: string }) => bootstrapFn({ data: v }),
    onSuccess: (user) => {
      clearCsrfTokenCache()
      void getCsrfToken().catch(() => {
        /* warm is best-effort; mutations still fail-closed on demand */
      })
      qc.setQueryData(meQueryOptions().queryKey, user)
      void qc.invalidateQueries({ queryKey: ['boards'] })
    },
  })
}
export function useLogout() {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: async () => {
      try {
        return await csrfServerCallNoData(logoutFn)
      } finally {
        clearCsrfTokenCache()
      }
    },
    onSuccess: () => {
      clearCsrfTokenCache()
      qc.setQueryData(meQueryOptions().queryKey, null)
      qc.clear()
    },
  })
}

export const usersQueryOptions = () =>
  queryOptions<Array<UserRow>>({ queryKey: ['users'], queryFn: () => listUsersFn(), staleTime: 5_000 })
export function useUsers(): Array<UserRow> {
  return useSuspenseQuery(usersQueryOptions()).data
}
function useUsersMutation<V>(send: (v: V) => Promise<Array<UserRow>>) {
  const qc = useQueryClient()
  return useMutation({
    mutationFn: send,
    onSuccess: (rows) => qc.setQueryData(usersQueryOptions().queryKey, rows),
  })
}
export function useCreateUser() {
  return useUsersMutation((v: { username: string; password: string; role: Role; boards?: Array<string> }) =>
    csrfServerCall(createUserFn, v),
  )
}
export function useSetUserBoards() {
  return useUsersMutation((v: { userId: string; boards: Array<string> }) =>
    csrfServerCall(setUserBoardsFn, v),
  )
}
export function useSetUserRole() {
  return useUsersMutation((v: { userId: string; role: Role }) => csrfServerCall(setUserRoleFn, v))
}
export function useDeleteUser() {
  return useUsersMutation((v: { userId: string }) => csrfServerCall(deleteUserFn, v))
}
export function useResetPassword() {
  return useMutation({
    mutationFn: (v: { userId: string; password: string }) => csrfServerCall(resetPasswordFn, v),
  })
}
