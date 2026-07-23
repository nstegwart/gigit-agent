/** @vitest-environment jsdom */
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import {
  EDGE_LINE_WIDTH_PX,
  edgeCanvasBackingSize,
  FlowUltimateScreen,
  worldToViewport,
} from '#/components/flow-ultimate/FlowUltimateScreen'
import {
  hasTechIdLeak,
  hasVisibleTechIdLeak,
} from '#/components/flow-ultimate/humanize'
import { nodeCenter } from '#/components/flow-ultimate/graph'
import type {
  FlowDataBundle,
  FlowDataSemanticNav,
  FlowSemanticLayerMeta,
} from '#/components/flow-ultimate/types'

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

const semanticNav: FlowDataSemanticNav = {
  version: 1,
  source: 'mysql',
  state: 'OK',
  sourceHash: 'screen-fixture',
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
            label_id: 'Masuk aplikasi',
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
            label_id: 'Beranda app',
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
          {
            node_id: 'webhook',
            project_id_storage: 'backend',
            project_id: 'backend',
            feature_id: 'FEAT-CLEENG',
            label_id: 'Webhook proses',
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
            edge_id: 'api_root->webhook',
            from_node: 'api_root',
            to_node: 'webhook',
            edge_kind: 'nav',
            edge_class: 'nav',
            sort_order: 1,
            project_id_storage: 'backend',
            project_id: 'backend',
            provenance: 'app_flow_edges',
          },
        ],
      },
      page_nav: { nodes: [], edges: [] },
    },
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
        title: 'Sales set paket & harga',
        st: 'ok',
        api: 'POST /api/admin/product-packages',
      },
      {
        n: 2,
        proj: 'backend',
        title: 'Webhook proses FEAT-CLEENG',
        st: 'warn',
      },
    ],
  },
  features: {
    rn: [
      {
        id: 'FEAT-AUTH-MEMBER',
        nama_id: 'Masuk anggota',
        ringkasan_id: 'Sesi anggota tanpa FEAT mentah',
        status: 'sebagian',
        pct: 70,
        screens: ['/login'],
      },
    ],
    'web-member': [
      {
        id: 'FEAT-CHECKOUT-WEB',
        nama_id: 'Checkout web',
        ringkasan_id:
          'Checkout premium tanpa menampilkan FEAT-CHECKOUT-WEB mentah',
        status: 'sebagian',
        pct: 88,
        screens: ['/premium', '/checkout'],
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
      {
        id: 'FEAT-CLEENG',
        nama_id: 'Cleeng webhook',
        status: 'sebagian',
        pct: 70,
        screens: [],
      },
    ],
  },
  tasks_by_feature: {
    'FEAT-HARGA-PAKET': [
      {
        id: 'T-SALES-01',
        judul_id: 'T-SALES-01 Set harga',
        verdict: 'MAPPED_100',
      },
    ],
    'FEAT-AUTH-MEMBER': [
      {
        id: 'T-AUTH-01',
        judul_id: 'T-AUTH-01 Wire login',
        verdict: 'MAPPED_100',
      },
    ],
  },
  apis_by_feature: {
    'FEAT-AUTH-MEMBER': [{ method: 'POST', path: '/api/auth/login' }],
  },
  premium_apis: [],
  nav: semanticNav,
}

const fixtureNoNav: FlowDataBundle = {
  ...fixture,
  nav: undefined,
}

/** Known EN chrome leftovers that must not appear as owner-visible strings. */
const FORBIDDEN_EN_CHROME = [
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
  'Status & progress',
  'Overview',
  'Related APIs',
  'Build Tasks',
  'Related features',
  'No screens mapped yet',
  'No APIs registered for this step',
  'No linked tasks',
  'No neighbors in this graph',
  'Drag canvas to pan',
  'Proven',
  'Partial',
  'Missing',
  'Affiliate',
]

async function flushRaf() {
  await act(async () => {
    await new Promise<void>((resolve) => {
      requestAnimationFrame(() => resolve())
    })
  })
}

afterEach(() => {
  cleanup()
})

