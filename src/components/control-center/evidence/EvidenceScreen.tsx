/**
 * FAN-EVIDENCE — Direction B "Bukti / Audit" screen (presentation only).
 * Composes Cairn UI kit primitives; no fetch / no invented proof.
 */
import { useMemo, useState } from 'react'

import { BoardLink } from '#/components/BoardLink'
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
  Tabs,
  Toolbar,
  type TableColumn,
} from '#/components/ui'
import { truncateIdentifier } from '#/lib/display-label'

import styles from './evidence.module.css'
import {
  eventHumanTitle,
  eventTimeDisplay,
  kindHumanDisplay,
} from './labels'
import type { EvidenceEventRow, EvidenceScreenProps } from './types'

const DEFAULT_PAGE_SIZE = 25

type KindFilter = 'all' | string

function matchesQuery(ev: EvidenceEventRow, q: string): boolean {
  if (!q) return true
  const hay = [
    ev.summary,
    ev.kind,
    ev.id,
    ev.actorId ?? '',
    ev.materialHash ?? '',
    kindHumanDisplay(ev.kind),
  ]
    .join(' ')
    .toLowerCase()
  return hay.includes(q)
}

export function EvidenceScreen({
  boardId,
  surfaceState,
  loading,
  events,
  nextCursor,
  pin,
  error,
  onRetry,
  onNextPage,
  onOpenEvidence,
  className,
}: EvidenceScreenProps) {
  const [search, setSearch] = useState('')
  const [kindFilter, setKindFilter] = useState<KindFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(DEFAULT_PAGE_SIZE)
  const [tab, setTab] = useState('events')

  const kindOptions = useMemo(() => {
    const set = new Set<string>()
    for (const ev of events) {
      const k = ev.kind?.trim()
      if (k) set.add(k)
    }
    return Array.from(set).sort((a, b) => a.localeCompare(b))
  }, [events])

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return events.filter((ev) => {
      if (kindFilter !== 'all' && ev.kind !== kindFilter) return false
      return matchesQuery(ev, q)
    })
  }, [events, search, kindFilter])

  // Reset to page 1 when filter/search/pageSize change
  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const pageRows = useMemo(() => {
    const start = (safePage - 1) * pageSize
    return filtered.slice(start, start + pageSize)
  }, [filtered, safePage, pageSize])

  const pinAttrs = pinnedSurfaceDataAttrs(
    pin
      ? {
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash ?? null,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
        }
      : null,
  )

  const stale = Boolean(pin?.stale)
  const eventCount = events.length
  const filteredCount = filtered.length

  const columns: Array<TableColumn<EvidenceEventRow>> = useMemo(
    () => [
      {
        id: 'entity',
        header: 'Bukti',
        cell: (row) => {
          const title = eventHumanTitle(row.summary, row.kind)
          const kindLabel = kindHumanDisplay(row.kind)
          const idShort = truncateIdentifier(row.id, 10, 6)
          return (
            <div className={styles.entityCell} data-testid="evidence-row">
              <span className={styles.entityTitle} title={title}>
                {title}
              </span>
              <span className={styles.entityMeta}>
                <span className={styles.kindSoft}>{kindLabel}</span>
                <MonoCell>
                  <span title={row.id} data-full-value={row.id}>
                    {idShort.display || row.id}
                  </span>
                </MonoCell>
              </span>
            </div>
          )
        },
      },
      {
        id: 'time',
        header: 'Waktu',
        cell: (row) => (
          <time dateTime={row.createdAt} title={row.createdAt}>
            {eventTimeDisplay(row.createdAt)}
          </time>
        ),
      },
      {
        id: 'actor',
        header: 'Aktor',
        mono: true,
        cell: (row) => {
          if (!row.actorId) return <span className={styles.na}>—</span>
          const short = truncateIdentifier(row.actorId, 8, 4)
          return (
            <span title={row.actorId} data-full-value={row.actorId}>
              {short.display}
            </span>
          )
        },
      },
      {
        id: 'hash',
        header: 'Hash',
        mono: true,
        cell: (row) => {
          if (!row.materialHash) return <span className={styles.na}>—</span>
          return (
            <span title={row.materialHash} data-full-value={row.materialHash}>
              {row.materialHash.slice(0, 12)}
            </span>
          )
        },
      },
      {
        id: 'actions',
        header: 'Aksi',
        align: 'right',
        cell: (row) => (
          <Button
            variant="secondary"
            size="sm"
            data-testid={`evidence-open-${row.id}`}
            onClick={() => onOpenEvidence(row.id)}
          >
            Buka bukti
          </Button>
        ),
      },
    ],
    [onOpenEvidence],
  )

  const showEmpty =
    !loading && !error && eventCount === 0
  const showFilteredEmpty =
    !loading && !error && eventCount > 0 && filteredCount === 0

  return (
    <div
      className={[styles.page, className].filter(Boolean).join(' ')}
      data-testid="control-center-evidence-route"
    >
      <section
        className={styles.root}
        data-surface-state={loading ? 'loading' : surfaceState}
        data-testid="control-center-evidence"
        data-board-id={boardId}
        aria-labelledby="evidence-page-title"
        {...pinAttrs}
      >
        <PageHeader
          eyebrow="Misi Q8"
          breadcrumb={
            <Breadcrumb
              items={[
                { label: 'Operasi', href: `/b/${encodeURIComponent(boardId)}/ops` },
                { label: 'Bukti' },
              ]}
            />
          }
          title={<span id="evidence-page-title">Bukti / Audit</span>}
          subtitle={
            <>
              Peristiwa material immutable dari agregasi pin ·{' '}
              <BoardLink to="/log">log aktivitas warisan</BoardLink>
            </>
          }
          actions={
            <div className={styles.headerActions}>
              <Badge mono variant="neutral" aria-label={`${eventCount} peristiwa`}>
                {eventCount}
              </Badge>
              {stale ? (
                <StatusChip variant="warn">Pin basi</StatusChip>
              ) : pin ? (
                <StatusChip variant="done">Pin aktif</StatusChip>
              ) : (
                <StatusChip variant="pending">Tanpa pin</StatusChip>
              )}
            </div>
          }
        />

        <div className={styles.kpiRow} data-testid="evidence-kpi-row">
          <KpiStat
            size="sm"
            value={eventCount}
            label="Peristiwa di pin"
            hint={
              filteredCount !== eventCount
                ? `${filteredCount} cocok filter`
                : 'Halaman pin saat ini'
            }
          />
          <KpiStat
            size="sm"
            value={pin ? pin.boardRev : '—'}
            label="Board rev"
            hint={pin ? `lifecycle ${pin.lifecycleRev}` : 'Tidak ada pin'}
          />
          <div className={styles.progressKpi}>
            <span className={styles.progressLabel}>Kehadiran daftar</span>
            <ProgressBar
              value={eventCount > 0 ? Math.min(eventCount, pageSize) : 0}
              max={eventCount > 0 ? Math.max(eventCount, pageSize) : 1}
              label={
                eventCount === 0
                  ? '0 peristiwa'
                  : `${Math.min(filteredCount, pageSize)} ditampilkan / ${filteredCount} filter`
              }
            />
          </div>
        </div>

        {pin ? (
          <Disclosure
            summary="Detail teknis"
            data-testid="evidence-pin"
            data-canonical-snapshot-id={pin.canonicalSnapshotId}
          >
            <dl className={styles.techGrid}>
              <dt>snapshot</dt>
              <dd>
                <code title={pin.canonicalSnapshotId}>{pin.canonicalSnapshotId}</code>
              </dd>
              <dt>canonicalHash</dt>
              <dd>
                <code title={pin.canonicalHash ?? undefined}>
                  {pin.canonicalHash ?? '—'}
                </code>
              </dd>
              <dt>boardRev</dt>
              <dd>
                <code>{pin.boardRev}</code>
              </dd>
              <dt>lifecycleRev</dt>
              <dd>
                <code>{pin.lifecycleRev}</code>
              </dd>
              {pin.stale ? (
                <>
                  <dt>stale</dt>
                  <dd>{pin.staleReason?.trim() || 'Pin bukti basi'}</dd>
                </>
              ) : null}
            </dl>
          </Disclosure>
        ) : null}

        {error ? (
          <Card data-testid="evidence-error" className={styles.stateCard}>
            <EmptyState
              title={error.code}
              description={error.message}
              action={
                <Button variant="secondary" size="sm" onClick={onRetry}>
                  Coba lagi
                </Button>
              }
            />
          </Card>
        ) : null}

        {!error ? (
          <Tabs
            value={tab}
            onValueChange={setTab}
            data-testid="evidence-tabs"
            items={[
              {
                id: 'events',
                label: `Peristiwa${filteredCount !== eventCount ? ` (${filteredCount})` : eventCount ? ` (${eventCount})` : ''}`,
                panel: (
                  <Card
                    title="Peristiwa material"
                    subtitle="Ringkasan bukti sebagai judul; ID teknis mono sekunder."
                    flush
                    data-testid="evidence-table-card"
                  >
                    <div className={styles.tableChrome}>
                      <Toolbar
                        searchProps={{
                          value: search,
                          onChange: (e) => {
                            setSearch(e.target.value)
                            setPage(1)
                          },
                          placeholder: 'Cari ringkasan, jenis, aktor…',
                          'aria-label': 'Cari bukti',
                        }}
                        filters={
                          <>
                            <Pill
                              active={kindFilter === 'all'}
                              onClick={() => {
                                setKindFilter('all')
                                setPage(1)
                              }}
                            >
                              Semua
                            </Pill>
                            {kindOptions.map((k) => (
                              <Pill
                                key={k}
                                active={kindFilter === k}
                                onClick={() => {
                                  setKindFilter(k)
                                  setPage(1)
                                }}
                              >
                                {kindHumanDisplay(k)}
                              </Pill>
                            ))}
                          </>
                        }
                        actions={
                          nextCursor ? (
                            <Button
                              variant="secondary"
                              size="sm"
                              onClick={onNextPage}
                              data-testid="evidence-next-page"
                            >
                              Halaman server berikutnya
                            </Button>
                          ) : null
                        }
                      />
                    </div>

                    {loading ? (
                      <div data-testid="evidence-loading" aria-busy="true">
                        <Table
                          columns={columns}
                          rows={[]}
                          rowKey={(r) => r.id}
                          loading
                          skeletonRows={5}
                          empty="Memuat bukti…"
                          aria-label="Peristiwa material"
                          data-testid="evidence-list"
                        />
                      </div>
                    ) : showEmpty ? (
                      <div className={styles.emptyPad} data-testid="evidence-empty">
                        <EmptyState
                          title="Tidak ada peristiwa material"
                          description="Belum ada yang diaudit pada pin ini."
                        />
                      </div>
                    ) : showFilteredEmpty ? (
                      <div
                        className={styles.emptyPad}
                        data-testid="evidence-filtered-empty"
                      >
                        <EmptyState
                          title="Tidak ada cocokan"
                          description="Ubah kata kunci atau filter jenis."
                          action={
                            <Button
                              variant="ghost"
                              size="sm"
                              onClick={() => {
                                setSearch('')
                                setKindFilter('all')
                                setPage(1)
                              }}
                            >
                              Reset filter
                            </Button>
                          }
                        />
                      </div>
                    ) : (
                      <>
                        <Table
                          columns={columns}
                          rows={[...pageRows]}
                          rowKey={(r) => r.id}
                          empty="Tidak ada peristiwa."
                          aria-label="Peristiwa material"
                          data-testid="evidence-list"
                        />
                        <div className={styles.paginationRow}>
                          <Pagination
                            page={safePage}
                            pageSize={pageSize}
                            total={filteredCount}
                            onPageChange={setPage}
                            onPageSizeChange={(size) => {
                              setPageSize(size)
                              setPage(1)
                            }}
                          />
                        </div>
                      </>
                    )}

                    {nextCursor ? (
                      <div
                        className={styles.cursorNote}
                        data-testid="evidence-next-cursor"
                      >
                        <span className={styles.cursorText}>
                          Ada halaman berikutnya (kursor server)
                        </span>
                      </div>
                    ) : null}
                  </Card>
                ),
              },
              {
                id: 'pin',
                label: 'Pin agregasi',
                panel: (
                  <Card
                    title="Pin agregasi"
                    subtitle="Status pin dan revisi — hash/snapshot di Detail teknis di atas."
                    data-testid="evidence-pin-tab"
                  >
                    {!pin ? (
                      <EmptyState
                        title="Tidak ada pin"
                        description="Envelope bukti belum membawa pin aktif."
                      />
                    ) : (
                      <div className={styles.pinSummary}>
                        {stale ? (
                          <StatusChip variant="warn">Pin basi</StatusChip>
                        ) : (
                          <StatusChip variant="done">Pin aktif</StatusChip>
                        )}
                        <span className={styles.pinRev}>
                          boardRev {pin.boardRev} · lifecycleRev {pin.lifecycleRev}
                          {stale && pin.staleReason
                            ? ` · ${pin.staleReason}`
                            : ''}
                        </span>
                      </div>
                    )}
                  </Card>
                ),
              },
            ]}
          />
        ) : null}
      </section>
    </div>
  )
}
