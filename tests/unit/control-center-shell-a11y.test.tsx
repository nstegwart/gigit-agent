/**
 * C3-R1B shell / mobile / a11y contract regressions.
 * Support evidence only (LOCAL ONLY) — not real-browser visual DONE.
 *
 * Covers: accessible names, CC nav order, mobile 44×44 target CSS contract,
 * document title/lang, secondary-text contrast tokens, legacy adaptive nav
 * compatibility, reduced-motion + focus-ring presence.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import { CONTROL_CENTER_NAV_LABELS } from '#/components/AppShell'
import { CONTROL_CENTER_PRIMARY_NAV_IDS } from '#/lib/control-center-query'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const appShellSrc = readFileSync(
  join(root, 'src/components/AppShell.tsx'),
  'utf8',
)
const stylesSrc = readFileSync(join(root, 'src/styles.css'), 'utf8')
const rootRouteSrc = readFileSync(join(root, 'src/routes/__root.tsx'), 'utf8')

/** Nine primary IA labels (UI_CONTRACT §2) — CONTROL_CENTER_NAV_LABELS export. */
const EXPECTED_CC_LABELS = [
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

/**
 * Live CONTROL_CENTER_NAV order after W-UI-1: Rebuild sits after Overview/Ringkasan
 * (SPEC-TM-KOMPAT-VISUAL-V1 §3.A / §4.6). Export CONTROL_CENTER_NAV_LABELS stays 9.
 */
const EXPECTED_CC_NAV_MARKUP_LABELS = [
  'Overview',
  'Rebuild',
  'Work',
  'Priority',
  'Projects',
  'Features / Flows',
  'Agents / Runs',
  'Ops / Accounts',
  'Decisions',
  'Evidence / Audit',
] as const

describe('control-center shell a11y — nav order + names', () => {
  it('exports the exact nine IA labels in UI_CONTRACT order', () => {
    expect([...CONTROL_CENTER_NAV_LABELS]).toEqual([...EXPECTED_CC_LABELS])
    expect(CONTROL_CENTER_NAV_LABELS).toHaveLength(9)
    expect(CONTROL_CENTER_PRIMARY_NAV_IDS).toHaveLength(9)
  })

  it('CONTROL_CENTER_NAV markup includes each primary label exactly once in order', () => {
    // Slice the control-center nav array body (between export const CONTROL_CENTER_NAV_LABELS
    // and SECTION_TITLE) and assert label order by source scan.
    const start = appShellSrc.indexOf('const CONTROL_CENTER_NAV:')
    const end = appShellSrc.indexOf('const SECTION_TITLE:')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const body = appShellSrc.slice(start, end)
    const labelRe = /label:\s*'([^']+)'/g
    const labels: string[] = []
    let m: RegExpExecArray | null
    while ((m = labelRe.exec(body))) {
      // Skip separator labels in either supported locale.
      if (['Structure', 'Ops', 'Struktur', 'Operasi'].includes(m[1])) continue
      labels.push(m[1])
    }
    expect(labels).toEqual([...EXPECTED_CC_NAV_MARKUP_LABELS])
  })

  it('nav BoardLink always sets aria-label from the item label (mobile icon-only name)', () => {
    expect(appShellSrc).toMatch(/aria-label=\{n\.label\}/)
    expect(appShellSrc).toMatch(/data-nav-id=\{n\.id\}/)
  })

  it('CC boards use pinned overview/features envelope counts (not only boardQuery model)', () => {
    expect(appShellSrc).toMatch(/overviewQueryOptions/)
    expect(appShellSrc).toMatch(/featuresQueryOptions/)
    expect(appShellSrc).toMatch(/decisionCount/)
    expect(appShellSrc).toMatch(/ongoing/)
    // Legacy path still present for non-CC boards.
    expect(appShellSrc).toMatch(/m\.runningAgents\.length/)
    expect(appShellSrc).toMatch(/m\.decisions\.length/)
  })

  it('main scroll landmark is named and keyboard-focusable', () => {
    expect(appShellSrc).toMatch(/id="view"/)
    expect(appShellSrc).toMatch(/<main/)
    expect(appShellSrc).toMatch(/aria-label="Main content"/)
    expect(appShellSrc).toMatch(/tabIndex=\{0\}/)
  })

  it('does not expose an incomplete dark-theme control', () => {
    expect(appShellSrc).not.toMatch(/id="theme-btn"/)
    expect(appShellSrc).not.toMatch(/Switch to dark theme/)
    expect(appShellSrc).not.toMatch(/setTheme\(/)
  })

  it('board switcher button has aria-label including current board name', () => {
    expect(appShellSrc).toMatch(
      /aria-label=\{`Switch board, current: \$\{boardName\}`\}/,
    )
  })

  it('brand link has an accessible name', () => {
    expect(appShellSrc).toMatch(/aria-label=\{`\$\{BRAND\} — all boards`\}/)
  })
})

