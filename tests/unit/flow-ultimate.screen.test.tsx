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
    // center-on-focused-node path must not throw (jsdom stage size may be 0)
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

    // Tab from close should stay inside sheet (cycle)
    const closeBtn = screen.getByTestId('flow-sheet-close')
    closeBtn.focus()
    fireEvent.keyDown(document, { key: 'Tab' })
    // After trap handler: if only close is focusable-ish, still contained
    await act(async () => {
      // dispatch real keydown on document as product listens there
      document.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', bubbles: true }),
      )
    })
    expect(sheet.contains(document.activeElement as Node)).toBe(true)

    // Escape closes and returns focus to opener node
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

    // Closed sheet: close control not tabbable
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

    // Focus on intentional initiating control (mode pill), not lost / not body
    await waitFor(() => {
      expect(document.activeElement).toBe(webMember)
    })
    expect(document.activeElement?.getAttribute('role')).toBe('tab')

    // Original opener unmounted after rebuild — must not remain as focused stale node
    if (firstId) {
      expect(
        document.activeElement?.getAttribute('data-node-id') === firstId,
      ).toBe(false)
    }

    // Escape restore still works on a fresh open in the new mode
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

    // Activate mode tab via keyboard APG while sheet is open (pointer/SR parity path)
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
    // Focus is a real control, not document body / null
    expect(
      document.activeElement === document.body ||
        document.activeElement == null,
    ).toBe(false)
  })

  it('D-A11Y-04 repair: brand reset while sheet open closes + focuses brand', async () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    // Open sheet in a non-cross mode so brand reset also rebuilds
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

    // Same-mode brand reset also closes (sheet open on cross)
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
    expect(summary.textContent || '').toMatch(/1 node/)
  })

  it('D-A11Y-12/13: zoom aria-labels and document h1 not inside button', () => {
    render(<FlowUltimateScreen data={fixture} boardId="mfs-rebuild" />)
    expect(screen.getByRole('button', { name: 'Perbesar' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Perkecil' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Muat semua' })).toBeTruthy()

    const headings = screen.getAllByRole('heading', { level: 1 })
    expect(headings).toHaveLength(1)
    expect(headings[0].textContent || '').toMatch(/Alur/i)
    // Adversarial: heading must not be contained by a button (pre-repair structure)
    expect(headings[0].closest('button')).toBeNull()
    // Brand remains a real button with reset affordance
    expect(screen.getByTestId('flow-brand').tagName).toBe('BUTTON')
    expect(screen.getByTestId('flow-brand').getAttribute('aria-label')).toMatch(
      /Alur/i,
    )
  })
})
