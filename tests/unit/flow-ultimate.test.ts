import { describe, expect, it } from 'vitest'

import {
  buildCrossGraph,
  buildGraphForMode,
  buildInventoryNodes,
  buildProjectGraph,
  buildSemanticCrossGraph,
  buildSemanticProjectGraph,
  clientAppFlowEdgeId,
  clientAppFlowNodeId,
  clientInventoryNodeId,
  clientPageNavEdgeId,
  clientPageNavNodeId,
  loadPositions,
  positionStorageKey,
  projectKey,
  projectLabel,
  savePosition,
} from '#/components/flow-ultimate/graph'
import {
  formatNodeMeta,
  hasTechIdLeak,
  hasVisibleTechIdLeak,
  humanizeNodeMeta,
  humanizeScreen,
  humanizeTaskTitle,
  humanizeTitle,
  layerCodeHonestyMessage,
  navHonestyBanner,
  navStateHonestyMessage,
  scrubTechIds,
  statusClass,
  statusLabel,
  stripAllowedApiEndpoints,
  verdictLabel,
} from '#/components/flow-ultimate/humanize'
import type {
  FlowDataBundle,
  FlowDataSemanticNav,
  FlowSemanticLayerMeta,
} from '#/components/flow-ultimate/types'
import { MODE_LABEL, STORAGE_KEY } from '#/components/flow-ultimate/types'
import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'

function layerMeta(
  layer: 'app_flow' | 'page_nav',
  code: FlowSemanticLayerMeta['code'] = 'OK',
  overrides: Partial<FlowSemanticLayerMeta> = {},
): FlowSemanticLayerMeta {
  return {
    layer,
    code,
    tablesRequired: [],
    tablesPresent: [],
    rawNodeCount: 0,
    rawEdgeCount: 0,
    projectedNodeCount: 0,
    projectedEdgeCount: 0,
    droppedDangling: 0,
    droppedUnknownProject: 0,
    droppedDuplicate: 0,
    droppedCrossProject: 0,
    droppedInvalid: 0,
    reasons: [],
    ...overrides,
  }
}

function emptyProject(id: string) {
  return {
    project_id: id,
    app_flow: { nodes: [] as never[], edges: [] as never[] },
    page_nav: { nodes: [] as never[], edges: [] as never[] },
  }
}

