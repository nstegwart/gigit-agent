/**
 * Presentation helpers for adaptive mapping version info (addendum B).
 * Client/lib only — never recomputes readiness; formats pin/mapping progress labels.
 *
 * Server source of truth: `#/server/adaptive-mapping`.
 */

export type MappingModeView = 'FULL' | 'ADAPTIVE_DEGRADED' | string

/**
 * Wire shape accepted from server envelopes (loose — tolerate partial pins).
 */
export interface MappingVersionWire {
  schemaVersion?: string | null
  knownSchema?: boolean
  snapshotId?: string | null
  payloadSha256?: string | null
  canonicalHash?: string | null
  boardId?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  entityRev?: number | null
  generatedAt?: string | null
  freshnessAgeSeconds?: number | null
  stale?: boolean
  staleReason?: string | null
  distinctCounts?: Record<string, number> | null
  dynamicDenominator?: number | null
  presentFieldKeys?: ReadonlyArray<string> | null
  unknownFieldKeys?: ReadonlyArray<string> | null
  presentCollectionKeys?: ReadonlyArray<string> | null
  mode?: MappingModeView | null
  warnings?: ReadonlyArray<string> | null
  mappingIsNotReadiness?: boolean
}

/** Owner-visible banner fields for mapping version + live progress (not readiness). */
export interface MappingVersionBannerView {
  schemaVersion: string | null
  knownSchema: boolean
  mode: MappingModeView
  snapshotId: string | null
  canonicalHashShort: string | null
  payloadShaShort: string | null
  boardRev: number | null
  lifecycleRev: number | null
  freshnessAgeSeconds: number | null
  stale: boolean
  staleReason: string | null
  /** Distinct task count from current mapping — never a hardcoded 639. */
  dynamicDenominator: number
  presentFieldCount: number
  unknownFieldCount: number
  warnings: ReadonlyArray<string>
  /** Always true — mapping progress ≠ delivery readiness. */
  mappingIsNotReadiness: true
  /** One-line human label for IA shelves. */
  summaryLabel: string
}

function shortHash(h: string | null | undefined, n = 12): string | null {
  if (!h || typeof h !== 'string') return null
  const t = h.trim()
  if (!t) return null
  return t.length <= n ? t : t.slice(0, n)
}

function asFiniteNonNeg(n: unknown): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return 0
  return Math.floor(n)
}

/**
 * Map optional server mappingVersion wire → banner view.
 * Returns null when no useful mapping metadata is present.
 */
export function mappingVersionWireToBanner(
  raw: MappingVersionWire | null | undefined,
): MappingVersionBannerView | null {
  if (!raw || typeof raw !== 'object') return null

  const schemaVersion =
    typeof raw.schemaVersion === 'string' && raw.schemaVersion.trim()
      ? raw.schemaVersion.trim()
      : null
  const dynamicDenominator = asFiniteNonNeg(raw.dynamicDenominator)
  const mode = (raw.mode && String(raw.mode)) || (raw.knownSchema === false ? 'ADAPTIVE_DEGRADED' : 'FULL')
  const hasSignal =
    schemaVersion != null ||
    dynamicDenominator > 0 ||
    (typeof raw.snapshotId === 'string' && raw.snapshotId.trim().length > 0) ||
    (typeof raw.canonicalHash === 'string' && raw.canonicalHash.trim().length > 0)

  if (!hasSignal) return null

  const presentFieldCount = Array.isArray(raw.presentFieldKeys) ? raw.presentFieldKeys.length : 0
  const unknownFieldCount = Array.isArray(raw.unknownFieldKeys) ? raw.unknownFieldKeys.length : 0
  const stale = Boolean(raw.stale)
  const warnings = Array.isArray(raw.warnings) ? [...raw.warnings] : []

  const denLabel =
    dynamicDenominator > 0 ? `${dynamicDenominator} mapped tasks` : 'no mapped tasks yet'
  const modeLabel = mode === 'ADAPTIVE_DEGRADED' ? 'adaptive (unknown schema)' : 'mapping'
  const schemaBit = schemaVersion ? schemaVersion : 'schema unknown'
  const staleBit = stale ? ' · stale' : ''
  const summaryLabel = `${modeLabel}: ${schemaBit} · ${denLabel}${staleBit}`

  return {
    schemaVersion,
    knownSchema: Boolean(raw.knownSchema),
    mode,
    snapshotId:
      typeof raw.snapshotId === 'string' && raw.snapshotId.trim() ? raw.snapshotId.trim() : null,
    canonicalHashShort: shortHash(raw.canonicalHash),
    payloadShaShort: shortHash(raw.payloadSha256),
    boardRev: typeof raw.boardRev === 'number' && Number.isFinite(raw.boardRev) ? raw.boardRev : null,
    lifecycleRev:
      typeof raw.lifecycleRev === 'number' && Number.isFinite(raw.lifecycleRev)
        ? raw.lifecycleRev
        : null,
    freshnessAgeSeconds:
      typeof raw.freshnessAgeSeconds === 'number' && Number.isFinite(raw.freshnessAgeSeconds)
        ? raw.freshnessAgeSeconds
        : null,
    stale,
    staleReason:
      typeof raw.staleReason === 'string' && raw.staleReason.trim() ? raw.staleReason.trim() : null,
    dynamicDenominator,
    presentFieldCount,
    unknownFieldCount,
    warnings,
    mappingIsNotReadiness: true,
    summaryLabel,
  }
}

/**
 * Extract mappingVersion from a pinned envelope or overview data bag if present.
 * Never invents readiness numbers.
 */
export function extractMappingVersionWire(source: unknown): MappingVersionWire | null {
  if (!source || typeof source !== 'object') return null
  const o = source as Record<string, unknown>
  if (o.mappingVersion && typeof o.mappingVersion === 'object') {
    return o.mappingVersion
  }
  if (o.data && typeof o.data === 'object') {
    const d = o.data as Record<string, unknown>
    if (d.mappingVersion && typeof d.mappingVersion === 'object') {
      return d.mappingVersion
    }
  }
  return null
}
