/** Pure CP0 sync/backlog projection shared by health and MCP read surfaces. */

export type Cp0SyncStatusRow = {
  status: unknown
  outbox_pending: unknown
  legacy_unreplayed: unknown
  effective_backlog: unknown
  board_rev: unknown
  lifecycle_rev: unknown
  canonical_hash: unknown
  last_ack_revision: unknown
  freshness_at: unknown
  entity_rev: unknown
}

export type Cp0SyncStatusPin = {
  boardRev: number
  lifecycleRev: number
  canonicalHash: string
}

/** Authoritative readback: never green-by-raw-status alone when proof fails. */
export type Cp0SyncStatusReadback = {
  ok: true
  /** Authoritative status (masked when off-pin / stale / counts unproven). */
  status: string
  /** Raw DB status string for diagnostics; null when no row. */
  rawStatus: string | null
  boardRev: number
  lifecycleRev: number
  canonicalHash: string
  /** ISO freshness timestamp from the row; null when unparseable/missing. */
  observedAt: string | null
  stale: boolean
  parity: boolean
  current_outbox: number | null
  legacy_unreplayed: number | null
  effectiveBacklog: number | null
  zeroBacklogProven: boolean
  lastAckRevision: number | null
  entityRev: number | null
  /** Sanitized machine code; null when zero proven or trusted non-zero IN_SYNC. */
  blocker: string | null
  /** Sanitized human reason; never secrets or raw SQL. */
  reason: string | null
}

/** Healthz camelCase projection of the shared readback (proof fields included). */
export type Cp0HealthzSyncPayload = {
  status: string
  rawStatus: string | null
  effectiveBacklog: number | null
  zeroBacklogProven: boolean
  freshnessAt: string | null
  parity: boolean
  stale: boolean
  currentOutbox: number | null
  legacyUnreplayed: number | null
  lastAckRevision: number | null
  entityRev: number | null
  blocker: string | null
  reason: string | null
}

function finiteNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/** Bound raw status tokens for diagnostic surfaces (no free-form payload). */
function sanitizeStatusToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const cleaned = value
    .trim()
    .toUpperCase()
    .replace(/[^A-Z0-9_]/g, '')
    .slice(0, 32)
  return cleaned.length > 0 ? cleaned : null
}

function resolveBlockerReason(input: {
  hasRow: boolean
  parity: boolean
  fresh: boolean
  futureSkew: boolean
  countsProven: boolean
  rawStatus: string | null
  outbox: number | null
  legacy: number | null
  effective: number | null
  zeroBacklogProven: boolean
}): { blocker: string | null; reason: string | null } {
  if (!input.hasRow) {
    return {
      blocker: 'SYNC_ROW_MISSING',
      reason: 'sync status row absent for board',
    }
  }
  if (!input.parity) {
    return {
      blocker: 'SYNC_OFF_PIN',
      reason: 'sync row pin does not match current board pin',
    }
  }
  if (!input.fresh) {
    if (input.futureSkew) {
      return {
        blocker: 'SYNC_FUTURE_SKEW',
        reason: 'sync freshness_at ahead of now beyond skew allowance',
      }
    }
    return {
      blocker: 'SYNC_STALE',
      reason: 'sync freshness_at outside 120s window',
    }
  }
  if (!input.countsProven) {
    return {
      blocker: 'SYNC_COUNTS_UNPROVEN',
      reason: 'outbox/legacy/effective counts not all finite non-negative integers',
    }
  }
  if (input.zeroBacklogProven) {
    return { blocker: null, reason: null }
  }
  if (input.rawStatus !== 'IN_SYNC') {
    const token = input.rawStatus ?? 'UNKNOWN'
    return {
      blocker: 'SYNC_NOT_IN_SYNC',
      reason: `raw sync status is ${token}`,
    }
  }
  // Proven counts, fresh, on-pin, raw IN_SYNC, but non-zero backlog.
  return {
    blocker: 'SYNC_BACKLOG_NONZERO',
    reason: 'proven non-zero backlog counts',
  }
}

