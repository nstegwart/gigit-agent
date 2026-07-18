/**
 * CP0 sync-status fail-closed measurement primitives (PACKET-P1).
 *
 * Pure / injectable count measures for a future continuous publisher.
 * Does NOT write DB, schedule ticks, or claim live zero backlog.
 *
 * Effective backlog combination (documented + tested):
 *   when outbox AND legacy are both proven finite non-negative integers
 *   and their sum is a safe integer:
 *     effective = outbox + legacy
 *   otherwise effective is unproven (value null). Partial proof ⇒ combined unproven.
 *
 * Default / no-source measures ALWAYS return proven:false with value:null.
 * Never coerce undefined/null/missing into a proven zero.
 */

/** Schema id for measure diagnostic envelopes (no secrets). */
export const CP0_SYNC_STATUS_MEASURES_SCHEMA = 'CP0_SYNC_STATUS_MEASURES_V1' as const

/**
 * Max age for a measure to remain usable when assembling a combined snapshot.
 * Matches the recommended continuous-publish renew interval (30s). Older
 * cached values are treated as unproven so stale zeros cannot re-enter a claim.
 */
export const CP0_MEASURE_DEFAULT_MAX_AGE_MS = 30_000 as const

/** Upper bound accepted for a single count (safe integer domain). */
export const CP0_MEASURE_MAX_SAFE_COUNT = Number.MAX_SAFE_INTEGER

/** Known machine reason codes (sanitized; never secrets/SQL). */
export type Cp0MeasureReasonCode =
  | 'NO_SOURCE'
  | 'SOURCE_UNAVAILABLE'
  | 'VALUE_MISSING'
  | 'VALUE_NOT_INTEGER'
  | 'VALUE_NEGATIVE'
  | 'VALUE_OVERFLOW'
  | 'VALUE_NON_FINITE'
  | 'PARTIAL_PROOF'
  | 'STALE_MEASURE'
  | 'MEASURE_ERROR'
  | 'COMBINE_OVERFLOW'
  | 'UNKNOWN'

export type Cp0CountMeasureName = 'outbox_pending' | 'legacy_unreplayed' | 'effective_backlog'

/** Non-secret source metadata retained on every measure result. */
export type Cp0MeasureSourceMeta = {
  /** Stable short source id, e.g. "default-unproven", "fixture", "outbox-table". */
  id: string
  /** Optional human label (sanitized; free of secrets). */
  label?: string
}

type MeasureBase = {
  name: Cp0CountMeasureName
  source: Cp0MeasureSourceMeta
  /** Epoch ms when this measure was produced. */
  measuredAtMs: number
  /** Sanitized machine reason code. */
  reasonCode: Cp0MeasureReasonCode
  /** Sanitized human reason; never secrets. */
  reason: string
}

/** Proven count: explicit finite non-negative integer. */
export type Cp0ProvenCountMeasure = MeasureBase & {
  proven: true
  value: number
}

/**
 * Unproven count: value is ALWAYS null.
 * Callers must never treat absence as zero.
 */
export type Cp0UnprovenCountMeasure = MeasureBase & {
  proven: false
  value: null
}

export type Cp0CountMeasureResult = Cp0ProvenCountMeasure | Cp0UnprovenCountMeasure

/**
 * Combined measurement for the three sync-status count columns.
 * `countsProven` is true only when outbox, legacy, AND effective are all proven.
 * Partial proof forces the whole bundle unproven for publisher write decisions.
 */
export type Cp0CombinedBacklogMeasure = {
  schemaVersion: typeof CP0_SYNC_STATUS_MEASURES_SCHEMA
  outbox: Cp0CountMeasureResult
  legacy: Cp0CountMeasureResult
  effective: Cp0CountMeasureResult
  /** True iff outbox, legacy, and effective are all proven. */
  countsProven: boolean
  /** Wall-clock used when assembling / freshness-checking. */
  assembledAtMs: number
  /** Aggregate sanitized reason when not fully proven; null when proven. */
  reasonCode: Cp0MeasureReasonCode | null
  reason: string | null
}

/** Context passed to injectable measurers (no secrets). */
export type Cp0MeasureContext = {
  boardId: string
  /** Clock for measuredAt / freshness; inject for tests. */
  nowMs: number
}

