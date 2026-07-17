/**
 * C3-F1: Client query wiring for control-center pinned envelopes.
 *
 * Rules (UI_CONTRACT §12 / API_CONTRACT §3):
 * - Query keys are boardId + surface + filter + pin revision only.
 * - Fetcher is injectable (server fn wired by later C3-W* packets).
 * - Client NEVER recomputes readiness, buckets, G5, NEXT, priority majority,
 *   denominators, or STALE membership — only formats ages / UI expand state.
 * - Filter params are constructed here; server re-validates.
 */

import { queryOptions } from '@tanstack/react-query'

import type {
  AgentsData,
  ControlCenterSurface,
  DecisionsData,
  EvidenceData,
  FeaturesData,
  OpsData,
  OverviewData,
  PinnedEnvelope,
  PriorityData,
  ProjectsData,
  UiSurfaceState,
  WorkData,
} from '#/server/control-center-ui'
import type { PrimaryBucket, StaleOverlayKind } from '#/lib/control-plane-types'

// ---------------------------------------------------------------------------
// Control-center board IA (client-safe)
// ---------------------------------------------------------------------------

/** Boards that force the nine primary control-center IA destinations. */
export const CONTROL_CENTER_BOARD_IDS = new Set(['mfs-rebuild'] as const)

export function isControlCenterBoard(boardId: string): boolean {
  return CONTROL_CENTER_BOARD_IDS.has(boardId as 'mfs-rebuild')
}

/** Nine primary IA destinations (UI_CONTRACT §2). */
export const CONTROL_CENTER_PRIMARY_NAV_IDS = [
  'overview',
  'work',
  'priority',
  'projects',
  'features',
  'agents',
  'ops',
  'decisions',
  'evidence',
] as const

export type ControlCenterPrimaryNavId = (typeof CONTROL_CENTER_PRIMARY_NAV_IDS)[number]

// ---------------------------------------------------------------------------
// Query keys (stable, board-scoped)
// ---------------------------------------------------------------------------

export const controlCenterQueryRoot = ['control-center'] as const

export type ControlCenterQueryKey =
  | readonly ['control-center', 'overview', string]
  | readonly ['control-center', 'work', string, WorkFilterKey]
  | readonly ['control-center', 'priority', string]
  | readonly ['control-center', 'projects', string]
  | readonly ['control-center', 'features', string, CursorKey]
  | readonly ['control-center', 'agents', string, CursorKey]
  | readonly ['control-center', 'ops', string]
  | readonly ['control-center', 'decisions', string, CursorKey]
  | readonly ['control-center', 'evidence', string, CursorKey]

export interface WorkFilterKey {
  bucket: PrimaryBucket | null
  overlay: StaleOverlayKind | null
  staleFamily: boolean | null
  cursor: string | null
  pageSize: number | null
}

export interface CursorKey {
  cursor: string | null
  pageSize: number | null
}

export function overviewQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'overview', boardId]
}

export function workQueryKey(boardId: string, filter: Partial<WorkFilterKey> = {}): ControlCenterQueryKey {
  return [
    'control-center',
    'work',
    boardId,
    {
      bucket: filter.bucket ?? null,
      overlay: filter.overlay ?? null,
      staleFamily: filter.staleFamily ?? null,
      cursor: filter.cursor ?? null,
      pageSize: filter.pageSize ?? null,
    },
  ]
}

export function priorityQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'priority', boardId]
}

export function projectsQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'projects', boardId]
}

export function featuresQueryKey(boardId: string, cursor: Partial<CursorKey> = {}): ControlCenterQueryKey {
  return [
    'control-center',
    'features',
    boardId,
    { cursor: cursor.cursor ?? null, pageSize: cursor.pageSize ?? null },
  ]
}

export function agentsQueryKey(boardId: string, cursor: Partial<CursorKey> = {}): ControlCenterQueryKey {
  return [
    'control-center',
    'agents',
    boardId,
    { cursor: cursor.cursor ?? null, pageSize: cursor.pageSize ?? null },
  ]
}

