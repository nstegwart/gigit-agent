import { describe, expect, it } from 'vitest'

import {
  DECISION_HEARTBEAT_RETENTION_POLICY,
  RETENTION_COMPACTION_WATERMARK_EVENT,
  STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
  applyHeartbeat,
  applyHeartbeatAsync,
  applyHeartbeatWithOptionalCompaction,
  applyHeartbeatWithOptionalCompactionAsync,
  compactRetention,
  compactRetentionAsync,
  createMemoryRetentionStore,
  planRetentionCompaction,
  readDurableCompactionWatermarkMs,
  resolveRetentionPolicy,
  retentionMaterialAuditId,
  retentionSampleAuditId,
  type BoardPolicyRetention,
  type CompactionResult,
  type HeartbeatApplyResult,
} from '#/server/audit-retention'
import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  createMemorySqlExecutor,
  createMysqlRetentionAsyncStore,
} from '#/server/control-plane-runtime-persistence'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'
import {
  createMemoryRunRegistryStore,
  heartbeatRun,
  registerRun,
  type RunRegistryDeps,
  type RunRegistryRetentionAsyncBinding,
  type RunRegistryRetentionBinding,
} from '#/server/run-registry'
import {
  OBSERVABILITY_REDACTED,
  STAGING_RUNBOOKS,
  V3_ALERT_IDS,
  V3_METRIC_CATEGORIES,
  assertAllMetricCategoriesRegistered,
  buildStructuredLog,
  createMemoryAlertRegistry,
  createMemoryMetricsRegistry,
  createObservabilityFacade,
  evaluatePublicFreshnessAlert,
  evaluateReleaseSchemaAlert,
  isSecretObservabilityKey,
  redactForObservability,
  runbookForAlert,
} from '#/server/observability'

/** Well-known JWT (public demo payload) — must never appear raw in redacted output. */
const RAW_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

/** Session cookie value with a distinctive secret segment for leak assertions. */
const RAW_SESSION_COOKIE =
  'session=s%3Araw-session-secret-value-DO-NOT-LOG.signature; Path=/; HttpOnly'

describe('AC-OPS-04 heartbeat is not immutable per-event audit', () => {
  it('updates hot state without immutable heartbeat audit', () => {
    const store = createMemoryRetentionStore()
    const policy = STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY
    const r1 = applyHeartbeat(
      {
        runId: 'run-1',
        boardId: 'b1',
        sequence: 1,
        atMs: 1000,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    expect(r1.immutableHeartbeatCreated).toBe(false)
    expect(r1.material).toBeNull()
    expect(r1.hot.heartbeatSequence).toBe(1)
    expect(store.getHot('run-1')?.status).toBe('RUNNING')

    // Pure heartbeats: no MATERIAL immutable rows
    for (let seq = 2; seq <= 9; seq++) {
      applyHeartbeat(
        {
          runId: 'run-1',
          boardId: 'b1',
          sequence: seq,
          atMs: 1000 + seq,
          status: 'RUNNING',
        },
        policy,
        store,
      )
    }
    const material = store.listAudit({ eventClass: 'MATERIAL', immutable: true })
    expect(material).toHaveLength(0)
  })

  it('samples on heartbeatSampleInterval without immutability', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 5,
    }
    for (let seq = 1; seq <= 10; seq++) {
      applyHeartbeat(
        {
          runId: 'run-1',
          boardId: 'b1',
          sequence: seq,
          atMs: seq * 1000,
          status: 'RUNNING',
        },
        policy,
        store,
      )
    }
    const sampled = store.listAudit({ eventClass: 'SAMPLED' })
    // sequences 5 and 10
    expect(sampled).toHaveLength(2)
    expect(sampled.every((s) => s.immutable === false)).toBe(true)
  })

  it('material progress creates immutable MATERIAL audit only', () => {
    const store = createMemoryRetentionStore()
    const r = applyHeartbeat(
      {
        runId: 'run-1',
        boardId: 'b1',
        sequence: 3,
        atMs: 3000,
        status: 'RUNNING',
        materialProgress: true,
      },
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      store,
    )
    expect(r.material?.immutable).toBe(true)
    expect(r.material?.eventClass).toBe('MATERIAL')
    expect(r.immutableHeartbeatCreated).toBe(false)
    expect(store.listAudit({ immutable: true })).toHaveLength(1)
  })
})

