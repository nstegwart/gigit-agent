/**
 * C3-W1: Presentation-only mapping from pinned envelopes → component props.
 * NEVER recomputes readiness, buckets, G5, NEXT, priority majority, or denominators.
 * Field renames + age formatting only.
 */

import {
  formatAgeSeconds,
  resolveClientSurfaceState,
  type PinnedEnvelope,
  type OverviewData,
  type WorkData,
  type PriorityData,
  type EvidenceData,
  type DecisionsData,
} from '#/lib/control-center-query'
import type {
  OverviewProps,
  OverviewSurfaceState,
  DecisionSeverity,
} from '#/components/control-center/overview'
import type {
  WorkScreenProps,
  WorkItemRow,
  WorkBucketCounts,
  PrimaryBucket,
  StaleOverlayKind,
} from '#/components/control-center/work'
import type { PriorityScreenProps } from '#/components/control-center/priority'
import { PRIORITY_PORTFOLIO_ID } from '#/components/control-center/priority'
import type {
  DecisionsScreenProps,
  DecisionItemView,
  DecisionSeverity as DecisionsSeverity,
} from '#/components/control-center/decisions'
import { G5_DOMAIN_LABELS, G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import type { G5DomainId } from '#/lib/control-plane-types'

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])

function asSeverity(v: string | null | undefined): DecisionSeverity {
  if (v && SEVERITIES.has(v)) return v as DecisionSeverity
  return 'MEDIUM'
}

/** Optional wire fields some projectors may attach; never invent when absent. */
type OverviewLowerWire = {
  lifecycle?: ReadonlyArray<{ stage?: string; count?: number }>
  lifecycleStages?: ReadonlyArray<{ stage?: string; count?: number }>
  materialEvents?: ReadonlyArray<Record<string, unknown>>
  auditEvents?: ReadonlyArray<Record<string, unknown>>
}

/**
 * Project lower-panel lifecycle stage counts from server fields only.
 * Prefer explicit lifecycle arrays; else projects[].readinessStage (+ taskCount weight).
 */
export function projectOverviewLifecycle(
  d: OverviewData,
): Array<{ stage: string; count: number }> {
  const wire = d as OverviewData & OverviewLowerWire
  const explicit = wire.lifecycle ?? wire.lifecycleStages
  if (Array.isArray(explicit) && explicit.length > 0) {
    const out: Array<{ stage: string; count: number }> = []
    for (const row of explicit) {
      const stage = typeof row?.stage === 'string' ? row.stage : ''
      const count = typeof row?.count === 'number' && Number.isFinite(row.count) ? row.count : 0
      if (stage) out.push({ stage, count })
    }
    return out
  }
  const counts = new Map<string, number>()
  for (const pr of d.projects ?? []) {
    const stage =
      typeof pr.readinessStage === 'string' && pr.readinessStage.length > 0
        ? pr.readinessStage
        : null
    if (!stage) continue
    const weight =
      typeof pr.taskCount === 'number' && Number.isFinite(pr.taskCount) ? pr.taskCount : 1
    counts.set(stage, (counts.get(stage) ?? 0) + weight)
  }
  return [...counts.entries()]
    .map(([stage, count]) => ({ stage, count }))
    .sort((a, b) => a.stage.localeCompare(b.stage))
}

/**
 * Project material events from optional server arrays on OverviewData.
 * Empty when projector has not attached materialEvents/auditEvents (no invention).
 */
