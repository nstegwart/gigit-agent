#!/usr/bin/env node
/**
 * Bounded UI Overview-ready / LCP + filter feedback probe (AC-PERF-01).
 *
 * Self-test (default / --self-test): pure budget evaluators, no browser, no staging.
 * Live (--live): Playwright measures Overview-ready marker and optional LCP; optional
 * UI filter feedback on Work surface. Does NOT run load/storms.
 *
 * Filter metric contract (HARD):
 *   UI filter feedback ≤200ms is **in-surface feedback after data is available** —
 *   load Work surface + wait for data, then apply filter (bucket tab click),
 *   measure only t0(filter action) → feedback visible.
 *   page.goto / full navigation wall time is NOT a valid filter sample
 *   (metricKind navigation_wall / page_goto → FAIL CLOSED).
 *   If the in-surface filter control is unavailable after data → FAIL CLOSED
 *   (do not substitute navigation timing).
 *
 * Env:
 *   WEB_BASE / STAGING_URL
 *   BOARD_ID                 default mfs-rebuild
 *   PERF_LCP_MS              default 2500
 *   PERF_UI_FILTER_P95_MS    default 200 (filter feedback budget)
 *   PERF_UI_FILTER_URL       optional absolute/path UI filter surface (bucket target)
 *   PERF_OVERVIEW_PATH       default /b/{board}/
 *   PERF_UI_TIMEOUT_MS       default 15000 (bounded wait)
 *   HEADED                   1 for headed browser
 *
 * Usage:
 *   node qa/e2e/flows/perf-ui-overview-lcp.mjs --self-test
 *   WEB_BASE=… BOARD_ID=mfs-rebuild node qa/e2e/flows/perf-ui-overview-lcp.mjs --live
 *   WEB_BASE=… PERF_UI_FILTER_URL=/b/mfs-rebuild/work?bucket=ONGOING node … --live --filter
 *
 * Auth: reuses qa/e2e storageState when present (auth-login.mjs). Unauth paths
 * that redirect to /login fail closed with class HARNESS/AUTH.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { printOwnerTarget, resolveBoardId, resolveHeaded, resolveWebBase } from '../lib/env.mjs'
import { AUTH_STORAGE_STATE_PATH } from '../lib/auth.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

export const DEFAULT_OVERVIEW_READY_MS = 2500
export const DEFAULT_UI_FILTER_FEEDBACK_MS = 200
export const DEFAULT_UI_TIMEOUT_MS = 15_000

/** Valid filter metric: in-surface action after data already present. */
export const FILTER_METRIC_IN_SURFACE = 'in_surface_after_data'
/** Invalid for ≤200 claim — full navigation wall (page.goto). Fail closed. */
export const FILTER_METRIC_NAV_WALL = 'navigation_wall'
export const FILTER_METRIC_PAGE_GOTO = 'page_goto'

const INVALID_FILTER_METRIC_KINDS = new Set([
  FILTER_METRIC_NAV_WALL,
  FILTER_METRIC_PAGE_GOTO,
  'full_navigation',
  'cold_load',
])

/** Overview ready: surface mounted and not loading. */
export const OVERVIEW_READY_SELECTOR =
  '[data-testid="control-center-overview"]:not([data-surface-state="loading"])'

/** Work surface ready (data path) before measuring filter feedback. */
export const WORK_DATA_READY_SELECTORS = [
  '[data-testid="work-list"]',
  '[data-testid="work-surface"]:not([data-surface-state="loading"])',
  '[data-testid="work-table"]',
  '[data-testid="work-card-list"]',
  '[data-testid="work-state-empty"]',
  '[role="tablist"][aria-label="Work primary buckets"]',
]

/** Work surface filter feedback after in-surface action. */
export const WORK_FILTER_FEEDBACK_SELECTORS = [
  '[data-testid="work-list"]',
  '[data-testid="work-surface"]',
  '[data-testid="work-table"]',
  '[data-testid="work-card-list"]',
  '[role="tab"][aria-selected="true"]',
  'main',
]

export function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Evaluate Overview-ready / LCP against ≤2.5s budget.
 * Prefer explicit overviewReadyMs when present; else LCP.
 */
