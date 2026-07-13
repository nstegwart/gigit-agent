/**
 * Focused integration: durable canonical MCP wiring.
 * - one runtime context (memory via explicit test injection only)
 * - pin from durable board/lifecycle revs (not hardcoded lifecycleRev=0)
 * - list/get runs/accounts/decisions/G5 from durable stores
 * - public MCP service: shared materialization + pin invalidation + rate limit
 * - typedError never echoes ER_* codes/details
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  assertGranularDefinitionMutationAllowed,
  authorizePersistedRunOwner,
  assertRegisteredRunOrThrow,
  attributionFromPrincipal,
  boardPinFromDefinitionPin,
  buildCanonicalRollupTaskInputs,
  buildCanonicalSnapshotFromReplaceBoardArgs,
  compatibilityReplaceAccountsResponse,
  compatibilityReplaceBoardReceipt,
  computeCanonicalDefinitionRollup,
  createMemoryControlPlaneRuntimeContext,
  defaultRunDeps,
  DEFINITION_MUTATOR_TOOL_NAMES,
  enforceIntegratorLockBounds,
  legacyOpsCompatibilityPayload,
  legacyShapedRollupFromCanonical,
  listRegisteredWriteToolSchemas,
  mapCanonicalFlowsToFeatureRows,
  mapCanonicalProjectsToListRows,
  mapCanonicalTasksToListRows,
  mapCanonicalTasksToWorkRows,
  mapLegacyOpsAccountsToSync,
  mcpTypedErrorForTests,
  McpMutationError,
  parseMutationEnvelope,
  registerBoardTools,
  REGISTERED_WRITE_TOOL_NAMES,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  resolveAdvanceTaskPersistedAgentId,
  resolveBoardDefinitionAuthority,
  resolveMcpRuntimeContext,
  runMutationGate,
  setTestControlPlaneRuntimeContext,
  throwNotFound,
  unclassifiedClassificationForTask,
  writeToolSchemaHasFullEnvelope,
  MUTATION_ENVELOPE_REQUIRED_KEYS,
  type McpAuthContext,
} from '#/server/board-mcp'
import {
  CanonicalReadModelError,
  loadPinnedDefinitionReadModel,
} from '#/server/canonical-read-model'
import { defaultScopesForRole, RbacError, type Principal } from '#/server/rbac'
import { seedBoardRevision } from '#/server/control-data-persistence'
import {
  createPublicSnapshotService,
  getSharedPublicSnapshotService,
  resetPublicSnapshotServiceForTests,
  setTestPublicSnapshotService,
} from '#/server/public-snapshot-service'
import { createMemoryPublicSnapshotStore, type PublicAggregationInput } from '#/server/public-snapshot'
import { createPublicSnapshotRateLimiter, createMemoryRateLimitStore } from '#/server/rate-limit'
import { PUBLIC_SERIALIZER_VERSION } from '#/server/public-snapshot'
import {
  registerRun,
  type RegisterRunRequest,
} from '#/server/run-registry'
import { openDecisionV3 } from '#/server/decisions-v3'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { applyImport, planImport } from '#/server/canonical-import'
import { syncAccounts } from '#/server/account-sync'
import { validateCanonicalSnapshot } from '#/server/canonical-snapshot'

const BOARD = 'durable-mcp-board'

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

function rootPrincipal(): Principal {
  return {
    role: 'ROOT_ORCHESTRATOR',
    actorId: 'root-durable-test',
    channel: 'bearer',
    scopes: defaultScopesForRole('ROOT_ORCHESTRATOR'),
    boards: [],
  }
}

function authRoot(): McpAuthContext {
  return {
    principal: rootPrincipal(),
    mechanism: { kind: 'OK' },
    bearerPresent: true,
  }
}

/** Capture tool handler outputs via a thin McpServer double is hard; call deps directly. */

beforeEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  resetPublicSnapshotServiceForTests()
  const mem = createMemoryControlPlaneRuntimeContext()
  setTestControlPlaneRuntimeContext(mem)
})

afterEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  resetPublicSnapshotServiceForTests()
})

describe('durable MCP runtime context', () => {
  it('resolveMcpRuntimeContext returns the injected singleton', () => {
    const a = resolveMcpRuntimeContext()
    const b = resolveMcpRuntimeContext()
    expect(a).toBe(b)
    expect(a.mode).toBe('memory')
    expect(a.runtime.runs).toBe(a.runtime.runs)
    expect(defaultRunDeps(BOARD, 0).runs).toBe(a.runtime.runs)
    expect(defaultRunDeps(BOARD, 0).atomic).toBe(a.atomic)
    expect(defaultRunDeps(BOARD, 0).idempotency).toBe(a.idempotency)
  })

  it('defaultRunDeps shares durable runs for register path', async () => {
    const deps = defaultRunDeps(BOARD, 0)
    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-dur-1',
      taskId: 'task-1',
      targetGate: 'G1',
      agentId: 'agent-dur',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-dur-1',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    expect(reg.fencingToken).toBeTruthy()
    const listed = await deps.runs.list(BOARD)
    expect(listed.some((r) => r.runId === 'run-dur-1')).toBe(true)
    // Same store on second defaultRunDeps call
    const listed2 = await defaultRunDeps(BOARD, 0).runs.list(BOARD)
    expect(listed2.some((r) => r.runId === 'run-dur-1')).toBe(true)
  })
})

describe('durable pin lifecycleRev (not hardcoded 0)', () => {
  it('imports.getBoardState carries seeded lifecycleRev', async () => {
    const ctx = resolveMcpRuntimeContext()
    // memory-backed control data exposes sql client via createMemoryBacked...
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
    expect(sql).toBeTruthy()
    await seedBoardRevision(sql!, {
      boardId: BOARD,
      boardRev: 7,
      lifecycleRev: 3,
      subjectHash: 'a'.repeat(64),
      canonicalSnapshotId: 'snap-durable-1',
      canonicalHash: 'b'.repeat(64),
    })
    const st = await ctx.controlData.imports.getBoardState(BOARD)
    expect(st).not.toBeNull()
    expect(st!.boardRev).toBe(7)
    expect(st!.lifecycleRev).toBe(3)
    expect(st!.canonicalSnapshotId).toBe('snap-durable-1')
    expect(st!.lifecycleRev).not.toBe(0)
  })
})

describe('durable decisions + g5 stores', () => {
  it('decisions list uses controlData.decisions store', async () => {
    const ctx = resolveMcpRuntimeContext()
    const opened = await openDecisionV3(
      { clock: ctx.clock, decisions: ctx.controlData.decisions, atomic: ctx.atomic },
      {
        boardId: BOARD,
        actorId: 'actor-durable',
        question: 'Approve durable path?',
        title: 'Durable decision',
        type: 'POLICY',
        severity: 'MEDIUM',
        blocking: false,
        expectedBoardRev: 0,
        options: [
          {
            optionId: 'yes',
            label: 'Yes',
            declining: false,
            requestsProductionAuthority: false,
            requestsHoldAuthority: false,
            requestsProviderAuthority: false,
          },
        ],
      },
    )
    expect(opened.decisionId).toBeTruthy()
    const listed = await ctx.controlData.decisions.list(BOARD)
    expect(listed.some((d) => d.decisionId === opened.decisionId)).toBe(true)
  })

  it('g5 store list is empty by default (fail-closed g5Pass)', async () => {
    const ctx = resolveMcpRuntimeContext()
    const domains = await ctx.controlData.g5.list(BOARD)
    expect(domains).toEqual([])
  })
})

describe('public snapshot shared service', () => {
  it('tool+resource share one store; pin change invalidates', async () => {
    const store = createMemoryPublicSnapshotStore()
    const svc = createPublicSnapshotService({
      store,
      rateLimiter: createPublicSnapshotRateLimiter({
        store: createMemoryRateLimitStore(),
        // high burst for this unit path
        policy: { sustainedPerMinute: 600, burst: 100 },
      }),
    })
    setTestPublicSnapshotService(svc)

    let pinRev = 1
    const load = async (boardId: string): Promise<PublicAggregationInput | null> => ({
      boardId,
      pin: {
        canonicalSnapshotId: `snap-${pinRev}`,
        canonicalHash: 'c'.repeat(64),
        boardRev: pinRev,
        lifecycleRev: pinRev,
        serializerVersion: PUBLIC_SERIALIZER_VERSION,
      },
      generatedAt: '2026-07-14T00:00:00.000Z',
      publishedAt: '2026-07-14T00:00:00.000Z',
      publicationIntervalMs: 60_000,
      boardRollup: {
        trackedWorkDenominator: 1,
        productDenominator: 1,
        stageProdReady: 0,
        prodReadyWithEvidence: 0,
        unclassifiedCount: 0,
        rawTaskReadinessPercent: 0,
        boardReadinessPercent: 0,
        cappedBy: null,
      },
      completion: { complete: false, g5Pass: false },
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 0,
      },
      staleOverlays: {},
      priorityRollup: null,
      projects: [],
      features: [],
      tasks: [],
      runs: [],
      accounts: [],
      decisionCount: 0,
      g5: {
        g5Pass: false,
        domainPassCount: 0,
        domainRequiredCount: 9,
      },
    })

    const first = await svc.getPublicSnapshot({ boardId: BOARD, loadAggregation: load, skipRateLimit: true })
    expect(first.ok).toBe(true)
    if (!first.ok) return
    expect(first.replayed).toBe(false)

    const second = await svc.getPublicSnapshot({ boardId: BOARD, loadAggregation: load, skipRateLimit: true })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.replayed).toBe(true)
    expect(second.etag).toBe(first.etag)

    pinRev = 2
    const third = await svc.getPublicSnapshot({ boardId: BOARD, loadAggregation: load, skipRateLimit: true })
    expect(third.ok).toBe(true)
    if (!third.ok) return
    expect(third.replayed).toBe(false)
    expect(third.pin.boardRev).toBe(2)
    expect(third.pin.lifecycleRev).toBe(2)
    expect(third.etag).not.toBe(first.etag)

    // Same shared singleton for getSharedPublicSnapshotService when test override set
    expect(getSharedPublicSnapshotService()).toBe(svc)
  })

  it('rate limiter enforces burst (60/min policy, burst 20)', async () => {
    const clock = { nowMs: () => 1_000_000 }
    const svc = createPublicSnapshotService({
      rateLimiter: createPublicSnapshotRateLimiter({
        store: createMemoryRateLimitStore(),
        clock,
        policy: { sustainedPerMinute: 60, burst: 20, windowMs: 60_000 },
      }),
    })
    const load = async (): Promise<PublicAggregationInput | null> => null
    let limited = 0
    for (let i = 0; i < 25; i++) {
      const r = await svc.getPublicSnapshot({
        boardId: BOARD,
        clientKey: 'burst-test',
        loadAggregation: load,
      })
      if (!r.ok && r.code === 'RATE_LIMITED') limited++
    }
    expect(limited).toBeGreaterThan(0)
  })
})

