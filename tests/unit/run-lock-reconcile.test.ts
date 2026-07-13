import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import {
  acquireCollisionLocks,
  acquireIntegrationLock,
  assertSafeLockPath,
  createMemoryLockStore,
  LockError,
  normalizePath,
  pathsOverlap,
  releaseCollisionLocks,
  scopesCollide,
  supersedeCollisionLock,
} from '#/server/locks'
import {
  applyReconcile,
  claimReconcilerLeadership,
  classifyRunForReconcile,
  createMemoryReconcilerStore,
  dryRunReconcile,
  tasksWithReconciliationPending,
  type ReconcilerDeps,
} from '#/server/reconciler'
import {
  createMemoryRunRegistryStore,
  heartbeatRun,
  registerRun,
  RunRegistryError,
  RUN_STALL_MS,
  terminateRun,
  type RunRegistryDeps,
  type RunRecord,
  type RegisterRunRequest,
} from '#/server/run-registry'

const BOARD = 'mfs-rebuild'

/** OPEN capacity — allows Grok + non-Grok (success-path default). */
function openCapacity(): NonNullable<RegisterRunRequest['capacity']> {
  return {
    dispatchMode: 'OPEN',
    dispatchAllowed: true,
    usableCapacity: 100,
    nonGrokAssignmentAllowed: true,
    grokAssignmentAllowed: true,
    limitingReasons: [],
  }
}

function grokOnlyCapacity(): NonNullable<RegisterRunRequest['capacity']> {
  return {
    dispatchMode: 'GROK_ONLY',
    dispatchAllowed: true,
    usableCapacity: 5,
    nonGrokAssignmentAllowed: false,
    grokAssignmentAllowed: true,
    limitingReasons: ['GROK_ONLY_RECOVERY'],
  }
}

function blockedCapacity(reason = 'ASSIGNMENT_BLOCKED'): NonNullable<RegisterRunRequest['capacity']> {
  return {
    dispatchMode: 'BLOCKED',
    dispatchAllowed: false,
    usableCapacity: 0,
    nonGrokAssignmentAllowed: false,
    grokAssignmentAllowed: false,
    limitingReasons: [reason],
  }
}

function staleZeroCapacity(): NonNullable<RegisterRunRequest['capacity']> {
  return {
    dispatchMode: 'BLOCKED',
    dispatchAllowed: false,
    usableCapacity: 0,
    nonGrokAssignmentAllowed: false,
    grokAssignmentAllowed: false,
    limitingReasons: ['ACCOUNT_SYNC_STALE'],
  }
}

