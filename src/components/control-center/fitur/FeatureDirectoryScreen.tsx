/**
 * W-UI-2 — Direktori Fitur (produk, id-ID).
 * SPEC-TM-KOMPAT-VISUAL-V1 §1 IA, §3.B, §4.3 + ADDENDUM V1.1 §B.
 * Kartu: nama id-ID bold → mini bar terbukti pindah → meta task·unit·docs → chip domain.
 * TANPA ID teknis di permukaan kartu.
 */
import { useMemo, useState } from 'react'

import type {
  FeatureDirCard,
  FeatureDirectoryData,
  FeatureDirDomainGroup,
} from '#/server/control-center-rebuild-fns'
import styles from './fitur.module.css'

export type FiturSurfaceState =
  | 'loading'
  | 'populated'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'disconnected'

export type FeatureDirectoryScreenProps = {
  boardId: string
  data: FeatureDirectoryData | null
  surfaceState: FiturSurfaceState
  errorMessage?: string | null
  onRetry?: () => void
  className?: string
}

function barWidthPct(mappedPct: number | null | undefined): string {
  if (mappedPct == null || !Number.isFinite(mappedPct)) return '0%'
  return `${Math.max(0, Math.min(100, mappedPct))}%`
}

function FeatureCard({ card }: { card: FeatureDirCard }) {
  return (
    <a
      className={styles.featureCard}
      href={card.detailHref}
      data-testid="fitur-card"
      data-feature-id={card.featureId}
    >
      <div className={styles.featureName}>{card.namaId}</div>
      <div className={styles.miniBarMeta}>
        <div className={styles.miniBarTrack} aria-hidden="true">
          <div
            className={styles.miniBarFill}
            style={{ width: barWidthPct(card.mappedPct) }}
          />
        </div>
        <span className={styles.miniBarNums}>
          {card.mapped100}/{card.measuredN}
          {card.mappedPct != null ? ` (${card.mappedPct}%)` : ''}
        </span>
      </div>
      <div className={styles.featureMeta}>
        {card.taskCount} task · {card.unitCount} unit · docs {card.docsOk ? '✓' : '–'}
      </div>
      <span className={styles.domainChip}>{card.domainBisnis}</span>
    </a>
  )
}

function EmptyMigratedState({ label }: { label: string }) {
  return (
    <div
      className={styles.emptyState}
      data-testid="fitur-directory-empty-state"
      role="status"
    >
      <div className={styles.emptyIcon} aria-hidden="true">
        ∅
      </div>
      <h2 className={styles.emptyTitle}>{label}</h2>
      <p className={styles.emptyBody}>
        Direktori fitur produk siap menampilkan 8 domain bisnis setelah tabel lineage
        dan product features diaktifkan. Tidak ada error — data belum tersedia.
      </p>
    </div>
  )
}

function filterDomains(
  domains: ReadonlyArray<FeatureDirDomainGroup>,
  q: string,
): Array<FeatureDirDomainGroup> {
  const needle = q.trim().toLowerCase()
  if (!needle) return [...domains]
  return domains
    .map((d) => ({
      ...d,
      features: d.features.filter(
        (f) =>
          f.namaId.toLowerCase().includes(needle) ||
          f.domainBisnis.toLowerCase().includes(needle),
      ),
      featureCount: 0,
    }))
    .map((d) => ({ ...d, featureCount: d.features.length }))
    .filter((d) => d.features.length > 0)
}

/**
 * Product feature directory — control-center only.
 */
