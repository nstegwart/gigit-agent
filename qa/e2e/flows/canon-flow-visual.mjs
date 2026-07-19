#!/usr/bin/env node
/**
 * C-FLOW-VIS — SHA-bound candidate visual/responsive captures for canon flow.
 * Produces candidate PNGs + comparison inputs only. Does NOT bless/replace baselines.
 *
 * Modes:
 *   --self-test   pure matrix + FULL_SHA fail-closed contracts (no browser)
 *   --plan        emit capture plan JSON (requires resolvable FULL_SHA)
 *   --capture     live Playwright candidates against WEB_BASE + auth
 *   --compare-inputs  emit baseline/candidate path pairs for external compare (no write to baselines)
 *
 * Env: WEB_BASE, BOARD_ID, FULL_SHA (required for plan/capture/compare-inputs), HEADED,
 *      CAIRN_E2E_AUTH_STORAGE_PATH
 *
 * Fail-closed: missing/invalid FULL_SHA on evidence modes → non-zero exit.
 * Never auto-replaces baselines (autoReplaceForbidden: true).
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
  FULL_SHA_RE,
} from '../lib/env.mjs'
import { DEFAULT_BOARD, flowRoute as staticFlowRoute } from './canon-flow-static-fidelity.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'canon-flow-visual'
const OUT_SHOTS = path.resolve(__dirname, '../out/screenshots/canon-flow')
const OUT_RUNTIME = path.resolve(__dirname, '../out/runtime')
const OUT_BASELINES = path.resolve(__dirname, '../out/baselines/canon-flow')

export const TARGET_GATE = 'TM_CANON_V3_BROWSER_HARNESS_READY'
export const MAX_DIFF_PIXEL_RATIO = 0.002
export const AUTO_REPLACE_FORBIDDEN = true

export const VIEWPORTS = Object.freeze([
  { name: '390x844', width: 390, height: 844 },
  { name: '1440x900', width: 1440, height: 900 },
  { name: '2560x1300', width: 2560, height: 1300 },
])

export const VISUAL_STATES = Object.freeze([
  'cross-default',
  'project-rn',
  'sheet-open',
  'after-drag',
])

export function flowRoute(boardId = resolveBoardId(DEFAULT_BOARD)) {
  return staticFlowRoute(boardId)
}

/**
 * Fail-closed FULL_SHA for visual evidence.
 * @param {{ fullSha?: string, require?: boolean, cwd?: string }} [opts]
 */
export function requireVisualFullSha(opts = {}) {
  if (opts.fullSha != null) {
    if (!isFullSha(opts.fullSha)) {
      throw new Error(
        `VISUAL FAIL: FULL_SHA must be 40-char hex for visual evidence (got ${String(opts.fullSha)})`,
      )
    }
    return opts.fullSha.toLowerCase()
  }
  return assertFullSha({ cwd: opts.cwd ?? ROOT })
}

/**
 * Candidate capture plan bound to FULL_SHA. Never writes baselines.
 */
export function planVisualCaptures(opts = {}) {
  const fullSha = requireVisualFullSha({
    fullSha: opts.fullSha,
    cwd: opts.cwd ?? ROOT,
  })
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const capturedAt = opts.capturedAt ?? new Date().toISOString()
  const rows = []

  for (const state of VISUAL_STATES) {
    for (const vp of VIEWPORTS) {
      const file = `canon-flow__${state}__${vp.name}__dpr1__${fullSha.slice(0, 12)}.png`
      rows.push({
        state,
        viewport: vp.name,
        width: vp.width,
        height: vp.height,
        deviceScaleFactor: 1,
        route,
        fullSha,
        candidatePath: path.join(OUT_SHOTS, fullSha, file),
        candidateName: file,
        // comparison inputs only — baseline path for future reviewer-approved set
        baselinePath: path.join(OUT_BASELINES, fullSha, file),
        claim: 'PENDING_CAPTURE',
      })
    }
  }
  // At least one retina capture
  const retina = VIEWPORTS.find((v) => v.name === '1440x900')
  const retinaFile = `canon-flow__cross-default__${retina.name}__dpr2__${fullSha.slice(0, 12)}.png`
  rows.push({
    state: 'cross-default',
    viewport: retina.name,
    width: retina.width,
    height: retina.height,
    deviceScaleFactor: 2,
    route,
    fullSha,
    candidatePath: path.join(OUT_SHOTS, fullSha, retinaFile),
    candidateName: retinaFile,
    baselinePath: path.join(OUT_BASELINES, fullSha, retinaFile),
    claim: 'PENDING_CAPTURE',
  })

  return {
    schemaVersion: 'TM_CANON_FLOW_VISUAL_PLAN_V1',
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    fullSha,
    route,
    boardId,
    capturedAt,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    autoReplaceForbidden: AUTO_REPLACE_FORBIDDEN,
    baselineBlessForbidden: true,
    rowCount: rows.length,
    rows,
    requiredViewports: VIEWPORTS.map((v) => v.name),
    requiredStates: [...VISUAL_STATES],
    requiredRetina: true,
    note: 'Candidates only — do not bless/replace baselines without independent reviewer receipt',
  }
}