export function projectOverviewMaterialEvents(
  d: OverviewData,
): Array<{
  eventId: string
  atLabel: string
  kind: string
  summary: string
  actor?: string
}> {
  const wire = d as OverviewData & OverviewLowerWire
  const source = wire.materialEvents ?? wire.auditEvents
  if (!Array.isArray(source) || source.length === 0) return []
  return source.map((raw, i) => {
    // AuditUiEvent and free-form wire rows both land here — normalize via unknown.
    const row = (raw ?? {}) as unknown as Record<string, unknown>
    const eventId = String(row.eventId ?? row.id ?? `ev-${i}`)
    const at =
      typeof row.atLabel === 'string'
        ? row.atLabel
        : typeof row.createdAt === 'string'
          ? row.createdAt
          : ''
    return {
      eventId,
      atLabel: at,
      kind: String(row.kind ?? 'event'),
      summary: String(row.summary ?? ''),
      actor:
        typeof row.actor === 'string'
          ? row.actor
          : typeof row.actorId === 'string'
            ? row.actorId
            : undefined,
    }
  })
}

/** OverviewData envelope → Overview presentational props. */
export function overviewEnvelopeToProps(
  envelope: PinnedEnvelope<OverviewData | null> | null | undefined,
  opts: {
    boardLabel?: string
    liveStage?: string
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onReconnect?: () => void
    onSelectBucket?: (bucket: PrimaryBucket) => void
    onToggleStale?: () => void
    pillCollapsed?: boolean
    onPillExpand?: () => void
    onPillCollapse?: () => void
  } = {},
): OverviewProps {
  const surfaceState = resolveClientSurfaceState(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  ) as OverviewSurfaceState

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      appSummary: null,
      pin: envelope
        ? {
            canonicalSnapshotId: envelope.canonicalSnapshotId || null,
            canonicalHash: envelope.canonicalHash || null,
            boardRev: typeof envelope.boardRev === 'number' ? envelope.boardRev : null,
            lifecycleRev:
              typeof envelope.lifecycleRev === 'number' ? envelope.lifecycleRev : null,
          }
        : null,
      decision: null,
      priority: null,
      global: null,
      buckets: null,
      ongoing: [],
      lower: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? undefined
          : { code: 'NO_DATA', message: 'Overview data unavailable' },
      onRetry: opts.onRetry,
      onReconnect: opts.onReconnect,
    }
  }

  const d = envelope.data
  const connection =
    envelope.stale
      ? ('stale' as const)
      : surfaceState === 'disconnected'
        ? ('disconnected' as const)
        : ('live' as const)

  const top = d.topDecision
  const topQuestion =
    top && 'question' in top && typeof (top as { question?: unknown }).question === 'string'
      ? ((top as { question: string }).question || null)
      : top && 'question' in top
        ? ((top as { question: string | null }).question ?? null)
        : null
  const decision =
    d.decisionCount > 0 || top
      ? {
          count: d.decisionCount,
          topSeverity: top ? asSeverity(top.severity) : null,
          topItem: top
            ? {
                decisionId: top.decisionId,
                title: top.title,
                // Real question only — never synthesize from title.
                question: topQuestion,
                severity: asSeverity(top.severity),
                blocking: top.blocking,
                ownerAction: top.blocking
                  ? 'Resolve blocking decision'
                  : 'Review decision',
                status: top.status,
              }
            : null,
        }
      : { count: 0, topSeverity: null, topItem: null }

  const p = d.priority
  const capacityShareDisplay =
    p.priorityCapacityShare === null ? 'N-A' : String(p.priorityCapacityShare)
  const majorityDisplay =
    p.majorityAllocationPass === null
      ? 'N-A'
      : p.majorityAllocationPass
        ? 'true'
        : 'false'

  const staleCount =
    (d.overlays.STALE_DATA_SOURCE ?? 0) +
    (d.overlays.EXPIRED_STALLED_RUN ?? 0) +
    (d.overlays.STALE_CLAIM ?? 0) +
    (d.overlays.STALE_DISPATCH_PLAN ?? 0) +
    (d.overlays.STALE_ACCOUNT_SYNC ?? 0)

  return {
    surfaceState,
    appSummary: {
      boardId: envelope.boardId,
      boardLabel: opts.boardLabel,
      liveStage: opts.liveStage ?? 'control-center',
      freshnessLabel: formatAgeSeconds(envelope.freshnessAgeSeconds),
      freshnessAgeSeconds: envelope.freshnessAgeSeconds,
      connection,
      stale: envelope.stale,
      staleReason: envelope.staleReason,
      schemaVersion: envelope.schemaVersion,
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
      canonicalSnapshotId: envelope.canonicalSnapshotId,
      canonicalHash: envelope.canonicalHash,
    },
    pin: {
      canonicalSnapshotId: envelope.canonicalSnapshotId || null,
      canonicalHash: envelope.canonicalHash || null,
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
    },
    decision,
    priority: {
      portfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipDenominator: p.membershipDenominator,
      productDenominator: d.productDenominator,
      stageProdReady: d.stageProdReady,
      prodReadyWithEvidence: d.prodReadyWithEvidence,
      g5Pass: d.g5Pass,
      complete: d.complete,
      priorityCapacityShare: p.priorityCapacityShare,
      majorityAllocationPass: p.majorityAllocationPass,
      frontierState: p.frontierState,
      capacityShareDisplay,
      majorityDisplay,
      dispatchReason: d.dispatchNext.blockedReason,
      blockers: d.sectionErrors.map((e) => `${e.code}: ${e.message}`),
    },
    global: {
      trackedWorkDenominator: d.trackedWorkDenominator,
      productDenominator: d.productDenominator,
      stageProdReady: d.stageProdReady,
      prodReadyWithEvidence: d.prodReadyWithEvidence,
      g5Pass: d.g5Pass,
      complete: d.complete,
      boardReadinessPercent: d.boardReadinessPercent,
      cappedBy: d.cappedBy ?? null,
    },
    buckets: {
      counts: d.buckets,
      staleCount,
      overlayBreakdown: d.overlays,
      onSelectBucket: opts.onSelectBucket,
      onToggleStale: opts.onToggleStale,
    },
    ongoing: d.ongoing.map((o) => ({
      taskId: o.taskId,
      title: o.title,
      targetGate: o.targetGate,
      agentId: o.agentId,
      role: o.role,
      model: o.model ?? '—',
      effort: o.effort ?? '—',
      maskedAccount: o.maskedAccount ?? '—',
      startedAge: formatAgeSeconds(o.startedAgeSeconds),
      heartbeatAge: formatAgeSeconds(o.heartbeatAgeSeconds),
      materialProgressAge: formatAgeSeconds(o.materialProgressAgeSeconds),
      productiveState: o.productiveSubstate,
      evidenceLabel: o.evidenceLink ? 'evidence' : 'no evidence',
      evidenceHref: o.evidenceLink,
    })),
    lower: {
      projects: d.projects.map((pr) => ({
        projectId: pr.id,
        name: pr.name ?? pr.id,
        statusLabel: pr.status ?? undefined,
        count: pr.taskCount,
      })),
      lifecycle: projectOverviewLifecycle(d),
      g5: {
        g5Pass: d.g5.g5Pass,
        domains: d.g5.domainResults.map((row) => ({
          domainId: row.domainId,
          label:
            G5_DOMAIN_LABELS[row.domainId as G5DomainId] ?? String(row.domainId),
          status: row.pass ? 'PASS' : 'FAIL',
          pass: row.pass,
        })),
      },
      decisionCount: d.decisionCount,
      materialEvents: projectOverviewMaterialEvents(d),
    },
    partialErrors: d.sectionErrors.map((e) => ({
      code: e.code,
      message: e.message,
    })),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : undefined,
    onRetry: opts.onRetry,
    onReconnect: opts.onReconnect,
    pillCollapsed: opts.pillCollapsed,
    onPillExpand: opts.onPillExpand,
    onPillCollapse: opts.onPillCollapse,
  }
}

