import { describe, expect, it } from 'vitest'

import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  acknowledgeDecisionV3,
  compareDecisionsV3,
  createMemoryDecisionV3Store,
  DecisionV3Error,
  isVisibleInInbox,
  listDecisionsV3,
  openDecisionV3,
  openDecisionV3IdempotencyBody,
  rejectDecisionV3,
  resolveDecisionV3,
  snoozeDecisionV3,
  type DecisionV3Deps,
  type DecisionV3Record,
  type DecisionOptionV3,
  type OpenDecisionV3Request,
} from '#/server/decisions-v3'
import { createMemoryIdempotencyStorage, requestHashOf } from '#/server/idempotency'

const BOARD = 'mfs-rebuild'
const PIN = 'canon-dec-pin-hash-v1'

function deps(clock = createFakeClock()) {
  const d: DecisionV3Deps & { clock: ReturnType<typeof createFakeClock> } = {
    clock,
    decisions: createMemoryDecisionV3Store(),
    idempotency: createMemoryIdempotencyStorage(),
    atomic: createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ]),
  }
  return d
}

function opts(over: Partial<DecisionOptionV3> & Pick<DecisionOptionV3, 'optionId' | 'label'>): DecisionOptionV3 {
  return { declining: false, ...over }
}

let keySeq = 0
function uniqKey(prefix: string): string {
  keySeq += 1
  return `${prefix}-${keySeq}`
}

function ownerEnv(over: {
  expectedRev: number
  expectedBoardRev: number
  selectedOptionId?: string
  snoozedUntil?: string
  comment?: string | null
  scopedApprovalId?: string | null
  canonicalHash?: string
  currentPinHash?: string | null
  idempotencyKey?: string
  actorId?: string
  decisionId?: string
}) {
  return {
    boardId: BOARD,
    decisionId: over.decisionId ?? 'D',
    actorId: over.actorId ?? 'owner',
    expectedRev: over.expectedRev,
    expectedBoardRev: over.expectedBoardRev,
    canonicalHash: over.canonicalHash ?? PIN,
    currentPinHash: over.currentPinHash === undefined ? PIN : over.currentPinHash,
    idempotencyKey: over.idempotencyKey ?? uniqKey('idem-owner'),
    selectedOptionId: over.selectedOptionId as string,
    snoozedUntil: over.snoozedUntil as string,
    comment: over.comment,
    scopedApprovalId: over.scopedApprovalId,
  }
}

