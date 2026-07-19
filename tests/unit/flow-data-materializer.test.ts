/**
 * FlowDataBundle materializer unit tests — injectable memory SQL only.
 * No live MySQL. No secrets. LOCAL ONLY.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { FlowDataBundle } from '#/components/flow-ultimate/types'
import {
  CANON_UI_PROJECT_IDS,
  normalizeCanonProjectId,
} from '#/lib/canon-flow-projects'
import {
  DEFAULT_FLOW_BOARD_ID,
  MATERIALIZER_VERSION,
  PREMIUM_FLOW_V1,
  emptyFlowDataBundle,
  getFlowDataBundleCacheKey,
  materializeFromMysql,
  platformJsonToUiProjects,
  redactSecrets,
  repositoryToUiProject,
  resetFlowDataBundleCache,
  resolveFlowDataBundle,
  rollupVerdicts,
  sha256Hex,
  stableStringify,
  storageProjectIdToUi,
  type FlowDataSqlExecutor,
} from '#/server/flow-data-materializer'

// ---------------------------------------------------------------------------
// Memory corpus / fake executor
// ---------------------------------------------------------------------------

type Corpus = {
  tables: Set<string>
  product_features: Array<Record<string, unknown>>
  feature_task_map: Array<Record<string, unknown>>
  rebuild_lineage_records: Array<Record<string, unknown>>
  feature_directory: Array<Record<string, unknown>>
  feature_units: Array<Record<string, unknown>>
  parity_rollups: Array<Record<string, unknown>>
  app_flow_nodes: Array<Record<string, unknown>>
  app_flow_edges: Array<Record<string, unknown>>
  app_pages: Array<Record<string, unknown>>
  nav_edges: Array<Record<string, unknown>>
  api_endpoints: Array<Record<string, unknown>>
  page_api_calls: Array<Record<string, unknown>>
}

function baseCorpus(over: Partial<Corpus> = {}): Corpus {
  const tables = new Set(
    over.tables ?? [
      'product_features',
      'feature_task_map',
      'rebuild_lineage_records',
      'parity_rollups',
      'feature_units',
      'feature_directory',
      'app_flow_nodes',
      'app_flow_edges',
      'app_pages',
      'nav_edges',
      'api_endpoints',
      'page_api_calls',
    ],
  )
  return {
    tables,
    product_features: over.product_features ?? [],
    feature_task_map: over.feature_task_map ?? [],
    rebuild_lineage_records: over.rebuild_lineage_records ?? [],
    feature_directory: over.feature_directory ?? [],
    feature_units: over.feature_units ?? [],
    parity_rollups: over.parity_rollups ?? [],
    app_flow_nodes: over.app_flow_nodes ?? [],
    app_flow_edges: over.app_flow_edges ?? [],
    app_pages: over.app_pages ?? [],
    nav_edges: over.nav_edges ?? [],
    api_endpoints: over.api_endpoints ?? [],
    page_api_calls: over.page_api_calls ?? [],
  }
}

function fixtureCorpus(): Corpus {
  return baseCorpus({
    product_features: [
      {
        feature_id: 'FEAT-AUTH-MEMBER',
        nama_id: 'Auth Member',
        domain_bisnis: 'Akun & Profil',
        ringkasan_id: 'Login member',
        platform_json: { rn: true, web: true, admin: true, backend: true },
        fc_refs_json: ['FC-AUTH'],
        curated: 1,
      },
      {
        feature_id: 'FEAT-AFFILIATE',
        nama_id: 'Afiliasi',
        domain_bisnis: 'Sosial & Komunitas',
        ringkasan_id: 'Portal afiliasi',
        platform_json: { web: true, admin: true, backend: true },
        fc_refs_json: ['FC-AFF'],
        curated: 0,
      },
      {
        feature_id: 'FEAT-ADMIN-ONLY',
        nama_id: 'Admin only',
        domain_bisnis: 'Admin & Operasional',
        ringkasan_id: null,
        platform_json: { admin: true },
        fc_refs_json: ['FC-ADM'],
        curated: 0,
      },
    ],
    feature_task_map: [
      {
        feature_id: 'FEAT-AUTH-MEMBER',
        task_id: 'T-AUTH-1',
        join_source: 'curated',
        confidence: 1,
      },
      {
        feature_id: 'FEAT-AUTH-MEMBER',
        task_id: 'T-AUTH-2',
        join_source: 'fc',
        confidence: 1,
      },
      {
        feature_id: 'FEAT-AFFILIATE',
        task_id: 'T-AFF-1',
        join_source: 'keyword',
        confidence: 0.4,
      },
      {
        feature_id: 'FEAT-ADMIN-ONLY',
        task_id: 'T-ADM-1',
        join_source: 'prefix',
        confidence: 0.6,
      },
    ],
    rebuild_lineage_records: [
      {
        board_id: 'mfs-rebuild',
        task_id: 'T-AUTH-1',
        repository: 'legacy/rn-mfs81',
        parity_verdict: 'MAPPED_100',
        source_hash: 'a'.repeat(64),
        synced_at: '2026-07-10T12:00:00.000Z',
        stage1_json: { title: 'Auth mobile' },
        implementation_json: null,
      },
      {
        board_id: 'mfs-rebuild',
        task_id: 'T-AUTH-2',
        repository: 'mfs-web-original-upgrade',
        parity_verdict: 'PARTIAL',
        source_hash: 'b'.repeat(64),
        synced_at: '2026-07-11T12:00:00.000Z',
        stage1_json: null,
        implementation_json: null,
      },
      {
        board_id: 'mfs-rebuild',
        task_id: 'T-AFF-1',
        repository: 'affiliate-rebuild',
        parity_verdict: 'MISSING',
        source_hash: 'c'.repeat(64),
        synced_at: '2026-07-09T12:00:00.000Z',
      },
      {
        board_id: 'mfs-rebuild',
        task_id: 'T-ADM-1',
        repository: 'sales-rebuild',
        parity_verdict: 'MAPPED_100',
        source_hash: 'd'.repeat(64),
        synced_at: '2026-07-12T12:00:00.000Z',
      },
      {
        board_id: 'other-board',
        task_id: 'T-OTHER',
        repository: 'rebuild-backend',
        parity_verdict: 'MAPPED_100',
        source_hash: 'e'.repeat(64),
        synced_at: '2026-07-12T12:00:00.000Z',
      },
    ],
    feature_directory: [
      {
        feature_contract_id: 'FC-AUTH',
        judul_id: 'Auth FC',
        ringkasan_id: 'Dir ringkasan auth',
        doc_md: '# Auth docs',
        source_hash: 'f'.repeat(64),
        synced_at: '2026-07-01T00:00:00.000Z',
      },
    ],
    feature_units: [
      {
        unit_id: 'U1',
        feature_contract_id: 'FC-AUTH',
        unit_type: 'screen',
        identifier: 'LoginScreen',
        source_hash: 'g'.repeat(64),
      },
    ],
    parity_rollups: [
      {
        id: 42,
        captured_at: '2026-07-12T15:00:00.000Z',
        source_hash: 'h'.repeat(64),
        mapped_100: 10,
        partial_n: 2,
        missing_n: 1,
        total_n: 13,
      },
    ],
    app_flow_nodes: [
      {
        project_id: 'web',
        node_id: 'n1',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Login Web',
        kind: 'screen',
        sort_order: 1,
        layout_col: 0,
        layout_row: 0,
        source_ref: null,
        meta_json: { route: '/login' },
      },
      {
        project_id: 'web',
        node_id: 'n1b',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Login Next',
        kind: 'screen',
        sort_order: 2,
        layout_col: 1,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'rn',
        node_id: 'n2',
        feature_id: null, // unmapped — ignored for feature screens
        label_id: 'Orphan',
        kind: 'screen',
        sort_order: 2,
        layout_col: 0,
        layout_row: 0,
      },
    ],
    app_flow_edges: [
      {
        project_id: 'web',
        edge_id: 'e-web-login',
        from_node: 'n1',
        to_node: 'n1b',
        edge_kind: 'nav',
        sort_order: 0,
      },
    ],
    app_pages: [
      {
        id: 'page-login',
        project_id: 'web',
        label_id: 'Login',
        route: '/app/login',
        feature_id: 'FEAT-AUTH-MEMBER',
        source_hash: 'i'.repeat(64),
        extracted_at: '2026-07-12T10:00:00.000Z',
      },
      {
        id: 'page-home',
        project_id: 'web',
        label_id: 'Home',
        route: '/app/home',
        feature_id: null,
        source_hash: 'k'.repeat(64),
        extracted_at: '2026-07-12T10:00:00.000Z',
      },
      {
        id: 'page-aff',
        project_id: 'affiliate',
        label_id: 'Portal',
        route: '/affiliate',
        feature_id: 'FEAT-AFFILIATE',
        source_hash: 'j'.repeat(64),
        extracted_at: '2026-07-11T10:00:00.000Z',
      },
    ],
    nav_edges: [
      { from_page: 'page-login', to_page: 'page-home' },
    ],
    api_endpoints: [
      {
        id: 'ep1',
        method: 'POST',
        path: '/api/web/v1/login',
        domain_id: 'auth',
        repo: 'mfs-web',
      },
      {
        id: 'ep2',
        method: 'GET',
        path: '/api/affiliate/me',
        domain_id: 'aff',
        repo: 'affiliate',
      },
    ],
    page_api_calls: [
      { page_id: 'page-login', endpoint_id: 'ep1' },
      { page_id: 'page-aff', endpoint_id: 'ep2' },
    ],
  })
}

function createMemoryExecutor(corpus: Corpus): FlowDataSqlExecutor & {
  calls: string[]
} {
  const calls: string[] = []
  return {
    calls,
    async query(sql: string, params: Array<unknown> = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push(normalized)

      if (/information_schema\.TABLES/i.test(sql)) {
        const names = [...corpus.tables].map((name) => ({ name }))
        return [names]
      }
      if (/COUNT\(\*\) AS n FROM product_features/i.test(sql)) {
        return [[{ n: corpus.product_features.length }]]
      }
      if (/COUNT\(\*\) AS n FROM feature_task_map/i.test(sql)) {
        return [[{ n: corpus.feature_task_map.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_flow_nodes/i.test(sql)) {
        return [[{ n: corpus.app_flow_nodes.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_flow_edges/i.test(sql)) {
        return [[{ n: corpus.app_flow_edges.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_pages/i.test(sql)) {
        return [[{ n: corpus.app_pages.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+nav_edges/i.test(sql)) {
        return [[{ n: corpus.nav_edges.length }]]
      }
      if (/FROM product_features/i.test(sql)) {
        return [[...corpus.product_features]]
      }
      if (/FROM feature_task_map/i.test(sql)) {
        return [[...corpus.feature_task_map]]
      }
      if (/FROM rebuild_lineage_records/i.test(sql)) {
        const boardId = String(params[0] ?? DEFAULT_FLOW_BOARD_ID)
        return [
          corpus.rebuild_lineage_records.filter(
            (r) => String(r.board_id) === boardId,
          ),
        ]
      }
      if (/FROM feature_directory/i.test(sql)) {
        return [[...corpus.feature_directory]]
      }
      if (/FROM feature_units/i.test(sql)) {
        return [[...corpus.feature_units]]
      }
      if (/FROM parity_rollups/i.test(sql)) {
        return [[...corpus.parity_rollups]]
      }
      if (/FROM app_flow_nodes/i.test(sql)) {
        let rows = corpus.app_flow_nodes
        // Base materializer filters feature-linked screens only.
        if (/feature_id\s+IS\s+NOT\s+NULL/i.test(sql)) {
          rows = rows.filter((n) => n.feature_id != null && n.feature_id !== '')
        }
        if (/WHERE\s+project_id\s+IN/i.test(sql) && params.length) {
          const set = new Set(params.map(String))
          rows = rows.filter((r) => set.has(String(r.project_id)))
        }
        return [[...rows]]
      }
      if (/FROM app_flow_edges/i.test(sql)) {
        let rows = corpus.app_flow_edges
        if (/WHERE\s+project_id\s+IN/i.test(sql) && params.length) {
          const set = new Set(params.map(String))
          rows = rows.filter((r) => set.has(String(r.project_id)))
        }
        return [[...rows]]
      }
      if (/FROM app_pages/i.test(sql)) {
        let rows = corpus.app_pages
        // Base materializer (screens/apis) wants feature-linked pages only.
        if (/feature_id\s+IS\s+NOT\s+NULL/i.test(sql)) {
          rows = rows.filter((p) => p.feature_id != null && p.feature_id !== '')
        }
        return [[...rows]]
      }
      if (/FROM nav_edges/i.test(sql)) {
        return [[...corpus.nav_edges]]
      }
      if (/FROM page_api_calls/i.test(sql) || /page_api_calls c/i.test(sql)) {
        // join simulation
        const out: Array<Record<string, unknown>> = []
        for (const c of corpus.page_api_calls) {
          const e = corpus.api_endpoints.find(
            (x) => String(x.id) === String(c.endpoint_id),
          )
          if (!e) continue
          out.push({
            id: e.id,
            method: e.method,
            path: e.path,
            domain_id: e.domain_id,
            repo: e.repo,
            page_id: c.page_id,
          })
        }
        return [out]
      }
      throw new Error(`unexpected SQL in memory executor: ${normalized.slice(0, 120)}`)
    },
  }
}

const FIXED_NOW = () => new Date('2026-07-18T00:00:00.000Z')

const FILE_FIXTURE_A: FlowDataBundle = {
  projects: {
    version: 1,
    generated_at: '2026-07-01T00:00:00.000Z',
    source: 'file-fixture-a',
    projects: [
      {
        id: 'rn',
        label: 'React Native',
        features: 1,
        tasks: 1,
        rollup: { terbukti: 1, sebagian: 0, belum: 0 },
        pct: 100,
        status: 'terbukti',
      },
    ],
  },
  premium: { name: 'File Premium A', steps: [] },
  features: {
    rn: [
      {
        id: 'FEAT-FILE-A',
        nama_id: 'From file A',
        status: 'terbukti',
        pct: 100,
      },
    ],
    'web-member': [],
    'panel-sales': [],
    affiliate: [],
    backend: [],
  },
  tasks_by_feature: {},
  apis_by_feature: {},
}

const FILE_FIXTURE_B: FlowDataBundle = {
  projects: {
    version: 1,
    generated_at: '2026-07-02T00:00:00.000Z',
    source: 'file-fixture-b',
    projects: [],
  },
  premium: { name: 'File Premium B', steps: [] },
  features: {
    rn: [
      {
        id: 'FEAT-FILE-B',
        nama_id: 'From file B',
        status: 'belum',
        pct: 0,
      },
    ],
    'web-member': [],
    'panel-sales': [],
    affiliate: [],
    backend: [],
  },
  tasks_by_feature: {},
  apis_by_feature: {},
}

afterEach(() => {
  resetFlowDataBundleCache()
})

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('flow-data-materializer pure helpers', () => {
  it('platform_json maps admin→panel-sales and web→web-member', () => {
    expect(
      platformJsonToUiProjects({ rn: true, web: true, admin: true }, 'FEAT-X'),
    ).toEqual(['rn', 'web-member', 'panel-sales'])
    expect(platformJsonToUiProjects({ backend: true, jobs: true }, 'FEAT-X')).toEqual([
      'backend',
    ])
  })

  it('FEAT-AFFILIATE always includes affiliate UI key', () => {
    const ids = platformJsonToUiProjects({ web: true }, 'FEAT-AFFILIATE')
    expect(ids).toContain('affiliate')
    expect(ids).toContain('web-member')
  })

  it('storage project ids alias via canon map', () => {
    expect(storageProjectIdToUi('web')).toBe('web-member')
    expect(storageProjectIdToUi('sales')).toBe('panel-sales')
    expect(storageProjectIdToUi('rn')).toBe('rn')
    expect(storageProjectIdToUi('nope')).toBeNull()
  })

  it('repository heuristic maps known repos only', () => {
    expect(repositoryToUiProject('legacy/rn-mfs81')).toBe('rn')
    expect(repositoryToUiProject('mfs-web-original-upgrade')).toBe('web-member')
    expect(repositoryToUiProject('sales-rebuild')).toBe('panel-sales')
    expect(repositoryToUiProject('affiliate-rebuild')).toBe('affiliate')
    expect(repositoryToUiProject('rebuild-backend')).toBe('backend')
    expect(repositoryToUiProject('mystery-repo')).toBeUndefined()
  })

  it('rollupVerdicts exact status/pct', () => {
    expect(rollupVerdicts(['MAPPED_100', 'MAPPED_100'])).toMatchObject({
      status: 'terbukti',
      pct: 100,
      terbukti: 2,
    })
    expect(rollupVerdicts(['MISSING', 'MISSING'])).toMatchObject({
      status: 'belum',
      pct: 0,
    })
    expect(rollupVerdicts(['MAPPED_100', 'PARTIAL'])).toMatchObject({
      status: 'sebagian',
      pct: 50,
    })
    expect(rollupVerdicts([])).toMatchObject({ status: 'sebagian', pct: 0 })
    expect(rollupVerdicts([null, 'UNKNOWN'])).toMatchObject({
      status: 'sebagian',
      sebagian: 2,
    })
  })

  it('redactSecrets strips credential-like substrings', () => {
    const msg = redactSecrets(
      "Access denied for user 'cairn'@'%' (password: supersecret) CAIRN_DB_PASSWORD=hunter2 mysql://u:p@host/db",
    )
    expect(msg).not.toMatch(/supersecret/)
    expect(msg).not.toMatch(/hunter2/)
    expect(msg).not.toMatch(/mysql:\/\/u:p@/)
    expect(msg).toMatch(/\*\*\*/)
  })

  it('stableStringify + sha256Hex deterministic', () => {
    const a = sha256Hex(stableStringify({ b: 1, a: [2, 3] }))
    const b = sha256Hex(stableStringify({ a: [2, 3], b: 1 }))
    expect(a).toBe(b)
    expect(a).toMatch(/^[a-f0-9]{64}$/)
  })
})

