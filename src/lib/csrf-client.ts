/**
 * Browser CSRF client wiring for cookie-authenticated TanStack serverFn mutations.
 *
 * Fail-closed: token-required mutations MUST send session-bound X-CSRF-Token.
 * Token source: csrfTokenFn (primary) → meV3Fn (fallback). Never put the token
 * in URL, body, or logs. Same-origin alone is insufficient on the server.
 *
 * Cache is browser-session-scoped (module memory). Cleared on logout / new login.
 * Never cache across SSR requests (server path always fetches without reuse).
 */

import { csrfTokenFn, meV3Fn } from '#/server/auth-fns'

/** Must match server CSRF_HEADER ('x-csrf-token'). Client-safe constant — do not import node csrf.ts. */
export const CSRF_CLIENT_HEADER = 'x-csrf-token' as const

export class CsrfClientError extends Error {
  readonly code: 'CSRF_TOKEN_UNAVAILABLE'
  constructor(message: string) {
    super(message)
    this.name = 'CsrfClientError'
    this.code = 'CSRF_TOKEN_UNAVAILABLE'
  }
}

type TokenFetcher = () => Promise<string | null>

function extractToken(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const t = value.trim()
  return t.length > 0 ? t : null
}

const defaultPrimary: TokenFetcher = async () => {
  const r = await csrfTokenFn()
  return extractToken(r?.csrfToken)
}

const defaultFallback: TokenFetcher = async () => {
  const r = await meV3Fn()
  return extractToken(r?.csrfToken)
}

let primaryFetcher: TokenFetcher = defaultPrimary
let fallbackFetcher: TokenFetcher = defaultFallback

/** In-memory browser cache only. Null on server / after clear. */
let cachedToken: string | null = null
/** Coalesce concurrent first-fetch calls in the browser. */
let inflight: Promise<string> | null = null

function isBrowser(): boolean {
  return typeof window !== 'undefined'
}

/** Drop cached token (logout, new session, tests). Safe to call anytime. */
export function clearCsrfTokenCache(): void {
  cachedToken = null
  inflight = null
}

/** Test/debug: current cache value without fetching. Never log this. */
export function peekCsrfTokenCache(): string | null {
  return cachedToken
}

/**
 * Seed cache after a known-good token is obtained (e.g. tests).
 * Empty/whitespace is ignored (fail-closed — does not clear).
 */
export function seedCsrfTokenCache(token: string): void {
  const t = extractToken(token)
  if (t) cachedToken = t
}

/**
 * Test-only fetcher override. Pass null to restore production fetchers + clear cache.
 * Not for production UI.
 */
export function setCsrfTokenFetchersForTests(
  fetchers: { primary?: TokenFetcher; fallback?: TokenFetcher } | null,
): void {
  if (!fetchers) {
    primaryFetcher = defaultPrimary
    fallbackFetcher = defaultFallback
    clearCsrfTokenCache()
    return
  }
  if (fetchers.primary) primaryFetcher = fetchers.primary
  if (fetchers.fallback) fallbackFetcher = fetchers.fallback
}

async function fetchTokenFailClosed(): Promise<string> {
  // Always normalize through extractToken so whitespace-only never caches as valid.
  let token = extractToken(await primaryFetcher())
  if (!token) {
    token = extractToken(await fallbackFetcher())
  }
  if (!token) {
    throw new CsrfClientError(
      'CSRF_TOKEN_UNAVAILABLE: session-bound CSRF token required for this mutation (csrfTokenFn/meV3Fn returned none)',
    )
  }
  return token
}

/**
 * Resolve session-bound CSRF token (fail-closed).
 * Browser: cache after first successful fetch until clearCsrfTokenCache().
 * Server/SSR: never reuse module cache across requests.
 */
export async function getCsrfToken(): Promise<string> {
  if (isBrowser()) {
    if (cachedToken) return cachedToken
    if (inflight) return inflight
    inflight = fetchTokenFailClosed()
      .then((t) => {
        cachedToken = t
        return t
      })
      .finally(() => {
        inflight = null
      })
    return inflight
  }
  // SSR / non-browser: one-shot, no cross-request cache.
  return fetchTokenFailClosed()
}

/** Headers bag for TanStack serverFn `{ headers }` option. */
export async function getCsrfHeaders(): Promise<Record<typeof CSRF_CLIENT_HEADER, string>> {
  const token = await getCsrfToken()
  return { [CSRF_CLIENT_HEADER]: token }
}

/**
 * Attach CSRF header to a serverFn call options object (preserves `data`).
 * Prefer this over spreading so the header name stays centralized.
 */
export async function withCsrfHeaders<T extends Record<string, unknown>>(
  opts: T,
): Promise<T & { headers: Record<typeof CSRF_CLIENT_HEADER, string> }> {
  const headers = await getCsrfHeaders()
  return { ...opts, headers }
}

/**
 * Call a validated serverFn with CSRF headers (data required).
 * Example: `csrfServerCall(toggleTaskFn, payload)`
 */
export async function csrfServerCall<TData, TResult>(
  fn: (opts: {
    data: TData
    headers: Record<typeof CSRF_CLIENT_HEADER, string>
  }) => Promise<TResult>,
  data: TData,
): Promise<TResult> {
  const headers = await getCsrfHeaders()
  return fn({ data, headers })
}

/**
 * Call a no-payload serverFn with CSRF headers (e.g. logoutFn).
 */
export async function csrfServerCallNoData<TResult>(
  fn: (opts: {
    headers: Record<typeof CSRF_CLIENT_HEADER, string>
  }) => Promise<TResult>,
): Promise<TResult> {
  const headers = await getCsrfHeaders()
  return fn({ headers })
}
