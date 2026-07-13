/**
 * CSRF client helper unit tests (fail-closed fetch, cache, clear, headers).
 * Does not exercise live HTTP — serverFn sources are injected for isolation.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  CSRF_CLIENT_HEADER,
  CsrfClientError,
  clearCsrfTokenCache,
  csrfServerCall,
  csrfServerCallNoData,
  getCsrfHeaders,
  getCsrfToken,
  peekCsrfTokenCache,
  seedCsrfTokenCache,
  setCsrfTokenFetchersForTests,
  withCsrfHeaders,
} from '#/lib/csrf-client'

afterEach(() => {
  setCsrfTokenFetchersForTests(null)
  clearCsrfTokenCache()
})

describe('csrf-client fail-closed token fetch', () => {
  it('returns primary token and caches in browser', async () => {
    const primary = vi.fn(async () => 'token-from-csrfTokenFn')
    const fallback = vi.fn(async () => 'token-from-meV3')
    setCsrfTokenFetchersForTests({ primary, fallback })

    const t1 = await getCsrfToken()
    const t2 = await getCsrfToken()
    expect(t1).toBe('token-from-csrfTokenFn')
    expect(t2).toBe('token-from-csrfTokenFn')
    expect(primary).toHaveBeenCalledTimes(1)
    expect(fallback).not.toHaveBeenCalled()
    expect(peekCsrfTokenCache()).toBe('token-from-csrfTokenFn')
  })

  it('falls back to meV3 when primary returns null/empty', async () => {
    setCsrfTokenFetchersForTests({
      primary: async () => null,
      fallback: async () => 'fallback-token',
    })
    await expect(getCsrfToken()).resolves.toBe('fallback-token')
    expect(peekCsrfTokenCache()).toBe('fallback-token')
  })

  it('throws CsrfClientError when both sources lack a token', async () => {
    setCsrfTokenFetchersForTests({
      primary: async () => null,
      fallback: async () => '   ',
    })
    await expect(getCsrfToken()).rejects.toMatchObject({
      name: 'CsrfClientError',
      code: 'CSRF_TOKEN_UNAVAILABLE',
    })
    await expect(getCsrfToken()).rejects.toBeInstanceOf(CsrfClientError)
    expect(peekCsrfTokenCache()).toBeNull()
  })

  it('coalesces concurrent first fetches (single primary call)', async () => {
    let resolvePrimary!: (v: string | null) => void
    const primary = vi.fn(
      () =>
        new Promise<string | null>((res) => {
          resolvePrimary = res
        }),
    )
    setCsrfTokenFetchersForTests({
      primary,
      fallback: async () => null,
    })

    const p1 = getCsrfToken()
    const p2 = getCsrfToken()
    expect(primary).toHaveBeenCalledTimes(1)
    resolvePrimary('shared-token')
    await expect(Promise.all([p1, p2])).resolves.toEqual(['shared-token', 'shared-token'])
    expect(primary).toHaveBeenCalledTimes(1)
  })

  it('clearCsrfTokenCache forces refetch', async () => {
    let n = 0
    setCsrfTokenFetchersForTests({
      primary: async () => `tok-${++n}`,
      fallback: async () => null,
    })
    expect(await getCsrfToken()).toBe('tok-1')
    clearCsrfTokenCache()
    expect(peekCsrfTokenCache()).toBeNull()
    expect(await getCsrfToken()).toBe('tok-2')
  })

  it('seedCsrfTokenCache avoids network until cleared', async () => {
    const primary = vi.fn(async () => 'network')
    setCsrfTokenFetchersForTests({ primary, fallback: async () => null })
    seedCsrfTokenCache('seeded')
    expect(await getCsrfToken()).toBe('seeded')
    expect(primary).not.toHaveBeenCalled()
  })
})

describe('csrf-client headers + serverFn call wrappers', () => {
  it('getCsrfHeaders uses x-csrf-token only (never body field)', async () => {
    seedCsrfTokenCache('hdr-token')
    const headers = await getCsrfHeaders()
    expect(headers).toEqual({ [CSRF_CLIENT_HEADER]: 'hdr-token' })
    expect(CSRF_CLIENT_HEADER).toBe('x-csrf-token')
    expect(Object.keys(headers)).toEqual(['x-csrf-token'])
  })

  it('withCsrfHeaders preserves data and attaches header', async () => {
    seedCsrfTokenCache('w-token')
    const out = await withCsrfHeaders({ data: { boardId: 'b1' } })
    expect(out.data).toEqual({ boardId: 'b1' })
    expect(out.headers['x-csrf-token']).toBe('w-token')
    // Token must not be copied into data.
    expect(JSON.stringify(out.data)).not.toContain('w-token')
  })

  it('csrfServerCall passes data + headers to fn', async () => {
    seedCsrfTokenCache('call-token')
    const fn = vi.fn(async (opts: { data: { id: string }; headers: Record<string, string> }) => {
      expect(opts.data).toEqual({ id: 'x' })
      expect(opts.headers['x-csrf-token']).toBe('call-token')
      return { ok: true as const }
    })
    await expect(csrfServerCall(fn, { id: 'x' })).resolves.toEqual({ ok: true })
    expect(fn).toHaveBeenCalledTimes(1)
  })

  it('csrfServerCallNoData passes headers only', async () => {
    seedCsrfTokenCache('logout-token')
    const fn = vi.fn(async (opts: { headers: Record<string, string> }) => {
      expect(opts.headers['x-csrf-token']).toBe('logout-token')
      return { ok: true as const }
    })
    await expect(csrfServerCallNoData(fn)).resolves.toEqual({ ok: true })
  })

  it('csrfServerCall fails closed when token unavailable (does not invoke fn)', async () => {
    setCsrfTokenFetchersForTests({
      primary: async () => null,
      fallback: async () => null,
    })
    const fn = vi.fn(async () => ({ ok: true as const }))
    await expect(csrfServerCall(fn, { id: 'x' })).rejects.toBeInstanceOf(CsrfClientError)
    expect(fn).not.toHaveBeenCalled()
  })
})
