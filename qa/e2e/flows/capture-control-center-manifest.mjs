#!/usr/bin/env node
/**
 * Deterministic screenshot-manifest runner for control-center routes/states/viewports.
 *
 * After functionality deploy: plan the full capture matrix, optionally capture with
 * Playwright, and write a UI_CONTRACT §13 screenshot manifest with required pin fields.
 *
 * Modes:
 *   --self-test   (default) pure plan + row contract — no browser / no network
 *   --plan        emit planned matrix + dry rows (no browser)
 *   --capture     live Playwright capture (requires WEB_BASE + auth storage)
 *
 * Env (capture / claimed runs):
 *   WEB_BASE, STAGING_URL, FULL_SHA, BOARD_ID, HEADED
 *   CANONICAL_SNAPSHOT_ID, CANONICAL_HASH, BOARD_REV, LIFECYCLE_REV
 *     (all four pin fields required for claimed capture; never fabricated)
 *
 * Rules:
 *   - Viewports: 1440x900, 1024x768, 390x844, 360x800 + 200% zoom on core routes
 *   - Every row: route, state, viewport|zoom, stagingUrl, fullSha, schemaVersion,
 *     canonicalSnapshotId, canonicalHash, boardRev, lifecycleRev, accessibilityResult,
 *     missionQuestionLink, visualDiff metadata
 *   - NEVER claim visual PASS without a real screenshot file on disk
 *   - Self-test only does not prove staging visual quality
 *
 * Usage:
 *   node qa/e2e/flows/capture-control-center-manifest.mjs --self-test
 *   node qa/e2e/flows/capture-control-center-manifest.mjs --plan
 *   STAGING_URL=… FULL_SHA=… CANONICAL_SNAPSHOT_ID=… CANONICAL_HASH=… \
 *     BOARD_REV=… LIFECYCLE_REV=… node qa/e2e/flows/capture-control-center-manifest.mjs --capture
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'
import { runAxe } from '../lib/axe.mjs'
import {
  assertFullSha,
  isFullSha,
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveSchemaVersion,
  resolveStagingUrl,
  resolveWebBase,
} from '../lib/env.mjs'
import { VIEWPORTS } from '../lib/overflow.mjs'
import {
  accountCaptureCounts,
  assertPlannedCaptureContract,
  EXPECTED_PLANNED_CAPTURES_MFS,
  planCaptures,
  VIEWPORT_ORDER,
} from '../lib/routes-matrix.mjs'
import {
  DEFAULT_MANIFEST_PATH,
  DEFAULT_SCHEMA_PATH,
  PIN_MISSING,
  ScreenshotManifestCollector,
  validateManifestRow,
} from '../lib/screenshot-manifest.mjs'
import { setPageZoom, resetPageZoom } from '../lib/zoom.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'capture-control-center-manifest'
const DEFAULT_BOARD = 'mfs-rebuild'

/** Required UI_CONTRACT §11 viewports (order fixed). */
export const REQUIRED_VIEWPORTS = Object.freeze([...VIEWPORT_ORDER])

/** Core zoom contract. */
export const REQUIRED_ZOOM = '200%'

/** Visual claim tokens — PASS only with on-disk screenshot proof. */
export const VISUAL_CLAIMS = Object.freeze({
  NOT_RUN: 'NOT_RUN',
  PENDING_CAPTURE: 'PENDING_CAPTURE',
  DIFF_PENDING: 'DIFF_PENDING',
  FAIL: 'FAIL',
  PASS: 'PASS',
})

const PIN_ENV_KEYS = [
  'CANONICAL_SNAPSHOT_ID',
  'CANONICAL_HASH',
  'BOARD_REV',
  'LIFECYCLE_REV',
]

/**
 * @param {string} name
 * @param {string|null} [fallback]
 */
function arg(name, fallback = null) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) {
    return process.argv[i + 1]
  }
  return fallback
}

function hasFlag(name) {
  return process.argv.includes(name)
}

