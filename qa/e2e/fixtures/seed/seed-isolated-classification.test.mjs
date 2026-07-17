import assert from 'node:assert/strict'
import test from 'node:test'

import {
  persistDurableClassificationAuthority,
  readbackSeedProof,
  seedIsolatedControlCenter,
} from './seed-isolated.mjs'
import { DEFAULT_BOARD_ID } from './control-center-fixture.mjs'
import {
  dropIsolatedDatabase,
  makeIsolatedDbName,
  withDbConnection,
} from '../../lib/db-iso.mjs'

test('isolated seed publishes canonical-pin durable classifications through bootstrap revisions', async () => {
  const dbName = makeIsolatedDbName('classification_r1')
  const now = '2026-07-15T12:00:00.000Z'
  const provenancePath = process.env.CAIRN_SEED_CLASSIFICATION_PROVENANCE_PATH
  assert.ok(
    provenancePath,
    'CAIRN_SEED_CLASSIFICATION_PROVENANCE_PATH is required for write-fenced proof output',
  )

  try {
    const seeded = await seedIsolatedControlCenter({
      dbName,
      now,
      provenancePath,
    })
    const expectedClassified = seeded.contract.classifiedCount
    const expectedUnclassified = seeded.contract.unclassifiedCount

    const proof = await withDbConnection(dbName, async (db) => {
      const before = await readbackSeedProof(db, DEFAULT_BOARD_ID)
      assert.equal(before.seedProof.durableClassifiedTasks, expectedClassified)
      assert.equal(
        before.seedProof.durableCanonicalPinCount,
        expectedClassified,
      )
      assert.equal(
        before.tasks - before.seedProof.durableClassifiedTasks,
        expectedUnclassified,
      )
      assert.equal(
        before.seedProof.durableClassificationTaskIds.includes(
          'task-missing-proof-1',
        ),
        false,
      )

      for (const record of before.durableClassifications) {
        assert.equal(record.canonicalSnapshotId, seeded.pin.canonicalSnapshotId)
        assert.equal(record.canonicalHash, seeded.pin.canonicalHash)
        assert.equal(record.taskHash, seeded.pin.taskHash)
        assert.equal(record.lifecycleRev, Number(seeded.pin.lifecycleRev))
        assert.equal(record.receipt?.bindingMode, 'CANONICAL_PIN')
        assert.equal(
          Number(record.receipt?.canonicalBoardRev) + 1,
          Number(record.receipt?.boardRev),
        )
      }

      // Dispatch + account bootstrap are volatile writes that advance boardRev.
      await db.query(
        'UPDATE board_revisions SET board_rev=board_rev+2 WHERE board_id=?',
        [DEFAULT_BOARD_ID],
      )
      const afterBootstrap = await readbackSeedProof(db, DEFAULT_BOARD_ID)
      assert.equal(
        afterBootstrap.seedProof.durableClassifiedTasks,
        expectedClassified,
      )
      assert.equal(
        afterBootstrap.seedProof.durableCanonicalPinCount,
        expectedClassified,
      )
      assert.equal(
        afterBootstrap.pin.boardRev,
        String(Number(seeded.pin.boardRev) + 2),
      )
      for (const record of afterBootstrap.durableClassifications) {
        assert.ok(
          Number(afterBootstrap.pin.boardRev) >=
            Number(record.receipt?.boardRev),
        )
        assert.equal(
          record.receipt?.canonicalHash,
          afterBootstrap.pin.subjectHash,
        )
        assert.equal(
          record.receipt?.lifecycleRev,
          Number(afterBootstrap.pin.lifecycleRev),
        )
      }

      // Same fixture publication is idempotent and restores the exact current set.
      const replay = await persistDurableClassificationAuthority(db, {
        boardId: DEFAULT_BOARD_ID,
        boundTasks: seeded.readback.taskIds.map((taskId) => {
          const record = before.durableClassifications.find(
            (item) => item.taskId === taskId,
          )
          return record
            ? {
                id: taskId,
                data: {
                  classification: {
                    taskClass: record.taskClass,
                    disposition: record.disposition,
                    receipt: record.receipt,
                  },
                },
              }
            : { id: taskId, data: {} }
        }),
        pin: {
          canonicalSnapshotId: seeded.pin.canonicalSnapshotId,
          canonicalHash: seeded.pin.canonicalHash,
          taskHash: seeded.pin.taskHash,
          boardRev: Number(seeded.pin.boardRev),
          lifecycleRev: Number(seeded.pin.lifecycleRev),
        },
        actor: 'classification-regression-replay',
      })
      const afterReplay = await readbackSeedProof(db, DEFAULT_BOARD_ID)
      assert.equal(replay.classifiedCount, expectedClassified)
      assert.equal(replay.unclassifiedCount, expectedUnclassified)
      assert.deepEqual(
        afterReplay.seedProof.durableClassificationTaskIds,
        before.seedProof.durableClassificationTaskIds,
      )

      return {
        expectedClassified,
        expectedUnclassified,
        beforeBoardRev: before.pin.boardRev,
        afterBootstrapBoardRev: afterBootstrap.pin.boardRev,
        durableClassificationTaskIds:
          before.seedProof.durableClassificationTaskIds,
        canonicalPinRows: before.seedProof.durableCanonicalPinCount,
        replayClassified: replay.classifiedCount,
      }
    })

    console.log(`CLASSIFICATION_SEED_PROOF ${JSON.stringify(proof)}`)
  } finally {
    const cleanup = await dropIsolatedDatabase(dbName)
    assert.equal(cleanup.stillPresent, false)
  }
})
