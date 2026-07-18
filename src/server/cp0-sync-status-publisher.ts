/**
 * CP0 sync-status one-tick publisher core (PACKET-P2).
 *
 * Pure / injectable: acquires a board-scoped lock through deps, reads a stable
 * canonical pin, runs P1 measure primitives, re-reads pin (refuse on drift),
 * decides a typed publish candidate, and optionally CAS-publishes via inject.
 *
 * Does NOT:
 *   - schedule intervals / start loops
 *   - execute SQL itself
 *   - invent proven zeros from missing/partial/stale/future/error measures
 *   - let default measurers claim proof
 *   - leak secret-bearing error messages
 *
 * rawStatus vs serializer effective status:
 *   - rawStatus is the DB token candidate (IN_SYNC only under dual proven zeros)
 *   - effectiveStatus is buildCp0SyncStatusReadback() over the candidate-as-row
 *     (may still mask when proof fails; never green-by-raw alone)
 *
 * P3 wires real lock/pin/row/CAS + real count SSOTs; this core stays injectable.
 */

import {
  buildCp0SyncStatusReadback,
  type Cp0SyncStatusPin,
  type Cp0SyncStatusRow,
} from './cp0-sync-status'
import {
  createDefaultCp0SyncStatusMeasureDeps,
  measureCp0SyncStatusCounts,
  sanitizeMeasureSourceId,
  toNullableCountColumns,
  type Cp0CombinedBacklogMeasure,
  type Cp0SyncStatusMeasureDeps,
} from './cp0-sync-status-measures'

/** Diagnostic schema id for publisher envelopes (no secrets). */
export const CP0_SYNC_STATUS_PUBLISHER_SCHEMA = 'CP0_SYNC_STATUS_PUBLISHER_V1' as const

/** Recommended renew interval; must stay well under the 120s serializer window. */
export const CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS = 30_000 as const

/** Bound free-form reason text on candidates / results. */
export const CP0_PUBLISHER_REASON_MAX_LEN = 200 as const

/** Allowed raw DB status tokens emitted by this core. */
export type Cp0PublisherRawStatus = 'IN_SYNC' | 'READBACK_REQUIRED'

export type Cp0PublisherDecision =
  | 'PUBLISH_IN_SYNC'
  | 'PUBLISH_READBACK_REQUIRED'
  | 'SKIP_LOCK_NOT_ACQUIRED'
  | 'SKIP_PIN_UNAVAILABLE'
  | 'SKIP_PIN_DRIFT'
  | 'SKIP_CAS_CONFLICT'
  | 'SKIP_STALE_WRITER'
  | 'SKIP_ERROR'

export type Cp0PublisherReasonCode =
  | 'OK_IN_SYNC_ZEROS'
  | 'OK_READBACK_REQUIRED'
  | 'LOCK_NOT_ACQUIRED'
  | 'PIN_UNAVAILABLE'
  | 'PIN_DRIFT'
  | 'CAS_CONFLICT'
  | 'STALE_WRITER'
  | 'COUNTS_UNPROVEN'
  | 'BACKLOG_NONZERO'
  | 'MEASURE_UNPROVEN'
  | 'PUBLISHER_ERROR'
  | 'UNKNOWN'

/** Existing row snapshot for CAS / stale-writer ordering (injected read; no SQL here). */
export type Cp0SyncStatusExistingRow = {
  entity_rev: number
  /** ISO or Date; used only for stale-writer freshness ordering. */
  freshness_at?: string | Date | null
  status?: unknown
  outbox_pending?: unknown
  legacy_unreplayed?: unknown
  effective_backlog?: unknown
  board_rev?: unknown
  lifecycle_rev?: unknown
  canonical_hash?: unknown
  last_ack_revision?: unknown
}

/** Board-scoped publisher lock handle (injected; typically GET_LOCK under P3). */
export type Cp0PublisherLockHandle = {
  held: boolean
  /** Optional fence token for diagnostics. */
  fenceToken?: string
  release: () => void | Promise<void>
}