export function opsQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'ops', boardId]
}

export function decisionsQueryKey(boardId: string, cursor: Partial<CursorKey> = {}): ControlCenterQueryKey {
  return [
    'control-center',
    'decisions',
    boardId,
    { cursor: cursor.cursor ?? null, pageSize: cursor.pageSize ?? null },
  ]
}

export function evidenceQueryKey(boardId: string, cursor: Partial<CursorKey> = {}): ControlCenterQueryKey {
  return [
    'control-center',
    'evidence',
    boardId,
    { cursor: cursor.cursor ?? null, pageSize: cursor.pageSize ?? null },
  ]
}

// ---------------------------------------------------------------------------
// Fetcher contracts (injectable — no formulas)
// ---------------------------------------------------------------------------

export type ControlCenterFetcher<T> = (args: {
  boardId: string
  cursor?: string | null
  pageSize?: number | null
  bucket?: PrimaryBucket | null
  overlay?: StaleOverlayKind | null
  staleFamily?: boolean | null
}) => Promise<PinnedEnvelope<T>>

export interface ControlCenterFetchers {
  overview: ControlCenterFetcher<OverviewData>
  work: ControlCenterFetcher<WorkData>
  priority: ControlCenterFetcher<PriorityData>
  projects: ControlCenterFetcher<ProjectsData>
  features: ControlCenterFetcher<FeaturesData>
  agents: ControlCenterFetcher<AgentsData>
  ops: ControlCenterFetcher<OpsData>
  decisions: ControlCenterFetcher<DecisionsData>
  evidence: ControlCenterFetcher<EvidenceData>
}

const DEFAULT_STALE_TIME_MS = 5_000

