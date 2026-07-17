/**
 * FAN-FITUR — Direktori Fitur (produk, id-ID) · Direction B.
 * Primitives: PageHeader, Card, Table, Toolbar, Pagination, EmptyState,
 * Button, Pill, Badge, ProgressBar, Disclosure, StatusChip.
 * Data/logic preserved — presentation only.
 */
import { useEffect, useMemo, useState, type ChangeEvent, type InputHTMLAttributes } from 'react'

import type {
  FeatureDirCard,
  FeatureDirectoryData,
  FeatureDirDomainGroup,
} from '#/server/control-center-rebuild-fns'
import {
  Badge,
  Button,
  Card,
  EmptyState,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  Table,
  Toolbar,
  type TableColumn,
} from '#/components/ui'
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

const PAGE_SIZE_DEFAULT = 25

function flattenFeatures(
  domains: ReadonlyArray<FeatureDirDomainGroup>,
): Array<FeatureDirCard> {
  return domains.flatMap((d) => d.features)
}

function filterFeatures(
  features: ReadonlyArray<FeatureDirCard>,
  q: string,
  domain: string | null,
): Array<FeatureDirCard> {
  const needle = q.trim().toLowerCase()
  return features.filter((f) => {
    if (domain && f.domainBisnis !== domain) return false
    if (!needle) return true
    return (
      f.namaId.toLowerCase().includes(needle) ||
      f.domainBisnis.toLowerCase().includes(needle)
    )
  })
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
  const [domainFilter, setDomainFilter] = useState<string | null>(null)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const allFeatures = useMemo(() => {
    if (!data?.available) return [] as Array<FeatureDirCard>
    return flattenFeatures(data.domains)
  }, [data])

  const domainOptions = useMemo(() => {
    if (!data?.available) return [] as string[]
    return data.domains.map((d) => d.domainBisnis)
  }, [data])

  const filtered = useMemo(
    () => filterFeatures(allFeatures, query, domainFilter),
    [allFeatures, query, domainFilter],
  )

  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const safePage = Math.min(page, pageCount)

  useEffect(() => {
    setPage(1)
  }, [query, domainFilter, pageSize])

  const pageRows = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, safePage, pageSize])

  const columns: Array<TableColumn<FeatureDirCard>> = useMemo(
    () => [
      {
        id: 'nama',
        header: 'Fitur',
        cell: (row) => (
          <div
            className={styles.entityTitle}
            data-testid="fitur-card"
            data-feature-id={row.featureId}
          >
            <a className={styles.featureLink} href={row.detailHref}>
              <span className={styles.entityName}>{row.namaId}</span>
            </a>
            <span className={styles.metaMuted}>
              {row.taskCount} task · {row.unitCount} unit ·{' '}
              {row.docsOk ? 'docs ✓' : 'docs –'}
            </span>
          </div>
        ),
      },
      {
        id: 'domain',
        header: 'Domain',
        cell: (row) => <Badge variant="neutral">{row.domainBisnis}</Badge>,
      },
      {
        id: 'tasks',
        header: 'Task',
        align: 'right',
        mono: true,
        cell: (row) => row.taskCount,
      },
      {
        id: 'units',
        header: 'Unit',
        align: 'right',
        mono: true,
        cell: (row) => row.unitCount,
      },
      {
        id: 'docs',
        header: 'Docs',
        cell: (row) => (row.docsOk ? '✓' : '–'),
      },
      {
        id: 'terbukti',
        header: 'Terbukti pindah',
        cell: (row) => (
          <div className={styles.tableProgress}>
            <ProgressBar
              value={row.mapped100}
              max={row.measuredN > 0 ? row.measuredN : 1}
              label={
                row.mappedPct != null
                  ? `${row.mapped100}/${row.measuredN} (${row.mappedPct}%)`
                  : `${row.mapped100}/${row.measuredN}`
              }
            />
          </div>
        ),
      },
    ],
    [],
  )

  const rootClass = [styles.root, className].filter(Boolean).join(' ')

  if (surfaceState === 'loading' && !data) {
    return (
      <div className={rootClass} data-testid="fitur-directory" data-surface="loading">
        <div className={styles.liveRegion} aria-live="polite">
          Memuat direktori fitur…
        </div>
        <PageHeader
          eyebrow="Produk"
          title="Fitur"
          subtitle="Memuat direktori fitur per domain bisnis…"
        />
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
      <div className={rootClass} data-testid="fitur-directory" data-surface={surfaceState}>
        <PageHeader eyebrow="Produk" title="Fitur" />
        <EmptyState
          title={title}
          description={errorMessage ?? 'Direktori fitur tidak dapat dimuat.'}
          action={
            onRetry ? (
              <Button type="button" variant="secondary" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : undefined
          }
        />
      </div>
    )
  }

  if (data && !data.available) {
    return (
      <div
        className={rootClass}
        data-testid="fitur-directory"
        data-surface="empty-migrated"
        data-available="false"
      >
        <div className={styles.liveRegion} aria-live="polite">
          {data.emptyStateLabelId}
        </div>
        <PageHeader
          eyebrow="Produk"
          title="Fitur"
          subtitle="Direktori fitur produk dikelompokkan per domain bisnis."
          actions={
            <a
              href={data.technicalFcHref}
              data-testid="fitur-technical-fc-link"
              className={styles.metaMuted}
            >
              Kontrak teknis (FC)
            </a>
          }
        />
        <EmptyState
          data-testid="fitur-directory-empty-state"
          title={data.emptyStateLabelId}
          description="Direktori fitur produk siap menampilkan domain bisnis setelah tabel lineage dan product features diaktifkan. Tidak ada error — data belum tersedia."
        />
      </div>
    )
  }

  if (!data || !data.available) {
    return (
      <div className={rootClass} data-testid="fitur-directory" data-surface="empty">
        <EmptyState
          data-testid="fitur-directory-empty-state"
          title="Data fitur produk belum tersedia."
          description="Direktori fitur produk siap menampilkan domain bisnis setelah data rebuild diaktifkan."
        />
      </div>
    )
  }

  return (
    <div
      className={rootClass}
      data-testid="fitur-directory"
      data-surface="populated"
      data-available="true"
      data-board-id={boardId}
    >
      <div className={styles.liveRegion} aria-live="polite">
        {data.featureCount} fitur · {filtered.length} ditampilkan
      </div>

      <PageHeader
        eyebrow="Produk"
        title="Fitur"
        subtitle="Direktori fitur produk (nama manusia) dikelompokkan per domain bisnis. Progres = terbukti pindah (bukti kode)."
        actions={
          <a
            href={data.technicalFcHref}
            data-testid="fitur-technical-fc-link"
            className={styles.metaMuted}
          >
            Kontrak teknis (FC)
          </a>
        }
      />

      <Card flush title="Daftar fitur" subtitle={`${filtered.length} dari ${data.featureCount} fitur`}>
        <div className={styles.stack}>
          <Toolbar
            searchProps={
              {
                id: 'fitur-directory-search',
                value: query,
                onChange: (e: ChangeEvent<HTMLInputElement>) =>
                  setQuery(e.target.value),
                placeholder: 'Cari fitur…',
                'aria-label': 'Cari fitur',
                autoComplete: 'off',
                'data-testid': 'fitur-directory-search',
              } as InputHTMLAttributes<HTMLInputElement>
            }
            filters={
              <>
                <Pill
                  active={domainFilter == null}
                  onClick={() => setDomainFilter(null)}
                  data-testid="fitur-domain-filter-all"
                >
                  Semua domain
                </Pill>
                {domainOptions.map((d) => (
                  <Pill
                    key={d}
                    active={domainFilter === d}
                    onClick={() =>
                      setDomainFilter((cur) => (cur === d ? null : d))
                    }
                    data-testid={`fitur-domain-filter-${d}`}
                  >
                    {d}
                  </Pill>
                ))}
              </>
            }
            actions={
              <span className={styles.countHint} data-testid="fitur-directory-count">
                {filtered.length}
                {query.trim() || domainFilter ? ` / ${data.featureCount}` : ''} fitur
              </span>
            }
          />

          {filtered.length === 0 ? (
            <EmptyState
              data-testid="fitur-directory-no-match"
              title="Tidak ada fitur yang cocok"
              description="Ubah kata kunci atau filter domain."
            />
          ) : (
            <>
              <Table
                columns={columns}
                rows={pageRows}
                rowKey={(r) => r.featureId}
                caption="Direktori fitur"
                aria-label="Tabel direktori fitur"
                empty="Tidak ada fitur."
              />
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={filtered.length}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
                data-testid="fitur-directory-pagination"
              />
            </>
          )}
        </div>
      </Card>
    </div>
  )
}
