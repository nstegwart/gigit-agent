/**
 * Human-first content contract foundation (ART-UX-DIRECTION.md).
 *
 * Pure module: no I/O, no DB, no UI wiring, no migration.
 * Produces versioned id-ID `humanDisplay` projections, fail-closed review
 * resolution, deterministic status sentences, and separate readiness rails.
 *
 * Classification rule: never invent PRODUCT — only pass through explicit
 * classified inputs. Missing/unknown class → UNCLASSIFIED.
 *
 * schemaVersion: TM_HUMAN_DISPLAY_V1
 */

import { createHash } from 'node:crypto'

// ---------------------------------------------------------------------------
// Schema / enums
// ---------------------------------------------------------------------------

export const HUMAN_DISPLAY_SCHEMA_VERSION = 'TM_HUMAN_DISPLAY_V1' as const
export type HumanDisplaySchemaVersion = typeof HUMAN_DISPLAY_SCHEMA_VERSION

export const DEFAULT_HUMAN_LOCALE = 'id-ID' as const

export type HumanDisplayEntityKind = 'task' | 'project' | 'feature'

export type HumanDisplayReviewStatus =
  | 'REVIEWED'
  | 'GENERATED_NEEDS_REVIEW'
  | 'BLOCKED_MISSING_SOURCE'
  | 'CONFLICT'
  | 'CONTENT_REVIEW_REQUIRED'

export const HUMAN_DISPLAY_REVIEW_STATUSES: ReadonlyArray<HumanDisplayReviewStatus> =
  [
    'REVIEWED',
    'GENERATED_NEEDS_REVIEW',
    'BLOCKED_MISSING_SOURCE',
    'CONFLICT',
    'CONTENT_REVIEW_REQUIRED',
  ] as const

/** Work-bucket / disposition keys used for status sentences (parent PrimaryBucket + HOLD/EXCLUDE). */
export type HumanStatusBucket =
  | 'DONE'
  | 'ONGOING'
  | 'NEXT'
  | 'QUEUED'
  | 'BLOCKED'
  | 'RECONCILIATION_PENDING'
  | 'HOLD'
  | 'EXCLUDE'

export const HUMAN_STATUS_BUCKETS: ReadonlyArray<HumanStatusBucket> = [
  'DONE',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
  'RECONCILIATION_PENDING',
  'HOLD',
  'EXCLUDE',
] as const

/** Separate readiness rails — never collapsed into workBucket (ART L190–211). */
export type ReadinessRailKind = 'mapping' | 'product' | 'program'

export type TaskClassInput = 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED' | string | null | undefined

// ---------------------------------------------------------------------------
// HumanDisplay payload (ART L77–94 + task foundation fields)
// ---------------------------------------------------------------------------

/**
 * Versioned owner-facing copy. Primary locale is id-ID.
 *
 * Compact aliases (task brief): why→whyItMatters, current→currentState,
 * remaining→remainingWork, next→nextAction, blocker→blockerSummary.
 */
export interface HumanDisplayV1 {
  schemaVersion: HumanDisplaySchemaVersion
  locale: string
  /** Concrete observable outcome; never begins with ID/FC/"Parity"/… */
  title: string
  outcome: string
  why: string
  current: string
  remaining: string
  next: string
  doneWhen: string
  blocker: string
  ownerAction: string
  reviewStatus: HumanDisplayReviewStatus
  /** SHA-256 hex of declared source facts (not of the prose alone). */
  sourceHash: string
  /** Independent review timestamp; null until real review. */
  reviewedAt: string | null
  contentVersion: number
  entityKind: HumanDisplayEntityKind
  entityId: string
  /** ART-required human bindings (fail-closed when missing on owner primary). */
  parentFeatureTitle: string
  businessArea: string
  actor: string
  /** Pin bindings — non-null required for REVIEWED owner primary. */
  snapshotId: string | null
  boardRev: number | null
  lifecycleRev: number | null
  /** Optional canonical snapshot hash binding (pin). */
  canonicalHash?: string | null
  /** Source-grounded citations for non-trivial statements. */
  citations: ReadonlyArray<HumanDisplayCitation>
  /** Acceptance / doneWhen evidence links (paths into canonical sources). */
  acceptanceLinks: ReadonlyArray<HumanDisplayAcceptanceLink>
  /** Mission-question projection (Q1–Q8) for owner comprehension gate. */
  missionQuestionLinks: ReadonlyArray<HumanDisplayMissionQuestionLink>
}

export interface HumanDisplayCitation {
  field: string
  path: string
  note?: string
}

export interface HumanDisplayAcceptanceLink {
  /** Acceptance criterion id when known. */
  id?: string
  /** Canonical path / anchor into source truth. */
  path: string
  summary?: string
}

export interface HumanDisplayMissionQuestionLink {
  /** Mission question id, e.g. Q1…Q8. */
  questionId: string
  /** HumanDisplay field or surface that answers it. */
  field?: string
  note?: string
}

/** Compact field list required for a non-blocked owner primary surface. */
export const HUMAN_DISPLAY_REQUIRED_COPY_FIELDS = [
  'title',
  'outcome',
  'why',
  'current',
  'remaining',
  'next',
  'doneWhen',
  'blocker',
  'ownerAction',
] as const satisfies ReadonlyArray<keyof HumanDisplayV1>

export type HumanDisplayRequiredCopyField =
  (typeof HUMAN_DISPLAY_REQUIRED_COPY_FIELDS)[number]

/** ART-required human bindings (not technical IDs). */
export const HUMAN_DISPLAY_REQUIRED_ART_BINDINGS = [
  'parentFeatureTitle',
  'businessArea',
  'actor',
] as const satisfies ReadonlyArray<keyof HumanDisplayV1>

export type HumanDisplayRequiredArtBinding =
  (typeof HUMAN_DISPLAY_REQUIRED_ART_BINDINGS)[number]

/** Link/projection collections required for owner primary. */
export const HUMAN_DISPLAY_REQUIRED_LINK_FIELDS = [
  'citations',
  'acceptanceLinks',
  'missionQuestionLinks',
] as const satisfies ReadonlyArray<keyof HumanDisplayV1>

export type HumanDisplayRequiredLinkField =
  (typeof HUMAN_DISPLAY_REQUIRED_LINK_FIELDS)[number]

// ---------------------------------------------------------------------------
// Source facts + hash
// ---------------------------------------------------------------------------

/**
 * Canonical source facts used to bind human copy. Changing any of these
 * invalidates REVIEWED when sourceHash no longer matches.
 * Never invents PRODUCT — taskClass is stored only if explicitly provided.
 */
