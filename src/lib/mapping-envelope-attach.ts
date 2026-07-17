/**
 * Attach adaptive mapping version wire to pinned control-center envelopes (addendum B).
 * Presentation-only merge — never recomputes readiness or denominators client-side.
 */
import type { MappingVersionWire } from '#/lib/mapping-version-view'
import type { PinnedEnvelope } from '#/server/control-center-ui'

/** Wire bag accepted from server adaptive-mapping surface (presentation-only). */
export type MappingVersionWireBag = MappingVersionWire

export type EnvelopeWithMappingVersion<T> = PinnedEnvelope<T> & {
  mappingVersion?: MappingVersionWireBag
}

/**
 * Merge mappingVersion onto envelope top-level and data bag when data is an object.
 * Idempotent when wire is null/empty.
 */
export function attachAdaptiveMappingToEnvelope<T>(
  envelope: PinnedEnvelope<T>,
  mappingVersion: MappingVersionWireBag | null | undefined,
): EnvelopeWithMappingVersion<T> {
  if (!mappingVersion || typeof mappingVersion !== 'object') {
    return envelope
  }

  const data =
    envelope.data && typeof envelope.data === 'object' && !Array.isArray(envelope.data)
      ? { ...(envelope.data as Record<string, unknown>), mappingVersion }
      : envelope.data

  return {
    ...envelope,
    data: data as T,
    mappingVersion,
  }
}