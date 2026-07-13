/**
 * Canonical definition read-model: single-authority pin + payload projection.
 * Memory ImportStorage only — no real DB, no MCP/UI wiring.
 */
import { describe, expect, it } from 'vitest'

import {
  applyImport,
  createMemoryImportStorage,
  IMPORT_WRITE_SCOPE,
  type ImportAuthContext,
  type ImportBoardState,
} from '#/server/canonical-import'
import {
  CanonicalReadModelError,
  createCanonicalDefinitionReadAdapter,
  isPinComplete,
  isSyntheticCanonicalSnapshotId,
  loadPinnedDefinitionReadModel,
  projectCanonicalDefinition,
  tryLoadPinnedDefinitionReadModel,
} from '#/server/canonical-read-model'
import {
  canonicalSubjectHash,
  produceCanonicalSnapshot,
  type CanonicalSnapshotInput,
} from '#/server/canonical-snapshot'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'

const auth: ImportAuthContext = {
  actorId: 'reader-root',
  scopes: [IMPORT_WRITE_SCOPE, 'board:read'],
  role: 'ROOT_ORCHESTRATOR',
}

function baseInput(over: Partial<CanonicalSnapshotInput> = {}): CanonicalSnapshotInput {
  return {
    boardId: 'mfs-rebuild',
    snapshotId: 'snap-read-001',
    sourceRepoId: 'repo/gigit',
    sourceCommitSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    generatedAt: '2026-07-13T08:00:00.000Z',
    projects: [
      { id: 'p-b', name: 'B' },
      { id: 'p-a', name: 'A' },
    ],
    flows: [
      { id: 'f-2', projectId: 'p-a', name: 'Flow B' },
      { id: 'f-1', projectId: 'p-a', name: 'Flow A' },
    ],
    nodes: [
      { id: 'n-2', flowId: 'f-1' },
      { id: 'n-1', flowId: 'f-1' },
    ],
    tasks: [
      { id: 't-2', projectId: 'p-a', title: 'Two' },
      { id: 't-1', projectId: 'p-a', title: 'One' },
    ],
    dependencies: [{ fromTaskId: 't-1', toTaskId: 't-2' }],
    featureContractJoins: [{ featureContractId: 'fc-1', taskId: 't-1' }],
    nodeJoins: [{ nodeId: 'n-1', taskId: 't-1' }],
    primaryOwnerships: [{ taskId: 't-1', ownerId: 'owner-a' }],
    classifications: [
      { taskId: 't-1', taskClass: 'UNCLASSIFIED', disposition: 'UNCLASSIFIED' },
      { taskId: 't-2', taskClass: 'UNCLASSIFIED', disposition: 'UNCLASSIFIED' },
    ],
    anchors: [{ id: 'a-1', taskId: 't-1', file: 'src/x.ts' }],
    acceptancePaths: [{ id: 'ap-1', taskId: 't-1', path: 'tests/unit/x.test.ts' }],
    ...over,
  }
}

function emptyBoard(over: Partial<ImportBoardState> = {}): ImportBoardState {
  return {
    boardId: 'mfs-rebuild',
    boardRev: 0,
    lifecycleRev: 7,
    lastSnapshotGeneratedAt: null,
    lastSnapshotId: null,
    lastPayloadSha256: null,
    canonicalSnapshotId: null,
    canonicalHash: null,
    entityRev: 0,
    subjectHash: '',
    lifecycleEvidenceByTask: {
      't-1': { stage: 'MAPPED', receiptId: 'ev-live-1' },
    },
    ...over,
  }
}

describe('isSyntheticCanonicalSnapshotId / isPinComplete', () => {
  it('detects resolveBoardPin synthetic pin- form', () => {
    expect(isSyntheticCanonicalSnapshotId('b1', 'pin-b1-abcdef0123456789')).toBe(true)
    expect(isSyntheticCanonicalSnapshotId('b1', 'snap-real-001')).toBe(false)
    expect(isSyntheticCanonicalSnapshotId('b1', null)).toBe(false)
  })

  it('isPinComplete requires real snapshot id + hash + finite revs', () => {
    expect(isPinComplete(emptyBoard())).toBe(false)
    expect(
      isPinComplete(
        emptyBoard({
          canonicalSnapshotId: 'pin-mfs-rebuild-deadbeefdeadbeef',
          canonicalHash: 'abc',
          boardRev: 1,
        }),
      ),
    ).toBe(false)
    expect(
      isPinComplete(
        emptyBoard({
          canonicalSnapshotId: 'snap-ok',
          canonicalHash: 'abc',
          boardRev: 1,
          lifecycleRev: 0,
        }),
      ),
    ).toBe(true)
  })
})