export interface HumanDisplaySourceFacts {
  entityKind: HumanDisplayEntityKind
  entityId: string
  /** Technical SSOT title (not owner primary). */
  technicalTitle?: string | null
  objective?: string | null
  projectId?: string | null
  featureId?: string | null
  featureContractId?: string | null
  lifecycleStage?: string | null
  disposition?: string | null
  /**
   * Explicit classification only. Missing/unknown → treated as UNCLASSIFIED
   * for product contribution; never coerced to PRODUCT.
   */
  taskClass?: TaskClassInput
  dependencies?: ReadonlyArray<string> | null
  acceptance?: string | null
  evidenceRefs?: ReadonlyArray<string> | null
  decisionIds?: ReadonlyArray<string> | null
  canonicalSnapshotId?: string | null
  canonicalHash?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  extra?: Readonly<Record<string, string | number | boolean | null>>
}

export function normalizeTaskClass(input: TaskClassInput): 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED' {
  if (input === 'PRODUCT' || input === 'CONTROL_PLANE' || input === 'UNCLASSIFIED') {
    return input
  }
  // Fail closed: never guess PRODUCT from free text or missing value.
  return 'UNCLASSIFIED'
}

/** True only when classification is explicitly PRODUCT (never inferred). */
export function isExplicitProduct(input: TaskClassInput): boolean {
  return input === 'PRODUCT'
}

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * Deterministic SHA-256 of normalized source facts.
 * Arrays sorted; keys sorted; null/empty normalized.
 */
export function computeHumanDisplaySourceHash(facts: HumanDisplaySourceFacts): string {
  const normalized = {
    schemaVersion: HUMAN_DISPLAY_SCHEMA_VERSION,
    entityKind: facts.entityKind,
    entityId: facts.entityId,
    technicalTitle: facts.technicalTitle ?? null,
    objective: facts.objective ?? null,
    projectId: facts.projectId ?? null,
    featureId: facts.featureId ?? null,
    featureContractId: facts.featureContractId ?? null,
    lifecycleStage: facts.lifecycleStage ?? null,
    disposition: facts.disposition ?? null,
    taskClass: normalizeTaskClass(facts.taskClass),
    dependencies: [...(facts.dependencies ?? [])].map(String).sort(),
    acceptance: facts.acceptance ?? null,
    evidenceRefs: [...(facts.evidenceRefs ?? [])].map(String).sort(),
    decisionIds: [...(facts.decisionIds ?? [])].map(String).sort(),
    canonicalSnapshotId: facts.canonicalSnapshotId ?? null,
    canonicalHash: facts.canonicalHash ?? null,
    boardRev: facts.boardRev ?? null,
    lifecycleRev: facts.lifecycleRev ?? null,
    extra: facts.extra ?? {},
  }
  return createHash('sha256').update(stableStringify(normalized)).digest('hex')
}

// ---------------------------------------------------------------------------
// Fail-closed evaluation
// ---------------------------------------------------------------------------

export type HumanDisplayInvalidReason =
  | 'MISSING_DISPLAY'
  | 'MISSING_REQUIRED_FIELD'
  | 'EMPTY_REQUIRED_FIELD'
  | 'MISSING_ART_BINDING'
  | 'EMPTY_ART_BINDING'
  | 'MISSING_CITATIONS'
  | 'MISSING_ACCEPTANCE_LINKS'
  | 'MISSING_MISSION_QUESTION_LINKS'
  | 'TITLE_LINT_FAILED'
  | 'INVALID_SCHEMA_VERSION'
  | 'INVALID_LOCALE'
  | 'INVALID_REVIEW_STATUS'
  | 'MISSING_SOURCE_HASH'
  | 'STALE_SOURCE_HASH'
  | 'MISSING_SNAPSHOT_BINDING'
  | 'MISSING_BOARD_REV_BINDING'
  | 'MISSING_LIFECYCLE_REV_BINDING'
  | 'MISSING_CANONICAL_HASH_BINDING'
  | 'STALE_SNAPSHOT'
  | 'STALE_BOARD_REV'
  | 'STALE_LIFECYCLE_REV'
  | 'ENTITY_MISMATCH'
  | 'CONFLICT_DECLARED'
  | 'BLOCKED_MISSING_SOURCE_DECLARED'
  | 'REVIEWED_WITHOUT_REVIEWED_AT'

export interface HumanDisplayLivePin {
  canonicalSnapshotId?: string | null
  /** Live canonical hash when available; display must bind it when present. */
  canonicalHash?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  /** Live recomputed source hash for the entity. */
  liveSourceHash: string
}

export interface HumanDisplayEvaluation {
  ok: boolean
  /** Effective status after fail-closed rules (may demote REVIEWED). */
  effectiveReviewStatus: HumanDisplayReviewStatus
  reasons: Array<HumanDisplayInvalidReason>
  missingFields: Array<HumanDisplayRequiredCopyField>
  /** ART binding keys missing or empty. */
  missingArtBindings: Array<HumanDisplayRequiredArtBinding>
  /** Title lint codes when TITLE_LINT_FAILED. */
  titleLintCodes: Array<HumanTitleLintCode>
  /**
   * When ok=false for owner primary, surface this constant.
   * Release-blocking for affected required scope.
   */
  releaseBlocker: 'CONTENT_REVIEW_REQUIRED' | null
  /** Display safe to use as owner primary (REVIEWED + valid + fresh). */
  ownerPrimaryReady: boolean
}

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function isReviewStatus(v: unknown): v is HumanDisplayReviewStatus {
  return (
    typeof v === 'string' &&
    (HUMAN_DISPLAY_REVIEW_STATUSES as ReadonlyArray<string>).includes(v)
  )
}

/**
 * Fail-closed validity of a humanDisplay against live source + pin.
 * Missing, incomplete, stale, conflicted, or unreviewed primary copy →
 * effectiveReviewStatus CONTENT_REVIEW_REQUIRED (or preserved BLOCKED/CONFLICT).
 * Never returns ownerPrimaryReady for non-REVIEWED or stale REVIEWED.
 */
