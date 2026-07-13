import { Icon } from '#/lib/icons'
import type { PrimaryBucket } from '#/lib/control-plane-types'
import { BUCKET_SEMANTICS } from './labels'
import type { WorkScreenError, WorkSurfaceState } from './types'
import styles from './work.module.css'

export interface WorkStatesProps {
  state: WorkSurfaceState
  error?: WorkScreenError | null
  partialMessage?: string | null
  envelopeStale?: boolean
  envelopeStaleReason?: string | null
  needsHumanMessage?: string | null
  onRetry?: () => void
  onRefresh?: () => void
  onReconnect?: () => void
}

function ActionButton({
  label,
  onClick,
  primary,
  testId,
}: {
  label: string
  onClick?: () => void
  primary?: boolean
  testId: string
}) {
  if (!onClick) return null
  return (
    <button
      type="button"
      className={[styles.btn, primary ? styles.btnPrimary : ''].filter(Boolean).join(' ')}
      onClick={onClick}
      data-testid={testId}
    >
      {label}
    </button>
  )
}

/** Loading skeleton — no fake numbers (UI_CONTRACT §5). */
export function WorkLoadingState() {
  return (
    <div
      className={styles.skeletonList}
      role="status"
      aria-live="polite"
      aria-busy="true"
      data-testid="work-state-loading"
    >
      <span className={styles.srOnly}>Loading work items…</span>
      <div className={styles.skeletonRow} />
      <div className={styles.skeletonRow} />
      <div className={styles.skeletonRow} />
      <div className={styles.skeletonRow} />
    </div>
  )
}

