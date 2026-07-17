import { Card, KpiStat, ProgressBar, StatusChip } from '#/components/ui'
import styles from './overview.module.css'
import type { OverviewGlobalCard } from './types'
import { SemanticIcon } from './SemanticIcon'
import { EmptySlot } from './SurfaceBanner'

export function GlobalCard({ data }: { data: OverviewGlobalCard | null }) {
  if (!data) {
    return (
      <Card
        data-testid="overview-global"
        aria-labelledby="ov-global-title"
        title={<span id="ov-global-title">Kesiapan program (global)</span>}
      >
        <EmptySlot>Kesiapan global tidak tersedia.</EmptySlot>
      </Card>
    )
  }

  return (
    <Card
      data-testid="overview-global"
      aria-labelledby="ov-global-title"
      title={
        <span id="ov-global-title" className={styles.cardTitleInline}>
          <SemanticIcon kind="check" />
          Kesiapan program (global)
        </span>
      }
      headerActions={
        data.g5Pass ? (
          <StatusChip variant="done">G5 PASS</StatusChip>
        ) : (
          <StatusChip variant="blocked">G5 belum</StatusChip>
        )
      }
    >
      <p className={styles.readinessNote} data-testid="overview-global-readiness-note">
        Bucket pekerjaan ≠ kesiapan mapping/produk/program. Angka di bawah dari evidence
        terbaru, bukan persentase statis.
      </p>
      <ProgressBar
        value={data.prodReadyWithEvidence}
        max={data.productDenominator || 1}
        ok={data.complete && data.g5Pass}
        label={`${data.prodReadyWithEvidence}/${data.productDenominator}`}
      />
      <div className={styles.kpiRow}>
        <KpiStat
          size="sm"
          value={
            <span data-field="trackedWorkDenominator">{data.trackedWorkDenominator}</span>
          }
          label="Denom terlacak"
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
              <span className={styles.panelMuted}> / {data.stageProdReady} tahap</span>
            </span>
          }
          label="PROD_READY ber-evidence"
        />
        <KpiStat
          size="sm"
          value={
            <span
              className={data.g5Pass ? styles.pass : styles.fail}
              data-field="g5Pass"
            >
              {data.g5Pass ? 'PASS' : 'FAIL'}
            </span>
          }
          label="G5"
        />
        <KpiStat
          size="sm"
          value={
            <span
              className={data.complete ? styles.pass : styles.fail}
              data-field="complete"
            >
              {data.complete ? 'Ya' : 'Tidak'}
            </span>
          }
          label="Selesai"
        />
        <KpiStat
          size="sm"
          value={
            <span data-field="boardReadinessPercent">
              {data.boardReadinessPercent === null ? (
                <span className={styles.na}>N-A</span>
              ) : (
                `${data.boardReadinessPercent}%`
              )}
            </span>
          }
          label="Rasio board (evidence)"
        />
        {data.cappedBy ? (
          <KpiStat
            size="sm"
            value={
              <span className={styles.metricValueMono} title={data.cappedBy}>
                {data.cappedBy}
              </span>
            }
            label="Dibatasi oleh"
          />
        ) : null}
      </div>
    </Card>
  )
}