/**
 * Comparison input manifest (paths only; no pixel diff here).
 */
export function buildCompareInputs(opts = {}) {
  const plan = planVisualCaptures(opts)
  return {
    schemaVersion: 'TM_CANON_FLOW_VISUAL_COMPARE_INPUTS_V1',
    fullSha: plan.fullSha,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    autoReplaceForbidden: true,
    pairs: plan.rows.map((r) => ({
      state: r.state,
      viewport: r.viewport,
      deviceScaleFactor: r.deviceScaleFactor,
      candidatePath: r.candidatePath,
      baselinePath: r.baselinePath,
      route: r.route,
      claim: fs.existsSync(r.candidatePath)
        ? fs.existsSync(r.baselinePath)
          ? 'READY_TO_COMPARE'
          : 'PENDING_BASELINE'
        : 'PENDING_CAPTURE',
    })),
    note: 'External comparator may compute maxDiffPixelRatio; harness never auto-writes baselines',
  }
}

export function runSelfTest() {
  const failures = []
  const cases = {}

  if (VIEWPORTS.length !== 3) {
    failures.push('need 390/1440/2560')
    cases.viewports = 'FAIL'
  } else {
    cases.viewports = 'PASS'
  }
  if (!VIEWPORTS.some((v) => v.name === '2560x1300')) {
    failures.push('missing 2560x1300')
    cases.uw = 'FAIL'
  } else {
    cases.uw = 'PASS'
  }
  if (VISUAL_STATES.length < 4) {
    failures.push('states incomplete')
    cases.states = 'FAIL'
  } else {
    cases.states = 'PASS'
  }

  // FULL_SHA fail-closed
  let threw = false
  try {
    requireVisualFullSha({ fullSha: 'short' })
  } catch {
    threw = true
  }
  if (!threw) {
    failures.push('short FULL_SHA must throw')
    cases.shaFail = 'FAIL'
  } else {
    cases.shaFail = 'PASS'
  }

  const sha = 'c'.repeat(40)
  const plan = planVisualCaptures({ fullSha: sha, boardId: DEFAULT_BOARD })
  if (plan.fullSha !== sha) {
    failures.push('plan fullSha')
    cases.planSha = 'FAIL'
  } else {
    cases.planSha = 'PASS'
  }
  if (!plan.rows.some((r) => r.deviceScaleFactor === 2)) {
    failures.push('missing dpr=2')
    cases.dpr = 'FAIL'
  } else {
    cases.dpr = 'PASS'
  }
  if (plan.rowCount < 13) {
    // 4 states * 3 viewports + 1 retina = 13
    failures.push(`expected ≥13 rows, got ${plan.rowCount}`)
    cases.rowCount = 'FAIL'
  } else {
    cases.rowCount = 'PASS'
  }
  if (plan.autoReplaceForbidden !== true || plan.baselineBlessForbidden !== true) {
    failures.push('must forbid baseline bless/replace')
    cases.noBless = 'FAIL'
  } else {
    cases.noBless = 'PASS'
  }

  const inputs = buildCompareInputs({ fullSha: sha })
  if (inputs.pairs.length !== plan.rowCount) {
    failures.push('compare inputs length')
    cases.compare = 'FAIL'
  } else {
    cases.compare = 'PASS'
  }

  // UNKNOWN_SHA forbidden
  if (FULL_SHA_RE.test('UNKNOWN_SHA')) {
    failures.push('UNKNOWN_SHA must not match FULL_SHA_RE')
    cases.unknown = 'FAIL'
  } else {
    cases.unknown = 'PASS'
  }

  return {
    ok: failures.length === 0,
    mode: 'self-test',
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    cases,
    failures,
    status: failures.length === 0 ? 'HARNESS_READY' : 'FAIL',
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
 * Prepare page into a named visual state (best-effort).
 * @param {import('@playwright/test').Page} page
 * @param {string} state
 */
async function prepareState(page, state) {
  if (state === 'cross-default') {
    await page.locator('.flow-pill[data-mode="cross"]').click().catch(() => null)
    await page.waitForTimeout(300)
    return
  }
  if (state === 'project-rn') {
    await page.locator('.flow-pill[data-mode="rn"]').click().catch(() => null)
    await page.waitForTimeout(350)
    return
  }
  if (state === 'sheet-open') {
    await page.locator('.flow-pill[data-mode="cross"]').click().catch(() => null)
    await page.waitForTimeout(250)
    await page.locator('[data-testid="flow-node"], .fnode').first().click().catch(() => null)
    await page.waitForTimeout(350)
    return
  }
  if (state === 'after-drag') {
    await page.locator('.flow-pill[data-mode="cross"]').click().catch(() => null)
    await page.waitForTimeout(250)
    const box = await page.locator('[data-testid="flow-node"], .fnode').first().boundingBox()
    if (box) {
      const s = { x: box.x + box.width / 2, y: box.y + box.height / 2 }
      await page.mouse.move(s.x, s.y)
      await page.mouse.down()
      await page.mouse.move(s.x + 120, s.y, { steps: 10 })
      await page.mouse.up()
      await page.waitForTimeout(200)
    }
  }
}

/**
 * Capture candidates only (no baseline write).
 */
export async function runCapture(opts = {}) {
  const { chromium } = await import('@playwright/test')
  const fullSha = requireVisualFullSha({ fullSha: opts.fullSha, cwd: ROOT })
  const plan = planVisualCaptures({
    fullSha,
    boardId: opts.boardId ?? resolveBoardId(DEFAULT_BOARD),
    route: opts.route,
    capturedAt: new Date().toISOString(),
  })
  const base = opts.webBase ?? resolveWebBase()
  const headed = resolveHeaded()
  const route = plan.route

  printOwnerTarget({ flow: FLOW_NAME, route, mode: 'capture', fullSha })

  fs.mkdirSync(path.join(OUT_SHOTS, fullSha), { recursive: true })
  fs.mkdirSync(OUT_RUNTIME, { recursive: true })

  const browser = await chromium.launch({ headless: !headed })
  const storagePath = resolveStorageStatePath()
  let authMode = 'none'
  const contextOpts = { baseURL: base }
  if (fs.existsSync(storagePath)) {
    try {
      contextOpts.storageState = requireExistingStorageState(storagePath)
      authMode = 'storageState'
    } catch (e) {
      authMode = `invalid: ${String(e?.message || e)}`
    }
  }

  const results = []
  let residual = null

  try {
    // Group by DPR so we can recreate context for retina
    const byDpr = new Map()
    for (const row of plan.rows) {
      const k = row.deviceScaleFactor
      if (!byDpr.has(k)) byDpr.set(k, [])
      byDpr.get(k).push(row)
    }

    for (const [dpr, rows] of byDpr) {
      const context = await browser.newContext({
        ...contextOpts,
        viewport: { width: 1440, height: 900 },
        deviceScaleFactor: dpr,
      })
      const page = await context.newPage()
      await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 45_000 })
      const onAlur = /\/alur/.test(page.url()) && !/\/login/.test(page.url())
      if (!onAlur) {
        residual = {
          code: 'AUTH_OR_ROUTE',
          url: page.url(),
          authMode,
          note: 'Cannot capture product flow states without auth — candidates incomplete',
        }
        for (const row of rows) {
          results.push({
            ...row,
            ok: false,
            claim: 'PENDING_CAPTURE',
            error: residual.code,
          })
        }
        await context.close()
        continue
      }
      await page
        .locator('[data-testid="flow-ultimate"], [data-testid="flow-node"], .fnode')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => null)

      for (const row of rows) {
        await page.setViewportSize({ width: row.width, height: row.height })
        await prepareState(page, row.state)
        await page.waitForTimeout(250)
        fs.mkdirSync(path.dirname(row.candidatePath), { recursive: true })
        await page.screenshot({ path: row.candidatePath, fullPage: false })
        results.push({
          state: row.state,
          viewport: row.viewport,
          width: row.width,
          height: row.height,
          deviceScaleFactor: row.deviceScaleFactor,
          route: row.route,
          fullSha,
          candidatePath: row.candidatePath,
          baselinePath: row.baselinePath,
          claim: 'PENDING_BASELINE',
          ok: true,
          capturedAt: plan.capturedAt,
        })
        console.log('CANDIDATE', row.candidatePath)
      }
      await context.close()
    }
  } finally {
    await browser.close()
  }

  const manifest = {
    schemaVersion: 'TM_CANON_FLOW_VISUAL_MANIFEST_V1',
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    fullSha,
    route,
    boardId: plan.boardId,
    capturedAt: plan.capturedAt,
    authMode,
    residual,
    autoReplaceForbidden: true,
    baselineBlessForbidden: true,
    maxDiffPixelRatio: MAX_DIFF_PIXEL_RATIO,
    rows: results,
    summary: {
      planned: plan.rowCount,
      captured: results.filter((r) => r.ok).length,
      failed: results.filter((r) => !r.ok).length,
    },
    status: residual ? 'LOCAL_ONLY' : results.every((r) => r.ok) ? 'LOCAL_ONLY' : 'FAIL',
    note: 'Candidates + comparison inputs only — baselines not blessed',
  }

  const compare = buildCompareInputs({ fullSha, boardId: plan.boardId })
  // Refresh claim from disk after capture
  compare.pairs = compare.pairs.map((p) => {
    const hit = results.find(
      (r) =>
        r.candidatePath === p.candidatePath ||
        (r.state === p.state &&
          r.viewport === p.viewport &&
          r.deviceScaleFactor === p.deviceScaleFactor),
    )
    return {
      ...p,
      claim: hit?.ok
        ? fs.existsSync(p.baselinePath)
          ? 'READY_TO_COMPARE'
          : 'PENDING_BASELINE'
        : p.claim,
    }
  })

  const manPath = path.join(OUT_RUNTIME, `canon-flow-visual-manifest-${fullSha.slice(0, 12)}.json`)
  const cmpPath = path.join(OUT_RUNTIME, `canon-flow-visual-compare-inputs-${fullSha.slice(0, 12)}.json`)
  fs.writeFileSync(manPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  fs.writeFileSync(cmpPath, `${JSON.stringify(compare, null, 2)}\n`, 'utf8')
  manifest.manifestPath = manPath
  manifest.compareInputsPath = cmpPath
  return manifest
}