describe('projectCanonicalDefinition', () => {
  it('projects DISTINCT sorted rows without inventing lifecycle', () => {
    const snap = produceCanonicalSnapshot(baseInput())
    const proj = projectCanonicalDefinition(snap.payload)
    expect(proj.distinctTaskIds).toEqual(['t-1', 't-2'])
    expect(proj.distinctProjectIds).toEqual(['p-a', 'p-b'])
    expect(proj.distinctFlowIds).toEqual(['f-1', 'f-2'])
    expect(proj.tasks.map((t) => t.id)).toEqual(['t-1', 't-2'])
    expect(proj.projects.map((p) => p.id)).toEqual(['p-a', 'p-b'])
    expect(proj.flows.map((f) => f.id)).toEqual(['f-1', 'f-2'])
    expect(proj.distinctCounts.tasks).toBe(2)
    expect(proj.distinctCounts.projects).toBe(2)
    // No lifecycle fields fabricated on tasks
    for (const t of proj.tasks) {
      expect(t).not.toHaveProperty('lifecycleStage')
      expect(t).not.toHaveProperty('stageEvidence')
      expect(t).not.toHaveProperty('g5Pass')
    }
  })

  it('dedupes duplicate ids without double-counting joins', () => {
    const snap = produceCanonicalSnapshot(baseInput())
    const duped = {
      ...snap.payload,
      tasks: [...snap.payload.tasks, snap.payload.tasks[0]!],
      dependencies: [
        ...snap.payload.dependencies,
        { fromTaskId: 't-1', toTaskId: 't-2' },
      ],
    }
    const proj = projectCanonicalDefinition(duped)
    expect(proj.tasks).toHaveLength(2)
    expect(proj.dependencies).toHaveLength(1)
    expect(proj.distinctCounts.tasks).toBe(2)
    expect(proj.distinctCounts.dependencies).toBe(1)
  })
})

