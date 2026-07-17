import { describe, expect, it } from 'vitest'

import type {
  ClassificationReceipt,
  G5DomainRecord,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import {
  overviewQueryKey,
  workQueryKey,
  priorityQueryKey,
  projectsQueryKey,
  featuresQueryKey,
  agentsQueryKey,
  opsQueryKey,
  decisionsQueryKey,
  evidenceQueryKey,
  formatAgeSeconds,
  buildWorkDeepLink,
  majorityDisplayFromEnvelope,
  resolveClientSurfaceState,
} from '#/lib/control-center-query'
import { makePassingDomain } from '#/server/g5'
import type { DecisionV3Record } from '#/server/decisions-v3'
import {
  aggregateControlCenter,
  buildOverviewLifecycle,
  buildOverviewLifecycleFromProjects,
  buildOverviewLifecycleFromTasks,
  compareOngoingZeroClick,
  CONTROL_CENTER_UI_SCHEMA,
  createPinnedEnvelope,
  envelopeDisconnected,
  envelopeError,
  envelopeForbidden,
  envelopePinIdentity,
  maskAccountForUi,
  projectAllSurfaces,
  projectDecisions,
  projectDecisionUiRow,
  projectOps,
  projectOverview,
  projectPriority,
  projectWork,
  stripSensitiveFields,
  type ControlCenterPin,
  type ControlCenterTaskInput,
} from '#/server/control-center-ui'

const PIN_TUPLE: PinnedRevisionTuple = {
  canonicalSnapshotId: 'snap-cc-ui-1',
  canonicalHash: 'canonhash_cc_aaaaaaaaaaaa',
  taskHash: 'taskhash_cc_bbbbbbbbbbbb',
  boardRev: 42,
  lifecycleRev: 7,
}

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  ...PIN_TUPLE,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 5,
  stale: false,
  staleReason: null,
}

const NOW = '2026-07-13T12:00:00.000Z'

function receipt(
  taskId: string,
  taskClass: ClassificationReceipt['taskClass'],
  disposition: ClassificationReceipt['disposition'],
  overrides: Partial<ClassificationReceipt> = {},
): ClassificationReceipt {
  return {
    receiptId: `rcpt-${taskId}`,
    receiptHash: 'abcdef0123456789abcdef01',
    taskId,
    taskClass,
    disposition,
    canonicalSnapshotId: PIN_TUPLE.canonicalSnapshotId,
    canonicalHash: PIN_TUPLE.canonicalHash,
    taskHash: PIN_TUPLE.taskHash,
    boardRev: PIN_TUPLE.boardRev,
    lifecycleRev: PIN_TUPLE.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
    ...overrides,
  }
}

function cls(
  taskId: string,
  taskClass: TaskClassificationRecord['taskClass'],
  disposition: TaskClassificationRecord['disposition'],
  overrides: Partial<TaskClassificationRecord> = {},
): TaskClassificationRecord {
  const { receipt: rOverride, ...rest } = overrides
  return {
    taskId,
    taskClass,
    disposition,
    receipt:
      rOverride === null
        ? null
        : receipt(taskId, taskClass, disposition, rOverride ?? undefined),
    ...rest,
  }
}

function productTask(
  taskId: string,
  stage: string,
  extra: Partial<ControlCenterTaskInput> = {},
): ControlCenterTaskInput {
  return {
    taskId,
    title: `Task ${taskId}`,
    classification: cls(taskId, 'PRODUCT', 'ACTIVE'),
    lifecycleStage: stage,
    productStageMode: 'STAGE_2',
    eligible: true,
    createdAt: '2026-07-13T10:00:00.000Z',
    ...extra,
  }
}

function allG5Pass(pin: PinnedRevisionTuple = PIN_TUPLE): Array<G5DomainRecord> {
  return G5_REQUIRED_DOMAINS.map((id) => makePassingDomain(id, pin))
}

function decision(
  partial: Partial<DecisionV3Record> & Pick<DecisionV3Record, 'decisionId' | 'severity' | 'blocking'>,
): DecisionV3Record {
  return {
    boardId: PIN.boardId,
    projectId: null,
    featureId: null,
    taskId: null,
    runId: null,
    type: 'owner',
    title: partial.title ?? partial.decisionId,
    question: 'q',
    evidence: [],
    options: [{ optionId: 'o1', label: 'yes' }],
    agentRecommendation: null,
    dueAt: null,
    dueAtMs: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    createdAtMs: 0,
    snoozedUntil: null,
    snoozedUntilMs: null,
    status: 'OPEN',
    ownerId: null,
    resolverId: null,
    selectedOptionId: null,
    comment: null,
    expectedRev: 0,
    boardRev: PIN.boardRev,
    entityRev: 1,
    scopedApprovalId: null,
    auditIds: [],
    expiresAt: null,
    expiresAtMs: null,
    ...partial,
  }
}

