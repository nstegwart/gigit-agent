/**
 * Pure helpers for canon-flow large-graph browser performance harness.
 * No browser / network / DB / product imports. Deterministic fixtures + fail-closed evaluators.
 *
 * Used by: qa/e2e/flows/canon-flow-perf.mjs
 *
 * Injection is fixture-only (synthetic nodes/edges + data-bundle shape). Never production DB.
 * Thresholds are explicit; missing samples → FAIL closed (never silent PASS).
 * Fixture proof requires route-hit + marker/hash or DOM PERF- marker — never native node count alone.
 * Payload/canvas are observe-only unless wire bytes / product redraw are real samples.
 */
import { createHash } from 'node:crypto'

export const PERF_HELPER_SCHEMA = 'TM_CANON_FLOW_PERF_HELPER_V1'
export const TARGET_GATE = 'TM_CANON_FLOW_PERF_HARNESS_READY'

/**
 * Offline public/flow-data/data-bundle.json backend feature count.
 * Native default alone must never prove large-graph fixture injection or soft-pass the node floor.
 */
export const NATIVE_PUBLIC_BACKEND_FEATURE_COUNT = 41

/** Synthetic fixture wire markers (response headers on Playwright fulfill). */
export const FIXTURE_MARKER_HEADER = 'x-canon-flow-perf-fixture'
export const FIXTURE_HASH_HEADER = 'x-canon-flow-perf-fixture-sha'
export const FIXTURE_MARKER_VALUE = '1'
/** Visible / id prefix for synthetic features (not present in native public bundle). */
export const FIXTURE_ID_PREFIX = 'PERF-'

/** Canon flow selectors shared with fidelity/functional gates. */
export const CANON_FLOW_SELECTORS = Object.freeze({
  flowUltimate: '[data-testid="flow-ultimate"]',
  flowStage: '.flow-stage, [data-testid="flow-stage"]',
  flowWorld: '.flow-world, [data-testid="flow-world"]',
  flowEdges: 'canvas.flow-edges, [data-testid="flow-edges"]',
  flowNodes: '.flow-nodes, [data-testid="flow-nodes"]',
  flowNode: '[data-testid="flow-node"], .fnode',
  flowZoom: '.flow-zoom',
  flowSheet: '.flow-sheet[role="dialog"], [data-testid="flow-sheet"]',
  pillCross: '.flow-pill[data-mode="cross"]',
  pillRn: '.flow-pill[data-mode="rn"]',
  pillBackend: '.flow-pill[data-mode="backend"]',
})

/**
 * Project keys that become graph modes with feature lists (product buildProjectGraph).
 * Larger feature lists → more DOM nodes in project mode.
 */
export const PROJECT_KEYS = Object.freeze([
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
])

/**
 * Explicit default thresholds (fail-closed). Override via env / plan opts only.
 * Units: ms unless noted. Missing sample never counts as pass for gated metrics.
 * minRenderedNodes honest floor always exceeds native public backend scale (41).
 */
export const DEFAULT_THRESHOLDS = Object.freeze({
  /** Time from navigation start → first interactive flow surface (nodes visible). */
  firstInteractivePaintMs: 3_500,
  /** p95 frame interval during empty-stage pan gesture. */
  panFrameP95Ms: 50,
  /** p95 frame interval during node drag gesture. */
  dragFrameP95Ms: 50,
  /** Max long-task duration (PerformanceObserver longtask). */
  longTaskMaxMs: 100,
  /** Max count of long tasks during the measurement window. */
  longTaskMaxCount: 8,
  /** Canvas edge redraw duration budget when product redraw is really sampled. */
  canvasRedrawMs: 80,
  /** Soft observation ceiling for JS heap used (MB); missing heap → observe-only, not PASS claim. */
  heapUsedMbMax: 512,
  /** Wire (intercepted) payload bytes upper bound; local generator bytes are observe-only. */
  payloadBytesMax: 8 * 1024 * 1024,
  /**
   * Minimum rendered nodes after large fixture injection.
   * Must exceed NATIVE_PUBLIC_BACKEND_FEATURE_COUNT; never auto-lower below honest floor.
   */
  minRenderedNodes: 50,
})

/** Default fixture scale for large-graph runs (no production DB). */
export const DEFAULT_FIXTURE = Object.freeze({
  nodeCount: 200,
  edgeCount: 240,
  featuresPerProject: 80,
  seed: 'canon-flow-perf-v1',
})

/**
 * Known TanStack `/_serverFn/<id>` hashes for flow data (current build tip).
 * Overridable via env when hashes change — never invent live PASS without injection proof.
 */
export const DEFAULT_SERVERFN_IDS = Object.freeze({
  getFlowDataBundleFn:
    '5641834cf094ec810f1da92f7b13e54a0aba0a56bd2c21a31d13f91f58a637db',
  getFlowGraphFn: '69081030c39f4db73a9a8a40a98a7d1b6c92837439d23bd28c58afa90a29de99',
})

// ---------------------------------------------------------------------------
// Numbers / stats
// ---------------------------------------------------------------------------

export function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function envIsSet(name) {
  const raw = process.env[name]
  return raw != null && String(raw).trim() !== ''
}

/**
 * Percentile on ascending-sorted copy. Empty → null (fail-closed callers).
 * @param {number[]} values
 * @param {number} p 0–100
 */
export function percentile(values, p) {
  if (!Array.isArray(values) || values.length === 0) return null
  const sorted = values
    .filter((v) => typeof v === 'number' && Number.isFinite(v))
    .slice()
    .sort((a, b) => a - b)
  if (!sorted.length) return null
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
  return sorted[Math.max(0, idx)]
}

export function mean(values) {
  const xs = (values || []).filter((v) => typeof v === 'number' && Number.isFinite(v))
  if (!xs.length) return null
  return xs.reduce((a, b) => a + b, 0) / xs.length
}

