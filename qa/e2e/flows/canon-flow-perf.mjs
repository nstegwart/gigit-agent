#!/usr/bin/env node
/**
 * C-FLOW-PERF — deterministic Playwright/Node harness for large-graph performance.
 *
 * Measures (when live):
 *   - configurable synthetic node/edge fixture injection (no production DB)
 *   - first interactive paint (nav → flow nodes visible)
 *   - pan / drag p95 frame intervals (rAF samples)
 *   - long tasks (PerformanceObserver)
 *   - canvas edge redraw timing
 *   - heap (when engine exposes) + fixture payload bytes
 *
 * Modes:
 *   --self-test   pure contracts + positive/negative evaluators (no server / browser)
 *   --plan        emit measurement plan + thresholds + fixture config JSON
 *   --run         live Chromium against WEB_BASE (auth storageState when present)
 *
 * Env:
 *   WEB_BASE, BOARD_ID, FULL_SHA (required for --run evidence), HEADED
 *   CAIRN_E2E_AUTH_STORAGE_PATH / PLAYWRIGHT_STORAGE_STATE
 *   CANON_FLOW_PERF_NODES, CANON_FLOW_PERF_EDGES, CANON_FLOW_PERF_FEATURES_PER_PROJECT
 *   CANON_FLOW_PERF_SEED, CANON_FLOW_PERF_*_MS budgets (see lib/canon-flow-perf.mjs)
 *   CANON_FLOW_PERF_SERVERFN_BUNDLE_ID / CANON_FLOW_PERF_SERVERFN_GRAPH_ID
 *
 * Fail-closed: missing server/auth/samples → never functional PASS.
 * Does NOT bless visual baselines (N/A for perf; autoReplaceForbidden retained).
 *
 * Usage:
 *   node qa/e2e/flows/canon-flow-perf.mjs --self-test
 *   FULL_SHA=$(git rev-parse HEAD) node qa/e2e/flows/canon-flow-perf.mjs --plan
 *   WEB_BASE=… FULL_SHA=… node qa/e2e/flows/canon-flow-perf.mjs --run
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTH_STORAGE_STATE_PATH,
  requireExistingStorageState,
} from '../lib/auth.mjs'
import {
  assertFullSha,
  isFullSha,
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveWebBase,
} from '../lib/env.mjs'
import {
  CANON_FLOW_SELECTORS,
  DEFAULT_THRESHOLDS,
  FIXTURE_HASH_HEADER,
  FIXTURE_ID_PREFIX,
  FIXTURE_MARKER_HEADER,
  FIXTURE_MARKER_VALUE,
  NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
  TARGET_GATE as HELPER_TARGET_GATE,
  classifyPerfRunStatus,
  evaluateAllPerfMetrics,
  generateScaleDataBundle,
  generateScaleGraphFixture,
  looksLikeDataBundle,
  looksLikeGraph,
  percentile,
  proveFixtureInjection,
  resolveFixtureConfig,
  resolveHonestMinRenderedNodes,
  resolveServerFnIds,
  resolveThresholds,
  runHelperSelfTest,
  estimateRenderedGraph,
} from '../lib/canon-flow-perf.mjs'
import { DEFAULT_BOARD, flowRoute as staticFlowRoute } from './canon-flow-static-fidelity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'canon-flow-perf'
const OUT_DIR = path.resolve(__dirname, '../out/runtime')

export const TARGET_GATE = HELPER_TARGET_GATE
export const AUTO_REPLACE_FORBIDDEN = true
export const BASELINE_BLESS_FORBIDDEN = true

export {
  CANON_FLOW_SELECTORS,
  DEFAULT_THRESHOLDS,
  FIXTURE_HASH_HEADER,
  FIXTURE_ID_PREFIX,
  FIXTURE_MARKER_HEADER,
  FIXTURE_MARKER_VALUE,
  NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
  classifyPerfRunStatus,
  evaluateAllPerfMetrics,
  generateScaleDataBundle,
  generateScaleGraphFixture,
  percentile,
  proveFixtureInjection,
  resolveFixtureConfig,
  resolveHonestMinRenderedNodes,
  resolveThresholds,
  runHelperSelfTest,
}

export function flowRoute(boardId = resolveBoardId(DEFAULT_BOARD)) {
  return staticFlowRoute(boardId)
}

/**
 * Ordered measurement steps for plan/live.
 */
export const PERF_STEPS = Object.freeze([
  {
    id: 'P0',
    name: 'resolve_fixture',
    desc: 'Build synthetic data-bundle + graph fixture (no production DB)',
  },
  {
    id: 'P1',
    name: 'install_route_injection',
    desc: 'Playwright route fulfill /flow-data/* and /_serverFn/* for scale fixtures',
  },
  {
    id: 'P2',
    name: 'navigate_alur',
    desc: 'Authenticated goto /b/$board/alur; fail-closed on /login',
  },
  {
    id: 'P3',
    name: 'first_interactive_paint',
    desc: 'Time until flow nodes interactive (canon selectors)',
  },
  {
    id: 'P4',
    name: 'switch_scale_mode',
    desc: 'Prefer project mode (backend/rn) for large feature-driven graph',
  },
  {
    id: 'P5',
    name: 'pan_frame_p95',
    desc: 'Empty-stage pan ~300px; rAF frame intervals → p95',
  },
  {
    id: 'P6',
    name: 'drag_frame_p95',
    desc: 'Node drag ~120px; rAF frame intervals → p95',
  },
  {
    id: 'P7',
    name: 'long_tasks',
    desc: 'PerformanceObserver longtask during gestures window',
  },
  {
    id: 'P8',
    name: 'canvas_redraw',
    desc: 'Canvas observe-only unless real product edge redraw is sampled',
  },
  {
    id: 'P9',
    name: 'heap_payload',
    desc: 'Heap observe + wire intercepted payload bytes (local generator bytes observe-only)',
  },
  {
    id: 'P10',
    name: 'threshold_gate',
    desc: 'Evaluate explicit thresholds fail-closed; emit receipt JSON',
  },
])