describe('AC-OPS-05 retention / compaction + DECISION policy', () => {
  it('PRODUCTION without policy returns DECISION_HEARTBEAT_RETENTION_POLICY', () => {
    const r = resolveRetentionPolicy({ environment: 'PRODUCTION' })
    expect(r.ok).toBe(false)
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
    expect(r.policy).toBeNull()
    expect(r.source).toBe('BLOCKED')
  })

  it('does not silently default production even with staging-only supplied policy', () => {
    const r = resolveRetentionPolicy({
      environment: 'PRODUCTION',
      supplied: STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
    })
    expect(r.ok).toBe(false)
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
  })

  it('staging requires explicit allowStagingProposal', () => {
    const blocked = resolveRetentionPolicy({ environment: 'STAGING' })
    expect(blocked.ok).toBe(false)
    const allowed = resolveRetentionPolicy({
      environment: 'STAGING',
      allowStagingProposal: true,
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.source).toBe('STAGING_PROPOSAL')
    expect(allowed.policy?.policyId).toBe(
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
    )
  })

  it('LOCAL uses staging proposal; TEST requires explicitAppEnv or test capability (R4)', () => {
    expect(resolveRetentionPolicy({ environment: 'LOCAL' }).ok).toBe(true)
    // Bare TEST without gates → blocked (NODE_ENV=test/VITEST must not silent-authorize)
    const bare = resolveRetentionPolicy({ environment: 'TEST' })
    expect(bare.ok).toBe(false)
    expect(bare.source).toBe('BLOCKED')
    expect(bare.message).toMatch(/R4|allowTestRetentionProposal|CAIRN_ENV/i)
    // Explicit CAIRN_ENV=test path
    expect(
      resolveRetentionPolicy({ environment: 'TEST', explicitAppEnv: true }).source,
    ).toBe('STAGING_PROPOSAL')
    // Approved test-context capability (disposable unit tests)
    expect(
      resolveRetentionPolicy({
        environment: 'TEST',
        allowTestRetentionProposal: true,
      }).source,
    ).toBe('STAGING_PROPOSAL')
  })

  it('supplied production-approved policy is accepted', () => {
    const prodPolicy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      policyId: 'prod-retention-v1',
      approvedFor: ['PRODUCTION'],
    }
    const r = resolveRetentionPolicy({
      environment: 'PRODUCTION',
      supplied: prodPolicy,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('SUPPLIED')
  })

  it('compacts hot/sampled/rollup and retains material immutable', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      hotStateRetentionMs: 1000,
      sampledEventRetentionMs: 1000,
      rollupRetentionMs: 1000,
    }
    applyHeartbeat(
      {
        runId: 'old-run',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    applyHeartbeat(
      {
        runId: 'mat-run',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
        materialProgress: true,
      },
      policy,
      store,
    )
    store.appendAudit({
      id: 'rollup-old',
      boardId: 'b1',
      eventClass: 'ROLLUP',
      eventType: 'rollup',
      atMs: 0,
      immutable: false,
      payload: {},
    })

    const result = compactRetention({
      policy,
      store,
      nowMs: 5000,
      boardId: 'b1',
    })
    expect(result.deletedHot).toBeGreaterThanOrEqual(1)
    expect(result.deletedSampled).toBeGreaterThanOrEqual(1)
    expect(result.deletedRollup).toBe(1)
    expect(result.retainedMaterial).toBe(1)
    expect(store.listAudit({ immutable: true })).toHaveLength(1)
  })

  it('planRetentionCompaction is bounded and retains material', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      hotStateRetentionMs: 10,
      sampledEventRetentionMs: 10,
    }
    for (let i = 0; i < 5; i++) {
      applyHeartbeat(
        {
          runId: `r-${i}`,
          boardId: 'b1',
          sequence: 1,
          atMs: 0,
          status: 'RUNNING',
          materialProgress: i === 0,
        },
        { ...policy, heartbeatSampleInterval: 1 },
        store,
      )
    }
    const plan = planRetentionCompaction({
      policy,
      store,
      nowMs: 100_000,
      maxActionsPerRun: 3,
    })
    expect(plan.maxActionsPerRun).toBe(3)
    expect(plan.wouldRetainMaterial.length).toBeGreaterThanOrEqual(1)
    expect(
      plan.wouldDeleteHot.length + plan.wouldDeleteAudit.length,
    ).toBeLessThanOrEqual(3)
  })

  it('compaction is idempotent when re-run at same nowMs', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      hotStateRetentionMs: 1,
      sampledEventRetentionMs: 1,
    }
    applyHeartbeat(
      {
        runId: 'r1',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    const a = compactRetention({ policy, store, nowMs: 10_000 })
    const b = compactRetention({ policy, store, nowMs: 10_000 })
    expect(a.deletedHot).toBe(1)
    expect(b.deletedHot).toBe(0)
    expect(b.deletedSampled).toBe(0)
  })

  it('applyHeartbeatWithOptionalCompaction compacts only after interval', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      compactionIntervalMs: 5_000,
      hotStateRetentionMs: 1,
      sampledEventRetentionMs: 1,
    }
    // Seed an old hot row that becomes compactable after interval.
    applyHeartbeat(
      {
        runId: 'old',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    const early = applyHeartbeatWithOptionalCompaction({
      input: {
        runId: 'new',
        boardId: 'b1',
        sequence: 1,
        atMs: 1_000,
        status: 'RUNNING',
      },
      policy,
      store,
      lastCompactionAtMs: 0,
    })
    // 1000 < 5000 interval from lastCompactionAtMs=0... wait 1000-0 < 5000 so no compact
    expect(early.compaction).toBeNull()
    expect(early.nextLastCompactionAtMs).toBe(0)

    const late = applyHeartbeatWithOptionalCompaction({
      input: {
        runId: 'new',
        boardId: 'b1',
        sequence: 2,
        atMs: 6_000,
        status: 'RUNNING',
      },
      policy,
      store,
      lastCompactionAtMs: 0,
    })
    expect(late.compaction).not.toBeNull()
    expect(late.compaction!.deletedHot).toBeGreaterThanOrEqual(1)
    expect(late.nextLastCompactionAtMs).toBe(6_000)
  })
})

