/**
 * MySQL ControlPlaneAtomicStore — durable board revision, dispatch-block, and
 * immutable material audit for the control plane.
 *
 * Backed by:
 *   - board_revisions (board_rev, dispatch_blocked, dispatch_blocked_reason) — 001+004
 *   - audit_log (material control-plane events) — 000 baseline
 *
 * No board-mcp wiring. Injectable SqlExecutor; unit tests use createMemoryAtomicSqlExecutor.
 * Named-lock multi-process path requires useNamedLock:true + getConnection (same F2 contract).
 */
import { randomUUID } from 'node:crypto'

import type {
  ControlPlaneAtomicStore,
  ControlPlaneAuditEvent,
  ControlPlaneAuditKind,
  ControlPlaneBoardState,
} from './board-store'
import {
  withMysqlNamedLock,
  type SqlExecuteResult,
  type SqlExecutor,
} from './control-plane-runtime-persistence'

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ControlPlaneAtomicErrorCode =
  | 'STALE_REVISION'
  | 'INVALID_INPUT'
  | 'DATA_INTEGRITY'
  | 'IMMUTABLE_AUDIT'
  | 'NOT_FOUND'

export class ControlPlaneAtomicError extends Error {
  readonly code: ControlPlaneAtomicErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: ControlPlaneAtomicErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ControlPlaneAtomicError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// SQL constants
// ---------------------------------------------------------------------------

export const ATOMIC_SQL = {
  getBoardState: `
    SELECT board_id, board_rev, dispatch_blocked, dispatch_blocked_reason
    FROM board_revisions
    WHERE board_id=? LIMIT 1
  `,
  ensureBoardRow: `
    INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, dispatch_blocked, dispatch_blocked_reason)
    VALUES (?, 0, 0, 0, NULL)
    ON DUPLICATE KEY UPDATE board_id=board_id
  `,
  /** Optimistic CAS: only write when observed board_rev still matches. */
  casSetBoardState: `
    UPDATE board_revisions
    SET board_rev=?, dispatch_blocked=?, dispatch_blocked_reason=?
    WHERE board_id=? AND board_rev=?
  `,
  insertBoardState: `
    INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, dispatch_blocked, dispatch_blocked_reason)
    VALUES (?, ?, 0, ?, ?)
  `,
  bumpBoardRev: `
    UPDATE board_revisions SET board_rev = board_rev + 1 WHERE board_id=?
  `,
  /** CAS bump: only succeed when current rev equals expected. */
  casBumpBoardRev: `
    UPDATE board_revisions SET board_rev = board_rev + 1
    WHERE board_id=? AND board_rev=?
  `,
  getBoardRev: `SELECT board_rev FROM board_revisions WHERE board_id=? LIMIT 1`,
  appendAudit: `
    INSERT INTO audit_log (board_id, ts, actor, action, task_id, from_stage, to_stage, detail)
    VALUES (?,?,?,?,?,?,?,?)
  `,
  listAudit: `
    SELECT id, board_id, ts, actor, action, task_id, from_stage, to_stage, detail
    FROM audit_log
    WHERE board_id=?
    ORDER BY id ASC
  `,
  findAuditByEventId: `
    SELECT id, board_id, ts, actor, action, task_id, from_stage, to_stage, detail
    FROM audit_log
    WHERE board_id=? AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.eventId'))=?
    LIMIT 1
  `,
} as const

const CONTROL_PLANE_AUDIT_KINDS = new Set<string>([
  'PLAN_PUBLISHED',
  'PLAN_SUPERSEDED',
  'RUN_REGISTERED',
  'RUN_FIRST_LIVE',
  'RUN_MATERIAL_PROGRESS',
  'RUN_STALLED',
  'RUN_RECOVERED',
  'RUN_FENCED',
  'RUN_SUPERSEDED',
  'RUN_TERMINAL',
  'LOCK_ACQUIRED',
  'LOCK_RELEASED',
  'LOCK_SUPERSEDED',
  'ACCOUNT_SYNC',
  'ACCOUNT_SYNC_STALE',
  'DECISION_OPENED',
  'DECISION_RESOLVED',
  'DECISION_REJECTED',
  'DECISION_SNOOZED',
  'RECONCILER_DRY_RUN',
  'RECONCILER_APPLY',
  'POLICY_CHANGE',
])

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return fallback
}

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  return String(v)
}