/**
 * Plan object (no I/O beyond env/SHA resolution).
 */
export function planPerfRun(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const fullShaRaw = opts.fullSha ?? resolveFullSha({ cwd: ROOT })
  const fullSha = isFullSha(fullShaRaw) ? fullShaRaw.toLowerCase() : null
  const fixture = resolveFixtureConfig(opts.fixture || {})
  const thresholds = resolveThresholds(opts.thresholds || {})
  const serverFnIds = resolveServerFnIds(opts.serverFnIds || {})
  const bundlePreview = generateScaleDataBundle(fixture)
  const graphPreview = generateScaleGraphFixture(fixture)
  const estBackend = estimateRenderedGraph(bundlePreview.bundle, 'backend')

  return {
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    route,
    boardId,
    fullSha,
    fullShaRequiredForEvidence: true,
    autoReplaceForbidden: AUTO_REPLACE_FORBIDDEN,
    baselineBlessForbidden: BASELINE_BLESS_FORBIDDEN,
    selectors: { ...CANON_FLOW_SELECTORS },
    steps: PERF_STEPS.map((s) => ({ ...s })),
    fixture: {
      ...fixture,
      dataBundle: {
        featureTotal: bundlePreview.config.featureTotal,
        expectedProjectModeNodes: bundlePreview.config.expectedProjectModeNodes,
        payloadBytes: bundlePreview.payloadBytes,
        payloadSha256: bundlePreview.payloadSha256,
      },
      graph: {
        nodeCount: graphPreview.config.nodeCount,
        edgeCount: graphPreview.config.edgeCount,
        payloadBytes: graphPreview.payloadBytes,
        payloadSha256: graphPreview.payloadSha256,
      },
      estimateBackend: estBackend,
      injection: {
        staticPaths: ['/flow-data/data-bundle.json', '/flow-data/graph.json'],
        serverFnPaths: [
          `/_serverFn/${serverFnIds.getFlowDataBundleFn}`,
          `/_serverFn/${serverFnIds.getFlowGraphFn}`,
        ],
        productionDb: false,
        proofRequired: 'route_hit_with_marker_or_dom_PERF_marker',
        markerHeader: FIXTURE_MARKER_HEADER,
        hashHeader: FIXTURE_HASH_HEADER,
        fixtureIdPrefix: FIXTURE_ID_PREFIX,
        nativePublicBackendFeatureCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
        note:
          'Synthetic fixtures only — never loads production DB. Native node count alone never proves injection.',
      },
    },
    thresholds,
    honestMinRenderedNodes: resolveHonestMinRenderedNodes({
      minRenderedNodes: thresholds.minRenderedNodes,
    }),
    metrics: [
      'firstInteractivePaintMs',
      'panFrameP95Ms',
      'dragFrameP95Ms',
      'longTaskMaxMs',
      'longTaskCount',
      'canvasRedrawMs (observe-only unless productRedrawSampled)',
      'heapUsedMb',
      'payloadBytes (wire only; local observe-only)',
      'renderedNodeCount',
    ],
    offlineStatus: 'HARNESS_READY',
    liveWithoutServer: 'LOCAL_ONLY',
    note:
      'Live PASS requires --run against WEB_BASE + auth + proven fixture injection (route marker or DOM PERF- hash-bound) + complete metrics within thresholds. No baseline bless. No native-41 false proof.',
  }
}

/**
 * Contract self-test (no browser). Positive + negative.
 */