describe('FlowUltimateScreen', () => {
  it('renders semantic cross journey nodes and opens sheet without navigation', () => {
    const { container } = render(
      <FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />,
    )

    expect(screen.getByTestId('flow-ultimate')).toBeTruthy()
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'cross',
    )
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-layer')).toBe(
      'app_flow',
    )

    const rootText = container.innerText || container.textContent || ''
    expect(rootText).toMatch(/Lintas Proyek/)
    expect(rootText).toMatch(/Terbukti/)
    expect(rootText).toMatch(/Sebagian/)
    expect(rootText).toMatch(/Belum/)
    expect(rootText).toMatch(/Seret kanvas/)
    for (const en of FORBIDDEN_EN_CHROME) {
      expect(rootText).not.toContain(en)
    }
    expect(hasVisibleTechIdLeak(rootText)).toBe(false)

    const nodes = screen.getAllByTestId('flow-node')
    expect(nodes.length).toBeGreaterThan(3)
    // no synthetic premium:N
    for (const n of nodes) {
      const id = n.getAttribute('data-node-id') || ''
      expect(id).toMatch(/^af:/)
      expect(id).not.toMatch(/^premium:/)
    }

    for (const n of nodes) {
      const title = n.querySelector('.ft')?.textContent || ''
      const meta = n.querySelector('.flow-meta')?.textContent || ''
      expect(hasTechIdLeak(title)).toBe(false)
      expect(hasTechIdLeak(meta)).toBe(false)
      expect(meta).not.toMatch(/\bscreens\b/i)
    }

    const first = nodes[0]
    fireEvent.pointerDown(first, { button: 0, clientX: 10, clientY: 10 })
    fireEvent.pointerUp(first, { button: 0, clientX: 10, clientY: 10 })

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')
    expect(sheet.getAttribute('aria-hidden')).toBe('false')

    const body = screen.getByTestId('flow-sheet-body')
    expect(within(body).getByText(/Status/i)).toBeTruthy()
    expect(within(body).getByText(/Status & progres/i)).toBeTruthy()
    expect(hasVisibleTechIdLeak(body.textContent || '')).toBe(false)
    expect(body.textContent || '').not.toMatch(/MAPPED_100|PROD_READY|\bMISSING\b/)
    expect(within(body).getByText(/Navigasi terkait/i)).toBeTruthy()

    expect(container.querySelector('a[href*="/tasks/"]')).toBeNull()
  })

  it('switches mode pills; project shows inventory + journey; layer toggle same route', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)

    const webPill = screen.getByRole('tab', { name: /Web Member/i })
    fireEvent.click(webPill)
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'web-member',
    )
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-layer')).toBe(
      'app_flow',
    )
    const webNodes = screen.getAllByTestId('flow-node')
    // journey checkout + inventory FEAT-CHECKOUT-WEB
    expect(webNodes.length).toBeGreaterThanOrEqual(1)
    expect(webNodes.some((n) => (n.textContent || '').includes('Checkout'))).toBe(
      true,
    )

    // RN with layer toggle
    fireEvent.click(screen.getByRole('tab', { name: /React Native/i }))
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'rn',
    )
    const layerToggle = screen.getByTestId('flow-layer-toggle')
    expect(layerToggle).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Alur aplikasi/i })).toBeTruthy()
    expect(screen.getByRole('tab', { name: /Navigasi laman/i })).toBeTruthy()

    const appNodes = screen.getAllByTestId('flow-node')
    expect(
      appNodes.some((n) => n.getAttribute('data-node-id') === 'af:rn:Login'),
    ).toBe(true)
    // inventory present in project mode
    expect(
      appNodes.some((n) => n.className.includes('is-inventory')),
    ).toBe(true)
    expect(
      appNodes.some((n) => (n.textContent || '').includes('Inventaris')),
    ).toBe(true)

    // Switch layer — no route change (still data-page=alur, mode=rn)
    fireEvent.click(screen.getByRole('tab', { name: /Navigasi laman/i }))
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-layer')).toBe(
      'page_nav',
    )
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'rn',
    )
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-page')).toBe(
      'alur',
    )
    const pageNodes = screen.getAllByTestId('flow-node')
    expect(
      pageNodes.some((n) => n.getAttribute('data-node-id') === 'pn:rn:rn-about'),
    ).toBe(true)
    expect(
      pageNodes.some((n) => n.getAttribute('data-node-id')?.startsWith('af:')),
    ).toBe(false)
  })

  it('semantic-only related; inventory unconnected honesty pin when no nav', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    fireEvent.click(screen.getByRole('tab', { name: /React Native/i }))

    const login = screen
      .getAllByTestId('flow-node')
      .find((n) => n.getAttribute('data-node-id') === 'af:rn:Login')
    expect(login).toBeTruthy()
    fireEvent.pointerDown(login!, { button: 0, clientX: 5, clientY: 5 })
    fireEvent.pointerUp(login!, { button: 0, clientX: 5, clientY: 5 })

    const body = screen.getByTestId('flow-sheet-body')
    expect(within(body).getByText(/Navigasi terkait/i)).toBeTruthy()
    const related = within(body).queryAllByTestId('flow-related')
    expect(related.length).toBe(1)
    expect(related[0].textContent || '').toMatch(/Beranda/)
    // same feature inventory must not masquerade as related nav
    for (const r of related) {
      expect(r.getAttribute('data-goto') || '').not.toMatch(/^inv:/)
    }
  })

  it('honesty pin when semantic source absent; zero journey; inventory only in project', () => {
    render(<FlowUltimateScreen data={fixtureNoNav} boardId="mfs-rebuild" />)
    // cross with no nav → empty canvas
    expect(screen.queryAllByTestId('flow-node')).toHaveLength(0)
    expect(screen.getByTestId('flow-honesty-pin').textContent || '').toMatch(
      /navigasi/i,
    )
    expect(
      hasVisibleTechIdLeak(screen.getByTestId('flow-honesty-pin').textContent || ''),
    ).toBe(false)

    fireEvent.click(screen.getByRole('tab', { name: /Web Member/i }))
    const nodes = screen.getAllByTestId('flow-node')
    expect(nodes.length).toBe(1)
    expect(nodes[0].className).toMatch(/is-inventory/)
    expect(nodes[0].textContent).toMatch(/Checkout web/)
    expect(nodes[0].textContent).toMatch(/Inventaris/)
  })

  it('exposes id-ID aria labels for chrome controls', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    expect(screen.getByRole('tablist', { name: /Mode alur kerja/i })).toBeTruthy()
    expect(screen.getByLabelText(/Legenda status/i)).toBeTruthy()
    expect(screen.getByLabelText(/Kanvas alur kerja/i)).toBeTruthy()
    // R1/R2 id-ID chrome: simpul list + perbesaran (reject residual EN node/zoom)
    const textAlt = screen.getByTestId('flow-graph-text-alt')
    expect(textAlt.getAttribute('aria-label')).toBe('Daftar simpul alur')
    expect(textAlt.getAttribute('aria-label') || '').not.toMatch(/\bnode\b/i)
    expect(textAlt.getAttribute('aria-label') || '').not.toBe('Daftar node alur')
    // Exact label — /Perbesar/i would also match "Kontrol perbesaran"
    const zoomGroup = screen.getByLabelText('Kontrol perbesaran')
    expect(zoomGroup).toBeTruthy()
    expect(zoomGroup.getAttribute('aria-label')).toBe('Kontrol perbesaran')
    expect(zoomGroup.getAttribute('aria-label') || '').not.toMatch(/\bzoom\b/i)
    expect(zoomGroup.getAttribute('aria-label') || '').not.toBe('Kontrol zoom')
    const hint = document.getElementById('flow-hint')
    expect(hint).toBeTruthy()
    const hintText = hint!.textContent || ''
    expect(hintText).toMatch(/seret simpul/i)
    expect(hintText).toMatch(/klik simpul/i)
    expect(hintText).not.toMatch(/\bnode\b/i)
    expect(hintText).not.toMatch(/seret node/i)
    expect(hintText).not.toMatch(/klik node/i)
    expect(screen.getByRole('button', { name: 'Perbesar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Perkecil' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Muat semua' })).toBeTruthy()
    expect(screen.getByLabelText(/Tutup detail/i)).toBeTruthy()
  })
})

