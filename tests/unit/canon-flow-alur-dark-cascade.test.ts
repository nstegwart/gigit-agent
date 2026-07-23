/**
 * Canon dark-token cascade (B-TOKENS-DARK / a308 → global dark 2026-07-19).
 *
 * Models selector applicability + specificity so unit gates prove EVERY route
 * (alur and non-alur) resolves the dark canon V3 tokens for data-theme light,
 * dark, auto, and absent. Historical failure documented: the light lock (0,2,0)
 * once overrode html[data-page=alur] dark host (0,1,1); the light lock is now
 * retired and replaced by a dark-canon lock with identical values everywhere.
 * Source-only — no live browser claim.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const stylesCss = readFileSync(join(root, 'src/styles.css'), 'utf8')

/** Canon dark host values (exact hex from styles.css alur block / a308). */
const ALUR_DARK = {
  bg: '#0d1017',
  surface: '#12161e',
  text: '#e8edf3',
  accent: '#5b9dff',
  ok: '#35c479',
  warn: '#e5a54b',
  blocked: '#e8635f',
  next: '#f472b6',
} as const

const ALUR_PROJ = {
  'proj-rn': '#f472b6',
  'proj-web': '#35c479',
  'proj-sales': '#e5a54b',
  'proj-affiliate': '#5b9dff',
  'proj-backend': '#a78bfa',
} as const

const RETIRED_LIGHT_BG = '#fafafa'

type Attrs = {
  dataTheme?: 'light' | 'dark' | null
  dataPage?: 'alur' | null
}

/**
 * Minimal CSS specificity: (a,b,c) for IDs / classes+attrs+pseudo-classes / elements.
 * Good enough for :root / html + attribute selectors used in the lock + alur host.
 */
function specificity(selector: string): [number, number, number] {
  const s = selector.trim()
  let a = 0
  let b = 0
  let c = 0
  // strip :not(...) contents into independent simple selectors for counting
  const withoutNot = s.replace(/:not\(([^)]*)\)/g, (_, inner: string) => {
    const innerSpec = specificity(inner)
    a += innerSpec[0]
    b += innerSpec[1]
    c += innerSpec[2]
    return ''
  })
  const ids = withoutNot.match(/#[\w-]+/g)
  if (ids) a += ids.length
  const attrs = withoutNot.match(/\[[^\]]+\]/g)
  if (attrs) b += attrs.length
  const classes = withoutNot.match(/\.[\w-]+/g)
  if (classes) b += classes.length
  const pseudos = withoutNot.match(/:(?!not\b)[\w-]+/g)
  if (pseudos) b += pseudos.length
  // elements / type selectors (html, :root counts as type)
  const types = withoutNot.match(/(?:^|[\s>+~])([a-zA-Z][\w-]*)/g)
  if (types) {
    for (const t of types) {
      const name = t.trim().replace(/^[>+~]\s*/, '')
      if (name && name !== 'not') c += 1
    }
  }
  // bare :root at start
  if (/(?:^|[\s,])(:root)\b/.test(s) || s.startsWith(':root')) {
    // :root is a pseudo-class in Selectors Level 3/4 → class column
    // Count once if not already counted via pseudos on stripped string
    if (!withoutNot.includes(':root') && s.includes(':root')) {
      b += 1
    } else if (withoutNot.includes(':root')) {
      // pseudos regex may have counted :root
    }
  }
  return [a, b, c]
}

function cmpSpec(x: [number, number, number], y: [number, number, number]): number {
  for (let i = 0; i < 3; i++) {
    if (x[i] !== y[i]) return x[i] - y[i]
  }
  return 0
}

