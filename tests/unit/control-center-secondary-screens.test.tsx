/**
 * C3-R2C secondary screens — unit / jsdom binding tests.
 * Support evidence only (LOCAL ONLY); no real-browser visual pair.
 */
import { describe, it, expect } from 'vitest'
import { render, screen, within } from '@testing-library/react'
import { ProjectsScreen } from '#/components/control-center/projects'
import { FeaturesScreen } from '#/components/control-center/features'
import { AgentsScreen } from '#/components/control-center/agents'
import { OpsScreen } from '#/components/control-center/ops'
import {
  projectsEnvelopeToProps,
  featuresEnvelopeToProps,
  agentsEnvelopeToProps,
  opsEnvelopeToProps,
  projectDetailHref,
  featureDetailHref,
  safeMaskedAccountDisplay,
  opsAccountAuditFlags,
} from '#/lib/control-center-secondary-route-adapters'
import type { AgentsScreenProps } from '#/components/control-center/agents/types'
import type { FeaturesScreenProps } from '#/components/control-center/features/types'
import type { PinnedEnvelope, ProjectsData, FeaturesData, AgentsData, OpsData } from '#/lib/control-center-query'
import {
  projectsQueryOptions,
  featuresQueryOptions,
  agentsQueryOptions,
  opsQueryOptions,
} from '#/lib/control-center-query'

function basePin<T>(data: T, over: Partial<PinnedEnvelope<T>> = {}): PinnedEnvelope<T> {
  return {
    schemaVersion: 'control-center-ui/v1' as PinnedEnvelope<T>['schemaVersion'],
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'snap-secondary-1',
    canonicalHash: 'hashabcdef0123456789',
    boardRev: 12,
    lifecycleRev: 4,
    generatedAt: '2026-07-13T12:00:00.000Z',
    freshnessAgeSeconds: 42,
    stale: false,
    staleReason: null,
    data,
    nextCursor: null,
    surfaceState: 'populated',
    surface: null,
    error: null,
    ...over,
  }
}

describe('secondary query options wiring', () => {
  it('projectsQueryOptions / features / agents / ops use control-center keys', () => {
    const fetch = async () => basePin({} as never)
    expect(projectsQueryOptions('mfs-rebuild', fetch).queryKey).toEqual([
      'control-center',
      'projects',
      'mfs-rebuild',
    ])
    expect(featuresQueryOptions('mfs-rebuild', { cursor: 'c1' }, fetch).queryKey).toEqual([
      'control-center',
      'features',
      'mfs-rebuild',
      { cursor: 'c1', pageSize: null },
    ])
    expect(agentsQueryOptions('mfs-rebuild', {}, fetch).queryKey).toEqual([
      'control-center',
      'agents',
      'mfs-rebuild',
      { cursor: null, pageSize: null },
    ])
    expect(opsQueryOptions('mfs-rebuild', fetch).queryKey).toEqual([
      'control-center',
      'ops',
      'mfs-rebuild',
    ])
  })
})

describe('detail link preservation', () => {
  it('builds legacy project/feature detail hrefs', () => {
    expect(projectDetailHref('mfs-rebuild', 'proj/a')).toBe(
      '/b/mfs-rebuild/projects/proj%2Fa',
    )
    expect(featureDetailHref('mfs-rebuild', 'feat-1')).toBe(
      '/b/mfs-rebuild/features/feat-1',
    )
  })
})

describe('redaction', () => {
  it('masks obvious secret-shaped account strings', () => {
    expect(safeMaskedAccountDisplay('sk-live-abcdef')).toBe('•••• (redacted)')
    expect(safeMaskedAccountDisplay('acct-•••9f2')).toBe('acct-•••9f2')
    expect(safeMaskedAccountDisplay(null)).toBe('—')
  })

  it('derives LIMIT / quarantine / tombstone flags without inventing', () => {
    expect(opsAccountAuditFlags({ status: 'LIMIT', quarantine: false }).isLimit).toBe(true)
    expect(opsAccountAuditFlags({ status: 'ACTIVE', quarantine: true }).isQuarantine).toBe(true)
    expect(opsAccountAuditFlags({ status: 'REMOVED', quarantine: false }).isTombstone).toBe(true)
  })
})