/** Zero-click ONGOING row fields used for Work list join (presentation only). */
export type WorkOngoingJoinRow = {
  taskId: string
  targetGate?: string | null
  agentId?: string | null
  role?: string | null
  model?: string | null
  effort?: string | null
  maskedAccount?: string | null
  startedAgeSeconds?: number | null
  heartbeatAgeSeconds?: number | null
  materialProgressAgeSeconds?: number | null
  productiveSubstate?: string | null
  liveness?: string | null
  evidenceLink?: string | null
}

type WorkDataWire = WorkData & {
  ongoing?: ReadonlyArray<WorkOngoingJoinRow>
}

function buildOngoingJoinMap(
  d: WorkData,
  external?: ReadonlyArray<WorkOngoingJoinRow> | null,
): Map<string, WorkOngoingJoinRow> {
  const map = new Map<string, WorkOngoingJoinRow>()
  const wire = d as WorkDataWire
  for (const row of wire.ongoing ?? []) {
    if (row?.taskId) map.set(row.taskId, row)
  }
  for (const row of external ?? []) {
    if (row?.taskId) map.set(row.taskId, row)
  }
  return map
}

function mapWorkOngoingDisplay(
  join: WorkOngoingJoinRow | undefined,
  row: { bucket: PrimaryBucket | null; targetGate: string | null },
): WorkItemRow['ongoing'] {
  if (join) {
    return {
      targetGate: join.targetGate ?? row.targetGate,
      agentId: join.agentId ?? null,
      role: join.role ?? null,
      model: join.model ?? null,
      effort: join.effort ?? null,
      maskedAccount: join.maskedAccount ?? null,
      startedAgeSeconds: join.startedAgeSeconds ?? null,
      heartbeatAgeSeconds: join.heartbeatAgeSeconds ?? null,
      materialProgressAgeSeconds: join.materialProgressAgeSeconds ?? null,
      liveness: join.liveness ?? join.productiveSubstate ?? null,
      evidenceLink: join.evidenceLink ?? null,
    }
  }
  // Partial zero-click from WorkTaskUiRow only — never invent agent/model/account.
  if (row.bucket === 'ONGOING' && row.targetGate) {
    return { targetGate: row.targetGate }
  }
  return null
}

