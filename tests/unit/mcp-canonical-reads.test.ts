import { describe, expect, it } from 'vitest'

import {
  CANONICAL_GET_METHODS,
  CANONICAL_LIST_METHODS,
  CANONICAL_READ_METHODS,
  COMPATIBILITY_ALIAS_MAP,
  COMPATIBILITY_ALIAS_NAMES,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  MCP_READ_CONTRACT_VERSION,
  MCP_READ_CURSOR_ORDER,
  McpReadContractError,
  PINNED_ENVELOPE_REQUIRED_KEYS,
  TM_PINNED_ENVELOPE_V1,
  allPinnedReadMethodNames,
  assertMcpReadPin,
  assertPinnedEnvelopeShape,
  boundListPayload,
  buildListReadEnvelope,
  buildPinnedReadEnvelope,
  decodeReadCursor,
  encodeReadCursor,
  getCanonicalReadMethodSpec,
  isCanonicalListMethod,
  isCanonicalReadMethod,
  isCompatibilityAlias,
  listAllCanonicalReadMethodSpecs,
  paginateReadRows,
  requireBoundedPageSize,
  resolveCanonicalReadMethod,
  resolveCompatibilityAlias,
  resolveReadPagination,
  validateNextCursorForPin,
  validateReadFilters,
  type McpPinnedReadEnvelope,
  type McpReadPin,
} from '#/server/mcp-canonical-reads'

function basePin(over: Partial<McpReadPin> = {}): McpReadPin {
  return {
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'pin-mfs-rebuild-abcdef01',
    canonicalHash: 'a'.repeat(64),
    boardRev: 12,
    lifecycleRev: 3,
    generatedAt: '2026-07-13T19:44:51.000Z',
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
    ...over,
  }
}

describe('canonical method registry', () => {
  it('exports exact API_CONTRACT §2 method set (20 methods)', () => {
    expect([...CANONICAL_READ_METHODS]).toEqual([
      'get_overview',
      'list_work_items',
      'list_projects',
      'get_project',
      'list_features',
      'get_feature',
      'list_tasks',
      'get_task',
      'list_runs',
      'get_run',
      'list_accounts',
      'get_account',
      'list_decisions',
      'get_decision',
      'list_activity',
      'list_audit',
      'get_priority_portfolio',
      'get_g5',
      'get_prod',
      'get_guide',
    ])
    expect(CANONICAL_READ_METHODS).toHaveLength(20)
  })

  it('partitions list vs get without overlap', () => {
    const lists = new Set(CANONICAL_LIST_METHODS)
    const gets = new Set(CANONICAL_GET_METHODS)
    for (const m of CANONICAL_READ_METHODS) {
      expect(lists.has(m as never) || gets.has(m as never)).toBe(true)
      expect(lists.has(m as never) && gets.has(m as never)).toBe(false)
    }
    expect(lists.size + gets.size).toBe(CANONICAL_READ_METHODS.length)
  })

  it('isCanonicalReadMethod / isCanonicalListMethod', () => {
    expect(isCanonicalReadMethod('get_overview')).toBe(true)
    expect(isCanonicalReadMethod('get_rollup')).toBe(false)
    expect(isCanonicalListMethod('list_work_items')).toBe(true)
    expect(isCanonicalListMethod('get_overview')).toBe(false)
  })
})

