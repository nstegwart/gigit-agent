/**
 * Authenticated GET /api/accounts?boardId=…
 *
 * Public consumer entrypoint for the API product surface:
 * session (cookie) required → readAuthenticatedApiAccountsService → JSON envelope
 * with sourceRevision / generatedAt / schema. Unauthenticated → 401.
 *
 * Does not self-call HTTP; invokes the same service path the scheduler uses
 * for API surface identity (with session auth enforced here).
 */
import { createFileRoute } from '@tanstack/react-router'

import { currentUser } from '#/server/auth'
import {
  AccountSurfaceAuthError,
  readAuthenticatedApiAccountsService,
} from '#/server/account-surface-readers'
import {
  getSharedAccountSyncStore,
  type AccountSyncStore,
} from '#/server/account-sync'
import { peekControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'

function resolveAccountStore(): AccountSyncStore {
  const ctx = peekControlPlaneRuntimeContext()
  if (ctx?.runtime?.accounts) return ctx.runtime.accounts
  return getSharedAccountSyncStore()
}

export async function accountsGetHandler(request: Request): Promise<Response> {
  const url = new URL(request.url)
  const boardId = (url.searchParams.get('boardId') ?? '').trim()
  if (!boardId) {
    return new Response(
      JSON.stringify({
        ok: false,
        error: 'boardId query parameter required',
        code: 'INVALID_INPUT',
      }),
      {
        status: 400,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }

  try {
    const user = await currentUser()
    const envelope = await readAuthenticatedApiAccountsService({
      boardId,
      accounts: resolveAccountStore(),
      auth: {
        kind: 'session',
        user: user
          ? { id: user.id, role: user.role, boards: user.boards }
          : null,
      },
    })

    if (!envelope) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: 'account sync snapshot missing',
          code: 'ACCOUNT_SYNC_MISSING',
          boardId,
          schema: 'ACCOUNT_API_JSON_V1',
          sourceRevision: null,
          generatedAt: null,
          usableCapacity: 0,
          stale: true,
        }),
        {
          status: 404,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      )
    }

    return new Response(JSON.stringify(envelope), {
      status: 200,
      headers: {
        'content-type': 'application/json; charset=utf-8',
        'cache-control': 'no-store',
      },
    })
  } catch (e) {
    if (e instanceof AccountSurfaceAuthError) {
      return new Response(
        JSON.stringify({
          ok: false,
          error: e.message,
          code: e.code,
        }),
        {
          status: e.status,
          headers: {
            'content-type': 'application/json; charset=utf-8',
            'cache-control': 'no-store',
          },
        },
      )
    }
    const message = e instanceof Error ? e.message : String(e)
    return new Response(
      JSON.stringify({
        ok: false,
        error: message,
        code: 'DATA_INTEGRITY',
      }),
      {
        status: 500,
        headers: {
          'content-type': 'application/json; charset=utf-8',
          'cache-control': 'no-store',
        },
      },
    )
  }
}

export const Route = createFileRoute('/api/accounts')({
  server: {
    handlers: {
      GET: ({ request }) => accountsGetHandler(request),
    },
  },
})
