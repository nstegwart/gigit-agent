import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import type { WorkTask, Run } from '#/lib/types'
import {
  buildControlCenterAggregationFromSources,
  buildPriorityPacketsFromDurable,
  deriveClaimStateFromRunRecord,
  deriveDurableOwnership,
  deriveFeatureFlowBranch,
  isControlCenterBoard,
  mapTaskClassification,
  mapWorkTaskToControlCenterInput,
  rawBoardFromCanonicalProjection,
  resolveControlCenterDefinitionLoad,
  workTasksFromCanonicalProjection,
  CONTROL_CENTER_PRIMARY_NAV_IDS,
} from '#/server/control-center-ui-adapter'
import {
  createMemoryControlPlaneRuntimeContext,
  resetControlPlaneRuntimeContextForTests,
  setTestControlPlaneRuntimeContext,
} from '#/server/control-plane-runtime-context'
import { applyImport } from '#/server/canonical-import'
import { buildCanonicalSnapshotFromReplaceBoardArgs } from '#/server/board-mcp'
import { seedBoardRevision } from '#/server/control-data-persistence'
import { projectCanonicalDefinition } from '#/server/canonical-read-model'
import {
  envelopePinIdentity,
  projectAllSurfaces,
  projectOps,
  projectOverview,
  projectWork,
  projectPriority,
  stripSensitiveFields,
  type ControlCenterPin,
} from '#/server/control-center-ui'
import type { ClassificationReceipt } from '#/lib/control-plane-types'
import type { AccountSyncSnapshot } from '#/server/account-sync'
import type { RunRecord } from '#/server/run-registry'

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'cc-mfs-test',
  canonicalHash: 'hash_aaaaaaaaaaaaaaaa',
  taskHash: 'taskhash_bbbbbbbbbbbb',
  boardRev: 1,
  lifecycleRev: 0,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 0,
  stale: false,
  staleReason: null,
}

function bareTask(id: string, extra: Partial<WorkTask> = {}): WorkTask {
  return {
    id,
    title: `Task ${id}`,
    dependencies: [],
    impacts: [],
    checkpoints: [],
    ...extra,
  }
}