/** Resolve taskHash for pin badge: envelope wire (if present) → route pin → empty. */
function resolveWorkTaskHash(
  envelope: PinnedEnvelope<unknown>,
  routePinned?: { taskHash?: string | null } | null,
): string {
  const wire = envelope as PinnedEnvelope<unknown> & { taskHash?: unknown }
  if (typeof wire.taskHash === 'string' && wire.taskHash.length > 0) return wire.taskHash
  if (routePinned?.taskHash && routePinned.taskHash.length > 0) return routePinned.taskHash
  return ''
}

/** WorkData envelope → WorkScreen props (controlled filter from route). */
export function workEnvelopeToProps(
  envelope: PinnedEnvelope<WorkData | null> | null | undefined,
  opts: {
    boardId: string
    activeBucket: PrimaryBucket
    staleOverlayActive: boolean
    overlayKind?: StaleOverlayKind | null
    transport?: 'online' | 'offline' | 'unknown'
    /** Pin-matched ONGOING zero-click rows (e.g. Overview.ongoing). */
    ongoingJoin?: ReadonlyArray<WorkOngoingJoinRow> | null
    /** Route deep-link pin (preserves taskHash when envelope omits it). */
    routePinned?: {
      canonicalSnapshotId?: string | null
      canonicalHash?: string | null
      taskHash?: string | null
      boardRev?: number | null
      lifecycleRev?: number | null
    } | null
    onBucketChange?: (bucket: PrimaryBucket) => void
    onStaleOverlayChange?: (active: boolean) => void
    onNextPage?: () => void
    onPrevPage?: () => void
    onRetry?: () => void
    onRefresh?: () => void
    onReconnect?: () => void
    onRowActivate?: WorkScreenProps['onRowActivate']
  },
): WorkScreenProps {
  const state = resolveClientSurfaceState(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  ) as WorkScreenProps['state']

  if (!envelope || !envelope.data) {
    return {
      state,
      boardId: opts.boardId,
      activeBucket: opts.activeBucket,
      staleOverlayActive: opts.staleOverlayActive,
      items: [],
      page: {
        cursor: null,
        nextCursor: null,
        pageSize: 50,
        hasMore: false,
      },
      pinned: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : undefined,
      onBucketChange: opts.onBucketChange,
      onStaleOverlayChange: opts.onStaleOverlayChange,
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
      onReconnect: opts.onReconnect,
      onRowActivate: opts.onRowActivate,
    }
  }

  const d = envelope.data
  const bucketCounts = d.buckets as WorkBucketCounts
  const staleTotal = Object.entries(d.overlays).reduce((sum, [k, v]) => {
    if (String(k).startsWith('STALE') || k === 'EXPIRED_STALLED_RUN') {
      return sum + (typeof v === 'number' ? v : 0)
    }
    return sum
  }, 0)

  const ongoingByTask = buildOngoingJoinMap(d, opts.ongoingJoin)
  const nextReasonByTask = new Map(
    (d.dispatchNext?.selectedForNextDispatch ?? []).map((s) => [
      s.taskId,
      s.selectionReason,
    ]),
  )

  const items: WorkItemRow[] = d.items.map((row) => {
    const bucket = (row.bucket ?? opts.activeBucket) as PrimaryBucket
    const join = ongoingByTask.get(row.taskId)
    const nextWhy = nextReasonByTask.get(row.taskId)
    const claimState =
      typeof row.claimState === 'string' && row.claimState.length > 0
        ? row.claimState
        : null
    return {
      taskId: row.taskId,
      title: row.title,
      bucket,
      overlays: row.overlays,
      blockReason: (row.blockReason as WorkItemRow['blockReason']) ?? null,
      // Prefer dispatch "why NEXT" when present; else server blockReason only.
      reason: nextWhy ?? row.blockReason,
      projectId: row.projectId,
      featureContractId: row.featureId,
      lifecycleStage: row.lifecycleStage,
      ongoing: mapWorkOngoingDisplay(join, {
        bucket: row.bucket,
        targetGate: row.targetGate,
      }),
      reconciliation: claimState
        ? {
            claimState,
          }
        : null,
      detailHref: `/b/${encodeURIComponent(opts.boardId)}/tasks/${encodeURIComponent(row.taskId)}`,
    }
  })

  return {
    state,
    boardId: opts.boardId,
    activeBucket: opts.activeBucket,
    bucketCounts,
    staleOverlayActive: opts.staleOverlayActive,
    staleSummary: { total: staleTotal, byKind: d.overlays },
    items,
    page: {
      cursor: null,
      nextCursor: envelope.nextCursor,
      pageSize: d.pageSize,
      hasMore: Boolean(envelope.nextCursor),
      totalCount: null,
    },
    pinned: {
      canonicalSnapshotId: envelope.canonicalSnapshotId,
      canonicalHash: envelope.canonicalHash,
      taskHash: resolveWorkTaskHash(envelope, opts.routePinned),
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
    },
    envelopeStale: envelope.stale,
    envelopeStaleReason: envelope.staleReason,
    partialMessage:
      state === 'partial'
        ? 'Some work sections loaded partially — server section errors present'
        : null,
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : undefined,
    onBucketChange: opts.onBucketChange,
    onStaleOverlayChange: opts.onStaleOverlayChange,
    onNextPage: opts.onNextPage,
    onPrevPage: opts.onPrevPage,
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
    onReconnect: opts.onReconnect,
    onRowActivate: opts.onRowActivate,
  }
}

