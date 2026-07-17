#!/usr/bin/env node
/**
 * W-TM-INGEST — ultimate map ingest (pages, API endpoints, nav, aliases).
 *
 * Reads (READ-ONLY sources):
 *   - DESIGN-CANON-V3/data/ultimate/* (or graph.json if present)
 *   - task-manager/data/ultimate/* (optional override / graph.json)
 *   - data/product-features.seed.json (EN↔ID alias seeds)
 *
 * Modes:
 *   --dry-run   (default) print summary counts; no DB; no write except console
 *   --bundle    write data/ultimate/upload-bundle.sql (one-shot SQL for later owner gate)
 *   --db        apply upserts to LOCAL/dev MySQL from .env only
 *
 * Safety:
 *   - NEVER connect/write production 34.177.80.237
 *   - NEVER print tokens/passwords
 *   - Idempotent via source_hash; pass-2 is zero-write when hashes match
 *   - No git writes
 *
 * Usage:
 *   node scripts/ingest-ultimate.mjs
 *   node scripts/ingest-ultimate.mjs --dry-run
 *   node scripts/ingest-ultimate.mjs --bundle
 *   node scripts/ingest-ultimate.mjs --db
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')

const DESIGN_DATA =
  process.env.ULTIMATE_DESIGN_DATA ||
  '/home/user/.claude/jobs/3c5adda9/tmp/tm-wave0/DESIGN-CANON-V3/data'
const LOCAL_ULTIMATE = path.join(ROOT, 'data', 'ultimate')
const SEED_PATH = path.join(ROOT, 'data', 'product-features.seed.json')
const BUNDLE_PATH = path.join(LOCAL_ULTIMATE, 'upload-bundle.sql')

const PROD_HOST_BLOCKLIST = new Set([
  '34.177.80.237',
  'task-manager.mfsdev.net',
])
const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '', '0.0.0.0'])

const PAGE_FILES = [
  { file: 'pages-web.json', project_id: 'web' },
  { file: 'pages-rn.json', project_id: 'rn' },
  { file: 'pages-sales.json', project_id: 'sales' },
  { file: 'pages-aff.json', project_id: 'affiliate' },
]
const ENDPOINTS_FILE = 'backend-endpoints.json'

// ─── argv / mode ─────────────────────────────────────────────────────────────

const argv = process.argv.slice(2)
const wantDb = argv.includes('--db')
const wantBundle = argv.includes('--bundle')
const wantDry =
  argv.includes('--dry-run') || (!wantDb && !wantBundle) // default dry-run
// If both --db and --bundle, both run; dry-run alone is default.

// ─── utils ───────────────────────────────────────────────────────────────────

function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

function readJson(p) {
  const t = readText(p)
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

function sha256(s) {
  return createHash('sha256').update(String(s), 'utf8').digest('hex')
}

function stableStringify(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v)
  if (Array.isArray(v)) return `[${v.map(stableStringify).join(',')}]`
  const keys = Object.keys(v).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(v[k])}`).join(',')}}`
}

function sqlStr(v) {
  if (v == null) return 'NULL'
  return `'${String(v).replace(/\\/g, '\\\\').replace(/'/g, "''")}'`
}

function sqlDt(iso) {
  // DATETIME(3) from ISO
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return 'CURRENT_TIMESTAMP(3)'
  const pad = (n, w = 2) => String(n).padStart(w, '0')
  const ms = pad(d.getUTCMilliseconds(), 3)
  return `'${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())} ${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}:${pad(d.getUTCSeconds())}.${ms}'`
}

function normMethod(m) {
  return String(m || 'GET').trim().toUpperCase() || 'GET'
}

function normPath(p) {
  return String(p || '').trim() || '/'
}

function endpointKey(method, pth) {
  return `${normMethod(method)} ${normPath(pth)}`
}

function synthEndpointId(method, pth) {
  const h = sha256(endpointKey(method, pth)).slice(0, 24)
  return `syn-${normMethod(method).toLowerCase()}-${h}`.slice(0, 191)
}

function loadEnvFile() {
  const envPath = path.join(ROOT, '.env')
  const out = {}
  const txt = readText(envPath)
  if (!txt) return out
  for (const line of txt.split('\n')) {
    const t = line.trim()
    if (!t || t.startsWith('#')) continue
    const i = t.indexOf('=')
    if (i < 0) continue
    const k = t.slice(0, i).trim()
    let v = t.slice(i + 1).trim()
    if (
      (v.startsWith('"') && v.endsWith('"')) ||
      (v.startsWith("'") && v.endsWith("'"))
    ) {
      v = v.slice(1, -1)
    }
    out[k] = v
  }
  return out
}

function env(key, fallback) {
  return process.env[key] ?? loadEnvFile()[key] ?? fallback
}

function assertDbHostSafe(host) {
  const h = String(host || '').trim().toLowerCase()
  if (PROD_HOST_BLOCKLIST.has(h) || h === '34.177.80.237') {
    throw new Error(
      `REFUSED: production DB host blocked (${host}). Use local/dev .env only, or --dry-run / --bundle.`,
    )
  }
  if (h.includes('prod') || h.includes('production') || h.endsWith('.mfsdev.net')) {
    throw new Error(
      `REFUSED: host classified production/remote (${host}). Staging-safe ingest only.`,
    )
  }
  if (!LOCAL_HOSTS.has(h)) {
    // Allow only explicit local; unknown remote blocked (no token print)
    throw new Error(
      `REFUSED: non-local CAIRN_DB_HOST. Point .env at 127.0.0.1/localhost, or use --dry-run / --bundle.`,
    )
  }
}

// ─── source resolution ───────────────────────────────────────────────────────

function resolveUltimateDirs() {
  const dirs = []
  if (fs.existsSync(LOCAL_ULTIMATE)) dirs.push(LOCAL_ULTIMATE)
  const designUltimate = path.join(DESIGN_DATA, 'ultimate')
  if (fs.existsSync(designUltimate)) dirs.push(designUltimate)
  // also allow DESIGN_DATA itself if files sit flat
  if (fs.existsSync(DESIGN_DATA)) dirs.push(DESIGN_DATA)
  return dirs
}

function findFirst(name) {
  for (const d of resolveUltimateDirs()) {
    const p = path.join(d, name)
    if (fs.existsSync(p)) return p
  }
  return null
}

function isUsableGraph(g) {
  if (!g || typeof g !== 'object') return false
  // Flat pages/endpoints shape (test fixtures + alternate dumps)
  if (g.pages || g.app_pages || g.endpoints || g.api_endpoints) return true
  // DESIGN-CANON-V3 graph: nodes[] + edges[] with kind=page|endpoint|feature
  if (Array.isArray(g.nodes) && g.nodes.some((n) => n && (n.kind === 'page' || n.kind === 'endpoint'))) {
    return true
  }
  return false
}

function loadGraphOrRaw() {
  // Prefer graph.json (local then design)
  for (const d of resolveUltimateDirs()) {
    const gp = path.join(d, 'graph.json')
    if (fs.existsSync(gp)) {
      const g = readJson(gp)
      if (isUsableGraph(g)) {
        return { kind: 'graph', path: gp, graph: g }
      }
    }
  }

  const pages = []
  const sources = []
  for (const { file, project_id } of PAGE_FILES) {
    const p = findFirst(file)
    if (!p) continue
    const rows = readJson(p)
    if (!Array.isArray(rows)) continue
    sources.push(p)
    for (const row of rows) {
      pages.push({ ...row, project_id: row.project_id || project_id })
    }
  }

  const epPath = findFirst(ENDPOINTS_FILE)
  let endpoints = []
  if (epPath) {
    const rows = readJson(epPath)
    if (Array.isArray(rows)) {
      endpoints = rows
      sources.push(epPath)
    }
  }

  if (pages.length === 0 && endpoints.length === 0) {
    throw new Error(
      `No ultimate source data found. Looked under ${LOCAL_ULTIMATE} and ${path.join(DESIGN_DATA, 'ultimate')}`,
    )
  }

  return {
    kind: 'raw',
    sources,
    pages,
    endpoints,
  }
}

// ─── model build ─────────────────────────────────────────────────────────────

/**
 * DESIGN-CANON graph: { nodes:[{kind:page|endpoint|feature}], edges:[{kind:nav_to|api_call|...}] }
 */