export function evaluateOverviewReady(input = {}) {
  const budgetMs = input.budgetMs ?? DEFAULT_OVERVIEW_READY_MS
  const readyMs = input.overviewReadyMs
  const lcpMs = input.lcpMs
  const hasReady = readyMs != null && Number.isFinite(readyMs)
  const hasLcp = lcpMs != null && Number.isFinite(lcpMs)

  if (!hasReady && !hasLcp) {
    return {
      ok: false,
      pass: false,
      budgetMs,
      metric: null,
      valueMs: null,
      reason: 'no_overview_ready_or_lcp_sample',
    }
  }

  if (hasReady) {
    const pass = readyMs <= budgetMs
    return {
      ok: pass,
      pass,
      budgetMs,
      metric: 'overview_ready',
      valueMs: readyMs,
      lcpMs: hasLcp ? lcpMs : null,
      reason: pass ? null : `overview_ready>${budgetMs}`,
    }
  }

  const pass = lcpMs <= budgetMs
  return {
    ok: pass,
    pass,
    budgetMs,
    metric: 'lcp',
    valueMs: lcpMs,
    lcpMs,
    reason: pass ? null : `lcp>${budgetMs}`,
  }
}

/**
 * Evaluate UI filter feedback ≤200ms after data is available.
 *
 * Contract:
 * - metricKind must be in_surface_after_data (or omitted → treated as in-surface for pure tests)
 * - navigation_wall / page_goto / cold_load → FAIL CLOSED (never PASS ≤200 claim)
 * - missing sample when applicable → FAIL CLOSED
 * - error from live measure (filter control unavailable) → FAIL CLOSED
 */
export function evaluateFilterFeedback(input = {}) {
  const budgetMs = input.budgetMs ?? DEFAULT_UI_FILTER_FEEDBACK_MS
  const feedbackMs = input.feedbackMs
  const applicable = input.applicable !== false
  const metricKind = input.metricKind ?? null
  const measureError = input.error ?? input.measureError ?? null

  if (!applicable) {
    return {
      ok: true,
      pass: true,
      applicable: false,
      budgetMs,
      valueMs: null,
      metricKind: null,
      reason: 'filter_feedback_not_configured',
    }
  }

  // Explicit invalid metric kinds fail closed even if a number is present
  if (metricKind != null && INVALID_FILTER_METRIC_KINDS.has(metricKind)) {
    return {
      ok: false,
      pass: false,
      applicable: true,
      budgetMs,
      valueMs: Number.isFinite(feedbackMs) ? feedbackMs : null,
      metricKind,
      reason: 'filter_metric_is_navigation_wall_not_in_surface',
    }
  }

  if (measureError) {
    return {
      ok: false,
      pass: false,
      applicable: true,
      budgetMs,
      valueMs: Number.isFinite(feedbackMs) ? feedbackMs : null,
      metricKind: metricKind || null,
      reason: String(measureError),
      error: String(measureError),
    }
  }

  if (feedbackMs == null || !Number.isFinite(feedbackMs)) {
    return {
      ok: false,
      pass: false,
      applicable: true,
      budgetMs,
      valueMs: null,
      metricKind: metricKind || null,
      reason: 'no_filter_feedback_sample',
    }
  }

  // Pure self-test may omit metricKind; live path always sets in_surface_after_data
  const effectiveKind = metricKind || FILTER_METRIC_IN_SURFACE
  if (effectiveKind !== FILTER_METRIC_IN_SURFACE) {
    return {
      ok: false,
      pass: false,
      applicable: true,
      budgetMs,
      valueMs: feedbackMs,
      metricKind: effectiveKind,
      reason: 'unknown_filter_metric_kind',
    }
  }

  const pass = feedbackMs <= budgetMs
  return {
    ok: pass,
    pass,
    applicable: true,
    budgetMs,
    valueMs: feedbackMs,
    metricKind: effectiveKind,
    reason: pass ? null : `filter_feedback>${budgetMs}`,
  }
}

/**
 * Parse target Work bucket from a filter path/URL (query bucket=…).
 * @returns {string|null}
 */
export function parseFilterBucket(filterPath) {
  if (!filterPath) return null
  try {
    const u = filterPath.includes('://')
      ? new URL(filterPath)
      : new URL(filterPath, 'http://local.invalid')
    const b = u.searchParams.get('bucket')
    return b && b.trim() ? b.trim() : null
  } catch {
    const m = String(filterPath).match(/[?&]bucket=([^&]+)/i)
    return m ? decodeURIComponent(m[1]) : null
  }
}

/**
 * Work surface base path (data load) without forcing the target bucket filter.
 * Used so filter feedback measures the in-surface tab change, not cold navigation.
 */
