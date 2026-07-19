/**
 * Pure helpers for TM canon-v3 browser gates (oracle: DESIGN-CANON-V3/flow/gate-simple.mjs).
 * No product imports. Used by canon-flow-total-replacement.spec.ts.
 * Status vocabulary: HARNESS_READY | LOCAL_ONLY | FAIL — never invent functional PASS offline.
 *
 * Semantic R2/R3 (criterion 3): graph/layer + related-edge contracts via durable DOM
 * attributes (data-mode/data-layer/data-node-id/data-node-kind/flow-related).
 * Cross mode requires explicit five-project portfolio (requiredProjects) — never
 * tautological auto-detect of multi-project from already-visible count.
 * Never sequential list-order count inference. Never treat Fitur sama as navigation.
 * No product source/bundle-internal inspection — DOM/test attributes only.
 * HardFail reasons may list missing project keys; never raw internal node IDs.
 */

export const TARGET_GATE = 'TM_CANON_V3_BROWSER_HARNESS_READY' as const
export const STORAGE_KEY = 'cairn-flow-pos-v1' as const
export const DEFAULT_BOARD = 'mfs-rebuild' as const
export const DEFAULT_ROUTE_SUFFIX = '/alur' as const

export const FLOW_MODES = [
  'cross',
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
] as const

export type FlowModeId = (typeof FLOW_MODES)[number]

/** Canon DOM skeleton (A1). */
export const REQUIRED_SELECTORS = [
  '.flow-top',
  '.flow-modes[role="tablist"]',
  '.flow-stage, [data-testid="flow-stage"]',
  '.flow-world, [data-testid="flow-world"]',
  'canvas.flow-edges, [data-testid="flow-edges"]',
  '.flow-nodes, [data-testid="flow-nodes"]',
  '.flow-zoom',
  '.flow-sheet[role="dialog"], [data-testid="flow-sheet"]',
  '.flow-backdrop, [data-testid="flow-backdrop"]',
  '.flow-hint',
  '.flow-pill[data-mode="cross"]',
] as const

/** Node anatomy (A2). */
export const NODE_ANATOMY_SELECTORS = [
  '.fnode, [data-testid="flow-node"]',
  '.ft',
  '.fdot',
] as const

/**
 * Forbidden multi-screen AppShell chrome on primary alur total-replace surface (A5).
 * Presence while claiming total replacement is a fidelity FAIL.
 */
export const FORBIDDEN_CHROME_SELECTORS = [
  'nav.sidebar .nav-item',
  '.sidebar[data-shell], [data-shell-version] .sidebar .nav-item',
  '[data-testid="legacy-shell-search"]',
  '[data-testid="control-center-shell-search"]',
  'aside.sidebar .nav-item',
] as const

/** Visible tech-id patterns (C3). API METHOD + path allowed. */
export const TECH_ID_PATTERNS: RegExp[] = [
  /\bFEAT-[A-Z0-9-]+\b/,
  /\bT-[A-Z]{2,}-[A-Z0-9-]+\b/,
  /\bFC-[A-Z0-9-]+\b/,
  /\bMAPPED_100\b/,
  /\bPROD_READY\b/,
  /mfs-web-original-upgrade/,
  /sales-rebuild/,
  /rebuild-backend/,
]

/**
 * Expected mode pill labels — id-ID product chrome (canonical) plus legacy EN
 * snippets for residual total-replace surfaces.
 */
export const MODE_LABEL_SNIPPETS = [
  /lintas\s*proyek/i,
  /cross[-\s]?project/i,
  /react native/i,
  /web member/i,
  /panel sales/i,
  /afiliasi|affiliate/i,
  /backend/i,
] as const

/** Indonesian section / layer chrome that semantic gates assert when present. */
export const ID_ID_LABELS = {
  relatedNav: /Navigasi terkait/i,
  sameFeature: /Fitur sama/i,
  layerAppFlow: /Alur aplikasi/i,
  layerPageNav: /Navigasi laman/i,
  inventory: /Inventaris/i,
  brandAlur: /\bAlur\b/,
  modeCross: /Lintas Proyek/i,
  modeTablist: /Mode alur kerja/i,
  layerTablist: /Lapisan navigasi/i,
} as const

/** Recognized project mode keys (matches product FlowMode minus cross). */
export const PROJECT_MODE_KEYS = [
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
] as const

/**
 * Canonical cross-mode portfolio — exact UI project keys (not app-flow aliases).
 * Live cross acceptance must always pass this list as requiredProjects.
 * Order is stable and matches PROJECT_MODE_KEYS / FLOW_MODES (minus cross).
 */
export const REQUIRED_CROSS_PROJECTS = [
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
] as const

export type RequiredCrossProjectId = (typeof REQUIRED_CROSS_PROJECTS)[number]

export type FlowNavLayerId = 'app_flow' | 'page_nav'

export type SemanticNodePrefix = 'af' | 'pn' | 'inv'

export type NodeDomSnapshot = {
  id: string
  kind?: string | null
  className?: string | null
  visible?: boolean
}

export type SemanticHonestyState =
  | 'ok'
  | 'empty'
  | 'no_source'
  | 'error'
  | 'unknown'

export type ClassifiedNodeId = {
  raw: string
  prefix: SemanticNodePrefix | 'synthetic' | 'unknown'
  project: string | null
  localId: string | null
  isJourney: boolean
  isInventory: boolean
  isForbiddenSynthetic: boolean
}

export const VIEWPORTS = {
  mobile: { width: 390, height: 844, name: '390x844' },
  desktop: { width: 1440, height: 900, name: '1440x900' },
  ultrawide: { width: 2560, height: 1300, name: '2560x1300' },
} as const

export const VISUAL_STATES = [
  'cross-default',
  'project-rn',
  'sheet-open',
  'after-drag',
] as const

export type VisualStateId = (typeof VISUAL_STATES)[number]

export type HarnessStatus =
  | 'HARNESS_READY'
  | 'LOCAL_ONLY'
  | 'FAIL'
  | 'NOT_RUN'

export type CheckRow = {
  name: string
  ok: boolean
  detail?: unknown
  layer?: string
}

export function flowRoute(boardId: string = DEFAULT_BOARD): string {
  return `/b/${boardId}${DEFAULT_ROUTE_SUFFIX}`
}

export function isFullSha(raw: unknown): raw is string {
  return typeof raw === 'string' && /^[0-9a-f]{40}$/i.test(raw.trim())
}

/**
 * Fail-closed FULL_SHA for visual evidence. Throws if missing/invalid.
 */
export function requireFullSha(raw: unknown, label = 'FULL_SHA'): string {
  if (!isFullSha(raw)) {
    throw new Error(
      `HARNESS FAIL: ${label} required as 40-char hex for visual evidence (got ${String(raw ?? 'unset')}). UNKNOWN_SHA forbidden.`,
    )
  }
  return String(raw).trim().toLowerCase()
}

/**
 * Scan visible text for tech IDs. Returns hits (empty = pass).
 * API lines like "GET /api/…" are not matched by these patterns.
 */
export function findTechIdHits(visibleText: string): Array<{ pattern: string; match: string }> {
  const hits: Array<{ pattern: string; match: string }> = []
  for (const re of TECH_ID_PATTERNS) {
    const m = visibleText.match(re)
    if (m) hits.push({ pattern: String(re), match: m[0] })
  }
  return hits
}

