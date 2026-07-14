/**
 * C3-R2C: Presentation-only mapping from pinned secondary envelopes → screen props.
 * NEVER recomputes readiness, buckets, stall sort, capacity formulas, or redaction.
 * Field renames + age formatting only. Server order/counts/pagination preserved.
 */

import {
  formatAgeSeconds,
  resolveClientSurfaceState,
  type PinnedEnvelope,
  type ProjectsData,
  type FeaturesData,
  type AgentsData,
  type OpsData,
  type UiSurfaceState,
} from '#/lib/control-center-query'
import type {
  ProjectsScreenProps,
  ProjectRowView,
  ProjectsPinView,
} from '#/components/control-center/projects'
import type {
  FeaturesScreenProps,
  FeatureRowView,
  FeaturesPinView,
} from '#/components/control-center/features'
import type {
  AgentsScreenProps,
  AgentRunRowView,
  AgentOngoingRowView,
  AgentsPinView,
} from '#/components/control-center/agents'
import type {
  OpsScreenProps,
  OpsAccountRowView,
  OpsPinView,
} from '#/components/control-center/ops'

// ---------------------------------------------------------------------------
// Shared pin + links
// ---------------------------------------------------------------------------

export type SecondarySurfaceState = UiSurfaceState | 'loading' | 'zero-results' | 'error' | 'forbidden'

export function pinAttrsFromEnvelope(
  envelope: PinnedEnvelope<unknown> | null | undefined,
): ProjectsPinView | null {
  if (!envelope) return null
  return {
    boardId: envelope.boardId,
    canonicalSnapshotId: envelope.canonicalSnapshotId,
    canonicalHash: envelope.canonicalHash,
    boardRev: envelope.boardRev,
    lifecycleRev: envelope.lifecycleRev,
    generatedAt: envelope.generatedAt,
    freshnessAgeSeconds: envelope.freshnessAgeSeconds,
    stale: envelope.stale,
    staleReason: envelope.staleReason,
  }
}

/** Deep link to legacy project detail — preserved, not replaced. */
export function projectDetailHref(boardId: string, projectId: string): string {
  return `/b/${encodeURIComponent(boardId)}/projects/${encodeURIComponent(projectId)}`
}

/** Deep link to legacy feature detail — preserved, not replaced. */
export function featureDetailHref(boardId: string, featureId: string): string {
  return `/b/${encodeURIComponent(boardId)}/features/${encodeURIComponent(featureId)}`
}

/** Deep link to task detail when a task id is present. */
export function taskDetailHref(boardId: string, taskId: string): string {
  return `/b/${encodeURIComponent(boardId)}/tasks/${encodeURIComponent(taskId)}`
}

function asSurface(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  transport: 'online' | 'offline' | 'unknown' = 'online',
): SecondarySurfaceState {
  return resolveClientSurfaceState(envelope, transport) as SecondarySurfaceState
}

function pinView(
  envelope: PinnedEnvelope<unknown>,
): ProjectsPinView & FeaturesPinView & AgentsPinView & OpsPinView {
  return {
    boardId: envelope.boardId,
    canonicalSnapshotId: envelope.canonicalSnapshotId,
    canonicalHash: envelope.canonicalHash,
    boardRev: envelope.boardRev,
    lifecycleRev: envelope.lifecycleRev,
    generatedAt: envelope.generatedAt,
    freshnessAgeSeconds: envelope.freshnessAgeSeconds,
    stale: envelope.stale,
    staleReason: envelope.staleReason,
  }
}

/** Pass-through string lists from server — never invent entries. */
export function asServerStringList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((v): v is string => typeof v === 'string' && v.trim().length > 0)
}

function asNullableNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

function asNullableString(value: unknown): string | null {
  return typeof value === 'string' && value.length > 0 ? value : null
}

function asNullableBoolean(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null
}

// ---------------------------------------------------------------------------
// Projects
// ---------------------------------------------------------------------------