describe('Decision V3 ordering / snooze / revision / authority', () => {
  it('deterministic order: blocking desc, severity, dueAt asc null last, createdAt, id', () => {
    const base = {
      boardId: BOARD,
      projectId: null,
      featureId: null,
      taskId: null,
      runId: null,
      type: 't',
      title: 't',
      question: 'q',
      evidence: [],
      options: [],
      agentRecommendation: null,
      snoozedUntil: null,
      snoozedUntilMs: null,
      status: 'OPEN' as const,
      ownerId: null,
      resolverId: null,
      selectedOptionId: null,
      comment: null,
      expectedRev: 0,
      boardRev: 1,
      entityRev: 1,
      scopedApprovalId: null,
      auditIds: [],
      expiresAt: null,
      expiresAtMs: null,
      dueAt: null,
      dueAtMs: null,
      createdAt: '2026-07-13T10:00:00.000Z',
      createdAtMs: 0,
    }
    const rows: Array<DecisionV3Record> = [
      {
        ...base,
        decisionId: 'D-low',
        severity: 'LOW',
        blocking: false,
        createdAtMs: 100,
      },
      {
        ...base,
        decisionId: 'D-block-med',
        severity: 'MEDIUM',
        blocking: true,
        createdAtMs: 50,
      },
      {
        ...base,
        decisionId: 'D-high-due-late',
        severity: 'HIGH',
        blocking: false,
        dueAt: '2026-07-14T00:00:00.000Z',
        dueAtMs: 2000,
        createdAtMs: 10,
      },
      {
        ...base,
        decisionId: 'D-high-due-early',
        severity: 'HIGH',
        blocking: false,
        dueAt: '2026-07-13T12:00:00.000Z',
        dueAtMs: 1000,
        createdAtMs: 10,
      },
      {
        ...base,
        decisionId: 'D-crit',
        severity: 'CRITICAL',
        blocking: false,
        createdAtMs: 1,
      },
      {
        ...base,
        decisionId: 'D-high-null-due',
        severity: 'HIGH',
        blocking: false,
        dueAtMs: null,
        createdAtMs: 5,
      },
    ]
    const sorted = [...rows].sort(compareDecisionsV3).map((d) => d.decisionId)
    expect(sorted[0]).toBe('D-block-med')
    expect(sorted[1]).toBe('D-crit')
    // HIGH: early due before late due before null
    const highIdx = sorted.indexOf('D-high-due-early')
    expect(sorted[highIdx + 1]).toBe('D-high-due-late')
    expect(sorted.indexOf('D-high-null-due')).toBeGreaterThan(sorted.indexOf('D-high-due-late'))
    expect(sorted[sorted.length - 1]).toBe('D-low')
  })

  it('snoozed non-blocking hidden until snoozedUntil; blocking cannot snooze-hide', async () => {
    const d = deps()
    const openNon = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'choice',
      severity: 'LOW',
      title: 'non-block',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'yes' }), opts({ optionId: 'o2', label: 'no' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-nb',
    })
    const openBlock = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'choice',
      severity: 'HIGH',
      title: 'block',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'yes' })],
      blocking: true,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: openNon.boardRev,
      actorId: 'agent',
      decisionId: 'D-b',
    })

    await expect(
      snoozeDecisionV3(
        d,
        ownerEnv({
          decisionId: 'D-b',
          snoozedUntil: '2026-07-13T18:00:00.000Z',
          expectedRev: openBlock.entityRev,
          expectedBoardRev: openBlock.boardRev,
        }),
      ),
    ).rejects.toMatchObject({ code: 'SNOOZE_BLOCKED' })

    const snoozed = await snoozeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-nb',
        snoozedUntil: '2026-07-13T12:00:00.000Z',
        expectedRev: openNon.entityRev,
        expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      }),
    )
    expect(snoozed.snoozedUntilMs).toBeTruthy()

    const now = d.clock.nowMs()
    expect(isVisibleInInbox(snoozed, now)).toBe(false)
    expect(isVisibleInInbox(openBlock, now)).toBe(true)

    const listed = await listDecisionsV3(d, BOARD)
    expect(listed.map((x) => x.decisionId)).toEqual(['D-b'])

    // resurface after snooze
    d.clock.advance(3 * 60 * 60_000)
    const listed2 = await listDecisionsV3(d, BOARD)
    expect(listed2.map((x) => x.decisionId).sort()).toEqual(['D-b', 'D-nb'])
  })

  it('REJECTED vs RESOLVED-with-declining-option semantics', async () => {
    const d = deps()
    const a = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'approval',
      severity: 'MEDIUM',
      title: 'decline-path',
      question: 'approve?',
      options: [
        opts({ optionId: 'yes', label: 'Yes' }),
        opts({ optionId: 'no', label: 'No thanks', declining: true }),
      ],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-dec',
    })
    const resolved = await resolveDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-dec',
        selectedOptionId: 'no',
        comment: 'declining option',
        scopedApprovalId: 'appr-1',
        expectedRev: a.entityRev,
        expectedBoardRev: a.boardRev,
      }),
    )
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.selectedOptionId).toBe('no')
    expect(resolved.scopedApprovalId).toBe('appr-1')

    const b = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'approval',
      severity: 'MEDIUM',
      title: 'reject-path',
      question: 'approve?',
      options: [opts({ optionId: 'yes', label: 'Yes' })],
      blocking: true,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: resolved.boardRev,
      actorId: 'agent',
      decisionId: 'D-rej',
    })
    const rejected = await rejectDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-rej',
        comment: 'request rejected',
        expectedRev: b.entityRev,
        expectedBoardRev: b.boardRev,
      }),
    )
    expect(rejected.status).toBe('REJECTED')
    expect(rejected.selectedOptionId).toBeNull()
  })

  it('expectedRev + boardRev STALE_REVISION; acknowledge path', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'rev',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-rev',
    })
    await expect(
      acknowledgeDecisionV3(
        d,
        ownerEnv({
          decisionId: 'D-rev',
          expectedRev: 999,
          expectedBoardRev: open.boardRev,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(
      acknowledgeDecisionV3(
        d,
        ownerEnv({
          decisionId: 'D-rev',
          expectedRev: open.entityRev,
          expectedBoardRev: 999,
        }),
      ),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const ack = await acknowledgeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-rev',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
      }),
    )
    expect(ack.status).toBe('ACKNOWLEDGED')
    expect(ack.ownerId).toBe('owner')
  })

  it('authority: Decision never broadens production/HOLD/provider', async () => {
    const d = deps()
    await expect(
      openDecisionV3(d, {
        boardId: BOARD,
        type: 'prod',
        severity: 'CRITICAL',
        title: 'broaden',
        question: 'ship prod?',
        options: [
          opts({
            optionId: 'ship',
            label: 'Ship',
            requestsProductionAuthority: true,
          }),
        ],
        blocking: true,
        entityExpectedRev: 0,
        canonicalHash: PIN,
        idempotencyKey: uniqKey('open'),
        expectedBoardRev: 0,
        actorId: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_BROADENING_FORBIDDEN' })

    await expect(
      openDecisionV3(d, {
        boardId: BOARD,
        type: 'hold',
        severity: 'HIGH',
        title: 'hold',
        question: 'hold?',
        options: [opts({ optionId: 'h', label: 'Hold', requestsHoldAuthority: true })],
        blocking: true,
        entityExpectedRev: 0,
        canonicalHash: PIN,
        idempotencyKey: uniqKey('open'),
        expectedBoardRev: 0,
        actorId: 'agent',
      }),
    ).rejects.toBeInstanceOf(DecisionV3Error)

    await expect(
      openDecisionV3(d, {
        boardId: BOARD,
        type: 'prov',
        severity: 'HIGH',
        title: 'prov',
        question: 'provider?',
        options: [opts({ optionId: 'p', label: 'P', requestsProviderAuthority: true })],
        blocking: true,
        entityExpectedRev: 0,
        canonicalHash: PIN,
        idempotencyKey: uniqKey('open'),
        expectedBoardRev: 0,
        actorId: 'agent',
      }),
    ).rejects.toMatchObject({ code: 'AUTHORITY_BROADENING_FORBIDDEN' })
  })

  it('expiry flips OPEN → EXPIRED on list', async () => {
    const d = deps()
    await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'exp',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-exp',
      expiresAt: '2026-07-13T10:05:00.000Z',
    })
    d.clock.advance(6 * 60_000)
    const listed = await listDecisionsV3(d, BOARD, { includeTerminal: true })
    const row = listed.find((x) => x.decisionId === 'D-exp')
    expect(row?.status).toBe('EXPIRED')
    const openOnly = await listDecisionsV3(d, BOARD)
    expect(openOnly.find((x) => x.decisionId === 'D-exp')).toBeUndefined()
  })

  it('scoped audit events on open/resolve/reject/snooze', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'aud',
      question: 'q',
      options: [
        opts({ optionId: 'o1', label: 'ok' }),
        opts({ optionId: 'o2', label: 'no', declining: true }),
      ],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-aud',
    })
    expect(open.auditIds.length).toBe(1)
    await resolveDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-aud',
        selectedOptionId: 'o1',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
      }),
    )
    const audit = await d.atomic.listAudit(BOARD)
    expect(audit.some((a) => a.kind === 'DECISION_OPENED')).toBe(true)
    expect(audit.some((a) => a.kind === 'DECISION_RESOLVED')).toBe(true)
  })

  it('full envelope: pin hash STALE; missing idempotencyKey INVALID_INPUT', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'env',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-env',
    })

    await expect(
      acknowledgeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-env',
        actorId: 'owner',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: PIN,
        currentPinHash: 'other-pin',
        idempotencyKey: uniqKey('ack'),
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(
      acknowledgeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-env',
        actorId: 'owner',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: PIN,
        currentPinHash: PIN,
        idempotencyKey: '',
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
  })

  it('idempotent REPLAY: same key no double board bump; conflict on different body', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'idem',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' }), opts({ optionId: 'o2', label: 'no' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-idem',
    })
    const key = uniqKey('ack-stable')
    const first = await acknowledgeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-idem',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        idempotencyKey: key,
      }),
    )
    expect(first.status).toBe('ACKNOWLEDGED')
    const boardAfterFirst = (await d.atomic.getBoardState(BOARD)).boardRev
    expect(boardAfterFirst).toBe(first.boardRev)

    // Exact replay: same key + same body → same record, no second bump.
    const replay = await acknowledgeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-idem',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        idempotencyKey: key,
      }),
    )
    expect(replay.status).toBe('ACKNOWLEDGED')
    expect(replay.entityRev).toBe(first.entityRev)
    expect(replay.boardRev).toBe(first.boardRev)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(boardAfterFirst)

    // Same key, different body (e.g. different expectedRev) → conflict.
    await expect(
      acknowledgeDecisionV3(
        d,
        ownerEnv({
          decisionId: 'D-idem',
          expectedRev: 999,
          expectedBoardRev: open.boardRev,
          idempotencyKey: key,
        }),
      ),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })

    // Resolve path: declining option still RESOLVED; replay stable.
    const open2 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'idem-res',
      question: 'q',
      options: [
        opts({ optionId: 'yes', label: 'Yes' }),
        opts({ optionId: 'no', label: 'No', declining: true }),
      ],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      actorId: 'agent',
      decisionId: 'D-idem-res',
    })
    const resKey = uniqKey('res-stable')
    const res1 = await resolveDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-idem-res',
        selectedOptionId: 'no',
        expectedRev: open2.entityRev,
        expectedBoardRev: open2.boardRev,
        idempotencyKey: resKey,
      }),
    )
    expect(res1.status).toBe('RESOLVED')
    const br = (await d.atomic.getBoardState(BOARD)).boardRev
    const res2 = await resolveDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-idem-res',
        selectedOptionId: 'no',
        expectedRev: open2.entityRev,
        expectedBoardRev: open2.boardRev,
        idempotencyKey: resKey,
      }),
    )
    expect(res2.boardRev).toBe(res1.boardRev)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(br)
  })

  it('reject + snooze require full envelope (canonicalHash + idempotencyKey)', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'full',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-full',
    })
    await expect(
      rejectDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-full',
        actorId: 'owner',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: '',
        idempotencyKey: uniqKey('rej'),
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })

    const rejected = await rejectDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-full',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
      }),
    )
    expect(rejected.status).toBe('REJECTED')
  })

  it('open_decision_v3 exact replay: same key+body no board bump; different body conflict', async () => {
    const d = deps()
    const key = uniqKey('open-idem-stable')
    const base: OpenDecisionV3Request = {
      boardId: BOARD,
      decisionId: 'D-open-idem',
      type: 'choice',
      severity: 'MEDIUM',
      title: 'open-idem',
      question: 'pick?',
      options: [
        opts({ optionId: 'a', label: 'A', tradeoffs: 'fast' }),
        opts({ optionId: 'b', label: 'B', tradeoffs: 'safe', declining: true }),
      ],
      blocking: true,
      taskId: 'task-1',
      runId: 'run-1',
      projectId: 'proj-1',
      featureId: 'feat-1',
      evidence: ['https://evidence.example/1'],
      agentRecommendation: 'a',
      dueAt: '2026-07-14T00:00:00.000Z',
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: key,
      actorId: 'agent',
    }
    const first = await openDecisionV3(d, base)
    expect(first.status).toBe('OPEN')
    expect(first.entityRev).toBe(1)
    const boardAfterFirst = (await d.atomic.getBoardState(BOARD)).boardRev
    expect(boardAfterFirst).toBe(first.boardRev)

    const replay = await openDecisionV3(d, base)
    expect(replay.decisionId).toBe(first.decisionId)
    expect(replay.entityRev).toBe(first.entityRev)
    expect(replay.boardRev).toBe(first.boardRev)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(boardAfterFirst)

    // Different body under same key → conflict (severity was previously excluded from hash).
    await expect(
      openDecisionV3(d, { ...base, severity: 'HIGH' }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(boardAfterFirst)
  })

  it('open_decision_v3 per-field conflict matrix (material fields in hash)', async () => {
    const base: OpenDecisionV3Request = {
      boardId: BOARD,
      decisionId: 'D-matrix',
      type: 'choice',
      severity: 'LOW',
      title: 'matrix',
      question: 'q-matrix',
      options: [
        opts({ optionId: 'o1', label: 'yes', tradeoffs: 't1' }),
        opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
      ],
      blocking: false,
      taskId: 'task-m',
      runId: 'run-m',
      projectId: 'proj-m',
      featureId: 'feat-m',
      evidence: ['e1', 'e2'],
      agentRecommendation: 'o1',
      dueAt: '2026-07-15T00:00:00.000Z',
      expiresAt: '2026-07-20T00:00:00.000Z',
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      idempotencyKey: 'unused-for-hash',
      actorId: 'agent-matrix',
    }
    const baseHash = requestHashOf(openDecisionV3IdempotencyBody(base))

    type FieldCase = { name: string; patch: Partial<OpenDecisionV3Request> }
    const cases: Array<FieldCase> = [
      // Previously excluded by independent verifier (must now change hash):
      { name: 'severity', patch: { severity: 'CRITICAL' } },
      {
        name: 'options.optionId',
        patch: {
          options: [
            opts({ optionId: 'o1-changed', label: 'yes', tradeoffs: 't1' }),
            opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
          ],
        },
      },
      {
        name: 'options.label',
        patch: {
          options: [
            opts({ optionId: 'o1', label: 'yes-changed', tradeoffs: 't1' }),
            opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
          ],
        },
      },
      {
        name: 'options.tradeoffs',
        patch: {
          options: [
            opts({ optionId: 'o1', label: 'yes', tradeoffs: 't1-changed' }),
            opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
          ],
        },
      },
      {
        name: 'options.order',
        patch: {
          options: [
            opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
            opts({ optionId: 'o1', label: 'yes', tradeoffs: 't1' }),
          ],
        },
      },
      {
        name: 'options.declining',
        patch: {
          options: [
            opts({ optionId: 'o1', label: 'yes', tradeoffs: 't1', declining: true }),
            opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
          ],
        },
      },
      { name: 'blocking', patch: { blocking: true } },
      { name: 'taskId', patch: { taskId: 'task-other' } },
      { name: 'runId', patch: { runId: 'run-other' } },
      // Remaining material fields:
      { name: 'type', patch: { type: 'approval' } },
      { name: 'title', patch: { title: 'matrix-other' } },
      { name: 'question', patch: { question: 'q-other' } },
      { name: 'decisionId', patch: { decisionId: 'D-matrix-other' } },
      { name: 'projectId', patch: { projectId: 'proj-other' } },
      { name: 'featureId', patch: { featureId: 'feat-other' } },
      { name: 'evidence', patch: { evidence: ['e1', 'e2', 'e3'] } },
      { name: 'agentRecommendation', patch: { agentRecommendation: 'o2' } },
      { name: 'dueAt', patch: { dueAt: '2026-07-16T00:00:00.000Z' } },
      { name: 'expiresAt', patch: { expiresAt: '2026-07-21T00:00:00.000Z' } },
      { name: 'expectedBoardRev', patch: { expectedBoardRev: 1 } },
      { name: 'canonicalHash', patch: { canonicalHash: 'other-pin-hash' } },
      { name: 'actorId', patch: { actorId: 'agent-other' } },
    ]

    for (const c of cases) {
      const mutated = { ...base, ...c.patch }
      const h = requestHashOf(openDecisionV3IdempotencyBody(mutated))
      expect(h, `field ${c.name} must change idempotency hash`).not.toBe(baseHash)
    }

    // Exact clone (incl. option objects rebuilt) → same hash.
    const clone: OpenDecisionV3Request = {
      ...base,
      options: [
        opts({ optionId: 'o1', label: 'yes', tradeoffs: 't1' }),
        opts({ optionId: 'o2', label: 'no', tradeoffs: 't2' }),
      ],
      evidence: ['e1', 'e2'],
    }
    expect(requestHashOf(openDecisionV3IdempotencyBody(clone))).toBe(baseHash)

    // Behavioral: same key + each critical previously-excluded field → IDEMPOTENCY_CONFLICT.
    const behavioral: Array<{ name: string; patch: Partial<OpenDecisionV3Request> }> = [
      { name: 'severity', patch: { severity: 'HIGH' } },
      {
        name: 'options',
        patch: {
          options: [opts({ optionId: 'only', label: 'solo', tradeoffs: 'x' })],
        },
      },
      { name: 'blocking', patch: { blocking: true } },
      { name: 'taskId', patch: { taskId: 'task-z' } },
      { name: 'runId', patch: { runId: 'run-z' } },
      { name: 'title', patch: { title: 'changed-title' } },
      { name: 'question', patch: { question: 'changed-q' } },
    ]
    for (const c of behavioral) {
      const d = deps()
      const key = uniqKey(`matrix-${c.name}`)
      const firstReq: OpenDecisionV3Request = {
        ...base,
        decisionId: `D-m-${c.name}`,
        idempotencyKey: key,
        expectedBoardRev: 0,
      }
      const first = await openDecisionV3(d, firstReq)
      const br = (await d.atomic.getBoardState(BOARD)).boardRev
      await expect(
        openDecisionV3(d, {
          ...firstReq,
          ...c.patch,
          // Keep decisionId distinct only when patching decisionId; otherwise same
          decisionId: firstReq.decisionId,
        }),
      ).rejects.toMatchObject({ code: 'IDEMPOTENCY_CONFLICT' })
      expect((await d.atomic.getBoardState(BOARD)).boardRev, c.name).toBe(br)
      // Exact replay still works after a conflict attempt.
      const replay = await openDecisionV3(d, firstReq)
      expect(replay.entityRev).toBe(first.entityRev)
      expect(replay.boardRev).toBe(first.boardRev)
    }
  })

  it('open_decision_v3 preserves resolve/ack/snooze/reject after hash repair', async () => {
    const d = deps()
    const open = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'preserve-actions',
      question: 'q',
      options: [
        opts({ optionId: 'yes', label: 'Yes' }),
        opts({ optionId: 'no', label: 'No', declining: true }),
      ],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-preserve',
    })
    const ack = await acknowledgeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-preserve',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
      }),
    )
    expect(ack.status).toBe('ACKNOWLEDGED')

    const open2 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'preserve-snooze',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: ack.boardRev,
      actorId: 'agent',
      decisionId: 'D-preserve-sn',
    })
    const snoozed = await snoozeDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-preserve-sn',
        snoozedUntil: '2026-07-13T18:00:00.000Z',
        expectedRev: open2.entityRev,
        expectedBoardRev: open2.boardRev,
      }),
    )
    expect(snoozed.snoozedUntilMs).toBeTruthy()

    const open3 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'preserve-res',
      question: 'q',
      options: [
        opts({ optionId: 'yes', label: 'Yes' }),
        opts({ optionId: 'no', label: 'No', declining: true }),
      ],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: snoozed.boardRev,
      actorId: 'agent',
      decisionId: 'D-preserve-res',
    })
    const resolved = await resolveDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-preserve-res',
        selectedOptionId: 'no',
        expectedRev: open3.entityRev,
        expectedBoardRev: open3.boardRev,
      }),
    )
    expect(resolved.status).toBe('RESOLVED')

    const open4 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 't',
      severity: 'LOW',
      title: 'preserve-rej',
      question: 'q',
      options: [opts({ optionId: 'o1', label: 'ok' })],
      blocking: false,
      entityExpectedRev: 0,
      canonicalHash: PIN,
      idempotencyKey: uniqKey('open'),
      expectedBoardRev: resolved.boardRev,
      actorId: 'agent',
      decisionId: 'D-preserve-rej',
    })
    const rejected = await rejectDecisionV3(
      d,
      ownerEnv({
        decisionId: 'D-preserve-rej',
        expectedRev: open4.entityRev,
        expectedBoardRev: open4.boardRev,
      }),
    )
    expect(rejected.status).toBe('REJECTED')
  })
})