/**
 * Resolve pin tuple from env or explicit input. Never fabricates values.
 * @param {{
 *   requirePresent?: boolean,
 *   pins?: {
 *     canonicalSnapshotId?: string,
 *     canonicalHash?: string,
 *     boardRev?: string|number,
 *     lifecycleRev?: string|number,
 *   },
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 */
export function resolveRunPins(opts = {}) {
  const env = opts.env ?? process.env
  const input = opts.pins ?? {}
  const fromEnv = {
    canonicalSnapshotId: env.CANONICAL_SNAPSHOT_ID?.trim() || undefined,
    canonicalHash: env.CANONICAL_HASH?.trim() || undefined,
    boardRev: env.BOARD_REV?.trim() || undefined,
    lifecycleRev: env.LIFECYCLE_REV?.trim() || undefined,
  }
  const merged = {
    canonicalSnapshotId: String(
      input.canonicalSnapshotId ?? fromEnv.canonicalSnapshotId ?? PIN_MISSING,
    ),
    canonicalHash: String(input.canonicalHash ?? fromEnv.canonicalHash ?? PIN_MISSING),
    boardRev: String(input.boardRev ?? fromEnv.boardRev ?? PIN_MISSING),
    lifecycleRev: String(input.lifecycleRev ?? fromEnv.lifecycleRev ?? PIN_MISSING),
  }
  const present = Object.values(merged).every((v) => v && v !== PIN_MISSING)
  if (opts.requirePresent && !present) {
    const missing = [
      !merged.canonicalSnapshotId || merged.canonicalSnapshotId === PIN_MISSING
        ? 'CANONICAL_SNAPSHOT_ID'
        : null,
      !merged.canonicalHash || merged.canonicalHash === PIN_MISSING ? 'CANONICAL_HASH' : null,
      !merged.boardRev || merged.boardRev === PIN_MISSING ? 'BOARD_REV' : null,
      !merged.lifecycleRev || merged.lifecycleRev === PIN_MISSING ? 'LIFECYCLE_REV' : null,
    ].filter(Boolean)
    throw new Error(
      `HARNESS FAIL: claimed capture requires pin fields PRESENT (missing: ${missing.join(', ')}). Never fabricate pins.`,
    )
  }
  return {
    ...merged,
    pinFields: present ? 'PRESENT' : 'MISSING',
    present,
  }
}

/**
 * Build visual-diff metadata object. PASS is refused without a real screenshot file.
 * @param {{
 *   claim?: string,
 *   screenshotPath?: string|null,
 *   baselinePath?: string|null,
 *   maxDiffPixelRatio?: number,
 *   note?: string,
 *   fsExists?: (p: string) => boolean,
 * }} input
 */
export function buildVisualDiffMetadata(input = {}) {
  const exists = input.fsExists ?? ((p) => fs.existsSync(p))
  const screenshotPath = input.screenshotPath || null
  const baselinePath = input.baselinePath || null
  let claim = input.claim || VISUAL_CLAIMS.NOT_RUN

  const shotOk = Boolean(screenshotPath && exists(screenshotPath))
  if (claim === VISUAL_CLAIMS.PASS) {
    if (!shotOk) {
      throw new Error(
        'VISUAL_CLAIM FAIL: cannot claim visual PASS without an on-disk screenshotPath',
      )
    }
    if (!baselinePath || !exists(baselinePath)) {
      throw new Error(
        'VISUAL_CLAIM FAIL: cannot claim visual PASS without an on-disk baselinePath',
      )
    }
  }

  if (!screenshotPath) {
    if (claim === VISUAL_CLAIMS.PASS || claim === VISUAL_CLAIMS.DIFF_PENDING) {
      claim = VISUAL_CLAIMS.PENDING_CAPTURE
    }
  } else if (!shotOk && claim === VISUAL_CLAIMS.PASS) {
    claim = VISUAL_CLAIMS.FAIL
  }

  return {
    claim,
    screenshotPath,
    baselinePath,
    maxDiffPixelRatio: input.maxDiffPixelRatio ?? 0.002,
    note:
      input.note ||
      (claim === VISUAL_CLAIMS.PASS
        ? 'pixel diff accepted against baseline'
        : claim === VISUAL_CLAIMS.PENDING_CAPTURE
          ? 'NOT_CLAIMED: no screenshot'
          : claim === VISUAL_CLAIMS.NOT_RUN
            ? 'visual comparison not executed'
            : 'visual claim recorded'),
    shippableVisual: claim === VISUAL_CLAIMS.PASS,
  }
}

