/**
 * Semantic edge materializer unit tests — injectable memory SQL only.
 * No live MySQL. No secrets. LOCAL ONLY.
 * No file fallback. No client layout graph imports.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'

import { CANON_UI_PROJECT_IDS } from '#/lib/canon-flow-projects'
import {
  DEFAULT_SEMANTIC_BOARD_ID,
  SEMANTIC_EDGES_VERSION,
  assertNoLayoutOrCross,
  hashSemanticEdges,
  materializeSemanticEdges,
  redactSecrets,
  resolveProjectFilter,
  sha256Hex,
  stableStringify,
  storageProjectKeysForUi,
  type FlowSemanticSqlExecutor,
  type SemanticEdgesResult,
} from '#/server/flow-semantic-edges'

// ---------------------------------------------------------------------------
// Memory corpus / fake executor
// ---------------------------------------------------------------------------

type Corpus = {
  tables: Set<string>
  app_flow_nodes: Array<Record<string, unknown>>
  app_flow_edges: Array<Record<string, unknown>>
  app_pages: Array<Record<string, unknown>>
  nav_edges: Array<Record<string, unknown>>
  /** When set, query matching pattern throws (after probe). */
  throwOn?: RegExp | string
  throwMessage?: string
}

function baseCorpus(over: Partial<Corpus> = {}): Corpus {
  return {
    tables: new Set(
      over.tables ?? [
        'app_flow_nodes',
        'app_flow_edges',
        'app_pages',
        'nav_edges',
      ],
    ),
    app_flow_nodes: over.app_flow_nodes ?? [],
    app_flow_edges: over.app_flow_edges ?? [],
    app_pages: over.app_pages ?? [],
    nav_edges: over.nav_edges ?? [],
    throwOn: over.throwOn,
    throwMessage: over.throwMessage,
  }
}