describe('C3-F1 envelope shape', () => {
  it('createPinnedEnvelope emits required common fields', () => {
    const env = createPinnedEnvelope(PIN, { hello: 1 }, { surface: 'overview' })
    expect(env.schemaVersion).toBe(CONTROL_CENTER_UI_SCHEMA)
    expect(env.boardId).toBe('mfs-rebuild')
    expect(env.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(env.canonicalHash).toBe(PIN.canonicalHash)
    expect(env.boardRev).toBe(42)
    expect(env.lifecycleRev).toBe(7)
    expect(env.generatedAt).toBe(PIN.generatedAt)
    expect(env.freshnessAgeSeconds).toBe(5)
    expect(env.stale).toBe(false)
    expect(env.staleReason).toBeNull()
    expect(env.data).toEqual({ hello: 1 })
    expect(env.nextCursor).toBeNull()
    expect(env.surfaceState).toBe('populated')
  })

  it('safe shapes: error / disconnected / forbidden', () => {
    const err = envelopeError(PIN, 'DATA_INTEGRITY', 'boom', 'overview')
    expect(err.surfaceState).toBe('error')
    expect(err.data).toBeNull()
    expect(err.error?.code).toBe('DATA_INTEGRITY')

    const disc = envelopeDisconnected(PIN, 'work')
    expect(disc.surfaceState).toBe('disconnected')
    expect(disc.error?.code).toBe('DISCONNECTED')

    const forb = envelopeForbidden(null, 'ops')
    expect(forb.surfaceState).toBe('forbidden')
    expect(forb.stale).toBe(true)
  })
})

describe('DISTINCT counts + six exclusive buckets + STALE overlay', () => {
  it('duplicate task rows collapse; bucket sum = trackedWorkDenominator', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [
        productTask('T-A', 'MAPPED'),
        productTask('T-A', 'BUILT'), // DISTINCT collapse
        productTask('D1', 'PROD_READY'),
        productTask('O1', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
          agentId: 'agent-1',
          role: 'implementer',
          model: 'grok',
          effort: 'high',
          accountRef: 'secret-account-xyz9',
          startedAt: '2026-07-13T11:00:00.000Z',
          heartbeatAt: '2026-07-13T11:55:00.000Z',
          materialProgressAt: '2026-07-13T11:50:00.000Z',
          targetGate: 'FUNCTIONAL',
          evidenceLink: '/evidence/O1',
        }),
        productTask('N1', 'BUILT', {
          selectedForNextDispatch: true,
          eligible: true,
        }),
        productTask('Q1', 'MAPPED', { eligible: true }),
        productTask('B1', 'MAPPED', {
          hasBlockingDecision: true,
          eligible: true,
        }),
        productTask('R1', 'FUNCTIONAL', {
          claimState: 'STALE',
          eligible: false,
        }),
        productTask('STALE-SRC', 'MAPPED', {
          eligible: true,
          staleDataSource: true,
        }),
      ],
    })

    expect(agg.rollup.trackedWorkDenominator).toBe(8) // T-A, D1, O1, N1, Q1, B1, R1, STALE-SRC
    expect(agg.rollup.productDenominator).toBe(8)
    const b = agg.rollup.buckets
    const sum =
      b.DONE +
      b.RECONCILIATION_PENDING +
      b.ONGOING +
      b.NEXT +
      b.QUEUED +
      b.BLOCKED
    expect(sum).toBe(agg.rollup.trackedWorkDenominator)
    expect(b.DONE).toBe(1) // D1
    expect(b.ONGOING).toBe(1) // O1
    expect(b.NEXT).toBe(1) // N1
    expect(b.RECONCILIATION_PENDING).toBe(1) // R1
    expect(b.BLOCKED).toBe(1) // B1
    // QUEUED: T-A, Q1, STALE-SRC
    expect(b.QUEUED).toBe(3)
    // STALE is overlay not a sixth primary bucket
    expect(agg.rollup.overlays.STALE_DATA_SOURCE).toBeGreaterThanOrEqual(1)

    const overview = projectOverview(agg)
    expect(overview.data.buckets).toEqual(b)
    expect(overview.data.overlays.STALE_DATA_SOURCE).toBeGreaterThanOrEqual(1)
  })

  it('overview lifecycle histogram prefers task stages over empty project readiness', () => {
    // Stage-1 mapping progress must show even when PRODUCT readinessStage is null
    // (UNCLASSIFIED / no PRODUCT receipt) — owner-visible MAP_VERIFIED progress.
    expect(
      buildOverviewLifecycleFromTasks([
        { lifecycleStage: 'MAPPED' },
        { lifecycleStage: 'MAPPED' },
        { lifecycleStage: 'MAP_VERIFIED' },
        { lifecycleStage: null },
        { lifecycleStage: 'MAP_VERIFIED' },
      ]),
    ).toEqual(
      expect.arrayContaining([
        { stage: 'MAPPED', count: 2 },
        { stage: 'MAP_VERIFIED', count: 2 },
      ]),
    )
    expect(buildOverviewLifecycleFromProjects([{ readinessStage: null, taskCount: 99 } as never])).toEqual(
      [],
    )
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [
        productTask('T-MV-1', 'MAP_VERIFIED'),
        productTask('T-MV-2', 'MAP_VERIFIED'),
        productTask('T-MP-1', 'MAPPED'),
      ],
      projects: [
        {
          id: 'p1',
          name: 'proj',
          status: null,
          taskCount: 3,
          doneCount: 0,
          blockedCount: 0,
          readinessPercent: null,
          readinessStage: null,
          readinessEvidenceOk: null,
        },
      ],
      g5Domains: [],
    })
    // Prefer task stages even when project readinessStage is empty.
    expect(buildOverviewLifecycle(agg)).toEqual(
      expect.arrayContaining([
        { stage: 'MAP_VERIFIED', count: 2 },
        { stage: 'MAPPED', count: 1 },
      ]),
    )
    const overview = projectOverview(agg)
    expect(overview.data.lifecycle).toEqual(
      expect.arrayContaining([
        { stage: 'MAP_VERIFIED', count: 2 },
        { stage: 'MAPPED', count: 1 },
      ]),
    )
  })

  it('stale completed-task exception: DONE + STALE_CLAIM overlay, not RECONCILIATION_PENDING', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [
        productTask('DONE-STALE', 'PROD_READY', {
          claimState: 'STALE',
          productStageMode: 'STAGE_2',
        }),
      ],
      g5Domains: [],
    })
    expect(agg.rollup.buckets.DONE).toBe(1)
    expect(agg.rollup.buckets.RECONCILIATION_PENDING).toBe(0)
    const a = agg.assignmentsByTaskId.get('DONE-STALE')
    expect(a?.primary).toBe('DONE')
    expect(a?.overlays).toContain('STALE_CLAIM')
    expect(a?.overlays).toContain('RECONCILIATION_DRILLDOWN')
  })
})

