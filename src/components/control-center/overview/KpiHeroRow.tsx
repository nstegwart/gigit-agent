/**
 * Direction B KPI row — presentation only.
 * Maps existing Overview props (global / priority / lifecycle / g5 / buckets)
 * onto PageHeader-adjacent KpiStat + ProgressBar + StatusChip primitives.
 * Never invents denominators, stage gates, or domain readiness.
 */
import {
  Card,
  KpiStat,
  ProgressBar,
  StatusChip,
  type StatusChipVariant,
} from '#/components/ui'
import { formatLifecycleStageLabel, formatOperationalLabel } from '#/lib/display-label'
import styles from './overview.module.css'
import type {
  OverviewBucketStrip,
  OverviewG5Summary,
  OverviewGlobalCard,
  OverviewLifecycleSummary,
  OverviewPriorityCard,
} from './types'
import { GlobalCard } from './GlobalCard'
import { PriorityCard } from './PriorityCard'

function stageChipVariant(stage: string): StatusChipVariant {
  const s = stage.toUpperCase()
  if (s === 'PROD_READY' || s === 'LIVE_VERIFIED' || s === 'STAGING_PROVEN') return 'done'
  if (s === 'MAP_VERIFIED' || s === 'INTEGRATED' || s === 'FUNCTIONAL' || s === 'BUILT')
    return 'ongoing'
  if (s === 'MAPPING' || s === 'MAPPED') return 'warn'
  if (s.includes('BLOCK') || s.includes('HOLD')) return 'blocked'
  return 'pending'
}

function remainingUnproven(global: OverviewGlobalCard): number | null {
  const den = global.productDenominator
  const proven = global.prodReadyWithEvidence
  if (typeof den !== 'number' || typeof proven !== 'number') return null
  if (!Number.isFinite(den) || !Number.isFinite(proven) || den < 0 || proven < 0) return null
  return Math.max(0, den - proven)
}

function mapVerifiedGate(lifecycle: OverviewLifecycleSummary[] | null | undefined): {
  verified: number
  total: number
} | null {
  if (!lifecycle?.length) return null
  const total = lifecycle.reduce(
    (s, r) => s + (typeof r.count === 'number' && Number.isFinite(r.count) ? r.count : 0),
    0,
  )
  if (total <= 0) return null
  const mv = lifecycle.find((r) => r.stage === 'MAP_VERIFIED')
  const verified =
    typeof mv?.count === 'number' && Number.isFinite(mv.count) ? mv.count : 0
  return { verified, total }
}

function g5DomainCounts(g5: OverviewG5Summary | null | undefined): {
  pass: number
  total: number
} | null {
  if (!g5?.domains?.length) return null
  const total = g5.domains.length
  const pass = g5.domains.filter((d) => d.pass).length
  return { pass, total }
}

function BucketChips({ buckets }: { buckets: OverviewBucketStrip | null }) {
  if (!buckets) return null
  const chips: Array<{ key: string; label: string; variant: StatusChipVariant; n: number }> = [
    { key: 'DONE', label: 'Selesai', variant: 'done', n: buckets.counts.DONE },
    {
      key: 'ONGOING',
      label: 'Sedang dikerjakan',
      variant: 'ongoing',
      n: buckets.counts.ONGOING,
    },
    { key: 'NEXT', label: 'Berikutnya', variant: 'next', n: buckets.counts.NEXT },
    {
      key: 'QUEUED',
      label: 'Menunggu',
      variant: 'pending',
      n: buckets.counts.QUEUED,
    },
    {
      key: 'BLOCKED',
      label: 'Terhambat',
      variant: 'blocked',
      n: buckets.counts.BLOCKED,
    },
  ]
  const visible = chips.filter((c) => typeof c.n === 'number' && c.n > 0)
  if (!visible.length && buckets.staleCount <= 0) return null
  return (
    <div className={styles.kpiChipRow} data-testid="overview-kpi-bucket-chips">
      {visible.map((c) => (
        <StatusChip key={c.key} variant={c.variant} showDot>
          {c.label} {c.n}
        </StatusChip>
      ))}
      {buckets.staleCount > 0 ? (
        <StatusChip variant="warn" showDot>
          Basi {buckets.staleCount}
        </StatusChip>
      ) : null}
    </div>
  )
}

function LifecycleChips({
  lifecycle,
}: {
  lifecycle: OverviewLifecycleSummary[] | null | undefined
}) {
  if (!lifecycle?.length) return null
  const rows = lifecycle.filter(
    (r) => typeof r.count === 'number' && Number.isFinite(r.count) && r.count > 0,
  )
  if (!rows.length) return null
  return (
    <div className={styles.kpiChipRow} data-testid="overview-kpi-lifecycle-chips">
      {rows.map((r) => (
        <StatusChip
          key={r.stage}
          variant={stageChipVariant(r.stage)}
          showDot
          title={r.stage}
        >
          {formatLifecycleStageLabel(r.stage)} {r.count}
        </StatusChip>
      ))}
    </div>
  )
}

