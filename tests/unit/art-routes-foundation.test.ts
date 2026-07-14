/**
 * ART S01–S24 functional route foundation — unit/router support evidence.
 * LOCAL ONLY; no visual claim.
 */
import { describe, expect, it } from 'vitest'

import {
  DEFAULT_CONTROL_CENTER_BOARD_ID,
  normalizeArtWorkSearch,
  resolveDefaultControlCenterBoardId,
} from '#/lib/control-center-default-board'
import {
  matchWorkItemTextQuery,
  taskDetailEnvelopeToViewModel,
  knowledgeDomainEnvelopeToViewModel,
  searchEnvelopeToViewModel,
  documentationDomainEnvelopeToViewModel,
  decisionDetailFromEnvelope,
  workEnvelopeToProps,
} from '#/lib/control-center-route-adapters'
import {
  normalizeWorkBucketToken,
  parseWorkDeepLink,
  isPrimaryBucket,
} from '#/components/control-center/work'
import { parseWorkRouteSearch } from '#/routes/b.$boardId.work.index'
import {
  projectKnowledgeDomainFromAgg,
  projectSearchFromAgg,
  projectDocumentationDomainFromAgg,
} from '#/server/control-center-ui-fns'
import {
  createPinnedEnvelope,
  projectTaskDetail,
  type ControlCenterAggregation,
  type ControlCenterPin,
  type DecisionsData,
  type PinnedEnvelope,
  type WorkData,
} from '#/server/control-center-ui'
import { CONTROL_CENTER_NAV_LABELS, CONTROL_CENTER_NAV_LABELS_ID } from '#/components/AppShell'

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'snap-art-1',
  canonicalHash: 'canon_art_hash_aaaa',
  taskHash: 'task_art_hash_bbbb',
  boardRev: 2,
  lifecycleRev: 1,
  generatedAt: '2026-07-14T00:00:00.000Z',
  freshnessAgeSeconds: 5,
  stale: false,
  staleReason: null,
}

function emptyAgg(overrides: Partial<ControlCenterAggregation> = {}): ControlCenterAggregation {
  return {
    pin: PIN,
    tuple: {
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      taskHash: PIN.taskHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
    },
    workRows: [],
    ongoing: [],
    projects: [],
    features: [],
    runs: [],
    accounts: [],
    decisions: [],
    auditEvents: [],
    assignmentsByTaskId: new Map(),
    rollup: {
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 0,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 0,
      },
      overlays: {
        STALE_DATA_SOURCE: 0,
        EXPIRED_STALLED_RUN: 0,
        STALE_CLAIM: 0,
        STALE_DISPATCH_PLAN: 0,
        STALE_ACCOUNT_SYNC: 0,
      },
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
      assignments: [],
    },
    priority: {
      portfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipDenominator: 0,
      membershipTaskIds: [],
      majorityAllocationPass: null,
      priorityCapacityShare: null,
      dispatchReason: null,
      blockers: [],
    },
    g5: { g5Pass: false, domainResults: [], missingDomains: [] },
    dispatchNext: {
      selectedForNextDispatch: [],
      planId: null,
      blockedReason: null,
      soleSource: 'active_dispatch_plan',
    },
    sectionErrors: [],
    accountSyncMeta: null,
    nowMs: Date.parse(PIN.generatedAt),
    ...overrides,
  } as unknown as ControlCenterAggregation
}

describe('default board + ART search normalize', () => {
  it('pins mfs-rebuild as default control center', () => {
    expect(DEFAULT_CONTROL_CENTER_BOARD_ID).toBe('mfs-rebuild')
    expect(resolveDefaultControlCenterBoardId()).toBe('mfs-rebuild')
  })

  it('S08 maps RECONCILIATION → RECONCILIATION_PENDING', () => {
    expect(normalizeWorkBucketToken('RECONCILIATION')).toBe('RECONCILIATION_PENDING')
    expect(normalizeWorkBucketToken('reconciliation')).toBe('RECONCILIATION_PENDING')
    expect(isPrimaryBucket('RECONCILIATION')).toBe(true)
    const deep = parseWorkDeepLink('mfs-rebuild', { bucket: 'RECONCILIATION' })
    expect(deep.bucket).toBe('RECONCILIATION_PENDING')
    const art = normalizeArtWorkSearch({ bucket: 'RECONCILIATION', query: 'nope' })
    expect(art.bucket).toBe('RECONCILIATION_PENDING')
    expect(art.query).toBe('nope')
  })

  it('S24 accepts query in work search schema + deep link', () => {
    const parsed = parseWorkRouteSearch({ query: 'zero-result-xyz', bucket: 'ONGOING' })
    expect(parsed.query).toBe('zero-result-xyz')
    const deep = parseWorkDeepLink('mfs-rebuild', {
      bucket: parsed.bucket,
      query: parsed.query,
    })
    expect(deep.query).toBe('zero-result-xyz')
  })
})