/**
 * Future real SSOT hooks: implement these with table COUNTs / residual scans.
 * Defaults must remain fail-closed unproven until real sources land (PACKET-P3).
 */
export type Cp0CountMeasurer = (
  ctx: Cp0MeasureContext,
) => Cp0CountMeasureResult | Promise<Cp0CountMeasureResult>

export type Cp0SyncStatusMeasureDeps = {
  measureOutbox: Cp0CountMeasurer
  measureLegacy: Cp0CountMeasurer
  /**
   * Max age (ms) for component measures relative to assemble time.
   * Defaults to CP0_MEASURE_DEFAULT_MAX_AGE_MS.
   */
  maxMeasureAgeMs?: number
}

const REASON_TEXT: Record<Cp0MeasureReasonCode, string> = {
  NO_SOURCE: 'no count source configured; measure remains unproven',
  SOURCE_UNAVAILABLE: 'count source unavailable; measure remains unproven',
  VALUE_MISSING: 'count value missing or undefined; not coerced to zero',
  VALUE_NOT_INTEGER: 'count value is not a finite integer',
  VALUE_NEGATIVE: 'count value is negative; rejected',
  VALUE_OVERFLOW: 'count value exceeds safe integer range',
  VALUE_NON_FINITE: 'count value is non-finite',
  PARTIAL_PROOF: 'partial proof; combined measurement unproven',
  STALE_MEASURE: 'measure older than max age; treated as unproven',
  MEASURE_ERROR: 'measurer threw or failed; fail-closed unproven',
  COMBINE_OVERFLOW: 'outbox + legacy overflows safe integer range',
  UNKNOWN: 'count unproven for unknown reason',
}

/** Sanitize free-form reason strings (length-bound; no control chars). */
export function sanitizeMeasureReason(raw: unknown, fallback: string): string {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 200)
  return cleaned.length > 0 ? cleaned : fallback
}

/** Sanitize source id (stable token only). */
export function sanitizeMeasureSourceId(raw: unknown, fallback = 'unknown'): string {
  if (typeof raw !== 'string') return fallback
  const cleaned = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._:-]/g, '')
    .slice(0, 64)
  return cleaned.length > 0 ? cleaned : fallback
}

function reasonFor(code: Cp0MeasureReasonCode, detail?: string): string {
  const base = REASON_TEXT[code]
  if (!detail) return base
  return sanitizeMeasureReason(`${base}: ${detail}`, base)
}

/**
 * Parse an unknown candidate into a safe non-negative integer, or reject with code.
 * Explicitly rejects undefined, null, booleans, floats, negatives, NaN, Infinity,
 * and values outside the safe integer range. Never maps missing → 0.
 */