export function evaluateHumanDisplay(
  display: HumanDisplayV1 | null | undefined,
  live: HumanDisplayLivePin,
  opts: {
    entityKind?: HumanDisplayEntityKind
    entityId?: string
  } = {},
): HumanDisplayEvaluation {
  const reasons: Array<HumanDisplayInvalidReason> = []
  const missingFields: Array<HumanDisplayRequiredCopyField> = []
  const missingArtBindings: Array<HumanDisplayRequiredArtBinding> = []
  const titleLintCodes: Array<HumanTitleLintCode> = []

  if (!display) {
    return {
      ok: false,
      effectiveReviewStatus: 'CONTENT_REVIEW_REQUIRED',
      reasons: ['MISSING_DISPLAY'],
      missingFields: [...HUMAN_DISPLAY_REQUIRED_COPY_FIELDS],
      missingArtBindings: [...HUMAN_DISPLAY_REQUIRED_ART_BINDINGS],
      titleLintCodes: [],
      releaseBlocker: 'CONTENT_REVIEW_REQUIRED',
      ownerPrimaryReady: false,
    }
  }

  if (display.schemaVersion !== HUMAN_DISPLAY_SCHEMA_VERSION) {
    reasons.push('INVALID_SCHEMA_VERSION')
  }

  if (!isNonEmptyString(display.locale)) {
    reasons.push('INVALID_LOCALE')
  }

  if (!isReviewStatus(display.reviewStatus)) {
    reasons.push('INVALID_REVIEW_STATUS')
  }

  if (!isNonEmptyString(display.sourceHash)) {
    reasons.push('MISSING_SOURCE_HASH')
  } else if (display.sourceHash !== live.liveSourceHash) {
    reasons.push('STALE_SOURCE_HASH')
  }

  if (opts.entityKind != null && display.entityKind !== opts.entityKind) {
    reasons.push('ENTITY_MISMATCH')
  }
  if (opts.entityId != null && display.entityId !== opts.entityId) {
    reasons.push('ENTITY_MISMATCH')
  }

  // Pin bindings must be non-null for owner-primary readiness (fail-closed).
  if (!isNonEmptyString(display.snapshotId)) {
    reasons.push('MISSING_SNAPSHOT_BINDING')
  }
  if (display.boardRev == null || !Number.isFinite(display.boardRev)) {
    reasons.push('MISSING_BOARD_REV_BINDING')
  }
  if (display.lifecycleRev == null || !Number.isFinite(display.lifecycleRev)) {
    reasons.push('MISSING_LIFECYCLE_REV_BINDING')
  }
  // When live provides a canonical hash, display must bind a non-null hash.
  if (
    isNonEmptyString(live.canonicalHash ?? null) &&
    !isNonEmptyString(display.canonicalHash ?? null)
  ) {
    reasons.push('MISSING_CANONICAL_HASH_BINDING')
  }

  if (
    live.canonicalSnapshotId != null &&
    display.snapshotId != null &&
    display.snapshotId !== live.canonicalSnapshotId
  ) {
    reasons.push('STALE_SNAPSHOT')
  }
  if (
    live.boardRev != null &&
    display.boardRev != null &&
    display.boardRev !== live.boardRev
  ) {
    reasons.push('STALE_BOARD_REV')
  }
  if (
    live.lifecycleRev != null &&
    display.lifecycleRev != null &&
    display.lifecycleRev !== live.lifecycleRev
  ) {
    reasons.push('STALE_LIFECYCLE_REV')
  }

  for (const field of HUMAN_DISPLAY_REQUIRED_COPY_FIELDS) {
    const val = display[field]
    if (val == null) {
      missingFields.push(field)
      reasons.push('MISSING_REQUIRED_FIELD')
    } else if (typeof val === 'string' && val.trim() === '') {
      missingFields.push(field)
      reasons.push('EMPTY_REQUIRED_FIELD')
    }
  }

  for (const field of HUMAN_DISPLAY_REQUIRED_ART_BINDINGS) {
    const val = display[field]
    if (val == null) {
      missingArtBindings.push(field)
      reasons.push('MISSING_ART_BINDING')
    } else if (typeof val === 'string' && val.trim() === '') {
      missingArtBindings.push(field)
      reasons.push('EMPTY_ART_BINDING')
    }
  }

  if (!Array.isArray(display.citations) || display.citations.length === 0) {
    reasons.push('MISSING_CITATIONS')
  }
  if (
    !Array.isArray(display.acceptanceLinks) ||
    display.acceptanceLinks.length === 0
  ) {
    reasons.push('MISSING_ACCEPTANCE_LINKS')
  }
  if (
    !Array.isArray(display.missionQuestionLinks) ||
    display.missionQuestionLinks.length === 0
  ) {
    reasons.push('MISSING_MISSION_QUESTION_LINKS')
  }

  // Review gate always invokes title lint (quality floor).
  const titleLint = lintHumanTitle(display.title)
  if (!titleLint.ok) {
    reasons.push('TITLE_LINT_FAILED')
    titleLintCodes.push(...titleLint.codes)
  }

  // Declared terminal-ish review states preserved when structure is otherwise ok.
  if (display.reviewStatus === 'CONFLICT') {
    reasons.push('CONFLICT_DECLARED')
  }
  if (display.reviewStatus === 'BLOCKED_MISSING_SOURCE') {
    reasons.push('BLOCKED_MISSING_SOURCE_DECLARED')
  }

  if (display.reviewStatus === 'REVIEWED' && !isNonEmptyString(display.reviewedAt)) {
    reasons.push('REVIEWED_WITHOUT_REVIEWED_AT')
  }

  const structuralFail =
    reasons.includes('INVALID_SCHEMA_VERSION') ||
    reasons.includes('INVALID_LOCALE') ||
    reasons.includes('INVALID_REVIEW_STATUS') ||
    reasons.includes('MISSING_SOURCE_HASH') ||
    reasons.includes('MISSING_REQUIRED_FIELD') ||
    reasons.includes('EMPTY_REQUIRED_FIELD') ||
    reasons.includes('MISSING_ART_BINDING') ||
    reasons.includes('EMPTY_ART_BINDING') ||
    reasons.includes('MISSING_CITATIONS') ||
    reasons.includes('MISSING_ACCEPTANCE_LINKS') ||
    reasons.includes('MISSING_MISSION_QUESTION_LINKS') ||
    reasons.includes('TITLE_LINT_FAILED') ||
    reasons.includes('MISSING_SNAPSHOT_BINDING') ||
    reasons.includes('MISSING_BOARD_REV_BINDING') ||
    reasons.includes('MISSING_LIFECYCLE_REV_BINDING') ||
    reasons.includes('MISSING_CANONICAL_HASH_BINDING') ||
    reasons.includes('ENTITY_MISMATCH') ||
    missingFields.length > 0 ||
    missingArtBindings.length > 0

  const stale =
    reasons.includes('STALE_SOURCE_HASH') ||
    reasons.includes('STALE_SNAPSHOT') ||
    reasons.includes('STALE_BOARD_REV') ||
    reasons.includes('STALE_LIFECYCLE_REV')

  let effective: HumanDisplayReviewStatus

  if (display.reviewStatus === 'CONFLICT' || reasons.includes('CONFLICT_DECLARED')) {
    effective = 'CONFLICT'
  } else if (
    display.reviewStatus === 'BLOCKED_MISSING_SOURCE' ||
    reasons.includes('BLOCKED_MISSING_SOURCE_DECLARED')
  ) {
    effective = 'BLOCKED_MISSING_SOURCE'
  } else if (structuralFail || stale || reasons.includes('REVIEWED_WITHOUT_REVIEWED_AT')) {
    // Stale / incomplete REVIEWED demotes to CONTENT_REVIEW_REQUIRED (ART L115–116).
    effective = 'CONTENT_REVIEW_REQUIRED'
  } else if (display.reviewStatus === 'GENERATED_NEEDS_REVIEW') {
    effective = 'GENERATED_NEEDS_REVIEW'
  } else if (display.reviewStatus === 'REVIEWED') {
    effective = 'REVIEWED'
  } else if (display.reviewStatus === 'CONTENT_REVIEW_REQUIRED') {
    effective = 'CONTENT_REVIEW_REQUIRED'
  } else {
    effective = 'CONTENT_REVIEW_REQUIRED'
  }

  const ownerPrimaryReady = effective === 'REVIEWED' && !structuralFail && !stale
  const ok = ownerPrimaryReady
  const releaseBlocker: 'CONTENT_REVIEW_REQUIRED' | null =
    ownerPrimaryReady ? null : 'CONTENT_REVIEW_REQUIRED'

  return {
    ok,
    effectiveReviewStatus: effective,
    reasons: [...new Set(reasons)],
    missingFields: [...new Set(missingFields)],
    missingArtBindings: [...new Set(missingArtBindings)],
    titleLintCodes: [...new Set(titleLintCodes)],
    releaseBlocker,
    ownerPrimaryReady,
  }
}

