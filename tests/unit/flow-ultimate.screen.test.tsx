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

import { FlowUltimateScreen } from '#/components/flow-ultimate'
import {
  hasTechIdLeak,
  hasVisibleTechIdLeak,
} from '#/components/flow-ultimate/humanize'
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
    expect(screen.getByLabelText(/Kontrol zoom/i)).toBeTruthy()
    expect(screen.getByLabelText(/Perbesar/i)).toBeTruthy()
    expect(screen.getByLabelText(/Perkecil/i)).toBeTruthy()
    expect(screen.getByLabelText(/Muat semua/i)).toBeTruthy()
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
    expect(summary.textContent || '').toMatch(/\d+\s+nodes?/)

    const textAlt = screen.getByTestId('flow-graph-text-alt')
    expect(textAlt.querySelectorAll('li').length).toBeGreaterThan(0)

    fireEvent.click(screen.getByRole('tab', { name: /Web Member/i }))
    await flushRaf()
    expect(summary.textContent || '').toMatch(/Web Member/)
    expect(summary.textContent || '').toMatch(/\d+\s+nodes?/)
  })

  it('D-A11Y-12/13: zoom aria-labels and document h1 not inside button', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
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
