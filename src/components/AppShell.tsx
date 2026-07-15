import { Link, useRouterState } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import { useStore } from '@tanstack/react-store'
import { useEffect, useMemo, useState } from 'react'
import type { ReactNode } from 'react'

import { BoardLink } from '#/components/BoardLink'
import { UserMenu } from '#/components/UserMenu'
import { BrandMark, Icon } from '#/lib/icons'
import type { IconName } from '#/lib/icons'
import {
  useBoard,
  useBoardId,
  useBoardViews,
  useBoards,
} from '#/lib/board-query'
import { fmtDate } from '#/lib/format'
import {
  featuresQueryOptions,
  getDefaultControlCenterFetchers,
  isControlCenterBoard,
  overviewQueryOptions,
} from '#/lib/control-center-query'
import { initTheme, setSearch, uiStore } from '#/store/ui'
import '#/components/control-center/control-center-shell.css'

export const BRAND = 'Cairn'

interface NavItem {
  id: string
  label: string
  icon: IconName
  to: string
  match: (p: string) => boolean
  count?: (n: NavCounts) => number
}
interface NavCounts {
  agents: number
  projects: number
  features: number
  decisions: number
  log: number
}

/** Classic adaptive nav (non control-center boards). */
const NAV: Array<NavItem | { sep: true; label: string }> = [
  {
    id: 'board',
    label: 'Board',
    icon: 'board',
    to: '/',
    match: (p) => p === '/',
  },
  {
    id: 'agents',
    label: 'Agents',
    icon: 'agents',
    to: '/agents',
    match: (p) => p.startsWith('/agents'),
    count: (n) => n.agents,
  },
  { sep: true, label: 'Plan' },
  {
    id: 'projects',
    label: 'Projects',
    icon: 'projects',
    to: '/projects',
    match: (p) => p.startsWith('/projects'),
    count: (n) => n.projects,
  },
  {
    id: 'features',
    label: 'Features',
    icon: 'features',
    to: '/features',
    match: (p) => p.startsWith('/features'),
    count: (n) => n.features,
  },
  {
    id: 'tasks',
    label: 'Tasks',
    icon: 'check',
    to: '/tasks',
    match: (p) => p.startsWith('/tasks'),
  },
  {
    id: 'map',
    label: 'Map',
    icon: 'branch',
    to: '/map',
    match: (p) => p.startsWith('/map'),
  },
  {
    id: 'design',
    label: 'Design',
    icon: 'layers',
    to: '/design',
    match: (p) => p.startsWith('/design'),
  },
  {
    id: 'decisions',
    label: 'Decisions',
    icon: 'decisions',
    to: '/decisions',
    match: (p) => p.startsWith('/decisions'),
    count: (n) => n.decisions,
  },
  {
    id: 'log',
    label: 'Log',
    icon: 'log',
    to: '/log',
    match: (p) => p.startsWith('/log'),
    count: (n) => n.log,
  },
  { sep: true, label: 'Ops' },
  {
    id: 'ops',
    label: 'Accounts',
    icon: 'users',
    to: '/ops',
    match: (p) => p.startsWith('/ops'),
  },
]

/**
 * Nine primary IA destinations for control-center boards (UI_CONTRACT §2).
 * Exact English label order for mfs-rebuild (and any control-center board).
 * id-ID human aliases are aria/title only — nine IA remains reachable.
 * Task/map/design/log remain reachable as drill-downs / compatibility paths.
 */
export const CONTROL_CENTER_NAV_LABELS = [
  'Overview',
  'Work',
  'Priority',
  'Projects',
  'Features / Flows',
  'Agents / Runs',
  'Ops / Accounts',
  'Decisions',
  'Evidence / Audit',
] as const

/** id-ID human chrome aliases (ART); never replaces CONTROL_CENTER_NAV_LABELS order. */
export const CONTROL_CENTER_NAV_LABELS_ID: Record<
  (typeof CONTROL_CENTER_NAV_LABELS)[number],
  string
> = {
  Overview: 'Ringkasan',
  Work: 'Pekerjaan',
  Priority: 'Prioritas',
  Projects: 'Proyek',
  'Features / Flows': 'Fitur / Alur',
  'Agents / Runs': 'Agen / Run',
  'Ops / Accounts': 'Operasi / Akun',
  Decisions: 'Keputusan',
  'Evidence / Audit': 'Bukti / Audit',
}

