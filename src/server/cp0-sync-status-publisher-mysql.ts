/**
 * CP0 sync-status publisher MySQL dependency adapter (PACKET-P3A).
 *
 * Injectable factory that implements P2 publisher deps against migration 008
 * (`control_plane_sync_status`) + `board_revisions` pin SSOT, using connection-
 * pinned GET_LOCK/RELEASE_LOCK (same contract as control-data / runtime named
 * locks). Pure adapter: no scheduler, no default background loop, no real
 * pool/db() default, no count measurers, no health/MCP wiring.
 *
 * P3B wires this into runtime/scheduler with a real pool client.
 */

import { createHash } from 'node:crypto'

import type { Cp0SyncStatusPin } from './cp0-sync-status'
import {
  isCompleteCp0Pin,
  type Cp0PublisherCasOutcome,
  type Cp0PublisherLockHandle,
  type Cp0PublisherRawStatus,
  type Cp0SyncStatusExistingRow,
  type Cp0SyncStatusPublishCandidate,
  type Cp0SyncStatusPublisherDeps,
} from './cp0-sync-status-publisher'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** MySQL GET_LOCK name maximum length. */
export const CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX = 64 as const

/** Lock name prefix (board-scoped publisher fence). */
export const CP0_PUBLISHER_MYSQL_LOCK_PREFIX = 'tm:cp0-sync-status:' as const

/**
 * Default GET_LOCK wait seconds. Non-blocking (0): multi-instance losers skip
 * the tick immediately rather than queue behind a long hold.
 */
export const CP0_PUBLISHER_MYSQL_DEFAULT_LOCK_TIMEOUT_SEC = 0 as const

/** Bound for canonical_hash / board id fragments accepted from SQL. */
export const CP0_PUBLISHER_MYSQL_HASH_MAX_LEN = 64 as const

/** Bound for serialized record_json payload (bytes of UTF-8 JSON text). */
export const CP0_PUBLISHER_MYSQL_RECORD_JSON_MAX_BYTES = 8192 as const

/** Allowed raw status tokens persisted by this adapter. */
const ALLOWED_RAW_STATUS = new Set<Cp0PublisherRawStatus>([
  'IN_SYNC',
  'READBACK_REQUIRED',
])

const SELECT_PIN_SQL =
  'SELECT board_rev, lifecycle_rev, canonical_hash FROM board_revisions WHERE board_id=? LIMIT 1'

const SELECT_SYNC_ROW_SQL =
  `SELECT board_id, status, outbox_pending, legacy_unreplayed, effective_backlog,
          board_rev, lifecycle_rev, canonical_hash, last_ack_revision,
          freshness_at, entity_rev
     FROM control_plane_sync_status
    WHERE board_id=?
    LIMIT 1`

const INSERT_SYNC_SQL =
  `INSERT INTO control_plane_sync_status (
     board_id, status, outbox_pending, legacy_unreplayed, effective_backlog,
     board_rev, lifecycle_rev, canonical_hash, last_ack_revision,
     freshness_at, entity_rev, record_json
   ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`

const UPDATE_SYNC_CAS_SQL =
  `UPDATE control_plane_sync_status SET
     status=?, outbox_pending=?, legacy_unreplayed=?, effective_backlog=?,
     board_rev=?, lifecycle_rev=?, canonical_hash=?, last_ack_revision=?,
     freshness_at=?, entity_rev=?, record_json=?
   WHERE board_id=? AND entity_rev=?`

// ---------------------------------------------------------------------------
// Injectable SQL client (no default pool; tests script fakes)
// ---------------------------------------------------------------------------

export type Cp0PublisherMysqlQueryResult = [rows: unknown, fields?: unknown]

/** Minimal pinned connection: query + release back to pool. */
export interface Cp0PublisherMysqlConnection {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<Cp0PublisherMysqlQueryResult>
  release(): void
}

/**
 * Pool-like client. Must expose getConnection so GET_LOCK and RELEASE_LOCK
 * share one physical connection for the lock hold duration.
 */