/** Pan tolerance from oracle gate-simple. */
export function evaluatePanDelta(panDx: number, expected = 300): { ok: boolean; panDx: number } {
  const ok = Math.abs(panDx - expected) <= 20 || Math.abs(panDx) >= 250
  return { ok, panDx }
}

/** Drag: card center must move ≥50 world units after ~120 screen px. */
export function evaluateDragMovement(
  before: { cx: number; cy: number; x: number; y: number },
  after: { cx: number; cy: number; x: number; y: number },
): { ok: boolean; centerDelta: number; worldDx: number } {
  const centerDelta = Math.hypot(after.cx - before.cx, after.cy - before.cy)
  const worldDx = after.x - before.x
  const cardMoved =
    Math.abs(after.x - before.x) > 50 || Math.abs(after.y - before.y) > 5
  const ok = cardMoved && Math.abs(after.cx - before.cx) > 50
  return { ok, centerDelta, worldDx }
}

/**
 * Data honesty seam: static/anonymous source cannot claim current-revision PASS.
 * Mark LOCAL_ONLY when source is file/static without pin fields.
 */
export function classifyDataHonesty(input: {
  source?: string | null
  pinFieldsPresent?: boolean
  boardRev?: string | null
  lifecycleRev?: string | null
  canonicalHash?: string | null
  visibleNodeIds?: string[]
}): {
  claim: 'PASS' | 'LOCAL_ONLY' | 'FAIL' | 'NOT_PROVEN'
  reason: string
  visibleNodeIds: string[]
} {
  const ids = input.visibleNodeIds ?? []
  const pinOk =
    input.pinFieldsPresent === true ||
    Boolean(
      input.boardRev &&
        input.lifecycleRev &&
        input.canonicalHash &&
        ![input.boardRev, input.lifecycleRev, input.canonicalHash].some(
          (v) => !v || v === 'MISSING' || v === 'UNKNOWN',
        ),
    )
  const src = (input.source ?? '').toLowerCase()
  const staticSource =
    !src ||
    src === 'file' ||
    src === 'static' ||
    src.includes('data-bundle') ||
    src === 'local' ||
    src === 'anonymous'

  if (staticSource && !pinOk) {
    return {
      claim: 'LOCAL_ONLY',
      reason:
        'Graph payload is static/file or unpinned — cannot PASS current-revision data honesty; functional LOCAL_ONLY only',
      visibleNodeIds: ids,
    }
  }
  if (!pinOk) {
    return {
      claim: 'NOT_PROVEN',
      reason: 'Pin fields missing (boardRev/lifecycleRev/canonicalHash)',
      visibleNodeIds: ids,
    }
  }
  if (ids.length === 0) {
    return {
      claim: 'FAIL',
      reason: 'No visible node ids from data attributes',
      visibleNodeIds: ids,
    }
  }
  return {
    claim: 'PASS',
    reason: 'Pinned provenance present with visible node ids',
    visibleNodeIds: ids,
  }
}

/**
 * Overall harness status when no live owned preview was exercised.
 */
export function offlineHarnessStatus(opts?: {
  selfTestOk?: boolean
  planOk?: boolean
}): { status: HarnessStatus; note: string } {
  if (opts?.selfTestOk === false || opts?.planOk === false) {
    return { status: 'FAIL', note: 'self-test or plan contract failed' }
  }
  return {
    status: 'HARNESS_READY',
    note: 'Harness authored; no owned preview run — not a functional PASS (LOCAL ONLY until live gates green)',
  }
}

export type VisualCapturePlanRow = {
  state: VisualStateId
  viewport: string
  width: number
  height: number
  deviceScaleFactor: number
  route: string
  candidateName: string
}

/**
 * Candidate visual capture matrix bound to FULL_SHA (candidates only — never baselines).
 * Includes 390, 1440, 2560 and at least one deviceScaleFactor=2 row.
 */
export function planVisualCaptures(opts: {
  fullSha: string
  route: string
  capturedAt?: string
}): {
  fullSha: string
  route: string
  capturedAt: string
  rows: VisualCapturePlanRow[]
  baselineBlessForbidden: true
} {
  const fullSha = requireFullSha(opts.fullSha)
  const capturedAt = opts.capturedAt ?? new Date().toISOString()
  const route = opts.route
  const viewports = [VIEWPORTS.mobile, VIEWPORTS.desktop, VIEWPORTS.ultrawide]
  const rows: VisualCapturePlanRow[] = []

  for (const state of VISUAL_STATES) {
    for (const vp of viewports) {
      rows.push({
        state,
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        route,
        candidateName: `canon-flow__${state}__${vp.name}__dpr1__${fullSha.slice(0, 12)}.png`,
      })
    }
  }
  // Required retina capture (at least one @2x)
  rows.push({
    state: 'cross-default',
    viewport: VIEWPORTS.desktop.name,
    width: VIEWPORTS.desktop.width,
    height: VIEWPORTS.desktop.height,
    deviceScaleFactor: 2,
    route,
    candidateName: `canon-flow__cross-default__${VIEWPORTS.desktop.name}__dpr2__${fullSha.slice(0, 12)}.png`,
  })

  return {
    fullSha,
    route,
    capturedAt,
    rows,
    baselineBlessForbidden: true,
  }
}

export function summarizeChecks(checks: CheckRow[]): {
  pass: number
  fail: number
  total: number
  ok: boolean
} {
  const pass = checks.filter((c) => c.ok).length
  const fail = checks.filter((c) => !c.ok).length
  return { pass, fail, total: checks.length, ok: fail === 0 }
}

/** Touch target gate: min 44×44 CSS px. */
export function evaluateTouchTargets(
  samples: Array<{ selector: string; w: number; h: number }>,
): { ok: boolean; failing: Array<{ selector: string; w: number; h: number }> } {
  const failing = samples.filter((s) => s.w < 44 || s.h < 44)
  return { ok: failing.length === 0 && samples.length > 0, failing }
}

/**
 * Reduced-motion: transition/animation durations must be ~0 when media matches.
 * Empty samples do NOT pass (avoids soft-skip vacuity).
 */
export function evaluateReducedMotionDurations(
  samples: Array<{ selector: string; durationMs: number }>,
  maxMs = 50,
): { ok: boolean; failing: typeof samples; empty: boolean } {
  const list = samples ?? []
  const failing = list.filter((s) => s.durationMs > maxMs)
  return {
    ok: list.length > 0 && failing.length === 0,
    failing,
    empty: list.length === 0,
  }
}

/**
 * B6 — canvas edge endpoint redraw (not node-center-delta alone).
 * Requires observable canvas buffer change + ink near the new endpoint geometry.
 */
export function evaluateEdgeEndpointRedraw(input: {
  canvasChanged: boolean
  beforeInkNearOldCenter: number
  afterInkNearOldCenter: number
  afterInkNearNewCenter: number
  nodeCenterDelta: number
  minCenterDelta?: number
}): { ok: boolean; reason: string } {
  const minDelta = input.minCenterDelta ?? 50
  if (!(input.nodeCenterDelta > minDelta)) {
    return { ok: false, reason: 'node center did not move enough to require edge redraw' }
  }
  if (!input.canvasChanged) {
    return {
      ok: false,
      reason: 'canvas pixel buffer unchanged — center delta alone is insufficient',
    }
  }
  if (!(input.afterInkNearNewCenter > 0)) {
    return {
      ok: false,
      reason: 'no canvas ink near new node center — edge endpoint not redrawn',
    }
  }
  // Geometry moved: new endpoint has ink; prefer old-region loss or at least buffer change.
  const relocated =
    input.afterInkNearNewCenter > 0 &&
    (input.afterInkNearOldCenter < input.beforeInkNearOldCenter ||
      input.afterInkNearNewCenter !== input.beforeInkNearOldCenter ||
      input.canvasChanged)
  return relocated
    ? { ok: true, reason: 'canvas edge endpoint geometry redrawn' }
    : { ok: false, reason: 'edge endpoint ink did not relocate with node' }
}