describe('control-center shell a11y — mobile target sizing contract', () => {
  it('C3-C12: shell grid uses minmax(0,1fr) and .main min-width:0 (no 424px min-content track)', () => {
    // Desktop + mobile must not allow grid/flex min-content to expand past viewport.
    expect(stylesSrc).toMatch(
      /\.app\s*\{[^}]*grid-template-columns:\s*250px\s+minmax\(0,\s*1fr\)/s,
    )
    expect(stylesSrc).toMatch(/\.main\s*\{[^}]*min-width:\s*0/s)
    const mobileBlock = extractMediaBlock(stylesSrc, 'max-width: 900px')
    expect(mobileBlock).toBeTruthy()
    expect(mobileBlock!).toMatch(
      /\.app\s*\{[^}]*grid-template-columns:\s*minmax\(0,\s*1fr\)/s,
    )
    expect(mobileBlock!).toMatch(/\.main\s*\{[^}]*min-width:\s*0/s)
    // html/body hard bound
    expect(stylesSrc).toMatch(/html,\s*body\s*\{[^}]*overflow-x:\s*clip/s)
  })

  it('≤900px shell nav items declare min 44×44 CSS px', () => {
    const mobileBlock = extractMediaBlock(stylesSrc, 'max-width: 900px')
    expect(mobileBlock).toBeTruthy()
    // nav-item box
    expect(mobileBlock!).toMatch(/\.nav-item\s*\{[^}]*min-width:\s*44px/s)
    expect(mobileBlock!).toMatch(/\.nav-item\s*\{[^}]*min-height:\s*44px/s)
    // icon-btn (theme)
    expect(mobileBlock!).toMatch(/\.icon-btn\s*\{[^}]*min-width:\s*44px/s)
    expect(mobileBlock!).toMatch(/\.icon-btn\s*\{[^}]*min-height:\s*44px/s)
    // switcher + usermenu
    expect(mobileBlock!).toMatch(/\.switcher-btn\s*\{[^}]*min-height:\s*44px/s)
    expect(mobileBlock!).toMatch(/\.usermenu-btn\s*\{[^}]*min-height:\s*44px/s)
  })

  it('usermenu-btn mobile 44px wins cascade after base min-height:36 (C3-R3A)', () => {
    // Probe c3-r2-preintegration: Ssynth…admin button was 247×37 because base
    // .usermenu-btn { min-height:36 } lived AFTER the shell ≤900 media block.
    const baseMatch = /\.usermenu-btn\s*\{[^}]*min-height:\s*36px[^}]*\}/.exec(
      stylesSrc,
    )
    expect(baseMatch, 'desktop base .usermenu-btn min-height:36').toBeTruthy()
    const baseEnd = baseMatch!.index + baseMatch![0].length
    const afterBase = stylesSrc.slice(baseEnd)
    const mediaAfter = afterBase.match(
      /@media\s*\(\s*max-width:\s*900px\s*\)\s*\{[\s\S]*?\.usermenu-btn\s*\{([^}]+)\}/,
    )
    expect(
      mediaAfter?.[1],
      'mobile usermenu rule must appear AFTER base .usermenu-btn',
    ).toBeTruthy()
    expect(mediaAfter![1]).toMatch(/min-height:\s*44px/)
  })

  it('mobile does not display:none nav labels (keeps accessible name source)', () => {
    const mobileBlock = extractMediaBlock(stylesSrc, 'max-width: 900px')
    expect(mobileBlock).toBeTruthy()
    // Forbidden pattern that caused link-name axe fails
    expect(mobileBlock!).not.toMatch(
      /\.nav-item\s+span\.lbl\s*\{\s*display:\s*none/,
    )
    expect(mobileBlock!).not.toMatch(
      /\.nav-item\s+\.lbl\s*\{\s*display:\s*none/,
    )
    // Clip / visually-hidden contract instead
    expect(mobileBlock!).toMatch(
      /\.nav-item\s+\.lbl\s*\{[^}]*clip:\s*rect\(0,\s*0,\s*0,\s*0\)/s,
    )
  })

  it('mobile shell uses stacked chrome + horizontal nav (not single cramped row)', () => {
    const mobileBlock = extractMediaBlock(stylesSrc, 'max-width: 900px')
    expect(mobileBlock!).toMatch(/\.sidebar\s*\{[^}]*flex-direction:\s*column/s)
    expect(mobileBlock!).toMatch(
      /\.sidebar-chrome\s*\{[^}]*flex-direction:\s*row/s,
    )
    expect(mobileBlock!).toMatch(/\.nav\s*\{[^}]*flex-direction:\s*row/s)
    expect(mobileBlock!).toMatch(/\.nav\s*\{[^}]*overflow-x:\s*auto/s)
  })
})