describe('zero-click ONGOING sort/fields', () => {
  it('emits all required fields and sorts stalled first → oldest material → taskId', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [
        productTask('O-prod', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
          agentId: 'a-prod',
          role: 'impl',
          model: 'm1',
          effort: 'xhigh',
          accountRef: 'acct-1111',
          startedAt: '2026-07-13T11:50:00.000Z',
          heartbeatAt: '2026-07-13T11:59:00.000Z',
          materialProgressAt: '2026-07-13T11:58:00.000Z',
          targetGate: 'FUNCTIONAL',
          evidenceLink: '/e/O-prod',
        }),
        // Stay ONGOING (VALID_CURRENT + RUNNING) but STALLED substate via material age ≥ 900s
        productTask('O-stall', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
          agentId: 'a-stall',
          role: 'impl',
          model: 'm2',
          effort: 'high',
          accountRef: 'acct-2222',
          startedAt: '2026-07-13T10:00:00.000Z',
          heartbeatAt: '2026-07-13T11:30:00.000Z',
          materialProgressAt: '2026-07-13T11:00:00.000Z', // age 3600s → STALLED
          targetGate: 'INTEGRATED',
          evidenceLink: '/e/O-stall',
        }),
        productTask('O-old', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
          agentId: 'a-old',
          role: 'impl',
          model: 'm3',
          effort: 'med',
          accountRef: 'acct-3333',
          startedAt: '2026-07-13T09:00:00.000Z',
          heartbeatAt: '2026-07-13T11:59:00.000Z',
          // age 1200s → also STALLED but younger material than O-stall
          materialProgressAt: '2026-07-13T11:40:00.000Z',
          targetGate: 'BUILT',
          evidenceLink: '/e/O-old',
        }),
      ],
      g5Domains: [],
    })

    expect(agg.ongoing).toHaveLength(3)
    const ids = agg.ongoing.map((o) => o.taskId)
    // Stalled substates first; within stalled, oldest materialProgressAge first
    expect(agg.ongoing[0]!.productiveSubstate).toBe('STALLED')
    expect(agg.ongoing[0]!.taskId).toBe('O-stall')
    expect(agg.ongoing[1]!.productiveSubstate).toBe('STALLED')
    expect(agg.ongoing[1]!.taskId).toBe('O-old')
    expect(agg.ongoing[2]!.taskId).toBe('O-prod')
    expect(agg.ongoing[2]!.productiveSubstate).toBe('PRODUCTIVE')

    // Within stalled: oldest materialProgressAge first
    const stalled = agg.ongoing.filter((o) => o.productiveSubstate === 'STALLED')
    for (let i = 1; i < stalled.length; i++) {
      const prev = stalled[i - 1]!.materialProgressAgeSeconds ?? -1
      const cur = stalled[i]!.materialProgressAgeSeconds ?? -1
      expect(prev).toBeGreaterThanOrEqual(cur)
    }

    const row = agg.ongoing.find((o) => o.taskId === 'O-prod')!
    expect(row.title).toBeTruthy()
    expect(row.targetGate).toBe('FUNCTIONAL')
    expect(row.agentId).toBe('a-prod')
    expect(row.role).toBe('impl')
    expect(row.model).toBe('m1')
    expect(row.effort).toBe('xhigh')
    expect(row.maskedAccount).toMatch(/^acc_\*\*\*/)
    expect(row.startedAgeSeconds).not.toBeNull()
    expect(row.heartbeatAgeSeconds).not.toBeNull()
    expect(row.materialProgressAgeSeconds).not.toBeNull()
    expect(row.productiveSubstate).toBeTruthy()
    expect(row.evidenceLink).toBe('/e/O-prod')
    expect(row.bucket).toBe('ONGOING')

    // stable sort helper
    const sorted = [...agg.ongoing].sort(compareOngoingZeroClick)
    expect(sorted.map((o) => o.taskId)).toEqual(ids)
  })
})