describe('work text query zero-results', () => {
  it('matchWorkItemTextQuery is case-insensitive over taskId/title', () => {
    expect(
      matchWorkItemTextQuery(
        { taskId: 'T-AFF-N16', title: 'Pembayaran affiliate', ownerPrimaryTitle: null },
        'affiliate',
      ),
    ).toBe(true)
    expect(
      matchWorkItemTextQuery(
        { taskId: 'T-1', title: 'Other', ownerPrimaryTitle: null },
        'zero-result-xyz',
      ),
    ).toBe(false)
  })

  it('workEnvelopeToProps forces zero-results when query matches nothing', () => {
    const data = {
      surfaceVersion: 'CC_UI_V1',
      buckets: {
        DONE: 0,
        RECONCILIATION_PENDING: 0,
        ONGOING: 1,
        NEXT: 0,
        QUEUED: 0,
        BLOCKED: 0,
      },
      overlays: {
        STALE_DATA_SOURCE: 0,
        EXPIRED_STALLED_RUN: 0,
        STALE_CLAIM: 0,
        STALE_DISPATCH_PLAN: 0,
        STALE_ACCOUNT_SYNC: 0,
        BEYOND_STAGE_ONGOING: 0,
        RECONCILIATION_DRILLDOWN: 0,
      },
      trackedWorkDenominator: 1,
      filter: { bucket: 'ONGOING', overlay: null, staleFamily: null },
      items: [
        {
          taskId: 'T-1',
          title: 'Hello',
          projectId: null,
          featureId: null,
          bucket: 'ONGOING',
          overlays: [],
          blockReason: null,
          outsideTracked: false,
          lifecycleStage: null,
          targetGate: null,
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T-1',
        },
      ],
      pageSize: 50,
      dispatchNext: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
    } as WorkData
    const env = createPinnedEnvelope(PIN, data, { surface: 'work', surfaceState: 'populated' })
    const props = workEnvelopeToProps(env, {
      boardId: 'mfs-rebuild',
      activeBucket: 'ONGOING',
      staleOverlayActive: false,
      textQuery: 'zero-result-xyz',
    })
    expect(props.state).toBe('zero-results')
    expect(props.items).toHaveLength(0)
  })
})

describe('task detail adapter + projector', () => {
  it('taskDetailEnvelopeToViewModel demotes technical mode', () => {
    const dto = {
      taskId: 'T-1',
      technicalTitle: 'tech-title',
      projectId: 'p1',
      featureId: null,
      bucket: 'ONGOING',
      overlays: [],
      blockReason: null,
      lifecycleStage: 'BUILT',
      targetGate: 'G5',
      claimState: null,
      ownerHumanDisplay: {
        contentReviewRequired: false,
        effectiveReviewStatus: 'REVIEWED',
        ownerPrimaryTitle: 'Judul pemilik',
        statusSentence: 'Sedang dikerjakan',
        ownerAction: 'Pantau',
        whyItMatters: 'Penting',
        next: 'Lanjut',
        blocker: '',
        primary: null,
        blockedShell: {},
        citations: [],
        acceptanceLinks: [],
        missionQuestionLinks: [],
        pin: {
          snapshotId: PIN.canonicalSnapshotId,
          boardRev: PIN.boardRev,
          lifecycleRev: PIN.lifecycleRev,
          canonicalHash: PIN.canonicalHash,
          sourceHash: 'src',
        },
      },
    }
    const env = createPinnedEnvelope(PIN, dto, { surface: 'work', surfaceState: 'populated' })
    const human = taskDetailEnvelopeToViewModel(env, {
      boardId: 'mfs-rebuild',
      taskId: 'T-1',
      mode: 'human',
    })
    expect(human.mode).toBe('human')
    expect(human.ownerPrimaryTitle).toBe('Judul pemilik')
    expect(human.technicalHref).toContain('mode=technical')
    const tech = taskDetailEnvelopeToViewModel(env, {
      boardId: 'mfs-rebuild',
      taskId: 'T-1',
      mode: 'technical',
    })
    expect(tech.mode).toBe('technical')
    expect(tech.technicalTitle).toBe('tech-title')
  })

  it('projectTaskDetail returns null for unknown task without assignment', () => {
    const agg = emptyAgg()
    expect(projectTaskDetail(agg, 'MISSING')).toBeNull()
  })
})

