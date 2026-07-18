/**
 * Product knowledge MCP tools — complete Task Manager knowledge for agents.
 *
 * Goal: one-shot answers for product questions ("period tracker", "/premium")
 * from real TM data (features, pages, endpoints, tasks, flows, units).
 *
 * Data sources (read-only):
 *  1. MySQL tables when present (010 product_features + feature_task_map,
 *     011 app_flow_nodes/edges, 012 app_pages/api_endpoints/page_api_calls/
 *     nav_edges/knowledge_aliases; plus feature_directory/units if present).
 *  2. Fallback: deployed public/flow-data (data-bundle.json + graph.json)
 *     which ships with the app — never an absolute VPS job path.
 *
 * Tool names (contract):
 *   search_knowledge, get_feature_bundle, get_endpoint_bundle, get_flow
 *
 * Auth: all four tools are authenticated MCP reads (board:read), same as
 * search_knowledge in MCP_TOOL_SPECS. Registration MUST go through board-mcp
 * secureTool (isToolListable + authorizeToolCall) — never bare server.registerTool.
 * Handlers are pure corpus functions — they never call HTTP endpoints or attach
 * Authorization headers.
 *
 * Pure handlers are unit-testable with an injected corpus (no live DB required).
 */

import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { z } from 'zod'

// ---------------------------------------------------------------------------
// Paths & constants
// ---------------------------------------------------------------------------

/** Relative path that ships in the deploy artifact (under app root). */
export const DEPLOYED_FLOW_DATA_REL = join('public', 'flow-data')

/** Vite preview / built client copy of the same corpus. */
const DIST_CLIENT_FLOW_DATA_REL = join('dist', 'client', 'flow-data')
const CLIENT_FLOW_DATA_REL = join('client', 'flow-data')

/**
 * App-root candidates that do not depend solely on process.cwd().
 * Vite preview pm2 cwd is usually the app dir, but SSR bundles may evaluate
 * from dist/server/* — walk from this module URL as well.
 */
function knowledgeAppRootCandidates(): string[] {
  const roots = new Set<string>()
  const add = (p: string | null | undefined) => {
    if (p && p.trim()) roots.add(p)
  }
  add(process.cwd())
  add(join(process.cwd(), 'task-manager'))
  add(join(process.cwd(), '..'))
  try {
    // knowledge-tools.ts lives at src/server/ or dist/server/assets/
    const here = dirname(fileURLToPath(import.meta.url))
    add(join(here, '..', '..')) // src/server → repo root; dist/server → dist parent (app)
    add(join(here, '..', '..', '..')) // dist/server/assets → app root
    add(join(here, '..')) // dist/server → dist
    add(join(here, '..', '..', '..', '..')) // deeper nested chunk layouts
  } catch {
    // non-ESM / test harness without import.meta.url — cwd candidates only
  }
  return [...roots]
}

function flowDataCandidatesUnder(root: string): string[] {
  return [
    join(root, DEPLOYED_FLOW_DATA_REL),
    join(root, DIST_CLIENT_FLOW_DATA_REL),
    join(root, CLIENT_FLOW_DATA_REL),
    join(root, 'flow-data'),
  ]
}

function isFlowDataDir(dir: string): boolean {
  return (
    existsSync(join(dir, 'data-bundle.json')) ||
    existsSync(join(dir, 'graph.json')) ||
    existsSync(join(dir, 'knowledge.json'))
  )
}

/**
 * Resolve the offline knowledge corpus directory.
 * Priority: explicit arg → TM_KNOWLEDGE_BUNDLE_PATH → public/flow-data (and
 * dist/client/flow-data) under cwd + import.meta-relative app roots.
 * Never defaults to absolute /home/user/.claude/... job paths (absent on prod).
 */
export function resolveKnowledgeBundlePath(override?: string): string {
  const env = (override ?? process.env.TM_KNOWLEDGE_BUNDLE_PATH)?.trim()
  if (env) {
    // Refuse known non-deploy job paths even if env is set incorrectly on prod.
    if (/\/home\/user\/\.claude\//.test(env) || /tm-wave0/.test(env)) {
      // fall through to deployed path
    } else {
      return env
    }
  }
  const candidates: string[] = []
  for (const root of knowledgeAppRootCandidates()) {
    candidates.push(...flowDataCandidatesUnder(root))
  }
  for (const c of candidates) {
    if (isFlowDataDir(c)) return c
  }
  // Stable default even when files are not yet present (tests may inject corpus).
  return join(process.cwd(), DEPLOYED_FLOW_DATA_REL)
}

/**
 * Default offline corpus directory (deployed public/flow-data).
 * Overridable via TM_KNOWLEDGE_BUNDLE_PATH. Prefer resolveKnowledgeBundlePath()
 * at call time — this constant is a snapshot at first module evaluation.
 */
export const DEFAULT_KNOWLEDGE_BUNDLE_PATH = resolveKnowledgeBundlePath()

/**
 * Auth semantics for product-knowledge tools — same class as search_knowledge
 * (authenticated board:read). Live tools/call also needs matching MCP_TOOL_SPECS
 * entries in rbac; handlers themselves never re-auth or proxy HTTP.
 */
export const KNOWLEDGE_TOOL_AUTH_SPECS = [
  { name: 'search_knowledge', kind: 'read' as const, scopes: ['board:read'] as const },
  { name: 'get_feature_bundle', kind: 'read' as const, scopes: ['board:read'] as const },
  { name: 'get_endpoint_bundle', kind: 'read' as const, scopes: ['board:read'] as const },
  { name: 'get_flow', kind: 'read' as const, scopes: ['board:read'] as const },
] as const

export const KNOWLEDGE_TOOL_NAMES = [
  'search_knowledge',
  'get_feature_bundle',
  'get_endpoint_bundle',
  'get_flow',
] as const

export type KnowledgeToolName = (typeof KNOWLEDGE_TOOL_NAMES)[number]

/** Built-in EN ↔ ID aliases for common product queries. */
export const KNOWLEDGE_ALIASES: ReadonlyArray<{ en: string; id: string; terms: string[] }> = [
  {
    en: 'period tracker',
    id: 'pelacak haid',
    terms: [
      'period tracker',
      'period',
      'menstrual',
      'menstruasi',
      'pelacak haid',
      'siklus haid',
      'haid',
      'periodtracker',
      'feat-siklus-haid',
    ],
  },
  {
    en: 'premium',
    id: 'premium',
    terms: ['premium', '/premium', 'paywall', 'langganan', 'subscription', 'anggota premium'],
  },
  {
    en: 'fit tracker',
    id: 'pelacak kebugaran',
    terms: ['fit tracker', 'pelacak kebugaran', 'fittracker', 'langkah', 'steps'],
  },
  {
    en: 'fasting',
    id: 'puasa intermiten',
    terms: ['fasting', 'puasa', 'intermittent', 'puasa intermiten'],
  },
  {
    en: 'meditation',
    id: 'meditasi',
    terms: ['meditation', 'meditasi', 'napas', 'breath'],
  },
  {
    en: 'checkout',
    id: 'checkout web',
    terms: ['checkout', 'pembayaran web', 'cms-checkout'],
  },
  {
    en: 'affiliate',
    id: 'afiliasi',
    terms: ['affiliate', 'afiliasi', 'referral', 'mitra'],
  },
]

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type KnowledgeSourceKind = 'mysql' | 'json_bundle' | 'injected'

export type KnowledgeSourceNote = {
  kind: KnowledgeSourceKind
  detail: string
  tablesPresent?: string[]
  bundlePath?: string
}

export type KnowledgeFeature = {
  id: string
  nama_id: string
  area?: string
  domain_bisnis?: string
  ringkasan_id?: string | null
  doc_md?: string | null
  screens?: string[]
  status?: string
  delivery_status?: string
  platform?: Record<string, unknown>
  task_ids?: string[]
  unit_count?: Record<string, unknown>
  rollup?: Record<string, unknown>
  fc_refs?: string[]
  curated?: boolean
  project_ids?: string[]
}

export type KnowledgePage = {
  id: string
  label_id: string
  route_or_screen: string
  api_calls: Array<{ method: string; path: string }>
  nav_to?: string[]
  area?: string
  feature_id?: string | null
  source_file?: string
}

export type KnowledgeEndpoint = {
  id: string
  method: string
  path: string
  domain_id?: string
  label_id?: string
  controller?: string
  repo?: string
}

export type KnowledgeTask = {
  id: string
  judul_id?: string
  verdict?: string
  feature_id?: string | null
  acceptance?: unknown
  evidence?: unknown
  lifecycle_stage?: string
  task_class?: string
  disposition?: string
  project_id?: string
}

export type KnowledgeUnit = {
  unit_id: string
  feature_contract_id?: string | null
  unit_type?: string | null
  identifier?: string | null
  anchor?: string | null
  notes?: string | null
  coverage_status?: string | null
  repo?: string | null
}

export type KnowledgeFlowNode = {
  id: string
  label_id?: string
  feature_id?: string | null
  kind?: string
  status?: string
  sort_order?: number
  layout_col?: number
  layout_row?: number
  source_ref?: string | null
  meta?: Record<string, unknown>
}

export type KnowledgeFlowEdge = {
  id: string
  from: string
  to: string
  kind?: string
  sort_order?: number
  meta?: Record<string, unknown>
}

export type KnowledgeFlow = {
  id: string
  project_id?: string
  name?: string
  desc?: string
  kind: 'project' | 'lintas'
  nodes: KnowledgeFlowNode[]
  edges: KnowledgeFlowEdge[]
  steps?: unknown[]
  stats?: Record<string, unknown>
  source?: string
}

export type KnowledgeCorpus = {
  features: KnowledgeFeature[]
  pages: KnowledgePage[]
  endpoints: KnowledgeEndpoint[]
  tasks: KnowledgeTask[]
  units: KnowledgeUnit[]
  flows: KnowledgeFlow[]
  source: KnowledgeSourceNote
}

export type KnowledgeHitType = 'feature' | 'page' | 'endpoint' | 'task' | 'alias' | 'unit' | 'flow'