describe('legacy mutation envelope hardening (AC-API-03)', () => {
  it('every registered write tool schema requires full mutation envelope', () => {
    const server = new McpServer({ name: 'mutation-envelope-proof', version: '0.0.0' })
    registerBoardTools(server, authRoot())
    const writes = listRegisteredWriteToolSchemas()
    expect(writes.length).toBeGreaterThan(0)
    const incomplete = writes.filter((w) => !writeToolSchemaHasFullEnvelope(w.schemaKeys))
    expect(incomplete).toEqual([])
    // Required logical keys: entity rev (aliases ok), board rev, subject/canonical hash, idempotency
    expect(MUTATION_ENVELOPE_REQUIRED_KEYS).toEqual([
      'entityExpectedRev',
      'expectedBoardRev',
      'canonicalHash',
      'idempotencyKey',
    ])
    for (const w of writes) {
      expect(writeToolSchemaHasFullEnvelope(w.schemaKeys)).toBe(true)
    }
  })

  it('exhaustive registered-write matrix: all 40 catalog writes including 9 V3', () => {
    const server = new McpServer({ name: 'write-matrix', version: '0.0.0' })
    registerBoardTools(server, authRoot())
    const writes = listRegisteredWriteToolSchemas()
    const names = new Set(writes.map((w) => w.name))

    // Catalog constant must be exactly 40
    expect(REGISTERED_WRITE_TOOL_NAMES).toHaveLength(40)
    expect(writes).toHaveLength(40)

    const missing = REGISTERED_WRITE_TOOL_NAMES.filter((n) => !names.has(n))
    const extra = writes.map((w) => w.name).filter((n) => !(REGISTERED_WRITE_TOOL_NAMES as readonly string[]).includes(n))
    expect(missing).toEqual([])
    expect(extra).toEqual([])

    const v3 = [
      'publish_dispatch_plan',
      'register_run',
      'heartbeat_run',
      'sync_accounts',
      'reconcile_dry_run',
      'reconcile_apply',
      'open_decision_v3',
      'resolve_decision_v3',
      'integration_lock',
    ] as const
    for (const n of v3) {
      expect(names.has(n)).toBe(true)
      const row = writes.find((w) => w.name === n)!
      expect(writeToolSchemaHasFullEnvelope(row.schemaKeys)).toBe(true)
    }

    // Per-tool matrix assertion
    for (const w of writes) {
      expect(writeToolSchemaHasFullEnvelope(w.schemaKeys), `${w.name} missing envelope keys`).toBe(
        true,
      )
      const keys = new Set(w.schemaKeys)
      expect(
        keys.has('entityExpectedRev') ||
          keys.has('expectedEntityRev') ||
          keys.has('expectedRev'),
      ).toBe(true)
      expect(keys.has('expectedBoardRev')).toBe(true)
      expect(keys.has('canonicalHash') || keys.has('subjectHash')).toBe(true)
      expect(keys.has('idempotencyKey')).toBe(true)
    }
  })

  it('parseMutationEnvelope fails closed when any required field is missing', () => {
    const base = {
      entityExpectedRev: 0,
      expectedBoardRev: 1,
      canonicalHash: 'hash-abc',
      idempotencyKey: 'idem-1',
    }
    expect(() => parseMutationEnvelope({})).toThrow(McpMutationError)
    expect(() =>
      parseMutationEnvelope({
        expectedBoardRev: base.expectedBoardRev,
        canonicalHash: base.canonicalHash,
        idempotencyKey: base.idempotencyKey,
      }),
    ).toThrow(/entityExpectedRev/)
    expect(() =>
      parseMutationEnvelope({
        entityExpectedRev: base.entityExpectedRev,
        canonicalHash: base.canonicalHash,
        idempotencyKey: base.idempotencyKey,
      }),
    ).toThrow(/expectedBoardRev/)
    expect(() =>
      parseMutationEnvelope({
        entityExpectedRev: base.entityExpectedRev,
        expectedBoardRev: base.expectedBoardRev,
        idempotencyKey: base.idempotencyKey,
      }),
    ).toThrow(/canonicalHash|subjectHash/)
    expect(() =>
      parseMutationEnvelope({
        entityExpectedRev: base.entityExpectedRev,
        expectedBoardRev: base.expectedBoardRev,
        canonicalHash: base.canonicalHash,
      }),
    ).toThrow(/idempotencyKey/)
    // Honest zero + aliases accepted
    const ok = parseMutationEnvelope({
      expectedRev: 0,
      expectedBoardRev: 2,
      subjectHash: 'subj-1',
      idempotencyKey: 'k',
    })
    expect(ok).toEqual({
      entityExpectedRev: 0,
      expectedBoardRev: 2,
      subjectHash: 'subj-1',
      idempotencyKey: 'k',
    })
  })

  it('runMutationGate: stale board rev / hash / UNCLASSIFIED / HOLD / idempotency conflict fail closed', async () => {
    const ctx = resolveMcpRuntimeContext()
    const boardId = BOARD
    const envelope = {
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: 'gate-hash-1',
      idempotencyKey: 'gate-idem-1',
    }

    // Stale board rev (atomic defaults boardRev=0)
    await expect(
      runMutationGate(
        {
          toolName: 'test_stale_board',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'board',
          entityId: boardId,
          requestBody: { ...envelope, expectedBoardRev: 99_999, idempotencyKey: 'stale-board-1' },
          skipPinHashCheck: true,
        },
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    // Subject/canonical hash mismatch against current pin (fail closed)
    await expect(
      runMutationGate(
        {
          toolName: 'test_hash_mismatch',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'board',
          entityId: boardId,
          requestBody: {
            ...envelope,
            canonicalHash: 'definitely-not-the-current-pin-hash',
            idempotencyKey: 'hash-mismatch-1',
          },
          skipBoardRevCheck: true,
        },
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    // UNCLASSIFIED when taskId present and no classification row
    await expect(
      runMutationGate(
        {
          toolName: 'test_unclassified',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'task',
          entityId: 'T-missing-class',
          taskId: 'T-missing-class',
          requestBody: { ...envelope, idempotencyKey: 'unclass-1' },
          skipPinHashCheck: true,
          skipBoardRevCheck: true,
        },
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'DATA_INTEGRITY' })

    // HOLD disposition
    await ctx.controlData.classification.put(boardId, {
      taskId: 'T-HOLD-DUR',
      taskClass: 'PRODUCT',
      disposition: 'HOLD',
      receipt: null,
    })
    await expect(
      runMutationGate(
        {
          toolName: 'test_hold',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'task',
          entityId: 'T-HOLD-DUR',
          taskId: 'T-HOLD-DUR',
          requestBody: { ...envelope, idempotencyKey: 'hold-1' },
          skipPinHashCheck: true,
          skipBoardRevCheck: true,
        },
        async () => ({ ok: true as const }),
      ),
    ).rejects.toMatchObject({ code: 'BLOCKED' })

    // Happy path + idempotent replay + same-key different body → conflict
    const first = await runMutationGate(
      {
        toolName: 'test_idem',
        boardId,
        actorId: 'root-durable-test',
        entityType: 'board',
        entityId: boardId,
        requestBody: { ...envelope, payload: 'A', idempotencyKey: 'idem-replay-1' },
        skipPinHashCheck: true,
        skipBoardRevCheck: true,
      },
      async () => ({ ok: true as const, payload: 'A' }),
    )
    expect(first.ok).toBe(true)
    expect(first.payload).toBe('A')
    expect(first.replayed).toBeUndefined()

    const replay = await runMutationGate(
      {
        toolName: 'test_idem',
        boardId,
        actorId: 'root-durable-test',
        entityType: 'board',
        entityId: boardId,
        requestBody: { ...envelope, payload: 'A', idempotencyKey: 'idem-replay-1' },
        skipPinHashCheck: true,
        skipBoardRevCheck: true,
      },
      async () => ({ ok: true as const, payload: 'SHOULD_NOT_RUN' }),
    )
    expect(replay.replayed).toBe(true)
    expect(replay.payload).toBe('A')

    await expect(
      runMutationGate(
        {
          toolName: 'test_idem',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'board',
          entityId: boardId,
          requestBody: { ...envelope, payload: 'B-DIFFERENT', idempotencyKey: 'idem-replay-1' },
          skipPinHashCheck: true,
          skipBoardRevCheck: true,
        },
        async () => ({ ok: true as const, payload: 'B' }),
      ),
    ).rejects.toMatchObject({ code: expect.stringMatching(/IDEMPOTENCY/) })
  })

  it('dryRun does not advance board or entity revision', async () => {
    const ctx = resolveMcpRuntimeContext()
    const boardId = BOARD
    const before = await ctx.atomic.getBoardState(boardId)
    const envelope = {
      entityExpectedRev: 0,
      expectedBoardRev: before.boardRev,
      canonicalHash: 'dry-hash',
      idempotencyKey: 'dry-run-rev-1',
    }
    const body = await runMutationGate(
      {
        toolName: 'test_dry_run',
        boardId,
        actorId: 'root-durable-test',
        entityType: 'board',
        entityId: boardId,
        requestBody: envelope,
        skipPinHashCheck: true,
        dryRun: true,
      },
      async () => ({ ok: true as const, dryRun: true, preview: true }),
    )
    expect(body.dryRun).toBe(true)
    const after = await ctx.atomic.getBoardState(boardId)
    expect(after.boardRev).toBe(before.boardRev)
    // Entity revision must not have been written for dryRun
    const ent = await ctx.revisions.getEntity({
      boardId,
      entityType: 'board',
      entityId: boardId,
    })
    // Either null (never written) or still at pre-dry state (entityRev 0 not advanced past mutate-only)
    if (ent) {
      expect(ent.entityRev).toBe(0)
    }
  })

  it('not-found throw does not consume idempotency or advance revision', async () => {
    const ctx = resolveMcpRuntimeContext()
    const boardId = BOARD
    const before = await ctx.atomic.getBoardState(boardId)
    const envelope = {
      entityExpectedRev: 0,
      expectedBoardRev: before.boardRev,
      canonicalHash: 'nf-hash',
      idempotencyKey: 'not-found-idem-1',
    }
    await expect(
      runMutationGate(
        {
          toolName: 'test_not_found',
          boardId,
          actorId: 'root-durable-test',
          entityType: 'feature',
          entityId: 'missing-feat',
          requestBody: envelope,
          skipPinHashCheck: true,
        },
        async () => {
          throwNotFound('feature not found: missing-feat', { featureId: 'missing-feat' })
        },
      ),
    ).rejects.toMatchObject({ code: 'NOT_FOUND' })

    const after = await ctx.atomic.getBoardState(boardId)
    expect(after.boardRev).toBe(before.boardRev)

    // Entity CAS must not have been persisted for the not-found path
    const ent = await ctx.revisions.getEntity({
      boardId,
      entityType: 'feature',
      entityId: 'missing-feat',
    })
    expect(ent == null || ent.entityRev === 0).toBe(true)

    // After error cleanup, a fresh key must EXECUTE (proves gate released in-progress slots
    // and not-found did not leave a durable completed idempotency body for the failed key).
    const ok = await runMutationGate(
      {
        toolName: 'test_not_found',
        boardId,
        actorId: 'root-durable-test',
        entityType: 'feature',
        entityId: 'missing-feat',
        requestBody: { ...envelope, idempotencyKey: 'not-found-idem-2' },
        skipPinHashCheck: true,
      },
      async () => ({ ok: true as const, recovered: true }),
    )
    expect(ok.recovered).toBe(true)
    expect(ok.replayed).toBeUndefined()
  })

  it('authorizePersistedRunOwner rejects AGENT on foreign run; attribution is principal', () => {
    const agent: Principal = {
      role: 'AGENT',
      actorId: 'agent-a',
      agentId: 'agent-a',
      channel: 'bearer',
      scopes: defaultScopesForRole('AGENT'),
      boards: [],
    }
    expect(() => authorizePersistedRunOwner(agent, 'agent-b')).toThrow(RbacError)
    expect(() => authorizePersistedRunOwner(agent, 'agent-a')).not.toThrow()
    // ROOT no-op
    const root = rootPrincipal()
    expect(() => authorizePersistedRunOwner(root, 'anyone')).not.toThrow()
    expect(attributionFromPrincipal(agent)).toBe('agent-a')
    expect(attributionFromPrincipal(root)).toBe('root-durable-test')
  })

  it('integration_lock bounds: INTEGRATOR pathspec/checkpoint enforced', () => {
    const integ: Principal = {
      role: 'INTEGRATOR',
      actorId: 'int-1',
      channel: 'bearer',
      scopes: defaultScopesForRole('INTEGRATOR'),
      boards: [],
      pathspecs: ['src/server/**'],
      checkpointId: 'cp-allowed',
    }
    expect(() =>
      enforceIntegratorLockBounds(integ, {
        checkpointId: 'cp-other',
        pathspecs: ['src/server/board-mcp.ts'],
      }),
    ).toThrow(RbacError)
    expect(() =>
      enforceIntegratorLockBounds(integ, {
        checkpointId: 'cp-allowed',
        pathspecs: ['other/repo/**'],
      }),
    ).toThrow(RbacError)
    expect(() =>
      enforceIntegratorLockBounds(integ, {
        checkpointId: 'cp-allowed',
        pathspecs: ['src/server/board-mcp.ts'],
      }),
    ).not.toThrow()
  })

  it('assertRegisteredRunOrThrow fails closed for unknown byRunId', async () => {
    await expect(assertRegisteredRunOrThrow(BOARD, 'run-never-registered')).rejects.toMatchObject({
      code: 'RUN_NOT_REGISTERED',
    })
  })
})

describe('P0 advance_task V3-only ownership (not principal-self)', () => {
  it('resolveAdvanceTaskPersistedAgentId returns V3 agentId for registry-only run', async () => {
    const deps = defaultRunDeps(BOARD, 0)
    await registerRun(deps, {
      boardId: BOARD,
      runId: 'v3-run-foreign',
      taskId: 'task-own-1',
      targetGate: 'G1',
      agentId: 'agent-foreign-owner',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-v3-foreign',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    const owner = await resolveAdvanceTaskPersistedAgentId(BOARD, 'v3-run-foreign')
    expect(owner).toBe('agent-foreign-owner')
  })

  it('AGENT foreign V3 byRunId is denied; self V3 byRunId is allowed', async () => {
    const deps = defaultRunDeps(BOARD, 0)
    await registerRun(deps, {
      boardId: BOARD,
      runId: 'v3-run-self',
      taskId: 'task-own-2',
      targetGate: 'G1',
      agentId: 'agent-a',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-v3-self',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    await registerRun(deps, {
      boardId: BOARD,
      runId: 'v3-run-other',
      taskId: 'task-own-3',
      targetGate: 'G1',
      agentId: 'agent-b',
      model: 'grok-4',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'idem-v3-other',
      initialState: 'STARTING',
      capacity: openCapacity(),
    })
    const agent: Principal = {
      role: 'AGENT',
      actorId: 'agent-a',
      agentId: 'agent-a',
      channel: 'bearer',
      scopes: defaultScopesForRole('AGENT'),
      boards: [],
    }
    const selfOwner = await resolveAdvanceTaskPersistedAgentId(BOARD, 'v3-run-self')
    const foreignOwner = await resolveAdvanceTaskPersistedAgentId(BOARD, 'v3-run-other')
    expect(selfOwner).toBe('agent-a')
    expect(foreignOwner).toBe('agent-b')
    expect(() => authorizePersistedRunOwner(agent, selfOwner)).not.toThrow()
    expect(() => authorizePersistedRunOwner(agent, foreignOwner)).toThrow(RbacError)
    // Regression: never authorize principal against itself when owner is foreign
    expect(foreignOwner).not.toBe(agent.agentId)
  })

  it('unknown byRunId yields null owner (fail closed before self-compare)', async () => {
    const owner = await resolveAdvanceTaskPersistedAgentId(BOARD, 'no-such-run')
    expect(owner).toBeNull()
  })
})

describe('P1 replace_accounts → durable sync ingestion', () => {
  it('mapLegacyOpsAccountsToSync maps id/usable/slots and strips secrets', () => {
    const mapped = mapLegacyOpsAccountsToSync({
      accounts: [
        {
          id: 'acct-1',
          label: 'Grok A',
          status: 'usable',
          usable: true,
          slotsInUse: 1,
          slotsCapacity: 5,
          provider: 'GROK',
          token: 'SECRET_SHOULD_STRIP',
          apiKey: 'also-strip',
        },
        {
          id: 'acct-2',
          label: 'Limited',
          status: 'LIMIT',
          usable: false,
          slotsInUse: 0,
          slotsCapacity: 3,
          provider: 'SPARK',
        },
      ],
    })
    expect(mapped).toHaveLength(2)
    expect(mapped[0]).toMatchObject({
      maskedAccountId: 'acct-1',
      status: 'OK',
      providerKind: 'GROK',
      effectiveInUse: 1,
      effectiveCap: 5,
    })
    expect(JSON.stringify(mapped)).not.toMatch(/SECRET_SHOULD_STRIP|also-strip/)
    expect(mapped[1]?.status).toBe('LIMIT')
  })

  it('mapLegacyOpsAccountsToSync fails closed on secret-like id and missing accounts', () => {
    expect(() => mapLegacyOpsAccountsToSync({ accounts: [{ id: 'token-xyz', usable: true }] })).toThrow(
      McpMutationError,
    )
    expect(() => mapLegacyOpsAccountsToSync(null)).toThrow(McpMutationError)
  })

  it('durable syncAccounts persistence + readback + compatibility response', async () => {
    const ctx = resolveMcpRuntimeContext()
    const boardId = BOARD
    const ops = {
      vault: { generatedAt: '2026-07-14T00:00:00.000Z', source: 'legacy-vault' },
      accounts: [
        {
          id: 'mask-legacy-1',
          label: 'L1',
          status: 'OK',
          usable: true,
          slotsInUse: 0,
          slotsCapacity: 5,
          provider: 'GROK',
        },
      ],
    }
    const mapped = mapLegacyOpsAccountsToSync(ops)
    const atomicBefore = await ctx.atomic.getBoardState(boardId)
    const sync = await syncAccounts(
      {
        clock: ctx.clock,
        accounts: ctx.runtime.accounts,
        atomic: ctx.atomic,
        idempotency: ctx.idempotency,
      },
      {
        boardId,
        sourceRevision: 1,
        generatedAt: '2026-07-14T00:00:00.000Z',
        expectedBoardRev: atomicBefore.boardRev,
        accounts: mapped,
        trigger: 'ORCHESTRATOR_LAUNCH',
        idempotencyKey: 'replace-acct-idem-1',
        callerRole: 'ROOT_ORCHESTRATOR',
        actorId: 'root-durable-test',
      },
    )
    expect(sync.acceptedCount).toBe(1)
    expect(sync.replayed).toBe(false)
    const snap = await ctx.runtime.accounts.get(boardId)
    expect(snap).not.toBeNull()
    expect(snap!.accounts[0]?.maskedAccountId).toBe('mask-legacy-1')
    expect(snap!.sourceRevision).toBe(1)
    const compatOps = legacyOpsCompatibilityPayload(ops)
    const wire = compatibilityReplaceAccountsResponse(compatOps, sync)
    expect(wire.accounts).toEqual(compatOps.accounts)
    expect(wire.sourceRevision).toBe(1)
    expect(wire.usableCapacity).toBe(sync.usableCapacity)
    expect(wire.boardRev).toBe(sync.boardRev)
    // Same-revision parity path still available via store
    expect(snap!.readbackSurfaces.mcp).toBeNull()
  })
})

describe('P1 replace_board_snapshot → planImport/applyImport', () => {
  it('buildCanonicalSnapshotFromReplaceBoardArgs produces schema-valid snapshot', () => {
    const snap = buildCanonicalSnapshotFromReplaceBoardArgs(
      BOARD,
      {
        projects: [{ id: 'p1', nama: 'Proj', status: 'active' }],
        features: [{ id: 'f1', nama: 'Feat', fase: 'build', projectId: 'p1' }],
        tasks: [{ id: 't1', title: 'Task one', projectId: 'p1', featureId: 'f1' }],
      },
      { idempotencyKey: 'snap-build-1' },
    )
    expect(() => validateCanonicalSnapshot(snap)).not.toThrow()
    expect(snap.payload.projects[0]?.id).toBe('p1')
    expect(snap.payload.tasks[0]?.id).toBe('t1')
    expect(snap.payload.flows[0]?.id).toBe('f1')
    expect(snap.manifest.boardId).toBe(BOARD)
  })

  it('dryRun planImport does not mutate boardRev or advance import entity', async () => {
    const ctx = resolveMcpRuntimeContext()
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
    expect(sql).toBeTruthy()
    await seedBoardRevision(sql!, {
      boardId: BOARD,
      boardRev: 0,
      lifecycleRev: 2,
      subjectHash: '',
      canonicalSnapshotId: null,
      canonicalHash: null,
    })
    const before = await ctx.controlData.imports.getBoardState(BOARD)
    expect(before).not.toBeNull()
    const lifecycleBefore = before!.lifecycleRev
    const boardRevBefore = before!.boardRev
    const entityBefore = before!.entityRev

    const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
      BOARD,
      {
        projects: [{ id: 'p-dry', nama: 'Dry', status: 'ok' }],
        tasks: [{ id: 't-dry', title: 'Dry task', projectId: 'p-dry' }],
      },
      { idempotencyKey: 'dry-plan-1' },
    )
    const plan = await planImport(ctx.controlData.imports, {
      auth: {
        actorId: 'root-durable-test',
        scopes: ['import:write'],
        role: 'ROOT_ORCHESTRATOR',
      },
      snapshot,
      entityExpectedRev: entityBefore,
      expectedBoardRev: boardRevBefore,
      expectedSubjectHash: before!.subjectHash ?? '',
    })
    expect(plan.ok).toBe(true)
    expect(plan.validation).toEqual({ schema: true, hash: true, graph: true })
    const after = await ctx.controlData.imports.getBoardState(BOARD)
    expect(after!.boardRev).toBe(boardRevBefore)
    expect(after!.entityRev).toBe(entityBefore)
    expect(after!.lifecycleRev).toBe(lifecycleBefore)
    expect(after!.canonicalSnapshotId).toBe(before!.canonicalSnapshotId)
    const receipt = compatibilityReplaceBoardReceipt({
      boardId: BOARD,
      dryRun: true,
      appliedCollections: ['projects', 'tasks'],
      fromHash: '',
      plan,
      afterCounts: {
        projects: 1,
        features: 0,
        tasks: 1,
        productionGates: 0,
        guideSections: 0,
        accounts: 0,
        runs: 0,
      },
    })
    expect(receipt.ok).toBe(true)
    expect(receipt.dryRun).toBe(true)
    expect(receipt.toHash).toBeNull()
  })

  it('valid applyImport persists + preserves compatibility receipt + no lifecycle mutate', async () => {
    const ctx = resolveMcpRuntimeContext()
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
    await seedBoardRevision(sql!, {
      boardId: BOARD,
      boardRev: 0,
      lifecycleRev: 5,
      subjectHash: '',
      canonicalSnapshotId: null,
      canonicalHash: null,
    })
    // Inject lifecycle evidence fingerprint via apply path preservation
    const before = await ctx.controlData.imports.getBoardState(BOARD)
    expect(before).not.toBeNull()
    const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
      BOARD,
      {
        projects: [{ id: 'p-apply', nama: 'Apply', status: 'ok' }],
        tasks: [
          { id: 't-apply-1', title: 'A1', projectId: 'p-apply' },
          { id: 't-apply-2', title: 'A2', projectId: 'p-apply' },
        ],
      },
      { idempotencyKey: 'apply-import-1', snapshotId: 'snap-apply-1' },
    )
    const applied = await applyImport(ctx.controlData.imports, ctx.idempotency, null, {
      auth: {
        actorId: 'root-durable-test',
        scopes: ['import:write'],
        role: 'ROOT_ORCHESTRATOR',
      },
      snapshot,
      entityExpectedRev: before!.entityRev,
      expectedBoardRev: before!.boardRev,
      expectedSubjectHash: before!.subjectHash ?? '',
      idempotencyKey: 'apply-import-1',
      dryRun: false,
    })
    expect(applied.ok).toBe(true)
    expect(applied.kind).toBe('APPLIED')
    expect(applied.lifecycleEvidenceUnchanged).toBe(true)
    expect(applied.lifecycleRev).toBe(5)
    expect(applied.boardRev).toBe(before!.boardRev + 1)
    expect(applied.readback.distinctTaskIds).toEqual(['t-apply-1', 't-apply-2'])
    const after = await ctx.controlData.imports.getBoardState(BOARD)
    expect(after!.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(after!.canonicalHash).toBe(applied.canonicalHash)
    expect(after!.lifecycleRev).toBe(5)
    const receipt = compatibilityReplaceBoardReceipt({
      boardId: BOARD,
      dryRun: false,
      appliedCollections: ['projects', 'tasks'],
      fromHash: '',
      applied,
      afterCounts: {
        projects: 1,
        features: 0,
        tasks: 2,
        productionGates: 0,
        guideSections: 0,
        accounts: 0,
        runs: 0,
      },
    })
    expect(receipt.ok).toBe(true)
    expect(receipt.dryRun).toBe(false)
    expect(receipt.toHash).toBe(applied.canonicalHash)
    expect((receipt.import as { provenance: { dryRun: boolean } }).provenance.dryRun).toBe(false)
  })
})

describe('typedError ER_* allowlist', () => {
  it('never echoes ER_DUP_ENTRY code/message/details', () => {
    const err = new Error('Duplicate entry for key PRIMARY') as Error & {
      code: string
      details: Record<string, unknown>
    }
    err.code = 'ER_DUP_ENTRY'
    err.details = { sqlMessage: 'ER_DUP_ENTRY for key primary', errno: 1062, sqlState: '23000' }
    const wire = mcpTypedErrorForTests(err)
    expect(wire.ok).toBe(false)
    expect(wire.code).toBe('MCP_HANDLER_ERROR')
    expect(wire.error).toBe('MCP_HANDLER_ERROR')
    expect(JSON.stringify(wire)).not.toMatch(/ER_DUP_ENTRY/)
    expect(JSON.stringify(wire)).not.toMatch(/Duplicate entry/)
  })

  it('passes through allowlisted STALE_REVISION with sanitized details', () => {
    const err = Object.assign(new Error('board rev mismatch'), {
      code: 'STALE_REVISION',
      details: { boardId: BOARD, expectedBoardRev: 1, currentBoardRev: 2, sqlMessage: 'ER_LOCK_WAIT' },
    })
    const wire = mcpTypedErrorForTests(err)
    expect(wire.code).toBe('STALE_REVISION')
    expect(wire.error).toBe('board rev mismatch')
    expect(wire.details).toMatchObject({ boardId: BOARD, expectedBoardRev: 1, currentBoardRev: 2 })
    expect(JSON.stringify(wire)).not.toMatch(/ER_LOCK/)
  })

  it('registerBoardTools registers without throwing under memory context', () => {
    const server = new McpServer({ name: 'test', version: '0.0.0' })
    expect(() => registerBoardTools(server, authRoot())).not.toThrow()
  })
})

describe('canonical list pagination + cursor revision (mcp-canonical-reads wiring)', () => {
  it('validateReadFilters accepts list_projects/features/tasks/activity/audit cursor+pageSize', async () => {
    const { validateReadFilters, DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } = await import(
      '#/server/mcp-canonical-reads'
    )
    for (const method of [
      'list_projects',
      'list_features',
      'list_tasks',
      'list_activity',
      'list_audit',
    ] as const) {
      const f = validateReadFilters(method, { boardId: BOARD, pageSize: 50 })
      expect(f.boardId).toBe(BOARD)
      expect(f.pageSize === 50 || f.pageSize == null).toBe(true)
    }
    expect(DEFAULT_PAGE_SIZE).toBe(50)
    expect(MAX_PAGE_SIZE).toBe(200)
    expect(() =>
      validateReadFilters('list_tasks', { boardId: BOARD, pageSize: 201 }),
    ).toThrow(/pageSize|200/i)
  })

  it('paginateReadRows rejects cursor boardRev mismatch (CURSOR_INVALID)', async () => {
    const { paginateReadRows, encodeReadCursor, McpReadContractError } = await import(
      '#/server/mcp-canonical-reads'
    )
    const rows = [
      { id: 'a', createdAt: '2026-07-14T12:00:00.000Z' },
      { id: 'b', createdAt: '2026-07-14T11:00:00.000Z' },
    ]
    const cursor = encodeReadCursor({
      createdAt: rows[0]!.createdAt,
      id: rows[0]!.id,
      boardRev: 1,
      order: 'DESC',
    })
    expect(() =>
      paginateReadRows(rows, {
        cursor,
        pageSize: 50,
        expectedBoardRev: 99,
      }),
    ).toThrow(McpReadContractError)
    try {
      paginateReadRows(rows, { cursor, pageSize: 50, expectedBoardRev: 99 })
    } catch (e) {
      expect(e).toBeInstanceOf(McpReadContractError)
      const err = e as InstanceType<typeof McpReadContractError>
      expect(err.code).toBe('CURSOR_INVALID')
      expect(String(err.message)).toMatch(/revision|boardRev|mismatch|cursor/i)
      const wire = mcpTypedErrorForTests(err)
      expect(wire.ok).toBe(false)
      expect(wire.code).toBe('CURSOR_INVALID')
    }
  })

  it('get_project/get_feature/get_task filters require entity id', async () => {
    const { validateReadFilters, McpReadContractError } = await import('#/server/mcp-canonical-reads')
    for (const method of ['get_project', 'get_feature', 'get_task'] as const) {
      expect(() => validateReadFilters(method, { boardId: BOARD })).toThrow(McpReadContractError)
    }
    expect(validateReadFilters('get_project', { boardId: BOARD, projectId: 'p1' })).toMatchObject({
      id: 'p1',
    })
    expect(validateReadFilters('get_feature', { boardId: BOARD, featureId: 'f1' })).toMatchObject({
      id: 'f1',
    })
    expect(validateReadFilters('get_task', { boardId: BOARD, taskId: 't1' })).toMatchObject({
      id: 't1',
    })
  })

  it('buildPinnedReadEnvelope pins list_projects method metadata', async () => {
    const { buildPinnedReadEnvelope } = await import('#/server/mcp-canonical-reads')
    const pin = {
      boardId: BOARD,
      canonicalSnapshotId: 'snap-x',
      canonicalHash: 'c'.repeat(64),
      boardRev: 3,
      lifecycleRev: 2,
      generatedAt: '2026-07-14T00:00:00.000Z',
      freshnessAgeSeconds: 0,
      stale: false,
      staleReason: null,
    }
    const env = buildPinnedReadEnvelope(pin, { projects: [], items: [], pageSize: 50 }, {
      method: 'list_projects',
      nextCursor: null,
    })
    expect(env.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    expect(env.method).toBe('list_projects')
    expect(env.boardRev).toBe(3)
    expect(env.lifecycleRev).toBe(2)
    expect(env.nextCursor).toBeNull()
  })
})

describe('P0 MCP public IP keying + canonical envelope wire', () => {
  it('unauth public tool keys by clientIp; different IPs have independent burst buckets', async () => {
    const clock = { nowMs: () => 1_000_000 }
    const limiter = createPublicSnapshotRateLimiter({
      store: createMemoryRateLimitStore(),
      clock,
      policy: { sustainedPerMinute: 60, burst: 2 },
    })
    const svc = createPublicSnapshotService({ rateLimiter: limiter })
    setTestPublicSnapshotService(svc)
    const load = async (): Promise<PublicAggregationInput | null> => null

    // Simulate board-mcp publicSnapshotRateClientKey for unauth: clientKey = clientIp
    const keyA = '10.0.0.1'
    const keyB = '10.0.0.2'
    const rA1 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: keyA, loadAggregation: load })
    const rA2 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: keyA, loadAggregation: load })
    const rA3 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: keyA, loadAggregation: load })
    expect(rA1.ok || (!rA1.ok && rA1.code === 'STALE_OR_MISSING')).toBe(true)
    expect(rA2.ok || (!rA2.ok && rA2.code === 'STALE_OR_MISSING')).toBe(true)
    expect(rA3.ok).toBe(false)
    if (!rA3.ok) expect(rA3.code).toBe('RATE_LIMITED')

    // Different IP still has capacity (independent bucket)
    const rB1 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: keyB, loadAggregation: load })
    expect(rB1.ok || (!rB1.ok && rB1.code === 'STALE_OR_MISSING')).toBe(true)
    if (!rB1.ok) expect(rB1.code).not.toBe('RATE_LIMITED')
  })

  it('tool + resource share unauth IP key (same-IP cross-surface exhaustion)', async () => {
    const clock = { nowMs: () => 2_000_000 }
    const limiter = createPublicSnapshotRateLimiter({
      store: createMemoryRateLimitStore(),
      clock,
      policy: { sustainedPerMinute: 60, burst: 1 },
    })
    const svc = createPublicSnapshotService({ rateLimiter: limiter })
    setTestPublicSnapshotService(svc)
    const load = async (): Promise<PublicAggregationInput | null> => null
    const sharedIp = '198.51.100.77'
    // Both MCP tool and resource use publicSnapshotRateClientKey() → same clientKey for unauth
    const tool = await svc.getPublicSnapshot({
      boardId: BOARD,
      clientKey: sharedIp,
      loadAggregation: load,
    })
    expect(tool.ok || (!tool.ok && tool.code === 'STALE_OR_MISSING')).toBe(true)
    const resource = await svc.getPublicSnapshot({
      boardId: BOARD,
      clientKey: sharedIp,
      loadAggregation: load,
    })
    expect(resource.ok).toBe(false)
    if (!resource.ok) expect(resource.code).toBe('RATE_LIMITED')
  })

  it('spoofed XFF never becomes rate key when clientIp comes from resolvePublicSnapshotClientIp', async () => {
    const { resolvePublicSnapshotClientIp } = await import('#/routes/api.public-snapshot')
    const req = new Request('http://127.0.0.1:3000/mcp', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-forwarded-for': '9.9.9.9',
        'x-real-ip': '8.8.8.8',
      },
    })
    Object.defineProperty(req, 'ip', { value: '10.0.0.7', enumerable: true, configurable: true })
    const clientIp = resolvePublicSnapshotClientIp(req)
    expect(clientIp).toBe('10.0.0.7')
    expect(clientIp).not.toBe('9.9.9.9')
    // Unauth key is raw IP (shared with HTTP public-snapshot:${ip})
    expect(clientIp).toBe('10.0.0.7')
  })

  it('missing clientIp bounds as unknown without collapsing known IPs', async () => {
    const clock = { nowMs: () => 3_000_000 }
    const limiter = createPublicSnapshotRateLimiter({
      store: createMemoryRateLimitStore(),
      clock,
      policy: { sustainedPerMinute: 60, burst: 1 },
    })
    const svc = createPublicSnapshotService({ rateLimiter: limiter })
    setTestPublicSnapshotService(svc)
    const load = async (): Promise<PublicAggregationInput | null> => null
    const unknownKey = 'unknown'
    const knownKey = '203.0.113.10'
    const u1 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: unknownKey, loadAggregation: load })
    const u2 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: unknownKey, loadAggregation: load })
    expect(u1.ok || (!u1.ok && u1.code === 'STALE_OR_MISSING')).toBe(true)
    expect(u2.ok).toBe(false)
    if (!u2.ok) expect(u2.code).toBe('RATE_LIMITED')
    const k1 = await svc.getPublicSnapshot({ boardId: BOARD, clientKey: knownKey, loadAggregation: load })
    expect(k1.ok || (!k1.ok && k1.code === 'STALE_OR_MISSING')).toBe(true)
    if (!k1.ok) expect(k1.code).not.toBe('RATE_LIMITED')
  })

  it('alias envelopes: get_board_hash/get_rollup/get_work/get_priority method+requestedAs+contractVersion', async () => {
    const {
      buildPinnedReadEnvelope,
      MCP_READ_CONTRACT_VERSION,
      TM_PINNED_ENVELOPE_V1,
    } = await import('#/server/mcp-canonical-reads')
    const pin = {
      boardId: BOARD,
      canonicalSnapshotId: 'snap-alias',
      canonicalHash: 'd'.repeat(64),
      boardRev: 5,
      lifecycleRev: 4,
      generatedAt: '2026-07-14T00:00:00.000Z',
      freshnessAgeSeconds: 0,
      stale: false,
      staleReason: null,
    }
    const hashEnv = buildPinnedReadEnvelope(pin, { hash: pin.canonicalHash }, { method: 'get_board_hash' })
    expect(hashEnv.schemaVersion).toBe(TM_PINNED_ENVELOPE_V1)
    expect(hashEnv.method).toBe('get_overview')
    expect(hashEnv.requestedAs).toBe('get_board_hash')
    expect(hashEnv.contractVersion).toBe(MCP_READ_CONTRACT_VERSION)
    expect(hashEnv.canonicalHash).toBe(pin.canonicalHash)

    const rollupEnv = buildPinnedReadEnvelope(pin, { rollup: {} }, { method: 'get_rollup' })
    expect(rollupEnv.method).toBe('get_overview')
    expect(rollupEnv.requestedAs).toBe('get_rollup')
    expect(rollupEnv.contractVersion).toBe(MCP_READ_CONTRACT_VERSION)

    const workEnv = buildPinnedReadEnvelope(
      pin,
      { work: [], items: [], pageSize: 50 },
      { method: 'get_work', nextCursor: null },
    )
    expect(workEnv.method).toBe('list_work_items')
    expect(workEnv.requestedAs).toBe('get_work')

    const prioEnv = buildPinnedReadEnvelope(pin, { priority: null }, { method: 'get_priority' })
    expect(prioEnv.method).toBe('get_priority_portfolio')
    expect(prioEnv.requestedAs).toBe('get_priority')

    const overviewEnv = buildPinnedReadEnvelope(pin, { projects: 0 }, { method: 'get_overview' })
    expect(overviewEnv.method).toBe('get_overview')
    expect(overviewEnv.requestedAs).toBe('get_overview')
    expect(overviewEnv.contractVersion).toBe(MCP_READ_CONTRACT_VERSION)

    const prodEnv = buildPinnedReadEnvelope(pin, { prod: [] }, { method: 'get_prod' })
    expect(prodEnv.method).toBe('get_prod')
    expect(prodEnv.requestedAs).toBe('get_prod')
    const guideEnv = buildPinnedReadEnvelope(pin, { guide: [] }, { method: 'get_guide' })
    expect(guideEnv.method).toBe('get_guide')
    expect(guideEnv.requestedAs).toBe('get_guide')
  })

  it('get_work unknown filter key fail-closed via validateReadFilters', async () => {
    const { validateReadFilters, McpReadContractError } = await import('#/server/mcp-canonical-reads')
    expect(() =>
      validateReadFilters('get_work', { boardId: BOARD, invent: true }),
    ).toThrow(McpReadContractError)
    try {
      validateReadFilters('get_work', { boardId: BOARD, invent: true })
    } catch (e) {
      expect(e).toBeInstanceOf(McpReadContractError)
      expect((e as InstanceType<typeof McpReadContractError>).code).toBe('INVALID_FILTER')
    }
  })

  it('registerBoardTools accepts clientIp on McpAuthContext without throwing', () => {
    const server = new McpServer({ name: 'ip-ctx', version: '0.0.0' })
    registerBoardTools(server, {
      principal: null,
      mechanism: { kind: 'DECISION_AUTH_MECHANISM_REQUIRED', reason: 'test' },
      bearerPresent: false,
      clientIp: '203.0.113.50',
    })
    // Unauth lists only public tools; registration with clientIp must succeed.
    expect(true).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// applyImport → MCP list/get definition parity (canonical sole authority)
// ---------------------------------------------------------------------------

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
}>

function toolHandler(server: McpServer, name: string): ToolHandler {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>
    }
  )._registeredTools
  const entry = tools[name]
  if (!entry?.handler) throw new Error(`tool not registered: ${name}`)
  return entry.handler
}

