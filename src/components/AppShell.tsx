import { Link, useRouterState } from '@tanstack/react-router'
import { useStore } from '@tanstack/react-store'
import { useEffect, useState, type ReactNode } from 'react'

import { BoardLink } from '#/components/BoardLink'
import { UserMenu } from '#/components/UserMenu'
import { BrandMark, Icon, type IconName } from '#/lib/icons'
import { useBoard, useBoardId, useBoardViews, useBoards } from '#/lib/board-query'
import { fmtDate } from '#/lib/format'
import { initTheme, resolvedIsDark, setSearch, setTheme, uiStore } from '#/store/ui'

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

const NAV: Array<NavItem | { sep: true; label: string }> = [
  { id: 'board', label: 'Board', icon: 'board', to: '/', match: (p) => p === '/' },
  { id: 'agents', label: 'Agents', icon: 'agents', to: '/agents', match: (p) => p.startsWith('/agents'), count: (n) => n.agents },
  { sep: true, label: 'Plan' },
  { id: 'projects', label: 'Projects', icon: 'projects', to: '/projects', match: (p) => p.startsWith('/projects'), count: (n) => n.projects },
  { id: 'features', label: 'Features', icon: 'features', to: '/features', match: (p) => p.startsWith('/features'), count: (n) => n.features },
  { id: 'tasks', label: 'Tasks', icon: 'check', to: '/tasks', match: (p) => p.startsWith('/tasks') },
  { id: 'map', label: 'Map', icon: 'branch', to: '/map', match: (p) => p.startsWith('/map') },
  { id: 'design', label: 'Design', icon: 'layers', to: '/design', match: (p) => p.startsWith('/design') },
  { id: 'decisions', label: 'Decisions', icon: 'decisions', to: '/decisions', match: (p) => p.startsWith('/decisions'), count: (n) => n.decisions },
  { id: 'log', label: 'Log', icon: 'log', to: '/log', match: (p) => p.startsWith('/log'), count: (n) => n.log },
  { sep: true, label: 'Ops' },
  { id: 'ops', label: 'Accounts', icon: 'users', to: '/ops', match: (p) => p.startsWith('/ops') },
]

const SECTION_TITLE: Record<string, string> = {
  board: 'Board', agents: 'Agents', projects: 'Projects',
  features: 'Features', tasks: 'Tasks', map: 'Dependency map', design: 'System design',
  decisions: 'Decisions', log: 'Activity log',
  ops: 'Agent accounts', prod: 'Path to production', guide: 'Guide',
}

export function AppShell({ children }: { children: ReactNode }) {
  const m = useBoard()
  const boardId = useBoardId()
  const views = useBoardViews()
  const pathname = useRouterState({ select: (s) => s.location.pathname })
  const search = useStore(uiStore, (s) => s.search)

  // adaptive nav: keep enabled items + any separator that precedes ≥1 enabled item
  const visible = NAV.filter((n, i) => {
    if (!('sep' in n)) return views.includes(n.id)
    for (let j = i + 1; j < NAV.length; j++) {
      const next = NAV[j]
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

  const counts: NavCounts = {
    agents: m.runningAgents.length,
    projects: m.projects.length,
    features: m.active.length,
    decisions: m.decisions.length,
    log: m.log.length,
  }

  const activeItem =
    (NAV.find((n) => !('sep' in n) && (n as NavItem).match(sub)) as NavItem | undefined) ??
    (NAV[0] as NavItem)
  const section = activeItem?.id ?? 'board'

  let crumb = ''
  const projMatch = sub.match(/^\/projects\/(.+)$/)
  const featMatch = sub.match(/^\/features\/(.+)$/)
  if (projMatch) crumb = m.projById[decodeURIComponent(projMatch[1])]?.nama ?? 'Project'
  else if (featMatch) crumb = m.featById[decodeURIComponent(featMatch[1])]?.nama ?? 'Feature'
  const baseTitle = SECTION_TITLE[section] ?? 'Board'

  return (
    <div className="app">
      <aside className="sidebar">
        <Link to="/" className="brand" title="All boards">
          <BrandMark />
          <div>
            <div className="brand-name">{BRAND}</div>
            <div className="brand-sub">Agent work board</div>
          </div>
        </Link>

        <BoardSwitcher boardId={boardId} />

        <nav className="nav">
          {visible.map((n, i) =>
            'sep' in n ? (
              <div key={`sep-${i}`}>
                <div className="nav-sep" />
                <div className="nav-label">{n.label}</div>
              </div>
            ) : (
              <BoardLink key={n.id} to={n.to} className={`nav-item ${n.match(sub) ? 'active' : ''}`}>
                <Icon name={n.icon} size={17} className="nav-ico" />
                <span className="lbl">{n.label}</span>
                {n.count ? <span className="nav-count">{n.count(counts)}</span> : null}
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
        <div className="topbar">
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
              placeholder="Search features, agents…"
              autoComplete="off"
              aria-label="Search"
            />
          </div>
          <ThemeButton />
          <UserMenu />
        </div>
        <div className="content" id="view">
          {children}
        </div>
      </div>
    </div>
  )
}

function BoardSwitcher({ boardId }: { boardId: string }) {
  const boards = useBoards()
  const [open, setOpen] = useState(false)
  const current = boards.find((b) => b.id === boardId)
  return (
    <div className="switcher">
      <button className="switcher-btn" onClick={() => setOpen((v) => !v)} aria-haspopup="listbox" aria-expanded={open}>
        <Icon name="board" size={15} />
        <span className="switcher-name">{current?.name ?? boardId}</span>
        <Icon name="chevL" size={14} className="switcher-caret" />
      </button>
      {open ? (
        <div className="switcher-menu" role="listbox">
          {boards.map((b) => (
            <Link
              key={b.id}
              to="/b/$boardId"
              params={{ boardId: b.id }}
              className={`switcher-item ${b.id === boardId ? 'active' : ''}`}
              onClick={() => setOpen(false)}
            >
              <Icon name="board" size={14} />
              {b.name}
            </Link>
          ))}
          <div className="nav-sep" />
          <Link to="/" className="switcher-item" onClick={() => setOpen(false)}>
            <Icon name="layers" size={14} /> All boards
          </Link>
        </div>
      ) : null}
    </div>
  )
}

function ThemeButton() {
  useStore(uiStore, (s) => s.theme)
  const dark = resolvedIsDark()
  return (
    <button
      className="icon-btn"
      id="theme-btn"
      title="Toggle theme"
      aria-label="Toggle theme"
      onClick={() => setTheme(dark ? 'light' : 'dark')}
    >
      <Icon name={dark ? 'sun' : 'moon'} size={16} />
    </button>
  )
}
