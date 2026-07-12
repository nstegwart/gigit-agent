// Pure layered-DAG layout for the wire/workflow graph. Left→right columns by
// dependency depth (within the given feature subset), nodes stacked per column.
// No DOM — the graph component renders SVG from these coords; unit-tested.
import type { Feature } from './types'

export interface GraphNode {
  id: string
  feature: Feature
  col: number
  row: number
  x: number
  y: number
  w: number
  h: number
}
export interface GraphEdge {
  from: string
  to: string
  blocked: boolean
}
export interface GraphLayout {
  nodes: Array<GraphNode>
  edges: Array<GraphEdge>
  width: number
  height: number
  cols: number
}

export const NODE_W = 220
export const NODE_H = 66
const COL_GAP = 96
const ROW_GAP = 20
const PAD = 28

export function layoutDag(features: Array<Feature>): GraphLayout {
  const ids = new Set(features.map((f) => f.id))
  const byId: Record<string, Feature> = {}
  for (const f of features) byId[f.id] = f

  // local depth = longest dependency chain WITHIN this subset (project subgraph starts at 0)
  const local: Record<string, number> = {}
  const seen = new Set<string>()
  const depth = (id: string): number => {
    if (local[id] != null) return local[id]
    if (seen.has(id)) return 0
    seen.add(id)
    const deps = (byId[id]?.deps ?? []).filter((d) => ids.has(d))
    const v = deps.length ? 1 + Math.max(...deps.map(depth)) : 0
    seen.delete(id)
    local[id] = v
    return v
  }
  for (const f of features) depth(f.id)

  const cols: Array<Array<Feature>> = []
  for (const f of features) (cols[local[f.id]] ??= []).push(f)

  const nodes: Array<GraphNode> = []
  cols.forEach((colFeats, col) => {
    colFeats.sort((a, b) => a.nama.localeCompare(b.nama))
    colFeats.forEach((f, row) => {
      nodes.push({
        id: f.id,
        feature: f,
        col,
        row,
        x: PAD + col * (NODE_W + COL_GAP),
        y: PAD + row * (NODE_H + ROW_GAP),
        w: NODE_W,
        h: NODE_H,
      })
    })
  })

  const edges: Array<GraphEdge> = []
  for (const f of features) {
    for (const d of f.deps ?? []) {
      if (ids.has(d)) edges.push({ from: d, to: f.id, blocked: f.isBlocked })
    }
  }

  const colCount = cols.length || 1
  const maxRows = Math.max(1, ...cols.map((c) => c.length))
  const width = PAD * 2 + colCount * (NODE_W + COL_GAP) - COL_GAP
  const height = PAD * 2 + maxRows * (NODE_H + ROW_GAP) - ROW_GAP
  return { nodes, edges, width, height, cols: colCount }
}

/** Edge endpoints: from right-center of `from` to left-center of `to`. */
export function edgePath(from: GraphNode, to: GraphNode): string {
  const x1 = from.x + from.w
  const y1 = from.y + from.h / 2
  const x2 = to.x
  const y2 = to.y + to.h / 2
  const mx = (x1 + x2) / 2
  return `M ${x1} ${y1} C ${mx} ${y1}, ${mx} ${y2}, ${x2} ${y2}`
}
