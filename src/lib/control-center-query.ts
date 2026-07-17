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
import type {
  Feature360UiData,
  FeatureDirectoryData,
  FeatureDocMdData,
  GroupedSearchData,
  RebuildBlindspotWire,
  RebuildDashboardData,
  TaskLineageData,
} from '#/server/control-center-rebuild-fns'
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
  | readonly ['control-center', 'rebuild', string]
  | readonly ['control-center', 'feature-directory', string]
  | readonly ['control-center', 'feature-360', string, string]
  | readonly ['control-center', 'feature-doc-md', string, string]
  | readonly ['control-center', 'task-lineage', string, string]
  | readonly ['control-center', 'search', string, string]
  | readonly ['control-center', 'grouped-search', string, string]
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

export function rebuildQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'rebuild', boardId]
}

/** W-UI-4 blindspot tracer query key (term-scoped; not a primary surface envelope). */
export function rebuildBlindspotQueryKey(
  boardId: string,
  term: string,
): readonly ['control-center', 'rebuild-blindspot', string, string] {
  return ['control-center', 'rebuild-blindspot', boardId, term.trim()]
}

export function featureDirectoryQueryKey(boardId: string): ControlCenterQueryKey {
  return ['control-center', 'feature-directory', boardId]
}

export function feature360QueryKey(
  boardId: string,
  featureId: string,
): ControlCenterQueryKey {
  return ['control-center', 'feature-360', boardId, featureId]
}

export function featureDocMdQueryKey(
  boardId: string,
  featureContractId: string,
): ControlCenterQueryKey {
  return ['control-center', 'feature-doc-md', boardId, featureContractId]
}

/** Per-task lineage panel (W-UI-3). */
export function taskLineageQueryKey(
  boardId: string,
  taskId: string,
): ControlCenterQueryKey {
  return ['control-center', 'task-lineage', boardId, taskId]
}

/** Pin-flat ART search (existing). */
export function searchQueryKey(
  boardId: string,
  q: string,
): ControlCenterQueryKey {
  return ['control-center', 'search', boardId, q]
}

