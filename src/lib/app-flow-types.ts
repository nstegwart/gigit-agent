/**
 * App navigation flow types + filesystem loader (F2-WF-0 / TM-SALVAGE-APP-FLOW-INGEST).
 * Server-safe: reads data/app-flow/*.json only. No DB imports. No secrets.
 */

import { readdirSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'

/** Canonical portfolio project ids for app-flow graphs. */
export const APP_FLOW_PROJECT_IDS = [
  'rn',
  'web',
  'sales',
  'affiliate',
  'backend',
] as const

export type AppFlowProjectId = (typeof APP_FLOW_PROJECT_IDS)[number]

/**
 * Soft aliases → canonical project_id.
 * Used by ingest + loaders so alternate labels map deterministically.
 */
export const PROJECT_ALIASES: Record<string, AppFlowProjectId> = {
  rn: 'rn',
  'react-native': 'rn',
  mobile: 'rn',
  mfs81: 'rn',
  web: 'web',
  'mfs-web': 'web',
  'mfs-web-original-upgrade': 'web',
  sales: 'sales',
  admin: 'sales',
  'sales-rebuild': 'sales',
  affiliate: 'affiliate',
  'affiliate-rebuild': 'affiliate',
  backend: 'backend',
  api: 'backend',
  'rebuild-backend': 'backend',
}

export type FlowNodeKind = 'screen' | 'feature'

export type FlowEdgeKind =
  | 'nav'
  | 'auth'
  | 'hub'
  | 'branch'
  | 'hierarchy'
  | 'fallback'
  | string

export interface FlowNode {
  node_id: string
  feature_id: string | null
  label_id: string
  kind: FlowNodeKind
  sort_order: number
  layout_col: number
  layout_row: number
  source_ref?: string | null
  meta?: Record<string, unknown> | null
}

export interface FlowEdge {
  edge_id: string
  from_node: string
  to_node: string
  edge_kind: FlowEdgeKind
  sort_order?: number
  meta?: Record<string, unknown> | null
}

export interface ProjectFlowStats {
  nodes: number
  edges: number
  mapped_features: number
  unmapped_screens: number
  feature_ids: string[]
}

export interface ProjectFlow {
  project_id: string
  version: number
  source: string
  generated_at?: string
  /** sha256 of stable payload (excludes generated_at). */
  source_hash?: string
  nodes: FlowNode[]
  edges: FlowEdge[]
  stats?: ProjectFlowStats
}

export interface AppFlowIndex {
  projects: string[]
  flows: Record<string, ProjectFlow>
}

export interface FlowValidationIssue {
  code: string
  message: string
  path?: string
}

export interface FlowValidationResult {
  ok: boolean
  issues: FlowValidationIssue[]
}

const DEFAULT_REL = 'data/app-flow'
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/
const EDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/
const FEATURE_SOFT_RE = /^FEAT-[A-Z0-9][A-Z0-9_-]*$/

/** Resolve alias (or raw id) to a canonical project id, or null if unknown. */
export function resolveProjectAlias(input: string): AppFlowProjectId | null {
  const key = String(input || '')
    .trim()
    .toLowerCase()
  if (!key) return null
  if ((APP_FLOW_PROJECT_IDS as readonly string[]).includes(key)) {
    return key as AppFlowProjectId
  }
  return PROJECT_ALIASES[key] ?? null
}

/** Resolve data/app-flow directory from cwd or explicit root. */
export function resolveAppFlowDir(rootDir?: string): string {
  const base = rootDir ?? process.cwd()
  return join(base, DEFAULT_REL)
}

/** List project ids that have a committed flow JSON (basename without .json). */
export function listAppFlowProjects(rootDir?: string): string[] {
  const dir = resolveAppFlowDir(rootDir)
  if (!existsSync(dir)) return []
  return readdirSync(dir)
    .filter((f) => f.endsWith('.json') && !f.startsWith('_'))
    .map((f) => f.replace(/\.json$/i, ''))
    .sort()
}

/** Load one project flow JSON. Returns null if missing/invalid. */
export function loadProjectFlow(
  projectId: string,
  rootDir?: string,
): ProjectFlow | null {
  const safe = projectId.replace(/[^a-zA-Z0-9_-]/g, '')
  if (!safe || safe !== projectId) return null
  const path = join(resolveAppFlowDir(rootDir), `${safe}.json`)
  if (!existsSync(path)) return null
  try {
    const raw = JSON.parse(readFileSync(path, 'utf8')) as ProjectFlow
    if (!raw || typeof raw !== 'object') return null
    if (typeof raw.project_id !== 'string') return null
    if (!Array.isArray(raw.nodes) || !Array.isArray(raw.edges)) return null
    return raw
  } catch {
    return null
  }
}

/** Load all project flows under data/app-flow. */
export function loadAllProjectFlows(rootDir?: string): AppFlowIndex {
  const projects = listAppFlowProjects(rootDir)
  const flows: Record<string, ProjectFlow> = {}
  for (const id of projects) {
    const flow = loadProjectFlow(id, rootDir)
    if (flow) flows[id] = flow
  }
  return { projects: Object.keys(flows).sort(), flows }
}

/**
 * Validate a ProjectFlow shape for file-only contracts:
 * unique node/edge ids, edge endpoints, feature soft refs, project alias, min size.
 */
export function validateProjectFlow(
  flow: ProjectFlow,
  opts: { minNodes?: number; requireSourceHash?: boolean } = {},
): FlowValidationResult {
  const minNodes = opts.minNodes ?? 5
  const issues: FlowValidationIssue[] = []

  if (!flow || typeof flow !== 'object') {
    return { ok: false, issues: [{ code: 'not_object', message: 'flow is not an object' }] }
  }
  if (typeof flow.project_id !== 'string' || !flow.project_id) {
    issues.push({ code: 'project_id', message: 'missing project_id', path: 'project_id' })
  } else if (!resolveProjectAlias(flow.project_id)) {
    issues.push({
      code: 'project_alias',
      message: `unknown project_id alias: ${flow.project_id}`,
      path: 'project_id',
    })
  } else {
    const canonical = resolveProjectAlias(flow.project_id)!
    if (flow.project_id !== canonical) {
      issues.push({
        code: 'project_alias_noncanonical',
        message: `project_id ${flow.project_id} should be canonical ${canonical}`,
        path: 'project_id',
      })
    }
  }

  if (!Array.isArray(flow.nodes)) {
    issues.push({ code: 'nodes', message: 'nodes must be an array', path: 'nodes' })
  }
  if (!Array.isArray(flow.edges)) {
    issues.push({ code: 'edges', message: 'edges must be an array', path: 'edges' })
  }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    return { ok: false, issues }
  }

  if (flow.nodes.length < minNodes) {
    issues.push({
      code: 'min_nodes',
      message: `nodes.length ${flow.nodes.length} < ${minNodes}`,
      path: 'nodes',
    })
  }

  const nodeIds = new Set<string>()
  for (let i = 0; i < flow.nodes.length; i++) {
    const n = flow.nodes[i]
    const p = `nodes[${i}]`
    if (!n || typeof n.node_id !== 'string' || !NODE_ID_RE.test(n.node_id)) {
      issues.push({
        code: 'node_id',
        message: `invalid node_id at ${p}`,
        path: p,
      })
      continue
    }
    if (nodeIds.has(n.node_id)) {
      issues.push({
        code: 'duplicate_node',
        message: `duplicate node_id ${n.node_id}`,
        path: p,
      })
    }
    nodeIds.add(n.node_id)
    if (typeof n.label_id !== 'string' || !n.label_id) {
      issues.push({ code: 'label_id', message: `missing label_id`, path: p })
    }
    if (n.kind !== 'screen' && n.kind !== 'feature') {
      issues.push({ code: 'kind', message: `invalid kind ${String(n.kind)}`, path: p })
    }
    // Feature soft ref: null (unmapped screen) or FEAT-* string; never hard FK to DB.
    if (n.feature_id == null) {
      if (n.kind === 'feature') {
        issues.push({
          code: 'feature_soft_ref',
          message: `kind=feature requires feature_id soft ref`,
          path: p,
        })
      }
    } else if (typeof n.feature_id !== 'string' || !FEATURE_SOFT_RE.test(n.feature_id)) {
      issues.push({
        code: 'feature_soft_ref',
        message: `feature_id must be null or FEAT-* soft ref, got ${String(n.feature_id)}`,
        path: p,
      })
    }
    if (typeof n.sort_order !== 'number' || !Number.isFinite(n.sort_order)) {
      issues.push({ code: 'sort_order', message: 'sort_order must be number', path: p })
    }
    if (typeof n.layout_col !== 'number' || typeof n.layout_row !== 'number') {
      issues.push({ code: 'layout', message: 'layout_col/row required', path: p })
    }
  }

  const edgeIds = new Set<string>()
  const undirectedPairs = new Set<string>()
  for (let i = 0; i < flow.edges.length; i++) {
    const e = flow.edges[i]
    const p = `edges[${i}]`
    if (!e || typeof e.edge_id !== 'string' || !EDGE_ID_RE.test(e.edge_id)) {
      issues.push({ code: 'edge_id', message: `invalid edge_id at ${p}`, path: p })
      continue
    }
    if (edgeIds.has(e.edge_id)) {
      issues.push({
        code: 'duplicate_edge_id',
        message: `duplicate edge_id ${e.edge_id}`,
        path: p,
      })
    }
    edgeIds.add(e.edge_id)
    if (!nodeIds.has(e.from_node)) {
      issues.push({
        code: 'edge_from',
        message: `from_node ${e.from_node} missing`,
        path: p,
      })
    }
    if (!nodeIds.has(e.to_node)) {
      issues.push({
        code: 'edge_to',
        message: `to_node ${e.to_node} missing`,
        path: p,
      })
    }
    if (e.from_node === e.to_node) {
      issues.push({
        code: 'edge_self',
        message: `self-loop ${e.edge_id}`,
        path: p,
      })
    }
    // Directed pair + kind uniqueness (duplicate parallel edges).
    const pairKey = `${e.from_node}\0${e.to_node}\0${e.edge_kind}`
    if (undirectedPairs.has(pairKey)) {
      issues.push({
        code: 'duplicate_edge',
        message: `duplicate edge ${e.from_node}→${e.to_node} (${e.edge_kind})`,
        path: p,
      })
    }
    undirectedPairs.add(pairKey)
    if (typeof e.edge_kind !== 'string' || !e.edge_kind) {
      issues.push({ code: 'edge_kind', message: 'edge_kind required', path: p })
    }
  }

  if (opts.requireSourceHash) {
    if (typeof flow.source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(flow.source_hash)) {
      issues.push({
        code: 'source_hash',
        message: 'source_hash must be 64-char hex sha256',
        path: 'source_hash',
      })
    }
  }

  return { ok: issues.length === 0, issues }
}

