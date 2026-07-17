// Tasks table — same look as the Features table (.ftable). Columns:
// Task (title + id) · Stage · Next gate · Project · Run · Readiness · Impact · Last receipt.
// Self-contained: project/scope filter chips + global search + sortable rows.
// W-FIX-PROJECTS: human titles, stage chip labels, domain/theme grouping, pageSize 20.
import { useEffect, useMemo, useState } from 'react'
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
import { formatLifecycleStageLabel } from '#/lib/display-label'
import { fmtDate } from '#/lib/format'
import { Icon } from '#/lib/icons'
import { nextStage, rowReadiness } from '#/lib/readiness'
import type { TaskView } from '#/lib/tasks'
import type { GroupReadiness, LifecycleConfig, Run } from '#/lib/types'
import { uiStore } from '#/store/ui'

const col = createColumnHelper<TaskView>()

/** Default rows per page on project/task lists (W-FIX-PROJECTS / V1.2 G-B). */
export const TASKS_TABLE_PAGE_SIZE = 20

/** Known domain tokens derived from featureContractId segments (presentation only). */
const DOMAIN_HINTS: Readonly<Record<string, string>> = {
  AUTH: 'Auth',
  PAY: 'Payment',
  PAYMENT: 'Payment',
  RC: 'Payment',
  IAP: 'Payment',
  PREMIUM: 'Payment',
  XENDIT: 'Payment',
  CLEENG: 'Payment',
  REVENUECAT: 'Payment',
  WELLNESS: 'Wellness',
  WELL: 'Wellness',
  MEDITATION: 'Wellness',
  FASTING: 'Wellness',
  PERIOD: 'Wellness',
  CONTENT: 'Content',
  MEAL: 'Content',
  RECIPE: 'Content',
  BOOKMARK: 'Content',
  CHALLENGE: 'Challenge',
  GAMIFY: 'Challenge',
  BADGE: 'Challenge',
  CORP: 'Corporate',
  AFF: 'Affiliate',
  AFFILIATE: 'Affiliate',
  REFERRAL: 'Affiliate',
  FIT: 'Fitness',
  JOURNEY: 'Fitness',
  WORKOUT: 'Fitness',
  SALES: 'Sales',
  PLATFORM: 'Platform',
  ADMIN: 'Platform',
  ONBOARD: 'Auth',
  LOGIN: 'Auth',
  REGISTER: 'Auth',
  SHELL: 'Shell',
  OFFLINE: 'Shell',
  NOTIF: 'Notifications',
  NOTIFICATION: 'Notifications',
  TEAM: 'Teams',
  TEAMS: 'Teams',
}

const PLATFORM_SKIP = new Set(['RN', 'BE', 'WEB', 'AFF', 'SALES', 'FIRM', 'API', 'CORE', 'MFS'])

function titleCaseToken(p: string): string {
  if (!p) return p
  if (/^\d+$/.test(p)) return p
  if (p.length <= 3 && p === p.toUpperCase()) return p
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
}

/** Strip bracket FC tags / T-* / FC-* tokens; light normalize for owner scan. */
export function cleanTaskTitle(raw: string): string {
  let s = raw.trim()
  if (!s) return s
  s = s.replace(/\[[^\]]*\]\s*/g, '')
  s = s.replace(/\b(?:T|FC|BE|WEB|RN|AFF|SALES)-[A-Z0-9._-]+\b/gi, '')
  s = s.replace(/[_/]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s) return raw.trim()
  return s.charAt(0).toUpperCase() + s.slice(1)
}

