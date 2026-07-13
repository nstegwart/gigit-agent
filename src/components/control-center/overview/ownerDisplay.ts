/**
 * Owner humanDisplay presentation helpers (Overview).
 * Fail-closed: never promote technical title to owner primary.
 * Accepts only REVIEWED status as owner-ready; GENERATED_NEEDS_REVIEW /
 * BLOCKED / CONFLICT / CONTENT_REVIEW_REQUIRED (and any other non-REVIEWED)
 * fail closed even when contentReviewRequired flag is inconsistently false.
 * Copy comes only from projected fields; this module does not invent narrative.
 */

export type OwnerDisplayCitation = {
  field: string
  path: string
  note?: string
}

export type OwnerDisplayInput = {
  /** Technical/system title — NEVER owner primary. */
  technicalTitle: string
  ownerPrimaryTitle?: string | null
  statusSentence?: string | null
  ownerAction?: string | null
  whyItMatters?: string | null
  next?: string | null
  blocker?: string | null
  contentReviewRequired?: boolean
  effectiveReviewStatus?: string | null
  citations?: ReadonlyArray<OwnerDisplayCitation> | null
  /** Nested wire; flat fields win when both present. */
  ownerHumanDisplay?: {
    ownerPrimaryTitle?: string | null
    statusSentence?: string | null
    ownerAction?: string | null
    whyItMatters?: string | null
    next?: string | null
    blocker?: string | null
    contentReviewRequired?: boolean
    effectiveReviewStatus?: string | null
    citations?: ReadonlyArray<OwnerDisplayCitation> | null
  } | null
}

export type OwnerDisplayResolved = {
  /** Owner-facing primary title or CONTENT_REVIEW_REQUIRED shell label. */
  primaryTitle: string
  contentReviewRequired: boolean
  statusSentence: string | null
  ownerAction: string | null
  whyItMatters: string | null
  next: string | null
  blocker: string | null
  citations: ReadonlyArray<OwnerDisplayCitation>
  /** Technical title retained for secondary/tech mode only. */
  technicalTitle: string
  effectiveReviewStatus: string
}

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

/**
 * Owner-ready only when:
 * - contentReviewRequired === false
 * - ownerPrimaryTitle present (flat or nested)
 * - effectiveReviewStatus === 'REVIEWED' (exact)
 *
 * GENERATED_NEEDS_REVIEW / BLOCKED / BLOCKED_MISSING_SOURCE / CONFLICT /
 * CONTENT_REVIEW_REQUIRED / missing status → fail-closed shell even if the
 * contentReviewRequired flag is inconsistently false.
 * Primary never falls back to technicalTitle.
 */
export function resolveOwnerDisplay(input: OwnerDisplayInput): OwnerDisplayResolved {
  const nested = input.ownerHumanDisplay
  const technicalTitle = input.technicalTitle
  const ownerPrimary = trimOrNull(input.ownerPrimaryTitle ?? nested?.ownerPrimaryTitle)
  const statusRaw = trimOrNull(
    input.effectiveReviewStatus ?? nested?.effectiveReviewStatus,
  )
  const reviewFlag =
    input.contentReviewRequired ?? nested?.contentReviewRequired
  // Strict REVIEWED only — never trust inconsistent contentReviewRequired=false
  // when status is GENERATED_NEEDS_REVIEW / BLOCKED / CONFLICT / other.
  const ready =
    reviewFlag === false &&
    ownerPrimary != null &&
    statusRaw === 'REVIEWED'

  const contentReviewRequired = !ready
  // Prefer projected shell/primary title; never technical title as primary.
  const primaryTitle = ownerPrimary ?? 'CONTENT_REVIEW_REQUIRED'
  const effectiveReviewStatus =
    statusRaw ?? (contentReviewRequired ? 'CONTENT_REVIEW_REQUIRED' : 'REVIEWED')

  return {
    primaryTitle,
    contentReviewRequired,
    statusSentence: trimOrNull(input.statusSentence ?? nested?.statusSentence),
    ownerAction: trimOrNull(input.ownerAction ?? nested?.ownerAction),
    whyItMatters: trimOrNull(input.whyItMatters ?? nested?.whyItMatters),
    next: trimOrNull(input.next ?? nested?.next),
    blocker: trimOrNull(input.blocker ?? nested?.blocker),
    citations: input.citations ?? nested?.citations ?? [],
    technicalTitle,
    effectiveReviewStatus,
  }
}
