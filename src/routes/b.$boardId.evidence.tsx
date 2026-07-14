// Control-center Evidence / Audit — material events from pinned aggregation.
// Existing /log remains the compatibility activity timeline.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback } from 'react'

import { BoardLink } from '#/components/BoardLink'
import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  evidenceQueryOptions,
  getDefaultControlCenterFetchers,
} from '#/lib/control-center-query'
import { evidenceEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'

export const Route = createFileRoute('/b/$boardId/evidence')({
  validateSearch: (search) => parseControlCenterCursorSearch(search),
  loader: async ({ context, params, location }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    const search = parseControlCenterCursorSearch(location.search)
    await context.queryClient.ensureQueryData(
      evidenceQueryOptions(
        params.boardId,
        { cursor: search.cursor ?? null, pageSize: null },
        getDefaultControlCenterFetchers().evidence,
      ),
    )
  },
  component: EvidenceRoute,
})

function EvidenceRoute() {
  const boardId = useBoardId()
  const search = Route.useSearch()
  const navigate = useNavigate({ from: '/b/$boardId/evidence' })
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(
    evidenceQueryOptions(
      boardId,
      { cursor: search.cursor ?? null, pageSize: null },
      fetchers.evidence,
    ),
  )

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'evidence', boardId] })
  }, [qc, boardId])

  const onNextPage = useCallback(() => {
    const next = q.data?.nextCursor
    if (!next) return
    void navigate({
      search: (prev) => ({ ...prev, cursor: next }),
      replace: true,
    })
  }, [navigate, q.data?.nextCursor])

  const vm = evidenceEnvelopeToViewModel(q.data)
  const loading = q.isLoading && !q.data
  const pinAttrs = pinnedSurfaceDataAttrs(
    vm.pin
      ? {
          canonicalSnapshotId: vm.pin.canonicalSnapshotId,
          canonicalHash: vm.pin.canonicalHash ?? null,
          boardRev: vm.pin.boardRev,
          lifecycleRev: vm.pin.lifecycleRev,
        }
      : null,
  )

  return (
    <div className="wrap" data-testid="control-center-evidence-route">
      <section
        className="section"
        data-surface-state={loading ? 'loading' : vm.surfaceState}
        data-testid="control-center-evidence"
        aria-labelledby="evidence-page-title"
        {...pinAttrs}
      >
        <div className="sec-head">
          <div>
            <p className="desc" style={{ margin: 0, fontWeight: 700, letterSpacing: '0.04em', textTransform: 'uppercase', fontSize: '0.72rem' }}>
              Mission Q8
            </p>
            <h2 id="evidence-page-title" style={{ margin: '4px 0 0' }}>
              Evidence / Audit
            </h2>
          </div>
          <span className="count" aria-label={`${vm.events.length} events`}>
            {vm.events.length}
          </span>
          <span className="desc">
            Immutable material events from the pinned aggregation ·{' '}
            <BoardLink to="/log">legacy activity log</BoardLink>
          </span>
        </div>

        {vm.pin ? (
          <p className="desc" data-testid="evidence-pin">
            pin <code>{vm.pin.canonicalSnapshotId}</code> · boardRev {vm.pin.boardRev} ·
            lifecycleRev {vm.pin.lifecycleRev}
            {vm.pin.stale ? ` · STALE ${vm.pin.staleReason ?? ''}` : ''}
          </p>
        ) : null}

        {vm.error ? (
          <div className="empty" role="alert" data-testid="evidence-error">
            <strong>{vm.error.code}</strong>: {vm.error.message}{' '}
            <button type="button" className="btn" onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}

        {loading ? (
          <div className="empty" data-testid="evidence-loading" aria-busy="true">
            Loading evidence…
          </div>
        ) : null}

        {!loading && !vm.error && vm.events.length === 0 ? (
          <div className="empty" data-testid="evidence-empty">
            No material events for this pin — nothing to audit yet.
          </div>
        ) : null}

        <ul className="timeline" data-testid="evidence-list" aria-label="Material events">
          {vm.events.map((ev) => (
            <li key={ev.id} className="tl-item" data-testid="evidence-row">
              <div className="tl-text">
                <strong>{ev.kind}</strong>
                <span aria-hidden="true"> · </span>
                <time dateTime={ev.createdAt}>{ev.createdAt}</time>
                {ev.actorId ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    <span>{ev.actorId}</span>
                  </>
                ) : null}
                {ev.materialHash ? (
                  <>
                    <span aria-hidden="true"> · </span>
                    hash <code title={ev.materialHash}>{ev.materialHash.slice(0, 12)}</code>
                  </>
                ) : null}
              </div>
              <div className="tl-text">{ev.summary || '—'}</div>
            </li>
          ))}
        </ul>

        {vm.nextCursor ? (
          <div
            className="sec-head"
            style={{ marginTop: 12, gap: 8, alignItems: 'center' }}
            data-testid="evidence-next-cursor"
          >
            <span className="desc">More pages available (server cursor)</span>
            <button
              type="button"
              className="btn"
              onClick={onNextPage}
              data-testid="evidence-next-page"
            >
              Next page
            </button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