function asBool(v: unknown): boolean {
  if (typeof v === 'boolean') return v
  if (typeof v === 'number') return v !== 0
  if (typeof v === 'bigint') return v !== 0n
  if (typeof v === 'string') return v === '1' || v.toLowerCase() === 'true'
  return false
}

function parseJsonCell(value: unknown): Record<string, unknown> {
  if (value == null) return {}
  if (typeof value === 'object' && !Array.isArray(value) && !(value instanceof Buffer)) {
    return value as Record<string, unknown>
  }
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8')) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t === 'null') return {}
    try {
      return JSON.parse(t) as Record<string, unknown>
    } catch {
      return {}
    }
  }
  return {}
}

function defaultBoardState(boardId: string): ControlPlaneBoardState {
  return {
    boardId,
    boardRev: 0,
    dispatchBlocked: false,
    dispatchBlockedReason: null,
  }
}

function rowToBoardState(row: Record<string, unknown>): ControlPlaneBoardState {
  return {
    boardId: asString(row.board_id),
    boardRev: asNumber(row.board_rev, 0),
    dispatchBlocked: asBool(row.dispatch_blocked),
    dispatchBlockedReason:
      row.dispatch_blocked_reason == null || row.dispatch_blocked_reason === ''
        ? null
        : asString(row.dispatch_blocked_reason),
  }
}

function rowToAuditEvent(row: Record<string, unknown>): ControlPlaneAuditEvent | null {
  const kind = asString(row.action)
  if (!CONTROL_PLANE_AUDIT_KINDS.has(kind)) return null
  const detailBag = parseJsonCell(row.detail)
  const eventId =
    detailBag.eventId != null
      ? asString(detailBag.eventId)
      : `aud-sql-${asString(row.id)}`
  const atMs =
    typeof detailBag.atMs === 'number' && Number.isFinite(detailBag.atMs)
      ? detailBag.atMs
      : Date.parse(asString(row.ts)) || 0
  const subjectType =
    detailBag.subjectType != null
      ? asString(detailBag.subjectType)
      : asString(row.from_stage, 'unknown')
  const subjectId =
    detailBag.subjectId != null ? asString(detailBag.subjectId) : asString(row.task_id)
  // Strip envelope fields from detail surface
  const {
    eventId: _e,
    atMs: _a,
    material: _m,
    subjectType: _st,
    subjectId: _si,
    ...rest
  } = detailBag
  void _e
  void _a
  void _m
  void _st
  void _si
  return {
    eventId,
    boardId: asString(row.board_id),
    kind: kind as ControlPlaneAuditKind,
    atMs,
    atISO: asString(row.ts),
    actorId: row.actor == null ? null : asString(row.actor),
    subjectType,
    subjectId,
    detail: rest,
    material: true,
  }
}

function auditPayloadHash(ev: {
  kind: string
  atMs: number
  atISO: string
  actorId: string | null
  subjectType: string
  subjectId: string
  detail: Record<string, unknown>
}): string {
  return JSON.stringify({
    kind: ev.kind,
    atMs: ev.atMs,
    atISO: ev.atISO,
    actorId: ev.actorId,
    subjectType: ev.subjectType,
    subjectId: ev.subjectId,
    detail: ev.detail,
  })
}