export interface Cp0PublisherMysqlClient {
  query(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<Cp0PublisherMysqlQueryResult>
  getConnection(): Promise<Cp0PublisherMysqlConnection>
}

export type Cp0PublisherMysqlAdapterOptions = {
  /** GET_LOCK wait timeout in seconds (default 0 = non-blocking). */
  lockTimeoutSec?: number
}

// ---------------------------------------------------------------------------
// Errors (bounded codes; never secret-bearing messages)
// ---------------------------------------------------------------------------

export type Cp0PublisherMysqlErrorCode =
  | 'INVALID_INPUT'
  | 'DATA_INTEGRITY'
  | 'DRIVER_MALFORMED'
  | 'LOCK_ERROR'
  | 'CAS_CONFLICT'
  | 'PUBLISH_ERROR'

export class Cp0PublisherMysqlError extends Error {
  readonly code: Cp0PublisherMysqlErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: Cp0PublisherMysqlErrorCode,
    /** Short, non-secret diagnostic (no SQL text, credentials, or row payloads). */
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'Cp0PublisherMysqlError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Lock name (bounded + injection-safe; always parameterized at call site)
// ---------------------------------------------------------------------------

/**
 * Build a MySQL GET_LOCK name for a board-scoped publisher fence.
 * - Always ≤ 64 chars.
 * - Safe charset only (no quotes/semicolons/whitespace from boardId).
 * - Long or unsafe board ids collapse to a stable SHA-256 fragment so two
 *   distinct ids never truncate-collide on the same prefix.
 */
export function buildCp0PublisherLockName(boardId: string): string {
  const raw = typeof boardId === 'string' ? boardId : ''
  const prefix = CP0_PUBLISHER_MYSQL_LOCK_PREFIX
  const budget = CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX - prefix.length
  // Allow only lock-name-safe characters (no injection metacharacters).
  const safe = raw.replace(/[^A-Za-z0-9._:-]/g, '')
  if (safe.length > 0 && safe.length <= budget && safe === raw) {
    return prefix + safe
  }
  // Hash path: original raw bytes (incl. unsafe chars) → fixed fragment.
  const digest = createHash('sha256')
    .update('tm:cp0-sync-status-lock:v1\0')
    .update(raw)
    .digest('hex')
    .slice(0, Math.min(40, budget))
  return (prefix + digest).slice(0, CP0_PUBLISHER_MYSQL_LOCK_NAME_MAX)
}

// ---------------------------------------------------------------------------
// Parsing helpers (fail-closed; never invent zeros)
// ---------------------------------------------------------------------------

function asRowArray(rows: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(rows)) return []
  return rows.filter(
    (r): r is Record<string, unknown> =>
      r != null && typeof r === 'object' && !Array.isArray(r),
  )
}

/**
 * Coerce a driver lock cell to a numeric scalar without boolean/string success paths.
 * Accepts only:
 *   - number (finite; real mysql2 GET_LOCK/RELEASE_LOCK returns 0/1/null as number)
 *   - bigint (only when driver surfaces 0n/1n — never boolean true / "1")
 * Rejects boolean, string, and other coercible garbage (D4).
 */
function lockCellToScalar(value: unknown): number | null {
  if (value === null || value === undefined) return null
  if (typeof value === 'boolean') return null
  if (typeof value === 'string') return null
  if (typeof value === 'number') {
    return Number.isFinite(value) ? value : null
  }
  if (typeof value === 'bigint') {
    // mysql2 may return BIGINT as bigint depending on config; only safe-range.
    if (value > BigInt(Number.MAX_SAFE_INTEGER) || value < BigInt(Number.MIN_SAFE_INTEGER)) {
      return null
    }
    return Number(value)
  }
  return null
}

/** Read GET_LOCK / RELEASE_LOCK scalar from a single-row result. */
export function readMysqlLockScalar(
  rows: unknown,
  aliases: ReadonlyArray<string> = ['l', 'r'],
): number | null {
  const row = asRowArray(rows)[0]
  if (!row) return null
  for (const a of aliases) {
    if (a in row && row[a] != null) {
      return lockCellToScalar(row[a])
    }
  }
  for (const key of Object.keys(row)) {
    if (/GET_LOCK|RELEASE_LOCK/i.test(key) && row[key] != null) {
      return lockCellToScalar(row[key])
    }
  }
  const vals = Object.values(row)
  if (vals.length === 1 && vals[0] != null) {
    return lockCellToScalar(vals[0])
  }
  return null
}

/**
 * Lock held only when the scalar is actual numeric 1 (or bigint 1 → number 1).
 * Explicit: reject boolean true / string "1" even if Number(x)===1.
 */
export function isMysqlLockAcquiredScalar(scalar: number | null): boolean {
  return scalar === 1
}

/**
 * Parse a non-negative safe integer from a driver cell.
 * Returns null for missing/invalid — never coerces to 0.
 */
export function parseNonNegativeSafeInt(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null
  }
  if (typeof value === 'bigint') {
    if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) return null
    return Number(value)
  }
  if (typeof value === 'number') {
    return Number.isSafeInteger(value) && value >= 0 ? value : null
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0 || !/^\d+$/.test(trimmed)) return null
    const n = Number(trimmed)
    return Number.isSafeInteger(n) && n >= 0 ? n : null
  }
  return null
}