export function FeatureDirectoryScreen({
  boardId,
  data,
  surfaceState,
  errorMessage,
  onRetry,
  className,
}: FeatureDirectoryScreenProps) {
  const [query, setQuery] = useState('')

  const filtered = useMemo(() => {
    if (!data?.available) return [] as Array<FeatureDirDomainGroup>
    return filterDomains(data.domains, query)
  }, [data, query])

  const visibleCount = useMemo(
    () => filtered.reduce((n, d) => n + d.features.length, 0),
    [filtered],
  )

  if (surfaceState === 'loading' && !data) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-directory"
        data-surface="loading"
      >
        <div className={styles.liveRegion} aria-live="polite">
          Memuat direktori fitur…
        </div>
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Produk</p>
            <h1 className={styles.pageTitle}>Fitur</h1>
            <p className={styles.pageSub}>Memuat direktori fitur per domain bisnis…</p>
          </div>
        </header>
      </div>
    )
  }

  if (
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'
  ) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-directory"
        data-surface={surfaceState}
      >
        <div className={`${styles.banner} ${styles.banner_error}`} role="alert">
          <p className={styles.bannerTitle}>
            {surfaceState === 'forbidden'
              ? 'Akses ditolak'
              : surfaceState === 'disconnected'
                ? 'Koneksi terputus'
                : 'Gagal memuat'}
          </p>
          <p className={styles.bannerBody}>
            {errorMessage ?? 'Direktori fitur tidak dapat dimuat.'}
          </p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-directory"
        data-surface="empty-migrated"
        data-available="false"
      >
        <div className={styles.liveRegion} aria-live="polite">
          {data.emptyStateLabelId}
        </div>
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Produk</p>
            <h1 className={styles.pageTitle}>Fitur</h1>
            <p className={styles.pageSub}>
              Direktori fitur produk dikelompokkan per domain bisnis.
            </p>
          </div>
          <div className={styles.headMeta}>
            <a
              className={styles.secondaryLink}
              href={data.technicalFcHref}
              data-testid="fitur-technical-fc-link"
            >
              Kontrak teknis (FC)
            </a>
          </div>
        </header>
        <EmptyMigratedState label={data.emptyStateLabelId} />
      </div>
    )
  }

  if (!data || !data.available) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="fitur-directory"
        data-surface="empty"
      >
        <EmptyMigratedState label="Data fitur produk belum tersedia." />
      </div>
    )
  }

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="fitur-directory"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {data.featureCount} fitur · {visibleCount} ditampilkan
      </div>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>Produk</p>
          <h1 className={styles.pageTitle}>Fitur</h1>
          <p className={styles.pageSub}>
            Direktori fitur produk (nama manusia) dikelompokkan per domain bisnis.
            Progres mini-bar = terbukti pindah (bukti kode).
          </p>
        </div>
        <div className={styles.headMeta}>
          <a
            className={styles.secondaryLink}
            href={data.technicalFcHref}
            data-testid="fitur-technical-fc-link"
          >
            Kontrak teknis (FC)
          </a>
        </div>
      </header>

      <div className={styles.searchRow}>
        <label className="sr-only" htmlFor="fitur-directory-search">
          Cari fitur
        </label>
        <input
          id="fitur-directory-search"
          className={styles.searchInput}
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Cari fitur…"
          data-testid="fitur-directory-search"
          autoComplete="off"
        />
        <span className={styles.searchMeta} data-testid="fitur-directory-count">
          {visibleCount}
          {query.trim() ? ` / ${data.featureCount}` : ''} fitur
        </span>
      </div>

      {filtered.length === 0 ? (
        <p className={styles.panelEmpty} data-testid="fitur-directory-no-match">
          Tidak ada fitur yang cocok dengan pencarian.
        </p>
      ) : (
        filtered.map((group) => (
          <section
            key={group.domainBisnis}
            className={styles.domainSection}
            data-testid="fitur-domain-group"
            data-domain={group.domainBisnis}
          >
            <div className={styles.domainHead}>
              <h2 className={styles.domainTitle}>{group.domainBisnis}</h2>
              <span className={styles.domainMeta}>
                {group.featureCount} fitur
              </span>
            </div>
            {group.features.length === 0 ? (
              <p className={styles.domainEmpty}>Belum ada fitur di domain ini.</p>
            ) : (
              <div className={styles.featureGrid} data-testid="fitur-card-grid">
                {group.features.map((card) => (
                  <FeatureCard key={card.featureId} card={card} />
                ))}
              </div>
            )}
          </section>
        ))
      )}
    </div>
  )
}
