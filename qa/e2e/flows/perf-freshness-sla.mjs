#!/usr/bin/env node
/**
 * Timed freshness SLA probe — runner ≤30s / material ≤30s / public ≤60s.
 *
 * Server-clock semantics: lag = visibleAt(server) − eventAt(server).
 * Client wall-clock is support-only and never used alone to claim PASS.
 *
 * Out-of-order / negative lag (HARD RULE):
 *   If visibleAt is before eventAt, lagMs is negative. That is ALWAYS a FAIL
 *   (error: out_of_order_negative_lag). A lag of -15000 must never pass.
 *   Zero lag is allowed; positive lag is gated by the surface SLA.
 *
 * Handling scenarios (pure evaluators; product AC-PERF freshness package):
 *   reconnect   — disconnect → reconnect → re-visible under server clock
 *   duplicate   — multi-delivery of same event; normalize earliest valid visibleAt
 *   out-of-order — timestamp order violation / negative lag
 *   stale       — forceStale/domain blockers orthogonal to age SLA (see public eval)
 *   manual refresh — user refreshRequestedAt → refreshVisibleAt server lag
 *
 * Modes:
 *   --self-test (default)  pure evaluators + synthetic timelines; no network
 *   --live-ro              single GET public-snapshot; evaluates publicationInterval
 *                          + ageMs using response fields (server-reported); no mutation
 *   --live-mutate          NOT default; requires MCP/bearer + explicit flag — registers
 *                          and polls surfaces. Forbidden on shared staging without owner gate.
 *
 * This harness does NOT run load storms. Default is safe self-test only.
 *
 * Env:
 *   WEB_BASE / STAGING_URL
 *   BOARD_ID
 *   PERF_RUN_VISIBLE_SLA_MS      default 30000
 *   PERF_MATERIAL_SLA_MS         default 30000
 *   PERF_PUBLIC_SLA_MS           default 60000 (publication lag; not age-stale 2×)
 *   PERF_PUBLIC_AGE_STALE_MULT   default 2 (product age-stale threshold = mult × interval)
 *
 * Usage:
 *   node qa/e2e/flows/perf-freshness-sla.mjs --self-test
 *   WEB_BASE=http://127.0.0.1:33211 BOARD_ID=mfs-rebuild \
 *     node qa/e2e/flows/perf-freshness-sla.mjs --live-ro
 */
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { printOwnerTarget, resolveBoardId, resolveWebBase } from '../lib/env.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Product constants (must match server run-registry / account-sync / public-snapshot). */
export const RUN_VISIBLE_SLA_MS = 30_000
export const ACCOUNT_PUBLISH_SLA_MS = 30_000
export const PUBLIC_PUBLICATION_SLA_MS = 60_000
export const PUBLIC_AGE_STALE_MULT = 2

export function numEnv(name, fallback) {
  const raw = process.env[name]
  if (raw == null || raw === '') return fallback
  const n = Number(raw)
  return Number.isFinite(n) ? n : fallback
}

/**
 * Parse ISO / epoch server timestamps. Returns ms epoch or null (never invents).
 */
export function parseServerTimeMs(value) {
  if (value == null || value === '') return null
  if (typeof value === 'number' && Number.isFinite(value)) return value
  const n = Date.parse(String(value))
  return Number.isFinite(n) ? n : null
}

/**
 * Server-clock lag: visibleAt − eventAt. Both must be server timestamps.
 * Negative lag is out-of-order (visible before event) — always an error; lagMs
 * is still returned for diagnostics (e.g. -15000 must never be treated as PASS).
 */
export function serverClockLagMs(eventAt, visibleAt) {
  const a = parseServerTimeMs(eventAt)
  const b = parseServerTimeMs(visibleAt)
  if (a == null || b == null) {
    return {
      lagMs: null,
      error: 'invalid_server_timestamp',
      clock: 'server',
      outOfOrder: false,
    }
  }
  const lagMs = b - a
  if (lagMs < 0) {
    return {
      lagMs,
      error: 'out_of_order_negative_lag',
      clock: 'server',
      outOfOrder: true,
    }
  }
  return { lagMs, error: null, clock: 'server', outOfOrder: false }
}