/** True when a path exists from `from` to `to` following directed edges. */
export function hasFlowPath(
  flow: ProjectFlow,
  fromNode: string,
  toNode: string,
): boolean {
  if (fromNode === toNode) return true
  const adj = new Map<string, string[]>()
  for (const e of flow.edges) {
    const list = adj.get(e.from_node) ?? []
    list.push(e.to_node)
    adj.set(e.from_node, list)
  }
  const seen = new Set<string>()
  const q = [fromNode]
  while (q.length) {
    const cur = q.shift()!
    if (cur === toNode) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const n of adj.get(cur) ?? []) {
      if (!seen.has(n)) q.push(n)
    }
  }
  return false
}

/** Whether nodes are sorted by sort_order ascending (stable output contract). */
export function isStableNodeOrder(flow: ProjectFlow): boolean {
  for (let i = 1; i < flow.nodes.length; i++) {
    const a = flow.nodes[i - 1]
    const b = flow.nodes[i]
    if (a.sort_order > b.sort_order) return false
    if (a.sort_order === b.sort_order && a.node_id.localeCompare(b.node_id) > 0) {
      return false
    }
  }
  return true
}

/** Whether edges are sorted by sort_order then edge_id (stable output contract). */
export function isStableEdgeOrder(flow: ProjectFlow): boolean {
  for (let i = 1; i < flow.edges.length; i++) {
    const a = flow.edges[i - 1]
    const b = flow.edges[i]
    const ao = a.sort_order ?? 0
    const bo = b.sort_order ?? 0
    if (ao > bo) return false
    if (ao === bo && a.edge_id.localeCompare(b.edge_id) > 0) return false
  }
  return true
}
