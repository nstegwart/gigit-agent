/**
 * C3-F4 Priority components — prop-driven render + fail-closed display contracts.
 * LOCAL ONLY support evidence (jsdom). Does not claim visual DONE.
 */
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from '@testing-library/react'
import { act } from 'react'
import { hydrateRoot } from 'react-dom/client'
import { renderToString } from 'react-dom/server'
import { afterEach, describe, expect, it, vi } from 'vitest'

import {
  NON_PRIORITY_REASON_ALLOWLIST,
  NonPriorityReasonsPanel,
  PriorityCapacityPanel,
  PriorityDenominatorsPanel,
  PriorityG5Panel,
  PriorityMembershipPanel,
  PriorityReadinessPanel,
  PriorityScreen,
  filterAllowlistedReasons,
  formatCapacityShare,
  formatMajorityAllocationPass,
  formatReadinessPercent,
  isAllowlistedNonPriorityReason,
  PRIORITY_PORTFOLIO_ID,
} from '#/components/control-center/priority'
import type {
  PriorityCapacityProps,
  PriorityG5Props,
  PriorityMembershipProps,
  PriorityReadinessProps,
  PriorityRollupDenominatorsProps,
  PriorityScreenProps,
} from '#/components/control-center/priority'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'

afterEach(() => {
  cleanup()
})

const baseMembership: PriorityMembershipProps = {
  portfolioId: PRIORITY_PORTFOLIO_ID,
  membershipDenominator: 2,
  membershipTaskIds: ['task-a', 'task-b'],
  receiptValid: true,
  excludedInvalidReceiptCount: 1,
  excludedNonProductCount: 3,
}

const baseDenominators: PriorityRollupDenominatorsProps = {
  productDenominator: 10,
  trackedWorkDenominator: 40,
  stageProdReady: 4,
  prodReadyWithEvidence: 3,
  unclassifiedCount: 0,
  productTaskIds: ['p1', 'p2'],
  trackedTaskIds: ['t1', 't2', 't3'],
}

const emptyProductDenominators: PriorityRollupDenominatorsProps = {
  productDenominator: 0,
  trackedWorkDenominator: 5,
  stageProdReady: 0,
  prodReadyWithEvidence: 0,
  unclassifiedCount: 0,
}

const baseReadiness: PriorityReadinessProps = {
  boardReadinessPercent: 72.5,
  rawTaskReadinessPercent: 80.0,
  complete: false,
  cappedBy: 'G5',
  g5Pass: false,
  taskReadinessPolicyVersion: 'MFS_DELIVERY_READINESS_V1',
  boardReadinessPolicyVersion: 'MFS_BOARD_READINESS_G5_CAP_V1',
}

const baseCapacityPass: PriorityCapacityProps = {
  portfolioId: PRIORITY_PORTFOLIO_ID,
  priorityClosureCapacity: 6,
  allClosureCapacity: 10,
  priorityCapacityShare: 0.6,
  majorityAllocationPass: true,
  frontierState: 'PRIORITY_FRONTIER_ACTIVE',
  reason: null,
}

function makeG5(pass = false): PriorityG5Props {
  return {
    g5Pass: pass,
    domains: G5_REQUIRED_DOMAINS.map((domainId) => ({
      domainId,
      status: pass ? ('PASS' as const) : ('NOT_STARTED' as const),
      pass,
      reason: pass ? null : 'pending',
      evidenceReceiptIds: pass ? [`ev-${domainId}`] : [],
    })),
    missingDomains: [],
  }
}

function populatedScreen(
  overrides: Partial<PriorityScreenProps> = {},
): PriorityScreenProps {
  return {
    uiState: 'populated',
    pin: {
      boardId: 'mfs-rebuild',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'hash-aaaa',
      boardRev: 12,
      lifecycleRev: 4,
      stale: false,
    },
    membership: baseMembership,
    denominators: baseDenominators,
    readiness: baseReadiness,
    g5: makeG5(false),
    capacity: baseCapacityPass,
    nonPriorityReasons: {
      items: [
        {
          reason: 'STRICT_DIRECT_DEPENDENCY',
          taskId: 'out-1',
          proof: 'dep:out-1→mem-a',
        },
      ],
    },
    ...overrides,
  }
}