export function parseNonNegativeCount(value: unknown):
  | { ok: true; value: number }
  | { ok: false; reasonCode: Cp0MeasureReasonCode; reason: string } {
  if (value === undefined || value === null) {
    return {
      ok: false,
      reasonCode: 'VALUE_MISSING',
      reason: reasonFor('VALUE_MISSING'),
    }
  }
  if (typeof value === 'boolean') {
    return {
      ok: false,
      reasonCode: 'VALUE_NOT_INTEGER',
      reason: reasonFor('VALUE_NOT_INTEGER', 'boolean rejected'),
    }
  }
  if (typeof value === 'bigint') {
    if (value < 0n) {
      return {
        ok: false,
        reasonCode: 'VALUE_NEGATIVE',
        reason: reasonFor('VALUE_NEGATIVE'),
      }
    }
    if (value > BigInt(CP0_MEASURE_MAX_SAFE_COUNT)) {
      return {
        ok: false,
        reasonCode: 'VALUE_OVERFLOW',
        reason: reasonFor('VALUE_OVERFLOW'),
      }
    }
    return { ok: true, value: Number(value) }
  }
  if (typeof value === 'string') {
    const trimmed = value.trim()
    if (trimmed.length === 0) {
      return {
        ok: false,
        reasonCode: 'VALUE_MISSING',
        reason: reasonFor('VALUE_MISSING', 'empty string'),
      }
    }
    // Strict decimal integer string only (no floats, no hex).
    if (!/^\+?\d+$/.test(trimmed)) {
      return {
        ok: false,
        reasonCode: 'VALUE_NOT_INTEGER',
        reason: reasonFor('VALUE_NOT_INTEGER', 'non-integer string'),
      }
    }
    const parsed = Number(trimmed)
    if (!Number.isFinite(parsed)) {
      return {
        ok: false,
        reasonCode: 'VALUE_NON_FINITE',
        reason: reasonFor('VALUE_NON_FINITE'),
      }
    }
    if (!Number.isInteger(parsed)) {
      return {
        ok: false,
        reasonCode: 'VALUE_NOT_INTEGER',
        reason: reasonFor('VALUE_NOT_INTEGER'),
      }
    }
    if (parsed < 0) {
      return {
        ok: false,
        reasonCode: 'VALUE_NEGATIVE',
        reason: reasonFor('VALUE_NEGATIVE'),
      }
    }
    if (parsed > CP0_MEASURE_MAX_SAFE_COUNT) {
      return {
        ok: false,
        reasonCode: 'VALUE_OVERFLOW',
        reason: reasonFor('VALUE_OVERFLOW'),
      }
    }
    return { ok: true, value: parsed }
  }
  if (typeof value !== 'number') {
    return {
      ok: false,
      reasonCode: 'VALUE_NOT_INTEGER',
      reason: reasonFor('VALUE_NOT_INTEGER', typeof value),
    }
  }
  if (!Number.isFinite(value)) {
    return {
      ok: false,
      reasonCode: 'VALUE_NON_FINITE',
      reason: reasonFor('VALUE_NON_FINITE'),
    }
  }
  if (!Number.isInteger(value)) {
    return {
      ok: false,
      reasonCode: 'VALUE_NOT_INTEGER',
      reason: reasonFor('VALUE_NOT_INTEGER', 'float rejected'),
    }
  }
  if (value < 0) {
    return {
      ok: false,
      reasonCode: 'VALUE_NEGATIVE',
      reason: reasonFor('VALUE_NEGATIVE'),
    }
  }
  if (value > CP0_MEASURE_MAX_SAFE_COUNT || !Number.isSafeInteger(value)) {
    return {
      ok: false,
      reasonCode: 'VALUE_OVERFLOW',
      reason: reasonFor('VALUE_OVERFLOW'),
    }
  }
  return { ok: true, value }
}

/** Build an unproven count result (value always null). */
export function unprovenCount(
  name: Cp0CountMeasureName,
  input: {
    sourceId: string
    measuredAtMs: number
    reasonCode?: Cp0MeasureReasonCode
    reason?: string
    sourceLabel?: string
  },
): Cp0UnprovenCountMeasure {
  const reasonCode = input.reasonCode ?? 'NO_SOURCE'
  return {
    name,
    proven: false,
    value: null,
    source: {
      id: sanitizeMeasureSourceId(input.sourceId, 'unknown'),
      ...(input.sourceLabel
        ? { label: sanitizeMeasureReason(input.sourceLabel, input.sourceLabel).slice(0, 80) }
        : {}),
    },
    measuredAtMs: input.measuredAtMs,
    reasonCode,
    reason: sanitizeMeasureReason(input.reason ?? reasonFor(reasonCode), reasonFor(reasonCode)),
  }
}

/** Build a proven count from a validated non-negative integer. */
export function provenCount(
  name: Cp0CountMeasureName,
  value: number,
  input: {
    sourceId: string
    measuredAtMs: number
    reason?: string
    sourceLabel?: string
  },
): Cp0ProvenCountMeasure | Cp0UnprovenCountMeasure {
  const parsed = parseNonNegativeCount(value)
  if (!parsed.ok) {
    return unprovenCount(name, {
      sourceId: input.sourceId,
      measuredAtMs: input.measuredAtMs,
      reasonCode: parsed.reasonCode,
      reason: parsed.reason,
      sourceLabel: input.sourceLabel,
    })
  }
  return {
    name,
    proven: true,
    value: parsed.value,
    source: {
      id: sanitizeMeasureSourceId(input.sourceId, 'unknown'),
      ...(input.sourceLabel
        ? { label: sanitizeMeasureReason(input.sourceLabel, input.sourceLabel).slice(0, 80) }
        : {}),
    },
    measuredAtMs: input.measuredAtMs,
    reasonCode: 'UNKNOWN',
    reason: sanitizeMeasureReason(input.reason ?? 'count proven from source', 'count proven from source'),
  }
}