/**
 * Parse entity_rev: safe integer ≥ 1, or null when missing/invalid.
 * Does not invent 0 or 1 from garbage.
 */
export function parseEntityRevCell(value: unknown): number | null {
  const n = parseNonNegativeSafeInt(value)
  if (n == null || n < 1) return null
  return n
}

/**
 * Canonical pin hash (migration CHAR(64) / SHA-256 hex contract).
 * Trim once + lowercase; accept only exactly 64 lowercase hex digits.
 * Validate and persist this same normalized value (no raw-space drift).
 */
const CANONICAL_HASH_HEX_RE = /^[0-9a-f]{64}$/

export function parseBoundedHash(value: unknown): string | null {
  if (typeof value !== 'string') return null
  // Single trim then lowercase — normalized form used for both check and write.
  const normalized = value.trim().toLowerCase()
  if (normalized.length === 0) return null
  if (normalized.length > CP0_PUBLISHER_MYSQL_HASH_MAX_LEN) return null
  if (!CANONICAL_HASH_HEX_RE.test(normalized)) return null
  return normalized
}

/**
 * Board id hygiene before any lock / pin-read / row-load / CAS.
 * Empty, overlong (>64), or control characters are rejected; SQL stays parameterized.
 */
export function assertValidPublisherBoardId(boardId: unknown): asserts boardId is string {
  if (typeof boardId !== 'string' || boardId.length === 0) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'board_id_invalid')
  }
  if (boardId.length > 64) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'board_id_too_long')
  }
  if (/[\u0000-\u001f\u007f]/.test(boardId)) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'board_id_control_chars')
  }
}

/** True when value is a safe non-negative integer (not null, not coerced). */
function isSafeNonNegInt(value: unknown): value is number {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
}

/**
 * Freeze a pin object so shared mutable-pin drift cannot be hidden across
 * pin-before / pin-after reads. Always returns a NEW object.
 */
export function freezeCp0Pin(pin: Cp0SyncStatusPin): Readonly<Cp0SyncStatusPin> {
  return Object.freeze({
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    canonicalHash: pin.canonicalHash,
  })
}

function parseFreshnessCell(value: unknown): string | Date | null {
  if (value == null) return null
  if (value instanceof Date) {
    return Number.isFinite(value.getTime()) ? value : null
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (t.length === 0) return null
    // Preserve raw string for P2 ordering; do not invent epoch.
    return t.slice(0, 40)
  }
  return null
}

