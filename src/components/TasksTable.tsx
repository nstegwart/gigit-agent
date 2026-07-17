// Tasks table — Direction B (FAN-PROJECTS). UI kit Table + Pagination + Toolbar.
// Logic preserved: filters, human titles, domain groups, readiness/next gate.
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'

import { useBoardId } from '#/lib/board-query'
import { MiniAgent } from '#/components/primitives'
import {
  cleanTechnicalTitle,
  isOwnerTitlePlaceholder,
  resolveOwnerDisplay,
} from '#/components/control-center/work/ownerDisplay'
import { formatLifecycleStageLabel } from '#/lib/display-label'
import { fmtDate } from '#/lib/format'
import { nextStage, rowReadiness } from '#/lib/readiness'
import type { TaskView } from '#/lib/tasks'
import type { GroupReadiness, LifecycleConfig, Run } from '#/lib/types'
import { uiStore } from '#/store/ui'
import {
  Badge,
  Button,
  EmptyState,
  Pagination,
  Pill,
  ProgressBar,
  StatusChip,
  Table,
  Toolbar,
  type StatusChipVariant,
  type SortDirection,
  type TableColumn,
} from '#/components/ui'

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
}

const groupHeaderStyle: CSSProperties = {
  display: 'flex',
  alignItems: 'center',
  gap: 'var(--sp-2)',
  flexWrap: 'wrap',
  padding: 'var(--sp-2) var(--sp-3)',
  borderBottom: '1px solid var(--border)',
  background: 'var(--surface)',
  cursor: 'pointer',
  userSelect: 'none',
}

function titleCaseToken(p: string): string {
  if (!p) return p
  if (/^\d+$/.test(p)) return p
  if (p.length <= 3 && p === p.toUpperCase()) return p
  return p.charAt(0).toUpperCase() + p.slice(1).toLowerCase()
}

/** Strip bracket FC tags / T-* / FC-* tokens; light normalize for owner scan.
 *  Reuses ownerDisplay.cleanTechnicalTitle (V1.1 §C) — no local policy fork. */
export function cleanTaskTitle(raw: string): string {
  return cleanTechnicalTitle(raw)
}

/**
 * Owner-facing task title (V1.1 §C via ownerDisplay.resolveOwnerDisplay):
 * humanTitle / ownerPrimary → cleaned technical title → taskId.
 * Never surfaces placeholder as sole primary. Task-id remains secondary in the cell.
 */
