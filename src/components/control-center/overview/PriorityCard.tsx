import { formatOperationalLabel } from '#/lib/display-label'
import { Card, Disclosure, KpiStat, ProgressBar, StatusChip } from '#/components/ui'
import styles from './overview.module.css'
import type { OverviewPriorityCard } from './types'
import { SemanticIcon } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

function boolDisplay(
  v: boolean | null,
  naLabel: string,
): { text: string; cls: string } {
  if (v === null) return { text: naLabel, cls: styles.na }
  return v
    ? { text: 'PASS', cls: styles.pass }
    : { text: 'FAIL', cls: styles.fail }
}

export function PriorityCard({ data }: { data: OverviewPriorityCard | null }) {
  if (!data) {
    return (
      <Card
        data-testid="overview-priority"
        aria-labelledby="ov-priority-title"
        title={<span id="ov-priority-title">Prioritas + progres bukti</span>}
      >
        <EmptySlot>Portofolio prioritas tidak tersedia.</EmptySlot>
      </Card>
    )
  }

  const majority = boolDisplay(data.majorityAllocationPass, data.majorityDisplay)
  const g5 = boolDisplay(data.g5Pass, 'N-A')
  const complete = boolDisplay(data.complete, 'N-A')

  return (
    <Card
      data-testid="overview-priority"
      data-portfolio={data.portfolioId}
      aria-labelledby="ov-priority-title"
      title={
        <span
          id="ov-priority-title"
          className={styles.cardTitleInline}
          title={data.portfolioId}
          data-portfolio-raw={data.portfolioId}
        >
          <SemanticIcon kind="forward" />
          Prioritas + progres bukti · {formatOperationalLabel(data.portfolioId)}
        </span>
      }
      headerActions={
        data.complete ? (
          <StatusChip variant="done">Selesai</StatusChip>
        ) : (
          <StatusChip variant="ongoing">Berjalan</StatusChip>
        )
      }
    >
      <p className={styles.readinessNote} data-testid="overview-priority-readiness-note">
        Kesiapan portofolio prioritas dihitung dari evidence — bukan hitungan bucket
        pekerjaan di strip bawah.
      </p>
      <ProgressBar
        value={data.prodReadyWithEvidence}
        max={data.productDenominator || 1}
        ok={data.complete}
        label={`${data.prodReadyWithEvidence}/${data.productDenominator} PROD_READY`}
      />
      <div className={styles.kpiRow}>
        <KpiStat
          size="sm"
          value={
            <span data-field="membershipDenominator">{data.membershipDenominator}</span>
          }
          label="Anggota portofolio"
        />
        <KpiStat
          size="sm"
          value={<span data-field="productDenominator">{data.productDenominator}</span>}
          label="Denom produk"
        />
        <KpiStat
          size="sm"
          value={
            <span data-field="prodReadyWithEvidence">
              {data.prodReadyWithEvidence}
              <span className={styles.panelMuted}> / {data.stageProdReady}</span>
            </span>
          }
          label="PROD_READY ber-evidence"
        />
        <KpiStat
          size="sm"
          value={
            <span className={g5.cls} data-field="g5Pass">
              {data.g5Pass ? 'PASS' : 'FAIL'}
            </span>
          }
          label="G5 prioritas"
        />
        <KpiStat
          size="sm"
          value={
            <span className={complete.cls} data-field="complete">
              {data.complete ? 'Ya' : 'Tidak'}
            </span>
          }
          label="Portofolio selesai"
        />
        <KpiStat
          size="sm"
          value={<span className={styles.metricValueMono}>{data.capacityShareDisplay}</span>}
          label="Porsi kapasitas"
        />
        <KpiStat
          size="sm"
          value={<span className={majority.cls}>{majority.text}</span>}
          label="Alokasi mayoritas"
        />
        <KpiStat
          size="sm"
          value={
            <span
              className={styles.metricValueEnum}
              title={data.frontierState}
              data-frontier-raw={data.frontierState}
              data-testid="overview-priority-frontier"
            >
              {formatOperationalLabel(data.frontierState)}
            </span>
          }
          label="Frontier"
        />
      </div>
      {data.dispatchReason ? (
        <p
          className={styles.decisionQuestion}
          data-testid="priority-dispatch-reason"
          title={data.dispatchReason}
          data-reason-raw={data.dispatchReason}
        >
          <strong>Alasan dispatch:</strong> {formatOperationalLabel(data.dispatchReason)}
        </p>
      ) : null}
      {data.nonPriorityReason ? (
        <p
          className={styles.decisionQuestion}
          data-testid="priority-non-priority-reason"
          title={data.nonPriorityReason}
          data-reason-raw={data.nonPriorityReason}
        >
          <strong>Alasan non-prioritas:</strong>{' '}
          {formatOperationalLabel(data.nonPriorityReason)}
        </p>
      ) : null}
      {data.blockers?.length ? (
        <>
          <ul className={styles.blockers} aria-label="Hambatan prioritas">
            {data.blockers.map((b, i) => (
              <li key={`${i}:${b}`} className={styles.blockerItem}>
                <SemanticIcon kind="stop" />
                <span>{b}</span>
              </li>
            ))}
          </ul>
          {data.blockersDetail?.length ? (
            <Disclosure summary={`Detail teknis (${data.blockersDetail.length} kode)`}>
              <ul className={styles.blockers}>
                {data.blockersDetail.map((e) => (
                  <li key={`${e.code}:${e.message}`} className={styles.blockerItem}>
                    <span>
                      <strong>{e.code}</strong>: {e.message}
                    </span>
                  </li>
                ))}
              </ul>
            </Disclosure>
          ) : null}
        </>
      ) : null}
    </Card>
  )
}
