// All-features table — typed React port of the prototype `vFeatures(m)` view.
// Reproduces the prototype markup/classes exactly: `.filters`/`.fbtn` chips drive
// project + status filters, the global search box narrows by name/id/track/kelompok,
// and rows sort by progress (desc) via @tanstack/react-table, navigating to the
// feature detail on click.
import { useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { useBoardId } from '#/lib/board-query'
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type SortingState,
} from '@tanstack/react-table'
import { useStore } from '@tanstack/react-store'

import type { Feature, Model } from '#/lib/types'
import { uiStore } from '#/store/ui'
import { MiniAgent, ProgressBar, ProjectPill } from '#/components/primitives'

type PhaseFilter = '' | 'active' | 'blocked' | 'parked'

const columnHelper = createColumnHelper<Feature>()

export function FeaturesTable({ model: m }: { model: Model }) {
  const q = useStore(uiStore, (s) => s.search)
  const [filterProj, setFilterProj] = useState<string>('')
  const [filterPhase, setFilterPhase] = useState<PhaseFilter>('')
  const [sorting, setSorting] = useState<SortingState>([{ id: 'progress', desc: true }])
  const navigate = useNavigate()
  const boardId = useBoardId()

  const rows = useMemo(() => {
    const Q = q.toLowerCase()
    let out = m.features.slice()
    if (filterProj) out = out.filter((f) => f.projectId === filterProj)
    if (filterPhase === 'blocked') out = out.filter((f) => f.isBlocked)
    else if (filterPhase === 'parked') out = out.filter((f) => f.parked)
    else if (filterPhase === 'active')
      out = out.filter((f) => !f.parked && !f.isBlocked && f.fase !== 'backlog')
    if (Q)
      out = out.filter((f) =>
        `${f.nama} ${f.id} ${f.track} ${f.kelompok}`.toLowerCase().includes(Q),
      )
    return out
  }, [m.features, filterProj, filterPhase, q])

  const columns = useMemo(
    () => [
      columnHelper.display({
        id: 'phase',
        header: 'Phase',
        cell: ({ row }) => {
          const f = row.original
          return (
            <>
              <span className={`phase ${f.phaseCls}`}>{f.phaseLabel}</span>
              {f.isBlocked ? (
                <>
                  {' '}
                  <span
                    className="tag"
                    style={{ color: 'var(--blocked)', background: 'var(--blocked-bg)' }}
                  >
                    blocked
                  </span>
                </>
              ) : null}
              {f.parked ? (
                <>
                  {' '}
                  <span className="phase ph-parked">parked</span>
                </>
              ) : null}
            </>
          )
        },
      }),
      columnHelper.display({
        id: 'feature',
        header: 'Feature',
        cell: ({ row }) => (
          <>
            <div className="t-name">{row.original.nama}</div>
            <div className="t-id">{row.original.id}</div>
          </>
        ),
      }),
      columnHelper.display({
        id: 'project',
        header: 'Project',
        cell: ({ row }) => {
          const pr = row.original.projectId ? m.projById[row.original.projectId] : undefined
          return pr ? <ProjectPill project={pr} /> : <>—</>
        },
      }),
      columnHelper.display({
        id: 'agents',
        header: 'Agents',
        cell: ({ row }) => {
          const ag = row.original.runs.filter((r) => r.status === 'running')
          return (
            <div style={{ display: 'flex' }}>
              {ag.length ? (
                ag.map((r) => <MiniAgent key={r.id} run={r} />)
              ) : (
                <span style={{ color: 'var(--text-faint)' }}>—</span>
              )}
            </div>
          )
        },
      }),
      columnHelper.display({
        id: 'tasks',
        header: 'Tasks',
        cell: ({ row }) => (
          <span
            style={{ fontVariantNumeric: 'tabular-nums', color: 'var(--text-dim)' }}
          >
            {row.original.taskDone}/{row.original.taskTotal}
          </span>
        ),
      }),
      columnHelper.accessor((f) => f.pct ?? 0, {
        id: 'progress',
        header: 'Progress',
        cell: ({ row }) => <ProgressBar pct={row.original.pct ?? 0} />,
      }),
    ],
    [m.projById],
  )

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  })

  return (
    <section className="section">
      <div className="sec-head">
        <h2>All features</h2>
        <span className="count">{rows.length}</span>
      </div>
      <div className="filters">
        <button
          className={`fbtn ${filterProj === '' ? 'on' : ''}`}
          onClick={() => setFilterProj('')}
        >
          All projects
        </button>
        {m.projects.map((p) => (
          <button
            key={p.id}
            className={`fbtn ${filterProj === p.id ? 'on' : ''}`}
            onClick={() => setFilterProj(p.id)}
          >
            {p.nama}
          </button>
        ))}
        <span
          style={{ width: 1, height: 20, background: 'var(--border)', margin: '0 4px' }}
        />
        {(
          [
            ['', 'All'],
            ['active', 'Active'],
            ['blocked', 'Blocked'],
            ['parked', 'Parked'],
          ] as Array<[PhaseFilter, string]>
        ).map(([id, lbl]) => (
          <button
            key={id || 'all'}
            className={`fbtn ${filterPhase === id ? 'on' : ''}`}
            onClick={() => setFilterPhase(id)}
          >
            {lbl}
          </button>
        ))}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table className="ftable">
          <thead>
            {table.getHeaderGroups().map((hg) => (
              <tr key={hg.id}>
                {hg.headers.map((h) => (
                  <th
                    key={h.id}
                    style={h.column.id === 'progress' ? { width: 130 } : undefined}
                  >
                    {h.isPlaceholder
                      ? null
                      : flexRender(h.column.columnDef.header, h.getContext())}
                  </th>
                ))}
              </tr>
            ))}
          </thead>
          <tbody>
            {table.getRowModel().rows.map((row) => {
              const f = row.original
              return (
                <tr
                  key={f.id}
                  onClick={() =>
                    navigate({ to: '/b/$boardId/features/$featureId', params: { boardId, featureId: f.id } })
                  }
                >
                  {row.getVisibleCells().map((cell) => (
                    <td key={cell.id}>
                      {flexRender(cell.column.columnDef.cell, cell.getContext())}
                    </td>
                  ))}
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}