export function projectsEnvelopeToProps(
  envelope: PinnedEnvelope<ProjectsData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onRefresh?: () => void
  } = {},
): ProjectsScreenProps {
  const surfaceState = asSurface(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  )

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId: envelope?.boardId ?? '',
      projects: [],
      productDenominator: null,
      bucketCounts: null,
      pin: pinAttrsFromEnvelope(envelope as PinnedEnvelope<unknown> | null | undefined),
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Projects data unavailable' },
      projectionGaps: [],
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
    }
  }

  const d = envelope.data
  const projects: ProjectRowView[] = d.projects.map((p) => ({
    projectId: p.id,
    name: p.name ?? p.id,
    status: p.status,
    taskCount: p.taskCount,
    doneCount: p.doneCount,
    blockedCount: p.blockedCount,
    // Server enrichment only — null when no proven PRODUCT stage (never fake 0/100).
    readinessPercent: asNullableNumber(p.readinessPercent),
    readinessStage: asNullableString(p.readinessStage),
    readinessEvidenceOk: asNullableBoolean(p.readinessEvidenceOk),
    detailHref: projectDetailHref(envelope.boardId, p.id),
  }))

  return {
    surfaceState,
    boardId: envelope.boardId,
    projects,
    productDenominator: d.productDenominator,
    bucketCounts: d.buckets ? { ...d.buckets } : null,
    pin: pinView(envelope),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
    // Readiness fields now wired from ProjectUiSummary — no false "missing" gap.
    projectionGaps: [],
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
  }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

/** Map one FeatureUiSummary → list/detail row view (presentation only). */
export function featureUiSummaryToRowView(
  boardId: string,
  f: {
    id?: string | null
    projectId?: string | null
    name?: string | null
    phase?: string | null
    flowBranch?: FeatureRowView['flowBranch']
    taskCount?: number | null
    progressNodes?: ReadonlyArray<{
      taskId?: string | null
      title?: string | null
      lifecycleStage?: string | null
      status?: string | null
      blockedReason?: string | null
      technicalTitle?: string | null
      contentReviewRequired?: boolean | null
    }> | null
    stageCounts?: Record<string, number> | null
    pageRoutes?: string[] | null
    apiEndpoints?: string[] | null
    logicRules?: string[] | null
    dataContext?: string[] | null
    geoVariants?: string[] | null
    providerVariants?: string[] | null
    sideEffectsReadback?: string[] | null
    styleContext?: string[] | null
  },
): FeatureRowView {
  const featureId = typeof f.id === 'string' ? f.id : ''
  const progressNodes = Array.isArray(f.progressNodes)
    ? f.progressNodes
        .filter((n) => n && typeof n.taskId === 'string' && n.taskId.length > 0)
        .map((n) => {
          const taskId = String(n.taskId)
          return {
            taskId,
            title:
              (typeof n.title === 'string' && n.title.trim()) || taskId || '—',
            lifecycleStage:
              typeof n.lifecycleStage === 'string' && n.lifecycleStage.trim()
                ? n.lifecycleStage
                : null,
            status: typeof n.status === 'string' && n.status.trim() ? n.status : null,
            blockedReason:
              typeof n.blockedReason === 'string' && n.blockedReason.trim()
                ? n.blockedReason
                : null,
            technicalTitle:
              typeof n.technicalTitle === 'string' && n.technicalTitle.trim()
                ? n.technicalTitle.trim()
                : null,
            contentReviewRequired: n.contentReviewRequired === true,
            detailHref: boardId
              ? `/b/${encodeURIComponent(boardId)}/work/${encodeURIComponent(taskId)}`
              : `/work/${encodeURIComponent(taskId)}`,
          }
        })
    : []
  const stageCounts: Record<string, number> = {}
  if (f.stageCounts && typeof f.stageCounts === 'object') {
    for (const [k, v] of Object.entries(f.stageCounts)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) stageCounts[k] = v
    }
  } else {
    for (const n of progressNodes) {
      const stage = n.lifecycleStage ?? 'UNKNOWN'
      stageCounts[stage] = (stageCounts[stage] ?? 0) + 1
    }
  }
  return {
    featureId,
    projectId: f.projectId ?? null,
    name: (typeof f.name === 'string' && f.name) || featureId || '—',
    phase: f.phase ?? null,
    flowBranch: f.flowBranch ?? null,
    taskCount: typeof f.taskCount === 'number' && Number.isFinite(f.taskCount) ? f.taskCount : 0,
    detailHref: featureId ? featureDetailHref(boardId, featureId) : '',
    projectHref: f.projectId ? projectDetailHref(boardId, f.projectId) : null,
    progressNodes,
    stageCounts,
    pageRoutes: asServerStringList(f.pageRoutes),
    apiEndpoints: asServerStringList(f.apiEndpoints),
    logicRules: asServerStringList(f.logicRules),
    dataContext: asServerStringList(f.dataContext),
    geoVariants: asServerStringList(f.geoVariants),
    providerVariants: asServerStringList(f.providerVariants),
    sideEffectsReadback: asServerStringList(f.sideEffectsReadback),
    styleContext: asServerStringList(f.styleContext),
  }
}

