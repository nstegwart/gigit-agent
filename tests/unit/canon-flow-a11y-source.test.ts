/**
 * Static source contracts for FlowUltimate a11y (LOCAL ONLY).
 * CSS/TSX scans — not a live browser PASS claim.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')
const cssPath = join(root, 'src/components/flow-ultimate/flow-ultimate.css')
const tsxPath = join(
  root,
  'src/components/flow-ultimate/FlowUltimateScreen.tsx',
)
const css = readFileSync(cssPath, 'utf8')
const tsx = readFileSync(tsxPath, 'utf8')

describe('canon-flow-a11y source contracts (CSS)', () => {
  it('D-A11Y-06: prefers-reduced-motion fence with ≤50ms / none durations', () => {
    expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)/)
    const reduceBlock = css.match(
      /@media\s*\(\s*prefers-reduced-motion:\s*reduce\s*\)\s*\{[\s\S]*?\n\}/,
    )
    expect(reduceBlock).toBeTruthy()
    const body = reduceBlock![0]
    // Must collapse motion (none or ≤50ms token)
    expect(
      /transition(?:-duration)?:\s*(none|0\.01ms|0ms)/.test(body) ||
        /animation(?:-duration)?:\s*(none|0\.01ms|0ms)/.test(body),
    ).toBe(true)
    // Must not leave 300ms sheet transition unfenced under reduce
    expect(body).not.toMatch(/300ms/)
  })

  it('D-A11Y-07: chrome controls declare min 44×44 CSS px', () => {
    // Zoom + sheet close hard sizes
    expect(css).toMatch(
      /\.flow-zoom\s+button\s*\{[^}]*min-width:\s*44px/s,
    )
    expect(css).toMatch(
      /\.flow-zoom\s+button\s*\{[^}]*min-height:\s*44px/s,
    )
    expect(css).toMatch(
      /\.flow-sheet-close\s*\{[^}]*min-width:\s*44px/s,
    )
    expect(css).toMatch(
      /\.flow-sheet-close\s*\{[^}]*min-height:\s*44px/s,
    )
    expect(css).toMatch(/\.flow-pill\s*\{[^}]*min-height:\s*44px/s)
    expect(css).toMatch(/\.flow-brand\s*\{[^}]*min-height:\s*44px/s)
  })

  it('D-A11Y-08: caption/meta/empty body text uses --t2 not --t3', () => {
    // Body-text selectors must not paint with --t3
    const bodySelectors = [
      [/\.fnode\s+\.flow-meta\s*\{[^}]*color:\s*([^;]+);/s, 'flow-meta'],
      [/\.flow-hint\s*\{[^}]*color:\s*([^;]+);/s, 'flow-hint'],
      [/\.flow-empty\s*\{[^}]*color:\s*([^;]+);/s, 'flow-empty'],
      [/\.flow-sec-hint\s*\{[^}]*color:\s*([^;]+);/s, 'flow-sec-hint'],
      [/\.flow-link-meta\s*\{[^}]*color:\s*([^;]+);/s, 'flow-link-meta'],
    ] as const
    for (const [re, name] of bodySelectors) {
      const m = css.match(re)
      expect(m, `${name} color rule`).toBeTruthy()
      const color = (m![1] || '').trim()
      expect(color, `${name} must not use --t3`).not.toMatch(/var\(--t3\)/)
      expect(color, `${name} should use AA-safe --t2/--tx`).toMatch(
        /var\(--t2\)|var\(--tx\)/,
      )
    }
  })

  it('D-A11Y-10: flow-top z-index ≥ backdrop; mobile pill reflow present', () => {
    const topZ = css.match(/\.flow-top\s*\{[^}]*z-index:\s*(\d+)/s)
    const backdropZ = css.match(/\.flow-backdrop\s*\{[^}]*z-index:\s*(\d+)/s)
    expect(topZ).toBeTruthy()
    expect(backdropZ).toBeTruthy()
    expect(Number(topZ![1])).toBeGreaterThanOrEqual(60)
    expect(Number(topZ![1])).toBeGreaterThan(Number(backdropZ![1]))

    expect(css).toMatch(/@media\s*\(\s*max-width:\s*900px\s*\)/)
    expect(css).toMatch(
      /\.flow-modes\s*\{[^}]*overflow-x:\s*auto/s,
    )
  })

  it('D-A11Y-11: focus-visible styles under flow-ultimate-root', () => {
    expect(css).toMatch(
      /\.flow-ultimate-root\s+:focus-visible\s*\{[^}]*outline:/s,
    )
    expect(css).toMatch(
      /\.flow-list-plain\s+li\s+button:focus-visible\s*\{[^}]*outline:/s,
    )
  })

  it('D-A11Y-09 aid: sr-only utility present', () => {
    expect(css).toMatch(/\.flow-sr-only\s*\{/)
  })

  it('preserves card geometry 200×64 (visual skeleton)', () => {
    expect(css).toMatch(/\.fnode\s*\{[^}]*width:\s*200px/s)
    expect(css).toMatch(/\.fnode\s*\{[^}]*height:\s*64px/s)
  })
})

describe('canon-flow-a11y source contracts (TSX)', () => {
  it('D-A11Y-01/05: nodes have role/tabIndex/aria-label + Enter/Space path', () => {
    expect(tsx).toMatch(/role=["']button["']/)
    expect(tsx).toMatch(/tabIndex=\{0\}/)
    expect(tsx).toMatch(/aria-label=\{accessibleName\}|aria-label=\{`\$\{/)
    expect(tsx).toMatch(/statusLabel/)
    expect(tsx).toMatch(/key === ['"]Enter['"]|key === ['"] ['"]/)
  })

  it('D-A11Y-02: stage keyboard pan handlers present', () => {
    expect(tsx).toMatch(/ArrowLeft|ArrowRight|ArrowUp|ArrowDown/)
    expect(tsx).toMatch(/onStageKeyDown|PAN_STEP/)
    expect(tsx).toMatch(/panToNode|centerOnNode/)
  })

  it('D-A11Y-03: APG tablist arrows + roving tabindex + aria-controls', () => {
    expect(tsx).toMatch(/ArrowRight/)
    expect(tsx).toMatch(/Home/)
    expect(tsx).toMatch(/End/)
    expect(tsx).toMatch(/tabIndex=\{mode === m \? 0 : -1\}/)
    expect(tsx).toMatch(/aria-controls=["']flow-stage["']/)
  })

  it('D-A11Y-04/14: dialog focus management + closed modal attrs', () => {
    expect(tsx).toMatch(/closeBtnRef|openerRef/)
    expect(tsx).toMatch(/Escape/)
    expect(tsx).toMatch(/aria-modal=\{sheetOpen/)
    expect(tsx).toMatch(/role=\{sheetOpen \? ['"]dialog['"]/)
    expect(tsx).toMatch(/inert=\{!sheetOpen/)
    // Coherent close policy: mode switch / rebuild must not bypass closeSheet
    expect(tsx).toMatch(/closeSheet\(\{\s*focusTarget/)
    expect(tsx).toMatch(/openerRef\.current\s*=\s*null/)
    expect(tsx).toMatch(/switchMode\([^)]*focusTarget|switchMode\s*=\s*useCallback/)
  })

  it('D-A11Y-09/12/13: summary, zoom labels, h1 not nested in button', () => {
    expect(tsx).toMatch(/flow-graph-summary|role=["']status["']/)
    expect(tsx).toMatch(/aria-label=["']Perbesar["']/)
    expect(tsx).toMatch(/aria-label=["']Perkecil["']/)
    expect(tsx).toMatch(/aria-label=["']Muat semua["']/)
    expect(tsx).toMatch(/<h1[\s>]/)
    // Adversarial: no h1 inside the brand button (invalid nesting)
    expect(tsx).not.toMatch(
      /<button[^>]*className=["']flow-brand["'][\s\S]*?<h1[\s>]/,
    )
    expect(tsx).not.toMatch(/<h1[^>]*className=["']flow-brand-title["']/)
  })
})