function buildFromNodesEdgesGraph(graph) {
  const extractedAt = graph.extracted_at || graph.generated_at || new Date().toISOString()
  const nodes = Array.isArray(graph.nodes) ? graph.nodes : []
  const edges = Array.isArray(graph.edges) ? graph.edges : []

  const endpoints = new Map()
  const pagesIn = []

  for (const n of nodes) {
    if (!n || !n.id) continue
    if (n.kind === 'endpoint') {
      const ep = normalizeEndpoint({
        id: n.id,
        method: n.method,
        path: n.path,
        domain_id: n.domain_id,
        label_id: n.label_id,
        repo: n.repo || n.source || null,
      })
      endpoints.set(ep.id, ep)
    } else if (n.kind === 'page') {
      let project_id = n.project_id || n.project || 'unknown'
      if (project_id === 'aff') project_id = 'affiliate'
      pagesIn.push({
        id: n.id,
        project_id,
        label_id: n.label_id,
        route: n.route || n.route_or_screen || n.path,
        area: n.area,
        feature_id: n.feature_id || null,
        api_calls: [],
        nav_to: [],
        extracted_at: n.extracted_at || extractedAt,
      })
    }
  }

  // key index for endpoint synthesis / lookup
  endpoints._byKey = new Map()
  for (const e of endpoints.values()) {
    if (e?.method) endpoints._byKey.set(endpointKey(e.method, e.path), e)
  }

  const pageIds = new Set(pagesIn.map((p) => p.id))
  const pageApiCalls = []
  const navEdges = []
  const featureByPage = new Map()

  for (const e of edges) {
    if (!e) continue
    const kind = e.kind || e.edge_kind || ''
    if (kind === 'nav_to') {
      const from = e.from || e.from_page || e.from_page_id
      const to = e.to || e.to_page || e.to_page_id
      if (from && to) navEdges.push({ from_page: String(from), to_page: String(to) })
    } else if (kind === 'api_call') {
      const page_id = e.from || e.page_id || e.pageId
      let endpoint_id = e.to || e.endpoint_id || e.endpointId
      const method = e.method
      const pth = e.path_norm || e.path_raw || e.path
      if (!endpoint_id && method && pth) {
        const key = endpointKey(method, pth)
        let ep = endpoints._byKey.get(key)
        if (!ep) {
          ep = normalizeEndpoint({
            id: synthEndpointId(method, pth),
            method,
            path: pth,
            domain_id: 'page-derived',
            label_id: `${normMethod(method)} ${normPath(pth)}`,
            repo: e.ep_source || 'page-derived',
          })
          endpoints.set(ep.id, ep)
          endpoints._byKey.set(key, ep)
        }
        endpoint_id = ep.id
      } else if (endpoint_id && !endpoints.has(endpoint_id) && method && pth) {
        // edge points at id not in nodes — materialize from edge fields
        const ep = normalizeEndpoint({
          id: endpoint_id,
          method,
          path: pth,
          domain_id: e.domain_id || 'page-derived',
          label_id: e.label_id || `${normMethod(method)} ${normPath(pth)}`,
          repo: e.ep_source || e.repo || 'page-derived',
        })
        endpoints.set(ep.id, ep)
        endpoints._byKey.set(endpointKey(ep.method, ep.path), ep)
      }
      if (!page_id || !endpoint_id) continue
      if (!pageIds.has(page_id)) continue
      const evidence =
        e.evidence != null
          ? String(e.evidence)
          : e.match_reason
            ? `match:${e.match_reason}${e.path_raw ? ` path=${e.path_raw}` : ''}`
            : e.path_raw
              ? String(e.path_raw)
              : null
      pageApiCalls.push({
        page_id: String(page_id),
        endpoint_id: String(endpoint_id),
        evidence: evidence != null ? String(evidence).slice(0, 65000) : null,
      })
    } else if (kind === 'page_feature') {
      const page_id = e.from || e.page_id
      const feature_id = e.to || e.feature_id
      if (page_id && feature_id && !featureByPage.has(page_id)) {
        featureByPage.set(String(page_id), String(feature_id))
      }
    }
  }

  // apply page_feature overrides when page.feature_id missing
  for (const p of pagesIn) {
    if (!p.feature_id && featureByPage.has(p.id)) {
      p.feature_id = featureByPage.get(p.id)
    }
  }

  const pages = pagesIn.map((p) => normalizePage(p, p.project_id, extractedAt))
  const endpointList = [...endpoints.values()].filter((e) => e && e.id)
  const aliases = mergeAliases(buildSeedAliases())
  return {
    pages,
    endpoints: endpointList,
    pageApiCalls,
    navEdges,
    aliases,
    extractedAt,
  }
}