function isDupKeyError(err: unknown): boolean {
  if (err == null || typeof err !== 'object') return false
  const e = err as { errno?: number; code?: string }
  return e.errno === 1062 || e.code === 'ER_DUP_ENTRY'
}

/** Redact thrown values to code/name only (no message/credentials). */
export function redactMysqlAdapterError(err: unknown): {
  name: string
  code?: string
} {
  if (err instanceof Cp0PublisherMysqlError) {
    return { name: err.name, code: err.code }
  }
  if (err instanceof Error) {
    const maybeCode = (err as unknown as { code?: unknown }).code
    const code =
      typeof maybeCode === 'string' ? maybeCode.slice(0, 64) : undefined
    // Name only — never message.
    return { name: err.name.slice(0, 64) || 'Error', code }
  }
  return { name: 'non-error-throw' }
}

function readAffectedRows(result: unknown): number | null {
  if (result == null || typeof result !== 'object') return null
  const r = result as { affectedRows?: unknown; rowsAffected?: unknown }
  if (typeof r.affectedRows === 'number' && Number.isSafeInteger(r.affectedRows) && r.affectedRows >= 0) {
    return r.affectedRows
  }
  if (typeof r.rowsAffected === 'number' && Number.isSafeInteger(r.rowsAffected) && r.rowsAffected >= 0) {
    return r.rowsAffected
  }
  // Driver returned something that is not a trustworthy integer count.
  return null
}

function serializeRecordJson(record: unknown): string {
  let text: string
  try {
    text = JSON.stringify(record ?? null)
  } catch {
    throw new Cp0PublisherMysqlError(
      'INVALID_INPUT',
      'record_json_not_serializable',
    )
  }
  if (typeof text !== 'string') {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'record_json_invalid')
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > CP0_PUBLISHER_MYSQL_RECORD_JSON_MAX_BYTES) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'record_json_too_large', {
      bytes,
    })
  }
  return text
}

/**
 * Defense-in-depth status/count integrity for bare casPublish (D1).
 * Never coerces missing counts to zero.
 *
 * IN_SYNC: all three counts safe ints === 0, effective === outbox + legacy,
 *          last_ack_revision === board_rev, pin fields already validated.
 * READBACK_REQUIRED: counts all null OR all safe non-neg ints with
 *          effective === outbox + legacy; hybrid null/non-null rejected.
 */
function validateCandidateCountIntegrity(
  candidate: Cp0SyncStatusPublishCandidate,
): void {
  const outbox = candidate.outbox_pending
  const legacy = candidate.legacy_unreplayed
  const effective = candidate.effective_backlog

  // Per-cell: only null or non-negative safe int (never invent zeros).
  for (const [key, v] of [
    ['outbox_pending', outbox],
    ['legacy_unreplayed', legacy],
    ['effective_backlog', effective],
  ] as const) {
    if (v === null) continue
    if (!isSafeNonNegInt(v)) {
      throw new Cp0PublisherMysqlError('INVALID_INPUT', `count_${key}_invalid`)
    }
  }

  if (candidate.rawStatus === 'IN_SYNC') {
    // Forged green: nulls or nonzeros must not persist.
    if (outbox !== 0 || legacy !== 0 || effective !== 0) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'in_sync_counts_not_zero',
      )
    }
    // Type-narrow: exact 0 (safe ints) — reject if somehow non-number zeros.
    if (
      !isSafeNonNegInt(outbox) ||
      !isSafeNonNegInt(legacy) ||
      !isSafeNonNegInt(effective)
    ) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'in_sync_counts_not_zero',
      )
    }
    if (effective !== outbox + legacy) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'effective_sum_mismatch',
      )
    }
    if (
      !isSafeNonNegInt(candidate.last_ack_revision) ||
      candidate.last_ack_revision !== candidate.board_rev
    ) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'last_ack_not_board_rev',
      )
    }
    return
  }

  // READBACK_REQUIRED: all-null OR all safe non-neg with effective = outbox+legacy.
  const nullCount =
    (outbox === null ? 1 : 0) +
    (legacy === null ? 1 : 0) +
    (effective === null ? 1 : 0)

  if (nullCount === 3) {
    // Honest unproven path — nulls preserved, never coerced to 0.
    return
  }
  if (nullCount !== 0) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'counts_hybrid_null')
  }
  // All present: must be safe non-neg ints (checked above) with sum match.
  if (
    !isSafeNonNegInt(outbox) ||
    !isSafeNonNegInt(legacy) ||
    !isSafeNonNegInt(effective)
  ) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'counts_invalid')
  }
  // Reject sum overflow / mismatch (never coerce).
  const sum = outbox + legacy
  if (!Number.isSafeInteger(sum) || effective !== sum) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'effective_sum_mismatch')
  }
}

