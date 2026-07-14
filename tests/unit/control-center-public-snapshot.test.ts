import { describe, expect, it } from 'vitest'

import type {
  ClassificationReceipt,
  G5DomainRecord,
  PinnedRevisionTuple,
  TaskClassificationRecord,
} from '#/lib/control-plane-types'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'
import { makePassingDomain } from '#/server/g5'
import type { DecisionV3Record } from '#/server/decisions-v3'
import {
  aggregateControlCenter,
  type ControlCenterPin,
  type ControlCenterTaskInput,
} from '#/server/control-center-ui'
import {
  ControlCenterPublicSnapshotError,
  buildPublicSnapshotEtagPayloadInput,
  mapControlCenterAggregationToPublicInput,
  materializePublicSnapshotFromControlCenter,
} from '#/server/control-center-public-snapshot'
import {
  PUBLIC_SERIALIZER_VERSION,
  PUBLIC_SNAPSHOT_SCHEMA,
  materializePublicSnapshot,
  stableStringify,
} from '#/server/public-snapshot'

const PIN_TUPLE: PinnedRevisionTuple = {
  canonicalSnapshotId: 'snap-cc-pub-1',
  canonicalHash: 'canonhash_cc_pub_aaaaaaaa',
  taskHash: 'taskhash_cc_pub_bbbbbbbb',
  boardRev: 11,
  lifecycleRev: 3,
}

const PIN: ControlCenterPin = {
  boardId: 'board-public-map',
  ...PIN_TUPLE,
  generatedAt: '2026-07-13T12:00:00.000Z',
  freshnessAgeSeconds: 12,
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
    projectId: 'proj-1',
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
  partial: Partial<DecisionV3Record> &
    Pick<DecisionV3Record, 'decisionId' | 'severity' | 'blocking'>,
): DecisionV3Record {
  return {
    boardId: PIN.boardId,
    projectId: null,
    featureId: null,
    taskId: null,
    runId: null,
    type: 'owner',
    title: partial.title ?? partial.decisionId,
    question: 'private question text must not leak',
    evidence: ['private-evidence-body'],
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
    comment: 'SECRET_OWNER_COMMENT_DO_NOT_LEAK',
    expectedRev: PIN.boardRev,
    boardRev: PIN.boardRev,
    entityRev: 1,
    scopedApprovalId: null,
    auditIds: [],
    expiresAt: null,
    expiresAtMs: null,
    ...partial,
  }
}

