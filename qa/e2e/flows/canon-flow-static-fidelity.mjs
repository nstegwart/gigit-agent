#!/usr/bin/env node
/**
 * C-FLOW-FIDELITY — static canon DOM/token/forbidden-chrome browser gate.
 * Oracle: DESIGN-CANON-V3/flow (index.html + gate-simple.mjs) + acceptance matrix A1–A6.
 *
 * Modes:
 *   --self-test   pure contracts (no server / no browser)
 *   --plan        emit planned DOM/token checks JSON
 *   --run         live Chromium against WEB_BASE (auth storageState when present)
 *
 * Env: WEB_BASE, BOARD_ID, FULL_SHA, HEADED, CAIRN_E2E_AUTH_STORAGE_PATH / default admin.json
 *
 * Without --run against an owned preview: status HARNESS_READY / LOCAL_ONLY — never functional PASS.
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

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')
const FLOW_NAME = 'canon-flow-static-fidelity'
const OUT_DIR = path.resolve(__dirname, '../out/runtime')

export const TARGET_GATE = 'TM_CANON_V3_BROWSER_HARNESS_READY'
export const DEFAULT_BOARD = 'mfs-rebuild'

/** Canon skeleton selectors (product uses data-testid fallbacks). */
export const REQUIRED_SELECTORS = Object.freeze([
  { id: 'flow-top', sel: '.flow-top' },
  { id: 'flow-modes', sel: '.flow-modes[role="tablist"]' },
  { id: 'flow-stage', sel: '.flow-stage, [data-testid="flow-stage"]' },
  { id: 'flow-world', sel: '.flow-world, [data-testid="flow-world"]' },
  { id: 'flow-edges', sel: 'canvas.flow-edges, [data-testid="flow-edges"]' },
  { id: 'flow-nodes', sel: '.flow-nodes, [data-testid="flow-nodes"]' },
  { id: 'flow-zoom', sel: '.flow-zoom' },
  { id: 'flow-sheet', sel: '.flow-sheet[role="dialog"], [data-testid="flow-sheet"]' },
  { id: 'flow-backdrop', sel: '.flow-backdrop, [data-testid="flow-backdrop"]' },
  { id: 'flow-hint', sel: '.flow-hint' },
  { id: 'pill-cross', sel: '.flow-pill[data-mode="cross"]' },
  { id: 'flow-ultimate', sel: '[data-testid="flow-ultimate"]' },
])

export const NODE_ANATOMY = Object.freeze([
  { id: 'fnode', sel: '.fnode, [data-testid="flow-node"]' },
  { id: 'ft', sel: '.ft' },
  { id: 'fdot', sel: '.fdot' },
])

/** Forbidden AppShell / nine-IA primary chrome on total-replace alur. */
export const FORBIDDEN_CHROME = Object.freeze([
  { id: 'sidebar-nav-items', sel: 'nav.sidebar .nav-item, .sidebar .nav-item' },
  { id: 'legacy-shell-search', sel: '[data-testid="legacy-shell-search"]' },
  { id: 'cc-shell-search', sel: '[data-testid="control-center-shell-search"]' },
  { id: 'shell-version-sidebar', sel: '[data-shell-version] .sidebar .nav-item' },
])

export const FLOW_MODES = Object.freeze([
  'cross',
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
])

/** Token samples expected on dark canon surface (A3). Soft-check when present. */
export const TOKEN_EXPECT = Object.freeze({
  '--bg': ['#0d1017', '#0d1017ff'],
  '--panel': ['#12161e', '#12161eff'],
  '--tx': ['#e8edf3', '#e8edf3ff'],
  '--acc': ['#5b9dff', '#5b9dffff'],
  '--ok': ['#35c479', '#35c479ff'],
  '--warn': ['#e5a54b', '#e5a54bff'],
  '--bad': ['#e8635f', '#e8635fff'],
})