function shuffle<T>(arr: T[], seed = 42): T[] {
  const a = arr.slice()
  let s = seed
  for (let i = a.length - 1; i > 0; i--) {
    s = (s * 1664525 + 1013904223) >>> 0
    const j = s % (i + 1)
    ;[a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

function makeExecutor(corpus: Corpus): FlowSemanticSqlExecutor & {
  calls: Array<{ sql: string; params?: unknown[] }>
} {
  const calls: Array<{ sql: string; params?: unknown[] }> = []

  return {
    calls,
    async query(sql: string, params?: Array<unknown>) {
      calls.push({ sql, params })
      const s = sql.replace(/\s+/g, ' ').trim()

      if (corpus.throwOn) {
        const re =
          typeof corpus.throwOn === 'string'
            ? new RegExp(corpus.throwOn, 'i')
            : corpus.throwOn
        if (re.test(s) && !/information_schema/i.test(s)) {
          throw new Error(
            corpus.throwMessage ??
              "Access denied for user 'root'@'localhost' (using password: YES) password=s3cret",
          )
        }
      }

      if (/information_schema\.TABLES/i.test(s)) {
        const names = [...corpus.tables].map((name) => ({ name }))
        return [names]
      }

      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_flow_nodes/i.test(s)) {
        return [[{ n: corpus.app_flow_nodes.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_flow_edges/i.test(s)) {
        return [[{ n: corpus.app_flow_edges.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+app_pages/i.test(s)) {
        return [[{ n: corpus.app_pages.length }]]
      }
      if (/COUNT\(\*\)\s+AS\s+n\s+FROM\s+nav_edges/i.test(s)) {
        return [[{ n: corpus.nav_edges.length }]]
      }

      if (/FROM\s+app_flow_nodes/i.test(s)) {
        let rows = corpus.app_flow_nodes
        if (/WHERE\s+project_id\s+IN/i.test(s) && params?.length) {
          const set = new Set(params.map(String))
          rows = rows.filter((r) => set.has(String(r.project_id)))
        }
        return [rows]
      }
      if (/FROM\s+app_flow_edges/i.test(s)) {
        let rows = corpus.app_flow_edges
        if (/WHERE\s+project_id\s+IN/i.test(s) && params?.length) {
          const set = new Set(params.map(String))
          rows = rows.filter((r) => set.has(String(r.project_id)))
        }
        return [rows]
      }
      if (/FROM\s+app_pages/i.test(s)) {
        return [corpus.app_pages]
      }
      if (/FROM\s+nav_edges/i.test(s)) {
        return [corpus.nav_edges]
      }

      throw new Error(`unexpected SQL in test executor: ${s.slice(0, 120)}`)
    },
  }
}

function fixtureBothLayers(): Corpus {
  return baseCorpus({
    app_flow_nodes: [
      {
        project_id: 'rn',
        node_id: 'login',
        feature_id: 'FEAT-AUTH-MEMBER',
        label_id: 'Login',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
        source_ref: 'rn/login',
      },
      {
        project_id: 'rn',
        node_id: 'home',
        feature_id: 'FEAT-HOME',
        label_id: 'Home',
        kind: 'screen',
        sort_order: 1,
        layout_col: 1,
        layout_row: 0,
        source_ref: 'rn/home',
      },
      {
        project_id: 'web',
        node_id: 'landing',
        feature_id: null,
        label_id: 'Landing',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'web',
        node_id: 'premium',
        feature_id: 'FEAT-PREMIUM',
        label_id: 'Premium',
        kind: 'screen',
        sort_order: 1,
        layout_col: 1,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'sales',
        node_id: 'root',
        feature_id: null,
        label_id: '/',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'sales',
        node_id: 'admin',
        feature_id: 'FEAT-ADMIN',
        label_id: '/admin',
        kind: 'feature',
        sort_order: 1,
        layout_col: 1,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'affiliate',
        node_id: 'portal',
        feature_id: 'FEAT-AFFILIATE',
        label_id: 'Portal',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
        source_ref: null,
      },
      {
        project_id: 'backend',
        node_id: 'api-root',
        feature_id: null,
        label_id: 'API',
        kind: 'screen',
        sort_order: 0,
        layout_col: 0,
        layout_row: 0,
        source_ref: null,
      },
    ],
    app_flow_edges: [
      {
        project_id: 'rn',
        edge_id: 'e-login-home',
        from_node: 'login',
        to_node: 'home',
        edge_kind: 'auth',
        sort_order: 0,
      },
      {
        project_id: 'web',
        edge_id: 'e-land-prem',
        from_node: 'landing',
        to_node: 'premium',
        edge_kind: 'hierarchy',
        sort_order: 0,
      },
      {
        project_id: 'sales',
        edge_id: 'e-root-admin',
        from_node: 'root',
        to_node: 'admin',
        edge_kind: 'hierarchy',
        sort_order: 0,
      },
    ],
    app_pages: [
      {
        id: 'rn-about',
        project_id: 'rn',
        label_id: 'About',
        route: '/about',
        area: 'info',
        feature_id: null,
      },
      {
        id: 'rn-home',
        project_id: 'rn',
        label_id: 'Home',
        route: '/home',
        area: 'main',
        feature_id: 'FEAT-HOME',
      },
      {
        id: 'web-landing',
        project_id: 'web',
        label_id: 'Landing',
        route: '/',
        area: null,
        feature_id: null,
      },
      {
        id: 'web-premium',
        project_id: 'web-member',
        label_id: 'Premium',
        route: '/premium',
        area: 'pay',
        feature_id: 'FEAT-PREMIUM',
      },
      // Intentionally same string as an app-flow node_id — must stay separate.
      {
        id: 'login',
        project_id: 'affiliate',
        label_id: 'Aff Login Page',
        route: '/aff/login',
        area: 'auth',
        feature_id: null,
      },
      {
        id: 'aff-dash',
        project_id: 'affiliate',
        label_id: 'Dashboard',
        route: '/aff',
        area: 'main',
        feature_id: 'FEAT-AFFILIATE',
      },
    ],
    nav_edges: [
      { from_page: 'rn-about', to_page: 'rn-home' },
      { from_page: 'web-landing', to_page: 'web-premium' },
      { from_page: 'login', to_page: 'aff-dash' },
    ],
  })
}

const FIXED_NOW = () => new Date('2026-07-18T12:00:00.000Z')

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('flow-semantic-edges pure helpers', () => {
  it('stableStringify is key-order independent', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe(stableStringify({ a: 2, b: 1 }))
  })

  it('sha256Hex matches node crypto', () => {
    const s = 'semantic'
    expect(sha256Hex(s)).toBe(
      createHash('sha256').update(s).digest('hex'),
    )
  })

  it('redactSecrets strips credentials', () => {
    const raw =
      "Access denied for user 'root'@'%' password=s3cret mysql://u:p@h/db"
    const out = redactSecrets(raw)
    expect(out).not.toMatch(/s3cret/)
    expect(out).not.toMatch(/mysql:\/\/u:p@/)
    expect(out).toMatch(/Access denied for user '\*\*\*'/)
  })

  it('storageProjectKeysForUi includes ui/appFlow/platform forms', () => {
    const keys = storageProjectKeysForUi(['web-member', 'panel-sales'])
    expect(keys).toEqual(
      expect.arrayContaining([
        'web-member',
        'web',
        'panel-sales',
        'sales',
        'admin',
      ]),
    )
    expect(keys).not.toContain('cross')
  })

  it('resolveProjectFilter: five aliases + unknown + cross', () => {
    const r = resolveProjectFilter([
      'rn',
      'web',
      'sales',
      'aff',
      'be',
      'not-a-project',
      'cross',
      'lintas',
    ])
    expect(r.uiIds).toEqual([
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
    expect(r.unknownProjectAliases).toContain('not-a-project')
    expect(r.omittedInputs.some((o) => o.input === 'cross')).toBe(true)
    expect(r.omittedInputs.find((o) => o.input === 'cross')?.code).toBe(
      'NOT_A_PROJECT',
    )
    expect(r.uiIds).not.toContain('cross' as never)
  })

  it('resolveProjectFilter: empty input → all five UI ids', () => {
    expect(resolveProjectFilter(undefined).uiIds).toEqual([
      ...CANON_UI_PROJECT_IDS,
    ])
    expect(resolveProjectFilter([]).uiIds).toEqual([...CANON_UI_PROJECT_IDS])
  })
})

// ---------------------------------------------------------------------------
// Materialize — happy path & aliases
// ---------------------------------------------------------------------------

describe('materializeSemanticEdges', () => {
  it('requires injected executor (no live DB default)', async () => {
    await expect(
      materializeSemanticEdges({
        // @ts-expect-error intentional
        executor: undefined,
      }),
    ).rejects.toThrow(/injected executor/)
  })

  it('T1: five aliases map to five UI project keys with real edges', async () => {
    const exec = makeExecutor(fixtureBothLayers())
    const result = await materializeSemanticEdges({
      executor: exec,
      projectIds: ['rn', 'web', 'sales', 'affiliate', 'backend'],
      now: FIXED_NOW,
    })

    expect(result.version).toBe(SEMANTIC_EDGES_VERSION)
    expect(result.boardId).toBe(DEFAULT_SEMANTIC_BOARD_ID)
    expect(result.generatedAt).toBe('2026-07-18T12:00:00.000Z')
    expect(Object.keys(result.by_project).sort()).toEqual(
      [...CANON_UI_PROJECT_IDS].sort(),
    )
    expect(result.by_project).not.toHaveProperty('cross')

    // app-flow aliases: web→web-member, sales→panel-sales
    expect(result.by_project.rn.app_flow.edges).toHaveLength(1)
    expect(result.by_project.rn.app_flow.edges[0]).toMatchObject({
      from_node: 'login',
      to_node: 'home',
      edge_kind: 'auth',
      edge_class: 'nav',
      provenance: 'app_flow_edges',
    })
    expect(result.by_project['web-member'].app_flow.edges).toHaveLength(1)
    expect(result.by_project['panel-sales'].app_flow.edges).toHaveLength(1)
    expect(result.by_project.affiliate.app_flow.nodes).toHaveLength(1)
    expect(result.by_project.backend.app_flow.nodes).toHaveLength(1)

    // page-nav
    expect(result.by_project.rn.page_nav.edges).toHaveLength(1)
    expect(result.by_project.rn.page_nav.edges[0]).toMatchObject({
      from_page: 'rn-about',
      to_page: 'rn-home',
      edge_class: 'page_nav',
      edge_kind: 'nav_to',
      provenance: 'nav_edges',
    })
    expect(result.layers.app_flow.code).toBe('OK')
    expect(result.layers.page_nav.code).toBe('OK')
    expect(assertNoLayoutOrCross(result)).toEqual({ ok: true })
  })

  it('T2: unknown aliases omitted with diagnostics; not assigned to backend', async () => {
    const exec = makeExecutor(fixtureBothLayers())
    const result = await materializeSemanticEdges({
      executor: exec,
      projectIds: ['rn', 'totally-unknown', 'cross', ''],
      now: FIXED_NOW,
    })
    expect(result.diagnostics.requestedProjects).toEqual(['rn'])
    expect(result.diagnostics.unknownProjectAliases).toEqual(
      expect.arrayContaining(['totally-unknown']),
    )
    expect(
      result.diagnostics.omittedInputs.some((o) => o.code === 'NOT_A_PROJECT'),
    ).toBe(true)
    // Only rn projected
    expect(result.by_project.rn.app_flow.edges.length).toBeGreaterThan(0)
    expect(result.by_project.backend.app_flow.nodes).toHaveLength(0)
    expect(result.by_project.backend.app_flow.edges).toHaveLength(0)
    expect(result.by_project['web-member'].app_flow.edges).toHaveLength(0)
    expect(result.by_project).not.toHaveProperty('cross')
  })

  it('T3: deterministic under shuffled DB row order (stable hash)', async () => {
    const base = fixtureBothLayers()
    const a = makeExecutor({
      ...base,
      app_flow_nodes: shuffle(base.app_flow_nodes, 1),
      app_flow_edges: shuffle(base.app_flow_edges, 2),
      app_pages: shuffle(base.app_pages, 3),
      nav_edges: shuffle(base.nav_edges, 4),
    })
    const b = makeExecutor({
      ...base,
      app_flow_nodes: shuffle(base.app_flow_nodes, 99),
      app_flow_edges: shuffle(base.app_flow_edges, 98),
      app_pages: shuffle(base.app_pages, 97),
      nav_edges: shuffle(base.nav_edges, 96),
    })
    const ra = await materializeSemanticEdges({
      executor: a,
      now: () => new Date('2026-07-18T12:00:00.000Z'),
    })
    const rb = await materializeSemanticEdges({
      executor: b,
      now: () => new Date('2026-07-18T23:59:59.000Z'), // different timestamp
    })
    expect(ra.sourceHash).toBe(rb.sourceHash)
    expect(ra.by_project.rn.app_flow.edges.map((e) => e.edge_id)).toEqual(
      rb.by_project.rn.app_flow.edges.map((e) => e.edge_id),
    )
    // generatedAt may differ; hash must not
    expect(ra.generatedAt).not.toBe(rb.generatedAt)
  })

  it('T4: no invented edges from feature/grid/order (empty edges tables)', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: fixtureBothLayers().app_flow_nodes,
      app_flow_edges: [],
      app_pages: fixtureBothLayers().app_pages,
      nav_edges: [],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    for (const id of CANON_UI_PROJECT_IDS) {
      expect(result.by_project[id].app_flow.edges).toEqual([])
      expect(result.by_project[id].page_nav.edges).toEqual([])
    }
    // Nodes may exist; edges never synthesized
    expect(result.by_project.rn.app_flow.nodes.length).toBeGreaterThan(0)
    expect(result.layers.app_flow.projectedEdgeCount).toBe(0)
    expect(result.layers.page_nav.projectedEdgeCount).toBe(0)
  })

  it('T5: dangling endpoints dropped with counts/reasons', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: [
        {
          project_id: 'rn',
          node_id: 'login',
          label_id: 'Login',
          kind: 'screen',
          sort_order: 0,
          layout_col: 0,
          layout_row: 0,
        },
      ],
      app_flow_edges: [
        {
          project_id: 'rn',
          edge_id: 'e-dangle',
          from_node: 'login',
          to_node: 'missing-home',
          edge_kind: 'nav',
          sort_order: 0,
        },
        {
          project_id: 'rn',
          edge_id: 'e-both-missing',
          from_node: 'ghost-a',
          to_node: 'ghost-b',
          edge_kind: 'nav',
          sort_order: 1,
        },
      ],
      app_pages: [
        {
          id: 'p1',
          project_id: 'rn',
          label_id: 'P1',
          route: '/p1',
        },
      ],
      nav_edges: [
        { from_page: 'p1', to_page: 'no-such-page' },
        { from_page: 'also-missing', to_page: 'p1' },
      ],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.by_project.rn.app_flow.edges).toHaveLength(0)
    expect(result.layers.app_flow.droppedDangling).toBe(2)
    expect(
      result.layers.app_flow.reasons.some((r) => r.code === 'DANGLING_ENDPOINT'),
    ).toBe(true)
    expect(result.by_project.rn.page_nav.edges).toHaveLength(0)
    expect(result.layers.page_nav.droppedDangling).toBe(2)
  })

  it('T6: duplicate edge deterministic collapse (same PK identity)', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: [
        {
          project_id: 'rn',
          node_id: 'a',
          label_id: 'A',
          kind: 'screen',
          sort_order: 0,
          layout_col: 0,
          layout_row: 0,
        },
        {
          project_id: 'rn',
          node_id: 'b',
          label_id: 'B',
          kind: 'screen',
          sort_order: 1,
          layout_col: 1,
          layout_row: 0,
        },
      ],
      app_flow_edges: [
        {
          project_id: 'rn',
          edge_id: 'dup',
          from_node: 'a',
          to_node: 'b',
          edge_kind: 'nav',
          sort_order: 5,
        },
        {
          project_id: 'rn',
          edge_id: 'dup',
          from_node: 'a',
          to_node: 'b',
          edge_kind: 'hub', // later duplicate — collapsed
          sort_order: 5,
        },
        // Distinct edge_id same endpoints — preserved
        {
          project_id: 'rn',
          edge_id: 'other',
          from_node: 'a',
          to_node: 'b',
          edge_kind: 'branch',
          sort_order: 6,
        },
      ],
      app_pages: [
        { id: 'x', project_id: 'rn', label_id: 'X', route: '/x' },
        { id: 'y', project_id: 'rn', label_id: 'Y', route: '/y' },
      ],
      nav_edges: [
        { from_page: 'x', to_page: 'y' },
        { from_page: 'x', to_page: 'y' }, // PK duplicate
      ],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.by_project.rn.app_flow.edges.map((e) => e.edge_id).sort()).toEqual(
      ['dup', 'other'],
    )
    expect(result.layers.app_flow.droppedDuplicate).toBeGreaterThanOrEqual(1)
    expect(result.by_project.rn.page_nav.edges).toHaveLength(1)
    expect(result.layers.page_nav.droppedDuplicate).toBeGreaterThanOrEqual(1)
  })

  it('T7: app-flow node_id and page_id collision stay in separate ID spaces', async () => {
    const result = await materializeSemanticEdges({
      executor: makeExecutor(fixtureBothLayers()),
      now: FIXED_NOW,
    })
    // app-flow rn has node_id "login"
    expect(
      result.by_project.rn.app_flow.nodes.some((n) => n.node_id === 'login'),
    ).toBe(true)
    // page-nav affiliate has page_id "login" — different layer, not merged
    expect(
      result.by_project.affiliate.page_nav.nodes.some(
        (n) => n.page_id === 'login',
      ),
    ).toBe(true)
    // Must not appear as page under rn app_flow or vice-versa
    expect(
      result.by_project.rn.page_nav.nodes.some((n) => n.page_id === 'login'),
    ).toBe(false)
    expect(
      result.by_project.affiliate.app_flow.nodes.some(
        (n) => n.node_id === 'login',
      ),
    ).toBe(false)
    // Edge endpoints keep their own space
    const affEdge = result.by_project.affiliate.page_nav.edges.find(
      (e) => e.from_page === 'login',
    )
    expect(affEdge?.to_page).toBe('aff-dash')
    expect(affEdge?.edge_class).toBe('page_nav')
  })

  it('T8: missing 011 tables with valid 012 — independent layers', async () => {
    const corpus = baseCorpus({
      tables: new Set(['app_pages', 'nav_edges']),
      app_pages: fixtureBothLayers().app_pages,
      nav_edges: fixtureBothLayers().nav_edges,
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.app_flow.code).toBe('TABLES_MISSING')
    expect(result.layers.page_nav.code).toBe('OK')
    expect(result.by_project.rn.page_nav.edges.length).toBeGreaterThan(0)
    for (const id of CANON_UI_PROJECT_IDS) {
      expect(result.by_project[id].app_flow.edges).toEqual([])
      expect(result.by_project[id].app_flow.nodes).toEqual([])
    }
  })

  it('T9: missing 012 tables with valid 011 — independent layers', async () => {
    const corpus = baseCorpus({
      tables: new Set(['app_flow_nodes', 'app_flow_edges']),
      app_flow_nodes: fixtureBothLayers().app_flow_nodes,
      app_flow_edges: fixtureBothLayers().app_flow_edges,
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.page_nav.code).toBe('TABLES_MISSING')
    expect(result.layers.app_flow.code).toBe('OK')
    expect(result.by_project.rn.app_flow.edges.length).toBeGreaterThan(0)
    for (const id of CANON_UI_PROJECT_IDS) {
      expect(result.by_project[id].page_nav.edges).toEqual([])
      expect(result.by_project[id].page_nav.nodes).toEqual([])
    }
  })

  it('T10: both layers empty tables → EMPTY_ROWS', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: [],
      app_flow_edges: [],
      app_pages: [],
      nav_edges: [],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.app_flow.code).toBe('EMPTY_ROWS')
    expect(result.layers.page_nav.code).toBe('EMPTY_ROWS')
    expect(result.layers.app_flow.rawNodeCount).toBe(0)
    expect(result.layers.page_nav.rawNodeCount).toBe(0)
  })

  it('T11: projected empty — rows exist but unknown/filtered projects only', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: [
        {
          project_id: 'martian-app',
          node_id: 'x',
          label_id: 'X',
          kind: 'screen',
          sort_order: 0,
          layout_col: 0,
          layout_row: 0,
        },
      ],
      app_flow_edges: [
        {
          project_id: 'martian-app',
          edge_id: 'e1',
          from_node: 'x',
          to_node: 'x',
          edge_kind: 'nav',
          sort_order: 0,
        },
      ],
      app_pages: [
        {
          id: 'p-mars',
          project_id: 'outer-space',
          label_id: 'Mars',
          route: '/mars',
        },
      ],
      nav_edges: [{ from_page: 'p-mars', to_page: 'p-mars' }],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.app_flow.code).toBe('PROJECTED_EMPTY')
    expect(result.layers.page_nav.code).toBe('PROJECTED_EMPTY')
    expect(result.layers.app_flow.rawNodeCount).toBeGreaterThan(0)
    expect(result.layers.app_flow.droppedUnknownProject).toBeGreaterThan(0)
    expect(result.layers.page_nav.droppedUnknownProject).toBeGreaterThan(0)
  })

  it('T12: DB throw is redacted; layers report DB_ERROR independently', async () => {
    const corpus = baseCorpus({
      throwOn: /app_flow_nodes|app_pages/,
      throwMessage:
        "Access denied for user 'admin'@'%' password=hunter2 DATABASE_URL=mysql://u:p@h/db",
      app_flow_nodes: fixtureBothLayers().app_flow_nodes,
      app_flow_edges: fixtureBothLayers().app_flow_edges,
      app_pages: fixtureBothLayers().app_pages,
      nav_edges: fixtureBothLayers().nav_edges,
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.app_flow.code).toBe('DB_ERROR')
    expect(result.layers.page_nav.code).toBe('DB_ERROR')
    const detail =
      (result.layers.app_flow.detail ?? '') +
      (result.layers.page_nav.detail ?? '')
    expect(detail).not.toMatch(/hunter2/)
    expect(detail).not.toMatch(/mysql:\/\/u:p@/)
    expect(detail).not.toMatch(/password=hunter2/i)
  })

  it('T13: no N+1 — query count bounded independent of row volume', async () => {
    const manyNodes = Array.from({ length: 50 }, (_, i) => ({
      project_id: 'rn',
      node_id: `n${i}`,
      label_id: `N${i}`,
      kind: 'screen',
      sort_order: i,
      layout_col: i % 5,
      layout_row: Math.floor(i / 5),
    }))
    const manyEdges = Array.from({ length: 49 }, (_, i) => ({
      project_id: 'rn',
      edge_id: `e${i}`,
      from_node: `n${i}`,
      to_node: `n${i + 1}`,
      edge_kind: 'nav',
      sort_order: i,
    }))
    const manyPages = Array.from({ length: 40 }, (_, i) => ({
      id: `p${i}`,
      project_id: 'rn',
      label_id: `P${i}`,
      route: `/p${i}`,
    }))
    const manyNav = Array.from({ length: 39 }, (_, i) => ({
      from_page: `p${i}`,
      to_page: `p${i + 1}`,
    }))

    const small = makeExecutor(fixtureBothLayers())
    const large = makeExecutor(
      baseCorpus({
        app_flow_nodes: manyNodes,
        app_flow_edges: manyEdges,
        app_pages: manyPages,
        nav_edges: manyNav,
      }),
    )

    const rs = await materializeSemanticEdges({
      executor: small,
      now: FIXED_NOW,
    })
    const rl = await materializeSemanticEdges({
      executor: large,
      now: FIXED_NOW,
    })
    // probe(1) + app_flow(2) + page_nav(2) = 5 for full portfolio
    expect(rs.queryCount).toBe(rl.queryCount)
    expect(rs.queryCount).toBeLessThanOrEqual(8)
    expect(small.calls.length).toBe(rs.queryCount)
    expect(large.calls.length).toBe(rl.queryCount)
    // No per-row queries
    expect(large.calls.every((c) => !/WHERE\s+node_id\s*=/i.test(c.sql))).toBe(
      true,
    )
  })

  it('T14: sourceHash flips when a semantic edge changes', async () => {
    const a = fixtureBothLayers()
    const b: Corpus = {
      ...fixtureBothLayers(),
      app_flow_edges: [
        ...fixtureBothLayers().app_flow_edges,
        {
          project_id: 'rn',
          edge_id: 'e-new',
          from_node: 'home',
          to_node: 'login',
          edge_kind: 'nav',
          sort_order: 9,
        },
      ],
    }
    // Ensure home→login endpoints exist (they do in fixture)
    const ra = await materializeSemanticEdges({
      executor: makeExecutor(a),
      now: FIXED_NOW,
    })
    const rb = await materializeSemanticEdges({
      executor: makeExecutor(b),
      now: FIXED_NOW,
    })
    expect(ra.sourceHash).not.toBe(rb.sourceHash)
    // Recompute pure hash helper
    expect(
      hashSemanticEdges(
        ra.by_project,
        ra.layers,
        ra.diagnostics.requestedProjects,
      ),
    ).toBe(ra.sourceHash)
  })

  it('T15: cross is impossible as a data project key', async () => {
    const result = await materializeSemanticEdges({
      executor: makeExecutor(fixtureBothLayers()),
      projectIds: ['cross', 'lintas proyek', 'CROSS'],
      now: FIXED_NOW,
    })
    expect(result.by_project).not.toHaveProperty('cross')
    expect(Object.keys(result.by_project).sort()).toEqual(
      [...CANON_UI_PROJECT_IDS].sort(),
    )
    expect(result.diagnostics.requestedProjects).toEqual([])
    // All aliases were cross → PROJECTED_EMPTY (or EMPTY if no rows scanned)
    expect(
      ['PROJECTED_EMPTY', 'EMPTY_ROWS'].includes(result.layers.app_flow.code),
    ).toBe(true)
    expect(assertNoLayoutOrCross(result).ok).toBe(true)
  })

  it('T16: no file fallback path and no client layout imports', async () => {
    const src = readFileSync(
      'src/server/flow-semantic-edges.ts',
      'utf8',
    )
    expect(src).not.toMatch(/data\/app-flow/)
    expect(src).not.toMatch(/data-bundle\.json/)
    expect(src).not.toMatch(/graph\.json/)
    expect(src).not.toMatch(/flow-ultimate\/graph/)
    expect(src).not.toMatch(/COL_CAP/)
    expect(src).not.toMatch(/buildProjectGraph/)
    expect(src).not.toMatch(/readFile|readFileSync|fs\/promises/)
    // Never invent layout edge class
    expect(src).not.toMatch(/edge_class:\s*['"]layout['"]/)
  })

  it('T17: preserves stored edge_kind and never rewrites node/page ids', async () => {
    const result = await materializeSemanticEdges({
      executor: makeExecutor(fixtureBothLayers()),
      now: FIXED_NOW,
    })
    const e = result.by_project.rn.app_flow.edges[0]
    expect(e.edge_kind).toBe('auth') // stored, not forced to 'nav'
    expect(e.from_node).toBe('login')
    expect(e.to_node).toBe('home')
    expect(e.edge_id).toBe('e-login-home')
    // page ids exact
    const pe = result.by_project.rn.page_nav.edges[0]
    expect(pe.from_page).toBe('rn-about')
    expect(pe.to_page).toBe('rn-home')
    // storage project preserved on app-flow (web stays web, UI is web-member)
    const webEdge = result.by_project['web-member'].app_flow.edges[0]
    expect(webEdge.project_id_storage).toBe('web')
    expect(webEdge.project_id).toBe('web-member')
  })

  it('T18: partial 011 (nodes without edges table) is TABLES_MISSING', async () => {
    const corpus = baseCorpus({
      tables: new Set(['app_flow_nodes', 'app_pages', 'nav_edges']),
      app_flow_nodes: fixtureBothLayers().app_flow_nodes,
      app_pages: fixtureBothLayers().app_pages,
      nav_edges: fixtureBothLayers().nav_edges,
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.app_flow.code).toBe('TABLES_MISSING')
    expect(result.layers.page_nav.code).toBe('OK')
  })

  it('T19: cross-project page_nav edges dropped (not forced into backend)', async () => {
    const corpus = baseCorpus({
      app_flow_nodes: [],
      app_flow_edges: [],
      app_pages: [
        {
          id: 'rn-a',
          project_id: 'rn',
          label_id: 'A',
          route: '/a',
        },
        {
          id: 'web-b',
          project_id: 'web',
          label_id: 'B',
          route: '/b',
        },
      ],
      nav_edges: [{ from_page: 'rn-a', to_page: 'web-b' }],
    })
    const result = await materializeSemanticEdges({
      executor: makeExecutor(corpus),
      now: FIXED_NOW,
    })
    expect(result.layers.page_nav.droppedCrossProject).toBe(1)
    expect(result.by_project.rn.page_nav.edges).toHaveLength(0)
    expect(result.by_project['web-member'].page_nav.edges).toHaveLength(0)
    expect(result.by_project.backend.page_nav.edges).toHaveLength(0)
  })

  it('T20: diagnostics.executorInjected is always true; no live claim fields', async () => {
    const result = await materializeSemanticEdges({
      executor: makeExecutor(fixtureBothLayers()),
      now: FIXED_NOW,
    })
    expect(result.diagnostics.executorInjected).toBe(true)
    const json = JSON.stringify(result)
    expect(json).not.toMatch(/live mysql/i)
    expect(json).not.toMatch(/password/i)
  })
})

// ---------------------------------------------------------------------------
// Source scan: module must not pull client layout graph
// ---------------------------------------------------------------------------

describe('flow-semantic-edges isolation', () => {
  it('does not import client graph or materializer file fallback', async () => {
    // Dynamic import of the module under test is enough; side-effect free.
    const mod = await import('#/server/flow-semantic-edges')
    expect(typeof mod.materializeSemanticEdges).toBe('function')
    expect(mod.SEMANTIC_EDGES_VERSION).toBe(1)
    // Result shape smoke
    const r: SemanticEdgesResult = await mod.materializeSemanticEdges({
      executor: makeExecutor(baseCorpus({ tables: new Set() })),
      now: FIXED_NOW,
    })
    expect(r.layers.app_flow.code).toBe('TABLES_MISSING')
    expect(r.layers.page_nav.code).toBe('TABLES_MISSING')
  })
})
