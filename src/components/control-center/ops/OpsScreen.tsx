/**
 * Ops / Accounts screen — Direction B presentation.
 * Prop-driven only; masked identity; no raw tokens.
 * Data/logic unchanged — kit primitives + tokens only.
 */
import { useMemo, useState } from 'react'

import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import {
  Badge,
  Breadcrumb,
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
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { formatOperationalLabel } from '#/lib/display-label'

import type { OpsAccountRowView, OpsScreenProps } from './types'
import styles from './ops.module.css'

const PAGE_SIZE_DEFAULT = 25

type FlagFilter = 'all' | 'ok' | 'limit' | 'quarantine' | 'tombstone'

function statusChipVariant(row: OpsAccountRowView): StatusChipVariant {
  if (row.quarantine) return 'blocked'
  if (row.isLimit) return 'warn'
  if (row.isTombstone) return 'pending'
  const s = (row.status ?? '').toUpperCase()
  if (/ACTIVE|OK|READY|HEALTHY|USABLE/.test(s)) return 'done'
  if (/LIMIT|RATE|CAP|WARN|STALE/.test(s)) return 'warn'
  if (/QUARANT|BLOCK|BAN|FAIL|AUTH|ERROR/.test(s)) return 'blocked'
  if (/RUN|BUSY|IN_USE|ONGOING/.test(s)) return 'ongoing'
  if (/REMOVED|TOMB|DELETE|IDLE/.test(s)) return 'pending'
  return 'pending'
}

/** Human id-ID status label; technical status remains secondary mono. */
function statusHumanLabel(row: OpsAccountRowView): string {
  if (row.quarantine) return 'Karantina'
  if (row.isLimit) return 'LIMIT'
  if (row.isTombstone) return 'Tombstone'
  const raw = (row.status ?? '').trim()
  if (!raw) return 'Bersih'
  const s = raw.toUpperCase()
  if (s === 'ACTIVE' || s === 'OK' || s === 'HEALTHY' || s === 'USABLE') return 'Aktif'
  if (s === 'LIMIT' || s === 'LIMITED' || s === 'RATE_LIMITED' || s === 'CAP_HIT') return 'LIMIT'
  if (s === 'QUARANTINED' || s === 'QUARANTINE') return 'Karantina'
  if (s === 'REMOVED' || s === 'TOMBSTONE' || s === 'DELETED') return 'Tombstone'
  return formatOperationalLabel(raw) || raw
}

/** Entity title: clean human fallback; technical id mono secondary. */
function accountTitle(row: OpsAccountRowView): string {
  if (row.isTombstone) return 'Akun di-tombstone'
  if (row.quarantine) return 'Akun dikarantina'
  if (row.isLimit) return 'Akun pada LIMIT'
  const provider = row.providerKind?.trim()
  if (provider) {
    return `Akun ${formatOperationalLabel(provider) || provider}`
  }
  return 'Akun ter-mask'
}

function AccountFlags({ row }: { row: OpsAccountRowView }) {
  return (
    <div className={styles.flagRow} data-testid="ops-account-flags">
      {row.isLimit ? (
        <StatusChip variant="warn" data-flag="limit">
          LIMIT
        </StatusChip>
      ) : null}
      {row.quarantine ? (
        <StatusChip variant="blocked" data-flag="quarantine">
          Karantina
        </StatusChip>
      ) : null}
      {row.isTombstone ? (
        <StatusChip variant="pending" showDot={false} data-flag="tombstone">
          Tombstone
        </StatusChip>
      ) : null}
      {!row.isLimit && !row.quarantine && !row.isTombstone ? (
        <StatusChip variant="done" data-flag="ok">
          Bersih
        </StatusChip>
      ) : null}
    </div>
  )
}

function CapacityCell({ row }: { row: OpsAccountRowView }) {
  const max = row.effectiveCap
  const value = row.effectiveInUse
  const hasBar = Number.isFinite(max) && max > 0
  return (
    <div className={styles.capacityCell} data-field="capacity">
      {hasBar ? (
        <ProgressBar
          value={value}
          max={max}
          label={row.capacityLabel}
          ok={value < max && !row.isLimit && !row.quarantine}
        />
      ) : (
        <span className={styles.monoSecondary}>{row.capacityLabel || '—'}</span>
      )}
    </div>
  )
}

function AccountCard({ row }: { row: OpsAccountRowView }) {
  const title = accountTitle(row)
  return (
    <li
      className={styles.cardItem}
      data-testid="ops-account-card"
      data-masked-account={row.maskedAccountId}
      data-quarantine={row.quarantine ? '1' : '0'}
      data-limit={row.isLimit ? '1' : '0'}
      data-tombstone={row.isTombstone ? '1' : '0'}
    >
      <Card
        title={
          <span className={styles.entityTitleBlock}>
            <span className={styles.entityTitle}>{title}</span>
            <span
              className={styles.monoSecondary}
              data-field="masked-account-id"
              title={row.maskedAccountId}
            >
              {row.maskedAccountId}
            </span>
          </span>
        }
        subtitle={
          row.providerKind
            ? formatOperationalLabel(row.providerKind) || row.providerKind
            : 'Penyedia tidak diproyeksikan'
        }
        headerActions={
          <StatusChip variant={statusChipVariant(row)}>{statusHumanLabel(row)}</StatusChip>
        }
      >
        <dl className={styles.cardMeta}>
          <div>
            <dt>Kapasitas</dt>
            <dd>
              <CapacityCell row={row} />
            </dd>
          </div>
          <div>
            <dt>Slot fisik</dt>
            <dd className={styles.monoSecondary}>{row.physicalSlotsDisplay ?? '—'}</dd>
          </div>
          <div>
            <dt>Bendera</dt>
            <dd>
              <AccountFlags row={row} />
            </dd>
          </div>
          <div>
            <dt>Alasan</dt>
            <dd>{row.reason?.trim() || '—'}</dd>
          </div>
        </dl>
      </Card>
    </li>
  )
}

function matchesSearch(row: OpsAccountRowView, q: string): boolean {
  if (!q) return true
  const hay = [
    row.maskedAccountId,
    row.status,
    row.providerKind,
    row.reason,
    row.capacityLabel,
    row.physicalSlotsDisplay,
    accountTitle(row),
    statusHumanLabel(row),
  ]
    .filter(Boolean)
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

function matchesFlag(row: OpsAccountRowView, flag: FlagFilter): boolean {
  if (flag === 'all') return true
  if (flag === 'limit') return row.isLimit
  if (flag === 'quarantine') return row.quarantine
  if (flag === 'tombstone') return row.isTombstone
  return !row.isLimit && !row.quarantine && !row.isTombstone
}

/**
 * Prop-driven Ops/Accounts screen.
 * Masked identity only; LIMIT / quarantine / tombstone from server status flags.
 */
export function OpsScreen({
  surfaceState,
  boardId,
  accounts,
  usableCapacity,
  quarantineCount,
  accountSyncStale,
  capacityNote,
  accountSourceRevision = null,
  pin,
  error,
  projectionGaps,
  liveMessage,
  onRetry,
  onRefresh,
  className,
}: OpsScreenProps) {
  const [search, setSearch] = useState('')
  const [flagFilter, setFlagFilter] = useState<FlagFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const pinAttrs = pinnedSurfaceDataAttrs(
    pin
      ? {
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
          generatedAt: pin.generatedAt,
          freshnessAgeSeconds: pin.freshnessAgeSeconds,
          stale: pin.stale,
        }
      : null,
  )

  const searchNorm = search.trim().toLowerCase()

  const filtered = useMemo(() => {
    return accounts.filter(
      (row) => matchesSearch(row, searchNorm) && matchesFlag(row, flagFilter),
    )
  }, [accounts, searchNorm, flagFilter])

  // Reset page when filter/search changes length beyond current page.
  const pageCount = Math.max(1, Math.ceil(filtered.length / Math.max(1, pageSize)))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pageSlice = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, safePage, pageSize])

  const columns: Array<TableColumn<OpsAccountRowView>> = useMemo(
    () => [
      {
        id: 'account',
        header: 'Akun',
        cell: (row) => (
          <div
            className={styles.entityCell}
            data-testid="ops-account-row"
            data-masked-account={row.maskedAccountId}
            data-quarantine={row.quarantine ? '1' : '0'}
            data-limit={row.isLimit ? '1' : '0'}
            data-tombstone={row.isTombstone ? '1' : '0'}
          >
            <span className={styles.entityTitle}>{accountTitle(row)}</span>
            <span
              className={styles.monoSecondary}
              data-field="masked-account-id"
              title={row.maskedAccountId}
            >
              {row.maskedAccountId}
            </span>
            {/* capacity mirrored for row-scoped contract queries */}
            <span className={styles.srOnly} data-field="capacity">
              {row.capacityLabel}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (row) => (
          <StatusChip variant={statusChipVariant(row)} title={row.status}>
            {statusHumanLabel(row)}
          </StatusChip>
        ),
      },
      {
        id: 'provider',
        header: 'Penyedia',
        cell: (row) =>
          row.providerKind ? (
            formatOperationalLabel(row.providerKind) || row.providerKind
          ) : (
            <span className={styles.na}>—</span>
          ),
      },
      {
        id: 'capacity',
        header: 'Kapasitas',
        cell: (row) => <CapacityCell row={row} />,
      },
      {
        id: 'slots',
        header: 'Slot fisik',
        mono: true,
        cell: (row) => (
          <MonoCell>{row.physicalSlotsDisplay ?? '—'}</MonoCell>
        ),
      },
      {
        id: 'flags',
        header: 'Bendera',
        cell: (row) => <AccountFlags row={row} />,
      },
      {
        id: 'reason',
        header: 'Alasan',
        cell: (row) =>
          row.reason?.trim() ? row.reason : <span className={styles.na}>—</span>,
      },
    ],
    [],
  )

  const limitCount = accounts.filter((a) => a.isLimit).length
  const tombCount = accounts.filter((a) => a.isTombstone).length
  const okCount = accounts.filter(
    (a) => !a.isLimit && !a.quarantine && !a.isTombstone,
  ).length

  const onSearchChange = (value: string) => {
    setSearch(value)
    setPage(1)
  }

  const onFlagChange = (next: FlagFilter) => {
    setFlagFilter(next)
    setPage(1)
  }

  const headerActions = (
    <div className={styles.headerActions}>
      {onRefresh ? (
        <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
          Muat ulang
        </Button>
      ) : null}
      {onRetry && onRetry !== onRefresh ? (
        <Button type="button" variant="ghost" size="sm" onClick={onRetry}>
          Coba lagi
        </Button>
      ) : null}
    </div>
  )

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="control-center-ops"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-account-count={accounts.length}
      data-account-sync-stale={accountSyncStale ? '1' : '0'}
      data-reflow-breakpoint="768"
      aria-labelledby="ops-page-title"
      {...pinAttrs}
    >
      <div
        className={styles.liveRegion}
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="ops-live"
      >
        {liveMessage ?? ''}
      </div>

      <PageHeader
        eyebrow="Operasi"
        title={<span id="ops-page-title">Operasi / Akun</span>}
        subtitle="Kapasitas akun ter-mask, karantina, LIMIT, dan audit sinkron dari envelope pin. Identitas mentah dan token tidak pernah ditampilkan."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Control center', href: `/b/${boardId}` },
              { label: 'Operasi' },
            ]}
          />
        }
        actions={onRefresh || onRetry ? headerActions : undefined}
      />

      <div className={styles.kpiRow} data-testid="ops-kpi-row">
        <KpiStat
          size="sm"
          label="Akun"
          value={accounts.length}
          data-testid="ops-account-count"
          hint="ter-mask pada pin"
        />
        {usableCapacity != null ? (
          <KpiStat
            size="sm"
            label="Kapasitas pakai"
            value={usableCapacity}
            data-testid="ops-usable-capacity"
          />
        ) : null}
        {quarantineCount != null ? (
          <KpiStat
            size="sm"
            label="Karantina"
            value={quarantineCount}
            data-testid="ops-quarantine-count"
            hint={quarantineCount > 0 ? 'perlu perhatian' : 'nihil'}
          />
        ) : null}
        <div className={styles.syncStat}>
          {accountSyncStale ? (
            <StatusChip variant="warn" data-testid="ops-sync-stale">
              Sinkron akun basi
            </StatusChip>
          ) : (
            <StatusChip variant="done" data-testid="ops-sync-fresh">
              Sinkron segar
            </StatusChip>
          )}
          {limitCount > 0 ? (
            <Badge variant="neutral">LIMIT {limitCount}</Badge>
          ) : null}
          {tombCount > 0 ? (
            <Badge variant="neutral">Tombstone {tombCount}</Badge>
          ) : null}
        </div>
      </div>

      {pin ? (
        <Disclosure
          summary="Detail teknis"
          data-testid="ops-pin"
          data-canonical-snapshot-id={pin.canonicalSnapshotId}
          data-canonical-hash={pin.canonicalHash}
          data-board-rev={pin.boardRev}
          data-lifecycle-rev={pin.lifecycleRev}
          data-generated-at={pin.generatedAt}
          data-freshness-age={pin.freshnessAgeSeconds}
          data-stale={pin.stale ? 'true' : 'false'}
          {...(accountSourceRevision != null
            ? { 'data-source-revision': String(accountSourceRevision) }
            : {})}
        >
          <dl className={styles.techDl}>
            <dt>Pin</dt>
            <dd className={styles.monoSecondary}>{pin.canonicalSnapshotId}</dd>
            <dt>Hash</dt>
            <dd className={styles.monoSecondary} title={pin.canonicalHash}>
              {pin.canonicalHash.length > 16
                ? `${pin.canonicalHash.slice(0, 12)}…`
                : pin.canonicalHash}
            </dd>
            <dt>boardRev</dt>
            <dd className={styles.monoSecondary}>{pin.boardRev}</dd>
            <dt>lifecycleRev</dt>
            <dd className={styles.monoSecondary}>{pin.lifecycleRev}</dd>
            <dt>sourceRevision akun</dt>
            <dd className={styles.monoSecondary}>
              {accountSourceRevision != null ? accountSourceRevision : '—'}
            </dd>
            <dt>Kesegaran</dt>
            <dd className={styles.monoSecondary}>{pin.freshnessAgeSeconds}s</dd>
            <dt>Stale</dt>
            <dd>
              {pin.stale ? (
                <StatusChip variant="warn">
                  STALE{pin.staleReason ? ` · ${pin.staleReason}` : ''}
                </StatusChip>
              ) : (
                <StatusChip variant="done">Segar</StatusChip>
              )}
            </dd>
            <dt>Board</dt>
            <dd className={styles.monoSecondary}>{pin.boardId || boardId}</dd>
          </dl>
        </Disclosure>
      ) : null}

      {capacityNote ? (
        <p className={styles.note} data-testid="ops-capacity-note">
          {capacityNote}
        </p>
      ) : null}

      {error ? (
        <Card
          data-testid="ops-error"
          role="alert"
          title={`${error.code}: operasi tidak tersedia`}
          subtitle={error.message}
          headerActions={
            onRetry ? (
              <Button type="button" variant="primary" size="sm" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {surfaceState === 'partial' ||
      (projectionGaps && projectionGaps.length > 0 && surfaceState === 'populated') ? (
        <Card
          data-testid="ops-partial-banner"
          role="status"
          title="Celah proyeksi jujur"
          subtitle="Stempel last-sync per akun tidak ada di AccountUiSummary; boardRev pin envelope adalah revisi sumber yang ditampilkan di Detail teknis."
        >
          {projectionGaps && projectionGaps.length > 0 ? (
            <ul className={styles.gapList}>
              {projectionGaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
        </Card>
      ) : null}

      {surfaceState === 'stale' || accountSyncStale ? (
        <Card
          data-testid="ops-stale-banner"
          role="status"
          title={accountSyncStale ? 'Sinkron akun basi' : 'Pin basi'}
          subtitle={
            pin?.staleReason ??
            (accountSyncStale
              ? 'Server menandai STALE_ACCOUNT_SYNC atau pin basi — muat ulang untuk kebenaran audit.'
              : 'Agregasi pin basi.')
          }
          headerActions={
            onRefresh ? (
              <Button type="button" variant="secondary" size="sm" onClick={onRefresh}>
                Muat ulang
              </Button>
            ) : undefined
          }
        />
      ) : null}

      {surfaceState === 'loading' ? (
        <Card data-testid="ops-skeleton" aria-hidden="true" flush>
          <Table
            columns={columns}
            rows={[]}
            rowKey={(r) => r.maskedAccountId}
            loading
            skeletonRows={4}
            caption="Memuat akun"
            aria-label="Memuat daftar akun"
          />
        </Card>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <EmptyState
          data-testid="ops-empty"
          title="Tidak ada akun"
          description="Tidak ada akun pada pin ini."
        />
      ) : null}

      {!hideList && accounts.length > 0 ? (
        <Card
          flush
          title="Daftar akun"
          subtitle={`${filtered.length} cocok dari ${accounts.length} akun · identitas ter-mask`}
          headerActions={
            <Badge variant="brand" mono>
              {okCount} bersih
            </Badge>
          }
        >
          <div className={styles.listChrome}>
            <Toolbar
              searchProps={{
                value: search,
                onChange: (e) => onSearchChange(e.target.value),
                placeholder: 'Cari akun, status, penyedia…',
                'aria-label': 'Cari akun',
              }}
              filters={
                <>
                  <Pill active={flagFilter === 'all'} onClick={() => onFlagChange('all')}>
                    Semua
                  </Pill>
                  <Pill active={flagFilter === 'ok'} onClick={() => onFlagChange('ok')}>
                    Bersih
                  </Pill>
                  <Pill active={flagFilter === 'limit'} onClick={() => onFlagChange('limit')}>
                    LIMIT
                  </Pill>
                  <Pill
                    active={flagFilter === 'quarantine'}
                    onClick={() => onFlagChange('quarantine')}
                  >
                    Karantina
                  </Pill>
                  <Pill
                    active={flagFilter === 'tombstone'}
                    onClick={() => onFlagChange('tombstone')}
                  >
                    Tombstone
                  </Pill>
                </>
              }
            />

            {filtered.length === 0 ? (
              <EmptyState
                title="Tidak ada hasil"
                description="Sesuaikan pencarian atau filter bendera."
                action={
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    onClick={() => {
                      onSearchChange('')
                      onFlagChange('all')
                    }}
                  >
                    Reset filter
                  </Button>
                }
              />
            ) : (
              <>
                <div className={styles.tableWrap} data-testid="ops-accounts-table">
                  <Table
                    columns={columns}
                    rows={pageSlice}
                    rowKey={(r) => r.maskedAccountId}
                    empty="Tidak ada akun."
                    caption="Daftar akun operasi"
                    aria-label="Tabel akun ter-mask"
                  />
                </div>

                <ul className={styles.cardList} data-testid="ops-accounts-cards">
                  {pageSlice.map((row) => (
                    <AccountCard key={row.maskedAccountId} row={row} />
                  ))}
                </ul>

                <Pagination
                  page={safePage}
                  pageSize={pageSize}
                  total={filtered.length}
                  onPageChange={setPage}
                  onPageSizeChange={(size) => {
                    setPageSize(size)
                    setPage(1)
                  }}
                />
              </>
            )}
          </div>
        </Card>
      ) : null}
    </section>
  )
}
