/**
 * Pure public snapshot mapper (foundation).
 *
 * Maps one already-computed ControlCenterAggregation into PublicAggregationInput
 * for the existing public snapshot DTO / ETag path — no rollup/G5/bucket recomputation,
 * no storage, no routes, no board-MCP wiring.
 *
 * Fail-closed on missing/mismatched pin and forbidden private fields.
 */

import type { ControlCenterAggregation, ControlCenterPin } from '#/server/control-center-ui'
import { assertPinComplete, pinToTuple } from '#/server/control-center-ui'
import type { PinnedRevisionTuple } from '#/lib/control-plane-types'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import {
  PUBLIC_SERIALIZER_VERSION,
  ensureMaskedAccountId,
  isPublicAccountStatusUnusable,
  isPublicDomainBlockerCode,
  maskAccountRef,
  materializePublicSnapshot,
  normalizeDomainBlockers,
  sanitizePublicValue,
  type MaterializedPublicSnapshot,
  type PublicAccountSummary,
  type PublicAggregationInput,
  type PublicBucketCounts,
  type PublicDomainBlocker,
  type PublicFeatureSummary,
  type PublicG5Summary,
  type PublicPriorityRollup,
  type PublicProjectSummary,
  type PublicRunSummary,
  type PublicSnapshotPin,
  type PublicStaleOverlayCounts,
  type PublicTaskSummary,
} from '#/server/public-snapshot'

export type ControlCenterPublicSnapshotErrorCode =
  | 'INVALID_PIN'
  | 'PIN_MISMATCH'
  | 'MISSING_AGGREGATION'
  | 'FORBIDDEN_FIELD'
  | 'MAP_FAILED'
  | 'STALE_OR_PARTIAL'

export class ControlCenterPublicSnapshotError extends Error {
  readonly code: ControlCenterPublicSnapshotErrorCode
  readonly details: Readonly<Record<string, unknown>>

  constructor(
    code: ControlCenterPublicSnapshotErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ControlCenterPublicSnapshotError'
    this.code = code
    this.details = details
  }
}

export interface MapControlCenterPublicSnapshotOptions {
  /**
   * Optional external pin binding. When provided, aggregation pin must match
   * every supplied field (fail-closed PIN_MISMATCH).
   */
  expectedPin?: Partial<
    Pick<
      ControlCenterPin,
      | 'boardId'
      | 'canonicalSnapshotId'
      | 'canonicalHash'
      | 'taskHash'
      | 'boardRev'
      | 'lifecycleRev'
    >
  >
  publishedAt?: string
  publicationIntervalMs?: number
  nowMs?: number
  /** When false, omit task summaries (default true — workRows → public tasks). */
  includeTasks?: boolean
}

function tupleFromPin(pin: ControlCenterPin): PinnedRevisionTuple {
  return pinToTuple(pin)
}

function tuplesEqual(a: PinnedRevisionTuple, b: PinnedRevisionTuple): boolean {
  return (
    a.canonicalSnapshotId === b.canonicalSnapshotId &&
    a.canonicalHash === b.canonicalHash &&
    a.taskHash === b.taskHash &&
    a.boardRev === b.boardRev &&
    a.lifecycleRev === b.lifecycleRev
  )
}

function assertAggregationPinConsistent(agg: ControlCenterAggregation): void {
  try {
    assertPinComplete(agg.pin)
  } catch (err) {
    throw new ControlCenterPublicSnapshotError(
      'INVALID_PIN',
      err instanceof Error ? err.message : 'control-center pin incomplete',
      { pin: agg.pin },
    )
  }

  const fromPin = tupleFromPin(agg.pin)
  if (!tuplesEqual(fromPin, agg.tuple)) {
    throw new ControlCenterPublicSnapshotError(
      'PIN_MISMATCH',
      'aggregation pin fields do not match aggregation.tuple',
      { pin: fromPin, tuple: agg.tuple },
    )
  }

  if (!agg.rollup?.pin || !tuplesEqual(fromPin, agg.rollup.pin)) {
    throw new ControlCenterPublicSnapshotError(
      'PIN_MISMATCH',
      'aggregation pin does not match rollup.pin (fail closed)',
      { pin: fromPin, rollupPin: agg.rollup?.pin ?? null },
    )
  }
}

