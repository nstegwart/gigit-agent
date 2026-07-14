/**
 * Public (unauthenticated) features surface helpers.
 * Fetches allowlisted /api/public-snapshot and maps to Feature* view models.
 * Never invents progress nodes — only projects server-emitted fields.
 */

import type {
  FeatureProgressNodeView,
  FeatureRowView,
  FeaturesPinView,
} from '#/components/control-center/features/types'

export const DEFAULT_PUBLIC_BOARD_ID = 'mfs-rebuild'

export interface PublicSnapshotFeatureNode {
  taskId?: string | null
  title?: string | null
  lifecycleStage?: string | null
  status?: string | null
  technicalTitle?: string | null
  contentReviewRequired?: boolean | null
}

export interface PublicSnapshotFeature {
  id?: string | null
  projectId?: string | null
  name?: string | null
  phase?: string | null
  taskCount?: number | null
  stageCounts?: Record<string, number> | null
  progressNodes?: ReadonlyArray<PublicSnapshotFeatureNode> | null
}

export interface PublicSnapshotPayload {
  boardId?: string | null
  pin?: {
    boardId?: string | null
    canonicalSnapshotId?: string | null
    canonicalHash?: string | null
    boardRev?: number | null
    lifecycleRev?: number | null
    generatedAt?: string | null
  } | null
  freshness?: {
    generatedAt?: string | null
    ageMs?: number | null
    stale?: boolean | null
  } | null
  features?: ReadonlyArray<PublicSnapshotFeature> | null
}

export function publicFeaturesListHref(boardId: string = DEFAULT_PUBLIC_BOARD_ID): string {
  return `/public/features?boardId=${encodeURIComponent(boardId)}`
}

export function publicFeatureDetailHref(
  featureId: string,
  boardId: string = DEFAULT_PUBLIC_BOARD_ID,
): string {
  return `/public/features/${encodeURIComponent(featureId)}?boardId=${encodeURIComponent(boardId)}`
}

export function pinViewFromPublicSnapshot(
  snap: PublicSnapshotPayload | null | undefined,
  boardId: string,
): FeaturesPinView | null {
  if (!snap) return null
  const pin = snap.pin
  const generatedAt =
    (typeof pin?.generatedAt === 'string' && pin.generatedAt) ||
    (typeof snap.freshness?.generatedAt === 'string' && snap.freshness.generatedAt) ||
    new Date(0).toISOString()
  const ageMs =
    typeof snap.freshness?.ageMs === 'number' && Number.isFinite(snap.freshness.ageMs)
      ? Math.max(0, snap.freshness.ageMs)
      : 0
  return {
    boardId: (typeof pin?.boardId === 'string' && pin.boardId) || boardId,
    canonicalSnapshotId:
      (typeof pin?.canonicalSnapshotId === 'string' && pin.canonicalSnapshotId) || '—',
    canonicalHash: (typeof pin?.canonicalHash === 'string' && pin.canonicalHash) || '—',
    boardRev: typeof pin?.boardRev === 'number' ? pin.boardRev : 0,
    lifecycleRev: typeof pin?.lifecycleRev === 'number' ? pin.lifecycleRev : 0,
    generatedAt,
    freshnessAgeSeconds: Math.floor(ageMs / 1000),
    stale: snap.freshness?.stale === true,
    staleReason: snap.freshness?.stale === true ? 'PUBLIC_SNAPSHOT_STALE' : null,
  }
}

function mapProgressNode(
  n: PublicSnapshotFeatureNode,
  boardId: string,
): FeatureProgressNodeView | null {
  if (!n || typeof n.taskId !== 'string' || !n.taskId.trim()) return null
  const taskId = n.taskId.trim()
  return {
    taskId,
    title: (typeof n.title === 'string' && n.title.trim()) || taskId,
    lifecycleStage:
      typeof n.lifecycleStage === 'string' && n.lifecycleStage.trim()
        ? n.lifecycleStage.trim()
        : null,
    status: typeof n.status === 'string' && n.status.trim() ? n.status.trim() : null,
    blockedReason: null,
    technicalTitle:
      typeof n.technicalTitle === 'string' && n.technicalTitle.trim()
        ? n.technicalTitle.trim()
        : null,
    contentReviewRequired: n.contentReviewRequired === true,
    // Public surface has no authenticated work deep-link; keep id as secondary.
    detailHref: publicFeatureDetailHref(taskId, boardId),
  }
}

export function publicFeatureToRowView(
  f: PublicSnapshotFeature,
  boardId: string,
): FeatureRowView | null {
  if (!f || typeof f.id !== 'string' || !f.id.trim()) return null
  const featureId = f.id.trim()
  const progressNodes = Array.isArray(f.progressNodes)
    ? f.progressNodes
        .map((n) => mapProgressNode(n, boardId))
        .filter((n): n is FeatureProgressNodeView => n != null)
    : []
  // Prefer public detail links over board-auth paths.
  const nodesWithPublicHref = progressNodes.map((n) => ({
    ...n,
    detailHref: `#node-${encodeURIComponent(n.taskId)}`,
  }))
  const stageCounts: Record<string, number> = {}
  if (f.stageCounts && typeof f.stageCounts === 'object') {
    for (const [k, v] of Object.entries(f.stageCounts)) {
      if (typeof v === 'number' && Number.isFinite(v) && v > 0) stageCounts[k] = Math.floor(v)
    }
  } else {
    for (const n of nodesWithPublicHref) {
      const stage = n.lifecycleStage ?? 'UNKNOWN'
      stageCounts[stage] = (stageCounts[stage] ?? 0) + 1
    }
  }
  return {
    featureId,
    projectId: typeof f.projectId === 'string' ? f.projectId : null,
    name: (typeof f.name === 'string' && f.name.trim()) || featureId,
    phase: typeof f.phase === 'string' ? f.phase : null,
    flowBranch: null,
    taskCount:
      typeof f.taskCount === 'number' && Number.isFinite(f.taskCount)
        ? Math.max(0, Math.floor(f.taskCount))
        : nodesWithPublicHref.length,
    detailHref: publicFeatureDetailHref(featureId, boardId),
    projectHref: null,
    progressNodes: nodesWithPublicHref,
    stageCounts,
    pageRoutes: [],
    apiEndpoints: [],
    logicRules: [],
    dataContext: [],
    geoVariants: [],
    providerVariants: [],
    sideEffectsReadback: [],
    styleContext: [],
  }
}

export function publicSnapshotToFeatureRows(
  snap: PublicSnapshotPayload | null | undefined,
  boardId: string,
): FeatureRowView[] {
  const features = snap?.features
  if (!Array.isArray(features)) return []
  return features
    .map((f) => publicFeatureToRowView(f, boardId))
    .filter((f): f is FeatureRowView => f != null)
    .sort((a, b) => a.featureId.localeCompare(b.featureId))
}

export async function fetchPublicSnapshot(
  boardId: string,
  fetchImpl: typeof fetch = fetch,
): Promise<{ ok: true; data: PublicSnapshotPayload } | { ok: false; status: number; message: string }> {
  const url = `/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      headers: { Accept: 'application/json' },
      credentials: 'same-origin',
    })
    if (!res.ok) {
      let message = `HTTP ${res.status}`
      try {
        const body = (await res.json()) as { error?: string; message?: string }
        message = body.message || body.error || message
      } catch {
        /* keep status message */
      }
      return { ok: false, status: res.status, message }
    }
    const data = (await res.json()) as PublicSnapshotPayload
    return { ok: true, data }
  } catch (e) {
    return {
      ok: false,
      status: 0,
      message: e instanceof Error ? e.message : String(e),
    }
  }
}
