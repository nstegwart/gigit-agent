import styles from './overview.module.css'
import type { OverviewGlobalCard } from './types'
import { SemanticIcon } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

export function GlobalCard({ data }: { data: OverviewGlobalCard | null }) {
  if (!data) {
    return (
      <section className={styles.card} data-testid="overview-global" aria-labelledby="ov-global-title">
        <h2 id="ov-global-title" className={styles.cardTitle}>
          Kesiapan program (global)
        </h2>
        <EmptySlot>Kesiapan global tidak tersedia.</EmptySlot>
      </section>
    )
  }

  return (
    <section className={styles.card} data-testid="overview-global" aria-labelledby="ov-global-title">
      <h2 id="ov-global-title" className={styles.cardTitle}>
        <SemanticIcon kind="check" />
        Kesiapan program (global)
      </h2>
      <p className={styles.readinessNote} data-testid="overview-global-readiness-note">
        Bucket pekerjaan ≠ kesiapan mapping/produk/program. Angka di bawah dari evidence
        terbaru, bukan persentase statis.
      </p>
      <div className={styles.cardGrid}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Denom terlacak</span>
          <span className={styles.metricValue} data-field="trackedWorkDenominator">
            {data.trackedWorkDenominator}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Denom produk</span>
          <span className={styles.metricValue} data-field="productDenominator">
            {data.productDenominator}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>PROD_READY ber-evidence</span>
          <span className={styles.metricValue} data-field="prodReadyWithEvidence">
            {data.prodReadyWithEvidence}
            <span className={styles.panelMuted}> / {data.stageProdReady} tahap</span>
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>G5</span>
          <span
            className={`${styles.metricValue} ${data.g5Pass ? styles.pass : styles.fail}`}
            data-field="g5Pass"
          >
            {data.g5Pass ? 'PASS' : 'FAIL'}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Selesai</span>
          <span
            className={`${styles.metricValue} ${data.complete ? styles.pass : styles.fail}`}
            data-field="complete"
          >
            {data.complete ? 'Ya' : 'Tidak'}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Rasio board (evidence)</span>
          <span className={styles.metricValue} data-field="boardReadinessPercent">
            {data.boardReadinessPercent === null ? (
              <span className={styles.na}>N-A</span>
            ) : (
              `${data.boardReadinessPercent}%`
            )}
          </span>
        </div>
        {data.cappedBy ? (
          <div className={styles.metric}>
            <span className={styles.metricLabel}>Dibatasi oleh</span>
            <span className={`${styles.metricValue} ${styles.metricValueMono}`} title={data.cappedBy}>
              {data.cappedBy}
            </span>
          </div>
        ) : null}
      </div>
    </section>
  )
}