function buildFromGraph(graph) {
  // Prefer DESIGN-CANON nodes/edges when present
  if (Array.isArray(graph.nodes) && graph.nodes.some((n) => n && n.kind === 'page')) {
    return buildFromNodesEdgesGraph(graph)
  }

  const extractedAt = graph.extracted_at || graph.generated_at || new Date().toISOString()
  const pagesIn = graph.pages || graph.app_pages || []
  const epsIn = graph.endpoints || graph.api_endpoints || []
  const callsIn = graph.page_api_calls || graph.pageApiCalls || []
  const navIn = graph.nav_edges || graph.navEdges || []
  const aliasesIn = graph.aliases || graph.knowledge_aliases || []

  const pages = pagesIn.map((p) => normalizePage(p, p.project_id || 'unknown', extractedAt))
  const endpoints = new Map()
  for (const e of epsIn) {
    const ep = normalizeEndpoint(e)
    endpoints.set(ep.id, ep)
  }

  // ensure calls' endpoints exist
  const pageApiCalls = []
  if (callsIn.length) {
    for (const c of callsIn) {
      const page_id = c.page_id || c.pageId
      let endpoint_id = c.endpoint_id || c.endpointId
      if (!endpoint_id && (c.method || c.path)) {
        const key = endpointKey(c.method, c.path)
        let found = [...endpoints.values()].find(
          (e) => endpointKey(e.method, e.path) === key,
        )
        if (!found) {
          found = normalizeEndpoint({
            id: synthEndpointId(c.method, c.path),
            method: c.method,
            path: c.path,
            domain_id: c.domain_id || 'page-derived',
            label_id: c.label_id || `${normMethod(c.method)} ${normPath(c.path)}`,
            repo: c.repo || 'page-derived',
          })
          endpoints.set(found.id, found)
        }
        endpoint_id = found.id
      }
      if (!page_id || !endpoint_id) continue
      pageApiCalls.push({
        page_id,
        endpoint_id,
        evidence: c.evidence != null ? String(c.evidence) : null,
      })
    }
  } else {
    // rebuild from page.api_calls
    for (const p of pagesIn) {
      attachPageCalls(p, p.id, endpoints, pageApiCalls)
    }
  }

  const navEdges = []
  if (navIn.length) {
    for (const e of navIn) {
      const from_page = e.from_page || e.from || e.from_page_id
      const to_page = e.to_page || e.to || e.to_page_id
      if (from_page && to_page) navEdges.push({ from_page, to_page })
    }
  } else {
    for (const p of pagesIn) {
      for (const to of p.nav_to || []) {
        if (to) navEdges.push({ from_page: p.id, to_page: to })
      }
    }
  }

  const aliases = mergeAliases(aliasesIn.map(normalizeAlias).filter(Boolean))
  return { pages, endpoints: [...endpoints.values()], pageApiCalls, navEdges, aliases, extractedAt }
}

