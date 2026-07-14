/**
 * Dedicated tests for qa/e2e/flows/staging-alert-selftest.mjs
 *
 * Injects sanctioned product hooks from #/server/observability-integration
 * (createObservabilityIntegration / evaluateAlerts / memory registry /
 * setSharedObservabilityIntegrationForTests). LOCAL ONLY — no live mutation.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterEach, describe, expect, it } from 'vitest'

import {
  STAGING_RUNBOOKS,
  V3_ALERT_IDS,
  createMemoryLogSink,
  createObservabilityIntegration,
  resetSharedObservabilityIntegration,
  runbookForAlert,
  setSharedObservabilityIntegrationForTests,
} from '#/server/observability-integration'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/staging-alert-selftest.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

function productHooks() {
  return {
    createObservabilityIntegration,
    V3_ALERT_IDS,
    STAGING_RUNBOOKS,
    setSharedObservabilityIntegrationForTests,
    resetSharedObservabilityIntegration,
    createMemoryLogSink,
    runbookForAlert,
  }
}

describe('staging-alert-selftest harness', () => {
  afterEach(() => {
    setSharedObservabilityIntegrationForTests(null)
    resetSharedObservabilityIntegration()
  })

  it('fail-closed when no authorized hooks (null)', async () => {
    const m = await loadFlow()
    const r = m.runAlertSelfTest(null)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NO_AUTHORIZED_HOOK')
    expect(r.results.some((x: { name: string; pass: boolean }) => x.name === 'authorized-hooks' && !x.pass)).toBe(
      true,
    )
  })

  it('fail-closed when hooks missing createObservabilityIntegration', async () => {
    const m = await loadFlow()
    const r = m.runAlertSelfTest({
      V3_ALERT_IDS,
      STAGING_RUNBOOKS,
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('NO_AUTHORIZED_HOOK')
    expect(r.results[0]?.detail?.missing).toContain('createObservabilityIntegration')
  })

  it('runFailClosedNoHookProbe asserts refuse-open behavior', async () => {
    const m = await loadFlow()
    const r = m.runFailClosedNoHookProbe()
    expect(r.ok).toBe(true)
    expect(r.results[0]?.name).toBe('fail-closed-no-hook')
    expect(r.results[0]?.pass).toBe(true)
  })

  it('resolveAuthorizedHooks accepts full product surface', async () => {
    const m = await loadFlow()
    const g = m.resolveAuthorizedHooks(productHooks())
    expect(g.ok).toBe(true)
    expect(g.hooks.createObservabilityIntegration).toBeTypeOf('function')
  })

  it('self-test activates all required alerts with runbooks via memory registry', async () => {
    const m = await loadFlow()
    const r = m.runAlertSelfTest(productHooks())
    const failed = r.results.filter((x: { pass: boolean }) => !x.pass)
    expect(r.ok, JSON.stringify(failed, null, 2)).toBe(true)
    expect(r.summary.failCount).toBe(0)
    expect(r.summary.alertDrills).toBe(7)

    for (const drill of m.REQUIRED_ALERT_DRILLS) {
      const breach = r.results.find(
        (x: { name: string }) => x.name === `breach-${drill.id}`,
      )
      expect(breach?.pass, drill.id).toBe(true)
      const targeted = r.results.find(
        (x: { name: string }) => x.name === `targeted-${drill.id}`,
      )
      expect(targeted?.pass, `targeted ${drill.id}`).toBe(true)
    }

    expect(
      r.results.find((x: { name: string }) => x.name === 'clear-all-healthy')?.pass,
    ).toBe(true)
    expect(
      r.results.find((x: { name: string }) => x.name === 'integration-selfTest')?.pass,
    ).toBe(true)
  })

  it('REQUIRED_ALERT_DRILLS covers healthz mismatch, freshness>2x, account sync, import, lock, latency', async () => {
    const m = await loadFlow()
    const ids = new Set(m.REQUIRED_ALERT_DRILLS.map((d: { id: string }) => d.id))
    expect(ids.has('UNHEALTHY_RELEASE_SCHEMA_MISMATCH')).toBe(true)
    expect(ids.has('PUBLIC_FRESHNESS_STALE')).toBe(true)
    expect(ids.has('ACCOUNT_SYNC_STALE')).toBe(true)
    expect(ids.has('REPEATED_IMPORT_RECONCILE_FAILURE')).toBe(true)
    expect(ids.has('CLAIM_LOCK_ANOMALY')).toBe(true)
    expect(ids.has('ERROR_LATENCY_BUDGET_BREACH')).toBe(true)
    // full V3 catalog also includes LIVE_MCP
    expect(ids.has('LIVE_MCP_UNAUTHORIZED_EXPOSURE')).toBe(true)
    expect(m.REQUIRED_ALERT_DRILLS).toHaveLength(7)
  })

  it('buildBreachSignals exceeds 2× publication interval for freshness', async () => {
    const m = await loadFlow()
    const s = m.buildBreachSignals('2026-07-14T04:00:00.000Z')
    expect(s.publicSnapshotAgeMs).toBeGreaterThan(2 * s.publicationIntervalMs)
    expect(s.releaseMatch).toBe(false)
    expect(s.schemaMatch).toBe(false)
    expect(s.claimLockAnomaly).toBe(true)
    expect(s.repeatedImportReconcileFailures).toBeGreaterThanOrEqual(3)
    expect(s.accountSyncAgeMs).toBeGreaterThan(15 * 60 * 1000)
    expect(s.p95LatencyMs).toBeGreaterThan(500)
    expect(s.errorRate).toBeGreaterThan(0.01)
  })

  it('buildTargetedBreachSignals activates only the named alert via product evaluateAlerts', async () => {
    const m = await loadFlow()
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-14T04:00:00.000Z',
    })
    for (const drill of m.REQUIRED_ALERT_DRILLS) {
      const signals = m.buildTargetedBreachSignals(drill.id)
      const evals = obs.evaluateAlerts(signals)
      const active = evals.filter((e) => e.state.active).map((e) => e.alertId)
      expect(active, drill.id).toEqual([drill.id])
      expect(obs.alerts.get(drill.id)?.active).toBe(true)
      // clear before next
      obs.evaluateAlerts(m.buildHealthySignals())
    }
  })

  it('parseArgs defaults to self-test; --real selects real mode', async () => {
    const m = await loadFlow()
    expect(m.parseArgs([]).selfTest).toBe(true)
    expect(m.parseArgs([]).real).toBe(false)
    expect(m.parseArgs(['--self-test']).selfTest).toBe(true)
    expect(m.parseArgs(['--real']).real).toBe(true)
    expect(m.parseArgs(['--real']).selfTest).toBe(false)
  })
})