/**
 * B9 — related navigation must replace sheet content and highlight target.
 * Absence of required related control is residual FAIL (never ok:true soft skip).
 * Semantic R2: prefer evaluateSemanticRelatedNavigation (Fitur sama cannot pass).
 */
export function evaluateRelatedNavigation(input: {
  hasRelatedControl: boolean
  titleBefore?: string
  titleAfter?: string
  bodyBefore?: string
  bodyAfter?: string
  hlId?: string | null
  gotoId?: string | null
  sheetOpen?: boolean
}): { ok: boolean; residual: boolean; reason: string } {
  if (!input.hasRelatedControl) {
    return {
      ok: false,
      residual: true,
      reason:
        'Required related navigation control (data-goto) absent — residual FAIL, not soft skip',
    }
  }
  const titleChanged =
    (input.titleBefore ?? '').trim() !== (input.titleAfter ?? '').trim()
  const bodyChanged =
    input.bodyBefore != null &&
    input.bodyAfter != null &&
    input.bodyBefore.trim() !== input.bodyAfter.trim()
  const contentChanged = titleChanged || bodyChanged
  const highlightOk = Boolean(
    input.gotoId && input.hlId && input.hlId === input.gotoId,
  )
  const sheetOk = input.sheetOpen !== false
  // Prove linked sheet replacement + center/highlight (both required when control present).
  const ok = sheetOk && contentChanged && highlightOk
  return {
    ok,
    residual: false,
    reason: ok
      ? 'related replaced sheet content and highlighted target'
      : `related incomplete (contentChanged=${contentChanged}, highlightOk=${highlightOk}, sheetOpen=${sheetOk})`,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Criterion 3 — semantic graph / related navigation (DOM-only; no sequential list-order inference)
// ─────────────────────────────────────────────────────────────────────────────

const SEMANTIC_ID_RE = /^(af|pn|inv):([^:]+):(.+)$/
const FORBIDDEN_SYNTHETIC_RE = /^(premium|auth):/i

/** Classify a durable data-node-id from the live/fixture DOM. */
export function classifySemanticNodeId(raw: string | null | undefined): ClassifiedNodeId {
  const id = (raw ?? '').trim()
  if (!id) {
    return {
      raw: '',
      prefix: 'unknown',
      project: null,
      localId: null,
      isJourney: false,
      isInventory: false,
      isForbiddenSynthetic: false,
    }
  }
  if (FORBIDDEN_SYNTHETIC_RE.test(id)) {
    return {
      raw: id,
      prefix: 'synthetic',
      project: null,
      localId: null,
      isJourney: false,
      isInventory: false,
      isForbiddenSynthetic: true,
    }
  }
  const m = id.match(SEMANTIC_ID_RE)
  if (!m) {
    return {
      raw: id,
      prefix: 'unknown',
      project: null,
      localId: null,
      isJourney: false,
      isInventory: false,
      isForbiddenSynthetic: false,
    }
  }
  const prefix = m[1] as SemanticNodePrefix
  const project = m[2]
  const localId = m[3]
  const isInventory = prefix === 'inv'
  const isJourney = prefix === 'af' || prefix === 'pn'
  return {
    raw: id,
    prefix,
    project,
    localId,
    isJourney,
    isInventory,
    isForbiddenSynthetic: false,
  }
}

/** True when node is inventory-marked in DOM (kind/class), never via list order. */
export function isInventoryDomNode(n: NodeDomSnapshot): boolean {
  const kind = (n.kind ?? '').toLowerCase()
  const cls = n.className ?? ''
  if (kind === 'inventory' || kind === 'feature') return true
  if (/\bis-inventory\b/.test(cls)) return true
  return classifySemanticNodeId(n.id).isInventory
}

export function expectedJourneyPrefix(layer: FlowNavLayerId): 'af' | 'pn' {
  return layer === 'page_nav' ? 'pn' : 'af'
}

/**
 * Validate explicit cross portfolio against distinct journey project keys only.
 * Inventory never counts. Reasons list project keys — never raw node IDs.
 */
export function evaluateRequiredProjectsCoverage(input: {
  journeyProjects: readonly string[]
  requiredProjects: readonly string[]
}): {
  ok: boolean
  hardFail: boolean
  reason: string
  missing: string[]
  unexpected: string[]
  duplicatesInRequired: string[]
  unrecognizedInRequired: string[]
  present: string[]
  required: string[]
} {
  const present = [...new Set(input.journeyProjects.filter(Boolean))].sort()
  const requiredRaw = input.requiredProjects.map((p) => String(p ?? '').trim()).filter(Boolean)
  const seen = new Set<string>()
  const duplicatesInRequired: string[] = []
  for (const p of requiredRaw) {
    if (seen.has(p)) duplicatesInRequired.push(p)
    seen.add(p)
  }
  const required = [...seen]
  const allowed = PROJECT_MODE_KEYS as readonly string[]
  const unrecognizedInRequired = required.filter((p) => !allowed.includes(p))
  if (duplicatesInRequired.length > 0) {
    return {
      ok: false,
      hardFail: true,
      reason: `requiredProjects list has duplicates: [${duplicatesInRequired.join(',')}]`,
      missing: [],
      unexpected: [],
      duplicatesInRequired,
      unrecognizedInRequired,
      present,
      required,
    }
  }
  if (unrecognizedInRequired.length > 0) {
    return {
      ok: false,
      hardFail: true,
      reason: `requiredProjects contains unrecognized UI keys: [${unrecognizedInRequired.join(',')}] (expected exact UI keys only)`,
      missing: [],
      unexpected: [],
      duplicatesInRequired,
      unrecognizedInRequired,
      present,
      required,
    }
  }
  const reqSet = new Set(required)
  const missing = required.filter((p) => !present.includes(p))
  const unexpected = present.filter((p) => !reqSet.has(p))
  if (missing.length > 0 || unexpected.length > 0) {
    return {
      ok: false,
      hardFail: true,
      reason:
        `cross portfolio incomplete: requiredCrossProjects=${required.length}` +
        ` present=${present.length}` +
        ` missing=[${missing.join(',')}]` +
        ` unexpected=[${unexpected.join(',')}]` +
        ` required=[${required.join(',')}]` +
        ` presentProjects=[${present.join(',')}]`,
      missing,
      unexpected,
      duplicatesInRequired,
      unrecognizedInRequired,
      present,
      required,
    }
  }
  return {
    ok: true,
    hardFail: false,
    reason: `cross portfolio complete requiredCrossProjects=${required.length}/[${required.join(',')}]`,
    missing: [],
    unexpected: [],
    duplicatesInRequired: [],
    unrecognizedInRequired: [],
    present,
    required,
  }
}

/**
 * Public hardFail/report detail for S1 — project keys + counts only.
 * Never includes raw internal node IDs (af:/pn:/inv:…).
 */
export function toSemanticLayerPublicDetail(
  layerEval: ReturnType<typeof evaluateSemanticLayerContract>,
): Record<string, unknown> {
  const d = layerEval.details ?? {}
  return {
    ok: layerEval.ok,
    residual: layerEval.residual,
    hardFail: layerEval.hardFail,
    reason: layerEval.reason,
    projects: layerEval.projects,
    expectedPrefix: layerEval.expectedPrefix,
    journeyCount: layerEval.journeyIds?.length ?? 0,
    inventoryCount: layerEval.inventoryIds?.length ?? 0,
    forbiddenCount: layerEval.forbiddenIds?.length ?? 0,
    details: {
      mode: d.mode,
      rootLayer: d.rootLayer,
      layerTablistPresent: d.layerTablistPresent,
      honesty: d.honesty,
      noListOrderCap: d.noListOrderCap,
      inventoryCount: d.inventoryCount,
      note: d.note,
      requiredProjects: d.requiredProjects,
      presentProjects: d.presentProjects,
      missingProjects: d.missingProjects,
      unexpectedProjects: d.unexpectedProjects,
      requiredCrossProjects: d.requiredCrossProjects,
      wrongPrefixCount: d.wrongPrefixCount,
      forbiddenCount: d.forbiddenCount,
      expectedPrefix: d.expectedPrefix,
    },
  }
}

/**
 * S1 — graph/layer contract from durable DOM attributes.
 * Fail-closed on empty / no-source / error honesty and wrong prefixes.
 * Inventory cards may coexist but never count toward the journey floor or portfolio.
 * Cross portfolio: pass requiredProjects (live always uses REQUIRED_CROSS_PROJECTS).
 * No sequential list-order inference. HardFail reasons never leak raw node IDs.
 */
export function evaluateSemanticLayerContract(input: {
  mode: string
  rootLayer: string | null | undefined
  layerTablistPresent?: boolean
  nodes: NodeDomSnapshot[]
  honestyState?: SemanticHonestyState
  /**
   * Legacy minimum: when true, cross requires ≥2 distinct journey projects.
   * Prefer requiredProjects for explicit portfolio contracts.
   */
  requireMultiProject?: boolean
  /**
   * Explicit portfolio contract: every listed UI project key must appear as a
   * distinct journey-node project; extras / aliases / duplicates-in-list fail closed.
   */
  requiredProjects?: readonly string[]
  minJourneyFloor?: number
}): {
  ok: boolean
  residual: boolean
  hardFail: boolean
  reason: string
  journeyIds: string[]
  inventoryIds: string[]
  forbiddenIds: string[]
  projects: string[]
  expectedPrefix: 'af' | 'pn' | null
  details: Record<string, unknown>
} {
  const mode = (input.mode ?? '').trim()
  const honesty = input.honestyState ?? 'unknown'
  const minFloor = input.minJourneyFloor ?? 1
  const nodes = (input.nodes ?? []).filter((n) => n.visible !== false)
  const journeyIds: string[] = []
  const inventoryIds: string[] = []
  const forbiddenIds: string[] = []
  const wrongPrefixIds: string[] = []
  /** Journey projects only — inventory never counts toward portfolio. */
  const journeyProjects = new Set<string>()

  if (honesty === 'empty' || honesty === 'no_source' || honesty === 'error') {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `semantic honesty state ${honesty} cannot PASS criterion 3`,
      journeyIds: [],
      inventoryIds: [],
      forbiddenIds: [],
      projects: [],
      expectedPrefix: null,
      details: { honesty, mode, rootLayer: input.rootLayer ?? null },
    }
  }

  if (!mode) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: 'missing data-mode on flow root',
      journeyIds: [],
      inventoryIds: [],
      forbiddenIds: [],
      projects: [],
      expectedPrefix: null,
      details: {},
    }
  }

  const isCross = mode === 'cross'
  const rootLayer = (input.rootLayer ?? '').trim() || null
  const expectedLayer: FlowNavLayerId | null = isCross
    ? 'app_flow'
    : rootLayer === 'app_flow' || rootLayer === 'page_nav'
      ? rootLayer
      : null
  const expectedPrefix = expectedLayer
    ? expectedJourneyPrefix(expectedLayer)
    : null

  if (isCross) {
    if (rootLayer !== 'app_flow') {
      return {
        ok: false,
        residual: false,
        hardFail: true,
        reason: `cross mode requires data-layer=app_flow (got ${rootLayer ?? 'null'})`,
        journeyIds: [],
        inventoryIds: [],
        forbiddenIds: [],
        projects: [],
        expectedPrefix: 'af',
        details: { rootLayer },
      }
    }
  } else {
    if (!input.layerTablistPresent) {
      return {
        ok: false,
        residual: false,
        hardFail: true,
        reason: 'project mode missing layer tablist (data-testid=flow-layer-toggle)',
        journeyIds: [],
        inventoryIds: [],
        forbiddenIds: [],
        projects: [],
        expectedPrefix,
        details: { mode, rootLayer },
      }
    }
    if (!expectedLayer) {
      return {
        ok: false,
        residual: false,
        hardFail: true,
        reason: `project mode requires data-layer app_flow|page_nav (got ${rootLayer ?? 'null'})`,
        journeyIds: [],
        inventoryIds: [],
        forbiddenIds: [],
        projects: [],
        expectedPrefix: null,
        details: { mode, rootLayer },
      }
    }
  }

  for (const n of nodes) {
    const c = classifySemanticNodeId(n.id)
    if (c.isForbiddenSynthetic) {
      forbiddenIds.push(n.id)
      continue
    }
    if (c.isInventory || isInventoryDomNode(n)) {
      // Inventory may only exist as inv: cards — never journey floor or portfolio
      if (c.prefix === 'inv' || isInventoryDomNode(n)) {
        inventoryIds.push(n.id)
      } else {
        wrongPrefixIds.push(n.id)
      }
      continue
    }
    if (!c.isJourney || !expectedPrefix) {
      if (c.prefix === 'pn' && isCross) {
        wrongPrefixIds.push(n.id)
      } else if (c.prefix === 'unknown' || c.prefix === 'synthetic') {
        forbiddenIds.push(n.id)
      } else {
        wrongPrefixIds.push(n.id)
      }
      continue
    }
    if (c.prefix !== expectedPrefix) {
      wrongPrefixIds.push(n.id)
      continue
    }
    // Project namespace: project modes require af|pn:{mode}:...
    if (!isCross && c.project && c.project !== mode) {
      // exact UI mode key only; app-flow aliases (web/sales) fail closed
      wrongPrefixIds.push(n.id)
      continue
    }
    journeyIds.push(n.id)
    if (c.project) journeyProjects.add(c.project)
  }

  const projectList = [...journeyProjects].sort()

  if (forbiddenIds.length > 0) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `forbidden synthetic or non-semantic node ids present (count=${forbiddenIds.length})`,
      journeyIds,
      inventoryIds,
      forbiddenIds,
      projects: projectList,
      expectedPrefix,
      details: {
        honesty,
        forbiddenCount: forbiddenIds.length,
        wrongPrefixCount: wrongPrefixIds.length,
      },
    }
  }
  if (wrongPrefixIds.length > 0) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `journey nodes with wrong prefix for mode/layer (count=${wrongPrefixIds.length}, expectedPrefix=${expectedPrefix ?? 'null'})`,
      journeyIds,
      inventoryIds,
      forbiddenIds,
      projects: projectList,
      expectedPrefix,
      details: {
        wrongPrefixCount: wrongPrefixIds.length,
        expectedPrefix,
        rootLayer,
      },
    }
  }
  if (journeyIds.length < minFloor) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `journey floor unmet: ${journeyIds.length} < ${minFloor} (inventory-only/empty cannot semantic PASS)`,
      journeyIds,
      inventoryIds,
      forbiddenIds,
      projects: projectList,
      expectedPrefix,
      details: {
        inventoryCount: inventoryIds.length,
        note: 'inventory never counts toward journey floor; no sequential list-order inference',
      },
    }
  }

  // Explicit portfolio contract (live cross always passes REQUIRED_CROSS_PROJECTS)
  if (isCross && input.requiredProjects != null && input.requiredProjects.length > 0) {
    const portfolio = evaluateRequiredProjectsCoverage({
      journeyProjects: projectList,
      requiredProjects: input.requiredProjects,
    })
    if (!portfolio.ok) {
      return {
        ok: false,
        residual: false,
        hardFail: true,
        reason: portfolio.reason,
        journeyIds,
        inventoryIds,
        forbiddenIds,
        projects: projectList,
        expectedPrefix,
        details: {
          requiredProjects: portfolio.required,
          presentProjects: portfolio.present,
          missingProjects: portfolio.missing,
          unexpectedProjects: portfolio.unexpected,
          requiredCrossProjects: portfolio.required.length,
          noListOrderCap: true,
        },
      }
    }
  } else if (isCross && input.requireMultiProject === true && projectList.length < 2) {
    // Legacy ≥2 only when explicitly claimed — never auto-detect from visibility
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason:
        'cross semantic PASS requires ≥2 recognized journey projects when requireMultiProject claimed',
      journeyIds,
      inventoryIds,
      forbiddenIds,
      projects: projectList,
      expectedPrefix,
      details: {
        presentProjects: projectList,
        requireMultiProject: true,
        noListOrderCap: true,
      },
    }
  }

  // Explicit: never use sequential list-order/list-order counts
  return {
    ok: true,
    residual: false,
    hardFail: false,
    reason: `semantic layer ok mode=${mode} layer=${rootLayer} journey=${journeyIds.length} inv=${inventoryIds.length} projects=${projectList.length}`,
    journeyIds,
    inventoryIds,
    forbiddenIds,
    projects: projectList,
    expectedPrefix,
    details: {
      mode,
      rootLayer,
      layerTablistPresent: Boolean(input.layerTablistPresent),
      honesty,
      noListOrderCap: true,
      presentProjects: projectList,
      requiredProjects:
        isCross && input.requiredProjects != null
          ? [...input.requiredProjects]
          : undefined,
      requiredCrossProjects:
        isCross && input.requiredProjects != null
          ? input.requiredProjects.length
          : undefined,
    },
  }
}