export const TECH_ID_PATTERNS = Object.freeze([
  /\bFEAT-[A-Z0-9-]+\b/,
  /\bT-[A-Z]{2,}-[A-Z0-9-]+\b/,
  /\bFC-[A-Z0-9-]+\b/,
  /\bMAPPED_100\b/,
  /\bPROD_READY\b/,
  /mfs-web-original-upgrade/,
  /sales-rebuild/,
  /rebuild-backend/,
])

export function flowRoute(boardId = resolveBoardId(DEFAULT_BOARD)) {
  return `/b/${boardId}/alur`
}

export function findTechIdHits(visibleText) {
  const hits = []
  for (const re of TECH_ID_PATTERNS) {
    const m = String(visibleText || '').match(re)
    if (m) hits.push({ pattern: String(re), match: m[0] })
  }
  return hits
}

/**
 * Classify data honesty for static bundle vs pinned current revision.
 * @param {{ source?: string|null, pinFieldsPresent?: boolean, visibleNodeIds?: string[] }} input
 */
export function classifyDataHonesty(input = {}) {
  const ids = Array.isArray(input.visibleNodeIds) ? input.visibleNodeIds : []
  const pinOk = input.pinFieldsPresent === true
  const src = String(input.source ?? '').toLowerCase()
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
        'Anonymous/static file source — mark LOCAL_ONLY, not current-revision PASS',
      visibleNodeIds: ids,
    }
  }
  if (!pinOk) {
    return {
      claim: 'NOT_PROVEN',
      reason: 'Pin fields absent',
      visibleNodeIds: ids,
    }
  }
  if (ids.length === 0) {
    return { claim: 'FAIL', reason: 'No visible node ids', visibleNodeIds: ids }
  }
  return {
    claim: 'PASS',
    reason: 'Pinned provenance + visible node ids',
    visibleNodeIds: ids,
  }
}

/**
 * Pure plan of fidelity checks (no I/O).
 */
export function planFidelityChecks(opts = {}) {
  const boardId = opts.boardId ?? resolveBoardId(DEFAULT_BOARD)
  const route = opts.route ?? flowRoute(boardId)
  const fullShaRaw = opts.fullSha ?? resolveFullSha({ cwd: ROOT })
  const fullSha = isFullSha(fullShaRaw) ? fullShaRaw.toLowerCase() : null
  return {
    flow: FLOW_NAME,
    targetGate: TARGET_GATE,
    route,
    boardId,
    fullSha,
    fullShaRequiredForEvidence: true,
    layers: {
      A1_markup: REQUIRED_SELECTORS.map((r) => r.id),
      A2_anatomy: NODE_ANATOMY.map((r) => r.id),
      A3_tokens: Object.keys(TOKEN_EXPECT),
      A5_forbidden: FORBIDDEN_CHROME.map((r) => r.id),
      A6_console: ['console_error_0', 'pageerror_0'],
      C3_tech_ids: TECH_ID_PATTERNS.map(String),
      modes: [...FLOW_MODES],
    },
    dataHonestyDefault: 'LOCAL_ONLY',
    note: 'Live PASS requires --run against authenticated product flow; static source remains LOCAL_ONLY for C1',
  }
}

/**
 * Contract self-test (no browser).
 */
