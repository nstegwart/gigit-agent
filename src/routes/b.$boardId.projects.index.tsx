// Projects list — control-center boards use pinned projects envelope; others keep legacy grid.
import { createFileRoute } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { boardQueryOptions, rollupQueryOptions, useBoard, useBoardId, useRollup } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  projectsQueryOptions,
} from '#/lib/control-center-query'
import { projectsEnvelopeToProps } from '#/lib/control-center-secondary-route-adapters'
import { ProjectsScreen } from '#/components/control-center/projects'
import { ProjectCard } from '#/components/ProjectCard'
import { uiStore } from '#/store/ui'

export const Route = createFileRoute('/b/$boardId/projects/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        projectsQueryOptions(params.boardId, getDefaultControlCenterFetchers().projects),
      )
    } else {
      await context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId))
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterProjects />
  }
  return <LegacyProjects />
}

function ControlCenterProjects() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(projectsQueryOptions(boardId, fetchers.projects))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'projects', boardId] })
  }, [qc, boardId])

  const props = projectsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-projects-route">
      <ProjectsScreen {...props} surfaceState={surfaceState} />
    </div>
  )
}

function LegacyProjects() {
  const m = useBoard()
  const rollup = useRollup()
  const q = useStore(uiStore, (s) => s.search).toLowerCase()
  const projects = q
    ? m.projects.filter((p) => `${p.nama} ${p.id}`.toLowerCase().includes(q))
    : m.projects

  return (
    <div className="wrap">
      <section className="section">
        <div className="sec-head">
          <h2>Projects</h2>
          <span className="count">{projects.length}</span>
          <span className="desc">readiness = lifecycle stage rollup (not legacy phase)</span>
        </div>
        <div className="proj-grid">
          {projects.map((p) => (
            <ProjectCard key={p.id} project={p} readiness={rollup.byProject[p.id]} />
          ))}
        </div>
      </section>
    </div>
  )
}