describe('FlowUltimateScreen a11y (D-A11Y)', () => {
  it('D-A11Y-01: keyboard focusable nodes open sheet via Enter and Space', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const nodes = screen.getAllByTestId('flow-node')
    const first = nodes[0]
    expect(first.getAttribute('role')).toBe('button')
    expect(first.tabIndex).toBe(0)

    first.focus()
    fireEvent.keyDown(first, { key: 'Enter' })
    await flushRaf()

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')
    expect(sheet.getAttribute('aria-hidden')).toBe('false')

    fireEvent.click(screen.getByTestId('flow-sheet-close'))
    await flushRaf()
    expect(sheet.className).not.toContain('is-open')

    first.focus()
    fireEvent.keyDown(first, { key: ' ' })
    await flushRaf()
    expect(sheet.className).toContain('is-open')
  })

  it('D-A11Y-02: stage Arrow keys pan transform; focus centers node', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const stage = screen.getByTestId('flow-stage')
    const world = screen.getByTestId('flow-world')

    const parseTx = () => {
      const t = world.getAttribute('style') || world.style.transform || ''
      const m = t.match(/translate\(([-\d.]+)px,\s*([-\d.]+)px\)/)
      return m
        ? { x: Number(m[1]), y: Number(m[2]) }
        : { x: 0, y: 0 }
    }

    const before = parseTx()
    stage.focus()
    fireEvent.keyDown(stage, { key: 'ArrowRight' })
    await flushRaf()
    const afterRight = parseTx()
    expect(afterRight.x).toBeLessThan(before.x)

    fireEvent.keyDown(stage, { key: 'ArrowDown' })
    await flushRaf()
    const afterDown = parseTx()
    expect(afterDown.y).toBeLessThan(afterRight.y)

    const node = screen.getAllByTestId('flow-node')[0]
    expect(() => fireEvent.focus(node)).not.toThrow()
    await flushRaf()
    expect(node.getAttribute('role')).toBe('button')
  })

  it('D-A11Y-03: tablist Arrow/Home/End + roving tabindex', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const root = screen.getByTestId('flow-ultimate')
    const cross = screen.getByRole('tab', { name: /Lintas Proyek/i })
    const rn = screen.getByRole('tab', { name: /React Native/i })

    expect(cross.tabIndex).toBe(0)
    expect(rn.tabIndex).toBe(-1)
    expect(cross.getAttribute('aria-controls')).toBe('flow-stage')

    cross.focus()
    fireEvent.keyDown(cross, { key: 'ArrowRight' })
    await flushRaf()
    expect(root.getAttribute('data-mode')).toBe('rn')
    expect(rn.tabIndex).toBe(0)
    expect(cross.tabIndex).toBe(-1)

    fireEvent.keyDown(rn, { key: 'Home' })
    await flushRaf()
    expect(root.getAttribute('data-mode')).toBe('cross')
    expect(cross.tabIndex).toBe(0)

    fireEvent.keyDown(cross, { key: 'End' })
    await flushRaf()
    expect(root.getAttribute('data-mode')).toBe('backend')
    const backend = screen.getByRole('tab', { name: /Backend/i })
    expect(backend.tabIndex).toBe(0)
  })

  it('D-A11Y-03b: layer tablist Arrow/Home/End wrap + rebuild; hidden in cross', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const root = screen.getByTestId('flow-ultimate')

    // Cross: layer tabs must not exist (no hidden-focus target).
    expect(screen.queryByTestId('flow-layer-toggle')).toBeNull()
    expect(screen.queryByRole('tab', { name: /Alur aplikasi/i })).toBeNull()
    expect(screen.queryByRole('tab', { name: /Navigasi laman/i })).toBeNull()
    expect(root.getAttribute('data-layer')).toBe('app_flow')
    expect(root.getAttribute('data-page')).toBe('alur')

    // Enter project mode — layer tablist appears with roving tabindex.
    fireEvent.click(screen.getByRole('tab', { name: /React Native/i }))
    await flushRaf()
    expect(root.getAttribute('data-mode')).toBe('rn')
    expect(root.getAttribute('data-layer')).toBe('app_flow')
    expect(root.getAttribute('data-page')).toBe('alur')

    const layerList = screen.getByRole('tablist', { name: /Lapisan navigasi/i })
    expect(layerList.getAttribute('data-testid')).toBe('flow-layer-toggle')
    const appFlowTab = screen.getByRole('tab', { name: /Alur aplikasi/i })
    const pageNavTab = screen.getByRole('tab', { name: /Navigasi laman/i })
    expect(appFlowTab.getAttribute('aria-selected')).toBe('true')
    expect(pageNavTab.getAttribute('aria-selected')).toBe('false')
    expect(appFlowTab.tabIndex).toBe(0)
    expect(pageNavTab.tabIndex).toBe(-1)

    // Semantic app_flow nodes present before switch
    expect(
      screen
        .getAllByTestId('flow-node')
        .some((n) => n.getAttribute('data-node-id') === 'af:rn:Login'),
    ).toBe(true)

    // ArrowRight → page_nav; no route reload
    appFlowTab.focus()
    fireEvent.keyDown(appFlowTab, { key: 'ArrowRight' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('page_nav')
    expect(root.getAttribute('data-mode')).toBe('rn')
    expect(root.getAttribute('data-page')).toBe('alur')
    expect(pageNavTab.getAttribute('aria-selected')).toBe('true')
    expect(appFlowTab.getAttribute('aria-selected')).toBe('false')
    expect(pageNavTab.tabIndex).toBe(0)
    expect(appFlowTab.tabIndex).toBe(-1)
    // Semantic rebuild: page_nav nodes, no leftover af: journey
    expect(
      screen
        .getAllByTestId('flow-node')
        .some((n) => n.getAttribute('data-node-id') === 'pn:rn:rn-about'),
    ).toBe(true)
    expect(
      screen
        .getAllByTestId('flow-node')
        .some((n) => n.getAttribute('data-node-id')?.startsWith('af:')),
    ).toBe(false)

    // ArrowLeft wrap back to app_flow
    fireEvent.keyDown(pageNavTab, { key: 'ArrowLeft' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('app_flow')
    expect(appFlowTab.tabIndex).toBe(0)
    expect(
      screen
        .getAllByTestId('flow-node')
        .some((n) => n.getAttribute('data-node-id') === 'af:rn:Login'),
    ).toBe(true)

    // ArrowDown → page_nav; ArrowUp → app_flow
    fireEvent.keyDown(appFlowTab, { key: 'ArrowDown' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('page_nav')
    fireEvent.keyDown(pageNavTab, { key: 'ArrowUp' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('app_flow')

    // End → last layer; Home → first; wrap ArrowRight from End
    fireEvent.keyDown(appFlowTab, { key: 'End' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('page_nav')
    expect(pageNavTab.tabIndex).toBe(0)
    fireEvent.keyDown(pageNavTab, { key: 'ArrowRight' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('app_flow')
    expect(appFlowTab.tabIndex).toBe(0)
    fireEvent.keyDown(appFlowTab, { key: 'Home' })
    await flushRaf()
    expect(root.getAttribute('data-layer')).toBe('app_flow')
    expect(appFlowTab.getAttribute('aria-selected')).toBe('true')
    // Still in-place Alur — no route
    expect(root.getAttribute('data-page')).toBe('alur')
    expect(root.getAttribute('data-mode')).toBe('rn')
  })

  it('D-A11Y-04: initial focus, Tab trap, Escape return, closed non-tabbable', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const first = screen.getAllByTestId('flow-node')[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'Enter' })
    await flushRaf()

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')
    expect(sheet.getAttribute('role')).toBe('dialog')
    expect(sheet.getAttribute('aria-modal')).toBe('true')

    await waitFor(() => {
      expect(document.activeElement).toBe(
        screen.getByTestId('flow-sheet-close'),
      )
    })

    const closeBtn = screen.getByTestId('flow-sheet-close')
    closeBtn.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      )
    })
    expect(sheet.contains(document.activeElement as Node)).toBe(true)

    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await flushRaf()
    expect(sheet.className).not.toContain('is-open')
    expect(sheet.getAttribute('aria-hidden')).toBe('true')
    expect(sheet.getAttribute('role')).toBeNull()
    expect(sheet.getAttribute('aria-modal')).toBeNull()

    await waitFor(() => {
      expect(document.activeElement).toBe(first)
    })

    expect(closeBtn.tabIndex).toBe(-1)
  })

  it('D-A11Y-04 repair: pointer mode switch while sheet open closes + focuses initiator', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const first = screen.getAllByTestId('flow-node')[0]
    const firstId = first.getAttribute('data-node-id')
    first.focus()
    fireEvent.keyDown(first, { key: 'Enter' })
    await flushRaf()

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByTestId('flow-sheet-close'))
    })

    const webMember = screen.getByRole('tab', { name: /Web Member/i })
    fireEvent.click(webMember)
    await flushRaf()
    await flushRaf()

    expect(sheet.className).not.toContain('is-open')
    expect(sheet.getAttribute('aria-hidden')).toBe('true')
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'web-member',
    )

    await waitFor(() => {
      expect(document.activeElement).toBe(webMember)
    })
    expect(document.activeElement?.getAttribute('role')).toBe('tab')

    if (firstId) {
      expect(
        document.activeElement?.getAttribute('data-node-id') === firstId,
      ).toBe(false)
    }

    const nodeAfter = screen.getAllByTestId('flow-node')[0]
    nodeAfter.focus()
    fireEvent.keyDown(nodeAfter, { key: 'Enter' })
    await flushRaf()
    expect(sheet.className).toContain('is-open')
    await act(async () => {
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }),
      )
    })
    await flushRaf()
    await waitFor(() => {
      expect(document.activeElement).toBe(nodeAfter)
    })
    expect(sheet.className).not.toContain('is-open')
  })

  it('D-A11Y-04 repair: keyboard mode switch while sheet open closes + focuses intended tab', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const first = screen.getAllByTestId('flow-node')[0]
    first.focus()
    fireEvent.keyDown(first, { key: 'Enter' })
    await flushRaf()

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')

    const cross = screen.getByRole('tab', { name: /Lintas Proyek/i })
    const rn = screen.getByRole('tab', { name: /React Native/i })
    cross.focus()
    fireEvent.keyDown(cross, { key: 'ArrowRight' })
    await flushRaf()
    await flushRaf()

    expect(sheet.className).not.toContain('is-open')
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'rn',
    )
    await waitFor(() => {
      expect(document.activeElement).toBe(rn)
    })
    expect(
      document.activeElement === document.body ||
        document.activeElement == null,
    ).toBe(false)
  })

  it('D-A11Y-04 repair: brand reset while sheet open closes + focuses brand', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    fireEvent.click(screen.getByRole('tab', { name: /Web Member/i }))
    await flushRaf()

    const node = screen.getAllByTestId('flow-node')[0]
    node.focus()
    fireEvent.keyDown(node, { key: 'Enter' })
    await flushRaf()

    const sheet = screen.getByTestId('flow-sheet')
    expect(sheet.className).toContain('is-open')

    const brand = screen.getByTestId('flow-brand')
    fireEvent.click(brand)
    await flushRaf()
    await flushRaf()

    expect(sheet.className).not.toContain('is-open')
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'cross',
    )
    await waitFor(() => {
      expect(document.activeElement).toBe(brand)
    })

    const crossNode = screen.getAllByTestId('flow-node')[0]
    crossNode.focus()
    fireEvent.keyDown(crossNode, { key: 'Enter' })
    await flushRaf()
    expect(sheet.className).toContain('is-open')
    fireEvent.click(brand)
    await flushRaf()
    await flushRaf()
    expect(sheet.className).not.toContain('is-open')
    await waitFor(() => {
      expect(document.activeElement).toBe(brand)
    })
  })

  it('D-A11Y-05: node accessible name includes status label', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const nodes = screen.getAllByTestId('flow-node')
    expect(nodes.length).toBeGreaterThan(0)
    for (const n of nodes) {
      const name = n.getAttribute('aria-label') || ''
      expect(name).toMatch(/Terbukti|Sebagian|Belum/)
      expect(name.length).toBeGreaterThan(3)
    }
  })

  it('D-A11Y-09: SR graph summary present and updates on mode switch', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const summary = screen.getByTestId('flow-graph-summary')
    expect(summary.getAttribute('role')).toBe('status')
    expect(summary.getAttribute('aria-live')).toBe('polite')
    expect(summary.textContent || '').toMatch(/Lintas Proyek/)
    expect(summary.textContent || '').toMatch(/\d+\s+simpul/)
    expect(summary.textContent || '').not.toMatch(/\bnodes?\b/i)

    const textAlt = screen.getByTestId('flow-graph-text-alt')
    expect(textAlt.querySelectorAll('li').length).toBeGreaterThan(0)
    expect(textAlt.getAttribute('aria-label')).toBe('Daftar simpul alur')
    expect(textAlt.getAttribute('aria-label') || '').not.toMatch(/\bnode\b/i)

    fireEvent.click(screen.getByRole('tab', { name: /Web Member/i }))
    await flushRaf()
    expect(summary.textContent || '').toMatch(/Web Member/)
    expect(summary.textContent || '').toMatch(/\d+\s+simpul/)
    expect(summary.textContent || '').not.toMatch(/\bnodes?\b/i)
  })

  it('D-A11Y-12/13: zoom aria-labels and document h1 not inside button', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    const zoomGroup = document.querySelector('.flow-zoom')
    expect(zoomGroup?.getAttribute('aria-label')).toBe('Kontrol perbesaran')
    expect(zoomGroup?.getAttribute('aria-label') || '').not.toMatch(/\bzoom\b/i)
    expect(screen.getByRole('button', { name: 'Perbesar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Perkecil' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Muat semua' })).toBeTruthy()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent || '').toMatch(/Alur/i)
    expect(headings[0].closest('button')).toBeNull()
    expect(screen.getByTestId('flow-brand').tagName).toBe('BUTTON')
    expect(screen.getByTestId('flow-brand').getAttribute('aria-label')).toMatch(
      /Alur/i,
    )
  })
})