function normalizePage(row, projectId, extractedAt) {
  const id = String(row.id || '').slice(0, 191)
  const project_id = String(row.project_id || projectId || 'unknown').slice(0, 64)
  const label_id = String(row.label_id || row.label || id).slice(0, 512)
  const route = String(row.route || row.route_or_screen || row.path || '/').slice(0, 1024)
  const area = row.area != null ? String(row.area).slice(0, 512) : null
  const feature_id =
    row.feature_id != null && row.feature_id !== ''
      ? String(row.feature_id).slice(0, 160)
      : null
  const payload = {
    id,
    project_id,
    label_id,
    route,
    area,
    feature_id,
    api_calls: row.api_calls || [],
    nav_to: row.nav_to || [],
  }
  const source_hash = sha256(stableStringify(payload))
  return {
    id,
    project_id,
    label_id,
    route,
    area,
    feature_id,
    source_hash,
    extracted_at: row.extracted_at || extractedAt,
    _api_calls: row.api_calls || [],
    _nav_to: row.nav_to || [],
  }
}

function normalizeEndpoint(row) {
  const method = normMethod(row.method)
  const pth = normPath(row.path)
  const id = String(row.id || synthEndpointId(method, pth)).slice(0, 191)
  const domain_id =
    row.domain_id != null ? String(row.domain_id).slice(0, 191) : null
  const label_id =
    row.label_id != null
      ? String(row.label_id).slice(0, 512)
      : `${method} ${pth}`.slice(0, 512)
  const repo = row.repo != null ? String(row.repo).slice(0, 191) : null
  const payload = { id, method, path: pth, domain_id, label_id, repo }
  return {
    id,
    method,
    path: pth,
    domain_id,
    label_id,
    repo,
    source_hash: sha256(stableStringify(payload)),
  }
}

function normalizeAlias(row) {
  if (!row) return null
  const alias = String(row.alias || row.from || '').trim()
  const target_type = String(row.target_type || row.type || 'feature').trim()
  const target_id = String(row.target_id || row.to || row.feature_id || '').trim()
  if (!alias || !target_id) return null
  return {
    alias: alias.slice(0, 512),
    target_type: target_type.slice(0, 64),
    target_id: target_id.slice(0, 191),
  }
}

function attachPageCalls(pageRow, pageId, endpointsMap, outCalls) {
  for (const c of pageRow.api_calls || pageRow._api_calls || []) {
    const method = normMethod(c.method)
    const pth = normPath(c.path)
    const key = endpointKey(method, pth)
    let ep = [...endpointsMap.values()].find(
      (e) => endpointKey(e.method, e.path) === key,
    )
    if (!ep) {
      // index by key for speed — rebuild map lookup
      ep = null
    }
    // secondary: maintain key index lazily
    if (!endpointsMap._byKey) {
      endpointsMap._byKey = new Map()
      for (const e of endpointsMap.values()) {
        if (e && e.method) endpointsMap._byKey.set(endpointKey(e.method, e.path), e)
      }
    }
    ep = endpointsMap._byKey.get(key)
    if (!ep) {
      ep = normalizeEndpoint({
        id: synthEndpointId(method, pth),
        method,
        path: pth,
        domain_id: 'page-derived',
        label_id: `${method} ${pth}`,
        repo: 'page-derived',
      })
      endpointsMap.set(ep.id, ep)
      endpointsMap._byKey.set(key, ep)
    }
    const evidence =
      c.evidence != null
        ? typeof c.evidence === 'string'
          ? c.evidence
          : JSON.stringify(c.evidence)
        : c.controller
          ? String(c.controller)
          : c.file
            ? `${c.file}${c.line != null ? `:${c.line}` : ''}`
            : null
    outCalls.push({
      page_id: pageId,
      endpoint_id: ep.id,
      evidence: evidence != null ? String(evidence).slice(0, 65000) : null,
    })
  }
}