describe('decision order', () => {
  it('blocking desc → severity → dueAt asc null last → createdAt → decisionId', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      decisions: [
        decision({
          decisionId: 'D-low',
          severity: 'LOW',
          blocking: false,
          createdAtMs: 100,
          createdAt: '2026-07-13T10:00:00.100Z',
        }),
        decision({
          decisionId: 'D-block-med',
          severity: 'MEDIUM',
          blocking: true,
          createdAtMs: 50,
          createdAt: '2026-07-13T10:00:00.050Z',
        }),
        decision({
          decisionId: 'D-high-late',
          severity: 'HIGH',
          blocking: false,
          dueAt: '2026-07-14T00:00:00.000Z',
          dueAtMs: 2_000,
          createdAtMs: 10,
          createdAt: '2026-07-13T10:00:00.010Z',
        }),
        decision({
          decisionId: 'D-high-early',
          severity: 'HIGH',
          blocking: false,
          dueAt: '2026-07-13T18:00:00.000Z',
          dueAtMs: 1_000,
          createdAtMs: 20,
          createdAt: '2026-07-13T10:00:00.020Z',
        }),
      ],
    })

    expect(agg.decisions.map((d) => d.decisionId)).toEqual([
      'D-block-med',
      'D-high-early',
      'D-high-late',
      'D-low',
    ])

    const env = projectDecisions(agg)
    expect(env.data.decisions.map((d) => d.decisionId)).toEqual([
      'D-block-med',
      'D-high-early',
      'D-high-late',
      'D-low',
    ])
    expect(env.data.blockingCount).toBe(1)
  })
})

describe('rich Decisions projection (C3-R2B)', () => {
  it('projects question/options/tradeoffs/recommendation/ids/owner/resolver/revs/audit/approval', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      decisions: [
        decision({
          decisionId: 'D-rich',
          severity: 'HIGH',
          blocking: true,
          title: 'Capacity floor',
          question: 'Raise Grok floor to 60?',
          evidence: ['ev-cap-1', 'ev-cap-2'],
          options: [
            { optionId: 'yes', label: 'Raise', tradeoffs: 'cost', declining: false },
            { optionId: 'no', label: 'Hold', tradeoffs: 'risk delay', declining: true },
          ],
          agentRecommendation: 'Raise with monitor',
          ownerId: 'owner-a',
          resolverId: null,
          selectedOptionId: null,
          expectedRev: 42,
          boardRev: 42,
          entityRev: 5,
          scopedApprovalId: 'appr-9',
          auditIds: ['aud-1', 'aud-2'],
          projectId: 'proj-1',
          featureId: 'feat-1',
          taskId: 'task-1',
          runId: null,
          comment: 'PRIVATE owner note must never ship',
          createdAt: '2026-07-13T11:00:00.000Z',
          createdAtMs: 100,
        }),
      ],
    })
    const env = projectDecisions(agg)
    const row = env.data.decisions[0]
    expect(row.question).toBe('Raise Grok floor to 60?')
    expect(row.options).toEqual([
      { optionId: 'yes', label: 'Raise', tradeoffs: 'cost', declining: false },
      { optionId: 'no', label: 'Hold', tradeoffs: 'risk delay', declining: true },
    ])
    expect(row.agentRecommendation).toBe('Raise with monitor')
    expect(row.evidence).toEqual(['ev-cap-1', 'ev-cap-2'])
    expect(row.ownerId).toBe('owner-a')
    expect(row.resolverId).toBeNull()
    expect(row.expectedRev).toBe(42)
    expect(row.boardRev).toBe(42)
    expect(row.entityRev).toBe(5)
    expect(row.scopedApprovalId).toBe('appr-9')
    expect(row.auditIds).toEqual(['aud-1', 'aud-2'])
    expect(row.projectId).toBe('proj-1')
    expect(row.taskId).toBe('task-1')
    // Redaction: private comment never present on projected rows
    expect(JSON.stringify(env.data)).not.toMatch(/PRIVATE owner note/)
    expect(JSON.stringify(env.data)).not.toMatch(/"comment"/)
    // No epoch placeholder
    expect(row.createdAt).toBe('2026-07-13T11:00:00.000Z')
    expect(row.dueAt).toBeNull()
    expect(env.data.items[0]).toMatchObject({ decisionId: 'D-rich' })
  })

  it('REJECTED status vs RESOLVED+declining option remain distinct on projection', () => {
    // Terminal rows are filtered from inbox aggregation; projector still maps truth when present.
    const rejected = projectDecisionUiRow(
      decision({
        decisionId: 'D-rej',
        severity: 'LOW',
        blocking: false,
        status: 'REJECTED',
        question: 'reject path?',
        options: [{ optionId: 'x', label: 'X' }],
        selectedOptionId: null,
        createdAtMs: 1,
      }),
    )
    const declined = projectDecisionUiRow(
      decision({
        decisionId: 'D-dec',
        severity: 'LOW',
        blocking: false,
        status: 'RESOLVED',
        question: 'decline path?',
        options: [
          { optionId: 'yes', label: 'Yes' },
          { optionId: 'no', label: 'No', declining: true },
        ],
        selectedOptionId: 'no',
        createdAtMs: 2,
      }),
    )
    expect(rejected.status).toBe('REJECTED')
    expect(rejected.selectedOptionId).toBeNull()
    expect(declined.status).toBe('RESOLVED')
    expect(declined.selectedOptionId).toBe('no')
    expect(declined.options.find((o) => o.optionId === 'no')?.declining).toBe(true)
  })

  it('partial-on-absent: empty question/options stay null/[] not invented', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      decisions: [
        decision({
          decisionId: 'D-sparse',
          severity: 'MEDIUM',
          blocking: false,
          question: '',
          options: [],
          agentRecommendation: null,
          evidence: [],
          createdAtMs: 1,
        }),
      ],
    })
    const env = projectDecisions(agg)
    const row = env.data.decisions[0]
    expect(row.question).toBeNull()
    expect(row.options).toEqual([])
    expect(row.agentRecommendation).toBeNull()
    expect(row.evidence).toEqual([])
  })
})

