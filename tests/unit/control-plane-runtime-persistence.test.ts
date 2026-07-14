/**
 * F2 runtime persistence foundation — unit only (no real MySQL apply).
 * Covers: migration SQL shape, codecs, memory-SQL store contracts,
 * fencing CAS, revision evaluate, retention policy.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
  type HotRunState,
  type AuditRecord,
} from '#/server/audit-retention'
import type { DispatchPlanRecord } from '#/server/control-plane-ingest'
import type { CollisionLockRecord, IntegrationLockRecord } from '#/server/locks'
import type { ReconcileDryRunResult, ReconcilerLeaderState } from '#/server/reconciler'
import type { RunRecord } from '#/server/run-registry'
import { subjectHashOf } from '#/server/revisions'
import {
  RUNTIME_PERSISTENCE_MIGRATION_FILE,
  RUNTIME_PERSISTENCE_TABLES,
  RUNTIME_SQL,
  assertCasMutationAllowed,
  assertFencingMatch,
  casRenewReconcilerLeader,
  casUpdateCollisionWithFencing,
  casUpdateRunWithFencing,
  createMemoryControlPlaneRuntimePersistence,
  createMemorySqlExecutor,
  createMysqlControlPlaneRuntimePersistence,
  createMysqlLockStore,
  createMysqlReconcilerStore,
  createMysqlRunRegistryStore,
  decodeAccountSyncSnapshot,
  decodeCollisionLock,
  decodeDispatchPlanRecord,
  decodeIntegrationLock,
  decodeReconcileDryRun,
  decodeReconcilerLeader,
  decodeRetentionPolicy,
  decodeRunRecord,
  encodeAccountSyncSnapshot,
  encodeCollisionLock,
  encodeDispatchPlanRecord,
  encodeIntegrationLock,
  encodeReconcileDryRun,
  encodeReconcilerLeader,
  encodeRetentionPolicy,
  encodeRunRecord,
  evaluateRuntimeCas,
  jsonParam,
  parseJsonCell,
  RuntimePersistenceError,
  withMysqlNamedLock,
} from '#/server/control-plane-runtime-persistence'
import type { AccountSyncSnapshot } from '#/server/account-sync'
import { splitSqlStatements } from '#/server/migrations'

const cwd = process.cwd()
const migrationPath = path.join(cwd, 'migrations/005_control_plane_runtime_persistence.sql')

function samplePlan(overrides: Partial<DispatchPlanRecord> = {}): DispatchPlanRecord {
  return {
    boardId: 'board-a',
    planId: 'plan-1',
    planVersion: 1,
    planHash: 'a'.repeat(64),
    canonicalSnapshotId: 'snap-1',
    canonicalHash: 'b'.repeat(64),
    boardRevAtPublish: 3,
    issuedAt: '2026-07-14T00:00:00.000Z',
    expiresAt: '2026-07-14T01:00:00.000Z',
    issuedAtMs: Date.parse('2026-07-14T00:00:00.000Z'),
    expiresAtMs: Date.parse('2026-07-14T01:00:00.000Z'),
    stage: 'IMPLEMENT',
    items: [
      {
        rank: 1,
        taskId: 'task-1',
        targetGate: 'G5',
        role: 'AGENT',
        selectionReason: 'next',
        priorityPortfolioId: null,
        dependencyProof: { satisfied: true },
        collisionScopeLockIds: ['scope-x'],
        expectedEntityRev: 1,
        expectedBoardRev: 3,
      },
    ],
    status: 'ACTIVE',
    generatedAt: '2026-07-14T00:00:00.000Z',
    generatedAtMs: Date.parse('2026-07-14T00:00:00.000Z'),
    supersededByPlanId: null,
    entityRev: 1,
    ...overrides,
  }
}

function sampleRun(overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    boardId: 'board-a',
    runId: 'run-1',
    state: 'RUNNING',
    planId: 'plan-1',
    planItemRank: 1,
    taskId: 'task-1',
    targetGate: 'G5',
    role: 'AGENT',
    agentId: 'agent-1',
    model: 'grok-4.5',
    effort: 'high',
    maskedAccountRef: 'acct-***',
    canonicalHash: 'c'.repeat(64),
    collisionScopeLockIds: ['scope-x'],
    fencingToken: 'fence-abc',
    fencingVersion: 1,
    registeredAtMs: 1_000,
    heartbeatAtMs: 1_500,
    leaseExpiresAtMs: 61_500,
    materialProgressAtMs: 1_400,
    heartbeatSequence: 2,
    expectedEntityRev: 1,
    expectedBoardRev: 3,
    entityRev: 2,
    boardRev: 3,
    stalled: false,
    history: [
      {
        atMs: 1_000,
        atISO: '2026-07-14T00:00:01.000Z',
        fromState: null,
        toState: 'RUNNING',
        reason: 'register',
        actorId: 'agent-1',
      },
    ],
    lastHeartbeatResponse: null,
    controllerRunId: null,
    parentRunId: null,
    idempotencyKey: 'idem-1',
    ...overrides,
  }
}

function sampleCollision(overrides: Partial<CollisionLockRecord> = {}): CollisionLockRecord {
  return {
    boardId: 'board-a',
    lockId: 'lock-1',
    scopeId: 'resources:db',
    taskId: 'task-1',
    runId: 'run-1',
    agentId: 'agent-1',
    role: 'AUTHOR',
    fencingToken: 'fence-lock',
    fencingVersion: 1,
    state: 'HELD',
    leaseExpiresAtMs: 60_000,
    acquiredAtMs: 1_000,
    releasedAtMs: null,
    supersededByLockId: null,
    supersedesLockId: null,
    entityRev: 1,
    ...overrides,
  }
}

function sampleIntegration(overrides: Partial<IntegrationLockRecord> = {}): IntegrationLockRecord {
  return {
    boardId: 'board-a',
    lockId: 'ilock-1',
    repoId: 'repo-x',
    trackingBranch: 'feature/a',
    runId: 'run-1',
    agentId: 'agent-1',
    integratorModel: 'grok-4.5',
    rootAcceptanceId: 'ra-1',
    checkpointId: 'cp-1',
    pathspecs: ['src/**'],
    fencingToken: 'fence-int',
    fencingVersion: 1,
    state: 'HELD',
    leaseExpiresAtMs: 60_000,
    acquiredAtMs: 1_000,
    releasedAtMs: null,
    entityRev: 1,
    ...overrides,
  }
}

function sampleAccountSnap(overrides: Partial<AccountSyncSnapshot> = {}): AccountSyncSnapshot {
  return {
    boardId: 'board-a',
    sourceRevision: 5,
    generatedAt: '2026-07-14T00:00:00.000Z',
    generatedAtMs: Date.parse('2026-07-14T00:00:00.000Z'),
    accounts: [
      {
        maskedAccountId: 'm-1',
        status: 'ACTIVE',
        providerKind: 'GROK',
        effectiveInUse: 1,
        effectiveCap: 5,
        physicalSlotsDisplay: '1/5',
        adaptiveQuotaState: null,
        reason: null,
        statusChangedAt: null,
        tombstone: false,
      },
    ],
    readbackSurfaces: {
      mcp: { sourceRevision: 5, generatedAt: '2026-07-14T00:00:00.000Z' },
      api: { sourceRevision: 5, generatedAt: '2026-07-14T00:00:00.000Z' },
      ui: null,
      ops: null,
    },
    publishedAtMs: Date.parse('2026-07-14T00:00:00.000Z'),
    lastPeriodicHealthAtMs: null,
    stale: false,
    staleReason: null,
    usableCapacity: 4,
    capacity: {
      sparkLive: 0,
      sparkCap: 10,
      solLive: 0,
      solCap: 10,
      grokLive: 1,
      grokPerAccount: [{ maskedAccountId: 'm-1', inUse: 1, cap: 5, healthy: true }],
      grokMajority: true,
      healthyGrokUsableCapacity: 4,
      combinedLive: 1,
      combinedCap: 200,
      floorTarget: 60,
      floorMet: false,
      belowFloor: true,
      belowFloorReason: 'below floor',
      usableCapacity: 4,
      dispatchAllowed: true,
      dispatchMode: 'OPEN',
      nonGrokAssignmentAllowed: true,
      grokAssignmentAllowed: true,
      limitingReasons: [],
      policy: {
        sparkMax: 10,
        solMax: 10,
        grokStartPerAccount: 5,
        grokMaxPerAccount: 10,
        combinedMax: 200,
        floorMin: 60,
        physicalSlotsDisplayOnly: true,
        neverAccountsAll: true,
        neverFiller: true,
      },
    },
    entityRev: 1,
    ...overrides,
  }
}

describe('005 migration SQL foundation', () => {
  it('exists at the scoped path and matches RUNTIME_PERSISTENCE_MIGRATION_FILE', () => {
    expect(fs.existsSync(migrationPath)).toBe(true)
    expect(RUNTIME_PERSISTENCE_MIGRATION_FILE).toBe(
      'migrations/005_control_plane_runtime_persistence.sql',
    )
  })

  it('is REVERSIBLE additive CREATE IF NOT EXISTS only — no DROP/TRUNCATE/FK', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8')
    expect(sql).toMatch(/Classification:\s*REVERSIBLE/)
    expect(sql).toMatch(/TM_CONTROL_PLANE_RUNTIME_PERSISTENCE_V1/)
    const stmts = splitSqlStatements(sql)
    expect(stmts.length).toBeGreaterThanOrEqual(RUNTIME_PERSISTENCE_TABLES.length)
    for (const s of stmts.map((x) => x.toLowerCase())) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
      expect(s).not.toMatch(/foreign\s+key/)
    }
    for (const t of RUNTIME_PERSISTENCE_TABLES) {
      expect(sql).toContain(t)
      expect(sql).toMatch(new RegExp(`CREATE TABLE IF NOT EXISTS ${t}`))
    }
  })

  it('includes fencing / entity_rev / idempotency columns for runtime domains', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8')
    expect(sql).toMatch(/fencing_token/)
    expect(sql).toMatch(/entity_rev/)
    expect(sql).toMatch(/idempotency_key/)
    expect(sql).toMatch(/lease_expires_at_ms/)
    expect(sql).toMatch(/control_plane_dispatch_plan_items/)
    expect(sql).toMatch(/control_plane_reconciler_leaders/)
    expect(sql).toMatch(/control_plane_retention_policies/)
    expect(sql).not.toMatch(/\bpassword\b/)
    expect(sql).not.toMatch(/\baccess_token\b/)
  })

  it('defines MySQL-8 STORED generated active keys + unique HELD invariants', () => {
    const sql = fs.readFileSync(migrationPath, 'utf8')
    // Collision: one HELD per board+scope; NULL when not HELD (history free)
    expect(sql).toMatch(
      /held_scope_key\s+VARCHAR\(400\)\s+GENERATED ALWAYS AS\s*\(\s*CASE WHEN state = 'HELD' THEN scope_id ELSE NULL END\s*\)\s*STORED/i,
    )
    expect(sql).toMatch(/UNIQUE KEY uq_collision_held_scope\s*\(\s*board_id,\s*held_scope_key\s*\)/i)
    // Integration: one HELD per board+repo+branch
    expect(sql).toMatch(
      /held_repo_id\s+VARCHAR\(160\)\s+GENERATED ALWAYS AS\s*\(\s*CASE WHEN state = 'HELD' THEN repo_id ELSE NULL END\s*\)\s*STORED/i,
    )
    expect(sql).toMatch(
      /held_tracking_branch\s+VARCHAR\(255\)\s+GENERATED ALWAYS AS\s*\(\s*CASE WHEN state = 'HELD' THEN tracking_branch ELSE NULL END\s*\)\s*STORED/i,
    )
    expect(sql).toMatch(
      /UNIQUE KEY uq_integration_held_repo_branch\s*\(\s*board_id,\s*held_repo_id,\s*held_tracking_branch\s*\)/i,
    )
  })
})

describe('codecs + JSON cells', () => {
  it('round-trips dispatch plan / run / locks / account / reconciler / retention', () => {
    const plan = samplePlan()
    expect(decodeDispatchPlanRecord(encodeDispatchPlanRecord(plan) as Record<string, unknown>).planId).toBe(
      'plan-1',
    )
    // Via record_json string path
    const planRow = {
      ...encodeDispatchPlanRecord(plan),
      items_json: jsonParam(plan.items),
      record_json: jsonParam(plan),
    }
    const plan2 = decodeDispatchPlanRecord(planRow as Record<string, unknown>)
    expect(plan2.items[0]?.taskId).toBe('task-1')
    expect(plan2.entityRev).toBe(1)

    const run = sampleRun()
    const runRow = {
      ...encodeRunRecord(run),
      collision_scope_lock_ids_json: jsonParam(run.collisionScopeLockIds),
      history_json: jsonParam(run.history),
      record_json: jsonParam(run),
    }
    const run2 = decodeRunRecord(runRow as Record<string, unknown>)
    expect(run2.fencingToken).toBe('fence-abc')
    expect(run2.history).toHaveLength(1)

    const c = sampleCollision()
    expect(decodeCollisionLock({ ...encodeCollisionLock(c), record_json: jsonParam(c) }).scopeId).toBe(
      'resources:db',
    )
    const i = sampleIntegration()
    expect(
      decodeIntegrationLock({ ...encodeIntegrationLock(i), record_json: jsonParam(i) }).pathspecs,
    ).toEqual(['src/**'])

    const snap = sampleAccountSnap()
    const snap2 = decodeAccountSyncSnapshot({
      ...encodeAccountSyncSnapshot(snap),
      accounts_json: jsonParam(snap.accounts),
      capacity_json: jsonParam(snap.capacity),
      readback_surfaces_json: jsonParam(snap.readbackSurfaces),
      record_json: jsonParam(snap),
    })
    expect(snap2.accounts[0]?.maskedAccountId).toBe('m-1')
    expect(snap2.readbackSurfaces.mcp?.sourceRevision).toBe(5)

    const leader: ReconcilerLeaderState = {
      boardId: 'board-a',
      leaderId: 'L1',
      fencingToken: 'rl-1',
      leaseExpiresAtMs: 99_000,
    }
    expect(decodeReconcilerLeader(encodeReconcilerLeader(leader))).toEqual(leader)

    const dry: ReconcileDryRunResult = {
      dryRunId: 'd1',
      dryRunHash: 'd'.repeat(64),
      boardId: 'board-a',
      boardRev: 3,
      leaderToken: 'rl-1',
      cursor: null,
      nextCursor: null,
      maxActions: 100,
      timeBudgetMs: 5000,
      items: [
        {
          runId: 'run-1',
          taskId: 'task-1',
          classification: 'LIVE',
          beforeState: 'RUNNING',
          afterState: null,
          action: 'NONE',
          reason: 'ok',
          reconciliationPending: false,
          doneWithReconciliationOverlay: false,
        },
      ],
      counts: { LIVE: 1, TERMINAL: 0, STALE: 0, ORPHAN: 0, REQUEUE: 0, MANUAL: 0 },
      generatedAtMs: 1_000,
      generatedAt: '2026-07-14T00:00:01.000Z',
    }
    const dry2 = decodeReconcileDryRun({
      ...encodeReconcileDryRun(dry),
      items_json: jsonParam(dry.items),
      counts_json: jsonParam(dry.counts),
      record_json: jsonParam(dry),
    })
    expect(dry2.items[0]?.classification).toBe('LIVE')

    const pol = STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY
    const pol2 = decodeRetentionPolicy({
      ...encodeRetentionPolicy('board-a', pol),
      approved_for_json: jsonParam(pol.approvedFor),
      record_json: jsonParam(pol),
    })
    expect(pol2.policyId).toBe(pol.policyId)
  })

  it('parseJsonCell handles string / object / null', () => {
    expect(parseJsonCell(null)).toBeNull()
    expect(parseJsonCell('{"a":1}')).toEqual({ a: 1 })
    expect(parseJsonCell({ a: 1 })).toEqual({ a: 1 })
    expect(parseJsonCell('not-json')).toBeNull()
  })
})

describe('revision + fencing helpers', () => {
  it('evaluateRuntimeCas succeeds and fails on stale entity/board/hash', () => {
    const current = {
      boardId: 'board-a',
      entityType: 'run',
      entityId: 'run-1',
      entityRev: 2,
      boardRev: 3,
      subjectHash: subjectHashOf({ x: 1 }),
    }
    const ok = evaluateRuntimeCas(current, {
      boardId: 'board-a',
      entityType: 'run',
      entityId: 'run-1',
      entityExpectedRev: 2,
      expectedBoardRev: 3,
      expectedSubjectHash: current.subjectHash!,
      nextSubjectHash: subjectHashOf({ x: 2 }),
    })
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.entityRev).toBe(3)
      expect(ok.boardRev).toBe(4)
    }

    const stale = evaluateRuntimeCas(current, {
      boardId: 'board-a',
      entityType: 'run',
      entityId: 'run-1',
      entityExpectedRev: 1,
      expectedBoardRev: 3,
      expectedSubjectHash: current.subjectHash!,
      nextSubjectHash: subjectHashOf({ x: 2 }),
    })
    expect(stale.ok).toBe(false)
    if (!stale.ok) expect(stale.code).toBe('STALE_REVISION')
  })

  it('assertFencingMatch throws FENCED on mismatch', () => {
    expect(() =>
      assertFencingMatch({
        currentToken: 'a',
        expectedToken: 'a',
        entityId: 'r1',
        kind: 'run',
      }),
    ).not.toThrow()
    try {
      assertFencingMatch({
        currentToken: 'a',
        expectedToken: 'b',
        entityId: 'r1',
        kind: 'run',
      })
      expect.fail('expected throw')
    } catch (e) {
      expect(e).toBeInstanceOf(RuntimePersistenceError)
      expect((e as RuntimePersistenceError).code).toBe('FENCED')
    }
  })

  it('assertCasMutationAllowed rejects fenced and stale puts', () => {
    expect(() =>
      assertCasMutationAllowed({
        existing: null,
        next: { fencingToken: 'f1', entityRev: 1 },
        entityId: 'x',
        kind: 'run',
      }),
    ).not.toThrow()
    expect(() =>
      assertCasMutationAllowed({
        existing: { fencingToken: 'f1', entityRev: 2 },
        next: { fencingToken: 'f1', entityRev: 3 },
        entityId: 'x',
        kind: 'run',
      }),
    ).not.toThrow()
    try {
      assertCasMutationAllowed({
        existing: { fencingToken: 'f1', entityRev: 2 },
        next: { fencingToken: 'f-other', entityRev: 3 },
        entityId: 'x',
        kind: 'run',
      })
      expect.fail('expected FENCED')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('FENCED')
    }
    try {
      assertCasMutationAllowed({
        existing: { fencingToken: 'f1', entityRev: 2 },
        next: { fencingToken: 'f1', entityRev: 2 },
        entityId: 'x',
        kind: 'run',
      })
      expect.fail('expected STALE_REVISION')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('STALE_REVISION')
    }
  })
})

describe('memory-SQL runtime stores (MySQL code paths)', () => {
  it('dispatch plan put/get/list/getActive with board lock', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    const plan = samplePlan()
    await rt.plans.put(plan)
    const got = await rt.plans.get('board-a', 'plan-1')
    expect(got?.planHash).toBe(plan.planHash)
    expect(got?.items[0]?.collisionScopeLockIds).toEqual(['scope-x'])

    await rt.plans.put(samplePlan({ planId: 'plan-2', status: 'SUPERSEDED', generatedAtMs: 1 }))
    const active = await rt.plans.getActive('board-a')
    expect(active?.planId).toBe('plan-1')

    const listed = await rt.plans.list('board-a')
    expect(listed).toHaveLength(2)

    let order: Array<string> = []
    await Promise.all([
      rt.plans.withBoardLock('board-a', async () => {
        order.push('a-start')
        await new Promise((r) => setTimeout(r, 20))
        order.push('a-end')
      }),
      rt.plans.withBoardLock('board-a', async () => {
        order.push('b')
      }),
    ])
    expect(order.indexOf('a-start')).toBeLessThan(order.indexOf('a-end'))
    expect(order.indexOf('a-end')).toBeLessThan(order.indexOf('b'))
  })

  it('V3 run put/get/list + fencing CAS update', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    const run = sampleRun()
    await rt.runs.put(run)
    const got = await rt.runs.get('board-a', 'run-1')
    expect(got?.state).toBe('RUNNING')
    expect(got?.fencingToken).toBe('fence-abc')

    const next = sampleRun({
      heartbeatSequence: 3,
      entityRev: 3,
      heartbeatAtMs: 2_000,
    })
    const casOk = await casUpdateRunWithFencing(rt.exec, next, 'fence-abc', 2)
    expect(casOk).toEqual({ ok: true })

    const casBad = await casUpdateRunWithFencing(
      rt.exec,
      sampleRun({ entityRev: 4, heartbeatSequence: 4 }),
      'wrong-fence',
      3,
    )
    expect(casBad).toEqual({ ok: false, code: 'FENCED' })

    const listed = await rt.runs.list('board-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]?.heartbeatSequence).toBe(3)
  })

  it('collision + integration locks round-trip', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    await rt.locks.putCollision(sampleCollision())
    await rt.locks.putIntegration(sampleIntegration())

    expect((await rt.locks.getCollision('board-a', 'lock-1'))?.fencingToken).toBe('fence-lock')
    expect((await rt.locks.getCollisionByScope('board-a', 'resources:db'))?.lockId).toBe('lock-1')
    expect((await rt.locks.listCollision('board-a')).length).toBe(1)

    const ig = await rt.locks.getIntegration('board-a', 'repo-x', 'feature/a')
    expect(ig?.rootAcceptanceId).toBe('ra-1')
    expect(ig?.pathspecs).toEqual(['src/**'])
    expect((await rt.locks.listIntegration('board-a')).length).toBe(1)
  })

  it('account sync snapshot + readback surface rows', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    const snap = sampleAccountSnap()
    await rt.accounts.put(snap)
    const got = await rt.accounts.get('board-a')
    expect(got?.sourceRevision).toBe(5)
    expect(got?.accounts[0]?.maskedAccountId).toBe('m-1')
    expect(got?.readbackSurfaces.mcp?.sourceRevision).toBe(5)

    // Readback denormalized rows written for mcp+api
    const rb = rt.exec.tables.get('control_plane_account_readbacks')
    expect(rb?.size).toBeGreaterThanOrEqual(2)
  })

  it('reconciler leader/dryrun/apply/task flags + leader fencing CAS', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    const leader: ReconcilerLeaderState = {
      boardId: 'board-a',
      leaderId: 'L1',
      fencingToken: 'rl-1',
      leaseExpiresAtMs: 100_000,
    }
    await rt.reconciler.putLeader(leader)
    expect((await rt.reconciler.getLeader('board-a'))?.leaderId).toBe('L1')

    const renewOk = await casRenewReconcilerLeader(
      rt.exec,
      { ...leader, leaseExpiresAtMs: 200_000, fencingToken: 'rl-2' },
      'rl-1',
    )
    expect(renewOk).toEqual({ ok: true })
    expect((await rt.reconciler.getLeader('board-a'))?.fencingToken).toBe('rl-2')

    const renewBad = await casRenewReconcilerLeader(
      rt.exec,
      { ...leader, fencingToken: 'rl-3' },
      'stale-token',
    )
    expect(renewBad).toEqual({ ok: false, code: 'FENCED' })

    const dry: ReconcileDryRunResult = {
      dryRunId: 'dry-1',
      dryRunHash: 'e'.repeat(64),
      boardId: 'board-a',
      boardRev: 3,
      leaderToken: 'rl-2',
      cursor: null,
      nextCursor: null,
      maxActions: 100,
      timeBudgetMs: 5000,
      items: [],
      counts: { LIVE: 0, TERMINAL: 0, STALE: 0, ORPHAN: 0, REQUEUE: 0, MANUAL: 0 },
      generatedAtMs: 5_000,
      generatedAt: '2026-07-14T00:00:05.000Z',
    }
    await rt.reconciler.putDryRun(dry)
    expect((await rt.reconciler.getDryRun('board-a', dry.dryRunHash))?.dryRunId).toBe('dry-1')

    await rt.reconciler.putLastApplyHash('board-a', dry.dryRunHash)
    expect(await rt.reconciler.getLastApplyHash('board-a')).toBe(dry.dryRunHash)

    expect(await rt.reconciler.isTaskCompleted('board-a', 'task-1')).toBe(false)
    await rt.reconciler.setTaskCompleted('board-a', 'task-1', true)
    expect(await rt.reconciler.isTaskCompleted('board-a', 'task-1')).toBe(true)
  })

  it('retention policy + async hot/audit durable path', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    const policy = STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY
    await rt.retentionPolicy.put('board-a', policy)
    const got = await rt.retentionPolicy.get('board-a')
    expect(got?.policyVersion).toBe(policy.policyVersion)
    expect(got?.approvedFor).toContain('STAGING')

    const hot: HotRunState = {
      runId: 'run-1',
      boardId: 'board-a',
      lastHeartbeatAtMs: 10_000,
      heartbeatSequence: 3,
      status: 'RUNNING',
      materialProgressAtMs: 9_000,
    }
    await rt.retentionAsync.putHot(hot)
    expect((await rt.retentionAsync.getHot('board-a', 'run-1'))?.heartbeatSequence).toBe(3)
    expect((await rt.retentionAsync.listHot('board-a')).length).toBe(1)

    const aud: AuditRecord = {
      id: 'aud-1',
      boardId: 'board-a',
      runId: 'run-1',
      eventClass: 'MATERIAL',
      eventType: 'progress',
      atMs: 10_000,
      immutable: true,
      payload: { ok: true },
    }
    await rt.retentionAsync.appendAudit(aud)
    const listed = await rt.retentionAsync.listAudit('board-a', { immutable: true })
    expect(listed).toHaveLength(1)
    expect(listed[0]?.eventType).toBe('progress')

    // In-process sync retention still works for applyHeartbeat compatibility
    rt.retention.putHot(hot)
    expect(rt.retention.getHot('run-1')?.status).toBe('RUNNING')
  })

  it('RUNTIME_SQL statements reference foundation tables', () => {
    expect(RUNTIME_SQL.putDispatchPlan).toMatch(/control_plane_dispatch_plans/)
    expect(RUNTIME_SQL.putRun).toMatch(/fencing_token/)
    expect(RUNTIME_SQL.casPutRunByFence).toMatch(/UPDATE control_plane_runs/)
    expect(RUNTIME_SQL.putReconcilerLeader).toMatch(/control_plane_reconciler_leaders/)
    expect(RUNTIME_SQL.putRetentionPolicy).toMatch(/control_plane_retention_policies/)
  })

  it('memory executor records SQL calls for put plan', async () => {
    const exec = createMemorySqlExecutor()
    const rt = createMemoryControlPlaneRuntimePersistence()
    // use shared factory's exec
    await rt.plans.put(samplePlan())
    const putCalls = rt.exec.calls.filter((c) =>
      c.sql.includes('INTO control_plane_dispatch_plans'),
    )
    expect(putCalls.length).toBeGreaterThanOrEqual(1)
    expect(putCalls[0]?.params[1]).toBe('plan-1')
    void exec
  })
})

describe('connection-pinned MySQL named lock', () => {
  it('GET_LOCK and RELEASE_LOCK use the same pinned connectionId', async () => {
    const exec = createMemorySqlExecutor()
    expect(typeof exec.getConnection).toBe('function')

    let observedInside = false
    await withMysqlNamedLock(exec, 'board-pin', async () => {
      observedInside = true
      // Lock must still be held on the pinned connection during critical section.
      expect(exec.heldNamedLocks.get('cp_rt_board-pin')).toBeTruthy()
    })
    expect(observedInside).toBe(true)

    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    const relCalls = exec.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
    expect(getCalls.length).toBe(1)
    expect(relCalls.length).toBe(1)
    expect(getCalls[0]!.connectionId).toMatch(/^memory-conn-/)
    expect(relCalls[0]!.connectionId).toBe(getCalls[0]!.connectionId)
    // Pool executor must NOT have run named-lock SQL (would be connection-scoped bug).
    expect(getCalls[0]!.connectionId).not.toBe('memory-pool')
    expect(relCalls[0]!.connectionId).not.toBe('memory-pool')
    // Released after finally
    expect(exec.heldNamedLocks.has('cp_rt_board-pin')).toBe(false)
  })

  it('RELEASE_LOCK on a different connection cannot free the lock (proves pin requirement)', async () => {
    const exec = createMemorySqlExecutor()
    const pinnedA = await exec.getConnection!()
    const pinnedB = await exec.getConnection!()
    try {
      const acq = await pinnedA.execute<{ l: number }>('SELECT GET_LOCK(?, 10) AS l', [
        'cp_rt_diff',
      ])
      expect(asNumberLike(acq.rows[0]?.l)).toBe(1)
      const badRel = await pinnedB.execute<{ r: number }>('SELECT RELEASE_LOCK(?) AS r', [
        'cp_rt_diff',
      ])
      expect(asNumberLike(badRel.rows[0]?.r)).toBe(0)
      expect(exec.heldNamedLocks.get('cp_rt_diff')).toBe(pinnedA.connectionId)
      const goodRel = await pinnedA.execute<{ r: number }>('SELECT RELEASE_LOCK(?) AS r', [
        'cp_rt_diff',
      ])
      expect(asNumberLike(goodRel.rows[0]?.r)).toBe(1)
    } finally {
      pinnedA.release()
      pinnedB.release()
    }
  })

  it('withMysqlNamedLock without getConnection fails closed', async () => {
    const bare = {
      async execute() {
        return { rows: [], affectedRows: 0 }
      },
    }
    await expect(withMysqlNamedLock(bare, 'b', async () => 1)).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
  })

  it('nested same context + same lockName: exactly one GET_LOCK + one RELEASE on same pin', async () => {
    const exec = createMemorySqlExecutor()
    let nestedSawHeld = false
    let outerConn: string | undefined
    let innerConn: string | undefined

    await withMysqlNamedLock(exec, 'board-re', async () => {
      outerConn = exec.heldNamedLocks.get('cp_rt_board-re')
      expect(outerConn).toMatch(/^memory-conn-/)
      await withMysqlNamedLock(exec, 'board-re', async () => {
        nestedSawHeld = true
        innerConn = exec.heldNamedLocks.get('cp_rt_board-re')
        // Still held by the outer pin — no second connection acquired the lock.
        expect(innerConn).toBe(outerConn)
      })
      // Outer still holds after inner returns (refcount / context unwind).
      expect(exec.heldNamedLocks.get('cp_rt_board-re')).toBe(outerConn)
    })

    expect(nestedSawHeld).toBe(true)
    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    const relCalls = exec.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
    expect(getCalls).toHaveLength(1)
    expect(relCalls).toHaveLength(1)
    expect(getCalls[0]!.connectionId).toBe(relCalls[0]!.connectionId)
    expect(getCalls[0]!.connectionId).toBe(outerConn)
    expect(exec.heldNamedLocks.has('cp_rt_board-re')).toBe(false)
  })

  it('independent concurrent async contexts are not treated as reentrant', async () => {
    const exec = createMemorySqlExecutor()
    let firstEntered = false
    let secondRejected = false

    const first = withMysqlNamedLock(exec, 'board-indep', async () => {
      firstEntered = true
      // Hold long enough for concurrent peer to attempt GET_LOCK on another pin.
      await new Promise((r) => setTimeout(r, 30))
      return 'first'
    })

    // Yield so first acquires the lock before second starts.
    await new Promise((r) => setTimeout(r, 5))
    const second = withMysqlNamedLock(exec, 'board-indep', async () => 'second').then(
      () => {
        throw new Error('second should not enter critical section')
      },
      (e: unknown) => {
        secondRejected = true
        expect(e).toMatchObject({ code: 'DATA_INTEGRITY' })
        return 'rejected'
      },
    )

    const [a, b] = await Promise.all([first, second])
    expect(a).toBe('first')
    expect(b).toBe('rejected')
    expect(firstEntered).toBe(true)
    expect(secondRejected).toBe(true)
    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    // Two independent contexts each open a pin and issue GET_LOCK.
    expect(getCalls.length).toBeGreaterThanOrEqual(2)
    expect(exec.heldNamedLocks.has('cp_rt_board-indep')).toBe(false)
  })

  it('different lock names in same context acquire independently', async () => {
    const exec = createMemorySqlExecutor()
    await withMysqlNamedLock(exec, 'board-a', async () => {
      expect(exec.heldNamedLocks.get('cp_rt_board-a')).toMatch(/^memory-conn-/)
      await withMysqlNamedLock(exec, 'board-b', async () => {
        expect(exec.heldNamedLocks.get('cp_rt_board-a')).toMatch(/^memory-conn-/)
        expect(exec.heldNamedLocks.get('cp_rt_board-b')).toMatch(/^memory-conn-/)
        // Different pins for different lock names.
        expect(exec.heldNamedLocks.get('cp_rt_board-a')).not.toBe(
          exec.heldNamedLocks.get('cp_rt_board-b'),
        )
      })
      expect(exec.heldNamedLocks.has('cp_rt_board-b')).toBe(false)
      expect(exec.heldNamedLocks.get('cp_rt_board-a')).toMatch(/^memory-conn-/)
    })
    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    const relCalls = exec.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
    expect(getCalls).toHaveLength(2)
    expect(relCalls).toHaveLength(2)
    expect(exec.heldNamedLocks.size).toBe(0)
  })

  it('thrown inner and outer still clean up pin/lock (no leak)', async () => {
    const exec = createMemorySqlExecutor()

    await expect(
      withMysqlNamedLock(exec, 'board-throw-inner', async () => {
        await withMysqlNamedLock(exec, 'board-throw-inner', async () => {
          throw new Error('inner-boom')
        })
      }),
    ).rejects.toThrow('inner-boom')
    expect(exec.heldNamedLocks.has('cp_rt_board-throw-inner')).toBe(false)

    await expect(
      withMysqlNamedLock(exec, 'board-throw-outer', async () => {
        await withMysqlNamedLock(exec, 'board-throw-outer', async () => 'ok')
        throw new Error('outer-boom')
      }),
    ).rejects.toThrow('outer-boom')
    expect(exec.heldNamedLocks.has('cp_rt_board-throw-outer')).toBe(false)

    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    const relCalls = exec.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
    // Two outer frames (inner throw + outer throw suites) → 2 GET + 2 RELEASE
    expect(getCalls).toHaveLength(2)
    expect(relCalls).toHaveLength(2)
  })

  it('nested runs.withBoardLock → locks.withBoardLock same exec reuses single GET_LOCK', async () => {
    // Mirrors register outer + acquireCollisionLocks inner (same boardId, shared exec).
    const exec = createMemorySqlExecutor()
    const runs = createMysqlRunRegistryStore(exec, { useNamedLock: true })
    const locks = createMysqlLockStore(exec, { useNamedLock: true })
    let nested = false
    await runs.withBoardLock('board-nest', async () => {
      await locks.withBoardLock('board-nest', async () => {
        nested = true
        expect(exec.heldNamedLocks.get('cp_rt_board-nest')).toMatch(/^memory-conn-/)
      })
    })
    expect(nested).toBe(true)
    const getCalls = exec.calls.filter((c) => /SELECT GET_LOCK/i.test(c.sql))
    const relCalls = exec.calls.filter((c) => /SELECT RELEASE_LOCK/i.test(c.sql))
    expect(getCalls).toHaveLength(1)
    expect(relCalls).toHaveLength(1)
    expect(getCalls[0]!.connectionId).toBe(relCalls[0]!.connectionId)
    expect(exec.heldNamedLocks.has('cp_rt_board-nest')).toBe(false)
  })
})

describe('store put CAS rejects stale/fenced overwrites', () => {
  it('run put rejects fenced actor and stale entity_rev without overwriting', async () => {
    const exec = createMemorySqlExecutor()
    const runs = createMysqlRunRegistryStore(exec)
    const base = sampleRun({ entityRev: 2, fencingToken: 'fence-abc', heartbeatSequence: 2 })
    await runs.put(base)
    const before = await runs.get('board-a', 'run-1')
    expect(before?.heartbeatSequence).toBe(2)

    // Fenced: wrong token, higher rev — must not overwrite
    await expect(
      runs.put(
        sampleRun({
          entityRev: 3,
          fencingToken: 'fence-STALE-ACTOR',
          heartbeatSequence: 99,
        }),
      ),
    ).rejects.toMatchObject({ code: 'FENCED' })
    expect((await runs.get('board-a', 'run-1'))?.heartbeatSequence).toBe(2)
    expect((await runs.get('board-a', 'run-1'))?.fencingToken).toBe('fence-abc')

    // Stale: same fence, entity_rev not advanced
    await expect(
      runs.put(sampleRun({ entityRev: 2, fencingToken: 'fence-abc', heartbeatSequence: 88 })),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
    expect((await runs.get('board-a', 'run-1'))?.heartbeatSequence).toBe(2)

    // Valid CAS advance
    await runs.put(sampleRun({ entityRev: 3, fencingToken: 'fence-abc', heartbeatSequence: 3 }))
    expect((await runs.get('board-a', 'run-1'))?.heartbeatSequence).toBe(3)
    expect((await runs.get('board-a', 'run-1'))?.entityRev).toBe(3)

    // casUpdateRunWithFencing still returns structured failure for wrong fence
    const casBad = await casUpdateRunWithFencing(
      exec,
      sampleRun({ entityRev: 4, heartbeatSequence: 4 }),
      'wrong-fence',
      3,
    )
    expect(casBad).toEqual({ ok: false, code: 'FENCED' })
    expect((await runs.get('board-a', 'run-1'))?.heartbeatSequence).toBe(3)
  })

  it('collision lock put rejects fenced/stale overwrites; same content is idempotent', async () => {
    const exec = createMemorySqlExecutor()
    const locks = createMysqlLockStore(exec)
    await locks.putCollision(sampleCollision({ entityRev: 1, fencingToken: 'fence-lock' }))

    await expect(
      locks.putCollision(
        sampleCollision({ entityRev: 2, fencingToken: 'wrong', state: 'RELEASED' }),
      ),
    ).rejects.toMatchObject({ code: 'FENCED' })
    expect((await locks.getCollision('board-a', 'lock-1'))?.state).toBe('HELD')

    // Exact same PK + canonical content: insert-idempotent replay (no write)
    await locks.putCollision(sampleCollision({ entityRev: 1, fencingToken: 'fence-lock' }))
    expect((await locks.getCollision('board-a', 'lock-1'))?.runId).toBe('run-1')

    // Same PK, different payload, not a CAS advance → IDEMPOTENCY_CONFLICT (never ODKU)
    await expect(
      locks.putCollision(
        sampleCollision({
          entityRev: 1,
          fencingToken: 'fence-lock',
          runId: 'run-hijack',
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect((await locks.getCollision('board-a', 'lock-1'))?.runId).toBe('run-1')

    // Valid CAS advance via fence + higher entity_rev
    await locks.putCollision(
      sampleCollision({ entityRev: 2, fencingToken: 'fence-lock', state: 'RELEASED' }),
    )
    expect((await locks.getCollision('board-a', 'lock-1'))?.state).toBe('RELEASED')

    const casBad = await casUpdateCollisionWithFencing(
      exec,
      sampleCollision({ entityRev: 3, fencingToken: 'fence-lock' }),
      'nope',
      2,
    )
    expect(casBad).toEqual({ ok: false, code: 'FENCED' })
  })

  it('reconciler putLeader rejects fenced takeover while lease live', async () => {
    const exec = createMemorySqlExecutor()
    const reconciler = createMysqlReconcilerStore(exec)
    const farFuture = Date.now() + 60_000_000
    await reconciler.putLeader({
      boardId: 'board-a',
      leaderId: 'L1',
      fencingToken: 'rl-1',
      leaseExpiresAtMs: farFuture,
    })
    expect((await reconciler.getLeader('board-a'))?.leaderId).toBe('L1')

    // Same fence renew OK
    await reconciler.putLeader({
      boardId: 'board-a',
      leaderId: 'L1',
      fencingToken: 'rl-1',
      leaseExpiresAtMs: farFuture + 1_000,
    })
    expect((await reconciler.getLeader('board-a'))?.leaseExpiresAtMs).toBe(farFuture + 1_000)

    // Different fence while lease live → FENCED, no overwrite
    await expect(
      reconciler.putLeader({
        boardId: 'board-a',
        leaderId: 'L2-intruder',
        fencingToken: 'rl-INTRUDER',
        leaseExpiresAtMs: farFuture + 9_000,
      }),
    ).rejects.toMatchObject({ code: 'FENCED' })
    expect((await reconciler.getLeader('board-a'))?.leaderId).toBe('L1')
    expect((await reconciler.getLeader('board-a'))?.fencingToken).toBe('rl-1')

    // Expired lease allows transfer with new fence
    await reconciler.putLeader({
      boardId: 'board-a',
      leaderId: 'L1',
      fencingToken: 'rl-1',
      leaseExpiresAtMs: Date.now() - 1,
    })
    await reconciler.putLeader({
      boardId: 'board-a',
      leaderId: 'L2',
      fencingToken: 'rl-2',
      leaseExpiresAtMs: farFuture,
    })
    expect((await reconciler.getLeader('board-a'))?.leaderId).toBe('L2')
    expect((await reconciler.getLeader('board-a'))?.fencingToken).toBe('rl-2')
  })
})

function asNumberLike(v: unknown): number {
  if (typeof v === 'number') return v
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v)
  return 0
}

describe('multi-process HELD unique invariants', () => {
  it('lock insert SQL is plain INSERT (no ON DUPLICATE KEY UPDATE hijack)', () => {
    expect(RUNTIME_SQL.putCollisionLock).toMatch(/INSERT\s+INTO\s+control_plane_collision_locks/i)
    expect(RUNTIME_SQL.putCollisionLock).not.toMatch(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i)
    expect(RUNTIME_SQL.putIntegrationLock).toMatch(
      /INSERT\s+INTO\s+control_plane_integration_locks/i,
    )
    expect(RUNTIME_SQL.putIntegrationLock).not.toMatch(/ON\s+DUPLICATE\s+KEY\s+UPDATE/i)
    // Updates remain CAS-only
    expect(RUNTIME_SQL.casPutCollisionByFence).toMatch(/^[\s]*UPDATE\s+control_plane_collision_locks/i)
    expect(RUNTIME_SQL.casPutIntegrationByFence).toMatch(
      /^[\s]*UPDATE\s+control_plane_integration_locks/i,
    )
  })

  it('rejects second simultaneous HELD collision lock on same board+scope (cross-task)', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    await rt.locks.putCollision(
      sampleCollision({
        lockId: 'lock-task-a',
        taskId: 'task-a',
        runId: 'run-a',
        scopeId: 'resources:db',
        state: 'HELD',
        fencingToken: 'fence-a',
        entityRev: 1,
      }),
    )
    await expect(
      rt.locks.putCollision(
        sampleCollision({
          lockId: 'lock-task-b',
          taskId: 'task-b',
          runId: 'run-b',
          scopeId: 'resources:db',
          state: 'HELD',
          fencingToken: 'fence-b',
          entityRev: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLAIM_COLLISION' })
    // Winner unchanged
    const held = await rt.locks.getCollisionByScope('board-a', 'resources:db')
    expect(held?.lockId).toBe('lock-task-a')
    expect(held?.taskId).toBe('task-a')
  })

  it('rejects second simultaneous HELD integration lock on same repo+trackingBranch', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    await rt.locks.putIntegration(
      sampleIntegration({
        lockId: 'ilock-a',
        runId: 'run-a',
        repoId: 'repo-x',
        trackingBranch: 'feature/a',
        state: 'HELD',
        fencingToken: 'fence-ia',
        entityRev: 1,
      }),
    )
    await expect(
      rt.locks.putIntegration(
        sampleIntegration({
          lockId: 'ilock-b',
          runId: 'run-b',
          repoId: 'repo-x',
          trackingBranch: 'feature/a',
          state: 'HELD',
          fencingToken: 'fence-ib',
          entityRev: 1,
        }),
      ),
    ).rejects.toMatchObject({ code: 'CLAIM_COLLISION' })
    const held = await rt.locks.getIntegration('board-a', 'repo-x', 'feature/a')
    expect(held?.lockId).toBe('ilock-a')
    expect(held?.runId).toBe('run-a')
  })

  it('memory concurrent collision insert race: exactly one fulfilled, owner unchanged', async () => {
    // Two stores share durable memory tables — no board-lock serialization on put path.
    const shared = createMemorySqlExecutor()
    const storeA = createMysqlLockStore(shared)
    const storeB = createMysqlLockStore(shared)
    const a = sampleCollision({
      lockId: 'lock-rA',
      taskId: 'task-a',
      runId: 'run-rA',
      scopeId: 'resources:race-scope',
      state: 'HELD',
      fencingToken: 'fence-rA',
      entityRev: 1,
    })
    const b = sampleCollision({
      lockId: 'lock-rB',
      taskId: 'task-b',
      runId: 'run-rB',
      scopeId: 'resources:race-scope',
      state: 'HELD',
      fencingToken: 'fence-rB',
      entityRev: 1,
    })
    const results = await Promise.allSettled([
      storeA.putCollision(a),
      storeB.putCollision(b),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CLAIM_COLLISION',
    })
    const held = await storeA.getCollisionByScope('board-a', 'resources:race-scope')
    expect(held).not.toBeNull()
    // Winner is either rA or rB, but run_id must match that lock_id (no ODKU hijack).
    if (held!.lockId === 'lock-rA') {
      expect(held!.runId).toBe('run-rA')
      expect(held!.taskId).toBe('task-a')
      expect(await storeA.getCollision('board-a', 'lock-rB')).toBeNull()
    } else {
      expect(held!.lockId).toBe('lock-rB')
      expect(held!.runId).toBe('run-rB')
      expect(held!.taskId).toBe('task-b')
      expect(await storeA.getCollision('board-a', 'lock-rA')).toBeNull()
    }
    // Exactly one row for the board scope path
    const listed = await storeA.listCollision('board-a')
    expect(listed.filter((r) => r.scopeId === 'resources:race-scope' && r.state === 'HELD')).toHaveLength(
      1,
    )
  })

  it('memory concurrent integration insert race: exactly one fulfilled, owner unchanged', async () => {
    const shared = createMemorySqlExecutor()
    const storeA = createMysqlLockStore(shared)
    const storeB = createMysqlLockStore(shared)
    const a = sampleIntegration({
      lockId: 'ilock-rA',
      runId: 'run-rA',
      repoId: 'repo-race',
      trackingBranch: 'feature/race',
      state: 'HELD',
      fencingToken: 'fence-ia',
      entityRev: 1,
    })
    const b = sampleIntegration({
      lockId: 'ilock-rB',
      runId: 'run-rB',
      repoId: 'repo-race',
      trackingBranch: 'feature/race',
      state: 'HELD',
      fencingToken: 'fence-ib',
      entityRev: 1,
    })
    const results = await Promise.allSettled([
      storeA.putIntegration(a),
      storeB.putIntegration(b),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(1)
    expect((rejected[0] as PromiseRejectedResult).reason).toMatchObject({
      code: 'CLAIM_COLLISION',
    })
    const held = await storeA.getIntegration('board-a', 'repo-race', 'feature/race')
    expect(held).not.toBeNull()
    if (held!.lockId === 'ilock-rA') {
      expect(held!.runId).toBe('run-rA')
    } else {
      expect(held!.lockId).toBe('ilock-rB')
      expect(held!.runId).toBe('run-rB')
    }
  })

  it('allows RELEASED/terminal history rows after HELD release; new HELD may reacquire', async () => {
    const rt = createMemoryControlPlaneRuntimePersistence()
    // Collision history
    await rt.locks.putCollision(
      sampleCollision({
        lockId: 'lock-1',
        scopeId: 'resources:db',
        state: 'HELD',
        fencingToken: 'f1',
        entityRev: 1,
      }),
    )
    await rt.locks.putCollision(
      sampleCollision({
        lockId: 'lock-1',
        scopeId: 'resources:db',
        state: 'RELEASED',
        releasedAtMs: 50_000,
        fencingToken: 'f1',
        entityRev: 2,
      }),
    )
    // Another released history row on same scope (different lock_id) is allowed
    await rt.locks.putCollision(
      sampleCollision({
        lockId: 'lock-hist-2',
        scopeId: 'resources:db',
        state: 'RELEASED',
        releasedAtMs: 40_000,
        fencingToken: 'f-hist',
        entityRev: 1,
      }),
    )
    expect((await rt.locks.getCollisionByScope('board-a', 'resources:db'))).toBeNull()
    // New HELD after history
    await rt.locks.putCollision(
      sampleCollision({
        lockId: 'lock-3',
        taskId: 'task-3',
        scopeId: 'resources:db',
        state: 'HELD',
        fencingToken: 'f3',
        entityRev: 1,
      }),
    )
    expect((await rt.locks.getCollisionByScope('board-a', 'resources:db'))?.lockId).toBe('lock-3')
    expect((await rt.locks.listCollision('board-a')).length).toBe(3)

    // Integration history
    await rt.locks.putIntegration(
      sampleIntegration({
        lockId: 'ilock-1',
        state: 'HELD',
        fencingToken: 'fi1',
        entityRev: 1,
      }),
    )
    await rt.locks.putIntegration(
      sampleIntegration({
        lockId: 'ilock-1',
        state: 'RELEASED',
        releasedAtMs: 50_000,
        fencingToken: 'fi1',
        entityRev: 2,
      }),
    )
    expect(await rt.locks.getIntegration('board-a', 'repo-x', 'feature/a')).toBeNull()
    await rt.locks.putIntegration(
      sampleIntegration({
        lockId: 'ilock-hist',
        state: 'RELEASED',
        releasedAtMs: 30_000,
        fencingToken: 'fi-h',
        entityRev: 1,
      }),
    )
    await rt.locks.putIntegration(
      sampleIntegration({
        lockId: 'ilock-new',
        runId: 'run-new',
        state: 'HELD',
        fencingToken: 'fi-new',
        entityRev: 1,
      }),
    )
    expect((await rt.locks.getIntegration('board-a', 'repo-x', 'feature/a'))?.lockId).toBe(
      'ilock-new',
    )
    expect((await rt.locks.listIntegration('board-a')).length).toBe(3)
  })
})

describe('MySQL runtime factory fail-closed + retention durable path', () => {
  it('default factory rejects missing useNamedLock and missing getConnection', () => {
    const exec = createMemorySqlExecutor()
    expect(() => createMysqlControlPlaneRuntimePersistence(exec)).toThrow(RuntimePersistenceError)
    try {
      createMysqlControlPlaneRuntimePersistence(exec)
      expect.fail('expected throw')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('INVALID_INPUT')
      expect((e as RuntimePersistenceError).message).toMatch(/useNamedLock:\s*true/)
    }
    try {
      createMysqlControlPlaneRuntimePersistence(exec, { useNamedLock: false })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('INVALID_INPUT')
    }
    // Explicit false-y default path (opts omitted) already covered; bare executor without pin:
    const bare: { execute: typeof exec.execute } = {
      async execute(sql, params) {
        return exec.execute(sql, params)
      },
    }
    try {
      createMysqlControlPlaneRuntimePersistence(bare as never, { useNamedLock: true })
      expect.fail('expected throw')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('INVALID_INPUT')
      expect((e as RuntimePersistenceError).message).toMatch(/getConnection/)
    }
  })

  it('MySQL factory with useNamedLock:true succeeds; sync retention fail-closed; memory factory allowed', async () => {
    const exec = createMemorySqlExecutor()
    const mysql = createMysqlControlPlaneRuntimePersistence(exec, { useNamedLock: true })
    expect(mysql.mode).toBe('mysql')
    expect(() =>
      mysql.retention.putHot({
        runId: 'run-1',
        boardId: 'board-a',
        lastHeartbeatAtMs: 1,
        heartbeatSequence: 1,
        status: 'RUNNING',
        materialProgressAtMs: null,
      }),
    ).toThrow(RuntimePersistenceError)
    try {
      mysql.retention.getHot('run-1')
      expect.fail('expected fail-closed sync retention')
    } catch (e) {
      expect((e as RuntimePersistenceError).code).toBe('INVALID_INPUT')
      expect((e as RuntimePersistenceError).message).toMatch(/createMysqlRetentionAsyncStore/)
    }

    // Explicit memory factory remains the only in-process default path
    const mem = createMemoryControlPlaneRuntimePersistence()
    expect(mem.mode).toBe('memory')
    mem.retention.putHot({
      runId: 'run-m',
      boardId: 'board-a',
      lastHeartbeatAtMs: 2,
      heartbeatSequence: 1,
      status: 'RUNNING',
      materialProgressAtMs: null,
    })
    expect(mem.retention.getHot('run-m')?.runId).toBe('run-m')
  })

  it('retentionAsync is restart-visible across two mysql bundles sharing durable executor', async () => {
    const shared = createMemorySqlExecutor()
    const instanceA = createMysqlControlPlaneRuntimePersistence(shared, { useNamedLock: true })
    const hot: HotRunState = {
      runId: 'run-restart',
      boardId: 'board-a',
      lastHeartbeatAtMs: 42_000,
      heartbeatSequence: 7,
      status: 'RUNNING',
      materialProgressAtMs: 41_000,
    }
    await instanceA.retentionAsync.putHot(hot)
    const aud: AuditRecord = {
      id: 'aud-restart',
      boardId: 'board-a',
      runId: 'run-restart',
      eventClass: 'MATERIAL',
      eventType: 'progress',
      atMs: 42_000,
      immutable: true,
      payload: { seq: 7 },
    }
    await instanceA.retentionAsync.appendAudit(aud)

    // "Restart": new process bundle, same durable store (shared executor tables)
    const instanceB = createMysqlControlPlaneRuntimePersistence(shared, { useNamedLock: true })
    const gotHot = await instanceB.retentionAsync.getHot('board-a', 'run-restart')
    expect(gotHot?.heartbeatSequence).toBe(7)
    expect(gotHot?.lastHeartbeatAtMs).toBe(42_000)
    const listed = await instanceB.retentionAsync.listAudit('board-a', { immutable: true })
    expect(listed.some((r) => r.id === 'aud-restart')).toBe(true)

    // Sync retention on mysql is NOT the live path — process-local write would not be visible
    expect(() => instanceB.retention.putHot(hot)).toThrow(RuntimePersistenceError)
  })
})
