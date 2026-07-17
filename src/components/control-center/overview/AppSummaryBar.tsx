import { formatLifecycleStageLabel, truncateIdentifier } from '#/lib/display-label'
import styles from './overview.module.css'
import type { OverviewAppSummary } from './types'

function connectionClass(conn: OverviewAppSummary['connection']): string {
  if (conn === 'live') return styles.connLive
  if (conn === 'stale') return styles.connStale
  if (conn === 'disconnected') return styles.connDown
  return ''
}

function connectionLabel(conn: OverviewAppSummary['connection']): string {
  if (conn === 'live') return 'Langsung'
  if (conn === 'stale') return 'Basi'
  if (conn === 'disconnected') return 'Terputus'
  return 'Tidak diketahui'
}

/**
 * Owner-facing pin / freshness / version strip.
 * Primary row: board, stage, freshness, connection (+ stale badge when real).
 * Technical revision/hash/snapshot stay under progressive disclosure.
 */
export function AppSummaryBar({ summary }: { summary: OverviewAppSummary }) {
  const stageLabel = formatLifecycleStageLabel(summary.liveStage) || summary.liveStage
  const hasPinDetail =
    typeof summary.boardRev === 'number' ||
    typeof summary.lifecycleRev === 'number' ||
    Boolean(summary.canonicalSnapshotId) ||
    Boolean(summary.canonicalHash) ||
    Boolean(summary.schemaVersion)

  const snap = summary.canonicalSnapshotId
    ? truncateIdentifier(summary.canonicalSnapshotId, 12, 6)
    : null
  const hash = summary.canonicalHash
    ? truncateIdentifier(summary.canonicalHash, 10, 6)
    : null

  const mapping = summary.mappingVersion

  return (
    <header
      className={styles.appBar}
      data-testid="overview-app-summary"
      aria-label="Ringkasan board"
      data-connection={summary.connection}
      data-stale={summary.stale ? 'true' : 'false'}
    >
      {mapping ? (
        <div
          className={styles.mappingBanner}
          data-testid="overview-mapping-banner"
          data-mapping-mode={mapping.mode}
          data-mapping-not-readiness="true"
          role="status"
        >
          <span className={styles.mappingBannerLabel}>Progres pemetaan</span>
          <span className={styles.mappingBannerValue} title={mapping.summaryLabel}>
            {mapping.summaryLabel}
          </span>
          {mapping.canonicalHashShort ? (
            <span
              className={styles.mappingBannerMeta}
              data-testid="overview-mapping-hash"
              title={mapping.canonicalHashShort}
            >
              hash {mapping.canonicalHashShort}
            </span>
          ) : null}
          {mapping.stale ? (
            <span className={styles.mappingBannerStale} data-testid="overview-mapping-stale">
              Basi{mapping.staleReason ? `: ${mapping.staleReason}` : ''}
            </span>
          ) : null}
          <span className={styles.mappingBannerNote}>
            Bukan kesiapan produksi
          </span>
        </div>
      ) : null}

      <div className={styles.appBarPrimary} data-testid="overview-freshness-strip">
        <div className={styles.appBarItem}>
          <span className={styles.appBarLabel}>Board</span>
          <span className={styles.appBarValue}>{summary.boardLabel ?? summary.boardId}</span>
        </div>
        <div className={styles.appBarItem}>
          <span className={styles.appBarLabel}>Tahap</span>
          <span
            className={styles.appBarValue}
            title={summary.liveStage}
            data-stage-raw={summary.liveStage}
          >
            {stageLabel}
          </span>
        </div>
        <div
          className={`${styles.appBarItem} ${styles.appBarFreshness}`}
          data-testid="overview-freshness"
        >
          <span className={styles.appBarLabel}>Kesegaran</span>
          <span className={styles.appBarValue}>{summary.freshnessLabel}</span>
        </div>
        <div className={styles.appBarItem}>
          <span className={styles.appBarLabel}>Koneksi</span>
          <span
            className={`${styles.appBarValue} ${connectionClass(summary.connection)}`}
            data-connection={summary.connection}
          >
            {connectionLabel(summary.connection)}
          </span>
        </div>
        {summary.stale ? (
          <div className={styles.appBarItem} data-stale="true">
            <span className={`${styles.severity} ${styles.sevMedium}`} role="status">
              Data basi
              {summary.staleReason ? `: ${summary.staleReason}` : null}
            </span>
          </div>
        ) : null}
      </div>

      {hasPinDetail ? (
        <details
          className={styles.techDisclosure}
          data-testid="overview-pin-detail"
        >
          <summary className={styles.techDisclosureSummary}>Detail pin &amp; revisi</summary>
          <dl className={styles.pinDetailList}>
            {typeof summary.boardRev === 'number' ? (
              <div className={styles.pinDetailRow}>
                <dt>Revisi board</dt>
                <dd
                  className={styles.metricValueMono}
                  data-field="boardRev"
                  title={String(summary.boardRev)}
                >
                  {summary.boardRev}
                </dd>
              </div>
            ) : null}
            {typeof summary.lifecycleRev === 'number' ? (
              <div className={styles.pinDetailRow}>
                <dt>Revisi lifecycle</dt>
                <dd
                  className={styles.metricValueMono}
                  data-field="lifecycleRev"
                  title={String(summary.lifecycleRev)}
                >
                  {summary.lifecycleRev}
                </dd>
              </div>
            ) : null}
            {snap ? (
              <div className={styles.pinDetailRow}>
                <dt>Snapshot</dt>
                <dd
                  className={styles.metricValueMono}
                  data-field="canonicalSnapshotId"
                  title={snap.full}
                >
                  {snap.display}
                </dd>
              </div>
            ) : null}
            {hash ? (
              <div className={styles.pinDetailRow}>
                <dt>Hash kanonis</dt>
                <dd
                  className={styles.metricValueMono}
                  data-field="canonicalHash"
                  title={hash.full}
                >
                  {hash.display}
                </dd>
              </div>
            ) : null}
            {summary.schemaVersion ? (
              <div className={styles.pinDetailRow}>
                <dt>Skema</dt>
                <dd
                  className={styles.metricValueMono}
                  data-field="schemaVersion"
                  title={summary.schemaVersion}
                >
                  {summary.schemaVersion}
                </dd>
              </div>
            ) : null}
          </dl>
        </details>
      ) : null}
    </header>
  )
}
