import styles from './overview.module.css'
import type { OverviewAppSummary } from './types'

function connectionClass(conn: OverviewAppSummary['connection']): string {
  if (conn === 'live') return styles.connLive
  if (conn === 'stale') return styles.connStale
  if (conn === 'disconnected') return styles.connDown
  return ''
}

function connectionLabel(conn: OverviewAppSummary['connection']): string {
  if (conn === 'live') return 'Live'
  if (conn === 'stale') return 'Stale'
  if (conn === 'disconnected') return 'Disconnected'
  return 'Unknown'
}

export function AppSummaryBar({ summary }: { summary: OverviewAppSummary }) {
  return (
    <header
      className={styles.appBar}
      data-testid="overview-app-summary"
      aria-label="Board summary"
    >
      <div className={styles.appBarItem}>
        <span className={styles.appBarLabel}>Board</span>
        <span className={styles.appBarValue}>{summary.boardLabel ?? summary.boardId}</span>
      </div>
      <div className={styles.appBarItem}>
        <span className={styles.appBarLabel}>Stage</span>
        <span className={styles.appBarValue}>{summary.liveStage}</span>
      </div>
      <div className={styles.appBarItem}>
        <span className={styles.appBarLabel}>Freshness</span>
        <span className={styles.appBarValue}>{summary.freshnessLabel}</span>
      </div>
      <div className={styles.appBarItem}>
        <span className={styles.appBarLabel}>Connection</span>
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
            STALE
            {summary.staleReason ? `: ${summary.staleReason}` : null}
          </span>
        </div>
      ) : null}
      {typeof summary.boardRev === 'number' ? (
        <div className={styles.appBarItem}>
          <span className={styles.appBarLabel}>boardRev</span>
          <span className={`${styles.appBarValue} ${styles.metricValueMono}`}>{summary.boardRev}</span>
        </div>
      ) : null}
    </header>
  )
}
