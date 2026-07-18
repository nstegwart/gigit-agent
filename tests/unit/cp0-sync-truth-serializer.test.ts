/**
 * Adversarial sync-truth serializer cases for PACKET healthz/MCP surface parity.
 * Canonical module: src/server/cp0-sync-status.ts (re-exported by cp0-mcp-metadata).
 */
import { describe, expect, it } from 'vitest'

import {
  buildCp0SyncStatusReadback,
  toHealthzSyncPayload,
} from '#/server/cp0-sync-status'
import { buildCp0SyncStatusReadback as fromMcpMeta } from '#/server/cp0-mcp-metadata'
import {
  buildHealthzPayload,
  evaluateHealthStatus,
  type HealthExpected,
  type HealthObserved,
} from '#/server/health'

const NOW = Date.parse('2026-07-18T18:00:00.000Z')
const PIN = {
  boardRev: 5845,
  lifecycleRev: 1,
  canonicalHash: '8ba475c604a0'.padEnd(64, '0'),
}

function goodRow(overrides: Record<string, unknown> = {}) {
  return {
    status: 'IN_SYNC',
    outbox_pending: 0,
    legacy_unreplayed: 0,
    effective_backlog: 0,
    board_rev: PIN.boardRev,
    lifecycle_rev: PIN.lifecycleRev,
    canonical_hash: PIN.canonicalHash,
    last_ack_revision: 3980,
    freshness_at: new Date(NOW - 15_000).toISOString(),
    entity_rev: 1563,
    ...overrides,
  }
}

describe('CP0 sync truth serializer (adversarial)', () => {
  it('fresh on-pin zero => IN_SYNC + zero proven', () => {
    const rb = buildCp0SyncStatusReadback(goodRow(), PIN, NOW)
    expect(rb.status).toBe('IN_SYNC')
    expect(rb.zeroBacklogProven).toBe(true)
    expect(rb.parity).toBe(true)
    expect(rb.stale).toBe(false)
    expect(rb.effectiveBacklog).toBe(0)
    expect(rb.current_outbox).toBe(0)
    expect(rb.legacy_unreplayed).toBe(0)
    expect(rb.blocker).toBeNull()
  })

  it('off-pin raw IN_SYNC => READBACK_REQUIRED + null counts + raw preserved', () => {
    const rb = buildCp0SyncStatusReadback(
      goodRow({ board_rev: 100, last_ack_revision: 3980 }),
      PIN,
      NOW,
    )
    expect(rb.status).toBe('READBACK_REQUIRED')
    expect(rb.rawStatus).toBe('IN_SYNC')
    expect(rb.parity).toBe(false)
    expect(rb.effectiveBacklog).toBeNull()
    expect(rb.current_outbox).toBeNull()
    expect(rb.legacy_unreplayed).toBeNull()
    expect(rb.zeroBacklogProven).toBe(false)
    expect(rb.lastAckRevision).toBe(3980)
    expect(rb.entityRev).toBe(1563)
  })

  it('stale raw IN_SYNC (~2d old) => READBACK_REQUIRED, not green-by-status', () => {
    const rb = buildCp0SyncStatusReadback(
      goodRow({
        freshness_at: '2026-07-16T14:12:46.594Z',
        board_rev: PIN.boardRev - 100,
      }),
      PIN,
      NOW,
    )
    expect(rb.status).toBe('READBACK_REQUIRED')
    expect(rb.rawStatus).toBe('IN_SYNC')
    expect(rb.stale).toBe(true)
    expect(rb.parity).toBe(false)
    expect(rb.zeroBacklogProven).toBe(false)
    expect(rb.blocker).toBe('SYNC_OFF_PIN')
  })

  it('missing row => UNKNOWN', () => {
    expect(buildCp0SyncStatusReadback(null, PIN, NOW).status).toBe('UNKNOWN')
  })

  it('future skew fails closed', () => {
    const rb = buildCp0SyncStatusReadback(
      goodRow({ freshness_at: new Date(NOW + 10_000).toISOString() }),
      PIN,
      NOW,
    )
    expect(rb.status).toBe('READBACK_REQUIRED')
    expect(rb.stale).toBe(true)
    expect(rb.zeroBacklogProven).toBe(false)
    expect(rb.blocker).toBe('SYNC_FUTURE_SKEW')
  })

  it('MCP re-export is the identical function reference', () => {
    expect(fromMcpMeta).toBe(buildCp0SyncStatusReadback)
  })

  it('healthz payload exposes proof fields and never green-by-status alone', () => {
    const readback = buildCp0SyncStatusReadback(
      goodRow({ board_rev: 1, freshness_at: '2026-07-16T14:12:46.594Z' }),
      PIN,
      NOW,
    )
    const sync = toHealthzSyncPayload(readback)
    expect(sync.status).toBe('READBACK_REQUIRED')
    expect(sync.rawStatus).toBe('IN_SYNC')
    expect(sync.parity).toBe(false)
    expect(sync.stale).toBe(true)
    expect(sync.currentOutbox).toBeNull()
    expect(sync.legacyUnreplayed).toBeNull()
    expect(sync.effectiveBacklog).toBeNull()
    expect(sync.zeroBacklogProven).toBe(false)
    expect(sync.freshnessAt).toBe('2026-07-16T14:12:46.594Z')
    expect(sync.lastAckRevision).toBe(3980)
    expect(sync.entityRev).toBe(1563)
    expect(sync.blocker).toBe('SYNC_OFF_PIN')
    expect(sync.reason).toMatch(/pin/i)

    const expected: HealthExpected = {
      deployedSha: 'a'.repeat(40),
      schemaVersion: '010',
    }
    const observed: HealthObserved = {
      deployedSha: 'a'.repeat(40),
      schemaVersion: '010',
      migration: {
        status: 'IDEMPOTENT_NOOP',
        appliedVersions: ['000', '010'],
        expectedLatestVersion: '010',
        schemaVersion: '010',
      },
      snapshot: {
        canonicalSnapshotId: 'snap',
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
        canonicalHash: PIN.canonicalHash,
      },
      dependencies: [{ name: 'mysql', status: 'up' }],
      // Cast: proof fields ride on structural assign without widening health.ts types this packet.
      sync: sync as HealthObserved['sync'],
    }

    // Service liveness remains independent of unproven sync (no new unhealthy reason).
    const evaled = evaluateHealthStatus(expected, observed)
    expect(evaled.status).toBe('ok')
    expect(evaled.unhealthyReasons).toEqual([])

    const payload = buildHealthzPayload(expected, observed, new Date(NOW).toISOString())
    expect(payload.status).toBe('ok')
    const bodySync = payload.sync as typeof sync
    expect(bodySync.status).toBe('READBACK_REQUIRED')
    expect(bodySync.parity).toBe(false)
    expect(bodySync.stale).toBe(true)
    expect(bodySync.zeroBacklogProven).toBe(false)
    expect(bodySync.blocker).toBe('SYNC_OFF_PIN')
    // Never invent zero from unproven state.
    expect(bodySync.effectiveBacklog).toBeNull()
    expect(bodySync.currentOutbox).toBeNull()
  })
})