/**
 * Resolve owner-facing display: returns the payload only when REVIEWED+fresh;
 * otherwise a fail-closed blocked shell that never exposes technical title as primary.
 */
export function resolveOwnerHumanDisplay(
  display: HumanDisplayV1 | null | undefined,
  live: HumanDisplayLivePin,
  opts: {
    entityKind: HumanDisplayEntityKind
    entityId: string
  },
): {
  evaluation: HumanDisplayEvaluation
  /** Null when not owner-primary-ready — UI must show content-review warning. */
  primary: HumanDisplayV1 | null
  /** Always present blocked shell for list visibility (never omit entity). */
  blockedShell: HumanDisplayV1
} {
  const evaluation = evaluateHumanDisplay(display, live, opts)
  const blockedShell = buildContentReviewRequiredShell({
    entityKind: opts.entityKind,
    entityId: opts.entityId,
    liveSourceHash: live.liveSourceHash,
    snapshotId: live.canonicalSnapshotId ?? null,
    boardRev: live.boardRev ?? null,
    lifecycleRev: live.lifecycleRev ?? null,
    reasons: evaluation.reasons,
  })

  if (evaluation.ownerPrimaryReady && display) {
    return {
      evaluation,
      primary: {
        ...display,
        reviewStatus: 'REVIEWED',
      },
      blockedShell,
    }
  }

  return {
    evaluation,
    primary: null,
    blockedShell,
  }
}

export function buildContentReviewRequiredShell(args: {
  entityKind: HumanDisplayEntityKind
  entityId: string
  liveSourceHash: string
  snapshotId?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  reasons?: ReadonlyArray<HumanDisplayInvalidReason>
}): HumanDisplayV1 {
  const reasonNote =
    args.reasons && args.reasons.length > 0
      ? ` Alasan: ${args.reasons.join(', ')}.`
      : ''
  return {
    schemaVersion: HUMAN_DISPLAY_SCHEMA_VERSION,
    locale: DEFAULT_HUMAN_LOCALE,
    title: 'Konten pemilik memerlukan peninjauan',
    outcome:
      'Salinan manusia untuk item ini belum siap ditampilkan sebagai kebenaran utama.',
    why: 'Salinan teknis mentah tidak boleh menjadi teks utama bagi pemilik.',
    current: `Status peninjauan: CONTENT_REVIEW_REQUIRED.${reasonNote}`,
    remaining: 'Tulis dan tinjau salinan manusia yang terikat ke fakta sumber.',
    next: 'Lengkapi humanDisplay dan minta peninjauan independen.',
    doneWhen: 'reviewStatus=REVIEWED dengan sourceHash yang cocok ke fakta sumber.',
    blocker: 'CONTENT_REVIEW_REQUIRED — salinan hilang, basi, konflik, atau belum ditinjau.',
    ownerAction: 'Tinjau atau tugaskan peninjauan salinan manusia untuk item ini.',
    reviewStatus: 'CONTENT_REVIEW_REQUIRED',
    sourceHash: args.liveSourceHash,
    reviewedAt: null,
    contentVersion: 0,
    entityKind: args.entityKind,
    entityId: args.entityId,
    parentFeatureTitle: 'Tidak diketahui',
    businessArea: 'Tidak diketahui',
    actor: 'Tidak diketahui',
    snapshotId: args.snapshotId ?? null,
    boardRev: args.boardRev ?? null,
    lifecycleRev: args.lifecycleRev ?? null,
    canonicalHash: null,
    citations: [
      {
        field: 'reviewStatus',
        path: 'humanDisplay.evaluateHumanDisplay',
        note: 'fail-closed shell',
      },
    ],
    acceptanceLinks: [
      {
        path: 'humanDisplay.evaluateHumanDisplay',
        summary: 'shell — acceptance belum terikat',
      },
    ],
    missionQuestionLinks: [
      {
        questionId: 'Q-CONTENT-REVIEW',
        field: 'reviewStatus',
        note: 'fail-closed shell — mission projection incomplete',
      },
    ],
  }
}

// ---------------------------------------------------------------------------
// Status sentence contract (ART L213–238)
// ---------------------------------------------------------------------------

export interface StatusSentenceInput {
  /** Exclusive primary bucket or disposition rail HOLD/EXCLUDE. */
  bucket: HumanStatusBucket | string
  gate?: string | null
  outcome?: string | null
  time?: string | null
  relativeTime?: string | null
  independentRole?: string | null
  laterReadinessNote?: string | null
  role?: string | null
  nextAction?: string | null
  condition?: string | null
  /** Dispatch / priority reason for NEXT (required; no fabricated default). */
  priorityReason?: string | null
  /** Alias of priorityReason for dispatch plan reason. */
  dispatchReason?: string | null
  /** Dispatch rank for NEXT (required). */
  dispatchRank?: number | string | null
  /** Dispatch plan board revision pin for NEXT (required). */
  dispatchBoardRev?: number | null
  /** Dispatch plan lifecycle revision pin for NEXT (required). */
  dispatchLifecycleRev?: number | null
  /** Capacity / queue reason for QUEUED (required). */
  queueReason?: string | null
  /** Blocker cause for BLOCKED (required). */
  cause?: string | null
  /** Who must unblock (required for BLOCKED). */
  unblockRole?: string | null
  /** Unblock action (required for BLOCKED). */
  unblockAction?: string | null
  impact?: string | null
  excludeReason?: string | null
  /**
   * When true, ONGOING is demoted to RECONCILIATION sentence
   * (stale/orphan claim or expired lease never ONGOING).
   */
  claimOrLeaseInvalid?: boolean
  /**
   * Explicit ONGOING truth. All three must be true for a confident ONGOING
   * sentence; missing/false (without claimOrLeaseInvalid) → CONTENT_REVIEW_REQUIRED.
   */
  claimValid?: boolean | null
  leaseValid?: boolean | null
  heartbeatFresh?: boolean | null
  evidenceSummary?: string | null
  decisionSummary?: string | null
}

