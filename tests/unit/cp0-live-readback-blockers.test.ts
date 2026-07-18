import { describe, expect, it } from 'vitest'

import { resolveHealthBoardId } from '#/routes/api.healthz'
import {
  buildCp0SyncStatusReadback,
  registerBoardTools,
  resolveCp0ReadBoardId,
} from '#/server/board-mcp'
import {
  defaultScopesForRole,
  isToolListable,
  type Principal,
} from '#/server/rbac'

const PIN = {
  boardRev: 23,
  lifecycleRev: 5,
  canonicalHash: 'a'.repeat(64),
}
const NOW = Date.parse('2026-07-15T08:00:00.000Z')

function legacyAgent(): Principal {
  return {
    actorId: 'legacy-write-token',
    role: 'AGENT',
    scopes: defaultScopesForRole('AGENT'),
    channel: 'bearer',
    boards: ['mfs-rebuild'],
    boardId: 'mfs-rebuild',
    agentId: 'legacy-write-token',
  }
}

describe('CP0 live readback blocker closure', () => {
  it('binds health to explicit configuration and fails closed on ambiguous discovery', () => {
    expect(resolveHealthBoardId({
      configuredBoardId: 'mfs-rebuild',
      writeTokenBoardId: 'other',
      discoveredBoardIds: ['one', 'two'],
    })).toBe('mfs-rebuild')
    expect(resolveHealthBoardId({ writeTokenBoardId: 'mfs-rebuild' })).toBe('mfs-rebuild')
    expect(resolveHealthBoardId({ discoveredBoardIds: ['only-board'] })).toBe('only-board')
    expect(resolveHealthBoardId({ discoveredBoardIds: ['one', 'two'] })).toBe('')
  })

  it('lists safe CP0 metadata without widening legacy account or audit scope', () => {
    const principal = legacyAgent()
    expect(isToolListable(principal, 'get_capabilities')).toBe(true)
    expect(isToolListable(principal, 'get_sync_status')).toBe(true)
    expect(isToolListable(principal, 'list_accounts')).toBe(false)
    expect(isToolListable(principal, 'list_audit')).toBe(false)

    const registered: Array<string> = []
    const server = {
      registerTool(name: string) { registered.push(name) },
      registerResource() {},
    }
    registerBoardTools(server as never, {
      principal,
      mechanism: { kind: 'OK' },
      bearerPresent: true,
    })
    expect(registered).toContain('get_capabilities')
    expect(registered).toContain('get_sync_status')
    expect(registered).not.toContain('list_accounts')
    expect(registered).not.toContain('list_audit')
  })

  it('binds omitted CP0 metadata reads to the principal instead of the first board', () => {
    const principal = legacyAgent()
    expect(resolveCp0ReadBoardId(undefined, principal)).toBe('mfs-rebuild')
    expect(resolveCp0ReadBoardId('explicit-board', principal)).toBe('explicit-board')
    expect(resolveCp0ReadBoardId(undefined, {
      boardId: undefined,
      boards: ['sole-board'],
    })).toBe('sole-board')
    expect(resolveCp0ReadBoardId(undefined, {
      boardId: undefined,
      boards: ['one', 'two'],
    })).toBe('')
  })

  it('never fabricates zero when migration-008 sync state is absent or off-pin', () => {
    const missing = buildCp0SyncStatusReadback(null, PIN, NOW)
    expect(missing).toMatchObject({
      ok: true,
      status: 'UNKNOWN',
      rawStatus: null,
      parity: false,
      current_outbox: null,
      legacy_unreplayed: null,
      effectiveBacklog: null,
      zeroBacklogProven: false,
      stale: true,
      blocker: 'SYNC_ROW_MISSING',
    })

    const offPin = buildCp0SyncStatusReadback({
      status: 'IN_SYNC',
      outbox_pending: 0,
      legacy_unreplayed: 0,
      effective_backlog: 0,
      board_rev: PIN.boardRev - 1,
      lifecycle_rev: PIN.lifecycleRev,
      canonical_hash: PIN.canonicalHash,
      last_ack_revision: 10,
      freshness_at: new Date(NOW).toISOString(),
      entity_rev: 2,
    }, PIN, NOW)
    expect(offPin.parity).toBe(false)
    expect(offPin.status).toBe('READBACK_REQUIRED')
    expect(offPin.rawStatus).toBe('IN_SYNC')
    expect(offPin.current_outbox).toBeNull()
    expect(offPin.zeroBacklogProven).toBe(false)
    expect(offPin.blocker).toBe('SYNC_OFF_PIN')
  })

  it('proves zero only for a fresh exact-pin IN_SYNC row', () => {
    expect(buildCp0SyncStatusReadback({
      status: 'IN_SYNC',
      outbox_pending: 0,
      legacy_unreplayed: 0,
      effective_backlog: 0,
      board_rev: PIN.boardRev,
      lifecycle_rev: PIN.lifecycleRev,
      canonical_hash: PIN.canonicalHash,
      last_ack_revision: 22,
      freshness_at: new Date(NOW - 30_000).toISOString(),
      entity_rev: 3,
    }, PIN, NOW)).toMatchObject({
      status: 'IN_SYNC',
      rawStatus: 'IN_SYNC',
      parity: true,
      current_outbox: 0,
      legacy_unreplayed: 0,
      effectiveBacklog: 0,
      zeroBacklogProven: true,
      stale: false,
      blocker: null,
    })
  })
})
