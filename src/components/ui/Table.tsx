import type { HTMLAttributes, ReactNode, ThHTMLAttributes } from 'react'
import { cx } from './cx'
import { Skeleton } from './Skeleton'
import styles from './Table.module.css'

export type SortDirection = 'asc' | 'desc' | false

export interface TableColumn<T> {
  id: string
  header: ReactNode
  /** Cell renderer. */
  cell: (row: T) => ReactNode
  sortable?: boolean
  mono?: boolean
  width?: string | number
  align?: 'left' | 'right' | 'center'
}

export interface TableProps<T> extends HTMLAttributes<HTMLDivElement> {
  columns: Array<TableColumn<T>>
  rows: T[]
  rowKey: (row: T) => string
  empty?: ReactNode
  loading?: boolean
  skeletonRows?: number
  sortColumnId?: string | null
  sortDirection?: SortDirection
  onSort?: (columnId: string) => void
  /** Accessible table caption. */
  caption?: string
  'aria-label'?: string
}

function SortMark({ dir }: { dir: SortDirection }) {
  if (dir === 'asc') return <span className={styles.sortIcon} aria-hidden>↑</span>
  if (dir === 'desc') return <span className={styles.sortIcon} aria-hidden>↓</span>
  return <span className={styles.sortIcon} aria-hidden>↕</span>
}

export function Table<T>({
  columns,
  rows,
  rowKey,
  empty = 'Tidak ada data.',
  loading = false,
  skeletonRows = 5,
  sortColumnId = null,
  sortDirection = false,
  onSort,
  caption,
  className,
  'aria-label': ariaLabel,
  ...rest
}: TableProps<T>) {
  return (
    <div
      className={cx(styles.wrap, className)}
      role="region"
      tabIndex={0}
      aria-label={ariaLabel ?? caption ?? 'Tabel'}
      {...rest}
    >
      <table className={styles.table}>
        {caption ? <caption className="sr-only">{caption}</caption> : null}
        <thead className={styles.thead}>
          <tr>
            {columns.map((col) => {
              const active = sortColumnId === col.id
              const dir = active ? sortDirection : false
              const thProps: ThHTMLAttributes<HTMLTableCellElement> = {
                scope: 'col',
                style: col.width
                  ? { width: typeof col.width === 'number' ? `${col.width}px` : col.width }
                  : undefined,
                'aria-sort':
                  col.sortable && active
                    ? dir === 'asc'
                      ? 'ascending'
                      : dir === 'desc'
                        ? 'descending'
                        : 'none'
                    : col.sortable
                      ? 'none'
                      : undefined,
              }
              return (
                <th key={col.id} {...thProps}>
                  {col.sortable && onSort ? (
                    <button
                      type="button"
                      className={styles.thBtn}
                      onClick={() => onSort(col.id)}
                    >
                      {col.header}
                      <SortMark dir={dir} />
                    </button>
                  ) : (
                    col.header
                  )}
                </th>
              )
            })}
          </tr>
        </thead>
        <tbody className={styles.tbody}>
          {loading
            ? Array.from({ length: skeletonRows }, (_, i) => (
                <tr key={`sk-${i}`}>
                  {columns.map((col) => (
                    <td key={col.id}>
                      <Skeleton height={14} width={col.mono ? '40%' : '70%'} />
                    </td>
                  ))}
                </tr>
              ))
            : null}
          {!loading && rows.length === 0 ? (
            <tr>
              <td className={styles.empty} colSpan={columns.length}>
                {empty}
              </td>
            </tr>
          ) : null}
          {!loading
            ? rows.map((row) => (
                <tr key={rowKey(row)}>
                  {columns.map((col) => (
                    <td
                      key={col.id}
                      className={cx(col.mono && styles.mono)}
                      style={
                        col.align && col.align !== 'left'
                          ? { textAlign: col.align }
                          : undefined
                      }
                    >
                      {col.cell(row)}
                    </td>
                  ))}
                </tr>
              ))
            : null}
        </tbody>
      </table>
    </div>
  )
}

/** Mono technical id cell helper. */
export function MonoCell({ children }: { children: ReactNode }) {
  return <span className={styles.mono}>{children}</span>
}
