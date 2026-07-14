/**
 * Dedicated unit coverage for qa/e2e/flows/lock-reconcile-smoke.mjs.
 * LOCAL ONLY — memory product engines via harness self-test; no staging mutation.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FLOW = join(ROOT, 'qa/e2e/flows/lock-reconcile-smoke.mjs')

async function loadHarness() {
  return import(pathToFileURL(FLOW).href)
}

describe('lock-reconcile-smoke harness inventory', () => {
  it('flow module exists and exports stable API', async () => {
    expect(existsSync(FLOW)).toBe(true)
    const h = await loadHarness()
    expect(h.HARNESS_ID).toBe('lock-reconcile-smoke-v1')
    expect(h.SYNTH_PREFIX).toBe('synth-lr-')
    expect(typeof h.checkStagingMutationGates).toBe('function')
    expect(typeof h.buildStagingLockReconcilePlan).toBe('function')
    expect(typeof h.buildCleanupPlan).toBe('function')
    expect(typeof h.runLockReconcileSelfTests).toBe('function')
    expect(typeof h.runGatedStagingPath).toBe('function')
    expect(Array.isArray(h.SCENARIO_MATRIX)).toBe(true)
    const ids = h.SCENARIO_MATRIX.map((s: { id: string }) => s.id)
    expect(ids).toEqual([
      'AC-LOCK-01',
      'AC-LOCK-02',
      'AC-LOCK-03',
      'AC-LOCK-04',
      'RECONCILE-DRY-APPLY',
    ])
  })
})

describe('staging mutation gates (fail-closed)', () => {
  it('refuses without exact dual gates', async () => {
    const h = await loadHarness()
    const r = h.checkStagingMutationGates({})
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CAIRN_LOCK_RECONCILE_GATES_REFUSED')
    expect(r.missing.length).toBeGreaterThanOrEqual(5)
    expect(r.executeAllowed).toBe(false)
  })

  it('accepts exact required env but keeps execute off by default', async () => {
    const h = await loadHarness()
    const r = h.checkStagingMutationGates({ ...h.REQUIRED_STAGING_ENV })
    expect(r.ok).toBe(true)
    expect(r.executeAllowed).toBe(false)
    expect(r.executeRequested).toBe(false)
  })

  it('runGatedStagingPath returns plan when gates ok without EXECUTE', async () => {
    const h = await loadHarness()
    const r = h.runGatedStagingPath({ ...h.REQUIRED_STAGING_ENV })
    expect(r.ok).toBe(true)
    expect(r.mode).toBe('apply-plan')
    expect(r.stagingMutation).toBe(false)
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'reconcile_dry_run')).toBe(
      true,
    )
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'register_run_overlap_reject')).toBe(
      true,
    )
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'post_suite_cleanup')).toBe(true)
    expect(r.cleanup?.runIdPrefix).toBe(h.SYNTH_PREFIX)
    expect(r.cleanup?.stagingMutation).toBe(false)
  })

  it('runGatedStagingPath refuses empty env', async () => {
    const h = await loadHarness()
    const r = h.runGatedStagingPath({})
    expect(r.ok).toBe(false)
    expect(r.mode).toBe('apply-refused')
    expect(r.stagingMutation).toBe(false)
  })

  it('EXECUTE without URL/bearer refuses live path', async () => {
    const h = await loadHarness()
    const r = h.runGatedStagingPath({
      ...h.REQUIRED_STAGING_ENV,
      CAIRN_LOCK_RECONCILE_EXECUTE: '1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('LOCK_RECONCILE_EXECUTE_TARGET_MISSING')
    expect(r.stagingMutation).toBe(false)
  })

  it('EXECUTE + URL + bearer still does not auto-mutate (operator gate)', async () => {
    const h = await loadHarness()
    const r = h.runGatedStagingPath({
      ...h.REQUIRED_STAGING_ENV,
      CAIRN_LOCK_RECONCILE_EXECUTE: '1',
      STAGING_URL: 'http://127.0.0.1:9',
      STAGING_ROOT_BEARER_TOKEN: 'not-a-real-token-for-unit',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('LOCK_RECONCILE_LIVE_MCP_NOT_AUTO_EXECUTED')
    expect(r.stagingMutation).toBe(false)
    expect(r.plan?.steps?.length).toBeGreaterThan(0)
    expect(r.cleanup?.steps?.length).toBeGreaterThan(0)
  })
})

describe('plan + cleanup inventory', () => {
  it('covers AC-LOCK + reconcile steps and residual gaps', async () => {
    const h = await loadHarness()
    const plan = h.buildStagingLockReconcilePlan({ boardId: 'mfs-rebuild' })
    expect(plan.harnessId).toBe(h.HARNESS_ID)
    const stepIds = plan.steps.map((s: { id: string }) => s.id)
    expect(stepIds).toContain('register_run_overlap_reject')
    expect(stepIds).toContain('terminate_release')
    expect(stepIds).toContain('integration_lock_second_reject')
    expect(stepIds).toContain('reconcile_dry_run')
    expect(stepIds).toContain('reconcile_apply')
    expect(stepIds).toContain('reconcile_apply_idempotent')
    expect(stepIds).toContain('post_suite_cleanup')
    expect(plan.residual_gaps).toContain('live_staging_not_exercised_in_plan_mode')
    expect(plan.scenarios.map((s: { id: string }) => s.id)).toEqual(
      h.SCENARIO_MATRIX.map((s: { id: string }) => s.id),
    )

    const cleanup = h.buildCleanupPlan({ boardId: 'mfs-rebuild' })
    expect(cleanup.runIdPrefix).toBe('synth-lr-')
    expect(cleanup.stagingMutation).toBe(false)
    expect(cleanup.mode).toBe('cleanup-plan')
    expect(cleanup.steps.some((s: { id: string }) => s.id === 'release_collision_held')).toBe(
      true,
    )
    expect(cleanup.steps.some((s: { id: string }) => s.id === 'release_integration_held')).toBe(
      true,
    )
    expect(cleanup.steps.some((s: { id: string }) => s.id === 'idempotent_rerelease')).toBe(true)
    expect(cleanup.steps.some((s: { id: string }) => s.id === 'verify_zero_held_synth')).toBe(
      true,
    )
  })
})

describe('product self-test (memory engines)', () => {
  it('runLockReconcileSelfTests passes all AC-LOCK + reconcile checks', async () => {
    const h = await loadHarness()
    const result = await h.runLockReconcileSelfTests({ boardId: 'mfs-rebuild' })
    if (!result.ok) {
      // surface failures for diagnosis without soft-paraphrasing
      // eslint-disable-next-line no-console
      console.error(JSON.stringify(result.failures, null, 2))
    }
    expect(result.ok).toBe(true)
    expect(result.mode).toBe('self-test')
    expect(result.stagingMutation).toBe(false)
    expect(result.harnessId).toBe(h.HARNESS_ID)
    expect(result.passCount).toBe(result.checkCount)
    expect(result.failures).toEqual([])

    const byId = Object.fromEntries(
      result.checks.map((c: { id: string; ok: boolean }) => [c.id, c.ok]),
    )
    expect(byId['AC-LOCK-01']).toBe(true)
    expect(byId['AC-LOCK-02']).toBe(true)
    expect(byId['AC-LOCK-03']).toBe(true)
    expect(byId['AC-LOCK-04']).toBe(true)
    expect(byId['RECONCILE-DRY-APPLY']).toBe(true)
    expect(byId['SCENARIO-INVENTORY']).toBe(true)
    expect(byId['POST-SUITE-RELEASE']).toBe(true)
    expect(byId['STAGING-GATES']).toBe(true)
    expect(result.cleanup?.runIdPrefix).toBe(h.SYNTH_PREFIX)
    expect(result.residual_gaps).toContain(
      'live_staging_mcp_not_exercised_self_test_only',
    )
    expect(result.residual_gaps).toContain('cleanup_not_auto_executed')
  }, 60_000)
})