describe('projectsEnvelopeToProps + ProjectsScreen', () => {
  const data: ProjectsData = {
    surfaceVersion: '1' as ProjectsData['surfaceVersion'],
    projects: [
      {
        id: 'p-sales',
        name: 'Sales web',
        status: 'active',
        taskCount: 10,
        doneCount: 3,
        blockedCount: 1,
      },
      {
        id: 'p-ops',
        name: 'Ops tooling',
        status: 'blocked',
        taskCount: 4,
        doneCount: 0,
        blockedCount: 2,
      },
    ],
    productDenominator: 14,
    buckets: { ONGOING: 2, NEXT: 1 } as ProjectsData['buckets'],
  }

  it('maps pin attrs and preserves server project order', () => {
    const props = projectsEnvelopeToProps(basePin(data))
    expect(props.pin?.canonicalSnapshotId).toBe('snap-secondary-1')
    expect(props.pin?.boardRev).toBe(12)
    expect(props.pin?.lifecycleRev).toBe(4)
    expect(props.projects.map((p) => p.projectId)).toEqual(['p-sales', 'p-ops'])
    expect(props.projects[0].detailHref).toBe('/b/mfs-rebuild/projects/p-sales')
    expect(props.productDenominator).toBe(14)
  })

  it('renders table + pin + detail links + reflow attr', () => {
    const props = projectsEnvelopeToProps(basePin(data))
    render(<ProjectsScreen {...props} />)
    const root = screen.getByTestId('control-center-projects')
    expect(root.getAttribute('data-reflow-breakpoint')).toBe('768')
    // Pin identity on surface ROOT (PinnedSurface contract), not only strip child.
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('snap-secondary-1')
    expect(root.getAttribute('data-canonical-hash')).toBe('hashabcdef0123456789')
    expect(root.getAttribute('data-board-rev')).toBe('12')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('4')
    expect(root.getAttribute('data-generated-at')).toBe('2026-07-13T12:00:00.000Z')
    expect(root.getAttribute('data-freshness-age')).toBe('42')
    expect(root.getAttribute('data-stale')).toBe('false')
    expect(root.getAttribute('data-pinned')).toBe('true')
    expect(screen.getByTestId('projects-pin').getAttribute('data-board-rev')).toBe('12')
    const rows = screen.getAllByTestId('project-row')
    expect(rows.map((r) => r.getAttribute('data-project-id'))).toEqual(['p-sales', 'p-ops'])
    const links = screen.getAllByTestId('project-detail-link')
    expect(links.some((a) => a.getAttribute('href') === '/b/mfs-rebuild/projects/p-sales')).toBe(
      true,
    )
  })

  it('shows honest empty state', () => {
    const empty = basePin({
      ...data,
      projects: [],
    }, { surfaceState: 'empty' })
    const props = projectsEnvelopeToProps(empty)
    render(<ProjectsScreen {...props} />)
    expect(screen.getByTestId('projects-empty')).toBeTruthy()
  })

  it('renders projection gaps as compact native disclosure', () => {
    const base = basePin({
      ...data,
      projectionGaps: ['p-legacy missing', 'p-ghost missing'],
      projects: data.projects,
      productDenominator: data.productDenominator,
      buckets: data.buckets,
    } as unknown as ProjectsData)
    const props = {
      ...projectsEnvelopeToProps(base),
      surfaceState: 'partial',
      projectionGaps: ['p-legacy missing', 'p-ghost missing'],
    } as any
    render(<ProjectsScreen {...props} />)
    const disclosure = screen.getByTestId('projects-partial-banner')
    const summary = within(disclosure).getByText(/Honest projection gaps \(2\)/i)
    expect(summary).toBeTruthy()
    expect(summary.tagName).toBe('SUMMARY')
    expect(disclosure.textContent).toContain('p-legacy missing')
  })
})

