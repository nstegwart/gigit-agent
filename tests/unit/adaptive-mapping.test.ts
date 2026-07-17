/**
 * Adaptive mapping ingest — version-aware, no hardcoded 639, graceful degrade.
 */
import { describe, expect, it } from 'vitest'

import {
  adaptPresentFields,
  computeDynamicDistinctCounts,
  computeMappingFreshness,
  deriveDynamicDenominator,
  ingestMappingSnapshot,
  isKnownMappingSchemaVersion,
  mappingLiveProgress,
  mappingVersionFromPinAndProjection,
  mappingVersionToWire,
  KNOWN_MAPPING_SCHEMA_VERSIONS,
} from '#/server/adaptive-mapping'
import {
  CANONICAL_SNAPSHOT_SCHEMA,
  produceCanonicalSnapshot,
  type CanonicalSnapshotInput,
} from '#/server/canonical-snapshot'
import { projectCanonicalDefinition } from '#/server/canonical-read-model'

function tasksOfSize(n: number): Array<{ id: string; title: string; projectId: string }> {
  return Array.from({ length: n }, (_, i) => ({
    id: `t-${String(i + 1).padStart(4, '0')}`,
    title: `Task ${i + 1}`,
    projectId: 'p-a',
  }))
}

function baseInput(over: Partial<CanonicalSnapshotInput> = {}): CanonicalSnapshotInput {
  return {
    boardId: 'mfs-rebuild',
    snapshotId: 'snap-adaptive-001',
    sourceRepoId: 'repo/mfs',
    sourceCommitSha: 'abc1234567890defabc1234567890defabc12345',
    generatedAt: '2026-07-16T04:00:00.000Z',
    projects: [{ id: 'p-a', name: 'A' }],
    flows: [{ id: 'f-1', projectId: 'p-a' }],
    nodes: [{ id: 'n-1', flowId: 'f-1' }],
    tasks: tasksOfSize(3),
    dependencies: [],
    featureContractJoins: [],
    nodeJoins: [],
    primaryOwnerships: [],
    classifications: tasksOfSize(3).map((t) => ({
      taskId: t.id,
      taskClass: 'UNCLASSIFIED' as const,
      disposition: 'UNCLASSIFIED' as const,
    })),
    anchors: [],
    acceptancePaths: [],
    ...over,
  }
}

describe('adaptive-mapping: no hardcoded denominators', () => {
  it('KNOWN schemas include V1 and isKnownMappingSchemaVersion works', () => {
    expect(KNOWN_MAPPING_SCHEMA_VERSIONS).toContain(CANONICAL_SNAPSHOT_SCHEMA)
    expect(isKnownMappingSchemaVersion(CANONICAL_SNAPSHOT_SCHEMA)).toBe(true)
    expect(isKnownMappingSchemaVersion('MFS_CANONICAL_TASK_SNAPSHOT_V99')).toBe(false)
    expect(isKnownMappingSchemaVersion(null)).toBe(false)
  })

  it('deriveDynamicDenominator uses actual task count for size 3', () => {
    expect(deriveDynamicDenominator({ tasks: tasksOfSize(3) })).toBe(3)
  })

  it('deriveDynamicDenominator uses actual task count for size 10', () => {
    expect(deriveDynamicDenominator({ tasks: tasksOfSize(10) })).toBe(10)
  })

  it('deriveDynamicDenominator scales to simulated large mapping (2300+)', () => {
    const large = tasksOfSize(2300)
    expect(deriveDynamicDenominator({ tasks: large })).toBe(2300)
    // Never equal to a hardcoded historical constant unless the fixture happens to be that size
    expect(deriveDynamicDenominator({ tasks: tasksOfSize(5) })).not.toBe(639)
    expect(deriveDynamicDenominator({ tasks: tasksOfSize(5) })).toBe(5)
  })

  it('source of adaptive-mapping module does not hardcode 639 as denominator', async () => {
    const fs = await import('node:fs')
    const path = await import('node:path')
    const src = fs.readFileSync(
      path.resolve(process.cwd(), 'src/server/adaptive-mapping.ts'),
      'utf8',
    )
    // Mentions of 639 only as documentation of "never hardcode" — no assignment of denominator=639
    expect(src).not.toMatch(/dynamicDenominator\s*[:=]\s*639/)
    expect(src).not.toMatch(/tasks:\s*639/)
    expect(src).not.toMatch(/denominator\s*=\s*639/)
  })
})

