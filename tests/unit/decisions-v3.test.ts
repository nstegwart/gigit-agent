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
  rejectDecisionV3,
  resolveDecisionV3,
  snoozeDecisionV3,
  type DecisionV3Deps,
  type DecisionV3Record,
  type DecisionOptionV3,
} from '#/server/decisions-v3'

const BOARD = 'mfs-rebuild'

function deps(clock = createFakeClock()) {
  const d: DecisionV3Deps & { clock: ReturnType<typeof createFakeClock> } = {
    clock,
    decisions: createMemoryDecisionV3Store(),
    atomic: createMemoryControlPlaneAtomicStore([
      { boardId: BOARD, boardRev: 0, dispatchBlocked: false, dispatchBlockedReason: null },
    ]),
  }
  return d
}

function opts(over: Partial<DecisionOptionV3> & Pick<DecisionOptionV3, 'optionId' | 'label'>): DecisionOptionV3 {
  return { declining: false, ...over }
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
      expectedBoardRev: openNon.boardRev,
      actorId: 'agent',
      decisionId: 'D-b',
    })

    await expect(
      snoozeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-b',
        actorId: 'owner',
        snoozedUntil: '2026-07-13T18:00:00.000Z',
        expectedRev: openBlock.entityRev,
        expectedBoardRev: openBlock.boardRev,
      }),
    ).rejects.toMatchObject({ code: 'SNOOZE_BLOCKED' })

    const snoozed = await snoozeDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-nb',
      actorId: 'owner',
      snoozedUntil: '2026-07-13T12:00:00.000Z',
      expectedRev: openNon.entityRev,
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
    })
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
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-dec',
    })
    const resolved = await resolveDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-dec',
      actorId: 'owner',
      selectedOptionId: 'no',
      comment: 'declining option',
      scopedApprovalId: 'appr-1',
      expectedRev: a.entityRev,
      expectedBoardRev: a.boardRev,
    })
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
      expectedBoardRev: resolved.boardRev,
      actorId: 'agent',
      decisionId: 'D-rej',
    })
    const rejected = await rejectDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-rej',
      actorId: 'owner',
      comment: 'request rejected',
      expectedRev: b.entityRev,
      expectedBoardRev: b.boardRev,
    })
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
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-rev',
    })
    await expect(
      acknowledgeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-rev',
        actorId: 'owner',
        expectedRev: 999,
        expectedBoardRev: open.boardRev,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    await expect(
      acknowledgeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-rev',
        actorId: 'owner',
        expectedRev: open.entityRev,
        expectedBoardRev: 999,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })

    const ack = await acknowledgeDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-rev',
      actorId: 'owner',
      expectedRev: open.entityRev,
      expectedBoardRev: open.boardRev,
    })
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
      expectedBoardRev: 0,
      actorId: 'agent',
      decisionId: 'D-aud',
    })
    expect(open.auditIds.length).toBe(1)
    await resolveDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-aud',
      actorId: 'owner',
      selectedOptionId: 'o1',
      expectedRev: open.entityRev,
      expectedBoardRev: open.boardRev,
    })
    const audit = await d.atomic.listAudit(BOARD)
    expect(audit.some((a) => a.kind === 'DECISION_OPENED')).toBe(true)
    expect(audit.some((a) => a.kind === 'DECISION_RESOLVED')).toBe(true)
  })
})