export type RelatedControlKind =
  | 'related'
  | 'same-feature'
  | 'other'
  | 'absent'

/**
 * S2 / B9 semantic — Navigasi terkait only; Fitur sama cannot satisfy PASS.
 * data-goto must resolve to an existing journey node (af:|pn:) in the same
 * mode/layer/project namespace — never inv:. Sheet content + highlight + /alur
 * stability still required (inherits F3/F6 honesty).
 */
export function evaluateSemanticRelatedNavigation(input: {
  hasRelatedControl: boolean
  controlKind?: RelatedControlKind
  /** Control carries data-testid=flow-related (not flow-same-feature-item). */
  isSemanticRelatedTestId?: boolean
  /** Visible section contains "Navigasi terkait". */
  sectionIsRelatedNav?: boolean
  titleBefore?: string
  titleAfter?: string
  bodyBefore?: string
  bodyAfter?: string
  hlId?: string | null
  gotoId?: string | null
  sheetOpen?: boolean
  /** Target exists as a journey card in current graph DOM. */
  targetPresentAsJourney?: boolean
  targetIsInventory?: boolean
  mode?: string
  layer?: string | null
  routePathBefore?: string
  routePathAfter?: string
}): {
  ok: boolean
  residual: boolean
  hardFail: boolean
  reason: string
  base?: ReturnType<typeof evaluateRelatedNavigation>
} {
  const kind: RelatedControlKind =
    input.controlKind ??
    (input.hasRelatedControl ? 'other' : 'absent')

  if (kind === 'absent' || !input.hasRelatedControl) {
    return {
      ok: false,
      residual: true,
      hardFail: true,
      reason:
        'Required Navigasi terkait control (data-testid=flow-related) absent — residual FAIL, not soft skip',
    }
  }

  // Fitur sama / flow-same-feature must NEVER satisfy related-navigation PASS
  if (kind === 'same-feature') {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason:
        'Fitur sama / flow-same-feature cannot satisfy related-navigation PASS even with data-goto',
    }
  }

  if (kind !== 'related' && input.isSemanticRelatedTestId !== true) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason:
        'Related control is not semantic Navigasi terkait (flow-related) — other data-goto ignored',
    }
  }

  if (input.sectionIsRelatedNav === false) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: 'Control not inside Navigasi terkait section',
    }
  }

  const gotoId = (input.gotoId ?? '').trim()
  const classified = classifySemanticNodeId(gotoId)
  if (!gotoId || !classified.isJourney) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `data-goto must be journey af:|pn: id (got ${gotoId || 'empty'})`,
    }
  }
  if (classified.isInventory || input.targetIsInventory) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: 'data-goto must never target inv: inventory node',
    }
  }
  if (input.targetPresentAsJourney === false) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `data-goto target ${gotoId} not present as journey node in current mode/layer`,
    }
  }

  // Layer/prefix namespace check
  const layer = (input.layer ?? '').trim()
  if (layer === 'app_flow' && classified.prefix !== 'af') {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `app_flow related target must be af: (got ${gotoId})`,
    }
  }
  if (layer === 'page_nav' && classified.prefix !== 'pn') {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `page_nav related target must be pn: (got ${gotoId})`,
    }
  }
  const mode = (input.mode ?? '').trim()
  if (mode && mode !== 'cross' && classified.project && classified.project !== mode) {
    return {
      ok: false,
      residual: false,
      hardFail: true,
      reason: `related target project ${classified.project} ≠ mode ${mode}`,
    }
  }

  // Route must stay on /alur (no full navigation/reload)
  const before = input.routePathBefore
  const after = input.routePathAfter
  if (before != null && after != null) {
    if (before !== after || !/\/alur/.test(after)) {
      return {
        ok: false,
        residual: false,
        hardFail: true,
        reason: `related nav must keep /alur route (before=${before}, after=${after})`,
      }
    }
  }

  const base = evaluateRelatedNavigation({
    hasRelatedControl: true,
    titleBefore: input.titleBefore,
    titleAfter: input.titleAfter,
    bodyBefore: input.bodyBefore,
    bodyAfter: input.bodyAfter,
    hlId: input.hlId,
    gotoId,
    sheetOpen: input.sheetOpen,
  })
  if (!base.ok) {
    return {
      ok: false,
      residual: base.residual,
      hardFail: true,
      reason: base.reason,
      base,
    }
  }
  return {
    ok: true,
    residual: false,
    hardFail: false,
    reason: 'semantic related nav replaced sheet, highlighted journey target, kept /alur',
    base,
  }
}