describe('priority false/null/N-A + productDenominator=0', () => {
  it('zero capacity → majority false, share null → N-A display', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [
        productTask('P1', 'MAPPED', {
          priorityMembership: true,
          classification: cls('P1', 'PRODUCT', 'ACTIVE', {
            receipt: receipt('P1', 'PRODUCT', 'ACTIVE', {
              membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
              membershipProofHash: 'proofhash11111111111111',
            }),
          }),
        }),
      ],
      priorityPackets: [], // zero schedulable capacity
    })
    expect(agg.priority.membershipDenominator).toBe(1)
    expect(agg.priority.allClosureCapacity).toBe(0)
    expect(agg.priority.priorityCapacityShare).toBeNull()
    expect(agg.priority.majorityAllocationPass).toBe(false)

    const env = projectPriority(agg)
    expect(env.data.majorityAllocationDisplay).toBe('false')
    expect(env.data.priorityCapacityShareDisplay).toBe('N-A')
  })

  it('empty membership frontier → majority null + N-A', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [productTask('X1', 'MAPPED', { priorityMembership: false })],
      priorityPackets: [
        {
          packetId: 'pk1',
          taskId: 'X1',
          liveOrReserved: true,
          genuine: true,
          unique: true,
          currentHash: true,
          dependencyReady: true,
          collisionSafe: true,
          advancesOpenClosureGate: true,
          isPriorityPortfolio: false,
        },
      ],
    })
    expect(agg.priority.membershipDenominator).toBe(0)
    expect(agg.priority.majorityAllocationPass).toBeNull()
    expect(agg.priority.priorityCapacityShare).toBeNull()
    const env = projectPriority(agg)
    expect(env.data.majorityAllocationDisplay).toBe('N-A')
    expect(env.data.priorityCapacityShareDisplay).toBe('N-A')
  })

  it('productDenominator=0 → null readiness, EMPTY_PRODUCT_SCOPE', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: allG5Pass(),
      tasks: [
        {
          taskId: 'H1',
          classification: cls('H1', 'PRODUCT', 'HOLD'),
          lifecycleStage: 'PROD_READY',
          title: 'held',
        },
      ],
    })
    expect(agg.rollup.productDenominator).toBe(0)
    expect(agg.rollup.rawTaskReadinessPercent).toBeNull()
    expect(agg.rollup.boardReadinessPercent).toBeNull()
    expect(agg.rollup.cappedBy).toBe('EMPTY_PRODUCT_SCOPE')
    expect(agg.rollup.complete).toBe(false)
    const overview = projectOverview(agg)
    expect(overview.data.productDenominator).toBe(0)
    expect(overview.data.boardReadinessPercent).toBeNull()
    expect(overview.data.cappedBy).toBe('EMPTY_PRODUCT_SCOPE')
  })
})

