#!/usr/bin/env node
/**
 * Promoted performance budget flow (AC-PERF-01).
 *
 * Env:
 *   WEB_BASE / STAGING_URL
 *   BOARD_ID                 default mfs-rebuild
 *   PERF_P95_MS              default 500 (on-host public / API p95)
 *   PERF_FILTER_P95_MS       default: same as PERF_P95_MS when filter probe is
 *                            the identical public-snapshot path; only used as a
 *                            tighter budget when set explicitly OR when a true
 *                            UI filter surface is configured (see PERF_UI_FILTER_URL)
 *   PERF_UI_FILTER_URL       optional absolute or path URL for true UI filter
 *                            feedback surface (distinct ≤200ms budget)
 *   PERF_UI_FILTER_P95_MS    default 200 (UI filter feedback only)
 *   PERF_SAMPLE_N            default 20 (may be rate-capped downward)
 *   PERF_SAMPLE_GAP_MS       default auto (≥1000ms when multi-series under rate policy)
 *   PERF_PROOF_BOUNDARY      on-host | tunnel | client | remote
 *                            default: loopback WEB_BASE → tunnel; else remote
 *   PERF_LOAD_RPS            default 20 (only with --load-10m)
 *   PERF_LOAD_DURATION_SEC   default 600 (only with --load-10m)
 *   PERF_SCALE_FIXTURE_DIR   default qa/fixtures/staging/scale-1000
 *   PERF_RATE_BURST          default 20 (PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
 *   PERF_RATE_SUSTAINED      default 60 / min
 *
 * Usage:
 *   WEB_BASE=http://127.0.0.1:33211 node qa/e2e/flows/perf-budgets.mjs
 *   WEB_BASE=… PERF_PROOF_BOUNDARY=on-host node qa/e2e/flows/perf-budgets.mjs
 *   WEB_BASE=… PERF_UI_FILTER_URL=/control-center?view=filter node …  # true UI ≤200
 *   WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 \
 *     node qa/e2e/flows/perf-budgets.mjs --load-10m
 *   node qa/e2e/flows/perf-budgets.mjs --self-test
 *   node qa/e2e/flows/perf-budgets.mjs --scale-only
 *
 * Long 10m load is OPT-IN via --load-10m. Default run does counts + short p95 only.
 *
 * Classification (root class when budgets fail):
 *   STACK   — transport / uncaught harness error
 *   HARNESS — sampling violated rate policy / 429 pollution / misconfigured probe
 *   TUNNEL  — client path is tunnel/loopback and only client wall-clock exceeded budget
 *   APP     — on-host proof boundary OR safely available server latency exceeded budget
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { printOwnerTarget, resolveBoardId, resolveWebBase } from '../lib/env.mjs'
import {
  SCALE_COUNTS,
  generateScaleFixture,
  writeScaleFixture,
} from '../../fixtures/staging/scale-1000/generate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../../..')

/** PUBLIC_SNAPSHOT_RATE_LIMIT_V1 defaults (src/server/rate-limit.ts). */
export const RATE_LIMIT_DEFAULTS = {
  burst: 20,
  sustainedPerMinute: 60,
  windowMs: 60_000,
}

export const DEFAULT_PUBLIC_P95_MS = 500
/** Distinct AC-PERF-01 UI filter feedback budget (not the identical public probe). */
export const DEFAULT_UI_FILTER_P95_MS = 200
/** Default unused query that does NOT change public-snapshot handler work. */
export const DEFAULT_IDENTICAL_FILTER_QUERY = 'view=filter&bucket=ONGOING'

export function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

export function envIsExplicitlySet(name) {
  const raw = process.env[name]
  return raw != null && String(raw).trim() !== ''
}

export function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, idx)]
}

/**
 * True when filter probe hits the same public-snapshot handler/body path
 * (extra view/bucket query params are unread by the server).
 */
