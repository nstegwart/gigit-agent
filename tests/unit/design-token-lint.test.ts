import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { describe, expect, it } from 'vitest'

interface LintResidual {
  file: string
  rule: string
}

interface ContrastAuditRow {
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
    counts: {
      outsideWriteFence: number
    }
    scopeContradiction: {
      files: Array<string>
    } | null
    residuals: Array<LintResidual>
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

describe('design-token-lint', () => {
  it('pinned token contract and programmatic contrast metadata are internally consistent', () => {
    const tokens = JSON.parse(
      fs.readFileSync(path.join(REPO_ROOT, TOKEN_PATH), 'utf8'),
    )
    const css = fs.readFileSync(path.join(REPO_ROOT, GLOBAL_CSS_PATH), 'utf8')
    const result = auditTokens(tokens, css)
    expect(result.issues).toEqual([])
    expect(result.contrast.length).toBeGreaterThanOrEqual(19)
    expect(result.contrast.every((row) => row.normalPass || row.uiPass)).toBe(
      true,
    )
    expect(Number(contrastRatio('#175CD3', '#FFFFFF').toFixed(2))).toBe(5.99)
    expect(Number(contrastRatio('#2E90FA', '#FFFFFF').toFixed(2))).toBe(3.24)
  })

  it('CSS lint rejects raw drift and accepts tokenized, reduced-motion-safe CSS', () => {
    const bad = lintCssText(`
    .bad {
      color: #ff00ff;
      font-size: 13px;
      padding: 7px;
      border-radius: 6px;
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
    expect(report.tokenVerdict).toBe('PASS')
    expect(report.scopeContradiction).toBeTruthy()
    expect(report.counts.outsideWriteFence).toBeGreaterThan(0)
    expect(
      report.scopeContradiction!.files.every((file) => file !== GLOBAL_CSS_PATH),
    ).toBe(true)
    expect(
      report.residuals.filter(
        (row) => row.file === GLOBAL_CSS_PATH && row.rule === 'raw-color',
      ).length,
    ).toBe(0)
    expect(
      report.residuals.filter(
        (row) =>
          row.file === GLOBAL_CSS_PATH && row.rule === 'decorative-gradient',
      ).length,
    ).toBe(0)
    expect(
      report.residuals.filter(
        (row) => row.file === GLOBAL_CSS_PATH && row.rule === 'pulsing-status',
      ).length,
    ).toBe(0)
  })
})
