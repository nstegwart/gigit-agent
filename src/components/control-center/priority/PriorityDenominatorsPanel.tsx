import type { PriorityRollupDenominatorsProps } from './types'
import styles from './priority.module.css'

/**
 * DISTINCT product/tracked denominators from server rollup.
 * Never averages or re-derives denominators client-side.
 */
export function PriorityDenominatorsPanel(props: PriorityRollupDenominatorsProps) {
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
          DISTINCT denominators
        </h2>
      </header>

      {emptyProduct ? (
        <p className={styles.warnLine} role="status" data-testid="priority-empty-product-scope">
          productDenominator=0 — readiness must stay null / N-A; complete must stay false (never
          100% / PASS from empty scope).
        </p>
      ) : null}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt>Product denominator</dt>
          <dd data-testid="priority-product-denominator">{productDenominator}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Tracked work denominator</dt>
          <dd data-testid="priority-tracked-denominator">{trackedWorkDenominator}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Stage PROD_READY</dt>
          <dd data-testid="priority-stage-prod-ready">{stageProdReady}</dd>
        </div>
        <div className={styles.stat}>
          <dt>PROD_READY with evidence</dt>
          <dd data-testid="priority-prod-ready-evidence">{prodReadyWithEvidence}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Unclassified count</dt>
          <dd data-testid="priority-unclassified-count">{unclassifiedCount}</dd>
        </div>
      </dl>

      {productTaskIds && productTaskIds.length > 0 ? (
        <details className={styles.details}>
          <summary className={styles.detailsSummary}>Product task IDs (DISTINCT)</summary>
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
          <summary className={styles.detailsSummary}>Tracked task IDs (DISTINCT)</summary>
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
