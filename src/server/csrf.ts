/**
 * Browser cookie-authenticated write CSRF + same-origin protection.
 * MCP bearer requests do NOT use cookie CSRF.
 *
 * Strategy:
 * - Session-bound CSRF token (HMAC-like hash of session token + secret) via double-submit header.
 * - Same-origin check on Origin/Referer vs Host (fail closed on mismatch).
 * - One-time nonce optional for replay tests (consumeNonce).
 * - When UI cannot yet supply X-CSRF-Token: allow only if same-origin is proven
 *   (C3_CSRF_TOKEN_CLIENT_WIRING carry-forward). Never disable the guard globally.
 */

import { createHash, randomBytes, timingSafeEqual } from 'node:crypto'

export const CSRF_HEADER = 'x-csrf-token'
export const CSRF_COOKIE = 'cairn_csrf'

export type CsrfFailCode =
  | 'CSRF_TOKEN_MISSING'
  | 'CSRF_TOKEN_INVALID'
  | 'CSRF_ORIGIN_MISMATCH'
  | 'CSRF_ORIGIN_MISSING'
  | 'CSRF_REPLAY'
  | 'CSRF_SESSION_REQUIRED'
  | 'CSRF_SECRET_REQUIRED'

export class CsrfError extends Error {
  readonly code: CsrfFailCode
  readonly status: number
  constructor(code: CsrfFailCode, message: string, status = 403) {
    super(message)
    this.name = 'CsrfError'
    this.code = code
    this.status = status
  }
}

/** Dev/unit-only default — never used under production-like env without explicit secret. */
export const CSRF_DEV_DEFAULT_SECRET = 'cairn-dev-csrf-secret-not-for-prod' as const

/** Secret for binding CSRF to session — process-local, not a user credential. */
let csrfSecret: string | null = null

export function setCsrfSecret(secret: string | null): void {
  csrfSecret = secret
}

/**
 * Production-like: NODE_ENV=production, or CAIRN_ENV/APP_ENV in {production,prod,staging}.
 * Local/test (NODE_ENV=test/development/undefined) may use the injected or dev default secret.
 */
export function isProductionLikeCsrfEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = (env.NODE_ENV || '').toLowerCase()
  if (nodeEnv === 'production') return true
  const appEnv = (env.CAIRN_ENV || env.APP_ENV || '').toLowerCase()
  return appEnv === 'production' || appEnv === 'prod' || appEnv === 'staging'
}

export type CsrfSecretResolution =
  | { ok: true; secret: string; source: 'injected' | 'env' | 'dev-default' }
  | { ok: false; code: 'CSRF_SECRET_REQUIRED'; message: string }

/**
 * Resolve CSRF secret. Production-like without CAIRN_CSRF_SECRET / injection fails closed.
 * Unit/local may use setCsrfSecret injection or the non-prod default marker.
 */
export function resolveCsrfSecret(
  env: NodeJS.ProcessEnv = process.env,
): CsrfSecretResolution {
  if (csrfSecret) {
    return { ok: true, secret: csrfSecret, source: 'injected' }
  }
  const fromEnv = env.CAIRN_CSRF_SECRET?.trim()
  if (fromEnv) {
    csrfSecret = fromEnv
    return { ok: true, secret: csrfSecret, source: 'env' }
  }
  if (isProductionLikeCsrfEnv(env)) {
    return {
      ok: false,
      code: 'CSRF_SECRET_REQUIRED',
      message: 'CAIRN_CSRF_SECRET required in non-local environments',
    }
  }
  csrfSecret = CSRF_DEV_DEFAULT_SECRET
  return { ok: true, secret: csrfSecret, source: 'dev-default' }
}

function secret(): string {
  const resolved = resolveCsrfSecret()
  if (!resolved.ok) {
    throw new CsrfError(resolved.code, resolved.message, 500)
  }
  return resolved.secret
}

/** Derive a stable session-bound CSRF token (not the session token itself). */
export function deriveCsrfToken(sessionToken: string): string {
  return createHash('sha256')
    .update(`csrf:v1:${secret()}:${sessionToken}`)
    .digest('hex')
}

/** Issue a fresh random CSRF token (for double-submit / one-time). */
export function issueRandomCsrfToken(): string {
  return randomBytes(32).toString('hex')
}

export function safeEqualHex(a: string, b: string): boolean {
  try {
    const ba = Buffer.from(a, 'utf8')
    const bb = Buffer.from(b, 'utf8')
    if (ba.length !== bb.length) return false
    return timingSafeEqual(ba, bb)
  } catch {
    return false
  }
}

export interface OriginCheckInput {
  origin?: string | null
  referer?: string | null
  host?: string | null
  /** e.g. https */
  protocol?: string | null
  /** When true, missing Origin+Referer fails closed. Default true for cookie writes. */
  requireOrigin?: boolean
}

function normalizeScheme(protocol: string | null | undefined): string | null {
  if (!protocol) return null
  return protocol.replace(/:$/, '').trim().toLowerCase() || null
}

