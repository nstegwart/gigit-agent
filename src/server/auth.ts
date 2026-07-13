// Request-scoped auth: read/write the session cookie and resolve the current human.
// Guards throw — callers (server fns) let it propagate; route beforeLoad redirects.
// V3: maps session → additive principal (OWNER/member-allowlist); CSRF for cookie writes.
import {
  deleteCookie,
  getCookie,
  getRequest,
  getRequestHeader,
  getRequestHost,
  getRequestProtocol,
  setCookie,
} from '@tanstack/react-start/server'

import { SESSION_DAYS, sessionUser } from './auth-store'
import {
  assertBrowserWriteCsrf,
  C3_CSRF_TOKEN_CLIENT_WIRING,
  CSRF_HEADER,
  deriveCsrfToken,
  type CsrfCheckResult,
} from './csrf'
import {
  assertBearerChannel,
  canAccessBoard,
  principalFromSession,
  requireBoardAccess,
  requireRole,
  requireScope,
  resetBearerInjection,
  type Principal,
  type Scope,
  type V3Role,
  RbacError,
} from './rbac'
import type { SessionUser } from '#/lib/types'

export const SESSION_COOKIE = 'cairn_session'

export { C3_CSRF_TOKEN_CLIENT_WIRING, CSRF_HEADER }

/** Secure only over https so http://127.0.0.1 local verify still receives the cookie. */
function secureCookie(): boolean {
  try {
    return getRequestProtocol() === 'https'
  } catch {
    return false
  }
}

/**
 * Session cookie for browser identity.
 * sameSite: 'lax' — safe default for cookie auth (blocks most cross-site POSTs);
 * CSRF header + same-origin remain required for cookie writes via requireAdminWrite.
 * httpOnly: true — never readable by JS; MCP bearer must use Authorization header, not this cookie.
 */
export function setSessionCookie(token: string): void {
  setCookie(SESSION_COOKIE, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: secureCookie(),
    path: '/',
    maxAge: SESSION_DAYS * 24 * 60 * 60,
  })
}
export function clearSessionCookie(): void {
  deleteCookie(SESSION_COOKIE, { path: '/' })
}
export function currentSessionToken(): string | undefined {
  return getCookie(SESSION_COOKIE)
}

/** The signed-in human, or null. Reads the cookie from the async request context. */
export async function currentUser(): Promise<SessionUser | null> {
  return sessionUser(currentSessionToken())
}

/** V3 principal for the browser session (null when anonymous). */
export async function currentPrincipal(): Promise<Principal | null> {
  return principalFromSession(await currentUser())
}

/** admin sees everything; a member sees only its allowlisted boards. */
export function canSeeBoard(user: SessionUser | null, boardId: string): boolean {
  if (!user) return false
  return user.role === 'admin' || user.boards.includes(boardId)
}

export class AuthError extends Error {
  status: number
  code?: string
  constructor(message: string, status = 401, code?: string) {
    super(message)
    this.name = 'AuthError'
    this.status = status
    this.code = code
  }
}

/** Require a signed-in human (any role). */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser()
  if (!u) throw new AuthError('not signed in', 401, 'AUTHORIZATION_REQUIRED')
  return u
}
/** Require admin — used by every web mutation and the user-management API. Maps to OWNER. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser()
  if (u.role !== 'admin') throw new AuthError('admin only', 403, 'FORBIDDEN_ROLE')
  return u
}
/** Require read access to a specific board (admin, or member with it allowlisted). */
export async function requireView(boardId: string): Promise<SessionUser> {
  const u = await requireUser()
  if (!canSeeBoard(u, boardId)) throw new AuthError('no access to this board', 403, 'FORBIDDEN_SCOPE')
  return u
}

/** Require V3 principal with role(s). */
export async function requirePrincipalRole(roles: ReadonlyArray<V3Role>): Promise<Principal> {
  const p = await currentPrincipal()
  try {
    return requireRole(p, roles)
  } catch (e) {
    if (e instanceof RbacError) throw new AuthError(e.message, e.status, e.code)
    throw e
  }
}

/** Require V3 scope on session principal. */
export async function requirePrincipalScope(scope: Scope): Promise<Principal> {
  const p = await currentPrincipal()
  try {
    return requireScope(p, scope)
  } catch (e) {
    if (e instanceof RbacError) throw new AuthError(e.message, e.status, e.code)
    throw e
  }
}

/** Require board access via V3 principal mapping. */
export async function requirePrincipalBoard(boardId: string): Promise<Principal> {
  const p = await currentPrincipal()
  try {
    return requireBoardAccess(p, boardId)
  } catch (e) {
    if (e instanceof RbacError) throw new AuthError(e.message, e.status, e.code)
    throw e
  }
}

/**
 * CSRF + same-origin for browser cookie writes.
 * MCP/bearer callers must not invoke this.
 */
export function assertRequestCsrf(opts?: {
  allowSameOriginWithoutToken?: boolean
  oneTime?: boolean
}): CsrfCheckResult {
  let origin: string | null = null
  let referer: string | null = null
  let host: string | null = null
  let protocol: string | null = null
  let csrfHeader: string | null = null
  try {
    origin = getRequestHeader('origin') ?? null
    referer = getRequestHeader('referer') ?? null
    csrfHeader = getRequestHeader(CSRF_HEADER) ?? getRequestHeader('x-csrf-token') ?? null
    host = getRequestHost({ xForwardedHost: false }) ?? null
    protocol = getRequestProtocol({ xForwardedProto: false }) ?? null
    // Fallback host from request URL when getRequestHost empty
    if (!host) {
      try {
        host = new URL(getRequest().url).host
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* outside request context — fail closed */
    return { ok: false, code: 'CSRF_ORIGIN_MISSING', message: 'no request context' }
  }

  return assertBrowserWriteCsrf({
    sessionToken: currentSessionToken(),
    csrfHeader,
    origin,
    referer,
    host,
    protocol,
    allowSameOriginWithoutToken: opts?.allowSameOriginWithoutToken,
    oneTime: opts?.oneTime,
  })
}

/**
 * Require admin + CSRF for browser mutations.
 * On CSRF failure throws AuthError 403 with code.
 */
export async function requireAdminWrite(): Promise<SessionUser> {
  const u = await requireAdmin()
  const csrf = assertRequestCsrf({ allowSameOriginWithoutToken: true })
  if (!csrf.ok) {
    throw new AuthError(csrf.message, 403, csrf.code)
  }
  return u
}

/** Session-bound CSRF token for the current browser session (null if anonymous). */
export function currentCsrfToken(): string | null {
  const t = currentSessionToken()
  return t ? deriveCsrfToken(t) : null
}

export {
  assertBearerChannel,
  canAccessBoard,
  principalFromSession,
  resetBearerInjection,
}
export type { Principal, Scope, V3Role }
