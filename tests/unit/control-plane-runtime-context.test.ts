/**
 * Control-plane runtime context — lazy global-symbol singleton, fail-closed
 * production DB gate, test-only memory setter/resetter. No real MySQL.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import { createFakeClock } from '#/server/board-store'
import { createMemoryControlDataSql } from '#/server/control-data-persistence'
import {
  CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL,
  ControlPlaneRuntimeContextError,
  buildMysqlControlPlaneRuntimeContext,
  checkDbConfigForContext,
  createMemoryControlPlaneRuntimeContext,
  createMemorySqlBackedControlPlaneRuntimeContext,
  getControlPlaneRuntimeContext,
  hasTestControlPlaneRuntimeContext,
  isProductionOrServerEnv,
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
    const rev = await ctx.atomic.bumpBoardRev('board-mysql-path')
    expect(rev).toBe(1)
  })

  it('setTestControlPlaneRuntimeContext(null) clears override', () => {
    setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
    expect(hasTestControlPlaneRuntimeContext()).toBe(true)
    setTestControlPlaneRuntimeContext(null)
    expect(hasTestControlPlaneRuntimeContext()).toBe(false)
    expect(peekControlPlaneRuntimeContext()).toBeNull()
  })
})