/** CAS outcome from an injected store write. */
export type Cp0PublisherCasOutcome =
  | { ok: true }
  | { ok: false; conflict: true }
  | { ok: false; conflict?: false; error?: unknown }

/**
 * Typed row candidate P3 can UPSERT later.
 * expectedEntityRev null ⇒ insert path; non-null ⇒ CAS WHERE entity_rev = expected.
 */
export type Cp0SyncStatusPublishCandidate = {
  schemaVersion: typeof CP0_SYNC_STATUS_PUBLISHER_SCHEMA
  boardId: string
  /** Raw DB status token (not serializer authoritative status). */
  rawStatus: Cp0PublisherRawStatus
  outbox_pending: number | null
  legacy_unreplayed: number | null
  effective_backlog: number | null
  board_rev: number
  lifecycle_rev: number
  canonical_hash: string
  /** Set to board_rev only on proven zero IN_SYNC; else preserved/null. */
  last_ack_revision: number | null
  /** Freshness from this measured/published sample only (ISO). */
  freshness_at: string
  /** CAS precondition: existing entity_rev, or null for insert. */
  expectedEntityRev: number | null
  /** Next entity_rev after successful CAS (existing+1 or 1). */
  nextEntityRev: number
  countsProven: boolean
  pinStable: true
  measuredAtMs: number
  reasonCode: Cp0PublisherReasonCode
  reason: string
  /** Non-secret diagnostic envelope for record_json. */
  record: Cp0PublisherRecordJson
}

export type Cp0PublisherRecordJson = {
  schemaVersion: typeof CP0_SYNC_STATUS_PUBLISHER_SCHEMA
  publisherId: string
  tickId: string
  measuredAtMs: number
  pin: Cp0SyncStatusPin
  countsProven: boolean
  rawStatus: Cp0PublisherRawStatus
  measureReasonCode: string | null
  measureSources: {
    outbox: string
    legacy: string
    effective: string
  }
}

export type Cp0SyncStatusPublishResult = {
  schemaVersion: typeof CP0_SYNC_STATUS_PUBLISHER_SCHEMA
  boardId: string
  decision: Cp0PublisherDecision
  /** True only when an injected CAS accepted the candidate. */
  published: boolean
  lockHeld: boolean
  pinStable: boolean
  /** Candidate for P3 persistence; null when tick refuses to form a row. */
  candidate: Cp0SyncStatusPublishCandidate | null
  /** Raw DB token intended / written; null when no candidate. */
  rawStatus: Cp0PublisherRawStatus | null
  /**
   * Serializer authoritative status if candidate were the live row under the
   * measured pin (preserves raw vs effective distinction).
   */
  effectiveStatus: string | null
  /** True only when this tick claims dual proven fresh zeros + stable pin. */
  zeroBacklogClaimed: boolean
  countsProven: boolean
  reasonCode: Cp0PublisherReasonCode
  reason: string
  measuredAtMs: number | null
  combined: Cp0CombinedBacklogMeasure | null
  tickId: string
}

export type Cp0SyncStatusPublisherDeps = {
  /** Clock for measure + freshness_at; inject for tests. */
  nowMs: () => number
  /**
   * Acquire one board-scoped publisher lock/fence.
   * Must not block indefinitely; non-holder returns held:false.
   */
  acquirePublisherLock: (boardId: string) => Promise<Cp0PublisherLockHandle>
  /** Stable canonical pin SSOT (same identity healthz/MCP use). */
  readCanonicalPin: (boardId: string) => Promise<Cp0SyncStatusPin | null>
  /** Optional existing row for CAS + stale-writer ordering. */
  loadExistingRow?: (boardId: string) => Promise<Cp0SyncStatusExistingRow | null>
  /**
   * Optional CAS writer. When omitted, candidate is returned for P3 without
   * marking published=true (local pure core / dry-run).
   */
  casPublish?: (input: {
    candidate: Cp0SyncStatusPublishCandidate
    expectedEntityRev: number | null
  }) => Promise<Cp0PublisherCasOutcome>
  /** Measure deps; defaults are fail-closed unproven (never claim proof). */
  measureDeps?: Cp0SyncStatusMeasureDeps
  /** Stable publisher identity for record_json (sanitized). */
  publisherId?: string
  /** Optional tick id; generated when omitted. */
  tickId?: string
}

