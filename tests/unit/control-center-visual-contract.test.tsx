/**
 * C3-R2A visual / contrast / a11y style contracts.
 * Support evidence only (LOCAL ONLY) — not authenticated browser/axe DONE.
 *
 * Asserts class/markup/token invariants for shell + primary CC modules.
 * Contrast ratios for dark canon V3 semantic tokens are computed from styles.css
 * with a real relative-luminance function (not hand-typed PASS).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const stylesSrc = readFileSync(join(root, 'src/styles.css'), 'utf8')
const appShellSrc = readFileSync(
  join(root, 'src/components/AppShell.tsx'),
  'utf8',
)
const userMenuSrc = readFileSync(
  join(root, 'src/components/UserMenu.tsx'),
  'utf8',
)
const tasksTableSrc = readFileSync(
  join(root, 'src/components/TasksTable.tsx'),
  'utf8',
)
const featuresTableSrc = readFileSync(
  join(root, 'src/components/FeaturesTable.tsx'),
  'utf8',
)
const decisionsCss = readFileSync(
  join(root, 'src/components/control-center/decisions/decisions.module.css'),
  'utf8',
)
const priorityCss = readFileSync(
  join(root, 'src/components/control-center/priority/priority.module.css'),
  'utf8',
)
const overviewCss = readFileSync(
  join(root, 'src/components/control-center/overview/overview.module.css'),
  'utf8',
)
const workCss = readFileSync(
  join(root, 'src/components/control-center/work/work.module.css'),
  'utf8',
)
const workStatesSrc = readFileSync(
  join(root, 'src/components/control-center/work/WorkStates.tsx'),
  'utf8',
)
const decisionsScreenSrc = readFileSync(
  join(root, 'src/components/control-center/decisions/DecisionsScreen.tsx'),
  'utf8',
)

/** Extract dark-canon :root token block only (before the dark-canon lock). */
function darkRootBlock(css: string): string {
  const start = css.indexOf(':root {')
  const lock = css.indexOf(':root[data-theme="light"]')
  expect(start).toBeGreaterThan(-1)
  expect(lock).toBeGreaterThan(start)
  return css.slice(start, lock)
}

