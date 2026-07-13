/**
 * Public GET /api/public-snapshot (AC-PUBLIC-*, AC-AUTH-05).
 * Allowlisted materialized snapshot only; rate limited; ETag/304.
 *
 * Cross-surface: loads canonical loadControlCenterAggregation, maps via
 * control-center-public-snapshot, materializes through the SAME shared
 * public-snapshot-service store + rate limiter as MCP tool/resource.
 *
 * Semantics:
 * - Structural pin/schema/hash/load/allowlist failures → null → 503 STALE_OR_MISSING
 * - Pin-complete + domain blockers (DATA_INTEGRITY / UNCLASSIFIED / ACCOUNT_SYNC_*)
 *   → sanitized public snapshot 200 with forceStale, usableCapacity=0, domainBlockers
 * - Never leaks private decisions/account identity/secrets
 */
import { createFileRoute } from '@tanstack/react-router'

import {
  handlePublicSnapshotGet,
  publicSnapshotResultToResponse,
  type PublicAggregationInput,
  type PublicSnapshotDeps,
} from '#/server/public-snapshot'
import { resolveClientIp } from '#/server/rate-limit'
import { loadControlCenterAggregation } from '#/server/control-center-ui-adapter'
import {
  ControlCenterPublicSnapshotError,
  mapControlCenterAggregationToPublicInput,
} from '#/server/control-center-public-snapshot'
import { getSharedPublicSnapshotService } from '#/server/public-snapshot-service'

/**
 * Explicit public-board allowlist (fail-closed).
 * Env: CAIRN_PUBLIC_BOARD_IDS or CAIRN_PUBLIC_BOARDS — comma/space separated board ids.
 * Empty/unset → deny all boards (no accidental public exposure).
 */
export function resolvePublicBoardAllowlist(
  fromEnv: NodeJS.ProcessEnv = process.env,
): ReadonlySet<string> {
  const raw = (
    fromEnv.CAIRN_PUBLIC_BOARD_IDS ??
    fromEnv.CAIRN_PUBLIC_BOARDS ??
    ''
  ).trim()
  if (!raw) return new Set()
  return new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
}

let allowlistOverride: ReadonlySet<string> | null = null

/** Test-only allowlist override. Pass null to clear. */
export function setPublicBoardAllowlistForTests(
  ids: ReadonlyArray<string> | null,
): void {
  allowlistOverride = ids == null ? null : new Set(ids)
}

export function getPublicBoardAllowlist(): ReadonlySet<string> {
  return allowlistOverride ?? resolvePublicBoardAllowlist()
}

export function isPublicBoardAllowed(boardId: string): boolean {
  if (!boardId) return false
  return getPublicBoardAllowlist().has(boardId)
}

/**
 * Build pinned public aggregation from canonical ControlCenterAggregation.
 * One materialization path shared with MCP (same mapper + serializer).
 *
 * Returns null (→ 503 STALE_OR_MISSING) only for:
 * - allowlist miss / load failure
 * - structural pin/schema/hash/incomplete pin (mapper throws STALE_OR_PARTIAL / INVALID_PIN / …)
 *
 * Domain blockers (DATA_INTEGRITY / UNCLASSIFIED / ACCOUNT_SYNC_*) materialize
 * successfully with forceStale + usableCapacity=0 — never 503 for those alone.
 */
export async function loadPublicAggregation(
  boardId: string,
): Promise<PublicAggregationInput | null> {
  try {
    if (!boardId) return null
    // Explicit allowlist — fail closed when board not listed.
    if (!isPublicBoardAllowed(boardId)) return null

    const agg = await loadControlCenterAggregation(boardId)
    // Mapper: structural pin/schema hard-fail; domain blockers soft-path sanitized.
    return mapControlCenterAggregationToPublicInput(agg)
  } catch (err) {
    // Fail-closed: never invent public payload from private/partial state.
    if (err instanceof ControlCenterPublicSnapshotError) return null
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

/**
 * Deps override for tests. When null, live defaults bind to the shared MCP service
 * (one store + one rate limiter process-wide).
 */
let publicSnapshotDepsOverride: PublicSnapshotDeps | null = null

function buildSharedPublicSnapshotDeps(): PublicSnapshotDeps {
  // Lazy resolve avoids circular init issues with public-snapshot-service.
  const shared = getSharedPublicSnapshotService()
  return {
    store: shared.store,
    loadAggregation: loadPublicAggregation,
    rateLimiter: shared.rateLimiter,
    resolveIp: resolvePublicSnapshotClientIp,
  }
}

export function setPublicSnapshotDeps(deps: PublicSnapshotDeps): void {
  publicSnapshotDepsOverride = deps
}

/** Clear test override — restore shared service defaults. */
export function resetPublicSnapshotDeps(): void {
  publicSnapshotDepsOverride = null
}

export function getPublicSnapshotDeps(): PublicSnapshotDeps {
  return publicSnapshotDepsOverride ?? buildSharedPublicSnapshotDeps()
}

export async function publicSnapshotGetHandler(request: Request): Promise<Response> {
  const result = await handlePublicSnapshotGet(request, getPublicSnapshotDeps())
  return publicSnapshotResultToResponse(result)
}

export const Route = createFileRoute('/api/public-snapshot')({
  server: {
    handlers: {
      GET: ({ request }) => publicSnapshotGetHandler(request),
    },
  },
})