/** PriorityData envelope → PriorityScreen props. */
export function priorityEnvelopeToProps(
  envelope: PinnedEnvelope<PriorityData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    /** Optional overview rollup fields when parent already holds them — else N/A from priority only. */
    productDenominator?: number
    trackedWorkDenominator?: number
    stageProdReady?: number
    prodReadyWithEvidence?: number
    unclassifiedCount?: number
    boardReadinessPercent?: number | null
    rawTaskReadinessPercent?: number | null
    complete?: boolean
    cappedBy?: PriorityScreenProps['readiness'] extends infer R
      ? R extends { cappedBy: infer C }
        ? C
        : never
      : never
  } = {},
): PriorityScreenProps {
  const uiState = resolveClientSurfaceState(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  ) as PriorityScreenProps['uiState']

  if (!envelope || !envelope.data) {
    return {
      uiState,
      pin: null,
      errorCode: envelope?.error?.code ?? 'NO_DATA',
      errorMessage: envelope?.error?.message ?? 'Priority data unavailable',
      onRetry: opts.onRetry,
    }
  }

  const d = envelope.data
  const p = d.priority

  // G5 domain rows: priority envelope carries g5Pass only; expand nine required domains
  // as NOT_STARTED unless parent injects evaluation (no invented PASS).
  const domains = G5_REQUIRED_DOMAINS.map((domainId) => ({
    domainId,
    label: G5_DOMAIN_LABELS[domainId],
    status: (d.g5Pass ? 'PASS' : 'NOT_STARTED') as 'PASS' | 'NOT_STARTED',
    pass: d.g5Pass,
    reason: d.g5Pass ? null : 'domain detail not on priority surface — see Overview G5',
  }))

  return {
    uiState,
    pin: {
      boardId: envelope.boardId,
      canonicalSnapshotId: envelope.canonicalSnapshotId,
      canonicalHash: envelope.canonicalHash,
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
      generatedAt: envelope.generatedAt,
      freshnessAgeSeconds: envelope.freshnessAgeSeconds,
      stale: envelope.stale,
      staleReason: envelope.staleReason,
    },
    membership: {
      portfolioId: PRIORITY_PORTFOLIO_ID,
      membershipDenominator: p.membershipDenominator,
      membershipTaskIds: p.membershipTaskIds,
      // Server only counts receipt-valid members; empty denom without proof is fail-closed.
      receiptValid: p.membershipDenominator > 0,
    },
    denominators: {
      productDenominator: opts.productDenominator ?? d.productDenominator,
      trackedWorkDenominator: opts.trackedWorkDenominator ?? d.productDenominator,
      stageProdReady: opts.stageProdReady ?? 0,
      prodReadyWithEvidence: opts.prodReadyWithEvidence ?? 0,
      unclassifiedCount: opts.unclassifiedCount ?? 0,
    },
    readiness: {
      boardReadinessPercent: opts.boardReadinessPercent ?? null,
      rawTaskReadinessPercent: opts.rawTaskReadinessPercent ?? null,
      complete: opts.complete ?? false,
      cappedBy: (opts.cappedBy ?? 'DATA_INTEGRITY_OR_P0') as NonNullable<
        PriorityScreenProps['readiness']
      >['cappedBy'],
      g5Pass: d.g5Pass,
    },
    g5: {
      g5Pass: d.g5Pass,
      domains,
    },
    capacity: {
      portfolioId: PRIORITY_PORTFOLIO_ID,
      priorityClosureCapacity: p.priorityClosureCapacity,
      allClosureCapacity: p.allClosureCapacity,
      priorityCapacityShare: p.priorityCapacityShare,
      majorityAllocationPass: p.majorityAllocationPass,
      frontierState: p.frontierState,
      reason: p.reason,
    },
    nonPriorityReasons: {
      items: d.nonPriorityAllowedReasons.map((reason) => ({ reason })),
    },
    errorCode: envelope.error?.code,
    errorMessage: envelope.error?.message,
    onRetry: opts.onRetry,
  }
}

