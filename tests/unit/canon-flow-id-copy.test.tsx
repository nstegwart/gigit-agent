/** @vitest-environment jsdom */
/**
 * Canon v3 — owner standing language: every visible FlowUltimate non-API
 * string is human-readable id-ID. Technical IDs stay off the chrome.
 *
 * R2 residual repair: fixtures seed honest `bundle.nav` semantic app_flow
 * nodes/edges; sheet sections use Navigasi terkait / Fitur sama (not
 * legacy Fitur terkait); empty neighbor copy matches production.
 * Graph nodes come only from production builders — never handcrafted DOM.
 */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { FlowUltimateScreen } from '#/components/flow-ultimate'
import {
  formatNodeMeta,
  hasTechIdLeak,
  hasVisibleTechIdLeak,
  humanizeNodeMeta,
  humanizeScreen,
  humanizeTaskTitle,
  scrubTechIds,
  statusLabel,
  verdictLabel,
} from '#/components/flow-ultimate/humanize'
import type {
  FlowDataBundle,
  FlowDataSemanticNav,
  FlowSemanticLayerMeta,
} from '#/components/flow-ultimate/types'
import { FLOW_MODES, MODE_LABEL, PROJ_META } from '#/components/flow-ultimate/types'

function layerMeta(
  layer: 'app_flow' | 'page_nav',
  code: FlowSemanticLayerMeta['code'] = 'OK',
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
  }
}

function emptyProject(id: string) {
  return {
    project_id: id,
    app_flow: { nodes: [] as never[], edges: [] as never[] },
    page_nav: { nodes: [] as never[], edges: [] as never[] },
  }
}

/**
 * Honest semantic nav for id-copy chrome proofs.
 * - Cross: multi-project app_flow → visible af: journey nodes
 * - web-member: checkout soft-linked to FEAT-CHECKOUT-WEB (API enrichment)
 * - panel-sales: two-node edge for Navigasi terkait neighbor proof
 * - backend: empty journey → inventory-only empty-neighbor path
 * No COL_CAP / premium sequential / inventory edges.
 */
