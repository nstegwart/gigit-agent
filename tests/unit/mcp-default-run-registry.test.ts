/**
 * Regression: default (non-injected) MCP run deps must use a process-wide
 * shared run registry store so register_run then heartbeat_run see the same
 * record. Per-call createMemoryRunRegistryStore() caused RUN_NOT_REGISTERED.
 *
 * Capacity authorization: production uses deps.getCapacity only. Disposable
 * unit paths that hit defaultRunDeps (missing account-sync → ACCOUNT_SYNC_STALE)
 * must use Symbol-branded withTestCapacityInjection — never request-body inject
 * (R3: JSON/MCP cannot forge the brand).
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
  hashRegisterBody,
  heartbeatRun,
  registerRun,
  RunRegistryError,
  withTestCapacityInjection,
  type RegisterRunCapacity,
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

/** OPEN capacity with complete M2 family remainings (fail-closed without these). */
function openCapacity(): NonNullable<RegisterRunCapacity> {
  return {
    dispatchMode: 'OPEN',
    dispatchAllowed: true,
    usableCapacity: 100,
    nonGrokAssignmentAllowed: true,
    grokAssignmentAllowed: true,
    limitingReasons: [],
    sparkUsableCapacity: 10,
    solUsableCapacity: 10,
    otherUsableCapacity: 10,
    healthyGrokUsableCapacity: 70,
    failSafeActions: [],
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

    // Symbol-branded inject: defaultRunDeps getCapacity is forceZero STALE without account-sync.
    const reg = await registerRun(withTestCapacityInjection(depsRegister, openCapacity()), {
      boardId: BOARD_A,
      runId: 'run-shared-1',
      taskId: 'task-1',
      targetGate: 'G1',
      agentId: 'agent-default',
      model: 'grok-4',
      canonicalHash: 'canon-default',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-shared-1',
      initialState: 'STARTING',
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
      idempotencyKey: 'hb-shared-1',
      canonicalHash: 'canon-default',
    })
    expect(hb.runId).toBe('run-shared-1')
    expect(hb.replayed).toBe(false)
    expect(hb.heartbeatSequence).toBe(1)
  })

  it('resetMcpControlPlaneDeps clears default deps so a new store is used', async () => {
    const deps1 = defaultRunDeps(BOARD_A, 0)
    const reg = await registerRun(withTestCapacityInjection(deps1, openCapacity()), {
      boardId: BOARD_A,
      runId: 'run-pre-reset',
      taskId: 'task-pre',
      targetGate: 'G1',
      agentId: 'agent-default',
      model: 'grok-4',
      canonicalHash: 'canon-default',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-pre-reset',
      initialState: 'STARTING',
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
        idempotencyKey: 'hb-pre-reset',
        canonicalHash: 'canon-default',
      }),
    ).rejects.toMatchObject({ code: 'RUN_NOT_REGISTERED' } satisfies Partial<RunRegistryError>)
  })

  it('board isolation: runs on board A are not visible as board B records', async () => {
    const deps = defaultRunDeps(BOARD_A, 0)
    // Same process-wide deps object; atomic getBoardState defaults unknown boards to rev 0.
    const depsB = defaultRunDeps(BOARD_B, 0)
    expect(depsB).toBe(deps)
    expect(depsB.runs).toBe(deps.runs)

    const regA = await registerRun(withTestCapacityInjection(deps, openCapacity()), {
      boardId: BOARD_A,
      runId: 'run-iso-a',
      taskId: 'task-a',
      targetGate: 'G1',
      agentId: 'agent-a',
      model: 'grok-4',
      canonicalHash: 'canon-default',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-iso-a',
      initialState: 'STARTING',
    })

    const listedA = await deps.runs.list(BOARD_A)
    const listedB = await deps.runs.list(BOARD_B)
    expect(listedA.some((r) => r.runId === 'run-iso-a')).toBe(true)
    expect(listedB.some((r) => r.runId === 'run-iso-a')).toBe(false)

    // Same runId on board B is a separate key in the shared store.
    const regB = await registerRun(withTestCapacityInjection(depsB, openCapacity()), {
      boardId: BOARD_B,
      runId: 'run-iso-a',
      taskId: 'task-b',
      targetGate: 'G1',
      agentId: 'agent-b',
      model: 'grok-4',
      canonicalHash: 'canon-default',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-iso-b',
      initialState: 'STARTING',
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

describe('register_run idempotency hash matrix (material fields)', () => {
  function baseRegister(over: Partial<RegisterRunRequest> = {}): RegisterRunRequest {
    return {
      boardId: BOARD_A,
      runId: 'run-matrix-1',
      planId: 'plan-matrix',
      planItemRank: 1,
      taskId: 'task-matrix',
      targetGate: 'G1',
      role: 'PRODUCT',
      agentId: 'agent-matrix',
      model: 'grok-4',
      effort: 'medium',
      maskedAccountRef: 'mask-1',
      canonicalHash: 'canon-matrix',
      currentPinHash: 'canon-matrix',
      collisionScopeLockIds: ['repo:ex:t/**'],
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-matrix-key',
      initialState: 'STARTING',
      actorRole: 'AGENT',
      ...over,
    }
  }

  function isolatedDeps(): RunRegistryDeps {
    const clock = createFakeClock(Date.parse('2026-07-13T12:00:00.000Z'))
    return {
      clock,
      runs: createMemoryRunRegistryStore(),
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
      // Explicit getCapacity with complete family remainings (not request-body inject).
      getCapacity: async () => openCapacity(),
    }
  }

  it('exact same key+body → replay; no double registration bump of entity', async () => {
    const deps = isolatedDeps()
    const req = baseRegister()
    const first = await registerRun(deps, req)
    expect(first.replayed).toBe(false)
    const entity1 = first.entityRev
    const board1 = first.boardRev

    const replay = await registerRun(deps, req)
    expect(replay.replayed).toBe(true)
    expect(replay.entityRev).toBe(entity1)
    expect(replay.boardRev).toBe(board1)
    expect(replay.runId).toBe(first.runId)
    expect(replay.fencingToken).toBe(first.fencingToken)
  })

  it('each previously-omitted material field alone → IDEMPOTENCY_CONFLICT', async () => {
    const deps = isolatedDeps()
    const KEY = 'reg-matrix-key'
    const base = baseRegister({ idempotencyKey: KEY })
    const first = await registerRun(deps, base)
    expect(first.replayed).toBe(false)
    const boardAfter = (await deps.atomic.getBoardState(BOARD_A)).boardRev
    const baseHash = hashRegisterBody(base)

    // R3: capacity / allowTestCapacityInjection are intentionally excluded from
    // canonicalRegisterRunRequestBody — not material for idempotency.
    const fieldCases: Array<{ field: string; patch: Partial<RegisterRunRequest> }> = [
      { field: 'initialState', patch: { initialState: 'QUEUED' } },
      { field: 'role', patch: { role: 'INTEGRATOR' } },
      // revisions (expectedBoardRev) — expectedEntityRev is create-locked to 0 before idempotency
      { field: 'expectedBoardRev', patch: { expectedBoardRev: 99 } },
      // also cover remaining material envelope fields for completeness
      { field: 'canonicalHash', patch: { canonicalHash: 'canon-OTHER', currentPinHash: 'canon-OTHER' } },
      { field: 'taskId', patch: { taskId: 'task-OTHER' } },
      { field: 'targetGate', patch: { targetGate: 'G2' } },
      { field: 'model', patch: { model: 'grok-other' } },
      { field: 'effort', patch: { effort: 'high' } },
      { field: 'planId', patch: { planId: 'plan-OTHER' } },
      { field: 'planItemRank', patch: { planItemRank: 2 } },
      { field: 'actorRole', patch: { actorRole: 'ROOT_ORCHESTRATOR' } },
    ]

    for (const c of fieldCases) {
      const mutated = baseRegister({ idempotencyKey: KEY, ...c.patch })
      // Different runId would hit unique-run binding; keep same runId so body hash is the axis.
      expect(mutated.runId).toBe(base.runId)
      const mutatedHash = hashRegisterBody(mutated)
      expect(mutatedHash, `hash must differ for field ${c.field}`).not.toBe(baseHash)

      await expect(registerRun(deps, mutated), `field ${c.field}`).rejects.toMatchObject({
        code: 'IDEMPOTENCY_CONFLICT',
      })
      expect(
        (await deps.atomic.getBoardState(BOARD_A)).boardRev,
        `no board bump after ${c.field} conflict`,
      ).toBe(boardAfter)
    }
  })

  it('hashRegisterBody covers full material body (not only runId/taskId/planId)', () => {
    const a = hashRegisterBody(baseRegister({ initialState: 'STARTING', role: 'PRODUCT' }))
    const b = hashRegisterBody(baseRegister({ initialState: 'QUEUED', role: 'PRODUCT' }))
    const c = hashRegisterBody(baseRegister({ initialState: 'STARTING', role: 'OTHER' }))
    const d = hashRegisterBody(baseRegister({ expectedBoardRev: 1 }))
    expect(a).not.toBe(b)
    expect(a).not.toBe(c)
    expect(a).not.toBe(d)
    // idempotencyKey alone must not be part of request hash
    const e = hashRegisterBody(baseRegister({ idempotencyKey: 'other-key-only' }))
    expect(e).toBe(a)
  })
})