describe('adaptive-mapping: FULL ingest of V1 snapshot', () => {
  it('surfaces version/hash/freshness and DISTINCT denominator', () => {
    const snap = produceCanonicalSnapshot(baseInput({ tasks: tasksOfSize(10) }))
    const now = Date.parse('2026-07-16T04:05:00.000Z')
    const result = ingestMappingSnapshot(snap, {
      now,
      pin: {
        boardId: 'mfs-rebuild',
        boardRev: 12,
        lifecycleRev: 4,
        canonicalSnapshotId: snap.manifest.snapshotId,
        canonicalHash: 'deadbeef',
        entityRev: 3,
        subjectHash: null,
        payloadSha256: snap.manifest.payloadSha256,
        lastSnapshotGeneratedAt: snap.manifest.generatedAt,
        lastSnapshotId: snap.manifest.snapshotId,
      },
    })

    expect(result.ok).toBe(true)
    expect(result.version.mode).toBe('FULL')
    expect(result.version.knownSchema).toBe(true)
    expect(result.version.schemaVersion).toBe(CANONICAL_SNAPSHOT_SCHEMA)
    expect(result.version.dynamicDenominator).toBe(10)
    expect(result.version.distinctCounts.tasks).toBe(10)
    expect(result.version.payloadSha256).toBe(snap.manifest.payloadSha256)
    expect(result.version.snapshotId).toBe('snap-adaptive-001')
    expect(result.version.boardRev).toBe(12)
    expect(result.version.lifecycleRev).toBe(4)
    expect(result.version.freshnessAgeSeconds).toBe(5 * 60)
    expect(result.version.stale).toBe(false)
    expect(result.version.mappingIsNotReadiness).toBe(true)
  })

  it('mappingVersionFromPinAndProjection prefers projection DISTINCT', () => {
    const snap = produceCanonicalSnapshot(baseInput({ tasks: tasksOfSize(7) }))
    const projection = projectCanonicalDefinition(snap.payload)
    const version = mappingVersionFromPinAndProjection({
      pin: {
        boardId: 'mfs-rebuild',
        boardRev: 1,
        lifecycleRev: 1,
        canonicalSnapshotId: snap.manifest.snapshotId,
        canonicalHash: 'hh',
        entityRev: 1,
        subjectHash: null,
        payloadSha256: snap.manifest.payloadSha256,
        lastSnapshotGeneratedAt: snap.manifest.generatedAt,
        lastSnapshotId: snap.manifest.snapshotId,
      },
      snapshot: snap,
      projection,
      now: Date.parse(snap.manifest.generatedAt),
    })
    expect(version.dynamicDenominator).toBe(7)
    expect(version.distinctCounts.tasks).toBe(7)
    expect(version.mode).toBe('FULL')
  })
})