// ---------------------------------------------------------------------------
// Viewport-sized edge canvas (B-FUNC-OOM repair) — stage × DPR, never world
// Authority: a309 / v306. Live layout extremes ~28880×19284 (~2.07 GiB @ DPR1).
// ---------------------------------------------------------------------------

/** Live staging extremes (investigation a309): world CSS 28880×19284. */
const GIANT_WORLD_W = 28880
const GIANT_WORLD_H = 19284
const STAGE_W = 1440
const STAGE_H = 839
/** Hard cap: never allow multi-GiB product allocation in unit proofs. */
const MAX_BACKING_BYTES = 64 * 1024 * 1024 // 64 MiB

/**
 * layout_col 105 / layout_row 191 → x=28600 y=19140 (rn baseY=40) →
 * worldSize w=28880 h=19284 matching live OOM bitmap.
 */
const giantLayoutNav: FlowDataSemanticNav = {
  version: 1,
  source: 'mysql',
  state: 'OK',
  sourceHash: 'viewport-oom-fixture',
  boardId: 'mfs-rebuild',
  by_project: {
    rn: {
      project_id: 'rn',
      app_flow: {
        nodes: [
          {
            node_id: 'origin',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: null,
            label_id: 'Asal raksasa',
            kind: 'screen',
            sort_order: 1,
            layout_col: 0,
            layout_row: 0,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
          {
            node_id: 'far',
            project_id_storage: 'rn',
            project_id: 'rn',
            feature_id: null,
            label_id: 'Ujung raksasa',
            kind: 'screen',
            sort_order: 2,
            layout_col: 105,
            layout_row: 191,
            source_ref: null,
            provenance: 'app_flow_nodes',
          },
        ],
        edges: [
          {
            edge_id: 'origin->far',
            from_node: 'origin',
            to_node: 'far',
            edge_kind: 'nav',
            edge_class: 'nav',
            sort_order: 1,
            project_id_storage: 'rn',
            project_id: 'rn',
            provenance: 'app_flow_edges',
          },
        ],
      },
      page_nav: { nodes: [], edges: [] },
    },
    'web-member': emptyProject('web-member'),
    'panel-sales': emptyProject('panel-sales'),
    affiliate: emptyProject('affiliate'),
    backend: emptyProject('backend'),
  },
  layers: {
    app_flow: layerMeta('app_flow', 'OK'),
    page_nav: layerMeta('page_nav', 'OK'),
  },
}

const giantFixture: FlowDataBundle = {
  ...fixture,
  nav: giantLayoutNav,
  features: { rn: [], 'web-member': [], 'panel-sales': [], affiliate: [], backend: [] },
  tasks_by_feature: {},
  apis_by_feature: {},
}

type CanvasStrokeLog = {
  moveTo: Array<[number, number]>
  bezier: Array<[number, number, number, number, number, number]>
  lineWidths: number[]
  clearRects: Array<[number, number, number, number]>
}

function installRecordingCanvasContext(): {
  log: CanvasStrokeLog
  restore: () => void
} {
  const log: CanvasStrokeLog = {
    moveTo: [],
    bezier: [],
    lineWidths: [],
    clearRects: [],
  }
  const prev = HTMLCanvasElement.prototype.getContext
  // jsdom has no real 2d context; record calls from product draw path.
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  HTMLCanvasElement.prototype.getContext = function getContextMock(
    this: HTMLCanvasElement,
    type: string,
  ): any {
    if (type !== '2d') return null
    const ctx: Record<string, unknown> = {
      strokeStyle: '',
      lineCap: '',
      setTransform() {},
      clearRect(x: number, y: number, w: number, h: number) {
        log.clearRects.push([x, y, w, h])
      },
      beginPath() {},
      moveTo(x: number, y: number) {
        log.moveTo.push([x, y])
      },
      bezierCurveTo(
        cp1x: number,
        cp1y: number,
        cp2x: number,
        cp2y: number,
        x: number,
        y: number,
      ) {
        log.bezier.push([cp1x, cp1y, cp2x, cp2y, x, y])
      },
      stroke() {},
    }
    Object.defineProperty(ctx, 'lineWidth', {
      configurable: true,
      enumerable: true,
      get() {
        return (ctx as { _lw?: number })._lw ?? 1
      },
      set(v: number) {
        ;(ctx as { _lw?: number })._lw = v
        log.lineWidths.push(v)
      },
    })
    return ctx
  }
  return {
    log,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = prev
    },
  }
}