export function resolveTaskDisplayTitle(t: {
  id: string
  title: string
  humanTitle?: string | null
  ownerPrimaryTitle?: string | null
  humanDisplay?: { ownerPrimaryTitle?: string | null; title?: string | null } | null
}): string {
  const ownerPrimary =
    t.humanTitle ??
    t.ownerPrimaryTitle ??
    t.humanDisplay?.ownerPrimaryTitle ??
    t.humanDisplay?.title ??
    null
  // Skip bare technical task-id masquerading as human title (secondary only).
  const primary =
    ownerPrimary &&
    !isOwnerTitlePlaceholder(ownerPrimary) &&
    !/^T-[A-Z0-9._-]+$/i.test(ownerPrimary.trim())
      ? ownerPrimary
      : null
  return resolveOwnerDisplay({
    technicalTitle: t.title ?? '',
    taskId: t.id,
    ownerPrimaryTitle: primary,
  }).primaryTitle
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

function stageVariant(stage: string | null | undefined, blocked?: string | null): StatusChipVariant {
  if (blocked) return 'blocked'
  if (!stage) return 'pending'
  const s = stage.toUpperCase()
  if (/PROD_READY|DONE|COMPLETE|SELESAI|PASS|LIVE/.test(s)) return 'done'
  if (/BLOCK|FAIL|HOLD|STOP/.test(s)) return 'blocked'
  if (/MAP|PENDING|WAIT|QUEUED|BACKLOG/.test(s)) return 'pending'
  if (/WARN|STALE|PARTIAL/.test(s)) return 'warn'
  if (/BUILD|RUN|PROGRESS|ONGOING|IMPL|VERIFY/.test(s)) return 'ongoing'
  if (/NEXT|READY/.test(s)) return 'next'
  return 'ongoing'
}

function flagLabel(f: string): string {
  if (f === 'blocked') return 'Terhambat'
  if (f === 'stale') return 'Basi'
  if (f === 'assigned') return 'Ditugaskan'
  if (f === 'unassigned') return 'Belum ditugaskan'
  return f
}

export function TasksTable({
  tasks,
  runsByTask,
  readinessByGroup,
  milestone,
  cfg,
  pageSize: pageSizeProp = TASKS_TABLE_PAGE_SIZE,
}: {
  tasks: Array<TaskView>
  runsByTask?: Record<string, Array<Run>>
  readinessByGroup?: Record<string, GroupReadiness>
  milestone?: string | null
  cfg?: LifecycleConfig
  /** Override page size (default 25). */
  pageSize?: number
}) {
  const globalQ = useStore(uiStore, (s) => s.search)
  const [localSearch, setLocalSearch] = useState('')
  const [filterProj, setFilterProj] = useState('')
  const [filterScope, setFilterScope] = useState('')
  const [filterStage, setFilterStage] = useState('')
  const [filterFC, setFilterFC] = useState('')
  const [filterGate, setFilterGate] = useState('')
  const [filterFlag, setFilterFlag] = useState('') // '' | blocked | stale | assigned | unassigned
  const [sortColumnId, setSortColumnId] = useState<string | null>('readiness')
  const [sortDirection, setSortDirection] = useState<SortDirection>('asc')
  const navigate = useNavigate()
  const boardId = useBoardId()
  const [openGroups, setOpenGroups] = useState<Set<string>>(() => new Set())
  const [touched, setTouched] = useState(false)
  const [page, setPage] = useState(1)
  const [pageSize, setPageSize] = useState(pageSizeProp)

  useEffect(() => {
    setPageSize(pageSizeProp)
  }, [pageSizeProp])

  const q = localSearch || globalQ

  const readyOf = (t: TaskView) => (cfg ? rowReadiness(cfg, t.lifecycleStage, t.done, t.total) : t.pct)
  const nextOf = (t: TaskView) => (cfg ? nextStage(cfg, t.lifecycleStage)?.key ?? null : null)
  // §4: "assigned" = a queued/running run only (a finished verifier is not an assignment)
  const runOf = (t: TaskView) =>
    (runsByTask?.[t.id] ?? []).find((r) => r.status === 'running' || r.status === 'queued') ?? null
  const assigned = (t: TaskView) => !!runOf(t)

  const projects = useMemo(
    () => [...new Set(tasks.map((t) => t.projectId).filter(Boolean) as Array<string>)].sort(),
    [tasks],
  )
  const scopes = useMemo(
    () => [...new Set(tasks.map((t) => t.scope).filter(Boolean) as Array<string>)].sort(),
    [tasks],
  )
  const fcs = useMemo(
    () => [...new Set(tasks.map((t) => t.featureContractId).filter(Boolean) as Array<string>)].sort(),
    [tasks],
  )
  const gates = useMemo(() => cfg?.stages.map((s) => s.key) ?? [], [cfg])

  const rows = useMemo(() => {
    const Q = q.toLowerCase()
    // Only compute wall-clock cutoff when the stale filter is active (avoids SSR/client clock drift on other paths)
    const staleBefore = filterFlag === 'stale' ? Date.now() - 7 * 864e5 : 0
    let out = tasks.slice()
    if (filterProj) out = out.filter((t) => t.projectId === filterProj)
    if (filterScope) out = out.filter((t) => t.scope === filterScope)
    if (filterStage)
      out = out.filter((t) =>
        filterStage === '__uninit__' ? !t.lifecycleStage : t.lifecycleStage === filterStage,
      )
    if (filterFC) out = out.filter((t) => t.featureContractId === filterFC)
    if (filterGate) out = out.filter((t) => nextOf(t) === filterGate)
    if (filterFlag === 'blocked') out = out.filter((t) => t.blockedReason)
    else if (filterFlag === 'stale')
      out = out.filter((t) => t.updated && Date.parse(t.updated) < staleBefore)
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

    if (sortColumnId && sortDirection) {
      const dir = sortDirection === 'desc' ? -1 : 1
      out = out.slice().sort((a, b) => {
        let cmp = 0
        if (sortColumnId === 'task') {
          cmp = resolveTaskDisplayTitle(a).localeCompare(resolveTaskDisplayTitle(b), 'id')
        } else if (sortColumnId === 'stage') {
          cmp = (a.lifecycleStage ?? '').localeCompare(b.lifecycleStage ?? '')
        } else if (sortColumnId === 'project') {
          cmp = (a.projectId ?? '').localeCompare(b.projectId ?? '')
        } else if (sortColumnId === 'readiness') {
          cmp = readyOf(a) - readyOf(b)
        } else if (sortColumnId === 'receipt') {
          cmp = (a.lastReceiptAt ?? a.updated ?? '').localeCompare(b.lastReceiptAt ?? b.updated ?? '')
        }
        if (cmp !== 0) return cmp * dir
        return a.id.localeCompare(b.id)
      })
    }
    return out
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    tasks,
    filterProj,
    filterScope,
    filterStage,
    filterFC,
    filterGate,
    filterFlag,
    q,
    runsByTask,
    cfg,
    sortColumnId,
    sortDirection,
  ])

  // Reset page when filter/search changes
  useEffect(() => {
    setPage(1)
  }, [filterProj, filterScope, filterStage, filterFC, filterGate, filterFlag, q, tasks.length, pageSize])

  const totalRows = rows.length
  const size = Math.max(1, pageSize)
  const pageCount = Math.max(1, Math.ceil(totalRows / size))
  const safePage = Math.min(page, pageCount)
  const pageRows = rows.slice((safePage - 1) * size, safePage * size)

  // bucket the current page into collapsible domain/theme groups (insertion order)
  const groups: Array<[string, Array<TaskView>]> = []
  const gIndex = new Map<string, number>()
  for (const t of pageRows) {
    const k = domainGroupKeyOf(t)
    let i = gIndex.get(k)
    if (i === undefined) {
      i = groups.length
      gIndex.set(k, i)
      groups.push([k, []])
    }
    groups[i]![1].push(t)
  }
  const single = groups.length <= 1
  const searching = q.trim() !== ''
  const autoOpen = pageRows.length <= 25 // short lists open by default; long ones collapse
  const isOpen = (k: string) => single || searching || (touched ? openGroups.has(k) : autoOpen)
  const toggleGroup = (k: string) => {
    setTouched(true)
    setOpenGroups((prev) => {
      const n = new Set(prev)
      if (n.has(k)) n.delete(k)
      else n.add(k)
      return n
    })
  }
  const allExpanded = groups.every(([k]) => isOpen(k))
  const expandAll = () => {
    setTouched(true)
    setOpenGroups(new Set(groups.map(([k]) => k)))
  }
  const collapseAll = () => {
    setTouched(true)
    setOpenGroups(new Set())
  }

  const onSort = (columnId: string) => {
    if (sortColumnId === columnId) {
      setSortDirection((d) => (d === 'asc' ? 'desc' : d === 'desc' ? false : 'asc'))
      if (sortDirection === 'desc') setSortColumnId(null)
    } else {
      setSortColumnId(columnId)
      setSortDirection('asc')
    }
  }

  const columns: Array<TableColumn<TaskView>> = useMemo(
    () => [
      {
        id: 'task',
        header: 'Tugas',
        sortable: true,
        cell: (t) => {
          const human = resolveTaskDisplayTitle(t)
          return (
            <div style={titleCellStyle}>
              <span style={primaryTitleStyle}>{human}</span>
              <span style={monoIdStyle} title={t.title !== human ? t.title : undefined}>
                {t.id}
              </span>
            </div>
          )
        },
      },
      {
        id: 'stage',
        header: 'Tahap',
        sortable: true,
        cell: (t) => {
          const s = t.lifecycleStage
          const label = s ? formatLifecycleStageLabel(s) || s : null
          return (
            <div style={{ display: 'flex', flexDirection: 'column', gap: 4, alignItems: 'flex-start' }}>
              {s ? (
                <StatusChip variant={stageVariant(s, t.blockedReason)} showDot data-stage={s} title={s}>
                  {label}
                </StatusChip>
              ) : (
                <span style={monoIdStyle}>belum diinisialisasi</span>
              )}
              {t.blockedReason ? (
                <span
                  style={{ fontSize: 11, color: 'var(--blocked)' }}
                  title={t.blockedReason}
                >
                  terhambat
                </span>
              ) : null}
            </div>
          )
        },
      },
      {
        id: 'nextgate',
        header: 'Gate berikutnya',
        cell: (t) => {
          const ng = nextOf(t)
          return ng ? (
            <span style={{ color: 'var(--accent)', fontFamily: 'var(--mono)', fontSize: 12 }}>{ng}</span>
          ) : (
            <span style={monoIdStyle}>—</span>
          )
        },
      },
      {
        id: 'project',
        header: 'Proyek',
        sortable: true,
        cell: (t) =>
          t.projectId ? (
            <Badge mono>{t.projectId}</Badge>
          ) : (
            <span style={monoIdStyle}>—</span>
          ),
      },
      {
        id: 'run',
        header: 'Run',
        cell: (t) => {
          const r = runOf(t)
          return r ? <MiniAgent run={r} /> : <span style={monoIdStyle}>—</span>
        },
      },
      {
        id: 'readiness',
        header: 'Kesiapan',
        sortable: true,
        cell: (t) => {
          const p = readyOf(t)
          return <ProgressBar value={p} max={100} ok={p >= 100} label={`${p}%`} />
        },
      },
      {
        id: 'impact',
        header: 'Dampak',
        cell: (t) => {
          const im = t.impacts
          if (!im.length) return <span style={monoIdStyle}>—</span>
          return (
            <div style={{ display: 'flex', gap: 4, alignItems: 'center', flexWrap: 'wrap' }}>
              <Badge>{im[0]}</Badge>
              {im.length > 1 ? <Badge>+{im.length - 1}</Badge> : null}
            </div>
          )
        },
      },
      {
        id: 'receipt',
        header: 'Receipt terakhir',
        sortable: true,
        cell: (t) => {
          const v = t.lastReceiptAt ?? t.updated ?? ''
          return (
            <span style={{ fontSize: 12, color: 'var(--text-faint)', whiteSpace: 'nowrap' }}>
              {v ? fmtDate(v) : '—'}
            </span>
          )
        },
      },
    ],
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [runsByTask, cfg],
  )

  // Navigate from human title button (keeps whole-row click free of kit Table constraints)
  const columnsClickable: Array<TableColumn<TaskView>> = useMemo(
    () =>
      columns.map((col) =>
        col.id === 'task'
          ? {
              ...col,
              cell: (t) => {
                const human = resolveTaskDisplayTitle(t)
                return (
                  <button
                    type="button"
                    onClick={() =>
                      void navigate({
                        to: '/b/$boardId/tasks/$taskId',
                        params: { boardId, taskId: t.id },
                      })
                    }
                    style={{
                      ...titleCellStyle,
                      background: 'none',
                      border: 0,
                      padding: 0,
                      margin: 0,
                      cursor: 'pointer',
                      textAlign: 'left',
                      width: '100%',
                      font: 'inherit',
                    }}
                  >
                    <span style={primaryTitleStyle}>{human}</span>
                    <span style={monoIdStyle} title={t.title !== human ? t.title : undefined}>
                      {t.id}
                    </span>
                  </button>
                )
              },
            }
          : col,
      ),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [columns, boardId, navigate],
  )

  return (
    <div style={{ display: 'flex', flexDirection: 'column', gap: 'var(--sp-3)' }} data-testid="tasks-table">
      <div style={{ padding: '0 var(--sp-4)' }}>
        <Toolbar
          searchProps={{
            value: localSearch,
            onChange: (e) => setLocalSearch(e.target.value),
            placeholder: 'Cari tugas…',
            'aria-label': 'Cari tugas',
          }}
          filters={
            <>
              <Pill active={filterProj === ''} onClick={() => setFilterProj('')}>
                Semua proyek
              </Pill>
              {projects.map((p) => (
                <Pill key={p} active={filterProj === p} onClick={() => setFilterProj(filterProj === p ? '' : p)}>
                  {p}
                </Pill>
              ))}
              {scopes.length > 0
                ? scopes.map((s) => (
                    <Pill
                      key={`sc-${s}`}
                      active={filterScope === s}
                      onClick={() => setFilterScope(filterScope === s ? '' : s)}
                    >
                      {s}
                    </Pill>
                  ))
                : null}
              {cfg?.stages.length
                ? cfg.stages.map((s) => (
                    <Pill
                      key={s.key}
                      active={filterStage === s.key}
                      onClick={() => setFilterStage(filterStage === s.key ? '' : s.key)}
                    >
                      {formatLifecycleStageLabel(s.key) || s.key}
                    </Pill>
                  ))
                : null}
              {(['blocked', 'stale', 'assigned', 'unassigned'] as const).map((f) => (
                <Pill
                  key={f}
                  active={filterFlag === f}
                  onClick={() => setFilterFlag(filterFlag === f ? '' : f)}
                >
                  {flagLabel(f)}
                </Pill>
              ))}
            </>
          }
          actions={
            <>
              {fcs.length ? (
                <select
                  value={filterFC}
                  onChange={(e) => setFilterFC(e.target.value)}
                  aria-label="Filter fitur kontrak"
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm, 6px)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">Semua FC</option>
                  {fcs.map((f) => (
                    <option key={f} value={f} title={f}>
                      {formatFeatureContractLabel(f)}
                    </option>
                  ))}
                </select>
              ) : null}
              {gates.length ? (
                <select
                  value={filterGate}
                  onChange={(e) => setFilterGate(e.target.value)}
                  aria-label="Filter gate berikutnya"
                  style={{
                    fontSize: 12,
                    padding: '4px 8px',
                    border: '1px solid var(--border)',
                    borderRadius: 'var(--r-sm, 6px)',
                    background: 'var(--surface)',
                    color: 'var(--text)',
                  }}
                >
                  <option value="">Gate mana saja</option>
                  {gates.map((g) => (
                    <option key={g} value={g}>
                      → {formatLifecycleStageLabel(g) || g}
                    </option>
                  ))}
                </select>
              ) : null}
              {!single && !searching ? (
                <Button type="button" variant="ghost" size="sm" onClick={allExpanded ? collapseAll : expandAll}>
                  {allExpanded ? 'Ciutkan semua' : 'Bentangkan semua'}
                  <Badge>{groups.length}</Badge>
                </Button>
              ) : null}
            </>
          }
        />
      </div>

      {totalRows === 0 ? (
        <div style={{ padding: 'var(--sp-4)' }}>
          <EmptyState title="Tidak ada tugas" description="Tidak ada tugas yang cocok dengan filter." />
        </div>
      ) : single ? (
        <Table
          columns={columnsClickable}
          rows={pageRows}
          rowKey={(t) => t.id}
          empty="Tidak ada tugas."
          sortColumnId={sortColumnId}
          sortDirection={sortDirection}
          onSort={onSort}
          aria-label="Tabel tugas"
        />
      ) : (
        <div>
          {groups.map(([key, grows]) => {
            const open = isOpen(key)
            const totalSum = grows.reduce((a, t) => a + t.total, 0)
            const doneSum = grows.reduce((a, t) => a + t.done, 0)
            const gr =
              readinessByGroup?.[key] ??
              grows.reduce<GroupReadiness | undefined>((found, t) => {
                if (found) return found
                const fc = t.featureContractId
                return fc ? readinessByGroup?.[fc] : undefined
              }, undefined)
            const pct = gr
              ? gr.readinessPercent
              : Math.round(grows.reduce((a, t) => a + t.pct, 0) / Math.max(1, grows.length))
            return (
              <div key={key} data-domain-group={key}>
                <div
                  style={groupHeaderStyle}
                  onClick={() => toggleGroup(key)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ' ') {
                      e.preventDefault()
                      toggleGroup(key)
                    }
                  }}
                  role="button"
                  tabIndex={0}
                  aria-expanded={open}
                >
                  <span style={{ color: 'var(--text-faint)', fontSize: 12 }} aria-hidden>
                    {open ? '▼' : '▶'}
                  </span>
                  <span style={{ fontWeight: 500, color: 'var(--text)' }}>{key}</span>
                  <Badge>{grows.length}</Badge>
                  {gr ? (
                    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>
                      floor {gr.floor ?? '—'}
                      {milestone ? ` · ${gr.atMilestone}/${gr.total} ${milestone}` : ''}
                    </span>
                  ) : null}
                  <span style={{ marginLeft: 'auto', minWidth: 140, maxWidth: 220 }}>
                    <ProgressBar
                      value={pct}
                      max={100}
                      ok={pct >= 100}
                      label={gr ? `${pct}% · ${doneSum}/${totalSum}` : `${doneSum}/${totalSum}`}
                    />
                  </span>
                </div>
                {open ? (
                  <Table
                    columns={columnsClickable}
                    rows={grows}
                    rowKey={(t) => t.id}
                    empty="—"
                    sortColumnId={sortColumnId}
                    sortDirection={sortDirection}
                    onSort={onSort}
                    aria-label={`Tugas domain ${key}`}
                  />
                ) : null}
              </div>
            )
          })}
        </div>
      )}

      {totalRows > 0 ? (
        <div style={{ padding: '0 var(--sp-4) var(--sp-3)' }} data-testid="tasks-table-pager">
          <Pagination
            page={safePage}
            pageSize={size}
            total={totalRows}
            onPageChange={setPage}
            onPageSizeChange={(n) => {
              setPageSize(n)
              setPage(1)
            }}
          />
        </div>
      ) : null}
    </div>
  )
}