export function runSelfTest() {
  const failures = []
  const cases = {}

  if (REQUIRED_SELECTORS.length < 10) {
    failures.push('REQUIRED_SELECTORS too short')
    cases.selectors = 'FAIL'
  } else {
    cases.selectors = 'PASS'
  }

  if (FLOW_MODES.length !== 6 || FLOW_MODES[0] !== 'cross') {
    failures.push('FLOW_MODES must be 6 starting with cross')
    cases.modes = 'FAIL'
  } else {
    cases.modes = 'PASS'
  }

  if (FORBIDDEN_CHROME.length < 3) {
    failures.push('FORBIDDEN_CHROME incomplete')
    cases.forbidden = 'FAIL'
  } else {
    cases.forbidden = 'PASS'
  }

  const hits = findTechIdHits('Hello FEAT-ABC-1 and GET /api/ok')
  if (hits.length !== 1 || hits[0].match !== 'FEAT-ABC-1') {
    failures.push(`tech id scan unexpected: ${JSON.stringify(hits)}`)
    cases.techIds = 'FAIL'
  } else {
    cases.techIds = 'PASS'
  }

  const clean = findTechIdHits('Verified Partial GET /api/admin/x')
  if (clean.length !== 0) {
    failures.push('API path must not trip tech-id patterns')
    cases.apiAllow = 'FAIL'
  } else {
    cases.apiAllow = 'PASS'
  }

  const honesty = classifyDataHonesty({
    source: 'file',
    pinFieldsPresent: false,
    visibleNodeIds: ['n1'],
  })
  if (honesty.claim !== 'LOCAL_ONLY') {
    failures.push(`static source must be LOCAL_ONLY, got ${honesty.claim}`)
    cases.honesty = 'FAIL'
  } else {
    cases.honesty = 'PASS'
  }

  const plan = planFidelityChecks({
    boardId: DEFAULT_BOARD,
    fullSha: 'a'.repeat(40),
  })
  if (plan.route !== `/b/${DEFAULT_BOARD}/alur`) {
    failures.push(`plan route wrong: ${plan.route}`)
    cases.plan = 'FAIL'
  } else {
    cases.plan = 'PASS'
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
  const fromEnv =
    process.env.CAIRN_E2E_AUTH_STORAGE_PATH?.trim() ||
    process.env.PLAYWRIGHT_STORAGE_STATE?.trim()
  if (fromEnv) return fromEnv
  return AUTH_STORAGE_STATE_PATH
}

/**
 * Live fidelity run (requires WEB_BASE + preferably auth storageState).
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

  const check = (name, ok, detail) => {
    checks.push({ name, ok: !!ok, detail: detail ?? null })
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
      authMode = `storageState_invalid: ${String(e?.message || e)}`
    }
  }
  const context = await browser.newContext(contextOpts)
  const page = await context.newPage()
  page.on('console', (msg) => {
    if (msg.type() === 'error') consoleErrors.push(msg.text())
  })
  page.on('pageerror', (err) => pageErrors.push(String(err?.message || err)))

  let residual = null
  try {
    await page.goto(route, { waitUntil: 'domcontentloaded', timeout: 45_000 })
    const url = page.url()
    const onLogin = /\/login/.test(url)
    const onAlur = /\/alur/.test(url)

    if (onLogin || !onAlur) {
      residual = {
        code: 'AUTH_OR_ROUTE',
        url,
        authMode,
        note: 'Did not land on authenticated alur — fidelity LIVE residual (not PASS)',
      }
      check('reach_flow_authenticated', false, residual)
    } else {
      check('reach_flow_authenticated', true, { url, authMode })
      await page
        .locator('[data-testid="flow-ultimate"], .flow-stage, [data-testid="flow-stage"]')
        .first()
        .waitFor({ timeout: 30_000 })
        .catch(() => null)
      await page.waitForTimeout(400)

      for (const row of REQUIRED_SELECTORS) {
        const count = await page.locator(row.sel).count()
        check(`selector_${row.id}`, count > 0, { sel: row.sel, count })
      }
      for (const row of NODE_ANATOMY) {
        const count = await page.locator(row.sel).count()
        check(`anatomy_${row.id}`, count > 0, { sel: row.sel, count })
      }

      // Forbidden chrome: if still under AppShell, FAIL total-replace claim
      for (const row of FORBIDDEN_CHROME) {
        const visible = await page.locator(row.sel).evaluateAll((els) =>
          els.some((el) => {
            const st = window.getComputedStyle(el)
            return st.display !== 'none' && st.visibility !== 'hidden' && el.offsetParent !== null
          }),
        )
        check(`forbidden_absent_${row.id}`, !visible, {
          sel: row.sel,
          visible,
          note: visible
            ? 'AppShell/nine-IA chrome still visible on primary alur — total replace not achieved'
            : 'ok',
        })
      }

      const mode = await page
        .locator('[data-testid="flow-ultimate"]')
        .getAttribute('data-mode')
        .catch(() => null)
      const crossSelected = await page
        .locator('.flow-pill[data-mode="cross"]')
        .getAttribute('aria-selected')
        .catch(() => null)
      check(
        'default_mode_cross',
        mode === 'cross' || crossSelected === 'true',
        { mode, crossSelected },
      )

      const tokenSample = await page.evaluate((expectMap) => {
        const cs = getComputedStyle(document.documentElement)
        const out = {}
        for (const key of Object.keys(expectMap)) {
          out[key] = (cs.getPropertyValue(key) || '').trim().toLowerCase()
        }
        // Also sample body bg as soft signal
        out.__bodyBg = getComputedStyle(document.body).backgroundColor
        return out
      }, TOKEN_EXPECT)
      // Soft: if tokens defined, they should match; if empty, product may use different var names — record only
      let tokenOk = true
      const tokenDetail = {}
      for (const [k, allowed] of Object.entries(TOKEN_EXPECT)) {
        const got = tokenSample[k]
        const match = !got || allowed.some((a) => got === a || got.includes(a.replace('#', '')))
        tokenDetail[k] = { got, match }
        // Only fail when token is present and wrong
        if (got && !match) tokenOk = false
      }
      check('tokens_sample', tokenOk, tokenDetail)

      const visibleText = await page.evaluate(() => document.body?.innerText || '')
      const techHits = findTechIdHits(visibleText)
      check('no_tech_ids_visible', techHits.length === 0, { techHits })

      const nodeIds = await page.evaluate(() =>
        [...document.querySelectorAll('[data-node-id], [data-testid="flow-node"]')]
          .map((el) => el.getAttribute('data-node-id') || el.dataset?.nodeId)
          .filter(Boolean),
      )
      const bundleMeta = await page.evaluate(async () => {
        try {
          const r = await fetch('/flow-data/data-bundle.json')
          if (!r.ok) return { source: 'missing', status: r.status }
          const j = await r.json()
          return {
            source: 'file',
            projectsSource: j?.projects?.source ?? null,
            generated_at: j?.projects?.generated_at ?? null,
            premiumSteps: j?.premium?.steps?.length ?? 0,
          }
        } catch (e) {
          return { source: 'error', error: String(e?.message || e) }
        }
      })
      const honesty = classifyDataHonesty({
        source: bundleMeta.source || 'file',
        pinFieldsPresent: false,
        visibleNodeIds: nodeIds,
      })
      check(
        'data_honesty_seam',
        honesty.claim === 'LOCAL_ONLY' || honesty.claim === 'PASS',
        { honesty, bundleMeta },
      )
      // Explicit: do not claim current-revision PASS for static
      check(
        'data_honesty_not_false_pass',
        honesty.claim !== 'PASS' || bundleMeta.source !== 'file',
        { claim: honesty.claim },
      )

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
  const status = residual
    ? 'LOCAL_ONLY'
    : fail > 0
      ? 'FAIL'
      : 'LOCAL_ONLY' // static data honesty prevents product current-revision PASS

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
    checks,
    summary: { pass, fail, total: checks.length },
    status,
    functionalPass: false,
    note:
      status === 'LOCAL_ONLY'
        ? 'Live checks executed or residual; data honesty LOCAL_ONLY for static bundle — not release PASS'
        : 'One or more fidelity checks failed',
    finishedAt: new Date().toISOString(),
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  const outPath = path.join(OUT_DIR, `canon-flow-static-fidelity-${fullSha.slice(0, 12)}.json`)
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
    const plan = planFidelityChecks({
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
      // Residual / LOCAL_ONLY exits 0 for harness readiness; hard FAIL exits 1
      process.exit(report.status === 'FAIL' ? 1 : 0)
    } catch (e) {
      console.error(String(e?.stack || e))
      process.exit(2)
    }
  }

  // Default: self-test + plan (no server)
  const self = runSelfTest()
  const plan = planFidelityChecks()
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
