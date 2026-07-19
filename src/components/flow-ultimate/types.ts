/** Flow ultimate — wire types for data-bundle + canvas nodes. */

export type FlowMode =
  | 'cross'
  | 'rn'
  | 'web-member'
  | 'panel-sales'
  | 'affiliate'
  | 'backend'

/** In-screen layer toggle (project mode). Cross always uses app_flow. */
export type FlowNavLayer = 'app_flow' | 'page_nav'

export type FlowStatusClass = 'ok' | 'warn' | 'bad'

export type FlowNodeKind =
  | 'journey_app'
  | 'journey_page'
  | 'inventory'
  /** @deprecated residual — treat as inventory if encountered */
  | 'feature'
  /** @deprecated residual — removed synthetic cross journey */
  | 'cross'

export interface FlowProjectRollup {
  terbukti: number
  sebagian: number
  belum: number
}

export interface FlowProjectMeta {
  id: string
  label: string
  repo?: string
  features?: number
  tasks?: number
  rollup?: FlowProjectRollup
  pct?: number
  status?: string
  generated_at?: string
}

export interface FlowFeature {
  id: string
  nama_id: string
  ringkasan_id?: string
  status: string
  pct?: number
  screens?: string[]
  doc_md?: string
  task_ids?: string[]
  rollup?: FlowProjectRollup
}

export interface FlowTask {
  id: string
  judul_id: string
  project?: string
  verdict?: string
}

export interface FlowApi {
  method: string
  path: string
  n?: number
  proj?: string
}

export interface FlowPremiumStep {
  n: number
  proj: string
  title: string
  kind?: string
  file?: string
  api?: string
  db?: string
  fields?: string[]
  st?: string
  feature_id?: string
  project?: string
}

// ---------------------------------------------------------------------------
// Semantic navigation wire (migration 011 app_flow + 012 page_nav)
// Two ID spaces never merged; materializer attaches; never invent edges.
// ---------------------------------------------------------------------------

/** Per-layer honesty codes (match server flow-semantic-edges). */
export type FlowSemanticLayerCode =
  | 'OK'
  | 'TABLES_MISSING'
  | 'EMPTY_ROWS'
  | 'PROJECTED_EMPTY'
  | 'DB_ERROR'

/**
 * Bundle-level semantic honesty for the attached nav block.
 * - OK: layers materialised without missing/error tables
 * - PARTIAL: one or more layers TABLES_MISSING / DB_ERROR (base may still be mysql)
 * - NO_SEMANTIC_SOURCE: file XOR path without authoritative file semantic data
 * - UNAVAILABLE: both mysql and file failed; empty skeleton
 */
export type FlowSemanticNavState =
  | 'OK'
  | 'PARTIAL'
  | 'NO_SEMANTIC_SOURCE'
  | 'UNAVAILABLE'

export type FlowSemanticNavSource = 'mysql' | 'file' | 'none'

export interface FlowSemanticLayerReason {
  code: string
  count: number
  samples: string[]
}

export interface FlowSemanticLayerMeta {
  layer: 'app_flow' | 'page_nav'
  code: FlowSemanticLayerCode
  tablesRequired: string[]
  tablesPresent: string[]
  rawNodeCount: number
  rawEdgeCount: number
  projectedNodeCount: number
  projectedEdgeCount: number
  droppedDangling: number
  droppedUnknownProject: number
  droppedDuplicate: number
  droppedCrossProject: number
  droppedInvalid: number
  reasons: FlowSemanticLayerReason[]
  detail?: string
}

/** Exact 011 node_id space (never rewritten). */
export interface FlowAppFlowSemanticNode {
  node_id: string
  project_id_storage: string
  project_id: string
  feature_id: string | null
  label_id: string
  kind: string
  sort_order: number
  layout_col: number
  layout_row: number
  source_ref: string | null
  provenance: 'app_flow_nodes'
}

/** Exact 011 edge; edge_class always `nav`. */
export interface FlowAppFlowSemanticEdge {
  edge_id: string
  from_node: string
  to_node: string
  edge_kind: string
  edge_class: 'nav'
  sort_order: number
  project_id_storage: string
  project_id: string
  provenance: 'app_flow_edges'
}

/** Exact 012 page id space (never rewritten). */
export interface FlowPageNavSemanticNode {
  page_id: string
  project_id_storage: string
  project_id: string
  label_id: string
  route: string
  area: string | null
  feature_id: string | null
  provenance: 'app_pages'
}

/** Exact 012 page edge; edge_class always `page_nav`. */
export interface FlowPageNavSemanticEdge {
  edge_id: string
  from_page: string
  to_page: string
  edge_kind: 'nav_to'
  edge_class: 'page_nav'
  sort_order: number
  project_id: string
  from_project_id_storage: string
  to_project_id_storage: string
  provenance: 'nav_edges'
}

