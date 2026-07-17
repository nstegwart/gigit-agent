import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_PROBE_MAX_AGE_SECONDS,
  evaluateCapacityPolicy,
  eligibleGrokAccountsForPlacement,
  isAccountEligible,
} from '#/server/account-sync'
import type { MaskedAccountRecord } from '#/server/account-sync'
import { DEFAULT_LOCK_LEASE_MS } from '#/server/locks'
import { MIGRATION_MANIFEST } from '#/server/migrations'
import { CP0_CONTROL_PLANE_VERSION, RUN_LEASE_MS } from '#/server/run-registry'
import { REQUIRED_TABLES_BY_MIGRATION } from '#/routes/api.healthz'

import { runSelfTest } from './secret-scan.mjs'
import {
  buildPlan,
  CP0_SCHEMA_VERSION,
  validateEvidence,
} from './staging-gate.mjs'

const NOW = Date.parse('2026-07-15T00:00:00.000Z')

function grok(
  overrides: Partial<MaskedAccountRecord> = {},
): MaskedAccountRecord {
  return {
    maskedAccountId: 'grok-masked-001',
    status: 'ACTIVE',
    providerKind: 'GROK',
    effectiveInUse: 0,
    effectiveCap: 20,
    adaptiveCap: 20,
    physicalSlotsDisplay: null,
    adaptiveQuotaState: null,
    reason: null,
    statusChangedAt: null,
    tombstone: false,
    expiresAt: '2026-07-15T01:00:00.000Z',
    quotaRemaining: 100,
    quotaVerdict: 'PASS',
    chatVerdict: 'PASS',
    probedAt: '2026-07-14T23:59:00.000Z',
    probeAgeSeconds: 60,
    quarantineReason: null,
    ...overrides,
  }
}

describe('CP0 capacity and lineage contract', () => {
  it('pins 400 global, 10 soft, 20 hard, SOL zero, and ten-minute leases', () => {
    const result = evaluateCapacityPolicy({ accounts: [grok()], nowMs: NOW })
    expect(result.policy).toMatchObject({
      combinedMax: 400,
      grokSoftPerAccount: 10,
      grokMaxPerAccount: 20,
      solMax: 0,
      cpuDrainFraction: 0.25,
    })
    expect(ACCOUNT_PROBE_MAX_AGE_SECONDS).toBe(300)
    expect(DEFAULT_LOCK_LEASE_MS).toBe(600_000)
    expect(RUN_LEASE_MS).toBe(600_000)
    expect(CP0_CONTROL_PLANE_VERSION).toBe('CP0_CONTROL_PLANE_V1')
  })

  it('requires live quota and chat proof, future expiry, and no quarantine', () => {
    expect(isAccountEligible(grok(), NOW)).toBe(true)
    expect(isAccountEligible(grok({ chatVerdict: 'SKIP' }), NOW)).toBe(false)
    expect(
      isAccountEligible(grok({ probedAt: '2026-07-14T23:54:59.000Z' }), NOW),
    ).toBe(false)
    expect(
      isAccountEligible(grok({ expiresAt: '2026-07-15T00:00:00.000Z' }), NOW),
    ).toBe(false)
    expect(
      isAccountEligible(grok({ quarantineReason: 'AUTH_EXPIRED' }), NOW),
    ).toBe(false)
  })

  it('allows CPU 95 and stops new dispatch above 95', () => {
    const at95 = evaluateCapacityPolicy({
      accounts: [grok()],
      nowMs: NOW,
      health: { cpuPercent: 95, memAvailableGiB: 42 },
    })
    const above95 = evaluateCapacityPolicy({
      accounts: [grok()],
      nowMs: NOW,
      health: { cpuPercent: 95.01, memAvailableGiB: 42 },
    })
    expect(at95.dispatchAllowed).toBe(true)
    expect(above95.dispatchAllowed).toBe(false)
    expect(above95.limitingReasons).toContain('CPU_GT_95')
  })

  it('keeps RSS as telemetry only while memory bands pace launch batches', () => {
    const accounts = Array.from({ length: 20 }, (_, index) =>
      grok({
        maskedAccountId: `grok-masked-${String(index).padStart(3, '0')}`,
      }),
    )
    const result = evaluateCapacityPolicy({
      accounts,
      nowMs: NOW,
      health: {
        cpuPercent: 10,
        memAvailableGiB: 42,
        observedWorkerRssP95MiB: 128,
      },
    })
    expect(result.usableCapacity).toBe(400)
    expect(result.combinedCap).toBe(400)
    expect(result.launchBatchFraction).toBe(1)

    const quarter = evaluateCapacityPolicy({
      accounts,
      nowMs: NOW,
      health: {
        cpuPercent: 94,
        memAvailableGiB: 15,
        observedWorkerRssP95MiB: 4_096,
      },
    })
    expect(quarter.usableCapacity).toBe(400)
    expect(quarter.launchBatchFraction).toBe(0.25)
  })

  it('orders eligible Grok accounts by nearest expiry then masked id', () => {
    const accounts = [
      grok({
        maskedAccountId: 'masked-z',
        expiresAt: '2026-07-15T03:00:00.000Z',
      }),
      grok({
        maskedAccountId: 'masked-b',
        expiresAt: '2026-07-15T02:00:00.000Z',
      }),
      grok({
        maskedAccountId: 'masked-a',
        expiresAt: '2026-07-15T02:00:00.000Z',
      }),
      grok({ maskedAccountId: 'masked-limit', status: 'LIMIT' }),
    ]
    expect(
      eligibleGrokAccountsForPlacement(accounts, NOW).map(
        (account) => account.maskedAccountId,
      ),
    ).toEqual(['masked-a', 'masked-b', 'masked-z'])
    expect(
      evaluateCapacityPolicy({ accounts, nowMs: NOW }).grokPlacementOrder,
    ).toEqual(['masked-a', 'masked-b', 'masked-z'])
  })
})

