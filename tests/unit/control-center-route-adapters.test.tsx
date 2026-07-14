import { describe, expect, it } from 'vitest'

import {
  CONTROL_CENTER_PRIMARY_NAV_IDS,
  buildWorkDeepLink,
  isControlCenterBoard,
  overviewQueryKey,
  workQueryKey,
  priorityQueryKey,
  evidenceQueryKey,
} from '#/lib/control-center-query'
import {
  overviewEnvelopeToProps,
  workEnvelopeToProps,
  priorityEnvelopeToProps,
  decisionsEnvelopeToProps,
  evidenceEnvelopeToViewModel,
  pinIdentityFromEnvelope,
  projectOverviewLifecycle,
  projectOverviewMaterialEvents,
} from '#/lib/control-center-route-adapters'
import type { WorkItemRow } from '#/components/control-center/work'
import {
  createPinnedEnvelope,
  type ControlCenterPin,
  type OverviewData,
  type WorkData,
  type PriorityData,
  type DecisionsData,
  type EvidenceData,
} from '#/server/control-center-ui'

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'snap-route-1',
  canonicalHash: 'canon_eeeeeeeeeeee',
  taskHash: 'task_ffffffffffff',
  boardRev: 3,
  lifecycleRev: 1,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 12,
  stale: false,
  staleReason: null,
}

const emptyBuckets = {
  DONE: 0,
  RECONCILIATION_PENDING: 0,
  ONGOING: 0,
  NEXT: 0,
  QUEUED: 0,
  BLOCKED: 2,
}

const emptyOverlays = {
  STALE_DATA_SOURCE: 0,
  EXPIRED_STALLED_RUN: 0,
  STALE_CLAIM: 0,
  STALE_DISPATCH_PLAN: 0,
  STALE_ACCOUNT_SYNC: 0,
  BEYOND_STAGE_ONGOING: 0,
  RECONCILIATION_DRILLDOWN: 0,
}