function assertExpectedPin(
  pin: ControlCenterPin,
  expected: MapControlCenterPublicSnapshotOptions['expectedPin'],
): void {
  if (!expected) return
  const checks: Array<[keyof typeof expected, unknown, unknown]> = [
    ['boardId', expected.boardId, pin.boardId],
    ['canonicalSnapshotId', expected.canonicalSnapshotId, pin.canonicalSnapshotId],
    ['canonicalHash', expected.canonicalHash, pin.canonicalHash],
    ['taskHash', expected.taskHash, pin.taskHash],
    ['boardRev', expected.boardRev, pin.boardRev],
    ['lifecycleRev', expected.lifecycleRev, pin.lifecycleRev],
  ]
  for (const [field, want, got] of checks) {
    if (want === undefined) continue
    if (want !== got) {
      throw new ControlCenterPublicSnapshotError(
        'PIN_MISMATCH',
        `expectedPin.${String(field)} mismatch`,
        { field, expected: want, actual: got },
      )
    }
  }
}

function toPublicPin(pin: ControlCenterPin): PublicSnapshotPin {
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    serializerVersion: PUBLIC_SERIALIZER_VERSION,
  }
}

function mapBuckets(agg: ControlCenterAggregation): PublicBucketCounts {
  const b = agg.rollup.buckets
  return {
    DONE: b.DONE,
    RECONCILIATION_PENDING: b.RECONCILIATION_PENDING,
    ONGOING: b.ONGOING,
    NEXT: b.NEXT,
    QUEUED: b.QUEUED,
    BLOCKED: b.BLOCKED,
  }
}

function mapStaleOverlays(agg: ControlCenterAggregation): PublicStaleOverlayCounts {
  // Copy DISTINCT overlay counts from rollup — no recompute.
  const out: PublicStaleOverlayCounts = {}
  for (const [k, v] of Object.entries(agg.rollup.overlays ?? {})) {
    if (typeof v === 'number' && Number.isFinite(v)) {
      out[k] = v
    }
  }
  return out
}

function mapPriority(agg: ControlCenterAggregation): PublicPriorityRollup {
  const p = agg.priority
  return {
    portfolioId: p.portfolioId,
    membershipDenominator: p.membershipDenominator,
    priorityClosureCapacity: p.priorityClosureCapacity,
    allClosureCapacity: p.allClosureCapacity,
    priorityCapacityShare: p.priorityCapacityShare,
    majorityAllocationPass: p.majorityAllocationPass,
    frontierState: p.frontierState,
    reason: p.reason,
  }
}

function mapG5(agg: ControlCenterAggregation): PublicG5Summary {
  // Derived G5 only — never invent domain rows; count from evaluation result.
  const domainPassCount = agg.g5.domainResults.filter((r) => r.pass).length
  return {
    g5Pass: agg.g5.g5Pass,
    domainPassCount,
    domainRequiredCount: G5_REQUIRED_DOMAINS.length,
  }
}

function mapProjects(agg: ControlCenterAggregation): Array<PublicProjectSummary> {
  return agg.projects.map((p) => ({
    id: p.id,
    name: p.name ?? null,
    status: p.status ?? null,
  }))
}

/**
 * Public feature rows with real progress nodes when the aggregation carries them
 * (featureContractId join on FeatureUiSummary) or when workRows link by featureId.
 * Never invents task ids/titles/stages — empty progressNodes when join has none.
 */
