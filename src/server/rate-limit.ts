/**
 * PUBLIC_SNAPSHOT_RATE_LIMIT_V1 — token-bucket rate limiter for public surfaces.
 * Sustained 60/min/IP, burst 20 → 429 + Retry-After.
 * Never trusts spoofable unvalidated forwarding headers for client IP.
 * Fully injectable / unit-testable without server startup.
 */

export const PUBLIC_SNAPSHOT_RATE_LIMIT_V1 = 'PUBLIC_SNAPSHOT_RATE_LIMIT_V1' as const

/** Default policy numbers (AC-AUTH-05). */
export const PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS = {
  policyId: PUBLIC_SNAPSHOT_RATE_LIMIT_V1,
  /** Sustained refill rate: 60 tokens per 60_000 ms. */
  sustainedPerMinute: 60,
  /** Bucket capacity (burst). */
  burst: 20,
  windowMs: 60_000,
} as const

export interface RateLimitPolicy {
  policyId: string
  sustainedPerMinute: number
  burst: number
  windowMs: number
}

export interface RateLimitDecision {
  allowed: boolean
  remaining: number
  limit: number
  /** Seconds until a token is available (ceil); present when denied. */
  retryAfterSeconds?: number
  policyId: string
  key: string
}

export interface TokenBucketState {
  tokens: number
  /** Last refill timestamp (ms epoch). */
  updatedAtMs: number
}

export interface RateLimitClock {
  nowMs(): number
}

export interface RateLimitStore {
  get(key: string): TokenBucketState | undefined
  set(key: string, state: TokenBucketState): void
}

export function createMemoryRateLimitStore(): RateLimitStore {
  const map = new Map<string, TokenBucketState>()
  return {
    get: (key) => map.get(key),
    set: (key, state) => {
      map.set(key, state)
    },
  }
}

export function defaultRateLimitClock(): RateLimitClock {
  return { nowMs: () => Date.now() }
}

export function resolvePublicSnapshotRateLimitPolicy(
  overrides?: Partial<RateLimitPolicy>,
): RateLimitPolicy {
  return {
    policyId: overrides?.policyId ?? PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS.policyId,
    sustainedPerMinute:
      overrides?.sustainedPerMinute ?? PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS.sustainedPerMinute,
    burst: overrides?.burst ?? PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS.burst,
    windowMs: overrides?.windowMs ?? PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS.windowMs,
  }
}

/**
 * Token bucket: capacity = burst, refill = sustainedPerMinute / windowMs.
 * One request consumes 1 token. When empty → denied + Retry-After.
 */
export function consumeTokenBucket(opts: {
  key: string
  policy: RateLimitPolicy
  store: RateLimitStore
  clock?: RateLimitClock
  cost?: number
}): RateLimitDecision {
  const clock = opts.clock ?? defaultRateLimitClock()
  const cost = opts.cost ?? 1
  const { policy, store, key } = opts
  const now = clock.nowMs()
  const capacity = policy.burst
  const refillPerMs = policy.sustainedPerMinute / policy.windowMs

  let state = store.get(key)
  if (!state) {
    state = { tokens: capacity, updatedAtMs: now }
  } else {
    const elapsed = Math.max(0, now - state.updatedAtMs)
    const refilled = state.tokens + elapsed * refillPerMs
    state = {
      tokens: Math.min(capacity, refilled),
      updatedAtMs: now,
    }
  }

  if (state.tokens >= cost) {
    const next: TokenBucketState = {
      tokens: state.tokens - cost,
      updatedAtMs: now,
    }
    store.set(key, next)
    return {
      allowed: true,
      remaining: Math.floor(next.tokens),
      limit: capacity,
      policyId: policy.policyId,
      key,
    }
  }

  // Time until one token is available.
  const deficit = cost - state.tokens
  const msUntil = refillPerMs > 0 ? Math.ceil(deficit / refillPerMs) : policy.windowMs
  store.set(key, state)
  return {
    allowed: false,
    remaining: 0,
    limit: capacity,
    retryAfterSeconds: Math.max(1, Math.ceil(msUntil / 1000)),
    policyId: policy.policyId,
    key,
  }
}

/**
 * Client IP for rate limiting.
 * - Prefer explicit `trustedClientIp` (injected by edge/proxy that already validated).
 * - Else use `directRemoteAddress` from the transport (non-spoofable).
 * - Do NOT trust raw X-Forwarded-For / X-Real-IP / Forwarded without a trust list.
 * - When a trust list is supplied, only the left-most hop after the trusted proxy chain is used.
 */
export function resolveClientIp(opts: {
  headers?: Headers | Record<string, string | null | undefined>
  /** Non-spoofable address from the socket / platform. */
  directRemoteAddress?: string | null
  /** Already-validated IP from a trusted edge (preferred). */
  trustedClientIp?: string | null
  /**
   * When true AND trustedClientIp is set, allow that IP.
   * Unvalidated forwarding headers are never read even when this is true.
   */
  trustForwardingHeaders?: boolean
}): string {
  if (opts.trustedClientIp && opts.trustedClientIp.trim()) {
    return normalizeIp(opts.trustedClientIp)
  }
  // Explicitly ignore spoofable headers unless a trustedClientIp was injected.
  // trustForwardingHeaders alone is NOT enough to read X-Forwarded-For.
  void opts.trustForwardingHeaders
  void opts.headers
  if (opts.directRemoteAddress && opts.directRemoteAddress.trim()) {
    return normalizeIp(opts.directRemoteAddress)
  }
  return 'unknown'
}

function normalizeIp(raw: string): string {
  const s = raw.trim().toLowerCase()
  // Strip IPv4-mapped IPv6 and zone ids
  if (s.startsWith('::ffff:')) return s.slice(7)
  const zone = s.indexOf('%')
  return zone >= 0 ? s.slice(0, zone) : s
}

/** Build 429 response headers for public snapshot rate limit. */
export function rateLimitResponseHeaders(decision: RateLimitDecision): Record<string, string> {
  const headers: Record<string, string> = {
    'x-ratelimit-limit': String(decision.limit),
    'x-ratelimit-remaining': String(Math.max(0, decision.remaining)),
    'x-ratelimit-policy': decision.policyId,
  }
  if (!decision.allowed && decision.retryAfterSeconds != null) {
    headers['retry-after'] = String(decision.retryAfterSeconds)
  }
  return headers
}

export function rateLimitExceededBody(decision: RateLimitDecision): {
  error: string
  code: 'RATE_LIMITED'
  policyId: string
  retryAfterSeconds: number
} {
  return {
    error: 'public snapshot rate limit exceeded',
    code: 'RATE_LIMITED',
    policyId: decision.policyId,
    retryAfterSeconds: decision.retryAfterSeconds ?? 1,
  }
}

export interface PublicSnapshotRateLimiter {
  check(key: string): RateLimitDecision
}

export function createPublicSnapshotRateLimiter(opts?: {
  policy?: Partial<RateLimitPolicy>
  store?: RateLimitStore
  clock?: RateLimitClock
}): PublicSnapshotRateLimiter {
  const policy = resolvePublicSnapshotRateLimitPolicy(opts?.policy)
  const store = opts?.store ?? createMemoryRateLimitStore()
  const clock = opts?.clock ?? defaultRateLimitClock()
  return {
    check(key: string): RateLimitDecision {
      return consumeTokenBucket({ key, policy, store, clock })
    },
  }
}