export function runSelfTest() {
  const failures = []
  const cases = {}

  const helper = runHelperSelfTest()
  if (!helper.ok) {
    failures.push(...helper.failures.map((f) => `helper:${f}`))
    cases.helper = 'FAIL'
  } else {
    cases.helper = 'PASS'
  }

  if (PERF_STEPS.length < 10) {
    failures.push('PERF_STEPS incomplete')
    cases.steps = 'FAIL'
  } else {
    cases.steps = 'PASS'
  }

  const plan = planPerfRun({
    boardId: DEFAULT_BOARD,
    fullSha: 'c'.repeat(40),
    fixture: { nodeCount: 30, edgeCount: 40, featuresPerProject: 15, seed: 'self' },
  })
  if (plan.route !== `/b/${DEFAULT_BOARD}/alur`) {
    failures.push(`plan route ${plan.route}`)
    cases.planRoute = 'FAIL'
  } else {
    cases.planRoute = 'PASS'
  }
  if (plan.fullSha !== 'c'.repeat(40)) {
    failures.push('plan fullSha')
    cases.planSha = 'FAIL'
  } else {
    cases.planSha = 'PASS'
  }
  if (plan.baselineBlessForbidden !== true || plan.autoReplaceForbidden !== true) {
    failures.push('baseline bless must be forbidden')
    cases.noBless = 'FAIL'
  } else {
    cases.noBless = 'PASS'
  }
  if (plan.fixture.injection.productionDb !== false) {
    failures.push('must declare no production DB')
    cases.noProdDb = 'FAIL'
  } else {
    cases.noProdDb = 'PASS'
  }

  // Positive: complete good metrics → pass (wire payload; canvas soft observe-only OK)
  const good = evaluateAllPerfMetrics(
    {
      firstInteractivePaintMs: 900,
      panFramesMs: Array.from({ length: 30 }, () => 14),
      dragFramesMs: Array.from({ length: 30 }, () => 16),
      longTasks: [{ duration: 20 }],
      longTaskCount: 1,
      longTaskMaxMs: 20,
      longTasksObserved: true,
      canvasRedrawMs: 25,
      // productRedrawSampled omitted → canvas observe-only
      heapUsedMb: 120,
      payloadBytes: 50_000,
      payloadSource: 'wire',
      renderedNodeCount: 80,
    },
    resolveThresholds({ minRenderedNodes: 50 }),
  )
  if (!good.pass) {
    failures.push(`good metrics should pass: ${good.failures.join(',')}`)
    cases.metricsPos = 'FAIL'
  } else {
    cases.metricsPos = 'PASS'
  }

  // Negative: missing metrics → fail closed
  const missing = evaluateAllPerfMetrics({})
  if (missing.pass) {
    failures.push('missing metrics must fail closed')
    cases.metricsNeg = 'FAIL'
  } else {
    cases.metricsNeg = 'PASS'
  }

  // Negative: over budget (wire payload + product canvas)
  const over = evaluateAllPerfMetrics({
    firstInteractivePaintMs: 99_000,
    panFrameP95Ms: 200,
    dragFrameP95Ms: 200,
    longTaskMaxMs: 500,
    longTaskCount: 50,
    longTasksObserved: true,
    canvasRedrawMs: 500,
    productRedrawSampled: true,
    heapUsedMb: 9000,
    payloadBytes: DEFAULT_THRESHOLDS.payloadBytesMax + 99,
    payloadSource: 'wire',
    renderedNodeCount: 1,
  })
  if (over.pass) {
    failures.push('over-budget must fail')
    cases.metricsOver = 'FAIL'
  } else {
    cases.metricsOver = 'PASS'
  }

  // classify negatives: explicit false + omitted keys
  const clsServer = classifyPerfRunStatus({ serverReachable: false })
  const clsAuth = classifyPerfRunStatus({ serverReachable: true, authOk: false })
  const clsOmitted = classifyPerfRunStatus({ allThresholdsPass: true })
  const clsOmittedFixture = classifyPerfRunStatus({
    serverReachable: true,
    authOk: true,
    landedOnFlow: true,
    metricsComplete: true,
    allThresholdsPass: true,
  })
  const clsAllOk = classifyPerfRunStatus({
    serverReachable: true,
    authOk: true,
    landedOnFlow: true,
    fixtureInjected: true,
    metricsComplete: true,
    allThresholdsPass: true,
  })
  if (
    clsServer.functionalPass ||
    clsAuth.functionalPass ||
    clsOmitted.functionalPass ||
    clsOmittedFixture.functionalPass ||
    !clsAllOk.functionalPass
  ) {
    failures.push('no fake PASS without affirmative server/auth/injection/metrics')
    cases.noFakePass = 'FAIL'
  } else {
    cases.noFakePass = 'PASS'
  }
  if (clsOmitted.functionalPass || clsOmittedFixture.gateOmitted !== true) {
    failures.push('omitted classify keys must fail')
    cases.classifyOmittedKeys = 'FAIL'
  } else {
    cases.classifyOmittedKeys = 'PASS'
  }

  // Fixture injection: routeHits=0 + native backend 41 → unproven
  const nativeUnproven = proveFixtureInjection({
    routeHits: 0,
    renderedNodeCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    markerHeaderVerified: false,
  })
  const ssrNonIntercept = proveFixtureInjection({
    routeHits: 0,
    renderedNodeCount: 80,
    markerHeaderVerified: false,
    domMarkerVerified: false,
  })
  const routeProven = proveFixtureInjection({
    routeHits: 1,
    markerHeaderVerified: true,
    responseFixtureHash: 'deadbeef',
    expectedFixtureHash: 'deadbeef',
  })
  if (nativeUnproven.proven || ssrNonIntercept.proven || !routeProven.proven) {
    failures.push('injection proof must reject native/SSR-non-intercept')
    cases.injectionNativeNeg = 'FAIL'
  } else {
    cases.injectionNativeNeg = 'PASS'
  }

  // Soft canvas + local payload not wire
  const softCanvas = good.results.canvasRedraw
  if (!softCanvas.observeOnly || softCanvas.productRedrawSampled === true) {
    failures.push('empty/soft canvas must be observe-only')
    cases.canvasObserveOnly = 'FAIL'
  } else {
    cases.canvasObserveOnly = 'PASS'
  }
  const localPayload = evaluateAllPerfMetrics(
    {
      firstInteractivePaintMs: 900,
      panFramesMs: Array.from({ length: 30 }, () => 14),
      dragFramesMs: Array.from({ length: 30 }, () => 16),
      longTasks: [],
      longTaskCount: 0,
      longTaskMaxMs: 0,
      longTasksObserved: true,
      payloadBytes: 50_000,
      payloadSource: 'local',
      localPayloadBytes: 50_000,
      renderedNodeCount: 80,
    },
    resolveThresholds({ minRenderedNodes: 50 }),
  )
  if (
    !localPayload.results.heapPayload.payloadObserveOnly ||
    localPayload.results.heapPayload.payloadSource !== 'local'
  ) {
    failures.push('local payload must be observe-only not wire')
    cases.localPayloadObserveOnly = 'FAIL'
  } else {
    cases.localPayloadObserveOnly = 'PASS'
  }

  // Honest floor > native 41; cannot auto-lower to 10
  const floor = resolveHonestMinRenderedNodes({ minRenderedNodes: 10 })
  if (floor <= NATIVE_PUBLIC_BACKEND_FEATURE_COUNT || floor < DEFAULT_THRESHOLDS.minRenderedNodes) {
    failures.push('min rendered nodes must exceed native and respect honest floor')
    cases.honestFloor = 'FAIL'
  } else {
    cases.honestFloor = 'PASS'
  }

  // fixture shape guards
  const bundle = generateScaleDataBundle({ featuresPerProject: 5, seed: 'x' })
  const graph = generateScaleGraphFixture({ nodeCount: 8, edgeCount: 10, seed: 'x' })
  if (!looksLikeDataBundle(bundle.bundle) || !looksLikeGraph(graph.graph)) {
    failures.push('fixture shape')
    cases.fixtureShape = 'FAIL'
  } else {
    cases.fixtureShape = 'PASS'
  }
  // Synthetic ids use PERF- prefix (distinct from native public bundle)
  const sampleFeat = bundle.bundle.features?.backend?.[0]?.id || ''
  if (!String(sampleFeat).startsWith(FIXTURE_ID_PREFIX)) {
    failures.push('fixture ids must use PERF- prefix for DOM marker proof')
    cases.fixturePerfIds = 'FAIL'
  } else {
    cases.fixturePerfIds = 'PASS'
  }

  // selectors present
  if (!CANON_FLOW_SELECTORS.flowNode || !CANON_FLOW_SELECTORS.flowStage) {
    failures.push('selectors incomplete')
    cases.selectors = 'FAIL'
  } else {
    cases.selectors = 'PASS'
  }

  return {
    ok: failures.length === 0,
    mode: 'self-test',
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    cases,
    failures,
    helperCases: helper.cases,
    status: failures.length === 0 ? 'HARNESS_READY' : 'FAIL',
    nativePublicBackendFeatureCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    honestMinRenderedNodes: resolveHonestMinRenderedNodes({}),
  }
}

