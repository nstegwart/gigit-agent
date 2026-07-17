/**
 * W-UI-1 Rebuild dashboard — SPEC §3.A + §4 + ADDENDUM V1.1 §B (3 bars later on feature 360).
 * Prop-driven; no client recomputation of denominators beyond display formatting.
 * All copy id-ID. Semantic colors only via CSS tokens.
 */
import { useCallback, useMemo, useState, type FormEvent } from 'react'

import type {
  RebuildChipTone,
  RebuildDashboardData,
  RebuildDomainRow,
  RebuildFeatureCard,
  RebuildHistoryPoint,
} from '#/server/control-center-rebuild-fns'
import styles from './rebuild.module.css'

export type RebuildSurfaceState =
  | 'loading'
  | 'populated'
  | 'empty'
  | 'error'
  | 'forbidden'
  | 'disconnected'

export type RebuildDashboardScreenProps = {
  boardId: string
  data: RebuildDashboardData | null
  surfaceState: RebuildSurfaceState
  liveMessage?: string
  errorMessage?: string | null
  onRetry?: () => void
  /** Blindspot: fetch via /api/rebuild-parity?view=blindspot (W-API-1). Injectable for tests. */
  onTraceBlindspot?: (term: string) => Promise<unknown>
  className?: string
}

function chipClass(tone: RebuildChipTone): string {
  if (tone === 'ok') return `${styles.chip} ${styles.chipOk}`
  if (tone === 'warn') return `${styles.chip} ${styles.chipWarn}`
  if (tone === 'blocked') return `${styles.chip} ${styles.chipBlocked}`
  return `${styles.chip} ${styles.chipMuted}`
}

function barWidthPct(mappedPct: number | null | undefined): string {
  if (mappedPct == null || !Number.isFinite(mappedPct)) return '0%'
  return `${Math.max(0, Math.min(100, mappedPct))}%`
}

