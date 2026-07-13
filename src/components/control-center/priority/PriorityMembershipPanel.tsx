import { PRIORITY_PORTFOLIO_ID } from './constants'
import type { PriorityMembershipProps } from './types'
import styles from './priority.module.css'

/**
 * Receipt-valid ACTIVE PRODUCT membership proof.
 * Displays server membership only — does not filter or reclassify tasks.
 */
export function PriorityMembershipPanel(props: PriorityMembershipProps) {
  const {
    portfolioId,
    membershipDenominator,
    membershipTaskIds,
    receiptValid,
    excludedInvalidReceiptCount,
    excludedNonProductCount,
  } = props

  const portfolioMismatch = portfolioId !== PRIORITY_PORTFOLIO_ID

  return (
    <section
      className={styles.panel}
      aria-labelledby="priority-membership-heading"
      data-testid="priority-membership"
      data-receipt-valid={receiptValid ? 'true' : 'false'}
    >
      <header className={styles.panelHead}>
        <h2 id="priority-membership-heading" className={styles.panelTitle}>
          Portfolio membership
        </h2>
        <span className={styles.portfolioBadge} data-testid="priority-portfolio-id">
          {portfolioId}
        </span>
      </header>

      {portfolioMismatch ? (
        <p className={styles.warnLine} role="alert" data-testid="priority-portfolio-mismatch">
          Unexpected portfolio id (expected {PRIORITY_PORTFOLIO_ID}). Displaying server value only.
        </p>
      ) : null}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt>Membership denominator</dt>
          <dd data-testid="priority-membership-denominator">{membershipDenominator}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Receipt-valid</dt>
          <dd
            data-testid="priority-membership-receipt-valid"
            className={receiptValid ? styles.semanticOk : styles.semanticFail}
          >
            <span className={styles.semanticIcon} aria-hidden="true">
              {receiptValid ? '✓' : '✗'}
            </span>
            {receiptValid ? 'Valid' : 'Invalid'}
          </dd>
        </div>
        {excludedInvalidReceiptCount != null ? (
          <div className={styles.stat}>
            <dt>Excluded invalid receipt</dt>
            <dd data-testid="priority-excluded-invalid-receipt">
              {excludedInvalidReceiptCount}
            </dd>
          </div>
        ) : null}
        {excludedNonProductCount != null ? (
          <div className={styles.stat}>
            <dt>Excluded non-product</dt>
            <dd data-testid="priority-excluded-non-product">{excludedNonProductCount}</dd>
          </div>
        ) : null}
      </dl>

      <div className={styles.listBlock}>
        <h3 className={styles.subTitle}>
          Membership task IDs{' '}
          <span className={styles.muted}>(ACTIVE PRODUCT, receipt-valid)</span>
        </h3>
        {membershipTaskIds.length === 0 ? (
          <p className={styles.emptyList} data-testid="priority-membership-empty">
            No membership tasks on this pin. Empty membership never implies majority PASS.
          </p>
        ) : (
          <ul className={styles.idList} data-testid="priority-membership-ids">
            {membershipTaskIds.map((id) => (
              <li key={id} className={styles.idItem}>
                <code>{id}</code>
              </li>
            ))}
          </ul>
        )}
      </div>
    </section>
  )
}
