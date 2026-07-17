/**
 * Snapshot-pinned humanDisplay mass backfill (TM_HUMAN_DISPLAY_BACKFILL_V1).
 *
 * Pure plan/apply helpers — no DB apply wiring, no UI. Source-grounded and
 * fail-closed per ART §SOURCE-GROUNDED COMPLETE BACKFILL:
 *   - insufficient source → BLOCKED_MISSING_SOURCE + specific gap
 *   - conflicting sources → CONFLICT with citations (never silent choose)
 *   - never invent PRODUCT classification
 *   - never auto-promote to REVIEWED (independent review required)
 *   - every entity yields a plan row (no silent omission)
 *
 * Emits coverage via human-display-coverage.ts (byReviewStatus + contentDebt).
 */
import {
  DEFAULT_HUMAN_LOCALE,
  HUMAN_DISPLAY_SCHEMA_VERSION,
  HUMAN_TAXONOMY_PROJECT_LABELS,
  buildHumanDisplay,
  computeHumanDisplaySourceHash,
  evaluateHumanDisplay,
  lintHumanTitle,
  normalizeTaskClass,
  resolveTaxonomyLabel
  
  
  
  
  
} from '#/server/human-display'
import type {HumanDisplayEntityKind, HumanDisplayLivePin, HumanDisplayReviewStatus, HumanDisplaySourceFacts, HumanDisplayV1} from '#/server/human-display';
import {
  HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION,
  HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION,
  coverageRowFromDisplay,
  emitHumanDisplayCoverage
  
  
  
} from '#/server/human-display-coverage'
import type {HumanDisplayCoverageEntityRow, HumanDisplayCoveragePin, HumanDisplayCoverageReport} from '#/server/human-display-coverage';

// ---------------------------------------------------------------------------
// Schema / constants
// ---------------------------------------------------------------------------

export const HUMAN_DISPLAY_BACKFILL_SCHEMA_VERSION =
  'TM_HUMAN_DISPLAY_BACKFILL_V1' as const

export type BackfillAction =
  | 'WOULD_WRITE'
  | 'WOULD_SKIP_FRESH_REVIEWED'
  | 'WOULD_DEMOTE_STALE'
  | 'WOULD_BLOCK_MISSING_SOURCE'
  | 'WOULD_CONFLICT'
  | 'WOULD_CONTENT_REVIEW'

export type BackfillOmissionReason =
  | 'MISSING_OBJECTIVE'
  | 'MISSING_ENTITY_ID'
  | 'CONFLICTING_SOURCES'
  | 'INSUFFICIENT_SOURCE_FACTS'
  | 'TITLE_LINT_FAILED_TECHNICAL_FALLBACK_FORBIDDEN'
  | 'STALE_REVIEWED'
  | 'PRODUCT_WITHOUT_PROOF'
  | 'NONE'

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface HumanDisplayBackfillPin {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string | null
  boardRev: number
  lifecycleRev: number
}

/**
 * Source facts for one entity. Backfill never invents missing objective/title
 * into owner-primary prose; it binds only declared fields.
 */
export interface HumanDisplayBackfillEntity {
  entityKind: HumanDisplayEntityKind
  entityId: string
  technicalTitle?: string | null
  objective?: string | null
  userStory?: string | null
  projectId?: string | null
  featureId?: string | null
  featureContractId?: string | null
  lifecycleStage?: string | null
  disposition?: string | null
  /**
   * Explicit classification only. When PRODUCT without classificationProofValid,
   * stored taskClass is forced to UNCLASSIFIED (never invent PRODUCT).
   */
  taskClass?: 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED' | string | null
  classificationProofValid?: boolean
  priority?: string | null
  /** Explicit P0 portfolio membership (preferred over free-text priority). */
  isP0ActiveProduct?: boolean
  dependencies?: ReadonlyArray<string> | null
  acceptance?: string | null
  evidenceRefs?: ReadonlyArray<string> | null
  decisionIds?: ReadonlyArray<string> | null
  parentFeatureTitle?: string | null
  businessArea?: string | null
  actor?: string | null
  /**
   * Optional pre-authored human copy. When present and lint-clean, used for
   * GENERATED_NEEDS_REVIEW write. When absent, grounded provisional copy is
   * derived only from objective/userStory (never from raw technical title).
   */
  humanCopy?: {
    title?: string | null
    outcome?: string | null
    why?: string | null
    current?: string | null
    remaining?: string | null
    next?: string | null
    doneWhen?: string | null
    blocker?: string | null
    ownerAction?: string | null
  } | null
  /**
   * Conflicting source citations. When length >= 2 with disagreeing values,
   * plan yields CONFLICT (never silent choose).
   */
  conflictingSources?: ReadonlyArray<{
    path: string
    value: string
    note?: string
  }> | null
}

export interface HumanDisplayBackfillExisting {
  display: HumanDisplayV1
}

// ---------------------------------------------------------------------------
// Results
// ---------------------------------------------------------------------------