const REASON_TEXT: Record<Cp0PublisherReasonCode, string> = {
  OK_IN_SYNC_ZEROS: 'dual proven fresh zero counts with stable pin; raw IN_SYNC',
  OK_READBACK_REQUIRED: 'publish candidate is READBACK_REQUIRED (not dual proven zeros)',
  LOCK_NOT_ACQUIRED: 'board-scoped publisher lock not acquired; tick no-op',
  PIN_UNAVAILABLE: 'canonical pin unavailable or incomplete; refuse publish',
  PIN_DRIFT: 'canonical pin changed between measure and publish; refuse write',
  CAS_CONFLICT: 'CAS rejected; existing entity_rev advanced by a newer writer',
  STALE_WRITER: 'sample freshness older than existing row; refuse overwrite',
  COUNTS_UNPROVEN: 'outbox/legacy/effective counts not fully proven',
  BACKLOG_NONZERO: 'counts proven but backlog non-zero; raw not IN_SYNC',
  MEASURE_UNPROVEN: 'measure phase unproven or partial; null counts',
  PUBLISHER_ERROR: 'publisher tick failed closed',
  UNKNOWN: 'publisher decision unknown',
}

function reasonFor(code: Cp0PublisherReasonCode, detail?: string): string {
  const base = REASON_TEXT[code]
  if (!detail) return base
  return sanitizePublisherReason(`${base}: ${detail}`, base)
}

/** Sanitize free-form publisher reasons (length-bound; no control chars). */
export function sanitizePublisherReason(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, CP0_PUBLISHER_REASON_MAX_LEN)
  return cleaned.length > 0 ? cleaned : fallback
}

function sanitizePublisherId(raw: unknown): string {
  return sanitizeMeasureSourceId(raw, 'cp0-sync-status-publisher')
}

function newTickId(nowMs: number): string {
  const rand = Math.floor(Math.random() * 1e9)
    .toString(36)
    .padStart(6, '0')
  return `tick-${nowMs.toString(36)}-${rand}`
}

/** True when pin components are finite non-negative revs + non-empty hash. */
export function isCompleteCp0Pin(pin: Cp0SyncStatusPin | null | undefined): pin is Cp0SyncStatusPin {
  if (pin == null) return false
  if (!Number.isSafeInteger(pin.boardRev) || pin.boardRev < 0) return false
  if (!Number.isSafeInteger(pin.lifecycleRev) || pin.lifecycleRev < 0) return false
  if (typeof pin.canonicalHash !== 'string' || pin.canonicalHash.length === 0) return false
  return true
}

/** Pin equality for drift detection (exact triple match). */
export function pinsEqual(a: Cp0SyncStatusPin, b: Cp0SyncStatusPin): boolean {
  return (
    a.boardRev === b.boardRev &&
    a.lifecycleRev === b.lifecycleRev &&
    a.canonicalHash === b.canonicalHash
  )
}

/**
 * IN_SYNC only when:
 *   countsProven ∧ outbox=legacy=effective=0 ∧ pinStable
 * Otherwise rawStatus is READBACK_REQUIRED.
 * Never invents zeros: unproven paths use null columns via toNullableCountColumns.
 */
