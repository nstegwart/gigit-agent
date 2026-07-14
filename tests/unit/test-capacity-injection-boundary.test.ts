/**
 * R3 boundary: allowTestCapacityInjection / capacity must not be forwardable from
 * runtime API/MCP/serialized untrusted request. Injectable only via Symbol-branded
 * RunRegistryDeps.testCapacityInjection from createTestCapacityInjection.
 */
import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'
import {
  TEST_CAPACITY_INJECTION,
  canonicalRegisterRunRequestBody,
  createMemoryRunRegistryStore,
  createTestCapacityInjection,
  isTestCapacityInjectionCapability,
  registerRun,
  resolveCapacitySource,
  withTestCapacityInjection,
  type RegisterRunCapacity,
  type RegisterRunRequest,
  type RunRegistryDeps,
} from '#/server/run-registry'
import {
  createMemoryControlPlaneRuntimeContext,
  defaultRunDeps,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  setTestControlPlaneRuntimeContext,
} from '#/server/board-mcp'

const BOARD = 'r3-cap-boundary'

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

function blockedCapacity(): NonNullable<RegisterRunCapacity> {
  return {
    dispatchMode: 'BLOCKED',
    dispatchAllowed: false,
    usableCapacity: 0,
    nonGrokAssignmentAllowed: false,
    grokAssignmentAllowed: false,
    limitingReasons: ['CPU_GTE_90'],
    sparkUsableCapacity: 0,
    solUsableCapacity: 0,
    otherUsableCapacity: 0,
    healthyGrokUsableCapacity: 0,
    failSafeActions: [],
  }
}

function baseDeps(getCapacity?: RunRegistryDeps['getCapacity']): RunRegistryDeps {
  return {
    clock: createFakeClock(Date.parse('2026-07-14T12:00:00.000Z')),
    runs: createMemoryRunRegistryStore(),
    locks: createMemoryLockStore(),
    atomic: createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ]),
    idempotency: createMemoryIdempotencyStorage(),
    getCapacity,
  }
}

function baseReq(over: Partial<RegisterRunRequest> = {}): RegisterRunRequest {
  return {
    boardId: BOARD,
    runId: 'run-r3-1',
    taskId: 'task-r3',
    targetGate: 'G1',
    agentId: 'agent-r3',
    model: 'grok-4.5',
    canonicalHash: 'canon-r3',
    expectedEntityRev: 0,
    expectedBoardRev: 0,
    idempotencyKey: 'idem-r3-1',
    initialState: 'STARTING',
    ...over,
  }
}

describe('R3 test capacity injection boundary', () => {
  it('compile-time: RegisterRunRequest has no capacity / allowTestCapacityInjection keys', () => {
    type ReqKeys = keyof RegisterRunRequest
    type Forbidden = 'capacity' | 'allowTestCapacityInjection'
    // If either key is re-added to RegisterRunRequest, this becomes `Forbidden` (not never) and fails.
    type AssertNever<T extends never> = T
    type _NoCapacityOnRequest = AssertNever<Extract<ReqKeys, Forbidden>>
    const _typeProbe: _NoCapacityOnRequest = undefined as never
    void _typeProbe

    const req = baseReq()
    expect('capacity' in req).toBe(false)
    expect('allowTestCapacityInjection' in req).toBe(false)
  })

  it('canonicalRegisterRunRequestBody never includes capacity or inject flag', () => {
    const body = canonicalRegisterRunRequestBody(baseReq())
    expect(body).not.toHaveProperty('capacity')
    expect(body).not.toHaveProperty('allowTestCapacityInjection')
  })

  it('runtime: JSON-deserialized look-alike inject object is NOT a valid capability', () => {
    // Simulate MCP/HTTP JSON round-trip: Symbol keys are dropped.
    const real = createTestCapacityInjection(blockedCapacity())
    const serialized = JSON.parse(JSON.stringify(real)) as Record<string, unknown>
    expect(serialized).toEqual({ capacity: blockedCapacity() })
    expect(serialized[TEST_CAPACITY_INJECTION as unknown as string]).toBeUndefined()
    expect(isTestCapacityInjectionCapability(serialized)).toBe(false)
    expect(isTestCapacityInjectionCapability(real)).toBe(true)

    // String-brand forgery also rejected
    expect(
      isTestCapacityInjectionCapability({
        __brand: 'TestCapacityInjection',
        capacity: blockedCapacity(),
      }),
    ).toBe(false)
  })

  it('runtime: forged request fields cannot override getCapacity', async () => {
    const deps = baseDeps(async () => openCapacity())
    const forged = {
      ...baseReq({ runId: 'run-forged-body', idempotencyKey: 'forged-body' }),
      capacity: blockedCapacity(),
      allowTestCapacityInjection: true,
    } as RegisterRunRequest & {
      capacity?: RegisterRunCapacity
      allowTestCapacityInjection?: boolean
    }

    const source = await resolveCapacitySource(deps, forged)
    expect(source).toEqual(openCapacity())

    const reg = await registerRun(deps, forged)
    expect(reg.state).toBe('STARTING')
    expect(reg.replayed).toBe(false)
  })

  it('runtime: forged deps.testCapacityInjection without Symbol brand is ignored', async () => {
    const deps: RunRegistryDeps = {
      ...baseDeps(async () => openCapacity()),
      // Attacker-shaped plain object (e.g. from Object.assign of request JSON)
      testCapacityInjection: {
        capacity: blockedCapacity(),
      } as RunRegistryDeps['testCapacityInjection'],
    }
    const source = await resolveCapacitySource(deps, baseReq())
    expect(source).toEqual(openCapacity())
  })

  it('runtime: only createTestCapacityInjection capability overrides getCapacity', async () => {
    const deps = withTestCapacityInjection(
      baseDeps(async () => openCapacity()),
      blockedCapacity(),
    )
    const source = await resolveCapacitySource(deps, baseReq())
    expect(source).toEqual(blockedCapacity())

    await expect(
      registerRun(deps, baseReq({ runId: 'run-inject-block', idempotencyKey: 'inject-block' })),
    ).rejects.toMatchObject({
      code: 'AUTHORIZATION_REQUIRED',
      details: expect.objectContaining({ reason: 'CPU_GTE_90' }),
    })
  })

  it('MCP defaultRunDeps never carries testCapacityInjection', () => {
    resetControlPlaneRuntimeContextForTests()
    resetMcpControlPlaneDeps()
    setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
    try {
      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.testCapacityInjection).toBeUndefined()
      expect(isTestCapacityInjectionCapability(deps.testCapacityInjection)).toBe(false)
      expect(typeof deps.getCapacity).toBe('function')
    } finally {
      resetMcpControlPlaneDeps()
      resetControlPlaneRuntimeContextForTests()
    }
  })
})