function tokenHex(block: string, name: string): string {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{6})`)
  const m = block.match(re)
  expect(m?.[1], `missing token --${name}`).toBeTruthy()
  return m![1]
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

/** Dark canon fixed surfaces (must match styles.css :root). */
const CANVAS = '#0d1017'
const SURFACE = '#12161e'

/** Approx soft tint: FG @ 14% over --surface (matches dark -bg rgba chips). */
function softOnSurface(fg: string, alpha = 0.14): string {
  const parse = (hex: string) => {
    const c = hex.replace('#', '')
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
  }
  const cf = parse(fg)
  const cs = parse(SURFACE)
  const mix = (i: number) => Math.round(cs[i] * (1 - alpha) + cf[i] * alpha)
  return (
    '#' +
    [mix(0), mix(1), mix(2)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  )
}

describe('C3-R2A dark canon semantic tokens — computed AA (≥4.5:1)', () => {
  const dark = darkRootBlock(stylesSrc)
  /*
   * Dark canon V3 dual tokens (owner 2026-07-19 global dark):
   *   --ok/--warn/… vibrant canon values double as measured AA text FG on
   *   dark panels, so --ok-fg/--warn-fg/… alias the same values.
   * text-faint is body tertiary (AA on canvas + surface); text-tertiary is
   * decorative canon t3 and intentionally not AA-gated.
   */
  const tokens = {
    accent: tokenHex(dark, 'accent-fg'),
    ok: tokenHex(dark, 'ok-fg'),
    blocked: tokenHex(dark, 'blocked-fg'),
    warn: tokenHex(dark, 'warn-fg'),
    info: tokenHex(dark, 'info-fg'),
    done: tokenHex(dark, 'done-fg'),
    textFaint: tokenHex(dark, 'text-faint'),
  } as const

  it.each(Object.entries(tokens))('%s on canvas ≥ 4.5:1', (_name, fg) => {
    const ratio = contrastRatio(fg, CANVAS)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it.each(Object.entries(tokens))('%s on surface ≥ 4.5:1', (_name, fg) => {
    const ratio = contrastRatio(fg, SURFACE)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['accent', 'ok', 'blocked', 'warn', 'info', 'done'] as const)(
    '%s on soft-14% tint ≥ 4.5:1',
    (name) => {
      const fg = tokens[name]
      const soft = softOnSurface(fg, 0.14)
      const ratio = contrastRatio(fg, soft)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('does not regress to the retired light palette in dark :root', () => {
    // Owner 2026-07-19: light Direction B is retired; dark canon V3 only.
    expect(dark).not.toMatch(/--bg:\s*#fafafa/)
    expect(dark).not.toMatch(/--surface:\s*#ffffff/)
    expect(dark).not.toMatch(/--text:\s*#0a0a0a/)
    expect(dark).not.toMatch(/--accent:\s*#0070f3/)
    expect(dark).not.toMatch(/--ok:\s*#16a34a/)
    expect(dark).not.toMatch(/--blocked:\s*#dc2626/)
    expect(dark).not.toMatch(/--warn:\s*#d97706/)
    // Faint tertiary must not regress to Direction-B #999 (not AA on dark either).
    expect(dark).not.toMatch(/--text-faint:\s*#999999/)
    expect(dark).toMatch(/color-scheme:\s*dark/)
  })

  it('keeps canon vibrant fill tokens alongside AA -fg text tokens', () => {
    expect(tokenHex(dark, 'bg').toLowerCase()).toBe('#0d1017')
    expect(tokenHex(dark, 'surface').toLowerCase()).toBe('#12161e')
    expect(tokenHex(dark, 'text').toLowerCase()).toBe('#e8edf3')
    expect(tokenHex(dark, 'ok').toLowerCase()).toBe('#35c479')
    expect(tokenHex(dark, 'warn').toLowerCase()).toBe('#e5a54b')
    expect(tokenHex(dark, 'blocked').toLowerCase()).toBe('#e8635f')
    expect(tokenHex(dark, 'accent').toLowerCase()).toBe('#5b9dff')
    expect(tokenHex(dark, 'ok-fg').toLowerCase()).toBe('#35c479')
    expect(tokenHex(dark, 'warn-fg').toLowerCase()).toBe('#e5a54b')
    expect(tokenHex(dark, 'blocked-fg').toLowerCase()).toBe('#e8635f')
  })

  it('chip-admin uses accent color on soft (token path)', () => {
    // Text on soft tint must use AA accent-fg (not vibrant fill --accent).
    expect(stylesSrc).toMatch(
      /\.chip-admin\s*\{[^}]*color:\s*var\(--accent-fg\)/s,
    )
  })
})

/**
 * W-TOKEN-2: screen AA hard-locals are token aliases (var(--*-fg)), never raw hex
 * and never vibrant fill tokens (var(--blocked) vs var(--blocked-fg)). Soft-chip
 * darker FG uses color-mix(blocked-fg, text) so AA ≥4.5:1 holds without residual hex.
 */
function mixHex(a: string, b: string, pctA: number): string {
  const parse = (hex: string) => {
    const c = hex.replace('#', '')
    return [0, 2, 4].map((i) => parseInt(c.slice(i, i + 2), 16))
  }
  const ca = parse(a)
  const cb = parse(b)
  const mix = ca.map((ch, i) => Math.round(ch * pctA + cb[i] * (1 - pctA)))
  return (
    '#' +
    mix.map((n) => n.toString(16).padStart(2, '0')).join('')
  )
}

describe('C3-R2A module AA hard-locals (no var pass-through trap)', () => {
  it('decisions module aliases blocked/ok/warn/info/accent AA tokens (not vibrant fills)', () => {
    expect(decisionsCss).toMatch(/--dec-blocked:\s*var\(--blocked-fg\)/)
    expect(decisionsCss).toMatch(/--dec-ok:\s*var\(--ok-fg\)/)
    expect(decisionsCss).toMatch(/--dec-warn:\s*var\(--warn-fg\)/)
    expect(decisionsCss).toMatch(/--dec-info:\s*var\(--info-fg\)/)
    expect(decisionsCss).toMatch(/--dec-accent:\s*var\(--accent-fg\)/)
    // Forbidden: vibrant fill pass-through (must use -fg, not bare --blocked).
    expect(decisionsCss).not.toMatch(/--dec-blocked:\s*var\(--blocked\)\s*;/)
  })

  it('priority module aliases semantic AA tokens (not vibrant fills)', () => {
    expect(priorityCss).toMatch(/--pr-blocked:\s*var\(--blocked-fg\)/)
    expect(priorityCss).toMatch(/--pr-ok:\s*var\(--ok-fg\)/)
    expect(priorityCss).toMatch(/--pr-warn:\s*var\(--warn-fg\)/)
    expect(priorityCss).toMatch(/--pr-accent:\s*var\(--accent-fg\)/)
    expect(priorityCss).not.toMatch(/--pr-blocked:\s*var\(--blocked\)\s*;/)
  })

  it('overview/work modules declare local AA semantic token aliases', () => {
    expect(overviewCss).toMatch(/--cc-blocked:\s*var\(--blocked-fg\)/)
    expect(overviewCss).toMatch(/--cc-ok:\s*var\(--ok-fg\)/)
    expect(workCss).toMatch(/--wk-blocked:\s*var\(--blocked-fg\)/)
    expect(workCss).toMatch(/--wk-done:\s*var\(--done-fg\)/)
  })

  it('badgeBlocked uses token mix toward --text that AA-passes dark soft tint', () => {
    // Historical root defect (light era): #c62828 on #eedde0 = 4.29 (axe fail).
    // Local alias uses --blocked-fg; badge text mixes toward --text, which on
    // dark canon LIGHTENS the red and keeps AA on the 14% soft tint.
    expect(workCss).toMatch(/--wk-blocked:\s*var\(--blocked-fg\)/)
    const badge = workCss.match(/\.badgeBlocked\s*\{([^}]+)\}/)
    expect(badge?.[1]).toBeTruthy()
    expect(badge![1]).toMatch(
      /color:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--blocked-fg\)\s+75%\s*,\s*var\(--text\)\s*\)/,
    )
    // Resolve mix against live global token values from styles.css dark :root.
    const dark = darkRootBlock(stylesSrc)
    const blockedFg = tokenHex(dark, 'blocked-fg')
    const text = tokenHex(dark, 'text')
    const fg = mixHex(blockedFg, text, 0.75)
    const measuredSoft = softOnSurface(tokenHex(dark, 'blocked'), 0.14)
    const ratio = contrastRatio(fg, measuredSoft)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(fg.toLowerCase()).not.toBe(blockedFg.toLowerCase())
  })

  it('summaryChipBlocking uses token mix toward --text that AA-passes dark soft tint', () => {
    // Historical root defect (light era): #c62828 on #f1dfe1 = 4.38
    // (decisions-blocking-count axe). Documented pair stays failing below.
    expect(decisionsCss).toMatch(/--dec-blocked:\s*var\(--blocked-fg\)/)
    const chip = decisionsCss.match(/\.summaryChipBlocking\s*\{([^}]+)\}/)
    expect(chip?.[1]).toBeTruthy()
    expect(chip![1]).toMatch(
      /color:\s*color-mix\(\s*in\s+srgb\s*,\s*var\(--blocked-fg\)\s+75%\s*,\s*var\(--text\)\s*\)/,
    )
    const dark = darkRootBlock(stylesSrc)
    const blockedFg = tokenHex(dark, 'blocked-fg')
    const text = tokenHex(dark, 'text')
    const fg = mixHex(blockedFg, text, 0.75)
    const measuredSoft = softOnSurface(tokenHex(dark, 'blocked'), 0.14)
    const ratio = contrastRatio(fg, measuredSoft)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(fg.toLowerCase()).not.toBe(blockedFg.toLowerCase())
    // Historical light-era defect pair must remain failing (documents the defect)
    expect(contrastRatio('#c62828', '#f1dfe1')).toBeLessThan(4.5)
  })
})

describe('C3-R2A shell scroll + legacy table a11y markup', () => {
  it('main content region is named + keyboard focusable', () => {
    expect(appShellSrc).toMatch(/id="view"/)
    expect(appShellSrc).toMatch(/<main/)
    expect(appShellSrc).toMatch(/aria-label="Main content"/)
    expect(appShellSrc).toMatch(/tabIndex=\{0\}/)
  })

  it('TasksTable selects have accessible names', () => {
    // id-ID primary chrome (i18n); keep EN alternates if a future string flip lands.
    expect(tasksTableSrc).toMatch(
      /aria-label="(?:Filter fitur kontrak|Filter by feature capability)"/,
    )
    expect(tasksTableSrc).toMatch(
      /aria-label="(?:Filter gate berikutnya|Filter by next gate)"/,
    )
  })

  it('TasksTable / FeaturesTable horizontal scrollports are focusable regions', () => {
    // TasksTable uses ui Table with named region; FeaturesTable retains table-scroll.
    expect(tasksTableSrc).toMatch(
      /aria-label="(?:Tabel tugas|Tasks table)"/,
    )
    expect(tasksTableSrc).toMatch(/tabIndex=\{0\}/)
    expect(featuresTableSrc).toMatch(/className="table-scroll"/)
    expect(featuresTableSrc).toMatch(/aria-label="Features table"/)
    expect(featuresTableSrc).toMatch(/tabIndex=\{0\}/)
    expect(stylesSrc).toMatch(/\.table-scroll\s*\{/)
  })

  it('UserMenu exposes full account name via aria-label/title', () => {
    expect(userMenuSrc).toMatch(
      /aria-label=\{`Account menu: \$\{me\.username\}, \$\{me\.role\}`\}/,
    )
    expect(userMenuSrc).toMatch(
      /title=\{`\$\{me\.username\} \(\$\{me\.role\}\)`\}/,
    )
  })
})

describe('C3-R2A visual density / empty-filter contracts', () => {
  it('decisions diagnostics use compact disclosed details', () => {
    expect(decisionsScreenSrc).toMatch(/decisions-diagnostics/)
    // id-ID primary copy; EN / legacy class names still accepted.
    expect(decisionsScreenSrc).toMatch(
      /diagDetails|Projection gaps|Celah proyeksi/,
    )
    expect(decisionsCss).toMatch(/\.bannerCompact/)
  })

  it('work empty state can reflect active bucket + stale filter truth', () => {
    expect(workStatesSrc).toMatch(/activeBucket/)
    expect(workStatesSrc).toMatch(/staleOverlayActive/)
    expect(workStatesSrc).toMatch(/Hapus filter BASI/)
    expect(workStatesSrc).toMatch(/Pindah ke Sedang dikerjakan/)
  })

  it('overview banners support compact + technical details disclosure', () => {
    expect(overviewCss).toMatch(/\.bannerCompact/)
    expect(overviewCss).toMatch(/\.bannerDetails/)
  })

  it('mobile chrome keeps 44×44 nav targets (≤900)', () => {
    const idx = stylesSrc.indexOf('@media (max-width: 900px)')
    expect(idx).toBeGreaterThan(-1)
    const slice = stylesSrc.slice(idx, idx + 2500)
    expect(slice).toMatch(/min-width:\s*44px/)
    expect(slice).toMatch(/min-height:\s*44px/)
  })
})

describe('C3-R4V agents density + enum label + mobile chrome contracts', () => {
  const agentsCss = readFileSync(
    join(root, 'src/components/control-center/agents/agents.module.css'),
    'utf8',
  )
  const agentsSrc = readFileSync(
    join(root, 'src/components/control-center/agents/AgentsScreen.tsx'),
    'utf8',
  )
  const displayLabelSrc = readFileSync(
    join(root, 'src/lib/display-label.ts'),
    'utf8',
  )
  const priorityCardSrc = readFileSync(
    join(root, 'src/components/control-center/overview/PriorityCard.tsx'),
    'utf8',
  )

  it('agents idCell never uses break-all (mid-token shred ban)', () => {
    const idCell = agentsCss.match(/\.idCell\s*\{([^}]+)\}/)
    expect(idCell?.[1]).toBeTruthy()
    expect(idCell![1]).not.toMatch(/word-break:\s*break-all/)
    expect(idCell![1]).toMatch(/text-overflow:\s*ellipsis/)
    expect(idCell![1]).toMatch(/white-space:\s*nowrap/)
  })

  it('agents table uses fixed layout + timeCell + col widths', () => {
    expect(agentsCss).toMatch(/table-layout:\s*fixed/)
    expect(agentsCss).toMatch(/\.timeCell\s*\{/)
    expect(agentsCss).toMatch(/\.colRun\s*\{/)
    expect(agentsSrc).toMatch(/formatDenseTimestamp/)
    expect(agentsSrc).toMatch(/title=\{full\}|title=\{row\.|title=\{pin\./)
  })

  it('display-label formatter humanizes SCREAMING_SNAKE enums', () => {
    expect(displayLabelSrc).toMatch(/formatOperationalLabel/)
    expect(displayLabelSrc).toMatch(/split\(['"]_['"]\)/)
  })

  it('overview PriorityCard uses formatOperationalLabel + raw title/data', () => {
    expect(priorityCardSrc).toMatch(/formatOperationalLabel/)
    expect(priorityCardSrc).toMatch(/data-frontier-raw/)
    expect(priorityCardSrc).toMatch(/data-portfolio-raw/)
    expect(overviewCss).toMatch(/\.metricValueEnum/)
    expect(overviewCss).not.toMatch(
      /\.metricValue\s*\{[^}]*overflow-wrap:\s*anywhere/s,
    )
  })

  it('UserMenu keeps full identity in aria-label/title; compact mobile hides name', () => {
    expect(userMenuSrc).toMatch(
      /aria-label=\{`Account menu: \$\{me\.username\}, \$\{me\.role\}`\}/,
    )
    expect(userMenuSrc).toMatch(
      /title=\{`\$\{me\.username\} \(\$\{me\.role\}\)`\}/,
    )
    expect(userMenuSrc).toMatch(/usermenu-role/)
    expect(stylesSrc).toMatch(/\.usermenu-name\s*\{\s*display:\s*none/)
    expect(stylesSrc).toMatch(/app--control-center/)
  })

  it('AppShell marks control-center shell for mobile chrome reduction', () => {
    expect(appShellSrc).toMatch(/app--control-center/)
  })
})