/**
 * Validate candidate and return the **normalized** canonical_hash that must be
 * persisted (same value used for validation — D2).
 */
function validateCandidateForCas(
  candidate: Cp0SyncStatusPublishCandidate,
  expectedEntityRev: number | null,
): { normalizedHash: string } {
  if (candidate == null || typeof candidate !== 'object') {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'candidate_missing')
  }
  assertValidPublisherBoardId(candidate.boardId)
  if (!ALLOWED_RAW_STATUS.has(candidate.rawStatus)) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'raw_status_not_allowed')
  }
  if (candidate.expectedEntityRev !== expectedEntityRev) {
    throw new Cp0PublisherMysqlError(
      'INVALID_INPUT',
      'expected_entity_rev_mismatch',
    )
  }
  if (expectedEntityRev === null) {
    if (candidate.nextEntityRev !== 1) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'next_entity_rev_insert_invalid',
      )
    }
  } else {
    if (
      !Number.isSafeInteger(expectedEntityRev) ||
      expectedEntityRev < 1
    ) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'expected_entity_rev_invalid',
      )
    }
    // Overflow-safe: expected+1 must stay a safe integer and match next.
    if (
      expectedEntityRev >= Number.MAX_SAFE_INTEGER ||
      candidate.nextEntityRev !== expectedEntityRev + 1
    ) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'next_entity_rev_relation_invalid',
      )
    }
  }
  if (
    !Number.isSafeInteger(candidate.nextEntityRev) ||
    candidate.nextEntityRev < 1
  ) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'next_entity_rev_invalid')
  }
  if (
    !Number.isSafeInteger(candidate.board_rev) ||
    candidate.board_rev < 0 ||
    !Number.isSafeInteger(candidate.lifecycle_rev) ||
    candidate.lifecycle_rev < 0
  ) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'pin_revs_invalid')
  }
  const normalizedHash = parseBoundedHash(candidate.canonical_hash)
  if (normalizedHash == null) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'canonical_hash_invalid')
  }
  validateCandidateCountIntegrity(candidate)
  if (candidate.last_ack_revision != null) {
    if (
      !Number.isSafeInteger(candidate.last_ack_revision) ||
      candidate.last_ack_revision < 0
    ) {
      throw new Cp0PublisherMysqlError(
        'INVALID_INPUT',
        'last_ack_revision_invalid',
      )
    }
  }
  // Freshness: nonempty ISO-ish string, hard bound 40 (DATETIME(3) / ISO8601).
  if (
    typeof candidate.freshness_at !== 'string' ||
    candidate.freshness_at.length === 0 ||
    candidate.freshness_at.length > 40 ||
    /[\u0000-\u001f\u007f]/.test(candidate.freshness_at)
  ) {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'freshness_at_invalid')
  }
  return { normalizedHash }
}

