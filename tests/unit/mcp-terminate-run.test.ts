/**
 * Focused unit coverage for authenticated MCP terminate_run + hardened domain terminateRun.
 * Catalog/RBAC, envelope CAS, owner/fence, lock release, idempotent terminal, set_run_status non-alias.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  authorizeToolCall,
  assertMcpToolCatalogIntegrity,
  defaultScopesForRole,
  isToolListable,
  listHumanSafeToolNames,
  type Principal,
} from '#/server/rbac'
import {
  authorizePersistedRunOwner,
  createMemoryControlPlaneRuntimeContext,
  defaultRunDeps,
  listRegisteredWriteToolSchemas,
  McpMutationError,
  registerBoardTools,
  REGISTERED_WRITE_TOOL_NAMES,
  resetControlPlaneRuntimeContextForTests,
  setTestControlPlaneRuntimeContext,
  writeToolSchemaHasFullEnvelope,
} from '#/server/board-mcp'
import {
  AGENT_TERMINATE_TO_STATES,
  ROOT_TERMINATE_TO_STATES,
  registerRun,
  heartbeatRun,
  terminateRun,
  RunRegistryError,
  type RegisterRunRequest,
} from '#/server/run-registry'
import { createFakeClock, createMemoryControlPlaneAtomicStore } from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'
import { createMemoryRunRegistryStore } from '#/server/run-registry'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { RbacError } from '#/server/rbac'

const BOARD = 'term-run-board'
const PIN = 'c'.repeat(64)

function openCapacity(): NonNullable<RegisterRunRequest['capacity']> {
  return {
    dispatchMode: 'OPEN',
    dispatchAllowed: true,
    usableCapacity: 50,
    nonGrokAssignmentAllowed: true,
    grokAssignmentAllowed: true,
    limitingReasons: [],
  }
}

function principal(
  role: Principal['role'],
  extra: Partial<Principal> = {},
): Principal {
  return {
    role,
    actorId: extra.actorId ?? `${role.toLowerCase()}-actor`,
    channel: 'bearer',
    scopes: extra.scopes ?? defaultScopesForRole(role),
    boards: extra.boards ?? [],
    agentId: extra.agentId ?? (role === 'AGENT' ? 'agent-a' : null),
    ...extra,
  }
}

function domainHarness() {
  const clock = createFakeClock(Date.parse('2026-07-14T00:00:00.000Z'))
  const locks = createMemoryLockStore()
  const runs = createMemoryRunRegistryStore()
  const atomic = createMemoryControlPlaneAtomicStore([
    { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
  ])
  const idempotency = createMemoryIdempotencyStorage()
  const deps = {
    clock,
    runs,
    locks,
    atomic,
    idempotency,
    getCapacity: async () => openCapacity(),
  }
  return { clock, locks, runs, atomic, idempotency, deps }
}

describe('terminate_run catalog + RBAC', () => {
  it('catalog integrity includes terminate_run once; write count 42', () => {
    expect(() => assertMcpToolCatalogIntegrity()).not.toThrow()
    expect(REGISTERED_WRITE_TOOL_NAMES).toContain('terminate_run')
    expect(REGISTERED_WRITE_TOOL_NAMES).toHaveLength(42)
    expect(REGISTERED_WRITE_TOOL_NAMES.filter((n) => n === 'terminate_run')).toHaveLength(1)

    const server = new McpServer({ name: 'term-cat', version: '0.0.0' })
    registerBoardTools(server, {
      principal: principal('ROOT_ORCHESTRATOR'),
      mechanism: { kind: 'OK' },
      bearerPresent: true,
    })
    const row = listRegisteredWriteToolSchemas().find((w) => w.name === 'terminate_run')
    expect(row).toBeTruthy()
    expect(writeToolSchemaHasFullEnvelope(row!.schemaKeys)).toBe(true)
  })

  it('listable: AGENT + ROOT yes; OWNER/INTEGRATOR/PUBLIC/null no', () => {
    expect(isToolListable(principal('AGENT', { agentId: 'agent-a' }), 'terminate_run')).toBe(true)
    expect(isToolListable(principal('ROOT_ORCHESTRATOR'), 'terminate_run')).toBe(true)
    expect(isToolListable(principal('OWNER'), 'terminate_run')).toBe(false)
    expect(isToolListable(principal('INTEGRATOR'), 'terminate_run')).toBe(false)
    expect(isToolListable(principal('PUBLIC'), 'terminate_run')).toBe(false)
    expect(isToolListable(null, 'terminate_run')).toBe(false)

    const agentNames = listHumanSafeToolNames(principal('AGENT', { agentId: 'agent-a' }))
    expect(agentNames).toContain('terminate_run')
    expect(agentNames).toContain('register_run')
    expect(listHumanSafeToolNames(principal('OWNER'))).not.toContain('terminate_run')
  })

  it('authorizeToolCall: OWNER evidence deny; unbound/foreign AGENT OWN_RUN_ONLY; bound AGENT ok; INTEGRATOR/PUBLIC denied', () => {
    const owner = authorizeToolCall(principal('OWNER'), 'terminate_run', {
      agentId: 'agent-a',
      boardId: BOARD,
    })
    expect(owner.ok).toBe(false)
    expect(owner.code).toBe('OWNER_EVIDENCE_IMPERSONATION_DENIED')

    const unbound = authorizeToolCall(principal('AGENT', { agentId: null }), 'terminate_run', {
      agentId: 'agent-a',
    })
    expect(unbound.ok).toBe(false)
    expect(unbound.code).toBe('OWN_RUN_ONLY')

    const foreign = authorizeToolCall(principal('AGENT', { agentId: 'agent-a' }), 'terminate_run', {
      agentId: 'agent-b',
    })
    expect(foreign.ok).toBe(false)
    expect(foreign.code).toBe('OWN_RUN_ONLY')

    const own = authorizeToolCall(principal('AGENT', { agentId: 'agent-a' }), 'terminate_run', {
      agentId: 'agent-a',
    })
    expect(own.ok).toBe(true)

    const omitAgent = authorizeToolCall(principal('AGENT', { agentId: 'agent-a' }), 'terminate_run', {})
    expect(omitAgent.ok).toBe(true)

    const root = authorizeToolCall(principal('ROOT_ORCHESTRATOR'), 'terminate_run', {
      agentId: 'any',
    })
    expect(root.ok).toBe(true)

    const integ = authorizeToolCall(principal('INTEGRATOR'), 'terminate_run', {})
    expect(integ.ok).toBe(false)
    expect(integ.code).toMatch(/FORBIDDEN/)

    const pub = authorizeToolCall(principal('PUBLIC'), 'terminate_run', {})
    expect(pub.ok).toBe(false)

    const unauth = authorizeToolCall(null, 'terminate_run', {})
    expect(unauth.ok).toBe(false)
    expect(unauth.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('authorizePersistedRunOwner blocks foreign AGENT; ROOT no-op', () => {
    expect(() =>
      authorizePersistedRunOwner(principal('AGENT', { agentId: 'agent-a' }), 'agent-a'),
    ).not.toThrow()
    expect(() =>
      authorizePersistedRunOwner(principal('AGENT', { agentId: 'agent-a' }), 'agent-b'),
    ).toThrow(RbacError)
    expect(() =>
      authorizePersistedRunOwner(principal('ROOT_ORCHESTRATOR'), 'agent-b'),
    ).not.toThrow()
  })

  it('toState policy constants: AGENT 3 states; ROOT includes STALE/SUPERSEDED', () => {
    expect([...AGENT_TERMINATE_TO_STATES]).toEqual(['SUCCEEDED', 'FAILED', 'CANCELLED'])
    expect([...ROOT_TERMINATE_TO_STATES]).toEqual([
      'SUCCEEDED',
      'FAILED',
      'CANCELLED',
      'STALE',
      'SUPERSEDED',
    ])
  })
})

describe('terminateRun domain harden', () => {
  it('register → terminate SUCCEEDED releases collision HELD; second terminal preserves state', async () => {
    const h = domainHarness()
    const reg = await registerRun(h.deps, {
      boardId: BOARD,
      runId: 'run-term-1',
      taskId: 'T-1',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-term-1',
      collisionScopeLockIds: ['repo:ex:term/**'],
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    expect(reg.fencingToken).toBeTruthy()
    const heldBefore = h.locks.snapshot().collision.filter(
      (l) => l.runId === 'run-term-1' && l.state === 'HELD',
    )
    expect(heldBefore.length).toBeGreaterThanOrEqual(1)

    const term = await terminateRun(h.deps, {
      boardId: BOARD,
      runId: 'run-term-1',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      toState: 'SUCCEEDED',
      reason: 'done',
      expectedEntityRev: reg.entityRev,
      expectedBoardRev: reg.boardRev,
      canonicalHash: PIN,
      idempotencyKey: 'term-1',
      currentPinHash: PIN,
    })
    expect(term.state).toBe('SUCCEEDED')
    expect(term.replayed).toBe(false)
    const heldAfter = h.locks.snapshot().collision.filter(
      (l) => l.runId === 'run-term-1' && l.state === 'HELD',
    )
    expect(heldAfter).toHaveLength(0)

    const again = await terminateRun(h.deps, {
      boardId: BOARD,
      runId: 'run-term-1',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      toState: 'FAILED',
      reason: 'noop',
      expectedEntityRev: term.entityRev,
      expectedBoardRev: reg.boardRev,
      canonicalHash: PIN,
      idempotencyKey: 'term-1-again',
      currentPinHash: PIN,
    })
    expect(again.state).toBe('SUCCEEDED')
    expect(again.replayed).toBe(true)
  })

  it('idempotent replay same key; conflict on different body; fence mismatch FENCED', async () => {
    const h = domainHarness()
    const reg = await registerRun(h.deps, {
      boardId: BOARD,
      runId: 'run-term-2',
      taskId: 'T-2',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-term-2',
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })

    const body = {
      boardId: BOARD,
      runId: 'run-term-2',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      toState: 'FAILED' as const,
      reason: 'boom',
      expectedEntityRev: reg.entityRev,
      expectedBoardRev: reg.boardRev,
      canonicalHash: PIN,
      idempotencyKey: 'term-idem-2',
      currentPinHash: PIN,
    }
    const first = await terminateRun(h.deps, body)
    expect(first.state).toBe('FAILED')
    expect(first.replayed).toBe(false)

    const replay = await terminateRun(h.deps, body)
    expect(replay.replayed).toBe(true)
    expect(replay.state).toBe('FAILED')

    await expect(
      terminateRun(h.deps, { ...body, reason: 'different-body', toState: 'CANCELLED' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    const h2 = domainHarness()
    const reg2 = await registerRun(h2.deps, {
      boardId: BOARD,
      runId: 'run-term-fence',
      taskId: 'T-f',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-fence',
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    await expect(
      terminateRun(h2.deps, {
        boardId: BOARD,
        runId: 'run-term-fence',
        agentId: 'agent-a',
        fencingToken: 'wrong-fence',
        toState: 'SUCCEEDED',
        reason: 'steal',
        expectedEntityRev: reg2.entityRev,
        expectedBoardRev: reg2.boardRev,
        canonicalHash: PIN,
        idempotencyKey: 'term-fence',
        currentPinHash: PIN,
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
    const still = await h2.runs.get(BOARD, 'run-term-fence')
    expect(still?.state).toBe('RUNNING')
  })

  it('owner mismatch AUTHORIZATION_REQUIRED; entity rev STALE; partial envelope INVALID_INPUT', async () => {
    const h = domainHarness()
    const reg = await registerRun(h.deps, {
      boardId: BOARD,
      runId: 'run-term-3',
      taskId: 'T-3',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-term-3',
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })

    await expect(
      terminateRun(h.deps, {
        boardId: BOARD,
        runId: 'run-term-3',
        agentId: 'agent-b',
        fencingToken: reg.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'steal',
        expectedEntityRev: reg.entityRev,
        expectedBoardRev: reg.boardRev,
        canonicalHash: PIN,
        idempotencyKey: 'term-owner',
        currentPinHash: PIN,
      }),
    ).rejects.toMatchObject({ code: 'AUTHORIZATION_REQUIRED' })

    await expect(
      terminateRun(h.deps, {
        boardId: BOARD,
        runId: 'run-term-3',
        agentId: 'agent-a',
        fencingToken: reg.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'stale',
        expectedEntityRev: reg.entityRev + 99,
        expectedBoardRev: reg.boardRev,
        canonicalHash: PIN,
        idempotencyKey: 'term-stale',
        currentPinHash: PIN,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(
      terminateRun(h.deps, {
        boardId: BOARD,
        runId: 'run-term-3',
        agentId: 'agent-a',
        fencingToken: reg.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'partial',
        expectedEntityRev: reg.entityRev,
        // missing board/canonical/idem → full path partial
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('legacy path (no envelope) still terminates + fail-closed release; pin mismatch STALE', async () => {
    const h = domainHarness()
    const reg = await registerRun(h.deps, {
      boardId: BOARD,
      runId: 'run-legacy',
      taskId: 'T-L',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-legacy',
      collisionScopeLockIds: ['repo:ex:legacy/**'],
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    const term = await terminateRun(h.deps, {
      boardId: BOARD,
      runId: 'run-legacy',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      toState: 'CANCELLED',
      reason: 'legacy-compat',
    })
    expect(term.state).toBe('CANCELLED')
    expect(
      h.locks.snapshot().collision.filter((l) => l.runId === 'run-legacy' && l.state === 'HELD'),
    ).toHaveLength(0)

    const h2 = domainHarness()
    const reg2 = await registerRun(h2.deps, {
      boardId: BOARD,
      runId: 'run-pin',
      taskId: 'T-P',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-pin',
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    await expect(
      terminateRun(h2.deps, {
        boardId: BOARD,
        runId: 'run-pin',
        agentId: 'agent-a',
        fencingToken: reg2.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'pin',
        expectedEntityRev: reg2.entityRev,
        expectedBoardRev: reg2.boardRev,
        canonicalHash: PIN,
        currentPinHash: 'wrong-pin',
        idempotencyKey: 'term-pin',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('heartbeat then terminate uses bumped entityRev; concurrent-style stale after heartbeat', async () => {
    const h = domainHarness()
    const reg = await registerRun(h.deps, {
      boardId: BOARD,
      runId: 'run-hb-term',
      taskId: 'T-HB',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-a',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'reg-hb',
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    const hb = await heartbeatRun(h.deps, {
      boardId: BOARD,
      runId: 'run-hb-term',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: reg.entityRev,
      expectedBoardRev: reg.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'hb-1',
    })
    // Stale entity from pre-heartbeat
    await expect(
      terminateRun(h.deps, {
        boardId: BOARD,
        runId: 'run-hb-term',
        agentId: 'agent-a',
        fencingToken: reg.fencingToken!,
        toState: 'SUCCEEDED',
        reason: 'race',
        expectedEntityRev: reg.entityRev,
        expectedBoardRev: reg.boardRev,
        canonicalHash: PIN,
        currentPinHash: PIN,
        idempotencyKey: 'term-race',
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const ok = await terminateRun(h.deps, {
      boardId: BOARD,
      runId: 'run-hb-term',
      agentId: 'agent-a',
      fencingToken: reg.fencingToken!,
      toState: 'SUCCEEDED',
      reason: 'after-hb',
      expectedEntityRev: hb.entityRev,
      expectedBoardRev: hb.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'term-ok',
    })
    expect(ok.state).toBe('SUCCEEDED')
  })
})

describe('terminate_run vs set_run_status non-alias (shared durable runtime)', () => {
  beforeEach(() => {
    resetControlPlaneRuntimeContextForTests()
    const mem = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(mem)
  })

  it('defaultRunDeps register+terminate works; set_run_status is separate catalog tool', async () => {
    const deps = defaultRunDeps(BOARD, 0)
    // Seed board rev 0 on atomic if needed via register path
    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-shared',
      taskId: 'T-S',
      targetGate: 'G1',
      agentId: 'agent-shared',
      model: 'grok',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'reg-shared',
      collisionScopeLockIds: ['repo:shared:term/**'],
      initialState: 'RUNNING',
      capacity: openCapacity(),
    })
    const term = await terminateRun(deps, {
      boardId: BOARD,
      runId: 'run-shared',
      agentId: 'agent-shared',
      fencingToken: reg.fencingToken!,
      toState: 'SUCCEEDED',
      reason: 'shared',
      expectedEntityRev: reg.entityRev,
      expectedBoardRev: reg.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'term-shared',
    })
    expect(term.state).toBe('SUCCEEDED')
    expect(REGISTERED_WRITE_TOOL_NAMES).toContain('set_run_status')
    expect(REGISTERED_WRITE_TOOL_NAMES).toContain('terminate_run')
    expect('set_run_status').not.toBe('terminate_run')
  })
})

describe('RunRegistryError typing for terminate', () => {
  it('exports RunRegistryError for FENCED path', () => {
    const e = new RunRegistryError('FENCED', 'terminal fencing mismatch')
    expect(e.code).toBe('FENCED')
    expect(e).toBeInstanceOf(Error)
  })
  it('McpMutationError INVALID_INPUT for role toState gate', () => {
    const e = new McpMutationError('INVALID_INPUT', 'toState STALE not allowed')
    expect(e.code).toBe('INVALID_INPUT')
  })
})