describe('CP0 schema, route, scan, and staging proof contract', () => {
  it('registers migration 008 and all CP0 health table probes', () => {
    expect(MIGRATION_MANIFEST.at(-1)).toMatchObject({
      version: '008',
      filename: '008_cp0_control_plane.sql',
    })
    expect(REQUIRED_TABLES_BY_MIGRATION['008']).toEqual([
      'control_plane_spawn_budgets',
      'control_plane_control_acks',
      'control_plane_account_probes',
      'control_plane_sync_status',
    ])
    const sql = readFileSync('migrations/008_cp0_control_plane.sql', 'utf8')
    for (const table of REQUIRED_TABLES_BY_MIGRATION['008']) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
  })

  it('keeps /healthz as a direct alias of the authenticated handler', () => {
    const alias = readFileSync('src/routes/healthz.ts', 'utf8')
    expect(alias).toContain("createFileRoute('/healthz')")
    expect(alias).toContain('healthzGetHandler(request)')
  })

  it('passes scanner self-test without exposing matched values', () => {
    expect(runSelfTest()).toMatchObject({ ok: true })
  })

  it('distinguishes plan-only output from evidence-backed staging verification', () => {
    const sha = '2'.repeat(40)
    const plan = buildPlan({ expectedSha: sha, cwd: process.cwd() })
    expect(plan).toMatchObject({
      mode: 'PLAN_ONLY',
      stagingVerified: false,
      liveP0: false,
    })

    const evidence = {
      target: 'staging',
      expectedSha: sha,
      observedSha: sha,
      health: {
        authenticated: true,
        httpStatus: 200,
        status: 'ok',
        deployedSha: sha,
        release: { match: true },
        schema: { version: CP0_SCHEMA_VERSION, match: true },
        migration: {
          status: 'READY',
          expectedLatestVersion: CP0_SCHEMA_VERSION,
          appliedVersions: [
            '000',
            '001',
            '002',
            '003',
            '004',
            '005',
            '006',
            '007',
            '008',
          ],
        },
        canonicalHash: 'a'.repeat(64),
        boardRev: 8,
        lifecycleRev: 3,
        sync: {
          status: 'IN_SYNC',
          effectiveBacklog: 0,
          zeroBacklogProven: true,
        },
        dependencies: [{ name: 'mysql', status: 'up' }],
      },
      checks: {
        cp0: 'PASS',
        secretScan: 'PASS',
        typecheck: 'PASS',
        build: 'PASS',
      },
      independentVerdict: {
        verdict: 'PASS',
        subjectSha: sha,
        authorRunId: 'author-run',
        verifierRunId: 'verifier-run',
      },
      rollback: {
        priorSha: '1'.repeat(40),
        priorShaHealthProven: true,
        restoredSha: sha,
        currentShaHealthProven: true,
      },
    }
    expect(validateEvidence(evidence, sha)).toMatchObject({
      ok: true,
      stagingVerified: true,
      liveP0: false,
    })
    expect(
      validateEvidence({ ...evidence, observedSha: '3'.repeat(40) }, sha),
    ).toMatchObject({
      ok: false,
      stagingVerified: false,
    })
  })
})
