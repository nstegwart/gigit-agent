/**
 * H2 security — healthz pin non-mix when board_revisions lacks canonical_snapshot_id.
 * Exercises resolveHealthzSnapshotPin (loader query result composition) for:
 * - old rev vs latest snapshot mismatch → fail-closed incomplete pin
 * - matching rev → accept latest snap id/hash
 * - missing snapshot row → leave id/hash null
 * - never overwrite non-null subject_hash
 * - id-scoped hash fill only (no latest mix)
 */
import { describe, expect, it } from 'vitest'

import {
  resolveHealthzSnapshotPin,
  type HealthzRevisionPinRow,
  type HealthzSnapshotPinRow,
} from '#/routes/api.healthz'

const HASH_REV = 'b'.repeat(64)
const HASH_SNAP = 'c'.repeat(64)
const HASH_OTHER = 'd'.repeat(64)

function rev(
  partial: Partial<HealthzRevisionPinRow> &
    Pick<HealthzRevisionPinRow, 'boardRev' | 'lifecycleRev'>,
): HealthzRevisionPinRow {
  return {
    canonicalSnapshotId: null,
    subjectHash: null,
    ...partial,
  }
}

function snap(
  partial: Partial<HealthzSnapshotPinRow> &
    Pick<HealthzSnapshotPinRow, 'snapshotId' | 'boardRev' | 'lifecycleRev'>,
): HealthzSnapshotPinRow {
  return {
    payloadSha256: HASH_SNAP,
    ...partial,
  }
}

describe('H2 resolveHealthzSnapshotPin — loader query composition', () => {
  it('old rev vs latest mismatch: board_rev=5 + null snapshot_id + latest board_rev=10 → no mixed pin', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({ boardRev: 5, lifecycleRev: 2, subjectHash: null }),
      latestSnap: snap({
        snapshotId: 'snap-latest-10',
        boardRev: 10,
        lifecycleRev: 4,
        payloadSha256: HASH_SNAP,
      }),
    })
    // Keep revision revs; do not emit latest snapshot id/hash against old revs.
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
    expect(out.canonicalSnapshotId).toBeNull()
    expect(out.canonicalHash).toBeNull()
  })

  it('old rev vs latest lifecycle-only mismatch → fail-closed (id/hash null)', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({ boardRev: 5, lifecycleRev: 2 }),
      latestSnap: snap({
        snapshotId: 'snap-same-board',
        boardRev: 5,
        lifecycleRev: 99,
      }),
    })
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
    expect(out.canonicalSnapshotId).toBeNull()
    expect(out.canonicalHash).toBeNull()
  })

  it('matching rev: latest snap board_rev/lifecycle_rev equal revision → fill id+hash', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({ boardRev: 5, lifecycleRev: 2, subjectHash: null }),
      latestSnap: snap({
        snapshotId: 'snap-match-5',
        boardRev: 5,
        lifecycleRev: 2,
        payloadSha256: HASH_SNAP,
      }),
    })
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
    expect(out.canonicalSnapshotId).toBe('snap-match-5')
    expect(out.canonicalHash).toBe(HASH_SNAP)
  })

  it('missing row: finite revs + null snapshot_id + no latest snap → leave id/hash null', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({ boardRev: 5, lifecycleRev: 2, subjectHash: null }),
      latestSnap: null,
    })
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
    expect(out.canonicalSnapshotId).toBeNull()
    expect(out.canonicalHash).toBeNull()
  })

  it('never overwrites non-null subject_hash even when revs match and latest has different hash', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({
        boardRev: 5,
        lifecycleRev: 2,
        subjectHash: HASH_REV,
      }),
      latestSnap: snap({
        snapshotId: 'snap-match-5',
        boardRev: 5,
        lifecycleRev: 2,
        payloadSha256: HASH_OTHER,
      }),
    })
    expect(out.canonicalSnapshotId).toBe('snap-match-5')
    expect(out.canonicalHash).toBe(HASH_REV)
    expect(out.canonicalHash).not.toBe(HASH_OTHER)
  })

  it('mismatch keeps subject_hash and does not attach latest snapshot id', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({
        boardRev: 5,
        lifecycleRev: 2,
        subjectHash: HASH_REV,
      }),
      latestSnap: snap({
        snapshotId: 'snap-latest-10',
        boardRev: 10,
        lifecycleRev: 4,
        payloadSha256: HASH_SNAP,
      }),
    })
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
    expect(out.canonicalSnapshotId).toBeNull()
    expect(out.canonicalHash).toBe(HASH_REV)
  })

  it('missing row still preserves subject_hash from revision', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({
        boardRev: 5,
        lifecycleRev: 2,
        subjectHash: HASH_REV,
      }),
      latestSnap: null,
    })
    expect(out.canonicalSnapshotId).toBeNull()
    expect(out.canonicalHash).toBe(HASH_REV)
  })

  it('id present + empty subject_hash → fill hash only from pinnedSnapHash (id-scoped), ignore latest', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({
        boardRev: 5,
        lifecycleRev: 2,
        canonicalSnapshotId: 'snap-pinned',
        subjectHash: null,
      }),
      latestSnap: snap({
        snapshotId: 'snap-latest-other',
        boardRev: 99,
        lifecycleRev: 99,
        payloadSha256: HASH_OTHER,
      }),
      pinnedSnapHash: HASH_SNAP,
    })
    expect(out.canonicalSnapshotId).toBe('snap-pinned')
    expect(out.canonicalHash).toBe(HASH_SNAP)
    expect(out.boardRev).toBe(5)
    expect(out.lifecycleRev).toBe(2)
  })

  it('id present + missing pinned row (null pinnedSnapHash) → leave hash null fail-closed', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({
        boardRev: 5,
        lifecycleRev: 2,
        canonicalSnapshotId: 'snap-pinned',
        subjectHash: null,
      }),
      latestSnap: null,
      pinnedSnapHash: null,
    })
    expect(out.canonicalSnapshotId).toBe('snap-pinned')
    expect(out.canonicalHash).toBeNull()
  })

  it('no finite revs (null revision pin) + latest snap → accept latest id/hash/revs', () => {
    const out = resolveHealthzSnapshotPin({
      revision: null,
      latestSnap: snap({
        snapshotId: 'snap-only',
        boardRev: 10,
        lifecycleRev: 4,
        payloadSha256: HASH_SNAP,
      }),
    })
    expect(out.boardRev).toBe(10)
    expect(out.lifecycleRev).toBe(4)
    expect(out.canonicalSnapshotId).toBe('snap-only')
    expect(out.canonicalHash).toBe(HASH_SNAP)
  })

  it('revision row exists but revs null + latest snap → accept latest (no finite-rev gate)', () => {
    const out = resolveHealthzSnapshotPin({
      revision: rev({ boardRev: null, lifecycleRev: null, subjectHash: null }),
      latestSnap: snap({
        snapshotId: 'snap-fill',
        boardRev: 3,
        lifecycleRev: 1,
      }),
    })
    expect(out.canonicalSnapshotId).toBe('snap-fill')
    expect(out.boardRev).toBe(3)
    expect(out.lifecycleRev).toBe(1)
    expect(out.canonicalHash).toBe(HASH_SNAP)
  })
})
