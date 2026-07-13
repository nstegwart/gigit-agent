/**
 * Axe zero critical/serious helper for promoted Node flows.
 */
import AxeBuilder from '@axe-core/playwright'
import fs from 'node:fs'
import path from 'node:path'

const DEFAULT_TAGS = ['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa', 'wcag22aa']

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ outPath?: string, browserTestId?: string, tags?: string[] }} [opts]
 */
export async function runAxe(page, opts = {}) {
  const builder = new AxeBuilder({ page }).withTags(opts.tags ?? DEFAULT_TAGS)
  const results = await builder.analyze()
  const criticalSerious = (results.violations ?? []).filter(
    (v) => v.impact === 'critical' || v.impact === 'serious',
  )

  let rawPath
  if (opts.outPath) {
    const id = opts.browserTestId ?? `axe-${Date.now()}`
    rawPath = opts.outPath.endsWith('.json')
      ? opts.outPath
      : path.join(opts.outPath, `${id}.json`)
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
    violations: results.violations ?? [],
    rawPath,
  }
}

/**
 * @param {import('@playwright/test').Page} page
 * @param {{ outPath?: string, browserTestId?: string }} [opts]
 */
export async function assertAxeZeroCriticalSerious(page, opts = {}) {
  const result = await runAxe(page, opts)
  if (!result.ok) {
    const lines = result.criticalSerious.map(
      (v) => `  - [${v.impact}] ${v.id}: ${v.description}`,
    )
    throw new Error(
      [`axe AC-UI-06 FAIL: ${result.criticalSerious.length} critical/serious`, ...lines].join(
        '\n',
      ),
    )
  }
  return result
}
