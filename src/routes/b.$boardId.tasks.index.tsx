// Tasks list (board-scoped) — Direction B: PageHeader + Toolbar + Table + Pagination.
// Data/logic from board-query + readiness helpers preserved; presentation only via UI kit.
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import { useEffect, useMemo, useState, type ReactNode } from 'react'

import { LifecycleEditor } from '#/components/LifecycleEditor'
import { RollupBar } from '#/components/RollupBar'
import {
  domainGroupKeyOf,
  resolveTaskDisplayTitle,
} from '#/components/TasksTable'
import {
  Badge,
  Button,
  Card,
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
import {
  boardQueryOptions,
  lifecycleQueryOptions,
  rollupQueryOptions,
  tasksQueryOptions,
  useBoard,
  useBoardId,
  useCanEdit,
  useLifecycle,
  useRollup,
  useTasks,
} from '#/lib/board-query'
import { formatDenseTimestamp, formatLifecycleStageLabel } from '#/lib/display-label'
import { nextStage, rowReadiness } from '#/lib/readiness'
import type { TaskView } from '#/lib/tasks'
import type { Run } from '#/lib/types'

import styles from './b.$boardId.tasks.index.module.css'

export const Route = createFileRoute('/b/$boardId/tasks/')({
  loader: async ({ context, params }) => {
    await Promise.all([
      context.queryClient.ensureQueryData(tasksQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(boardQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(rollupQueryOptions(params.boardId)),
      context.queryClient.ensureQueryData(lifecycleQueryOptions(params.boardId)),
    ])
  },
  component: View,
})

const PAGE_SIZE_DEFAULT = 25

type FlagFilter = '' | 'blocked' | 'stale' | 'assigned' | 'unassigned'
type SortDir = 'asc' | 'desc' | false

function stageVariant(stage: string | null | undefined, blocked?: string | null): StatusChipVariant {
  if (blocked) return 'blocked'
  if (!stage) return 'pending'
  const s = stage.toUpperCase()
  if (/PROD_READY|LIVE_VERIFIED|DONE|SELESAI|PASS/.test(s)) return 'done'
  if (/BLOCK|HOLD|STOP|FAIL/.test(s)) return 'blocked'
  if (/MAP|DRAFT|QUEUED|PENDING|INIT/.test(s)) return 'pending'
  if (/WARN|REVIEW|CONTENT/.test(s)) return 'warn'
  if (/NEXT|READY_FOR/.test(s)) return 'next'
  return 'ongoing'
}

function runOf(runs: Array<Run> | undefined): Run | null {
  return (runs ?? []).find((r) => r.status === 'running' || r.status === 'queued') ?? null
}

function View() {
  const { tasks } = useTasks()
  const m = useBoard()
  const rollup = useRollup()
  const cfg = useLifecycle()
  const canEdit = useCanEdit()
  const boardId = useBoardId()
  const navigate = useNavigate()
  const [editRail, setEditRail] = useState(false)

  const [search, setSearch] = useState('')
  const [filterProj, setFilterProj] = useState('')
  const [filterStage, setFilterStage] = useState('')
  const [filterFlag, setFilterFlag] = useState<FlagFilter>('')
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(PAGE_SIZE_DEFAULT)
  const [sortColumnId, setSortColumnId] = useState<string | null>('readiness')
  const [sortDirection, setSortDirection] = useState<SortDir>('asc')

  const projects = useMemo(
    () => [...new Set(tasks.map((t) => t.projectId).filter(Boolean) as Array<string>)].sort(),
    [tasks],
  )

  const readyOf = (t: TaskView) =>
    cfg ? rowReadiness(cfg, t.lifecycleStage, t.done, t.total) : t.pct
  const nextOf = (t: TaskView) => (cfg ? nextStage(cfg, t.lifecycleStage)?.key ?? null : null)
  const assigned = (t: TaskView) => !!runOf(m.runsByTask[t.id])

  const filtered = useMemo(() => {
    const Q = search.trim().toLowerCase()
    const staleBefore = filterFlag === 'stale' ? Date.now() - 7 * 864e5 : 0
    let out = tasks.slice()
    if (filterProj) out = out.filter((t) => t.projectId === filterProj)
    if (filterStage) {
      out = out.filter((t) =>
        filterStage === '__uninit__' ? !t.lifecycleStage : t.lifecycleStage === filterStage,
      )
    }
    if (filterFlag === 'blocked') out = out.filter((t) => !!t.blockedReason)
    else if (filterFlag === 'stale')
      out = out.filter((t) => t.updated && Date.parse(t.updated) < staleBefore)
    else if (filterFlag === 'assigned') out = out.filter((t) => assigned(t))
    else if (filterFlag === 'unassigned') out = out.filter((t) => !assigned(t))
    if (Q) {
      out = out.filter((t) => {
        const human = resolveTaskDisplayTitle(t)
        return `${human} ${t.title} ${t.id} ${t.projectId ?? ''} ${t.group ?? ''} ${t.lifecycleStage ?? ''} ${t.featureContractId ?? ''}`
          .toLowerCase()
          .includes(Q)
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, filterProj, filterStage, filterFlag, search, m.runsByTask, cfg])

  const sorted = useMemo(() => {
    const dir = sortDirection === 'desc' ? -1 : 1
    const col = sortColumnId
    const rows = filtered.slice()
    rows.sort((a, b) => {
      let cmp = 0
      if (col === 'title') {
        cmp = resolveTaskDisplayTitle(a).localeCompare(resolveTaskDisplayTitle(b), 'id')
      } else if (col === 'stage') {
        cmp = (a.lifecycleStage ?? '').localeCompare(b.lifecycleStage ?? '')
      } else if (col === 'project') {
        cmp = (a.projectId ?? '').localeCompare(b.projectId ?? '')
      } else if (col === 'readiness') {
        cmp = readyOf(a) - readyOf(b)
      } else if (col === 'updated') {
        cmp = (a.updated ?? '').localeCompare(b.updated ?? '')
      } else {
        cmp = a.id.localeCompare(b.id)
      }
      if (cmp === 0) cmp = a.id.localeCompare(b.id)
      return cmp * (col ? dir : 1)
    })
    return rows
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [filtered, sortColumnId, sortDirection, cfg])

  useEffect(() => {
    setPage(1)
  }, [filterProj, filterStage, filterFlag, search, pageSize, tasks.length])

  const total = sorted.length
  const pageCount = Math.max(1, Math.ceil(total / pageSize))
  const safePage = Math.min(page, pageCount)
  const pageRows = sorted.slice((safePage - 1) * pageSize, safePage * pageSize)

  const kpiReady = useMemo(
    () => tasks.filter((t) => readyOf(t) >= 100).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, cfg],
  )
  const kpiBlocked = useMemo(() => tasks.filter((t) => !!t.blockedReason).length, [tasks])
  const kpiAssigned = useMemo(
    () => tasks.filter((t) => assigned(t)).length,
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [tasks, m.runsByTask],
  )

  const onSort = (id: string) => {
    if (sortColumnId === id) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : d === 'desc' ? false : 'asc'))
      if (sortDirection === 'desc') setSortColumnId(null)
    } else {
      setSortColumnId(id)
      setSortDirection('asc')
    }
  }

  const columns: Array<TableColumn<TaskView>> = useMemo(
    () => [
      {
        id: 'title',
        header: 'Tugas',
        sortable: true,
        cell: (row) => {
          const human = resolveTaskDisplayTitle(row)
          const domain = domainGroupKeyOf(row)
          return (
            <button
              type="button"
              className={styles.rowLink}
              onClick={() =>
                navigate({
                  to: '/b/$boardId/tasks/$taskId',
                  params: { boardId, taskId: row.id },
                })
              }
            >
              <span className={styles.taskTitle}>{human}</span>
              <span className={styles.taskMeta}>
                <Badge mono variant="neutral">
                  {row.id}
                </Badge>
                {domain ? <span className={styles.domainHint}>{domain}</span> : null}
              </span>
            </button>
          )
        },
      },
      {
        id: 'stage',
        header: 'Tahap',
        sortable: true,
        cell: (row) => {
          const stage = row.lifecycleStage
          const label = stage ? formatLifecycleStageLabel(stage) || stage : 'Belum diinisialisasi'
          return (
            <div className={styles.stageCell}>
              <StatusChip variant={stageVariant(stage, row.blockedReason)} showDot>
                {label}
              </StatusChip>
              {row.blockedReason ? (
                <span className={styles.blockedHint} title={row.blockedReason}>
                  Terblokir
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'nextgate',
        header: 'Gerbang berikutnya',
        mono: true,
        cell: (row) => {
          const ng = nextOf(row)
          if (!ng) return <span className={styles.na}>—</span>
          return (
            <span className={styles.nextGate} title={ng}>
              {formatLifecycleStageLabel(ng) || ng}
            </span>
          )
        },
      },
      {
        id: 'project',
        header: 'Proyek',
        sortable: true,
        cell: (row) =>
          row.projectId ? (
            <Badge mono variant="neutral">
              {row.projectId}
            </Badge>
          ) : (
            <span className={styles.na}>—</span>
          ),
      },
      {
        id: 'readiness',
        header: 'Kesiapan',
        sortable: true,
        cell: (row) => {
          const p = readyOf(row)
          return (
            <ProgressBar
              value={p}
              max={100}
              ok={p >= 100}
              label={`${p}%`}
            />
          )
        },
      },
      {
        id: 'run',
        header: 'Run',
        cell: (row) => {
          const r = runOf(m.runsByTask[row.id])
          if (!r) return <span className={styles.na}>—</span>
          const variant: StatusChipVariant =
            r.status === 'running' ? 'ongoing' : r.status === 'queued' ? 'pending' : 'pending'
          return (
            <StatusChip variant={variant} showDot>
              {r.status === 'running' ? 'Berjalan' : r.status === 'queued' ? 'Antrian' : r.status}
            </StatusChip>
          )
        },
      },
      {
        id: 'updated',
        header: 'Diperbarui',
        sortable: true,
        mono: true,
        cell: (row) => {
          const iso = row.lastReceiptAt ?? row.updated
          return (
            <span className={styles.date} title={iso ?? undefined}>
              {iso ? formatDenseTimestamp(iso) : '—'}
            </span>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [boardId, navigate, m.runsByTask, cfg],
  )

  const filterPills: ReactNode = (
    <>
      <Pill active={filterProj === ''} onClick={() => setFilterProj('')}>
        Semua proyek
      </Pill>
      {projects.slice(0, 8).map((p) => (
        <Pill key={p} active={filterProj === p} onClick={() => setFilterProj(p)}>
          {p}
        </Pill>
      ))}
      {cfg?.stages?.length ? (
        <>
          <span className={styles.filterSep} aria-hidden="true" />
          <Pill active={filterStage === ''} onClick={() => setFilterStage('')}>
            Semua tahap
          </Pill>
          {cfg.stages.slice(0, 6).map((s) => (
            <Pill
              key={s.key}
              active={filterStage === s.key}
              onClick={() => setFilterStage(s.key)}
            >
              {formatLifecycleStageLabel(s.key) || s.key}
            </Pill>
          ))}
        </>
      ) : null}
      <span className={styles.filterSep} aria-hidden="true" />
      {(
        [
          ['blocked', 'Terblokir'],
          ['stale', 'Usang'],
          ['assigned', 'Ditugaskan'],
          ['unassigned', 'Belum ditugaskan'],
        ] as const
      ).map(([id, label]) => (
        <Pill
          key={id}
          active={filterFlag === id}
          onClick={() => setFilterFlag(filterFlag === id ? '' : id)}
        >
          {label}
        </Pill>
      ))}
    </>
  )

  return (
    <div className={styles.root} data-testid="control-center-tasks-list">
      <PageHeader
        eyebrow="Pekerjaan"
        title="Tugas"
        subtitle="Daftar tugas first-class — buka baris untuk peta checkpoint dan detail pemilik."
        actions={
          canEdit ? (
            <Button variant="secondary" size="sm" onClick={() => setEditRail(true)}>
              Edit rel lifecycle
            </Button>
          ) : null
        }
      />

      <div className={styles.kpiRow} data-testid="tasks-kpi-row">
        <KpiStat size="sm" value={tasks.length} label="Total tugas" />
        <KpiStat size="sm" value={kpiReady} label="Siap (100%)" hint={`${kpiReady}/${tasks.length}`} />
        <KpiStat size="sm" value={kpiBlocked} label="Terblokir" />
        <KpiStat size="sm" value={kpiAssigned} label="Run aktif" />
        {rollup.milestone ? (
          <KpiStat size="sm" value={rollup.milestone} label="Milestone" />
        ) : null}
      </div>

      {/* Existing rollup strip — data continuity; chrome remains external. */}
      <div className={styles.rollupSlot}>
        <RollupBar />
      </div>

      <Card
        flush
        title="Daftar tugas"
        subtitle={
          total === tasks.length
            ? `${total} tugas`
            : `${total} dari ${tasks.length} tugas (terfilter)`
        }
        data-testid="tasks-table-card"
      >
        <div className={styles.toolbarSlot}>
          <Toolbar
            searchProps={{
              value: search,
              onChange: (e) => setSearch(e.target.value),
              placeholder: 'Cari judul, id, proyek, tahap…',
              'aria-label': 'Cari tugas',
            }}
            filters={filterPills}
          />
        </div>

        {tasks.length === 0 ? (
          <EmptyState
            title="Belum ada tugas"
            description="Board ini belum memuat daftar tugas first-class."
          />
        ) : (
          <>
            <Table
              columns={columns}
              rows={pageRows}
              rowKey={(r) => r.id}
              loading={false}
              empty="Tidak ada tugas yang cocok dengan filter."
              sortColumnId={sortColumnId}
              sortDirection={sortDirection}
              onSort={onSort}
              caption="Daftar tugas"
              aria-label="Tabel tugas"
              data-testid="tasks-table"
            />
            <div className={styles.pagerSlot}>
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
          </>
        )}
      </Card>

      {editRail && canEdit ? <LifecycleEditor onClose={() => setEditRail(false)} /> : null}
    </div>
  )
}
