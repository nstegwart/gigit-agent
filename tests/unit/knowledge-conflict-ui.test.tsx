/**
 * TM-08 / ART S21 — Knowledge conflict/redaction UI (jsdom support evidence).
 * Asserts PROVEN|UNKNOWN|CONFLICT|STALE presentation + redaction disclosure.
 */
import { describe, it, expect, vi } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { KnowledgeDomainScreen } from '#/components/control-center/knowledge/KnowledgeDomainScreen'
import { KnowledgeConflictPanel } from '#/components/control-center/knowledge/KnowledgeConflictPanel'
import {
  knowledgeConflictSourcesFromRaw,
  knowledgeRedactionsFromRaw,
  knowledgeRedactionsFromGaps,
  resolveKnowledgeConflictView,
  type KnowledgeConflictPanelModel,
} from '#/lib/control-center-secondary-route-adapters'
import type { KnowledgeDomainScreenProps } from '#/components/control-center/knowledge/KnowledgeDomainScreen'

function baseScreenProps(
  over: Partial<KnowledgeDomainScreenProps> = {},
): KnowledgeDomainScreenProps {
  return {
    surfaceState: 'populated',
    boardId: 'mfs-rebuild',
    domain: 'AFFILIATE',
    availability: 'available',
    title: 'AFFILIATE',
    summary: 'Domain AFFILIATE: data tersedia dari pin.',
    projects: [{ id: 'p-aff', name: 'Affiliate portal', taskCount: 3 }],
    features: [{ id: 'f-reg', name: 'Registration' }],
    tasks: [
      {
        taskId: 'T-AFF-1',
        title: 'Wire commission',
        bucket: 'NEXT',
        ownerPrimaryTitle: 'Komisi affiliate',
      },
    ],
    decisions: [{ decisionId: 'D-1', title: 'Payout cadence', status: 'OPEN' }],
    evidence: [{ id: 'E-1', kind: 'receipt', summary: 'staging readback' }],
    gaps: [],
    pin: {
      canonicalSnapshotId: 'snap-k-1',
      canonicalHash: 'hashabcdef0123456789',
      boardRev: 9,
      lifecycleRev: 2,
      stale: false,
      staleReason: null,
    },
    error: null,
    ...over,
  }
}