export function decidePublisherRawStatus(input: {
  countsProven: boolean
  outbox: number | null
  legacy: number | null
  effective: number | null
  pinStable: boolean
}): {
  rawStatus: Cp0PublisherRawStatus
  zeroBacklogClaimed: boolean
  reasonCode: Cp0PublisherReasonCode
  reason: string
} {
  if (!input.pinStable) {
    return {
      rawStatus: 'READBACK_REQUIRED',
      zeroBacklogClaimed: false,
      reasonCode: 'PIN_DRIFT',
      reason: reasonFor('PIN_DRIFT'),
    }
  }
  if (!input.countsProven) {
    return {
      rawStatus: 'READBACK_REQUIRED',
      zeroBacklogClaimed: false,
      reasonCode: 'COUNTS_UNPROVEN',
      reason: reasonFor('COUNTS_UNPROVEN'),
    }
  }
  // Proven path: columns must be safe non-negative integers (already validated by measures).
  if (
    input.outbox === 0 &&
    input.legacy === 0 &&
    input.effective === 0
  ) {
    return {
      rawStatus: 'IN_SYNC',
      zeroBacklogClaimed: true,
      reasonCode: 'OK_IN_SYNC_ZEROS',
      reason: reasonFor('OK_IN_SYNC_ZEROS'),
    }
  }
  return {
    rawStatus: 'READBACK_REQUIRED',
    zeroBacklogClaimed: false,
    reasonCode: 'BACKLOG_NONZERO',
    reason: reasonFor('BACKLOG_NONZERO'),
  }
}

/** Project candidate → Cp0SyncStatusRow shape for serializer effective status. */
export function candidateToSyncStatusRow(
  candidate: Cp0SyncStatusPublishCandidate,
): Cp0SyncStatusRow {
  return {
    status: candidate.rawStatus,
    outbox_pending: candidate.outbox_pending,
    legacy_unreplayed: candidate.legacy_unreplayed,
    effective_backlog: candidate.effective_backlog,
    board_rev: candidate.board_rev,
    lifecycle_rev: candidate.lifecycle_rev,
    canonical_hash: candidate.canonical_hash,
    last_ack_revision: candidate.last_ack_revision,
    freshness_at: candidate.freshness_at,
    entity_rev: candidate.nextEntityRev,
  }
}

/** Effective serializer status for a candidate under its pin (diagnostic). */
export function effectiveStatusForCandidate(
  candidate: Cp0SyncStatusPublishCandidate,
  nowMs: number,
): string {
  const readback = buildCp0SyncStatusReadback(
    candidateToSyncStatusRow(candidate),
    {
      boardRev: candidate.board_rev,
      lifecycleRev: candidate.lifecycle_rev,
      canonicalHash: candidate.canonical_hash,
    },
    nowMs,
  )
  return readback.status
}

function parseExistingFreshnessMs(existing: Cp0SyncStatusExistingRow | null): number | null {
  if (existing == null || existing.freshness_at == null) return null
  const ms =
    existing.freshness_at instanceof Date
      ? existing.freshness_at.getTime()
      : new Date(existing.freshness_at as string).getTime()
  return Number.isFinite(ms) ? ms : null
}

function validateExistingEntityRev(existing: Cp0SyncStatusExistingRow | null): number | null {
  if (existing == null) return null
  const rev = existing.entity_rev
  if (!Number.isSafeInteger(rev) || rev < 1) return null
  return rev
}

function redactThrown(err: unknown): string {
  if (err instanceof Error) {
    // Name only — never message (may hold SQL/secrets).
    return sanitizePublisherReason(err.name, 'Error')
  }
  return 'non-error throw'
}

function emptyResult(input: {
  boardId: string
  decision: Cp0PublisherDecision
  reasonCode: Cp0PublisherReasonCode
  reason: string
  lockHeld: boolean
  tickId: string
  pinStable?: boolean
  combined?: Cp0CombinedBacklogMeasure | null
  measuredAtMs?: number | null
}): Cp0SyncStatusPublishResult {
  return {
    schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
    boardId: input.boardId,
    decision: input.decision,
    published: false,
    lockHeld: input.lockHeld,
    pinStable: input.pinStable ?? false,
    candidate: null,
    rawStatus: null,
    effectiveStatus: null,
    zeroBacklogClaimed: false,
    countsProven: false,
    reasonCode: input.reasonCode,
    reason: input.reason,
    measuredAtMs: input.measuredAtMs ?? null,
    combined: input.combined ?? null,
    tickId: input.tickId,
  }
}