describe('control-center-ui-adapter', () => {
  it('mfs-rebuild is control-center board; nine primary nav ids', () => {
    expect(isControlCenterBoard('mfs-rebuild')).toBe(true)
    expect(isControlCenterBoard('ibils')).toBe(false)
    expect(CONTROL_CENTER_PRIMARY_NAV_IDS).toHaveLength(9)
    expect(CONTROL_CENTER_PRIMARY_NAV_IDS).toContain('overview')
    expect(CONTROL_CENTER_PRIMARY_NAV_IDS).toContain('evidence')
  })

  it('missing proof → UNCLASSIFIED (never PRODUCT from phase/pct)', () => {
    const t = bareTask('T1', {
      phase: 'PROD_READY',
      mappingPct: 100,
      status: 'done',
      lifecycleStage: 'PROD_READY',
    })
    const cls = mapTaskClassification(t, PIN)
    expect(cls.taskClass).toBe('UNCLASSIFIED')
    expect(cls.disposition).toBe('UNCLASSIFIED')
    expect(cls.receipt).toBeNull()

    const input = mapWorkTaskToControlCenterInput(t, PIN)
    expect(input.classification.taskClass).toBe('UNCLASSIFIED')
    expect(input.eligible).toBe(false)
    expect(input.priorityMembership).toBe(false)
  })

  it('valid receipt classification is preserved (not rewritten)', () => {
    const receipt: ClassificationReceipt = {
      receiptId: 'r1',
      receiptHash: 'abcdef0123456789abcdef01',
      taskId: 'T-OK',
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipProofHash: 'proofhash_cccc',
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      taskHash: PIN.taskHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      issuedAt: '2026-07-13T00:00:00.000Z',
    }
    const t = bareTask('T-OK', {}) as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    t.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt,
    }
    const cls = mapTaskClassification(t, PIN)
    expect(cls.taskClass).toBe('PRODUCT')
    expect(cls.disposition).toBe('ACTIVE')
    expect(cls.receipt?.receiptId).toBe('r1')
  })

  it('top-level classificationReceipt on light task is preserved (list-path shape)', () => {
    const receipt: ClassificationReceipt = {
      receiptId: 'r-light',
      receiptHash: 'abcdef0123456789abcdef01',
      taskId: 'T-LIGHT',
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      taskHash: PIN.taskHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      issuedAt: '2026-07-13T00:00:00.000Z',
    }
    const t = bareTask('T-LIGHT', {}) as WorkTask & {
      taskClass: 'PRODUCT'
      disposition: 'ACTIVE'
      classificationReceipt: ClassificationReceipt
    }
    t.taskClass = 'PRODUCT'
    t.disposition = 'ACTIVE'
    t.classificationReceipt = receipt
    const cls = mapTaskClassification(t, PIN)
    expect(cls.taskClass).toBe('PRODUCT')
    expect(cls.receipt?.receiptId).toBe('r-light')
  })

  it('aggregation fail-closed BLOCKED:DATA_INTEGRITY path + one-pin projection', () => {
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [{ id: 'p1', nama: 'P1' }],
      features: [{ id: 'f1', nama: 'F1', projectId: 'p1', fase: 'build', checklist: [] }],
      runs: [],
      decisions: [],
      log: [{ tanggal: '2026-07-13', teks: 'hello audit' }],
      collab: { comments: {}, activity: [] },
    } as never

    const tasks = [bareTask('T-A'), bareTask('T-B', { phase: 'done', mappingPct: 100 })]
    const accountSyncSnapshot: AccountSyncSnapshot = {
      boardId: 'mfs-rebuild',
      sourceRevision: 77,
      generatedAt: PIN.generatedAt,
      generatedAtMs: Date.parse(PIN.generatedAt),
      accounts: [
        {
          maskedAccountId: 'acc_***_xyz9',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 2,
          physicalSlotsDisplay: '0/2',
          adaptiveQuotaState: null,
          reason: null,
          statusChangedAt: null,
          tombstone: false,
        },
      ],
      readbackSurfaces: {
        mcp: { sourceRevision: 77, generatedAt: PIN.generatedAt },
        api: { sourceRevision: 77, generatedAt: PIN.generatedAt },
        ui: { sourceRevision: 77, generatedAt: PIN.generatedAt },
        ops: { sourceRevision: 77, generatedAt: PIN.generatedAt },
      },
      publishedAtMs: Date.parse(PIN.generatedAt),
      lastPeriodicHealthAtMs: Date.parse(PIN.generatedAt),
      stale: false,
      staleReason: null,
      usableCapacity: 2,
      capacity: {
        sparkLive: 0,
        sparkCap: 10,
        solLive: 0,
        solCap: 10,
        grokLive: 0,
        grokPerAccount: [],
        grokMajority: false,
        healthyGrokUsableCapacity: 2,
        combinedLive: 0,
        combinedCap: 200,
        floorTarget: 60,
        floorMet: false,
        belowFloor: true,
        belowFloorReason: 'BELOW_FLOOR',
        usableCapacity: 2,
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
    }
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks,
      opsAccounts: [{ id: 'secret-token-xyz', status: 'ACTIVE', usable: true, cap: 2, inUse: 0 }],
      runs: [],
      boardContentHash: 'contenthash_dddddddddddd',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      accountSyncSnapshot,
    })

    // No valid receipts → unclassified tracked → DATA_INTEGRITY section note
    expect(agg.sectionErrors.some((e) => e.code === 'DATA_INTEGRITY')).toBe(true)
    expect(agg.rollup.unclassifiedCount).toBeGreaterThan(0)

    const all = projectAllSurfaces(agg)
    const pins = Object.values(all).map((e) => envelopePinIdentity(e))
    const first = pins[0]
    for (const p of pins) {
      expect(p).toEqual(first)
    }

    // Sensitive strip: raw secret never present; C2 masked id projected
    const ops = all.ops
    expect(JSON.stringify(ops)).not.toMatch(/secret-token-xyz/)
    expect(ops.data?.accounts[0]?.maskedAccountId).toMatch(/^acc_/)
    expect(ops.data?.sourceRevision).toBe(77)
    expect(ops.data?.sourceRevision).not.toBe(ops.boardRev)

    // Overview / work / priority surface states honest
    const overview = projectOverview(agg)
    expect(overview.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    expect(overview.data.unclassifiedCount).toBe(agg.rollup.unclassifiedCount)

    const work = projectWork(agg, { bucket: 'BLOCKED' })
    expect(work.surface).toBe('work')
    expect(work.data.filter.bucket).toBe('BLOCKED')

    const priority = projectPriority(agg)
    expect(priority.data.majorityAllocationDisplay === 'N-A' || typeof priority.data.majorityAllocationDisplay === 'string').toBe(
      true,
    )
    expect(priority.data.priority.portfolioId).toBe('SALES_WEB_RELATED_BACKEND')
  })

  it('missing account-sync snapshot → fail-closed usableCapacity=0; legacy ops not capacity authority', () => {
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [],
      opsAccounts: [{ id: 'legacy-acc', status: 'ACTIVE', usable: true, cap: 99, inUse: 0 }],
      runs: [],
      boardContentHash: 'hash_no_account_sync',
      boardRev: 5,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })
    expect(agg.accounts).toHaveLength(0)
    expect(agg.accountSyncMeta?.authoritative).toBe(false)
    expect(agg.sectionErrors.some((e) => e.code === 'ACCOUNT_SYNC_MISSING')).toBe(true)
    const ops = projectOps(agg)
    expect(ops.data.usableCapacity).toBe(0)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.sourceRevision).toBeNull()
    expect(ops.data.sourceRevision).not.toBe(5)
    expect(JSON.stringify(ops)).not.toMatch(/legacy-acc/)
  })

  it('stale account-sync → usableCapacity=0 even when caps present; LIMIT/BAN excluded from sum path', () => {
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const snap: AccountSyncSnapshot = {
      boardId: 'mfs-rebuild',
      sourceRevision: 9,
      generatedAt: PIN.generatedAt,
      generatedAtMs: Date.parse(PIN.generatedAt),
      accounts: [
        {
          maskedAccountId: 'acc_***ok01',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
          physicalSlotsDisplay: '0/5',
          adaptiveQuotaState: null,
          reason: null,
          statusChangedAt: null,
          tombstone: false,
        },
        {
          maskedAccountId: 'acc_***lim1',
          status: 'LIMIT',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
          physicalSlotsDisplay: '0/5',
          adaptiveQuotaState: null,
          reason: 'rate',
          statusChangedAt: null,
          tombstone: false,
        },
        {
          maskedAccountId: 'acc_***ban1',
          status: 'BAN',
          providerKind: 'SPARK',
          effectiveInUse: 0,
          effectiveCap: 3,
          physicalSlotsDisplay: null,
          adaptiveQuotaState: null,
          reason: 'banned',
          statusChangedAt: null,
          tombstone: false,
        },
      ],
      readbackSurfaces: {
        mcp: null,
        api: null,
        ui: null,
        ops: null,
      },
      publishedAtMs: Date.parse(PIN.generatedAt),
      lastPeriodicHealthAtMs: null,
      stale: true,
      staleReason: 'SLA_MISS_30S_NO_PARITY',
      usableCapacity: 0,
      capacity: {
        sparkLive: 0,
        sparkCap: 10,
        solLive: 0,
        solCap: 10,
        grokLive: 0,
        grokPerAccount: [],
        grokMajority: false,
        healthyGrokUsableCapacity: 0,
        combinedLive: 0,
        combinedCap: 200,
        floorTarget: 60,
        floorMet: false,
        belowFloor: true,
        belowFloorReason: 'STALE',
        usableCapacity: 0,
        dispatchAllowed: false,
        dispatchMode: 'BLOCKED',
        nonGrokAssignmentAllowed: false,
        grokAssignmentAllowed: false,
        limitingReasons: ['ACCOUNT_SYNC_STALE'],
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
      entityRev: 2,
    }
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [],
      opsAccounts: [],
      runs: [],
      boardContentHash: 'hash_stale_acc',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
      accountSyncSnapshot: snap,
    })
    expect(agg.accounts).toHaveLength(3)
    expect(agg.accounts.find((a) => a.status === 'LIMIT')?.providerKind).toBe('GROK')
    expect(agg.accounts.find((a) => a.status === 'BAN')?.quarantine).toBe(true)
    const ops = projectOps(agg)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.usableCapacity).toBe(0)
    expect(ops.data.sourceRevision).toBe(9)
    expect(ops.data.accountStaleReason).toBe('SLA_MISS_30S_NO_PARITY')
  })

  it('materialProgressAt is not mirrored from heartbeat when only updated is present', () => {
    const run: Run = {
      id: 'r1',
      agent: 'agent-1',
      agentType: 'claude',
      model: 'm',
      effort: 'high',
      task: 'T1',
      taskId: 'T1',
      status: 'running',
      started: '2026-07-13T11:00:00.000Z',
      updated: '2026-07-13T11:50:00.000Z',
      evidencePath: '/e/r1',
    }
    const input = mapWorkTaskToControlCenterInput(bareTask('T1'), PIN, { run })
    expect(input.heartbeatAt).toBe('2026-07-13T11:50:00.000Z')
    expect(input.materialProgressAt).toBeNull()

    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [run],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [bareTask('T1')],
      opsAccounts: [],
      runs: [run],
      boardContentHash: 'hash_run_mat',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })
    expect(agg.runs[0]?.heartbeatAt).toBe('2026-07-13T11:50:00.000Z')
    expect(agg.runs[0]?.materialProgressAt).toBeNull()
    expect(agg.runs[0]?.evidenceLink).toBe('/e/r1')
  })

  it('distinct materialProgressAt preserved when present on run source', () => {
    const run = {
      id: 'r2',
      agent: 'agent-2',
      agentType: 'claude' as const,
      model: 'm',
      effort: 'high',
      task: 'T2',
      taskId: 'T2',
      status: 'running' as const,
      started: '2026-07-13T11:00:00.000Z',
      updated: '2026-07-13T11:59:00.000Z',
      materialProgressAt: '2026-07-13T11:40:00.000Z',
      controllerRunId: 'ctrl-1',
      parentRunId: 'parent-1',
      collisionScopeLockIds: ['lock-a'],
      claimState: 'VALID_CURRENT',
    }
    const input = mapWorkTaskToControlCenterInput(bareTask('T2'), PIN, { run: run as Run })
    expect(input.heartbeatAt).toBe('2026-07-13T11:59:00.000Z')
    expect(input.materialProgressAt).toBe('2026-07-13T11:40:00.000Z')
    expect(input.heartbeatAt).not.toBe(input.materialProgressAt)

    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [run],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [bareTask('T2')],
      opsAccounts: [],
      runs: [run as Run],
      boardContentHash: 'hash_run_distinct',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })
    expect(agg.runs[0]?.materialProgressAt).toBe('2026-07-13T11:40:00.000Z')
    expect(agg.runs[0]?.controllerRunId).toBe('ctrl-1')
    expect(agg.runs[0]?.parentRunId).toBe('parent-1')
    expect(agg.runs[0]?.lockIds).toEqual(['lock-a'])
    expect(agg.runs[0]?.claimState).toBe('VALID_CURRENT')
  })

  it('feature flowBranch: fail when blocked; null when unknown; never invent success', () => {
    expect(deriveFeatureFlowBranch({ isBlocked: true }, [])).toBe('fail')
    expect(deriveFeatureFlowBranch({ blocked: 'x' }, [])).toBe('fail')
    expect(deriveFeatureFlowBranch({ branch: 'expired' }, [])).toBe('expired')
    expect(deriveFeatureFlowBranch({ isBlocked: false, fase: 'build' }, [])).toBeNull()
    expect(
      deriveFeatureFlowBranch(
        { isBlocked: false },
        [
          bareTask('t1', {
            status: 'done',
            lifecycleStage: 'PROD_READY',
          }),
        ],
      ),
    ).toBe('success')
  })

  it('feature context projected from task sources; style null when absent', () => {
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [{ id: 'p1', nama: 'P1', status: 'active' }],
      features: [{ id: 'f1', nama: 'F1', projectId: 'p1', fase: 'build', checklist: [] }],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const tasks = [
      bareTask('T-ctx', {
        projectId: 'p1',
        featureContractId: 'f1',
        page_routes: ['/a'],
        api_endpoints: ['GET /api/x'],
        logic_rules: ['rule-1'],
        sales_table_fields: ['col_a'],
        geo_variants: [{ when: 'US' }],
        provider_variants: [{ when: 'cleeng' }],
        side_effects_readback: ['webhook'],
      }),
    ]
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks,
      opsAccounts: [],
      runs: [],
      boardContentHash: 'hash_feat_ctx',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })
    const f = agg.features.find((x) => x.id === 'f1')
    expect(f?.pageRoutes).toEqual(['/a'])
    expect(f?.apiEndpoints).toEqual(['GET /api/x'])
    expect(f?.logicRules).toEqual(['rule-1'])
    expect(f?.dataContext).toEqual(['col_a'])
    expect(f?.geoVariants).toEqual(['US'])
    expect(f?.providerVariants).toEqual(['cleeng'])
    expect(f?.sideEffectsReadback).toEqual(['webhook'])
    expect(f?.styleContext).toBeNull()
    expect(f?.flowBranch).toBeNull()
  })

  it('project doneCount from rollup DONE distinct task IDs; readiness null without PRODUCT proof', () => {
    // Receipt must bind to the pin the adapter derives (content hash + task-id hash).
    const boardContentHash = 'hash_proj_done_xxxx'
    const boardRev = 1
    const lifecycleRev = 0
    const taskIds = ['T-DONE']
    const taskHash = createHash('sha256')
      .update(taskIds.slice().sort().join('|') || 'empty-tasks')
      .digest('hex')
    const canonicalSnapshotId = `cc-mfs-rebuild-${boardContentHash.slice(0, 16)}`
    const receipt: ClassificationReceipt = {
      receiptId: 'r-done',
      receiptHash: 'abcdef0123456789abcdef01',
      taskId: 'T-DONE',
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      canonicalSnapshotId,
      canonicalHash: boardContentHash,
      taskHash,
      boardRev,
      lifecycleRev,
      issuedAt: '2026-07-13T00:00:00.000Z',
    }
    const doneTask = bareTask('T-DONE', {
      projectId: 'p1',
      lifecycleStage: 'PROD_READY',
      status: 'done',
    }) as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    doneTask.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt,
    }
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [{ id: 'p1', nama: 'P1', status: 'active' }],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [doneTask],
      opsAccounts: [],
      runs: [],
      boardContentHash,
      boardRev,
      lifecycleRev,
      now: PIN.generatedAt,
      // Provide non-stale account sync so STALE_ACCOUNT_SYNC does not dominate diagnosis.
      accountSyncSnapshot: {
        boardId: 'mfs-rebuild',
        sourceRevision: 1,
        generatedAt: PIN.generatedAt,
        generatedAtMs: Date.parse(PIN.generatedAt),
        accounts: [],
        readbackSurfaces: {
          mcp: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          api: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          ui: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          ops: { sourceRevision: 1, generatedAt: PIN.generatedAt },
        },
        publishedAtMs: Date.parse(PIN.generatedAt),
        lastPeriodicHealthAtMs: Date.parse(PIN.generatedAt),
        stale: false,
        staleReason: null,
        usableCapacity: 0,
        capacity: {
          sparkLive: 0,
          sparkCap: 10,
          solLive: 0,
          solCap: 10,
          grokLive: 0,
          grokPerAccount: [],
          grokMajority: false,
          healthyGrokUsableCapacity: 0,
          combinedLive: 0,
          combinedCap: 200,
          floorTarget: 60,
          floorMet: false,
          belowFloor: true,
          belowFloorReason: null,
          usableCapacity: 0,
          dispatchAllowed: false,
          dispatchMode: 'BLOCKED',
          nonGrokAssignmentAllowed: false,
          grokAssignmentAllowed: false,
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
      },
    })
    const p = agg.projects.find((x) => x.id === 'p1')
    expect(agg.assignmentsByTaskId.get('T-DONE')?.primary).toBe('DONE')
    expect(p?.doneCount).toBe(1)
    expect(p?.readinessPercent).toBe(100)
    expect(p?.readinessStage).toBe('PROD_READY')

    const noProof = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [bareTask('T-x', { projectId: 'p1', phase: 'PROD_READY', mappingPct: 100 })],
      opsAccounts: [],
      runs: [],
      boardContentHash: 'hash_proj_noproof',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
    })
    const p2 = noProof.projects.find((x) => x.id === 'p1')
    expect(p2?.readinessPercent).toBeNull()
    expect(p2?.readinessStage).toBeNull()
    // phase/pct alone never creates DONE
    expect(p2?.doneCount).toBe(0)
  })

  it('stripSensitiveFields removes token/secret keys from nested objects', () => {
    const cleaned = stripSensitiveFields({
      ok: 1,
      token: 'abc',
      nested: { password: 'x', title: 'y' },
    })
    expect(cleaned).toEqual({ ok: 1, nested: { title: 'y' } })
  })
})

