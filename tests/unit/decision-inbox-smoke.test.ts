/**
 * Dedicated unit coverage for qa/e2e/flows/decision-inbox-smoke.mjs.
 * LOCAL ONLY — memory product engines via harness self-test; no staging mutation.
 */
import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FLOW = join(ROOT, 'qa/e2e/flows/decision-inbox-smoke.mjs')

async function loadHarness() {
  return import(pathToFileURL(FLOW).href)
}

describe('decision-inbox-smoke harness inventory', () => {
  it('flow module exists and exports stable API', async () => {
    expect(existsSync(FLOW)).toBe(true)
    const h = await loadHarness()
    expect(h.HARNESS_ID).toBe('decision-inbox-smoke-v1')
    expect(typeof h.checkStagingMutationGates).toBe('function')
    expect(typeof h.buildStagingDecisionInboxPlan).toBe('function')
    expect(typeof h.buildCleanupPlan).toBe('function')
    expect(typeof h.runDecisionInboxSelfTests).toBe('function')
    expect(typeof h.runGatedStagingPath).toBe('function')
    expect(Array.isArray(h.SCENARIO_MATRIX)).toBe(true)
    const ids = h.SCENARIO_MATRIX.map((s: { id: string }) => s.id)
    expect(ids).toEqual([
      'AC-ORDER',
      'AC-BLOCK-SNOOZE',
      'AC-ACK',
      'AC-RESOLVED',
      'AC-REJECTED',
      'AC-EXPIRED',
      'AC-SCOPED-APPROVAL',
      'AC-REV-CAS',
      'AC-IDEMPOTENCY',
      'AC-OWNER-ONLY',
      'AC-AUDIT',
    ])
  })
})

describe('staging mutation gates (fail-closed)', () => {
  it('refuses without exact dual gates', async () => {
    const h = await loadHarness()
    const r = h.checkStagingMutationGates({})
    expect(r.ok).toBe(false)
    expect(r.code).toBe('CAIRN_DECISION_INBOX_GATES_REFUSED')
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
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'open_blocking_critical')).toBe(
      true,
    )
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'resolve_owner_ok')).toBe(true)
    expect(r.plan.steps.some((s: { id: string }) => s.id === 'list_audit_readback')).toBe(true)
    expect(r.cleanup?.decisionIdPrefix).toBe(h.SYNTH_PREFIX)
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
      CAIRN_DECISION_INBOX_EXECUTE: '1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DECISION_INBOX_EXECUTE_TARGET_MISSING')
    expect(r.stagingMutation).toBe(false)
  })

  it('EXECUTE + URL + bearer still does not auto-mutate (operator gate)', async () => {
    const h = await loadHarness()
    const r = h.runGatedStagingPath({
      ...h.REQUIRED_STAGING_ENV,
      CAIRN_DECISION_INBOX_EXECUTE: '1',
      STAGING_URL: 'http://127.0.0.1:9',
      STAGING_ROOT_BEARER_TOKEN: 'not-a-real-token-for-unit',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('DECISION_INBOX_LIVE_MCP_NOT_AUTO_EXECUTED')
    expect(r.stagingMutation).toBe(false)
    expect(r.plan?.steps?.length).toBeGreaterThan(0)
    expect(r.cleanup?.steps?.length).toBeGreaterThan(0)
  })
})

describe('plan + cleanup inventory', () => {
  it('covers order/ack/resolve/audit steps and residual gaps', async () => {
    const h = await loadHarness()
    const plan = h.buildStagingDecisionInboxPlan({ boardId: 'mfs-rebuild' })
    expect(plan.harnessId).toBe(h.HARNESS_ID)
    const stepIds = plan.steps.map((s: { id: string }) => s.id)
    expect(stepIds).toContain('list_decisions_order')
    expect(stepIds).toContain('open_blocking_critical')
    expect(stepIds).toContain('resolve_stale_rev_negative')
    expect(stepIds).toContain('resolve_owner_ok')
    expect(stepIds).toContain('resolve_non_owner_negative')
    expect(stepIds).toContain('open_idempotent_replay')
    expect(stepIds).toContain('list_audit_readback')
    expect(stepIds).toContain('cleanup_synth')
    expect(plan.residual_gaps).toContain('live_staging_not_exercised_in_plan_mode')
    expect(plan.scenarios.map((s: { id: string }) => s.id)).toEqual(
      h.SCENARIO_MATRIX.map((s: { id: string }) => s.id),
    )

    const cleanup = h.buildCleanupPlan({ boardId: 'mfs-rebuild' })
    expect(cleanup.decisionIdPrefix).toBe('synth-di-')
    expect(cleanup.stagingMutation).toBe(false)
    expect(cleanup.steps.some((s: { id: string }) => s.id === 'terminal_or_cancel_synth')).toBe(
      true,
    )
  })
})

describe('product self-test (memory engines)', () => {
  it('runDecisionInboxSelfTests passes all AC + inventory checks', async () => {
    const h = await loadHarness()
    const result = await h.runDecisionInboxSelfTests({ boardId: 'mfs-rebuild' })
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
    expect(byId['AC-ORDER']).toBe(true)
    expect(byId['AC-BLOCK-SNOOZE']).toBe(true)
    expect(byId['AC-ACK']).toBe(true)
    expect(byId['AC-RESOLVED']).toBe(true)
    expect(byId['AC-REJECTED']).toBe(true)
    expect(byId['AC-EXPIRED']).toBe(true)
    expect(byId['AC-SCOPED-APPROVAL']).toBe(true)
    expect(byId['AC-REV-CAS']).toBe(true)
    expect(byId['AC-IDEMPOTENCY']).toBe(true)
    expect(byId['AC-OWNER-ONLY']).toBe(true)
    expect(byId['AC-AUDIT']).toBe(true)
    expect(byId['SCENARIO-INVENTORY']).toBe(true)
    expect(byId['STAGING-GATES']).toBe(true)
    expect(result.residual_gaps).toContain(
      'live_staging_mcp_not_exercised_self_test_only',
    )
  }, 60_000)
})
