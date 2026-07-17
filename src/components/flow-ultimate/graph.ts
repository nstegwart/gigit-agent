import { humanizeTitle } from './humanize'
import {
  CARD_H,
  CARD_W,
  GAP_X,
  GAP_Y,
  PROJ_META,
  STORAGE_KEY,
  type FlowDataBundle,
  type FlowFeature,
  type FlowGraph,
  type FlowMode,
  type FlowNode,
  type FlowPremiumStep,
} from './types'

export function projectKey(p: string | undefined | null): string {
  if (p === 'web' || p === 'web-member') return 'web-member'
  if (p === 'sales' || p === 'panel-sales') return 'panel-sales'
  return p || ''
}

export function projectLabel(p: string | undefined | null): string {
  const k = projectKey(p)
  return (PROJ_META[k] || PROJ_META[p || ''] || { label: k || 'Proyek' }).label
}

export function projectColor(p: string | undefined | null): string {
  const k = projectKey(p)
  return (PROJ_META[k] || PROJ_META[p || ''] || { color: 'var(--t3)' }).color
}

export function projectCss(p: string | undefined | null): string {
  const k = projectKey(p)
  return (PROJ_META[k] || PROJ_META[p || ''] || { css: '#586170' }).css
}

export function findFeature(
  data: FlowDataBundle,
  featureId: string | null | undefined,
  preferProj?: string | null,
): { feature: FlowFeature; project: string } | null {
  if (!featureId || !data) return null
  const order = preferProj
    ? [
        projectKey(preferProj),
        'web-member',
        'panel-sales',
        'backend',
        'rn',
        'affiliate',
      ]
    : ['web-member', 'panel-sales', 'backend', 'rn', 'affiliate']
  const seen = new Set<string>()
  for (const p of order) {
    if (seen.has(p)) continue
    seen.add(p)
    const list = data.features[p] || []
    const f = list.find((x) => x.id === featureId)
    if (f) return { feature: f, project: p }
  }
  for (const p of Object.keys(data.features)) {
    const f = (data.features[p] || []).find((x) => x.id === featureId)
    if (f) return { feature: f, project: p }
  }
  return null
}

function premiumFeatureMap(step: FlowPremiumStep): string | null {
  const map: Record<number, string> = {
    1: 'FEAT-HARGA-PAKET',
    2: 'FEAT-HARGA-PAKET',
    3: 'FEAT-LANDING-HARGA',
    4: 'FEAT-CHECKOUT-WEB',
    5: 'FEAT-HARGA-PAKET',
    6: 'FEAT-CHECKOUT-WEB',
    7: 'FEAT-CLEENG',
    8: 'FEAT-PAYWALL',
    9: 'FEAT-SALES-TXN',
    10: 'FEAT-AFFILIATE',
  }
  return map[step.n] || null
}

export type PositionMap = Record<string, { x: number; y: number }>

export function loadPositions(modeKey: string): PositionMap {
  if (typeof localStorage === 'undefined') return {}
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<
      string,
      PositionMap
    >
    return all[modeKey] || {}
  } catch {
    return {}
  }
}

export function savePosition(
  modeKey: string,
  nodeId: string,
  x: number,
  y: number,
): void {
  if (typeof localStorage === 'undefined') return
  try {
    const all = JSON.parse(localStorage.getItem(STORAGE_KEY) || '{}') as Record<
      string,
      PositionMap
    >
    if (!all[modeKey]) all[modeKey] = {}
    all[modeKey][nodeId] = { x, y }
    localStorage.setItem(STORAGE_KEY, JSON.stringify(all))
  } catch {
    /* ignore quota */
  }
}