function rowWriteParams(
  candidate: Cp0SyncStatusPublishCandidate,
  normalizedHash: string,
): {
  status: Cp0PublisherRawStatus
  outbox: number | null
  legacy: number | null
  effective: number | null
  boardRev: number
  lifecycleRev: number
  hash: string
  lastAck: number | null
  freshness: string
  entityRev: number
  recordJson: string
} {
  return {
    status: candidate.rawStatus,
    outbox: candidate.outbox_pending,
    legacy: candidate.legacy_unreplayed,
    effective: candidate.effective_backlog,
    boardRev: candidate.board_rev,
    lifecycleRev: candidate.lifecycle_rev,
    // Persist exactly the validated normalized hash (D2) — never raw padded input.
    hash: normalizedHash,
    lastAck: candidate.last_ack_revision,
    freshness: candidate.freshness_at,
    entityRev: candidate.nextEntityRev,
    recordJson: serializeRecordJson(candidate.record),
  }
}

// ---------------------------------------------------------------------------
// Adapter implementations
// ---------------------------------------------------------------------------

async function acquirePublisherLockImpl(
  client: Cp0PublisherMysqlClient,
  boardId: string,
  lockTimeoutSec: number,
): Promise<Cp0PublisherLockHandle> {
  // D3: reject empty/overlong/control board_id before getConnection / GET_LOCK.
  assertValidPublisherBoardId(boardId)
  if (typeof client.getConnection !== 'function') {
    throw new Cp0PublisherMysqlError(
      'INVALID_INPUT',
      'getConnection_required',
    )
  }

  const lockName = buildCp0PublisherLockName(boardId)
  const timeout =
    Number.isFinite(lockTimeoutSec) && lockTimeoutSec >= 0
      ? Math.min(Math.floor(lockTimeoutSec), 30)
      : CP0_PUBLISHER_MYSQL_DEFAULT_LOCK_TIMEOUT_SEC

  let conn: Cp0PublisherMysqlConnection | null = null
  let acquired = false
  try {
    conn = await client.getConnection()
    const [acqRows] = await conn.query('SELECT GET_LOCK(?, ?) AS l', [
      lockName,
      timeout,
    ])
    const scalar = readMysqlLockScalar(acqRows, ['l'])
    // D4: only numeric/bigint scalar 1 counts as held (never boolean true / "1").
    acquired = isMysqlLockAcquiredScalar(scalar)
    if (!acquired) {
      // Lock miss / timeout / null: release connection immediately; not held.
      try {
        conn.release()
      } catch {
        /* ignore */
      }
      conn = null
      return {
        held: false,
        release: async () => {
          /* no-op: never acquired */
        },
      }
    }

    // Hold connection reserved until P2 release callback.
    const pinned = conn
    conn = null // ownership transferred to handle
    let released = false
    return {
      held: true,
      fenceToken: lockName,
      release: async () => {
        if (released) return
        released = true
        try {
          try {
            await pinned.query('SELECT RELEASE_LOCK(?) AS r', [lockName])
          } catch {
            // RELEASE_LOCK errors must not prevent returning the connection.
          }
        } finally {
          try {
            pinned.release()
          } catch {
            /* ignore pool release errors */
          }
        }
      },
    }
  } catch (err) {
    if (conn) {
      try {
        conn.release()
      } catch {
        /* ignore */
      }
    }
    if (err instanceof Cp0PublisherMysqlError) throw err
    // Re-throw as bounded error (name only in message slot).
    const redacted = redactMysqlAdapterError(err)
    throw new Cp0PublisherMysqlError(
      'LOCK_ERROR',
      'lock_acquire_failed',
      redacted,
    )
  }
}

async function readCanonicalPinImpl(
  client: Cp0PublisherMysqlClient,
  boardId: string,
): Promise<Cp0SyncStatusPin | null> {
  // D3: reject bad board_id before SELECT (parameterized only).
  assertValidPublisherBoardId(boardId)
  const [rows] = await client.query(SELECT_PIN_SQL, [boardId])
  const row = asRowArray(rows)[0]
  if (!row) return null

  const boardRev = parseNonNegativeSafeInt(row.board_rev)
  const lifecycleRev = parseNonNegativeSafeInt(row.lifecycle_rev)
  const canonicalHash = parseBoundedHash(row.canonical_hash)
  if (boardRev == null || lifecycleRev == null || canonicalHash == null) {
    return null
  }
  const pin: Cp0SyncStatusPin = {
    boardRev,
    lifecycleRev,
    canonicalHash,
  }
  if (!isCompleteCp0Pin(pin)) return null
  // NEW frozen object every read — mutation of prior results cannot drift-hide.
  return freezeCp0Pin(pin) as Cp0SyncStatusPin
}

