import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import { DecisionCard } from './DecisionCard'
import type { DecisionsScreenProps } from './types'
import styles from './decisions.module.css'

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
}: DecisionsScreenProps) {
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

  return (
    <section
      className={[styles.screen, className].filter(Boolean).join(' ')}
      data-testid="control-center-decisions"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-needs-human={needsHuman ? 'true' : 'false'}
      data-open-count={openCount}
      data-blocking-count={blockingCount}
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

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>Mission Q6</p>
          <h1 id="decisions-page-title" className={styles.pageTitle}>
            Decisions
          </h1>
          <p className={styles.pageSub}>
            Owner inbox in server order (blocking → severity → due → created → id). Blocking
            decisions cannot be snoozed away.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.summaryChip} ${styles.summaryChipOpen}`}>
            <span aria-hidden="true">◎</span>
            {openCount} open
          </span>
          <span
            className={`${styles.summaryChip}${
              blockingCount > 0 ? ` ${styles.summaryChipBlocking}` : ''
            }`}
            data-testid="decisions-blocking-count"
          >
            <span aria-hidden="true">{blockingCount > 0 ? '⛔' : '○'}</span>
            {blockingCount} blocking
          </span>
        </div>
      </header>

      {pin ? (
        <p className={styles.pinStrip} data-testid="decisions-pin">
          pin <code>{pin.canonicalSnapshotId}</code>
          {pin.canonicalHash ? (
            <>
              {' '}
              · hash <code title={pin.canonicalHash}>{pin.canonicalHash.slice(0, 12)}</code>
            </>
          ) : null}{' '}
          · boardRev {pin.boardRev} · lifecycleRev {pin.lifecycleRev}
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.bannerCompact} ${styles.banner_error}`}
          role="alert"
          data-testid="decisions-error"
        >
          <p className={styles.bannerTitle}>Decisions unavailable</p>
          <p className={styles.bannerBody}>Could not load the owner inbox for this pin.</p>
          <details className={styles.diagDetails}>
            <summary>Technical detail</summary>
            <p className={styles.bannerBody}>
              <strong>{error.code}</strong>
              {error.message ? `: ${error.message}` : null}
            </p>
          </details>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {/* Compact diagnostics strip: prefer list in first viewport over dual tall banners. */}
      {(surfaceState === 'partial' ||
        surfaceState === 'stale' ||
        (projectionGaps && projectionGaps.length > 0) ||
        surfaceState === 'needs-human' ||
        (blockingCount > 0 && !hideList)) &&
      !error ? (
        <div
          className={`${styles.banner} ${styles.bannerCompact} ${
            blockingCount > 0 || surfaceState === 'needs-human'
              ? styles.banner_needs_human
              : styles.banner_partial
          }`}
          role="status"
          data-testid="decisions-diagnostics"
        >
          <p className={styles.bannerTitle}>
            {blockingCount > 0 || surfaceState === 'needs-human'
              ? 'Needs your decision'
              : surfaceState === 'stale'
                ? 'Stale pin'
                : 'Partial projection'}
          </p>
          <p className={styles.bannerBody}>
            {blockingCount > 0 || surfaceState === 'needs-human'
              ? `${blockingCount} blocking decision${blockingCount === 1 ? '' : 's'} stay visible until resolved.`
              : surfaceState === 'stale'
                ? (pin?.staleReason ??
                  'Pinned aggregation is stale — refresh for current decisions.')
                : 'Some detail fields are not on the public envelope. Empty slots below are honest.'}
          </p>
          {projectionGaps && projectionGaps.length > 0 ? (
            <details className={styles.diagDetails} data-testid="decisions-partial-banner">
              <summary>
                Projection gaps ({projectionGaps.length})
              </summary>
              <ul className={styles.gapList}>
                {projectionGaps.map((g) => (
                  <li key={g}>{g}</li>
                ))}
              </ul>
            </details>
          ) : surfaceState === 'partial' ? (
            <span className={styles.srOnly} data-testid="decisions-partial-banner">
              Partial decision projection
            </span>
          ) : null}
          {surfaceState === 'needs-human' || (blockingCount > 0 && !hideList) ? (
            <span className={styles.srOnly} data-testid="decisions-needs-human">
              Needs your decision
            </span>
          ) : null}
          {surfaceState === 'stale' && onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeleton} data-testid="decisions-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <p className={styles.empty} data-testid="decisions-empty">
          {surfaceState === 'zero-results'
            ? 'No decisions match the current filters.'
            : 'Nothing waiting on you — no open decisions for this pin.'}
        </p>
      ) : null}

      {!hideList && items.length > 0 ? (
        <ul className={styles.list} data-testid="decisions-list">
          {items.map((item) => (
            <li key={item.decisionId}>
              <DecisionCard item={item} boardId={boardId} />
            </li>
          ))}
        </ul>
      ) : null}

      {nextCursor ? (
        <p className={styles.pageSub} data-testid="decisions-next-cursor">
          More pages available (server cursor) · pageSize {pageSize}
        </p>
      ) : null}
    </section>
  )
}
