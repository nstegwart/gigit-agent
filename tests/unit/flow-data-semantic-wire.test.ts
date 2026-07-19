/**
 * FlowDataBundle semantic nav wire — materializer ↔ flow-semantic-edges.
 * Injectable memory SQL only. No live MySQL. No secrets. LOCAL ONLY.
 */
import { afterEach, describe, expect, it } from 'vitest'

import type { FlowDataBundle, FlowDataSemanticNav } from '#/components/flow-ultimate/types'
import { CANON_UI_PROJECT_IDS } from '#/lib/canon-flow-projects'
import {
  DEFAULT_FLOW_BOARD_ID,
  emptyFlowDataBundle,
  isAuthoritativeFileSemanticNav,
  materializeFromMysql,
  noSemanticSourceNav,
  resetFlowDataBundleCache,
  resolveFlowDataBundle,
  type FlowDataSqlExecutor,
} from '#/server/flow-data-materializer'

// ---------------------------------------------------------------------------
// Memory corpus (base 010+ + semantic 011/012)
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
  throwOn?: RegExp
  throwMessage?: string
}

function baseTables(extra: string[] = []): Set<string> {
  return new Set([
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
    ...extra,
  ])
}

function minimalFeatures(): Pick<
  Corpus,
  'product_features' | 'feature_task_map' | 'rebuild_lineage_records'
> {
  return {
    product_features: [
      {
        feature_id: 'FEAT-AUTH-MEMBER',
        nama_id: 'Auth Member',
        platform_json: { rn: true, web: true },
        fc_refs_json: [],
        curated: 1,
      },
    ],
    feature_task_map: [
      {
        feature_id: 'FEAT-AUTH-MEMBER',
        task_id: 'T-1',
        join_source: 'curated',
        confidence: 1,
      },
    ],
    rebuild_lineage_records: [
      {
        board_id: DEFAULT_FLOW_BOARD_ID,
        task_id: 'T-1',
        repository: 'legacy/rn-mfs81',
        parity_verdict: 'MAPPED_100',
        synced_at: '2026-07-10T12:00:00.000Z',
      },
    ],
  }
}

function richSemanticCorpus(over: Partial<Corpus> = {}): Corpus {
  const base = minimalFeatures()
  return {
    tables: over.tables ?? baseTables(),
    product_features: over.product_features ?? base.product_features,
    feature_task_map: over.feature_task_map ?? base.feature_task_map,
    rebuild_lineage_records:
      over.rebuild_lineage_records ?? base.rebuild_lineage_records,
    feature_directory: over.feature_directory ?? [],
    feature_units: over.feature_units ?? [],
    parity_rollups: over.parity_rollups ?? [
      { id: 7, captured_at: '2026-07-12T15:00:00.000Z' },
    ],
    app_flow_nodes: over.app_flow_nodes ?? [
      {
        project_id: 'rn',
        node_id: 'login',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Login',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
      },
      {
        project_id: 'rn',
        node_id: 'home',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Home',
        kind: 'screen',
        sort_order: 1,
        layout_col: 1,
        layout_row: 0,
      },
      {
        project_id: 'web',
        node_id: 'web-login',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Web Login',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
      },
      {
        project_id: 'web',
        node_id: 'web-home',
        feature_id: null,
        label_id: 'Web Home',
        kind: 'screen',
        sort_order: 1,
        layout_col: 1,
        layout_row: 0,
      },
    ],
    app_flow_edges: over.app_flow_edges ?? [
      {
        project_id: 'rn',
        edge_id: 'rn-login-home',
        from_node: 'login',
        to_node: 'home',
        edge_kind: 'nav',
        sort_order: 0,
      },
      {
        project_id: 'web',
        edge_id: 'web-login-home',
        from_node: 'web-login',
        to_node: 'web-home',
        edge_kind: 'nav',
        sort_order: 0,
      },
    ],
    app_pages: over.app_pages ?? [
      {
        id: 'pg-login',
        project_id: 'web',
        label_id: 'Login',
        route: '/app/login',
        feature_id: 'FEAT-AUTH-MEMBER',
        extracted_at: '2026-07-12T10:00:00.000Z',
      },
      {
        id: 'pg-home',
        project_id: 'web',
        label_id: 'Home',
        route: '/app/home',
        feature_id: null,
        extracted_at: '2026-07-12T10:00:00.000Z',
      },
      {
        id: 'pg-rn-login',
        project_id: 'rn',
        label_id: 'RN Login',
        route: 'LoginScreen',
        feature_id: 'FEAT-AUTH-MEMBER',
      },
    ],
    nav_edges: over.nav_edges ?? [
      { from_page: 'pg-login', to_page: 'pg-home' },
    ],
    api_endpoints: over.api_endpoints ?? [],
    page_api_calls: over.page_api_calls ?? [],
    throwOn: over.throwOn,
    throwMessage: over.throwMessage,
  }
}

