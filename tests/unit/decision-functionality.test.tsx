/**
 * Decision owner actions + HumanDisplay fail-closed — unit/jsdom support evidence.
 * LOCAL ONLY (no real browser / API / DB mutation this session).
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import {
  DecisionsScreen,
  DecisionCard,
  decisionActionAvailability,
  decisionMutationRevs,
  resolveDecisionOwnerDisplay,
  type DecisionItemView,
  type DecisionsScreenProps,
} from '#/components/control-center/decisions'

function item(
  partial: Partial<DecisionItemView> & Pick<DecisionItemView, 'decisionId' | 'title'>,
): DecisionItemView {
  return {
    question: null,
    severity: 'HIGH',
    blocking: true,
    status: 'OPEN',
    dueAt: null,
    createdAt: '2026-07-13T10:00:00.000Z',
    snoozedUntil: null,
    type: 'owner',
    evidence: [],
    options: [],
    recommendation: null,
    ownerId: null,
    resolverId: null,
    selectedOptionId: null,
    expectedRev: 1,
    boardRev: 3,
    entityRev: 1,
    scopedApprovalId: null,
    auditIds: [],
    ownerActions: ['Resolve blocking decision', 'Snooze unavailable (blocking)'],
    partialFields: true,
    absentFields: ['question', 'options', 'evidence', 'agentRecommendation'],
    contentReviewRequired: true,
    effectiveReviewStatus: 'CONTENT_REVIEW_REQUIRED',
    ...partial,
  }
}

function baseProps(over: Partial<DecisionsScreenProps> = {}): DecisionsScreenProps {
  return {
    surfaceState: 'needs-human',
    boardId: 'mfs-rebuild',
    items: [
      item({
        decisionId: 'dec-1',
        title: 'Raise capacity floor',
        severity: 'CRITICAL',
        blocking: true,
        options: [
          { optionId: 'yes', label: 'Ship' },
          { optionId: 'no', label: 'Wait', declining: true },
        ],
        partialFields: false,
        absentFields: [],
        question: 'Raise capacity?',
      }),
      item({
        decisionId: 'dec-2',
        title: 'Non-blocking review',
        severity: 'MEDIUM',
        blocking: false,
        status: 'ACKNOWLEDGED',
        entityRev: 2,
        boardRev: 3,
        options: [{ optionId: 'ok', label: 'OK' }],
        ownerActions: ['Review decision', 'Snooze (non-blocking only)'],
        partialFields: false,
        absentFields: [],
      }),
    ],
    openCount: 2,
    blockingCount: 1,
    pageSize: 50,
    nextCursor: null,
    pin: {
      boardId: 'mfs-rebuild',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canonhash_decisions_aa',
      boardRev: 3,
      lifecycleRev: 1,
      stale: false,
      staleReason: null,
    },
    canAct: true,
    ...over,
  }
}

describe('decisionActionAvailability', () => {
  it('blocking cannot snooze; open can ack/resolve/reject', () => {
    const a = decisionActionAvailability({ status: 'OPEN', blocking: true })
    expect(a.canAcknowledge).toBe(true)
    expect(a.canResolve).toBe(true)
    expect(a.canReject).toBe(true)
    expect(a.canSnooze).toBe(false)
    expect(a.snoozeBlockedReason).toMatch(/Blocking/)
  })

  it('ACKNOWLEDGED skips acknowledge; non-blocking can snooze', () => {
    const a = decisionActionAvailability({ status: 'ACKNOWLEDGED', blocking: false })
    expect(a.canAcknowledge).toBe(false)
    expect(a.canSnooze).toBe(true)
  })

  it('EXPIRED and terminal close actions', () => {
    expect(decisionActionAvailability({ status: 'EXPIRED', blocking: false }).canResolve).toBe(
      false,
    )
    expect(decisionActionAvailability({ status: 'RESOLVED', blocking: true }).canReject).toBe(
      false,
    )
  })

  it('canAct false disables all', () => {
    const a = decisionActionAvailability({ status: 'OPEN', blocking: false }, { canAct: false })
    expect(a.canAcknowledge).toBe(false)
    expect(a.canSnooze).toBe(false)
  })
})

describe('decisionMutationRevs', () => {
  it('prefers entityRev and boardRev', () => {
    expect(
      decisionMutationRevs(
        { entityRev: 5, expectedRev: 1, boardRev: 9 },
        3,
      ),
    ).toEqual({ expectedRev: 5, expectedBoardRev: 9 })
  })

  it('falls back to pin boardRev and expectedRev', () => {
    expect(
      decisionMutationRevs(
        { entityRev: null, expectedRev: 2, boardRev: null },
        7,
      ),
    ).toEqual({ expectedRev: 2, expectedBoardRev: 7 })
  })

  it('null when revs missing', () => {
    expect(
      decisionMutationRevs(
        { entityRev: null, expectedRev: null, boardRev: null },
        null,
      ),
    ).toBeNull()
  })
})

describe('decision envelope helpers (full pin + 24h key)', () => {
  it('buildDecisionOwnerIdempotencyKey stable unique per action', async () => {
    const { buildDecisionOwnerIdempotencyKey, decisionMutationEnvelope } = await import(
      '#/components/control-center/decisions/decisionActions'
    )
    const a = buildDecisionOwnerIdempotencyKey({
      action: 'acknowledge',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-1',
      expectedRev: 1,
      expectedBoardRev: 3,
      canonicalHash: 'canonhash_decisions_aa',
    })
    const b = buildDecisionOwnerIdempotencyKey({
      action: 'resolve',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-1',
      expectedRev: 1,
      expectedBoardRev: 3,
      canonicalHash: 'canonhash_decisions_aa',
      selectedOptionId: 'yes',
    })
    expect(a).not.toBe(b)
    expect(a.length).toBeLessThanOrEqual(191)

    const env = decisionMutationEnvelope(
      item({ decisionId: 'dec-1', title: 't', entityRev: 1, boardRev: 3 }),
      {
        boardId: 'mfs-rebuild',
        boardRev: 3,
        canonicalHash: 'canonhash_decisions_aa',
      },
      'acknowledge',
    )
    expect(env?.canonicalHash).toBe('canonhash_decisions_aa')
    expect(env?.idempotencyKey).toBe(a)
  })
})

describe('resolveDecisionOwnerDisplay fail-closed', () => {
  it('CONTENT_REVIEW_REQUIRED when HD missing — never raw technical as sole primary without shell', () => {
    const d = resolveDecisionOwnerDisplay(
      item({
        decisionId: 'raw-1',
        title: '[FC-99] cryptic technical title',
        contentReviewRequired: true,
        ownerHumanDisplay: null,
      }),
    )
    expect(d.contentReviewRequired).toBe(true)
    expect(d.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(d.primaryTitle).toMatch(/peninjauan|CONTENT_REVIEW|Konten/i)
    expect(d.primaryTitle).not.toBe('[FC-99] cryptic technical title')
    expect(d.technicalTitle).toBe('[FC-99] cryptic technical title')
  })

  it('uses ownerPrimaryTitle when reviewed', () => {
    const d = resolveDecisionOwnerDisplay(
      item({
        decisionId: 'hd-1',
        title: 'tech-title',
        contentReviewRequired: false,
        ownerPrimaryTitle: 'Naikkan kapasitas',
        statusSentence: 'Butuh keputusan pemilik.',
        ownerHumanDisplay: {
          contentReviewRequired: false,
          effectiveReviewStatus: 'REVIEWED',
          ownerPrimaryTitle: 'Naikkan kapasitas',
          statusSentence: 'Butuh keputusan pemilik.',
          ownerAction: 'Pilih opsi',
          whyItMatters: 'Mengunci kapasitas',
          next: 'Konfirmasi',
          blocker: '',
        },
      }),
    )
    expect(d.contentReviewRequired).toBe(false)
    expect(d.primaryTitle).toBe('Naikkan kapasitas')
    expect(d.statusSentence).toBe('Butuh keputusan pemilik.')
    expect(d.ownerAction).toBe('Pilih opsi')
  })
})

describe('DecisionCard interactive actions', () => {
  it('renders real buttons not span lookalikes for open decision', () => {
    const onResolve = vi.fn()
    const onReject = vi.fn()
    const onAcknowledge = vi.fn()
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        canAct
        item={item({
          decisionId: 'act-1',
          title: 'Act',
          blocking: false,
          options: [
            { optionId: 'a', label: 'Yes' },
            { optionId: 'b', label: 'No', declining: true },
          ],
          partialFields: false,
          absentFields: [],
        })}
        actions={{ onResolve, onReject, onAcknowledge, onSnooze: vi.fn() }}
      />,
    )
    const card = screen.getByTestId('decision-card')
    const ack = within(card).getByTestId('decision-action-acknowledge')
    expect(ack.tagName).toBe('BUTTON')
    expect(ack).toHaveProperty('disabled', false)

    const resolveBtns = within(card).getAllByTestId('decision-action-resolve')
    expect(resolveBtns).toHaveLength(2)
    expect(resolveBtns[0].tagName).toBe('BUTTON')

    fireEvent.click(ack)
    expect(onAcknowledge).toHaveBeenCalledWith(
      expect.objectContaining({
        boardId: 'mfs-rebuild',
        decisionId: 'act-1',
        expectedRev: 1,
        expectedBoardRev: 3,
      }),
    )

    fireEvent.click(resolveBtns[1])
    expect(onResolve).toHaveBeenCalledWith(
      expect.objectContaining({
        decisionId: 'act-1',
        selectedOptionId: 'b',
      }),
    )

    fireEvent.click(within(card).getByTestId('decision-action-reject'))
    expect(onReject).toHaveBeenCalledWith(
      expect.objectContaining({ decisionId: 'act-1' }),
    )

    fireEvent.click(within(card).getByTestId('decision-action-snooze'))
  })

  it('blocking shows snooze blocked hint, no snooze button', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'b1',
          title: 'Blocker',
          blocking: true,
          options: [{ optionId: 'x', label: 'Go' }],
          partialFields: false,
          absentFields: [],
        })}
        actions={{
          onResolve: vi.fn(),
          onReject: vi.fn(),
          onAcknowledge: vi.fn(),
          onSnooze: vi.fn(),
        }}
      />,
    )
    const card = screen.getByTestId('decision-card')
    expect(within(card).queryByTestId('decision-action-snooze')).toBeNull()
    expect(within(card).getByTestId('decision-action-snooze-blocked').textContent).toMatch(
      /Snooze unavailable/,
    )
    expect(within(card).getByTestId('decision-snooze').textContent).toMatch(/Cannot hide/)
  })

  it('EXPIRED shows expired state and no mutation buttons', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'exp',
          title: 'Old',
          status: 'EXPIRED',
          blocking: false,
          partialFields: false,
          absentFields: [],
        })}
        actions={{
          onResolve: vi.fn(),
          onReject: vi.fn(),
          onAcknowledge: vi.fn(),
          onSnooze: vi.fn(),
        }}
      />,
    )
    expect(screen.getByTestId('decision-expired-state')).toBeTruthy()
    expect(screen.getByTestId('decision-expired-badge')).toBeTruthy()
    expect(screen.queryByTestId('decision-action-acknowledge')).toBeNull()
    expect(screen.queryByTestId('decision-action-resolve')).toBeNull()
    expect(screen.queryByTestId('decision-action-reject')).toBeNull()
    expect(screen.queryByTestId('decision-action-snooze')).toBeNull()
  })

  it('pending disables buttons and surfaces action error', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        pending
        pendingAction="resolve"
        actionError={{ code: 'STALE_REVISION', message: 'entity rev mismatch', action: 'resolve' }}
        item={item({
          decisionId: 'p1',
          title: 'Pending',
          blocking: false,
          options: [{ optionId: 'a', label: 'A' }],
          partialFields: false,
          absentFields: [],
        })}
        actions={{ onResolve: vi.fn(), onReject: vi.fn(), onAcknowledge: vi.fn(), onSnooze: vi.fn() }}
      />,
    )
    const card = screen.getByTestId('decision-card')
    expect(card.getAttribute('data-pending')).toBe('true')
    expect(card.getAttribute('data-pending-action')).toBe('resolve')
    expect(within(card).getByTestId('decision-action-acknowledge')).toHaveProperty(
      'disabled',
      true,
    )
    const err = within(card).getByTestId('decision-action-error')
    expect(err.getAttribute('data-error-code')).toBe('STALE_REVISION')
    expect(err.textContent).toMatch(/entity rev mismatch/)
  })

  it('REJECTED badge distinguishes from declining-option RESOLVED', () => {
    const { rerender } = render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'rej',
          title: 'Rejected',
          status: 'REJECTED',
          partialFields: false,
          absentFields: [],
        })}
      />,
    )
    expect(screen.getByTestId('decision-rejected-badge')).toBeTruthy()
    rerender(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'dec',
          title: 'Declined',
          status: 'RESOLVED',
          selectedOptionId: 'no',
          options: [
            { optionId: 'yes', label: 'Yes' },
            { optionId: 'no', label: 'No', declining: true },
          ],
          partialFields: false,
          absentFields: [],
        })}
      />,
    )
    expect(screen.getByTestId('decision-declined-badge')).toBeTruthy()
    expect(screen.queryByTestId('decision-rejected-badge')).toBeNull()
  })
})

describe('DecisionsScreen action wiring + states', () => {
  it('preserves server order with action buttons on cards', () => {
    render(<DecisionsScreen {...baseProps()} actions={{ onResolve: vi.fn() }} />)
    const cards = screen.getAllByTestId('decision-card')
    expect(cards.map((c) => c.getAttribute('data-decision-id'))).toEqual(['dec-1', 'dec-2'])
    // blocking first card: no snooze button
    expect(within(cards[0]).queryByTestId('decision-action-snooze')).toBeNull()
    // non-blocking second: snooze present
    expect(within(cards[1]).getByTestId('decision-action-snooze')).toBeTruthy()
    // ACKNOWLEDGED: no acknowledge on second
    expect(within(cards[1]).queryByTestId('decision-action-acknowledge')).toBeNull()
  })

  it('forbidden surface shows forbidden banner, hides list', () => {
    render(
      <DecisionsScreen
        {...baseProps({
          surfaceState: 'forbidden',
          items: [],
          error: { code: 'FORBIDDEN', message: 'admin only' },
        })}
      />,
    )
    expect(screen.getByTestId('decisions-forbidden').textContent).toMatch(/Forbidden/)
    expect(screen.queryByTestId('decisions-list')).toBeNull()
  })

  it('error surface still field-linked retry', () => {
    const onRetry = vi.fn()
    render(
      <DecisionsScreen
        {...baseProps({
          surfaceState: 'error',
          items: [],
          error: { code: 'FETCH_FAILED', message: 'upstream down' },
          onRetry,
        })}
      />,
    )
    const alert = screen.getByTestId('decisions-error')
    expect(alert.textContent).toMatch(/FETCH_FAILED/)
    within(alert).getByRole('button', { name: /Retry/i }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('action error map routes to matching card', () => {
    render(
      <DecisionsScreen
        {...baseProps({
          actionErrors: {
            'dec-1': { code: 'SNOOZE_BLOCKED', message: 'blocking', action: 'snooze' },
          },
        })}
        actions={{ onResolve: vi.fn(), onReject: vi.fn(), onAcknowledge: vi.fn() }}
      />,
    )
    const cards = screen.getAllByTestId('decision-card')
    expect(within(cards[0]).getByTestId('decision-action-error').textContent).toMatch(
      /SNOOZE_BLOCKED/,
    )
    expect(within(cards[1]).queryByTestId('decision-action-error')).toBeNull()
  })

  it('canAct false disables interactive buttons', () => {
    render(
      <DecisionsScreen
        {...baseProps({ canAct: false })}
        actions={{
          onResolve: vi.fn(),
          onReject: vi.fn(),
          onAcknowledge: vi.fn(),
          onSnooze: vi.fn(),
        }}
      />,
    )
    const root = screen.getByTestId('control-center-decisions')
    expect(root.getAttribute('data-can-act')).toBe('false')
    // availability closes actions when canAct false
    expect(screen.queryByTestId('decision-action-acknowledge')).toBeNull()
  })
})

describe('44x44 touch semantics (CSS module contract)', () => {
  it('action buttons use dec-touch min size class', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'touch',
          title: 'T',
          blocking: false,
          options: [{ optionId: 'a', label: 'A' }],
          partialFields: false,
          absentFields: [],
        })}
        actions={{ onResolve: vi.fn(), onAcknowledge: vi.fn(), onReject: vi.fn(), onSnooze: vi.fn() }}
      />,
    )
    const btn = screen.getByTestId('decision-action-acknowledge')
    // className from CSS module ends with actionBtn + actionBtnPrimary
    expect(btn.className).toMatch(/actionBtn/)
  })
})