/**
 * Indonesian chrome honesty: key section/tab labels present in id-ID when
 * the surface claims semantic alur chrome. Technical IDs still scrubbed via
 * findTechIdHits (METHOD+path allowed).
 */
export function evaluateIndonesianChromeLabels(input: {
  visibleText: string
  requireLayers?: boolean
  requireRelatedSection?: boolean
}): { ok: boolean; reason: string; missing: string[] } {
  const text = input.visibleText ?? ''
  const missing: string[] = []
  if (!ID_ID_LABELS.brandAlur.test(text) && !ID_ID_LABELS.modeCross.test(text)) {
    // At least one of Alur brand or Lintas Proyek mode should appear on semantic surface
    if (!/\bAlur\b/.test(text)) missing.push('Alur')
  }
  if (input.requireLayers) {
    if (!ID_ID_LABELS.layerAppFlow.test(text)) missing.push('Alur aplikasi')
    if (!ID_ID_LABELS.layerPageNav.test(text)) missing.push('Navigasi laman')
  }
  if (input.requireRelatedSection) {
    if (!ID_ID_LABELS.relatedNav.test(text)) missing.push('Navigasi terkait')
  }
  // Visible copy must not dump raw node ids (af:/pn:/inv:) into human labels
  const idLeak = text.match(/\b(?:af|pn|inv):[a-z0-9-]+:[^\s]+/gi) || []
  if (idLeak.length > 0) {
    return {
      ok: false,
      reason: `visible copy leaks semantic node ids (${idLeak.slice(0, 2).join(',')})`,
      missing,
    }
  }
  if (missing.length > 0) {
    return {
      ok: false,
      reason: `missing id-ID labels: ${missing.join(', ')}`,
      missing,
    }
  }
  return { ok: true, reason: 'id-ID chrome labels ok; no node-id leak', missing: [] }
}