function readOptionalString(row: Record<string, unknown>, key: string): string | null {
  const v = row[key]
  if (typeof v === 'string' && v.length > 0) return v
  if (v === null || v === undefined || v === '') return null
  return null
}

function readOptionalNumber(row: Record<string, unknown>, key: string): number | null {
  const v = row[key]
  if (typeof v === 'number' && Number.isFinite(v)) return v
  return null
}

function mapDecisionRowToView(row: Record<string, unknown>): DecisionItemView {
  const status = String(row.status ?? '')
  const blocking = Boolean(row.blocking)
  const open = status === 'OPEN' || status === 'ACKNOWLEDGED'
  const ownerActions: string[] = []
  if (open && blocking) {
    ownerActions.push('Resolve blocking decision')
    ownerActions.push('Snooze unavailable (blocking)')
  } else if (open) {
    ownerActions.push('Review decision')
    ownerActions.push('Snooze (non-blocking only)')
  } else if (status === 'RESOLVED') {
    ownerActions.push('Resolved — view only')
  } else if (status === 'REJECTED') {
    ownerActions.push('Rejected — view only')
  } else {
    ownerActions.push('View decision')
  }

  const question = readOptionalString(row, 'question')
  const evidence = Array.isArray(row.evidence) ? row.evidence.map(String) : []
  const optionsRaw = Array.isArray(row.options) ? row.options : []
  const options = optionsRaw.map((o) => {
    const opt = (o ?? {}) as Record<string, unknown>
    return {
      optionId: String(opt.optionId ?? ''),
      label: String(opt.label ?? ''),
      tradeoffs:
        typeof opt.tradeoffs === 'string'
          ? opt.tradeoffs
          : opt.tradeoffs == null
            ? null
            : String(opt.tradeoffs),
      declining: Boolean(opt.declining),
    }
  })
  const recommendation =
    readOptionalString(row, 'agentRecommendation') ??
    readOptionalString(row, 'recommendation')

  // Honest empty arrays (options/evidence projected as []) are complete empties —
  // not projection gaps. Only absent / unprojected fields mark partial.
  const absentFields: string[] = []
  if (question == null) absentFields.push('question')
  if (!Array.isArray(row.options)) absentFields.push('options')
  if (!Array.isArray(row.evidence)) absentFields.push('evidence')
  if (recommendation == null) absentFields.push('agentRecommendation')

  return {
    decisionId: String(row.decisionId ?? ''),
    title: String(row.title ?? ''),
    question,
    severity: asSeverity(String(row.severity ?? '')) as DecisionsSeverity,
    blocking,
    status,
    dueAt: row.dueAt == null ? null : String(row.dueAt),
    createdAt: String(row.createdAt ?? ''),
    snoozedUntil: row.snoozedUntil == null ? null : String(row.snoozedUntil),
    type: row.type == null ? '' : String(row.type),
    evidence,
    options,
    recommendation,
    ownerId: readOptionalString(row, 'ownerId'),
    resolverId: readOptionalString(row, 'resolverId'),
    selectedOptionId: readOptionalString(row, 'selectedOptionId'),
    expectedRev: readOptionalNumber(row, 'expectedRev'),
    boardRev: readOptionalNumber(row, 'boardRev'),
    entityRev: readOptionalNumber(row, 'entityRev'),
    scopedApprovalId: readOptionalString(row, 'scopedApprovalId'),
    auditIds: Array.isArray(row.auditIds) ? row.auditIds.map(String) : [],
    projectId: readOptionalString(row, 'projectId'),
    featureId: readOptionalString(row, 'featureId'),
    taskId: readOptionalString(row, 'taskId'),
    runId: readOptionalString(row, 'runId'),
    ownerActions,
    partialFields: absentFields.length > 0,
    absentFields,
  }
}

