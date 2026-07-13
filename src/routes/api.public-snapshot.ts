/**
 * Public GET /api/public-snapshot (AC-PUBLIC-*, AC-AUTH-05).
 * Allowlisted materialized snapshot only; rate limited; ETag/304.
 * C2A: installs pinned aggregation loader from same public serializer path.
 * Fail-closed on missing pin / errors — never leaks private data.
 */
import { createFileRoute } from '@tanstack/react-router'
import { createHash } from 'node:crypto'

import {
  PUBLIC_SERIALIZER_VERSION,
  createMemoryPublicSnapshotStore,
  handlePublicSnapshotGet,
  publicSnapshotResultToResponse,
  type PublicAggregationInput,
  type PublicSnapshotDeps,
} from '#/server/public-snapshot'
import {
  createPublicSnapshotRateLimiter,
  resolveClientIp,
} from '#/server/rate-limit'
import { boardHash, listBoards, readBoard, readOps } from '#/server/board-store'
import { computeRollup, readLifecycle } from '#/server/lifecycle-store'
import { readTasks } from '#/server/board-store'
import { buildModel } from '#/lib/model'
import { maskAccountId } from '#/server/public-snapshot'

const defaultStore = createMemoryPublicSnapshotStore()
const defaultLimiter = createPublicSnapshotRateLimiter()

/**
 * Build a pinned public aggregation from board stores.
 * Uses one materialization path (C2C serializer) — never recomputes private fields into payload.
 * Returns null on any failure (fail-closed 503).
 */
export async function loadPublicAggregation(boardId: string): Promise<PublicAggregationInput | null> {
  try {
    if (!boardId) return null
    // Ensure board exists
    const boards = await listBoards()
    if (!boards.some((b) => b.id === boardId)) return null

    const [raw, tasksDoc, ops, lc, rollup, hash] = await Promise.all([
      readBoard(boardId),
      readTasks(boardId),
      readOps(boardId),
      readLifecycle(boardId),
      computeRollup(boardId),
      boardHash(boardId),
    ])
    const model = buildModel(raw)
    const pinHash = createHash('sha256').update(`${boardId}:${hash}`).digest('hex')
    const generatedAt = new Date().toISOString()

    // RawBoard / LifecycleConfig do not declare integer rev fields. Do not invent or unsafe-cast.
    // Pin identity uses content hash; revs stay 0 until control-plane revision store is the source.
    void raw
    void lc
    const boardRev = 0
    const lifecycleRev = 0

    const accounts = (ops.accounts ?? []).map((a: { id?: string; status?: string; usable?: boolean; label?: string }) => ({
      accountIdMasked: maskAccountId(String(a.id ?? a.label ?? 'unknown')),
      status: String(a.status ?? 'UNKNOWN'),
      provider: null as string | null,
      usable: !!a.usable,
    }))

    const readinessPercent =
      typeof (rollup as { readinessPercent?: unknown }).readinessPercent === 'number'
        ? (rollup as { readinessPercent: number }).readinessPercent
        : 0
    const activeCount =
      typeof (rollup as { active?: unknown }).active === 'number'
        ? (rollup as { active: number }).active
        : model.features.length

    const aggregation: PublicAggregationInput = {
      boardId,
      pin: {
        canonicalSnapshotId: `pub-${boardId}-${pinHash.slice(0, 16)}`,
        canonicalHash: pinHash,
        boardRev,
        lifecycleRev,
        serializerVersion: PUBLIC_SERIALIZER_VERSION,
      },
      generatedAt,
      publishedAt: generatedAt,
      publicationIntervalMs: 60_000,
      nowMs: Date.now(),
      boardRollup: {
        trackedWorkDenominator: activeCount || 0,
        productDenominator: activeCount || 0,
        stageProdReady: Number((rollup as { prodReady?: number }).prodReady ?? 0) || 0,
        prodReadyWithEvidence: 0,
        unclassifiedCount: Number((rollup as { uninitialized?: number }).uninitialized ?? 0) || 0,
        rawTaskReadinessPercent: readinessPercent,
        boardReadinessPercent: readinessPercent,
        cappedBy: null,
      },
      completion: { complete: false, g5Pass: false },
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: model.features.filter((f) => f.isBlocked).length,
      },
      staleOverlays: {},
      priorityRollup: null,
      projects: model.projects.map((p) => ({
        id: p.id,
        name: p.nama,
        status: p.status,
      })),
      features: model.features.map((f) => ({
        id: f.id,
        projectId: f.projectId,
        name: f.nama,
        phase: String(f.fase),
      })),
      tasks: (tasksDoc.tasks ?? []).map((t) => ({
        id: t.id,
        projectId: t.projectId ?? null,
        title: t.title,
        bucket: null,
        readinessPercent: null,
      })),
      runs: model.runs.map((r) => ({
        runId: r.id,
        status: r.status,
        taskId: r.taskId ?? r.task ?? null,
        agentRole: r.role ?? null,
        accountRefMasked: r.account ? maskAccountId(String(r.account)) : null,
        lastHeartbeatAt: r.updated ?? null,
      })),
      accounts,
      decisionCount: (model.decisions ?? []).length,
      // PublicG5Summary only — no invented domain rows / no fake g5Pass.
      g5: { g5Pass: false, domainPassCount: 0, domainRequiredCount: 9 },
    }
    return aggregation
  } catch {
    return null
  }
}

