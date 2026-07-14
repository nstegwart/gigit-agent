/**
 * C3-R2A visual / contrast / a11y style contracts.
 * Support evidence only (LOCAL ONLY) — not authenticated browser/axe DONE.
 *
 * Asserts class/markup/token invariants for shell + primary CC modules.
 * Contrast ratios for light semantic tokens are computed from styles.css
 * with a real relative-luminance function (not hand-typed PASS).
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const stylesSrc = readFileSync(join(root, 'src/styles.css'), 'utf8')
const appShellSrc = readFileSync(join(root, 'src/components/AppShell.tsx'), 'utf8')
const userMenuSrc = readFileSync(join(root, 'src/components/UserMenu.tsx'), 'utf8')
const tasksTableSrc = readFileSync(join(root, 'src/components/TasksTable.tsx'), 'utf8')
const featuresTableSrc = readFileSync(join(root, 'src/components/FeaturesTable.tsx'), 'utf8')
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

/** Extract light :root token block only (before dark theme). */
function lightRootBlock(css: string): string {
  const start = css.indexOf(':root {')
  const dark = css.indexOf(':root[data-theme="dark"]')
  expect(start).toBeGreaterThan(-1)
  expect(dark).toBeGreaterThan(start)
  return css.slice(start, dark)
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
  const f = (x: number) => (x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4))
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b)
}

function contrastRatio(fg: string, bg: string): number {
  const L1 = relativeLuminance(fg)
  const L2 = relativeLuminance(bg)
  const hi = Math.max(L1, L2)
  const lo = Math.min(L1, L2)
  return (hi + 0.05) / (lo + 0.05)
}

/** Approx soft tint: FG @ 12% over white (matches design soft chips). */
function softOnWhite(fg: string, alpha = 0.12): string {
  const c = fg.replace('#', '')
  const r = parseInt(c.slice(0, 2), 16)
  const g = parseInt(c.slice(2, 4), 16)
  const b = parseInt(c.slice(4, 6), 16)
  const mix = (ch: number) => Math.round(255 * (1 - alpha) + ch * alpha)
  return (
    '#' +
    [mix(r), mix(g), mix(b)]
      .map((x) => x.toString(16).padStart(2, '0'))
      .join('')
  )
}