export function isIdenticalPublicFilterProbe({ publicUrl, filterUrl, uiFilterUrl }) {
  if (uiFilterUrl) return false
  if (!publicUrl || !filterUrl) return false
  try {
    const pub = new URL(publicUrl)
    const fil = new URL(filterUrl)
    if (pub.origin !== fil.origin || pub.pathname !== fil.pathname) return false
    // Filter URL is public URL plus optional extra query keys only.
    const pubKeys = new Set([...pub.searchParams.keys()])
    for (const [k, v] of fil.searchParams) {
      if (pubKeys.has(k)) {
        if (pub.searchParams.get(k) !== v) return false
      }
      // extra keys (view, bucket, …) are allowed and mark "identical-path probe"
    }
    return true
  } catch {
    return false
  }
}

/**
 * Resolve budgets:
 * - publicP95Ms: on-host API ≤500 default
 * - filterProbeP95Ms: aligns to public when identical path + PERF_FILTER_P95_MS unset
 * - uiFilterP95Ms: distinct ≤200; only gated when true UI surface configured
 */
export function resolveBudgets(opts = {}) {
  const publicP95Ms = opts.publicP95Ms ?? DEFAULT_PUBLIC_P95_MS
  const identicalPath = opts.identicalPath === true
  const uiFilterConfigured = Boolean(opts.uiFilterUrl)
  const filterEnvExplicit = opts.filterP95Explicit === true
  const filterEnvValue = opts.filterP95Ms

  let filterProbeP95Ms
  let filterBudgetSource
  if (filterEnvExplicit && filterEnvValue != null) {
    filterProbeP95Ms = filterEnvValue
    filterBudgetSource = 'PERF_FILTER_P95_MS'
  } else if (identicalPath) {
    filterProbeP95Ms = publicP95Ms
    filterBudgetSource = 'aligned_to_public_identical_path'
  } else if (uiFilterConfigured) {
    filterProbeP95Ms = opts.uiFilterP95Ms ?? DEFAULT_UI_FILTER_P95_MS
    filterBudgetSource = 'ui_filter_surface'
  } else {
    filterProbeP95Ms = publicP95Ms
    filterBudgetSource = 'aligned_to_public_default'
  }

  return {
    publicP95Ms,
    filterProbeP95Ms,
    filterBudgetSource,
    uiFilterP95Ms: opts.uiFilterP95Ms ?? DEFAULT_UI_FILTER_P95_MS,
    uiFilterConfigured,
    identicalPath,
  }
}

/**
 * Rate-limit-aware sampling plan so multi-series probes stay under policy.
 * Caps sampleN ≤ burst/2 when seriesCount≥2; enforces gapMs floor for sustained rate.
 */
export function resolveSamplePlan(opts = {}) {
  const burst = opts.burst ?? RATE_LIMIT_DEFAULTS.burst
  const sustainedPerMinute = opts.sustainedPerMinute ?? RATE_LIMIT_DEFAULTS.sustainedPerMinute
  const seriesCount = Math.max(1, opts.seriesCount ?? 2)
  const requestedN = Math.max(1, Math.floor(opts.sampleN ?? 20))
  const gapRequested = opts.gapMs
  const gapExplicit = opts.gapExplicit === true

  const reasons = []
  let sampleN = requestedN
  const maxPerSeries = Math.max(1, Math.floor(burst / 2))
  if (seriesCount >= 2 && sampleN > maxPerSeries) {
    sampleN = maxPerSeries
    reasons.push(`sampleN_capped_burst_half:${requestedN}->${sampleN}`)
  }

  // Min gap so seriesCount * sampleN requests over the wall fit sustained rate
  // with headroom: target ≤ sustainedPerMinute * 0.8 for safety.
  const safePerMin = Math.max(1, Math.floor(sustainedPerMinute * 0.8))
  const totalRequests = seriesCount * sampleN
  const minGapForSustained =
    totalRequests > 0 ? Math.ceil((totalRequests / safePerMin) * 60_000) / totalRequests : 0
  // Also ensure refill between individual requests ≈ 1 token/s under 60/min.
  const minGapTokenRefill = Math.ceil(60_000 / sustainedPerMinute)
  let gapMs
  if (gapExplicit && gapRequested != null) {
    gapMs = Math.max(0, gapRequested)
    if (gapMs < minGapTokenRefill) {
      reasons.push(`gap_below_policy_refill:${gapMs}<${minGapTokenRefill}`)
    }
  } else {
    const auto = Math.max(
      minGapTokenRefill,
      Math.ceil(minGapForSustained),
      gapRequested != null ? gapRequested : 0,
      1000,
    )
    gapMs = auto
    if (gapRequested != null && gapRequested < auto) {
      reasons.push(`gap_auto_raised:${gapRequested}->${auto}`)
    } else {
      reasons.push(`gap_auto:${auto}`)
    }
  }

  const seriesCooldownMs = opts.seriesCooldownMs ?? Math.max(2000, minGapTokenRefill * 2)

  return {
    sampleN,
    gapMs,
    seriesCount,
    seriesCooldownMs,
    burst,
    sustainedPerMinute,
    totalRequests,
    adjusted: reasons.length > 0,
    reasons,
    belowPolicy: !gapExplicit || gapMs >= minGapTokenRefill,
  }
}