describe('resolveKnowledgeConflictView (presentation-only)', () => {
  it('PROVEN when available, no gaps, pin fresh', () => {
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      gaps: [],
      pin: { stale: false, staleReason: null },
    })
    expect(m.knowledgeState).toBe('PROVEN')
    expect(m.certaintyBlocked).toBe(false)
    expect(m.visible).toBe(false)
  })

  it('STALE when pin.stale — blocks certainty, surfaces reason + last valid', () => {
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      gaps: [],
      pin: {
        stale: true,
        staleReason: 'BOARD_REV_DRIFT',
        generatedAt: '2026-07-13T12:00:00.000Z',
      },
    })
    expect(m.knowledgeState).toBe('STALE')
    expect(m.certaintyBlocked).toBe(true)
    expect(m.visible).toBe(true)
    expect(m.staleReason).toBe('BOARD_REV_DRIFT')
    expect(m.lastValidGeneratedAt).toBe('2026-07-13T12:00:00.000Z')
  })

  it('UNKNOWN when unavailable or partial gaps (never fake PROVEN)', () => {
    const unavailable = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'unavailable',
      gaps: ['NO_PINNED_DOMAIN_DATA'],
      pin: null,
    })
    expect(unavailable.knowledgeState).toBe('UNKNOWN')
    expect(unavailable.certaintyBlocked).toBe(true)
    expect(unavailable.visible).toBe(true)

    const partial = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'partial',
      gaps: ['NO_MATCHING_FEATURES'],
      pin: { stale: false, staleReason: null },
    })
    expect(partial.knowledgeState).toBe('UNKNOWN')
  })

  it('CONFLICT when ≥2 sources — never picks a winner; certainty blocked', () => {
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      gaps: [],
      pin: { stale: false, staleReason: null },
      sources: [
        {
          sourceId: 'src-a',
          label: 'Legacy sales KYC',
          citation: 'projects.sales.kyc',
          claim: 'status=active',
        },
        {
          sourceId: 'src-b',
          label: 'Rebuild affiliate graph',
          citation: 'domains.AFFILIATE.rollups',
          claim: 'status=blocked',
        },
      ],
    })
    expect(m.knowledgeState).toBe('CONFLICT')
    expect(m.certaintyBlocked).toBe(true)
    expect(m.sources).toHaveLength(2)
    expect(m.visible).toBe(true)
  })

  it('CONFLICT from honesty gap token without inventing sources', () => {
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'partial',
      gaps: ['SOURCE_CONFLICT_COMMISSION_RATE'],
      pin: { stale: false, staleReason: null },
      sources: [],
    })
    expect(m.knowledgeState).toBe('CONFLICT')
    expect(m.sources).toEqual([])
  })

  it('PROVEN with redactions stays visible (partial redaction disclosure)', () => {
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      gaps: [],
      pin: { stale: false, staleReason: null },
      redactions: [
        {
          fieldPath: 'accounts.maskedToken',
          reason: 'RBAC',
          hiddenScope: 'provider API tokens',
        },
      ],
    })
    expect(m.knowledgeState).toBe('PROVEN')
    expect(m.visible).toBe(true)
    expect(m.redactions).toHaveLength(1)
  })

  it('does not invent second source from raw single-entry conflicts', () => {
    const sources = knowledgeConflictSourcesFromRaw({
      conflicts: [{ id: 'only-one', label: 'Solo', claim: 'x' }],
    })
    expect(sources).toHaveLength(1)
    const m = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      sources,
      pin: { stale: false, staleReason: null },
    })
    // single source alone is not multi-source CONFLICT
    expect(m.knowledgeState).toBe('PROVEN')
  })
})

describe('raw parsers (pass-through only)', () => {
  it('knowledgeConflictSourcesFromRaw ignores malformed rows', () => {
    expect(knowledgeConflictSourcesFromRaw(null)).toEqual([])
    expect(knowledgeConflictSourcesFromRaw({ conflicts: [null, 'x', 1] })).toEqual([])
    const ok = knowledgeConflictSourcesFromRaw({
      conflictSources: [
        { sourceId: 'a', label: 'A', citation: 'c1', claim: 'v1' },
      ],
    })
    expect(ok).toEqual([
      { sourceId: 'a', label: 'A', citation: 'c1', claim: 'v1' },
    ])
  })

  it('knowledgeRedactionsFromRaw + fromGaps', () => {
    expect(knowledgeRedactionsFromRaw({})).toEqual([])
    expect(
      knowledgeRedactionsFromRaw({
        redactions: [
          { field: 'secret.field', reason: 'POLICY', scope: 'ops credentials' },
        ],
      }),
    ).toEqual([
      {
        fieldPath: 'secret.field',
        reason: 'POLICY',
        hiddenScope: 'ops credentials',
      },
    ])
    expect(knowledgeRedactionsFromGaps(['NO_MATCHING_TASKS'])).toEqual([])
    expect(knowledgeRedactionsFromGaps(['REDACTED_PROVIDER_KEYS'])).toEqual([
      {
        fieldPath: 'REDACTED_PROVIDER_KEYS',
        reason: 'GAP_DECLARED_REDACTION',
        hiddenScope: 'REDACTED_PROVIDER_KEYS',
      },
    ])
  })
})