/**
 * Serialize visual-diff metadata for the manifest string field (UI_CONTRACT §13).
 * Prefer writing a JSON sidecar and storing its path; fall back to a status token.
 * @param {ReturnType<typeof buildVisualDiffMetadata>} meta
 * @param {{ outPath?: string|null }} [opts]
 */
export function serializeVisualDiff(meta, opts = {}) {
  if (opts.outPath) {
    fs.mkdirSync(path.dirname(opts.outPath), { recursive: true })
    fs.writeFileSync(opts.outPath, JSON.stringify(meta, null, 2), 'utf8')
    return opts.outPath
  }
  if (meta.claim === VISUAL_CLAIMS.PASS && meta.screenshotPath) {
    return meta.screenshotPath
  }
  return `${meta.claim}: ${meta.note}`
}

/**
 * Assert a row (or visualDiff string) never claims PASS without screenshot evidence.
 * @param {{ screenshotPath?: string|null, visualDiff?: string|null }} row
 * @param {{ fsExists?: (p: string) => boolean }} [opts]
 */
export function assertNoVisualPassWithoutScreenshot(row, opts = {}) {
  const exists = opts.fsExists ?? ((p) => fs.existsSync(p))
  const vd = row.visualDiff == null ? '' : String(row.visualDiff)
  const claimsPass =
    /\bPASS\b/.test(vd) ||
    (vd.endsWith('.json') && exists(vd) && /"claim"\s*:\s*"PASS"/.test(fs.readFileSync(vd, 'utf8')))

  if (!claimsPass) return { ok: true, claimPass: false }

  const shot = row.screenshotPath
  if (!shot || !exists(shot)) {
    throw new Error(
      `VISUAL_CLAIM FAIL: visualDiff claims PASS but screenshot missing (path=${shot || 'null'})`,
    )
  }
  return { ok: true, claimPass: true, screenshotPath: shot }
}

/**
 * Build one planned capture descriptor (no I/O).
 * @param {{
 *   item: { kind: string, route: object, vp: string, id: string },
 *   stagingUrl: string,
 *   fullSha: string,
 *   schemaVersion: string,
 *   pins: ReturnType<typeof resolveRunPins>,
 *   runId: string,
 *   outRoot?: string,
 * }} args
 */
export function planItemToRowInput(args) {
  const { item, stagingUrl, fullSha, schemaVersion, pins, runId, outRoot } = args
  const r = item.route
  const isZoom = item.kind === 'zoom200'
  const id = item.id
  const axePath = outRoot
    ? path.join(outRoot, 'axe', `${id}.json`)
    : `qa/e2e/out/axe/${id}.json`
  const shotPath = outRoot
    ? path.join(outRoot, 'screenshots', `${id}.png`)
    : `qa/e2e/out/screenshots/${id}.png`
  const visualMeta = buildVisualDiffMetadata({
    claim: VISUAL_CLAIMS.PENDING_CAPTURE,
    screenshotPath: null,
    note: 'NOT_CLAIMED: no screenshot (plan-only row)',
  })

  return {
    route: r.path,
    state: r.state,
    viewport: isZoom ? undefined : item.vp,
    zoom: isZoom ? REQUIRED_ZOOM : undefined,
    browserTestId: id,
    serverTestId: runId,
    runId,
    accessibilityResult: axePath,
    missionQuestionLink: r.mission ?? null,
    visualDiff: serializeVisualDiff(visualMeta),
    screenshotPath: undefined,
    stagingUrl,
    fullSha,
    schemaVersion,
    captureMode: isZoom ? 'zoom-200' : 'viewport',
    pins: {
      canonicalSnapshotId: pins.canonicalSnapshotId,
      canonicalHash: pins.canonicalHash,
      boardRev: pins.boardRev,
      lifecycleRev: pins.lifecycleRev,
    },
    // planning metadata (not written to collector unless capture completes)
    _plan: {
      id,
      kind: item.kind,
      label: r.label,
      core: Boolean(r.core),
      vp: item.vp,
      plannedScreenshotPath: shotPath,
      mission: r.mission ?? null,
    },
  }
}