describe('knowledge / search / documentation honesty', () => {
  it('AFFILIATE unavailable when pin has no matching domain data', () => {
    const env = projectKnowledgeDomainFromAgg(emptyAgg(), 'AFFILIATE')
    expect(env.data).toMatchObject({ availability: 'unavailable', domain: 'AFFILIATE' })
    const vm = knowledgeDomainEnvelopeToViewModel(env as PinnedEnvelope<unknown>, {
      boardId: 'mfs-rebuild',
      domain: 'AFFILIATE',
    })
    expect(vm.availability).toBe('unavailable')
    expect(vm.gaps.length).toBeGreaterThan(0)
  })

  it('search zero-results for unmatched query', () => {
    const env = projectSearchFromAgg(emptyAgg(), 'pembayaran affiliate')
    expect(env.surfaceState).toBe('zero-results')
    const vm = searchEnvelopeToViewModel(env as PinnedEnvelope<unknown>, {
      boardId: 'mfs-rebuild',
      query: 'pembayaran affiliate',
    })
    expect(vm.surfaceState).toBe('zero-results')
    expect(vm.results).toHaveLength(0)
  })

  it('documentation unavailable without domain hits', () => {
    const env = projectDocumentationDomainFromAgg(emptyAgg(), 'AFFILIATE')
    const vm = documentationDomainEnvelopeToViewModel(env as PinnedEnvelope<unknown>, {
      boardId: 'mfs-rebuild',
      domain: 'AFFILIATE',
    })
    expect(vm.availability).toBe('unavailable')
  })

  it('knowledge partial when only task id matches domain token', () => {
    const agg = emptyAgg({
      workRows: [
        {
          taskId: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
          title: 'Expired unpaid',
          projectId: null,
          featureId: null,
          bucket: 'BLOCKED',
          overlays: [],
          blockReason: null,
          outsideTracked: false,
          lifecycleStage: null,
          targetGate: null,
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
        },
      ] as ControlCenterAggregation['workRows'],
    })
    const env = projectKnowledgeDomainFromAgg(agg, 'AFFILIATE')
    expect((env.data as { availability: string }).availability).toBe('partial')
    const search = projectSearchFromAgg(agg, 'T-AFF-N16-MONEY-EXPIRED-UNPAID')
    expect(search.surfaceState).toBe('populated')
    expect((search.data as { results: unknown[] }).results.length).toBe(1)
  })
})

describe('decision detail from envelope', () => {
  it('marks zero-results when decision id absent', () => {
    const data: DecisionsData = {
      surfaceVersion: 'CC_UI_V1',
      decisions: [],
      items: [],
      pageSize: 50,
      openCount: 0,
      blockingCount: 0,
    }
    const env = createPinnedEnvelope(PIN, data, {
      surface: 'decisions',
      surfaceState: 'empty',
    }) as PinnedEnvelope<DecisionsData>
    const vm = decisionDetailFromEnvelope(env, {
      boardId: 'mfs-rebuild',
      decisionId: 'D-missing',
    })
    expect(vm.surfaceState).toBe('zero-results')
    expect(vm.item).toBeNull()
  })
})

describe('id-ID nav aliases preserve nine IA', () => {
  it('nine English labels remain + id-ID map covers all', () => {
    expect(CONTROL_CENTER_NAV_LABELS).toHaveLength(9)
    for (const label of CONTROL_CENTER_NAV_LABELS) {
      expect(CONTROL_CENTER_NAV_LABELS_ID[label].length).toBeGreaterThan(0)
    }
  })
})