describe('identical pins across all projections', () => {
  it('all nine surfaces share pin identity', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: allG5Pass(),
      tasks: [
        productTask('T1', 'MAPPED'),
        productTask('O1', 'BUILT', {
          claimState: 'VALID_CURRENT',
          runLiveness: 'RUNNING',
          eligible: false,
          agentId: 'a1',
          role: 'r',
          accountRef: 'acc-9999',
          startedAt: '2026-07-13T11:00:00.000Z',
          heartbeatAt: '2026-07-13T11:59:00.000Z',
          materialProgressAt: '2026-07-13T11:50:00.000Z',
          targetGate: 'FUNCTIONAL',
        }),
      ],
      projects: [{ id: 'p1', name: 'P', status: 'active', taskCount: 2, doneCount: 0, blockedCount: 0 }],
      features: [
        {
          id: 'f1',
          projectId: 'p1',
          name: 'F',
          phase: 'build',
          flowBranch: 'open',
          taskCount: 1,
        },
      ],
      runs: [
        {
          runId: 'run-1',
          taskId: 'O1',
          agentId: 'a1',
          role: 'impl',
          model: 'm',
          effort: 'h',
          maskedAccount: 'acc_***9999',
          status: 'RUNNING',
          startedAt: '2026-07-13T11:00:00.000Z',
          heartbeatAt: '2026-07-13T11:59:00.000Z',
          materialProgressAt: '2026-07-13T11:50:00.000Z',
          productiveSubstate: 'PRODUCTIVE',
          createdAt: '2026-07-13T11:00:00.000Z',
          id: 'run-1',
        },
      ],
      accounts: [
        {
          maskedAccountId: 'plain-account-abcd',
          status: 'HEALTHY',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
          physicalSlotsDisplay: '1/5',
          quarantine: false,
          reason: null,
        },
      ],
      decisions: [
        decision({
          decisionId: 'D1',
          severity: 'CRITICAL',
          blocking: true,
          title: 'Need owner',
        }),
      ],
      auditEvents: [
        {
          id: 'ev1',
          createdAt: '2026-07-13T11:00:00.000Z',
          kind: 'lifecycle.advance',
          actorId: 'agent-1',
          subjectId: 'T1',
          summary: 'advanced',
          materialHash: 'mh1',
          boardRev: 42,
        },
      ],
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: 'plan-1',
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
    })

    const all = projectAllSurfaces(agg)
    const identities = Object.values(all).map(envelopePinIdentity)
    const first = identities[0]!
    for (const id of identities) {
      expect(id).toEqual(first)
    }
    expect(first.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
    expect(first.boardId).toBe('mfs-rebuild')
    expect(first.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(first.canonicalHash).toBe(PIN.canonicalHash)
    expect(first.boardRev).toBe(42)
    expect(first.lifecycleRev).toBe(7)
    expect(first.generatedAt).toBe(PIN.generatedAt)

    // accounts masked
    expect(all.ops.data.accounts[0]!.maskedAccountId).toMatch(/^acc_/)
    // secrets stripped
    const leaked = JSON.stringify(all)
    expect(leaked).not.toMatch(/password|clientSecret|rawIdentity/i)
    expect(leaked).not.toContain('plain-account-abcd')
  })
})

describe('work cursor pagination pins revision', () => {
  it('pages with nextCursor bound to boardRev + snapshot', () => {
    const tasks = Array.from({ length: 5 }, (_, i) =>
      productTask(`T-${i}`, 'MAPPED', {
        createdAt: `2026-07-13T10:0${i}:00.000Z`,
      }),
    )
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks,
      g5Domains: [],
    })
    const page1 = projectWork(agg, { pageSize: 2 })
    expect(page1.data.items).toHaveLength(2)
    expect(page1.nextCursor).toBeTruthy()
    expect(page1.boardRev).toBe(42)
    expect(page1.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)

    const page2 = projectWork(agg, {
      pageSize: 2,
      cursor: page1.nextCursor,
    })
    expect(page2.data.items).toHaveLength(2)
    const ids1 = page1.data.items.map((i) => i.taskId)
    const ids2 = page2.data.items.map((i) => i.taskId)
    expect(new Set([...ids1, ...ids2]).size).toBe(4)
  })
})

