/**
 * CP0 sync-status dual-count MySQL backlog sources (PACKET-P3C).
 *
 * Single-statement dual COUNT snapshot (outbox + legacy) behind a shared-closure
 * P1 inject factory. Both measureOutbox and measureLegacy single-flight one query
 * keyed by (boardId, nowMs) so Promise.all does not N+1 or split MVCC snapshots.
 *
 * Inject-only: no runtime/scheduler default, no db() import, no writers, no TX.
 * Never SELECTs denormalized control_plane_sync_status sink columns as source.
 * Missing tables / errors → unproven (never zero-coerced).
 */

import {
  countFromUnknown,
  sanitizeMeasureReason,
  unprovenCount,
  type Cp0CountMeasureResult,
  type Cp0MeasureContext,
  type Cp0SyncStatusMeasureDeps,
} from './cp0-sync-status-measures'

// ---------------------------------------------------------------------------
// Constants / SQL
// ---------------------------------------------------------------------------

/** Stable source id for outbox COUNT side (sanitized token). */
export const CP0_BACKLOG_OUTBOX_SOURCE_ID = 'cp0-sync-outbox' as const

/** Stable source id for legacy residual COUNT side (sanitized token). */
export const CP0_BACKLOG_LEGACY_SOURCE_ID = 'cp0-legacy-residuals' as const

const OUTBOX_SOURCE_LABEL = 'control_plane_sync_outbox status COUNT'
const LEGACY_SOURCE_LABEL = 'control_plane_legacy_residuals status COUNT'

/** Board id upper bound (matches VARCHAR(64) on source tables / P3A). */
export const CP0_BACKLOG_BOARD_ID_MAX = 64 as const

/**
 * One dual-COUNT statement = one coherent read snapshot.
 * Params: [boardId, boardId]. Status sets match migration 014.
 * ACKED/DEAD and REPLAYED/ABANDONED are intentionally excluded.
 */
export const CP0_BACKLOG_DUAL_COUNT_SQL = `
SELECT
  (SELECT COUNT(*)
     FROM control_plane_sync_outbox
    WHERE board_id = ?
      AND status IN ('PENDING','IN_FLIGHT','FAILED')) AS outbox_pending,
  (SELECT COUNT(*)
     FROM control_plane_legacy_residuals
    WHERE board_id = ?
      AND status IN ('UNREPLAYED','REPLAYING')) AS legacy_unreplayed
`.replace(/\s+/g, ' ').trim()

// ---------------------------------------------------------------------------
// Injectable SQL client (pool-level is enough; no TX / no borrowed conn)
// ---------------------------------------------------------------------------

/** Thin queryable — inject only; no default pool. */
export type Cp0BacklogCountSqlClient = {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<[unknown, unknown?]>
}

export type Cp0BacklogDualCountSnapshot = {
  outbox: Cp0CountMeasureResult
  legacy: Cp0CountMeasureResult
  /** Same ctx.nowMs used for both measuredAtMs. */
  measuredAtMs: number
  boardId: string
}

// ---------------------------------------------------------------------------
// Board id validation / error redaction
// ---------------------------------------------------------------------------

export function isValidCp0BacklogBoardId(boardId: unknown): boardId is string {
  if (typeof boardId !== 'string' || boardId.length === 0) return false
  if (boardId.length > CP0_BACKLOG_BOARD_ID_MAX) return false
  if (/[\u0000-\u001f\u007f]/.test(boardId)) return false
  return true
}

/** Detect missing-table driver errors (errno 1146 / ER_NO_SUCH_TABLE). */
export function isMysqlMissingTableError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as { errno?: unknown; code?: unknown; message?: unknown }
  if (e.errno === 1146) return true
  if (e.code === 'ER_NO_SUCH_TABLE') return true
  if (typeof e.message === 'string') {
    // Detection only — message never enters reason strings.
    if (
      /ER_NO_SUCH_TABLE/i.test(e.message) ||
      /doesn't exist/i.test(e.message) ||
      /Unknown table/i.test(e.message)
    ) {
      return true
    }
  }
  return false
}