// ---------------------------------------------------------------------------
// Durable V3 ownership / classification / priority packets
// ---------------------------------------------------------------------------

function bareRunRecord(
  partial: Partial<RunRecord> & Pick<RunRecord, 'runId' | 'taskId' | 'agentId' | 'state'>,
): RunRecord {
  const now = Date.parse('2026-07-13T12:00:00.000Z')
  return {
    boardId: 'mfs-rebuild',
    planId: null,
    planItemRank: null,
    targetGate: 'PROD_READY',
    role: 'implementer',
    model: 'grok',
    effort: 'high',
    maskedAccountRef: 'acc_***_x1',
    canonicalHash: null,
    collisionScopeLockIds: [],
    fencingToken: 'fence-1',
    fencingVersion: 1,
    registeredAtMs: now - 60_000,
    heartbeatAtMs: now - 5_000,
    leaseExpiresAtMs: now + 30_000,
    materialProgressAtMs: now - 10_000,
    heartbeatSequence: 1,
    expectedEntityRev: 0,
    expectedBoardRev: 1,
    entityRev: 1,
    boardRev: 1,
    stalled: false,
    history: [],
    lastHeartbeatResponse: null,
    controllerRunId: null,
    parentRunId: null,
    idempotencyKey: null,
    ...partial,
  }
}

