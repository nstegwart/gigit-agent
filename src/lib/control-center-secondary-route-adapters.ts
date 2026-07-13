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
    projectionGaps: [
      'per-project readiness percent not on ProjectsData (server summary counts only)',
    ],
    onRetry: opts.onRetry,
    onRefresh: opts.onRefresh,
  }
}

// ---------------------------------------------------------------------------
// Features
// ---------------------------------------------------------------------------

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
  // Prefer paginated `items` when present; fall back to full `features` list.
  // Order is server order — never client re-sort.
  const source = d.items?.length ? d.items : d.features
  const features: FeatureRowView[] = source.map((f) => ({
    featureId: f.id,
    projectId: f.projectId,
    name: f.name ?? f.id,
    phase: f.phase,
    flowBranch: f.flowBranch,
    taskCount: f.taskCount,
    detailHref: featureDetailHref(envelope.boardId, f.id),
    projectHref: f.projectId
      ? projectDetailHref(envelope.boardId, f.projectId)
      : null,
  }))

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

  const ongoing: AgentOngoingRowView[] = d.ongoing.map((o) => ({
    taskId: o.taskId,
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
  }))

  // Server page order (paginateDesc) — do not re-sort stalled client-side.
  const runSource = d.items?.length ? d.items : d.runs
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