function createBoardLockChain() {
  const chains = new Map<string, Promise<unknown>>()
  return async function withBoardLock<T>(boardId: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = chains.get(boardId) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((r) => {
      release = r
    })
    chains.set(
      boardId,
      prev.then(() => gate),
    )
    await prev
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export interface MysqlControlPlaneAtomicOptions {
  /**
   * Multi-process named lock (GET_LOCK on pinned connection).
   * Required true for production MySQL factory path used by runtime context.
   */
  useNamedLock?: boolean
}

/**
 * MySQL-backed ControlPlaneAtomicStore.
 * - Board rev: monotonic bump + optimistic CAS on setBoardState
 * - Dispatch block: durable on board_revisions
 * - Audit: insert-only immutable rows in audit_log (board-scoped)
 */
export function createMysqlControlPlaneAtomicStore(
  exec: SqlExecutor,
  opts?: MysqlControlPlaneAtomicOptions,
): ControlPlaneAtomicStore & {
  /** CAS bump: returns new rev or throws STALE_REVISION when expected mismatches. */
  casBumpBoardRev(boardId: string, expectedBoardRev: number): Promise<number>
} {
  if (opts?.useNamedLock === true && typeof exec.getConnection !== 'function') {
    throw new ControlPlaneAtomicError(
      'INVALID_INPUT',
      'createMysqlControlPlaneAtomicStore with useNamedLock:true requires SqlExecutor.getConnection()',
      {},
    )
  }

  const chainLock = createBoardLockChain()
  const withLock = <T>(boardId: string, fn: () => Promise<T> | T): Promise<T> =>
    opts?.useNamedLock ? withMysqlNamedLock(exec, `at_${boardId}`, fn) : chainLock(boardId, fn)

  async function readBoard(boardId: string): Promise<ControlPlaneBoardState> {
    if (!boardId || typeof boardId !== 'string') {
      throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardId required', { boardId })
    }
    const res = await exec.execute<Record<string, unknown>>(ATOMIC_SQL.getBoardState, [boardId])
    const row = res.rows[0]
    if (!row) return defaultBoardState(boardId)
    return rowToBoardState(row)
  }

  async function ensureBoard(boardId: string): Promise<void> {
    await exec.execute(ATOMIC_SQL.ensureBoardRow, [boardId])
  }

  const store: ControlPlaneAtomicStore & {
    casBumpBoardRev(boardId: string, expectedBoardRev: number): Promise<number>
  } = {
    async getBoardState(boardId) {
      return readBoard(boardId)
    },

    async setBoardState(state) {
      if (!state?.boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'setBoardState requires boardId', {})
      }
      if (!Number.isFinite(state.boardRev) || state.boardRev < 0) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardRev must be a non-negative finite number', {
          boardRev: state.boardRev,
        })
      }
      return withLock(state.boardId, async () => {
        const current = await readBoard(state.boardId)
        // Never allow board_rev to move backwards (stale writer).
        if (state.boardRev < current.boardRev) {
          throw new ControlPlaneAtomicError(
            'STALE_REVISION',
            `setBoardState boardRev ${state.boardRev} < current ${current.boardRev}`,
            {
              boardId: state.boardId,
              expectedMinBoardRev: current.boardRev,
              attemptedBoardRev: state.boardRev,
            },
          )
        }

        const blocked = state.dispatchBlocked ? 1 : 0
        const reason = state.dispatchBlockedReason

        if (current.boardRev === 0 && !(await boardRowExists(exec, state.boardId))) {
          // Fresh insert (no prior row). CAS not needed.
          await exec.execute(ATOMIC_SQL.insertBoardState, [
            state.boardId,
            state.boardRev,
            blocked,
            reason,
          ])
          return
        }

        // Optimistic CAS on the observed board_rev.
        const cas = await exec.execute(ATOMIC_SQL.casSetBoardState, [
          state.boardRev,
          blocked,
          reason,
          state.boardId,
          current.boardRev,
        ])
        if (cas.affectedRows !== 1) {
          const latest = await readBoard(state.boardId)
          throw new ControlPlaneAtomicError(
            'STALE_REVISION',
            'setBoardState lost CAS race on board_rev',
            {
              boardId: state.boardId,
              observedBoardRev: current.boardRev,
              attemptedBoardRev: state.boardRev,
              currentBoardRev: latest.boardRev,
            },
          )
        }
      })
    },

    async bumpBoardRev(boardId) {
      if (!boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardId required', { boardId })
      }
      return withLock(boardId, async () => {
        await ensureBoard(boardId)
        const bump = await exec.execute(ATOMIC_SQL.bumpBoardRev, [boardId])
        if (bump.affectedRows !== 1) {
          throw new ControlPlaneAtomicError('DATA_INTEGRITY', 'bumpBoardRev failed to update row', {
            boardId,
          })
        }
        const revRes = await exec.execute<{ board_rev: number }>(ATOMIC_SQL.getBoardRev, [boardId])
        return asNumber(revRes.rows[0]?.board_rev, 0)
      })
    },

    async casBumpBoardRev(boardId, expectedBoardRev) {
      if (!boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardId required', { boardId })
      }
      if (!Number.isFinite(expectedBoardRev) || expectedBoardRev < 0) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'expectedBoardRev must be non-negative', {
          expectedBoardRev,
        })
      }
      return withLock(boardId, async () => {
        await ensureBoard(boardId)
        // After ensure, brand-new rows start at 0; CAS against expected.
        const cas = await exec.execute(ATOMIC_SQL.casBumpBoardRev, [boardId, expectedBoardRev])
        if (cas.affectedRows !== 1) {
          const cur = await readBoard(boardId)
          throw new ControlPlaneAtomicError(
            'STALE_REVISION',
            `casBumpBoardRev expected ${expectedBoardRev} != current ${cur.boardRev}`,
            {
              boardId,
              expectedBoardRev,
              currentBoardRev: cur.boardRev,
            },
          )
        }
        const revRes = await exec.execute<{ board_rev: number }>(ATOMIC_SQL.getBoardRev, [boardId])
        return asNumber(revRes.rows[0]?.board_rev, 0)
      })
    },

    async appendAudit(ev) {
      if (!ev?.boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'appendAudit requires boardId', {})
      }
      if (!ev.kind || !CONTROL_PLANE_AUDIT_KINDS.has(ev.kind)) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'appendAudit requires valid kind', {
          kind: ev.kind,
        })
      }
      if (ev.material !== true && ev.material !== undefined) {
        throw new ControlPlaneAtomicError(
          'INVALID_INPUT',
          'control-plane audit events must be material:true',
          { material: ev.material },
        )
      }

      const eventId = ev.eventId ?? `aud-${randomUUID()}`
      const detailEnvelope = {
        ...(ev.detail ?? {}),
        eventId,
        atMs: ev.atMs,
        material: true as const,
        subjectType: ev.subjectType,
        subjectId: ev.subjectId,
      }

      return withLock(ev.boardId, async () => {
        // Immutable: same eventId must not rewrite with different payload.
        const existing = await exec.execute<Record<string, unknown>>(ATOMIC_SQL.findAuditByEventId, [
          ev.boardId,
          eventId,
        ])
        if (existing.rows[0]) {
          const prev = rowToAuditEvent(existing.rows[0])
          if (!prev) {
            throw new ControlPlaneAtomicError('DATA_INTEGRITY', 'corrupt audit row for eventId', {
              eventId,
              boardId: ev.boardId,
            })
          }
          const nextHash = auditPayloadHash({
            kind: ev.kind,
            atMs: ev.atMs,
            atISO: ev.atISO,
            actorId: ev.actorId,
            subjectType: ev.subjectType,
            subjectId: ev.subjectId,
            detail: ev.detail ?? {},
          })
          const prevHash = auditPayloadHash({
            kind: prev.kind,
            atMs: prev.atMs,
            atISO: prev.atISO,
            actorId: prev.actorId,
            subjectType: prev.subjectType,
            subjectId: prev.subjectId,
            detail: prev.detail,
          })
          if (nextHash === prevHash) {
            return prev
          }
          throw new ControlPlaneAtomicError(
            'IMMUTABLE_AUDIT',
            'appendAudit refused rewrite of existing eventId with different payload',
            { boardId: ev.boardId, eventId },
          )
        }

        await exec.execute(ATOMIC_SQL.appendAudit, [
          ev.boardId,
          ev.atISO,
          ev.actorId,
          ev.kind,
          ev.subjectId,
          ev.subjectType,
          null,
          JSON.stringify(detailEnvelope),
        ])

        return {
          eventId,
          boardId: ev.boardId,
          kind: ev.kind,
          atMs: ev.atMs,
          atISO: ev.atISO,
          actorId: ev.actorId,
          subjectType: ev.subjectType,
          subjectId: ev.subjectId,
          detail: { ...(ev.detail ?? {}) },
          material: true as const,
        }
      })
    },

    async listAudit(boardId) {
      if (!boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardId required', { boardId })
      }
      const res = await exec.execute<Record<string, unknown>>(ATOMIC_SQL.listAudit, [boardId])
      const out: Array<ControlPlaneAuditEvent> = []
      for (const row of res.rows) {
        // Board isolation: SQL already filters board_id; re-check.
        if (asString(row.board_id) !== boardId) continue
        const ev = rowToAuditEvent(row)
        if (ev) out.push(ev)
      }
      return out
    },

    async withBoardLock(boardId, fn) {
      if (!boardId) {
        throw new ControlPlaneAtomicError('INVALID_INPUT', 'boardId required', { boardId })
      }
      return withLock(boardId, fn)
    },
  }

  return store
}