export interface StatusSentenceResult {
  bucket: HumanStatusBucket | 'UNKNOWN' | 'CONTENT_REVIEW_REQUIRED'
  sentence: string
  /** True when input was demoted from ONGOING due to invalid claim/lease. */
  demotedFromOngoing: boolean
  /** True when required truth for a confident sentence is missing. */
  contentReviewRequired: boolean
  /** Machine keys naming missing truth (tests / UI chips). */
  missingTruth: Array<string>
}

function fill(template: string, vars: Record<string, string>): string {
  let out = template
  for (const [k, v] of Object.entries(vars)) {
    out = out.split(`<${k}>`).join(v)
  }
  // Collapse leftover empty clause fragments lightly.
  return out.replace(/\s{2,}/g, ' ').replace(/\s+\./g, '.').trim()
}

function nonEmpty(v: string | null | undefined): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function requireNonEmpty(
  missing: Array<string>,
  key: string,
  v: string | null | undefined,
): string | null {
  if (!nonEmpty(v)) {
    missing.push(key)
    return null
  }
  return String(v).trim()
}

function contentReviewSentence(missing: ReadonlyArray<string>): string {
  const detail =
    missing.length > 0 ? ` Kebenaran hilang: ${missing.join(', ')}.` : ''
  return `Status pekerjaan memerlukan peninjauan konten — data kebenaran untuk kalimat status tidak lengkap.${detail}`
}

/**
 * Deterministic id-ID status sentences. Never returns a naked enum as primary text.
 * Never fabricates confident defaults for ONGOING/NEXT/QUEUED/BLOCKED.
 * ONGOING with invalid claim/lease → RECONCILIATION_PENDING sentence.
 * Missing required truth → CONTENT_REVIEW_REQUIRED.
 */
export function buildStatusSentence(input: StatusSentenceInput): StatusSentenceResult {
  let bucket = normalizeStatusBucket(input.bucket)
  let demotedFromOngoing = false
  const missingTruth: Array<string> = []

  if (bucket === 'ONGOING' && input.claimOrLeaseInvalid === true) {
    bucket = 'RECONCILIATION_PENDING'
    demotedFromOngoing = true
  }

  const later = nonEmpty(input.laterReadinessNote)
    ? ` ${String(input.laterReadinessNote).trim()}`
    : ''

  let sentence: string

  switch (bucket) {
    case 'DONE': {
      const gate = requireNonEmpty(missingTruth, 'gate', input.gate)
      const outcome = requireNonEmpty(missingTruth, 'outcome', input.outcome)
      const time = requireNonEmpty(missingTruth, 'time', input.time)
      const role = requireNonEmpty(
        missingTruth,
        'independentRole',
        input.independentRole,
      )
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Selesai untuk <gate> — <outcome> lolos pada <time>. Bukti diverifikasi oleh <independent role>.<later>',
        {
          gate: gate!,
          outcome: outcome!,
          time: time!,
          'independent role': role!,
          later,
        },
      )
      break
    }
    case 'ONGOING': {
      // Fail closed: require explicit valid claim + lease + fresh heartbeat.
      if (input.claimValid !== true) missingTruth.push('claimValid')
      if (input.leaseValid !== true) missingTruth.push('leaseValid')
      if (input.heartbeatFresh !== true) missingTruth.push('heartbeatFresh')
      const role = requireNonEmpty(missingTruth, 'role', input.role)
      const time = requireNonEmpty(missingTruth, 'time', input.time)
      const relative = requireNonEmpty(
        missingTruth,
        'relativeTime',
        input.relativeTime,
      )
      const action = requireNonEmpty(missingTruth, 'nextAction', input.nextAction)
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Sedang dikerjakan oleh <role> sejak <time>. Aktivitas terakhir <relative time>; langkah berikutnya <specific action>.',
        {
          role: role!,
          time: time!,
          'relative time': relative!,
          'specific action': action!,
        },
      )
      break
    }
    case 'NEXT': {
      const condition = requireNonEmpty(missingTruth, 'condition', input.condition)
      const reasonRaw = nonEmpty(input.dispatchReason)
        ? input.dispatchReason
        : input.priorityReason
      const reason = requireNonEmpty(
        missingTruth,
        'dispatchReason',
        reasonRaw,
      )
      if (
        input.dispatchRank == null ||
        (typeof input.dispatchRank === 'string' &&
          String(input.dispatchRank).trim() === '')
      ) {
        missingTruth.push('dispatchRank')
      }
      if (
        input.dispatchBoardRev == null ||
        !Number.isFinite(input.dispatchBoardRev)
      ) {
        missingTruth.push('dispatchBoardRev')
      }
      if (
        input.dispatchLifecycleRev == null ||
        !Number.isFinite(input.dispatchLifecycleRev)
      ) {
        missingTruth.push('dispatchLifecycleRev')
      }
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Berikutnya — siap dimulai setelah <condition>. Diprioritaskan karena <reason> (peringkat <rank>, rev board <boardRev>/lifecycle <lifecycleRev>).',
        {
          condition: condition!,
          reason: reason!,
          rank: String(input.dispatchRank),
          boardRev: String(input.dispatchBoardRev),
          lifecycleRev: String(input.dispatchLifecycleRev),
        },
      )
      break
    }
    case 'QUEUED': {
      const reason = requireNonEmpty(missingTruth, 'queueReason', input.queueReason)
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Menunggu giliran — pekerjaan valid tetapi belum dijadwalkan karena <reason>.',
        { reason: reason! },
      )
      break
    }
    case 'BLOCKED': {
      const cause = requireNonEmpty(missingTruth, 'cause', input.cause)
      const unblockRole = requireNonEmpty(
        missingTruth,
        'unblockRole',
        input.unblockRole,
      )
      const unblockAction = requireNonEmpty(
        missingTruth,
        'unblockAction',
        input.unblockAction,
      )
      const impact = requireNonEmpty(missingTruth, 'impact', input.impact)
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Terhambat — <cause>. Agar terbuka, <role/person> perlu <action>. Dampak: <scope>.',
        {
          cause: cause!,
          'role/person': unblockRole!,
          action: unblockAction!,
          scope: impact!,
        },
      )
      break
    }
    case 'RECONCILIATION_PENDING':
      sentence =
        'Sedang dicocokkan — klaim lama tidak memiliki heartbeat/lease valid. Sistem memastikan bukti dan kepemilikan sebelum menjadwalkan ulang.'
      if (input.evidenceSummary) {
        sentence += ` Bukti: ${String(input.evidenceSummary).trim()}.`
      }
      if (input.decisionSummary) {
        sentence += ` Keputusan: ${String(input.decisionSummary).trim()}.`
      }
      break
    case 'HOLD':
      sentence =
        'Ditahan berdasarkan keputusan owner; terlihat untuk dokumentasi tetapi tidak dikerjakan atau dihitung dalam progres aktif sampai dibuka.'
      if (input.decisionSummary) {
        sentence += ` Keputusan: ${String(input.decisionSummary).trim()}.`
      }
      break
    case 'EXCLUDE': {
      const cited = requireNonEmpty(
        missingTruth,
        'excludeReason',
        input.excludeReason,
      )
      if (missingTruth.length > 0) {
        return {
          bucket: 'CONTENT_REVIEW_REQUIRED',
          sentence: contentReviewSentence(missingTruth),
          demotedFromOngoing,
          contentReviewRequired: true,
          missingTruth,
        }
      }
      sentence = fill(
        'Dikecualikan dari cakupan aktif karena <cited reason>; tetap terlihat agar cakupan tidak hilang diam-diam.',
        { 'cited reason': cited! },
      )
      break
    }
    default:
      sentence =
        'Status pekerjaan belum dapat dijelaskan dalam bahasa pemilik — data bucket tidak dikenali.'
      return {
        bucket: 'UNKNOWN',
        sentence,
        demotedFromOngoing,
        contentReviewRequired: true,
        missingTruth: ['bucket'],
      }
  }

  return {
    bucket,
    sentence,
    demotedFromOngoing,
    contentReviewRequired: false,
    missingTruth: [],
  }
}

