/**
 * C3-F2 Overview components — real RTL render of markup + accessibility contract.
 * Support evidence only (LOCAL ONLY); no route/AppShell/styles.css/query coverage.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within, fireEvent } from '@testing-library/react'
import {
  Overview,
  PRIMARY_BUCKETS,
  NeedsYourDecision,
  OngoingZeroClick,
  BucketStrip,
} from '#/components/control-center/overview'
import type {
  OverviewProps,
  OverviewOngoingItem,
  OverviewBucketStrip,
  OverviewDecisionSection,
} from '#/components/control-center/overview'

function attr(el: Element, name: string): string | null {
  return el.getAttribute(name)
}

function baseBuckets(
  overrides: Partial<OverviewBucketStrip> = {},
): OverviewBucketStrip {
  return {
    counts: {
      DONE: 3,
      RECONCILIATION_PENDING: 1,
      ONGOING: 2,
      NEXT: 1,
      QUEUED: 4,
      BLOCKED: 2,
    },
    staleCount: 2,
    activeBucket: 'ONGOING',
    staleActive: false,
    ...overrides,
  }
}

function ongoingItem(
  partial: Partial<OverviewOngoingItem> &
    Pick<OverviewOngoingItem, 'taskId' | 'title' | 'productiveState'>,
): OverviewOngoingItem {
  return {
    targetGate: 'FUNCTIONAL',
    agentId: 'agent-1',
    role: 'IMPLEMENTER',
    model: 'grok-4.5',
    effort: 'high',
    maskedAccount: 'grok••••9a',
    startedAge: '12m',
    heartbeatAge: '8s',
    materialProgressAge: '3m',
    evidenceLabel: 'receipt/sha',
    evidenceHref: '/b/mfs/evidence/r1',
    ...partial,
  }
}

function decisionSection(
  overrides: Partial<OverviewDecisionSection> = {},
): OverviewDecisionSection {
  return {
    count: 2,
    topSeverity: 'CRITICAL',
    topItem: {
      decisionId: 'dec-1',
      title: 'Approve capacity floor',
      question: 'Raise Grok floor to 60?',
      severity: 'CRITICAL',
      blocking: true,
      ownerAction: 'Choose option A or B; blocking decisions cannot be snoozed.',
      options: [
        { optionId: 'a', label: 'Approve raise' },
        { optionId: 'b', label: 'Keep current' },
      ],
    },
    ...overrides,
  }
}

function populatedProps(overrides: Partial<OverviewProps> = {}): OverviewProps {
  return {
    surfaceState: 'populated',
    appSummary: {
      boardId: 'mfs-rebuild',
      boardLabel: 'MFS Rebuild',
      liveStage: 'INTEGRATED',
      freshnessLabel: '4s ago',
      freshnessAgeSeconds: 4,
      connection: 'live',
      boardRev: 12,
      lifecycleRev: 8,
    },
    decision: decisionSection(),
    priority: {
      portfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipDenominator: 10,
      productDenominator: 40,
      stageProdReady: 2,
      prodReadyWithEvidence: 1,
      g5Pass: false,
      complete: false,
      priorityCapacityShare: 0.62,
      majorityAllocationPass: true,
      frontierState: 'PRIORITY_FRONTIER_ACTIVE',
      capacityShareDisplay: '0.62',
      majorityDisplay: 'PASS',
      dispatchReason: 'Priority frontier active',
      blockers: ['Waiting on domain security'],
    },
    global: {
      trackedWorkDenominator: 13,
      productDenominator: 40,
      stageProdReady: 2,
      prodReadyWithEvidence: 1,
      g5Pass: false,
      complete: false,
      boardReadinessPercent: 45,
      cappedBy: 'G5',
    },
    buckets: baseBuckets(),
    ongoing: [
      ongoingItem({
        taskId: 't-stalled',
        title: 'Stalled worker',
        productiveState: 'STALLED',
        materialProgressAge: '2h',
      }),
      ongoingItem({
        taskId: 't-prod',
        title: 'Active implementer',
        productiveState: 'PRODUCTIVE',
        materialProgressAge: '1m',
      }),
      ongoingItem({
        taskId: 't-idle',
        title: 'Idle runner',
        productiveState: 'IDLE',
        evidenceHref: null,
        evidenceLabel: 'no evidence yet',
      }),
    ],
    lower: {
      projects: [{ projectId: 'p1', name: 'sales-rebuild', statusLabel: 'active' }],
      lifecycle: [
        { stage: 'BUILT', count: 4 },
        { stage: 'FUNCTIONAL', count: 2 },
      ],
      g5: {
        g5Pass: false,
        domains: [
          { domainId: 'security', label: 'security', status: 'IN_PROGRESS', pass: false },
          { domainId: 'backup_dr', label: 'backup/DR', status: 'PASS', pass: true },
        ],
      },
      decisionCount: 2,
      materialEvents: [
        {
          eventId: 'e1',
          atLabel: '12:01',
          kind: 'HEARTBEAT',
          summary: 'run r1 material',
          actor: 'agent-1',
        },
      ],
    },
    liveMessage: 'Overview updated',
    ...overrides,
  }
}

describe('control-center overview components', () => {
  it('renders populated mission surfaces in mobile/desktop contract order', () => {
    const { container } = render(<Overview {...populatedProps()} />)
    const root = screen.getByTestId('control-center-overview')
    expect(attr(root, 'data-surface-state')).toBe('populated')
    expect(attr(root, 'data-needs-human')).toBe('true')

    const order = [
      'overview-app-summary',
      'overview-decision-card',
      'overview-priority',
      'overview-global',
      'overview-buckets',
      'overview-ongoing',
      'overview-lower',
    ]
    const positions = order.map((id) => {
      const el = screen.getByTestId(id)
      return Array.from(container.querySelectorAll('[data-testid]')).indexOf(el)
    })
    for (let i = 1; i < positions.length; i++) {
      expect(positions[i]).toBeGreaterThan(positions[i - 1])
    }
  })

  it('exposes six exclusive primary buckets plus STALE overlay chip', () => {
    render(<Overview {...populatedProps()} />)
    const strip = screen.getByTestId('overview-buckets')
    for (const b of PRIMARY_BUCKETS) {
      expect(
        within(strip).getByRole('tab', { name: new RegExp(b.replaceAll('_', ' '), 'i') }),
      ).toBeTruthy()
    }
    const stale = within(strip).getByRole('tab', { name: /STALE/i })
    expect(attr(stale, 'data-overlay')).toBe('true')
    expect(attr(stale, 'data-bucket')).toBe('STALE')
    expect(within(strip).getAllByRole('tab')).toHaveLength(7)
  })

  it('zero-click ONGOING shows required fields with text+icon productive state', () => {
    render(<Overview {...populatedProps()} />)
    const cards = screen.getAllByTestId('overview-ongoing-card')
    expect(cards).toHaveLength(3)

    const stalled = cards.find((c) => c.getAttribute('data-task-id') === 't-stalled')!
    expect(within(stalled).getByText('Stalled worker')).toBeTruthy()
    expect(within(stalled).getByText('FUNCTIONAL')).toBeTruthy()
    expect(within(stalled).getByText('agent-1')).toBeTruthy()
    expect(within(stalled).getByText('IMPLEMENTER')).toBeTruthy()
    expect(within(stalled).getByText('grok-4.5')).toBeTruthy()
    expect(within(stalled).getByText(/effort high/)).toBeTruthy()
    expect(within(stalled).getByText('grok••••9a')).toBeTruthy()
    expect(stalled.querySelector('[data-field="started-age"]')?.textContent).toBe('12m')
    expect(stalled.querySelector('[data-field="heartbeat-age"]')?.textContent).toBe('8s')
    expect(stalled.querySelector('[data-field="material-age"]')?.textContent).toBe('2h')
    expect(within(stalled).getByRole('status', { name: /STALLED/i })).toBeTruthy()
    const link = within(stalled).getByRole('link', { name: /receipt/i })
    expect(attr(link, 'href')).toBe('/b/mfs/evidence/r1')

    const productive = cards.find((c) => c.getAttribute('data-task-id') === 't-prod')!
    expect(within(productive).getByRole('status', { name: /PRODUCTIVE/i })).toBeTruthy()
  })

  it('does not re-sort ONGOING — preserves server order', () => {
    const items = [
      ongoingItem({ taskId: 'z-last', title: 'Z', productiveState: 'PRODUCTIVE' }),
      ongoingItem({ taskId: 'a-first', title: 'A', productiveState: 'STALLED' }),
    ]
    render(<OngoingZeroClick items={items} />)
    const ids = screen
      .getAllByTestId('overview-ongoing-card')
      .map((el) => el.getAttribute('data-task-id'))
    expect(ids).toEqual(['z-last', 'a-first'])
  })

  it('Needs Your Decision sticky pill shows count, severity, expand (controlled)', () => {
    const onExpand = vi.fn()
    render(
      <NeedsYourDecision
        decision={decisionSection()}
        enableStickyPill
        pillCollapsed
        onPillExpand={onExpand}
      />,
    )
    const stack = screen.getByTestId('overview-decision-stack')
    expect(attr(stack, 'data-pill-collapsed')).toBe('true')
    expect(attr(stack, 'data-blocking')).toBe('true')
    const pill = screen.getByTestId('overview-decision-pill')
    expect(pill.textContent).toMatch(/2 decisions/i)
    expect(pill.textContent).toMatch(/CRITICAL/i)
    expect(screen.getByTestId('overview-decision-pill-count').textContent).toMatch(/2/)
    expect(screen.getByTestId('overview-decision-pill-severity').textContent).toMatch(/CRITICAL/)
    // Blocking card remains mounted while pill is collapsed (cannot be hidden).
    expect(screen.getByTestId('overview-decision-card')).toBeTruthy()
    const expand = within(pill).getByRole('button', { name: /Expand/i })
    expect(attr(expand, 'aria-expanded')).toBe('false')
    fireEvent.click(expand)
    expect(onExpand).toHaveBeenCalledTimes(1)
  })

  it('controlled sticky: IO collapse fires when card leaves scroll root; expand returns; empty preserved', () => {
    type IOCallback = IntersectionObserverCallback
    let ioCallback: IOCallback | null = null
    const observe = vi.fn()
    const disconnect = vi.fn()
    class MockIntersectionObserver {
      readonly root: Element | Document | null = null
      readonly rootMargin = ''
      readonly thresholds: ReadonlyArray<number> = []
      constructor(cb: IOCallback) {
        ioCallback = cb
      }
      observe = observe
      unobserve = vi.fn()
      disconnect = disconnect
      takeRecords = (): IntersectionObserverEntry[] => []
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    const onCollapse = vi.fn()
    const onExpand = vi.fn()
    const { rerender, unmount } = render(
      <NeedsYourDecision
        decision={decisionSection()}
        enableStickyPill
        pillCollapsed={false}
        onPillCollapse={onCollapse}
        onPillExpand={onExpand}
      />,
    )

    // Controlled mode must attach IO (regression: previously skipped when controlled).
    expect(observe).toHaveBeenCalledTimes(1)
    expect(ioCallback).toBeTypeOf('function')
    expect(screen.queryByTestId('overview-decision-pill')).toBeNull()
    expect(screen.getByTestId('overview-decision-card')).toBeTruthy()

    const leaveEntry = {
      isIntersecting: false,
      intersectionRatio: 0,
      target: screen.getByTestId('overview-decision-card'),
    } as unknown as IntersectionObserverEntry

    // Card leaves scroll root → parent collapse callback (route setPillCollapsed(true)).
    ioCallback!([leaveEntry], {} as IntersectionObserver)
    expect(onCollapse).toHaveBeenCalledTimes(1)
    expect(onExpand).not.toHaveBeenCalled()

    // Same leave edge must not double-fire parent setState.
    ioCallback!([leaveEntry], {} as IntersectionObserver)
    expect(onCollapse).toHaveBeenCalledTimes(1)

    // Parent applies controlled collapse → one-line sticky pill.
    rerender(
      <NeedsYourDecision
        decision={decisionSection()}
        enableStickyPill
        pillCollapsed
        onPillCollapse={onCollapse}
        onPillExpand={onExpand}
      />,
    )
    const pill = screen.getByTestId('overview-decision-pill')
    expect(attr(screen.getByTestId('overview-decision-stack'), 'data-pill-collapsed')).toBe(
      'true',
    )
    expect(screen.getByTestId('overview-decision-pill-count').textContent).toMatch(/2/)
    expect(screen.getByTestId('overview-decision-pill-severity').textContent).toMatch(/CRITICAL/)
    // Full card remains mounted (a11y + spacer); never strips content.
    expect(screen.getByTestId('overview-decision-card')).toBeTruthy()

    fireEvent.click(within(pill).getByRole('button', { name: /Expand/i }))
    expect(onExpand).toHaveBeenCalledTimes(1)

    // Parent expands → pill gone, card visible again.
    rerender(
      <NeedsYourDecision
        decision={decisionSection()}
        enableStickyPill
        pillCollapsed={false}
        onPillCollapse={onCollapse}
        onPillExpand={onExpand}
      />,
    )
    expect(screen.queryByTestId('overview-decision-pill')).toBeNull()
    expect(screen.getByTestId('overview-decision-card')).toBeTruthy()

    // Empty state still renders under controlled props.
    rerender(
      <NeedsYourDecision
        decision={null}
        enableStickyPill
        pillCollapsed={false}
        onPillCollapse={onCollapse}
        onPillExpand={onExpand}
      />,
    )
    expect(screen.getByTestId('overview-decision-empty')).toBeTruthy()
    expect(screen.queryByTestId('overview-decision-pill')).toBeNull()

    unmount()
    expect(disconnect).toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('controlled sticky: empty decision still skips pill and preserves empty state', () => {
    type IOCallback = IntersectionObserverCallback
    const observe = vi.fn()
    class MockIntersectionObserver {
      constructor(_cb: IOCallback) {}
      observe = observe
      unobserve = vi.fn()
      disconnect = vi.fn()
      takeRecords = (): IntersectionObserverEntry[] => []
    }
    vi.stubGlobal('IntersectionObserver', MockIntersectionObserver)

    render(
      <NeedsYourDecision
        decision={{ count: 0, topSeverity: 'LOW', topItem: null }}
        enableStickyPill
        pillCollapsed={false}
        onPillCollapse={vi.fn()}
        onPillExpand={vi.fn()}
      />,
    )
    expect(screen.getByTestId('overview-decision-empty')).toBeTruthy()
    expect(screen.queryByTestId('overview-decision-pill')).toBeNull()
    expect(screen.queryByTestId('overview-decision-card')).toBeNull()
    // No card element to observe when empty.
    expect(observe).not.toHaveBeenCalled()
    vi.unstubAllGlobals()
  })

  it('sticky pill CSS constrains to scrollport (no wider-ancestor bleed) and keeps Expand 44×44', () => {
    // Support evidence for C3-C9/C10 containment: module must bind max-width to viewport
    // on mobile and keep Expand min 44×44 (full visual proof is harness screenshots).
    const cssPath = path.join(
      process.cwd(),
      'src/components/control-center/overview/overview.module.css',
    )
    const css = fs.readFileSync(cssPath, 'utf8')
    expect(css).toMatch(/\.stickyPill\s*\{[^}]*max-width:\s*100%/s)
    expect(css).toMatch(/max-width:\s*min\(\s*100%\s*,\s*calc\(\s*100vw\s*-\s*24px\s*\)\s*\)/)
    expect(css).toMatch(/\.pillBtn\s*\{[^}]*min-height:\s*44px/s)
    expect(css).toMatch(/\.pillBtn\s*\{[^}]*min-width:\s*44px/s)
    expect(css).toMatch(/decisionStack\[data-pill-collapsed='true'\]/)
    // C3-C10 shelf/flow reservation: chrome + mission scroll split.
    expect(css).toMatch(/\.stickyChrome\s*\{/)
    expect(css).toMatch(/\.missionScroll\s*\{/)
    expect(css).toMatch(/\.rootShelf\s*\{/)
  })

  it('populated overview uses sticky chrome shelf + mission scroll host', () => {
    render(<Overview {...populatedProps({ pillCollapsed: true })} />)
    expect(screen.getByTestId('overview-sticky-chrome')).toBeTruthy()
    expect(screen.getByTestId('overview-mission-scroll')).toBeTruthy()
    expect(attr(screen.getByTestId('control-center-overview'), 'data-shelf-layout')).toBe(
      'true',
    )
    // Collapsed pill portals into chrome shelf (not under mission content).
    const chrome = screen.getByTestId('overview-sticky-chrome')
    expect(within(chrome).getByTestId('overview-decision-pill')).toBeTruthy()
    expect(within(chrome).getByTestId('overview-app-summary')).toBeTruthy()
  })

  it('collapsed sticky pill keeps full card in a11y tree (no aria-hidden on non-blocking)', () => {
    const section = decisionSection({
      topItem: {
        decisionId: 'dec-nb',
        title: 'Non-blocking call',
        question: 'Approve optional change?',
        severity: 'MEDIUM',
        blocking: false,
        ownerAction: 'Review when free',
        options: [{ optionId: 'ok', label: 'OK' }],
      },
      topSeverity: 'MEDIUM',
      count: 1,
    })
    render(
      <NeedsYourDecision decision={section} enableStickyPill pillCollapsed />,
    )
    const card = screen.getByTestId('overview-decision-card')
    expect(card.getAttribute('aria-hidden')).toBeNull()
    expect(card.getAttribute('data-blocking')).toBe('false')
    // Full name/description/action path remains readable.
    expect(within(card).getByText(/Non-blocking call/)).toBeTruthy()
    expect(within(card).getByText(/Approve optional change/)).toBeTruthy()
    expect(within(card).getByText(/Review when free/)).toBeTruthy()
    // Visual one-line pill still present.
    expect(screen.getByTestId('overview-decision-pill')).toBeTruthy()
  })

  it('decision card shows exact owner action and elevated blocking chrome', () => {
    render(<Overview {...populatedProps({ surfaceState: 'needs-human' })} />)
    const card = screen.getByTestId('overview-decision-card')
    expect(attr(card, 'data-blocking')).toBe('true')
    expect(within(card).getByText(/Exact owner action/i)).toBeTruthy()
    expect(
      within(card).getByText(/Choose option A or B; blocking decisions cannot be snoozed/),
    ).toBeTruthy()
  })

  it('PRIORITY card shows N-A majority semantics without inventing PASS', () => {
    render(
      <Overview
        {...populatedProps({
          priority: {
            portfolioId: 'SALES_WEB_RELATED_BACKEND',
            membershipDenominator: 0,
            productDenominator: 0,
            stageProdReady: 0,
            prodReadyWithEvidence: 0,
            g5Pass: false,
            complete: false,
            priorityCapacityShare: null,
            majorityAllocationPass: null,
            frontierState: 'PRIORITY_FRONTIER_EMPTY',
            capacityShareDisplay: 'N-A',
            majorityDisplay: 'N-A',
            dispatchReason: null,
          },
        })}
      />,
    )
    const pri = screen.getByTestId('overview-priority')
    expect(within(pri).getAllByText('N-A').length).toBeGreaterThanOrEqual(2)
    expect(pri.textContent).toMatch(/Capacity share[\s\S]*N-A/)
    expect(pri.textContent).toMatch(/Majority allocation[\s\S]*N-A/)
    expect(pri.textContent).not.toMatch(/Majority allocation[\s\S]*PASS/)
  })

  it('GLOBAL card shows denominators, PROD_READY evidence, G5, complete', () => {
    render(<Overview {...populatedProps()} />)
    const g = screen.getByTestId('overview-global')
    expect(g.textContent).toMatch(/Tracked denom/)
    expect(g.textContent).toMatch(/13/)
    expect(g.textContent).toMatch(/PROD_READY evidence/)
    expect(g.textContent).toMatch(/G5/)
    expect(g.textContent).toMatch(/FAIL/)
    expect(g.textContent).toMatch(/Complete/)
  })

  it('bucket selection callbacks fire without recomputing counts', () => {
    const onSelect = vi.fn()
    const onStale = vi.fn()
    render(
      <BucketStrip data={baseBuckets({ onSelectBucket: onSelect, onToggleStale: onStale })} />,
    )
    fireEvent.click(screen.getByRole('tab', { name: /BLOCKED/i }))
    expect(onSelect).toHaveBeenCalledWith('BLOCKED')
    fireEvent.click(screen.getByRole('tab', { name: /STALE/i }))
    expect(onStale).toHaveBeenCalled()
  })

  it('supports loading skeleton without fake numbers', () => {
    render(
      <Overview
        {...populatedProps({
          surfaceState: 'loading',
          decision: null,
          priority: null,
          global: null,
          buckets: null,
          ongoing: [],
          lower: null,
        })}
      />,
    )
    expect(screen.getByTestId('overview-skeleton')).toBeTruthy()
    const status = screen.getByRole('status')
    expect(attr(status, 'data-state')).toBe('loading')
    expect(screen.queryByTestId('overview-priority')).toBeNull()
  })

  it('supports empty decision copy distinct from zero-results', () => {
    const { unmount } = render(
      <Overview
        {...populatedProps({
          surfaceState: 'empty',
          decision: { count: 0, topSeverity: null, topItem: null },
          ongoing: [],
        })}
      />,
    )
    expect(screen.getByTestId('overview-decision-empty').textContent).toMatch(
      /No decisions waiting/,
    )
    unmount()

    render(
      <Overview
        {...populatedProps({
          surfaceState: 'zero-results',
          ongoing: [],
        })}
      />,
    )
    const status = document.querySelector('[data-state="zero-results"]')
    expect(status).toBeTruthy()
    expect(screen.getByText(/No ONGOING items match/i)).toBeTruthy()
  })

  it('supports partial, stale, disconnected, error, forbidden, retry', () => {
    const onRetry = vi.fn()
    const onReconnect = vi.fn()

    const { rerender } = render(
      <Overview
        {...populatedProps({
          surfaceState: 'partial',
          partialErrors: [{ code: 'G5_UNAVAILABLE', message: 'g5 timeout' }],
          onRetry,
        })}
      />,
    )
    expect(attr(screen.getByRole('alert'), 'data-state')).toBe('partial')
    expect(screen.getByText(/G5_UNAVAILABLE/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /Retry failed sections/i }))
    expect(onRetry).toHaveBeenCalled()

    rerender(
      <Overview
        {...populatedProps({
          surfaceState: 'stale',
          appSummary: {
            boardId: 'mfs-rebuild',
            liveStage: 'INTEGRATED',
            freshnessLabel: '10m ago',
            connection: 'stale',
            stale: true,
            staleReason: 'ACCOUNT_SYNC_STALE',
          },
          onRetry,
        })}
      />,
    )
    const staleBanner = document.querySelector('[data-state="stale"]')
    expect(staleBanner).toBeTruthy()
    expect(staleBanner?.textContent).toMatch(/ACCOUNT_SYNC_STALE/)

    rerender(
      <Overview
        {...populatedProps({
          surfaceState: 'disconnected',
          appSummary: {
            boardId: 'mfs-rebuild',
            liveStage: 'INTEGRATED',
            freshnessLabel: '—',
            connection: 'disconnected',
          },
          onReconnect,
        })}
      />,
    )
    expect(attr(screen.getByRole('alert'), 'data-state')).toBe('disconnected')
    fireEvent.click(screen.getByRole('button', { name: /Reconnect/i }))
    expect(onReconnect).toHaveBeenCalled()

    rerender(
      <Overview
        {...populatedProps({
          surfaceState: 'error',
          error: { code: 'DATA_INTEGRITY', message: 'bucket sum mismatch' },
          onRetry,
        })}
      />,
    )
    expect(attr(screen.getByRole('alert'), 'data-state')).toBe('error')
    expect(screen.getByText(/DATA_INTEGRITY/)).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /^Retry$/i }))
    expect(onRetry).toHaveBeenCalledTimes(2)

    rerender(
      <Overview
        {...populatedProps({
          surfaceState: 'forbidden',
          error: { code: 'AUTHORIZATION_REQUIRED', message: 'board:read missing' },
        })}
      />,
    )
    expect(attr(screen.getByRole('alert'), 'data-state')).toBe('forbidden')
    expect(screen.getByText(/AUTHORIZATION_REQUIRED/)).toBeTruthy()
  })

  it('coalesces live region messages and uses native headings/tabs', () => {
    render(<Overview {...populatedProps({ liveMessage: '3 ONGOING updated' })} />)
    const live = screen.getByTestId('overview-live')
    expect(attr(live, 'aria-live')).toBe('polite')
    expect(attr(live, 'aria-atomic')).toBe('true')
    expect(live.textContent).toBe('3 ONGOING updated')

    expect(screen.getByRole('heading', { name: /Needs Your Decision/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /PRIORITY/i })).toBeTruthy()
    expect(screen.getByRole('heading', { name: /^GLOBAL$/i })).toBeTruthy()
    expect(screen.getByRole('tablist', { name: /Primary work buckets/i })).toBeTruthy()
  })

  it('lower panels render projects, lifecycle, G5, decisions, material events', () => {
    render(<Overview {...populatedProps()} />)
    const lower = screen.getByTestId('overview-lower')
    expect(lower.querySelector('[data-panel="projects"]')?.textContent).toMatch(/sales-rebuild/)
    expect(lower.querySelector('[data-panel="lifecycle"]')?.textContent).toMatch(/BUILT/)
    expect(lower.querySelector('[data-panel="g5"]')?.textContent).toMatch(/security/)
    expect(lower.querySelector('[data-panel="decisions"]')?.textContent).toMatch(/2 open/)
    expect(lower.querySelector('[data-panel="material-events"]')?.textContent).toMatch(
      /HEARTBEAT/,
    )
  })

  it('44×44-ish targets: expand and bucket buttons are real buttons', () => {
    render(
      <Overview
        {...populatedProps({
          pillCollapsed: true,
          enableStickyPill: true,
        })}
      />,
    )
    const expand = screen.getByRole('button', { name: /Expand/i })
    expect(expand.tagName).toBe('BUTTON')
    const tab = screen.getByRole('tab', { name: /ONGOING/i })
    expect(tab.tagName).toBe('BUTTON')
  })
})
