/**
 * PACKET-P3C: dual-COUNT MySQL backlog sources — adversarial matrix T1–T20.
 * Scripted fake SQL client only; no live MySQL claim.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it, vi } from 'vitest'

import {
  CP0_BACKLOG_BOARD_ID_MAX,
  CP0_BACKLOG_DUAL_COUNT_SQL,
  CP0_BACKLOG_LEGACY_SOURCE_ID,
  CP0_BACKLOG_OUTBOX_SOURCE_ID,
  createCp0MysqlBacklogCountMeasurers,
  isMysqlMissingTableError,
  isValidCp0BacklogBoardId,
  measureCp0BacklogCountsSnapshot,
  redactBacklogCountError,
  type Cp0BacklogCountSqlClient,
} from '#/server/cp0-sync-status-count-sources'
import {
  createDefaultCp0SyncStatusMeasureDeps,
  measureCp0SyncStatusCounts,
  toNullableCountColumns,
  type Cp0MeasureContext,
} from '#/server/cp0-sync-status-measures'
import {
  createCp0SyncStatusPublisherDeps,
  runCp0SyncStatusPublisherTick,
  type Cp0PublisherLockHandle,
  type Cp0SyncStatusExistingRow,
  type Cp0SyncStatusPublishCandidate,
  type Cp0SyncStatusPublisherDeps,
} from '#/server/cp0-sync-status-publisher'

const NOW = Date.parse('2026-07-19T12:00:00.000Z')
const BOARD = 'mfs-rebuild'
const BOARD_B = 'other-board'
const CTX: Cp0MeasureContext = { boardId: BOARD, nowMs: NOW }
const PIN = {
  boardRev: 5845,
  lifecycleRev: 1,
  canonicalHash: '8ba475c604a0'.padEnd(64, '0'),
}

const SRC_PATH = join(
  dirname(fileURLToPath(import.meta.url)),
  '../../src/server/cp0-sync-status-count-sources.ts',
)

// ---------------------------------------------------------------------------
// Scripted fake client
// ---------------------------------------------------------------------------

type ScriptedOpts = {
  /** Return this row object (default dual zeros). */
  row?: Record<string, unknown> | null
  /** Map boardId → row override (board isolation). */
  byBoard?: Map<string, Record<string, unknown>>
  /** Throw this error from query. */
  throwError?: unknown
  /** Delay ms before resolving (concurrency tests). */
  delayMs?: number
  /** Custom query handler (overrides row/throw). */
  handler?: (
    sql: string,
    params: ReadonlyArray<unknown>,
  ) => Promise<[unknown, unknown?]> | [unknown, unknown?]
}

function createScriptedClient(opts: ScriptedOpts = {}) {
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []

  const client: Cp0BacklogCountSqlClient = {
    async query(sql: string, params: ReadonlyArray<unknown> = []) {
      calls.push({ sql, params: [...params] })
      if (opts.delayMs && opts.delayMs > 0) {
        await new Promise((r) => setTimeout(r, opts.delayMs))
      }
      if (opts.handler) {
        return await opts.handler(sql, params)
      }
      if (opts.throwError !== undefined) {
        throw opts.throwError
      }
      if (opts.row === null) {
        return [[], []]
      }
      if (opts.byBoard) {
        const boardId = String(params[0] ?? '')
        const row =
          opts.byBoard.get(boardId) ??
          ({ outbox_pending: 0, legacy_unreplayed: 0 } as Record<string, unknown>)
        return [[row], []]
      }
      const row =
        opts.row ??
        ({ outbox_pending: 0, legacy_unreplayed: 0 } as Record<string, unknown>)
      return [[row], []]
    },
  }

  return { client, calls }
}

function missingTableError(message = "Table 'tm.control_plane_sync_outbox' doesn't exist"): Error {
  return Object.assign(new Error(message), {
    code: 'ER_NO_SUCH_TABLE',
    errno: 1146,
    sqlState: '42S02',
  })
}