/**
 * Redact driver errors to name + optional code/errno only.
 * Never includes message, SQL text, DSN, passwords, or row payloads.
 */
export function redactBacklogCountError(err: unknown): {
  name: string
  code?: string
  errno?: number
} {
  if (err instanceof Error) {
    const maybe = err as Error & { code?: unknown; errno?: unknown }
    const code =
      typeof maybe.code === 'string' ? maybe.code.slice(0, 64) : undefined
    const errno =
      typeof maybe.errno === 'number' && Number.isFinite(maybe.errno)
        ? maybe.errno
        : undefined
    return {
      name: (err.name || 'Error').slice(0, 64),
      ...(code !== undefined ? { code } : {}),
      ...(errno !== undefined ? { errno } : {}),
    }
  }
  return { name: 'non-error-throw' }
}

function redactedErrorDetail(err: unknown): string {
  const r = redactBacklogCountError(err)
  const parts = [r.name]
  if (r.code) parts.push(r.code)
  if (r.errno !== undefined) parts.push(`errno=${r.errno}`)
  return sanitizeMeasureReason(parts.join(' '), r.name)
}

function dualUnproven(
  boardId: string,
  measuredAtMs: number,
  reasonCode: 'SOURCE_UNAVAILABLE' | 'MEASURE_ERROR' | 'VALUE_MISSING',
  detail?: string,
): Cp0BacklogDualCountSnapshot {
  const reasonBase =
    reasonCode === 'SOURCE_UNAVAILABLE'
      ? 'count source unavailable; measure remains unproven'
      : reasonCode === 'VALUE_MISSING'
        ? 'count value missing or undefined; not coerced to zero'
        : 'measurer threw or failed; fail-closed unproven'
  const reason = sanitizeMeasureReason(
    detail ? `${reasonBase}: ${detail}` : reasonBase,
    reasonBase,
  )
  return {
    boardId: typeof boardId === 'string' ? boardId.slice(0, CP0_BACKLOG_BOARD_ID_MAX) : '',
    measuredAtMs,
    outbox: unprovenCount('outbox_pending', {
      sourceId: CP0_BACKLOG_OUTBOX_SOURCE_ID,
      measuredAtMs,
      reasonCode,
      reason,
      sourceLabel: OUTBOX_SOURCE_LABEL,
    }),
    legacy: unprovenCount('legacy_unreplayed', {
      sourceId: CP0_BACKLOG_LEGACY_SOURCE_ID,
      measuredAtMs,
      reasonCode,
      reason,
      sourceLabel: LEGACY_SOURCE_LABEL,
    }),
  }
}

function asRowArray(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return []
  const out: Array<Record<string, unknown>> = []
  for (const r of rows) {
    if (r != null && typeof r === 'object' && !Array.isArray(r)) {
      out.push(r as Record<string, unknown>)
    }
  }
  return out
}

function cellFromRow(
  row: Record<string, unknown> | undefined,
  key: string,
): unknown {
  if (!row) return undefined
  if (Object.prototype.hasOwnProperty.call(row, key)) return row[key]
  // Drivers sometimes return lowercase aliases only; keep exact key first.
  const lower = key.toLowerCase()
  for (const k of Object.keys(row)) {
    if (k.toLowerCase() === lower) return row[k]
  }
  return undefined
}

// ---------------------------------------------------------------------------
// Direct dual-COUNT measure
// ---------------------------------------------------------------------------

/**
 * Run one dual-COUNT statement and parse both sides with P1 parsers.
 * Fail-closed: missing tables / query errors / malformed cells never invent 0.
 */