export function WorkEmptyState({
  kind,
  activeBucket,
  staleOverlayActive,
  onClearStale,
  onSwitchToOngoing,
}: {
  kind: 'empty' | 'zero-results'
  activeBucket?: PrimaryBucket
  staleOverlayActive?: boolean
  onClearStale?: () => void
  onSwitchToOngoing?: () => void
}) {
  const bucketLabel = activeBucket
    ? BUCKET_SEMANTICS[activeBucket]?.label ?? activeBucket
    : 'this bucket'
  const title = kind === 'zero-results' ? 'No matching work items' : 'No work in this board'
  const body =
    kind === 'zero-results'
      ? staleOverlayActive
        ? `No server rows in ${bucketLabel} with the STALE overlay on. Clear STALE or switch bucket.`
        : `No server rows in the ${bucketLabel} bucket for the current pin.`
      : activeBucket
        ? `No tracked work items in ${bucketLabel} for the active stage.`
        : 'This board has no tracked work items for the active stage.'
  const showClearStale = kind === 'zero-results' && !!staleOverlayActive && !!onClearStale
  const showSwitchOngoing =
    kind === 'zero-results' &&
    !!onSwitchToOngoing &&
    !!activeBucket &&
    activeBucket !== 'ONGOING'
  return (
    <div
      className={styles.emptyState}
      role="status"
      data-testid={kind === 'zero-results' ? 'work-state-zero-results' : 'work-state-empty'}
      data-active-bucket={activeBucket ?? undefined}
      data-stale-overlay={staleOverlayActive ? '1' : '0'}
    >
      <Icon name="inbox" size={20} />
      <h3>{title}</h3>
      <p>{body}</p>
      {showClearStale || showSwitchOngoing ? (
        <div className={styles.bannerActions}>
          {showClearStale ? (
            <button
              type="button"
              className={[styles.btn, styles.btnPrimary].join(' ')}
              onClick={onClearStale}
              data-testid="work-empty-clear-stale"
            >
              Clear STALE filter
            </button>
          ) : null}
          {showSwitchOngoing ? (
            <button
              type="button"
              className={styles.btn}
              onClick={onSwitchToOngoing}
              data-testid="work-empty-switch-ongoing"
            >
              Switch to Ongoing
            </button>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

/**
 * Banner / empty / error surfaces for Work. State is parent-controlled;
 * this package never invents transport outcomes.
 */
export function WorkStates({
  state,
  error,
  partialMessage,
  envelopeStale,
  envelopeStaleReason,
  needsHumanMessage,
  activeBucket,
  staleOverlayActive,
  onRetry,
  onRefresh,
  onReconnect,
  onClearStale,
  onSwitchToOngoing,
}: WorkStatesProps & {
  activeBucket?: PrimaryBucket
  staleOverlayActive?: boolean
  onClearStale?: () => void
  onSwitchToOngoing?: () => void
}) {
  if (state === 'loading') return <WorkLoadingState />

  if (state === 'empty') {
    return <WorkEmptyState kind="empty" activeBucket={activeBucket} />
  }
  if (state === 'zero-results') {
    return (
      <WorkEmptyState
        kind="zero-results"
        activeBucket={activeBucket}
        staleOverlayActive={staleOverlayActive}
        onClearStale={onClearStale}
        onSwitchToOngoing={onSwitchToOngoing}
      />
    )
  }

  if (state === 'disconnected') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerMuted}`}
        role="alert"
        data-testid="work-state-disconnected"
      >
        <Icon name="alert" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Disconnected</p>
          <p className={styles.bannerText}>
            Transport is down. Work data may be incomplete until reconnect.
          </p>
        </div>
        <div className={styles.bannerActions}>
          <ActionButton
            label="Reconnect"
            onClick={onReconnect}
            primary
            testId="work-reconnect"
          />
        </div>
      </div>
    )
  }

  if (state === 'forbidden') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-testid="work-state-forbidden"
      >
        <Icon name="lock" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Forbidden</p>
          <p className={styles.bannerText}>
            {error?.message ?? 'You are not authorized to view this work list (401/403).'}
          </p>
          {error?.code ? (
            <p className={styles.fieldError} data-testid="work-error-code">
              {error.code}
            </p>
          ) : null}
        </div>
      </div>
    )
  }

  if (state === 'error') {
    const fieldId = error?.field ? `work-field-error-${error.field}` : undefined
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-testid="work-state-error"
        aria-describedby={fieldId}
      >
        <Icon name="alert" size={18} />
        <div className={styles.bannerBody}>
          <p className={styles.bannerTitle}>Could not load work</p>
          <p className={styles.bannerText}>{error?.message ?? 'Unknown error'}</p>
          {error?.code ? (
            <p className={styles.fieldError} data-testid="work-error-code">
              {error.code}
            </p>
          ) : null}
          {error?.field ? (
            <p className={styles.fieldError} id={fieldId} data-testid="work-field-error">
              Field: {error.field}
            </p>
          ) : null}
        </div>
        <div className={styles.bannerActions}>
          {error?.retryable !== false ? (
            <ActionButton label="Retry" onClick={onRetry} primary testId="work-retry" />
          ) : null}
        </div>
      </div>
    )
  }

  // Non-terminal banners that may coexist with a list (partial / stale / needs-human)
  return (
    <>
      {state === 'partial' || partialMessage ? (
        <div
          className={`${styles.banner} ${styles.bannerWarn}`}
          role="status"
          data-testid="work-state-partial"
        >
          <Icon name="alert" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Partial data</p>
            <p className={styles.bannerText}>
              {partialMessage ?? 'Some sections failed; showing available rows only.'}
            </p>
          </div>
          <div className={styles.bannerActions}>
            <ActionButton label="Retry" onClick={onRetry} testId="work-retry" />
          </div>
        </div>
      ) : null}

      {state === 'stale' || envelopeStale ? (
        <div
          className={`${styles.banner} ${styles.bannerWarn}`}
          role="status"
          data-testid="work-state-stale"
        >
          <Icon name="clock" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Stale envelope</p>
            <p className={styles.bannerText}>
              {envelopeStaleReason ?? 'Server marked this response stale. Refresh for current pin.'}
            </p>
          </div>
          <div className={styles.bannerActions}>
            <ActionButton label="Refresh" onClick={onRefresh} primary testId="work-refresh" />
          </div>
        </div>
      ) : null}

      {state === 'needs-human' || needsHumanMessage ? (
        <div
          className={`${styles.banner} ${styles.bannerError}`}
          role="status"
          data-testid="work-state-needs-human"
        >
          <Icon name="flag" size={18} />
          <div className={styles.bannerBody}>
            <p className={styles.bannerTitle}>Needs human decision</p>
            <p className={styles.bannerText}>
              {needsHumanMessage ?? 'An open blocking decision is elevated for this board.'}
            </p>
          </div>
        </div>
      ) : null}
    </>
  )
}