/**
 * Resolve a feature detail row from the pinned features envelope.
 * Prefers full `data.features` (all ids), then current page `items`.
 * Returns null when the id is absent (honest not-found — never invent).
 */
export function featureDetailFromEnvelope(
  envelope: PinnedEnvelope<FeaturesData | null> | null | undefined,
  featureId: string,
): {
  surfaceState: SecondarySurfaceState
  boardId: string
  feature: FeatureRowView | null
  pin: FeaturesPinView | null
  error: { code: string; message: string } | null
  listHref: string
} {
  const boardId = envelope?.boardId ?? ''
  const listHref = boardId ? `/b/${encodeURIComponent(boardId)}/features` : '/features'
  const surfaceState = asSurface(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    'online',
  )

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId,
      feature: null,
      pin: pinAttrsFromEnvelope(envelope as PinnedEnvelope<unknown> | null | undefined) as FeaturesPinView | null,
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Features data unavailable' },
      listHref,
    }
  }

  const d = envelope.data
  const pool = [
    ...(Array.isArray(d.features) ? d.features : []),
    ...(Array.isArray(d.items) ? d.items : []),
  ]
  const raw = pool.find((f) => f && typeof f.id === 'string' && f.id === featureId) ?? null
  const feature = raw ? featureUiSummaryToRowView(envelope.boardId, raw) : null

  return {
    surfaceState: feature ? surfaceState : surfaceState === 'loading' ? 'loading' : 'empty',
    boardId: envelope.boardId,
    feature,
    pin: pinView(envelope),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : feature
        ? null
        : { code: 'NOT_FOUND', message: `Feature not found: ${featureId}` },
    listHref,
  }
}

export function featuresEnvelopeToProps(
  envelope: PinnedEnvelope<FeaturesData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onRefresh?: () => void
    onNextPage?: () => void
  } = {},
): FeaturesScreenProps {
  const surfaceState = asSurface(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  )

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId: envelope?.boardId ?? '',
      features: [],
      pageSize: 50,
      nextCursor: null,
      pin: pinAttrsFromEnvelope(envelope as PinnedEnvelope<unknown> | null | undefined),
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Features data unavailable' },
      projectionGaps: [],
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
      onNextPage: opts.onNextPage,
    }
  }

  const d = envelope.data
  // Bounded server pagination only: when `items` is present (even empty), use it.
  // Never fall back to full `features` when the page is honestly empty.
  // Order is server order — never client re-sort.
  const source = Array.isArray(d.items) ? d.items : d.features
  const features: FeatureRowView[] = source
    .map((f) => featureUiSummaryToRowView(envelope.boardId, f))
    // Guard: never emit detailHref with empty/undefined id (historical items id-strip bug).
    .filter((row) => row.featureId.length > 0)

  return {
    surfaceState,
    boardId: envelope.boardId,
    features,
    pageSize: d.pageSize,
    nextCursor: envelope.nextCursor,
    pin: pinView(envelope),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
    projectionGaps: [
      'full feature checklist / comments not on FeaturesData list surface',
    ],
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
    onNextPage: opts.onNextPage,
  }
}