/**
 * Parse server-observed latency from response headers when safely present.
 * Never invents a value.
 */
export function parseServerLatencyMs(headers) {
  if (!headers) return null
  const get = (name) => {
    if (typeof headers.get === 'function') return headers.get(name)
    const key = Object.keys(headers).find((k) => k.toLowerCase() === name.toLowerCase())
    return key != null ? headers[key] : null
  }

  const direct =
    get('x-server-latency-ms') ||
    get('x-backend-latency-ms') ||
    get('x-app-latency-ms') ||
    get('x-response-time-ms')
  if (direct != null && direct !== '') {
    const n = Number(String(direct).replace(/ms$/i, '').trim())
    if (Number.isFinite(n) && n >= 0) return n
  }

  const serverTiming = get('server-timing')
  if (serverTiming) {
    // Prefer app|handler|total;dur=…
    const re = /(?:^|,)\s*(?:app|handler|total|server)[^,;]*;\s*dur\s*=\s*([0-9.]+)/i
    const m = String(serverTiming).match(re)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 0) return n
    }
    const anyDur = String(serverTiming).match(/dur\s*=\s*([0-9.]+)/i)
    if (anyDur) {
      const n = Number(anyDur[1])
      if (Number.isFinite(n) && n >= 0) return n
    }
  }

  const xrt = get('x-response-time')
  if (xrt != null && xrt !== '') {
    const m = String(xrt).match(/([0-9.]+)\s*ms/i) || String(xrt).match(/^([0-9.]+)$/)
    if (m) {
      const n = Number(m[1])
      if (Number.isFinite(n) && n >= 0) return n
    }
  }
  return null
}

export function isLoopbackBase(base) {
  try {
    const u = new URL(base)
    const h = u.hostname.toLowerCase()
    return h === '127.0.0.1' || h === 'localhost' || h === '::1' || h === '[::1]'
  } catch {
    return false
  }
}

/**
 * Resolve proof boundary used for APP vs TUNNEL classification.
 */
export function resolveProofBoundary(opts = {}) {
  const raw = (opts.explicit || process.env.PERF_PROOF_BOUNDARY || '').trim().toLowerCase()
  if (raw === 'on-host' || raw === 'onhost' || raw === 'host') return 'on-host'
  if (raw === 'tunnel') return 'tunnel'
  if (raw === 'client') return 'client'
  if (raw === 'remote') return 'remote'
  const base = opts.base || ''
  if (isLoopbackBase(base)) return 'tunnel'
  return 'remote'
}

/**
 * Classify root cause when a budget fails (or overall result).
 * Prefer APP only with on-host boundary or safe server latency proof.
 */
export function classifyPerfResult(input = {}) {
  const {
    stackError = null,
    rateLimitCount = 0,
    samplePlanBelowPolicy = true,
    okCount = 0,
    publicPass = true,
    filterPass = true,
    uiFilterPass = true,
    proofBoundary = 'remote',
    usedServerLatency = false,
    budgetsFailed = null,
  } = input

  if (stackError) return 'STACK'

  const anyFail =
    budgetsFailed != null
      ? budgetsFailed
      : !(publicPass && filterPass && uiFilterPass)

  if (rateLimitCount > 0 && anyFail) return 'HARNESS'
  if (!samplePlanBelowPolicy && anyFail) return 'HARNESS'
  if (okCount === 0) return 'APP_OR_STACK'

  if (!anyFail) return 'OK'

  // Budget exceeded with clean samples
  if (usedServerLatency || proofBoundary === 'on-host') return 'APP'
  if (proofBoundary === 'tunnel' || proofBoundary === 'client') return 'TUNNEL'
  return 'APP'
}