export interface HumanDisplayBackfillItemResult {
  entityKind: HumanDisplayEntityKind
  entityId: string
  action: BackfillAction
  reviewStatus: HumanDisplayReviewStatus
  omissionReason: BackfillOmissionReason
  sourceHash: string
  reasons: Array<string>
  display: HumanDisplayV1 | null
  isP0ActiveProduct: boolean
  taskClass: 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED'
  disposition: string | null
  priority: string | null
  technicalTitle: string | null
  locale: string
}

export interface HumanDisplayBackfillPlan {
  schemaVersion: typeof HUMAN_DISPLAY_BACKFILL_SCHEMA_VERSION
  dryRun: boolean
  pin: HumanDisplayBackfillPin
  totals: {
    entities: number
    wouldWrite: number
    wouldSkip: number
    wouldBlock: number
    wouldConflict: number
    wouldDemote: number
    wouldContentReview: number
  }
  items: Array<HumanDisplayBackfillItemResult>
  coverage: HumanDisplayCoverageReport
}

// ---------------------------------------------------------------------------
// Source sufficiency
// ---------------------------------------------------------------------------

function nonEmpty(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function resolveTaskClass(
  entity: HumanDisplayBackfillEntity,
): 'PRODUCT' | 'CONTROL_PLANE' | 'UNCLASSIFIED' {
  const raw = normalizeTaskClass(entity.taskClass)
  if (raw === 'PRODUCT' && entity.classificationProofValid !== true) {
    // Fail closed: never invent / retain PRODUCT without proof.
    return 'UNCLASSIFIED'
  }
  return raw
}

function hasConflictingSources(entity: HumanDisplayBackfillEntity): boolean {
  const list = entity.conflictingSources
  if (!list || list.length < 2) return false
  const values = new Set(list.map((c) => String(c.value).trim()))
  return values.size >= 2
}

function hasSufficientSource(entity: HumanDisplayBackfillEntity): {
  ok: boolean
  gap: BackfillOmissionReason
  detail: string
} {
  if (!nonEmpty(entity.entityId)) {
    return { ok: false, gap: 'MISSING_ENTITY_ID', detail: 'entityId required' }
  }
  // Objective or user story is the minimum for honest human outcome copy.
  if (!nonEmpty(entity.objective) && !nonEmpty(entity.userStory)) {
    return {
      ok: false,
      gap: 'MISSING_OBJECTIVE',
      detail: 'objective and userStory both missing — cannot ground human copy',
    }
  }
  return { ok: true, gap: 'NONE', detail: '' }
}

function isP0ActiveProduct(entity: HumanDisplayBackfillEntity): boolean {
  if (entity.isP0ActiveProduct === true) return true
  const taskClass = resolveTaskClass(entity)
  const disposition = String(entity.disposition ?? 'ACTIVE').toUpperCase()
  const priority = String(entity.priority ?? '').toUpperCase()
  return taskClass === 'PRODUCT' && disposition === 'ACTIVE' && priority === 'P0'
}

// ---------------------------------------------------------------------------
// Source facts + grounded provisional copy
// ---------------------------------------------------------------------------

export function buildSourceFactsForBackfill(
  entity: HumanDisplayBackfillEntity,
  pin: HumanDisplayBackfillPin,
): HumanDisplaySourceFacts {
  return {
    entityKind: entity.entityKind,
    entityId: entity.entityId,
    technicalTitle: entity.technicalTitle ?? null,
    objective: entity.objective ?? entity.userStory ?? null,
    projectId: entity.projectId ?? null,
    featureId: entity.featureId ?? null,
    featureContractId: entity.featureContractId ?? null,
    lifecycleStage: entity.lifecycleStage ?? null,
    disposition: entity.disposition ?? null,
    taskClass: resolveTaskClass(entity),
    dependencies: entity.dependencies ?? null,
    acceptance: entity.acceptance ?? null,
    evidenceRefs: entity.evidenceRefs ?? null,
    decisionIds: entity.decisionIds ?? null,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
  }
}

function resolveBusinessArea(entity: HumanDisplayBackfillEntity): string {
  if (nonEmpty(entity.businessArea)) return entity.businessArea.trim()
  if (nonEmpty(entity.projectId)) {
    const proj = resolveTaxonomyLabel('project', entity.projectId)
    if (proj.known && proj.label) return proj.label
  }
  return ''
}

function resolveParentFeatureTitle(entity: HumanDisplayBackfillEntity): string {
  if (nonEmpty(entity.parentFeatureTitle)) return entity.parentFeatureTitle.trim()
  if (nonEmpty(entity.featureId)) {
    const f = resolveTaxonomyLabel('feature', entity.featureId, {
      featureTitle: entity.parentFeatureTitle,
    })
    if (f.known && f.label) return f.label
  }
  return ''
}

/**
 * Build grounded provisional human copy. Never uses technical title as primary
 * when lint fails (ART: no raw primary fallback).
 */
function buildGroundedCopy(entity: HumanDisplayBackfillEntity): {
  title: string
  outcome: string
  why: string
  current: string
  remaining: string
  next: string
  doneWhen: string
  blocker: string
  ownerAction: string
  titleOk: boolean
} {
  const hc = entity.humanCopy ?? {}
  const objective = nonEmpty(entity.objective)
    ? entity.objective.trim()
    : nonEmpty(entity.userStory)
      ? entity.userStory.trim()
      : ''

  let title = nonEmpty(hc.title) ? hc.title.trim() : ''
  let titleOk = false
  if (title) {
    titleOk = lintHumanTitle(title).ok
  }
  if (!title || !titleOk) {
    // Derive a provisional title from objective only if it passes lint.
    if (objective) {
      const candidate =
        objective.length > 120 ? `${objective.slice(0, 117).trim()}…` : objective
      if (lintHumanTitle(candidate).ok) {
        title = candidate
        titleOk = true
      }
    }
  }
  if (!title || !titleOk) {
    // Fail-closed provisional: never expose FC/Parity technical title as primary.
    title = 'Salinan pemilik memerlukan penulisan ulang dari fakta sumber'
    titleOk = lintHumanTitle(title).ok
  }

  const outcome =
    nonEmpty(hc.outcome)
      ? hc.outcome.trim()
      : objective ||
        'Hasil pemilik belum dapat dinyatakan — fakta sumber objektif kurang.'

  return {
    title,
    outcome,
    why:
      nonEmpty(hc.why)
        ? hc.why.trim()
        : 'Dampak dan alasan bisnis harus terikat ke fakta sumber, bukan tebakan.',
    current:
      nonEmpty(hc.current)
        ? hc.current.trim()
        : `Fakta sumber tersedia untuk ${entity.entityKind}/${entity.entityId}; salinan manusia menunggu peninjauan.`,
    remaining:
      nonEmpty(hc.remaining)
        ? hc.remaining.trim()
        : 'Lengkapi salinan manusia spesifik tugas dan minta peninjauan independen.',
    next:
      nonEmpty(hc.next)
        ? hc.next.trim()
        : 'Tulis ulang judul/outcome spesifik dan ajukan peninjauan independen.',
    doneWhen:
      nonEmpty(hc.doneWhen)
        ? hc.doneWhen.trim()
        : nonEmpty(entity.acceptance)
          ? entity.acceptance.trim()
          : 'reviewStatus=REVIEWED dengan sourceHash cocok dan bukti independen.',
    blocker: nonEmpty(hc.blocker) ? hc.blocker.trim() : 'Tidak ada',
    ownerAction: nonEmpty(hc.ownerAction)
      ? hc.ownerAction.trim()
      : 'Tidak ada tindakan yang diperlukan',
    titleOk,
  }
}

function buildBlockedDisplay(
  entity: HumanDisplayBackfillEntity,
  pin: HumanDisplayBackfillPin,
  reviewStatus: 'BLOCKED_MISSING_SOURCE' | 'CONFLICT' | 'CONTENT_REVIEW_REQUIRED',
  gapDetail: string,
): HumanDisplayV1 {
  const title =
    reviewStatus === 'CONFLICT'
      ? 'Konflik sumber — salinan pemilik ditahan'
      : reviewStatus === 'BLOCKED_MISSING_SOURCE'
        ? 'Sumber tidak cukup — salinan pemilik diblokir'
        : 'Konten pemilik memerlukan peninjauan'
  const outcome =
    reviewStatus === 'CONFLICT'
      ? 'Beberapa sumber bertentangan; sistem tidak memilih diam-diam.'
      : reviewStatus === 'BLOCKED_MISSING_SOURCE'
        ? `Fakta sumber tidak cukup untuk salinan manusia yang jujur. Celah: ${gapDetail}`
        : 'Salinan manusia belum siap sebagai kebenaran utama pemilik.'

  return buildHumanDisplay({
    entityKind: entity.entityKind,
    entityId: entity.entityId,
    title,
    outcome,
    why: 'Salinan teknis mentah atau tebakan tidak boleh menjadi teks utama.',
    current: `Status: ${reviewStatus}. ${gapDetail}`,
    remaining: 'Lengkapi fakta sumber atau selesaikan konflik, lalu regenerasi.',
    next: 'Perbaiki sumber kanonik lalu jalankan ulang backfill terikat pin.',
    doneWhen: 'reviewStatus=REVIEWED dengan sourceHash cocok ke pin saat ini.',
    blocker: `${reviewStatus}: ${gapDetail}`,
    ownerAction: 'Tugaskan perbaikan sumber atau peninjauan salinan manusia.',
    sourceFacts: buildSourceFactsForBackfill(entity, pin),
    reviewStatus,
    reviewedAt: null,
    contentVersion: 1,
    parentFeatureTitle: resolveParentFeatureTitle(entity) || 'Tidak diketahui',
    businessArea: resolveBusinessArea(entity) || 'Tidak diketahui',
    actor: nonEmpty(entity.actor) ? entity.actor.trim() : 'Tidak diketahui',
    citations: [
      {
        field: 'reviewStatus',
        path: `${entity.entityKind}/${entity.entityId}`,
        note: gapDetail,
      },
      ...(entity.conflictingSources ?? []).map((c) => ({
        field: 'conflict',
        path: c.path,
        note: c.note ?? c.value,
      })),
    ],
    acceptanceLinks: [
      {
        path: `${entity.entityKind}/${entity.entityId}.acceptance`,
        summary: 'blocked — acceptance belum terikat penuh',
      },
    ],
    missionQuestionLinks: [
      {
        questionId: 'Q-CONTENT-REVIEW',
        field: 'reviewStatus',
        note: 'fail-closed backfill',
      },
    ],
  })
  // buildHumanDisplay already binds pin via sourceFacts; force sourceHash if needed
  // (compute is deterministic from sourceFacts). Override only review semantics above.
}

// ---------------------------------------------------------------------------
// Plan one entity
// ---------------------------------------------------------------------------

export function planHumanDisplayBackfillItem(
  entity: HumanDisplayBackfillEntity,
  pin: HumanDisplayBackfillPin,
  existing: HumanDisplayBackfillExisting | null = null,
): HumanDisplayBackfillItemResult {
  const taskClass = resolveTaskClass(entity)
  const p0 = isP0ActiveProduct({ ...entity, taskClass })
  const sourceFacts = buildSourceFactsForBackfill(
    { ...entity, taskClass },
    pin,
  )
  const sourceHash = computeHumanDisplaySourceHash(sourceFacts)
  const live: HumanDisplayLivePin = {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    liveSourceHash: sourceHash,
  }

  const baseMeta = {
    entityKind: entity.entityKind,
    entityId: entity.entityId,
    isP0ActiveProduct: p0,
    taskClass,
    disposition: entity.disposition ?? null,
    priority: entity.priority ?? null,
    technicalTitle: entity.technicalTitle ?? null,
    locale: DEFAULT_HUMAN_LOCALE,
    sourceHash,
  }

  // PRODUCT without proof is recorded as UNCLASSIFIED (already in taskClass) + reason.
  const productWithoutProof =
    normalizeTaskClass(entity.taskClass) === 'PRODUCT' &&
    entity.classificationProofValid !== true

  if (hasConflictingSources(entity)) {
    const display = buildBlockedDisplay(
      entity,
      pin,
      'CONFLICT',
      'conflictingSources disagree — never silent choose',
    )
    return {
      ...baseMeta,
      action: 'WOULD_CONFLICT',
      reviewStatus: 'CONFLICT',
      omissionReason: 'CONFLICTING_SOURCES',
      reasons: [
        'CONFLICTING_SOURCES',
        ...(productWithoutProof ? (['PRODUCT_WITHOUT_PROOF'] as const) : []),
      ],
      display: { ...display, sourceHash },
    }
  }

  const sufficiency = hasSufficientSource(entity)
  if (!sufficiency.ok) {
    const display = buildBlockedDisplay(
      entity,
      pin,
      'BLOCKED_MISSING_SOURCE',
      sufficiency.detail,
    )
    return {
      ...baseMeta,
      action: 'WOULD_BLOCK_MISSING_SOURCE',
      reviewStatus: 'BLOCKED_MISSING_SOURCE',
      omissionReason: sufficiency.gap,
      reasons: [
        sufficiency.gap,
        ...(productWithoutProof ? (['PRODUCT_WITHOUT_PROOF'] as const) : []),
      ],
      display: { ...display, sourceHash },
    }
  }

  // Existing REVIEWED + fresh against live pin → skip (preserve independent review).
  if (existing?.display) {
    const evaluation = evaluateHumanDisplay(existing.display, live, {
      entityKind: entity.entityKind,
      entityId: entity.entityId,
    })
    if (
      existing.display.reviewStatus === 'REVIEWED' &&
      evaluation.ownerPrimaryReady
    ) {
      return {
        ...baseMeta,
        action: 'WOULD_SKIP_FRESH_REVIEWED',
        reviewStatus: 'REVIEWED',
        omissionReason: 'NONE',
        reasons: ['FRESH_REVIEWED'],
        display: existing.display,
        locale: existing.display.locale || DEFAULT_HUMAN_LOCALE,
      }
    }
    if (
      existing.display.reviewStatus === 'REVIEWED' &&
      !evaluation.ownerPrimaryReady
    ) {
      // Stale REVIEWED demotes — plan CONTENT_REVIEW_REQUIRED write.
      const demoted = buildBlockedDisplay(
        entity,
        pin,
        'CONTENT_REVIEW_REQUIRED',
        `stale REVIEWED demoted: ${evaluation.reasons.join(',')}`,
      )
      return {
        ...baseMeta,
        action: 'WOULD_DEMOTE_STALE',
        reviewStatus: 'CONTENT_REVIEW_REQUIRED',
        omissionReason: 'STALE_REVIEWED',
        reasons: ['STALE_REVIEWED', ...evaluation.reasons],
        display: { ...demoted, sourceHash },
      }
    }
  }

  const copy = buildGroundedCopy(entity)
  const display = buildHumanDisplay({
    entityKind: entity.entityKind,
    entityId: entity.entityId,
    title: copy.title,
    outcome: copy.outcome,
    why: copy.why,
    current: copy.current,
    remaining: copy.remaining,
    next: copy.next,
    doneWhen: copy.doneWhen,
    blocker: copy.blocker,
    ownerAction: copy.ownerAction,
    sourceFacts,
    reviewStatus: 'GENERATED_NEEDS_REVIEW',
    reviewedAt: null,
    contentVersion: existing?.display?.contentVersion
      ? existing.display.contentVersion + 1
      : 1,
    parentFeatureTitle: resolveParentFeatureTitle(entity),
    businessArea: resolveBusinessArea(entity),
    actor: nonEmpty(entity.actor) ? entity.actor.trim() : 'Implementer',
    citations: [
      {
        field: 'title',
        path: `${entity.entityKind}/${entity.entityId}`,
        note: 'entity identity',
      },
      {
        field: 'outcome',
        path: `${entity.entityKind}/${entity.entityId}.objective`,
        note: 'source objective / userStory projection',
      },
    ],
    acceptanceLinks: [
      {
        path: `${entity.entityKind}/${entity.entityId}.acceptance`,
        summary: nonEmpty(entity.acceptance)
          ? entity.acceptance.trim()
          : 'acceptance not yet cited',
      },
    ],
    missionQuestionLinks: [
      { questionId: 'Q1', field: 'outcome', note: 'what outcome' },
      { questionId: 'Q2', field: 'why', note: 'why it matters' },
      { questionId: 'Q3', field: 'current', note: 'status now' },
    ],
  })

  const reasons: Array<string> = ['SOURCE_GROUNDED_GENERATED']
  if (productWithoutProof) reasons.push('PRODUCT_WITHOUT_PROOF')
  if (!copy.titleOk) {
    reasons.push('TITLE_LINT_FAILED_TECHNICAL_FALLBACK_FORBIDDEN')
  }

  return {
    ...baseMeta,
    action: 'WOULD_WRITE',
    reviewStatus: 'GENERATED_NEEDS_REVIEW',
    omissionReason: productWithoutProof ? 'PRODUCT_WITHOUT_PROOF' : 'NONE',
    reasons,
    display,
  }
}

// ---------------------------------------------------------------------------
// Mass plan
// ---------------------------------------------------------------------------

export function planHumanDisplayBackfill(opts: {
  pin: HumanDisplayBackfillPin
  entities: ReadonlyArray<HumanDisplayBackfillEntity>
  existingByKey?: ReadonlyMap<string, HumanDisplayBackfillExisting>
  dryRun?: boolean
  now?: string
}): HumanDisplayBackfillPlan {
  const dryRun = opts.dryRun !== false
  const items: Array<HumanDisplayBackfillItemResult> = []

  for (const entity of opts.entities) {
    const key = `${entity.entityKind}::${entity.entityId}`
    const existing = opts.existingByKey?.get(key) ?? null
    items.push(planHumanDisplayBackfillItem(entity, opts.pin, existing))
  }

  // Stable order for deterministic receipts
  items.sort((a, b) => {
    const k = a.entityKind.localeCompare(b.entityKind)
    if (k !== 0) return k
    return a.entityId.localeCompare(b.entityId)
  })

  const totals = {
    entities: items.length,
    wouldWrite: 0,
    wouldSkip: 0,
    wouldBlock: 0,
    wouldConflict: 0,
    wouldDemote: 0,
    wouldContentReview: 0,
  }
  for (const it of items) {
    switch (it.action) {
      case 'WOULD_WRITE':
        totals.wouldWrite += 1
        break
      case 'WOULD_SKIP_FRESH_REVIEWED':
        totals.wouldSkip += 1
        break
      case 'WOULD_BLOCK_MISSING_SOURCE':
        totals.wouldBlock += 1
        break
      case 'WOULD_CONFLICT':
        totals.wouldConflict += 1
        break
      case 'WOULD_DEMOTE_STALE':
        totals.wouldDemote += 1
        break
      case 'WOULD_CONTENT_REVIEW':
        totals.wouldContentReview += 1
        break
    }
  }

  const coverage = buildCoverageFromBackfillItems(opts.pin, items, opts.now)

  return {
    schemaVersion: HUMAN_DISPLAY_BACKFILL_SCHEMA_VERSION,
    dryRun,
    pin: { ...opts.pin },
    totals,
    items,
    coverage,
  }
}

export function buildCoverageFromBackfillItems(
  pin: HumanDisplayBackfillPin,
  items: ReadonlyArray<HumanDisplayBackfillItemResult>,
  now?: string,
): HumanDisplayCoverageReport {
  const coveragePin: HumanDisplayCoveragePin = {
    boardId: pin.boardId,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
  }
  const rows: Array<HumanDisplayCoverageEntityRow> = items.map((it) =>
    coverageRowFromDisplay(it.display, {
      entityKind: it.entityKind,
      entityId: it.entityId,
      effectiveReviewStatus: it.reviewStatus,
      missingDisplay: it.display == null,
      priority: it.priority,
      taskClass: it.taskClass,
      disposition: it.disposition,
      technicalTitle: it.technicalTitle,
      isP0ActiveProduct: it.isP0ActiveProduct,
      omissionReason:
        it.omissionReason !== 'NONE' ? it.omissionReason : null,
    }),
  )
  return emitHumanDisplayCoverage({ pin: coveragePin, rows, now })
}

// ---------------------------------------------------------------------------
// Fixture loaders (staging pin + MANIFEST)
// ---------------------------------------------------------------------------

export interface StagingFixtureManifest {
  boardId?: string
  taskIds?: ReadonlyArray<string>
  pin?: {
    canonicalSnapshotId?: string
    canonicalHash?: string | null
    boardRev?: number
    lifecycleRev?: number
  }
  counts?: { tasks?: number }
}

export interface StagingFixturePinFile {
  canonicalSnapshotId?: string
  canonicalHash?: string | null
  boardRev?: number
  lifecycleRev?: number
}

/**
 * Build hierarchy entities for a staging fixture:
 * - every MANIFEST.taskId as a task (fail-closed if no objective — expected for
 *   smoke MANIFEST without copy seeds)
 * - every known taxonomy project as a project entity with grounded label
 *
 * Optional entity overrides (from human-display-entities.json etc.) merge by id.
 */
export function buildEntitiesFromStagingFixture(opts: {
  manifest: StagingFixtureManifest
  pinFile?: StagingFixturePinFile | null
  entityOverrides?: ReadonlyArray<HumanDisplayBackfillEntity>
  includeTaxonomyProjects?: boolean
}): {
  pin: HumanDisplayBackfillPin
  entities: Array<HumanDisplayBackfillEntity>
} {
  const pinSrc = opts.pinFile ?? opts.manifest.pin ?? {}
  const boardId = opts.manifest.boardId ?? 'mfs-rebuild'
  const pin: HumanDisplayBackfillPin = {
    boardId,
    canonicalSnapshotId: String(
      pinSrc.canonicalSnapshotId ??
        opts.manifest.pin?.canonicalSnapshotId ??
        'missing-snapshot',
    ),
    canonicalHash:
      pinSrc.canonicalHash !== undefined
        ? pinSrc.canonicalHash
        : (opts.manifest.pin?.canonicalHash ?? null),
    boardRev: Number(
      pinSrc.boardRev ?? opts.manifest.pin?.boardRev ?? 0,
    ),
    lifecycleRev: Number(
      pinSrc.lifecycleRev ?? opts.manifest.pin?.lifecycleRev ?? 0,
    ),
  }

  const overrideMap = new Map<string, HumanDisplayBackfillEntity>()
  for (const e of opts.entityOverrides ?? []) {
    overrideMap.set(`${e.entityKind}::${e.entityId}`, e)
  }

  const entities: Array<HumanDisplayBackfillEntity> = []
  const taskIds = opts.manifest.taskIds ?? []
  for (const id of taskIds) {
    const key = `task::${id}`
    const over = overrideMap.get(key)
    if (over) {
      entities.push(over)
      overrideMap.delete(key)
    } else {
      // Honest smoke entity: no objective → BLOCKED_MISSING_SOURCE in plan.
      entities.push({
        entityKind: 'task',
        entityId: String(id),
        technicalTitle: null,
        objective: null,
        disposition: 'ACTIVE',
        taskClass: 'UNCLASSIFIED',
        classificationProofValid: false,
      })
    }
  }

  if (opts.includeTaxonomyProjects !== false) {
    for (const [projectId, label] of Object.entries(HUMAN_TAXONOMY_PROJECT_LABELS)) {
      const key = `project::${projectId}`
      const over = overrideMap.get(key)
      if (over) {
        entities.push(over)
        overrideMap.delete(key)
      } else {
        entities.push({
          entityKind: 'project',
          entityId: projectId,
          technicalTitle: projectId,
          objective: `Proyek ${label} memiliki batasan, status, dan celah yang dapat dijelaskan pemilik.`,
          humanCopy: {
            title: label,
            outcome: `Pemilik memahami cakupan dan status proyek ${label}.`,
            why: 'Label repositori mentah tidak boleh menjadi teks domain utama.',
            current: 'Taksonomi sumber tersedia; salinan manusia terikat pin.',
            remaining: 'Jaga agar salinan tetap segar terhadap snapshot kanonik.',
            next: 'Tinjau salinan proyek setelah perubahan snapshot.',
            doneWhen: 'reviewStatus=REVIEWED dengan sourceHash cocok.',
            blocker: 'Tidak ada',
            ownerAction: 'Tidak ada tindakan yang diperlukan',
          },
          parentFeatureTitle: 'Taksonomi portofolio',
          businessArea: label,
          actor: 'Owner',
          disposition: 'ACTIVE',
          taskClass: 'CONTROL_PLANE',
          classificationProofValid: true,
        })
      }
    }
  }

  // Any remaining overrides (features / extra tasks)
  for (const e of overrideMap.values()) {
    entities.push(e)
  }

  return { pin, entities }
}

/**
 * CLI / script entry: plan backfill and return serializable result.
 */
export function runHumanDisplayBackfillDryRun(opts: {
  pin: HumanDisplayBackfillPin
  entities: ReadonlyArray<HumanDisplayBackfillEntity>
  existingByKey?: ReadonlyMap<string, HumanDisplayBackfillExisting>
  now?: string
}): HumanDisplayBackfillPlan {
  return planHumanDisplayBackfill({
    pin: opts.pin,
    entities: opts.entities,
    existingByKey: opts.existingByKey,
    dryRun: true,
    now: opts.now,
  })
}

/** Serialize plan for JSON fixtures (strips Map etc.). */
export function serializeBackfillPlan(
  plan: HumanDisplayBackfillPlan,
): Record<string, unknown> {
  return {
    schemaVersion: plan.schemaVersion,
    dryRun: plan.dryRun,
    pin: plan.pin,
    totals: plan.totals,
    itemCount: plan.items.length,
    items: plan.items.map((it) => ({
      entityKind: it.entityKind,
      entityId: it.entityId,
      action: it.action,
      reviewStatus: it.reviewStatus,
      omissionReason: it.omissionReason,
      sourceHash: it.sourceHash,
      reasons: it.reasons,
      isP0ActiveProduct: it.isP0ActiveProduct,
      taskClass: it.taskClass,
      disposition: it.disposition,
      priority: it.priority,
      technicalTitle: it.technicalTitle,
      locale: it.locale,
      hasDisplay: it.display != null,
      displayReviewStatus: it.display?.reviewStatus ?? null,
      displayTitle: it.display?.title ?? null,
    })),
    coverage: plan.coverage,
  }
}

// Re-export coverage schema constants for script consumers
export {
  HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION,
  HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION,
}

export { HUMAN_DISPLAY_SCHEMA_VERSION, DEFAULT_HUMAN_LOCALE }

// ---------------------------------------------------------------------------
// CLI (loaded via scripts/human-display-backfill.mjs + Vite SSR)
// ---------------------------------------------------------------------------

export interface HumanDisplayBackfillCliDeps {
  readFileSync: (path: string, encoding: 'utf8') => string
  writeFileSync: (path: string, data: string, encoding: 'utf8') => void
  existsSync: (path: string) => boolean
  cwd: () => string
  stdoutWrite: (s: string) => void
  stderrWrite: (s: string) => void
}

function parseArgs(argv: ReadonlyArray<string>): {
  dryRun: boolean
  fixtureDir: string | null
  writeCoverage: string | null
  json: boolean
  help: boolean
} {
  let dryRun = false
  let fixtureDir: string | null = null
  let writeCoverage: string | null = null
  let json = false
  let help = false
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--dry-run') dryRun = true
    else if (a === '--json') json = true
    else if (a === '--help' || a === '-h') help = true
    else if (a === '--fixture' || a === '--fixture-dir') {
      fixtureDir = argv[i + 1] ?? null
      i += 1
    } else if (a === '--write-coverage') {
      writeCoverage = argv[i + 1] ?? null
      i += 1
    } else if (a?.startsWith('--fixture=')) {
      fixtureDir = a.slice('--fixture='.length)
    } else if (a?.startsWith('--write-coverage=')) {
      writeCoverage = a.slice('--write-coverage='.length)
    }
  }
  return { dryRun, fixtureDir, writeCoverage, json, help }
}