// ---------------------------------------------------------------------------
// Agents / Runs
// ---------------------------------------------------------------------------

const SENSITIVE_ACCOUNT_RE =
  /(sk-|api[_-]?key|token|secret|password|bearer\s+[a-z0-9]|eyJ[a-zA-Z0-9_-]{10,})/i

/** Display helper — never invent redaction; only refuse to render obvious secrets if they leak. */
export function safeMaskedAccountDisplay(
  value: string | null | undefined,
): string {
  if (value == null || value === '') return '—'
  if (SENSITIVE_ACCOUNT_RE.test(value)) return '•••• (redacted)'
  return value
}

export function agentsEnvelopeToProps(
  envelope: PinnedEnvelope<AgentsData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onRefresh?: () => void
    onNextPage?: () => void
  } = {},
): AgentsScreenProps {
  const surfaceState = asSurface(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  )

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId: envelope?.boardId ?? '',
      ongoing: [],
      runs: [],
      pageSize: 50,
      nextCursor: null,
      pin: pinAttrsFromEnvelope(envelope as PinnedEnvelope<unknown> | null | undefined),
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Agents data unavailable' },
      projectionGaps: [],
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
      onNextPage: opts.onNextPage,
    }
  }

  const d = envelope.data
  const boardId = envelope.boardId

  const ongoing = d.ongoing.map((o) => {
    const hdRaw = (o as { ownerHumanDisplay?: unknown }).ownerHumanDisplay
    const hd =
      hdRaw && typeof hdRaw === 'object'
        ? (hdRaw as {
            ownerPrimaryTitle?: string
            statusSentence?: string
            ownerAction?: string
            whyItMatters?: string
            next?: string
            blocker?: string
            contentReviewRequired?: boolean
            effectiveReviewStatus?: string
          })
        : null
    return {
      taskId: o.taskId,
      // Technical title retained; owner primary is ownerHumanDisplay fields.
      title: o.title,
      targetGate: o.targetGate,
      agentId: o.agentId,
      role: o.role,
      model: o.model,
      effort: o.effort,
      maskedAccount: safeMaskedAccountDisplay(o.maskedAccount),
      startedAge: formatAgeSeconds(o.startedAgeSeconds),
      heartbeatAge: formatAgeSeconds(o.heartbeatAgeSeconds),
      materialProgressAge: formatAgeSeconds(o.materialProgressAgeSeconds),
      productiveSubstate: o.productiveSubstate,
      evidenceLink: o.evidenceLink,
      taskHref: taskDetailHref(boardId, o.taskId),
      overlays: [...o.overlays],
      ownerPrimaryTitle: hd?.ownerPrimaryTitle ?? null,
      statusSentence: hd?.statusSentence ?? null,
      ownerAction: hd?.ownerAction ?? null,
      whyItMatters: hd?.whyItMatters ?? null,
      next: hd?.next ?? null,
      blocker: hd?.blocker ?? null,
      contentReviewRequired: hd?.contentReviewRequired ?? true,
      effectiveReviewStatus: hd?.effectiveReviewStatus ?? 'CONTENT_REVIEW_REQUIRED',
    }
  }) as AgentOngoingRowView[]

  // Bounded server pagination only: when `items` is present (even empty), use it.
  // Never fall back to full `runs` when the page is honestly empty.
  // Server page order (paginateDesc) — do not re-sort stalled client-side.
  const runSource = Array.isArray(d.items) ? d.items : d.runs
  const runs: AgentRunRowView[] = runSource.map((r) => ({
    runId: r.runId,
    taskId: r.taskId,
    agentId: r.agentId,
    role: r.role,
    model: r.model,
    effort: r.effort,
    maskedAccount: safeMaskedAccountDisplay(r.maskedAccount),
    status: r.status,
    startedAt: r.startedAt,
    heartbeatAt: r.heartbeatAt,
    materialProgressAt: r.materialProgressAt,
    productiveSubstate: r.productiveSubstate,
    taskHref: r.taskId ? taskDetailHref(boardId, r.taskId) : null,
    // Durable ownership fields from RunUiSummary — null/empty when absent.
    claimState: asNullableString(r.claimState),
    lockIds: asServerStringList(r.lockIds),
    controllerRunId: asNullableString(r.controllerRunId),
    parentRunId: asNullableString(r.parentRunId),
  }))

  return {
    surfaceState,
    boardId,
    ongoing,
    runs,
    pageSize: d.pageSize,
    nextCursor: envelope.nextCursor,
    pin: pinView(envelope),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
    projectionGaps: [
      'run-row relative ages not on RunUiSummary (timestamps only; ages on ongoing rows)',
      'evidence link not on RunUiSummary (present on ongoing when server provides it)',
    ],
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
    onNextPage: opts.onNextPage,
  }
}