function hasFlag(name) {
  return process.argv.includes(name)
}

function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return fallback
}

function resolveStorageStatePath() {
  return (
    process.env.CAIRN_E2E_AUTH_STORAGE_PATH?.trim() ||
    process.env.PLAYWRIGHT_STORAGE_STATE?.trim() ||
    AUTH_STORAGE_STATE_PATH
  )
}

/**
 * Soft probe WEB_BASE — fail closed classification when unreachable.
 */
async function probeServer(base, timeoutMs = 4_000) {
  try {
    const ctrl = new AbortController()
    const t = setTimeout(() => ctrl.abort(), timeoutMs)
    const res = await fetch(`${base}/api/healthz`, {
      signal: ctrl.signal,
      redirect: 'manual',
    }).catch(async () => {
      // healthz optional — try origin root
      return fetch(base, { signal: ctrl.signal, redirect: 'manual' })
    })
    clearTimeout(t)
    return { ok: Boolean(res), status: res?.status ?? null }
  } catch (e) {
    return { ok: false, status: null, error: String(e?.message || e) }
  }
}

/**
 * Install Playwright routes that fulfill synthetic fixtures (no production DB).
 * Emits verifiable marker + fixture-hash headers; tracks wire bytes of fulfilled bodies.
 * @returns {{
 *   injectedPaths: string[]
 *   serverFnIds: object
 *   wireBytes: number
 *   markerHeaderSet: boolean
 *   fixtureHash: string
 * }}
 */
async function installFixtureRoutes(page, bundleFixture, graphFixture) {
  const serverFnIds = resolveServerFnIds()
  const bundleBody = JSON.stringify(bundleFixture.bundle)
  const graphBody = JSON.stringify(graphFixture.graph)
  const fixtureHash = String(bundleFixture.payloadSha256 || '')
  const injectedPaths = []
  let wireBytes = 0
  let markerHeaderSet = false

  const fulfillJson = async (route, body) => {
    injectedPaths.push(route.request().url())
    wireBytes += Buffer.byteLength(body, 'utf8')
    markerHeaderSet = true
    await route.fulfill({
      status: 200,
      contentType: 'application/json; charset=utf-8',
      body,
      headers: {
        'cache-control': 'no-store',
        [FIXTURE_MARKER_HEADER]: FIXTURE_MARKER_VALUE,
        [FIXTURE_HASH_HEADER]: fixtureHash,
      },
    })
  }

  await page.route('**/flow-data/data-bundle.json', (route) => fulfillJson(route, bundleBody))
  await page.route('**/flow-data/graph.json', (route) => fulfillJson(route, graphBody))

  // Single /_serverFn handler (Playwright last-registered wins — avoid stacked catch-alls).
  // Known ids fulfilled immediately; others inspected and rewritten when shape matches.
  await page.route('**/_serverFn/**', async (route) => {
    const url = route.request().url()
    if (url.includes(serverFnIds.getFlowDataBundleFn)) {
      return fulfillJson(route, bundleBody)
    }
    if (url.includes(serverFnIds.getFlowGraphFn)) {
      return fulfillJson(route, graphBody)
    }
    try {
      const res = await route.fetch()
      const text = await res.text()
      if (looksLikeDataBundle(text)) {
        return fulfillJson(route, bundleBody)
      }
      if (looksLikeGraph(text)) {
        return fulfillJson(route, graphBody)
      }
      return route.fulfill({
        status: res.status(),
        headers: res.headers(),
        body: text,
      })
    } catch {
      return route.continue()
    }
  })

  return {
    injectedPaths,
    serverFnIds,
    wireBytes,
    markerHeaderSet,
    fixtureHash,
  }
}