export function normalizeStatusBucket(
  raw: string | null | undefined,
): HumanStatusBucket | 'UNKNOWN' {
  if (!raw) return 'UNKNOWN'
  const s = String(raw).trim().toUpperCase()
  if (s === 'RECONCILIATION') return 'RECONCILIATION_PENDING'
  if ((HUMAN_STATUS_BUCKETS as ReadonlyArray<string>).includes(s)) {
    return s as HumanStatusBucket
  }
  return 'UNKNOWN'
}

// ---------------------------------------------------------------------------
// Readiness rails (separate from workBucket)
// ---------------------------------------------------------------------------

export interface MappingReadinessInput {
  lifecycleStage?: string | null
  mappingComplete?: boolean | null
}

export interface ProductReadinessInput {
  lifecycleStage?: string | null
  taskWeight?: number | null
  evidenceComplete?: boolean | null
}

export interface ProgramReadinessInput {
  g5Pass?: boolean | null
  boardReadinessPercent?: number | null
  complete?: boolean | null
  cappedBy?: string | null
  productDenominator?: number | null
}

export interface ReadinessRailSentence {
  rail: ReadinessRailKind
  /** Stable machine code for tests / UI chips (not owner primary alone). */
  code: string
  /** id-ID plain-language sentence. */
  sentence: string
}

/**
 * Mapping readiness rail — MAPPED/MAP_VERIFIED style progress, independent of workBucket.
 */
export function buildMappingReadinessSentence(
  input: MappingReadinessInput,
): ReadinessRailSentence {
  const stage = (input.lifecycleStage ?? '').toUpperCase()
  if (input.mappingComplete === true || stage === 'MAP_VERIFIED') {
    return {
      rail: 'mapping',
      code: 'MAP_VERIFIED',
      sentence:
        'Kesiapan pemetaan: peta sumber sudah diverifikasi (MAP_VERIFIED). Ini bukan kesiapan produk di staging/produksi.',
    }
  }
  if (stage === 'MAPPED') {
    return {
      rail: 'mapping',
      code: 'MAPPED',
      sentence:
        'Kesiapan pemetaan: peta sumber sudah ada (MAPPED) tetapi belum diverifikasi. Bucket kerja bisa berbeda.',
    }
  }
  if (stage === 'MAPPING') {
    return {
      rail: 'mapping',
      code: 'MAPPING',
      sentence: 'Kesiapan pemetaan: masih dalam proses memetakan sumber (MAPPING).',
    }
  }
  if (!stage) {
    return {
      rail: 'mapping',
      code: 'UNKNOWN',
      sentence:
        'Kesiapan pemetaan: tahap belum diketahui — tidak mengasumsikan peta selesai.',
    }
  }
  // Delivery stages imply mapping already past MAP_VERIFIED for product rail context,
  // but mapping rail still states mapping is complete without inventing product %.
  if (
    [
      'BUILT',
      'FUNCTIONAL',
      'INTEGRATED',
      'STAGING_PROVEN',
      'PROD_READY',
      'LIVE_VERIFIED',
    ].includes(stage)
  ) {
    return {
      rail: 'mapping',
      code: 'MAP_VERIFIED_IMPLIED',
      sentence:
        'Kesiapan pemetaan: tahap pengiriman sudah lewat MAP_VERIFIED; rel pemetaan dianggap selesai untuk tahap ini.',
    }
  }
  return {
    rail: 'mapping',
    code: 'UNKNOWN_STAGE',
    sentence: `Kesiapan pemetaan: tahap "${stage}" tidak dipetakan ke rel pemetaan — tidak mengarang status.`,
  }
}

/**
 * Product delivery readiness rail — target/staging evidence path (weights), not workBucket.
 */
export function buildProductReadinessSentence(
  input: ProductReadinessInput,
): ReadinessRailSentence {
  const stage = (input.lifecycleStage ?? '').toUpperCase()
  const weight =
    typeof input.taskWeight === 'number' && Number.isFinite(input.taskWeight)
      ? input.taskWeight
      : null
  const evidence =
    input.evidenceComplete === true
      ? 'bukti lengkap'
      : input.evidenceComplete === false
        ? 'bukti belum lengkap'
        : 'status bukti tidak diketahui'

  if (!stage && weight == null) {
    return {
      rail: 'product',
      code: 'UNKNOWN',
      sentence:
        'Kesiapan produk: belum diketahui — tidak menampilkan persen statis sebagai kebenaran.',
    }
  }

  if (stage === 'PROD_READY' || stage === 'LIVE_VERIFIED') {
    return {
      rail: 'product',
      code: stage,
      sentence: `Kesiapan produk: tahap ${stage} (bobot ${weight ?? 100}). ${evidence === 'bukti lengkap' ? 'Bukti pengiriman lengkap untuk tahap ini.' : `Catatan: ${evidence}.`} Ini terpisah dari bucket kerja (DONE/ONGOING/…).`,
    }
  }

  if (stage) {
    return {
      rail: 'product',
      code: stage,
      sentence: `Kesiapan produk: tahap ${stage}${weight != null ? ` (bobot kebijakan ${weight})` : ''}. ${evidence.charAt(0).toUpperCase()}${evidence.slice(1)}. Bucket kerja bukan persen kesiapan.`,
    }
  }

  return {
    rail: 'product',
    code: 'WEIGHT_ONLY',
    sentence: `Kesiapan produk: bobot kebijakan ${weight}. Tahap tidak disetel; tidak mengarang PROD_READY.`,
  }
}

/**
 * Program readiness rail — scoped/global rollup + G5 gates.
 * Never invents 100% when product denominator empty.
 */