describe('projectWork stale-family overlay filtering', () => {
  it('stale-family filter includes rows with any STALE-family overlay only', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [
        productTask('S_DS', 'ONGOING', { staleDataSource: true, createdAt: '2026-07-13T10:00:00.000Z' }),
        productTask('S_DP', 'ONGOING', {
          staleDispatchPlan: true,
          createdAt: '2026-07-13T09:00:00.000Z',
        }),
        productTask('S_AS', 'ONGOING', {
          staleAccountSync: true,
          createdAt: '2026-07-13T08:00:00.000Z',
        }),
        productTask('S_ES', 'ONGOING', {
          runLiveness: 'STALLED',
          createdAt: '2026-07-13T07:00:00.000Z',
        }),
        // Completed linger → DONE + STALE_CLAIM (family)
        productTask('S_SC', 'PROD_READY', {
          claimState: 'STALE',
          createdAt: '2026-07-13T06:00:00.000Z',
        }),
        // Incomplete ownership claim → RECONCILIATION_PENDING + STALE_CLAIM (family)
        productTask('S_RECON_ORPHAN', 'BUILT', {
          claimState: 'ORPHAN',
          eligible: false,
          createdAt: '2026-07-13T05:30:00.000Z',
        }),
        productTask('S_RECON_FENCED', 'FUNCTIONAL', {
          claimState: 'FENCED',
          eligible: false,
          createdAt: '2026-07-13T05:20:00.000Z',
        }),
        // Non-family: beyond-stage incomplete has RECONCILIATION_DRILLDOWN + BEYOND_STAGE_ONGOING only
        productTask('NON_FAMILY', 'BUILT', {
          claimState: 'BEYOND_STAGE',
          eligible: false,
          createdAt: '2026-07-13T05:00:00.000Z',
        }),
        // Clean queued row — no overlays
        productTask('CLEAN_Q', 'MAPPED', {
          eligible: true,
          createdAt: '2026-07-13T04:00:00.000Z',
        }),
      ],
    })

    const env = projectWork(agg, { staleFamily: true })
    const ids = env.data.items.map((i) => i.taskId)

    expect(ids).toContain('S_DS')
    expect(ids).toContain('S_DP')
    expect(ids).toContain('S_AS')
    expect(ids).toContain('S_ES')
    expect(ids).toContain('S_SC')
    expect(ids).toContain('S_RECON_ORPHAN')
    expect(ids).toContain('S_RECON_FENCED')
    expect(ids).not.toContain('NON_FAMILY')
    expect(ids).not.toContain('CLEAN_Q')
    expect(env.data.filter.staleFamily).toBe(true)
    expect(env.data.filter.overlay).toBeNull()

    // Incomplete recon remains primary RECONCILIATION_PENDING (not a 7th bucket)
    const orphanRow = env.data.items.find((i) => i.taskId === 'S_RECON_ORPHAN')
    expect(orphanRow?.bucket).toBe('RECONCILIATION_PENDING')
    expect(orphanRow?.overlays).toContain('STALE_CLAIM')
    const doneStale = env.data.items.find((i) => i.taskId === 'S_SC')
    expect(doneStale?.bucket).toBe('DONE')
    expect(doneStale?.overlays).toContain('STALE_CLAIM')
  })

  it('stale-family + exact overlay narrows family rows', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [
        productTask('S1', 'ONGOING', { staleDataSource: true }),
        productTask('S2', 'ONGOING', {
          staleDispatchPlan: true,
          claimState: 'STALE',
          createdAt: '2026-07-13T10:00:00.000Z',
        }),
      ],
    })

    const env = projectWork(agg, { staleFamily: true, overlay: 'STALE_DISPATCH_PLAN' })
    expect(env.data.items).toHaveLength(1)
    expect(env.data.items[0]?.taskId).toBe('S2')
    expect(env.data.filter.overlay).toBe('STALE_DISPATCH_PLAN')
    expect(env.data.filter.staleFamily).toBe(true)
  })

  it('bucket + stale-family + overlay filters compose deterministically', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      g5Domains: [],
      tasks: [
        productTask('RDS', 'RECONCILIATION_PENDING', {
          staleDataSource: true,
          claimState: 'STALE',
          createdAt: '2026-07-13T10:00:00.000Z',
        }),
        productTask('Q', 'QUEUED', { staleDataSource: true }),
      ],
    })

    const reconOnly = projectWork(agg, {
      bucket: 'RECONCILIATION_PENDING',
      staleFamily: true,
      overlay: null,
    })
    const idsRecon = reconOnly.data.items.map((i) => i.taskId)
    expect(idsRecon).toEqual(['RDS'])

    const allFamily = projectWork(agg, {
      staleFamily: true,
      overlay: 'STALE_DATA_SOURCE',
      cursor: null,
    })
    const idsAll = new Set(allFamily.data.items.map((i) => i.taskId))
    expect(idsAll).toContain('RDS')
    expect(idsAll).toContain('Q')
  })
})

describe('projectOps fail-closed account capacity', () => {
  it('missing accountSyncMeta → stale + usableCapacity 0 (no optimistic sum)', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      accounts: [
        {
          maskedAccountId: 'acc_***ok',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 10,
          physicalSlotsDisplay: '0/10',
          quarantine: false,
          reason: null,
        },
      ],
    })
    expect(agg.accountSyncMeta).toBeNull()
    const ops = projectOps(agg)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.usableCapacity).toBe(0)
    expect(ops.data.sourceRevision).toBeNull()
    expect(ops.data.capacityNote).toBe('ACCOUNT_SYNC_MISSING')
  })

  it('authoritative fresh snapshot usableCapacity preferred; LIMIT/BAN not summed when meta usable null', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      accounts: [
        {
          maskedAccountId: 'acc_***a',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 5,
          physicalSlotsDisplay: '1/5',
          quarantine: false,
          reason: null,
        },
        {
          maskedAccountId: 'acc_***l',
          status: 'LIMIT',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 5,
          physicalSlotsDisplay: null,
          quarantine: false,
          reason: 'limit',
        },
        {
          maskedAccountId: 'acc_***b',
          status: 'BAN',
          providerKind: 'SPARK',
          effectiveInUse: 0,
          effectiveCap: 3,
          physicalSlotsDisplay: null,
          quarantine: true,
          reason: 'ban',
        },
      ],
      accountSyncMeta: {
        authoritative: true,
        sourceRevision: 55,
        generatedAt: NOW,
        stale: false,
        staleReason: null,
        usableCapacity: null,
        readbackParityOk: true,
      },
    })
    const ops = projectOps(agg)
    expect(ops.data.accountSyncStale).toBe(false)
    // Only ACTIVE remaining: 5-1=4; LIMIT/BAN excluded
    expect(ops.data.usableCapacity).toBe(4)
    expect(ops.data.sourceRevision).toBe(55)
    expect(ops.data.sourceRevision).not.toBe(PIN.boardRev)
  })

  it('stale authoritative meta zeros capacity even if account caps would sum > 0', () => {
    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
      accounts: [
        {
          maskedAccountId: 'acc_***a',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 0,
          effectiveCap: 8,
          physicalSlotsDisplay: null,
          quarantine: false,
          reason: null,
        },
      ],
      accountSyncMeta: {
        authoritative: true,
        sourceRevision: 3,
        generatedAt: NOW,
        stale: true,
        staleReason: 'PERIODIC_HEALTH_MISS_60S',
        usableCapacity: 8,
        readbackParityOk: false,
      },
    })
    const ops = projectOps(agg)
    expect(ops.data.usableCapacity).toBe(0)
    expect(ops.data.accountSyncStale).toBe(true)
    expect(ops.data.accountStaleReason).toBe('PERIODIC_HEALTH_MISS_60S')
  })
})