// ---------------------------------------------------------------------------
// Ops / Accounts
// ---------------------------------------------------------------------------

/** Map status/quarantine into honest audit chips — never invent LIMIT/tombstone. */
export function opsAccountAuditFlags(row: {
  status: string | null
  quarantine: boolean
}): {
  isLimit: boolean
  isQuarantine: boolean
  isTombstone: boolean
  statusLabel: string
} {
  const status = (row.status ?? '').toUpperCase()
  const isQuarantine =
    row.quarantine || status === 'QUARANTINED' || status === 'QUARANTINE'
  const isTombstone =
    status === 'REMOVED' || status === 'TOMBSTONE' || status === 'DELETED'
  const isLimit =
    status === 'LIMIT' ||
    status === 'LIMITED' ||
    status === 'RATE_LIMITED' ||
    status === 'CAP_HIT'
  return {
    isLimit,
    isQuarantine,
    isTombstone,
    statusLabel: row.status ?? (isQuarantine ? 'QUARANTINED' : '—'),
  }
}

export function opsEnvelopeToProps(
  envelope: PinnedEnvelope<OpsData | null> | null | undefined,
  opts: {
    transport?: 'online' | 'offline' | 'unknown'
    onRetry?: () => void
    onRefresh?: () => void
  } = {},
): OpsScreenProps {
  const surfaceState = asSurface(
    envelope as PinnedEnvelope<unknown> | null | undefined,
    opts.transport,
  )

  if (!envelope || !envelope.data) {
    return {
      surfaceState,
      boardId: envelope?.boardId ?? '',
      accounts: [],
      usableCapacity: null,
      quarantineCount: null,
      accountSyncStale: false,
      capacityNote: null,
      accountSourceRevision: null,
      pin: pinAttrsFromEnvelope(envelope as PinnedEnvelope<unknown> | null | undefined),
      error: envelope?.error
        ? { code: envelope.error.code, message: envelope.error.message }
        : surfaceState === 'loading'
          ? null
          : { code: 'NO_DATA', message: 'Ops data unavailable' },
      projectionGaps: [],
      onRetry: opts.onRetry,
      onRefresh: opts.onRefresh,
    }
  }

  const d = envelope.data
  const accounts: OpsAccountRowView[] = d.accounts.map((a) => {
    const flags = opsAccountAuditFlags(a)
    return {
      maskedAccountId: safeMaskedAccountDisplay(a.maskedAccountId),
      status: flags.statusLabel,
      providerKind: a.providerKind,
      effectiveInUse: a.effectiveInUse,
      effectiveCap: a.effectiveCap,
      physicalSlotsDisplay: a.physicalSlotsDisplay,
      quarantine: flags.isQuarantine,
      isLimit: flags.isLimit,
      isTombstone: flags.isTombstone,
      reason: a.reason,
      capacityLabel: `${a.effectiveInUse}/${a.effectiveCap}`,
    }
  })

  // Map server OpsData.sourceRevision only — never substitute boardRev.
  const accountSourceRevision =
    typeof d.sourceRevision === 'number' && Number.isFinite(d.sourceRevision)
      ? d.sourceRevision
      : null

  return {
    surfaceState,
    boardId: envelope.boardId,
    accounts,
    usableCapacity: d.usableCapacity,
    quarantineCount: d.quarantineCount,
    accountSyncStale: d.accountSyncStale,
    capacityNote: d.capacityNote,
    accountSourceRevision,
    pin: pinView(envelope),
    error: envelope.error
      ? { code: envelope.error.code, message: envelope.error.message }
      : null,
    projectionGaps: [
      'per-account last-sync timestamp not on AccountUiSummary',
      accountSourceRevision == null
        ? 'account sourceRevision absent when OpsData.sourceRevision not projected (never invent from boardRev)'
        : null,
      'capacityNote currently null from projector unless server populates it',
    ].filter((g): g is string => Boolean(g)),
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
  }
}

