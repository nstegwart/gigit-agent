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
          <span aria-hidden="true">⛔</span> karantina
        </span>
      ) : null}
      {row.isTombstone ? (
        <span className={`${styles.chip} ${styles.flagTombstone}`} data-flag="tombstone">
          <span aria-hidden="true">∅</span> tombstone
        </span>
      ) : null}
      {!row.isLimit && !row.quarantine && !row.isTombstone ? (
        <span className={styles.chip} data-flag="ok">
          <span aria-hidden="true">○</span> bersih
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
          <dt>Penyedia</dt>
          <dd>{row.providerKind ?? '—'}</dd>
        </div>
        <div>
          <dt>Kapasitas</dt>
          <dd className={styles.capacityBar} data-field="capacity">
            {row.capacityLabel}
          </dd>
        </div>
        <div>
          <dt>Slot fisik</dt>
          <dd className={styles.idCell}>{row.physicalSlotsDisplay ?? '—'}</dd>
        </div>
        <div>
          <dt>Alasan</dt>
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
          <p className={styles.eyebrow}>Misi Q7</p>
          <h1 id="ops-page-title" className={styles.pageTitle}>
            Operasi / Akun
          </h1>
          <p className={styles.pageSub}>
            Kapasitas akun ter-mask, karantina, LIMIT, dan audit sinkron dari envelope pin. Identitas
            mentah dan token tidak pernah ditampilkan.
          </p>
        </div>
        <div className={styles.summaryStrip}>
          <span className={`${styles.chip} ${styles.chipAccent}`} data-testid="ops-account-count">
            <span aria-hidden="true">◎</span>
            {accounts.length} akun
          </span>
          {usableCapacity != null ? (
            <span className={styles.chip} data-testid="ops-usable-capacity">
              kapasitas pakai {usableCapacity}
            </span>
          ) : null}
          {quarantineCount != null ? (
            <span
              className={`${styles.chip}${quarantineCount > 0 ? ` ${styles.flagQuarantine}` : ''}`}
              data-testid="ops-quarantine-count"
            >
              karantina {quarantineCount}
            </span>
          ) : null}
          {accountSyncStale ? (
            <span
              className={`${styles.chip} ${styles.flagSyncStale}`}
              data-testid="ops-sync-stale"
            >
              <span aria-hidden="true">⚠</span> sinkron akun basi
            </span>
          ) : (
            <span className={styles.chip} data-testid="ops-sync-fresh">
              sinkron segar
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
            {error.code}: operasi tidak tersedia
          </p>
          <p className={styles.bannerBody}>{error.message}</p>
          {onRetry ? (
            <button type="button" className={styles.retryBtn} onClick={onRetry}>
              Coba lagi
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
          <p className={styles.bannerTitle}>Celah proyeksi jujur</p>
          <p className={styles.bannerBody}>
            Stempel last-sync per akun tidak ada di AccountUiSummary; boardRev pin envelope adalah
            revisi sumber yang ditampilkan di atas.
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
            {accountSyncStale ? 'Sinkron akun basi' : 'Pin basi'}
          </p>
          <p className={styles.bannerBody}>
            {pin?.staleReason ??
              (accountSyncStale
                ? 'Server menandai STALE_ACCOUNT_SYNC atau pin basi — muat ulang untuk kebenaran audit.'
                : 'Agregasi pin basi.')}
          </p>
          {onRefresh ? (
            <button type="button" className={styles.retryBtn} onClick={onRefresh}>
              Muat ulang
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
          Tidak ada akun pada pin ini.
        </p>
      ) : null}

      {!hideList && accounts.length > 0 ? (
        <>
          <div className={styles.tableWrap} data-testid="ops-accounts-table">
            <table className={styles.table}>
              <thead>
                <tr>
                  <th scope="col">Akun ter-mask</th>
                  <th scope="col">Status</th>
                  <th scope="col">Penyedia</th>
                  <th scope="col">Kapasitas</th>
                  <th scope="col">Slot fisik</th>
                  <th scope="col">Bendera</th>
                  <th scope="col">Alasan</th>
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
