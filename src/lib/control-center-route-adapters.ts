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
  type UiSurfaceState,
} from '#/lib/control-center-query'
import type {
  OverviewProps,
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
import {
  G5_DOMAIN_LABELS,
  G5_REQUIRED_DOMAINS,
  type G5DomainId,
} from '#/lib/control-plane-types'
import { sectionErrorHumanSentence } from '#/lib/section-error-copy'
import {
  knowledgeConflictSourcesFromRaw,
  knowledgeRedactionsFromRaw,
} from '#/lib/control-center-secondary-route-adapters'
import {
  extractMappingVersionWire,
  mappingVersionWireToBanner,
  type MappingVersionBannerView,
} from '#/lib/mapping-version-view'

const SEVERITIES = new Set(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW'])

/**
 * Resolve adaptive mapping banner from envelope / data.mappingVersion when present.
 * Mapping progress is never readiness (addendum B).
 * Accepts any pinned envelope (Overview or mapping-attached) — only pin + mappingVersion are read.
 */
export function resolveOverviewMappingBanner(
  envelope: PinnedEnvelope<unknown> | null | undefined,
): MappingVersionBannerView | null {
  if (!envelope) return null
  const fromEnv = extractMappingVersionWire(envelope)
  if (fromEnv) return mappingVersionWireToBanner(fromEnv)
  if (envelope.data) {
    const fromData = extractMappingVersionWire({ mappingVersion: (envelope.data as { mappingVersion?: unknown }).mappingVersion })
    if (fromData) return mappingVersionWireToBanner(fromData)
  }
  // Fallback: pin + freshness only (denominator unknown until mappingVersion is wired server-side)
  if (envelope.canonicalSnapshotId || envelope.canonicalHash) {
    return mappingVersionWireToBanner({
      schemaVersion: envelope.schemaVersion ?? null,
      knownSchema: true,
      snapshotId: envelope.canonicalSnapshotId || null,
      canonicalHash: envelope.canonicalHash || null,
      boardRev: typeof envelope.boardRev === 'number' ? envelope.boardRev : null,
      lifecycleRev: typeof envelope.lifecycleRev === 'number' ? envelope.lifecycleRev : null,
      freshnessAgeSeconds: envelope.freshnessAgeSeconds,
      stale: envelope.stale,
      staleReason: envelope.staleReason,
      dynamicDenominator: 0,
      mode: 'FULL',
      mappingIsNotReadiness: true,
    })
  }
  return null
}

function asSeverity(v: string | null | undefined): DecisionSeverity {
  if (v && SEVERITIES.has(v)) return v as DecisionSeverity
  return 'MEDIUM'
}

/**
 * Presentation wire for owner humanDisplay (fail-closed).
 * Never invents copy; maps server OwnerHumanDisplayUiProjection only.
 */
export type OwnerHumanDisplayView = {
  contentReviewRequired: boolean
  effectiveReviewStatus: string
  /** Owner primary title — blockedShell when content review required. */
  ownerPrimaryTitle: string
  statusSentence: string
  ownerAction: string
  whyItMatters: string
  next: string
  blocker: string
  citations: ReadonlyArray<{ field: string; path: string; note?: string }>
  missionQuestionLinks: ReadonlyArray<{
    questionId: string
    field?: string
    note?: string
  }>
  acceptanceLinks: ReadonlyArray<{ id?: string; path: string; summary?: string }>
  pin: {
    snapshotId: string | null
    boardRev: number | null
    lifecycleRev: number | null
    canonicalHash: string | null
    sourceHash: string
  }
}

function mapOwnerHumanDisplayView(
  raw: unknown,
): OwnerHumanDisplayView | null {
  if (!raw || typeof raw !== 'object') return null
  const o = raw as Record<string, unknown>
  const pinRaw =
    o.pin && typeof o.pin === 'object'
      ? (o.pin as Record<string, unknown>)
      : null
  const citations = Array.isArray(o.citations)
    ? o.citations.map((c) => {
        const row = (c ?? {}) as Record<string, unknown>
        return {
          field: String(row.field ?? ''),
          path: String(row.path ?? ''),
          note: typeof row.note === 'string' ? row.note : undefined,
        }
      })
    : []
  const missionQuestionLinks = Array.isArray(o.missionQuestionLinks)
    ? o.missionQuestionLinks.map((m) => {
        const row = (m ?? {}) as Record<string, unknown>
        return {
          questionId: String(row.questionId ?? ''),
          field: typeof row.field === 'string' ? row.field : undefined,
          note: typeof row.note === 'string' ? row.note : undefined,
        }
      })
    : []
  const acceptanceLinks = Array.isArray(o.acceptanceLinks)
    ? o.acceptanceLinks.map((a) => {
        const row = (a ?? {}) as Record<string, unknown>
        return {
          id: typeof row.id === 'string' ? row.id : undefined,
          path: String(row.path ?? ''),
          summary: typeof row.summary === 'string' ? row.summary : undefined,
        }
      })
    : []
  return {
    contentReviewRequired: Boolean(o.contentReviewRequired),
    effectiveReviewStatus: String(o.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED'),
    ownerPrimaryTitle: String(o.ownerPrimaryTitle ?? ''),
    statusSentence: String(o.statusSentence ?? ''),
    ownerAction: String(o.ownerAction ?? ''),
    whyItMatters: String(o.whyItMatters ?? ''),
    next: String(o.next ?? ''),
    blocker: String(o.blocker ?? ''),
    citations,
    missionQuestionLinks,
    acceptanceLinks,
    pin: {
      snapshotId:
        pinRaw && typeof pinRaw.snapshotId === 'string' ? pinRaw.snapshotId : null,
      boardRev:
        pinRaw && typeof pinRaw.boardRev === 'number' ? pinRaw.boardRev : null,
      lifecycleRev:
        pinRaw && typeof pinRaw.lifecycleRev === 'number'
          ? pinRaw.lifecycleRev
          : null,
      canonicalHash:
        pinRaw && typeof pinRaw.canonicalHash === 'string'
          ? pinRaw.canonicalHash
          : null,
      sourceHash:
        pinRaw && typeof pinRaw.sourceHash === 'string' ? pinRaw.sourceHash : '',
    },
  }
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
    envelope,
    opts.transport,
  )

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
  // Owner humanDisplay on topDecision when server projects it (optional wire).
  // Never invent ownerAction from blocking; missing/unreviewed → fail-closed fields.
  const topHd = top
    ? mapOwnerHumanDisplayView(
        (top as { ownerHumanDisplay?: unknown }).ownerHumanDisplay,
      )
    : null
  const decision =
    d.decisionCount > 0 || top
      ? {
          count: d.decisionCount,
          topSeverity: top ? asSeverity(top.severity) : null,
          topItem: top
            ? {
                decisionId: top.decisionId,
                // Technical title retained for secondary/tech mode only.
                title: top.title,
                // Real question only — never synthesize from title.
                question: topQuestion,
                severity: asSeverity(top.severity),
                blocking: top.blocking,
                // Owner action ONLY from projected humanDisplay — never invent
                // "Resolve blocking decision" / "Review decision" as owner primary copy.
                ownerAction: topHd?.ownerAction ?? '',
                status: top.status,
                ownerHumanDisplay: topHd,
                ownerPrimaryTitle: topHd?.ownerPrimaryTitle ?? null,
                statusSentence: topHd?.statusSentence ?? null,
                whyItMatters: topHd?.whyItMatters ?? null,
                next: topHd?.next ?? null,
                blocker: topHd?.blocker ?? null,
                contentReviewRequired: topHd?.contentReviewRequired ?? true,
                effectiveReviewStatus:
                  topHd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
                citations: topHd?.citations ?? null,
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

  const mappingBanner = resolveOverviewMappingBanner(envelope)

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
      // Adaptive mapping surface (P2). Optional for P1 visual banner consumption.
      // mappingIsNotReadiness is always true — never treat as delivery readiness.
      mappingVersion: mappingBanner,
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
      // Primary copy is a plain-language sentence; raw code/message moves to blockersDetail.
      blockers: d.sectionErrors.map((e) => sectionErrorHumanSentence(e.code)),
      blockersDetail: d.sectionErrors.map((e) => ({ code: e.code, message: e.message })),
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
    ongoing: d.ongoing.map((o) => {
      const hd = mapOwnerHumanDisplayView(
        (o as { ownerHumanDisplay?: unknown }).ownerHumanDisplay,
      )
      return {
        taskId: o.taskId,
        // Technical title retained for technical mode; owner primary is ownerHumanDisplay.
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
        ownerHumanDisplay: hd,
        // Owner-facing title: never fall back to technical title when HD requires review.
        ownerPrimaryTitle: hd?.ownerPrimaryTitle ?? null,
        statusSentence: hd?.statusSentence ?? null,
        ownerAction: hd?.ownerAction ?? null,
        whyItMatters: hd?.whyItMatters ?? null,
        next: hd?.next ?? null,
        blocker: hd?.blocker ?? null,
        contentReviewRequired: hd?.contentReviewRequired ?? true,
        effectiveReviewStatus: hd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
      }
    }),
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

/**
 * S24 display-layer text match over already-projected work rows.
 * Never invents buckets; only narrows the served page for ?query=.
 */
export function matchWorkItemTextQuery(
  item: Pick<
    WorkItemRow,
    'taskId' | 'title' | 'projectId' | 'featureContractId' | 'ownerPrimaryTitle' | 'statusSentence'
  > & { ownerHumanDisplay?: { ownerPrimaryTitle?: string | null } | null },
  query: string,
): boolean {
  const q = query.trim().toLowerCase()
  if (!q) return true
  const hay = [
    item.taskId,
    item.title,
    item.projectId,
    item.featureContractId,
    item.ownerPrimaryTitle,
    item.statusSentence,
    item.ownerHumanDisplay?.ownerPrimaryTitle,
  ]
    .filter((v): v is string => typeof v === 'string' && v.length > 0)
    .join('\n')
    .toLowerCase()
  return hay.includes(q)
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
    /**
     * S24 free-text query (`?query=`). Filters projected rows only;
     * empty match forces zero-results (never invents membership).
     */
    textQuery?: string | null
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
    envelope,
    opts.transport,
  )

  if (!envelope || !envelope.data) {
    return {
      state:
        opts.textQuery && opts.textQuery.trim().length > 0 && state === 'empty'
          ? 'zero-results'
          : state,
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

  const mapped = d.items.map((row) => {
    const bucket = (row.bucket ?? opts.activeBucket) as PrimaryBucket
    const join = ongoingByTask.get(row.taskId)
    const nextWhy = nextReasonByTask.get(row.taskId)
    const claimState =
      typeof row.claimState === 'string' && row.claimState.length > 0
        ? row.claimState
        : null
    const hd = mapOwnerHumanDisplayView(
      (row as { ownerHumanDisplay?: unknown }).ownerHumanDisplay,
    )
    return {
      taskId: row.taskId,
      // Technical title for technical mode only — owner primary is ownerHumanDisplay.
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
      // Board-scoped ART task detail (top-level /work/$taskId aliases here).
      detailHref: `/b/${encodeURIComponent(opts.boardId)}/work/${encodeURIComponent(row.taskId)}`,
      ownerHumanDisplay: hd,
      ownerPrimaryTitle: hd?.ownerPrimaryTitle ?? null,
      statusSentence: hd?.statusSentence ?? null,
      ownerAction: hd?.ownerAction ?? null,
      whyItMatters: hd?.whyItMatters ?? null,
      next: hd?.next ?? null,
      blocker: hd?.blocker ?? null,
      contentReviewRequired: hd?.contentReviewRequired ?? true,
      effectiveReviewStatus: hd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
    }
  }) as Array<
    WorkItemRow & {
      ownerHumanDisplay: OwnerHumanDisplayView | null
      ownerPrimaryTitle: string | null
      statusSentence: string | null
      ownerAction: string | null
      whyItMatters: string | null
      next: string | null
      blocker: string | null
      contentReviewRequired: boolean
      effectiveReviewStatus: string
    }
  >

  const textQuery =
    typeof opts.textQuery === 'string' && opts.textQuery.trim().length > 0
      ? opts.textQuery.trim()
      : null
  const items = textQuery
    ? mapped.filter((row) => matchWorkItemTextQuery(row, textQuery))
    : mapped

  let resolvedState = state
  if (
    textQuery &&
    items.length === 0 &&
    (state === 'populated' || state === 'empty' || state === 'zero-results')
  ) {
    resolvedState = 'zero-results'
  }

  return {
    state: resolvedState,
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
    envelope,
    opts.transport,
  )

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

  const hd = mapOwnerHumanDisplayView(row.ownerHumanDisplay)
  // Prefer humanDisplay ownerAction when projected; else presentational action labels.
  const hdOwnerAction = hd?.ownerAction
  const resolvedOwnerActions =
    hdOwnerAction && hdOwnerAction.length > 0
      ? [hdOwnerAction, ...ownerActions.filter((a) => a !== hdOwnerAction)]
      : ownerActions

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
    ownerActions: resolvedOwnerActions,
    partialFields: absentFields.length > 0,
    absentFields,
    // Extended owner HD wire (not on DecisionItemView yet — cast-safe excess for consumers).
    ownerHumanDisplay: hd,
    ownerPrimaryTitle: hd?.ownerPrimaryTitle ?? null,
    statusSentence: hd?.statusSentence ?? null,
    whyItMatters: hd?.whyItMatters ?? null,
    next: hd?.next ?? null,
    blocker: hd?.blocker ?? null,
    contentReviewRequired: hd?.contentReviewRequired ?? true,
    effectiveReviewStatus: hd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
  } as DecisionItemView & {
    ownerHumanDisplay: OwnerHumanDisplayView | null
    ownerPrimaryTitle: string | null
    statusSentence: string | null
    whyItMatters: string | null
    next: string | null
    blocker: string | null
    contentReviewRequired: boolean
    effectiveReviewStatus: string
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
    envelope,
    opts.transport,
  )

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
        envelope,
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

// ---------------------------------------------------------------------------
// ART task detail / decision detail / knowledge / search / documentation
// Presentation-only — never invent readiness or fake domain coverage.
// ---------------------------------------------------------------------------

export type TaskDetailMode = 'human' | 'technical'

export type TaskDetailViewModel = {
  surfaceState: UiSurfaceState | 'loading' | 'error' | 'forbidden' | 'zero-results'
  boardId: string
  taskId: string
  mode: TaskDetailMode
  /** Owner primary title (fail-closed CONTENT_REVIEW_REQUIRED). */
  ownerPrimaryTitle: string
  statusSentence: string
  ownerAction: string
  whyItMatters: string
  next: string
  blocker: string
  contentReviewRequired: boolean
  effectiveReviewStatus: string
  /** Technical fields — demoted; shown only in mode=technical. */
  technicalTitle: string
  projectId: string | null
  featureId: string | null
  bucket: string | null
  overlays: ReadonlyArray<string>
  blockReason: string | null
  lifecycleStage: string | null
  targetGate: string | null
  claimState: string | null
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
  workHref: string
  technicalHref: string
  humanHref: string
}

export function taskDetailEnvelopeToViewModel(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  opts: { boardId: string; taskId: string; mode?: TaskDetailMode | null },
): TaskDetailViewModel {
  const mode: TaskDetailMode = opts.mode === 'technical' ? 'technical' : 'human'
  const humanHref = `/work/${encodeURIComponent(opts.taskId)}`
  const technicalHref = `/work/${encodeURIComponent(opts.taskId)}?mode=technical`
  const workHref = `/work`

  if (!envelope || envelope.data == null) {
    const surfaceState = resolveClientSurfaceState(
      envelope,
    )
    return {
      surfaceState:
        surfaceState === 'error' || surfaceState === 'forbidden'
          ? surfaceState
          : 'zero-results',
      boardId: opts.boardId,
      taskId: opts.taskId,
      mode,
      ownerPrimaryTitle: '',
      statusSentence: '',
      ownerAction: '',
      whyItMatters: '',
      next: '',
      blocker: '',
      contentReviewRequired: true,
      effectiveReviewStatus: 'CONTENT_REVIEW_REQUIRED',
      technicalTitle: opts.taskId,
      projectId: null,
      featureId: null,
      bucket: null,
      overlays: [],
      blockReason: null,
      lifecycleStage: null,
      targetGate: null,
      claimState: null,
      pin: envelope
        ? {
            canonicalSnapshotId: envelope.canonicalSnapshotId,
            canonicalHash: envelope.canonicalHash,
            boardRev: envelope.boardRev,
            lifecycleRev: envelope.lifecycleRev,
            stale: envelope.stale,
            staleReason: envelope.staleReason,
          }
        : null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : { code: 'NOT_FOUND', message: 'Task not found in pinned work set' },
      workHref,
      technicalHref,
      humanHref,
    }
  }

  const raw = envelope.data as Record<string, unknown>
  const hd = mapOwnerHumanDisplayView(raw.ownerHumanDisplay)
  const overlays = Array.isArray(raw.overlays)
    ? raw.overlays.map((o) => String(o))
    : []

  return {
    surfaceState: envelope.surfaceState,
    boardId: opts.boardId,
    taskId: String(raw.taskId ?? opts.taskId),
    mode,
    ownerPrimaryTitle: hd?.ownerPrimaryTitle ?? '',
    statusSentence: hd?.statusSentence ?? '',
    ownerAction: hd?.ownerAction ?? '',
    whyItMatters: hd?.whyItMatters ?? '',
    next: hd?.next ?? '',
    blocker: hd?.blocker ?? '',
    contentReviewRequired: hd?.contentReviewRequired ?? true,
    effectiveReviewStatus: hd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
    technicalTitle: String(raw.technicalTitle ?? raw.taskId ?? opts.taskId),
    projectId: typeof raw.projectId === 'string' ? raw.projectId : null,
    featureId: typeof raw.featureId === 'string' ? raw.featureId : null,
    bucket: typeof raw.bucket === 'string' ? raw.bucket : null,
    overlays,
    blockReason: typeof raw.blockReason === 'string' ? raw.blockReason : null,
    lifecycleStage: typeof raw.lifecycleStage === 'string' ? raw.lifecycleStage : null,
    targetGate: typeof raw.targetGate === 'string' ? raw.targetGate : null,
    claimState: typeof raw.claimState === 'string' ? raw.claimState : null,
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
    workHref,
    technicalHref,
    humanHref,
  }
}

export type DecisionDetailViewModel = {
  surfaceState: UiSurfaceState | 'loading' | 'error' | 'forbidden' | 'zero-results'
  boardId: string
  decisionId: string
  item: DecisionItemView | null
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
  listHref: string
}

/** Pick one decision from a decisions envelope by id (no reordering). */
export function decisionDetailFromEnvelope(
  envelope: PinnedEnvelope<DecisionsData | null> | null | undefined,
  opts: { boardId: string; decisionId: string },
): DecisionDetailViewModel {
  const listHref = '/decisions'
  if (!envelope || !envelope.data) {
    return {
      surfaceState: resolveClientSurfaceState(
        envelope,
      ),
      boardId: opts.boardId,
      decisionId: opts.decisionId,
      item: null,
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : { code: 'NO_DATA', message: 'Decisions envelope unavailable' },
      listHref,
    }
  }
  const props = decisionsEnvelopeToProps(envelope, {})
  const item =
    props.items.find(
      (d) => d.decisionId === opts.decisionId || (d as { id?: string }).id === opts.decisionId,
    ) ?? null
  return {
    surfaceState: item ? props.surfaceState : 'zero-results',
    boardId: opts.boardId,
    decisionId: opts.decisionId,
    item,
    pin: props.pin
      ? {
          canonicalSnapshotId: props.pin.canonicalSnapshotId,
          canonicalHash: props.pin.canonicalHash,
          boardRev: props.pin.boardRev,
          lifecycleRev: props.pin.lifecycleRev,
          stale: props.pin.stale,
          staleReason: props.pin.staleReason,
        }
      : null,
    error: item
      ? null
      : { code: 'NOT_FOUND', message: 'Decision not found in pinned inbox' },
    listHref,
  }
}

export type KnowledgeDomainViewModel = {
  surfaceState: UiSurfaceState | 'loading' | 'error' | 'forbidden' | 'partial' | 'zero-results'
  boardId: string
  domain: string
  domainId: string | null
  availability: 'available' | 'partial' | 'unavailable'
  title: string
  summary: string
  projects: ReadonlyArray<{ id: string; name: string | null; taskCount: number }>
  features: ReadonlyArray<{ id: string; name: string | null }>
  tasks: ReadonlyArray<{
    taskId: string
    title: string
    bucket: string | null
    ownerPrimaryTitle: string | null
  }>
  decisions: ReadonlyArray<{ decisionId: string; title: string; status: string }>
  evidence: ReadonlyArray<{ id: string; kind: string; summary: string }>
  gaps: ReadonlyArray<string>
  /** Structured gaps from DomainKnowledgeBundle (AFFILIATE); null when absent. */
  knowledgeGaps: ReadonlyArray<{
    id: string
    code: string
    message: string
    knowledgeState: string
  }> | null
  /** Coverage/omission manifest (AFFILIATE); null when absent. */
  coverageManifest: ReadonlyArray<{
    id: string
    kind: string
    label: string
    disposition: string
    reason: string | null
    projectIds: ReadonlyArray<string>
    knowledgeState: string
  }> | null
  relations: ReadonlyArray<{
    id: string
    fromId: string
    toId: string
    type: string
    label: string
  }> | null
  flows: ReadonlyArray<{
    id: string
    name: string
    featureId: string
    projectIds: ReadonlyArray<string>
  }> | null
  boundaries: ReadonlyArray<string> | null
  /**
   * Multi-source CONFLICT projector fields (TM-08 / ART S21).
   * Pass-through only — never invent a second source client-side.
   */
  conflictSources: ReadonlyArray<{
    sourceId: string
    label: string
    citation: string | null
    claim: string | null
  }>
  redactions: ReadonlyArray<{
    fieldPath: string
    reason: string
    hiddenScope: string
  }>
  knowledgeState: string | null
  lastValidGeneratedAt: string | null
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
}

function asKnowledgeGapRows(
  raw: unknown,
): KnowledgeDomainViewModel['knowledgeGaps'] {
  if (!Array.isArray(raw)) return null
  return raw.map((g) => {
    const row = (g ?? {}) as Record<string, unknown>
    return {
      id: String(row.id ?? ''),
      code: String(row.code ?? ''),
      message: String(row.message ?? ''),
      knowledgeState: String(row.knowledgeState ?? 'UNKNOWN'),
    }
  })
}

function asCoverageManifestRows(
  raw: unknown,
): KnowledgeDomainViewModel['coverageManifest'] {
  if (!Array.isArray(raw)) return null
  return raw.map((c) => {
    const row = (c ?? {}) as Record<string, unknown>
    return {
      id: String(row.id ?? ''),
      kind: String(row.kind ?? ''),
      label: String(row.label ?? ''),
      disposition: String(row.disposition ?? 'unknown'),
      reason: typeof row.reason === 'string' ? row.reason : null,
      projectIds: Array.isArray(row.projectIds)
        ? row.projectIds.map((p) => String(p))
        : [],
      knowledgeState: String(row.knowledgeState ?? 'UNKNOWN'),
    }
  })
}

export function knowledgeDomainEnvelopeToViewModel(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  opts: { boardId: string; domain: string },
): KnowledgeDomainViewModel {
  if (!envelope || envelope.data == null) {
    return {
      surfaceState: resolveClientSurfaceState(
        envelope,
      ),
      boardId: opts.boardId,
      domain: opts.domain,
      domainId: null,
      availability: 'unavailable',
      title: opts.domain,
      summary: 'Data domain knowledge tidak tersedia dari pin saat ini.',
      projects: [],
      features: [],
      tasks: [],
      decisions: [],
      evidence: [],
      gaps: ['NO_PINNED_DOMAIN_DATA'],
      knowledgeGaps: null,
      coverageManifest: null,
      relations: null,
      flows: null,
      boundaries: null,
      conflictSources: [],
      redactions: [],
      knowledgeState: 'UNKNOWN',
      lastValidGeneratedAt: null,
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : { code: 'UNAVAILABLE', message: 'Domain knowledge unavailable' },
    }
  }
  const raw = envelope.data as Record<string, unknown>
  const availabilityRaw = String(raw.availability ?? 'unavailable')
  const availability =
    availabilityRaw === 'available' || availabilityRaw === 'partial'
      ? availabilityRaw
      : 'unavailable'
  const relations = Array.isArray(raw.relations)
    ? (raw.relations as NonNullable<KnowledgeDomainViewModel['relations']>).map((r) => ({
        id: String((r as { id?: string }).id ?? ''),
        fromId: String((r as { fromId?: string }).fromId ?? ''),
        toId: String((r as { toId?: string }).toId ?? ''),
        type: String((r as { type?: string }).type ?? ''),
        label: String((r as { label?: string }).label ?? ''),
      }))
    : null
  const flows = Array.isArray(raw.flows)
    ? (raw.flows as Array<Record<string, unknown>>).map((f) => ({
        id: String(f.id ?? ''),
        name: String(f.name ?? ''),
        featureId: String(f.featureId ?? ''),
        projectIds: Array.isArray(f.projectIds)
          ? f.projectIds.map((p) => String(p))
          : [],
      }))
    : null
  const boundaries = Array.isArray(raw.boundaries)
    ? raw.boundaries.map((b) => String(b))
    : null
  // TM-08: pass-through server conflicts/redactions only (no client invention).
  const conflictSources = knowledgeConflictSourcesFromRaw(raw)
  const redactions = knowledgeRedactionsFromRaw(raw)
  const knowledgeState =
    typeof raw.knowledgeState === 'string' && raw.knowledgeState.trim()
      ? raw.knowledgeState.trim().toUpperCase()
      : null
  const lastValidGeneratedAt =
    typeof raw.lastValidGeneratedAt === 'string' ? raw.lastValidGeneratedAt : null
  return {
    surfaceState: (raw.surfaceState as KnowledgeDomainViewModel['surfaceState']) ??
      envelope.surfaceState,
    boardId: opts.boardId,
    domain: String(raw.domain ?? opts.domain),
    domainId: typeof raw.domainId === 'string' ? raw.domainId : null,
    availability,
    title: String(raw.title ?? opts.domain),
    summary: String(raw.summary ?? ''),
    projects: Array.isArray(raw.projects)
      ? (raw.projects as KnowledgeDomainViewModel['projects'])
      : [],
    features: Array.isArray(raw.features)
      ? (raw.features as KnowledgeDomainViewModel['features'])
      : [],
    tasks: Array.isArray(raw.tasks) ? (raw.tasks as KnowledgeDomainViewModel['tasks']) : [],
    decisions: Array.isArray(raw.decisions)
      ? (raw.decisions as KnowledgeDomainViewModel['decisions'])
      : [],
    evidence: Array.isArray(raw.evidence)
      ? (raw.evidence as KnowledgeDomainViewModel['evidence'])
      : [],
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map((g) => String(g)) : [],
    knowledgeGaps: asKnowledgeGapRows(raw.knowledgeGaps),
    coverageManifest: asCoverageManifestRows(raw.coverageManifest),
    relations,
    flows,
    boundaries,
    conflictSources,
    redactions,
    knowledgeState,
    lastValidGeneratedAt,
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

export type SearchResultViewModel = {
  surfaceState: UiSurfaceState | 'loading' | 'error' | 'forbidden' | 'zero-results'
  boardId: string
  query: string
  results: ReadonlyArray<{
    kind: 'task' | 'project' | 'feature' | 'decision' | 'evidence'
    id: string
    title: string
    subtitle: string | null
    href: string
    technicalAlias: string | null
  }>
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
}

export function searchEnvelopeToViewModel(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  opts: { boardId: string; query: string },
): SearchResultViewModel {
  if (!envelope || envelope.data == null) {
    return {
      surfaceState: resolveClientSurfaceState(
        envelope,
      ),
      boardId: opts.boardId,
      query: opts.query,
      results: [],
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : null,
    }
  }
  const raw = envelope.data as Record<string, unknown>
  const results = Array.isArray(raw.results)
    ? (raw.results as SearchResultViewModel['results'])
    : []
  const q = opts.query.trim()
  let surfaceState = envelope.surfaceState
  if (q.length > 0 && results.length === 0 && surfaceState === 'populated') {
    surfaceState = 'zero-results'
  }
  if (q.length === 0) {
    surfaceState = 'empty'
  }
  return {
    surfaceState,
    boardId: opts.boardId,
    query: String(raw.query ?? opts.query),
    results,
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

export type DocumentationDomainViewModel = {
  surfaceState: UiSurfaceState | 'loading' | 'error' | 'forbidden' | 'partial' | 'zero-results'
  boardId: string
  domain: string
  domainId: string | null
  availability: 'available' | 'partial' | 'unavailable'
  title: string
  bodyMarkdown: string
  citations: ReadonlyArray<{ field: string; path: string; note?: string }>
  gaps: ReadonlyArray<string>
  knowledgeGaps: KnowledgeDomainViewModel['knowledgeGaps']
  coverageManifest: KnowledgeDomainViewModel['coverageManifest']
  pin: {
    canonicalSnapshotId: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
    stale: boolean
    staleReason: string | null
  } | null
  error: { code: string; message: string } | null
}

export function documentationDomainEnvelopeToViewModel(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  opts: { boardId: string; domain: string },
): DocumentationDomainViewModel {
  if (!envelope || envelope.data == null) {
    return {
      surfaceState: resolveClientSurfaceState(
        envelope,
      ),
      boardId: opts.boardId,
      domain: opts.domain,
      domainId: null,
      availability: 'unavailable',
      title: opts.domain,
      bodyMarkdown: '',
      citations: [],
      gaps: ['NO_PINNED_DOCUMENTATION'],
      knowledgeGaps: null,
      coverageManifest: null,
      pin: null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : { code: 'UNAVAILABLE', message: 'Documentation unavailable' },
    }
  }
  const raw = envelope.data as Record<string, unknown>
  const availabilityRaw = String(raw.availability ?? 'unavailable')
  const availability =
    availabilityRaw === 'available' || availabilityRaw === 'partial'
      ? availabilityRaw
      : 'unavailable'
  const citations = Array.isArray(raw.citations)
    ? raw.citations.map((c) => {
        const row = (c ?? {}) as Record<string, unknown>
        return {
          field: String(row.field ?? ''),
          path: String(row.path ?? ''),
          note: typeof row.note === 'string' ? row.note : undefined,
        }
      })
    : []
  return {
    surfaceState: envelope.surfaceState,
    boardId: opts.boardId,
    domain: String(raw.domain ?? opts.domain),
    domainId: typeof raw.domainId === 'string' ? raw.domainId : null,
    availability,
    title: String(raw.title ?? opts.domain),
    bodyMarkdown: String(raw.bodyMarkdown ?? ''),
    citations,
    gaps: Array.isArray(raw.gaps) ? raw.gaps.map((g) => String(g)) : [],
    knowledgeGaps: asKnowledgeGapRows(raw.knowledgeGaps),
    coverageManifest: asCoverageManifestRows(raw.coverageManifest),
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
