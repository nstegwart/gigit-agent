import {
  formatBoolean,
  formatCappedBy,
  formatReadinessPercent,
  humanBoolean,
  humanCappedBy,
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
  const cappedRaw = formatCappedBy(cappedBy)

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
          Kesiapan (dari server)
        </h2>
      </header>

      <dl className={styles.statGrid}>
        <div className={styles.stat}>
          <dt title="boardReadinessPercent">Kesiapan board (%)</dt>
          <dd
            data-testid="priority-board-readiness"
            className={isNaBoard ? styles.semanticNa : undefined}
          >
            {boardDisplay}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="rawTaskReadinessPercent">Kesiapan tugas mentah (%)</dt>
          <dd
            data-testid="priority-raw-readiness"
            className={rawDisplay === 'N-A' ? styles.semanticNa : undefined}
          >
            {rawDisplay}
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="complete">Selesai (complete)</dt>
          <dd data-testid="priority-complete" className={completeClass}>
            <span className={styles.semanticIcon} aria-hidden="true">
              {complete ? '✓' : '✗'}
            </span>
            {humanBoolean(complete, 'Ya — board dinyatakan complete.', 'Belum complete.')}{' '}
            <code className={styles.mono} title="complete raw boolean">
              {formatBoolean(complete)}
            </code>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="cappedBy">Dibatasi oleh</dt>
          <dd>
            <span>{humanCappedBy(cappedBy)}</span>
            <div>
              <code
                data-testid="priority-capped-by"
                className={styles.mono}
                title={cappedRaw}
              >
                {cappedRaw}
              </code>
            </div>
          </dd>
        </div>
        <div className={styles.stat}>
          <dt title="g5Pass">G5 lolos (rollup)</dt>
          <dd
            data-testid="priority-readiness-g5-pass"
            className={g5Pass ? styles.semanticOk : styles.semanticFail}
          >
            <span className={styles.semanticIcon} aria-hidden="true">
              {g5Pass ? '✓' : '✗'}
            </span>
            {humanBoolean(g5Pass, 'Sembilan domain G5 lolos.', 'G5 belum lolos.')}{' '}
            <code className={styles.mono}>{formatBoolean(g5Pass)}</code>
          </dd>
        </div>
      </dl>

      {(taskReadinessPolicyVersion || boardReadinessPolicyVersion) && (
        <details className={styles.details} data-testid="priority-readiness-policy">
          <summary className={styles.detailsSummary}>Detail teknis — versi kebijakan</summary>
          <p className={styles.policyLine}>
            {taskReadinessPolicyVersion ? (
              <span>
                Kebijakan tugas: <code>{taskReadinessPolicyVersion}</code>
              </span>
            ) : null}
            {boardReadinessPolicyVersion ? (
              <span>
                Kebijakan board: <code>{boardReadinessPolicyVersion}</code>
              </span>
            ) : null}
          </p>
        </details>
      )}
    </section>
  )
}
