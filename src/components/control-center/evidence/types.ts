/**
 * Prop-driven view-model for the Evidence & Citation drawer (ART-017).
 * Parents map envelope/citation data here — the drawer never fetches or invents facts.
 */
import type { RefObject } from 'react'

export type EvidenceWarningKind = 'conflict' | 'stale' | 'redaction'

export type EvidenceWarning = {
  kind: EvidenceWarningKind
  /** Plain-language id-ID message; never raw JSON as primary. */
  message: string
}

/**
 * Drawer presentation model. All fields are display-only; absent data stays null/empty.
 */
export type EvidenceDrawerViewModel = {
  /** Stable evidence/citation id (also used for deep-link `?evidence=`). */
  id: string
  /** Plain-language proof summary (primary). */
  proofSummary: string
  /** What claim this evidence supports. */
  claimSupported: string
  /** Independent verifier display name/label. */
  verifier: string | null
  /** Verification time (ISO or human display string from projector). */
  verifiedAt: string | null
  /** Freshness label or age sentence when known. */
  freshness: string | null
  /** Board/lifecycle or content revision string when known. */
  revision: string | null
  /** Canonical snapshot id when known. */
  snapshotId: string | null
  /** Source anchor label (path, field, receipt id). */
  sourceAnchor: string | null
  /** Resolvable link (relative path or absolute URL). */
  sourceHref: string | null
  /** Conflict / stale / redaction warnings. */
  warnings: ReadonlyArray<EvidenceWarning>
  /**
   * Raw receipt payload for nested technical disclosure only.
   * Never rendered as primary copy.
   */
  rawReceipt: string | null
  /** Canonical citation text for clipboard copy. */
  citationText: string
}

export type EvidenceDrawerProps = {
  open: boolean
  model: EvidenceDrawerViewModel | null
  onClose: () => void
  /**
   * Optional element to restore focus on close.
   * When omitted, the element focused before open is restored.
   */
  returnFocusRef?: RefObject<HTMLElement | null>
  /** Optional deep-link href shown for share/copy context. */
  deepLinkHref?: string | null
  className?: string
  /** Override copy handler (tests / environments without clipboard). */
  onCopyCitation?: (text: string) => void | Promise<void>
}