describe('control-center-ui-adapter durable ownership', () => {
  const nowMs = Date.parse('2026-07-13T12:00:00.000Z')

  it('deriveClaimStateFromRunRecord: VALID_CURRENT / EXPIRED / ORPHAN / FENCED / BEYOND_STAGE', () => {
    const live = bareRunRecord({
      runId: 'r-live',
      taskId: 'T1',
      agentId: 'agent-a',
      state: 'RUNNING',
    })
    expect(deriveClaimStateFromRunRecord(live, nowMs).claimState).toBe('VALID_CURRENT')
    expect(deriveClaimStateFromRunRecord(live, nowMs).runLiveness).toBe('RUNNING')

    const expired = bareRunRecord({
      runId: 'r-exp',
      taskId: 'T1',
      agentId: 'agent-a',
      state: 'RUNNING',
      leaseExpiresAtMs: nowMs - 120_000,
    })
    expect(deriveClaimStateFromRunRecord(expired, nowMs).claimState).toBe('EXPIRED')

    const orphan = bareRunRecord({
      runId: 'r-orp',
      taskId: 'T1',
      agentId: '',
      state: 'RUNNING',
      fencingToken: null,
    })
    expect(deriveClaimStateFromRunRecord(orphan, nowMs).claimState).toBe('ORPHAN')

    const fenced = bareRunRecord({
      runId: 'r-fence',
      taskId: 'T1',
      agentId: 'agent-a',
      state: 'RUNNING',
      fencingVersion: 3,
      heartbeatAtMs: nowMs - 120_000,
      leaseExpiresAtMs: nowMs + 30_000,
    })
    expect(deriveClaimStateFromRunRecord(fenced, nowMs).claimState).toBe('FENCED')

    const beyond = bareRunRecord({
      runId: 'r-beyond',
      taskId: 'T1',
      agentId: 'agent-a',
      state: 'RUNNING',
    })
    expect(
      deriveClaimStateFromRunRecord(beyond, nowMs, {
        taskId: 'T1',
        lifecycleStage: 'PROD_READY',
        productStageMode: 'STAGE_2',
      }).claimState,
    ).toBe('BEYOND_STAGE')
  })

  it('conflicting primary owners → conflictTaskIds + no primaryOwnership edge', () => {
    const runs = [
      bareRunRecord({
        runId: 'r1',
        taskId: 'T-conf',
        agentId: 'agent-a',
        state: 'RUNNING',
      }),
      bareRunRecord({
        runId: 'r2',
        taskId: 'T-conf',
        agentId: 'agent-b',
        state: 'RUNNING',
        heartbeatAtMs: nowMs - 1_000,
      }),
    ]
    const own = deriveDurableOwnership(runs, nowMs)
    expect(own.conflictTaskIds).toEqual(['T-conf'])
    expect(own.primaryOwnership).toEqual([])
    expect(own.byTaskId.get('T-conf')?.conflicting).toBe(true)
  })

  it('aggregation: durable ownership overrides embedded claimState; conflict → DATA_INTEGRITY', () => {
    const boardContentHash = 'hash_durable_own_01'
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [
        // Legacy embed must NOT drive ownership when durableRuns present.
        {
          id: 'legacy-r',
          agent: 'legacy-agent',
          agentType: 'claude',
          model: 'm',
          effort: 'high',
          task: 'T-own',
          taskId: 'T-own',
          status: 'running',
          started: '2026-07-13T11:00:00.000Z',
          updated: '2026-07-13T11:50:00.000Z',
        },
      ],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never

    const taskEmbeddedClaim = bareTask('T-own', {
      claimState: 'STALE',
      lifecycleStage: 'MAPPED',
    } as Partial<WorkTask>)

    const durableRuns = [
      bareRunRecord({
        runId: 'r-durable',
        taskId: 'T-own',
        agentId: 'agent-durable',
        state: 'RUNNING',
      }),
    ]

    const receipt: ClassificationReceipt = {
      receiptId: 'r-own',
      receiptHash: 'abcdef0123456789abcdef01',
      taskId: 'T-own',
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      canonicalSnapshotId: `cc-mfs-rebuild-${boardContentHash.slice(0, 16)}`,
      canonicalHash: boardContentHash,
      taskHash: createHash('sha256').update('T-own').digest('hex'),
      boardRev: 1,
      lifecycleRev: 0,
      issuedAt: '2026-07-13T00:00:00.000Z',
      membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipProofHash: 'proofhash_membership_1',
    }

    const classified = bareTask('T-own', {
      claimState: 'STALE',
      lifecycleStage: 'MAPPED',
    }) as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    classified.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt,
    }

    const legacyRuns = (raw as { runs?: Run[] }).runs ?? []
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [classified],
      opsAccounts: [],
      runs: legacyRuns,
      boardContentHash,
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
      durableRuns,
      durableOwnershipLoaded: true,
      durableClassifications: [
        {
          taskId: 'T-own',
          taskClass: 'PRODUCT',
          disposition: 'ACTIVE',
          receipt,
        },
      ],
      durableClassificationsLoaded: true,
      activePlan: {
        boardId: 'mfs-rebuild',
        planId: 'plan-1',
        planVersion: 1,
        planHash: 'phash',
        canonicalSnapshotId: `cc-mfs-rebuild-${boardContentHash.slice(0, 16)}`,
        canonicalHash: boardContentHash,
        boardRevAtPublish: 1,
        issuedAt: PIN.generatedAt,
        expiresAt: '2026-07-14T12:00:00.000Z',
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 86_400_000,
        stage: null,
        items: [
          {
            rank: 1,
            taskId: 'T-own',
            targetGate: 'PROD_READY',
            role: 'implementer',
            selectionReason: 'frontier',
            priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
            dependencyProof: { satisfied: true },
            expectedEntityRev: 0,
            expectedBoardRev: 1,
          },
        ],
        status: 'ACTIVE',
        generatedAt: PIN.generatedAt,
        generatedAtMs: nowMs,
        supersededByPlanId: null,
        entityRev: 1,
      },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: 'plan-1',
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      accountSyncSnapshot: {
        boardId: 'mfs-rebuild',
        sourceRevision: 1,
        generatedAt: PIN.generatedAt,
        generatedAtMs: nowMs,
        accounts: [],
        readbackSurfaces: {
          mcp: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          api: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          ui: { sourceRevision: 1, generatedAt: PIN.generatedAt },
          ops: { sourceRevision: 1, generatedAt: PIN.generatedAt },
        },
        publishedAtMs: nowMs,
        lastPeriodicHealthAtMs: nowMs,
        stale: false,
        staleReason: null,
        usableCapacity: 1,
        capacity: {
          sparkLive: 0,
          sparkCap: 10,
          solLive: 0,
          solCap: 10,
          grokLive: 0,
          grokPerAccount: [],
          grokMajority: false,
          healthyGrokUsableCapacity: 1,
          combinedLive: 0,
          combinedCap: 200,
          floorTarget: 60,
          floorMet: false,
          belowFloor: true,
          belowFloorReason: null,
          usableCapacity: 1,
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
      },
    })

    // Embedded STALE ignored; durable VALID_CURRENT + RUNNING → ONGOING
    expect(agg.assignmentsByTaskId.get('T-own')?.primary).toBe('ONGOING')
    expect(agg.workRows.find((r) => r.taskId === 'T-own')?.claimState).toBe('VALID_CURRENT')
    expect(agg.runs[0]?.agentId).toBe('agent-durable')
    expect(agg.runs[0]?.runId).toBe('r-durable')
    // Real priority packets from plan + membership
    expect(agg.priority.membershipDenominator).toBe(1)
    expect(agg.priority.allClosureCapacity).toBeGreaterThan(0)

    // Overview carries materialEvents/lifecycle wire (may be empty honestly)
    const overview = projectOverview(agg)
    expect(Array.isArray(overview.data.lifecycle)).toBe(true)
    expect(Array.isArray(overview.data.materialEvents)).toBe(true)

    // Conflict case
    const conflictAgg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [taskEmbeddedClaim],
      opsAccounts: [],
      runs: [],
      boardContentHash: 'hash_conflict_own',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
      durableRuns: [
        bareRunRecord({
          runId: 'c1',
          taskId: 'T-own',
          agentId: 'a1',
          state: 'RUNNING',
        }),
        bareRunRecord({
          runId: 'c2',
          taskId: 'T-own',
          agentId: 'a2',
          state: 'RUNNING',
        }),
      ],
      durableOwnershipLoaded: true,
      durableClassificationsLoaded: true,
      durableClassifications: [],
    })
    expect(conflictAgg.sectionErrors.some((e) => e.code === 'DATA_INTEGRITY')).toBe(true)
    expect(conflictAgg.assignmentsByTaskId.get('T-own')?.blockReason).toBe('DATA_INTEGRITY')
    // Missing durable classification → UNCLASSIFIED tracked
    expect(conflictAgg.rollup.unclassifiedCount).toBeGreaterThan(0)
  })

  it('missing durable classification row → UNCLASSIFIED even if task embeds PRODUCT', () => {
    const embedded = bareTask('T-miss') as WorkTask & {
      classification: {
        taskClass: 'PRODUCT'
        disposition: 'ACTIVE'
        receipt: ClassificationReceipt
      }
    }
    embedded.classification = {
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
      receipt: {
        receiptId: 'r-x',
        receiptHash: 'abcdef0123456789abcdef01',
        taskId: 'T-miss',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        canonicalSnapshotId: 'snap',
        canonicalHash: 'hash_miss_cls_xxxx',
        taskHash: 'th',
        boardRev: 1,
        lifecycleRev: 0,
        issuedAt: '2026-07-13T00:00:00.000Z',
      },
    }
    const raw = {
      id: 'mfs-rebuild',
      name: 'MFS',
      projects: [],
      features: [],
      runs: [],
      decisions: [],
      log: [],
      collab: { comments: {}, activity: [] },
    } as never
    const agg = buildControlCenterAggregationFromSources({
      boardId: 'mfs-rebuild',
      raw,
      tasks: [embedded],
      opsAccounts: [],
      runs: [],
      boardContentHash: 'hash_miss_cls_xxxx',
      boardRev: 1,
      lifecycleRev: 0,
      now: PIN.generatedAt,
      durableClassifications: [],
      durableClassificationsLoaded: true,
      durableOwnershipLoaded: true,
      durableRuns: [],
    })
    expect(agg.assignmentsByTaskId.get('T-miss')?.blockReason).toBe('DATA_INTEGRITY')
    expect(agg.rollup.unclassifiedCount).toBe(1)
  })

  it('buildPriorityPacketsFromDurable creates plan + run packets deterministically', () => {
    const packets = buildPriorityPacketsFromDurable({
      plan: {
        boardId: 'mfs-rebuild',
        planId: 'p1',
        planVersion: 1,
        planHash: 'h',
        canonicalSnapshotId: 's',
        canonicalHash: 'ch',
        boardRevAtPublish: 1,
        issuedAt: PIN.generatedAt,
        expiresAt: '2099-01-01T00:00:00.000Z',
        issuedAtMs: nowMs,
        expiresAtMs: nowMs + 1e12,
        stage: null,
        items: [
          {
            rank: 1,
            taskId: 'T1',
            targetGate: 'G',
            role: 'r',
            selectionReason: 'x',
            priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
            dependencyProof: { satisfied: true },
            expectedEntityRev: 0,
            expectedBoardRev: 1,
          },
        ],
        status: 'ACTIVE',
        generatedAt: PIN.generatedAt,
        generatedAtMs: nowMs,
        supersededByPlanId: null,
        entityRev: 1,
      },
      runs: [
        bareRunRecord({
          runId: 'r1',
          taskId: 'T1',
          agentId: 'a',
          state: 'RUNNING',
        }),
      ],
      membershipTaskIds: new Set(['T1']),
      pinCanonicalHash: 'ch',
      nowMs,
    })
    expect(packets.some((p) => p.packetId.startsWith('plan:'))).toBe(true)
    expect(packets.some((p) => p.packetId.startsWith('run:'))).toBe(true)
    expect(packets.every((p) => p.isPriorityPortfolio)).toBe(true)
  })
})