describe('C3-R2A light semantic tokens — computed AA (≥4.5:1)', () => {
  const light = lightRootBlock(stylesSrc)
  const tokens = {
    accent: tokenHex(light, 'accent'),
    ok: tokenHex(light, 'ok'),
    blocked: tokenHex(light, 'blocked'),
    warn: tokenHex(light, 'warn'),
    info: tokenHex(light, 'info'),
    done: tokenHex(light, 'done'),
    textFaint: tokenHex(light, 'text-faint'),
  } as const

  it.each(Object.entries(tokens))('%s on white ≥ 4.5:1', (_name, fg) => {
    const ratio = contrastRatio(fg, '#ffffff')
    expect(ratio).toBeGreaterThanOrEqual(4.5)
  })

  it.each(['accent', 'ok', 'blocked', 'warn', 'info', 'done'] as const)(
    '%s on soft-12% tint ≥ 4.5:1',
    (name) => {
      const fg = tokens[name]
      const soft = softOnWhite(fg, 0.12)
      const ratio = contrastRatio(fg, soft)
      expect(ratio).toBeGreaterThanOrEqual(4.5)
    },
  )

  it('does not use legacy low-contrast bright tokens in light :root', () => {
    // Pre-repair fails measured by Spark axe.
    expect(light).not.toMatch(/--blocked:\s*#e5484d/)
    expect(light).not.toMatch(/--ok:\s*#12a06a/)
    expect(light).not.toMatch(/--warn:\s*#c77b16/)
    expect(light).not.toMatch(/--info:\s*#2f7fe0/)
    expect(light).not.toMatch(/--done:\s*#0d9488/)
    expect(light).not.toMatch(/--accent:\s*#6d5efc/)
    expect(light).not.toMatch(/--text-faint:\s*#98a1af/)
  })

  it('chip-admin uses accent color on soft (token path)', () => {
    expect(stylesSrc).toMatch(
      /\.chip-admin\s*\{[^}]*color:\s*var\(--accent\)/s,
    )
  })
})

describe('C3-R2A module AA hard-locals (no var pass-through trap)', () => {
  it('decisions module hard-assigns blocked/ok/warn/info/accent AA hex', () => {
    expect(decisionsCss).toMatch(/--dec-blocked:\s*#c62828/)
    expect(decisionsCss).toMatch(/--dec-ok:\s*#0a6e48/)
    expect(decisionsCss).toMatch(/--dec-warn:\s*#8a5200/)
    expect(decisionsCss).toMatch(/--dec-info:\s*#1a5fb4/)
    expect(decisionsCss).toMatch(/--dec-accent:\s*#4f3fd4/)
    // Forbidden pattern that silently kept bright globals.
    expect(decisionsCss).not.toMatch(/--dec-blocked:\s*var\(--blocked/)
  })

  it('priority module hard-assigns semantic AA hex', () => {
    expect(priorityCss).toMatch(/--pr-blocked:\s*#c62828/)
    expect(priorityCss).toMatch(/--pr-ok:\s*#0a6e48/)
    expect(priorityCss).toMatch(/--pr-warn:\s*#8a5200/)
    expect(priorityCss).toMatch(/--pr-accent:\s*#4f3fd4/)
    expect(priorityCss).not.toMatch(/--pr-blocked:\s*var\(--blocked/)
  })

  it('overview/work modules declare local AA semantic vars', () => {
    expect(overviewCss).toMatch(/--cc-blocked:\s*#c62828/)
    expect(overviewCss).toMatch(/--cc-ok:\s*#0a6e48/)
    expect(workCss).toMatch(/--wk-blocked:\s*#c62828/)
    expect(workCss).toMatch(/--wk-done:\s*#08665e/)
  })

  it('badgeBlocked uses local darker FG that AA-passes measured soft #eedde0', () => {
    // Root defect: Work-BLOCKED_1440x900 axe — #c62828 on #eedde0 = 4.29.
    // --wk-blocked stays #c62828; only .badgeBlocked text is darker.
    expect(workCss).toMatch(/--wk-blocked:\s*#c62828/)
    const badge = workCss.match(/\.badgeBlocked\s*\{([^}]+)\}/)
    expect(badge?.[1]).toBeTruthy()
    const color = badge![1].match(/color:\s*(#[0-9a-fA-F]{6})/)
    expect(color?.[1]).toBeTruthy()
    const fg = color![1]
    // Measured soft = color-mix(blocked 12%, surface-2 #f4f6f9)
    const measuredSoft = '#eedde0'
    const ratio = contrastRatio(fg, measuredSoft)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    // Must not still use the failing pair
    expect(fg.toLowerCase()).not.toBe('#c62828')
  })

  it('summaryChipBlocking uses local darker FG that AA-passes measured soft #f1dfe1', () => {
    // Root defect: Decisions_* axe — #c62828 on #f1dfe1 = 4.38 (decisions-blocking-count).
    // --dec-blocked stays #c62828; only .summaryChipBlocking text is darker.
    expect(decisionsCss).toMatch(/--dec-blocked:\s*#c62828/)
    const chip = decisionsCss.match(/\.summaryChipBlocking\s*\{([^}]+)\}/)
    expect(chip?.[1]).toBeTruthy()
    const color = chip![1].match(/color:\s*(#[0-9a-fA-F]{6})/)
    expect(color?.[1]).toBeTruthy()
    const fg = color![1]
    // Harness-measured soft (rgba(198,40,40,0.12) composite on light Decisions surface)
    const measuredSoft = '#f1dfe1'
    const ratio = contrastRatio(fg, measuredSoft)
    expect(ratio).toBeGreaterThanOrEqual(4.5)
    expect(fg.toLowerCase()).not.toBe('#c62828')
    // Pre-fix pair must remain failing so the test documents the defect pair
    expect(contrastRatio('#c62828', measuredSoft)).toBeLessThan(4.5)
  })
})

describe('C3-R2A shell scroll + legacy table a11y markup', () => {
  it('main content region is named + keyboard focusable', () => {
    expect(appShellSrc).toMatch(/id="view"/)
    expect(appShellSrc).toMatch(/role="region"/)
    expect(appShellSrc).toMatch(/aria-label="Main content"/)
    expect(appShellSrc).toMatch(/tabIndex=\{0\}/)
  })

  it('TasksTable selects have accessible names', () => {
    expect(tasksTableSrc).toMatch(/aria-label="Filter by feature capability"/)
    expect(tasksTableSrc).toMatch(/aria-label="Filter by next gate"/)
  })

  it('TasksTable / FeaturesTable horizontal scrollports are focusable regions', () => {
    expect(tasksTableSrc).toMatch(/className="table-scroll"/)
    expect(tasksTableSrc).toMatch(/aria-label="Tasks table"/)
    expect(tasksTableSrc).toMatch(/tabIndex=\{0\}/)
    expect(featuresTableSrc).toMatch(/className="table-scroll"/)
    expect(featuresTableSrc).toMatch(/aria-label="Features table"/)
    expect(featuresTableSrc).toMatch(/tabIndex=\{0\}/)
    expect(stylesSrc).toMatch(/\.table-scroll\s*\{/)
  })

  it('UserMenu exposes full account name via aria-label/title', () => {
    expect(userMenuSrc).toMatch(/aria-label=\{`Account menu: \$\{me\.username\}, \$\{me\.role\}`\}/)
    expect(userMenuSrc).toMatch(/title=\{`\$\{me\.username\} \(\$\{me\.role\}\)`\}/)
  })
})

describe('C3-R2A visual density / empty-filter contracts', () => {
  it('decisions diagnostics use compact disclosed details', () => {
    expect(decisionsScreenSrc).toMatch(/decisions-diagnostics/)
    expect(decisionsScreenSrc).toMatch(/diagDetails|Projection gaps/)
    expect(decisionsCss).toMatch(/\.bannerCompact/)
  })

  it('work empty state can reflect active bucket + stale filter truth', () => {
    expect(workStatesSrc).toMatch(/activeBucket/)
    expect(workStatesSrc).toMatch(/staleOverlayActive/)
    expect(workStatesSrc).toMatch(/Clear STALE filter/)
    expect(workStatesSrc).toMatch(/Switch to Ongoing/)
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
  const displayLabelSrc = readFileSync(join(root, 'src/lib/display-label.ts'), 'utf8')
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
    expect(overviewCss).not.toMatch(/\.metricValue\s*\{[^}]*overflow-wrap:\s*anywhere/s)
  })

  it('UserMenu keeps full identity in aria-label/title; compact mobile hides name', () => {
    expect(userMenuSrc).toMatch(/aria-label=\{`Account menu: \$\{me\.username\}, \$\{me\.role\}`\}/)
    expect(userMenuSrc).toMatch(/title=\{`\$\{me\.username\} \(\$\{me\.role\}\)`\}/)
    expect(userMenuSrc).toMatch(/usermenu-role/)
    expect(stylesSrc).toMatch(/\.usermenu-name\s*\{\s*display:\s*none/)
    expect(stylesSrc).toMatch(/app--control-center/)
  })

  it('AppShell marks control-center shell for mobile chrome reduction', () => {
    expect(appShellSrc).toMatch(/app--control-center/)
  })
})