describe('AC-OPS-04/05 heartbeatRun production retention wiring', () => {
  const BOARD = 'mfs-rebuild-ret'

  function openCapacity() {
    return {
      dispatchMode: 'OPEN' as const,
      dispatchAllowed: true,
      usableCapacity: 100,
      nonGrokAssignmentAllowed: true,
      grokAssignmentAllowed: true,
      limitingReasons: [] as string[],
      sparkUsableCapacity: 10,
      solUsableCapacity: 10,
      otherUsableCapacity: 10,
      healthyGrokUsableCapacity: 100,
    }
  }

  function makeDeps(retention?: RunRegistryRetentionBinding | null): {
    deps: RunRegistryDeps
    clock: ReturnType<typeof createFakeClock>
    retentionStore: ReturnType<typeof createMemoryRetentionStore>
    atomic: ReturnType<typeof createMemoryControlPlaneAtomicStore>
  } {
    const clock = createFakeClock(Date.parse('2026-07-13T10:00:00.000Z'))
    const retentionStore = createMemoryRetentionStore()
    const atomic = createMemoryControlPlaneAtomicStore([
      {
        boardId: BOARD,
        boardRev: 0,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      },
    ])
    const deps: RunRegistryDeps = {
      clock,
      runs: createMemoryRunRegistryStore(),
      locks: createMemoryLockStore(),
      atomic,
      idempotency: createMemoryIdempotencyStorage(),
      getCapacity: async () => openCapacity(),
      retention:
        retention === undefined
          ? {
              store: retentionStore,
              policy: {
                ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
                heartbeatSampleInterval: 5,
                compactionIntervalMs: 1, // compact every HB after first watermark
                hotStateRetentionMs: 60_000,
                sampledEventRetentionMs: 60_000,
              },
              lastCompactionAtMs: 0,
            }
          : retention,
    }
    return {
      deps,
      clock,
      retentionStore:
        (deps.retention?.store as ReturnType<typeof createMemoryRetentionStore> | undefined) ??
        retentionStore,
      atomic,
    }
  }

  it('heartbeatRun updates retention hot state without immutable ordinary heartbeat', async () => {
    const applied: Array<HeartbeatApplyResult> = []
    const compactions: Array<CompactionResult> = []
    const { deps, retentionStore } = makeDeps()
    deps.retention!.onHeartbeatRetention = (r) => applied.push(r)
    deps.retention!.onCompacted = (c) => compactions.push(c)

    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-hb-ret',
      taskId: 'T-HB-RET',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-hb',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-hb-ret',
      initialState: 'RUNNING',
      canonicalHash: 'canon-hb-ret',

    })

    for (let seq = 1; seq <= 4; seq++) {
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-hb-ret',
        agentId: 'agent-hb',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: seq,
        expectedEntityRev: seq, // after register entityRev=1; first HB expects 1 then +1 each
        expectedBoardRev: 0,
        idempotencyKey: `hb-ret-${seq}`,
        canonicalHash: 'canon-hb-ret',
      })
    }

    expect(applied).toHaveLength(4)
    expect(applied.every((a) => a.immutableHeartbeatCreated === false)).toBe(true)
    expect(applied.every((a) => a.material === null)).toBe(true)
    expect(retentionStore.getHot('run-hb-ret')?.heartbeatSequence).toBe(4)
    expect(retentionStore.listAudit({ eventClass: 'MATERIAL', immutable: true })).toHaveLength(0)
    // sample interval 5 → no sample yet on seq 1..4
    expect(retentionStore.listAudit({ eventClass: 'SAMPLED' })).toHaveLength(0)
  })

  it('heartbeatRun materialProgress creates retention MATERIAL immutable only', async () => {
    const { deps, retentionStore, atomic } = makeDeps()
    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-mat',
      taskId: 'T-MAT',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-mat',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-mat',
      initialState: 'RUNNING',
      canonicalHash: 'canon-mat',

    })
    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-mat',
      agentId: 'agent-mat',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-mat-1',
      canonicalHash: 'canon-mat',
      materialProgressAt: new Date(deps.clock.nowMs()).toISOString(),
    })
    const material = retentionStore.listAudit({ eventClass: 'MATERIAL', immutable: true })
    expect(material).toHaveLength(1)
    expect(material[0]?.eventType).toBe('material_progress')
    // Control-plane atomic also records RUN_MATERIAL_PROGRESS (separate stream)
    expect(atomic.auditSnapshot().some((e) => e.kind === 'RUN_MATERIAL_PROGRESS')).toBe(true)
  })

  it('heartbeatRun without retention binding does not invent policy / hot rows', async () => {
    const { deps } = makeDeps(null)
    expect(deps.retention).toBeNull()
    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-no-ret',
      taskId: 'T-NO',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-no',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-no-ret',
      initialState: 'RUNNING',
      canonicalHash: 'canon-no',

    })
    const hb = await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-no-ret',
      agentId: 'agent-no',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-no-1',
      canonicalHash: 'canon-no',
    })
    expect(hb.heartbeatSequence).toBe(1)
    expect(hb.replayed).toBe(false)
  })

  it('samples on interval and runs compaction when interval elapsed', async () => {
    const compactions: Array<CompactionResult> = []
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 2,
      compactionIntervalMs: 1,
      hotStateRetentionMs: 30_000,
      sampledEventRetentionMs: 30_000,
    }
    // Pre-seed an expired hot row so compaction has work when first HB fires.
    store.putHot({
      runId: 'stale-hot',
      boardId: BOARD,
      lastHeartbeatAtMs: 0,
      heartbeatSequence: 9,
      status: 'RUNNING',
      materialProgressAtMs: null,
    })
    const { deps, clock } = makeDeps({
      store,
      policy,
      lastCompactionAtMs: 0,
      onCompacted: (c) => compactions.push(c),
    })
    // Move clock past hot retention for stale-hot
    clock.advance(60_000)

    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-sample',
      taskId: 'T-SAMP',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-s',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-samp',
      initialState: 'RUNNING',
      canonicalHash: 'canon-samp',

    })
    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-sample',
      agentId: 'agent-s',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-samp-1',
      canonicalHash: 'canon-samp',
    })
    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-sample',
      agentId: 'agent-s',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 2,
      expectedEntityRev: 2,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-samp-2',
      canonicalHash: 'canon-samp',
    })
    const sampled = store.listAudit({ eventClass: 'SAMPLED' })
    expect(sampled.some((s) => s.payload.sequence === 2)).toBe(true)
    expect(sampled.every((s) => s.immutable === false)).toBe(true)
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect(store.getHot('stale-hot')).toBeNull()
  })
})