function mapFeatures(agg: ControlCenterAggregation): Array<PublicFeatureSummary> {
  return agg.features.map((f) => {
    const fromFeature = Array.isArray(f.progressNodes)
      ? f.progressNodes.map((n) => ({
          taskId: n.taskId,
          title:
            typeof n.title === 'string' && n.title.trim().length > 0 ? n.title : n.taskId,
          lifecycleStage:
            typeof n.lifecycleStage === 'string' && n.lifecycleStage.length > 0
              ? n.lifecycleStage
              : null,
          status: typeof n.status === 'string' && n.status.length > 0 ? n.status : null,
        }))
      : null

    const linkedRows = agg.workRows.filter((r) => r.featureId === f.id)
    const progressNodes =
      fromFeature ??
      linkedRows.map((r) => ({
        taskId: r.taskId,
        title:
          typeof r.title === 'string' && r.title.trim().length > 0 ? r.title : r.taskId,
        lifecycleStage:
          typeof r.lifecycleStage === 'string' && r.lifecycleStage.length > 0
            ? r.lifecycleStage
            : null,
        status: null as string | null,
      }))

    const stageCounts: Record<string, number> = {}
    if (f.stageCounts && typeof f.stageCounts === 'object') {
      for (const [k, v] of Object.entries(f.stageCounts)) {
        if (typeof v === 'number' && Number.isFinite(v) && v > 0) {
          stageCounts[k] = Math.floor(v)
        }
      }
    } else {
      for (const n of progressNodes) {
        const stage = n.lifecycleStage ?? 'UNKNOWN'
        stageCounts[stage] = (stageCounts[stage] ?? 0) + 1
      }
    }

    const taskCount =
      typeof f.taskCount === 'number' && Number.isFinite(f.taskCount)
        ? Math.max(0, Math.floor(f.taskCount))
        : progressNodes.length

    return {
      id: f.id,
      projectId: f.projectId ?? null,
      name: f.name ?? null,
      phase: f.phase ?? null,
      taskCount,
      stageCounts: Object.keys(stageCounts).length > 0 ? stageCounts : null,
      progressNodes,
    }
  })
}

function mapTasks(agg: ControlCenterAggregation): Array<PublicTaskSummary> {
  // workRows are already DISTINCT tracked task IDs from rollup — map only public fields.
  // Include lifecycleStage so public consumers can see MAP_VERIFIED progress (not PRODUCT-only %).
  return agg.workRows.map((t) => ({
    id: t.taskId,
    projectId: t.projectId ?? null,
    title: t.title ?? null,
    bucket: t.bucket ?? null,
    readinessPercent: null,
    lifecycleStage:
      typeof t.lifecycleStage === 'string' && t.lifecycleStage.length > 0
        ? t.lifecycleStage
        : null,
  }))
}

/** Distinct work-row stage histogram for boardRollup (owner progress). */
export function mapLifecycleStageCounts(
  agg: ControlCenterAggregation,
): Record<string, number> {
  const counts: Record<string, number> = {}
  for (const t of agg.workRows) {
    const stage =
      typeof t.lifecycleStage === 'string' && t.lifecycleStage.length > 0
        ? t.lifecycleStage
        : null
    if (!stage) continue
    counts[stage] = (counts[stage] ?? 0) + 1
  }
  return counts
}

function mapRuns(agg: ControlCenterAggregation): Array<PublicRunSummary> {
  return agg.runs.map((r) => {
    // Always remask — `acc_` prefix alone is not canonical masking.
    const accountRefMasked =
      r.maskedAccount == null || r.maskedAccount === ''
        ? null
        : maskAccountRef(r.maskedAccount)
    return {
      runId: r.runId,
      status: r.status ?? 'UNKNOWN',
      taskId: r.taskId ?? null,
      agentRole: r.role ?? null,
      accountRefMasked,
      lastHeartbeatAt: r.heartbeatAt ?? null,
    }
  })
}

/**
 * Account usable for public surface.
 * usable=false when BAN/403/AUTH_EXPIRED/quarantine/tombstone/LIMIT,
 * or account-sync authority missing/stale/parity-invalid.
 */
