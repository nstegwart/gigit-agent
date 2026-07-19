/**
 * Canon-v3 primary shell — route entry + AppShell isolation (LOCAL ONLY).
 * Proves: logged-in root → alur; boards escape hatch; CC index → alur;
 * classic index remains; alur layout excludes AppShell chrome; no redirect loop.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { wantsBoardPicker } from '#/routes/index'
import { isAlurBoardPath } from '#/routes/b.$boardId'
import { shouldRedirectBoardIndexToAlur } from '#/routes/b.$boardId.index'
import { DEFAULT_CONTROL_CENTER_BOARD_ID } from '#/lib/control-center-default-board'
import { isControlCenterBoard } from '#/lib/control-center-query'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

const indexSrc = readSrc('src/routes/index.tsx')
const boardLayoutSrc = readSrc('src/routes/b.$boardId.tsx')
const boardIndexSrc = readSrc('src/routes/b.$boardId.index.tsx')
const alurSrc = readSrc('src/routes/b.$boardId.alur.tsx')
const flowCss = readSrc('src/components/flow-ultimate/flow-ultimate.css')
const stylesCss = readSrc('src/styles.css')
const appShellSrc = readSrc('src/components/AppShell.tsx')

describe('canon-v3 primary shell — pure helpers', () => {
  it('pins default control center board as mfs-rebuild', () => {
    expect(DEFAULT_CONTROL_CENTER_BOARD_ID).toBe('mfs-rebuild')
    expect(isControlCenterBoard('mfs-rebuild')).toBe(true)
    expect(isControlCenterBoard('ibils')).toBe(false)
  })

  it('wantsBoardPicker only for explicit ?boards=1 escape hatch', () => {
    expect(wantsBoardPicker(undefined)).toBe(false)
    expect(wantsBoardPicker(null)).toBe(false)
    expect(wantsBoardPicker({})).toBe(false)
    expect(wantsBoardPicker({ boards: '0' })).toBe(false)
    expect(wantsBoardPicker({ boards: '1' })).toBe(true)
    expect(wantsBoardPicker({ boards: 1 })).toBe(true)
    expect(wantsBoardPicker({ boards: true })).toBe(true)
    expect(wantsBoardPicker({ boards: 'true' })).toBe(true)
  })

  it('shouldRedirectBoardIndexToAlur only for control-center boards', () => {
    expect(shouldRedirectBoardIndexToAlur('mfs-rebuild')).toBe(true)
    expect(shouldRedirectBoardIndexToAlur('ibils')).toBe(false)
    expect(shouldRedirectBoardIndexToAlur('other-board')).toBe(false)
  })

  it('isAlurBoardPath matches /b/$boardId/alur only', () => {
    expect(isAlurBoardPath('/b/mfs-rebuild/alur')).toBe(true)
    expect(isAlurBoardPath('/b/mfs-rebuild/alur/')).toBe(true)
    expect(isAlurBoardPath('/b/ibils/alur')).toBe(true)
    expect(isAlurBoardPath('/b/mfs-rebuild/')).toBe(false)
    expect(isAlurBoardPath('/b/mfs-rebuild')).toBe(false)
    expect(isAlurBoardPath('/b/mfs-rebuild/work')).toBe(false)
    expect(isAlurBoardPath('/b/mfs-rebuild/alur/extra')).toBe(false)
    expect(isAlurBoardPath('/alur')).toBe(false)
    expect(isAlurBoardPath('/')).toBe(false)
  })
})

describe('canon-v3 primary shell — logged-in root redirect', () => {
  it('authenticated default / redirects to /b/$boardId/alur (not bare board index)', () => {
    expect(indexSrc).toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    expect(indexSrc).toMatch(/DEFAULT_CONTROL_CENTER_BOARD_ID/)
    // Must not still target bare board overview as default
    expect(indexSrc).not.toMatch(
      /throw redirect\(\{\s*to:\s*['"]\/b\/\$boardId['"]/,
    )
  })

  it('preserves auth fence to /login when unauthenticated', () => {
    expect(indexSrc).toMatch(/if\s*\(\s*!context\.me\s*\)\s*throw redirect\(\{\s*to:\s*['"]\/login['"]/)
  })

  it('preserves ?boards=1 board picker escape hatch', () => {
    expect(indexSrc).toMatch(/wantsBoardPicker/)
    expect(indexSrc).toMatch(/boards === '1'/)
    // Picker surface still renders Home when escape hatch active
    expect(indexSrc).toMatch(/component:\s*Home/)
    expect(indexSrc).toMatch(/className="home"/)
    expect(indexSrc).toMatch(/Boards/)
  })
})

describe('canon-v3 primary shell — control-center index redirect', () => {
  it('CC board index redirects to alur', () => {
    expect(boardIndexSrc).toMatch(/shouldRedirectBoardIndexToAlur/)
    expect(boardIndexSrc).toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    expect(boardIndexSrc).toMatch(/isControlCenterBoard/)
  })

  it('does not render ControlCenter Overview as primary on board index', () => {
    // Primary path is redirect/Navigate to alur — no Overview mount component
    expect(boardIndexSrc).not.toMatch(/ControlCenterOverview/)
    expect(boardIndexSrc).not.toMatch(/control-center-overview-route/)
    expect(boardIndexSrc).not.toMatch(/return\s+<\s*Overview\b/)
    expect(boardIndexSrc).not.toMatch(/<\s*Overview\s/)
    // Pure helper may remain for unit tests; must not be the route component
    expect(boardIndexSrc).toMatch(/component:\s*View/)
    expect(boardIndexSrc).toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
  })

  it('classic / non-control-center index remains BoardHome', () => {
    expect(boardIndexSrc).toMatch(/function BoardHome/)
    expect(boardIndexSrc).toMatch(/data-testid="board-smoke"/)
    expect(boardIndexSrc).toMatch(/KpiStrip/)
    expect(boardIndexSrc).toMatch(/ActivityFeed/)
  })
})

describe('canon-v3 primary shell — alur layout excludes AppShell', () => {
  it('board layout skips AppShell on alur path and renders Outlet host', () => {
    expect(boardLayoutSrc).toMatch(/isAlurBoardPath/)
    expect(boardLayoutSrc).toMatch(/alur-primary-shell/)
    expect(boardLayoutSrc).toMatch(/data-testid="alur-primary-shell"/)
    expect(boardLayoutSrc).toMatch(/data-shell="alur"/)
    // Conditional: AppShell only when not alur
    expect(boardLayoutSrc).toMatch(/if\s*\(\s*isAlurBoardPath\(pathname\)\s*\)/)
    expect(boardLayoutSrc).toMatch(/<AppShell>/)
    expect(boardLayoutSrc).toMatch(/<Outlet\s*\/>/)
  })

  it('alur primary host does not import or nest AppShell chrome selectors in route', () => {
    // Alur page itself never mounts AppShell
    expect(alurSrc).not.toMatch(/AppShell/)
    expect(alurSrc).not.toMatch(/CommandSearch/)
    expect(alurSrc).not.toMatch(/CONTROL_CENTER_NAV/)
    expect(alurSrc).toMatch(/FlowUltimateScreen/)
    expect(alurSrc).toMatch(/getFlowDataBundleFn/)
    expect(alurSrc).toMatch(/data-page['"]?\s*,\s*['"]alur['"]/)
  })

  it('AppShell still owns classic chrome (sidebar/topbar/search) for non-alur', () => {
    expect(appShellSrc).toMatch(/export function AppShell/)
    expect(appShellSrc).toMatch(/CommandSearch/)
    expect(appShellSrc).toMatch(/CONTROL_CENTER_NAV|const NAV/)
    expect(boardLayoutSrc).toMatch(/import \{ AppShell \}/)
  })

  it('flow CSS scopes full viewport + dark canon to alur only', () => {
    // Layout / shell geometry remain module concerns
    expect(flowCss).toMatch(/100dvh/)
    expect(flowCss).toMatch(/100vw/)
    expect(flowCss).toMatch(/html\[data-page=['"]alur['"]\]/)
    expect(flowCss).toMatch(/\.alur-primary-shell/)
    // Dark canon --bg lives on the sanctioned host (styles.css), scoped to alur only
    expect(stylesCss).toMatch(
      /html\[data-page=['"]alur['"]\][\s\S]*?--bg:\s*#0d1017/,
    )
    // Module must not redeclare raw dark --bg (lint host/module split)
    expect(flowCss).not.toMatch(/--bg:\s*#0d1017/)
    // Must not claim global body rewrite without data-page guard
    expect(stylesCss).not.toMatch(/^body\s*\{[^}]*--bg:\s*#0d1017/m)
    expect(flowCss).not.toMatch(/^body\s*\{[^}]*--bg:\s*#0d1017/m)
  })

  it('preserves localStorage key and data loader (no second V2 screen)', () => {
    const typesSrc = readSrc('src/components/flow-ultimate/types.ts')
    const graphSrc = readSrc('src/components/flow-ultimate/graph.ts')
    expect(typesSrc).toMatch(/STORAGE_KEY\s*=\s*['"]cairn-flow-pos-v1['"]/)
    expect(graphSrc).toMatch(/STORAGE_KEY/)
    expect(alurSrc).toMatch(/getFlowDataBundleFn/)
    expect(alurSrc).toMatch(/FlowUltimateScreen/)
    // Must not introduce a parallel vanilla flow.js port in routes
    expect(alurSrc).not.toMatch(/flow\.js/)
    expect(alurSrc).not.toMatch(/FlowV2|flow-v2|VanillaFlow/)
  })
})

describe('canon-v3 primary shell — no redirect loop', () => {
  it('alur route does not redirect to / or board index', () => {
    expect(alurSrc).not.toMatch(/throw redirect/)
    expect(alurSrc).not.toMatch(/Navigate/)
    expect(alurSrc).not.toMatch(/to:\s*['"]\/['"]/)
    expect(alurSrc).not.toMatch(/to:\s*['"]\/b\/\$boardId['"]/)
  })

  it('root and CC index redirect targets land on alur, which is terminal', () => {
    // Root → alur
    expect(indexSrc).toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    // Index → alur
    expect(boardIndexSrc).toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
    // Alur path is shell-less terminal (renders screen, no further redirect)
    expect(alurSrc).toMatch(/createFileRoute\(['"]\/b\/\$boardId\/alur['"]\)/)
    expect(alurSrc).toMatch(/component:\s*AlurView/)
    expect(isAlurBoardPath('/b/mfs-rebuild/alur')).toBe(true)
    // Terminal: isAlurBoardPath true means layout does not re-enter index redirect
    expect(shouldRedirectBoardIndexToAlur('mfs-rebuild')).toBe(true)
    // But alur is not the index path — no loop between index↔alur when already on alur
    expect(isAlurBoardPath('/b/mfs-rebuild/')).toBe(false)
  })

  it('board layout auth fence remains (login) without looping to alur', () => {
    expect(boardLayoutSrc).toMatch(/if\s*\(\s*!context\.me\s*\)\s*throw redirect\(\{\s*to:\s*['"]\/login['"]/)
    // Layout itself does not redirect to alur (only skips shell)
    expect(boardLayoutSrc).not.toMatch(/to:\s*['"]\/b\/\$boardId\/alur['"]/)
  })
})

describe('canon-v3 primary shell — static selector inventory', () => {
  it('proves old shell chrome classes exist only in AppShell, not alur route tree for primary', () => {
    // AppShell owns these
    expect(appShellSrc).toMatch(/className="sidebar"/)
    expect(appShellSrc).toMatch(/className="topbar"/)
    // Alur route file has none of the nine-IA / search chrome
    expect(alurSrc).not.toMatch(/#page-title/)
    expect(alurSrc).not.toMatch(/switcher-btn/)
    expect(alurSrc).not.toMatch(/nav-item/)
    expect(alurSrc).not.toMatch(/className="sidebar"/)
    expect(alurSrc).not.toMatch(/className="topbar"/)
    // Board layout alur branch has shell-less host, no AppShell chrome markup
    const alurBranch = boardLayoutSrc.slice(
      boardLayoutSrc.indexOf('if (isAlurBoardPath'),
      boardLayoutSrc.indexOf('<AppShell>'),
    )
    expect(alurBranch).toMatch(/alur-primary-shell/)
    expect(alurBranch).toMatch(/<Outlet/)
    expect(alurBranch).not.toMatch(/className="sidebar"/)
    expect(alurBranch).not.toMatch(/className="topbar"/)
    expect(alurBranch).not.toMatch(/CommandSearch/)
    expect(alurBranch).not.toMatch(/<AppShell/)
  })
})