/**
 * Evaluate one SLA row under server-clock semantics.
 * Negative lag always fails (never pass when lagMs < 0, including -15000).
 * @param {{ kind: string, eventAt: string|number, visibleAt: string|number, slaMs: number }} input
 */
export function evaluateTimedSla(input = {}) {
  const kind = input.kind || 'unknown'
  const slaMs = input.slaMs
  if (slaMs == null || !Number.isFinite(slaMs)) {
    return {
      kind,
      pass: false,
      lagMs: null,
      slaMs: null,
      clock: 'server',
      error: 'sla_ms_missing',
      outOfOrder: false,
    }
  }
  const { lagMs, error, clock, outOfOrder } = serverClockLagMs(
    input.eventAt,
    input.visibleAt,
  )
  if (error) {
    return {
      kind,
      pass: false,
      lagMs,
      slaMs,
      clock,
      error,
      outOfOrder: Boolean(outOfOrder),
      reason: error,
    }
  }
  return {
    kind,
    pass: lagMs <= slaMs,
    lagMs,
    slaMs,
    clock,
    error: null,
    outOfOrder: false,
    reason: lagMs <= slaMs ? null : `lagMs>${slaMs}`,
  }
}

/**
 * Validate a sequence of named server timestamps is non-decreasing in the
 * declared order. First OOO pair fails closed.
 * @param {Array<{ name: string, at: string|number }>} points
 */
export function evaluateServerTimestampOrder(points = []) {
  if (!Array.isArray(points) || points.length < 2) {
    return {
      pass: false,
      error: 'order_points_insufficient',
      clock: 'server',
      violations: [],
    }
  }
  const parsed = []
  for (const p of points) {
    const ms = parseServerTimeMs(p?.at)
    if (ms == null) {
      return {
        pass: false,
        error: 'invalid_server_timestamp',
        clock: 'server',
        violations: [{ name: p?.name ?? 'unknown', reason: 'invalid_server_timestamp' }],
      }
    }
    parsed.push({ name: p.name || 'unnamed', at: p.at, ms })
  }
  const violations = []
  for (let i = 1; i < parsed.length; i++) {
    if (parsed[i].ms < parsed[i - 1].ms) {
      violations.push({
        earlier: parsed[i - 1].name,
        later: parsed[i].name,
        deltaMs: parsed[i].ms - parsed[i - 1].ms,
        reason: 'out_of_order',
      })
    }
  }
  return {
    pass: violations.length === 0,
    error: violations.length ? 'out_of_order' : null,
    clock: 'server',
    violations,
  }
}

/**
 * Reconnect recovery: after disconnect, reconnectAt → reVisibleAt must meet SLA
 * under server clock. Full chain eventAt ≤ disconnectAt ≤ reconnectAt ≤ reVisibleAt.
 * @param {{
 *   eventAt: string|number,
 *   disconnectAt: string|number,
 *   reconnectAt: string|number,
 *   reVisibleAt: string|number,
 *   slaMs?: number,
 *   kind?: string,
 * }} input
 */
export function evaluateReconnectRecovery(input = {}) {
  const kind = input.kind || 'reconnect_recovery'
  const slaMs = input.slaMs ?? RUN_VISIBLE_SLA_MS
  const order = evaluateServerTimestampOrder([
    { name: 'eventAt', at: input.eventAt },
    { name: 'disconnectAt', at: input.disconnectAt },
    { name: 'reconnectAt', at: input.reconnectAt },
    { name: 'reVisibleAt', at: input.reVisibleAt },
  ])
  if (!order.pass) {
    return {
      kind,
      pass: false,
      scenario: 'reconnect',
      clock: 'server',
      slaMs,
      lagMs: null,
      order,
      error: order.error || 'out_of_order',
      reason: 'reconnect_timeline_out_of_order',
    }
  }
  // Recovery lag is measured from reconnect, not original event (reconnect SLA).
  const timed = evaluateTimedSla({
    kind,
    eventAt: input.reconnectAt,
    visibleAt: input.reVisibleAt,
    slaMs,
  })
  return {
    kind,
    pass: timed.pass,
    scenario: 'reconnect',
    clock: 'server',
    slaMs,
    lagMs: timed.lagMs,
    order,
    error: timed.error,
    reason: timed.reason,
    outOfOrder: timed.outOfOrder,
  }
}