function mockStageClientSize(w: number, h: number): () => void {
  const prevW = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientWidth')
  const prevH = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'clientHeight')
  Object.defineProperty(HTMLElement.prototype, 'clientWidth', {
    configurable: true,
    get(this: HTMLElement) {
      if (
        this.getAttribute?.('data-testid') === 'flow-stage' ||
        this.id === 'flow-stage' ||
        this.classList?.contains('flow-stage')
      ) {
        return w
      }
      return 0
    },
  })
  Object.defineProperty(HTMLElement.prototype, 'clientHeight', {
    configurable: true,
    get(this: HTMLElement) {
      if (
        this.getAttribute?.('data-testid') === 'flow-stage' ||
        this.id === 'flow-stage' ||
        this.classList?.contains('flow-stage')
      ) {
        return h
      }
      return 0
    },
  })
  return () => {
    if (prevW) Object.defineProperty(HTMLElement.prototype, 'clientWidth', prevW)
    else delete (HTMLElement.prototype as { clientWidth?: unknown }).clientWidth
    if (prevH) Object.defineProperty(HTMLElement.prototype, 'clientHeight', prevH)
    else delete (HTMLElement.prototype as { clientHeight?: unknown }).clientHeight
  }
}

function mockDevicePixelRatio(dpr: number): () => void {
  const prev = Object.getOwnPropertyDescriptor(window, 'devicePixelRatio')
  Object.defineProperty(window, 'devicePixelRatio', {
    configurable: true,
    get: () => dpr,
  })
  return () => {
    if (prev) Object.defineProperty(window, 'devicePixelRatio', prev)
    else delete (window as { devicePixelRatio?: number }).devicePixelRatio
  }
}