export function sha256Hex(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

/** Deterministic uint32 PRNG (mulberry32). */
export function mulberry32(seed) {
  let t = seed >>> 0
  return function next() {
    t += 0x6d2b79f5
    let r = Math.imul(t ^ (t >>> 15), 1 | t)
    r ^= r + Math.imul(r ^ (r >>> 7), 61 | r)
    return ((r ^ (r >>> 14)) >>> 0) / 4294967296
  }
}

export function seedToUint32(seed) {
  const hex = sha256Hex(String(seed ?? '0')).slice(0, 8)
  return Number.parseInt(hex, 16) >>> 0
}

// ---------------------------------------------------------------------------
// Fixture generation (no DB)
// ---------------------------------------------------------------------------

/**
 * Resolve fixture sizes from opts/env. Never reads production data.
 * @param {{
 *   nodeCount?: number
 *   edgeCount?: number
 *   featuresPerProject?: number
 *   seed?: string
 * }} [opts]
 */
export function resolveFixtureConfig(opts = {}) {
  const nodeCount = Math.max(
    1,
    Math.floor(opts.nodeCount ?? numEnv('CANON_FLOW_PERF_NODES', DEFAULT_FIXTURE.nodeCount)),
  )
  const edgeCount = Math.max(
    0,
    Math.floor(opts.edgeCount ?? numEnv('CANON_FLOW_PERF_EDGES', DEFAULT_FIXTURE.edgeCount)),
  )
  const featuresPerProject = Math.max(
    1,
    Math.floor(
      opts.featuresPerProject ??
        numEnv('CANON_FLOW_PERF_FEATURES_PER_PROJECT', DEFAULT_FIXTURE.featuresPerProject),
    ),
  )
  const seed = String(opts.seed ?? process.env.CANON_FLOW_PERF_SEED ?? DEFAULT_FIXTURE.seed)
  return { nodeCount, edgeCount, featuresPerProject, seed }
}

/**
 * Synthetic ultimate-style graph (nodes + edges) for payload/redraw observation.
 * Deterministic for a given seed + counts. No production IDs.
 *
 * @param {{ nodeCount?: number, edgeCount?: number, seed?: string }} [opts]
 */
export function generateScaleGraphFixture(opts = {}) {
  const cfg = resolveFixtureConfig(opts)
  const rand = mulberry32(seedToUint32(cfg.seed))
  const projects = PROJECT_KEYS
  const kinds = ['page', 'endpoint', 'feature', 'screen']
  const nodes = []
  for (let i = 0; i < cfg.nodeCount; i++) {
    const project = projects[i % projects.length]
    nodes.push({
      id: `perf-n-${String(i).padStart(5, '0')}`,
      kind: kinds[i % kinds.length],
      project,
      label: `Perf Node ${i}`,
      label_id: `Perf Node ${i}`,
      route_or_screen: `perf_screen_${i}`,
      area: 'Harness',
      feature_id: null,
      project_label_id: project,
    })
  }
  const edges = []
  const maxEdges = Math.min(cfg.edgeCount, Math.max(0, cfg.nodeCount * (cfg.nodeCount - 1)))
  for (let i = 0; i < maxEdges; i++) {
    const from = nodes[i % nodes.length].id
    // Prefer sequential + some random long-range edges for realism
    const toIdx =
      i + 1 < nodes.length
        ? (i + 1) % nodes.length
        : Math.floor(rand() * nodes.length)
    const to = nodes[toIdx].id
    if (from === to) continue
    edges.push({
      id: `perf-e-${String(edges.length).padStart(5, '0')}`,
      from,
      to,
      kind: i % 3 === 0 ? 'nav' : 'dep',
    })
  }
  const payload = {
    generated_at: '1970-01-01T00:00:00.000Z',
    label_id: 'Canon flow perf harness synthetic graph',
    source: 'canon-flow-perf-fixture',
    seed: cfg.seed,
    nodes,
    edges,
  }
  const json = JSON.stringify(payload)
  return {
    schema: PERF_HELPER_SCHEMA,
    kind: 'graph',
    config: { nodeCount: cfg.nodeCount, edgeCount: edges.length, seed: cfg.seed },
    graph: payload,
    payloadBytes: Buffer.byteLength(json, 'utf8'),
    payloadSha256: sha256Hex(json),
  }
}

/**
 * Synthetic data-bundle.json shape consumed by product Flow Ultimate.
 * features[project] length drives project-mode node count (1:1 with features).
 * Cross mode still uses premium + hardcoded flows; project modes scale with fixture.
 *
 * @param {{ featuresPerProject?: number, seed?: string, nodeCount?: number }} [opts]
 */
export function generateScaleDataBundle(opts = {}) {
  const cfg = resolveFixtureConfig(opts)
  const features = {}
  const tasks_by_feature = {}
  const apis_by_feature = {}
  let featureTotal = 0

  for (const proj of PROJECT_KEYS) {
    const list = []
    for (let i = 0; i < cfg.featuresPerProject; i++) {
      // Human-facing labels only — avoid FEAT-/T-/FC- tech-id patterns in visible title path.
      // Product stores id as FEAT-… internally; harness labels use plain language.
      const id = `PERF-${proj.toUpperCase()}-${String(i).padStart(4, '0')}`
      const feat = {
        id,
        nama_id: `Perf ${proj} ${i}`,
        ringkasan_id: `Synthetic scale feature ${i} for ${proj}`,
        status: i % 5 === 0 ? 'terbukti' : i % 3 === 0 ? 'sebagian' : 'belum',
        pct: (i * 7) % 100,
        screens: [`/perf/${proj}/${i}`, `screen_${i}`],
        task_ids: [`TASK-PERF-${proj}-${i}`],
      }
      list.push(feat)
      tasks_by_feature[id] = [
        {
          id: `TASK-PERF-${proj}-${i}`,
          judul_id: `Task ${i}`,
          project: proj,
          verdict: 'open',
        },
      ]
      apis_by_feature[id] = [
        { method: 'GET', path: `/api/perf/${proj}/${i}`, n: 1, proj },
      ]
      featureTotal++
    }
    features[proj] = list
  }

  const premiumSteps = []
  for (let n = 1; n <= 10; n++) {
    premiumSteps.push({
      n,
      proj: PROJECT_KEYS[(n - 1) % PROJECT_KEYS.length],
      title: `Premium step ${n}`,
      kind: 'step',
      st: n % 2 === 0 ? 'ok' : 'warn',
      api: n % 3 === 0 ? `GET /api/premium/${n}` : '—',
    })
  }

  const bundle = {
    projects: {
      version: 1,
      generated_at: '1970-01-01T00:00:00.000Z',
      source: 'canon-flow-perf-fixture',
      projects: PROJECT_KEYS.map((id) => ({
        id,
        label: id,
        features: cfg.featuresPerProject,
        tasks: cfg.featuresPerProject,
        pct: 50,
        status: 'sebagian',
      })),
    },
    premium: {
      name: 'Perf Premium Flow',
      desc: 'Synthetic premium steps for scale harness',
      steps: premiumSteps,
    },
    features,
    tasks_by_feature,
    apis_by_feature,
    premium_apis: [{ method: 'GET', path: '/api/premium/status', n: 1 }],
  }

  const json = JSON.stringify(bundle)
  return {
    schema: PERF_HELPER_SCHEMA,
    kind: 'data-bundle',
    config: {
      featuresPerProject: cfg.featuresPerProject,
      featureTotal,
      projectKeys: [...PROJECT_KEYS],
      seed: cfg.seed,
      /** Project mode expected nodes ≈ featuresPerProject (one node per feature). */
      expectedProjectModeNodes: cfg.featuresPerProject,
    },
    bundle,
    payloadBytes: Buffer.byteLength(json, 'utf8'),
    payloadSha256: sha256Hex(json),
  }
}

/**
 * Estimate nodes/edges the product would build for a mode (mirrors graph.ts rules loosely).
 * Pure — does not import product code.
 */
export function estimateRenderedGraph(bundle, mode = 'backend') {
  if (!bundle || typeof bundle !== 'object') {
    return { nodes: 0, edges: 0, mode }
  }
  if (mode === 'cross') {
    const premium = bundle.premium?.steps?.length ?? 0
    // premium + auth(3) + aff(5) + iap(4) from buildCrossGraph
    const nodes = premium + 3 + 5 + 4
    const edges = Math.max(0, premium - 1) + 2 + 4 + 3
    return { nodes, edges, mode }
  }
  const list = bundle.features?.[mode] || []
  const nodes = list.length
  // buildProjectGraph: edges along columns + hub links
  const COL_CAP = 7
  let edges = 0
  list.forEach((_, idx) => {
    const row = idx % COL_CAP
    const col = Math.floor(idx / COL_CAP)
    if (row > 0) edges++
    else if (col > 0) edges++
  })
  return { nodes, edges, mode }
}

// ---------------------------------------------------------------------------
// Threshold resolution + evaluation (fail-closed)
// ---------------------------------------------------------------------------

/**
 * Honest min rendered-node floor: never below default or native public backend + 1.
 * Env/opts may raise the floor; they cannot soften below the honesty bar.
 * @param {{ minRenderedNodes?: number, nativeBackendFeatureCount?: number }} [opts]
 */
export function resolveHonestMinRenderedNodes(opts = {}) {
  const nativeCount =
    opts.nativeBackendFeatureCount != null && Number.isFinite(opts.nativeBackendFeatureCount)
      ? Math.floor(opts.nativeBackendFeatureCount)
      : NATIVE_PUBLIC_BACKEND_FEATURE_COUNT
  const honestFloor = Math.max(DEFAULT_THRESHOLDS.minRenderedNodes, nativeCount + 1)
  let requested
  if (opts.minRenderedNodes != null && Number.isFinite(Number(opts.minRenderedNodes))) {
    requested = Math.floor(Number(opts.minRenderedNodes))
  } else if (envIsSet('CANON_FLOW_PERF_MIN_NODES')) {
    requested = Math.floor(numEnv('CANON_FLOW_PERF_MIN_NODES', honestFloor))
  } else {
    requested = honestFloor
  }
  if (!Number.isFinite(requested)) requested = honestFloor
  return Math.max(honestFloor, requested)
}

/**
 * Resolve thresholds from opts/env with explicit defaults.
 * minRenderedNodes is honesty-clamped (never auto-softened below native+1 / default).
 * @param {Partial<typeof DEFAULT_THRESHOLDS>} [opts]
 */
export function resolveThresholds(opts = {}) {
  return {
    firstInteractivePaintMs:
      opts.firstInteractivePaintMs ??
      numEnv('CANON_FLOW_PERF_FIP_MS', DEFAULT_THRESHOLDS.firstInteractivePaintMs),
    panFrameP95Ms:
      opts.panFrameP95Ms ??
      numEnv('CANON_FLOW_PERF_PAN_P95_MS', DEFAULT_THRESHOLDS.panFrameP95Ms),
    dragFrameP95Ms:
      opts.dragFrameP95Ms ??
      numEnv('CANON_FLOW_PERF_DRAG_P95_MS', DEFAULT_THRESHOLDS.dragFrameP95Ms),
    longTaskMaxMs:
      opts.longTaskMaxMs ??
      numEnv('CANON_FLOW_PERF_LONGTASK_MS', DEFAULT_THRESHOLDS.longTaskMaxMs),
    longTaskMaxCount:
      opts.longTaskMaxCount ??
      numEnv('CANON_FLOW_PERF_LONGTASK_COUNT', DEFAULT_THRESHOLDS.longTaskMaxCount),
    canvasRedrawMs:
      opts.canvasRedrawMs ??
      numEnv('CANON_FLOW_PERF_CANVAS_MS', DEFAULT_THRESHOLDS.canvasRedrawMs),
    heapUsedMbMax:
      opts.heapUsedMbMax ??
      numEnv('CANON_FLOW_PERF_HEAP_MB', DEFAULT_THRESHOLDS.heapUsedMbMax),
    payloadBytesMax:
      opts.payloadBytesMax ??
      numEnv('CANON_FLOW_PERF_PAYLOAD_BYTES', DEFAULT_THRESHOLDS.payloadBytesMax),
    minRenderedNodes: resolveHonestMinRenderedNodes({
      minRenderedNodes: opts.minRenderedNodes,
      nativeBackendFeatureCount: opts.nativeBackendFeatureCount,
    }),
  }
}

/**
 * Prove synthetic fixture injection. Native rendered node count alone is never enough.
 *
 * Affirmative proof requires either:
 * 1. routeHits > 0 AND verifiable synthetic response marker/header bound to fixture hash, or
 * 2. SSR-safe DOM marker bound to fixture (PERF- ids / marker hash) — not mere node count.
 *
 * @param {{
 *   routeHits?: number
 *   markerHeaderVerified?: boolean
 *   responseFixtureHash?: string | null
 *   expectedFixtureHash?: string | null
 *   domMarkerVerified?: boolean
 *   domMarkerBoundToFixtureHash?: boolean
 *   perfFixtureNodeCount?: number
 *   renderedNodeCount?: number
 * }} [input]
 */
export function proveFixtureInjection(input = {}) {
  const routeHits = Number(input.routeHits) || 0
  const expectedHash =
    input.expectedFixtureHash != null && String(input.expectedFixtureHash).length > 0
      ? String(input.expectedFixtureHash)
      : null
  const responseHash =
    input.responseFixtureHash != null && String(input.responseFixtureHash).length > 0
      ? String(input.responseFixtureHash)
      : null

  const hashBound =
    expectedHash == null || responseHash == null || responseHash === expectedHash
  const routeProof =
    routeHits > 0 && input.markerHeaderVerified === true && hashBound

  const perfCount = Number(input.perfFixtureNodeCount) || 0
  const domProof =
    input.domMarkerVerified === true &&
    input.domMarkerBoundToFixtureHash === true &&
    perfCount > 0

  if (routeProof) {
    return {
      proven: true,
      method: 'route_hit_with_marker',
      routeHits,
      perfFixtureNodeCount: perfCount,
      reason: null,
    }
  }
  if (domProof) {
    return {
      proven: true,
      method: 'dom_marker_fixture_bound',
      routeHits,
      perfFixtureNodeCount: perfCount,
      reason: null,
    }
  }

  const reasons = []
  if (routeHits === 0) reasons.push('routeHits=0')
  if (input.markerHeaderVerified !== true) reasons.push('marker_header_unverified')
  if (expectedHash && responseHash && responseHash !== expectedHash) {
    reasons.push('fixture_hash_mismatch')
  }
  if (!domProof) reasons.push('dom_marker_unproven')
  if (routeHits === 0 && (Number(input.renderedNodeCount) || 0) > 0) {
    reasons.push('native_node_count_alone_insufficient')
  }

  return {
    proven: false,
    method: null,
    routeHits,
    perfFixtureNodeCount: perfCount,
    reason: reasons.join(';') || 'fixture_injection_unproven',
  }
}

/**
 * First interactive paint: navigation → flow surface interactive (nodes > 0).
 * Missing sample → FAIL closed.
 */
export function evaluateFirstInteractivePaint(input = {}) {
  const budgetMs = input.budgetMs ?? DEFAULT_THRESHOLDS.firstInteractivePaintMs
  const valueMs = input.valueMs ?? input.firstInteractivePaintMs
  if (valueMs == null || !Number.isFinite(valueMs)) {
    return {
      ok: false,
      pass: false,
      metric: 'first_interactive_paint',
      budgetMs,
      valueMs: null,
      reason: 'missing_first_interactive_paint_sample',
    }
  }
  const pass = valueMs <= budgetMs
  return {
    ok: pass,
    pass,
    metric: 'first_interactive_paint',
    budgetMs,
    valueMs,
    reason: pass ? null : `first_interactive_paint>${budgetMs}`,
  }
}

/**
 * Frame timing p95 for pan or drag. Empty frames → FAIL closed.
 * @param {{ framesMs?: number[], p95Ms?: number, budgetMs?: number, gesture?: string }} input
 */
export function evaluateFrameP95(input = {}) {
  const gesture = input.gesture || 'frame'
  const budgetMs = input.budgetMs ?? DEFAULT_THRESHOLDS.panFrameP95Ms
  let p95 = input.p95Ms
  if (p95 == null && Array.isArray(input.framesMs)) {
    p95 = percentile(input.framesMs, 95)
  }
  if (p95 == null || !Number.isFinite(p95)) {
    return {
      ok: false,
      pass: false,
      metric: `${gesture}_frame_p95`,
      budgetMs,
      valueMs: null,
      sampleCount: Array.isArray(input.framesMs) ? input.framesMs.length : 0,
      reason: `missing_${gesture}_frame_samples`,
    }
  }
  const pass = p95 <= budgetMs
  return {
    ok: pass,
    pass,
    metric: `${gesture}_frame_p95`,
    budgetMs,
    valueMs: p95,
    sampleCount: Array.isArray(input.framesMs) ? input.framesMs.length : null,
    reason: pass ? null : `${gesture}_frame_p95>${budgetMs}`,
  }
}

/**
 * Long tasks: max duration + count. Missing observation when expected → FAIL closed.
 * @param {{
 *   longTasks?: Array<{ duration: number }>
 *   maxDurationMs?: number
 *   count?: number
 *   budgetMaxMs?: number
 *   budgetMaxCount?: number
 *   observed?: boolean
 * }} input
 */
export function evaluateLongTasks(input = {}) {
  const budgetMaxMs = input.budgetMaxMs ?? DEFAULT_THRESHOLDS.longTaskMaxMs
  const budgetMaxCount = input.budgetMaxCount ?? DEFAULT_THRESHOLDS.longTaskMaxCount
  const observed = input.observed !== false

  if (!observed) {
    return {
      ok: false,
      pass: false,
      metric: 'long_tasks',
      budgetMaxMs,
      budgetMaxCount,
      maxDurationMs: null,
      count: null,
      reason: 'long_task_observer_not_available',
    }
  }

  const tasks = Array.isArray(input.longTasks) ? input.longTasks : null
  const count =
    input.count != null
      ? input.count
      : tasks
        ? tasks.length
        : null
  const maxDurationMs =
    input.maxDurationMs != null
      ? input.maxDurationMs
      : tasks
        ? tasks.reduce((m, t) => Math.max(m, Number(t.duration) || 0), 0)
        : null

  if (count == null || maxDurationMs == null || !Number.isFinite(maxDurationMs)) {
    return {
      ok: false,
      pass: false,
      metric: 'long_tasks',
      budgetMaxMs,
      budgetMaxCount,
      maxDurationMs: maxDurationMs ?? null,
      count: count ?? null,
      reason: 'missing_long_task_samples',
    }
  }

  const reasons = []
  if (maxDurationMs > budgetMaxMs) reasons.push(`long_task_max>${budgetMaxMs}`)
  if (count > budgetMaxCount) reasons.push(`long_task_count>${budgetMaxCount}`)
  const pass = reasons.length === 0
  return {
    ok: pass,
    pass,
    metric: 'long_tasks',
    budgetMaxMs,
    budgetMaxCount,
    maxDurationMs,
    count,
    reason: pass ? null : reasons.join(';'),
  }
}

/**
 * Canvas redraw budget.
 * Soft/harness-only samples (no product edge redraw) are observe-only — never threshold drivers.
 * Real product redraw must set productRedrawSampled:true; missing sample then fails closed.
 */
export function evaluateCanvasRedraw(input = {}) {
  const budgetMs = input.budgetMs ?? DEFAULT_THRESHOLDS.canvasRedrawMs
  const productRedrawSampled = input.productRedrawSampled === true
  const valueMs = input.valueMs ?? input.redrawMs

  if (!productRedrawSampled) {
    return {
      ok: true,
      pass: true,
      observeOnly: true,
      applicable: false,
      productRedrawSampled: false,
      metric: 'canvas_redraw',
      budgetMs,
      valueMs: valueMs != null && Number.isFinite(valueMs) ? valueMs : null,
      reason: null,
      note:
        'canvas_observe_only — harness soft sample / empty canvas does not drive threshold PASS or FAIL',
    }
  }

  if (valueMs == null || !Number.isFinite(valueMs)) {
    return {
      ok: false,
      pass: false,
      observeOnly: false,
      applicable: true,
      productRedrawSampled: true,
      metric: 'canvas_redraw',
      budgetMs,
      valueMs: null,
      reason: 'missing_canvas_redraw_sample',
    }
  }
  const pass = valueMs <= budgetMs
  return {
    ok: pass,
    pass,
    observeOnly: false,
    applicable: true,
    productRedrawSampled: true,
    metric: 'canvas_redraw',
    budgetMs,
    valueMs,
    reason: pass ? null : `canvas_redraw>${budgetMs}`,
  }
}

/**
 * Heap + payload observation.
 * - Wire (intercepted response) payloadBytes with payloadSource:'wire' → threshold gated.
 * - Local generator JSON.stringify bytes → observe-only (not transfer proof).
 * - heap missing → observed:false (not a PASS for heap; does not invent numbers)
 * - heap over bound when present → FAIL
 */
export function evaluateHeapPayload(input = {}) {
  const heapBudget = input.heapUsedMbMax ?? DEFAULT_THRESHOLDS.heapUsedMbMax
  const payloadBudget = input.payloadBytesMax ?? DEFAULT_THRESHOLDS.payloadBytesMax
  const heapUsedMb = input.heapUsedMb
  const payloadBytes = input.payloadBytes
  const payloadSource = input.payloadSource === 'wire' ? 'wire' : 'local'
  const wirePayload = payloadSource === 'wire'
  const reasons = []

  const payloadPresent = payloadBytes != null && Number.isFinite(payloadBytes)
  let payloadObserveOnly = !wirePayload

  if (wirePayload) {
    if (!payloadPresent) {
      reasons.push('missing_payload_bytes')
    } else if (payloadBytes > payloadBudget) {
      reasons.push(`payload_bytes>${payloadBudget}`)
    }
  }

  let heapObserved = false
  if (heapUsedMb != null && Number.isFinite(heapUsedMb)) {
    heapObserved = true
    if (heapUsedMb > heapBudget) {
      reasons.push(`heap_used_mb>${heapBudget}`)
    }
  }

  const localPayloadBytes =
    input.localPayloadBytes != null && Number.isFinite(input.localPayloadBytes)
      ? input.localPayloadBytes
      : !wirePayload && payloadPresent
        ? payloadBytes
        : null

  const pass = reasons.length === 0
  const notes = []
  if (!heapObserved) notes.push('heap_not_available_in_engine — heap not claimed')
  if (payloadObserveOnly) {
    notes.push(
      'payload_local_observe_only — generator bytes are not wire transfer; not a threshold driver',
    )
  }

  return {
    ok: pass,
    pass,
    metric: 'heap_payload',
    heapUsedMb: heapObserved ? heapUsedMb : null,
    heapObserved,
    heapUsedMbMax: heapBudget,
    payloadBytes: wirePayload && payloadPresent ? payloadBytes : payloadPresent ? payloadBytes : null,
    payloadBytesMax: payloadBudget,
    payloadSource: wirePayload ? 'wire' : payloadPresent || localPayloadBytes != null ? 'local' : null,
    payloadObserveOnly,
    localPayloadBytes,
    reason: pass ? null : reasons.join(';'),
    note: notes.length ? notes.join('; ') : null,
  }
}

/**
 * Rendered node count vs honest min for large-graph claims.
 * Uses honesty-clamped floor (never below native public backend + 1 / default 50).
 */
export function evaluateRenderedNodes(input = {}) {
  const minNodes = resolveHonestMinRenderedNodes({
    minRenderedNodes: input.minRenderedNodes,
    nativeBackendFeatureCount: input.nativeBackendFeatureCount,
  })
  const count = input.renderedNodeCount
  if (count == null || !Number.isFinite(count)) {
    return {
      ok: false,
      pass: false,
      metric: 'rendered_nodes',
      minRenderedNodes: minNodes,
      renderedNodeCount: null,
      reason: 'missing_rendered_node_count',
    }
  }
  const pass = count >= minNodes
  return {
    ok: pass,
    pass,
    metric: 'rendered_nodes',
    minRenderedNodes: minNodes,
    renderedNodeCount: count,
    nativeBackendFeatureCount:
      input.nativeBackendFeatureCount ?? NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    reason: pass ? null : `rendered_nodes<${minNodes}`,
  }
}

/**
 * Aggregate all metric evaluations. Any fail → overall fail (fail-closed).
 * @param {object} metrics observed samples
 * @param {ReturnType<typeof resolveThresholds>} [thresholds]
 */
export function evaluateAllPerfMetrics(metrics = {}, thresholds = resolveThresholds()) {
  const results = {
    firstInteractivePaint: evaluateFirstInteractivePaint({
      valueMs: metrics.firstInteractivePaintMs,
      budgetMs: thresholds.firstInteractivePaintMs,
    }),
    panFrameP95: evaluateFrameP95({
      framesMs: metrics.panFramesMs,
      p95Ms: metrics.panFrameP95Ms,
      budgetMs: thresholds.panFrameP95Ms,
      gesture: 'pan',
    }),
    dragFrameP95: evaluateFrameP95({
      framesMs: metrics.dragFramesMs,
      p95Ms: metrics.dragFrameP95Ms,
      budgetMs: thresholds.dragFrameP95Ms,
      gesture: 'drag',
    }),
    longTasks: evaluateLongTasks({
      longTasks: metrics.longTasks,
      maxDurationMs: metrics.longTaskMaxMs,
      count: metrics.longTaskCount,
      budgetMaxMs: thresholds.longTaskMaxMs,
      budgetMaxCount: thresholds.longTaskMaxCount,
      observed: metrics.longTasksObserved !== false,
    }),
    canvasRedraw: evaluateCanvasRedraw({
      valueMs: metrics.canvasRedrawMs,
      budgetMs: thresholds.canvasRedrawMs,
      productRedrawSampled: metrics.productRedrawSampled === true,
    }),
    heapPayload: evaluateHeapPayload({
      heapUsedMb: metrics.heapUsedMb,
      payloadBytes: metrics.payloadBytes,
      payloadSource: metrics.payloadSource,
      localPayloadBytes: metrics.localPayloadBytes,
      heapUsedMbMax: thresholds.heapUsedMbMax,
      payloadBytesMax: thresholds.payloadBytesMax,
    }),
    renderedNodes: evaluateRenderedNodes({
      renderedNodeCount: metrics.renderedNodeCount,
      minRenderedNodes: thresholds.minRenderedNodes,
      nativeBackendFeatureCount: metrics.nativeBackendFeatureCount,
    }),
  }

  const failures = Object.values(results)
    .filter((r) => !r.pass)
    .map((r) => r.reason || r.metric)
  return {
    ok: failures.length === 0,
    pass: failures.length === 0,
    thresholds,
    results,
    failures,
  }
}

/**
 * Affirmative gates required for functional PASS. Omitted keys fail (not only explicit false).
 */
export const CLASSIFY_REQUIRED_AFFIRMATIVE_KEYS = Object.freeze([
  'serverReachable',
  'authOk',
  'landedOnFlow',
  'fixtureInjected',
  'metricsComplete',
  'allThresholdsPass',
])

/**
 * Classify live run honesty. Never fake PASS without affirmative server+auth+injection+samples.
 * Every key in CLASSIFY_REQUIRED_AFFIRMATIVE_KEYS must be strictly true; omitted → fail closed.
 * @param {{
 *   selfTestOnly?: boolean
 *   serverReachable?: boolean
 *   authOk?: boolean
 *   landedOnFlow?: boolean
 *   fixtureInjected?: boolean
 *   metricsComplete?: boolean
 *   allThresholdsPass?: boolean
 * }} input
 */
export function classifyPerfRunStatus(input = {}) {
  if (input.selfTestOnly) {
    return {
      status: 'HARNESS_READY',
      functionalPass: false,
      reason: 'self-test / plan only — no live functional PASS',
    }
  }

  const gateMeta = {
    serverReachable: {
      status: 'HARNESS',
      falseReason: 'server_unreachable — no fake PASS',
      omitReason: 'serverReachable_omitted — no fake PASS',
    },
    authOk: {
      status: 'AUTH',
      falseReason: 'auth_missing_or_login_redirect — no fake PASS',
      omitReason: 'authOk_omitted — no fake PASS',
    },
    landedOnFlow: {
      status: 'LOCAL_ONLY',
      falseReason: 'did_not_land_on_authenticated_alur',
      omitReason: 'landedOnFlow_omitted — no fake PASS',
    },
    fixtureInjected: {
      status: 'LOCAL_ONLY',
      falseReason: 'fixture_injection_unproven — large-graph claim not established',
      omitReason: 'fixtureInjected_omitted — large-graph claim not established',
    },
    metricsComplete: {
      status: 'FAIL',
      falseReason: 'incomplete_metrics — fail closed',
      omitReason: 'metricsComplete_omitted — fail closed',
    },
    allThresholdsPass: {
      status: 'FAIL',
      falseReason: 'one_or_more_thresholds_failed',
      omitReason: 'allThresholdsPass_omitted — fail closed',
    },
  }

  for (const key of CLASSIFY_REQUIRED_AFFIRMATIVE_KEYS) {
    if (input[key] === true) continue
    const meta = gateMeta[key]
    const omitted = !Object.prototype.hasOwnProperty.call(input, key)
    return {
      status: meta.status,
      functionalPass: false,
      reason: omitted ? meta.omitReason : meta.falseReason,
      failedGate: key,
      gateOmitted: omitted,
    }
  }

  return {
    status: 'PASS',
    functionalPass: true,
    reason: 'live metrics within explicit thresholds with all affirmative gates',
  }
}

/**
 * Detect data-bundle-shaped JSON (for server-fn response rewrite / plan).
 */
export function looksLikeDataBundle(value) {
  let obj = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!obj || typeof obj !== 'object') return false
  return Boolean(obj.features && obj.premium && obj.projects)
}

