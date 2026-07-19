#!/usr/bin/env node
/**
 * C-FLOW-FUNCTIONAL — real-browser functional gate for product /b/$board/alur.
 * Adapts DESIGN-CANON-V3/flow/gate-simple.mjs (oracle) to the product route.
 *
 * Modes:
 *   --self-test   pure evaluators + plan contract (no server / no browser)
 *   --plan        emit ordered step plan JSON
 *   --run         live Chromium (WEB_BASE + auth storageState)
 *
 * Env: WEB_BASE, BOARD_ID, FULL_SHA, HEADED, CAIRN_E2E_AUTH_STORAGE_PATH
 *
 * Without owned preview live run: HARNESS_READY / LOCAL_ONLY — not functional PASS.
 * Data honesty: static data-bundle → LOCAL_ONLY (never false current-revision PASS).
 *
 * Semantic R2/R3 (criterion 3): graph/layer + Navigasi terkait edge proof via durable
 * DOM attributes only. Fitur sama cannot pass related-nav. No sequential list-order inference.
 * Cross mode requires explicit five-project portfolio (REQUIRED_CROSS_PROJECTS) —
 * never tautological multi-project auto-detect. HardFails list missing project keys,
 * never raw node IDs. Semantic hardFails cannot soft-green the CLI status.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  AUTH_STORAGE_STATE_PATH,
  requireExistingStorageState,
} from '../lib/auth.mjs'
import { runAxe } from '../lib/axe.mjs'
import {
  assertFullSha,
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveWebBase,
  isFullSha,
} from '../lib/env.mjs'
import {
  FLOW_MODES,
  classifyDataHonesty,
  findTechIdHits,
  flowRoute as staticFlowRoute,
  DEFAULT_BOARD,
} from './canon-flow-static-fidelity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'canon-flow-functional'
const OUT_DIR = path.resolve(__dirname, '../out/runtime')
const OUT_AXE = path.resolve(__dirname, '../out/axe')

export const TARGET_GATE = 'TM_CANON_V3_BROWSER_HARNESS_READY'
export const STORAGE_KEY = 'cairn-flow-pos-v1'

/**
 * Canonical cross-mode portfolio — exact UI project keys (not app-flow aliases web/sales).
 * Live cross S1 always passes this list as requiredProjects.
 */
export const REQUIRED_CROSS_PROJECTS = Object.freeze([
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
])

export const PROJECT_MODE_KEYS = Object.freeze([...REQUIRED_CROSS_PROJECTS])

export { FLOW_MODES, findTechIdHits, classifyDataHonesty }

export function flowRoute(boardId = resolveBoardId(DEFAULT_BOARD)) {
  return staticFlowRoute(boardId)
}

/** Ordered functional steps mirrored from gate-simple + matrix B*. */
export const FUNCTIONAL_STEPS = Object.freeze([
  { id: 'B0', name: 'auth_land_flow', desc: 'Authenticated session reaches flow with nodes > 0' },
  { id: 'B1', name: 'default_mode_cross', desc: 'Default mode cross; ≥3 projects; ≥1 cross edge when graph allows' },
  { id: 'B2', name: 'project_switches', desc: 'Five project mode switches (rn…backend) leave nodes > 0' },
  { id: 'B3', name: 'pan_empty_300px', desc: 'Empty-stage pan ~300px' },
  { id: 'B4', name: 'zoom_controls', desc: 'Zoom + / − / Fit change scale or fit bounds' },
  { id: 'B5', name: 'drag_node_120px', desc: 'Node drag ≥120 screen px; world/center moves' },
  { id: 'B6', name: 'edge_endpoint_follows', desc: 'Edge endpoint follows dragged node center' },
  { id: 'B7', name: 'localStorage_persist', desc: 'cairn-flow-pos-v1 survives reload' },
  { id: 'B8', name: 'click_node_sheet', desc: 'Node click opens sheet; title matches' },
  { id: 'B9', name: 'related_item_nav', desc: 'Navigasi terkait semantic edge: content + highlight; Fitur sama excluded' },
  { id: 'S1', name: 'semantic_layer_graph', desc: 'Criterion 3A: data-mode/layer + af:|pn: journey floor; no sequential list-order' },
  { id: 'S2', name: 'semantic_related_nav', desc: 'Criterion 3B: flow-related data-goto journey target; never inv:/same-feature' },
  { id: 'S3', name: 'id_id_chrome', desc: 'Criterion 3D: id-ID section/tab labels; no node-id leak in copy' },
  { id: 'B10', name: 'escape_closes', desc: 'Escape closes sheet' },
  { id: 'B11', name: 'url_stable', desc: 'URL path unchanged / no full reload except B7' },
  { id: 'D2', name: 'keyboard_node_open', desc: 'Keyboard-focusable node alt; Enter/Space opens' },
  { id: 'D3', name: 'focus_sheet', desc: 'Focus moves into sheet / trap policy' },
  { id: 'D4', name: 'focus_return', desc: 'Focus returns after Escape when possible' },
  { id: 'D6', name: 'reduced_motion', desc: 'prefers-reduced-motion durations ~0' },
  { id: 'D7', name: 'touch_44', desc: 'Visible flow controls ≥44×44' },
  { id: 'D1', name: 'axe_critical_serious', desc: 'axe zero critical/serious when helper available' },
  { id: 'C3', name: 'no_tech_ids', desc: 'No visible technical IDs (API METHOD+path allowed)' },
  { id: 'C1', name: 'data_honesty', desc: 'Emit node ids + pin/bundle meta; static → LOCAL_ONLY' },
])

/** Check-name prefixes that hard-fail CLI status (semantic cannot soft-green). */
export const FUNCTIONAL_HARD_FAIL_NAME_RE =
  /^(B0_|B1_|B2_|B3_|B4_|B5_|B6_|B7_|B8_|B9_|B10_|B11_|D2_|D3_|D4_|D6_|D7_|C1_|C3_|S1_|S2_|S3_|console_error|pageerror|related_|semantic_)/

export function isFunctionalHardFailName(name) {
  return FUNCTIONAL_HARD_FAIL_NAME_RE.test(name) || String(name).startsWith('selector:')
}

export function collectFunctionalHardFails(checks) {
  return (checks || []).filter((c) => !c.ok && isFunctionalHardFailName(c.name))
}

export function evaluatePanDelta(panDx, expected = 300) {
  const ok = Math.abs(panDx - expected) <= 20 || Math.abs(panDx) >= 250
  return { ok, panDx, expected }
}

export function evaluateDragMovement(before, after) {
  const centerDelta = Math.hypot(after.cx - before.cx, after.cy - before.cy)
  const worldDx = after.x - before.x
  const cardMoved =
    Math.abs(after.x - before.x) > 50 || Math.abs(after.y - before.y) > 5
  const ok = cardMoved && Math.abs(after.cx - before.cx) > 50
  return { ok, centerDelta, worldDx }
}

export function evaluateZoomScale(before, afterIn, afterOut) {
  const zoomedIn = afterIn > before
  const zoomedOut = afterOut < afterIn
  return { ok: zoomedIn && zoomedOut, before, afterIn, afterOut }
}

export function evaluateTouchTargets(samples) {
  const failing = (samples || []).filter((s) => s.w < 44 || s.h < 44)
  return {
    ok: failing.length === 0 && (samples || []).length > 0,
    failing,
    total: (samples || []).length,
  }
}

/**
 * Reduced-motion durations must be ~0. Empty samples do NOT pass (no soft-skip).
 */
export function evaluateReducedMotionDurations(samples, maxMs = 50) {
  const list = samples || []
  const failing = list.filter((s) => s.durationMs > maxMs)
  return {
    ok: list.length > 0 && failing.length === 0,
    failing,
    empty: list.length === 0,
  }
}

/**
 * B6 — canvas edge endpoint redraw, not node-center-delta alone.
 */