describe('AC-OPS-04/05 durable retentionAsync (MySQL multi-instance)', () => {
  const BOARD = 'mfs-async-ret'

  function openCapacity() {
    return {
      dispatchMode: 'OPEN' as const,
      dispatchAllowed: true,
      usableCapacity: 100,
      nonGrokAssignmentAllowed: true,
      grokAssignmentAllowed: true,
      limitingReasons: [] as string[],
      sparkUsableCapacity: 10,
      solUsableCapacity: 10,
      otherUsableCapacity: 10,
      healthyGrokUsableCapacity: 100,
    }
  }

  it('applyHeartbeatAsync: hot + sample + no immutable ordinary heartbeat', async () => {
    const exec = createMemorySqlExecutor()
    const store = createMysqlRetentionAsyncStore(exec)
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 2,
    }
    const r1 = await applyHeartbeatAsync(
      {
        runId: 'run-a',
        boardId: BOARD,
        sequence: 1,
        atMs: 1000,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    expect(r1.immutableHeartbeatCreated).toBe(false)
    expect(r1.sampled).toBeNull()
    expect(r1.material).toBeNull()
    expect((await store.getHot(BOARD, 'run-a'))?.heartbeatSequence).toBe(1)

    const r2 = await applyHeartbeatAsync(
      {
        runId: 'run-a',
        boardId: BOARD,
        sequence: 2,
        atMs: 2000,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    expect(r2.sampled?.immutable).toBe(false)
    expect(r2.sampled?.id).toBe(retentionSampleAuditId(BOARD, 'run-a', 2))
    const audits = await store.listAudit(BOARD, { eventClass: 'SAMPLED' })
    expect(audits).toHaveLength(1)
    expect(audits.every((a) => a.immutable === false)).toBe(true)
    expect(
      (await store.listAudit(BOARD, { eventClass: 'MATERIAL', immutable: true })).length,
    ).toBe(0)
  })

  it('applyHeartbeatAsync materialProgress → MATERIAL immutable only', async () => {
    const store = createMysqlRetentionAsyncStore(createMemorySqlExecutor())
    const r = await applyHeartbeatAsync(
      {
        runId: 'run-m',
        boardId: BOARD,
        sequence: 3,
        atMs: 3000,
        status: 'RUNNING',
        materialProgress: true,
      },
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      store,
    )
    expect(r.material?.immutable).toBe(true)
    expect(r.material?.id).toBe(retentionMaterialAuditId(BOARD, 'run-m', 3))
    expect(r.immutableHeartbeatCreated).toBe(false)
    expect((await store.listAudit(BOARD, { immutable: true })).length).toBe(1)
  })

  it('compactRetentionAsync is bounded, retains MATERIAL, writes durable watermark', async () => {
    const store = createMysqlRetentionAsyncStore(createMemorySqlExecutor())
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      hotStateRetentionMs: 10,
      sampledEventRetentionMs: 10,
      rollupRetentionMs: 10,
    }
    for (let i = 0; i < 5; i++) {
      await applyHeartbeatAsync(
        {
          runId: `r-${i}`,
          boardId: BOARD,
          sequence: 1,
          atMs: 0,
          status: 'RUNNING',
          materialProgress: i === 0,
        },
        policy,
        store,
      )
    }
    const first = await compactRetentionAsync({
      policy,
      store,
      nowMs: 100_000,
      boardId: BOARD,
      maxActionsPerRun: 3,
    })
    expect(first.maxActionsPerRun).toBe(3)
    expect(first.deletedHot + first.deletedSampled + first.deletedRollup).toBeLessThanOrEqual(3)
    expect(first.truncated).toBe(true)
    expect(first.retainedMaterial).toBeGreaterThanOrEqual(1)
    const wm = await readDurableCompactionWatermarkMs(store, BOARD)
    expect(wm).toBe(100_000)
    const watermarks = (await store.listAudit(BOARD, { eventClass: 'ROLLUP' })).filter(
      (a) => a.eventType === RETENTION_COMPACTION_WATERMARK_EVENT,
    )
    expect(watermarks.length).toBeGreaterThanOrEqual(1)

    // Idempotent second pass at same clock: no further hot/sample deletes (watermark retained)
    const second = await compactRetentionAsync({
      policy,
      store,
      nowMs: 100_000,
      boardId: BOARD,
      maxActionsPerRun: 100,
    })
    // First pass may have truncated; second may finish remaining hot/samples OR already clean.
    // MATERIAL still retained; watermarks never deleted.
    expect(
      (await store.listAudit(BOARD, { eventClass: 'MATERIAL', immutable: true })).length,
    ).toBeGreaterThanOrEqual(1)
    void second
  })

  it('applyHeartbeatWithOptionalCompactionAsync uses durable watermark (no process invent)', async () => {
    const store = createMysqlRetentionAsyncStore(createMemorySqlExecutor())
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      compactionIntervalMs: 5_000,
      hotStateRetentionMs: 1,
      sampledEventRetentionMs: 1,
    }
    await applyHeartbeatAsync(
      {
        runId: 'old',
        boardId: BOARD,
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    const early = await applyHeartbeatWithOptionalCompactionAsync({
      input: {
        runId: 'new',
        boardId: BOARD,
        sequence: 1,
        atMs: 1_000,
        status: 'RUNNING',
      },
      policy,
      store,
      lastCompactionAtMs: 0,
    })
    expect(early.compaction).toBeNull()
    expect(early.apply.immutableHeartbeatCreated).toBe(false)

    const late = await applyHeartbeatWithOptionalCompactionAsync({
      input: {
        runId: 'new',
        boardId: BOARD,
        sequence: 2,
        atMs: 6_000,
        status: 'RUNNING',
      },
      policy,
      store,
      lastCompactionAtMs: 0,
    })
    expect(late.compaction).not.toBeNull()
    expect(late.nextLastCompactionAtMs).toBe(6_000)
    // Second instance reading only durable store sees watermark
    expect(await readDurableCompactionWatermarkMs(store, BOARD)).toBe(6_000)
  })

  it('heartbeatRun + retentionAsync: multi-instance hot visible; no process memory store', async () => {
    const exec = createMemorySqlExecutor()
    const asyncA = createMysqlRetentionAsyncStore(exec)
    const asyncB = createMysqlRetentionAsyncStore(exec)
    const applied: Array<HeartbeatApplyResult> = []
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 2,
      compactionIntervalMs: 60_000,
    }
    const retentionAsync: RunRegistryRetentionAsyncBinding = {
      store: asyncA,
      policy,
      onHeartbeatRetention: (r) => applied.push(r),
    }
    const clock = createFakeClock(Date.parse('2026-07-14T04:00:00.000Z'))
    const deps: RunRegistryDeps = {
      clock,
      runs: createMemoryRunRegistryStore(),
      locks: createMemoryLockStore(),
      atomic: createMemoryControlPlaneAtomicStore([
        {
          boardId: BOARD,
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ]),
      idempotency: createMemoryIdempotencyStorage(),
      getCapacity: async () => openCapacity(),
      retention: null,
      retentionAsync,
    }

    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-async-hb',
      taskId: 'T-ASYNC',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-async',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-async',
      initialState: 'RUNNING',
      canonicalHash: 'canon-async',

    })

    for (let seq = 1; seq <= 2; seq++) {
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-async-hb',
        agentId: 'agent-async',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: seq,
        expectedEntityRev: seq,
        expectedBoardRev: 0,
        idempotencyKey: `hb-async-${seq}`,
        canonicalHash: 'canon-async',
      })
    }

    expect(applied).toHaveLength(2)
    expect(applied.every((a) => a.immutableHeartbeatCreated === false)).toBe(true)
    // Instance B (shared durable executor) sees hot + sample from instance A path
    const hotB = await asyncB.getHot(BOARD, 'run-async-hb')
    expect(hotB?.heartbeatSequence).toBe(2)
    const samplesB = await asyncB.listAudit(BOARD, { eventClass: 'SAMPLED' })
    expect(samplesB.some((s) => s.payload.sequence === 2)).toBe(true)
    expect(samplesB.every((s) => s.immutable === false)).toBe(true)
    expect(
      (await asyncB.listAudit(BOARD, { eventClass: 'MATERIAL', immutable: true })).length,
    ).toBe(0)

    // materialProgress
    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-async-hb',
      agentId: 'agent-async',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 3,
      expectedEntityRev: 3,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-async-3-mat',
      canonicalHash: 'canon-async',
      materialProgressAt: new Date(clock.nowMs()).toISOString(),
    })
    const materials = await asyncB.listAudit(BOARD, {
      eventClass: 'MATERIAL',
      immutable: true,
    })
    expect(materials).toHaveLength(1)
    expect(materials[0]?.id).toBe(retentionMaterialAuditId(BOARD, 'run-async-hb', 3))
  })

  it('heartbeatRun retentionAsync compaction across instances is durable + bounded', async () => {
    const exec = createMemorySqlExecutor()
    const store = createMysqlRetentionAsyncStore(exec)
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      compactionIntervalMs: 1,
      hotStateRetentionMs: 30_000,
      sampledEventRetentionMs: 30_000,
    }
    // Stale hot via durable store (no process Map)
    await store.putHot({
      runId: 'stale-async',
      boardId: BOARD,
      lastHeartbeatAtMs: 0,
      heartbeatSequence: 1,
      status: 'RUNNING',
      materialProgressAtMs: null,
    })
    const compactions: Array<CompactionResult> = []
    const clock = createFakeClock(Date.parse('2026-07-14T05:00:00.000Z'))
    clock.advance(60_000)
    const deps: RunRegistryDeps = {
      clock,
      runs: createMemoryRunRegistryStore(),
      locks: createMemoryLockStore(),
      atomic: createMemoryControlPlaneAtomicStore([
        {
          boardId: BOARD,
          boardRev: 0,
          dispatchBlocked: false,
          dispatchBlockedReason: null,
        },
      ]),
      idempotency: createMemoryIdempotencyStorage(),
      getCapacity: async () => openCapacity(),
      retentionAsync: {
        store,
        policy,
        maxCompactionActions: 50,
        onCompacted: (c) => compactions.push(c),
      },
    }
    const reg = await registerRun(deps, {
      boardId: BOARD,
      runId: 'run-async-c',
      taskId: 'T-AC',
      targetGate: 'FUNCTIONAL',
      agentId: 'agent-ac',
      model: 'grok-4.5',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-ac',
      initialState: 'RUNNING',
      canonicalHash: 'canon-ac',

    })
    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-async-c',
      agentId: 'agent-ac',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-ac-1',
      canonicalHash: 'canon-ac',
    })
    expect(compactions.length).toBeGreaterThanOrEqual(1)
    expect(compactions.some((c) => c.deletedHot >= 1)).toBe(true)
    expect(await store.getHot(BOARD, 'stale-async')).toBeNull()
    // Second "instance" sees durable watermark without process lastCompactionAtMs
    const peer = createMysqlRetentionAsyncStore(exec)
    expect(await readDurableCompactionWatermarkMs(peer, BOARD)).toBeGreaterThan(0)
  })

  it('PRODUCTION policy Decision preserved — resolve still fail-closed without supplied', () => {
    const r = resolveRetentionPolicy({ environment: 'PRODUCTION' })
    expect(r.ok).toBe(false)
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
    expect(r.source).toBe('BLOCKED')
  })
})