/**
 * Detect graph.json shape.
 */
export function looksLikeGraph(value) {
  let obj = value
  if (typeof value === 'string') {
    try {
      obj = JSON.parse(value)
    } catch {
      return false
    }
  }
  if (!obj || typeof obj !== 'object') return false
  return Array.isArray(obj.nodes) && Array.isArray(obj.edges)
}

/**
 * Resolve serverFn ids for route injection (env overrides).
 */
export function resolveServerFnIds(opts = {}) {
  return {
    getFlowDataBundleFn:
      opts.getFlowDataBundleFn ||
      process.env.CANON_FLOW_PERF_SERVERFN_BUNDLE_ID ||
      DEFAULT_SERVERFN_IDS.getFlowDataBundleFn,
    getFlowGraphFn:
      opts.getFlowGraphFn ||
      process.env.CANON_FLOW_PERF_SERVERFN_GRAPH_ID ||
      DEFAULT_SERVERFN_IDS.getFlowGraphFn,
  }
}

/**
 * Pure self-test for helper module (positive + negative).
 */
export function runHelperSelfTest() {
  const failures = []
  const cases = {}

  // percentile
  if (percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95) !== 10) {
    failures.push('p95 expected 10')
    cases.percentile = 'FAIL'
  } else if (percentile([], 95) !== null) {
    failures.push('empty percentile must be null')
    cases.percentile = 'FAIL'
  } else {
    cases.percentile = 'PASS'
  }

  // fixture graph deterministic
  const g1 = generateScaleGraphFixture({ nodeCount: 20, edgeCount: 25, seed: 't' })
  const g2 = generateScaleGraphFixture({ nodeCount: 20, edgeCount: 25, seed: 't' })
  if (g1.payloadSha256 !== g2.payloadSha256 || g1.graph.nodes.length !== 20) {
    failures.push('graph fixture not deterministic or wrong size')
    cases.graphFixture = 'FAIL'
  } else {
    cases.graphFixture = 'PASS'
  }

  // data bundle
  const b = generateScaleDataBundle({ featuresPerProject: 12, seed: 't' })
  if (b.config.featureTotal !== 12 * PROJECT_KEYS.length) {
    failures.push('bundle feature total wrong')
    cases.bundleFixture = 'FAIL'
  } else if (!looksLikeDataBundle(b.bundle)) {
    failures.push('bundle shape')
    cases.bundleFixture = 'FAIL'
  } else {
    cases.bundleFixture = 'PASS'
  }

  const est = estimateRenderedGraph(b.bundle, 'backend')
  if (est.nodes !== 12) {
    failures.push(`estimate backend nodes ${est.nodes}`)
    cases.estimate = 'FAIL'
  } else {
    cases.estimate = 'PASS'
  }

  // positive evaluators
  const fipOk = evaluateFirstInteractivePaint({ valueMs: 800, budgetMs: 3500 })
  const fipBad = evaluateFirstInteractivePaint({})
  const fipOver = evaluateFirstInteractivePaint({ valueMs: 9000, budgetMs: 3500 })
  if (!fipOk.pass || fipBad.pass || fipOver.pass) {
    failures.push('FIP evaluator pos/neg')
    cases.fip = 'FAIL'
  } else {
    cases.fip = 'PASS'
  }

  const frames = Array.from({ length: 20 }, () => 12)
  frames[19] = 40
  const panOk = evaluateFrameP95({ framesMs: frames, budgetMs: 50, gesture: 'pan' })
  const panMissing = evaluateFrameP95({ framesMs: [], budgetMs: 50, gesture: 'pan' })
  const panOver = evaluateFrameP95({
    framesMs: Array.from({ length: 20 }, () => 80),
    budgetMs: 50,
    gesture: 'pan',
  })
  if (!panOk.pass || panMissing.pass || panOver.pass) {
    failures.push('frame p95 evaluator')
    cases.frameP95 = 'FAIL'
  } else {
    cases.frameP95 = 'PASS'
  }

  const ltOk = evaluateLongTasks({
    longTasks: [{ duration: 40 }, { duration: 30 }],
    budgetMaxMs: 100,
    budgetMaxCount: 8,
  })
  const ltMissing = evaluateLongTasks({ observed: true })
  const ltOver = evaluateLongTasks({
    longTasks: [{ duration: 200 }],
    budgetMaxMs: 100,
    budgetMaxCount: 8,
  })
  if (!ltOk.pass || ltMissing.pass || ltOver.pass) {
    failures.push('long task evaluator')
    cases.longTasks = 'FAIL'
  } else {
    cases.longTasks = 'PASS'
  }

  // Soft/empty canvas is observe-only (must not fail aggregate path)
  const canvasSoft = evaluateCanvasRedraw({ valueMs: 20, budgetMs: 80 })
  const canvasEmpty = evaluateCanvasRedraw({})
  const canvasProductOk = evaluateCanvasRedraw({
    valueMs: 20,
    budgetMs: 80,
    productRedrawSampled: true,
  })
  const canvasProductMissing = evaluateCanvasRedraw({ productRedrawSampled: true })
  const canvasProductOver = evaluateCanvasRedraw({
    valueMs: 500,
    budgetMs: 80,
    productRedrawSampled: true,
  })
  if (
    !canvasSoft.observeOnly ||
    !canvasEmpty.observeOnly ||
    !canvasSoft.pass ||
    !canvasEmpty.pass ||
    !canvasProductOk.pass ||
    canvasProductMissing.pass ||
    canvasProductOver.pass
  ) {
    failures.push('canvas evaluator soft/product')
    cases.canvas = 'FAIL'
  } else {
    cases.canvas = 'PASS'
  }

  // Wire payload gates; local payload is observe-only (not wire transfer)
  const heapWireOk = evaluateHeapPayload({
    heapUsedMb: 100,
    payloadBytes: 10_000,
    payloadSource: 'wire',
  })
  const heapLocalOnly = evaluateHeapPayload({
    heapUsedMb: 100,
    payloadBytes: 10_000,
    payloadSource: 'local',
  })
  const heapWireMissing = evaluateHeapPayload({
    heapUsedMb: 100,
    payloadSource: 'wire',
  })
  const heapWireOver = evaluateHeapPayload({
    payloadBytes: DEFAULT_THRESHOLDS.payloadBytesMax + 1,
    payloadSource: 'wire',
  })
  if (
    !heapWireOk.pass ||
    !heapLocalOnly.pass ||
    heapLocalOnly.payloadObserveOnly !== true ||
    heapLocalOnly.payloadSource !== 'local' ||
    heapWireMissing.pass ||
    heapWireOver.pass ||
    heapWireOk.payloadObserveOnly === true
  ) {
    failures.push('heap/payload wire vs local observe-only')
    cases.heapPayload = 'FAIL'
  } else {
    cases.heapPayload = 'PASS'
  }

  const nodesOk = evaluateRenderedNodes({ renderedNodeCount: 80, minRenderedNodes: 50 })
  const nodesBad = evaluateRenderedNodes({ renderedNodeCount: 3, minRenderedNodes: 50 })
  const nodesNativeAlone = evaluateRenderedNodes({
    renderedNodeCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
  })
  if (!nodesOk.pass || nodesBad.pass || nodesNativeAlone.pass) {
    failures.push('rendered nodes evaluator / native floor')
    cases.renderedNodes = 'FAIL'
  } else {
    cases.renderedNodes = 'PASS'
  }

  // Honest floor never auto-softens below native+1 / default
  const softAttempt = resolveHonestMinRenderedNodes({ minRenderedNodes: 10 })
  const defaultHonest = resolveHonestMinRenderedNodes({})
  if (
    softAttempt < DEFAULT_THRESHOLDS.minRenderedNodes ||
    softAttempt <= NATIVE_PUBLIC_BACKEND_FEATURE_COUNT ||
    defaultHonest <= NATIVE_PUBLIC_BACKEND_FEATURE_COUNT
  ) {
    failures.push('honest min nodes must not soften below native/default floor')
    cases.honestMinNodes = 'FAIL'
  } else {
    cases.honestMinNodes = 'PASS'
  }

  // Fixture injection proof — routeHits=0 + native 41 must not prove
  const injNative = proveFixtureInjection({
    routeHits: 0,
    renderedNodeCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    markerHeaderVerified: false,
  })
  const injRoute = proveFixtureInjection({
    routeHits: 2,
    markerHeaderVerified: true,
    responseFixtureHash: 'abc',
    expectedFixtureHash: 'abc',
  })
  const injDom = proveFixtureInjection({
    routeHits: 0,
    domMarkerVerified: true,
    domMarkerBoundToFixtureHash: true,
    perfFixtureNodeCount: 12,
    expectedFixtureHash: 'abc',
  })
  const injSsrNoMarker = proveFixtureInjection({
    routeHits: 0,
    renderedNodeCount: 80,
    markerHeaderVerified: false,
    domMarkerVerified: false,
  })
  if (
    injNative.proven ||
    !injRoute.proven ||
    !injDom.proven ||
    injSsrNoMarker.proven ||
    !String(injNative.reason || '').includes('native_node_count_alone_insufficient')
  ) {
    failures.push('fixture injection proof pos/neg')
    cases.fixtureInjectionProof = 'FAIL'
  } else {
    cases.fixtureInjectionProof = 'PASS'
  }

  // aggregate fail-closed on missing gated metrics (canvas soft-ok; payload local soft-ok)
  const allMissing = evaluateAllPerfMetrics({})
  if (allMissing.pass) {
    failures.push('aggregate must fail when metrics missing')
    cases.aggregateFailClosed = 'FAIL'
  } else {
    cases.aggregateFailClosed = 'PASS'
  }

  // classify — never fake PASS; omitted keys fail
  const noServer = classifyPerfRunStatus({ serverReachable: false })
  const noAuth = classifyPerfRunStatus({
    serverReachable: true,
    authOk: false,
  })
  const omittedOnlyThresholds = classifyPerfRunStatus({ allThresholdsPass: true })
  const omittedFixture = classifyPerfRunStatus({
    serverReachable: true,
    authOk: true,
    landedOnFlow: true,
    metricsComplete: true,
    allThresholdsPass: true,
    // fixtureInjected omitted
  })
  const allAffirmative = classifyPerfRunStatus({
    serverReachable: true,
    authOk: true,
    landedOnFlow: true,
    fixtureInjected: true,
    metricsComplete: true,
    allThresholdsPass: true,
  })
  if (
    noServer.functionalPass ||
    noAuth.functionalPass ||
    noServer.status === 'PASS' ||
    omittedOnlyThresholds.functionalPass ||
    omittedOnlyThresholds.status === 'PASS' ||
    omittedFixture.functionalPass ||
    omittedFixture.gateOmitted !== true ||
    !allAffirmative.functionalPass ||
    allAffirmative.status !== 'PASS'
  ) {
    failures.push('classify must require all affirmative keys; omitted fail')
    cases.classify = 'FAIL'
  } else {
    cases.classify = 'PASS'
  }

  // no baseline bless flag in helper contract (contractual; bless path absent)
  if (typeof globalThis.blessBaseline === 'function') {
    failures.push('baseline bless must remain forbidden')
    cases.baselineBlessForbidden = 'FAIL'
  } else {
    cases.baselineBlessForbidden = 'PASS'
  }

  return {
    ok: failures.length === 0,
    schema: PERF_HELPER_SCHEMA,
    targetGate: TARGET_GATE,
    cases,
    failures,
    status: failures.length === 0 ? 'HARNESS_READY' : 'FAIL',
    nativePublicBackendFeatureCount: NATIVE_PUBLIC_BACKEND_FEATURE_COUNT,
    honestMinRenderedNodes: resolveHonestMinRenderedNodes({}),
  }
}