describe('compatibility alias map', () => {
  it('maps get_rollup/get_lifecycle/get_board_hash/get_work/get_priority', () => {
    expect(COMPATIBILITY_ALIAS_NAMES.sort()).toEqual(
      ['get_board_hash', 'get_lifecycle', 'get_priority', 'get_rollup', 'get_work'].sort(),
    )
    expect(COMPATIBILITY_ALIAS_MAP.get_rollup.resolvesTo).toBe('get_overview')
    expect(COMPATIBILITY_ALIAS_MAP.get_lifecycle.resolvesTo).toBe('get_overview')
    expect(COMPATIBILITY_ALIAS_MAP.get_board_hash.resolvesTo).toBe('get_overview')
    expect(COMPATIBILITY_ALIAS_MAP.get_work.resolvesTo).toBe('list_work_items')
    expect(COMPATIBILITY_ALIAS_MAP.get_priority.resolvesTo).toBe('get_priority_portfolio')
  })

  it('resolveCanonicalReadMethod maps aliases and identity', () => {
    expect(resolveCanonicalReadMethod('get_overview')).toBe('get_overview')
    expect(resolveCanonicalReadMethod('get_rollup')).toBe('get_overview')
    expect(resolveCanonicalReadMethod('get_work')).toBe('list_work_items')
    expect(resolveCanonicalReadMethod('get_priority')).toBe('get_priority_portfolio')
    expect(resolveCanonicalReadMethod('not_a_tool')).toBeNull()
  })

  it('isCompatibilityAlias + resolveCompatibilityAlias', () => {
    expect(isCompatibilityAlias('get_rollup')).toBe(true)
    expect(isCompatibilityAlias('get_overview')).toBe(false)
    const entry = resolveCompatibilityAlias('get_work')
    expect(entry?.slice).toBe('work')
    expect(entry?.resolvesTo).toBe('list_work_items')
    expect(resolveCompatibilityAlias('get_task')).toBeNull()
  })

  it('allPinnedReadMethodNames = canonical ∪ aliases, no dups', () => {
    const all = allPinnedReadMethodNames()
    expect(new Set(all).size).toBe(all.length)
    expect(all).toHaveLength(CANONICAL_READ_METHODS.length + COMPATIBILITY_ALIAS_NAMES.length)
  })
})

describe('pinned envelope builder', () => {
  it('builds TM_PINNED_ENVELOPE_V1 with all required keys', () => {
    const pin = basePin()
    const data = { readyPercent: 42, buckets: { DONE: 1 } }
    const env = buildPinnedReadEnvelope(pin, data, { method: 'get_overview' })
    expect(env.schemaVersion).toBe(TM_PINNED_ENVELOPE_V1)
    expect(env.contractVersion).toBe(MCP_READ_CONTRACT_VERSION)
    expect(env.method).toBe('get_overview')
    expect(env.requestedAs).toBe('get_overview')
    expect(env.data).toEqual(data)
    expect(env.nextCursor).toBeNull()
    for (const key of PINNED_ENVELOPE_REQUIRED_KEYS) {
      expect(env).toHaveProperty(key)
    }
    assertPinnedEnvelopeShape(env)
  })

  it('alias request records requestedAs + resolved method', () => {
    const env = buildPinnedReadEnvelope(basePin(), { hash: 'abc' }, { method: 'get_board_hash' })
    expect(env.method).toBe('get_overview')
    expect(env.requestedAs).toBe('get_board_hash')
  })

  it('forces nextCursor null on get methods even if supplied', () => {
    const env = buildPinnedReadEnvelope(basePin(), { g5Pass: false }, {
      method: 'get_g5',
      nextCursor: 'should-be-ignored',
    })
    expect(env.nextCursor).toBeNull()
  })

  it('preserves validated nextCursor on list methods (pin-matching opaque token)', () => {
    const pin = basePin()
    const token = encodeReadCursor({
      createdAt: '2026-07-13T05:00:00.000Z',
      id: 'row-1',
      boardRev: pin.boardRev,
      snapshotRev: null,
      order: 'DESC',
    })
    const env = buildPinnedReadEnvelope(pin, { items: [] }, {
      method: 'list_tasks',
      nextCursor: token,
    })
    expect(env.nextCursor).toBe(token)
  })

  it('rejects incomplete pin', () => {
    expect(() => assertMcpReadPin(basePin({ boardId: '' }))).toThrow(McpReadContractError)
    try {
      buildPinnedReadEnvelope(basePin({ canonicalHash: '' }), {}, { method: 'get_prod' })
    } catch (e) {
      expect(e).toBeInstanceOf(McpReadContractError)
      expect((e as McpReadContractError).code).toBe('PIN_INCOMPLETE')
    }
  })

  it('rejects unknown method names', () => {
    expect(() =>
      buildPinnedReadEnvelope(basePin(), {}, { method: 'invent_counts' }),
    ).toThrow(McpReadContractError)
  })

  it('never mutates injected data (no recompute)', () => {
    const data = { readinessPercent: 12.5, source: 'precomputed' as const }
    const frozen = Object.freeze({ ...data })
    const env = buildPinnedReadEnvelope(basePin(), frozen, { method: 'get_overview' })
    expect(env.data).toBe(frozen)
    expect(env.data).toEqual({ readinessPercent: 12.5, source: 'precomputed' })
  })
})

