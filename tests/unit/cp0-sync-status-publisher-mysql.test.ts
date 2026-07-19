/**
 * PACKET-P3A: injectable MySQL adapter for CP0 sync-status publisher deps.
 * Scripted fake pinned connection/pool only — no live DB.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
  type Cp0SyncStatusPublishCandidate,
} from '#/server/cp0-sync-status-publisher'
import {
  CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX,
  CP0_PUBLISHER_MYSQL_LOCK_PREFIX,
  assertValidPublisherBoardId,
  buildCp0PublisherLockName,
  createCp0SyncStatusPublisherMysqlDeps,
  freezeCp0Pin,
  isMysqlLockAcquiredScalar,
  parseBoundedHash,
  parseEntityRevCell,
  parseNonNegativeSafeInt,
  readMysqlLockScalar,
  redactMysqlAdapterError,
  Cp0PublisherMysqlError,
  type Cp0PublisherMysqlClient,
  type Cp0PublisherMysqlConnection,
  type Cp0PublisherMysqlQueryResult,
} from '#/server/cp0-sync-status-publisher-mysql'

const BOARD = 'mfs-rebuild'
const PIN_HASH = '8ba475c604a0'.padEnd(64, '0')
const NOW_ISO = '2026-07-18T18:00:00.000Z'

function baseCandidate(
  overrides: Partial<Cp0SyncStatusPublishCandidate> = {},
): Cp0SyncStatusPublishCandidate {
  return {
    schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
    boardId: BOARD,
    rawStatus: 'READBACK_REQUIRED',
    outbox_pending: null,
    legacy_unreplayed: null,
    effective_backlog: null,
    board_rev: 10,
    lifecycle_rev: 1,
    canonical_hash: PIN_HASH,
    last_ack_revision: null,
    freshness_at: NOW_ISO,
    expectedEntityRev: null,
    nextEntityRev: 1,
    countsProven: false,
    pinStable: true,
    measuredAtMs: Date.parse(NOW_ISO),
    reasonCode: 'COUNTS_UNPROVEN',
    reason: 'counts unproven',
    record: {
      schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
      publisherId: 'unit-publisher',
      tickId: 'tick-1',
      measuredAtMs: Date.parse(NOW_ISO),
      pin: { boardRev: 10, lifecycleRev: 1, canonicalHash: PIN_HASH },
      countsProven: false,
      rawStatus: 'READBACK_REQUIRED',
      measureReasonCode: null,
      measureSources: { outbox: 'x', legacy: 'y', effective: 'z' },
    },
    ...overrides,
  }
}

type ScriptedCall = {
  sql: string
  params: ReadonlyArray<unknown>
  connectionId: string
}

/**
 * Scripted fake pool + pinned connections.
 * GET_LOCK/RELEASE_LOCK are connection-scoped (same connectionId required).
 */