function buildAgg(over: {
  tasks?: ControlCenterTaskInput[]
  g5Domains?: G5DomainRecord[]
  decisions?: DecisionV3Record[]
  pin?: ControlCenterPin
} = {}) {
  return aggregateControlCenter({
    pin: over.pin ?? PIN,
    now: NOW,
    tasks: over.tasks ?? [
      productTask('t-done', 'PROD_READY', {
        claimState: 'NONE',
        evidence: {
          stage: 'PROD_READY',
          receiptId: 'ev-done',
          receiptHash: 'hash-done-aaaaaaaa',
          independentVerifier: true,
          boardRev: PIN.boardRev,
          lifecycleRev: PIN.lifecycleRev,
          taskHash: PIN.taskHash,
          canonicalHash: PIN.canonicalHash,
        },
      }),
      productTask('t-ongoing', 'IN_PROGRESS', {
        claimState: 'VALID_CURRENT',
        runLiveness: 'RUNNING',
        accountRef: 'raw-account-id-xyz7890',
        heartbeatAt: '2026-07-13T11:55:00.000Z',
        materialProgressAt: '2026-07-13T11:50:00.000Z',
        startedAt: '2026-07-13T11:00:00.000Z',
        agentId: 'agent-1',
        role: 'implementer',
      }),
      productTask('t-queued', 'READY', {
        eligible: true,
        selectedForNextDispatch: false,
      }),
      productTask('t-blocked', 'READY', {
        hardBlocker: true,
      }),
    ],
    g5Domains: over.g5Domains ?? allG5Pass(),
    decisions: over.decisions ?? [
      decision({
        decisionId: 'dec-1',
        severity: 'HIGH',
        blocking: true,
        title: 'PRIVATE_DECISION_TITLE',
      }),
      decision({
        decisionId: 'dec-2',
        severity: 'MEDIUM',
        blocking: false,
        title: 'ANOTHER_PRIVATE_TITLE',
      }),
    ],
    projects: [
      {
        id: 'proj-1',
        name: 'Project One',
        status: 'ACTIVE',
        taskCount: 4,
        doneCount: 0,
        blockedCount: 0,
      },
    ],
    features: [
      {
        id: 'feat-1',
        projectId: 'proj-1',
        name: 'Feature One',
        phase: 'build',
        flowBranch: 'open',
        taskCount: 4,
      },
    ],
    runs: [
      {
        runId: 'run-1',
        taskId: 't-ongoing',
        agentId: 'agent-1',
        role: 'implementer',
        model: 'grok',
        effort: null,
        maskedAccount: 'acc_***7890',
        status: 'RUNNING',
        startedAt: '2026-07-13T11:00:00.000Z',
        heartbeatAt: '2026-07-13T11:55:00.000Z',
        materialProgressAt: '2026-07-13T11:50:00.000Z',
        productiveSubstate: 'PRODUCTIVE',
        createdAt: '2026-07-13T11:00:00.000Z',
        id: 'run-1',
      },
    ],
    accounts: [
      {
        maskedAccountId: 'acc_***7890',
        status: 'ACTIVE',
        providerKind: 'grok',
        effectiveInUse: 1,
        effectiveCap: 5,
        physicalSlotsDisplay: '1/5',
        quarantine: false,
        reason: null,
      },
    ],
    // Authoritative account-sync required for usable=true (absent parity → usable=false).
    accountSyncMeta: {
      authoritative: true,
      sourceRevision: 1,
      generatedAt: NOW,
      stale: false,
      staleReason: null,
      usableCapacity: 4,
      readbackParityOk: true,
    },
    priorityPackets: [],
  })
}

