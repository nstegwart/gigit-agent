/**
 * Real disposable MySQL: nested board-lock reentrancy via register/heartbeat/terminate.
 *
 * Without ALS reentrancy, register outer withBoardLock + acquireCollisionLocks inner
 * pin different pool connections for the same lockName → GET_LOCK waits 10s → timeout.
 * This suite requires a reachable local MySQL (must not soft-skip).
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

import { createFakeClock, createMemoryControlPlaneAtomicStore } from '#/server/board-store'
import {
  RUNTIME_PERSISTENCE_MIGRATION_FILE,
  createMysqlControlPlaneRuntimePersistence,
  createMysqlPoolExecutor,
} from '#/server/control-plane-runtime-persistence'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { splitSqlStatements } from '#/server/migrations'
import {
  heartbeatRun,
  registerRun,
  terminateRun,
  type RunRegistryDeps,
} from '#/server/run-registry'

const cwd = process.cwd()
const stamp = Date.now().toString(36)
const BOARD = `board-reent-${stamp}`
const LOCK_NAME = `cp_rt_${BOARD}`.slice(0, 64)

const itCtx = {
  host: process.env.CAIRN_DB_HOST || '127.0.0.1',
  port: Number(process.env.CAIRN_DB_PORT || 3306),
  user: process.env.CAIRN_DB_USER || 'root',
  password: process.env.CAIRN_DB_PASSWORD || '',
  database: `cp_rt_named_lock_reent_${stamp}`,
  available: false,
  failReason: '' as string,
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
  if (process.env.CAIRN_MIGRATE_IT === '0') {
    itCtx.failReason = 'CAIRN_MIGRATE_IT=0'
    return false
  }
  try {
    const conn = await openAdminConn()
    await conn.query('SELECT 1')
    await conn.end()
    return true
  } catch (e) {
    itCtx.failReason = e instanceof Error ? e.message : String(e)
    return false
  }
}

async function applyRuntimeTables(conn: mysql.Connection): Promise<void> {
  const sqlPath = path.join(cwd, RUNTIME_PERSISTENCE_MIGRATION_FILE)
  const sql = fs.readFileSync(sqlPath, 'utf8')
  const stmts = splitSqlStatements(sql).filter((s) => /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS/i.test(s))
  expect(stmts.length).toBeGreaterThanOrEqual(2)
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

async function isUsedLock(pool: mysql.Pool, lockName: string): Promise<number | null> {
  const [rows] = await pool.query<mysql.RowDataPacket[]>('SELECT IS_USED_LOCK(?) AS holder', [
    lockName,
  ])
  const v = rows[0]?.holder
  if (v == null) return null
  return Number(v)
}

describe('MySQL named lock reentrancy (register/heartbeat/terminate)', () => {
  beforeAll(async () => {
    itCtx.available = await probeLocalMysql()
    if (!itCtx.available) {
      // Task requires real MySQL — surface as hard failure, not soft skip.
      throw new Error(
        `real disposable MySQL required for named-lock reentrancy proof; unavailable: ${itCtx.failReason}`,
      )
    }
    const conn = await openAdminConn()
    try {
      await conn.query(
        `CREATE DATABASE \`${itCtx.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${itCtx.database}\``)
      await applyRuntimeTables(conn)
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

  it('useNamedLock:true nested register/heartbeat/terminate succeeds promptly; IS_USED_LOCK null after', async () => {
    const pool = makePool()
    const t0 = Date.now()
    try {
      const exec = createMysqlPoolExecutor(pool)
      const rt = createMysqlControlPlaneRuntimePersistence(exec, { useNamedLock: true })
      const clock = createFakeClock(Date.parse('2026-07-14T12:00:00.000Z'))
      const atomic = createMemoryControlPlaneAtomicStore([
        {
          boardId: BOARD,
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ])
      const deps: RunRegistryDeps = {
        clock,
        runs: rt.runs,
        locks: rt.locks,
        atomic,
        idempotency: createMemoryIdempotencyStorage(),
        getCapacity: async () => ({
          dispatchMode: 'OPEN',
          dispatchAllowed: true,
          usableCapacity: 10,
          nonGrokAssignmentAllowed: true,
          grokAssignmentAllowed: true,
          limitingReasons: [],
          // M2: dispatchAllowed requires complete family remainings (fail closed without these).
          sparkUsableCapacity: 2,
          solUsableCapacity: 2,
          otherUsableCapacity: 2,
          healthyGrokUsableCapacity: 4,
          failSafeActions: [],
        }),
      }

      // Precondition: named lock free
      expect(await isUsedLock(pool, LOCK_NAME)).toBeNull()

      const scope = `repo:reent:src/**`
      const regStarted = Date.now()
      const reg = await registerRun(deps, {
        canonicalHash: 'canon-reent',
        boardId: BOARD,
        runId: `run-reent-${stamp}`,
        taskId: 'T-REENT',
        targetGate: 'FUNCTIONAL',
        agentId: 'agent-reent',
        model: 'grok-4.5',
        collisionScopeLockIds: [scope],
        expectedEntityRev: 0,
        expectedBoardRev: 0,
        idempotencyKey: `reg-reent-${stamp}`,
        initialState: 'STARTING',
      })
      const regMs = Date.now() - regStarted
      // Nested lock without reentrancy deadlocks ~10s; require prompt success.
      expect(regMs).toBeLessThan(3000)
      expect(reg.state).toBe('STARTING')
      expect(reg.fencingToken).toBeTruthy()
      expect(reg.runId).toBe(`run-reent-${stamp}`)

      // Persist readback: run + HELD collision lock
      const loaded = await rt.runs.get(BOARD, reg.runId)
      expect(loaded).not.toBeNull()
      expect(loaded!.state).toBe('STARTING')
      expect(loaded!.fencingToken).toBe(reg.fencingToken)
      expect(loaded!.collisionScopeLockIds).toEqual([scope])
      const heldLocks = (await rt.locks.listCollision(BOARD)).filter(
        (l) => l.runId === reg.runId && l.state === 'HELD',
      )
      expect(heldLocks.length).toBeGreaterThanOrEqual(1)
      expect(heldLocks[0]!.scopeId).toBe(scope)
      expect(heldLocks[0]!.fencingToken).toBe(reg.fencingToken)

      // Direct SQL readback
      const [runRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT run_id, state, fencing_token FROM control_plane_runs WHERE board_id=? AND run_id=?`,
        [BOARD, reg.runId],
      )
      expect(runRows).toHaveLength(1)
      expect(runRows[0]!.state).toBe('STARTING')

      const [lockRows] = await pool.query<mysql.RowDataPacket[]>(
        `SELECT lock_id, scope_id, state, run_id FROM control_plane_collision_locks
         WHERE board_id=? AND run_id=? AND state='HELD'`,
        [BOARD, reg.runId],
      )
      expect(lockRows.length).toBeGreaterThanOrEqual(1)
      expect(lockRows[0]!.scope_id).toBe(scope)

      // Named lock must not remain held after register returns
      expect(await isUsedLock(pool, LOCK_NAME)).toBeNull()

      const hbStarted = Date.now()
      const hb = await heartbeatRun(deps, {
        idempotencyKey: `hb-reent-${stamp}`,
        canonicalHash: 'canon-reent',
        boardId: BOARD,
        runId: reg.runId,
        agentId: 'agent-reent',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 1,
        expectedEntityRev: loaded!.entityRev,
        expectedBoardRev: 0,
      })
      const hbMs = Date.now() - hbStarted
      expect(hbMs).toBeLessThan(3000)
      expect(hb.state).toBe('RUNNING')
      expect(hb.replayed).toBe(false)
      expect(await isUsedLock(pool, LOCK_NAME)).toBeNull()

      const afterHb = await rt.runs.get(BOARD, reg.runId)
      expect(afterHb!.state).toBe('RUNNING')
      const heldAfterHb = (await rt.locks.listCollision(BOARD)).filter(
        (l) => l.runId === reg.runId && l.state === 'HELD',
      )
      expect(heldAfterHb.length).toBeGreaterThanOrEqual(1)

      const termStarted = Date.now()
      const term = await terminateRun(deps, {
        boardId: BOARD,
        runId: reg.runId,
        agentId: 'agent-reent',
        fencingToken: reg.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'reentrancy-proof',
      })
      const termMs = Date.now() - termStarted
      expect(termMs).toBeLessThan(3000)
      expect(term.state).toBe('SUCCEEDED')

      const afterTerm = await rt.runs.get(BOARD, reg.runId)
      expect(afterTerm!.state).toBe('SUCCEEDED')
      const heldAfterTerm = (await rt.locks.listCollision(BOARD)).filter(
        (l) => l.runId === reg.runId && l.state === 'HELD',
      )
      expect(heldAfterTerm).toHaveLength(0)

      // Final: MySQL named lock free
      expect(await isUsedLock(pool, LOCK_NAME)).toBeNull()

      const totalMs = Date.now() - t0
      // Full lifecycle must not accumulate nested 10s deadlocks (would be ≥30s).
      expect(totalMs).toBeLessThan(15_000)
    } finally {
      await pool.end()
    }
  }, 30_000)

  it('withMysqlNamedLock nested same connection still free after outer (IS_USED_LOCK null)', async () => {
    const pool = makePool()
    try {
      const exec = createMysqlPoolExecutor(pool)
      const { withMysqlNamedLock } = await import('#/server/control-plane-runtime-persistence')
      let depth = 0
      await withMysqlNamedLock(exec, BOARD, async () => {
        depth++
        // Held while outer critical section is active (connection-scoped; IS_USED_LOCK sees holder).
        const duringOuter = await isUsedLock(pool, LOCK_NAME)
        expect(duringOuter).not.toBeNull()
        await withMysqlNamedLock(exec, BOARD, async () => {
          depth++
          const duringInner = await isUsedLock(pool, LOCK_NAME)
          expect(duringInner).toBe(duringOuter)
        })
        expect(depth).toBe(2)
      })
      expect(await isUsedLock(pool, LOCK_NAME)).toBeNull()
    } finally {
      await pool.end()
    }
  }, 15_000)
})