export function buildProgramReadinessSentence(
  input: ProgramReadinessInput,
): ReadinessRailSentence {
  if (input.productDenominator === 0) {
    return {
      rail: 'program',
      code: 'EMPTY_PRODUCT_SCOPE',
      sentence:
        'Kesiapan program: cakupan produk kosong — persen program tidak ditampilkan sebagai 100%.',
    }
  }

  if (input.complete === true && input.g5Pass === true) {
    return {
      rail: 'program',
      code: 'COMPLETE',
      sentence:
        'Kesiapan program: gerbang program (G5) lulus dan kriteria complete terpenuhi pada pin saat ini.',
    }
  }

  const pct =
    typeof input.boardReadinessPercent === 'number' &&
    Number.isFinite(input.boardReadinessPercent)
      ? input.boardReadinessPercent
      : null
  const g5 =
    input.g5Pass === true ? 'G5 lulus' : input.g5Pass === false ? 'G5 belum lulus' : 'G5 tidak diketahui'
  const cap = input.cappedBy ? ` dibatasi oleh ${input.cappedBy}` : ''

  if (pct == null) {
    return {
      rail: 'program',
      code: 'NULL_PERCENT',
      sentence: `Kesiapan program: persen board tidak tersedia (${g5}${cap}). Jangan menafsirkan sebagai selesai.`,
    }
  }

  return {
    rail: 'program',
    code: input.g5Pass === true ? 'G5_PASS' : 'G5_OPEN',
    sentence: `Kesiapan program: tampilan board ${pct}% (${g5}${cap}). Portofolio 100% tidak berarti program global 100%.`,
  }
}

export function buildAllReadinessRails(input: {
  mapping?: MappingReadinessInput
  product?: ProductReadinessInput
  program?: ProgramReadinessInput
}): {
  mapping: ReadinessRailSentence
  product: ReadinessRailSentence
  program: ReadinessRailSentence
} {
  return {
    mapping: buildMappingReadinessSentence(input.mapping ?? {}),
    product: buildProductReadinessSentence(input.product ?? {}),
    program: buildProgramReadinessSentence(input.program ?? {}),
  }
}

// ---------------------------------------------------------------------------
// Human taxonomy labels (ART L139–150) — stable map, no PRODUCT guess
// ---------------------------------------------------------------------------

export const HUMAN_TAXONOMY_DOMAIN_LABELS: Readonly<Record<string, string>> = {
  SALES_WEB_RELATED_BACKEND:
    'Prioritas Utama — Panel Sales, Website, dan Backend Terkait',
  AFFILIATE: 'Domain Affiliate (lintas portal, Sales, backend, web, pembayaran)',
}

export const HUMAN_TAXONOMY_PROJECT_LABELS: Readonly<Record<string, string>> = {
  'sales-rebuild': 'Panel Sales',
  'mfs-web-original-upgrade': 'Website Publik dan Area Member',
  'rebuild-backend': 'Backend dan Layanan Inti',
  'affiliate-rebuild': 'Portal Affiliate',
}

/**
 * Resolve a human taxonomy label. Unknown ids stay unknown — never invent PRODUCT
 * portfolio membership or a marketing name.
 */
export function resolveTaxonomyLabel(
  kind: 'domain' | 'project' | 'feature',
  id: string | null | undefined,
  opts: { featureTitle?: string | null } = {},
): { label: string | null; known: boolean } {
  if (!id || !String(id).trim()) {
    return { label: null, known: false }
  }
  const key = String(id).trim()
  if (kind === 'domain') {
    const label = HUMAN_TAXONOMY_DOMAIN_LABELS[key] ?? null
    return { label, known: label != null }
  }
  if (kind === 'project') {
    const label = HUMAN_TAXONOMY_PROJECT_LABELS[key] ?? null
    return { label, known: label != null }
  }
  // feature: only accept explicit human title; never invent from id alone
  if (opts.featureTitle && String(opts.featureTitle).trim()) {
    return { label: String(opts.featureTitle).trim(), known: true }
  }
  return { label: null, known: false }
}

// ---------------------------------------------------------------------------
// Title quality lint (support evidence for content gate; not UI wiring)
// ---------------------------------------------------------------------------

export type HumanTitleLintCode =
  | 'STARTS_WITH_ID'
  | 'STARTS_WITH_FC'
  | 'STARTS_WITH_PARITY'
  | 'STARTS_WITH_INTEGRATION_CLOSURE'
  | 'STARTS_WITH_MAP'
  | 'STARTS_WITH_REPOISH'
  | 'EMPTY'

