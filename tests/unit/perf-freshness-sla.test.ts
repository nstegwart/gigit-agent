/**
 * Deterministic unit tests for qa/e2e/flows/perf-freshness-sla.mjs pure helpers.
 * LOCAL ONLY — no network, no staging mutation.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/perf-freshness-sla.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

describe('perf-freshness-sla helpers', () => {
  it('serverClockLagMs uses server timestamps only', async () => {
    const m = await loadFlow()
    const lag = m.serverClockLagMs('2026-07-14T10:00:00.000Z', '2026-07-14T10:00:20.000Z')
    expect(lag.clock).toBe('server')
    expect(lag.lagMs).toBe(20_000)
    expect(lag.error).toBeNull()
    const bad = m.serverClockLagMs('nope', '2026-07-14T10:00:00.000Z')
    expect(bad.lagMs).toBeNull()
    expect(bad.error).toBe('invalid_server_timestamp')
  })

  it('runner/material/public timed SLAs use server clock', async () => {
    const m = await loadFlow()
    const pass = m.evaluateTimedSla({
      kind: 'runner_visible',
      eventAt: '2026-07-14T10:00:00.000Z',
      visibleAt: '2026-07-14T10:00:10.000Z',
      slaMs: m.RUN_VISIBLE_SLA_MS,
    })
    expect(pass.pass).toBe(true)
    expect(pass.lagMs).toBe(10_000)
    expect(pass.clock).toBe('server')

    const fail = m.evaluateTimedSla({
      kind: 'material_publish',
      eventAt: '2026-07-14T10:00:00.000Z',
      visibleAt: '2026-07-14T10:00:45.000Z',
      slaMs: m.ACCOUNT_PUBLISH_SLA_MS,
    })
    expect(fail.pass).toBe(false)
    expect(fail.lagMs).toBe(45_000)
  })

  it('evaluateFreshnessTimeline requires all three rows', async () => {
    const m = await loadFlow()
    const t0 = '2026-07-14T10:00:00.000Z'
    const t10 = '2026-07-14T10:00:10.000Z'
    const ok = m.evaluateFreshnessTimeline({
      runnerRegisteredAt: t0,
      runnerVisibleAt: t10,
      materialEventAt: t0,
      materialVisibleAt: t10,
      publicEventAt: t0,
      publicVisibleAt: t10,
    })
    expect(ok.pass).toBe(true)
    expect(ok.rows).toHaveLength(3)
    expect(ok.clock).toBe('server')
  })

  it('public snapshot evaluator fail-closes on missing age; forceStale ≠ age fail', async () => {
    const m = await loadFlow()
    const forceStale = m.evaluatePublicFreshnessFromSnapshot({
      publicationIntervalMs: 60_000,
      ageMs: 0,
      stale: true,
      generatedAt: '2026-07-14T10:00:00.000Z',
    })
    expect(forceStale.pass).toBe(true)
    expect(forceStale.forceStaleLikely).toBe(true)
    expect(forceStale.clock).toBe('server')

    const ageFail = m.evaluatePublicFreshnessFromSnapshot({
      publicationIntervalMs: 60_000,
      ageMs: 90_000,
      stale: true,
    })
    expect(ageFail.pass).toBe(false)

    const missing = m.evaluatePublicFreshnessFromSnapshot({})
    expect(missing.pass).toBe(false)
  })

  it('rejects out-of-order negative lag (-15000 must never pass)', async () => {
    const m = await loadFlow()
    const eventAt = '2026-07-14T10:00:15.000Z'
    const visibleAt = '2026-07-14T10:00:00.000Z' // 15s before event
    const lag = m.serverClockLagMs(eventAt, visibleAt)
    expect(lag.lagMs).toBe(-15_000)
    expect(lag.error).toBe('out_of_order_negative_lag')
    expect(lag.outOfOrder).toBe(true)

    const timed = m.evaluateTimedSla({
      kind: 'ooo',
      eventAt,
      visibleAt,
      slaMs: m.RUN_VISIBLE_SLA_MS,
    })
    expect(timed.pass).toBe(false)
    expect(timed.lagMs).toBe(-15_000)
    expect(timed.error).toBe('out_of_order_negative_lag')
    // Even though -15000 <= 30000 numerically, must not pass
    expect(timed.pass).not.toBe(true)
  })

  it('evaluateReconnectRecovery passes ordered reconnect; fails OOO chain', async () => {
    const m = await loadFlow()
    const ok = m.evaluateReconnectRecovery({
      eventAt: '2026-07-14T10:00:00.000Z',
      disconnectAt: '2026-07-14T10:00:05.000Z',
      reconnectAt: '2026-07-14T10:00:10.000Z',
      reVisibleAt: '2026-07-14T10:00:20.000Z',
      slaMs: 30_000,
    })
    expect(ok.pass).toBe(true)
    expect(ok.scenario).toBe('reconnect')
    expect(ok.lagMs).toBe(10_000)

    const bad = m.evaluateReconnectRecovery({
      eventAt: '2026-07-14T10:00:00.000Z',
      disconnectAt: '2026-07-14T10:00:20.000Z',
      reconnectAt: '2026-07-14T10:00:10.000Z',
      reVisibleAt: '2026-07-14T10:00:25.000Z',
      slaMs: 30_000,
    })
    expect(bad.pass).toBe(false)
  })

  it('evaluateDuplicateDelivery normalizes earliest valid; all-OOO fails', async () => {
    const m = await loadFlow()
    const ok = m.evaluateDuplicateDelivery({
      eventAt: '2026-07-14T10:00:00.000Z',
      visibleAts: [
        '2026-07-14T10:00:12.000Z',
        '2026-07-14T10:00:12.000Z',
        '2026-07-14T10:00:18.000Z',
      ],
      eventId: 'e1',
      slaMs: 30_000,
    })
    expect(ok.pass).toBe(true)
    expect(ok.lagMs).toBe(12_000)
    expect(ok.duplicateCount).toBe(3)

    const allOoo = m.evaluateDuplicateDelivery({
      eventAt: '2026-07-14T10:00:15.000Z',
      visibleAts: ['2026-07-14T10:00:00.000Z', '2026-07-14T10:00:01.000Z'],
      slaMs: 30_000,
    })
    expect(allOoo.pass).toBe(false)
    expect(allOoo.error).toBe('out_of_order_negative_lag')
  })

  it('evaluateManualRefresh server-clock; OOO fails; staleBefore not auto-fail', async () => {
    const m = await loadFlow()
    const ok = m.evaluateManualRefresh({
      refreshRequestedAt: '2026-07-14T10:00:00.000Z',
      refreshVisibleAt: '2026-07-14T10:00:08.000Z',
      staleBefore: true,
      slaMs: 60_000,
    })
    expect(ok.pass).toBe(true)
    expect(ok.scenario).toBe('manual_refresh')
    expect(ok.staleBefore).toBe(true)

    const ooo = m.evaluateManualRefresh({
      refreshRequestedAt: '2026-07-14T10:00:15.000Z',
      refreshVisibleAt: '2026-07-14T10:00:00.000Z',
      slaMs: 60_000,
    })
    expect(ooo.pass).toBe(false)
    expect(ooo.error).toBe('out_of_order_negative_lag')
  })

  it('evaluateHandlingScenarios covers reconnect/dup/OOO/manual', async () => {
    const m = await loadFlow()
    const r = m.evaluateHandlingScenarios()
    expect(r.pass).toBe(true)
    expect(r.rows.outOfOrder.pass).toBe(false)
    expect(r.rows.outOfOrder.lagMs).toBe(-15_000)
    expect(r.rows.reconnect.pass).toBe(true)
    expect(r.rows.duplicate.pass).toBe(true)
    expect(r.rows.manualRefresh.pass).toBe(true)
  })

  it('selfTest() passes', async () => {
    const m = await loadFlow()
    const r = m.selfTest()
    expect(r.ok).toBe(true)
    expect(r.checks.constants).toBe(true)
    expect(r.checks.oooNegativeFail).toBe(true)
    expect(r.checks.reconnectOk).toBe(true)
    expect(r.checks.handlingScenarios).toBe(true)
  })
})
