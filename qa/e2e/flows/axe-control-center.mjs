#!/usr/bin/env node
/**
 * Axe WCAG harness for control-center ART S01–S24 surfaces (AC-UI-06 / 01B RELEASE-BLOCKING).
 *
 * Modes:
 *   --self-test   (default) pure plan + gate contract — no browser / no network
 *   --plan        emit planned axe matrix JSON (no browser)
 *   --run         live Playwright + axe (requires WEB_BASE + auth for protected routes)
 *
 * Gate: axe tags wcag2a/aa + wcag21a/aa + wcag22aa; fail on any critical/serious.
 * Writes under qa/e2e/out/axe/ when --run produces real analyze() output.
 * NEVER claim accessibility PASS without on-disk axe JSON with criticalSeriousCount === 0.
 *
 * Usage:
 *   node qa/e2e/flows/axe-control-center.mjs --self-test
 *   node qa/e2e/flows/axe-control-center.mjs --plan
 *   WEB_BASE=… node qa/e2e/flows/axe-control-center.mjs --run
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  printOwnerTarget,
  resolveBoardId,
  resolveFullSha,
  resolveHeaded,
  resolveWebBase,
  isFullSha,
} from '../lib/env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'axe-control-center'
const OUT_AXE = path.resolve(__dirname, '../out/axe')
const DEFAULT_BOARD = 'mfs-rebuild'

/** WCAG 2.2 AA tag set used by @axe-core/playwright (UI_CONTRACT §11 / AC-UI-06). */
export const AXE_TAGS = Object.freeze([
  'wcag2a',
  'wcag2aa',
  'wcag21a',
  'wcag21aa',
  'wcag22aa',
])

/** Impacts that fail the release gate. */
export const FAIL_IMPACTS = Object.freeze(['critical', 'serious'])

/** Accessibility claim tokens — PASS only with on-disk axe receipt. */
export const A11Y_CLAIMS = Object.freeze({
  NOT_RUN: 'NOT_RUN',
  PENDING_RUN: 'PENDING_RUN',
  FAIL: 'FAIL',
  PASS: 'PASS',
})

/**
 * ART S01–S24 → product board-scoped routes for axe (SCREENSHOT_SPEC / ART-UX-DIRECTION).
 * Placeholder tokens: {board}, {taskId}, {decisionId}
 */
export const ART_AXE_SIDS = Object.freeze([
  {
    id: 'S01',
    productPath: '/b/{board}/',
    viewport: '1440x900',
    state: 'populated',
    intent: 'Overview fresh',
  },
  {
    id: 'S02',
    productPath: '/b/{board}/',
    viewport: '390x844',
    state: 'populated',
    intent: 'Overview mobile',
  },
  {
    id: 'S03',
    productPath: '/b/{board}/work?bucket=DONE',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Work DONE',
  },
  {
    id: 'S04',
    productPath: '/b/{board}/work?bucket=ONGOING',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Work ONGOING',
  },
  {
    id: 'S05',
    productPath: '/b/{board}/work?bucket=NEXT',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Work NEXT',
  },
  {
    id: 'S06',
    productPath: '/b/{board}/work?bucket=QUEUED',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Work QUEUED',
  },
  {
    id: 'S07',
    productPath: '/b/{board}/work?bucket=BLOCKED',
    viewport: '1280x800',
    state: 'needs-human',
    intent: 'Work BLOCKED',
  },
  {
    id: 'S08',
    productPath: '/b/{board}/work?bucket=RECONCILIATION_PENDING',
    viewport: '390x844',
    state: 'partial',
    intent: 'Work RECONCILIATION',
  },
  {
    id: 'S09',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Task detail human',
  },
  {
    id: 'S10',
    productPath: '/b/{board}/work/{taskId}?mode=technical',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Task detail technical',
  },
  {
    id: 'S11',
    productPath: '/b/{board}/decisions',
    viewport: '1280x800',
    state: 'needs-human',
    intent: 'Decision inbox',
  },
  {
    id: 'S12',
    productPath: '/b/{board}/decisions/{decisionId}',
    viewport: '390x844',
    state: 'needs-human',
    intent: 'Decision detail',
  },
  {
    id: 'S13',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '1440x900',
    state: 'populated',
    intent: 'Knowledge domain',
  },
  {
    id: 'S14',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '390x844',
    state: 'populated',
    intent: 'Knowledge domain mobile',
  },
  {
    id: 'S15',
    productPath: '/b/{board}/search?q=pembayaran%20affiliate',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Search semantic',
  },
  {
    id: 'S16',
    productPath: '/b/{board}/search?q=T-AFF-N16-MONEY-EXPIRED-UNPAID',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Search technical alias',
  },
  {
    id: 'S17',
    productPath: '/b/{board}/documentation/domains/AFFILIATE',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Documentation domain',
  },
  {
    id: 'S18',
    productPath: '/b/{board}/',
    viewport: '1280x800',
    state: 'stale',
    intent: 'Stale banner overview',
  },
  {
    id: 'S19',
    productPath: '/b/{board}/work',
    viewport: '1280x800',
    state: 'loading',
    intent: 'Work loading skeleton',
  },
  {
    id: 'S20',
    productPath: '/b/{board}/work',
    viewport: '1280x800',
    state: 'error',
    intent: 'Work safe error',
  },
  {
    id: 'S21',
    productPath: '/b/{board}/knowledge/domains/AFFILIATE',
    viewport: '1280x800',
    state: 'partial',
    intent: 'Knowledge conflict/redact',
  },
  {
    id: 'S22',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Keyboard focus sequence',
  },
  {
    id: 'S23',
    productPath: '/b/{board}/work/{taskId}',
    viewport: '1280x800',
    state: 'populated',
    intent: 'Browser zoom 200%',
    zoom: '200%',
  },
  {
    id: 'S24',
    productPath: '/b/{board}/work?query=zero-result-xyz',
    viewport: '320x568',
    state: 'zero-results',
    intent: 'Work empty query',
  },
])

