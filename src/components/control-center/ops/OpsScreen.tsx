import { pinnedSurfaceDataAttrs } from '#/components/control-center/PinnedSurface'
import type { OpsAccountRowView, OpsScreenProps } from './types'
import styles from './ops.module.css'

function AccountFlags({ row }: { row: OpsAccountRowView }) {
  return (
    <div className={styles.summaryStrip} data-testid="ops-account-flags">
      {row.isLimit ? (
        <span className={`${styles.chip} ${styles.flagLimit}`} data-flag="limit">
          <span aria-hidden="true">⚠</span> LIMIT
        </span>
      ) : null}
      {row.quarantine ? (
        <span className={`${styles.chip} ${styles.flagQuarantine}`} data-flag="quarantine">
          <span aria-hidden="true">⛔</span> quarantine
        </span>
      ) : null}
      {row.isTombstone ? (
        <span className={`${styles.chip} ${styles.flagTombstone}`} data-flag="tombstone">
          <span aria-hidden="true">∅</span> tombstone
        </span>
      ) : null}
      {!row.isLimit && !row.quarantine && !row.isTombstone ? (
        <span className={styles.chip} data-flag="ok">
          <span aria-hidden="true">○</span> clear
        </span>
      ) : null}
    </div>
  )
}

function AccountCard({ row }: { row: OpsAccountRowView }) {
  return (
    <li
      className={styles.card}
      data-testid="ops-account-card"
      data-masked-account={row.maskedAccountId}
      data-quarantine={row.quarantine ? '1' : '0'}
      data-limit={row.isLimit ? '1' : '0'}
      data-tombstone={row.isTombstone ? '1' : '0'}
    >
      <div className={styles.idCell} data-field="masked-account-id">
        {row.maskedAccountId}
      </div>
      <AccountFlags row={row} />
      <dl className={styles.cardMeta}>
        <div>
          <dt>Status</dt>
          <dd>{row.status}</dd>
        </div>
        <div>
          <dt>Provider</dt>
          <dd>{row.providerKind ?? '—'}</dd>
        </div>
        <div>
          <dt>Capacity</dt>
          <dd className={styles.capacityBar} data-field="capacity">
            {row.capacityLabel}
          </dd>
        </div>
        <div>
          <dt>Physical slots</dt>
          <dd className={styles.idCell}>{row.physicalSlotsDisplay ?? '—'}</dd>
        </div>
        <div>
          <dt>Reason</dt>
          <dd>{row.reason ?? '—'}</dd>
        </div>
      </dl>
    </li>
  )
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

      <header className={styles.pageHead}>
        <div>
          <p className={styles.eyebrow}>Mission Q7</p>
          <h1 id="ops-page-title" className={styles.pageTitle}>
            Ops / Accounts
          </h1>
          <p className={styles.pageSub}>
            Masked account capacity, quarantine, LIMIT, and sync audit from the pinned envelope.
            Raw identity and tokens are never shown.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="ops-account-count">
            <span aria-hidden="true">◎</span>
            {accounts.length} accounts
          </span>
          {usableCapacity != null ? (
            <span className={styles.chip} data-testid="ops-usable-capacity">
              usable capacity {usableCapacity}
            </span>
          ) : null}
          {quarantineCount != null ? (
            <span
              className={`${styles.chip}${quarantineCount > 0 ? ` ${styles.flagQuarantine}` : ''}`}
              data-testid="ops-quarantine-count"
            >
              quarantine {quarantineCount}
            </span>
          ) : null}
          {accountSyncStale ? (
            <span
              className={`${styles.chip} ${styles.flagSyncStale}`}
              data-testid="ops-sync-stale"
            >
              <span aria-hidden="true">⚠</span> account sync stale
            </span>
          ) : (
            <span className={styles.chip} data-testid="ops-sync-fresh">
              sync fresh
            </span>
          )}
        </div>
      </header>

      {pin ? (
        <p
          className={styles.pinStrip}
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
          pin <code>{pin.canonicalSnapshotId}</code> · boardRev {pin.boardRev} · lifecycleRev{' '}
          {pin.lifecycleRev}
          {accountSourceRevision != null
            ? ` · account sourceRevision ${accountSourceRevision}`
            : ' · account sourceRevision —'}
          {' · '}freshness {pin.freshnessAgeSeconds}s
          {pin.stale ? ` · STALE ${pin.staleReason ?? ''}` : ''}
        </p>
      ) : null}

      {capacityNote ? (
        <p className={styles.pageSub} data-testid="ops-capacity-note">
          {capacityNote}
        </p>
      ) : null}

      {error ? (
        <div
          className={`${styles.banner} ${styles.banner_error}`}
          role="alert"
          data-testid="ops-error"
        >
          <p className={styles.bannerTitle}>
            {error.code}: ops unavailable
          </p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Retry
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'partial' ||
      (projectionGaps && projectionGaps.length > 0 && surfaceState === 'populated') ? (
        <div
          className={`${styles.banner} ${styles.banner_partial}`}
          role="status"
          data-testid="ops-partial-banner"
        >
          <p className={styles.bannerTitle}>Honest projection gaps</p>
          <p className={styles.bannerBody}>
            Per-account last-sync timestamps are not on AccountUiSummary; envelope pin boardRev is
            the source revision shown above.
          </p>
          {projectionGaps && projectionGaps.length > 0 ? (
            <ul className={styles.gapList}>
              {projectionGaps.map((g) => (
                <li key={g}>{g}</li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'stale' || accountSyncStale ? (
        <div
          className={`${styles.banner} ${styles.banner_stale}`}
          role="status"
          data-testid="ops-stale-banner"
        >
          <p className={styles.bannerTitle}>
            {accountSyncStale ? 'Account sync stale' : 'Stale pin'}
          </p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ??
              (accountSyncStale
                ? 'Server flagged STALE_ACCOUNT_SYNC or pin staleness — refresh for audit truth.'
                : 'Pinned aggregation is stale.')}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Refresh
            </button>
          ) : null}
        </div>
      ) : null}

      {surfaceState === 'loading' ? (
        <div className={styles.skeleton} data-testid="ops-skeleton" aria-hidden="true">
          <div className={styles.skeletonCard} />
          <div className={styles.skeletonCard} />
        </div>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <p className={styles.empty} data-testid="ops-empty">
          No accounts on this pin.
        </p>
      ) : null}

      {!hideList && accounts.length > 0 ? (
        <>
          <div className={styles.tableWrap} data-testid="ops-accounts-table">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Masked account</th>
                  <th scope="col">Status</th>
                  <th scope="col">Provider</th>
                  <th scope="col">Capacity</th>
                  <th scope="col">Physical slots</th>
                  <th scope="col">Flags</th>
                  <th scope="col">Reason</th>
                </tr>
              </thead>
              <tbody>
                {accounts.map((row) => (
                  <tr
                    key={row.maskedAccountId}
                    data-testid="ops-account-row"
                    data-masked-account={row.maskedAccountId}
                    data-quarantine={row.quarantine ? '1' : '0'}
                    data-limit={row.isLimit ? '1' : '0'}
                    data-tombstone={row.isTombstone ? '1' : '0'}
                  >
                    <td className={styles.idCell} data-field="masked-account-id">
                      {row.maskedAccountId}
                    </td>
                    <td>
                      <span className={styles.statusDot}>{row.status}</span>
                    </td>
                    <td>{row.providerKind ?? '—'}</td>
                    <td className={styles.capacityBar} data-field="capacity">
                      {row.capacityLabel}
                    </td>
                    <td className={styles.idCell}>{row.physicalSlotsDisplay ?? '—'}</td>
                    <td>
                      <AccountFlags row={row} />
                    </td>
                    <td>{row.reason ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <ul className={styles.cardList} data-testid="ops-accounts-cards">
            {accounts.map((row) => (
              <AccountCard key={row.maskedAccountId} row={row} />
            ))}
          </ul>
        </>
      ) : null}
    </section>
  )
}