const semanticNav: FlowDataSemanticNav = {
  version: 1,
  source: 'mysql',
  state: 'OK',
  sourceHash: 'id-copy-fixture',
  boardId: 'mfs-rebuild',
  by_project: {
    rn: {
      project_id: 'rn',
      app_flow: {
        nodes: [
          {
            node_id: 'rn_home',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: null,
            label_id: 'Beranda RN',
            kind: 'screen',
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
    'web-member': {
      project_id: 'web-member',
      app_flow: {
        nodes: [
          {
            node_id: 'checkout',
            project_id_storage: 'web',
            project_id: 'web-member',
            feature_id: 'FEAT-CHECKOUT-WEB',
            label_id: 'Checkout web',
            kind: 'screen',
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
    'panel-sales': {
      project_id: 'panel-sales',
      app_flow: {
        nodes: [
          {
            node_id: 'set_paket',
            project_id_storage: 'sales',
            project_id: 'panel-sales',
            feature_id: 'FEAT-HARGA-PAKET',
            label_id: 'Set paket harga',
            kind: 'screen',
            sort_order: 1,
            layout_col: 0,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
          {
            node_id: 'konfirmasi',
            project_id_storage: 'sales',
            project_id: 'panel-sales',
            feature_id: null,
            label_id: 'Konfirmasi paket',
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
            edge_id: 'set_paket->konfirmasi',
            from_node: 'set_paket',
            to_node: 'konfirmasi',
            edge_kind: 'nav',
            edge_class: 'nav',
            sort_order: 1,
            project_id_storage: 'sales',
            project_id: 'panel-sales',
            provenance: 'app_flow_edges',
          },
        ],
      },
      page_nav: { nodes: [], edges: [] },
    },
    affiliate: emptyProject('affiliate'),
    backend: emptyProject('backend'),
  },
  layers: {
    app_flow: layerMeta('app_flow', 'OK'),
    page_nav: layerMeta('page_nav', 'OK'),
  },
}

const fixture: FlowDataBundle = {
  projects: { version: 1, projects: [] },
  premium: {
    name: 'Pembelian Premium',
    steps: [
      {
        n: 1,
        proj: 'sales',
        title: 'Sales set paket FEAT-HARGA-PAKET',
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
    rn: [],
    'web-member': [
      {
        id: 'FEAT-CHECKOUT-WEB',
        nama_id: 'Checkout web',
        ringkasan_id:
          'Ringkasan fitur FEAT-CHECKOUT-WEB tanpa ID mentah di UI',
        status: 'sebagian',
        pct: 88,
        screens: ['/premium', '/login', 'HomeScreen'],
        doc_md: 'Dokumen FC-CHECKOUT-01 dan T-WEB-99 di sales-rebuild',
      },
    ],
    'panel-sales': [
      {
        id: 'FEAT-HARGA-PAKET',
        nama_id: 'Harga paket',
        status: 'terbukti',
        pct: 100,
        screens: [],
      },
    ],
    affiliate: [],
    backend: [
      {
        id: 'FEAT-HARGA-PAKET-BE',
        nama_id: 'Harga paket backend',
        status: 'terbukti',
        pct: 100,
        screens: [],
      },
    ],
  },
  tasks_by_feature: {
    'FEAT-CHECKOUT-WEB': [
      {
        id: 'T-WEB-01',
        judul_id: 'T-WEB-01 Wire checkout',
        verdict: 'MAPPED_100',
      },
    ],
    'FEAT-HARGA-PAKET': [
      {
        id: 'T-SALES-01',
        judul_id: 'T-SALES-01 Set harga MAPPED_100',
        verdict: 'PROD_READY',
      },
    ],
  },
  apis_by_feature: {
    'FEAT-CHECKOUT-WEB': [
      { method: 'POST', path: '/api/checkout/session' },
      { method: 'GET', path: '/api/checkout/status' },
    ],
    // Soft enrichment for panel-sales semantic node set_paket (not graph fiction).
    'FEAT-HARGA-PAKET': [
      { method: 'POST', path: '/api/admin/product-packages' },
    ],
  },
  premium_apis: [
    {
      n: 1,
      method: 'POST',
      path: '/api/admin/product-packages',
      proj: 'sales',
    },
  ],
  nav: semanticNav,
}

/** English chrome phrases that must not surface in owner-visible text. */
const FORBIDDEN_EN = [
  'Cross-project',
  'Cross-Project',
  'Interactive workflow',
  'Workflow modes',
  'Status legend',
  'Workflow canvas',
  'Zoom controls',
  'Zoom in',
  'Zoom out',
  'Fit all',
  'Close detail',
  'Close',
  'Status & progress',
  'Overview',
  'Docs',
  'Screens',
  'Related APIs',
  'Build Tasks',
  'Related features',
  'No screens mapped yet',
  'No APIs registered for this step',
  'No linked tasks',
  'No neighbors in this graph',
  'Drag canvas to pan',
  'drag node to move',
  'click node for detail',
  'Proven',
  'Partial',
  'Missing',
  'Verified',
  'Affiliate',
  'related feature',
  'related task',
  'feature contract',
  'fully proven',
  'production ready',
  'related repo',
  'Flow section',
]

const FORBIDDEN_ID_PATTERNS: RegExp[] = [
  /\bFEAT-[A-Z0-9-]+\b/,
  /\bT-[A-Z0-9-]{4,}\b/,
  /\bFC-[A-Z0-9-]+\b/,
  /\bMAPPED_100\b/,
  /\bPROD_READY\b/,
  /\bMISSING\b/,
  /\bsales-rebuild\b/,
  /\brebuild-backend\b/,
  /\baffiliate-rebuild\b/,
  /\bmfs-web-original-upgrade\b/,
  /\blegacy\/[a-z0-9-]+\b/,
]

function assertNoForbiddenVisible(text: string, allowApi = true) {
  const scan = allowApi
    ? text.replace(
        /\b(GET|POST|PUT|PATCH|DELETE)\s+(\/[A-Za-z0-9._~\-/{}\[\]:*]+)/gi,
        ' ',
      )
    : text
  for (const en of FORBIDDEN_EN) {
    expect(scan, `forbidden EN: ${en}`).not.toContain(en)
  }
  for (const re of FORBIDDEN_ID_PATTERNS) {
    expect(scan, `forbidden ID ${re}`).not.toMatch(re)
  }
  expect(hasVisibleTechIdLeak(text)).toBe(false)
}

afterEach(() => {
  cleanup()
})

describe('canon-flow-id-copy — mode / status labels', () => {
  it('exposes required mode labels', () => {
    expect(MODE_LABEL.cross).toBe('Lintas Proyek')
    expect(MODE_LABEL.rn).toBe('React Native')
    expect(MODE_LABEL['web-member']).toBe('Web Member')
    expect(MODE_LABEL['panel-sales']).toBe('Panel Sales')
    expect(MODE_LABEL.affiliate).toBe('Afiliasi')
    expect(MODE_LABEL.backend).toBe('Backend')
    expect(PROJ_META.affiliate.label).toBe('Afiliasi')
    expect(FLOW_MODES).toEqual([
      'cross',
      'rn',
      'web-member',
      'panel-sales',
      'affiliate',
      'backend',
    ])
  })

  it('status chips never leak enums', () => {
    expect(statusLabel('MAPPED_100')).toBe('Terbukti')
    expect(statusLabel('terbukti')).toBe('Terbukti')
    expect(statusLabel('sebagian')).toBe('Sebagian')
    expect(statusLabel('belum')).toBe('Belum')
    expect(statusLabel('MISSING')).toBe('Belum')
    expect(verdictLabel('MAPPED_100')).toBe('Terbukti')
    expect(verdictLabel('PROD_READY')).toBe('Sebagian')
    expect(verdictLabel('MISSING')).toBe('Belum')
    for (const s of ['Terbukti', 'Sebagian', 'Belum'] as const) {
      expect(hasTechIdLeak(s)).toBe(false)
    }
  })
})

describe('canon-flow-id-copy — scrubTechIds id-ID', () => {
  it('replaces FEAT/T/FC/enums/repo slugs without corrupting API blocks', () => {
    const mixed =
      'Gunakan POST /api/checkout/session untuk FEAT-CHECKOUT-WEB ' +
      'dan T-WEB-01 FC-CHECKOUT-01 MAPPED_100 PROD_READY MISSING sales-rebuild'
    const out = scrubTechIds(mixed)
    expect(out).toContain('POST /api/checkout/session')
    expect(out).toContain('fitur terkait')
    expect(out).toContain('tugas terkait')
    expect(out).toContain('kontrak fitur')
    expect(out).toContain('terbukti penuh')
    expect(out).toContain('siap produksi')
    expect(out).toContain('belum')
    expect(out).toContain('repo terkait')
    expect(out).not.toMatch(/FEAT-|T-WEB|FC-CHECKOUT|MAPPED_100|PROD_READY|\bMISSING\b|sales-rebuild/)
    expect(hasVisibleTechIdLeak(out)).toBe(false)
  })

  it('humanizes screens/paths and task titles', () => {
    expect(humanizeScreen('/login')).toBe('Masuk')
    expect(humanizeScreen('/premium')).toBe('Premium')
    expect(humanizeScreen('HomeScreen')).toMatch(/Beranda|Home|Screen/)
    expect(humanizeTaskTitle('T-WEB-01 Wire checkout')).toMatch(/Wire checkout/)
    expect(hasTechIdLeak(humanizeTaskTitle('T-WEB-01 Wire checkout'))).toBe(
      false,
    )
    expect(formatNodeMeta(2, 88)).toBe('2 layar · 88% terverifikasi')
    expect(humanizeNodeMeta('2 screens · 88%')).toBe(
      '2 layar · 88% terverifikasi',
    )
  })
})

describe('canon-flow-id-copy — rendered chrome', () => {
  it('renders all mode pills and legend in id-ID', () => {
    const { container } = render(
      <FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />,
    )
    for (const m of FLOW_MODES) {
      expect(screen.getByRole('tab', { name: MODE_LABEL[m] })).toBeTruthy()
    }
    const text = container.innerText || container.textContent || ''
    expect(text).toMatch(/Lintas Proyek/)
    expect(text).toMatch(/Afiliasi/)
    expect(text).toMatch(/Terbukti/)
    expect(text).toMatch(/Sebagian/)
    expect(text).toMatch(/Belum/)
    expect(text).toMatch(/Seret kanvas untuk geser/)
    expect(text).toMatch(/Alur kerja interaktif/)
    expect(text).toMatch(/Muat/)
    assertNoForbiddenVisible(text)
  })

  it('regex-scans full rendered innerText for forbidden IDs (API exception)', () => {
    const { container } = render(
      <FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />,
    )

    // Cross has seeded semantic journey nodes (not premium:N fiction).
    const nodes = screen.getAllByTestId('flow-node')
    expect(nodes.length).toBeGreaterThan(0)
    for (const n of nodes) {
      const id = n.getAttribute('data-node-id') || ''
      expect(id).toMatch(/^af:/)
      expect(id).not.toMatch(/^premium:|^auth:|^aff:|^iap:/)
    }

    // Soft feature enrichment on real semantic node (production builder).
    const salesNode = nodes.find(
      (n) => n.getAttribute('data-node-id') === 'af:panel-sales:set_paket',
    )
    expect(salesNode).toBeTruthy()
    fireEvent.pointerDown(salesNode!, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(salesNode!, { button: 0, clientX: 5, clientY: 5 })

    const sheetBody = screen.getByTestId('flow-sheet-body')
    const bodyText = sheetBody.innerText || sheetBody.textContent || ''
    // allowed technical surface — from apis_by_feature soft enrichment only
    expect(bodyText).toMatch(/POST\s+\/api\/admin\/product-packages/)

    const full =
      (container as HTMLElement).innerText || container.textContent || ''
    assertNoForbiddenVisible(full)

    // section headings id-ID — Navigasi terkait (not legacy Fitur terkait)
    expect(within(sheetBody).getByText(/Status & progres/i)).toBeTruthy()
    expect(within(sheetBody).getByText(/^Layar/i)).toBeTruthy()
    expect(within(sheetBody).getByText(/API terkait/i)).toBeTruthy()
    expect(within(sheetBody).getByText(/Tugas bangun/i)).toBeTruthy()
    expect(within(sheetBody).getByText(/Navigasi terkait/i)).toBeTruthy()
    // Semantic neighbor via real app_flow edge (not same-feature masquerade)
    expect(within(sheetBody).getByTestId('flow-related').textContent || '').toMatch(
      /Konfirmasi/,
    )
    // No legacy related-features heading as navigation
    expect(within(sheetBody).queryByText(/^Fitur terkait$/i)).toBeNull()
  })

  it('web-member sheet humanizes screens, scrubs docs/tasks, keeps APIs', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    fireEvent.click(screen.getByRole('tab', { name: /Web Member/i }))
    // Journey card from bundle.nav app_flow (exact-prefixed client id)
    const node = screen
      .getAllByTestId('flow-node')
      .find((n) => n.getAttribute('data-node-id') === 'af:web-member:checkout')
    expect(node).toBeTruthy()
    expect(node!.textContent).toMatch(/layar/)
    expect(node!.textContent).toMatch(/% terverifikasi/)
    fireEvent.pointerDown(node!, { button: 0, clientX: 4, clientY: 4 })
    fireEvent.pointerUp(node!, { button: 0, clientX: 4, clientY: 4 })

    const body = screen.getByTestId('flow-sheet-body')
    const t = body.innerText || body.textContent || ''
    expect(t).toMatch(/Ringkasan/)
    expect(t).toMatch(/Dokumentasi/)
    expect(t).toMatch(/Masuk|Premium|Checkout|Home/)
    expect(t).toMatch(/POST\s+\/api\/checkout\/session/)
    expect(t).toMatch(/GET\s+\/api\/checkout\/status/)
    expect(t).toMatch(/fitur terkait|tugas terkait|kontrak fitur|repo terkait/)
    expect(t).toMatch(/Navigasi terkait/)
    // Same-feature inventory may appear separately (not as navigation)
    const same = within(body).queryByTestId('flow-same-feature')
    if (same) {
      expect(same.textContent || '').toMatch(/Fitur sama/)
      expect(same.textContent || '').toMatch(/bukan navigasi/)
    }
    assertNoForbiddenVisible(t)
  })

  it('empty states are natural id-ID', () => {
    const emptyish: FlowDataBundle = {
      ...fixture,
      features: {
        ...fixture.features,
        backend: [
          {
            id: 'FEAT-EMPTY',
            nama_id: 'Fitur kosong',
            status: 'belum',
            pct: 0,
            screens: [],
          },
        ],
      },
      tasks_by_feature: {},
      apis_by_feature: {},
      // backend still empty journey in nav → inventory-only, no semantic neighbors
    }
    render(<FlowUltimateScreen data={emptyish} boardId="mfs-rebuild" />)
    fireEvent.click(screen.getByRole('tab', { name: /^Backend$/i }))
    const node = screen.getAllByTestId('flow-node')[0]
    expect(node.getAttribute('data-node-id') || '').toMatch(/^inv:/)
    fireEvent.pointerDown(node, { button: 0, clientX: 3, clientY: 3 })
    fireEvent.pointerUp(node, { button: 0, clientX: 3, clientY: 3 })
    const body = screen.getByTestId('flow-sheet-body')
    const t = body.innerText || body.textContent || ''
    expect(t).toMatch(/Belum ada layar yang dipetakan/)
    expect(t).toMatch(/Belum ada API terdaftar untuk langkah ini/)
    expect(t).toMatch(/Belum ada tugas terkait/)
    // Production empty-neighbor copy (Navigasi terkait section)
    expect(t).toMatch(/Belum ada tetangga navigasi di graf ini/)
    expect(t).toMatch(/Navigasi terkait/)
    assertNoForbiddenVisible(t)
  })

  it('close control aria is id-ID', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const nodes = screen.getAllByTestId('flow-node')
    expect(nodes.length).toBeGreaterThan(0)
    fireEvent.pointerDown(nodes[0], { button: 0, clientX: 2, clientY: 2 })
    fireEvent.pointerUp(nodes[0], { button: 0, clientX: 2, clientY: 2 })
    expect(screen.getByTestId('flow-sheet-close').getAttribute('aria-label')).toBe(
      'Tutup',
    )
    expect(screen.getByLabelText('Tutup detail')).toBeTruthy()
  })

  it('graph summary uses Indonesian simpul count (no English node/nodes)', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const summary = screen.getByTestId('flow-graph-summary')
    const text = summary.textContent || ''
    expect(summary.getAttribute('role')).toBe('status')
    expect(summary.getAttribute('aria-live')).toBe('polite')
    expect(text).toMatch(/Mode\s+Lintas Proyek/)
    // Accessible count announcement preserved with id-ID term
    expect(text).toMatch(/\d+\s+simpul\./)
    expect(text).toMatch(/\d+\s+koneksi navigasi\./)
    // Residual English graph-summary pluralization must be gone
    expect(text).not.toMatch(/\bnodes?\b/i)
    expect(text).not.toMatch(/\d+\s+node/i)
  })
})
