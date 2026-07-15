/**
 * Authenticated API accounts entrypoint + four-surface service contract.
 * Proves unauth denied (401) and same-revision identity across product services.
 */
import { describe, expect, it } from 'vitest'

import {
  ACCOUNT_SURFACE_SCHEMA,
  AccountSurfaceAuthError,
  assertAccountSurfaceAuthorized,
  createProductAccountSyncSurfaceReaders,
  loadPinnedAuthoritativeAccountSnapshot,
  projectAuthenticatedApiAccounts,
  projectMcpListAccounts,
  projectOpsAccountSource,
  projectAuthenticatedUiAccountSource,
  readAuthenticatedApiAccountsService,
} from '#/server/account-surface-readers'
import { createMemoryAccountSyncStore } from '#/server/account-sync'

const BOARD = 'mfs-rebuild'
const GEN = '2026-07-13T15:00:00.000Z'

async function seedStore() {
  const accounts = createMemoryAccountSyncStore()
  await accounts.put({
    boardId: BOARD,
    sourceRevision: 9,
    generatedAt: GEN,
    generatedAtMs: Date.parse(GEN),
    accounts: [
      {
        maskedAccountId: 'acct-mask-api',
        status: 'OK',
        providerKind: 'GROK',
        effectiveInUse: 1,
        effectiveCap: 4,
        physicalSlotsDisplay: '1/4',
        adaptiveQuotaState: null,
        reason: null,
        statusChangedAt: null,
        tombstone: false,
      },
    ],
    readbackSurfaces: {
      mcp: { sourceRevision: 9, generatedAt: GEN },
      api: { sourceRevision: 9, generatedAt: GEN },
      ui: { sourceRevision: 9, generatedAt: GEN },
      ops: { sourceRevision: 9, generatedAt: GEN },
    },
    publishedAtMs: Date.parse(GEN),
    lastPeriodicHealthAtMs: null,
    stale: false,
    staleReason: null,
    usableCapacity: 3,
    capacity: {} as never,
    entityRev: 2,
  })
  return accounts
}

describe('account surface API + product services', () => {
  it('API unauth denied (session user null → 401 AUTHORIZATION_REQUIRED)', async () => {
    const accounts = await seedStore()
    try {
      await readAuthenticatedApiAccountsService({
        boardId: BOARD,
        accounts,
        auth: { kind: 'session', user: null },
      })
      expect.fail('expected AccountSurfaceAuthError')
    } catch (e) {
      expect(e).toBeInstanceOf(AccountSurfaceAuthError)
      expect((e as AccountSurfaceAuthError).status).toBe(401)
      expect((e as AccountSurfaceAuthError).code).toBe('AUTHORIZATION_REQUIRED')
    }
  })

  it('API session without board access → 403', async () => {
    const accounts = await seedStore()
    await expect(
      readAuthenticatedApiAccountsService({
        boardId: BOARD,
        accounts,
        auth: {
          kind: 'session',
          user: { id: 'u1', role: 'member', boards: ['other-board'] },
        },
      }),
    ).rejects.toMatchObject({ status: 403, code: 'FORBIDDEN_SCOPE' })
  })

  it('API authorized session returns JSON envelope with schema + revision', async () => {
    const accounts = await seedStore()
    const env = await readAuthenticatedApiAccountsService({
      boardId: BOARD,
      accounts,
      auth: {
        kind: 'session',
        user: { id: 'admin', role: 'admin', boards: [] },
      },
    })
    expect(env).toMatchObject({
      ok: true,
      schema: ACCOUNT_SURFACE_SCHEMA.api,
      sourceRevision: 9,
      generatedAt: GEN,
      usableCapacity: 3,
      boardId: BOARD,
    })
    expect(JSON.stringify(env)).not.toMatch(/password|token|secret/i)
  })

  it('four projectors share sourceRevision/generatedAt with distinct schemas', async () => {
    const accounts = await seedStore()
    const snap = await loadPinnedAuthoritativeAccountSnapshot(BOARD, accounts)
    expect(snap?.sourceRevision).toBe(9)

    const mcp = projectMcpListAccounts(snap, { boardId: BOARD })
    const api = projectAuthenticatedApiAccounts(snap, { boardId: BOARD })
    const ui = projectAuthenticatedUiAccountSource(snap, { boardId: BOARD })
    const ops = projectOpsAccountSource(snap, { boardId: BOARD })

    for (const p of [mcp, api, ui, ops]) {
      expect(p?.sourceRevision).toBe(9)
      expect(p?.generatedAt).toBe(GEN)
    }
    expect(mcp?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.mcp)
    expect(mcp?.entityRev).toBe(2)
    expect(api?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.api)
    expect(ui?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.ui)
    expect(ops?.schema).toBe(ACCOUNT_SURFACE_SCHEMA.ops)

    const readers = createProductAccountSyncSurfaceReaders(accounts)
    const ids = await Promise.all([
      readers.mcp.readAuthoritativeIdentity(BOARD),
      readers.api.readAuthoritativeIdentity(BOARD),
      readers.ui.readAuthoritativeIdentity(BOARD),
      readers.ops.readAuthoritativeIdentity(BOARD),
    ])
    expect(ids.every((i) => i?.sourceRevision === 9 && i?.generatedAt === GEN)).toBe(true)
  })

  it('assertAccountSurfaceAuthorized allows system and admin session', () => {
    expect(() =>
      assertAccountSurfaceAuthorized('api', BOARD, { kind: 'system' }),
    ).not.toThrow()
    expect(() =>
      assertAccountSurfaceAuthorized('ui', BOARD, {
        kind: 'session',
        user: { id: 'a', role: 'admin', boards: [] },
      }),
    ).not.toThrow()
    expect(() =>
      assertAccountSurfaceAuthorized('ops', BOARD, {
        kind: 'session',
        user: null,
      }),
    ).toThrow(AccountSurfaceAuthError)
  })
})