/**
 * Summarize samples for p95. Excludes:
 * - non-ok statuses
 * - samples that required 429 retries (retry wall path is HARNESS, not APP)
 * Prefers server latency when present on a sample.
 */
export function summarizeSamples(samples, opts = {}) {
  const preferServer = opts.preferServerLatency !== false
  const clean = []
  const rateLimited = []
  const retriedOk = []
  const failed = []
  let usedServerLatency = false

  for (const s of samples) {
    if (s.status === 429) {
      rateLimited.push(s)
      continue
    }
    if (!s.ok) {
      failed.push(s)
      continue
    }
    if (s.retries429 > 0) {
      // Final status may be 200, but path was rate-limited — do not count as APP latency.
      retriedOk.push(s)
      continue
    }
    let ms = s.ms
    if (preferServer && s.serverMs != null && Number.isFinite(s.serverMs)) {
      ms = s.serverMs
      usedServerLatency = true
    }
    clean.push({ ...s, budgetMs: ms })
  }

  const ms = clean.map((s) => s.budgetMs).sort((a, b) => a - b)
  return {
    n: samples.length,
    okCount: clean.length,
    failCount: failed.length,
    rateLimitCount: rateLimited.length,
    retriedOkCount: retriedOk.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    min: ms[0] ?? null,
    max: ms[ms.length - 1] ?? null,
    usedServerLatency,
    statuses: samples.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    }, {}),
    latencySource: usedServerLatency ? 'server_header' : 'client_wall',
  }
}

export async function timedGet(url, headers = {}) {
  const t0 = performance.now()
  let status = 0
  let ok = false
  let serverMs = null
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers } })
    status = res.status
    ok = res.ok || res.status === 304
    serverMs = parseServerLatencyMs(res.headers)
    await res.arrayBuffer()
  } catch (e) {
    return {
      ms: performance.now() - t0,
      status: 0,
      ok: false,
      serverMs: null,
      error: String(e?.message || e),
      retries429: 0,
    }
  }
  return {
    ms: performance.now() - t0,
    status,
    ok,
    serverMs,
    error: null,
    retries429: 0,
  }
}

/**
 * Sample latencies without folding 429-retry backoff into APP latency.
 * On 429: record the 429 sample (status 429, not ok) and optionally attempt
 * recovery samples that are tagged retries429>0 (excluded from APP p95).
 */
export async function sampleLatencies(url, n, opts = {}) {
  const samples = []
  const gapMs = opts.gapMs ?? 0
  const max429Retries = opts.max429Retries ?? 0 // default: do not retry into APP stats
  for (let i = 0; i < n; i++) {
    let sample = await timedGet(url)
    let retries = 0
    if (sample.status === 429 && max429Retries > 0) {
      // Record the pure 429 first (class HARNESS signal).
      samples.push({ ...sample, retries429: 0 })
      while (sample.status === 429 && retries < max429Retries) {
        retries++
        const retryAfterMs = 1100
        await new Promise((r) => setTimeout(r, retryAfterMs))
        sample = await timedGet(url)
      }
      if (sample.status !== 429) {
        samples.push({ ...sample, retries429: retries })
      } else {
        samples.push({ ...sample, retries429: retries })
      }
    } else {
      samples.push({ ...sample, retries429: 0 })
    }
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
  }
  return summarizeSamples(samples, opts)
}

/**
 * Sustained load: target RPS for durationSec.
 * Bounded concurrency = rps (one wave per second).
 * 429s counted separately; not folded into APP p95.
 */