describe('display helpers — fail-closed N-A (AC-PRIORITY-02)', () => {
  it('majority: true→PASS, false→FAIL, null→N-A (never invents PASS)', () => {
    expect(formatMajorityAllocationPass(true)).toBe('PASS')
    expect(formatMajorityAllocationPass(false)).toBe('FAIL')
    expect(formatMajorityAllocationPass(null)).toBe('N-A')
    expect(formatMajorityAllocationPass(undefined)).toBe('N-A')
  })

  it('share and readiness null → N-A, never 100', () => {
    expect(formatCapacityShare(null)).toBe('N-A')
    expect(formatCapacityShare(0.5)).toBe('0.5000')
    expect(formatReadinessPercent(null)).toBe('N-A')
    expect(formatReadinessPercent(99.0)).toBe('99.0')
  })

  it('non-priority allowlist is exact four codes', () => {
    expect(NON_PRIORITY_REASON_ALLOWLIST).toEqual([
      'STRICT_DIRECT_DEPENDENCY',
      'NON_DELAYING_SPARE_CAPACITY',
      'PRIORITY_FRONTIER_BLOCKED',
      'PRIORITY_FRONTIER_EXHAUSTED',
    ])
    expect(isAllowlistedNonPriorityReason('STRICT_DIRECT_DEPENDENCY')).toBe(
      true,
    )
    expect(isAllowlistedNonPriorityReason('JUST_BECAUSE')).toBe(false)
    const { allowed, rejected } = filterAllowlistedReasons([
      { reason: 'NON_DELAYING_SPARE_CAPACITY' },
      { reason: 'OWNER_WHIM' },
    ])
    expect(allowed).toHaveLength(1)
    expect(rejected).toHaveLength(1)
  })
})

describe('PriorityMembershipPanel', () => {
  it('renders receipt-valid membership denominator and task ids', () => {
    render(<PriorityMembershipPanel {...baseMembership} />)
    expect(screen.getByTestId('priority-portfolio-id').textContent).toBe(
      'SALES_WEB_RELATED_BACKEND',
    )
    expect(
      screen.getByTestId('priority-membership-denominator').textContent,
    ).toBe('2')
    expect(
      screen.getByTestId('priority-membership-receipt-valid').textContent,
    ).toMatch(/Valid/)
    const ids = within(
      screen.getByTestId('priority-membership-ids'),
    ).getAllByRole('listitem')
    expect(ids.map((li) => li.textContent)).toEqual(['task-a', 'task-b'])
  })

  it('empty membership never implies success copy as PASS', () => {
    render(
      <PriorityMembershipPanel
        portfolioId={PRIORITY_PORTFOLIO_ID}
        membershipDenominator={0}
        membershipTaskIds={[]}
        receiptValid={true}
      />,
    )
    expect(screen.getByTestId('priority-membership-empty').textContent).toMatch(
      /never implies majority PASS/,
    )
  })
})

