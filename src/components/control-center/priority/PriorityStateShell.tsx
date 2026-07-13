import type { ReactNode } from 'react'
import {
  pinnedSurfaceDataAttrs,
  type PinnedSurfaceMeta,
} from '#/components/control-center/PinnedSurface'
import type { PriorityUiState } from './constants'
import styles from './priority.module.css'

export interface PriorityStateShellProps {
  uiState: PriorityUiState
  errorCode?: string | null
  errorMessage?: string | null
  onRetry?: () => void
  liveMessage?: string | null
  staleReason?: string | null
  /** Envelope pin for root data attrs. */
  pin?: PinnedSurfaceMeta | null
  children?: ReactNode
}

const STATE_COPY: Record<
  PriorityUiState,
  { title: string; body: string; role?: 'status' | 'alert' }
> = {
  populated: { title: '', body: '' },
  loading: {
    title: 'Loading priority portfolio',
    body: 'Fetching server envelope… numbers stay hidden until data arrives.',
    role: 'status',
  },
  empty: {
    title: 'No priority portfolio data',
    body: 'Server returned an empty priority envelope for this board pin.',
    role: 'status',
  },
  'zero-results': {
    title: 'No matching priority items',
    body: 'Filters matched nothing. This is distinct from an empty board envelope.',
    role: 'status',
  },
  partial: {
    title: 'Partial priority data',
    body: 'Some Priority sections failed. Showing available server fields only.',
    role: 'alert',
  },
  stale: {
    title: 'Stale priority envelope',
    body: 'Pinned data is stale. Refresh for a current board/lifecycle revision.',
    role: 'status',
  },
  disconnected: {
    title: 'Disconnected',
    body: 'Transport is down. Reconnect to load SALES_WEB_RELATED_BACKEND truth.',
    role: 'alert',
  },
  error: {
    title: 'Priority load failed',
    body: 'Hard failure loading priority portfolio. Retry when ready.',
    role: 'alert',
  },
  forbidden: {
    title: 'Forbidden',
    body: 'You do not have authorization to read the priority portfolio.',
    role: 'alert',
  },
  'needs-human': {
    title: 'Needs human decision',
    body: 'A blocking decision must be resolved before priority dispatch can proceed.',
    role: 'alert',
  },
}

/**
 * Required UI state shell (UI_CONTRACT §5). Never fabricates numbers in non-populated states.
 */
export function PriorityStateShell({
  uiState,
  errorCode,
  errorMessage,
  onRetry,
  liveMessage,
  staleReason,
  pin,
  children,
}: PriorityStateShellProps) {
  const meta = STATE_COPY[uiState]
  const showBlocking =
    uiState === 'loading' ||
    uiState === 'empty' ||
    uiState === 'zero-results' ||
    uiState === 'disconnected' ||
    uiState === 'error' ||
    uiState === 'forbidden'

  const showBanner =
    uiState === 'partial' ||
    uiState === 'stale' ||
    uiState === 'needs-human' ||
    uiState === 'error' ||
    uiState === 'disconnected' ||
    uiState === 'forbidden'

  return (
    <div
      className={styles.screen}
      data-testid="priority-screen"
      data-ui-state={uiState}
      data-portfolio="SALES_WEB_RELATED_BACKEND"
      {...pinnedSurfaceDataAttrs(pin)}
    >
      <div className={styles.liveRegion} aria-live="polite" aria-atomic="true">
        {liveMessage ?? (showBlocking ? meta.title : null)}
      </div>

      {showBanner ? (
        <div
          className={`${styles.banner} ${styles[`banner_${uiState.replace(/-/g, '_')}`] ?? ''}`}
          role={meta.role ?? 'status'}
          data-testid="priority-state-banner"
        >
          <div className={styles.bannerTitle}>{meta.title}</div>
          <p className={styles.bannerBody}>
            {errorMessage ?? meta.body}
            {uiState === 'stale' && staleReason ? (
              <>
                {' '}
                Reason: <code data-testid="priority-stale-reason">{staleReason}</code>
              </>
            ) : null}
          </p>
          {errorCode ? (
            <p className={styles.errorCode}>
              Code: <code data-testid="priority-error-code">{errorCode}</code>
            </p>
          ) : null}
          {(uiState === 'error' || uiState === 'disconnected') && onRetry ? (
            <button
              type="button"
              className={styles.retryBtn}
              onClick={onRetry}
              data-testid="priority-retry"
            >
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {uiState === 'loading' ? (
        <div
          className={styles.skeleton}
          data-testid="priority-skeleton"
          role="status"
          aria-busy="true"
          aria-label="Loading priority portfolio"
        >
          <div className={styles.skeletonBlock} />
          <div className={styles.skeletonBlock} />
          <div className={styles.skeletonBlock} />
        </div>
      ) : null}

      {uiState === 'empty' || uiState === 'zero-results' || uiState === 'forbidden' ? (
        <div className={styles.emptyPanel} data-testid={`priority-state-${uiState}`} role="status">
          <h2 className={styles.emptyTitle}>{meta.title}</h2>
          <p className={styles.emptyBody}>{errorMessage ?? meta.body}</p>
        </div>
      ) : null}

      {uiState === 'disconnected' && !onRetry ? (
        <div className={styles.emptyPanel} data-testid="priority-state-disconnected" role="alert">
          <h2 className={styles.emptyTitle}>{meta.title}</h2>
          <p className={styles.emptyBody}>{errorMessage ?? meta.body}</p>
        </div>
      ) : null}

      {/* Content when not blocking (populated / partial / stale / needs-human). */}
      {!showBlocking ? children : null}
    </div>
  )
}