/**
 * Never turns missing, malformed, stale, or off-pin state into a zero-backlog
 * claim. Freshness permits five seconds of clock skew and expires at 120s.
 *
 * Primary `status` is authoritative: raw IN_SYNC is never reported when the
 * row is off-pin, stale (incl. future skew), or counts are unproven. Raw DB
 * status is preserved separately as `rawStatus` for diagnostics.
 */
export function buildCp0SyncStatusReadback(
  row: Cp0SyncStatusRow | null,
  pin: Cp0SyncStatusPin,
  nowMs = Date.now(),
): Cp0SyncStatusReadback {
  const hasRow = row != null
  const rowBoardRev = finiteNonNegativeInteger(row?.board_rev)
  const rowLifecycleRev = finiteNonNegativeInteger(row?.lifecycle_rev)
  const rowHash =
    typeof row?.canonical_hash === 'string' ? row.canonical_hash : null
  const rawFreshnessMs =
    row?.freshness_at == null
      ? Number.NaN
      : new Date(row.freshness_at as string | Date).getTime()
  const freshnessAt = Number.isFinite(rawFreshnessMs)
    ? new Date(rawFreshnessMs).toISOString()
    : null
  const freshnessMs = freshnessAt ? Date.parse(freshnessAt) : Number.NaN
  const futureSkew =
    Number.isFinite(freshnessMs) && freshnessMs - nowMs > 5_000
  const fresh =
    Number.isFinite(freshnessMs) &&
    nowMs - freshnessMs <= 120_000 &&
    freshnessMs - nowMs <= 5_000
  const parity =
    rowBoardRev === pin.boardRev &&
    rowLifecycleRev === pin.lifecycleRev &&
    rowHash === pin.canonicalHash
  const outbox = finiteNonNegativeInteger(row?.outbox_pending)
  const legacy = finiteNonNegativeInteger(row?.legacy_unreplayed)
  const effective = finiteNonNegativeInteger(row?.effective_backlog)
  const countsProven =
    parity && outbox !== null && legacy !== null && effective !== null

  const rawStatus = hasRow ? sanitizeStatusToken(row?.status) ?? 'UNKNOWN' : null
  const rawForProof = rawStatus ?? 'UNKNOWN'

  // Authoritative status: missing row stays UNKNOWN; unproven rows never report
  // raw IN_SYNC (or any other trusted green) — expose READBACK_REQUIRED.
  let status: string
  if (!hasRow) {
    status = 'UNKNOWN'
  } else if (!parity || !fresh || !countsProven) {
    status = 'READBACK_REQUIRED'
  } else {
    status = rawForProof
  }

  const zeroBacklogProven =
    countsProven &&
    fresh &&
    rawForProof === 'IN_SYNC' &&
    outbox === 0 &&
    legacy === 0 &&
    effective === 0

  const { blocker, reason } = resolveBlockerReason({
    hasRow,
    parity,
    fresh,
    futureSkew,
    countsProven,
    rawStatus,
    outbox,
    legacy,
    effective,
    zeroBacklogProven,
  })

  return {
    ok: true,
    status,
    rawStatus,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    canonicalHash: pin.canonicalHash,
    observedAt: freshnessAt,
    stale: !fresh,
    parity,
    current_outbox: countsProven ? outbox : null,
    legacy_unreplayed: countsProven ? legacy : null,
    effectiveBacklog: countsProven ? effective : null,
    zeroBacklogProven,
    lastAckRevision: finiteNonNegativeInteger(row?.last_ack_revision),
    entityRev: finiteNonNegativeInteger(row?.entity_rev),
    blocker,
    reason,
  }
}

/** Map shared readback → healthz sync object (camelCase proof fields). */
export function toHealthzSyncPayload(
  readback: Cp0SyncStatusReadback,
): Cp0HealthzSyncPayload {
  return {
    status: readback.status,
    rawStatus: readback.rawStatus,
    effectiveBacklog: readback.effectiveBacklog,
    zeroBacklogProven: readback.zeroBacklogProven,
    freshnessAt: readback.observedAt,
    parity: readback.parity,
    stale: readback.stale,
    currentOutbox: readback.current_outbox,
    legacyUnreplayed: readback.legacy_unreplayed,
    lastAckRevision: readback.lastAckRevision,
    entityRev: readback.entityRev,
    blocker: readback.blocker,
    reason: readback.reason,
  }
}
