/** @vitest-environment jsdom */
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, describe, expect, it } from 'vitest'

import { FlowUltimateScreen } from '#/components/flow-ultimate'
import {
  hasTechIdLeak,
  hasVisibleTechIdLeak,
} from '#/components/flow-ultimate/humanize'
import type { FlowDataBundle } from '#/components/flow-ultimate/types'

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
    rn: [],
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
  },
  apis_by_feature: {},
  premium_apis: [],
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

afterEach(() => {
  cleanup()
})

describe('FlowUltimateScreen', () => {
  it('renders cross-project nodes and opens slide-up without navigation', () => {
    const { container } = render(
      <FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />,
    )

    expect(screen.getByTestId('flow-ultimate')).toBeTruthy()
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'cross',
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

    // human-readable: no technical IDs in node titles / meta
    for (const n of nodes) {
      const title = n.querySelector('.ft')?.textContent || ''
      const meta = n.querySelector('.flow-meta')?.textContent || ''
      expect(hasTechIdLeak(title)).toBe(false)
      expect(hasTechIdLeak(meta)).toBe(false)
      expect(meta).not.toMatch(/\bscreens\b/i)
      if (meta.includes('%')) {
        expect(meta).toMatch(/terverifikasi/)
      }
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
    // scrubbed content — no FEAT/T/enums in visible sheet text
    expect(hasVisibleTechIdLeak(body.textContent || '')).toBe(false)
    expect(body.textContent || '').not.toMatch(/MAPPED_100|PROD_READY|\bMISSING\b/)

    // URL is not a browser concern here — assert we did not add links that navigate away
    expect(container.querySelector('a[href*="/tasks/"]')).toBeNull()
  })

  it('switches mode pills and related buttons re-open sheet', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)

    const webPill = screen.getByRole('tab', { name: /Web Member/i })
    fireEvent.click(webPill)
    expect(screen.getByTestId('flow-ultimate').getAttribute('data-mode')).toBe(
      'web-member',
    )
    const webNodes = screen.getAllByTestId('flow-node')
    expect(webNodes.length).toBe(1)
    expect(webNodes[0].textContent).toMatch(/Checkout web/)
    expect(webNodes[0].textContent).toMatch(/layar/)
    expect(webNodes[0].textContent).toMatch(/terverifikasi/)
  })

  it('exposes id-ID aria labels for chrome controls', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    expect(screen.getByRole('tablist', { name: /Mode alur kerja/i })).toBeTruthy()
    expect(screen.getByLabelText(/Legenda status/i)).toBeTruthy()
    expect(screen.getByLabelText(/Kanvas alur kerja/i)).toBeTruthy()
    expect(screen.getByLabelText(/Kontrol zoom/i)).toBeTruthy()
    expect(screen.getByTitle(/Perbesar/i)).toBeTruthy()
    expect(screen.getByTitle(/Perkecil/i)).toBeTruthy()
    expect(screen.getByTitle(/Muat semua/i)).toBeTruthy()
    expect(screen.getByLabelText(/Tutup detail/i)).toBeTruthy()
  })
})