function isPlaceholderTitle(value: string | null | undefined): boolean {
  const t = (value ?? '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  if (lower === 'konten pemilik memerlukan peninjauan') return true
  if (lower === 'konten perlu ditinjau') return true
  if (lower === 'content_review_required') return true
  return false
}

/**
 * Owner-facing task title: humanTitle / ownerPrimary → cleaned title → id.
 * Never surfaces raw run-id or placeholder as sole primary.
 */
export function resolveTaskDisplayTitle(t: {
  id: string
  title: string
  humanTitle?: string | null
  ownerPrimaryTitle?: string | null
  humanDisplay?: { ownerPrimaryTitle?: string | null; title?: string | null } | null
}): string {
  const extras = t as {
    humanTitle?: string | null
    ownerPrimaryTitle?: string | null
    humanDisplay?: { ownerPrimaryTitle?: string | null; title?: string | null } | null
  }
  const candidates = [
    extras.humanTitle,
    extras.ownerPrimaryTitle,
    extras.humanDisplay?.ownerPrimaryTitle,
    extras.humanDisplay?.title,
  ]
  for (const c of candidates) {
    const v = (c ?? '').trim()
    if (v && !isPlaceholderTitle(v) && !/^T-[A-Z0-9._-]+$/i.test(v)) return v
  }
  const cleaned = cleanTaskTitle(t.title ?? '')
  if (cleaned && !isPlaceholderTitle(cleaned)) return cleaned
  if ((t.title ?? '').trim() && !isPlaceholderTitle(t.title)) return t.title.trim()
  return t.id
}

/** Readable label from raw FC-* id (never used as primary if domain map hits). */
export function formatFeatureContractLabel(fc: string): string {
  const parts = fc.replace(/^FC-/i, '').split(/[-_]/).filter(Boolean)
  const meaningful = parts.filter((p) => !PLATFORM_SKIP.has(p.toUpperCase()))
  const src = meaningful.length ? meaningful : parts
  return src.map(titleCaseToken).join(' ') || fc
}

/**
 * Group key for TasksTable: human domain/theme, not raw featureContractId.
 * Prefer explicit non-technical `group`, else domain hint from FC tokens,
 * else readable FC label, else "Lainnya".
 */
export function domainGroupKeyOf(t: {
  group?: string | null
  featureContractId?: string | null
}): string {
  const g = (t.group ?? '').trim()
  if (g && !/^(FC|T|FEAT)-/i.test(g)) return g

  const fc = (t.featureContractId ?? '').trim()
  if (!fc) return 'Lainnya'

  const parts = fc.replace(/^FC-/i, '').split(/[-_]/).filter(Boolean)
  const meaningful = parts.filter((p) => !PLATFORM_SKIP.has(p.toUpperCase()))

  // Collect domain hits; prefer the last (more specific) token — e.g. CORP+WELLNESS → Wellness
  const hits: Array<string> = []
  for (const p of meaningful) {
    const hit = DOMAIN_HINTS[p.toUpperCase()]
    if (hit) hits.push(hit)
  }
  if (hits.length) return hits[hits.length - 1]!

  // Fallback: readable 1–2 token theme from FC (not the full technical code)
  if (meaningful.length >= 1) {
    return meaningful.slice(0, 2).map(titleCaseToken).join(' · ')
  }
  return formatFeatureContractLabel(fc)
}

export function TasksTable({
  tasks,
  runsByTask,
  readinessByGroup,
  milestone,
  cfg,
  pageSize = TASKS_TABLE_PAGE_SIZE,
}: {
  tasks: Array<TaskView>
  runsByTask?: Record<string, Array<Run>>
  readinessByGroup?: Record<string, GroupReadiness>
  milestone?: string | null
  cfg?: LifecycleConfig
  /** Override page size (default 20). */
  pageSize?: number
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
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [touched, setTouched] = useState(false)
  const [page, setPage] = useState(0)

  const readyOf = (t: TaskView) => (cfg ? rowReadiness(cfg, t.lifecycleStage, t.done, t.total) : t.pct)
  const nextOf = (t: TaskView) => (cfg ? nextStage(cfg, t.lifecycleStage)?.key ?? null : null)
  // §4: "assigned" = a queued/running run only (a finished verifier is not an assignment)
  const runOf = (t: TaskView) => (runsByTask?.[t.id] ?? []).find((r) => r.status === 'running' || r.status === 'queued') ?? null
  const assigned = (t: TaskView) => !!runOf(t)

  const projects = useMemo(() => [...new Set(tasks.map((t) => t.projectId).filter(Boolean) as Array<string>)].sort(), [tasks])
  const scopes = useMemo(() => [...new Set(tasks.map((t) => t.scope).filter(Boolean) as Array<string>)].sort(), [tasks])
  const fcs = useMemo(() => [...new Set(tasks.map((t) => t.featureContractId).filter(Boolean) as Array<string>)].sort(), [tasks])
  const gates = useMemo(() => cfg?.stages.map((s) => s.key) ?? [], [cfg])

  const rows = useMemo(() => {
    const Q = q.toLowerCase()
    // Only compute wall-clock cutoff when the stale filter is active (avoids SSR/client clock drift on other paths)
    const staleBefore = filterFlag === 'stale' ? Date.now() - 7 * 864e5 : 0
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
      out = out.filter((t) => {
        const human = resolveTaskDisplayTitle(t)
        return `${human} ${t.title} ${t.id} ${t.projectId ?? ''} ${t.group ?? ''} ${t.lifecycleStage ?? ''} ${t.featureContractId ?? ''}`
          .toLowerCase()
          .includes(Q)
      })
    // Stable secondary order by id so server/client group insertion matches
    out.sort((a, b) => a.id.localeCompare(b.id))
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [tasks, filterProj, filterScope, filterStage, filterFC, filterGate, filterFlag, q, runsByTask, cfg])

  // Reset page when filter/search changes
  useEffect(() => {
    setPage(0)
  }, [filterProj, filterScope, filterStage, filterFC, filterGate, filterFlag, q, tasks.length])

  const columns = useMemo(
    () => [
      col.display({
        id: 'task',
        header: 'Task',
        cell: ({ row }) => {
          const human = resolveTaskDisplayTitle(row.original)
          return (
            <div>
              <div className="t-name">{human}</div>
              <div className="t-id" title={row.original.title !== human ? row.original.title : undefined}>
                {row.original.id}
              </div>
            </div>
          )
        },
      }),
      col.accessor((t) => t.lifecycleStage ?? '', {
        id: 'stage',
        header: 'Stage',
        cell: ({ row }) => {
          const s = row.original.lifecycleStage
          const label = s ? formatLifecycleStageLabel(s) || s : null
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 3, alignItems: 'flex-start' }}>
              {s ? (
                <span className="chip chip-mono" title={s} data-stage={s}>
                  {label}
                </span>
              ) : (
                <span className="t-id">uninit</span>
              )}
              {row.original.blockedReason ? (
                <span className="t-blocked" title={row.original.blockedReason}>
                  <Icon name="lock" size={9} /> blocked
                </span>
              ) : null}
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

  const modelRowsAll = table.getRowModel().rows
  const totalRows = modelRowsAll.length
  const size = Math.max(1, pageSize)
  const pageCount = Math.max(1, Math.ceil(totalRows / size))
  const safePage = Math.min(page, pageCount - 1)
  const modelRows = modelRowsAll.slice(safePage * size, safePage * size + size)

  // bucket the current page into collapsible domain/theme groups (insertion order)
  const groups: Array<[string, Array<Row<TaskView>>]> = []
  const gIndex = new Map<string, number>()
  for (const r of modelRows) {
    const k = domainGroupKeyOf(r.original)
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
            {cfg.stages.map((s) => chip(s.key, formatLifecycleStageLabel(s.key) || s.key, filterStage === s.key, () => setFilterStage(s.key)))}
          </>
        ) : null}
        {fcs.length ? (
          <select
            className="tf-select"
            value={filterFC}
            onChange={(e) => setFilterFC(e.target.value)}
            aria-label="Filter by feature capability"
          >
            <option value="">All FCs</option>
            {fcs.map((f) => (
              <option key={f} value={f} title={f}>
                {formatFeatureContractLabel(f)}
              </option>
            ))}
          </select>
        ) : null}
        {gates.length ? (
          <select
            className="tf-select"
            value={filterGate}
            onChange={(e) => setFilterGate(e.target.value)}
            aria-label="Filter by next gate"
          >
            <option value="">Any next gate</option>
            {gates.map((g) => <option key={g} value={g}>→ {formatLifecycleStageLabel(g) || g}</option>)}
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
      <div
        className="table-scroll"
        role="region"
        aria-label="Tasks table"
        tabIndex={0}
      >
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
              // Readiness-by-group was keyed by raw FC; try domain key then any FC in group
              const gr =
                readinessByGroup?.[key] ??
                grows.reduce<GroupReadiness | undefined>((found, r) => {
                  if (found) return found
                  const fc = r.original.featureContractId
                  return fc ? readinessByGroup?.[fc] : undefined
                }, undefined)
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
      {totalRows > size ? (
        <div
          className="tt-pager"
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 10,
            marginTop: 10,
            fontSize: 12.5,
            color: 'var(--text-dim)',
          }}
          data-testid="tasks-table-pager"
        >
          <span>
            {safePage * size + 1}–{Math.min(totalRows, safePage * size + size)} dari {totalRows}
          </span>
          <button
            type="button"
            className="fbtn"
            disabled={safePage <= 0}
            onClick={() => setPage((p) => Math.max(0, p - 1))}
            aria-label="Halaman tugas sebelumnya"
          >
            Sebelumnya
          </button>
          <span className="chip chip-mono" style={{ fontSize: 11 }}>
            {safePage + 1}/{pageCount}
          </span>
          <button
            type="button"
            className="fbtn"
            disabled={safePage >= pageCount - 1}
            onClick={() => setPage((p) => Math.min(pageCount - 1, p + 1))}
            aria-label="Halaman tugas berikutnya"
          >
            Berikutnya
          </button>
        </div>
      ) : null}
    </>
  )
}