describe('loadPinnedDefinitionReadModel (memory)', () => {
  it('positive: after applyImport, projects imported definition + pin fields', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    const applied = await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-pos-1',
      importId: 'imp-read-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    expect(applied.ok).toBe(true)
    expect(applied.lifecycleEvidenceUnchanged).toBe(true)

    const model = await loadPinnedDefinitionReadModel(storage, 'mfs-rebuild')
    expect(model.mismatch).toBeNull()
    expect(model.pin.boardRev).toBe(applied.boardRev)
    expect(model.pin.lifecycleRev).toBe(7)
    expect(model.pin.canonicalSnapshotId).toBe(snap.manifest.snapshotId)
    expect(model.pin.canonicalHash).toBe(canonicalSubjectHash(snap))
    expect(model.pin.payloadSha256).toBe(snap.manifest.payloadSha256)
    expect(model.projection.distinctTaskIds).toEqual(['t-1', 't-2'])
    expect(model.projection.tasks.map((t) => t.title)).toEqual(['One', 'Two'])
    expect(model.projection.projects.map((p) => p.id)).toEqual(['p-a', 'p-b'])
    expect(model.projection.flows.map((f) => f.id)).toEqual(['f-1', 'f-2'])
    expect(model.projection.anchors).toHaveLength(1)
    expect(model.projection.classifications).toHaveLength(2)
    // Lifecycle evidence on storage pin must remain untouched (not in projection)
    expect(storage.state().lifecycleEvidenceByTask['t-1']).toEqual({
      stage: 'MAPPED',
      receiptId: 'ev-live-1',
    })
  })

  it('PIN_MISSING when board unknown', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    await expect(loadPinnedDefinitionReadModel(storage, 'other-board')).rejects.toMatchObject({
      code: 'PIN_MISSING',
      name: 'CanonicalReadModelError',
    })
  })

  it('PIN_INCOMPLETE when no import applied yet', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    await expect(loadPinnedDefinitionReadModel(storage, 'mfs-rebuild')).rejects.toMatchObject({
      code: 'PIN_INCOMPLETE',
    })
  })

  it('PIN_SYNTHETIC rejects resolveBoardPin-shaped ids', async () => {
    const storage = createMemoryImportStorage(
      emptyBoard({
        boardRev: 1,
        canonicalSnapshotId: 'pin-mfs-rebuild-abcdef0123456789',
        canonicalHash: 'deadbeef'.repeat(8),
      }),
    )
    await expect(loadPinnedDefinitionReadModel(storage, 'mfs-rebuild')).rejects.toMatchObject({
      code: 'PIN_SYNTHETIC',
    })
  })

  it('SNAPSHOT_MISSING when pin set but payload dropped', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-miss-1',
      importId: 'imp-miss-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    storage.dropLastSnapshot()
    await expect(loadPinnedDefinitionReadModel(storage, 'mfs-rebuild')).rejects.toMatchObject({
      code: 'SNAPSHOT_MISSING',
    })
  })

  it('HASH_MISMATCH when pin.canonicalHash does not match snapshot subject', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-hash-1',
      importId: 'imp-hash-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    storage.forcePin({ canonicalHash: '0'.repeat(64), subjectHash: '0'.repeat(64) })
    await expect(loadPinnedDefinitionReadModel(storage, 'mfs-rebuild')).rejects.toMatchObject({
      code: 'HASH_MISMATCH',
    })
  })

  it('SNAPSHOT_ID_MISMATCH via expectedSnapshotId option', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-sid-1',
      importId: 'imp-sid-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    await expect(
      loadPinnedDefinitionReadModel(storage, 'mfs-rebuild', {
        expectedSnapshotId: 'other-snap',
      }),
    ).rejects.toMatchObject({ code: 'SNAPSHOT_ID_MISMATCH' })
  })

  it('OUT_OF_ORDER_PIN when expectedBoardRev does not match pin', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    const applied = await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-ooo-1',
      importId: 'imp-ooo-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    await expect(
      loadPinnedDefinitionReadModel(storage, 'mfs-rebuild', {
        expectedBoardRev: applied.boardRev + 99,
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_ORDER_PIN' })
  })

  it('tryLoad returns mismatch object instead of throwing', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const r = await tryLoadPinnedDefinitionReadModel(storage, 'mfs-rebuild')
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('expected fail')
    expect(r.code).toBe('PIN_INCOMPLETE')
    expect(r.mismatch.code).toBe('PIN_INCOMPLETE')
  })

  it('createCanonicalDefinitionReadAdapter exposes load + tryLoad', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-adapter-1',
      importId: 'imp-adapter-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    const adapter = createCanonicalDefinitionReadAdapter(storage)
    const model = await adapter.loadPinnedDefinition('mfs-rebuild')
    expect(model.projection.distinctTaskIds).toEqual(['t-1', 't-2'])
    const soft = await adapter.tryLoadPinnedDefinition('nope')
    expect(soft.ok).toBe(false)
  })

  it('getPinnedSnapshot retains payload after apply (no void lastSnapshot)', async () => {
    const storage = createMemoryImportStorage(emptyBoard())
    const snap = produceCanonicalSnapshot(baseInput())
    await applyImport(storage, createMemoryIdempotencyStorage(), null, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'read-model-retain-1',
      importId: 'imp-retain-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    const bundle = await storage.getPinnedSnapshot('mfs-rebuild')
    expect(bundle).not.toBeNull()
    expect(bundle!.snapshot?.manifest.snapshotId).toBe(snap.manifest.snapshotId)
    expect(bundle!.snapshot?.payload.tasks.map((t) => t.id).sort()).toEqual(['t-1', 't-2'])
    expect(storage.lastAppliedSnapshot()?.manifest.snapshotId).toBe(snap.manifest.snapshotId)
  })

  it('CanonicalReadModelError is instanceof Error with code', () => {
    const e = new CanonicalReadModelError('HASH_MISMATCH', 'x', { a: 1 })
    expect(e).toBeInstanceOf(Error)
    expect(e.code).toBe('HASH_MISMATCH')
    expect(e.details).toEqual({ a: 1 })
  })
})
