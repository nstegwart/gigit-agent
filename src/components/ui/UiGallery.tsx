/**
 * Static primitive gallery for art-director review / screenshots.
 * Direction B (Vercel/Geist-grade) — monochrome, 1px borders, near-zero shadow.
 * No data fetching. Not wired into production IA.
 */
import { useState } from 'react'
import {
  Badge,
  Breadcrumb,
  Button,
  Card,
  Disclosure,
  EmptyState,
  IconButton,
  KpiStat,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  SegmentedControl,
  Skeleton,
  StatusChip,
  Table,
  Tabs,
  Toolbar,
  Tooltip,
} from './index'
import styles from './UiGallery.module.css'

export function UiGallery() {
  const [seg, setSeg] = useState('a')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(25)
  const [pill, setPill] = useState('all')
  const [sortCol, setSortCol] = useState<string | null>('id')
  const [sortDir, setSortDir] = useState<'asc' | 'desc' | false>('asc')

  return (
    <div className={styles.root} data-testid="ui-gallery" data-direction="B">
      <PageHeader
        eyebrow="Design system · Direction B"
        title="Kit primitif Cairn"
        subtitle="Vercel/Geist-grade — monokrom tajam, border 1px, shadow nol, progress hitam, chip hemat."
        breadcrumb={
          <Breadcrumb
            items={[
              { label: 'Desain', href: '#' },
              { label: 'UI Kit' },
              { label: 'Direction B' },
            ]}
          />
        }
        actions={
          <>
            <Button variant="secondary" size="sm">
              Sekunder
            </Button>
            <Button size="sm">Utama</Button>
          </>
        }
      />

      <section className={styles.section}>
        <h2 className={styles.h2}>Button · IconButton · Badge · Tooltip</h2>
        <div className={styles.row}>
          <Button>Primary</Button>
          <Button variant="secondary">Secondary</Button>
          <Button variant="ghost">Ghost</Button>
          <Button variant="danger">Danger</Button>
          <Button size="sm">Sm 32</Button>
          <Button size="md">Md 36</Button>
          <IconButton aria-label="Cari">
            <svg
              width="16"
              height="16"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
          </IconButton>
          <IconButton aria-label="Lainnya" variant="ghost" size="sm">
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <circle cx="12" cy="5" r="1.5" fill="currentColor" />
              <circle cx="12" cy="12" r="1.5" fill="currentColor" />
              <circle cx="12" cy="19" r="1.5" fill="currentColor" />
            </svg>
          </IconButton>
          <Badge>Netral</Badge>
          <Badge variant="brand" mono>
            pin-abc
          </Badge>
          <Tooltip content="Tooltip monokrom">
            <Button variant="ghost" size="sm">
              Hover tip
            </Button>
          </Tooltip>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>StatusChip · Pill</h2>
        <div className={styles.row}>
          <StatusChip variant="done">Siap produksi</StatusChip>
          <StatusChip variant="ongoing">Pemetaan</StatusChip>
          <StatusChip variant="warn">Tinjauan</StatusChip>
          <StatusChip variant="blocked">Blokir</StatusChip>
          <StatusChip variant="pending">Tahan</StatusChip>
          <StatusChip variant="next">Berikutnya</StatusChip>
          <Pill active={pill === 'all'} onClick={() => setPill('all')}>
            Semua
          </Pill>
          <Pill active={pill === 'open'} onClick={() => setPill('open')}>
            Terbuka
          </Pill>
          <Pill active={pill === 'done'} onClick={() => setPill('done')}>
            Selesai
          </Pill>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>KpiStat · ProgressBar</h2>
        <div className={styles.kpiGrid}>
          <KpiStat value="2241/2501" label="Siap produksi" hint="89,6% portofolio" />
          <KpiStat value="316" label="Prioritas PROD_READY" size="sm" />
          <KpiStat value="9/9" label="Domain G5" />
        </div>
        <div className={styles.stack}>
          <ProgressBar value={316} max={316} ok label="316/316 (100%) · ok" />
          <ProgressBar value={42} max={100} label="42/100 (42%) · mono default" />
          <ProgressBar
            value={18}
            max={100}
            data-tone="warn"
            label="18/100 · warn"
          />
          <ProgressBar
            value={7}
            max={100}
            data-tone="blocked"
            label="7/100 · blocked"
          />
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Toolbar · SegmentedControl · Tabs</h2>
        <Toolbar
          searchProps={{ placeholder: 'Cari tugas…', defaultValue: '' }}
          searchIcon={
            <svg
              width="14"
              height="14"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
            >
              <circle cx="11" cy="11" r="7" />
              <path d="m20 20-3.2-3.2" />
            </svg>
          }
          filters={
            <>
              <Pill active={pill === 'all'} onClick={() => setPill('all')}>
                Semua
              </Pill>
              <Pill active={pill === 'open'} onClick={() => setPill('open')}>
                Terbuka
              </Pill>
            </>
          }
          actions={<Button size="sm">Ekspor</Button>}
        />
        <SegmentedControl
          aria-label="Mode tampilan"
          value={seg}
          onChange={setSeg}
          options={[
            { value: 'a', label: 'Ringkas' },
            { value: 'b', label: 'Detail' },
            { value: 'c', label: 'Peta' },
          ]}
        />
        <Tabs
          items={[
            {
              id: '1',
              label: 'Ringkasan',
              panel: <p className={styles.muted}>Panel ringkasan — underline monokrom aktif.</p>,
            },
            {
              id: '2',
              label: 'Bukti',
              panel: <p className={styles.muted}>Panel bukti.</p>,
            },
            {
              id: '3',
              label: 'Agen',
              panel: <p className={styles.muted}>Panel agen.</p>,
            },
          ]}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Card · Panel</h2>
        <div className={styles.cardGrid}>
          <Card title="Kartu prioritas" subtitle="Portofolio SALES_WEB_RELATED_BACKEND">
            <p className={styles.muted}>
              Border 1px · radius 8px · shadow none · padding 20–24px.
            </p>
          </Card>
          <Card
            title="Panel"
            variant="panel"
            footer={<Button size="sm">Aksi</Button>}
          >
            Footer opsional di bawah.
          </Card>
        </div>
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>Table · Pagination · MonoCell</h2>
        <Table
          aria-label="Contoh tabel"
          columns={[
            {
              id: 'id',
              header: 'ID',
              mono: true,
              sortable: true,
              cell: (r) => r.id,
            },
            {
              id: 'title',
              header: 'Judul',
              sortable: true,
              cell: (r) => r.title,
            },
            {
              id: 'owner',
              header: 'Pemilik',
              cell: (r) => r.owner,
            },
            {
              id: 'status',
              header: 'Status',
              cell: (r) => (
                <StatusChip variant={r.status}>{r.statusLabel}</StatusChip>
              ),
            },
          ]}
          rows={[
            {
              id: 'TASK-01',
              title: 'AppShell redesign',
              owner: 'Gian',
              status: 'done' as const,
              statusLabel: 'Siap produksi',
            },
            {
              id: 'TASK-02',
              title: 'Overview primitives',
              owner: 'Ayu',
              status: 'ongoing' as const,
              statusLabel: 'Pemetaan',
            },
            {
              id: 'TASK-03',
              title: 'Token AA pass',
              owner: 'Raka',
              status: 'warn' as const,
              statusLabel: 'Tinjauan',
            },
            {
              id: 'TASK-04',
              title: 'Sync backlog drain',
              owner: 'Nia',
              status: 'blocked' as const,
              statusLabel: 'Blokir',
            },
          ]}
          rowKey={(r) => r.id}
          sortColumnId={sortCol}
          sortDirection={sortDir}
          onSort={(id) => {
            if (sortCol === id) {
              setSortDir((d) => (d === 'asc' ? 'desc' : 'asc'))
            } else {
              setSortCol(id)
              setSortDir('asc')
            }
          }}
        />
        <Pagination
          page={page}
          pageSize={pageSize}
          total={120}
          onPageChange={setPage}
          onPageSizeChange={(n) => {
            setPageSize(n)
            setPage(1)
          }}
        />
      </section>

      <section className={styles.section}>
        <h2 className={styles.h2}>EmptyState · Skeleton · Disclosure · Breadcrumb</h2>
        <EmptyState
          icon={
            <svg
              width="18"
              height="18"
              viewBox="0 0 24 24"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              aria-hidden
            >
              <rect x="4" y="5" width="16" height="14" rx="2" />
              <path d="M8 9h8M8 13h5" />
            </svg>
          }
          title="Belum ada pekerjaan"
          description="Saat data hadir, daftar akan tampil di sini dengan tabel dan pagination."
          action={
            <Button size="sm" variant="secondary">
              Reset filter
            </Button>
          }
        />
        <div className={styles.skelRow}>
          <Skeleton height={16} width="40%" />
          <Skeleton height={16} width="70%" />
          <Skeleton height={16} width="55%" />
          <Skeleton circle height={28} />
        </div>
        <Disclosure summary="Detail teknis">
          <code className={styles.mono}>
            boardRev=12 · pin=abc123 · hash=deadbeef
          </code>
        </Disclosure>
        <Breadcrumb
          items={[
            { label: 'Pekerjaan', href: '#' },
            { label: 'TASK-02', href: '#' },
            { label: 'Overview primitives' },
          ]}
        />
      </section>
    </div>
  )
}
