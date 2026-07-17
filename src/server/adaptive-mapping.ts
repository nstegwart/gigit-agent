/**
 * Version-ADAPTIVE mapping ingest (Requirement #2 / addendum B).
 *
 * Source of truth = whatever is currently pinned as the canonical mapping.
 * Never hard-codes denominators (639/316/…) or assumes a single forever schema.
 *
 * Modes:
 * - FULL: known schema (currently MFS_CANONICAL_TASK_SNAPSHOT_V1) fully validated path inputs
 * - ADAPTIVE_DEGRADED: unknown / future schemaVersion — surface pin metadata + best-effort
 *   field extraction; do not crash UI/MCP consumers; never fabricate readiness
 *
 * Import APPLY remains strict (canonical-snapshot validateCanonicalSnapshot). This module is
 * for read / progress / UI / MCP view derivation.
 */
import {
  CANONICAL_SNAPSHOT_SCHEMA,
  computeDistinctCounts
  
  
  
} from '#/server/canonical-snapshot'
import type {CanonicalSnapshot, CanonicalSnapshotPayload, DistinctCounts} from '#/server/canonical-snapshot';
import type { CanonicalDefinitionPin, CanonicalDefinitionProjection } from '#/server/canonical-read-model'

// ---------------------------------------------------------------------------
// Known schemas (extensible — add entries as versions ship; never hardcode counts)
// ---------------------------------------------------------------------------

/** Schemas the adaptive reader fully understands today. */
export const KNOWN_MAPPING_SCHEMA_VERSIONS = [CANONICAL_SNAPSHOT_SCHEMA] as const

export type KnownMappingSchemaVersion = (typeof KNOWN_MAPPING_SCHEMA_VERSIONS)[number]

export function isKnownMappingSchemaVersion(v: string | null | undefined): v is KnownMappingSchemaVersion {
  if (!v || typeof v !== 'string') return false
  return (KNOWN_MAPPING_SCHEMA_VERSIONS as ReadonlyArray<string>).includes(v)
}

/** Default baseline task keys expected on V1; extra keys are tracked as unknown/present. */
export const BASELINE_TASK_FIELD_KEYS = [
  'id',
  'projectId',
  'featureContractId',
  'title',
  'objective',
] as const

export const DEFAULT_STALE_AFTER_SECONDS = 15 * 60

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type MappingIngestMode = 'FULL' | 'ADAPTIVE_DEGRADED'

export interface MappingFreshness {
  generatedAt: string | null
  freshnessAgeSeconds: number | null
  stale: boolean
  staleReason: string | null
  staleAfterSeconds: number
}

/**
 * Active mapping version + live progress authority surface.
 * Denominators always come from DISTINCT counts of the current pin payload — never constants.
 */
export interface MappingVersionInfo {
  schemaVersion: string
  knownSchema: boolean
  snapshotId: string | null
  payloadSha256: string | null
  canonicalHash: string | null
  boardId: string | null
  boardRev: number | null
  lifecycleRev: number | null
  entityRev: number | null
  generatedAt: string | null
  freshnessAgeSeconds: number | null
  stale: boolean
  staleReason: string | null
  /** Dynamic counts from actual payload arrays (keys may grow with schema evolution). */
  distinctCounts: Readonly<Record<string, number>>
  /**
   * Primary progress denominator = distinct task count in current mapping.
   * Grows with the mapping (3 → 639 → 2300+); never a hardcoded constant.
   */
  dynamicDenominator: number
  /** Field keys observed on task entities (adaptive columns/filters). */
  presentFieldKeys: ReadonlyArray<string>
  /** Task field keys present that are outside the V1 baseline set. */
  unknownFieldKeys: ReadonlyArray<string>
  /** Payload top-level collection keys actually present. */
  presentCollectionKeys: ReadonlyArray<string>
  mode: MappingIngestMode
  warnings: ReadonlyArray<string>
  /**
   * Explicit non-readiness flag: mapping detail / MAP_VERIFIED style progress must never
   * masquerade as delivery readiness (addendum B).
   */
  mappingIsNotReadiness: true
}

export interface AdaptiveMappingIngestResult {
  ok: true
  version: MappingVersionInfo
  /** Best-effort payload view; may be partial when degraded. */
  payload: AdaptivePayloadView
  /** Original raw preserved for passthrough of unknown fields. */
  raw: unknown
}