const semanticNavOk: FlowDataSemanticNav = {
  version: 1,
  source: 'mysql',
  state: 'OK',
  sourceHash: 'test-hash',
  boardId: 'mfs-rebuild',
  by_project: {
    rn: {
      project_id: 'rn',
      app_flow: {
        nodes: [
          {
            node_id: 'Login',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: 'FEAT-AUTH-MEMBER',
            label_id: 'Masuk',
            kind: 'screen',
            sort_order: 1,
            layout_col: 0,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
          {
            node_id: 'home',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: null,
            label_id: 'Beranda',
            kind: 'screen',
            sort_order: 2,
            layout_col: 1,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
          {
            // Intentional raw-id collision with page_nav space
            node_id: 'login',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: null,
            label_id: 'Masuk (legacy id)',
            kind: 'screen',
            sort_order: 3,
            layout_col: 0,
            layout_row: 1,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
        ],
        edges: [
          {
            edge_id: 'Login->home',
            from_node: 'Login',
            to_node: 'home',
            edge_kind: 'auth',
            edge_class: 'nav',
            sort_order: 1,
            project_id_storage: 'rn',
            project_id: 'rn',
            provenance: 'app_flow_edges',
          },
          {
            // dangling — endpoint missing
            edge_id: 'Login->ghost',
            from_node: 'Login',
            to_node: 'ghost',
            edge_kind: 'nav',
            edge_class: 'nav',
            sort_order: 2,
            project_id_storage: 'rn',
            project_id: 'rn',
            provenance: 'app_flow_edges',
          },
        ],
      },
      page_nav: {
        nodes: [
          {
            page_id: 'rn-about',
            project_id_storage: 'rn',
            project_id: 'rn',
            label_id: 'Tentang',
            route: '/about',
            area: 'info',
            feature_id: null,
            provenance: 'app_pages',
          },
          {
            page_id: 'rn-home',
            project_id_storage: 'rn',
            project_id: 'rn',
            label_id: 'Beranda laman',
            route: '/home',
            area: 'main',
            feature_id: 'FEAT-AUTH-MEMBER',
            provenance: 'app_pages',
          },
          {
            page_id: 'login',
            project_id_storage: 'rn',
            project_id: 'rn',
            label_id: 'Laman masuk',
            route: '/login',
            area: 'auth',
            feature_id: null,
            provenance: 'app_pages',
          },
        ],
        edges: [
          {
            edge_id: 'rn-about->rn-home',
            from_page: 'rn-about',
            to_page: 'rn-home',
            edge_kind: 'nav_to',
            edge_class: 'page_nav',
            sort_order: 1,
            project_id: 'rn',
            from_project_id_storage: 'rn',
            to_project_id_storage: 'rn',
            provenance: 'nav_edges',
          },
        ],
      },
    },
    'web-member': {
      project_id: 'web-member',
      app_flow: {
        nodes: [
          {
            node_id: 'root',
            project_id_storage: 'web',
            project_id: 'web-member',
            feature_id: 'FEAT-CHECKOUT-WEB',
            label_id: 'Akar web',
            kind: 'hub',
            sort_order: 1,
            layout_col: 0,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
          {
            node_id: 'about',
            project_id_storage: 'web',
            project_id: 'web-member',
            feature_id: null,
            label_id: 'Tentang web',
            kind: 'screen',
            sort_order: 2,
            layout_col: 1,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
        ],
        edges: [
          {
            edge_id: 'root->about',
            from_node: 'root',
            to_node: 'about',
            edge_kind: 'hierarchy',
            edge_class: 'nav',
            sort_order: 1,
            project_id_storage: 'web',
            project_id: 'web-member',
            provenance: 'app_flow_edges',
          },
        ],
      },
      page_nav: { nodes: [], edges: [] },
    },
    'panel-sales': emptyProject('panel-sales'),
    affiliate: emptyProject('affiliate'),
    backend: {
      project_id: 'backend',
      app_flow: {
        nodes: [
          {
            node_id: 'api_root',
            project_id_storage: 'backend',
            project_id: 'backend',
            feature_id: 'FEAT-HARGA-PAKET',
            label_id: 'API root',
            kind: 'hub',
            sort_order: 1,
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
    app_flow: layerMeta('app_flow', 'OK', {
      projectedNodeCount: 6,
      projectedEdgeCount: 2,
    }),
    page_nav: layerMeta('page_nav', 'OK', {
      projectedNodeCount: 3,
      projectedEdgeCount: 1,
    }),
  },
}

const fixture: FlowDataBundle = {
  projects: {
    version: 1,
    projects: [
      {
        id: 'rn',
        label: 'React Native',
        features: 1,
        tasks: 1,
        pct: 80,
        status: 'sebagian',
      },
    ],
  },
  premium: {
    name: 'Pembelian Premium',
    desc: 'Alur end-to-end',
    steps: [
      {
        n: 1,
        proj: 'sales',
        title: 'Sales set paket & harga',
        st: 'ok',
        api: 'POST /api/admin/product-packages',
      },
      {
        n: 2,
        proj: 'backend',
        title: 'Webhook proses',
        st: 'warn',
        api: 'POST /api/webhooks/cleeng',
      },
    ],
  },
  features: {
    rn: [
      {
        id: 'FEAT-AUTH-MEMBER',
        nama_id: 'Masuk anggota',
        ringkasan_id: 'Login sesi FEAT-AUTH-MEMBER di app',
        status: 'sebagian',
        pct: 70,
        screens: ['/login', 'HomeScreen'],
      },
    ],
    'web-member': [
      {
        id: 'FEAT-AUTH-MEMBER',
        nama_id: 'Masuk web',
        status: 'terbukti',
        pct: 100,
        screens: ['/login'],
      },
      {
        id: 'FEAT-CHECKOUT-WEB',
        nama_id: 'Checkout web',
        status: 'sebagian',
        pct: 90,
        screens: ['/premium'],
      },
    ],
    'panel-sales': [],
    affiliate: [],
    backend: [
      {
        id: 'FEAT-HARGA-PAKET',
        nama_id: 'Harga paket',
        status: 'terbukti',
        pct: 100,
        screens: [],
      },
    ],
  },
  tasks_by_feature: {
    'FEAT-AUTH-MEMBER': [
      {
        id: 'T-AUTH-01',
        judul_id: 'T-AUTH-01 Wire login screen',
        verdict: 'MAPPED_100',
      },
    ],
  },
  apis_by_feature: {
    'FEAT-AUTH-MEMBER': [{ method: 'POST', path: '/api/auth/login' }],
  },
  premium_apis: [
    { n: 1, method: 'POST', path: '/api/admin/product-packages', proj: 'sales' },
  ],
  nav: semanticNavOk,
}

/** Features only — no nav block (legacy / absent semantic). */
const fixtureNoNav: FlowDataBundle = {
  ...fixture,
  nav: undefined,
}

const fixtureNoSemanticSource: FlowDataBundle = {
  ...fixture,
  nav: {
    version: 1,
    source: 'none',
    state: 'NO_SEMANTIC_SOURCE',
    sourceHash: '',
    boardId: 'mfs-rebuild',
    by_project: {
      rn: emptyProject('rn'),
      'web-member': emptyProject('web-member'),
      'panel-sales': emptyProject('panel-sales'),
      affiliate: emptyProject('affiliate'),
      backend: emptyProject('backend'),
    },
    layers: {
      app_flow: layerMeta('app_flow', 'EMPTY_ROWS'),
      page_nav: layerMeta('page_nav', 'EMPTY_ROWS'),
    },
    reason: 'file path without semantic tables',
  },
}

describe('flow-ultimate humanize', () => {
  it('scrubs technical IDs from display text with id-ID replacements', () => {
    const s = scrubTechIds(
      'Tugas FEAT-AUTH-MEMBER dan T-WEB-001 MAPPED_100 PROD_READY MISSING sales-rebuild',
    )
    expect(s).not.toMatch(/FEAT-/)
    expect(s).not.toMatch(/\bT-WEB-001\b/)
    expect(s).not.toMatch(/MAPPED_100/)
    expect(s).not.toMatch(/PROD_READY/)
    expect(s).not.toMatch(/\bMISSING\b/)
    expect(s).not.toMatch(/sales-rebuild/)
    expect(s).toMatch(/fitur terkait/)
    expect(s).toMatch(/tugas terkait/)
    expect(s).toMatch(/terbukti penuh/)
    expect(s).toMatch(/siap produksi/)
    expect(s).toMatch(/belum/)
    expect(s).toMatch(/repo terkait/)
    expect(hasTechIdLeak(s)).toBe(false)
  })

  it('does not corrupt API METHOD + /path blocks', () => {
    const raw = 'Panggil POST /api/auth/login lalu FEAT-AUTH-MEMBER'
    const s = scrubTechIds(raw)
    expect(s).toMatch(/POST \/api\/auth\/login/)
    expect(s).not.toMatch(/FEAT-/)
    expect(hasVisibleTechIdLeak(s)).toBe(false)
    expect(stripAllowedApiEndpoints('POST /api/x FEAT-Y')).not.toMatch(/POST/)
    expect(hasVisibleTechIdLeak('POST /api/auth/login')).toBe(false)
    expect(hasVisibleTechIdLeak('POST /api/auth/login FEAT-AUTH')).toBe(true)
  })

  it('humanizes screens and titles in id-ID', () => {
    expect(humanizeScreen('/premium')).toBe('Premium')
    expect(humanizeScreen('login')).toBe('Masuk')
    expect(humanizeScreen('home')).toBe('Beranda')
    expect(humanizeScreen(null)).toBe('Layar')
    expect(humanizeTitle('/premium — pricing appears')).toMatch(/Premium/)
    expect(humanizeTaskTitle('T-AUTH-01 Wire login screen')).toMatch(
      /Wire login screen/,
    )
    expect(hasTechIdLeak(humanizeTaskTitle('T-AUTH-01 Wire login screen'))).toBe(
      false,
    )
    expect(humanizeTaskTitle(null)).toBe('Tugas')
    expect(humanizeTitle(null)).toBe('Langkah')
    expect(scrubTechIds('FEAT-X and T-WEB-001')).toMatch(/\b(tugas|fitur)\b/)
  })

  it('maps status labels to owner-readable id-ID', () => {
    expect(statusClass('MAPPED_100')).toBe('ok')
    expect(statusClass('MISSING')).toBe('bad')
    expect(statusLabel('terbukti')).toBe('Terbukti')
    expect(statusLabel('sebagian')).toBe('Sebagian')
    expect(statusLabel('belum')).toBe('Belum')
    expect(statusLabel('MISSING')).toBe('Belum')
    expect(verdictLabel('MAPPED_100')).toBe('Terbukti')
    expect(verdictLabel('MISSING')).toBe('Belum')
    expect(verdictLabel(null)).toBe('Sebagian')
  })

  it('node meta uses id-ID layar / % terverifikasi (not EN screens)', () => {
    expect(formatNodeMeta(3, 80)).toBe('3 layar · 80% terverifikasi')
    expect(formatNodeMeta(0, 50)).toBe('50% terverifikasi')
    expect(humanizeNodeMeta('2 screens · 70%')).toBe(
      '2 layar · 70% terverifikasi',
    )
    expect(humanizeNodeMeta('100%')).toBe('100% terverifikasi')

    const g = buildCrossGraph(fixture, {})
    for (const n of g.nodes) {
      const visible = humanizeNodeMeta(n.meta)
      expect(visible).not.toMatch(/\bscreens\b/i)
      expect(visible).not.toMatch(/\bProven\b/)
      if (/\d+/.test(visible) && visible.includes('%')) {
        expect(visible).toMatch(/terverifikasi/)
      }
    }
  })

  it('mode labels are owner id-ID chrome', () => {
    expect(MODE_LABEL.cross).toBe('Lintas Proyek')
    expect(MODE_LABEL.rn).toBe('React Native')
    expect(MODE_LABEL['web-member']).toBe('Web Member')
    expect(MODE_LABEL['panel-sales']).toBe('Panel Sales')
    expect(MODE_LABEL.affiliate).toBe('Afiliasi')
    expect(MODE_LABEL.backend).toBe('Backend')
  })

  it('C-HUM / honesty: nav state + layer codes are id-ID without technical leaks', () => {
    expect(navStateHonestyMessage('OK')).toBeNull()
    expect(navStateHonestyMessage('NO_SEMANTIC_SOURCE')).toMatch(/navigasi/)
    expect(navStateHonestyMessage('UNAVAILABLE')).toMatch(/tidak tersedia/)
    expect(navStateHonestyMessage('PARTIAL')).toMatch(/sebagian/)
    expect(layerCodeHonestyMessage('EMPTY_ROWS')).toMatch(/Belum ada data/)
    expect(layerCodeHonestyMessage('TABLES_MISSING')).toMatch(/Tabel navigasi/)
    expect(layerCodeHonestyMessage('DB_ERROR')).toMatch(/Gagal/)
    expect(layerCodeHonestyMessage('PROJECTED_EMPTY')).toMatch(/proyeksi/)
    for (const msg of [
      navStateHonestyMessage('NO_SEMANTIC_SOURCE'),
      layerCodeHonestyMessage('DB_ERROR'),
      navHonestyBanner(fixtureNoSemanticSource.nav, 'app_flow'),
    ]) {
      expect(msg).toBeTruthy()
      expect(hasVisibleTechIdLeak(msg!)).toBe(false)
      expect(msg).not.toMatch(/SELECT|FROM|WHERE|FEAT-|TABLES_MISSING|NO_SEMANTIC/)
    }
  })
})

describe('flow-ultimate semantic client IDs (C-ID-1)', () => {
  it('namespaces cannot collide for equal raw ids', () => {
    const af = clientAppFlowNodeId('rn', 'login')
    const pn = clientPageNavNodeId('rn', 'login')
    const inv = clientInventoryNodeId('rn', 'FEAT-AUTH-MEMBER')
    expect(af).toBe('af:rn:login')
    expect(pn).toBe('pn:rn:login')
    expect(inv).toBe('inv:rn:FEAT-AUTH-MEMBER')
    expect(new Set([af, pn, inv]).size).toBe(3)
    expect(clientAppFlowEdgeId('rn', 'Login->home')).toBe('nav:rn:Login->home')
    expect(clientPageNavEdgeId('rn-about->rn-home')).toBe(
      'page_nav:rn-about->rn-home',
    )
  })
})

describe('flow-ultimate semantic graph builders', () => {
  it('C-AF-1: app_flow Login→home attaches with prefixed ids; titles humanized', () => {
    const g = buildSemanticProjectGraph(fixture, 'rn', 'app_flow', {})
    const login = g.nodes.find((n) => n.id === 'af:rn:Login')
    const home = g.nodes.find((n) => n.id === 'af:rn:home')
    expect(login).toBeTruthy()
    expect(home).toBeTruthy()
    expect(login!.kind).toBe('journey_app')
    expect(login!.title).toMatch(/Masuk/i)
    expect(hasTechIdLeak(login!.title)).toBe(false)
    expect(
      g.edges.some((e) => e.from === 'af:rn:Login' && e.to === 'af:rn:home'),
    ).toBe(true)
    expect(g.edges.every((e) => e.edge_class === 'nav')).toBe(true)
    // dangling ghost dropped
    expect(g.edges.some((e) => e.to.includes('ghost'))).toBe(false)
    // inventory present unconnected
    const inv = g.nodes.filter((n) => n.kind === 'inventory')
    expect(inv.some((n) => n.id === 'inv:rn:FEAT-AUTH-MEMBER')).toBe(true)
    for (const e of g.edges) {
      expect(e.from.startsWith('inv:')).toBe(false)
      expect(e.to.startsWith('inv:')).toBe(false)
    }
  })

  it('C-PN-1: page_nav edges separate from app_flow even when raw id equals login', () => {
    const app = buildSemanticProjectGraph(fixture, 'rn', 'app_flow', {})
    const page = buildSemanticProjectGraph(fixture, 'rn', 'page_nav', {})
    expect(app.nodes.some((n) => n.id === 'af:rn:login')).toBe(true)
    expect(page.nodes.some((n) => n.id === 'pn:rn:login')).toBe(true)
    expect(
      page.edges.some(
        (e) => e.from === 'pn:rn:rn-about' && e.to === 'pn:rn:rn-home',
      ),
    ).toBe(true)
    expect(page.edges.every((e) => e.edge_class === 'page_nav')).toBe(true)
    // namespaces never mixed in one graph
    expect(app.edges.every((e) => e.from.startsWith('af:'))).toBe(true)
    expect(page.edges.every((e) => e.from.startsWith('pn:'))).toBe(true)
  })

  it('C-NI-1: features present, nav absent → zero edges (no COL_CAP fiction)', () => {
    const g = buildProjectGraph(fixtureNoNav, 'web-member', {})
    expect(g.nodes.length).toBe(2)
    expect(g.nodes.every((n) => n.kind === 'inventory')).toBe(true)
    expect(g.edges).toHaveLength(0)
  })

  it('C-NI-1b: NO_SEMANTIC_SOURCE → inventory only, zero edges', () => {
    const g = buildGraphForMode(fixtureNoSemanticSource, 'rn', {}, 'app_flow')
    expect(g.edges).toHaveLength(0)
    expect(g.nodes.every((n) => n.kind === 'inventory')).toBe(true)
  })

  it('C-NI-2: journey nodes present, empty edges → no list-order chain', () => {
    const emptyEdges: FlowDataBundle = {
      ...fixture,
      nav: {
        ...semanticNavOk,
        by_project: {
          ...semanticNavOk.by_project,
          rn: {
            ...semanticNavOk.by_project.rn,
            app_flow: {
              nodes: semanticNavOk.by_project.rn.app_flow.nodes,
              edges: [],
            },
          },
        },
      },
    }
    const g = buildSemanticProjectGraph(emptyEdges, 'rn', 'app_flow', {})
    const journey = g.nodes.filter((n) => n.kind === 'journey_app')
    expect(journey.length).toBeGreaterThan(1)
    expect(g.edges).toHaveLength(0)
  })

  it('C-NI-3: source has no list-order / sequential fiction edge synthesis', () => {
    const src = readFileSync(
      resolve(__dirname, '../../src/components/flow-ultimate/graph.ts'),
      'utf8',
    )
    // Forbidden patterns from the removed synthetic builders
    expect(src).not.toMatch(/\bCOL_CAP\b/)
    expect(src).not.toMatch(/if \(i > 0\) es\.push/)
    expect(src).not.toMatch(/if \(row > 0\)/)
    expect(src).not.toMatch(/placeFlow\('auth'/)
    expect(src).not.toMatch(/placeFlow\('premium'/)
    expect(src).not.toMatch(/premiumFeatureMap/)
    // Edges only via semantic mappers
    expect(src).toMatch(/mapAppFlowEdge/)
    expect(src).toMatch(/mapPageNavEdge/)
  })

  it('C-X-1: cross is multi-project app_flow union; no synthetic sequential fiction', () => {
    const g = buildSemanticCrossGraph(fixture, {})
    expect(g.nodes.some((n) => n.id === 'af:rn:Login')).toBe(true)
    expect(g.nodes.some((n) => n.id === 'af:web-member:root')).toBe(true)
    expect(g.nodes.some((n) => n.id === 'af:backend:api_root')).toBe(true)
    // no premium/auth/aff/iap fiction
    expect(g.nodes.some((n) => /^premium:\d+$/.test(n.id))).toBe(false)
    expect(g.nodes.some((n) => /^auth:\d+$/.test(n.id))).toBe(false)
    expect(g.nodes.some((n) => /^aff:\d+$/.test(n.id))).toBe(false)
    expect(g.nodes.some((n) => /^iap:\d+$/.test(n.id))).toBe(false)
    // no inventory in cross
    expect(g.nodes.some((n) => n.kind === 'inventory')).toBe(false)
    // no inter-project edges
    for (const e of g.edges) {
      const fromProj = e.from.split(':')[1]
      const toProj = e.to.split(':')[1]
      expect(fromProj).toBe(toProj)
    }
    expect(
      g.edges.some((e) => e.from === 'af:rn:Login' && e.to === 'af:rn:home'),
    ).toBe(true)
  })

  it('C-X-1b: cross without nav invents nothing', () => {
    const g = buildCrossGraph(fixtureNoNav, {})
    expect(g.nodes).toHaveLength(0)
    expect(g.edges).toHaveLength(0)
  })

  it('C-POS-1: saved positions key by client node id + mode:layer; layout_col/row used', () => {
    expect(positionStorageKey('cross')).toBe('cross:app_flow')
    expect(positionStorageKey('rn', 'app_flow')).toBe('rn:app_flow')
    expect(positionStorageKey('rn', 'page_nav')).toBe('rn:page_nav')
    expect(STORAGE_KEY).toBe('cairn-flow-pos-v1')

    const g = buildSemanticProjectGraph(fixture, 'rn', 'app_flow', {
      'af:rn:Login': { x: 999, y: 888 },
    })
    const login = g.nodes.find((n) => n.id === 'af:rn:Login')!
    expect(login.x).toBe(999)
    expect(login.y).toBe(888)
    // layout_col=1 for home when no saved
    const home = g.nodes.find((n) => n.id === 'af:rn:home')!
    expect(home.x).toBe(40 + 1 * (200 + 72))

    // namespacing: old bare FEAT id under mode key cannot hit af: node
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
      savePosition('rn', 'FEAT-AUTH-MEMBER', 1, 2)
      savePosition('rn:app_flow', 'af:rn:Login', 10, 20)
      expect(loadPositions('rn:app_flow')['af:rn:Login']).toEqual({
        x: 10,
        y: 20,
      })
      expect(loadPositions('rn:app_flow')['FEAT-AUTH-MEMBER']).toBeUndefined()
    }
  })

  it('C-STATE-1: state matrix does not invent edges', () => {
    const states: Array<FlowDataSemanticNav['state']> = [
      'OK',
      'PARTIAL',
      'NO_SEMANTIC_SOURCE',
      'UNAVAILABLE',
    ]
    for (const state of states) {
      const nav: FlowDataSemanticNav = {
        version: 1,
        source: state === 'OK' ? 'mysql' : 'none',
        state,
        sourceHash: '',
        boardId: 'x',
        by_project: {
          rn: emptyProject('rn'),
          'web-member': emptyProject('web-member'),
          'panel-sales': emptyProject('panel-sales'),
          affiliate: emptyProject('affiliate'),
          backend: emptyProject('backend'),
        },
        layers: {
          app_flow: layerMeta(
            'app_flow',
            state === 'OK' ? 'OK' : 'EMPTY_ROWS',
          ),
          page_nav: layerMeta(
            'page_nav',
            state === 'PARTIAL' ? 'TABLES_MISSING' : 'EMPTY_ROWS',
          ),
        },
      }
      const g = buildGraphForMode({ ...fixture, nav }, 'rn', {}, 'app_flow')
      expect(g.edges).toHaveLength(0)
      // still may show inventory from features
      expect(g.nodes.every((n) => n.kind === 'inventory')).toBe(true)
    }
  })

  it('C-REL-1: related neighbors == undirected semantic endpoints only', () => {
    const g = buildSemanticProjectGraph(fixture, 'rn', 'app_flow', {})
    const activeId = 'af:rn:Login'
    const ids = new Set<string>()
    g.edges.forEach((e) => {
      if (e.from === activeId) ids.add(e.to)
      if (e.to === activeId) ids.add(e.from)
    })
    expect([...ids]).toEqual(['af:rn:home'])
    // same feature inventory must NOT be in semantic related set
    expect(ids.has('inv:rn:FEAT-AUTH-MEMBER')).toBe(false)
  })

  it('inventory builder never emits edges', () => {
    const inv = buildInventoryNodes(fixture, 'web-member', {})
    expect(inv).toHaveLength(2)
    expect(inv.every((n) => n.kind === 'inventory')).toBe(true)
    expect(inv.every((n) => n.id.startsWith('inv:'))).toBe(true)
  })

  it('buildGraphForMode switches cross vs project + layer', () => {
    const cross = buildGraphForMode(fixture, 'cross', {})
    const rnApp = buildGraphForMode(fixture, 'rn', {}, 'app_flow')
    const rnPage = buildGraphForMode(fixture, 'rn', {}, 'page_nav')
    expect(cross.nodes.every((n) => n.kind === 'journey_app')).toBe(true)
    expect(rnApp.nodes.some((n) => n.kind === 'journey_app')).toBe(true)
    expect(rnPage.nodes.some((n) => n.kind === 'journey_page')).toBe(true)
    expect(projectKey('sales')).toBe('panel-sales')
    expect(projectLabel('rn')).toBe('React Native')
    expect(projectLabel('affiliate')).toBe('Afiliasi')
  })

  it('C-HUM-1: no FEAT/T-/enum leaks in titles/meta', () => {
    for (const mode of ['cross', 'rn', 'web-member'] as const) {
      const g = buildGraphForMode(
        fixture,
        mode,
        {},
        mode === 'cross' ? 'app_flow' : 'app_flow',
      )
      for (const n of g.nodes) {
        expect(hasTechIdLeak(n.title)).toBe(false)
        expect(hasTechIdLeak(humanizeNodeMeta(n.meta))).toBe(false)
      }
    }
  })
})
