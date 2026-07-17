/**
 * Direction B "Per domain" panel — presentation only.
 * Uses available project summaries (no invented domain readiness).
 * Missing fields render as em dash; never fabricates progress %.
 */
import {
  Card,
  ProgressBar,
  StatusChip,
  Table,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import styles from './overview.module.css'
import type { OverviewProjectSummary } from './types'
import { EmptySlot } from './SurfaceBanner'

function statusVariant(label: string | undefined): StatusChipVariant {
  if (!label) return 'pending'
  const s = label.toUpperCase()
  if (/PROD|READY|DONE|SELESAI|PASS|COMPLETE|ACTIVE/.test(s)) return 'done'
  if (/BLOCK|FAIL|HOLD|STOP/.test(s)) return 'blocked'
  if (/WARN|MAP|PENDING|WAIT/.test(s)) return 'warn'
  if (/ONGOING|RUN|PROGRESS|BUILD/.test(s)) return 'ongoing'
  return 'pending'
}

type DomainRow = OverviewProjectSummary & {
  /** Display-only progress when count is the only numeric signal available. */
  hasCount: boolean
}

export function DomainTable({
  projects,
}: {
  projects: OverviewProjectSummary[] | null | undefined
}) {
  const rows: DomainRow[] = (projects ?? []).map((p) => ({
    ...p,
    hasCount: typeof p.count === 'number' && Number.isFinite(p.count),
  }))

  const columns: Array<TableColumn<DomainRow>> = [
    {
      id: 'domain',
      header: 'Domain',
      cell: (row) => (
        <div className={styles.domainName}>
          <span className={styles.domainMark} aria-hidden="true" />
          <span className={styles.domainTitle}>{row.name}</span>
        </div>
      ),
    },
    {
      id: 'tasks',
      header: 'Tugas',
      align: 'right',
      mono: true,
      cell: (row) =>
        row.hasCount && typeof row.count === 'number' ? (
          <span data-field="count">{row.count}</span>
        ) : (
          <span className={styles.na}>—</span>
        ),
    },
    {
      id: 'proven',
      header: 'Terbukti',
      align: 'right',
      mono: true,
      cell: () => (
        // Not in OverviewProjectSummary wire — never invent.
        <span className={styles.na} title="Field terbukti tidak tersedia di ringkasan proyek">
          —
        </span>
      ),
    },
    {
      id: 'progress',
      header: 'Progress',
      cell: (row) =>
        row.hasCount && typeof row.count === 'number' && row.count > 0 ? (
          // Count alone is not readiness; show monochrome track as presence only
          // with neutral label — no fabricated completion ratio.
          <div className={styles.domainProgress}>
            <ProgressBar
              value={0}
              max={row.count}
              label={`${row.count} tugas`}
            />
          </div>
        ) : (
          <span className={styles.na}>—</span>
        ),
    },
    {
      id: 'status',
      header: 'Status',
      cell: (row) => {
        const label = row.statusLabel ?? row.bucketHint
        if (!label) return <span className={styles.na}>—</span>
        return (
          <StatusChip variant={statusVariant(label)} showDot>
            {label}
          </StatusChip>
        )
      },
    },
    {
      id: 'owner',
      header: 'Pemilik',
      cell: () => (
        // Owner not projected on OverviewProjectSummary — show available absence honestly.
        <span className={styles.panelMuted}>—</span>
      ),
    },
  ]

  return (
    <Card
      data-testid="overview-domain-table"
      aria-labelledby="ov-domain-title"
      title={<span id="ov-domain-title">Per domain</span>}
      subtitle={
        rows.length
          ? `Distribusi dari ${rows.length} proyek terlacak pada snapshot`
          : 'Proyek terlacak pada snapshot ini'
      }
      flush
    >
      {rows.length === 0 ? (
        <div className={styles.domainEmpty}>
          <EmptySlot>Tidak ada proyek/domain pada ringkasan ini.</EmptySlot>
        </div>
      ) : (
        <Table
          columns={columns}
          rows={rows}
          rowKey={(r) => r.projectId}
          caption="Per domain"
          aria-label="Tabel per domain"
        />
      )}
    </Card>
  )
}
