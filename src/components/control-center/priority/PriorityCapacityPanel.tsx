import { formatOperationalLabel } from '#/lib/display-label'
import {
  Badge,
  Card,
  KpiStat,
  ProgressBar,
  StatusChip,
} from '#/components/ui'
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

function majorityChipVariant(
  cls: 'pass' | 'fail' | 'na',
): 'done' | 'blocked' | 'pending' {
  if (cls === 'pass') return 'done'
  if (cls === 'fail') return 'blocked'
  return 'pending'
}

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

  const sharePct =
    priorityCapacityShare == null || Number.isNaN(priorityCapacityShare)
      ? 0
      : Math.round(priorityCapacityShare * 100)

  return (
    <Card
      aria-labelledby="priority-capacity-heading"
      data-testid="priority-capacity"
      data-majority={majorityLabel}
      data-share={shareLabel}
      data-frontier={frontierState}
      data-zero-capacity={zeroCapacity ? 'true' : 'false'}
      title={
        <span id="priority-capacity-heading" className={styles.entityTitle}>
          <span className={styles.entityPrimary}>Kapasitas &amp; alokasi mayoritas</span>
          <span className={styles.entitySecondary} title={portfolioRaw}>
            {humanPortfolioLabel(portfolioRaw)}
          </span>
        </span>
      }
      headerActions={
        <>
          <Badge mono variant="neutral" title={humanPortfolioLabel(portfolioRaw)} data-portfolio-raw={portfolioRaw}>
            {portfolioRaw}
          </Badge>
          <StatusChip variant={majorityChipVariant(majorityClass)}>
            {majorityLabel}
          </StatusChip>
        </>
      }
    >
      <div className={styles.stack}>
        {(zeroCapacity || emptyFrontier || majorityAllocationPass === null) && (
          <p
            className={styles.warnLine}
            role="status"
            data-testid="priority-fail-closed-notice"
          >
            Fail-closed: kapasitas nol / frontier kosong / mayoritas null tidak pernah
            ditampilkan sebagai mayoritas PASS. Mayoritas yang ditampilkan:{' '}
            <strong>{majorityLabel}</strong>
            {majorityLabel === NA_TOKEN ? ' (N-A)' : ''}.
          </p>
        )}

        <div className={styles.progressBlock}>
          <ProgressBar
            value={sharePct}
            max={100}
            ok={majorityAllocationPass === true}
            label={
              shareLabel === NA_TOKEN
                ? 'Porsi kapasitas N-A'
                : `Porsi kapasitas ${shareLabel} (${sharePct}%)`
            }
          />
        </div>

        <div className={styles.kpiRow}>
          <KpiStat
            size="sm"
            label="Kapasitas penutupan prioritas"
            value={
              <span
                data-testid="priority-closure-capacity"
                title="priorityClosureCapacity"
              >
                {priorityClosureCapacity}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Kapasitas penutupan semua peran"
            value={
              <span
                data-testid="priority-all-closure-capacity"
                title="allClosureCapacity"
              >
                {allClosureCapacity}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Porsi kapasitas prioritas"
            value={
              <span
                data-testid="priority-capacity-share"
                title="priorityCapacityShare"
                className={shareLabel === NA_TOKEN ? styles.semanticNa : styles.mono}
              >
                {shareLabel}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Alokasi mayoritas"
            value={
              <span
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
                {humanMajorityAllocation(majorityAllocationPass)}{' '}
                <strong>{majorityLabel}</strong>
                <span className={styles.srOnly}>
                  raw boolean {formatBoolean(majorityAllocationPass)}
                </span>
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Status frontier prioritas"
            value={
              <span>
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
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Alasan kapasitas"
            value={
              <span>
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
              </span>
            }
          />
        </div>
      </div>
    </Card>
  )
}