describe('PriorityDenominatorsPanel + readiness empty product scope', () => {
  it('shows DISTINCT product/tracked denominators', () => {
    render(<PriorityDenominatorsPanel {...baseDenominators} />)
    expect(screen.getByTestId('priority-product-denominator').textContent).toBe(
      '10',
    )
    expect(screen.getByTestId('priority-tracked-denominator').textContent).toBe(
      '40',
    )
    expect(screen.getByTestId('priority-stage-prod-ready').textContent).toBe(
      '4',
    )
    expect(screen.getByTestId('priority-prod-ready-evidence').textContent).toBe(
      '3',
    )
  })

  it('productDenominator=0 warns and readiness null/complete false stay non-PASS', () => {
    render(<PriorityDenominatorsPanel {...emptyProductDenominators} />)
    expect(screen.getByTestId('priority-empty-product-scope')).toBeTruthy()
    expect(
      screen
        .getByTestId('priority-denominators')
        .getAttribute('data-empty-product'),
    ).toBe('true')

    render(
      <PriorityReadinessPanel
        boardReadinessPercent={null}
        rawTaskReadinessPercent={null}
        complete={false}
        cappedBy="EMPTY_PRODUCT_SCOPE"
        g5Pass={false}
      />,
    )
    expect(screen.getByTestId('priority-board-readiness').textContent).toBe(
      'N-A',
    )
    expect(screen.getByTestId('priority-complete').textContent).toMatch(/false/)
    expect(screen.getByTestId('priority-capped-by').textContent).toBe(
      'EMPTY_PRODUCT_SCOPE',
    )
    // Never renders 100
    expect(screen.getByTestId('priority-board-readiness').textContent).not.toBe(
      '100.0',
    )
    expect(screen.getByTestId('priority-board-readiness').textContent).not.toBe(
      '100',
    )
  })

  it('serializes and hydrates valid empty-product disclosure markup without losing content', async () => {
    const view = <PriorityDenominatorsPanel {...emptyProductDenominators} />
    const serverHtml = renderToString(view)

    // A <p> may not contain interactive flow content. Assert the serialized SSR tree itself,
    // before a browser parser can silently repair invalid markup and hide the hydration defect.
    expect(serverHtml).not.toMatch(/<p\b(?:(?!<\/p>).)*<(?:details|summary)\b/s)
    expect(serverHtml).toContain('role="status"')
    expect(serverHtml).toContain('Detail teknis')
    expect(serverHtml).toContain('productDenominator=0')

    const host = document.createElement('div')
    host.innerHTML = serverHtml
    document.body.appendChild(host)
    const consoleErrors: string[] = []
    const consoleError = vi
      .spyOn(console, 'error')
      .mockImplementation((...args: unknown[]) => {
        consoleErrors.push(args.map(String).join(' '))
      })
    let root: ReturnType<typeof hydrateRoot> | undefined

    try {
      await act(async () => {
        root = hydrateRoot(host, view)
        await Promise.resolve()
      })

      const warning = host.querySelector<HTMLElement>(
        '[data-testid="priority-empty-product-scope"]',
      )
      expect(warning?.tagName).toBe('DIV')
      expect(warning?.querySelector('p details, p summary')).toBeNull()
      expect(warning?.textContent).toContain(
        'Belum ada tugas produk pada cakupan ini, jadi kesiapan belum dapat dihitung',
      )
      expect(warning?.textContent).toContain(
        'tidak pernah dibulatkan menjadi 100%',
      )
      expect(warning?.textContent).toContain(
        'productDenominator=0 — readiness must stay null / N-A; complete must stay false',
      )

      const disclosure = warning?.querySelector<HTMLDetailsElement>('details')
      const summary = disclosure?.querySelector<HTMLElement>('summary')
      expect(summary?.textContent).toBe('Detail teknis')
      expect(summary?.tabIndex).toBe(0)
      expect(disclosure?.open).toBe(false)
      fireEvent.click(summary!)
      expect(disclosure?.open).toBe(true)
      expect(consoleErrors.join('\n')).not.toMatch(
        /hydration|cannot be a descendant|cannot contain a nested/i,
      )
    } finally {
      if (root) {
        await act(async () => {
          root?.unmount()
        })
      }
      consoleError.mockRestore()
      host.remove()
    }
  })
})

