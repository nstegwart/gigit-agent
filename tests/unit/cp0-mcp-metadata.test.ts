import { describe, expect, it } from 'vitest'

import { registerBoardTools } from '#/server/board-mcp'
import {
  buildCp0CapabilitiesReadback,
  buildCp0SyncStatusReadback,
  resolveCp0ReadBoardId,
} from '#/server/cp0-mcp-metadata'
import { defaultScopesForRole, isToolListable, type Principal } from '#/server/rbac'

const PIN = {
  boardRev: 2918,
  lifecycleRev: 17,
  canonicalHash: 'a'.repeat(64),
}
const NOW = Date.parse('2026-07-15T12:00:00.000Z')

function boardAgent(): Principal {
  return {
    actorId: 'masked-agent',
    role: 'AGENT',
    scopes: defaultScopesForRole('AGENT'),
    channel: 'bearer',
    boards: ['mfs-rebuild'],
    boardId: 'mfs-rebuild',
    agentId: 'masked-agent',
  }
}

describe('CP0 MCP metadata', () => {
  it('registers both metadata tools for board readers without widening account/audit reads', () => {
    const principal = boardAgent()
    expect(isToolListable(principal, 'get_capabilities')).toBe(true)
    expect(isToolListable(principal, 'get_sync_status')).toBe(true)
    expect(isToolListable(principal, 'list_accounts')).toBe(false)
    expect(isToolListable(principal, 'list_audit')).toBe(false)

    const registered: Array<string> = []
    registerBoardTools(
      {
        registerTool(name: string) {
          registered.push(name)
        },
        registerResource() {},
      } as never,
      { principal, mechanism: { kind: 'OK' }, bearerPresent: true },
    )
    expect(registered).toContain('get_capabilities')
    expect(registered).toContain('get_sync_status')
  })

  it('binds omitted reads to one authenticated board and fails closed on ambiguity', () => {
    expect(resolveCp0ReadBoardId(undefined, boardAgent())).toBe('mfs-rebuild')
    expect(resolveCp0ReadBoardId('explicit', boardAgent())).toBe('explicit')
    expect(resolveCp0ReadBoardId(undefined, { boards: ['sole'] })).toBe('sole')
    expect(resolveCp0ReadBoardId(undefined, { boards: ['one', 'two'] })).toBe('')
  })

  it('binds capability metadata to the resolved current pin', () => {
    expect(
      buildCp0CapabilitiesReadback({
        principal: boardAgent(),
        capabilities: ['get_capabilities', 'get_sync_status'],
        pin: { ...PIN, generatedAt: new Date(NOW).toISOString(), stale: false },
      }),
    ).toMatchObject({
      authenticated: true,
      role: 'AGENT',
      capabilities: ['get_capabilities', 'get_sync_status'],
      ...PIN,
      observedAt: new Date(NOW).toISOString(),
      stale: false,
    })
  })

  it('never fabricates a zero backlog from missing or off-pin state', () => {
    expect(buildCp0SyncStatusReadback(null, PIN, NOW)).toMatchObject({
      status: 'UNKNOWN',
      parity: false,
      effectiveBacklog: null,
      zeroBacklogProven: false,
      stale: true,
    })
    expect(
      buildCp0SyncStatusReadback(
        {
          status: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          board_rev: PIN.boardRev - 1,
          lifecycle_rev: PIN.lifecycleRev,
          canonical_hash: PIN.canonicalHash,
          last_ack_revision: 12,
          freshness_at: new Date(NOW).toISOString(),
          entity_rev: 3,
        },
        PIN,
        NOW,
      ),
    ).toMatchObject({ parity: false, effectiveBacklog: null, zeroBacklogProven: false })
  })

  it('proves zero only for fresh exact-pin IN_SYNC state', () => {
    expect(
      buildCp0SyncStatusReadback(
        {
          status: 'IN_SYNC',
          outbox_pending: 0,
          legacy_unreplayed: 0,
          effective_backlog: 0,
          board_rev: PIN.boardRev,
          lifecycle_rev: PIN.lifecycleRev,
          canonical_hash: PIN.canonicalHash,
          last_ack_revision: 12,
          freshness_at: new Date(NOW - 30_000).toISOString(),
          entity_rev: 3,
        },
        PIN,
        NOW,
      ),
    ).toMatchObject({ parity: true, effectiveBacklog: 0, zeroBacklogProven: true, stale: false })
  })
})