// ---------------------------------------------------------------------------
// Knowledge domain — conflict / redaction presentation (ART S21 / 01A states)
// Presentation-only. Never invents sources, never silently picks a winner.
// Knowledge states: PROVEN | UNKNOWN | CONFLICT | STALE
// ---------------------------------------------------------------------------

/** 01A knowledge fact state — fail closed on conflict/unknown/stale. */
export type KnowledgeFactState = 'PROVEN' | 'UNKNOWN' | 'CONFLICT' | 'STALE'

export type KnowledgeConflictSourceView = {
  sourceId: string
  label: string
  citation: string | null
  claim: string | null
}

export type KnowledgeRedactionView = {
  fieldPath: string
  reason: string
  /** Human scope that is hidden (RBAC / policy), never the secret value. */
  hiddenScope: string
}

export type KnowledgeConflictPanelModel = {
  knowledgeState: KnowledgeFactState
  /** CONFLICT always blocks certainty; STALE/UNKNOWN also block proven claims. */
  certaintyBlocked: boolean
  headline: string
  detail: string
  sources: KnowledgeConflictSourceView[]
  redactions: KnowledgeRedactionView[]
  staleReason: string | null
  lastValidGeneratedAt: string | null
  gaps: string[]
  domain: string
  /** Render panel when non-PROVEN or any redaction disclosure is present. */
  visible: boolean
}

const KNOWLEDGE_STATES: ReadonlySet<string> = new Set([
  'PROVEN',
  'UNKNOWN',
  'CONFLICT',
  'STALE',
])

function asKnowledgeState(value: unknown): KnowledgeFactState | null {
  if (typeof value !== 'string') return null
  const u = value.trim().toUpperCase()
  return KNOWLEDGE_STATES.has(u) ? (u as KnowledgeFactState) : null
}

/**
 * Pass-through parse of server conflict sources — empty when absent/malformed.
 * Never synthesizes a second source to force CONFLICT.
 */
export function knowledgeConflictSourcesFromRaw(
  raw: unknown,
): KnowledgeConflictSourceView[] {
  if (!raw || typeof raw !== 'object') return []
  const rec = raw as Record<string, unknown>
  const list = Array.isArray(rec.conflicts)
    ? rec.conflicts
    : Array.isArray(rec.conflictSources)
      ? rec.conflictSources
      : Array.isArray(raw)
        ? raw
        : null
  if (!list) return []
  const out: KnowledgeConflictSourceView[] = []
  for (let i = 0; i < list.length; i++) {
    const item = list[i]
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const sourceId =
      asNullableString(r.sourceId) ??
      asNullableString(r.id) ??
      asNullableString(r.citation) ??
      `source-${i + 1}`
    const label =
      asNullableString(r.label) ??
      asNullableString(r.name) ??
      asNullableString(r.source) ??
      sourceId
    out.push({
      sourceId,
      label,
      citation: asNullableString(r.citation) ?? asNullableString(r.anchor) ?? null,
      claim:
        asNullableString(r.claim) ??
        asNullableString(r.value) ??
        asNullableString(r.summary) ??
        null,
    })
  }
  return out
}

