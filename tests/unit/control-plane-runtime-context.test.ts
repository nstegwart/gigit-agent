/**
 * Control-plane runtime context — lazy global-symbol singleton, fail-closed
 * production DB gate, test-only memory setter/resetter. No real MySQL.
 * Includes AccountSyncScheduler process attachment (shared / isolation / freshness).
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  ACCOUNT_PERIODIC_HEALTH_MS,
  ACCOUNT_PUBLISH_SLA_MS,
} from '#/server/account-sync'
import {
  createMemoryAccountSyncSurfacePublisher,
  drainAccountSyncLoopFatalSinkForTests,
} from '#/server/account-sync-scheduler'
import { createFakeClock } from '#/server/board-store'
import { createMemoryMetricsRegistry } from '#/server/observability'
import { createMemoryControlDataSql } from '#/server/control-data-persistence'
import {
  CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL,
  ControlPlaneRuntimeContextError,
  buildMysqlControlPlaneRuntimeContext,
  checkDbConfigForContext,
  createMemoryControlPlaneRuntimeContext,
  createMemorySqlBackedControlPlaneRuntimeContext,
  getAccountSyncScheduler,
  getControlPlaneRuntimeContext,
  hasTestControlPlaneRuntimeContext,
  isApprovedTestRetentionContext,
  isProductionOrServerEnv,
  peekAccountSyncScheduler,
  peekControlPlaneRuntimeContext,
  readDbConfigSnapshot,
  resetControlPlaneRuntimeContextForTests,
  setTestControlPlaneRuntimeContext,
} from '#/server/control-plane-runtime-context'
import {
  createMemoryAtomicSqlExecutor,
  createMysqlControlPlaneAtomicStore,
} from '#/server/mysql-control-plane-atomic'

describe('control-plane-runtime-context', () => {
  beforeEach(() => {
    resetControlPlaneRuntimeContextForTests()
  })

  afterEach(() => {
    resetControlPlaneRuntimeContextForTests()
  })

  it('exposes a stable global Symbol.for key', () => {
    expect(CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL).toBe(
      Symbol.for('cairn.controlPlaneRuntimeContext.v1'),
    )
    expect(typeof CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL).toBe('symbol')
  })

  it('isProductionOrServerEnv detects production/staging/server markers', () => {
    expect(isProductionOrServerEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionOrServerEnv({ CAIRN_ENV: 'staging' })).toBe(true)
    expect(isProductionOrServerEnv({ APP_ENV: 'prod' })).toBe(true)
    expect(isProductionOrServerEnv({ CAIRN_SERVER: '1' })).toBe(true)
    expect(isProductionOrServerEnv({ NODE_ENV: 'test' })).toBe(false)
    expect(isProductionOrServerEnv({ NODE_ENV: 'development' })).toBe(false)
  })

  it('checkDbConfigForContext fail-closes when user/database missing', () => {
    const err = checkDbConfigForContext({
      NODE_ENV: 'production',
      CAIRN_DB_HOST: '127.0.0.1',
      // no user / name
    })
    expect(err).toBeInstanceOf(ControlPlaneRuntimeContextError)
    expect(err?.code).toBe('DB_UNAVAILABLE')
    expect(err?.message).toMatch(/CAIRN_DB_USER/)
  })

  it('checkDbConfigForContext accepts complete identity', () => {
    const err = checkDbConfigForContext({
      CAIRN_DB_HOST: '127.0.0.1',
      CAIRN_DB_USER: 'u',
      CAIRN_DB_NAME: 'cairn_taskmanager',
      CAIRN_DB_PASSWORD: 'p',
    })
    expect(err).toBeNull()
    const snap = readDbConfigSnapshot({
      CAIRN_DB_USER: 'u',
      CAIRN_DB_NAME: 'db',
    })
    expect(snap.user).toBe('u')
    expect(snap.database).toBe('db')
  })

  it('production-like getControlPlaneRuntimeContext fails closed without DB config', () => {
    const env = {
      NODE_ENV: 'production',
      CAIRN_DB_HOST: 'db.prod.example',
      // deliberately no CAIRN_DB_USER / CAIRN_DB_NAME
    } as NodeJS.ProcessEnv

    expect(() => getControlPlaneRuntimeContext(env)).toThrow(ControlPlaneRuntimeContextError)
    try {
      getControlPlaneRuntimeContext(env)
    } catch (e) {
      expect(e).toBeInstanceOf(ControlPlaneRuntimeContextError)
      expect((e as ControlPlaneRuntimeContextError).code).toBe('DB_UNAVAILABLE')
      expect((e as ControlPlaneRuntimeContextError).message).toMatch(/refusing silent memory fallback/)
    }
    expect(peekControlPlaneRuntimeContext()).toBeNull()
  })

  it('boot refuses serve when retention env UNRESOLVED (no invent LOCAL)', () => {
    const env = {
      // bare development / empty app env → retention UNRESOLVED
      NODE_ENV: 'development',
      CAIRN_SERVER: '1',
      CAIRN_DB_HOST: '127.0.0.1',
      CAIRN_DB_USER: 'u',
      CAIRN_DB_NAME: 'db',
    } as NodeJS.ProcessEnv
    expect(() => getControlPlaneRuntimeContext(env)).toThrow(ControlPlaneRuntimeContextError)
    try {
      getControlPlaneRuntimeContext(env)
    } catch (e) {
      expect(e).toBeInstanceOf(ControlPlaneRuntimeContextError)
      expect((e as ControlPlaneRuntimeContextError).code).toBe('NOT_CONFIGURED')
      expect((e as ControlPlaneRuntimeContextError).message).toMatch(/UNRESOLVED|retention environment/i)
      expect((e as ControlPlaneRuntimeContextError).message).toMatch(/refused|boot/i)
    }
    expect(peekControlPlaneRuntimeContext()).toBeNull()
  })

  it('buildMysqlControlPlaneRuntimeContext asserts retention env before build', () => {
    expect(() =>
      buildMysqlControlPlaneRuntimeContext({
        env: {
          NODE_ENV: 'development',
          // no CAIRN_ENV / APP_ENV / VITEST
        } as NodeJS.ProcessEnv,
        controlDataClient: createMemoryControlDataSql(),
        sqlExecutor: createMemoryAtomicSqlExecutor(),
        requireDbConfig: false,
      }),
    ).toThrow(/UNRESOLVED|retention environment/i)
  })

  it('R4: production-like + NODE_ENV=test/VITEST refuses boot (no silent TEST proposal)', () => {
    const env = {
      NODE_ENV: 'test',
      VITEST: 'true',
      CAIRN_SERVER: '1',
      CAIRN_DB_HOST: '127.0.0.1',
      CAIRN_DB_USER: 'u',
      CAIRN_DB_NAME: 'db',
    } as NodeJS.ProcessEnv
    expect(() => getControlPlaneRuntimeContext(env)).toThrow(
      ControlPlaneRuntimeContextError,
    )
    try {
      getControlPlaneRuntimeContext(env)
    } catch (e) {
      expect(e).toBeInstanceOf(ControlPlaneRuntimeContextError)
      expect((e as ControlPlaneRuntimeContextError).code).toBe('NOT_CONFIGURED')
      expect((e as ControlPlaneRuntimeContextError).message).toMatch(
        /UNRESOLVED|R4|retention environment/i,
      )
    }
    expect(() =>
      buildMysqlControlPlaneRuntimeContext({
        env,
        controlDataClient: createMemoryControlDataSql(),
        sqlExecutor: createMemoryAtomicSqlExecutor(),
        requireDbConfig: false,
      }),
    ).toThrow(/UNRESOLVED|R4|retention environment/i)
  })

  it('R4: isApprovedTestRetentionContext only for memory/test override, never production-like', () => {
    expect(isApprovedTestRetentionContext(null)).toBe(false)
    const mem = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(mem)
    expect(
      isApprovedTestRetentionContext(mem, {
        NODE_ENV: 'test',
      } as NodeJS.ProcessEnv),
    ).toBe(true)
    expect(
      isApprovedTestRetentionContext(mem, {
        NODE_ENV: 'test',
        CAIRN_SERVER: '1',
      } as NodeJS.ProcessEnv),
    ).toBe(false)
    expect(
      isApprovedTestRetentionContext(
        { mode: 'mysql' },
        { NODE_ENV: 'test' } as NodeJS.ProcessEnv,
      ),
    ).toBe(false)
  })

  it('without test override and without instance, peek is null', () => {
    expect(hasTestControlPlaneRuntimeContext()).toBe(false)
    expect(peekControlPlaneRuntimeContext()).toBeNull()
  })

  it('test setter installs memory context; get returns same singleton reference', () => {
    const clock = createFakeClock(1_000)
    const mem = createMemoryControlPlaneRuntimeContext({ clock })
    setTestControlPlaneRuntimeContext(mem)

    expect(hasTestControlPlaneRuntimeContext()).toBe(true)
    const a = getControlPlaneRuntimeContext()
    const b = getControlPlaneRuntimeContext()
    expect(a).toBe(mem)
    expect(b).toBe(a)
    expect(a.mode).toBe('memory')
    expect(a.clock).toBe(clock)
    // Shared authority identity
    expect(a.revisions).toBe(a.controlData.revisions)
    expect(a.idempotency).toBe(a.controlData.idempotency)
    expect(a.runtime.mode).toBe('memory')
    // HumanDisplayStore attached to durable runtime context
    expect(a.humanDisplay).toBeDefined()
    expect(typeof a.humanDisplay.get).toBe('function')
    expect(typeof a.humanDisplay.list).toBe('function')
    expect(typeof a.humanDisplay.put).toBe('function')
  })

  it('reset clears override so next get does not return old memory context', () => {
    const mem = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(mem)
    expect(getControlPlaneRuntimeContext()).toBe(mem)

    resetControlPlaneRuntimeContextForTests()
    expect(hasTestControlPlaneRuntimeContext()).toBe(false)
    expect(peekControlPlaneRuntimeContext()).toBeNull()

    const mem2 = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(mem2)
    expect(getControlPlaneRuntimeContext()).toBe(mem2)
    expect(getControlPlaneRuntimeContext()).not.toBe(mem)
  })

  it('global symbol holder is process-singleton across reset of instance field', () => {
    const g = globalThis as Record<symbol, unknown>
    const holder1 = g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]
    resetControlPlaneRuntimeContextForTests()
    const holder2 = g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]
    expect(holder1).toBe(holder2)
    expect(holder1).toBeTruthy()
  })

  it('memory context atomic bump is visible to same context (shared store)', async () => {
    const ctx = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(ctx)
    const got = getControlPlaneRuntimeContext()
    const r1 = await got.atomic.bumpBoardRev('board-ctx')
    const r2 = await got.atomic.bumpBoardRev('board-ctx')
    expect(r1).toBe(1)
    expect(r2).toBe(2)
    const st = await getControlPlaneRuntimeContext().atomic.getBoardState('board-ctx')
    expect(st.boardRev).toBe(2)
  })

  it('memory-SQL backed context: atomic restart across store rebuild on same executor', async () => {
    const ctx = createMemorySqlBackedControlPlaneRuntimeContext()
    const rev = await ctx.atomic.bumpBoardRev('board-sql')
    expect(rev).toBe(1)
    await ctx.atomic.setBoardState({
      boardId: 'board-sql',
      boardRev: 1,
      dispatchBlocked: true,
      dispatchBlockedReason: 'test-block',
    })
    await ctx.atomic.appendAudit({
      eventId: 'ev-sql-1',
      boardId: 'board-sql',
      kind: 'ACCOUNT_SYNC',
      atMs: 100,
      atISO: new Date(100).toISOString(),
      actorId: 't',
      subjectType: 'account_sync',
      subjectId: '1',
      detail: { ok: true },
      material: true,
    })

    // Rebuild atomic store over same durable tables (simulates process restart of adapter)
    const atomic2 = createMysqlControlPlaneAtomicStore(ctx.atomicExec, { useNamedLock: false })
    const st = await atomic2.getBoardState('board-sql')
    expect(st.boardRev).toBe(1)
    expect(st.dispatchBlocked).toBe(true)
    const audits = await atomic2.listAudit('board-sql')
    expect(audits).toHaveLength(1)
    expect(audits[0]!.eventId).toBe('ev-sql-1')
  })

  it('buildMysqlControlPlaneRuntimeContext rejects executor without getConnection', () => {
    const atomicExec = createMemoryAtomicSqlExecutor()
    const bare = { execute: atomicExec.execute.bind(atomicExec) }
    expect(() =>
      buildMysqlControlPlaneRuntimeContext({
        sqlExecutor: bare as never,
        controlDataClient: createMemoryControlDataSql(),
        requireDbConfig: false,
      }),
    ).toThrow(/getConnection/)
  })

  it('buildMysql with full injects produces mysql mode + shared authorities', async () => {
    const controlDataClient = createMemoryControlDataSql()
    const sqlExecutor = createMemoryAtomicSqlExecutor()
    const ctx = buildMysqlControlPlaneRuntimeContext({
      controlDataClient,
      sqlExecutor,
      requireDbConfig: false,
      clock: createFakeClock(5_000),
    })
    expect(ctx.mode).toBe('mysql')
    expect(ctx.runtime.mode).toBe('mysql')
    expect(ctx.revisions).toBe(ctx.controlData.revisions)
    expect(ctx.idempotency).toBe(ctx.controlData.idempotency)
    expect(ctx.humanDisplay).toBeDefined()
    expect(typeof ctx.humanDisplay.get).toBe('function')
    const rev = await ctx.atomic.bumpBoardRev('board-mysql-path')
    expect(rev).toBe(1)
  })

  it('memory humanDisplay store: missing get → CONTENT_REVIEW_REQUIRED blockedShell', async () => {
    const ctx = createMemoryControlPlaneRuntimeContext()
    const got = await ctx.humanDisplay.get('board-hd', 'task', 'T-missing')
    expect(got.primary).toBeNull()
    expect(got.contentReviewRequired).toBe(true)
    expect(got.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(got.blockedShell.reviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(got.blockedShell.title).toMatch(/peninjauan/i)
    // Never promotes technical id as owner primary title
    expect(got.blockedShell.title).not.toBe('T-missing')
  })

  it('memory-SQL backed context exposes MySQL-adapter humanDisplay store', async () => {
    const ctx = createMemorySqlBackedControlPlaneRuntimeContext()
    expect(ctx.humanDisplay).toBeDefined()
    const missing = await ctx.humanDisplay.get('b-sql-hd', 'task', 'T-x')
    expect(missing.contentReviewRequired).toBe(true)
    expect(missing.primary).toBeNull()
    expect(missing.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
  })

  it('setTestControlPlaneRuntimeContext(null) clears override', () => {
    setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
    expect(hasTestControlPlaneRuntimeContext()).toBe(true)
    setTestControlPlaneRuntimeContext(null)
    expect(hasTestControlPlaneRuntimeContext()).toBe(false)
    expect(peekControlPlaneRuntimeContext()).toBeNull()
  })

  // ---------------------------------------------------------------------------
  // AccountSyncScheduler runtime attachment
  // ---------------------------------------------------------------------------

  it('memory context attaches one AccountSyncScheduler wired to authority stores', () => {
    const clock = createFakeClock(10_000)
    const ctx = createMemoryControlPlaneRuntimeContext({ clock })
    expect(ctx.accountSyncScheduler).toBeDefined()
    expect(typeof ctx.accountSyncScheduler.enqueue).toBe('function')
    expect(typeof ctx.accountSyncScheduler.tick).toBe('function')
    expect(typeof ctx.accountSyncScheduler.flush).toBe('function')
    expect(typeof ctx.accountSyncScheduler.getBoardState).toBe('function')
    // Unit memory default: no auto loop (tests drive tick with fake clock)
    expect(ctx.accountSyncSchedulerLoop).toBeNull()
  })

  it('memory context can start unref scheduler loop and reset stops it', () => {
    const clock = createFakeClock(10_000)
    const ctx = createMemoryControlPlaneRuntimeContext({
      clock,
      autoStartSchedulerLoop: true,
      schedulerLoopIntervalMs: 60_000,
    })
    expect(ctx.accountSyncSchedulerLoop?.isRunning()).toBe(true)
    setTestControlPlaneRuntimeContext(ctx)
    resetControlPlaneRuntimeContextForTests()
    expect(ctx.accountSyncSchedulerLoop?.isRunning()).toBe(false)
  })

  it('runtime injects MetricsRegistry into FATAL path (api_error_rate increments)', async () => {
    drainAccountSyncLoopFatalSinkForTests()
    const metrics = createMemoryMetricsRegistry(() => 99_000)
    const clock = createFakeClock(99_000)
    // Build memory context without auto-loop; exercise production fatal factory path
    // the same way maybeStartLoop wires metrics.
    const mem = createMemoryControlPlaneRuntimeContext({
      clock,
      metrics,
      seedBoards: [
        {
          boardId: 'board-fatal-metric',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
    })
    setTestControlPlaneRuntimeContext(mem)

    const { createAccountSyncSchedulerLoopOnFatalError } = await import(
      '#/server/account-sync-scheduler'
    )
    // Use the same injection pattern as maybeStartLoop (runtime owns metrics).
    const onFatal = createAccountSyncSchedulerLoopOnFatalError({
      scheduler: mem.accountSyncScheduler,
      appendAudit: (entry) => mem.controlData.imports.appendAudit(entry),
      nowMs: () => clock.nowMs(),
      metrics,
      logLine: () => {},
    })
    await onFatal({
      kind: 'ACCOUNT_SYNC_LOOP_FATAL',
      error: new Error('runtime-wired fatal'),
      boardIds: ['board-fatal-metric'],
      atMs: clock.nowMs(),
      reason: 'ACCOUNT_SYNC_LOOP_FATAL',
      phase: 'SECONDARY_ON_FATAL',
    })
    // Drain microtask for fire-and-forget appendAudit completion.
    await Promise.resolve()
    await Promise.resolve()
    expect(metrics.sum('api_error_rate')).toBeGreaterThanOrEqual(1)
    const sample = metrics.snapshot().find((s) => s.category === 'api_error_rate')
    expect(sample?.labels?.endpoint).toBe('account-sync-scheduler')
    expect(sample?.labels?.event).toBe('ACCOUNT_SYNC_LOOP_FATAL')
    expect(sample?.labels?.phase).toBe('SECONDARY_ON_FATAL')
    const sink = drainAccountSyncLoopFatalSinkForTests()
    expect(sink.some((s) => s.event.kind === 'ACCOUNT_SYNC_LOOP_FATAL')).toBe(true)
  })

  it('auto-started loop onError fail-closes watched boards + fires alert (fake clock)', async () => {
    const clock = createFakeClock(50_000)
    const alerts: Array<{ kind: string; reason: string }> = []
    const mem = createMemoryControlPlaneRuntimeContext({
      clock,
      seedBoards: [
        {
          boardId: 'board-loop-err',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
      onAccountSyncLoopAlert: (ev) => {
        alerts.push({ kind: ev.kind, reason: ev.reason })
      },
    })
    setTestControlPlaneRuntimeContext(mem)

    await mem.accountSyncScheduler.enqueue({
      boardId: 'board-loop-err',
      sourceRevision: 1,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-loop-err',
      accounts: [
        {
          maskedAccountId: 'acct-loop',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'loop-err-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })

    // Production onError path (same factory used by maybeStartLoop).
    const { createAccountSyncSchedulerLoopOnError } = await import(
      '#/server/account-sync-scheduler'
    )
    const onError = createAccountSyncSchedulerLoopOnError({
      scheduler: mem.accountSyncScheduler,
      nowMs: () => clock.nowMs(),
      onAlert: (ev) => {
        alerts.push({ kind: ev.kind, reason: ev.reason })
      },
    })
    await onError(new Error('injected tick rejection'))

    const snap = await mem.runtime.accounts.get('board-loop-err')
    expect(snap?.stale).toBe(true)
    expect(snap?.usableCapacity).toBe(0)
    expect(snap?.staleReason).toBe('ACCOUNT_SYNC_LOOP_TICK_REJECTED')
    const board = await mem.atomic.getBoardState('board-loop-err')
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_STALE/)
    expect(alerts.some((a) => a.kind === 'ACCOUNT_SYNC_LOOP_TICK_REJECTED')).toBe(true)
  })

  it('getAccountSyncScheduler returns the same shared instance as context (survives re-get)', async () => {
    const clock = createFakeClock(20_000)
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const mem = createMemoryControlPlaneRuntimeContext({
      clock,
      surfacePublisher: surfaces,
      seedBoards: [
        {
          boardId: 'board-shared',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
    })
    setTestControlPlaneRuntimeContext(mem)

    const a = getAccountSyncScheduler()
    const b = getAccountSyncScheduler()
    expect(a).toBe(b)
    expect(a).toBe(mem.accountSyncScheduler)
    expect(getControlPlaneRuntimeContext().accountSyncScheduler).toBe(a)
    expect(peekAccountSyncScheduler()).toBe(a)

    // Coalesce a heartbeat — state must survive a second get() (request boundary).
    const c1 = await a.enqueue({
      boardId: 'board-shared',
      sourceRevision: 1,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-mask-shared',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'hb-shared-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    expect(c1.kind).toBe('COALESCED')
    expect(c1.deadlineMs).toBe(clock.nowMs() + ACCOUNT_PUBLISH_SLA_MS)

    const again = getAccountSyncScheduler()
    expect(again).toBe(a)
    const st = again.getBoardState('board-shared')
    expect(st.pendingHeartbeat).not.toBeNull()
    expect(st.pendingHeartbeatDeadlineMs).toBe(c1.deadlineMs)
    expect(st.pendingHeartbeat?.sourceRevision).toBe(1)
  })

  it('board isolation: pending heartbeat on A does not appear on B', async () => {
    const clock = createFakeClock(30_000)
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const ctx = createMemoryControlPlaneRuntimeContext({
      clock,
      surfacePublisher: surfaces,
      seedBoards: [
        {
          boardId: 'board-a',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
        {
          boardId: 'board-b',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
    })
    setTestControlPlaneRuntimeContext(ctx)
    const sched = getAccountSyncScheduler()

    await sched.enqueue({
      boardId: 'board-a',
      sourceRevision: 10,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-a',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'hb-a',
      callerRole: 'ROOT_ORCHESTRATOR',
    })

    expect(sched.getBoardState('board-a').pendingHeartbeat).not.toBeNull()
    expect(sched.getBoardState('board-b').pendingHeartbeat).toBeNull()
    expect(sched.getBoardState('board-b').publishCount).toBe(0)

    // Immediate publish on B must not clear A's pending heartbeat.
    const pubB = await sched.enqueue({
      boardId: 'board-b',
      sourceRevision: 20,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-b',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
        },
      ],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'launch-b',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    expect(pubB.kind).toBe('PUBLISHED')
    expect(sched.getBoardState('board-a').pendingHeartbeat).not.toBeNull()
    expect(sched.getBoardState('board-b').pendingHeartbeat).toBeNull()
    expect(sched.getBoardState('board-b').publishCount).toBe(1)

    // Authority store is real runtime.accounts — B is durable there.
    const snapB = await ctx.runtime.accounts.get('board-b')
    expect(snapB?.sourceRevision).toBe(20)
    const snapA = await ctx.runtime.accounts.get('board-a')
    expect(snapA).toBeNull() // heartbeat still coalesced, not published
  })

  it('freshness fail-closed: mismatched surface after SLA → usableCapacity=0 + stale', async () => {
    const clock = createFakeClock(40_000)
    const surfaces = createMemoryAccountSyncSurfacePublisher({
      mismatch: {
        ui: { sourceRevision: 999, generatedAt: '1999-01-01T00:00:00.000Z' },
      },
    })
    const ctx = createMemoryControlPlaneRuntimeContext({
      clock,
      surfacePublisher: surfaces,
      seedBoards: [
        {
          boardId: 'board-fresh',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
    })
    setTestControlPlaneRuntimeContext(ctx)
    const sched = getAccountSyncScheduler()
    const gen = clock.nowISO()

    const out = await sched.enqueue({
      boardId: 'board-fresh',
      sourceRevision: 55,
      generatedAt: gen,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-fresh',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
        },
      ],
      trigger: 'WAVE_LAUNCH',
      idempotencyKey: 'wave-fresh',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    expect(out.parityOk).toBe(false)
    // Envelope must never carry secret-like keys.
    for (const entry of surfaces.log) {
      expect(JSON.stringify(entry.envelope)).not.toMatch(
        /("password"|"token"|"secret"|"authorization")\s*:/i,
      )
    }

    clock.advance(ACCOUNT_PUBLISH_SLA_MS + 1)
    const tick = await sched.tick()
    const snap =
      tick.freshness.find((s) => s?.boardId === 'board-fresh') ??
      (await ctx.runtime.accounts.get('board-fresh'))
    expect(snap?.stale).toBe(true)
    expect(snap?.usableCapacity).toBe(0)
    expect(snap?.staleReason).toMatch(/SLA_MISS/)
    const board = await ctx.atomic.getBoardState('board-fresh')
    expect(board.dispatchBlocked).toBe(true)
    expect(board.dispatchBlockedReason).toMatch(/ACCOUNT_SYNC_STALE/)
  })

  it('preserves <=30s heartbeat deadline + <=60s periodic via attached scheduler', async () => {
    const clock = createFakeClock(50_000)
    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const ctx = createMemoryControlPlaneRuntimeContext({
      clock,
      surfacePublisher: surfaces,
      seedBoards: [
        {
          boardId: 'board-sla',
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ],
    })
    setTestControlPlaneRuntimeContext(ctx)
    const sched = getAccountSyncScheduler()

    const c1 = await sched.enqueue({
      boardId: 'board-sla',
      sourceRevision: 1,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-sla',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'hb-sla-1',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    expect(c1.deadlineMs).toBe(clock.nowMs() + ACCOUNT_PUBLISH_SLA_MS)
    expect(ACCOUNT_PUBLISH_SLA_MS).toBe(30_000)
    expect(ACCOUNT_PERIODIC_HEALTH_MS).toBe(60_000)

    clock.advance(5_000)
    const c2 = await getAccountSyncScheduler().enqueue({
      boardId: 'board-sla',
      sourceRevision: 2,
      generatedAt: clock.nowISO(),
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'canon-runtime-pin',
      accounts: [
        {
          maskedAccountId: 'acct-sla',
          status: 'OK',
          providerKind: 'GROK',
          effectiveInUse: 2,
          effectiveCap: 5,
        },
      ],
      trigger: 'HEARTBEAT',
      idempotencyKey: 'hb-sla-2',
      callerRole: 'ROOT_ORCHESTRATOR',
    })
    // Deadline fixed from first pending (30s SLA), not reset by coalesce.
    expect(c2.deadlineMs).toBe(c1.deadlineMs)

    clock.advance(ACCOUNT_PUBLISH_SLA_MS)
    const tickHb = await getAccountSyncScheduler().tick()
    expect(tickHb.published.length).toBe(1)
    expect(tickHb.published[0]?.result?.sourceRevision).toBe(2)

    // Arm periodic from last publish; fire at 60s.
    clock.advance(ACCOUNT_PERIODIC_HEALTH_MS - 1)
    let tickP = await getAccountSyncScheduler().tick()
    expect(tickP.published.filter((p) => p.trigger === 'PERIODIC_HEALTH').length).toBe(0)
    clock.advance(2)
    tickP = await getAccountSyncScheduler().tick()
    expect(tickP.published.filter((p) => p.trigger === 'PERIODIC_HEALTH').length).toBe(1)
  })

  it('buildMysql path also attaches scheduler using runtime.accounts', () => {
    const controlDataClient = createMemoryControlDataSql()
    const sqlExecutor = createMemoryAtomicSqlExecutor()
    const clock = createFakeClock(60_000)
    const ctx = buildMysqlControlPlaneRuntimeContext({
      controlDataClient,
      sqlExecutor,
      requireDbConfig: false,
      clock,
    })
    expect(ctx.accountSyncScheduler).toBeDefined()
    expect(getAccountSyncScheduler).toBeTypeOf('function')
    // Without test override, getter would go to production path — only assert field.
    expect(typeof ctx.accountSyncScheduler.listBoards).toBe('function')
  })

  it('peekAccountSyncScheduler is null when no context installed', () => {
    expect(peekAccountSyncScheduler()).toBeNull()
  })
})