function createScriptedMysql(opts: {
  /** board_id → pin row */
  pins?: Map<string, { board_rev: unknown; lifecycle_rev: unknown; canonical_hash: unknown }>
  /** board_id → sync row */
  rows?: Map<string, Record<string, unknown>>
  /** Pre-held locks by name → connectionId */
  preHeldLocks?: Map<string, string>
  /** Force getConnection to throw */
  getConnectionThrow?: Error
  /** Force RELEASE_LOCK to throw */
  releaseLockThrow?: Error
  /** Force GET_LOCK to throw after pin */
  getLockThrow?: Error
  /** Override affectedRows for next write */
  writeAffectedRows?: number | null | 'omit'
  /** Next write throws this error */
  writeThrow?: Error & { errno?: number; code?: string }
} = {}) {
  const pins =
    opts.pins ??
    new Map([
      [
        BOARD,
        { board_rev: 10, lifecycle_rev: 1, canonical_hash: PIN_HASH },
      ],
    ])
  const rows = opts.rows ?? new Map<string, Record<string, unknown>>()
  const heldNamedLocks = new Map<string, string>(opts.preHeldLocks ?? [])
  const calls: ScriptedCall[] = []
  let connSeq = 0
  let releasedConnections = 0

  function makeConnection(connectionId: string): Cp0PublisherMysqlConnection & {
    connectionId: string
  } {
    let released = false
    return {
      connectionId,
      async query(sql: string, params: ReadonlyArray<unknown> = []): Promise<Cp0PublisherMysqlQueryResult> {
        if (released) throw new Error('query_after_release')
        calls.push({ sql, params: [...params], connectionId })

        if (/SELECT GET_LOCK/i.test(sql)) {
          if (opts.getLockThrow) throw opts.getLockThrow
          const name = String(params[0] ?? '')
          const holder = heldNamedLocks.get(name)
          if (holder && holder !== connectionId) {
            return [[{ l: 0 }], []]
          }
          heldNamedLocks.set(name, connectionId)
          return [[{ l: 1 }], []]
        }
        if (/SELECT RELEASE_LOCK/i.test(sql)) {
          if (opts.releaseLockThrow) throw opts.releaseLockThrow
          const name = String(params[0] ?? '')
          const holder = heldNamedLocks.get(name)
          if (holder === connectionId) {
            heldNamedLocks.delete(name)
            return [[{ r: 1 }], []]
          }
          return [[{ r: 0 }], []]
        }
        if (/FROM board_revisions/i.test(sql)) {
          const boardId = String(params[0] ?? '')
          const pin = pins.get(boardId)
          return [pin ? [pin] : [], []]
        }
        if (/FROM control_plane_sync_status/i.test(sql) && /SELECT/i.test(sql)) {
          const boardId = String(params[0] ?? '')
          const row = rows.get(boardId)
          return [row ? [row] : [], []]
        }
        if (/^INSERT INTO control_plane_sync_status/i.test(sql.trim())) {
          if (opts.writeThrow) throw opts.writeThrow
          const boardId = String(params[0] ?? '')
          if (rows.has(boardId)) {
            const err = new Error('Duplicate entry') as Error & {
              errno: number
              code: string
            }
            err.errno = 1062
            err.code = 'ER_DUP_ENTRY'
            throw err
          }
          if (opts.writeAffectedRows === 'omit') {
            return [{}, []]
          }
          if (opts.writeAffectedRows === null) {
            return [{ affectedRows: null }, []]
          }
          const affected =
            opts.writeAffectedRows !== undefined ? opts.writeAffectedRows : 1
          rows.set(boardId, {
            board_id: boardId,
            status: params[1],
            outbox_pending: params[2],
            legacy_unreplayed: params[3],
            effective_backlog: params[4],
            board_rev: params[5],
            lifecycle_rev: params[6],
            canonical_hash: params[7],
            last_ack_revision: params[8],
            freshness_at: params[9],
            entity_rev: params[10],
            record_json: params[11],
          })
          return [{ affectedRows: affected }, []]
        }
        if (/^UPDATE control_plane_sync_status/i.test(sql.trim())) {
          if (opts.writeThrow) throw opts.writeThrow
          const boardId = String(params[11] ?? '')
          const expectedRev = params[12]
          const existing = rows.get(boardId)
          if (opts.writeAffectedRows === 'omit') {
            return [{}, []]
          }
          if (opts.writeAffectedRows === null) {
            return [{ affectedRows: 'nope' as unknown as number }, []]
          }
          if (opts.writeAffectedRows !== undefined) {
            if (opts.writeAffectedRows === 1 && existing) {
              rows.set(boardId, {
                ...existing,
                status: params[0],
                outbox_pending: params[1],
                legacy_unreplayed: params[2],
                effective_backlog: params[3],
                board_rev: params[4],
                lifecycle_rev: params[5],
                canonical_hash: params[6],
                last_ack_revision: params[7],
                freshness_at: params[8],
                entity_rev: params[9],
                record_json: params[10],
              })
            }
            return [{ affectedRows: opts.writeAffectedRows }, []]
          }
          if (!existing || existing.entity_rev !== expectedRev) {
            return [{ affectedRows: 0 }, []]
          }
          rows.set(boardId, {
            ...existing,
            status: params[0],
            outbox_pending: params[1],
            legacy_unreplayed: params[2],
            effective_backlog: params[3],
            board_rev: params[4],
            lifecycle_rev: params[5],
            canonical_hash: params[6],
            last_ack_revision: params[7],
            freshness_at: params[8],
            entity_rev: params[9],
            record_json: params[10],
          })
          return [{ affectedRows: 1 }, []]
        }
        return [[], []]
      },
      release() {
        if (!released) {
          released = true
          releasedConnections += 1
        }
      },
    }
  }

  const client: Cp0PublisherMysqlClient & {
    calls: ScriptedCall[]
    heldNamedLocks: Map<string, string>
    releasedConnections: () => number
    rows: Map<string, Record<string, unknown>>
    pins: typeof pins
  } = {
    calls,
    heldNamedLocks,
    rows,
    pins,
    releasedConnections: () => releasedConnections,
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      calls.push({ sql, params: [...params], connectionId: 'pool' })
      // Pool path for pin/row/CAS (not lock)
      if (/FROM board_revisions/i.test(sql)) {
        const boardId = String(params[0] ?? '')
        const pin = pins.get(boardId)
        return [pin ? [pin] : [], []]
      }
      if (/FROM control_plane_sync_status/i.test(sql) && /SELECT/i.test(sql)) {
        const boardId = String(params[0] ?? '')
        const row = rows.get(boardId)
        return [row ? [row] : [], []]
      }
      if (/^INSERT INTO control_plane_sync_status/i.test(sql.trim())) {
        if (opts.writeThrow) throw opts.writeThrow
        const boardId = String(params[0] ?? '')
        if (rows.has(boardId)) {
          const err = new Error('Duplicate entry for key PRIMARY password=secret') as Error & {
            errno: number
            code: string
          }
          err.errno = 1062
          err.code = 'ER_DUP_ENTRY'
          throw err
        }
        if (opts.writeAffectedRows === 'omit') {
          return [{}, []]
        }
        if (opts.writeAffectedRows === null) {
          return [{ affectedRows: null }, []]
        }
        const affected =
          opts.writeAffectedRows !== undefined ? opts.writeAffectedRows : 1
        rows.set(boardId, {
          board_id: boardId,
          status: params[1],
          outbox_pending: params[2],
          legacy_unreplayed: params[3],
          effective_backlog: params[4],
          board_rev: params[5],
          lifecycle_rev: params[6],
          canonical_hash: params[7],
          last_ack_revision: params[8],
          freshness_at: params[9],
          entity_rev: params[10],
          record_json: params[11],
        })
        return [{ affectedRows: affected }, []]
      }
      if (/^UPDATE control_plane_sync_status/i.test(sql.trim())) {
        if (opts.writeThrow) throw opts.writeThrow
        const boardId = String(params[11] ?? '')
        const expectedRev = params[12]
        const existing = rows.get(boardId)
        if (opts.writeAffectedRows === 'omit') {
          return [{}, []]
        }
        if (opts.writeAffectedRows === null) {
          return [{ affectedRows: 'nope' as unknown as number }, []]
        }
        if (opts.writeAffectedRows !== undefined) {
          if (opts.writeAffectedRows === 1 && existing) {
            rows.set(boardId, {
              ...existing,
              status: params[0],
              outbox_pending: params[1],
              legacy_unreplayed: params[2],
              effective_backlog: params[3],
              board_rev: params[4],
              lifecycle_rev: params[5],
              canonical_hash: params[6],
              last_ack_revision: params[7],
              freshness_at: params[8],
              entity_rev: params[9],
              record_json: params[10],
            })
          }
          return [{ affectedRows: opts.writeAffectedRows }, []]
        }
        if (!existing || existing.entity_rev !== expectedRev) {
          return [{ affectedRows: 0 }, []]
        }
        rows.set(boardId, {
          ...existing,
          status: params[0],
          outbox_pending: params[1],
          legacy_unreplayed: params[2],
          effective_backlog: params[3],
          board_rev: params[4],
          lifecycle_rev: params[5],
          canonical_hash: params[6],
          last_ack_revision: params[7],
          freshness_at: params[8],
          entity_rev: params[9],
          record_json: params[10],
        })
        return [{ affectedRows: 1 }, []]
      }
      return [[], []]
    },
    async getConnection() {
      if (opts.getConnectionThrow) throw opts.getConnectionThrow
      connSeq += 1
      return makeConnection(`pin-conn-${connSeq}`)
    },
  }

  return client
}