/**
 * Pass-through parse of server redaction disclosures — empty when absent.
 * Never invents hidden fields.
 */
export function knowledgeRedactionsFromRaw(raw: unknown): KnowledgeRedactionView[] {
  if (!raw || typeof raw !== 'object') return []
  const rec = raw as Record<string, unknown>
  const list = Array.isArray(rec.redactions)
    ? rec.redactions
    : Array.isArray(raw)
      ? raw
      : null
  if (!list) return []
  const out: KnowledgeRedactionView[] = []
  for (const item of list) {
    if (!item || typeof item !== 'object') continue
    const r = item as Record<string, unknown>
    const fieldPath =
      asNullableString(r.fieldPath) ??
      asNullableString(r.field) ??
      asNullableString(r.path) ??
      null
    if (!fieldPath) continue
    out.push({
      fieldPath,
      reason:
        asNullableString(r.reason) ??
        asNullableString(r.policy) ??
        'REDACTED',
      hiddenScope:
        asNullableString(r.hiddenScope) ??
        asNullableString(r.scope) ??
        asNullableString(r.note) ??
        fieldPath,
    })
  }
  return out
}

/** Gap tokens that declare an explicit multi-source conflict (server honesty). */
function gapsDeclareConflict(gaps: readonly string[]): boolean {
  return gaps.some((g) => {
    const u = g.toUpperCase()
    return (
      u === 'CONFLICT' ||
      u.includes('SOURCE_CONFLICT') ||
      u.includes('KNOWLEDGE_CONFLICT') ||
      u.startsWith('CONFLICT_') ||
      u.includes('_CONFLICT')
    )
  })
}

/** Gap tokens that declare redacted scope without a structured redactions array. */
export function knowledgeRedactionsFromGaps(
  gaps: readonly string[],
): KnowledgeRedactionView[] {
  const out: KnowledgeRedactionView[] = []
  for (const g of gaps) {
    const u = g.toUpperCase()
    if (!(u.includes('REDACT') || u.startsWith('REDACTED') || u.includes('RBAC_HIDDEN'))) {
      continue
    }
    out.push({
      fieldPath: g,
      reason: 'GAP_DECLARED_REDACTION',
      hiddenScope: g,
    })
  }
  return out
}

/**
 * Resolve ART S21 knowledge conflict/redaction presentation from pin + honesty gaps.
 * Priority (fail closed): explicit CONFLICT → STALE pin → UNKNOWN (gaps/partial/unavailable)
 * → PROVEN only when available, not stale, no conflict sources, no unknown gaps.
 */