export const EXPECTED_SID_COUNT = 24

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

/**
 * Parse viewport token "WwHh" → { width, height }.
 * @param {string} token
 */
export function parseViewport(token) {
  const m = String(token).match(/^(\d+)x(\d+)$/i)
  if (!m) throw new Error(`invalid viewport token: ${token}`)
  return { width: Number(m[1]), height: Number(m[2]) }
}

/**
 * Resolve product path with board / task / decision placeholders.
 * @param {string} template
 * @param {{ boardId?: string, taskId?: string, decisionId?: string }} [pins]
 */
export function resolveProductPath(template, pins = {}) {
  const board = pins.boardId ?? DEFAULT_BOARD
  const taskId = pins.taskId ?? 'task-ongoing-1'
  const decisionId = pins.decisionId ?? 'dec-v3-001'
  return String(template)
    .replaceAll('{board}', board)
    .replaceAll('{taskId}', taskId)
    .replaceAll('{decisionId}', decisionId)
}

/**
 * Build planned axe rows for all ART SIDs (no I/O).
 * @param {{
 *   boardId?: string,
 *   taskId?: string,
 *   decisionId?: string,
 *   fullSha?: string,
 *   outAxe?: string,
 * }} [opts]
 */
export function planAxeMatrix(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const fullSha = opts.fullSha ?? resolveFullSha({ cwd: ROOT })
  const outAxe = opts.outAxe ?? OUT_AXE
  const rows = ART_AXE_SIDS.map((sid) => {
    const route = resolveProductPath(sid.productPath, {
      boardId,
      taskId: opts.taskId,
      decisionId: opts.decisionId,
    })
    const browserTestId = `axe-${sid.id}`
    const axePath = path.join(outAxe, `${browserTestId}.json`)
    return {
      artSid: sid.id,
      route,
      viewport: sid.viewport,
      zoom: sid.zoom ?? null,
      state: sid.state,
      intent: sid.intent,
      browserTestId,
      axePath,
      tags: [...AXE_TAGS],
      failImpacts: [...FAIL_IMPACTS],
      accessibilityResult: axePath,
      claim: A11Y_CLAIMS.PENDING_RUN,
      fullSha,
    }
  })
  return {
    flow: FLOW_NAME,
    boardId,
    fullSha,
    plannedCount: rows.length,
    tags: [...AXE_TAGS],
    failImpacts: [...FAIL_IMPACTS],
    outAxe,
    rows,
  }
}

/**
 * Evaluate axe JSON payload for gate (pure).
 * @param {{ criticalSeriousCount?: number, violations?: Array<{ impact?: string }> }} payload
 */
export function evaluateAxePayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return {
      ok: false,
      claim: A11Y_CLAIMS.FAIL,
      criticalSeriousCount: null,
      reason: 'missing or invalid axe payload',
    }
  }
  let count =
    typeof payload.criticalSeriousCount === 'number'
      ? payload.criticalSeriousCount
      : null
  if (count == null && Array.isArray(payload.violations)) {
    count = payload.violations.filter(
      (v) => v && (v.impact === 'critical' || v.impact === 'serious'),
    ).length
  }
  if (count == null) {
    return {
      ok: false,
      claim: A11Y_CLAIMS.FAIL,
      criticalSeriousCount: null,
      reason: 'axe payload lacks criticalSeriousCount/violations',
    }
  }
  if (count > 0) {
    return {
      ok: false,
      claim: A11Y_CLAIMS.FAIL,
      criticalSeriousCount: count,
      reason: `axe AC-UI-06 FAIL: ${count} critical/serious`,
    }
  }
  return {
    ok: true,
    claim: A11Y_CLAIMS.PASS,
    criticalSeriousCount: 0,
    reason: 'zero critical/serious',
  }
}

