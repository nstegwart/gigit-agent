/**
 * Unit/self-tests for TM canon-flow large-graph performance harness (no server).
 * Imports Node harness modules via pathToFileURL and exercises pure contracts.
 *
 * Does NOT claim live functional PASS or staging/prod release.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/canon-flow-perf.mjs')
const HELPER = join(ROOT, 'qa/e2e/lib/canon-flow-perf.mjs')

type SelfReport = {
  ok: boolean
  status: string
  failures: string[]
  cases: Record<string, string>
  targetGate?: string
}

async function load<T>(abs: string): Promise<T> {
  return (await import(pathToFileURL(abs).href)) as T
}

describe('canon-flow-perf — file presence', () => {
  it('ships flow harness + optional helper', () => {
    expect(existsSync(FLOW), FLOW).toBe(true)
    expect(existsSync(HELPER), HELPER).toBe(true)
  })
})

describe('canon-flow-perf helper pure contracts', () => {
  it('runHelperSelfTest passes with positive+negative coverage', async () => {
    const m = await load<{
      runHelperSelfTest: () => SelfReport
      TARGET_GATE: string
      DEFAULT_THRESHOLDS: { panFrameP95Ms: number; firstInteractivePaintMs: number; minRenderedNodes: number }
      NATIVE_PUBLIC_BACKEND_FEATURE_COUNT: number
      generateScaleGraphFixture: (o?: object) => {
        graph: { nodes: unknown[]; edges: unknown[] }
        payloadSha256: string
        payloadBytes: number
      }
      generateScaleDataBundle: (o?: object) => {
        bundle: object
        config: { featureTotal: number; expectedProjectModeNodes: number }
        payloadBytes: number
        payloadSha256: string
      }
      evaluateFrameP95: (i: object) => { pass: boolean; reason: string | null }
      evaluateFirstInteractivePaint: (i: object) => { pass: boolean }
      evaluateCanvasRedraw: (i: object) => {
        pass: boolean
        observeOnly?: boolean
        productRedrawSampled?: boolean
      }
      evaluateHeapPayload: (i: object) => {
        pass: boolean
        payloadObserveOnly?: boolean
        payloadSource?: string | null
      }
      evaluateRenderedNodes: (i: object) => { pass: boolean; minRenderedNodes: number }
      classifyPerfRunStatus: (i: object) => {
        functionalPass: boolean
        status: string
        gateOmitted?: boolean
        failedGate?: string
      }
      proveFixtureInjection: (i: object) => {
        proven: boolean
        method: string | null
        reason: string | null
      }
      resolveHonestMinRenderedNodes: (o?: object) => number
      looksLikeDataBundle: (v: unknown) => boolean
      looksLikeGraph: (v: unknown) => boolean
      estimateRenderedGraph: (b: object, mode?: string) => { nodes: number }
      percentile: (a: number[], p: number) => number | null
    }>(HELPER)

    const r = m.runHelperSelfTest()
    expect(r.ok).toBe(true)
    expect(r.status).toBe('HARNESS_READY')
    expect(r.failures).toEqual([])
    expect(m.TARGET_GATE).toBe('TM_CANON_FLOW_PERF_HARNESS_READY')
    expect(m.DEFAULT_THRESHOLDS.panFrameP95Ms).toBe(50)
    expect(m.DEFAULT_THRESHOLDS.firstInteractivePaintMs).toBe(3500)
    expect(m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT).toBe(41)
    expect(m.DEFAULT_THRESHOLDS.minRenderedNodes).toBeGreaterThan(
      m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    )

    const g1 = m.generateScaleGraphFixture({ nodeCount: 40, edgeCount: 50, seed: 'u' })
    const g2 = m.generateScaleGraphFixture({ nodeCount: 40, edgeCount: 50, seed: 'u' })
    expect(g1.graph.nodes).toHaveLength(40)
    expect(g1.payloadSha256).toBe(g2.payloadSha256)
    expect(g1.payloadBytes).toBeGreaterThan(100)
    expect(m.looksLikeGraph(g1.graph)).toBe(true)

    const b = m.generateScaleDataBundle({ featuresPerProject: 7, seed: 'u' })
    expect(m.looksLikeDataBundle(b.bundle)).toBe(true)
    expect(b.config.expectedProjectModeNodes).toBe(7)
    expect(m.estimateRenderedGraph(b.bundle, 'rn').nodes).toBe(7)

    // Negative: missing frame samples fail closed
    expect(m.evaluateFrameP95({ framesMs: [], gesture: 'pan' }).pass).toBe(false)
    expect(m.evaluateFirstInteractivePaint({}).pass).toBe(false)

    // No fake PASS without server/auth
    expect(m.classifyPerfRunStatus({ serverReachable: false }).functionalPass).toBe(false)
    expect(
      m.classifyPerfRunStatus({ serverReachable: true, authOk: false }).status,
    ).toBe('AUTH')

    expect(m.percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)).toBe(10)
    expect(m.percentile([], 95)).toBeNull()
  })

  it('classify requires all affirmative keys; omitted keys fail', async () => {
    const m = await load<{
      classifyPerfRunStatus: (i: object) => {
        functionalPass: boolean
        status: string
        gateOmitted?: boolean
        failedGate?: string
      }
    }>(HELPER)

    // Only allThresholdsPass true → must NOT PASS (omitted gates)
    const omitted = m.classifyPerfRunStatus({ allThresholdsPass: true })
    expect(omitted.functionalPass).toBe(false)
    expect(omitted.status).not.toBe('PASS')
    expect(omitted.gateOmitted).toBe(true)

    // fixtureInjected omitted with everything else true
    const noFixtureKey = m.classifyPerfRunStatus({
      serverReachable: true,
      authOk: true,
      landedOnFlow: true,
      metricsComplete: true,
      allThresholdsPass: true,
    })
    expect(noFixtureKey.functionalPass).toBe(false)
    expect(noFixtureKey.failedGate).toBe('fixtureInjected')
    expect(noFixtureKey.gateOmitted).toBe(true)

    // All affirmative → PASS
    const ok = m.classifyPerfRunStatus({
      serverReachable: true,
      authOk: true,
      landedOnFlow: true,
      fixtureInjected: true,
      metricsComplete: true,
      allThresholdsPass: true,
    })
    expect(ok.functionalPass).toBe(true)
    expect(ok.status).toBe('PASS')
  })

  it('fixture injection rejects routeHits=0 + native backend 41', async () => {
    const m = await load<{
      NATIVE_PUBLIC_BACKEND_FEATURE_COUNT: number
      proveFixtureInjection: (i: object) => {
        proven: boolean
        reason: string | null
        method: string | null
      }
    }>(HELPER)

    const native = m.proveFixtureInjection({
      routeHits: 0,
      renderedNodeCount: m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
      markerHeaderVerified: false,
    })
    expect(native.proven).toBe(false)
    expect(String(native.reason)).toMatch(/native_node_count_alone_insufficient|routeHits=0/)

    // SSR non-intercept: nodes present, no route, no DOM marker
    const ssr = m.proveFixtureInjection({
      routeHits: 0,
      renderedNodeCount: 80,
      markerHeaderVerified: false,
      domMarkerVerified: false,
    })
    expect(ssr.proven).toBe(false)

    // Route hit + marker + hash → proven
    const route = m.proveFixtureInjection({
      routeHits: 2,
      markerHeaderVerified: true,
      responseFixtureHash: 'abc',
      expectedFixtureHash: 'abc',
    })
    expect(route.proven).toBe(true)
    expect(route.method).toBe('route_hit_with_marker')

    // DOM PERF marker bound to fixture → proven without route
    const dom = m.proveFixtureInjection({
      routeHits: 0,
      domMarkerVerified: true,
      domMarkerBoundToFixtureHash: true,
      perfFixtureNodeCount: 20,
    })
    expect(dom.proven).toBe(true)
    expect(dom.method).toBe('dom_marker_fixture_bound')
  })

  it('honest min nodes never auto-lowers below native floor; canvas/payload observe-only', async () => {
    const m = await load<{
      NATIVE_PUBLIC_BACKEND_FEATURE_COUNT: number
      DEFAULT_THRESHOLDS: { minRenderedNodes: number; payloadBytesMax: number }
      resolveHonestMinRenderedNodes: (o?: object) => number
      evaluateCanvasRedraw: (i: object) => {
        pass: boolean
        observeOnly?: boolean
      }
      evaluateHeapPayload: (i: object) => {
        pass: boolean
        payloadObserveOnly?: boolean
        payloadSource?: string | null
      }
      evaluateRenderedNodes: (i: object) => { pass: boolean; minRenderedNodes: number }
    }>(HELPER)

    const soft = m.resolveHonestMinRenderedNodes({ minRenderedNodes: 10 })
    expect(soft).toBeGreaterThan(m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT)
    expect(soft).toBeGreaterThanOrEqual(m.DEFAULT_THRESHOLDS.minRenderedNodes)

    // Native 41 alone must not clear rendered-node floor
    const nativeNodes = m.evaluateRenderedNodes({
      renderedNodeCount: m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    })
    expect(nativeNodes.pass).toBe(false)
    expect(nativeNodes.minRenderedNodes).toBeGreaterThan(m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT)

    // Soft/empty canvas → observe-only (not fail)
    const softCanvas = m.evaluateCanvasRedraw({})
    expect(softCanvas.observeOnly).toBe(true)
    expect(softCanvas.pass).toBe(true)

    // Local payload is not wire
    const local = m.evaluateHeapPayload({
      payloadBytes: 12_000,
      payloadSource: 'local',
    })
    expect(local.payloadObserveOnly).toBe(true)
    expect(local.payloadSource).toBe('local')
    expect(local.pass).toBe(true)

    // Wire payload missing fails closed
    const wireMissing = m.evaluateHeapPayload({ payloadSource: 'wire' })
    expect(wireMissing.pass).toBe(false)

    // Wire over budget fails
    const wireOver = m.evaluateHeapPayload({
      payloadSource: 'wire',
      payloadBytes: m.DEFAULT_THRESHOLDS.payloadBytesMax + 1,
    })
    expect(wireOver.pass).toBe(false)
  })
})

describe('canon-flow-perf flow self-test', () => {
  it('runSelfTest + planPerfRun contracts', async () => {
    const m = await load<{
      runSelfTest: () => SelfReport
      planPerfRun: (o?: object) => {
        route: string
        targetGate: string
        fullSha: string | null
        steps: unknown[]
        thresholds: { panFrameP95Ms: number; minRenderedNodes: number }
        fixture: {
          injection: {
            productionDb: boolean
            proofRequired?: string
            nativePublicBackendFeatureCount?: number
          }
          dataBundle: { payloadBytes: number }
        }
        baselineBlessForbidden: boolean
        autoReplaceForbidden: boolean
        honestMinRenderedNodes?: number
      }
      evaluateAllPerfMetrics: (
        metrics: object,
        thresholds?: object,
      ) => { pass: boolean; failures: string[] }
      proveFixtureInjection: (i: object) => { proven: boolean }
      NATIVE_PUBLIC_BACKEND_FEATURE_COUNT: number
      PERF_STEPS: unknown[]
      TARGET_GATE: string
      flowRoute: (boardId?: string) => string
    }>(FLOW)

    const r = m.runSelfTest()
    expect(r.ok).toBe(true)
    expect(r.status).toBe('HARNESS_READY')
    expect(r.failures).toEqual([])
    expect(m.TARGET_GATE).toBe('TM_CANON_FLOW_PERF_HARNESS_READY')
    expect(m.PERF_STEPS.length).toBeGreaterThanOrEqual(10)
    expect(m.flowRoute('mfs-rebuild')).toBe('/b/mfs-rebuild/alur')

    // Adversarial case keys from self-test
    expect(r.cases.classifyOmittedKeys).toBe('PASS')
    expect(r.cases.injectionNativeNeg).toBe('PASS')
    expect(r.cases.canvasObserveOnly).toBe('PASS')
    expect(r.cases.localPayloadObserveOnly).toBe('PASS')
    expect(r.cases.honestFloor).toBe('PASS')

    const sha = 'd'.repeat(40)
    const plan = m.planPerfRun({ boardId: 'mfs-rebuild', fullSha: sha })
    expect(plan.route).toBe('/b/mfs-rebuild/alur')
    expect(plan.fullSha).toBe(sha)
    expect(plan.targetGate).toBe('TM_CANON_FLOW_PERF_HARNESS_READY')
    expect(plan.baselineBlessForbidden).toBe(true)
    expect(plan.autoReplaceForbidden).toBe(true)
    expect(plan.fixture.injection.productionDb).toBe(false)
    expect(plan.fixture.injection.nativePublicBackendFeatureCount).toBe(41)
    expect(plan.fixture.dataBundle.payloadBytes).toBeGreaterThan(0)
    expect(plan.thresholds.panFrameP95Ms).toBe(50)
    expect(plan.thresholds.minRenderedNodes).toBeGreaterThan(m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT)
    expect(plan.steps.length).toBe(m.PERF_STEPS.length)

    // Fail-closed aggregate
    expect(m.evaluateAllPerfMetrics({}).pass).toBe(false)

    // Native injection false proof
    expect(
      m.proveFixtureInjection({
        routeHits: 0,
        renderedNodeCount: m.NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
      }).proven,
    ).toBe(false)
  })

  it('CLI --self-test exits 0 with HARNESS_READY', () => {
    const out = execFileSync(process.execPath, [FLOW, '--self-test'], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    const j = JSON.parse(out) as SelfReport
    expect(j.ok).toBe(true)
    expect(j.status).toBe('HARNESS_READY')
    // Positive + negative case keys present
    expect(j.cases.metricsPos).toBe('PASS')
    expect(j.cases.metricsNeg).toBe('PASS')
    expect(j.cases.noFakePass).toBe('PASS')
    expect(j.cases.classifyOmittedKeys).toBe('PASS')
    expect(j.cases.injectionNativeNeg).toBe('PASS')
    expect(j.cases.canvasObserveOnly).toBe('PASS')
    expect(j.cases.localPayloadObserveOnly).toBe('PASS')
    expect(j.cases.honestFloor).toBe('PASS')
  })

  it('CLI --plan exits 0 offline with FULL_SHA', () => {
    const sha = 'a'.repeat(40)
    const out = execFileSync(process.execPath, [FLOW, '--plan'], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env, FULL_SHA: sha },
    })
    const plan = JSON.parse(out) as {
      fullSha: string
      route: string
      thresholds: { minRenderedNodes: number }
      fixture: {
        injection: {
          productionDb: boolean
          proofRequired?: string
          nativePublicBackendFeatureCount?: number
        }
      }
    }
    expect(plan.fullSha).toBe(sha)
    expect(plan.route).toMatch(/\/alur$/)
    expect(plan.fixture.injection.productionDb).toBe(false)
    expect(plan.fixture.injection.nativePublicBackendFeatureCount).toBe(41)
    expect(plan.thresholds.minRenderedNodes).toBeGreaterThan(41)
    expect(plan.thresholds).toBeTruthy()
  })

  it('CLI --plan fails closed when FULL_SHA is invalid', () => {
    let code = 0
    try {
      execFileSync(process.execPath, [FLOW, '--plan'], {
        encoding: 'utf8',
        cwd: ROOT,
        env: { ...process.env, FULL_SHA: 'not-a-sha' },
      })
      code = 0
    } catch (e: unknown) {
      const err = e as { status?: number }
      code = err.status ?? 1
    }
    expect(code).not.toBe(0)
  })
})

describe('canon-flow-perf thresholds vocabulary', () => {
  it('helper source declares explicit fail-closed thresholds and no baseline bless', async () => {
    const { readFileSync } = await import('node:fs')
    const helperSrc = readFileSync(HELPER, 'utf8')
    const flowSrc = readFileSync(FLOW, 'utf8')
    expect(helperSrc).toContain('firstInteractivePaintMs')
    expect(helperSrc).toContain('panFrameP95Ms')
    expect(helperSrc).toContain('dragFrameP95Ms')
    expect(helperSrc).toContain('longTaskMaxMs')
    expect(helperSrc).toContain('canvasRedrawMs')
    expect(helperSrc).toContain('heapUsedMbMax')
    expect(helperSrc).toContain('payloadBytesMax')
    expect(helperSrc).toContain('missing_')
    expect(helperSrc).toContain('no fake PASS')
    expect(helperSrc).toContain('proveFixtureInjection')
    expect(helperSrc).toContain('resolveHonestMinRenderedNodes')
    expect(helperSrc).toContain('CLASSIFY_REQUIRED_AFFIRMATIVE_KEYS')
    expect(helperSrc).toContain('payloadObserveOnly')
    expect(helperSrc).toContain('productRedrawSampled')
    expect(flowSrc).toContain('BASELINE_BLESS_FORBIDDEN')
    expect(flowSrc).toContain('--self-test')
    expect(flowSrc).toContain('--plan')
    expect(flowSrc).toContain('--run')
    expect(flowSrc).toContain('WEB_BASE')
    expect(flowSrc).toContain('FULL_SHA')
    expect(flowSrc).toContain('proveFixtureInjection')
    expect(flowSrc).not.toContain('nearExpected')
    expect(flowSrc).not.toContain('lt.longTasks.length >= 0')
    expect(flowSrc).not.toContain('blessBaseline(true)')
  })
})
