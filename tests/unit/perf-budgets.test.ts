/**
 * Deterministic unit tests for qa/e2e/flows/perf-budgets.mjs pure helpers.
 * LOCAL ONLY — no network, no staging mutation.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/perf-budgets.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

describe('perf-budgets harness helpers', () => {
  it('percentile p95 on 1..10 is 10', async () => {
    const m = await loadFlow()
    expect(m.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(m.percentile([], 95)).toBeNull()
  })

  it('detects identical public-snapshot filter probe (view/bucket unread path)', async () => {
    const m = await loadFlow()
    const publicUrl = 'http://127.0.0.1:33211/api/public-snapshot?boardId=mfs-rebuild'
    const filterUrl = `${publicUrl}&view=filter&bucket=ONGOING`
    expect(
      m.isIdenticalPublicFilterProbe({ publicUrl, filterUrl, uiFilterUrl: null }),
    ).toBe(true)
    expect(
      m.isIdenticalPublicFilterProbe({
        publicUrl,
        filterUrl: 'http://127.0.0.1:33211/api/other',
        uiFilterUrl: null,
      }),
    ).toBe(false)
    expect(
      m.isIdenticalPublicFilterProbe({
        publicUrl,
        filterUrl,
        uiFilterUrl: 'http://127.0.0.1:33211/control-center',
      }),
    ).toBe(false)
  })

  it('aligns filter budget to public when path is identical and env not explicit', async () => {
    const m = await loadFlow()
    const b = m.resolveBudgets({
      publicP95Ms: 500,
      identicalPath: true,
      filterP95Explicit: false,
    })
    expect(b.filterProbeP95Ms).toBe(500)
    expect(b.filterBudgetSource).toBe('aligned_to_public_identical_path')
    expect(b.uiFilterP95Ms).toBe(200)
    expect(b.uiFilterConfigured).toBe(false)
  })

  it('preserves explicit PERF_FILTER_P95_MS and distinct UI ≤200 budget', async () => {
    const m = await loadFlow()
    const explicit = m.resolveBudgets({
      publicP95Ms: 500,
      identicalPath: true,
      filterP95Explicit: true,
      filterP95Ms: 200,
    })
    expect(explicit.filterProbeP95Ms).toBe(200)
    expect(explicit.filterBudgetSource).toBe('PERF_FILTER_P95_MS')

    const ui = m.resolveBudgets({
      publicP95Ms: 500,
      identicalPath: false,
      uiFilterUrl: 'http://127.0.0.1:3210/cc?filter=1',
      uiFilterP95Ms: 200,
    })
    expect(ui.filterProbeP95Ms).toBe(200)
    expect(ui.uiFilterConfigured).toBe(true)
    expect(ui.uiFilterP95Ms).toBe(m.DEFAULT_UI_FILTER_P95_MS)
  })

  it('rate-limit sample plan caps n ≤ burst/2 and gap ≥ 1000ms', async () => {
    const m = await loadFlow()
    const plan = m.resolveSamplePlan({
      sampleN: 20,
      seriesCount: 2,
      burst: 20,
      sustainedPerMinute: 60,
    })
    expect(plan.sampleN).toBe(10)
    expect(plan.gapMs).toBeGreaterThanOrEqual(1000)
    expect(plan.totalRequests).toBe(20)
    expect(plan.belowPolicy).toBe(true)
    expect(plan.reasons.some((r: string) => r.startsWith('sampleN_capped_burst_half'))).toBe(
      true,
    )
  })

  it('honors explicit gap but flags when below policy refill', async () => {
    const m = await loadFlow()
    const plan = m.resolveSamplePlan({
      sampleN: 10,
      seriesCount: 2,
      burst: 20,
      sustainedPerMinute: 60,
      gapMs: 50,
      gapExplicit: true,
    })
    expect(plan.gapMs).toBe(50)
    expect(plan.belowPolicy).toBe(false)
    expect(plan.reasons.some((r: string) => r.startsWith('gap_below_policy_refill'))).toBe(true)
  })

  it('parses server latency from Server-Timing / x-server-latency-ms only when present', async () => {
    const m = await loadFlow()
    expect(m.parseServerLatencyMs(null)).toBeNull()
    expect(
      m.parseServerLatencyMs({
        get: (n: string) =>
          n.toLowerCase() === 'server-timing' ? 'app;dur=12.5, db;dur=3' : null,
      }),
    ).toBe(12.5)
    expect(
      m.parseServerLatencyMs({
        get: (n: string) => (n.toLowerCase() === 'x-server-latency-ms' ? '18' : null),
      }),
    ).toBe(18)
    expect(
      m.parseServerLatencyMs({
        get: () => null,
      }),
    ).toBeNull()
  })

  it('summarizeSamples excludes 429 and 429-retried ok from APP p95', async () => {
    const m = await loadFlow()
    const summary = m.summarizeSamples([
      { ms: 10, status: 200, ok: true, serverMs: null, retries429: 0 },
      { ms: 30, status: 200, ok: true, serverMs: null, retries429: 0 },
      { ms: 9000, status: 200, ok: true, serverMs: null, retries429: 1 },
      { ms: 2, status: 429, ok: false, serverMs: null, retries429: 0 },
      { ms: 5, status: 500, ok: false, serverMs: null, retries429: 0 },
    ])
    expect(summary.okCount).toBe(2)
    expect(summary.rateLimitCount).toBe(1)
    expect(summary.retriedOkCount).toBe(1)
    expect(summary.failCount).toBe(1)
    expect(summary.p95).toBe(30)
    expect(summary.latencySource).toBe('client_wall')
  })

  it('prefers serverMs when present on clean samples', async () => {
    const m = await loadFlow()
    const summary = m.summarizeSamples([
      { ms: 400, status: 200, ok: true, serverMs: 12, retries429: 0 },
      { ms: 500, status: 200, ok: true, serverMs: 15, retries429: 0 },
    ])
    expect(summary.usedServerLatency).toBe(true)
    expect(summary.p95).toBe(15)
    expect(summary.latencySource).toBe('server_header')
  })

  it('classifies TUNNEL / APP / HARNESS / STACK / OK correctly', async () => {
    const m = await loadFlow()
    expect(
      m.classifyPerfResult({
        publicPass: true,
        filterPass: false,
        proofBoundary: 'tunnel',
        usedServerLatency: false,
        okCount: 8,
        rateLimitCount: 0,
      }),
    ).toBe('TUNNEL')

    expect(
      m.classifyPerfResult({
        publicPass: false,
        filterPass: true,
        proofBoundary: 'on-host',
        usedServerLatency: false,
        okCount: 8,
        rateLimitCount: 0,
      }),
    ).toBe('APP')

    expect(
      m.classifyPerfResult({
        publicPass: false,
        filterPass: true,
        proofBoundary: 'tunnel',
        usedServerLatency: true,
        okCount: 8,
        rateLimitCount: 0,
      }),
    ).toBe('APP')

    expect(
      m.classifyPerfResult({
        publicPass: false,
        filterPass: true,
        proofBoundary: 'on-host',
        okCount: 5,
        rateLimitCount: 2,
      }),
    ).toBe('HARNESS')

    expect(m.classifyPerfResult({ stackError: 'ECONNREFUSED', okCount: 0 })).toBe('STACK')
    expect(
      m.classifyPerfResult({
        publicPass: true,
        filterPass: true,
        uiFilterPass: true,
        okCount: 10,
      }),
    ).toBe('OK')
  })

  it('resolveProofBoundary defaults loopback to tunnel; honors explicit on-host', async () => {
    const m = await loadFlow()
    expect(m.resolveProofBoundary({ base: 'http://127.0.0.1:33211' })).toBe('tunnel')
    expect(m.resolveProofBoundary({ base: 'http://localhost:3210' })).toBe('tunnel')
    expect(
      m.resolveProofBoundary({ explicit: 'on-host', base: 'http://127.0.0.1:33211' }),
    ).toBe('on-host')
    expect(m.resolveProofBoundary({ base: 'https://staging.example.com' })).toBe('remote')
  })

  it('buildFilterProbeUrl appends identical query or uses UI surface', async () => {
    const m = await loadFlow()
    const pub = 'http://127.0.0.1:33211/api/public-snapshot?boardId=x'
    expect(m.buildFilterProbeUrl(pub)).toBe(
      `${pub}&${m.DEFAULT_IDENTICAL_FILTER_QUERY}`,
    )
    expect(
      m.buildFilterProbeUrl(pub, {
        base: 'http://127.0.0.1:33211',
        uiFilterUrl: '/control-center?bucket=ONGOING',
      }),
    ).toBe('http://127.0.0.1:33211/control-center?bucket=ONGOING')
  })

  it('selfTest() passes all deterministic checks', async () => {
    const m = await loadFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.checks.budgetsIdenticalAlign).toBe(true)
    expect(r.checks.samplePlanCap).toBe(true)
    expect(r.checks.classTunnel).toBe(true)
    expect(r.checks.classApp).toBe(true)
    expect(r.checks.summaryExcludesRetry).toBe(true)
  })
})