/**
 * Build accessibility claim metadata. PASS refused without on-disk axe JSON gate pass.
 * @param {{
 *   claim?: string,
 *   axePath?: string|null,
 *   fullSha?: string|null,
 *   expectedFullSha?: string|null,
 *   fsExists?: (p: string) => boolean,
 *   fsRead?: (p: string) => string,
 * }} input
 */
export function buildA11yClaimMetadata(input = {}) {
  const exists = input.fsExists ?? ((p) => fs.existsSync(p))
  const read = input.fsRead ?? ((p) => fs.readFileSync(p, 'utf8'))
  const axePath = input.axePath || null
  let claim = input.claim || A11Y_CLAIMS.NOT_RUN

  if (claim === A11Y_CLAIMS.PASS) {
    if (!axePath || !exists(axePath)) {
      throw new Error(
        'A11Y_CLAIM FAIL: cannot claim accessibility PASS without on-disk axe JSON',
      )
    }
    let payload
    try {
      payload = JSON.parse(read(axePath))
    } catch (e) {
      throw new Error(
        `A11Y_CLAIM FAIL: axe JSON unreadable at ${axePath}: ${String(e?.message || e)}`,
      )
    }
    const evaled = evaluateAxePayload(payload)
    if (!evaled.ok) {
      throw new Error(
        `A11Y_CLAIM FAIL: ${evaled.reason} (path=${axePath})`,
      )
    }
    if (
      input.expectedFullSha &&
      isFullSha(input.expectedFullSha) &&
      payload.fullSha &&
      payload.fullSha !== input.expectedFullSha
    ) {
      throw new Error(
        `A11Y_CLAIM FAIL: axe receipt fullSha ${payload.fullSha} != expected ${input.expectedFullSha}`,
      )
    }
  }

  const fileOk = Boolean(axePath && exists(axePath))
  if (!fileOk && (claim === A11Y_CLAIMS.PASS || claim === A11Y_CLAIMS.FAIL)) {
    claim = A11Y_CLAIMS.PENDING_RUN
  }

  return {
    claim,
    axePath,
    fullSha: input.fullSha ?? null,
    tags: [...AXE_TAGS],
    failImpacts: [...FAIL_IMPACTS],
    shippableA11y: claim === A11Y_CLAIMS.PASS,
    note:
      claim === A11Y_CLAIMS.PASS
        ? 'axe zero critical/serious on disk'
        : claim === A11Y_CLAIMS.PENDING_RUN
          ? 'NOT_CLAIMED: no axe JSON'
          : claim === A11Y_CLAIMS.NOT_RUN
            ? 'axe not executed'
            : 'accessibility claim recorded',
  }
}

/**
 * Pure self-test — no browser, no network.
 */