async function boardRowExists(exec: SqlExecutor, boardId: string): Promise<boolean> {
  const res = await exec.execute(ATOMIC_SQL.getBoardState, [boardId])
  return res.rows.length > 0
}

/**
 * Production-oriented factory: named locks required (multi-process safe).
 */
export function createMysqlControlPlaneAtomicStoreStrict(
  exec: SqlExecutor,
): ControlPlaneAtomicStore & {
  casBumpBoardRev(boardId: string, expectedBoardRev: number): Promise<number>
} {
  if (typeof exec.getConnection !== 'function') {
    throw new ControlPlaneAtomicError(
      'INVALID_INPUT',
      'createMysqlControlPlaneAtomicStoreStrict requires SqlExecutor.getConnection()',
      {},
    )
  }
  return createMysqlControlPlaneAtomicStore(exec, { useNamedLock: true })
}

// ---------------------------------------------------------------------------
// In-memory SQL executor for unit tests (board_revisions + audit_log + locks)
// ---------------------------------------------------------------------------

type MemBoardRow = {
  board_id: string
  board_rev: number
  lifecycle_rev: number
  dispatch_blocked: number
  dispatch_blocked_reason: string | null
}

type MemAuditRow = {
  id: number
  board_id: string
  ts: string
  actor: string | null
  action: string
  task_id: string | null
  from_stage: string | null
  to_stage: string | null
  detail: string
}