export async function loadForDuration(url, { rps, durationSec }) {
  const started = Date.now()
  const deadline = started + durationSec * 1000
  let sent = 0
  let ok = 0
  let fail = 0
  let rateLimited = 0
  const latencies = []
  let second = 0
  let usedServerLatency = false

  while (Date.now() < deadline) {
    second++
    const waveStart = Date.now()
    const batch = []
    for (let i = 0; i < rps; i++) {
      batch.push(timedGet(url))
    }
    const results = await Promise.all(batch)
    for (const r of results) {
      sent++
      if (r.status === 429) {
        rateLimited++
        fail++
        continue
      }
      if (r.ok) {
        ok++
        if (r.serverMs != null && Number.isFinite(r.serverMs)) {
          latencies.push(r.serverMs)
          usedServerLatency = true
        } else {
          latencies.push(r.ms)
        }
      } else fail++
    }
    const elapsed = Date.now() - waveStart
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed))
    }
    if (second % 30 === 0) {
      const sorted = [...latencies].sort((a, b) => a - b)
      console.error(
        JSON.stringify({
          progress: true,
          second,
          sent,
          ok,
          fail,
          rateLimited,
          p95: percentile(sorted, 95),
        }),
      )
    }
  }

  const sorted = latencies.sort((a, b) => a - b)
  const wallSec = (Date.now() - started) / 1000
  return {
    rps,
    durationSec,
    wallSec,
    sent,
    ok,
    fail,
    rateLimited,
    achievedRps: wallSec > 0 ? sent / wallSec : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
    usedServerLatency,
    latencySource: usedServerLatency ? 'server_header' : 'client_wall',
  }
}

export function verifyScaleFixtureDir(dir) {
  const manifestPath = path.join(dir, 'manifest.json')
  if (!fs.existsSync(manifestPath)) {
    const written = writeScaleFixture(dir, generateScaleFixture())
    return {
      ok: written.ok,
      generated: true,
      counts: written.counts,
      expected: SCALE_COUNTS,
      dir,
    }
  }
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  const counts = manifest.counts || {}
  const ok =
    counts.tasks === SCALE_COUNTS.tasks &&
    counts.runs === SCALE_COUNTS.runs &&
    counts.accounts === SCALE_COUNTS.accounts &&
    counts.decisions === SCALE_COUNTS.decisions
  return { ok, generated: false, counts, expected: SCALE_COUNTS, dir }
}

