import { describe, expect, it } from 'vitest'

import {
  buildCp0SyncStatusReadback,
  toHealthzSyncPayload,
} from '#/server/cp0-sync-status'

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
      rawStatus: 'IN_SYNC',
      parity: true,
      stale: false,
      current_outbox: 0,
      legacy_unreplayed: 0,
      effectiveBacklog: 0,
      zeroBacklogProven: true,
      blocker: null,
      reason: null,
      lastAckRevision: 30,
      entityRev: 2,
    })
  })

  it('missing row => UNKNOWN with unproven null counts', () => {
    const result = buildCp0SyncStatusReadback(null, PIN, NOW)
    expect(result).toMatchObject({
      status: 'UNKNOWN',
      rawStatus: null,
      parity: false,
      stale: true,
      current_outbox: null,
      legacy_unreplayed: null,
      effectiveBacklog: null,
      zeroBacklogProven: false,
      blocker: 'SYNC_ROW_MISSING',
    })
  })

  it('off-pin raw IN_SYNC => READBACK_REQUIRED and null counts', () => {
    const result = buildCp0SyncStatusReadback(
      row({ board_rev: PIN.boardRev - 1 }),
      PIN,
      NOW,
    )
    expect(result).toMatchObject({
      status: 'READBACK_REQUIRED',
      rawStatus: 'IN_SYNC',
      parity: false,
      effectiveBacklog: null,
      current_outbox: null,
      legacy_unreplayed: null,
      zeroBacklogProven: false,
      blocker: 'SYNC_OFF_PIN',
    })
  })

  it('stale raw IN_SYNC => READBACK_REQUIRED (counts null only when off-pin or unproven)', () => {
    const result = buildCp0SyncStatusReadback(
      row({ freshness_at: new Date(NOW - 120_001).toISOString() }),
      PIN,
      NOW,
    )
    expect(result).toMatchObject({
      status: 'READBACK_REQUIRED',
      rawStatus: 'IN_SYNC',
      parity: true,
      stale: true,
      // on-pin still proves count identity; stale blocks zero claim + authoritative IN_SYNC
      current_outbox: 0,
      legacy_unreplayed: 0,
      effectiveBacklog: 0,
      zeroBacklogProven: false,
      blocker: 'SYNC_STALE',
    })
  })

  it('future skew fails closed as untrusted (not IN_SYNC)', () => {
    const result = buildCp0SyncStatusReadback(
      row({ freshness_at: new Date(NOW + 5_001).toISOString() }),
      PIN,
      NOW,
    )
    expect(result).toMatchObject({
      status: 'READBACK_REQUIRED',
      rawStatus: 'IN_SYNC',
      stale: true,
      zeroBacklogProven: false,
      blocker: 'SYNC_FUTURE_SKEW',
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
  ])('fails closed for %s state (never zero proven; never green-by-status alone)', (_name, input) => {
    const result = buildCp0SyncStatusReadback(input, PIN, NOW)
    expect(result.zeroBacklogProven).toBe(false)
    if (!result.parity) {
      expect(result.effectiveBacklog).toBeNull()
    }
    // Raw IN_SYNC must not remain the primary status when proof fails.
    if (input != null && (input as { status?: string }).status === 'IN_SYNC') {
      if (!result.parity || result.stale || result.effectiveBacklog === null) {
        if (!result.parity || result.stale || (input as { effective_backlog?: unknown }).effective_backlog === 'not-a-number') {
          expect(result.status).not.toBe('IN_SYNC')
          expect(result.status).toBe('READBACK_REQUIRED')
        }
      }
    }
    if (input === null) {
      expect(result.status).toBe('UNKNOWN')
    }
  })

  it('toHealthzSyncPayload exposes proof fields in camelCase', () => {
    const payload = toHealthzSyncPayload(buildCp0SyncStatusReadback(row(), PIN, NOW))
    expect(payload).toMatchObject({
      status: 'IN_SYNC',
      rawStatus: 'IN_SYNC',
      effectiveBacklog: 0,
      zeroBacklogProven: true,
      freshnessAt: new Date(NOW - 30_000).toISOString(),
      parity: true,
      stale: false,
      currentOutbox: 0,
      legacyUnreplayed: 0,
      lastAckRevision: 30,
      entityRev: 2,
      blocker: null,
      reason: null,
    })
  })

  it('healthz shape for off-pin never green-by-status alone', () => {
    const payload = toHealthzSyncPayload(
      buildCp0SyncStatusReadback(row({ board_rev: 1 }), PIN, NOW),
    )
    expect(payload.status).toBe('READBACK_REQUIRED')
    expect(payload.rawStatus).toBe('IN_SYNC')
    expect(payload.parity).toBe(false)
    expect(payload.stale).toBe(false)
    expect(payload.effectiveBacklog).toBeNull()
    expect(payload.currentOutbox).toBeNull()
    expect(payload.legacyUnreplayed).toBeNull()
    expect(payload.zeroBacklogProven).toBe(false)
    expect(payload.blocker).toBe('SYNC_OFF_PIN')
    expect(typeof payload.reason).toBe('string')
  })
})
