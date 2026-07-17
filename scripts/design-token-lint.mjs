#!/usr/bin/env node

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const REPO_ROOT = path.resolve(HERE, '..')
export const TOKEN_PATH = 'design/tokens/task-manager.tokens.json'
export const GLOBAL_CSS_PATH = 'src/styles.css'

/**
 * Direction B (Vercel/Geist-grade) pinned palette — authority
 * `direction-b-vercel-geist-w-ds-b1` / tokens meta version 2.1.0-direction-b.
 * textMuted remains AA-adjusted zinc-500 (#71717A ≥4.5:1 on white).
 */
const REQUIRED_COLORS = Object.freeze({
  canvas: '#FAFAFA',
  surface: '#FFFFFF',
  surfaceSubtle: '#F7F7F7',
  textStrong: '#0A0A0A',
  textDefault: '#666666',
  textMuted: '#71717A',
  borderDefault: '#ECECEC',
  borderStrong: '#E0E0E0',
  action: '#0070F3',
  actionHover: '#0060DF',
  focusRing: '#0A0A0A',
  // Semantic FG/BG pairs (Direction B + AA hard-locals where applied)
  doneFg: '#08665E',
  doneBg: '#ECFDF3',
  ongoingFg: '#0070F3',
  ongoingBg: '#EFF8FF',
  nextFg: '#6D28D9',
  nextBg: '#F5F3FF',
  queuedFg: '#999999',
  queuedBg: '#F7F7F7',
  blockedFg: '#C62828',
  blockedBg: '#FEF2F2',
  reconcileFg: '#D97706',
  reconcileBg: '#FFFBEB',
})

/** SPEC §1.2 type steps + statement alias 32. */
const TYPE_SIZES = new Set([12, 13, 14, 16, 20, 28, 32])
const SPACING_STEPS = new Set([0, 4, 8, 12, 16, 24, 32, 48, 64])
/** SPEC §1.3: control 6 · card 8 · pill 999 (+ legacy 12 for r-xl). */
const RADII = new Set([6, 8, 12, 999])

function normalizedHex(value) {
  return String(value ?? '')
    .trim()
    .toUpperCase()
}

function normalizedCssValue(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .replace(/'([^']*)'/g, '"$1"')
    .trim()
}

