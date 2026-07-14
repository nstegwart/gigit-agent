/**
 * Real disposable MySQL stress: concurrent authority syncAccounts vs
 * failClosedStale (lock-serialized forceStaleUsableZero).
 * Proves newer authority snapshot cannot be lost to unlocked get→put race.
 * Skips when local MySQL unreachable (CAIRN_MIGRATE_IT=0 or probe fail).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

import {
  AccountSyncError,
  syncAccounts,
  type AccountSyncDeps,
  type MaskedAccountRecord,
} from '#/server/account-sync'
import {
  createAccountSyncScheduler,
  createMemoryAccountSyncSurfacePublisher,
} from '#/server/account-sync-scheduler'
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
  database: `acct_sync_race_${stamp}`,
  available: false,
}

const receiptDir = path.join(process.cwd(), '.artifact/repair-final-account-sync-residuals')
const receiptPath = path.join(receiptDir, 'mysql-concurrent-receipt.json')

const receipt: {
  db: string
  steps: Array<Record<string, unknown>>
  allOk?: boolean
  store: string
} = {
  db: itCtx.database,
  steps: [],
  store: 'createMysqlAccountSyncStore(useNamedLock)+memoryAtomic+scheduler',
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

const BOARD = 'board-race'
const AUTH_SOURCE = 9999
const AUTH_MASK = 'acct-authority-mysql-winner'
const PIN = 'pinhash-race-concurrent-1'

describe('real-MySQL concurrent authority vs fail-close (no newer snapshot loss)', () => {
  let pool: mysql.Pool | undefined
  let deps: AccountSyncDeps
  let t = 3_000_000
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
      connectionLimit: 16,
      multipleStatements: true,
    })
    const exec = createMysqlPoolExecutor(pool)
    const accounts = createMysqlAccountSyncStore(exec, { useNamedLock: true })
    const atomic = createMemoryControlPlaneAtomicStore([
      {
        boardId: BOARD,
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
      receipt.allOk = receipt.steps.length > 0 && receipt.steps.every((s) => s.ok !== false)
      fs.writeFileSync(receiptPath, JSON.stringify(receipt, null, 2))
    } catch {
      /* ignore */
    }
  })

  it('authority sourceRevision survives concurrent failClosedStale thrash', async ({ skip }) => {
    if (!itCtx.available) {
      step('skip', { reason: 'local MySQL unavailable', ok: false })
      skip()
      return
    }

    const seed: Omit<MaskedAccountRecord, 'tombstone'> = {
      maskedAccountId: 'acct-seed-mysql',
      status: 'ACTIVE',
      providerKind: 'GROK',
      effectiveInUse: 0,
      effectiveCap: 5,
      physicalSlotsDisplay: '0/5',
      adaptiveQuotaState: 'healthy',
      reason: null,
      statusChangedAt: new Date(t).toISOString(),
    }

    const seedRes = await syncAccounts(deps, {
      boardId: BOARD,
      sourceRevision: 1,
      generatedAt: new Date(t).toISOString(),
      entityExpectedRev: 0,
      expectedBoardRev: 10,
      canonicalHash: PIN,
      accounts: [seed],
      trigger: 'ORCHESTRATOR_LAUNCH',
      idempotencyKey: 'idem-race-seed',
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: 'race-it',
    })
    step('seed_usable5', {
      ok: seedRes.usableCapacity === 5 && seedRes.stale === false,
      usableCapacity: seedRes.usableCapacity,
      entityRev: (await deps.accounts.get(BOARD))?.entityRev,
    })
    expect(seedRes.usableCapacity).toBe(5)

    const surfaces = createMemoryAccountSyncSurfacePublisher()
    const sched = createAccountSyncScheduler({
      clock: deps.clock,
      accountSync: deps,
      surfacePublisher: surfaces,
    })

    let authorityOk = false
    const isRetryableLockOrCas = (e: unknown): boolean => {
      if (e instanceof AccountSyncError && e.code === 'STALE_REVISION') return true
      if (e && typeof e === 'object' && 'message' in e) {
        const msg = String((e as { message: unknown }).message)
        if (/failed to acquire board named lock|named lock/i.test(msg)) return true
      }
      if (e && typeof e === 'object' && 'code' in e) {
        const code = String((e as { code: unknown }).code)
        if (code === 'DATA_INTEGRITY' || code === 'STALE_REVISION') return true
      }
      return false
    }
    const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms))

    // Bounded concurrency: GET_LOCK wait is 10s; pile-up must still settle via retry.
    const failClosers = Array.from({ length: 16 }, async (_, i) => {
      for (let attempt = 0; attempt < 40; attempt++) {
        try {
          await sched.failClosedStale(BOARD, `MYSQL_RACE_FAIL_CLOSE:${i}`)
          return
        } catch (e) {
          if (isRetryableLockOrCas(e)) {
            await sleep(15 + (attempt % 5) * 10)
            continue
          }
          throw e
        }
      }
      throw new Error(`mysql fail-close worker ${i} exhausted retries`)
    })
    const authorities = Array.from({ length: 6 }, async (_, i) => {
      for (let attempt = 0; attempt < 80; attempt++) {
        const live = await deps.accounts.get(BOARD)
        const board = await deps.atomic.getBoardState(BOARD)
        try {
          const r = await syncAccounts(deps, {
            boardId: BOARD,
            sourceRevision: AUTH_SOURCE,
            generatedAt: new Date(t).toISOString(),
            entityExpectedRev: live?.entityRev ?? 0,
            expectedBoardRev: board.boardRev,
            canonicalHash: PIN,
            accounts: [
              {
                ...seed,
                maskedAccountId: AUTH_MASK,
                status: 'ACTIVE',
                effectiveInUse: 0,
                effectiveCap: 5,
              },
            ],
            trigger: 'ORCHESTRATOR_LAUNCH',
            idempotencyKey: `idem-race-auth-${i}-a${attempt}`,
            callerRole: 'ROOT_ORCHESTRATOR',
            actorId: 'race-it',
          })
          if (!r.replayed) authorityOk = true
          return
        } catch (e) {
          if (isRetryableLockOrCas(e)) {
            await sleep(10 + (attempt % 5) * 8)
            continue
          }
          throw e
        }
      }
      throw new Error(`mysql authority worker ${i} exhausted retries`)
    })

    await Promise.all([...failClosers, ...authorities])

    const final = await deps.accounts.get(BOARD)
    const board = await deps.atomic.getBoardState(BOARD)
    const preserved =
      authorityOk &&
      final != null &&
      final.sourceRevision === AUTH_SOURCE &&
      final.accounts[0]?.maskedAccountId === AUTH_MASK &&
      Number(final.sourceRevision) !== 1

    step('concurrent_authority_vs_fail_close', {
      ok: preserved,
      authorityOk,
      finalSourceRevision: final?.sourceRevision,
      finalMask: final?.accounts[0]?.maskedAccountId,
      finalEntityRev: final?.entityRev,
      finalStale: final?.stale,
      finalUsable: final?.usableCapacity,
      dispatchBlocked: board.dispatchBlocked,
    })

    expect(authorityOk).toBe(true)
    expect(final).not.toBeNull()
    expect(final!.sourceRevision).toBe(AUTH_SOURCE)
    expect(final!.accounts[0]?.maskedAccountId).toBe(AUTH_MASK)
    expect(Number(final!.sourceRevision)).not.toBe(1)
    if (final!.stale) {
      expect(final!.usableCapacity).toBe(0)
      expect(board.dispatchBlocked).toBe(true)
    } else {
      expect(final!.usableCapacity).toBe(5)
    }

    // Already-stale no-op still holds after race settle
    const revBefore = final!.entityRev
    if (final!.stale && final!.usableCapacity === 0) {
      const again = await sched.failClosedStale(BOARD, 'POST_RACE_NOOP')
      step('already_stale_noop_after_race', {
        ok: again?.entityRev === revBefore,
        entityRevBefore: revBefore,
        entityRevAfter: again?.entityRev,
      })
      expect(again?.entityRev).toBe(revBefore)
    } else {
      step('already_stale_noop_after_race', {
        ok: true,
        skipped: true,
        reason: 'final not stale+0 (authority last writer)',
      })
    }
  }, 120_000)
})
