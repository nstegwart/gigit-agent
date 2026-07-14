#!/usr/bin/env node
/**
 * Promoted performance budget flow (AC-PERF-01).
 *
 * Env:
 *   WEB_BASE / STAGING_URL
 *   BOARD_ID                 default mfs-rebuild
 *   PERF_P95_MS              default 500 (public snapshot)
 *   PERF_FILTER_P95_MS       default 200 (filter-style probe)
 *   PERF_SAMPLE_N            default 20
 *   PERF_LOAD_RPS            default 20 (only with --load-10m)
 *   PERF_LOAD_DURATION_SEC   default 600 (only with --load-10m)
 *   PERF_SCALE_FIXTURE_DIR   default qa/fixtures/staging/scale-1000
 *
 * Usage:
 *   WEB_BASE=http://127.0.0.1:33211 node qa/e2e/flows/perf-budgets.mjs
 *   WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 \
 *     node qa/e2e/flows/perf-budgets.mjs --load-10m
 *   node qa/e2e/flows/perf-budgets.mjs --self-test
 *   node qa/e2e/flows/perf-budgets.mjs --scale-only
 *
 * Long 10m load is OPT-IN via --load-10m (exact command supported). Default run
 * does counts + short p95 only.
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

function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

function percentile(sortedAsc, p) {
  if (!sortedAsc.length) return null
  const idx = Math.min(sortedAsc.length - 1, Math.ceil((p / 100) * sortedAsc.length) - 1)
  return sortedAsc[Math.max(0, idx)]
}

async function timedGet(url, headers = {}) {
  const t0 = performance.now()
  let status = 0
  let ok = false
  try {
    const res = await fetch(url, { headers: { accept: 'application/json', ...headers } })
    status = res.status
    ok = res.ok || res.status === 304
    await res.arrayBuffer()
  } catch (e) {
    return {
      ms: performance.now() - t0,
      status: 0,
      ok: false,
      error: String(e?.message || e),
    }
  }
  return { ms: performance.now() - t0, status, ok, error: null }
}

async function sampleLatencies(url, n, opts = {}) {
  const samples = []
  const gapMs = opts.gapMs ?? 0
  const max429Retries = opts.max429Retries ?? 3
  for (let i = 0; i < n; i++) {
    let sample = await timedGet(url)
    let retries = 0
    while (sample.status === 429 && retries < max429Retries) {
      retries++
      await new Promise((r) => setTimeout(r, 1100))
      sample = await timedGet(url)
    }
    samples.push(sample)
    if (gapMs > 0) await new Promise((r) => setTimeout(r, gapMs))
  }
  const okSamples = samples.filter((s) => s.ok)
  const ms = okSamples.map((s) => s.ms).sort((a, b) => a - b)
  return {
    n,
    okCount: okSamples.length,
    failCount: samples.length - okSamples.length,
    p50: percentile(ms, 50),
    p95: percentile(ms, 95),
    p99: percentile(ms, 99),
    min: ms[0] ?? null,
    max: ms[ms.length - 1] ?? null,
    statuses: samples.reduce((acc, s) => {
      acc[s.status] = (acc[s.status] || 0) + 1
      return acc
    }, {}),
  }
}

/**
 * Sustained load: target RPS for durationSec.
 * Bounded concurrency = rps (one wave per second).
 */
async function loadForDuration(url, { rps, durationSec }) {
  const started = Date.now()
  const deadline = started + durationSec * 1000
  let sent = 0
  let ok = 0
  let fail = 0
  const latencies = []
  let second = 0

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
      if (r.ok) {
        ok++
        latencies.push(r.ms)
      } else fail++
    }
    const elapsed = Date.now() - waveStart
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed))
    }
    // progress every 30s
    if (second % 30 === 0) {
      const sorted = [...latencies].sort((a, b) => a - b)
      console.error(
        JSON.stringify({
          progress: true,
          second,
          sent,
          ok,
          fail,
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
    achievedRps: wallSec > 0 ? sent / wallSec : null,
    p50: percentile(sorted, 50),
    p95: percentile(sorted, 95),
    p99: percentile(sorted, 99),
  }
}

function verifyScaleFixtureDir(dir) {
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

function selfTest() {
  const f = generateScaleFixture()
  const ok =
    f.tasks.length === 1000 &&
    f.runs.length === 200 &&
    f.accounts.length === 20 &&
    f.decisions.length === 100
  const p = percentile([1, 2, 3, 4, 5, 6, 7, 8, 9, 10], 95)
  return {
    ok: ok && p === 10,
    scaleCounts: {
      tasks: f.tasks.length,
      runs: f.runs.length,
      accounts: f.accounts.length,
      decisions: f.decisions.length,
    },
    p95Sample: p,
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
  const p95Budget = numEnv('PERF_P95_MS', 500)
  const filterBudget = numEnv('PERF_FILTER_P95_MS', 200)
  const sampleN = numEnv('PERF_SAMPLE_N', 20)
  const loadOptIn = flags.has('--load-10m') || flags.has('--load')
  const loadRps = numEnv('PERF_LOAD_RPS', 20)
  const loadDuration = numEnv('PERF_LOAD_DURATION_SEC', 600)

  printOwnerTarget({
    flow: 'perf-budgets',
    boardId,
    loadOptIn,
    p95Budget,
    filterBudget,
  })

  const publicUrl = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
  // Filter-style: same public endpoint with extra query (no private surface)
  const filterUrl = `${publicUrl}&view=filter&bucket=ONGOING`

  let publicStats
  let filterStats
  let loadStats = null
  let stackError = null

  try {
    // Gentle sampling: avoid self-tripping PUBLIC_SNAPSHOT_RATE_LIMIT_V1 (20/min).
    const gapMs = numEnv('PERF_SAMPLE_GAP_MS', 50)
    publicStats = await sampleLatencies(publicUrl, sampleN, { gapMs, max429Retries: 5 })
    // brief cool-down before second series
    await new Promise((r) => setTimeout(r, 1200))
    filterStats = await sampleLatencies(filterUrl, sampleN, { gapMs, max429Retries: 5 })
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
    publicStats.p95 <= p95Budget
  const filterPass =
    filterStats &&
    filterStats.okCount > 0 &&
    filterStats.p95 != null &&
    filterStats.p95 <= filterBudget
  const loadPass =
    !loadOptIn ||
    (loadStats &&
      loadStats.ok > 0 &&
      loadStats.p95 != null &&
      loadStats.p95 <= p95Budget)

  const out = {
    ok: Boolean(scale.ok && publicPass && filterPass && loadPass && !stackError),
    base,
    boardId,
    scale,
    budgets: {
      publicP95Ms: p95Budget,
      filterP95Ms: filterBudget,
      loadRps: loadOptIn ? loadRps : null,
      loadDurationSec: loadOptIn ? loadDuration : null,
    },
    publicSnapshot: publicStats,
    filterProbe: filterStats,
    load: loadStats,
    loadOptIn,
    loadCommand:
      'WEB_BASE=… PERF_LOAD_RPS=20 PERF_LOAD_DURATION_SEC=600 node qa/e2e/flows/perf-budgets.mjs --load-10m',
    residualGaps: [
      ...(loadOptIn ? [] : ['10m load not run (opt-in --load-10m)']),
      'LCP browser probe not included in default node flow',
      'p95 only meaningful when target returns 200/304 samples',
    ],
    stackError,
    class: stackError ? 'STACK' : publicStats?.okCount === 0 ? 'APP_OR_STACK' : 'APP',
  }

  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main()
