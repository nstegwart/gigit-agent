/**
 * Real-MySQL lock insert race regression (F2 repair).
 * Skips cleanly when local disposable MySQL is unreachable (CAIRN_MIGRATE_IT=0 or probe fail).
 * Proves: plain INSERT (no ODKU hijack) — concurrent different lock_id / same held scope
 * yields exactly one fulfilled + one CLAIM_COLLISION; winner row owner unchanged.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

import type { CollisionLockRecord, IntegrationLockRecord } from '#/server/locks'
import {
  RUNTIME_PERSISTENCE_MIGRATION_FILE,
  RUNTIME_SQL,
  createMysqlControlPlaneRuntimePersistence,
  createMysqlLockStore,
  createMysqlPoolExecutor,
  RuntimePersistenceError,
} from '#/server/control-plane-runtime-persistence'
import { splitSqlStatements } from '#/server/migrations'

const cwd = process.cwd()
const stamp = Date.now().toString(36)
const itCtx = {
  host: process.env.CAIRN_DB_HOST || '127.0.0.1',
  port: Number(process.env.CAIRN_DB_PORT || 3306),
  user: process.env.CAIRN_DB_USER || 'root',
  password: process.env.CAIRN_DB_PASSWORD || '',
  database: `cp_rt_lock_race_${stamp}`,
  available: false,
}

async function openAdminConn() {
  return mysql.createConnection({
    host: itCtx.host,
    port: itCtx.port,
    user: itCtx.user,
    password: itCtx.password,
    multipleStatements: true,
    connectTimeout: 3000,
  })
}

async function probeLocalMysql(): Promise<boolean> {
  if (process.env.CAIRN_MIGRATE_IT === '0') return false
  try {
    const conn = await openAdminConn()
    await conn.query('SELECT 1')
    await conn.end()
    return true
  } catch {
    return false
  }
}

function sampleCollision(overrides: Partial<CollisionLockRecord> = {}): CollisionLockRecord {
  return {
    boardId: 'board-race',
    lockId: 'lock-1',
    scopeId: 'resources:db',
    taskId: 'task-1',
    runId: 'run-1',
    agentId: 'agent-1',
    role: 'AUTHOR',
    fencingToken: 'fence-lock',
    fencingVersion: 1,
    state: 'HELD',
    leaseExpiresAtMs: Date.now() + 60_000,
    acquiredAtMs: Date.now(),
    releasedAtMs: null,
    supersededByLockId: null,
    supersedesLockId: null,
    entityRev: 1,
    ...overrides,
  }
}

function sampleIntegration(overrides: Partial<IntegrationLockRecord> = {}): IntegrationLockRecord {
  return {
    boardId: 'board-race',
    lockId: 'ilock-1',
    repoId: 'repo-x',
    trackingBranch: 'feature/a',
    runId: 'run-1',
    agentId: 'agent-1',
    integratorModel: 'grok-4.5',
    rootAcceptanceId: 'ra-1',
    checkpointId: 'cp-1',
    pathspecs: ['src/**'],
    fencingToken: 'fence-int',
    fencingVersion: 1,
    state: 'HELD',
    leaseExpiresAtMs: Date.now() + 60_000,
    acquiredAtMs: Date.now(),
    releasedAtMs: null,
    entityRev: 1,
    ...overrides,
  }
}

/** Apply only lock tables from 005 (CREATE IF NOT EXISTS). */
async function applyLockTables(conn: mysql.Connection): Promise<void> {
  const sqlPath = path.join(cwd, RUNTIME_PERSISTENCE_MIGRATION_FILE)
  const sql = fs.readFileSync(sqlPath, 'utf8')
  const stmts = splitSqlStatements(sql).filter(
    (s) =>
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+control_plane_collision_locks/i.test(s) ||
      /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+control_plane_integration_locks/i.test(s),
  )
  expect(stmts.length).toBe(2)
  for (const s of stmts) {
    await conn.query(s)
  }
}