export function buildFilterProbeUrl(publicUrl, opts = {}) {
  if (opts.uiFilterUrl) {
    const base = opts.base || ''
    if (/^https?:\/\//i.test(opts.uiFilterUrl)) return opts.uiFilterUrl
    const b = base.replace(/\/$/, '')
    const p = opts.uiFilterUrl.startsWith('/') ? opts.uiFilterUrl : `/${opts.uiFilterUrl}`
    return `${b}${p}`
  }
  const q = opts.identicalQuery || DEFAULT_IDENTICAL_FILTER_QUERY
  const join = publicUrl.includes('?') ? '&' : '?'
  return `${publicUrl}${join}${q}`
}

export function selfTest() {
  const f = generateScaleFixture()
  const scaleOk =
    f.tasks.length === 1000 &&
    f.runs.length === 200 &&
    f.accounts.length === 20 &&
    f.decisions.length === 100
  const p = percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)

  // Identical path → filter budget aligns to public (500), not 200
  const budgetsIdentical = resolveBudgets({
    publicP95Ms: 500,
    identicalPath: true,
    filterP95Explicit: false,
  })
  const budgetsExplicitFilter = resolveBudgets({
    publicP95Ms: 500,
    identicalPath: true,
    filterP95Explicit: true,
    filterP95Ms: 200,
  })
  const budgetsUi = resolveBudgets({
    publicP95Ms: 500,
    identicalPath: false,
    uiFilterUrl: 'http://127.0.0.1:3210/ui-filter',
    uiFilterP95Ms: 200,
  })

  const plan = resolveSamplePlan({ sampleN: 20, seriesCount: 2, burst: 20, sustainedPerMinute: 60 })

  const pub = 'http://127.0.0.1:33211/api/public-snapshot?boardId=mfs-rebuild'
  const fil = `${pub}&view=filter&bucket=ONGOING`
  const identical = isIdenticalPublicFilterProbe({ publicUrl: pub, filterUrl: fil, uiFilterUrl: null })
  const notIdentical = isIdenticalPublicFilterProbe({
    publicUrl: pub,
    filterUrl: 'http://127.0.0.1:33211/other',
    uiFilterUrl: null,
  })

  const serverMs = parseServerLatencyMs({
    get: (n) => (n.toLowerCase() === 'server-timing' ? 'app;dur=12.5' : null),
  })

  const samples = [
    { ms: 10, status: 200, ok: true, serverMs: null, retries429: 0 },
    { ms: 20, status: 200, ok: true, serverMs: null, retries429: 0 },
    { ms: 5000, status: 200, ok: true, serverMs: null, retries429: 2 }, // excluded
    { ms: 1, status: 429, ok: false, serverMs: null, retries429: 0 },
  ]
  const summary = summarizeSamples(samples)

  const classTunnel = classifyPerfResult({
    publicPass: true,
    filterPass: false,
    proofBoundary: 'tunnel',
    usedServerLatency: false,
    okCount: 5,
    rateLimitCount: 0,
  })
  const classApp = classifyPerfResult({
    publicPass: false,
    filterPass: true,
    proofBoundary: 'on-host',
    usedServerLatency: false,
    okCount: 5,
    rateLimitCount: 0,
  })
  const classHarness = classifyPerfResult({
    publicPass: false,
    filterPass: true,
    proofBoundary: 'on-host',
    rateLimitCount: 3,
    okCount: 2,
  })
  const classOk = classifyPerfResult({
    publicPass: true,
    filterPass: true,
    uiFilterPass: true,
    okCount: 10,
  })

  const boundaryLoop = resolveProofBoundary({ base: 'http://127.0.0.1:33211' })
  const boundaryHost = resolveProofBoundary({ explicit: 'on-host', base: 'http://127.0.0.1:33211' })

  const checks = {
    scaleOk,
    p95Sample: p === 10,
    budgetsIdenticalAlign: budgetsIdentical.filterProbeP95Ms === 500,
    budgetsIdenticalSource: budgetsIdentical.filterBudgetSource === 'aligned_to_public_identical_path',
    budgetsExplicitFilter: budgetsExplicitFilter.filterProbeP95Ms === 200,
    budgetsUiFilter: budgetsUi.filterProbeP95Ms === 200 && budgetsUi.uiFilterConfigured,
    uiBudgetDistinct: budgetsIdentical.uiFilterP95Ms === 200,
    samplePlanCap: plan.sampleN === 10,
    samplePlanGap: plan.gapMs >= 1000,
    identicalPath: identical === true,
    notIdentical: notIdentical === false,
    serverTimingParse: serverMs === 12.5,
    summaryExcludesRetry: summary.okCount === 2 && summary.retriedOkCount === 1,
    summaryRateLimit: summary.rateLimitCount === 1,
    summaryP95: summary.p95 === 20,
    classTunnel: classTunnel === 'TUNNEL',
    classApp: classApp === 'APP',
    classHarness: classHarness === 'HARNESS',
    classOk: classOk === 'OK',
    boundaryLoop: boundaryLoop === 'tunnel',
    boundaryHost: boundaryHost === 'on-host',
  }
  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    checks,
    scaleCounts: {
      tasks: f.tasks.length,
      runs: f.runs.length,
      accounts: f.accounts.length,
      decisions: f.decisions.length,
    },
    p95Sample: p,
    budgetsIdentical,
    plan,
  }
}

