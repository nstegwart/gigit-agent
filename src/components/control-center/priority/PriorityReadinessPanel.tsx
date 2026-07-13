import {
  formatBoolean,
  formatCappedBy,
  formatReadinessPercent,
} from './display'
import type { PriorityReadinessProps } from './types'
import styles from './priority.module.css'

/**
 * Readiness / complete / cappedBy — server envelope only.
 * Null readiness and complete=false must never render as success.
 */
export function PriorityReadinessPanel(props: PriorityReadinessProps) {
  const {
    boardReadinessPercent,
    rawTaskReadinessPercent,
    complete,
    cappedBy,
    g5Pass,
    taskReadinessPolicyVersion,
    boardReadinessPolicyVersion,
  } = props

  const boardDisplay = formatReadinessPercent(boardReadinessPercent)
  const rawDisplay = formatReadinessPercent(rawTaskReadinessPercent)
  const isNaBoard = boardDisplay === 'N-A'
  const completeClass = complete ? styles.semanticOk : styles.semanticFail

  return (
    <section
      className={styles.panel}
      aria-labelledby="priority-readiness-heading"
      data-testid="priority-readiness"
      data-complete={complete ? 'true' : 'false'}
      data-capped-by={cappedBy ?? 'null'}
    >
      <header className={styles.panelHead}>
        <h2 id="priority-readiness-heading" className={styles.panelTitle}>
          Readiness (server)
        </h2>
      </header>

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt>Board readiness %</dt>
          <dd
            data-testid="priority-board-readiness"
            className={isNaBoard ? styles.semanticNa : undefined}
          >
            {boardDisplay}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Raw task readiness %</dt>
          <dd
            data-testid="priority-raw-readiness"
            className={rawDisplay === 'N-A' ? styles.semanticNa : undefined}
          >
            {rawDisplay}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Complete</dt>
          <dd data-testid="priority-complete" className={completeClass}>
            <span className={styles.semanticIcon} aria-hidden="true">
              {complete ? '✓' : '✗'}
            </span>
            {formatBoolean(complete)}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>Capped by</dt>
          <dd data-testid="priority-capped-by" className={styles.mono}>
            {formatCappedBy(cappedBy)}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt>G5 pass (rollup)</dt>
          <dd
            data-testid="priority-readiness-g5-pass"
            className={g5Pass ? styles.semanticOk : styles.semanticFail}
          >
            <span className={styles.semanticIcon} aria-hidden="true">
              {g5Pass ? '✓' : '✗'}
            </span>
            {formatBoolean(g5Pass)}
          </dd>
        </div>
      </dl>

      {(taskReadinessPolicyVersion || boardReadinessPolicyVersion) && (
        <p className={styles.policyLine} data-testid="priority-readiness-policy">
          {taskReadinessPolicyVersion ? (
            <span>
              Task policy: <code>{taskReadinessPolicyVersion}</code>
            </span>
          ) : null}
          {boardReadinessPolicyVersion ? (
            <span>
              Board policy: <code>{boardReadinessPolicyVersion}</code>
            </span>
          ) : null}
        </p>
      )}
    </section>
  )
}
