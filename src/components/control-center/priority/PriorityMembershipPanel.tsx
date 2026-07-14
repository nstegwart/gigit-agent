import { PRIORITY_PORTFOLIO_ID } from './constants'
import { humanPortfolioLabel } from './display'
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
          Keanggotaan portofolio
        </h2>
        <span
          className={styles.portfolioBadge}
          data-testid="priority-portfolio-id"
          title={humanPortfolioLabel(portfolioId)}
        >
          {portfolioId}
        </span>
      </header>

      <p className={styles.muted} data-testid="priority-portfolio-human">
        {humanPortfolioLabel(portfolioId)}
      </p>

      {portfolioMismatch ? (
        <p className={styles.warnLine} role="alert" data-testid="priority-portfolio-mismatch">
          ID portofolio tidak diharapkan (seharusnya {PRIORITY_PORTFOLIO_ID}). Menampilkan nilai
          server apa adanya.
          <details className={styles.details}>
            <summary className={styles.detailsSummary}>Detail teknis</summary>
            <code>
              expected={PRIORITY_PORTFOLIO_ID}; got={portfolioId}
            </code>
          </details>
        </p>
      ) : null}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt title="membershipDenominator">Penyebut keanggotaan</dt>
          <dd data-testid="priority-membership-denominator">{membershipDenominator}</dd>
        </div>
        <div className={styles.stat}>
          <dt title="receiptValid">Bukti receipt valid</dt>
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
            <dt title="excludedInvalidReceiptCount">Dikeluarkan (receipt tidak valid)</dt>
            <dd data-testid="priority-excluded-invalid-receipt">
              {excludedInvalidReceiptCount}
            </dd>
          </div>
        ) : null}
        {excludedNonProductCount != null ? (
          <div className={styles.stat}>
            <dt title="excludedNonProductCount">Dikeluarkan (bukan produk)</dt>
            <dd data-testid="priority-excluded-non-product">{excludedNonProductCount}</dd>
          </div>
        ) : null}
      </dl>

      <div className={styles.listBlock}>
        <h3 className={styles.subTitle}>
          Anggota portofolio{' '}
          <span className={styles.muted}>(ACTIVE PRODUCT, receipt valid)</span>
        </h3>
        {membershipTaskIds.length === 0 ? (
          <p className={styles.emptyList} data-testid="priority-membership-empty">
            Tidak ada tugas keanggotaan pada pin ini. Keanggotaan kosong never implies majority
            PASS.
          </p>
        ) : (
          <details className={styles.details} open={membershipTaskIds.length <= 12}>
            <summary className={styles.detailsSummary}>
              Detail teknis — ID tugas keanggotaan ({membershipTaskIds.length})
            </summary>
            <ul className={styles.idList} data-testid="priority-membership-ids">
              {membershipTaskIds.map((id) => (
                <li key={id} className={styles.idItem}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </details>
        )}
      </div>
    </section>
  )
}