describe('PriorityCapacityPanel — AC-PRIORITY-02 display', () => {
  it('majority PASS only when server majorityAllocationPass=true', () => {
    render(<PriorityCapacityPanel {...baseCapacityPass} />)
    const el = screen.getByTestId('priority-majority-pass')
    expect(el.textContent).toMatch(/PASS/)
    expect(el.getAttribute('data-majority-raw')).toBe('true')
    expect(screen.getByTestId('priority-capacity-share').textContent).toBe(
      '0.6000',
    )
  })

  it('zero allClosureCapacity → majority FAIL (false), share N-A — not PASS', () => {
    render(
      <PriorityCapacityPanel
        portfolioId={PRIORITY_PORTFOLIO_ID}
        priorityClosureCapacity={0}
        allClosureCapacity={0}
        priorityCapacityShare={null}
        majorityAllocationPass={false}
        frontierState="PRIORITY_FRONTIER_ACTIVE"
        reason="ZERO_SCHEDULABLE_CAPACITY"
      />,
    )
    const el = screen.getByTestId('priority-majority-pass')
    expect(el.textContent).toMatch(/FAIL/)
    expect(el.textContent).not.toMatch(/PASS/)
    expect(el.getAttribute('data-majority-raw')).toBe('false')
    expect(screen.getByTestId('priority-capacity-share').textContent).toBe(
      'N-A',
    )
    expect(screen.getByTestId('priority-capacity-reason').textContent).toBe(
      'ZERO SCHEDULABLE CAPACITY',
    )
    expect(
      screen
        .getByTestId('priority-capacity-reason')
        .getAttribute('data-reason-raw'),
    ).toBe('ZERO_SCHEDULABLE_CAPACITY')
    expect(screen.getByTestId('priority-fail-closed-notice')).toBeTruthy()
  })

  it('empty frontier → majority N-A (null), never PASS', () => {
    render(
      <PriorityCapacityPanel
        portfolioId={PRIORITY_PORTFOLIO_ID}
        priorityClosureCapacity={0}
        allClosureCapacity={0}
        priorityCapacityShare={null}
        majorityAllocationPass={null}
        frontierState="PRIORITY_FRONTIER_EMPTY"
        reason="PRIORITY_FRONTIER_EMPTY"
      />,
    )
    const el = screen.getByTestId('priority-majority-pass')
    expect(el.textContent).toMatch(/N-A/)
    expect(el.textContent).not.toMatch(/PASS/)
    expect(el.getAttribute('data-majority-raw')).toBe('null')
    expect(screen.getByTestId('priority-frontier-state').textContent).toBe(
      'PRIORITY FRONTIER EMPTY',
    )
    expect(
      screen
        .getByTestId('priority-frontier-state')
        .getAttribute('data-frontier-raw'),
    ).toBe('PRIORITY_FRONTIER_EMPTY')
  })

  it('share 0.5 with majority false does not display PASS', () => {
    render(
      <PriorityCapacityPanel
        portfolioId={PRIORITY_PORTFOLIO_ID}
        priorityClosureCapacity={5}
        allClosureCapacity={10}
        priorityCapacityShare={0.5}
        majorityAllocationPass={false}
        frontierState="PRIORITY_FRONTIER_ACTIVE"
        reason={null}
      />,
    )
    expect(screen.getByTestId('priority-majority-pass').textContent).toMatch(
      /FAIL/,
    )
    expect(screen.getByTestId('priority-capacity-share').textContent).toBe(
      '0.5000',
    )
  })
})

describe('PriorityG5Panel — nine domains', () => {
  it('renders exactly nine required G5 domains', () => {
    render(<PriorityG5Panel {...makeG5(false)} />)
    expect(screen.getByTestId('priority-g5-pass').textContent).toMatch(/false/)
    for (const id of G5_REQUIRED_DOMAINS) {
      expect(screen.getByTestId(`priority-g5-row-${id}`)).toBeTruthy()
      expect(screen.getByTestId(`priority-g5-card-${id}`)).toBeTruthy()
    }
    const rows = screen
      .getByTestId('priority-g5-table')
      .querySelectorAll('tbody tr')
    expect(rows.length).toBe(9)
  })

  it('G5 scroll region is named and focusable', () => {
    render(<PriorityG5Panel {...makeG5(false)} />)
    const region = screen.getByTestId('priority-g5-scroll')
    expect(region.getAttribute('role')).toBe('region')
    expect(region.getAttribute('aria-label')).toMatch(/G5 domain matrix/i)
    expect(region.getAttribute('tabindex')).toBe('0')
  })

  it('does not flip g5Pass client-side when domains are mixed', () => {
    const domains = G5_REQUIRED_DOMAINS.map(
      (domainId, i): PriorityG5Props['domains'][number] => ({
        domainId,
        status: i === 0 ? 'PASS' : 'FAIL',
        pass: i === 0,
        reason: i === 0 ? null : 'blocked',
        evidenceReceiptIds: [],
      }),
    )
    // Server says false even if one domain "looks" pass — UI must honor server g5Pass
    render(<PriorityG5Panel g5Pass={false} domains={domains} />)
    expect(screen.getByTestId('priority-g5').getAttribute('data-g5-pass')).toBe(
      'false',
    )
    expect(screen.getByTestId('priority-g5-pass').textContent).toMatch(/false/)
  })
})