export function isSameOrigin(input: OriginCheckInput): { ok: boolean; code?: CsrfFailCode; message?: string } {
  const host = (input.host || '').split(',')[0]?.trim().toLowerCase()
  if (!host) {
    return { ok: false, code: 'CSRF_ORIGIN_MISSING', message: 'host missing' }
  }
  const origin = input.origin?.trim() || null
  const referer = input.referer?.trim() || null
  if (!origin && !referer) {
    if (input.requireOrigin === false) return { ok: true }
    return { ok: false, code: 'CSRF_ORIGIN_MISSING', message: 'Origin/Referer required' }
  }
  const candidate = origin || referer!
  let url: URL
  try {
    url = new URL(candidate)
  } catch {
    return { ok: false, code: 'CSRF_ORIGIN_MISMATCH', message: 'invalid origin/referer' }
  }
  const candHost = url.host.toLowerCase()
  // Exact host:port match (prevents cross-port CSRF on localhost).
  if (candHost !== host) {
    return { ok: false, code: 'CSRF_ORIGIN_MISMATCH', message: `origin host ${candHost} != ${host}` }
  }
  // Scheme must match when expected protocol is known (prevents https↔http same-host CSRF).
  const expectedScheme = normalizeScheme(input.protocol)
  if (expectedScheme) {
    const candScheme = normalizeScheme(url.protocol)
    if (candScheme !== expectedScheme) {
      return {
        ok: false,
        code: 'CSRF_ORIGIN_MISMATCH',
        message: `origin scheme ${candScheme} != ${expectedScheme}`,
      }
    }
  }
  return { ok: true }
}

// ---- optional one-time nonce store (replay protection) ----

const usedNonces = new Map<string, number>()
const NONCE_TTL_MS = 60 * 60 * 1000

export function rememberNonce(nonce: string, nowMs = Date.now()): void {
  usedNonces.set(nonce, nowMs + NONCE_TTL_MS)
}

export function consumeNonce(nonce: string, nowMs = Date.now()): boolean {
  // purge
  for (const [k, exp] of usedNonces) {
    if (exp <= nowMs) usedNonces.delete(k)
  }
  if (usedNonces.has(nonce)) return false
  usedNonces.set(nonce, nowMs + NONCE_TTL_MS)
  return true
}

export function clearNonceStore(): void {
  usedNonces.clear()
}

export interface CsrfCheckInput {
  sessionToken: string | null | undefined
  csrfHeader: string | null | undefined
  origin?: string | null
  referer?: string | null
  host?: string | null
  protocol?: string | null
  /**
   * When true (default), missing CSRF token is allowed only if same-origin passes
   * (C3 client wiring carry-forward). When false, token is mandatory.
   */
  allowSameOriginWithoutToken?: boolean
  /** When set, token must be unused one-time nonce. */
  oneTime?: boolean
  nowMs?: number
}

export type CsrfCheckResult =
  | { ok: true; mode: 'token' | 'same-origin-deferred' }
  | { ok: false; code: CsrfFailCode; message: string }

/**
 * Validate browser write CSRF. Call only for cookie-authenticated mutations.
 * MCP bearer path must NOT call this.
 */
export function assertBrowserWriteCsrf(input: CsrfCheckInput): CsrfCheckResult {
  if (!input.sessionToken) {
    return { ok: false, code: 'CSRF_SESSION_REQUIRED', message: 'session required for CSRF' }
  }

  // Fail closed before any token mint/compare when non-local secret is missing.
  const secretState = resolveCsrfSecret()
  if (!secretState.ok) {
    return { ok: false, code: secretState.code, message: secretState.message }
  }

  const originCheck = isSameOrigin({
    origin: input.origin,
    referer: input.referer,
    host: input.host,
    protocol: input.protocol,
    requireOrigin: true,
  })
  if (!originCheck.ok) {
    return {
      ok: false,
      code: originCheck.code ?? 'CSRF_ORIGIN_MISMATCH',
      message: originCheck.message ?? 'origin check failed',
    }
  }

  let expected: string
  try {
    expected = deriveCsrfToken(input.sessionToken)
  } catch (e) {
    if (e instanceof CsrfError) {
      return { ok: false, code: e.code, message: e.message }
    }
    throw e
  }
  const provided = input.csrfHeader?.trim() || ''

  if (provided) {
    // Session-bound constant-time compare. Wrong session / wrong secret → CSRF_TOKEN_INVALID
    // (covers replay of a token minted for a different session = session mismatch).
    const boundOk = safeEqualHex(provided, expected)
    if (!boundOk) {
      return { ok: false, code: 'CSRF_TOKEN_INVALID', message: 'invalid CSRF token' }
    }
    if (input.oneTime) {
      if (!consumeNonce(provided, input.nowMs ?? Date.now())) {
        return { ok: false, code: 'CSRF_REPLAY', message: 'CSRF token replay' }
      }
    }
    return { ok: true, mode: 'token' }
  }

  // No token
  if (input.allowSameOriginWithoutToken !== false) {
    // C3 carry-forward: same-origin proven above + SameSite session cookie only.
    // Does NOT disable the guard globally — origin check still required.
    return { ok: true, mode: 'same-origin-deferred' }
  }
  return { ok: false, code: 'CSRF_TOKEN_MISSING', message: 'CSRF token required' }
}

/** C3 carry-forward constant — client must wire X-CSRF-Token on mutations. */
export const C3_CSRF_TOKEN_CLIENT_WIRING =
  'C3_CSRF_TOKEN_CLIENT_WIRING: browser mutation callers must send X-CSRF-Token (session-bound via csrfTokenFn); server currently accepts same-origin as interim fail-open for missing token only after origin check; never disable guard' as const
