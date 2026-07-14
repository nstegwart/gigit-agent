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
  featureDetailFromEnvelope,
  agentsEnvelopeToProps,
  opsEnvelopeToProps,
  projectDetailHref,
  featureDetailHref,
  safeMaskedAccountDisplay,
  opsAccountAuditFlags,
} from '#/lib/control-center-secondary-route-adapters'
import { FeatureDetailScreen } from '#/components/control-center/features'
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
        readinessPercent: 62.5,
        readinessStage: 'G4',
        readinessEvidenceOk: true,
      },
      {
        id: 'p-ops',
        name: 'Ops tooling',
        status: 'blocked',
        taskCount: 4,
        doneCount: 0,
        blockedCount: 2,
        readinessPercent: null,
        readinessStage: null,
        readinessEvidenceOk: null,
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
    expect(props.projects[0].readinessPercent).toBe(62.5)
    expect(props.projects[0].readinessStage).toBe('G4')
    expect(props.projects[0].readinessEvidenceOk).toBe(true)
    expect(props.projects[1].readinessPercent).toBeNull()
    expect(props.projectionGaps).toEqual([])
  })

  it('renders table + pin + detail links + reflow attr + readiness fields', () => {
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
    expect(rows[0].getAttribute('data-readiness-percent')).toBe('62.5')
    expect(rows[0].getAttribute('data-readiness-stage')).toBe('G4')
    expect(rows[0].getAttribute('data-readiness-evidence-ok')).toBe('true')
    expect(within(rows[0]).getByText('62.5%')).toBeTruthy()
    expect(within(rows[0]).getByText('G4')).toBeTruthy()
    expect(within(rows[0]).getByText('ok')).toBeTruthy()
    const links = screen.getAllByTestId('project-detail-link')
    expect(links.some((a) => a.getAttribute('href') === '/b/mfs-rebuild/projects/p-sales')).toBe(
      true,
    )
    // Honest eyebrow: Projects is not Mission Q2–Q4 primary.
    expect(root.textContent).toMatch(/IA · Projects/)
    expect(root.textContent).not.toMatch(/Mission Q2–Q4/)
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
        pageRoutes: ['/checkout', '/cart'],
        apiEndpoints: ['POST /pay'],
        logicRules: ['must-auth'],
        dataContext: ['orders.total'],
        geoVariants: ['US', 'ID'],
        providerVariants: ['xendit'],
        sideEffectsReadback: ['webhook.paid'],
        styleContext: null,
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

  it('preserves item order and detail links + flow context fields', () => {
    const props = featuresEnvelopeToProps(basePin(data, { nextCursor: 'cur-2' }))
    expect(props.features.map((f) => f.featureId)).toEqual(['f-1', 'f-2'])
    expect(props.features[0].detailHref).toBe('/b/mfs-rebuild/features/f-1')
    expect(props.nextCursor).toBe('cur-2')
    expect(props.features[0].pageRoutes).toEqual(['/checkout', '/cart'])
    expect(props.features[0].apiEndpoints).toEqual(['POST /pay'])
    expect(props.features[0].logicRules).toEqual(['must-auth'])
    expect(props.features[0].dataContext).toEqual(['orders.total'])
    expect(props.features[0].geoVariants).toEqual(['US', 'ID'])
    expect(props.features[0].providerVariants).toEqual(['xendit'])
    expect(props.features[0].sideEffectsReadback).toEqual(['webhook.paid'])
    expect(props.features[0].styleContext).toEqual([])
    expect(props.features[1].pageRoutes).toEqual([])
  })

  it('drops items missing id (historical strip bug) so detailHref never ends in /undefined', () => {
    const broken: FeaturesData = {
      ...data,
      items: [
        {
          // id intentionally omitted — mirrors old projectFeatures destructure
          projectId: 'p-sales',
          name: 'Broken row',
          phase: 'spec',
          flowBranch: null,
          taskCount: 1,
        } as FeaturesData['items'][number],
        data.items[0]!,
      ],
    }
    const props = featuresEnvelopeToProps(basePin(broken))
    expect(props.features.map((f) => f.featureId)).toEqual(['f-1'])
    expect(props.features.every((f) => !f.detailHref.includes('undefined'))).toBe(true)
  })

  it('featureDetailFromEnvelope resolves from full features list (not only page items)', () => {
    const env = basePin({
      ...data,
      features: [
        {
          id: 'FC-AFF-MEMBER-REFERRAL',
          projectId: 'backend',
          name: 'Member referral link/payout',
          phase: 'spec',
          flowBranch: 'open' as const,
          taskCount: 4,
        },
      ],
      items: [data.items[0]!], // page does not include FC-AFF
    })
    const found = featureDetailFromEnvelope(env, 'FC-AFF-MEMBER-REFERRAL')
    expect(found.feature?.featureId).toBe('FC-AFF-MEMBER-REFERRAL')
    expect(found.feature?.name).toMatch(/Member referral/)
    expect(found.feature?.detailHref).toBe(
      '/b/mfs-rebuild/features/FC-AFF-MEMBER-REFERRAL',
    )
    expect(found.error).toBeNull()

    const missing = featureDetailFromEnvelope(env, 'FC-DOES-NOT-EXIST')
    expect(missing.feature).toBeNull()
    expect(missing.error?.code).toBe('NOT_FOUND')
  })

  it('FeatureDetailScreen renders title for resolved feature and not-found banner', () => {
    const env = basePin(data)
    const found = featureDetailFromEnvelope(env, 'f-1')
    const { rerender } = render(
      <FeatureDetailScreen
        surfaceState="populated"
        boardId="mfs-rebuild"
        feature={found.feature}
        pin={found.pin}
        error={found.error}
        listHref={found.listHref}
      />,
    )
    expect(screen.getByTestId('control-center-feature-detail').getAttribute('data-feature-id')).toBe(
      'f-1',
    )
    expect(screen.getByTestId('feature-detail-title').textContent).toMatch(/Checkout flow/)
    expect(screen.queryByTestId('feature-detail-not-found')).toBeNull()

    rerender(
      <FeatureDetailScreen
        surfaceState="empty"
        boardId="mfs-rebuild"
        feature={null}
        pin={null}
        error={{ code: 'NOT_FOUND', message: 'Feature not found: missing' }}
        listHref="/b/mfs-rebuild/features"
      />,
    )
    expect(screen.getByTestId('feature-detail-not-found').textContent).toMatch(/Feature not found/)
  })

  it('renders flow branch + context chips + responsive structure', () => {
    render(<FeaturesScreen {...featuresEnvelopeToProps(basePin(data))} />)
    const root = screen.getByTestId('control-center-features')
    expect(root.getAttribute('data-reflow-breakpoint')).toBe('768')
    const rows = screen.getAllByTestId('feature-row')
    expect(rows[0].getAttribute('data-flow-branch')).toBe('open')
    expect(rows[1].getAttribute('data-flow-branch')).toBe('fail')
    const ctx = within(rows[0]).getAllByTestId('feature-context')
    expect(ctx.length).toBeGreaterThan(0)
    expect(ctx[0].textContent).toMatch(/routes/)
    expect(ctx[0].textContent).toMatch(/api/)
    expect(ctx[0].textContent).toMatch(/geo/)
    expect(within(rows[1]).getByTestId('feature-context-empty')).toBeTruthy()
    expect(
      screen.getAllByTestId('feature-detail-link').some(
        (a) => a.getAttribute('href') === '/b/mfs-rebuild/features/f-2',
      ),
    ).toBe(true)
    // Q5 is BLOCKED; Features is IA portfolio, not Mission Q5.
    expect(root.textContent).toMatch(/IA · Fitur \/ Alur/)
    expect(root.textContent).not.toMatch(/Mission Q5/)
    // Name primary before technical id column
    const firstRow = rows[0]!
    const nameIdx = firstRow.textContent?.indexOf('Checkout flow') ?? -1
    const idIdx = firstRow.textContent?.indexOf('f-1') ?? -1
    expect(nameIdx).toBeGreaterThanOrEqual(0)
    expect(idIdx).toBeGreaterThan(nameIdx)
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
        claimState: 'VALID_CURRENT',
        lockIds: ['lock-a', 'lock-b'],
        controllerRunId: 'ctrl-1',
        parentRunId: 'parent-0',
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
        claimState: null,
        lockIds: null,
        controllerRunId: null,
        parentRunId: null,
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

  it('does not re-sort runs (server order preserved) and maps ownership fields', () => {
    const props = agentsEnvelopeToProps(basePin(data))
    expect(props.runs.map((r) => r.runId)).toEqual(['run-1', 'run-2'])
    expect(props.runs[0].claimState).toBe('VALID_CURRENT')
    expect(props.runs[0].lockIds).toEqual(['lock-a', 'lock-b'])
    expect(props.runs[0].controllerRunId).toBe('ctrl-1')
    expect(props.runs[0].parentRunId).toBe('parent-0')
    expect(props.runs[1].claimState).toBeNull()
    expect(props.runs[1].lockIds).toEqual([])
    expect(props.runs[1].controllerRunId).toBeNull()
    expect(props.runs[1].parentRunId).toBeNull()
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

  it('run rows keep server order in DOM and expose claim/locks/controller/parent', () => {
    render(<AgentsScreen {...agentsEnvelopeToProps(basePin(data))} />)
    const root = screen.getByTestId('control-center-agents')
    const runs = screen.getAllByTestId('agent-run-row')
    expect(runs.map((r) => r.getAttribute('data-run-id'))).toEqual(['run-1', 'run-2'])
    expect(runs[0].getAttribute('data-claim-state')).toBe('VALID_CURRENT')
    expect(runs[0].getAttribute('data-controller-run-id')).toBe('ctrl-1')
    expect(runs[0].getAttribute('data-parent-run-id')).toBe('parent-0')
    const ownership = within(runs[0]).getByTestId('agent-run-ownership')
    expect(ownership.getAttribute('data-lock-count')).toBe('2')
    expect(ownership.textContent).toMatch(/VALID_CURRENT/)
    expect(ownership.textContent).toMatch(/lock-a/)
    expect(ownership.textContent).toMatch(/ctrl-1/)
    expect(ownership.textContent).toMatch(/parent-0/)
    // Q6 is Decisions; Agents is Mission Q2 only.
    expect(root.textContent).toMatch(/Mission Q2/)
    expect(root.textContent).not.toMatch(/Mission Q2 \/ Q6/)
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