/**
 * Decisions envelope → DecisionsScreen props.
 * Preserves server order; maps projected DecisionV3 public fields when present.
 * Never invents question/options/evidence/recommendation; never surfaces private comment.
 */
export function decisionsEnvelopeToProps(
  envelope: PinnedEnvelope<DecisionsData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onRefresh?: () => void
  } = {},
): DecisionsScreenProps {
  const surfaceState = resolveClientSurfaceState(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  ) as DecisionsScreenProps['surfaceState']

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId: envelope?.boardId ?? '',
      items: [],
      openCount: 0,
      blockingCount: 0,
      pageSize: 50,
      nextCursor: null,
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Decisions data unavailable' },
      projectionGaps: [],
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
    }
  }

  const d = envelope.data
  // Bounded server pagination only: when `items` is present (even empty), use it.
  // Never fall back to full `decisions` when the page is honestly empty.
  const source = Array.isArray(d.items) ? d.items : d.decisions
  const fullById = new Map(d.decisions.map((row) => [row.decisionId, row]))

  const items: DecisionItemView[] = source.map((row) => {
    const full = fullById.get(row.decisionId) ?? row
    // Merge list item + full decisions row (full carries richer fields).
    const merged = { ...(full as object), ...(row as object) } as Record<string, unknown>
    // Prefer full-row rich fields when items page omitted them.
    if (!('question' in row) && full && typeof full === 'object') {
      Object.assign(merged, full)
    }
    return mapDecisionRowToView(merged)
  })

  const gapSet = new Set<string>()
  for (const item of items) {
    for (const f of item.absentFields ?? []) gapSet.add(f)
  }
  const projectionGaps = [...gapSet].map((f) => `${f} absent on one or more decision rows`)

  let state = surfaceState
  if (d.blockingCount > 0 && (state === 'populated' || state === 'partial' || state === 'stale')) {
    state = 'needs-human'
  }

  return {
    surfaceState: state,
    boardId: envelope.boardId,
    items,
    openCount: d.openCount,
    blockingCount: d.blockingCount,
    pageSize: d.pageSize,
    nextCursor: envelope.nextCursor,
    pin: {
      boardId: envelope.boardId,
      canonicalSnapshotId: envelope.canonicalSnapshotId,
      canonicalHash: envelope.canonicalHash,
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
      stale: envelope.stale,
      staleReason: envelope.staleReason,
    },
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
    projectionGaps,
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
  }
}