/** Whether a single compound selector matches modeled html attrs. */
function selectorMatches(selector: string, attrs: Attrs): boolean {
  const s = selector.trim()
  // Evaluate :not() by requiring the inner not to match
  const notRe = /:not\(([^)]*)\)/g
  let m: RegExpExecArray | null
  const notInners: string[] = []
  while ((m = notRe.exec(s)) !== null) {
    notInners.push(m[1].trim())
  }
  for (const inner of notInners) {
    if (simpleAttrMatches(inner, attrs)) return false
  }
  // Positive attribute requirements outside :not
  const positive = s.replace(/:not\([^)]*\)/g, '')
  // data-theme="dark" / data-theme="light"
  const themeEq = positive.match(/\[data-theme=["'](light|dark)["']\]/)
  if (themeEq) {
    if (attrs.dataTheme !== themeEq[1]) return false
  }
  const pageEq = positive.match(/\[data-page=["']([^"']+)["']\]/)
  if (pageEq) {
    if (attrs.dataPage !== pageEq[1]) return false
  }
  // Must be root/html host
  if (!/(^|[\s,]):root\b|^html\b|[\s,]html\b/.test(s) && !s.includes(':root') && !s.startsWith('html')) {
    return false
  }
  return true
}

function simpleAttrMatches(simple: string, attrs: Attrs): boolean {
  const themeEq = simple.match(/\[data-theme=["'](light|dark)["']\]/)
  if (themeEq) return attrs.dataTheme === themeEq[1]
  const pageEq = simple.match(/\[data-page=["']([^"']+)["']\]/)
  if (pageEq) return attrs.dataPage === pageEq[1]
  // bare attribute presence e.g. [data-theme] not used here
  return false
}

function extractRuleBlock(css: string, headerRe: RegExp): string {
  const m = css.match(headerRe)
  expect(m, `rule header ${headerRe}`).toBeTruthy()
  const start = m!.index! + m![0].length
  // find matching closing brace for this block (no nested rules expected)
  const end = css.indexOf('\n}', start)
  expect(end).toBeGreaterThan(start)
  return css.slice(m!.index!, end + 2)
}

function tokenInBlock(block: string, name: string): string | null {
  const re = new RegExp(`--${name}:\\s*(#[0-9a-fA-F]{3,8})`)
  const m = block.match(re)
  return m?.[1]?.toLowerCase() ?? null
}

/**
 * Cascade model: later equal-specificity wins. Returns winning --bg (and scheme)
 * from the three host rules we care about.
 */
function resolveCascade(attrs: Attrs): {
  bg: string
  colorScheme: 'light' | 'dark' | null
  winner: string
} {
  type Cand = {
    name: string
    sel: string
    order: number
    bg: string
    scheme: 'light' | 'dark' | null
  }
  const candidates: Cand[] = []

  // :root base (now declares color-scheme: dark itself)
  const rootBlock = extractRuleBlock(stylesCss, /^:root\s*\{/m)
  candidates.push({
    name: ':root',
    sel: ':root',
    order: 0,
    bg: tokenInBlock(rootBlock, 'bg')!,
    scheme: /color-scheme:\s*dark/.test(rootBlock) ? 'dark' : null,
  })

  // dark-canon lock — split group selector
  const lockHeader =
    /:root\[data-theme="light"\],\s*:root:not\(\[data-theme="dark"\]\)\s*\{/
  const lockBlock = extractRuleBlock(stylesCss, lockHeader)
  const lockSels = [
    ':root[data-theme="light"]',
    ':root:not([data-theme="dark"])',
  ]
  for (const sel of lockSels) {
    if (selectorMatches(sel, attrs)) {
      candidates.push({
        name: `dark-lock:${sel}`,
        sel,
        order: 1,
        bg: tokenInBlock(lockBlock, 'bg')!,
        scheme: 'dark',
      })
    }
  }

  // alur dark host
  const alurBlock = extractRuleBlock(
    stylesCss,
    /^html\[data-page=['"]alur['"]\]\s*\{/m,
  )
  const alurSel = "html[data-page='alur']"
  if (selectorMatches(alurSel, attrs)) {
    candidates.push({
      name: 'alur-host',
      sel: alurSel,
      order: 2,
      bg: tokenInBlock(alurBlock, 'bg')!,
      scheme: 'dark',
    })
  }

  // Pick winner by specificity then source order
  let best: Cand | null = null
  let bestSpec: [number, number, number] = [-1, -1, -1]
  for (const c of candidates) {
    // only candidates that match (already filtered except :root always)
    if (c.name !== ':root' && !selectorMatches(c.sel, attrs)) continue
    const sp = specificity(c.sel)
    const cmp = cmpSpec(sp, bestSpec)
    if (!best || cmp > 0 || (cmp === 0 && c.order >= best.order)) {
      best = c
      bestSpec = sp
    }
  }
  expect(best).toBeTruthy()
  return {
    bg: best!.bg.toLowerCase(),
    colorScheme: best!.scheme,
    winner: best!.name,
  }
}

describe('canon-flow-alur-dark-cascade — dark-canon lock source', () => {
  it('locks dark for data-theme light/auto/absent with no alur carve-out left', () => {
    // Owner 2026-07-19: dark canon V3 on every route. Both lock branches present.
    expect(stylesCss).toMatch(
      /:root\[data-theme="light"\],\s*:root:not\(\[data-theme="dark"\]\)\s*\{/,
    )
    // Carve-outs retired with the light lock — no selector excludes alur anymore.
    expect(stylesCss).not.toMatch(/:not\(\[data-page=['"]alur['"]\]\)/)
    // The retired light palette and light scheme must be gone entirely.
    expect(stylesCss).not.toMatch(/#fafafa/i)
    expect(stylesCss).not.toMatch(/color-scheme:\s*light/)
    // No !important hammer on alur dark tokens
    const alurBlock = extractRuleBlock(
      stylesCss,
      /^html\[data-page=['"]alur['"]\]\s*\{/m,
    )
    expect(alurBlock).not.toMatch(/!important/)
  })

  it('alur host still declares exact dark canon + project identity', () => {
    const alurBlock = extractRuleBlock(
      stylesCss,
      /^html\[data-page=['"]alur['"]\]\s*\{/m,
    )
    expect(tokenInBlock(alurBlock, 'bg')).toBe(ALUR_DARK.bg)
    expect(tokenInBlock(alurBlock, 'surface')).toBe(ALUR_DARK.surface)
    expect(tokenInBlock(alurBlock, 'text')).toBe(ALUR_DARK.text)
    expect(tokenInBlock(alurBlock, 'accent')).toBe(ALUR_DARK.accent)
    expect(tokenInBlock(alurBlock, 'ok')).toBe(ALUR_DARK.ok)
    expect(tokenInBlock(alurBlock, 'warn')).toBe(ALUR_DARK.warn)
    expect(tokenInBlock(alurBlock, 'blocked')).toBe(ALUR_DARK.blocked)
    expect(tokenInBlock(alurBlock, 'next')).toBe(ALUR_DARK.next)
    expect(alurBlock).toMatch(/color-scheme:\s*dark/)
    for (const [name, hex] of Object.entries(ALUR_PROJ)) {
      expect(tokenInBlock(alurBlock, name)).toBe(hex)
    }
    // Project re-host on canvas root
    const projHost = extractRuleBlock(
      stylesCss,
      /^html\[data-page=['"]alur['"]\]\s+\.flow-ultimate-root\s*\{/m,
    )
    for (const [name, hex] of Object.entries(ALUR_PROJ)) {
      expect(tokenInBlock(projHost, name)).toBe(hex)
    }
  })

  it('dark-canon lock reasserts the exact canon values (same as :root and alur host)', () => {
    const lockHeader =
      /:root\[data-theme="light"\],\s*:root:not\(\[data-theme="dark"\]\)\s*\{/
    const lockBlock = extractRuleBlock(stylesCss, lockHeader)
    expect(tokenInBlock(lockBlock, 'bg')).toBe(ALUR_DARK.bg)
    expect(tokenInBlock(lockBlock, 'surface')).toBe(ALUR_DARK.surface)
    expect(tokenInBlock(lockBlock, 'text')).toBe(ALUR_DARK.text)
    expect(tokenInBlock(lockBlock, 'accent')).toBe(ALUR_DARK.accent)
    expect(tokenInBlock(lockBlock, 'bg')).not.toBe(RETIRED_LIGHT_BG)
    expect(lockBlock).toMatch(/color-scheme:\s*dark/)
  })
})

describe('canon-flow-alur-dark-cascade — modeled applicability / specificity', () => {
  const combos: Array<[string, Attrs]> = [
    ['alur + auto (no data-theme)', { dataTheme: null, dataPage: 'alur' }],
    ['alur + data-theme=dark', { dataTheme: 'dark', dataPage: 'alur' }],
    ['alur + data-theme=light', { dataTheme: 'light', dataPage: 'alur' }],
    ['non-alur + auto (no data-theme)', { dataTheme: null, dataPage: null }],
    ['non-alur + data-theme=dark', { dataTheme: 'dark', dataPage: null }],
    ['non-alur + data-theme=light', { dataTheme: 'light', dataPage: null }],
  ]

  it.each(combos)('%s resolves dark canon bg + color-scheme dark', (_label, attrs) => {
    const r = resolveCascade(attrs)
    expect(r.bg).toBe(ALUR_DARK.bg)
    expect(r.colorScheme).toBe('dark')
  })

  it('lock may win over alur host but declares identical canon values', () => {
    // Historical bug context: bare light lock (0,2,0) > alur host (0,1,1) forced
    // light on alur. The dark lock keeps that specificity relationship — and it
    // is now harmless BY VALUE EQUALITY: lock and alur host declare the same
    // canon tokens, so no carve-out is needed for any cascade path.
    const bareLock: [number, number, number] = [0, 2, 0]
    const alur: [number, number, number] = specificity("html[data-page='alur']")
    expect(cmpSpec(alur, bareLock)).toBeLessThan(0)
    // The un-carved dark lock branch applies on the alur document too.
    expect(
      selectorMatches(':root:not([data-theme="dark"])', {
        dataTheme: null,
        dataPage: 'alur',
      }),
    ).toBe(true)
    const lockBlock = extractRuleBlock(
      stylesCss,
      /:root\[data-theme="light"\],\s*:root:not\(\[data-theme="dark"\]\)\s*\{/,
    )
    const alurBlock = extractRuleBlock(
      stylesCss,
      /^html\[data-page=['"]alur['"]\]\s*\{/m,
    )
    for (const name of [
      'bg',
      'surface',
      'surface-2',
      'surface-3',
      'border',
      'border-strong',
      'text',
      'text-dim',
      'accent',
      'ok',
      'warn',
      'blocked',
      'next',
    ]) {
      expect(tokenInBlock(lockBlock, name), `token --${name}`).toBe(
        tokenInBlock(alurBlock, name),
      )
    }
  })
})
