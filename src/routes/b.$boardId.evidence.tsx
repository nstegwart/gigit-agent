// Control-center Evidence / Audit — material events from pinned aggregation.
// Existing /log remains the compatibility activity timeline.
// Page-layout-only: deep-link query `?evidence=` opens the ART-017 drawer.
// FAN-EVIDENCE: presentation via Direction B kit (EvidenceScreen + EvidenceDrawer).
// Canon-v3: control-center boards demote to /alur before evidence loaders run.
import { createFileRoute, redirect, useNavigate } from '@tanstack/react-router'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useMemo } from 'react'

import {
  EvidenceDrawer,
  EvidenceScreen,
  encodeEvidenceDeepLink,
  materialEventToDrawerModel,
  parseEvidenceDeepLink,
} from '#/components/control-center/evidence'
import { boardQueryOptions, useBoardId } from '#/lib/board-query'
import {
  evidenceQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
} from '#/lib/control-center-query'
import { evidenceEnvelopeToViewModel } from '#/lib/control-center-route-adapters'
import { parseControlCenterCursorSearch } from '#/lib/control-center-search'

function parseEvidenceRouteSearch(search: unknown) {
  const cursor = parseControlCenterCursorSearch(search)
  const raw =
    search && typeof search === 'object' && !Array.isArray(search)
      ? (search as Record<string, unknown>)
      : {}
  const evidence = parseEvidenceDeepLink(raw)
  return {
    ...cursor,
    ...(evidence ? { evidence } : {}),
  }
}

export const Route = createFileRoute('/b/$boardId/evidence')({
  validateSearch: (search) => parseEvidenceRouteSearch(search),
  beforeLoad: ({ params }) => {
    if (isControlCenterBoard(params.boardId)) {
      throw redirect({
        to: '/b/$boardId/alur',
        params: { boardId: params.boardId },
        replace: true,
      })
    }
  },
  loader: async ({ context, params, location }) => {
    // Control-center boards never reach here (beforeLoad → /alur).
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

  const openEvidence = useCallback(
    (evidenceId: string) => {
      void navigate({
        search: (prev) =>
          encodeEvidenceDeepLink(
            {
              cursor: typeof prev.cursor === 'string' ? prev.cursor : undefined,
              pageSize:
                typeof prev.pageSize === 'string' ? prev.pageSize : undefined,
            },
            evidenceId,
          ),
        replace: true,
      })
    },
    [navigate],
  )

  const closeEvidence = useCallback(() => {
    void navigate({
      search: (prev) =>
        encodeEvidenceDeepLink(
          {
            cursor: typeof prev.cursor === 'string' ? prev.cursor : undefined,
            pageSize:
              typeof prev.pageSize === 'string' ? prev.pageSize : undefined,
          },
          null,
        ),
      replace: true,
    })
  }, [navigate])

  const vm = evidenceEnvelopeToViewModel(q.data)
  const loading = q.isLoading && !q.data

  const deepEvidenceId =
    typeof search.evidence === 'string' ? search.evidence : null
  const selectedEvent = useMemo(
    () =>
      deepEvidenceId
        ? (vm.events.find((e) => e.id === deepEvidenceId) ?? null)
        : null,
    [deepEvidenceId, vm.events],
  )
  const drawerModel = useMemo(
    () =>
      selectedEvent
        ? materialEventToDrawerModel(selectedEvent, vm.pin)
        : deepEvidenceId
          ? {
              id: deepEvidenceId,
              proofSummary: 'Bukti tidak ada di pin halaman ini.',
              claimSupported: 'Klaim tidak dapat ditampilkan tanpa peristiwa pin.',
              verifier: null,
              verifiedAt: null,
              freshness: null,
              revision: null,
              snapshotId: vm.pin?.canonicalSnapshotId ?? null,
              sourceAnchor: deepEvidenceId,
              sourceHref: null,
              warnings: [
                {
                  kind: 'stale' as const,
                  message:
                    'ID bukti di tautan dalam tidak cocok dengan peristiwa pin saat ini.',
                },
              ],
              rawReceipt: null,
              citationText: deepEvidenceId,
            }
          : null,
    [selectedEvent, deepEvidenceId, vm.pin],
  )
  const deepLinkHref = deepEvidenceId
    ? `/b/${encodeURIComponent(boardId)}/evidence?evidence=${encodeURIComponent(deepEvidenceId)}`
    : null

  return (
    <>
      <EvidenceScreen
        boardId={boardId}
        surfaceState={vm.surfaceState}
        loading={loading}
        events={vm.events}
        nextCursor={vm.nextCursor}
        pin={vm.pin}
        error={vm.error}
        onRetry={onRetry}
        onNextPage={onNextPage}
        onOpenEvidence={openEvidence}
      />
      <EvidenceDrawer
        open={deepEvidenceId != null}
        model={drawerModel}
        onClose={closeEvidence}
        deepLinkHref={deepLinkHref}
      />
    </>
  )
}
