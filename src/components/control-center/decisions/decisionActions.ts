/**
 * Pure helpers for owner decision action availability (UI_CONTRACT §9).
 * Blocking cannot snooze; declining option → RESOLVED; REJECTED = request rejection.
 */

import type {
  DecisionActionKind,
  DecisionItemView,
  DecisionOwnerHumanDisplayView,
  DecisionStatus,
} from './types'

const OPEN_STATUSES = new Set(['OPEN', 'ACKNOWLEDGED'])
const TERMINAL_STATUSES = new Set(['RESOLVED', 'REJECTED', 'CANCELLED', 'EXPIRED'])

export function isOpenDecisionStatus(status: DecisionStatus): boolean {
  return OPEN_STATUSES.has(String(status).toUpperCase())
}

export function isTerminalDecisionStatus(status: DecisionStatus): boolean {
  return TERMINAL_STATUSES.has(String(status).toUpperCase())
}

export function isExpiredDecisionStatus(status: DecisionStatus): boolean {
  return String(status).toUpperCase() === 'EXPIRED'
}

export interface DecisionActionAvailability {
  canAcknowledge: boolean
  canResolve: boolean
  canReject: boolean
  canSnooze: boolean
  /** Why snooze is unavailable when canSnooze is false and open. */
  snoozeBlockedReason: string | null
}

export function decisionActionAvailability(
  item: Pick<DecisionItemView, 'status' | 'blocking'>,
  opts: { canAct?: boolean } = {},
): DecisionActionAvailability {
  const canAct = opts.canAct !== false
  const status = String(item.status).toUpperCase()
  const open = OPEN_STATUSES.has(status)
  if (!canAct || !open) {
    return {
      canAcknowledge: false,
      canResolve: false,
      canReject: false,
      canSnooze: false,
      snoozeBlockedReason: !open
        ? status === 'EXPIRED'
          ? 'Kedaluwarsa — tindakan ditutup'
          : 'Terminal — hanya lihat'
        : 'Tidak berwenang bertindak',
    }
  }
  const blocking = Boolean(item.blocking)
  return {
    canAcknowledge: status === 'OPEN',
    canResolve: true,
    canReject: true,
    canSnooze: !blocking,
    snoozeBlockedReason: blocking
      ? 'Keputusan menghambat tidak bisa disembunyikan dengan tunda'
      : null,
  }
}

/** CAS revs for mutation; entityRev preferred for entity CAS. */
export function decisionMutationRevs(
  item: Pick<DecisionItemView, 'entityRev' | 'expectedRev' | 'boardRev'>,
  pinBoardRev: number | null | undefined,
): { expectedRev: number; expectedBoardRev: number } | null {
  const expectedRev =
    typeof item.entityRev === 'number'
      ? item.entityRev
      : typeof item.expectedRev === 'number'
        ? item.expectedRev
        : null
  const expectedBoardRev =
    typeof item.boardRev === 'number'
      ? item.boardRev
      : typeof pinBoardRev === 'number'
        ? pinBoardRev
        : null
  if (expectedRev == null || expectedBoardRev == null) return null
  return { expectedRev, expectedBoardRev }
}

/**
 * Stable 24h owner-decision idempotency key — unique per action intent, stable on retry.
 * Bounded ≤191 chars (idempotency key max). Deterministic (no random).
 */
export function buildDecisionOwnerIdempotencyKey(input: {
  action: DecisionActionKind
  boardId: string
  decisionId: string
  expectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  selectedOptionId?: string | null
  snoozedUntil?: string | null
}): string {
  const hashPart = String(input.canonicalHash || '')
    .trim()
    .slice(0, 24)
  const optionPart = input.selectedOptionId ? `:opt:${input.selectedOptionId}` : ''
  const snoozePart = input.snoozedUntil ? `:sz:${input.snoozedUntil}` : ''
  const raw = [
    'dec-v3',
    input.action,
    input.boardId,
    input.decisionId,
    `er${input.expectedRev}`,
    `br${input.expectedBoardRev}`,
    hashPart,
  ].join(':')
  const full = `${raw}${optionPart}${snoozePart}`
  if (full.length <= 191) return full
  // Deterministic truncation with length marker (not crypto — key is opaque to storage).
  return full.slice(0, 187) + ':x'
}

/** Full CAS + pin + idempotency envelope for owner mutations (client or route). */
export function decisionMutationEnvelope(
  item: Pick<DecisionItemView, 'decisionId' | 'entityRev' | 'expectedRev' | 'boardRev'>,
  pin: { boardId: string; boardRev?: number | null; canonicalHash?: string | null } | null | undefined,
  action: DecisionActionKind,
  extras: {
    selectedOptionId?: string | null
    snoozedUntil?: string | null
    comment?: string | null
    boardId?: string
  } = {},
): {
  boardId: string
  decisionId: string
  expectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  idempotencyKey: string
  selectedOptionId?: string
  snoozedUntil?: string
  comment?: string | null
} | null {
  const boardId = extras.boardId ?? pin?.boardId
  if (!boardId) return null
  const revs = decisionMutationRevs(item, pin?.boardRev)
  const canonicalHash =
    pin?.canonicalHash && String(pin.canonicalHash).trim()
      ? String(pin.canonicalHash).trim()
      : ''
  if (!revs || !canonicalHash) return null
  const idempotencyKey = buildDecisionOwnerIdempotencyKey({
    action,
    boardId,
    decisionId: item.decisionId,
    expectedRev: revs.expectedRev,
    expectedBoardRev: revs.expectedBoardRev,
    canonicalHash,
    selectedOptionId: extras.selectedOptionId,
    snoozedUntil: extras.snoozedUntil,
  })
  return {
    boardId,
    decisionId: item.decisionId,
    expectedRev: revs.expectedRev,
    expectedBoardRev: revs.expectedBoardRev,
    canonicalHash,
    idempotencyKey,
    ...(extras.selectedOptionId ? { selectedOptionId: extras.selectedOptionId } : {}),
    ...(extras.snoozedUntil ? { snoozedUntil: extras.snoozedUntil } : {}),
    ...(extras.comment !== undefined ? { comment: extras.comment } : {}),
  }
}