/**
 * Minimal memory SQL covering statements issued by this module.
 * Supports restart tests: tables live on the returned object; multiple store
 * instances sharing the same executor see the same durable state.
 */
export function createMemoryAtomicSqlExecutor(): SqlExecutor & {
  boards: Map<string, MemBoardRow>
  audits: Array<MemAuditRow>
  reset(): void
  calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }>
} {
  const boards = new Map<string, MemBoardRow>()
  const audits: Array<MemAuditRow> = []
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }> = []
  const heldNamedLocks = new Map<string, string>()
  let auditSeq = 0
  let connSeq = 0
  const POOL_ID = 'atomic-memory-pool'

  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  const executeOn = async <T = Record<string, unknown>>(
    sql: string,
    params: ReadonlyArray<unknown> = [],
    connectionId: string = POOL_ID,
  ): Promise<SqlExecuteResult<T>> => {
    const s = normalize(sql)
    const p = [...params]
    calls.push({ sql: s, params: p, connectionId })

    if (/^SELECT GET_LOCK/i.test(s)) {
      const name = String(p[0])
      const holder = heldNamedLocks.get(name)
      if (holder && holder !== connectionId) {
        return { rows: [{ l: 0 }] as Array<T>, affectedRows: 0 }
      }
      heldNamedLocks.set(name, connectionId)
      return { rows: [{ l: 1 }] as Array<T>, affectedRows: 1 }
    }
    if (/^SELECT RELEASE_LOCK/i.test(s)) {
      const name = String(p[0])
      if (heldNamedLocks.get(name) === connectionId) heldNamedLocks.delete(name)
      return { rows: [{ r: 1 }] as Array<T>, affectedRows: 1 }
    }

    if (/SELECT board_id, board_rev, dispatch_blocked, dispatch_blocked_reason FROM board_revisions WHERE board_id=\? LIMIT 1/i.test(s)) {
      const row = boards.get(String(p[0]))
      return { rows: (row ? [row] : []) as Array<T>, affectedRows: row ? 1 : 0 }
    }

    if (/SELECT board_rev FROM board_revisions WHERE board_id=\? LIMIT 1/i.test(s)) {
      const row = boards.get(String(p[0]))
      return {
        rows: (row ? [{ board_rev: row.board_rev }] : []) as Array<T>,
        affectedRows: row ? 1 : 0,
      }
    }

    if (/INSERT INTO board_revisions \(board_id, board_rev, lifecycle_rev, dispatch_blocked, dispatch_blocked_reason\) VALUES \(\?, 0, 0, 0, NULL\) ON DUPLICATE KEY UPDATE board_id=board_id/i.test(s)) {
      const boardId = String(p[0])
      if (!boards.has(boardId)) {
        boards.set(boardId, {
          board_id: boardId,
          board_rev: 0,
          lifecycle_rev: 0,
          dispatch_blocked: 0,
          dispatch_blocked_reason: null,
        })
        return { rows: [] as Array<T>, affectedRows: 1 }
      }
      return { rows: [] as Array<T>, affectedRows: 0 }
    }

    if (/INSERT INTO board_revisions \(board_id, board_rev, lifecycle_rev, dispatch_blocked, dispatch_blocked_reason\) VALUES \(\?, \?, 0, \?, \?\)/i.test(s) && !/ON DUPLICATE/i.test(s)) {
      const boardId = String(p[0])
      if (boards.has(boardId)) {
        throw new Error(`Duplicate entry '${boardId}' for key 'PRIMARY'`)
      }
      boards.set(boardId, {
        board_id: boardId,
        board_rev: asNumber(p[1], 0),
        lifecycle_rev: 0,
        dispatch_blocked: asNumber(p[2], 0) ? 1 : 0,
        dispatch_blocked_reason: p[3] == null ? null : String(p[3]),
      })
      return { rows: [] as Array<T>, affectedRows: 1 }
    }

    if (/UPDATE board_revisions SET board_rev=\?, dispatch_blocked=\?, dispatch_blocked_reason=\? WHERE board_id=\? AND board_rev=\?/i.test(s)) {
      const boardId = String(p[3])
      const expected = asNumber(p[4], -1)
      const row = boards.get(boardId)
      if (!row || row.board_rev !== expected) {
        return { rows: [] as Array<T>, affectedRows: 0 }
      }
      row.board_rev = asNumber(p[0], row.board_rev)
      row.dispatch_blocked = asNumber(p[1], 0) ? 1 : 0
      row.dispatch_blocked_reason = p[2] == null ? null : String(p[2])
      return { rows: [] as Array<T>, affectedRows: 1 }
    }

    if (/UPDATE board_revisions SET board_rev = board_rev \+ 1 WHERE board_id=\? AND board_rev=\?/i.test(s)) {
      const boardId = String(p[0])
      const expected = asNumber(p[1], -1)
      const row = boards.get(boardId)
      if (!row || row.board_rev !== expected) {
        return { rows: [] as Array<T>, affectedRows: 0 }
      }
      row.board_rev += 1
      return { rows: [] as Array<T>, affectedRows: 1 }
    }

    if (/UPDATE board_revisions SET board_rev = board_rev \+ 1 WHERE board_id=\?/i.test(s)) {
      const boardId = String(p[0])
      const row = boards.get(boardId)
      if (!row) return { rows: [] as Array<T>, affectedRows: 0 }
      row.board_rev += 1
      return { rows: [] as Array<T>, affectedRows: 1 }
    }

    if (/INSERT INTO audit_log \(board_id, ts, actor, action, task_id, from_stage, to_stage, detail\) VALUES/i.test(s)) {
      auditSeq += 1
      audits.push({
        id: auditSeq,
        board_id: String(p[0]),
        ts: String(p[1]),
        actor: p[2] == null ? null : String(p[2]),
        action: String(p[3]),
        task_id: p[4] == null ? null : String(p[4]),
        from_stage: p[5] == null ? null : String(p[5]),
        to_stage: p[6] == null ? null : String(p[6]),
        detail: typeof p[7] === 'string' ? p[7] : JSON.stringify(p[7] ?? null),
      })
      return { rows: [] as Array<T>, affectedRows: 1 }
    }

    if (/SELECT id, board_id, ts, actor, action, task_id, from_stage, to_stage, detail FROM audit_log WHERE board_id=\? ORDER BY id ASC/i.test(s)) {
      const boardId = String(p[0])
      const rows = audits.filter((a) => a.board_id === boardId)
      return { rows: rows as unknown as Array<T>, affectedRows: rows.length }
    }

    if (/SELECT id, board_id, ts, actor, action, task_id, from_stage, to_stage, detail FROM audit_log WHERE board_id=\? AND JSON_UNQUOTE\(JSON_EXTRACT\(detail, '\$\.eventId'\)\)=\? LIMIT 1/i.test(s)) {
      const boardId = String(p[0])
      const eventId = String(p[1])
      const row = audits.find((a) => {
        if (a.board_id !== boardId) return false
        const d = parseJsonCell(a.detail)
        return asString(d.eventId) === eventId
      })
      return { rows: (row ? [row] : []) as unknown as Array<T>, affectedRows: row ? 1 : 0 }
    }

    throw new Error(`createMemoryAtomicSqlExecutor: unsupported SQL: ${s.slice(0, 160)}`)
  }

  const exec: SqlExecutor & {
    boards: Map<string, MemBoardRow>
    audits: Array<MemAuditRow>
    reset(): void
    calls: typeof calls
  } = {
    boards,
    audits,
    calls,
    reset() {
      boards.clear()
      audits.length = 0
      calls.length = 0
      heldNamedLocks.clear()
      auditSeq = 0
    },
    execute: (sql, params) => executeOn(sql, params, POOL_ID),
    async getConnection() {
      const connectionId = `atomic-conn-${++connSeq}`
      return {
        connectionId,
        execute: <T = Record<string, unknown>>(sql: string, params?: ReadonlyArray<unknown>) =>
          executeOn<T>(sql, params ?? [], connectionId),
        release() {
          /* no-op */
        },
      }
    },
  }

  return exec
}