describe('filter validation (fail-closed)', () => {
  it('requires boardId', () => {
    expect(() => validateReadFilters('get_overview', {})).toThrow(McpReadContractError)
    try {
      validateReadFilters('get_overview', { boardId: '' })
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('MISSING_BOARD_ID')
    }
  })

  it('rejects unknown filter keys', () => {
    expect(() =>
      validateReadFilters('get_overview', { boardId: 'mfs-rebuild', invent: true }),
    ).toThrow(/unknown filter key/)
  })

  it('validates list_work_items bucket enum', () => {
    const ok = validateReadFilters('list_work_items', {
      boardId: 'mfs-rebuild',
      bucket: 'ONGOING',
      pageSize: 50,
    })
    expect(ok).toMatchObject({ boardId: 'mfs-rebuild', bucket: 'ONGOING', pageSize: 50 })
    expect(() =>
      validateReadFilters('list_work_items', { boardId: 'mfs-rebuild', bucket: 'NOT_A_BUCKET' }),
    ).toThrow(McpReadContractError)
  })

  it('rejects pageSize > 200 (fail-closed, no clamp)', () => {
    try {
      validateReadFilters('list_tasks', { boardId: 'b1', pageSize: 201 })
    } catch (e) {
      expect(e).toBeInstanceOf(McpReadContractError)
      expect((e as McpReadContractError).code).toBe('PAGE_SIZE_INVALID')
    }
  })

  it('accepts alias names and validates against resolved method', () => {
    const f = validateReadFilters('get_work', {
      boardId: 'mfs-rebuild',
      bucket: 'NEXT',
      staleFamily: true,
    })
    expect(f).toMatchObject({ boardId: 'mfs-rebuild', bucket: 'NEXT', staleFamily: true })
  })

  it('requires entity id for get_project / get_task / get_run / get_account / get_decision / get_feature', () => {
    for (const method of [
      'get_project',
      'get_feature',
      'get_task',
      'get_run',
      'get_account',
      'get_decision',
    ] as const) {
      expect(() => validateReadFilters(method, { boardId: 'b1' })).toThrow(McpReadContractError)
    }
    expect(validateReadFilters('get_project', { boardId: 'b1', projectId: 'p1' })).toMatchObject({
      id: 'p1',
    })
    expect(validateReadFilters('get_task', { boardId: 'b1', id: 't9' })).toMatchObject({ id: 't9' })
    expect(validateReadFilters('get_run', { boardId: 'b1', runId: 'r1' })).toMatchObject({
      id: 'r1',
    })
    expect(validateReadFilters('get_account', { boardId: 'b1', accountId: 'a1' })).toMatchObject({
      id: 'a1',
    })
    expect(validateReadFilters('get_decision', { boardId: 'b1', decisionId: 'd1' })).toMatchObject({
      id: 'd1',
    })
    expect(validateReadFilters('get_feature', { boardId: 'b1', featureId: 'f1' })).toMatchObject({
      id: 'f1',
    })
  })

  it('list_runs / list_accounts / list_decisions / list_tasks optional filters', () => {
    expect(
      validateReadFilters('list_runs', { boardId: 'b', status: 'active', taskId: 't1' }),
    ).toMatchObject({ status: 'active', taskId: 't1' })
    expect(
      validateReadFilters('list_accounts', { boardId: 'b', provider: 'grok', status: 'OK' }),
    ).toMatchObject({ provider: 'grok', status: 'OK' })
    expect(
      validateReadFilters('list_decisions', { boardId: 'b', openOnly: true, blocking: false }),
    ).toMatchObject({ openOnly: true, blocking: false })
    expect(
      validateReadFilters('list_tasks', {
        boardId: 'b',
        projectId: 'p',
        featureId: 'f',
        stage: 'READY_PROD',
      }),
    ).toMatchObject({ projectId: 'p', featureId: 'f', stage: 'READY_PROD' })
  })

  it('unknown method is fail-closed', () => {
    try {
      validateReadFilters('compute_my_own_rollup', { boardId: 'b' })
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('UNKNOWN_METHOD')
    }
  })
})

