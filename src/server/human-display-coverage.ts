/**
 * Human-display coverage + content-debt recount (TM_HUMAN_DISPLAY_COVERAGE_V1).
 *
 * Pure module: recompute denominators from a pinned entity set — never hard-code
 * 639 / 316 / historical audit counts as current truth (ART §KNOWN CONTENT DEBT).
 * Emits totals by entity, locale, review state, priority, and omission reason.
 */
import {
  HUMAN_DISPLAY_REVIEW_STATUSES,
  lintHumanTitle
  
  
  
} from '#/server/human-display'
import type {HumanDisplayEntityKind, HumanDisplayReviewStatus, HumanDisplayV1} from '#/server/human-display';

// ---------------------------------------------------------------------------
// Schema
// ---------------------------------------------------------------------------

export const HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION =
  'TM_HUMAN_DISPLAY_COVERAGE_V1' as const

export const HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION =
  'TM_HUMAN_DISPLAY_CONTENT_DEBT_V1' as const

/** Effective status buckets for coverage (includes missing display). */
export type CoverageReviewBucket =
  | HumanDisplayReviewStatus
  | 'MISSING_DISPLAY'

export const COVERAGE_REVIEW_BUCKETS: ReadonlyArray<CoverageReviewBucket> = [
  ...HUMAN_DISPLAY_REVIEW_STATUSES,
  'MISSING_DISPLAY',
] as const

// ---------------------------------------------------------------------------
// Input rows (post-evaluation / post-backfill plan)
// ---------------------------------------------------------------------------

export interface HumanDisplayCoverageEntityRow {
  entityKind: HumanDisplayEntityKind
  entityId: string
  /**
   * Effective review status after fail-closed evaluation.
   * null / undefined → MISSING_DISPLAY.
   */
  effectiveReviewStatus?: HumanDisplayReviewStatus | null
  /** True when no humanDisplay row exists. */
  missingDisplay?: boolean
  locale?: string | null
  /** Explicit priority label (e.g. P0); never inferred from free text alone. */
  priority?: string | null
  /**
   * Explicit classification only. Missing → not counted as PRODUCT (never invent).
   */
  taskClass?: 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED' | null
  disposition?: string | null
  /** Technical / SSOT title used only for content-debt title lint patterns. */
  technicalTitle?: string | null
  /** Human primary title when present (debt also counts lint failures). */
  humanTitle?: string | null
  /** Machine omission / gap reason (one primary). */
  omissionReason?: string | null
  /** When true, entity is in the P0 active PRODUCT portfolio scope. */
  isP0ActiveProduct?: boolean
}

export interface HumanDisplayCoveragePin {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string | null
  boardRev: number
  lifecycleRev: number
}

// ---------------------------------------------------------------------------
// Content debt
// ---------------------------------------------------------------------------

/**
 * Title-debt pattern categories from ART §KNOWN CONTENT DEBT.
 * Categories may overlap — each match increments its own counter.
 */
export type TitleDebtCategory =
  | 'fcNotation'
  | 'parityFramed'
  | 'integrationClosure'
  | 'apiPrimary'
  | 'e2ePrimary'

export interface TitleDebtCounts {
  fcNotation: number
  parityFramed: number
  integrationClosure: number
  apiPrimary: number
  e2ePrimary: number
  /** Rows that matched at least one category. */
  anyDebtTitle: number
  /** Total titles inspected. */
  inspected: number
}

export interface P0ProductCoverage {
  /** Recomputed denominator (never hard-coded 316). */
  total: number
  independentlyReviewed: number
  /** e.g. "12/40" */
  ratio: string
  /** True only when total > 0 and reviewed === total. */
  pass: boolean
  /** Release-blocking when any P0 PRODUCT active row is not independently reviewed. */
  releaseBlocked: boolean
}

export interface ContentDebtAudit {
  schemaVersion: typeof HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION
  totalEntities: number
  totalTasks: number
  titleDebt: TitleDebtCounts
  byEffectiveStatus: Record<CoverageReviewBucket, number>
  omissionReasons: Record<string, number>
  p0ActiveProduct: P0ProductCoverage
  /**
   * Historical baseline note only — never used as live truth.
   * Spec reference: P0 active PRODUCT was 316 at a prior pinned audit.
   */
  historicalBaselineNote: string
}

export interface HumanDisplayCoverageReport {
  schemaVersion: typeof HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION
  pin: HumanDisplayCoveragePin
  generatedAt: string
  totals: {
    entities: number
    byEntityKind: Record<HumanDisplayEntityKind, number>
    byLocale: Record<string, number>
  }
  /** Required acceptance key. */
  byReviewStatus: Record<CoverageReviewBucket, number>
  byPriority: Record<string, number>
  /** Required acceptance key. */
  contentDebt: ContentDebtAudit
  p0Coverage: P0ProductCoverage
  /** Entities that still block release (missing / not independently reviewed P0, etc.). */
  releaseBlockers: {
    count: number
    missingDisplay: number
    contentReviewRequired: number
    blockedMissingSource: number
    conflict: number
    generatedNeedsReview: number
    p0NotIndependentlyReviewed: number
  }
}

