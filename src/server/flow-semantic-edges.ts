/**
 * Flow semantic edge materializer (011 app-flow + 012 page-nav).
 *
 * Pure injectable bulk-query layer for later Alur wiring. No routes, no client,
 * no file fallback, no layout/feature/grid edge synthesis.
 *
 * Two honest ID spaces (never interchangeable):
 * - app_flow (migration 011): stored node_id / from_node / to_node
 * - page_nav (migration 012): stored page id / from_page / to_page
 *
 * Project aliases only are normalized via canon-flow-projects.
 * Node/page IDs are never rewritten. `cross` is never a data project.
 *
 * Server-only. Injectable SQL executor for offline unit tests.
 * Does not open a live DB; callers must inject an executor.
 */

import { createHash } from 'node:crypto'

import {
  CANON_UI_PROJECT_IDS,
  normalizeCanonProjectId,
  toAppFlowId,
  toPlatformKey,
  type CanonUiProjectId,
} from '#/lib/canon-flow-projects'

// ---------------------------------------------------------------------------
// Version / constants
// ---------------------------------------------------------------------------

export const SEMANTIC_EDGES_VERSION = 1 as const
export const DEFAULT_SEMANTIC_BOARD_ID = 'mfs-rebuild' as const

/** Bounded sample count in layer reason diagnostics. */
const REASON_SAMPLE_LIMIT = 8

const APP_FLOW_TABLES = ['app_flow_nodes', 'app_flow_edges'] as const
const PAGE_NAV_TABLES = ['app_pages', 'nav_edges'] as const
const PROBE_TABLES = [...APP_FLOW_TABLES, ...PAGE_NAV_TABLES] as const

// ---------------------------------------------------------------------------
// Executor (matches flow-data-materializer shape; local type to avoid coupling)
// ---------------------------------------------------------------------------

export type FlowSemanticSqlExecutor = {
  query(sql: string, params?: Array<unknown>): Promise<[unknown, unknown?]>
}

// ---------------------------------------------------------------------------
// Layer / edge vocabulary
// ---------------------------------------------------------------------------

export type SemanticLayerId = 'app_flow' | 'page_nav'

/**
 * Wire edge class. Never `layout`. Never invented journey sequences here.
 * - app_flow rows → `nav` (stored edge_kind preserved separately)
 * - page_nav rows → `page_nav`
 */
export type SemanticEdgeClass = 'nav' | 'page_nav'

export type SemanticLayerCode =
  | 'OK'
  | 'TABLES_MISSING'
  | 'EMPTY_ROWS'
  | 'PROJECTED_EMPTY'
  | 'DB_ERROR'

export type SemanticDropReasonCode =
  | 'DANGLING_ENDPOINT'
  | 'UNKNOWN_PROJECT'
  | 'CROSS_PROJECT_ENDPOINTS'
  | 'DUPLICATE_COLLAPSED'
  | 'INVALID_ROW'
  | 'FILTERED_PROJECT'

export type SemanticLayerReason = {
  code: SemanticDropReasonCode | string
  count: number
  /** Bounded samples for diagnosis (never credentials). */
  samples: string[]
}

export type SemanticLayerMeta = {
  layer: SemanticLayerId
  code: SemanticLayerCode
  tablesRequired: readonly string[]
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
  reasons: SemanticLayerReason[]
  detail?: string
}

// ---------------------------------------------------------------------------
// Row wire types — exact stored IDs preserved
// ---------------------------------------------------------------------------

export type AppFlowSemanticNode = {
  /** Exact stored node_id (011). Never rewritten. */
  node_id: string
  /** Exact stored project_id cell. */
  project_id_storage: string
  /** Canon UI project after alias normalize only. */
  project_id: CanonUiProjectId
  feature_id: string | null
  label_id: string
  kind: string
  sort_order: number
  layout_col: number
  layout_row: number
  source_ref: string | null
  provenance: 'app_flow_nodes'
}

export type AppFlowSemanticEdge = {
  /** Exact stored edge_id (011). */
  edge_id: string
  /** Exact stored from_node. */
  from_node: string
  /** Exact stored to_node. */
  to_node: string
  /** Exact stored edge_kind (default 'nav' in schema). */
  edge_kind: string
  edge_class: 'nav'
  sort_order: number
  project_id_storage: string
  project_id: CanonUiProjectId
  provenance: 'app_flow_edges'
}

export type PageNavSemanticNode = {
  /** Exact stored app_pages.id. */
  page_id: string
  project_id_storage: string
  project_id: CanonUiProjectId
  label_id: string
  route: string
  area: string | null
  feature_id: string | null
  provenance: 'app_pages'
}

export type PageNavSemanticEdge = {
  /**
   * Deterministic composite identity (012 has no edge_id column; PK is
   * (from_page, to_page)). Format: `${from_page}->${to_page}`.
   */
  edge_id: string
  /** Exact stored from_page. */
  from_page: string
  /** Exact stored to_page. */
  to_page: string
  edge_kind: 'nav_to'
  edge_class: 'page_nav'
  /** Stable lexicographic order rank within project (schema has no sort_order). */
  sort_order: number
  project_id: CanonUiProjectId
  /** from_page storage project (exact). */
  from_project_id_storage: string
  /** to_page storage project (exact). */
  to_project_id_storage: string
  provenance: 'nav_edges'
}

export type ProjectAppFlowGraph = {
  nodes: AppFlowSemanticNode[]
  edges: AppFlowSemanticEdge[]
}

export type ProjectPageNavGraph = {
  nodes: PageNavSemanticNode[]
  edges: PageNavSemanticEdge[]
}