export interface AdaptivePayloadView {
  tasks: Array<Record<string, unknown>>
  projects: Array<Record<string, unknown>>
  flows: Array<Record<string, unknown>>
  nodes: Array<Record<string, unknown>>
  classifications: Array<Record<string, unknown>>
  /** All other top-level array collections discovered on the payload. */
  extraCollections: Record<string, Array<Record<string, unknown>>>
}

export interface MappingVersionFromPinInput {
  pin?: Partial<CanonicalDefinitionPin> | null
  snapshot?: CanonicalSnapshot | null
  projection?: CanonicalDefinitionProjection | null
  /** When snapshot is missing, supply raw payload-like object for degraded ingest. */
  rawPayload?: unknown
  /** Override schema when only pin metadata is available. */
  schemaVersion?: string | null
  now?: Date | number
  staleAfterSeconds?: number
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | null {
  if (v && typeof v === 'object' && !Array.isArray(v)) return v as Record<string, unknown>
  return null
}

function asObjectArray(v: unknown): Array<Record<string, unknown>> {
  if (!Array.isArray(v)) return []
  return v.filter((row) => row && typeof row === 'object' && !Array.isArray(row)) as Array<
    Record<string, unknown>
  >
}

function finiteNonNegInt(n: unknown, fallback = 0): number {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return fallback
  return Math.floor(n)
}

/**
 * Derive the live denominator from whatever task-like array is present.
 * Never returns a hardcoded historical count.
 */
export function deriveDynamicDenominator(
  source:
    | { tasks?: ReadonlyArray<unknown> | null; distinctCounts?: { tasks?: number } | null }
    | null
    | undefined,
): number {
  if (!source) return 0
  if (source.distinctCounts && typeof source.distinctCounts.tasks === 'number') {
    return finiteNonNegInt(source.distinctCounts.tasks, 0)
  }
  if (Array.isArray(source.tasks)) {
    const ids = new Set<string>()
    for (const t of source.tasks) {
      const row = asRecord(t)
      if (row && typeof row.id === 'string' && row.id.trim()) ids.add(row.id.trim())
      else if (row && typeof row.taskId === 'string' && row.taskId.trim()) ids.add(row.taskId.trim())
      else if (row) ids.add(`anon:${ids.size}`)
    }
    // Prefer DISTINCT ids when present; else array length for anonymous rows.
    if (ids.size > 0) return ids.size
    return source.tasks.length
  }
  return 0
}

/**
 * Collect field keys present across entities for adaptive columns/filters.
 * `unknownFieldKeys` = keys outside the provided baseline (default V1 task baseline).
 */
export function adaptPresentFields(
  entities: ReadonlyArray<Record<string, unknown>>,
  baselineKeys: ReadonlyArray<string> = BASELINE_TASK_FIELD_KEYS,
): { presentFieldKeys: string[]; unknownFieldKeys: string[] } {
  const present = new Set<string>()
  for (const row of entities) {
    for (const k of Object.keys(row)) present.add(k)
  }
  const presentFieldKeys = [...present].sort()
  const baseline = new Set(baselineKeys)
  const unknownFieldKeys = presentFieldKeys.filter((k) => !baseline.has(k))
  return { presentFieldKeys, unknownFieldKeys }
}

/**
 * Freshness from mapping generatedAt / pin timestamp.
 * stale when age exceeds staleAfterSeconds (default 15m) or generatedAt unparsable with pin present.
 */
export function computeMappingFreshness(
  generatedAt: string | null | undefined,
  opts: { now?: Date | number; staleAfterSeconds?: number; forceStaleReason?: string | null } = {},
): MappingFreshness {
  const staleAfterSeconds =
    typeof opts.staleAfterSeconds === 'number' && Number.isFinite(opts.staleAfterSeconds)
      ? Math.max(0, Math.floor(opts.staleAfterSeconds))
      : DEFAULT_STALE_AFTER_SECONDS
  const nowMs =
    opts.now instanceof Date
      ? opts.now.getTime()
      : typeof opts.now === 'number'
        ? opts.now
        : Date.now()

  if (opts.forceStaleReason) {
    return {
      generatedAt: generatedAt ?? null,
      freshnessAgeSeconds: null,
      stale: true,
      staleReason: opts.forceStaleReason,
      staleAfterSeconds,
    }
  }

  if (generatedAt == null || !String(generatedAt).trim()) {
    return {
      generatedAt: null,
      freshnessAgeSeconds: null,
      stale: true,
      staleReason: 'MAPPING_GENERATED_AT_MISSING',
      staleAfterSeconds,
    }
  }

  const parsed = Date.parse(String(generatedAt))
  if (!Number.isFinite(parsed)) {
    return {
      generatedAt: String(generatedAt),
      freshnessAgeSeconds: null,
      stale: true,
      staleReason: 'MAPPING_GENERATED_AT_UNPARSEABLE',
      staleAfterSeconds,
    }
  }

  const ageSec = Math.max(0, Math.floor((nowMs - parsed) / 1000))
  const stale = ageSec > staleAfterSeconds
  return {
    generatedAt: String(generatedAt),
    freshnessAgeSeconds: ageSec,
    stale,
    staleReason: stale ? 'MAPPING_STALE' : null,
    staleAfterSeconds,
  }
}

/** Distinct counts from a typed V1 payload — thin wrapper for adaptive consumers. */
export function distinctCountsFromPayload(payload: CanonicalSnapshotPayload): DistinctCounts {
  return computeDistinctCounts(payload)
}

/**
 * Distinct counts from an arbitrary payload-shaped object.
 * Counts only collections that are arrays; never invents missing collections as non-zero.
 */
export function computeDynamicDistinctCounts(payload: unknown): Record<string, number> {
  const root = asRecord(payload)
  if (!root) return { tasks: 0 }

  const out: Record<string, number> = {}
  for (const [key, val] of Object.entries(root)) {
    if (!Array.isArray(val)) continue
    const rows = asObjectArray(val)
    if (rows.length === 0) {
      out[key] = val.length
      continue
    }
    // Prefer id / taskId DISTINCT when available
    const ids = new Set<string>()
    let hasId = false
    for (const row of rows) {
      if (typeof row.id === 'string' && row.id.trim()) {
        hasId = true
        ids.add(row.id.trim())
      } else if (typeof row.taskId === 'string' && row.taskId.trim()) {
        hasId = true
        ids.add(row.taskId.trim())
      } else if (
        typeof row.fromTaskId === 'string' &&
        typeof row.toTaskId === 'string'
      ) {
        hasId = true
        ids.add(`${row.fromTaskId}\0${row.toTaskId}`)
      } else if (
        typeof row.featureContractId === 'string' &&
        typeof row.taskId === 'string'
      ) {
        hasId = true
        ids.add(`${row.featureContractId}\0${row.taskId}`)
      } else if (typeof row.nodeId === 'string' && typeof row.taskId === 'string') {
        hasId = true
        ids.add(`${row.nodeId}\0${row.taskId}`)
      }
    }
    out[key] = hasId ? ids.size : rows.length
  }
  if (typeof out.tasks !== 'number') out.tasks = 0
  return out
}

export function buildAdaptivePayloadView(payload: unknown): AdaptivePayloadView {
  const root = asRecord(payload) ?? {}
  const known = new Set([
    'projects',
    'flows',
    'nodes',
    'tasks',
    'classifications',
  ])
  const extraCollections: Record<string, Array<Record<string, unknown>>> = {}
  for (const [k, v] of Object.entries(root)) {
    if (known.has(k)) continue
    if (Array.isArray(v)) extraCollections[k] = asObjectArray(v)
  }
  return {
    tasks: asObjectArray(root.tasks),
    projects: asObjectArray(root.projects),
    flows: asObjectArray(root.flows),
    nodes: asObjectArray(root.nodes),
    classifications: asObjectArray(root.classifications),
    extraCollections,
  }
}

// ---------------------------------------------------------------------------
// Ingest
// ---------------------------------------------------------------------------

function emptyVersion(warnings: string[], mode: MappingIngestMode = 'ADAPTIVE_DEGRADED'): MappingVersionInfo {
  return {
    schemaVersion: '',
    knownSchema: false,
    snapshotId: null,
    payloadSha256: null,
    canonicalHash: null,
    boardId: null,
    boardRev: null,
    lifecycleRev: null,
    entityRev: null,
    generatedAt: null,
    freshnessAgeSeconds: null,
    stale: true,
    staleReason: 'MAPPING_EMPTY',
    distinctCounts: { tasks: 0 },
    dynamicDenominator: 0,
    presentFieldKeys: [],
    unknownFieldKeys: [],
    presentCollectionKeys: [],
    mode,
    warnings,
    mappingIsNotReadiness: true,
  }
}

/**
 * Ingest an arbitrary mapping snapshot-like value into MappingVersionInfo.
 * Accepts:
 * - full { manifest, payload } envelopes
 * - raw payload objects with optional schemaVersion
 * - null/undefined → degraded empty with warnings
 */
export function ingestMappingSnapshot(
  raw: unknown,
  opts: {
    now?: Date | number
    staleAfterSeconds?: number
    pin?: Partial<CanonicalDefinitionPin> | null
  } = {},
): AdaptiveMappingIngestResult {
  const warnings: string[] = []
  if (raw == null) {
    warnings.push('MAPPING_RAW_NULL')
    return {
      ok: true,
      version: emptyVersion(warnings),
      payload: buildAdaptivePayloadView(null),
      raw,
    }
  }

  const root = asRecord(raw)
  if (!root) {
    warnings.push('MAPPING_RAW_NOT_OBJECT')
    return {
      ok: true,
      version: emptyVersion(warnings),
      payload: buildAdaptivePayloadView(null),
      raw,
    }
  }

  // Envelope form: { manifest, payload }
  const manifest = asRecord(root.manifest)
  const payloadNode = root.payload != null ? root.payload : manifest ? null : root
  const payload = payloadNode != null ? payloadNode : root

  const schemaVersion =
    (manifest && typeof manifest.schemaVersion === 'string' && manifest.schemaVersion) ||
    (typeof root.schemaVersion === 'string' && root.schemaVersion) ||
    ''

  const knownSchema = isKnownMappingSchemaVersion(schemaVersion)
  if (!schemaVersion) warnings.push('MAPPING_SCHEMA_VERSION_MISSING')
  else if (!knownSchema) warnings.push(`MAPPING_SCHEMA_UNKNOWN:${schemaVersion}`)

  const view = buildAdaptivePayloadView(payload)
  const distinctCounts = computeDynamicDistinctCounts(payload)
  const dynamicDenominator = deriveDynamicDenominator({
    tasks: view.tasks,
    distinctCounts: { tasks: distinctCounts.tasks },
  })

  const fieldInfo = adaptPresentFields(view.tasks)
  const presentCollectionKeys = Object.keys(asRecord(payload) ?? {})
    .filter((k) => Array.isArray((asRecord(payload) as Record<string, unknown>)[k]))
    .sort()

  const generatedAt =
    (manifest && typeof manifest.generatedAt === 'string' && manifest.generatedAt) ||
    (typeof root.generatedAt === 'string' && root.generatedAt) ||
    opts.pin?.lastSnapshotGeneratedAt ||
    null

  const freshness = computeMappingFreshness(generatedAt, {
    now: opts.now,
    staleAfterSeconds: opts.staleAfterSeconds,
  })

  const snapshotId =
    (manifest && typeof manifest.snapshotId === 'string' && manifest.snapshotId) ||
    (typeof root.snapshotId === 'string' && root.snapshotId) ||
    opts.pin?.canonicalSnapshotId ||
    null

  const payloadSha256 =
    (manifest && typeof manifest.payloadSha256 === 'string' && manifest.payloadSha256) ||
    (typeof root.payloadSha256 === 'string' && root.payloadSha256) ||
    opts.pin?.payloadSha256 ||
    null

  const mode: MappingIngestMode = knownSchema ? 'FULL' : 'ADAPTIVE_DEGRADED'

  // Preserve unknown task fields in view (already on records); soft-warn only.
  if (fieldInfo.unknownFieldKeys.length > 0) {
    warnings.push(`UNKNOWN_TASK_FIELDS:${fieldInfo.unknownFieldKeys.join(',')}`)
  }

  const version: MappingVersionInfo = {
    schemaVersion: schemaVersion || 'UNKNOWN',
    knownSchema,
    snapshotId,
    payloadSha256,
    canonicalHash: opts.pin?.canonicalHash ?? null,
    boardId:
      (manifest && typeof manifest.boardId === 'string' && manifest.boardId) ||
      opts.pin?.boardId ||
      null,
    boardRev: opts.pin?.boardRev ?? null,
    lifecycleRev: opts.pin?.lifecycleRev ?? null,
    entityRev: opts.pin?.entityRev ?? null,
    generatedAt: freshness.generatedAt,
    freshnessAgeSeconds: freshness.freshnessAgeSeconds,
    stale: freshness.stale,
    staleReason: freshness.staleReason,
    distinctCounts,
    dynamicDenominator,
    presentFieldKeys: fieldInfo.presentFieldKeys,
    unknownFieldKeys: fieldInfo.unknownFieldKeys,
    presentCollectionKeys,
    mode,
    warnings,
    mappingIsNotReadiness: true,
  }

  return { ok: true, version, payload: view, raw }
}

/**
 * Build MappingVersionInfo from a loaded pin + projection/snapshot (happy path).
 * Prefer this after loadPinnedDefinitionReadModel succeeds.
 */
export function mappingVersionFromPinAndProjection(
  input: MappingVersionFromPinInput,
): MappingVersionInfo {
  const pin = input.pin ?? null
  const snapshot = input.snapshot ?? null
  const projection = input.projection ?? null

  if (snapshot) {
    const ingested = ingestMappingSnapshot(snapshot, {
      now: input.now,
      staleAfterSeconds: input.staleAfterSeconds,
      pin,
    })
    // Overlay pin revs / hash authority
    return {
      ...ingested.version,
      canonicalHash: pin?.canonicalHash ?? ingested.version.canonicalHash,
      boardRev: pin?.boardRev ?? ingested.version.boardRev,
      lifecycleRev: pin?.lifecycleRev ?? ingested.version.lifecycleRev,
      entityRev: pin?.entityRev ?? ingested.version.entityRev,
      boardId: pin?.boardId ?? ingested.version.boardId,
      snapshotId: pin?.canonicalSnapshotId ?? ingested.version.snapshotId,
      payloadSha256: pin?.payloadSha256 ?? ingested.version.payloadSha256,
      // Prefer typed DISTINCT when projection present
      dynamicDenominator: projection
        ? deriveDynamicDenominator({
            tasks: projection.tasks,
            distinctCounts: projection.distinctCounts,
          })
        : ingested.version.dynamicDenominator,
      distinctCounts: projection
        ? { ...projection.distinctCounts }
        : ingested.version.distinctCounts,
      mappingIsNotReadiness: true,
    }
  }

  if (projection) {
    const fieldInfo = adaptPresentFields(
      projection.tasks,
    )
    const generatedAt = pin?.lastSnapshotGeneratedAt ?? null
    const freshness = computeMappingFreshness(generatedAt, {
      now: input.now,
      staleAfterSeconds: input.staleAfterSeconds,
    })
    const schemaVersion =
      (typeof input.schemaVersion === 'string' && input.schemaVersion) ||
      CANONICAL_SNAPSHOT_SCHEMA
    return {
      schemaVersion,
      knownSchema: isKnownMappingSchemaVersion(schemaVersion),
      snapshotId: pin?.canonicalSnapshotId ?? null,
      payloadSha256: pin?.payloadSha256 ?? null,
      canonicalHash: pin?.canonicalHash ?? null,
      boardId: pin?.boardId ?? null,
      boardRev: pin?.boardRev ?? null,
      lifecycleRev: pin?.lifecycleRev ?? null,
      entityRev: pin?.entityRev ?? null,
      generatedAt: freshness.generatedAt,
      freshnessAgeSeconds: freshness.freshnessAgeSeconds,
      stale: freshness.stale,
      staleReason: freshness.staleReason,
      distinctCounts: { ...projection.distinctCounts },
      dynamicDenominator: deriveDynamicDenominator({
        tasks: projection.tasks,
        distinctCounts: projection.distinctCounts,
      }),
      presentFieldKeys: fieldInfo.presentFieldKeys,
      unknownFieldKeys: fieldInfo.unknownFieldKeys,
      presentCollectionKeys: [
        'projects',
        'flows',
        'nodes',
        'tasks',
        'dependencies',
        'featureContractJoins',
        'nodeJoins',
        'primaryOwnerships',
        'classifications',
        'anchors',
        'acceptancePaths',
      ],
      mode: isKnownMappingSchemaVersion(schemaVersion) ? 'FULL' : 'ADAPTIVE_DEGRADED',
      warnings: isKnownMappingSchemaVersion(schemaVersion)
        ? []
        : [`MAPPING_SCHEMA_UNKNOWN:${schemaVersion}`],
      mappingIsNotReadiness: true,
    }
  }

  if (input.rawPayload != null) {
    return ingestMappingSnapshot(input.rawPayload, {
      now: input.now,
      staleAfterSeconds: input.staleAfterSeconds,
      pin,
    }).version
  }

  // Pin-only degraded surface (no payload yet)
  const generatedAt = pin?.lastSnapshotGeneratedAt ?? null
  const freshness = computeMappingFreshness(generatedAt, {
    now: input.now,
    staleAfterSeconds: input.staleAfterSeconds,
    forceStaleReason: pin ? 'MAPPING_PAYLOAD_UNAVAILABLE' : 'MAPPING_PIN_MISSING',
  })
  return {
    schemaVersion:
      (typeof input.schemaVersion === 'string' && input.schemaVersion) || 'UNKNOWN',
    knownSchema: isKnownMappingSchemaVersion(input.schemaVersion ?? null),
    snapshotId: pin?.canonicalSnapshotId ?? null,
    payloadSha256: pin?.payloadSha256 ?? null,
    canonicalHash: pin?.canonicalHash ?? null,
    boardId: pin?.boardId ?? null,
    boardRev: pin?.boardRev ?? null,
    lifecycleRev: pin?.lifecycleRev ?? null,
    entityRev: pin?.entityRev ?? null,
    generatedAt: freshness.generatedAt,
    freshnessAgeSeconds: freshness.freshnessAgeSeconds,
    stale: true,
    staleReason: freshness.staleReason,
    distinctCounts: { tasks: 0 },
    dynamicDenominator: 0,
    presentFieldKeys: [],
    unknownFieldKeys: [],
    presentCollectionKeys: [],
    mode: 'ADAPTIVE_DEGRADED',
    warnings: ['MAPPING_PAYLOAD_UNAVAILABLE'],
    mappingIsNotReadiness: true,
  }
}

/**
 * Guard: progress % from mapping membership must not be labeled readiness.
 * Returns a labeled progress object for UI banners.
 */
export function mappingLiveProgress(
  version: MappingVersionInfo,
  completedInMapping: number,
): {
  completed: number
  denominator: number
  percent: number | null
  label: 'mapping_progress'
  notReadiness: true
  mode: MappingIngestMode
  stale: boolean
} {
  const denominator = version.dynamicDenominator
  const completed = Math.max(0, Math.min(finiteNonNegInt(completedInMapping), denominator))
  const percent =
    denominator > 0 ? Math.round((completed / denominator) * 1000) / 10 : null
  return {
    completed,
    denominator,
    percent,
    label: 'mapping_progress',
    notReadiness: true,
    mode: version.mode,
    stale: version.stale,
  }
}

/**
 * Presentation-safe subset for lib adapters / MCP / server-fn wire (no secrets).
 * Explicit fields only — `Record<string, unknown>` is not TanStack-serializable.
 */
export interface MappingVersionWirePayload {
  schemaVersion: string
  knownSchema: boolean
  snapshotId: string | null
  payloadSha256: string | null
  canonicalHash: string | null
  boardId: string | null
  boardRev: number | null
  lifecycleRev: number | null
  entityRev: number | null
  generatedAt: string | null
  freshnessAgeSeconds: number | null
  stale: boolean
  staleReason: string | null
  distinctCounts: Record<string, number>
  dynamicDenominator: number
  presentFieldKeys: string[]
  unknownFieldKeys: string[]
  presentCollectionKeys: string[]
  mode: MappingIngestMode
  warnings: string[]
  mappingIsNotReadiness: true
}

/**
 * Presentation-safe subset for lib adapters / MCP (no secrets).
 */
export function mappingVersionToWire(version: MappingVersionInfo): MappingVersionWirePayload {
  return {
    schemaVersion: version.schemaVersion,
    knownSchema: version.knownSchema,
    snapshotId: version.snapshotId,
    payloadSha256: version.payloadSha256,
    canonicalHash: version.canonicalHash,
    boardId: version.boardId,
    boardRev: version.boardRev,
    lifecycleRev: version.lifecycleRev,
    entityRev: version.entityRev,
    generatedAt: version.generatedAt,
    freshnessAgeSeconds: version.freshnessAgeSeconds,
    stale: version.stale,
    staleReason: version.staleReason,
    distinctCounts: { ...version.distinctCounts },
    dynamicDenominator: version.dynamicDenominator,
    presentFieldKeys: [...version.presentFieldKeys],
    unknownFieldKeys: [...version.unknownFieldKeys],
    presentCollectionKeys: [...version.presentCollectionKeys],
    mode: version.mode,
    warnings: [...version.warnings],
    mappingIsNotReadiness: true as const,
  }
}
