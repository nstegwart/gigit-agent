/**
 * Public unauthenticated features list (01A public surface).
 * Loads allowlisted /api/public-snapshot — no board session required.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import styles from '#/components/control-center/features/features.module.css'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import {
  DEFAULT_PUBLIC_BOARD_ID,
  fetchPublicSnapshot,
  pinViewFromPublicSnapshot,
  publicFeaturesListHref,
  publicSnapshotToFeatureRows,
  type PublicSnapshotPayload,
} from '#/lib/public-features'

type Search = { boardId?: string }

export const Route = createFileRoute('/public/features/')({
  validateSearch: (raw: Record<string, unknown>): Search => {
    const boardId =
      typeof raw.boardId === 'string' && raw.boardId.trim().length > 0
        ? raw.boardId.trim()
        : DEFAULT_PUBLIC_BOARD_ID
    return { boardId }
  },
  component: PublicFeaturesPage,
  head: () => ({
    meta: [
      { title: 'Fitur publik — Cairn' },
      {
        name: 'description',
        content: 'Daftar fitur dan node progres tugas (snapshot publik, tanpa login).',
      },
    ],
  }),
})

function PublicFeaturesPage() {
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
  const pin = useMemo(() => pinViewFromPublicSnapshot(snap, boardId), [snap, boardId])

  return (
    <div className="wrap" data-testid="public-features-page" data-board-id={boardId}>
      <section className={styles.root} data-testid="public-features-list">
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Publik · Tanpa login</p>
            <h1 className={styles.pageTitle}>Fitur / Alur</h1>
            <p className={styles.pageSub}>
              Daftar fitur dari snapshot publik board <code>{boardId}</code>. Klik fitur untuk
              melihat node progres tugas nyata (featureContractId) — tidak memerlukan sesi board.
            </p>
          </div>
          <div className={styles.summaryStrip}>
            <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="public-features-count">
              {rows.length} fitur
            </span>
            {pin ? (
              <span className={styles.chip} title={pin.canonicalSnapshotId}>
                pin · rev {pin.boardRev}
              </span>
            ) : null}
            <button type="button" className={styles.retryBtn} onClick={() => void load()}>
              Muat ulang
            </button>
          </div>
        </header>

        {loading && !snap ? (
          <p className={styles.empty} data-testid="public-features-loading" role="status">
            Memuat snapshot publik…
          </p>
        ) : null}

        {error ? (
          <div
            className={`${styles.banner} ${styles.banner_error}`}
            role="alert"
            data-testid="public-features-error"
          >
            <p className={styles.bannerTitle}>Snapshot publik tidak tersedia</p>
            <p className={styles.bannerBody}>{error}</p>
            <button type="button" className={styles.retryBtn} onClick={() => void load()}>
              Coba lagi
            </button>
          </div>
        ) : null}

        {!loading && !error && rows.length === 0 ? (
          <p className={styles.empty} data-testid="public-features-empty">
            Tidak ada fitur pada snapshot publik ini (jujur kosong).
          </p>
        ) : null}

        {rows.length > 0 ? (
          <ul className={styles.cardList}>
            {rows.map((row) => {
              const stageEntries = Object.entries(row.stageCounts).sort((a, b) => b[1] - a[1])
              const reviewCount = row.progressNodes.filter((n) => n.contentReviewRequired).length
              return (
                <li
                  key={row.featureId}
                  className={styles.card}
                  data-testid="public-feature-row"
                  data-feature-id={row.featureId}
                >
                  <div className={styles.progressNodeHead}>
                    <Link
                      to="/public/features/$featureId"
                      params={{ featureId: row.featureId }}
                      search={{ boardId }}
                      className={styles.progressNodeTitle}
                      data-testid="public-feature-link"
                    >
                      {row.name}
                    </Link>
                    <code className={styles.progressNodeId}>{row.featureId}</code>
                  </div>
                  <div className={styles.progressNodeMeta}>
                    <span className={styles.chip}>{row.taskCount} tugas</span>
                    {row.phase ? <span className={styles.chip}>Fase {row.phase}</span> : null}
                    {row.projectId ? (
                      <span className={styles.chip} title={row.projectId}>
                        Proyek {row.projectId}
                      </span>
                    ) : null}
                    {reviewCount > 0 ? (
                      <span className={styles.progressContentReview}>
                        {reviewCount} perlu peninjauan konten
                      </span>
                    ) : null}
                  </div>
                  {stageEntries.length > 0 ? (
                    <div className={styles.stageChipStrip} style={{ marginTop: 10 }}>
                      {stageEntries.map(([stage, count]) => (
                        <span key={stage} className={styles.stageChip} title={stage}>
                          {formatLifecycleStageLabel(stage)} · {count}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className={styles.pageSub} style={{ marginTop: 10, marginBottom: 0 }}>
                    <Link
                      to="/public/features/$featureId"
                      params={{ featureId: row.featureId }}
                      search={{ boardId }}
                      data-testid="public-feature-open"
                    >
                      Buka detail progres →
                    </Link>
                  </p>
                </li>
              )
            })}
          </ul>
        ) : null}

        <p className={styles.pageSub} data-testid="public-features-note">
          Surface board lengkap (Overview/Work) tetap memerlukan login (RBAC). URL daftar publik:{' '}
          <code>{publicFeaturesListHref(boardId)}</code>
        </p>
      </section>
    </div>
  )
}
