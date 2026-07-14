/**
 * MCP defaultRunDeps retention binding (IB-RETENTION-CALLER-BINDING).
 * - Bind only via resolveRetentionPolicy from approved/versioned BoardPolicy
 * - PRODUCTION absent policy → fail-closed + Decision path
 * - Long-lived binding shares compaction watermark across defaultRunDeps calls
 * - Ordinary heartbeat → no immutable MATERIAL audit
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  DECISION_HEARTBEAT_RETENTION_POLICY,
  STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
  assertRetentionEnvironmentConfigured,
  isProductionLikeRetentionRuntime,
  resolveRetentionEnvironment,
  resolveRetentionEnvironmentDetails,
  resolveRetentionPolicy,
  type BoardPolicyRetention,
} from '#/server/audit-retention'
import {
  RETENTION_DURABLE_STORE_UNBOUND,
  bindMcpRetentionPolicyFromStore,
  createMemoryControlPlaneRuntimeContext,
  defaultRunDeps,
  getMcpRetentionAsyncBinding,
  getMcpRetentionBinding,
  getMcpRetentionPolicyResolve,
  openMcpHeartbeatRetentionPolicyDecision,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  setMcpRetentionPolicyConfig,
  setMcpRunRegistryDeps,
  setTestControlPlaneRuntimeContext,
} from '#/server/board-mcp'
import { createMysqlRetentionStore } from '#/server/control-plane-runtime-persistence'
import {
  heartbeatRun,
  registerRun,
  type RegisterRunCapacity,
  type RunRegistryDeps,
  withTestCapacityInjection,
} from '#/server/run-registry'
import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore } from '#/server/locks'
import { createMemoryRunRegistryStore } from '#/server/run-registry'

const BOARD = 'board-mcp-ret-bind'

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
    healthyGrokUsableCapacity: 100,
  }
}

const PROD_APPROVED: BoardPolicyRetention = {
  ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
  policyId: 'prod-approved-heartbeat-retention-v1',
  policyVersion: '1.0.0',
  approvedFor: ['PRODUCTION', 'STAGING', 'LOCAL', 'TEST'],
  heartbeatSampleInterval: 5,
  compactionIntervalMs: 1,
  hotStateRetentionMs: 60_000,
  sampledEventRetentionMs: 60_000,
}

beforeEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
})

afterEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
})

describe('resolveRetentionEnvironment H3 fail-closed', () => {
  it('missing CAIRN_ENV/APP_ENV + non-test NODE_ENV → UNRESOLVED (not LOCAL invent)', () => {
    const env = {
      NODE_ENV: 'development',
    } as NodeJS.ProcessEnv
    expect(resolveRetentionEnvironment(env)).toBe('UNRESOLVED')
    const policy = resolveRetentionPolicy({ environment: 'UNRESOLVED' })
    expect(policy.ok).toBe(false)
    expect(policy.source).toBe('BLOCKED')
    expect(policy.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
    expect(policy.message).toMatch(/cannot invent LOCAL/i)
  })

  it('empty env → UNRESOLVED; assert throws startup fail-closed', () => {
    const env = {} as NodeJS.ProcessEnv
    expect(resolveRetentionEnvironment(env)).toBe('UNRESOLVED')
    expect(() => assertRetentionEnvironmentConfigured(env)).toThrow(/UNRESOLVED/i)
  })

  it('unknown CAIRN_ENV → UNRESOLVED (not LOCAL)', () => {
    expect(
      resolveRetentionEnvironment({
        CAIRN_ENV: 'development',
        NODE_ENV: 'development',
      } as NodeJS.ProcessEnv),
    ).toBe('UNRESOLVED')
  })

  it('explicit CAIRN_ENV=local → LOCAL; proposal allowed only when explicit', () => {
    expect(
      resolveRetentionEnvironment({ CAIRN_ENV: 'local' } as NodeJS.ProcessEnv),
    ).toBe('LOCAL')
    const r = resolveRetentionPolicy({ environment: 'LOCAL' })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('STAGING_PROPOSAL')
  })

  it('explicit tokens: test/staging/production/prod', () => {
    expect(
      resolveRetentionEnvironment({ CAIRN_ENV: 'test' } as NodeJS.ProcessEnv),
    ).toBe('TEST')
    expect(
      resolveRetentionEnvironment({ APP_ENV: 'staging' } as NodeJS.ProcessEnv),
    ).toBe('STAGING')
    expect(
      resolveRetentionEnvironment({ CAIRN_ENV: 'production' } as NodeJS.ProcessEnv),
    ).toBe('PRODUCTION')
    expect(
      resolveRetentionEnvironment({ APP_ENV: 'prod' } as NodeJS.ProcessEnv),
    ).toBe('PRODUCTION')
  })

  it('NODE_ENV=test or VITEST → TEST without inventing LOCAL from bare development', () => {
    expect(
      resolveRetentionEnvironment({ NODE_ENV: 'test' } as NodeJS.ProcessEnv),
    ).toBe('TEST')
    expect(
      resolveRetentionEnvironment({ VITEST: 'true' } as NodeJS.ProcessEnv),
    ).toBe('TEST')
    const weak = resolveRetentionEnvironmentDetails({
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)
    expect(weak.weakTestSignal).toBe(true)
    expect(weak.explicitAppEnv).toBe(false)
    // R4: weak TEST without capability cannot authorize staging proposal
    const blocked = resolveRetentionPolicy({
      environment: weak.environment,
      explicitAppEnv: weak.explicitAppEnv,
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.source).toBe('BLOCKED')
    expect(blocked.message).toMatch(/R4|allowTestRetentionProposal/i)
  })

  it('R4: production-like + NODE_ENV=test/VITEST → UNRESOLVED (no silent TEST proposal)', () => {
    const env = {
      NODE_ENV: 'test',
      CAIRN_SERVER: '1',
      VITEST: 'true',
    } as NodeJS.ProcessEnv
    expect(isProductionLikeRetentionRuntime(env)).toBe(true)
    const d = resolveRetentionEnvironmentDetails(env)
    expect(d.environment).toBe('UNRESOLVED')
    expect(d.weakTestSignal).toBe(true)
    expect(d.productionLike).toBe(true)
    expect(() => assertRetentionEnvironmentConfigured(env)).toThrow(/R4|UNRESOLVED/i)
    const policy = resolveRetentionPolicy({
      environment: d.environment,
      allowTestRetentionProposal: true, // capability must not override UNRESOLVED
    })
    expect(policy.ok).toBe(false)
    expect(policy.source).toBe('BLOCKED')
  })

  it('R4: CAIRN_ENV=test under production-like still TEST with explicitAppEnv (authorized)', () => {
    const env = {
      CAIRN_ENV: 'test',
      CAIRN_SERVER: '1',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv
    const d = resolveRetentionEnvironmentDetails(env)
    expect(d.environment).toBe('TEST')
    expect(d.explicitAppEnv).toBe(true)
    expect(d.weakTestSignal).toBe(false)
    const r = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: d.explicitAppEnv,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('STAGING_PROPOSAL')
  })
})

/**
 * R4 exact matrix (smaller-scope retry):
 * NEG: NODE_ENV=test / VITEST alone → no STAGING_PROPOSED
 * NEG: production-like + weak test signals → UNRESOLVED (boot refuse)
 * NEG: PRODUCTION without supplied → fail-closed
 * POS: CAIRN_ENV=test (explicitAppEnv) → STAGING_PROPOSAL
 * POS: allowTestRetentionProposal (disposable harness capability) → STAGING_PROPOSAL
 * POS: allowStagingProposal → STAGING_PROPOSAL
 */