async function main() {
  if (hasFlag('--self-test')) {
    const r = runSelfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (hasFlag('--plan')) {
    try {
      // Fail closed without FULL_SHA
      const fullSha = process.env.FULL_SHA?.trim()
        ? requireVisualFullSha({ fullSha: process.env.FULL_SHA })
        : requireVisualFullSha({ cwd: ROOT })
      const plan = planVisualCaptures({
        fullSha,
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
      })
      console.log(JSON.stringify(plan, null, 2))
      process.exit(0)
    } catch (e) {
      console.error(String(e?.message || e))
      process.exit(2)
    }
  }

  if (hasFlag('--compare-inputs')) {
    try {
      const fullSha = process.env.FULL_SHA?.trim()
        ? requireVisualFullSha({ fullSha: process.env.FULL_SHA })
        : requireVisualFullSha({ cwd: ROOT })
      const inputs = buildCompareInputs({
        fullSha,
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
      })
      console.log(JSON.stringify(inputs, null, 2))
      process.exit(0)
    } catch (e) {
      console.error(String(e?.message || e))
      process.exit(2)
    }
  }

  if (hasFlag('--capture')) {
    try {
      const fullSha = process.env.FULL_SHA?.trim()
        ? requireVisualFullSha({ fullSha: process.env.FULL_SHA })
        : requireVisualFullSha({ cwd: ROOT })
      const man = await runCapture({
        fullSha,
        boardId: arg('--board', resolveBoardId(DEFAULT_BOARD)),
      })
      console.log(JSON.stringify(man, null, 2))
      process.exit(man.status === 'FAIL' ? 1 : 0)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(2)
    }
  }

  // Default offline
  const self = runSelfTest()
  let plan = null
  let planError = null
  try {
    const sha = resolveFullSha({ cwd: ROOT })
    if (isFullSha(sha)) {
      plan = planVisualCaptures({ fullSha: sha })
    } else {
      planError = 'FULL_SHA unresolved — plan skipped (fail-closed for evidence)'
    }
  } catch (e) {
    planError = String(e?.message || e)
  }
  console.log(
    JSON.stringify(
      {
        mode: 'default-offline',
        selfTest: self,
        plan,
        planError,
        status: self.ok ? 'HARNESS_READY' : 'FAIL',
        note: 'Pass --capture for candidates; baselines never auto-blessed',
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