async function callToolJson(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await toolHandler(server, name)(args)
  const text = result.content?.[0]?.text
  if (typeof text !== 'string') throw new Error(`no text from ${name}`)
  return JSON.parse(text) as Record<string, unknown>
}

async function applyCanonicalFixture(opts?: {
  boardId?: string
  snapshotId?: string
  projects?: Array<Record<string, unknown>>
  features?: Array<Record<string, unknown>>
  tasks?: Array<Record<string, unknown>>
  lifecycleRev?: number
}) {
  const boardId = opts?.boardId ?? BOARD
  const ctx = resolveMcpRuntimeContext()
  const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
  expect(sql).toBeTruthy()
  await seedBoardRevision(sql!, {
    boardId,
    boardRev: 0,
    lifecycleRev: opts?.lifecycleRev ?? 4,
    subjectHash: '',
    canonicalSnapshotId: null,
    canonicalHash: null,
  })
  const before = await ctx.controlData.imports.getBoardState(boardId)
  expect(before).not.toBeNull()
  const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
    boardId,
    {
      projects: opts?.projects ?? [
        { id: 'p-wire', nama: 'Wire Proj', status: 'active' },
      ],
      features: opts?.features ?? [
        { id: 'f-wire', nama: 'Wire Feat', fase: 'build', projectId: 'p-wire' },
      ],
      tasks: opts?.tasks ?? [
        { id: 't-wire-1', title: 'W1', projectId: 'p-wire', featureId: 'f-wire' },
        { id: 't-wire-2', title: 'W2', projectId: 'p-wire', featureId: 'f-wire' },
      ],
    },
    {
      idempotencyKey: `wire-${boardId}-${opts?.snapshotId ?? 'snap'}`,
      snapshotId: opts?.snapshotId ?? `snap-wire-${boardId}`,
    },
  )
  const applied = await applyImport(ctx.controlData.imports, ctx.idempotency, null, {
    auth: {
      actorId: 'root-durable-test',
      scopes: ['import:write'],
      role: 'ROOT_ORCHESTRATOR',
    },
    snapshot,
    entityExpectedRev: before!.entityRev,
    expectedBoardRev: before!.boardRev,
    expectedSubjectHash: before!.subjectHash ?? '',
    idempotencyKey: `wire-${boardId}-${opts?.snapshotId ?? 'snap'}`,
    dryRun: false,
  })
  expect(applied.ok).toBe(true)
  return { ctx, snapshot, applied, boardId, before }
}