const CONTROL_CENTER_NAV: Array<NavItem | { sep: true; label: string }> = [
  {
    id: 'overview',
    label: 'Overview',
    icon: 'board',
    to: '/',
    match: (p) => p === '/' || p === '',
  },
  {
    id: 'work',
    label: 'Work',
    icon: 'check',
    to: '/work',
    match: (p) =>
      p === '/work' || p.startsWith('/work?') || p.startsWith('/work/'),
  },
  {
    id: 'priority',
    label: 'Priority',
    icon: 'flag',
    to: '/priority',
    match: (p) => p.startsWith('/priority'),
  },
  // Separator chrome id-ID; item .lbl stays English (UI_CONTRACT §2 / e2e).
  { sep: true, label: 'Struktur' },
  {
    id: 'projects',
    label: 'Projects',
    icon: 'projects',
    to: '/projects',
    match: (p) => p.startsWith('/projects'),
    count: (n) => n.projects,
  },
  {
    id: 'features',
    label: 'Features / Flows',
    icon: 'features',
    to: '/features',
    match: (p) => p.startsWith('/features'),
    count: (n) => n.features,
  },
  { sep: true, label: 'Operasi' },
  {
    id: 'agents',
    label: 'Agents / Runs',
    icon: 'agents',
    to: '/agents',
    match: (p) => p.startsWith('/agents'),
    count: (n) => n.agents,
  },
  {
    id: 'ops',
    label: 'Ops / Accounts',
    icon: 'users',
    to: '/ops',
    match: (p) => p.startsWith('/ops'),
  },
  {
    id: 'decisions',
    label: 'Decisions',
    icon: 'decisions',
    to: '/decisions',
    match: (p) => p.startsWith('/decisions'),
    count: (n) => n.decisions,
  },
  {
    id: 'evidence',
    label: 'Evidence / Audit',
    icon: 'log',
    to: '/evidence',
    match: (p) => p.startsWith('/evidence'),
  },
]

const SECTION_TITLE: Record<string, string> = {
  board: 'Board',
  overview: 'Overview',
  work: 'Work',
  priority: 'Priority',
  agents: 'Agents / Runs',
  projects: 'Projects',
  features: 'Features / Flows',
  tasks: 'Tasks',
  map: 'Dependency map',
  design: 'System design',
  decisions: 'Decisions',
  log: 'Activity log',
  evidence: 'Evidence / Audit',
  ops: 'Ops / Accounts',
  prod: 'Path to production',
  guide: 'Guide',
  knowledge: 'Pengetahuan',
  search: 'Pencarian',
  documentation: 'Dokumentasi',
}

const SECTION_TITLE_ID: Record<string, string> = {
  overview: 'Ringkasan',
  work: 'Pekerjaan',
  priority: 'Prioritas',
  projects: 'Proyek',
  features: 'Fitur / Alur',
  agents: 'Agen / Run',
  ops: 'Operasi / Akun',
  decisions: 'Keputusan',
  evidence: 'Bukti / Audit',
  knowledge: 'Pengetahuan',
  search: 'Pencarian',
  documentation: 'Dokumentasi',
  tasks: 'Tugas',
}