function buildFromRaw(pagesIn, endpointsIn) {
  const extractedAt = new Date().toISOString()
  const endpoints = new Map()
  for (const e of endpointsIn) {
    const ep = normalizeEndpoint(e)
    endpoints.set(ep.id, ep)
  }
  // key index
  endpoints._byKey = new Map()
  for (const e of endpoints.values()) {
    endpoints._byKey.set(endpointKey(e.method, e.path), e)
  }

  const pages = []
  const pageApiCalls = []
  const navEdges = []
  const pageIds = new Set()

  for (const row of pagesIn) {
    const p = normalizePage(row, row.project_id, extractedAt)
    if (!p.id || pageIds.has(p.id)) continue
    pageIds.add(p.id)
    pages.push(p)
    attachPageCalls(row, p.id, endpoints, pageApiCalls)
    for (const to of row.nav_to || []) {
      if (to) navEdges.push({ from_page: p.id, to_page: String(to) })
    }
  }

  // drop synthetic helper
  const endpointList = [...endpoints.values()].filter((e) => e && e.id)

  const aliases = mergeAliases(buildSeedAliases())
  return {
    pages,
    endpoints: endpointList,
    pageApiCalls,
    navEdges,
    aliases,
    extractedAt,
  }
}

function mergeAliases(list) {
  const m = new Map()
  for (const a of list) {
    if (!a?.alias) continue
    const key = a.alias.toLowerCase()
    if (!m.has(key)) m.set(key, a)
  }
  return [...m.values()].sort((a, b) => a.alias.localeCompare(b.alias))
}

/**
 * Seed EN↔ID knowledge aliases from product-features.seed.json + fixed owner examples.
 * target_type = 'feature', target_id = FEAT-*
 */
function buildSeedAliases() {
  const out = []
  const push = (alias, featureId) => {
    if (!alias || !featureId) return
    out.push({
      alias: String(alias).trim(),
      target_type: 'feature',
      target_id: featureId,
    })
  }

  // Explicit owner examples + common EN/ID pairs
  const FIXED = [
    ['period tracker', 'FEAT-SIKLUS-HAID'],
    ['period-tracker', 'FEAT-SIKLUS-HAID'],
    ['Period Tracker', 'FEAT-SIKLUS-HAID'],
    ['Pelacak Haid', 'FEAT-SIKLUS-HAID'],
    ['pelacak haid', 'FEAT-SIKLUS-HAID'],
    ['premium', 'FEAT-PAYWALL'],
    ['Premium', 'FEAT-PAYWALL'],
    ['Paywall & Status Premium', 'FEAT-PAYWALL'],
    ['paywall', 'FEAT-PAYWALL'],
    ['Paywall', 'FEAT-PAYWALL'],
    ['meditation', 'FEAT-MEDITATION'],
    ['Meditasi', 'FEAT-MEDITATION'],
    ['fit tracker', 'FEAT-FIT-TRACKER'],
    ['Pelacak Kebugaran', 'FEAT-FIT-TRACKER'],
    ['workout', 'FEAT-WORKOUT'],
    ['Program Latihan', 'FEAT-WORKOUT'],
    ['fasting', 'FEAT-PUASA'],
    ['Puasa Intermiten', 'FEAT-PUASA'],
    ['meal recipe', 'FEAT-MEAL-RECIPE'],
    ['Resep & Rencana Makan', 'FEAT-MEAL-RECIPE'],
    ['home', 'FEAT-HOME-SHELL'],
    ['Beranda & Shell Aplikasi', 'FEAT-HOME-SHELL'],
    ['affiliate', 'FEAT-AFFILIATE'],
    ['Afiliasi Non-Reseller', 'FEAT-AFFILIATE'],
  ]
  for (const [a, id] of FIXED) push(a, id)

  const seed = readJson(SEED_PATH)
  if (seed?.features) {
    for (const f of seed.features) {
      const id = f.feature_id
      if (!id) continue
      if (f.nama_id) push(f.nama_id, id)
      push(id, id)
      for (const k of f.join?.keywords || []) push(k, id)
      for (const k of f.join?.id_includes || []) push(String(k).toLowerCase(), id)
    }
  }

  // Design-canon features-*.json (nama_id already ID)
  for (const d of resolveUltimateDirs()) {
    // parent of ultimate often has features-*.json
    const parent = path.dirname(d)
    for (const base of [d, parent, DESIGN_DATA]) {
      if (!fs.existsSync(base)) continue
      let files
      try {
        files = fs.readdirSync(base).filter((f) => f.startsWith('features-') && f.endsWith('.json'))
      } catch {
        continue
      }
      for (const file of files) {
        const doc = readJson(path.join(base, file))
        for (const feat of doc?.features || []) {
          const id = feat.id || feat.feature_id
          if (!id) continue
          if (feat.nama_id) push(feat.nama_id, id)
          push(id, id)
        }
      }
    }
  }

  return out
}

// ─── SQL generation ──────────────────────────────────────────────────────────

function loadMigration012() {
  const p = path.join(ROOT, 'migrations', '012_ultimate_map.sql')
  const t = readText(p)
  if (!t) throw new Error(`missing migration ${p}`)
  return t
}