function heldLock(release = vi.fn(async () => {})): Cp0PublisherLockHandle {
  return { held: true, fenceToken: 'fence-p3c', release }
}

function memoryCasStore() {
  let row: Cp0SyncStatusExistingRow | null = null
  const writes: Cp0SyncStatusPublishCandidate[] = []
  return {
    writes,
    loadExistingRow: async () => row,
    casPublish: async ({
      candidate,
      expectedEntityRev,
    }: {
      candidate: Cp0SyncStatusPublishCandidate
      expectedEntityRev: number | null
    }) => {
      if (row == null) {
        if (expectedEntityRev != null) return { ok: false as const, conflict: true as const }
        row = {
          entity_rev: candidate.nextEntityRev,
          freshness_at: candidate.freshness_at,
          status: candidate.rawStatus,
          outbox_pending: candidate.outbox_pending,
          legacy_unreplayed: candidate.legacy_unreplayed,
          effective_backlog: candidate.effective_backlog,
          board_rev: candidate.board_rev,
          lifecycle_rev: candidate.lifecycle_rev,
          canonical_hash: candidate.canonical_hash,
          last_ack_revision: candidate.last_ack_revision,
        }
        writes.push(candidate)
        return { ok: true as const }
      }
      if (row.entity_rev !== expectedEntityRev) {
        return { ok: false as const, conflict: true as const }
      }
      row = {
        entity_rev: candidate.nextEntityRev,
        freshness_at: candidate.freshness_at,
        status: candidate.rawStatus,
        outbox_pending: candidate.outbox_pending,
        legacy_unreplayed: candidate.legacy_unreplayed,
        effective_backlog: candidate.effective_backlog,
        board_rev: candidate.board_rev,
        lifecycle_rev: candidate.lifecycle_rev,
        canonical_hash: candidate.canonical_hash,
        last_ack_revision: candidate.last_ack_revision,
      }
      writes.push(candidate)
      return { ok: true as const }
    },
  }
}

function basePublisherDeps(
  overrides: Partial<Cp0SyncStatusPublisherDeps> & {
    pin?: typeof PIN | null
    pinSequence?: Array<typeof PIN | null>
  } = {},
): Cp0SyncStatusPublisherDeps {
  let pinReads = 0
  const pinSequence = overrides.pinSequence
  const fixedPin = overrides.pin === undefined ? PIN : overrides.pin
  return createCp0SyncStatusPublisherDeps({
    nowMs: overrides.nowMs ?? (() => NOW),
    acquirePublisherLock:
      overrides.acquirePublisherLock ?? (async () => heldLock()),
    readCanonicalPin:
      overrides.readCanonicalPin ??
      (async () => {
        if (pinSequence) {
          const p = pinSequence[Math.min(pinReads, pinSequence.length - 1)] ?? null
          pinReads += 1
          return p
        }
        return fixedPin
      }),
    loadExistingRow: overrides.loadExistingRow,
    casPublish: overrides.casPublish,
    measureDeps: overrides.measureDeps,
    publisherId: overrides.publisherId ?? 'unit-p3c',
    tickId: overrides.tickId ?? 'tick-p3c-1',
  })
}