async function loadExistingRowImpl(
  client: Cp0PublisherMysqlClient,
  boardId: string,
): Promise<Cp0SyncStatusExistingRow | null> {
  // D3: reject bad board_id before SELECT (parameterized only).
  assertValidPublisherBoardId(boardId)
  const [rows] = await client.query(SELECT_SYNC_ROW_SQL, [boardId])
  const row = asRowArray(rows)[0]
  if (!row) return null

  // entity_rev: required for CAS baseline. Invalid/missing → null row (fail-closed).
  const entityRev = parseEntityRevCell(row.entity_rev)
  if (entityRev == null) {
    return null
  }

  // Counts: null when missing/invalid — never coerce to 0.
  const outbox = parseNonNegativeSafeInt(row.outbox_pending)
  const legacy = parseNonNegativeSafeInt(row.legacy_unreplayed)
  const effective = parseNonNegativeSafeInt(row.effective_backlog)
  // Note: parseNonNegativeSafeInt returns null for NULL; for present 0 it returns 0.
  // Distinguishing SQL NULL vs invalid: both map to null (no invent). Present 0 is kept.

  // If driver returned a value that is present but not a non-neg int, stay null.
  // (0 is valid when the column is actually 0.)
  const outboxCell = row.outbox_pending
  const legacyCell = row.legacy_unreplayed
  const effectiveCell = row.effective_backlog

  const boardRev = parseNonNegativeSafeInt(row.board_rev)
  const lifecycleRev = parseNonNegativeSafeInt(row.lifecycle_rev)
  const hash =
    typeof row.canonical_hash === 'string' ? row.canonical_hash : row.canonical_hash
  const lastAck = parseNonNegativeSafeInt(row.last_ack_revision)
  const freshness = parseFreshnessCell(row.freshness_at)

  return {
    entity_rev: entityRev,
    freshness_at: freshness,
    status: row.status,
    // Preserve null for SQL NULL / invalid; preserve 0 only when parsed as 0.
    outbox_pending:
      outboxCell === null || outboxCell === undefined
        ? null
        : outbox,
    legacy_unreplayed:
      legacyCell === null || legacyCell === undefined
        ? null
        : legacy,
    effective_backlog:
      effectiveCell === null || effectiveCell === undefined
        ? null
        : effective,
    board_rev: boardRev,
    lifecycle_rev: lifecycleRev,
    canonical_hash: hash,
    last_ack_revision:
      row.last_ack_revision === null || row.last_ack_revision === undefined
        ? null
        : lastAck,
  }
}