/**
 * Duplicate delivery of the same event: normalize to earliest valid visibleAt
 * that is ≥ eventAt (server clock). OOO samples are discarded; if none remain,
 * fail closed with out_of_order_negative_lag. Lag uses the normalized sample.
 * @param {{
 *   eventAt: string|number,
 *   visibleAts: Array<string|number>,
 *   slaMs?: number,
 *   eventId?: string,
 *   kind?: string,
 * }} input
 */
export function evaluateDuplicateDelivery(input = {}) {
  const kind = input.kind || 'duplicate_delivery'
  const slaMs = input.slaMs ?? RUN_VISIBLE_SLA_MS
  const eventId = input.eventId ?? null
  const raw = Array.isArray(input.visibleAts) ? input.visibleAts : []
  if (raw.length === 0) {
    return {
      kind,
      pass: false,
      scenario: 'duplicate',
      clock: 'server',
      eventId,
      slaMs,
      lagMs: null,
      normalizedVisibleAt: null,
      samples: [],
      error: 'no_visible_samples',
      reason: 'no_visible_samples',
    }
  }

  const samples = raw.map((at, i) => {
    const lag = serverClockLagMs(input.eventAt, at)
    return {
      index: i,
      visibleAt: at,
      lagMs: lag.lagMs,
      outOfOrder: Boolean(lag.outOfOrder),
      error: lag.error,
    }
  })
  const valid = samples.filter((s) => s.error == null && s.lagMs != null && s.lagMs >= 0)
  if (valid.length === 0) {
    const anyOoo = samples.some((s) => s.outOfOrder)
    return {
      kind,
      pass: false,
      scenario: 'duplicate',
      clock: 'server',
      eventId,
      slaMs,
      lagMs: samples.find((s) => s.lagMs != null)?.lagMs ?? null,
      normalizedVisibleAt: null,
      samples,
      discardedOoo: samples.filter((s) => s.outOfOrder).length,
      error: anyOoo ? 'out_of_order_negative_lag' : 'invalid_server_timestamp',
      reason: anyOoo
        ? 'all_duplicate_samples_out_of_order'
        : 'all_duplicate_samples_invalid',
    }
  }

  valid.sort((a, b) => a.lagMs - b.lagMs)
  const earliest = valid[0]
  const pass = earliest.lagMs <= slaMs
  return {
    kind,
    pass,
    scenario: 'duplicate',
    clock: 'server',
    eventId,
    slaMs,
    lagMs: earliest.lagMs,
    normalizedVisibleAt: earliest.visibleAt,
    samples,
    discardedOoo: samples.filter((s) => s.outOfOrder).length,
    duplicateCount: raw.length,
    error: null,
    reason: pass ? null : `lagMs>${slaMs}`,
  }
}

/**
 * Manual refresh recovery: refreshRequestedAt → refreshVisibleAt under server clock.
 * Stale snapshot before refresh is expected and does not auto-fail.
 * @param {{
 *   refreshRequestedAt: string|number,
 *   refreshVisibleAt: string|number,
 *   staleBefore?: boolean,
 *   slaMs?: number,
 *   kind?: string,
 * }} input
 */
export function evaluateManualRefresh(input = {}) {
  const kind = input.kind || 'manual_refresh'
  const slaMs = input.slaMs ?? PUBLIC_PUBLICATION_SLA_MS
  const timed = evaluateTimedSla({
    kind,
    eventAt: input.refreshRequestedAt,
    visibleAt: input.refreshVisibleAt,
    slaMs,
  })
  return {
    kind,
    pass: timed.pass,
    scenario: 'manual_refresh',
    clock: 'server',
    slaMs,
    lagMs: timed.lagMs,
    staleBefore: input.staleBefore === true,
    error: timed.error,
    reason: timed.reason,
    outOfOrder: timed.outOfOrder,
    note:
      input.staleBefore === true
        ? 'stale_before_refresh_expected_not_auto_fail'
        : null,
  }
}