export function KpiHeroRow({
  global,
  priority,
  lifecycle,
  g5,
  buckets,
}: {
  global: OverviewGlobalCard | null
  priority: OverviewPriorityCard | null
  lifecycle: OverviewLifecycleSummary[] | null | undefined
  g5: OverviewG5Summary | null | undefined
  buckets: OverviewBucketStrip | null
}) {
  const remaining = global ? remainingUnproven(global) : null
  const stageGate = mapVerifiedGate(lifecycle)
  const g5Counts = g5DomainCounts(g5 ?? null)

  const heroValue = global ? (
    <>
      <span data-field="prodReadyWithEvidence">{global.prodReadyWithEvidence}</span>
      <span className={styles.kpiMuted}>/{global.productDenominator}</span>
      {global.boardReadinessPercent != null ? (
        <span className={styles.kpiPct}>
          ({global.boardReadinessPercent}%)
        </span>
      ) : null}
    </>
  ) : (
    <span className={styles.na}>—</span>
  )

  const heroHint =
    remaining != null
      ? `${remaining} item masih menunggu bukti PROD_READY ber-evidence`
      : global
        ? 'Angka dari evidence terbaru — bukan persentase statis program'
        : 'Data kesiapan global belum tersedia'

  return (
    <div className={styles.kpiHeroGrid} data-testid="overview-kpi-row">
      <Card
        className={styles.kpiHeroCard}
        data-testid="overview-kpi-proven"
        aria-labelledby="ov-kpi-proven-label"
      >
        <KpiStat
          label={<span id="ov-kpi-proven-label">Terbukti pindah</span>}
          value={heroValue}
          hint={heroHint}
        />
        {global ? (
          <div className={styles.kpiHeroBar}>
            <ProgressBar
              value={global.prodReadyWithEvidence}
              max={global.productDenominator || 0}
              ok={global.complete && global.g5Pass}
              label={`${global.prodReadyWithEvidence}/${global.productDenominator}`}
            />
          </div>
        ) : null}
        <LifecycleChips lifecycle={lifecycle} />
        <BucketChips buckets={buckets} />
      </Card>

      {stageGate ? (
        <Card data-testid="overview-kpi-stage1" aria-labelledby="ov-kpi-stage1-label">
          <KpiStat
            label={<span id="ov-kpi-stage1-label">Gate Stage 1</span>}
            value={
              <>
                {stageGate.verified}
                <span className={styles.kpiMuted}>/{stageGate.total}</span>
              </>
            }
            hint={
              stageGate.verified === stageGate.total && stageGate.total > 0
                ? 'MAP_VERIFIED pada rollup lifecycle tersedia'
                : 'MAP_VERIFIED dari histogram lifecycle (bukan kesiapan produksi)'
            }
          />
        </Card>
      ) : priority ? (
        <Card data-testid="overview-kpi-stage1" aria-labelledby="ov-kpi-stage1-label">
          <KpiStat
            label={<span id="ov-kpi-stage1-label">Portofolio prioritas</span>}
            value={
              <>
                {priority.prodReadyWithEvidence}
                <span className={styles.kpiMuted}>/{priority.productDenominator}</span>
              </>
            }
            hint={`${formatOperationalLabel(priority.portfolioId)} · evidence PROD_READY`}
          />
        </Card>
      ) : (
        <Card data-testid="overview-kpi-stage1">
          <KpiStat
            label="Gate Stage 1"
            value={<span className={styles.na}>—</span>}
            hint="Rollup lifecycle / prioritas belum tersedia"
          />
        </Card>
      )}

      {g5Counts ? (
        <Card data-testid="overview-kpi-g5" aria-labelledby="ov-kpi-g5-label">
          <KpiStat
            label={<span id="ov-kpi-g5-label">G5 domain</span>}
            value={
              <>
                {g5Counts.pass}
                <span className={styles.kpiMuted}>/{g5Counts.total}</span>
              </>
            }
            hint={
              g5?.g5Pass
                ? 'Semua domain G5 lulus pada snapshot ini'
                : `${g5Counts.total - g5Counts.pass} domain belum lulus`
            }
          />
        </Card>
      ) : (
        <Card data-testid="overview-kpi-g5">
          <KpiStat
            label="G5 domain"
            value={
              global ? (
                <span className={global.g5Pass ? styles.pass : styles.fail}>
                  {global.g5Pass ? 'PASS' : 'FAIL'}
                </span>
              ) : (
                <span className={styles.na}>—</span>
              )
            }
            hint="Checklist domain G5 belum tersedia; status global ditampilkan"
          />
        </Card>
      )}

      {/* Full priority + global cards retain ART testids and metric contracts */}
      <div className={styles.priorityGlobal} data-testid="overview-priority-global-pair">
        <PriorityCard data={priority} />
        <GlobalCard data={global} />
      </div>
    </div>
  )
}