function createExecutor(corpus: Corpus): FlowDataSqlExecutor & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    async query(sql: string, params: Array<unknown> = []) {
      const normalized = sql.replace(/\s+/g, ' ').trim()
      calls.push(normalized)

      if (corpus.throwOn && corpus.throwOn.test(normalized)) {
        if (!/information_schema/i.test(normalized)) {
          throw new Error(
            corpus.throwMessage ??
              "Access denied for user 'root'@'%' password=s3cret",
          )
        }
      }

      if (/information_schema\.TABLES/i.test(sql)) {
        return [[...corpus.tables].map((name) => ({ name }))]
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
      if (/FROM feature_directory/i.test(sql)) return [[...corpus.feature_directory]]
      if (/FROM feature_units/i.test(sql)) return [[...corpus.feature_units]]
      if (/FROM parity_rollups/i.test(sql)) return [[...corpus.parity_rollups]]
      if (/FROM app_flow_nodes/i.test(sql)) {
        let rows = corpus.app_flow_nodes
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
        if (/feature_id\s+IS\s+NOT\s+NULL/i.test(sql)) {
          rows = rows.filter((p) => p.feature_id != null && p.feature_id !== '')
        }
        return [[...rows]]
      }
      if (/FROM nav_edges/i.test(sql)) return [[...corpus.nav_edges]]
      if (/FROM page_api_calls/i.test(sql) || /page_api_calls c/i.test(sql)) {
        return [[]]
      }
      throw new Error(`unexpected SQL: ${normalized.slice(0, 140)}`)
    },
  }
}

const FIXED_NOW = () => new Date('2026-07-19T00:00:00.000Z')

const FILE_PLAIN: FlowDataBundle = {
  projects: {
    version: 1,
    generated_at: '2026-07-01T00:00:00.000Z',
    source: 'file-plain',
    projects: [{ id: 'rn', label: 'RN', features: 0, tasks: 0 }],
  },
  premium: { name: 'File', steps: [] },
  features: {
    rn: [{ id: 'FEAT-FILE', nama_id: 'File Feat', status: 'belum' }],
  },
  tasks_by_feature: {},
  apis_by_feature: {},
}

function fileWithAuthoritativeNav(): FlowDataBundle {
  const nav = noSemanticSourceNav({
    boardId: DEFAULT_FLOW_BOARD_ID,
    state: 'NO_SEMANTIC_SOURCE',
    reason: 'placeholder',
  })
  // Authoritative file contract: source=file + structure + hash
  const authoritative: FlowDataSemanticNav = {
    ...nav,
    source: 'file',
    state: 'OK',
    reason: undefined,
    by_project: {
      ...nav.by_project,
      rn: {
        project_id: 'rn',
        app_flow: {
          nodes: [
            {
              node_id: 'file-node',
              project_id_storage: 'rn',
              project_id: 'rn',
              feature_id: null,
              label_id: 'File Node',
              kind: 'screen',
              sort_order: 0,
              layout_col: 0,
              layout_row: 0,
              source_ref: null,
              provenance: 'app_flow_nodes',
            },
          ],
          edges: [],
        },
        page_nav: { nodes: [], edges: [] },
      },
    },
    layers: {
      app_flow: {
        ...nav.layers.app_flow,
        code: 'OK',
        rawNodeCount: 1,
        projectedNodeCount: 1,
        tablesPresent: ['app_flow_nodes', 'app_flow_edges'],
      },
      page_nav: {
        ...nav.layers.page_nav,
        code: 'EMPTY_ROWS',
        tablesPresent: ['app_pages', 'nav_edges'],
      },
    },
  }
  return { ...FILE_PLAIN, nav: authoritative }
}

afterEach(() => {
  resetFlowDataBundleCache()
})

// ---------------------------------------------------------------------------
// Exact edge survival + namespace separation
// ---------------------------------------------------------------------------

