import { Button, Pagination } from '#/components/ui'
import type { WorkPageState } from './types'
import styles from './work.module.css'

export interface WorkPaginationProps {
  page: WorkPageState
  onNext?: () => void
  onPrev?: () => void
  disabled?: boolean
}

/**
 * Server cursor / page controls — UI never invents next page membership.
 * Kit Pagination for numbered display; cursor prev/next Buttons keep
 * hasMore/hasPrev semantics and stable testids.
 */
export function WorkPagination({
  page,
  onNext,
  onPrev,
  disabled = false,
}: WorkPaginationProps) {
  const canPrev = page.hasPrev === true && !!onPrev
  const canNext = page.hasMore && !!onNext
  const pageIndex =
    typeof page.pageIndex === 'number' && page.pageIndex > 0
      ? page.pageIndex
      : 1
  const pageSize = page.pageSize > 0 ? page.pageSize : 25

  /**
   * Cursor pages may report hasMore even when totalCount is a single-page
   * snapshot — inflate total so kit Pagination can show a next slot without
   * inventing membership (actual next still gated by canNext / onNext).
   */
  const totalForKit = (() => {
    if (typeof page.totalCount === 'number' && page.totalCount >= 0) {
      if (page.hasMore) {
        return Math.max(page.totalCount, pageIndex * pageSize + 1)
      }
      return page.totalCount
    }
    if (page.hasMore) return pageIndex * pageSize + 1
    return Math.max(pageIndex * pageSize, pageSize)
  })()

  const handlePageChange = (nextPage: number) => {
    if (disabled) return
    if (nextPage > pageIndex && canNext) onNext?.()
    else if (nextPage < pageIndex && canPrev) onPrev?.()
  }

  return (
    <nav
      className={styles.pagination}
      aria-label="Paginasi daftar pekerjaan"
      data-testid="work-pagination"
      data-cursor={page.cursor ?? ''}
      data-next-cursor={page.nextCursor ?? ''}
      data-page-size={page.pageSize}
    >
      <Pagination
        page={pageIndex}
        pageSize={pageSize}
        total={totalForKit}
        onPageChange={handlePageChange}
        labels={{
          prev: 'Sebelumnya',
          next: 'Berikutnya',
          perPage: 'per halaman',
          showing: (from, to, _total) =>
            typeof page.totalCount === 'number'
              ? `Menampilkan ${from}–${Math.min(to, page.totalCount)} dari ${page.totalCount}`
              : `Halaman ${pageIndex} · ${pageSize} per halaman`,
        }}
      />
      {/* Cursor-faithful controls with stable testids (kit Pagination is page-index). */}
      <div className={styles.pageActions}>
        <p className={styles.pageMeta}>
          {typeof page.pageIndex === 'number'
            ? `Halaman ${page.pageIndex}`
            : 'Halaman'}
          {typeof page.totalCount === 'number'
            ? ` · ${page.totalCount} pekerjaan`
            : ''}
          {page.cursor
            ? ` · posisi ${page.cursor.length > 12 ? `${page.cursor.slice(0, 10)}…` : page.cursor}`
            : ' · halaman pertama'}
        </p>
        <div className={styles.pageActions}>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || !canPrev}
            onClick={() => onPrev?.()}
            data-testid="work-page-prev"
          >
            Sebelumnya
          </Button>
          <Button
            type="button"
            variant="secondary"
            size="sm"
            disabled={disabled || !canNext}
            onClick={() => onNext?.()}
            data-testid="work-page-next"
          >
            Berikutnya
          </Button>
        </div>
      </div>
    </nav>
  )
}