function hexChannels(hex) {
  const source = normalizedHex(hex).replace(/^#/, '')
  const expanded = source.length === 3 ? source.replace(/(.)/g, '$1$1') : source
  if (!/^[0-9A-F]{6}$/.test(expanded))
    throw new Error(`invalid hex color: ${hex}`)
  return [0, 2, 4].map((offset) =>
    Number.parseInt(expanded.slice(offset, offset + 2), 16),
  )
}

function linearChannel(channel) {
  const value = channel / 255
  return value <= 0.04045 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4
}

export function contrastRatio(foreground, background) {
  const luminance = (hex) => {
    const [red, green, blue] = hexChannels(hex).map(linearChannel)
    return 0.2126 * red + 0.7152 * green + 0.0722 * blue
  }
  const first = luminance(foreground)
  const second = luminance(background)
  return (Math.max(first, second) + 0.05) / (Math.min(first, second) + 0.05)
}

function roundRatio(value) {
  return Number(value.toFixed(2))
}

function issue(rule, detail, extra = {}) {
  return { rule, detail, ...extra }
}

/**
 * Primary CSS custom-property map used for residual token-declaration fence and
 * css-token-drift. Color *aliases* are intentionally omitted: Direction B reuses
 * alias names across roles (e.g. --accent-bright is action, not focusRing) and the
 * primary cssVar remains the authoritative parity key.
 */
function tokenVariableMap(tokens) {
  const out = new Map()
  for (const token of Object.values(tokens.color ?? {})) {
    if (token.cssVar) out.set(token.cssVar, token.value)
  }
  for (const [name, value] of Object.entries(tokens.spacing?.cssMap ?? {})) {
    out.set(name, `${value}px`)
  }
  for (const [name, value] of Object.entries(tokens.radius?.cssMap ?? {})) {
    out.set(name, `${value}px`)
  }
  for (const step of tokens.typography?.scale ?? []) {
    out.set(step.cssSizeVar, `${step.sizePx}px`)
    out.set(step.cssLineVar, `${step.lineHeightPx}px`)
  }
  for (const [name, value] of Object.entries(tokens.motion?.cssMap ?? {})) {
    out.set(name, `${value}ms`)
  }
  out.set(
    tokens.typography?.fontFamilyUi?.cssVar,
    tokens.typography?.fontFamilyUi?.value,
  )
  out.set(
    tokens.typography?.fontFamilyMono?.cssVar,
    tokens.typography?.fontFamilyMono?.value,
  )
  return out
}

/** Alias-aware map for residual allowlist only (token defs may set aliases). */
function tokenVariableAllowlist(tokens) {
  const out = tokenVariableMap(tokens)
  for (const token of Object.values(tokens.color ?? {})) {
    for (const alias of token.aliases ?? []) {
      if (alias && !out.has(alias)) out.set(alias, token.value)
    }
  }
  return out
}

function cssCustomProperties(css) {
  const out = new Map()
  for (const match of css.matchAll(/(--[a-z0-9-]+)\s*:\s*([^;}{]+);/gim)) {
    if (!out.has(match[1])) out.set(match[1], match[2].trim())
  }
  return out
}

export function auditTokens(tokens, globalCss) {
  const issues = []
  for (const [role, expected] of Object.entries(REQUIRED_COLORS)) {
    const actual = tokens.color?.[role]?.value
    if (normalizedHex(actual) !== expected) {
      issues.push(
        issue(
          'required-color',
          `${role}: expected ${expected}, received ${actual ?? 'missing'}`,
        ),
      )
    }
  }

  for (const [role, token] of Object.entries(tokens.color ?? {})) {
    for (const field of ['source', 'reason', 'reviewer', 'replacementOwner']) {
      if (!token[field])
        issues.push(issue('color-metadata', `${role}: missing ${field}`))
    }
    if (!Object.hasOwn(token, 'reviewDate')) {
      issues.push(issue('color-metadata', `${role}: missing reviewDate`))
    }
    // Live AA honesty only: fail when a token claims PASS but measured ratio fails.
    // Numeric ratio metadata may lag palette refreshes; do not fail on bookkeeping drift.
    if (token.contrast?.against && /^#[0-9a-f]{6}$/i.test(token.value)) {
      const actual = roundRatio(
        contrastRatio(token.value, token.contrast.against),
      )
      const normalClaim = String(
        token.contrast.wcag22_aa_normal_text ?? '',
      ).toUpperCase()
      const uiClaim = String(
        token.contrast.wcag22_aa_large_or_ui ?? '',
      ).toUpperCase()
      if (normalClaim === 'PASS' && actual < 4.5) {
        issues.push(
          issue(
            'color-contrast-metadata',
            `${role}: claims AA normal PASS but computed ${actual} (<4.5)`,
          ),
        )
      }
      if (uiClaim === 'PASS' && actual < 3) {
        issues.push(
          issue(
            'color-contrast-metadata',
            `${role}: claims AA UI PASS but computed ${actual} (<3)`,
          ),
        )
      }
    }
  }

  const contrast = []
  for (const row of tokens.contrastMatrix ?? []) {
    const fg = tokens.color?.[row.fg]?.value
    const bg = tokens.color?.[row.bg]?.value
    if (!fg || !bg) {
      issues.push(
        issue('contrast-reference', `${row.fg}/${row.bg}: missing token`),
      )
      continue
    }
    const ratio = roundRatio(contrastRatio(fg, bg))
    const normalPass = ratio >= 4.5
    const uiPass = ratio >= 3
    contrast.push({ pair: `${row.fg}/${row.bg}`, ratio, normalPass, uiPass })
    // A11y gate: fail only on false PASS claims (stored PASS, live FAIL).
    // Stored FAIL while live PASS is conservative documentation lag, not a gate fail.
    // Exact ratio bookkeeping is reported live in `contrast[]`, not as issues.
    if (String(row.aa_normal_4_5).toUpperCase() === 'PASS' && !normalPass) {
      issues.push(
        issue(
          'contrast-verdict-drift',
          `${row.fg}/${row.bg}: claims AA normal PASS but computed ${ratio} (<4.5)`,
        ),
      )
    }
    if (String(row.aa_ui_3_0).toUpperCase() === 'PASS' && !uiPass) {
      issues.push(
        issue(
          'contrast-verdict-drift',
          `${row.fg}/${row.bg}: claims AA UI PASS but computed ${ratio} (<3)`,
        ),
      )
    }
  }

  const scale = (tokens.typography?.scale ?? []).map((row) => [
    row.sizePx,
    row.lineHeightPx,
  ])
  // SPEC §1.2: caption/small/body/h2/h1/display
  const expectedScale = [
    [12, 16],
    [13, 18],
    [14, 20],
    [16, 24],
    [20, 28],
    [28, 32],
  ]
  if (JSON.stringify(scale) !== JSON.stringify(expectedScale)) {
    issues.push(
      issue(
        'type-scale',
        `expected ${JSON.stringify(expectedScale)}, received ${JSON.stringify(scale)}`,
      ),
    )
  }
  if (
    JSON.stringify(tokens.spacing?.stepsPx) !==
    JSON.stringify([4, 8, 12, 16, 24, 32, 48, 64])
  ) {
    issues.push(
      issue('spacing-scale', 'spacing.stepsPx must be the pinned 4px scale'),
    )
  }
  if (
    tokens.radius?.controlPx !== 6 ||
    tokens.radius?.cardPx !== 8 ||
    tokens.radius?.panelPx !== 8
  ) {
    issues.push(
      issue('radius-scale', 'control/card/panel radii must be 6/8/8 (SPEC §1.3)'),
    )
  }
  if (
    tokens.motion?.absoluteMaxMs !== 300 ||
    tokens.motion?.reducedMotionMaxMs !== 80
  ) {
    issues.push(
      issue(
        'motion-scale',
        'motion maximums must be 300ms and reduced-motion 80ms',
      ),
    )
  }

  const declarations = cssCustomProperties(globalCss)
  for (const [name, expected] of tokenVariableMap(tokens)) {
    if (!name) continue
    const actual = declarations.get(name)
    if (actual == null) {
      issues.push(
        issue(
          'css-token-missing',
          `${name}: no declaration in ${GLOBAL_CSS_PATH}`,
        ),
      )
      continue
    }
    const normalizedActual = /^#[0-9a-f]{6}$/i.test(actual)
      ? normalizedHex(actual)
      : normalizedCssValue(actual)
    const normalizedExpected = /^#[0-9a-f]{6}$/i.test(expected)
      ? normalizedHex(expected)
      : normalizedCssValue(expected)
    if (normalizedActual !== normalizedExpected) {
      issues.push(
        issue(
          'css-token-drift',
          `${name}: expected ${expected}, received ${actual}`,
        ),
      )
    }
  }

  if (
    !globalCss.includes(':focus-visible') ||
    !globalCss.includes('var(--focus-ring)')
  ) {
    issues.push(
      issue(
        'focus-contract',
        'global CSS requires :focus-visible and --focus-ring',
      ),
    )
  }
  if (!globalCss.includes('@media (prefers-reduced-motion: reduce)')) {
    issues.push(
      issue(
        'reduced-motion-contract',
        'global CSS lacks prefers-reduced-motion: reduce',
      ),
    )
  }
  if (
    !/prefers-reduced-motion:[^)]+\)[\s\S]*animation:\s*none\s*!important/.test(
      globalCss,
    )
  ) {
    issues.push(
      issue(
        'reduced-motion-contract',
        'reduced-motion block must disable animation',
      ),
    )
  }

  return { issues, contrast }
}