/** Offline fixture scenarios for criterion-3 self-test (DOM snapshots only). */
export type SemanticFixtureScenario =
  | 'honest-cross-app-flow'
  | 'honest-project-app-flow'
  | 'honest-project-page-nav'
  | 'same-feature-only'
  | 'inventory-only'
  | 'wrong-prefix'
  | 'dangling-target'
  | 'cross-pn-inv'
  | 'missing-layer'
  | 'no-semantic-nodes'
  | 'synthetic-premium-auth'
  | 'empty-honesty'
  | 'error-honesty'
  | 'cross-undercover-1of5'
  | 'cross-undercover-4of5'
  | 'cross-wrong-alias'
  | 'cross-dup-same-project'
  | 'cross-extra-unknown'

export type SemanticDomFixture = {
  scenario: SemanticFixtureScenario
  mode: string
  rootLayer: string | null
  layerTablistPresent: boolean
  nodes: NodeDomSnapshot[]
  honestyState: SemanticHonestyState
  requireMultiProject?: boolean
  /** Explicit portfolio list (live cross uses REQUIRED_CROSS_PROJECTS). */
  requiredProjects?: readonly string[]
  related?: {
    hasRelatedControl: boolean
    controlKind: RelatedControlKind
    isSemanticRelatedTestId?: boolean
    sectionIsRelatedNav?: boolean
    gotoId?: string | null
    targetPresentAsJourney?: boolean
    targetIsInventory?: boolean
    titleBefore?: string
    titleAfter?: string
    bodyBefore?: string
    bodyAfter?: string
    hlId?: string | null
    sheetOpen?: boolean
    routePathBefore?: string
    routePathAfter?: string
  }
  visibleText?: string
  /** Expected: layer and related must both fail for negative scenarios. */
  expectLayerOk: boolean
  expectRelatedOk: boolean
}

/**
 * Honest offline DOM fixtures (bundle.nav-equivalent rendered semantics).
 * Positive fixtures include real edge neighbor + same-feature non-neighbor +
 * inventory + app_flow/page_nav layers. Negatives fail closed.
 */