export function selfTest() {
  const checks = {}
  const detail = {}

  checks.sidCount24 = ART_AXE_SIDS.length === EXPECTED_SID_COUNT
  checks.sidIdsSequential = ART_AXE_SIDS.every(
    (s, i) => s.id === `S${String(i + 1).padStart(2, '0')}`,
  )
  checks.tagsIncludeWcag22aa =
    AXE_TAGS.includes('wcag22aa') &&
    AXE_TAGS.includes('wcag2aa') &&
    AXE_TAGS.length === 5
  checks.failImpactsCriticalSerious =
    FAIL_IMPACTS.includes('critical') && FAIL_IMPACTS.includes('serious')

  const planned = planAxeMatrix({
    boardId: DEFAULT_BOARD,
    fullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
  })
  checks.plannedCount24 = planned.plannedCount === 24
  checks.rows24 = planned.rows.length === 24
  detail.plannedCount = planned.plannedCount

  checks.allHaveRoute = planned.rows.every(
    (r) => typeof r.route === 'string' && r.route.startsWith(`/b/${DEFAULT_BOARD}/`),
  )
  checks.allHaveAxePath = planned.rows.every(
    (r) => typeof r.axePath === 'string' && r.axePath.includes('axe-S') && r.axePath.endsWith('.json'),
  )
  checks.allPending = planned.rows.every((r) => r.claim === A11Y_CLAIMS.PENDING_RUN)
  checks.uniqueSids = new Set(planned.rows.map((r) => r.artSid)).size === 24

  // viewport tokens parse
  let viewportOk = true
  for (const r of planned.rows) {
    try {
      const vp = parseViewport(r.viewport)
      if (!vp.width || !vp.height) viewportOk = false
    } catch {
      viewportOk = false
    }
  }
  checks.viewportsParse = viewportOk

  // PASS without file throws
  let passBlocked = false
  try {
    buildA11yClaimMetadata({ claim: A11Y_CLAIMS.PASS, axePath: null })
  } catch (e) {
    passBlocked = String(e.message).includes('without on-disk axe JSON')
  }
  checks.passBlockedNoFile = passBlocked

  let passBlockedMissing = false
  try {
    buildA11yClaimMetadata({
      claim: A11Y_CLAIMS.PASS,
      axePath: '/tmp/__no_such_axe_cc__.json',
      fsExists: () => false,
    })
  } catch (e) {
    passBlockedMissing = String(e.message).includes('without on-disk axe JSON')
  }
  checks.passBlockedMissingFile = passBlockedMissing

  // PASS allowed with zero critical/serious payload
  const okMeta = buildA11yClaimMetadata({
    claim: A11Y_CLAIMS.PASS,
    axePath: '/mock/axe-S01.json',
    fullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
    expectedFullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
    fsExists: () => true,
    fsRead: () =>
      JSON.stringify({
        browserTestId: 'axe-S01',
        fullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
        criticalSeriousCount: 0,
        violations: [],
      }),
  })
  checks.passAllowedZeroViolations =
    okMeta.claim === A11Y_CLAIMS.PASS && okMeta.shippableA11y === true

  // FAIL when critical/serious present
  let failOnSerious = false
  try {
    buildA11yClaimMetadata({
      claim: A11Y_CLAIMS.PASS,
      axePath: '/mock/axe-bad.json',
      fsExists: () => true,
      fsRead: () =>
        JSON.stringify({
          criticalSeriousCount: 2,
          violations: [
            { id: 'color-contrast', impact: 'serious' },
            { id: 'button-name', impact: 'critical' },
          ],
        }),
    })
  } catch (e) {
    failOnSerious = String(e.message).includes('critical/serious')
  }
  checks.failOnCriticalSerious = failOnSerious

  // SHA mismatch refuses PASS
  let shaMismatch = false
  try {
    buildA11yClaimMetadata({
      claim: A11Y_CLAIMS.PASS,
      axePath: '/mock/axe-sha.json',
      expectedFullSha: 'b9c86c2d1ef6c26d4436d4ffd434642421f847bd',
      fsExists: () => true,
      fsRead: () =>
        JSON.stringify({
          criticalSeriousCount: 0,
          fullSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
          violations: [],
        }),
    })
  } catch (e) {
    shaMismatch = String(e.message).includes('fullSha')
  }
  checks.shaBoundReceipt = shaMismatch

  // evaluateAxePayload pure
  checks.evalZeroOk = evaluateAxePayload({ criticalSeriousCount: 0 }).ok === true
  checks.evalSeriousFail =
    evaluateAxePayload({
      violations: [{ impact: 'serious' }],
    }).ok === false

  // out dir path is under qa/e2e/out/axe
  checks.outAxePath = planned.outAxe.includes(`${path.sep}out${path.sep}axe`) ||
    planned.outAxe.endsWith('/out/axe') ||
    planned.outAxe.endsWith('\\out\\axe')

  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    mode: 'self-test',
    flow: FLOW_NAME,
    checks,
    detail,
    residual_gaps: ok
      ? 'none for pure contract; live --run not exercised this session'
      : Object.entries(checks)
          .filter(([, v]) => !v)
          .map(([k]) => k)
          .join(','),
    NOT_SHIPPABLE: 'no live axe proof (self-test only)',
  }
}

/**
 * Write plan JSON under out/runtime (optional).
 */
export function runPlan(opts = {}) {
  const planned = planAxeMatrix(opts)
  const runId =
    opts.runId ??
    `axe-cc-plan-${new Date().toISOString().replace(/[:.]/g, '').slice(0, 15)}`
  const outPath =
    opts.outPath ||
    arg('--out', path.join(ROOT, 'qa/e2e/out/runtime', runId, 'AXE_PLAN.json'))
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify({ ...planned, runId, mode: 'plan' }, null, 2), 'utf8')
  return {
    mode: 'plan',
    flow: FLOW_NAME,
    plan: outPath,
    plannedCount: planned.plannedCount,
    note: 'Plan-only: claim=PENDING_RUN; no axe analyze executed',
    NOT_SHIPPABLE: 'no live axe proof',
  }
}