/** Inline SVG sparkline — no chart library (WORKER_CONTRACT). */
export function RebuildSparkline({
  history,
  width = 480,
  height = 72,
}: {
  history: ReadonlyArray<RebuildHistoryPoint>
  width?: number
  height?: number
}) {
  if (history.length === 0) {
    return (
      <p className={styles.sparkEmpty} data-testid="rebuild-sparkline-empty">
        Belum ada riwayat pengukuran parity.
      </p>
    )
  }

  const padX = 4
  const padY = 8
  const innerW = width - padX * 2
  const innerH = height - padY * 2
  const values = history.map((h) => {
    if (h.mappedPct != null) return h.mappedPct
    if (h.totalN > 0) return (h.mapped100 / h.totalN) * 100
    return 0
  })
  const minV = Math.min(...values, 0)
  const maxV = Math.max(...values, 100)
  const span = maxV - minV || 1

  const coords = values.map((v, i) => {
    const x =
      values.length === 1
        ? padX + innerW / 2
        : padX + (i / (values.length - 1)) * innerW
    const y = padY + innerH - ((v - minV) / span) * innerH
    return { x, y }
  })

  const lineD = coords
    .map((c, i) => `${i === 0 ? 'M' : 'L'} ${c.x.toFixed(1)} ${c.y.toFixed(1)}`)
    .join(' ')
  const areaD =
    coords.length > 0
      ? `${lineD} L ${coords[coords.length - 1]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} L ${coords[0]!.x.toFixed(1)} ${(padY + innerH).toFixed(1)} Z`
      : ''

  return (
    <svg
      className={styles.sparkline}
      viewBox={`0 0 ${width} ${height}`}
      role="img"
      aria-label="Tren terbukti pindah dari riwayat parity"
      data-testid="rebuild-sparkline"
    >
      <defs>
        <linearGradient id="rbSparkFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="var(--ok, #067647)" stopOpacity="0.28" />
          <stop offset="100%" stopColor="var(--ok, #067647)" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {areaD ? <path d={areaD} fill="url(#rbSparkFill)" /> : null}
      <path
        d={lineD}
        fill="none"
        stroke="var(--ok, #067647)"
        strokeWidth="2"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {coords.length > 0 ? (
        <circle
          cx={coords[coords.length - 1]!.x}
          cy={coords[coords.length - 1]!.y}
          r="3.5"
          fill="var(--ok, #067647)"
        />
      ) : null}
    </svg>
  )
}

function FeatureCard({ card }: { card: RebuildFeatureCard }) {
  return (
    <a
      className={styles.featureCard}
      href={card.detailHref}
      data-testid="rebuild-feature-card"
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
        {card.taskCount} task · {card.unitCount} unit
      </div>
      <span className={styles.domainChip}>{card.domainBisnis}</span>
    </a>
  )
}

function DomainExpand({
  row,
  defaultOpen = false,
}: {
  row: RebuildDomainRow
  defaultOpen?: boolean
}) {
  const [open, setOpen] = useState(defaultOpen)
  return (
    <div
      className={styles.domainBlock}
      data-testid="rebuild-domain-block"
      data-domain={row.domainBisnis}
    >
      <button
        type="button"
        className={styles.domainToggle}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
        data-testid="rebuild-domain-toggle"
      >
        <span className={styles.domainToggleTitle}>{row.domainBisnis}</span>
        <span className={styles.domainToggleMeta}>
          {row.featureCount} fitur · {row.taskCount} task
        </span>
        <span
          className={`${styles.chevron} ${open ? styles.chevronOpen : ''}`}
          aria-hidden="true"
        >
          ▾
        </span>
      </button>
      {open ? (
        row.topFeatures.length > 0 ? (
          <div className={styles.featureGrid} data-testid="rebuild-feature-grid">
            {row.topFeatures.map((f) => (
              <FeatureCard key={f.featureId} card={f} />
            ))}
          </div>
        ) : (
          <p className={styles.featureEmpty}>Belum ada fitur di domain ini.</p>
        )
      ) : null}
    </div>
  )
}

function EmptyMigratedState({ label }: { label: string }) {
  return (
    <div
      className={styles.emptyState}
      data-testid="rebuild-empty-state"
      role="status"
    >
      <div className={styles.emptyIcon} aria-hidden="true">
        ∅
      </div>
      <h2 className={styles.emptyTitle}>{label}</h2>
      <p className={styles.emptyBody}>
        Layar ini siap menampilkan progres legacy→rebuild setelah tabel lineage dan
        product features diaktifkan. Tidak ada error — data belum tersedia.
      </p>
    </div>
  )
}

/**
 * Rebuild progress dashboard (control-center only).
 */
export function RebuildDashboardScreen({
  boardId,
  data,
  surfaceState,
  liveMessage,
  errorMessage,
  onRetry,
  onTraceBlindspot,
  className,
}: RebuildDashboardScreenProps) {
  const [term, setTerm] = useState('')
  const [traceLoading, setTraceLoading] = useState(false)
  const [traceJson, setTraceJson] = useState<string | null>(null)
  const [traceError, setTraceError] = useState<string | null>(null)

  const defaultTrace = useCallback(
    async (q: string) => {
      const params = new URLSearchParams({
        view: 'blindspot',
        boardId,
        term: q,
      })
      const res = await fetch(`/api/rebuild-parity?${params.toString()}`, {
        credentials: 'same-origin',
        headers: { accept: 'application/json' },
      })
      const body = (await res.json().catch(() => null)) as unknown
      return body
    },
    [boardId],
  )

  const runTrace = useCallback(
    async (e?: FormEvent) => {
      e?.preventDefault()
      const q = term.trim()
      if (!q) return
      setTraceLoading(true)
      setTraceError(null)
      try {
        const fn = onTraceBlindspot ?? defaultTrace
        const body = await fn(q)
        setTraceJson(JSON.stringify(body, null, 2))
      } catch {
        setTraceError('Gagal menelusuri blindspot. Coba lagi nanti.')
        setTraceJson(null)
      } finally {
        setTraceLoading(false)
      }
    },
    [term, onTraceBlindspot, defaultTrace],
  )

  const live = liveMessage ?? ''

  const domains: Array<RebuildDomainRow> = useMemo(() => {
    if (data?.available) return data.domains
    return []
  }, [data])

  if (surfaceState === 'loading' && !data) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="rebuild-dashboard"
        data-surface="loading"
      >
        <div className={styles.liveRegion} aria-live="polite">
          Memuat dasbor rebuild…
        </div>
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Kontrol rebuild</p>
            <h1 className={styles.pageTitle}>Rebuild</h1>
            <p className={styles.pageSub}>Memuat data progres legacy→rebuild…</p>
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
        data-testid="rebuild-dashboard"
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
            {errorMessage ?? 'Dasbor rebuild tidak dapat dimuat.'}
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

  // Graceful: tables not migrated
  if (data && !data.available) {
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="rebuild-dashboard"
        data-surface="empty-migrated"
        data-available="false"
      >
        <div className={styles.liveRegion} aria-live="polite">
          {data.emptyStateLabelId}
        </div>
        <header className={styles.pageHead}>
          <div>
            <p className={styles.eyebrow}>Kontrol rebuild</p>
            <h1 className={styles.pageTitle}>Rebuild</h1>
            <p className={styles.pageSub}>
              Progres terbukti pindah dari legacy ke rebuild.
            </p>
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
        data-testid="rebuild-dashboard"
        data-surface="empty"
      >
        <EmptyMigratedState label="Data rebuild belum tersedia." />
      </div>
    )
  }

  const { kpi, freshness, disclaimerId, chips, history } = data
  const firstDomainWithFeatures = domains.find((d) => d.topFeatures.length > 0)

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="rebuild-dashboard"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {live ||
          `${kpi.display} terbukti pindah · ${freshness.labelId}`}
      </div>

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>Kontrol rebuild</p>
          <h1 className={styles.pageTitle}>Rebuild</h1>
          <p className={styles.pageSub}>
            Progres terbukti pindah dari legacy ke rebuild (bukti kode, bukan siap
            produksi).
          </p>
        </div>
      </header>

      {/* 1. KPI hero */}
      <section
        className={styles.kpiHero}
        aria-labelledby="rebuild-kpi-label"
        data-testid="rebuild-kpi-hero"
      >
        <div className={styles.kpiDisplay} data-testid="rebuild-kpi-display">
          {kpi.display}
        </div>
        <p className={styles.kpiLabel} id="rebuild-kpi-label">
          {kpi.labelId}
          {kpi.mappedPct != null ? (
            <>
              {' '}
              <span className={styles.kpiPct}>({kpi.mappedPct}%)</span>
            </>
          ) : null}
        </p>
        <div className={styles.heroBarTrack} aria-hidden="true">
          <div
            className={styles.heroBarFill}
            style={{ width: barWidthPct(kpi.mappedPct) }}
            data-testid="rebuild-kpi-bar"
          />
        </div>
        <div className={styles.kpiMeta}>
          <span data-testid="rebuild-freshness">{freshness.labelId}</span>
        </div>
        <p className={styles.disclaimer} data-testid="rebuild-disclaimer">
          {disclaimerId}
        </p>
      </section>

      {/* 2. Semantic chips */}
      <div
        className={styles.chipRow}
        role="list"
        aria-label="Rincian status parity"
        data-testid="rebuild-chip-row"
      >
        {chips.map((c) => (
          <span
            key={c.key}
            className={chipClass(c.tone)}
            role="listitem"
            data-chip={c.key}
            data-tone={c.tone}
          >
            {c.labelId}
            <span className={styles.chipCount}>{c.count}</span>
          </span>
        ))}
      </div>

      {/* 3. Trend sparkline */}
      <section className={styles.trendCard} data-testid="rebuild-trend">
        <h2 className={styles.sectionTitle}>Tren terbukti pindah</h2>
        <RebuildSparkline history={history} />
      </section>

      {/* 4. Domain table */}
      <section data-testid="rebuild-domain-table-section">
        <h2 className={styles.sectionTitle}>Per domain bisnis</h2>
        <div className={styles.tableWrap}>
          <table className={styles.domainTable} data-testid="rebuild-domain-table">
            <thead>
              <tr>
                <th scope="col">Domain</th>
                <th scope="col">Fitur</th>
                <th scope="col">Task</th>
                <th scope="col">Terbukti pindah</th>
              </tr>
            </thead>
            <tbody>
              {domains.map((d) => (
                <tr key={d.domainBisnis} data-domain-row={d.domainBisnis}>
                  <td className={styles.domainName}>{d.domainBisnis}</td>
                  <td>{d.featureCount}</td>
                  <td>{d.taskCount}</td>
                  <td>
                    <div className={styles.miniBarMeta}>
                      <div className={styles.miniBarTrack} aria-hidden="true">
                        <div
                          className={styles.miniBarFill}
                          style={{ width: barWidthPct(d.mappedPct) }}
                        />
                      </div>
                      <span className={styles.miniBarNums}>
                        {d.mapped100}/{d.measuredN}
                        {d.mappedPct != null ? ` (${d.mappedPct}%)` : ''}
                      </span>
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {/* 5. Top features per domain (expand/collapse) */}
      <section data-testid="rebuild-domain-features">
        <h2 className={styles.sectionTitle}>Fitur teratas per domain</h2>
        <div className={styles.domainBlocks}>
          {domains.map((d) => (
            <DomainExpand
              key={d.domainBisnis}
              row={d}
              defaultOpen={d.domainBisnis === firstDomainWithFeatures?.domainBisnis}
            />
          ))}
        </div>
      </section>

      {/* 6. Blindspot tracer placeholder */}
      <section
        className={styles.tracerCard}
        data-testid="rebuild-blindspot-tracer"
        aria-labelledby="rebuild-tracer-title"
      >
        <h2 className={styles.sectionTitle} id="rebuild-tracer-title">
          Pelacak blindspot
        </h2>
        <form className={styles.tracerForm} onSubmit={runTrace}>
          <label className="sr-only" htmlFor="rebuild-blindspot-input">
            Telusuri akar masalah fitur
          </label>
          <input
            id="rebuild-blindspot-input"
            className={styles.tracerInput}
            type="search"
            value={term}
            onChange={(e) => setTerm(e.target.value)}
            placeholder="Telusuri akar masalah fitur…"
            data-testid="rebuild-blindspot-input"
            autoComplete="off"
          />
          <button
            type="submit"
            className={styles.tracerBtn}
            disabled={traceLoading || !term.trim()}
            data-testid="rebuild-blindspot-submit"
          >
            {traceLoading ? 'Menelusuri…' : 'Telusuri'}
          </button>
        </form>
        <p className={styles.tracerHint}>
          Placeholder W-UI-1 — hasil JSON dari{' '}
          <code>/api/rebuild-parity?view=blindspot</code>. UI penuh menyusul W-UI-4.
        </p>
        {traceError ? (
          <p className={styles.bannerBody} role="alert">
            {traceError}
          </p>
        ) : null}
        {traceJson ? (
          <pre
            className={styles.tracerPanel}
            data-testid="rebuild-blindspot-result"
          >
            {traceJson}
          </pre>
        ) : null}
      </section>
    </div>
  )
}
