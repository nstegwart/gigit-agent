// Projects list — Direction B (FAN-PROJECTS). Control-center boards use pinned
// projects envelope; legacy boards use board model. Presentation only via UI kit.
// FLOW_IA L1: /projects must stay on this surface for control-center boards
// (must NOT demote to /alur). UI_CONTRACT §2 screen #4.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useMemo, useState, type CSSProperties } from 'react'

import { boardQueryOptions, rollupQueryOptions, useBoard, useBoardId, useRollup } from '#/lib/board-query'
import {
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  projectsQueryOptions,
} from '#/lib/control-center-query'
import { projectsEnvelopeToProps } from '#/lib/control-center-secondary-route-adapters'
import type { ProjectRowView, ProjectsScreenProps } from '#/components/control-center/projects'
import {
  Badge,
  Button,
  Card,
  Disclosure,
  EmptyState,
  KpiStat,
  PageHeader,
  Pagination,
  Pill,
  ProgressBar,
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type TableColumn,
} from '#/components/ui'
import { uiStore } from '#/store/ui'
import type { GroupReadiness, Project } from '#/lib/types'

const PAGE_SIZE_DEFAULT = 25

export const Route = createFileRoute('/b/$boardId/projects/')({
  loader: async ({ context, params }) => {
    await context.queryClient.ensureQueryData(boardQueryOptions(params.boardId))
    if (isControlCenterBoard(params.boardId)) {
      await context.queryClient.ensureQueryData(
        projectsQueryOptions(params.boardId, getDefaultControlCenterFetchers().projects),
      )
    } else {
      await context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId))
    }
  },
  component: View,
})

function View() {
  const boardId = useBoardId()
  if (isControlCenterBoard(boardId)) {
    return <ControlCenterProjects />
  }
  return <LegacyProjects />
}

// ---------------------------------------------------------------------------
// Helpers (presentation)
// ---------------------------------------------------------------------------

function projectStatusVariant(status: string | null | undefined): StatusChipVariant {
  const s = (status ?? '').toLowerCase()
  if (!s) return 'pending'
  if (/(done|ready|ok|active|live|prod|selesai)/.test(s)) return 'done'
  if (/(block|fail|error|terhambat)/.test(s)) return 'blocked'
  if (/(warn|stale|partial|risk)/.test(s)) return 'warn'
  if (/(progress|build|run|ongoing|kerja)/.test(s)) return 'ongoing'
  if (/(internal|next)/.test(s)) return 'next'
  return 'pending'
}

function projectStatusLabel(status: string | null | undefined): string {
  const s = (status ?? '').toLowerCase()
  if (s === 'live') return 'Live'
  if (s === 'planned') return 'Direncanakan'
  if (s === 'internal') return 'Internal'
  if (!status) return '—'
  return status
}

function formatReadinessPercent(value: number | null | undefined): string {
  return value == null || !Number.isFinite(value) ? '—' : `${value}%`
}

function formatEvidenceOk(value: boolean | null | undefined): string {
  if (value === true) return 'lolos'
  if (value === false) return 'celah'
  return '—'
}

const stackStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 'var(--sp-4)',
}

const kpiRowStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'repeat(auto-fit, minmax(120px, 1fr))',
  gap: 'var(--sp-3)',
}

const titleCellStyle: CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
  minWidth: 0,
}