describe('NonPriorityReasonsPanel — allowlist + proof', () => {
  it('shows allowlisted reasons with proof', () => {
    render(
      <NonPriorityReasonsPanel
        items={[
          {
            reason: 'PRIORITY_FRONTIER_BLOCKED',
            taskId: 'x1',
            proof: 'frontier-blocked-rcpt-9',
          },
          {
            reason: 'NOT_A_REAL_REASON',
            taskId: 'x2',
            proof: 'should-hide',
          },
        ]}
      />,
    )
    const items = screen.getAllByTestId('priority-non-priority-item')
    expect(items).toHaveLength(1)
    expect(items[0].getAttribute('data-reason')).toBe(
      'PRIORITY_FRONTIER_BLOCKED',
    )
    expect(screen.getByTestId('priority-reason-proof').textContent).toBe(
      'frontier-blocked-rcpt-9',
    )
    expect(
      screen.getByTestId('priority-non-priority-rejected').textContent,
    ).toMatch(/outside allowlist/)
  })

  it('flags missing proof on allowlisted reason', () => {
    render(
      <NonPriorityReasonsPanel
        items={[{ reason: 'NON_DELAYING_SPARE_CAPACITY', taskId: 'spare-1' }]}
      />,
    )
    expect(screen.getByTestId('priority-reason-missing-proof')).toBeTruthy()
  })
})

