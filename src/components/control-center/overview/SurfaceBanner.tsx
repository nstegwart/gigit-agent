import styles from './overview.module.css'
import type { OverviewSurfaceState, TypedErrorShape } from './types'

export function SurfaceBanner({
  state,
  error,
  partialErrors,
  staleReason,
  onRetry,
  onReconnect,
}: {
  state: OverviewSurfaceState
  error?: TypedErrorShape | null
  partialErrors?: TypedErrorShape[]
  staleReason?: string | null
  onRetry?: () => void
  onReconnect?: () => void
}) {
  if (state === 'populated' || state === 'needs-human' || state === 'empty') {
    return null
  }

  if (state === 'loading') {
    return (
      <div className={`${styles.banner} ${styles.bannerMuted}`} role="status" data-state="loading">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Loading overview</div>
          <p className={styles.bannerText}>Fetching pinned mission envelope…</p>
        </div>
      </div>
    )
  }

  if (state === 'zero-results') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerMuted}`}
        role="status"
        data-state="zero-results"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>No matching results</div>
          <p className={styles.bannerText}>
            Filters matched no work items. Clear filters to see the full board.
          </p>
        </div>
      </div>
    )
  }

  if (state === 'partial') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerCompact} ${styles.bannerWarn}`}
        role="alert"
        data-state="partial"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Partial overview</div>
          <p className={styles.bannerText}>Some sections failed — showing available data only.</p>
          {partialErrors?.length ? (
            <details className={styles.bannerDetails}>
              <summary>
                Technical detail ({partialErrors.length} code
                {partialErrors.length === 1 ? '' : 's'})
              </summary>
              <ul className={styles.blockers}>
                {partialErrors.map((e) => (
                  <li key={`${e.code}:${e.message}`} className={styles.blockerItem}>
                    <span>
                      <strong>{e.code}</strong>: {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Retry failed sections
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'stale') {
    return (
      <div className={`${styles.banner} ${styles.bannerWarn}`} role="status" data-state="stale">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Stale data</div>
          <p className={styles.bannerText}>
            {staleReason?.trim() || 'Envelope marked stale. Refresh for current pins.'}
          </p>
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Refresh
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'disconnected') {
    return (
      <div
        className={`${styles.banner} ${styles.bannerError}`}
        role="alert"
        data-state="disconnected"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Disconnected</div>
          <p className={styles.bannerText}>Transport is down. Reconnect to resume live updates.</p>
        </div>
        {onReconnect ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onReconnect}>
              Reconnect
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'error') {
    const shortMsg = error?.message?.trim() || 'Unknown error'
    return (
      <div
        className={`${styles.banner} ${styles.bannerCompact} ${styles.bannerError}`}
        role="alert"
        data-state="error"
      >
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Overview failed</div>
          <p className={styles.bannerText}>Could not load the mission envelope.</p>
          {error?.code || shortMsg ? (
            <details className={styles.bannerDetails}>
              <summary>Technical detail</summary>
              <p className={styles.bannerText}>
                {error?.code ? (
                  <>
                    <strong>{error.code}</strong>
                    {error.message ? `: ${error.message}` : null}
                  </>
                ) : (
                  shortMsg
                )}
              </p>
            </details>
          ) : null}
        </div>
        {onRetry ? (
          <div className={styles.bannerActions}>
            <button type="button" className={styles.actionBtn} onClick={onRetry}>
              Retry
            </button>
          </div>
        ) : null}
      </div>
    )
  }

  if (state === 'forbidden') {
    return (
      <div className={`${styles.banner} ${styles.bannerError}`} role="alert" data-state="forbidden">
        <div className={styles.bannerBody}>
          <div className={styles.bannerTitle}>Access denied</div>
          <p className={styles.bannerText}>
            {error?.code === 'AUTHORIZATION_REQUIRED' || error?.code
              ? `${error.code}${error.message ? `: ${error.message}` : ''}`
              : 'You do not have permission to view this overview (401/403).'}
          </p>
        </div>
      </div>
    )
  }

  return null
}

export function OverviewSkeleton() {
  return (
    <div className={styles.skeleton} data-testid="overview-skeleton" aria-hidden="true">
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
      <div className={styles.skelBlock} />
    </div>
  )
}

export function EmptySlot({ children }: { children: React.ReactNode }) {
  return (
    <div className={styles.emptySlot} data-empty="true">
      {children}
    </div>
  )
}