/**
 * Symbol for middleware / edge adapters that have *already validated* a client IP.
 * Attach via `Object.defineProperty(request, TRUSTED_CLIENT_IP, { value: '1.2.3.4' })`.
 * Never populated from raw X-Forwarded-For / X-Real-IP / Forwarded headers.
 */
export const TRUSTED_CLIENT_IP = Symbol.for('cairn.publicSnapshot.trustedClientIp')

/** Optional process-level trusted-edge IP provider (injected, validated by caller). */
let trustedEdgeClientIpProvider: ((request: Request) => string | null | undefined) | null =
  null

/**
 * Inject a trusted-edge IP resolver (e.g. after mTLS / validated edge hop).
 * Pass `null` to clear. Provider must never return spoofable raw XFF values.
 */
export function setTrustedEdgeClientIpProvider(
  provider: ((request: Request) => string | null | undefined) | null,
): void {
  trustedEdgeClientIpProvider = provider
}

export function getTrustedEdgeClientIpProvider():
  | ((request: Request) => string | null | undefined)
  | null {
  return trustedEdgeClientIpProvider
}

/**
 * Direct socket / runtime client address (non-spoofable).
 * Prefer srvx NodeRequest `.ip` (socket.remoteAddress), then common socket fields.
 * Never reads X-Forwarded-For / X-Real-IP / Forwarded / CF-Connecting-IP.
 */
export function extractDirectRemoteAddress(request: Request): string | null {
  const r = request as Request & {
    ip?: unknown
    socket?: { remoteAddress?: unknown } | null
    connection?: { remoteAddress?: unknown } | null
    raw?: { socket?: { remoteAddress?: unknown } | null } | null
    info?: { remoteAddress?: unknown } | null
  }

  const candidates: unknown[] = [
    r.ip,
    r.socket?.remoteAddress,
    r.connection?.remoteAddress,
    r.raw?.socket?.remoteAddress,
    r.info?.remoteAddress,
  ]

  for (const c of candidates) {
    if (typeof c === 'string' && c.trim()) return c.trim()
  }
  return null
}

/**
 * Explicitly injected trusted-edge client IP only.
 * Sources: process provider and/or Symbol on the request.
 * Never derived from unvalidated forwarding headers.
 */
export function extractTrustedEdgeClientIp(request: Request): string | null {
  if (trustedEdgeClientIpProvider) {
    try {
      const fromProvider = trustedEdgeClientIpProvider(request)
      if (typeof fromProvider === 'string' && fromProvider.trim()) {
        return fromProvider.trim()
      }
    } catch {
      /* provider failure → fall through; never invent */
    }
  }

  const tagged = (request as Request & { [TRUSTED_CLIENT_IP]?: unknown })[
    TRUSTED_CLIENT_IP
  ]
  if (typeof tagged === 'string' && tagged.trim()) return tagged.trim()
  return null
}

/**
 * Per-client identity for PUBLIC_SNAPSHOT_RATE_LIMIT_V1.
 * Priority: validated trusted-edge IP → direct socket/runtime address →
 * bounded anonymous key `unknown` (does not collapse clients that have identity).
 * Spoofed X-Forwarded-For is ignored even when present.
 */
export function resolvePublicSnapshotClientIp(request: Request): string {
  return resolveClientIp({
    headers: request.headers,
    directRemoteAddress: extractDirectRemoteAddress(request),
    trustedClientIp: extractTrustedEdgeClientIp(request),
  })
}

/** Default: pinned loader installed (C2A). Fail-closed inside loader. */
let publicSnapshotDeps: PublicSnapshotDeps = {
  store: defaultStore,
  loadAggregation: loadPublicAggregation,
  rateLimiter: defaultLimiter,
  resolveIp: resolvePublicSnapshotClientIp,
}

export function setPublicSnapshotDeps(deps: PublicSnapshotDeps): void {
  publicSnapshotDeps = deps
}

export function getPublicSnapshotDeps(): PublicSnapshotDeps {
  return publicSnapshotDeps
}

export async function publicSnapshotGetHandler(request: Request): Promise<Response> {
  const result = await handlePublicSnapshotGet(request, publicSnapshotDeps)
  return publicSnapshotResultToResponse(result)
}

export const Route = createFileRoute('/api/public-snapshot')({
  server: {
    handlers: {
      GET: ({ request }) => publicSnapshotGetHandler(request),
    },
  },
})
