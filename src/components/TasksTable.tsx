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
  type SortingState,
} from '@tanstack/react-table'
import { useStore } from '@tanstack/react-store'

import { useBoardId } from '#/lib/board-query'
import { MiniAgent, ProgressBar } from '#/components/primitives'
import { fmtDate } from '#/lib/format'
import type { TaskView } from '#/lib/tasks'
import type { Run } from '#/lib/types'
import { uiStore } from '#/store/ui'

const col = createColumnHelper<TaskView>()

export function TasksTable({
  tasks,
  runsByTask,
}: {
  tasks: Array<TaskView>
  runsByTask?: Record<string, Array<Run>>
}) {
  const q = useStore(uiStore, (s) => s.search)
  const [filterProj, setFilterProj] = useState('')
  const [filterScope, setFilterScope] = useState('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'progress', desc: true }])
  const navigate = useNavigate()
  const boardId = useBoardId()

  const projects = useMemo(
    () => [...new Set(tasks.map((t) => t.projectId).filter(Boolean) as Array<string>)],
    [tasks],
  )
  const scopes = useMemo(
    () => [...new Set(tasks.map((t) => t.scope).filter(Boolean) as Array<string>)],
    [tasks],
  )

  const rows = useMemo(() => {
    const Q = q.toLowerCase()
    let out = tasks.slice()
    if (filterProj) out = out.filter((t) => t.projectId === filterProj)
    if (filterScope) out = out.filter((t) => t.scope === filterScope)
    if (Q)
      out = out.filter((t) =>
        `${t.title} ${t.id} ${t.projectId ?? ''} ${t.group ?? ''} ${t.phase ?? ''}`
          .toLowerCase()
          .includes(Q),
      )
    return out
  }, [tasks, filterProj, filterScope, q])

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
      col.accessor((t) => t.group ?? '', {
        id: 'group',
        header: 'Group',
        cell: ({ getValue }) => (getValue() ? <span className="chip">{getValue()}</span> : <span className="t-id">—</span>),
      }),
      col.accessor((t) => t.phase ?? '', {
        id: 'phase',
        header: 'Phase',
        cell: ({ getValue }) => (getValue() ? <span className="task-phase">{getValue()}</span> : null),
      }),
      col.accessor((t) => t.projectId ?? '', {
        id: 'project',
        header: 'Project',
        cell: ({ getValue }) => (getValue() ? <span className="chip chip-mono">{getValue()}</span> : <span className="t-id">—</span>),
      }),
      ...(runsByTask
        ? [
            col.display({
              id: 'agents',
              header: 'Agents',
              cell: ({ row }) => {
                const rs = (runsByTask[row.original.id] ?? []).filter((r) => r.status === 'running')
                if (!rs.length) return <span className="t-id">—</span>
                return (
                  <div style={{ display: 'flex' }}>
                    {rs.map((r) => (
                      <MiniAgent key={r.id} run={r} />
                    ))}
                  </div>
                )
              },
            }),
          ]
        : []),
      col.accessor((t) => t.pct, {
        id: 'progress',
        header: 'Progress',
        cell: ({ row }) => <ProgressBar pct={row.original.pct} />,
      }),
      col.display({
        id: 'ceklis',
        header: 'Checkpoints',
        cell: ({ row }) => (
          <span style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-dim)' }}>
            {row.original.done}/{row.original.total}
          </span>
        ),
      }),
      col.display({
        id: 'impact',
        header: 'Impact',
        cell: ({ row }) => {
          const im = row.original.impacts
          if (!im.length) return <span className="t-id">—</span>
          return (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
              <span className="chip" style={{ maxWidth: 150, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                {im[0]}
              </span>
              {im.length > 1 ? <span className="chip">+{im.length - 1}</span> : null}
            </div>
          )
        },
      }),
      col.accessor((t) => t.updated ?? '', {
        id: 'updated',
        header: 'Updated',
        cell: ({ getValue }) => (
          <span style={{ fontSize: 11.5, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
            {getValue() ? fmtDate(getValue()) : '—'}
          </span>
        ),
      }),
    ],
    [runsByTask],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

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
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="ftable">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th key={h.id} style={h.column.id === 'progress' ? { width: 140 } : undefined}>
                    {h.isPlaceholder ? null : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const t = row.original
              return (
                <tr
                  key={t.id}
                  onClick={() =>
                    navigate({ to: '/b/$boardId/tasks/$taskId', params: { boardId, taskId: t.id } })
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>{flexRender(cell.column.columnDef.cell, cell.getContext())}</td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </>
  )
}
