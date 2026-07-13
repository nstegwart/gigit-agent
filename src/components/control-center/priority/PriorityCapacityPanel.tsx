import { formatOperationalLabel } from '#/lib/display-label'

import { PRIORITY_PORTFOLIO_ID } from './constants'
import {
  formatBoolean,
  formatCapacityShare,
  formatMajorityAllocationPass,
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
          Capacity &amp; majority allocation
        </h2>
        <span
          className={styles.portfolioBadge}
          title={portfolioId || PRIORITY_PORTFOLIO_ID}
          data-portfolio-raw={portfolioId || PRIORITY_PORTFOLIO_ID}
        >
          {formatOperationalLabel(portfolioId || PRIORITY_PORTFOLIO_ID)}
        </span>
      </header>

      {(zeroCapacity || emptyFrontier || majorityAllocationPass === null) && (
        <p className={styles.warnLine} role="status" data-testid="priority-fail-closed-notice">
          Fail-closed: zero capacity / empty frontier / null majority never renders as majority
          PASS. Displayed majority is <strong>{majorityLabel}</strong>
          {majorityLabel === NA_TOKEN ? ' (N-A)' : ''}.
        </p>
      )}

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt>Priority closure capacity</dt>
          <dd data-testid="priority-closure-capacity">{priorityClosureCapacity}</dd>
        </div>
        <div className={styles.stat}>
          <dt>All-role closure capacity</dt>
          <dd data-testid="priority-all-closure-capacity">{allClosureCapacity}</dd>
        </div>
        <div className={styles.stat}>
          <dt>Priority capacity share</dt>
          <dd
            data-testid="priority-capacity-share"
            className={shareLabel === NA_TOKEN ? styles.semanticNa : styles.mono}
          >
            {shareLabel}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Majority allocation</dt>
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
            {majorityLabel}
            <span className={styles.srOnly}>
              raw boolean {formatBoolean(majorityAllocationPass)}
            </span>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Frontier state</dt>
          <dd
            data-testid="priority-frontier-state"
            className={styles.mono}
            title={frontierState}
            data-frontier-raw={frontierState}
          >
            {formatOperationalLabel(frontierState)}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Reason</dt>
          <dd
            data-testid="priority-capacity-reason"
            className={styles.mono}
            title={reason ?? NA_TOKEN}
            data-reason-raw={reason ?? NA_TOKEN}
          >
            {reason == null || reason === '' ? NA_TOKEN : formatOperationalLabel(reason)}
          </dd>
        </div>
      </dl>
    </section>
  )
}
