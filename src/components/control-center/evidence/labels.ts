/**
 * Presentation-only id-ID labels for Evidence surface.
 * Never invents proof/verifier facts — only clean display fallbacks.
 */
import { formatDenseTimestamp, formatOperationalLabel } from '#/lib/display-label'

/** Known material-event kinds → short id-ID title (human primary). */
const KIND_LABELS_ID: Readonly<Record<string, string>> = {
  RECEIPT: 'Resi',
  VERIFICATION: 'Verifikasi',
  AUDIT: 'Audit',
  MATERIAL: 'Material',
  PIN: 'Pin',
  CITATION: 'Kutipan',
  PROOF: 'Bukti',
  GATE: 'Gerbang',
  SNAPSHOT: 'Snapshot',
  HASH: 'Hash',
}

/**
 * Human primary label for an event kind.
 * Prefer mapped id-ID; else clean operational spacing; never invent meaning.
 */
export function kindHumanDisplay(kind: string | null | undefined): string {
  const raw = kind?.trim() ?? ''
  if (!raw) return 'Peristiwa material'
  const upper = raw.toUpperCase()
  if (KIND_LABELS_ID[upper]) return KIND_LABELS_ID[upper]
  // SCREAMING_SNAKE → spaced words; leave hyphenated ids as-is
  const spaced = formatOperationalLabel(raw)
  return spaced || 'Peristiwa material'
}

/**
 * Entity title: summary (owner-facing proof text) first; clean kind fallback.
 * Technical id is never primary.
 */
export function eventHumanTitle(
  summary: string | null | undefined,
  kind: string | null | undefined,
): string {
  const s = summary?.trim()
  if (s) return s
  return kindHumanDisplay(kind)
}

/** Dense time for tables; full ISO remains in title attribute. */
export function eventTimeDisplay(iso: string | null | undefined): string {
  return formatDenseTimestamp(iso)
}

export function warningKindLabel(
  kind: 'conflict' | 'stale' | 'redaction',
): string {
  if (kind === 'conflict') return 'Konflik'
  if (kind === 'stale') return 'Basi'
  return 'Redaksi'
}

export function warningStatusVariant(
  kind: 'conflict' | 'stale' | 'redaction',
): 'blocked' | 'warn' | 'pending' {
  if (kind === 'conflict') return 'blocked'
  if (kind === 'stale') return 'warn'
  return 'pending'
}
