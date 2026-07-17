/**
 * Product knowledge MCP tools — fixture-based unit tests (no live DB required).
 */
import { afterEach, describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'

import {
  DEFAULT_KNOWLEDGE_BUNDLE_PATH,
  DEPLOYED_FLOW_DATA_REL,
  expandQueryTerms,
  getEndpointBundle,
  getFeatureBundle,
  getFlow,
  KNOWLEDGE_TOOL_AUTH_SPECS,
  listKnowledgeToolNames,
  loadKnowledgeCorpusFromJson,
  resetKnowledgeCorpusCache,
  resolveKnowledgeBundlePath,
  searchKnowledge,
  setKnowledgeCorpusForTests,
  type KnowledgeCorpus,
} from '#/server/knowledge-tools'
import { authorizeToolCall, MCP_TOOL_SPECS } from '#/server/rbac'
import type { Principal } from '#/server/rbac'

function isFlowDataPath(p: string): boolean {
  return (
    p.includes(join('public', 'flow-data')) ||
    p.includes(join('client', 'flow-data')) ||
    p.endsWith('flow-data')
  )
}

function boardReadPrincipal(): Principal {
  return {
    role: 'ROOT_ORCHESTRATOR',
    actorId: 'test-root',
    channel: 'bearer',
    scopes: ['board:read', 'task:read'],
    boards: [],
  }
}

function fixtureCorpus(): KnowledgeCorpus {
  return {
    features: [
      {
        id: 'FEAT-SIKLUS-HAID',
        nama_id: 'Pelacak Haid',
        area: 'Kesehatan & Wellness',
        ringkasan_id: 'Pelacak siklus haid dengan data sensitif (PII), onboarding, gejala, dan pengingat privat.',
        doc_md:
          '## Apa ini\n\n**Pelacak siklus menstruasi** (period tracker) untuk member. Onboarding siklus, kalender, gejala, pengingat privat.',
        screens: ['PeriodTracker', 'PeriodChooseCycle', 'LogPeriodCalendar', 'period_tracker'],
        status: 'terbukti',
        task_ids: ['T-RN-PERIOD', 'T-MOBILE-PERIOD'],
        fc_refs: ['FC-RN-WELLNESS-SUITE'],
        project_ids: ['rn', 'backend'],
      },
      {
        id: 'FEAT-PAYWALL',
        nama_id: 'Paywall & Status Premium',
        area: 'Pembayaran & Langganan',
        ringkasan_id: 'Gerbang premium dan status langganan member.',
        doc_md: 'Paywall mengontrol akses konten premium.',
        screens: ['landingPremium', 'paymentScreen', '/premium'],
        status: 'sebagian',
        task_ids: ['T-WEB-PREMIUM'],
        project_ids: ['web-member', 'rn'],
      },
      {
        id: 'FEAT-MEDITATION',
        nama_id: 'Meditasi',
        area: 'Kesehatan & Wellness',
        ringkasan_id: 'Katalog meditasi terpandu.',
        screens: ['MeditationDiscover'],
        task_ids: ['T-RN-MEDITATION'],
        project_ids: ['rn'],
      },
    ],
    pages: [
      {
        id: 'rn-period-tracker',
        label_id: 'Period Tracker',
        route_or_screen: 'PeriodTracker',
        api_calls: [
          { method: 'GET', path: '/api/v1/period/cycles' },
          { method: 'POST', path: '/api/v1/period/cycles' },
        ],
        feature_id: 'FEAT-SIKLUS-HAID',
        area: 'Kesehatan & Wellness',
      },
      {
        id: 'web-premium',
        label_id: 'Halaman Premium',
        route_or_screen: '/premium',
        api_calls: [{ method: 'GET', path: '/api/web/v1/premium/packages' }],
        feature_id: 'FEAT-PAYWALL',
        area: 'Pembayaran',
      },
    ],
    endpoints: [
      {
        id: 'be-get-period-cycles',
        method: 'GET',
        path: '/api/v1/period/cycles',
        domain_id: 'Kesehatan & Wellness',
        label_id: 'Ambil siklus period tracker',
        controller: 'PeriodCycleController@index',
        repo: 'rebuild-backend',
      },
      {
        id: 'be-post-period-cycles',
        method: 'POST',
        path: '/api/v1/period/cycles',
        domain_id: 'Kesehatan & Wellness',
        label_id: 'Buat siklus period tracker',
        controller: 'PeriodCycleController@store',
        repo: 'rebuild-backend',
      },
      {
        id: 'be-get-premium-packages',
        method: 'GET',
        path: '/api/web/v1/premium/packages',
        domain_id: 'Pembayaran',
        label_id: 'Daftar paket premium',
        repo: 'rebuild-backend',
      },
    ],
    tasks: [
      {
        id: 'T-RN-PERIOD',
        judul_id: 'RN period tracker screens + API contract',
        verdict: 'MAPPED_100',
        feature_id: 'FEAT-SIKLUS-HAID',
        project_id: 'rn',
      },
      {
        id: 'T-MOBILE-PERIOD',
        judul_id: 'Mobile period module',
        verdict: 'MAPPED_100',
        feature_id: 'FEAT-SIKLUS-HAID',
        project_id: 'rn',
      },
      {
        id: 'T-WEB-PREMIUM',
        judul_id: 'Web /premium pricing page',
        verdict: 'PARTIAL',
        feature_id: 'FEAT-PAYWALL',
        project_id: 'web-member',
      },
    ],
    units: [
      {
        unit_id: 'FU-PERIOD-1',
        feature_contract_id: 'FC-RN-WELLNESS-SUITE',
        unit_type: 'rn_api_call',
        identifier: 'apiRequest.fetchPeriodNoteList',
        notes: 'Panggilan API ambil daftar catatan siklus haid',
        repo: 'rn-mfs81',
      },
    ],
    flows: [
      {
        id: 'rn',
        project_id: 'rn',
        kind: 'project',
        nodes: [
          { id: 'Login', label_id: 'Login', kind: 'screen', sort_order: 0 },
          {
            id: 'PeriodTracker',
            label_id: 'Period Tracker',
            feature_id: 'FEAT-SIKLUS-HAID',
            kind: 'screen',
            sort_order: 1,
          },
        ],
        edges: [
          {
            id: 'Login__PeriodTracker',
            from: 'Login',
            to: 'PeriodTracker',
            kind: 'nav',
          },
        ],
        source: 'fixture',
      },
      {
        id: 'premium',
        name: 'Pembelian Premium (lintas-sistem)',
        desc: 'Sales set harga → Web checkout → webhook',
        kind: 'lintas',
        nodes: [
          { id: 'step-1', label_id: 'Sales set paket', kind: 'input', sort_order: 1 },
          { id: 'step-2', label_id: '/premium pricing', kind: 'page', sort_order: 2 },
        ],
        edges: [{ id: 'step-1__step-2', from: 'step-1', to: 'step-2', kind: 'sequence' }],
        source: 'fixture',
      },
    ],
    source: {
      kind: 'injected',
      detail: 'unit fixture corpus',
    },
  }
}

afterEach(() => {
  resetKnowledgeCorpusCache()
})

describe('knowledge-tools catalog', () => {
  it('exports the four contract tool names', () => {
    expect([...listKnowledgeToolNames()]).toEqual([
      'search_knowledge',
      'get_feature_bundle',
      'get_endpoint_bundle',
      'get_flow',
    ])
  })
})

describe('expandQueryTerms EN↔ID', () => {
  it('expands period tracker to haid terms', () => {
    const terms = expandQueryTerms('period tracker')
    expect(terms.some((t) => t.includes('haid') || t.includes('pelacak'))).toBe(true)
    expect(terms.some((t) => t.includes('period'))).toBe(true)
  })
})

describe('search_knowledge (fixture)', () => {
  it('ranks period tracker hits with feature type', async () => {
    const corpus = fixtureCorpus()
    setKnowledgeCorpusForTests(corpus)
    const res = await searchKnowledge('period tracker', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.hits.length).toBeGreaterThan(0)
    expect(res.searchReal).toBe(true)
    const featureHit = res.hits.find((h) => h.type === 'feature' && h.id === 'FEAT-SIKLUS-HAID')
    expect(featureHit).toBeTruthy()
    expect(featureHit!.score).toBeGreaterThan(40)
    expect(res.hits[0]!.score).toBeGreaterThanOrEqual(res.hits[res.hits.length - 1]!.score)
    // types present in ranked list
    const types = new Set(res.hits.map((h) => h.type))
    expect(types.has('feature')).toBe(true)
  })

  it('finds premium via /premium and alias', async () => {
    const corpus = fixtureCorpus()
    const res = await searchKnowledge('/premium', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    const hit = res.hits.find(
      (h) =>
        (h.type === 'feature' && h.id === 'FEAT-PAYWALL') ||
        (h.type === 'page' && h.id === 'web-premium') ||
        (h.type === 'flow' && h.id === 'premium'),
    )
    expect(hit).toBeTruthy()
  })

  it('rejects empty query', async () => {
    const res = await searchKnowledge('  ', { corpus: fixtureCorpus() })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('INVALID_INPUT')
  })
})

describe('get_feature_bundle (fixture)', () => {
  it('returns complete one-shot bundle by id', async () => {
    const corpus = fixtureCorpus()
    const res = await getFeatureBundle('FEAT-SIKLUS-HAID', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.feature.nama_id).toBe('Pelacak Haid')
    expect(res.feature.doc_md).toMatch(/period tracker/i)
    expect(res.pages.some((p) => p.route_or_screen === 'PeriodTracker')).toBe(true)
    expect(res.endpoints.some((e) => e.path.includes('period'))).toBe(true)
    expect(res.tasks.some((t) => t.id === 'T-RN-PERIOD' && t.verdict === 'MAPPED_100')).toBe(true)
    expect(res.units.some((u) => u.unit_id === 'FU-PERIOD-1')).toBe(true)
    expect(res.related_features.some((f) => f.id === 'FEAT-MEDITATION')).toBe(true)
  })

  it('resolves by human name / alias query', async () => {
    const corpus = fixtureCorpus()
    const res = await getFeatureBundle('period tracker', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.feature.id).toBe('FEAT-SIKLUS-HAID')
  })

  it('returns NOT_FOUND for unknown feature', async () => {
    const res = await getFeatureBundle('FEAT-DOES-NOT-EXIST', { corpus: fixtureCorpus() })
    expect(res.ok).toBe(false)
    if (res.ok) return
    expect(res.code).toBe('NOT_FOUND')
  })
})

describe('get_endpoint_bundle (fixture)', () => {
  it('returns endpoint + callers + features + domain', async () => {
    const corpus = fixtureCorpus()
    const res = await getEndpointBundle('GET /api/v1/period/cycles', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.endpoint.method).toBe('GET')
    expect(res.endpoint.path).toBe('/api/v1/period/cycles')
    expect(res.callers.some((p) => p.id === 'rn-period-tracker')).toBe(true)
    expect(res.features.some((f) => f.id === 'FEAT-SIKLUS-HAID')).toBe(true)
    expect(res.domain).toBe('Kesehatan & Wellness')
  })
})

describe('get_flow (fixture)', () => {
  it('returns project flow nodes+edges', async () => {
    const corpus = fixtureCorpus()
    const res = await getFlow('rn', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.flow.kind).toBe('project')
    expect(res.flow.nodes.length).toBeGreaterThanOrEqual(2)
    expect(res.flow.edges.length).toBeGreaterThanOrEqual(1)
  })

  it('returns lintas premium graph', async () => {
    const corpus = fixtureCorpus()
    const res = await getFlow('premium', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.flow.kind).toBe('lintas')
    expect(res.flow.nodes.length).toBeGreaterThanOrEqual(2)
    expect(res.flow.edges.every((e) => e.from && e.to)).toBe(true)
  })

  it('resolves lintas alias to a cross-system flow', async () => {
    const corpus = fixtureCorpus()
    const res = await getFlow('lintas', { corpus })
    expect(res.ok).toBe(true)
    if (!res.ok) return
    expect(res.flow.kind).toBe('lintas')
  })
})

describe('deployed public/flow-data corpus (no absolute external paths)', () => {
  const flowDataDir = join(process.cwd(), DEPLOYED_FLOW_DATA_REL)

  it('default bundle path resolves under public/flow-data (not tm-wave0 job path)', () => {
    const resolved = resolveKnowledgeBundlePath()
    expect(resolved).toContain(join('public', 'flow-data'))
    expect(resolved.includes('/home/user/.claude')).toBe(false)
    expect(resolved.includes('tm-wave0')).toBe(false)
    // DEFAULT constant must also avoid absolute VPS job paths
    expect(DEFAULT_KNOWLEDGE_BUNDLE_PATH.includes('/home/user/.claude')).toBe(false)
    expect(DEFAULT_KNOWLEDGE_BUNDLE_PATH.includes('tm-wave0')).toBe(false)
  })

  it('resolves corpus when cwd is not the app root (prod pm2 / nested cwd)', () => {
    const prev = process.cwd()
    try {
      // Simulate pm2 cwd outside app (or nested) — import.meta-relative roots still find public/flow-data
      process.chdir('/tmp')
      const resolved = resolveKnowledgeBundlePath()
      expect(isFlowDataPath(resolved)).toBe(true)
      expect(resolved.includes('/home/user/.claude')).toBe(false)
      const corpus = loadKnowledgeCorpusFromJson(resolved)
      expect(corpus.features.length).toBeGreaterThan(10)
    } finally {
      process.chdir(prev)
    }
  })

  it('auth specs for get_feature_bundle match search_knowledge (board:read)', () => {
    const search = KNOWLEDGE_TOOL_AUTH_SPECS.find((s) => s.name === 'search_knowledge')
    const bundle = KNOWLEDGE_TOOL_AUTH_SPECS.find((s) => s.name === 'get_feature_bundle')
    expect(search).toBeTruthy()
    expect(bundle).toBeTruthy()
    expect(search!.kind).toBe('read')
    expect(bundle!.kind).toBe('read')
    expect([...search!.scopes]).toEqual([...bundle!.scopes])
    expect(search!.scopes).toContain('board:read')
  })

  it('MCP_TOOL_SPECS catalogs get_feature_bundle with same board:read gate as search_knowledge', () => {
    const names = MCP_TOOL_SPECS.map((t) => t.name)
    expect(names).toContain('search_knowledge')
    expect(names).toContain('get_feature_bundle')
    expect(names).toContain('get_endpoint_bundle')
    expect(names).toContain('get_flow')
    const principal = boardReadPrincipal()
    for (const tool of [
      'search_knowledge',
      'get_feature_bundle',
      'get_endpoint_bundle',
      'get_flow',
    ] as const) {
      const gate = authorizeToolCall(principal, tool, {})
      expect(gate.ok, `${tool} should authorize board:read principal`).toBe(true)
    }
    // Regression: missing catalog entry used to yield 401 AUTHORIZATION_REQUIRED
    // even with a valid bearer (unknown tool), while search_knowledge worked.
    const unauth = authorizeToolCall(null, 'get_feature_bundle', {})
    expect(unauth.ok).toBe(false)
    expect(unauth.code).toBe('AUTHORIZATION_REQUIRED')
  })


  it(
    'loads corpus from public/flow-data and finds period tracker',
    async () => {
      expect(existsSync(join(flowDataDir, 'data-bundle.json'))).toBe(true)
      expect(existsSync(join(flowDataDir, 'graph.json'))).toBe(true)
      // Prefer deployable knowledge.json when present (no absolute external paths)
      const hasKnowledge = existsSync(join(flowDataDir, 'knowledge.json'))

      const corpus = loadKnowledgeCorpusFromJson(flowDataDir)
      expect(corpus.source.kind).toBe('json_bundle')
      expect(corpus.source.bundlePath).toBe(flowDataDir)
      expect(corpus.source.detail).toMatch(/flow-data|knowledge\.json/)
      // Must not claim a missing absolute job path
      expect(corpus.source.detail.includes('/home/user/.claude')).toBe(false)
      expect(String(corpus.source.bundlePath ?? '')).not.toMatch(
        /\/home\/user\/\.claude|tm-wave0/,
      )
      if (hasKnowledge) {
        expect(corpus.source.detail).toMatch(/knowledge\.json/)
      }
      expect(corpus.features.length).toBeGreaterThan(10)
      expect(corpus.pages.length).toBeGreaterThan(10)
      expect(corpus.endpoints.length).toBeGreaterThan(10)
      expect(corpus.tasks.length).toBeGreaterThan(10)

      const res = await searchKnowledge('period tracker', { corpus, limit: 15 })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      const featureHit = res.hits.find(
        (h) =>
          h.type === 'feature' &&
          (h.id === 'FEAT-SIKLUS-HAID' || /haid|period/i.test(h.label)),
      )
      expect(featureHit, JSON.stringify(res.hits.slice(0, 5), null, 2)).toBeTruthy()
      // Real data signal for clients (non-empty hits + json_bundle source)
      expect(res.hits.length).toBeGreaterThan(0)
      expect(res.searchReal).toBe(true)
      expect(res.source.kind).toBe('json_bundle')
      expect(res.source.bundlePath).toBe(flowDataDir)
      expect(String(res.source.bundlePath ?? '')).not.toMatch(/\/home\/user\/\.claude|tm-wave0/)

      const bundle = await getFeatureBundle('FEAT-SIKLUS-HAID', { corpus })
      expect(bundle.ok).toBe(true)
      if (!bundle.ok) return
      expect(bundle.feature.id).toBe('FEAT-SIKLUS-HAID')
      expect(bundle.feature.nama_id).toMatch(/haid|period/i)
      expect((bundle.feature.screens ?? []).length + bundle.pages.length).toBeGreaterThan(0)
      expect(bundle.tasks.length).toBeGreaterThan(0)
      // Handler is pure — ok:true, never auth error envelope (live 401 is MCP catalog/RBAC, not handler)
      expect((bundle as { code?: string }).code).toBeUndefined()
      expect((bundle as { error?: string }).error).toBeUndefined()
      expect(bundle.ok).toBe(true)
    },
    30_000,
  )

  it(
    'get_feature_bundle by human name uses same pure corpus path as search',
    async () => {
      const corpus = loadKnowledgeCorpusFromJson(flowDataDir)
      const res = await getFeatureBundle('period tracker', { corpus })
      expect(res.ok).toBe(true)
      if (!res.ok) return
      expect(res.feature.id).toBe('FEAT-SIKLUS-HAID')
      expect(res.source.kind).toBe('json_bundle')
      // Same board:read auth class as search_knowledge (no secondary HTTP/auth in handler)
      const searchSpec = KNOWLEDGE_TOOL_AUTH_SPECS.find((s) => s.name === 'search_knowledge')!
      const bundleSpec = KNOWLEDGE_TOOL_AUTH_SPECS.find((s) => s.name === 'get_feature_bundle')!
      expect(bundleSpec.scopes).toEqual(searchSpec.scopes)
      expect(bundleSpec.kind).toBe(searchSpec.kind)
    },
    30_000,
  )

  it(
    'refuses absolute VPS job paths even when TM_KNOWLEDGE_BUNDLE_PATH is poisoned',
    () => {
      const prev = process.env.TM_KNOWLEDGE_BUNDLE_PATH
      try {
        process.env.TM_KNOWLEDGE_BUNDLE_PATH =
          '/home/user/.claude/jobs/3c5adda9/tmp/tm-wave0/DESIGN-CANON-V3/data'
        const resolved = resolveKnowledgeBundlePath()
        expect(resolved).toContain(join('public', 'flow-data'))
        expect(resolved.includes('/home/user/.claude')).toBe(false)
        expect(resolved.includes('tm-wave0')).toBe(false)
        const corpus = loadKnowledgeCorpusFromJson(resolved)
        expect(corpus.features.length).toBeGreaterThan(10)
      } finally {
        if (prev === undefined) delete process.env.TM_KNOWLEDGE_BUNDLE_PATH
        else process.env.TM_KNOWLEDGE_BUNDLE_PATH = prev
      }
    },
    30_000,
  )
})