/**
 * Browser-side: install longtask observer + rAF helpers.
 */
async function installPerfProbes(page) {
  await page.addInitScript(() => {
    window.__canonFlowPerf = {
      longTasks: [],
      frames: [],
      longTaskObserverOk: false,
    }
    try {
      const po = new PerformanceObserver((list) => {
        for (const e of list.getEntries()) {
          window.__canonFlowPerf.longTasks.push({
            name: e.name,
            duration: e.duration,
            startTime: e.startTime,
          })
        }
      })
      po.observe({ type: 'longtask', buffered: true })
      window.__canonFlowPerf.longTaskObserverOk = true
      window.__canonFlowPerf._ltPo = po
    } catch {
      window.__canonFlowPerf.longTaskObserverOk = false
    }
  })
}

/**
 * Collect rAF frame intervals while running an async gesture callback in page.
 */
async function measureFramesDuring(page, durationMs, gestureFn) {
  await page.evaluate(() => {
    window.__canonFlowPerf.frames = []
    window.__canonFlowPerf._rafActive = true
    let last = performance.now()
    const tick = (now) => {
      if (!window.__canonFlowPerf._rafActive) return
      window.__canonFlowPerf.frames.push(now - last)
      last = now
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
  })

  await gestureFn()
  await page.waitForTimeout(Math.min(50, durationMs))

  const frames = await page.evaluate(() => {
    window.__canonFlowPerf._rafActive = false
    return window.__canonFlowPerf.frames.slice()
  })
  // Drop first frame (often inflated)
  const cleaned = frames.slice(1).filter((v) => Number.isFinite(v) && v > 0 && v < 5_000)
  return cleaned
}

/**
 * Live performance run.
 */
export async function runLive(opts = {}) {
  const { chromium } = await import('@playwright/test')
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const base = opts.webBase ?? resolveWebBase()
  const headed = resolveHeaded()
  const fullSha = assertFullSha({ cwd: ROOT })
  const fixtureCfg = resolveFixtureConfig(opts.fixture || {})
  // Honest floor: never auto-lower below default / native public backend + 1
  const thresholds = resolveThresholds(opts.thresholds || {})
  thresholds.minRenderedNodes = resolveHonestMinRenderedNodes({
    minRenderedNodes: thresholds.minRenderedNodes,
  })
  const bundleFixture = generateScaleDataBundle(fixtureCfg)
  const graphFixture = generateScaleGraphFixture(fixtureCfg)
  const expectedNodes = bundleFixture.config.expectedProjectModeNodes
  const localPayloadBytes = bundleFixture.payloadBytes + graphFixture.payloadBytes
  const expectedFixtureHash = String(bundleFixture.payloadSha256 || '')
  // Sample synthetic id for DOM binding (backend mode)
  const samplePerfId =
    bundleFixture.bundle?.features?.backend?.[0]?.id || `${FIXTURE_ID_PREFIX}BACKEND-0000`

  const checks = []
  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail ?? null })
  }

  printOwnerTarget({ flow: FLOW_NAME, route, mode: 'run' })

  const serverProbe = await probeServer(base)
  if (!serverProbe.ok) {
    const classified = classifyPerfRunStatus({ serverReachable: false })
    const report = {
      flow: FLOW_NAME,
      targetGate: TARGET_GATE,
      mode: 'run',
      fullSha,
      webBase: base,
      route,
      boardId,
      serverProbe,
      status: classified.status,
      functionalPass: false,
      residual: {
        code: 'SERVER_UNREACHABLE',
        note: classified.reason,
      },
      note: 'No fake PASS when server missing',
      finishedAt: new Date().toISOString(),
    }
    fs.mkdirSync(OUT_DIR, { recursive: true })
    const outPath = path.join(OUT_DIR, `canon-flow-perf-${fullSha.slice(0, 12)}.json`)
    fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
    report.outPath = outPath
    return report
  }

  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = {
    baseURL: base,
    viewport: { width: 1440, height: 900 },
  }
  const storagePath = resolveStorageStatePath()
  let authMode = 'none'
  let authOk = false
  if (fs.existsSync(storagePath)) {
    try {
      contextOpts.storageState = requireExistingStorageState(storagePath)
      authMode = 'storageState'
      authOk = true
    } catch (e) {
      authMode = `storageState_invalid: ${String(e?.message || e)}`
      authOk = false
    }
  }

  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  const consoleErrors = []
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })

  await installPerfProbes(page)
  const injectionMeta = await installFixtureRoutes(page, bundleFixture, graphFixture)

  let residual = null
  /** @type {Record<string, unknown>} */
  const metrics = {
    // Local generator bytes are observe-only until wire intercept is proven
    localPayloadBytes,
    payloadSource: 'local',
    payloadBytes: localPayloadBytes,
    longTasksObserved: true,
    productRedrawSampled: false,
    nativeBackendFeatureCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
  }
  let fixtureInjected = false
  let landedOnFlow = false
  /** @type {ReturnType<typeof proveFixtureInjection> | null} */
  let injectionProof = null

  try {
    const navT0 = Date.now()
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 60_000 })
    const url = page.url()
    const onLogin = /\/login/.test(url)
    const onAlur = /\/alur/.test(url)

    if (onLogin || !onAlur) {
      residual = {
        code: onLogin ? 'AUTH_OR_ROUTE' : 'ROUTE',
        url,
        authMode,
        note: 'Did not land on authenticated alur — no fake PASS',
      }
      check('P2_land_flow', false, residual)
      authOk = false
      landedOnFlow = false
    } else {
      landedOnFlow = true
      check('P2_land_flow', true, { url, authMode })

      // Wait for interactive surface
      const nodeSel = CANON_FLOW_SELECTORS.flowNode
      const stageSel = CANON_FLOW_SELECTORS.flowStage
      try {
        await page
          .locator(`${CANON_FLOW_SELECTORS.flowUltimate}, ${stageSel}, ${nodeSel}`)
          .first()
          .waitFor({ timeout: 45_000 })
      } catch {
        /* continue — recorded below */
      }

      // Prefer large project mode for scale nodes
      const scalePill = page.locator(CANON_FLOW_SELECTORS.pillBackend)
      if ((await scalePill.count()) > 0) {
        await scalePill.click().catch(() => null)
        await page.waitForTimeout(400)
      }

      try {
        await page.locator(nodeSel).first().waitFor({ state: 'visible', timeout: 30_000 })
      } catch {
        /* recorded */
      }
      const fipMs = Date.now() - navT0
      metrics.firstInteractivePaintMs = fipMs

      const renderedNodeCount = await page.locator(nodeSel).count()
      metrics.renderedNodeCount = renderedNodeCount
      check('P3_first_interactive_paint_sampled', Number.isFinite(fipMs), { fipMs })
      check('P3_nodes_visible', renderedNodeCount > 0, { renderedNodeCount })

      // DOM PERF- marker scan (SSR-safe alternate proof when bound to synthetic fixture ids)
      const domMarker = await page.evaluate(
        ({ nodeSelector, idPrefix, sampleId }) => {
          const nodes = Array.from(document.querySelectorAll(nodeSelector))
          let perfFixtureNodeCount = 0
          let sampleIdHits = 0
          const samples = []
          const re = new RegExp(`\\b${idPrefix.replace(/-/g, '\\-')}[A-Z0-9_-]+`, 'i')
          for (const n of nodes) {
            const blob = [
              n.textContent || '',
              n.getAttribute('data-id') || '',
              n.getAttribute('data-feature-id') || '',
              n.getAttribute('data-node-id') || '',
              n.id || '',
            ].join(' ')
            if (re.test(blob) || /perf-n-\d+/i.test(blob)) {
              perfFixtureNodeCount++
              if (samples.length < 3) samples.push(blob.slice(0, 96))
            }
            if (sampleId && blob.includes(sampleId)) sampleIdHits++
          }
          // Also scan document for fixture marker attribute if product ever surfaces it
          const attrHits = document.querySelectorAll(
            `[data-canon-flow-perf-fixture], [data-canon-flow-perf-fixture-sha]`,
          ).length
          return {
            perfFixtureNodeCount,
            sampleIdHits,
            attrHits,
            total: nodes.length,
            samples,
          }
        },
        {
          nodeSelector: nodeSel,
          idPrefix: FIXTURE_ID_PREFIX,
          sampleId: samplePerfId,
        },
      )

      // Wire bytes from real intercepts; local generator bytes remain observe-only otherwise
      const routeHits = injectionMeta.injectedPaths.length
      if (routeHits > 0 && injectionMeta.wireBytes > 0) {
        metrics.payloadBytes = injectionMeta.wireBytes
        metrics.payloadSource = 'wire'
      } else {
        metrics.payloadBytes = localPayloadBytes
        metrics.payloadSource = 'local'
      }
      metrics.localPayloadBytes = localPayloadBytes

      const domMarkerVerified = domMarker.perfFixtureNodeCount > 0 || domMarker.attrHits > 0
      const domMarkerBoundToFixtureHash =
        domMarker.sampleIdHits > 0 ||
        (domMarker.perfFixtureNodeCount > 0 &&
          domMarker.perfFixtureNodeCount >= Math.min(5, Math.max(1, Math.floor(expectedNodes * 0.1))))

      injectionProof = proveFixtureInjection({
        routeHits,
        markerHeaderVerified: injectionMeta.markerHeaderSet === true && routeHits > 0,
        responseFixtureHash: injectionMeta.fixtureHash,
        expectedFixtureHash,
        domMarkerVerified,
        domMarkerBoundToFixtureHash,
        perfFixtureNodeCount: domMarker.perfFixtureNodeCount,
        renderedNodeCount,
      })
      fixtureInjected = injectionProof.proven === true
      check('P1_fixture_injection', fixtureInjected, {
        routeHits,
        method: injectionProof.method,
        reason: injectionProof.reason,
        wireBytes: injectionMeta.wireBytes,
        markerHeader: FIXTURE_MARKER_HEADER,
        fixtureHash: expectedFixtureHash,
        injectedSample: injectionMeta.injectedPaths.slice(0, 5),
        renderedNodeCount,
        expectedProjectModeNodes: expectedNodes,
        domMarker,
        note: 'Native node count alone never proves injection',
      })

      // Long-task buffer reset window start
      await page.evaluate(() => {
        if (window.__canonFlowPerf) window.__canonFlowPerf.longTasks = []
      })

      // Pan frames
      const stageBox = await page.locator(stageSel).first().boundingBox()
      let panFrames = []
      if (stageBox) {
        panFrames = await measureFramesDuring(page, 800, async () => {
          const start = { x: stageBox.x + stageBox.width - 80, y: stageBox.y + 40 }
          await page.mouse.move(start.x, start.y)
          await page.mouse.down()
          await page.mouse.move(start.x + 300, start.y, { steps: 20 })
          await page.mouse.up()
        })
      }
      metrics.panFramesMs = panFrames
      metrics.panFrameP95Ms = percentile(panFrames, 95)
      check('P5_pan_frames', panFrames.length > 0, {
        sampleCount: panFrames.length,
        p95: metrics.panFrameP95Ms,
      })

      // Drag frames
      const nodeBox = await page.locator(nodeSel).first().boundingBox()
      let dragFrames = []
      if (nodeBox) {
        dragFrames = await measureFramesDuring(page, 800, async () => {
          const start = {
            x: nodeBox.x + nodeBox.width / 2,
            y: nodeBox.y + nodeBox.height / 2,
          }
          await page.mouse.move(start.x, start.y)
          await page.mouse.down()
          await page.mouse.move(start.x + 120, start.y, { steps: 16 })
          await page.mouse.up()
        })
      }
      metrics.dragFramesMs = dragFrames
      metrics.dragFrameP95Ms = percentile(dragFrames, 95)
      check('P6_drag_frames', dragFrames.length > 0, {
        sampleCount: dragFrames.length,
        p95: metrics.dragFrameP95Ms,
      })

      // Long tasks collected during gestures
      const lt = await page.evaluate(() => {
        const p = window.__canonFlowPerf || { longTasks: [], longTaskObserverOk: false }
        return {
          longTasks: p.longTasks || [],
          observerOk: p.longTaskObserverOk === true,
        }
      })
      metrics.longTasksObserved = lt.observerOk
      metrics.longTasks = lt.longTasks
      metrics.longTaskCount = lt.longTasks.length
      metrics.longTaskMaxMs = lt.longTasks.reduce(
        (m, t) => Math.max(m, Number(t.duration) || 0),
        0,
      )
      // If observer unavailable, still record empty with observed:false (fail-closed evaluator)
      if (!lt.observerOk) {
        metrics.longTasksObserved = false
      }
      // P7: observer honesty only (do not soft-pass on empty task list alone)
      check('P7_long_tasks_observed', lt.observerOk === true, {
        observerOk: lt.observerOk,
        count: metrics.longTaskCount,
        maxMs: metrics.longTaskMaxMs,
      })

      // Canvas: harness soft sample is observe-only (not product edge redraw)
      const canvasSample = await page.evaluate((sel) => {
        const canvas = document.querySelector(sel)
        if (!canvas) {
          return {
            present: false,
            productRedrawSampled: false,
            redrawMs: null,
          }
        }
        const t0 = performance.now()
        try {
          const ctx = canvas.getContext && canvas.getContext('2d')
          if (ctx) {
            // Soft observation only — not a product redraw path
            const w = Math.min(canvas.width || 1, 64)
            const h = Math.min(canvas.height || 1, 64)
            ctx.getImageData(0, 0, w, h)
          }
        } catch {
          /* ignore */
        }
        const redrawMs = performance.now() - t0
        return {
          present: true,
          productRedrawSampled: false,
          redrawMs,
          width: canvas.width || null,
          height: canvas.height || null,
          note: 'harness soft sample — observe-only',
        }
      }, CANON_FLOW_SELECTORS.flowEdges)
      metrics.productRedrawSampled = canvasSample.productRedrawSampled === true
      metrics.canvasRedrawMs = canvasSample.redrawMs
      check('P8_canvas_redraw_observe', true, {
        ...canvasSample,
        observeOnly: metrics.productRedrawSampled !== true,
      })

      // Heap observation + payload role (wire vs local)
      const heap = await page.evaluate(() => {
        const m = performance.memory
        if (!m) return { heapUsedMb: null, available: false }
        return {
          available: true,
          heapUsedMb: m.usedJSHeapSize / (1024 * 1024),
          heapTotalMb: m.totalJSHeapSize / (1024 * 1024),
        }
      })
      metrics.heapUsedMb = heap.heapUsedMb
      metrics.heapObserved = heap.available
      check('P9_heap_payload', true, {
        heap,
        payloadBytes: metrics.payloadBytes,
        payloadSource: metrics.payloadSource,
        localPayloadBytes: metrics.localPayloadBytes,
        wireBytes: injectionMeta.wireBytes,
      })
    }
  } finally {
    await context.close()
    await browser.close()
  }

  const evaluation = evaluateAllPerfMetrics(metrics, thresholds)
  const classified = classifyPerfRunStatus({
    serverReachable: true,
    authOk: authOk && landedOnFlow,
    landedOnFlow,
    fixtureInjected: landedOnFlow ? fixtureInjected : false,
    metricsComplete: landedOnFlow && evaluation.failures.every((f) => !String(f).startsWith('missing_')),
    allThresholdsPass: evaluation.pass && landedOnFlow && fixtureInjected,
  })

  // If residual auth, force non-PASS
  if (residual) {
    classified.status = residual.code === 'AUTH_OR_ROUTE' ? 'AUTH' : 'LOCAL_ONLY'
    classified.functionalPass = false
  }

  // Incomplete missing samples while on flow → FAIL
  if (landedOnFlow && !evaluation.pass) {
    classified.status = classified.status === 'AUTH' ? 'AUTH' : 'FAIL'
    classified.functionalPass = false
  }

  const report = {
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    mode: 'run',
    fullSha,
    webBase: base,
    route,
    boardId,
    authMode,
    serverProbe,
    residual,
    fixture: {
      config: fixtureCfg,
      dataBundle: {
        featureTotal: bundleFixture.config.featureTotal,
        expectedProjectModeNodes: expectedNodes,
        payloadBytes: bundleFixture.payloadBytes,
        payloadSha256: bundleFixture.payloadSha256,
      },
      graph: {
        nodeCount: graphFixture.config.nodeCount,
        edgeCount: graphFixture.config.edgeCount,
        payloadBytes: graphFixture.payloadBytes,
        payloadSha256: graphFixture.payloadSha256,
      },
      injection: {
        productionDb: false,
        serverFnIds: injectionMeta.serverFnIds,
        routeHitCount: injectionMeta.injectedPaths.length,
        wireBytes: injectionMeta.wireBytes,
        markerHeaderSet: injectionMeta.markerHeaderSet,
        fixtureHash: injectionMeta.fixtureHash,
        fixtureInjected,
        proof: injectionProof,
        nativePublicBackendFeatureCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
      },
    },
    thresholds,
    honestMinRenderedNodes: thresholds.minRenderedNodes,
    metrics: {
      firstInteractivePaintMs: metrics.firstInteractivePaintMs ?? null,
      panFrameP95Ms: metrics.panFrameP95Ms ?? null,
      panFrameSampleCount: Array.isArray(metrics.panFramesMs) ? metrics.panFramesMs.length : 0,
      dragFrameP95Ms: metrics.dragFrameP95Ms ?? null,
      dragFrameSampleCount: Array.isArray(metrics.dragFramesMs) ? metrics.dragFramesMs.length : 0,
      longTaskMaxMs: metrics.longTaskMaxMs ?? null,
      longTaskCount: metrics.longTaskCount ?? null,
      longTasksObserved: metrics.longTasksObserved,
      canvasRedrawMs: metrics.canvasRedrawMs ?? null,
      productRedrawSampled: metrics.productRedrawSampled === true,
      heapUsedMb: metrics.heapUsedMb ?? null,
      payloadBytes: metrics.payloadBytes ?? null,
      payloadSource: metrics.payloadSource ?? null,
      localPayloadBytes: metrics.localPayloadBytes ?? null,
      renderedNodeCount: metrics.renderedNodeCount ?? null,
    },
    evaluation,
    checks,
    consoleErrorCount: consoleErrors.length,
    status: classified.status,
    functionalPass: classified.functionalPass === true,
    classificationReason: classified.reason,
    autoReplaceForbidden: AUTO_REPLACE_FORBIDDEN,
    baselineBlessForbidden: BASELINE_BLESS_FORBIDDEN,
    note:
      classified.functionalPass === true
        ? 'Live metrics within explicit thresholds with proven fixture injection'
        : classified.reason || 'Not a functional PASS',
    finishedAt: new Date().toISOString(),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `canon-flow-perf-${fullSha.slice(0, 12)}.json`)
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  // Also write fixture receipt (no secrets)
  const fixPath = path.join(OUT_DIR, `canon-flow-perf-fixture-${fullSha.slice(0, 12)}.json`)
  fs.writeFileSync(
    fixPath,
    `${JSON.stringify(
      {
        schema: 'TM_CANON_FLOW_PERF_FIXTURE_RECEIPT_V1',
        fullSha,
        dataBundle: report.fixture.dataBundle,
        graph: report.fixture.graph,
        config: fixtureCfg,
      },
      null,
      2,
    )}\n`,
    'utf8',
  )
  report.outPath = outPath
  report.fixtureReceiptPath = fixPath
  return report
}