function assertNoSecrets(text: string) {
  expect(text).not.toMatch(/password|passwd|secret|token|Bearer|mysql:\/\/|DSN=/i)
  expect(text).not.toMatch(/SELECT[\s\S]{40,}FROM/i)
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('cp0-sync-status-count-sources (PACKET-P3C)', () => {
  describe('SQL surface / static forbid (T9, T18, no N+1 shape)', () => {
    it('dual SELECT uses both source tables, pending status sets, and params slots', () => {
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/control_plane_sync_outbox/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/control_plane_legacy_residuals/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/PENDING/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/IN_FLIGHT/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/FAILED/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/UNREPLAYED/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).toMatch(/REPLAYING/)
      // Excluded statuses must not appear as status tokens (UNREPLAYED ≠ REPLAYED)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/'ACKED'/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/'DEAD'/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/'REPLAYED'/)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/'ABANDONED'/)
      // Two board_id placeholders
      expect((CP0_BACKLOG_DUAL_COUNT_SQL.match(/\?/g) ?? []).length).toBe(2)
      // Single statement (no multi-statement separators beyond the dual SELECT)
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/BEGIN|COMMIT|ROLLBACK/i)
    })

    it('T18: source module must not SELECT sink control_plane_sync_status as measure SSOT', () => {
      const src = readFileSync(SRC_PATH, 'utf8')
      // Sink table name may appear only in comments forbidding it — not as FROM source.
      expect(src).not.toMatch(
        /FROM\s+control_plane_sync_status|JOIN\s+control_plane_sync_status/i,
      )
      // Dual COUNT SQL constant must not reference sink
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/control_plane_sync_status/)
    })
  })

  describe('board id validation', () => {
    it('accepts nonempty bounded ids without control chars', () => {
      expect(isValidCp0BacklogBoardId(BOARD)).toBe(true)
      expect(isValidCp0BacklogBoardId('a')).toBe(true)
      expect(isValidCp0BacklogBoardId('x'.repeat(CP0_BACKLOG_BOARD_ID_MAX))).toBe(true)
    })

    it('rejects empty, overlong, control-char, non-string', () => {
      expect(isValidCp0BacklogBoardId('')).toBe(false)
      expect(isValidCp0BacklogBoardId('x'.repeat(CP0_BACKLOG_BOARD_ID_MAX + 1))).toBe(
        false,
      )
      expect(isValidCp0BacklogBoardId('bad\nid')).toBe(false)
      expect(isValidCp0BacklogBoardId('has\0null')).toBe(false)
      expect(isValidCp0BacklogBoardId(null)).toBe(false)
      expect(isValidCp0BacklogBoardId(12)).toBe(false)
    })

    it('invalid boardId does not query and returns both unproven', async () => {
      const { client, calls } = createScriptedClient()
      const snap = await measureCp0BacklogCountsSnapshot(client, {
        boardId: 'bad\nboard',
        nowMs: NOW,
      })
      expect(calls).toHaveLength(0)
      expect(snap.outbox.proven).toBe(false)
      expect(snap.legacy.proven).toBe(false)
      expect(snap.outbox.value).toBeNull()
      expect(snap.legacy.value).toBeNull()
      expect(snap.outbox.reasonCode).toBe('MEASURE_ERROR')
      expect(snap.legacy.reasonCode).toBe('MEASURE_ERROR')
    })
  })

  describe('T1 missing tables', () => {
    it('errno 1146 / ER_NO_SUCH_TABLE → both unproven SOURCE_UNAVAILABLE; never 0', async () => {
      const { client } = createScriptedClient({ throwError: missingTableError() })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox.proven).toBe(false)
      expect(snap.legacy.proven).toBe(false)
      expect(snap.outbox.value).toBeNull()
      expect(snap.legacy.value).toBeNull()
      expect(snap.outbox.value).not.toBe(0)
      expect(snap.legacy.value).not.toBe(0)
      expect(snap.outbox.reasonCode).toBe('SOURCE_UNAVAILABLE')
      expect(snap.legacy.reasonCode).toBe('SOURCE_UNAVAILABLE')
      expect(snap.outbox.measuredAtMs).toBe(NOW)
      expect(snap.legacy.measuredAtMs).toBe(NOW)
      assertNoSecrets(snap.outbox.reason)
      assertNoSecrets(snap.legacy.reason)
    })

    it('isMysqlMissingTableError detects errno/code/message variants', () => {
      expect(isMysqlMissingTableError(missingTableError())).toBe(true)
      expect(
        isMysqlMissingTableError(
          Object.assign(new Error('Unknown table'), { errno: 1146 }),
        ),
      ).toBe(true)
      expect(
        isMysqlMissingTableError(
          Object.assign(new Error('x'), { code: 'ER_NO_SUCH_TABLE' }),
        ),
      ).toBe(true)
      expect(isMysqlMissingTableError(new Error('timeout'))).toBe(false)
    })
  })

  describe('T2 generic DB error / redaction (T20)', () => {
    it('generic throw → both unproven MEASURE_ERROR; no secrets in reason', async () => {
      const secretErr = Object.assign(
        new Error(
          'Access denied for user root@localhost password=hunter2 mysql://u:p@h/db SELECT * FROM t',
        ),
        { code: 'ER_ACCESS_DENIED_ERROR', errno: 1045 },
      )
      const { client } = createScriptedClient({ throwError: secretErr })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox.proven).toBe(false)
      expect(snap.legacy.proven).toBe(false)
      expect(snap.outbox.reasonCode).toBe('MEASURE_ERROR')
      expect(snap.legacy.reasonCode).toBe('MEASURE_ERROR')
      // Coherent both sides
      expect(snap.outbox.reasonCode).toBe(snap.legacy.reasonCode)
      assertNoSecrets(snap.outbox.reason)
      assertNoSecrets(snap.legacy.reason)
      expect(snap.outbox.reason).not.toContain('hunter2')
      expect(snap.outbox.reason).not.toContain('Access denied')
      // Redaction helper: name/code only
      const red = redactBacklogCountError(secretErr)
      expect(red.name).toBe('Error')
      expect(red.code).toBe('ER_ACCESS_DENIED_ERROR')
      expect(red.errno).toBe(1045)
      expect(JSON.stringify(red)).not.toMatch(/hunter2|password/i)
    })

    it('timeout-style throw is unproven, not zero', async () => {
      const { client } = createScriptedClient({
        throwError: Object.assign(new Error('Query timeout'), {
          code: 'PROTOCOL_SEQUENCE_TIMEOUT',
        }),
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox.value).toBeNull()
      expect(snap.legacy.value).toBeNull()
      expect(snap.outbox.reasonCode).toBe('MEASURE_ERROR')
    })
  })

  describe('T3–T6 cell parsing (malformed / overflow / negative / bigint)', () => {
    it('T3: malformed cells → unproven VALUE_NOT_INTEGER / VALUE_MISSING', async () => {
      const cases: Array<{ row: Record<string, unknown>; code: string }> = [
        { row: { outbox_pending: '1.5', legacy_unreplayed: 0 }, code: 'VALUE_NOT_INTEGER' },
        { row: { outbox_pending: 'abc', legacy_unreplayed: 0 }, code: 'VALUE_NOT_INTEGER' },
        { row: { outbox_pending: '', legacy_unreplayed: 0 }, code: 'VALUE_MISSING' },
        { row: { outbox_pending: true, legacy_unreplayed: 0 }, code: 'VALUE_NOT_INTEGER' },
        { row: { outbox_pending: { n: 1 }, legacy_unreplayed: 0 }, code: 'VALUE_NOT_INTEGER' },
        { row: { outbox_pending: null, legacy_unreplayed: 0 }, code: 'VALUE_MISSING' },
      ]
      for (const c of cases) {
        const { client } = createScriptedClient({ row: c.row })
        const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
        expect(snap.outbox.proven, JSON.stringify(c.row)).toBe(false)
        expect(snap.outbox.value).toBeNull()
        expect(snap.outbox.reasonCode, JSON.stringify(c.row)).toBe(c.code)
      }
    })

    it('T4: bigint within safe range → proven Number', async () => {
      const { client } = createScriptedClient({
        row: { outbox_pending: 3n, legacy_unreplayed: 2n },
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox).toMatchObject({ proven: true, value: 3 })
      expect(snap.legacy).toMatchObject({ proven: true, value: 2 })
    })

    it('T5: overflow → VALUE_OVERFLOW', async () => {
      const huge = BigInt(Number.MAX_SAFE_INTEGER) + 1n
      const { client } = createScriptedClient({
        row: { outbox_pending: huge, legacy_unreplayed: 0 },
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox.proven).toBe(false)
      expect(snap.outbox.reasonCode).toBe('VALUE_OVERFLOW')
      expect(snap.outbox.value).toBeNull()
    })

    it('T6: negative number → VALUE_NEGATIVE; negative string rejected (not integer shape)', async () => {
      const num = createScriptedClient({
        row: { outbox_pending: -1, legacy_unreplayed: 0 },
      })
      const snapNum = await measureCp0BacklogCountsSnapshot(num.client, CTX)
      expect(snapNum.outbox.proven).toBe(false)
      expect(snapNum.outbox.reasonCode).toBe('VALUE_NEGATIVE')

      // P1 strict decimal regex is +?\d+ only; leading '-' is VALUE_NOT_INTEGER
      const str = createScriptedClient({
        row: { outbox_pending: '-3', legacy_unreplayed: 0 },
      })
      const snapStr = await measureCp0BacklogCountsSnapshot(str.client, CTX)
      expect(snapStr.outbox.proven).toBe(false)
      expect(snapStr.outbox.value).toBeNull()
      expect(['VALUE_NEGATIVE', 'VALUE_NOT_INTEGER']).toContain(
        snapStr.outbox.reasonCode,
      )
    })

    it('missing row / missing cells → VALUE_MISSING never 0', async () => {
      const empty = createScriptedClient({ row: null })
      const snapEmpty = await measureCp0BacklogCountsSnapshot(empty.client, CTX)
      expect(snapEmpty.outbox.reasonCode).toBe('VALUE_MISSING')
      expect(snapEmpty.legacy.reasonCode).toBe('VALUE_MISSING')
      expect(snapEmpty.outbox.value).toBeNull()

      const partial = createScriptedClient({
        row: { outbox_pending: 1 } /* legacy missing */,
      })
      const snapPartial = await measureCp0BacklogCountsSnapshot(partial.client, CTX)
      expect(snapPartial.outbox).toMatchObject({ proven: true, value: 1 })
      expect(snapPartial.legacy.proven).toBe(false)
      expect(snapPartial.legacy.reasonCode).toBe('VALUE_MISSING')
    })
  })

  describe('T7–T10 honest counts, exclusion surface, board isolation', () => {
    it('T7: tables present, zero rows for board → proven 0,0', async () => {
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox).toMatchObject({
        proven: true,
        value: 0,
        name: 'outbox_pending',
        source: { id: CP0_BACKLOG_OUTBOX_SOURCE_ID },
      })
      expect(snap.legacy).toMatchObject({
        proven: true,
        value: 0,
        name: 'legacy_unreplayed',
        source: { id: CP0_BACKLOG_LEGACY_SOURCE_ID },
      })
      expect(snap.measuredAtMs).toBe(NOW)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.params).toEqual([BOARD, BOARD])
      expect(calls[0]!.sql).toBe(CP0_BACKLOG_DUAL_COUNT_SQL)
    })

    it('T8: outbox 3, legacy 0 → proven pair; effective 3 via P1', async () => {
      const { client } = createScriptedClient({
        row: { outbox_pending: 3, legacy_unreplayed: 0 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const combined = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps(hooks),
        CTX,
      )
      expect(combined.countsProven).toBe(true)
      expect(combined.outbox.value).toBe(3)
      expect(combined.legacy.value).toBe(0)
      expect(combined.effective.value).toBe(3)
      const cols = toNullableCountColumns(combined)
      expect(cols).toEqual({
        outbox_pending: 3,
        legacy_unreplayed: 0,
        effective_backlog: 3,
        countsProven: true,
      })
    })

    it('T9: SQL excludes terminal statuses (static + live call uses that SQL)', async () => {
      const { client, calls } = createScriptedClient()
      await measureCp0BacklogCountsSnapshot(client, CTX)
      const sql = calls[0]!.sql
      expect(sql).toContain("IN ('PENDING','IN_FLIGHT','FAILED')")
      expect(sql).toContain("IN ('UNREPLAYED','REPLAYING')")
      expect(sql).not.toMatch(/'ACKED'/)
      expect(sql).not.toMatch(/'DEAD'/)
      expect(sql).not.toMatch(/'REPLAYED'/)
      expect(sql).not.toMatch(/'ABANDONED'/)
    })

    it('T10: board filter enforced via params; board A invisible to board B mapping', async () => {
      const byBoard = new Map<string, Record<string, unknown>>([
        [BOARD, { outbox_pending: 5, legacy_unreplayed: 1 }],
        [BOARD_B, { outbox_pending: 0, legacy_unreplayed: 0 }],
      ])
      const { client, calls } = createScriptedClient({ byBoard })
      const a = await measureCp0BacklogCountsSnapshot(client, {
        boardId: BOARD,
        nowMs: NOW,
      })
      const b = await measureCp0BacklogCountsSnapshot(client, {
        boardId: BOARD_B,
        nowMs: NOW,
      })
      expect(a.outbox.value).toBe(5)
      expect(a.legacy.value).toBe(1)
      expect(b.outbox.value).toBe(0)
      expect(b.legacy.value).toBe(0)
      expect(calls[0]!.params).toEqual([BOARD, BOARD])
      expect(calls[1]!.params).toEqual([BOARD_B, BOARD_B])
    })
  })

  describe('T11–T13 single-flight / no N+1 / no cross-tick cache', () => {
    it('T11: concurrent measureOutbox+measureLegacy → exactly one query', async () => {
      const { client, calls } = createScriptedClient({
        delayMs: 15,
        row: { outbox_pending: 2, legacy_unreplayed: 4 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const [outbox, legacy] = await Promise.all([
        hooks.measureOutbox(CTX),
        hooks.measureLegacy(CTX),
      ])
      expect(calls).toHaveLength(1)
      expect(outbox).toMatchObject({ proven: true, value: 2 })
      expect(legacy).toMatchObject({ proven: true, value: 4 })
      // Same snapshot measuredAtMs
      expect(outbox.measuredAtMs).toBe(NOW)
      expect(legacy.measuredAtMs).toBe(NOW)
    })

    it('T11b: sequential same-key hooks also single-flight (no requery)', async () => {
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 1, legacy_unreplayed: 1 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const outbox = await hooks.measureOutbox(CTX)
      const legacy = await hooks.measureLegacy(CTX)
      const outbox2 = await hooks.measureOutbox(CTX)
      expect(calls).toHaveLength(1)
      expect(outbox.value).toBe(1)
      expect(legacy.value).toBe(1)
      expect(outbox2.value).toBe(1)
    })

    it('T11c: measureCp0SyncStatusCounts Promise.all uses one query', async () => {
      const { client, calls } = createScriptedClient({
        delayMs: 10,
        row: { outbox_pending: 7, legacy_unreplayed: 1 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const combined = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps(hooks),
        CTX,
      )
      expect(calls).toHaveLength(1)
      expect(combined.countsProven).toBe(true)
      expect(combined.effective.value).toBe(8)
    })

    it('T12: different nowMs (next tick) starts a new query', async () => {
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      await Promise.all([
        hooks.measureOutbox({ boardId: BOARD, nowMs: NOW }),
        hooks.measureLegacy({ boardId: BOARD, nowMs: NOW }),
      ])
      await Promise.all([
        hooks.measureOutbox({ boardId: BOARD, nowMs: NOW + 30_000 }),
        hooks.measureLegacy({ boardId: BOARD, nowMs: NOW + 30_000 }),
      ])
      expect(calls).toHaveLength(2)
    })

    it('T12b: different boardId starts a new query', async () => {
      const { client, calls } = createScriptedClient()
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      await hooks.measureOutbox({ boardId: BOARD, nowMs: NOW })
      await hooks.measureLegacy({ boardId: BOARD_B, nowMs: NOW })
      expect(calls).toHaveLength(2)
      expect(calls[0]!.params[0]).toBe(BOARD)
      expect(calls[1]!.params[0]).toBe(BOARD_B)
    })

    it('T13: factory is single-shot; independent two-query path is not used', async () => {
      // Document: direct dual measure is one SQL; factory does not call two COUNTs.
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 9, legacy_unreplayed: 1 },
      })
      await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(calls).toHaveLength(1)
      expect(calls[0]!.sql).toBe(CP0_BACKLOG_DUAL_COUNT_SQL)
      // Not two separate COUNT statements
      expect(calls.filter((c) => /COUNT\(\*\)/.test(c.sql))).toHaveLength(1)
    })
  })

  describe('T14 pin drift integration with P2 (no CAS)', () => {
    it('real dual measures + pin drift → SKIP_PIN_DRIFT; no CAS write; no forged zeros', async () => {
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const store = memoryCasStore()
      const release = vi.fn(async () => {})
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        basePublisherDeps({
          measureDeps: createDefaultCp0SyncStatusMeasureDeps(hooks),
          pinSequence: [PIN, { ...PIN, boardRev: PIN.boardRev + 1 }],
          acquirePublisherLock: async () => heldLock(release),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(result.decision).toBe('SKIP_PIN_DRIFT')
      expect(result.published).toBe(false)
      expect(result.candidate).toBeNull()
      expect(result.zeroBacklogClaimed).toBe(false)
      expect(store.writes).toHaveLength(0)
      expect(release).toHaveBeenCalled()
      // Measure still ran once (coherent dual)
      expect(calls).toHaveLength(1)
      // Combined measures retained on result when present
      if (result.combined) {
        expect(result.combined.outbox.proven).toBe(true)
        expect(result.combined.outbox.value).toBe(0)
        // But no publish of zeros under drift
      }
    })
  })

  describe('T15 no TX / no borrowed connection lifecycle', () => {
    it('module source has no BEGIN/COMMIT/ROLLBACK or getConnection/release', () => {
      const src = readFileSync(SRC_PATH, 'utf8')
      expect(src).not.toMatch(/\bBEGIN\b|\bCOMMIT\b|\bROLLBACK\b/)
      expect(src).not.toMatch(/getConnection|beginTransaction/)
      // Client type is query-only
      expect(CP0_BACKLOG_DUAL_COUNT_SQL).not.toMatch(/BEGIN|COMMIT|ROLLBACK/i)
    })
  })

  describe('T16 duplicate status rows / COUNT semantics', () => {
    it('fake COUNT row count is accepted as non-negative; still single query', async () => {
      // UNIQUE prevents dups in real schema; if client returns N, we trust COUNT cell.
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 2, legacy_unreplayed: 2 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const combined = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps(hooks),
        CTX,
      )
      expect(calls).toHaveLength(1)
      expect(combined.outbox.value).toBe(2)
      expect(combined.legacy.value).toBe(2)
      expect(combined.effective.value).toBe(4)
    })
  })

  describe('T17 hybrid partial inject', () => {
    it('one real hook + one default → countsProven=false, all null columns', async () => {
      const { client } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      // Only inject outbox; legacy remains default NO_SOURCE
      const combined = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps({
          measureOutbox: hooks.measureOutbox,
        }),
        CTX,
      )
      expect(combined.countsProven).toBe(false)
      expect(combined.outbox.proven).toBe(true)
      expect(combined.legacy.proven).toBe(false)
      expect(combined.legacy.reasonCode).toBe('NO_SOURCE')
      const cols = toNullableCountColumns(combined)
      expect(cols.countsProven).toBe(false)
      expect(cols.outbox_pending).toBeNull()
      expect(cols.legacy_unreplayed).toBeNull()
      expect(cols.effective_backlog).toBeNull()
      // Never hybrid zero
      expect(cols.outbox_pending).not.toBe(0)
      expect(cols.effective_backlog).not.toBe(0)
    })
  })

  describe('T19 P1 combination / effective values / defaults NO_SOURCE', () => {
    it('proven path integers; unproven path nulls via toNullableCountColumns', async () => {
      const good = createScriptedClient({
        row: { outbox_pending: 1, legacy_unreplayed: 2 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(good.client)
      const proven = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps(hooks),
        CTX,
      )
      expect(proven.countsProven).toBe(true)
      expect(toNullableCountColumns(proven)).toEqual({
        outbox_pending: 1,
        legacy_unreplayed: 2,
        effective_backlog: 3,
        countsProven: true,
      })

      const bad = createScriptedClient({ throwError: missingTableError() })
      const badHooks = createCp0MysqlBacklogCountMeasurers(bad.client)
      const unproven = await measureCp0SyncStatusCounts(
        createDefaultCp0SyncStatusMeasureDeps(badHooks),
        CTX,
      )
      expect(unproven.countsProven).toBe(false)
      expect(toNullableCountColumns(unproven)).toEqual({
        outbox_pending: null,
        legacy_unreplayed: null,
        effective_backlog: null,
        countsProven: false,
      })
    })

    it('default deps without factory remain NO_SOURCE (no runtime enablement)', async () => {
      const deps = createDefaultCp0SyncStatusMeasureDeps()
      const combined = await measureCp0SyncStatusCounts(deps, CTX)
      expect(combined.outbox.reasonCode).toBe('NO_SOURCE')
      expect(combined.legacy.reasonCode).toBe('NO_SOURCE')
      expect(combined.countsProven).toBe(false)
      expect(toNullableCountColumns(combined).effective_backlog).toBeNull()
    })

    it('stable sanitized source ids on both sides', async () => {
      const { client } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox.source.id).toBe(CP0_BACKLOG_OUTBOX_SOURCE_ID)
      expect(snap.legacy.source.id).toBe(CP0_BACKLOG_LEGACY_SOURCE_ID)
      expect(snap.outbox.source.id).toMatch(/^[a-z0-9._:-]+$/)
      expect(snap.legacy.source.id).toMatch(/^[a-z0-9._:-]+$/)
    })

    it('string integer cells accepted (driver decimal-string path)', async () => {
      const { client } = createScriptedClient({
        row: { outbox_pending: '12', legacy_unreplayed: '0' },
      })
      const snap = await measureCp0BacklogCountsSnapshot(client, CTX)
      expect(snap.outbox).toMatchObject({ proven: true, value: 12 })
      expect(snap.legacy).toMatchObject({ proven: true, value: 0 })
    })
  })

  describe('query-level error coherence under factory', () => {
    it('both hooks fail coherently on missing table (single flight)', async () => {
      const { client, calls } = createScriptedClient({
        throwError: missingTableError(),
        delayMs: 5,
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const [o, l] = await Promise.all([
        hooks.measureOutbox(CTX),
        hooks.measureLegacy(CTX),
      ])
      expect(calls).toHaveLength(1)
      expect(o.reasonCode).toBe('SOURCE_UNAVAILABLE')
      expect(l.reasonCode).toBe('SOURCE_UNAVAILABLE')
      expect(o.value).toBeNull()
      expect(l.value).toBeNull()
    })
  })

  describe('P2 happy path with dual proven zeros still may IN_SYNC (control)', () => {
    it('stable pin + dual proven zeros from factory may publish IN_SYNC candidate', async () => {
      const { client, calls } = createScriptedClient({
        row: { outbox_pending: 0, legacy_unreplayed: 0 },
      })
      const hooks = createCp0MysqlBacklogCountMeasurers(client)
      const store = memoryCasStore()
      const result = await runCp0SyncStatusPublisherTick(
        BOARD,
        basePublisherDeps({
          measureDeps: createDefaultCp0SyncStatusMeasureDeps(hooks),
          loadExistingRow: store.loadExistingRow,
          casPublish: store.casPublish,
        }),
      )
      expect(calls).toHaveLength(1)
      expect(result.published).toBe(true)
      expect(result.rawStatus).toBe('IN_SYNC')
      expect(result.zeroBacklogClaimed).toBe(true)
      expect(store.writes).toHaveLength(1)
      expect(store.writes[0]!.outbox_pending).toBe(0)
      expect(store.writes[0]!.legacy_unreplayed).toBe(0)
      expect(store.writes[0]!.effective_backlog).toBe(0)
    })
  })
})