/**
 * Accept unknown raw values into a typed measure.
 * undefined / null / garbage → unproven (never proven zero).
 */
export function countFromUnknown(
  name: Cp0CountMeasureName,
  raw: unknown,
  input: {
    sourceId: string
    measuredAtMs: number
    sourceLabel?: string
  },
): Cp0CountMeasureResult {
  const parsed = parseNonNegativeCount(raw)
  if (!parsed.ok) {
    return unprovenCount(name, {
      sourceId: input.sourceId,
      measuredAtMs: input.measuredAtMs,
      reasonCode: parsed.reasonCode,
      reason: parsed.reason,
      sourceLabel: input.sourceLabel,
    })
  }
  return provenCount(name, parsed.value, input)
}

/**
 * Effective backlog combination:
 *   effective_backlog := outbox_pending + legacy_unreplayed
 * only when BOTH inputs are proven non-negative integers and the sum is safe.
 *
 * Rationale: outbox and legacy are independent backlog sources; the combined
 * claim is their total outstanding units. max() would hide dual pressure;
 * inventing 0 when either side is unproven is forbidden.
 */
export function combineEffectiveBacklog(
  outbox: Cp0CountMeasureResult,
  legacy: Cp0CountMeasureResult,
  measuredAtMs: number,
): Cp0CountMeasureResult {
  if (!outbox.proven || !legacy.proven) {
    const sides: string[] = []
    if (!outbox.proven) sides.push('outbox_pending')
    if (!legacy.proven) sides.push('legacy_unreplayed')
    return unprovenCount('effective_backlog', {
      sourceId: 'effective-combine',
      measuredAtMs,
      reasonCode: 'PARTIAL_PROOF',
      reason: reasonFor(
        'PARTIAL_PROOF',
        `requires proven outbox and legacy; unproven: ${sides.join(',')}`,
      ),
      sourceLabel: 'effective = outbox + legacy (both required)',
    })
  }

  const sum = outbox.value + legacy.value
  if (!Number.isSafeInteger(sum) || sum > CP0_MEASURE_MAX_SAFE_COUNT || sum < 0) {
    return unprovenCount('effective_backlog', {
      sourceId: 'effective-combine',
      measuredAtMs,
      reasonCode: 'COMBINE_OVERFLOW',
      reason: reasonFor('COMBINE_OVERFLOW'),
      sourceLabel: 'effective = outbox + legacy (both required)',
    })
  }

  return {
    name: 'effective_backlog',
    proven: true,
    value: sum,
    source: {
      id: 'effective-combine',
      label: 'effective = outbox + legacy (both required)',
    },
    measuredAtMs,
    reasonCode: 'UNKNOWN',
    reason: 'effective_backlog = outbox_pending + legacy_unreplayed (both proven)',
  }
}

/** True when measure age is within maxAgeMs of nowMs (inclusive). Future-dated measures fail closed. */
export function isMeasureFresh(
  measure: Cp0CountMeasureResult,
  nowMs: number,
  maxAgeMs: number = CP0_MEASURE_DEFAULT_MAX_AGE_MS,
): boolean {
  if (!Number.isFinite(nowMs) || !Number.isFinite(measure.measuredAtMs)) return false
  if (!Number.isFinite(maxAgeMs) || maxAgeMs < 0) return false
  const age = nowMs - measure.measuredAtMs
  // Future skew beyond 1s → not fresh (clock / cache poison).
  if (measure.measuredAtMs - nowMs > 1_000) return false
  return age >= 0 ? age <= maxAgeMs : measure.measuredAtMs - nowMs <= 1_000
}

/** Re-stamp a proven measure as unproven when stale / future-skewed. */
export function requireFreshMeasure(
  measure: Cp0CountMeasureResult,
  nowMs: number,
  maxAgeMs: number = CP0_MEASURE_DEFAULT_MAX_AGE_MS,
): Cp0CountMeasureResult {
  if (!measure.proven) return measure
  if (isMeasureFresh(measure, nowMs, maxAgeMs)) return measure
  return unprovenCount(measure.name, {
    sourceId: measure.source.id,
    measuredAtMs: measure.measuredAtMs,
    reasonCode: 'STALE_MEASURE',
    reason: reasonFor(
      'STALE_MEASURE',
      `ageMs=${nowMs - measure.measuredAtMs} maxAgeMs=${maxAgeMs}`,
    ),
    sourceLabel: measure.source.label,
  })
}