describe('featuresEnvelopeToProps + FeaturesScreen', () => {
  const data: FeaturesData = {
    surfaceVersion: '1' as FeaturesData['surfaceVersion'],
    features: [],
    items: [
      {
        id: 'f-1',
        projectId: 'p-sales',
        name: 'Checkout flow',
        phase: 'build',
        flowBranch: 'open',
        taskCount: 5,
      },
      {
        id: 'f-2',
        projectId: 'p-sales',
        name: 'Refund path',
        phase: 'verify',
        flowBranch: 'fail',
        taskCount: 2,
      },
    ],
    pageSize: 50,
  }

  it('preserves item order and detail links', () => {
    const props = featuresEnvelopeToProps(basePin(data, { nextCursor: 'cur-2' }))
    expect(props.features.map((f) => f.featureId)).toEqual(['f-1', 'f-2'])
    expect(props.features[0].detailHref).toBe('/b/mfs-rebuild/features/f-1')
    expect(props.nextCursor).toBe('cur-2')
  })

  it('renders flow branch + responsive structure', () => {
    render(<FeaturesScreen {...featuresEnvelopeToProps(basePin(data))} />)
    const root = screen.getByTestId('control-center-features')
    expect(root.getAttribute('data-reflow-breakpoint')).toBe('768')
    const rows = screen.getAllByTestId('feature-row')
    expect(rows[0].getAttribute('data-flow-branch')).toBe('open')
    expect(rows[1].getAttribute('data-flow-branch')).toBe('fail')
    expect(
      screen.getAllByTestId('feature-detail-link').some(
        (a) => a.getAttribute('href') === '/b/mfs-rebuild/features/f-2',
      ),
    ).toBe(true)
  })

  it('surfaces projection gaps via details disclosure and count', () => {
    const base = basePin({
      ...data,
      projectionGaps: ['f-open missing checklist', 'f-open stale'],
      features: data.features,
      items: data.items,
      pageSize: data.pageSize,
    } as unknown as FeaturesData)
    const props: FeaturesScreenProps = {
      ...featuresEnvelopeToProps(base),
      projectionGaps: ['f-open missing checklist', 'f-open stale'],
      surfaceState: 'partial',
      nextCursor: 'cur-2',
    }
    render(<FeaturesScreen {...props} />)
    const disclosure = screen.getByTestId('features-partial-banner')
    const summary = within(disclosure).getByText(/Honest projection gaps \(2\)/i)
    expect(summary).toBeTruthy()
    expect(summary.tagName).toBe('SUMMARY')
    expect(disclosure.textContent).toContain('f-open missing checklist')
  })

  it('empty paginated items must NOT fall back to full features list', () => {
    const emptyPage: FeaturesData = {
      ...data,
      features: [
        {
          id: 'f-only-full',
          projectId: 'p1',
          name: 'Should not appear',
          phase: 'build',
          flowBranch: 'open',
          taskCount: 1,
        },
      ],
      items: [],
    }
    const props = featuresEnvelopeToProps(basePin(emptyPage))
    expect(props.features).toEqual([])
  })
})