export function resolveKnowledgeConflictView(args: {
  domain: string
  availability: 'available' | 'partial' | 'unavailable'
  surfaceState?: string | null
  gaps?: readonly string[] | null
  pin?: {
    stale: boolean
    staleReason: string | null
    generatedAt?: string | null
    boardRev?: number
    lifecycleRev?: number
    canonicalSnapshotId?: string
    canonicalHash?: string
  } | null
  sources?: readonly KnowledgeConflictSourceView[] | null
  redactions?: readonly KnowledgeRedactionView[] | null
  /** Server override when projected; ignored if invalid. */
  knowledgeState?: string | null
  lastValidGeneratedAt?: string | null
}): KnowledgeConflictPanelModel {
  const domain = args.domain.trim() || 'UNKNOWN_DOMAIN'
  const gaps = Array.isArray(args.gaps)
    ? args.gaps.filter((g): g is string => typeof g === 'string' && g.length > 0)
    : []
  const sources = Array.isArray(args.sources) ? [...args.sources] : []
  const redactionsFromArgs = Array.isArray(args.redactions) ? [...args.redactions] : []
  const redactionsFromGaps = knowledgeRedactionsFromGaps(gaps)
  // Prefer structured redactions; gap-derived only fills when none provided.
  const redactions =
    redactionsFromArgs.length > 0 ? redactionsFromArgs : redactionsFromGaps

  const pinStale = Boolean(args.pin?.stale)
  const surfaceStale = (args.surfaceState ?? '').toLowerCase() === 'stale'
  const staleReason =
    args.pin?.staleReason ??
    (surfaceStale ? 'SURFACE_STALE' : null)
  const lastValidGeneratedAt =
    asNullableString(args.lastValidGeneratedAt) ??
    asNullableString(args.pin?.generatedAt) ??
    null

  const explicitState = asKnowledgeState(args.knowledgeState)
  const multiSourceConflict = sources.length >= 2
  const gapConflict = gapsDeclareConflict(gaps)

  let knowledgeState: KnowledgeFactState
  if (explicitState === 'CONFLICT' || multiSourceConflict || gapConflict) {
    knowledgeState = 'CONFLICT'
  } else if (explicitState === 'STALE' || pinStale || surfaceStale) {
    knowledgeState = 'STALE'
  } else if (
    explicitState === 'UNKNOWN' ||
    args.availability === 'unavailable' ||
    args.availability === 'partial' ||
    gaps.length > 0
  ) {
    knowledgeState = 'UNKNOWN'
  } else if (explicitState === 'PROVEN') {
    knowledgeState = 'PROVEN'
  } else if (args.availability === 'available' && gaps.length === 0 && !pinStale) {
    knowledgeState = 'PROVEN'
  } else {
    knowledgeState = 'UNKNOWN'
  }

  const certaintyBlocked = knowledgeState !== 'PROVEN'

  let headline: string
  let detail: string
  switch (knowledgeState) {
    case 'CONFLICT':
      headline = 'Konflik sumber pengetahuan'
      detail =
        sources.length >= 2
          ? 'Dua atau lebih sumber disajikan tanpa memilih pemenang. Kepastian diblokir sampai rekonsiliasi.'
          : 'Konflik pengetahuan dilaporkan. Kepastian diblokir — tidak memilih sumber diam-diam.'
      break
    case 'STALE':
      headline = 'Pengetahuan domain basi (STALE)'
      detail =
        'Pin/revisi sudah usang. Jangan anggap fakta domain masih PROVEN; muat ulang/rekonsiliasi pin.'
      break
    case 'UNKNOWN':
      headline = 'Pengetahuan domain tidak terbukti (UNKNOWN)'
      detail =
        args.availability === 'unavailable'
          ? 'Tidak ada data domain ter-pin. Gap eksplisit — bukan kesiapan palsu.'
          : 'Ada gap atau cakupan parsial. Unknown menjadi gap eksplisit, bukan tebakan.'
      break
    case 'PROVEN':
    default:
      headline = 'Pengetahuan domain terbukti (PROVEN)'
      detail =
        redactions.length > 0
          ? 'Fakta terbukti dari pin saat ini; sebagian lingkup disembunyikan (redaction).'
          : 'Fakta domain tersedia dari pin saat ini tanpa konflik/stale yang dilaporkan.'
      break
  }

  const visible = knowledgeState !== 'PROVEN' || redactions.length > 0

  return {
    knowledgeState,
    certaintyBlocked,
    headline,
    detail,
    sources,
    redactions,
    staleReason: knowledgeState === 'STALE' ? staleReason : knowledgeState === 'CONFLICT' && pinStale ? staleReason : null,
    lastValidGeneratedAt,
    gaps,
    domain,
    visible,
  }
}
