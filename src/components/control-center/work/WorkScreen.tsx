import { useId, useMemo } from 'react'
import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  KpiStat,
  PageHeader,
  Pill,
  ProgressBar,
  StatusChip,
  Tabs,
  Toolbar,
} from '#/components/ui'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import { BucketTabs } from './BucketTabs'
import { PinnedRevisionBadge } from './PinnedRevisionBadge'
import { StaleOverlayFilter } from './StaleOverlayFilter'
import { WorkList } from './WorkList'
import { WorkPagination } from './WorkPagination'
import { WorkStates } from './WorkStates'
import { BUCKET_SEMANTICS } from './labels'
import type { WorkScreenProps } from './types'
import styles from './work.module.css'

const LIST_TERMINAL: ReadonlySet<WorkScreenProps['state']> = new Set([
  'loading',
  'empty',
  'zero-results',
  'disconnected',
  'error',
  'forbidden',
])

const BUCKET_DESCRIPTIONS: Readonly<
  Record<WorkScreenProps['activeBucket'], string>
> = {
  DONE: 'Hasil yang sudah melewati gate saat ini dan memiliki bukti penyelesaian.',
  RECONCILIATION_PENDING:
    'Klaim atau run sedang dicocokkan agar kepemilikan dan bukti tetap dapat dipercaya.',
  ONGOING:
    'Pekerjaan dengan pemilik, lease, dan aktivitas terbaru yang masih valid.',
  NEXT: 'Pekerjaan yang siap dimulai setelah prasyarat terdekat terpenuhi.',
  QUEUED: 'Pekerjaan valid yang menunggu giliran dan belum dijadwalkan.',
  BLOCKED:
    'Pekerjaan yang tidak dapat bergerak sampai penyebab hambatannya diselesaikan.',
}

/**
 * Prop-driven Work screen shell (UI_CONTRACT §5–§7, §11).
 * Direction B presentation via Cairn UI kit — data/logika tetap prop-driven.
 */