/** Default snooze: +24h ISO. */
export function defaultSnoozedUntil(nowMs: number = Date.now()): string {
  return new Date(nowMs + 24 * 60 * 60 * 1000).toISOString()
}

/**
 * Grounded in buildContentReviewRequiredShell / projectOwnerHumanDisplayUi
 * (src/server/human-display.ts + control-center-ui.ts). Never invent alternate copy.
 */
const BLOCKED_SHELL_TITLE = 'Konten pemilik memerlukan peninjauan'
const BLOCKED_SHELL_STATUS =
  'Status peninjauan: CONTENT_REVIEW_REQUIRED. Salinan pemilik tidak siap.'
const BLOCKED_SHELL_ACTION =
  'Tinjau atau tugaskan peninjauan salinan manusia untuk item ini.'
const BLOCKED_SHELL_BLOCKER =
  'CONTENT_REVIEW_REQUIRED — salinan hilang, basi, konflik, atau belum ditinjau.'

/** Plain-language chip label — never the raw enum as primary visible text. */
export const CONTENT_REVIEW_CHIP_LABEL = 'Perlu tinjauan konten'

function trimOrEmpty(v: string | null | undefined): string {
  return (v ?? '').trim()
}

/** True when a string is only the technical review enum (not a full shell sentence). */
function isBareReviewEnum(v: string): boolean {
  return v === 'CONTENT_REVIEW_REQUIRED'
}

/**
 * Resolve owner-readable display from DTO HumanDisplay fields.
 * Fail closed to blockedShell sentences — never raw technical title or bare
 * CONTENT_REVIEW_REQUIRED enum as primary title.
 *
 * Owner-ready only when contentReviewRequired === false, ownerPrimaryTitle
 * present, and effectiveReviewStatus === 'REVIEWED' (same bar as work rows).
 */
export function resolveDecisionOwnerDisplay(item: DecisionItemView): {
  primaryTitle: string
  statusSentence: string
  ownerAction: string
  whyItMatters: string | null
  next: string | null
  blocker: string | null
  contentReviewRequired: boolean
  effectiveReviewStatus: string
  technicalTitle: string
} {
  const hd: DecisionOwnerHumanDisplayView | null | undefined = item.ownerHumanDisplay
  const primaryFromHd =
    trimOrEmpty(hd?.ownerPrimaryTitle) ||
    trimOrEmpty(item.ownerPrimaryTitle) ||
    ''
  const statusRaw =
    trimOrEmpty(hd?.effectiveReviewStatus) ||
    trimOrEmpty(item.effectiveReviewStatus) ||
    ''
  const reviewFlag =
    hd?.contentReviewRequired ?? item.contentReviewRequired

  // Strict REVIEWED only — never trust inconsistent contentReviewRequired=false.
  const ready =
    reviewFlag === false &&
    primaryFromHd.length > 0 &&
    !isBareReviewEnum(primaryFromHd) &&
    statusRaw === 'REVIEWED'

  const contentReviewRequired = !ready
  const technicalTitle = trimOrEmpty(item.title) || item.decisionId

  if (contentReviewRequired) {
    // Prefer projected blockedShell fields; never bare enum / technical as primary.
    const projectedTitle =
      primaryFromHd && !isBareReviewEnum(primaryFromHd)
        ? primaryFromHd
        : BLOCKED_SHELL_TITLE
    return {
      primaryTitle: projectedTitle,
      statusSentence:
        trimOrEmpty(hd?.statusSentence) ||
        trimOrEmpty(item.statusSentence) ||
        BLOCKED_SHELL_STATUS,
      ownerAction:
        trimOrEmpty(hd?.ownerAction) ||
        trimOrEmpty(item.ownerActions[0]) ||
        BLOCKED_SHELL_ACTION,
      whyItMatters: trimOrEmpty(hd?.whyItMatters) || item.whyItMatters || null,
      next: trimOrEmpty(hd?.next) || item.next || null,
      blocker:
        trimOrEmpty(hd?.blocker) || item.blocker || BLOCKED_SHELL_BLOCKER,
      contentReviewRequired: true,
      effectiveReviewStatus: statusRaw || 'CONTENT_REVIEW_REQUIRED',
      technicalTitle,
    }
  }

  return {
    primaryTitle: primaryFromHd,
    statusSentence:
      trimOrEmpty(hd?.statusSentence) ||
      trimOrEmpty(item.statusSentence) ||
      '',
    ownerAction:
      trimOrEmpty(hd?.ownerAction) ||
      trimOrEmpty(item.ownerActions[0]) ||
      '',
    whyItMatters: trimOrEmpty(hd?.whyItMatters) || item.whyItMatters || null,
    next: trimOrEmpty(hd?.next) || item.next || null,
    blocker: trimOrEmpty(hd?.blocker) || item.blocker || null,
    contentReviewRequired: false,
    effectiveReviewStatus: statusRaw || 'REVIEWED',
    technicalTitle,
  }
}

export function actionLabel(kind: DecisionActionKind): string {
  switch (kind) {
    case 'acknowledge':
      return 'Akui'
    case 'resolve':
      return 'Selesaikan'
    case 'reject':
      return 'Tolak permintaan'
    case 'snooze':
      return 'Tunda 24 jam'
  }
}
