import { NON_PRIORITY_REASON_ALLOWLIST } from './constants'
import { filterAllowlistedReasons, labelNonPriorityReason } from './display'
import type { NonPriorityReasonsProps } from './types'
import styles from './priority.module.css'

/**
 * Non-priority dispatch reasons — allowlist + proof only (UI_CONTRACT §8).
 * Unknown reasons are not rendered as justified non-priority work.
 */
export function NonPriorityReasonsPanel({ items }: NonPriorityReasonsProps) {
  const { allowed, rejected } = filterAllowlistedReasons(items)

  return (
    <section
      className={styles.panel}
      aria-labelledby="priority-non-priority-heading"
      data-testid="priority-non-priority-reasons"
    >
      <header className={styles.panelHead}>
        <h2 id="priority-non-priority-heading" className={styles.panelTitle}>
          Non-priority reasons
        </h2>
      </header>

      <p className={styles.muted} data-testid="priority-reason-allowlist">
        Allowlist:{' '}
        {NON_PRIORITY_REASON_ALLOWLIST.map((code) => (
          <code key={code} className={styles.allowCode}>
            {code}
          </code>
        ))}
      </p>

      {allowed.length === 0 ? (
        <p className={styles.emptyList} data-testid="priority-non-priority-empty">
          No allowlisted non-priority dispatches on this pin.
        </p>
      ) : (
        <ul className={styles.reasonList} data-testid="priority-non-priority-list">
          {allowed.map((item, idx) => (
            <li
              key={`${item.reason}-${item.taskId ?? idx}`}
              className={styles.reasonItem}
              data-testid="priority-non-priority-item"
              data-reason={item.reason}
            >
              <div className={styles.reasonHead}>
                <span className={styles.statusPill} data-testid="priority-reason-code">
                  {item.reason}
                </span>
                <span className={styles.reasonLabel}>{labelNonPriorityReason(item.reason)}</span>
              </div>
              {item.taskId ? (
                <p className={styles.reasonMeta}>
                  Task: <code data-testid="priority-reason-task">{item.taskId}</code>
                  {item.title ? <span> — {item.title}</span> : null}
                </p>
              ) : null}
              {item.proof ? (
                <p className={styles.reasonProof}>
                  Proof: <code data-testid="priority-reason-proof">{item.proof}</code>
                </p>
              ) : (
                <p className={styles.warnLine} data-testid="priority-reason-missing-proof">
                  Missing proof — allowlisted reason without server proof is incomplete.
                </p>
              )}
              {item.detail ? <p className={styles.reasonDetail}>{item.detail}</p> : null}
            </li>
          ))}
        </ul>
      )}

      {rejected.length > 0 ? (
        <div
          className={styles.rejectedBox}
          role="status"
          data-testid="priority-non-priority-rejected"
        >
          <p className={styles.warnLine}>
            {rejected.length} reason(s) outside allowlist were not shown as justified non-priority
            work.
          </p>
          <ul className={styles.idList}>
            {rejected.map((item, idx) => (
              <li key={`rej-${item.reason}-${idx}`}>
                <code>{item.reason}</code>
                {item.taskId ? (
                  <>
                    {' '}
                    (<code>{item.taskId}</code>)
                  </>
                ) : null}
              </li>
            ))}
          </ul>
        </div>
      ) : null}
    </section>
  )
}
