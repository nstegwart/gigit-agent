import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  ACCOUNT_PERIODIC_HEALTH_MS,
  ACCOUNT_PUBLISH_SLA_MS,
  ACCOUNT_SYNC_READBACK_SURFACES,
  AccountSyncError,
  authorizeProviderAssignment,
  CAP_REASON_GROK_MAJORITY_NO_RECOVERY,
  CAP_REASON_GROK_ONLY_RECOVERY,
  CAP_REASON_NON_GROK_DENIED_GROK_ONLY,
  createMemoryAccountSyncStore,
  evaluateAccountSyncFreshness,
  evaluateCapacityPolicy,
  getSharedAccountSyncStore,
  isCoalescableAccountSyncTrigger,
  isFailClosedStable,
  isImmediateAccountSyncTrigger,
  isMaterialAccountSyncTransition,
  projectAccountSyncCcReadModel,
  readLatestAccountSyncSnapshot,
  recordAccountReadback,
  recordAccountReadbacks,
  resetSharedAccountSyncStore,
  resolveProviderKindFromModel,
  setSharedAccountSyncStore,
  surfacesHaveParity,
  syncAccounts,
  syncAccountsIdempotencyBody,
  type AccountSyncDeps,
  type MaskedAccountRecord,
  type SyncAccountsRequest,
} from '#/server/account-sync'
import {
  resetMcpControlPlaneDeps,
  setMcpAccountStore,
} from '#/server/board-mcp'
import {
  buildControlCenterAggregationFromSources,
} from '#/server/control-center-ui-adapter'
import { projectOps } from '#/server/control-center-ui'
import { createMemoryIdempotencyStorage, requestHashOf } from '#/server/idempotency'
import {
  createMemoryDispatchPlanStore,
  computePlanHash,
  DISPATCH_CALLER_ROOT,
  publishDispatchPlan,
  type DispatchPlanItem,
} from '#/server/control-plane-ingest'
import {
  createMemoryRunRegistryStore,
  registerRun,
} from '#/server/run-registry'
import { createMemoryLockStore } from '#/server/locks'

const BOARD = 'mfs-rebuild'

