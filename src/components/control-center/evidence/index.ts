/**
 * Evidence & Citation public surface (ART-017 + FAN-EVIDENCE Direction B).
 * Screens open the drawer with a prop-driven view-model; no server fetch inside.
 */
export { EvidenceDrawer } from './EvidenceDrawer'
export type { EvidenceDrawerProps } from './EvidenceDrawer'
export { EvidenceScreen } from './EvidenceScreen'
export type {
  EvidenceDrawerViewModel,
  EvidenceWarning,
  EvidenceWarningKind,
  EvidenceEventRow,
  EvidencePinView,
  EvidenceScreenProps,
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
export {
  kindHumanDisplay,
  eventHumanTitle,
  eventTimeDisplay,
  warningKindLabel,
  warningStatusVariant,
} from './labels'