function generateBundleSql(model) {
  const lines = []
  lines.push('-- upload-bundle.sql — ultimate map one-shot (owner-gated production apply LATER)')
  lines.push(`-- generated_at: ${new Date().toISOString()}`)
  lines.push(`-- pages=${model.pages.length} endpoints=${model.endpoints.length} page_api_calls=${model.pageApiCalls.length} nav_edges=${model.navEdges.length} aliases=${model.aliases.length}`)
  lines.push('-- SAFE: additive upserts only; source_hash idempotent')
  lines.push('SET NAMES utf8mb4;')
  lines.push('START TRANSACTION;')
  lines.push('')
  lines.push('-- schema (idempotent)')
  lines.push(loadMigration012().trim())
  lines.push('')

  lines.push('-- app_pages')
  for (const p of model.pages) {
    lines.push(
      `INSERT INTO app_pages (id, project_id, label_id, route, area, feature_id, source_hash, extracted_at) VALUES (${sqlStr(p.id)}, ${sqlStr(p.project_id)}, ${sqlStr(p.label_id)}, ${sqlStr(p.route)}, ${sqlStr(p.area)}, ${sqlStr(p.feature_id)}, ${sqlStr(p.source_hash)}, ${sqlDt(p.extracted_at)}) ON DUPLICATE KEY UPDATE label_id=IF(source_hash=VALUES(source_hash), label_id, VALUES(label_id)), project_id=IF(source_hash=VALUES(source_hash), project_id, VALUES(project_id)), route=IF(source_hash=VALUES(source_hash), route, VALUES(route)), area=IF(source_hash=VALUES(source_hash), area, VALUES(area)), feature_id=IF(source_hash=VALUES(source_hash), feature_id, VALUES(feature_id)), extracted_at=IF(source_hash=VALUES(source_hash), extracted_at, VALUES(extracted_at)), source_hash=IF(source_hash=VALUES(source_hash), source_hash, VALUES(source_hash));`,
    )
  }

  lines.push('')
  lines.push('-- api_endpoints')
  for (const e of model.endpoints) {
    lines.push(
      `INSERT INTO api_endpoints (id, method, path, domain_id, label_id, repo, source_hash) VALUES (${sqlStr(e.id)}, ${sqlStr(e.method)}, ${sqlStr(e.path)}, ${sqlStr(e.domain_id)}, ${sqlStr(e.label_id)}, ${sqlStr(e.repo)}, ${sqlStr(e.source_hash)}) ON DUPLICATE KEY UPDATE method=IF(source_hash=VALUES(source_hash), method, VALUES(method)), path=IF(source_hash=VALUES(source_hash), path, VALUES(path)), domain_id=IF(source_hash=VALUES(source_hash), domain_id, VALUES(domain_id)), label_id=IF(source_hash=VALUES(source_hash), label_id, VALUES(label_id)), repo=IF(source_hash=VALUES(source_hash), repo, VALUES(repo)), source_hash=IF(source_hash=VALUES(source_hash), source_hash, VALUES(source_hash));`,
    )
  }

  lines.push('')
  lines.push('-- page_api_calls')
  for (const c of model.pageApiCalls) {
    lines.push(
      `INSERT INTO page_api_calls (page_id, endpoint_id, evidence) VALUES (${sqlStr(c.page_id)}, ${sqlStr(c.endpoint_id)}, ${sqlStr(c.evidence)}) ON DUPLICATE KEY UPDATE evidence=VALUES(evidence);`,
    )
  }

  lines.push('')
  lines.push('-- nav_edges')
  for (const e of model.navEdges) {
    lines.push(
      `INSERT IGNORE INTO nav_edges (from_page, to_page) VALUES (${sqlStr(e.from_page)}, ${sqlStr(e.to_page)});`,
    )
  }

  lines.push('')
  lines.push('-- knowledge_aliases')
  for (const a of model.aliases) {
    lines.push(
      `INSERT INTO knowledge_aliases (alias, target_type, target_id) VALUES (${sqlStr(a.alias)}, ${sqlStr(a.target_type)}, ${sqlStr(a.target_id)}) ON DUPLICATE KEY UPDATE target_type=VALUES(target_type), target_id=VALUES(target_id);`,
    )
  }

  lines.push('')
  lines.push('COMMIT;')
  return lines.join('\n') + '\n'
}

// ─── in-memory upsert (pass-2 zero-write proof) ──────────────────────────────

/**
 * Simulate DB store with source_hash idempotency.
 * Returns write counts for pass.
 */
function memoryUpsert(store, model) {
  let writes = 0
  const pageStore = store.pages
  for (const p of model.pages) {
    const prev = pageStore.get(p.id)
    if (prev && prev.source_hash === p.source_hash) continue
    pageStore.set(p.id, { ...p })
    writes++
  }
  for (const e of model.endpoints) {
    const prev = store.endpoints.get(e.id)
    if (prev && prev.source_hash === e.source_hash) continue
    store.endpoints.set(e.id, { ...e })
    writes++
  }
  for (const c of model.pageApiCalls) {
    const k = `${c.page_id}\0${c.endpoint_id}`
    const prev = store.calls.get(k)
    if (prev && prev.evidence === c.evidence) continue
    store.calls.set(k, { ...c })
    writes++
  }
  for (const e of model.navEdges) {
    const k = `${e.from_page}\0${e.to_page}`
    if (store.nav.has(k)) continue
    store.nav.set(k, { ...e })
    writes++
  }
  for (const a of model.aliases) {
    const key = a.alias.toLowerCase()
    const prev = store.aliases.get(key)
    if (
      prev &&
      prev.target_type === a.target_type &&
      prev.target_id === a.target_id
    ) {
      continue
    }
    store.aliases.set(key, { ...a })
    writes++
  }
  return writes
}

