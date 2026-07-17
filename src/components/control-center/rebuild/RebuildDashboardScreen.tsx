/**
 * FAN-REBUILD — Rebuild dashboard · Direction B (presentation only).
 * SPEC §3.A + §4 + ADDENDUM V1.1 §B. Blindspot via BlindspotTracer.
 * Prop-driven; no client recomputation of denominators beyond display formatting.
 * All copy id-ID. Compose #/components/ui primitives + design tokens only.
 */
import { useMemo, useState } from 'react'

import type {
  RebuildChipTone,
  RebuildDashboardData,
  RebuildDomainRow,
  RebuildFeatureCard,
  RebuildHistoryPoint,
} from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  Skeleton,
  StatusChip,
  Table,
  Tabs,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { BlindspotTracer } from './BlindspotTracer'
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
  /** Blindspot tracer (W-UI-4): injectable for tests; default hits /api/rebuild-parity?view=blindspot. */
  onTraceBlindspot?: (term: string) => Promise<unknown>
  className?: string
}

const PAGE_SIZE_DEFAULT = 25

function chipToneToVariant(tone: RebuildChipTone): StatusChipVariant {
  if (tone === 'ok') return 'done'
  if (tone === 'warn') return 'warn'
  if (tone === 'blocked') return 'blocked'
  return 'pending'
}

/** Inline SVG sparkline — monochrome Direction B; no chart library. */
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
          <stop offset="0%" stopColor="var(--text)" stopOpacity="0.12" />
          <stop offset="100%" stopColor="var(--text)" stopOpacity="0.01" />
        </linearGradient>
      </defs>
      {areaD ? <path d={areaD} fill="url(#rbSparkFill)" /> : null}
      <path
        d={lineD}
        fill="none"
        stroke="var(--text)"
        strokeWidth="1.5"
        strokeLinejoin="round"
        strokeLinecap="round"
      />
      {coords.length > 0 ? (
        <circle
          cx={coords[coords.length - 1]!.x}
          cy={coords[coords.length - 1]!.y}
          r="3"
          fill="var(--text)"
        />
      ) : null}
    </svg>
  )
}

function FeatureCard({ card }: { card: RebuildFeatureCard }) {
  const progressLabel =
    card.mappedPct != null
      ? `${card.mapped100}/${card.measuredN} (${card.mappedPct}%)`
      : `${card.mapped100}/${card.measuredN}`

  return (
    <a
      className={styles.featureCard}
      href={card.detailHref}
      data-testid="rebuild-feature-card"
      data-feature-id={card.featureId}
    >
      <div className={styles.featureName}>{card.namaId}</div>
      <div className={styles.featureId} title={card.featureId}>
        {card.featureId}
      </div>
      <ProgressBar
        value={card.mapped100}
        max={card.measuredN || 0}
        label={progressLabel}
      />
      <div className={styles.featureMeta}>
        {card.taskCount} task · {card.unitCount} unit
      </div>
      <Badge variant="neutral">{card.domainBisnis}</Badge>
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

function DomainTablePanel({ domains }: { domains: Array<RebuildDomainRow> }) {
  const [search, setSearch] = useState('')
  const [onlyWithFeatures, setOnlyWithFeatures] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return domains.filter((d) => {
      if (onlyWithFeatures && d.featureCount <= 0) return false
      if (!q) return true
      return d.domainBisnis.toLowerCase().includes(q)
    })
  }, [domains, search, onlyWithFeatures])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const columns: Array<TableColumn<RebuildDomainRow>> = [
    {
      id: 'domain',
      header: 'Domain',
      cell: (row) => (
        <span className={styles.domainName}>{row.domainBisnis}</span>
      ),
    },
    {
      id: 'features',
      header: 'Fitur',
      align: 'right',
      mono: true,
      cell: (row) => row.featureCount,
    },
    {
      id: 'tasks',
      header: 'Task',
      align: 'right',
      mono: true,
      cell: (row) => row.taskCount,
    },
    {
      id: 'proven',
      header: 'Terbukti pindah',
      cell: (row) => {
        const label =
          row.mappedPct != null
            ? `${row.mapped100}/${row.measuredN} (${row.mappedPct}%)`
            : `${row.mapped100}/${row.measuredN}`
        return (
          <div className={styles.progressCell}>
            <ProgressBar
              value={row.mapped100}
              max={row.measuredN || 0}
              label={label}
            />
          </div>
        )
      },
    },
  ]

  return (
    <Card
      data-testid="rebuild-domain-table-section"
      title="Per domain bisnis"
      subtitle={
        domains.length
          ? `${domains.length} domain pada snapshot parity`
          : 'Domain bisnis terlacak'
      }
      flush
    >
      <div className={styles.tableToolbar}>
        <Toolbar
          searchProps={{
            value: search,
            onChange: (e) => {
              setSearch(e.target.value)
              setPage(1)
            },
            placeholder: 'Cari domain…',
            'aria-label': 'Cari domain',
          }}
          filters={
            <>
              <Pill
                active={!onlyWithFeatures}
                onClick={() => {
                  setOnlyWithFeatures(false)
                  setPage(1)
                }}
              >
                Semua
              </Pill>
              <Pill
                active={onlyWithFeatures}
                onClick={() => {
                  setOnlyWithFeatures(true)
                  setPage(1)
                }}
              >
                Ada fitur
              </Pill>
            </>
          }
        />
      </div>
      <Table
        data-testid="rebuild-domain-table"
        columns={columns}
        rows={pageRows}
        rowKey={(r) => r.domainBisnis}
        empty="Tidak ada domain yang cocok."
        caption="Per domain bisnis"
        aria-label="Tabel per domain bisnis"
      />
      {filtered.length > 0 ? (
        <div className={styles.tableFooter}>
          <Pagination
            page={safePage}
            pageSize={pageSize}
            total={filtered.length}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n)
              setPage(1)
            }}
          />
        </div>
      ) : null}
    </Card>
  )
}