/**
 * Bundle reconnect / duplicate / OOO / manual-refresh scenario evaluations.
 * Used by self-test and unit tests for AC-PERF handling coverage.
 */
export function evaluateHandlingScenarios(scenarios = {}) {
  const reconnect = evaluateReconnectRecovery(
    scenarios.reconnect || {
      eventAt: '2026-07-14T10:00:00.000Z',
      disconnectAt: '2026-07-14T10:00:05.000Z',
      reconnectAt: '2026-07-14T10:00:10.000Z',
      reVisibleAt: '2026-07-14T10:00:20.000Z',
      slaMs: RUN_VISIBLE_SLA_MS,
    },
  )
  const duplicate = evaluateDuplicateDelivery(
    scenarios.duplicate || {
      eventAt: '2026-07-14T10:00:00.000Z',
      visibleAts: [
        '2026-07-14T10:00:12.000Z',
        '2026-07-14T10:00:12.000Z',
        '2026-07-14T10:00:18.000Z',
      ],
      eventId: 'evt-dup-1',
      slaMs: RUN_VISIBLE_SLA_MS,
    },
  )
  const outOfOrder = evaluateTimedSla(
    scenarios.outOfOrder || {
      kind: 'out_of_order_negative',
      eventAt: '2026-07-14T10:00:15.000Z',
      visibleAt: '2026-07-14T10:00:00.000Z', // visible 15s BEFORE event → lag -15000
      slaMs: RUN_VISIBLE_SLA_MS,
    },
  )
  const manualRefresh = evaluateManualRefresh(
    scenarios.manualRefresh || {
      refreshRequestedAt: '2026-07-14T10:00:00.000Z',
      refreshVisibleAt: '2026-07-14T10:00:08.000Z',
      staleBefore: true,
      slaMs: PUBLIC_PUBLICATION_SLA_MS,
    },
  )
  const rows = { reconnect, duplicate, outOfOrder, manualRefresh }
  // OOO row must FAIL; others use their pass flags
  const pass =
    reconnect.pass === true &&
    duplicate.pass === true &&
    outOfOrder.pass === false &&
    outOfOrder.error === 'out_of_order_negative_lag' &&
    manualRefresh.pass === true
  return { pass, clock: 'server', rows }
}

/**
 * Public freshness from snapshot fields (server-reported).
 * - publicationIntervalMs must be ≤ PUBLIC_PUBLICATION_SLA_MS (config contract)
 * - ageMs is server-reported age of material; age SLA for "public ≤60s" uses ageMs ≤ publicSlaMs
 * - forceStale (domain blockers) is reported but is NOT age-SLA failure by itself
 * - age-stale product threshold = ageMs > mult * publicationIntervalMs (documented, separate)
 */
export function evaluatePublicFreshnessFromSnapshot(freshness = {}, opts = {}) {
  const publicSlaMs = opts.publicSlaMs ?? PUBLIC_PUBLICATION_SLA_MS
  const ageStaleMult = opts.ageStaleMult ?? PUBLIC_AGE_STALE_MULT
  const intervalMs = freshness.publicationIntervalMs
  const ageMs = freshness.ageMs
  const stale = freshness.stale
  const generatedAt = freshness.generatedAt ?? freshness.publishedAt ?? null

  const checks = {
    intervalConfigured:
      intervalMs != null && Number.isFinite(intervalMs) && intervalMs <= publicSlaMs,
    ageWithinSla: ageMs != null && Number.isFinite(ageMs) ? ageMs <= publicSlaMs : null,
    ageStaleByProductRule:
      ageMs != null &&
      intervalMs != null &&
      Number.isFinite(ageMs) &&
      Number.isFinite(intervalMs)
        ? ageMs > ageStaleMult * intervalMs
        : null,
  }

  const reasons = []
  if (intervalMs == null || !Number.isFinite(intervalMs)) {
    reasons.push('publicationIntervalMs_missing')
  } else if (intervalMs > publicSlaMs) {
    reasons.push(`publicationIntervalMs>${publicSlaMs}`)
  }
  if (ageMs == null || !Number.isFinite(ageMs)) {
    reasons.push('ageMs_missing')
  } else if (ageMs > publicSlaMs) {
    reasons.push(`ageMs>${publicSlaMs}`)
  }

  // forceStale is orthogonal to age SLA
  const forceStaleLikely =
    stale === true &&
    ageMs != null &&
    Number.isFinite(ageMs) &&
    intervalMs != null &&
    Number.isFinite(intervalMs) &&
    ageMs <= ageStaleMult * intervalMs

  // Fail-closed: missing interval or age cannot prove public ≤60s
  const pass = checks.intervalConfigured === true && checks.ageWithinSla === true

  return {
    kind: 'public',
    pass,
    clock: 'server',
    publicSlaMs,
    publicationIntervalMs: intervalMs ?? null,
    ageMs: ageMs ?? null,
    stale: stale ?? null,
    generatedAt,
    forceStaleLikely,
    ageStaleMult,
    checks,
    reasons,
    residualNote: forceStaleLikely
      ? 'stale=true with age within product threshold → forceStale (domain blockers), not age SLA'
      : null,
  }
}

