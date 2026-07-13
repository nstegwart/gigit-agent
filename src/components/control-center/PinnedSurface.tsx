/**
 * Pinned revision DOM attribute contract for control-center primary surfaces.
 * Values MUST come from the authenticated envelope only — never invent revs/hashes.
 * Browser evidence can read data-canonical-snapshot-id | data-canonical-hash |
 * data-board-rev | data-lifecycle-rev on the surface root.
 */
import type { ElementType, HTMLAttributes, ReactNode } from 'react'

export interface PinnedSurfaceMeta {
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  /** Envelope generatedAt when present — not inventable. */
  generatedAt?: string | null
  /** Envelope freshness age in seconds when present. */
  freshnessAgeSeconds?: number | null
  /** Envelope stale flag when known. */
  stale?: boolean | null
}

export type PinnedSurfaceDataAttrs = {
  'data-canonical-snapshot-id'?: string
  'data-canonical-hash'?: string
  'data-board-rev'?: string
  'data-lifecycle-rev'?: string
  'data-generated-at'?: string
  'data-freshness-age'?: string
  'data-stale'?: 'true' | 'false'
  'data-pinned'?: 'true' | 'false'
}

/**
 * Build data-* attrs from envelope-derived pin fields.
 * - Missing/null/empty string → attribute omitted (honest absence).
 * - boardRev/lifecycleRev of 0 remain visible (honest zero, not fabricated authority).
 * - Never maps boardRev into account sourceRevision (ops uses a separate field).
 */
export function pinnedSurfaceDataAttrs(
  pin: PinnedSurfaceMeta | null | undefined,
): PinnedSurfaceDataAttrs {
  if (!pin) {
    return { 'data-pinned': 'false' }
  }
  const attrs: PinnedSurfaceDataAttrs = { 'data-pinned': 'true' }
  if (typeof pin.canonicalSnapshotId === 'string' && pin.canonicalSnapshotId.length > 0) {
    attrs['data-canonical-snapshot-id'] = pin.canonicalSnapshotId
  }
  if (typeof pin.canonicalHash === 'string' && pin.canonicalHash.length > 0) {
    attrs['data-canonical-hash'] = pin.canonicalHash
  }
  if (typeof pin.boardRev === 'number' && Number.isFinite(pin.boardRev)) {
    attrs['data-board-rev'] = String(pin.boardRev)
  }
  if (typeof pin.lifecycleRev === 'number' && Number.isFinite(pin.lifecycleRev)) {
    attrs['data-lifecycle-rev'] = String(pin.lifecycleRev)
  }
  if (typeof pin.generatedAt === 'string' && pin.generatedAt.length > 0) {
    attrs['data-generated-at'] = pin.generatedAt
  }
  if (typeof pin.freshnessAgeSeconds === 'number' && Number.isFinite(pin.freshnessAgeSeconds)) {
    attrs['data-freshness-age'] = String(pin.freshnessAgeSeconds)
  }
  if (typeof pin.stale === 'boolean') {
    attrs['data-stale'] = pin.stale ? 'true' : 'false'
  }
  return attrs
}

/** Extract pin meta from a PinnedEnvelope-like object (envelope-derived only). */
export function pinMetaFromEnvelope(
  envelope:
    | {
        canonicalSnapshotId?: string | null
        canonicalHash?: string | null
        boardRev?: number | null
        lifecycleRev?: number | null
      }
    | null
    | undefined,
): PinnedSurfaceMeta | null {
  if (!envelope) return null
  return {
    canonicalSnapshotId: envelope.canonicalSnapshotId ?? null,
    canonicalHash: envelope.canonicalHash ?? null,
    boardRev: typeof envelope.boardRev === 'number' ? envelope.boardRev : null,
    lifecycleRev: typeof envelope.lifecycleRev === 'number' ? envelope.lifecycleRev : null,
  }
}

export interface PinnedSurfaceProps extends HTMLAttributes<HTMLElement> {
  pin: PinnedSurfaceMeta | null | undefined
  as?: ElementType
  children?: ReactNode
  className?: string
  /** data-testid; default pinned-surface */
  testId?: string
}

/**
 * Optional wrapper that stamps pin data attrs on a root element.
 * Prefer spreading `pinnedSurfaceDataAttrs(pin)` onto existing screen roots when composition is fixed.
 */
export function PinnedSurface({
  pin,
  as: Tag = 'div',
  children,
  className,
  testId = 'pinned-surface',
  ...rest
}: PinnedSurfaceProps) {
  const attrs = pinnedSurfaceDataAttrs(pin)
  return (
    <Tag className={className} data-testid={testId} {...attrs} {...rest}>
      {children}
    </Tag>
  )
}
