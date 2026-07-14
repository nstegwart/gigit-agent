/**
 * Deterministic unit tests for qa/e2e/flows/perf-ui-overview-lcp.mjs pure helpers.
 * LOCAL ONLY — no browser, no staging.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/perf-ui-overview-lcp.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

describe('perf-ui-overview-lcp helpers', () => {
  it('prefers overviewReadyMs over LCP for ≤2.5s budget', async () => {
    const m = await loadFlow()
    const r = m.evaluateOverviewReady({
      overviewReadyMs: 1000,
      lcpMs: 4000,
      budgetMs: 2500,
    })
    expect(r.pass).toBe(true)
    expect(r.metric).toBe('overview_ready')
    expect(r.valueMs).toBe(1000)
  })

  it('fails when overview ready exceeds budget', async () => {
    const m = await loadFlow()
    const r = m.evaluateOverviewReady({ overviewReadyMs: 3000, budgetMs: 2500 })
    expect(r.pass).toBe(false)
    expect(r.reason).toContain('overview_ready')
  })

  it('uses LCP when ready marker absent', async () => {
    const m = await loadFlow()
    const r = m.evaluateOverviewReady({ lcpMs: 800, budgetMs: 2500 })
    expect(r.pass).toBe(true)
    expect(r.metric).toBe('lcp')
  })

  it('evaluates filter feedback ≤200 and skip when not applicable', async () => {
    const m = await loadFlow()
    expect(
      m.evaluateFilterFeedback({
        feedbackMs: 50,
        budgetMs: 200,
        metricKind: m.FILTER_METRIC_IN_SURFACE,
      }).pass,
    ).toBe(true)
    expect(
      m.evaluateFilterFeedback({
        feedbackMs: 500,
        budgetMs: 200,
        metricKind: m.FILTER_METRIC_IN_SURFACE,
      }).pass,
    ).toBe(false)
    const skip = m.evaluateFilterFeedback({ applicable: false })
    expect(skip.applicable).toBe(false)
    expect(skip.pass).toBe(true)
  })

  it('fail-closes navigation wall / page.goto as filter metric (never PASS ≤200)', async () => {
    const m = await loadFlow()
    const nav = m.evaluateFilterFeedback({
      feedbackMs: 50,
      budgetMs: 200,
      metricKind: m.FILTER_METRIC_NAV_WALL,
    })
    expect(nav.pass).toBe(false)
    expect(nav.reason).toBe('filter_metric_is_navigation_wall_not_in_surface')

    const goto = m.evaluateFilterFeedback({
      feedbackMs: 10,
      budgetMs: 200,
      metricKind: m.FILTER_METRIC_PAGE_GOTO,
    })
    expect(goto.pass).toBe(false)

    const missingControl = m.evaluateFilterFeedback({
      applicable: true,
      budgetMs: 200,
      error: 'filter_action_unavailable_after_data',
    })
    expect(missingControl.pass).toBe(false)
  })

  it('builds overview and filter paths; parses bucket; work base excludes query', async () => {
    const m = await loadFlow()
    expect(m.buildOverviewPath('mfs-rebuild')).toBe('/b/mfs-rebuild/')
    expect(m.buildFilterPath('mfs-rebuild', null)).toBe('/b/mfs-rebuild/work?bucket=ONGOING')
    expect(m.buildFilterPath('x', '/b/x/work?bucket=DONE')).toBe('/b/x/work?bucket=DONE')
    expect(m.parseFilterBucket('/b/mfs-rebuild/work?bucket=ONGOING')).toBe('ONGOING')
    expect(m.buildWorkBasePath('mfs-rebuild', '/b/mfs-rebuild/work?bucket=ONGOING')).toBe(
      '/b/mfs-rebuild/work',
    )
  })

  it('selfTest() passes', async () => {
    const m = await loadFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.checks.filterNavWallFail).toBe(true)
  })
})
