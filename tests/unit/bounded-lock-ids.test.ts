/**
 * Bounded opaque lock IDs (VARCHAR(64) safe): pure hash helpers + memory store lifecycle.
 * runId schema max 160; repo_id 160; tracking_branch 255 — lock_id must stay ≤64.
 */
import { describe, expect, it } from 'vitest'

import { createFakeClock } from '#/server/board-store'
import {
  acquireCollisionLocks,
  collisionLockId,
  createMemoryLockStore,
  integrationLockId,
  releaseCollisionLocks,
  renewCollisionLocks,
  supersedeCollisionLock,
} from '#/server/locks'

const RUN_ID_160 = 'r'.repeat(160)
const REPO_ID_160 = 'p'.repeat(160)
const BRANCH_255 = 'b'.repeat(255)

describe('collisionLockId / integrationLockId pure', () => {
  it('identical inputs → identical IDs', () => {
    const a = collisionLockId('resources:db', 'run-1')
    const b = collisionLockId('resources:db', 'run-1')
    expect(a).toBe(b)
    const ia = integrationLockId('repo', 'main', 'run-1')
    const ib = integrationLockId('repo', 'main', 'run-1')
    expect(ia).toBe(ib)
  })

  it('different inputs → different IDs', () => {
    expect(collisionLockId('resources:db', 'run-1')).not.toBe(
      collisionLockId('resources:db', 'run-2'),
    )
    expect(collisionLockId('resources:db', 'run-1')).not.toBe(
      collisionLockId('resources:cache', 'run-1'),
    )
    expect(integrationLockId('repo-a', 'main', 'run-1')).not.toBe(
      integrationLockId('repo-b', 'main', 'run-1'),
    )
    expect(integrationLockId('repo', 'main', 'run-1')).not.toBe(
      integrationLockId('repo', 'dev', 'run-1'),
    )
    expect(integrationLockId('repo', 'main', 'run-1')).not.toBe(
      integrationLockId('repo', 'main', 'run-2'),
    )
  })

  it('runId length 160 → length 36 and ≤64', () => {
    const id = collisionLockId('resources:db', RUN_ID_160)
    expect(id.length).toBe(36)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id.startsWith('clk-')).toBe(true)
    expect(id).toMatch(/^clk-[0-9a-f]{32}$/)
  })

  it('max repo/branch/run → integration length 36 and ≤64', () => {
    const id = integrationLockId(REPO_ID_160, BRANCH_255, RUN_ID_160)
    expect(id.length).toBe(36)
    expect(id.length).toBeLessThanOrEqual(64)
    expect(id.startsWith('ilk-')).toBe(true)
    expect(id).toMatch(/^ilk-[0-9a-f]{32}$/)
    // Unbounded template would overflow VARCHAR(64) badly
    const legacyLen =
      `ilk-${REPO_ID_160}-${BRANCH_255}-${RUN_ID_160}`.length
    expect(legacyLen).toBeGreaterThan(64)
    expect(id.length).toBeLessThan(legacyLen)
  })

  it('trims scope whitespace for collision determinism', () => {
    expect(collisionLockId('  resources:db  ', 'run-1')).toBe(
      collisionLockId('resources:db', 'run-1'),
    )
  })

  it('short and long runId both constant-bounded (no embedding of raw runId)', () => {
    const short = collisionLockId('s', 'x')
    const long = collisionLockId('s', RUN_ID_160)
    expect(short.length).toBe(36)
    expect(long.length).toBe(36)
    expect(long.includes(RUN_ID_160)).toBe(false)
  })
})