export async function measureCp0BacklogCountsSnapshot(
  client: Cp0BacklogCountSqlClient,
  ctx: Cp0MeasureContext,
): Promise<Cp0BacklogDualCountSnapshot> {
  const measuredAtMs = ctx.nowMs
  const boardId = ctx.boardId

  if (!isValidCp0BacklogBoardId(boardId)) {
    return dualUnproven(
      typeof boardId === 'string' ? boardId : '',
      measuredAtMs,
      'MEASURE_ERROR',
      'board_id_invalid',
    )
  }

  if (
    !Number.isFinite(measuredAtMs) ||
    typeof client?.query !== 'function'
  ) {
    return dualUnproven(
      boardId,
      Number.isFinite(measuredAtMs) ? measuredAtMs : 0,
      'MEASURE_ERROR',
      'invalid_measure_context',
    )
  }

  let rowsUnknown: unknown
  try {
    const result = await client.query(CP0_BACKLOG_DUAL_COUNT_SQL, [
      boardId,
      boardId,
    ])
    rowsUnknown = Array.isArray(result) ? result[0] : undefined
  } catch (err) {
    if (isMysqlMissingTableError(err)) {
      return dualUnproven(
        boardId,
        measuredAtMs,
        'SOURCE_UNAVAILABLE',
        redactedErrorDetail(err),
      )
    }
    return dualUnproven(
      boardId,
      measuredAtMs,
      'MEASURE_ERROR',
      redactedErrorDetail(err),
    )
  }

  const rows = asRowArray(rowsUnknown)
  const row = rows[0]
  if (!row) {
    // Scalar subquery SELECT always yields one row when tables exist; empty
    // result is treated as missing cells (never proven zero).
    return dualUnproven(boardId, measuredAtMs, 'VALUE_MISSING', 'empty_result')
  }

  const outboxRaw = cellFromRow(row, 'outbox_pending')
  const legacyRaw = cellFromRow(row, 'legacy_unreplayed')

  const outbox = countFromUnknown('outbox_pending', outboxRaw, {
    sourceId: CP0_BACKLOG_OUTBOX_SOURCE_ID,
    measuredAtMs,
    sourceLabel: OUTBOX_SOURCE_LABEL,
  })
  const legacy = countFromUnknown('legacy_unreplayed', legacyRaw, {
    sourceId: CP0_BACKLOG_LEGACY_SOURCE_ID,
    measuredAtMs,
    sourceLabel: LEGACY_SOURCE_LABEL,
  })

  return {
    boardId,
    measuredAtMs,
    outbox,
    legacy,
  }
}

// ---------------------------------------------------------------------------
// Shared-closure P1 inject factory (single-flight per boardId+nowMs)
// ---------------------------------------------------------------------------

function flightKey(ctx: Cp0MeasureContext): string {
  // Delimiter cannot appear in validated board ids (control chars rejected).
  return `${String(ctx.boardId)}\0${String(ctx.nowMs)}`
}

/**
 * Implements both P1 inject hooks with single-flight shared snapshot per
 * (boardId, nowMs). Safe under measureCp0SyncStatusCounts Promise.all.
 *
 * Cache is per factory instance and only retains the latest key/promise so
 * concurrent and sequential same-tick access share one query. A different
 * boardId or nowMs starts a new query (no multi-tick indefinite memo).
 */
export function createCp0MysqlBacklogCountMeasurers(
  client: Cp0BacklogCountSqlClient,
): Pick<Cp0SyncStatusMeasureDeps, 'measureOutbox' | 'measureLegacy'> {
  let latestKey: string | null = null
  let latestPromise: Promise<Cp0BacklogDualCountSnapshot> | null = null

  function getSnapshot(
    ctx: Cp0MeasureContext,
  ): Promise<Cp0BacklogDualCountSnapshot> {
    const key = flightKey(ctx)
    if (latestPromise && latestKey === key) {
      return latestPromise
    }
    const started = measureCp0BacklogCountsSnapshot(client, ctx)
    latestKey = key
    latestPromise = started
    return started
  }

  return {
    measureOutbox: async (ctx) => {
      const snap = await getSnapshot(ctx)
      return snap.outbox
    },
    measureLegacy: async (ctx) => {
      const snap = await getSnapshot(ctx)
      return snap.legacy
    },
  }
}
