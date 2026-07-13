// Auth + user-management server functions (the browser's login/admin API).
// MCP is untouched — this is the human plane only.
// V3: CSRF on cookie mutations; meFn exposes additive principal + csrfToken.
import { createServerFn } from '@tanstack/react-start'
import { z } from 'zod'

import {
  authenticate,
  countUsers,
  createUser,
  deleteUser,
  destroySession,
  listUsers,
  resetPassword,
  setUserBoards,
  setUserRole,
} from './auth-store'
import {
  assertRequestCsrf,
  clearSessionCookie,
  currentCsrfToken,
  currentPrincipal,
  currentSessionToken,
  currentUser,
  requireAdmin,
  requireAdminWrite,
  setSessionCookie,
} from './auth'
import { principalFromSession } from './rbac'
import type { SessionUser, UserRow } from '#/lib/types'

const roleSchema = z.enum(['admin', 'member'])

// ---- session ----
/** The signed-in human (null when anonymous) — drives the route guards + UI chrome. */
export const meFn = createServerFn({ method: 'GET' }).handler(async (): Promise<SessionUser | null> => currentUser())

/**
 * Additive V3 session view: principal mapping + CSRF token.
 * Does not replace meFn (legacy SessionUser shape preserved for UI).
 */
export const meV3Fn = createServerFn({ method: 'GET' }).handler(async () => {
  const user = await currentUser()
  const principal = principalFromSession(user)
  return {
    user,
    principal: principal
      ? {
          actorId: principal.actorId,
          role: principal.role,
          scopes: [...principal.scopes],
          legacyRole: principal.legacyRole ?? null,
          channel: principal.channel,
          boards: [...principal.boards],
        }
      : null,
    /** Session-bound CSRF token for browser writes (null when anonymous). Never a credential. */
    csrfToken: currentCsrfToken(),
  }
})

/** Whether the instance still needs its first admin — the login page shows a setup form. */
export const needsSetupFn = createServerFn({ method: 'GET' }).handler(async () => (await countUsers()) === 0)

export const loginFn = createServerFn({ method: 'POST' })
  .validator(z.object({ username: z.string().min(1), password: z.string().min(1) }))
  .handler(async ({ data }): Promise<SessionUser> => {
    // Login has no prior session — CSRF not applicable; still prefer same-origin when present.
    const res = await authenticate(data.username, data.password)
    if (!res) throw new Error('Invalid username or password')
    setSessionCookie(res.token)
    return res.user
  })

export const logoutFn = createServerFn({ method: 'POST' }).handler(async () => {
  // Logout: if session exists, CSRF-protect; anonymous logout is noop.
  if (currentSessionToken()) {
    const csrf = assertRequestCsrf({ allowSameOriginWithoutToken: true })
    if (!csrf.ok) throw new Error(csrf.message)
  }
  await destroySession(currentSessionToken())
  clearSessionCookie()
  return { ok: true }
})

/** One-time: create the first admin when there are zero users, then sign in. */
export const bootstrapFn = createServerFn({ method: 'POST' })
  .validator(z.object({ username: z.string().min(1), password: z.string().min(6) }))
  .handler(async ({ data }): Promise<SessionUser> => {
    if ((await countUsers()) > 0) throw new Error('Setup already complete — ask an admin for an account')
    await createUser({ username: data.username, password: data.password, role: 'admin' })
    const res = await authenticate(data.username, data.password)
    if (!res) throw new Error('bootstrap failed')
    setSessionCookie(res.token)
    return res.user
  })

// ---- admin: user management (all gated to admin + CSRF) ----
export const listUsersFn = createServerFn({ method: 'GET' }).handler(async (): Promise<Array<UserRow>> => {
  await requireAdmin()
  return listUsers()
})

export const createUserFn = createServerFn({ method: 'POST' })
  .validator(z.object({ username: z.string().min(1), password: z.string().min(6), role: roleSchema, boards: z.array(z.string()).optional() }))
  .handler(async ({ data }): Promise<Array<UserRow>> => {
    await requireAdminWrite()
    await createUser(data)
    return listUsers()
  })

export const setUserBoardsFn = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string().min(1), boards: z.array(z.string()) }))
  .handler(async ({ data }): Promise<Array<UserRow>> => {
    await requireAdminWrite()
    await setUserBoards(data.userId, data.boards)
    return listUsers()
  })

export const setUserRoleFn = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string().min(1), role: roleSchema }))
  .handler(async ({ data }): Promise<Array<UserRow>> => {
    await requireAdminWrite()
    await setUserRole(data.userId, data.role)
    return listUsers()
  })

export const resetPasswordFn = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string().min(1), password: z.string().min(6) }))
  .handler(async ({ data }): Promise<{ ok: true }> => {
    await requireAdminWrite()
    await resetPassword(data.userId, data.password)
    return { ok: true }
  })

export const deleteUserFn = createServerFn({ method: 'POST' })
  .validator(z.object({ userId: z.string().min(1) }))
  .handler(async ({ data }): Promise<Array<UserRow>> => {
    const me = await requireAdminWrite()
    if (me.id === data.userId) throw new Error('You cannot delete your own account')
    await deleteUser(data.userId)
    return listUsers()
  })

/** Explicit CSRF token read (same as meFn.csrfToken) for clients that only need the token. */
export const csrfTokenFn = createServerFn({ method: 'GET' }).handler(async () => {
  await currentPrincipal() // touch session context
  return { csrfToken: currentCsrfToken() }
})