const primaryTitleStyle: CSSProperties = {
  color: 'var(--text)',
  fontWeight: 500,
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const monoIdStyle: CSSProperties = {
  fontFamily: 'var(--mono, ui-monospace, monospace)',
  fontSize: 'var(--type-caption-size, 12px)',
  color: 'var(--text-faint)',
  overflow: 'hidden',
  textOverflow: 'ellipsis',
  whiteSpace: 'nowrap',
}

const techDlStyle: CSSProperties = {
  display: 'grid',
  gridTemplateColumns: 'auto 1fr',
  gap: '4px 12px',
  margin: 0,
  fontSize: 'var(--type-caption-size, 12px)',
}

// ---------------------------------------------------------------------------
// Control-center projects (pinned envelope)
// ---------------------------------------------------------------------------

function ControlCenterProjects() {
  const boardId = useBoardId()
  const qc = useQueryClient()
  const fetchers = getDefaultControlCenterFetchers()
  const q = useQuery(projectsQueryOptions(boardId, fetchers.projects))

  const onRetry = useCallback(() => {
    void qc.invalidateQueries({ queryKey: ['control-center', 'projects', boardId] })
  }, [qc, boardId])

  const props = projectsEnvelopeToProps(q.data, {
    transport: q.isError ? 'offline' : 'online',
    onRetry,
    onRefresh: onRetry,
  })

  const surfaceState =
    q.isLoading && !q.data ? ('loading' as const) : props.surfaceState

  return (
    <div className="wrap" data-testid="control-center-projects-route" style={stackStyle}>
      <ProjectsIndexKit {...props} surfaceState={surfaceState} />
    </div>
  )
}

function ProjectsIndexKit({
  surfaceState,
  boardId,
  projects,
  productDenominator,
  bucketCounts,
  pin,
  error,
  projectionGaps,
  liveMessage,
  onRetry,
  onRefresh,
}: ProjectsScreenProps) {
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const hideList =
    surfaceState === 'loading' ||
    surfaceState === 'error' ||
    surfaceState === 'forbidden' ||
    surfaceState === 'disconnected'

  const statusOptions = useMemo(() => {
    const set = new Set<string>()
    for (const p of projects) {
      if (p.status) set.add(p.status)
    }
    return [...set].sort()
  }, [projects])

  const filtered = useMemo(() => {
    const Q = search.trim().toLowerCase()
    let out = projects
    if (statusFilter) out = out.filter((p) => p.status === statusFilter)
    if (Q) {
      out = out.filter(
        (p) =>
          p.name.toLowerCase().includes(Q) ||
          p.projectId.toLowerCase().includes(Q) ||
          (p.status ?? '').toLowerCase().includes(Q),
      )
    }
    return out
  }, [projects, search, statusFilter])

  useEffect(() => {
    setPage(1)
  }, [search, statusFilter, projects.length, pageSize])

  const total = filtered.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = filtered.slice((safePage - 1) * pageSize, safePage * pageSize)

  const totalTasks = projects.reduce((a, p) => a + (p.taskCount || 0), 0)
  const totalBlocked = projects.reduce((a, p) => a + (p.blockedCount || 0), 0)
  const readyCount = projects.filter(
    (p) => p.readinessPercent != null && p.readinessPercent >= 100,
  ).length

  const columns: Array<TableColumn<ProjectRowView>> = useMemo(
    () => [
      {
        id: 'name',
        header: 'Proyek',
        cell: (row) => (
          <div style={titleCellStyle} data-project-id={row.projectId}>
            <span style={primaryTitleStyle}>{row.name || row.projectId}</span>
            <span style={monoIdStyle} title={row.projectId}>
              {row.projectId}
            </span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: (row) => (
          <StatusChip variant={projectStatusVariant(row.status)} data-field="status">
            {projectStatusLabel(row.status)}
          </StatusChip>
        ),
      },
      {
        id: 'tasks',
        header: 'Tugas',
        align: 'right',
        mono: true,
        cell: (row) => <span>{row.taskCount}</span>,
      },
      {
        id: 'done',
        header: 'Selesai',
        align: 'right',
        mono: true,
        cell: (row) => <span>{row.doneCount}</span>,
      },
      {
        id: 'blocked',
        header: 'Terhambat',
        align: 'right',
        mono: true,
        cell: (row) => <span>{row.blockedCount}</span>,
      },
      {
        id: 'ready',
        header: 'Kesiapan',
        cell: (row) => {
          const pct = row.readinessPercent
          if (pct == null) return <span style={{ color: 'var(--text-faint)' }}>—</span>
          return (
            <ProgressBar
              value={pct}
              max={100}
              ok={pct >= 100}
              label={formatReadinessPercent(pct)}
              data-field="readiness-percent"
            />
          )
        },
      },
      {
        id: 'stage',
        header: 'Tahap',
        cell: (row) => (
          <span data-field="readiness-stage" style={{ color: 'var(--text-dim)' }}>
            {row.readinessStage ?? '—'}
          </span>
        ),
      },
      {
        id: 'evidence',
        header: 'Bukti',
        cell: (row) => (
          <Badge mono data-field="readiness-evidence-ok">
            {formatEvidenceOk(row.readinessEvidenceOk)}
          </Badge>
        ),
      },
      {
        id: 'open',
        header: 'Aksi',
        cell: (row) => (
          <a
            href={row.detailHref}
            data-testid="project-detail-link"
            style={{
              color: 'var(--accent)',
              fontSize: 'var(--type-small-size, 13px)',
              textDecoration: 'none',
              fontWeight: 500,
            }}
          >
            Buka
          </a>
        ),
      },
    ],
    [],
  )

  const projectionGapList = projectionGaps ?? []

  return (
    <section
      style={stackStyle}
      data-testid="control-center-projects"
      data-surface-state={surfaceState}
      data-board-id={boardId}
      data-project-count={projects.length}
      data-reflow-breakpoint="768"
      aria-labelledby="projects-page-title"
      data-canonical-snapshot-id={pin?.canonicalSnapshotId}
      data-canonical-hash={pin?.canonicalHash}
      data-board-rev={pin?.boardRev}
      data-lifecycle-rev={pin?.lifecycleRev}
    >
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        data-testid="projects-live"
        style={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
        }}
      >
        {liveMessage ?? ''}
      </div>

      <PageHeader
        id="projects-page-title"
        eyebrow="Struktur · Proyek"
        title="Proyek"
        subtitle="Ringkasan proyek dari envelope control-center yang di-pin. Kesiapan / tahap / bukti dari server — tidak dihitung ulang di browser."
        actions={
          onRefresh ? (
            <Button variant="secondary" size="sm" onClick={onRefresh}>
              Muat ulang
            </Button>
          ) : null
        }
      />

      <div style={kpiRowStyle}>
        <KpiStat
          size="sm"
          value={projects.length}
          label="Proyek"
          data-testid="projects-count"
        />
        {productDenominator != null ? (
          <KpiStat
            size="sm"
            value={productDenominator}
            label="Denom produk"
            data-testid="projects-product-denom"
          />
        ) : null}
        <KpiStat size="sm" value={totalTasks} label="Tugas" />
        <KpiStat size="sm" value={totalBlocked} label="Terhambat" />
        <KpiStat size="sm" value={readyCount} label="Siap 100%" />
      </div>

      {bucketCounts && Object.keys(bucketCounts).length > 0 ? (
        <div
          style={{ display: 'flex', flexWrap: 'wrap', gap: 'var(--sp-2)' }}
          data-testid="projects-bucket-strip"
          aria-label="Hitungan bucket"
        >
          {Object.entries(bucketCounts).map(([k, v]) => (
            <Badge key={k}>
              {k} · {v}
            </Badge>
          ))}
        </div>
      ) : null}

      {error ? (
        <Card
          title={`${error.code}: proyek tidak tersedia`}
          subtitle={error.message}
          data-testid="projects-error"
          role="alert"
          headerActions={
            onRetry ? (
              <Button variant="secondary" size="sm" onClick={onRetry}>
                Coba lagi
              </Button>
            ) : null
          }
        />
      ) : null}

      {surfaceState === 'stale' ? (
        <Card
          title="Pin basi"
          subtitle={pin?.staleReason ?? 'Agregasi pin basi — muat ulang untuk proyek terkini.'}
          data-testid="projects-stale"
          role="status"
          headerActions={
            onRefresh ? (
              <Button variant="secondary" size="sm" onClick={onRefresh}>
                Muat ulang
              </Button>
            ) : null
          }
        />
      ) : null}

      {surfaceState === 'loading' ? (
        <Card data-testid="projects-skeleton" aria-hidden="true">
          <Table
            columns={columns}
            rows={[]}
            rowKey={(r) => r.projectId}
            loading
            skeletonRows={5}
            aria-label="Memuat proyek"
          />
        </Card>
      ) : null}

      {surfaceState === 'empty' || surfaceState === 'zero-results' ? (
        <EmptyState
          title="Tidak ada proyek"
          description="Tidak ada proyek pada pin ini."
          data-testid="projects-empty"
        />
      ) : null}

      {!hideList && projects.length > 0 ? (
        <Card title="Daftar proyek" subtitle={`${total} cocok · ${projects.length} total`} flush>
          <div style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}>
            <Toolbar
              searchProps={{
                value: search,
                onChange: (e) => setSearch(e.target.value),
                placeholder: 'Cari nama atau id proyek…',
                'aria-label': 'Cari proyek',
              }}
              filters={
                <>
                  <Pill active={statusFilter === ''} onClick={() => setStatusFilter('')}>
                    Semua status
                  </Pill>
                  {statusOptions.map((s) => (
                    <Pill
                      key={s}
                      active={statusFilter === s}
                      onClick={() => setStatusFilter(statusFilter === s ? '' : s)}
                    >
                      {projectStatusLabel(s)}
                    </Pill>
                  ))}
                </>
              }
            />
          </div>
          <div data-testid="projects-table">
            <Table
              columns={columns}
              rows={pageRows}
              rowKey={(r) => r.projectId}
              empty="Tidak ada proyek yang cocok."
              aria-label="Tabel proyek"
            />
          </div>
          {total > 0 ? (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
              />
            </div>
          ) : null}
        </Card>
      ) : null}

      {pin ? (
        <Disclosure summary="Detail teknis" data-testid="projects-pin">
          <dl style={techDlStyle}>
            <dt>Snapshot</dt>
            <dd style={monoIdStyle}>{pin.canonicalSnapshotId}</dd>
            <dt>Hash</dt>
            <dd style={monoIdStyle}>{pin.canonicalHash}</dd>
            <dt>Board rev</dt>
            <dd style={monoIdStyle}>{pin.boardRev}</dd>
            <dt>Lifecycle rev</dt>
            <dd style={monoIdStyle}>{pin.lifecycleRev}</dd>
            <dt>Usia</dt>
            <dd style={monoIdStyle}>{pin.freshnessAgeSeconds}s</dd>
            {pin.stale ? (
              <>
                <dt>Stale</dt>
                <dd style={monoIdStyle}>{pin.staleReason ?? 'ya'}</dd>
              </>
            ) : null}
          </dl>
        </Disclosure>
      ) : null}

      {(surfaceState === 'partial' || projectionGapList.length > 0) &&
      projectionGapList.length > 0 ? (
        <Disclosure
          summary={`Celah proyeksi jujur (${projectionGapList.length})`}
          data-testid="projects-partial-banner"
        >
          <p style={{ margin: '0 0 8px', color: 'var(--text-dim)', fontSize: 13 }}>
            Beberapa kolom detail proyek tidak ada di envelope daftar publik. Slot kosong
            bukan kesiapan yang dibuat-buat.
          </p>
          <ul style={{ margin: 0, paddingLeft: 18, color: 'var(--text-dim)', fontSize: 13 }}>
            {projectionGapList.map((g) => (
              <li key={g}>{g}</li>
            ))}
          </ul>
        </Disclosure>
      ) : null}
    </section>
  )
}

