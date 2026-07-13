import { NonPriorityReasonsPanel } from './NonPriorityReasonsPanel'
import { PriorityCapacityPanel } from './PriorityCapacityPanel'
import { PriorityDenominatorsPanel } from './PriorityDenominatorsPanel'
import { PriorityG5Panel } from './PriorityG5Panel'
import { PriorityMembershipPanel } from './PriorityMembershipPanel'
import { PriorityReadinessPanel } from './PriorityReadinessPanel'
import { PriorityStateShell } from './PriorityStateShell'
import type { PriorityScreenProps } from './types'
import styles from './priority.module.css'

/**
 * Prop-driven SALES_WEB_RELATED_BACKEND Priority screen.
 * Composes membership, DISTINCT rollups, readiness/cappedBy, G5, capacity/majority,
 * and non-priority allowlist panels. No fetch, no allocation/readiness recompute.
 */
export function PriorityScreen({
  uiState,
  pin,
  membership,
  denominators,
  readiness,
  g5,
  capacity,
  nonPriorityReasons,
  errorCode,
  errorMessage,
  onRetry,
  liveMessage,
}: PriorityScreenProps) {
  const showBody =
    uiState === 'populated' ||
    uiState === 'partial' ||
    uiState === 'stale' ||
    uiState === 'needs-human'

  return (
    <PriorityStateShell
      uiState={uiState}
      errorCode={errorCode}
      errorMessage={errorMessage}
      onRetry={onRetry}
      liveMessage={liveMessage}
      staleReason={pin?.staleReason}
      pin={
        pin
          ? {
              canonicalSnapshotId: pin.canonicalSnapshotId,
              canonicalHash: pin.canonicalHash,
              boardRev: pin.boardRev,
              lifecycleRev: pin.lifecycleRev,
            }
          : null
      }
    >
      {showBody ? (
        <div className={styles.body} data-testid="priority-body">
          <header className={styles.pageHead}>
            <div>
              <p className={styles.eyebrow}>Mission Q7</p>
              <h1 className={styles.pageTitle}>Priority portfolio</h1>
              <p className={styles.pageSub}>
                SALES_WEB_RELATED_BACKEND — server envelope only (no client recompute)
              </p>
            </div>
            {pin ? (
              <dl className={styles.pinStrip} data-testid="priority-pin">
                <div>
                  <dt>Board</dt>
                  <dd>
                    <code>{pin.boardId}</code>
                  </dd>
                </div>
                <div>
                  <dt>Snapshot</dt>
                  <dd>
                    <code title={pin.canonicalHash}>{pin.canonicalSnapshotId}</code>
                  </dd>
                </div>
                <div>
                  <dt>boardRev</dt>
                  <dd data-testid="priority-board-rev">{pin.boardRev}</dd>
                </div>
                <div>
                  <dt>lifecycleRev</dt>
                  <dd data-testid="priority-lifecycle-rev">{pin.lifecycleRev}</dd>
                </div>
                {pin.stale ? (
                  <div>
                    <dt>Stale</dt>
                    <dd className={styles.semanticWarn} data-testid="priority-pin-stale">
                      true
                      {pin.staleReason ? ` · ${pin.staleReason}` : ''}
                    </dd>
                  </div>
                ) : null}
              </dl>
            ) : null}
          </header>

          <div className={styles.grid}>
            {membership ? <PriorityMembershipPanel {...membership} /> : null}
            {denominators ? <PriorityDenominatorsPanel {...denominators} /> : null}
            {readiness ? <PriorityReadinessPanel {...readiness} /> : null}
            {capacity ? <PriorityCapacityPanel {...capacity} /> : null}
            {g5 ? <PriorityG5Panel {...g5} /> : null}
            {nonPriorityReasons ? (
              <NonPriorityReasonsPanel {...nonPriorityReasons} />
            ) : null}
          </div>
        </div>
      ) : null}
    </PriorityStateShell>
  )
}
