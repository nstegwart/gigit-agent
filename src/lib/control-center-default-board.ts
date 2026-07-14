/**
 * Default control-center board for ART top-level aliases (S01–S24).
 * Nine board-prefixed IA remains the product truth; top-level paths resolve here.
 */
export const DEFAULT_CONTROL_CENTER_BOARD_ID = 'mfs-rebuild' as const

export type DefaultControlCenterBoardId = typeof DEFAULT_CONTROL_CENTER_BOARD_ID

/** Resolve default human control-center board (always mfs-rebuild product pin). */
export function resolveDefaultControlCenterBoardId(): DefaultControlCenterBoardId {
  return DEFAULT_CONTROL_CENTER_BOARD_ID
}

/**
 * Normalize ART work search before board redirect.
 * S08: RECONCILIATION → RECONCILIATION_PENDING (human-display normalizeStatusBucket).
 * Pass-through other keys; never invents bucket membership.
 */
export function normalizeArtWorkSearch(
  search: Record<string, unknown> | undefined | null,
): Record<string, string | undefined> {
  const raw =
    search && typeof search === 'object' && !Array.isArray(search)
      ? (search as Record<string, unknown>)
      : {}
  const out: Record<string, string | undefined> = {}
  for (const [k, v] of Object.entries(raw)) {
    if (v === undefined || v === null || v === '') continue
    if (typeof v === 'string') out[k] = v
    else if (typeof v === 'number' && Number.isFinite(v)) out[k] = String(v)
    else if (typeof v === 'boolean') out[k] = v ? 'true' : 'false'
  }
  const bucket = out.bucket
  if (typeof bucket === 'string' && bucket.toUpperCase() === 'RECONCILIATION') {
    out.bucket = 'RECONCILIATION_PENDING'
  }
  return out
}
