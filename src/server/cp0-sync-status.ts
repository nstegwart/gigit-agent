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

function finiteNonNegativeInteger(value: unknown): number | null {
  if (value === null || value === undefined || typeof value === 'boolean') {
    return null
  }
  const parsed = Number(value)
  return Number.isInteger(parsed) && parsed >= 0 ? parsed : null
}

/**
 * Never turns missing, malformed, stale, or off-pin state into a zero-backlog
 * claim. Freshness permits five seconds of clock skew and expires at 120s.
 */
export function buildCp0SyncStatusReadback(
  row: Cp0SyncStatusRow | null,
  pin: Cp0SyncStatusPin,
  nowMs = Date.now(),
) {
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
  const status = typeof row?.status === 'string' ? row.status : 'UNKNOWN'

  return {
    ok: true,
    status,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    canonicalHash: pin.canonicalHash,
    observedAt: freshnessAt,
    stale: !fresh,
    parity,
    current_outbox: countsProven ? outbox : null,
    legacy_unreplayed: countsProven ? legacy : null,
    effectiveBacklog: countsProven ? effective : null,
    zeroBacklogProven:
      countsProven &&
      fresh &&
      status === 'IN_SYNC' &&
      outbox === 0 &&
      legacy === 0 &&
      effective === 0,
    lastAckRevision: finiteNonNegativeInteger(row?.last_ack_revision),
    entityRev: finiteNonNegativeInteger(row?.entity_rev),
  }
}