function deps(clock = createFakeClock()) {
  const atomic = createMemoryControlPlaneAtomicStore([
    { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
  ])
  const accounts = createMemoryAccountSyncStore()
  const idempotency = createMemoryIdempotencyStorage()
  const d: AccountSyncDeps & { clock: ReturnType<typeof createFakeClock> } = {
    clock,
    accounts,
    atomic,
    idempotency,
  }
  return d
}

function grok(id: string, over: Partial<MaskedAccountRecord> = {}): MaskedAccountRecord {
  return {
    maskedAccountId: id,
    status: 'OK',
    providerKind: 'GROK',
    effectiveInUse: 2,
    effectiveCap: 5,
    physicalSlotsDisplay: '2/20',
    adaptiveQuotaState: 'HEALTHY',
    reason: null,
    statusChangedAt: null,
    tombstone: false,
    ...over,
  }
}

function spark(id: string, over: Partial<MaskedAccountRecord> = {}): MaskedAccountRecord {
  return {
    maskedAccountId: id,
    status: 'OK',
    providerKind: 'SPARK',
    effectiveInUse: 0,
    effectiveCap: 10,
    physicalSlotsDisplay: null,
    adaptiveQuotaState: null,
    reason: null,
    statusChangedAt: null,
    tombstone: false,
    ...over,
  }
}

function sol(id: string, over: Partial<MaskedAccountRecord> = {}): MaskedAccountRecord {
  return {
    maskedAccountId: id,
    status: 'OK',
    providerKind: 'SOL',
    effectiveInUse: 0,
    effectiveCap: 10,
    physicalSlotsDisplay: null,
    adaptiveQuotaState: null,
    reason: null,
    statusChangedAt: null,
    tombstone: false,
    ...over,
  }
}

describe('AC-CAP capacity policy', () => {
  it('AC-CAP-01: Spark<=10 SOL<=10 Grok 5-10/account majority combined<=200', () => {
    const accounts: Array<MaskedAccountRecord> = [
      {
        maskedAccountId: 's1',
        status: 'OK',
        providerKind: 'SPARK',
        effectiveInUse: 12,
        effectiveCap: 12,
        physicalSlotsDisplay: null,
        adaptiveQuotaState: null,
        reason: null,
        statusChangedAt: null,
        tombstone: false,
      },
      {
        maskedAccountId: 'sol1',
        status: 'OK',
        providerKind: 'SOL',
        effectiveInUse: 15,
        effectiveCap: 15,
        physicalSlotsDisplay: null,
        adaptiveQuotaState: null,
        reason: null,
        statusChangedAt: null,
        tombstone: false,
      },
      // Grok majority of safe live capacity: after Spark/SOL clamp to 10+10,
      // need Grok live > 20 (e.g. 5 accounts × 5).
      grok('g1', { effectiveInUse: 5, effectiveCap: 5 }),
      grok('g2', { effectiveInUse: 5, effectiveCap: 8 }),
      grok('g3', { effectiveInUse: 5, effectiveCap: 10 }),
      grok('g4', { effectiveInUse: 5, effectiveCap: 5 }),
      grok('g5', { effectiveInUse: 5, effectiveCap: 5 }),
    ]
    const r = evaluateCapacityPolicy({ accounts })
    expect(r.sparkLive).toBe(10)
    expect(r.solLive).toBe(10)
    expect(r.policy.sparkMax).toBe(10)
    expect(r.policy.solMax).toBe(10)
    expect(r.policy.grokStartPerAccount).toBe(5)
    expect(r.policy.grokMaxPerAccount).toBe(10)
    expect(r.combinedLive).toBeLessThanOrEqual(200)
    expect(r.grokLive).toBe(25)
    expect(r.grokMajority).toBe(true)
    expect(r.dispatchMode).toBe('OPEN')
    expect(r.nonGrokAssignmentAllowed).toBe(false) // Spark/SOL over-cap, no remaining non-Grok
    expect(r.grokAssignmentAllowed).toBe(true) // g2+g3 have spare
    expect(r.limitingReasons.some((x) => x.startsWith('SPARK_OVER_CAP'))).toBe(true)
    expect(r.limitingReasons.some((x) => x.startsWith('SOL_OVER_CAP'))).toBe(true)
  })

  it('AC-CAP-02: floor >=60 only with genuine packets + health; else BELOW_FLOOR', () => {
    const accounts = [grok('g1', { effectiveInUse: 0, effectiveCap: 5 })]
    const below = evaluateCapacityPolicy({
      accounts,
      genuineReadyPacketCount: 10,
      health: { cpuPercent: 20 },
    })
    expect(below.belowFloor).toBe(true)
    expect(below.belowFloorReason).toMatch(/BELOW_FLOOR/)
    expect(below.floorMet).toBe(false)

    // Many grok accounts to reach floor live if packets ok — still may be below live count
    const many = Array.from({ length: 20 }, (_, i) =>
      grok(`g${i}`, { effectiveInUse: 5, effectiveCap: 5 }),
    )
    const met = evaluateCapacityPolicy({
      accounts: many,
      genuineReadyPacketCount: 60,
      health: { cpuPercent: 10, ramHealthy: true, loadHealthy: true },
    })
    expect(met.combinedLive).toBe(100)
    expect(met.floorMet).toBe(true)
    expect(met.belowFloor).toBe(false)
    expect(met.grokMajority).toBe(true)
    expect(met.dispatchMode).toBe('OPEN')

    const cpuBlock = evaluateCapacityPolicy({
      accounts: many,
      genuineReadyPacketCount: 60,
      health: { cpuPercent: 95 },
    })
    expect(cpuBlock.usableCapacity).toBe(0)
    expect(cpuBlock.dispatchAllowed).toBe(false)
    expect(cpuBlock.dispatchMode).toBe('BLOCKED')
    expect(cpuBlock.limitingReasons).toContain('CPU_GTE_90')
  })

  it('AC-CAP-03: LIMIT/quarantine/tombstone/physical20/accounts-all/filler', () => {
    const accounts: Array<MaskedAccountRecord> = [
      grok('ok', { status: 'OK', effectiveInUse: 1, effectiveCap: 5 }),
      grok('lim', { status: 'LIMIT', effectiveInUse: 3, effectiveCap: 5 }),
      grok('ban', { status: 'BAN', effectiveInUse: 2, effectiveCap: 5 }),
      grok('auth', { status: 'AUTH_EXPIRED', effectiveInUse: 1, effectiveCap: 5 }),
      grok('q', { status: 'quarantine', effectiveInUse: 1, effectiveCap: 5 }),
      grok('rm', { status: 'REMOVED', effectiveInUse: 1, effectiveCap: 5, tombstone: true }),
    ]
    const r = evaluateCapacityPolicy({ accounts })
    // only OK contributes
    expect(r.grokLive).toBe(1)
    expect(r.policy.physicalSlotsDisplayOnly).toBe(true)
    expect(r.policy.neverAccountsAll).toBe(true)
    expect(r.policy.neverFiller).toBe(true)
    // sole live is Grok → majority OPEN with remaining Grok slots
    expect(r.grokMajority).toBe(true)
    expect(r.dispatchMode).toBe('OPEN')
    expect(r.usableCapacity).toBe(4)

    const all = evaluateCapacityPolicy({ accounts, accountsAllFlag: true })
    expect(all.usableCapacity).toBe(0)
    expect(all.dispatchMode).toBe('BLOCKED')
    expect(all.limitingReasons).toContain('ACCOUNTS_ALL_FORBIDDEN')

    const filler = evaluateCapacityPolicy({ accounts, fillerDetected: true })
    expect(filler.usableCapacity).toBe(0)
    expect(filler.dispatchMode).toBe('BLOCKED')
    expect(filler.limitingReasons).toContain('FILLER_FORBIDDEN')

    const force = evaluateCapacityPolicy({ accounts, forceZero: true })
    expect(force.usableCapacity).toBe(0)
    expect(force.dispatchMode).toBe('BLOCKED')
    expect(force.limitingReasons).toContain('ACCOUNT_SYNC_STALE')
  })

  it('zero-live bootstrap: healthy Grok usable → GROK_ONLY (no deadlock)', () => {
    const r = evaluateCapacityPolicy({
      accounts: [grok('g1', { effectiveInUse: 0, effectiveCap: 5 })],
    })
    expect(r.combinedLive).toBe(0)
    expect(r.grokMajority).toBe(false)
    expect(r.dispatchMode).toBe('GROK_ONLY')
    expect(r.healthyGrokUsableCapacity).toBe(5)
    expect(r.usableCapacity).toBe(5)
    expect(r.dispatchAllowed).toBe(true)
    expect(r.grokAssignmentAllowed).toBe(true)
    expect(r.nonGrokAssignmentAllowed).toBe(false)
    expect(r.limitingReasons).toContain(CAP_REASON_GROK_ONLY_RECOVERY)

    const grokAuth = authorizeProviderAssignment(r, { providerKind: 'GROK' })
    expect(grokAuth.allowed).toBe(true)
    expect(grokAuth.dispatchMode).toBe('GROK_ONLY')

    const sparkAuth = authorizeProviderAssignment(r, { providerKind: 'SPARK' })
    expect(sparkAuth.allowed).toBe(false)
    expect(sparkAuth.reason).toBe(CAP_REASON_NON_GROK_DENIED_GROK_ONLY)

    const solAuth = authorizeProviderAssignment(r, { model: 'gpt-5.6-sol' })
    expect(solAuth.allowed).toBe(false)
    expect(solAuth.providerKind).toBe('SOL')
  })

  it('non-Grok denial while Grok recovery: Spark/SOL live without majority', () => {
    const r = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 5, effectiveCap: 10 }),
        sol('sol1', { effectiveInUse: 3, effectiveCap: 10 }),
        grok('g1', { effectiveInUse: 1, effectiveCap: 5 }),
      ],
    })
    // live: spark 5 + sol 3 + grok 1 = 9; grok not majority
    expect(r.sparkLive).toBe(5)
    expect(r.solLive).toBe(3)
    expect(r.grokLive).toBe(1)
    expect(r.grokMajority).toBe(false)
    expect(r.dispatchMode).toBe('GROK_ONLY')
    expect(r.usableCapacity).toBe(4) // only Grok remaining (5-1)
    expect(r.nonGrokAssignmentAllowed).toBe(false)
    expect(authorizeProviderAssignment(r, { providerKind: 'SPARK' }).allowed).toBe(false)
    expect(authorizeProviderAssignment(r, { providerKind: 'SOL' }).allowed).toBe(false)
    expect(authorizeProviderAssignment(r, { providerKind: 'GROK' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { model: 'grok-4.5' }).allowed).toBe(true)
  })

  it('Grok recovery continues until majority; OPEN once grokLive > nonGrok', () => {
    // Spark 2 live, Grok 3 live with spare → still not majority if nonGrok=2, grok=3 → majority
    const majority = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 2, effectiveCap: 10 }),
        grok('g1', { effectiveInUse: 3, effectiveCap: 5 }),
      ],
    })
    expect(majority.grokLive).toBe(3)
    expect(majority.sparkLive).toBe(2)
    expect(majority.grokMajority).toBe(true)
    expect(majority.dispatchMode).toBe('OPEN')
    expect(majority.nonGrokAssignmentAllowed).toBe(true)
    expect(authorizeProviderAssignment(majority, { providerKind: 'SPARK' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(majority, { providerKind: 'GROK' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(majority, {}).providerKind).toBe('OTHER')

    // Equal live is NOT majority → GROK_ONLY if Grok spare exists
    const tied = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 4, effectiveCap: 10 }),
        grok('g1', { effectiveInUse: 4, effectiveCap: 5 }),
      ],
    })
    expect(tied.grokLive).toBe(4)
    expect(tied.sparkLive).toBe(4)
    expect(tied.grokMajority).toBe(false)
    expect(tied.dispatchMode).toBe('GROK_ONLY')
    expect(authorizeProviderAssignment(tied, { providerKind: 'SPARK' }).allowed).toBe(false)
    expect(authorizeProviderAssignment(tied, { providerKind: 'GROK' }).allowed).toBe(true)
  })

  it('healthy majority OPEN mode allows non-Grok when remaining slots exist', () => {
    const r = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 1, effectiveCap: 10 }),
        sol('sol1', { effectiveInUse: 1, effectiveCap: 10 }),
        // grok live 5 > nonGrok 2
        grok('g1', { effectiveInUse: 5, effectiveCap: 5 }),
        grok('g2', { effectiveInUse: 0, effectiveCap: 5 }),
      ],
    })
    expect(r.grokMajority).toBe(true)
    expect(r.dispatchMode).toBe('OPEN')
    expect(r.nonGrokAssignmentAllowed).toBe(true)
    expect(r.grokAssignmentAllowed).toBe(true)
    expect(r.usableCapacity).toBeGreaterThan(0)
    expect(authorizeProviderAssignment(r, { providerKind: 'SPARK' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { providerKind: 'SOL' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { providerKind: 'GROK' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { model: 'gpt-5.3-codex-spark' }).providerKind).toBe(
      'SPARK',
    )
  })

  it('loss of all healthy Grok recovery capacity → BLOCKED usable=0 exact reason', () => {
    // Non-Grok live only; Grok accounts unhealthy or full with no remaining
    const noGrok = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 5, effectiveCap: 10 }),
        sol('sol1', { effectiveInUse: 2, effectiveCap: 10 }),
        grok('g-lim', { status: 'LIMIT', effectiveInUse: 0, effectiveCap: 5 }),
        grok('g-ban', { status: 'BAN', effectiveInUse: 0, effectiveCap: 5 }),
      ],
    })
    expect(noGrok.grokMajority).toBe(false)
    expect(noGrok.healthyGrokUsableCapacity).toBe(0)
    expect(noGrok.dispatchMode).toBe('BLOCKED')
    expect(noGrok.usableCapacity).toBe(0)
    expect(noGrok.dispatchAllowed).toBe(false)
    expect(noGrok.limitingReasons).toContain(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)
    expect(authorizeProviderAssignment(noGrok, { providerKind: 'SPARK' }).allowed).toBe(false)
    expect(authorizeProviderAssignment(noGrok, { providerKind: 'GROK' }).allowed).toBe(false)
    expect(authorizeProviderAssignment(noGrok, { providerKind: 'GROK' }).reason).toBe(
      CAP_REASON_GROK_MAJORITY_NO_RECOVERY,
    )

    // Healthy Grok fully saturated + equal non-Grok live → no recovery capacity
    const fullGrok = evaluateCapacityPolicy({
      accounts: [
        spark('s1', { effectiveInUse: 5, effectiveCap: 10 }),
        grok('g1', { effectiveInUse: 5, effectiveCap: 5 }),
      ],
    })
    expect(fullGrok.grokLive).toBe(5)
    expect(fullGrok.sparkLive).toBe(5)
    expect(fullGrok.grokMajority).toBe(false)
    expect(fullGrok.healthyGrokUsableCapacity).toBe(0)
    expect(fullGrok.dispatchMode).toBe('BLOCKED')
    expect(fullGrok.usableCapacity).toBe(0)
    expect(fullGrok.limitingReasons).toContain(CAP_REASON_GROK_MAJORITY_NO_RECOVERY)
  })

  it('resolveProviderKindFromModel uses exact supported identities only (no substring)', () => {
    // Contractual exact identities
    expect(resolveProviderKindFromModel('grok-4.5')).toBe('GROK')
    expect(resolveProviderKindFromModel('gpt-5.3-codex-spark')).toBe('SPARK')
    expect(resolveProviderKindFromModel('gpt-5.6-sol')).toBe('SOL')
    // Unknown / other product models
    expect(resolveProviderKindFromModel('claude-opus')).toBe('OTHER')
    expect(resolveProviderKindFromModel('gpt-5.6')).toBe('OTHER')
    // Substring false-positives must NOT map to Grok/Spark/SOL
    expect(resolveProviderKindFromModel('grok')).toBe('OTHER')
    expect(resolveProviderKindFromModel('not-a-grok-model')).toBe('OTHER')
    expect(resolveProviderKindFromModel('my-grok-fork')).toBe('OTHER')
    expect(resolveProviderKindFromModel('spark-1')).toBe('OTHER')
    expect(resolveProviderKindFromModel('codex-spark')).toBe('OTHER')
    expect(resolveProviderKindFromModel('sol-agent')).toBe('OTHER')
    expect(resolveProviderKindFromModel('gpt-5.6-sol-extra')).toBe('OTHER')
    expect(resolveProviderKindFromModel('Grok-4.5')).toBe('OTHER') // case-sensitive exact
    expect(resolveProviderKindFromModel('  grok-4.5  ')).toBe('GROK') // trim only
    expect(resolveProviderKindFromModel('')).toBe('OTHER')
  })

  it('AC-CAP floor/caps 5–10/account preserved under exact model mapping', () => {
    // Clamp semantics + OPEN majority (grok live 6 > nonGrok live 2)
    const r = evaluateCapacityPolicy({
      accounts: [
        grok('g1', { effectiveInUse: 3, effectiveCap: 3 }), // floor healthy cap to start 5; live min(3,5)=3
        grok('g2', { effectiveInUse: 3, effectiveCap: 15 }), // clamp cap to max 10; live 3
        spark('s1', { effectiveInUse: 1, effectiveCap: 10 }),
        sol('sol1', { effectiveInUse: 1, effectiveCap: 10 }),
      ],
    })
    expect(r.policy.grokStartPerAccount).toBe(5)
    expect(r.policy.grokMaxPerAccount).toBe(10)
    expect(r.policy.sparkMax).toBe(10)
    expect(r.policy.solMax).toBe(10)
    expect(r.policy.floorMin).toBe(60)
    expect(r.policy.combinedMax).toBe(200)
    const g1 = r.grokPerAccount.find((g) => g.maskedAccountId === 'g1')
    const g2 = r.grokPerAccount.find((g) => g.maskedAccountId === 'g2')
    expect(g1?.cap).toBe(5)
    expect(g2?.cap).toBe(10)
    expect(r.grokLive).toBe(6)
    expect(r.sparkLive + r.solLive).toBe(2)
    expect(r.grokMajority).toBe(true)
    expect(r.dispatchMode).toBe('OPEN')
    expect(r.healthyGrokUsableCapacity).toBe((5 - 3) + (10 - 3))
    expect(authorizeProviderAssignment(r, { model: 'grok-4.5' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { model: 'gpt-5.3-codex-spark' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { model: 'gpt-5.6-sol' }).allowed).toBe(true)
    expect(authorizeProviderAssignment(r, { model: 'not-a-grok-model' }).providerKind).toBe('OTHER')
  })
})

