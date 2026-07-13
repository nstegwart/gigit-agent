import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'

import type { WorkTask, Run } from '#/lib/types'
import {
  buildControlCenterAggregationFromSources,
  deriveFeatureFlowBranch,
  isControlCenterBoard,
  mapTaskClassification,
  mapWorkTaskToControlCenterInput,
  CONTROL_CENTER_PRIMARY_NAV_IDS,
} from '#/server/control-center-ui-adapter'
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