describe('control-center-route-adapters', () => {
  it('mfs-rebuild nav ids include all nine destinations', () => {
    expect(isControlCenterBoard('mfs-rebuild')).toBe(true)
    expect([...CONTROL_CENTER_PRIMARY_NAV_IDS]).toEqual([
      'overview',
      'work',
      'priority',
      'projects',
      'features',
      'agents',
      'ops',
      'decisions',
      'evidence',
    ])
  })

  it('query keys cover nine surfaces + work filter/deep-link', () => {
    expect(overviewQueryKey('mfs-rebuild')).toEqual(['control-center', 'overview', 'mfs-rebuild'])
    expect(
      workQueryKey('mfs-rebuild', {
        bucket: 'BLOCKED',
        overlay: null,
        cursor: 'c1',
        pageSize: 50,
        staleFamily: true,
      })[3],
    ).toMatchObject({
      bucket: 'BLOCKED',
      cursor: 'c1',
      staleFamily: true,
    })
    expect(
      workQueryKey('mfs-rebuild', {
        bucket: 'ONGOING',
        overlay: 'STALE_DATA_SOURCE',
        staleFamily: false,
        cursor: 'c2',
      })[3],
    ).toMatchObject({
      overlay: 'STALE_DATA_SOURCE',
      staleFamily: false,
    })
    expect(priorityQueryKey('mfs-rebuild')[1]).toBe('priority')
    expect(evidenceQueryKey('mfs-rebuild', { cursor: 'x' })[1]).toBe('evidence')
    expect(buildWorkDeepLink({ boardId: 'mfs-rebuild', bucket: 'ONGOING' })).toBe(
      '/b/mfs-rebuild/work?bucket=ONGOING',
    )
  })

  it('overview mapping: mission fields present, no sensitive keys', () => {
    const data: OverviewData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets,
      overlays: emptyOverlays,
      trackedWorkDenominator: 2,
      productDenominator: 0,
      stageProdReady: 0,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 2,
      g5Pass: false,
      complete: false,
      rawTaskReadinessPercent: null,
      boardReadinessPercent: null,
      cappedBy: 'DATA_INTEGRITY_OR_P0',
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipTaskIds: [],
        membershipDenominator: 0,
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY',
        reason: 'no membership',
      },
      g5: { g5Pass: false, domainResults: [], missingDomains: [] },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      ongoing: [],
      decisionCount: 1,
      topDecision: {
        decisionId: 'd1',
        severity: 'HIGH',
        blocking: true,
        title: 'Need owner call',
        status: 'OPEN',
        question: 'Should we raise capacity?',
      },
      needsHuman: true,
      projects: [{ id: 'p1', name: 'P', status: null, taskCount: 1, doneCount: 0, blockedCount: 0 }],
      sectionErrors: [{ section: 'classification', code: 'DATA_INTEGRITY', message: 'missing receipts' }],
    }
    const env = createPinnedEnvelope(PIN, data, {
      surface: 'overview',
      surfaceState: 'needs-human',
    })
    const props = overviewEnvelopeToProps(env, { boardLabel: 'MFS' })
    expect(props.surfaceState).toBe('needs-human')
    expect(props.decision?.count).toBe(1)
    expect(props.priority?.portfolioId).toBe('SALES_WEB_RELATED_BACKEND')
    expect(props.priority?.majorityDisplay).toBe('N-A')
    expect(props.global?.trackedWorkDenominator).toBe(2)
    expect(props.buckets?.counts.BLOCKED).toBe(2)
    expect(props.decision?.topItem?.question).toBe('Should we raise capacity?')
    expect(props.pin?.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(props.pin?.canonicalHash).toBe(PIN.canonicalHash)
    expect(props.pin?.boardRev).toBe(PIN.boardRev)
    expect(props.pin?.lifecycleRev).toBe(PIN.lifecycleRev)
    expect(props.lower?.lifecycle).toEqual([])
    expect(props.lower?.materialEvents).toEqual([])
    expect(JSON.stringify(props)).not.toMatch(/token|password|secret/i)
  })

  it('overview projects lifecycle from projects.readinessStage and materialEvents from wire', () => {
    const data: OverviewData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets,
      overlays: emptyOverlays,
      trackedWorkDenominator: 3,
      productDenominator: 2,
      stageProdReady: 1,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 0,
      g5Pass: false,
      complete: false,
      rawTaskReadinessPercent: null,
      boardReadinessPercent: null,
      cappedBy: 'DATA_INTEGRITY_OR_P0',
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipTaskIds: [],
        membershipDenominator: 0,
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY',
        reason: 'no membership',
      },
      g5: { g5Pass: false, domainResults: [], missingDomains: [] },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      ongoing: [],
      decisionCount: 0,
      topDecision: null,
      needsHuman: false,
      projects: [
        {
          id: 'p1',
          name: 'A',
          status: null,
          taskCount: 2,
          doneCount: 0,
          blockedCount: 0,
          readinessStage: 'BUILT',
        },
        {
          id: 'p2',
          name: 'B',
          status: null,
          taskCount: 1,
          doneCount: 0,
          blockedCount: 0,
          readinessStage: 'BUILT',
        },
        {
          id: 'p3',
          name: 'C',
          status: null,
          taskCount: 4,
          doneCount: 0,
          blockedCount: 0,
          readinessStage: 'PROD_READY',
        },
      ],
      sectionErrors: [],
    }
    const withEvents = {
      ...data,
      auditEvents: [
        {
          id: 'ev-1',
          createdAt: '2026-07-13T12:00:00.000Z',
          kind: 'lifecycle.advance',
          actorId: 'agent-1',
          summary: 'advanced T1',
          materialHash: 'mh1',
        },
      ],
    }
    expect(projectOverviewLifecycle(data)).toEqual([
      { stage: 'BUILT', count: 3 },
      { stage: 'PROD_READY', count: 4 },
    ])
    expect(projectOverviewMaterialEvents(data)).toEqual([])
    expect(projectOverviewMaterialEvents(withEvents as OverviewData)).toEqual([
      {
        eventId: 'ev-1',
        atLabel: '2026-07-13T12:00:00.000Z',
        kind: 'lifecycle.advance',
        summary: 'advanced T1',
        actor: 'agent-1',
      },
    ])
    const env = createPinnedEnvelope(PIN, withEvents as OverviewData, { surface: 'overview' })
    const props = overviewEnvelopeToProps(env)
    expect(props.lower?.lifecycle).toEqual([
      { stage: 'BUILT', count: 3 },
      { stage: 'PROD_READY', count: 4 },
    ])
    expect(props.lower?.materialEvents).toHaveLength(1)
    expect(props.lower?.materialEvents[0]?.eventId).toBe('ev-1')
  })

  it('overview never synthesizes question from title', () => {
    const data = {
      surfaceVersion: 'CC_UI_V1' as const,
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 0,
      },
      overlays: {},
      trackedWorkDenominator: 0,
      productDenominator: 0,
      stageProdReady: 0,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 0,
      g5Pass: false,
      complete: false,
      rawTaskReadinessPercent: null,
      boardReadinessPercent: null,
      cappedBy: null,
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND' as const,
        membershipTaskIds: [],
        membershipDenominator: 0,
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY' as const,
        reason: null,
      },
      g5: { g5Pass: false, domainResults: [], missingDomains: [] },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan' as const,
      },
      ongoing: [],
      decisionCount: 1,
      topDecision: {
        decisionId: 'd-no-q',
        severity: 'MEDIUM',
        blocking: false,
        title: 'Only title',
        status: 'OPEN',
        question: null,
      },
      needsHuman: false,
      projects: [],
      sectionErrors: [],
    }
    const env = createPinnedEnvelope(PIN, data as never, { surface: 'overview' })
    const props = overviewEnvelopeToProps(env)
    expect(props.decision?.topItem?.title).toBe('Only title')
    expect(props.decision?.topItem?.question).toBeNull()
  })

  it('work mapping: filter deep-link fields + items without recompute', () => {
    const data: WorkData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets,
      overlays: emptyOverlays,
      trackedWorkDenominator: 2,
      filter: { bucket: 'BLOCKED', overlay: null, staleFamily: null },
      items: [
        {
          taskId: 'T1',
          title: 'One',
          projectId: 'p1',
          featureId: null,
          bucket: 'BLOCKED',
          overlays: [],
          blockReason: 'DATA_INTEGRITY',
          outsideTracked: false,
          lifecycleStage: null,
          targetGate: null,
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T1',
        },
      ],
      pageSize: 50,
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
    }
    const env = createPinnedEnvelope(PIN, data, {
      surface: 'work',
      nextCursor: 'cursor-next',
    })
    const props = workEnvelopeToProps(env, {
      boardId: 'mfs-rebuild',
      activeBucket: 'BLOCKED',
      staleOverlayActive: false,
    })
    expect(props.items).toHaveLength(1)
    expect(props.items[0].bucket).toBe('BLOCKED')
    expect(props.items[0].blockReason).toBe('DATA_INTEGRITY')
    expect(props.items[0].detailHref).toBe('/b/mfs-rebuild/work/T1')
    expect(props.page.nextCursor).toBe('cursor-next')
    expect(props.pinned?.boardRev).toBe(3)
    expect(props.pinned?.taskHash).toBe('')
  })

  it('work mapping: ONGOING zero-click join + pin taskHash preservation + NEXT reason', () => {
    const data: WorkData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 1,
        NEXT: 1,
        QUEUED: 0,
        BLOCKED: 0,
      },
      overlays: emptyOverlays,
      trackedWorkDenominator: 2,
      filter: { bucket: null, overlay: null, staleFamily: null },
      items: [
        {
          taskId: 'T-ON',
          title: 'Running',
          projectId: 'p1',
          featureId: null,
          bucket: 'ONGOING',
          overlays: [],
          blockReason: null,
          outsideTracked: false,
          lifecycleStage: 'BUILT',
          targetGate: 'FUNCTIONAL',
          claimState: 'VALID_CURRENT',
          createdAt: PIN.generatedAt,
          id: 'T-ON',
        },
        {
          taskId: 'T-NEXT',
          title: 'Next up',
          projectId: 'p1',
          featureId: null,
          bucket: 'NEXT',
          overlays: [],
          blockReason: null,
          outsideTracked: false,
          lifecycleStage: 'MAPPED',
          targetGate: 'BUILT',
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T-NEXT',
        },
      ],
      pageSize: 50,
      dispatchNext: {
        selectedForNextDispatch: [
          {
            taskId: 'T-NEXT',
            rank: 1,
            selectionReason: 'sole dispatch plan head',
            targetGate: 'BUILT',
            role: 'implementer',
            priorityPortfolioId: null,
          },
        ],
        planId: 'plan-1',
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
    }
    const env = createPinnedEnvelope(PIN, data, { surface: 'work' })
    const props = workEnvelopeToProps(env, {
      boardId: 'mfs-rebuild',
      activeBucket: 'ONGOING',
      staleOverlayActive: false,
      routePinned: { taskHash: PIN.taskHash },
      ongoingJoin: [
        {
          taskId: 'T-ON',
          targetGate: 'FUNCTIONAL',
          agentId: 'agent-a',
          role: 'implementer',
          model: 'grok',
          effort: 'high',
          maskedAccount: 'a***@x.ai',
          startedAgeSeconds: 120,
          heartbeatAgeSeconds: 5,
          materialProgressAgeSeconds: 30,
          productiveSubstate: 'PRODUCTIVE',
          evidenceLink: '/evidence/e1',
        },
      ],
    })
    const ongoing = props.items.find((i) => i.taskId === 'T-ON')
    expect(ongoing?.ongoing?.agentId).toBe('agent-a')
    expect(ongoing?.ongoing?.model).toBe('grok')
    expect(ongoing?.ongoing?.liveness).toBe('PRODUCTIVE')
    expect(ongoing?.ongoing?.targetGate).toBe('FUNCTIONAL')
    expect(ongoing?.reconciliation?.claimState).toBe('VALID_CURRENT')
    expect(ongoing?.detailHref).toBe('/b/mfs-rebuild/work/T-ON')
    const next = props.items.find((i) => i.taskId === 'T-NEXT')
    expect(next?.reason).toBe('sole dispatch plan head')
    expect(props.pinned?.taskHash).toBe(PIN.taskHash)
    expect(props.pinned?.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(props.pinned?.boardRev).toBe(PIN.boardRev)
    expect(props.pinned?.lifecycleRev).toBe(PIN.lifecycleRev)
  })

  it('priority mapping: N-A majority + portfolio membership fields', () => {
    const data: PriorityData = {
      surfaceVersion: 'CC_UI_V1',
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipTaskIds: [],
        membershipDenominator: 0,
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY',
        reason: null,
      },
      majorityAllocationDisplay: 'N-A',
      priorityCapacityShareDisplay: 'N-A',
      g5Pass: false,
      productDenominator: 0,
      membershipDenominator: 0,
      nonPriorityAllowedReasons: [
        'STRICT_DIRECT_DEPENDENCY',
        'NON_DELAYING_SPARE_CAPACITY',
        'PRIORITY_FRONTIER_BLOCKED',
        'PRIORITY_FRONTIER_EXHAUSTED',
      ],
    }
    const env = createPinnedEnvelope(PIN, data, { surface: 'priority' })
    const props = priorityEnvelopeToProps(env)
    expect(props.capacity?.majorityAllocationPass).toBeNull()
    expect(props.capacity?.priorityCapacityShare).toBeNull()
    expect(props.membership?.portfolioId).toBe('SALES_WEB_RELATED_BACKEND')
    expect(props.g5?.domains).toHaveLength(9)
  })

  it('decisions mapping: preserves order, maps rich fields, partial only when absent', () => {
    const rich = {
      decisionId: 'dec-b',
      severity: 'HIGH',
      blocking: true,
      title: 'Blocking first',
      status: 'OPEN',
      dueAt: null,
      createdAt: '2026-07-13T09:00:00.000Z',
      snoozedUntil: null,
      type: 'owner',
      question: 'Approve raise?',
      evidence: ['ev-1'],
      options: [
        { optionId: 'yes', label: 'Yes', tradeoffs: 'cost', declining: false },
        { optionId: 'no', label: 'No', tradeoffs: null, declining: true },
      ],
      agentRecommendation: 'Yes with gate',
      ownerId: 'own-1',
      resolverId: null,
      selectedOptionId: null,
      expectedRev: 3,
      boardRev: 3,
      entityRev: 1,
      scopedApprovalId: null,
      auditIds: ['a1'],
      projectId: null,
      featureId: null,
      taskId: null,
      runId: null,
    }
    const partial = {
      decisionId: 'dec-a',
      severity: 'MEDIUM',
      blocking: false,
      title: 'Second',
      status: 'ACKNOWLEDGED',
      dueAt: '2026-07-20T00:00:00.000Z',
      createdAt: '2026-07-13T08:00:00.000Z',
      snoozedUntil: null,
      type: 'owner',
      question: null,
      evidence: [] as string[],
      options: [] as Array<{
        optionId: string
        label: string
        tradeoffs: string | null
        declining: boolean
      }>,
      agentRecommendation: null,
      ownerId: null,
      resolverId: null,
      selectedOptionId: null,
      expectedRev: null,
      boardRev: null,
      entityRev: null,
      scopedApprovalId: null,
      auditIds: [] as string[],
      projectId: null,
      featureId: null,
      taskId: null,
      runId: null,
    }
    const data: DecisionsData = {
      surfaceVersion: 'CC_UI_V1',
      decisions: [rich, partial],
      items: [
        { ...rich, id: 'dec-b' },
        { ...partial, id: 'dec-a' },
      ],
      pageSize: 50,
      openCount: 2,
      blockingCount: 1,
    }
    const env = createPinnedEnvelope(PIN, data, { surface: 'decisions' })
    const props = decisionsEnvelopeToProps(env)
    expect(props.items.map((i) => i.decisionId)).toEqual(['dec-b', 'dec-a'])
    expect(props.blockingCount).toBe(1)
    expect(props.surfaceState).toBe('needs-human')
    expect(props.items[0].question).toBe('Approve raise?')
    expect(props.items[0].options).toHaveLength(2)
    expect(props.items[0].evidence).toEqual(['ev-1'])
    expect(props.items[0].recommendation).toBe('Yes with gate')
    expect(props.items[0].ownerId).toBe('own-1')
    expect(props.items[0].partialFields).toBe(false)
    expect(props.items[1].question).toBeNull()
    // Empty options/evidence arrays are honest empties — still partial from null question/recommendation
    expect(props.items[1].partialFields).toBe(true)
    expect(props.items[1].absentFields).toEqual(
      expect.arrayContaining(['question', 'agentRecommendation']),
    )
    expect(props.items[1].absentFields).not.toContain('options')
    expect(props.items[1].absentFields).not.toContain('evidence')
    expect(props.pin?.canonicalHash).toBe(PIN.canonicalHash)
    expect(JSON.stringify(props)).not.toMatch(/password|token|secret|sk-|privateComment|ownerComment/i)
  })

  it('honest empty options/evidence do not alone mark partialFields', () => {
    const completeEmpty = {
      decisionId: 'dec-empty',
      severity: 'LOW',
      blocking: false,
      title: 'Empty arrays complete',
      status: 'OPEN',
      dueAt: null,
      createdAt: '2026-07-13T09:00:00.000Z',
      snoozedUntil: null,
      type: 'owner',
      question: 'Anything?',
      evidence: [] as string[],
      options: [] as Array<{
        optionId: string
        label: string
        tradeoffs: string | null
        declining: boolean
      }>,
      agentRecommendation: 'None',
      ownerId: 'o1',
      resolverId: null,
      selectedOptionId: null,
      expectedRev: 1,
      boardRev: 1,
      entityRev: 1,
      scopedApprovalId: null,
      auditIds: [] as string[],
      projectId: null,
      featureId: null,
      taskId: null,
      runId: null,
    }
    const data: DecisionsData = {
      surfaceVersion: 'CC_UI_V1',
      decisions: [completeEmpty],
      items: [{ ...completeEmpty, id: 'dec-empty' }],
      pageSize: 50,
      openCount: 1,
      blockingCount: 0,
    }
    const props = decisionsEnvelopeToProps(createPinnedEnvelope(PIN, data, { surface: 'decisions' }))
    expect(props.items[0].options).toEqual([])
    expect(props.items[0].evidence).toEqual([])
    expect(props.items[0].partialFields).toBe(false)
    expect(props.items[0].absentFields ?? []).toEqual([])
  })

  it('evidence mapping + pin identity', () => {
    const data: EvidenceData = {
      surfaceVersion: 'CC_UI_V1',
      events: [
        {
          id: 'e1',
          createdAt: PIN.generatedAt,
          kind: 'log',
          actorId: 'system',
          subjectId: null,
          summary: 'audit line',
          materialHash: null,
          boardRev: 3,
        },
      ],
      items: [],
      pageSize: 50,
    }
    data.items = data.events
    const env = createPinnedEnvelope(PIN, data, { surface: 'evidence' })
    const vm = evidenceEnvelopeToViewModel(env)
    expect(vm.events[0].summary).toBe('audit line')
    expect(pinIdentityFromEnvelope(env).canonicalSnapshotId).toBe('snap-route-1')
  })

  it('empty paginated items must NOT fall back to full decisions collection', () => {
    const fullRow = {
      decisionId: 'dec-full',
      severity: 'HIGH' as const,
      blocking: true,
      title: 'Full list only',
      status: 'OPEN' as const,
      dueAt: null,
      createdAt: '2026-07-13T09:00:00.000Z',
      snoozedUntil: null,
      type: 'owner',
      question: 'Q?',
      evidence: [] as string[],
      options: [{ optionId: 'a', label: 'A', tradeoffs: null, declining: false }],
      agentRecommendation: null,
      ownerId: null,
      resolverId: null,
      selectedOptionId: null,
      expectedRev: 1,
      boardRev: 1,
      entityRev: 1,
      scopedApprovalId: null,
      auditIds: [] as string[],
      projectId: null,
      featureId: null,
      taskId: null,
      runId: null,
    }
    const data: DecisionsData = {
      surfaceVersion: 'CC_UI_V1',
      decisions: [fullRow],
      items: [], // honest empty page
      pageSize: 50,
      openCount: 1,
      blockingCount: 1,
    }
    const props = decisionsEnvelopeToProps(
      createPinnedEnvelope(PIN, data, { surface: 'decisions' }),
    )
    expect(props.items).toEqual([])
    expect(props.openCount).toBe(1)
  })

  it('existing-board compatibility: non mfs boards are not control-center', () => {
    expect(isControlCenterBoard('ibils')).toBe(false)
    expect(isControlCenterBoard('demo')).toBe(false)
  })

  it('overview topDecision projects humanDisplay fail-closed; never invents ownerAction', () => {
    const reviewedHd = {
      contentReviewRequired: false,
      effectiveReviewStatus: 'REVIEWED',
      ownerPrimaryTitle: 'Setujui kenaikan kapasitas',
      statusSentence: 'Keputusan blocking menunggu owner.',
      ownerAction: 'Pilih opsi A atau B.',
      whyItMatters: 'Kapasitas membatasi throughput.',
      next: 'Putuskan sekarang.',
      blocker: 'Menunggu owner.',
      citations: [{ field: 'title', path: 'humanDisplay.title' }],
      acceptanceLinks: [],
      missionQuestionLinks: [],
      pin: {
        snapshotId: PIN.canonicalSnapshotId,
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
        canonicalHash: PIN.canonicalHash,
        sourceHash: PIN.canonicalHash,
      },
      primary: { title: 'Setujui kenaikan kapasitas' },
      blockedShell: { title: 'shell' },
    }

    const baseOverview = (): OverviewData => ({
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets as OverviewData['buckets'],
      overlays: emptyOverlays as OverviewData['overlays'],
      trackedWorkDenominator: 0,
      productDenominator: 0,
      stageProdReady: 0,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 0,
      g5Pass: false,
      complete: false,
      rawTaskReadinessPercent: null,
      boardReadinessPercent: null,
      cappedBy: 'DATA_INTEGRITY_OR_P0',
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipDenominator: 0,
        membershipTaskIds: [],
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY',
        reason: 'no membership',
      },
      g5: { g5Pass: false, domainResults: [], missingDomains: [] },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      ongoing: [],
      decisionCount: 1,
      topDecision: {
        decisionId: 'd-hd-1',
        severity: 'HIGH',
        blocking: true,
        title: '[DEC-TECH] technical title',
        status: 'OPEN',
        question: 'Naikkan floor?',
        ownerHumanDisplay: reviewedHd as never,
      } as OverviewData['topDecision'],
      needsHuman: true,
      projects: [],
      sectionErrors: [],
    })

    const reviewedProps = overviewEnvelopeToProps(
      createPinnedEnvelope(PIN, baseOverview(), { surface: 'overview' }),
    )
    const top = reviewedProps.decision?.topItem as {
      title: string
      ownerPrimaryTitle?: string | null
      ownerAction?: string
      contentReviewRequired?: boolean
      effectiveReviewStatus?: string | null
      whyItMatters?: string | null
      next?: string | null
      blocker?: string | null
      statusSentence?: string | null
    }
    expect(top.title).toBe('[DEC-TECH] technical title')
    expect(top.ownerPrimaryTitle).toBe('Setujui kenaikan kapasitas')
    expect(top.ownerAction).toBe('Pilih opsi A atau B.')
    expect(top.contentReviewRequired).toBe(false)
    expect(top.effectiveReviewStatus).toBe('REVIEWED')
    expect(top.whyItMatters).toMatch(/Kapasitas/)
    expect(top.next).toMatch(/Putuskan/)
    expect(top.blocker).toMatch(/Menunggu/)
    expect(top.statusSentence).toMatch(/blocking/)
    // Must never invent English technical actions from blocking flag.
    expect(top.ownerAction).not.toBe('Resolve blocking decision')
    expect(top.ownerAction).not.toBe('Review decision')

    // Missing HD → fail-closed fields; empty ownerAction (not invented).
    const missingData = baseOverview()
    missingData.topDecision = {
      decisionId: 'd-hd-missing',
      severity: 'CRITICAL',
      blocking: true,
      title: '[DEC-99] technical only',
      status: 'OPEN',
      question: 'Ship?',
    }
    const missingProps = overviewEnvelopeToProps(
      createPinnedEnvelope(PIN, missingData, { surface: 'overview' }),
    )
    const missingTop = missingProps.decision?.topItem as {
      title: string
      ownerPrimaryTitle?: string | null
      ownerAction?: string
      contentReviewRequired?: boolean
      effectiveReviewStatus?: string | null
    }
    expect(missingTop.title).toBe('[DEC-99] technical only')
    expect(missingTop.ownerPrimaryTitle).toBeNull()
    expect(missingTop.ownerAction).toBe('')
    expect(missingTop.contentReviewRequired).toBe(true)
    expect(missingTop.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(missingTop.ownerAction).not.toMatch(/Resolve blocking/)
    expect(missingTop.ownerAction).not.toMatch(/Review decision/)
  })

  it('work + overview project ownerHumanDisplay fail-closed wire (never technical title primary)', () => {
    const blockedShell = {
      contentReviewRequired: true,
      effectiveReviewStatus: 'CONTENT_REVIEW_REQUIRED',
      ownerPrimaryTitle: 'Konten pemilik memerlukan peninjauan',
      statusSentence: 'Status peninjauan: CONTENT_REVIEW_REQUIRED.',
      ownerAction: 'Tinjau atau tugaskan peninjauan salinan manusia untuk item ini.',
      whyItMatters: 'Salinan teknis mentah tidak boleh menjadi teks utama bagi pemilik.',
      next: 'Lengkapi humanDisplay dan minta peninjauan independen.',
      blocker: 'CONTENT_REVIEW_REQUIRED — salinan hilang, basi, konflik, atau belum ditinjau.',
      citations: [{ field: 'reviewStatus', path: 'humanDisplay.evaluateHumanDisplay' }],
      acceptanceLinks: [{ path: 'humanDisplay.evaluateHumanDisplay', summary: 'shell' }],
      missionQuestionLinks: [{ questionId: 'Q-CONTENT-REVIEW', field: 'reviewStatus' }],
      pin: {
        snapshotId: PIN.canonicalSnapshotId,
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
        canonicalHash: PIN.canonicalHash,
        sourceHash: PIN.canonicalHash,
      },
      primary: null,
      blockedShell: {
        title: 'Konten pemilik memerlukan peninjauan',
        reviewStatus: 'CONTENT_REVIEW_REQUIRED',
      },
    }

    const workData: WorkData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets as WorkData['buckets'],
      overlays: emptyOverlays as WorkData['overlays'],
      trackedWorkDenominator: 1,
      filter: { bucket: null, overlay: null, staleFamily: null },
      items: [
        {
          taskId: 'T-HD-W',
          title: '[FC-77] technical only',
          projectId: null,
          featureId: null,
          bucket: 'BLOCKED',
          overlays: [],
          blockReason: 'DATA_INTEGRITY',
          outsideTracked: false,
          lifecycleStage: 'MAPPED',
          targetGate: null,
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T-HD-W',
          ownerHumanDisplay: blockedShell as never,
        },
      ],
      pageSize: 50,
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
    }
    const workProps = workEnvelopeToProps(createPinnedEnvelope(PIN, workData, { surface: 'work' }), {
      boardId: 'mfs-rebuild',
      activeBucket: 'BLOCKED',
      staleOverlayActive: false,
    })
    const item = workProps.items[0] as WorkItemRow & {
      ownerPrimaryTitle?: string | null
      contentReviewRequired?: boolean
      statusSentence?: string | null
      whyItMatters?: string | null
    }
    expect(item.title).toBe('[FC-77] technical only')
    expect(item.ownerPrimaryTitle).toBe('Konten pemilik memerlukan peninjauan')
    expect(item.ownerPrimaryTitle).not.toContain('[FC-77]')
    expect(item.contentReviewRequired).toBe(true)
    expect(item.statusSentence).toMatch(/CONTENT_REVIEW_REQUIRED/)
    expect(item.whyItMatters).toMatch(/teknis/)

    const overviewData: OverviewData = {
      surfaceVersion: 'CC_UI_V1',
      buckets: emptyBuckets as OverviewData['buckets'],
      overlays: emptyOverlays as OverviewData['overlays'],
      trackedWorkDenominator: 0,
      productDenominator: 0,
      stageProdReady: 0,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 0,
      g5Pass: false,
      complete: false,
      rawTaskReadinessPercent: null,
      boardReadinessPercent: null,
      cappedBy: 'DATA_INTEGRITY_OR_P0',
      priority: {
        portfolioId: 'SALES_WEB_RELATED_BACKEND',
        membershipDenominator: 0,
        membershipTaskIds: [],
        priorityClosureCapacity: 0,
        allClosureCapacity: 0,
        priorityCapacityShare: null,
        majorityAllocationPass: null,
        frontierState: 'PRIORITY_FRONTIER_EMPTY',
        reason: 'no membership',
      },
      g5: { g5Pass: false, domainResults: [], missingDomains: [] },
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      ongoing: [
        {
          taskId: 'T-ON-1',
          title: 'tech-run-title',
          targetGate: 'GATE',
          agentId: 'a1',
          role: 'implementer',
          model: null,
          effort: null,
          maskedAccount: null,
          startedAt: null,
          startedAgeSeconds: 10,
          heartbeatAt: null,
          heartbeatAgeSeconds: 5,
          materialProgressAt: null,
          materialProgressAgeSeconds: null,
          productiveSubstate: 'PRODUCTIVE',
          evidenceLink: null,
          bucket: 'ONGOING',
          overlays: [],
          ownerHumanDisplay: blockedShell as never,
        },
      ],
      decisionCount: 0,
      topDecision: null,
      needsHuman: false,
      projects: [],
      sectionErrors: [],
    }
    const ovProps = overviewEnvelopeToProps(
      createPinnedEnvelope(PIN, overviewData, { surface: 'overview' }),
    )
    const ongoing = ovProps.ongoing[0] as {
      title: string
      ownerPrimaryTitle?: string | null
      contentReviewRequired?: boolean
    }
    expect(ongoing.title).toBe('tech-run-title')
    expect(ongoing.ownerPrimaryTitle).toBe('Konten pemilik memerlukan peninjauan')
    expect(ongoing.contentReviewRequired).toBe(true)
  })
})