export type ProjectSemanticGraphs = {
  project_id: CanonUiProjectId
  app_flow: ProjectAppFlowGraph
  page_nav: ProjectPageNavGraph
}

export type SemanticInputDiagnostic = {
  input: string
  code: string
  message: string
}

export type SemanticEdgesResult = {
  version: typeof SEMANTIC_EDGES_VERSION
  boardId: string
  generatedAt: string
  /**
   * Hash of semantic payload only (projects + layer codes/counts).
   * Independent of DB row order and generatedAt / queryCount.
   */
  sourceHash: string
  queryCount: number
  /**
   * Always keyed by the five UI project ids (never `cross`).
   * Unrequested / empty projects hold empty graphs.
   */
  by_project: Record<CanonUiProjectId, ProjectSemanticGraphs>
  layers: {
    app_flow: SemanticLayerMeta
    page_nav: SemanticLayerMeta
  }
  diagnostics: {
    requestedProjects: CanonUiProjectId[]
    unknownProjectAliases: string[]
    omittedInputs: SemanticInputDiagnostic[]
    /** True only when executor was injected (never claims live DB). */
    executorInjected: true
  }
}

export type MaterializeSemanticEdgesOpts = {
  executor: FlowSemanticSqlExecutor
  boardId?: string
  /**
   * Optional project alias filter (UI / app-flow / platform / MCP aliases).
   * Unknown aliases are omitted with diagnostics — never assigned to backend/cross.
   * `cross` is omitted as NOT_A_PROJECT.
   * When empty after filtering, all five projects are projected (full portfolio).
   */
  projectIds?: string[]
  /** Injected clock for generatedAt stability in tests. */
  now?: () => Date
}

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function sha256Hex(input: string | Buffer): string {
  return createHash('sha256').update(input).digest('hex')
}

/** Strip credential-like substrings from error/detail strings. */
export function redactSecrets(message: string): string {
  return message
    .replace(/(password|passwd|pwd)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(
      /(CAIRN_DB_PASSWORD|MYSQL_PWD|DATABASE_URL)\s*[=:]\s*\S+/gi,
      '$1=***',
    )
    .replace(/mysql:\/\/[^:\s]+:[^@\s]+@/gi, 'mysql://***:***@')
    .replace(/Access denied for user '[^']+'/gi, "Access denied for user '***'")
}

function asRows<T extends Record<string, unknown>>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : []
}

function str(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  return String(v)
}

function intOr(v: unknown, fallback: number): number {
  if (typeof v === 'number' && Number.isFinite(v)) return Math.trunc(v)
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v)
    if (Number.isFinite(n)) return Math.trunc(n)
  }
  return fallback
}

function emptyProjectGraphs(id: CanonUiProjectId): ProjectSemanticGraphs {
  return {
    project_id: id,
    app_flow: { nodes: [], edges: [] },
    page_nav: { nodes: [], edges: [] },
  }
}

function emptyByProject(): Record<CanonUiProjectId, ProjectSemanticGraphs> {
  return Object.fromEntries(
    CANON_UI_PROJECT_IDS.map((id) => [id, emptyProjectGraphs(id)]),
  ) as Record<CanonUiProjectId, ProjectSemanticGraphs>
}

type ReasonBucket = {
  count: number
  samples: string[]
}

function bumpReason(
  map: Map<string, ReasonBucket>,
  code: string,
  sample?: string,
): void {
  const cur = map.get(code) ?? { count: 0, samples: [] }
  cur.count++
  if (sample && cur.samples.length < REASON_SAMPLE_LIMIT) {
    cur.samples.push(sample)
  }
  map.set(code, cur)
}

function reasonsFrom(map: Map<string, ReasonBucket>): SemanticLayerReason[] {
  return [...map.entries()]
    .map(([code, b]) => ({
      code,
      count: b.count,
      samples: b.samples.slice(),
    }))
    .sort((a, b) => a.code.localeCompare(b.code))
}

function baseLayerMeta(
  layer: SemanticLayerId,
  tablesRequired: readonly string[],
  tablesPresent: string[],
): SemanticLayerMeta {
  return {
    layer,
    // Placeholder until probe/finalize; never leave as TABLES_MISSING by default
    // or finalizeLayerCode would short-circuit and never emit OK/EMPTY/PROJECTED.
    code: 'EMPTY_ROWS',
    tablesRequired: [...tablesRequired],
    tablesPresent: tablesPresent.filter((t) =>
      (tablesRequired as readonly string[]).includes(t),
    ),
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

/**
 * Storage project_id values that may appear in 011/012 for a set of UI projects.
 * Includes ui / appFlow / platform forms so filters remain honest without rewriting rows.
 */
export function storageProjectKeysForUi(
  uiIds: readonly CanonUiProjectId[],
): string[] {
  const keys = new Set<string>()
  for (const id of uiIds) {
    keys.add(id)
    keys.add(toAppFlowId(id))
    keys.add(toPlatformKey(id))
  }
  return [...keys].sort()
}

/**
 * Resolve caller project alias list → UI ids + diagnostics.
 * Unknown / cross / empty → omitted (never backend, never cross as data).
 */
export function resolveProjectFilter(inputs: string[] | undefined): {
  uiIds: CanonUiProjectId[]
  unknownProjectAliases: string[]
  omittedInputs: SemanticInputDiagnostic[]
} {
  const unknownProjectAliases: string[] = []
  const omittedInputs: SemanticInputDiagnostic[] = []
  const seen = new Set<CanonUiProjectId>()

  if (!inputs || inputs.length === 0) {
    return {
      uiIds: [...CANON_UI_PROJECT_IDS],
      unknownProjectAliases,
      omittedInputs,
    }
  }

  for (const raw of inputs) {
    const input = typeof raw === 'string' ? raw : String(raw ?? '')
    const r = normalizeCanonProjectId(input)
    if (r.ok) {
      seen.add(r.id)
      continue
    }
    omittedInputs.push({
      input,
      code: r.code,
      message: r.message,
    })
    if (r.code === 'UNKNOWN' || r.code === 'EMPTY' || r.code === 'INVALID_TYPE') {
      unknownProjectAliases.push(input)
    }
    // NOT_A_PROJECT (cross) is omitted without treating as unknown project alias list
    // but still recorded in omittedInputs; also surface in unknown for operator clarity when raw is 'cross'
    if (r.code === 'NOT_A_PROJECT') {
      // keep out of by_project; do not add to unknownProjectAliases as "unknown"
    }
  }

  const uiIds = CANON_UI_PROJECT_IDS.filter((id) => seen.has(id))
  // If every input was bad, project filter is empty → treat as projected-empty
  // for all projects (caller still gets five keys). Keep empty uiIds to signal filter miss.
  return { uiIds, unknownProjectAliases, omittedInputs }
}

function sortAppFlowNodes(nodes: AppFlowSemanticNode[]): AppFlowSemanticNode[] {
  return nodes.slice().sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.node_id.localeCompare(b.node_id)
  })
}

