/**
 * Evidence & Citation drawer public surface (ART-017).
 * Screens open this with a prop-driven view-model; no server fetch inside.
 */
export { EvidenceDrawer } from './EvidenceDrawer'
export type { EvidenceDrawerProps } from './EvidenceDrawer'
export type {
  EvidenceDrawerViewModel,
  EvidenceWarning,
  EvidenceWarningKind,
} from './types'
export {
  parseEvidenceDeepLink,
  encodeEvidenceDeepLink,
  evidenceDeepLinkPath,
  EVIDENCE_PARAM,
} from './deepLink'
export {
  materialEventToDrawerModel,
  citationToDrawerModel,
  type MaterialEvidenceEventLike,
  type CitationLike,
  type PinLike,
} from './mappers'