export function overviewQueryOptions(
  boardId: string,
  fetch: ControlCenterFetcher<OverviewData>,
) {
  return queryOptions({
    queryKey: overviewQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function workQueryOptions(
  boardId: string,
  filter: Partial<WorkFilterKey>,
  fetch: ControlCenterFetcher<WorkData>,
) {
  const normalized: WorkFilterKey = {
    bucket: filter.bucket ?? null,
    overlay: filter.overlay ?? null,
    staleFamily: filter.staleFamily ?? null,
    cursor: filter.cursor ?? null,
    pageSize: filter.pageSize ?? null,
  }
  return queryOptions({
    queryKey: workQueryKey(boardId, normalized),
    queryFn: () =>
      fetch({
        boardId,
        bucket: normalized.bucket,
        overlay: normalized.overlay,
        staleFamily: normalized.staleFamily,
        cursor: normalized.cursor,
        pageSize: normalized.pageSize,
      }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function priorityQueryOptions(
  boardId: string,
  fetch: ControlCenterFetcher<PriorityData>,
) {
  return queryOptions({
    queryKey: priorityQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function projectsQueryOptions(
  boardId: string,
  fetch: ControlCenterFetcher<ProjectsData>,
) {
  return queryOptions({
    queryKey: projectsQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function featuresQueryOptions(
  boardId: string,
  cursor: Partial<CursorKey>,
  fetch: ControlCenterFetcher<FeaturesData>,
) {
  return queryOptions({
    queryKey: featuresQueryKey(boardId, cursor),
    queryFn: () =>
      fetch({
        boardId,
        cursor: cursor.cursor ?? null,
        pageSize: cursor.pageSize ?? null,
      }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function agentsQueryOptions(
  boardId: string,
  cursor: Partial<CursorKey>,
  fetch: ControlCenterFetcher<AgentsData>,
) {
  return queryOptions({
    queryKey: agentsQueryKey(boardId, cursor),
    queryFn: () =>
      fetch({
        boardId,
        cursor: cursor.cursor ?? null,
        pageSize: cursor.pageSize ?? null,
      }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function opsQueryOptions(
  boardId: string,
  fetch: ControlCenterFetcher<OpsData>,
) {
  return queryOptions({
    queryKey: opsQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function decisionsQueryOptions(
  boardId: string,
  cursor: Partial<CursorKey>,
  fetch: ControlCenterFetcher<DecisionsData>,
) {
  return queryOptions({
    queryKey: decisionsQueryKey(boardId, cursor),
    queryFn: () =>
      fetch({
        boardId,
        cursor: cursor.cursor ?? null,
        pageSize: cursor.pageSize ?? null,
      }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function evidenceQueryOptions(
  boardId: string,
  cursor: Partial<CursorKey>,
  fetch: ControlCenterFetcher<EvidenceData>,
) {
  return queryOptions({
    queryKey: evidenceQueryKey(boardId, cursor),
    queryFn: () =>
      fetch({
        boardId,
        cursor: cursor.cursor ?? null,
        pageSize: cursor.pageSize ?? null,
      }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

// ---------------------------------------------------------------------------
// Presentation-only helpers (allowed client work)
// ---------------------------------------------------------------------------

/** Format server age seconds for display — does not recompute truth. */
export function formatAgeSeconds(ageSeconds: number | null | undefined): string {
  if (ageSeconds == null || !Number.isFinite(ageSeconds)) return '—'
  if (ageSeconds < 60) return `${ageSeconds}s`
  if (ageSeconds < 3600) return `${Math.floor(ageSeconds / 60)}m`
  if (ageSeconds < 86400) return `${Math.floor(ageSeconds / 3600)}h`
  return `${Math.floor(ageSeconds / 86400)}d`
}

/** Map envelope flags → UI surface state without inventing data. */
export function resolveClientSurfaceState(
  envelope: PinnedEnvelope<unknown> | null | undefined,
  transport: 'online' | 'offline' | 'unknown' = 'online',
): UiSurfaceState {
  if (transport === 'offline') return 'disconnected'
  if (!envelope) return 'loading'
  if (envelope.error?.code === 'FORBIDDEN') return 'forbidden'
  if (envelope.error) return 'error'
  if (envelope.stale) return 'stale'
  return envelope.surfaceState
}

/** Deep-link filter construction — server re-validates. */
export function buildWorkDeepLink(opts: {
  boardId: string
  bucket?: PrimaryBucket | null
  overlay?: StaleOverlayKind | null
  cursor?: string | null
  boardRev?: number | null
  canonicalSnapshotId?: string | null
}): string {
  const params = new URLSearchParams()
  if (opts.bucket) params.set('bucket', opts.bucket)
  if (opts.overlay) params.set('overlay', opts.overlay)
  if (opts.cursor) params.set('cursor', opts.cursor)
  if (opts.boardRev != null) params.set('boardRev', String(opts.boardRev))
  if (opts.canonicalSnapshotId) params.set('pin', opts.canonicalSnapshotId)
  const q = params.toString()
  return `/b/${encodeURIComponent(opts.boardId)}/work${q ? `?${q}` : ''}`
}

/**
 * Guard: reject client-side attempts to invent majority PASS.
 * UI must display server `majorityAllocationDisplay` only.
 */
export function majorityDisplayFromEnvelope(
  envelope: PinnedEnvelope<PriorityData> | null | undefined,
): 'true' | 'false' | 'N-A' | null {
  if (!envelope?.data) return null
  return envelope.data.majorityAllocationDisplay
}

/** Cast wire envelope from server fn → typed PinnedEnvelope (presentation only). */
function asPinned<T>(wire: unknown): PinnedEnvelope<T> {
  return wire as PinnedEnvelope<T>
}

/** Wire default authenticated fetchers (TanStack Start server fns). */
export function createDefaultControlCenterFetchers(): ControlCenterFetchers {
  // Lazy import binding kept dynamic-call shape so tests can inject mocks instead.
  return {
    overview: async ({ boardId }) => {
      const { getControlCenterOverviewFn } = await import('#/server/control-center-ui-fns')
      const { attachAdaptiveMappingToEnvelope } = await import('#/lib/mapping-envelope-attach')
      const envelope = asPinned<OverviewData>(
        await getControlCenterOverviewFn({ data: { boardId } }),
      )
      try {
        const { loadBoardAdaptiveMappingSurface } = await import(
          '#/server/mapping-version-loader'
        )
        const surface = await loadBoardAdaptiveMappingSurface(boardId)
        return attachAdaptiveMappingToEnvelope(envelope, surface.mappingVersion)
      } catch {
        return envelope
      }
    },
    work: async ({ boardId, bucket, overlay, staleFamily, cursor, pageSize }) => {
      const { getControlCenterWorkFn } = await import('#/server/control-center-ui-fns')
      return asPinned<WorkData>(
        await getControlCenterWorkFn({
          data: {
            boardId,
            bucket: bucket ?? null,
            overlay: overlay ?? null,
            staleFamily: staleFamily ?? null,
            cursor: cursor ?? null,
            pageSize: pageSize ?? null,
          },
        }),
      )
    },
    priority: async ({ boardId }) => {
      const { getControlCenterPriorityFn } = await import('#/server/control-center-ui-fns')
      return asPinned<PriorityData>(
        await getControlCenterPriorityFn({ data: { boardId } }),
      )
    },
    projects: async ({ boardId }) => {
      const { getControlCenterProjectsFn } = await import('#/server/control-center-ui-fns')
      return asPinned<ProjectsData>(
        await getControlCenterProjectsFn({ data: { boardId } }),
      )
    },
    features: async ({ boardId, cursor, pageSize }) => {
      const { getControlCenterFeaturesFn } = await import('#/server/control-center-ui-fns')
      return asPinned<FeaturesData>(
        await getControlCenterFeaturesFn({
          data: { boardId, cursor: cursor ?? null, pageSize: pageSize ?? null },
        }),
      )
    },
    agents: async ({ boardId, cursor, pageSize }) => {
      const { getControlCenterAgentsFn } = await import('#/server/control-center-ui-fns')
      return asPinned<AgentsData>(
        await getControlCenterAgentsFn({
          data: { boardId, cursor: cursor ?? null, pageSize: pageSize ?? null },
        }),
      )
    },
    ops: async ({ boardId }) => {
      const { getControlCenterOpsFn } = await import('#/server/control-center-ui-fns')
      return asPinned<OpsData>(await getControlCenterOpsFn({ data: { boardId } }))
    },
    decisions: async ({ boardId, cursor, pageSize }) => {
      const { getControlCenterDecisionsFn } = await import('#/server/control-center-ui-fns')
      return asPinned<DecisionsData>(
        await getControlCenterDecisionsFn({
          data: { boardId, cursor: cursor ?? null, pageSize: pageSize ?? null },
        }),
      )
    },
    evidence: async ({ boardId, cursor, pageSize }) => {
      const { getControlCenterEvidenceFn } = await import('#/server/control-center-ui-fns')
      return asPinned<EvidenceData>(
        await getControlCenterEvidenceFn({
          data: { boardId, cursor: cursor ?? null, pageSize: pageSize ?? null },
        }),
      )
    },
  }
}

let defaultFetchers: ControlCenterFetchers | null = null

export function getDefaultControlCenterFetchers(): ControlCenterFetchers {
  if (!defaultFetchers) defaultFetchers = createDefaultControlCenterFetchers()
  return defaultFetchers
}

/** Test/support: replace default fetchers (does not recompute truth). */
export function setDefaultControlCenterFetchers(f: ControlCenterFetchers | null): void {
  defaultFetchers = f
}

export type {
  ControlCenterSurface,
  OverviewData,
  WorkData,
  PriorityData,
  ProjectsData,
  FeaturesData,
  AgentsData,
  OpsData,
  DecisionsData,
  EvidenceData,
  PinnedEnvelope,
  UiSurfaceState,
}
