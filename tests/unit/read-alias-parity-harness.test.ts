/**
 * Unit suite for qa/e2e/flows/read-alias-parity.mjs
 *
 * Cross-checks the harness matrix + pure checks against real product modules:
 *   - #/server/mcp-canonical-reads (alias map, envelope, filters, cursor)
 *   - #/server/rbac (aliasOf + scopes)
 *   - #/server/cursor (default 50 / max 200)
 *
 * Runs harness self-test offline. No live mutation / no network.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import {
  COMPATIBILITY_ALIAS_MAP,
  COMPATIBILITY_ALIAS_NAMES,
  DEFAULT_PAGE_SIZE as SRV_DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE as SRV_MAX_PAGE_SIZE,
  MCP_READ_CONTRACT_VERSION as SRV_CONTRACT,
  MCP_READ_CURSOR_ORDER as SRV_CURSOR_ORDER,
  TM_PINNED_ENVELOPE_V1 as SRV_ENVELOPE,
  buildPinnedReadEnvelope,
  encodeReadCursor,
  resolveCanonicalReadMethod,
  validateReadFilters,
  type McpReadPin,
} from '#/server/mcp-canonical-reads'
import {
  DEFAULT_PAGE_SIZE as CURSOR_DEFAULT,
  MAX_PAGE_SIZE as CURSOR_MAX,
  resolvePageSize as cursorResolvePageSize,
} from '#/server/cursor'
import { getToolSpec } from '#/server/rbac'

import {
  COMPATIBILITY_ALIAS_MATRIX,
  CONTRACT_ID,
  DEFAULT_PAGE_SIZE,
  HARNESS_ID,
  MAX_PAGE_SIZE,
  MCP_READ_CONTRACT_VERSION,
  MCP_READ_CURSOR_ORDER,
  PRIMARY_OVERVIEW_ALIASES,
  TM_PINNED_ENVELOPE_V1,
  assertAuthParity,
  assertEnvelopeParity,
  assertNoIndependentRecompute,
  assertPinnedEnvelopeShape,
  baseFixturePin,
  buildFixturePinnedEnvelope,
  decodeCursorFixture,
  encodeCursorFixture,
  resolveAliasEntry,
  resolveCanonicalMethod,
  resolvePageSize,
  runSelfTest,
  scopesEqual,
  summarize,
  validateSharedFilters,
} from '../../qa/e2e/flows/read-alias-parity.mjs'

function serverPin(over: Partial<McpReadPin> = {}): McpReadPin {
  return {
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'pin-mfs-rebuild-alias-parity',
    canonicalHash: 'b'.repeat(64),
    boardRev: 42,
    lifecycleRev: 7,
    generatedAt: '2026-07-14T04:34:07.000Z',
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
    ...over,
  }
}

describe('harness identity + matrix vs product', () => {
  it('exports stable harness/contract ids', () => {
    expect(HARNESS_ID).toBe('read-alias-parity-v1')
    expect(CONTRACT_ID).toBe('TM_MCP_READ_ALIAS_PARITY_V1')
  })

  it('cursor constants match cursor.ts + mcp-canonical-reads', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50)
    expect(MAX_PAGE_SIZE).toBe(200)
    expect(DEFAULT_PAGE_SIZE).toBe(SRV_DEFAULT_PAGE_SIZE)
    expect(MAX_PAGE_SIZE).toBe(SRV_MAX_PAGE_SIZE)
    expect(DEFAULT_PAGE_SIZE).toBe(CURSOR_DEFAULT)
    expect(MAX_PAGE_SIZE).toBe(CURSOR_MAX)
    expect(MCP_READ_CURSOR_ORDER).toBe(SRV_CURSOR_ORDER)
    expect(MCP_READ_CURSOR_ORDER).toBe('createdAt DESC, id DESC')
    expect(TM_PINNED_ENVELOPE_V1).toBe(SRV_ENVELOPE)
    expect(MCP_READ_CONTRACT_VERSION).toBe(SRV_CONTRACT)
  })

  it('PRIMARY_OVERVIEW_ALIASES is get_rollup/get_lifecycle/get_board_hash', () => {
    expect([...PRIMARY_OVERVIEW_ALIASES].sort()).toEqual(
      ['get_board_hash', 'get_lifecycle', 'get_rollup'].sort(),
    )
  })

  it('harness matrix covers full COMPATIBILITY_ALIAS_MAP names', () => {
    const harnessNames = COMPATIBILITY_ALIAS_MATRIX.map((e) => e.alias).sort()
    expect(harnessNames).toEqual([...COMPATIBILITY_ALIAS_NAMES].sort())
  })

  it.each(COMPATIBILITY_ALIAS_MATRIX)(
    'harness entry $alias matches COMPATIBILITY_ALIAS_MAP + rbac',
    (entry) => {
      const srv = COMPATIBILITY_ALIAS_MAP[entry.alias as keyof typeof COMPATIBILITY_ALIAS_MAP]
      expect(srv).toBeTruthy()
      expect(srv.resolvesTo).toBe(entry.resolvesTo)
      expect(srv.slice).toBe(entry.slice)

      expect(resolveCanonicalMethod(entry.alias)).toBe(entry.resolvesTo)
      expect(resolveCanonicalReadMethod(entry.alias)).toBe(entry.resolvesTo)

      const spec = getToolSpec(entry.alias)
      expect(spec).toBeTruthy()
      expect(spec!.aliasOf).toBe(entry.resolvesTo)
      expect(scopesEqual(spec!.scopes, entry.scopes)).toBe(true)

      const target = getToolSpec(entry.resolvesTo)
      expect(target).toBeTruthy()
      expect(scopesEqual(spec!.scopes, target!.scopes)).toBe(true)

      const auth = assertAuthParity(
        { name: entry.alias, scopes: [...spec!.scopes], aliasOf: spec!.aliasOf, kind: spec!.kind },
        {
          name: entry.resolvesTo,
          scopes: [...target!.scopes],
          kind: target!.kind,
        },
        entry,
      )
      expect(auth.ok).toBe(true)
    },
  )
})

describe('pinned envelope parity (product builder + harness)', () => {
  it('get_overview + primary aliases share pin identity and method metadata', () => {
    const pin = serverPin()
    const overviewData = {
      projects: 3,
      rollup: { readinessPercent: 44, active: 5 },
      lifecycleStages: 9,
    }
    const overview = buildPinnedReadEnvelope(pin, overviewData, { method: 'get_overview' })
    expect(overview.method).toBe('get_overview')
    expect(overview.requestedAs).toBe('get_overview')
    expect(overview.contractVersion).toBe(SRV_CONTRACT)
    expect(overview.nextCursor).toBeNull()

    for (const alias of PRIMARY_OVERVIEW_ALIASES) {
      const entry = resolveAliasEntry(alias)!
      let data: Record<string, unknown>
      if (entry.slice === 'rollup') data = { rollup: overviewData.rollup }
      else if (entry.slice === 'lifecycle') data = { lifecycle: { stages: 9 } }
      else data = { hash: pin.canonicalHash, boardId: pin.boardId }

      const srvEnv = buildPinnedReadEnvelope(pin, data, { method: alias })
      expect(srvEnv.method).toBe('get_overview')
      expect(srvEnv.requestedAs).toBe(alias)
      expect(srvEnv.canonicalHash).toBe(overview.canonicalHash)
      expect(srvEnv.boardRev).toBe(overview.boardRev)
      expect(srvEnv.lifecycleRev).toBe(overview.lifecycleRev)
      expect(srvEnv.nextCursor).toBeNull()

      const harnessEnv = buildFixturePinnedEnvelope(baseFixturePin(), data, { method: alias })
      const parity = assertEnvelopeParity(
        harnessEnv as Record<string, unknown>,
        buildFixturePinnedEnvelope(baseFixturePin(), overviewData, {
          method: 'get_overview',
        }) as Record<string, unknown>,
        entry,
      )
      expect(parity.ok).toBe(true)
    }
  })

  it('does not recompute injected counts (product + harness)', () => {
    const pin = serverPin()
    const pre = Object.freeze({
      readinessPercent: 12.5,
      counts: Object.freeze({ DONE: 1, NEXT: 2 }),
      source: 'precomputed' as const,
    })
    const env = buildPinnedReadEnvelope(pin, pre, { method: 'get_rollup' })
    expect(env.data).toBe(pre)
    expect(env.data).toEqual(pre)

    const h = assertNoIndependentRecompute(baseFixturePin(), { ...pre }, 'get_rollup')
    expect(h.ok).toBe(true)
  })

  it('get aliases force nextCursor null even if hostile token supplied', () => {
    const pin = serverPin()
    const token = encodeReadCursor({
      createdAt: '2026-07-14T01:00:00.000Z',
      id: 'row-1',
      boardRev: pin.boardRev,
      snapshotRev: null,
      order: 'DESC',
    })
    for (const alias of PRIMARY_OVERVIEW_ALIASES) {
      const env = buildPinnedReadEnvelope(pin, { x: 1 }, { method: alias, nextCursor: token })
      expect(env.nextCursor).toBeNull()
    }
  })
})

describe('filters + cursor (shared path)', () => {
  it('alias filter validation resolves to target allowlist (product)', () => {
    for (const alias of PRIMARY_OVERVIEW_ALIASES) {
      const ok = validateReadFilters(alias, { boardId: 'mfs-rebuild' })
      expect(ok.boardId).toBe('mfs-rebuild')
      expect(() =>
        validateReadFilters(alias, { boardId: 'mfs-rebuild', inventCounts: true }),
      ).toThrow()
      // same class as canonical
      expect(() =>
        validateReadFilters('get_overview', { boardId: 'mfs-rebuild', inventCounts: true }),
      ).toThrow()
    }
  })

  it('harness validateSharedFilters matches product reject class', () => {
    for (const alias of PRIMARY_OVERVIEW_ALIASES) {
      expect(validateSharedFilters(alias, { boardId: 'mfs-rebuild' }).ok).toBe(true)
      const bad = validateSharedFilters(alias, { boardId: 'mfs-rebuild', inventCounts: true })
      expect(bad.ok).toBe(false)
      expect(bad.errors[0]).toContain('inventCounts')
    }
  })

  it('createdAt+id cursor default50/max200 (cursor.ts + harness)', () => {
    expect(cursorResolvePageSize(null)).toBe(50)
    expect(cursorResolvePageSize(undefined)).toBe(50)
    expect(cursorResolvePageSize(200)).toBe(200)
    expect(() => cursorResolvePageSize(201)).toThrow()
    expect(resolvePageSize(null)).toBe(50)
    expect(resolvePageSize(200)).toBe(200)
    expect(() => resolvePageSize(201)).toThrow()
  })

  it('fixture cursor encode/decode is createdAt+id DESC with boardRev pin', () => {
    const token = encodeCursorFixture({
      createdAt: '2026-07-14T01:00:00.000Z',
      id: 'row-1',
      boardRev: 42,
    })
    // same wire format as product cursor.ts
    const productToken = encodeReadCursor({
      createdAt: '2026-07-14T01:00:00.000Z',
      id: 'row-1',
      boardRev: 42,
      snapshotRev: null,
      order: 'DESC',
    })
    expect(token).toBe(productToken)
    const d = decodeCursorFixture(token)
    expect(d).toEqual({
      createdAt: '2026-07-14T01:00:00.000Z',
      id: 'row-1',
      boardRev: 42,
      snapshotRev: null,
      order: 'DESC',
    })
  })

  it('product encodeReadCursor mac matches harness algorithm', () => {
    const body = JSON.stringify({
      createdAt: 't',
      id: 'i',
      boardRev: 1,
      snapshotRev: null,
      order: 'DESC',
    })
    const mac = createHash('sha256').update(`cairn-cursor|${body}`).digest('hex').slice(0, 16)
    expect(mac).toHaveLength(16)
  })
})

describe('runSelfTest (offline)', () => {
  it('all self-test checks pass', () => {
    const results = runSelfTest({ silent: true })
    const failed = results.filter((r) => !r.ok)
    expect(failed, JSON.stringify(failed, null, 2)).toEqual([])
    expect(results.length).toBeGreaterThan(20)
    const summary = summarize(results, 'fixture')
    expect(summary.passed).toBe(summary.total)
    expect(summary.failed).toEqual([])
    expect(summary.residual_gaps).toContain('LIVE HTTP')
  })

  it('shape check rejects incomplete envelopes', () => {
    const bad = assertPinnedEnvelopeShape({ schemaVersion: 'NOPE' })
    expect(bad.ok).toBe(false)
  })
})