describe('pagination: createdAt,id default50 max200', () => {
  it('defaults page size 50 and max 200', () => {
    expect(DEFAULT_PAGE_SIZE).toBe(50)
    expect(MAX_PAGE_SIZE).toBe(200)
    expect(MCP_READ_CURSOR_ORDER).toBe('createdAt DESC, id DESC')
    const page = resolveReadPagination({ expectedBoardRev: 1, expectedSnapshotRev: null })
    expect(page.pageSize).toBe(50)
    expect(page.cursor).toBeNull()
  })

  it('rejects oversize pageSize', () => {
    expect(() =>
      resolveReadPagination({ expectedBoardRev: 1, pageSize: 201 }),
    ).toThrow(McpReadContractError)
  })

  it('paginateReadRows walks pages with opaque nextCursor (createdAt,id DESC)', () => {
    const rows = [
      { createdAt: '2026-07-13T05:00:00.000Z', id: 'e', title: 'e' },
      { createdAt: '2026-07-13T04:00:00.000Z', id: 'd', title: 'd' },
      { createdAt: '2026-07-13T03:00:00.000Z', id: 'c', title: 'c' },
      { createdAt: '2026-07-13T02:00:00.000Z', id: 'b', title: 'b' },
      { createdAt: '2026-07-13T01:00:00.000Z', id: 'a', title: 'a' },
    ]
    const p1 = paginateReadRows(rows, {
      expectedBoardRev: 7,
      expectedSnapshotRev: 'snap-1',
      pageSize: 2,
    })
    expect(p1.items.map((r) => r.id)).toEqual(['e', 'd'])
    expect(p1.nextCursor).toBeTruthy()
    expect(p1.pageSize).toBe(2)

    const p2 = paginateReadRows(rows, {
      expectedBoardRev: 7,
      expectedSnapshotRev: 'snap-1',
      pageSize: 2,
      cursor: p1.nextCursor,
    })
    expect(p2.items.map((r) => r.id)).toEqual(['c', 'b'])

    const p3 = paginateReadRows(rows, {
      expectedBoardRev: 7,
      expectedSnapshotRev: 'snap-1',
      pageSize: 2,
      cursor: p2.nextCursor,
    })
    expect(p3.items.map((r) => r.id)).toEqual(['a'])
    expect(p3.nextCursor).toBeNull()
  })

  it('encodeReadCursor is deterministic', () => {
    const a = encodeReadCursor({
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 't1',
      boardRev: 3,
      snapshotRev: null,
      order: 'DESC',
    })
    const b = encodeReadCursor({
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 't1',
      boardRev: 3,
      snapshotRev: null,
      order: 'DESC',
    })
    expect(a).toBe(b)
    expect(a.startsWith('v1.')).toBe(true)
  })
})

describe('bounded payload', () => {
  it('accepts items within pageSize and rejects overflow', () => {
    const items = Array.from({ length: 3 }, (_, i) => ({ id: String(i) }))
    expect(boundListPayload(items, 3)).toBe(items)
    expect(boundListPayload(items, 50)).toHaveLength(3)
    expect(() => boundListPayload(items, 2)).toThrow(McpReadContractError)
    try {
      boundListPayload(items, 2)
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('PAYLOAD_UNBOUNDED')
    }
  })

  it('rejects pageSize above MAX', () => {
    expect(() => boundListPayload([], 201)).toThrow(McpReadContractError)
  })

  it('buildListReadEnvelope wraps bounded items under data', () => {
    const items = [
      { createdAt: '2026-07-13T01:00:00.000Z', id: '1' },
      { createdAt: '2026-07-13T00:00:00.000Z', id: '2' },
    ]
    const env = buildListReadEnvelope(basePin(), 'list_work_items', items, {
      pageSize: 50,
      nextCursor: null,
    })
    expect(env.method).toBe('list_work_items')
    expect(env.schemaVersion).toBe(TM_PINNED_ENVELOPE_V1)
    expect(env.data.items).toHaveLength(2)
    expect(env.data.pageSize).toBe(50)
    expect(env.nextCursor).toBeNull()
  })

  it('buildListReadEnvelope accepts get_work alias → list_work_items', () => {
    const env = buildListReadEnvelope(basePin(), 'get_work', [], { pageSize: 50 })
    expect(env.method).toBe('list_work_items')
    expect(env.requestedAs).toBe('get_work')
  })

  it('buildListReadEnvelope rejects non-list methods', () => {
    expect(() => buildListReadEnvelope(basePin(), 'get_g5', [])).toThrow(McpReadContractError)
  })
})