function mapAccounts(agg: ControlCenterAggregation): Array<PublicAccountSummary> {
  const meta = agg.accountSyncMeta
  const syncBlocksUsable =
    meta == null ||
    !meta.authoritative ||
    Boolean(meta.stale) ||
    meta.readbackParityOk === false

  return agg.accounts.map((a) => {
    const accountIdMasked = ensureMaskedAccountId(a.maskedAccountId || 'unknown')
    const status = a.status ?? 'UNKNOWN'
    let usable = true
    if (syncBlocksUsable) usable = false
    else if (a.quarantine) usable = false
    else if (isPublicAccountStatusUnusable(status)) usable = false
    else if ((a.effectiveCap ?? 0) <= 0) usable = false
    return {
      accountIdMasked,
      status,
      provider: a.providerKind ?? null,
      usable,
    }
  })
}

/**
 * Structural section error codes — pin/schema/hash/load/authority incompleteness.
 * These remain hard fail-closed (mapper throws → HTTP/MCP 503 STALE_OR_MISSING).
 * Domain codes (DATA_INTEGRITY / UNCLASSIFIED / ACCOUNT_SYNC_*) are NOT structural.
 *
 * PARTIAL_SOURCE is section-scoped (see STRUCTURAL_PARTIAL_SOURCE_SECTIONS):
 * overlay partials (human_display, audit, dispatch, …) must NOT 503 a pin-complete
 * public materialization — they soft-force stale via collectPublicDomainBlockers /
 * forceStale when needed, or are ignored when they do not affect public fields.
 */
export const PUBLIC_STRUCTURAL_SECTION_CODES: ReadonlySet<string> = new Set([
  'PIN_AUTHORITY_FALLBACK',
  'PIN_AUTHORITY_INCOMPLETE',
  'PIN_AUTHORITY_MISSING',
  'REVISION_AUTHORITY_MISSING',
  // Note: bare PARTIAL_SOURCE is NOT globally structural — see section gate below.
  'SCHEMA_INVALID',
  'SCHEMA_MISMATCH',
  'HASH_MISMATCH',
  'SNAPSHOT_ID_MISMATCH',
  'BOARD_MISMATCH',
  'LOAD_FAILED',
  'SOURCE_UNAVAILABLE',
  'RUNTIME_UNAVAILABLE',
  'DEFINITION_MISMATCH',
  'DEFINITION_AUTHORITY_STALE',
  'CANONICAL_LOAD_FAILED',
])

/**
 * Sections where PARTIAL_SOURCE means authority/runtime incompleteness → hard 503.
 * Overlay/non-authority sections are excluded so public pin-complete boards still
 * materialize (AC-PUBLIC-01) instead of false STALE_OR_MISSING.
 */
export const STRUCTURAL_PARTIAL_SOURCE_SECTIONS: ReadonlySet<string> = new Set([
  'runtime_context',
  'definition',
  'revisions',
  'pin',
  'canonical',
  'board_revisions',
  'authority',
  'load',
  'source',
])

export function isPublicStructuralSectionCode(
  code: string | null | undefined,
  section?: string | null,
): boolean {
  if (code == null || code === '') return false
  const c = String(code).trim()
  if (c === 'PARTIAL_SOURCE') {
    // Fail-closed when section is missing (unknown authority surface).
    if (section == null || section === '') return true
    const s = String(section).trim().toLowerCase()
    return STRUCTURAL_PARTIAL_SOURCE_SECTIONS.has(s)
  }
  if (PUBLIC_STRUCTURAL_SECTION_CODES.has(c)) return true
  // Prefix traps for load/schema/hash families
  if (/^(PIN_|SCHEMA_|HASH_|LOAD_|REVISION_|DEFINITION_)/i.test(c) && !isPublicDomainBlockerCode(c)) {
    return true
  }
  return false
}

/**
 * Collect allowlisted domain blockers from sectionErrors + rollup/account-sync signals.
 * Never includes private task titles, comments, evidence, or account identity.
 */