describe('memory store: acquire / renew / release / supersede with long runId', () => {
  it('acquire + renew + release with runId len 160', async () => {
    const clock = createFakeClock(Date.parse('2026-07-14T00:00:00.000Z'))
    const store = createMemoryLockStore()
    const runId = RUN_ID_160
    const scope = 'resources:bounded-long-run'

    const acq = await acquireCollisionLocks(store, clock, {
      boardId: 'board-b',
      taskId: 'task-1',
      runId,
      agentId: 'agent-1',
      role: 'AUTHOR',
      collisionScopeLockIds: [scope],
    })
    expect(acq.locks).toHaveLength(1)
    const lock = acq.locks[0]!
    expect(lock.lockId).toBe(collisionLockId(scope, runId))
    expect(lock.lockId.length).toBeLessThanOrEqual(64)
    expect(lock.runId).toBe(runId)
    expect(lock.state).toBe('HELD')

    const byScope = await store.getCollisionByScope('board-b', scope)
    expect(byScope?.lockId).toBe(lock.lockId)
    expect(byScope?.runId).toBe(runId)

    const renewed = await renewCollisionLocks(store, clock, {
      boardId: 'board-b',
      runId,
      fencingToken: acq.fencingToken,
      leaseMs: 120_000,
    })
    expect(renewed).toHaveLength(1)
    expect(renewed[0]!.lockId).toBe(lock.lockId)
    expect(renewed[0]!.entityRev).toBe(lock.entityRev + 1)
    expect(renewed[0]!.runId).toBe(runId)

    const released = await releaseCollisionLocks(store, clock, {
      boardId: 'board-b',
      runId,
      fencingToken: acq.fencingToken,
    })
    expect(released).toHaveLength(1)
    expect(released[0]!.state).toBe('RELEASED')
    expect(released[0]!.lockId).toBe(lock.lockId)
    expect(await store.getCollisionByScope('board-b', scope)).toBeNull()
  })

  it('supersede chains opaque lockIds with long newRunId', async () => {
    const clock = createFakeClock(Date.parse('2026-07-14T00:00:00.000Z'))
    const store = createMemoryLockStore()
    const scope = 'resources:supersede-bounded'
    const oldRun = 'run-old-short'
    const newRun = RUN_ID_160

    const acq = await acquireCollisionLocks(store, clock, {
      boardId: 'board-s',
      taskId: 'task-old',
      runId: oldRun,
      agentId: 'agent-old',
      role: 'AUTHOR',
      collisionScopeLockIds: [scope],
    })
    const prevId = acq.locks[0]!.lockId
    expect(prevId).toBe(collisionLockId(scope, oldRun))

    const { previous, next } = await supersedeCollisionLock(store, clock, {
      boardId: 'board-s',
      scopeId: scope,
      expectedFencingToken: acq.fencingToken,
      newRunId: newRun,
      newTaskId: 'task-new',
      newAgentId: 'agent-new',
      newRole: 'AUTHOR',
    })

    expect(previous.state).toBe('SUPERSEDED')
    expect(previous.supersededByLockId).toBe(next.lockId)
    expect(next.supersedesLockId).toBe(previous.lockId)
    expect(next.supersedesLockId).toBe(prevId)
    expect(next.lockId).toBe(collisionLockId(scope, newRun))
    expect(next.lockId.length).toBeLessThanOrEqual(64)
    expect(next.lockId).not.toBe(prevId)
    expect(next.runId).toBe(newRun)
    expect(next.fencingVersion).toBe(previous.fencingVersion + 1)

    const held = await store.getCollisionByScope('board-s', scope)
    expect(held?.lockId).toBe(next.lockId)
    expect(held?.runId).toBe(newRun)
  })

  it('legacy-format lockId still works as opaque PK for renew/release (compat)', async () => {
    const clock = createFakeClock(Date.parse('2026-07-14T00:00:00.000Z'))
    const store = createMemoryLockStore()
    const legacyId = 'clk-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-short'
    const rec = {
      boardId: 'board-leg',
      lockId: legacyId,
      scopeId: 'resources:legacy',
      taskId: 't1',
      runId: 'run-leg',
      agentId: 'a1',
      role: 'AUTHOR' as const,
      fencingToken: 'fence-leg',
      fencingVersion: 1,
      state: 'HELD' as const,
      leaseExpiresAtMs: clock.nowMs() + 60_000,
      acquiredAtMs: clock.nowMs(),
      releasedAtMs: null,
      supersededByLockId: null,
      supersedesLockId: null,
      entityRev: 1,
    }
    await store.putCollision(rec)

    const renewed = await renewCollisionLocks(store, clock, {
      boardId: 'board-leg',
      runId: 'run-leg',
      fencingToken: 'fence-leg',
    })
    expect(renewed[0]!.lockId).toBe(legacyId)

    const released = await releaseCollisionLocks(store, clock, {
      boardId: 'board-leg',
      runId: 'run-leg',
      fencingToken: 'fence-leg',
    })
    expect(released[0]!.lockId).toBe(legacyId)
    expect(released[0]!.state).toBe('RELEASED')
  })
})