/**
 * Assemble outbox + legacy into a combined triple with effective.
 * Applies freshness fence so cached proven zeros cannot satisfy countsProven.
 */
export function assembleCombinedBacklogMeasure(input: {
  outbox: Cp0CountMeasureResult
  legacy: Cp0CountMeasureResult
  nowMs: number
  maxMeasureAgeMs?: number
}): Cp0CombinedBacklogMeasure {
  const maxAge = input.maxMeasureAgeMs ?? CP0_MEASURE_DEFAULT_MAX_AGE_MS
  const outbox = requireFreshMeasure(input.outbox, input.nowMs, maxAge)
  const legacy = requireFreshMeasure(input.legacy, input.nowMs, maxAge)
  const effective = combineEffectiveBacklog(outbox, legacy, input.nowMs)
  const countsProven = outbox.proven && legacy.proven && effective.proven

  if (countsProven) {
    return {
      schemaVersion: CP0_SYNC_STATUS_MEASURES_SCHEMA,
      outbox,
      legacy,
      effective,
      countsProven: true,
      assembledAtMs: input.nowMs,
      reasonCode: null,
      reason: null,
    }
  }

  let reasonCode: Cp0MeasureReasonCode = 'PARTIAL_PROOF'
  let reason = reasonFor('PARTIAL_PROOF')
  if (!outbox.proven && outbox.reasonCode === 'STALE_MEASURE') {
    reasonCode = 'STALE_MEASURE'
    reason = outbox.reason
  } else if (!legacy.proven && legacy.reasonCode === 'STALE_MEASURE') {
    reasonCode = 'STALE_MEASURE'
    reason = legacy.reason
  } else if (!outbox.proven && !legacy.proven) {
    reasonCode =
      outbox.reasonCode === 'NO_SOURCE' && legacy.reasonCode === 'NO_SOURCE'
        ? 'NO_SOURCE'
        : 'PARTIAL_PROOF'
    reason = reasonFor(reasonCode, 'outbox and legacy unproven')
  } else if (!outbox.proven) {
    reasonCode = outbox.reasonCode
    reason = outbox.reason
  } else if (!legacy.proven) {
    reasonCode = legacy.reasonCode
    reason = legacy.reason
  } else if (!effective.proven) {
    reasonCode = effective.reasonCode
    reason = effective.reason
  }

  return {
    schemaVersion: CP0_SYNC_STATUS_MEASURES_SCHEMA,
    outbox,
    legacy,
    effective,
    countsProven: false,
    assembledAtMs: input.nowMs,
    reasonCode,
    reason,
  }
}

/** Default fail-closed outbox measurer: always unproven, never zero. */
export function defaultUnprovenOutboxMeasurer(
  ctx: Cp0MeasureContext,
): Cp0UnprovenCountMeasure {
  return unprovenCount('outbox_pending', {
    sourceId: 'default-unproven',
    measuredAtMs: ctx.nowMs,
    reasonCode: 'NO_SOURCE',
    reason: reasonFor('NO_SOURCE', 'outbox SSOT not wired (PACKET-P3)'),
    sourceLabel: 'default fail-closed outbox',
  })
}

/** Default fail-closed legacy measurer: always unproven, never zero. */
export function defaultUnprovenLegacyMeasurer(
  ctx: Cp0MeasureContext,
): Cp0UnprovenCountMeasure {
  return unprovenCount('legacy_unreplayed', {
    sourceId: 'default-unproven',
    measuredAtMs: ctx.nowMs,
    reasonCode: 'NO_SOURCE',
    reason: reasonFor('NO_SOURCE', 'legacy residual SSOT not wired (PACKET-P3)'),
    sourceLabel: 'default fail-closed legacy',
  })
}