/**
 * Build a publish candidate from a stable pin + combined measure.
 * Pure; does not lock, measure, or persist.
 */
export function buildPublishCandidate(input: {
  boardId: string
  pin: Cp0SyncStatusPin
  combined: Cp0CombinedBacklogMeasure
  measuredAtMs: number
  existing: Cp0SyncStatusExistingRow | null
  publisherId: string
  tickId: string
}): Cp0SyncStatusPublishCandidate {
  const cols = toNullableCountColumns(input.combined)
  const decided = decidePublisherRawStatus({
    countsProven: cols.countsProven,
    outbox: cols.outbox_pending,
    legacy: cols.legacy_unreplayed,
    effective: cols.effective_backlog,
    pinStable: true,
  })

  const expectedEntityRev = validateExistingEntityRev(input.existing)
  const nextEntityRev = expectedEntityRev == null ? 1 : expectedEntityRev + 1

  // last_ack_revision: only advance to board_rev on proven zero IN_SYNC;
  // otherwise preserve existing or leave null (never invent 0).
  let lastAck: number | null = null
  if (decided.zeroBacklogClaimed) {
    lastAck = input.pin.boardRev
  } else if (input.existing != null) {
    const prev = input.existing.last_ack_revision
    if (typeof prev === 'number' && Number.isSafeInteger(prev) && prev >= 0) {
      lastAck = prev
    } else if (prev != null) {
      const n = Number(prev)
      lastAck = Number.isSafeInteger(n) && n >= 0 ? n : null
    }
  }

  const reasonCode =
    decided.reasonCode === 'COUNTS_UNPROVEN' && input.combined.reasonCode
      ? 'MEASURE_UNPROVEN'
      : decided.reasonCode
  const reason =
    decided.reasonCode === 'COUNTS_UNPROVEN' && input.combined.reason
      ? reasonFor(
          'MEASURE_UNPROVEN',
          sanitizePublisherReason(input.combined.reason, 'unproven'),
        )
      : decided.reason

  const record: Cp0PublisherRecordJson = {
    schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
    publisherId: sanitizePublisherId(input.publisherId),
    tickId: input.tickId,
    measuredAtMs: input.measuredAtMs,
    pin: {
      boardRev: input.pin.boardRev,
      lifecycleRev: input.pin.lifecycleRev,
      canonicalHash: input.pin.canonicalHash,
    },
    countsProven: cols.countsProven,
    rawStatus: decided.rawStatus,
    measureReasonCode: input.combined.reasonCode,
    measureSources: {
      outbox: sanitizeMeasureSourceId(input.combined.outbox.source.id, 'unknown'),
      legacy: sanitizeMeasureSourceId(input.combined.legacy.source.id, 'unknown'),
      effective: sanitizeMeasureSourceId(input.combined.effective.source.id, 'unknown'),
    },
  }

  return {
    schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
    boardId: input.boardId,
    rawStatus: decided.rawStatus,
    outbox_pending: cols.outbox_pending,
    legacy_unreplayed: cols.legacy_unreplayed,
    effective_backlog: cols.effective_backlog,
    board_rev: input.pin.boardRev,
    lifecycle_rev: input.pin.lifecycleRev,
    canonical_hash: input.pin.canonicalHash,
    last_ack_revision: lastAck,
    freshness_at: new Date(input.measuredAtMs).toISOString(),
    expectedEntityRev,
    nextEntityRev,
    countsProven: cols.countsProven,
    pinStable: true,
    measuredAtMs: input.measuredAtMs,
    reasonCode,
    reason,
    record,
  }
}

/**
 * Pure CAS preflight: reject stale writers whose sample is older than the row.
 * Does not perform I/O.
 */