// ---------------------------------------------------------------------------
// Title debt patterns (recomputed programmatically)
// ---------------------------------------------------------------------------

export function classifyTitleDebt(
  title: string | null | undefined,
): Array<TitleDebtCategory> {
  if (title == null || !String(title).trim()) return []
  const t = String(title).trim()
  const cats: Array<TitleDebtCategory> = []
  // FC-oriented notation (code prefix or bracketed FC)
  if (/\[?\s*FC[-_]/i.test(t) || /\bFC-[A-Z0-9]/i.test(t) || /^FC\b/i.test(t)) {
    cats.push('fcNotation')
  }
  if (/\bparity\b/i.test(t)) {
    cats.push('parityFramed')
  }
  if (/integration(\/|\s+)?closure/i.test(t)) {
    cats.push('integrationClosure')
  }
  // Framed primarily as API work (leading or dominant)
  if (
    /^(api[\s:_-]|\[?api\]?[\s:_-])/i.test(t) ||
    /\bAPI\b/.test(t) && /^(implement|add|create|wire|build)?\s*api\b/i.test(t)
  ) {
    cats.push('apiPrimary')
  } else if (/^api\b/i.test(t) || /\bAPI\s+(endpoint|route|handler|check)\b/i.test(t)) {
    cats.push('apiPrimary')
  }
  if (
    /^(e2e[\s:_-]|\[?e2e\]?[\s:_-])/i.test(t) ||
    /\bE2E\b/.test(t) && /e2e/i.test(t.slice(0, 24))
  ) {
    cats.push('e2ePrimary')
  } else if (/^e2e\b/i.test(t) || /\bE2E\s+(test|flow|scenario|coverage)\b/i.test(t)) {
    cats.push('e2ePrimary')
  }
  return cats
}

export function emptyTitleDebtCounts(): TitleDebtCounts {
  return {
    fcNotation: 0,
    parityFramed: 0,
    integrationClosure: 0,
    apiPrimary: 0,
    e2ePrimary: 0,
    anyDebtTitle: 0,
    inspected: 0,
  }
}

export function emptyByReviewStatus(): Record<CoverageReviewBucket, number> {
  const out = {} as Record<CoverageReviewBucket, number>
  for (const b of COVERAGE_REVIEW_BUCKETS) out[b] = 0
  return out
}

function emptyByEntityKind(): Record<HumanDisplayEntityKind, number> {
  return { task: 0, project: 0, feature: 0 }
}

/**
 * Recount content debt from entity rows against the current pin set.
 * Never hard-codes historical 639/316 counts.
 */
export function recountContentDebt(
  rows: ReadonlyArray<HumanDisplayCoverageEntityRow>,
): ContentDebtAudit {
  const titleDebt = emptyTitleDebtCounts()
  const byEffectiveStatus = emptyByReviewStatus()
  const omissionReasons: Record<string, number> = {}
  let totalTasks = 0
  let p0Total = 0
  let p0Reviewed = 0

  for (const row of rows) {
    if (row.entityKind === 'task') totalTasks += 1

    const status = resolveCoverageBucket(row)
    byEffectiveStatus[status] = (byEffectiveStatus[status] ?? 0) + 1

    if (row.omissionReason && String(row.omissionReason).trim()) {
      const key = String(row.omissionReason).trim()
      omissionReasons[key] = (omissionReasons[key] ?? 0) + 1
    }

    // Prefer technical title for debt patterns (ART audit used technical titles);
    // also inspect human title when technical absent.
    const titleForDebt = row.technicalTitle ?? row.humanTitle ?? null
    if (titleForDebt != null && String(titleForDebt).trim()) {
      titleDebt.inspected += 1
      const cats = classifyTitleDebt(titleForDebt)
      if (cats.length > 0) titleDebt.anyDebtTitle += 1
      for (const c of cats) {
        titleDebt[c] += 1
      }
    }

    // Human title lint failures also contribute omission visibility
    if (row.humanTitle) {
      const lint = lintHumanTitle(row.humanTitle)
      if (!lint.ok && !row.omissionReason) {
        const key = `TITLE_LINT:${lint.codes.join(',')}`
        omissionReasons[key] = (omissionReasons[key] ?? 0) + 1
      }
    }

    const isP0 =
      row.isP0ActiveProduct === true ||
      (String(row.priority ?? '').toUpperCase() === 'P0' &&
        row.taskClass === 'PRODUCT' &&
        String(row.disposition ?? 'ACTIVE').toUpperCase() === 'ACTIVE')

    if (isP0) {
      p0Total += 1
      if (status === 'REVIEWED') p0Reviewed += 1
    }
  }

  const p0ActiveProduct = buildP0Coverage(p0Total, p0Reviewed)

  return {
    schemaVersion: HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION,
    totalEntities: rows.length,
    totalTasks,
    titleDebt,
    byEffectiveStatus,
    omissionReasons: sortRecord(omissionReasons),
    p0ActiveProduct,
    historicalBaselineNote:
      'Prior pinned audit cited ~639 tasks and 316 P0 active PRODUCT rows; live denominators are recomputed from the pin — never hard-coded.',
  }
}

export function buildP0Coverage(
  total: number,
  independentlyReviewed: number,
): P0ProductCoverage {
  const ratio = `${independentlyReviewed}/${total}`
  const pass = total > 0 && independentlyReviewed === total
  return {
    total,
    independentlyReviewed,
    ratio,
    pass,
    releaseBlocked: !pass,
  }
}

export function resolveCoverageBucket(
  row: HumanDisplayCoverageEntityRow,
): CoverageReviewBucket {
  if (row.missingDisplay === true || row.effectiveReviewStatus == null) {
    return 'MISSING_DISPLAY'
  }
  return row.effectiveReviewStatus
}

// ---------------------------------------------------------------------------
// Coverage emit
// ---------------------------------------------------------------------------

export function emitHumanDisplayCoverage(opts: {
  pin: HumanDisplayCoveragePin
  rows: ReadonlyArray<HumanDisplayCoverageEntityRow>
  /** Override clock for deterministic tests. */
  now?: string
}): HumanDisplayCoverageReport {
  const generatedAt = opts.now ?? new Date().toISOString()
  const contentDebt = recountContentDebt(opts.rows)
  const byReviewStatus = emptyByReviewStatus()
  const byEntityKind = emptyByEntityKind()
  const byLocale: Record<string, number> = {}
  const byPriority: Record<string, number> = {}

  let p0NotIndependentlyReviewed = 0

  for (const row of opts.rows) {
    const bucket = resolveCoverageBucket(row)
    byReviewStatus[bucket] = (byReviewStatus[bucket] ?? 0) + 1
    byEntityKind[row.entityKind] = (byEntityKind[row.entityKind] ?? 0) + 1

    const locale = (row.locale && String(row.locale).trim()) || 'unknown'
    byLocale[locale] = (byLocale[locale] ?? 0) + 1

    const pri =
      row.priority && String(row.priority).trim()
        ? String(row.priority).trim()
        : 'UNSET'
    byPriority[pri] = (byPriority[pri] ?? 0) + 1

    const isP0 =
      row.isP0ActiveProduct === true ||
      (String(row.priority ?? '').toUpperCase() === 'P0' &&
        row.taskClass === 'PRODUCT' &&
        String(row.disposition ?? 'ACTIVE').toUpperCase() === 'ACTIVE')
    if (isP0 && bucket !== 'REVIEWED') {
      p0NotIndependentlyReviewed += 1
    }
  }

  const releaseBlockers = {
    count: 0,
    missingDisplay: byReviewStatus.MISSING_DISPLAY,
    contentReviewRequired: byReviewStatus.CONTENT_REVIEW_REQUIRED,
    blockedMissingSource: byReviewStatus.BLOCKED_MISSING_SOURCE,
    conflict: byReviewStatus.CONFLICT,
    generatedNeedsReview: byReviewStatus.GENERATED_NEEDS_REVIEW,
    p0NotIndependentlyReviewed,
  }
  releaseBlockers.count =
    releaseBlockers.missingDisplay +
    releaseBlockers.contentReviewRequired +
    releaseBlockers.blockedMissingSource +
    releaseBlockers.conflict +
    releaseBlockers.generatedNeedsReview

  return {
    schemaVersion: HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION,
    pin: { ...opts.pin },
    generatedAt,
    totals: {
      entities: opts.rows.length,
      byEntityKind,
      byLocale: sortRecord(byLocale),
    },
    byReviewStatus,
    byPriority: sortRecord(byPriority),
    contentDebt,
    p0Coverage: contentDebt.p0ActiveProduct,
    releaseBlockers,
  }
}

/**
 * Map a stored/planned HumanDisplayV1 into a coverage row.
 */
export function coverageRowFromDisplay(
  display: HumanDisplayV1 | null | undefined,
  base: Omit<HumanDisplayCoverageEntityRow, 'effectiveReviewStatus' | 'missingDisplay' | 'humanTitle' | 'locale'> & {
    effectiveReviewStatus?: HumanDisplayReviewStatus | null
    missingDisplay?: boolean
  },
): HumanDisplayCoverageEntityRow {
  if (!display) {
    return {
      ...base,
      missingDisplay: true,
      effectiveReviewStatus: null,
      humanTitle: null,
      locale: null,
    }
  }
  return {
    ...base,
    missingDisplay: false,
    effectiveReviewStatus:
      base.effectiveReviewStatus ?? display.reviewStatus,
    humanTitle: display.title,
    locale: display.locale,
  }
}

function sortRecord(rec: Record<string, number>): Record<string, number> {
  const keys = Object.keys(rec).sort()
  const out: Record<string, number> = {}
  for (const k of keys) out[k] = rec[k]!
  return out
}