// ---------------------------------------------------------------------------
// Legacy projects (board model + rollup)
// ---------------------------------------------------------------------------

type LegacyRow = {
  project: Project
  readiness?: GroupReadiness
}

function LegacyProjects() {
  const m = useBoard()
  const rollup = useRollup()
  const navigate = useNavigate()
  const boardId = useBoardId()
  const globalQ = useStore(uiStore, (s) => s.search)
  const [search, setSearch] = useState('')
  const [statusFilter, setStatusFilter] = useState('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)

  const combinedQ = (search || globalQ).toLowerCase()

  const rows: LegacyRow[] = useMemo(() => {
    let list = m.projects
    if (statusFilter) list = list.filter((p) => p.status === statusFilter)
    if (combinedQ) {
      list = list.filter((p) => `${p.nama} ${p.id}`.toLowerCase().includes(combinedQ))
    }
    return list.map((project) => ({
      project,
      readiness: rollup.byProject[project.id],
    }))
  }, [m.projects, rollup.byProject, combinedQ, statusFilter])

  useEffect(() => {
    setPage(1)
  }, [combinedQ, statusFilter, m.projects.length, pageSize])

  const statusOptions = useMemo(() => {
    const set = new Set(m.projects.map((p) => p.status).filter(Boolean))
    return [...set].sort()
  }, [m.projects])

  const total = rows.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = rows.slice((safePage - 1) * pageSize, safePage * pageSize)

  const columns: Array<TableColumn<LegacyRow>> = useMemo(
    () => [
      {
        id: 'name',
        header: 'Proyek',
        cell: ({ project: p }) => (
          <div style={titleCellStyle}>
            <span style={primaryTitleStyle}>{p.nama || p.id}</span>
            <span style={monoIdStyle}>{p.id}</span>
          </div>
        ),
      },
      {
        id: 'status',
        header: 'Status',
        cell: ({ project: p }) => (
          <StatusChip variant={projectStatusVariant(p.status)}>
            {projectStatusLabel(p.status)}
          </StatusChip>
        ),
      },
      {
        id: 'stage',
        header: 'Tahap',
        cell: ({ project: p, readiness }) => (
          <span style={{ color: 'var(--text-dim)' }}>
            {readiness?.floor ?? p.stage ?? p.status ?? '—'}
          </span>
        ),
      },
      {
        id: 'features',
        header: 'Fitur aktif',
        align: 'right',
        mono: true,
        cell: ({ project: p }) => <span>{p.features.filter((f) => !f.parked).length}</span>,
      },
      {
        id: 'blocked',
        header: 'Terhambat',
        align: 'right',
        mono: true,
        cell: ({ project: p, readiness }) => (
          <span>{readiness?.blocked ?? p.features.filter((f) => f.blocked).length}</span>
        ),
      },
      {
        id: 'ready',
        header: 'Kesiapan',
        cell: ({ project: p, readiness }) => {
          const pct = readiness ? readiness.readinessPercent : p.progress
          const n = typeof pct === 'number' && Number.isFinite(pct) ? pct : 0
          return (
            <ProgressBar
              value={n}
              max={100}
              ok={n >= 100}
              label={
                readiness
                  ? `${n}% · ${readiness.atMilestone}/${readiness.total}`
                  : `${n}%`
              }
            />
          )
        },
      },
      {
        id: 'open',
        header: 'Aksi',
        cell: ({ project: p }) => (
          <Button
            variant="ghost"
            size="sm"
            onClick={() =>
              void navigate({
                to: '/b/$boardId/projects/$projectId',
                params: { boardId, projectId: p.id },
              })
            }
          >
            Buka
          </Button>
        ),
      },
    ],
    [boardId, navigate],
  )

  return (
    <div className="wrap" style={stackStyle} data-testid="legacy-projects-route">
      <PageHeader
        eyebrow="Struktur · Proyek"
        title="Proyek"
        subtitle="Kesiapan = rollup tahap lifecycle (bukan fase warisan)."
      />

      <div style={kpiRowStyle}>
        <KpiStat size="sm" value={m.projects.length} label="Proyek" />
        <KpiStat size="sm" value={total} label="Tampil" />
      </div>

      {m.projects.length === 0 ? (
        <EmptyState
          title="Tidak ada proyek"
          description="Board ini belum memiliki proyek."
        />
      ) : (
        <Card title="Daftar proyek" subtitle={`${total} cocok`} flush>
          <div style={{ padding: 'var(--sp-3) var(--sp-4) 0' }}>
            <Toolbar
              searchProps={{
                value: search,
                onChange: (e) => setSearch(e.target.value),
                placeholder: 'Cari nama atau id proyek…',
                'aria-label': 'Cari proyek',
              }}
              filters={
                <>
                  <Pill active={statusFilter === ''} onClick={() => setStatusFilter('')}>
                    Semua status
                  </Pill>
                  {statusOptions.map((s) => (
                    <Pill
                      key={s}
                      active={statusFilter === s}
                      onClick={() => setStatusFilter(statusFilter === s ? '' : s)}
                    >
                      {projectStatusLabel(s)}
                    </Pill>
                  ))}
                </>
              }
            />
          </div>
          <Table
            columns={columns}
            rows={pageRows}
            rowKey={(r) => r.project.id}
            empty="Tidak ada proyek yang cocok."
            aria-label="Tabel proyek"
          />
          {total > 0 ? (
            <div style={{ padding: 'var(--sp-3) var(--sp-4)' }}>
              <Pagination
                page={safePage}
                pageSize={pageSize}
                total={total}
                onPageChange={setPage}
                onPageSizeChange={(n) => {
                  setPageSize(n)
                  setPage(1)
                }}
              />
            </div>
          ) : null}
        </Card>
      )}
    </div>
  )
}
