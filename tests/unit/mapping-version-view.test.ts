import { describe, expect, it } from 'vitest'

import { attachAdaptiveMappingToEnvelope } from '#/lib/mapping-envelope-attach'
import { resolveOverviewMappingBanner } from '#/lib/control-center-route-adapters'
import type { PinnedEnvelope } from '#/server/control-center-ui'

function basePinnedEnvelope(): PinnedEnvelope<{ mappingVersion?: unknown }> {
  return {
    schemaVersion: 'TM_PINNED_ENVELOPE_V1',
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'snap-99',
    canonicalHash: 'deadbeefcafe',
    boardRev: 7,
    lifecycleRev: 3,
    generatedAt: '2026-07-16T04:00:00.000Z',
    freshnessAgeSeconds: 120,
    stale: false,
    staleReason: null,
    data: {},
    nextCursor: null,
    surfaceState: 'populated',
    surface: 'overview',
    error: null,
  }
}

describe('mapping-version-view: envelope → banner', () => {
  it('resolveOverviewMappingBanner reads mappingVersion from attached envelope', () => {
    const envelope = attachAdaptiveMappingToEnvelope(basePinnedEnvelope(), {
      schemaVersion: 'MFS_CANONICAL_TASK_SNAPSHOT_V1',
      knownSchema: true,
      mode: 'FULL',
      snapshotId: 'snap-99',
      canonicalHash: 'deadbeefcafe',
      dynamicDenominator: 2301,
      mappingIsNotReadiness: true,
    })

    const banner = resolveOverviewMappingBanner(envelope)
    expect(banner).not.toBeNull()
    expect(banner!.dynamicDenominator).toBe(2301)
    expect(banner!.mappingIsNotReadiness).toBe(true)
    expect(banner!.summaryLabel).toMatch(/2301 mapped tasks/)
    expect(banner!.summaryLabel).not.toMatch(/639/)
  })
})