async function casPublishImpl(
  client: Cp0PublisherMysqlClient,
  input: {
    candidate: Cp0SyncStatusPublishCandidate
    expectedEntityRev: number | null
  },
): Promise<Cp0PublisherCasOutcome> {
  try {
    const { normalizedHash } = validateCandidateForCas(
      input.candidate,
      input.expectedEntityRev,
    )
    const c = input.candidate
    const w = rowWriteParams(c, normalizedHash)

    if (input.expectedEntityRev === null) {
      // Plain INSERT only — never ON DUPLICATE KEY UPDATE.
      try {
        const [result] = await client.query(INSERT_SYNC_SQL, [
          c.boardId,
          w.status,
          w.outbox,
          w.legacy,
          w.effective,
          w.boardRev,
          w.lifecycleRev,
          w.hash,
          w.lastAck,
          w.freshness,
          w.entityRev,
          w.recordJson,
        ])
        const affected = readAffectedRows(result)
        if (affected === null) {
          return {
            ok: false,
            conflict: false,
            error: new Cp0PublisherMysqlError(
              'DRIVER_MALFORMED',
              'affected_rows_malformed',
            ),
          }
        }
        if (affected !== 1) {
          // Insert must affect exactly one row; anything else is not success.
          if (affected === 0) {
            return { ok: false, conflict: true }
          }
          return {
            ok: false,
            conflict: false,
            error: new Cp0PublisherMysqlError(
              'DATA_INTEGRITY',
              'insert_affected_unexpected',
              { affected },
            ),
          }
        }
        return { ok: true }
      } catch (err) {
        if (isDupKeyError(err)) {
          return { ok: false, conflict: true }
        }
        return {
          ok: false,
          conflict: false,
          error: new Cp0PublisherMysqlError(
            'PUBLISH_ERROR',
            'insert_failed',
            redactMysqlAdapterError(err),
          ),
        }
      }
    }

    // UPDATE CAS path: exact entity_rev match.
    const [result] = await client.query(UPDATE_SYNC_CAS_SQL, [
      w.status,
      w.outbox,
      w.legacy,
      w.effective,
      w.boardRev,
      w.lifecycleRev,
      w.hash,
      w.lastAck,
      w.freshness,
      w.entityRev,
      w.recordJson,
      c.boardId,
      input.expectedEntityRev,
    ])
    const affected = readAffectedRows(result)
    if (affected === null) {
      return {
        ok: false,
        conflict: false,
        error: new Cp0PublisherMysqlError(
          'DRIVER_MALFORMED',
          'affected_rows_malformed',
        ),
      }
    }
    if (affected === 1) return { ok: true }
    if (affected === 0) return { ok: false, conflict: true }
    // >1: PK should make this impossible — data integrity failure, not success.
    return {
      ok: false,
      conflict: false,
      error: new Cp0PublisherMysqlError(
        'DATA_INTEGRITY',
        'update_affected_multiple',
        { affected },
      ),
    }
  } catch (err) {
    if (err instanceof Cp0PublisherMysqlError) {
      return { ok: false, conflict: false, error: err }
    }
    return {
      ok: false,
      conflict: false,
      error: new Cp0PublisherMysqlError(
        'PUBLISH_ERROR',
        'cas_publish_failed',
        redactMysqlAdapterError(err),
      ),
    }
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export type Cp0SyncStatusPublisherMysqlDeps = Pick<
  Cp0SyncStatusPublisherDeps,
  'acquirePublisherLock' | 'readCanonicalPin' | 'loadExistingRow' | 'casPublish'
>

/**
 * Create injectable P2 publisher deps backed by MySQL SQL.
 *
 * - Requires an injected client with getConnection (connection-pinned locks).
 * - Does **not** open a default pool or import `db()`.
 * - Does **not** start a scheduler / background loop.
 * - Does **not** span a transaction across measurement (lock + CAS only).
 */
export function createCp0SyncStatusPublisherMysqlDeps(
  client: Cp0PublisherMysqlClient,
  options: Cp0PublisherMysqlAdapterOptions = {},
): Cp0SyncStatusPublisherMysqlDeps {
  if (client == null || typeof client !== 'object') {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'client_required')
  }
  if (typeof client.query !== 'function') {
    throw new Cp0PublisherMysqlError('INVALID_INPUT', 'client_query_required')
  }
  if (typeof client.getConnection !== 'function') {
    throw new Cp0PublisherMysqlError(
      'INVALID_INPUT',
      'getConnection_required',
    )
  }

  const lockTimeoutSec =
    options.lockTimeoutSec ?? CP0_PUBLISHER_MYSQL_DEFAULT_LOCK_TIMEOUT_SEC

  return {
    acquirePublisherLock: (boardId: string) =>
      acquirePublisherLockImpl(client, boardId, lockTimeoutSec),
    readCanonicalPin: (boardId: string) =>
      readCanonicalPinImpl(client, boardId),
    loadExistingRow: (boardId: string) => loadExistingRowImpl(client, boardId),
    casPublish: (input) => casPublishImpl(client, input),
  }
}