describe('cp0-sync-status-publisher-mysql (PACKET-P3A)', () => {
  describe('lock name', () => {
    it('bounds length and rejects injection metacharacters via sanitize/hash', () => {
      const normal = buildCp0PublisherLockName(BOARD)
      expect(normal).toBe(`${CP0_PUBLISHER_MYSQL_LOCK_PREFIX}${BOARD}`)
      expect(normal.length).toBeLessThanOrEqual(CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX)

      const injection = "board'; DROP TABLE users;--"
      const injName = buildCp0PublisherLockName(injection)
      expect(injName.length).toBeLessThanOrEqual(CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX)
      expect(injName.startsWith(CP0_PUBLISHER_MYSQL_LOCK_PREFIX)).toBe(true)
      expect(injName).not.toContain(';')
      expect(injName).not.toContain("'")
      expect(injName).not.toContain('DROP')
      expect(injName).not.toContain(' ')

      const longId = 'b'.repeat(200)
      const longName = buildCp0PublisherLockName(longId)
      expect(longName.length).toBeLessThanOrEqual(CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX)
      const digest = createHash('sha256')
        .update('tm:cp0-sync-status-lock:v1\0')
        .update(longId)
        .digest('hex')
        .slice(0, 40)
      expect(longName).toBe(`${CP0_PUBLISHER_MYSQL_LOCK_PREFIX}${digest}`)
    })
  })

  describe('acquirePublisherLock', () => {
    it('GET_LOCK and RELEASE_LOCK use the same pinned connection; connection released after', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const lock = await deps.acquirePublisherLock(BOARD)
      expect(lock.held).toBe(true)

      const getCalls = client.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
      expect(getCalls).toHaveLength(1)
      expect(getCalls[0]!.connectionId).toMatch(/^pin-conn-/)
      expect(getCalls[0]!.params[0]).toBe(buildCp0PublisherLockName(BOARD))
      expect(getCalls[0]!.params[1]).toBe(0)

      await lock.release()
      const relCalls = client.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
      expect(relCalls).toHaveLength(1)
      expect(relCalls[0]!.connectionId).toBe(getCalls[0]!.connectionId)
      expect(relCalls[0]!.params[0]).toBe(getCalls[0]!.params[0])
      expect(client.releasedConnections()).toBe(1)
      expect(client.heldNamedLocks.size).toBe(0)
    })

    it('lock miss returns held:false and still returns connection to pool', async () => {
      const lockName = buildCp0PublisherLockName(BOARD)
      const client = createScriptedMysql({
        preHeldLocks: new Map([[lockName, 'other-conn']]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const lock = await deps.acquirePublisherLock(BOARD)
      expect(lock.held).toBe(false)
      expect(client.releasedConnections()).toBe(1)
      await lock.release() // no-op
      expect(client.calls.filter((c) => /RELEASE_LOCK/i.test(c.sql))).toHaveLength(0)
    })

    it('acquire throw releases connection and surfaces bounded error', async () => {
      const client = createScriptedMysql({
        getLockThrow: new Error('mysql ECONNRESET password=hunter2'),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expect(deps.acquirePublisherLock(BOARD)).rejects.toMatchObject({
        name: 'Cp0PublisherMysqlError',
        code: 'LOCK_ERROR',
      })
      expect(client.releasedConnections()).toBe(1)
      try {
        await deps.acquirePublisherLock(BOARD)
      } catch (e) {
        const msg = String((e as Error).message)
        expect(msg).not.toMatch(/password|hunter2|ECONNRESET/i)
        expect(msg).toBe('lock_acquire_failed')
      }
    })

    it('getConnection throw fails closed without leaking secrets', async () => {
      const client = createScriptedMysql({
        getConnectionThrow: new Error('Access denied for user root@localhost password=secret'),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expect(deps.acquirePublisherLock(BOARD)).rejects.toMatchObject({
        code: 'LOCK_ERROR',
      })
    })

    it('RELEASE_LOCK throw still returns connection to pool', async () => {
      const client = createScriptedMysql({
        releaseLockThrow: new Error('RELEASE_LOCK boom token=abc'),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const lock = await deps.acquirePublisherLock(BOARD)
      expect(lock.held).toBe(true)
      await expect(lock.release()).resolves.toBeUndefined()
      expect(client.releasedConnections()).toBe(1)
    })
  })

  describe('readCanonicalPin', () => {
    it('returns a NEW frozen/copied pin each read (mutation attack cannot hide drift)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const a = await deps.readCanonicalPin(BOARD)
      const b = await deps.readCanonicalPin(BOARD)
      expect(a).toEqual({
        boardRev: 10,
        lifecycleRev: 1,
        canonicalHash: PIN_HASH,
      })
      expect(a).not.toBe(b)
      expect(Object.isFrozen(a)).toBe(true)
      expect(Object.isFrozen(b)).toBe(true)
      // Mutation attack on returned object is blocked by freeze.
      expect(() => {
        ;(a as { boardRev: number }).boardRev = 999
      }).toThrow()
      const c = await deps.readCanonicalPin(BOARD)
      expect(c!.boardRev).toBe(10)
    })

    it('freezeCp0Pin copies fields into a new frozen object', () => {
      const shared = { boardRev: 1, lifecycleRev: 2, canonicalHash: 'abc' }
      const f = freezeCp0Pin(shared)
      expect(f).not.toBe(shared)
      expect(Object.isFrozen(f)).toBe(true)
      shared.boardRev = 99
      expect(f.boardRev).toBe(1)
    })

    it('missing pin row returns null', async () => {
      const client = createScriptedMysql({ pins: new Map() })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      expect(await deps.readCanonicalPin(BOARD)).toBeNull()
    })

    it('invalid pin fields fail closed to null', async () => {
      const client = createScriptedMysql({
        pins: new Map([
          [BOARD, { board_rev: -1, lifecycle_rev: 1, canonical_hash: PIN_HASH }],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      expect(await deps.readCanonicalPin(BOARD)).toBeNull()

      client.pins.set(BOARD, {
        board_rev: 1,
        lifecycle_rev: 1,
        canonical_hash: '',
      })
      expect(await deps.readCanonicalPin(BOARD)).toBeNull()

      client.pins.set(BOARD, {
        board_rev: 'nope',
        lifecycle_rev: 1,
        canonical_hash: PIN_HASH,
      })
      expect(await deps.readCanonicalPin(BOARD)).toBeNull()

      client.pins.set(BOARD, {
        board_rev: 1,
        lifecycle_rev: 1,
        canonical_hash: 'x'.repeat(65),
      })
      expect(await deps.readCanonicalPin(BOARD)).toBeNull()
    })

    it('parameterizes board_id (no table/column interpolation)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await deps.readCanonicalPin("evil';--")
      const pinCalls = client.calls.filter((c) => /board_revisions/i.test(c.sql))
      expect(pinCalls.length).toBeGreaterThanOrEqual(1)
      for (const c of pinCalls) {
        expect(c.sql).toContain('?')
        expect(c.sql).not.toContain('evil')
        expect(c.params).toContain("evil';--")
      }
    })
  })

  describe('loadExistingRow', () => {
    it('parses nullable counts without coercing missing/invalid to zero', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'READBACK_REQUIRED',
              outbox_pending: null,
              legacy_unreplayed: null,
              effective_backlog: null,
              board_rev: 10,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: null,
              freshness_at: NOW_ISO,
              entity_rev: 3,
            },
          ],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const row = await deps.loadExistingRow!(BOARD)
      expect(row).not.toBeNull()
      expect(row!.entity_rev).toBe(3)
      expect(row!.outbox_pending).toBeNull()
      expect(row!.legacy_unreplayed).toBeNull()
      expect(row!.effective_backlog).toBeNull()
      expect(row!.last_ack_revision).toBeNull()
      expect(row!.outbox_pending).not.toBe(0)

      client.rows.set(BOARD, {
        board_id: BOARD,
        status: 'IN_SYNC',
        outbox_pending: 'bogus',
        legacy_unreplayed: -5,
        effective_backlog: 2,
        board_rev: 10,
        lifecycle_rev: 1,
        canonical_hash: PIN_HASH,
        last_ack_revision: null,
        freshness_at: new Date(NOW_ISO),
        entity_rev: 1,
      })
      const bad = await deps.loadExistingRow!(BOARD)
      expect(bad!.outbox_pending).toBeNull()
      expect(bad!.legacy_unreplayed).toBeNull()
      expect(bad!.effective_backlog).toBe(2)
      expect(bad!.outbox_pending).not.toBe(0)
      expect(bad!.legacy_unreplayed).not.toBe(0)
    })

    it('preserves proven zero counts as 0 (not null)', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'IN_SYNC',
              outbox_pending: 0,
              legacy_unreplayed: 0,
              effective_backlog: 0,
              board_rev: 10,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: 10,
              freshness_at: NOW_ISO,
              entity_rev: 2,
            },
          ],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const row = await deps.loadExistingRow!(BOARD)
      expect(row!.outbox_pending).toBe(0)
      expect(row!.legacy_unreplayed).toBe(0)
      expect(row!.effective_backlog).toBe(0)
    })

    it('missing row or invalid entity_rev returns null', async () => {
      const client = createScriptedMysql({ rows: new Map() })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      expect(await deps.loadExistingRow!(BOARD)).toBeNull()

      client.rows.set(BOARD, {
        board_id: BOARD,
        status: 'X',
        entity_rev: 0,
        outbox_pending: null,
        legacy_unreplayed: null,
        effective_backlog: null,
        board_rev: 1,
        lifecycle_rev: 1,
        canonical_hash: PIN_HASH,
        last_ack_revision: null,
        freshness_at: null,
      })
      expect(await deps.loadExistingRow!(BOARD)).toBeNull()
    })
  })

  describe('casPublish', () => {
    it('insert success for expectedEntityRev null (plain INSERT, no ON DUP)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const candidate = baseCandidate({
        expectedEntityRev: null,
        nextEntityRev: 1,
        rawStatus: 'READBACK_REQUIRED',
      })
      const out = await deps.casPublish!({ candidate, expectedEntityRev: null })
      expect(out).toEqual({ ok: true })
      const insert = client.calls.find((c) => /INSERT INTO control_plane_sync_status/i.test(c.sql))
      expect(insert).toBeTruthy()
      expect(insert!.sql).not.toMatch(/ON DUPLICATE/i)
      expect(insert!.sql).toContain('?')
      expect(insert!.params[0]).toBe(BOARD)
      expect(insert!.params[1]).toBe('READBACK_REQUIRED')
      expect(insert!.params[2]).toBeNull() // null counts preserved
      expect(insert!.params[10]).toBe(1) // entity_rev
      expect(client.rows.get(BOARD)?.outbox_pending).toBeNull()
    })

    it('duplicate insert becomes conflict (never ON DUP update)', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'IN_SYNC',
              entity_rev: 1,
              outbox_pending: 0,
              legacy_unreplayed: 0,
              effective_backlog: 0,
              board_rev: 10,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: 10,
              freshness_at: NOW_ISO,
            },
          ],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const out = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: null, nextEntityRev: 1 }),
        expectedEntityRev: null,
      })
      expect(out).toEqual({ ok: false, conflict: true })
    })

    it('update success when affectedRows === 1', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'READBACK_REQUIRED',
              entity_rev: 2,
              outbox_pending: null,
              legacy_unreplayed: null,
              effective_backlog: null,
              board_rev: 9,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: null,
              freshness_at: NOW_ISO,
            },
          ],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const candidate = baseCandidate({
        expectedEntityRev: 2,
        nextEntityRev: 3,
        rawStatus: 'IN_SYNC',
        outbox_pending: 0,
        legacy_unreplayed: 0,
        effective_backlog: 0,
        last_ack_revision: 10,
        countsProven: true,
        reasonCode: 'OK_IN_SYNC_ZEROS',
        record: {
          schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
          publisherId: 'unit-publisher',
          tickId: 'tick-1',
          measuredAtMs: Date.parse(NOW_ISO),
          pin: { boardRev: 10, lifecycleRev: 1, canonicalHash: PIN_HASH },
          countsProven: true,
          rawStatus: 'IN_SYNC',
          measureReasonCode: null,
          measureSources: { outbox: 'x', legacy: 'y', effective: 'z' },
        },
      })
      const out = await deps.casPublish!({ candidate, expectedEntityRev: 2 })
      expect(out).toEqual({ ok: true })
      const upd = client.calls.find((c) => /^UPDATE control_plane_sync_status/i.test(c.sql.trim()))
      expect(upd).toBeTruthy()
      expect(upd!.sql).toMatch(/WHERE board_id=\? AND entity_rev=\?/)
      expect(upd!.params[11]).toBe(BOARD)
      expect(upd!.params[12]).toBe(2)
      expect(upd!.params[0]).toBe('IN_SYNC')
      expect(client.rows.get(BOARD)?.entity_rev).toBe(3)
    })

    it('update affectedRows 0 is conflict', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'READBACK_REQUIRED',
              entity_rev: 5,
              outbox_pending: null,
              legacy_unreplayed: null,
              effective_backlog: null,
              board_rev: 10,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: null,
              freshness_at: NOW_ISO,
            },
          ],
        ]),
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const out = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: 2, nextEntityRev: 3 }),
        expectedEntityRev: 2,
      })
      expect(out).toEqual({ ok: false, conflict: true })
    })

    it('update affectedRows > 1 is data-integrity failure (not success)', async () => {
      const client = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              status: 'READBACK_REQUIRED',
              entity_rev: 2,
              outbox_pending: null,
              legacy_unreplayed: null,
              effective_backlog: null,
              board_rev: 10,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: null,
              freshness_at: NOW_ISO,
            },
          ],
        ]),
        writeAffectedRows: 2,
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const out = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: 2, nextEntityRev: 3 }),
        expectedEntityRev: 2,
      })
      expect(out.ok).toBe(false)
      if (!out.ok && out.conflict !== true) {
        expect(out.error).toMatchObject({
          name: 'Cp0PublisherMysqlError',
          code: 'DATA_INTEGRITY',
        })
      } else {
        expect.fail('expected non-conflict integrity failure')
      }
    })

    it('malformed affectedRows is not fabricated success', async () => {
      const client = createScriptedMysql({
        writeAffectedRows: 'omit',
      })
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const out = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: null, nextEntityRev: 1 }),
        expectedEntityRev: null,
      })
      expect(out.ok).toBe(false)
      if (!out.ok && out.conflict !== true) {
        expect(out.error).toMatchObject({ code: 'DRIVER_MALFORMED' })
      } else {
        expect.fail('expected DRIVER_MALFORMED on insert')
      }

      const client2 = createScriptedMysql({
        rows: new Map([
          [
            BOARD,
            {
              board_id: BOARD,
              entity_rev: 1,
              status: 'X',
              outbox_pending: null,
              legacy_unreplayed: null,
              effective_backlog: null,
              board_rev: 1,
              lifecycle_rev: 1,
              canonical_hash: PIN_HASH,
              last_ack_revision: null,
              freshness_at: NOW_ISO,
            },
          ],
        ]),
        writeAffectedRows: null,
      })
      const deps2 = createCp0SyncStatusPublisherMysqlDeps(client2)
      const out2 = await deps2.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: 1, nextEntityRev: 2 }),
        expectedEntityRev: 1,
      })
      expect(out2.ok).toBe(false)
      if (!out2.ok && out2.conflict !== true) {
        expect(out2.error).toMatchObject({ code: 'DRIVER_MALFORMED' })
      } else {
        expect.fail('expected DRIVER_MALFORMED on update')
      }
    })

    it('expected/next rev mismatch is rejected', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const out = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: 2, nextEntityRev: 99 }),
        expectedEntityRev: 2,
      })
      expect(out.ok).toBe(false)
      if (!out.ok && out.conflict !== true) {
        expect(out.error).toMatchObject({ code: 'INVALID_INPUT' })
      } else {
        expect.fail('expected INVALID_INPUT for rev relation')
      }

      const out2 = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: null, nextEntityRev: 2 }),
        expectedEntityRev: null,
      })
      expect(out2.ok).toBe(false)

      const out3 = await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: 1, nextEntityRev: 2 }),
        expectedEntityRev: 9,
      })
      expect(out3.ok).toBe(false)
    })

    it('rejects disallowed rawStatus; accepts honest IN_SYNC and READBACK_REQUIRED', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const bad = await deps.casPublish!({
        candidate: baseCandidate({
          rawStatus: 'GREEN' as 'IN_SYNC',
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(bad.ok).toBe(false)

      const okRb = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-rb',
          rawStatus: 'READBACK_REQUIRED',
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(okRb).toEqual({ ok: true })

      const okIn = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-in',
          rawStatus: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          last_ack_revision: 10, // must equal board_rev for honest IN_SYNC
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(okIn).toEqual({ ok: true })
    })

    it('null counts are persisted as null (not zero)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await deps.casPublish!({
        candidate: baseCandidate({
          outbox_pending: null,
          legacy_unreplayed: null,
          effective_backlog: null,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      const insert = client.calls.find((c) => /INSERT INTO/i.test(c.sql))!
      expect(insert.params[2]).toBeNull()
      expect(insert.params[3]).toBeNull()
      expect(insert.params[4]).toBeNull()
      expect(client.rows.get(BOARD)?.outbox_pending).toBeNull()
    })
  })

  describe('SQL parameterization & hygiene', () => {
    it('all statements use placeholders; board id only in params', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const lock = await deps.acquirePublisherLock(BOARD)
      await deps.readCanonicalPin(BOARD)
      await deps.loadExistingRow!(BOARD)
      await deps.casPublish!({
        candidate: baseCandidate({ expectedEntityRev: null, nextEntityRev: 1 }),
        expectedEntityRev: null,
      })
      await lock.release()

      for (const c of client.calls) {
        if (/GET_LOCK|RELEASE_LOCK|board_revisions|control_plane_sync_status/i.test(c.sql)) {
          expect(c.sql).toContain('?')
          // No string-interpolated board id into SQL text.
          expect(c.sql).not.toContain(`'${BOARD}'`)
          expect(c.sql).not.toMatch(/\$\{/)
        }
      }
    })

    it('error redaction strips message/credentials', () => {
      const err = new Error('Access denied password=supersecret token=abc')
      ;(err as { code?: string }).code = 'ER_ACCESS_DENIED_ERROR'
      const r = redactMysqlAdapterError(err)
      expect(r.name).toBe('Error')
      expect(JSON.stringify(r)).not.toMatch(/supersecret|password|token=abc/i)

      const bounded = new Cp0PublisherMysqlError('LOCK_ERROR', 'lock_acquire_failed', {
        name: 'Error',
      })
      expect(redactMysqlAdapterError(bounded)).toEqual({
        name: 'Cp0PublisherMysqlError',
        code: 'LOCK_ERROR',
      })
    })

    it('factory rejects missing getConnection', () => {
      expect(() =>
        createCp0SyncStatusPublisherMysqlDeps({
          query: async () => [[], []],
        } as unknown as Cp0PublisherMysqlClient),
      ).toThrow(/getConnection_required/)
    })

    it('no N+1 / unbounded fan-out: single query per op', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const before = client.calls.length
      await deps.readCanonicalPin(BOARD)
      expect(client.calls.length - before).toBe(1)
      await deps.loadExistingRow!(BOARD)
      expect(client.calls.length - before).toBe(2)
      await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-n1',
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(client.calls.length - before).toBe(3)
    })
  })

  describe('parse helpers', () => {
    it('parseNonNegativeSafeInt never invents zero from garbage', () => {
      expect(parseNonNegativeSafeInt(null)).toBeNull()
      expect(parseNonNegativeSafeInt(undefined)).toBeNull()
      expect(parseNonNegativeSafeInt('')).toBeNull()
      expect(parseNonNegativeSafeInt('x')).toBeNull()
      expect(parseNonNegativeSafeInt(-1)).toBeNull()
      expect(parseNonNegativeSafeInt(1.5)).toBeNull()
      expect(parseNonNegativeSafeInt(0)).toBe(0)
      expect(parseNonNegativeSafeInt('0')).toBe(0)
      expect(parseNonNegativeSafeInt(7n)).toBe(7)
    })

    it('parseEntityRevCell requires ≥1', () => {
      expect(parseEntityRevCell(0)).toBeNull()
      expect(parseEntityRevCell(1)).toBe(1)
      expect(parseEntityRevCell('3')).toBe(3)
    })

    it('parseBoundedHash requires strict 64-lowercase-hex (trim+normalize)', () => {
      expect(parseBoundedHash('')).toBeNull()
      expect(parseBoundedHash('abc')).toBeNull()
      expect(parseBoundedHash('x'.repeat(65))).toBeNull()
      expect(parseBoundedHash(PIN_HASH)).toBe(PIN_HASH)
      expect(parseBoundedHash(PIN_HASH.toUpperCase())).toBe(PIN_HASH)
      // Padded spaces: normalize to trimmed hex (same value validate==persist).
      expect(parseBoundedHash(`  ${PIN_HASH}  `)).toBe(PIN_HASH)
      // Non-hex content rejected even at length 64.
      expect(parseBoundedHash('g'.repeat(64))).toBeNull()
    })

    it('readMysqlLockScalar handles aliases; rejects boolean/string coercion', () => {
      expect(readMysqlLockScalar([{ l: 1 }])).toBe(1)
      expect(readMysqlLockScalar([{ r: 0 }])).toBe(0)
      expect(readMysqlLockScalar([])).toBeNull()
      // Real mysql2 null miss.
      expect(readMysqlLockScalar([{ l: null }])).toBeNull()
      // Bigint 1 (possible under mysql2 bigint option) → number 1.
      expect(readMysqlLockScalar([{ l: 1n }])).toBe(1)
      // D4: boolean true and string "1" must NOT coerce to acquired scalar.
      expect(readMysqlLockScalar([{ l: true }])).toBeNull()
      expect(readMysqlLockScalar([{ l: '1' }])).toBeNull()
      expect(isMysqlLockAcquiredScalar(1)).toBe(true)
      expect(isMysqlLockAcquiredScalar(0)).toBe(false)
      expect(isMysqlLockAcquiredScalar(null)).toBe(false)
    })
  })

  describe('adversarial D1–D4 (lying caller / forge defenses)', () => {
    /** Assert casPublish failed closed before any INSERT/UPDATE. */
    async function expectRejectBeforeWrite(
      deps: ReturnType<typeof createCp0SyncStatusPublisherMysqlDeps>,
      client: ReturnType<typeof createScriptedMysql>,
      candidate: Cp0SyncStatusPublishCandidate,
      expectedEntityRev: number | null,
    ) {
      const writesBefore = client.calls.filter((c) =>
        /^(INSERT|UPDATE)\b/i.test(c.sql.trim()),
      ).length
      const out = await deps.casPublish!({ candidate, expectedEntityRev })
      expect(out.ok).toBe(false)
      if (!out.ok && out.conflict !== true) {
        expect(out.error).toMatchObject({
          name: 'Cp0PublisherMysqlError',
          code: 'INVALID_INPUT',
        })
      } else {
        expect.fail('expected INVALID_INPUT non-conflict reject')
      }
      const writesAfter = client.calls.filter((c) =>
        /^(INSERT|UPDATE)\b/i.test(c.sql.trim()),
      ).length
      expect(writesAfter).toBe(writesBefore)
    }

    it('D1: forged IN_SYNC with null counts is rejected before SQL write', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          rawStatus: 'IN_SYNC',
          outbox_pending: null,
          legacy_unreplayed: null,
          effective_backlog: null,
          last_ack_revision: 10,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
    })

    it('D1: forged IN_SYNC with nonzero counts is rejected before SQL write', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          rawStatus: 'IN_SYNC',
          outbox_pending: 5,
          legacy_unreplayed: 0,
          effective_backlog: 5,
          last_ack_revision: 10,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
    })

    it('D1: hybrid READBACK_REQUIRED counts (null + non-null) rejected before write', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          rawStatus: 'READBACK_REQUIRED',
          outbox_pending: 1,
          legacy_unreplayed: null,
          effective_backlog: 1,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          boardId: 'board-hyb2',
          rawStatus: 'READBACK_REQUIRED',
          outbox_pending: null,
          legacy_unreplayed: 0,
          effective_backlog: null,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
    })

    it('D1: bad effective sum rejected; never coerce missing to zero', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          rawStatus: 'READBACK_REQUIRED',
          outbox_pending: 2,
          legacy_unreplayed: 3,
          effective_backlog: 9, // not 2+3
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
    })

    it('D1: IN_SYNC with last_ack_revision !== board_rev rejected before write', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          rawStatus: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          board_rev: 10,
          last_ack_revision: 9, // mismatch
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          boardId: 'board-ack-null',
          rawStatus: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          last_ack_revision: null,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )
    })

    it('D1: honest P2-shaped candidates still pass (all-null RB + zero IN_SYNC)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)

      const honestRb = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'honest-rb',
          rawStatus: 'READBACK_REQUIRED',
          outbox_pending: null,
          legacy_unreplayed: null,
          effective_backlog: null,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(honestRb).toEqual({ ok: true })

      const honestRbSum = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'honest-rb-sum',
          rawStatus: 'READBACK_REQUIRED',
          outbox_pending: 2,
          legacy_unreplayed: 3,
          effective_backlog: 5,
          last_ack_revision: null,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(honestRbSum).toEqual({ ok: true })

      const honestIn = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'honest-in',
          rawStatus: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          last_ack_revision: 10,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(honestIn).toEqual({ ok: true })
      expect(client.rows.get('honest-in')?.status).toBe('IN_SYNC')
      expect(client.rows.get('honest-in')?.outbox_pending).toBe(0)
    })

    it('D2: padded canonical_hash persists normalized value (not raw spaces)', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const padded = `  ${PIN_HASH}  `
      // Pre-fix regression: validate used trim but write used raw → spaces persisted.
      // Post-fix: same normalized 64-hex is validated and written.
      const out = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-pad-hash',
          canonical_hash: padded,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(out).toEqual({ ok: true })
      const insert = client.calls.find(
        (c) =>
          /INSERT INTO control_plane_sync_status/i.test(c.sql) &&
          c.params[0] === 'board-pad-hash',
      )
      expect(insert).toBeTruthy()
      expect(insert!.params[7]).toBe(PIN_HASH)
      expect(insert!.params[7]).not.toBe(padded)
      expect(client.rows.get('board-pad-hash')?.canonical_hash).toBe(PIN_HASH)
    })

    it('D3: control-character / empty / overlong board_id rejected before lock/read/load/CAS', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const controlId = 'ok\nid'
      const empty = ''
      const overlong = 'b'.repeat(65)

      await expect(deps.acquirePublisherLock(controlId)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'board_id_control_chars',
      })
      await expect(deps.acquirePublisherLock(empty)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      await expect(deps.acquirePublisherLock(overlong)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
        message: 'board_id_too_long',
      })
      // No GET_LOCK issued for bad ids.
      expect(client.calls.filter((c) => /GET_LOCK/i.test(c.sql))).toHaveLength(0)

      await expect(deps.readCanonicalPin(controlId)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      await expect(deps.loadExistingRow!(controlId)).rejects.toMatchObject({
        code: 'INVALID_INPUT',
      })
      expect(client.calls.filter((c) => /board_revisions|control_plane_sync_status/i.test(c.sql))).toHaveLength(0)

      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          boardId: controlId,
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )

      expect(() => assertValidPublisherBoardId(controlId)).toThrow(Cp0PublisherMysqlError)
      expect(() => assertValidPublisherBoardId('good-board')).not.toThrow()
    })

    it('D4: boolean true lock scalar does not count as acquired', async () => {
      // Scripted connection that returns boolean true for GET_LOCK (broken driver).
      const calls: ScriptedCall[] = []
      let released = 0
      const client: Cp0PublisherMysqlClient & { released: () => number } = {
        released: () => released,
        async query() {
          return [[], []]
        },
        async getConnection() {
          return {
            async query(sql: string, params: ReadonlyArray<unknown> = []) {
              calls.push({ sql, params: [...params], connectionId: 'bool-conn' })
              if (/GET_LOCK/i.test(sql)) {
                return [[{ l: true }], []]
              }
              if (/RELEASE_LOCK/i.test(sql)) {
                return [[{ r: true }], []]
              }
              return [[], []]
            },
            release() {
              released += 1
            },
          }
        },
      }
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)
      const lock = await deps.acquirePublisherLock(BOARD)
      expect(lock.held).toBe(false)
      expect(released).toBe(1) // connection returned on miss
      // Numeric 1 still acquires.
      const clientOk = createScriptedMysql()
      const depsOk = createCp0SyncStatusPublisherMysqlDeps(clientOk)
      const lockOk = await depsOk.acquirePublisherLock(BOARD)
      expect(lockOk.held).toBe(true)
      await lockOk.release()
    })

    it('recheck: revision overflow, record_json bound, freshness control chars, dup insert', async () => {
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client)

      // nextEntityRev overflow relation
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          boardId: 'board-overflow',
          expectedEntityRev: Number.MAX_SAFE_INTEGER,
          nextEntityRev: Number.MAX_SAFE_INTEGER, // not +1 (unsafe)
        }),
        Number.MAX_SAFE_INTEGER,
      )

      // Honest max-safe update path: expected = MAX-1 → next = MAX
      client.rows.set('board-max', {
        board_id: 'board-max',
        status: 'READBACK_REQUIRED',
        entity_rev: Number.MAX_SAFE_INTEGER - 1,
        outbox_pending: null,
        legacy_unreplayed: null,
        effective_backlog: null,
        board_rev: 10,
        lifecycle_rev: 1,
        canonical_hash: PIN_HASH,
        last_ack_revision: null,
        freshness_at: NOW_ISO,
      })
      const maxOk = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-max',
          expectedEntityRev: Number.MAX_SAFE_INTEGER - 1,
          nextEntityRev: Number.MAX_SAFE_INTEGER,
        }),
        expectedEntityRev: Number.MAX_SAFE_INTEGER - 1,
      })
      expect(maxOk).toEqual({ ok: true })

      // freshness control chars
      await expectRejectBeforeWrite(
        deps,
        client,
        baseCandidate({
          boardId: 'board-fresh',
          freshness_at: '2026-07-18T18:00:00.000Z\n',
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        null,
      )

      // record_json oversize
      const big = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-big-json',
          expectedEntityRev: null,
          nextEntityRev: 1,
          record: {
            schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
            publisherId: 'unit-publisher',
            tickId: 'tick-1',
            measuredAtMs: Date.parse(NOW_ISO),
            pin: { boardRev: 10, lifecycleRev: 1, canonicalHash: PIN_HASH },
            countsProven: false,
            rawStatus: 'READBACK_REQUIRED',
            measureReasonCode: null,
            measureSources: { outbox: 'x', legacy: 'y', effective: 'z' },
            pad: 'x'.repeat(9000),
          } as Cp0SyncStatusPublishCandidate['record'],
        }),
        expectedEntityRev: null,
      })
      expect(big.ok).toBe(false)
      if (!big.ok && big.conflict !== true) {
        expect(big.error).toMatchObject({ code: 'INVALID_INPUT' })
      }

      // duplicate insert → conflict
      client.rows.set('board-dup', {
        board_id: 'board-dup',
        status: 'READBACK_REQUIRED',
        entity_rev: 1,
        outbox_pending: null,
        legacy_unreplayed: null,
        effective_backlog: null,
        board_rev: 10,
        lifecycle_rev: 1,
        canonical_hash: PIN_HASH,
        last_ack_revision: null,
        freshness_at: NOW_ISO,
      })
      const dup = await deps.casPublish!({
        candidate: baseCandidate({
          boardId: 'board-dup',
          expectedEntityRev: null,
          nextEntityRev: 1,
        }),
        expectedEntityRev: null,
      })
      expect(dup).toEqual({ ok: false, conflict: true })
    })
  })

  describe('no live DB import side effect', () => {
    it('module factory does not require db() and works with pure fake', async () => {
      // If the adapter imported db() at module load, tests would need env/pool.
      // This pure fake path proves inject-only wiring.
      const client = createScriptedMysql()
      const deps = createCp0SyncStatusPublisherMysqlDeps(client, {
        lockTimeoutSec: 0,
      })
      expect(typeof deps.acquirePublisherLock).toBe('function')
      expect(typeof deps.readCanonicalPin).toBe('function')
      expect(typeof deps.loadExistingRow).toBe('function')
      expect(typeof deps.casPublish).toBe('function')
      const lock = await deps.acquirePublisherLock(BOARD)
      expect(lock.held).toBe(true)
      await lock.release()
    })
  })
})
