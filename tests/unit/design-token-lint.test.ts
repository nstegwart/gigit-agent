import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface LintResidual {
  file: string
  rule: string
}

interface ContrastAuditRow {
  pair?: string
  normalPass: boolean
  uiPass: boolean
}

interface DesignTokenLintModule {
  GLOBAL_CSS_PATH: string
  REPO_ROOT: string
  TOKEN_PATH: string
  auditTokens: (
    tokens: unknown,
    globalCss: string,
  ) => {
    issues: Array<unknown>
    contrast: Array<ContrastAuditRow>
  }
  buildReport: (root?: string) => {
    tokenVerdict: string
    cssVerdict: string
    counts: {
      contrastPairsChecked: number
      tokenIssues: number
      cssResiduals: number
      outsideWriteFence: number
    }
    scopeContradiction: {
      files: Array<string>
      residualCount: number
    } | null
    residuals: Array<LintResidual>
    residualSummary: {
      byRule: Record<string, number>
    }
  }
  contrastRatio: (foreground: string, background: string) => number
  lintCssText: (rawCss: string) => Array<LintResidual>
}

// Use createRequire so vitest does not rewrite the script path to an http: URL.
const require = createRequire(import.meta.url)
const {
  GLOBAL_CSS_PATH,
  REPO_ROOT,
  TOKEN_PATH,
  auditTokens,
  buildReport,
  contrastRatio,
  lintCssText,
} = require('../../scripts/design-token-lint.mjs') as DesignTokenLintModule

/**
 * Honest baseline after W-TOKEN-2 (2026-07-17):
 * - REQUIRED_COLORS pinned to Direction B (accent #0070F3, surfaces/text/borders B).
 * - Screen module.css raw hex → var(--*-fg) aliases; soft-chip darker FG via color-mix.
 * - styles.css is the authorized token host and is excluded from residual counts.
 * - tokenVerdict PASS: live AA honesty (false PASS claims only) + primary cssVar parity.
 * - Remaining residuals: off-scale spacing/type/radius + motion/gradient debt in modules.
 * Do not suppress assertions — lock measured counts so regressions surface.
 * AA body/action pairs stay ≥4.5:1 (program-emitted checks below).
 */
const BASELINE = {
  tokenIssues: 0,
  tokenVerdict: 'PASS' as const,
  cssResiduals: 263,
  outsideWriteFence: 263,
  rawColor: 0,
  byRule: {
    'decorative-gradient': 2,
    'motion-over-300ms': 3,
    'off-scale-radius': 17,
    'off-scale-spacing': 155,
    'off-scale-type': 85,
    'pulsing-status': 1,
  },
}

describe('design-token-lint', () => {
  it('pinned token contract and programmatic contrast metadata are internally consistent', () => {
    const tokens = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, TOKEN_PATH), 'utf8'),
    )
    const css = fs.readFileSync(path.join(REPO_ROOT, GLOBAL_CSS_PATH), 'utf8')
    const result = auditTokens(tokens, css)
    expect(result.issues.length).toBe(BASELINE.tokenIssues)
    expect(result.contrast.length).toBeGreaterThanOrEqual(19)
    // Direction-B queuedFg (#999) fails both AA thresholds on surface/queuedBg
    // (2.85 / 2.66). Other pairs pass at least UI AA (3:1). Documented palette debt.
    const dualFail = result.contrast.filter(
      (row) => !row.normalPass && !row.uiPass,
    )
    expect(dualFail.map((row) => row.pair)).toEqual([
      'queuedFg/surface',
      'queuedFg/queuedBg',
    ])
    expect(
      result.contrast.filter((row) => row.normalPass || row.uiPass).length,
    ).toBe(result.contrast.length - 2)
    // Direction B accent + focus ring (program-emitted AA checks; must stay ≥4.5:1)
    expect(Number(contrastRatio('#0070F3', '#FFFFFF').toFixed(2))).toBe(4.55)
    expect(Number(contrastRatio('#0A0A0A', '#FFFFFF').toFixed(2))).toBe(19.8)
    expect(Number(contrastRatio('#0070F3', '#FFFFFF').toFixed(2))).toBeGreaterThanOrEqual(
      4.5,
    )
    expect(Number(contrastRatio('#666666', '#FFFFFF').toFixed(2))).toBeGreaterThanOrEqual(
      4.5,
    )
    expect(Number(contrastRatio('#71717A', '#FFFFFF').toFixed(2))).toBeGreaterThanOrEqual(
      4.5,
    )
  })

  it('CSS lint rejects raw drift and accepts tokenized, reduced-motion-safe CSS', () => {
    // Off-scale values intentionally outside SPEC V2 (13px/6px are ON scale now).
    const bad = lintCssText(`
    .bad {
      color: #ff00ff;
      font-size: 15px;
      padding: 7px;
      border-radius: 5px;
      background: linear-gradient(red, blue);
      animation: pulse 2s infinite;
    }
  `)
    expect(new Set(bad.map((row) => row.rule))).toEqual(
      new Set([
        'raw-color',
        'off-scale-type',
        'off-scale-spacing',
        'off-scale-radius',
        'decorative-gradient',
        'pulsing-status',
        'motion-over-300ms',
      ]),
    )

    const good = lintCssText(`
    .good {
      color: var(--text);
      font-size: var(--type-body-size);
      padding: var(--sp-4);
      border-radius: var(--r-md);
      transition: opacity var(--motion-fast) ease-out;
    }
    .pattern { background: repeating-linear-gradient(45deg, var(--queued), transparent 4px); }
  `)
    expect(good).toEqual([])
  })

  it('repo report exposes exact out-of-fence residuals without suppressing them', () => {
    const report = buildReport(REPO_ROOT)
    expect(report.tokenVerdict).toBe(BASELINE.tokenVerdict)
    expect(report.counts.tokenIssues).toBe(BASELINE.tokenIssues)
    expect(report.counts.cssResiduals).toBe(BASELINE.cssResiduals)
    expect(report.counts.outsideWriteFence).toBe(BASELINE.outsideWriteFence)
    expect(report.scopeContradiction).toBeTruthy()
    expect(report.counts.outsideWriteFence).toBeGreaterThan(0)
    // styles.css is the authorized token host — never appears in residual rows.
    expect(
      report.scopeContradiction!.files.every((file) => file !== GLOBAL_CSS_PATH),
    ).toBe(true)
    expect(
      report.residuals.every((row) => row.file !== GLOBAL_CSS_PATH),
    ).toBe(true)
    // W-TOKEN-2: screen module raw hex eliminated (0 raw-color residuals).
    expect(
      report.residuals.filter((row) => row.rule === 'raw-color').length,
    ).toBe(BASELINE.rawColor)
    // Residual rule histogram locked so off-scale debt cannot silently grow.
    expect(report.residualSummary.byRule).toEqual(BASELINE.byRule)
  })
})
