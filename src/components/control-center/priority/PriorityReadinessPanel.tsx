import {
  Card,
  Disclosure,
  KpiStat,
  ProgressBar,
  StatusChip,
} from '#/components/ui'
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
  const cappedRaw = formatCappedBy(cappedBy)
  const boardValue =
    boardReadinessPercent == null || Number.isNaN(boardReadinessPercent)
      ? 0
      : boardReadinessPercent

  return (
    <Card
      aria-labelledby="priority-readiness-heading"
      data-testid="priority-readiness"
      data-complete={complete ? 'true' : 'false'}
      data-capped-by={cappedBy ?? 'null'}
      title={<span id="priority-readiness-heading">Kesiapan (dari server)</span>}
      headerActions={
        complete ? (
          <StatusChip variant="done">Selesai</StatusChip>
        ) : (
          <StatusChip variant="ongoing">Belum complete</StatusChip>
        )
      }
    >
      <div className={styles.stack}>
        <div className={styles.progressBlock}>
          <ProgressBar
            value={boardValue}
            max={100}
            ok={complete === true}
            label={
              isNaBoard
                ? 'N-A — kesiapan board tidak dihitung'
                : `Kesiapan board ${boardDisplay}%`
            }
          />
        </div>

        <div className={styles.kpiRow}>
          <KpiStat
            size="sm"
            label="Kesiapan board (%)"
            value={
              <span
                data-testid="priority-board-readiness"
                title="boardReadinessPercent"
                className={isNaBoard ? styles.semanticNa : undefined}
              >
                {boardDisplay}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Kesiapan tugas mentah (%)"
            value={
              <span
                data-testid="priority-raw-readiness"
                title="rawTaskReadinessPercent"
                className={rawDisplay === 'N-A' ? styles.semanticNa : undefined}
              >
                {rawDisplay}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Selesai (complete)"
            value={
              <span
                data-testid="priority-complete"
                className={complete ? styles.semanticOk : styles.semanticFail}
              >
                {humanBoolean(complete, 'Ya — board dinyatakan complete.', 'Belum complete.')}{' '}
                <code className={styles.mono} title="complete raw boolean">
                  {formatBoolean(complete)}
                </code>
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Dibatasi oleh"
            value={
              <span>
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
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="G5 lolos (rollup)"
            value={
              <span
                data-testid="priority-readiness-g5-pass"
                className={g5Pass ? styles.semanticOk : styles.semanticFail}
              >
                {humanBoolean(g5Pass, 'Sembilan domain G5 lolos.', 'G5 belum lolos.')}{' '}
                <code className={styles.mono}>{formatBoolean(g5Pass)}</code>
              </span>
            }
          />
        </div>

        {(taskReadinessPolicyVersion || boardReadinessPolicyVersion) && (
          <Disclosure
            summary="Detail teknis — versi kebijakan"
            data-testid="priority-readiness-policy"
          >
            <p className={styles.policyLine}>
              {taskReadinessPolicyVersion ? (
                <span>
                  Kebijakan tugas: <code className={styles.mono}>{taskReadinessPolicyVersion}</code>
                </span>
              ) : null}
              {boardReadinessPolicyVersion ? (
                <span>
                  Kebijakan board: <code className={styles.mono}>{boardReadinessPolicyVersion}</code>
                </span>
              ) : null}
            </p>
          </Disclosure>
        )}
      </div>
    </Card>
  )
}