export type KnowledgeHit = {
  type: KnowledgeHitType
  id: string
  label: string
  score: number
  snippet?: string
  match?: string
  meta?: Record<string, unknown>
}

export type SearchKnowledgeResult = {
  ok: true
  query: string
  expandedTerms: string[]
  hits: KnowledgeHit[]
  source: KnowledgeSourceNote
  /** True when hits come from a non-empty product corpus (json_bundle/mysql/injected). */
  searchReal: boolean
}

export type FeatureBundleResult = {
  ok: true
  feature: KnowledgeFeature
  pages: KnowledgePage[]
  endpoints: KnowledgeEndpoint[]
  tasks: Array<KnowledgeTask & { verdict?: string }>
  units: KnowledgeUnit[]
  related_features: Array<Pick<KnowledgeFeature, 'id' | 'nama_id' | 'area' | 'ringkasan_id'>>
  source: KnowledgeSourceNote
}

export type EndpointBundleResult = {
  ok: true
  endpoint: KnowledgeEndpoint
  callers: KnowledgePage[]
  features: Array<Pick<KnowledgeFeature, 'id' | 'nama_id' | 'area' | 'ringkasan_id'>>
  domain: string | null
  source: KnowledgeSourceNote
}

export type FlowResult = {
  ok: true
  flow: KnowledgeFlow
  source: KnowledgeSourceNote
}