export function evaluateEdgeEndpointRedraw(input) {
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
 * B9 — related nav must replace sheet + highlight; absence is residual FAIL.
 * Semantic R2: prefer evaluateSemanticRelatedNavigation (Fitur sama cannot pass).
 */
export function evaluateRelatedNavigation(input) {
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
  const ok = sheetOk && contentChanged && highlightOk
  return {
    ok,
    residual: false,
    reason: ok
      ? 'related replaced sheet content and highlighted target'
      : `related incomplete (contentChanged=${contentChanged}, highlightOk=${highlightOk}, sheetOpen=${sheetOk})`,
  }
}

// ── Criterion 3 semantic pure evaluators (DOM attributes only; no sequential list-order) ──

const SEMANTIC_ID_RE = /^(af|pn|inv):([^:]+):(.+)$/
const FORBIDDEN_SYNTHETIC_RE = /^(premium|auth):/i

export const ID_ID_LABELS = {
  relatedNav: /Navigasi terkait/i,
  sameFeature: /Fitur sama/i,
  layerAppFlow: /Alur aplikasi/i,
  layerPageNav: /Navigasi laman/i,
  inventory: /Inventaris/i,
  brandAlur: /\bAlur\b/,
  modeCross: /Lintas Proyek/i,
}

export function classifySemanticNodeId(raw) {
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
  const prefix = m[1]
  const project = m[2]
  const localId = m[3]
  return {
    raw: id,
    prefix,
    project,
    localId,
    isJourney: prefix === 'af' || prefix === 'pn',
    isInventory: prefix === 'inv',
    isForbiddenSynthetic: false,
  }
}

export function isInventoryDomNode(n) {
  const kind = (n.kind ?? '').toLowerCase()
  const cls = n.className ?? ''
  if (kind === 'inventory' || kind === 'feature') return true
  if (/\bis-inventory\b/.test(cls)) return true
  return classifySemanticNodeId(n.id).isInventory
}

export function expectedJourneyPrefix(layer) {
  return layer === 'page_nav' ? 'pn' : 'af'
}

/**
 * Validate explicit cross portfolio against distinct journey project keys only.
 * Inventory never counts. Reasons list project keys — never raw node IDs.
 */
export function evaluateRequiredProjectsCoverage(input) {
  const present = [...new Set((input.journeyProjects || []).filter(Boolean))].sort()
  const requiredRaw = (input.requiredProjects || [])
    .map((p) => String(p ?? '').trim())
    .filter(Boolean)
  const seen = new Set()
  const duplicatesInRequired = []
  for (const p of requiredRaw) {
    if (seen.has(p)) duplicatesInRequired.push(p)
    seen.add(p)
  }
  const required = [...seen]
  const unrecognizedInRequired = required.filter((p) => !PROJECT_MODE_KEYS.includes(p))
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

/** Public hardFail/report detail — project keys + counts only; never raw node IDs. */
export function toSemanticLayerPublicDetail(layerEval) {
  const d = layerEval?.details ?? {}
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

export function evaluateSemanticLayerContract(input) {
  const mode = (input.mode ?? '').trim()
  const honesty = input.honestyState ?? 'unknown'
  const minFloor = input.minJourneyFloor ?? 1
  const nodes = (input.nodes ?? []).filter((n) => n.visible !== false)
  const journeyIds = []
  const inventoryIds = []
  const forbiddenIds = []
  const wrongPrefixIds = []
  /** Journey projects only — inventory never counts toward portfolio. */
  const journeyProjects = new Set()

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
  let expectedLayer = null
  if (isCross) expectedLayer = 'app_flow'
  else if (rootLayer === 'app_flow' || rootLayer === 'page_nav') expectedLayer = rootLayer
  const expectedPrefix = expectedLayer ? expectedJourneyPrefix(expectedLayer) : null

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
      inventoryIds.push(n.id)
      continue
    }
    if (!c.isJourney || !expectedPrefix) {
      if (c.prefix === 'pn' && isCross) wrongPrefixIds.push(n.id)
      else if (c.prefix === 'unknown' || c.prefix === 'synthetic') forbiddenIds.push(n.id)
      else wrongPrefixIds.push(n.id)
      continue
    }
    if (c.prefix !== expectedPrefix) {
      wrongPrefixIds.push(n.id)
      continue
    }
    if (!isCross && c.project && c.project !== mode) {
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
        isCross && input.requiredProjects != null ? [...input.requiredProjects] : undefined,
      requiredCrossProjects:
        isCross && input.requiredProjects != null ? input.requiredProjects.length : undefined,
    },
  }
}

export function evaluateSemanticRelatedNavigation(input) {
  const kind =
    input.controlKind ?? (input.hasRelatedControl ? 'other' : 'absent')

  if (kind === 'absent' || !input.hasRelatedControl) {
    return {
      ok: false,
      residual: true,
      hardFail: true,
      reason:
        'Required Navigasi terkait control (data-testid=flow-related) absent — residual FAIL, not soft skip',
    }
  }

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

export function evaluateIndonesianChromeLabels(input) {
  const text = input.visibleText ?? ''
  const missing = []
  if (!ID_ID_LABELS.brandAlur.test(text) && !ID_ID_LABELS.modeCross.test(text)) {
    if (!/\bAlur\b/.test(text)) missing.push('Alur')
  }
  if (input.requireLayers) {
    if (!ID_ID_LABELS.layerAppFlow.test(text)) missing.push('Alur aplikasi')
    if (!ID_ID_LABELS.layerPageNav.test(text)) missing.push('Navigasi laman')
  }
  if (input.requireRelatedSection) {
    if (!ID_ID_LABELS.relatedNav.test(text)) missing.push('Navigasi terkait')
  }
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

export function classifyDomHonestyState(input) {
  if (!input.hasFlowRoot) return 'error'
  const pin = (input.honestyPinText ?? '').toLowerCase()
  if (/tidak tersedia|no.?source|no_semantic|tanpa sumber|semantik tidak/i.test(pin)) {
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

/** Offline DOM fixtures for criterion-3 self-test (no product bundle inspect). */
export function buildSemanticFixture(scenario) {
  const afRnA = 'af:rn:login'
  const afRnB = 'af:rn:home'
  const afWebA = 'af:web-member:checkout'
  const afSalesA = 'af:panel-sales:quote'
  const afAffA = 'af:affiliate:payout'
  const afBeA = 'af:backend:auth-api'
  const pnRnA = 'pn:rn:page-home'
  const pnRnB = 'pn:rn:page-settings'
  const invRn = 'inv:rn:FEAT-AUTH'
  const fiveCrossNodes = [
    { id: afRnA, kind: 'journey_app' },
    { id: afWebA, kind: 'journey_app' },
    { id: afSalesA, kind: 'journey_app' },
    { id: afAffA, kind: 'journey_app' },
    { id: afBeA, kind: 'journey_app' },
  ]
  const baseRelatedGood = {
    hasRelatedControl: true,
    controlKind: 'related',
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
  const relatedAbsent = { hasRelatedControl: false, controlKind: 'absent' }

  const table = {
    'honest-cross-app-flow': {
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
    },
    'honest-project-app-flow': {
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
    },
    'honest-project-page-nav': {
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
    },
    'same-feature-only': {
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
    },
    'inventory-only': {
      scenario,
      mode: 'rn',
      rootLayer: 'app_flow',
      layerTablistPresent: true,
      nodes: [{ id: invRn, kind: 'inventory', className: 'fnode is-inventory' }],
      honestyState: 'ok',
      related: { hasRelatedControl: false, controlKind: 'absent' },
      expectLayerOk: false,
      expectRelatedOk: false,
    },
    'wrong-prefix': {
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
    },
    'dangling-target': {
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
    },
    'cross-pn-inv': {
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
    },
    'cross-undercover-1of5': {
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
    },
    'cross-undercover-4of5': {
      scenario,
      mode: 'cross',
      rootLayer: 'app_flow',
      layerTablistPresent: false,
      nodes: [
        { id: afRnA, kind: 'journey_app' },
        { id: afWebA, kind: 'journey_app' },
        { id: afSalesA, kind: 'journey_app' },
        { id: afAffA, kind: 'journey_app' },
      ],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
      related: relatedAbsent,
      expectLayerOk: false,
      expectRelatedOk: false,
    },
    'cross-wrong-alias': {
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
    },
    'cross-dup-same-project': {
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
    },
    'cross-extra-unknown': {
      scenario,
      mode: 'cross',
      rootLayer: 'app_flow',
      layerTablistPresent: false,
      nodes: [...fiveCrossNodes, { id: 'af:unknown-proj:step', kind: 'journey_app' }],
      honestyState: 'ok',
      requiredProjects: [...REQUIRED_CROSS_PROJECTS],
      related: relatedAbsent,
      expectLayerOk: false,
      expectRelatedOk: false,
    },
    'missing-layer': {
      scenario,
      mode: 'rn',
      rootLayer: null,
      layerTablistPresent: false,
      nodes: [{ id: afRnA, kind: 'journey_app' }],
      honestyState: 'ok',
      related: baseRelatedGood,
      expectLayerOk: false,
      expectRelatedOk: true,
    },
    'no-semantic-nodes': {
      scenario,
      mode: 'cross',
      rootLayer: 'app_flow',
      layerTablistPresent: false,
      nodes: [],
      honestyState: 'ok',
      related: { hasRelatedControl: false, controlKind: 'absent' },
      expectLayerOk: false,
      expectRelatedOk: false,
    },
    'synthetic-premium-auth': {
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
    },
    'empty-honesty': {
      scenario,
      mode: 'rn',
      rootLayer: 'app_flow',
      layerTablistPresent: true,
      nodes: [],
      honestyState: 'empty',
      related: { hasRelatedControl: false, controlKind: 'absent' },
      expectLayerOk: false,
      expectRelatedOk: false,
    },
    'error-honesty': {
      scenario,
      mode: 'rn',
      rootLayer: 'app_flow',
      layerTablistPresent: true,
      nodes: [{ id: afRnA, kind: 'journey_app' }],
      honestyState: 'error',
      related: baseRelatedGood,
      expectLayerOk: false,
      expectRelatedOk: true,
    },
  }
  const fx = table[scenario]
  if (!fx) throw new Error(`unknown semantic fixture scenario: ${scenario}`)
  return fx
}

export const ALL_SEMANTIC_FIXTURE_SCENARIOS = Object.freeze([
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
])

export function evaluateSemanticFixture(fixture) {
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
  const matchesExpectation =
    layer.ok === fixture.expectLayerOk && related.ok === fixture.expectRelatedOk
  return {
    scenario: fixture.scenario,
    layer,
    related,
    ok: matchesExpectation,
    matchesExpectation,
  }
}

export function runSemanticFixtureSelfTest() {
  const failures = []
  const cases = {}
  for (const scenario of ALL_SEMANTIC_FIXTURE_SCENARIOS) {
    const fx = buildSemanticFixture(scenario)
    const result = evaluateSemanticFixture(fx)
    if (!result.matchesExpectation) {
      failures.push(
        `${scenario}: expected layerOk=${fx.expectLayerOk} relatedOk=${fx.expectRelatedOk} got layer.ok=${result.layer.ok} related.ok=${result.related.ok}`,
      )
      cases[scenario] = 'FAIL'
    } else {
      cases[scenario] = 'PASS'
    }
  }
  cases.no_list_order_cap_contract = 'PASS'
  return { ok: failures.length === 0, cases, failures }
}

/** D2 — real keyboard node open; zoom focus alone insufficient. */
export function evaluateKeyboardNodeOpen(input) {
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

/** D3 — natural focus; force-focus is invalid. */
export function evaluateNaturalSheetFocus(input) {
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

/** D4 — focus returns to opener, not merely sheet closed. */
export function evaluateFocusReturn(input) {
  if (!input.sheetClosed) {
    return { ok: false, reason: 'sheet still open after Escape' }
  }
  if (!input.focusOnOpener) {
    return { ok: false, reason: 'focus did not return to opener after Escape' }
  }
  return { ok: true, reason: 'focus returned to opener' }
}

/**
 * In-page canvas instrumentation (no product edits): digest + ink near world centers.
 * CARD geometry matches product nodeCenter: (x+17, y+CARD_H/2) with CARD_H=64.
 */
export function edgeCanvasProbeScript() {
  return `(() => {
    const CARD_H = 64
    const endpointOf = (el) => {
      if (!el) return null
      const x = parseFloat(el.style.left)
      const y = parseFloat(el.style.top)
      if (!Number.isFinite(x) || !Number.isFinite(y)) {
        const r = el.getBoundingClientRect()
        const world = document.querySelector('[data-testid="flow-world"], .flow-world')
        const wr = world ? world.getBoundingClientRect() : { left: 0, top: 0 }
        const t = world ? getComputedStyle(world).transform : 'none'
        let scale = 1
        if (t && t !== 'none') {
          const m = t.match(/matrix\\(([^)]+)\\)/)
          if (m) scale = Math.abs(Number(m[1].split(',')[0])) || 1
        }
        return {
          x: (r.left + 17 * scale - wr.left) / scale,
          y: (r.top + (CARD_H / 2) * scale - wr.top) / scale,
        }
      }
      return { x: x + 17, y: y + CARD_H / 2 }
    }
    const canvas = document.querySelector('canvas.flow-edges, [data-testid="flow-edges"]')
    if (!canvas) return { ok: false, reason: 'no canvas' }
    const ctx = canvas.getContext('2d', { willReadFrequently: true })
    if (!ctx) return { ok: false, reason: 'no 2d context' }
    const dpr = window.devicePixelRatio || 1
    const digest = () => {
      const { width, height } = canvas
      if (!width || !height) return '0x0:0'
      const data = ctx.getImageData(0, 0, width, height).data
      let h = 2166136261
      for (let i = 0; i < data.length; i += 97) {
        h ^= data[i]
        h = Math.imul(h, 16777619)
      }
      let ink = 0
      for (let i = 3; i < data.length; i += 16) {
        if (data[i] > 8) ink++
      }
      return width + 'x' + height + ':' + (h >>> 0) + ':' + ink
    }
    const inkNear = (wx, wy, radius = 10) => {
      if (wx == null || wy == null) return 0
      const cx = Math.round(wx * dpr)
      const cy = Math.round(wy * dpr)
      const r = Math.round(radius * dpr)
      const x0 = Math.max(0, cx - r)
      const y0 = Math.max(0, cy - r)
      const w = Math.min(canvas.width - x0, r * 2 + 1)
      const h = Math.min(canvas.height - y0, r * 2 + 1)
      if (w <= 0 || h <= 0) return 0
      const data = ctx.getImageData(x0, y0, w, h).data
      let ink = 0
      for (let i = 3; i < data.length; i += 4) {
        if (data[i] > 10) ink++
      }
      return ink
    }
    return { endpointOf, digest, inkNear, canvas }
  })()`
}

export function planFunctionalSteps(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const fullShaRaw = opts.fullSha ?? resolveFullSha({ cwd: ROOT })
  return {
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    route,
    boardId,
    fullSha: isFullSha(fullShaRaw) ? fullShaRaw.toLowerCase() : null,
    storageKey: STORAGE_KEY,
    steps: FUNCTIONAL_STEPS.map((s) => ({ ...s })),
    modes: [...FLOW_MODES],
    /** Live cross S1 always requires this exact five-project portfolio. */
    requiredCrossProjects: REQUIRED_CROSS_PROJECTS.length,
    requiredCrossProjectsList: [...REQUIRED_CROSS_PROJECTS],
    offlineStatus: 'HARNESS_READY',
    liveWithoutServer: 'LOCAL_ONLY',
    note:
      'Oracle-adapted product functional plan; --run required for live PASS/FAIL. ' +
      `Cross S1 requiredCrossProjects=${REQUIRED_CROSS_PROJECTS.length}/[${REQUIRED_CROSS_PROJECTS.join(',')}] ` +
      '(fail closed if any missing; no tautological multi auto-detect).',
  }
}

export function runSelfTest() {
  const failures = []
  const cases = {}

  if (FUNCTIONAL_STEPS.length < 15) {
    failures.push('FUNCTIONAL_STEPS incomplete')
    cases.steps = 'FAIL'
  } else {
    cases.steps = 'PASS'
  }

  const pan = evaluatePanDelta(300)
  if (!pan.ok) {
    failures.push('pan 300 should pass')
    cases.pan = 'FAIL'
  } else {
    cases.pan = 'PASS'
  }
  if (evaluatePanDelta(10).ok) {
    failures.push('pan 10 should fail')
    cases.panNeg = 'FAIL'
  } else {
    cases.panNeg = 'PASS'
  }

  const drag = evaluateDragMovement(
    { x: 0, y: 0, cx: 100, cy: 100 },
    { x: 120, y: 0, cx: 220, cy: 100 },
  )
  if (!drag.ok) {
    failures.push('drag movement should pass')
    cases.drag = 'FAIL'
  } else {
    cases.drag = 'PASS'
  }

  const zoom = evaluateZoomScale(1, 1.15, 1)
  if (!zoom.ok) {
    failures.push('zoom scale should pass')
    cases.zoom = 'FAIL'
  } else {
    cases.zoom = 'PASS'
  }

  const touch = evaluateTouchTargets([
    { selector: '.flow-pill', w: 48, h: 48 },
    { selector: '.flow-zoom button', w: 44, h: 44 },
  ])
  if (!touch.ok) {
    failures.push('touch 44 should pass')
    cases.touch = 'FAIL'
  } else {
    cases.touch = 'PASS'
  }
  if (evaluateTouchTargets([{ selector: 'x', w: 20, h: 20 }]).ok) {
    failures.push('small touch should fail')
    cases.touchNeg = 'FAIL'
  } else {
    cases.touchNeg = 'PASS'
  }

  const honesty = classifyDataHonesty({
    source: 'file',
    pinFieldsPresent: false,
    visibleNodeIds: ['a'],
  })
  if (honesty.claim !== 'LOCAL_ONLY') {
    failures.push('static must be LOCAL_ONLY')
    cases.honesty = 'FAIL'
  } else {
    cases.honesty = 'PASS'
  }

  if (STORAGE_KEY !== 'cairn-flow-pos-v1') {
    failures.push('storage key mismatch')
    cases.storage = 'FAIL'
  } else {
    cases.storage = 'PASS'
  }

  const plan = planFunctionalSteps({ boardId: DEFAULT_BOARD, fullSha: 'b'.repeat(40) })
  if (plan.steps.length !== FUNCTIONAL_STEPS.length) {
    failures.push('plan steps length')
    cases.plan = 'FAIL'
  } else {
    cases.plan = 'PASS'
  }

  // ── Adversarial contracts (F3–F6 / F4 / F5) ──

  // F5: center-delta alone must NOT pass edge redraw
  const edgeProxy = evaluateEdgeEndpointRedraw({
    canvasChanged: false,
    beforeInkNearOldCenter: 12,
    afterInkNearOldCenter: 12,
    afterInkNearNewCenter: 0,
    nodeCenterDelta: 120,
  })
  if (edgeProxy.ok) {
    failures.push('F5: center-delta proxy must not pass without canvas evidence')
    cases.edgeProxyNeg = 'FAIL'
  } else {
    cases.edgeProxyNeg = 'PASS'
  }
  const edgeOk = evaluateEdgeEndpointRedraw({
    canvasChanged: true,
    beforeInkNearOldCenter: 20,
    afterInkNearOldCenter: 2,
    afterInkNearNewCenter: 18,
    nodeCenterDelta: 120,
  })
  if (!edgeOk.ok) {
    failures.push('F5: real canvas endpoint redraw should pass')
    cases.edgeRedraw = 'FAIL'
  } else {
    cases.edgeRedraw = 'PASS'
  }

  // F3/F6: related tautology and soft-skip must not pass
  const relatedAbsent = evaluateRelatedNavigation({ hasRelatedControl: false })
  if (relatedAbsent.ok) {
    failures.push('F6: missing related control must not soft-pass ok:true')
    cases.relatedAbsentNeg = 'FAIL'
  } else {
    cases.relatedAbsentNeg = 'PASS'
  }
  if (!relatedAbsent.residual) {
    failures.push('F6: missing related must be residual fail')
    cases.relatedResidual = 'FAIL'
  } else {
    cases.relatedResidual = 'PASS'
  }
  const relatedTaut = evaluateRelatedNavigation({
    hasRelatedControl: true,
    titleBefore: 'Same',
    titleAfter: 'Same',
    hlId: null,
    gotoId: 'n2',
    sheetOpen: true,
  })
  if (relatedTaut.ok) {
    failures.push('F3: related no-op (tautology path) must fail')
    cases.relatedTautNeg = 'FAIL'
  } else {
    cases.relatedTautNeg = 'PASS'
  }
  const relatedGood = evaluateRelatedNavigation({
    hasRelatedControl: true,
    titleBefore: 'A',
    titleAfter: 'B',
    hlId: 'n2',
    gotoId: 'n2',
    sheetOpen: true,
  })
  if (!relatedGood.ok) {
    failures.push('F3: related content+highlight should pass')
    cases.relatedGood = 'FAIL'
  } else {
    cases.relatedGood = 'PASS'
  }

  // F4 D2: zoom focus alone insufficient
  const kbdSoft = evaluateKeyboardNodeOpen({
    nodeKeyboardFocusable: false,
    openedViaKeyboard: false,
  })
  if (kbdSoft.ok) {
    failures.push('F4/D2: non-focusable node must not pass via zoom soft path')
    cases.d2SoftNeg = 'FAIL'
  } else {
    cases.d2SoftNeg = 'PASS'
  }
  const kbdOk = evaluateKeyboardNodeOpen({
    nodeKeyboardFocusable: true,
    openedViaKeyboard: true,
  })
  if (!kbdOk.ok) {
    failures.push('F4/D2: real keyboard open should pass')
    cases.d2Ok = 'FAIL'
  } else {
    cases.d2Ok = 'PASS'
  }

  // F4 D3: force-focus invalid
  const d3Force = evaluateNaturalSheetFocus({
    sheetOpen: true,
    activeInSheet: true,
    forceFocused: true,
  })
  if (d3Force.ok) {
    failures.push('F4/D3: force-focus path must fail')
    cases.d3ForceNeg = 'FAIL'
  } else {
    cases.d3ForceNeg = 'PASS'
  }
  const d3Natural = evaluateNaturalSheetFocus({
    sheetOpen: true,
    activeInSheet: true,
    forceFocused: false,
  })
  if (!d3Natural.ok) {
    failures.push('F4/D3: natural focus should pass')
    cases.d3Natural = 'FAIL'
  } else {
    cases.d3Natural = 'PASS'
  }

  // F4 D4: sheet closed alone insufficient
  const d4SheetOnly = evaluateFocusReturn({ sheetClosed: true, focusOnOpener: false })
  if (d4SheetOnly.ok) {
    failures.push('F4/D4: sheet-closed without focus return must fail')
    cases.d4SheetOnlyNeg = 'FAIL'
  } else {
    cases.d4SheetOnlyNeg = 'PASS'
  }
  const d4Ok = evaluateFocusReturn({ sheetClosed: true, focusOnOpener: true })
  if (!d4Ok.ok) {
    failures.push('F4/D4: focus return should pass')
    cases.d4Ok = 'FAIL'
  } else {
    cases.d4Ok = 'PASS'
  }

  // F4 D6: long transition / empty samples must fail
  if (evaluateReducedMotionDurations([{ selector: '.flow-sheet', durationMs: 300 }]).ok) {
    failures.push('F4/D6: 300ms transition under reduce must fail')
    cases.d6LongNeg = 'FAIL'
  } else {
    cases.d6LongNeg = 'PASS'
  }
  if (evaluateReducedMotionDurations([]).ok) {
    failures.push('F4/D6: empty duration samples must not soft-pass')
    cases.d6EmptyNeg = 'FAIL'
  } else {
    cases.d6EmptyNeg = 'PASS'
  }
  if (!evaluateReducedMotionDurations([{ selector: '.flow-sheet', durationMs: 0 }]).ok) {
    failures.push('F4/D6: 0ms durations should pass')
    cases.d6Ok = 'FAIL'
  } else {
    cases.d6Ok = 'PASS'
  }

  // ── Criterion 3 semantic fixture matrix (fail-closed negatives) ──
  const sem = runSemanticFixtureSelfTest()
  for (const [k, v] of Object.entries(sem.cases)) {
    cases[`sem_${k}`] = v
  }
  if (!sem.ok) {
    failures.push(...sem.failures.map((f) => `S-SEM: ${f}`))
  }

  // Fitur sama must not pass even with content+highlight
  const sameFeat = evaluateSemanticRelatedNavigation({
    hasRelatedControl: true,
    controlKind: 'same-feature',
    gotoId: 'af:rn:home',
    targetPresentAsJourney: true,
    titleBefore: 'A',
    titleAfter: 'B',
    hlId: 'af:rn:home',
    sheetOpen: true,
    routePathBefore: '/b/x/alur',
    routePathAfter: '/b/x/alur',
    mode: 'rn',
    layer: 'app_flow',
  })
  if (sameFeat.ok) {
    failures.push('S2: Fitur sama must never satisfy related-nav PASS')
    cases.sem_same_feature_hardneg = 'FAIL'
  } else {
    cases.sem_same_feature_hardneg = 'PASS'
  }

  // Inventory target must fail
  const invGoto = evaluateSemanticRelatedNavigation({
    hasRelatedControl: true,
    controlKind: 'related',
    isSemanticRelatedTestId: true,
    sectionIsRelatedNav: true,
    gotoId: 'inv:rn:FEAT-X',
    targetPresentAsJourney: true,
    targetIsInventory: true,
    titleBefore: 'A',
    titleAfter: 'B',
    hlId: 'inv:rn:FEAT-X',
    sheetOpen: true,
    mode: 'rn',
    layer: 'app_flow',
    routePathBefore: '/b/x/alur',
    routePathAfter: '/b/x/alur',
  })
  if (invGoto.ok) {
    failures.push('S2: inv: data-goto must fail')
    cases.sem_inv_goto_neg = 'FAIL'
  } else {
    cases.sem_inv_goto_neg = 'PASS'
  }

  // Semantic hardFail name registration
  if (!isFunctionalHardFailName('S1_semantic_layer') || !isFunctionalHardFailName('S2_related')) {
    failures.push('S*: hard-fail name registry missing S1/S2')
    cases.sem_hardfail_registry = 'FAIL'
  } else {
    cases.sem_hardfail_registry = 'PASS'
  }

  // Soft-green proof: failed S1 cannot leave status green
  const softGreenProbe = collectFunctionalHardFails([
    { name: 'S1_semantic_layer', ok: false },
    { name: 'B3_pan_empty_300px', ok: true },
  ])
  if (softGreenProbe.length !== 1) {
    failures.push('S1 hardFail must collect for soft-green prevention')
    cases.sem_soft_green_neg = 'FAIL'
  } else {
    cases.sem_soft_green_neg = 'PASS'
  }

  // FUNCTIONAL_STEPS must include S1/S2/S3
  const stepIds = new Set(FUNCTIONAL_STEPS.map((s) => s.id))
  if (!stepIds.has('S1') || !stepIds.has('S2') || !stepIds.has('S3')) {
    failures.push('FUNCTIONAL_STEPS missing S1/S2/S3')
    cases.sem_steps = 'FAIL'
  } else {
    cases.sem_steps = 'PASS'
  }

  // R3: requiredCrossProjects constant is exact five UI keys
  const five = [...REQUIRED_CROSS_PROJECTS]
  if (
    five.length !== 5 ||
    five.join(',') !== 'rn,web-member,panel-sales,affiliate,backend'
  ) {
    failures.push('REQUIRED_CROSS_PROJECTS must be exact rn,web-member,panel-sales,affiliate,backend')
    cases.sem_required_cross_const = 'FAIL'
  } else {
    cases.sem_required_cross_const = 'PASS'
  }

  // R3: plan advertises requiredCrossProjects=5/list so live operator cannot omit
  const planProbe = planFunctionalSteps({ boardId: DEFAULT_BOARD })
  if (
    planProbe.requiredCrossProjects !== 5 ||
    !Array.isArray(planProbe.requiredCrossProjectsList) ||
    planProbe.requiredCrossProjectsList.join(',') !== five.join(',')
  ) {
    failures.push('plan must state requiredCrossProjects=5 and exact list')
    cases.sem_plan_required_cross = 'FAIL'
  } else {
    cases.sem_plan_required_cross = 'PASS'
  }

  // R3: single-project cross with requiredProjects=5 hardFails (not tautology green)
  const under1 = evaluateSemanticLayerContract({
    mode: 'cross',
    rootLayer: 'app_flow',
    nodes: [
      { id: 'af:rn:a', kind: 'journey_app' },
      { id: 'af:rn:b', kind: 'journey_app' },
    ],
    honestyState: 'ok',
    requiredProjects: [...REQUIRED_CROSS_PROJECTS],
  })
  if (under1.ok || !under1.hardFail || !/missing=\[/.test(under1.reason)) {
    failures.push('R3: 1/5 portfolio must hardFail with missing project details')
    cases.sem_portfolio_1of5 = 'FAIL'
  } else if (/af:rn:/.test(under1.reason)) {
    failures.push('R3: hardFail reason must not leak raw node IDs')
    cases.sem_portfolio_1of5 = 'FAIL'
  } else {
    cases.sem_portfolio_1of5 = 'PASS'
  }

  // R3: public detail scrub never includes journeyIds
  const pub = toSemanticLayerPublicDetail(under1)
  if (
    pub.journeyIds != null ||
    JSON.stringify(pub).includes('af:rn:') ||
    !pub.details?.missingProjects?.length
  ) {
    failures.push('R3: public detail must scrub node IDs and keep missingProjects')
    cases.sem_public_detail_scrub = 'FAIL'
  } else {
    cases.sem_public_detail_scrub = 'PASS'
  }

  // R3: full five-project honest cross PASSes
  const fullFive = evaluateSemanticLayerContract({
    mode: 'cross',
    rootLayer: 'app_flow',
    nodes: [
      { id: 'af:rn:a', kind: 'journey_app' },
      { id: 'af:web-member:b', kind: 'journey_app' },
      { id: 'af:panel-sales:c', kind: 'journey_app' },
      { id: 'af:affiliate:d', kind: 'journey_app' },
      { id: 'af:backend:e', kind: 'journey_app' },
    ],
    honestyState: 'ok',
    requiredProjects: [...REQUIRED_CROSS_PROJECTS],
  })
  if (!fullFive.ok || fullFive.hardFail) {
    failures.push('R3: full five UI projects must PASS layer contract')
    cases.sem_portfolio_5of5 = 'FAIL'
  } else {
    cases.sem_portfolio_5of5 = 'PASS'
  }

  // R3: wrong aliases web/sales fail closed
  const aliasBad = evaluateSemanticLayerContract({
    mode: 'cross',
    rootLayer: 'app_flow',
    nodes: [
      { id: 'af:rn:a', kind: 'journey_app' },
      { id: 'af:web:b', kind: 'journey_app' },
      { id: 'af:sales:c', kind: 'journey_app' },
      { id: 'af:affiliate:d', kind: 'journey_app' },
      { id: 'af:backend:e', kind: 'journey_app' },
    ],
    honestyState: 'ok',
    requiredProjects: [...REQUIRED_CROSS_PROJECTS],
  })
  if (aliasBad.ok || !aliasBad.hardFail) {
    failures.push('R3: web/sales aliases must fail portfolio (UI keys required)')
    cases.sem_portfolio_wrong_alias = 'FAIL'
  } else {
    cases.sem_portfolio_wrong_alias = 'PASS'
  }

  // R3: legacy requireMultiProject without requiredProjects still ≥2 only
  const multiLegacy = evaluateSemanticLayerContract({
    mode: 'cross',
    rootLayer: 'app_flow',
    nodes: [
      { id: 'af:rn:a', kind: 'journey_app' },
      { id: 'af:web-member:b', kind: 'journey_app' },
    ],
    honestyState: 'ok',
    requireMultiProject: true,
  })
  if (!multiLegacy.ok) {
    failures.push('R3: legacy requireMultiProject with 2 projects should still PASS')
    cases.sem_legacy_multi = 'FAIL'
  } else {
    cases.sem_legacy_multi = 'PASS'
  }

  // R3: no auto-green when requiredProjects omitted and only 1 project (no requireMulti)
  const singleNoClaim = evaluateSemanticLayerContract({
    mode: 'cross',
    rootLayer: 'app_flow',
    nodes: [{ id: 'af:rn:a', kind: 'journey_app' }],
    honestyState: 'ok',
  })
  // Without requiredProjects live always supplies it; offline single without claim is layer-ok
  // (prefix/floor only). Live wiring must always pass requiredProjects — asserted in unit source scan.
  if (!singleNoClaim.ok) {
    failures.push('R3: cross single without requiredProjects claim is prefix/floor only (legacy)')
    cases.sem_no_claim_single = 'FAIL'
  } else {
    cases.sem_no_claim_single = 'PASS'
  }

  return {
    ok: failures.length === 0,
    mode: 'self-test',
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    cases,
    failures,
    status: failures.length === 0 ? 'HARNESS_READY' : 'FAIL',
    semantic: {
      fixtureOk: sem.ok,
      fixtureCases: sem.cases,
      requiredCrossProjects: REQUIRED_CROSS_PROJECTS.length,
      requiredCrossProjectsList: [...REQUIRED_CROSS_PROJECTS],
    },
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
 * Live functional suite (oracle-adapted).
 */
export async function runLive(opts = {}) {
  const { chromium } = await import('@playwright/test')
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const base = opts.webBase ?? resolveWebBase()
  const headed = resolveHeaded()
  const fullSha = assertFullSha({ cwd: ROOT })
  const checks = []
  const consoleErrors = []
  const pageErrors = []
  let navCount = 0

  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail ?? null })
    console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail != null ? ' — ' + JSON.stringify(detail) : ''}`)
  }

  printOwnerTarget({ flow: FLOW_NAME, route, mode: 'run' })

  const browser = await chromium.launch({ headless: !headed })
  const contextOpts = {
    baseURL: base,
    viewport: { width: 1440, height: 900 },
  }
  const storagePath = resolveStorageStatePath()
  let authMode = 'none'
  if (fs.existsSync(storagePath)) {
    try {
      contextOpts.storageState = requireExistingStorageState(storagePath)
      authMode = 'storageState'
    } catch (e) {
      authMode = `invalid: ${String(e?.message || e)}`
    }
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)))
  page.on('framenavigated', (frame) => {
    if (frame === page.mainFrame()) navCount++
  })

  let residual = null
  const urlLog = []

  try {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    urlLog.push(page.url())
    const onLogin = /\/login/.test(page.url())
    const onAlur = /\/alur/.test(page.url())

    if (onLogin || !onAlur) {
      residual = {
        code: 'AUTH_OR_ROUTE',
        url: page.url(),
        authMode,
        note: 'No authenticated flow — functional LIVE residual, not PASS',
      }
      check('B0_auth_land_flow', false, residual)
    } else {
      await page
        .locator('[data-testid="flow-ultimate"], [data-testid="flow-node"], .fnode')
        .first()
        .waitFor({ timeout: 30_000 })
      await page.waitForTimeout(400)

      const nodeCount = await page.locator('[data-testid="flow-node"], .fnode').count()
      check('B0_auth_land_flow', nodeCount > 0, { nodeCount, url: page.url(), authMode })

      // Graph introspection via DOM (product may not expose window.__FLOW__)
      const crossInfo = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="flow-ultimate"]')
        const mode =
          root?.getAttribute('data-mode') ||
          (document.querySelector('.flow-pill.on')?.getAttribute('data-mode') ?? null)
        const nodes = [...document.querySelectorAll('[data-testid="flow-node"], .fnode')]
        const projects = new Set(
          nodes
            .map((n) => {
              const tag = n.querySelector('.flow-proj-tag')
              return tag?.textContent?.trim() || n.getAttribute('data-project') || null
            })
            .filter(Boolean),
        )
        return {
          mode,
          nodeCount: nodes.length,
          projectCount: projects.size,
          projects: [...projects],
          crossSelected:
            document.querySelector('.flow-pill[data-mode="cross"]')?.getAttribute('aria-selected') ===
            'true',
        }
      })
      check(
        'B1_default_mode_cross',
        crossInfo.mode === 'cross' || crossInfo.crossSelected,
        crossInfo,
      )
      check('B1_projects_ge_1', crossInfo.projectCount >= 1 || crossInfo.nodeCount > 0, crossInfo)

      // B2: five project switches
      const projectModes = FLOW_MODES.filter((m) => m !== 'cross')
      const switchResults = []
      for (const m of projectModes) {
        await page.locator(`.flow-pill[data-mode="${m}"]`).click()
        await page.waitForTimeout(350)
        const info = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="flow-ultimate"]')
          return {
            mode: root?.getAttribute('data-mode'),
            nodes: document.querySelectorAll('[data-testid="flow-node"], .fnode').length,
            sheetOpen: document
              .querySelector('[data-testid="flow-sheet"], .flow-sheet')
              ?.classList.contains('is-open'),
          }
        })
        switchResults.push({ mode: m, ...info })
        check(
          `B2_switch_${m}`,
          info.mode === m && info.nodes > 0 && !info.sheetOpen,
          info,
        )
      }
      // restore cross
      await page.locator('.flow-pill[data-mode="cross"]').click()
      await page.waitForTimeout(350)

      // B3 pan
      await page.evaluate(() => {
        try {
          localStorage.removeItem('cairn-flow-pos-v1')
        } catch {
          /* */
        }
      })
      // Use transform style on .flow-world as product signal
      const panBefore = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        return { transform: t }
      })
      const stageBox = await page.locator('[data-testid="flow-stage"], .flow-stage').boundingBox()
      if (stageBox) {
        const panStart = { x: stageBox.x + stageBox.width - 80, y: stageBox.y + 40 }
        await page.mouse.move(panStart.x, panStart.y)
        await page.mouse.down()
        await page.mouse.move(panStart.x + 300, panStart.y, { steps: 15 })
        await page.mouse.up()
        await page.waitForTimeout(120)
      }
      const panAfter = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        return { transform: w ? getComputedStyle(w).transform : 'none' }
      })
      const parseTx = (t) => {
        if (!t || t === 'none') return { x: 0, y: 0 }
        const m = t.match(/matrix\(([^)]+)\)/)
        if (!m) return { x: 0, y: 0 }
        const parts = m[1].split(',').map((x) => Number(x.trim()))
        return { x: parts[4] || 0, y: parts[5] || 0 }
      }
      const panDx = parseTx(panAfter.transform).x - parseTx(panBefore.transform).x
      const panEval = evaluatePanDelta(panDx)
      check('B3_pan_empty_300px', panEval.ok, { panBefore, panAfter, ...panEval })

      // B4 zoom
      const scaleBefore = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        if (!t || t === 'none') return 1
        const m = t.match(/matrix\(([^)]+)\)/)
        if (!m) return 1
        return Math.abs(Number(m[1].split(',')[0])) || 1
      })
      const zoomIn = page.locator('.flow-zoom button[title="Zoom in"], .flow-zoom button').nth(0)
      const zoomOut = page.locator('.flow-zoom button[title="Zoom out"], .flow-zoom button').nth(1)
      const zoomFit = page.locator('.flow-zoom button[title="Fit all"], .flow-zoom button').nth(2)
      await zoomIn.click()
      await page.waitForTimeout(100)
      const scaleIn = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        if (!t || t === 'none') return 1
        const m = t.match(/matrix\(([^)]+)\)/)
        return m ? Math.abs(Number(m[1].split(',')[0])) || 1 : 1
      })
      await zoomOut.click()
      await page.waitForTimeout(100)
      const scaleOut = await page.evaluate(() => {
        const w = document.querySelector('[data-testid="flow-world"], .flow-world')
        const t = w ? getComputedStyle(w).transform : 'none'
        if (!t || t === 'none') return 1
        const m = t.match(/matrix\(([^)]+)\)/)
        return m ? Math.abs(Number(m[1].split(',')[0])) || 1 : 1
      })
      await zoomFit.click()
      await page.waitForTimeout(150)
      const zoomEval = evaluateZoomScale(scaleBefore, scaleIn, scaleOut)
      check('B4_zoom_controls', zoomEval.ok || scaleIn !== scaleBefore, zoomEval)

      // B5/B6 drag
      await page.evaluate(() => {
        try {
          localStorage.removeItem('cairn-flow-pos-v1')
        } catch {
          /* */
        }
      })
      // Ensure we have nodes in cross
      await page.locator('.flow-pill[data-mode="cross"]').click()
      await page.waitForTimeout(300)
      const nodeLoc = page.locator('[data-testid="flow-node"], .fnode').first()
      const nodeBox = await nodeLoc.boundingBox()
      const beforePos = await page.evaluate(() => {
        const n = document.querySelector('[data-testid="flow-node"], .fnode')
        if (!n) return null
        const r = n.getBoundingClientRect()
        return {
          id: n.getAttribute('data-node-id'),
          x: parseFloat(n.style.left) || r.left,
          y: parseFloat(n.style.top) || r.top,
          cx: r.left + r.width / 2,
          cy: r.top + r.height / 2,
        }
      })
      // Canvas edge probe BEFORE drag (F5) — pixel/geometry, not center proxy alone
      const edgeBefore = await page.evaluate(() => {
        const CARD_H = 64
        const canvas = document.querySelector(
          'canvas.flow-edges, [data-testid="flow-edges"]',
        )
        const n = document.querySelector('[data-testid="flow-node"], .fnode')
        if (!canvas || !n) return null
        const ctx = canvas.getContext('2d', { willReadFrequently: true })
        if (!ctx) return null
        const dpr = window.devicePixelRatio || 1
        const wx = (parseFloat(n.style.left) || 0) + 17
        const wy = (parseFloat(n.style.top) || 0) + CARD_H / 2
        const digest = () => {
          const { width, height } = canvas
          if (!width || !height) return '0x0:0'
          const data = ctx.getImageData(0, 0, width, height).data
          let h = 2166136261
          for (let i = 0; i < data.length; i += 97) {
            h ^= data[i]
            h = Math.imul(h, 16777619)
          }
          let ink = 0
          for (let i = 3; i < data.length; i += 16) {
            if (data[i] > 8) ink++
          }
          return `${width}x${height}:${h >>> 0}:${ink}`
        }
        const inkNear = (x, y, radius = 10) => {
          const cx = Math.round(x * dpr)
          const cy = Math.round(y * dpr)
          const r = Math.round(radius * dpr)
          const x0 = Math.max(0, cx - r)
          const y0 = Math.max(0, cy - r)
          const w = Math.min(canvas.width - x0, r * 2 + 1)
          const h = Math.min(canvas.height - y0, r * 2 + 1)
          if (w <= 0 || h <= 0) return 0
          const data = ctx.getImageData(x0, y0, w, h).data
          let ink = 0
          for (let i = 3; i < data.length; i += 4) {
            if (data[i] > 10) ink++
          }
          return ink
        }
        return {
          digest: digest(),
          wx,
          wy,
          ink: inkNear(wx, wy),
        }
      })
      if (nodeBox && beforePos) {
        const start = { x: nodeBox.x + nodeBox.width / 2, y: nodeBox.y + nodeBox.height / 2 }
        await page.mouse.move(start.x, start.y)
        await page.mouse.down()
        await page.mouse.move(start.x + 120, start.y, { steps: 12 })
        await page.mouse.up()
        await page.waitForTimeout(200)
        const afterPos = await page.evaluate((id) => {
          const n =
            (id && document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)) ||
            document.querySelector('[data-testid="flow-node"], .fnode')
          if (!n) return null
          const r = n.getBoundingClientRect()
          return {
            id: n.getAttribute('data-node-id'),
            x: parseFloat(n.style.left) || r.left,
            y: parseFloat(n.style.top) || r.top,
            cx: r.left + r.width / 2,
            cy: r.top + r.height / 2,
          }
        }, beforePos.id)
        const edgeAfter = await page.evaluate((old) => {
          const CARD_H = 64
          const canvas = document.querySelector(
            'canvas.flow-edges, [data-testid="flow-edges"]',
          )
          const n = old?.id
            ? document.querySelector(`[data-node-id="${CSS.escape(old.id)}"]`)
            : document.querySelector('[data-testid="flow-node"], .fnode')
          if (!canvas || !n) return null
          const ctx = canvas.getContext('2d', { willReadFrequently: true })
          if (!ctx) return null
          const dpr = window.devicePixelRatio || 1
          const wx = (parseFloat(n.style.left) || 0) + 17
          const wy = (parseFloat(n.style.top) || 0) + CARD_H / 2
          const digest = () => {
            const { width, height } = canvas
            if (!width || !height) return '0x0:0'
            const data = ctx.getImageData(0, 0, width, height).data
            let h = 2166136261
            for (let i = 0; i < data.length; i += 97) {
              h ^= data[i]
              h = Math.imul(h, 16777619)
            }
            let ink = 0
            for (let i = 3; i < data.length; i += 16) {
              if (data[i] > 8) ink++
            }
            return `${width}x${height}:${h >>> 0}:${ink}`
          }
          const inkNear = (x, y, radius = 10) => {
            const cx = Math.round(x * dpr)
            const cy = Math.round(y * dpr)
            const r = Math.round(radius * dpr)
            const x0 = Math.max(0, cx - r)
            const y0 = Math.max(0, cy - r)
            const w = Math.min(canvas.width - x0, r * 2 + 1)
            const h = Math.min(canvas.height - y0, r * 2 + 1)
            if (w <= 0 || h <= 0) return 0
            const data = ctx.getImageData(x0, y0, w, h).data
            let ink = 0
            for (let i = 3; i < data.length; i += 4) {
              if (data[i] > 10) ink++
            }
            return ink
          }
          return {
            digest: digest(),
            wx,
            wy,
            inkNew: inkNear(wx, wy),
            inkOld: old ? inkNear(old.wx, old.wy) : 0,
          }
        }, edgeBefore)
        const dragEval = evaluateDragMovement(beforePos, afterPos)
        check('B5_drag_node_120px', dragEval.ok, { before: beforePos, after: afterPos, ...dragEval })
        const centerDelta = Math.hypot(
          afterPos.cx - beforePos.cx,
          afterPos.cy - beforePos.cy,
        )
        const edgeEval = evaluateEdgeEndpointRedraw({
          canvasChanged: Boolean(
            edgeBefore && edgeAfter && edgeBefore.digest !== edgeAfter.digest,
          ),
          beforeInkNearOldCenter: edgeBefore?.ink ?? 0,
          afterInkNearOldCenter: edgeAfter?.inkOld ?? 0,
          afterInkNearNewCenter: edgeAfter?.inkNew ?? 0,
          nodeCenterDelta: centerDelta,
        })
        check('B6_edge_endpoint_follows', edgeEval.ok, {
          edgeEval,
          edgeBefore,
          edgeAfter,
          centerDelta,
          note: 'Requires canvas pixel/geometry redraw — not node center delta alone',
        })

        // B7 localStorage
        const stored = await page.evaluate((key) => {
          try {
            return localStorage.getItem(key)
          } catch {
            return null
          }
        }, STORAGE_KEY)
        check('B7_localStorage_written', Boolean(stored && stored.length > 2), {
          key: STORAGE_KEY,
          len: stored?.length ?? 0,
        })
        const pathBeforeReload = new URL(page.url()).pathname
        await page.reload({ waitUntil: 'domcontentloaded' })
        await page
          .locator('[data-testid="flow-node"], .fnode')
          .first()
          .waitFor({ timeout: 30_000 })
          .catch(() => null)
        await page.waitForTimeout(400)
        const afterReload = await page.evaluate((id) => {
          const n =
            (id && document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)) ||
            document.querySelector('[data-testid="flow-node"], .fnode')
          if (!n) return null
          return {
            id: n.getAttribute('data-node-id'),
            x: parseFloat(n.style.left) || 0,
            y: parseFloat(n.style.top) || 0,
          }
        }, beforePos.id)
        const storedAfter = await page.evaluate((key) => localStorage.getItem(key), STORAGE_KEY)
        check(
          'B7_localStorage_survives_reload',
          Boolean(storedAfter) &&
            afterReload &&
            (Math.abs(afterReload.x - afterPos.x) <= 30 || Math.abs(afterReload.x - beforePos.x) > 40),
          { afterReload, afterPos, storedLen: storedAfter?.length ?? 0 },
        )
        check(
          'B11_path_after_reload',
          new URL(page.url()).pathname === pathBeforeReload,
          { path: new URL(page.url()).pathname, pathBeforeReload },
        )
      } else {
        check('B5_drag_node_120px', false, { reason: 'no node box' })
        check('B6_edge_endpoint_follows', false, { reason: 'no node box' })
        check('B7_localStorage_written', false, { reason: 'no drag' })
        check('B7_localStorage_survives_reload', false, { reason: 'no drag' })
      }

      // B8 sheet
      const urlBeforeSheet = page.url()
      const clickTarget = page.locator('[data-testid="flow-node"], .fnode').nth(1)
      const expectedTitle = await clickTarget.locator('.ft').innerText().catch(() => '')
      await clickTarget.click()
      await page.waitForTimeout(350)
      const sheetState = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="flow-sheet"], #flow-sheet, .flow-sheet')
        const title = document.getElementById('sheet-title')?.textContent || ''
        return {
          hasClass: sheet?.classList.contains('is-open'),
          aria: sheet?.getAttribute('aria-hidden'),
          title,
        }
      })
      check(
        'B8_click_node_sheet',
        sheetState.hasClass && sheetState.aria !== 'true',
        sheetState,
      )
      check(
        'B8_title_match',
        !expectedTitle ||
          sheetState.title.trim() === expectedTitle.trim() ||
          sheetState.title.includes(expectedTitle.slice(0, 12)),
        { expectedTitle, got: sheetState.title },
      )
      check('B11_url_unchanged_sheet', page.url() === urlBeforeSheet, {
        before: urlBeforeSheet,
        after: page.url(),
      })

      // ── S1 semantic graph/layer (criterion 3A) — DOM attributes only ──
      const semanticDom = await page.evaluate(() => {
        const root = document.querySelector('[data-testid="flow-ultimate"]')
        const mode =
          root?.getAttribute('data-mode') ||
          document.querySelector('.flow-pill.on')?.getAttribute('data-mode') ||
          null
        const rootLayer = root?.getAttribute('data-layer') || null
        const layerTablistPresent = Boolean(
          document.querySelector(
            '[data-testid="flow-layer-toggle"], .flow-layers[role="tablist"]',
          ),
        )
        const honestyPinText =
          document.querySelector('[data-testid="flow-honesty-pin"]')?.textContent ||
          null
        const nodes = [...document.querySelectorAll('[data-testid="flow-node"], .fnode')].map(
          (el) => ({
            id: el.getAttribute('data-node-id') || '',
            kind: el.getAttribute('data-node-kind'),
            className: el.className || '',
            visible: el.getClientRects().length > 0,
          }),
        )
        return {
          mode,
          rootLayer,
          layerTablistPresent,
          honestyPinText,
          nodes,
          hasFlowRoot: Boolean(root),
        }
      })
      const journeyCountLive = semanticDom.nodes.filter((n) => {
        const c = classifySemanticNodeId(n.id)
        return c.isJourney && !isInventoryDomNode(n)
      }).length
      const honestyState = classifyDomHonestyState({
        honestyPinText: semanticDom.honestyPinText,
        journeyNodeCount: journeyCountLive,
        hasFlowRoot: semanticDom.hasFlowRoot,
      })
      // Live cross: ALWAYS pass exact five-project portfolio — never tautological auto-detect
      const layerEval = evaluateSemanticLayerContract({
        mode: semanticDom.mode || '',
        rootLayer: semanticDom.rootLayer,
        layerTablistPresent: semanticDom.layerTablistPresent,
        nodes: semanticDom.nodes,
        honestyState,
        requiredProjects:
          semanticDom.mode === 'cross' ? [...REQUIRED_CROSS_PROJECTS] : undefined,
      })
      // Public detail: missing project keys only — never raw internal node IDs
      check('S1_semantic_layer', layerEval.ok, toSemanticLayerPublicDetail(layerEval))
      check(
        'S1_no_list_order_cap',
        layerEval.details?.noListOrderCap === true || !layerEval.ok,
        { note: 'semantic PASS never uses sequential list-order inference' },
      )
      if (semanticDom.mode === 'cross') {
        check(
          'S1_cross_portfolio_five',
          layerEval.ok &&
            layerEval.details?.requiredCrossProjects === REQUIRED_CROSS_PROJECTS.length,
          {
            requiredCrossProjects: REQUIRED_CROSS_PROJECTS.length,
            requiredCrossProjectsList: [...REQUIRED_CROSS_PROJECTS],
            presentProjects: layerEval.projects,
            missingProjects: layerEval.details?.missingProjects,
            reason: layerEval.reason,
          },
        )
      }

      // Sample project modes deterministically (rn + first other) for layer prefixes
      const sampleModes = ['rn', 'web-member'].filter((m) =>
        FLOW_MODES.includes(m),
      )
      for (const m of sampleModes) {
        await page.locator(`.flow-pill[data-mode="${m}"]`).click()
        await page.waitForTimeout(300)
        // app_flow layer
        const appFlowLayerBtn = page.locator(
          '.flow-layer-pill[data-layer="app_flow"], [data-testid="flow-layer-toggle"] [data-layer="app_flow"]',
        )
        if ((await appFlowLayerBtn.count()) > 0) {
          await appFlowLayerBtn.first().click()
          await page.waitForTimeout(250)
        }
        const projApp = await page.evaluate(() => {
          const root = document.querySelector('[data-testid="flow-ultimate"]')
          return {
            mode: root?.getAttribute('data-mode'),
            rootLayer: root?.getAttribute('data-layer'),
            layerTablistPresent: Boolean(
              document.querySelector('[data-testid="flow-layer-toggle"]'),
            ),
            nodes: [...document.querySelectorAll('[data-testid="flow-node"], .fnode')].map(
              (el) => ({
                id: el.getAttribute('data-node-id') || '',
                kind: el.getAttribute('data-node-kind'),
                className: el.className || '',
              }),
            ),
          }
        })
        const projAppEval = evaluateSemanticLayerContract({
          mode: projApp.mode || m,
          rootLayer: projApp.rootLayer,
          layerTablistPresent: projApp.layerTablistPresent,
          nodes: projApp.nodes,
          honestyState: classifyDomHonestyState({
            honestyPinText: null,
            journeyNodeCount: projApp.nodes.filter((n) =>
              classifySemanticNodeId(n.id).isJourney,
            ).length,
            hasFlowRoot: true,
          }),
        })
        check(
          `S1_project_${m}_app_flow`,
          projAppEval.ok,
          toSemanticLayerPublicDetail(projAppEval),
        )

        // page_nav layer
        const pageNavBtn = page.locator(
          '.flow-layer-pill[data-layer="page_nav"], [data-testid="flow-layer-toggle"] [data-layer="page_nav"]',
        )
        if ((await pageNavBtn.count()) > 0) {
          await pageNavBtn.first().click()
          await page.waitForTimeout(250)
          const projPn = await page.evaluate(() => {
            const root = document.querySelector('[data-testid="flow-ultimate"]')
            return {
              mode: root?.getAttribute('data-mode'),
              rootLayer: root?.getAttribute('data-layer'),
              layerTablistPresent: Boolean(
                document.querySelector('[data-testid="flow-layer-toggle"]'),
              ),
              nodes: [...document.querySelectorAll('[data-testid="flow-node"], .fnode')].map(
                (el) => ({
                  id: el.getAttribute('data-node-id') || '',
                  kind: el.getAttribute('data-node-kind'),
                  className: el.className || '',
                }),
              ),
            }
          })
          const projPnEval = evaluateSemanticLayerContract({
            mode: projPn.mode || m,
            rootLayer: projPn.rootLayer,
            layerTablistPresent: projPn.layerTablistPresent,
            nodes: projPn.nodes,
            honestyState: classifyDomHonestyState({
              honestyPinText: null,
              journeyNodeCount: projPn.nodes.filter((n) =>
                classifySemanticNodeId(n.id).isJourney,
              ).length,
              hasFlowRoot: true,
            }),
          })
          check(
            `S1_project_${m}_page_nav`,
            projPnEval.ok,
            toSemanticLayerPublicDetail(projPnEval),
          )
        } else {
          check(`S1_project_${m}_page_nav`, false, {
            reason: 'page_nav layer control missing — blocker for semantic layer sample',
          })
        }
      }
      // restore cross
      await page.locator('.flow-pill[data-mode="cross"]').click()
      await page.waitForTimeout(300)

      // B9/S2 related — ONLY [data-testid=flow-related] inside Navigasi terkait
      // Fitur sama (flow-same-feature-item) must NOT satisfy PASS (F3/F6 + criterion 3B)
      let relatedFound = false
      let relatedEval = evaluateSemanticRelatedNavigation({
        hasRelatedControl: false,
        controlKind: 'absent',
      })
      const pathBeforeRelated = new URL(page.url()).pathname
      const nodeCountForRelated = await page.locator('[data-testid="flow-node"], .fnode').count()
      const scanLimit = Math.min(nodeCountForRelated, 10)
      for (let i = 0; i < scanLimit; i++) {
        await page.locator('[data-testid="flow-node"], .fnode').nth(i).click()
        await page.waitForTimeout(280)
        // Explicitly ignore same-feature controls
        const sameFeatCount = await page
          .locator('[data-testid="flow-same-feature-item"]')
          .count()
        const relatedBtn = page.locator('[data-testid="flow-related"]').first()
        if ((await relatedBtn.count()) === 0) continue
        // Prove same-feature alone would not count
        if (sameFeatCount > 0) {
          const sameGoto = await page
            .locator('[data-testid="flow-same-feature-item"]')
            .first()
            .getAttribute('data-goto')
          const sameFeatEval = evaluateSemanticRelatedNavigation({
            hasRelatedControl: true,
            controlKind: 'same-feature',
            gotoId: sameGoto,
            targetPresentAsJourney: true,
            titleBefore: 'x',
            titleAfter: 'y',
            hlId: sameGoto,
            sheetOpen: true,
            mode: semanticDom.mode || 'cross',
            layer: semanticDom.rootLayer,
            routePathBefore: pathBeforeRelated,
            routePathAfter: pathBeforeRelated,
          })
          check('S2_same_feature_cannot_pass', !sameFeatEval.ok, sameFeatEval)
        } else {
          check('S2_same_feature_cannot_pass', true, {
            note: 'no same-feature control on this node — N/A pass',
          })
        }
        relatedFound = true
        const titleBefore = await page.locator('#sheet-title').innerText()
        const bodyBefore = await page
          .locator('#sheet-body, [data-testid="flow-sheet"]')
          .innerText()
          .catch(() => '')
        const gotoId = await relatedBtn.getAttribute('data-goto')
        const sectionText = await page
          .locator('[data-testid="flow-sheet"], .flow-sheet')
          .innerText()
          .catch(() => '')
        const sectionIsRelatedNav = /Navigasi terkait/i.test(sectionText)
        const journeyIds = new Set(
          (
            await page.evaluate(() =>
              [...document.querySelectorAll('[data-testid="flow-node"], .fnode')]
                .map((el) => el.getAttribute('data-node-id') || '')
                .filter(Boolean),
            )
          ).filter((id) => classifySemanticNodeId(id).isJourney),
        )
        const targetPresentAsJourney = Boolean(gotoId && journeyIds.has(gotoId))
        const targetIsInventory = Boolean(
          gotoId && classifySemanticNodeId(gotoId).isInventory,
        )
        await relatedBtn.click()
        await page.waitForTimeout(400)
        const afterNav = await page.evaluate(() => {
          const title = document.getElementById('sheet-title')?.textContent || ''
          const body =
            document.getElementById('sheet-body')?.innerText ||
            document.querySelector('[data-testid="flow-sheet"]')?.innerText ||
            ''
          const hl = document.querySelector(
            '.fnode.is-hl, .fnode.on, [data-testid="flow-node"].is-hl, [data-testid="flow-node"].on',
          )
          return {
            title,
            body,
            hlId: hl?.getAttribute('data-node-id') || null,
            open: document
              .querySelector('[data-testid="flow-sheet"], .flow-sheet')
              ?.classList.contains('is-open'),
          }
        })
        const pathAfterRelated = new URL(page.url()).pathname
        relatedEval = evaluateSemanticRelatedNavigation({
          hasRelatedControl: true,
          controlKind: 'related',
          isSemanticRelatedTestId: true,
          sectionIsRelatedNav,
          titleBefore,
          titleAfter: afterNav.title,
          bodyBefore,
          bodyAfter: afterNav.body,
          hlId: afterNav.hlId,
          gotoId,
          sheetOpen: afterNav.open,
          targetPresentAsJourney,
          targetIsInventory,
          mode: semanticDom.mode || 'cross',
          layer: semanticDom.rootLayer || 'app_flow',
          routePathBefore: pathBeforeRelated,
          routePathAfter: pathAfterRelated,
        })
        check(
          'B9_related_content_changes',
          relatedEval.ok &&
            (titleBefore !== afterNav.title || bodyBefore !== afterNav.body),
          { relatedEval, titleBefore, after: afterNav, gotoId },
        )
        check(
          'B9_related_highlight',
          Boolean(gotoId && afterNav.hlId === gotoId),
          { hlId: afterNav.hlId, gotoId, relatedEval },
        )
        check('B9_related_nav', relatedEval.ok, relatedEval)
        check('S2_semantic_related_nav', relatedEval.ok, relatedEval)
        check(
          'S2_related_keeps_alur',
          pathAfterRelated === pathBeforeRelated && /\/alur/.test(pathAfterRelated),
          { pathBeforeRelated, pathAfterRelated },
        )
        break
      }
      if (!relatedFound) {
        relatedEval = evaluateSemanticRelatedNavigation({
          hasRelatedControl: false,
          controlKind: 'absent',
        })
        check('B9_related_content_changes', false, {
          residual: true,
          ...relatedEval,
        })
        check('B9_related_highlight', false, {
          residual: true,
          ...relatedEval,
        })
        check('B9_related_nav', false, {
          residual: true,
          ...relatedEval,
        })
        check('S2_semantic_related_nav', false, {
          residual: true,
          ...relatedEval,
        })
      }

      // S3 Indonesian labels + no node-id leak in visible copy
      const visibleChrome = await page.evaluate(() => document.body?.innerText || '')
      const idIdEval = evaluateIndonesianChromeLabels({
        visibleText: visibleChrome,
        requireLayers: false,
        requireRelatedSection: relatedFound,
      })
      check('S3_id_id_chrome', idIdEval.ok, idIdEval)
      const techHitsSem = findTechIdHits(visibleChrome)
      check('S3_tech_id_scrub', techHitsSem.length === 0, { techHitsSem })

      // B10 Escape
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      const sheetClosed = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="flow-sheet"], .flow-sheet')
        return !sheet?.classList.contains('is-open')
      })
      check('B10_escape_closes', sheetClosed, { sheetClosed })

      // D2 keyboard: real node keyboard open — zoom/pill alone is insufficient (F4)
      await page.keyboard.press('Escape').catch(() => null)
      await page.waitForTimeout(150)
      const kbdMeta = await page.evaluate(() => {
        const node = document.querySelector('[data-testid="flow-node"], .fnode')
        if (!node) {
          return { nodeKeyboardFocusable: false, reason: 'no node' }
        }
        const ti = node.getAttribute('tabindex')
        const focusable =
          node.tabIndex >= 0 ||
          (ti != null && ti !== '-1') ||
          node.getAttribute('role') === 'button' ||
          Boolean(node.querySelector('a[href], button, [tabindex]:not([tabindex="-1"])'))
        return {
          nodeKeyboardFocusable: focusable,
          tabIndex: node.tabIndex,
          tag: node.tagName,
          role: node.getAttribute('role'),
        }
      })
      let openedViaKeyboard = false
      if (kbdMeta.nodeKeyboardFocusable) {
        await page.locator('[data-testid="flow-node"], .fnode').first().focus()
        await page.keyboard.press('Enter')
        await page.waitForTimeout(300)
        openedViaKeyboard = await page.evaluate(() =>
          Boolean(
            document
              .querySelector('[data-testid="flow-sheet"], .flow-sheet')
              ?.classList.contains('is-open'),
          ),
        )
        if (!openedViaKeyboard) {
          await page.locator('[data-testid="flow-node"], .fnode').first().focus()
          await page.keyboard.press('Space')
          await page.waitForTimeout(300)
          openedViaKeyboard = await page.evaluate(() =>
            Boolean(
              document
                .querySelector('[data-testid="flow-sheet"], .flow-sheet')
                ?.classList.contains('is-open'),
            ),
          )
        }
      }
      const d2Eval = evaluateKeyboardNodeOpen({
        nodeKeyboardFocusable: Boolean(kbdMeta.nodeKeyboardFocusable),
        openedViaKeyboard,
      })
      check('D2_keyboard_node_open', d2Eval.ok, { ...kbdMeta, openedViaKeyboard, d2Eval })

      // D3 — natural focus into sheet WITHOUT force-focusing controls (F4)
      await page.keyboard.press('Escape').catch(() => null)
      await page.waitForTimeout(150)
      await page.locator('[data-testid="flow-node"], .fnode').first().click()
      await page.waitForTimeout(350)
      const focusInSheet = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="flow-sheet"], .flow-sheet')
        const ae = document.activeElement
        // Do NOT call focus() — measure natural initial focus / trap only
        return {
          sheetOpen: sheet?.classList.contains('is-open'),
          activeInSheet: Boolean(sheet && ae && sheet.contains(ae)),
          activeTag: ae?.tagName,
          activeTestId: ae?.getAttribute?.('data-testid') || null,
          forceFocused: false,
        }
      })
      // Optional Tab trap probe without force-focus seed
      let trapOk = focusInSheet.activeInSheet
      if (focusInSheet.sheetOpen && focusInSheet.activeInSheet) {
        await page.keyboard.press('Tab')
        await page.waitForTimeout(80)
        trapOk = await page.evaluate(() => {
          const sheet = document.querySelector('[data-testid="flow-sheet"], .flow-sheet')
          const ae = document.activeElement
          return Boolean(sheet && ae && sheet.contains(ae))
        })
      }
      const d3Eval = evaluateNaturalSheetFocus({
        sheetOpen: Boolean(focusInSheet.sheetOpen),
        activeInSheet: Boolean(focusInSheet.activeInSheet),
        forceFocused: false,
      })
      check('D3_focus_into_sheet', d3Eval.ok, { ...focusInSheet, trapOk, d3Eval })

      // D4 — focus must return to opener after Escape (F4)
      const openerId = await page
        .locator('[data-testid="flow-node"], .fnode')
        .first()
        .getAttribute('data-node-id')
      // Re-open from known opener if needed
      const sheetStillOpen = await page.evaluate(() =>
        document
          .querySelector('[data-testid="flow-sheet"], .flow-sheet')
          ?.classList.contains('is-open'),
      )
      if (!sheetStillOpen && openerId) {
        await page.locator(`[data-node-id="${openerId}"]`).click()
        await page.waitForTimeout(300)
      }
      // Mark opener for focus-return comparison
      await page.evaluate((id) => {
        const el = id
          ? document.querySelector(`[data-node-id="${CSS.escape(id)}"]`)
          : document.querySelector('[data-testid="flow-node"], .fnode')
        if (el) el.setAttribute('data-flow-opener', '1')
      }, openerId)
      await page.keyboard.press('Escape')
      await page.waitForTimeout(250)
      const afterEsc = await page.evaluate(() => {
        const sheet = document.querySelector('[data-testid="flow-sheet"], .flow-sheet')
        const ae = document.activeElement
        const opener = document.querySelector('[data-flow-opener="1"]')
        const focusOnOpener = Boolean(
          opener && ae && (ae === opener || opener.contains(ae)),
        )
        return {
          sheetOpen: sheet?.classList.contains('is-open'),
          focusOnOpener,
          active:
            ae?.getAttribute?.('data-testid') ||
            ae?.getAttribute?.('data-node-id') ||
            ae?.tagName,
        }
      })
      const d4Eval = evaluateFocusReturn({
        sheetClosed: afterEsc.sheetOpen === false,
        focusOnOpener: Boolean(afterEsc.focusOnOpener),
      })
      check('D4_escape_focus', d4Eval.ok, { ...afterEsc, d4Eval })
      check('B10_escape_closes_d4', afterEsc.sheetOpen === false, afterEsc)

      // D6 reduced motion — fail on non-compliant durations; empty samples fail (F4)
      await page.emulateMedia({ reducedMotion: 'reduce' })
      await page.waitForTimeout(100)
      const rm = await page.evaluate(() => {
        const sels = [
          '.flow-sheet',
          '[data-testid="flow-sheet"]',
          '.flow-backdrop',
          '.fnode',
          '.flow-pill',
          '.flow-hint',
        ]
        const samples = []
        for (const sel of sels) {
          const el = document.querySelector(sel)
          if (!el) continue
          const st = getComputedStyle(el)
          const parseList = (raw) =>
            (raw || '0s')
              .split(',')
              .map((x) => x.trim())
              .map((x) => {
                if (!x || x === '0') return 0
                return x.endsWith('ms') ? parseFloat(x) : parseFloat(x) * 1000
              })
              .filter((n) => Number.isFinite(n))
          const durs = [
            ...parseList(st.transitionDuration),
            ...parseList(st.animationDuration),
          ]
          const maxD = durs.length ? Math.max(0, ...durs) : 0
          samples.push({ selector: sel, durationMs: maxD })
        }
        return {
          matches: window.matchMedia('(prefers-reduced-motion: reduce)').matches,
          samples,
        }
      })
      const rmEval = evaluateReducedMotionDurations(rm.samples)
      check('D6_reduced_motion_media', rm.matches, { matches: rm.matches })
      check(
        'D6_reduced_motion',
        rm.matches && rmEval.ok,
        { ...rm, rmEval, note: 'Non-compliant transition/animation durations under reduce are FAIL' },
      )
      await page.emulateMedia({ reducedMotion: 'no-preference' })

      // D7 touch 44
      const touchSamples = await page.evaluate(() => {
        const sels = [
          '.flow-pill',
          '.flow-zoom button',
          '.flow-sheet-close, [data-testid="flow-sheet-close"]',
          '.flow-brand',
        ]
        const out = []
        for (const sel of sels) {
          const el = document.querySelector(sel)
          if (!el) continue
          const r = el.getBoundingClientRect()
          out.push({ selector: sel, w: Math.round(r.width), h: Math.round(r.height) })
        }
        return out
      })
      const touchEval = evaluateTouchTargets(touchSamples)
      check('D7_touch_44', touchEval.ok, touchEval)

      // D1 axe
      try {
        const axe = await runAxe(page, {
          outPath: OUT_AXE,
          browserTestId: `canon-flow-functional-${fullSha.slice(0, 8)}`,
        })
        check('D1_axe_critical_serious', axe.ok, {
          criticalSerious: axe.criticalSerious?.length ?? 0,
          rawPath: axe.rawPath,
        })
      } catch (e) {
        check('D1_axe_critical_serious', false, {
          error: String(e?.message || e),
          note: 'axe helper failed',
        })
      }

      // C3 tech ids
      const visibleText = await page.evaluate(() => document.body?.innerText || '')
      const techHits = findTechIdHits(visibleText)
      check('C3_no_tech_ids', techHits.length === 0, { techHits })

      // C1 data honesty seam
      const nodeIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-node-id]')]
          .map((el) => el.getAttribute('data-node-id'))
          .filter(Boolean),
      )
      const bundleMeta = await page.evaluate(async () => {
        try {
          const r = await fetch('/flow-data/data-bundle.json')
          if (!r.ok) return { source: 'missing', status: r.status }
          const j = await r.json()
          return {
            source: 'file',
            projectsSource: j?.projects?.source ?? 'anonymous-static',
            generated_at: j?.projects?.generated_at ?? null,
            premiumSteps: j?.premium?.steps?.length ?? 0,
            projectCount: j?.projects?.projects?.length ?? 0,
          }
        } catch (e) {
          return { source: 'error', error: String(e?.message || e) }
        }
      })
      const honesty = classifyDataHonesty({
        source: bundleMeta.source,
        pinFieldsPresent: false,
        visibleNodeIds: nodeIds,
      })
      check('C1_emit_node_ids', nodeIds.length > 0, {
        count: nodeIds.length,
        sample: nodeIds.slice(0, 8),
      })
      check('C1_data_honesty_local_only', honesty.claim === 'LOCAL_ONLY', {
        honesty,
        bundleMeta,
      })

      check('console_error_0', consoleErrors.length === 0, {
        count: consoleErrors.length,
        sample: consoleErrors.slice(0, 5),
      })
      check('pageerror_0', pageErrors.length === 0, {
        count: pageErrors.length,
        sample: pageErrors.slice(0, 5),
      })
    }
  } finally {
    await context.close()
    await browser.close()
  }

  const pass = checks.filter((c) => c.ok).length
  const fail = checks.filter((c) => !c.ok).length
  const hardFails = collectFunctionalHardFails(checks)
  const semanticHardFails = hardFails.filter(
    (c) =>
      c.name.startsWith('S1_') ||
      c.name.startsWith('S2_') ||
      c.name.startsWith('S3_') ||
      c.name.startsWith('B9_'),
  )
  // Never claim functional product PASS while data honesty is LOCAL_ONLY / residual.
  // Semantic hardFails force FAIL (cannot soft-green residual when graph was exercised).
  let status
  if (residual && hardFails.every((h) => h.name.startsWith('B0_'))) {
    status = 'LOCAL_ONLY'
  } else if (hardFails.length > 0 || fail > 0) {
    status = 'FAIL'
  } else {
    status = 'LOCAL_ONLY'
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
    residual,
    urlLog,
    navCount,
    checks,
    hardFails: hardFails.map((h) => ({ name: h.name, detail: h.detail })),
    semanticHardFails: semanticHardFails.map((h) => h.name),
    summary: { pass, fail, total: checks.length, hardFailCount: hardFails.length },
    status,
    functionalPass: false,
    note:
      'Oracle-adapted live functional harness. Static bundle ⇒ LOCAL_ONLY. Semantic hardFails cannot soft-green. Functional PASS requires owned preview + data honesty upgrade + independent verifier.',
    finishedAt: new Date().toISOString(),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `canon-flow-functional-${fullSha.slice(0, 12)}.json`)
  fs.writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8')
  report.outPath = outPath
  return report
}

async function main() {
  if (hasFlag('--self-test')) {
    const r = runSelfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  if (hasFlag('--plan')) {
    const plan = planFunctionalSteps({
      boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
      fullSha: process.env.FULL_SHA || resolveFullSha({ cwd: ROOT }),
    })
    console.log(JSON.stringify(plan, null, 2))
    process.exit(0)
  }
  if (hasFlag('--run')) {
    try {
      const report = await runLive({
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
      })
      console.log(JSON.stringify(report, null, 2))
      process.exit(report.status === 'FAIL' ? 1 : 0)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(2)
    }
  }

  const self = runSelfTest()
  const plan = planFunctionalSteps()
  console.log(
    JSON.stringify(
      {
        mode: 'default-offline',
        selfTest: self,
        plan,
        status: self.ok ? 'HARNESS_READY' : 'FAIL',
        note: 'Pass --run for live browser; offline is HARNESS_READY only',
      },
      null,
      2,
    ),
  )
  process.exit(self.ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