/** Evidence envelope → simple list model (W4 owns richer components). */
export function evidenceEnvelopeToViewModel(
  envelope: PinnedEnvelope<EvidenceData | null> | null | undefined,
): {
  surfaceState: string
  boardId: string
  events: Array<{
    id: string
    createdAt: string
    kind: string
    summary: string
    actorId: string | null
    materialHash: string | null
  }>
  nextCursor: string | null
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
} {
  if (!envelope || !envelope.data) {
    return {
      surfaceState: resolveClientSurfaceState(
        envelope as PinnedEnvelope<unknown> | null | undefined,
      ),
      boardId: envelope?.boardId ?? '',
      events: [],
      nextCursor: null,
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : { code: 'NO_DATA', message: 'Evidence data unavailable' },
    }
  }
  return {
    surfaceState: envelope.surfaceState,
    boardId: envelope.boardId,
    events: envelope.data.events.map((e) => ({
      id: e.id,
      createdAt: e.createdAt,
      kind: e.kind,
      summary: e.summary ?? '',
      actorId: e.actorId,
      materialHash: e.materialHash,
    })),
    nextCursor: envelope.nextCursor,
    pin: {
      canonicalSnapshotId: envelope.canonicalSnapshotId,
      canonicalHash: envelope.canonicalHash,
      boardRev: envelope.boardRev,
      lifecycleRev: envelope.lifecycleRev,
      stale: envelope.stale,
      staleReason: envelope.staleReason,
    },
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
  }
}

/**
 * Stable pin identity for equality checks across surfaces (one aggregation per request).
 */
export function pinIdentityFromEnvelope(
  envelope: PinnedEnvelope<unknown>,
): {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
} {
  return {
    boardId: envelope.boardId,
    canonicalSnapshotId: envelope.canonicalSnapshotId,
    canonicalHash: envelope.canonicalHash,
    boardRev: envelope.boardRev,
    lifecycleRev: envelope.lifecycleRev,
    generatedAt: envelope.generatedAt,
  }
}