describe('control-center-public-snapshot mapper', () => {
  it('maps pin identity + freshness without recomputation', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    expect(input.boardId).toBe(PIN.boardId)
    expect(input.pin).toEqual({
      canonicalSnapshotId: PIN.canonicalSnapshotId,
      canonicalHash: PIN.canonicalHash,
      boardRev: PIN.boardRev,
      lifecycleRev: PIN.lifecycleRev,
      serializerVersion: PUBLIC_SERIALIZER_VERSION,
    })
    expect(input.generatedAt).toBe(PIN.generatedAt)
    expect(input.publishedAt).toBe(PIN.generatedAt)
    expect(input.nowMs).toBe(agg.nowMs)
  })

  it('preserves DISTINCT global rollup numbers from aggregation (no recompute)', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    expect(input.boardRollup).toEqual({
      trackedWorkDenominator: agg.rollup.trackedWorkDenominator,
      productDenominator: agg.rollup.productDenominator,
      stageProdReady: agg.rollup.stageProdReady,
      prodReadyWithEvidence: agg.rollup.prodReadyWithEvidence,
      unclassifiedCount: agg.rollup.unclassifiedCount,
      rawTaskReadinessPercent: agg.rollup.rawTaskReadinessPercent,
      boardReadinessPercent: agg.rollup.boardReadinessPercent,
      cappedBy: agg.rollup.cappedBy,
      lifecycleStageCounts: expect.any(Object),
    })
    // Stage histogram derived from workRows (owner progress), not PRODUCT-only readiness.
    expect(input.boardRollup.lifecycleStageCounts).toEqual(
      expect.objectContaining({
        READY: expect.any(Number),
      }),
    )
    expect(input.completion.complete).toBe(agg.rollup.complete)
    expect(input.completion.g5Pass).toBe(agg.g5.g5Pass)
  })

  it('preserves six primary bucket counts + STALE overlay counts', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    expect(input.buckets).toEqual({
      DONE: agg.rollup.buckets.DONE,
      RECONCILIATION_PENDING: agg.rollup.buckets.RECONCILIATION_PENDING,
      ONGOING: agg.rollup.buckets.ONGOING,
      NEXT: agg.rollup.buckets.NEXT,
      QUEUED: agg.rollup.buckets.QUEUED,
      BLOCKED: agg.rollup.buckets.BLOCKED,
    })
    // Sum of primary buckets equals DISTINCT tracked assignments with a primary.
    const bucketSum = Object.values(input.buckets).reduce((a, b) => a + b, 0)
    expect(bucketSum).toBeGreaterThan(0)
    expect(bucketSum).toBe(
      agg.rollup.assignments.filter((a) => a.primary != null && !a.outsideTracked).length,
    )

    for (const [k, v] of Object.entries(agg.rollup.overlays)) {
      expect(input.staleOverlays?.[k]).toBe(v)
    }
  })

  it('preserves priority rollup from aggregation (DISTINCT membership)', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    expect(input.priorityRollup).toEqual({
      portfolioId: agg.priority.portfolioId,
      membershipDenominator: agg.priority.membershipDenominator,
      priorityClosureCapacity: agg.priority.priorityClosureCapacity,
      allClosureCapacity: agg.priority.allClosureCapacity,
      priorityCapacityShare: agg.priority.priorityCapacityShare,
      majorityAllocationPass: agg.priority.majorityAllocationPass,
      frontierState: agg.priority.frontierState,
      reason: agg.priority.reason,
    })
    // Private membership task id list must not appear on public DTO.
    expect(JSON.stringify(input)).not.toContain('membershipTaskIds')
  })

  it('maps derived G5 summary only (pass counts, no domain private evidence)', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    const passCount = agg.g5.domainResults.filter((r) => r.pass).length
    expect(input.g5).toEqual({
      g5Pass: agg.g5.g5Pass,
      domainPassCount: passCount,
      domainRequiredCount: G5_REQUIRED_DOMAINS.length,
    })
    expect(input.g5.g5Pass).toBe(true)
    expect(input.g5.domainPassCount).toBe(G5_REQUIRED_DOMAINS.length)

    const blob = stableStringify(input)
    expect(blob).not.toMatch(/evidenceReceipt/)
    expect(blob).not.toMatch(/verifierRunId/)
    expect(blob).not.toMatch(/authorRunId/)
  })

  it('exports decision COUNT only — redacts titles/comments/evidence bodies', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)

    expect(input.decisionCount).toBe(2)
    expect(input.decisionCount).toBe(agg.decisions.length)

    const blob = stableStringify(input)
    expect(blob).not.toContain('PRIVATE_DECISION_TITLE')
    expect(blob).not.toContain('ANOTHER_PRIVATE_TITLE')
    expect(blob).not.toContain('SECRET_OWNER_COMMENT_DO_NOT_LEAK')
    expect(blob).not.toContain('private question text')
    expect(blob).not.toContain('private-evidence-body')
    expect(blob).not.toMatch(/"comment"/)
    expect(blob).not.toMatch(/"question"/)
    expect(blob).not.toMatch(/"title":"PRIVATE/)
  })

  it('sanitizes run + account summaries (masked only, no raw identity)', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg)
    const runs = input.runs ?? []
    const accounts = input.accounts ?? []

    expect(runs).toHaveLength(1)
    expect(runs[0]).toMatchObject({
      runId: 'run-1',
      status: 'RUNNING',
      taskId: 't-ongoing',
      agentRole: 'implementer',
    })
    expect(runs[0]?.accountRefMasked).toMatch(/^acc_/)
    expect(runs[0]?.accountRefMasked).not.toContain('raw-account')

    expect(accounts).toHaveLength(1)
    expect(accounts[0]?.accountIdMasked).toMatch(/^acc_/)
    expect(accounts[0]?.status).toBe('ACTIVE')
    expect(accounts[0]?.provider).toBe('grok')
    expect(accounts[0]?.usable).toBe(true)

    const blob = stableStringify(input)
    expect(blob).not.toContain('raw-account-id-xyz7890')
    expect(blob).not.toMatch(/password|token|secret|authorization/i)
  })

  it('parity: materializePublicSnapshot From mapper matches direct materialize path', () => {
    const agg = buildAgg()
    const input = buildPublicSnapshotEtagPayloadInput(agg, {
      nowMs: Date.parse('2026-07-13T12:00:12.000Z'),
      publicationIntervalMs: 60_000,
    })
    const fromMapper = materializePublicSnapshotFromControlCenter(agg, {
      nowMs: Date.parse('2026-07-13T12:00:12.000Z'),
      publicationIntervalMs: 60_000,
    })
    const direct = materializePublicSnapshot(input)

    expect(fromMapper.etag).toBe(direct.etag)
    expect(fromMapper.payload.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
    expect(fromMapper.payload.pin.canonicalSnapshotId).toBe(PIN.canonicalSnapshotId)
    expect(fromMapper.payload.pin.canonicalHash).toBe(PIN.canonicalHash)
    expect(fromMapper.payload.pin.boardRev).toBe(PIN.boardRev)
    expect(fromMapper.payload.pin.lifecycleRev).toBe(PIN.lifecycleRev)
    expect(fromMapper.payload.buckets).toEqual(input.buckets)
    expect(fromMapper.payload.decisionCount).toBe(2)
    expect(fromMapper.payload.g5.g5Pass).toBe(true)
    expect(fromMapper.bodyJson).toBe(direct.bodyJson)
  })

  it('deterministic ETag payload: same aggregation → identical etag twice', () => {
    const agg = buildAgg()
    const opts = {
      nowMs: Date.parse('2026-07-13T12:00:12.000Z'),
      publicationIntervalMs: 60_000 as const,
    }
    const a = materializePublicSnapshotFromControlCenter(agg, opts)
    const b = materializePublicSnapshotFromControlCenter(agg, opts)
    expect(a.etag).toBe(b.etag)
    expect(a.payload.payloadSha256).toBe(b.payload.payloadSha256)
    expect(a.bodyJson).toBe(b.bodyJson)
  })

  it('fail-closed: missing aggregation', () => {
    expect(() => mapControlCenterAggregationToPublicInput(null)).toThrow(
      ControlCenterPublicSnapshotError,
    )
    try {
      mapControlCenterAggregationToPublicInput(undefined)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('MISSING_AGGREGATION')
    }
  })

  it('fail-closed: pin mismatch vs expectedPin', () => {
    const agg = buildAgg()
    expect(() =>
      mapControlCenterAggregationToPublicInput(agg, {
        expectedPin: { boardRev: PIN.boardRev + 1 },
      }),
    ).toThrow(ControlCenterPublicSnapshotError)

    try {
      mapControlCenterAggregationToPublicInput(agg, {
        expectedPin: { canonicalSnapshotId: 'other-snap' },
      })
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('PIN_MISMATCH')
    }
  })

  it('fail-closed: rollup.pin mismatch with aggregation pin', () => {
    const agg = buildAgg()
    // Mutate rollup pin to simulate drift (should never happen in healthy pipeline).
    const drifted = {
      ...agg,
      rollup: {
        ...agg.rollup,
        pin: {
          ...agg.rollup.pin,
          boardRev: agg.rollup.pin.boardRev + 99,
        },
      },
    }
    try {
      mapControlCenterAggregationToPublicInput(drifted)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('PIN_MISMATCH')
    }
  })

  it('fail-closed: tuple mismatch with pin fields', () => {
    const agg = buildAgg()
    const drifted = {
      ...agg,
      tuple: {
        ...agg.tuple,
        lifecycleRev: agg.tuple.lifecycleRev + 1,
      },
    }
    try {
      mapControlCenterAggregationToPublicInput(drifted)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('PIN_MISMATCH')
    }
  })

  it('expectedPin match succeeds (parity binding)', () => {
    const agg = buildAgg()
    const input = mapControlCenterAggregationToPublicInput(agg, {
      expectedPin: {
        boardId: PIN.boardId,
        canonicalSnapshotId: PIN.canonicalSnapshotId,
        canonicalHash: PIN.canonicalHash,
        taskHash: PIN.taskHash,
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
      },
    })
    expect(input.pin.boardRev).toBe(PIN.boardRev)
  })

  it('redaction: raw unmasked account id on run is re-masked', () => {
    const agg = buildAgg()
    // Force a residual unmasked id through (defense in depth on mapper).
    const withRaw = {
      ...agg,
      runs: [
        {
          ...agg.runs[0]!,
          maskedAccount: 'plaintext-account-SECRET99',
        },
      ],
    }
    const input = mapControlCenterAggregationToPublicInput(withRaw)
    const runs = input.runs ?? []
    expect(runs[0]?.accountRefMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(runs[0]?.accountRefMasked).not.toContain('plaintext')
    expect(runs[0]?.accountRefMasked).not.toContain('SECRET')
  })

  it('redaction: hostile acc_ prefix is NOT treated as already-masked', () => {
    const agg = buildAgg()
    const withHostile = {
      ...agg,
      runs: [
        {
          ...agg.runs[0]!,
          maskedAccount: 'acc_plaintextSECRET99',
        },
      ],
      accounts: [
        {
          ...agg.accounts[0]!,
          maskedAccountId: 'acc_rawIdentityLEAK12',
        },
      ],
    }
    const input = mapControlCenterAggregationToPublicInput(withHostile)
    const runs = input.runs ?? []
    const accounts = input.accounts ?? []
    expect(runs[0]?.accountRefMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(runs[0]?.accountRefMasked).not.toContain('plaintext')
    expect(runs[0]?.accountRefMasked).not.toContain('SECRET')
    expect(accounts[0]?.accountIdMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(accounts[0]?.accountIdMasked).not.toContain('rawIdentity')
    expect(accounts[0]?.accountIdMasked).not.toContain('LEAK')
  })

  it('usable=false for BAN/403/AUTH_EXPIRED/quarantine and absent account-sync parity', () => {
    const base = buildAgg()

    for (const status of ['BAN', '403', 'AUTH_EXPIRED', 'quarantine', 'REMOVED'] as const) {
      const input = mapControlCenterAggregationToPublicInput({
        ...base,
        accounts: [
          {
            ...base.accounts[0]!,
            status,
            quarantine: status === 'quarantine' || status === 'REMOVED',
          },
        ],
      })
      expect(input.accounts?.[0]?.usable).toBe(false)
    }

    // Absent account-sync authority → all usable=false
    const noSync = mapControlCenterAggregationToPublicInput({
      ...base,
      accountSyncMeta: null,
    })
    expect(noSync.accounts?.[0]?.usable).toBe(false)

    // Stale sync → usable=false
    const staleSync = mapControlCenterAggregationToPublicInput({
      ...base,
      accountSyncMeta: {
        authoritative: true,
        sourceRevision: 1,
        generatedAt: NOW,
        stale: true,
        staleReason: 'ACCOUNT_SYNC_STALE',
        usableCapacity: 0,
        readbackParityOk: true,
      },
    })
    expect(staleSync.accounts?.[0]?.usable).toBe(false)

    // Parity invalid → usable=false
    const badParity = mapControlCenterAggregationToPublicInput({
      ...base,
      accountSyncMeta: {
        authoritative: true,
        sourceRevision: 1,
        generatedAt: NOW,
        stale: false,
        staleReason: null,
        usableCapacity: 4,
        readbackParityOk: false,
      },
    })
    expect(badParity.accounts?.[0]?.usable).toBe(false)
  })

  it('fail-closed: pin.stale or structural sectionErrors → STALE_OR_PARTIAL', () => {
    const agg = buildAgg()
    const stalePin = {
      ...agg,
      pin: { ...agg.pin, stale: true, staleReason: 'SOURCE_STALE' },
    }
    try {
      mapControlCenterAggregationToPublicInput(stalePin)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('STALE_OR_PARTIAL')
    }

    const partial = {
      ...agg,
      sectionErrors: [
        { section: 'runtime_context', code: 'PARTIAL_SOURCE', message: 'unavailable' },
      ],
    }
    try {
      mapControlCenterAggregationToPublicInput(partial)
      expect.unreachable('should throw')
    } catch (e) {
      expect(e).toBeInstanceOf(ControlCenterPublicSnapshotError)
      expect((e as ControlCenterPublicSnapshotError).code).toBe('STALE_OR_PARTIAL')
    }

    // Schema/hash structural codes also hard-fail (never soft domain path).
    for (const code of ['SCHEMA_INVALID', 'HASH_MISMATCH', 'PIN_AUTHORITY_INCOMPLETE']) {
      try {
        mapControlCenterAggregationToPublicInput({
          ...agg,
          sectionErrors: [{ section: 'revisions', code, message: 'structural' }],
        })
        expect.unreachable(`should throw for ${code}`)
      } catch (e) {
        expect((e as ControlCenterPublicSnapshotError).code).toBe('STALE_OR_PARTIAL')
      }
    }
  })

  it('domain blockers DATA_INTEGRITY / ACCOUNT_SYNC_MISSING → sanitized soft path (not throw)', () => {
    const base = buildAgg()

    // DATA_INTEGRITY section + valid pin → materialize with forceStale, usableCapacity=0
    const di = mapControlCenterAggregationToPublicInput({
      ...base,
      sectionErrors: [
        {
          section: 'classification',
          code: 'DATA_INTEGRITY',
          message: 'No valid V3 classification receipts — private detail must not leak as reason',
        },
      ],
    })
    expect(di.forceStale).toBe(true)
    expect(di.usableCapacity).toBe(0)
    expect(di.domainBlockers?.some((b) => b.code === 'DATA_INTEGRITY')).toBe(true)
    // Reason is section-scoped only — free-form private message stripped.
    const diBlocker = di.domainBlockers?.find((b) => b.code === 'DATA_INTEGRITY')
    expect(diBlocker?.reason).toBe('section:classification')
    expect(JSON.stringify(di)).not.toContain('private detail')

    // ACCOUNT_SYNC_MISSING via sectionError
    const asm = mapControlCenterAggregationToPublicInput({
      ...base,
      sectionErrors: [
        {
          section: 'accounts',
          code: 'ACCOUNT_SYNC_MISSING',
          message: 'No authoritative C2 AccountSyncSnapshot',
        },
      ],
    })
    expect(asm.forceStale).toBe(true)
    expect(asm.usableCapacity).toBe(0)
    expect(asm.domainBlockers?.some((b) => b.code === 'ACCOUNT_SYNC_MISSING')).toBe(true)

    // Missing account-sync meta alone (no sectionError) still domain-blocks.
    const noMeta = mapControlCenterAggregationToPublicInput({
      ...base,
      accountSyncMeta: null,
    })
    expect(noMeta.forceStale).toBe(true)
    expect(noMeta.usableCapacity).toBe(0)
    expect(noMeta.domainBlockers?.some((b) => b.code === 'ACCOUNT_SYNC_MISSING')).toBe(true)
    expect(noMeta.accounts?.every((a) => a.usable === false)).toBe(true)

    // Materialize succeeds (never 503 path) with stale freshness forced.
    const mat = materializePublicSnapshotFromControlCenter({
      ...base,
      sectionErrors: [
        { section: 'classification', code: 'DATA_INTEGRITY', message: 'unclassified' },
      ],
    })
    expect(mat.payload.freshness.stale).toBe(true)
    expect(mat.payload.usableCapacity).toBe(0)
    expect(mat.payload.domainBlockers.some((b) => b.code === 'DATA_INTEGRITY')).toBe(true)
    expect(mat.payload.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
  })

  it('healthy pin-complete aggregation exposes usableCapacity without forceStale', () => {
    const input = mapControlCenterAggregationToPublicInput(buildAgg())
    expect(input.forceStale).toBe(false)
    expect(input.usableCapacity).toBe(4)
    expect(input.domainBlockers ?? []).toEqual([])
  })
})