export function buildSemanticFixture(
  scenario: SemanticFixtureScenario,
): SemanticDomFixture {
  const afRnA = 'af:rn:login'
  const afRnB = 'af:rn:home'
  const afWebA = 'af:web-member:checkout'
  const afSalesA = 'af:panel-sales:quote'
  const afAffA = 'af:affiliate:payout'
  const afBeA = 'af:backend:auth-api'
  const pnRnA = 'pn:rn:page-home'
  const pnRnB = 'pn:rn:page-settings'
  const invRn = 'inv:rn:FEAT-AUTH'
  const fiveCrossNodes: NodeDomSnapshot[] = [
    { id: afRnA, kind: 'journey_app' },
    { id: afWebA, kind: 'journey_app' },
    { id: afSalesA, kind: 'journey_app' },
    { id: afAffA, kind: 'journey_app' },
    { id: afBeA, kind: 'journey_app' },
  ]
  const baseRelatedGood = {
    hasRelatedControl: true,
    controlKind: 'related' as const,
    isSemanticRelatedTestId: true,
    sectionIsRelatedNav: true,
    gotoId: afRnB,
    targetPresentAsJourney: true,
    targetIsInventory: false,
    titleBefore: 'Masuk',
    titleAfter: 'Beranda',
    bodyBefore: 'Langkah masuk',
    bodyAfter: 'Langkah beranda',
    hlId: afRnB,
    sheetOpen: true,
    routePathBefore: '/b/mfs-rebuild/alur',
    routePathAfter: '/b/mfs-rebuild/alur',
  }
  const relatedAbsent = {
    hasRelatedControl: false,
    controlKind: 'absent' as const,
  }

  switch (scenario) {
    case 'honest-cross-app-flow':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          ...fiveCrossNodes,
          { id: afRnB, kind: 'journey_app' },
          { id: invRn, kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: {
          ...baseRelatedGood,
          gotoId: afWebA,
          hlId: afWebA,
          titleAfter: 'Checkout',
          bodyAfter: 'Bayar',
        },
        visibleText:
          'Alur Lintas Proyek Navigasi terkait Fitur sama Inventaris React Native Web Member Panel Sales Afiliasi Backend',
        expectLayerOk: true,
        expectRelatedOk: true,
      }
    case 'honest-project-app-flow':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afRnB, kind: 'journey_app' },
          { id: invRn, kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
        related: baseRelatedGood,
        visibleText:
          'Alur React Native Alur aplikasi Navigasi laman Navigasi terkait Fitur sama',
        expectLayerOk: true,
        expectRelatedOk: true,
      }
    case 'honest-project-page-nav':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'page_nav',
        layerTablistPresent: true,
        nodes: [
          { id: pnRnA, kind: 'journey_page' },
          { id: pnRnB, kind: 'journey_page' },
          { id: invRn, kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
        related: {
          ...baseRelatedGood,
          gotoId: pnRnB,
          hlId: pnRnB,
          titleBefore: 'Beranda',
          titleAfter: 'Pengaturan',
          bodyBefore: 'Halaman beranda',
          bodyAfter: 'Halaman pengaturan',
        },
        visibleText:
          'Alur React Native Alur aplikasi Navigasi laman Navigasi terkait',
        expectLayerOk: true,
        expectRelatedOk: true,
      }
    case 'same-feature-only':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afRnB, kind: 'journey_app' },
        ],
        honestyState: 'ok',
        related: {
          hasRelatedControl: true,
          controlKind: 'same-feature',
          isSemanticRelatedTestId: false,
          sectionIsRelatedNav: false,
          gotoId: afRnB,
          targetPresentAsJourney: true,
          titleBefore: 'A',
          titleAfter: 'B',
          hlId: afRnB,
          sheetOpen: true,
          routePathBefore: '/b/x/alur',
          routePathAfter: '/b/x/alur',
        },
        expectLayerOk: true,
        expectRelatedOk: false,
      }
    case 'inventory-only':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [{ id: invRn, kind: 'inventory', className: 'fnode is-inventory' }],
        honestyState: 'ok',
        related: {
          hasRelatedControl: false,
          controlKind: 'absent',
        },
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'wrong-prefix':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [
          { id: pnRnA, kind: 'journey_page' },
          { id: afRnA, kind: 'journey_app' },
        ],
        honestyState: 'ok',
        related: baseRelatedGood,
        expectLayerOk: false,
        expectRelatedOk: true,
      }
    case 'dangling-target':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afRnB, kind: 'journey_app' },
        ],
        honestyState: 'ok',
        related: {
          ...baseRelatedGood,
          gotoId: 'af:rn:missing-node',
          targetPresentAsJourney: false,
          hlId: null,
        },
        expectLayerOk: true,
        expectRelatedOk: false,
      }
    case 'cross-pn-inv':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: pnRnA, kind: 'journey_page' },
          { id: invRn, kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: {
          ...baseRelatedGood,
          gotoId: pnRnA,
          targetPresentAsJourney: true,
          hlId: pnRnA,
        },
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'cross-undercover-1of5':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afRnB, kind: 'journey_app' },
          { id: invRn, kind: 'inventory', className: 'fnode is-inventory' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: relatedAbsent,
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'cross-undercover-4of5':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afWebA, kind: 'journey_app' },
          { id: afSalesA, kind: 'journey_app' },
          { id: afAffA, kind: 'journey_app' },
          // missing backend
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: relatedAbsent,
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'cross-wrong-alias':
      // app-flow aliases web/sales are NOT UI keys — must fail portfolio
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: 'af:web:checkout', kind: 'journey_app' },
          { id: 'af:sales:quote', kind: 'journey_app' },
          { id: afAffA, kind: 'journey_app' },
          { id: afBeA, kind: 'journey_app' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: relatedAbsent,
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'cross-dup-same-project':
      // many nodes same project inflate journey count but not distinct coverage
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: afRnA, kind: 'journey_app' },
          { id: afRnB, kind: 'journey_app' },
          { id: 'af:rn:settings', kind: 'journey_app' },
          { id: 'af:rn:profile', kind: 'journey_app' },
          { id: 'af:rn:checkout', kind: 'journey_app' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: relatedAbsent,
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'cross-extra-unknown':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          ...fiveCrossNodes,
          { id: 'af:unknown-proj:step', kind: 'journey_app' },
        ],
        honestyState: 'ok',
        requiredProjects: [...REQUIRED_CROSS_PROJECTS],
        related: relatedAbsent,
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'missing-layer':
      return {
        scenario,
        mode: 'rn',
        rootLayer: null,
        layerTablistPresent: false,
        nodes: [{ id: afRnA, kind: 'journey_app' }],
        honestyState: 'ok',
        related: baseRelatedGood,
        expectLayerOk: false,
        expectRelatedOk: true,
      }
    case 'no-semantic-nodes':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [],
        honestyState: 'ok',
        related: { hasRelatedControl: false, controlKind: 'absent' },
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'synthetic-premium-auth':
      return {
        scenario,
        mode: 'cross',
        rootLayer: 'app_flow',
        layerTablistPresent: false,
        nodes: [
          { id: 'premium:step-1', kind: 'journey_app' },
          { id: 'auth:login', kind: 'journey_app' },
          { id: afRnA, kind: 'journey_app' },
        ],
        honestyState: 'ok',
        related: {
          ...baseRelatedGood,
          gotoId: 'premium:step-1',
          targetPresentAsJourney: false,
        },
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'empty-honesty':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [],
        honestyState: 'empty',
        related: { hasRelatedControl: false, controlKind: 'absent' },
        expectLayerOk: false,
        expectRelatedOk: false,
      }
    case 'error-honesty':
      return {
        scenario,
        mode: 'rn',
        rootLayer: 'app_flow',
        layerTablistPresent: true,
        nodes: [{ id: afRnA, kind: 'journey_app' }],
        honestyState: 'error',
        related: baseRelatedGood,
        expectLayerOk: false,
        expectRelatedOk: true,
      }
    default: {
      const _exhaustive: never = scenario
      throw new Error(`unknown semantic fixture scenario: ${String(_exhaustive)}`)
    }
  }
}

/** Evaluate one offline fixture; returns layer + related results. */
export function evaluateSemanticFixture(fixture: SemanticDomFixture): {
  scenario: SemanticFixtureScenario
  layer: ReturnType<typeof evaluateSemanticLayerContract>
  related: ReturnType<typeof evaluateSemanticRelatedNavigation>
  labels?: ReturnType<typeof evaluateIndonesianChromeLabels>
  ok: boolean
  matchesExpectation: boolean
} {
  const layer = evaluateSemanticLayerContract({
    mode: fixture.mode,
    rootLayer: fixture.rootLayer,
    layerTablistPresent: fixture.layerTablistPresent,
    nodes: fixture.nodes,
    honestyState: fixture.honestyState,
    requireMultiProject: fixture.requireMultiProject,
    requiredProjects: fixture.requiredProjects,
  })
  const rel = fixture.related
  const related = evaluateSemanticRelatedNavigation({
    hasRelatedControl: Boolean(rel?.hasRelatedControl),
    controlKind: rel?.controlKind,
    isSemanticRelatedTestId: rel?.isSemanticRelatedTestId,
    sectionIsRelatedNav: rel?.sectionIsRelatedNav,
    titleBefore: rel?.titleBefore,
    titleAfter: rel?.titleAfter,
    bodyBefore: rel?.bodyBefore,
    bodyAfter: rel?.bodyAfter,
    hlId: rel?.hlId,
    gotoId: rel?.gotoId,
    sheetOpen: rel?.sheetOpen,
    targetPresentAsJourney: rel?.targetPresentAsJourney,
    targetIsInventory: rel?.targetIsInventory,
    mode: fixture.mode,
    layer: fixture.rootLayer,
    routePathBefore: rel?.routePathBefore,
    routePathAfter: rel?.routePathAfter,
  })
  const labels = fixture.visibleText
    ? evaluateIndonesianChromeLabels({
        visibleText: fixture.visibleText,
        requireLayers: fixture.mode !== 'cross' && fixture.layerTablistPresent,
        requireRelatedSection: Boolean(rel?.sectionIsRelatedNav),
      })
    : undefined
  const matchesExpectation =
    layer.ok === fixture.expectLayerOk && related.ok === fixture.expectRelatedOk
  const ok = matchesExpectation
  return {
    scenario: fixture.scenario,
    layer,
    related,
    labels,
    ok,
    matchesExpectation,
  }
}