export function lintHumanTitle(title: string | null | undefined): {
  ok: boolean
  codes: Array<HumanTitleLintCode>
} {
  if (title == null || String(title).trim() === '') {
    return { ok: false, codes: ['EMPTY'] }
  }
  const t = String(title).trim()
  const codes: Array<HumanTitleLintCode> = []
  if (/^T-[A-Z0-9-]+/i.test(t) || /^[A-Z]+-\d+/.test(t)) codes.push('STARTS_WITH_ID')
  if (/^\[?FC-/i.test(t) || /^FC\b/i.test(t)) codes.push('STARTS_WITH_FC')
  if (/^parity\b/i.test(t)) codes.push('STARTS_WITH_PARITY')
  if (/^integration(\/|\s+)?closure\b/i.test(t)) codes.push('STARTS_WITH_INTEGRATION_CLOSURE')
  if (/^map\b/i.test(t)) codes.push('STARTS_WITH_MAP')
  if (/^(sales-rebuild|rebuild-backend|affiliate-rebuild|mfs-web)\b/i.test(t)) {
    codes.push('STARTS_WITH_REPOISH')
  }
  return { ok: codes.length === 0, codes }
}

// ---------------------------------------------------------------------------
// Build helpers + fixtures (for tests / future backfill — no persistence here)
// ---------------------------------------------------------------------------

export interface BuildHumanDisplayInput {
  entityKind: HumanDisplayEntityKind
  entityId: string
  title: string
  outcome: string
  why: string
  current: string
  remaining: string
  next: string
  doneWhen: string
  blocker: string
  ownerAction: string
  sourceFacts: HumanDisplaySourceFacts
  reviewStatus?: HumanDisplayReviewStatus
  reviewedAt?: string | null
  contentVersion?: number
  locale?: string
  parentFeatureTitle?: string
  businessArea?: string
  actor?: string
  citations?: ReadonlyArray<HumanDisplayCitation>
  acceptanceLinks?: ReadonlyArray<HumanDisplayAcceptanceLink>
  missionQuestionLinks?: ReadonlyArray<HumanDisplayMissionQuestionLink>
  canonicalHash?: string | null
}

/**
 * Construct a HumanDisplayV1 bound to computed sourceHash.
 * Does NOT set REVIEWED unless caller supplies reviewedAt + reviewStatus=REVIEWED.
 * Never invents PRODUCT in source facts.
 * Missing ART bindings stay empty strings so evaluate fails closed (no invent).
 */
export function buildHumanDisplay(input: BuildHumanDisplayInput): HumanDisplayV1 {
  const sourceHash = computeHumanDisplaySourceHash({
    ...input.sourceFacts,
    entityKind: input.entityKind,
    entityId: input.entityId,
    taskClass: normalizeTaskClass(input.sourceFacts.taskClass),
  })

  const reviewStatus = input.reviewStatus ?? 'GENERATED_NEEDS_REVIEW'
  const reviewedAt =
    reviewStatus === 'REVIEWED' ? (input.reviewedAt ?? null) : (input.reviewedAt ?? null)

  const defaultCitations: HumanDisplayCitation[] = [
    {
      field: 'title',
      path: `${input.entityKind}/${input.entityId}`,
      note: 'entity identity',
    },
  ]
  const defaultAcceptance: HumanDisplayAcceptanceLink[] = input.sourceFacts.acceptance
    ? [{ path: 'sourceFacts.acceptance', summary: String(input.sourceFacts.acceptance) }]
    : [{ path: 'sourceFacts.acceptance', summary: 'acceptance not yet cited' }]
  const defaultMission: HumanDisplayMissionQuestionLink[] = [
    { questionId: 'Q1', field: 'outcome', note: 'what outcome' },
  ]

  return {
    schemaVersion: HUMAN_DISPLAY_SCHEMA_VERSION,
    locale: input.locale ?? DEFAULT_HUMAN_LOCALE,
    title: input.title,
    outcome: input.outcome,
    why: input.why,
    current: input.current,
    remaining: input.remaining,
    next: input.next,
    doneWhen: input.doneWhen,
    blocker: input.blocker,
    ownerAction: input.ownerAction,
    reviewStatus,
    sourceHash,
    reviewedAt,
    contentVersion: input.contentVersion ?? 1,
    entityKind: input.entityKind,
    entityId: input.entityId,
    parentFeatureTitle: input.parentFeatureTitle ?? '',
    businessArea: input.businessArea ?? '',
    actor: input.actor ?? '',
    snapshotId: input.sourceFacts.canonicalSnapshotId ?? null,
    boardRev: input.sourceFacts.boardRev ?? null,
    lifecycleRev: input.sourceFacts.lifecycleRev ?? null,
    canonicalHash:
      input.canonicalHash !== undefined
        ? input.canonicalHash
        : (input.sourceFacts.canonicalHash ?? null),
    citations: input.citations ? [...input.citations] : defaultCitations,
    acceptanceLinks: input.acceptanceLinks
      ? [...input.acceptanceLinks]
      : defaultAcceptance,
    missionQuestionLinks: input.missionQuestionLinks
      ? [...input.missionQuestionLinks]
      : defaultMission,
  }
}

/** Quality-floor fixtures from ART L155–186 (id-ID). Not runtime seed data. */
export const HUMAN_DISPLAY_TITLE_FIXTURES = [
  {
    id: 'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
    technicalTitle: '[FC-WEB-PREMIUM-E2E] Checkout quote / create pending invoice',
    title: 'Menampilkan harga checkout dan membuat tagihan yang menunggu pembayaran',
    outcome:
      'Pelanggan melihat rincian harga yang benar. Saat melanjutkan, sistem membuat satu tagihan menunggu pembayaran tanpa duplikasi.',
  },
  {
    id: 'T-PANEL-SALES-LAND-99-INTEGRATION',
    technicalTitle: 'Integration/closure: landing price variants',
    title: 'Memastikan semua harga promo diteruskan dengan benar hingga checkout',
    outcome:
      'Harga promo harus sama pada kartu paket, checkout, tagihan, dan transaksi Sales.',
  },
  {
    id: 'T-BE-ID-REFRESH-REVOKE',
    technicalTitle: 'Parity refresh_token + revoke',
    title: 'Memperbarui sesi login dan mencabut akses secara aman',
    outcome:
      'Sesi sah dapat diperbarui, sedangkan token yang dicabut tidak dapat dipakai lagi.',
  },
  {
    id: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
    technicalTitle: 'Money tail expired/unpaid',
    title: 'Mencegah komisi dicairkan dari pembayaran kedaluwarsa atau belum dibayar',
    outcome:
      'Tagihan belum lunas atau kedaluwarsa tidak masuk ke komisi yang dapat ditarik.',
  },
] as const

export function fixtureHumanDisplayForTask(
  fixtureId: (typeof HUMAN_DISPLAY_TITLE_FIXTURES)[number]['id'],
  overrides: Partial<BuildHumanDisplayInput> = {},
): HumanDisplayV1 {
  const fx = HUMAN_DISPLAY_TITLE_FIXTURES.find((f) => f.id === fixtureId)
  if (!fx) {
    throw new Error(`Unknown human display fixture: ${fixtureId}`)
  }
  const { sourceFacts: sourceOver, ...restOver } = overrides
  const sourceFacts: HumanDisplaySourceFacts = {
    technicalTitle: fx.technicalTitle,
    objective: fx.outcome,
    lifecycleStage: 'MAPPED',
    disposition: 'ACTIVE',
    canonicalSnapshotId: 'snap-fixture-1',
    canonicalHash: 'canon-fixture-aaa',
    boardRev: 1,
    lifecycleRev: 1,
    ...(sourceOver ?? {}),
    entityKind: 'task',
    entityId: fx.id,
  }

  return buildHumanDisplay({
    entityKind: 'task',
    entityId: fx.id,
    title: fx.title,
    outcome: fx.outcome,
    why: 'Dampak langsung ke pelanggan, pendapatan, atau keamanan akses.',
    current: 'Fakta sumber tersedia; salinan manusia terikat sourceHash.',
    remaining: 'Menyelesaikan sisa pekerjaan sesuai doneWhen.',
    next: 'Lanjutkan langkah berikutnya yang tercatat di rencana kerja.',
    doneWhen: 'Bukti independen mengonfirmasi outcome terpenuhi.',
    blocker: 'Tidak ada',
    ownerAction: 'Tidak ada tindakan yang diperlukan',
    reviewStatus: 'GENERATED_NEEDS_REVIEW',
    parentFeatureTitle: 'Fitur terkait (fixture)',
    businessArea: 'Portofolio prioritas',
    actor: 'Implementer',
    citations: [
      {
        field: 'title',
        path: `task/${fx.id}`,
        note: 'ART title fixture',
      },
      {
        field: 'outcome',
        path: `task/${fx.id}.objective`,
        note: 'source objective projection',
      },
    ],
    acceptanceLinks: [
      {
        id: 'doneWhen',
        path: `task/${fx.id}.acceptance`,
        summary: 'Bukti independen mengonfirmasi outcome terpenuhi.',
      },
    ],
    missionQuestionLinks: [
      { questionId: 'Q1', field: 'outcome', note: 'what outcome' },
      { questionId: 'Q2', field: 'why', note: 'why it matters' },
      { questionId: 'Q3', field: 'current', note: 'status now' },
    ],
    ...restOver,
    sourceFacts,
  })
}