export function buildWorkBasePath(boardId, filterPath) {
  if (filterPath) {
    try {
      const u = filterPath.includes('://')
        ? new URL(filterPath)
        : new URL(filterPath, 'http://local.invalid')
      // Prefer same path without search when it is a work route
      if (u.pathname.includes('/work')) {
        return u.pathname
      }
    } catch {
      /* fall through */
    }
  }
  return `/b/${boardId}/work`
}

export function buildOverviewPath(boardId, overridePath) {
  if (overridePath) {
    if (/^https?:\/\//i.test(overridePath)) return overridePath
    return overridePath.startsWith('/') ? overridePath : `/${overridePath}`
  }
  return `/b/${boardId}/`
}

export function buildFilterPath(boardId, uiFilterUrl) {
  if (!uiFilterUrl) return `/b/${boardId}/work?bucket=ONGOING`
  if (/^https?:\/\//i.test(uiFilterUrl)) {
    try {
      const u = new URL(uiFilterUrl)
      return `${u.pathname}${u.search}`
    } catch {
      return uiFilterUrl
    }
  }
  return uiFilterUrl.startsWith('/') ? uiFilterUrl : `/${uiFilterUrl}`
}

export function selfTest() {
  const readyPass = evaluateOverviewReady({ overviewReadyMs: 1200, lcpMs: 1800, budgetMs: 2500 })
  const readyFail = evaluateOverviewReady({ overviewReadyMs: 4000, budgetMs: 2500 })
  const lcpOnly = evaluateOverviewReady({ lcpMs: 900, budgetMs: 2500 })
  const missing = evaluateOverviewReady({})
  const filterPass = evaluateFilterFeedback({
    feedbackMs: 80,
    budgetMs: 200,
    metricKind: FILTER_METRIC_IN_SURFACE,
  })
  const filterFail = evaluateFilterFeedback({
    feedbackMs: 350,
    budgetMs: 200,
    metricKind: FILTER_METRIC_IN_SURFACE,
  })
  const filterSkip = evaluateFilterFeedback({ applicable: false })
  // HARD: navigation wall must never pass as filter ≤200
  const filterNavWall = evaluateFilterFeedback({
    feedbackMs: 50,
    budgetMs: 200,
    metricKind: FILTER_METRIC_NAV_WALL,
  })
  const filterPageGoto = evaluateFilterFeedback({
    feedbackMs: 10,
    budgetMs: 200,
    metricKind: FILTER_METRIC_PAGE_GOTO,
  })
  const filterMissingControl = evaluateFilterFeedback({
    applicable: true,
    budgetMs: 200,
    error: 'filter_action_unavailable_after_data',
  })
  const path = buildOverviewPath('mfs-rebuild')
  const filterPath = buildFilterPath('mfs-rebuild', null)
  const workBase = buildWorkBasePath('mfs-rebuild', filterPath)
  const bucket = parseFilterBucket(filterPath)

  const checks = {
    readyPass: readyPass.pass === true && readyPass.metric === 'overview_ready',
    readyFail: readyFail.pass === false,
    lcpOnly: lcpOnly.pass === true && lcpOnly.metric === 'lcp',
    missing: missing.pass === false,
    filterPass:
      filterPass.pass === true && filterPass.metricKind === FILTER_METRIC_IN_SURFACE,
    filterFail: filterFail.pass === false,
    filterSkip: filterSkip.applicable === false && filterSkip.pass === true,
    filterNavWallFail:
      filterNavWall.pass === false &&
      filterNavWall.reason === 'filter_metric_is_navigation_wall_not_in_surface',
    filterPageGotoFail: filterPageGoto.pass === false,
    filterMissingControlFail: filterMissingControl.pass === false,
    overviewPath: path === '/b/mfs-rebuild/',
    filterPath: filterPath === '/b/mfs-rebuild/work?bucket=ONGOING',
    workBasePath: workBase === '/b/mfs-rebuild/work',
    parseBucket: bucket === 'ONGOING',
    budgets: DEFAULT_OVERVIEW_READY_MS === 2500 && DEFAULT_UI_FILTER_FEEDBACK_MS === 200,
  }
  const ok = Object.values(checks).every(Boolean)
  return { ok, checks, readyPass, filterPass, filterNavWall }
}

/**
 * Inject LCP observer + navigation timing. Returns { lcpMs, overviewReadyMs }.
 */
async function measureOverview(page, overviewPath, timeoutMs) {
  await page.addInitScript(() => {
    window.__perfLcpMs = null
    try {
      const po = new PerformanceObserver((list) => {
        const entries = list.getEntries()
        const last = entries[entries.length - 1]
        if (last) window.__perfLcpMs = last.startTime
      })
      po.observe({ type: 'largest-contentful-paint', buffered: true })
    } catch {
      /* LCP may be unavailable in some engines */
    }
  })

  const t0 = performance.now()
  await page.goto(overviewPath, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  if (page.url().includes('/login')) {
    throw new Error('FAIL-CLOSED: redirected to /login — auth storage required for Overview probe')
  }

  const readyLocator = page.locator(OVERVIEW_READY_SELECTOR).first()
  await readyLocator.waitFor({ state: 'visible', timeout: timeoutMs })
  const overviewReadyMs = performance.now() - t0

  // Give LCP a short bounded window after ready
  await page.waitForTimeout(Math.min(500, Math.max(0, timeoutMs / 10)))
  const lcpMs = await page.evaluate(() => {
    if (typeof window.__perfLcpMs === 'number') return window.__perfLcpMs
    try {
      const entries = performance.getEntriesByType('largest-contentful-paint')
      if (entries.length) return entries[entries.length - 1].startTime
    } catch {
      /* ignore */
    }
    return null
  })

  const surfaceState = await page
    .locator('[data-testid="control-center-overview"]')
    .first()
    .getAttribute('data-surface-state')

  return { overviewReadyMs, lcpMs, surfaceState }
}

/**
 * In-surface filter feedback AFTER data is available.
 *
 * Steps:
 *  1. Navigate to Work base (data load) — NOT counted toward feedbackMs
 *  2. Wait for work data-ready surface
 *  3. t0 = now; click target bucket tab (in-surface filter action)
 *  4. Wait for feedback selector / selected tab
 *  5. feedbackMs = now − t0; metricKind = in_surface_after_data
 *
 * FAIL CLOSED (returns error, feedbackMs null) when:
 *  - redirect to login
 *  - work data surface never ready
 *  - target bucket tab not found / not clickable
 *
 * NEVER returns page.goto wall time as feedbackMs.
 */
async function measureFilterFeedback(page, filterPath, timeoutMs, boardId) {
  const targetBucket = parseFilterBucket(filterPath) || 'ONGOING'
  const workBase = buildWorkBasePath(boardId, filterPath)

  await page.goto(workBase, { waitUntil: 'domcontentloaded', timeout: timeoutMs })
  if (page.url().includes('/login')) {
    return {
      feedbackMs: null,
      metricKind: null,
      selector: null,
      targetBucket,
      workBase,
      error: 'FAIL-CLOSED: redirected to /login on work path',
    }
  }

  // Wait for data/surface ready BEFORE starting filter timer
  let dataReadySel = null
  for (const sel of WORK_DATA_READY_SELECTORS) {
    const loc = page.locator(sel).first()
    try {
      await loc.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 8000) })
      dataReadySel = sel
      break
    } catch {
      /* try next */
    }
  }
  if (!dataReadySel) {
    return {
      feedbackMs: null,
      metricKind: null,
      selector: null,
      targetBucket,
      workBase,
      error: 'work_data_not_ready_before_filter',
    }
  }

  const tabSel = `[data-testid="work-tab-${targetBucket}"]`
  const tab = page.locator(tabSel).first()
  try {
    await tab.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) })
  } catch {
    return {
      feedbackMs: null,
      metricKind: null,
      selector: null,
      targetBucket,
      workBase,
      dataReadySel,
      error: 'filter_action_unavailable_after_data',
    }
  }

  // --- filter metric window starts here (in-surface only) ---
  const t0 = performance.now()
  await tab.click({ timeout: Math.min(timeoutMs, 3000) })

  let found = null
  // Prefer selected tab proof for the target bucket
  const selectedTab = page.locator(
    `${tabSel}[aria-selected="true"], ${tabSel}[data-bucket="${targetBucket}"][aria-selected="true"]`,
  )
  try {
    await selectedTab.first().waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 5000) })
    found = tabSel + '[aria-selected="true"]'
  } catch {
    for (const sel of WORK_FILTER_FEEDBACK_SELECTORS) {
      const loc = page.locator(sel).first()
      try {
        await loc.waitFor({ state: 'visible', timeout: Math.min(timeoutMs, 3000) })
        found = sel
        break
      } catch {
        /* try next */
      }
    }
  }

  if (!found) {
    return {
      feedbackMs: null,
      metricKind: FILTER_METRIC_IN_SURFACE,
      selector: null,
      targetBucket,
      workBase,
      dataReadySel,
      error: 'filter_feedback_surface_not_visible',
    }
  }

  const feedbackMs = performance.now() - t0
  return {
    feedbackMs,
    metricKind: FILTER_METRIC_IN_SURFACE,
    selector: found,
    targetBucket,
    workBase,
    dataReadySel,
    error: null,
  }
}