function sortAppFlowEdges(edges: AppFlowSemanticEdge[]): AppFlowSemanticEdge[] {
  return edges.slice().sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.edge_id.localeCompare(b.edge_id)
  })
}

function sortPageNodes(nodes: PageNavSemanticNode[]): PageNavSemanticNode[] {
  return nodes.slice().sort((a, b) => a.page_id.localeCompare(b.page_id))
}

function sortPageEdges(edges: PageNavSemanticEdge[]): PageNavSemanticEdge[] {
  return edges.slice().sort((a, b) => {
    if (a.sort_order !== b.sort_order) return a.sort_order - b.sort_order
    return a.edge_id.localeCompare(b.edge_id)
  })
}

/**
 * Hash payload: semantic content only.
 * Excludes generatedAt, queryCount, free-form detail strings that include timestamps.
 */
export function semanticEdgesHashPayload(
  by_project: Record<CanonUiProjectId, ProjectSemanticGraphs>,
  layers: SemanticEdgesResult['layers'],
  requestedProjects: CanonUiProjectId[],
): string {
  const projects: Record<string, unknown> = {}
  for (const id of CANON_UI_PROJECT_IDS) {
    const g = by_project[id]
    projects[id] = {
      app_flow: {
        nodes: g.app_flow.nodes.map((n) => ({
          node_id: n.node_id,
          project_id_storage: n.project_id_storage,
          project_id: n.project_id,
          feature_id: n.feature_id,
          label_id: n.label_id,
          kind: n.kind,
          sort_order: n.sort_order,
          layout_col: n.layout_col,
          layout_row: n.layout_row,
          source_ref: n.source_ref,
        })),
        edges: g.app_flow.edges.map((e) => ({
          edge_id: e.edge_id,
          from_node: e.from_node,
          to_node: e.to_node,
          edge_kind: e.edge_kind,
          edge_class: e.edge_class,
          sort_order: e.sort_order,
          project_id_storage: e.project_id_storage,
          project_id: e.project_id,
        })),
      },
      page_nav: {
        nodes: g.page_nav.nodes.map((n) => ({
          page_id: n.page_id,
          project_id_storage: n.project_id_storage,
          project_id: n.project_id,
          label_id: n.label_id,
          route: n.route,
          area: n.area,
          feature_id: n.feature_id,
        })),
        edges: g.page_nav.edges.map((e) => ({
          edge_id: e.edge_id,
          from_page: e.from_page,
          to_page: e.to_page,
          edge_kind: e.edge_kind,
          edge_class: e.edge_class,
          sort_order: e.sort_order,
          project_id: e.project_id,
          from_project_id_storage: e.from_project_id_storage,
          to_project_id_storage: e.to_project_id_storage,
        })),
      },
    }
  }
  return stableStringify({
    version: SEMANTIC_EDGES_VERSION,
    requestedProjects: [...requestedProjects],
    projects,
    layers: {
      app_flow: {
        code: layers.app_flow.code,
        rawNodeCount: layers.app_flow.rawNodeCount,
        rawEdgeCount: layers.app_flow.rawEdgeCount,
        projectedNodeCount: layers.app_flow.projectedNodeCount,
        projectedEdgeCount: layers.app_flow.projectedEdgeCount,
        droppedDangling: layers.app_flow.droppedDangling,
        droppedUnknownProject: layers.app_flow.droppedUnknownProject,
        droppedDuplicate: layers.app_flow.droppedDuplicate,
        droppedCrossProject: layers.app_flow.droppedCrossProject,
      },
      page_nav: {
        code: layers.page_nav.code,
        rawNodeCount: layers.page_nav.rawNodeCount,
        rawEdgeCount: layers.page_nav.rawEdgeCount,
        projectedNodeCount: layers.page_nav.projectedNodeCount,
        projectedEdgeCount: layers.page_nav.projectedEdgeCount,
        droppedDangling: layers.page_nav.droppedDangling,
        droppedUnknownProject: layers.page_nav.droppedUnknownProject,
        droppedDuplicate: layers.page_nav.droppedDuplicate,
        droppedCrossProject: layers.page_nav.droppedCrossProject,
      },
    },
  })
}