export function collectPublicDomainBlockers(
  agg: ControlCenterAggregation,
): Array<PublicDomainBlocker> {
  const raw: Array<PublicDomainBlocker> = []

  for (const e of agg.sectionErrors ?? []) {
    const code = String(e.code ?? '').trim()
    if (!isPublicDomainBlockerCode(code)) continue
    // Public reason = section + code only (drop free-form private messages).
    raw.push({
      code,
      count: 1,
      reason: e.section ? `section:${e.section}` : null,
    })
  }

  const unclassified = Math.max(0, Math.floor(agg.rollup?.unclassifiedCount ?? 0))
  if (unclassified > 0) {
    raw.push({
      code: 'UNCLASSIFIED',
      count: unclassified,
      reason: 'rollup.unclassifiedCount',
    })
  }

  const meta = agg.accountSyncMeta
  if (meta == null || !meta.authoritative) {
    raw.push({
      code: 'ACCOUNT_SYNC_MISSING',
      count: 1,
      reason: 'accountSyncMeta.missing',
    })
  } else if (meta.stale) {
    raw.push({
      code: 'ACCOUNT_SYNC_STALE',
      count: 1,
      reason: meta.staleReason
        ? `accountSyncMeta.stale:${String(meta.staleReason).slice(0, 80)}`
        : 'accountSyncMeta.stale',
    })
  } else if (meta.readbackParityOk === false) {
    raw.push({
      code: 'ACCOUNT_SYNC_PARITY_INVALID',
      count: 1,
      reason: 'accountSyncMeta.readbackParityOk=false',
    })
  }

  return normalizeDomainBlockers(raw)
}

/**
 * Fail-closed gate for STRUCTURAL readiness only.
 *
 * Business domain blockers (DATA_INTEGRITY / UNCLASSIFIED / ACCOUNT_SYNC_*) do NOT
 * throw — caller materializes a sanitized public snapshot with forceStale + usableCapacity=0.
 *
 * Still throws STALE_OR_PARTIAL for:
 * - pin.stale (authority/source pin integrity)
 * - structural sectionErrors (pin/schema/hash/load/revision authority)
 */
export function assertAggregationPublicReady(agg: ControlCenterAggregation): void {
  if (agg.pin.stale) {
    throw new ControlCenterPublicSnapshotError(
      'STALE_OR_PARTIAL',
      'aggregation pin is stale — public snapshot fail-closed',
      { stale: true, staleReason: agg.pin.staleReason },
    )
  }
  const structural = (agg.sectionErrors ?? []).filter((e) =>
    isPublicStructuralSectionCode(e.code, e.section),
  )
  if (structural.length > 0) {
    throw new ControlCenterPublicSnapshotError(
      'STALE_OR_PARTIAL',
      'aggregation has structural sectionErrors — public snapshot fail-closed',
      {
        sectionErrorCount: structural.length,
        sectionCodes: structural.map((e) => e.code),
        sectionNames: structural.map((e) => e.section),
      },
    )
  }
}

/**
 * Resolve public usableCapacity from account-sync meta, forced to 0 when domain
 * blockers are present (fail-closed dispatch capacity on public surface).
 */
export function resolvePublicUsableCapacity(
  agg: ControlCenterAggregation,
  domainBlockers: ReadonlyArray<PublicDomainBlocker>,
): number {
  if (domainBlockers.length > 0) return 0
  const meta = agg.accountSyncMeta
  if (meta == null || !meta.authoritative || meta.stale || meta.readbackParityOk === false) {
    return 0
  }
  const cap = meta.usableCapacity
  if (typeof cap !== 'number' || !Number.isFinite(cap) || cap < 0) return 0
  return Math.floor(cap)
}

/**
 * Map one pinned ControlCenterAggregation → PublicAggregationInput.
 * Preserves pin identity, DISTINCT rollup numbers, six bucket counts + STALE overlays,
 * sanitized run/account summaries, decision COUNT only, derived G5.
 * Does NOT recompute rollup/priority/G5.
 */
