/**
 * TM-03: AFFILIATE DomainKnowledgeBundle + coverage manifest (unit / LOCAL ONLY).
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { describe, expect, it } from 'vitest'

import {
  knowledgeDomainEnvelopeToViewModel,
  documentationDomainEnvelopeToViewModel,
} from '#/lib/control-center-route-adapters'
import {
  AFFILIATE_DOMAIN_ID,
  AFFILIATE_BUNDLE_GENERATED_AT,
  affiliateBundleToDocumentationMarkdown,
  affiliateBundleToKnowledgeDomainData,
  buildAffiliateDomainKnowledgeBundle,
  isAffiliateDomainId,
} from '#/server/domain-knowledge-affiliate'
import {
  projectKnowledgeDomainFromAgg,
  projectDocumentationDomainFromAgg,
} from '#/server/control-center-ui-fns'
import {
  type ControlCenterAggregation,
  type ControlCenterPin,
  type PinnedEnvelope,
} from '#/server/control-center-ui'

const FIXTURE_PATH = join(
  process.cwd(),
  'qa/fixtures/staging/domain-affiliate.bundle.json',
)

const PIN: ControlCenterPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'snap-aff-1',
  canonicalHash: 'canon_aff_hash_aaaa',
  taskHash: 'task_aff_hash_bbbb',
  boardRev: 4,
  lifecycleRev: 2,
  generatedAt: '2026-07-14T12:00:00.000Z',
  freshnessAgeSeconds: 30,
  stale: false,
  staleReason: null,
}

function emptyAgg(
  overrides: Partial<ControlCenterAggregation> = {},
): ControlCenterAggregation {
  return {
    pin: PIN,
    workRows: [],
    projects: [],
    features: [],
    decisions: [],
    auditEvents: [],
    agents: [],
    opsAccounts: [],
    g5Domains: [],
    rollup: null,
    priority: null,
    ...overrides,
  } as ControlCenterAggregation
}

describe('isAffiliateDomainId', () => {
  it('matches AFFILIATE aliases', () => {
    expect(isAffiliateDomainId('AFFILIATE')).toBe(true)
    expect(isAffiliateDomainId('affiliate')).toBe(true)
    expect(isAffiliateDomainId('AFF')).toBe(true)
    expect(isAffiliateDomainId('affiliate-rebuild')).toBe(true)
    expect(isAffiliateDomainId('PAYMENTS')).toBe(false)
    expect(isAffiliateDomainId('')).toBe(false)
  })
})

describe('buildAffiliateDomainKnowledgeBundle', () => {
  it('produces domainId AFFILIATE with coverageManifest and knowledgeGaps', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    expect(b.domainId).toBe(AFFILIATE_DOMAIN_ID)
    expect(b.schemaVersion).toBe('DOMAIN_KNOWLEDGE_BUNDLE_V1')
    expect(b.generatedAt).toBe(AFFILIATE_BUNDLE_GENERATED_AT)
    expect(Array.isArray(b.coverageManifest)).toBe(true)
    expect(b.coverageManifest.length).toBeGreaterThan(0)
    expect(b.knowledgeGaps).not.toBeNull()
    expect(b.knowledgeGaps.length).toBeGreaterThan(0)
    expect(b.projects.length).toBeGreaterThanOrEqual(5)
    expect(b.features.length).toBeGreaterThanOrEqual(8)
    expect(b.flows.length).toBeGreaterThanOrEqual(3)
    expect(b.relations.length).toBeGreaterThanOrEqual(5)
  })

  it('is deterministic for the same inputs', () => {
    const a = buildAffiliateDomainKnowledgeBundle()
    const b = buildAffiliateDomainKnowledgeBundle()
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })

  it('coverage dispositions cover expected | included | redacted | unknown | conflict | omitted-with-reason', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    const dispositions = new Set(b.coverageManifest.map((c) => c.disposition))
    expect(dispositions.has('included')).toBe(true)
    expect(dispositions.has('expected')).toBe(true)
    expect(dispositions.has('redacted')).toBe(true)
    expect(dispositions.has('unknown')).toBe(true)
    expect(dispositions.has('conflict')).toBe(true)
    expect(dispositions.has('omitted-with-reason')).toBe(true)
  })

  it('accounts for every known project, feature, and flow with no silent omission', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    const included = new Set(
      b.coverageManifest
        .filter((row) => row.disposition === 'included')
        .map(
          (row) =>
            `${row.kind}:${row.id.replace(/^cov-(?:project|feature|flow)-/, '')}`,
        ),
    )
    for (const project of b.projects)
      expect(included.has(`project:${project.id}`)).toBe(true)
    for (const feature of b.features)
      expect(included.has(`feature:${feature.id}`)).toBe(true)
    for (const flow of b.flows)
      expect(included.has(`flow:${flow.id}`)).toBe(true)
    for (const row of b.coverageManifest.filter(
      (item) => item.disposition !== 'included',
    )) {
      expect(row.reason, row.id).toBeTruthy()
    }
    expect(
      b.citations.every((citation) => citation.field && citation.path),
    ).toBe(true)
  })

  it('covers required outcomes and keeps every relation endpoint resolvable', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    const outcomes = new Set(b.flows.flatMap((flow) => flow.outcomes))
    for (const outcome of [
      'success',
      'fail',
      'expired',
      'refund',
      'revoke',
      'recurring',
    ]) {
      expect(outcomes.has(outcome), outcome).toBe(true)
    }
    const ids = new Set([
      b.domainId,
      ...b.projects.map((row) => row.id),
      ...b.features.map((row) => row.id),
      ...b.flows.map((row) => row.id),
      ...b.entities.map((row) => row.id),
    ])
    for (const relation of b.relations) {
      expect(ids.has(relation.fromId), `${relation.id}:from`).toBe(true)
      expect(ids.has(relation.toId), `${relation.id}:to`).toBe(true)
    }
  })

  it('cross-project graph spans portal, Sales, backend, public web, payment', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    const ids = new Set(b.projects.map((p) => p.id))
    expect(ids.has('affiliate-rebuild')).toBe(true)
    expect(ids.has('sales-rebuild')).toBe(true)
    expect(ids.has('rebuild-backend')).toBe(true)
    expect(ids.has('mfs-web-original-upgrade')).toBe(true)
    expect(ids.has('payment-provider')).toBe(true)
  })

  it('availability is partial when unknown coverage entries exist (honest gaps)', () => {
    const b = buildAffiliateDomainKnowledgeBundle()
    expect(b.availability).toBe('partial')
    expect(b.statusRollup.gapCount).toBe(b.knowledgeGaps.length)
  })

  it('pinHits enrich tasks/decisions and append pin gap codes when empty', () => {
    const withHits = buildAffiliateDomainKnowledgeBundle({
      pinHits: {
        tasks: [
          {
            taskId: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
            title: 'Expired unpaid',
            bucket: 'BLOCKED',
            ownerPrimaryTitle: 'Komisi kedaluwarsa',
          },
        ],
        decisions: [
          { decisionId: 'D-AFF-1', title: 'Tahan payout', status: 'OPEN' },
        ],
        evidence: [{ id: 'ev-1', kind: 'receipt', summary: 'proof' }],
      },
    })
    expect(
      withHits.blockers.some((x) => x.id === 'T-AFF-N16-MONEY-EXPIRED-UNPAID'),
    ).toBe(true)
    expect(withHits.decisions).toHaveLength(1)
    expect(
      withHits.knowledgeGaps.every((g) => g.code !== 'NO_MATCHING_PIN_TASKS'),
    ).toBe(true)

    const emptyPin = buildAffiliateDomainKnowledgeBundle({
      pinHits: { tasks: [], decisions: [], evidence: [] },
    })
    const codes = emptyPin.knowledgeGaps.map((g) => g.code)
    expect(codes).toContain('NO_MATCHING_PIN_TASKS')
    expect(codes).toContain('NO_MATCHING_PIN_DECISIONS')
    expect(codes).toContain('NO_MATCHING_PIN_EVIDENCE')
  })
})

describe('staging fixture domain-affiliate.bundle.json', () => {
  it('matches acceptance shape and pack domainId', () => {
    const raw = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8')) as Record<
      string,
      unknown
    >
    expect(raw.domainId).toBe('AFFILIATE')
    expect(raw.coverageManifest).toBeDefined()
    expect(raw.knowledgeGaps).not.toBeNull()
    expect(Array.isArray(raw.coverageManifest)).toBe(true)
    expect(Array.isArray(raw.knowledgeGaps)).toBe(true)
  })

  it('matches pure buildAffiliateDomainKnowledgeBundle() output', () => {
    const fixture = JSON.parse(readFileSync(FIXTURE_PATH, 'utf8'))
    const built = buildAffiliateDomainKnowledgeBundle()
    expect(fixture).toEqual(built)
  })
})

describe('affiliateBundleToKnowledgeDomainData / documentation', () => {
  it('maps pack into knowledge domain payload with coverageManifest', () => {
    const bundle = buildAffiliateDomainKnowledgeBundle()
    const data = affiliateBundleToKnowledgeDomainData(bundle)
    expect(data.domainId).toBe('AFFILIATE')
    expect(
      data.availability === 'available' || data.availability === 'partial',
    ).toBe(true)
    expect(data.coverageManifest.length).toBeGreaterThan(0)
    expect(data.knowledgeGaps.length).toBeGreaterThan(0)
    expect(data.projects.length).toBeGreaterThanOrEqual(5)
    expect(data.bundle.domainId).toBe('AFFILIATE')
  })

  it('builds non-empty documentation markdown with project span', () => {
    const bundle = buildAffiliateDomainKnowledgeBundle()
    const md = affiliateBundleToDocumentationMarkdown(bundle)
    expect(md).toContain('# Dokumentasi domain: Affiliate')
    expect(md).toContain('Portal Affiliate')
    expect(md).toContain('Coverage manifest')
    expect(md).toContain('/a/{code}')
  })
})

describe('projectKnowledgeDomainFromAgg AFFILIATE overlay', () => {
  it('returns non-unavailable AFFILIATE pack even on empty pin', () => {
    const env = projectKnowledgeDomainFromAgg(emptyAgg(), 'AFFILIATE')
    const data = env.data as {
      availability: string
      domainId: string
      coverageManifest: unknown[]
      knowledgeGaps: unknown[]
      projects: unknown[]
      conflicts: Array<{ sourceId: string; label: string }>
      redactions: Array<{ fieldPath: string; reason: string }>
      knowledgeState: string
    }
    expect(data.domainId).toBe('AFFILIATE')
    expect(data.availability).not.toBe('unavailable')
    expect(data.coverageManifest.length).toBeGreaterThan(0)
    expect(data.knowledgeGaps).not.toBeNull()
    expect(data.projects.length).toBeGreaterThanOrEqual(5)
    // TM-08: multi-source CONFLICT + redaction pass-through
    expect(data.conflicts.length).toBeGreaterThanOrEqual(2)
    expect(data.redactions.length).toBeGreaterThanOrEqual(1)
    expect(data.knowledgeState).toBe('CONFLICT')

    const vm = knowledgeDomainEnvelopeToViewModel(
      env as PinnedEnvelope<unknown>,
      {
        boardId: 'mfs-rebuild',
        domain: 'AFFILIATE',
      },
    )
    expect(vm.availability).not.toBe('unavailable')
    expect(vm.coverageManifest).not.toBeNull()
    expect(vm.knowledgeGaps).not.toBeNull()
    expect(vm.domainId).toBe('AFFILIATE')
    expect(vm.conflictSources.length).toBeGreaterThanOrEqual(2)
    expect(vm.redactions.length).toBeGreaterThanOrEqual(1)
    expect(vm.knowledgeState).toBe('CONFLICT')
  })

  it('merges pin task hits into AFFILIATE knowledge payload', () => {
    const agg = emptyAgg({
      workRows: [
        {
          taskId: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
          title: 'Expired unpaid',
          projectId: null,
          featureId: null,
          bucket: 'BLOCKED',
          overlays: [],
          blockReason: null,
          outsideTracked: false,
          lifecycleStage: null,
          targetGate: null,
          claimState: null,
          createdAt: PIN.generatedAt,
          id: 'T-AFF-N16-MONEY-EXPIRED-UNPAID',
        },
      ] as ControlCenterAggregation['workRows'],
    })
    const env = projectKnowledgeDomainFromAgg(agg, 'AFFILIATE')
    const data = env.data as {
      tasks: Array<{ taskId: string }>
      availability: string
    }
    expect(
      data.tasks.some((t) => t.taskId === 'T-AFF-N16-MONEY-EXPIRED-UNPAID'),
    ).toBe(true)
    expect(data.availability).not.toBe('unavailable')
  })

  it('non-AFFILIATE domain stays unavailable on empty pin', () => {
    const env = projectKnowledgeDomainFromAgg(emptyAgg(), 'PAYMENTS')
    expect((env.data as { availability: string }).availability).toBe(
      'unavailable',
    )
  })
})

describe('projectDocumentationDomainFromAgg AFFILIATE', () => {
  it('returns markdown + coverage on empty pin (not unavailable)', () => {
    const env = projectDocumentationDomainFromAgg(emptyAgg(), 'AFFILIATE')
    const data = env.data as {
      availability: string
      bodyMarkdown: string
      coverageManifest: unknown
      knowledgeGaps: unknown
      citations: unknown[]
    }
    expect(data.availability).not.toBe('unavailable')
    expect(data.bodyMarkdown.length).toBeGreaterThan(100)
    expect(data.coverageManifest).not.toBeNull()
    expect(data.knowledgeGaps).not.toBeNull()
    expect(data.citations.length).toBeGreaterThan(0)

    const vm = documentationDomainEnvelopeToViewModel(
      env as PinnedEnvelope<unknown>,
      {
        boardId: 'mfs-rebuild',
        domain: 'AFFILIATE',
      },
    )
    expect(vm.availability).not.toBe('unavailable')
    expect(vm.bodyMarkdown).toContain('Affiliate')
    expect(vm.coverageManifest).not.toBeNull()
  })
})
