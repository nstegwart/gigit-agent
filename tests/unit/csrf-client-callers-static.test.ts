/**
 * Static guard: browser cookie mutation call sites must route through csrf-client
 * (or an explicit csrfServerCall / getCsrfHeaders / withCsrfHeaders path).
 * loginFn / bootstrapFn must remain origin-only (no CSRF header attach).
 *
 * Support evidence only — does not exercise live CSRF handshake.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const root = join(dirname(fileURLToPath(import.meta.url)), '../..')

function readSrc(rel: string): string {
  return readFileSync(join(root, rel), 'utf8')
}

/** Token-required serverFns that have browser call sites in this app. */
const TOKEN_REQUIRED_FNS = [
  'logoutFn',
  'createUserFn',
  'setUserBoardsFn',
  'setUserRoleFn',
  'resetPasswordFn',
  'deleteUserFn',
  'createBoardFn',
  'toggleTaskFn',
  'addDesignLinkFn',
  'addCommentFn',
  'openDecisionFn',
  'decideDecisionFn',
  'clearBlockedFn',
  'setLifecycleFn',
  'advanceTaskFn',
  'toggleCheckpointFn',
] as const

const ORIGIN_ONLY_FNS = ['loginFn', 'bootstrapFn'] as const

const CSRF_WIRE_MARKERS = [
  'csrfServerCall',
  'csrfServerCallNoData',
  'getCsrfHeaders',
  'withCsrfHeaders',
  'CSRF_CLIENT_HEADER',
] as const

describe('csrf-client static caller guard', () => {
  const boardQuery = readSrc('src/lib/board-query.ts')
  const indexRoute = readSrc('src/routes/index.tsx')
  const rootRoute = readSrc('src/routes/__root.tsx')
  const csrfClient = readSrc('src/lib/csrf-client.ts')
  const combined = `${boardQuery}\n${indexRoute}`

  it('csrf-client exports fail-closed helpers and uses x-csrf-token header name', () => {
    expect(csrfClient).toMatch(/export async function getCsrfToken/)
    expect(csrfClient).toMatch(/export async function getCsrfHeaders/)
    expect(csrfClient).toMatch(/export async function csrfServerCall/)
    expect(csrfClient).toMatch(/export function clearCsrfTokenCache/)
    expect(csrfClient).toMatch(/CSRF_CLIENT_HEADER = 'x-csrf-token'/)
    expect(csrfClient).toMatch(/csrfTokenFn/)
    expect(csrfClient).toMatch(/meV3Fn/)
    // Never place token into URL construction helpers.
    expect(csrfClient).not.toMatch(/URLSearchParams/)
    expect(csrfClient).not.toMatch(/searchParams/)
    expect(csrfClient).not.toMatch(/location\.href/)
    expect(csrfClient).not.toMatch(/new URL\(/)
  })

  it('board-query imports csrf-client and clears cache on logout path', () => {
    expect(boardQuery).toMatch(/from '\.\/csrf-client'/)
    expect(boardQuery).toMatch(/clearCsrfTokenCache/)
    expect(boardQuery).toMatch(/csrfServerCallNoData\(logoutFn\)/)
  })

  it('loginFn and bootstrapFn stay origin-only (no csrfServerCall wrap)', () => {
    for (const fn of ORIGIN_ONLY_FNS) {
      expect(combined).toMatch(new RegExp(`${fn}\\(\\{\\s*data:`))
      expect(combined).not.toMatch(new RegExp(`csrfServerCall\\(\\s*${fn}`))
      expect(combined).not.toMatch(new RegExp(`${fn}\\(\\{[^}]*headers`))
    }
    // Explicit comments document origin-only contract near the mutations.
    expect(boardQuery).toMatch(/Origin-only:[\s\S]{0,200}loginFn/)
    expect(boardQuery).toMatch(/Origin-only:[\s\S]{0,200}bootstrapFn/)
  })

  it('every token-required browser call site is CSRF-wired', () => {
    const missing: string[] = []
    for (const fn of TOKEN_REQUIRED_FNS) {
      // Direct raw call without csrf helper nearby is forbidden for these Fns.
      const rawCall = new RegExp(`${fn}\\(\\s*\\{|${fn}\\(\\s*\\)`, 'g')
      const csrfWrapped = new RegExp(
        `csrfServerCall(?:NoData)?\\(\\s*${fn}|${fn}[\\s\\S]{0,120}headers`,
      )
      // Prefer csrfServerCall(fn, ...) pattern used by this wiring.
      const viaHelper = combined.includes(`csrfServerCall(${fn}`) || combined.includes(`csrfServerCallNoData(${fn}`)
      if (!viaHelper) {
        // Fallback: allow explicit headers on the call if somehow present.
        const sites = combined.match(rawCall) ?? []
        if (sites.length === 0 || !csrfWrapped.test(combined)) {
          missing.push(fn)
        }
      }
    }
    expect(missing, `unwired token-required Fns: ${missing.join(', ')}`).toEqual([])
    expect(TOKEN_REQUIRED_FNS.length).toBe(16)
  })

  it('createBoardFn on home route is CSRF-wired', () => {
    expect(indexRoute).toMatch(/csrfServerCall\(createBoardFn/)
    expect(indexRoute).toMatch(/from '#\/lib\/csrf-client'/)
  })

  it('root route warms/clears CSRF only in browser (no SSR cache seed)', () => {
    expect(rootRoute).toMatch(/getCsrfToken/)
    expect(rootRoute).toMatch(/clearCsrfTokenCache/)
    expect(rootRoute).toMatch(/typeof window !== 'undefined'/)
  })

  it('no token-required raw serverFn call bypasses csrf helper in board-query/index', () => {
    // Strip comments to reduce false positives, then ban patterns like:
    //   toggleTaskFn({ data: ... }) without csrfServerCall
    const stripComments = (s: string) =>
      s.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '')
    const src = stripComments(combined)
    for (const fn of TOKEN_REQUIRED_FNS) {
      // Ban: any `fn(` that is not the argument to csrfServerCall / csrfServerCallNoData.
      const occurrences: string[] = []
      const re = new RegExp(`\\b${fn}\\s*\\(`, 'g')
      let m: RegExpExecArray | null
      while ((m = re.exec(src)) !== null) {
        const before = src.slice(Math.max(0, m.index - 48), m.index)
        if (!/csrfServerCall(?:NoData)?\s*\(\s*$/.test(before)) {
          occurrences.push(`${fn}@${m.index}`)
        }
      }
      expect(occurrences, `raw calls for ${fn}: ${occurrences.join(', ')}`).toEqual([])
    }
  })

  it('csrf wire markers present for shared choke points', () => {
    for (const marker of CSRF_WIRE_MARKERS) {
      if (marker === 'getCsrfHeaders' || marker === 'withCsrfHeaders' || marker === 'CSRF_CLIENT_HEADER') {
        expect(csrfClient).toContain(marker)
      }
    }
    expect(boardQuery).toContain('csrfServerCall')
    expect(boardQuery).toContain('csrfServerCallNoData')
  })
})