export function mapControlCenterAggregationToPublicInput(
  agg: ControlCenterAggregation | null | undefined,
  opts: MapControlCenterPublicSnapshotOptions = {},
): PublicAggregationInput {
  if (agg == null) {
    throw new ControlCenterPublicSnapshotError(
      'MISSING_AGGREGATION',
      'ControlCenterAggregation is required',
    )
  }

  try {
    assertAggregationPinConsistent(agg)
    assertExpectedPin(agg.pin, opts.expectedPin)
    // Structural pin/schema/hash only — domain blockers soft-path below.
    assertAggregationPublicReady(agg)

    if (!agg.pin.boardId) {
      throw new ControlCenterPublicSnapshotError('INVALID_PIN', 'boardId required on pin')
    }

    const publicPin = toPublicPin(agg.pin)
    const includeTasks = opts.includeTasks !== false
    // Business blockers → sanitized public truth (stale=true, usableCapacity=0), never 503.
    const domainBlockers = collectPublicDomainBlockers(agg)
    const usableCapacity = resolvePublicUsableCapacity(agg, domainBlockers)
    const forceStale = domainBlockers.length > 0

    const input: PublicAggregationInput = {
      boardId: agg.pin.boardId,
      pin: publicPin,
      generatedAt: agg.pin.generatedAt,
      publishedAt: opts.publishedAt ?? agg.pin.generatedAt,
      publicationIntervalMs: opts.publicationIntervalMs ?? 60_000,
      nowMs: opts.nowMs ?? agg.nowMs,
      boardRollup: {
        trackedWorkDenominator: agg.rollup.trackedWorkDenominator,
        productDenominator: agg.rollup.productDenominator,
        stageProdReady: agg.rollup.stageProdReady,
        prodReadyWithEvidence: agg.rollup.prodReadyWithEvidence,
        unclassifiedCount: agg.rollup.unclassifiedCount,
        rawTaskReadinessPercent: agg.rollup.rawTaskReadinessPercent,
        boardReadinessPercent: agg.rollup.boardReadinessPercent,
        cappedBy: agg.rollup.cappedBy,
        lifecycleStageCounts: mapLifecycleStageCounts(agg),
      },
      completion: {
        complete: agg.rollup.complete,
        // Prefer already-derived aggregation G5 (same pin); rollup.g5Pass is also derived.
        g5Pass: agg.g5.g5Pass,
      },
      buckets: mapBuckets(agg),
      staleOverlays: mapStaleOverlays(agg),
      priorityRollup: mapPriority(agg),
      projects: mapProjects(agg),
      features: mapFeatures(agg),
      tasks: includeTasks ? mapTasks(agg) : [],
      runs: mapRuns(agg),
      accounts: mapAccounts(agg),
      // Public decision COUNT only — never titles, questions, comments, evidence bodies.
      decisionCount: agg.decisions.length,
      g5: mapG5(agg),
      usableCapacity,
      domainBlockers,
      forceStale,
    }

    // Fail-closed: reject if any forbidden/private key slipped into the public DTO.
    try {
      sanitizePublicValue(input, { mode: 'strict' })
    } catch (err) {
      const msg = err instanceof Error ? err.message : 'forbidden field in public map'
      throw new ControlCenterPublicSnapshotError('FORBIDDEN_FIELD', msg, {
        cause: err instanceof Error ? err.name : 'unknown',
      })
    }

    return input
  } catch (err) {
    if (err instanceof ControlCenterPublicSnapshotError) throw err
    throw new ControlCenterPublicSnapshotError(
      'MAP_FAILED',
      err instanceof Error ? err.message : 'public snapshot map failed',
      { failClosed: true },
    )
  }
}

/**
 * Deterministic PublicAggregationInput for ETag materialization.
 * Same aggregation + opts → identical input shape for computePublicEtag /
 * materializePublicSnapshot (no storage side effects).
 */
export function buildPublicSnapshotEtagPayloadInput(
  agg: ControlCenterAggregation,
  opts: MapControlCenterPublicSnapshotOptions = {},
): PublicAggregationInput {
  return mapControlCenterAggregationToPublicInput(agg, opts)
}

/**
 * Convenience: map then materialize once via existing public serializer.
 * Still pure w.r.t. board stores (no I/O); does not write snapshot storage.
 */
export function materializePublicSnapshotFromControlCenter(
  agg: ControlCenterAggregation,
  opts: MapControlCenterPublicSnapshotOptions = {},
): MaterializedPublicSnapshot {
  const input = mapControlCenterAggregationToPublicInput(agg, opts)
  return materializePublicSnapshot(input)
}
