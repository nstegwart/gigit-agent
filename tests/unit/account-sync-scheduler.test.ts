import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  ACCOUNT_PERIODIC_HEALTH_MS,
  ACCOUNT_PUBLISH_SLA_MS,
  AccountSyncError,
  createMemoryAccountSyncStore,
  isCoalescableAccountSyncTrigger,
  isImmediateAccountSyncTrigger,
  type AccountSyncDeps,
  type AccountSyncTrigger,
  type MaskedAccountStatus,
} from '#/server/account-sync'
import {
  ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS,
  assertAccountSyncSurfaceReadersComplete,
  createAccountSyncScheduler,
  createAccountSyncSchedulerFromAuthority,
  createAccountSyncSchedulerLoopOnError,
  createAccountSyncSchedulerLoopOnFatalError,
  createDurableAccountSyncSurfaceReaders,
  createIndependentAccountSyncSurfacePublisher,
  createMemoryAccountSyncSurfacePublisher,
  createSharedDurableAccountSyncSurfacePublisher,
  drainAccountSyncLoopFatalSinkForTests,
  emitAccountSyncLoopFatal,
  inferAccountSyncTriggerFromStatuses,
  readSharedAccountSyncSurface,
  resetSharedAccountSyncSurfacesForTests,
  startAccountSyncSchedulerLoop,
  type AccountSyncPublishIntent,
  type AccountSyncSurfaceReaders,
} from '#/server/account-sync-scheduler'
import { createMemoryMetricsRegistry } from '#/server/observability'
import {
  ACCOUNT_SURFACE_SCHEMA,
  createProductAccountSyncSurfaceReaders,
  readAuthenticatedApiAccountsService,
  readAuthenticatedUiAccountSourceService,
  readMcpListAccountsService,
  readOpsAccountSourceService,
  AccountSurfaceAuthError,
} from '#/server/account-surface-readers'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'

/** Minimal fatal secondary for tests that only assert primary/onError wiring. */
function noopFatal() {
  return async () => {}
}

const BOARD = 'mfs-rebuild'