export function hashSemanticEdges(
  by_project: Record<CanonUiProjectId, ProjectSemanticGraphs>,
  layers: SemanticEdgesResult['layers'],
  requestedProjects: CanonUiProjectId[],
): string {
  return sha256Hex(
    semanticEdgesHashPayload(by_project, layers, requestedProjects),
  )
}

// ---------------------------------------------------------------------------
// Internal materialize helpers
// ---------------------------------------------------------------------------

type ProbeResult = {
  tablesPresent: string[]
  tables: Set<string>
  queryCount: number
}

async function probeTables(
  exec: FlowSemanticSqlExecutor,
  queryCount: { n: number },
): Promise<ProbeResult> {
  queryCount.n++
  const [rows] = await exec.query(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${PROBE_TABLES.map(() => '?').join(',')})`,
    [...PROBE_TABLES],
  )
  const tablesPresent = asRows<{ name: string }>(rows)
    .map((r) => str(r.name))
    .filter(Boolean)
    .sort()
  return {
    tablesPresent,
    tables: new Set(tablesPresent),
    queryCount: queryCount.n,
  }
}

type AppFlowRawNode = {
  project_id: string
  node_id: string
  feature_id?: string | null
  label_id?: string | null
  kind?: string | null
  sort_order?: number | string | null
  layout_col?: number | string | null
  layout_row?: number | string | null
  source_ref?: string | null
}

type AppFlowRawEdge = {
  project_id: string
  edge_id: string
  from_node: string
  to_node: string
  edge_kind?: string | null
  sort_order?: number | string | null
}

type PageRaw = {
  id: string
  project_id: string
  label_id?: string | null
  route?: string | null
  area?: string | null
  feature_id?: string | null
}

type NavRaw = {
  from_page: string
  to_page: string
}

/**
 * Collapse duplicate app-flow edges by (project_id_storage, edge_id).
 * Contract: keep the row with lowest sort_order, then lowest edge_id (identity
 * already equal), after input is pre-sorted. Distinct edge_ids with the same
 * endpoints are preserved.
 */
function collapseAppFlowEdges(
  edges: AppFlowSemanticEdge[],
  reasonMap: Map<string, ReasonBucket>,
): { edges: AppFlowSemanticEdge[]; droppedDuplicate: number } {
  const sorted = sortAppFlowEdges(edges)
  const map = new Map<string, AppFlowSemanticEdge>()
  let droppedDuplicate = 0
  for (const e of sorted) {
    const key = `${e.project_id_storage}\0${e.edge_id}`
    if (map.has(key)) {
      droppedDuplicate++
      bumpReason(
        reasonMap,
        'DUPLICATE_COLLAPSED',
        `${e.project_id_storage}/${e.edge_id}`,
      )
      continue
    }
    map.set(key, e)
  }
  return { edges: sortAppFlowEdges([...map.values()]), droppedDuplicate }
}

/**
 * Collapse page-nav edges by (from_page, to_page) — matches 012 PK.
 */
function collapsePageEdges(
  edges: PageNavSemanticEdge[],
  reasonMap: Map<string, ReasonBucket>,
): { edges: PageNavSemanticEdge[]; droppedDuplicate: number } {
  const sorted = sortPageEdges(edges)
  const map = new Map<string, PageNavSemanticEdge>()
  let droppedDuplicate = 0
  for (const e of sorted) {
    const key = `${e.from_page}\0${e.to_page}`
    if (map.has(key)) {
      droppedDuplicate++
      bumpReason(
        reasonMap,
        'DUPLICATE_COLLAPSED',
        `${e.from_page}->${e.to_page}`,
      )
      continue
    }
    map.set(key, e)
  }
  return { edges: sortPageEdges([...map.values()]), droppedDuplicate }
}

function finalizeLayerCode(
  meta: SemanticLayerMeta,
  requestedEmpty: boolean,
): SemanticLayerMeta {
  // Terminal codes set by callers must stick.
  if (meta.code === 'DB_ERROR' || meta.code === 'TABLES_MISSING') {
    return meta
  }
  if (requestedEmpty) {
    // Invalid/empty project filter: host may still have rows.
    if (meta.rawNodeCount === 0 && meta.rawEdgeCount === 0) {
      return { ...meta, code: 'EMPTY_ROWS' }
    }
    return { ...meta, code: 'PROJECTED_EMPTY' }
  }
  if (meta.rawNodeCount === 0 && meta.rawEdgeCount === 0) {
    return { ...meta, code: 'EMPTY_ROWS' }
  }
  if (meta.projectedNodeCount === 0 && meta.projectedEdgeCount === 0) {
    // Rows existed but none survived projection/filter/dangles
    return { ...meta, code: 'PROJECTED_EMPTY' }
  }
  return { ...meta, code: 'OK' }
}

async function materializeAppFlowLayer(
  exec: FlowSemanticSqlExecutor,
  tables: Set<string>,
  tablesPresent: string[],
  requested: CanonUiProjectId[],
  queryCount: { n: number },
): Promise<{
  meta: SemanticLayerMeta
  by_project: Record<CanonUiProjectId, ProjectAppFlowGraph>
}> {
  const by_project = Object.fromEntries(
    CANON_UI_PROJECT_IDS.map((id) => [id, { nodes: [] as AppFlowSemanticNode[], edges: [] as AppFlowSemanticEdge[] }]),
  ) as Record<CanonUiProjectId, ProjectAppFlowGraph>

  let meta = baseLayerMeta('app_flow', APP_FLOW_TABLES, tablesPresent)
  const reasonMap = new Map<string, ReasonBucket>()
  const requestedSet = new Set(requested)
  const requestedEmpty = requested.length === 0

  const hasNodes = tables.has('app_flow_nodes')
  const hasEdges = tables.has('app_flow_edges')
  if (!hasNodes || !hasEdges) {
    meta.code = 'TABLES_MISSING'
    meta.detail = !hasNodes && !hasEdges
      ? 'missing app_flow_nodes and app_flow_edges'
      : !hasNodes
        ? 'missing app_flow_nodes'
        : 'missing app_flow_edges'
    meta.reasons = reasonsFrom(reasonMap)
    return { meta, by_project }
  }

  try {
    // Bulk SELECT both tables (fixed 2 queries — never N+1).
    // Optional parameterized project filter when caller requested a subset;
    // full portfolio uses unfiltered SELECT so raw EMPTY_ROWS is honest.
    const fullPortfolio =
      !requestedEmpty &&
      requested.length === CANON_UI_PROJECT_IDS.length &&
      CANON_UI_PROJECT_IDS.every((id) => requestedSet.has(id))

    const storageKeys = storageProjectKeysForUi(
      requestedEmpty ? [] : requested,
    )

    let nodeRows: AppFlowRawNode[]
    let edgeRows: AppFlowRawEdge[]

    if (requestedEmpty) {
      // All aliases invalid — do not invent; COUNT for EMPTY vs PROJECTED.
      queryCount.n++
      const [nc] = await exec.query(
        'SELECT COUNT(*) AS n FROM app_flow_nodes',
      )
      queryCount.n++
      const [ec] = await exec.query(
        'SELECT COUNT(*) AS n FROM app_flow_edges',
      )
      meta.rawNodeCount = intOr(asRows<{ n: unknown }>(nc)[0]?.n, 0)
      meta.rawEdgeCount = intOr(asRows<{ n: unknown }>(ec)[0]?.n, 0)
      meta = finalizeLayerCode(meta, true)
      meta.reasons = reasonsFrom(reasonMap)
      return { meta, by_project }
    }

    if (fullPortfolio || storageKeys.length === 0) {
      queryCount.n++
      const [nRaw] = await exec.query(
        `SELECT project_id, node_id, feature_id, label_id, kind,
                sort_order, layout_col, layout_row, source_ref
         FROM app_flow_nodes`,
      )
      nodeRows = asRows<AppFlowRawNode>(nRaw)

      queryCount.n++
      const [eRaw] = await exec.query(
        `SELECT project_id, edge_id, from_node, to_node, edge_kind, sort_order
         FROM app_flow_edges`,
      )
      edgeRows = asRows<AppFlowRawEdge>(eRaw)
    } else {
      // Parameterized project filter (storage alias forms for requested UI ids).
      const placeholders = storageKeys.map(() => '?').join(',')
      queryCount.n++
      const [nRaw] = await exec.query(
        `SELECT project_id, node_id, feature_id, label_id, kind,
                sort_order, layout_col, layout_row, source_ref
         FROM app_flow_nodes
         WHERE project_id IN (${placeholders})`,
        storageKeys,
      )
      nodeRows = asRows<AppFlowRawNode>(nRaw)

      queryCount.n++
      const [eRaw] = await exec.query(
        `SELECT project_id, edge_id, from_node, to_node, edge_kind, sort_order
         FROM app_flow_edges
         WHERE project_id IN (${placeholders})`,
        storageKeys,
      )
      edgeRows = asRows<AppFlowRawEdge>(eRaw)

      // Distinguish host-empty vs filter miss when filtered bulk is empty.
      if (nodeRows.length === 0 && edgeRows.length === 0) {
        queryCount.n++
        const [nc] = await exec.query(
          'SELECT COUNT(*) AS n FROM app_flow_nodes',
        )
        queryCount.n++
        const [ec] = await exec.query(
          'SELECT COUNT(*) AS n FROM app_flow_edges',
        )
        meta.rawNodeCount = intOr(asRows<{ n: unknown }>(nc)[0]?.n, 0)
        meta.rawEdgeCount = intOr(asRows<{ n: unknown }>(ec)[0]?.n, 0)
        meta = finalizeLayerCode(meta, false)
        meta.reasons = reasonsFrom(reasonMap)
        return { meta, by_project }
      }
    }

    meta.rawNodeCount = nodeRows.length
    meta.rawEdgeCount = edgeRows.length

    // Endpoint sets keyed by storage project_id (exact 011 PK scope).
    // Edges only connect nodes that exist under the same stored project_id.
    const nodesByUi = new Map<CanonUiProjectId, AppFlowSemanticNode[]>()
    const nodeIdsByStorage = new Map<string, Set<string>>()
    for (const id of CANON_UI_PROJECT_IDS) {
      nodesByUi.set(id, [])
    }

    const nodeSeen = new Set<string>()
    for (const row of nodeRows) {
      const node_id = str(row.node_id).trim()
      const project_id_storage = str(row.project_id).trim()
      if (!node_id || !project_id_storage) {
        meta.droppedInvalid++
        bumpReason(reasonMap, 'INVALID_ROW', 'node:missing-id')
        continue
      }
      const norm = normalizeCanonProjectId(project_id_storage)
      if (!norm.ok) {
        meta.droppedUnknownProject++
        bumpReason(
          reasonMap,
          'UNKNOWN_PROJECT',
          `node:${project_id_storage}/${node_id}`,
        )
        continue
      }
      if (!requestedSet.has(norm.id)) {
        bumpReason(
          reasonMap,
          'FILTERED_PROJECT',
          `node:${project_id_storage}/${node_id}`,
        )
        continue
      }
      const dedupeKey = `${project_id_storage}\0${node_id}`
      if (nodeSeen.has(dedupeKey)) {
        meta.droppedDuplicate++
        bumpReason(
          reasonMap,
          'DUPLICATE_COLLAPSED',
          `node:${project_id_storage}/${node_id}`,
        )
        continue
      }
      nodeSeen.add(dedupeKey)
      const node: AppFlowSemanticNode = {
        node_id,
        project_id_storage,
        project_id: norm.id,
        feature_id:
          row.feature_id == null || row.feature_id === ''
            ? null
            : str(row.feature_id),
        label_id: str(row.label_id, node_id),
        kind: str(row.kind, 'screen') || 'screen',
        sort_order: intOr(row.sort_order, 0),
        layout_col: intOr(row.layout_col, 0),
        layout_row: intOr(row.layout_row, 0),
        source_ref:
          row.source_ref == null || row.source_ref === ''
            ? null
            : str(row.source_ref),
        provenance: 'app_flow_nodes',
      }
      nodesByUi.get(norm.id)!.push(node)
      let set = nodeIdsByStorage.get(project_id_storage)
      if (!set) {
        set = new Set()
        nodeIdsByStorage.set(project_id_storage, set)
      }
      set.add(node_id)
    }

    const rawEdges: AppFlowSemanticEdge[] = []
    for (const row of edgeRows) {
      const edge_id = str(row.edge_id).trim()
      const from_node = str(row.from_node).trim()
      const to_node = str(row.to_node).trim()
      const project_id_storage = str(row.project_id).trim()
      if (!edge_id || !from_node || !to_node || !project_id_storage) {
        meta.droppedInvalid++
        bumpReason(reasonMap, 'INVALID_ROW', `edge:${edge_id || '?'}`)
        continue
      }
      const norm = normalizeCanonProjectId(project_id_storage)
      if (!norm.ok) {
        meta.droppedUnknownProject++
        bumpReason(
          reasonMap,
          'UNKNOWN_PROJECT',
          `edge:${project_id_storage}/${edge_id}`,
        )
        continue
      }
      if (!requestedSet.has(norm.id)) {
        bumpReason(
          reasonMap,
          'FILTERED_PROJECT',
          `edge:${project_id_storage}/${edge_id}`,
        )
        continue
      }
      const ids = nodeIdsByStorage.get(project_id_storage)
      if (!ids || !ids.has(from_node) || !ids.has(to_node)) {
        meta.droppedDangling++
        bumpReason(
          reasonMap,
          'DANGLING_ENDPOINT',
          `${project_id_storage}/${edge_id}:${from_node}->${to_node}`,
        )
        continue
      }
      rawEdges.push({
        edge_id,
        from_node,
        to_node,
        edge_kind: str(row.edge_kind, 'nav') || 'nav',
        edge_class: 'nav',
        sort_order: intOr(row.sort_order, 0),
        project_id_storage,
        project_id: norm.id,
        provenance: 'app_flow_edges',
      })
    }

    const collapsed = collapseAppFlowEdges(rawEdges, reasonMap)
    meta.droppedDuplicate += collapsed.droppedDuplicate

    for (const id of CANON_UI_PROJECT_IDS) {
      const nodes = sortAppFlowNodes(nodesByUi.get(id) ?? [])
      const edges = sortAppFlowEdges(
        collapsed.edges.filter((e) => e.project_id === id),
      )
      by_project[id] = { nodes, edges }
      meta.projectedNodeCount += nodes.length
      meta.projectedEdgeCount += edges.length
    }

    meta.reasons = reasonsFrom(reasonMap)
    meta = finalizeLayerCode(meta, false)
    return { meta, by_project }
  } catch (err) {
    const msg = redactSecrets(
      err instanceof Error ? err.message : String(err),
    )
    meta.code = 'DB_ERROR'
    meta.detail = msg
    meta.reasons = reasonsFrom(reasonMap)
    return { meta, by_project: Object.fromEntries(
      CANON_UI_PROJECT_IDS.map((id) => [
        id,
        { nodes: [] as AppFlowSemanticNode[], edges: [] as AppFlowSemanticEdge[] },
      ]),
    ) as Record<CanonUiProjectId, ProjectAppFlowGraph> }
  }
}

async function materializePageNavLayer(
  exec: FlowSemanticSqlExecutor,
  tables: Set<string>,
  tablesPresent: string[],
  requested: CanonUiProjectId[],
  queryCount: { n: number },
): Promise<{
  meta: SemanticLayerMeta
  by_project: Record<CanonUiProjectId, ProjectPageNavGraph>
}> {
  const by_project = Object.fromEntries(
    CANON_UI_PROJECT_IDS.map((id) => [
      id,
      { nodes: [] as PageNavSemanticNode[], edges: [] as PageNavSemanticEdge[] },
    ]),
  ) as Record<CanonUiProjectId, ProjectPageNavGraph>

  let meta = baseLayerMeta('page_nav', PAGE_NAV_TABLES, tablesPresent)
  const reasonMap = new Map<string, ReasonBucket>()
  const requestedSet = new Set(requested)
  const requestedEmpty = requested.length === 0

  const hasPages = tables.has('app_pages')
  const hasNav = tables.has('nav_edges')
  if (!hasPages || !hasNav) {
    meta.code = 'TABLES_MISSING'
    meta.detail = !hasPages && !hasNav
      ? 'missing app_pages and nav_edges'
      : !hasPages
        ? 'missing app_pages'
        : 'missing nav_edges'
    meta.reasons = reasonsFrom(reasonMap)
    return { meta, by_project }
  }

  try {
    if (requestedEmpty) {
      queryCount.n++
      const [nc] = await exec.query('SELECT COUNT(*) AS n FROM app_pages')
      queryCount.n++
      const [ec] = await exec.query('SELECT COUNT(*) AS n FROM nav_edges')
      meta.rawNodeCount = intOr(asRows<{ n: unknown }>(nc)[0]?.n, 0)
      meta.rawEdgeCount = intOr(asRows<{ n: unknown }>(ec)[0]?.n, 0)
      meta = finalizeLayerCode(meta, true)
      meta.reasons = reasonsFrom(reasonMap)
      return { meta, by_project }
    }

    // Bulk load all pages + all nav edges (bounded 2 queries).
    // Project filter applied in memory so cross-page endpoint checks see full
    // page index within the layer (dangling detection is layer-global).
    queryCount.n++
    const [pRaw] = await exec.query(
      `SELECT id, project_id, label_id, route, area, feature_id
       FROM app_pages`,
    )
    const pageRows = asRows<PageRaw>(pRaw)

    queryCount.n++
    const [nRaw] = await exec.query(
      `SELECT from_page, to_page FROM nav_edges`,
    )
    const navRows = asRows<NavRaw>(nRaw)

    meta.rawNodeCount = pageRows.length
    meta.rawEdgeCount = navRows.length

    // Full page index for dangling checks (all pages in layer, any project).
    const pageById = new Map<string, PageNavSemanticNode>()
    const pageProjectUi = new Map<string, CanonUiProjectId | null>()

    for (const row of pageRows) {
      const page_id = str(row.id).trim()
      const project_id_storage = str(row.project_id).trim()
      if (!page_id || !project_id_storage) {
        meta.droppedInvalid++
        bumpReason(reasonMap, 'INVALID_ROW', 'page:missing-id')
        continue
      }
      const norm = normalizeCanonProjectId(project_id_storage)
      if (!norm.ok) {
        meta.droppedUnknownProject++
        pageProjectUi.set(page_id, null)
        bumpReason(
          reasonMap,
          'UNKNOWN_PROJECT',
          `page:${project_id_storage}/${page_id}`,
        )
        continue
      }
      const node: PageNavSemanticNode = {
        page_id,
        project_id_storage,
        project_id: norm.id,
        label_id: str(row.label_id, page_id),
        route: str(row.route, ''),
        area: row.area == null || row.area === '' ? null : str(row.area),
        feature_id:
          row.feature_id == null || row.feature_id === ''
            ? null
            : str(row.feature_id),
        provenance: 'app_pages',
      }
      // Collapse duplicate page ids (PK is id) — first wins after we will sort
      if (pageById.has(page_id)) {
        meta.droppedDuplicate++
        bumpReason(reasonMap, 'DUPLICATE_COLLAPSED', `page:${page_id}`)
        continue
      }
      pageById.set(page_id, node)
      pageProjectUi.set(page_id, norm.id)
    }

    // Project nodes into requested projects only
    for (const node of pageById.values()) {
      if (!requestedSet.has(node.project_id)) continue
      by_project[node.project_id].nodes.push(node)
    }

    const rawEdges: PageNavSemanticEdge[] = []
    for (const row of navRows) {
      const from_page = str(row.from_page).trim()
      const to_page = str(row.to_page).trim()
      if (!from_page || !to_page) {
        meta.droppedInvalid++
        bumpReason(reasonMap, 'INVALID_ROW', 'nav:missing-endpoint')
        continue
      }
      const fromNode = pageById.get(from_page)
      const toNode = pageById.get(to_page)
      if (!fromNode || !toNode) {
        meta.droppedDangling++
        bumpReason(
          reasonMap,
          'DANGLING_ENDPOINT',
          `${from_page}->${to_page}`,
        )
        continue
      }
      // Same-project only: cross-project page edges are reported, not forced
      // into backend/cross. Distinct ID-space honesty.
      if (fromNode.project_id !== toNode.project_id) {
        meta.droppedCrossProject++
        bumpReason(
          reasonMap,
          'CROSS_PROJECT_ENDPOINTS',
          `${from_page}->${to_page}`,
        )
        continue
      }
      if (!requestedSet.has(fromNode.project_id)) {
        bumpReason(
          reasonMap,
          'FILTERED_PROJECT',
          `${from_page}->${to_page}`,
        )
        continue
      }
      rawEdges.push({
        edge_id: `${from_page}->${to_page}`,
        from_page,
        to_page,
        edge_kind: 'nav_to',
        edge_class: 'page_nav',
        sort_order: 0, // filled after sort
        project_id: fromNode.project_id,
        from_project_id_storage: fromNode.project_id_storage,
        to_project_id_storage: toNode.project_id_storage,
        provenance: 'nav_edges',
      })
    }

    const collapsed = collapsePageEdges(rawEdges, reasonMap)
    meta.droppedDuplicate += collapsed.droppedDuplicate

    // Assign stable sort_order by lexicographic edge_id within each project
    for (const id of CANON_UI_PROJECT_IDS) {
      const edges = collapsed.edges
        .filter((e) => e.project_id === id)
        .slice()
        .sort((a, b) => a.edge_id.localeCompare(b.edge_id))
        .map((e, idx) => ({ ...e, sort_order: idx }))
      const nodes = sortPageNodes(by_project[id].nodes)
      by_project[id] = { nodes, edges }
      meta.projectedNodeCount += nodes.length
      meta.projectedEdgeCount += edges.length
    }

    meta.reasons = reasonsFrom(reasonMap)
    meta = finalizeLayerCode(meta, false)
    return { meta, by_project }
  } catch (err) {
    const msg = redactSecrets(
      err instanceof Error ? err.message : String(err),
    )
    meta.code = 'DB_ERROR'
    meta.detail = msg
    meta.reasons = reasonsFrom(reasonMap)
    return {
      meta,
      by_project: Object.fromEntries(
        CANON_UI_PROJECT_IDS.map((id) => [
          id,
          {
            nodes: [] as PageNavSemanticNode[],
            edges: [] as PageNavSemanticEdge[],
          },
        ]),
      ) as Record<CanonUiProjectId, ProjectPageNavGraph>,
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Materialize semantic navigation edges from MySQL 011 + 012 tables.
 *
 * - Layers are independent: one may be OK while the other is TABLES_MISSING.
 * - No file fallback, no layout synthesis, no live default pool.
 * - Node/page IDs preserved exactly; only project aliases normalized.
 * - `cross` never appears under by_project.
 */
export async function materializeSemanticEdges(
  opts: MaterializeSemanticEdgesOpts,
): Promise<SemanticEdgesResult> {
  if (!opts?.executor || typeof opts.executor.query !== 'function') {
    throw new Error(
      'materializeSemanticEdges requires an injected executor (no live DB default)',
    )
  }

  const boardId =
    (opts.boardId ?? DEFAULT_SEMANTIC_BOARD_ID).trim() ||
    DEFAULT_SEMANTIC_BOARD_ID
  const now = opts.now ?? (() => new Date())
  const generatedAt = now().toISOString()
  const queryCount = { n: 0 }

  const {
    uiIds: requestedProjects,
    unknownProjectAliases,
    omittedInputs,
  } = resolveProjectFilter(opts.projectIds)

  const by_project = emptyByProject()

  let tablesPresent: string[] = []
  let tables = new Set<string>()

  let appMeta = baseLayerMeta('app_flow', APP_FLOW_TABLES, [])
  let pageMeta = baseLayerMeta('page_nav', PAGE_NAV_TABLES, [])

  try {
    const probe = await probeTables(opts.executor, queryCount)
    tablesPresent = probe.tablesPresent
    tables = probe.tables
  } catch (err) {
    const msg = redactSecrets(
      err instanceof Error ? err.message : String(err),
    )
    appMeta = {
      ...appMeta,
      code: 'DB_ERROR',
      detail: msg,
      tablesPresent: [],
    }
    pageMeta = {
      ...pageMeta,
      code: 'DB_ERROR',
      detail: msg,
      tablesPresent: [],
    }
    const layers = { app_flow: appMeta, page_nav: pageMeta }
    const sourceHash = hashSemanticEdges(
      by_project,
      layers,
      requestedProjects,
    )
    return {
      version: SEMANTIC_EDGES_VERSION,
      boardId,
      generatedAt,
      sourceHash,
      queryCount: queryCount.n,
      by_project,
      layers,
      diagnostics: {
        requestedProjects,
        unknownProjectAliases,
        omittedInputs,
        executorInjected: true,
      },
    }
  }

  // Independent layers — failures do not merge/fail the whole result.
  const app = await materializeAppFlowLayer(
    opts.executor,
    tables,
    tablesPresent,
    requestedProjects,
    queryCount,
  )
  const page = await materializePageNavLayer(
    opts.executor,
    tables,
    tablesPresent,
    requestedProjects,
    queryCount,
  )

  for (const id of CANON_UI_PROJECT_IDS) {
    by_project[id] = {
      project_id: id,
      app_flow: app.by_project[id],
      page_nav: page.by_project[id],
    }
  }

  // Guard: never serialize cross as a data project
  const keys = Object.keys(by_project)
  if (keys.includes('cross')) {
    // Defensive — should be unreachable
    delete (by_project as Record<string, unknown>).cross
  }

  const layers = { app_flow: app.meta, page_nav: page.meta }
  const sourceHash = hashSemanticEdges(
    by_project,
    layers,
    requestedProjects,
  )

  return {
    version: SEMANTIC_EDGES_VERSION,
    boardId,
    generatedAt,
    sourceHash,
    queryCount: queryCount.n,
    by_project,
    layers,
    diagnostics: {
      requestedProjects,
      unknownProjectAliases,
      omittedInputs,
      executorInjected: true,
    },
  }
}

/**
 * Assert result never contains layout-class edges or a cross project key.
 * Pure check for tests / integrators.
 */
export function assertNoLayoutOrCross(
  result: SemanticEdgesResult,
): { ok: true } | { ok: false; violations: string[] } {
  const violations: string[] = []
  if ('cross' in result.by_project) {
    violations.push('by_project contains cross')
  }
  for (const id of CANON_UI_PROJECT_IDS) {
    const g = result.by_project[id]
    for (const e of g.app_flow.edges) {
      if ((e.edge_class as string) === 'layout') {
        violations.push(`layout edge in app_flow ${id}/${e.edge_id}`)
      }
    }
    for (const e of g.page_nav.edges) {
      if ((e.edge_class as string) === 'layout') {
        violations.push(`layout edge in page_nav ${id}/${e.edge_id}`)
      }
    }
  }
  return violations.length === 0 ? { ok: true } : { ok: false, violations }
}
