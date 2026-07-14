import { useId, useMemo } from 'react'
import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
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

/**
 * Prop-driven Work screen shell (UI_CONTRACT §5–§7, §11).
 * Parent owns query, deep-link sync, and server list_work_items binding.
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
  // Match BucketTabs sanitization so tab id / aria-controls IDREFs always resolve.
  const uid = rawUid.replace(/[^A-Za-z0-9_-]/g, '')
  const panelId = `${uid}-panel`
  const activeTabId = `${uid}-tab-${activeBucket}`
  const showList = !LIST_TERMINAL.has(state)
  const controlsDisabled = state === 'loading' || state === 'disconnected' || state === 'forbidden'
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

  /** Page-local stage histogram for scanability (display of served rows only). */
  const pageStageChips = useMemo(() => {
    const counts = new Map<string, number>()
    for (const item of items) {
      const stage = item.lifecycleStage?.trim()
      if (!stage) continue
      counts.set(stage, (counts.get(stage) ?? 0) + 1)
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1])
  }, [items])

  const activeBucketLabel = BUCKET_SEMANTICS[activeBucket]?.label ?? activeBucket
  const queryValue = textQuery ?? ''

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
      <div className={styles.header}>
        <h1 className={styles.title} id={`${uid}-title`}>
          Pekerjaan
        </h1>
        <div className={styles.metaRow}>
          <PinnedRevisionBadge pinned={pinned} />
        </div>
      </div>

      <div className={styles.tabBar}>
        <BucketTabs
          activeBucket={activeBucket}
          counts={bucketCounts}
          onChange={onBucketChange}
          disabled={controlsDisabled}
          idPrefix={uid}
        />
        <StaleOverlayFilter
          active={staleOverlayActive}
          summary={staleSummary}
          onChange={onStaleOverlayChange}
          disabled={controlsDisabled}
        />
      </div>

      <div className={styles.filterBar} data-testid="work-filter-bar">
        <label className={styles.filterSearchLabel} htmlFor={`${uid}-query`}>
          <span className={styles.filterSearchCaption}>Cari di halaman ini</span>
          <input
            id={`${uid}-query`}
            type="search"
            className={styles.filterSearch}
            data-testid="work-query-input"
            placeholder="Judul, id, tahap…"
            value={queryValue}
            disabled={controlsDisabled || !onTextQueryChange}
            onChange={(e) => onTextQueryChange?.(e.target.value)}
            aria-label="Filter teks daftar pekerjaan"
          />
        </label>
        <div
          className={styles.activeFilterChips}
          data-testid="work-active-filter-chips"
          aria-label="Filter aktif"
        >
          <span className={styles.filterChip} data-filter="bucket" data-bucket={activeBucket}>
            Bucket: {activeBucketLabel}
          </span>
          {staleOverlayActive ? (
            <span className={styles.filterChip} data-filter="stale">
              Overlay: BASI
            </span>
          ) : null}
          {queryValue.trim() ? (
            <span className={styles.filterChip} data-filter="query">
              Cari: {queryValue.trim()}
              {onTextQueryChange ? (
                <button
                  type="button"
                  className={styles.filterChipClear}
                  onClick={() => onTextQueryChange('')}
                  aria-label="Hapus filter pencarian"
                >
                  ×
                </button>
              ) : null}
            </span>
          ) : null}
        </div>
        {pageStageChips.length > 0 ? (
          <div
            className={styles.stageChipStrip}
            data-testid="work-page-stage-chips"
            aria-label="Ringkasan tahap pada halaman ini"
          >
            {pageStageChips.map(([stage, count]) => (
              <span
                key={stage}
                className={styles.stageChip}
                data-stage={stage}
                title={stage}
              >
                {formatLifecycleStageLabel(stage)} · {count}
              </span>
            ))}
          </div>
        ) : null}
      </div>

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
          onStaleOverlayChange ? () => onStaleOverlayChange(false) : undefined
        }
        onSwitchToOngoing={
          onBucketChange ? () => onBucketChange('ONGOING') : undefined
        }
      />

      {/* Always mount tabpanel so tab aria-controls IDs resolve (axe aria-valid-attr-value). */}
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
    </section>
  )
}
