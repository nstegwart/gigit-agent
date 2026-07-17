import { useMemo } from 'react'
import { Table, type TableColumn } from '#/components/ui'
import type { WorkItemRow } from './types'
import {
  WorkRow,
  workRowReadinessCell,
  workRowStageCell,
  workRowStatusCell,
  workRowTitleCell,
} from './WorkRow'
import styles from './work.module.css'

export interface WorkListProps {
  items: ReadonlyArray<WorkItemRow>
  panelId: string
  labelledBy: string
  onRowActivate?: (item: WorkItemRow) => void
  /**
   * When true, omit outer tabpanel role (parent WorkScreen already owns the panel
   * so aria-controls always resolves, including empty/terminal states).
   */
  asNested?: boolean
}

/**
 * Dual presentation: kit Table (desktop) + card list (≤768 via CSS module).
 * Both trees render so unit tests can assert reflow structure without layout engines.
 */
export function WorkList({
  items,
  panelId,
  labelledBy,
  onRowActivate,
  asNested = false,
}: WorkListProps) {
  const columns = useMemo<Array<TableColumn<WorkItemRow>>>(
    () => [
      {
        id: 'title',
        header: 'Hasil dan langkah berikutnya',
        cell: (row) => workRowTitleCell(row, onRowActivate),
      },
      {
        id: 'status',
        header: 'Status pekerjaan',
        cell: (row) => workRowStatusCell(row),
      },
      {
        id: 'stage',
        header: 'Tahap dan proyek',
        cell: (row) => workRowStageCell(row),
      },
      {
        id: 'readiness',
        header: 'Kesiapan',
        mono: true,
        cell: (row) => workRowReadinessCell(row),
      },
    ],
    [onRowActivate],
  )

  const rows = useMemo(() => [...items], [items])

  return (
    <div
      className={styles.listRegion}
      role={asNested ? undefined : 'tabpanel'}
      id={panelId}
      aria-labelledby={asNested ? undefined : labelledBy}
      data-testid="work-list"
      data-reflow-breakpoint="768"
    >
      <div className={styles.tableWrap} data-testid="work-table-wrap">
        <Table
          data-testid="work-table"
          columns={columns}
          rows={rows}
          rowKey={(r) => r.taskId}
          caption="Daftar pekerjaan"
          aria-label="Daftar item pekerjaan"
          empty="Tidak ada baris pada halaman ini."
        />
      </div>

      <div className={styles.cardList} data-testid="work-card-list">
        {items.map((item) => (
          <WorkRow
            key={`card-${item.taskId}`}
            item={item}
            asCard
            onActivate={onRowActivate}
          />
        ))}
      </div>
    </div>
  )
}
