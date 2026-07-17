import type { PriorityRollupDenominatorsProps } from './types'
import styles from './priority.module.css'

/**
 * DISTINCT product/tracked denominators from server rollup.
 * Never averages or re-derives denominators client-side.
 * Labels are id-ID primary; technical field names stay on title / Detail teknis.
 */
export function PriorityDenominatorsPanel(
  props: PriorityRollupDenominatorsProps,
) {
  const {
    productDenominator,
    trackedWorkDenominator,
    stageProdReady,
    prodReadyWithEvidence,
    unclassifiedCount,
    productTaskIds,
    trackedTaskIds,
  } = props

  const emptyProduct = productDenominator === 0

  return (
    <section
      className={styles.panel}
      aria-labelledby="priority-denominators-heading"
      data-testid="priority-denominators"
      data-empty-product={emptyProduct ? 'true' : 'false'}
    >
      <header className={styles.panelHead}>
        <h2 id="priority-denominators-heading" className={styles.panelTitle}>
          Penyebut terpisah (DISTINCT)
        </h2>
      </header>

      {emptyProduct ? (
        <div
          className={styles.warnLine}
          role="status"
          data-testid="priority-empty-product-scope"
        >
          Belum ada tugas produk pada cakupan ini, jadi kesiapan belum dapat
          dihitung dan ditampilkan sebagai <strong>N/A</strong> — tidak pernah
          dibulatkan menjadi 100% atau lolos dari cakupan kosong.
          <details className={styles.details}>
            <summary className={styles.detailsSummary}>Detail teknis</summary>
            <code>
              productDenominator=0 — readiness must stay null / N-A; complete
              must stay false (never 100% / PASS from empty scope).
            </code>
          </details>
        </div>
      ) : null}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt title="productDenominator">Penyebut produk</dt>
          <dd data-testid="priority-product-denominator">
            {productDenominator}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="trackedWorkDenominator">Penyebut pekerjaan terlacak</dt>
          <dd data-testid="priority-tracked-denominator">
            {trackedWorkDenominator}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="stageProdReady">Tahap PROD_READY</dt>
          <dd data-testid="priority-stage-prod-ready">{stageProdReady}</dd>
        </div>
        <div className={styles.stat}>
          <dt title="prodReadyWithEvidence">PROD_READY dengan bukti</dt>
          <dd data-testid="priority-prod-ready-evidence">
            {prodReadyWithEvidence}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="unclassifiedCount">Jumlah belum terklasifikasi</dt>
          <dd data-testid="priority-unclassified-count">{unclassifiedCount}</dd>
        </div>
      </dl>

      {productTaskIds && productTaskIds.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>
            Detail teknis — ID tugas produk (DISTINCT)
          </summary>
          <ul className={styles.idList} data-testid="priority-product-task-ids">
            {productTaskIds.map((id) => (
              <li key={id} className={styles.idItem}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}

      {trackedTaskIds && trackedTaskIds.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>
            Detail teknis — ID tugas terlacak (DISTINCT)
          </summary>
          <ul className={styles.idList} data-testid="priority-tracked-task-ids">
            {trackedTaskIds.map((id) => (
              <li key={id} className={styles.idItem}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        </details>
      ) : null}
    </section>
  )
}
