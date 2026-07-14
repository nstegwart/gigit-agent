import { formatOperationalLabel } from '#/lib/display-label'

import styles from './overview.module.css'
import type { OverviewPriorityCard } from './types'
import { SemanticIcon } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

function boolDisplay(v: boolean | null, naLabel: string): { text: string; cls: string } {
  if (v === null) return { text: naLabel, cls: styles.na }
  return v
    ? { text: 'PASS', cls: styles.pass }
    : { text: 'FAIL', cls: styles.fail }
}

export function PriorityCard({ data }: { data: OverviewPriorityCard | null }) {
  if (!data) {
    return (
      <section className={styles.card} data-testid="overview-priority" aria-labelledby="ov-priority-title">
        <h2 id="ov-priority-title" className={styles.cardTitle}>
          Prioritas + progres bukti
        </h2>
        <EmptySlot>Portofolio prioritas tidak tersedia.</EmptySlot>
      </section>
    )
  }

  const majority = boolDisplay(data.majorityAllocationPass, data.majorityDisplay)
  const g5 = boolDisplay(data.g5Pass, 'N-A')
  const complete = boolDisplay(data.complete, 'N-A')

  return (
    <section
      className={styles.card}
      data-testid="overview-priority"
      data-portfolio={data.portfolioId}
      aria-labelledby="ov-priority-title"
    >
      <h2
        id="ov-priority-title"
        className={styles.cardTitle}
        title={data.portfolioId}
        data-portfolio-raw={data.portfolioId}
      >
        <SemanticIcon kind="forward" />
        Prioritas + progres bukti · {formatOperationalLabel(data.portfolioId)}
      </h2>
      <div className={styles.cardGrid}>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Denom keanggotaan</span>
          <span className={styles.metricValue}>{data.membershipDenominator}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Denom produk</span>
          <span className={styles.metricValue}>{data.productDenominator}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>PROD_READY ber-evidence</span>
          <span className={styles.metricValue}>
            {data.prodReadyWithEvidence}
            <span className={styles.panelMuted}> / {data.stageProdReady} tahap</span>
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>G5</span>
          <span className={`${styles.metricValue} ${g5.cls}`}>{data.g5Pass ? 'PASS' : 'FAIL'}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Selesai</span>
          <span className={`${styles.metricValue} ${complete.cls}`}>
            {data.complete ? 'Ya' : 'Tidak'}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Porsi kapasitas</span>
          <span className={`${styles.metricValue} ${styles.metricValueMono}`}>
            {data.capacityShareDisplay}
          </span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Alokasi mayoritas</span>
          <span className={`${styles.metricValue} ${majority.cls}`}>{majority.text}</span>
        </div>
        <div className={styles.metric}>
          <span className={styles.metricLabel}>Frontier</span>
          <span
            className={`${styles.metricValue} ${styles.metricValueEnum}`}
            title={data.frontierState}
            data-frontier-raw={data.frontierState}
            data-testid="overview-priority-frontier"
          >
            {formatOperationalLabel(data.frontierState)}
          </span>
        </div>
      </div>
      {data.dispatchReason ? (
        <p
          className={styles.decisionQuestion}
          data-testid="priority-dispatch-reason"
          title={data.dispatchReason}
          data-reason-raw={data.dispatchReason}
        >
          <strong>Alasan dispatch:</strong> {formatOperationalLabel(data.dispatchReason)}
        </p>
      ) : null}
      {data.nonPriorityReason ? (
        <p
          className={styles.decisionQuestion}
          data-testid="priority-non-priority-reason"
          title={data.nonPriorityReason}
          data-reason-raw={data.nonPriorityReason}
        >
          <strong>Alasan non-prioritas:</strong> {formatOperationalLabel(data.nonPriorityReason)}
        </p>
      ) : null}
      {data.blockers?.length ? (
        <>
          <ul className={styles.blockers} aria-label="Hambatan prioritas">
            {data.blockers.map((b, i) => (
              <li key={`${i}:${b}`} className={styles.blockerItem}>
                <SemanticIcon kind="stop" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          {data.blockersDetail?.length ? (
            <details className={styles.bannerDetails}>
              <summary>
                Detail teknis ({data.blockersDetail.length} kode)
              </summary>
              <ul className={styles.blockers}>
                {data.blockersDetail.map((e) => (
                  <li key={`${e.code}:${e.message}`} className={styles.blockerItem}>
                    <span>
                      <strong>{e.code}</strong>: {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </details>
          ) : null}
        </>
      ) : null}
    </section>
  )
}
