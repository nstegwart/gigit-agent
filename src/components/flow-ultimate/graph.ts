import { formatNodeMeta, humanizeTitle } from './humanize'
import {
  CARD_H,
  CARD_W,
  CROSS_PROJECT_ORDER,
  GAP_X,
  GAP_Y,
  PROJ_META,
  STORAGE_KEY,
  type FlowAppFlowSemanticEdge,
  type FlowAppFlowSemanticNode,
  type FlowDataBundle,
  type FlowEdge,
  type FlowFeature,
  type FlowGraph,
  type FlowMode,
  type FlowNavLayer,
  type FlowNode,
  type FlowPageNavSemanticEdge,
  type FlowPageNavSemanticNode,
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

// ---------------------------------------------------------------------------
// Semantic client ID namespaces — never merge; never rewrite exact endpoints
// ---------------------------------------------------------------------------

/** app_flow journey card id */
export function clientAppFlowNodeId(project: string, nodeId: string): string {
  return `af:${projectKey(project)}:${nodeId}`
}

/** page_nav journey card id */
export function clientPageNavNodeId(project: string, pageId: string): string {
  return `pn:${projectKey(project)}:${pageId}`
}

/** feature inventory card id — never an edge endpoint */
export function clientInventoryNodeId(
  project: string,
  featureId: string,
): string {
  return `inv:${projectKey(project)}:${featureId}`
}

/** app_flow edge runtime id */
export function clientAppFlowEdgeId(project: string, edgeId: string): string {
  return `nav:${projectKey(project)}:${edgeId}`
}

/** page_nav edge runtime id (edge_id already `${from}->${to}`) */
export function clientPageNavEdgeId(edgeId: string): string {
  return `page_nav:${edgeId}`
}

/**
 * localStorage mode bucket under STORAGE_KEY (`cairn-flow-pos-v1`).
 * Namespaced by mode+layer so old bare feature / sequential fiction entries
 * cannot collide with prefixed semantic node ids.
 */
export function positionStorageKey(
  mode: FlowMode | string,
  layer: FlowNavLayer = 'app_flow',
): string {
  if (mode === 'cross') return 'cross:app_flow'
  return `${mode}:${layer}`
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

// ---------------------------------------------------------------------------
// Layout (positions only — never edges)
// ---------------------------------------------------------------------------

const GRID_COL_CAP = 7

function defaultGridPos(index: number): { x: number; y: number } {
  const col = Math.floor(index / GRID_COL_CAP)
  const row = index % GRID_COL_CAP
  return {
    x: 40 + col * (CARD_W + GAP_X),
    y: 40 + row * (CARD_H + GAP_Y),
  }
}

function layoutFromSemantic(
  col: number | undefined | null,
  row: number | undefined | null,
  fallbackIndex: number,
): { x: number; y: number } {
  if (
    col != null &&
    row != null &&
    Number.isFinite(col) &&
    Number.isFinite(row) &&
    (col > 0 || row > 0 || col === 0)
  ) {
    // layout_col/row may be 0-based; treat as grid coords when both set
    return {
      x: 40 + Number(col) * (CARD_W + GAP_X),
      y: 40 + Number(row) * (CARD_H + GAP_Y),
    }
  }
  return defaultGridPos(fallbackIndex)
}

function journeyMetaFromFeature(
  data: FlowDataBundle,
  featureId: string | null | undefined,
  preferProj: string,
  fallbackKind: string,
): { meta: string; status: string } {
  const found = featureId ? findFeature(data, featureId, preferProj) : null
  if (found) {
    const sc = (found.feature.screens || []).length
    return {
      meta: formatNodeMeta(sc, found.feature.pct),
      status: found.feature.status,
    }
  }
  return { meta: fallbackKind, status: 'sebagian' }
}

// ---------------------------------------------------------------------------
// Inventory nodes (project mode only) — never connected
// ---------------------------------------------------------------------------

export function buildInventoryNodes(
  data: FlowDataBundle,
  projId: string,
  saved?: PositionMap,
  startIndex = 0,
): FlowNode[] {
  const list = (data.features[projId] || []).slice()
  // Stable order by id for deterministic layout
  list.sort((a, b) => a.id.localeCompare(b.id))
  const posMap = saved || {}
  const ns: FlowNode[] = []
  list.forEach((f, i) => {
    const id = clientInventoryNodeId(projId, f.id)
    const idx = startIndex + i
    const def = defaultGridPos(idx)
    // Offset inventory below journey area when mixed
    const defaultX = def.x
    const defaultY = def.y + (startIndex > 0 ? CARD_H + GAP_Y : 0)
    const pos = posMap[id] || { x: defaultX, y: defaultY }
    const sc = (f.screens || []).length
    ns.push({
      id,
      x: pos.x,
      y: pos.y,
      title: humanizeTitle(f.nama_id),
      meta: formatNodeMeta(sc, f.pct),
      status: f.status,
      project: projId,
      featureId: f.id,
      kind: 'inventory',
      inventoryBadge: true,
    })
  })
  return ns
}

// ---------------------------------------------------------------------------
// Semantic edge mappers — drop dangling; never invent stubs
// ---------------------------------------------------------------------------

export function mapAppFlowEdge(
  project: string,
  edge: FlowAppFlowSemanticEdge,
  nodeIds: Set<string>,
): FlowEdge | null {
  const from = clientAppFlowNodeId(project, edge.from_node)
  const to = clientAppFlowNodeId(project, edge.to_node)
  if (!nodeIds.has(from) || !nodeIds.has(to)) return null
  return {
    id: clientAppFlowEdgeId(project, edge.edge_id),
    from,
    to,
    edge_class: 'nav',
  }
}

export function mapPageNavEdge(
  project: string,
  edge: FlowPageNavSemanticEdge,
  nodeIds: Set<string>,
): FlowEdge | null {
  const from = clientPageNavNodeId(project, edge.from_page)
  const to = clientPageNavNodeId(project, edge.to_page)
  if (!nodeIds.has(from) || !nodeIds.has(to)) return null
  return {
    id: clientPageNavEdgeId(edge.edge_id),
    from,
    to,
    edge_class: 'page_nav',
  }
}

// ---------------------------------------------------------------------------
// Project graph — one layer at a time + optional unconnected inventory
// ---------------------------------------------------------------------------

function sortAppFlowNodes(
  nodes: FlowAppFlowSemanticNode[],
): FlowAppFlowSemanticNode[] {
  return nodes.slice().sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.node_id.localeCompare(b.node_id)
  })
}

