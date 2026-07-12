// Request-scoped auth: read/write the session cookie and resolve the current human.
// Guards throw — callers (server fns) let it propagate; route beforeLoad redirects.
import { deleteCookie, getCookie, getRequestProtocol, setCookie } from '@tanstack/react-start/server'

import { SESSION_DAYS, sessionUser } from './auth-store'
import type { SessionUser } from '#/lib/types'

export const SESSION_COOKIE = 'cairn_session'

/** Secure only over https so http://127.0.0.1 local verify still receives the cookie. */
function secureCookie(): boolean {
  try {
    return getRequestProtocol() === 'https'
  } catch {
    return false
  }
}

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

/** admin sees everything; a member sees only its allowlisted boards. */
export function canSeeBoard(user: SessionUser | null, boardId: string): boolean {
  if (!user) return false
  return user.role === 'admin' || user.boards.includes(boardId)
}

export class AuthError extends Error {
  status: number
  constructor(message: string, status = 401) {
    super(message)
    this.name = 'AuthError'
    this.status = status
  }
}

/** Require a signed-in human (any role). */
export async function requireUser(): Promise<SessionUser> {
  const u = await currentUser()
  if (!u) throw new AuthError('not signed in', 401)
  return u
}
/** Require admin — used by every web mutation and the user-management API. */
export async function requireAdmin(): Promise<SessionUser> {
  const u = await requireUser()
  if (u.role !== 'admin') throw new AuthError('admin only', 403)
  return u
}
/** Require read access to a specific board (admin, or member with it allowlisted). */
export async function requireView(boardId: string): Promise<SessionUser> {
  const u = await requireUser()
  if (!canSeeBoard(u, boardId)) throw new AuthError('no access to this board', 403)
  return u
}
