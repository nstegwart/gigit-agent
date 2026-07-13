/**
 * Regression: default (non-injected) MCP run deps must use a process-wide
 * shared run registry store so register_run then heartbeat_run see the same
 * record. Per-call createMemoryRunRegistryStore() caused RUN_NOT_REGISTERED.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  createMemoryControlPlaneRuntimeContext,
  defaultRunDeps,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  setMcpRunRegistryDeps,
  setTestControlPlaneRuntimeContext,
} from '#/server/board-mcp'
import {
  createMemoryRunRegistryStore,
  heartbeatRun,
  registerRun,
  RunRegistryError,
  type RegisterRunRequest,
  type RunRegistryDeps,
} from '#/server/run-registry'
import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'

const BOARD_A = 'board-default-a'
const BOARD_B = 'board-default-b'

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

beforeEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  // Memory durable context is explicit test injection only (production uses MySQL).
  setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
})

afterEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
})

describe('MCP default run registry (no injection)', () => {
  it('register then heartbeat on default path shares the same record', async () => {
    // Two independent defaultRunDeps calls — must not mint a fresh runs store each time.
    const depsRegister = defaultRunDeps(BOARD_A, 0)
    const depsHeartbeat = defaultRunDeps(BOARD_A, 0)
    expect(depsRegister).toBe(depsHeartbeat)
    expect(depsRegister.runs).toBe(depsHeartbeat.runs)

    const reg = await registerRun(depsRegister, {
      boardId: BOARD_A,
      runId: 'run-shared-1',
      taskId: 'task-1',
      targetGate: 'G1',
      agentId: 'agent-default',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-shared-1',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    expect(reg.replayed).toBe(false)
    expect(reg.fencingToken).toBeTruthy()
    expect(reg.state).not.toBe('QUEUED')

    const hb = await heartbeatRun(depsHeartbeat, {
      boardId: BOARD_A,
      runId: 'run-shared-1',
      agentId: 'agent-default',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: reg.entityRev,
      expectedBoardRev: reg.boardRev,
    })
    expect(hb.runId).toBe('run-shared-1')
    expect(hb.replayed).toBe(false)
    expect(hb.heartbeatSequence).toBe(1)
  })

  it('resetMcpControlPlaneDeps clears default deps so a new store is used', async () => {
    const deps1 = defaultRunDeps(BOARD_A, 0)
    const reg = await registerRun(deps1, {
      boardId: BOARD_A,
      runId: 'run-pre-reset',
      taskId: 'task-pre',
      targetGate: 'G1',
      agentId: 'agent-default',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-pre-reset',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    expect(reg.fencingToken).toBeTruthy()

    resetMcpControlPlaneDeps()
    // Durable runs store lives on the runtime context; reset MCP deps + install a fresh memory context.
    resetControlPlaneRuntimeContextForTests()
    setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())

    const deps2 = defaultRunDeps(BOARD_A, 0)
    expect(deps2).not.toBe(deps1)
    expect(deps2.runs).not.toBe(deps1.runs)

    // Record from pre-reset store is gone on the new default store.
    await expect(
      heartbeatRun(deps2, {
        boardId: BOARD_A,
        runId: 'run-pre-reset',
        agentId: 'agent-default',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 1,
        expectedEntityRev: reg.entityRev,
        expectedBoardRev: reg.boardRev,
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' } satisfies Partial<RunRegistryError>)
  })

  it('board isolation: runs on board A are not visible as board B records', async () => {
    const deps = defaultRunDeps(BOARD_A, 0)
    // Same process-wide deps object; atomic getBoardState defaults unknown boards to rev 0.
    const depsB = defaultRunDeps(BOARD_B, 0)
    expect(depsB).toBe(deps)
    expect(depsB.runs).toBe(deps.runs)

    const regA = await registerRun(deps, {
      boardId: BOARD_A,
      runId: 'run-iso-a',
      taskId: 'task-a',
      targetGate: 'G1',
      agentId: 'agent-a',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-iso-a',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })

    const listedA = await deps.runs.list(BOARD_A)
    const listedB = await deps.runs.list(BOARD_B)
    expect(listedA.some((r) => r.runId === 'run-iso-a')).toBe(true)
    expect(listedB.some((r) => r.runId === 'run-iso-a')).toBe(false)

    // Same runId on board B is a separate key in the shared store.
    const regB = await registerRun(depsB, {
      boardId: BOARD_B,
      runId: 'run-iso-a',
      taskId: 'task-b',
      targetGate: 'G1',
      agentId: 'agent-b',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-iso-b',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    expect(regB.fencingToken).not.toBe(regA.fencingToken)

    const listedB2 = await deps.runs.list(BOARD_B)
    expect(listedB2.some((r) => r.runId === 'run-iso-a' && r.agentId === 'agent-b')).toBe(true)
  })

  it('setMcpRunRegistryDeps injection still takes precedence over default cache', async () => {
    // Prime default path
    const defaultDeps = defaultRunDeps(BOARD_A, 0)
    const injectedRuns = createMemoryRunRegistryStore()
    const clock = createFakeClock(Date.parse('2026-07-13T12:00:00.000Z'))
    const injected: RunRegistryDeps = {
      clock,
      runs: injectedRuns,
      locks: createMemoryLockStore(),
      atomic: createMemoryControlPlaneAtomicStore([
        {
          boardId: BOARD_A,
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ]),
      idempotency: createMemoryIdempotencyStorage(),
      getCapacity: async () => openCapacity(),
    }
    setMcpRunRegistryDeps(injected)

    const resolved = defaultRunDeps(BOARD_A, 0)
    expect(resolved).toBe(injected)
    expect(resolved).not.toBe(defaultDeps)
    expect(resolved.runs).toBe(injectedRuns)
  })
})