describe('AC-ACCOUNT sync SLA + fail-closed', () => {
  it('exports readback surfaces + coalesce helpers for scheduler foundation', () => {
    expect(ACCOUNT_SYNC_READBACK_SURFACES).toEqual(['mcp', 'api', 'ui', 'ops'])
    expect(isCoalescableAccountSyncTrigger('HEARTBEAT')).toBe(true)
    expect(isImmediateAccountSyncTrigger('ORCHESTRATOR_LAUNCH')).toBe(true)
    expect(
      surfacesHaveParity(
        {
          mcp: { sourceRevision: 1, generatedAt: 't' },
          api: { sourceRevision: 1, generatedAt: 't' },
          ui: { sourceRevision: 1, generatedAt: 't' },
          ops: { sourceRevision: 1, generatedAt: 't' },
        },
        1,
        't',
      ),
    ).toBe(true)
    expect(
      surfacesHaveParity(
        {
          mcp: { sourceRevision: 1, generatedAt: 't' },
          api: { sourceRevision: 1, generatedAt: 't' },
          ui: null,
          ops: { sourceRevision: 1, generatedAt: 't' },
        },
        1,
        't',
      ),
    ).toBe(false)
  })

  it('AC-ACCOUNT-01..05: triggers publish masked state with sourceRevision/generatedAt', async () => {
    const d = deps()
    const triggers = [
      'ORCHESTRATOR_LAUNCH',
      'HEARTBEAT',
      'LIMIT_TRANSITION',
      'ROTATION',
      'WAVE_CLOSE',
    ] as const
    let boardRev = 0
    let entityExpectedRev = 0
    for (const trigger of triggers) {
      const res = await syncAccounts(d, {
        boardId: BOARD,
        sourceRevision: 1000 + boardRev,
        generatedAt: d.clock.nowISO(),
        entityExpectedRev,
        canonicalHash: 'canon-test-pin',
        expectedBoardRev: boardRev,
        accounts: [
          {
            maskedAccountId: 'acct-mask-001',
            status: trigger === 'LIMIT_TRANSITION' ? 'LIMIT' : 'OK',
            providerKind: 'GROK',
            effectiveInUse: 1,
            effectiveCap: 5,
            physicalSlotsDisplay: '1/20',
          },
        ],
        trigger,
        idempotencyKey: `sync-${trigger}`,
        callerRole: 'ROOT_ORCHESTRATOR',
      })
      expect(res.acceptedCount).toBe(1)
      expect(res.sourceRevision).toBe(1000 + boardRev)
      expect(res.stale).toBe(false)
      boardRev = res.boardRev
      entityExpectedRev = (await d.accounts.get(BOARD))!.entityRev
      d.clock.advance(1000)
    }
    const audit = await d.atomic.listAudit(BOARD)
    expect(audit.filter((a) => a.kind === 'ACCOUNT_SYNC').length).toBe(triggers.length)
  })

  it('AC-ACCOUNT-06: periodic health tracked; miss after 60s → stale', async () => {
    const d = deps()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [{ maskedAccountId: 'a1', status: 'OK', providerKind: 'GROK', effectiveInUse: 0, effectiveCap: 5 }],
      trigger: 'PERIODIC_HEALTH',
      idempotencyKey: 'ph-1',
      callerRole: 'MFS_SYNC',
    })
    // establish parity so only periodic miss triggers
    for (const surface of ['mcp', 'api', 'ui', 'ops'] as const) {
      await recordAccountReadback(d, {
        boardId: BOARD,
        surface,
        sourceRevision: 1,
        generatedAt: d.clock.nowISO(),
      })
    }
    // re-sync to reset with periodic + re-parity quickly within SLA
    // After readback with matching generatedAt - wait, generatedAt on readback uses clock now which may differ
    // Re-publish and complete parity within window
    const gen = d.clock.nowISO()
    const prevEntityRev = (await d.accounts.get(BOARD))!.entityRev
    const pub = await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 2,
      generatedAt: gen,
      entityExpectedRev: prevEntityRev,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      accounts: [{ maskedAccountId: 'a1', status: 'OK', providerKind: 'GROK', effectiveInUse: 0, effectiveCap: 5 }],
      trigger: 'PERIODIC_HEALTH',
      idempotencyKey: 'ph-2',
      callerRole: 'MFS_SYNC',
    })
    for (const surface of ['mcp', 'api', 'ui', 'ops'] as const) {
      await recordAccountReadback(d, {
        boardId: BOARD,
        surface,
        sourceRevision: 2,
        generatedAt: gen,
      })
    }
    let snap = await d.accounts.get(BOARD)
    expect(snap?.stale).toBe(false)
    expect(pub.usableCapacity).toBeGreaterThanOrEqual(0)

    d.clock.advance(ACCOUNT_PERIODIC_HEALTH_MS + 1)
    snap = await evaluateAccountSyncFreshness(d, BOARD)
    expect(snap?.stale).toBe(true)
    expect(snap?.staleReason).toMatch(/PERIODIC_HEALTH/)
    expect(snap?.usableCapacity).toBe(0)
  })

  it('AC-ACCOUNT-07: miss SLA without readback → ACCOUNT_SYNC_STALE usableCapacity=0 blocks dispatch', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 42,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'AGENT_LAUNCH',
      idempotencyKey: 'launch-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })

    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS + 1)
    const stale = await evaluateAccountSyncFreshness(d, BOARD)
    expect(stale?.stale).toBe(true)
    expect(stale?.usableCapacity).toBe(0)
    expect(stale?.staleReason).toMatch(/SLA_MISS/)

    const board = await d.atomic.getBoardState(BOARD)
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_STALE/)

    const audit = await d.atomic.listAudit(BOARD)
    expect(audit.some((a) => a.kind === 'ACCOUNT_SYNC_STALE')).toBe(true)

    // Dispatch + register blocked
    const plans = createMemoryDispatchPlanStore()
    const ingestDeps = {
      clock: d.clock,
      plans,
      atomic: d.atomic,
      idempotency: createMemoryIdempotencyStorage(),
    }
    const items: Array<DispatchPlanItem> = [
      {
        rank: 1,
        taskId: 'T-1',
        targetGate: 'FUNCTIONAL',
        role: 'PRODUCT',
        selectionReason: 'x',
        dependencyProof: { satisfied: true },
        collisionScopeLockIds: ['repo:x:a/**'],
        expectedEntityRev: 0,
        expectedBoardRev: board.boardRev,
      },
    ]
    const planHash = computePlanHash({
      boardId: BOARD,
      planId: 'p1',
      planVersion: 1,
      canonicalSnapshotId: 's',
      canonicalHash: 'c',
      items,
    })
    await expect(
      publishDispatchPlan(ingestDeps, {
        entityExpectedRev: 0,
        // Pin match required so fail-closed path is DISPATCH_BLOCKED (stale capacity), not STALE_REVISION.
        currentPinHash: 'c',
        boardId: BOARD,
        planId: 'p1',
        planVersion: 1,
        planHash,
        canonicalSnapshotId: 's',
        canonicalHash: 'c',
        expectedBoardRev: board.boardRev,
        issuedAt: d.clock.nowISO(),
        expiresAt: new Date(d.clock.nowMs() + 3600_000).toISOString(),
        items,
        idempotencyKey: 'disp-blocked',
        callerRole: DISPATCH_CALLER_ROOT,
      }),
    ).rejects.toMatchObject({ code: 'DISPATCH_BLOCKED' })

    const runDeps = {
      clock: d.clock,
      runs: createMemoryRunRegistryStore(),
      locks: createMemoryLockStore(),
      atomic: d.atomic,
      idempotency: createMemoryIdempotencyStorage(),
      // Production always supplies getCapacity; stale → forceZero BLOCKED.
      getCapacity: async () => ({
        dispatchMode: 'BLOCKED' as const,
        dispatchAllowed: false,
        usableCapacity: 0,
        nonGrokAssignmentAllowed: false,
        grokAssignmentAllowed: false,
        limitingReasons: ['ACCOUNT_SYNC_STALE'],
      }),
    }
    // R5-02: capacity authorization runs before board dispatchBlocked / idempotency.
    // Stale zero capacity → AUTHORIZATION_REQUIRED (fail closed); board remains dispatchBlocked.
    await expect(
      registerRun(runDeps, {
      canonicalHash: 'canon-run',
      boardId: BOARD,
        runId: 'r1',
        taskId: 'T-1',
        targetGate: 'FUNCTIONAL',
        agentId: 'a',
        model: 'grok-4.5',
        expectedEntityRev: 0,
        expectedBoardRev: board.boardRev,
        idempotencyKey: 'r1',
      }),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({
        dispatchMode: 'BLOCKED',
        usableCapacity: 0,
      }),
    })
    expect((await d.atomic.getBoardState(BOARD)).dispatchBlocked).toBe(true)
  })

  it('same-revision multi-surface readback clears fail-closed', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 7,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'ok-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    for (const surface of ['mcp', 'api', 'ui', 'ops'] as const) {
      const snap = await recordAccountReadback(d, {
        boardId: BOARD,
        surface,
        sourceRevision: 7,
        generatedAt: gen,
      })
      if (surface === 'ops') {
        expect(snap.stale).toBe(false)
        expect(snap.usableCapacity).toBeGreaterThan(0)
      }
    }
    const board = await d.atomic.getBoardState(BOARD)
    expect(board.dispatchBlocked).toBe(false)
  })

  it('churn: already-stale re-eval does not bump entityRev when only staleReason compounds', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 50,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'churn-fresh-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    const afterCreate = await d.accounts.get(BOARD)
    expect(afterCreate?.entityRev).toBe(1)
    expect(afterCreate?.usableCapacity).toBe(5)

    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS + 1)
    const firstStale = await evaluateAccountSyncFreshness(d, BOARD)
    expect(firstStale?.stale).toBe(true)
    expect(firstStale?.usableCapacity).toBe(0)
    expect(firstStale?.entityRev).toBe(2)
    expect(firstStale?.staleReason).toMatch(/SLA_MISS/)
    expect(isFailClosedStable(firstStale!)).toBe(true)

    // Force periodic-miss path while already fail-closed: reason would compound,
    // but material transition is false → entityRev must stay.
    await d.accounts.put({
      ...firstStale!,
      lastPeriodicHealthAtMs: d.clock.nowMs() - ACCOUNT_PERIODIC_HEALTH_MS - 1,
    })
    const second = await evaluateAccountSyncFreshness(d, BOARD)
    expect(second?.entityRev).toBe(2)
    expect(second?.usableCapacity).toBe(0)
    expect(second?.stale).toBe(true)
    // staleReason left as first material transition (no put on compound)
    expect(second?.staleReason).toBe(firstStale?.staleReason)

    const third = await evaluateAccountSyncFreshness(d, BOARD)
    expect(third?.entityRev).toBe(2)
    expect(isMaterialAccountSyncTransition(
      { stale: true, usableCapacity: 0 },
      { stale: true, usableCapacity: 0 },
    )).toBe(false)
  })

  it('churn: coalesced four-surface readback is at most +1 entityRev; preserves parity', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 77,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'churn-rb-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    const afterAuth = await d.accounts.get(BOARD)
    expect(afterAuth?.entityRev).toBe(1)
    const authRev = afterAuth!.entityRev

    const coalesced = await recordAccountReadbacks(d, {
      boardId: BOARD,
      surfaces: {
        mcp: { sourceRevision: 77, generatedAt: gen },
        api: { sourceRevision: 77, generatedAt: gen },
        ui: { sourceRevision: 77, generatedAt: gen },
        ops: { sourceRevision: 77, generatedAt: gen },
      },
    })
    expect(coalesced.entityRev).toBe(authRev + 1)
    expect(coalesced.stale).toBe(false)
    expect(coalesced.usableCapacity).toBe(5)
    expect(surfacesHaveParity(coalesced.readbackSurfaces, 77, gen)).toBe(true)
    expect(coalesced.readbackSurfaces.mcp).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(coalesced.readbackSurfaces.api).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(coalesced.readbackSurfaces.ui).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(coalesced.readbackSurfaces.ops).toEqual({ sourceRevision: 77, generatedAt: gen })

    // Exact same readback again → no entityRev bump
    const noop = await recordAccountReadbacks(d, {
      boardId: BOARD,
      surfaces: {
        mcp: { sourceRevision: 77, generatedAt: gen },
        api: { sourceRevision: 77, generatedAt: gen },
        ui: { sourceRevision: 77, generatedAt: gen },
        ops: { sourceRevision: 77, generatedAt: gen },
      },
    })
    expect(noop.entityRev).toBe(authRev + 1)
  })

  it('churn: recover with live entityExpectedRev restores usableCapacity=5 (GROK_ONLY)', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    const grokAcc = {
      maskedAccountId: 'acct-mask-001',
      status: 'OK' as const,
      providerKind: 'GROK' as const,
      effectiveInUse: 0,
      effectiveCap: 5,
    }
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [grokAcc],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'recover-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS + 1)
    const stale = await evaluateAccountSyncFreshness(d, BOARD)
    expect(stale?.usableCapacity).toBe(0)
    expect(stale?.entityRev).toBe(2)

    // Stale CAS with old entityExpectedRev → STALE_REVISION with currentEntityRev
    await expect(
      syncAccounts(d, {
        boardId: BOARD,
        sourceRevision: 2,
        generatedAt: d.clock.nowISO(),
        entityExpectedRev: 1,
        canonicalHash: 'canon-test-pin',
        expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
        accounts: [grokAcc],
        trigger: 'PERIODIC_HEALTH',
        idempotencyKey: 'recover-stale-key',
        callerRole: 'ROOT_ORCHESTRATOR',
      }),
    ).rejects.toMatchObject({
      code: 'STALE_REVISION',
      details: expect.objectContaining({ currentEntityRev: 2 }),
    })

    const live = await d.accounts.get(BOARD)
    const board = await d.atomic.getBoardState(BOARD)
    const recover = await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 3,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: live!.entityRev,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: board.boardRev,
      accounts: [grokAcc],
      trigger: 'PERIODIC_HEALTH',
      idempotencyKey: 'recover-ok',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    expect(recover.usableCapacity).toBe(5)
    expect(recover.stale).toBe(false)
    expect(recover.capacity.dispatchMode).toBe('GROK_ONLY')
  })

  it('idempotency replay-before-CAS preserved after boardRev advances', async () => {
    const d = deps()
    const gen = d.clock.nowISO()
    const body = {
      boardId: BOARD,
      sourceRevision: 9,
      generatedAt: gen,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK' as const,
          providerKind: 'GROK' as const,
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH' as const,
      idempotencyKey: 'idem-replay-cas',
      callerRole: 'ROOT_ORCHESTRATOR' as const,
    }
    const first = await syncAccounts(d, body)
    expect(first.replayed).toBeFalsy()
    expect(first.usableCapacity).toBe(5)
    await d.atomic.bumpBoardRev(BOARD)
    const replay = await syncAccounts(d, body)
    expect(replay.replayed).toBe(true)
    expect(replay.usableCapacity).toBe(5)
    // entityRev unchanged by pure replay
    expect((await d.accounts.get(BOARD))?.entityRev).toBe(1)
  })

  it('AC-INGEST-05: masked account pool matches sync (no tokens)', async () => {
    const d = deps()
    await syncAccounts(d, {
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 2,
          effectiveCap: 5,
          physicalSlotsDisplay: '2/20',
        },
        {
          maskedAccountId: 'acct-mask-002',
          status: 'REMOVED',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 0,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'pool-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    const snap = await d.accounts.get(BOARD)
    expect(snap?.accounts.map((a) => a.maskedAccountId).sort()).toEqual([
      'acct-mask-001',
      'acct-mask-002',
    ])
    expect(JSON.stringify(snap)).not.toMatch(/password|token|secret/i)
    expect(snap?.accounts.find((a) => a.maskedAccountId === 'acct-mask-002')?.tombstone).toBe(true)
  })

  it('rejects unauthorized caller and --accounts all', async () => {
    const d = deps()
    await expect(
      syncAccounts(d, {
        boardId: BOARD,
        sourceRevision: 1,
        generatedAt: d.clock.nowISO(),
        entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
        accounts: [],
        trigger: 'HEARTBEAT',
        idempotencyKey: 'bad',
        callerRole: 'AGENT',
      }),
    ).rejects.toBeInstanceOf(AccountSyncError)

    await expect(
      syncAccounts(d, {
        boardId: BOARD,
        sourceRevision: 1,
        generatedAt: d.clock.nowISO(),
        entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
        accounts: [],
        trigger: 'HEARTBEAT',
        idempotencyKey: 'all',
        callerRole: 'ROOT_ORCHESTRATOR',
        accountsAllFlag: true,
      }),
    ).rejects.toMatchObject({ code: 'ACCOUNTS_ALL_FORBIDDEN' })
  })

  it('idempotent sync_accounts replay', async () => {
    const d = deps()
    // Identical body both times (including entityExpectedRev) — second call is pure replay.
    const body = {
      boardId: BOARD,
      sourceRevision: 9,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-test-pin',
      accounts: [
        {
          maskedAccountId: 'm1',
          status: 'OK' as const,
          providerKind: 'GROK' as const,
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT' as const,
      idempotencyKey: 'idem-acct',
      callerRole: 'ROOT_ORCHESTRATOR' as const,
      health: { cpuPercent: 10, ramHealthy: true, loadHealthy: true },
      genuineReadyPacketCount: 12,
    }
    const a = await syncAccounts(d, body)
    const b = await syncAccounts(d, body)
    expect(b.replayed).toBe(true)
    expect(b.sourceRevision).toBe(a.sourceRevision)
  })

  it('sync_accounts same key + changed health/genuineReadyPacketCount → IDEMPOTENCY_CONFLICT', async () => {
    const d = deps()
    const base: SyncAccountsRequest = {
      boardId: BOARD,
      sourceRevision: 11,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-test-pin',
      accounts: [
        {
          maskedAccountId: 'm1',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'idem-health-conflict',
      callerRole: 'ROOT_ORCHESTRATOR',
      health: { cpuPercent: 10, ramHealthy: true, loadHealthy: true },
      genuineReadyPacketCount: 20,
    }
    const first = await syncAccounts(d, base)
    expect(first.replayed).toBe(false)

    await expect(
      syncAccounts(d, {
        ...base,
        health: { cpuPercent: 50, ramHealthy: true, loadHealthy: true },
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    await expect(
      syncAccounts(d, {
        ...base,
        genuineReadyPacketCount: 99,
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    // Exact same body still replays (no board rev bump on conflict paths).
    const replay = await syncAccounts(d, base)
    expect(replay.replayed).toBe(true)
    expect(replay.boardRev).toBe(first.boardRev)
  })

  it('sync_accounts per-field conflict matrix (material fields in hash)', async () => {
    const base: SyncAccountsRequest = {
      boardId: BOARD,
      sourceRevision: 3,
      generatedAt: '2026-07-13T12:00:00.000Z',
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-matrix-pin',
      accounts: [
        {
          maskedAccountId: 'm1',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
          physicalSlotsDisplay: '1/20',
          adaptiveQuotaState: 'HEALTHY',
          reason: null,
          statusChangedAt: null,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'unused-for-hash',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'actor-matrix',
      health: { cpuPercent: 15, ramHealthy: true, loadHealthy: true },
      genuineReadyPacketCount: 30,
      accountsAllFlag: false,
    }
    const baseHash = requestHashOf(syncAccountsIdempotencyBody(base))

    type FieldCase = { name: string; patch: Partial<SyncAccountsRequest> }
    const cases: Array<FieldCase> = [
      // Previously omitted capacity inputs (must now change hash):
      {
        name: 'health.cpuPercent',
        patch: { health: { cpuPercent: 80, ramHealthy: true, loadHealthy: true } },
      },
      {
        name: 'health.ramHealthy',
        patch: { health: { cpuPercent: 15, ramHealthy: false, loadHealthy: true } },
      },
      {
        name: 'health.loadHealthy',
        patch: { health: { cpuPercent: 15, ramHealthy: true, loadHealthy: false } },
      },
      { name: 'genuineReadyPacketCount', patch: { genuineReadyPacketCount: 60 } },
      { name: 'health null vs present', patch: { health: undefined } },
      { name: 'genuineReadyPacketCount null', patch: { genuineReadyPacketCount: undefined } },
      // Remaining material fields affecting capacity/result:
      { name: 'sourceRevision', patch: { sourceRevision: 4 } },
      { name: 'generatedAt', patch: { generatedAt: '2026-07-13T12:00:01.000Z' } },
      { name: 'entityExpectedRev', patch: { entityExpectedRev: 1 } },
      { name: 'expectedBoardRev', patch: { expectedBoardRev: 2 } },
      { name: 'canonicalHash', patch: { canonicalHash: 'other-pin' } },
      { name: 'trigger', patch: { trigger: 'ORCHESTRATOR_LAUNCH' } },
      { name: 'callerRole', patch: { callerRole: 'MFS_SYNC' } },
      { name: 'actorId', patch: { actorId: 'actor-other' } },
      { name: 'accountsAllFlag', patch: { accountsAllFlag: true } },
      {
        name: 'accounts.status',
        patch: {
          accounts: [
            {
              maskedAccountId: 'm1',
              status: 'LIMIT',
              providerKind: 'GROK',
              effectiveInUse: 1,
              effectiveCap: 5,
            },
          ],
        },
      },
      {
        name: 'accounts.providerKind',
        patch: {
          accounts: [
            {
              maskedAccountId: 'm1',
              status: 'OK',
              providerKind: 'SPARK',
              effectiveInUse: 1,
              effectiveCap: 5,
            },
          ],
        },
      },
      {
        name: 'accounts.effectiveInUse',
        patch: {
          accounts: [
            {
              maskedAccountId: 'm1',
              status: 'OK',
              providerKind: 'GROK',
              effectiveInUse: 4,
              effectiveCap: 5,
            },
          ],
        },
      },
      {
        name: 'accounts.effectiveCap',
        patch: {
          accounts: [
            {
              maskedAccountId: 'm1',
              status: 'OK',
              providerKind: 'GROK',
              effectiveInUse: 1,
              effectiveCap: 10,
            },
          ],
        },
      },
      {
        name: 'accounts.maskedAccountId',
        patch: {
          accounts: [
            {
              maskedAccountId: 'm2',
              status: 'OK',
              providerKind: 'GROK',
              effectiveInUse: 1,
              effectiveCap: 5,
            },
          ],
        },
      },
    ]

    for (const c of cases) {
      const mutated = { ...base, ...c.patch }
      const h = requestHashOf(syncAccountsIdempotencyBody(mutated))
      expect(h, `field ${c.name} must change idempotency hash`).not.toBe(baseHash)
    }

    // Exact clone → same hash.
    const clone: SyncAccountsRequest = {
      ...base,
      accounts: base.accounts.map((a) => ({ ...a })),
      health: base.health ? { ...base.health } : undefined,
    }
    expect(requestHashOf(syncAccountsIdempotencyBody(clone))).toBe(baseHash)
  })

  it('rejects missing entityExpectedRev / canonicalHash and pin hash mismatch (no silent default)', async () => {
    const d = deps()
    const base = {
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: d.clock.nowISO(),
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'm1',
          status: 'OK' as const,
          providerKind: 'GROK' as const,
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT' as const,
      idempotencyKey: 'cas-neg-1',
      callerRole: 'ROOT_ORCHESTRATOR' as const,
    }
    await expect(
      syncAccounts(d, { ...base, canonicalHash: 'canon-test-pin' } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      syncAccounts(d, { ...base, entityExpectedRev: 0 } as never),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      syncAccounts(d, {
        ...base,
        entityExpectedRev: 0,
        canonicalHash: 'canon-test-pin',
        currentPinHash: 'different-pin-hash',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })
})

// ---------------------------------------------------------------------------
// Process-wide shared store: MCP write path == control-center UI read path
// ---------------------------------------------------------------------------
describe('shared account-sync store (MCP ↔ control-center parity)', () => {
  beforeEach(() => {
    resetMcpControlPlaneDeps()
    resetSharedAccountSyncStore()
  })
  afterEach(() => {
    resetMcpControlPlaneDeps()
    resetSharedAccountSyncStore()
  })

  it('authorized sync via shared deps is read back identically by CC helpers', async () => {
    const clock = createFakeClock()
    const atomic = createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ])
    const idempotency = createMemoryIdempotencyStorage()
    // Exact shared deps shape used by board-mcp accountSyncDeps():
    // accounts: getSharedAccountSyncStore()
    const mcpStyleDeps: AccountSyncDeps = {
      clock,
      accounts: getSharedAccountSyncStore(),
      atomic,
      idempotency,
    }

    const generatedAt = clock.nowISO()
    const sourceRevision = 42
    const write = await syncAccounts(mcpStyleDeps, {
      boardId: BOARD,
      sourceRevision,
      generatedAt,
      entityExpectedRev: 0,
      canonicalHash: 'canon-test-pin',
      expectedBoardRev: 0,
      accounts: [
        {
          maskedAccountId: 'acc_shared_ok',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
        },
        {
          maskedAccountId: 'acc_shared_limit',
          status: 'LIMIT',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
        {
          // secret-like fields must never land on the read model / projector path
          maskedAccountId: 'acc_shared_ban',
          status: 'BAN',
          providerKind: 'SPARK',
          effectiveInUse: 0,
          effectiveCap: 10,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'shared-store-write-1',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'mcp-root-test',
    })

    // Same process-wide store: read helper used by control-center-ui-adapter
    const snap = await readLatestAccountSyncSnapshot(BOARD)
    expect(snap).not.toBeNull()
    expect(snap!.boardId).toBe(BOARD)
    expect(snap!.sourceRevision).toBe(write.sourceRevision)
    expect(snap!.sourceRevision).toBe(sourceRevision)
    expect(snap!.generatedAt).toBe(generatedAt)
    expect(snap!.generatedAt).toBe(write.generatedAt)
    expect(snap!.accounts.map((a) => a.maskedAccountId).sort()).toEqual([
      'acc_shared_ban',
      'acc_shared_limit',
      'acc_shared_ok',
    ])
    // No token/raw identity keys on snapshot
    expect(JSON.stringify(snap)).not.toMatch(/password|token|secret|apiKey|authorization/i)

    // Store identity: MCP setter/getter and shared store are the same instance
    const viaSetter = createMemoryAccountSyncStore()
    setMcpAccountStore(viaSetter)
    expect(getSharedAccountSyncStore()).toBe(viaSetter)
    // After injection, previous snapshot is gone (isolation)
    expect(await readLatestAccountSyncSnapshot(BOARD)).toBeNull()

    // Restore shared path and re-prove write→read after re-bind of original store
    setSharedAccountSyncStore(mcpStyleDeps.accounts)
    const snap2 = await readLatestAccountSyncSnapshot(BOARD)
    expect(snap2?.sourceRevision).toBe(sourceRevision)
    expect(snap2?.generatedAt).toBe(generatedAt)

    const projected = projectAccountSyncCcReadModel(snap2)
    expect(projected).not.toBeNull()
    expect(projected!.boardId).toBe(BOARD)
    expect(projected!.sourceRevision).toBe(sourceRevision)
    expect(projected!.generatedAt).toBe(generatedAt)
    expect(projected!.accounts).toHaveLength(3)
    expect(JSON.stringify(projected)).not.toMatch(/password|token|secret/i)

    // Control-center aggregation + Ops fail-closed / capacity rules from same snapshot
    const raw = {
      id: BOARD,
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: BOARD,
      raw,
      tasks: [],
      opsAccounts: [{ id: 'legacy-should-not-drive-capacity', cap: 999, usable: true }],
      runs: [],
      boardContentHash: 'hash_shared_store_parity',
      boardRev: 99, // must NOT become sourceRevision
      lifecycleRev: 0,
      now: generatedAt,
      accountSyncSnapshot: snap2,
    })
    expect(agg.accountSyncMeta?.authoritative).toBe(true)
    expect(agg.accountSyncMeta?.sourceRevision).toBe(sourceRevision)
    expect(agg.accountSyncMeta?.sourceRevision).not.toBe(99)
    expect(agg.accountSyncMeta?.generatedAt).toBe(generatedAt)
    expect(agg.accounts.map((a) => a.maskedAccountId).sort()).toEqual([
      'acc_shared_ban',
      'acc_shared_limit',
      'acc_shared_ok',
    ])
    expect(agg.accounts.find((a) => a.status === 'BAN')?.quarantine).toBe(true)
    expect(agg.accounts.find((a) => a.status === 'LIMIT')).toBeTruthy()

    const ops = projectOps(agg)
    // Fresh publish without multi-surface parity → readbackParityOk false → fail-closed capacity 0
    expect(ops.data.sourceRevision).toBe(sourceRevision)
    expect(ops.data.sourceRevision).not.toBe(99)
    expect(ops.data.readbackParityOk).toBe(false)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.usableCapacity).toBe(0)
    expect(JSON.stringify(ops.data)).not.toMatch(/password|token|secret/i)
  })

  it('missing snapshot fail-closes Ops; reset clears both MCP and CC surfaces', async () => {
    expect(await readLatestAccountSyncSnapshot(BOARD)).toBeNull()
    const raw = {
      id: BOARD,
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: BOARD,
      raw,
      tasks: [],
      opsAccounts: [{ id: 'legacy', cap: 50, usable: true }],
      runs: [],
      boardContentHash: 'hash_missing_sync',
      boardRev: 7,
      lifecycleRev: 0,
      now: '2026-07-13T12:00:00.000Z',
      accountSyncSnapshot: null,
    })
    expect(agg.accountSyncMeta?.authoritative).toBe(false)
    expect(agg.accountSyncMeta?.sourceRevision).toBeNull()
    expect(agg.accountSyncMeta?.usableCapacity).toBe(0)
    expect(agg.accountSyncMeta?.stale).toBe(true)
    const ops = projectOps(agg)
    expect(ops.data.usableCapacity).toBe(0)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.sourceRevision).toBeNull()
    // boardRev must never substitute
    expect(ops.data.sourceRevision).not.toBe(7)

    // Write then reset via MCP helper — both surfaces empty
    const clock = createFakeClock()
    await syncAccounts(
      {
        clock,
        accounts: getSharedAccountSyncStore(),
        atomic: createMemoryControlPlaneAtomicStore([
          { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
        ]),
        idempotency: createMemoryIdempotencyStorage(),
      },
      {
        boardId: BOARD,
        sourceRevision: 1,
        generatedAt: clock.nowISO(),
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        canonicalHash: 'canon-test-pin',
        accounts: [grok('acc_tmp')],
        trigger: 'HEARTBEAT',
        idempotencyKey: 'tmp-reset',
        callerRole: 'ROOT_ORCHESTRATOR',
      },
    )
    expect(await readLatestAccountSyncSnapshot(BOARD)).not.toBeNull()
    resetMcpControlPlaneDeps()
    expect(await readLatestAccountSyncSnapshot(BOARD)).toBeNull()
  })
})
