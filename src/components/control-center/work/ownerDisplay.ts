/**
 * Owner humanDisplay presentation helpers (Work).
 * ADDENDUM V1.1 §C / V1.2: primary title is always scannable —
 * humanTitle (non-placeholder) → cleaned technicalTitle → taskId.
 * Placeholder "Konten pemilik memerlukan peninjauan" is NEVER the sole title;
 * review state is a badge/status, not the primary line.
 * REVIEWED + non-placeholder owner primary remains the preferred ready path.
 */

export type OwnerDisplayCitation = {
  field: string
  path: string
  note?: string
}

export type OwnerDisplayInput = {
  /** Technical/system title — used as cleaned fallback, never preferred over reviewed human. */
  technicalTitle: string
  /** Task id for always-visible secondary + last-resort primary fallback. */
  taskId?: string | null
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
  /** Owner-facing primary title — never bare placeholder. */
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
  /** True when primary came from cleaned technical / taskId fallback. */
  usedTechnicalFallback: boolean
}

/** Canonical blocked shell copy — forbidden as the only primary title. */
export const OWNER_CONTENT_PLACEHOLDER = 'Konten pemilik memerlukan peninjauan'
const OWNER_CONTENT_PLACEHOLDER_SHORT = 'Konten perlu ditinjau'

function trimOrNull(v: string | null | undefined): string | null {
  const t = (v ?? '').trim()
  return t.length > 0 ? t : null
}

/**
 * True when the string is empty or is a known content-review shell placeholder.
 * These must never be the sole owner-facing primary title (V1.1 §C).
 */
export function isOwnerTitlePlaceholder(value: string | null | undefined): boolean {
  const t = (value ?? '').trim()
  if (!t) return true
  const lower = t.toLowerCase()
  if (lower === OWNER_CONTENT_PLACEHOLDER.toLowerCase()) return true
  if (lower === OWNER_CONTENT_PLACEHOLDER_SHORT.toLowerCase()) return true
  if (lower === 'content_review_required') return true
  return false
}

/**
 * Strip technical ids (bracket FC tags, T-/FC- style tokens) and light-normalize for owner scan.
 * Mirrors FeatureDetail presentation policy (ADDENDUM C).
 */
export function cleanTechnicalTitle(raw: string): string {
  let s = raw.trim()
  if (!s) return s
  s = s.replace(/\[[^\]]*\]\s*/g, '')
  s = s.replace(/\b(?:T|FC|BE|WEB|RN|AFF|SALES)-[A-Z0-9._-]+\b/gi, '')
  s = s.replace(/[_/]+/g, ' ')
  s = s.replace(/\s+/g, ' ').trim()
  if (!s || isOwnerTitlePlaceholder(s)) return raw.trim()
  // Sentence-case first char; leave rest as source (often already mixed).
  return s.charAt(0).toUpperCase() + s.slice(1)
}

/**
 * Owner primary resolution (V1.1 §C):
 * 1. Non-placeholder human/owner title (reviewed preferred; generated still usable)
 * 2. Cleaned technical title
 * 3. taskId
 *
 * Ready (contentReviewRequired=false) only when:
 * - contentReviewRequired flag === false
 * - non-placeholder ownerPrimaryTitle present
 * - effectiveReviewStatus === 'REVIEWED'
 *
 * GENERATED_NEEDS_REVIEW / BLOCKED / CONFLICT keep the human title when present
 * but stay contentReviewRequired=true (badge as status, not title).
 */
export function resolveOwnerDisplay(
  input: OwnerDisplayInput,
): OwnerDisplayResolved {
  const nested = input.ownerHumanDisplay
  const technicalTitle = input.technicalTitle ?? ''
  const taskId = trimOrNull(input.taskId)
  const ownerPrimaryRaw = trimOrNull(
    input.ownerPrimaryTitle ?? nested?.ownerPrimaryTitle,
  )
  const ownerPrimary = isOwnerTitlePlaceholder(ownerPrimaryRaw)
    ? null
    : ownerPrimaryRaw
  const statusRaw = trimOrNull(
    input.effectiveReviewStatus ?? nested?.effectiveReviewStatus,
  )
  const reviewFlag =
    input.contentReviewRequired ?? nested?.contentReviewRequired
  // Strict REVIEWED only — never trust inconsistent contentReviewRequired=false
  // when status is GENERATED_NEEDS_REVIEW / BLOCKED / CONFLICT / other.
  const ready =
    reviewFlag === false && ownerPrimary != null && statusRaw === 'REVIEWED'

  const contentReviewRequired = !ready

  let primaryTitle: string
  let usedTechnicalFallback = false
  if (ownerPrimary) {
    primaryTitle = ownerPrimary
  } else {
    const cleaned = cleanTechnicalTitle(technicalTitle)
    if (cleaned && !isOwnerTitlePlaceholder(cleaned)) {
      primaryTitle = cleaned
      usedTechnicalFallback = true
    } else if (taskId) {
      primaryTitle = taskId
      usedTechnicalFallback = true
    } else if (technicalTitle.trim() && !isOwnerTitlePlaceholder(technicalTitle)) {
      primaryTitle = technicalTitle.trim()
      usedTechnicalFallback = true
    } else {
      primaryTitle = taskId ?? 'Tugas tanpa judul'
      usedTechnicalFallback = true
    }
  }

  // Hard guard: never leave a placeholder as the sole primary title.
  if (isOwnerTitlePlaceholder(primaryTitle)) {
    const cleaned = cleanTechnicalTitle(technicalTitle)
    primaryTitle =
      (cleaned && !isOwnerTitlePlaceholder(cleaned) ? cleaned : null) ||
      taskId ||
      'Tugas tanpa judul'
    usedTechnicalFallback = true
  }

  const effectiveReviewStatus =
    statusRaw ??
    (contentReviewRequired ? 'CONTENT_REVIEW_REQUIRED' : 'REVIEWED')

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
    usedTechnicalFallback,
  }
}