async function runLive() {
  const base = resolveWebBase()
  const boardId = resolveBoardId('mfs-rebuild')
  const budgetMs = numEnv('PERF_LCP_MS', DEFAULT_OVERVIEW_READY_MS)
  const filterBudgetMs = numEnv('PERF_UI_FILTER_P95_MS', DEFAULT_UI_FILTER_FEEDBACK_MS)
  const timeoutMs = numEnv('PERF_UI_TIMEOUT_MS', DEFAULT_UI_TIMEOUT_MS)
  const uiFilterUrl = process.env.PERF_UI_FILTER_URL?.trim() || null
  const overviewPath = buildOverviewPath(boardId, process.env.PERF_OVERVIEW_PATH?.trim())
  const filterPath = buildFilterPath(boardId, uiFilterUrl)
  const measureFilter = Boolean(uiFilterUrl) || process.argv.includes('--filter')

  printOwnerTarget({
    flow: 'perf-ui-overview-lcp',
    boardId,
    budgetMs,
    filterBudgetMs,
    measureFilter,
  })

  let chromium
  try {
    ;({ chromium } = await import('@playwright/test'))
  } catch (e) {
    return {
      ok: false,
      mode: 'live',
      class: 'STACK',
      stackError: `playwright_unavailable: ${String(e?.message || e)}`,
    }
  }

  const headed = resolveHeaded()
  const storageState = fs.existsSync(AUTH_STORAGE_STATE_PATH) ? AUTH_STORAGE_STATE_PATH : undefined
  const browser = await chromium.launch({ headless: !headed })
  const context = await browser.newContext({
    baseURL: base,
    viewport: { width: 1440, height: 900 },
    ...(storageState ? { storageState } : {}),
  })
  const page = await context.newPage()

  let overview = null
  let filter = null
  let stackError = null

  try {
    overview = await measureOverview(page, overviewPath, timeoutMs)
    if (measureFilter) {
      filter = await measureFilterFeedback(page, filterPath, timeoutMs, boardId)
    }
  } catch (e) {
    stackError = String(e?.message || e)
  } finally {
    await context.close()
    await browser.close()
  }

  const overviewEval = evaluateOverviewReady({
    overviewReadyMs: overview?.overviewReadyMs,
    lcpMs: overview?.lcpMs,
    budgetMs,
  })
  const filterEval = evaluateFilterFeedback({
    feedbackMs: filter?.feedbackMs,
    budgetMs: filterBudgetMs,
    applicable: measureFilter,
    metricKind: filter?.metricKind,
    error: filter?.error,
  })

  const ok = !stackError && overviewEval.pass && filterEval.pass
  return {
    ok,
    mode: 'live',
    base,
    boardId,
    urls: {
      overviewPath,
      filterPath: measureFilter ? filterPath : null,
      workBase: measureFilter ? filter?.workBase ?? buildWorkBasePath(boardId, filterPath) : null,
    },
    budgets: { overviewReadyMs: budgetMs, uiFilterFeedbackMs: filterBudgetMs, timeoutMs },
    filterMetricContract:
      'in_surface_after_data only — navigation wall / page.goto is fail-closed',
    overview,
    overviewEval,
    filter,
    filterEval,
    residualGaps: [
      ...(measureFilter
        ? filter?.error
          ? [`filter measure fail-closed: ${filter.error}`]
          : []
        : ['filter feedback not measured (pass --filter or PERF_UI_FILTER_URL)']),
      ...(overview?.lcpMs == null ? ['LCP entry unavailable in this browser session'] : []),
      'Live UI probe is bounded single sample — not multi-sample p95',
      'Filter ≤200 is in-surface after data, not Overview cold navigation',
    ],
    stackError,
    class: stackError
      ? stackError.includes('login')
        ? 'HARNESS'
        : 'STACK'
      : ok
        ? 'OK'
        : 'APP',
  }
}

async function main() {
  const flags = new Set(process.argv.filter((a) => a.startsWith('--')))
  const wantLive = flags.has('--live')
  const wantSelf = flags.has('--self-test') || !wantLive

  if (wantSelf && !wantLive) {
    const r = selfTest()
    console.log(JSON.stringify({ mode: 'self-test', ...r }, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (wantLive) {
    const r = await runLive()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  // Both
  const self = selfTest()
  const live = await runLive()
  const out = { mode: 'both', selfTest: self, live, ok: self.ok && live.ok }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