/**
 * Expand full ordered plan into row inputs for the board.
 * @param {{
 *   boardId?: string,
 *   stagingUrl?: string,
 *   fullSha?: string,
 *   schemaVersion?: string,
 *   pins?: object,
 *   requirePinsPresent?: boolean,
 *   runId?: string,
 *   outRoot?: string,
 *   env?: NodeJS.ProcessEnv,
 * }} [opts]
 */
export function buildPlannedManifestRows(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const stagingUrl = opts.stagingUrl ?? resolveStagingUrl()
  const schemaVersion = opts.schemaVersion ?? resolveSchemaVersion()
  const fullSha =
    opts.fullSha ??
    (opts.requirePinsPresent
      ? assertFullSha({ cwd: ROOT })
      : resolveFullSha({ cwd: ROOT }))
  if (opts.requirePinsPresent && !isFullSha(fullSha)) {
    throw new Error('HARNESS FAIL: fullSha must be 40-char hex for claimed runs')
  }
  if (!stagingUrl || !String(stagingUrl).trim()) {
    throw new Error('HARNESS FAIL: stagingUrl/WEB_BASE required')
  }

  const pins = resolveRunPins({
    pins: opts.pins,
    requirePresent: opts.requirePinsPresent === true,
    env: opts.env,
  })
  const runId =
    opts.runId ??
    `cc-manifest-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  const plan = planCaptures(boardId)
  const contract = assertPlannedCaptureContract(boardId)

  const rows = plan.map((item) =>
    planItemToRowInput({
      item,
      stagingUrl,
      fullSha,
      schemaVersion,
      pins,
      runId,
      outRoot: opts.outRoot,
    }),
  )

  return {
    boardId,
    runId,
    stagingUrl,
    fullSha,
    schemaVersion,
    pins,
    contract,
    plan,
    plannedCount: plan.length,
    rows,
    viewports: REQUIRED_VIEWPORTS,
    zoom: REQUIRED_ZOOM,
  }
}

/**
 * Materialize collector rows from planned inputs (plan mode / self-test).
 * Does not attach screenshotPath (honest plan-only).
 * @param {ReturnType<typeof buildPlannedManifestRows>} planned
 */
export function materializePlanCollector(planned) {
  const collector = new ScreenshotManifestCollector({
    runId: planned.runId,
    version: 1,
  })
  collector.clear()
  for (const input of planned.rows) {
    const { _plan, ...rowInput } = input
    void _plan
    collector.add(rowInput)
  }
  return collector
}

/**
 * Validate a completed capture set: every planned id accounted, pins present when required,
 * no visual PASS without screenshots.
 * @param {{
 *   planned: ReturnType<typeof buildPlannedManifestRows>,
 *   capturedIds?: string[],
 *   skippedIds?: string[],
 *   errorIds?: string[],
 *   rows?: object[],
 *   requirePinsPresent?: boolean,
 *   fsExists?: (p: string) => boolean,
 * }} args
 */
export function validateCaptureManifest(args) {
  const errors = []
  const planned = args.planned
  const book = accountCaptureCounts({
    planned: planned.plannedCount,
    captured: args.capturedIds ?? [],
    skipped: args.skippedIds ?? [],
    error: args.errorIds ?? [],
  })
  if (!book.consistent) {
    errors.push(`bookkeeping inconsistent: ${JSON.stringify(book)}`)
  }

  if (args.requirePinsPresent && !planned.pins.present) {
    errors.push('pins MISSING on claimed capture run')
  }
  if (args.requirePinsPresent && !isFullSha(planned.fullSha)) {
    errors.push(`fullSha not 40-char hex: ${planned.fullSha}`)
  }
  if (!planned.stagingUrl) errors.push('stagingUrl empty')
  if (!planned.schemaVersion) errors.push('schemaVersion empty')

  for (const vp of REQUIRED_VIEWPORTS) {
    if (!VIEWPORTS[vp]) errors.push(`viewport table missing ${vp}`)
  }

  const rows = args.rows ?? []
  for (const row of rows) {
    const ve = validateManifestRow(row)
    if (ve.length) errors.push(`${row.browserTestId}: ${ve.join('; ')}`)
    try {
      assertNoVisualPassWithoutScreenshot(row, { fsExists: args.fsExists })
    } catch (e) {
      errors.push(String(e?.message || e))
    }
  }

  // Mission coverage: Q1–Q8 each appear ≥ once in plan
  const missions = new Set(
    planned.rows.map((r) => r.missionQuestionLink).filter((m) => m != null),
  )
  for (const q of ['Q1', 'Q2', 'Q3', 'Q4', 'Q5', 'Q6', 'Q7', 'Q8']) {
    if (!missions.has(q)) errors.push(`mission ${q} missing from plan`)
  }

  // Core zoom rows present
  const zoomRows = planned.rows.filter((r) => r.zoom === REQUIRED_ZOOM)
  if (zoomRows.length < 1) errors.push('no 200% zoom rows in plan')
  const coreZoomOk = zoomRows.every((r) => r._plan?.core === true)
  if (!coreZoomOk) errors.push('non-core route present in zoom plan')

  return {
    ok: errors.length === 0,
    errors,
    bookkeeping: book,
    plannedCount: planned.plannedCount,
    rowCount: rows.length,
    missions: [...missions].sort(),
    zoomRowCount: zoomRows.length,
  }
}

/**
 * Pure self-test (no browser, no network, no writes to default manifest path).
 * Uses PRESENT fixture pins + real git SHA so field shape matches claimed runs.
 */
export function selfTest() {
  const checks = {}
  const detail = {}

  // 1) viewport table
  checks.viewportsExact =
    REQUIRED_VIEWPORTS.length === 4 &&
    REQUIRED_VIEWPORTS[0] === '1440x900' &&
    REQUIRED_VIEWPORTS[1] === '1024x768' &&
    REQUIRED_VIEWPORTS[2] === '390x844' &&
    REQUIRED_VIEWPORTS[3] === '360x800' &&
    VIEWPORTS['1440x900']?.width === 1440 &&
    VIEWPORTS['360x800']?.height === 800

  // 2) plan contract = 53
  const contract = assertPlannedCaptureContract(DEFAULT_BOARD)
  checks.plannedExact53 =
    contract.planned === EXPECTED_PLANNED_CAPTURES_MFS && contract.planned === 53
  detail.planned = contract.planned

  // 3) pins: missing refused when requirePresent
  let pinRefuseOk = false
  try {
    resolveRunPins({
      requirePresent: true,
      env: {},
      pins: {},
    })
  } catch (e) {
    pinRefuseOk = String(e.message).includes('CANONICAL_SNAPSHOT_ID')
  }
  checks.pinRequireRefusesMissing = pinRefuseOk

  const fixturePins = {
    canonicalSnapshotId: 'synth-cc-manifest-snap-001',
    canonicalHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab',
    boardRev: '7',
    lifecycleRev: '3',
  }
  const pins = resolveRunPins({ pins: fixturePins, requirePresent: true, env: {} })
  checks.pinPresent = pins.present && pins.pinFields === 'PRESENT'

  // 4) full SHA resolve (soft if git unavailable — still prefer real HEAD)
  const sha = resolveFullSha({ cwd: ROOT })
  checks.fullShaShape = isFullSha(sha) || sha === 'UNKNOWN_SHA'
  detail.fullSha = sha

  const stagingUrl =
    process.env.STAGING_URL?.trim() ||
    process.env.WEB_BASE?.trim() ||
    'http://127.0.0.1:3210'
  const schemaVersion = resolveSchemaVersion()
  checks.schemaVersion = schemaVersion === 'TM_UI_CONTRACT_V1' || schemaVersion.length > 0

  // 5) build full planned rows with PRESENT pins
  const planned = buildPlannedManifestRows({
    boardId: DEFAULT_BOARD,
    stagingUrl,
    fullSha: isFullSha(sha) ? sha : 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
    schemaVersion,
    pins: fixturePins,
    requirePinsPresent: true,
    runId: 'self-test-cc-manifest',
    env: {},
  })
  checks.rowCount53 = planned.rows.length === 53
  detail.rowCount = planned.rows.length

  const collector = materializePlanCollector(planned)
  checks.collectorRows53 = collector.rows.length === 53
  checks.allPinsPresent = collector.rows.every((r) => r.pinFields === 'PRESENT')
  checks.allHaveStaging = collector.rows.every((r) => r.stagingUrl === stagingUrl)
  checks.allHaveSha = collector.rows.every((r) => isFullSha(r.fullSha))
  checks.allHaveSchema = collector.rows.every((r) => r.schemaVersion === schemaVersion)
  checks.allHaveA11y = collector.rows.every(
    (r) => typeof r.accessibilityResult === 'string' && r.accessibilityResult.length > 0,
  )
  checks.allHaveVisualDiff = collector.rows.every(
    (r) => typeof r.visualDiff === 'string' && r.visualDiff.includes('NOT_CLAIMED'),
  )
  checks.noScreenshotOnPlan = collector.rows.every((r) => !r.screenshotPath)

  // 6) validation of plan rows
  const validated = validateCaptureManifest({
    planned,
    capturedIds: [],
    skippedIds: planned.rows.map((r) => r.browserTestId),
    errorIds: [],
    rows: collector.rows,
    requirePinsPresent: true,
  })
  checks.validatePlanOk = validated.ok
  detail.validateErrors = validated.errors
  checks.missionsQ1toQ8 = validated.missions.length === 8
  checks.zoomCoreCount = validated.zoomRowCount === 5

  // 7) visual PASS without screenshot must throw
  let visualPassBlocked = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      screenshotPath: null,
    })
  } catch (e) {
    visualPassBlocked = String(e.message).includes('without an on-disk screenshotPath')
  }
  checks.visualPassBlockedNoShot = visualPassBlocked

  let visualPassBlockedMissingFile = false
  try {
    buildVisualDiffMetadata({
      claim: VISUAL_CLAIMS.PASS,
      screenshotPath: '/tmp/__no_such_screenshot_cc_manifest__.png',
      baselinePath: '/tmp/__no_such_baseline_cc_manifest__.png',
      fsExists: () => false,
    })
  } catch (e) {
    visualPassBlockedMissingFile = String(e.message).includes('without an on-disk screenshotPath')
  }
  checks.visualPassBlockedMissingFile = visualPassBlockedMissingFile

  // 8) PASS allowed only when both files exist (mock exists)
  const okMeta = buildVisualDiffMetadata({
    claim: VISUAL_CLAIMS.PASS,
    screenshotPath: '/mock/shot.png',
    baselinePath: '/mock/base.png',
    fsExists: () => true,
  })
  checks.visualPassAllowedWithFiles =
    okMeta.claim === VISUAL_CLAIMS.PASS && okMeta.shippableVisual === true

  // 9) assertNoVisualPassWithoutScreenshot on row with PASS token + no file
  let rowPassBlocked = false
  try {
    assertNoVisualPassWithoutScreenshot(
      {
        visualDiff: 'PASS: fabricated',
        screenshotPath: null,
      },
      { fsExists: () => false },
    )
  } catch (e) {
    rowPassBlocked = String(e.message).includes('screenshot missing')
  }
  checks.rowVisualPassBlocked = rowPassBlocked

  // 10) bookkeeping honesty
  const balanced = accountCaptureCounts({
    planned: 53,
    captured: 50,
    skipped: 2,
    error: 1,
  })
  checks.bookkeepingBalanced = balanced.consistent === true
  const dishonest = accountCaptureCounts({
    planned: 53,
    captured: 40,
    skipped: 0,
    error: 0,
  })
  checks.bookkeepingDetectsGap = dishonest.consistent === false

  // 11) schema file present (path exists)
  checks.schemaFileExists = fs.existsSync(DEFAULT_SCHEMA_PATH)
  detail.schemaPath = DEFAULT_SCHEMA_PATH

  // 12) each required viewport appears in plan
  const vpSet = new Set(
    planned.rows.filter((r) => r.viewport).map((r) => r.viewport),
  )
  checks.allViewportsInPlan = REQUIRED_VIEWPORTS.every((vp) => vpSet.has(vp))
  detail.viewportsInPlan = [...vpSet]

  // 13) route/state present on every row
  checks.routeStateAlways =
    collector.rows.every((r) => r.route && r.state) &&
    planned.rows.some((r) => r.state === 'populated') &&
    planned.rows.some((r) => r.state === 'needs-human')

  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    mode: 'self-test',
    flow: FLOW_NAME,
    checks,
    detail,
    residual_gaps: ok
      ? 'none for pure contract; live --capture not exercised this session'
      : Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(','),
    NOT_SHIPPABLE: 'no visual proof (self-test only)',
  }
}

/**
 * Plan-only CLI: write manifest with PENDING visual claims (no screenshots).
 * @param {{ outManifest?: string, boardId?: string }} [opts]
 */
export function runPlan(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const requirePins = hasFlag('--require-pins')
  const pins = requirePins
    ? resolveRunPins({ requirePresent: true })
    : resolveRunPins({ requirePresent: false })

  const planned = buildPlannedManifestRows({
    boardId,
    requirePinsPresent: requirePins,
    pins: requirePins
      ? {
          canonicalSnapshotId: pins.canonicalSnapshotId,
          canonicalHash: pins.canonicalHash,
          boardRev: pins.boardRev,
          lifecycleRev: pins.lifecycleRev,
        }
      : undefined,
  })
  const collector = materializePlanCollector(planned)
  const outPath =
    opts.outManifest ||
    arg('--out', path.join(ROOT, 'qa/e2e/out/runtime', planned.runId, 'SCREENSHOT_MANIFEST.json'))
  collector.write(outPath)

  const summary = {
    mode: 'plan',
    flow: FLOW_NAME,
    manifest: outPath,
    plannedCount: planned.plannedCount,
    rowCount: collector.rows.length,
    stagingUrl: planned.stagingUrl,
    fullSha: planned.fullSha,
    schemaVersion: planned.schemaVersion,
    pinFields: planned.pins.pinFields,
    viewports: REQUIRED_VIEWPORTS,
    zoom: REQUIRED_ZOOM,
    missions: [
      ...new Set(collector.rows.map((r) => r.missionQuestionLink).filter(Boolean)),
    ].sort(),
    note: 'Plan-only: visualDiff=PENDING_CAPTURE; no screenshots written; never claim visual PASS',
    NOT_SHIPPABLE: 'no visual proof',
  }
  return summary
}

/**
 * Live capture path — requires browser + pins PRESENT + full SHA.
 * Not invoked by default self-test.
 */
export async function runCapture(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const headed = resolveHeaded()
  const fullSha = assertFullSha({ cwd: ROOT })
  const stagingUrl = resolveStagingUrl()
  const schemaVersion = resolveSchemaVersion()
  const pins = resolveRunPins({ requirePresent: true })
  const runId =
    opts.runId ??
    `cc-manifest-cap-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  const outRoot =
    opts.outRoot ?? path.join(ROOT, 'qa/e2e/out/runtime', runId)
  fs.mkdirSync(path.join(outRoot, 'screenshots'), { recursive: true })
  fs.mkdirSync(path.join(outRoot, 'axe'), { recursive: true })
  fs.mkdirSync(path.join(outRoot, 'visual-diff'), { recursive: true })

  printOwnerTarget({
    flow: FLOW_NAME,
    mode: 'capture',
    boardId,
    stagingUrl,
    fullSha,
  })

  const planned = buildPlannedManifestRows({
    boardId,
    stagingUrl,
    fullSha,
    schemaVersion,
    pins: {
      canonicalSnapshotId: pins.canonicalSnapshotId,
      canonicalHash: pins.canonicalHash,
      boardRev: pins.boardRev,
      lifecycleRev: pins.lifecycleRev,
    },
    requirePinsPresent: true,
    runId,
    outRoot,
  })

  // Dynamic import so --self-test never loads Playwright.
  const { chromium } = await import('@playwright/test')
  const browser = await chromium.launch({ headless: !headed })
  const collector = new ScreenshotManifestCollector({ runId, version: 1 })
  collector.clear()
  const capturedIds = []
  const errorIds = []

  try {
    const storage = requireExistingStorageState(
      opts.storageStatePath ?? AUTH_STORAGE_STATE_PATH,
    )
    const context = await browser.newContext({
      baseURL: resolveWebBase(),
      viewport: VIEWPORTS['1440x900'],
      storageState: storage,
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()

    for (const input of planned.rows) {
      const planMeta = input._plan
      const id = planMeta.id
      const isZoom = planMeta.kind === 'zoom200'
      try {
        const size = VIEWPORTS[planMeta.vp] || VIEWPORTS['1440x900']
        await page.setViewportSize(size)
        await page.goto(input.route, { waitUntil: 'domcontentloaded', timeout: 60_000 })
        if (isZoom) {
          await setPageZoom(page, 2)
        }
        const shotPath = planMeta.plannedScreenshotPath
        await page.screenshot({ path: shotPath, fullPage: false })
        if (isZoom) await resetPageZoom(page)

        const axe = await runAxe(page, {
          outPath: path.join(outRoot, 'axe', `${id}.json`),
          browserTestId: id,
        })

        const visualMeta = buildVisualDiffMetadata({
          claim: VISUAL_CLAIMS.DIFF_PENDING,
          screenshotPath: shotPath,
          baselinePath: null,
          note: 'screenshot captured; baseline/pixel-diff not run — do not claim visual PASS',
        })
        const visualPath = path.join(outRoot, 'visual-diff', `${id}.json`)
        const visualDiff = serializeVisualDiff(visualMeta, { outPath: visualPath })

        collector.add({
          route: input.route,
          state: input.state,
          viewport: input.viewport,
          zoom: input.zoom,
          browserTestId: id,
          serverTestId: runId,
          runId,
          accessibilityResult: axe.rawPath || path.join(outRoot, 'axe', `${id}.json`),
          missionQuestionLink: input.missionQuestionLink,
          visualDiff,
          screenshotPath: shotPath,
          stagingUrl,
          fullSha,
          schemaVersion,
          pins: {
            canonicalSnapshotId: pins.canonicalSnapshotId,
            canonicalHash: pins.canonicalHash,
            boardRev: pins.boardRev,
            lifecycleRev: pins.lifecycleRev,
          },
          width: size.width,
          height: size.height,
          captureMode: isZoom ? 'zoom-200' : 'viewport',
        })
        assertNoVisualPassWithoutScreenshot(collector.rows[collector.rows.length - 1])
        capturedIds.push(id)
        console.log(`OK capture ${id} route=${input.route}`)
      } catch (e) {
        errorIds.push(id)
        console.error(`FAIL capture ${id}: ${String(e?.stack || e)}`)
      }
    }

    await context.close()
  } finally {
    await browser.close()
  }

  const book = accountCaptureCounts({
    planned: planned.plannedCount,
    captured: capturedIds,
    skipped: 0,
    error: errorIds,
  })
  const manifestPath = path.join(outRoot, 'SCREENSHOT_MANIFEST.json')
  collector.write(manifestPath)
  // Optional publish to latest only when fully consistent and pins present
  if (book.consistent && errorIds.length === 0 && pins.present) {
    collector.write(DEFAULT_MANIFEST_PATH)
  }

  const summary = {
    mode: 'capture',
    flow: FLOW_NAME,
    ok: book.consistent && errorIds.length === 0,
    manifest: manifestPath,
    latestPublished: book.consistent && errorIds.length === 0,
    bookkeeping: book,
    stagingUrl,
    fullSha,
    schemaVersion,
    pinFields: pins.pinFields,
    captured: capturedIds.length,
    errors: errorIds,
    note:
      errorIds.length === 0
        ? 'captures complete; visualDiff=DIFF_PENDING (not PASS — no baseline compare)'
        : 'incomplete matrix — do not claim visual PASS',
    NOT_SHIPPABLE:
      errorIds.length === 0
        ? 'screenshots exist but visual PASS not claimed without baseline diff'
        : 'capture errors — incomplete',
  }
  return summary
}

async function main() {
  const selfTestMode = hasFlag('--self-test') || (!hasFlag('--capture') && !hasFlag('--plan'))
  const planMode = hasFlag('--plan')
  const captureMode = hasFlag('--capture')

  if (selfTestMode && !captureMode && !planMode) {
    printOwnerTarget({
      flow: FLOW_NAME,
      mode: 'self-test',
      base_url: 'n/a-self-test',
    })
    const r = selfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (planMode) {
    printOwnerTarget({ flow: FLOW_NAME, mode: 'plan' })
    const summary = runPlan()
    console.log(JSON.stringify(summary, null, 2))
    process.exit(0)
  }

  if (captureMode) {
    try {
      const summary = await runCapture()
      console.log(JSON.stringify(summary, null, 2))
      process.exit(summary.ok ? 0 : 1)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(1)
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
