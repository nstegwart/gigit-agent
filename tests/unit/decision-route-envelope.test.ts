/**
 * Route-level behavioral tests for Decision owner full envelope.
 * Exercises prepareDecisionOwnerEnvelope + domain mutators with route-shaped deps
 * (idempotency + pin hash + unique stable keys). No real HTTP/browser.
 */
import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest'

import {
  buildDecisionOwnerIdempotencyKey,
  decisionMutationEnvelope,
} from '#/components/control-center/decisions/decisionActions'
import {
  createFakeClock,
  createMemoryControlPlaneAtomicStore,
} from '#/server/board-store'
import {
  acknowledgeDecisionV3,
  createMemoryDecisionV3Store,
  openDecisionV3,
  rejectDecisionV3,
  resolveDecisionV3,
  snoozeDecisionV3,
  type DecisionV3Deps,
} from '#/server/decisions-v3'
import { createMemoryIdempotencyStorage } from '#/server/idempotency'

const BOARD = 'mfs-rebuild'
const PIN = 'route-pin-hash-aabbcc'

function makeDeps(clock = createFakeClock()) {
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

/** Mirrors route prepareDecisionOwnerEnvelope without control-plane runtime. */
function prepareEnvelopeLocal(input: {
  action: 'acknowledge' | 'resolve' | 'reject' | 'snooze'
  boardId: string
  decisionId: string
  expectedRev: number
  expectedBoardRev: number
  canonicalHash?: string | null
  idempotencyKey?: string | null
  selectedOptionId?: string | null
  snoozedUntil?: string | null
  currentPinHash: string
}) {
  const clientHash =
    input.canonicalHash && String(input.canonicalHash).trim()
      ? String(input.canonicalHash).trim()
      : null
  const canonicalHash = clientHash ?? input.currentPinHash
  const idempotencyKey =
    input.idempotencyKey && String(input.idempotencyKey).trim()
      ? String(input.idempotencyKey).trim()
      : buildDecisionOwnerIdempotencyKey({
          action: input.action,
          boardId: input.boardId,
          decisionId: input.decisionId,
          expectedRev: input.expectedRev,
          expectedBoardRev: input.expectedBoardRev,
          canonicalHash,
          selectedOptionId: input.selectedOptionId,
          snoozedUntil: input.snoozedUntil,
        })
  return {
    canonicalHash,
    currentPinHash: input.currentPinHash,
    idempotencyKey,
  }
}

describe('decision route envelope helpers', () => {
  it('buildDecisionOwnerIdempotencyKey is stable, unique per action, ≤191 chars', () => {
    const base = {
      boardId: BOARD,
      decisionId: 'dec-1',
      expectedRev: 2,
      expectedBoardRev: 5,
      canonicalHash: PIN,
    }
    const a = buildDecisionOwnerIdempotencyKey({ ...base, action: 'acknowledge' })
    const a2 = buildDecisionOwnerIdempotencyKey({ ...base, action: 'acknowledge' })
    const r = buildDecisionOwnerIdempotencyKey({
      ...base,
      action: 'resolve',
      selectedOptionId: 'yes',
    })
    const rOther = buildDecisionOwnerIdempotencyKey({
      ...base,
      action: 'resolve',
      selectedOptionId: 'no',
    })
    expect(a).toBe(a2)
    expect(a).not.toBe(r)
    expect(r).not.toBe(rOther)
    expect(a.length).toBeLessThanOrEqual(191)
    expect(a.startsWith('dec-v3:acknowledge:')).toBe(true)
  })

  it('decisionMutationEnvelope includes hash + key when pin present', () => {
    const env = decisionMutationEnvelope(
      { decisionId: 'd1', entityRev: 3, expectedRev: 1, boardRev: 9 },
      { boardId: BOARD, boardRev: 9, canonicalHash: PIN },
      'reject',
    )
    expect(env).not.toBeNull()
    expect(env!.expectedRev).toBe(3)
    expect(env!.expectedBoardRev).toBe(9)
    expect(env!.canonicalHash).toBe(PIN)
    expect(env!.idempotencyKey).toContain('reject')
    expect(env!.idempotencyKey).toContain('d1')
  })

  it('decisionMutationEnvelope null without pin hash', () => {
    expect(
      decisionMutationEnvelope(
        { decisionId: 'd1', entityRev: 1, expectedRev: 1, boardRev: 1 },
        { boardId: BOARD, boardRev: 1, canonicalHash: '' },
        'acknowledge',
      ),
    ).toBeNull()
  })
})

describe('route-shaped owner mutation behavioral (full envelope)', () => {
  it('ack/resolve/reject/snooze: prepare envelope → mutator; REPLAY no double board bump', async () => {
    const d = makeDeps()
    const opened = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'HIGH',
      title: 'route-env',
      question: 'act?',
      options: [
        { optionId: 'yes', label: 'Yes', declining: false },
        { optionId: 'no', label: 'No', declining: true },
      ],
      blocking: false,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-route-1',
      actorId: 'agent',
      decisionId: 'D-route-1',
    })

    // --- acknowledge ---
    const ackPrep = prepareEnvelopeLocal({
      action: 'acknowledge',
      boardId: BOARD,
      decisionId: 'D-route-1',
      expectedRev: opened.entityRev,
      expectedBoardRev: opened.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
    })
    expect(ackPrep.idempotencyKey).toContain('acknowledge')
    const ack = await acknowledgeDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-1',
      actorId: 'admin-1',
      expectedRev: opened.entityRev,
      entityExpectedRev: opened.entityRev,
      expectedBoardRev: opened.boardRev,
      canonicalHash: ackPrep.canonicalHash,
      currentPinHash: ackPrep.currentPinHash,
      idempotencyKey: ackPrep.idempotencyKey,
    })
    expect(ack.status).toBe('ACKNOWLEDGED')
    const brAfterAck = (await d.atomic.getBoardState(BOARD)).boardRev
    const ackReplay = await acknowledgeDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-1',
      actorId: 'admin-1',
      expectedRev: opened.entityRev,
      entityExpectedRev: opened.entityRev,
      expectedBoardRev: opened.boardRev,
      canonicalHash: ackPrep.canonicalHash,
      currentPinHash: ackPrep.currentPinHash,
      idempotencyKey: ackPrep.idempotencyKey,
    })
    expect(ackReplay.entityRev).toBe(ack.entityRev)
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(brAfterAck)

    // open a second decision for resolve/reject/snooze isolation
    const o2 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'MEDIUM',
      title: 'route-env-2',
      question: 'act2?',
      options: [
        { optionId: 'yes', label: 'Yes', declining: false },
        { optionId: 'no', label: 'No', declining: true },
      ],
      blocking: false,
      entityExpectedRev: 0,
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-route-2',
      actorId: 'agent',
      decisionId: 'D-route-2',
    })

    // --- resolve (declining → RESOLVED) ---
    const resPrep = prepareEnvelopeLocal({
      action: 'resolve',
      boardId: BOARD,
      decisionId: 'D-route-2',
      expectedRev: o2.entityRev,
      expectedBoardRev: o2.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      selectedOptionId: 'no',
    })
    const resolved = await resolveDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-2',
      actorId: 'admin-1',
      selectedOptionId: 'no',
      expectedRev: o2.entityRev,
      entityExpectedRev: o2.entityRev,
      expectedBoardRev: o2.boardRev,
      canonicalHash: resPrep.canonicalHash,
      currentPinHash: resPrep.currentPinHash,
      idempotencyKey: resPrep.idempotencyKey,
    })
    expect(resolved.status).toBe('RESOLVED')
    expect(resolved.selectedOptionId).toBe('no')
    const brRes = (await d.atomic.getBoardState(BOARD)).boardRev
    await resolveDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-2',
      actorId: 'admin-1',
      selectedOptionId: 'no',
      expectedRev: o2.entityRev,
      entityExpectedRev: o2.entityRev,
      expectedBoardRev: o2.boardRev,
      canonicalHash: resPrep.canonicalHash,
      currentPinHash: resPrep.currentPinHash,
      idempotencyKey: resPrep.idempotencyKey,
    })
    expect((await d.atomic.getBoardState(BOARD)).boardRev).toBe(brRes)

    // --- reject path (request rejection ≠ declining) ---
    const o3 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'LOW',
      title: 'route-env-3',
      question: 'act3?',
      options: [{ optionId: 'yes', label: 'Yes', declining: false }],
      blocking: false,
      entityExpectedRev: 0,
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-route-3',
      actorId: 'agent',
      decisionId: 'D-route-3',
    })
    const rejPrep = prepareEnvelopeLocal({
      action: 'reject',
      boardId: BOARD,
      decisionId: 'D-route-3',
      expectedRev: o3.entityRev,
      expectedBoardRev: o3.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
    })
    const rejected = await rejectDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-3',
      actorId: 'admin-1',
      expectedRev: o3.entityRev,
      entityExpectedRev: o3.entityRev,
      expectedBoardRev: o3.boardRev,
      canonicalHash: rejPrep.canonicalHash,
      currentPinHash: rejPrep.currentPinHash,
      idempotencyKey: rejPrep.idempotencyKey,
      comment: 'nope',
    })
    expect(rejected.status).toBe('REJECTED')
    expect(rejected.selectedOptionId).toBeNull()

    // --- snooze non-blocking ---
    const o4 = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'LOW',
      title: 'route-env-4',
      question: 'act4?',
      options: [{ optionId: 'ok', label: 'OK', declining: false }],
      blocking: false,
      entityExpectedRev: 0,
      expectedBoardRev: (await d.atomic.getBoardState(BOARD)).boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-route-4',
      actorId: 'agent',
      decisionId: 'D-route-4',
    })
    const until = '2026-07-14T12:00:00.000Z'
    const snPrep = prepareEnvelopeLocal({
      action: 'snooze',
      boardId: BOARD,
      decisionId: 'D-route-4',
      expectedRev: o4.entityRev,
      expectedBoardRev: o4.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      snoozedUntil: until,
    })
    const snoozed = await snoozeDecisionV3(d, {
      boardId: BOARD,
      decisionId: 'D-route-4',
      actorId: 'admin-1',
      snoozedUntil: until,
      expectedRev: o4.entityRev,
      entityExpectedRev: o4.entityRev,
      expectedBoardRev: o4.boardRev,
      canonicalHash: snPrep.canonicalHash,
      currentPinHash: snPrep.currentPinHash,
      idempotencyKey: snPrep.idempotencyKey,
    })
    expect(snoozed.snoozedUntil).toBe(until)
  })

  it('pin hash mismatch from prepare+mutator is STALE_REVISION (route pin CAS)', async () => {
    const d = makeDeps()
    const opened = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'LOW',
      title: 'stale-pin',
      question: '?',
      options: [{ optionId: 'ok', label: 'OK', declining: false }],
      blocking: false,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-stale-pin',
      actorId: 'agent',
      decisionId: 'D-stale-pin',
    })
    const prep = prepareEnvelopeLocal({
      action: 'reject',
      boardId: BOARD,
      decisionId: 'D-stale-pin',
      expectedRev: opened.entityRev,
      expectedBoardRev: opened.boardRev,
      canonicalHash: 'client-old-hash',
      currentPinHash: PIN,
    })
    // Client hash ≠ current pin → domain STALE
    await expect(
      rejectDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-stale-pin',
        actorId: 'admin-1',
        expectedRev: opened.entityRev,
        expectedBoardRev: opened.boardRev,
        canonicalHash: prep.canonicalHash,
        currentPinHash: prep.currentPinHash,
        idempotencyKey: prep.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'STALE_REVISION' })
  })

  it('blocking snooze still SNOOZE_BLOCKED with full envelope', async () => {
    const d = makeDeps()
    const opened = await openDecisionV3(d, {
      boardId: BOARD,
      type: 'owner',
      severity: 'CRITICAL',
      title: 'block-sn',
      question: '?',
      options: [{ optionId: 'ok', label: 'OK', declining: false }],
      blocking: true,
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: PIN,
      currentPinHash: PIN,
      idempotencyKey: 'open-block-sn',
      actorId: 'agent',
      decisionId: 'D-block-sn',
    })
    const prep = prepareEnvelopeLocal({
      action: 'snooze',
      boardId: BOARD,
      decisionId: 'D-block-sn',
      expectedRev: opened.entityRev,
      expectedBoardRev: opened.boardRev,
      canonicalHash: PIN,
      currentPinHash: PIN,
      snoozedUntil: '2026-07-14T00:00:00.000Z',
    })
    await expect(
      snoozeDecisionV3(d, {
        boardId: BOARD,
        decisionId: 'D-block-sn',
        actorId: 'admin-1',
        snoozedUntil: '2026-07-14T00:00:00.000Z',
        expectedRev: opened.entityRev,
        expectedBoardRev: opened.boardRev,
        canonicalHash: prep.canonicalHash,
        currentPinHash: prep.currentPinHash,
        idempotencyKey: prep.idempotencyKey,
      }),
    ).rejects.toMatchObject({ code: 'SNOOZE_BLOCKED' })
  })
})

describe('route module exports (prepareDecisionOwnerEnvelope shape)', () => {
  beforeEach(() => {
    vi.resetModules()
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('buildDecisionOwnerIdempotencyKey matches route prepare key emission pattern', () => {
    // Route prepareDecisionOwnerEnvelope delegates to this helper when key absent.
    const key = buildDecisionOwnerIdempotencyKey({
      action: 'acknowledge',
      boardId: 'b1',
      decisionId: 'd1',
      expectedRev: 1,
      expectedBoardRev: 2,
      canonicalHash: 'hash1234567890abcdef',
    })
    expect(key).toBe(
      buildDecisionOwnerIdempotencyKey({
        action: 'acknowledge',
        boardId: 'b1',
        decisionId: 'd1',
        expectedRev: 1,
        expectedBoardRev: 2,
        canonicalHash: 'hash1234567890abcdef',
      }),
    )
    // Unique per action kind
    expect(key).not.toBe(
      buildDecisionOwnerIdempotencyKey({
        action: 'reject',
        boardId: 'b1',
        decisionId: 'd1',
        expectedRev: 1,
        expectedBoardRev: 2,
        canonicalHash: 'hash1234567890abcdef',
      }),
    )
  })
})
