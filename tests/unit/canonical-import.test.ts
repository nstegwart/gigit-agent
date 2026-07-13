import { describe, expect, it } from 'vitest'

import {
  applyImport,
  buildSnapshotFromInput,
  createMemoryImportStorage,
  ImportError,
  planImport,
  type ImportAuthContext,
  type ImportBoardState,
} from '#/server/canonical-import'
import {
  CANONICAL_SNAPSHOT_SCHEMA,
  produceCanonicalSnapshot,
  SnapshotValidationError,
  validateCanonicalSnapshot,
  payloadSha256,
  type CanonicalSnapshot,
  type CanonicalSnapshotInput,
} from '#/server/canonical-snapshot'
import {
  createMemoryIdempotencyStorage,
  IDEMPOTENCY_CONFLICT,
} from '#/server/idempotency'
import {
  createMemoryRevisionStore,
  type RevisionState,
} from '#/server/revisions'
import { canonicalSubjectHash } from '#/server/canonical-snapshot'

const auth: ImportAuthContext = {
  actorId: 'root-1',
  scopes: ['import:write', 'board:read'],
  role: 'ROOT_ORCHESTRATOR',
}

function baseInput(over: Partial<CanonicalSnapshotInput> = {}): CanonicalSnapshotInput {
  return {
    boardId: 'mfs-rebuild',
    snapshotId: 'snap-001',
    sourceRepoId: 'repo/gigit',
    sourceCommitSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    generatedAt: '2026-07-13T08:00:00.000Z',
    projects: [
      { id: 'p-b', name: 'B' },
      { id: 'p-a', name: 'A' },
    ],
    flows: [
      { id: 'f-2', projectId: 'p-a' },
      { id: 'f-1', projectId: 'p-a' },
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

describe('canonical snapshot producer — deterministic hash', () => {
  it('same logical input in different order yields identical payload + hash', () => {
    const a = produceCanonicalSnapshot(baseInput())
    const b = produceCanonicalSnapshot(
      baseInput({
        projects: [
          { id: 'p-a', name: 'A' },
          { id: 'p-b', name: 'B' },
        ],
        tasks: [
          { id: 't-1', projectId: 'p-a', title: 'One' },
          { id: 't-2', projectId: 'p-a', title: 'Two' },
        ],
        nodes: [
          { id: 'n-1', flowId: 'f-1' },
          { id: 'n-2', flowId: 'f-1' },
        ],
        flows: [
          { id: 'f-1', projectId: 'p-a' },
          { id: 'f-2', projectId: 'p-a' },
        ],
      }),
    )
    expect(a.manifest.payloadSha256).toBe(b.manifest.payloadSha256)
    expect(a.payload).toEqual(b.payload)
    expect(a.manifest.schemaVersion).toBe(CANONICAL_SNAPSHOT_SCHEMA)
    expect(a.manifest.distinctCounts.tasks).toBe(2)
    expect(a.manifest.distinctCounts.projects).toBe(2)
    validateCanonicalSnapshot(a)
  })

  it('payloadSha256 matches recomputed hash', () => {
    const snap = produceCanonicalSnapshot(baseInput())
    expect(payloadSha256(snap.payload)).toBe(snap.manifest.payloadSha256)
  })

  it('rejects duplicate task ids', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          tasks: [
            { id: 't-1', title: 'a' },
            { id: 't-1', title: 'b' },
          ],
        }),
      ),
    ).toThrow(SnapshotValidationError)
  })

  it('rejects duplicate FC joins', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          featureContractJoins: [
            { featureContractId: 'fc-1', taskId: 't-1' },
            { featureContractId: 'fc-1', taskId: 't-1' },
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_FC_JOIN|duplicate FC/i)
  })

  it('rejects duplicate node joins', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          nodeJoins: [
            { nodeId: 'n-1', taskId: 't-1' },
            { nodeId: 'n-1', taskId: 't-1' },
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_NODE_JOIN|duplicate node/i)
  })

  it('rejects duplicate dependency joins', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          dependencies: [
            { fromTaskId: 't-1', toTaskId: 't-2' },
            { fromTaskId: 't-1', toTaskId: 't-2' },
          ],
        }),
      ),
    ).toThrow(/DUPLICATE_DEPENDENCY|duplicate dependency/i)
  })

  it('rejects missing references', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          dependencies: [{ fromTaskId: 't-1', toTaskId: 'missing' }],
        }),
      ),
    ).toThrow(/MISSING_REFERENCE|missing/i)
  })

  it('rejects dependency cycles', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          dependencies: [
            { fromTaskId: 't-1', toTaskId: 't-2' },
            { fromTaskId: 't-2', toTaskId: 't-1' },
          ],
        }),
      ),
    ).toThrow(/DEPENDENCY_CYCLE|cycle/i)
  })

  it('rejects conflicting primary ownership', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          primaryOwnerships: [
            { taskId: 't-1', ownerId: 'a' },
            { taskId: 't-1', ownerId: 'b' },
          ],
        }),
      ),
    ).toThrow(/CONFLICTING_PRIMARY_OWNERSHIP|owners/i)
  })

  it('rejects malformed classification', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          classifications: [
            {
              taskId: 't-1',
              taskClass: 'NOT_A_CLASS' as 'PRODUCT',
              disposition: 'ACTIVE',
            },
          ],
        }),
      ),
    ).toThrow(/MALFORMED_CLASSIFICATION|invalid taskClass/i)
  })

  it('rejects fabricated lifecycle evidence on definition tasks', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          tasks: [
            {
              id: 't-1',
              title: 'x',
              lifecycleStage: 'LIVE_VERIFIED',
            } as never,
          ],
        }),
      ),
    ).toThrow(/LIFECYCLE_EVIDENCE|lifecycle field/i)
  })

  it('rejects secret fields', () => {
    expect(() =>
      produceCanonicalSnapshot(
        baseInput({
          tasks: [{ id: 't-1', title: 'x', token: 'sekrit' } as never],
        }),
      ),
    ).toThrow(/SECRET_FIELD|secret field/i)
  })

  it('detects tampered hash on validate', () => {
    const snap = produceCanonicalSnapshot(baseInput())
    const bad: CanonicalSnapshot = {
      ...snap,
      manifest: { ...snap.manifest, payloadSha256: '0'.repeat(64) },
    }
    expect(() => validateCanonicalSnapshot(bad)).toThrow(/payloadSha256 does not match|HASH_MISMATCH/)
    try {
      validateCanonicalSnapshot(bad)
    } catch (e) {
      expect(e).toBeInstanceOf(SnapshotValidationError)
      expect((e as SnapshotValidationError).code).toBe('HASH_MISMATCH')
    }
  })
})