function harness(startMs = Date.parse('2026-07-13T10:00:00.000Z')) {
  const clock = createFakeClock(startMs)
  const locks = createMemoryLockStore()
  const runs = createMemoryRunRegistryStore()
  const atomic = createMemoryControlPlaneAtomicStore([
    { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
  ])
  const idempotency = createMemoryIdempotencyStorage()
  const reconciler = createMemoryReconcilerStore()
  // Default getCapacity = OPEN so legacy success paths still exercise register after capacity gate.
  const runDeps: RunRegistryDeps = {
    clock,
    runs,
    locks,
    atomic,
    idempotency,
    getCapacity: async () => openCapacity(),
  }
  const recDeps: ReconcilerDeps = { clock, runs, locks, reconciler, atomic }
  return { clock, locks, runs, atomic, idempotency, reconciler, runDeps, recDeps }
}

/**
 * Full control-plane mutation surface snapshot used to prove capacity denial
 * happens before board lock / claim / collision / audit mutation.
 */
async function captureMutationSurface(h: ReturnType<typeof harness>) {
  const board = await h.atomic.getBoardState(BOARD)
  const collision = h.locks.snapshot().collision.map((l) => ({
    lockId: l.lockId,
    runId: l.runId,
    state: l.state,
    scopeId: l.scopeId,
    fencingToken: l.fencingToken,
  }))
  const integration = h.locks.snapshot().integration.map((l) => ({
    lockId: l.lockId,
    runId: l.runId,
    state: l.state,
  }))
  const runs = h.runs.snapshot().map((r) => ({
    runId: r.runId,
    state: r.state,
    agentId: r.agentId,
    model: r.model,
    fencingToken: r.fencingToken,
    entityRev: r.entityRev,
  }))
  const audit = h.atomic.auditSnapshot().map((e) => ({
    kind: e.kind,
    subjectId: e.subjectId,
    material: e.material,
    detailRunId: e.detail && typeof e.detail === 'object' ? (e.detail as { runId?: string }).runId : undefined,
  }))
  return {
    boardRev: board.boardRev,
    dispatchBlocked: board.dispatchBlocked,
    collision,
    integration,
    runs,
    audit,
  }
}

/** Assert denial left zero run rows, zero HELD locks for runId, zero audit for runId. */
async function assertZeroMutation(
  h: ReturnType<typeof harness>,
  runId: string,
): Promise<void> {
  expect(await h.runs.get(BOARD, runId)).toBeNull()
  const held = h.locks.snapshot().collision.filter((l) => l.state === 'HELD' && l.runId === runId)
  expect(held).toHaveLength(0)
  const audit = h.atomic.auditSnapshot().filter(
    (e) => e.subjectId === runId || (e.detail && (e.detail as { runId?: string }).runId === runId),
  )
  expect(audit).toHaveLength(0)
}

/** Assert full mutation surface is byte-stable (deep equal) after a capacity denial. */
async function assertSurfaceUnchanged(
  h: ReturnType<typeof harness>,
  before: Awaited<ReturnType<typeof captureMutationSurface>>,
): Promise<void> {
  const after = await captureMutationSurface(h)
  expect(after).toEqual(before)
}

describe('AC-LOCK collision + integration locks', () => {
  it('pathsOverlap and scopesCollide pure helpers', () => {
    expect(pathsOverlap('src/**', 'src/a.ts')).toBe(true)
    expect(pathsOverlap('src/a', 'src/b')).toBe(false)
    expect(scopesCollide('repo:r:src/**', 'repo:r:src/x.ts')).toBe(true)
    expect(scopesCollide('repo:r:src/**', 'repo:other:src/**')).toBe(false)
    expect(scopesCollide('resources:plan-run', 'resources:plan-run')).toBe(true)
  })

  it('assertSafeLockPath rejects absolute, dot-dot, NUL, non-canonical paths', () => {
    expect(() => assertSafeLockPath('/etc/passwd')).toThrow(LockError)
    expect(() => assertSafeLockPath('C:\\Windows\\System32')).toThrow(LockError)
    expect(() => assertSafeLockPath('../secret')).toThrow(LockError)
    expect(() => assertSafeLockPath('src/../../etc')).toThrow(LockError)
    expect(() => assertSafeLockPath('foo\0bar')).toThrow(LockError)
    expect(() => assertSafeLockPath('src/./x')).toThrow(LockError)
    expect(() => assertSafeLockPath('src//x')).toThrow(LockError)
    expect(() => assertSafeLockPath('/**')).toThrow(LockError)
    expect(() => normalizePath('../x')).toThrow(LockError)
    // Safe relative globs still normalize
    expect(normalizePath('src/**')).toBe('src')
    expect(normalizePath('src/a.ts')).toBe('src/a.ts')
  })

  it('acquireCollisionLocks rejects unsafe scopes before any lock mutation', async () => {
    const { locks, clock } = harness()
    const before = locks.snapshot().collision.length
    for (const scope of [
      'repo:ex:/absolute/**',
      'repo:ex:../escape/**',
      'path:/etc/passwd',
      'path:foo/../bar',
      'repo:ex:src\0evil/**',
      'path:src/./x',
    ] as const) {
      await expect(
        acquireCollisionLocks(locks, clock, {
          boardId: BOARD,
          taskId: 'T-bad',
          runId: `run-bad-${scope.slice(0, 12)}`,
          agentId: 'a1',
          role: 'AUTHOR',
          collisionScopeLockIds: [scope],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(locks.snapshot().collision.length).toBe(before)
    }
  })

  it('acquireIntegrationLock rejects absolute/dot-dot/NUL pathspecs before lock', async () => {
    const { locks, clock } = harness()
    const before = locks.snapshot().integration.length
    for (const pathspecs of [
      ['/abs/**'],
      ['../escape'],
      ['src\0x'],
      ['src/./x'],
      ['src//y'],
    ] as const) {
      await expect(
        acquireIntegrationLock(locks, clock, {
          boardId: BOARD,
          repoId: 'gigit-agent',
          trackingBranch: 'main',
          runId: `int-bad-${pathspecs[0]}`,
          agentId: 'integrator-1',
          integratorModel: 'grok-4.5',
          rootAcceptanceId: 'ra-1',
          checkpointId: 'cp-1',
          pathspecs: [...pathspecs],
        }),
      ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
      expect(locks.snapshot().integration.length).toBe(before)
    }
    // Non-exact integrator model (substring "grok") rejected
    await expect(
      acquireIntegrationLock(locks, clock, {
        boardId: BOARD,
        repoId: 'gigit-agent',
        trackingBranch: 'main',
        runId: 'int-bad-model',
        agentId: 'integrator-1',
        integratorModel: 'my-grok-fork',
        rootAcceptanceId: 'ra-1',
        checkpointId: 'cp-1',
        pathspecs: ['src/**'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(locks.snapshot().integration.length).toBe(before)
  })

  it('AC-LOCK-01: overlapping cross-task path collision atomically rejected', async () => {
    const { locks, clock } = harness()
    await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-1',
      runId: 'run-1',
      agentId: 'a1',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:src/**'],
    })
    await expect(
      acquireCollisionLocks(locks, clock, {
        boardId: BOARD,
        taskId: 'T-2',
        runId: 'run-2',
        agentId: 'a2',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:ex:src/foo.ts'],
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_COLLISION' })
  })

  it('AC-LOCK-02: lease/fence/terminal release', async () => {
    const { locks, clock } = harness()
    const acq = await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-1',
      runId: 'run-1',
      agentId: 'a1',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:a/**', 'resources:x'],
      leaseMs: 60_000,
    })
    expect(acq.locks).toHaveLength(2)
    expect(acq.fencingToken).toBeTruthy()

    await expect(
      releaseCollisionLocks(locks, clock, {
        boardId: BOARD,
        runId: 'run-1',
        fencingToken: 'wrong',
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })

    const released = await releaseCollisionLocks(locks, clock, {
      boardId: BOARD,
      runId: 'run-1',
      fencingToken: acq.fencingToken,
    })
    expect(released.every((l) => l.state === 'RELEASED')).toBe(true)

    // After release, other task can acquire
    const acq2 = await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-2',
      runId: 'run-2',
      agentId: 'a2',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:a/**'],
    })
    expect(acq2.locks).toHaveLength(1)
  })

  it('AC-LOCK-03: exactly one live integrator per repoId+trackingBranch', async () => {
    const { locks, clock } = harness()
    await acquireIntegrationLock(locks, clock, {
      boardId: BOARD,
      repoId: 'gigit-agent',
      trackingBranch: 'main',
      runId: 'int-1',
      agentId: 'integrator-1',
      integratorModel: 'grok-4.5',
      rootAcceptanceId: 'ra-1',
      checkpointId: 'cp-1',
      pathspecs: ['src/**'],
    })
    await expect(
      acquireIntegrationLock(locks, clock, {
        boardId: BOARD,
        repoId: 'gigit-agent',
        trackingBranch: 'main',
        runId: 'int-2',
        agentId: 'integrator-2',
        integratorModel: 'grok-4.5',
        rootAcceptanceId: 'ra-2',
        checkpointId: 'cp-2',
        pathspecs: ['src/**'],
      }),
    ).rejects.toMatchObject({ code: 'INTEGRATION_LOCKED' })
  })

  it('AC-LOCK-04: supersession pointer + fencing atomic', async () => {
    const { locks, clock } = harness()
    const acq = await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-1',
      runId: 'run-old',
      agentId: 'a1',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:only/**'],
    })
    const { previous, next } = await supersedeCollisionLock(locks, clock, {
      boardId: BOARD,
      scopeId: 'repo:ex:only/**',
      expectedFencingToken: acq.fencingToken,
      newRunId: 'run-new',
      newTaskId: 'T-1',
      newAgentId: 'a2',
      newRole: 'AUTHOR',
    })
    expect(previous.state).toBe('SUPERSEDED')
    expect(previous.supersededByLockId).toBe(next.lockId)
    expect(next.supersedesLockId).toBe(previous.lockId)
    expect(next.fencingVersion).toBe(previous.fencingVersion + 1)

    await expect(
      supersedeCollisionLock(locks, clock, {
        boardId: BOARD,
        scopeId: 'repo:ex:only/**',
        expectedFencingToken: acq.fencingToken,
        newRunId: 'run-x',
        newTaskId: 'T-1',
        newAgentId: 'a3',
        newRole: 'AUTHOR',
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
  })

  it('author/verifier conflict rejected', async () => {
    const { locks, clock } = harness()
    await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-1',
      runId: 'run-auth',
      agentId: 'a1',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:shared/**'],
    })
    await expect(
      acquireCollisionLocks(locks, clock, {
        boardId: BOARD,
        taskId: 'T-1',
        runId: 'run-ver',
        agentId: 'a2',
        role: 'VERIFIER',
        collisionScopeLockIds: ['repo:ex:shared/**'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHOR_VERIFIER_CONFLICT' })
  })

  it('acquire-all-or-none: partial failure leaves no new locks', async () => {
    const { locks, clock } = harness()
    await acquireCollisionLocks(locks, clock, {
      boardId: BOARD,
      taskId: 'T-hold',
      runId: 'run-hold',
      agentId: 'h',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:b/**'],
    })
    const before = locks.snapshot().collision.filter((l) => l.state === 'HELD').length
    await expect(
      acquireCollisionLocks(locks, clock, {
        boardId: BOARD,
        taskId: 'T-new',
        runId: 'run-new',
        agentId: 'n',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:ex:a/**', 'repo:ex:b/**'],
      }),
    ).rejects.toBeInstanceOf(LockError)
    const after = locks.snapshot().collision.filter((l) => l.state === 'HELD' && l.runId === 'run-new')
    expect(after).toHaveLength(0)
    expect(locks.snapshot().collision.filter((l) => l.state === 'HELD').length).toBe(before)
  })
})

describe('AC-INGEST register/heartbeat run registry', () => {
  it('AC-INGEST-03/04: register binds fields, unique runId, idempotency, visibility SLA constant', async () => {
    const h = harness()
    const r1 = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-1',
      planId: 'plan-1',
      planItemRank: 1,
      taskId: 'T-1',
      targetGate: 'FUNCTIONAL',
      role: 'PRODUCT',
      agentId: 'agent-1',
      model: 'grok-4.5',
      effort: 'high',
      maskedAccountRef: 'acct-mask-001',
      canonicalHash: 'canon-1',
      collisionScopeLockIds: ['repo:ex:t1/**'],
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-1',
      initialState: 'STARTING',
    })
    expect(r1.state).toBe('STARTING')
    expect(r1.fencingToken).toBeTruthy()
    expect(r1.visibleWithinMs).toBe(30_000)
    expect(r1.registeredAt).toBeTruthy()

    const replay = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-1',
      planId: 'plan-1',
      planItemRank: 1,
      taskId: 'T-1',
      targetGate: 'FUNCTIONAL',
      role: 'PRODUCT',
      agentId: 'agent-1',
      model: 'grok-4.5',
      effort: 'high',
      maskedAccountRef: 'acct-mask-001',
      canonicalHash: 'canon-1',
      collisionScopeLockIds: ['repo:ex:t1/**'],
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-1',
      initialState: 'STARTING',
    })
    expect(replay.replayed).toBe(true)

    const stored = await h.runs.get(BOARD, 'run-1')
    expect(stored?.maskedAccountRef).toBe('acct-mask-001')
    expect(stored?.canonicalHash).toBe('canon-1')
    expect(stored?.planId).toBe('plan-1')
    expect(stored?.effort).toBe('high')
  })

  it('QUEUED has no lease/claim; leased states enforce fencing', async () => {
    const h = harness()
    const q = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-q',
      taskId: 'T-Q',
      targetGate: 'BUILT',
      agentId: 'agent-q',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-q',
      initialState: 'QUEUED',
    })
    expect(q.fencingToken).toBeNull()
    expect(q.leaseExpiresAt).toBeNull()

    await expect(
      heartbeatRun(h.runDeps, {
        boardId: BOARD,
        runId: 'run-q',
        agentId: 'agent-q',
        fencingToken: 'x',
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_STATE' })
  })

  it('heartbeat: owning agent only, monotonic sequence, duplicate replay, material vs liveness', async () => {
    const h = harness()
    const reg = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-hb',
      taskId: 'T-HB',
      targetGate: 'FUNCTIONAL',
      agentId: 'owner',
      model: 'grok-4.5',
      collisionScopeLockIds: ['repo:ex:hb/**'],
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-hb',
      initialState: 'STARTING',
    })

    await expect(
      heartbeatRun(h.runDeps, {
        boardId: BOARD,
        runId: 'run-hb',
        agentId: 'intruder',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })

    await expect(
      heartbeatRun(h.runDeps, {
        boardId: BOARD,
        runId: 'run-hb',
        agentId: 'owner',
        fencingToken: 'wrong-fence',
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })

    const hb1 = await heartbeatRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-hb',
      agentId: 'owner',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
    })
    expect(hb1.state).toBe('RUNNING')
    expect(hb1.replayed).toBe(false)

    const dup = await heartbeatRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-hb',
      agentId: 'owner',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
    })
    expect(dup.replayed).toBe(true)

    // Material progress anchored far in the past → next heartbeat within lease marks STALLED
    // (without advancing clock past lease expiry).
    const oldProgress = new Date(h.clock.nowMs() - RUN_STALL_MS - 1).toISOString()
    const mat = await heartbeatRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-hb',
      agentId: 'owner',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 2,
      materialProgressAt: oldProgress,
      expectedEntityRev: 2,
      expectedBoardRev: 0,
    })
    expect(mat.materialProgressAt).toBeTruthy()
    expect(mat.stalled).toBe(true)

    // Fresh material progress recovers
    const recovered = await heartbeatRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-hb',
      agentId: 'owner',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 3,
      materialProgressAt: h.clock.nowISO(),
      expectedEntityRev: 3,
      expectedBoardRev: 0,
    })
    expect(recovered.stalled).toBe(false)

    // Heartbeats do not create one immutable audit each — only material events
    const audit = await h.atomic.listAudit(BOARD)
    expect(audit.some((a) => a.kind === 'RUN_MATERIAL_PROGRESS')).toBe(true)
    expect(audit.some((a) => a.kind === 'RUN_STALLED')).toBe(true)
    expect(audit.some((a) => a.kind === 'RUN_RECOVERED')).toBe(true)
    // no generic HEARTBEAT audit kind exists
    expect(audit.every((a) => a.material === true)).toBe(true)
    expect(audit.length).toBeLessThan(10)
  })

  it('expired lease rejects heartbeat; terminal preserves history', async () => {
    const h = harness()
    const reg = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-lease',
      taskId: 'T-L',
      targetGate: 'FUNCTIONAL',
      agentId: 'owner',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-lease',
      initialState: 'RUNNING',
    })
    h.clock.advance(61_000)
    await expect(
      heartbeatRun(h.runDeps, {
        boardId: BOARD,
        runId: 'run-lease',
        agentId: 'owner',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'LEASE_EXPIRED' })

    // Re-register path for terminate: fresh run
    const reg2 = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-term',
      taskId: 'T-T',
      targetGate: 'FUNCTIONAL',
      agentId: 'owner',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-term',
      initialState: 'RUNNING',
    })
    const term = await terminateRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-term',
      agentId: 'owner',
      fencingToken: reg2.fencingToken!,
      toState: 'SUCCEEDED',
      reason: 'done',
    })
    expect(term.state).toBe('SUCCEEDED')
    expect(term.history.length).toBeGreaterThanOrEqual(2)
    const again = await terminateRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-term',
      agentId: 'owner',
      fencingToken: reg2.fencingToken!,
      toState: 'FAILED',
      reason: 'noop',
    })
    expect(again.state).toBe('SUCCEEDED') // preserved
  })

  it('concurrent register lock race: one wins CLAIM_COLLISION', async () => {
    const h = harness()
    const base = {
      boardId: BOARD,
      taskId: 'T-RACE',
      targetGate: 'FUNCTIONAL' as const,
      model: 'grok-4.5',
      collisionScopeLockIds: ['repo:ex:race/**'],
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      initialState: 'STARTING' as const,
    }
    const results = await Promise.allSettled([
      registerRun(h.runDeps, {
        ...base,
        runId: 'run-race-a',
        agentId: 'a',
        idempotencyKey: 'race-a',
      }),
      registerRun(h.runDeps, {
        ...base,
        runId: 'run-race-b',
        agentId: 'b',
        idempotencyKey: 'race-b',
      }),
    ])
    const oks = results.filter((r) => r.status === 'fulfilled')
    const fails = results.filter((r) => r.status === 'rejected')
    expect(oks).toHaveLength(1)
    expect(fails).toHaveLength(1)
  })
})

describe('AC-BUCKET-07 + reconciler dry-run/apply/idempotency', () => {
  it('incomplete stale/orphan → RECONCILIATION_PENDING; completed → DONE overlay', () => {
    const now = Date.parse('2026-07-13T12:00:00.000Z')
    const base: RunRecord = {
      boardId: BOARD,
      runId: 'r1',
      state: 'RUNNING',
      planId: null,
      planItemRank: null,
      taskId: 'T-1',
      targetGate: 'FUNCTIONAL',
      role: 'PRODUCT',
      agentId: 'a',
      model: 'grok',
      effort: 'high',
      maskedAccountRef: null,
      canonicalHash: null,
      collisionScopeLockIds: [],
      fencingToken: 'f',
      fencingVersion: 1,
      registeredAtMs: now - 120_000,
      heartbeatAtMs: now - 120_000,
      leaseExpiresAtMs: now - 90_000,
      materialProgressAtMs: null,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      entityRev: 1,
      boardRev: 0,
      stalled: false,
      history: [],
      lastHeartbeatResponse: null,
      controllerRunId: null,
      parentRunId: null,
      idempotencyKey: null,
    }
    const incomplete = classifyRunForReconcile(base, now, false)
    expect(incomplete.reconciliationPending).toBe(true)
    expect(incomplete.classification).toBe('STALE')
    expect(incomplete.doneWithReconciliationOverlay).toBe(false)

    const complete = classifyRunForReconcile(base, now, true)
    expect(complete.reconciliationPending).toBe(false)
    expect(complete.doneWithReconciliationOverlay).toBe(true)
  })

  it('single-leader dry-run + apply same hash + idempotent rerun', async () => {
    const h = harness()
    const reg = await registerRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-rec',
      taskId: 'T-REC',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-rec',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-rec',
      initialState: 'RUNNING',
    })
    // Expire lease past grace
    h.clock.advance(60_000 + 30_000 + 1)

    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-1',
    })
    const dry = await dryRunReconcile(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-1',
      fencingToken: leader.fencingToken,
      expectedBoardRev: 0,
      maxActions: 100,
    })
    expect(dry.items.length).toBeGreaterThanOrEqual(1)
    expect(dry.dryRunHash).toBeTruthy()
    expect(dry.maxActions).toBe(100)
    const pending = tasksWithReconciliationPending(dry.items)
    expect(pending).toContain('T-REC')

    const apply1 = await applyReconcile(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-1',
      fencingToken: leader.fencingToken,
      dryRunHash: dry.dryRunHash,
      expectedBoardRev: 0,
    })
    expect(apply1.applied).toBe(true)
    expect(apply1.idempotentReplay).toBe(false)
    expect(apply1.appliedCount).toBeGreaterThanOrEqual(1)

    const after = await h.runs.get(BOARD, 'run-rec')
    expect(after?.state).toBe('STALE')
    expect(after?.history.some((x) => x.reason.startsWith('reconcile:'))).toBe(true)

    const apply2 = await applyReconcile(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-1',
      fencingToken: leader.fencingToken,
      dryRunHash: dry.dryRunHash,
      expectedBoardRev: apply1.boardRev,
    })
    expect(apply2.idempotentReplay).toBe(true)

    // Second leader rejected while lease holds
    h.clock.advance(1)
    await expect(
      claimReconcilerLeadership(h.recDeps, { boardId: BOARD, leaderId: 'leader-2' }),
    ).rejects.toMatchObject({ code: 'NOT_LEADER' })

    // Preserve fencing token on run until terminal
    expect(reg.fencingToken).toBeTruthy()
  })

  it('maxActions capped at 100', async () => {
    const h = harness()
    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-cap',
    })
    await expect(
      dryRunReconcile(h.recDeps, {
        boardId: BOARD,
        leaderId: 'leader-cap',
        fencingToken: leader.fencingToken,
        maxActions: 101,
      }),
    ).rejects.toMatchObject({ code: 'BUDGET_EXCEEDED' })
  })

  it('adversarial: dry-run fencing/STALE_REVISION; apply rejects hash mismatch', async () => {
    const h = harness()
    const leader = await claimReconcilerLeadership(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-adv',
    })

    await expect(
      dryRunReconcile(h.recDeps, {
        boardId: BOARD,
        leaderId: 'leader-adv',
        fencingToken: 'wrong-fence',
      }),
    ).rejects.toMatchObject({ code: 'NOT_LEADER' })

    await expect(
      dryRunReconcile(h.recDeps, {
        boardId: BOARD,
        leaderId: 'leader-adv',
        fencingToken: leader.fencingToken,
        expectedBoardRev: 999,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const dry = await dryRunReconcile(h.recDeps, {
      boardId: BOARD,
      leaderId: 'leader-adv',
      fencingToken: leader.fencingToken,
      expectedBoardRev: 0,
    })

    await expect(
      applyReconcile(h.recDeps, {
        boardId: BOARD,
        leaderId: 'leader-adv',
        fencingToken: leader.fencingToken,
        dryRunHash: 'deadbeef' + dry.dryRunHash.slice(8),
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'DRY_RUN_HASH_MISMATCH' })

    // Wrong board rev on apply with known hash
    await expect(
      applyReconcile(h.recDeps, {
        boardId: BOARD,
        leaderId: 'leader-adv',
        fencingToken: leader.fencingToken,
        dryRunHash: dry.dryRunHash,
        expectedBoardRev: 42,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('adversarial: integration lock requires rootAcceptance/checkpoint/pathspecs', async () => {
    const { locks, clock } = harness()
    await expect(
      acquireIntegrationLock(locks, clock, {
        boardId: BOARD,
        repoId: 'gigit-agent',
        trackingBranch: 'main',
        runId: 'int-bad',
        agentId: 'integrator-1',
        integratorModel: 'grok-4.5',
        rootAcceptanceId: '',
        checkpointId: 'cp-1',
        pathspecs: ['src/**'],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    await expect(
      acquireIntegrationLock(locks, clock, {
        boardId: BOARD,
        repoId: 'gigit-agent',
        trackingBranch: 'main',
        runId: 'int-bad2',
        agentId: 'integrator-1',
        integratorModel: 'grok-4.5',
        rootAcceptanceId: 'ra-1',
        checkpointId: 'cp-1',
        pathspecs: [],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('adversarial: concurrent collision lock acquire — one wins', async () => {
    const { locks, clock } = harness()
    const results = await Promise.allSettled([
      acquireCollisionLocks(locks, clock, {
        boardId: BOARD,
        taskId: 'T-A',
        runId: 'run-ca',
        agentId: 'a',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:ex:concurrent/**'],
      }),
      acquireCollisionLocks(locks, clock, {
        boardId: BOARD,
        taskId: 'T-B',
        runId: 'run-cb',
        agentId: 'b',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:ex:concurrent/**'],
      }),
    ])
    const oks = results.filter((r) => r.status === 'fulfilled')
    const fails = results.filter((r) => r.status === 'rejected')
    expect(oks).toHaveLength(1)
    expect(fails).toHaveLength(1)
    if (fails[0]?.status === 'rejected') {
      expect(fails[0].reason).toMatchObject({ code: 'CLAIM_COLLISION' })
    }
  })
})

describe('C2A2 provider capacity gate — always-on, zero mutation on denial', () => {
  const baseReq = {
    boardId: BOARD,
    taskId: 'T-CAP',
    targetGate: 'FUNCTIONAL',
    agentId: 'agent-cap',
    expectedEntityRev: 0,
    expectedBoardRev: 0,
    initialState: 'STARTING' as const,
  }

  it('adversarial: missing capacity (null + no getCapacity) denies before lock with full surface freeze', async () => {
    const h = harness()
    // Strip getCapacity — fail closed
    const deps: RunRegistryDeps = {
      clock: h.clock,
      runs: h.runs,
      locks: h.locks,
      atomic: h.atomic,
      idempotency: h.idempotency,
    }
    const before = await captureMutationSurface(h)
    expect(before.runs).toEqual([])
    expect(before.collision).toEqual([])
    expect(before.boardRev).toBe(0)

    const runId = 'run-missing-cap'
    await expect(
      registerRun(deps, {
        ...baseReq,
        runId,
        model: 'grok-4.5',
        idempotencyKey: 'miss-1',
        capacity: null,
        collisionScopeLockIds: ['repo:ex:missing/**'],
      }),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({
        reason: 'CAPACITY_UNAVAILABLE',
        dispatchMode: 'BLOCKED',
        usableCapacity: 0,
      }),
    })
    await assertZeroMutation(h, runId)
    await assertSurfaceUnchanged(h, before)

    // undefined capacity + no getCapacity (property absent)
    const runId2 = 'run-missing-cap-2'
    const err = await registerRun(deps, {
      ...baseReq,
      runId: runId2,
      model: 'gpt-5.3-codex-spark',
      idempotencyKey: 'miss-2',
      collisionScopeLockIds: ['repo:ex:missing-2/**'],
    }).then(
      () => null,
      (e: unknown) => e,
    )
    expect(err).toBeInstanceOf(RunRegistryError)
    expect(err).toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({ reason: 'CAPACITY_UNAVAILABLE' }),
    })
    await assertZeroMutation(h, runId2)
    await assertSurfaceUnchanged(h, before)
  })

  it('adversarial: missing/undefined/NaN/non-finite/negative usableCapacity fail closed before idempotency/lock', async () => {
    const h = harness()
    const before = await captureMutationSurface(h)
    const idempBefore = h.idempotency // memory store has no public size; prove no run/lock/audit

    const openish = {
      dispatchMode: 'OPEN' as const,
      dispatchAllowed: true,
      nonGrokAssignmentAllowed: true,
      grokAssignmentAllowed: true,
      limitingReasons: [] as string[],
    }

    const cases: Array<{ label: string; usable: unknown }> = [
      { label: 'undefined', usable: undefined },
      { label: 'missing', usable: 'MISSING_KEY' },
      { label: 'NaN', usable: Number.NaN },
      { label: 'Infinity', usable: Number.POSITIVE_INFINITY },
      { label: 'neg-Infinity', usable: Number.NEGATIVE_INFINITY },
      { label: 'negative', usable: -1 },
      { label: 'string', usable: '100' },
      { label: 'null-usable', usable: null },
    ]

    for (const c of cases) {
      const runId = `run-bad-usable-${c.label}`
      const capacity =
        c.usable === 'MISSING_KEY'
          ? ({ ...openish } as NonNullable<RegisterRunRequest['capacity']>)
          : ({
              ...openish,
              usableCapacity: c.usable as number,
            } as NonNullable<RegisterRunRequest['capacity']>)

      await expect(
        registerRun(h.runDeps, {
          ...baseReq,
          runId,
          model: 'grok-4.5',
          idempotencyKey: `bad-usable-${c.label}`,
          capacity,
          collisionScopeLockIds: [`repo:ex:${runId}/**`],
        }),
      ).rejects.toMatchObject({
        code: 'AUTHORIZATION_REQUIRED',
        details: expect.objectContaining({
          reason: 'CAPACITY_INVALID',
          usableCapacity: 0,
        }),
      })
      await assertZeroMutation(h, runId)
      await assertSurfaceUnchanged(h, before)
      void idempBefore
    }

    // Zero usable still denied (CAPACITY path, not INVALID)
    await expect(
      registerRun(h.runDeps, {
        ...baseReq,
        runId: 'run-zero-usable',
        model: 'grok-4.5',
        idempotencyKey: 'zero-usable',
        capacity: { ...openish, usableCapacity: 0, dispatchAllowed: true },
        collisionScopeLockIds: ['repo:ex:zero-usable/**'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
    await assertZeroMutation(h, 'run-zero-usable')
    await assertSurfaceUnchanged(h, before)
  })

  it('adversarial: stale / BLOCKED capacity denies ALL providers; surface frozen (not only error code)', async () => {
    const h = harness()
    // Pre-seed an unrelated HELD lock so we can prove denials do not touch existing state.
    const seed = await acquireCollisionLocks(h.locks, h.clock, {
      boardId: BOARD,
      taskId: 'T-SEED',
      runId: 'run-seed-held',
      agentId: 'seed',
      role: 'AUTHOR',
      collisionScopeLockIds: ['repo:ex:seed-held/**'],
    })
    expect(seed.locks).toHaveLength(1)
    const before = await captureMutationSurface(h)
    expect(before.collision.some((l) => l.runId === 'run-seed-held' && l.state === 'HELD')).toBe(true)

    for (const [model, runId] of [
      ['grok-4.5', 'run-stale-grok'],
      ['gpt-5.3-codex-spark', 'run-stale-spark'],
      ['gpt-5.6-sol', 'run-stale-sol'],
      ['unknown-model', 'run-stale-unk'],
      ['not-a-grok-model', 'run-stale-subgrok'],
    ] as const) {
      await expect(
        registerRun(h.runDeps, {
          ...baseReq,
          runId,
          model,
          idempotencyKey: `stale-${runId}`,
          capacity: staleZeroCapacity(),
          collisionScopeLockIds: [`repo:ex:${runId}/**`],
        }),
      ).rejects.toMatchObject({
        code: 'AUTHORIZATION_REQUIRED',
        details: expect.objectContaining({
          dispatchMode: 'BLOCKED',
          usableCapacity: 0,
        }),
      })
      await assertZeroMutation(h, runId)
      await assertSurfaceUnchanged(h, before)
    }

    await expect(
      registerRun(h.runDeps, {
        ...baseReq,
        runId: 'run-blocked',
        model: 'grok-4.5',
        idempotencyKey: 'blocked-1',
        capacity: blockedCapacity('CPU_GTE_90'),
        collisionScopeLockIds: ['repo:ex:blocked/**'],
      }),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({
        reason: 'CPU_GTE_90',
        dispatchMode: 'BLOCKED',
        usableCapacity: 0,
      }),
    })
    await assertZeroMutation(h, 'run-blocked')
    await assertSurfaceUnchanged(h, before)

    // Seeded lock still HELD with same fencing token
    const seedAfter = h.locks.snapshot().collision.find((l) => l.runId === 'run-seed-held')
    expect(seedAfter?.state).toBe('HELD')
    expect(seedAfter?.fencingToken).toBe(seed.fencingToken)
  })

  it('adversarial: GROK_ONLY allows Grok (mutates) and denies Spark/SOL/unknown with surface freeze on denial', async () => {
    const h = harness()
    const emptyBefore = await captureMutationSurface(h)

    // Success: GROK_ONLY + Grok MUST create run row + HELD collision lock
    const allowed = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-grok-ok',
      model: 'grok-4.5',
      idempotencyKey: 'grok-ok',
      capacity: grokOnlyCapacity(),
      collisionScopeLockIds: ['repo:ex:grok-ok/**'],
    })
    expect(allowed.state).toBe('STARTING')
    expect(allowed.replayed).toBe(false)
    expect(allowed.fencingToken).toBeTruthy()
    const stored = await h.runs.get(BOARD, 'run-grok-ok')
    expect(stored).toMatchObject({
      runId: 'run-grok-ok',
      state: 'STARTING',
      model: 'grok-4.5',
      agentId: 'agent-cap',
    })
    const afterOk = await captureMutationSurface(h)
    expect(afterOk.runs).toHaveLength(1)
    expect(afterOk.runs[0]?.runId).toBe('run-grok-ok')
    expect(afterOk.collision.filter((l) => l.state === 'HELD' && l.runId === 'run-grok-ok')).toHaveLength(
      1,
    )
    // Success path must diverge from empty surface (proves we assert snapshots, not only codes)
    expect(afterOk).not.toEqual(emptyBefore)

    // Denials must not add further mutation beyond the successful Grok register
    const beforeDenies = await captureMutationSurface(h)
    for (const [model, runId] of [
      ['gpt-5.3-codex-spark', 'run-deny-spark'],
      ['gpt-5.6-sol', 'run-deny-sol'],
      ['claude-unknown', 'run-deny-unk'],
      ['sol-agent', 'run-deny-sol2'],
      ['not-a-grok-model', 'run-deny-subgrok'],
      ['spark-x', 'run-deny-spark-alias'],
    ] as const) {
      await expect(
        registerRun(h.runDeps, {
          ...baseReq,
          runId,
          model,
          idempotencyKey: `deny-${runId}`,
          capacity: grokOnlyCapacity(),
          collisionScopeLockIds: [`repo:ex:${runId}/**`],
        }),
      ).rejects.toMatchObject({
        code: 'AUTHORIZATION_REQUIRED',
        details: expect.objectContaining({ dispatchMode: 'GROK_ONLY' }),
      })
      await assertZeroMutation(h, runId)
      await assertSurfaceUnchanged(h, beforeDenies)
    }
  })

  it('adversarial: OPEN valid Grok+Spark succeed with surface mutations; OPEN nonGrok=false freezes', async () => {
    const h = harness()
    const before = await captureMutationSurface(h)

    const grok = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-open-grok',
      model: 'grok-4.5',
      idempotencyKey: 'open-g',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:open-g/**'],
    })
    expect(grok.state).toBe('STARTING')
    expect(grok.fencingToken).toBeTruthy()

    const spark = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-open-spark',
      model: 'gpt-5.3-codex-spark',
      idempotencyKey: 'open-s',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:open-s/**'],
    })
    expect(spark.state).toBe('STARTING')

    const sol = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-open-sol',
      model: 'gpt-5.6-sol',
      idempotencyKey: 'open-sol',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:open-sol/**'],
    })
    expect(sol.state).toBe('STARTING')

    const afterSuccess = await captureMutationSurface(h)
    expect(afterSuccess.runs.map((r) => r.runId).sort()).toEqual([
      'run-open-grok',
      'run-open-sol',
      'run-open-spark',
    ])
    expect(afterSuccess.collision.filter((l) => l.state === 'HELD')).toHaveLength(3)
    expect(afterSuccess).not.toEqual(before)

    // OPEN but nonGrokAssignmentAllowed false → deny spark, full surface freeze
    const openGrokOnlySlots: NonNullable<RegisterRunRequest['capacity']> = {
      ...openCapacity(),
      nonGrokAssignmentAllowed: false,
    }
    const beforeDeny = await captureMutationSurface(h)
    await expect(
      registerRun(h.runDeps, {
        ...baseReq,
        runId: 'run-open-deny-spark',
        model: 'gpt-5.3-codex-spark',
        idempotencyKey: 'open-deny-s',
        capacity: openGrokOnlySlots,
        collisionScopeLockIds: ['repo:ex:open-deny-s/**'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
    await assertZeroMutation(h, 'run-open-deny-spark')
    await assertSurfaceUnchanged(h, beforeDeny)
  })

  it('adversarial: capacity denial via getCapacity loader freezes boardRev/locks/audit/runs', async () => {
    const h = harness()
    const blockedDeps: RunRegistryDeps = {
      ...h.runDeps,
      getCapacity: async () => blockedCapacity('ACCOUNT_SYNC_STALE'),
    }
    // Pre-existing unrelated run (OPEN path) to prove freeze of mixed surface
    await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-preexisting',
      model: 'grok-4.5',
      idempotencyKey: 'pre-exist',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:pre/**'],
    })
    const before = await captureMutationSurface(h)
    expect(before.runs).toHaveLength(1)
    expect(before.boardRev).toBe(0)

    await expect(
      registerRun(blockedDeps, {
        ...baseReq,
        runId: 'run-loader-blocked',
        model: 'gpt-5.3-codex-spark',
        idempotencyKey: 'loader-block',
        // capacity property ABSENT → uses getCapacity
        collisionScopeLockIds: ['repo:ex:loader/**'],
      }),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({
        reason: 'ACCOUNT_SYNC_STALE',
        dispatchMode: 'BLOCKED',
      }),
    })
    await assertZeroMutation(h, 'run-loader-blocked')
    await assertSurfaceUnchanged(h, before)
  })

  it('capacity denial happens before board lock / claim / collision / audit (deep snapshot)', async () => {
    const h = harness()
    const before = await captureMutationSurface(h)
    await expect(
      registerRun(h.runDeps, {
        ...baseReq,
        runId: 'run-pre-lock',
        model: 'gpt-5.3-codex-spark',
        idempotencyKey: 'pre-lock',
        capacity: blockedCapacity(),
        collisionScopeLockIds: ['repo:ex:pre-lock/**'],
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })
    // Full surface: not only counts
    await assertSurfaceUnchanged(h, before)
    expect(h.locks.snapshot().collision.length).toBe(before.collision.length)
    expect(h.runs.snapshot().length).toBe(before.runs.length)
    expect(h.atomic.auditSnapshot().length).toBe(before.audit.length)
    const board = await h.atomic.getBoardState(BOARD)
    expect(board.boardRev).toBe(before.boardRev)
  })

  it('adversarial: successful register then replay/fence/collision/terminal semantics still hold under capacity', async () => {
    const h = harness()
    // Idempotent replay under OPEN capacity
    const reg = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-sem-1',
      model: 'grok-4.5',
      idempotencyKey: 'sem-reg-1',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:sem-1/**'],
      initialState: 'RUNNING',
    })
    expect(reg.fencingToken).toBeTruthy()
    const replay = await registerRun(h.runDeps, {
      ...baseReq,
      runId: 'run-sem-1',
      model: 'grok-4.5',
      idempotencyKey: 'sem-reg-1',
      capacity: openCapacity(),
      collisionScopeLockIds: ['repo:ex:sem-1/**'],
      initialState: 'RUNNING',
    })
    expect(replay.replayed).toBe(true)
    expect(replay.fencingToken).toBe(reg.fencingToken)

    // Fence: wrong token on heartbeat
    await expect(
      heartbeatRun(h.runDeps, {
        boardId: BOARD,
        runId: 'run-sem-1',
        agentId: 'agent-cap',
        fencingToken: 'wrong-fence',
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })

    // Collision: second run same scope rejected
    await expect(
      registerRun(h.runDeps, {
        ...baseReq,
        runId: 'run-sem-collide',
        model: 'gpt-5.3-codex-spark',
        agentId: 'agent-other',
        idempotencyKey: 'sem-collide',
        capacity: openCapacity(),
        collisionScopeLockIds: ['repo:ex:sem-1/**'],
      }),
    ).rejects.toMatchObject({ code: 'CLAIM_COLLISION' })
    await assertZeroMutation(h, 'run-sem-collide')

    // Terminal preserves history; second terminate is no-op
    const term = await terminateRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-sem-1',
      agentId: 'agent-cap',
      fencingToken: reg.fencingToken!,
      toState: 'SUCCEEDED',
      reason: 'capacity-sem-done',
    })
    expect(term.state).toBe('SUCCEEDED')
    expect(term.history.length).toBeGreaterThanOrEqual(2)
    const term2 = await terminateRun(h.runDeps, {
      boardId: BOARD,
      runId: 'run-sem-1',
      agentId: 'agent-cap',
      fencingToken: reg.fencingToken!,
      toState: 'FAILED',
      reason: 'noop',
    })
    expect(term2.state).toBe('SUCCEEDED')
    const final = await h.runs.get(BOARD, 'run-sem-1')
    expect(final?.state).toBe('SUCCEEDED')
  })
})