function makePool() {
  return mysql.createPool({
    host: itCtx.host,
    port: itCtx.port,
    user: itCtx.user,
    password: itCtx.password,
    database: itCtx.database,
    connectionLimit: 8,
    waitForConnections: true,
    connectTimeout: 10_000,
    charset: 'utf8mb4',
  })
}

describe('control-plane-runtime MySQL lock insert race', () => {
  beforeAll(async () => {
    itCtx.available = await probeLocalMysql()
    if (!itCtx.available) {
      console.warn('SKIP real MySQL lock race: local MySQL not reachable')
      return
    }
    const conn = await openAdminConn()
    try {
      await conn.query(
        `CREATE DATABASE \`${itCtx.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${itCtx.database}\``)
      await applyLockTables(conn)
    } finally {
      await conn.end()
    }
  }, 30_000)

  afterAll(async () => {
    if (!itCtx.available) return
    const conn = await openAdminConn()
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${itCtx.database}\``)
    } finally {
      await conn.end()
    }
  }, 30_000)

  it('lock INSERT SQL is insert-only (no ODKU)', () => {
    expect(RUNTIME_SQL.putCollisionLock).not.toMatch(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i)
    expect(RUNTIME_SQL.putIntegrationLock).not.toMatch(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i)
  })

  it('createMysql factory cannot bypass named locks', () => {
    if (!itCtx.available) return
    const pool = makePool()
    const exec = createMysqlPoolExecutor(pool)
    expect(() => createMysqlControlPlaneRuntimePersistence(exec)).toThrow(RuntimePersistenceError)
    expect(() =>
      createMysqlControlPlaneRuntimePersistence(exec, { useNamedLock: false }),
    ).toThrow(RuntimePersistenceError)
    // With pin + useNamedLock true: allowed
    const ok = createMysqlControlPlaneRuntimePersistence(exec, { useNamedLock: true })
    expect(ok.mode).toBe('mysql')
    void pool.end()
  })

  it('concurrent collision inserts different lock_id same held scope: one win, owner unchanged', async () => {
    if (!itCtx.available) {
      console.warn('SKIP disposable MySQL collision race')
      return
    }
    const poolA = makePool()
    const poolB = makePool()
    try {
      // No named-lock wrap on put path — exposes raw unique-index race (the ODKU bug class).
      const storeA = createMysqlLockStore(createMysqlPoolExecutor(poolA))
      const storeB = createMysqlLockStore(createMysqlPoolExecutor(poolB))
      const scope = `resources:mysql-race-${stamp}`
      const a = sampleCollision({
        lockId: 'lock-rA',
        taskId: 'task-a',
        runId: 'run-rA',
        scopeId: scope,
        fencingToken: 'fence-rA',
      })
      const b = sampleCollision({
        lockId: 'lock-rB',
        taskId: 'task-b',
        runId: 'run-rB',
        scopeId: scope,
        fencingToken: 'fence-rB',
      })
      const results = await Promise.allSettled([storeA.putCollision(a), storeB.putCollision(b)])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      const reason = (rejected[0] as PromiseRejectedResult).reason as RuntimePersistenceError
      expect(reason).toBeInstanceOf(RuntimePersistenceError)
      expect(['CLAIM_COLLISION', 'DATA_INTEGRITY']).toContain(reason.code)

      const held = await storeA.getCollisionByScope('board-race', scope)
      expect(held).not.toBeNull()
      // Critical: winner lock_id and run_id must be consistent (no ODKU PK hijack).
      if (held!.lockId === 'lock-rA') {
        expect(held!.runId).toBe('run-rA')
        expect(held!.taskId).toBe('task-a')
        expect(await storeA.getCollision('board-race', 'lock-rB')).toBeNull()
      } else {
        expect(held!.lockId).toBe('lock-rB')
        expect(held!.runId).toBe('run-rB')
        expect(held!.taskId).toBe('task-b')
        expect(await storeA.getCollision('board-race', 'lock-rA')).toBeNull()
      }

      // Direct SQL readback: only one HELD row for scope; run_id matches lock_id owner
      const [rows] = await poolA.query<mysql.RowDataPacket[]>(
        `SELECT lock_id, run_id, task_id, state FROM control_plane_collision_locks
         WHERE board_id=? AND scope_id=? AND state='HELD'`,
        ['board-race', scope],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.lock_id).toBe(held!.lockId)
      expect(rows[0]!.run_id).toBe(held!.runId)
    } finally {
      await poolA.end()
      await poolB.end()
    }
  }, 30_000)

  it('concurrent integration inserts different lock_id same repo+branch: one win, owner unchanged', async () => {
    if (!itCtx.available) {
      console.warn('SKIP disposable MySQL integration race')
      return
    }
    const poolA = makePool()
    const poolB = makePool()
    try {
      const storeA = createMysqlLockStore(createMysqlPoolExecutor(poolA))
      const storeB = createMysqlLockStore(createMysqlPoolExecutor(poolB))
      const branch = `feature/mysql-race-${stamp}`
      const a = sampleIntegration({
        lockId: 'ilock-rA',
        runId: 'run-rA',
        repoId: 'repo-race',
        trackingBranch: branch,
        fencingToken: 'fence-ia',
      })
      const b = sampleIntegration({
        lockId: 'ilock-rB',
        runId: 'run-rB',
        repoId: 'repo-race',
        trackingBranch: branch,
        fencingToken: 'fence-ib',
      })
      const results = await Promise.allSettled([
        storeA.putIntegration(a),
        storeB.putIntegration(b),
      ])
      const fulfilled = results.filter((r) => r.status === 'fulfilled')
      const rejected = results.filter((r) => r.status === 'rejected')
      expect(fulfilled).toHaveLength(1)
      expect(rejected).toHaveLength(1)
      const reason = (rejected[0] as PromiseRejectedResult).reason as RuntimePersistenceError
      expect(['CLAIM_COLLISION', 'DATA_INTEGRITY']).toContain(reason.code)

      const held = await storeA.getIntegration('board-race', 'repo-race', branch)
      expect(held).not.toBeNull()
      if (held!.lockId === 'ilock-rA') {
        expect(held!.runId).toBe('run-rA')
      } else {
        expect(held!.lockId).toBe('ilock-rB')
        expect(held!.runId).toBe('run-rB')
      }

      const [rows] = await poolA.query<mysql.RowDataPacket[]>(
        `SELECT lock_id, run_id, state FROM control_plane_integration_locks
         WHERE board_id=? AND repo_id=? AND tracking_branch=? AND state='HELD'`,
        ['board-race', 'repo-race', branch],
      )
      expect(rows).toHaveLength(1)
      expect(rows[0]!.lock_id).toBe(held!.lockId)
      expect(rows[0]!.run_id).toBe(held!.runId)
    } finally {
      await poolA.end()
      await poolB.end()
    }
  }, 30_000)

  it('same PK different payload is IDEMPOTENCY_CONFLICT; same content replays', async () => {
    if (!itCtx.available) return
    const pool = makePool()
    try {
      const locks = createMysqlLockStore(createMysqlPoolExecutor(pool))
      const base = sampleCollision({
        lockId: 'lock-idem',
        scopeId: `resources:idem-${stamp}`,
        runId: 'run-orig',
        fencingToken: 'fence-idem',
      })
      await locks.putCollision(base)
      // Idempotent replay
      await locks.putCollision(base)
      const got = await locks.getCollision('board-race', 'lock-idem')
      expect(got?.runId).toBe('run-orig')
      // Different payload same PK
      await expect(
        locks.putCollision({ ...base, runId: 'run-hijack' }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      expect((await locks.getCollision('board-race', 'lock-idem'))?.runId).toBe('run-orig')
    } finally {
      await pool.end()
    }
  }, 30_000)
})
