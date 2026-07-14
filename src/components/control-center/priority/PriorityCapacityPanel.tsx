import { formatOperationalLabel } from '#/lib/display-label'

import { PRIORITY_PORTFOLIO_ID } from './constants'
import {
  formatBoolean,
  formatCapacityShare,
  formatMajorityAllocationPass,
  humanCapacityReason,
  humanFrontierState,
  humanMajorityAllocation,
  humanPortfolioLabel,
  majoritySemanticClass,
  NA_TOKEN,
} from './display'
import type { PriorityCapacityProps } from './types'
import styles from './priority.module.css'

/**
 * All-role capacity, exact majority share, frontier, fail-closed false/null/N-A.
 * Never invents majority PASS when share null, capacity 0, or frontier empty.
 */
export function PriorityCapacityPanel(props: PriorityCapacityProps) {
  const {
    portfolioId,
    priorityClosureCapacity,
    allClosureCapacity,
    priorityCapacityShare,
    majorityAllocationPass,
    frontierState,
    reason,
  } = props

  const majorityLabel = formatMajorityAllocationPass(majorityAllocationPass)
  const shareLabel = formatCapacityShare(priorityCapacityShare)
  const majorityClass = majoritySemanticClass(majorityAllocationPass)
  const zeroCapacity = allClosureCapacity === 0
  const emptyFrontier =
    frontierState === 'PRIORITY_FRONTIER_EMPTY' ||
    frontierState === 'PRIORITY_FRONTIER_EXHAUSTED'
  const portfolioRaw = portfolioId || PRIORITY_PORTFOLIO_ID
  const reasonRaw = reason == null || reason === '' ? NA_TOKEN : reason
  const reasonTechnical =
    reason == null || reason === '' ? NA_TOKEN : formatOperationalLabel(reason)

  return (
    <section
      className={styles.panel}
      aria-labelledby="priority-capacity-heading"
      data-testid="priority-capacity"
      data-majority={majorityLabel}
      data-share={shareLabel}
      data-frontier={frontierState}
      data-zero-capacity={zeroCapacity ? 'true' : 'false'}
    >
      <header className={styles.panelHead}>
        <h2 id="priority-capacity-heading" className={styles.panelTitle}>
          Kapasitas &amp; alokasi mayoritas
        </h2>
        <span
          className={styles.portfolioBadge}
          title={humanPortfolioLabel(portfolioRaw)}
          data-portfolio-raw={portfolioRaw}
        >
          {portfolioRaw}
        </span>
      </header>

      {(zeroCapacity || emptyFrontier || majorityAllocationPass === null) && (
        <p className={styles.warnLine} role="status" data-testid="priority-fail-closed-notice">
          Fail-closed: kapasitas nol / frontier kosong / mayoritas null tidak pernah ditampilkan
          sebagai mayoritas PASS. Mayoritas yang ditampilkan:{' '}
          <strong>{majorityLabel}</strong>
          {majorityLabel === NA_TOKEN ? ' (N-A)' : ''}.
        </p>
      )}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt title="priorityClosureCapacity">Kapasitas penutupan prioritas</dt>
          <dd data-testid="priority-closure-capacity">{priorityClosureCapacity}</dd>
        </div>
        <div className={styles.stat}>
          <dt title="allClosureCapacity">Kapasitas penutupan semua peran</dt>
          <dd data-testid="priority-all-closure-capacity">{allClosureCapacity}</dd>
        </div>
        <div className={styles.stat}>
          <dt title="priorityCapacityShare">Porsi kapasitas prioritas</dt>
          <dd
            data-testid="priority-capacity-share"
            className={shareLabel === NA_TOKEN ? styles.semanticNa : styles.mono}
          >
            {shareLabel}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="majorityAllocationPass">Alokasi mayoritas</dt>
          <dd
            data-testid="priority-majority-pass"
            className={
              majorityClass === 'pass'
                ? styles.semanticOk
                : majorityClass === 'fail'
                  ? styles.semanticFail
                  : styles.semanticNa
            }
            data-majority-raw={
              majorityAllocationPass === null
                ? 'null'
                : majorityAllocationPass
                  ? 'true'
                  : 'false'
            }
          >
            <span className={styles.semanticIcon} aria-hidden="true">
              {majorityClass === 'pass' ? '✓' : majorityClass === 'fail' ? '✗' : '–'}
            </span>
            {humanMajorityAllocation(majorityAllocationPass)}{' '}
            <strong>{majorityLabel}</strong>
            <span className={styles.srOnly}>
              raw boolean {formatBoolean(majorityAllocationPass)}
            </span>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="frontierState">Status frontier prioritas</dt>
          <dd>
            <span>{humanFrontierState(frontierState)}</span>
            <div>
              <code
                data-testid="priority-frontier-state"
                className={styles.mono}
                title={frontierState}
                data-frontier-raw={frontierState}
              >
                {formatOperationalLabel(frontierState)}
              </code>
            </div>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="reason">Alasan kapasitas</dt>
          <dd>
            <span>{humanCapacityReason(reason)}</span>
            <div>
              <code
                data-testid="priority-capacity-reason"
                className={styles.mono}
                title={reasonRaw}
                data-reason-raw={reasonRaw}
              >
                {reasonTechnical}
              </code>
            </div>
          </dd>
        </div>
      </dl>
    </section>
  )
}