export function WorkScreen({
  state,
  boardId,
  activeBucket,
  bucketCounts,
  staleOverlayActive,
  staleSummary,
  items,
  page,
  pinned,
  envelopeStale,
  envelopeStaleReason,
  partialMessage,
  error,
  needsHumanMessage,
  liveMessage,
  onBucketChange,
  onStaleOverlayChange,
  onNextPage,
  onPrevPage,
  onRetry,
  onRefresh,
  onReconnect,
  onRowActivate,
  textQuery = null,
  onTextQueryChange,
  className,
}: WorkScreenProps) {
  const rawUid = useId()
  const uid = rawUid.replace(/[^A-Za-z0-9_-]/g, '')
  const panelId = `${uid}-panel`
  const activeTabId = `${uid}-tab-${activeBucket}`
  const showList = !LIST_TERMINAL.has(state)
  const controlsDisabled =
    state === 'loading' || state === 'disconnected' || state === 'forbidden'
  const pinAttrs = pinnedSurfaceDataAttrs(
    pinned
      ? {
          canonicalSnapshotId: pinned.canonicalSnapshotId,
          canonicalHash: pinned.canonicalHash,
          boardRev: pinned.boardRev,
          lifecycleRev: pinned.lifecycleRev,
        }
      : null,
  )

  const pageStageChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const stage = item.lifecycleStage?.trim()
      if (!stage) continue
      counts.set(stage, (counts.get(stage) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const activeBucketLabel = BUCKET_SEMANTICS[activeBucket].label
  const activeBucketCount = bucketCounts?.[activeBucket]
  const queryValue = textQuery ?? ''

  const inventoryTotal = useMemo(() => {
    if (!bucketCounts) return null
    let sum = 0
    let any = false
    for (const v of Object.values(bucketCounts)) {
      if (typeof v === 'number' && Number.isFinite(v)) {
        sum += v
        any = true
      }
    }
    return any ? sum : null
  }, [bucketCounts])

  const doneCount =
    typeof bucketCounts?.DONE === 'number' ? bucketCounts.DONE : null

  const stagePanel =
    pageStageChips.length > 0 ? (
      <div
        className={styles.stageStrip}
        data-testid="work-page-stage-chips"
        aria-label="Ringkasan tahap pada halaman ini"
      >
        {pageStageChips.map(([stage, count]) => (
          <StatusChip
            key={stage}
            variant="pending"
            showDot={false}
            data-stage={stage}
            title={stage}
          >
            {formatLifecycleStageLabel(stage)} · {count}
          </StatusChip>
        ))}
      </div>
    ) : (
      <p className={styles.reason}>
        Tidak ada ringkasan tahap pada halaman ini.
      </p>
    )

  return (
    <section
      className={[styles.root, className].filter(Boolean).join(' ')}
      data-testid="work-screen"
      data-state={state}
      data-board-id={boardId}
      data-active-bucket={activeBucket}
      data-stale-overlay={staleOverlayActive ? '1' : '0'}
      aria-labelledby={`${uid}-title`}
      {...pinAttrs}
    >
      <PageHeader
        eyebrow="Pusat kendali program"
        title={<span id={`${uid}-title`}>Pekerjaan</span>}
        subtitle="Lihat hasil yang sudah selesai, pekerjaan aktif, urutan berikutnya, dan hambatan dalam satu alur yang dapat ditindaklanjuti."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Board', href: `/b/${boardId}` },
              { label: 'Pekerjaan' },
            ]}
          />
        }
        actions={
          onRefresh ? (
            <Button
              type="button"
              variant="secondary"
              size="sm"
              onClick={onRefresh}
              disabled={controlsDisabled}
            >
              Muat ulang
            </Button>
          ) : null
        }
      />

      <Disclosure summary="Detail teknis">
        <div className={styles.pinMeta}>
          <PinnedRevisionBadge pinned={pinned} />
          {pinned?.canonicalSnapshotId ? (
            <Badge mono title={pinned.canonicalSnapshotId}>
              snap{' '}
              {pinned.canonicalSnapshotId.length > 14
                ? `${pinned.canonicalSnapshotId.slice(0, 12)}…`
                : pinned.canonicalSnapshotId}
            </Badge>
          ) : null}
        </div>
      </Disclosure>

      {inventoryTotal != null && doneCount != null ? (
        <div className={styles.kpiRow}>
          <KpiStat
            size="sm"
            label="Total bucket"
            value={inventoryTotal}
            hint="Jumlah rollup server (bukan kesiapan program)"
          />
          <KpiStat
            size="sm"
            label="Selesai"
            value={doneCount}
            hint={
              inventoryTotal > 0 ? (
                <ProgressBar
                  value={doneCount}
                  max={inventoryTotal}
                  label={`${doneCount}/${inventoryTotal}`}
                />
              ) : null
            }
          />
          {typeof activeBucketCount === 'number' ? (
            <KpiStat
              size="sm"
              label={activeBucketLabel}
              value={activeBucketCount}
              hint="Tampilan aktif"
            />
          ) : null}
        </div>
      ) : null}

      <div className={styles.bucketNavigation}>
        <BucketTabs
          activeBucket={activeBucket}
          counts={bucketCounts}
          onChange={onBucketChange}
          disabled={controlsDisabled}
          idPrefix={uid}
        />
      </div>

      <Card
        className={styles.workspace}
        flush
        title={
          <span id={`${uid}-active-title`}>
            <span className={styles.summaryLabel}>Tampilan aktif · </span>
            {activeBucketLabel}
          </span>
        }
        subtitle={BUCKET_DESCRIPTIONS[activeBucket]}
        headerActions={
          typeof activeBucketCount === 'number' ? (
            <KpiStat
              size="sm"
              label="Pekerjaan"
              value={activeBucketCount}
              aria-label={`${activeBucketCount} pekerjaan`}
            />
          ) : null
        }
      >
        <div className={styles.workspace}>
          <div className={styles.filterChips} data-testid="work-filter-bar">
            <Toolbar
              searchProps={{
                id: `${uid}-query`,
                type: 'search',
                placeholder: 'Cari judul, hasil, ID, atau tahap',
                value: queryValue,
                disabled: controlsDisabled || !onTextQueryChange,
                onChange: (e) => onTextQueryChange?.(e.target.value),
                'aria-label': 'Filter teks daftar pekerjaan',
                ...({ 'data-testid': 'work-query-input' } as object),
              }}
              filters={
                <StaleOverlayFilter
                  active={staleOverlayActive}
                  summary={staleSummary}
                  onChange={onStaleOverlayChange}
                  disabled={controlsDisabled}
                />
              }
            />

            <div
              className={styles.filterChips}
              data-testid="work-active-filter-chips"
              aria-label="Filter aktif"
            >
              <Pill active data-filter="bucket" data-bucket={activeBucket}>
                Status: {activeBucketLabel}
              </Pill>
              {staleOverlayActive ? (
                <Pill active data-filter="stale">
                  Hanya data basi
                </Pill>
              ) : null}
              {queryValue.trim() ? (
                <Pill active data-filter="query">
                  “{queryValue.trim()}”
                  {onTextQueryChange ? (
                    <button
                      type="button"
                      className={styles.chipClear}
                      onClick={() => onTextQueryChange('')}
                      aria-label="Hapus filter pencarian"
                    >
                      ×
                    </button>
                  ) : null}
                </Pill>
              ) : null}
            </div>
          </div>

          <Tabs
            items={[
              {
                id: 'daftar',
                label: 'Daftar halaman',
                panel: (
                  <p className={styles.reason}>
                    {showList
                      ? `${items.length} baris pada halaman ini${
                          typeof page.totalCount === 'number'
                            ? ` · total filter ${page.totalCount}`
                            : ''
                        }.`
                      : 'Daftar disembunyikan pada status terminal.'}
                  </p>
                ),
              },
              {
                id: 'tahap',
                label: 'Tahap pada halaman ini',
                panel: stagePanel,
              },
            ]}
            defaultValue="daftar"
          />

          <div
            className={styles.liveRegion}
            role="status"
            aria-live="polite"
            aria-atomic="true"
            data-testid="work-live-region"
          >
            {liveMessage ?? ''}
          </div>

          <WorkStates
            state={state}
            error={error}
            partialMessage={partialMessage}
            envelopeStale={envelopeStale}
            envelopeStaleReason={envelopeStaleReason}
            needsHumanMessage={needsHumanMessage}
            activeBucket={activeBucket}
            staleOverlayActive={staleOverlayActive}
            onRetry={onRetry}
            onRefresh={onRefresh}
            onReconnect={onReconnect}
            onClearStale={
              onStaleOverlayChange
                ? () => onStaleOverlayChange(false)
                : undefined
            }
            onSwitchToOngoing={
              onBucketChange ? () => onBucketChange('ONGOING') : undefined
            }
          />

          {/* Always mount tabpanel so tab aria-controls IDs resolve. */}
          <div
            className={styles.listRegion}
            role="tabpanel"
            id={panelId}
            aria-labelledby={activeTabId}
            data-testid="work-tabpanel"
            data-reflow-breakpoint="768"
          >
            {showList ? (
              <>
                <WorkList
                  items={items}
                  panelId={`${panelId}-list`}
                  labelledBy={activeTabId}
                  onRowActivate={onRowActivate}
                  asNested
                />
                <WorkPagination
                  page={page}
                  onNext={onNextPage}
                  onPrev={onPrevPage}
                  disabled={controlsDisabled}
                />
              </>
            ) : null}
          </div>
        </div>
      </Card>
    </section>
  )
}