describe('KnowledgeConflictPanel', () => {
  it('renders nothing when model not visible', () => {
    const model: KnowledgeConflictPanelModel = {
      knowledgeState: 'PROVEN',
      certaintyBlocked: false,
      headline: 'ok',
      detail: 'ok',
      sources: [],
      redactions: [],
      staleReason: null,
      lastValidGeneratedAt: null,
      gaps: [],
      domain: 'AFFILIATE',
      visible: false,
    }
    const { container } = render(<KnowledgeConflictPanel model={model} />)
    expect(container.querySelector('[data-testid="knowledge-conflict"]')).toBeNull()
  })

  it('CONFLICT shows both sources and certainty blocked', () => {
    const model = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      sources: [
        {
          sourceId: 'legacy',
          label: 'Legacy',
          citation: 'legacy.aff',
          claim: 'commission=10%',
        },
        {
          sourceId: 'rebuild',
          label: 'Rebuild',
          citation: 'rebuild.aff',
          claim: 'commission=12%',
        },
      ],
      pin: { stale: false, staleReason: null },
    })
    render(<KnowledgeConflictPanel model={model} />)
    const panel = screen.getByTestId('knowledge-conflict')
    expect(panel.getAttribute('data-knowledge-state')).toBe('CONFLICT')
    expect(panel.getAttribute('data-certainty-blocked')).toBe('true')
    expect(screen.getByTestId('knowledge-conflict-state').textContent).toBe('CONFLICT')
    expect(screen.getByTestId('knowledge-conflict-certainty-blocked')).toBeTruthy()
    const sourceLis = within(panel).getAllByTestId('knowledge-conflict-source')
    expect(sourceLis).toHaveLength(2)
    expect(sourceLis[0]!.textContent).toMatch(/Legacy/)
    expect(sourceLis[1]!.textContent).toMatch(/Rebuild/)
    expect(sourceLis[0]!.textContent).toMatch(/commission=10%/)
    expect(sourceLis[1]!.textContent).toMatch(/commission=12%/)
  })

  it('STALE banner with last valid time and reason', () => {
    const model = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      pin: {
        stale: true,
        staleReason: 'MIXED_REVISION',
        generatedAt: '2026-07-12T08:00:00.000Z',
      },
    })
    render(<KnowledgeConflictPanel model={model} />)
    expect(screen.getByTestId('knowledge-conflict').getAttribute('data-knowledge-state')).toBe(
      'STALE',
    )
    expect(screen.getByTestId('knowledge-conflict-stale-reason').textContent).toBe(
      'MIXED_REVISION',
    )
    expect(screen.getByTestId('knowledge-conflict-last-valid').textContent).toBe(
      '2026-07-12T08:00:00.000Z',
    )
  })

  it('partial redaction explains hidden scope', () => {
    const model = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'available',
      pin: { stale: false, staleReason: null },
      redactions: [
        {
          fieldPath: 'payout.bankAccount',
          reason: 'RBAC_ROLE_VIEWER',
          hiddenScope: 'bank account numbers for payouts',
        },
      ],
    })
    render(<KnowledgeConflictPanel model={model} />)
    const redaction = screen.getByTestId('knowledge-conflict-redaction')
    expect(redaction.textContent).toMatch(/payout\.bankAccount/)
    expect(redaction.textContent).toMatch(/RBAC_ROLE_VIEWER/)
    expect(redaction.textContent).toMatch(/bank account numbers for payouts/)
  })

  it('retry control when certainty blocked', () => {
    const onRetry = vi.fn()
    const model = resolveKnowledgeConflictView({
      domain: 'AFFILIATE',
      availability: 'unavailable',
      gaps: ['NO_PINNED_DOMAIN_DATA'],
      pin: null,
    })
    render(<KnowledgeConflictPanel model={model} onRetry={onRetry} />)
    screen.getByTestId('knowledge-conflict-retry').click()
    expect(onRetry).toHaveBeenCalledTimes(1)
  })
})

