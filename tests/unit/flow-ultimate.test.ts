import { describe, expect, it } from 'vitest'

import {
  buildCrossGraph,
  buildGraphForMode,
  buildProjectGraph,
  projectKey,
  projectLabel,
} from '#/components/flow-ultimate/graph'
import {
  hasTechIdLeak,
  humanizeScreen,
  humanizeTaskTitle,
  humanizeTitle,
  scrubTechIds,
  statusClass,
  statusLabel,
} from '#/components/flow-ultimate/humanize'
import type { FlowDataBundle } from '#/components/flow-ultimate/types'

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
}

describe('flow-ultimate humanize', () => {
  it('scrubs technical IDs from display text', () => {
    const s = scrubTechIds('Tugas FEAT-AUTH-MEMBER dan T-WEB-001 MAPPED_100')
    expect(s).not.toMatch(/FEAT-/)
    expect(s).not.toMatch(/\bT-WEB-001\b/)
    expect(s).not.toMatch(/MAPPED_100/)
    expect(hasTechIdLeak(s)).toBe(false)
  })

  it('humanizes screens and titles', () => {
    expect(humanizeScreen('/premium')).toBe('Premium')
    expect(humanizeScreen('login')).toBe('Masuk')
    expect(humanizeTitle('/premium — pricing muncul')).toMatch(/Premium/)
    // scrubTechIds runs first → T-* becomes "tugas terkait" (canon parity)
    expect(humanizeTaskTitle('T-AUTH-01 Wire login screen')).toMatch(
      /Wire login screen/,
    )
    expect(hasTechIdLeak(humanizeTaskTitle('T-AUTH-01 Wire login screen'))).toBe(
      false,
    )
  })

  it('maps status labels to owner-readable id-ID', () => {
    expect(statusClass('MAPPED_100')).toBe('ok')
    expect(statusClass('MISSING')).toBe('bad')
    expect(statusLabel('terbukti')).toBe('Terbukti')
    expect(statusLabel('sebagian')).toBe('Sebagian')
  })
})

describe('flow-ultimate graph builders', () => {
  it('builds cross-project graph with sequential edges', () => {
    const g = buildCrossGraph(fixture, {})
    expect(g.nodes.length).toBeGreaterThan(5)
    expect(g.edges.length).toBeGreaterThan(0)
    // first premium node
    const n0 = g.nodes.find((n) => n.id === 'premium:1')
    expect(n0).toBeTruthy()
    expect(n0!.title).toMatch(/Sales/i)
    expect(hasTechIdLeak(n0!.title)).toBe(false)
    // no raw FEAT ids in titles/meta
    for (const n of g.nodes) {
      expect(hasTechIdLeak(n.title)).toBe(false)
      expect(hasTechIdLeak(n.meta)).toBe(false)
    }
  })

  it('builds project graph for web-member', () => {
    const g = buildProjectGraph(fixture, 'web-member', {})
    expect(g.nodes).toHaveLength(2)
    expect(g.nodes[0].title).toBe('Masuk web')
    expect(projectKey('sales')).toBe('panel-sales')
    expect(projectLabel('rn')).toBe('React Native')
  })

  it('buildGraphForMode switches cross vs project', () => {
    const cross = buildGraphForMode(fixture, 'cross', {})
    const rn = buildGraphForMode(fixture, 'rn', {})
    expect(cross.nodes.some((n) => n.kind === 'cross')).toBe(true)
    expect(rn.nodes.every((n) => n.kind === 'feature')).toBe(true)
    expect(rn.nodes).toHaveLength(1)
  })
})
