import styles from './overview.module.css'
import type { OverviewGlobalCard } from './types'
import { SemanticIcon } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

export function GlobalCard({ data }: { data: OverviewGlobalCard | null }) {
  if (!data) {
    return (
      <section className={styles.card} data-testid="overview-global" aria-labelledby="ov-global-title">
        <h2 id="ov-global-title" className={styles.cardTitle}>
          GLOBAL
        </h2>
        <EmptySlot>Global readiness unavailable.</EmptySlot>
      </section>
    )
  }

  return (
    <section className={styles.card} data-testid="overview-global" aria-labelledby="ov-global-title">
      <h2 id="ov-global-title" className={styles.cardTitle}>
        <SemanticIcon kind="check" />
        GLOBAL
      </h2>
      <div className={styles.cardGrid}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Tracked denom</span>
          <span className={styles.metricValue}>{data.trackedWorkDenominator}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Product denom</span>
          <span className={styles.metricValue}>{data.productDenominator}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>PROD_READY evidence</span>
          <span className={styles.metricValue}>
            {data.prodReadyWithEvidence}
            <span className={styles.panelMuted}> / {data.stageProdReady} stage</span>
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>G5</span>
          <span className={`${styles.metricValue} ${data.g5Pass ? styles.pass : styles.fail}`}>
            {data.g5Pass ? 'PASS' : 'FAIL'}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Complete</span>
          <span className={`${styles.metricValue} ${data.complete ? styles.pass : styles.fail}`}>
            {data.complete ? 'Yes' : 'No'}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Board readiness %</span>
          <span className={styles.metricValue}>
            {data.boardReadinessPercent === null ? (
              <span className={styles.na}>N-A</span>
            ) : (
              data.boardReadinessPercent
            )}
          </span>
        </div>
        {data.cappedBy ? (
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Capped by</span>
            <span className={`${styles.metricValue} ${styles.metricValueMono}`}>{data.cappedBy}</span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