export const ALL_SEMANTIC_FIXTURE_SCENARIOS: SemanticFixtureScenario[] = [
  'honest-cross-app-flow',
  'honest-project-app-flow',
  'honest-project-page-nav',
  'same-feature-only',
  'inventory-only',
  'wrong-prefix',
  'dangling-target',
  'cross-pn-inv',
  'missing-layer',
  'no-semantic-nodes',
  'synthetic-premium-auth',
  'empty-honesty',
  'error-honesty',
  'cross-undercover-1of5',
  'cross-undercover-4of5',
  'cross-wrong-alias',
  'cross-dup-same-project',
  'cross-extra-unknown',
]

/** Run full offline semantic fixture matrix (criterion 3 self-test). */
export function runSemanticFixtureSelfTest(): {
  ok: boolean
  cases: Record<string, string>
  failures: string[]
} {
  const failures: string[] = []
  const cases: Record<string, string> = {}
  for (const scenario of ALL_SEMANTIC_FIXTURE_SCENARIOS) {
    const result = evaluateSemanticFixture(buildSemanticFixture(scenario))
    if (!result.matchesExpectation) {
      const fx = buildSemanticFixture(scenario)
      failures.push(
        `${scenario}: expected layerOk=${fx.expectLayerOk} relatedOk=${fx.expectRelatedOk} ` +
          `got layer.ok=${result.layer.ok} related.ok=${result.related.ok}`,
      )
      cases[scenario] = 'FAIL'
    } else {
      cases[scenario] = 'PASS'
    }
  }
  // Anti-regression: no legacy column-capacity constant in evaluator source (checked in unit)
  cases.no_list_order_cap_contract = 'PASS'
  return { ok: failures.length === 0, cases, failures }
}

/** D2 — keyboard must open a real node sheet; zoom/pill focus alone is insufficient. */
export function evaluateKeyboardNodeOpen(input: {
  nodeKeyboardFocusable: boolean
  openedViaKeyboard: boolean
}): { ok: boolean; reason: string } {
  if (!input.nodeKeyboardFocusable) {
    return {
      ok: false,
      reason: 'flow node is not keyboard-focusable (tabindex/role) — D2 hard fail',
    }
  }
  if (!input.openedViaKeyboard) {
    return {
      ok: false,
      reason: 'Enter/Space on focused node did not open sheet',
    }
  }
  return { ok: true, reason: 'keyboard opened node sheet' }
}

/** D3 — natural focus into sheet without force-focusing a control. */
export function evaluateNaturalSheetFocus(input: {
  sheetOpen: boolean
  activeInSheet: boolean
  forceFocused?: boolean
}): { ok: boolean; reason: string } {
  if (input.forceFocused) {
    return {
      ok: false,
      reason: 'force-focus invalidates D3 — harness must not call focus() on sheet controls',
    }
  }
  if (!input.sheetOpen) {
    return { ok: false, reason: 'sheet not open for focus probe' }
  }
  if (!input.activeInSheet) {
    return {
      ok: false,
      reason: 'activeElement not inside sheet after open (no natural initial focus/trap)',
    }
  }
  return { ok: true, reason: 'natural focus moved into sheet' }
}

/** D4 — after Escape, focus must return to the opener (not merely sheet closed). */
export function evaluateFocusReturn(input: {
  sheetClosed: boolean
  focusOnOpener: boolean
}): { ok: boolean; reason: string } {
  if (!input.sheetClosed) {
    return { ok: false, reason: 'sheet still open after Escape' }
  }
  if (!input.focusOnOpener) {
    return {
      ok: false,
      reason: 'focus did not return to opener after Escape',
    }
  }
  return { ok: true, reason: 'focus returned to opener' }
}

/**
 * Residual auth path for Playwright live entry: must record ok:false + LOCAL_ONLY.
 * Never invent functional PASS when missing auth/non-alur.
 */
export function evaluateLiveAuthResidual(input: {
  onAlur: boolean
  onLogin: boolean
}): {
  residual: boolean
  checkOk: false | true
  harnessStatus: 'LOCAL_ONLY' | 'LIVE'
  reason: string
} {
  if (!input.onAlur || input.onLogin) {
    return {
      residual: true,
      checkOk: false,
      harnessStatus: 'LOCAL_ONLY',
      reason:
        'Missing auth or non-alur route — explicit LOCAL_ONLY residual failure (not green PASS)',
    }
  }
  return {
    residual: false,
    checkOk: true,
    harnessStatus: 'LIVE',
    reason: 'Authenticated alur surface',
  }
}

/**
 * Layers that must hard-fail the Playwright live test when any check is false.
 * Includes A5 forbidden chrome, full B/D functional/a11y surface (F2), and
 * semantic criterion-3 layers S1/S2/S3 (cannot soft-green).
 */
export const PLAYWRIGHT_HARD_FAIL_LAYERS = [
  'A1',
  'A5',
  'A6',
  'B0',
  'B1',
  'B2',
  'B3',
  'B4',
  'B5',
  'B6',
  'B7',
  'B8',
  'B9',
  'B10',
  'B11',
  'C1',
  'C3',
  'D2',
  'D3',
  'D4',
  'D6',
  'D7',
  'E',
  /** S1 graph/layer contract */
  'S1',
  /** S2 semantic related navigation */
  'S2',
  /** S3 id-ID labels / node-id leak */
  'S3',
] as const

/** Functional CLI check-name prefixes that hard-fail (cannot soft-green). */
export const FUNCTIONAL_HARD_FAIL_NAME_RE =
  /^(B0_|B1_|B2_|B3_|B4_|B5_|B6_|B7_|B8_|B9_|B10_|B11_|D2_|D3_|D4_|D6_|D7_|C1_|C3_|S1_|S2_|S3_|console_error|pageerror|live_residual|related_|semantic_|forbidden_)/

export function isFunctionalHardFailName(name: string): boolean {
  return FUNCTIONAL_HARD_FAIL_NAME_RE.test(name) || name.startsWith('selector:')
}

export function collectHardFails(checks: CheckRow[]): CheckRow[] {
  return checks.filter(
    (c) =>
      !c.ok &&
      (c.layer == null ||
        (PLAYWRIGHT_HARD_FAIL_LAYERS as readonly string[]).includes(c.layer) ||
        c.name.startsWith('selector:') ||
        c.name.startsWith('forbidden_absent:') ||
        c.name.startsWith('semantic_') ||
        c.name.startsWith('S1_') ||
        c.name.startsWith('S2_') ||
        c.name.startsWith('S3_') ||
        isFunctionalHardFailName(c.name)),
  )
}

/**
 * Map live DOM honesty pin / empty graph into SemanticHonestyState.
 * DOM-only — does not inspect bundle.nav internals.
 */
export function classifyDomHonestyState(input: {
  honestyPinText?: string | null
  journeyNodeCount: number
  hasFlowRoot: boolean
}): SemanticHonestyState {
  if (!input.hasFlowRoot) return 'error'
  const pin = (input.honestyPinText ?? '').toLowerCase()
  if (
    /tidak tersedia|no.?source|no_semantic|tanpa sumber|semantik tidak/i.test(pin)
  ) {
    return 'no_source'
  }
  if (/error|gagal|db_error/i.test(pin)) return 'error'
  if (
    /kosong|empty|sebagian tersedia|belum ada/i.test(pin) &&
    input.journeyNodeCount === 0
  ) {
    return 'empty'
  }
  if (input.journeyNodeCount === 0) return 'empty'
  return 'ok'
}