async function main() {
  if (hasFlag('--self-test')) {
    const r = runSelfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (hasFlag('--plan')) {
    try {
      // Plan may run offline; FULL_SHA preferred but not hard-required for plan (evidence modes require it on run)
      const fullShaEnv = process.env.FULL_SHA?.trim()
      if (fullShaEnv && !isFullSha(fullShaEnv)) {
        console.error(
          JSON.stringify({
            ok: false,
            error: 'FULL_SHA set but not 40-char hex — fail closed',
            fullSha: fullShaEnv,
          }),
        )
        process.exit(2)
      }
      const plan = planPerfRun({
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
        fullSha: fullShaEnv || resolveFullSha({ cwd: ROOT }),
        fixture: {
          nodeCount: arg('--nodes') ? Number(arg('--nodes')) : undefined,
          edgeCount: arg('--edges') ? Number(arg('--edges')) : undefined,
          featuresPerProject: arg('--features') ? Number(arg('--features')) : undefined,
        },
      })
      console.log(JSON.stringify(plan, null, 2))
      process.exit(0)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(2)
    }
  }

  if (hasFlag('--run')) {
    try {
      const report = await runLive({
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
        fixture: {
          nodeCount: arg('--nodes') ? Number(arg('--nodes')) : undefined,
          edgeCount: arg('--edges') ? Number(arg('--edges')) : undefined,
          featuresPerProject: arg('--features') ? Number(arg('--features')) : undefined,
        },
      })
      console.log(JSON.stringify(report, null, 2))
      // Residual AUTH/HARNESS/LOCAL_ONLY exit 0 for harness usability; FAIL → 1; crash → 2
      if (report.status === 'FAIL') process.exit(1)
      process.exit(0)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(2)
    }
  }

  // Default: self-test + plan (no server)
  const self = runSelfTest()
  const plan = planPerfRun()
  console.log(
    JSON.stringify(
      {
        mode: 'default',
        selfTest: self,
        plan,
        usage: {
          selfTest: 'node qa/e2e/flows/canon-flow-perf.mjs --self-test',
          plan: 'FULL_SHA=$(git rev-parse HEAD) node qa/e2e/flows/canon-flow-perf.mjs --plan',
          run: 'WEB_BASE=… FULL_SHA=… node qa/e2e/flows/canon-flow-perf.mjs --run',
        },
      },
      null,
      2,
    ),
  )
  process.exit(self.ok ? 0 : 1)
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((e) => {
    console.error(String(e?.stack || e))
    process.exit(2)
  })
}