function sortPageNavNodes(
  nodes: FlowPageNavSemanticNode[],
): FlowPageNavSemanticNode[] {
  return nodes.slice().sort((a, b) => {
    const sa = (a as { sort_order?: number }).sort_order ?? 0
    const sb = (b as { sort_order?: number }).sort_order ?? 0
    if (sa !== sb) return sa - sb
    return a.page_id.localeCompare(b.page_id)
  })
}

export function buildSemanticProjectGraph(
  data: FlowDataBundle,
  projId: string,
  layer: FlowNavLayer = 'app_flow',
  saved?: PositionMap,
): FlowGraph {
  const proj = projectKey(projId)
  const posMap = saved || loadPositions(positionStorageKey(proj, layer))
  const ns: FlowNode[] = []
  const es: FlowEdge[] = []
  const nav = data.nav
  const projectNav = nav?.by_project?.[proj]

  if (layer === 'app_flow' && projectNav?.app_flow) {
    const sorted = sortAppFlowNodes(projectNav.app_flow.nodes)
    sorted.forEach((n, i) => {
      const id = clientAppFlowNodeId(proj, n.node_id)
      const def = layoutFromSemantic(n.layout_col, n.layout_row, i)
      const pos = posMap[id] || def
      const { meta, status } = journeyMetaFromFeature(
        data,
        n.feature_id,
        proj,
        'Layar',
      )
      ns.push({
        id,
        x: pos.x,
        y: pos.y,
        title: humanizeTitle(n.label_id || n.node_id),
        meta,
        status,
        project: proj,
        featureId: n.feature_id,
        kind: 'journey_app',
        semanticRef: {
          layer: 'app_flow',
          exactId: n.node_id,
          project: proj,
        },
      })
    })
    const nodeIds = new Set(ns.map((n) => n.id))
    const edges = projectNav.app_flow.edges
      .slice()
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.edge_id.localeCompare(b.edge_id)
      })
    for (const e of edges) {
      const mapped = mapAppFlowEdge(proj, e, nodeIds)
      if (mapped) es.push(mapped)
    }
  } else if (layer === 'page_nav' && projectNav?.page_nav) {
    const sorted = sortPageNavNodes(projectNav.page_nav.nodes)
    sorted.forEach((n, i) => {
      const id = clientPageNavNodeId(proj, n.page_id)
      const def = defaultGridPos(i)
      const pos = posMap[id] || def
      const { meta, status } = journeyMetaFromFeature(
        data,
        n.feature_id,
        proj,
        n.area ? humanizeTitle(n.area) : 'Laman',
      )
      const routeHint = n.route
        ? humanizeTitle(n.route.replace(/^\/+/, '').split('/')[0] || 'Laman')
        : meta
      ns.push({
        id,
        x: pos.x,
        y: pos.y,
        title: humanizeTitle(n.label_id || n.page_id),
        meta: n.route ? routeHint : meta,
        status,
        project: proj,
        featureId: n.feature_id,
        kind: 'journey_page',
        semanticRef: {
          layer: 'page_nav',
          exactId: n.page_id,
          project: proj,
        },
      })
    })
    const nodeIds = new Set(ns.map((n) => n.id))
    const edges = projectNav.page_nav.edges
      .slice()
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.edge_id.localeCompare(b.edge_id)
      })
    for (const e of edges) {
      const mapped = mapPageNavEdge(proj, e, nodeIds)
      if (mapped) es.push(mapped)
    }
  }

  // Unconnected inventory (features) — never edges, never list-order fiction
  const inv = buildInventoryNodes(data, proj, posMap, ns.length)
  // Place inventory to the right of journey cards when both present
  if (ns.length > 0 && inv.length > 0) {
    let maxJourneyX = 0
    for (const n of ns) maxJourneyX = Math.max(maxJourneyX, n.x + CARD_W)
    inv.forEach((n, i) => {
      if (!posMap[n.id]) {
        const row = i % GRID_COL_CAP
        const col = Math.floor(i / GRID_COL_CAP)
        n.x = maxJourneyX + GAP_X + col * (CARD_W + GAP_X)
        n.y = 40 + row * (CARD_H + GAP_Y)
      }
    })
  }
  ns.push(...inv)

  return { nodes: ns, edges: es }
}