export function AppShell({ children }: { children: ReactNode }) {
  const m = useBoard()
  const boardId = useBoardId()
  const views = useBoardViews()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useStore(uiStore, (s) => s.search)
  const controlCenter = isControlCenterBoard(boardId)
  const navSource = controlCenter ? CONTROL_CENTER_NAV : NAV

  // adaptive nav: keep enabled items + any separator that precedes ≥1 enabled item
  // control-center boards: always show the nine primary IA destinations (UI_CONTRACT §2)
  const visible = controlCenter
    ? navSource
    : navSource.filter((n, i) => {
        if (!('sep' in n)) return views.includes(n.id)
        for (let j = i + 1; j < navSource.length; j++) {
          const next = navSource[j]
          if ('sep' in next) break
          if (views.includes(next.id)) return true
        }
        return false
      })

  useEffect(() => {
    initTheme()
  }, [])

  // board-relative path (strip the /b/<id> scope) for nav matching + breadcrumbs
  const sub = pathname.replace(/^\/b\/[^/]+/, '') || '/'

  // ART top-level aliases may appear without /b/ prefix when tests hit paths directly
  const subForMatch = (() => {
    if (pathname.startsWith('/b/')) return sub
    if (pathname.startsWith('/work')) return pathname
    if (pathname.startsWith('/decisions')) return pathname
    if (pathname.startsWith('/knowledge')) return pathname
    if (pathname.startsWith('/search')) return pathname
    if (pathname.startsWith('/documentation')) return pathname
    return sub
  })()

  // mfs-rebuild (CC boards): IA badges read pinned envelope counts via shared query
  // cache (same keys as Overview/Features surfaces). No client recompute of readiness
  // / buckets / open membership — only length/decisionCount from server payloads.
  // Non-CC boards keep legacy boardQuery model counts.
  const ccFetchers = useMemo(
    () => (controlCenter ? getDefaultControlCenterFetchers() : null),
    [controlCenter],
  )
  const overviewQ = useQuery({
    ...overviewQueryOptions(
      boardId,
      ccFetchers?.overview ?? (async () => null as never),
    ),
    enabled: controlCenter && Boolean(ccFetchers),
  })
  const featuresQ = useQuery({
    ...featuresQueryOptions(
      boardId,
      {},
      ccFetchers?.features ?? (async () => null as never),
    ),
    enabled: controlCenter && Boolean(ccFetchers),
  })

  const counts: NavCounts = useMemo(() => {
    if (!controlCenter) {
      return {
        agents: m.runningAgents.length,
        projects: m.projects.length,
        features: m.active.length,
        decisions: m.decisions.length,
        log: m.log.length,
      }
    }
    const overviewData = overviewQ.isSuccess ? overviewQ.data.data : undefined
    const featuresData = featuresQ.isSuccess ? featuresQ.data.data : undefined
    return {
      agents: overviewData ? overviewData.ongoing.length : 0,
      projects: overviewData ? overviewData.projects.length : 0,
      features: featuresData
        ? (featuresData.items.length
            ? featuresData.items
            : featuresData.features
          ).length
        : 0,
      decisions: overviewData ? overviewData.decisionCount : 0,
      log: m.log.length,
    }
  }, [
    controlCenter,
    m.runningAgents.length,
    m.projects.length,
    m.active.length,
    m.decisions.length,
    m.log.length,
    overviewQ.data,
    featuresQ.data,
  ])

  const navItems = navSource.filter((item): item is NavItem => !('sep' in item))
  const activeItem =
    navItems.find((item) => item.match(subForMatch)) ?? navItems[0]
  let section = activeItem.id
  // Knowledge / search / documentation are ART drill-downs (not 10th nav items).
  if (subForMatch.startsWith('/knowledge')) section = 'knowledge'
  else if (subForMatch.startsWith('/search')) section = 'search'
  else if (subForMatch.startsWith('/documentation')) section = 'documentation'
  else if (subForMatch.startsWith('/work/') && subForMatch !== '/work')
    section = 'work'

  let crumb = ''
  const projMatch = sub.match(/^\/projects\/(.+)$/)
  const featMatch = sub.match(/^\/features\/(.+)$/)
  if (projMatch) {
    const projectId = decodeURIComponent(projMatch[1])
    crumb = projectId in m.projById ? m.projById[projectId].nama : 'Project'
  } else if (featMatch) {
    const featureId = decodeURIComponent(featMatch[1])
    crumb = featureId in m.featById ? m.featById[featureId].nama : 'Feature'
  }
  const baseTitleEn =
    SECTION_TITLE[section] ?? (controlCenter ? 'Overview' : 'Board')
  const baseTitleId = SECTION_TITLE_ID[section]
  const baseTitle = baseTitleId
    ? `${baseTitleEn} · ${baseTitleId}`
    : baseTitleEn

  return (
    <div
      className={controlCenter ? 'app app--control-center' : 'app'}
      data-control-center={controlCenter ? 'true' : 'false'}
    >
      <aside
        className="sidebar"
        data-control-center={controlCenter ? 'true' : 'false'}
      >
        <div className="sidebar-chrome">
          <Link
            to="/"
            className="brand"
            title="All boards"
            aria-label={`${BRAND} — all boards`}
          >
            <BrandMark />
            <div className="brand-text">
              <div className="brand-name">{BRAND}</div>
              <div className="brand-sub">Agent work board</div>
            </div>
          </Link>

          <BoardSwitcher boardId={boardId} />
        </div>

        <nav
          className="nav"
          aria-label={controlCenter ? 'Control center' : 'Board'}
          data-control-center={controlCenter ? 'true' : 'false'}
        >
          {visible.map((n, i) =>
            'sep' in n ? (
              <div
                key={`sep-${i}`}
                className="nav-sep-block"
                aria-hidden="true"
              >
                <div className="nav-sep" />
                <div className="nav-label">{n.label}</div>
              </div>
            ) : (
              <BoardLink
                key={n.id}
                to={n.to}
                className={`nav-item ${n.match(subForMatch) ? 'active' : ''}`}
                aria-label={n.label}
                title={
                  controlCenter && n.label in CONTROL_CENTER_NAV_LABELS_ID
                    ? `${n.label} · ${CONTROL_CENTER_NAV_LABELS_ID[n.label as keyof typeof CONTROL_CENTER_NAV_LABELS_ID]}`
                    : n.label
                }
                data-nav-id={n.id}
                data-nav-label-en={n.label}
                data-nav-label-id={
                  controlCenter && n.label in CONTROL_CENTER_NAV_LABELS_ID
                    ? CONTROL_CENTER_NAV_LABELS_ID[
                        n.label as keyof typeof CONTROL_CENTER_NAV_LABELS_ID
                      ]
                    : undefined
                }
              >
                <Icon name={n.icon} size={17} className="nav-ico" />
                <span className="nav-text">
                  {controlCenter && n.label in CONTROL_CENTER_NAV_LABELS_ID ? (
                    <span className="nav-lbl-id">
                      {
                        CONTROL_CENTER_NAV_LABELS_ID[
                          n.label as keyof typeof CONTROL_CENTER_NAV_LABELS_ID
                        ]
                      }
                    </span>
                  ) : null}
                  <span className="lbl">{n.label}</span>
                </span>
                {n.count ? (
                  <span
                    className="nav-count"
                    aria-label={`${n.count(counts)} items`}
                  >
                    {n.count(counts)}
                  </span>
                ) : null}
              </BoardLink>
            ),
          )}
        </nav>

        <div className="sidebar-foot">
          SSOT · data/boards/{boardId || '…'}
          <br />
          updated {fmtDate(m.updated)}
        </div>
      </aside>

      <div className="main">
        <header className="topbar">
          <h1 id="page-title">
            {crumb ? (
              <>
                <span className="crumb">{baseTitle} /</span> {crumb}
              </>
            ) : (
              baseTitle
            )}
          </h1>
          <div className="topbar-spacer" />
          <div className="search">
            <Icon name="search" />
            <input
              value={search}
              onChange={(e) => setSearch(e.target.value)}
              placeholder={
                controlCenter ? 'Cari fitur, agen…' : 'Search features, agents…'
              }
              autoComplete="off"
              aria-label={
                controlCenter
                  ? 'Cari fitur dan agen'
                  : 'Search features and agents'
              }
            />
          </div>
          <UserMenu />
        </header>
        <main
          className="content"
          id="view"
          aria-label="Main content"
          tabIndex={0}
          data-testid="app-main-content"
        >
          {children}
        </main>
      </div>
    </div>
  )
}