/**
 * Live axe run — requires browser + storage for protected routes.
 * Not invoked by default self-test.
 */
export async function runLive(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const headed = resolveHeaded()
  const webBase = resolveWebBase()
  const fullSha = resolveFullSha({ cwd: ROOT })
  const planned = planAxeMatrix({ boardId, fullSha, outAxe: opts.outAxe ?? OUT_AXE })

  printOwnerTarget({
    flow: FLOW_NAME,
    mode: 'run',
    base_url: webBase,
    boardId,
    fullSha,
  })

  fs.mkdirSync(planned.outAxe, { recursive: true })

  // Dynamic import so --self-test never loads Playwright / axe-core.
  const { chromium } = await import('@playwright/test')
  const { runAxe } = await import('../lib/axe.mjs')
  const { requireExistingStorageState, AUTH_STORAGE_STATE_PATH } = await import(
    '../lib/auth.mjs'
  )

  const browser = await chromium.launch({ headless: !headed })
  const results = []
  try {
    const context = await browser.newContext({
      baseURL: webBase,
      viewport: { width: 1440, height: 900 },
      storageState: requireExistingStorageState(
        opts.storageStatePath ?? AUTH_STORAGE_STATE_PATH,
      ),
      ignoreHTTPSErrors: true,
    })
    const page = await context.newPage()

    for (const row of planned.rows) {
      const vp = parseViewport(row.viewport)
      await page.setViewportSize(vp)
      await page.goto(row.route, { waitUntil: 'domcontentloaded' })
      if (row.zoom === '200%') {
        await page.evaluate(() => {
          document.documentElement.style.zoom = '2'
        })
      }
      const axe = await runAxe(page, {
        outPath: row.axePath,
        browserTestId: row.browserTestId,
        tags: row.tags,
      })
      // bind release SHA into the receipt for audit
      if (axe.rawPath && fs.existsSync(axe.rawPath)) {
        try {
          const body = JSON.parse(fs.readFileSync(axe.rawPath, 'utf8'))
          body.fullSha = fullSha
          body.artSid = row.artSid
          body.route = row.route
          body.viewport = row.viewport
          body.tags = row.tags
          fs.writeFileSync(axe.rawPath, JSON.stringify(body, null, 2), 'utf8')
        } catch {
          /* leave raw axe output */
        }
      }
      const evaled = evaluateAxePayload({
        criticalSeriousCount: axe.criticalSerious?.length ?? 0,
        violations: axe.violations,
      })
      results.push({
        artSid: row.artSid,
        route: row.route,
        ok: evaled.ok,
        claim: evaled.claim,
        criticalSeriousCount: evaled.criticalSeriousCount,
        axePath: axe.rawPath ?? row.axePath,
      })
      if (row.zoom === '200%') {
        await page.evaluate(() => {
          document.documentElement.style.zoom = ''
        })
      }
    }
    await context.close()
  } finally {
    await browser.close()
  }

  const failed = results.filter((r) => !r.ok)
  const summary = {
    mode: 'run',
    flow: FLOW_NAME,
    fullSha,
    plannedCount: planned.plannedCount,
    ran: results.length,
    passed: results.filter((r) => r.ok).length,
    failed: failed.length,
    results,
    ok: failed.length === 0,
    residual_gaps:
      failed.length === 0
        ? 'none for axe critical/serious on exercised routes'
        : failed.map((f) => `${f.artSid}:${f.criticalSeriousCount}`).join(','),
  }
  return summary
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/axe-control-center.mjs --self-test
  node qa/e2e/flows/axe-control-center.mjs --plan
  node qa/e2e/flows/axe-control-center.mjs --run
Env: WEB_BASE, BOARD_ID, HEADED, FULL_SHA, CAIRN_E2E_* (for --run auth)
`)
}

async function main() {
  if (hasFlag('--help') || hasFlag('-h')) {
    printHelp()
    process.exitCode = 0
    return
  }

  const wantRun = hasFlag('--run')
  const wantPlan = hasFlag('--plan')
  const wantSelf =
    hasFlag('--self-test') || (!wantRun && !wantPlan)

  if (wantSelf) {
    const r = selfTest()
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = r.ok ? 0 : 1
    return
  }

  if (wantPlan) {
    const r = runPlan()
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = 0
    return
  }

  if (wantRun) {
    try {
      const r = await runLive()
      console.log(JSON.stringify(r, null, 2))
      process.exitCode = r.ok ? 0 : 1
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exitCode = 1
    }
  }
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