/**
 * @deprecated Prefer buildSemanticProjectGraph. Kept as alias for tests/callers.
 * No list-order layout edges — inventory only when nav absent.
 */
export function buildProjectGraph(
  data: FlowDataBundle,
  projId: string,
  saved?: PositionMap,
  layer: FlowNavLayer = 'app_flow',
): FlowGraph {
  return buildSemanticProjectGraph(data, projId, layer, saved)
}

// ---------------------------------------------------------------------------
// Cross graph — union of five projects' app_flow; no synthetic / inter-project
// ---------------------------------------------------------------------------

export function buildSemanticCrossGraph(
  data: FlowDataBundle,
  saved?: PositionMap,
): FlowGraph {
  const posMap = saved || loadPositions(positionStorageKey('cross', 'app_flow'))
  const ns: FlowNode[] = []
  const es: FlowEdge[] = []
  const nav = data.nav
  if (!nav?.by_project) {
    // No semantic source: zero journey nodes, zero edges (never invent premium/auth fiction)
    return { nodes: ns, edges: es }
  }

  let row = 0
  for (const proj of CROSS_PROJECT_ORDER) {
    const projectNav = nav.by_project[proj]
    if (!projectNav?.app_flow?.nodes?.length) {
      row += 1
      continue
    }
    const baseY = row * (CARD_H + GAP_Y + 48) + 40
    const sorted = sortAppFlowNodes(projectNav.app_flow.nodes)
    const projectNodeIds = new Set<string>()
    sorted.forEach((n, i) => {
      const id = clientAppFlowNodeId(proj, n.node_id)
      projectNodeIds.add(id)
      const defX = 40 + i * (CARD_W + GAP_X)
      // Prefer layout_col within the project row when available
      const def =
        n.layout_col != null && Number.isFinite(n.layout_col)
          ? {
              x: 40 + Number(n.layout_col) * (CARD_W + GAP_X),
              y: baseY + (Number(n.layout_row) || 0) * (CARD_H + GAP_Y),
            }
          : { x: defX, y: baseY }
      const pos = posMap[id] || def
      const { meta, status } = journeyMetaFromFeature(
        data,
        n.feature_id,
        proj,
        'Layar',
      )
      ns.push({
        id,
        x: pos.x,
        y: pos.y,
        title: humanizeTitle(n.label_id || n.node_id),
        meta,
        status,
        project: proj,
        featureId: n.feature_id,
        kind: 'journey_app',
        semanticRef: {
          layer: 'app_flow',
          exactId: n.node_id,
          project: proj,
        },
      })
    })
    // Only exact per-project app_flow edges (no inter-project lines)
    const edges = projectNav.app_flow.edges
      .slice()
      .sort((a, b) => {
        if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
        return a.edge_id.localeCompare(b.edge_id)
      })
    for (const e of edges) {
      const mapped = mapAppFlowEdge(proj, e, projectNodeIds)
      if (mapped) es.push(mapped)
    }
    row += 1
  }

  return { nodes: ns, edges: es }
}

/**
 * @deprecated Prefer buildSemanticCrossGraph. Kept as alias for tests/callers.
 * No premium/auth/aff/iap sequential fiction.
 */
export function buildCrossGraph(
  data: FlowDataBundle,
  saved?: PositionMap,
): FlowGraph {
  return buildSemanticCrossGraph(data, saved)
}

export function buildGraphForMode(
  data: FlowDataBundle,
  mode: FlowMode,
  saved?: PositionMap,
  layer: FlowNavLayer = 'app_flow',
): FlowGraph {
  return mode === 'cross'
    ? buildSemanticCrossGraph(data, saved)
    : buildSemanticProjectGraph(data, mode, layer, saved)
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
