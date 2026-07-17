import type { HTMLAttributes } from 'react'
import { cx } from './cx'
import styles from './Pagination.module.css'

export interface PaginationProps extends HTMLAttributes<HTMLDivElement> {
  page: number
  pageSize: number
  total: number
  pageSizeOptions?: number[]
  onPageChange: (page: number) => void
  onPageSizeChange?: (size: number) => void
  /** Labels id-ID. */
  labels?: {
    prev?: string
    next?: string
    perPage?: string
    showing?: (from: number, to: number, total: number) => string
  }
}

export function Pagination({
  page,
  pageSize,
  total,
  pageSizeOptions = [10, 25, 50, 100],
  onPageChange,
  onPageSizeChange,
  labels,
  className,
  ...rest
}: PaginationProps) {
  const safeTotal = Math.max(0, total)
  const safeSize = Math.max(1, pageSize)
  const pageCount = Math.max(1, Math.ceil(safeTotal / safeSize))
  const safePage = Math.min(Math.max(1, page), pageCount)
  const from = safeTotal === 0 ? 0 : (safePage - 1) * safeSize + 1
  const to = Math.min(safePage * safeSize, safeTotal)

  const prev = labels?.prev ?? 'Sebelumnya'
  const next = labels?.next ?? 'Berikutnya'
  const perPage = labels?.perPage ?? 'per halaman'
  const showing =
    labels?.showing?.(from, to, safeTotal) ??
    `Menampilkan ${from}–${to} dari ${safeTotal}`

  return (
    <div className={cx(styles.root, className)} {...rest}>
      <div className={styles.meta}>{showing}</div>
      <div className={styles.controls}>
        {onPageSizeChange ? (
          <label>
            <span className="sr-only">{perPage}</span>
            <select
              className={styles.select}
              value={safeSize}
              aria-label={perPage}
              onChange={(e) => onPageSizeChange(Number(e.target.value))}
            >
              {pageSizeOptions.map((n) => (
                <option key={n} value={n}>
                  {n} {perPage}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        <button
          type="button"
          className={styles.navBtn}
          disabled={safePage <= 1}
          onClick={() => onPageChange(safePage - 1)}
        >
          {prev}
        </button>
        <button
          type="button"
          className={styles.navBtn}
          disabled={safePage >= pageCount}
          onClick={() => onPageChange(safePage + 1)}
        >
          {next}
        </button>
      </div>
    </div>
  )
}