// ---------------------------------------------------------------------------
// MySQL materialize
// ---------------------------------------------------------------------------

describe('materializeFromMysql', () => {
  it('T1: features under correct UI keys (admin→panel-sales, web→web-member)', async () => {
    const exec = createMemoryExecutor(fixtureCorpus())
    const result = await materializeFromMysql({
      executor: exec,
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const { bundle, meta } = result.load
    expect(meta.source).toBe('mysql')
    expect(meta.code).toBe('OK')
    expect(meta.availability).toBe('available')

    const authIds = (p: string) =>
      (bundle.features[p] ?? []).map((f) => f.id)

    expect(authIds('rn')).toContain('FEAT-AUTH-MEMBER')
    expect(authIds('web-member')).toContain('FEAT-AUTH-MEMBER')
    expect(authIds('panel-sales')).toContain('FEAT-AUTH-MEMBER')
    expect(authIds('backend')).toContain('FEAT-AUTH-MEMBER')

    expect(authIds('panel-sales')).toContain('FEAT-ADMIN-ONLY')
    expect(authIds('rn')).not.toContain('FEAT-ADMIN-ONLY')

    // only five keys
    expect(Object.keys(bundle.features).sort()).toEqual(
      [...CANON_UI_PROJECT_IDS].sort(),
    )
  })

  it('T2: lineage verdicts → status/pct/rollup exact', async () => {
    const exec = createMemoryExecutor(fixtureCorpus())
    const result = await materializeFromMysql({
      executor: exec,
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const auth = result.load.bundle.features.rn.find(
      (f) => f.id === 'FEAT-AUTH-MEMBER',
    )!
    // MAPPED_100 + PARTIAL → sebagian 50%
    expect(auth.status).toBe('sebagian')
    expect(auth.pct).toBe(50)
    expect(auth.rollup).toEqual({ terbukti: 1, sebagian: 1, belum: 0 })

    const aff = result.load.bundle.features.affiliate.find(
      (f) => f.id === 'FEAT-AFFILIATE',
    )!
    expect(aff.status).toBe('belum')
    expect(aff.pct).toBe(0)

    const tasks = result.load.bundle.tasks_by_feature['FEAT-AUTH-MEMBER']
    expect(tasks.map((t) => t.id).sort()).toEqual(['T-AUTH-1', 'T-AUTH-2'])
    expect(tasks.find((t) => t.id === 'T-AUTH-1')?.judul_id).toBe('Auth mobile')
    expect(tasks.find((t) => t.id === 'T-AUTH-1')?.project).toBe('rn')
    expect(tasks.find((t) => t.id === 'T-AUTH-2')?.project).toBe('web-member')
  })

  it('T3: missing 009 tables → features load; status sebagian/pct 0; OK_PARTIAL', async () => {
    const corpus = fixtureCorpus()
    corpus.tables.delete('rebuild_lineage_records')
    corpus.tables.delete('parity_rollups')
    corpus.tables.delete('feature_directory')
    corpus.tables.delete('feature_units')
    const exec = createMemoryExecutor(corpus)
    const result = await materializeFromMysql({
      executor: exec,
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.load.meta.code).toBe('OK_PARTIAL')
    expect(result.load.meta.availability).toBe('partial')
    const auth = result.load.bundle.features.rn.find(
      (f) => f.id === 'FEAT-AUTH-MEMBER',
    )!
    expect(auth.status).toBe('sebagian')
    expect(auth.pct).toBe(0)
    expect(result.load.bundle.tasks_by_feature['FEAT-AUTH-MEMBER'][0].verdict).toBe(
      'PARTIAL',
    )
  })

  it('T4: missing 010 → gate fail TABLES_MISSING', async () => {
    const corpus = baseCorpus({
      tables: new Set(['rebuild_lineage_records']),
    })
    const exec = createMemoryExecutor(corpus)
    const result = await materializeFromMysql({ executor: exec, now: FIXED_NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('TABLES_MISSING')
  })

  it('T5: empty product_features → EMPTY_MYSQL', async () => {
    const corpus = baseCorpus({
      product_features: [],
      feature_task_map: [],
    })
    const exec = createMemoryExecutor(corpus)
    const result = await materializeFromMysql({ executor: exec, now: FIXED_NOW })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.code).toBe('EMPTY_MYSQL')
  })

  it('T10: 012 page_api_calls → apis_by_feature; without 012 empty', async () => {
    const full = createMemoryExecutor(fixtureCorpus())
    const fullR = await materializeFromMysql({
      executor: full,
      now: FIXED_NOW,
    })
    expect(fullR.ok).toBe(true)
    if (!fullR.ok) return
    expect(fullR.load.bundle.apis_by_feature['FEAT-AUTH-MEMBER']).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          method: 'POST',
          path: '/api/web/v1/login',
          proj: 'web-member',
        }),
      ]),
    )

    const no012 = fixtureCorpus()
    no012.tables.delete('app_pages')
    no012.tables.delete('api_endpoints')
    no012.tables.delete('page_api_calls')
    const partial = await materializeFromMysql({
      executor: createMemoryExecutor(no012),
      now: FIXED_NOW,
    })
    expect(partial.ok).toBe(true)
    if (!partial.ok) return
    expect(partial.load.meta.code).toBe('OK_PARTIAL')
    expect(partial.load.bundle.apis_by_feature['FEAT-AUTH-MEMBER']).toEqual([])
  })

  it('T11: screens from app_pages + app_flow_nodes; unmapped nodes ignored', async () => {
    const result = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const auth = result.load.bundle.features['web-member'].find(
      (f) => f.id === 'FEAT-AUTH-MEMBER',
    )!
    expect(auth.screens).toEqual(
      expect.arrayContaining(['/app/login', '/login', 'LoginScreen']),
    )
    expect(auth.screens).not.toContain('Orphan')
    expect(auth.doc_md).toBe('# Auth docs')
  })

  it('T12: no flat edges key; premium curated; semantic nav attached', async () => {
    const result = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.load.bundle).not.toHaveProperty('edges')
    expect(result.load.bundle.premium.name).toBe(PREMIUM_FLOW_V1.name)
    expect(result.load.bundle.premium.steps).toHaveLength(10)
    expect(result.load.bundle.premium_apis).toHaveLength(9)
    expect(result.load.bundle.projects.version).toBe(MATERIALIZER_VERSION)
    expect(result.load.bundle.projects.source).toMatch(/^mysql:010/)
    expect(result.load.bundle.nav).toBeDefined()
    expect(result.load.bundle.nav!.source).toBe('mysql')
    expect(result.load.bundle.nav!.state).toBe('OK')
  })

  it('T13: boardId filters lineage; default mfs-rebuild', async () => {
    const result = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
      boardId: 'mfs-rebuild',
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const allTaskIds = Object.values(result.load.bundle.tasks_by_feature).flatMap(
      (t) => t.map((x) => x.id),
    )
    expect(allTaskIds).not.toContain('T-OTHER')
    expect(result.load.meta.boardId).toBe(DEFAULT_FLOW_BOARD_ID)
    expect(result.load.meta.revision).toBe(42)
  })

  it('T14: affiliate feature under affiliate (and platform keys)', async () => {
    const result = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(
      result.load.bundle.features.affiliate.some((f) => f.id === 'FEAT-AFFILIATE'),
    ).toBe(true)
  })

  it('T8: sourceHash stable; changes when verdict flips', async () => {
    const c1 = fixtureCorpus()
    const r1 = await materializeFromMysql({
      executor: createMemoryExecutor(c1),
      now: FIXED_NOW,
    })
    const r1b = await materializeFromMysql({
      executor: createMemoryExecutor(c1),
      now: FIXED_NOW,
    })
    expect(r1.ok && r1b.ok).toBe(true)
    if (!r1.ok || !r1b.ok) return
    expect(r1.load.meta.sourceHash).toBe(r1b.load.meta.sourceHash)

    const c2 = fixtureCorpus()
    const row = c2.rebuild_lineage_records.find((r) => r.task_id === 'T-AUTH-2')!
    row.parity_verdict = 'MAPPED_100'
    const r2 = await materializeFromMysql({
      executor: createMemoryExecutor(c2),
      now: FIXED_NOW,
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.load.meta.sourceHash).not.toBe(r1.load.meta.sourceHash)
  })

  it('no N+1: query count bounded (bulk only, independent of feature count)', async () => {
    const small = fixtureCorpus()
    const execSmall = createMemoryExecutor(small)
    const rSmall = await materializeFromMysql({
      executor: execSmall,
      now: FIXED_NOW,
    })
    expect(rSmall.ok).toBe(true)
    if (!rSmall.ok) return
    const qSmall = rSmall.load.meta.queryCount!

    const big = fixtureCorpus()
    for (let i = 0; i < 40; i++) {
      big.product_features.push({
        feature_id: `FEAT-X-${i}`,
        nama_id: `X${i}`,
        platform_json: { rn: true },
        fc_refs_json: [],
      })
      big.feature_task_map.push({
        feature_id: `FEAT-X-${i}`,
        task_id: `T-X-${i}`,
        join_source: 'prefix',
        confidence: 0.6,
      })
    }
    const execBig = createMemoryExecutor(big)
    const rBig = await materializeFromMysql({
      executor: execBig,
      now: FIXED_NOW,
    })
    expect(rBig.ok).toBe(true)
    if (!rBig.ok) return
    expect(rBig.load.meta.queryCount).toBe(qSmall)
    // upper bound: base bulk (~12) + semantic probe/bulk (~5) — still O(1), no N+1
    expect(qSmall).toBeLessThanOrEqual(24)
    expect(qSmall).toBeGreaterThanOrEqual(8)
  })

  it('deterministic feature/task ordering', async () => {
    const r1 = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    const r2 = await materializeFromMysql({
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    expect(r1.ok && r2.ok).toBe(true)
    if (!r1.ok || !r2.ok) return
    expect(JSON.stringify(r1.load.bundle.features)).toBe(
      JSON.stringify(r2.load.bundle.features),
    )
    expect(JSON.stringify(r1.load.bundle.tasks_by_feature)).toBe(
      JSON.stringify(r2.load.bundle.tasks_by_feature),
    )
  })
})

// ---------------------------------------------------------------------------
// resolveFlowDataBundle — XOR fallback
// ---------------------------------------------------------------------------

describe('resolveFlowDataBundle', () => {
  it('T4/T5: missing 010 / empty → file fallback (not merge)', async () => {
    const missing = baseCorpus({ tables: new Set(['app_pages']) })
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createMemoryExecutor(missing),
      fileBundle: FILE_FIXTURE_A,
      now: FIXED_NOW,
    })
    expect(load.meta.source).toBe('file')
    expect(load.meta.code).toBe('FILE_FALLBACK')
    expect(load.bundle.features.rn[0].id).toBe('FEAT-FILE-A')

    resetFlowDataBundleCache()
    const empty = baseCorpus({ product_features: [] })
    const load2 = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createMemoryExecutor(empty),
      fileBundle: FILE_FIXTURE_A,
      now: FIXED_NOW,
    })
    expect(load2.meta.code).toBe('FILE_FALLBACK')
    expect(load2.meta.detail).toMatch(/EMPTY_MYSQL|COUNT/i)
  })

  it('T6: DB throw → file fallback; meta DB_ERROR', async () => {
    const exec: FlowDataSqlExecutor = {
      async query() {
        throw new Error(
          "Access denied for user 'root'@'%' (using password: YES) password=s3cret CAIRN_DB_PASSWORD=s3cret",
        )
      },
    }
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: exec,
      fileBundle: FILE_FIXTURE_A,
      now: FIXED_NOW,
    })
    expect(load.meta.source).toBe('file')
    expect(load.meta.code).toBe('FILE_FALLBACK')
    expect(load.meta.detail).toMatch(/DB_ERROR/)
    expect(load.meta.detail).not.toMatch(/s3cret/)
    expect(load.bundle.features.rn[0].id).toBe('FEAT-FILE-A')
  })

  it('T7: no merge — mysql features A XOR file B only', async () => {
    const mysqlLoad = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createMemoryExecutor(fixtureCorpus()),
      fileBundle: FILE_FIXTURE_B,
      now: FIXED_NOW,
    })
    expect(mysqlLoad.meta.source).toBe('mysql')
    const mysqlIds = Object.values(mysqlLoad.bundle.features)
      .flat()
      .map((f) => f.id)
    expect(mysqlIds).toContain('FEAT-AUTH-MEMBER')
    expect(mysqlIds).not.toContain('FEAT-FILE-B')
    expect(mysqlLoad.bundle.premium.name).toBe(PREMIUM_FLOW_V1.name)
    expect(mysqlLoad.bundle.premium.name).not.toBe('File Premium B')

    resetFlowDataBundleCache()
    const fileLoad = await resolveFlowDataBundle({
      preferMysql: false,
      fileBundle: FILE_FIXTURE_B,
      now: FIXED_NOW,
    })
    expect(fileLoad.meta.source).toBe('file')
    expect(fileLoad.meta.code).toBe('FILE_FORCED')
    expect(fileLoad.bundle.features.rn[0].id).toBe('FEAT-FILE-B')
    expect(
      Object.values(fileLoad.bundle.features)
        .flat()
        .map((f) => f.id),
    ).not.toContain('FEAT-AUTH-MEMBER')
  })

  it('T9: cache returns same object; reset clears', async () => {
    const exec = createMemoryExecutor(fixtureCorpus())
    const a = await resolveFlowDataBundle({
      preferMysql: true,
      executor: exec,
      now: FIXED_NOW,
    })
    const key1 = getFlowDataBundleCacheKey()
    expect(key1).toMatch(/^flow\|mysql\|/)
    expect(key1).toContain(a.meta.sourceHash)

    const b = await resolveFlowDataBundle({
      preferMysql: true,
      executor: exec,
      now: FIXED_NOW,
    })
    expect(b).toBe(a)
    expect(getFlowDataBundleCacheKey()).toBe(key1)

    resetFlowDataBundleCache()
    expect(getFlowDataBundleCacheKey()).toBeNull()
    const c = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createMemoryExecutor(fixtureCorpus()),
      now: FIXED_NOW,
    })
    expect(c).not.toBe(a)
    expect(c.meta.sourceHash).toBe(a.meta.sourceHash)
  })

  it('T15: credentials never appear in meta.detail / UNAVAILABLE path', async () => {
    const exec: FlowDataSqlExecutor = {
      async query() {
        throw new Error('password=leak-me-now mysql://admin:hunter2@dbhost/cairn')
      },
    }
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: exec,
      fileBundle: null,
      now: FIXED_NOW,
    })
    expect(load.meta.code).toBe('UNAVAILABLE')
    expect(load.meta.availability).toBe('unavailable')
    expect(load.meta.detail).not.toMatch(/leak-me-now/)
    expect(load.meta.detail).not.toMatch(/hunter2/)
    expect(JSON.stringify(load)).not.toMatch(/leak-me-now|hunter2/)
    expect(load.bundle.projects.source).toBe('empty')
    expect(load.bundle.features.rn).toEqual([])
  })

  it('preferMysql false forces file without touching executor', async () => {
    let called = false
    const exec: FlowDataSqlExecutor = {
      async query() {
        called = true
        return [[]]
      },
    }
    const load = await resolveFlowDataBundle({
      preferMysql: false,
      executor: exec,
      fileBundle: FILE_FIXTURE_A,
      now: FIXED_NOW,
    })
    expect(called).toBe(false)
    expect(load.meta.code).toBe('FILE_FORCED')
  })

  it('empty skeleton shape matches five projects', () => {
    const b = emptyFlowDataBundle('2026-07-18T00:00:00.000Z')
    expect(b.projects.projects.map((p) => p.id)).toEqual([...CANON_UI_PROJECT_IDS])
    expect(b.premium.steps).toEqual([])
    expect(b.nav?.state).toBe('UNAVAILABLE')
    expect(b.nav?.by_project.rn.app_flow.edges).toEqual([])
    expect(b.nav?.by_project.rn.page_nav.edges).toEqual([])
  })

  it('file fallback does not leak mysql semantic edges', async () => {
    const mysqlOnlyEdgeId = 'e-web-login'
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createMemoryExecutor(
        baseCorpus({ tables: new Set(['app_pages']) }),
      ),
      fileBundle: FILE_FIXTURE_A,
      now: FIXED_NOW,
    })
    expect(load.meta.source).toBe('file')
    expect(load.meta.code).toBe('FILE_FALLBACK')
    expect(load.bundle.nav?.state).toBe('NO_SEMANTIC_SOURCE')
    expect(load.bundle.nav?.source).toBe('none')
    const allAppEdges = Object.values(load.bundle.nav?.by_project ?? {}).flatMap(
      (g) => g.app_flow.edges.map((e) => e.edge_id),
    )
    const allPageEdges = Object.values(load.bundle.nav?.by_project ?? {}).flatMap(
      (g) => g.page_nav.edges.map((e) => e.edge_id),
    )
    expect(allAppEdges).not.toContain(mysqlOnlyEdgeId)
    expect(allAppEdges).toEqual([])
    expect(allPageEdges).toEqual([])
    expect(load.bundle).not.toHaveProperty('edges')
  })
})

// ---------------------------------------------------------------------------
// Alias parity with canon / graph projectKey
// ---------------------------------------------------------------------------

describe('alias mapping parity', () => {
  it('normalizeCanonProjectId web/sales matches materializer storage map', () => {
    expect(normalizeCanonProjectId('web')).toEqual({ ok: true, id: 'web-member' })
    expect(normalizeCanonProjectId('sales')).toEqual({
      ok: true,
      id: 'panel-sales',
    })
    expect(storageProjectIdToUi('web')).toBe('web-member')
    expect(storageProjectIdToUi('sales')).toBe('panel-sales')
  })
})