describe('agentsEnvelopeToProps + AgentsScreen', () => {
  const data: AgentsData = {
    surfaceVersion: '1' as AgentsData['surfaceVersion'],
    runs: [],
    items: [
      {
        runId: 'run-1',
        taskId: 't-1',
        agentId: 'agent-a',
        role: 'implementer',
        model: 'grok-4.5',
        effort: 'high',
        maskedAccount: 'acct-•••1',
        status: 'running',
        startedAt: '2026-07-13T11:00:00.000Z',
        heartbeatAt: '2026-07-13T11:50:00.000Z',
        materialProgressAt: '2026-07-13T11:40:00.000Z',
        productiveSubstate: 'STALLED',
        createdAt: '2026-07-13T11:00:00.000Z',
        id: 'run-1',
      },
      {
        runId: 'run-2',
        taskId: 't-2',
        agentId: 'agent-b',
        role: 'verifier',
        model: 'opus',
        effort: 'medium',
        maskedAccount: 'acct-•••2',
        status: 'running',
        startedAt: '2026-07-13T10:00:00.000Z',
        heartbeatAt: '2026-07-13T11:55:00.000Z',
        materialProgressAt: '2026-07-13T11:55:00.000Z',
        productiveSubstate: 'PRODUCTIVE',
        createdAt: '2026-07-13T10:00:00.000Z',
        id: 'run-2',
      },
    ],
    pageSize: 50,
    ongoing: [
      {
        taskId: 't-1',
        title: 'Wire secondary screens',
        targetGate: 'G3',
        agentId: 'agent-a',
        role: 'implementer',
        model: 'grok-4.5',
        effort: 'high',
        maskedAccount: 'acct-•••1',
        startedAt: '2026-07-13T11:00:00.000Z',
        startedAgeSeconds: 3600,
        heartbeatAt: '2026-07-13T11:50:00.000Z',
        heartbeatAgeSeconds: 600,
        materialProgressAt: '2026-07-13T11:40:00.000Z',
        materialProgressAgeSeconds: 1200,
        productiveSubstate: 'STALLED',
        evidenceLink: '/b/mfs-rebuild/evidence',
        bucket: 'ONGOING',
        overlays: [],
      },
    ],
  }

  it('does not re-sort runs (server order preserved)', () => {
    const props = agentsEnvelopeToProps(basePin(data))
    expect(props.runs.map((r) => r.runId)).toEqual(['run-1', 'run-2'])
  })

  it('empty paginated items must NOT fall back to full runs list', () => {
    const emptyPage: AgentsData = {
      ...data,
      runs: data.items,
      items: [],
    }
    const props = agentsEnvelopeToProps(basePin(emptyPage))
    expect(props.runs).toEqual([])
  })

  it('zero-click ongoing shows ages / gate / role / masked account / evidence', () => {
    render(<AgentsScreen {...agentsEnvelopeToProps(basePin(data))} />)
    const ongoing = screen.getByTestId('agent-ongoing-row')
    expect(ongoing.getAttribute('data-productive-state')).toBe('STALLED')
    expect(within(ongoing).getByText(/G3/)).toBeTruthy()
    expect(within(ongoing).getByText(/implementer/)).toBeTruthy()
    expect(within(ongoing).getByText(/acct-•••1/)).toBeTruthy()
    expect(within(ongoing).getByTestId('agent-ongoing-ages').textContent).toMatch(/1h/)
    expect(within(ongoing).getByTestId('agent-ongoing-ages').textContent).toMatch(/10m/)
    expect(within(ongoing).getByTestId('agent-ongoing-ages').textContent).toMatch(/20m/)
    expect(within(ongoing).getByText(/Evidence/)).toBeTruthy()
  })

  it('run rows keep server order in DOM', () => {
    render(<AgentsScreen {...agentsEnvelopeToProps(basePin(data))} />)
    const runs = screen.getAllByTestId('agent-run-row')
    expect(runs.map((r) => r.getAttribute('data-run-id'))).toEqual(['run-1', 'run-2'])
  })

  it('renders projection gaps as native details with count label', () => {
    const base = agentsEnvelopeToProps(
      basePin({
        ...data,
        projectionGaps: ['agent-auth stale', 'agent-account redacted'],
        runs: data.runs,
        items: data.items,
        pageSize: data.pageSize,
        ongoing: data.ongoing,
      } as unknown as AgentsData),
    ) as unknown as ReturnType<typeof agentsEnvelopeToProps>
    const props: AgentsScreenProps = {
      ...base,
      projectionGaps: ['agent-auth stale', 'agent-account redacted'],
      surfaceState: 'partial',
    }
    render(<AgentsScreen {...props} />)
    const disclosure = screen.getByTestId('agents-partial-banner')
    const summary = within(disclosure).getByText(/Honest projection gaps \(2\)/i)
    expect(summary).toBeTruthy()
    expect(summary.tagName).toBe('SUMMARY')
    expect(disclosure.textContent).toContain('agent-auth stale')
  })
})