function FeaturesByDomainPanel({ domains }: { domains: Array<RebuildDomainRow> }) {
  const firstWith = domains.find((d) => d.topFeatures.length > 0)

  return (
    <Card
      data-testid="rebuild-domain-features"
      title="Fitur teratas per domain"
      subtitle="Nama fitur human-readable; id teknis mono sekunder"
    >
      <div className={styles.domainBlocks}>
        {domains.map((d) => (
          <DomainExpand
            key={d.domainBisnis}
            row={d}
            defaultOpen={d.domainBisnis === firstWith?.domainBisnis}
          />
        ))}
      </div>
    </Card>
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
  const live = liveMessage ?? ''

  const domains: Array<RebuildDomainRow> = useMemo(() => {
    if (data?.available) return data.domains
    return []
  }, [data])

  const crumb = (
    <Breadcrumb
      items={[
        { label: 'Papan', href: `/b/${encodeURIComponent(boardId)}` },
        { label: 'Rebuild' },
      ]}
    />
  )

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
        <PageHeader
          breadcrumb={crumb}
          eyebrow="Kontrol rebuild"
          title="Rebuild"
          subtitle="Memuat data progres legacy→rebuild…"
        />
        <Card>
          <Skeleton height={28} width="40%" />
          <div className={styles.kpiHeroBar}>
            <Skeleton height={48} width="60%" />
          </div>
          <div className={styles.kpiHeroBar}>
            <Skeleton height={12} width="100%" />
          </div>
        </Card>
      </div>
    )
  }

  if (
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'
  ) {
    const title =
      surfaceState === 'forbidden'
        ? 'Akses ditolak'
        : surfaceState === 'disconnected'
          ? 'Koneksi terputus'
          : 'Gagal memuat'
    return (
      <div
        className={[styles.root, className].filter(Boolean).join(' ')}
        data-testid="rebuild-dashboard"
        data-surface={surfaceState}
      >
        <PageHeader
          breadcrumb={crumb}
          eyebrow="Kontrol rebuild"
          title="Rebuild"
        />
        <Card>
          <EmptyState
            title={title}
            description={errorMessage ?? 'Dasbor rebuild tidak dapat dimuat.'}
            action={
              onRetry ? (
                <Button type="button" variant="primary" onClick={onRetry}>
                  Coba lagi
                </Button>
              ) : undefined
            }
          />
          <div role="alert" className="sr-only">
            {title}. {errorMessage ?? 'Dasbor rebuild tidak dapat dimuat.'}
          </div>
        </Card>
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
        <PageHeader
          breadcrumb={crumb}
          eyebrow="Kontrol rebuild"
          title="Rebuild"
          subtitle="Progres terbukti pindah dari legacy ke rebuild."
        />
        <EmptyState
          data-testid="rebuild-empty-state"
          title={data.emptyStateLabelId}
          description="Layar ini siap menampilkan progres legacy→rebuild setelah tabel lineage dan product features diaktifkan. Tidak ada error — data belum tersedia."
        />
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
        <EmptyState
          data-testid="rebuild-empty-state"
          title="Data rebuild belum tersedia."
          description="Layar ini siap menampilkan progres legacy→rebuild setelah tabel lineage dan product features diaktifkan. Tidak ada error — data belum tersedia."
        />
      </div>
    )
  }

  const { kpi, freshness, disclaimerId, chips, history } = data

  return (
    <div
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="rebuild-dashboard"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {live || `${kpi.display} terbukti pindah · ${freshness.labelId}`}
      </div>

      <PageHeader
        breadcrumb={crumb}
        eyebrow="Kontrol rebuild"
        title="Rebuild"
        subtitle="Progres terbukti pindah dari legacy ke rebuild (bukti kode, bukan siap produksi)."
      />

      {/* 1. KPI hero + chip breakdown */}
      <Card
        data-testid="rebuild-kpi-hero"
        aria-labelledby="rebuild-kpi-label"
      >
        <KpiStat
          label={<span id="rebuild-kpi-label">{kpi.labelId}</span>}
          value={<span data-testid="rebuild-kpi-display">{kpi.display}</span>}
          hint={
            kpi.mappedPct != null
              ? `${kpi.mappedPct}% · ${freshness.labelId}`
              : freshness.labelId
          }
        />
        <div className={styles.kpiHeroBar} data-testid="rebuild-kpi-bar">
          <ProgressBar
            value={kpi.mapped100}
            max={kpi.totalN || 0}
            ok={kpi.mappedPct != null && kpi.mappedPct >= 100}
            label={
              kpi.mappedPct != null
                ? `${kpi.display} (${kpi.mappedPct}%)`
                : kpi.display
            }
          />
        </div>
        <div className={styles.kpiMeta}>
          <span data-testid="rebuild-freshness">{freshness.labelId}</span>
        </div>
        <p className={styles.disclaimer} data-testid="rebuild-disclaimer">
          {disclaimerId}
        </p>
        <div
          className={styles.kpiChipRow}
          role="list"
          aria-label="Rincian status parity"
          data-testid="rebuild-chip-row"
        >
          {chips.map((c) => (
            <span key={c.key} role="listitem" data-chip={c.key} data-tone={c.tone}>
              <StatusChip variant={chipToneToVariant(c.tone)} showDot>
                {c.labelId} {c.count}
              </StatusChip>
            </span>
          ))}
        </div>
        <Disclosure summary="Detail teknis" data-testid="rebuild-kpi-tech">
          <dl className={styles.techDl}>
            <dt>Papan</dt>
            <dd>{boardId}</dd>
            <dt>mapped100</dt>
            <dd>{kpi.mapped100}</dd>
            <dt>totalN</dt>
            <dd>{kpi.totalN}</dd>
            <dt>capturedAt</dt>
            <dd>{freshness.capturedAt ?? '—'}</dd>
            <dt>ageSeconds</dt>
            <dd>{freshness.ageSeconds ?? '—'}</dd>
          </dl>
        </Disclosure>
      </Card>

      {/* 2. Trend sparkline */}
      <Card data-testid="rebuild-trend" title="Tren terbukti pindah">
        <Tabs
          defaultValue="chart"
          items={[
            {
              id: 'chart',
              label: 'Grafik',
              panel: <RebuildSparkline history={history} />,
            },
            {
              id: 'ringkas',
              label: 'Ringkas',
              panel: (
                <p className={styles.sparkEmpty}>
                  {history.length === 0
                    ? 'Belum ada riwayat pengukuran parity.'
                    : `${history.length} titik riwayat · terbaru ${
                        history[history.length - 1]?.mapped100 ?? '—'
                      }/${history[history.length - 1]?.totalN ?? '—'} terbukti pindah.`}
                </p>
              ),
            },
          ]}
        />
      </Card>

      {/* 3. Domain table + Toolbar + Pagination */}
      <DomainTablePanel domains={domains} />

      {/* 4. Top features per domain */}
      <FeaturesByDomainPanel domains={domains} />

      {/* 5. Blindspot tracer */}
      <BlindspotTracer boardId={boardId} onTrace={onTraceBlindspot} />
    </div>
  )
}
