/**
 * Public unauthenticated features list (01A public surface).
 * Loads allowlisted /api/public-snapshot — no board session required.
 * W-UI-QW: always-visible cards, client search + project filter, §4.3 card hierarchy.
 */
import { Link, createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import styles from '#/components/control-center/features/features.module.css'
import type { FeatureRowView } from '#/components/control-center/features/types'
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

/** Lifecycle stages treated as progressed for the mini bar (semantic green). */
const PROGRESSED_STAGES = new Set([
  'MAPPED',
  'MAP_VERIFIED',
  'BUILT',
  'FUNCTIONAL',
  'INTEGRATED',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
])

function miniProgress(row: FeatureRowView): {
  total: number
  done: number
  pct: number
} {
  const sumStages = Object.values(row.stageCounts).reduce((s, n) => s + n, 0)
  const total = row.taskCount > 0 ? row.taskCount : sumStages
  if (total <= 0) return { total: 0, done: 0, pct: 0 }
  let done = 0
  for (const [stage, count] of Object.entries(row.stageCounts)) {
    if (PROGRESSED_STAGES.has(stage)) done += count
  }
  const pct = Math.min(100, Math.round((done / total) * 100))
  return { total, done, pct }
}

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
  const [query, setQuery] = useState('')
  const [projectFilter, setProjectFilter] = useState<string | null>(null)

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

  const projectIds = useMemo(() => {
    const set = new Set<string>()
    for (const r of rows) {
      if (r.projectId && r.projectId.trim()) set.add(r.projectId.trim())
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [rows])

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase()
    return rows.filter((row) => {
      if (projectFilter && row.projectId !== projectFilter) return false
      if (!q) return true
      const name = row.name.toLowerCase()
      const id = row.featureId.toLowerCase()
      return name.includes(q) || id.includes(q)
    })
  }, [rows, query, projectFilter])

  return (
    <div className="wrap" data-testid="public-features-page" data-board-id={boardId}>
      <section className={styles.root} data-testid="public-features-list">
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Publik · Tanpa login</p>
            <h1 className={styles.pageTitle}>Fitur / Alur</h1>
            <p className={styles.pageSub}>
              Daftar fitur dari snapshot publik board <code>{boardId}</code>. Klik fitur untuk
              melihat node progres tugas — tidak memerlukan sesi board.
            </p>
          </div>
          <div className={styles.summaryStrip}>
            <span
              className={`${styles.chip} ${styles.chipAccent}`}
              data-testid="public-features-count"
            >
              {filtered.length}
              {filtered.length !== rows.length ? ` / ${rows.length}` : ''} fitur
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

        {rows.length > 0 ? (
          <div className={styles.filterBar} data-testid="public-features-filters">
            <label className="sr-only" htmlFor="public-features-search">
              Cari fitur
            </label>
            <input
              id="public-features-search"
              type="search"
              className={styles.searchInput}
              placeholder="Cari fitur…"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              autoComplete="off"
              data-testid="public-features-search"
            />
            <div
              className={styles.projectChips}
              role="group"
              aria-label="Filter proyek"
              data-testid="public-features-project-filters"
            >
              <button
                type="button"
                className={`${styles.projectChip}${projectFilter == null ? ` ${styles.projectChipActive}` : ''}`}
                aria-pressed={projectFilter == null}
                onClick={() => setProjectFilter(null)}
                data-testid="public-features-project-all"
              >
                Semua proyek
              </button>
              {projectIds.map((pid) => (
                <button
                  key={pid}
                  type="button"
                  className={`${styles.projectChip}${projectFilter === pid ? ` ${styles.projectChipActive}` : ''}`}
                  aria-pressed={projectFilter === pid}
                  title={pid}
                  onClick={() => setProjectFilter(pid)}
                  data-testid="public-features-project-chip"
                  data-project-id={pid}
                >
                  {pid}
                </button>
              ))}
            </div>
          </div>
        ) : null}

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

        {!loading && !error && rows.length > 0 && filtered.length === 0 ? (
          <p className={styles.empty} data-testid="public-features-zero-filter">
            Tidak ada fitur yang cocok dengan pencarian/filter.
          </p>
        ) : null}

        {filtered.length > 0 ? (
          <ul
            className={`${styles.cardList} ${styles.cardListAlways}`}
            data-testid="public-features-card-list"
          >
            {filtered.map((row) => {
              const stageEntries = Object.entries(row.stageCounts).sort((a, b) => b[1] - a[1])
              const reviewCount = row.progressNodes.filter((n) => n.contentReviewRequired).length
              const prog = miniProgress(row)
              const fillClass =
                prog.pct <= 0
                  ? styles.miniProgressFillEmpty
                  : prog.pct < 100
                    ? styles.miniProgressFillPartial
                    : ''
              return (
                <li
                  key={row.featureId}
                  className={styles.card}
                  data-testid="public-feature-row"
                  data-feature-id={row.featureId}
                >
                  {/* §4.3: nama bold → mini bar → meta → chip (tanpa ID teknis di permukaan) */}
                  <p className={styles.cardName}>
                    <Link
                      to="/public/features/$featureId"
                      params={{ featureId: row.featureId }}
                      search={{ boardId }}
                      data-testid="public-feature-link"
                    >
                      {row.name}
                    </Link>
                  </p>
                  <div
                    className={styles.miniProgress}
                    data-testid="public-feature-progress"
                    title={`${prog.done}/${prog.total} tahap lanjut (${prog.pct}%)`}
                  >
                    <div className={styles.miniProgressTrack} aria-hidden="true">
                      <div
                        className={`${styles.miniProgressFill}${fillClass ? ` ${fillClass}` : ''}`}
                        style={{ width: `${prog.pct}%` }}
                      />
                    </div>
                    <span className={styles.miniProgressMeta}>
                      {prog.total > 0
                        ? `${prog.done}/${prog.total} (${prog.pct}%)`
                        : '0 tugas'}
                    </span>
                  </div>
                  <div className={styles.progressNodeMeta}>
                    <span className={styles.chip}>{row.taskCount} tugas</span>
                    {row.phase ? <span className={styles.chip}>Fase {row.phase}</span> : null}
                    {row.projectId ? (
                      <span className={styles.chip} title={row.projectId}>
                        {row.projectId}
                      </span>
                    ) : null}
                    {reviewCount > 0 ? (
                      <span className={styles.progressContentReview}>
                        {reviewCount} perlu tinjauan
                      </span>
                    ) : null}
                  </div>
                  {stageEntries.length > 0 ? (
                    <div className={styles.stageChipStrip} style={{ marginTop: 2 }}>
                      {stageEntries.slice(0, 4).map(([stage, count]) => (
                        <span key={stage} className={styles.stageChip} title={stage}>
                          {formatLifecycleStageLabel(stage)} · {count}
                        </span>
                      ))}
                    </div>
                  ) : null}
                  <p className={styles.pageSub} style={{ marginTop: 4, marginBottom: 0 }}>
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
          Surface board lengkap memerlukan login. URL daftar publik:{' '}
          <code>{publicFeaturesListHref(boardId)}</code>
        </p>
      </section>
    </div>
  )
}