export function buildCrossGraph(
  data: FlowDataBundle,
  saved?: PositionMap,
): FlowGraph {
  const ns: FlowNode[] = []
  const es: { from: string; to: string }[] = []
  const posMap = saved || loadPositions('cross')
  let row = 0

  function placeFlow(
    flowId: string,
    title: string,
    steps: Array<FlowPremiumStep & { feature_id?: string | null }>,
  ) {
    const baseY = row * (CARD_H + GAP_Y + 48) + 40
    steps.forEach((step, i) => {
      const id = `${flowId}:${i + 1}`
      const proj = projectKey(step.proj || step.project)
      const featId = step.feature_id || premiumFeatureMap(step) || null
      const found = featId ? findFeature(data, featId, proj) : null
      const st =
        step.st === 'ok'
          ? 'terbukti'
          : step.st === 'warn'
            ? 'sebagian'
            : found
              ? found.feature.status
              : 'sebagian'
      const pct = found ? found.feature.pct : step.st === 'ok' ? 100 : 70
      const screens = found ? (found.feature.screens || []).length : 0
      const defaultX = 40 + i * (CARD_W + GAP_X)
      const defaultY = baseY
      const pos = posMap[id] || { x: defaultX, y: defaultY }
      ns.push({
        id,
        x: pos.x,
        y: pos.y,
        title: humanizeTitle(step.title),
        meta: screens ? `${screens} layar · ${pct}%` : `${pct}%`,
        status: st,
        project: proj,
        featureId: featId,
        step,
        kind: 'cross',
        flowTitle: title,
        apis: step.api && step.api !== '—' ? [step.api] : [],
      })
      if (i > 0) es.push({ from: `${flowId}:${i}`, to: id })
    })
    row += 1
  }

  const premiumSteps = (data.premium && data.premium.steps) || []
  placeFlow(
    'premium',
    (data.premium && data.premium.name) || 'Pembelian Premium',
    premiumSteps.map((s) => ({
      ...s,
      feature_id: premiumFeatureMap(s) ?? undefined,
    })),
  )

  placeFlow('auth', 'Login & sesi anggota', [
    {
      n: 1,
      proj: 'rn',
      title: 'Masuk di aplikasi',
      feature_id: 'FEAT-AUTH-MEMBER',
      st: 'warn',
    },
    {
      n: 2,
      proj: 'backend',
      title: 'Terbitkan sesi & token',
      feature_id: 'FEAT-AUTH-MEMBER',
      st: 'warn',
    },
    {
      n: 3,
      proj: 'web-member',
      title: 'Masuk di web member',
      feature_id: 'FEAT-AUTH-MEMBER',
      st: 'warn',
    },
  ])

  placeFlow('aff', 'Atribusi & komisi afiliasi', [
    {
      n: 1,
      proj: 'web-member',
      title: 'Tautan undangan publik',
      feature_id: 'FEAT-AFFILIATE',
      st: 'warn',
    },
    {
      n: 2,
      proj: 'web-member',
      title: 'Checkout ber-kode mitra',
      feature_id: 'FEAT-CHECKOUT-WEB',
      st: 'warn',
    },
    {
      n: 3,
      proj: 'backend',
      title: 'Catat referral & komisi',
      feature_id: 'FEAT-AFFILIATE',
      st: 'warn',
    },
    {
      n: 4,
      proj: 'affiliate',
      title: 'Portal mitra melihat saldo',
      feature_id: 'FEAT-AFFILIATE',
      st: 'warn',
    },
    {
      n: 5,
      proj: 'backend',
      title: 'Payout lewat Xendit',
      feature_id: 'FEAT-XENDIT',
      st: 'warn',
    },
  ])

  placeFlow('iap', 'Pembelian dalam aplikasi', [
    {
      n: 1,
      proj: 'rn',
      title: 'Paywall di aplikasi',
      feature_id: 'FEAT-PAYWALL',
      st: 'warn',
    },
    {
      n: 2,
      proj: 'rn',
      title: 'Beli lewat toko aplikasi',
      feature_id: 'FEAT-REVENUECAT',
      st: 'warn',
    },
    {
      n: 3,
      proj: 'backend',
      title: 'Webhook pembelian',
      feature_id: 'FEAT-REVENUECAT',
      st: 'warn',
    },
    {
      n: 4,
      proj: 'backend',
      title: 'Status premium aktif',
      feature_id: 'FEAT-PAYWALL',
      st: 'warn',
    },
  ])

  return { nodes: ns, edges: es }
}

export function buildProjectGraph(
  data: FlowDataBundle,
  projId: string,
  saved?: PositionMap,
): FlowGraph {
  const list = (data.features[projId] || []).slice()
  const posMap = saved || loadPositions(projId)
  const ns: FlowNode[] = []
  const es: { from: string; to: string }[] = []
  if (!list.length) return { nodes: ns, edges: es }

  const COL_CAP = 7
  list.forEach((f, idx) => {
    const col = Math.floor(idx / COL_CAP)
    const row = idx % COL_CAP
    const id = f.id
    const defaultX = 40 + col * (CARD_W + GAP_X)
    const defaultY = 40 + row * (CARD_H + GAP_Y)
    const pos = posMap[id] || { x: defaultX, y: defaultY }
    const sc = (f.screens || []).length
    ns.push({
      id,
      x: pos.x,
      y: pos.y,
      title: f.nama_id,
      meta: `${sc} layar · ${f.pct || 0}%`,
      status: f.status,
      project: projId,
      featureId: f.id,
      kind: 'feature',
    })
    if (row > 0) {
      const prev = list[idx - 1]
      if (prev) es.push({ from: prev.id, to: id })
    } else if (col > 0) {
      const hub = list[(col - 1) * COL_CAP]
      if (hub) es.push({ from: hub.id, to: id })
    }
  })
  return { nodes: ns, edges: es }
}

export function buildGraphForMode(
  data: FlowDataBundle,
  mode: FlowMode,
  saved?: PositionMap,
): FlowGraph {
  return mode === 'cross'
    ? buildCrossGraph(data, saved)
    : buildProjectGraph(data, mode, saved)
}

export function clamp(n: number, a: number, b: number): number {
  return Math.max(a, Math.min(b, n))
}

export function nodeCenter(n: FlowNode): { x: number; y: number } {
  return { x: n.x + 12 + 5, y: n.y + CARD_H / 2 }
}

export function fitTransform(
  nodes: FlowNode[],
  vw: number,
  vh: number,
): { x: number; y: number; scale: number } {
  if (!nodes.length) return { x: 80, y: 60, scale: 1 }
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const n of nodes) {
    minX = Math.min(minX, n.x)
    minY = Math.min(minY, n.y)
    maxX = Math.max(maxX, n.x + CARD_W)
    maxY = Math.max(maxY, n.y + CARD_H)
  }
  const pad = 48
  const bw = maxX - minX + pad * 2
  const bh = maxY - minY + pad * 2
  const s = clamp(Math.min(vw / bw, vh / bh, 1.15), 0.35, 1.25)
  return {
    scale: s,
    x: (vw - bw * s) / 2 - (minX - pad) * s,
    y: (vh - bh * s) / 2 - (minY - pad) * s,
  }
}

export function centerTransform(
  n: FlowNode,
  vw: number,
  vh: number,
  scale: number,
  sheetOpen: boolean,
): { x: number; y: number; scale: number } {
  const usableH = vh * (sheetOpen ? 0.55 : 1)
  const cx = n.x + CARD_W / 2
  const cy = n.y + CARD_H / 2
  return {
    scale,
    x: vw / 2 - cx * scale,
    y: usableH / 2 - cy * scale,
  }
}