describe('edgeCanvasBackingSize / worldToViewport pure helpers', () => {
  it('binds backing pixels to stage × DPR never world (DPR1 and DPR2)', () => {
    for (const dpr of [1, 2] as const) {
      const b = edgeCanvasBackingSize(STAGE_W, STAGE_H, dpr)
      expect(b.cssW).toBe(STAGE_W)
      expect(b.cssH).toBe(STAGE_H)
      expect(b.bufW).toBe(Math.ceil(STAGE_W * dpr))
      expect(b.bufH).toBe(Math.ceil(STAGE_H * dpr))
      // Explicitly not world-sized
      expect(b.bufW).toBeLessThan(GIANT_WORLD_W)
      expect(b.bufH).toBeLessThan(GIANT_WORLD_H)
      const bytes = b.bufW * b.bufH * 4
      expect(bytes).toBeLessThan(MAX_BACKING_BYTES)
      // Old path would be ~2.07 GiB @ DPR1 / ~8.3 GiB @ DPR2
      const oldBytes = GIANT_WORLD_W * GIANT_WORLD_H * dpr * dpr * 4
      expect(oldBytes).toBeGreaterThan(2 * 1024 * 1024 * 1024)
      expect(bytes).toBeLessThan(oldBytes / 100)
    }
  })

  it('maps world anchors through pan+zoom into viewport coords', () => {
    const t = { x: -100, y: 50, scale: 0.5 }
    expect(worldToViewport(200, 400, t)).toEqual({ x: 0, y: 250 })
    expect(worldToViewport(0, 0, { x: 80, y: 60, scale: 1 })).toEqual({
      x: 80,
      y: 60,
    })
  })

  it('exports constant screen-space edge width 1.5', () => {
    expect(EDGE_LINE_WIDTH_PX).toBe(1.5)
  })
})

