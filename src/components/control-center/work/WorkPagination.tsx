import type { WorkPageState } from './types'
import styles from './work.module.css'

export interface WorkPaginationProps {
  page: WorkPageState
  onNext?: () => void
  onPrev?: () => void
  disabled?: boolean
}

/** Server cursor / page controls — UI never invents next page membership. */
export function WorkPagination({
  page,
  onNext,
  onPrev,
  disabled = false,
}: WorkPaginationProps) {
  const canPrev = page.hasPrev === true && !!onPrev
  const canNext = page.hasMore && !!onNext
  const totalPart =
    typeof page.totalCount === 'number' ? ` · ${page.totalCount} pekerjaan` : ''
  const pagePart =
    typeof page.pageIndex === 'number' ? `Halaman ${page.pageIndex}` : 'Halaman'
  const cursorHint = page.cursor
    ? `posisi ${page.cursor.length > 12 ? `${page.cursor.slice(0, 10)}…` : page.cursor}`
    : 'halaman pertama'

  return (
    <nav
      className={styles.pagination}
      aria-label="Work list pagination"
      data-testid="work-pagination"
      data-cursor={page.cursor ?? ''}
      data-next-cursor={page.nextCursor ?? ''}
      data-page-size={page.pageSize}
    >
      <div className={styles.pageMeta}>
        <span>
          {pagePart}
          {totalPart}
        </span>
        <span aria-hidden="true"> · </span>
        <span>
          {page.pageSize} per halaman
          {' · '}
          {cursorHint}
        </span>
      </div>
      <div className={styles.pageActions}>
        <button
          type="button"
          className={styles.btn}
          disabled={disabled || !canPrev}
          onClick={() => onPrev?.()}
          data-testid="work-page-prev"
        >
          Sebelumnya
        </button>
        <button
          type="button"
          className={styles.btn}
          disabled={disabled || !canNext}
          onClick={() => onNext?.()}
          data-testid="work-page-next"
        >
          Berikutnya
        </button>
      </div>
    </nav>
  )
}