/**
 * Synthetic multi-surface timeline evaluation (runner / material / public).
 * All timestamps must be server-side ISO strings.
 */
export function evaluateFreshnessTimeline(timeline = {}, budgets = {}) {
  const runSla = budgets.runVisibleMs ?? RUN_VISIBLE_SLA_MS
  const matSla = budgets.materialMs ?? ACCOUNT_PUBLISH_SLA_MS
  const pubSla = budgets.publicMs ?? PUBLIC_PUBLICATION_SLA_MS

  const runner = evaluateTimedSla({
    kind: 'runner_visible',
    eventAt: timeline.runnerRegisteredAt,
    visibleAt: timeline.runnerVisibleAt,
    slaMs: runSla,
  })
  const material = evaluateTimedSla({
    kind: 'material_publish',
    eventAt: timeline.materialEventAt,
    visibleAt: timeline.materialVisibleAt,
    slaMs: matSla,
  })
  const publicTimed = evaluateTimedSla({
    kind: 'public_publish_lag',
    eventAt: timeline.publicEventAt,
    visibleAt: timeline.publicVisibleAt,
    slaMs: pubSla,
  })

  const rows = [runner, material, publicTimed]
  return {
    pass: rows.every((r) => r.pass),
    clock: 'server',
    rows,
    budgets: { runVisibleMs: runSla, materialMs: matSla, publicMs: pubSla },
  }
}

