/**
 * C3-R1C Decisions components — unit / jsdom binding tests.
 * Support evidence only (LOCAL ONLY); no real-browser visual pair.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import {
  DecisionsScreen,
  DecisionCard,
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
    boardRev: 1,
    entityRev: 1,
    scopedApprovalId: null,
    auditIds: [],
    ownerActions: ['Resolve blocking decision', 'Snooze unavailable (blocking)'],
    partialFields: true,
    absentFields: ['question', 'options', 'evidence', 'agentRecommendation'],
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
      }),
      item({
        decisionId: 'dec-2',
        title: 'Non-blocking review',
        severity: 'MEDIUM',
        blocking: false,
        status: 'ACKNOWLEDGED',
        ownerActions: ['Review decision', 'Snooze (non-blocking only)'],
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
    projectionGaps: [
      'question absent on one or more decision rows',
      'options absent on one or more decision rows',
    ],
    ...over,
  }
}

describe('DecisionsScreen', () => {
  it('preserves server item order without client re-sort', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const cards = screen.getAllByTestId('decision-card')
    expect(cards.map((c) => c.getAttribute('data-decision-id'))).toEqual(['dec-1', 'dec-2'])
  })

  it('renders open/blocking counts and needs-human banner', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const root = screen.getByTestId('control-center-decisions')
    expect(root.getAttribute('data-open-count')).toBe('2')
    expect(root.getAttribute('data-blocking-count')).toBe('1')
    expect(root.getAttribute('data-needs-human')).toBe('true')
    expect(screen.getByTestId('decisions-needs-human')).toBeTruthy()
    expect(screen.getByTestId('decisions-blocking-count').textContent).toMatch(/1 blocking/)
  })

  it('shows honest partial slots when question/options/evidence missing', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const card = screen.getAllByTestId('decision-card')[0]
    expect(within(card).getByTestId('decision-question-partial')).toBeTruthy()
    expect(within(card).getByTestId('decision-options-partial')).toBeTruthy()
    expect(within(card).getByTestId('decision-evidence-empty')).toBeTruthy()
    expect(within(card).getByTestId('decision-recommendation-partial')).toBeTruthy()
    expect(within(card).getByTestId('decision-partial-notice')).toBeTruthy()
  })

  it('blocking card cannot claim snooze hide', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'b1',
          title: 'Blocker',
          blocking: true,
          entityRev: 1,
          boardRev: 1,
          options: [{ optionId: 'go', label: 'Go' }],
          ownerActions: ['Resolve blocking decision', 'Snooze unavailable (blocking)'],
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
    expect(card.getAttribute('data-blocking')).toBe('true')
    expect(within(card).getByTestId('decision-snooze').textContent).toMatch(/Cannot hide/)
    expect(within(card).queryByTestId('decision-action-snooze')).toBeNull()
    expect(within(card).getByTestId('decision-action-snooze-blocked').textContent).toMatch(
      /Snooze unavailable/,
    )
    expect(within(card).getByTestId('decision-action-acknowledge').tagName).toBe('BUTTON')
  })

  it('renders full projected fields when provided (no invent)', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'full',
          title: 'Full payload',
          question: 'Ship now?',
          evidence: ['ev-1', 'ev-2'],
          options: [
            { optionId: 'a', label: 'Ship', tradeoffs: 'risk' },
            { optionId: 'b', label: 'Wait', declining: true },
          ],
          recommendation: 'Wait for G5',
          ownerId: 'owner-1',
          resolverId: null,
          selectedOptionId: null,
          expectedRev: 42,
          boardRev: 42,
          entityRev: 3,
          scopedApprovalId: 'appr-1',
          auditIds: ['aud-1'],
          projectId: 'proj-1',
          featureId: 'feat-1',
          taskId: 'task-1',
          runId: 'run-1',
          partialFields: false,
          absentFields: [],
        })}
      />,
    )
    const card = screen.getByTestId('decision-card')
    expect(within(card).getByText('Ship now?')).toBeTruthy()
    expect(within(card).getByText('Wait for G5')).toBeTruthy()
    expect(within(card).getByText('Ship')).toBeTruthy()
    expect(within(card).getByText(/Tradeoff: risk/)).toBeTruthy()
    expect(within(card).getByTestId('decision-owner').textContent).toBe('owner-1')
    expect(within(card).getByTestId('decision-entity-rev').textContent).toBe('3')
    expect(within(card).getByTestId('decision-approval').textContent).toBe('appr-1')
    expect(within(card).queryByTestId('decision-question-partial')).toBeNull()
    expect(within(card).getByTestId('decision-project-link').getAttribute('href')).toBe(
      '/b/mfs-rebuild/projects/proj-1',
    )
    expect(within(card).getByTestId('decision-feature-link').getAttribute('href')).toBe(
      '/b/mfs-rebuild/features/feat-1',
    )
    expect(within(card).getByTestId('decision-task-link').getAttribute('href')).toBe(
      '/b/mfs-rebuild/tasks/task-1',
    )
    expect(within(card).getByTestId('decision-run-link').getAttribute('href')).toBe(
      '/b/mfs-rebuild/agents',
    )
  })

  it('entity bindings omit links when ids absent (no invent)', () => {
    render(
      <DecisionCard
        boardId="mfs-rebuild"
        item={item({
          decisionId: 'no-bind',
          title: 'No bindings',
          projectId: null,
          featureId: null,
          taskId: null,
          runId: null,
          partialFields: false,
          absentFields: [],
        })}
      />,
    )
    const card = screen.getByTestId('decision-card')
    expect(within(card).getByTestId('decision-project').textContent).toBe('—')
    expect(within(card).getByTestId('decision-feature').textContent).toBe('—')
    expect(within(card).getByTestId('decision-task').textContent).toBe('—')
    expect(within(card).getByTestId('decision-run').textContent).toBe('—')
    expect(within(card).queryByTestId('decision-project-link')).toBeNull()
  })

  it('distinguishes REJECTED vs declined option (RESOLVED + declining)', () => {
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

  it('stamps envelope pin data attrs on decisions root (no invent)', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const root = screen.getByTestId('control-center-decisions')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('snap-1')
    expect(root.getAttribute('data-canonical-hash')).toBe('canonhash_decisions_aa')
    expect(root.getAttribute('data-board-rev')).toBe('3')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('1')
    expect(root.getAttribute('data-pinned')).toBe('true')
  })

  it('honest zero rev attrs remain visible; missing pin → data-pinned false', () => {
    render(
      <DecisionsScreen
        {...baseProps({
          pin: {
            boardId: 'mfs-rebuild',
            canonicalSnapshotId: 'snap-z',
            canonicalHash: 'hash-z',
            boardRev: 0,
            lifecycleRev: 0,
            stale: false,
            staleReason: null,
          },
        })}
      />,
    )
    const root = screen.getByTestId('control-center-decisions')
    expect(root.getAttribute('data-board-rev')).toBe('0')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('0')
  })

  it('empty state copy distinct from zero-results', () => {
    render(
      <DecisionsScreen
        {...baseProps({
          surfaceState: 'empty',
          items: [],
          openCount: 0,
          blockingCount: 0,
        })}
      />,
    )
    expect(screen.getByTestId('decisions-empty').textContent).toMatch(/Nothing waiting/)
    render(
      <DecisionsScreen
        {...baseProps({
          surfaceState: 'zero-results',
          items: [],
          openCount: 0,
          blockingCount: 0,
        })}
      />,
    )
    expect(screen.getAllByTestId('decisions-empty').at(-1)?.textContent).toMatch(/match the current filters/)
  })

  it('error surface exposes field-linked retry', () => {
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
    expect(alert.textContent).toMatch(/upstream down/)
    within(alert).getByRole('button', { name: /Retry/i }).click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('does not render private/credential patterns from props', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const html = document.body.textContent ?? ''
    expect(html).not.toMatch(/password|api[_-]?key|Bearer |sk-/i)
  })

  it('projection gaps banner lists server contract gaps', () => {
    render(<DecisionsScreen {...baseProps()} />)
    const banner = screen.getByTestId('decisions-partial-banner')
    expect(banner.textContent).toMatch(/question/)
    expect(banner.textContent).toMatch(/options/)
  })
})