describe('canonical import plan/apply — auth, CAS, idempotency, no evidence fab', () => {
  it('rejects missing import:write scope', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const storage = createMemoryImportStorage(emptyBoard())
    await expect(
      planImport(storage, {
        auth: { actorId: 'a', scopes: ['board:read'] },
        snapshot: snap,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        expectedSubjectHash: '',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
  })

  it('plans and applies import with injected storage (no real DB)', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const storage = createMemoryImportStorage(emptyBoard())
    const idem = createMemoryIdempotencyStorage()
    const seed: RevisionState = {
      boardId: 'mfs-rebuild',
      entityType: 'canonical_import',
      entityId: 'mfs-rebuild',
      entityRev: 0,
      boardRev: 0,
      subjectHash: '',
    }
    const revs = createMemoryRevisionStore([seed])
    const subject = ''
    const plan = await planImport(storage, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: subject,
    })
    expect(plan.ok).toBe(true)
    expect(plan.nextBoardRev).toBe(1)

    const applied = await applyImport(storage, idem, revs, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: subject,
      idempotencyKey: 'key-1',
      importId: 'imp-1',
      now: '2026-07-13T09:00:00.000Z',
    })
    expect(applied.ok).toBe(true)
    expect(applied.kind).toBe('APPLIED')
    expect(applied.lifecycleEvidenceUnchanged).toBe(true)
    expect(applied.lifecycleRev).toBe(7) // not advanced
    expect(applied.boardRev).toBe(1)
    expect(applied.readback.canonicalSnapshotId).toBe('snap-001')
    expect(applied.readback.lifecycleRev).toBe(7)
    expect(applied.readback.distinctTaskIds).toEqual(['t-1', 't-2'])
    // evidence preserved
    expect(storage.state().lifecycleEvidenceByTask['t-1']).toEqual({
      stage: 'MAPPED',
      receiptId: 'ev-live-1',
    })
    // Retained pinned snapshot payload is readable after apply (single-authority read path).
    const pinned = await storage.getPinnedSnapshot('mfs-rebuild')
    expect(pinned?.snapshot?.manifest.snapshotId).toBe('snap-001')
    expect(pinned?.snapshot?.payload.tasks.map((t) => t.id).sort()).toEqual(['t-1', 't-2'])
    expect(pinned?.pin.canonicalHash).toBe(canonicalSubjectHash(snap))
  })

  it('idempotent replay returns original body', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const storage = createMemoryImportStorage(emptyBoard())
    const idem = createMemoryIdempotencyStorage()
    const revs = createMemoryRevisionStore([
      {
        boardId: 'mfs-rebuild',
        entityType: 'canonical_import',
        entityId: 'mfs-rebuild',
        entityRev: 0,
        boardRev: 0,
        subjectHash: '',
      },
    ])
    const first = await applyImport(storage, idem, revs, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'idem-replay',
      importId: 'imp-r1',
    })
    // second apply with same key — revision already advanced; replay before CAS
    const second = await applyImport(storage, idem, revs, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'idem-replay',
      importId: 'imp-r1',
    })
    expect(second.kind).toBe('REPLAY')
    expect(second.importId).toBe(first.importId)
    expect(second.payloadSha256).toBe(first.payloadSha256)
  })

  it('idempotency conflict on different request hash', async () => {
    const snap1 = buildSnapshotFromInput(baseInput({ snapshotId: 'snap-a' }))
    const snap2 = buildSnapshotFromInput(
      baseInput({ snapshotId: 'snap-b', generatedAt: '2026-07-13T10:00:00.000Z' }),
    )
    const storage = createMemoryImportStorage(emptyBoard())
    const idem = createMemoryIdempotencyStorage()
    const revs = createMemoryRevisionStore([
      {
        boardId: 'mfs-rebuild',
        entityType: 'canonical_import',
        entityId: 'mfs-rebuild',
        entityRev: 0,
        boardRev: 0,
        subjectHash: '',
      },
    ])
    await applyImport(storage, idem, revs, {
      auth,
      snapshot: snap1,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'same-key',
      importId: 'imp-a',
    })
    await expect(
      applyImport(storage, idem, revs, {
        auth,
        snapshot: snap2,
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedSubjectHash: canonicalSubjectHash(snap1),
        idempotencyKey: 'same-key',
        importId: 'imp-b',
      }),
    ).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT })
  })

  it('rejects stale entity/board rev (STALE_REVISION)', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const storage = createMemoryImportStorage(emptyBoard({ boardRev: 5, entityRev: 3, subjectHash: 'abc' }))
    const idem = createMemoryIdempotencyStorage()
    await expect(
      applyImport(storage, idem, null, {
        auth,
        snapshot: snap,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        expectedSubjectHash: 'abc',
        idempotencyKey: 'stale-1',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('rejects out-of-order older generatedAt snapshot', async () => {
    const snapOld = buildSnapshotFromInput(
      baseInput({ snapshotId: 'snap-old', generatedAt: '2026-07-01T00:00:00.000Z' }),
    )
    const storage = createMemoryImportStorage(
      emptyBoard({
        boardRev: 1,
        entityRev: 1,
        subjectHash: 'x',
        lastSnapshotGeneratedAt: '2026-07-13T08:00:00.000Z',
        lastSnapshotId: 'snap-newer',
        lastPayloadSha256: 'ff'.repeat(32),
      }),
    )
    const idem = createMemoryIdempotencyStorage()
    await expect(
      applyImport(storage, idem, null, {
        auth,
        snapshot: snapOld,
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedSubjectHash: 'x',
        idempotencyKey: 'ooo-1',
      }),
    ).rejects.toMatchObject({ code: 'OUT_OF_ORDER_SNAPSHOT' })
  })

  it('rejects tampered payload hash on apply', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const bad: CanonicalSnapshot = {
      ...snap,
      manifest: { ...snap.manifest, payloadSha256: 'deadbeef'.repeat(8) },
    }
    const storage = createMemoryImportStorage(emptyBoard())
    const idem = createMemoryIdempotencyStorage()
    await expect(
      applyImport(storage, idem, null, {
        auth,
        snapshot: bad,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        expectedSubjectHash: '',
        idempotencyKey: 'tamper-1',
      }),
    ).rejects.toBeInstanceOf(ImportError)
  })

  it('does not fabricate lifecycle evidence — lifecycleRev unchanged after import', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const storage = createMemoryImportStorage(
      emptyBoard({
        lifecycleRev: 42,
        lifecycleEvidenceByTask: { 't-keep': { stage: 'FUNCTIONAL', receiptId: 'r1' } },
      }),
    )
    const idem = createMemoryIdempotencyStorage()
    const revs = createMemoryRevisionStore([
      {
        boardId: 'mfs-rebuild',
        entityType: 'canonical_import',
        entityId: 'mfs-rebuild',
        entityRev: 0,
        boardRev: 0,
        subjectHash: '',
      },
    ])
    const result = await applyImport(storage, idem, revs, {
      auth,
      snapshot: snap,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      expectedSubjectHash: '',
      idempotencyKey: 'no-fab',
    })
    expect(result.lifecycleRev).toBe(42)
    expect(storage.state().lifecycleEvidenceByTask['t-keep']).toEqual({
      stage: 'FUNCTIONAL',
      receiptId: 'r1',
    })
  })

  it('planImport: stale subject-hash fails via single CAS and reads board state once', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const base = createMemoryImportStorage(
      emptyBoard({
        boardRev: 4,
        entityRev: 2,
        subjectHash: 'live-subject-hash-aaaaaaaa',
      }),
    )
    let getBoardStateCalls = 0
    const storage = {
      ...base,
      async getBoardState(boardId: string) {
        getBoardStateCalls += 1
        return base.getBoardState(boardId)
      },
    }

    await expect(
      planImport(storage, {
        auth,
        snapshot: snap,
        entityExpectedRev: 2,
        expectedBoardRev: 4,
        expectedSubjectHash: 'stale-client-hash-bbbbbbbb',
      }),
    ).rejects.toMatchObject({
      code: 'STALE_REVISION',
      httpStatus: 409,
    })

    expect(getBoardStateCalls).toBe(1)

    // Correct hash still plans with a single read.
    getBoardStateCalls = 0
    const plan = await planImport(storage, {
      auth,
      snapshot: snap,
      entityExpectedRev: 2,
      expectedBoardRev: 4,
      expectedSubjectHash: 'live-subject-hash-aaaaaaaa',
    })
    expect(plan.ok).toBe(true)
    expect(plan.nextEntityRev).toBe(3)
    expect(plan.nextBoardRev).toBe(5)
    expect(getBoardStateCalls).toBe(1)
  })

  it('planImport: stale entity/board rev fails closed via CAS (single read)', async () => {
    const snap = buildSnapshotFromInput(baseInput())
    const base = createMemoryImportStorage(
      emptyBoard({ boardRev: 9, entityRev: 5, subjectHash: 'abc' }),
    )
    let reads = 0
    const storage = {
      ...base,
      async getBoardState(boardId: string) {
        reads += 1
        return base.getBoardState(boardId)
      },
    }
    await expect(
      planImport(storage, {
        auth,
        snapshot: snap,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        expectedSubjectHash: 'abc',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
    expect(reads).toBe(1)
  })
})
