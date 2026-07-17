import {
  Card,
  Disclosure,
  KpiStat,
  ProgressBar,
  StatusChip,
} from '#/components/ui'
import type { PriorityRollupDenominatorsProps } from './types'
import styles from './priority.module.css'

/**
 * DISTINCT product/tracked denominators from server rollup.
 * Never averages or re-derives denominators client-side.
 * Labels are id-ID primary; technical field names stay on title / Detail teknis.
 */
export function PriorityDenominatorsPanel(
  props: PriorityRollupDenominatorsProps,
) {
  const {
    productDenominator,
    trackedWorkDenominator,
    stageProdReady,
    prodReadyWithEvidence,
    unclassifiedCount,
    productTaskIds,
    trackedTaskIds,
  } = props

  const emptyProduct = productDenominator === 0

  return (
    <Card
      aria-labelledby="priority-denominators-heading"
      data-testid="priority-denominators"
      data-empty-product={emptyProduct ? 'true' : 'false'}
      title={
        <span id="priority-denominators-heading">Penyebut terpisah (DISTINCT)</span>
      }
      headerActions={
        emptyProduct ? (
          <StatusChip variant="warn">Cakupan produk kosong</StatusChip>
        ) : (
          <StatusChip variant="ongoing">Aktif</StatusChip>
        )
      }
    >
      <div className={styles.stack}>
        {emptyProduct ? (
          <div
            className={styles.warnLine}
            role="status"
            data-testid="priority-empty-product-scope"
          >
            Belum ada tugas produk pada cakupan ini, jadi kesiapan belum dapat dihitung
            dan ditampilkan sebagai <strong>N/A</strong> — tidak pernah dibulatkan menjadi
            100% atau lolos dari cakupan kosong.
            {/* Native details: contract requires summary textContent exactly "Detail teknis". */}
            <details className={styles.details}>
              <summary className={styles.detailsSummary}>Detail teknis</summary>
              <code className={styles.mono}>
                productDenominator=0 — readiness must stay null / N-A; complete must stay
                false (never 100% / PASS from empty scope).
              </code>
            </details>
          </div>
        ) : null}

        <div className={styles.progressBlock}>
          <ProgressBar
            value={prodReadyWithEvidence}
            max={productDenominator || 0}
            ok={
              productDenominator > 0 &&
              prodReadyWithEvidence >= productDenominator &&
              productDenominator > 0
            }
            label={`${prodReadyWithEvidence}/${productDenominator} PROD_READY ber-evidence`}
          />
        </div>

        <div className={styles.kpiRow}>
          <KpiStat
            size="sm"
            label="Penyebut produk"
            value={
              <span data-testid="priority-product-denominator" title="productDenominator">
                {productDenominator}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Penyebut pekerjaan terlacak"
            value={
              <span
                data-testid="priority-tracked-denominator"
                title="trackedWorkDenominator"
              >
                {trackedWorkDenominator}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Tahap PROD_READY"
            value={
              <span data-testid="priority-stage-prod-ready" title="stageProdReady">
                {stageProdReady}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="PROD_READY dengan bukti"
            value={
              <span
                data-testid="priority-prod-ready-evidence"
                title="prodReadyWithEvidence"
              >
                {prodReadyWithEvidence}
              </span>
            }
          />
          <KpiStat
            size="sm"
            label="Jumlah belum terklasifikasi"
            value={
              <span data-testid="priority-unclassified-count" title="unclassifiedCount">
                {unclassifiedCount}
              </span>
            }
          />
        </div>

        {productTaskIds && productTaskIds.length > 0 ? (
          <Disclosure summary="Detail teknis — ID tugas produk (DISTINCT)">
            <ul className={styles.idList} data-testid="priority-product-task-ids">
              {productTaskIds.map((id) => (
                <li key={id} className={styles.idItem}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}

        {trackedTaskIds && trackedTaskIds.length > 0 ? (
          <Disclosure summary="Detail teknis — ID tugas terlacak (DISTINCT)">
            <ul className={styles.idList} data-testid="priority-tracked-task-ids">
              {trackedTaskIds.map((id) => (
                <li key={id} className={styles.idItem}>
                  <code>{id}</code>
                </li>
              ))}
            </ul>
          </Disclosure>
        ) : null}
      </div>
    </Card>
  )
}
