/**
 * Dedicated unit / contract coverage for qa/e2e/flows/account-sync-sla.mjs.
 * LOCAL ONLY — no --real, no staging mutation, no token output.
 */
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const FLOW = join(ROOT, 'qa/e2e/flows/account-sync-sla.mjs')

async function loadFlow() {
  return import(pathToFileURL(FLOW).href)
}

describe('account-sync-sla harness (contract)', () => {
  it('exports SLA constants matching domain (30s / 60s)', async () => {
    const m = await loadFlow()
    expect(m.ACCOUNT_PUBLISH_SLA_MS).toBe(30_000)
    expect(m.ACCOUNT_PERIODIC_HEALTH_MS).toBe(60_000)
    expect(m.SURFACES).toEqual(['mcp', 'api', 'ui', 'ops'])
  })

  it('builds masked fixture without secret fields', async () => {
    const m = await loadFlow()
    const fx = m.buildMaskedFixtureState({
      runId: 'unit',
      status: 'BAN',
      trigger: 'BAN_TRANSITION',
      sourceRevision: 3,
      generatedAt: '2026-07-14T12:00:00.000Z',
    })
    expect(fx.accounts.length).toBeGreaterThanOrEqual(1)
    expect(fx.accounts[0].status).toBe('BAN')
    expect(() => m.assertMaskedPool(fx.accounts)).not.toThrow()
    expect(() =>
      m.buildMaskedAccount({ maskedAccountId: 'secret-token-id' }),
    ).toThrow(/FAIL-CLOSED/)
  })

  it('requires exact four-surface sourceRevision/generatedAt parity', async () => {
    const m = await loadFlow()
    const gen = '2026-07-14T12:00:00.000Z'
    const good = m.projectFourSurfaces({ sourceRevision: 11, generatedAt: gen })
    expect(m.surfacesHaveExactParity(good, 11, gen)).toBe(true)
    const bad = { ...good, ui: { ...good.ui, generatedAt: 'other' } }
    expect(m.surfacesHaveExactParity(bad, 11, gen)).toBe(false)
  })

  it('SLA miss without parity and periodic miss fail closed usableCapacity=0', async () => {
    const m = await loadFlow()
    const t0 = Date.parse('2026-07-14T00:00:00.000Z')
    const sla = m.evaluatePublishSla({
      publishAtMs: t0,
      nowMs: t0 + 30_001,
      parity: false,
    })
    expect(sla.slaMiss).toBe(true)
    expect(sla.reason).toBe('SLA_MISS_30S_NO_PARITY')

    const per = m.evaluatePeriodicHealth({
      lastPeriodicHealthAtMs: t0,
      nowMs: t0 + 60_001,
    })
    expect(per.periodicMiss).toBe(true)
    expect(per.reason).toBe('PERIODIC_HEALTH_MISS_60S')

    const fc = m.evaluateFailClosed({
      parity: false,
      slaMiss: true,
      periodicMiss: true,
      usableCapacity: 8,
    })
    expect(fc.failClosed).toBe(true)
    expect(fc.stale).toBe(true)
    expect(fc.usableCapacity).toBe(0)
    expect(fc.alert).toBe('ACCOUNT_SYNC_STALE')
  })

  it('mandatory trigger matrix covers LIMIT/BAN/403/AUTH_EXPIRED/rotation/requeue/checkpoint/periodic', async () => {
    const m = await loadFlow()
    const plan = m.buildTriggerRunPlan({ runId: 'vitest', boardId: 'mfs-rebuild' })
    const kinds = new Set(plan.steps.map((s: { kind: string }) => s.kind))
    for (const k of [
      'limit',
      'ban',
      '403',
      'auth_expired',
      'rotation',
      'requeue',
      'checkpoint',
      'periodic',
    ]) {
      expect(kinds.has(k)).toBe(true)
    }
    expect(plan.cleanup.steps.length).toBeGreaterThanOrEqual(2)
    expect(m.isCoalescableTrigger('HEARTBEAT')).toBe(true)
    expect(m.requireImmediatePublish('LIMIT_TRANSITION')).toBe(true)
  })

  it('explicit ROOT token env only (rejects legacy MCP-only)', async () => {
    const m = await loadFlow()
    expect(m.resolveExplicitRootToken({}).ok).toBe(false)
    expect(m.resolveExplicitRootToken({ CAIRN_MCP_BEARER: 'x' }).ok).toBe(false)
    const r = m.resolveExplicitRootToken({ ACCOUNT_SYNC_SLA_ROOT_TOKEN: 'synth' })
    expect(r.ok).toBe(true)
    expect(r.tokenRef).toBe('ACCOUNT_SYNC_SLA_ROOT_TOKEN')
    expect(m.mutationsAllowed({})).toBe(false)
    expect(m.mutationsAllowed({ ACCOUNT_SYNC_SLA_ALLOW_MUTATION: '1' })).toBe(true)
  })

  it('staging-only guard refuses prod-like hosts', async () => {
    const m = await loadFlow()
    expect(m.assertStagingOnlyBase('http://127.0.0.1:33211').ok).toBe(true)
    expect(m.assertStagingOnlyBase('https://prod.myfitsociety.com').ok).toBe(false)
    expect(m.assertStagingOnlyBase('').ok).toBe(false)
  })

  it('--self-test suite passes offline', async () => {
    const m = await loadFlow()
    const r = m.selfTest()
    if (!r.ok) {
      const failed = r.results.filter((x: { pass: boolean }) => !x.pass)
      // Surface exact failures for debugging
      expect(failed).toEqual([])
    }
    expect(r.ok).toBe(true)
    expect(r.failCount).toBe(0)
    expect(r.passCount).toBeGreaterThan(20)
  })

  it('live path without ROOT token fails closed (no mutation, injectable fetch unused)', async () => {
    const m = await loadFlow()
    const receipt = await m.runLiveAccountSyncSla({
      env: {
        STAGING_URL: 'http://127.0.0.1:9',
        BOARD_ID: 'mfs-rebuild',
        // no ROOT token
      },
      fetchImpl: async () => {
        throw new Error('fetch must not be called without ROOT token')
      },
    })
    expect(receipt.ok).toBe(false)
    expect(receipt.residuals.some((x: { code?: string }) => x.code === 'MISSING_ROOT_TOKEN')).toBe(
      true,
    )
  })

  it('live path without ALLOW_MUTATION does not call sync_accounts', async () => {
    const m = await loadFlow()
    const calls: string[] = []
    const receipt = await m.runLiveAccountSyncSla({
      env: {
        STAGING_URL: 'http://127.0.0.1:9',
        BOARD_ID: 'mfs-rebuild',
        ACCOUNT_SYNC_SLA_ROOT_TOKEN: 'synth-root-unit',
        // ACCOUNT_SYNC_SLA_ALLOW_MUTATION intentionally unset
      },
      fetchImpl: async (url: string | URL, init?: RequestInit) => {
        const u = String(url)
        const body = typeof init?.body === 'string' ? init.body : ''
        if (body.includes('sync_accounts')) calls.push('sync_accounts')
        if (body.includes('list_accounts')) calls.push('list_accounts')
        // Minimal MCP JSON-RPC list_accounts success
        if (u.includes('/mcp')) {
          const tool = {
            ok: true,
            boardId: 'mfs-rebuild',
            sourceRevision: 42,
            generatedAt: '2026-07-14T12:00:00.000Z',
            schema: 'ACCOUNT_MCP_LIST_V1',
            accounts: [
              {
                maskedAccountId: 'acc_synth_unit',
                status: 'OK',
                providerKind: 'GROK',
                effectiveInUse: 0,
                effectiveCap: 5,
                physicalSlotsDisplay: '0/5',
                adaptiveQuotaState: 'healthy',
                reason: null,
              },
            ],
            stale: false,
          }
          return new Response(
            JSON.stringify({
              jsonrpc: '2.0',
              id: 1,
              result: {
                content: [{ type: 'text', text: JSON.stringify(tool) }],
              },
            }),
            { status: 200, headers: { 'content-type': 'application/json' } },
          )
        }
        // API accounts
        return new Response(
          JSON.stringify({
            ok: true,
            sourceRevision: 42,
            generatedAt: '2026-07-14T12:00:00.000Z',
            schema: 'ACCOUNT_API_JSON_V1',
            stale: false,
            accounts: [],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        )
      },
    })
    expect(calls).not.toContain('sync_accounts')
    expect(calls).toContain('list_accounts')
    expect(receipt.mutations).toBe(false)
    expect(
      receipt.residuals.some((x: { code?: string }) => x.code === 'MUTATION_DISABLED'),
    ).toBe(true)
    expect(receipt.ok).toBe(true)
  })
})
