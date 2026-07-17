/**
 * Real disposable MySQL regression: account-sync entityRev churn bounds,
 * fail-closed no-op on already-stale, recovery usableCapacity=5, idempotency-before-CAS.
 * Skips when local MySQL unreachable (CAIRN_MIGRATE_IT=0 or probe fail).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

import {
  evaluateAccountSyncFreshness,
  recordAccountReadbacks,
  syncAccounts,
  AccountSyncError,
} from '#/server/account-sync'
import type {
  AccountSyncDeps,
  MaskedAccountRecord,
} from '#/server/account-sync'
import { createMemoryControlPlaneAtomicStore } from '#/server/board-store'
import {
  RUNTIME_PERSISTENCE_MIGRATION_FILE,
  createMysqlAccountSyncStore,
  createMysqlPoolExecutor,
} from '#/server/control-plane-runtime-persistence'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { splitSqlStatements } from '#/server/migrations'

const stamp = Date.now().toString(36)
const itCtx = {
  host: process.env.CAIRN_DB_HOST || '127.0.0.1',
  port: Number(process.env.CAIRN_DB_PORT || 3306),
  user: process.env.CAIRN_DB_USER || 'root',
  password: process.env.CAIRN_DB_PASSWORD || '',
  database: `acct_sync_churn_${stamp}`,
  available: false,
}

const receiptDir = path.join(
  process.cwd(),
  '.artifact/fix-final-account-sync-r2',
)
const receiptPath = path.join(receiptDir, 'mysql-churn-receipt.json')

const receipt: {
  db: string
  steps: Array<Record<string, unknown>>
  allOk?: boolean
  store: string
} = {
  db: itCtx.database,
  steps: [],
  store: 'createMysqlAccountSyncStore+memoryAtomic',
}

function step(name: string, data: Record<string, unknown>) {
  receipt.steps.push({ name, ...data })
}

async function openAdmin() {
  return mysql.createConnection({
    host: itCtx.host,
    port: itCtx.port,
    user: itCtx.user,
    password: itCtx.password,
    multipleStatements: true,
    connectTimeout: 3000,
  })
}

async function probe(): Promise<boolean> {
  if (process.env.CAIRN_MIGRATE_IT === '0') return false
  try {
    const c = await openAdmin()
    await c.query('SELECT 1')
    await c.end()
    return true
  } catch {
    return false
  }
}

describe('real-MySQL account-sync churn bounds + recovery', () => {
  let pool: mysql.Pool | undefined
  let deps: AccountSyncDeps
  let t = 2_000_000
  let admin: mysql.Connection | undefined

  beforeAll(async () => {
    itCtx.available = await probe()
    if (!itCtx.available) return
    fs.mkdirSync(receiptDir, { recursive: true })
    admin = await openAdmin()
    await admin.query(
      `CREATE DATABASE \`${itCtx.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
    const migAbs = path.isAbsolute(RUNTIME_PERSISTENCE_MIGRATION_FILE)
      ? RUNTIME_PERSISTENCE_MIGRATION_FILE
      : path.join(process.cwd(), RUNTIME_PERSISTENCE_MIGRATION_FILE)
    const sql = fs.readFileSync(migAbs, 'utf8')
    await admin.changeUser({ database: itCtx.database })
    for (const stmt of splitSqlStatements(sql)) {
      await admin.query(stmt)
    }
    pool = mysql.createPool({
      host: itCtx.host,
      port: itCtx.port,
      user: itCtx.user,
      password: itCtx.password,
      database: itCtx.database,
      connectionLimit: 4,
      multipleStatements: true,
    })
    const exec = createMysqlPoolExecutor(pool)
    const accounts = createMysqlAccountSyncStore(exec, { useNamedLock: true })
    const atomic = createMemoryControlPlaneAtomicStore([
      {
        boardId: 'board-churn',
        boardRev: 10,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      },
    ])
    const clock = {
      nowMs: () => t,
      nowISO: () => new Date(t).toISOString(),
    }
    deps = {
      clock,
      accounts,
      atomic,
      idempotency: createMemoryIdempotencyStorage(),
    }
  }, 60_000)

  afterAll(async () => {
    try {
      if (pool) await pool.end()
    } catch {
      /* ignore */
    }
    try {
      if (admin) {
        await admin.query(`DROP DATABASE IF EXISTS \`${itCtx.database}\``)
        await admin.end()
      }
    } catch {
      /* ignore */
    }
    try {
      fs.mkdirSync(receiptDir, { recursive: true })
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    } catch {
      /* ignore */
    }
  })

  it('bounded revisions + fail-closed no thrash + STALE retry + recover capacity5', async ({
    skip,
  }) => {
    if (!itCtx.available) {
      step('skip', { reason: 'local MySQL unavailable' })
      skip()
      return
    }

    const grok: Omit<MaskedAccountRecord, 'tombstone'> = {
      maskedAccountId: 'acc_churn_001',
      status: 'ACTIVE',
      providerKind: 'GROK',
      effectiveInUse: 0,
      effectiveCap: 5,
      physicalSlotsDisplay: '0/5',
      adaptiveQuotaState: 'healthy',
      reason: null,
      statusChangedAt: new Date(t).toISOString(),
    }
    const gen1 = new Date(t).toISOString()

    const r1 = await syncAccounts(deps, {
      boardId: 'board-churn',
      sourceRevision: 1,
      generatedAt: gen1,
      entityExpectedRev: 0,
      expectedBoardRev: 10,
      canonicalHash: 'pinhash-churn-1',
      accounts: [grok],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'idem-create-churn',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'churn-it',
    })
    const snap1 = await deps.accounts.get('board-churn')
    step('sync_create_usable5', {
      ok:
        r1.usableCapacity === 5 && r1.stale === false && snap1?.entityRev === 1,
      usableCapacity: r1.usableCapacity,
      dispatchMode: r1.capacity.dispatchMode,
      entityRev: snap1?.entityRev,
    })
    expect(r1.usableCapacity).toBe(5)
    expect(r1.capacity.dispatchMode).toBe('GROK_ONLY')
    expect(snap1?.entityRev).toBe(1)

    // Coalesced four-surface readback → +1 entityRev only
    const rb = await recordAccountReadbacks(deps, {
      boardId: 'board-churn',
      surfaces: {
        mcp: { sourceRevision: 1, generatedAt: gen1 },
        api: { sourceRevision: 1, generatedAt: gen1 },
        ui: { sourceRevision: 1, generatedAt: gen1 },
        ops: { sourceRevision: 1, generatedAt: gen1 },
      },
    })
    step('coalesced_readback_plus1', {
      ok: rb.entityRev === 2 && rb.stale === false && rb.usableCapacity === 5,
      entityRev: rb.entityRev,
      paritySurfaces: rb.readbackSurfaces,
    })
    expect(rb.entityRev).toBe(2)
    expect(rb.usableCapacity).toBe(5)
    expect(rb.readbackSurfaces.mcp).toEqual({
      sourceRevision: 1,
      generatedAt: gen1,
    })
    expect(rb.readbackSurfaces.ops).toEqual({
      sourceRevision: 1,
      generatedAt: gen1,
    })

    // Exact same coalesced readback → no bump
    const rb2 = await recordAccountReadbacks(deps, {
      boardId: 'board-churn',
      surfaces: {
        mcp: { sourceRevision: 1, generatedAt: gen1 },
        api: { sourceRevision: 1, generatedAt: gen1 },
        ui: { sourceRevision: 1, generatedAt: gen1 },
        ops: { sourceRevision: 1, generatedAt: gen1 },
      },
    })
    step('readback_idempotent_noop', {
      ok: rb2.entityRev === 2,
      entityRev: rb2.entityRev,
    })
    expect(rb2.entityRev).toBe(2)

    // Idempotency replay before CAS after boardRev advances
    await deps.atomic.bumpBoardRev('board-churn')
    const replay = await syncAccounts(deps, {
      boardId: 'board-churn',
      sourceRevision: 1,
      generatedAt: gen1,
      entityExpectedRev: 0,
      expectedBoardRev: 10,
      canonicalHash: 'pinhash-churn-1',
      accounts: [grok],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'idem-create-churn',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'churn-it',
    })
    step('idempotency_before_cas_replay', {
      ok: replay.replayed === true && replay.usableCapacity === 5,
      replayed: replay.replayed,
      usableCapacity: replay.usableCapacity,
    })
    expect(replay.replayed).toBe(true)

    // Clear parity + advance past SLA → first material fail-close bumps once
    await deps.accounts.put({
      ...(await deps.accounts.get('board-churn'))!,
      readbackSurfaces: { mcp: null, api: null, ui: null, ops: null },
      publishedAtMs: t,
    })
    t += 31_000
    const stale1 = await evaluateAccountSyncFreshness(deps, 'board-churn')
    const revAfterFirstStale = stale1!.entityRev
    step('first_fail_close_material', {
      ok:
        stale1?.stale === true &&
        stale1.usableCapacity === 0 &&
        typeof revAfterFirstStale === 'number',
      entityRev: revAfterFirstStale,
      staleReason: stale1?.staleReason,
    })
    expect(stale1?.stale).toBe(true)
    expect(stale1?.usableCapacity).toBe(0)

    // Compound periodic reason while already fail-closed → no entityRev bump
    await deps.accounts.put({
      ...stale1!,
      lastPeriodicHealthAtMs: t - 70_000,
    })
    const stale2 = await evaluateAccountSyncFreshness(deps, 'board-churn')
    step('already_stale_no_entity_bump', {
      ok:
        stale2?.entityRev === revAfterFirstStale && stale2.usableCapacity === 0,
      entityRevBefore: revAfterFirstStale,
      entityRevAfter: stale2?.entityRev,
      staleReason: stale2?.staleReason,
    })
    expect(stale2?.entityRev).toBe(revAfterFirstStale)
    expect(stale2?.usableCapacity).toBe(0)

    // STALE_REVISION surfaces currentEntityRev for deterministic retry
    let err: AccountSyncError | null = null
    try {
      await syncAccounts(deps, {
        boardId: 'board-churn',
        sourceRevision: 2,
        generatedAt: new Date(t).toISOString(),
        entityExpectedRev: 1,
        expectedBoardRev: (await deps.atomic.getBoardState('board-churn'))
          .boardRev,
        canonicalHash: 'pinhash-churn-1',
        accounts: [grok],
        trigger: 'PERIODIC_HEALTH',
        idempotencyKey: 'idem-stale-retry-wrong',
        callerRole: 'ROOT_ORCHESTRATOR',
        actorId: 'churn-it',
      })
    } catch (e) {
      if (e instanceof AccountSyncError) err = e
      else throw e
    }
    step('stale_revision_current_entity', {
      ok:
        err?.code === 'STALE_REVISION' &&
        Number(err.details.currentEntityRev) === revAfterFirstStale,
      code: err?.code,
      details: err?.details,
    })
    expect(err?.code).toBe('STALE_REVISION')
    expect(Number(err?.details.currentEntityRev)).toBe(revAfterFirstStale)

    // Recover with live entityExpectedRev → usableCapacity 5
    const live = await deps.accounts.get('board-churn')
    const boardLive = await deps.atomic.getBoardState('board-churn')
    const recover = await syncAccounts(deps, {
      boardId: 'board-churn',
      sourceRevision: 3,
      generatedAt: new Date(t).toISOString(),
      entityExpectedRev: live!.entityRev,
      expectedBoardRev: boardLive.boardRev,
      canonicalHash: 'pinhash-churn-1',
      accounts: [grok],
      trigger: 'PERIODIC_HEALTH',
      idempotencyKey: 'idem-recover-churn',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'churn-it',
    })
    step('recover_usableCapacity5', {
      ok:
        recover.usableCapacity === 5 &&
        recover.stale === false &&
        recover.capacity.dispatchMode === 'GROK_ONLY',
      usableCapacity: recover.usableCapacity,
      dispatchMode: recover.capacity.dispatchMode,
      entityRev: (await deps.accounts.get('board-churn'))?.entityRev,
    })
    expect(recover.usableCapacity).toBe(5)
    expect(recover.stale).toBe(false)
    expect(recover.capacity.dispatchMode).toBe('GROK_ONLY')

    receipt.allOk = receipt.steps.every((s) => s.ok !== false)
    fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
  })
})
