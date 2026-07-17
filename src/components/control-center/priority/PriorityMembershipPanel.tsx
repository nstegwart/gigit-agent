import { useMemo, useState } from 'react'
import {
  Badge,
  Card,
  Disclosure,
  EmptyState,
  MonoCell,
  Pagination,
  StatusChip,
  Table,
  Toolbar,
  type TableColumn,
} from '#/components/ui'
import { PRIORITY_PORTFOLIO_ID } from './constants'
import { humanPortfolioLabel } from './display'
import type { PriorityMembershipProps } from './types'
import styles from './priority.module.css'

const PAGE_SIZE_DEFAULT = 25

type MemberRow = { id: string }

/**
 * Receipt-valid ACTIVE PRODUCT membership proof.
 * Displays server membership only — does not filter or reclassify tasks.
 */
export function PriorityMembershipPanel(props: PriorityMembershipProps) {
  const {
    portfolioId,
    membershipDenominator,
    membershipTaskIds,
    receiptValid,
    excludedInvalidReceiptCount,
    excludedNonProductCount,
  } = props

  const portfolioMismatch = portfolioId !== PRIORITY_PORTFOLIO_ID
  const human = humanPortfolioLabel(portfolioId)

  const [search, setSearch] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const filteredIds = useMemo(() => {
    const q = search.trim().toLowerCase()
    if (!q) return membershipTaskIds
    return membershipTaskIds.filter((id) => id.toLowerCase().includes(q))
  }, [membershipTaskIds, search])

  const pageCount = Math.max(1, Math.ceil(filteredIds.length / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageIds = filteredIds.slice((safePage - 1) * pageSize, safePage * pageSize)
  const rows: MemberRow[] = pageIds.map((id) => ({ id }))

  const columns: Array<TableColumn<MemberRow>> = [
    {
      id: 'id',
      header: 'ID tugas',
      mono: true,
      cell: (row) => <MonoCell>{row.id}</MonoCell>,
    },
  ]

  return (
    <Card
      aria-labelledby="priority-membership-heading"
      data-testid="priority-membership"
      data-receipt-valid={receiptValid ? 'true' : 'false'}
      title={
        <span id="priority-membership-heading" className={styles.entityTitle}>
          <span className={styles.entityPrimary}>Keanggotaan portofolio</span>
          <span className={styles.entitySecondary} title={portfolioId}>
            {human}
          </span>
        </span>
      }
      headerActions={
        <>
          <Badge
            mono
            variant="neutral"
            data-testid="priority-portfolio-id"
            title={human}
          >
            {portfolioId}
          </Badge>
          <StatusChip variant={receiptValid ? 'done' : 'blocked'}>
            {receiptValid ? 'Receipt valid' : 'Receipt invalid'}
          </StatusChip>
        </>
      }
    >
      <div className={styles.stack}>
        <p className={styles.muted} data-testid="priority-portfolio-human">
          {human}
        </p>

        {portfolioMismatch ? (
          <div className={styles.warnLine} role="alert" data-testid="priority-portfolio-mismatch">
            ID portofolio tidak diharapkan (seharusnya {PRIORITY_PORTFOLIO_ID}). Menampilkan
            nilai server apa adanya.
            <Disclosure summary="Detail teknis">
              <code className={styles.mono}>
                expected={PRIORITY_PORTFOLIO_ID}; got={portfolioId}
              </code>
            </Disclosure>
          </div>
        ) : null}

        <div className={styles.kpiRow}>
          <div data-testid="priority-membership-denominator-wrap">
            <span className={styles.srOnly}>Penyebut keanggotaan</span>
            <div>
              <div className={styles.muted}>Penyebut keanggotaan</div>
              <div
                data-testid="priority-membership-denominator"
                className={styles.entityPrimary}
                title="membershipDenominator"
              >
                {membershipDenominator}
              </div>
            </div>
          </div>
          <div>
            <div className={styles.muted}>Bukti receipt valid</div>
            <div
              data-testid="priority-membership-receipt-valid"
              className={receiptValid ? styles.semanticOk : styles.semanticFail}
            >
              {receiptValid ? 'Valid' : 'Invalid'}
            </div>
          </div>
          {excludedInvalidReceiptCount != null ? (
            <div>
              <div className={styles.muted}>Dikeluarkan (receipt tidak valid)</div>
              <div
                data-testid="priority-excluded-invalid-receipt"
                className={styles.entityPrimary}
              >
                {excludedInvalidReceiptCount}
              </div>
            </div>
          ) : null}
          {excludedNonProductCount != null ? (
            <div>
              <div className={styles.muted}>Dikeluarkan (bukan produk)</div>
              <div
                data-testid="priority-excluded-non-product"
                className={styles.entityPrimary}
              >
                {excludedNonProductCount}
              </div>
            </div>
          ) : null}
        </div>

        <div className={styles.listBlock}>
          <h3 className={styles.subTitle}>
            Anggota portofolio{' '}
            <span className={styles.muted}>(ACTIVE PRODUCT, receipt valid)</span>
          </h3>
          {membershipTaskIds.length === 0 ? (
            <EmptyState
              data-testid="priority-membership-empty"
              title="Keanggotaan kosong"
              description="Tidak ada tugas keanggotaan pada pin ini. Keanggotaan kosong never implies majority PASS."
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
                  placeholder: 'Cari ID tugas…',
                  'aria-label': 'Cari ID tugas keanggotaan',
                }}
              />
              <Table
                columns={columns}
                rows={rows}
                rowKey={(r) => r.id}
                empty="Tidak ada ID yang cocok dengan pencarian."
                caption="Daftar ID tugas keanggotaan portofolio"
                aria-label="Tabel ID tugas keanggotaan"
              />
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={filteredIds.length}
                onPageChange={setPage}
                onPageSizeChange={(size) => {
                  setPageSize(size)
                  setPage(1)
                }}
              />
              <Disclosure
                summary={`Detail teknis — ID tugas keanggotaan (${membershipTaskIds.length})`}
                open={membershipTaskIds.length <= 12}
              >
                <ul className={styles.idList} data-testid="priority-membership-ids">
                  {membershipTaskIds.map((id) => (
                    <li key={id} className={styles.idItem}>
                      <code>{id}</code>
                    </li>
                  ))}
                </ul>
              </Disclosure>
            </div>
          )}
        </div>
      </div>
    </Card>
  )
}