function makeDeps(clock = createFakeClock()) {
  const atomic = createMemoryControlPlaneAtomicStore([
    { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
  ])
  const accounts = createMemoryAccountSyncStore()
  const idempotency = createMemoryIdempotencyStorage()
  const accountSync: AccountSyncDeps & { clock: ReturnType<typeof createFakeClock> } = {
    clock,
    accounts,
    atomic,
    idempotency,
  }
  return { clock, accountSync, accounts, atomic }
}

function baseAccounts(
  status: MaskedAccountStatus = 'OK',
  over: Partial<AccountSyncPublishIntent['accounts'][number]> = {},
): AccountSyncPublishIntent['accounts'] {
  return [
    {
      maskedAccountId: 'acct-mask-001',
      status,
      providerKind: 'GROK',
      effectiveInUse: status === 'REMOVED' || status === 'LIMIT' ? 0 : 1,
      effectiveCap: status === 'REMOVED' ? 0 : 5,
      physicalSlotsDisplay: '1/20',
      ...over,
    },
  ]
}

/** Resolve current CAS envelope from durable state (create=0, update=snapshot.entityRev). */
async function intent(
  d: ReturnType<typeof makeDeps>,
  over: Partial<AccountSyncPublishIntent> & Pick<AccountSyncPublishIntent, 'trigger' | 'sourceRevision' | 'idempotencyKey'>,
): Promise<AccountSyncPublishIntent> {
  const board = await d.atomic.getBoardState(BOARD)
  const prev = await d.accounts.get(BOARD)
  return {
    boardId: BOARD,
    generatedAt: d.clock.nowISO(),
    entityExpectedRev: prev?.entityRev ?? 0,
    expectedBoardRev: board.boardRev,
    canonicalHash: 'canon-sched-pin',
    accounts: baseAccounts(),
    callerRole: 'ROOT_ORCHESTRATOR',
    ...over,
  }
}

describe('account-sync-scheduler foundation (AC-ACCOUNT SLA)', () => {
  it('classifies HEARTBEAT as coalescable; all mandatory triggers as immediate except HEARTBEAT', () => {
    expect(isCoalescableAccountSyncTrigger('HEARTBEAT')).toBe(true)
    const immediate: Array<AccountSyncTrigger> = [
      'ORCHESTRATOR_LAUNCH',
      'WAVE_LAUNCH',
      'AGENT_LAUNCH',
      'MATERIAL_ASSIGNMENT',
      'STATUS_TRANSITION',
      'LIMIT_TRANSITION',
      'BAN_TRANSITION',
      'AUTH_EXPIRED_TRANSITION',
      'ROTATION',
      'REQUEUE',
      'INTEGRATION_CHECKPOINT',
      'WAVE_CLOSE',
      'PERIODIC_HEALTH',
    ]
    for (const t of immediate) {
      expect(isImmediateAccountSyncTrigger(t)).toBe(true)
      expect(isCoalescableAccountSyncTrigger(t)).toBe(false)
    }
  })

  it('AC-ACCOUNT-01: launch publishes to MCP/API/UI/Ops with same sourceRevision/generatedAt', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const gen = d.clock.nowISO()
    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 100,
        generatedAt: gen,
        idempotencyKey: 'launch-1',
      }),
    )
    expect(out.kind).toBe('PUBLISHED')
    expect(out.parityOk).toBe(true)
    expect(out.stale).toBe(false)
    expect(out.usableCapacity).toBeGreaterThan(0)
    expect(surfaces.log.map((l) => l.surface).sort()).toEqual(['api', 'mcp', 'ops', 'ui'])
    for (const entry of surfaces.log) {
      expect(entry.envelope.sourceRevision).toBe(100)
      expect(entry.envelope.generatedAt).toBe(gen)
      expect(JSON.stringify(entry.envelope)).not.toMatch(/password|token|secret/i)
    }
    const snap = await d.accounts.get(BOARD)
    expect(snap?.sourceRevision).toBe(100)
    expect(snap?.generatedAt).toBe(gen)
    expect(snap?.readbackSurfaces.mcp).toEqual({ sourceRevision: 100, generatedAt: gen })
    expect(snap?.readbackSurfaces.api).toEqual({ sourceRevision: 100, generatedAt: gen })
    expect(snap?.readbackSurfaces.ui).toEqual({ sourceRevision: 100, generatedAt: gen })
    expect(snap?.readbackSurfaces.ops).toEqual({ sourceRevision: 100, generatedAt: gen })
  })

  it('M4: publish wires failSafeActions into pending requeue/rotate/drain intents (no external side effects)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })

    // LIMIT account → STOP_LIMIT + PRESERVE_REQUEUE + ROTATE intents
    const limOut = await sched.enqueue(
      await intent(d, {
        trigger: 'LIMIT_TRANSITION',
        sourceRevision: 200,
        idempotencyKey: 'm4-limit-fs',
        accounts: [
          {
            maskedAccountId: 'lim-1',
            status: 'LIMIT',
            providerKind: 'GROK',
            effectiveInUse: 2,
            effectiveCap: 5,
          },
          {
            maskedAccountId: 'ok-1',
            status: 'OK',
            providerKind: 'GROK',
            effectiveInUse: 1,
            effectiveCap: 5,
          },
        ],
      }),
    )
    expect(limOut.kind).toBe('PUBLISHED')
    expect(limOut.failSafeIntents?.length).toBeGreaterThan(0)
    expect(
      limOut.failSafeIntents?.some(
        (i) =>
          i.action === 'STOP_LIMIT_ASSIGNMENT' &&
          i.maskedAccountId === 'lim-1' &&
          i.scheduleTrigger === 'LIMIT_TRANSITION' &&
          i.blocksAssignment,
      ),
    ).toBe(true)
    expect(
      limOut.failSafeIntents?.some(
        (i) =>
          i.action === 'PRESERVE_REQUEUE_UNFINISHED' &&
          i.scheduleTrigger === 'REQUEUE' &&
          i.maskedAccountId === 'lim-1' &&
          !i.blocksAssignment,
      ),
    ).toBe(true)
    expect(
      limOut.failSafeIntents?.some(
        (i) =>
          i.action === 'ROTATE_LIMIT_ACCOUNT' &&
          i.scheduleTrigger === 'ROTATION' &&
          i.maskedAccountId === 'lim-1',
      ),
    ).toBe(true)
    // No runner-mutation fields on any intent
    for (const i of limOut.failSafeIntents ?? []) {
      expect('runnerMutation' in i).toBe(false)
      expect('killRunners' in i).toBe(false)
    }

    const peeked = sched.peekFailSafeIntents(BOARD)
    expect(peeked.length).toBe(limOut.failSafeIntents?.length)
    expect(sched.getBoardState(BOARD).pendingFailSafeIntents.length).toBe(peeked.length)

    const drained = sched.drainFailSafeIntents(BOARD)
    expect(drained.length).toBe(peeked.length)
    expect(sched.peekFailSafeIntents(BOARD)).toEqual([])
    expect(sched.getBoardState(BOARD).pendingFailSafeIntents).toEqual([])

    // CPU>=90 → STOP_NEW_DISPATCH + BOUNDED_DRAIN_REDUCE intents
    const board = await d.atomic.getBoardState(BOARD)
    const prev = await d.accounts.get(BOARD)
    const cpuOut = await sched.enqueue({
      boardId: BOARD,
      sourceRevision: 201,
      generatedAt: d.clock.nowISO(),
      entityExpectedRev: prev!.entityRev,
      expectedBoardRev: board.boardRev,
      canonicalHash: 'canon-sched-pin',
      accounts: [
        {
          maskedAccountId: 'g1',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 5,
          effectiveCap: 5,
        },
      ],
      trigger: 'PERIODIC_HEALTH',
      idempotencyKey: 'm4-cpu-drain',
      callerRole: 'ROOT_ORCHESTRATOR',
      health: { cpuPercent: 95 },
    })
    expect(cpuOut.kind).toBe('PUBLISHED')
    expect(cpuOut.usableCapacity).toBe(0)
    expect(
      cpuOut.failSafeIntents?.some(
        (i) => i.action === 'STOP_NEW_DISPATCH' && i.blocksAssignment && i.scheduleTrigger === null,
      ),
    ).toBe(true)
    const drain = cpuOut.failSafeIntents?.find((i) => i.action === 'BOUNDED_DRAIN_REDUCE')
    expect(drain?.scheduleTrigger).toBe('PERIODIC_HEALTH')
    expect(drain?.blocksAssignment).toBe(true)
    expect(drain?.maxReduceSlots).toBeLessThanOrEqual(10)
    expect(drain && 'runnerMutation' in drain).toBe(false)
    expect(sched.peekFailSafeIntents(BOARD).some((i) => i.action === 'BOUNDED_DRAIN_REDUCE')).toBe(
      true,
    )
  })

  it('AC-ACCOUNT-02: HEARTBEAT coalesces; newest publishes within 30s SLA', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })

    const c1 = await sched.enqueue(
      await intent(d, {
        trigger: 'HEARTBEAT',
        sourceRevision: 1,
        idempotencyKey: 'hb-1',
        accounts: baseAccounts('OK', { effectiveInUse: 1 }),
      }),
    )
    expect(c1.kind).toBe('COALESCED')
    expect(c1.deadlineMs).toBe(d.clock.nowMs() + ACCOUNT_PUBLISH_SLA_MS)

    d.clock.advance(5_000)
    const c2 = await sched.enqueue(
      await intent(d, {
        trigger: 'HEARTBEAT',
        sourceRevision: 2,
        idempotencyKey: 'hb-2',
        accounts: baseAccounts('OK', { effectiveInUse: 2 }),
      }),
    )
    expect(c2.kind).toBe('COALESCED')
    expect(c2.coalescedCount).toBe(1)
    // Deadline fixed from first pending — newest still within window.
    expect(c2.deadlineMs).toBe(c1.deadlineMs)

    // Before deadline: still pending, not published.
    d.clock.advance(10_000)
    let tick = await sched.tick()
    expect(tick.published.length).toBe(0)
    expect(tick.pendingHeartbeats).toBe(1)
    expect(surfaces.log.length).toBe(0)

    // Cross deadline → publish newest (rev 2, inUse 2).
    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS) // past first-pending deadline
    tick = await sched.tick()
    expect(tick.published.length).toBe(1)
    expect(tick.published[0]?.kind).toBe('PUBLISHED')
    expect(tick.published[0]?.result?.sourceRevision).toBe(2)
    expect(tick.pendingHeartbeats).toBe(0)
    expect(surfaces.log.length).toBe(4)
    expect(surfaces.log[0]?.envelope.accounts[0]?.effectiveInUse).toBe(2)
  })

  it('AC-ACCOUNT-02: material/status transitions publish immediately (not coalesced)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    for (const trigger of ['MATERIAL_ASSIGNMENT', 'STATUS_TRANSITION'] as const) {
      const boardRev = (await d.atomic.getBoardState(BOARD)).boardRev
      const out = await sched.enqueue(
        await intent(d, {
          trigger,
          sourceRevision: 200 + boardRev,
          expectedBoardRev: boardRev,
          idempotencyKey: `imm-${trigger}`,
        }),
      )
      expect(out.kind).toBe('PUBLISHED')
      expect(out.parityOk).toBe(true)
    }
    expect(surfaces.log.length).toBe(8)
  })

  it('AC-ACCOUNT-03: LIMIT/BAN/403/AUTH_EXPIRED transitions publish within SLA path', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const cases: Array<{ trigger: AccountSyncTrigger; status: MaskedAccountStatus }> = [
      { trigger: 'LIMIT_TRANSITION', status: 'LIMIT' },
      { trigger: 'BAN_TRANSITION', status: 'BAN' },
      { trigger: 'STATUS_TRANSITION', status: '403' },
      { trigger: 'AUTH_EXPIRED_TRANSITION', status: 'AUTH_EXPIRED' },
    ]
    for (const c of cases) {
      const boardRev = (await d.atomic.getBoardState(BOARD)).boardRev
      const out = await sched.enqueue(
        await intent(d, {
          trigger: c.trigger,
          sourceRevision: 300 + boardRev,
          expectedBoardRev: boardRev,
          accounts: baseAccounts(c.status),
          idempotencyKey: `bad-${c.status}`,
        }),
      )
      expect(out.kind).toBe('PUBLISHED')
      expect(out.parityOk).toBe(true)
      // Fail-safe: non-usable statuses contribute 0 capacity from those accounts.
      const last = surfaces.log[surfaces.log.length - 1]
      expect(last?.envelope.accounts[0]?.status).toBe(c.status)
    }
  })

  it('AC-ACCOUNT-04/05: rotation/requeue/integration/wave close publish immediately', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    for (const trigger of [
      'ROTATION',
      'REQUEUE',
      'INTEGRATION_CHECKPOINT',
      'WAVE_CLOSE',
    ] as const) {
      const boardRev = (await d.atomic.getBoardState(BOARD)).boardRev
      const out = await sched.enqueue(
        await intent(d, {
          trigger,
          sourceRevision: 400 + boardRev,
          expectedBoardRev: boardRev,
          idempotencyKey: `close-${trigger}`,
        }),
      )
      expect(out.kind).toBe('PUBLISHED')
    }
    expect(surfaces.log.length).toBe(16)
  })

  it('AC-ACCOUNT-06: tick auto-publishes periodic health at least every 60s', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const first = await sched.enqueue(
      await intent(d, {
        trigger: 'AGENT_LAUNCH',
        sourceRevision: 10,
        idempotencyKey: 'agent-1',
      }),
    )
    expect(first.kind).toBe('PUBLISHED')
    const afterLaunch = surfaces.log.length

    // Within 60s: no auto periodic.
    d.clock.advance(ACCOUNT_PERIODIC_HEALTH_MS - 1)
    let tick = await sched.tick()
    expect(tick.published.filter((p) => p.trigger === 'PERIODIC_HEALTH').length).toBe(0)

    // At 60s boundary from last arm: periodic fires with next revision.
    d.clock.advance(2)
    tick = await sched.tick()
    const periodics = tick.published.filter((p) => p.trigger === 'PERIODIC_HEALTH')
    expect(periodics.length).toBe(1)
    expect(periodics[0]?.result?.sourceRevision).toBe(11)
    expect(surfaces.log.length).toBe(afterLaunch + 4)
    expect(sched.getBoardState(BOARD).lastPeriodicHealthAtMs).toBe(d.clock.nowMs())
  })

  it('AC-ACCOUNT-07: mismatched surface readback → stale + usableCapacity=0 after SLA', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher({
      mismatch: {
        ui: { sourceRevision: 999, generatedAt: '1999-01-01T00:00:00.000Z' },
      },
    })
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const gen = d.clock.nowISO()
    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'WAVE_LAUNCH',
        sourceRevision: 55,
        generatedAt: gen,
        idempotencyKey: 'wave-mismatch',
      }),
    )
    // Immediately after publish, parity false but within SLA window may not yet force stale
    // depending on evaluate timing — force past SLA.
    expect(out.parityOk).toBe(false)

    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS + 1)
    const tick = await sched.tick()
    const snap = tick.freshness.find((s) => s?.boardId === BOARD) ?? (await d.accounts.get(BOARD))
    expect(snap?.stale).toBe(true)
    expect(snap?.usableCapacity).toBe(0)
    expect(snap?.staleReason).toMatch(/SLA_MISS/)
    const board = await d.atomic.getBoardState(BOARD)
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_STALE/)
  })

  it('immediate trigger flushes/supersedes pending heartbeat (no server-local-only state)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'HEARTBEAT',
        sourceRevision: 1,
        idempotencyKey: 'hb-pending',
        accounts: baseAccounts('OK', { effectiveInUse: 1 }),
      }),
    )
    expect(sched.getBoardState(BOARD).pendingHeartbeat).not.toBeNull()

    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'LIMIT_TRANSITION',
        sourceRevision: 2,
        accounts: baseAccounts('LIMIT'),
        idempotencyKey: 'lim-1',
      }),
    )
    expect(out.kind).toBe('PUBLISHED')
    expect(out.result?.sourceRevision).toBe(2)
    expect(sched.getBoardState(BOARD).pendingHeartbeat).toBeNull()
    // Only LIMIT publish occurred (heartbeat superseded, not left local).
    expect(surfaces.log.every((l) => l.envelope.sourceRevision === 2)).toBe(true)
  })

  it('flush() force-publishes pending heartbeat before deadline', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'HEARTBEAT',
        sourceRevision: 7,
        idempotencyKey: 'hb-flush',
      }),
    )
    const flushed = await sched.flush(BOARD)
    expect(flushed.length).toBe(1)
    expect(flushed[0]?.kind).toBe('PUBLISHED')
    expect(flushed[0]?.result?.sourceRevision).toBe(7)
    expect(sched.getBoardState(BOARD).pendingHeartbeat).toBeNull()
  })

  it('rejects --accounts all and secret-like fields before publish', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await expect(
      sched.enqueue(
        await intent(d, {
          trigger: 'HEARTBEAT',
          sourceRevision: 1,
          idempotencyKey: 'all-flag',
          accountsAllFlag: true,
        }),
      ),
    ).rejects.toMatchObject({ code: 'ACCOUNTS_ALL_FORBIDDEN' })

    await expect(
      sched.enqueue(
        await intent(d, {
          trigger: 'ORCHESTRATOR_LAUNCH',
          sourceRevision: 1,
          idempotencyKey: 'sec-1',
          accounts: [
            {
              maskedAccountId: 'token-abc',
              status: 'OK',
              providerKind: 'GROK',
              effectiveInUse: 0,
              effectiveCap: 5,
            },
          ],
        }),
      ),
    ).rejects.toBeInstanceOf(AccountSyncError)

    expect(surfaces.log.length).toBe(0)
  })

  it('tombstone REMOVED accounts publish with zero contribution (capacity fail-safe)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'ROTATION',
        sourceRevision: 1,
        accounts: [
          ...baseAccounts('REMOVED', { maskedAccountId: 'acct-gone' }),
          {
            maskedAccountId: 'acct-mask-002',
            status: 'OK',
            providerKind: 'GROK',
            effectiveInUse: 0,
            effectiveCap: 5,
          },
        ],
        idempotencyKey: 'tomb-1',
      }),
    )
    expect(out.kind).toBe('PUBLISHED')
    const snap = await d.accounts.get(BOARD)
    expect(snap?.accounts.find((a) => a.maskedAccountId === 'acct-gone')?.tombstone).toBe(true)
    expect(out.usableCapacity).toBeGreaterThan(0) // remaining healthy grok
  })

  it('injectable authorityPublisher + clock are used (runtime wiring hooks)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    let authorityCalls = 0
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
      authorityPublisher: async (req) => {
        authorityCalls += 1
        // Delegate to real sync so store stays consistent.
        const { syncAccounts } = await import('#/server/account-sync')
        return syncAccounts(d.accountSync, req)
      },
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 1,
        idempotencyKey: 'inj-1',
      }),
    )
    expect(authorityCalls).toBe(1)
    expect(sched.snapshot()[BOARD]?.publishCount).toBe(1)
  })

  it('missing surface publication fails closed (no partial silent success)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher({ omit: ['ops'] })
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await expect(
      sched.enqueue(
        await intent(d, {
          trigger: 'ORCHESTRATOR_LAUNCH',
          sourceRevision: 1,
          idempotencyKey: 'omit-ops',
        }),
      ),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })
  })

  it('createAccountSyncSchedulerFromAuthority shares one instance + authority store', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncSchedulerFromAuthority({
      clock: d.clock,
      accounts: d.accounts,
      atomic: d.atomic,
      idempotency: d.accountSync.idempotency,
      surfacePublisher: surfaces,
    })

    // Board isolation inside single shared scheduler instance.
    const boardB = 'other-board'
    await d.atomic.setBoardState({
      boardId: boardB,
      boardRev: 0,
      dispatchBlocked: false,
      dispatchBlockedReason: null,
    })

    await sched.enqueue(
      await intent(d, {
        boardId: BOARD,
        trigger: 'HEARTBEAT',
        sourceRevision: 1,
        idempotencyKey: 'auth-hb-a',
      }),
    )
    await sched.enqueue(
      await intent(d, {
        boardId: boardB,
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 5,
        idempotencyKey: 'auth-launch-b',
      }),
    )

    expect(sched.getBoardState(BOARD).pendingHeartbeat).not.toBeNull()
    expect(sched.getBoardState(boardB).pendingHeartbeat).toBeNull()
    expect(sched.getBoardState(boardB).publishCount).toBe(1)

    const snapB = await d.accounts.get(boardB)
    expect(snapB?.sourceRevision).toBe(5)
    // Same object identity across list/snapshot (shared instance).
    expect(sched.listBoards().sort()).toEqual([BOARD, boardB].sort())
  })

  it('shared-instance freshness: same scheduler object keeps deadline after re-bind', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncSchedulerFromAuthority({
      clock: d.clock,
      accounts: d.accounts,
      atomic: d.atomic,
      idempotency: d.accountSync.idempotency,
      surfacePublisher: surfaces,
    })
    // Simulate "re-get" by aliasing the same reference (runtime getter pattern).
    const again = sched

    const c1 = await sched.enqueue(
      await intent(d, {
        trigger: 'HEARTBEAT',
        sourceRevision: 1,
        idempotencyKey: 'fresh-hb-1',
      }),
    )
    expect(again.getBoardState(BOARD).pendingHeartbeatDeadlineMs).toBe(c1.deadlineMs)
    expect(c1.deadlineMs).toBe(d.clock.nowMs() + ACCOUNT_PUBLISH_SLA_MS)

    d.clock.advance(ACCOUNT_PUBLISH_SLA_MS)
    const tick = await again.tick()
    expect(tick.published.length).toBe(1)
    expect(tick.published[0]?.result?.sourceRevision).toBe(1)
    const snap = await d.accounts.get(BOARD)
    expect(snap?.sourceRevision).toBe(1)
    expect(snap?.stale).toBe(false)
  })

  it('independent durable surface readers reload authoritative snapshot (not label-echo)', async () => {
    resetSharedAccountSyncSurfacesForTests()
    const d = makeDeps()
    // Seed durable snapshot first.
    await d.accounts.put({
      boardId: BOARD,
      sourceRevision: 7,
      generatedAt: '2026-07-13T00:00:00.000Z',
      generatedAtMs: Date.parse('2026-07-13T00:00:00.000Z'),
      accounts: [],
      readbackSurfaces: { mcp: null, api: null, ui: null, ops: null },
      publishedAtMs: 0,
      lastPeriodicHealthAtMs: null,
      stale: false,
      staleReason: null,
      usableCapacity: 1,
      capacity: {} as never,
      entityRev: 1,
    })
    const pub = createSharedDurableAccountSyncSurfacePublisher({
      accounts: d.accounts,
      nowMs: () => 42_000,
    })
    // Envelope identity matches durable store — each surface reloads independently.
    const observed = await pub.publish('mcp', {
      boardId: BOARD,
      sourceRevision: 7,
      generatedAt: '2026-07-13T00:00:00.000Z',
      trigger: 'ORCHESTRATOR_LAUNCH',
      accounts: [],
      usableCapacity: 1,
      stale: false,
      capacity: {} as never,
    })
    expect(observed).toEqual({
      sourceRevision: 7,
      generatedAt: '2026-07-13T00:00:00.000Z',
    })
    expect(readSharedAccountSyncSurface(BOARD, 'mcp')).toEqual({
      sourceRevision: 7,
      generatedAt: '2026-07-13T00:00:00.000Z',
      publishedAtMs: 42_000,
    })
    expect(readSharedAccountSyncSurface(BOARD, 'api')).toBeNull()

    // Four independent reader objects (not one shared echo adapter).
    expect(pub.readers.mcp).not.toBe(pub.readers.api)
    expect(pub.readers.ui).not.toBe(pub.readers.ops)
  })

  it('independent publisher fails closed when any surface reader is absent', () => {
    const readers = createDurableAccountSyncSurfaceReaders(createMemoryAccountSyncStore())
    const partial = { ...readers, ops: undefined } as unknown as AccountSyncSurfaceReaders
    expect(() => assertAccountSyncSurfaceReadersComplete(partial)).toThrow(AccountSyncError)
    expect(() =>
      createIndependentAccountSyncSurfacePublisher({ readers: partial }),
    ).toThrow(/ops|reader/i)
    expect(() =>
      createSharedDurableAccountSyncSurfacePublisher({ accounts: null as never }),
    ).toThrow(/accounts store/)
  })

  it('independent publisher rejects envelope/identity mismatch (not label-echo)', async () => {
    const d = makeDeps()
    await d.accounts.put({
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: '2026-07-13T00:00:01.000Z',
      generatedAtMs: Date.parse('2026-07-13T00:00:01.000Z'),
      accounts: [],
      readbackSurfaces: { mcp: null, api: null, ui: null, ops: null },
      publishedAtMs: 0,
      lastPeriodicHealthAtMs: null,
      stale: false,
      staleReason: null,
      usableCapacity: 0,
      capacity: {} as never,
      entityRev: 1,
    })
    const pub = createIndependentAccountSyncSurfacePublisher({
      readers: createDurableAccountSyncSurfaceReaders(d.accounts),
      recordShared: false,
    })
    await expect(
      pub.publish('ui', {
        boardId: BOARD,
        sourceRevision: 99, // mismatch vs durable
        generatedAt: '2026-07-13T00:00:01.000Z',
        trigger: 'HEARTBEAT',
        accounts: [],
        usableCapacity: 0,
        stale: false,
        capacity: {} as never,
      }),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })
  })

  it('startAccountSyncSchedulerLoop requires onError + onFatalError and is unref + stoppable', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    expect(() =>
      startAccountSyncSchedulerLoop(sched, { intervalMs: 60_000, unref: true } as never),
    ).toThrow(/onError/)
    expect(() =>
      startAccountSyncSchedulerLoop(sched, {
        intervalMs: 60_000,
        unref: true,
        onError: () => {},
      } as never),
    ).toThrow(/onFatalError/)
    const loop = startAccountSyncSchedulerLoop(sched, {
      intervalMs: 60_000,
      unref: true,
      onError: () => {},
      onFatalError: noopFatal(),
    })
    expect(loop.isRunning()).toBe(true)
    expect(loop.intervalMs).toBe(60_000)
    loop.stop()
    expect(loop.isRunning()).toBe(false)
    loop.stop() // idempotent
  })

  it('fake-clock: tick rejection onError marks watched boards ACCOUNT_SYNC_STALE usableCapacity=0 + alert', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    // Publish once so the board is watched and has a durable snapshot.
    await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 1,
        idempotencyKey: 'loop-rej-1',
      }),
    )
    const snapOk = await d.accounts.get(BOARD)
    expect(snapOk?.stale).toBe(false)
    expect(snapOk?.usableCapacity).toBeGreaterThan(0)

    const alerts: Array<{ kind: string; boardIds: Array<string>; reason: string }> = []
    const onError = createAccountSyncSchedulerLoopOnError({
      scheduler: sched,
      nowMs: () => d.clock.nowMs(),
      onAlert: (ev) => {
        alerts.push({
          kind: ev.kind,
          boardIds: ev.boardIds,
          reason: ev.reason,
        })
      },
    })

    // Simulate autonomous loop tick rejection (fake clock — no wall interval wait).
    await onError(new Error('tick boom: injected rejection'))

    const snap = await d.accounts.get(BOARD)
    expect(snap?.stale).toBe(true)
    expect(snap?.usableCapacity).toBe(0)
    expect(snap?.staleReason).toBe('ACCOUNT_SYNC_LOOP_TICK_REJECTED')
    const board = await d.atomic.getBoardState(BOARD)
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_STALE/)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_LOOP_TICK_REJECTED/)
    expect(alerts).toHaveLength(1)
    expect(alerts[0]?.kind).toBe('ACCOUNT_SYNC_LOOP_TICK_REJECTED')
    expect(alerts[0]?.boardIds).toContain(BOARD)
    expect(alerts[0]?.reason).toBe('ACCOUNT_SYNC_LOOP_TICK_REJECTED')
  })

  it('startAccountSyncSchedulerLoop invokes onError when tick rejects (never swallows)', async () => {
    let tickCalls = 0
    const stubSched = {
      async tick() {
        tickCalls += 1
        throw new Error('forced tick rejection')
      },
      listBoards: () => [BOARD],
      failClosedStale: async () => null,
      enqueue: async () => ({ kind: 'SKIPPED' as const, trigger: 'HEARTBEAT' as const, boardId: BOARD }),
      flush: async () => [],
      getBoardState: () => ({}) as never,
      snapshot: () => ({}),
    }
    const seen: Array<unknown> = []
    const loop = startAccountSyncSchedulerLoop(stubSched as never, {
      intervalMs: 20,
      unref: true,
      onError: (err) => {
        seen.push(err)
      },
      onFatalError: noopFatal(),
    })
    // Wait for at least one wall-clock interval fire.
    await new Promise((r) => setTimeout(r, 60))
    loop.stop()
    expect(tickCalls).toBeGreaterThanOrEqual(1)
    expect(seen.length).toBeGreaterThanOrEqual(1)
    expect(String(seen[0])).toMatch(/forced tick rejection/)
  })

  it('secondary onFatalError fires when primary onError rejects (ACCOUNT_SYNC_LOOP_FATAL)', async () => {
    drainAccountSyncLoopFatalSinkForTests()
    let tickCalls = 0
    const failClosed: Array<string> = []
    const stubSched = {
      async tick() {
        tickCalls += 1
        throw new Error('tick primary path')
      },
      listBoards: () => [BOARD],
      failClosedStale: async (boardId: string, reason: string) => {
        failClosed.push(`${boardId}:${reason}`)
        return null
      },
      enqueue: async () => ({ kind: 'SKIPPED' as const, trigger: 'HEARTBEAT' as const, boardId: BOARD }),
      flush: async () => [],
      getBoardState: () => ({}) as never,
      snapshot: () => ({}),
    }
    const fatals: Array<{ kind: string; phase: string }> = []
    const loop = startAccountSyncSchedulerLoop(stubSched as never, {
      intervalMs: 20,
      unref: true,
      onError: async () => {
        throw new Error('primary onError rejected')
      },
      onFatalError: async (ev) => {
        fatals.push({ kind: ev.kind, phase: ev.phase })
        // Production secondary also fail-closes + emits.
        await createAccountSyncSchedulerLoopOnFatalError({
          scheduler: stubSched as never,
          logLine: () => {},
        })(ev)
      },
    })
    await new Promise((r) => setTimeout(r, 80))
    loop.stop()
    expect(tickCalls).toBeGreaterThanOrEqual(1)
    expect(fatals.length).toBeGreaterThanOrEqual(1)
    expect(fatals[0]?.kind).toBe('ACCOUNT_SYNC_LOOP_FATAL')
    expect(fatals[0]?.phase).toBe('PRIMARY_ON_ERROR')
    expect(failClosed.some((s) => s.includes('ACCOUNT_SYNC_LOOP_FATAL'))).toBe(true)
    const sink = drainAccountSyncLoopFatalSinkForTests()
    expect(sink.some((s) => s.event.kind === 'ACCOUNT_SYNC_LOOP_FATAL')).toBe(true)
  })

  it('emitAccountSyncLoopFatal records structured log without empty swallow', () => {
    drainAccountSyncLoopFatalSinkForTests()
    const lines: Array<string> = []
    emitAccountSyncLoopFatal(
      {
        kind: 'ACCOUNT_SYNC_LOOP_FATAL',
        error: new Error('boom'),
        boardIds: [BOARD],
        atMs: 1,
        reason: 'ACCOUNT_SYNC_LOOP_FATAL',
        phase: 'SECONDARY_ON_FATAL',
      },
      { logLine: (l) => lines.push(l) },
    )
    expect(lines.length).toBe(1)
    expect(lines[0]).toMatch(/ACCOUNT_SYNC_LOOP_FATAL/)
    expect(drainAccountSyncLoopFatalSinkForTests().length).toBe(1)
  })

  it('emitAccountSyncLoopFatal increments api_error_rate metric with scheduler labels', () => {
    drainAccountSyncLoopFatalSinkForTests()
    const metrics = createMemoryMetricsRegistry(() => 1000)
    emitAccountSyncLoopFatal(
      {
        kind: 'ACCOUNT_SYNC_LOOP_FATAL',
        error: new Error('metric-boom'),
        boardIds: [BOARD],
        atMs: 1000,
        reason: 'ACCOUNT_SYNC_LOOP_FATAL',
        phase: 'SECONDARY_ON_FATAL',
      },
      { metrics, logLine: () => {} },
    )
    expect(metrics.sum('api_error_rate')).toBe(1)
    expect(metrics.count('api_error_rate')).toBe(1)
    const sample = metrics.snapshot().find((s) => s.category === 'api_error_rate')
    expect(sample?.labels?.endpoint).toBe(ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.endpoint)
    expect(sample?.labels?.event).toBe(ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.event)
    expect(sample?.labels?.phase).toBe('SECONDARY_ON_FATAL')
    drainAccountSyncLoopFatalSinkForTests()
  })

  it('failClosedStale rejection emits FATAL then propagates to tertiary sink (not swallowed)', async () => {
    drainAccountSyncLoopFatalSinkForTests()
    const metrics = createMemoryMetricsRegistry(() => Date.now())
    const lines: Array<string> = []
    let tickCalls = 0
    const stubSched = {
      async tick() {
        tickCalls += 1
        throw new Error('tick primary path')
      },
      listBoards: () => [BOARD],
      failClosedStale: async () => {
        throw new Error('failClosedStale boom')
      },
      enqueue: async () => ({ kind: 'SKIPPED' as const, trigger: 'HEARTBEAT' as const, boardId: BOARD }),
      flush: async () => [],
      getBoardState: () => ({}) as never,
      snapshot: () => ({}),
    }
    const loop = startAccountSyncSchedulerLoop(stubSched as never, {
      intervalMs: 20,
      unref: true,
      metrics,
      logLine: (l) => lines.push(l),
      onError: async () => {
        throw new Error('primary onError rejected')
      },
      onFatalError: createAccountSyncSchedulerLoopOnFatalError({
        scheduler: stubSched as never,
        metrics,
        logLine: (l) => lines.push(l),
      }),
    })
    await new Promise((r) => setTimeout(r, 100))
    loop.stop()
    expect(tickCalls).toBeGreaterThanOrEqual(1)
    const sink = drainAccountSyncLoopFatalSinkForTests()
    // Secondary emit (failClosed collect + structured fatal) then tertiary from throw.
    expect(sink.some((s) => s.event.kind === 'ACCOUNT_SYNC_LOOP_FATAL')).toBe(true)
    expect(sink.some((s) => s.event.phase === 'TERTIARY_SINK')).toBe(true)
    const tertiary = sink.find((s) => s.event.phase === 'TERTIARY_SINK')
    expect(String(tertiary?.event.error)).toMatch(/failClosedStale/)
    // Metric increments for secondary + tertiary emissions.
    expect(metrics.sum('api_error_rate')).toBeGreaterThanOrEqual(2)
    const fatalSamples = metrics
      .snapshot()
      .filter(
        (s) =>
          s.category === 'api_error_rate' &&
          s.labels?.event === 'ACCOUNT_SYNC_LOOP_FATAL' &&
          s.labels?.endpoint === 'account-sync-scheduler',
      )
    expect(fatalSamples.length).toBeGreaterThanOrEqual(2)
    expect(fatalSamples.some((s) => s.labels?.phase === 'TERTIARY_SINK')).toBe(true)
    expect(lines.some((l) => l.includes('ACCOUNT_SYNC_LOOP_FATAL'))).toBe(true)
  })

  it('createAccountSyncSchedulerLoopOnFatalError throws after emit when failClosedStale rejects', async () => {
    drainAccountSyncLoopFatalSinkForTests()
    const metrics = createMemoryMetricsRegistry()
    const stubSched = {
      listBoards: () => [BOARD],
      failClosedStale: async () => {
        throw new Error('stale-mark-failed')
      },
    }
    const handler = createAccountSyncSchedulerLoopOnFatalError({
      scheduler: stubSched as never,
      metrics,
      logLine: () => {},
    })
    await expect(
      handler({
        kind: 'ACCOUNT_SYNC_LOOP_FATAL',
        error: new Error('primary handler failed'),
        primaryError: new Error('tick failed'),
        boardIds: [BOARD],
        atMs: 42,
        reason: 'ACCOUNT_SYNC_LOOP_FATAL',
        phase: 'PRIMARY_ON_ERROR',
      }),
    ).rejects.toThrow(/failClosedStale rejected/)
    expect(metrics.sum('api_error_rate')).toBe(1)
    const sink = drainAccountSyncLoopFatalSinkForTests()
    expect(sink.length).toBe(1)
    expect(sink[0]?.event.kind).toBe('ACCOUNT_SYNC_LOOP_FATAL')
  })

  it('four product surface services return same sourceRevision/generatedAt + distinct schemas', async () => {
    const d = makeDeps()
    const gen = '2026-07-13T12:00:00.000Z'
    await d.accounts.put({
      boardId: BOARD,
      sourceRevision: 42,
      generatedAt: gen,
      generatedAtMs: Date.parse(gen),
      accounts: [
        {
          maskedAccountId: 'acct-mask-001',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
          physicalSlotsDisplay: '0/5',
          adaptiveQuotaState: null,
          reason: null,
          statusChangedAt: null,
          tombstone: false,
        },
      ],
      readbackSurfaces: {
        mcp: { sourceRevision: 42, generatedAt: gen },
        api: { sourceRevision: 42, generatedAt: gen },
        ui: { sourceRevision: 42, generatedAt: gen },
        ops: { sourceRevision: 42, generatedAt: gen },
      },
      publishedAtMs: Date.parse(gen),
      lastPeriodicHealthAtMs: null,
      stale: false,
      staleReason: null,
      usableCapacity: 5,
      capacity: {} as never,
      entityRev: 1,
    })

    const mcp = await readMcpListAccountsService({
      boardId: BOARD,
      accounts: d.accounts,
      auth: { kind: 'system' },
    })
    const api = await readAuthenticatedApiAccountsService({
      boardId: BOARD,
      accounts: d.accounts,
      auth: { kind: 'system' },
    })
    const ui = await readAuthenticatedUiAccountSourceService({
      boardId: BOARD,
      accounts: d.accounts,
      auth: { kind: 'system' },
    })
    const ops = await readOpsAccountSourceService({
      boardId: BOARD,
      accounts: d.accounts,
      auth: { kind: 'system' },
    })

    expect(mcp?.sourceRevision).toBe(42)
    expect(api?.sourceRevision).toBe(42)
    expect(ui?.sourceRevision).toBe(42)
    expect(ops?.sourceRevision).toBe(42)
    expect(mcp?.generatedAt).toBe(gen)
    expect(api?.generatedAt).toBe(gen)
    expect(ui?.generatedAt).toBe(gen)
    expect(ops?.generatedAt).toBe(gen)
    expect(mcp?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.mcp)
    expect(api?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.api)
    expect(ui?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.ui)
    expect(ops?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.ops)
    // Distinct schemas (not identical-store echo of one envelope shape).
    expect(new Set([mcp!.schema, api!.schema, ui!.schema, ops!.schema]).size).toBe(4)

    const readers = createProductAccountSyncSurfaceReaders(d.accounts)
    expect(readers.mcp).not.toBe(readers.api)
    expect(readers.ui).not.toBe(readers.ops)
    const identities = await Promise.all(
      (['mcp', 'api', 'ui', 'ops'] as const).map((s) =>
        readers[s].readAuthoritativeIdentity(BOARD),
      ),
    )
    for (const id of identities) {
      expect(id?.sourceRevision).toBe(42)
      expect(id?.generatedAt).toBe(gen)
      expect(id?.schema).toBeTruthy()
    }
  })

  it('authenticated API service denies unauthenticated session', async () => {
    const d = makeDeps()
    await expect(
      readAuthenticatedApiAccountsService({
        boardId: BOARD,
        accounts: d.accounts,
        auth: { kind: 'session', user: null },
      }),
    ).rejects.toBeInstanceOf(AccountSurfaceAuthError)
    await expect(
      readAuthenticatedApiAccountsService({
        boardId: BOARD,
        accounts: d.accounts,
        auth: { kind: 'session', user: null },
      }),
    ).rejects.toMatchObject({ status: 401, code: 'AUTHORIZATION_REQUIRED' })
  })

  it('product durable readers used by default authority publisher keep same-revision parity', async () => {
    resetSharedAccountSyncSurfacesForTests()
    const d = makeDeps()
    const readers = createDurableAccountSyncSurfaceReaders(d.accounts)
    const pub = createIndependentAccountSyncSurfacePublisher({
      readers,
      recordShared: true,
      nowMs: () => 99_000,
    })
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: pub,
    })
    const gen = d.clock.nowISO()
    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 77,
        generatedAt: gen,
        idempotencyKey: 'product-parity-1',
      }),
    )
    expect(out.kind).toBe('PUBLISHED')
    expect(out.parityOk).toBe(true)
    expect(out.surfaces?.mcp).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(out.surfaces?.api).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(out.surfaces?.ui).toEqual({ sourceRevision: 77, generatedAt: gen })
    expect(out.surfaces?.ops).toEqual({ sourceRevision: 77, generatedAt: gen })
    // Product readers attach schema on identity read.
    const idMcp = await readers.mcp.readAuthoritativeIdentity(BOARD)
    expect(idMcp?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.mcp)
  })

  it('inferAccountSyncTriggerFromStatuses maps BAN/AUTH/LIMIT', () => {
    expect(inferAccountSyncTriggerFromStatuses(['BAN'])).toBe('BAN_TRANSITION')
    expect(inferAccountSyncTriggerFromStatuses(['AUTH_EXPIRED'])).toBe('AUTH_EXPIRED_TRANSITION')
    expect(inferAccountSyncTriggerFromStatuses(['LIMIT'])).toBe('LIMIT_TRANSITION')
    expect(inferAccountSyncTriggerFromStatuses(['403'])).toBe('LIMIT_TRANSITION')
    expect(inferAccountSyncTriggerFromStatuses(['OK'], 'ORCHESTRATOR_LAUNCH')).toBe(
      'ORCHESTRATOR_LAUNCH',
    )
  })

  it('failClosedStale sets usableCapacity=0 + dispatchBlocked', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 1,
        idempotencyKey: 'fc-1',
      }),
    )
    const stale = await sched.failClosedStale(BOARD, 'NOTIFY_FAILED:TEST')
    expect(stale?.stale).toBe(true)
    expect(stale?.usableCapacity).toBe(0)
    const board = await d.atomic.getBoardState(BOARD)
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/NOTIFY_FAILED:TEST/)
  })

  it('churn: publish four surfaces bounds entityRev to auth+1 (not +4); exact parity', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    const gen = d.clock.nowISO()
    const out = await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 200,
        generatedAt: gen,
        idempotencyKey: 'bound-rev-1',
        // inUse 0 → healthy Grok remaining slots = 5 (AC-CAP bootstrap)
        accounts: baseAccounts('OK', { effectiveInUse: 0, effectiveCap: 5 }),
      }),
    )
    expect(out.kind).toBe('PUBLISHED')
    expect(out.parityOk).toBe(true)
    expect(out.stale).toBe(false)
    expect(out.usableCapacity).toBe(5)
    const snap = await d.accounts.get(BOARD)
    // authority write (+1) + coalesced four-surface readback (+1) = 2, not 1+4=5
    expect(snap?.entityRev).toBe(2)
    expect(snap?.sourceRevision).toBe(200)
    expect(snap?.generatedAt).toBe(gen)
    expect(snap?.readbackSurfaces.mcp).toEqual({ sourceRevision: 200, generatedAt: gen })
    expect(snap?.readbackSurfaces.api).toEqual({ sourceRevision: 200, generatedAt: gen })
    expect(snap?.readbackSurfaces.ui).toEqual({ sourceRevision: 200, generatedAt: gen })
    expect(snap?.readbackSurfaces.ops).toEqual({ sourceRevision: 200, generatedAt: gen })
    expect(surfaces.log).toHaveLength(4)
  })

  it('churn: failClosedStale no-ops entityRev when already stale+usable0', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 1,
        idempotencyKey: 'fc-noop-1',
      }),
    )
    const first = await sched.failClosedStale(BOARD, 'NOTIFY_FAILED:A')
    expect(first?.stale).toBe(true)
    expect(first?.usableCapacity).toBe(0)
    const revAfterFirst = first!.entityRev

    const second = await sched.failClosedStale(BOARD, 'NOTIFY_FAILED:B')
    expect(second?.entityRev).toBe(revAfterFirst)
    expect(second?.usableCapacity).toBe(0)
    expect(second?.stale).toBe(true)
    // original reason retained (no put)
    expect(second?.staleReason).toBe('NOTIFY_FAILED:A')

    const third = await sched.failClosedStale(BOARD, 'SURFACE_PUBLISH_FAILED')
    expect(third?.entityRev).toBe(revAfterFirst)
  })

  it('concurrent failClosedStale vs authority: newer sourceRevision not lost (lock-serialized)', async () => {
    const d = makeDeps()
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: d.clock,
      accountSync: d.accountSync,
      surfacePublisher: surfaces,
    })
    await sched.enqueue(
      await intent(d, {
        trigger: 'ORCHESTRATOR_LAUNCH',
        sourceRevision: 1,
        idempotencyKey: 'race-seed-1',
        accounts: baseAccounts('OK', {
          maskedAccountId: 'acct-seed',
          effectiveInUse: 0,
          effectiveCap: 5,
        }),
      }),
    )

    const authSource = 9999
    const authMask = 'acct-authority-winner'
    let authorityOk = false

    const failClosers = Array.from({ length: 32 }, (_, i) =>
      sched.failClosedStale(BOARD, `RACE_FAIL_CLOSE:${i}`),
    )
    // Multiple authority workers all try the same newer authority identity (retry CAS).
    const authorities = Array.from({ length: 8 }, async (_, i) => {
      for (let attempt = 0; attempt < 50; attempt++) {
        const live = await d.accounts.get(BOARD)
        const board = await d.atomic.getBoardState(BOARD)
        try {
          const { syncAccounts } = await import('#/server/account-sync')
          const r = await syncAccounts(d.accountSync, {
            boardId: BOARD,
            sourceRevision: authSource,
            generatedAt: d.clock.nowISO(),
            entityExpectedRev: live?.entityRev ?? 0,
            expectedBoardRev: board.boardRev,
            canonicalHash: 'canon-sched-pin',
            accounts: baseAccounts('OK', {
              maskedAccountId: authMask,
              effectiveInUse: 0,
              effectiveCap: 5,
            }),
            trigger: 'ORCHESTRATOR_LAUNCH',
            idempotencyKey: `race-auth-${i}-a${attempt}`,
            callerRole: 'ROOT_ORCHESTRATOR',
            actorId: 'race-auth',
          })
          if (!r.replayed) authorityOk = true
          return
        } catch (e) {
          if (e instanceof AccountSyncError && e.code === 'STALE_REVISION') continue
          throw e
        }
      }
      throw new Error(`authority worker ${i} exhausted retries`)
    })

    await Promise.all([...failClosers, ...authorities])

    expect(authorityOk).toBe(true)
    const final = await d.accounts.get(BOARD)
    expect(final).not.toBeNull()
    // Fail-close may run last (stale usable0) but must not restore pre-authority seed.
    expect(final!.sourceRevision).toBe(authSource)
    expect(final!.accounts[0]?.maskedAccountId).toBe(authMask)
    expect(Number(final!.sourceRevision)).not.toBe(1)
    const board = await d.atomic.getBoardState(BOARD)
    if (final!.stale) {
      expect(final!.usableCapacity).toBe(0)
      expect(board.dispatchBlocked).toBe(true)
    } else {
      expect(final!.usableCapacity).toBe(5)
    }
  })
})
