// Agents route — control-center boards use pinned agents envelope; others keep legacy status groups.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import {
  boardQueryOptions,
  lifecycleQueryOptions,
  opsQueryOptions,
  tasksQueryOptions,
  useBoard,
  useBoardId,
  useLifecycle,
  useOps,
  useTasks,
} from '#/lib/board-query'
import {
  agentsQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { agentsEnvelopeToProps } from '#/lib/control-center-secondary-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'
import { AgentsScreen } from '#/components/control-center/agents'
import { nextStage, stageReadiness } from '#/lib/readiness'
import { uiStore } from '#/store/ui'
import { RunCard, type RunTaskInfo } from '#/components/RunCard'
import { EmptyState } from '#/components/primitives'
import type { Run } from '#/lib/types'

export const Route = createFileRoute('/b/$boardId/agents')({
  validateSearch: (search) => parseControlCenterCursorSearch(search),
  loader: async ({ context, params, location }) => {
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
      const search = parseControlCenterCursorSearch(location.search)
      await context.queryClient.ensureQueryData(
        agentsQueryOptions(
          params.boardId,
          { cursor: search.cursor ?? null, pageSize: null },
          getDefaultControlCenterFetchers().agents,
        ),
      )
      return
    }
    await Promise.all([
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(opsQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

const GROUPS: Array<[string, Run['status']]> = [
  ['Running', 'running'],
  ['Blocked', 'blocked'],
  ['Queued', 'queued'],
  ['Done', 'done'],
  ['Failed', 'failed'],
]

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterAgents />
  }
  return <LegacyAgents />
}

function ControlCenterAgents() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/b/$boardId/agents' })
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    agentsQueryOptions(
      boardId,
      { cursor: search.cursor ?? null, pageSize: null },
      fetchers.agents,
    ),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'agents', boardId] })
  }, [qc, boardId])

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (!next) return
    void navigate({
      search: (prev) => ({ ...prev, cursor: next }),
      replace: true,
    })
  }, [navigate, q.data?.nextCursor])

  const props = agentsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
    onNextPage,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-agents-route">
      <AgentsScreen {...props} surfaceState={surfaceState} />
    </div>
  )
}

function LegacyAgents() {
  const m = useBoard()
  const { byId: taskById } = useTasks()
  const cfg = useLifecycle()
  const ops = useOps()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()

  const info = (r: Run): RunTaskInfo | undefined => {
    const t = r.taskId ? taskById[r.taskId] : null
    if (!t) return undefined
    return {
      stage: t.lifecycleStage ?? null,
      nextGate: nextStage(cfg, t.lifecycleStage)?.key ?? null,
      readinessPercent: stageReadiness(cfg, t.lifecycleStage),
    }
  }

  let runs = m.runs
  if (q)
    runs = runs.filter((r) =>
      `${r.agent} ${r.task} ${r.model} ${r.agentType} ${r.effort}`.toLowerCase().includes(q),
    )
  const groups = GROUPS.map(([t, s]) => [t, runs.filter((r) => r.status === s)] as [string, Array<Run>]).filter(
    (g) => g[1].length,
  )

  const live = m.runningAgents.length
  const now = Date.now()
  const stalled = m.runningAgents.filter(
    (r) => r.updated && now - Date.parse(r.updated) > 15 * 60 * 1000,
  ).length
  const unproductive = m.runs.filter(
    (r) => r.status === 'running' && (!r.taskId || (!r.targetGate && !r.verdict)),
  ).length
  const receipts = m.runs.filter(
    (r) =>
      r.verdict && r.updated && new Date(r.updated).toDateString() === new Date(now).toDateString(),
  ).length
  const usable = ops.accounts.filter((a) => a.usable).length
  const limited = ops.accounts.filter((a) => !a.usable).length

  const tiles: Array<[string, number | string, string]> = [
    ['Live runs', live, 'ok'],
    ['Stalled', stalled, stalled ? 'warn' : ''],
    ['Unproductive', unproductive, unproductive ? 'blocked' : ''],
    ['Receipts today', receipts, ''],
    ['Accounts usable', `${usable}/${usable + limited}`, limited ? 'warn' : 'ok'],
  ]

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Agents</h2>
          <span className="count">{m.runs.length}</span>
          <span className="live">
            <span className="blink" />
            {live} live
          </span>
          <span className="desc">who is moving which gate — not the source of progress</span>
        </div>

        <div className="agsum">
          {tiles.map(([lbl, val, tone]) => (
            <div className={`agsum-tile ${tone ? `t-${tone}` : ''}`} key={lbl}>
              <div className="agsum-n">{val}</div>
              <div className="agsum-l">{lbl}</div>
            </div>
          ))}
        </div>

        {groups.length ? (
          groups.map(([t, rs]) => (
            <div key={t}>
              <div className="queue-rail" style={{ marginTop: 8 }}>
                <span
                  className={`queue-lbl ${
                    t === 'Running'
                      ? 'ql-now'
                      : t === 'Blocked' || t === 'Failed'
                        ? 'ql-blocked'
                        : 'ql-next'
                  }`}
                >
                  {t}
                </span>
                <span className="line" />
                <span style={{ fontSize: 11, color: 'var(--text-faint)' }}>{rs.length}</span>
              </div>
              <div className="runs-grid" style={{ marginBottom: 16 }}>
                {rs.map((r) => (
                  <RunCard
                    key={r.id}
                    run={r}
                    model={m}
                    taskTitle={r.taskId ? taskById[r.taskId]?.title : undefined}
                    taskInfo={info(r)}
                  />
                ))}
              </div>
            </div>
          ))
        ) : (
          <EmptyState icon="agents">No agents.</EmptyState>
        )}
      </section>
    </div>
  )
}