async function main() {
  const flags = new Set(process.argv.filter((a) => a.startsWith('--')))

  if (flags.has('--self-test')) {
    const r = selfTest()
    console.log(JSON.stringify({ mode: 'self-test', ...r }, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  const scaleDir =
    process.env.PERF_SCALE_FIXTURE_DIR?.trim() ||
    path.join(ROOT, 'qa/fixtures/staging/scale-1000')

  const scale = verifyScaleFixtureDir(scaleDir)

  if (flags.has('--scale-only')) {
    console.log(JSON.stringify({ mode: 'scale-only', scale }, null, 2))
    process.exit(scale.ok ? 0 : 1)
  }

  const base = resolveWebBase()
  const boardId = resolveBoardId('mfs-rebuild')
  const p95Budget = numEnv('PERF_P95_MS', DEFAULT_PUBLIC_P95_MS)
  const uiFilterUrl = process.env.PERF_UI_FILTER_URL?.trim() || null
  const uiFilterBudget = numEnv('PERF_UI_FILTER_P95_MS', DEFAULT_UI_FILTER_P95_MS)
  const filterEnvExplicit = envIsExplicitlySet('PERF_FILTER_P95_MS')
  const filterEnvValue = filterEnvExplicit ? numEnv('PERF_FILTER_P95_MS', p95Budget) : null

  const publicUrl = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
  const filterUrl = buildFilterProbeUrl(publicUrl, {
    base,
    uiFilterUrl,
    identicalQuery: DEFAULT_IDENTICAL_FILTER_QUERY,
  })
  const identicalPath = isIdenticalPublicFilterProbe({
    publicUrl,
    filterUrl,
    uiFilterUrl,
  })

  const budgets = resolveBudgets({
    publicP95Ms: p95Budget,
    identicalPath,
    filterP95Explicit: filterEnvExplicit,
    filterP95Ms: filterEnvValue,
    uiFilterUrl,
    uiFilterP95Ms: uiFilterBudget,
  })

  // public + filter series (two HTTP series). When PERF_UI_FILTER_URL is set,
  // filterUrl IS the UI surface (buildFilterProbeUrl prefers it) — still two series.
  const uiFilterIsFilterProbe = Boolean(uiFilterUrl)

  const samplePlan = resolveSamplePlan({
    sampleN: numEnv('PERF_SAMPLE_N', 20),
    gapMs: envIsExplicitlySet('PERF_SAMPLE_GAP_MS') ? numEnv('PERF_SAMPLE_GAP_MS', 1000) : undefined,
    gapExplicit: envIsExplicitlySet('PERF_SAMPLE_GAP_MS'),
    seriesCount: 2,
    burst: numEnv('PERF_RATE_BURST', RATE_LIMIT_DEFAULTS.burst),
    sustainedPerMinute: numEnv('PERF_RATE_SUSTAINED', RATE_LIMIT_DEFAULTS.sustainedPerMinute),
  })

  const loadOptIn = flags.has('--load-10m') || flags.has('--load')
  const loadRps = numEnv('PERF_LOAD_RPS', 20)
  const loadDuration = numEnv('PERF_LOAD_DURATION_SEC', 600)
  const proofBoundary = resolveProofBoundary({ base })

  printOwnerTarget({
    flow: 'perf-budgets',
    boardId,
    loadOptIn,
    p95Budget: budgets.publicP95Ms,
    filterBudget: budgets.filterProbeP95Ms,
    uiFilterBudget: budgets.uiFilterP95Ms,
    proofBoundary,
    sampleN: samplePlan.sampleN,
    gapMs: samplePlan.gapMs,
  })

  let publicStats
  let filterStats
  let uiFilterStats = null
  let loadStats = null
  let stackError = null

  try {
    publicStats = await sampleLatencies(publicUrl, samplePlan.sampleN, {
      gapMs: samplePlan.gapMs,
      max429Retries: 0,
    })
    await new Promise((r) => setTimeout(r, samplePlan.seriesCooldownMs))
    filterStats = await sampleLatencies(filterUrl, samplePlan.sampleN, {
      gapMs: samplePlan.gapMs,
      max429Retries: 0,
    })
    // Distinct UI filter series only when configured AND we still want a separate public identical probe.
    // Current design: PERF_UI_FILTER_URL replaces filter probe URL; ui stats = filterStats when set.
    if (uiFilterIsFilterProbe) {
      uiFilterStats = filterStats
    }
    if (loadOptIn) {
      console.error(
        JSON.stringify({
          load_start: true,
          rps: loadRps,
          durationSec: loadDuration,
          url: publicUrl,
        }),
      )
      loadStats = await loadForDuration(publicUrl, {
        rps: loadRps,
        durationSec: loadDuration,
      })
    }
  } catch (e) {
    stackError = String(e?.message || e)
  }

  const publicPass =
    publicStats &&
    publicStats.okCount > 0 &&
    publicStats.p95 != null &&
    publicStats.p95 <= budgets.publicP95Ms

  // Filter probe uses aligned budget when identical path
  const filterPass =
    filterStats &&
    filterStats.okCount > 0 &&
    filterStats.p95 != null &&
    filterStats.p95 <= budgets.filterProbeP95Ms

  // Distinct UI filter feedback ≤200 only when true UI surface configured
  let uiFilterPass = true
  let uiFilterApplicable = false
  if (uiFilterIsFilterProbe && uiFilterStats) {
    uiFilterApplicable = true
    uiFilterPass =
      uiFilterStats.okCount > 0 &&
      uiFilterStats.p95 != null &&
      uiFilterStats.p95 <= budgets.uiFilterP95Ms
  }

  const loadPass =
    !loadOptIn ||
    (loadStats &&
      loadStats.ok > 0 &&
      loadStats.p95 != null &&
      loadStats.p95 <= budgets.publicP95Ms)

  const rateLimitCount =
    (publicStats?.rateLimitCount || 0) +
    (filterStats?.rateLimitCount || 0) +
    (loadStats?.rateLimited || 0)

  const usedServerLatency = Boolean(
    publicStats?.usedServerLatency ||
      filterStats?.usedServerLatency ||
      loadStats?.usedServerLatency,
  )

  const rootClass = classifyPerfResult({
    stackError,
    rateLimitCount,
    samplePlanBelowPolicy: samplePlan.belowPolicy,
    okCount: (publicStats?.okCount || 0) + (filterStats?.okCount || 0),
    publicPass: Boolean(publicPass),
    filterPass: Boolean(filterPass),
    uiFilterPass: Boolean(uiFilterPass),
    proofBoundary,
    usedServerLatency,
  })

  const residualGaps = [
    ...(loadOptIn ? [] : ['10m load not run (opt-in --load-10m)']),
    'LCP browser probe not included in default node flow',
    'p95 only meaningful when target returns 200/304 clean samples (no 429 retry path)',
    ...(identicalPath
      ? [
          'filterProbe uses identical public-snapshot path (view/bucket unread); budget aligned to public unless PERF_FILTER_P95_MS or PERF_UI_FILTER_URL set',
        ]
      : []),
    ...(uiFilterApplicable
      ? []
      : [
          'UI filter feedback ≤200ms not gated (set PERF_UI_FILTER_URL for true UI surface)',
        ]),
    ...(usedServerLatency
      ? []
      : [
          'server latency headers absent — budgets use client wall-clock; TUNNEL path cannot prove APP',
        ]),
    ...(proofBoundary !== 'on-host'
      ? [`proofBoundary=${proofBoundary} (set PERF_PROOF_BOUNDARY=on-host for APP-class fail proof)`]
      : []),
  ]

  const out = {
    ok: Boolean(
      scale.ok && publicPass && filterPass && uiFilterPass && loadPass && !stackError && rateLimitCount === 0,
    ),
    base,
    boardId,
    proofBoundary,
    scale,
    samplePlan,
    budgets: {
      publicP95Ms: budgets.publicP95Ms,
      filterP95Ms: budgets.filterProbeP95Ms,
      filterBudgetSource: budgets.filterBudgetSource,
      uiFilterP95Ms: budgets.uiFilterP95Ms,
      uiFilterApplicable,
      identicalPath,
      loadRps: loadOptIn ? loadRps : null,
      loadDurationSec: loadOptIn ? loadDuration : null,
    },
    urls: {
      publicUrl,
      filterUrl,
      uiFilterUrl: uiFilterUrl || null,
    },
    publicSnapshot: publicStats,
    filterProbe: filterStats,
    uiFilterFeedback: uiFilterApplicable ? uiFilterStats : null,
    load: loadStats,
    loadOptIn,
    loadCommand:
      'WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 node qa/e2e/flows/perf-budgets.mjs --load-10m',
    passes: {
      public: Boolean(publicPass),
      filterProbe: Boolean(filterPass),
      uiFilterFeedback: uiFilterApplicable ? Boolean(uiFilterPass) : null,
      load: loadPass,
      scale: Boolean(scale.ok),
    },
    rateLimitCount,
    usedServerLatency,
    residualGaps,
    stackError,
    class: rootClass,
  }

  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
