/**
 * Axe accessibility check — fail on critical/serious (UI_CONTRACT AC-UI-06).
 * Requires devDependency @axe-core/playwright.
 */
import AxeBuilder from '@axe-core/playwright'
import type { Page } from '@playwright/test'
import fs from 'node:fs'
import path from 'node:path'

export type AxeImpact = 'minor' | 'moderate' | 'serious' | 'critical'

export type AxeViolationSummary = {
  id: string
  impact: AxeImpact | null
  description: string
  helpUrl: string
  nodes: number
}

export type AxeCheckResult = {
  ok: boolean
  criticalSerious: AxeViolationSummary[]
  all: AxeViolationSummary[]
  rawPath?: string
}

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

export type RunAxeOptions = {
  /** Write full axe JSON under this path (directory or file). */
  outPath?: string
  browserTestId?: string
  include?: string[]
  exclude?: string[]
  tags?: string[]
}

function summarize(
  v: { id: string; impact?: string | null; description: string; helpUrl: string; nodes: unknown[] },
): AxeViolationSummary {
  return {
    id: v.id,
    impact: (v.impact as AxeImpact | null | undefined) ?? null,
    description: v.description,
    helpUrl: v.helpUrl,
    nodes: v.nodes?.length ?? 0,
  }
}

/**
 * Run axe on the current page. Returns structured result.
 * Does not throw — use assertAxeZeroCriticalSerious to fail closed.
 */
export async function runAxe(page: Page, opts: RunAxeOptions = {}): Promise<AxeCheckResult> {
  let builder = new AxeBuilder({ page }).withTags(opts.tags ?? DEFAULT_TAGS)
  if (opts.include?.length) {
    for (const sel of opts.include) builder = builder.include(sel)
  }
  if (opts.exclude?.length) {
    for (const sel of opts.exclude) builder = builder.exclude(sel)
  }

  const results = await builder.analyze()
  const all = (results.violations ?? []).map(summarize)
  const criticalSerious = all.filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  )

  let rawPath: string | undefined
  if (opts.outPath) {
    const id = opts.browserTestId ?? `axe-${Date.now()}`
    const isDir = opts.outPath.endsWith('/') || !opts.outPath.endsWith('.json')
    rawPath = isDir
      ? path.join(opts.outPath, `${id}.json`)
      : opts.outPath
    fs.mkdirSync(path.dirname(rawPath), { recursive: true })
    fs.writeFileSync(
      rawPath,
      JSON.stringify(
        {
          browserTestId: id,
          url: page.url(),
          timestamp: new Date().toISOString(),
          criticalSeriousCount: criticalSerious.length,
          violations: results.violations,
          passes: results.passes?.length ?? 0,
          incomplete: results.incomplete?.length ?? 0,
        },
        null,
        2,
      ),
      'utf8',
    )
  }

  return {
    ok: criticalSerious.length === 0,
    criticalSerious,
    all,
    rawPath,
  }
}

/** Fail closed when any critical or serious axe violation exists. */
export async function assertAxeZeroCriticalSerious(
  page: Page,
  opts: RunAxeOptions = {},
): Promise<AxeCheckResult> {
  const result = await runAxe(page, opts)
  if (!result.ok) {
    const lines = result.criticalSerious.map(
      (v) => `  - [${v.impact}] ${v.id}: ${v.description} (nodes=${v.nodes}) ${v.helpUrl}`,
    )
    throw new Error(
      [
        `axe AC-UI-06 FAIL: ${result.criticalSerious.length} critical/serious violation(s)`,
        ...lines,
        result.rawPath ? `raw: ${result.rawPath}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
    )
  }
  return result
}