/** W-UI-5 product/rebuild grouped search (Fitur / Tugas / Dokumen / Unit). */
export function groupedSearchQueryKey(
  boardId: string,
  q: string,
): ControlCenterQueryKey {
  return ['control-center', 'grouped-search', boardId, q]
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

/** Rebuild dashboard fetcher (W-UI-1) — not a pinned envelope; flat dashboard data. */
export type RebuildDashboardFetcher = (args: {
  boardId: string
}) => Promise<RebuildDashboardData>

/** W-UI-4 blindspot tracer fetcher — reuses getControlCenterRebuildBlindspotFn (W-API-1). */
export type RebuildBlindspotFetcher = (args: {
  boardId: string
  term: string
  limit?: number
}) => Promise<RebuildBlindspotWire>

/** Product feature directory (W-UI-2). */
export type FeatureDirectoryFetcher = (args: {
  boardId: string
}) => Promise<FeatureDirectoryData>

/** Product Fitur 360 (W-UI-2). */
export type Feature360Fetcher = (args: {
  boardId: string
  featureId: string
}) => Promise<Feature360UiData>

/** FC doc_md fetch (W-UI-2). */
export type FeatureDocMdFetcher = (args: {
  boardId: string
  featureContractId: string
}) => Promise<FeatureDocMdData>

/** Per-task lineage (W-UI-3). */
export type TaskLineageFetcher = (args: {
  boardId: string
  taskId: string
}) => Promise<TaskLineageData>

/** W-UI-5 grouped global search. */
export type GroupedSearchFetcher = (args: {
  boardId: string
  q: string
}) => Promise<GroupedSearchData>

export interface ControlCenterFetchers {
  overview: ControlCenterFetcher<OverviewData>
  rebuild: RebuildDashboardFetcher
  featureDirectory: FeatureDirectoryFetcher
  feature360: Feature360Fetcher
  featureDocMd: FeatureDocMdFetcher
  taskLineage: TaskLineageFetcher
  groupedSearch: GroupedSearchFetcher
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

export function rebuildQueryOptions(
  boardId: string,
  fetch: RebuildDashboardFetcher,
) {
  return queryOptions({
    queryKey: rebuildQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

/** W-UI-4 — term-scoped blindspot trace (enabled only when term non-empty). */
export function rebuildBlindspotQueryOptions(
  boardId: string,
  term: string,
  fetch: RebuildBlindspotFetcher,
  limit?: number,
) {
  const trimmed = term.trim()
  return queryOptions({
    queryKey: rebuildBlindspotQueryKey(boardId, trimmed),
    queryFn: () => fetch({ boardId, term: trimmed, limit }),
    staleTime: DEFAULT_STALE_TIME_MS,
    enabled: trimmed.length > 0,
  })
}

/** Default authenticated blindspot fetcher (server fn). */
export async function fetchRebuildBlindspot(args: {
  boardId: string
  term: string
  limit?: number
}): Promise<RebuildBlindspotWire> {
  const { getControlCenterRebuildBlindspotFn } = await import(
    '#/server/control-center-rebuild-fns'
  )
  return (await getControlCenterRebuildBlindspotFn({
    data: {
      boardId: args.boardId,
      term: args.term,
      limit: args.limit,
    },
  })) as RebuildBlindspotWire
}

export function featureDirectoryQueryOptions(
  boardId: string,
  fetch: FeatureDirectoryFetcher,
) {
  return queryOptions({
    queryKey: featureDirectoryQueryKey(boardId),
    queryFn: () => fetch({ boardId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function feature360QueryOptions(
  boardId: string,
  featureId: string,
  fetch: Feature360Fetcher,
) {
  return queryOptions({
    queryKey: feature360QueryKey(boardId, featureId),
    queryFn: () => fetch({ boardId, featureId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function groupedSearchQueryOptions(
  boardId: string,
  q: string,
  fetch: GroupedSearchFetcher,
) {
  return queryOptions({
    queryKey: groupedSearchQueryKey(boardId, q),
    queryFn: () => fetch({ boardId, q }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function featureDocMdQueryOptions(
  boardId: string,
  featureContractId: string,
  fetch: FeatureDocMdFetcher,
) {
  return queryOptions({
    queryKey: featureDocMdQueryKey(boardId, featureContractId),
    queryFn: () => fetch({ boardId, featureContractId }),
    staleTime: DEFAULT_STALE_TIME_MS,
  })
}

export function taskLineageQueryOptions(
  boardId: string,
  taskId: string,
  fetch: TaskLineageFetcher,
) {
  return queryOptions({
    queryKey: taskLineageQueryKey(boardId, taskId),
    queryFn: () => fetch({ boardId, taskId }),
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
      const envelope = asPinned<OverviewData>(
        await getControlCenterOverviewFn({ data: { boardId } }),
      )
      // mapping-version-loader → db/mysql2. Never pull it into the client graph.
      // Vite replaces import.meta.env.SSR=false on client and DCE's this branch.
      if (!import.meta.env.SSR) {
        return envelope
      }
      try {
        const { attachAdaptiveMappingToEnvelope } = await import(
          '#/lib/mapping-envelope-attach'
        )
        const { loadBoardAdaptiveMappingSurface } = await import(
          '#/server/mapping-version-loader'
        )
        const surface = await loadBoardAdaptiveMappingSurface(boardId)
        return attachAdaptiveMappingToEnvelope(envelope, surface.mappingVersion)
      } catch {
        return envelope
      }
    },
    rebuild: async ({ boardId }) => {
      const { getControlCenterRebuildFn } = await import('#/server/control-center-rebuild-fns')
      return (await getControlCenterRebuildFn({ data: { boardId } })) as RebuildDashboardData
    },
    featureDirectory: async ({ boardId }) => {
      const { getControlCenterFeatureDirectoryFn } = await import(
        '#/server/control-center-rebuild-fns'
      )
      return (await getControlCenterFeatureDirectoryFn({
        data: { boardId },
      })) as FeatureDirectoryData
    },
    feature360: async ({ boardId, featureId }) => {
      const { getControlCenterFeature360Fn } = await import(
        '#/server/control-center-rebuild-fns'
      )
      return (await getControlCenterFeature360Fn({
        data: { boardId, featureId },
      })) as Feature360UiData
    },
    featureDocMd: async ({ boardId, featureContractId }) => {
      const { getControlCenterFeatureDocMdFn } = await import(
        '#/server/control-center-rebuild-fns'
      )
      return (await getControlCenterFeatureDocMdFn({
        data: { boardId, featureContractId },
      })) as FeatureDocMdData
    },
    taskLineage: async ({ boardId, taskId }) => {
      const { getTaskLineageFn } = await import('#/server/control-center-rebuild-fns')
      return (await getTaskLineageFn({
        data: { boardId, taskId },
      })) as TaskLineageData
    },
    groupedSearch: async ({ boardId, q }) => {
      const { getControlCenterGroupedSearchFn } = await import(
        '#/server/control-center-rebuild-fns'
      )
      return (await getControlCenterGroupedSearchFn({
        data: { boardId, q },
      })) as GroupedSearchData
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

export type {
  RebuildDashboardData,
  RebuildBlindspotWire,
  FeatureDirectoryData,
  Feature360UiData,
  FeatureDocMdData,
  GroupedSearchData,
  TaskLineageData,
}