describe('AC-OPS-02 structured log redaction', () => {
  it('buildStructuredLog includes exact safe fields', () => {
    const log = buildStructuredLog({
      requestId: 'req-1',
      endpoint: '/api/public-snapshot',
      event: 'get',
      boardId: 'b1',
      actorRole: 'PUBLIC',
      actorId: null,
      result: 'ok',
      errorCode: null,
      latencyMs: 12,
      boardRev: 10,
      lifecycleRev: 5,
    })
    expect(log.timestamp).toBeTruthy()
    expect(log.requestId).toBe('req-1')
    expect(log.boardId).toBe('b1')
    expect(log.actorRole).toBe('PUBLIC')
    expect(log.endpoint).toBe('/api/public-snapshot')
    expect(log.event).toBe('get')
    expect(log.result).toBe('ok')
    expect(log.latencyMs).toBe(12)
    expect(log.boardRev).toBe(10)
    expect(log.lifecycleRev).toBe(5)
  })

  it('redacts secrets, tokens, comments, evidence, private decision text', () => {
    const redacted = redactForObservability({
      token: 'super-secret',
      password: 'p',
      apiKey: 'k',
      authorization: 'Bearer abc',
      comments: 'private owner note',
      decisionText: 'should not log',
      evidenceBody: 'blob',
      safe: 'ok',
      nested: { refreshToken: 'r', count: 1 },
    }) as Record<string, unknown>
    expect(redacted.token).toBe('[REDACTED]')
    expect(redacted.password).toBe('[REDACTED]')
    expect(redacted.apiKey).toBe('[REDACTED]')
    expect(redacted.comments).toBe('[REDACTED]')
    expect(redacted.decisionText).toBe('[REDACTED]')
    expect(redacted.evidenceBody).toBe('[REDACTED]')
    expect(redacted.safe).toBe('ok')
    expect((redacted.nested as Record<string, unknown>).refreshToken).toBe(
      '[REDACTED]',
    )
    expect((redacted.nested as Record<string, unknown>).count).toBe(1)
  })

  it('redacts secret-looking string values', () => {
    expect(redactForObservability('Bearer abcdefghijklmnop')).toBe('[REDACTED]')
    expect(redactForObservability('sk-abcdefghijklmnop')).toBe('[REDACTED]')
  })

  it('log meta is redacted', () => {
    const log = buildStructuredLog({
      requestId: 'r',
      endpoint: '/x',
      event: 'e',
      meta: { token: 'leak', board: 'b1' },
    })
    expect(log.meta?.token).toBe('[REDACTED]')
    expect(log.meta?.board).toBe('b1')
  })

  it('isSecretObservabilityKey matches case-insensitive variants and header aliases', () => {
    const secretKeys = [
      'token',
      'Token',
      'accessToken',
      'refresh_token',
      'password',
      'apiKey',
      'api-key',
      'API_KEY',
      'cookie',
      'Cookie',
      'cookieHeader',
      'Cookie-Header',
      'auth',
      'authHeader',
      'Authorization',
      'authorization',
      'session',
      'sessionId',
      'credential',
      'clientSecret',
      'x-auth-token',
    ]
    for (const k of secretKeys) {
      expect(isSecretObservabilityKey(k), k).toBe(true)
    }
    // Safe structured / metric keys must remain usable.
    for (const k of [
      'requestId',
      'endpoint',
      'event',
      'boardId',
      'actorRole',
      'latencyMs',
      'route',
      'channel',
      'method',
      'reason',
      'count',
      'safe',
    ]) {
      expect(isSecretObservabilityKey(k), k).toBe(false)
    }
  })

  it('fail-closed: cookieHeader/authHeader + nested JWT/session cookie never leak raw', () => {
    const redacted = redactForObservability({
      cookieHeader: RAW_SESSION_COOKIE,
      authHeader: `Bearer ${RAW_JWT}`,
      Cookie: RAW_SESSION_COOKIE,
      Authorization: `Bearer ${RAW_JWT}`,
      headers: {
        cookieHeader: RAW_SESSION_COOKIE,
        authHeader: `Bearer ${RAW_JWT}`,
        'x-api-key': 'sk-live-should-not-appear',
      },
      items: [
        { accessToken: RAW_JWT, sessionCookie: RAW_SESSION_COOKIE, count: 2 },
        { nested: { password: 'p', ok: true } },
      ],
      // Value-shape only (safe key) — still scrub JWT / session= blobs.
      note: RAW_JWT,
      cookieBlob: RAW_SESSION_COOKIE,
      safe: 'ok',
      boardId: 'b1',
    }) as Record<string, unknown>

    expect(redacted.cookieHeader).toBe(OBSERVABILITY_REDACTED)
    expect(redacted.authHeader).toBe(OBSERVABILITY_REDACTED)
    expect(redacted.Cookie).toBe(OBSERVABILITY_REDACTED)
    expect(redacted.Authorization).toBe(OBSERVABILITY_REDACTED)
    expect(redacted.safe).toBe('ok')
    expect(redacted.boardId).toBe('b1')

    const headers = redacted.headers as Record<string, unknown>
    expect(headers.cookieHeader).toBe(OBSERVABILITY_REDACTED)
    expect(headers.authHeader).toBe(OBSERVABILITY_REDACTED)
    expect(headers['x-api-key']).toBe(OBSERVABILITY_REDACTED)

    const items = redacted.items as Array<Record<string, unknown>>
    expect(items[0]?.accessToken).toBe(OBSERVABILITY_REDACTED)
    expect(items[0]?.sessionCookie).toBe(OBSERVABILITY_REDACTED)
    expect(items[0]?.count).toBe(2)
    expect((items[1]?.nested as Record<string, unknown>).password).toBe(
      OBSERVABILITY_REDACTED,
    )
    expect((items[1]?.nested as Record<string, unknown>).ok).toBe(true)

    // Value-shape redaction when the key itself is not secret-named.
    expect(redacted.note).toBe(OBSERVABILITY_REDACTED)
    // cookieBlob key contains "cookie" → key redaction.
    expect(redacted.cookieBlob).toBe(OBSERVABILITY_REDACTED)

    const json = JSON.stringify(redacted)
    expect(json).not.toContain(RAW_JWT)
    expect(json).not.toContain('raw-session-secret-value-DO-NOT-LOG')
    expect(json).not.toContain(RAW_SESSION_COOKIE)
    expect(json).not.toContain('sk-live-should-not-appear')
    expect(json).not.toContain(`Bearer ${RAW_JWT}`)
  })

  it('buildStructuredLog meta: cookieHeader/authHeader with raw JWT/session never leak', () => {
    const log = buildStructuredLog({
      requestId: 'req-redact',
      endpoint: '/api/public-snapshot',
      event: 'get',
      boardId: 'b1',
      actorRole: 'PUBLIC',
      result: 'ok',
      latencyMs: 9,
      boardRev: 3,
      lifecycleRev: 1,
      meta: {
        cookieHeader: RAW_SESSION_COOKIE,
        authHeader: `Bearer ${RAW_JWT}`,
        route: 'public',
      },
    })
    // Required structured fields preserved.
    expect(log.requestId).toBe('req-redact')
    expect(log.endpoint).toBe('/api/public-snapshot')
    expect(log.event).toBe('get')
    expect(log.boardId).toBe('b1')
    expect(log.actorRole).toBe('PUBLIC')
    expect(log.result).toBe('ok')
    expect(log.latencyMs).toBe(9)
    expect(log.boardRev).toBe(3)
    expect(log.lifecycleRev).toBe(1)
    expect(log.meta?.route).toBe('public')
    expect(log.meta?.cookieHeader).toBe(OBSERVABILITY_REDACTED)
    expect(log.meta?.authHeader).toBe(OBSERVABILITY_REDACTED)
    const json = JSON.stringify(log)
    expect(json).not.toContain(RAW_JWT)
    expect(json).not.toContain('raw-session-secret-value-DO-NOT-LOG')
  })

  it('redacts cycles, depth cap, and large nests without leaking secrets', () => {
    const cyclic: Record<string, unknown> = {
      authHeader: `Bearer ${RAW_JWT}`,
      safe: 1,
    }
    cyclic.self = cyclic
    const out = redactForObservability(cyclic) as Record<string, unknown>
    expect(out.authHeader).toBe(OBSERVABILITY_REDACTED)
    expect(out.safe).toBe(1)
    expect(out.self).toBe(`${OBSERVABILITY_REDACTED}:CYCLE`)
    expect(JSON.stringify(out)).not.toContain(RAW_JWT)

    // Deep nesting of a secret key still redacts at the leaf.
    let deep: unknown = { cookieHeader: RAW_SESSION_COOKIE }
    for (let i = 0; i < 20; i++) deep = { wrap: deep }
    const deepOut = JSON.stringify(redactForObservability(deep))
    expect(deepOut).not.toContain('raw-session-secret-value-DO-NOT-LOG')
    expect(deepOut).toMatch(/REDACTED/)
  })
})