describe('FlowUltimateScreen viewport edge canvas (OOM repair)', () => {
  it('large 28880×19284 layout: canvas = stage×DPR; world keeps layout bounds', async () => {
    const restoreStage = mockStageClientSize(STAGE_W, STAGE_H)
    const restoreDpr = mockDevicePixelRatio(1)
    const { log, restore: restoreCtx } = installRecordingCanvasContext()
    try {
      render(<FlowUltimateScreen data={giantFixture} boardId="mfs-rebuild" />)
      await flushRaf()
      await flushRaf()

      const world = screen.getByTestId('flow-world')
      const canvas = screen.getByTestId('flow-edges') as HTMLCanvasElement
      const stage = screen.getByTestId('flow-stage')

      // Fit / layout still uses world node extents
      expect(world.style.width).toBe(`${GIANT_WORLD_W}px`)
      expect(world.style.height).toBe(`${GIANT_WORLD_H}px`)

      // Backing store bound to stage, never world
      expect(canvas.width).toBe(STAGE_W) // DPR1
      expect(canvas.height).toBe(STAGE_H)
      expect(canvas.style.width).toBe(`${STAGE_W}px`)
      expect(canvas.style.height).toBe(`${STAGE_H}px`)
      expect(canvas.width).not.toBe(GIANT_WORLD_W)
      expect(canvas.height).not.toBe(GIANT_WORLD_H)

      const bytes = canvas.width * canvas.height * 4
      expect(bytes).toBe(STAGE_W * STAGE_H * 4)
      expect(bytes).toBeLessThan(MAX_BACKING_BYTES)
      expect(bytes).toBeLessThan(50 * 1024 * 1024)

      // Canvas is stage child (not inside scaled world)
      expect(canvas.parentElement).toBe(stage)
      expect(world.contains(canvas)).toBe(false)

      // Screen-space line width preserved
      expect(log.lineWidths.length).toBeGreaterThan(0)
      expect(log.lineWidths.every((w) => w === EDGE_LINE_WIDTH_PX)).toBe(true)
      expect(EDGE_LINE_WIDTH_PX).toBe(1.5)

      // One semantic edge drawn with transformed anchors
      expect(log.moveTo.length).toBeGreaterThanOrEqual(1)
      expect(log.bezier.length).toBeGreaterThanOrEqual(1)

      // pointer-events:none is in flow-ultimate.css (.flow-edges); class present
      expect(canvas.className).toContain('flow-edges')
      expect(canvas.getAttribute('aria-hidden')).toBe('true')
    } finally {
      restoreCtx()
      restoreDpr()
      restoreStage()
    }
  })

  it('DPR2: backing is stage×2, still far below world multi-GiB', async () => {
    const restoreStage = mockStageClientSize(STAGE_W, STAGE_H)
    const restoreDpr = mockDevicePixelRatio(2)
    const { log, restore: restoreCtx } = installRecordingCanvasContext()
    try {
      render(<FlowUltimateScreen data={giantFixture} boardId="mfs-rebuild" />)
      await flushRaf()
      await flushRaf()

      const canvas = screen.getByTestId('flow-edges') as HTMLCanvasElement
      const expected = edgeCanvasBackingSize(STAGE_W, STAGE_H, 2)
      expect(canvas.width).toBe(expected.bufW)
      expect(canvas.height).toBe(expected.bufH)
      expect(canvas.style.width).toBe(`${STAGE_W}px`)
      expect(canvas.style.height).toBe(`${STAGE_H}px`)
      const bytes = canvas.width * canvas.height * 4
      expect(bytes).toBe(STAGE_W * 2 * STAGE_H * 2 * 4)
      expect(bytes).toBeLessThan(MAX_BACKING_BYTES)
      // Old world×DPR2 path ~8.3 GiB
      expect(GIANT_WORLD_W * GIANT_WORLD_H * 4 * 4).toBeGreaterThan(
        8 * 1024 * 1024 * 1024,
      )
      expect(log.lineWidths.every((w) => w === 1.5)).toBe(true)
    } finally {
      restoreCtx()
      restoreDpr()
      restoreStage()
    }
  })

  it('draws edges in viewport coords via pan+zoom transform of world anchors', async () => {
    const restoreStage = mockStageClientSize(STAGE_W, STAGE_H)
    const restoreDpr = mockDevicePixelRatio(1)
    const { log, restore: restoreCtx } = installRecordingCanvasContext()
    try {
      render(<FlowUltimateScreen data={giantFixture} boardId="mfs-rebuild" />)
      await flushRaf()
      await flushRaf()

      const world = screen.getByTestId('flow-world')
      // Parse CSS transform translate(tx) scale(s) from fit
      const tf = world.style.transform || ''
      const m = tf.match(
        /translate\(([-\d.]+)px,\s*([-\d.]+)px\)\s*scale\(([-\d.]+)\)/,
      )
      expect(m).toBeTruthy()
      const tx = Number(m![1])
      const ty = Number(m![2])
      const scale = Number(m![3])
      expect(scale).toBeGreaterThan(0)
      // Fit clamps scale floor 0.35 for giant world
      expect(scale).toBeLessThanOrEqual(1.25)

      const originEl = screen
        .getAllByTestId('flow-node')
        .find((n) => n.getAttribute('data-node-id') === 'af:rn:origin')
      const farEl = screen
        .getAllByTestId('flow-node')
        .find((n) => n.getAttribute('data-node-id') === 'af:rn:far')
      expect(originEl && farEl).toBeTruthy()

      const originNode = {
        id: 'af:rn:origin',
        x: Number.parseFloat(originEl!.style.left || '0'),
        y: Number.parseFloat(originEl!.style.top || '0'),
        title: '',
        meta: '',
        status: 'sebagian',
      }
      const farNode = {
        id: 'af:rn:far',
        x: Number.parseFloat(farEl!.style.left || '0'),
        y: Number.parseFloat(farEl!.style.top || '0'),
        title: '',
        meta: '',
        status: 'sebagian',
      }
      expect(originNode.x).toBe(40)
      expect(farNode.x).toBe(28600)
      expect(farNode.y).toBe(19140)

      const p0 = nodeCenter(originNode as never)
      const p1 = nodeCenter(farNode as never)
      const v0 = worldToViewport(p0.x, p0.y, { x: tx, y: ty, scale })
      const v1 = worldToViewport(p1.x, p1.y, { x: tx, y: ty, scale })

      // Use last stroke after fitTransform rAF (earlier draws use default pan/zoom)
      expect(log.moveTo.length).toBeGreaterThan(0)
      expect(log.bezier.length).toBeGreaterThan(0)
      const lastMove = log.moveTo[log.moveTo.length - 1]
      const bez = log.bezier[log.bezier.length - 1]
      expect(lastMove[0]).toBeCloseTo(v0.x, 4)
      expect(lastMove[1]).toBeCloseTo(v0.y, 4)
      expect(bez[4]).toBeCloseTo(v1.x, 4)
      expect(bez[5]).toBeCloseTo(v1.y, 4)
      // Control points use viewport-space dx
      const dx = Math.abs(v1.x - v0.x) * 0.45
      expect(bez[0]).toBeCloseTo(v0.x + dx, 4)
      expect(bez[2]).toBeCloseTo(v1.x - dx, 4)
    } finally {
      restoreCtx()
      restoreDpr()
      restoreStage()
    }
  })

  it('redraws on zoom (interaction dep) while staying stage-sized', async () => {
    const restoreStage = mockStageClientSize(STAGE_W, STAGE_H)
    const restoreDpr = mockDevicePixelRatio(1)
    const { log, restore: restoreCtx } = installRecordingCanvasContext()
    try {
      render(<FlowUltimateScreen data={giantFixture} boardId="mfs-rebuild" />)
      await flushRaf()
      await flushRaf()

      const strokesBefore = log.moveTo.length
      expect(strokesBefore).toBeGreaterThan(0)

      fireEvent.click(screen.getByRole('button', { name: 'Perbesar' }))
      await flushRaf()

      const canvas = screen.getByTestId('flow-edges') as HTMLCanvasElement
      expect(canvas.width).toBe(STAGE_W)
      expect(canvas.height).toBe(STAGE_H)
      // Zoom changed transform → another draw pass
      expect(log.moveTo.length).toBeGreaterThan(strokesBefore)
      expect(log.lineWidths[log.lineWidths.length - 1]).toBe(1.5)
    } finally {
      restoreCtx()
      restoreDpr()
      restoreStage()
    }
  })

  it('fit (Muat) still uses world bounds; canvas remains stage-sized', async () => {
    const restoreStage = mockStageClientSize(STAGE_W, STAGE_H)
    const restoreDpr = mockDevicePixelRatio(1)
    const { restore: restoreCtx } = installRecordingCanvasContext()
    try {
      render(<FlowUltimateScreen data={giantFixture} boardId="mfs-rebuild" />)
      await flushRaf()
      await flushRaf()

      // Zoom in first so fit must recompute from world extents
      fireEvent.click(screen.getByRole('button', { name: 'Perbesar' }))
      fireEvent.click(screen.getByRole('button', { name: 'Perbesar' }))
      await flushRaf()

      fireEvent.click(screen.getByRole('button', { name: 'Muat semua' }))
      await flushRaf()

      const world = screen.getByTestId('flow-world')
      const canvas = screen.getByTestId('flow-edges') as HTMLCanvasElement
      expect(world.style.width).toBe(`${GIANT_WORLD_W}px`)
      expect(world.style.height).toBe(`${GIANT_WORLD_H}px`)
      expect(canvas.width).toBe(STAGE_W)
      expect(canvas.height).toBe(STAGE_H)

      const tf = world.style.transform || ''
      const m = tf.match(/scale\(([-\d.]+)\)/)
      expect(m).toBeTruthy()
      // Fit floor for giant graph
      expect(Number(m![1])).toBeGreaterThanOrEqual(0.35)
      expect(Number(m![1])).toBeLessThanOrEqual(1.25)
    } finally {
      restoreCtx()
      restoreDpr()
      restoreStage()
    }
  })
})