export function evaluateCasPreflight(input: {
  candidate: Cp0SyncStatusPublishCandidate
  existing: Cp0SyncStatusExistingRow | null
}): { allow: true } | { allow: false; reasonCode: Cp0PublisherReasonCode; reason: string } {
  const existingRev = validateExistingEntityRev(input.existing)
  if (existingRev != null && input.candidate.expectedEntityRev !== existingRev) {
    return {
      allow: false,
      reasonCode: 'CAS_CONFLICT',
      reason: reasonFor(
        'CAS_CONFLICT',
        `expected=${String(input.candidate.expectedEntityRev)} actual=${existingRev}`,
      ),
    }
  }
  if (existingRev == null && input.candidate.expectedEntityRev != null) {
    return {
      allow: false,
      reasonCode: 'CAS_CONFLICT',
      reason: reasonFor('CAS_CONFLICT', 'row missing but expectedEntityRev set'),
    }
  }

  const existingFreshMs = parseExistingFreshnessMs(input.existing)
  if (
    existingFreshMs != null &&
    Number.isFinite(input.candidate.measuredAtMs) &&
    existingFreshMs > input.candidate.measuredAtMs
  ) {
    return {
      allow: false,
      reasonCode: 'STALE_WRITER',
      reason: reasonFor(
        'STALE_WRITER',
        `existingFreshnessMs=${existingFreshMs} sampleMs=${input.candidate.measuredAtMs}`,
      ),
    }
  }

  return { allow: true }
}

/**
 * Factory: injectable deps with fail-closed default measurers (no proof claim).
 * Lock / pin / CAS remain required injects (no silent SQL defaults).
 */
export function createCp0SyncStatusPublisherDeps(
  overrides: Pick<
    Cp0SyncStatusPublisherDeps,
    'nowMs' | 'acquirePublisherLock' | 'readCanonicalPin'
  > &
    Partial<Cp0SyncStatusPublisherDeps>,
): Cp0SyncStatusPublisherDeps {
  return {
    nowMs: overrides.nowMs,
    acquirePublisherLock: overrides.acquirePublisherLock,
    readCanonicalPin: overrides.readCanonicalPin,
    loadExistingRow: overrides.loadExistingRow,
    casPublish: overrides.casPublish,
    measureDeps:
      overrides.measureDeps ?? createDefaultCp0SyncStatusMeasureDeps(),
    publisherId: overrides.publisherId ?? 'cp0-sync-status-publisher',
    tickId: overrides.tickId,
  }
}

/**
 * One publisher tick: lock → pin → measure → pin re-read → decide → optional CAS.
 * No scheduler side effects. No SQL. Suitable for P3 wiring.
 */
