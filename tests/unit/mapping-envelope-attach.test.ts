import { describe, expect, it } from 'vitest'

import { attachAdaptiveMappingToEnvelope } from '#/lib/mapping-envelope-attach'
import type { PinnedEnvelope } from '#/server/control-center-ui'

function baseEnvelope(): PinnedEnvelope<{ trackedWorkDenominator: number }> {
  return {
    schemaVersion: 'TM_PINNED_ENVELOPE_V1',
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'snap-1',
    canonicalHash: 'abc123',
    boardRev: 1,
    lifecycleRev: 1,
    generatedAt: '2026-07-16T04:00:00.000Z',
    freshnessAgeSeconds: 60,
    stale: false,
    staleReason: null,
    data: { trackedWorkDenominator: 10 },
    nextCursor: null,
    surfaceState: 'populated',
    surface: 'overview',
    error: null,
  }
}

describe('mapping-envelope-attach', () => {
  it('merges mappingVersion on envelope top-level and data', () => {
    const wire = {
      schemaVersion: 'MFS_CANONICAL_TASK_SNAPSHOT_V1',
      dynamicDenominator: 42,
      mappingIsNotReadiness: true,
    }
    const out = attachAdaptiveMappingToEnvelope(baseEnvelope(), wire)
    expect(out.mappingVersion).toEqual(wire)
    expect((out.data as { mappingVersion?: unknown }).mappingVersion).toEqual(wire)
  })

  it('returns envelope unchanged when wire is null', () => {
    const env = baseEnvelope()
    expect(attachAdaptiveMappingToEnvelope(env, null)).toBe(env)
  })
})