describe('adaptive-mapping: unknown schema + unknown fields degrade gracefully', () => {
  it('unknown schemaVersion → ADAPTIVE_DEGRADED with pin metadata preserved', () => {
    const raw = {
      manifest: {
        schemaVersion: 'MFS_CANONICAL_TASK_SNAPSHOT_V9_FUTURE',
        boardId: 'mfs-rebuild',
        snapshotId: 'snap-future-1',
        sourceRepoId: 'repo/x',
        sourceCommitSha: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
        generatedAt: '2026-07-16T03:00:00.000Z',
        payloadSha256: 'abc',
        distinctCounts: { tasks: 2 },
      },
      payload: {
        tasks: [
          { id: 't-a', title: 'A', newFutureField: 'x' },
          { id: 't-b', title: 'B', anotherExtra: 1 },
        ],
        projects: [{ id: 'p-1', name: 'P' }],
        customCollection: [{ id: 'c-1', foo: true }],
      },
    }
    const result = ingestMappingSnapshot(raw, {
      now: Date.parse('2026-07-16T03:10:00.000Z'),
      pin: {
        boardId: 'mfs-rebuild',
        boardRev: 99,
        lifecycleRev: 8,
        canonicalSnapshotId: 'snap-future-1',
        canonicalHash: 'pinhash',
        entityRev: 2,
        subjectHash: null,
        payloadSha256: 'abc',
        lastSnapshotGeneratedAt: '2026-07-16T03:00:00.000Z',
        lastSnapshotId: 'snap-future-1',
      },
    })

    expect(result.version.mode).toBe('ADAPTIVE_DEGRADED')
    expect(result.version.knownSchema).toBe(false)
    expect(result.version.schemaVersion).toBe('MFS_CANONICAL_TASK_SNAPSHOT_V9_FUTURE')
    expect(result.version.dynamicDenominator).toBe(2)
    expect(result.version.boardRev).toBe(99)
    expect(result.version.canonicalHash).toBe('pinhash')
    expect(result.version.snapshotId).toBe('snap-future-1')
    expect(result.version.warnings.some((w) => w.includes('MAPPING_SCHEMA_UNKNOWN'))).toBe(true)
    // Does not throw; unknown task fields preserved on payload view
    expect(result.payload.tasks[0]?.newFutureField).toBe('x')
    expect(result.version.unknownFieldKeys).toEqual(
      expect.arrayContaining(['newFutureField', 'anotherExtra']),
    )
    expect(result.payload.extraCollections.customCollection?.length).toBe(1)
  })

  it('adaptPresentFields lists present + unknown vs baseline', () => {
    const { presentFieldKeys, unknownFieldKeys } = adaptPresentFields([
      { id: 't1', title: 'T', experimentalTag: 'e' },
      { id: 't2', title: 'U', projectId: 'p' },
    ])
    expect(presentFieldKeys).toEqual(
      expect.arrayContaining(['id', 'title', 'experimentalTag', 'projectId']),
    )
    expect(unknownFieldKeys).toContain('experimentalTag')
    expect(unknownFieldKeys).not.toContain('id')
  })

  it('null raw → degraded empty envelope, no throw', () => {
    const result = ingestMappingSnapshot(null)
    expect(result.version.mode).toBe('ADAPTIVE_DEGRADED')
    expect(result.version.dynamicDenominator).toBe(0)
    expect(result.version.warnings).toContain('MAPPING_RAW_NULL')
  })
})

describe('adaptive-mapping: freshness + live progress', () => {
  it('computeMappingFreshness marks stale after threshold', () => {
    const fresh = computeMappingFreshness('2026-07-16T04:00:00.000Z', {
      now: Date.parse('2026-07-16T04:05:00.000Z'),
      staleAfterSeconds: 600,
    })
    expect(fresh.stale).toBe(false)
    expect(fresh.freshnessAgeSeconds).toBe(300)

    const stale = computeMappingFreshness('2026-07-16T04:00:00.000Z', {
      now: Date.parse('2026-07-16T04:30:00.000Z'),
      staleAfterSeconds: 600,
    })
    expect(stale.stale).toBe(true)
    expect(stale.staleReason).toBe('MAPPING_STALE')
  })

  it('mappingLiveProgress never claims readiness', () => {
    const version = ingestMappingSnapshot({
      schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
      tasks: tasksOfSize(100),
      generatedAt: '2026-07-16T04:00:00.000Z',
    }).version
    const progress = mappingLiveProgress(version, 40)
    expect(progress.denominator).toBe(100)
    expect(progress.completed).toBe(40)
    expect(progress.percent).toBe(40)
    expect(progress.label).toBe('mapping_progress')
    expect(progress.notReadiness).toBe(true)
  })

  it('mappingVersionToWire is JSON-safe and keeps mappingIsNotReadiness', () => {
    const version = ingestMappingSnapshot({
      schemaVersion: CANONICAL_SNAPSHOT_SCHEMA,
      tasks: tasksOfSize(3),
      generatedAt: '2026-07-16T04:00:00.000Z',
    }).version
    const wire = mappingVersionToWire(version)
    expect(wire.mappingIsNotReadiness).toBe(true)
    expect(wire.dynamicDenominator).toBe(3)
    expect(() => JSON.stringify(wire)).not.toThrow()
  })
})

describe('adaptive-mapping: dynamic distinct counts', () => {
  it('counts arbitrary collections without requiring V1 shape', () => {
    const counts = computeDynamicDistinctCounts({
      tasks: [{ id: 'a' }, { id: 'b' }, { id: 'a' }],
      widgets: [{ id: 'w1' }, { id: 'w2' }],
      note: 'ignored-non-array',
    })
    expect(counts.tasks).toBe(2)
    expect(counts.widgets).toBe(2)
  })
})