describe('R4 exact negative/positive matrix', () => {
  it('NEG: NODE_ENV=test alone does not authorize STAGING_PROPOSED', () => {
    const d = resolveRetentionEnvironmentDetails({
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv)
    expect(d.environment).toBe('TEST')
    expect(d.weakTestSignal).toBe(true)
    expect(d.explicitAppEnv).toBe(false)
    const r = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: d.explicitAppEnv,
    })
    expect(r.ok).toBe(false)
    expect(r.source).toBe('BLOCKED')
    expect(r.policy).toBeNull()
    expect(r.message).toMatch(/R4|NODE_ENV=test|allowTestRetentionProposal/i)
  })

  it('NEG: VITEST alone does not authorize STAGING_PROPOSED', () => {
    const d = resolveRetentionEnvironmentDetails({
      VITEST: 'true',
    } as NodeJS.ProcessEnv)
    expect(d.environment).toBe('TEST')
    expect(d.weakTestSignal).toBe(true)
    expect(d.source).toBe('VITEST')
    const r = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: false,
    })
    expect(r.ok).toBe(false)
    expect(r.source).toBe('BLOCKED')
    expect(r.policy).toBeNull()
  })

  it('NEG: production-like serve + NODE_ENV=test/VITEST → UNRESOLVED (no silent proposal)', () => {
    const weakProdLikeCases: NodeJS.ProcessEnv[] = [
      { NODE_ENV: 'test', CAIRN_SERVER: '1' },
      { VITEST: '1', CAIRN_SERVER: '1' },
      { NODE_ENV: 'test', VITEST: 'true', CAIRN_SERVER: '1' },
    ]
    for (const env of weakProdLikeCases) {
      expect(isProductionLikeRetentionRuntime(env)).toBe(true)
      const d = resolveRetentionEnvironmentDetails(env)
      expect(d.productionLike).toBe(true)
      expect(d.environment).toBe('UNRESOLVED')
      expect(d.weakTestSignal).toBe(true)
      expect(d.explicitAppEnv).toBe(false)
      expect(() => assertRetentionEnvironmentConfigured(env)).toThrow(
        /R4|UNRESOLVED/i,
      )
      // Capability flag must not override UNRESOLVED identity.
      expect(
        resolveRetentionPolicy({
          environment: d.environment,
          allowTestRetentionProposal: true,
        }).ok,
      ).toBe(false)
    }
  })

  it('NEG: production-like + explicit CAIRN_ENV=staging without allowStagingProposal stays blocked', () => {
    const env = {
      CAIRN_ENV: 'staging',
      NODE_ENV: 'test',
    } as NodeJS.ProcessEnv
    const d = resolveRetentionEnvironmentDetails(env)
    expect(d.environment).toBe('STAGING')
    expect(d.explicitAppEnv).toBe(true)
    expect(d.productionLike).toBe(true)
    const blocked = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: d.explicitAppEnv,
      allowTestRetentionProposal: true, // must not bypass STAGING gate
    })
    expect(blocked.ok).toBe(false)
    expect(blocked.source).toBe('BLOCKED')
  })

  it('NEG: explicit PRODUCTION remains fail-closed without supplied policy', () => {
    const d = resolveRetentionEnvironmentDetails({
      CAIRN_ENV: 'production',
      NODE_ENV: 'test',
      VITEST: 'true',
    } as NodeJS.ProcessEnv)
    expect(d.environment).toBe('PRODUCTION')
    expect(d.explicitAppEnv).toBe(true)
    const r = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: d.explicitAppEnv,
      allowTestRetentionProposal: true,
      allowStagingProposal: true,
    })
    expect(r.ok).toBe(false)
    expect(r.source).toBe('BLOCKED')
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
    expect(r.message).toMatch(/DECISION_HEARTBEAT_RETENTION_POLICY|production/i)
  })

  it('POS: CAIRN_ENV=test (explicitAppEnv) authorizes STAGING_PROPOSED', () => {
    const d = resolveRetentionEnvironmentDetails({
      CAIRN_ENV: 'test',
    } as NodeJS.ProcessEnv)
    expect(d.environment).toBe('TEST')
    expect(d.explicitAppEnv).toBe(true)
    expect(d.weakTestSignal).toBe(false)
    const r = resolveRetentionPolicy({
      environment: d.environment,
      explicitAppEnv: d.explicitAppEnv,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('STAGING_PROPOSAL')
    expect(r.policy?.policyId).toBe(
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
    )
  })

  it('POS: allowTestRetentionProposal capability authorizes disposable harness', () => {
    const r = resolveRetentionPolicy({
      environment: 'TEST',
      explicitAppEnv: false,
      allowTestRetentionProposal: true,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('STAGING_PROPOSAL')
  })

  it('POS: allowStagingProposal flag authorizes TEST proposal', () => {
    const r = resolveRetentionPolicy({
      environment: 'TEST',
      explicitAppEnv: false,
      allowStagingProposal: true,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('STAGING_PROPOSAL')
  })

  it('POS: disposable unit harness (test override + weak TEST) binds STAGING_PROPOSED', () => {
    // beforeEach installs memory test override; process under vitest is weak TEST.
    // mcpAllowTestRetentionProposal grants capability — preserves disposable harnesses.
    const prevCairn = process.env.CAIRN_ENV
    const prevApp = process.env.APP_ENV
    try {
      delete process.env.CAIRN_ENV
      delete process.env.APP_ENV
      // leave NODE_ENV/VITEST as vitest provides (weak)
      resetMcpControlPlaneDeps()
      setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retention).toBeTruthy()
      expect(deps.retention?.policy.policyId).toBe(
        STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
      )
      expect(getMcpRetentionPolicyResolve()?.source).toBe('STAGING_PROPOSAL')
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
      if (prevApp === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = prevApp
    }
  })

  it('NEG: weak TEST without test override capability does not bind proposal on MCP path', () => {
    const prevCairn = process.env.CAIRN_ENV
    const prevApp = process.env.APP_ENV
    try {
      delete process.env.CAIRN_ENV
      delete process.env.APP_ENV
      resetMcpControlPlaneDeps()
      // Install then clear test override so hasTestControlPlaneRuntimeContext=false
      // while still providing a ctx via direct mode for defaultRunDeps path:
      // without override, defaultRunDeps still needs a runtime — use set then clear
      // and re-set with a context that is NOT tracked as test override is impossible
      // after clear. Instead assert pure resolve path used by MCP (no capability).
      resetControlPlaneRuntimeContextForTests()
      const weak = resolveRetentionEnvironmentDetails(process.env)
      // Under vitest process: weak TEST, not productionLike (unless CAIRN_SERVER set).
      if (weak.environment === 'TEST' && weak.weakTestSignal && !weak.explicitAppEnv) {
        const r = resolveRetentionPolicy({
          environment: weak.environment,
          explicitAppEnv: false,
          allowTestRetentionProposal: false,
          allowStagingProposal: false,
        })
        expect(r.ok).toBe(false)
        expect(r.source).toBe('BLOCKED')
      } else {
        // If process env was polluted, still prove pure weak case.
        const r = resolveRetentionPolicy({
          environment: 'TEST',
          explicitAppEnv: false,
        })
        expect(r.ok).toBe(false)
        expect(r.source).toBe('BLOCKED')
      }
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
      if (prevApp === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = prevApp
      setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
    }
  })
})

describe('MCP defaultRunDeps retention binding', () => {
  it('binds long-lived retention on LOCAL/TEST default path (staging proposal)', () => {
    // Disposable harness: test override grants allowTestRetentionProposal for weak TEST.
    const deps1 = defaultRunDeps(BOARD, 0)
    const deps2 = defaultRunDeps(BOARD, 0)
    expect(deps1).toBe(deps2)
    expect(deps1.retention).toBeTruthy()
    expect(deps1.retention).toBe(deps2.retention)
    expect(deps1.retention?.policy.policyId).toBe(
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
    )
    expect(getMcpRetentionBinding()).toBe(deps1.retention)
    const resolve = getMcpRetentionPolicyResolve()
    expect(resolve?.ok).toBe(true)
    expect(resolve?.source).toBe('STAGING_PROPOSAL')
  })

  it('H3: UNRESOLVED process env fail-closed on defaultRunDeps (no LOCAL invent)', () => {
    const prevCairn = process.env.CAIRN_ENV
    const prevApp = process.env.APP_ENV
    const prevNode = process.env.NODE_ENV
    const prevVitest = process.env.VITEST
    try {
      delete process.env.CAIRN_ENV
      delete process.env.APP_ENV
      process.env.NODE_ENV = 'development'
      delete process.env.VITEST
      resetMcpControlPlaneDeps()
      setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())

      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retention == null || deps.retention === null).toBe(true)
      expect(getMcpRetentionBinding()).toBeNull()
      const resolve = getMcpRetentionPolicyResolve()
      expect(resolve?.ok).toBe(false)
      expect(resolve?.source).toBe('BLOCKED')
      expect(resolve?.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
      expect(resolve?.message).toMatch(/UNRESOLVED|cannot invent LOCAL/i)
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
      if (prevApp === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = prevApp
      if (prevNode === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNode
      if (prevVitest === undefined) delete process.env.VITEST
      else process.env.VITEST = prevVitest
    }
  })

  it('R1/M3: mysql mode binds durable retentionAsync (no process-local sync memory)', () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'local'
      resetMcpControlPlaneDeps()
      const base = createMemoryControlPlaneRuntimeContext()
      // Simulate mysql mode: fail-closed sync retention stub + durable retentionAsync present.
      setTestControlPlaneRuntimeContext({
        ...base,
        mode: 'mysql',
        runtime: {
          ...base.runtime,
          mode: 'mysql',
          retention: createMysqlRetentionStore(),
        },
      })
      setMcpRetentionPolicyConfig({
        supplied: {
          ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
          approvedFor: ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'],
        },
      })
      const deps = defaultRunDeps(BOARD, 0)
      // Sync process-memory never bound in mysql mode.
      expect(deps.retention).toBeNull()
      expect(getMcpRetentionBinding()).toBeNull()
      // Durable async bound from runtime.retentionAsync.
      expect(deps.retentionAsync).toBeTruthy()
      expect(deps.retentionAsync?.store).toBe(base.runtime.retentionAsync)
      expect(deps.retentionAsync?.policy.policyId).toBe(
        STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
      )
      expect(getMcpRetentionAsyncBinding()).toBe(deps.retentionAsync)
      const resolve = getMcpRetentionPolicyResolve()
      expect(resolve?.ok).toBe(true)
      expect(resolve?.policy?.policyId).toBe(
        STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
      )
      // Long-lived: second defaultRunDeps shares same async binding.
      const deps2 = defaultRunDeps(BOARD, 0)
      expect(deps2.retentionAsync).toBe(deps.retentionAsync)
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('R1: mysql mode fail-closed when durable retentionAsync unavailable', () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'local'
      resetMcpControlPlaneDeps()
      const base = createMemoryControlPlaneRuntimeContext()
      setTestControlPlaneRuntimeContext({
        ...base,
        mode: 'mysql',
        runtime: {
          ...base.runtime,
          mode: 'mysql',
          retention: createMysqlRetentionStore(),
          // Simulate persistence unavailable — no invent of process-memory Maps.
          retentionAsync: null as unknown as typeof base.runtime.retentionAsync,
        },
      })
      setMcpRetentionPolicyConfig({
        supplied: {
          ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
          approvedFor: ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'],
        },
      })
      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retention).toBeNull()
      expect(deps.retentionAsync == null || deps.retentionAsync === null).toBe(true)
      expect(getMcpRetentionAsyncBinding()).toBeNull()
      const resolve = getMcpRetentionPolicyResolve()
      expect(resolve?.ok).toBe(false)
      expect(resolve?.source).toBe('BLOCKED')
      expect(resolve?.message).toMatch(new RegExp(RETENTION_DURABLE_STORE_UNBOUND))
      expect(resolve?.message).toMatch(/retentionAsync unavailable|fail closed/i)
      expect(resolve?.message).toMatch(/no process-local invent/i)
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('R1: mysql defaultRunDeps heartbeat sample/material via retentionAsync (no immutable ordinary HB)', async () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'local'
      resetMcpControlPlaneDeps()
      const base = createMemoryControlPlaneRuntimeContext()
      setTestControlPlaneRuntimeContext({
        ...base,
        mode: 'mysql',
        runtime: {
          ...base.runtime,
          mode: 'mysql',
          retention: createMysqlRetentionStore(),
        },
      })
      setMcpRetentionPolicyConfig({
        supplied: {
          ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
          approvedFor: ['LOCAL', 'TEST', 'STAGING', 'PRODUCTION'],
          heartbeatSampleInterval: 2,
          compactionIntervalMs: 60_000,
        },
      })
      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retentionAsync).toBeTruthy()
      const asyncStore = deps.retentionAsync!.store

      const reg = await registerRun(withTestCapacityInjection(deps, openCapacity()), {
        boardId: BOARD,
        runId: 'run-mysql-async-hb',
        taskId: 'task-mysql-async',
        targetGate: 'G1',
        agentId: 'agent-mysql-async',
        model: 'grok-4',
        canonicalHash: 'canon-mysql-async',
        expectedEntityRev: 0,
        expectedBoardRev: 0,
        idempotencyKey: 'reg-mysql-async-1',
        initialState: 'RUNNING',
      })

      // seq 1: hot only (sample interval 2 → sample on even)
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-mysql-async-hb',
        agentId: 'agent-mysql-async',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 1,
        expectedEntityRev: 1,
        expectedBoardRev: 0,
        idempotencyKey: 'hb-mysql-async-1',
        canonicalHash: 'canon-mysql-async',
      })
      // seq 2: sample (immutable:false)
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-mysql-async-hb',
        agentId: 'agent-mysql-async',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 2,
        expectedEntityRev: 2,
        expectedBoardRev: 0,
        idempotencyKey: 'hb-mysql-async-2',
        canonicalHash: 'canon-mysql-async',
      })
      // seq 3 material progress → MATERIAL immutable only
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-mysql-async-hb',
        agentId: 'agent-mysql-async',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: 3,
        expectedEntityRev: 3,
        expectedBoardRev: 0,
        idempotencyKey: 'hb-mysql-async-3',
        canonicalHash: 'canon-mysql-async',
        materialProgressAt: new Date(deps.clock.nowMs()).toISOString(),
      })

      const hot = await asyncStore.getHot(BOARD, 'run-mysql-async-hb')
      expect(hot?.heartbeatSequence).toBe(3)
      expect(hot?.materialProgressAtMs).not.toBeNull()

      const sampled = await asyncStore.listAudit(BOARD, { eventClass: 'SAMPLED' })
      expect(sampled.length).toBeGreaterThanOrEqual(1)
      expect(sampled.every((a) => a.immutable === false)).toBe(true)

      const material = await asyncStore.listAudit(BOARD, {
        eventClass: 'MATERIAL',
        immutable: true,
      })
      expect(material).toHaveLength(1)
      expect(material[0]!.runId).toBe('run-mysql-async-hb')

      // Sync store never used (would throw if createMysqlRetentionStore called).
      expect(deps.retention).toBeNull()
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('PRODUCTION without supplied policy fail-closed (no invent)', () => {
    const prevCairn = process.env.CAIRN_ENV
    const prevApp = process.env.APP_ENV
    const prevNode = process.env.NODE_ENV
    try {
      process.env.CAIRN_ENV = 'production'
      delete process.env.APP_ENV
      // NODE_ENV may stay 'test' under vitest — CAIRN_ENV production wins in resolveRetentionEnvironment
      resetMcpControlPlaneDeps()
      setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())

      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retention == null || deps.retention === null).toBe(true)
      expect(getMcpRetentionBinding()).toBeNull()
      const resolve = getMcpRetentionPolicyResolve()
      expect(resolve?.ok).toBe(false)
      expect(resolve?.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
      expect(resolve?.source).toBe('BLOCKED')
      expect(resolve?.message).toMatch(/do not invent production retention/i)
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
      if (prevApp === undefined) delete process.env.APP_ENV
      else process.env.APP_ENV = prevApp
      if (prevNode === undefined) delete process.env.NODE_ENV
      else process.env.NODE_ENV = prevNode
    }
  })

  it('PRODUCTION with approved versioned BoardPolicy binds retention', () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'production'
      setMcpRetentionPolicyConfig({ supplied: PROD_APPROVED })
      const deps = defaultRunDeps(BOARD, 0)
      expect(deps.retention).toBeTruthy()
      expect(deps.retention?.policy.policyId).toBe(PROD_APPROVED.policyId)
      expect(deps.retention?.policy.policyVersion).toBe('1.0.0')
      expect(getMcpRetentionPolicyResolve()?.source).toBe('SUPPLIED')
      expect(getMcpRetentionPolicyResolve()?.ok).toBe(true)
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('bindMcpRetentionPolicyFromStore loads durable row then resolves', async () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'production'
      const ctx = createMemoryControlPlaneRuntimeContext()
      setTestControlPlaneRuntimeContext(ctx)
      await ctx.runtime.retentionPolicy.put(BOARD, PROD_APPROVED)

      const resolve = await bindMcpRetentionPolicyFromStore(BOARD)
      expect(resolve.ok).toBe(true)
      expect(resolve.policy?.policyId).toBe(PROD_APPROVED.policyId)
      expect(defaultRunDeps(BOARD, 0).retention?.policy.policyId).toBe(
        PROD_APPROVED.policyId,
      )
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('openMcpHeartbeatRetentionPolicyDecision opens exact Decision when absent', async () => {
    const prevCairn = process.env.CAIRN_ENV
    try {
      process.env.CAIRN_ENV = 'production'
      resetMcpControlPlaneDeps()
      // Seed board rev 0 so openDecision CAS can succeed.
      setTestControlPlaneRuntimeContext(
        createMemoryControlPlaneRuntimeContext({
          seedBoards: [
            {
              boardId: BOARD,
              boardRev: 0,
              dispatchBlocked: false,
              dispatchBlockedReason: null,
            },
          ],
        }),
      )

      const { opened, resolve } = await openMcpHeartbeatRetentionPolicyDecision({
        boardId: BOARD,
        actorId: 'actor-ret',
        expectedBoardRev: 0,
        entityExpectedRev: 0,
        canonicalHash: 'c'.repeat(64),
        idempotencyKey: 'open-ret-policy-1',
      })
      expect(resolve.ok).toBe(false)
      expect(resolve.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
      expect(opened).not.toBeNull()
      expect(opened!.type).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
      expect(opened!.status).toBe('OPEN')
    } finally {
      if (prevCairn === undefined) delete process.env.CAIRN_ENV
      else process.env.CAIRN_ENV = prevCairn
    }
  })

  it('ordinary heartbeat updates hot state without immutable audit', async () => {
    setMcpRetentionPolicyConfig({
      supplied: {
        ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
        heartbeatSampleInterval: 10,
        compactionIntervalMs: 60_000,
      },
    })
    const deps = defaultRunDeps(BOARD, 0)
    expect(deps.retention).toBeTruthy()
    const store = deps.retention!.store

    const reg = await registerRun(withTestCapacityInjection(deps, openCapacity()), {
      boardId: BOARD,
      runId: 'run-ord-hb',
      taskId: 'task-ord',
      targetGate: 'G1',
      agentId: 'agent-ord',
      model: 'grok-4',
      canonicalHash: 'canon-ord',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-ord-1',
      initialState: 'RUNNING'})

    for (let seq = 1; seq <= 3; seq++) {
      await heartbeatRun(deps, {
        boardId: BOARD,
        runId: 'run-ord-hb',
        agentId: 'agent-ord',
        fencingToken: reg.fencingToken!,
        heartbeatSequence: seq,
        expectedEntityRev: seq,
        expectedBoardRev: 0,
        idempotencyKey: `hb-ord-${seq}`,
        canonicalHash: 'canon-ord',
      })
    }

    expect(store.getHot('run-ord-hb')?.heartbeatSequence).toBe(3)
    expect(store.listAudit({ eventClass: 'MATERIAL', immutable: true })).toHaveLength(0)
  })

  it('compaction interval + long-lived watermark survives defaultRunDeps re-entry', async () => {
    setMcpRetentionPolicyConfig({
      supplied: {
        ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
        heartbeatSampleInterval: 100,
        compactionIntervalMs: 1,
        hotStateRetentionMs: 30_000,
        sampledEventRetentionMs: 30_000,
      },
    })
    const deps = defaultRunDeps(BOARD, 0)
    const binding = deps.retention!
    expect(binding.lastCompactionAtMs ?? 0).toBe(0)

    // Pre-seed expired hot row so compaction has work.
    binding.store.putHot({
      runId: 'stale-hot',
      boardId: BOARD,
      lastHeartbeatAtMs: 0,
      heartbeatSequence: 1,
      status: 'RUNNING',
      materialProgressAtMs: null,
    })

    const reg = await registerRun(withTestCapacityInjection(deps, openCapacity()), {
      boardId: BOARD,
      runId: 'run-compact',
      taskId: 'task-c',
      targetGate: 'G1',
      agentId: 'agent-c',
      model: 'grok-4',
      canonicalHash: 'canon-c',
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      idempotencyKey: 'reg-c-1',
      initialState: 'RUNNING'})

    await heartbeatRun(deps, {
      boardId: BOARD,
      runId: 'run-compact',
      agentId: 'agent-c',
      fencingToken: reg.fencingToken!,
      heartbeatSequence: 1,
      expectedEntityRev: 1,
      expectedBoardRev: 0,
      idempotencyKey: 'hb-c-1',
      canonicalHash: 'canon-c',
    })

    const watermarkAfter = binding.lastCompactionAtMs ?? 0
    expect(watermarkAfter).toBeGreaterThan(0)
    // Stale hot should be compacted away (retention window vs clock now).
    // Hot retention 30s; lastHeartbeat 0 vs now ~ current → deleted
    expect(binding.store.getHot('stale-hot')).toBeNull()

    // Re-enter defaultRunDeps — same binding + watermark (not reset to 0).
    const deps2 = defaultRunDeps(BOARD, 0)
    expect(deps2.retention).toBe(binding)
    expect(deps2.retention!.lastCompactionAtMs).toBe(watermarkAfter)
  })

  it('setMcpRunRegistryDeps injection still takes precedence (no forced bind)', () => {
    const clock = createFakeClock(Date.parse('2026-07-14T00:00:00.000Z'))
    const injected: RunRegistryDeps = {
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
      // Explicitly no retention on injection
      retention: null,
    }
    setMcpRunRegistryDeps(injected)
    const resolved = defaultRunDeps(BOARD, 0)
    expect(resolved).toBe(injected)
    expect(resolved.retention).toBeNull()
  })
})