export type KnowledgeErrorResult = {
  ok: false
  tool: string
  code: string
  error: string
  source?: KnowledgeSourceNote
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function norm(s: string): string {
  return s
    .toLowerCase()
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/[_/.-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

function readJsonFile(path: string): unknown {
  if (!existsSync(path)) return null
  return safeJsonParse(readFileSync(path, 'utf8'))
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : []
}

function asRecord(v: unknown): Record<string, unknown> | null {
  return v && typeof v === 'object' && !Array.isArray(v) ? (v as Record<string, unknown>) : null
}

function str(v: unknown): string {
  return typeof v === 'string' ? v : v == null ? '' : String(v)
}

function snippetAround(hay: string, needle: string, radius = 80): string | undefined {
  const h = hay.toLowerCase()
  const n = needle.toLowerCase()
  const i = h.indexOf(n)
  if (i < 0) return hay.slice(0, radius * 2).trim() || undefined
  const start = Math.max(0, i - radius)
  const end = Math.min(hay.length, i + needle.length + radius)
  return `${start > 0 ? '…' : ''}${hay.slice(start, end).trim()}${end < hay.length ? '…' : ''}`
}

function scoreText(query: string, terms: string[], fields: Array<{ text: string; weight: number }>): {
  score: number
  match?: string
  snippet?: string
} {
  const q = norm(query)
  const allTerms = [q, ...terms.map(norm)].filter(Boolean)
  let best = 0
  let match: string | undefined
  let snippet: string | undefined

  for (const field of fields) {
    const t = field.text
    if (!t) continue
    const nt = norm(t)
    // Empty after norm (e.g. path "/") must not match via startsWith('')
    if (!nt) continue
    for (const term of allTerms) {
      if (!term) continue
      let s = 0
      if (nt === term) s = 100 * field.weight
      else if (nt.startsWith(term) || (term.length >= 3 && term.startsWith(nt) && nt.length >= 3))
        s = 85 * field.weight
      else if (nt.includes(term)) s = 70 * field.weight
      else {
        // token overlap
        const qTokens = term.split(' ').filter((x) => x.length > 2)
        if (qTokens.length > 0) {
          const hits = qTokens.filter((tok) => nt.includes(tok)).length
          if (hits > 0) s = (45 + (hits / qTokens.length) * 25) * field.weight
        }
      }
      if (s > best) {
        best = s
        match = term
        snippet = snippetAround(t, term.split(' ')[0] ?? term)
      }
    }
  }
  return { score: best, match, snippet }
}

/** Expand query with EN↔ID alias terms. */
export function expandQueryTerms(query: string): string[] {
  const q = norm(query)
  const out = new Set<string>([q, query.trim().toLowerCase()])
  for (const alias of KNOWLEDGE_ALIASES) {
    const aliasTerms = alias.terms.map(norm)
    if (aliasTerms.some((t) => q.includes(t) || t.includes(q) || q === t)) {
      for (const t of alias.terms) out.add(norm(t))
      out.add(norm(alias.en))
      out.add(norm(alias.id))
    }
  }
  // also drop leading slash for routes
  if (q.startsWith(' ')) out.add(q)
  const stripped = q.replace(/^\//, '')
  if (stripped !== q) out.add(stripped)
  return [...out].filter(Boolean)
}

// ---------------------------------------------------------------------------
// JSON / flow-data corpus loaders (deployed files only — no external job paths)
// ---------------------------------------------------------------------------

/**
 * Load corpus from deployed public/flow-data shape:
 *   data-bundle.json — features, tasks_by_feature, apis_by_feature, premium flow
 *   graph.json       — pages, endpoints, nav/api_call edges
 *   knowledge.json   — optional prebuilt corpus override (same KnowledgeCorpus shape)
 */
function loadFromFlowDataDir(dir: string): KnowledgeCorpus {
  const knowledgePath = join(dir, 'knowledge.json')
  if (existsSync(knowledgePath)) {
    const prebuilt = loadFromKnowledgeJsonFile(knowledgePath, dir)
    if (prebuilt.features.length > 0 || prebuilt.pages.length > 0) {
      return prebuilt
    }
  }

  const bundleRaw = readJsonFile(join(dir, 'data-bundle.json'))
  const graphRaw = readJsonFile(join(dir, 'graph.json'))
  const bundle = asRecord(bundleRaw) ?? {}
  const graph = asRecord(graphRaw) ?? {}

  const byId = new Map<string, KnowledgeFeature>()

  // Features from data-bundle.features.{project}[]
  const featuresByProject = asRecord(bundle.features) ?? {}
  for (const [projectId, list] of Object.entries(featuresByProject)) {
    for (const item of asArray(list)) {
      const f = asRecord(item)
      if (!f) continue
      const id = str(f.id)
      if (!id) continue
      const prev = byId.get(id)
      const screens = asArray(f.screens).map(str).filter(Boolean)
      const taskIds = asArray(f.task_ids).map(str).filter(Boolean)
      byId.set(id, {
        id,
        nama_id: str(f.nama_id) || str(f.label) || prev?.nama_id || id,
        area: str(f.area) || prev?.area,
        domain_bisnis: str(f.domain_bisnis) || prev?.domain_bisnis || str(f.area) || undefined,
        ringkasan_id: str(f.ringkasan_id) || prev?.ringkasan_id || null,
        doc_md: str(f.doc_md) || prev?.doc_md || null,
        screens: [...new Set([...(prev?.screens ?? []), ...screens])],
        status: str(f.status) || prev?.status,
        delivery_status: str(f.delivery_status) || prev?.delivery_status,
        platform: (asRecord(f.platform) as Record<string, unknown> | null) ?? prev?.platform,
        task_ids: [...new Set([...(prev?.task_ids ?? []), ...taskIds])],
        unit_count: (asRecord(f.unit_count) as Record<string, unknown> | null) ?? prev?.unit_count,
        rollup: (asRecord(f.rollup) as Record<string, unknown> | null) ?? prev?.rollup,
        fc_refs: prev?.fc_refs,
        curated: Boolean(f.curated ?? prev?.curated),
        project_ids: [...new Set([...(prev?.project_ids ?? []), projectId])],
      })
    }
  }

  // Enrich from graph feature nodes (area / ringkasan / status)
  for (const item of asArray(graph.nodes)) {
    const n = asRecord(item)
    if (!n || str(n.kind) !== 'feature') continue
    const id = str(n.id)
    if (!id) continue
    const prev = byId.get(id)
    const projects = asArray(n.projects).map(str).filter(Boolean)
    if (prev) {
      prev.area = prev.area || str(n.area) || undefined
      prev.domain_bisnis = prev.domain_bisnis || str(n.area) || undefined
      prev.ringkasan_id = prev.ringkasan_id || str(n.ringkasan_id) || null
      prev.status = prev.status || str(n.status) || undefined
      prev.nama_id = prev.nama_id || str(n.label_id) || str(n.label) || id
      prev.project_ids = [...new Set([...(prev.project_ids ?? []), ...projects])]
    } else {
      byId.set(id, {
        id,
        nama_id: str(n.label_id) || str(n.label) || id,
        area: str(n.area) || undefined,
        domain_bisnis: str(n.area) || undefined,
        ringkasan_id: str(n.ringkasan_id) || null,
        status: str(n.status) || undefined,
        screens: [],
        task_ids: [],
        project_ids: projects,
      })
    }
  }

  // Tasks from tasks_by_feature
  const tasks: KnowledgeTask[] = []
  const tasksByFeature = asRecord(bundle.tasks_by_feature) ?? {}
  for (const [featureId, list] of Object.entries(tasksByFeature)) {
    for (const item of asArray(list)) {
      const t = asRecord(item)
      if (!t) continue
      const id = str(t.id)
      if (!id) continue
      tasks.push({
        id,
        judul_id: str(t.judul_id) || undefined,
        verdict: str(t.verdict) || undefined,
        feature_id: featureId,
        project_id: str(t.project) || undefined,
      })
      const feat = byId.get(featureId)
      if (feat) {
        feat.task_ids = [...new Set([...(feat.task_ids ?? []), id])]
      }
    }
  }

  // Pages + endpoints from graph nodes; wire api_calls + nav_to from edges
  const apiCallsByPage = new Map<string, Array<{ method: string; path: string }>>()
  const navByPage = new Map<string, string[]>()
  for (const item of asArray(graph.edges)) {
    const e = asRecord(item)
    if (!e) continue
    const kind = str(e.kind)
    const from = str(e.from)
    const to = str(e.to)
    if (!from) continue
    if (kind === 'api_call') {
      const method = str(e.method) || 'GET'
      const path = str(e.path_norm) || str(e.path_raw) || str(e.path)
      if (!path) continue
      const list = apiCallsByPage.get(from) ?? []
      list.push({ method, path })
      apiCallsByPage.set(from, list)
    } else if (kind === 'nav_to' && to) {
      const list = navByPage.get(from) ?? []
      list.push(to)
      navByPage.set(from, list)
    } else if (kind === 'page_feature' && to) {
      // Prefer graph page_feature mapping when page.feature_id is missing/wrong later
      void to
    }
  }

  // page → feature from page_feature edges (overrides noisy feature_id on nodes when useful)
  const pageFeatureFromEdge = new Map<string, string>()
  for (const item of asArray(graph.edges)) {
    const e = asRecord(item)
    if (!e || str(e.kind) !== 'page_feature') continue
    const from = str(e.from)
    const to = str(e.to)
    if (from && to) pageFeatureFromEdge.set(from, to)
  }

  // Also map screens → feature for correct page attachment (graph page.feature_id is often wrong)
  const screenToFeature = new Map<string, string>()
  for (const feat of byId.values()) {
    for (const s of feat.screens ?? []) {
      const key = norm(s)
      if (key && !screenToFeature.has(key)) screenToFeature.set(key, feat.id)
    }
  }

  const pages: KnowledgePage[] = []
  const endpoints: KnowledgeEndpoint[] = []
  for (const item of asArray(graph.nodes)) {
    const n = asRecord(item)
    if (!n) continue
    const kind = str(n.kind)
    if (kind === 'page') {
      const id = str(n.id)
      if (!id) continue
      const route = str(n.route_or_screen)
      let featureId =
        n.feature_id == null || n.feature_id === ''
          ? null
          : str(n.feature_id)
      // Prefer screen→feature when screens list owns this route (fixes mis-tagged graph nodes)
      const byScreen = route ? screenToFeature.get(norm(route)) : undefined
      if (byScreen) featureId = byScreen
      else if (!featureId && pageFeatureFromEdge.has(id)) {
        featureId = pageFeatureFromEdge.get(id) ?? null
      }
      // Dedupe api calls
      const rawCalls = apiCallsByPage.get(id) ?? []
      const seenCall = new Set<string>()
      const api_calls: Array<{ method: string; path: string }> = []
      for (const c of rawCalls) {
        const k = `${c.method.toUpperCase()} ${c.path}`
        if (seenCall.has(k)) continue
        seenCall.add(k)
        api_calls.push({ method: c.method.toUpperCase(), path: c.path })
      }
      pages.push({
        id,
        label_id: str(n.label_id) || str(n.label) || route || id,
        route_or_screen: route,
        api_calls,
        nav_to: navByPage.get(id),
        area: str(n.area) || undefined,
        feature_id: featureId,
        source_file: 'graph.json',
      })
    } else if (kind === 'endpoint') {
      const method = str(n.method) || 'GET'
      const path = str(n.path)
      if (!path) continue
      endpoints.push({
        id: str(n.id) || `${method} ${path}`,
        method: method.toUpperCase(),
        path,
        domain_id: str(n.domain_id) || undefined,
        label_id: str(n.label_id) || str(n.label) || undefined,
        controller: str(n.controller) || undefined,
        repo: str(n.repo) || undefined,
      })
    }
  }

  // Supplement endpoints from apis_by_feature when graph is thin for a feature
  const apisByFeature = asRecord(bundle.apis_by_feature) ?? {}
  const epKey = new Set(endpoints.map((e) => `${e.method.toUpperCase()} ${e.path}`))
  for (const [featureId, list] of Object.entries(apisByFeature)) {
    for (const item of asArray(list)) {
      const a = asRecord(item)
      if (!a) continue
      const method = (str(a.method) || 'GET').toUpperCase()
      const path = str(a.path)
      if (!path) continue
      const k = `${method} ${path}`
      if (epKey.has(k)) continue
      epKey.add(k)
      endpoints.push({
        id: str(a.id) || `${method} ${path}`,
        method,
        path,
        domain_id: str(a.domain_id) || featureId,
        label_id: str(a.label_id) || undefined,
        repo: str(a.repo) || undefined,
      })
    }
  }

  // Flows: one project flow per project id (pages as nodes, nav edges)
  const flows: KnowledgeFlow[] = []
  const projectIds = new Set<string>()
  const projectsWrap = asRecord(bundle.projects)
  for (const p of asArray(projectsWrap?.projects)) {
    const r = asRecord(p)
    if (r) projectIds.add(str(r.id))
  }
  const pageById = new Map(pages.map((p) => [p.id, p]))
  const pagesByProject = new Map<string, KnowledgePage[]>()
  for (const item of asArray(graph.nodes)) {
    const n = asRecord(item)
    if (!n || str(n.kind) !== 'page') continue
    const proj = str(n.project) || 'unknown'
    projectIds.add(proj)
    const page = pageById.get(str(n.id))
    if (!page) continue
    const list = pagesByProject.get(proj) ?? []
    list.push(page)
    pagesByProject.set(proj, list)
  }
  for (const proj of projectIds) {
    if (!proj || proj === 'unknown') continue
    const projPages = pagesByProject.get(proj) ?? []
    const nodeIds = new Set(projPages.map((p) => p.id))
    const nodes: KnowledgeFlowNode[] = projPages.map((p, i) => ({
      id: p.id,
      label_id: p.label_id,
      feature_id: p.feature_id,
      kind: 'screen',
      sort_order: i,
      source_ref: p.route_or_screen,
    }))
    const edges: KnowledgeFlowEdge[] = []
    let ei = 0
    for (const item of asArray(graph.edges)) {
      const e = asRecord(item)
      if (!e || str(e.kind) !== 'nav_to') continue
      const from = str(e.from)
      const to = str(e.to)
      if (!nodeIds.has(from) || !nodeIds.has(to)) continue
      edges.push({
        id: str(e.id) || `${from}__${to}`,
        from,
        to,
        kind: 'nav',
        sort_order: ei++,
      })
    }
    if (nodes.length > 0) {
      flows.push({
        id: proj,
        project_id: proj,
        kind: 'project',
        nodes,
        edges,
        source: 'graph.json',
      })
    }
  }

  // Premium / lintas flow from data-bundle.premium
  const premium = asRecord(bundle.premium)
  if (premium && Array.isArray(premium.steps)) {
    const steps = asArray(premium.steps)
    const nodes: KnowledgeFlowNode[] = steps.map((s, i) => {
      const r = asRecord(s) ?? {}
      const id = `step-${str(r.n) || i + 1}`
      return {
        id,
        label_id: str(r.title) || id,
        kind: str(r.kind) || 'step',
        sort_order: typeof r.n === 'number' ? r.n : i + 1,
        meta: {
          proj: r.proj,
          api: r.api,
          db: r.db,
          file: r.file,
          fields: r.fields,
          st: r.st,
        },
      }
    })
    const edges: KnowledgeFlowEdge[] = []
    for (let i = 0; i < nodes.length - 1; i++) {
      edges.push({
        id: `${nodes[i]!.id}__${nodes[i + 1]!.id}`,
        from: nodes[i]!.id,
        to: nodes[i + 1]!.id,
        kind: 'sequence',
        sort_order: i,
      })
    }
    flows.push({
      id: 'premium',
      name: str(premium.name) || 'Pembelian Premium (lintas-sistem)',
      desc: str(premium.desc) || undefined,
      kind: 'lintas',
      nodes,
      edges,
      steps,
      source: 'data-bundle.json#premium',
    })
  }

  // Units: optional from knowledge.json only (none in bare flow-data)
  const units: KnowledgeUnit[] = []

  const hasData =
    byId.size > 0 || pages.length > 0 || endpoints.length > 0 || tasks.length > 0
  return {
    features: [...byId.values()],
    pages,
    endpoints,
    tasks,
    units,
    flows,
    source: {
      kind: 'json_bundle',
      detail: hasData
        ? `deployed flow-data at ${dir} (data-bundle.json + graph.json)`
        : `flow-data present but empty at ${dir}`,
      bundlePath: dir,
    },
  }
}

function loadFromKnowledgeJsonFile(path: string, dir: string): KnowledgeCorpus {
  const raw = readJsonFile(path)
  const rec = asRecord(raw)
  if (!rec) {
    return emptyCorpus(dir, `knowledge.json unreadable at ${path}`)
  }
  // Accept either { features, pages, ... } or { corpus: { ... } }
  const body = asRecord(rec.corpus) ?? rec
  const features: KnowledgeFeature[] = []
  for (const item of asArray(body.features)) {
    const f = asRecord(item)
    if (!f || !str(f.id)) continue
    features.push({
      id: str(f.id),
      nama_id: str(f.nama_id) || str(f.id),
      area: str(f.area) || undefined,
      domain_bisnis: str(f.domain_bisnis) || undefined,
      ringkasan_id: f.ringkasan_id == null ? null : str(f.ringkasan_id),
      doc_md: f.doc_md == null ? null : str(f.doc_md),
      screens: asArray(f.screens).map(str).filter(Boolean),
      status: str(f.status) || undefined,
      task_ids: asArray(f.task_ids).map(str).filter(Boolean),
      project_ids: asArray(f.project_ids).map(str).filter(Boolean),
      fc_refs: asArray(f.fc_refs).map(str).filter(Boolean),
    })
  }
  const pages: KnowledgePage[] = []
  for (const item of asArray(body.pages)) {
    const p = asRecord(item)
    if (!p || !str(p.id)) continue
    const api_calls: Array<{ method: string; path: string }> = []
    for (const c of asArray(p.api_calls)) {
      const r = asRecord(c)
      if (!r) continue
      const path = str(r.path)
      if (!path) continue
      api_calls.push({ method: str(r.method) || 'GET', path })
    }
    const page: KnowledgePage = {
      id: str(p.id),
      label_id: str(p.label_id),
      route_or_screen: str(p.route_or_screen),
      api_calls,
      nav_to: asArray(p.nav_to).map(str),
      area: str(p.area) || undefined,
      feature_id: p.feature_id == null ? null : str(p.feature_id),
      source_file: 'knowledge.json',
    }
    pages.push(page)
  }

  const endpoints: KnowledgeEndpoint[] = []
  for (const item of asArray(body.endpoints)) {
    const e = asRecord(item)
    if (!e) continue
    const method = str(e.method) || 'GET'
    const path = str(e.path)
    if (!path) continue
    endpoints.push({
      id: str(e.id) || `${method} ${path}`,
      method,
      path,
      domain_id: str(e.domain_id) || undefined,
      label_id: str(e.label_id) || undefined,
      controller: str(e.controller) || undefined,
      repo: str(e.repo) || undefined,
    })
  }

  const tasks: KnowledgeTask[] = []
  for (const item of asArray(body.tasks)) {
    const t = asRecord(item)
    if (!t || !str(t.id)) continue
    tasks.push({
      id: str(t.id),
      judul_id: str(t.judul_id) || undefined,
      verdict: str(t.verdict) || undefined,
      feature_id: t.feature_id == null ? null : str(t.feature_id),
      project_id: str(t.project_id) || undefined,
    })
  }

  const units: KnowledgeUnit[] = []
  for (const item of asArray(body.units)) {
    const u = asRecord(item)
    if (!u || !str(u.unit_id)) continue
    units.push({
      unit_id: str(u.unit_id),
      feature_contract_id: u.feature_contract_id == null ? null : str(u.feature_contract_id),
      unit_type: u.unit_type == null ? null : str(u.unit_type),
      identifier: u.identifier == null ? null : str(u.identifier),
      anchor: u.anchor == null ? null : str(u.anchor),
      notes: u.notes == null ? null : str(u.notes),
      coverage_status: u.coverage_status == null ? null : str(u.coverage_status),
      repo: u.repo == null ? null : str(u.repo),
    })
  }

  const flows: KnowledgeFlow[] = []
  for (const item of asArray(body.flows)) {
    const f = asRecord(item)
    if (!f || !str(f.id)) continue
    flows.push({
      id: str(f.id),
      project_id: str(f.project_id) || undefined,
      name: str(f.name) || undefined,
      desc: str(f.desc) || undefined,
      kind: str(f.kind) === 'lintas' ? 'lintas' : 'project',
      nodes: asArray(f.nodes).map((n, i) => {
        const r = asRecord(n) ?? {}
        return {
          id: str(r.id) || `n-${i}`,
          label_id: str(r.label_id) || str(r.id) || `n-${i}`,
          feature_id: r.feature_id == null ? null : str(r.feature_id),
          kind: str(r.kind) || 'screen',
          sort_order: typeof r.sort_order === 'number' ? r.sort_order : i,
        }
      }),
      edges: asArray(f.edges).map((e, i) => {
        const r = asRecord(e) ?? {}
        return {
          id: str(r.id) || `e-${i}`,
          from: str(r.from),
          to: str(r.to),
          kind: str(r.kind) || 'nav',
          sort_order: typeof r.sort_order === 'number' ? r.sort_order : i,
        }
      }),
      source: 'knowledge.json',
    })
  }

  return {
    features,
    pages,
    endpoints,
    tasks,
    units,
    flows,
    source: {
      kind: 'json_bundle',
      detail: `knowledge.json at ${path}`,
      bundlePath: dir,
    },
  }
}

function emptyCorpus(bundlePath: string, detail: string): KnowledgeCorpus {
  return {
    features: [],
    pages: [],
    endpoints: [],
    tasks: [],
    units: [],
    flows: [],
    source: { kind: 'json_bundle', detail, bundlePath },
  }
}

/** Legacy multi-file DESIGN-CANON layout (features-*.json) — no hardcoded absolute path. */
function loadFromLegacyMultiFileDir(dir: string): KnowledgeCorpus {
  const byId = new Map<string, KnowledgeFeature>()
  let featureFiles = 0
  try {
    featureFiles = readdirSync(dir).filter((f) => f.startsWith('features-') && f.endsWith('.json')).length
  } catch {
    return emptyCorpus(dir, `cannot read dir: ${dir}`)
  }
  if (featureFiles === 0) {
    return emptyCorpus(dir, `no flow-data or legacy features-*.json at ${dir}`)
  }

  for (const file of readdirSync(dir).filter((f) => f.startsWith('features-') && f.endsWith('.json'))) {
    const raw = readJsonFile(join(dir, file))
    const rec = asRecord(raw)
    const projectId = str(rec?.project_id) || file.replace(/^features-/, '').replace(/\.json$/, '')
    for (const item of asArray(rec?.features)) {
      const f = asRecord(item)
      if (!f) continue
      const id = str(f.id)
      if (!id) continue
      const prev = byId.get(id)
      const screens = asArray(f.screens).map(str).filter(Boolean)
      const taskIds = asArray(f.task_ids).map(str).filter(Boolean)
      byId.set(id, {
        id,
        nama_id: str(f.nama_id) || prev?.nama_id || id,
        area: str(f.area) || prev?.area,
        domain_bisnis: str(f.domain_bisnis) || prev?.domain_bisnis || str(f.area) || undefined,
        ringkasan_id: str(f.ringkasan_id) || prev?.ringkasan_id || null,
        doc_md: str(f.doc_md) || prev?.doc_md || null,
        screens: [...new Set([...(prev?.screens ?? []), ...screens])],
        status: str(f.status) || prev?.status,
        task_ids: [...new Set([...(prev?.task_ids ?? []), ...taskIds])],
        project_ids: [...new Set([...(prev?.project_ids ?? []), projectId])],
      })
    }
  }

  const pages: KnowledgePage[] = []
  const ultimate = join(dir, 'ultimate')
  if (existsSync(ultimate)) {
    for (const file of readdirSync(ultimate).filter(
      (f) => f.startsWith('pages-') && f.endsWith('.json') && !f.endsWith('.meta.json'),
    )) {
      for (const item of asArray(readJsonFile(join(ultimate, file)))) {
        const p = asRecord(item)
        if (!p) continue
        pages.push({
          id: str(p.id),
          label_id: str(p.label_id),
          route_or_screen: str(p.route_or_screen),
          api_calls: asArray(p.api_calls)
            .map((c) => {
              const r = asRecord(c)
              if (!r) return null
              return { method: str(r.method) || 'GET', path: str(r.path) }
            })
            .filter((x): x is { method: string; path: string } => !!x && !!x.path),
          nav_to: asArray(p.nav_to).map(str),
          area: str(p.area) || undefined,
          feature_id: p.feature_id == null ? null : str(p.feature_id),
          source_file: file,
        })
      }
    }
  }

  const endpoints: KnowledgeEndpoint[] = []
  for (const item of asArray(readJsonFile(join(dir, 'ultimate', 'backend-endpoints.json')))) {
    const e = asRecord(item)
    if (!e) continue
    const method = str(e.method) || 'GET'
    const path = str(e.path)
    if (!path) continue
    endpoints.push({
      id: str(e.id) || `${method} ${path}`,
      method,
      path,
      domain_id: str(e.domain_id) || undefined,
      label_id: str(e.label_id) || undefined,
      controller: str(e.controller) || undefined,
      repo: str(e.repo) || undefined,
    })
  }

  const tasks: KnowledgeTask[] = []
  for (const file of readdirSync(dir).filter((f) => f.startsWith('tasks-') && f.endsWith('.json'))) {
    const raw = readJsonFile(join(dir, file))
    const rec = asRecord(raw)
    const projectId = str(rec?.project_id) || file.replace(/^tasks-/, '').replace(/\.json$/, '')
    for (const item of asArray(rec?.tasks)) {
      const t = asRecord(item)
      if (!t) continue
      const id = str(t.id)
      if (!id) continue
      tasks.push({
        id,
        judul_id: str(t.judul_id) || undefined,
        verdict: str(t.verdict) || undefined,
        feature_id: t.feature_id == null ? null : str(t.feature_id),
        project_id: projectId,
      })
    }
  }

  const units: KnowledgeUnit[] = []
  for (const item of asArray(readJsonFile(join(dir, '_raw', 'feature_units.json')))) {
    const u = asRecord(item)
    if (!u || !str(u.unit_id)) continue
    units.push({
      unit_id: str(u.unit_id),
      feature_contract_id: u.feature_contract_id == null ? null : str(u.feature_contract_id),
      unit_type: u.unit_type == null ? null : str(u.unit_type),
      identifier: u.identifier == null ? null : str(u.identifier),
      anchor: u.anchor == null ? null : str(u.anchor),
      notes: u.notes == null ? null : str(u.notes),
      coverage_status: u.coverage_status == null ? null : str(u.coverage_status),
      repo: u.repo == null ? null : str(u.repo),
    })
  }

  const flows: KnowledgeFlow[] = []
  for (const file of readdirSync(dir).filter((f) => f.startsWith('flow-') && f.endsWith('.json'))) {
    const raw = readJsonFile(join(dir, file))
    const rec = asRecord(raw)
    if (!rec) continue
    const baseId = file.replace(/^flow-/, '').replace(/\.json$/, '')
    if (Array.isArray(rec.nodes) && Array.isArray(rec.edges)) {
      flows.push({
        id: baseId,
        project_id: str(rec.project_id) || baseId,
        kind: 'project',
        nodes: asArray(rec.nodes).map((n, i) => {
          const r = asRecord(n) ?? {}
          return {
            id: str(r.id ?? r.node_id) || `n-${i}`,
            label_id: str(r.label_id) || str(r.id) || `n-${i}`,
            feature_id: r.feature_id == null ? null : str(r.feature_id),
            kind: str(r.kind) || 'screen',
            sort_order: typeof r.sort_order === 'number' ? r.sort_order : i,
          }
        }),
        edges: asArray(rec.edges).map((e, i) => {
          const r = asRecord(e) ?? {}
          return {
            id: str(r.id ?? r.edge_id) || `e-${i}`,
            from: str(r.from ?? r.from_node),
            to: str(r.to ?? r.to_node),
            kind: str(r.kind ?? r.edge_kind) || 'nav',
            sort_order: typeof r.sort_order === 'number' ? r.sort_order : i,
          }
        }),
        source: file,
      })
    } else if (Array.isArray(rec.steps)) {
      const steps = asArray(rec.steps)
      const nodes: KnowledgeFlowNode[] = steps.map((s, i) => {
        const r = asRecord(s) ?? {}
        return {
          id: `step-${str(r.n) || i + 1}`,
          label_id: str(r.title) || `step-${i + 1}`,
          kind: str(r.kind) || 'step',
          sort_order: typeof r.n === 'number' ? r.n : i + 1,
        }
      })
      const edges: KnowledgeFlowEdge[] = []
      for (let i = 0; i < nodes.length - 1; i++) {
        edges.push({
          id: `${nodes[i]!.id}__${nodes[i + 1]!.id}`,
          from: nodes[i]!.id,
          to: nodes[i + 1]!.id,
          kind: 'sequence',
          sort_order: i,
        })
      }
      flows.push({
        id: baseId,
        name: str(rec.name) || baseId,
        desc: str(rec.desc) || undefined,
        kind: 'lintas',
        nodes,
        edges,
        steps,
        source: file,
      })
    }
  }

  return {
    features: [...byId.values()],
    pages,
    endpoints,
    tasks,
    units,
    flows,
    source: {
      kind: 'json_bundle',
      detail: `legacy multi-file JSON bundle at ${dir}`,
      bundlePath: dir,
    },
  }
}

/**
 * Load corpus from a directory that ships with the app.
 * Prefers public/flow-data (data-bundle.json + graph.json [+ optional knowledge.json]).
 * Falls back to legacy multi-file layout when present. Never requires absolute job paths.
 */
export function loadKnowledgeCorpusFromJson(bundlePath: string): KnowledgeCorpus {
  if (!bundlePath || !existsSync(bundlePath)) {
    return emptyCorpus(bundlePath || '(empty)', `bundle path missing: ${bundlePath}`)
  }

  // File path → treat as knowledge.json
  if (bundlePath.endsWith('.json') && existsSync(bundlePath)) {
    const dir = bundlePath.replace(/[/\\][^/\\]+$/, '') || '.'
    return loadFromKnowledgeJsonFile(bundlePath, dir)
  }

  const flowBundle = join(bundlePath, 'data-bundle.json')
  const flowGraph = join(bundlePath, 'graph.json')
  const flowKnowledge = join(bundlePath, 'knowledge.json')
  if (existsSync(flowBundle) || existsSync(flowGraph) || existsSync(flowKnowledge)) {
    return loadFromFlowDataDir(bundlePath)
  }

  return loadFromLegacyMultiFileDir(bundlePath)
}

// ---------------------------------------------------------------------------
// MySQL optional load (read-only; never mutates; never prints credentials)
// ---------------------------------------------------------------------------

async function tryLoadKnowledgeCorpusFromMysql(): Promise<KnowledgeCorpus | null> {
  try {
    // Dynamic import keeps unit tests free of a live pool when unused.
    const { db } = await import('#/server/db')
    const pool = await db()

    const [tableRows] = await pool.query(
      `SELECT TABLE_NAME AS name
       FROM information_schema.TABLES
       WHERE TABLE_SCHEMA = DATABASE()
         AND TABLE_NAME IN (
           'product_features','feature_task_map','feature_directory','feature_units',
           'app_flow_nodes','app_flow_edges',
           'app_pages','api_endpoints','page_api_calls','nav_edges','knowledge_aliases'
         )`,
    )
    const tables = new Set(
      (tableRows as Array<{ name: string }>).map((r) => r.name),
    )
    if (tables.size === 0) return null

    const features: KnowledgeFeature[] = []
    const tasks: KnowledgeTask[] = []
    const units: KnowledgeUnit[] = []
    const flows: KnowledgeFlow[] = []
    let pages: KnowledgePage[] = []
    let endpoints: KnowledgeEndpoint[] = []

    if (tables.has('product_features')) {
      const [rows] = await pool.query(
        `SELECT feature_id, nama_id, domain_bisnis, ringkasan_id,
                platform_json, capabilities_json, fc_refs_json, curated
         FROM product_features`,
      )
      for (const r of rows as Array<Record<string, unknown>>) {
        let fcRefs: string[] = []
        const rawFc = r.fc_refs_json
        if (typeof rawFc === 'string') {
          const parsed = safeJsonParse(rawFc)
          fcRefs = asArray(parsed).map(str).filter(Boolean)
        } else if (Array.isArray(rawFc)) {
          fcRefs = rawFc.map(str).filter(Boolean)
        }
        features.push({
          id: str(r.feature_id),
          nama_id: str(r.nama_id),
          domain_bisnis: str(r.domain_bisnis) || undefined,
          ringkasan_id: r.ringkasan_id == null ? null : str(r.ringkasan_id),
          platform: asRecord(r.platform_json) ?? undefined,
          fc_refs: fcRefs,
          curated: Boolean(r.curated),
          screens: [],
          task_ids: [],
        })
      }
    }

    if (tables.has('feature_directory')) {
      const [rows] = await pool.query(
        `SELECT feature_contract_id, judul_id, domain_bisnis, ringkasan_id, doc_md, delivery_status
         FROM feature_directory`,
      )
      // Store directory rows as pseudo-features when no FEAT match; also enrich.
      const byId = new Map(features.map((f) => [f.id, f]))
      for (const r of rows as Array<Record<string, unknown>>) {
        const fc = str(r.feature_contract_id)
        const ring = r.ringkasan_id == null ? null : str(r.ringkasan_id)
        const doc = r.doc_md == null ? null : str(r.doc_md)
        let attached = false
        for (const f of byId.values()) {
          if (f.fc_refs?.includes(fc)) {
            if (!f.doc_md && doc) f.doc_md = doc
            if (!f.ringkasan_id && ring) f.ringkasan_id = ring
            if (!f.delivery_status && r.delivery_status) f.delivery_status = str(r.delivery_status)
            attached = true
          }
        }
        if (!attached && fc) {
          features.push({
            id: fc,
            nama_id: str(r.judul_id) || fc,
            domain_bisnis: str(r.domain_bisnis) || undefined,
            ringkasan_id: ring,
            doc_md: doc,
            delivery_status: str(r.delivery_status) || undefined,
            screens: [],
            task_ids: [],
            fc_refs: [fc],
          })
        }
      }
    }

    if (tables.has('feature_task_map')) {
      const [rows] = await pool.query(
        `SELECT feature_id, task_id, join_source, confidence FROM feature_task_map`,
      )
      const byFeat = new Map(features.map((f) => [f.id, f]))
      for (const r of rows as Array<Record<string, unknown>>) {
        const fid = str(r.feature_id)
        const tid = str(r.task_id)
        const f = byFeat.get(fid)
        if (f) {
          f.task_ids = [...new Set([...(f.task_ids ?? []), tid])]
        }
        tasks.push({
          id: tid,
          feature_id: fid,
        })
      }
    }

    if (tables.has('feature_units')) {
      const [rows] = await pool.query(
        `SELECT unit_id, feature_contract_id, unit_type, identifier, anchor, notes,
                coverage_status, repo
         FROM feature_units`,
      )
      for (const r of rows as Array<Record<string, unknown>>) {
        units.push({
          unit_id: str(r.unit_id),
          feature_contract_id: r.feature_contract_id == null ? null : str(r.feature_contract_id),
          unit_type: r.unit_type == null ? null : str(r.unit_type),
          identifier: r.identifier == null ? null : str(r.identifier),
          anchor: r.anchor == null ? null : str(r.anchor),
          notes: r.notes == null ? null : str(r.notes),
          coverage_status: r.coverage_status == null ? null : str(r.coverage_status),
          repo: r.repo == null ? null : str(r.repo),
        })
      }
    }

    if (tables.has('app_flow_nodes') && tables.has('app_flow_edges')) {
      const [nodeRows] = await pool.query(
        `SELECT project_id, node_id, feature_id, label_id, kind, sort_order,
                layout_col, layout_row, source_ref
         FROM app_flow_nodes ORDER BY project_id, sort_order`,
      )
      const [edgeRows] = await pool.query(
        `SELECT project_id, edge_id, from_node, to_node, edge_kind, sort_order
         FROM app_flow_edges ORDER BY project_id, sort_order`,
      )
      const byProject = new Map<string, KnowledgeFlow>()
      for (const r of nodeRows as Array<Record<string, unknown>>) {
        const pid = str(r.project_id)
        let flow = byProject.get(pid)
        if (!flow) {
          flow = {
            id: pid,
            project_id: pid,
            kind: 'project',
            nodes: [],
            edges: [],
            source: 'mysql:app_flow_nodes',
          }
          byProject.set(pid, flow)
        }
        flow.nodes.push({
          id: str(r.node_id),
          label_id: str(r.label_id),
          feature_id: r.feature_id == null ? null : str(r.feature_id),
          kind: str(r.kind) || 'screen',
          sort_order: Number(r.sort_order) || 0,
          layout_col: Number(r.layout_col) || 0,
          layout_row: Number(r.layout_row) || 0,
          source_ref: r.source_ref == null ? null : str(r.source_ref),
        })
      }
      for (const r of edgeRows as Array<Record<string, unknown>>) {
        const pid = str(r.project_id)
        const flow = byProject.get(pid)
        if (!flow) continue
        flow.edges.push({
          id: str(r.edge_id),
          from: str(r.from_node),
          to: str(r.to_node),
          kind: str(r.edge_kind) || 'nav',
          sort_order: Number(r.sort_order) || 0,
        })
      }
      flows.push(...byProject.values())
    }

    // 012 ultimate map tables (pages / endpoints / calls / nav)
    if (tables.has('app_pages')) {
      const [pageRows] = await pool.query(
        `SELECT id, project_id, label_id, route, area, feature_id FROM app_pages`,
      )
      const callsByPage = new Map<string, Array<{ method: string; path: string }>>()
      if (tables.has('page_api_calls') && tables.has('api_endpoints')) {
        const [callRows] = await pool.query(
          `SELECT c.page_id, e.method, e.path
           FROM page_api_calls c
           INNER JOIN api_endpoints e ON e.id = c.endpoint_id`,
        )
        for (const r of callRows as Array<Record<string, unknown>>) {
          const pid = str(r.page_id)
          const list = callsByPage.get(pid) ?? []
          list.push({ method: str(r.method) || 'GET', path: str(r.path) })
          callsByPage.set(pid, list)
        }
      }
      const navByPage = new Map<string, string[]>()
      if (tables.has('nav_edges')) {
        const [navRows] = await pool.query(`SELECT from_page, to_page FROM nav_edges`)
        for (const r of navRows as Array<Record<string, unknown>>) {
          const from = str(r.from_page)
          const list = navByPage.get(from) ?? []
          list.push(str(r.to_page))
          navByPage.set(from, list)
        }
      }
      pages = (pageRows as Array<Record<string, unknown>>).map((r) => ({
        id: str(r.id),
        label_id: str(r.label_id),
        route_or_screen: str(r.route),
        api_calls: callsByPage.get(str(r.id)) ?? [],
        nav_to: navByPage.get(str(r.id)),
        area: str(r.area) || undefined,
        feature_id: r.feature_id == null ? null : str(r.feature_id),
        source_file: 'mysql:app_pages',
      }))
    }

    if (tables.has('api_endpoints')) {
      const [epRows] = await pool.query(
        `SELECT id, method, path, domain_id, label_id, repo FROM api_endpoints`,
      )
      endpoints = (epRows as Array<Record<string, unknown>>).map((r) => ({
        id: str(r.id) || `${str(r.method)} ${str(r.path)}`,
        method: str(r.method) || 'GET',
        path: str(r.path),
        domain_id: str(r.domain_id) || undefined,
        label_id: str(r.label_id) || undefined,
        repo: str(r.repo) || undefined,
      }))
    }

    // Merge JSON for missing layers / enrichment (always safe offline fallback data).
    const json = loadKnowledgeCorpusFromJson(resolveKnowledgeBundlePath())
    // Prefer MySQL features when non-empty; still merge screens/task_ids/doc from JSON.
    const featById = new Map(features.map((f) => [f.id, f]))
    for (const jf of json.features) {
      const cur = featById.get(jf.id)
      if (!cur) {
        featById.set(jf.id, jf)
        continue
      }
      cur.screens = [...new Set([...(cur.screens ?? []), ...(jf.screens ?? [])])]
      cur.task_ids = [...new Set([...(cur.task_ids ?? []), ...(jf.task_ids ?? [])])]
      if (!cur.doc_md && jf.doc_md) cur.doc_md = jf.doc_md
      if (!cur.ringkasan_id && jf.ringkasan_id) cur.ringkasan_id = jf.ringkasan_id
      if (!cur.area && jf.area) cur.area = jf.area
      if (!cur.status && jf.status) cur.status = jf.status
      if (!cur.rollup && jf.rollup) cur.rollup = jf.rollup
      if (!cur.unit_count && jf.unit_count) cur.unit_count = jf.unit_count
      cur.project_ids = [...new Set([...(cur.project_ids ?? []), ...(jf.project_ids ?? [])])]
    }

    // Merge task verdicts from JSON
    const taskById = new Map<string, KnowledgeTask>()
    for (const t of tasks) taskById.set(t.id, t)
    for (const t of json.tasks) {
      const cur = taskById.get(t.id)
      if (!cur) taskById.set(t.id, t)
      else {
        cur.judul_id = cur.judul_id || t.judul_id
        cur.verdict = cur.verdict || t.verdict
        cur.feature_id = cur.feature_id || t.feature_id
        cur.acceptance = cur.acceptance ?? t.acceptance
        cur.evidence = cur.evidence ?? t.evidence
      }
    }

    // Flows: MySQL wins per project id; keep lintas JSON flows
    const flowById = new Map(flows.map((f) => [f.id, f]))
    for (const f of json.flows) {
      if (!flowById.has(f.id)) flowById.set(f.id, f)
    }

    if (pages.length === 0) pages = json.pages
    if (endpoints.length === 0) endpoints = json.endpoints

    const pageNote =
      pages === json.pages || (pages.length > 0 && pages[0]?.source_file === 'mysql:app_pages')
        ? tables.has('app_pages')
          ? 'pages/endpoints from mysql 012'
          : 'pages/endpoints from JSON bundle'
        : 'pages/endpoints mixed'

    return {
      features: [...featById.values()],
      pages,
      endpoints,
      tasks: [...taskById.values()],
      units: units.length > 0 ? units : json.units,
      flows: [...flowById.values()],
      source: {
        kind: 'mysql',
        detail: `MySQL tables present: ${[...tables].sort().join(', ')}; ${pageNote}`,
        tablesPresent: [...tables].sort(),
        bundlePath: resolveKnowledgeBundlePath(),
      },
    }
  } catch {
    // Fail soft — callers fall back to JSON. Never surface credentials.
    return null
  }
}

// ---------------------------------------------------------------------------
// Corpus cache / injection (tests)
// ---------------------------------------------------------------------------

let injectedCorpus: KnowledgeCorpus | null = null
let cachedCorpus: KnowledgeCorpus | null = null
let cacheKey: string | null = null

/** Test helper: inject a fixed corpus (skips disk/DB). */
export function setKnowledgeCorpusForTests(corpus: KnowledgeCorpus | null): void {
  injectedCorpus = corpus
  cachedCorpus = null
  cacheKey = null
}

/** Reset caches (tests). */
export function resetKnowledgeCorpusCache(): void {
  injectedCorpus = null
  cachedCorpus = null
  cacheKey = null
}

/**
 * Resolve active corpus: injected → MySQL (best-effort) → deployed flow-data JSON.
 * Handlers never call remote HTTP; auth is solely the MCP tools/call gate (board:read).
 */
export async function resolveKnowledgeCorpus(opts?: {
  bundlePath?: string
  preferMysql?: boolean
}): Promise<KnowledgeCorpus> {
  if (injectedCorpus) return injectedCorpus

  const bundlePath = resolveKnowledgeBundlePath(opts?.bundlePath)
  const preferMysql = opts?.preferMysql !== false
  const key = `${preferMysql ? 'mysql|' : 'json|'}${bundlePath}`
  if (cachedCorpus && cacheKey === key) return cachedCorpus

  if (preferMysql) {
    const mysqlCorpus = await tryLoadKnowledgeCorpusFromMysql()
    if (mysqlCorpus && mysqlCorpus.features.length > 0) {
      cachedCorpus = mysqlCorpus
      cacheKey = key
      return mysqlCorpus
    }
  }

  const jsonCorpus = loadKnowledgeCorpusFromJson(bundlePath)
  cachedCorpus = jsonCorpus
  cacheKey = key
  return jsonCorpus
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export async function searchKnowledge(
  query: string,
  opts?: { limit?: number; corpus?: KnowledgeCorpus },
): Promise<SearchKnowledgeResult | KnowledgeErrorResult> {
  const q = (query ?? '').trim()
  if (!q) {
    return { ok: false, tool: 'search_knowledge', code: 'INVALID_INPUT', error: 'query is required' }
  }
  const corpus = opts?.corpus ?? (await resolveKnowledgeCorpus())
  const terms = expandQueryTerms(q)
  const limit = Math.min(Math.max(opts?.limit ?? 25, 1), 100)
  const hits: KnowledgeHit[] = []

  // Alias hits
  for (const alias of KNOWLEDGE_ALIASES) {
    const { score, match } = scoreText(q, terms, [
      { text: alias.en, weight: 1 },
      { text: alias.id, weight: 1 },
      { text: alias.terms.join(' '), weight: 0.9 },
    ])
    if (score >= 50) {
      hits.push({
        type: 'alias',
        id: `alias:${norm(alias.en)}`,
        label: `${alias.en} ↔ ${alias.id}`,
        score: score + 5,
        match,
        snippet: `EN: ${alias.en} | ID: ${alias.id}`,
        meta: { terms: alias.terms },
      })
    }
  }

  for (const f of corpus.features) {
    const { score, match, snippet } = scoreText(q, terms, [
      { text: f.id, weight: 1.2 },
      { text: f.nama_id, weight: 1.15 },
      { text: f.ringkasan_id ?? '', weight: 0.95 },
      { text: f.doc_md ?? '', weight: 0.75 },
      { text: (f.screens ?? []).join(' '), weight: 0.9 },
      { text: f.area ?? '', weight: 0.5 },
      { text: f.domain_bisnis ?? '', weight: 0.5 },
      { text: (f.task_ids ?? []).join(' '), weight: 0.7 },
    ])
    if (score >= 35) {
      hits.push({
        type: 'feature',
        id: f.id,
        label: f.nama_id,
        score,
        match,
        snippet: snippet ?? f.ringkasan_id ?? undefined,
        meta: { area: f.area, status: f.status, screens: f.screens?.slice(0, 8) },
      })
    }
  }

  for (const p of corpus.pages) {
    const { score, match, snippet } = scoreText(q, terms, [
      { text: p.id, weight: 1 },
      { text: p.label_id, weight: 1.1 },
      { text: p.route_or_screen, weight: 1.15 },
      { text: p.feature_id ?? '', weight: 0.8 },
      { text: p.area ?? '', weight: 0.4 },
      {
        text: p.api_calls.map((c) => `${c.method} ${c.path}`).join(' '),
        weight: 0.7,
      },
    ])
    if (score >= 40) {
      hits.push({
        type: 'page',
        id: p.id,
        label: p.label_id || p.route_or_screen,
        score,
        match,
        snippet: snippet ?? p.route_or_screen,
        meta: { route_or_screen: p.route_or_screen, feature_id: p.feature_id },
      })
    }
  }

  for (const e of corpus.endpoints) {
    const methodPath = `${e.method} ${e.path}`
    const { score, match, snippet } = scoreText(q, terms, [
      { text: e.id, weight: 0.9 },
      { text: methodPath, weight: 1.2 },
      { text: e.path, weight: 1.15 },
      { text: e.label_id ?? '', weight: 1 },
      { text: e.domain_id ?? '', weight: 0.6 },
      { text: e.controller ?? '', weight: 0.5 },
    ])
    if (score >= 40) {
      hits.push({
        type: 'endpoint',
        id: e.id,
        label: methodPath,
        score,
        match,
        snippet: snippet ?? e.label_id,
        meta: { domain_id: e.domain_id, controller: e.controller },
      })
    }
  }

  for (const t of corpus.tasks) {
    const { score, match, snippet } = scoreText(q, terms, [
      { text: t.id, weight: 1.1 },
      { text: t.judul_id ?? '', weight: 1 },
      { text: t.feature_id ?? '', weight: 0.8 },
      { text: t.verdict ?? '', weight: 0.3 },
    ])
    if (score >= 40) {
      hits.push({
        type: 'task',
        id: t.id,
        label: t.judul_id || t.id,
        score,
        match,
        snippet: snippet ?? t.verdict,
        meta: { verdict: t.verdict, feature_id: t.feature_id },
      })
    }
  }

  for (const u of corpus.units) {
    const { score, match, snippet } = scoreText(q, terms, [
      { text: u.unit_id, weight: 0.8 },
      { text: u.identifier ?? '', weight: 1 },
      { text: u.notes ?? '', weight: 0.9 },
      { text: u.anchor ?? '', weight: 0.7 },
      { text: u.feature_contract_id ?? '', weight: 0.6 },
    ])
    if (score >= 45) {
      hits.push({
        type: 'unit',
        id: u.unit_id,
        label: u.identifier || u.unit_id,
        score,
        match,
        snippet: snippet ?? u.notes ?? undefined,
        meta: { feature_contract_id: u.feature_contract_id, repo: u.repo },
      })
    }
  }

  for (const f of corpus.flows) {
    const { score, match, snippet } = scoreText(q, terms, [
      { text: f.id, weight: 1 },
      { text: f.name ?? '', weight: 1.1 },
      { text: f.desc ?? '', weight: 0.9 },
      { text: f.project_id ?? '', weight: 0.8 },
      { text: f.nodes.map((n) => n.label_id ?? n.id).join(' '), weight: 0.6 },
    ])
    if (score >= 40) {
      hits.push({
        type: 'flow',
        id: f.id,
        label: f.name || f.project_id || f.id,
        score,
        match,
        snippet: snippet ?? f.desc,
        meta: { kind: f.kind, node_count: f.nodes.length, edge_count: f.edges.length },
      })
    }
  }

  hits.sort((a, b) => b.score - a.score || a.type.localeCompare(b.type) || a.id.localeCompare(b.id))

  const limited = hits.slice(0, limit)
  const corpusNonEmpty =
    corpus.features.length +
      corpus.pages.length +
      corpus.endpoints.length +
      corpus.tasks.length >
    0
  const productHit = limited.some(
    (h) =>
      h.type === 'feature' ||
      h.type === 'page' ||
      h.type === 'endpoint' ||
      h.type === 'task' ||
      h.type === 'unit' ||
      h.type === 'flow',
  )

  return {
    ok: true,
    query: q,
    expandedTerms: terms,
    hits: limited,
    source: corpus.source,
    searchReal: corpusNonEmpty && productHit && limited.length > 0,
  }
}

function resolveFeature(
  corpus: KnowledgeCorpus,
  idOrName: string,
): KnowledgeFeature | null {
  const key = idOrName.trim()
  if (!key) return null
  const exact = corpus.features.find((f) => f.id === key)
  if (exact) return exact
  const n = norm(key)
  const byNormId = corpus.features.find((f) => norm(f.id) === n)
  if (byNormId) return byNormId
  // FEAT-* style ids: exact / normalized id only (no fuzzy false positives).
  if (/^feat[\s-]/i.test(key) || /^fc[\s-]/i.test(key)) {
    return null
  }
  const byName = corpus.features.find((f) => norm(f.nama_id) === n)
  if (byName) return byName
  // fuzzy human names / aliases only
  const terms = expandQueryTerms(key)
  let best: KnowledgeFeature | null = null
  let bestScore = 0
  for (const f of corpus.features) {
    const { score } = scoreText(key, terms, [
      { text: f.id, weight: 1.2 },
      { text: f.nama_id, weight: 1.2 },
      { text: f.ringkasan_id ?? '', weight: 0.8 },
      { text: (f.screens ?? []).join(' '), weight: 0.9 },
    ])
    if (score > bestScore) {
      bestScore = score
      best = f
    }
  }
  // Require a strong match so random strings do not attach to the nearest FEAT-*.
  return bestScore >= 70 ? best : null
}

export async function getFeatureBundle(
  idOrName: string,
  opts?: { corpus?: KnowledgeCorpus },
): Promise<FeatureBundleResult | KnowledgeErrorResult> {
  const key = (idOrName ?? '').trim()
  if (!key) {
    return {
      ok: false,
      tool: 'get_feature_bundle',
      code: 'INVALID_INPUT',
      error: 'idOrName is required',
    }
  }
  const corpus = opts?.corpus ?? (await resolveKnowledgeCorpus())
  const feature = resolveFeature(corpus, key)
  if (!feature) {
    return {
      ok: false,
      tool: 'get_feature_bundle',
      code: 'NOT_FOUND',
      error: `feature not found: ${key}`,
      source: corpus.source,
    }
  }

  const pages = corpus.pages.filter(
    (p) =>
      p.feature_id === feature.id ||
      (feature.screens ?? []).some(
        (s) => norm(s) === norm(p.route_or_screen) || norm(p.route_or_screen).includes(norm(s)),
      ),
  )

  const endpointKeys = new Set<string>()
  for (const p of pages) {
    for (const c of p.api_calls) {
      endpointKeys.add(`${c.method.toUpperCase()} ${c.path}`)
    }
  }
  // Distinctive tokens from id/name/screens only (not full EN↔ID alias expand —
  // alias expansion would attach unrelated endpoints via shared short words).
  const distinctive = new Set<string>()
  for (const raw of [
    feature.id,
    feature.nama_id,
    ...(feature.screens ?? []),
  ]) {
    for (const tok of norm(raw).split(' ').filter((t) => t.length >= 4)) {
      if (!['feat', 'page', 'screen', 'with', 'from', 'this', 'that'].includes(tok)) {
        distinctive.add(tok)
      }
    }
  }
  // Seed well-known product tokens when present on the feature
  const blob = norm(`${feature.id} ${feature.nama_id} ${(feature.screens ?? []).join(' ')} ${feature.ringkasan_id ?? ''}`)
  for (const t of ['period', 'haid', 'menstru', 'premium', 'checkout', 'affiliate', 'puasa', 'meditat']) {
    if (blob.includes(t)) distinctive.add(t)
  }

  const endpoints: KnowledgeEndpoint[] = []
  const seenEp = new Set<string>()
  const ranked: Array<{ e: KnowledgeEndpoint; rank: number }> = []
  for (const e of corpus.endpoints) {
    const mk = `${e.method.toUpperCase()} ${e.path}`
    const pathHit = endpointKeys.has(mk)
    const looseHit = [...endpointKeys].some((k) => {
      const path = k.replace(/^[A-Z]+\s+/, '')
      return pathLooseEqual(e.path, path)
    })
    const epBlob = norm(`${e.path} ${e.label_id ?? ''} ${e.id}`)
    const tokenHits = [...distinctive].filter((t) => epBlob.includes(t))
    const textHit = tokenHits.length >= 1 && tokenHits.some((t) => t.length >= 5 || ['period', 'haid', 'premium'].includes(t))
    if (pathHit || looseHit || textHit) {
      if (!seenEp.has(e.id)) {
        seenEp.add(e.id)
        ranked.push({
          e,
          rank: pathHit ? 3 : looseHit ? 2 : 1,
        })
      }
    }
  }
  ranked.sort((a, b) => b.rank - a.rank || a.e.path.localeCompare(b.e.path))
  for (const r of ranked) endpoints.push(r.e)

  const featTerms = expandQueryTerms(`${feature.id} ${feature.nama_id}`)

  const taskIdSet = new Set(feature.task_ids ?? [])
  const tasks = corpus.tasks.filter(
    (t) => taskIdSet.has(t.id) || t.feature_id === feature.id,
  )
  // ensure task_ids without task rows still appear
  for (const tid of taskIdSet) {
    if (!tasks.some((t) => t.id === tid)) {
      tasks.push({ id: tid, feature_id: feature.id })
    }
  }

  const fcSet = new Set(feature.fc_refs ?? [])
  const units = corpus.units.filter((u) => {
    if (u.feature_contract_id && fcSet.has(u.feature_contract_id)) return true
    const blob = norm(`${u.identifier ?? ''} ${u.notes ?? ''} ${u.anchor ?? ''}`)
    return featTerms.some((t) => t.length > 3 && blob.includes(t))
  })

  const related_features = corpus.features
    .filter(
      (f) =>
        f.id !== feature.id &&
        (f.area === feature.area ||
          f.domain_bisnis === feature.domain_bisnis ||
          (f.fc_refs ?? []).some((fc) => fcSet.has(fc))),
    )
    .slice(0, 12)
    .map((f) => ({
      id: f.id,
      nama_id: f.nama_id,
      area: f.area,
      ringkasan_id: f.ringkasan_id,
    }))

  return {
    ok: true,
    feature,
    pages,
    endpoints: endpoints.slice(0, 80),
    tasks,
    units: units.slice(0, 80),
    related_features,
    source: corpus.source,
  }
}

function parseMethodPath(methodPath: string): { method: string | null; path: string } {
  const raw = methodPath.trim()
  const m = raw.match(/^(GET|POST|PUT|PATCH|DELETE|OPTIONS|HEAD)\s+(.+)$/i)
  if (m) {
    return { method: m[1]!.toUpperCase(), path: m[2]!.trim() }
  }
  return { method: null, path: raw }
}

function pathLooseEqual(a: string, b: string): boolean {
  const normPath = (p: string) =>
    p
      .replace(/\{[^}]+\}/g, '*')
      .replace(/:\w+/g, '*')
      .replace(/\*/g, '*')
      .replace(/\/+$/, '')
      .toLowerCase()
  return normPath(a) === normPath(b) || a.toLowerCase() === b.toLowerCase()
}

export async function getEndpointBundle(
  methodPath: string,
  opts?: { corpus?: KnowledgeCorpus },
): Promise<EndpointBundleResult | KnowledgeErrorResult> {
  const key = (methodPath ?? '').trim()
  if (!key) {
    return {
      ok: false,
      tool: 'get_endpoint_bundle',
      code: 'INVALID_INPUT',
      error: 'methodPath is required',
    }
  }
  const corpus = opts?.corpus ?? (await resolveKnowledgeCorpus())
  const { method, path } = parseMethodPath(key)

  let endpoint =
    corpus.endpoints.find((e) => {
      if (method && e.method.toUpperCase() !== method) return false
      return pathLooseEqual(e.path, path) || e.id === key
    }) ?? null

  if (!endpoint) {
    // fuzzy by path substring
    endpoint =
      corpus.endpoints.find((e) => {
        if (method && e.method.toUpperCase() !== method) return false
        return e.path.includes(path) || path.includes(e.path)
      }) ?? null
  }

  if (!endpoint) {
    return {
      ok: false,
      tool: 'get_endpoint_bundle',
      code: 'NOT_FOUND',
      error: `endpoint not found: ${key}`,
      source: corpus.source,
    }
  }

  const callers = corpus.pages.filter((p) =>
    p.api_calls.some(
      (c) =>
        c.method.toUpperCase() === endpoint!.method.toUpperCase() &&
        pathLooseEqual(c.path, endpoint!.path),
    ),
  )

  const featureIds = new Set(
    callers.map((c) => c.feature_id).filter((x): x is string => typeof x === 'string' && !!x),
  )
  const features = corpus.features
    .filter((f) => featureIds.has(f.id))
    .map((f) => ({
      id: f.id,
      nama_id: f.nama_id,
      area: f.area,
      ringkasan_id: f.ringkasan_id,
    }))

  return {
    ok: true,
    endpoint,
    callers,
    features,
    domain: endpoint.domain_id ?? null,
    source: corpus.source,
  }
}

export async function getFlow(
  projectOrLintas: string,
  opts?: { corpus?: KnowledgeCorpus },
): Promise<FlowResult | KnowledgeErrorResult> {
  const key = (projectOrLintas ?? '').trim()
  if (!key) {
    return {
      ok: false,
      tool: 'get_flow',
      code: 'INVALID_INPUT',
      error: 'project|lintas id is required',
    }
  }
  const corpus = opts?.corpus ?? (await resolveKnowledgeCorpus())
  const n = norm(key)

  // aliases for project ids (empty strings never participate in matching)
  const aliases: Record<string, string[]> = {
    rn: ['rn', 'react native', 'mobile'],
    web: ['web', 'web-member', 'web member', 'mfs-web'],
    'web-member': ['web', 'web-member', 'web member'],
    sales: ['sales', 'panel-sales', 'panel sales'],
    'panel-sales': ['sales', 'panel-sales'],
    affiliate: ['affiliate', 'aff', 'afiliasi'],
    backend: ['backend', 'be', 'api'],
    premium: ['premium', 'lintas-premium', 'pembelian premium'],
    lintas: ['lintas', 'cross', 'lintas-sistem', 'cross-system'],
  }

  // Generic "lintas" / "cross" → first cross-system flow (prefer premium if present)
  if (n === 'lintas' || n === 'cross' || n === 'lintas-sistem' || n === 'cross-system') {
    const lintasFlows = corpus.flows.filter((f) => f.kind === 'lintas')
    const flow =
      lintasFlows.find((f) => norm(f.id) === 'premium' || /premium/i.test(f.name ?? '')) ??
      lintasFlows[0] ??
      null
    if (flow) return { ok: true, flow, source: corpus.source }
  }

  let flow =
    corpus.flows.find(
      (f) =>
        norm(f.id) === n ||
        norm(f.project_id ?? '') === n ||
        norm(f.name ?? '') === n,
    ) ?? null

  if (!flow) {
    for (const f of corpus.flows) {
      const keys = [f.id, f.project_id ?? '', f.name ?? ''].map(norm).filter(Boolean)
      const expanded = keys.flatMap((k) => (aliases[k] ?? [k]).map(norm).filter(Boolean))
      if (expanded.some((a) => a === n || (a.length >= 3 && (n.includes(a) || a.includes(n))))) {
        flow = f
        break
      }
      // match alias table reverse (canon id/project only)
      for (const [canon, list] of Object.entries(aliases)) {
        if (
          list.map(norm).some((a) => a === n) &&
          (norm(f.id) === canon || norm(f.project_id ?? '') === canon)
        ) {
          flow = f
          break
        }
      }
      if (flow) break
    }
  }

  // "premium" alias may point at lintas flow id
  if (!flow && (n === 'premium' || n.includes('premium'))) {
    flow =
      corpus.flows.find(
        (f) => f.kind === 'lintas' && (norm(f.id) === 'premium' || /premium/i.test(f.name ?? '')),
      ) ?? null
  }

  if (!flow) {
    return {
      ok: false,
      tool: 'get_flow',
      code: 'NOT_FOUND',
      error: `flow not found: ${key}`,
      source: corpus.source,
    }
  }

  return { ok: true, flow, source: corpus.source }
}

// ---------------------------------------------------------------------------
// MCP registration — inject secureTool from board-mcp (never bare registerTool)
// ---------------------------------------------------------------------------

export type KnowledgeToolsRegisterDeps = {
  /**
   * Same signature as board-mcp `secureTool` — applies isToolListable + authorizeToolCall.
   * Unauthenticated principals never list or invoke these tools.
   */
  secureTool: (
    name: string,
    meta: {
      title: string
      description: string
      inputSchema: Record<string, unknown> | object
    },
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ) => void
  /** Serialize tool result into MCP content (usually board-mcp jsonText). */
  jsonText: (value: unknown) => unknown
}

/**
 * Register product-knowledge tools via injected secureTool.
 * Call from board-mcp `registerBoardTools` **before** domain-knowledge so the
 * product flow-data corpus owns `search_knowledge`; domain-knowledge skips the
 * duplicate name. secureTool itself swallows "already registered".
 *
 * Auth semantics (same for all four tools):
 *   authenticated MCP read with board:read — identical class to search_knowledge.
 *   Listability and invocation go through isToolListable / authorizeToolCall.
 *   Handlers are pure (corpus only); they never call HTTP or set Authorization headers.
 *   See KNOWLEDGE_TOOL_AUTH_SPECS for the required catalog entries.
 */
export function registerKnowledgeTools(deps: KnowledgeToolsRegisterDeps): void {
  const { secureTool, jsonText } = deps

  // Pure handlers — no HTTP proxy, no secondary auth. secureTool rechecks RBAC.
  const wrap = (
    name: string,
    run: (args: Record<string, unknown>) => Promise<unknown>,
  ) =>
    async (args: Record<string, unknown>) => {
      try {
        return jsonText(await run(args ?? {}))
      } catch {
        return jsonText({
          ok: false,
          tool: name,
          code: 'INTERNAL_ERROR',
          error: 'KNOWLEDGE_TOOL_ERROR',
        })
      }
    }

  secureTool(
    'search_knowledge',
    {
      title: 'Search product knowledge',
      description:
        'Search Task Manager product knowledge across features (label/ringkasan/doc_md), ' +
        'pages, endpoints, tasks, units, flows, and EN↔ID aliases. Ranked hits with type. ' +
        'Auth: board:read (same as get_feature_bundle).',
      inputSchema: {
        query: z.string().describe('Search query (EN or ID), e.g. "period tracker" or "/premium"'),
        limit: z.number().int().optional().describe('Max hits (default 25)'),
      },
    },
    wrap('search_knowledge', async (args) =>
      searchKnowledge(str(args.query), {
        limit: typeof args.limit === 'number' ? args.limit : undefined,
      }),
    ),
  )

  secureTool(
    'get_feature_bundle',
    {
      title: 'Get feature bundle',
      description:
        'One-shot complete feature bundle: ringkasan, doc_md, pages/screens, endpoints, ' +
        'tasks+verdict, units, related features. Accepts FEAT-* id or human name. ' +
        'Auth: board:read (same as search_knowledge). Pure corpus — no HTTP.',
      inputSchema: {
        idOrName: z
          .string()
          .describe('Feature id (FEAT-SIKLUS-HAID) or name ("Pelacak Haid", "period tracker")'),
      },
    },
    wrap('get_feature_bundle', async (args) =>
      getFeatureBundle(str(args.idOrName ?? args.id ?? args.name)),
    ),
  )

  secureTool(
    'get_endpoint_bundle',
    {
      title: 'Get endpoint bundle',
      description:
        'Endpoint detail plus calling pages, linked features, and domain. ' +
        'methodPath e.g. "GET /api/v1/admin-ops/period/cycles".',
      inputSchema: {
        methodPath: z
          .string()
          .describe('METHOD /path or bare /path, e.g. "GET /api/v1/..."'),
      },
    },
    wrap('get_endpoint_bundle', async (args) =>
      getEndpointBundle(str(args.methodPath ?? args.path)),
    ),
  )

  secureTool(
    'get_flow',
    {
      title: 'Get navigation/data flow graph',
      description:
        'Return nodes+edges for a project flow (rn|web-member|panel-sales|affiliate|backend) ' +
        'or a lintas (cross-system) flow such as premium. Auth: board:read.',
      inputSchema: {
        project: z
          .string()
          .describe(
            'Project id or lintas key: rn, web-member, sales, affiliate, backend, premium, lintas',
          ),
      },
    },
    wrap('get_flow', async (args) => getFlow(str(args.project ?? args.projectOrLintas))),
  )
}

export function listKnowledgeToolNames(): readonly KnowledgeToolName[] {
  return KNOWLEDGE_TOOL_NAMES
}
