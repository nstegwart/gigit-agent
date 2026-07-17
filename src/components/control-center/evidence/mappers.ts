/**
 * Honest mappers from projected control-center shapes → EvidenceDrawerViewModel.
 * Never invents verifier receipts, hashes, or claims not present in the source.
 */
import type { EvidenceDrawerViewModel, EvidenceWarning } from './types'

export type MaterialEvidenceEventLike = {
  id: string
  createdAt: string
  kind: string
  summary: string
  actorId?: string | null
  materialHash?: string | null
}

export type PinLike = {
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  stale?: boolean | null
  staleReason?: string | null
} | null

export type CitationLike = {
  field: string
  path: string
  note?: string
}

/**
 * Map a material evidence list event (+ optional pin) into drawer view-model.
 * Missing verifier stays null; stale pin surfaces a warning.
 */
export function materialEventToDrawerModel(
  event: MaterialEvidenceEventLike,
  pin?: PinLike,
  opts?: { claimSupported?: string | null; sourceHref?: string | null },
): EvidenceDrawerViewModel {
  const warnings: EvidenceWarning[] = []
  if (pin?.stale) {
    warnings.push({
      kind: 'stale',
      message:
        pin.staleReason?.trim() ||
        'Pin bukti basi — gunakan data terakhir yang valid, jangan anggap pasti.',
    })
  }

  const revisionParts: string[] = []
  if (typeof pin?.boardRev === 'number' && Number.isFinite(pin.boardRev)) {
    revisionParts.push(`boardRev ${pin.boardRev}`)
  }
  if (
    typeof pin?.lifecycleRev === 'number' &&
    Number.isFinite(pin.lifecycleRev)
  ) {
    revisionParts.push(`lifecycleRev ${pin.lifecycleRev}`)
  }

  const citationText = [
    event.id,
    event.kind,
    event.summary,
    pin?.canonicalSnapshotId ? `snapshot:${pin.canonicalSnapshotId}` : null,
  ]
    .filter(Boolean)
    .join(' · ')

  const rawBits: Record<string, unknown> = {
    id: event.id,
    kind: event.kind,
    createdAt: event.createdAt,
    summary: event.summary,
  }
  if (event.actorId) rawBits.actorId = event.actorId
  if (event.materialHash) rawBits.materialHash = event.materialHash
  if (pin?.canonicalSnapshotId) {
    rawBits.canonicalSnapshotId = pin.canonicalSnapshotId
  }
  if (pin?.canonicalHash) rawBits.canonicalHash = pin.canonicalHash

  return {
    id: event.id,
    proofSummary: event.summary?.trim() || 'Ringkasan bukti tidak tersedia.',
    claimSupported:
      opts?.claimSupported?.trim() ||
      `Peristiwa material: ${event.kind || 'tidak diketahui'}`,
    verifier: null,
    verifiedAt: event.createdAt || null,
    freshness: pin?.stale ? 'Basi (pin stale)' : pin ? 'Dari pin aktif' : null,
    revision: revisionParts.length ? revisionParts.join(' / ') : null,
    snapshotId: pin?.canonicalSnapshotId ?? null,
    sourceAnchor: event.materialHash
      ? `hash ${event.materialHash}`
      : event.id,
    sourceHref: opts?.sourceHref ?? null,
    warnings,
    rawReceipt: JSON.stringify(rawBits, null, 2),
    citationText,
  }
}

/**
 * Map a documentation / owner citation into a minimal drawer view-model.
 * Does not invent independent verifier or proof beyond path/field/note.
 */
export function citationToDrawerModel(
  citation: CitationLike,
  opts?: { id?: string; claimSupported?: string | null },
): EvidenceDrawerViewModel {
  const id =
    opts?.id?.trim() ||
    `cite:${citation.field}:${citation.path}`.slice(0, 160)
  const note = citation.note?.trim() || null
  const citationText = [citation.field, citation.path, note]
    .filter(Boolean)
    .join(' · ')

  return {
    id,
    proofSummary: note || `Kutipan sumber untuk ${citation.field}`,
    claimSupported:
      opts?.claimSupported?.trim() ||
      `Mendukung bidang: ${citation.field}`,
    verifier: null,
    verifiedAt: null,
    freshness: null,
    revision: null,
    snapshotId: null,
    sourceAnchor: citation.path || citation.field,
    sourceHref: citation.path.startsWith('/') ? citation.path : null,
    warnings: [],
    rawReceipt: JSON.stringify(
      {
        field: citation.field,
        path: citation.path,
        note: note,
      },
      null,
      2,
    ),
    citationText,
  }
}