describe('method specs introspection', () => {
  it('every canonical method has a spec with cursor defaults', () => {
    const specs = listAllCanonicalReadMethodSpecs()
    expect(specs).toHaveLength(20)
    for (const s of specs) {
      expect(s.defaultPageSize).toBe(50)
      expect(s.maxPageSize).toBe(200)
      expect(s.cursorOrder).toBe('createdAt DESC, id DESC')
      expect(s.envelopeSchema).toBe(TM_PINNED_ENVELOPE_V1)
      expect(s.supportsCursor).toBe(s.kind === 'list')
    }
    const work = getCanonicalReadMethodSpec('list_work_items')
    expect(work.aliases).toContain('get_work')
    const overview = getCanonicalReadMethodSpec('get_overview')
    expect(overview.aliases).toEqual(
      expect.arrayContaining(['get_rollup', 'get_lifecycle', 'get_board_hash']),
    )
    const prio = getCanonicalReadMethodSpec('get_priority_portfolio')
    expect(prio.aliases).toEqual(['get_priority'])
  })
})

// ---------------------------------------------------------------------------
// Hostile: envelope typed validation + cursor/nextCursor (not key-only)
// ---------------------------------------------------------------------------
describe('hostile envelope + nextCursor validation', () => {
  function validOpaque(boardRev: number, snapshotRev: string | null = null): string {
    return encodeReadCursor({
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 'hostile-row',
      boardRev,
      snapshotRev,
      order: 'DESC',
    })
  }

  it('assertPinnedEnvelopeShape rejects wrong types (not key-only)', () => {
    const good = buildPinnedReadEnvelope(basePin(), { ok: true }, { method: 'get_overview' })
    assertPinnedEnvelopeShape(good)

    const badBoardRev = { ...good, boardRev: '12' as unknown as number }
    expect(() => assertPinnedEnvelopeShape(badBoardRev as McpPinnedReadEnvelope<unknown>)).toThrow(
      McpReadContractError,
    )
    try {
      assertPinnedEnvelopeShape(badBoardRev as McpPinnedReadEnvelope<unknown>)
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('PIN_INCOMPLETE')
      expect((e as McpReadContractError).message).toMatch(/boardRev/)
    }

    const badStale = { ...good, stale: 'yes' as unknown as boolean }
    expect(() => assertPinnedEnvelopeShape(badStale as McpPinnedReadEnvelope<unknown>)).toThrow(
      /stale must be boolean/,
    )

    const badSchema = { ...good, schemaVersion: 'TM_PINNED_ENVELOPE_V0' as typeof TM_PINNED_ENVELOPE_V1 }
    expect(() => assertPinnedEnvelopeShape(badSchema as McpPinnedReadEnvelope<unknown>)).toThrow(
      /schemaVersion/,
    )

    const emptyBoard = { ...good, boardId: '   ' }
    expect(() => assertPinnedEnvelopeShape(emptyBoard as McpPinnedReadEnvelope<unknown>)).toThrow(
      /boardId/,
    )

    const badFresh = { ...good, freshnessAgeSeconds: Number.NaN }
    expect(() => assertPinnedEnvelopeShape(badFresh as McpPinnedReadEnvelope<unknown>)).toThrow(
      /freshnessAgeSeconds/,
    )
  })

  it('rejects malformed nextCursor (no arbitrary passthrough)', () => {
    const pin = basePin()
    for (const bad of ['v1.cursor.token', 'not-a-cursor', '', '   ', 42, { evil: true }, 'v1.only.two']) {
      expect(() =>
        buildPinnedReadEnvelope(pin, { items: [] }, {
          method: 'list_work_items',
          nextCursor: bad as string,
        }),
      ).toThrow(McpReadContractError)
      try {
        validateNextCursorForPin(bad, pin)
      } catch (e) {
        expect(e).toBeInstanceOf(McpReadContractError)
        expect((e as McpReadContractError).code).toBe('CURSOR_INVALID')
      }
    }
  })

  it('rejects foreign nextCursor (boardRev mismatch)', () => {
    const pin = basePin({ boardRev: 12 })
    const foreign = validOpaque(99) // different board revision
    expect(() =>
      buildPinnedReadEnvelope(pin, { items: [] }, {
        method: 'list_tasks',
        nextCursor: foreign,
      }),
    ).toThrow(McpReadContractError)
    try {
      validateNextCursorForPin(foreign, pin)
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('CURSOR_INVALID')
      expect((e as McpReadContractError).message).toMatch(/boardRev|mismatch|revision/i)
      expect((e as McpReadContractError).details.cursorCode).toBe('CURSOR_REVISION_MISMATCH')
    }
  })

  it('rejects stale nextCursor after pin advances', () => {
    const staleToken = validOpaque(5)
    const advancedPin = basePin({ boardRev: 6 })
    expect(() =>
      buildListReadEnvelope(advancedPin, 'list_runs', [], {
        pageSize: 50,
        nextCursor: staleToken,
      }),
    ).toThrow(McpReadContractError)
    try {
      validateNextCursorForPin(staleToken, advancedPin)
    } catch (e) {
      expect((e as McpReadContractError).details.cursorCode).toBe('CURSOR_REVISION_MISMATCH')
    }
  })

  it('rejects snapshotRev mismatch (foreign snapshot pin)', () => {
    const pin = basePin({ boardRev: 3 })
    const foreignSnap = validOpaque(3, 'snap-other')
    expect(() =>
      validateNextCursorForPin(foreignSnap, pin, { expectedSnapshotRev: 'snap-expected' }),
    ).toThrow(McpReadContractError)
    try {
      validateNextCursorForPin(foreignSnap, pin, { expectedSnapshotRev: 'snap-expected' })
    } catch (e) {
      expect((e as McpReadContractError).details.cursorCode).toBe('CURSOR_REVISION_MISMATCH')
    }
    // Matching snapshot accepted at build time
    const ok = validOpaque(3, 'snap-expected')
    expect(validateNextCursorForPin(ok, pin, { expectedSnapshotRev: 'snap-expected' })).toBe(ok)
    const env = buildPinnedReadEnvelope(pin, { items: [] }, {
      method: 'list_activity',
      nextCursor: ok,
      expectedSnapshotRev: 'snap-expected',
    })
    expect(env.nextCursor).toBe(ok)
    assertPinnedEnvelopeShape(env)
  })

  it('rejects tampered nextCursor MAC', () => {
    const pin = basePin()
    const good = validOpaque(pin.boardRev)
    const parts = good.split('.')
    const tampered = `${parts[0]}.${parts[1]}.deadbeefdeadbeef`
    expect(() => validateNextCursorForPin(tampered, pin)).toThrow(McpReadContractError)
    try {
      validateNextCursorForPin(tampered, pin)
    } catch (e) {
      expect((e as McpReadContractError).details.cursorCode).toBe('CURSOR_TAMPERED')
    }
  })

  it('requireBoundedPageSize defaults 50 and rejects oversize/zero/non-int', () => {
    expect(requireBoundedPageSize(undefined)).toBe(50)
    expect(requireBoundedPageSize(null)).toBe(50)
    expect(requireBoundedPageSize(1)).toBe(1)
    expect(requireBoundedPageSize(200)).toBe(200)
    expect(() => requireBoundedPageSize(0)).toThrow(McpReadContractError)
    expect(() => requireBoundedPageSize(201)).toThrow(McpReadContractError)
    expect(() => requireBoundedPageSize(1.5)).toThrow(McpReadContractError)
    try {
      requireBoundedPageSize(999)
    } catch (e) {
      expect((e as McpReadContractError).code).toBe('PAGE_SIZE_INVALID')
    }
  })

  it('buildListReadEnvelope rejects unbounded pageSize and invalid nextCursor', () => {
    const pin = basePin()
    expect(() => buildListReadEnvelope(pin, 'list_work_items', [], { pageSize: 500 })).toThrow(
      /pageSize|PAGE_SIZE/i,
    )
    expect(() =>
      buildListReadEnvelope(pin, 'list_work_items', [], {
        pageSize: 50,
        nextCursor: 'passthrough-evil',
      }),
    ).toThrow(McpReadContractError)
  })

  it('decodeReadCursor fails closed on garbage', () => {
    expect(() => decodeReadCursor('nope')).toThrow(McpReadContractError)
    const token = validOpaque(1)
    const decoded = decodeReadCursor(token)
    expect(decoded.boardRev).toBe(1)
    expect(decoded.order).toBe('DESC')
  })
})