describe('sensitive fields never enter public-shaped data', () => {
  it('stripSensitiveFields drops tokens; maskAccountForUi masks', () => {
    const raw = {
      title: 'ok',
      password: 'secret',
      token: 'tok',
      accountRef: 'my-raw-account-id-42',
      nested: { clientSecret: 'x', keep: 1 },
    }
    const clean = stripSensitiveFields(raw) as Record<string, unknown>
    expect(clean.password).toBeUndefined()
    expect(clean.token).toBeUndefined()
    expect(clean.accountRef).toBeUndefined()
    expect(clean.maskedAccount).toMatch(/^acc_\*\*\*/)
    expect((clean.nested as Record<string, unknown>).clientSecret).toBeUndefined()
    expect((clean.nested as Record<string, unknown>).keep).toBe(1)
    expect(maskAccountForUi('abcd1234')).toBe('acc_***1234')
  })

  it('stripSensitiveFields drops private decision comment keys', () => {
    const clean = stripSensitiveFields({
      decisionId: 'd1',
      comment: 'owner private',
      privateComment: 'x',
      decisionText: 'y',
      ownerComment: 'z',
      title: 'public title',
    }) as Record<string, unknown>
    expect(clean.comment).toBeUndefined()
    expect(clean.privateComment).toBeUndefined()
    expect(clean.decisionText).toBeUndefined()
    expect(clean.ownerComment).toBeUndefined()
    expect(clean.title).toBe('public title')
  })
})

describe('control-center-query client helpers (no formula recompute)', () => {
  it('stable query keys per surface', () => {
    expect(overviewQueryKey('mfs-rebuild')).toEqual([
      'control-center',
      'overview',
      'mfs-rebuild',
    ])
    expect(workQueryKey('mfs-rebuild', { bucket: 'DONE' })[3]).toMatchObject({
      bucket: 'DONE',
      overlay: null,
    })
    expect(priorityQueryKey('b')).toEqual(['control-center', 'priority', 'b'])
    expect(projectsQueryKey('b')[1]).toBe('projects')
    expect(featuresQueryKey('b')[1]).toBe('features')
    expect(agentsQueryKey('b')[1]).toBe('agents')
    expect(opsQueryKey('b')[1]).toBe('ops')
    expect(decisionsQueryKey('b')[1]).toBe('decisions')
    expect(evidenceQueryKey('b')[1]).toBe('evidence')
  })

  it('formatAgeSeconds + deep link + majority display from envelope only', () => {
    expect(formatAgeSeconds(30)).toBe('30s')
    expect(formatAgeSeconds(120)).toBe('2m')
    expect(formatAgeSeconds(null)).toBe('—')
    const link = buildWorkDeepLink({
      boardId: 'mfs-rebuild',
      bucket: 'ONGOING',
      boardRev: 42,
      canonicalSnapshotId: 'snap-1',
    })
    expect(link).toContain('/b/mfs-rebuild/work')
    expect(link).toContain('bucket=ONGOING')
    expect(link).toContain('boardRev=42')

    const agg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [],
      g5Domains: [],
    })
    const env = projectPriority(agg)
    expect(majorityDisplayFromEnvelope(env)).toBe('N-A')
    expect(resolveClientSurfaceState(env)).toBe(env.surfaceState)
    expect(resolveClientSurfaceState(null, 'offline')).toBe('disconnected')
    expect(resolveClientSurfaceState(null)).toBe('loading')
  })
})

describe('partial / stale surface states', () => {
  it('sectionErrors → partial; pin.stale → stale', () => {
    const partialAgg = aggregateControlCenter({
      pin: PIN,
      now: NOW,
      tasks: [productTask('T1', 'MAPPED')],
      g5Domains: [],
      sectionErrors: [{ section: 'runs', code: 'LOAD_FAIL', message: 'runs unavailable' }],
    })
    expect(projectOverview(partialAgg).surfaceState).toBe('partial')

    const staleAgg = aggregateControlCenter({
      pin: { ...PIN, stale: true, staleReason: 'ACCOUNT_SYNC_STALE' },
      now: NOW,
      tasks: [productTask('T1', 'MAPPED')],
      g5Domains: [],
    })
    expect(projectOverview(staleAgg).surfaceState).toBe('stale')
    expect(projectOverview(staleAgg).stale).toBe(true)
    expect(projectOverview(staleAgg).staleReason).toBe('ACCOUNT_SYNC_STALE')
  })
})