function newStore() {
  return {
    pages: new Map(),
    endpoints: new Map(),
    calls: new Map(),
    nav: new Map(),
    aliases: new Map(),
  }
}

// ─── DB apply (local only) ───────────────────────────────────────────────────

async function applyToDb(model) {
  const host = env('CAIRN_DB_HOST', '127.0.0.1')
  assertDbHostSafe(host)

  const port = Number(env('CAIRN_DB_PORT', '3306'))
  const user = env('CAIRN_DB_USER', 'root')
  const password = env('CAIRN_DB_PASSWORD', '')
  const database = env('CAIRN_DB_NAME', 'cairn_taskmanager')

  // never log password/token
  console.log(`[db] connecting host=${host} port=${port} database=${database} user=${user ? '(set)' : '(empty)'}`)

  let mysql
  try {
    mysql = await import('mysql2/promise')
  } catch (e) {
    throw new Error(`mysql2 unavailable: ${e.message}`)
  }

  let conn
  try {
    conn = await mysql.createConnection({
      host,
      port,
      user,
      password,
      database,
      multipleStatements: true,
      connectTimeout: 8_000,
    })
  } catch (e) {
    throw new Error(
      `Local DB connect failed (${e.code || e.message}). Use --dry-run or --bundle. No production fallback.`,
    )
  }

  const stats = {
    pages_written: 0,
    pages_skipped: 0,
    endpoints_written: 0,
    endpoints_skipped: 0,
    calls_written: 0,
    nav_written: 0,
    aliases_written: 0,
  }

  try {
    await conn.query(loadMigration012())

    for (const p of model.pages) {
      const [rows] = await conn.query(
        'SELECT source_hash FROM app_pages WHERE id = ? LIMIT 1',
        [p.id],
      )
      if (rows[0]?.source_hash === p.source_hash) {
        stats.pages_skipped++
        continue
      }
      await conn.query(
        `INSERT INTO app_pages (id, project_id, label_id, route, area, feature_id, source_hash, extracted_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           project_id=VALUES(project_id), label_id=VALUES(label_id), route=VALUES(route),
           area=VALUES(area), feature_id=VALUES(feature_id), source_hash=VALUES(source_hash),
           extracted_at=VALUES(extracted_at)`,
        [
          p.id,
          p.project_id,
          p.label_id,
          p.route,
          p.area,
          p.feature_id,
          p.source_hash,
          new Date(p.extracted_at),
        ],
      )
      stats.pages_written++
    }

    for (const e of model.endpoints) {
      const [rows] = await conn.query(
        'SELECT source_hash FROM api_endpoints WHERE id = ? LIMIT 1',
        [e.id],
      )
      if (rows[0]?.source_hash === e.source_hash) {
        stats.endpoints_skipped++
        continue
      }
      await conn.query(
        `INSERT INTO api_endpoints (id, method, path, domain_id, label_id, repo, source_hash)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           method=VALUES(method), path=VALUES(path), domain_id=VALUES(domain_id),
           label_id=VALUES(label_id), repo=VALUES(repo), source_hash=VALUES(source_hash)`,
        [e.id, e.method, e.path, e.domain_id, e.label_id, e.repo, e.source_hash],
      )
      stats.endpoints_written++
    }

    for (const c of model.pageApiCalls) {
      const [res] = await conn.query(
        `INSERT INTO page_api_calls (page_id, endpoint_id, evidence)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE evidence=VALUES(evidence)`,
        [c.page_id, c.endpoint_id, c.evidence],
      )
      if (res.affectedRows > 0) stats.calls_written++
    }

    for (const e of model.navEdges) {
      const [res] = await conn.query(
        `INSERT IGNORE INTO nav_edges (from_page, to_page) VALUES (?, ?)`,
        [e.from_page, e.to_page],
      )
      if (res.affectedRows > 0) stats.nav_written++
    }

    for (const a of model.aliases) {
      const [res] = await conn.query(
        `INSERT INTO knowledge_aliases (alias, target_type, target_id)
         VALUES (?, ?, ?)
         ON DUPLICATE KEY UPDATE target_type=VALUES(target_type), target_id=VALUES(target_id)`,
        [a.alias, a.target_type, a.target_id],
      )
      if (res.affectedRows > 0) stats.aliases_written++
    }

    return stats
  } finally {
    await conn.end()
  }
}

// ─── summary ─────────────────────────────────────────────────────────────────