describe('PriorityScreen — UI states + composition', () => {
  it('populated composes all panels with pin revs', () => {
    render(<PriorityScreen {...populatedScreen()} />)
    expect(
      screen.getByTestId('priority-screen').getAttribute('data-ui-state'),
    ).toBe('populated')
    expect(screen.getByTestId('priority-body')).toBeTruthy()
    expect(screen.getByTestId('priority-membership')).toBeTruthy()
    expect(screen.getByTestId('priority-denominators')).toBeTruthy()
    expect(screen.getByTestId('priority-readiness')).toBeTruthy()
    expect(screen.getByTestId('priority-capacity')).toBeTruthy()
    expect(screen.getByTestId('priority-g5')).toBeTruthy()
    expect(screen.getByTestId('priority-non-priority-reasons')).toBeTruthy()
    expect(screen.getByTestId('priority-board-rev').textContent).toBe('12')
    expect(screen.getByTestId('priority-lifecycle-rev').textContent).toBe('4')
  })

  it('loading shows skeleton and no fake numbers', () => {
    render(<PriorityScreen uiState="loading" membership={baseMembership} />)
    expect(screen.getByTestId('priority-skeleton')).toBeTruthy()
    expect(screen.queryByTestId('priority-membership-denominator')).toBeNull()
    expect(screen.queryByTestId('priority-body')).toBeNull()
  })

  it('empty / zero-results / forbidden / disconnected surfaces', () => {
    for (const state of ['empty', 'zero-results', 'forbidden'] as const) {
      cleanup()
      render(<PriorityScreen uiState={state} />)
      expect(
        screen.getByTestId('priority-screen').getAttribute('data-ui-state'),
      ).toBe(state)
      expect(screen.getByTestId(`priority-state-${state}`)).toBeTruthy()
      expect(screen.queryByTestId('priority-body')).toBeNull()
    }
    cleanup()
    render(<PriorityScreen uiState="disconnected" errorCode="TRANSPORT_DOWN" />)
    expect(screen.getByTestId('priority-error-code').textContent).toBe(
      'TRANSPORT_DOWN',
    )
  })

  it('error retry invokes handler', () => {
    const onRetry = vi.fn()
    render(
      <PriorityScreen
        uiState="error"
        errorCode="E_PRIORITY"
        errorMessage="boom"
        onRetry={onRetry}
      />,
    )
    fireEvent.click(screen.getByTestId('priority-retry'))
    expect(onRetry).toHaveBeenCalledTimes(1)
  })

  it('stale shows banner + body with stale reason', () => {
    render(
      <PriorityScreen
        {...populatedScreen({
          uiState: 'stale',
          pin: {
            boardId: 'mfs-rebuild',
            canonicalSnapshotId: 'snap-1',
            canonicalHash: 'h',
            boardRev: 1,
            lifecycleRev: 1,
            stale: true,
            staleReason: 'freshnessAgeSeconds>threshold',
          },
        })}
      />,
    )
    expect(screen.getByTestId('priority-state-banner')).toBeTruthy()
    expect(screen.getByTestId('priority-stale-reason').textContent).toBe(
      'freshnessAgeSeconds>threshold',
    )
    expect(screen.getByTestId('priority-body')).toBeTruthy()
  })

  it('partial still renders available sections', () => {
    render(
      <PriorityScreen
        uiState="partial"
        errorMessage="G5 section failed"
        membership={baseMembership}
        capacity={{
          ...baseCapacityPass,
          majorityAllocationPass: null,
          priorityCapacityShare: null,
          frontierState: 'PRIORITY_FRONTIER_EMPTY',
          reason: 'PRIORITY_FRONTIER_EMPTY',
        }}
      />,
    )
    expect(screen.getByTestId('priority-membership')).toBeTruthy()
    expect(screen.getByTestId('priority-majority-pass').textContent).toMatch(
      /N-A/,
    )
  })

  it('needs-human banner does not hide capacity truth', () => {
    render(<PriorityScreen {...populatedScreen({ uiState: 'needs-human' })} />)
    expect(screen.getByTestId('priority-state-banner').textContent).toMatch(
      /human/i,
    )
    expect(screen.getByTestId('priority-capacity')).toBeTruthy()
  })
})

describe('no client invent of PASS from empty props', () => {
  it('screen with empty membership + null majority never shows PASS in majority field', () => {
    render(
      <PriorityScreen
        uiState="populated"
        membership={{
          portfolioId: PRIORITY_PORTFOLIO_ID,
          membershipDenominator: 0,
          membershipTaskIds: [],
          receiptValid: true,
        }}
        capacity={{
          portfolioId: PRIORITY_PORTFOLIO_ID,
          priorityClosureCapacity: 0,
          allClosureCapacity: 0,
          priorityCapacityShare: null,
          majorityAllocationPass: null,
          frontierState: 'PRIORITY_FRONTIER_EMPTY',
          reason: 'PRIORITY_FRONTIER_EMPTY',
        }}
        denominators={{
          productDenominator: 0,
          trackedWorkDenominator: 0,
          stageProdReady: 0,
          prodReadyWithEvidence: 0,
          unclassifiedCount: 0,
        }}
        readiness={{
          boardReadinessPercent: null,
          rawTaskReadinessPercent: null,
          complete: false,
          cappedBy: 'EMPTY_PRODUCT_SCOPE',
          g5Pass: false,
        }}
      />,
    )
    expect(
      screen.getByTestId('priority-majority-pass').textContent,
    ).toBeTruthy()
    expect(
      screen.getByTestId('priority-majority-pass').textContent,
    ).not.toMatch(/PASS/)
    expect(screen.getByTestId('priority-board-readiness').textContent).toBe(
      'N-A',
    )
    expect(screen.getByTestId('priority-complete').textContent).toMatch(/false/)
  })
})
