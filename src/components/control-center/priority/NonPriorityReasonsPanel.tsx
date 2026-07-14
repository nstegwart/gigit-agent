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
          Alasan di luar prioritas
        </h2>
      </header>

      <p className={styles.muted}>
        Hanya empat alasan allowlist yang boleh menjustifikasi pekerjaan di luar portofolio
        prioritas. Kode mentah ada di detail teknis.
      </p>

      <details className={styles.details} data-testid="priority-reason-allowlist">
        <summary className={styles.detailsSummary}>Detail teknis — allowlist kode</summary>
        <p className={styles.policyLine}>
          {NON_PRIORITY_REASON_ALLOWLIST.map((code) => (
            <code key={code} className={styles.allowCode}>
              {code}
            </code>
          ))}
        </p>
      </details>

      {allowed.length === 0 ? (
        <p className={styles.emptyList} data-testid="priority-non-priority-empty">
          Tidak ada penugasan di luar prioritas yang lolos allowlist pada pin ini.
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
                <span className={styles.reasonLabel}>{labelNonPriorityReason(item.reason)}</span>
                <span className={styles.statusPill} data-testid="priority-reason-code" title={item.reason}>
                  {item.reason}
                </span>
              </div>
              {item.taskId ? (
                <p className={styles.reasonMeta}>
                  Tugas: <code data-testid="priority-reason-task">{item.taskId}</code>
                  {item.title ? <span> — {item.title}</span> : null}
                </p>
              ) : null}
              {item.proof ? (
                <p className={styles.reasonProof}>
                  Bukti:{' '}
                  <code data-testid="priority-reason-proof">{item.proof}</code>
                </p>
              ) : (
                <p className={styles.warnLine} data-testid="priority-reason-missing-proof">
                  Bukti hilang — alasan allowlist tanpa bukti server belum lengkap.
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
            {rejected.length} alasan di luar allowlist tidak ditampilkan sebagai pekerjaan
            non-prioritas yang sah (outside allowlist).
          </p>
          <details className={styles.details}>
            <summary className={styles.detailsSummary}>Detail teknis — kode ditolak</summary>
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
          </details>
        </div>
      ) : null}
    </section>
  )
}