function printSummary(model, extra = {}) {
  const byProject = {}
  for (const p of model.pages) {
    byProject[p.project_id] = (byProject[p.project_id] || 0) + 1
  }
  const summary = {
    mode: extra.mode || 'dry-run',
    source_kind: extra.source_kind,
    sources: extra.sources || [],
    counts: {
      app_pages: model.pages.length,
      api_endpoints: model.endpoints.length,
      page_api_calls: model.pageApiCalls.length,
      nav_edges: model.navEdges.length,
      knowledge_aliases: model.aliases.length,
      pages_by_project: byProject,
    },
    pass1_writes: extra.pass1_writes ?? null,
    pass2_writes: extra.pass2_writes ?? null,
    pass2_zero_write: extra.pass2_writes === 0,
    bundle_path: extra.bundle_path || null,
    bundle_lines: extra.bundle_lines ?? null,
    db_stats: extra.db_stats || null,
  }
  console.log(JSON.stringify(summary, null, 2))
  console.log(
    `[ingest-ultimate] pages=${summary.counts.app_pages} endpoints=${summary.counts.api_endpoints} calls=${summary.counts.page_api_calls} nav=${summary.counts.nav_edges} aliases=${summary.counts.knowledge_aliases} pass2_writes=${summary.pass2_writes}`,
  )
  return summary
}

// ─── main ────────────────────────────────────────────────────────────────────

/**
 * Collapse join-table rows so pass-2 is zero-write (last-wins for evidence).
 * Without this, conflicting evidence on the same (page,endpoint) oscillates writes.
 */
function finalizeModel(model) {
  const callMap = new Map()
  for (const c of model.pageApiCalls) {
    if (!c?.page_id || !c?.endpoint_id) continue
    callMap.set(`${c.page_id}\0${c.endpoint_id}`, {
      page_id: c.page_id,
      endpoint_id: c.endpoint_id,
      evidence: c.evidence != null ? String(c.evidence) : null,
    })
  }
  const navMap = new Map()
  for (const e of model.navEdges) {
    if (!e?.from_page || !e?.to_page) continue
    navMap.set(`${e.from_page}\0${e.to_page}`, {
      from_page: e.from_page,
      to_page: e.to_page,
    })
  }
  model.pageApiCalls = [...callMap.values()]
  model.navEdges = [...navMap.values()]
  model.aliases = mergeAliases(model.aliases || [])
  return model
}

export function buildModel() {
  const src = loadGraphOrRaw()
  if (src.kind === 'graph') {
    const model = buildFromGraph(src.graph)
    // still merge seed aliases
    model.aliases = mergeAliases([
      ...model.aliases,
      ...buildSeedAliases(),
    ])
    return {
      model: finalizeModel(model),
      source_kind: 'graph',
      sources: [src.path],
    }
  }
  const model = finalizeModel(buildFromRaw(src.pages, src.endpoints))
  return { model, source_kind: 'raw', sources: src.sources }
}

export function runDry(model) {
  const store = newStore()
  const pass1 = memoryUpsert(store, model)
  const pass2 = memoryUpsert(store, model)
  return { pass1_writes: pass1, pass2_writes: pass2 }
}

async function main() {
  const { model, source_kind, sources } = buildModel()
  const { pass1_writes, pass2_writes } = runDry(model)

  let bundle_path = null
  let bundle_lines = null
  let db_stats = null
  let mode = 'dry-run'

  if (wantBundle) {
    mode = wantDb ? 'bundle+db' : 'bundle'
    fs.mkdirSync(LOCAL_ULTIMATE, { recursive: true })
    const sql = generateBundleSql(model)
    fs.writeFileSync(BUNDLE_PATH, sql, 'utf8')
    bundle_path = BUNDLE_PATH
    bundle_lines = sql.split('\n').length
    console.log(`[bundle] wrote ${BUNDLE_PATH} lines=${bundle_lines}`)
  }

  if (wantDb) {
    mode = wantBundle ? 'bundle+db' : 'db'
    try {
      db_stats = await applyToDb(model)
      // pass-2 on DB
      const pass2db = await applyToDb(model)
      db_stats.pass2 = pass2db
    } catch (e) {
      console.error(`[db] ${e.message}`)
      if (!wantBundle && wantDry === false) {
        // if user only asked --db and it failed, still exit non-zero
        printSummary(model, {
          mode: 'db-failed',
          source_kind,
          sources,
          pass1_writes,
          pass2_writes,
        })
        process.exit(1)
      }
      console.error('[db] continuing with dry-run/bundle only (no production fallback)')
    }
  }

  if (wantDry || (!wantDb && !wantBundle)) {
    // dry-run path always exercised for counts
  }

  printSummary(model, {
    mode,
    source_kind,
    sources,
    pass1_writes,
    pass2_writes,
    bundle_path,
    bundle_lines,
    db_stats,
  })

  if (pass2_writes !== 0) {
    console.error('[fail] pass-2 expected zero writes')
    process.exit(1)
  }
  process.exit(0)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main().catch((e) => {
    console.error('[ingest-ultimate] fatal:', e.message || e)
    process.exit(1)
  })
}