/**
 * CLI entry. Exit codes: 0 ok, 1 usage/error, 2 fixture invalid.
 */
export async function main(
  argv: ReadonlyArray<string> = [],
  deps?: HumanDisplayBackfillCliDeps,
): Promise<number> {
  const fs = await import('node:fs')
  const path = await import('node:path')
  const d: HumanDisplayBackfillCliDeps = deps ?? {
    readFileSync: (p, enc) => fs.readFileSync(p, enc),
    writeFileSync: (p, data, enc) => fs.writeFileSync(p, data, enc),
    existsSync: (p) => fs.existsSync(p),
    cwd: () => process.cwd(),
    stdoutWrite: (s) => {
      process.stdout.write(s)
    },
    stderrWrite: (s) => {
      process.stderr.write(s)
    },
  }

  const args = parseArgs(argv)
  if (args.help || (!args.dryRun && !args.fixtureDir)) {
    d.stdoutWrite(
      [
        'Usage: node scripts/human-display-backfill.mjs --dry-run --fixture <dir> [--write-coverage <path>] [--json]',
        '',
        '  --dry-run              Plan only (required for acceptance; no DB writes)',
        '  --fixture <dir>        Staging fixture dir (MANIFEST.json + pin.json)',
        '  --write-coverage <p>   Write coverage JSON (default: <fixture>/human-display-coverage.example.json)',
        '  --json                 Print full plan JSON to stdout',
        '',
      ].join('\n'),
    )
    return args.help ? 0 : 1
  }

  if (!args.dryRun) {
    d.stderrWrite(
      'human-display-backfill: only --dry-run is supported in this package (no live DB apply)\n',
    )
    return 1
  }

  if (!args.fixtureDir) {
    d.stderrWrite('human-display-backfill: --fixture <dir> is required\n')
    return 1
  }

  const fixtureDir = path.isAbsolute(args.fixtureDir)
    ? args.fixtureDir
    : path.resolve(d.cwd(), args.fixtureDir)

  const manifestPath = path.join(fixtureDir, 'MANIFEST.json')
  const pinPath = path.join(fixtureDir, 'pin.json')
  const overridesPath = path.join(fixtureDir, 'human-display-entities.json')

  if (!d.existsSync(manifestPath)) {
    d.stderrWrite(
      `human-display-backfill: MANIFEST.json not found at ${manifestPath}\n`,
    )
    return 2
  }

  let manifest: StagingFixtureManifest
  let pinFile: StagingFixturePinFile | null = null
  let entityOverrides: Array<HumanDisplayBackfillEntity> = []

  try {
    manifest = JSON.parse(d.readFileSync(manifestPath, 'utf8')) as StagingFixtureManifest
  } catch (e) {
    d.stderrWrite(
      `human-display-backfill: failed to parse MANIFEST.json: ${e instanceof Error ? e.message : String(e)}\n`,
    )
    return 2
  }

  if (d.existsSync(pinPath)) {
    try {
      pinFile = JSON.parse(d.readFileSync(pinPath, 'utf8')) as StagingFixturePinFile
    } catch (e) {
      d.stderrWrite(
        `human-display-backfill: failed to parse pin.json: ${e instanceof Error ? e.message : String(e)}\n`,
      )
      return 2
    }
  }

  if (d.existsSync(overridesPath)) {
    try {
      const raw = JSON.parse(d.readFileSync(overridesPath, 'utf8')) as
        | { entities?: Array<HumanDisplayBackfillEntity> }
        | Array<HumanDisplayBackfillEntity>
      entityOverrides = Array.isArray(raw) ? raw : (raw.entities ?? [])
    } catch (e) {
      d.stderrWrite(
        `human-display-backfill: failed to parse human-display-entities.json: ${e instanceof Error ? e.message : String(e)}\n`,
      )
      return 2
    }
  }

  const { pin, entities } = buildEntitiesFromStagingFixture({
    manifest,
    pinFile,
    entityOverrides,
    includeTaxonomyProjects: true,
  })

  // Deterministic clock for fixture coverage example
  const now = '2026-07-14T00:00:00.000Z'
  const plan = runHumanDisplayBackfillDryRun({ pin, entities, now })
  const serialized = serializeBackfillPlan(plan)

  const coverageOut =
    args.writeCoverage != null
      ? path.isAbsolute(args.writeCoverage)
        ? args.writeCoverage
        : path.resolve(d.cwd(), args.writeCoverage)
      : path.join(fixtureDir, 'human-display-coverage.example.json')

  const coverageJson = `${JSON.stringify(plan.coverage, null, 2)}\n`
  d.writeFileSync(coverageOut, coverageJson, 'utf8')

  if (args.json) {
    d.stdoutWrite(`${JSON.stringify(serialized, null, 2)}\n`)
  } else {
    d.stdoutWrite(
      [
        `human-display-backfill dry-run ok`,
        `  schema: ${plan.schemaVersion}`,
        `  boardId: ${pin.boardId}`,
        `  pin: snapshot=${pin.canonicalSnapshotId} boardRev=${pin.boardRev} lifecycleRev=${pin.lifecycleRev}`,
        `  entities: ${plan.totals.entities}`,
        `  wouldWrite=${plan.totals.wouldWrite} wouldBlock=${plan.totals.wouldBlock} wouldConflict=${plan.totals.wouldConflict} wouldSkip=${plan.totals.wouldSkip} wouldDemote=${plan.totals.wouldDemote}`,
        `  byReviewStatus: ${JSON.stringify(plan.coverage.byReviewStatus)}`,
        `  contentDebt.tasks=${plan.coverage.contentDebt.totalTasks} p0=${plan.coverage.p0Coverage.ratio} releaseBlocked=${plan.coverage.p0Coverage.releaseBlocked}`,
        `  coverage written: ${coverageOut}`,
        '',
      ].join('\n'),
    )
  }

  // Fail closed if coverage lacks required keys (acceptance contract).
  if (
    !plan.coverage.byReviewStatus ||
    !plan.coverage.contentDebt ||
    plan.coverage.contentDebt.schemaVersion !==
      HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION
  ) {
    d.stderrWrite(
      'human-display-backfill: coverage missing byReviewStatus/contentDebt\n',
    )
    return 1
  }

  return 0
}