describe('applyImport → MCP list/get canonical definition parity', () => {
  it('resolveBoardDefinitionAuthority is canonical after applyImport with pin match', async () => {
    const { applied, boardId, snapshot } = await applyCanonicalFixture()
    const authz = await resolveBoardDefinitionAuthority(boardId)
    expect(authz.mode).toBe('canonical')
    if (authz.mode !== 'canonical') return
    expect(authz.pin.boardRev).toBe(applied.boardRev)
    expect(authz.pin.lifecycleRev).toBe(applied.lifecycleRev)
    expect(authz.pin.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(authz.pin.canonicalHash).toBe(applied.canonicalHash)
    expect(authz.pin.stale).toBe(false)
    expect(authz.definition.projection.distinctTaskIds).toEqual(['t-wire-1', 't-wire-2'])
    expect(authz.definition.projection.distinctProjectIds).toEqual(['p-wire'])
    expect(authz.definition.projection.distinctFlowIds).toEqual(['f-wire'])
  })

  it('list_projects / list_features / list_tasks / get_work return imported ids + matching pin', async () => {
    const { applied, boardId, snapshot } = await applyCanonicalFixture({
      boardId: 'wire-list-parity',
    })
    const server = new McpServer({ name: 'wire-parity', version: '0.0.0' })
    registerBoardTools(server, authRoot())

    const projects = await callToolJson(server, 'list_projects', { boardId })
    expect(projects.ok).not.toBe(false)
    expect(projects.boardRev).toBe(applied.boardRev)
    expect(projects.lifecycleRev).toBe(applied.lifecycleRev)
    expect(projects.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(projects.canonicalHash).toBe(applied.canonicalHash)
    const projectIds = (projects.projects as Array<{ id: string }>).map((p) => p.id)
    expect(projectIds).toContain('p-wire')
    // Envelope pin matches data-bearing model (no dual pin).
    expect(projects.boardRev).toBe(
      (projects.data as { boardRev?: number } | undefined)?.boardRev ?? projects.boardRev,
    )

    const features = await callToolJson(server, 'list_features', { boardId })
    expect(features.canonicalHash).toBe(applied.canonicalHash)
    expect((features.features as Array<{ id: string }>).map((f) => f.id)).toContain('f-wire')

    const tasks = await callToolJson(server, 'list_tasks', { boardId })
    expect(tasks.boardRev).toBe(applied.boardRev)
    expect(tasks.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(tasks.canonicalHash).toBe(applied.canonicalHash)
    const taskIds = (tasks.tasks as Array<{ id: string }>).map((t) => t.id).sort()
    expect(taskIds).toEqual(['t-wire-1', 't-wire-2'])

    const work = await callToolJson(server, 'get_work', { boardId })
    expect(work.boardRev).toBe(applied.boardRev)
    expect(work.canonicalHash).toBe(applied.canonicalHash)
    const workIds = (work.work as Array<{ id: string }>).map((t) => t.id).sort()
    expect(workIds).toEqual(['t-wire-1', 't-wire-2'])

    const overview = await callToolJson(server, 'get_overview', { boardId })
    expect(overview.boardRev).toBe(applied.boardRev)
    expect(overview.canonicalHash).toBe(applied.canonicalHash)
    expect(overview.projects).toBe(1)
    expect(overview.features).toBe(1)
  })

  it('get_project / get_feature / get_task resolve imported entities only', async () => {
    const { boardId, applied } = await applyCanonicalFixture({ boardId: 'wire-get-one' })
    const server = new McpServer({ name: 'wire-get', version: '0.0.0' })
    registerBoardTools(server, authRoot())

    const project = await callToolJson(server, 'get_project', {
      boardId,
      projectId: 'p-wire',
    })
    expect(project.canonicalHash).toBe(applied.canonicalHash)
    expect((project.project as { id: string }).id).toBe('p-wire')

    const feature = await callToolJson(server, 'get_feature', {
      boardId,
      featureId: 'f-wire',
    })
    expect((feature.feature as { id: string }).id).toBe('f-wire')

    const task = await callToolJson(server, 'get_task', { boardId, taskId: 't-wire-1' })
    expect((task.task as { id: string }).id).toBe('t-wire-1')
    // Lifecycle not fabricated when overlay absent
    expect((task.task as { lifecycleStage: string | null }).lifecycleStage).toBeNull()

    const missing = await callToolJson(server, 'get_task', {
      boardId,
      taskId: 'legacy-only-not-in-snapshot',
    })
    expect(missing.ok).toBe(false)
    expect(missing.code).toBe('NOT_FOUND')
  })

  it('SNAPSHOT_MISSING pin-complete fails closed (typed error, no silent legacy)', async () => {
    const boardId = 'wire-orphan-pin'
    const ctx = resolveMcpRuntimeContext()
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql!
    await seedBoardRevision(sql, {
      boardId,
      boardRev: 9,
      lifecycleRev: 2,
      subjectHash: 'e'.repeat(64),
      importEntityRev: 1,
      canonicalSnapshotId: 'snap-missing-wire',
      canonicalHash: 'e'.repeat(64),
    })
    await expect(resolveBoardDefinitionAuthority(boardId)).rejects.toMatchObject({
      code: 'SNAPSHOT_MISSING',
      name: 'CanonicalReadModelError',
    })
    const server = new McpServer({ name: 'wire-orphan', version: '0.0.0' })
    registerBoardTools(server, authRoot())
    const listed = await callToolJson(server, 'list_tasks', { boardId })
    expect(listed.ok).toBe(false)
    expect(listed.code).toBe('SNAPSHOT_MISSING')
  })

  it('no pin → legacy mode marked PIN_AUTHORITY_INCOMPLETE (honest stale)', async () => {
    const boardId = 'wire-no-pin-board'
    // No seedBoardRevision / applyImport
    const authz = await resolveBoardDefinitionAuthority(boardId)
    expect(authz.mode).toBe('legacy')
    if (authz.mode !== 'legacy') return
    expect(authz.authorityIncomplete).toBe(true)
    expect(authz.incompleteCode).toBe('PIN_MISSING')
    expect(authz.pin.stale).toBe(true)
    expect(authz.pin.staleReason).toBe('PIN_AUTHORITY_INCOMPLETE')
  })

  it('lifecycle overlay left-joins stage without inventing missing stages', () => {
    const projection = {
      projects: [{ id: 'p1' }],
      flows: [{ id: 'f1', projectId: 'p1' }],
      nodes: [],
      tasks: [
        { id: 't1', projectId: 'p1', title: 'One', featureContractId: 'f1' },
        { id: 't2', projectId: 'p1', title: 'Two' },
      ],
      dependencies: [],
      featureContractJoins: [{ featureContractId: 'f1', taskId: 't1' }],
      nodeJoins: [],
      primaryOwnerships: [],
      classifications: [],
      anchors: [],
      acceptancePaths: [],
      distinctCounts: {
        projects: 1,
        flows: 1,
        nodes: 0,
        tasks: 2,
        dependencies: 0,
        featureContractJoins: 1,
        nodeJoins: 0,
        classifications: 0,
        anchors: 0,
        acceptancePaths: 0,
        primaryOwnerships: 0,
      },
      distinctTaskIds: ['t1', 't2'],
      distinctProjectIds: ['p1'],
      distinctFlowIds: ['f1'],
    }
    const lifecycleByTaskId = new Map([
      [
        't1',
        {
          id: 't1',
          title: 'One',
          dependencies: [],
          impacts: [],
          checkpoints: [],
          lifecycleStage: 'MAPPED',
          blockedReason: null,
          lastReceiptAt: '2026-07-13T10:00:00.000Z',
        },
      ],
    ])
    const rows = mapCanonicalTasksToListRows(projection as never, {
      pinGeneratedAt: '2026-07-13T12:00:00.000Z',
      cfg: {
        stages: [
          { key: 'MAPPED', label: 'Mapped', readiness: 10 },
          { key: 'BUILT', label: 'Built', readiness: 50 },
        ],
        allowSkip: false,
        allowRegression: true,
        formulaVersion: 'v1',
      },
      lifecycleByTaskId: lifecycleByTaskId as never,
      runsByTask: {},
    })
    expect(rows).toHaveLength(2)
    const t1 = rows.find((r) => r.id === 't1')!
    const t2 = rows.find((r) => r.id === 't2')!
    expect(t1.lifecycleStage).toBe('MAPPED')
    expect(t1.readinessPercent).toBe(10)
    // t2 has no lifecycle row → null stage, readiness 0 (not fabricated)
    expect(t2.lifecycleStage).toBeNull()
    expect(t2.readinessPercent).toBe(0)
    expect(mapCanonicalProjectsToListRows(projection as never, 't').map((p) => p.id)).toEqual([
      'p1',
    ])
    expect(mapCanonicalFlowsToFeatureRows(projection as never, 't').map((f) => f.id)).toEqual([
      'f1',
    ])
    const work = mapCanonicalTasksToWorkRows(projection as never, {
      pinGeneratedAt: 't',
      lifecycleByTaskId: lifecycleByTaskId as never,
    })
    expect(work.map((w) => w.id).sort()).toEqual(['t1', 't2'])
    expect(work.find((w) => w.id === 't2')!.lifecycleStage).toBeNull()
  })

  it('boardPinFromDefinitionPin matches loaded model pin fields exactly', async () => {
    const { applied, boardId, snapshot } = await applyCanonicalFixture({
      boardId: 'wire-pin-fields',
    })
    const model = await loadPinnedDefinitionReadModel(
      resolveMcpRuntimeContext().controlData.imports,
      boardId,
    )
    const pin = boardPinFromDefinitionPin(model.pin, '2026-07-13T00:00:00.000Z')
    expect(pin.boardRev).toBe(model.pin.boardRev)
    expect(pin.lifecycleRev).toBe(model.pin.lifecycleRev)
    expect(pin.canonicalSnapshotId).toBe(model.pin.canonicalSnapshotId)
    expect(pin.canonicalHash).toBe(model.pin.canonicalHash)
    expect(pin.boardRev).toBe(applied.boardRev)
    expect(pin.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(pin.stale).toBe(false)
  })

  it('typedError echoes CanonicalReadModelError codes (fail-closed wire)', () => {
    const err = new CanonicalReadModelError('HASH_MISMATCH', 'pin hash mismatch', {
      pinCanonicalHash: 'a',
    })
    const te = mcpTypedErrorForTests(err)
    expect(te.code).toBe('HASH_MISMATCH')
    expect(te.error).toContain('hash')
  })
})

// ---------------------------------------------------------------------------
// CLOSE: canonical rollup DISTINCT membership + granular mutator dual-authority
// ---------------------------------------------------------------------------

describe('canonical rollup exclusion/inclusion/missing lifecycle matrix', () => {
  it('buildCanonicalRollupTaskInputs excludes legacy-only lifecycle rows', () => {
    const projection = {
      projects: [{ id: 'p1' }],
      flows: [{ id: 'f1', projectId: 'p1' }],
      nodes: [],
      tasks: [
        { id: 't-def-1', title: 'D1', projectId: 'p1' },
        { id: 't-def-2', title: 'D2', projectId: 'p1' },
      ],
      dependencies: [],
      featureContractJoins: [],
      nodeJoins: [],
      primaryOwnerships: [],
      classifications: [],
      anchors: [],
      acceptancePaths: [],
      distinctCounts: {
        projects: 1,
        flows: 1,
        nodes: 0,
        tasks: 2,
        dependencies: 0,
        featureContractJoins: 0,
        nodeJoins: 0,
        classifications: 0,
        anchors: 0,
        acceptancePaths: 0,
        primaryOwnerships: 0,
      },
      distinctTaskIds: ['t-def-1', 't-def-2'],
      distinctProjectIds: ['p1'],
      distinctFlowIds: ['f1'],
    }
    const lifecycleByTaskId = new Map([
      [
        't-def-1',
        {
          id: 't-def-1',
          title: 'D1',
          dependencies: [],
          impacts: [],
          checkpoints: [],
          lifecycleStage: 'MAPPED',
        },
      ],
      // Legacy-only — must NEVER enter rollup inputs
      [
        'legacy-orphan',
        {
          id: 'legacy-orphan',
          title: 'Orphan',
          dependencies: [],
          impacts: [],
          checkpoints: [],
          lifecycleStage: 'BUILT',
        },
      ],
    ])
    const inputs = buildCanonicalRollupTaskInputs(projection as never, {
      lifecycleByTaskId: lifecycleByTaskId as never,
    })
    expect(inputs.map((i) => i.taskId).sort()).toEqual(['t-def-1', 't-def-2'])
    expect(inputs.find((i) => i.taskId === 'legacy-orphan')).toBeUndefined()
    expect(inputs.find((i) => i.taskId === 't-def-1')!.lifecycleStage).toBe('MAPPED')
    // Missing lifecycle → null stage, UNCLASSIFIED classification (honest)
    const t2 = inputs.find((i) => i.taskId === 't-def-2')!
    expect(t2.lifecycleStage).toBeNull()
    expect(t2.classification.taskClass).toBe('UNCLASSIFIED')
    expect(t2.classification.disposition).toBe('UNCLASSIFIED')
    expect(t2.classification.receipt).toBeNull()
  })

  it('missing classification fails honest UNCLASSIFIED → tracked DATA_INTEGRITY in V3 rollup', async () => {
    const { applied, boardId, snapshot } = await applyCanonicalFixture({
      boardId: 'rollup-unclass-board',
    })
    const authz = await resolveBoardDefinitionAuthority(boardId)
    expect(authz.mode).toBe('canonical')
    if (authz.mode !== 'canonical') return
    const pin = boardPinFromDefinitionPin(authz.definition.pin, '2026-07-13T12:00:00.000Z')
    const lifecycleByTaskId = new Map([
      [
        't-wire-1',
        {
          id: 't-wire-1',
          title: 'W1',
          dependencies: [],
          impacts: [],
          checkpoints: [],
          lifecycleStage: 'BUILT',
        },
      ],
    ])
    // No classification store rows → all UNCLASSIFIED
    const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
      lifecycleByTaskId: lifecycleByTaskId as never,
      classificationByTaskId: new Map(),
      now: pin.generatedAt,
    })
    expect(v3.trackedWorkDenominator).toBe(2)
    expect(v3.unclassifiedCount).toBe(2)
    expect(v3.hasP0OrDataIntegrityBlocker).toBe(true)
    expect(v3.buckets.BLOCKED).toBe(2)
    expect(v3.productDenominator).toBe(0)
    // Legacy-shaped summary matches DISTINCT definition count (not lifecycle table size=1)
    const shaped = legacyShapedRollupFromCanonical(
      v3,
      authz.definition.projection,
      lifecycleByTaskId as never,
      {
        stages: [
          { key: 'MAPPED', readiness: 10 },
          { key: 'BUILT', readiness: 45 },
        ],
      },
    )
    expect(shaped.distinctDefinitionTaskCount).toBe(2)
    expect(shaped.active).toBe(2)
    expect(shaped.uninitialized).toBe(1) // t-wire-2 missing stage
    expect((shaped.counts as Record<string, number>).BUILT).toBe(1)
    expect(shaped.unclassifiedCount).toBe(2)
    expect(pin.boardRev).toBe(applied.boardRev)
    expect(pin.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
  })

  it('get_overview / get_rollup pin-complete use DISTINCT definition + buckets, exclude lifecycle orphans', async () => {
    const { applied, boardId } = await applyCanonicalFixture({
      boardId: 'rollup-mcp-overview',
    })
    const server = new McpServer({ name: 'rollup-ov', version: '0.0.0' })
    registerBoardTools(server, authRoot())

    const overview = await callToolJson(server, 'get_overview', { boardId })
    expect(overview.boardRev).toBe(applied.boardRev)
    expect(overview.projects).toBe(1)
    expect(overview.features).toBe(1)
    const rollup = overview.rollup as Record<string, unknown>
    expect(rollup.note).toBe('canonical_definition_distinct_left_join')
    expect(rollup.distinctDefinitionTaskCount).toBe(2)
    expect(rollup.active).toBe(2)
    expect(rollup.unclassifiedCount).toBe(2)
    expect((rollup.buckets as { BLOCKED: number }).BLOCKED).toBe(2)

    const getRollup = await callToolJson(server, 'get_rollup', { boardId })
    expect(getRollup.boardRev).toBe(applied.boardRev)
    const r2 = (getRollup.rollup ?? getRollup) as Record<string, unknown>
    expect(r2.note).toBe('canonical_definition_distinct_left_join')
    expect(r2.distinctDefinitionTaskCount).toBe(2)

    const work = await callToolJson(server, 'get_work', { boardId })
    const workIds = (work.work as Array<{ id: string; bucket?: string | null }>).map((w) => w.id)
    expect(workIds.sort()).toEqual(['t-wire-1', 't-wire-2'])
    // Buckets from V3 assignment (BLOCKED for UNCLASSIFIED), not overlay
    for (const w of work.work as Array<{ bucket?: string | null }>) {
      expect(w.bucket).toBe('BLOCKED')
    }
  })

  it('valid classification receipt can leave UNCLASSIFIED path (inclusion)', async () => {
    const { boardId } = await applyCanonicalFixture({
      boardId: 'rollup-class-include',
    })
    const authz = await resolveBoardDefinitionAuthority(boardId)
    if (authz.mode !== 'canonical') throw new Error('expected canonical')
    const pin = boardPinFromDefinitionPin(authz.definition.pin, '2026-07-13T12:00:00.000Z')
    const receipt = {
      receiptId: 'rcpt-1',
      receiptHash: 'abcdef0123456789abcdef01',
      taskId: 't-wire-1',
      taskClass: 'PRODUCT' as const,
      disposition: 'ACTIVE' as const,
      canonicalSnapshotId: pin.canonicalSnapshotId,
      canonicalHash: pin.canonicalHash,
      taskHash: pin.canonicalHash,
      boardRev: pin.boardRev,
      lifecycleRev: pin.lifecycleRev,
      issuedAt: '2026-07-13T11:00:00.000Z',
    }
    const classificationByTaskId = new Map([
      [
        't-wire-1',
        {
          taskId: 't-wire-1',
          taskClass: 'PRODUCT' as const,
          disposition: 'ACTIVE' as const,
          receipt,
        },
      ],
    ])
    const lifecycleByTaskId = new Map([
      [
        't-wire-1',
        {
          id: 't-wire-1',
          title: 'W1',
          dependencies: [],
          impacts: [],
          checkpoints: [],
          lifecycleStage: 'MAPPED',
        },
      ],
    ])
    const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
      lifecycleByTaskId: lifecycleByTaskId as never,
      classificationByTaskId: classificationByTaskId as never,
      now: pin.generatedAt,
    })
    // t-wire-1 classified PRODUCT → product denom; t-wire-2 still UNCLASSIFIED repair
    expect(v3.unclassifiedCount).toBe(1)
    expect(v3.productDenominator).toBe(1)
    expect(v3.trackedWorkDenominator).toBe(2)
  })
})

describe('granular definition mutator fail-closed / non-consume matrix', () => {
  it('DEFINITION_MUTATOR_TOOL_NAMES is exhaustive for definition graph tools', () => {
    // Every listed tool is a registered write; replace_board_snapshot is intentionally excluded (import CAS).
    for (const name of DEFINITION_MUTATOR_TOOL_NAMES) {
      expect(REGISTERED_WRITE_TOOL_NAMES).toContain(name)
    }
    expect(DEFINITION_MUTATOR_TOOL_NAMES).not.toContain('replace_board_snapshot')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).not.toContain('advance_task')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).not.toContain('publish_dispatch_plan')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('upsert_task')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('delete_task')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('upsert_feature')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('delete_feature')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('upsert_project')
    expect(DEFINITION_MUTATOR_TOOL_NAMES).toContain('delete_project')
  })

  it('pin-complete: every definition mutator rejects CANONICAL_IMPORT_REQUIRED before idempotency consume', async () => {
    const { applied, boardId } = await applyCanonicalFixture({
      boardId: 'mutator-fail-closed',
    })
    const ctx = resolveMcpRuntimeContext()
    const boardBefore = await ctx.atomic.getBoardState(boardId)
    const revBefore = boardBefore.boardRev

    for (const toolName of DEFINITION_MUTATOR_TOOL_NAMES) {
      const idemKey = `mutator-reject-${toolName}`
      await expect(
        assertGranularDefinitionMutationAllowed(toolName, boardId),
      ).rejects.toMatchObject({ code: 'CANONICAL_IMPORT_REQUIRED' })

      // runMutationGate must reject before beginIdempotent (no consume / no rev bump)
      await expect(
        runMutationGate(
          {
            toolName,
            boardId,
            actorId: 'root-durable-test',
            entityType: 'task',
            entityId: 't-wire-1',
            requestBody: {
              entityExpectedRev: 0,
              expectedBoardRev: revBefore,
              canonicalHash: applied.canonicalHash,
              idempotencyKey: idemKey,
            },
            skipPinHashCheck: true,
            skipBoardRevCheck: true,
          },
          async () => {
            throw new Error('mutate must not run')
          },
        ),
      ).rejects.toMatchObject({ code: 'CANONICAL_IMPORT_REQUIRED' })

      // Same key can be retried later (slot never completed as success; reject is pre-begin)
      // Board rev unchanged
      const boardAfter = await ctx.atomic.getBoardState(boardId)
      expect(boardAfter.boardRev).toBe(revBefore)
    }
  })

  it('pin-complete orphan snapshot → DEFINITION_AUTHORITY_STALE (not silent legacy write)', async () => {
    const boardId = 'mutator-stale-pin'
    const ctx = resolveMcpRuntimeContext()
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql!
    await seedBoardRevision(sql, {
      boardId,
      boardRev: 3,
      lifecycleRev: 1,
      subjectHash: 'b'.repeat(64),
      importEntityRev: 1,
      canonicalSnapshotId: 'snap-orphan-mutator',
      canonicalHash: 'b'.repeat(64),
    })
    await expect(
      assertGranularDefinitionMutationAllowed('upsert_task', boardId),
    ).rejects.toMatchObject({ code: 'DEFINITION_AUTHORITY_STALE' })
  })

  it('no-pin path: definition mutators still allowed (legacy compatibility)', async () => {
    // Fresh board id with no import pin
    await expect(
      assertGranularDefinitionMutationAllowed('upsert_task', 'no-pin-legacy-board'),
    ).resolves.toBeUndefined()

    // Non-definition tools never gated
    await expect(
      assertGranularDefinitionMutationAllowed('advance_task', 'no-pin-legacy-board'),
    ).resolves.toBeUndefined()
    await expect(
      assertGranularDefinitionMutationAllowed('replace_board_snapshot', 'no-pin-legacy-board'),
    ).resolves.toBeUndefined()
  })

  it('typedError allowlists CANONICAL_IMPORT_REQUIRED + DEFINITION_AUTHORITY_STALE', () => {
    const a = mcpTypedErrorForTests(
      new McpMutationError('CANONICAL_IMPORT_REQUIRED', 'use import', { toolName: 'upsert_task' }),
    )
    expect(a.code).toBe('CANONICAL_IMPORT_REQUIRED')
    const b = mcpTypedErrorForTests(
      new McpMutationError('DEFINITION_AUTHORITY_STALE', 'stale pin', {}),
    )
    expect(b.code).toBe('DEFINITION_AUTHORITY_STALE')
  })

  it('unclassifiedClassificationForTask is pure fail-closed seed', () => {
    expect(unclassifiedClassificationForTask('t-x')).toEqual({
      taskId: 't-x',
      taskClass: 'UNCLASSIFIED',
      disposition: 'UNCLASSIFIED',
      receipt: null,
    })
  })
})