describe('canonical definition → control-center aggregation', () => {
  beforeEach(() => {
    resetControlPlaneRuntimeContextForTests()
    setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
  })
  afterEach(() => {
    resetControlPlaneRuntimeContextForTests()
  })

  it('resolveControlCenterDefinitionLoad after applyImport is sole definition authority', async () => {
    const boardId = 'cc-wire-board'
    const ctx = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(ctx)
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql!
    await seedBoardRevision(sql, {
      boardId,
      boardRev: 0,
      lifecycleRev: 3,
      subjectHash: '',
      canonicalSnapshotId: null,
      canonicalHash: null,
    })
    const before = await ctx.controlData.imports.getBoardState(boardId)
    const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
      boardId,
      {
        projects: [{ id: 'p-cc', nama: 'CC', status: 'active' }],
        features: [{ id: 'f-cc', nama: 'Feat', fase: 'build', projectId: 'p-cc' }],
        tasks: [
          { id: 't-cc-1', title: 'C1', projectId: 'p-cc', featureId: 'f-cc' },
          { id: 't-cc-2', title: 'C2', projectId: 'p-cc' },
        ],
      },
      { idempotencyKey: 'cc-wire-1', snapshotId: 'snap-cc-wire-1' },
    )
    const applied = await applyImport(ctx.controlData.imports, ctx.idempotency, null, {
      auth: {
        actorId: 'cc-test',
        scopes: ['import:write'],
        role: 'ROOT_ORCHESTRATOR',
      },
      snapshot,
      entityExpectedRev: before!.entityRev,
      expectedBoardRev: before!.boardRev,
      expectedSubjectHash: before!.subjectHash ?? '',
      idempotencyKey: 'cc-wire-1',
      dryRun: false,
    })
    expect(applied.ok).toBe(true)

    // Lifecycle overlay only for t-cc-1
    const overlay: WorkTask[] = [
      {
        id: 't-cc-1',
        title: 'C1',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        lifecycleStage: 'MAPPED',
      },
      // Legacy-only task must NOT appear in definition membership
      {
        id: 'legacy-only-task',
        title: 'Should not surface',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        lifecycleStage: 'BUILT',
      },
    ]

    const load = await resolveControlCenterDefinitionLoad(
      boardId,
      ctx.controlData.imports,
      overlay,
    )
    expect(load.kind).toBe('canonical')
    if (load.kind !== 'canonical') return
    expect(load.pinAuthorityComplete).toBe(true)
    expect(load.boardRev).toBe(applied.boardRev)
    expect(load.lifecycleRev).toBe(3)
    expect(load.authorityCanonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(load.authorityCanonicalHash).toBe(applied.canonicalHash)
    expect(load.tasks.map((t) => t.id).sort()).toEqual(['t-cc-1', 't-cc-2'])
    expect(load.tasks.find((t) => t.id === 'legacy-only-task')).toBeUndefined()
    expect(load.tasks.find((t) => t.id === 't-cc-1')?.lifecycleStage).toBe('MAPPED')
    expect(load.tasks.find((t) => t.id === 't-cc-2')?.lifecycleStage).toBeNull()
    expect(load.raw.projects.map((p) => p.id)).toEqual(['p-cc'])
    expect(load.raw.features.map((f) => f.id)).toEqual(['f-cc'])

    const agg = buildControlCenterAggregationFromSources({
      boardId,
      raw: load.raw,
      tasks: load.tasks,
      opsAccounts: [],
      runs: [],
      boardContentHash: 'legacyhashxxxxxxxx',
      boardRev: load.boardRev,
      lifecycleRev: load.lifecycleRev,
      authorityCanonicalHash: load.authorityCanonicalHash,
      authorityCanonicalSnapshotId: load.authorityCanonicalSnapshotId,
      pinAuthorityComplete: true,
      now: '2026-07-13T12:00:00.000Z',
      durableRuns: [],
      durableOwnershipLoaded: true,
      durableClassifications: [],
      durableClassificationsLoaded: true,
    })
    expect(agg.pin.boardRev).toBe(applied.boardRev)
    expect(agg.pin.canonicalHash).toBe(applied.canonicalHash)
    expect(agg.pin.canonicalSnapshotId).toBe(snapshot.manifest.snapshotId)
    expect(agg.workRows.map((t) => t.taskId).sort()).toEqual(['t-cc-1', 't-cc-2'])
    expect(agg.projects.map((p) => p.id)).toEqual(['p-cc'])
  })

  it('mismatch pin (orphan snapshot id) fails closed — empty definition, no legacy merge', async () => {
    const boardId = 'cc-orphan-pin'
    const ctx = createMemoryControlPlaneRuntimeContext()
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql!
    await seedBoardRevision(sql, {
      boardId,
      boardRev: 5,
      lifecycleRev: 1,
      subjectHash: 'f'.repeat(64),
      importEntityRev: 1,
      canonicalSnapshotId: 'snap-cc-orphan',
      canonicalHash: 'f'.repeat(64),
    })
    const load = await resolveControlCenterDefinitionLoad(boardId, ctx.controlData.imports, [
      {
        id: 'legacy-t',
        title: 'Legacy must not merge',
        dependencies: [],
        impacts: [],
        checkpoints: [],
      },
    ])
    expect(load.kind).toBe('mismatch')
    if (load.kind !== 'mismatch') return
    expect(load.code).toBe('SNAPSHOT_MISSING')
    expect(load.tasks).toEqual([])
    expect(load.raw.projects).toEqual([])
    expect(load.raw.features).toEqual([])
    expect(load.boardRev).toBe(5)
    expect(load.pinAuthorityComplete).toBe(false)

    const agg = buildControlCenterAggregationFromSources({
      boardId,
      raw: load.raw,
      tasks: load.tasks,
      opsAccounts: [],
      runs: [],
      boardContentHash: 'x'.repeat(16),
      boardRev: load.boardRev,
      lifecycleRev: load.lifecycleRev,
      authorityCanonicalHash: load.authorityCanonicalHash,
      authorityCanonicalSnapshotId: load.authorityCanonicalSnapshotId,
      pinAuthorityComplete: false,
      now: '2026-07-13T12:00:00.000Z',
      sectionErrors: [
        { section: 'definition', code: load.code, message: load.message },
        {
          section: 'definition',
          code: 'DEFINITION_AUTHORITY_STALE',
          message: 'pinned snapshot missing/mismatched; refusing legacy merge',
        },
      ],
      durableRuns: [],
      durableOwnershipLoaded: true,
    })
    expect(agg.workRows).toHaveLength(0)
    expect(agg.projects).toHaveLength(0)
    expect(agg.sectionErrors.some((e) => e.code === 'SNAPSHOT_MISSING')).toBe(true)
    expect(agg.sectionErrors.some((e) => e.code === 'DEFINITION_AUTHORITY_STALE')).toBe(true)
  })

  it('no pin → legacy reason PIN_MISSING', async () => {
    const ctx = createMemoryControlPlaneRuntimeContext()
    const load = await resolveControlCenterDefinitionLoad(
      'never-imported-board',
      ctx.controlData.imports,
    )
    expect(load).toEqual({ kind: 'legacy', reason: 'PIN_MISSING' })
  })

  it('pin-complete aggregation: DISTINCT definition rollup excludes legacy-only + missing class → UNCLASSIFIED', async () => {
    const boardId = 'cc-rollup-matrix'
    const ctx = createMemoryControlPlaneRuntimeContext()
    setTestControlPlaneRuntimeContext(ctx)
    const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql!
    await seedBoardRevision(sql, {
      boardId,
      boardRev: 0,
      lifecycleRev: 2,
      subjectHash: '',
      canonicalSnapshotId: null,
      canonicalHash: null,
    })
    const before = await ctx.controlData.imports.getBoardState(boardId)
    const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
      boardId,
      {
        projects: [{ id: 'p-r', nama: 'R', status: 'active' }],
        features: [{ id: 'f-r', nama: 'F', fase: 'build', projectId: 'p-r' }],
        tasks: [
          { id: 't-r-1', title: 'R1', projectId: 'p-r', featureId: 'f-r' },
          { id: 't-r-2', title: 'R2', projectId: 'p-r' },
        ],
      },
      { idempotencyKey: 'cc-rollup-1', snapshotId: 'snap-cc-rollup-1' },
    )
    const applied = await applyImport(ctx.controlData.imports, ctx.idempotency, null, {
      auth: {
        actorId: 'cc-test',
        scopes: ['import:write'],
        role: 'ROOT_ORCHESTRATOR',
      },
      snapshot,
      entityExpectedRev: before!.entityRev,
      expectedBoardRev: before!.boardRev,
      expectedSubjectHash: before!.subjectHash ?? '',
      idempotencyKey: 'cc-rollup-1',
      dryRun: false,
    })
    expect(applied.ok).toBe(true)

    const overlay: WorkTask[] = [
      {
        id: 't-r-1',
        title: 'R1',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        lifecycleStage: 'MAPPED',
      },
      {
        id: 'legacy-only-r',
        title: 'Orphan',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        lifecycleStage: 'PROD_READY',
      },
    ]
    const load = await resolveControlCenterDefinitionLoad(
      boardId,
      ctx.controlData.imports,
      overlay,
    )
    expect(load.kind).toBe('canonical')
    if (load.kind !== 'canonical') return
    expect(load.tasks.map((t) => t.id).sort()).toEqual(['t-r-1', 't-r-2'])
    expect(load.tasks.find((t) => t.id === 'legacy-only-r')).toBeUndefined()
    expect(load.tasks.find((t) => t.id === 't-r-2')?.lifecycleStage).toBeNull()

    const agg = buildControlCenterAggregationFromSources({
      boardId,
      raw: load.raw,
      tasks: load.tasks,
      opsAccounts: [],
      runs: [],
      boardContentHash: 'legacyhashxxxxxxxx',
      boardRev: load.boardRev,
      lifecycleRev: load.lifecycleRev,
      authorityCanonicalHash: load.authorityCanonicalHash,
      authorityCanonicalSnapshotId: load.authorityCanonicalSnapshotId,
      pinAuthorityComplete: true,
      now: '2026-07-13T12:00:00.000Z',
      durableRuns: [],
      durableOwnershipLoaded: true,
      durableClassifications: [],
      durableClassificationsLoaded: true,
    })
    // DISTINCT definition only — both missing classification → UNCLASSIFIED repair tracked
    expect(agg.workRows.map((r) => r.taskId).sort()).toEqual(['t-r-1', 't-r-2'])
    expect(agg.rollup.trackedWorkDenominator).toBe(2)
    expect(agg.rollup.unclassifiedCount).toBe(2)
    expect(agg.rollup.hasP0OrDataIntegrityBlocker).toBe(true)
    expect(agg.rollup.buckets.BLOCKED).toBe(2)
    // Orphan lifecycle PROD_READY never enters product denom
    expect(agg.rollup.productDenominator).toBe(0)
    expect(agg.rollup.stageProdReady).toBe(0)
  })

  it('rawBoardFromCanonicalProjection + workTasks map definition membership (pure)', () => {
    const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
      'cc-proj-map',
      {
        projects: [{ id: 'p1', nama: 'P', status: 'active' }],
        features: [{ id: 'f1', nama: 'F', projectId: 'p1', fase: 'qa' }],
        tasks: [{ id: 't1', title: 'T', projectId: 'p1', featureId: 'f1' }],
      },
      { idempotencyKey: 'cc-proj-map', snapshotId: 'snap-cc-proj' },
    )
    // Use live snapshot projection (mapper purity — no MySQL round-trip required).
    const projection = projectCanonicalDefinition(snapshot.payload)
    const raw = rawBoardFromCanonicalProjection(projection)
    expect(raw.projects[0]?.nama).toBe('P')
    expect(raw.features[0]?.track).toBe('p1')
    const tasks = workTasksFromCanonicalProjection(projection)
    expect(tasks).toHaveLength(1)
    expect(tasks[0]?.featureContractId).toBe('f1')
  })
})