describe('opsEnvelopeToProps + OpsScreen', () => {
  const data: OpsData = {
    surfaceVersion: '1' as OpsData['surfaceVersion'],
    accounts: [
      {
        maskedAccountId: 'acct-•••ok',
        status: 'ACTIVE',
        providerKind: 'grok',
        effectiveInUse: 1,
        effectiveCap: 3,
        physicalSlotsDisplay: '1/3',
        quarantine: false,
        reason: null,
      },
      {
        maskedAccountId: 'acct-•••lim',
        status: 'LIMIT',
        providerKind: 'codex',
        effectiveInUse: 2,
        effectiveCap: 2,
        physicalSlotsDisplay: '2/2',
        quarantine: false,
        reason: 'daily cap',
      },
      {
        maskedAccountId: 'acct-•••q',
        status: 'QUARANTINED',
        providerKind: 'claude',
        effectiveInUse: 0,
        effectiveCap: 0,
        physicalSlotsDisplay: '0',
        quarantine: true,
        reason: 'auth fail',
      },
      {
        maskedAccountId: 'acct-•••tomb',
        status: 'REMOVED',
        providerKind: null,
        effectiveInUse: 0,
        effectiveCap: 0,
        physicalSlotsDisplay: null,
        quarantine: false,
        reason: 'tombstone',
      },
    ],
    usableCapacity: 2,
    quarantineCount: 1,
    accountSyncStale: true,
    capacityNote: null,
  }

  it('never exposes raw token-looking values; maps audit flags', () => {
    const leaked = basePin({
      ...data,
      accounts: [
        {
          ...data.accounts[0],
          maskedAccountId: 'sk-secret-token-value',
        },
      ],
    })
    const props = opsEnvelopeToProps(leaked)
    expect(props.accounts[0].maskedAccountId).toBe('•••• (redacted)')
    const normal = opsEnvelopeToProps(basePin(data))
    expect(normal.accounts.map((a) => a.isLimit)).toEqual([false, true, false, false])
    expect(normal.accounts.map((a) => a.quarantine)).toEqual([false, false, true, false])
    expect(normal.accounts.map((a) => a.isTombstone)).toEqual([false, false, false, true])
    expect(normal.accountSyncStale).toBe(true)
    expect(normal.usableCapacity).toBe(2)
  })

  it('renders pin source revision / freshness / sync stale / capacity', () => {
    const props = opsEnvelopeToProps(
      basePin({
        ...data,
        sourceRevision: 99,
      }),
    )
    render(<OpsScreen {...props} />)
    const root = screen.getByTestId('control-center-ops')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('snap-secondary-1')
    expect(root.getAttribute('data-board-rev')).toBe('12')
    expect(root.getAttribute('data-freshness-age')).toBe('42')
    expect(root.getAttribute('data-stale')).toBe('false')
    // boardRev must never be used as account sourceRevision
    expect(root.getAttribute('data-source-revision')).toBeNull()
    const pin = screen.getByTestId('ops-pin')
    expect(pin.getAttribute('data-board-rev')).toBe('12')
    expect(pin.getAttribute('data-source-revision')).toBe('99')
    expect(pin.getAttribute('data-freshness-age')).toBe('42')
    expect(screen.getByTestId('ops-sync-stale')).toBeTruthy()
    expect(screen.getByTestId('ops-usable-capacity').textContent).toMatch(/2/)
    const rows = screen.getAllByTestId('ops-account-row')
    expect(rows[1].getAttribute('data-limit')).toBe('1')
    expect(rows[2].getAttribute('data-quarantine')).toBe('1')
    expect(rows[3].getAttribute('data-tombstone')).toBe('1')
    // no raw secret
    expect(document.body.textContent).not.toMatch(/sk-secret/)
  })

  it('omits account sourceRevision when OpsData.sourceRevision absent (not boardRev)', () => {
    const props = opsEnvelopeToProps(basePin(data))
    expect(props.accountSourceRevision).toBeNull()
    render(<OpsScreen {...props} />)
    expect(screen.getByTestId('ops-pin').getAttribute('data-source-revision')).toBeNull()
  })
})