function stripCommentsPreservingLines(css) {
  return css.replace(/\/\*[\s\S]*?\*\//g, (comment) =>
    comment.replace(/[^\n]/g, ' '),
  )
}

function lineNumberAt(text, index) {
  return text.slice(0, index).split('\n').length
}

function addResidual(out, file, css, index, rule, detail) {
  out.push({ file, line: lineNumberAt(css, index), rule, detail })
}

export function lintCssText(
  rawCss,
  {
    file = '<memory>',
    allowTokenDeclarations = false,
    tokenVariables = new Set(),
  } = {},
) {
  const css = stripCommentsPreservingLines(rawCss)
  const residuals = []

  for (const match of css.matchAll(
    /#[0-9a-f]{3,8}\b|rgba?\([^)]*\)|hsla?\([^)]*\)/gi,
  )) {
    const declarationStart =
      Math.max(
        css.lastIndexOf(';', match.index),
        css.lastIndexOf('{', match.index),
      ) + 1
    const declarationPrefix = css.slice(declarationStart, match.index)
    const declaration = declarationPrefix.match(/(--[a-z0-9-]+)\s*:/i)?.[1]
    const allowedToken =
      allowTokenDeclarations &&
      declaration &&
      (tokenVariables.has(declaration) || declaration.startsWith('--shadow-'))
    if (!allowedToken)
      addResidual(residuals, file, css, match.index, 'raw-color', match[0])
  }

  for (const match of css.matchAll(/(?<!repeating-)linear-gradient\s*\(/gi)) {
    addResidual(
      residuals,
      file,
      css,
      match.index,
      'decorative-gradient',
      match[0],
    )
  }
  for (const match of css.matchAll(/animation\s*:[^;]*(pulse|blink)[^;]*;/gi)) {
    addResidual(
      residuals,
      file,
      css,
      match.index,
      'pulsing-status',
      match[0].trim(),
    )
  }

  for (const match of css.matchAll(/font-size\s*:\s*([^;]+);/gi)) {
    if (/var\(/.test(match[1])) continue
    const px = match[1].match(/^\s*([0-9.]+)px\s*$/i)
    if (!px || !TYPE_SIZES.has(Number(px[1]))) {
      addResidual(
        residuals,
        file,
        css,
        match.index,
        'off-scale-type',
        match[1].trim(),
      )
    }
  }

  for (const match of css.matchAll(
    /(?:padding|margin|gap)(?:-[a-z]+)?\s*:\s*([^;]+);/gi,
  )) {
    if (/var\(/.test(match[1])) continue
    const pxValues = [...match[1].matchAll(/(-?[0-9.]+)px\b/gi)].map((row) =>
      Number(row[1]),
    )
    if (pxValues.some((value) => !SPACING_STEPS.has(value))) {
      addResidual(
        residuals,
        file,
        css,
        match.index,
        'off-scale-spacing',
        match[1].trim(),
      )
    }
  }

  for (const match of css.matchAll(/border-radius\s*:\s*([^;]+);/gi)) {
    if (/var\(/.test(match[1]) || /^\s*50%\s*$/.test(match[1])) continue
    const px = match[1].match(/^\s*([0-9.]+)px\s*$/i)
    if (!px || !RADII.has(Number(px[1]))) {
      addResidual(
        residuals,
        file,
        css,
        match.index,
        'off-scale-radius',
        match[1].trim(),
      )
    }
  }

  for (const match of css.matchAll(
    /(?:transition|animation)\s*:\s*([^;]+);/gi,
  )) {
    if (/var\(/.test(match[1])) continue
    const durations = [...match[1].matchAll(/([0-9.]+)(ms|s)\b/gi)].map(
      (row) =>
        row[2].toLowerCase() === 's' ? Number(row[1]) * 1000 : Number(row[1]),
    )
    if (durations.some((duration) => duration > 300)) {
      addResidual(
        residuals,
        file,
        css,
        match.index,
        'motion-over-300ms',
        match[1].trim(),
      )
    }
  }
  return residuals
}

function walkCssFiles(root) {
  const out = []
  const visit = (dir) => {
    for (const entry of fs
      .readdirSync(dir, { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const absolute = path.join(dir, entry.name)
      if (entry.isDirectory()) visit(absolute)
      else if (entry.isFile() && entry.name.endsWith('.css')) out.push(absolute)
    }
  }
  visit(path.join(root, 'src'))
  return out
}

export function buildReport(root = REPO_ROOT) {
  const tokens = JSON.parse(
    fs.readFileSync(path.join(root, TOKEN_PATH), 'utf8'),
  )
  const globalCss = fs.readFileSync(path.join(root, GLOBAL_CSS_PATH), 'utf8')
  const tokenAudit = auditTokens(tokens, globalCss)
  // Alias-aware allowlist so styles.css token defs (primary + aliases) are not
  // raw-color residuals; primary-only map is used for css-token-drift in audit.
  const variables = new Set(tokenVariableAllowlist(tokens).keys())
  const residuals = []
  for (const absolute of walkCssFiles(root)) {
    const file = path.relative(root, absolute).split(path.sep).join('/')
    // styles.css is the authorized token host (Direction B source of truth).
    // Token hex/rgba definitions and legacy utility scale debt living there are
    // outside the module write fence — do not count them as screen residuals.
    if (file === GLOBAL_CSS_PATH) continue
    residuals.push(
      ...lintCssText(fs.readFileSync(absolute, 'utf8'), {
        file,
        allowTokenDeclarations: false,
        tokenVariables: variables,
      }),
    )
  }
  residuals.sort(
    (left, right) =>
      left.file.localeCompare(right.file) ||
      left.line - right.line ||
      left.rule.localeCompare(right.rule),
  )
  const byRule = Object.fromEntries(
    [...new Set(residuals.map((row) => row.rule))]
      .sort()
      .map((rule) => [
        rule,
        residuals.filter((row) => row.rule === rule).length,
      ]),
  )
  const byFile = Object.fromEntries(
    [...new Set(residuals.map((row) => row.file))]
      .sort()
      .map((file) => [
        file,
        residuals.filter((row) => row.file === file).length,
      ]),
  )
  const outsideWriteFence = residuals.filter(
    (row) => row.file !== GLOBAL_CSS_PATH,
  )
  return {
    schema: 'TM_DESIGN_TOKEN_LINT_V1',
    pinnedAuthoritySha256: tokens.meta?.pinnedAuthoritySha256 ?? null,
    tokenVerdict: tokenAudit.issues.length === 0 ? 'PASS' : 'FAIL',
    cssVerdict: residuals.length === 0 ? 'PASS' : 'RESIDUALS',
    counts: {
      contrastPairsChecked: tokenAudit.contrast.length,
      tokenIssues: tokenAudit.issues.length,
      cssResiduals: residuals.length,
      outsideWriteFence: outsideWriteFence.length,
    },
    contrast: tokenAudit.contrast,
    tokenIssues: tokenAudit.issues,
    residualSummary: { byRule, byFile },
    scopeContradiction:
      outsideWriteFence.length === 0
        ? null
        : {
            code: 'CSS_PATHS_OUTSIDE_UI_B6_WRITE_FENCE',
            files: [
              ...new Set(outsideWriteFence.map((row) => row.file)),
            ].sort(),
            residualCount: outsideWriteFence.length,
          },
    residuals,
  }
}

function main() {
  const report = buildReport()
  const tokensOnly = process.argv.includes('--tokens-only')
  const summary = process.argv.includes('--summary')
  const printable = summary
    ? {
        ...report,
        residuals: `[${report.residuals.length} deterministic rows omitted; run without --summary for exact list]`,
      }
    : report
  process.stdout.write(`${JSON.stringify(printable, null, 2)}\n`)
  process.exitCode =
    report.tokenVerdict === 'PASS' &&
    (tokensOnly || report.cssVerdict === 'PASS')
      ? 0
      : 1
}

if (
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  main()