describe('semantic wire — mysql path', () => {
  it('exact app_flow and page_nav edge rows survive with separate namespaces', async () => {
    const result = await materializeFromMysql({
      executor: createExecutor(richSemanticCorpus()),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const nav = result.load.bundle.nav!
    expect(nav.source).toBe('mysql')
    expect(nav.state).toBe('OK')
    expect(nav.version).toBe(1)
    expect(result.load.bundle).not.toHaveProperty('edges')

    const rnApp = nav.by_project.rn.app_flow
    expect(rnApp.edges).toEqual([
      expect.objectContaining({
        edge_id: 'rn-login-home',
        from_node: 'login',
        to_node: 'home',
        edge_class: 'nav',
        provenance: 'app_flow_edges',
      }),
    ])
    expect(rnApp.nodes.map((n) => n.node_id).sort()).toEqual(['home', 'login'])

    const webPage = nav.by_project['web-member'].page_nav
    expect(webPage.edges).toEqual([
      expect.objectContaining({
        edge_id: 'pg-login->pg-home',
        from_page: 'pg-login',
        to_page: 'pg-home',
        edge_class: 'page_nav',
        provenance: 'nav_edges',
      }),
    ])
    // Same string id space collision would still be separate layers
    expect(rnApp.edges[0].edge_class).toBe('nav')
    expect(webPage.edges[0].edge_class).toBe('page_nav')
    // Never merge: app_flow uses from_node; page_nav uses from_page
    expect(rnApp.edges[0]).toHaveProperty('from_node')
    expect(rnApp.edges[0]).not.toHaveProperty('from_page')
    expect(webPage.edges[0]).toHaveProperty('from_page')
    expect(webPage.edges[0]).not.toHaveProperty('from_node')

    for (const id of CANON_UI_PROJECT_IDS) {
      expect(nav.by_project[id]?.project_id).toBe(id)
    }
    expect(nav.by_project).not.toHaveProperty('cross')
  })

  it('does not invent edges from features, projects, or layout', async () => {
    const corpus = richSemanticCorpus({
      app_flow_edges: [],
      nav_edges: [],
    })
    const result = await materializeFromMysql({
      executor: createExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    const nav = result.load.bundle.nav!
    const appEdges = Object.values(nav.by_project).flatMap((g) => g.app_flow.edges)
    const pageEdges = Object.values(nav.by_project).flatMap((g) => g.page_nav.edges)
    expect(appEdges).toEqual([])
    expect(pageEdges).toEqual([])
    // Nodes may still project; edges must not be synthesized from feature list
    expect(nav.layers.app_flow.projectedNodeCount).toBeGreaterThan(0)
    expect(nav.layers.app_flow.projectedEdgeCount).toBe(0)
    expect(result.load.bundle.features.rn.length).toBeGreaterThan(0)
  })

  it('deterministic sort + sourceHash flips when edge set changes', async () => {
    const c1 = richSemanticCorpus()
    const r1 = await materializeFromMysql({
      executor: createExecutor(c1),
      now: FIXED_NOW,
    })
    const r1b = await materializeFromMysql({
      executor: createExecutor(c1),
      now: () => new Date('2026-07-20T00:00:00.000Z'),
    })
    expect(r1.ok && r1b.ok).toBe(true)
    if (!r1.ok || !r1b.ok) return
    expect(r1.load.meta.sourceHash).toBe(r1b.load.meta.sourceHash)
    expect(r1.load.bundle.nav!.sourceHash).toBe(r1b.load.bundle.nav!.sourceHash)
    expect(JSON.stringify(r1.load.bundle.nav!.by_project)).toBe(
      JSON.stringify(r1b.load.bundle.nav!.by_project),
    )

    const c2 = richSemanticCorpus({
      app_flow_edges: [
        ...richSemanticCorpus().app_flow_edges,
        {
          project_id: 'rn',
          edge_id: 'rn-extra',
          from_node: 'home',
          to_node: 'login',
          edge_kind: 'nav',
          sort_order: 1,
        },
      ],
    })
    const r2 = await materializeFromMysql({
      executor: createExecutor(c2),
      now: FIXED_NOW,
    })
    expect(r2.ok).toBe(true)
    if (!r2.ok) return
    expect(r2.load.bundle.nav!.sourceHash).not.toBe(r1.load.bundle.nav!.sourceHash)
    expect(r2.load.meta.sourceHash).not.toBe(r1.load.meta.sourceHash)
  })

  it('TABLES_MISSING vs EMPTY_ROWS vs PROJECTED_EMPTY vs DB_ERROR', async () => {
    // TABLES_MISSING: no edge tables
    const missing = richSemanticCorpus({
      tables: new Set([
        'product_features',
        'feature_task_map',
        'rebuild_lineage_records',
        'app_flow_nodes',
        'app_pages',
      ]),
    })
    const rMiss = await materializeFromMysql({
      executor: createExecutor(missing),
      now: FIXED_NOW,
    })
    expect(rMiss.ok).toBe(true)
    if (!rMiss.ok) return
    expect(rMiss.load.bundle.nav!.layers.app_flow.code).toBe('TABLES_MISSING')
    expect(rMiss.load.bundle.nav!.layers.page_nav.code).toBe('TABLES_MISSING')
    expect(rMiss.load.bundle.nav!.state).toBe('PARTIAL')
    expect(rMiss.load.meta.code).toBe('OK_PARTIAL')
    expect(rMiss.load.meta.source).toBe('mysql') // base still mysql — no file merge

    // EMPTY_ROWS: tables present, zero rows
    const empty = richSemanticCorpus({
      app_flow_nodes: [],
      app_flow_edges: [],
      app_pages: [],
      nav_edges: [],
    })
    const rEmpty = await materializeFromMysql({
      executor: createExecutor(empty),
      now: FIXED_NOW,
    })
    expect(rEmpty.ok).toBe(true)
    if (!rEmpty.ok) return
    expect(rEmpty.load.bundle.nav!.layers.app_flow.code).toBe('EMPTY_ROWS')
    expect(rEmpty.load.bundle.nav!.layers.page_nav.code).toBe('EMPTY_ROWS')
    expect(rEmpty.load.bundle.nav!.state).toBe('OK')

    // PROJECTED_EMPTY: rows exist but unknown project aliases only
    const projected = richSemanticCorpus({
      app_flow_nodes: [
        {
          project_id: 'unknown-proj',
          node_id: 'x',
          label_id: 'X',
          kind: 'screen',
          sort_order: 0,
        },
      ],
      app_flow_edges: [
        {
          project_id: 'unknown-proj',
          edge_id: 'e1',
          from_node: 'x',
          to_node: 'x',
          edge_kind: 'nav',
          sort_order: 0,
        },
      ],
      app_pages: [
        {
          id: 'p-x',
          project_id: 'not-a-real-project',
          label_id: 'X',
          route: '/x',
        },
      ],
      nav_edges: [{ from_page: 'p-x', to_page: 'p-x' }],
    })
    const rProj = await materializeFromMysql({
      executor: createExecutor(projected),
      now: FIXED_NOW,
    })
    expect(rProj.ok).toBe(true)
    if (!rProj.ok) return
    expect(rProj.load.bundle.nav!.layers.app_flow.code).toBe('PROJECTED_EMPTY')
    expect(rProj.load.bundle.nav!.layers.page_nav.code).toBe('PROJECTED_EMPTY')

    // DB_ERROR on semantic layer query (after base succeeds) — redacted, partial
    const dbErr = richSemanticCorpus({
      throwOn: /FROM\s+app_flow_edges/i,
      throwMessage:
        "Access denied for user 'root'@'%' password=s3cret CAIRN_DB_PASSWORD=leak",
    })
    const rErr = await materializeFromMysql({
      executor: createExecutor(dbErr),
      now: FIXED_NOW,
    })
    expect(rErr.ok).toBe(true)
    if (!rErr.ok) return
    expect(rErr.load.bundle.nav!.layers.app_flow.code).toBe('DB_ERROR')
    expect(rErr.load.bundle.nav!.state).toBe('PARTIAL')
    expect(rErr.load.meta.source).toBe('mysql')
    expect(JSON.stringify(rErr.load)).not.toMatch(/s3cret|leak/)
    const detail = rErr.load.bundle.nav!.layers.app_flow.detail ?? ''
    expect(detail).not.toMatch(/s3cret|leak/)
  })

  it('bounded query count independent of edge/feature volume (no N+1)', async () => {
    const small = richSemanticCorpus()
    const rSmall = await materializeFromMysql({
      executor: createExecutor(small),
      now: FIXED_NOW,
    })
    expect(rSmall.ok).toBe(true)
    if (!rSmall.ok) return
    const qSmall = rSmall.load.meta.queryCount!

    const big = richSemanticCorpus()
    for (let i = 0; i < 50; i++) {
      big.product_features.push({
        feature_id: `FEAT-B-${i}`,
        nama_id: `B${i}`,
        platform_json: { rn: true },
        fc_refs_json: [],
      })
      big.app_flow_nodes.push({
        project_id: 'rn',
        node_id: `n-${i}`,
        label_id: `N${i}`,
        kind: 'screen',
        sort_order: i + 10,
        layout_col: 0,
        layout_row: i,
      })
      if (i > 0) {
        big.app_flow_edges.push({
          project_id: 'rn',
          edge_id: `e-${i}`,
          from_node: `n-${i - 1}`,
          to_node: `n-${i}`,
          edge_kind: 'nav',
          sort_order: i,
        })
      }
    }
    const rBig = await materializeFromMysql({
      executor: createExecutor(big),
      now: FIXED_NOW,
    })
    expect(rBig.ok).toBe(true)
    if (!rBig.ok) return
    expect(rBig.load.meta.queryCount).toBe(qSmall)
    expect(qSmall).toBeLessThanOrEqual(24)
    expect(qSmall).toBeGreaterThanOrEqual(8)
  })
})

// ---------------------------------------------------------------------------
// XOR resolve paths
// ---------------------------------------------------------------------------

describe('semantic wire — resolve XOR honesty', () => {
  it('mysql failure + file fallback has no DB edge leakage', async () => {
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: createExecutor(
        richSemanticCorpus({
          tables: new Set(['app_pages']), // missing 010 gate
        }),
      ),
      fileBundle: FILE_PLAIN,
      now: FIXED_NOW,
    })
    expect(load.meta.source).toBe('file')
    expect(load.meta.code).toBe('FILE_FALLBACK')
    expect(load.bundle.features.rn[0].id).toBe('FEAT-FILE')
    expect(load.bundle.nav?.state).toBe('NO_SEMANTIC_SOURCE')
    expect(load.bundle.nav?.source).toBe('none')
    const edgeIds = Object.values(load.bundle.nav!.by_project).flatMap((g) => [
      ...g.app_flow.edges.map((e) => e.edge_id),
      ...g.page_nav.edges.map((e) => e.edge_id),
    ])
    expect(edgeIds).toEqual([])
    expect(edgeIds).not.toContain('rn-login-home')
    expect(edgeIds).not.toContain('web-login-home')
    expect(edgeIds).not.toContain('pg-login->pg-home')
  })

  it('preserves authoritative file semantic nav without inventing', async () => {
    const file = fileWithAuthoritativeNav()
    expect(isAuthoritativeFileSemanticNav(file.nav)).toBe(true)
    const load = await resolveFlowDataBundle({
      preferMysql: false,
      fileBundle: file,
      now: FIXED_NOW,
    })
    expect(load.meta.code).toBe('FILE_FORCED')
    expect(load.bundle.nav?.source).toBe('file')
    expect(load.bundle.nav?.by_project.rn.app_flow.nodes[0]?.node_id).toBe(
      'file-node',
    )
  })

  it('total unavailable has empty explicit semantic layers', async () => {
    const load = await resolveFlowDataBundle({
      preferMysql: true,
      executor: {
        async query() {
          throw new Error('password=nope mysql://u:hunter2@h/db')
        },
      },
      fileBundle: null,
      now: FIXED_NOW,
    })
    expect(load.meta.code).toBe('UNAVAILABLE')
    expect(load.meta.availability).toBe('unavailable')
    expect(load.bundle.nav?.state).toBe('UNAVAILABLE')
    expect(load.bundle.nav?.source).toBe('none')
    expect(load.bundle.nav?.reason).toBeTruthy()
    for (const id of CANON_UI_PROJECT_IDS) {
      expect(load.bundle.nav!.by_project[id].app_flow.edges).toEqual([])
      expect(load.bundle.nav!.by_project[id].page_nav.edges).toEqual([])
      expect(load.bundle.nav!.by_project[id].app_flow.nodes).toEqual([])
      expect(load.bundle.nav!.by_project[id].page_nav.nodes).toEqual([])
    }
    expect(JSON.stringify(load)).not.toMatch(/hunter2|password=nope/)
  })

  it('emptyFlowDataBundle exposes UNAVAILABLE empty nav', () => {
    const b = emptyFlowDataBundle('2026-07-19T00:00:00.000Z')
    expect(b.nav?.state).toBe('UNAVAILABLE')
    expect(b.nav?.layers.app_flow.code).toBe('TABLES_MISSING')
    expect(b.nav?.layers.page_nav.code).toBe('TABLES_MISSING')
  })
})
