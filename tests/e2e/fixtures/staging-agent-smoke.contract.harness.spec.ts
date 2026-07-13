/**
 * Staging agent MCP smoke — contract harness (no server / no staging tunnel).
 * Project: harness-contract (*.contract.harness.spec.ts)
 *
 * Full real remote: node qa/e2e/flows/staging-agent-smoke.mjs --real
 */
import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'

const ROOT = process.cwd()
const require = createRequire(import.meta.url)

// Dynamic import of ESM fixture + smoke lib (Node harness).
async function loadContract() {
  const fixtureUrl = pathToFileUrl(path.join(ROOT, 'qa/fixtures/staging/contract.mjs'))
  return import(fixtureUrl.href)
}

async function loadSmokeLib() {
  const libUrl = pathToFileUrl(path.join(ROOT, 'qa/e2e/lib/staging-agent-smoke.mjs'))
  return import(libUrl.href)
}

function pathToFileUrl(p: string) {
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  return pathToFileURL(p)
}

test.describe('staging-agent-smoke contract (no server)', () => {
  test('fixture MANIFEST + pin + seeds validate', async () => {
    const c = await loadContract()
    const v = c.validateStagingFixtureContract()
    expect(v.ok, v.errors?.join('; ')).toBe(true)
    expect(v.manifest.boardId).toBe('mfs-rebuild')
    expect(v.manifest.syntheticOnly).toBe(true)
    expect(v.manifest.productionDerived).toBe(false)
    expect(v.pin.canonicalSnapshotId).toBeTruthy()
    expect(v.pin.taskHash).toMatch(/^[0-9a-f]{64}$/i)
    expect(v.manifest.requiredMcpTools).toEqual(
      expect.arrayContaining([
        'publish_dispatch_plan',
        'get_next',
        'sync_accounts',
        'register_run',
        'heartbeat_run',
        'list_tasks',
        'get_rollup',
        'list_audit',
      ]),
    )
  })

  test('unique synthetic ids embed smokeRunId and diverge per run', async () => {
    const c = await loadContract()
    const a = c.buildSyntheticSmokeIds({ smokeRunId: 'idA', boardId: 'mfs-rebuild' })
    const b = c.buildSyntheticSmokeIds({ smokeRunId: 'idB', boardId: 'mfs-rebuild' })
    expect(a.planId).toContain('idA')
    expect(a.runId).toContain('idA')
    expect(a.agentId).toContain('idA')
    expect(a.planId).not.toBe(b.planId)
    expect(a.runId).not.toBe(b.runId)
    expect(a.planId.startsWith('synth-stg-smoke') || a.planId.includes('synth-stg-smoke')).toBe(
      true,
    )
  })

  test('dispatch planHash is stable authority recompute; tamper diverges', async () => {
    const c = await loadContract()
    const pin = c.loadStagingPin()
    const ids = c.buildSyntheticSmokeIds({ smokeRunId: 'hash01', boardId: 'mfs-rebuild' })
    const plan = c.buildDispatchPlanArgs({
      pin,
      ids,
      now: '2026-07-13T00:00:00.000Z',
    })
    const again = c.computePlanHash({
      boardId: plan.boardId,
      planId: plan.planId,
      planVersion: plan.planVersion,
      canonicalSnapshotId: plan.canonicalSnapshotId,
      canonicalHash: plan.canonicalHash,
      items: plan.items,
    })
    expect(again).toBe(plan.planHash)
    const tampered = c.computePlanHash({
      boardId: plan.boardId,
      planId: 'other-plan',
      planVersion: plan.planVersion,
      canonicalSnapshotId: plan.canonicalSnapshotId,
      canonicalHash: plan.canonicalHash,
      items: plan.items,
    })
    expect(tampered).not.toBe(plan.planHash)
  })

  test('account sync seed has no credential keys', async () => {
    const c = await loadContract()
    const sync = c.buildAccountSyncArgs({
      pin: c.loadStagingPin(),
      ids: c.buildSyntheticSmokeIds({ smokeRunId: 'acc01' }),
      now: '2026-07-13T00:00:00.000Z',
    })
    const blob = JSON.stringify(sync.accounts)
    expect(blob).not.toMatch(/"(token|secret|password|authorization|apiKey|api_key|credential)"\s*:/i)
    expect(sync.accounts.length).toBeGreaterThanOrEqual(1)
    expect(sync.accounts[0].maskedAccountId).toMatch(/^acc_synth/)
  })

  test('token ref resolution never embeds secret in meta', async () => {
    const s = await loadSmokeLib()
    const missing = s.resolveAuthorizedTokenRef({})
    expect(missing.ok).toBe(false)
    expect(missing.meta.present).toBe(false)

    const secret = `test-secret-${'z'.repeat(32)}`
    const present = s.resolveAuthorizedTokenRef({ STAGING_BEARER_TOKEN: secret })
    expect(present.ok).toBe(true)
    expect(present.tokenRef).toBe('STAGING_BEARER_TOKEN')
    expect(present.meta.present).toBe(true)
    expect(JSON.stringify(present.meta)).not.toContain(secret)
    present.bearer = ''
  })

  test('dual principal: root prefers STAGING_ROOT_BEARER_TOKEN; agent required fail-closed', async () => {
    const s = await loadSmokeLib()
    const rootSecret = `root-${'r'.repeat(40)}`
    const agentSecret = `agent-${'a'.repeat(40)}`

    const preferred = s.resolveRootTokenRef({
      STAGING_ROOT_BEARER_TOKEN: rootSecret,
      STAGING_BEARER_TOKEN: 'legacy-fallback',
    })
    expect(preferred.ok).toBe(true)
    expect(preferred.tokenRef).toBe('STAGING_ROOT_BEARER_TOKEN')
    expect(JSON.stringify(preferred.meta)).not.toContain(rootSecret)
    preferred.bearer = ''

    const legacy = s.resolveRootTokenRef({ STAGING_BEARER_TOKEN: rootSecret })
    expect(legacy.ok).toBe(true)
    expect(legacy.tokenRef).toBe('STAGING_BEARER_TOKEN')
    legacy.bearer = ''

    const missingAgent = s.resolveDualPrincipalTokens(
      { STAGING_ROOT_BEARER_TOKEN: rootSecret },
      { requireAgent: true, requireAgentId: true },
    )
    expect(missingAgent.ok).toBe(false)
    expect(missingAgent.code).toBe('MISSING_AGENT_BEARER')

    const missingId = s.resolveDualPrincipalTokens(
      {
        STAGING_ROOT_BEARER_TOKEN: rootSecret,
        STAGING_AGENT_BEARER_TOKEN: agentSecret,
      },
      { requireAgent: true, requireAgentId: true },
    )
    expect(missingId.ok).toBe(false)
    expect(missingId.code).toBe('MISSING_AGENT_ID')

    const dual = s.resolveDualPrincipalTokens(
      {
        STAGING_ROOT_BEARER_TOKEN: rootSecret,
        STAGING_AGENT_BEARER_TOKEN: agentSecret,
        STAGING_AGENT_ID: 'staging-agent-1',
      },
      { requireAgent: true, requireAgentId: true },
    )
    expect(dual.ok).toBe(true)
    expect(dual.root.tokenRef).toBe('STAGING_ROOT_BEARER_TOKEN')
    expect(dual.agent.tokenRef).toBe('STAGING_AGENT_BEARER_TOKEN')
    expect(dual.agentId).toBe('staging-agent-1')
    expect(JSON.stringify(dual.meta)).not.toContain(rootSecret)
    expect(JSON.stringify(dual.meta)).not.toContain(agentSecret)
    if (dual.root) dual.root.bearer = ''
    if (dual.agent) dual.agent.bearer = ''

    // Role tool gates are distinct (root publish/get_next/sync; agent register/heartbeat)
    expect(s.ROOT_REQUIRED_MCP_TOOLS).toEqual(
      expect.arrayContaining(['publish_dispatch_plan', 'get_next', 'sync_accounts']),
    )
    expect(s.AGENT_REQUIRED_MCP_TOOLS).toEqual(
      expect.arrayContaining(['register_run', 'heartbeat_run']),
    )
    expect(s.ROOT_REQUIRED_MCP_TOOLS).not.toContain('register_run')
    expect(s.ROOT_REQUIRED_MCP_TOOLS).not.toContain('heartbeat_run')
  })

  test('full self-test suite passes (mock MCP lifecycle)', async () => {
    const s = await loadSmokeLib()
    const result = await s.runStagingAgentSmokeSelfTests()
    const failed = result.results.filter((r: { pass: boolean; name: string }) => !r.pass)
    expect(result.ok, failed.map((f: { name: string }) => f.name).join(', ')).toBe(true)
    expect(result.failCount).toBe(0)
  })

  test('fixture contract self-tests pass', async () => {
    const c = await loadContract()
    const r = c.runFixtureContractSelfTests()
    expect(r.ok, r.results.filter((x: { pass: boolean }) => !x.pass).map((x: { name: string }) => x.name).join(',')).toBe(
      true,
    )
  })
})