export interface FlowSemanticProjectGraphs {
  project_id: string
  app_flow: {
    nodes: FlowAppFlowSemanticNode[]
    edges: FlowAppFlowSemanticEdge[]
  }
  page_nav: {
    nodes: FlowPageNavSemanticNode[]
    edges: FlowPageNavSemanticEdge[]
  }
}

/**
 * Semantic navigation truth on FlowDataBundle.
 * Namespaces: app_flow (edge_class=nav) vs page_nav (edge_class=page_nav).
 * Never a top-level flat `edges` invent key; never merge ID spaces.
 */
export interface FlowDataSemanticNav {
  version: 1
  source: FlowSemanticNavSource
  state: FlowSemanticNavState
  sourceHash: string
  boardId: string
  /** Always five UI project keys when materializer-produced. */
  by_project: Record<string, FlowSemanticProjectGraphs>
  layers: {
    app_flow: FlowSemanticLayerMeta
    page_nav: FlowSemanticLayerMeta
  }
  /** Explicit when state is NO_SEMANTIC_SOURCE or UNAVAILABLE. */
  reason?: string
}

export interface FlowDataBundle {
  projects: {
    version?: number
    generated_at?: string
    source?: string
    projects: FlowProjectMeta[]
  }
  premium: {
    name: string
    desc?: string
    steps: FlowPremiumStep[]
  }
  features: Record<string, FlowFeature[]>
  tasks_by_feature: Record<string, FlowTask[]>
  apis_by_feature: Record<string, FlowApi[]>
  premium_apis?: FlowApi[]
  /**
   * Semantic navigation (011 app_flow + 012 page_nav).
   * Always set by materializer / resolve. Legacy static fixtures may omit;
   * resolve attaches NO_SEMANTIC_SOURCE rather than inventing edges.
   */
  nav?: FlowDataSemanticNav
}

export interface FlowNodeSemanticRef {
  layer: FlowNavLayer
  exactId: string
  project: string
}

export interface FlowNode {
  id: string
  x: number
  y: number
  title: string
  meta: string
  status: string
  project?: string
  /** Soft feature link for sheet enrichment — never an edge endpoint. */
  featureId?: string | null
  step?: FlowPremiumStep & { flowTitle?: string }
  kind: FlowNodeKind
  flowTitle?: string
  apis?: string[]
  semanticRef?: FlowNodeSemanticRef
  /** Inventory badge for owner chrome. */
  inventoryBadge?: boolean
}

export interface FlowEdge {
  from: string
  to: string
  /** Runtime edge class from semantic wire only. Never `layout`. */
  edge_class?: 'nav' | 'page_nav'
  /** Prefixed client edge id for tests/debug. */
  id?: string
}

export interface FlowGraph {
  nodes: FlowNode[]
  edges: FlowEdge[]
}

export interface FlowTransform {
  x: number
  y: number
  scale: number
}

export const CARD_W = 200
export const CARD_H = 64
export const GAP_X = 72
export const GAP_Y = 36
export const DRAG_THRESHOLD = 5
/** Canon-compatible key; positions are namespaced by mode+layer + prefixed node ids. */
export const STORAGE_KEY = 'cairn-flow-pos-v1'

export const MODE_LABEL: Record<FlowMode, string> = {
  cross: 'Lintas Proyek',
  rn: 'React Native',
  'web-member': 'Web Member',
  'panel-sales': 'Panel Sales',
  affiliate: 'Afiliasi',
  backend: 'Backend',
}

export const LAYER_LABEL: Record<FlowNavLayer, string> = {
  app_flow: 'Alur aplikasi',
  page_nav: 'Navigasi laman',
}

export const PROJ_META: Record<
  string,
  { label: string; color: string; css: string }
> = {
  rn: { label: 'React Native', color: 'var(--proj-rn)', css: '#f472b6' },
  'web-member': { label: 'Web Member', color: 'var(--proj-web)', css: '#35c479' },
  web: { label: 'Web Member', color: 'var(--proj-web)', css: '#35c479' },
  'panel-sales': {
    label: 'Panel Sales',
    color: 'var(--proj-sales)',
    css: '#e5a54b',
  },
  sales: { label: 'Panel Sales', color: 'var(--proj-sales)', css: '#e5a54b' },
  affiliate: {
    label: 'Afiliasi',
    color: 'var(--proj-affiliate)',
    css: '#5b9dff',
  },
  backend: { label: 'Backend', color: 'var(--proj-backend)', css: '#a78bfa' },
}

export const FLOW_MODES: FlowMode[] = [
  'cross',
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
]

/** Stable project-row order for cross-mode layout. */
export const CROSS_PROJECT_ORDER: string[] = [
  'rn',
  'web-member',
  'panel-sales',
  'affiliate',
  'backend',
]
