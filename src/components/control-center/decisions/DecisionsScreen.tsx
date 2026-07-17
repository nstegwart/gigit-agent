/**
 * FAN-DECISIONS — Direction B "Keputusan" inbox.
 * Prop-driven (UI_CONTRACT §9). Server order preserved; presentation-only kit rebuild.
 */
import { useEffect, useMemo, useState } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import {
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  MonoCell,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  Skeleton,
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { DecisionCard } from './DecisionCard'
import { resolveDecisionOwnerDisplay } from './decisionActions'
import type { DecisionItemView, DecisionsScreenProps } from './types'
import styles from './decisions.module.css'

const PAGE_SIZE_DEFAULT = 25

type FilterKind = 'all' | 'blocking' | 'open'

type ScanRow = DecisionItemView & {
  primaryTitle: string
  technicalSecondary: string | null
}

function statusVariant(status: string): StatusChipVariant {
  const s = status.toUpperCase()
  if (s === 'RESOLVED') return 'done'
  if (s === 'OPEN') return 'ongoing'
  if (s === 'ACKNOWLEDGED') return 'next'
  if (s === 'REJECTED' || s === 'EXPIRED' || s === 'CANCELLED') return 'blocked'
  return 'pending'
}

function statusLabelId(status: string): string {
  const s = status.toUpperCase()
  if (s === 'OPEN') return 'Terbuka'
  if (s === 'ACKNOWLEDGED') return 'Diakui'
  if (s === 'RESOLVED') return 'Selesai'
  if (s === 'REJECTED') return 'Ditolak'
  if (s === 'EXPIRED') return 'Kedaluwarsa'
  if (s === 'CANCELLED') return 'Dibatalkan'
  return status
}

function severityLabelId(sev: string): string {
  const s = sev.toUpperCase()
  if (s === 'CRITICAL') return 'Kritis'
  if (s === 'HIGH') return 'Tinggi'
  if (s === 'MEDIUM') return 'Sedang'
  if (s === 'LOW') return 'Rendah'
  return sev
}

function displayOrDash(v: string | number | null | undefined): string {
  if (v === null || v === undefined || v === '') return '—'
  const s = String(v).trim()
  if (
    s === '0' ||
    s === '1970-01-01T00:00:00.000Z' ||
    s === '1970-01-01T00:00:00Z' ||
    s.startsWith('1970-01-01')
  ) {
    return '—'
  }
  return s
}

function filterItems(
  items: ReadonlyArray<DecisionItemView>,
  filter: FilterKind,
  needle: string,
): DecisionItemView[] {
  const n = needle.trim().toLocaleLowerCase('id-ID')
  // Preserve relative server order — filter only, never re-sort.
  return items.filter((item) => {
    if (filter === 'blocking' && !item.blocking) return false
    if (filter === 'open') {
      const s = String(item.status).toUpperCase()
      if (s !== 'OPEN' && s !== 'ACKNOWLEDGED') return false
    }
    if (!n) return true
    const owner = resolveDecisionOwnerDisplay(item)
    const blob = [
      owner.primaryTitle,
      owner.technicalTitle,
      item.decisionId,
      item.title,
      item.question ?? '',
      item.status,
      item.severity,
      item.type,
    ]
      .join('\n')
      .toLocaleLowerCase('id-ID')
    return blob.includes(n)
  })
}

/**
 * Prop-driven Decisions inbox (UI_CONTRACT §9).
 * Does not reorder items — server compareDecisionsV3 order is preserved.
 * No private comment/credential rendering.
 */
export function DecisionsScreen({
  surfaceState,
  boardId,
  items,
  openCount,
  blockingCount,
  pageSize,
  nextCursor,
  pin,
  error,
  projectionGaps,
  liveMessage,
  onRetry,
  onRefresh,
  className,
  canAct = true,
  pendingDecisionId = null,
  pendingAction = null,
  actionErrors,
  actions,
}: DecisionsScreenProps) {
  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<FilterKind>('all')
  const [page, setPage] = useState(1)
  const [clientPageSize, setClientPageSize] = useState(
    pageSize > 0 ? Math.min(pageSize, PAGE_SIZE_DEFAULT) : PAGE_SIZE_DEFAULT,
  )

  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const needsHuman = surfaceState === 'needs-human' || blockingCount > 0
  const pinAttrs = pinnedSurfaceDataAttrs(
    pin
      ? {
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
        }
      : null,
  )

  const filtered = useMemo(
    () => filterItems(items, filter, search),
    [items, filter, search],
  )

  useEffect(() => {
    setPage(1)
  }, [search, filter, items.length])

  const pageCount = Math.max(1, Math.ceil(filtered.length / clientPageSize))
  const safePage = Math.min(page, pageCount)
  const pageItems = filtered.slice(
    (safePage - 1) * clientPageSize,
    safePage * clientPageSize,
  )

  const scanRows: ScanRow[] = useMemo(
    () =>
      pageItems.map((item) => {
        const owner = resolveDecisionOwnerDisplay(item)
        const tech =
          owner.technicalTitle && owner.technicalTitle !== owner.primaryTitle
            ? owner.technicalTitle
            : item.decisionId !== owner.primaryTitle
              ? item.decisionId
              : null
        return {
          ...item,
          primaryTitle: owner.primaryTitle,
          technicalSecondary: tech,
        }
      }),
    [pageItems],
  )

  const columns: Array<TableColumn<ScanRow>> = [
    {
      id: 'title',
      header: 'Judul',
      cell: (row) => (
        <div className={styles.titleCell}>
          <span className={styles.titleText}>{row.primaryTitle}</span>
          {row.technicalSecondary ? (
            <span className={styles.techSecondary} title={row.technicalSecondary}>
              {row.technicalSecondary}
            </span>
          ) : null}
        </div>
      ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => (
        <StatusChip variant={statusVariant(row.status)}>
          {statusLabelId(row.status)}
        </StatusChip>
      ),
    },
    {
      id: 'severity',
      header: 'Tingkat',
      cell: (row) => severityLabelId(row.severity),
    },
    {
      id: 'blocking',
      header: 'Hambatan',
      cell: (row) =>
        row.blocking ? (
          <StatusChip variant="blocked" showDot>
            Menghambat
          </StatusChip>
        ) : (
          <span className={styles.na}>—</span>
        ),
    },
    {
      id: 'due',
      header: 'Jatuh tempo',
      cell: (row) => displayOrDash(row.dueAt),
    },
    {
      id: 'id',
      header: 'ID',
      mono: true,
      cell: (row) => (
        <MonoCell>
          <span title={row.decisionId}>{row.decisionId}</span>
        </MonoCell>
      ),
    },
  ]

  const progressMax = Math.max(openCount, 1)
  const progressVal = Math.max(0, openCount - blockingCount)

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-decisions"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-needs-human={needsHuman ? 'true' : 'false'}
      data-open-count={openCount}
      data-blocking-count={blockingCount}
      data-can-act={canAct ? 'true' : 'false'}
      aria-labelledby="decisions-page-title"
      {...pinAttrs}
    >
      <div
        className={styles.liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="decisions-live"
      >
        {liveMessage ?? ''}
      </div>

      <PageHeader
        eyebrow="Misi Q6"
        title={<span id="decisions-page-title">Keputusan</span>}
        subtitle="Kotak masuk pemilik dalam urutan server (menghambat → tingkat → jatuh tempo → dibuat → id). Keputusan yang menghambat tidak bisa disembunyikan dengan tunda. Menolak opsi menyelesaikan (RESOLVED); tolak berarti menolak permintaan itu sendiri."
        actions={
          onRefresh || onRetry ? (
            <Button
              variant="secondary"
              size="sm"
              onClick={onRefresh ?? onRetry}
              data-testid="decisions-header-refresh"
            >
              Muat ulang
            </Button>
          ) : null
        }
      />

      <div className={styles.kpiRow} data-testid="decisions-kpi-row">
        <KpiStat value={openCount} label="Terbuka" size="sm" />
        <KpiStat
          value={blockingCount}
          label="Menghambat"
          size="sm"
          hint={
            <span data-testid="decisions-blocking-count">
              {blockingCount} menghambat
            </span>
          }
        />
        <KpiStat value={items.length} label="Pada pin ini" size="sm" />
        <KpiStat value={pageSize} label="Ukuran halaman server" size="sm" />
      </div>

      {openCount > 0 ? (
        <div className={styles.progressSlot}>
          <ProgressBar
            value={progressVal}
            max={progressMax}
            label={`${openCount} terbuka · ${blockingCount} menghambat`}
          />
        </div>
      ) : null}

      {pin ? (
        <Disclosure summary="Detail teknis" data-testid="decisions-pin">
          <dl className={styles.techDl}>
            <dt>pin</dt>
            <dd className={styles.mono}>{pin.canonicalSnapshotId}</dd>
            {pin.canonicalHash ? (
              <>
                <dt>hash</dt>
                <dd className={styles.mono} title={pin.canonicalHash}>
                  {pin.canonicalHash.slice(0, 12)}
                </dd>
              </>
            ) : null}
            <dt>boardRev</dt>
            <dd className={styles.mono}>{pin.boardRev}</dd>
            <dt>lifecycleRev</dt>
            <dd className={styles.mono}>{pin.lifecycleRev}</dd>
            {pin.stale ? (
              <>
                <dt>stale</dt>
                <dd>{pin.staleReason ?? 'STALE'}</dd>
              </>
            ) : null}
          </dl>
        </Disclosure>
      ) : null}

      <div className={styles.bannerStack}>
        {surfaceState === 'forbidden' ? (
          <Card
            title="Akses ditolak"
            role="alert"
            data-testid="decisions-forbidden"
          >
            <p className={styles.bannerBody}>
              Anda tidak berwenang melihat atau bertindak pada keputusan board ini.
            </p>
            {error ? (
              <Disclosure summary="Detail teknis">
                <p className={styles.bannerBody}>
                  <strong>{error.code}</strong>
                  {error.message ? `: ${error.message}` : null}
                </p>
              </Disclosure>
            ) : null}
          </Card>
        ) : null}

        {error && surfaceState !== 'forbidden' ? (
          <Card
            title="Keputusan tidak tersedia"
            role="alert"
            data-testid="decisions-error"
          >
            <p className={styles.bannerBody}>
              Kotak masuk pemilik untuk pin ini tidak dapat dimuat.
            </p>
            <Disclosure summary="Detail teknis">
              <p className={styles.bannerBody}>
                <strong>{error.code}</strong>
                {error.message ? `: ${error.message}` : null}
              </p>
            </Disclosure>
            {onRetry ? (
              <Button type="button" variant="primary" size="sm" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : null}
          </Card>
        ) : null}

        {(surfaceState === 'partial' ||
          surfaceState === 'stale' ||
          (projectionGaps && projectionGaps.length > 0) ||
          surfaceState === 'needs-human' ||
          (blockingCount > 0 && !hideList)) &&
        !error &&
        surfaceState !== 'forbidden' ? (
          <Card
            title={
              blockingCount > 0 || surfaceState === 'needs-human'
                ? 'Perlu keputusan Anda'
                : surfaceState === 'stale'
                  ? 'Pin basi'
                  : 'Proyeksi sebagian'
            }
            role="status"
            data-testid="decisions-diagnostics"
          >
            <p className={styles.bannerBody}>
              {blockingCount > 0 || surfaceState === 'needs-human'
                ? `${blockingCount} keputusan menghambat tetap tampil sampai diselesaikan.`
                : surfaceState === 'stale'
                  ? (pin?.staleReason ??
                    'Agregasi pin basi — muat ulang untuk keputusan terkini.')
                  : 'Beberapa kolom detail tidak ada di envelope publik. Slot kosong di bawah jujur.'}
            </p>
            {projectionGaps && projectionGaps.length > 0 ? (
              <Disclosure
                summary={`Celah proyeksi (${projectionGaps.length})`}
                data-testid="decisions-partial-banner"
              >
                <ul className={styles.gapList}>
                  {projectionGaps.map((g) => (
                    <li key={g}>{g}</li>
                  ))}
                </ul>
              </Disclosure>
            ) : surfaceState === 'partial' ? (
              <span className={styles.srOnly} data-testid="decisions-partial-banner">
                Proyeksi keputusan sebagian
              </span>
            ) : null}
            {surfaceState === 'needs-human' || (blockingCount > 0 && !hideList) ? (
              <span className={styles.srOnly} data-testid="decisions-needs-human">
                Perlu keputusan Anda
              </span>
            ) : null}
            {surfaceState === 'stale' && onRefresh ? (
              <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
                Muat ulang
              </Button>
            ) : null}
          </Card>
        ) : null}
      </div>

      {surfaceState === 'loading' ? (
        <div
          className={styles.skeletonStack}
          data-testid="decisions-skeleton"
          aria-hidden="true"
        >
          <Skeleton height={72} />
          <Skeleton height={72} />
          <Skeleton height={72} />
        </div>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <EmptyState
          data-testid="decisions-empty"
          title={
            surfaceState === 'zero-results'
              ? 'Tidak ada yang cocok'
              : 'Tidak ada yang menunggu Anda'
          }
          description={
            surfaceState === 'zero-results'
              ? 'Tidak ada keputusan yang cocok dengan filter saat ini.'
              : 'Tidak ada keputusan terbuka pada pin ini.'
          }
        />
      ) : null}

      {!hideList && items.length > 0 ? (
        <>
          <Toolbar
            data-testid="decisions-toolbar"
            searchProps={{
              value: search,
              onChange: (e) => setSearch(e.target.value),
              placeholder: 'Cari judul, ID, pertanyaan…',
              'aria-label': 'Cari keputusan',
            }}
            filters={
              <>
                <Pill active={filter === 'all'} onClick={() => setFilter('all')}>
                  Semua
                </Pill>
                <Pill
                  active={filter === 'blocking'}
                  onClick={() => setFilter('blocking')}
                >
                  Menghambat
                </Pill>
                <Pill active={filter === 'open'} onClick={() => setFilter('open')}>
                  Terbuka
                </Pill>
              </>
            }
          />

          <Card
            title="Ringkasan daftar"
            subtitle={`${filtered.length} keputusan (urutan server dipertahankan)`}
            flush
            data-testid="decisions-scan-table-card"
          >
            <Table
              columns={columns}
              rows={scanRows}
              rowKey={(r) => r.decisionId}
              loading={false}
              empty="Tidak ada baris pada filter ini."
              caption="Ringkasan keputusan"
              aria-label="Tabel ringkasan keputusan"
              data-testid="decisions-scan-table"
            />
            {filtered.length > 0 ? (
              <div className={styles.pager}>
                <Pagination
                  page={safePage}
                  pageSize={clientPageSize}
                  total={filtered.length}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setClientPageSize(size)
                    setPage(1)
                  }}
                  data-testid="decisions-pagination"
                />
              </div>
            ) : null}
          </Card>

          {pageItems.length > 0 ? (
            <ul className={styles.list} data-testid="decisions-list">
              {pageItems.map((item) => (
                <li key={item.decisionId}>
                  <DecisionCard
                    item={item}
                    boardId={boardId}
                    pin={pin}
                    canAct={canAct}
                    pending={pendingDecisionId === item.decisionId}
                    pendingAction={
                      pendingDecisionId === item.decisionId ? pendingAction : null
                    }
                    actionError={actionErrors?.[item.decisionId] ?? null}
                    actions={actions}
                  />
                </li>
              ))}
            </ul>
          ) : (
            <EmptyState
              title="Tidak ada yang cocok"
              description="Sesuaikan pencarian atau filter untuk melihat keputusan."
            />
          )}
        </>
      ) : null}

      {nextCursor ? (
        <p className={styles.bannerBody} data-testid="decisions-next-cursor">
          Ada halaman berikutnya (kursor server) · pageSize {pageSize}
        </p>
      ) : null}
    </section>
  )
}
