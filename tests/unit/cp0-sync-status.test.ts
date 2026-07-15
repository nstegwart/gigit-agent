import { describe, expect, it } from 'vitest'

import { buildCp0SyncStatusReadback } from '#/server/cp0-sync-status'

const NOW = Date.parse('2026-07-15T12:00:00.000Z')
const PIN = {
  boardRev: 31,
  lifecycleRev: 7,
  canonicalHash: 'a'.repeat(64),
}

function row(overrides: Record<string, unknown> = {}) {
  return {
    status: 'IN_SYNC',
    outbox_pending: 0,
    legacy_unreplayed: 0,
    effective_backlog: 0,
    board_rev: PIN.boardRev,
    lifecycle_rev: PIN.lifecycleRev,
    canonical_hash: PIN.canonicalHash,
    last_ack_revision: 30,
    freshness_at: new Date(NOW - 30_000).toISOString(),
    entity_rev: 2,
    ...overrides,
  }
}

describe('CP0 sync status projection', () => {
  it('proves zero only for a fresh exact-pin row with all three zero counts', () => {
    expect(buildCp0SyncStatusReadback(row(), PIN, NOW)).toMatchObject({
      status: 'IN_SYNC',
      parity: true,
      stale: false,
      current_outbox: 0,
      legacy_unreplayed: 0,
      effectiveBacklog: 0,
      zeroBacklogProven: true,
    })
  })

  it.each([
    ['missing', null],
    ['off-board-rev', row({ board_rev: PIN.boardRev - 1 })],
    ['off-lifecycle-rev', row({ lifecycle_rev: PIN.lifecycleRev - 1 })],
    ['off-hash', row({ canonical_hash: 'b'.repeat(64) })],
    ['stale', row({ freshness_at: new Date(NOW - 120_001).toISOString() })],
    ['future-skew', row({ freshness_at: new Date(NOW + 5_001).toISOString() })],
    ['outbox-pending', row({ outbox_pending: 1, effective_backlog: 1 })],
    ['legacy-pending', row({ legacy_unreplayed: 1, effective_backlog: 1 })],
    ['malformed', row({ effective_backlog: 'not-a-number' })],
  ])('fails closed for %s state', (_name, input) => {
    const result = buildCp0SyncStatusReadback(input, PIN, NOW)
    expect(result.zeroBacklogProven).toBe(false)
    if (!result.parity) {
      expect(result.effectiveBacklog).toBeNull()
    }
  })
})
