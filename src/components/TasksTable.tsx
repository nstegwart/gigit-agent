// Tasks table — same look as the Features table (.ftable). Columns:
// Task (title + id) · Group · Phase · Project · Progress · Checkpoints · Impact · Updated.
// Self-contained: project/scope filter chips + global search + sortable rows.
import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type Row,
  type SortingState,
} from '@tanstack/react-table'
import { useStore } from '@tanstack/react-store'

import { useBoardId } from '#/lib/board-query'
import { MiniAgent, ProgressBar } from '#/components/primitives'
import { fmtDate } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { nextStage, rowReadiness } from '#/lib/readiness'
import type { TaskView } from '#/lib/tasks'
import type { GroupReadiness, LifecycleConfig, Run } from '#/lib/types'
import { uiStore } from '#/store/ui'

const col = createColumnHelper<TaskView>()

/** Bucket tasks are grouped under: explicit group → feature contract → Other. */
const groupKeyOf = (t: TaskView) => t.group || t.featureContractId || 'Other'

export function TasksTable({
  tasks,
  runsByTask,
  readinessByGroup,
  milestone,
  cfg,
}: {
  tasks: Array<TaskView>
  runsByTask?: Record<string, Array<Run>>
  readinessByGroup?: Record<string, GroupReadiness>
  milestone?: string | null
  cfg?: LifecycleConfig
}) {
  const q = useStore(uiStore, (s) => s.search)
  const [filterProj, setFilterProj] = useState('')
  const [filterScope, setFilterScope] = useState('')
  const [filterStage, setFilterStage] = useState('')
  const [filterFC, setFilterFC] = useState('')
  const [filterGate, setFilterGate] = useState('')
  const [filterFlag, setFilterFlag] = useState('') // '' | blocked | stale | assigned | unassigned
  const [sorting, setSorting] = useState<SortingState>([{ id: 'readiness', desc: false }])
  const navigate = useNavigate()
  const boardId = useBoardId()
  const [openGroups, setOpenGroups] = useState<Set<string>>(new Set())
  const [touched, setTouched] = useState(false)

  const readyOf = (t: TaskView) => (cfg ? rowReadiness(cfg, t.lifecycleStage, t.done, t.total) : t.pct)
  const nextOf = (t: TaskView) => (cfg ? nextStage(cfg, t.lifecycleStage)?.key ?? null : null)
  const runOf = (t: TaskView) => (runsByTask?.[t.id] ?? [])[0] ?? null
  const assigned = (t: TaskView) => !!runsByTask?.[t.id]?.length

  const projects = useMemo(() => [...new Set(tasks.map((t) => t.projectId).filter(Boolean) as Array<string>)], [tasks])
  const scopes = useMemo(() => [...new Set(tasks.map((t) => t.scope).filter(Boolean) as Array<string>)], [tasks])
  const fcs = useMemo(() => [...new Set(tasks.map((t) => t.featureContractId).filter(Boolean) as Array<string>)].sort(), [tasks])
  const gates = useMemo(() => cfg?.stages.map((s) => s.key) ?? [], [cfg])

  const rows = useMemo(() => {
    const Q = q.toLowerCase()
    const staleBefore = Date.now() - 7 * 864e5
    let out = tasks.slice()
    if (filterProj) out = out.filter((t) => t.projectId === filterProj)
    if (filterScope) out = out.filter((t) => t.scope === filterScope)
    if (filterStage) out = out.filter((t) => (filterStage === '__uninit__' ? !t.lifecycleStage : t.lifecycleStage === filterStage))
    if (filterFC) out = out.filter((t) => t.featureContractId === filterFC)
    if (filterGate) out = out.filter((t) => nextOf(t) === filterGate)
    if (filterFlag === 'blocked') out = out.filter((t) => t.blockedReason)
    else if (filterFlag === 'stale') out = out.filter((t) => t.updated && Date.parse(t.updated) < staleBefore)
    else if (filterFlag === 'assigned') out = out.filter((t) => assigned(t))
    else if (filterFlag === 'unassigned') out = out.filter((t) => !assigned(t))
    if (Q)
      out = out.filter((t) =>
        `${t.title} ${t.id} ${t.projectId ?? ''} ${t.group ?? ''} ${t.lifecycleStage ?? ''} ${t.featureContractId ?? ''}`
          .toLowerCase()
          .includes(Q),
      )
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, filterProj, filterScope, filterStage, filterFC, filterGate, filterFlag, q, runsByTask, cfg])

  const columns = useMemo(
    () => [
      col.display({
        id: 'task',
        header: 'Task',
        cell: ({ row }) => (
          <div>
            <div className="t-name">{row.original.title}</div>
            <div className="t-id">{row.original.id}</div>
          </div>
        ),
      }),
      col.accessor((t) => t.lifecycleStage ?? '', {
        id: 'stage',
        header: 'Stage',
        cell: ({ row }) => {
          const s = row.original.lifecycleStage
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
              {s ? <span className="chip chip-mono">{s}</span> : <span className="t-id">uninit</span>}
              {row.original.blockedReason ? <span className="t-blocked" title={row.original.blockedReason}><Icon name="lock" size={9} /> blocked</span> : null}
            </div>
          )
        },
      }),
      col.display({
        id: 'nextgate',
        header: 'Next gate',
        cell: ({ row }) => {
          const ng = nextOf(row.original)
          return ng ? <span className="t-id" style={{ color: 'var(--accent)' }}>{ng}</span> : <span className="t-id">—</span>
        },
      }),
      col.accessor((t) => t.projectId ?? '', {
        id: 'project',
        header: 'Project',
        cell: ({ getValue }) => (getValue() ? <span className="chip chip-mono">{getValue()}</span> : <span className="t-id">—</span>),
      }),
      col.display({
        id: 'run',
        header: 'Run',
        cell: ({ row }) => {
          const r = runOf(row.original)
          return r ? <MiniAgent run={r} /> : <span className="t-id">—</span>
        },
      }),
      col.accessor((t) => readyOf(t), {
        id: 'readiness',
        header: 'Readiness',
        cell: ({ row }) => { const p = readyOf(row.original); return <ProgressBar pct={p} ok={p >= 100} right={`${p}%`} /> },
      }),
      col.display({
        id: 'impact',
        header: 'Impact',
        cell: ({ row }) => {
          const im = row.original.impacts
          if (!im.length) return <span className="t-id">—</span>
          return (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span className="chip" style={{ maxWidth: 130, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{im[0]}</span>
              {im.length > 1 ? <span className="chip">+{im.length - 1}</span> : null}
            </div>
          )
        },
      }),
      col.accessor((t) => t.lastReceiptAt ?? t.updated ?? '', {
        id: 'receipt',
        header: 'Last receipt',
        cell: ({ getValue }) => (
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
            {getValue() ? fmtDate(getValue()) : '—'}
          </span>
        ),
      }),
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runsByTask, cfg],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  // bucket the sorted/filtered rows into collapsible groups (insertion order)
  const modelRows = table.getRowModel().rows
  const groups: Array<[string, Array<Row<TaskView>>]> = []
  const gIndex = new Map<string, number>()
  for (const r of modelRows) {
    const k = groupKeyOf(r.original)
    let i = gIndex.get(k)
    if (i === undefined) { i = groups.length; gIndex.set(k, i); groups.push([k, []]) }
    groups[i][1].push(r)
  }
  const single = groups.length <= 1
  const searching = q.trim() !== ''
  const autoOpen = modelRows.length <= 25 // short lists open by default; long ones collapse
  const isOpen = (k: string) => single || searching || (touched ? openGroups.has(k) : autoOpen)
  const colCount = table.getVisibleFlatColumns().length
  const toggleGroup = (k: string) => {
    setTouched(true)
    setOpenGroups((prev) => { const n = new Set(prev); if (n.has(k)) n.delete(k); else n.add(k); return n })
  }
  const allExpanded = groups.every(([k]) => isOpen(k))
  const expandAll = () => { setTouched(true); setOpenGroups(new Set(groups.map(([k]) => k))) }
  const collapseAll = () => { setTouched(true); setOpenGroups(new Set()) }

  const renderRow = (row: Row<TaskView>) => {
    const t = row.original
    return (
      <tr key={t.id} onClick={() => navigate({ to: '/b/$boardId/tasks/$taskId', params: { boardId, taskId: t.id } })}>
        {row.getVisibleCells().map((cell) => (
          <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
        ))}
      </tr>
    )
  }

  const chip = (id: string, lbl: string, active: boolean, on: () => void) => (
    <button key={id || 'all'} className={`fbtn ${active ? 'on' : ''}`} onClick={on}>
      {lbl}
    </button>
  )

  return (
    <>
      <div className="filters">
        {chip('', 'All projects', filterProj === '', () => setFilterProj(''))}
        {projects.map((p) => chip(p, p, filterProj === p, () => setFilterProj(p)))}
        {scopes.length > 0 && (
          <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
        )}
        {scopes.length > 0 && chip('', 'All scopes', filterScope === '', () => setFilterScope(''))}
        {scopes.map((s) => chip(s, s, filterScope === s, () => setFilterScope(s)))}
        {cfg?.stages.length ? (
          <>
            <span style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }} />
            {chip('', 'All stages', filterStage === '', () => setFilterStage(''))}
            {cfg.stages.map((s) => chip(s.key, s.key, filterStage === s.key, () => setFilterStage(s.key)))}
          </>
        ) : null}
        {fcs.length ? (
          <select className="tf-select" value={filterFC} onChange={(e) => setFilterFC(e.target.value)}>
            <option value="">All FCs</option>
            {fcs.map((f) => <option key={f} value={f}>{f}</option>)}
          </select>
        ) : null}
        {gates.length ? (
          <select className="tf-select" value={filterGate} onChange={(e) => setFilterGate(e.target.value)}>
            <option value="">Any next gate</option>
            {gates.map((g) => <option key={g} value={g}>→ {g}</option>)}
          </select>
        ) : null}
        {(['blocked', 'stale', 'assigned', 'unassigned'] as const).map((f) => chip(f, f, filterFlag === f, () => setFilterFlag(filterFlag === f ? '' : f)))}
        {!single && !searching && (
          <button type="button" className="grp-toggle" onClick={allExpanded ? collapseAll : expandAll}>
            <Icon name="layers" size={13} />
            {allExpanded ? 'Collapse all' : 'Expand all'}
            <span className="grp-toggle-n">{groups.length}</span>
          </button>
        )}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="ftable">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} style={h.column.id === 'readiness' ? { width: 150 } : undefined}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          {single ? (
            <tbody>{modelRows.map(renderRow)}</tbody>
          ) : (
            groups.map(([key, grows]) => {
              const open = isOpen(key)
              const totalSum = grows.reduce((a, r) => a + r.original.total, 0)
              const doneSum = grows.reduce((a, r) => a + r.original.done, 0)
              const gr = readinessByGroup?.[key]
              const pct = gr ? gr.readinessPercent : Math.round(grows.reduce((a, r) => a + r.original.pct, 0) / grows.length)
              return (
                <tbody key={key} className="tgroup-body">
                  <tr className="tgroup" onClick={() => toggleGroup(key)}>
                    <td colSpan={colCount}>
                      <div className="tgroup-in">
                        <Icon name="chevL" size={14} className={`tgroup-caret ${open ? 'open' : ''}`} />
                        <span className="tgroup-name">{key}</span>
                        <span className="tgroup-count">{grows.length}</span>
                        {gr ? (
                          <span className="tgroup-tags">
                            <span className="tgroup-floor">floor {gr.floor ?? '—'}</span>
                            {milestone ? <span className="tgroup-mile">{gr.atMilestone}/{gr.total} {milestone}</span> : null}
                          </span>
                        ) : null}
                        <span className="tgroup-prog">
                          <ProgressBar pct={pct} right={gr ? `${pct}% · ${doneSum}/${totalSum}` : `${doneSum}/${totalSum}`} />
                        </span>
                      </div>
                    </td>
                  </tr>
                  {open ? grows.map(renderRow) : null}
                </tbody>
              )
            })
          )}
        </table>
      </div>
    </>
  )
}