describe('KnowledgeDomainScreen S21 integration', () => {
  it('keeps pre-existing domain body when conflict props absent (populated path)', () => {
    render(<KnowledgeDomainScreen {...baseScreenProps()} />)
    expect(screen.getByTestId('control-center-knowledge-domain')).toBeTruthy()
    expect(screen.getByTestId('knowledge-title').textContent).toBe('AFFILIATE')
    expect(screen.getByTestId('knowledge-projects').textContent).toMatch(/Affiliate portal/)
    expect(screen.getByTestId('knowledge-features').textContent).toMatch(/Registration/)
    expect(screen.getByTestId('knowledge-tasks').textContent).toMatch(/Komisi affiliate/)
    expect(screen.getByTestId('knowledge-decisions').textContent).toMatch(/Payout cadence/)
    expect(screen.getByTestId('knowledge-evidence').textContent).toMatch(/staging readback/)
    expect(screen.getByTestId('knowledge-pin').textContent).toMatch(/snap-k-1/)
    // PROVEN → conflict panel hidden
    expect(screen.queryByTestId('knowledge-conflict')).toBeNull()
    expect(screen.getByTestId('knowledge-fact-state').textContent).toBe('PROVEN')
  })

  it('renders knowledge-conflict for multi-source CONFLICT on AFFILIATE', () => {
    render(
      <KnowledgeDomainScreen
        {...baseScreenProps({
          conflictSources: [
            {
              sourceId: 'sales-kyc',
              label: 'Sales KYC bundle',
              citation: 'projects.sales',
              claim: 'activation=required',
            },
            {
              sourceId: 'portal',
              label: 'Portal graph',
              citation: 'features.portal',
              claim: 'activation=optional',
            },
          ],
        })}
      />,
    )
    const panel = screen.getByTestId('knowledge-conflict')
    expect(panel.getAttribute('data-knowledge-state')).toBe('CONFLICT')
    expect(screen.getByTestId('knowledge-fact-state').textContent).toBe('CONFLICT')
    // Pre-existing body still renders (conflict blocks certainty, not the whole page)
    expect(screen.getByTestId('knowledge-body')).toBeTruthy()
    expect(within(panel).getAllByTestId('knowledge-conflict-source')).toHaveLength(2)
  })

  it('renders STALE panel when pin.stale without dropping pin footer', () => {
    render(
      <KnowledgeDomainScreen
        {...baseScreenProps({
          pin: {
            canonicalSnapshotId: 'snap-stale',
            canonicalHash: 'hashstale',
            boardRev: 10,
            lifecycleRev: 3,
            stale: true,
            staleReason: 'LIFECYCLE_AHEAD',
          },
          lastValidGeneratedAt: '2026-07-11T00:00:00.000Z',
          surfaceState: 'stale',
        })}
      />,
    )
    expect(screen.getByTestId('knowledge-conflict').getAttribute('data-knowledge-state')).toBe(
      'STALE',
    )
    expect(screen.getByTestId('knowledge-pin').textContent).toMatch(/STALE LIFECYCLE_AHEAD/)
    expect(screen.getByTestId('knowledge-conflict-last-valid').textContent).toBe(
      '2026-07-11T00:00:00.000Z',
    )
  })

  it('unavailable still honest + UNKNOWN conflict surface', () => {
    render(
      <KnowledgeDomainScreen
        {...baseScreenProps({
          availability: 'unavailable',
          projects: [],
          features: [],
          tasks: [],
          decisions: [],
          evidence: [],
          gaps: ['NO_PINNED_DOMAIN_DATA'],
          summary: 'Domain AFFILIATE tidak punya data ter-pin.',
          pin: null,
        })}
      />,
    )
    expect(screen.getByTestId('knowledge-unavailable')).toBeTruthy()
    expect(screen.queryByTestId('knowledge-body')).toBeNull()
    expect(screen.getByTestId('knowledge-conflict').getAttribute('data-knowledge-state')).toBe(
      'UNKNOWN',
    )
  })

  it('redaction disclosure with PROVEN body retained', () => {
    render(
      <KnowledgeDomainScreen
        {...baseScreenProps({
          redactions: [
            {
              fieldPath: 'webhook.signingSecret',
              reason: 'REDACTION_POLICY',
              hiddenScope: 'provider webhook secrets',
            },
          ],
        })}
      />,
    )
    expect(screen.getByTestId('knowledge-fact-state').textContent).toBe('PROVEN')
    expect(screen.getByTestId('knowledge-conflict')).toBeTruthy()
    expect(screen.getByTestId('knowledge-conflict-redaction').textContent).toMatch(
      /provider webhook secrets/,
    )
    expect(screen.getByTestId('knowledge-projects')).toBeTruthy()
  })
})
