/**
 * Shared public snapshot materialization service for MCP tool + resource + HTTP.
 *
 * - One process-wide materialization store (pin + content-fingerprint invalidation)
 * - PUBLIC_SNAPSHOT_RATE_LIMIT_V1: 60/min sustained, burst 20
 * - Fail-closed load path (no private data leak on error)
 * - HTTP /api/public-snapshot MUST share this store/limiter (cross-surface one pin)
 */
import { loadPublicAggregation } from '#/routes/api.public-snapshot'
import {
  createMemoryPublicSnapshotStore,
  getOrMaterializePublicSnapshot,
  pinIdentity,
  publicContentFingerprint,
  type MaterializedPublicSnapshot,
  type PublicAggregationInput,
  type PublicSnapshotPin,
  type PublicSnapshotStore,
} from '#/server/public-snapshot'
import {
  createPublicSnapshotRateLimiter,
  rateLimitExceededBody,
  type PublicSnapshotRateLimiter,
  type RateLimitDecision,
} from '#/server/rate-limit'

export const PUBLIC_SNAPSHOT_SERVICE_SYMBOL = Symbol.for('cairn.publicSnapshotService.v1')

export type PublicSnapshotServiceErrorCode =
  | 'RATE_LIMITED'
  | 'STALE_OR_MISSING'
  | 'INVALID_INPUT'
  | 'MATERIALIZATION_FAILED'

export class PublicSnapshotServiceError extends Error {
  readonly code: PublicSnapshotServiceErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: PublicSnapshotServiceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'PublicSnapshotServiceError'
    this.code = code
    this.details = details
  }
}

export type PublicSnapshotLoadResult =
  | { ok: true; snapshot: MaterializedPublicSnapshot['payload']; etag: string; pin: PublicSnapshotPin; replayed: boolean }
  | {
      ok: false
      code: PublicSnapshotServiceErrorCode
      error: string
      stale?: boolean
      retryAfterSeconds?: number
      policyId?: string
    }

export interface PublicSnapshotService {
  store: PublicSnapshotStore
  rateLimiter: PublicSnapshotRateLimiter
  /**
   * Load or return cached materialization for boardId.
   * Invalidates cache when current pin identity differs from stored.
   * Rate-limits by clientKey (default "mcp-public").
   */
  getPublicSnapshot(opts: {
    boardId: string
    clientKey?: string
    /** Injectable aggregation loader (tests). Default: loadPublicAggregation. */
    loadAggregation?: (boardId: string) => Promise<PublicAggregationInput | null>
    /** Skip rate limit (authenticated internal only — tests). */
    skipRateLimit?: boolean
  }): Promise<PublicSnapshotLoadResult>
  /** Drop cache for board (or all) — next get rematerializes. */
  invalidate(boardId?: string): void
  /** Invalidate if stored pin no longer matches current pin. */
  invalidateIfPinChanged(boardId: string, currentPin: PublicSnapshotPin): boolean
}

interface Holder {
  instance: PublicSnapshotService | null
  testOverride: PublicSnapshotService | null
}

type GlobalWithService = typeof globalThis & {
  [PUBLIC_SNAPSHOT_SERVICE_SYMBOL]?: Holder
}

function getHolder(): Holder {
  const g = globalThis as GlobalWithService
  let h = g[PUBLIC_SNAPSHOT_SERVICE_SYMBOL]
  if (!h) {
    h = { instance: null, testOverride: null }
    g[PUBLIC_SNAPSHOT_SERVICE_SYMBOL] = h
  }
  return h
}

export function createPublicSnapshotService(opts?: {
  store?: PublicSnapshotStore
  rateLimiter?: PublicSnapshotRateLimiter
}): PublicSnapshotService {
  const store = opts?.store ?? createMemoryPublicSnapshotStore()
  const rateLimiter = opts?.rateLimiter ?? createPublicSnapshotRateLimiter()

  return {
    store,
    rateLimiter,

    invalidate(boardId?: string) {
      store.clear(boardId)
    },

    invalidateIfPinChanged(boardId: string, currentPin: PublicSnapshotPin): boolean {
      const existing = store.get(boardId)
      if (!existing) return false
      if (pinIdentity(existing.pin) === pinIdentity(currentPin)) return false
      store.clear(boardId)
      return true
    },

    async getPublicSnapshot(optsIn): Promise<PublicSnapshotLoadResult> {
      const boardId = (optsIn.boardId ?? '').trim()
      if (!boardId) {
        return { ok: false, code: 'INVALID_INPUT', error: 'boardId required' }
      }

      const clientKey = (optsIn.clientKey ?? 'mcp-public').trim() || 'mcp-public'
      if (!optsIn.skipRateLimit) {
        const decision: RateLimitDecision = rateLimiter.check(`public-snapshot:${clientKey}`)
        if (!decision.allowed) {
          const body = rateLimitExceededBody(decision)
          return {
            ok: false,
            code: 'RATE_LIMITED',
            error: body.error,
            retryAfterSeconds: body.retryAfterSeconds,
            policyId: body.policyId,
          }
        }
      }

      try {
        const load = optsIn.loadAggregation ?? loadPublicAggregation
        const aggregation = await load(boardId)
        if (!aggregation || aggregation.boardId !== boardId) {
          return {
            ok: false,
            code: 'STALE_OR_MISSING',
            error: 'public snapshot unavailable',
            stale: true,
          }
        }

        // Current-pin invalidation: drop stale materialization before get-or-materialize.
        this.invalidateIfPinChanged(boardId, aggregation.pin)

        const existing = store.get(boardId)
        const nextFp = publicContentFingerprint(aggregation)
        // Replay only when pin AND public content fingerprint match (decisions/G5/counts).
        const replayed =
          !!existing &&
          pinIdentity(existing.pin) === pinIdentity(aggregation.pin) &&
          existing.contentFingerprint === nextFp &&
          existing.payload.boardId === boardId

        const mat = getOrMaterializePublicSnapshot({
          boardId,
          store,
          input: aggregation,
        })

        return {
          ok: true,
          snapshot: mat.payload,
          etag: mat.etag,
          pin: mat.pin,
          replayed,
        }
      } catch {
        // Fail-closed: never surface private payloads or raw errors.
        return {
          ok: false,
          code: 'MATERIALIZATION_FAILED',
          error: 'public snapshot unavailable',
          stale: true,
        }
      }
    },
  }
}

/** Process singleton — MCP tool + resource share this. */
export function getSharedPublicSnapshotService(): PublicSnapshotService {
  const holder = getHolder()
  if (holder.testOverride) return holder.testOverride
  if (!holder.instance) {
    holder.instance = createPublicSnapshotService()
  }
  return holder.instance
}

/** Test-only override. */
export function setTestPublicSnapshotService(svc: PublicSnapshotService | null): void {
  getHolder().testOverride = svc
}

/** Test-only: clear override + cached production instance. */
export function resetPublicSnapshotServiceForTests(): void {
  const holder = getHolder()
  holder.testOverride = null
  holder.instance = null
}
