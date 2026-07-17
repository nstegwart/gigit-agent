import { useMemo, useState } from 'react'
import {
  Badge,
  Card,
  Disclosure,
  EmptyState,
  MonoCell,
  Pagination,
  Pill,
  StatusChip,
  Table,
  Toolbar,
  type TableColumn,
} from '#/components/ui'
import { NON_PRIORITY_REASON_ALLOWLIST } from './constants'
import { filterAllowlistedReasons, labelNonPriorityReason } from './display'
import type { NonPriorityReasonItem, NonPriorityReasonsProps } from './types'
import styles from './priority.module.css'

const PAGE_SIZE_DEFAULT = 25

type ReasonFilter = 'all' | 'with-proof' | 'missing-proof'

type ReasonRow = NonPriorityReasonItem & { key: string }

/**
 * Non-priority dispatch reasons — allowlist + proof only (UI_CONTRACT §8).
 * Unknown reasons are not rendered as justified non-priority work.
 */
export function NonPriorityReasonsPanel({ items }: NonPriorityReasonsProps) {
  const { allowed, rejected } = filterAllowlistedReasons(items)

  const [search, setSearch] = useState('')
  const [filter, setFilter] = useState<ReasonFilter>('all')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase()
    return allowed.filter((item) => {
      if (filter === 'with-proof' && !item.proof) return false
      if (filter === 'missing-proof' && item.proof) return false
      if (!q) return true
      const hay = [item.reason, item.taskId, item.title, item.proof, item.detail]
        .filter(Boolean)
        .join(' ')
        .toLowerCase()
      return hay.includes(q)
    })
  }, [allowed, filter, search])

  const pageCount = Math.max(1, Math.ceil(filtered.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageItems = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const rows: ReasonRow[] = pageItems.map((item, idx) => ({
    ...item,
    key: `${item.reason}-${item.taskId ?? idx}`,
  }))

  const columns: Array<TableColumn<ReasonRow>> = [
    {
      id: 'reason',
      header: 'Alasan',
      cell: (row) => (
        <div className={styles.entityTitle}>
          <span className={styles.entityPrimary}>{labelNonPriorityReason(row.reason)}</span>
          <span className={styles.entitySecondary} title={row.reason}>
            {row.reason}
          </span>
        </div>
      ),
    },
    {
      id: 'task',
      header: 'Tugas',
      mono: true,
      cell: (row) =>
        row.taskId ? (
          <span>
            <MonoCell>{row.taskId}</MonoCell>
            {row.title ? <span className={styles.muted}> — {row.title}</span> : null}
          </span>
        ) : (
          '—'
        ),
    },
    {
      id: 'proof',
      header: 'Bukti',
      mono: true,
      cell: (row) =>
        row.proof ? (
          <code data-testid="priority-reason-proof">{row.proof}</code>
        ) : (
          <span data-testid="priority-reason-missing-proof" className={styles.semanticWarn}>
            Bukti hilang
          </span>
        ),
    },
  ]

  return (
    <Card
      aria-labelledby="priority-non-priority-heading"
      data-testid="priority-non-priority-reasons"
      title={
        <span id="priority-non-priority-heading">Alasan di luar prioritas</span>
      }
      headerActions={
        <StatusChip variant={allowed.length > 0 ? 'warn' : 'pending'}>
          {allowed.length} allowlist
        </StatusChip>
      }
    >
      <div className={styles.stack}>
        <p className={styles.muted}>
          Hanya empat alasan allowlist yang boleh menjustifikasi pekerjaan di luar
          portofolio prioritas. Kode mentah ada di detail teknis.
        </p>

        <Disclosure summary="Detail teknis — allowlist kode" data-testid="priority-reason-allowlist">
          <p className={styles.policyLine}>
            {NON_PRIORITY_REASON_ALLOWLIST.map((code) => (
              <Badge key={code} mono variant="neutral" className={styles.allowCode}>
                {code}
              </Badge>
            ))}
          </p>
        </Disclosure>

        {allowed.length === 0 ? (
          <EmptyState
            data-testid="priority-non-priority-empty"
            title="Tidak ada penugasan di luar prioritas"
            description="Tidak ada penugasan di luar prioritas yang lolos allowlist pada pin ini."
          />
        ) : (
          <div className={styles.tableStack}>
            <Toolbar
              searchProps={{
                value: search,
                onChange: (e) => {
                  setSearch(e.target.value)
                  setPage(1)
                },
                placeholder: 'Cari alasan / tugas / bukti…',
                'aria-label': 'Cari alasan di luar prioritas',
              }}
              filters={
                <>
                  <Pill
                    active={filter === 'all'}
                    onClick={() => {
                      setFilter('all')
                      setPage(1)
                    }}
                  >
                    Semua
                  </Pill>
                  <Pill
                    active={filter === 'with-proof'}
                    onClick={() => {
                      setFilter('with-proof')
                      setPage(1)
                    }}
                  >
                    Ada bukti
                  </Pill>
                  <Pill
                    active={filter === 'missing-proof'}
                    onClick={() => {
                      setFilter('missing-proof')
                      setPage(1)
                    }}
                  >
                    Bukti hilang
                  </Pill>
                </>
              }
            />

            <Table
              columns={columns}
              rows={rows}
              rowKey={(r) => r.key}
              empty="Tidak ada baris yang cocok."
              caption="Alasan penugasan di luar portofolio prioritas"
              aria-label="Tabel alasan di luar prioritas"
            />

            <Pagination
              page={safePage}
              pageSize={pageSize}
              total={filtered.length}
              onPageChange={setPage}
              onPageSizeChange={(size) => {
                setPageSize(size)
                setPage(1)
              }}
            />

            {/* Contract list for unit tests + owner scan of human labels. */}
            <ul className={styles.reasonList} data-testid="priority-non-priority-list">
              {allowed.map((item, idx) => (
                <li
                  key={`${item.reason}-${item.taskId ?? idx}`}
                  className={styles.reasonItem}
                  data-testid="priority-non-priority-item"
                  data-reason={item.reason}
                >
                  <div className={styles.reasonHead}>
                    <span className={styles.reasonLabel}>
                      {labelNonPriorityReason(item.reason)}
                    </span>
                    <Badge
                      mono
                      variant="neutral"
                      data-testid="priority-reason-code"
                      title={item.reason}
                    >
                      {item.reason}
                    </Badge>
                  </div>
                  {item.taskId ? (
                    <p className={styles.reasonMeta}>
                      Tugas: <code data-testid="priority-reason-task">{item.taskId}</code>
                      {item.title ? <span> — {item.title}</span> : null}
                    </p>
                  ) : null}
                  {item.proof ? (
                    <p className={styles.reasonProof}>
                      Bukti: <code>{item.proof}</code>
                    </p>
                  ) : (
                    <p className={styles.warnLine}>
                      Bukti hilang — alasan allowlist tanpa bukti server belum lengkap.
                    </p>
                  )}
                  {item.detail ? <p className={styles.reasonDetail}>{item.detail}</p> : null}
                </li>
              ))}
            </ul>
          </div>
        )}

        {rejected.length > 0 ? (
          <div
            className={styles.rejectedBox}
            role="status"
            data-testid="priority-non-priority-rejected"
          >
            <p className={styles.muted}>
              {rejected.length} alasan di luar allowlist tidak ditampilkan sebagai pekerjaan
              non-prioritas yang sah (outside allowlist).
            </p>
            <Disclosure summary="Detail teknis — kode ditolak">
              <ul className={styles.idList}>
                {rejected.map((item, idx) => (
                  <li key={`rej-${item.reason}-${idx}`}>
                    <code className={styles.mono}>{item.reason}</code>
                    {item.taskId ? (
                      <>
                        {' '}
                        (<code className={styles.mono}>{item.taskId}</code>)
                      </>
                    ) : null}
                  </li>
                ))}
              </ul>
            </Disclosure>
          </div>
        ) : null}
      </div>
    </Card>
  )
}