export async function runCp0SyncStatusPublisherTick(
  boardId: string,
  deps: Cp0SyncStatusPublisherDeps,
): Promise<Cp0SyncStatusPublishResult> {
  const tickId = deps.tickId ?? newTickId(deps.nowMs())
  const publisherId = deps.publisherId ?? 'cp0-sync-status-publisher'
  const measureDeps =
    deps.measureDeps ?? createDefaultCp0SyncStatusMeasureDeps()

  let lock: Cp0PublisherLockHandle | null = null
  try {
    lock = await deps.acquirePublisherLock(boardId)
    if (!lock.held) {
      return emptyResult({
        boardId,
        decision: 'SKIP_LOCK_NOT_ACQUIRED',
        reasonCode: 'LOCK_NOT_ACQUIRED',
        reason: reasonFor('LOCK_NOT_ACQUIRED'),
        lockHeld: false,
        tickId,
      })
    }

    const pinBefore = await deps.readCanonicalPin(boardId)
    if (!isCompleteCp0Pin(pinBefore)) {
      return emptyResult({
        boardId,
        decision: 'SKIP_PIN_UNAVAILABLE',
        reasonCode: 'PIN_UNAVAILABLE',
        reason: reasonFor('PIN_UNAVAILABLE'),
        lockHeld: true,
        tickId,
      })
    }

    const measuredAtMs = deps.nowMs()
    const combined = await measureCp0SyncStatusCounts(measureDeps, {
      boardId,
      nowMs: measuredAtMs,
    })

    const pinAfter = await deps.readCanonicalPin(boardId)
    if (!isCompleteCp0Pin(pinAfter) || !pinsEqual(pinBefore, pinAfter)) {
      return emptyResult({
        boardId,
        decision: 'SKIP_PIN_DRIFT',
        reasonCode: 'PIN_DRIFT',
        reason: reasonFor('PIN_DRIFT'),
        lockHeld: true,
        tickId,
        pinStable: false,
        combined,
        measuredAtMs,
      })
    }

    const existing =
      deps.loadExistingRow != null ? await deps.loadExistingRow(boardId) : null

    const candidate = buildPublishCandidate({
      boardId,
      pin: pinAfter,
      combined,
      measuredAtMs,
      existing,
      publisherId,
      tickId,
    })

    const preflight = evaluateCasPreflight({ candidate, existing })
    if (!preflight.allow) {
      const decision: Cp0PublisherDecision =
        preflight.reasonCode === 'STALE_WRITER'
          ? 'SKIP_STALE_WRITER'
          : 'SKIP_CAS_CONFLICT'
      return {
        schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
        boardId,
        decision,
        published: false,
        lockHeld: true,
        pinStable: true,
        candidate,
        rawStatus: candidate.rawStatus,
        effectiveStatus: effectiveStatusForCandidate(candidate, measuredAtMs),
        zeroBacklogClaimed: candidate.rawStatus === 'IN_SYNC' && candidate.countsProven,
        countsProven: candidate.countsProven,
        reasonCode: preflight.reasonCode,
        reason: preflight.reason,
        measuredAtMs,
        combined,
        tickId,
      }
    }

    let published = false
    let decision: Cp0PublisherDecision =
      candidate.rawStatus === 'IN_SYNC'
        ? 'PUBLISH_IN_SYNC'
        : 'PUBLISH_READBACK_REQUIRED'
    let reasonCode = candidate.reasonCode
    let reason = candidate.reason

    if (deps.casPublish) {
      const cas = await deps.casPublish({
        candidate,
        expectedEntityRev: candidate.expectedEntityRev,
      })
      if (cas.ok) {
        published = true
      } else if (cas.conflict) {
        published = false
        decision = 'SKIP_CAS_CONFLICT'
        reasonCode = 'CAS_CONFLICT'
        reason = reasonFor('CAS_CONFLICT')
      } else {
        published = false
        decision = 'SKIP_ERROR'
        reasonCode = 'PUBLISHER_ERROR'
        reason = reasonFor('PUBLISHER_ERROR', redactThrown(cas.error))
      }
    }

    // Freshness is only on the candidate from this measured sample.
    // When CAS is not wired, published stays false; candidate is still returned for P3.
    const zeroBacklogClaimed =
      candidate.rawStatus === 'IN_SYNC' &&
      candidate.countsProven &&
      candidate.outbox_pending === 0 &&
      candidate.legacy_unreplayed === 0 &&
      candidate.effective_backlog === 0

    return {
      schemaVersion: CP0_SYNC_STATUS_PUBLISHER_SCHEMA,
      boardId,
      decision,
      published,
      lockHeld: true,
      pinStable: true,
      candidate,
      rawStatus: candidate.rawStatus,
      effectiveStatus: effectiveStatusForCandidate(candidate, measuredAtMs),
      zeroBacklogClaimed,
      countsProven: candidate.countsProven,
      reasonCode,
      reason,
      measuredAtMs,
      combined,
      tickId,
    }
  } catch (err) {
    return emptyResult({
      boardId,
      decision: 'SKIP_ERROR',
      reasonCode: 'PUBLISHER_ERROR',
      reason: reasonFor('PUBLISHER_ERROR', redactThrown(err)),
      lockHeld: lock?.held === true,
      tickId,
    })
  } finally {
    if (lock?.held) {
      try {
        await lock.release()
      } catch {
        // release errors must not escape; tick already decided
      }
    }
  }
}