function BoardSwitcher({ boardId }: { boardId: string }) {
  const boards = useBoards()
  const [open, setOpen] = useState(false)
  const current = boards.find((b) => b.id === boardId)
  const boardName = current?.name ?? boardId
  return (
    <div className="switcher">
      <button
        type="button"
        className="switcher-btn"
        onClick={() => setOpen((v) => !v)}
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={`Switch board, current: ${boardName}`}
      >
        <Icon name="board" size={15} />
        <span className="switcher-name" title={boardName}>
          {boardName}
        </span>
        <Icon name="chevL" size={14} className="switcher-caret" />
      </button>
      {open ? (
        <div className="switcher-menu" role="listbox" aria-label="Boards">
          {boards.map((b) => (
            <Link
              key={b.id}
              to="/b/$boardId"
              params={{ boardId: b.id }}
              className={`switcher-item ${b.id === boardId ? 'active' : ''}`}
              role="option"
              aria-selected={b.id === boardId}
              onClick={() => setOpen(false)}
            >
              <Icon name="board" size={14} />
              {b.name}
            </Link>
          ))}
          <div className="nav-sep" aria-hidden="true" />
          <a
            href="/?boards=1"
            className="switcher-item"
            onClick={() => setOpen(false)}
          >
            <Icon name="layers" size={14} /> All boards
          </a>
        </div>
      ) : null}
    </div>
  )
}