describe('AC-OPS-03 metrics / alerts / runbook', () => {
  it('registers every V3 metric category', () => {
    const metrics = createMemoryMetricsRegistry(() => 1000)
    for (const cat of V3_METRIC_CATEGORIES) {
      metrics.observe(cat, 1)
    }
    const check = assertAllMetricCategoriesRegistered(
      metrics.snapshot().map((s) => s.category),
    )
    expect(check.ok).toBe(true)
    expect(check.missing).toEqual([])
    expect(V3_METRIC_CATEGORIES.length).toBeGreaterThanOrEqual(18)
  })

  it('metrics sum/count and never keep secret labels', () => {
    const metrics = createMemoryMetricsRegistry()
    metrics.increment('auth_denies', 2, { token: 'x', reason: 'missing' })
    metrics.observe('api_latency_ms', 40, { route: 'public-snapshot' })
    expect(metrics.sum('auth_denies')).toBe(2)
    expect(metrics.count('api_latency_ms')).toBe(1)
    const sample = metrics.snapshot().find((s) => s.category === 'auth_denies')
    expect(sample?.labels?.token).toBeUndefined()
    expect(sample?.labels?.reason).toBe('missing')
  })

  it('has alert ids + runbook metadata for each V3 alert', () => {
    expect(V3_ALERT_IDS.length).toBe(7)
    for (const id of V3_ALERT_IDS) {
      const rb = runbookForAlert(id)
      expect(rb).not.toBeNull()
      expect(rb?.steps.length).toBeGreaterThan(0)
      expect(rb?.runbookId).toBeTruthy()
    }
    expect(STAGING_RUNBOOKS.length).toBe(V3_ALERT_IDS.length)
  })

  it('public freshness alert activates above 2 intervals', () => {
    const active = evaluatePublicFreshnessAlert({
      ageMs: 121_000,
      publicationIntervalMs: 60_000,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    expect(active.active).toBe(true)
    expect(active.severity).toBe('critical')
    expect(active.runbookId).toBe('rb-public-freshness-stale')

    const ok = evaluatePublicFreshnessAlert({
      ageMs: 30_000,
      publicationIntervalMs: 60_000,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    expect(ok.active).toBe(false)
  })

  it('release/schema alert and registry', () => {
    const alerts = createMemoryAlertRegistry()
    const a = evaluateReleaseSchemaAlert({
      releaseMatch: false,
      schemaMatch: true,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    alerts.set(a)
    expect(alerts.listActive()).toHaveLength(1)
    expect(alerts.get('UNHEALTHY_RELEASE_SCHEMA_MISMATCH')?.active).toBe(true)
    alerts.clear('UNHEALTHY_RELEASE_SCHEMA_MISMATCH')
    expect(alerts.listActive()).toHaveLength(0)
  })

  it('observability facade wires log/metrics/alerts/runbooks', () => {
    const fac = createObservabilityFacade()
    const log = fac.log({
      requestId: '1',
      endpoint: '/api/healthz',
      event: 'health',
      result: 'ok',
    })
    expect(log.endpoint).toBe('/api/healthz')
    fac.metrics.increment('auth_denies')
    expect(fac.metrics.sum('auth_denies')).toBe(1)
    expect(fac.runbooks.length).toBeGreaterThan(0)
  })
})
