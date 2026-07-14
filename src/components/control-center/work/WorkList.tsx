import type { WorkItemRow } from './types'
import { WorkRow } from './WorkRow'
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
 * Dual presentation: table (desktop) + card list (≤768 via CSS module).
 * Both trees render so unit tests can assert reflow structure without layout engines.
 */
export function WorkList({
  items,
  panelId,
  labelledBy,
  onRowActivate,
  asNested = false,
}: WorkListProps) {
  return (
    <div
      className={styles.listRegion}
      role={asNested ? undefined : 'tabpanel'}
      id={panelId}
      aria-labelledby={asNested ? undefined : labelledBy}
      data-testid="work-list"
      data-reflow-breakpoint="768"
    >
      <div
        className={styles.tableWrap}
        data-testid="work-table-wrap"
        role="region"
        aria-label="Work items table"
        tabIndex={0}
      >
        <table className={styles.table} data-testid="work-table">
          <thead>
            <tr>
              <th scope="col">Judul pekerjaan</th>
              <th scope="col">Bucket / overlay</th>
              <th scope="col">Tahap / proyek</th>
              <th scope="col">Kesiapan</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => (
              <WorkRow key={item.taskId} item={item} onActivate={onRowActivate} />
            ))}
          </tbody>
        </table>
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