/** Factory: injectable deps with fail-closed defaults (no real SSOT). */
export function createDefaultCp0SyncStatusMeasureDeps(
  overrides: Partial<Cp0SyncStatusMeasureDeps> = {},
): Cp0SyncStatusMeasureDeps {
  return {
    measureOutbox: overrides.measureOutbox ?? defaultUnprovenOutboxMeasurer,
    measureLegacy: overrides.measureLegacy ?? defaultUnprovenLegacyMeasurer,
    maxMeasureAgeMs: overrides.maxMeasureAgeMs ?? CP0_MEASURE_DEFAULT_MAX_AGE_MS,
  }
}

async function safeRunMeasurer(
  name: 'outbox_pending' | 'legacy_unreplayed',
  measurer: Cp0CountMeasurer,
  ctx: Cp0MeasureContext,
): Promise<Cp0CountMeasureResult> {
  try {
    const result = await measurer(ctx)
    if (
      result == null ||
      typeof result !== 'object' ||
      (result.proven !== true && result.proven !== false)
    ) {
      return unprovenCount(name, {
        sourceId: 'measurer-invalid',
        measuredAtMs: ctx.nowMs,
        reasonCode: 'MEASURE_ERROR',
        reason: reasonFor('MEASURE_ERROR', 'measurer returned invalid shape'),
      })
    }
    // Enforce name + null value invariant for unproven.
    if (result.proven === false) {
      return {
        ...result,
        name,
        proven: false,
        value: null,
        source: {
          id: sanitizeMeasureSourceId(result.source?.id, 'unknown'),
          ...(result.source?.label
            ? {
                label: sanitizeMeasureReason(result.source.label, result.source.label).slice(
                  0,
                  80,
                ),
              }
            : {}),
        },
        reason: sanitizeMeasureReason(result.reason, reasonFor('UNKNOWN')),
        reasonCode: result.reasonCode ?? 'UNKNOWN',
        measuredAtMs: Number.isFinite(result.measuredAtMs) ? result.measuredAtMs : ctx.nowMs,
      }
    }
    // Re-validate proven values so a buggy measurer cannot inject negatives/NaN.
    return countFromUnknown(name, result.value, {
      sourceId: result.source?.id ?? 'injected',
      measuredAtMs: Number.isFinite(result.measuredAtMs) ? result.measuredAtMs : ctx.nowMs,
      sourceLabel: result.source?.label,
    })
  } catch (err) {
    const detail =
      err instanceof Error
        ? sanitizeMeasureReason(err.name, 'Error')
        : 'non-error throw'
    return unprovenCount(name, {
      sourceId: 'measurer-error',
      measuredAtMs: ctx.nowMs,
      reasonCode: 'MEASURE_ERROR',
      reason: reasonFor('MEASURE_ERROR', detail),
    })
  }
}

/**
 * Run injectable measurers and assemble a fail-closed combined result.
 * Never claims proven zeros without both sources returning proven integers.
 */
export async function measureCp0SyncStatusCounts(
  deps: Cp0SyncStatusMeasureDeps,
  ctx: Cp0MeasureContext,
): Promise<Cp0CombinedBacklogMeasure> {
  const [outbox, legacy] = await Promise.all([
    safeRunMeasurer('outbox_pending', deps.measureOutbox, ctx),
    safeRunMeasurer('legacy_unreplayed', deps.measureLegacy, ctx),
  ])
  return assembleCombinedBacklogMeasure({
    outbox,
    legacy,
    nowMs: ctx.nowMs,
    maxMeasureAgeMs: deps.maxMeasureAgeMs,
  })
}

/**
 * Project combined measure into nullable column values for a future UPSERT.
 * Unproven → null (serializer / DB must not invent 0).
 * Proven → integer. Never returns 0 for an unproven side.
 */
export function toNullableCountColumns(combined: Cp0CombinedBacklogMeasure): {
  outbox_pending: number | null
  legacy_unreplayed: number | null
  effective_backlog: number | null
  countsProven: boolean
} {
  if (!combined.countsProven) {
    return {
      outbox_pending: null,
      legacy_unreplayed: null,
      effective_backlog: null,
      countsProven: false,
    }
  }
  return {
    outbox_pending: combined.outbox.value,
    legacy_unreplayed: combined.legacy.value,
    effective_backlog: combined.effective.value,
    countsProven: true,
  }
}