export function selfTest() {
  const t0 = '2026-07-14T10:00:00.000Z'
  const t15s = '2026-07-14T10:00:15.000Z'
  const t45s = '2026-07-14T10:00:45.000Z'
  const t90s = '2026-07-14T10:01:30.000Z'

  const runnerPass = evaluateTimedSla({
    kind: 'runner_visible',
    eventAt: t0,
    visibleAt: t15s,
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const runnerFail = evaluateTimedSla({
    kind: 'runner_visible',
    eventAt: t0,
    visibleAt: t45s,
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const badClock = evaluateTimedSla({
    kind: 'runner_visible',
    eventAt: 'not-a-date',
    visibleAt: t15s,
    slaMs: RUN_VISIBLE_SLA_MS,
  })

  // HARD: visibleAt 15s BEFORE eventAt → lagMs=-15000 must NEVER pass
  const oooNegative = evaluateTimedSla({
    kind: 'out_of_order_negative',
    eventAt: t15s,
    visibleAt: t0,
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const oooLag = serverClockLagMs(t15s, t0)

  const timelinePass = evaluateFreshnessTimeline(
    {
      runnerRegisteredAt: t0,
      runnerVisibleAt: t15s,
      materialEventAt: t0,
      materialVisibleAt: t15s,
      publicEventAt: t0,
      publicVisibleAt: t15s,
    },
    {},
  )
  const timelineFail = evaluateFreshnessTimeline(
    {
      runnerRegisteredAt: t0,
      runnerVisibleAt: t15s,
      materialEventAt: t0,
      materialVisibleAt: t15s,
      publicEventAt: t0,
      publicVisibleAt: t90s, // 90s > 60s
    },
    {},
  )
  // Timeline with OOO runner row must fail overall
  const timelineOoo = evaluateFreshnessTimeline(
    {
      runnerRegisteredAt: t15s,
      runnerVisibleAt: t0, // -15s
      materialEventAt: t0,
      materialVisibleAt: t15s,
      publicEventAt: t0,
      publicVisibleAt: t15s,
    },
    {},
  )

  const publicSnapOk = evaluatePublicFreshnessFromSnapshot({
    publicationIntervalMs: 60_000,
    ageMs: 0,
    stale: true,
    generatedAt: t0,
  })
  const publicSnapAgeFail = evaluatePublicFreshnessFromSnapshot({
    publicationIntervalMs: 60_000,
    ageMs: 90_000,
    stale: true,
    generatedAt: t0,
  })
  const publicMissing = evaluatePublicFreshnessFromSnapshot({})

  const lag = serverClockLagMs(t0, t15s)

  const reconnectOk = evaluateReconnectRecovery({
    eventAt: t0,
    disconnectAt: '2026-07-14T10:00:05.000Z',
    reconnectAt: '2026-07-14T10:00:10.000Z',
    reVisibleAt: '2026-07-14T10:00:20.000Z',
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const reconnectOoo = evaluateReconnectRecovery({
    eventAt: t0,
    disconnectAt: '2026-07-14T10:00:20.000Z',
    reconnectAt: '2026-07-14T10:00:10.000Z', // reconnect before disconnect
    reVisibleAt: '2026-07-14T10:00:25.000Z',
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const duplicateOk = evaluateDuplicateDelivery({
    eventAt: t0,
    visibleAts: [t15s, t15s, t45s],
    eventId: 'evt-1',
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const duplicateAllOoo = evaluateDuplicateDelivery({
    eventAt: t15s,
    visibleAts: [t0, t0],
    eventId: 'evt-ooo',
    slaMs: RUN_VISIBLE_SLA_MS,
  })
  const manualOk = evaluateManualRefresh({
    refreshRequestedAt: t0,
    refreshVisibleAt: t15s,
    staleBefore: true,
    slaMs: PUBLIC_PUBLICATION_SLA_MS,
  })
  const manualOoo = evaluateManualRefresh({
    refreshRequestedAt: t15s,
    refreshVisibleAt: t0,
    slaMs: PUBLIC_PUBLICATION_SLA_MS,
  })
  const handling = evaluateHandlingScenarios()

  const checks = {
    runnerPass: runnerPass.pass === true && runnerPass.lagMs === 15_000 && runnerPass.clock === 'server',
    runnerFail: runnerFail.pass === false && runnerFail.lagMs === 45_000,
    badClock: badClock.pass === false && badClock.error === 'invalid_server_timestamp',
    // -15000 must never pass
    oooNegativeFail:
      oooNegative.pass === false &&
      oooNegative.lagMs === -15_000 &&
      oooNegative.error === 'out_of_order_negative_lag' &&
      oooNegative.outOfOrder === true,
    oooLagFlag:
      oooLag.lagMs === -15_000 &&
      oooLag.error === 'out_of_order_negative_lag' &&
      oooLag.outOfOrder === true,
    timelinePass: timelinePass.pass === true && timelinePass.rows.length === 3,
    timelineFail: timelineFail.pass === false,
    timelineOooFail: timelineOoo.pass === false,
    publicSnapOk:
      publicSnapOk.pass === true &&
      publicSnapOk.forceStaleLikely === true &&
      publicSnapOk.checks.intervalConfigured === true,
    publicSnapAgeFail: publicSnapAgeFail.pass === false,
    publicMissing: publicMissing.pass === false,
    lag15s: lag.lagMs === 15_000 && lag.clock === 'server' && lag.outOfOrder === false,
    reconnectOk: reconnectOk.pass === true && reconnectOk.scenario === 'reconnect' && reconnectOk.lagMs === 10_000,
    reconnectOooFail: reconnectOoo.pass === false,
    duplicateOk:
      duplicateOk.pass === true &&
      duplicateOk.lagMs === 15_000 &&
      duplicateOk.duplicateCount === 3,
    duplicateAllOooFail:
      duplicateAllOoo.pass === false &&
      duplicateAllOoo.error === 'out_of_order_negative_lag',
    manualOk: manualOk.pass === true && manualOk.scenario === 'manual_refresh',
    manualOooFail:
      manualOoo.pass === false && manualOoo.error === 'out_of_order_negative_lag',
    handlingScenarios: handling.pass === true,
    constants:
      RUN_VISIBLE_SLA_MS === 30_000 &&
      ACCOUNT_PUBLISH_SLA_MS === 30_000 &&
      PUBLIC_PUBLICATION_SLA_MS === 60_000,
  }
  const ok = Object.values(checks).every(Boolean)
  return {
    ok,
    checks,
    sample: {
      runnerPass,
      publicSnapOk,
      timelinePass,
      oooNegative,
      reconnectOk,
      duplicateOk,
      manualOk,
      handling,
    },
  }
}

async function runLiveRo() {
  const base = resolveWebBase()
  const boardId = resolveBoardId('mfs-rebuild')
  const publicSlaMs = numEnv('PERF_PUBLIC_SLA_MS', PUBLIC_PUBLICATION_SLA_MS)
  const ageStaleMult = numEnv('PERF_PUBLIC_AGE_STALE_MULT', PUBLIC_AGE_STALE_MULT)
  const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`

  printOwnerTarget({
    flow: 'perf-freshness-sla',
    mode: 'live-ro',
    boardId,
    publicSlaMs,
  })

  const t0 = performance.now()
  let status = 0
  let body = null
  let stackError = null
  try {
    const res = await fetch(url, { headers: { accept: 'application/json' } })
    status = res.status
    const text = await res.text()
    try {
      body = JSON.parse(text)
    } catch (e) {
      stackError = `json_parse: ${String(e?.message || e)}`
    }
  } catch (e) {
    stackError = String(e?.message || e)
  }
  const clientWallMs = performance.now() - t0

  if (stackError || status !== 200 || !body) {
    return {
      ok: false,
      mode: 'live-ro',
      base,
      boardId,
      url,
      status,
      clientWallMs,
      stackError: stackError || `http_${status}`,
      class: stackError ? 'STACK' : 'APP_OR_STACK',
      residualGaps: [
        'runner/material timed SLAs not exercised in live-ro (read-only; no register)',
        'use --self-test for server-clock timeline unit proof',
      ],
    }
  }

  const freshness = body.freshness || {}
  const publicEval = evaluatePublicFreshnessFromSnapshot(freshness, {
    publicSlaMs,
    ageStaleMult,
  })

  return {
    ok: publicEval.pass,
    mode: 'live-ro',
    base,
    boardId,
    url,
    status,
    clientWallMs,
    clientWallNote: 'support only — PASS/FAIL uses server freshness fields',
    freshness: {
      publicationIntervalMs: freshness.publicationIntervalMs ?? null,
      ageMs: freshness.ageMs ?? null,
      stale: freshness.stale ?? null,
      generatedAt: freshness.generatedAt ?? null,
    },
    publicEval,
    residualGaps: [
      'runner_visible ≤30s not live-timed (no register_run in live-ro)',
      'material ≤30s not live-timed (no mutation in live-ro)',
      ...(publicEval.forceStaleLikely
        ? ['public stale=true is forceStale/domain blockers — not age SLA alone']
        : []),
      'full multi-surface timed proof requires owner-gated --live-mutate (not default)',
    ],
    class: publicEval.pass ? 'OK' : 'APP',
  }
}

async function main() {
  const flags = new Set(process.argv.filter((a) => a.startsWith('--')))

  if (flags.has('--live-mutate')) {
    console.log(
      JSON.stringify(
        {
          ok: false,
          mode: 'live-mutate',
          class: 'HARNESS',
          stackError:
            'live-mutate disabled in this harness build — owner gate required; use --self-test or --live-ro',
          residualGaps: [
            'register_run → multi-surface visible timed path not auto-run against shared staging',
          ],
        },
        null,
        2,
      ),
    )
    process.exit(1)
  }

  if (flags.has('--live-ro')) {
    const r = await runLiveRo()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  // default self-test
  const r = selfTest()
  console.log(JSON.stringify({ mode: 'self-test', ...r }, null, 2))
  process.exit(r.ok ? 0 : 1)
}

const isMain =
  process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main()
}
