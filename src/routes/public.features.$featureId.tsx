/**
 * Public unauthenticated feature detail with real progress nodes.
 * Source: allowlisted /api/public-snapshot only — no board session.
 * Title presentation policy (ADDENDUM C) applied in FeatureDetailScreen.
 * Pin/boardRev/STALE live under "Detail teknis" (W-UI-QW D.3).
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { FeatureDetailScreen } from '#/components/control-center/features/FeatureDetailScreen'
import {
  DEFAULT_PUBLIC_BOARD_ID,
  fetchPublicSnapshot,
  pinViewFromPublicSnapshot,
  publicFeaturesListHref,
  publicSnapshotToFeatureRows,
  type PublicSnapshotPayload,
} from '#/lib/public-features'

type Search = { boardId?: string }

export const Route = createFileRoute('/public/features/$featureId')({
  validateSearch: (raw: Record<string, unknown>): Search => {
    const boardId =
      typeof raw.boardId === 'string' && raw.boardId.trim().length > 0
        ? raw.boardId.trim()
        : DEFAULT_PUBLIC_BOARD_ID
    return { boardId }
  },
  component: PublicFeatureDetailPage,
  head: () => ({
    meta: [
      { title: 'Detail fitur publik — Cairn' },
      {
        name: 'description',
        content: 'Node progres tugas nyata per fitur dari snapshot publik (tanpa login).',
      },
    ],
  }),
})

function PublicFeatureDetailPage() {
  const { featureId } = Route.useParams()
  const { boardId = DEFAULT_PUBLIC_BOARD_ID } = Route.useSearch()
  const [snap, setSnap] = useState<PublicSnapshotPayload | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(true)

  const load = useCallback(async () => {
    setLoading(true)
    setError(null)
    const result = await fetchPublicSnapshot(boardId)
    if (!result.ok) {
      setSnap(null)
      setError(result.message || `Gagal memuat snapshot (${result.status})`)
      setLoading(false)
      return
    }
    setSnap(result.data)
    setLoading(false)
  }, [boardId])

  useEffect(() => {
    void load()
  }, [load])

  const rows = useMemo(() => publicSnapshotToFeatureRows(snap, boardId), [snap, boardId])
  const feature = useMemo(
    () => rows.find((r) => r.featureId === featureId) ?? null,
    [rows, featureId],
  )
  const pin = useMemo(() => pinViewFromPublicSnapshot(snap, boardId), [snap, boardId])
  const listHref = publicFeaturesListHref(boardId)

  const surfaceState =
    loading && !snap
      ? ('loading' as const)
      : error
        ? ('error' as const)
        : feature
          ? ('populated' as const)
          : ('empty' as const)

  return (
    <div
      className="wrap"
      data-testid="public-feature-detail-page"
      data-board-id={boardId}
      data-feature-id={featureId}
    >
      <p style={{ margin: '0 0 12px', fontSize: '0.875rem' }}>
        <Link to="/public/features" search={{ boardId }} data-testid="public-feature-back-nav">
          ← Daftar fitur publik
        </Link>
      </p>
      <FeatureDetailScreen
        surfaceState={surfaceState}
        boardId={boardId}
        feature={feature}
        pin={pin}
        error={
          error
            ? { code: 'PUBLIC_SNAPSHOT_ERROR', message: error }
            : !feature && !loading
              ? {
                  code: 'FEATURE_NOT_FOUND',
                  message: `Fitur ${featureId} tidak ada di snapshot publik board ${boardId}.`,
                }
              : null
        }
        listHref={listHref}
        onRetry={() => void load()}
      />
    </div>
  )
}