describe('control-center shell a11y — contrast tokens (shell chrome)', () => {
  it('brand-sub / nav-label / sidebar-foot use --text-dim (AA) not --text-faint', () => {
    // Extract only the app-shell secondary text rules (before KPI strip)
    const shellSlice = stylesSrc.slice(
      stylesSrc.indexOf('/* ---------- app shell ---------- */'),
      stylesSrc.indexOf('/* ---------- KPI strip ---------- */'),
    )
    expect(shellSlice).toMatch(
      /\.brand-sub\s*\{[^}]*color:\s*var\(--text-dim\)/s,
    )
    expect(shellSlice).toMatch(
      /\.nav-label\s*\{[^}]*color:\s*var\(--text-dim\)/s,
    )
    expect(shellSlice).toMatch(
      /\.sidebar-foot\s*\{[^}]*color:\s*var\(--text-dim\)/s,
    )
    expect(shellSlice).not.toMatch(
      /\.brand-sub\s*\{[^}]*color:\s*var\(--text-faint\)/s,
    )
    expect(shellSlice).not.toMatch(
      /\.nav-label\s*\{[^}]*color:\s*var\(--text-faint\)/s,
    )
    expect(shellSlice).not.toMatch(
      /\.sidebar-foot\s*\{[^}]*color:\s*var\(--text-faint\)/s,
    )
  })

  it('light --text-dim contrast on white meets WCAG AA (≥4.5)', () => {
    // Token value from :root in styles.css
    const m = stylesSrc.match(/:root\s*\{[^}]*--text-dim:\s*(#[0-9a-fA-F]{6})/s)
    expect(m?.[1]).toBeTruthy()
    const ratio = contrastRatio(m![1], '#ffffff')
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })
})

describe('document title + html lang', () => {
  it('root document sets lang="id"', () => {
    expect(rootRouteSrc).toMatch(/<html\s+lang="id">/)
  })

  it('root head meta includes a meaningful non-empty title', () => {
    expect(rootRouteSrc).toMatch(
      /\{\s*title:\s*'Cairn — papan kerja agen'\s*\}/,
    )
  })
})

describe('legacy adaptive nav compatibility (non-CC boards)', () => {
  it('keeps classic NAV entries (Board/Agents/…/Log/Accounts) for adaptive filter', () => {
    const start = appShellSrc.indexOf('const NAV:')
    const end = appShellSrc.indexOf('export const CONTROL_CENTER_NAV_LABELS')
    expect(start).toBeGreaterThan(-1)
    expect(end).toBeGreaterThan(start)
    const classic = appShellSrc.slice(start, end)
    for (const id of [
      'board',
      'agents',
      'projects',
      'features',
      'tasks',
      'map',
      'design',
      'decisions',
      'log',
      'ops',
    ]) {
      expect(classic).toContain(`id: '${id}'`)
    }
  })

  it('control-center boards force full nine nav; others filter by views', () => {
    expect(appShellSrc).toMatch(
      /const controlCenter = isControlCenterBoard\(boardId\)/,
    )
    expect(appShellSrc).toMatch(/const visible = controlCenter/)
    expect(appShellSrc).toMatch(/\? navSource/)
    expect(appShellSrc).toMatch(/navSource\.filter\(/)
  })

  it('legacy drill-down paths remain in SECTION_TITLE (tasks/map/design/log)', () => {
    for (const key of [
      'tasks',
      'map',
      'design',
      'log',
      'evidence',
      'overview',
      'work',
      'priority',
    ]) {
      expect(appShellSrc).toMatch(new RegExp(`${key}:\\s*'`))
    }
  })
})

describe('focus + reduced motion shell contracts', () => {
  it('declares focus-visible ring for shell interactive controls', () => {
    expect(stylesSrc).toMatch(/\.nav-item:focus-visible/)
    expect(stylesSrc).toMatch(/\.icon-btn:focus-visible/)
    expect(stylesSrc).toMatch(/\.switcher-btn:focus-visible/)
    expect(stylesSrc).toMatch(
      /0 0 0 2px var\(--surface\),\s*\n?\s*0 0 0 4px var\(--focus-ring\)/,
    )
  })

  it('honors prefers-reduced-motion for shell transitions', () => {
    expect(stylesSrc).toMatch(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/,
    )
    const block = extractMediaBlock(stylesSrc, 'prefers-reduced-motion: reduce')
    expect(block).toBeTruthy()
    expect(block!).toMatch(/\.nav-item/)
    expect(block!).toMatch(/transition:\s*none/)
  })
})

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function extractMediaBlock(css: string, queryFragment: string): string | null {
  const idx = css.indexOf(`@media (${queryFragment})`)
  if (idx < 0) {
    // tolerate spacing variants
    const re = new RegExp(
      `@media\\s*\\(\\s*${queryFragment.replace(/[.*+?^${}()|[\]\\]/g, '\\$&').replace(/:\s*/g, ':\\s*')}\\s*\\)`,
    )
    const m = re.exec(css)
    if (!m) return null
    return sliceBalanced(css, m.index + m[0].length)
  }
  return sliceBalanced(css, idx + `@media (${queryFragment})`.length)
}

function sliceBalanced(css: string, from: number): string {
  let i = from
  while (i < css.length && css[i] !== '{') i++
  if (css[i] !== '{') return ''
  let depth = 0
  const start = i
  for (; i < css.length; i++) {
    if (css[i] === '{') depth++
    else if (css[i] === '}') {
      depth--
      if (depth === 0) return css.slice(start, i + 1)
    }
  }
  return css.slice(start)
}

function relativeLuminance(hex: string): number {
  const c = hex.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16) / 255
  const g = parseInt(c.slice(2, 4), 16) / 255
  const b = parseInt(c.slice(4, 6), 16) / 255
  const f = (x: number) =>
    x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4)
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}
