#!/usr/bin/env node
/**
 * F2-WF-0 / TM-SALVAGE-APP-FLOW-INGEST — ingest per-project app navigation flow graphs.
 *
 * File-only extraction + validation. Does NOT touch DB. Does NOT INSERT.
 * Does NOT apply migrations. Does NOT git write. Does NOT mutate sibling product repos
 * (read-only when present). Does NOT print secrets.
 *
 * Reads (READ-ONLY, when present under --ws-root):
 *   - legacy/rn-mfs81 Navigations.js + lazyScreens
 *   - mfs-web / sales-rebuild / affiliate-rebuild App Router page.tsx trees
 *   - rebuild-backend routes/api/*.php domain files
 *   - data/product-features.seed.json (feature soft-ref map)
 *   - optional F1 fallback: APP_FLOW_F1_FALLBACK or default preview path
 *
 * Writes (only when not --dry-run):
 *   - <out-dir>/<project>.json  { nodes[], edges[], stats, source_hash }
 *
 * Usage:
 *   node scripts/ingest-app-flow.mjs --help
 *   node scripts/ingest-app-flow.mjs --dry-run
 *   node scripts/ingest-app-flow.mjs --self-test
 *   node scripts/ingest-app-flow.mjs --out-dir /tmp/app-flow --ws-root /path/to/workspace
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '..')
const DEFAULT_WS = path.resolve(ROOT, '..')
const DEFAULT_OUT = path.join(ROOT, 'data', 'app-flow')
const DEFAULT_SEED = path.join(ROOT, 'data', 'product-features.seed.json')
const DEFAULT_F1 =
  process.env.APP_FLOW_F1_FALLBACK ||
  '/home/user/.claude/jobs/3c5adda9/tmp/tm-wave0/preview/app-data.json'

export const PROJECTS = ['rn', 'web', 'sales', 'affiliate', 'backend']

/** Soft aliases → canonical project_id (mirrors src/lib/app-flow-types.ts). */
export const PROJECT_ALIASES = {
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

const FEATURE_SOFT_RE = /^FEAT-[A-Z0-9][A-Z0-9_-]*$/
const NODE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/
const EDGE_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,190}$/

// ─── CLI ─────────────────────────────────────────────────────────────────────

export function parseArgs(argv = process.argv.slice(2)) {
  const opts = {
    help: false,
    dryRun: false,
    selfTest: false,
    outDir: DEFAULT_OUT,
    wsRoot: DEFAULT_WS,
    seedPath: DEFAULT_SEED,
    f1Fallback: DEFAULT_F1,
    projects: [...PROJECTS],
    generatedAt: process.env.APP_FLOW_GENERATED_AT || null,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--help' || a === '-h') opts.help = true
    else if (a === '--dry-run') opts.dryRun = true
    else if (a === '--self-test') opts.selfTest = true
    else if (a === '--out-dir') opts.outDir = path.resolve(argv[++i] || '')
    else if (a === '--ws-root') opts.wsRoot = path.resolve(argv[++i] || '')
    else if (a === '--seed') opts.seedPath = path.resolve(argv[++i] || '')
    else if (a === '--f1-fallback') opts.f1Fallback = path.resolve(argv[++i] || '')
    else if (a === '--projects') {
      const raw = argv[++i] || ''
      opts.projects = raw
        .split(',')
        .map((s) => s.trim())
        .filter(Boolean)
        .map((s) => resolveProjectAlias(s) || s)
    } else if (a === '--generated-at') opts.generatedAt = argv[++i] || null
    else if (a.startsWith('-')) {
      throw new Error(`unknown flag: ${a}`)
    }
  }
  return opts
}

export function printHelp() {
  const text = `Usage: node scripts/ingest-app-flow.mjs [options]

File-only app-flow extraction for rn/web/sales/affiliate/backend.
No DB writes. No secrets. Sibling product repos are read-only when present.

Options:
  --help, -h          Show this help
  --dry-run           Build + validate; do not write JSON files
  --self-test         Build mini fixtures under a temp dir, validate, exit
  --out-dir <path>    Output directory (default: data/app-flow)
  --ws-root <path>    Workspace root containing product repos (default: parent of TM)
  --seed <path>       product-features.seed.json path
  --f1-fallback <path> Optional F1 app-data.json fallback
  --projects <list>   Comma-separated project ids/aliases (default: all five)
  --generated-at <iso> Pin generated_at for deterministic output (or APP_FLOW_GENERATED_AT)

Environment:
  APP_FLOW_GENERATED_AT   ISO timestamp pin (excluded from source_hash)
  APP_FLOW_F1_FALLBACK    Override default F1 preview path
`
  console.log(text)
  return text
}

// ─── utils ───────────────────────────────────────────────────────────────────

export function resolveProjectAlias(input) {
  const key = String(input || '')
    .trim()
    .toLowerCase()
  if (!key) return null
  if (PROJECTS.includes(key)) return key
  return PROJECT_ALIASES[key] || null
}

export function readText(p) {
  try {
    return fs.readFileSync(p, 'utf8')
  } catch {
    return null
  }
}

export function readJson(p) {
  const t = readText(p)
  if (!t) return null
  try {
    return JSON.parse(t)
  } catch {
    return null
  }
}

export function walkFiles(dir, pred, acc = []) {
  if (!fs.existsSync(dir)) return acc
  let entries
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true })
  } catch {
    return acc
  }
  for (const ent of entries) {
    if (ent.name === 'node_modules' || ent.name === '.git' || ent.name === 'dist')
      continue
    const full = path.join(dir, ent.name)
    if (ent.isDirectory()) walkFiles(full, pred, acc)
    else if (pred(full, ent.name)) acc.push(full)
  }
  return acc
}

export function slugify(s) {
  return String(s)
    .trim()
    .replace(/[^a-zA-Z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 160)
}

export function normKey(s) {
  return String(s || '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '')
}

export function edgeId(from, to, kind = 'nav') {
  return slugify(`${from}__${to}__${kind}`).slice(0, 191)
}

export function sha256(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex')
}

/** Deterministic JSON stringify with sorted object keys. */
export function stableStringify(value) {
  return JSON.stringify(sortKeysDeep(value))
}

function sortKeysDeep(value) {
  if (Array.isArray(value)) return value.map(sortKeysDeep)
  if (value && typeof value === 'object') {
    const out = {}
    for (const k of Object.keys(value).sort()) {
      out[k] = sortKeysDeep(value[k])
    }
    return out
  }
  return value
}

/**
 * source_hash over stable payload excluding generated_at (volatile clock).
 */
export function computeSourceHash(flow) {
  const payload = {
    project_id: flow.project_id,
    version: flow.version,
    source: flow.source,
    nodes: (flow.nodes || []).map((n) => ({
      node_id: n.node_id,
      feature_id: n.feature_id ?? null,
      label_id: n.label_id,
      kind: n.kind,
      sort_order: n.sort_order,
      layout_col: n.layout_col,
      layout_row: n.layout_row,
      source_ref: n.source_ref ?? null,
      meta: n.meta ?? null,
    })),
    edges: (flow.edges || []).map((e) => ({
      edge_id: e.edge_id,
      from_node: e.from_node,
      to_node: e.to_node,
      edge_kind: e.edge_kind,
      sort_order: e.sort_order ?? 0,
      meta: e.meta ?? null,
    })),
    stats: flow.stats ?? null,
  }
  return sha256(stableStringify(payload))
}

// ─── product feature mapper ──────────────────────────────────────────────────

export function loadFeatureIndex(seedPath = DEFAULT_SEED) {
  const seed = readJson(seedPath)
  if (!seed?.features) {
    return []
  }
  return seed.features.map((f) => {
    const tokens = new Set()
    for (const x of f.join?.id_includes || []) tokens.add(normKey(x))
    for (const x of f.join?.keywords || []) tokens.add(normKey(x))
    tokens.add(normKey(f.feature_id))
    tokens.add(normKey(f.nama_id))
    const platforms = f.platform_json || {}
    return {
      feature_id: f.feature_id,
      nama_id: f.nama_id,
      tokens: [...tokens].filter(Boolean),
      platforms,
    }
  })
}

/**
 * Map a screen/route label to product feature_id when confidence is high enough.
 * Returns null when unmapped (honest screen-only node). Soft ref only — no DB FK.
 */
export function mapToFeature(label, featureIndex, projectId) {
  const key = normKey(label)
  if (!key || key.length < 3) return null

  const platformGate = {
    rn: (p) => p.rn === true,
    web: (p) => p.web === true || p.backend === true,
    sales: (p) => p.admin === true || p.backend === true,
    affiliate: (p) => p.web === true || p.admin === true || p.backend === true,
    backend: (p) => p.backend === true || p.admin === true || p.jobs === true,
  }
  const gate = platformGate[projectId] || (() => true)

  let best = null
  let bestScore = 0
  for (const f of featureIndex) {
    if (!gate(f.platforms || {})) continue
    let score = 0
    for (const t of f.tokens) {
      if (!t || t.length < 3) continue
      if (key === t) score = Math.max(score, 100)
      else if (key.includes(t) && t.length >= 4) score = Math.max(score, 40 + t.length)
      else if (t.includes(key) && key.length >= 5) score = Math.max(score, 30 + key.length)
    }
    if (score > bestScore) {
      bestScore = score
      best = f.feature_id
    }
  }
  if (bestScore < 35) return null
  return best
}

// Strong manual aliases for known nav screens → product features (soft refs)
export const SCREEN_FEATURE_ALIASES = {
  Login: 'FEAT-AUTH-MEMBER',
  Register: 'FEAT-AUTH-MEMBER',
  RegisterPersonalizedContent: 'FEAT-AUTH-MEMBER',
  OnboardingPage: 'FEAT-AUTH-MEMBER',
  ForgotPassword: 'FEAT-AUTH-MEMBER',
  OTP: 'FEAT-AUTH-MEMBER',
  SocialRegistration: 'FEAT-AUTH-MEMBER',
  SelectFeatures: 'FEAT-AUTH-MEMBER',
  SelectLocation: 'FEAT-AUTH-MEMBER',
  EditFeatures: 'FEAT-AUTH-MEMBER',
  setPassword: 'FEAT-AUTH-MEMBER',
  resetPassword: 'FEAT-AUTH-MEMBER',
  activationFail: 'FEAT-AUTH-MEMBER',
  ChangeRegistrationEmail: 'FEAT-AUTH-MEMBER',
  Home: 'FEAT-HOME-SHELL',
  homepageGuess: 'FEAT-HOME-SHELL',
  HomeComplete: 'FEAT-HOME-SHELL',
  Dashboard: 'FEAT-HOME-SHELL',
  FitTrackerHome: 'FEAT-FIT-TRACKER',
  FitTrackerStats: 'FEAT-FIT-TRACKER',
  fitTrackerFull: 'FEAT-FIT-TRACKER',
  fitTrackerGuide: 'FEAT-FIT-TRACKER',
  fitTrackerSetting: 'FEAT-FIT-TRACKER',
  fittrackerReminder: 'FEAT-FIT-TRACKER',
  setGoal: 'FEAT-FIT-TRACKER',
  addNutrition: 'FEAT-FIT-TRACKER',
  stepTracker: 'FEAT-FIT-TRACKER',
  exerciseSlidePage: 'FEAT-WORKOUT',
  discoverWorkout: 'FEAT-WORKOUT',
  workoutDetail: 'FEAT-WORKOUT',
  workoutHistory: 'FEAT-WORKOUT',
  workoutSummary: 'FEAT-WORKOUT',
  workoutPlay: 'FEAT-WORKOUT',
  scheduleWorkout: 'FEAT-WORKOUT',
  meditation: 'FEAT-MEDITATION',
  meditationDetail: 'FEAT-MEDITATION',
  meditationPlayer: 'FEAT-MEDITATION',
  meditationList: 'FEAT-MEDITATION',
  sleepMusic: 'FEAT-MEDITATION',
  musicOption: 'FEAT-MEDITATION',
  bubbleBreath: 'FEAT-RELAKSASI',
  bubbleBreathDetail: 'FEAT-RELAKSASI',
  bubbleBreathPlaying: 'FEAT-RELAKSASI',
  PeriodTracker: 'FEAT-SIKLUS-HAID',
  PeriodTrackerIntro: 'FEAT-SIKLUS-HAID',
  PeriodChooseCycle: 'FEAT-SIKLUS-HAID',
  foodDatabase: 'FEAT-MEAL-RECIPE',
  recipeList: 'FEAT-MEAL-RECIPE',
  recipeDetail: 'FEAT-MEAL-RECIPE',
  MealPlan: 'FEAT-MEAL-RECIPE',
  CreateRecipe: 'FEAT-MEAL-RECIPE',
  mainProgress: 'FEAT-PROGRESS-TUBUH',
  addProgress: 'FEAT-PROGRESS-TUBUH',
  progressDetail: 'FEAT-PROGRESS-TUBUH',
  challengeDetail: 'FEAT-CHALLENGE',
  ChallengeList: 'FEAT-CHALLENGE',
  ChallengeDetailV2: 'FEAT-CHALLENGE',
  landingPremium: 'FEAT-PAYWALL',
  FreeTrial: 'FEAT-AKSES-GRATIS',
  paymentScreen: 'FEAT-PAYWALL',
  intermittentDiscover: 'FEAT-PUASA',
  yourFasting: 'FEAT-PUASA',
  fastingDetail: 'FEAT-PUASA',
  about: 'FEAT-PROFIL-PRIVASI',
  settings: 'FEAT-PROFIL-PRIVASI',
  personal_edit: 'FEAT-PROFIL-PRIVASI',
  CorporateWellnessMenu: 'FEAT-KORPORAT-HR',
  pointLeaderboard: 'FEAT-POIN-LEADERBOARD',
}

export function resolveFeatureId(label, featureIndex, projectId) {
  if (SCREEN_FEATURE_ALIASES[label]) return SCREEN_FEATURE_ALIASES[label]
  const hit = Object.entries(SCREEN_FEATURE_ALIASES).find(
    ([k]) => k.toLowerCase() === String(label).toLowerCase(),
  )
  if (hit) return hit[1]
  return mapToFeature(label, featureIndex, projectId)
}

// ─── layout + build ──────────────────────────────────────────────────────────

export function assignLayout(nodes, edges) {
  const indeg = new Map(nodes.map((n) => [n.node_id, 0]))
  const adj = new Map(nodes.map((n) => [n.node_id, []]))
  for (const e of edges) {
    if (!indeg.has(e.from_node) || !indeg.has(e.to_node)) continue
    indeg.set(e.to_node, (indeg.get(e.to_node) || 0) + 1)
    adj.get(e.from_node).push(e.to_node)
  }
  const col = new Map()
  const roots = nodes.filter((n) => (indeg.get(n.node_id) || 0) === 0)
  const q = roots.map((n) => n.node_id).sort()
  for (const r of q) col.set(r, 0)
  let qi = 0
  while (qi < q.length) {
    const cur = q[qi++]
    const c = col.get(cur) ?? 0
    const nexts = [...(adj.get(cur) || [])].sort()
    for (const nxt of nexts) {
      const prev = col.get(nxt)
      if (prev == null || c + 1 > prev) {
        col.set(nxt, c + 1)
        q.push(nxt)
      }
    }
  }
  const rows = new Map()
  const ordered = [...nodes].sort((a, b) => a.node_id.localeCompare(b.node_id))
  for (const n of ordered) {
    const c = col.get(n.node_id) ?? 0
    const r = rows.get(c) ?? 0
    rows.set(c, r + 1)
    n.layout_col = c
    n.layout_row = r
  }
  ordered
    .sort(
      (a, b) =>
        a.layout_col - b.layout_col ||
        a.layout_row - b.layout_row ||
        a.node_id.localeCompare(b.node_id),
    )
    .forEach((n, i) => {
      n.sort_order = i
    })
  return ordered
}

export function buildFlow(
  projectId,
  source,
  nodeSpecs,
  edgeSpecs,
  featureIndex,
  options = {},
) {
  const canonical = resolveProjectAlias(projectId) || projectId
  const nodeMap = new Map()
  for (const spec of nodeSpecs) {
    const node_id = slugify(spec.node_id || spec.id || spec.label)
    if (!node_id || nodeMap.has(node_id)) continue
    const label_id = spec.label_id || spec.label || node_id
    const feature_id =
      spec.feature_id !== undefined
        ? spec.feature_id
        : resolveFeatureId(label_id, featureIndex, canonical) ||
          resolveFeatureId(node_id, featureIndex, canonical)
    const finalKind = !feature_id
      ? 'screen'
      : spec.kind === 'feature'
        ? 'feature'
        : 'screen'
    nodeMap.set(node_id, {
      node_id,
      feature_id: feature_id || null,
      label_id,
      kind: finalKind,
      sort_order: 0,
      layout_col: 0,
      layout_row: 0,
      source_ref: spec.source_ref || null,
      meta: spec.meta || null,
    })
  }

  const edges = []
  const edgeSeen = new Set()
  const pairSeen = new Set()
  for (const e of edgeSpecs) {
    const from = slugify(e.from_node || e.from)
    const to = slugify(e.to_node || e.to)
    if (!from || !to || from === to) continue
    if (!nodeMap.has(from) || !nodeMap.has(to)) continue
    const edge_kind = e.edge_kind || e.kind || 'nav'
    const id = e.edge_id || edgeId(from, to, edge_kind)
    if (edgeSeen.has(id)) continue
    const pairKey = `${from}\0${to}\0${edge_kind}`
    if (pairSeen.has(pairKey)) continue
    edgeSeen.add(id)
    pairSeen.add(pairKey)
    edges.push({
      edge_id: id,
      from_node: from,
      to_node: to,
      edge_kind,
      sort_order: 0,
      meta: e.meta || null,
    })
  }

  // Stable edge order before layout sort_order assignment
  edges.sort(
    (a, b) =>
      a.from_node.localeCompare(b.from_node) ||
      a.to_node.localeCompare(b.to_node) ||
      a.edge_kind.localeCompare(b.edge_kind) ||
      a.edge_id.localeCompare(b.edge_id),
  )
  edges.forEach((e, i) => {
    e.sort_order = i
  })

  const nodes = assignLayout([...nodeMap.values()], edges)
  const mapped = nodes.filter((n) => n.feature_id).length
  const unmapped = nodes.length - mapped
  const featureIds = [
    ...new Set(nodes.map((n) => n.feature_id).filter(Boolean)),
  ].sort()

  const generated_at =
    options.generatedAt ||
    process.env.APP_FLOW_GENERATED_AT ||
    new Date().toISOString()

  const flow = {
    project_id: canonical,
    version: 1,
    source,
    generated_at,
    nodes,
    edges,
    stats: {
      nodes: nodes.length,
      edges: edges.length,
      mapped_features: mapped,
      unmapped_screens: unmapped,
      feature_ids: featureIds,
    },
  }
  flow.source_hash = computeSourceHash(flow)
  return flow
}

/**
 * Validate flow contract (node/edge ids, project alias, feature soft refs, dupes).
 */
export function validateFlow(flow, opts = {}) {
  const minNodes = opts.minNodes ?? 5
  const issues = []
  if (!flow || typeof flow !== 'object') {
    return { ok: false, issues: [{ code: 'not_object', message: 'flow is not an object' }] }
  }
  if (typeof flow.project_id !== 'string' || !resolveProjectAlias(flow.project_id)) {
    issues.push({
      code: 'project_alias',
      message: `unknown/missing project_id: ${flow?.project_id}`,
    })
  } else if (flow.project_id !== resolveProjectAlias(flow.project_id)) {
    issues.push({
      code: 'project_alias_noncanonical',
      message: `project_id must be canonical`,
    })
  }
  if (!Array.isArray(flow.nodes) || !Array.isArray(flow.edges)) {
    issues.push({ code: 'arrays', message: 'nodes and edges must be arrays' })
    return { ok: false, issues }
  }
  if (flow.nodes.length < minNodes) {
    issues.push({
      code: 'min_nodes',
      message: `nodes ${flow.nodes.length} < ${minNodes}`,
    })
  }
  const nodeIds = new Set()
  for (const n of flow.nodes) {
    if (!n?.node_id || !NODE_ID_RE.test(n.node_id)) {
      issues.push({ code: 'node_id', message: `bad node_id ${n?.node_id}` })
      continue
    }
    if (nodeIds.has(n.node_id)) {
      issues.push({ code: 'duplicate_node', message: n.node_id })
    }
    nodeIds.add(n.node_id)
    if (n.feature_id != null && !FEATURE_SOFT_RE.test(n.feature_id)) {
      issues.push({
        code: 'feature_soft_ref',
        message: `bad feature_id ${n.feature_id}`,
      })
    }
    if (n.feature_id == null && n.kind === 'feature') {
      issues.push({
        code: 'feature_soft_ref',
        message: `kind=feature without feature_id on ${n.node_id}`,
      })
    }
  }
  const edgeIds = new Set()
  const pairs = new Set()
  for (const e of flow.edges) {
    if (!e?.edge_id || !EDGE_ID_RE.test(e.edge_id)) {
      issues.push({ code: 'edge_id', message: `bad edge_id ${e?.edge_id}` })
      continue
    }
    if (edgeIds.has(e.edge_id)) {
      issues.push({ code: 'duplicate_edge_id', message: e.edge_id })
    }
    edgeIds.add(e.edge_id)
    if (!nodeIds.has(e.from_node) || !nodeIds.has(e.to_node)) {
      issues.push({
        code: 'edge_endpoint',
        message: `${e.edge_id} bad endpoints`,
      })
    }
    const pk = `${e.from_node}\0${e.to_node}\0${e.edge_kind}`
    if (pairs.has(pk)) {
      issues.push({
        code: 'duplicate_edge',
        message: `${e.from_node}→${e.to_node}`,
      })
    }
    pairs.add(pk)
  }
  if (typeof flow.source_hash !== 'string' || !/^[a-f0-9]{64}$/.test(flow.source_hash)) {
    issues.push({ code: 'source_hash', message: 'missing/invalid source_hash' })
  } else {
    const recomputed = computeSourceHash(flow)
    if (recomputed !== flow.source_hash) {
      issues.push({
        code: 'source_hash_mismatch',
        message: 'source_hash does not match payload',
      })
    }
  }
  // stable order checks
  for (let i = 1; i < flow.nodes.length; i++) {
    if (flow.nodes[i - 1].sort_order > flow.nodes[i].sort_order) {
      issues.push({ code: 'node_order', message: 'nodes not sorted by sort_order' })
      break
    }
  }
  for (let i = 1; i < flow.edges.length; i++) {
    const a = flow.edges[i - 1]
    const b = flow.edges[i]
    if ((a.sort_order ?? 0) > (b.sort_order ?? 0)) {
      issues.push({ code: 'edge_order', message: 'edges not sorted by sort_order' })
      break
    }
  }
  return { ok: issues.length === 0, issues }
}

export function hasFlowPath(flow, fromNode, toNode) {
  if (fromNode === toNode) return true
  const adj = new Map()
  for (const e of flow.edges) {
    const list = adj.get(e.from_node) || []
    list.push(e.to_node)
    adj.set(e.from_node, list)
  }
  const seen = new Set()
  const q = [fromNode]
  while (q.length) {
    const cur = q.shift()
    if (cur === toNode) return true
    if (seen.has(cur)) continue
    seen.add(cur)
    for (const n of adj.get(cur) || []) {
      if (!seen.has(n)) q.push(n)
    }
  }
  return false
}

// ─── RN parser ───────────────────────────────────────────────────────────────

export function parseRnScreens(wsRoot, f1Fallback) {
  const navPath = path.join(wsRoot, 'legacy/rn-mfs81/src/Navigations.js')
  const lazyPath = path.join(wsRoot, 'legacy/rn-mfs81/src/navigation/lazyScreens.js')
  const navText = readText(navPath) || ''
  const lazyText = readText(lazyPath) || ''

  const names = new Set()
  for (const m of navText.matchAll(
    /<Stack\.Screen\b[\s\S]*?\bname\s*=\s*["']([^"']+)["']/g,
  )) {
    names.add(m[1])
  }
  if (names.size < 20) {
    for (const m of navText.matchAll(/name\s*=\s*["']([A-Za-z][A-Za-z0-9_]*)["']/g)) {
      names.add(m[1])
    }
  }
  const existingNorm = new Set([...names].map(normKey))
  for (const m of lazyText.matchAll(/^\s{2}([A-Za-z][A-Za-z0-9_]*)\s*:/gm)) {
    const k = m[1]
    if (k === 'lazy') continue
    if (!existingNorm.has(normKey(k))) {
      names.add(k)
      existingNorm.add(normKey(k))
    }
  }
  for (const eager of [
    'OnboardingPage',
    'Dashboard',
    'FreeTrial',
    'AddWidget',
    'RunningPlayer',
  ]) {
    if (navText.includes(eager) && !existingNorm.has(normKey(eager))) {
      names.add(eager)
      existingNorm.add(normKey(eager))
    }
  }

  return {
    screens: [...names].sort(),
    source: 'legacy/rn-mfs81/src/Navigations.js (route names; lazyScreens fill-in)',
    navPath,
    f1Fallback,
  }
}

function loadF1RnAreas(f1Fallback) {
  const f1 = readJson(f1Fallback)
  return f1?.rn_areas || f1?.features?.filter((f) => f.proj === 'rn') || []
}

export function buildRnFlow(featureIndex, ctx) {
  const { screens, source } = parseRnScreens(ctx.wsRoot, ctx.f1Fallback)
  if (screens.length < 5) {
    throw new Error(`RN parse produced too few screens: ${screens.length}`)
  }

  const nodeSpecs = screens.map((s) => ({
    node_id: s,
    label_id: s,
    source_ref: 'legacy/rn-mfs81/src/Navigations.js',
    kind: 'screen',
  }))

  // Primary auth → home spine (Login→Home representative flow)
  const spine = [
    ['Login', 'Register', 'auth'],
    ['Login', 'ForgotPassword', 'auth'],
    ['Login', 'OTP', 'auth'],
    ['Login', 'SocialRegistration', 'auth'],
    ['Register', 'RegisterPersonalizedContent', 'auth'],
    ['Register', 'OTP', 'auth'],
    ['OTP', 'RegisterPersonalizedContent', 'auth'],
    ['RegisterPersonalizedContent', 'SelectFeatures', 'auth'],
    ['SelectFeatures', 'SelectLocation', 'auth'],
    ['SelectLocation', 'OnboardingPage', 'auth'],
    ['OnboardingPage', 'Home', 'auth'],
    ['Login', 'OnboardingPage', 'auth'],
    ['Login', 'Home', 'auth'],
    ['Register', 'OnboardingPage', 'auth'],
    ['ForgotPassword', 'Login', 'auth'],
    ['SocialRegistration', 'SelectFeatures', 'auth'],
  ]

  const edgeSpecs = []
  for (const [from, to, kind] of spine) {
    edgeSpecs.push({ from_node: from, to_node: to, edge_kind: kind })
  }

  const areaEntries = [
    'FitTrackerHome',
    'mainProgress',
    'bodyWeight',
    'exerciseSlidePage',
    'sleepMusic',
    'runningDiscover',
    'combatDiscover',
    'summaryJourneyInstagram',
    'challengeDetail',
    'PeriodTracker',
    'foodDatabase',
    'group_profile',
    'about',
    'settings',
    'landingPremium',
    'intermittentDiscover',
    'meditation',
    'pointLeaderboard',
    'CorporateWellnessMenu',
  ]
  for (const entry of areaEntries) {
    const real =
      screens.find((s) => s === entry) ||
      screens.find((s) => normKey(s) === normKey(entry))
    if (real) {
      edgeSpecs.push({
        from_node: 'Home',
        to_node: real,
        edge_kind: 'hub',
      })
    }
  }

  const areas = loadF1RnAreas(ctx.f1Fallback)
  for (const area of areas) {
    const list = area.screens || []
    for (let i = 0; i < list.length - 1; i++) {
      const a = list[i]
      const b = list[i + 1]
      const ra =
        screens.find((s) => s === a) ||
        screens.find((s) => normKey(s) === normKey(a))
      const rb =
        screens.find((s) => s === b) ||
        screens.find((s) => normKey(s) === normKey(b))
      if (ra && rb) {
        edgeSpecs.push({
          from_node: ra,
          to_node: rb,
          edge_kind: 'branch',
        })
      }
    }
  }

  if (!screens.includes('Home') && screens.includes('Dashboard')) {
    nodeSpecs.push({
      node_id: 'Home',
      label_id: 'Home',
      source_ref: 'alias:Dashboard',
      kind: 'screen',
    })
    edgeSpecs.push({
      from_node: 'Dashboard',
      to_node: 'Home',
      edge_kind: 'nav',
    })
  }

  // Ensure Login/Home nodes exist when spine references them but parse missed names
  for (const required of ['Login', 'Home']) {
    if (!nodeSpecs.some((n) => n.node_id === required) && screens.includes(required)) {
      /* already present via screens map */
    }
  }

  return buildFlow('rn', source, nodeSpecs, edgeSpecs, featureIndex, {
    generatedAt: ctx.generatedAt,
  })
}

// ─── Next.js App Router projects ─────────────────────────────────────────────

export function collectAppRouterRoutes(appDir) {
  const pages = walkFiles(
    appDir,
    (_full, name) => name === 'page.tsx' || name === 'page.ts' || name === 'page.jsx',
  )
  const routes = []
  for (const p of pages) {
    const rel = path.relative(appDir, path.dirname(p)).replace(/\\/g, '/')
    const route =
      rel === '' || rel === '.'
        ? '/'
        : '/' +
          rel
            .split('/')
            .filter((seg) => !(seg.startsWith('(') && seg.endsWith(')')))
            .join('/')
    routes.push({ route, file: p })
  }
  return routes.sort((a, b) => a.route.localeCompare(b.route))
}

export function routeToNodeId(route) {
  if (route === '/') return 'root'
  return slugify(route.replace(/^\//, '').replace(/\//g, '__'))
}

export function parentRoute(route) {
  if (route === '/') return null
  const parts = route.split('/').filter(Boolean)
  if (parts.length <= 1) return '/'
  return '/' + parts.slice(0, -1).join('/')
}

function findNearestHub(routes) {
  const prefer = ['/dashboard', '/sales', '/admin', '/affiliate', '/account']
  for (const p of prefer) {
    if (routes.some((r) => r.route === p || r.route.startsWith(p + '/'))) {
      const hit =
        routes.find((r) => r.route === p) ||
        routes.find((r) => r.route.startsWith(p))
      if (hit) return routeToNodeId(hit.route)
    }
  }
  return routeToNodeId(routes[0]?.route || '/')
}

function summarizeRoutes(nodeSpecs, edgeSpecs, maxNodes) {
  const hubs = new Map()
  for (const n of nodeSpecs) {
    const route = n.label_id || n.node_id
    const parts = String(route).split('/').filter(Boolean)
    const depth = Math.min(2, parts.length)
    const hubRoute =
      parts.length === 0 ? '/' : '/' + parts.slice(0, Math.max(1, depth)).join('/')
    const cleanParts = hubRoute
      .split('/')
      .filter(Boolean)
      .filter(
        (p, i, arr) =>
          !(p.startsWith('[') && i === arr.length - 1 && arr.length > 1),
      )
    const hub =
      cleanParts.length === 0 ? '/' : '/' + cleanParts.slice(0, 2).join('/')
    if (!hubs.has(hub)) {
      hubs.set(hub, {
        node_id: routeToNodeId(hub),
        label_id: hub,
        source_ref: n.source_ref,
        kind: 'feature',
        meta: { summarized: true, children: 0 },
      })
    }
    hubs.get(hub).meta.children++
  }
  let nodes = [...hubs.values()]
  if (nodes.length > maxNodes) {
    const top = new Map()
    for (const n of nodes) {
      const parts = String(n.label_id).split('/').filter(Boolean)
      const hub = parts.length === 0 ? '/' : '/' + parts[0]
      if (!top.has(hub)) {
        top.set(hub, {
          node_id: routeToNodeId(hub),
          label_id: hub,
          source_ref: n.source_ref,
          kind: 'feature',
          meta: { summarized: true },
        })
      }
    }
    nodes = [...top.values()]
  }
  const ids = new Set(nodes.map((n) => n.node_id))
  const labels = new Map(nodes.map((n) => [n.label_id, n.node_id]))
  const edges = []
  for (const n of nodes) {
    if (n.label_id === '/') continue
    const parts = String(n.label_id).split('/').filter(Boolean)
    if (parts.length <= 1) {
      if (labels.has('/')) {
        edges.push({
          from_node: labels.get('/'),
          to_node: n.node_id,
          edge_kind: 'hierarchy',
        })
      }
      continue
    }
    const parent = '/' + parts.slice(0, -1).join('/')
    if (labels.has(parent)) {
      edges.push({
        from_node: labels.get(parent),
        to_node: n.node_id,
        edge_kind: 'hierarchy',
      })
    } else if (labels.has('/' + parts[0])) {
      edges.push({
        from_node: labels.get('/' + parts[0]),
        to_node: n.node_id,
        edge_kind: 'hierarchy',
      })
    }
  }
  for (const e of edgeSpecs) {
    if (ids.has(e.from_node) && ids.has(e.to_node)) {
      edges.push(e)
    }
  }
  return { nodes, edges }
}

export function buildAppRouterFlow(projectId, appDir, featureIndex, labelPrefix, ctx) {
  const routes = collectAppRouterRoutes(appDir)
  const f1 = readJson(ctx.f1Fallback)
  let source = `${labelPrefix} App Router page.tsx`

  if (routes.length < 5 && f1) {
    source = `fallback:F1 app-data.json + partial ${labelPrefix}`
  }

  const nodeSpecs = routes.map((r) => ({
    node_id: routeToNodeId(r.route),
    label_id: r.route,
    source_ref: path.relative(ctx.wsRoot, r.file),
    kind: 'screen',
    meta: { route: r.route },
  }))

  const edgeSpecs = []
  for (const r of routes) {
    const parent = parentRoute(r.route)
    if (parent == null) continue
    const parentExists = parent === '/' || routes.some((x) => x.route === parent)
    if (!parentExists) {
      let p = parent
      while (p && p !== '/') {
        if (routes.some((x) => x.route === p)) break
        p = parentRoute(p)
      }
      if (p != null && routes.some((x) => x.route === p || p === '/')) {
        edgeSpecs.push({
          from_node: routeToNodeId(
            p === '/' && !routes.some((x) => x.route === '/')
              ? (() => {
                  const hub = findNearestHub(routes)
                  return routes.find((x) => routeToNodeId(x.route) === hub)?.route || p
                })()
              : p,
          ),
          to_node: routeToNodeId(r.route),
          edge_kind: 'hierarchy',
        })
      }
      continue
    }
    const fromId =
      parent === '/' && !routes.some((x) => x.route === '/')
        ? findNearestHub(routes)
        : routeToNodeId(parent)
    edgeSpecs.push({
      from_node: fromId,
      to_node: routeToNodeId(r.route),
      edge_kind: 'hierarchy',
    })
  }

  const byLabel = new Map(nodeSpecs.map((n) => [n.label_id, n.node_id]))
  const findRoute = (pred) => [...byLabel.keys()].find((k) => pred(k)) || null

  if (projectId === 'web' || projectId === 'affiliate') {
    const login =
      findRoute((k) => /\/(login|sign-in|signin)$/i.test(k) || k === '/login') ||
      findRoute((k) => /login|sign-in/i.test(k))
    const reg =
      findRoute((k) => /\/(register|join|sign-up)$/i.test(k)) ||
      findRoute((k) => /register|join/i.test(k))
    const home =
      findRoute((k) => k === '/') ||
      findRoute((k) => /dashboard/i.test(k)) ||
      findRoute((k) => /account/i.test(k))
    if (login && reg) {
      edgeSpecs.push({
        from_node: byLabel.get(login),
        to_node: byLabel.get(reg),
        edge_kind: 'auth',
      })
    }
    if (login && home) {
      edgeSpecs.push({
        from_node: byLabel.get(login),
        to_node: byLabel.get(home),
        edge_kind: 'auth',
      })
    }
  }

  if (projectId === 'sales') {
    const salesRoot = findRoute((k) => k === '/sales' || k.startsWith('/sales'))
    const adminRoot = findRoute((k) => k === '/admin' || k.startsWith('/admin'))
    const login = findRoute((k) => /login|sign-in/i.test(k))
    if (login && salesRoot) {
      edgeSpecs.push({
        from_node: byLabel.get(login),
        to_node: byLabel.get(salesRoot),
        edge_kind: 'auth',
      })
    }
    if (login && adminRoot) {
      edgeSpecs.push({
        from_node: byLabel.get(login),
        to_node: byLabel.get(adminRoot),
        edge_kind: 'auth',
      })
    }
  }

  let finalNodes = nodeSpecs
  let finalEdges = edgeSpecs
  if (nodeSpecs.length > 80) {
    const summarized = summarizeRoutes(nodeSpecs, edgeSpecs, 60)
    finalNodes = summarized.nodes
    finalEdges = summarized.edges
    source += ' (summarized top segments for Workflow density)'
  }

  if (finalNodes.length < 5 && f1?.projects) {
    const p = f1.projects.find((x) => x.id === projectId)
    if (p) {
      finalNodes.push(
        {
          node_id: `${projectId}_overview`,
          label_id: p.label || projectId,
          kind: 'feature',
          feature_id: null,
          source_ref: 'F1:app-data.json',
        },
        {
          node_id: `${projectId}_features`,
          label_id: 'Fitur',
          kind: 'screen',
          source_ref: 'F1:app-data.json',
        },
        {
          node_id: `${projectId}_tasks`,
          label_id: 'Tugas',
          kind: 'screen',
          source_ref: 'F1:app-data.json',
        },
        {
          node_id: `${projectId}_workflow`,
          label_id: 'Workflow',
          kind: 'screen',
          source_ref: 'F1:app-data.json',
        },
        {
          node_id: `${projectId}_ringkasan`,
          label_id: 'Ringkasan',
          kind: 'screen',
          source_ref: 'F1:app-data.json',
        },
      )
      finalEdges.push(
        {
          from_node: `${projectId}_overview`,
          to_node: `${projectId}_ringkasan`,
          edge_kind: 'fallback',
        },
        {
          from_node: `${projectId}_overview`,
          to_node: `${projectId}_workflow`,
          edge_kind: 'fallback',
        },
        {
          from_node: `${projectId}_overview`,
          to_node: `${projectId}_features`,
          edge_kind: 'fallback',
        },
        {
          from_node: `${projectId}_overview`,
          to_node: `${projectId}_tasks`,
          edge_kind: 'fallback',
        },
      )
    }
  }

  return buildFlow(projectId, source, finalNodes, finalEdges, featureIndex, {
    generatedAt: ctx.generatedAt,
  })
}

// ─── Backend domain routes ───────────────────────────────────────────────────

export function buildBackendFlow(featureIndex, ctx) {
  const apiDir = path.join(ctx.wsRoot, 'rebuild-backend/routes/api')
  let files = []
  if (fs.existsSync(apiDir)) {
    files = fs
      .readdirSync(apiDir)
      .filter((f) => f.endsWith('.php'))
      .sort()
  }

  const domains = new Map()
  for (const f of files) {
    const base = f.replace(/\.php$/, '')
    const domain = base.includes('__') ? base.split('__')[0] : base
    if (!domains.has(domain)) {
      domains.set(domain, { domain, files: [] })
    }
    domains.get(domain).files.push(base)
  }

  const nodeSpecs = []
  const edgeSpecs = []
  nodeSpecs.push({
    node_id: 'api_root',
    label_id: 'API Root',
    kind: 'feature',
    feature_id: 'FEAT-DOMAIN-INVENTORY',
    source_ref: 'rebuild-backend/routes/api.php',
  })

  // Stable iteration
  for (const domain of [...domains.keys()].sort()) {
    const info = domains.get(domain)
    const domainId = slugify(domain)
    nodeSpecs.push({
      node_id: domainId,
      label_id: domain,
      kind: 'feature',
      source_ref: `rebuild-backend/routes/api/${info.files[0]}.php`,
      meta: { unit_count: info.files.length },
    })
    edgeSpecs.push({
      from_node: 'api_root',
      to_node: domainId,
      edge_kind: 'hierarchy',
    })
    const subs = info.files.filter((f) => f.includes('__')).slice(0, 8)
    for (const sub of subs) {
      const subId = slugify(sub)
      nodeSpecs.push({
        node_id: subId,
        label_id: sub.replace(/__/g, '/'),
        kind: 'screen',
        source_ref: `rebuild-backend/routes/api/${sub}.php`,
      })
      edgeSpecs.push({
        from_node: domainId,
        to_node: subId,
        edge_kind: 'branch',
      })
    }
  }

  if (nodeSpecs.length > 100) {
    const keep = nodeSpecs.filter(
      (n) => n.node_id === 'api_root' || !String(n.label_id).includes('/'),
    )
    const keepIds = new Set(keep.map((n) => n.node_id))
    return buildFlow(
      'backend',
      'rebuild-backend/routes/api/*.php (domain hubs)',
      keep,
      edgeSpecs.filter((e) => keepIds.has(e.from_node) && keepIds.has(e.to_node)),
      featureIndex,
      { generatedAt: ctx.generatedAt },
    )
  }

  return buildFlow(
    'backend',
    'rebuild-backend/routes/api/*.php',
    nodeSpecs,
    edgeSpecs,
    featureIndex,
    { generatedAt: ctx.generatedAt },
  )
}

// ─── builders registry ───────────────────────────────────────────────────────

export function createBuilders(featureIndex, ctx) {
  return {
    rn: () => buildRnFlow(featureIndex, ctx),
    web: () =>
      buildAppRouterFlow(
        'web',
        path.join(ctx.wsRoot, 'mfs-web-original-upgrade/src/app'),
        featureIndex,
        'mfs-web-original-upgrade',
        ctx,
      ),
    sales: () =>
      buildAppRouterFlow(
        'sales',
        path.join(ctx.wsRoot, 'sales-rebuild/src/app'),
        featureIndex,
        'sales-rebuild',
        ctx,
      ),
    affiliate: () =>
      buildAppRouterFlow(
        'affiliate',
        path.join(ctx.wsRoot, 'affiliate-rebuild/src/app'),
        featureIndex,
        'affiliate-rebuild',
        ctx,
      ),
    backend: () => buildBackendFlow(featureIndex, ctx),
  }
}

export function runIngest(opts) {
  const featureIndex = loadFeatureIndex(opts.seedPath)
  if (!featureIndex.length) {
    console.warn('[warn] product-features.seed.json missing or empty (soft refs limited)')
  }
  if (!fs.existsSync(opts.outDir) && !opts.dryRun) {
    fs.mkdirSync(opts.outDir, { recursive: true })
  }

  const ctx = {
    wsRoot: opts.wsRoot,
    f1Fallback: opts.f1Fallback,
    generatedAt: opts.generatedAt,
  }
  const builders = createBuilders(featureIndex, ctx)
  const summary = []
  const flows = {}

  for (const rawId of opts.projects) {
    const projectId = resolveProjectAlias(rawId) || rawId
    if (!builders[projectId]) {
      throw new Error(`unknown project: ${rawId}`)
    }
    const flow = builders[projectId]()
    const v = validateFlow(flow)
    if (!v.ok) {
      throw new Error(
        `validation failed for ${projectId}: ${v.issues.map((i) => i.code).join(',')}`,
      )
    }
    if (flow.nodes.length < 5) {
      throw new Error(`project ${projectId} produced ${flow.nodes.length} nodes (<5)`)
    }
    const outPath = path.join(opts.outDir, `${projectId}.json`)
    if (!opts.dryRun) {
      fs.writeFileSync(outPath, JSON.stringify(flow, null, 2) + '\n', 'utf8')
    }
    flows[projectId] = flow
    summary.push({
      project_id: projectId,
      nodes: flow.stats.nodes,
      edges: flow.stats.edges,
      mapped: flow.stats.mapped_features,
      unmapped: flow.stats.unmapped_screens,
      feature_ids: flow.stats.feature_ids.length,
      source_hash: flow.source_hash,
      source: flow.source,
      out: opts.dryRun ? '(dry-run)' : path.relative(ROOT, outPath),
    })
  }

  return { ok: true, dryRun: !!opts.dryRun, projects: summary, flows }
}

// ─── self-test (temp fixtures only; no product-repo writes) ──────────────────

export function writeSelfTestFixtures(baseDir) {
  const ws = path.join(baseDir, 'ws')
  const seedPath = path.join(baseDir, 'product-features.seed.json')
  const outDir = path.join(baseDir, 'out')
  fs.mkdirSync(outDir, { recursive: true })

  // Minimal seed
  fs.writeFileSync(
    seedPath,
    JSON.stringify(
      {
        version: 1,
        features: [
          {
            feature_id: 'FEAT-AUTH-MEMBER',
            nama_id: 'Auth',
            platform_json: { rn: true, web: true, admin: true, backend: true },
            join: { id_includes: ['AUTH', 'LOGIN'], keywords: ['login', 'auth'] },
          },
          {
            feature_id: 'FEAT-HOME-SHELL',
            nama_id: 'Home',
            platform_json: { rn: true, web: true, admin: true, backend: true },
            join: { id_includes: ['HOME'], keywords: ['home', 'dashboard'] },
          },
          {
            feature_id: 'FEAT-DOMAIN-INVENTORY',
            nama_id: 'Domain Inventory',
            platform_json: { backend: true, admin: true, jobs: true },
            join: { id_includes: ['DOMAIN'], keywords: ['api'] },
          },
        ],
      },
      null,
      2,
    ),
    'utf8',
  )

  // RN Navigations mini
  const rnNav = path.join(ws, 'legacy/rn-mfs81/src')
  fs.mkdirSync(rnNav, { recursive: true })
  fs.mkdirSync(path.join(ws, 'legacy/rn-mfs81/src/navigation'), { recursive: true })
  fs.writeFileSync(
    path.join(rnNav, 'Navigations.js'),
    `
export function Nav() {
  return (
    <>
      <Stack.Screen name="Login" />
      <Stack.Screen name="Register" />
      <Stack.Screen name="ForgotPassword" />
      <Stack.Screen name="OTP" />
      <Stack.Screen name="OnboardingPage" />
      <Stack.Screen name="Home" />
      <Stack.Screen name="settings" />
      <Stack.Screen name="about" />
    </>
  )
}
`,
    'utf8',
  )
  fs.writeFileSync(
    path.join(ws, 'legacy/rn-mfs81/src/navigation/lazyScreens.js'),
    `export default {
  Login: 1,
  Home: 1,
  ExtraScreen: 1,
}
`,
    'utf8',
  )

  // App router trees for web/sales/affiliate
  function writePages(appRoot, routes) {
    for (const route of routes) {
      const dir =
        route === '/'
          ? appRoot
          : path.join(appRoot, ...route.replace(/^\//, '').split('/'))
      fs.mkdirSync(dir, { recursive: true })
      fs.writeFileSync(path.join(dir, 'page.tsx'), `export default function P(){return null}\n`)
    }
  }

  writePages(path.join(ws, 'mfs-web-original-upgrade/src/app'), [
    '/',
    '/login',
    '/register',
    '/account',
    '/dashboard',
    '/about',
  ])
  writePages(path.join(ws, 'sales-rebuild/src/app'), [
    '/login',
    '/sales',
    '/sales/leads',
    '/admin',
    '/admin/users',
    '/dashboard',
  ])
  writePages(path.join(ws, 'affiliate-rebuild/src/app'), [
    '/',
    '/login',
    '/register',
    '/affiliate',
    '/affiliate/stats',
    '/account',
  ])

  // Backend php domains
  const apiDir = path.join(ws, 'rebuild-backend/routes/api')
  fs.mkdirSync(apiDir, { recursive: true })
  for (const f of [
    'activity_tracker.php',
    'activity_tracker__goal.php',
    'auth.php',
    'auth__login.php',
    'meditation.php',
    'meditation__list.php',
    'billing.php',
  ]) {
    fs.writeFileSync(path.join(apiDir, f), `<?php // fixture ${f}\n`)
  }

  return { wsRoot: ws, seedPath, outDir, f1Fallback: path.join(baseDir, 'missing-f1.json') }
}

export function runSelfTest() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), 'app-flow-selftest-'))
  try {
    const fx = writeSelfTestFixtures(base)
    const pin = '2026-07-18T00:00:00.000Z'
    const opts = {
      dryRun: false,
      outDir: fx.outDir,
      wsRoot: fx.wsRoot,
      seedPath: fx.seedPath,
      f1Fallback: fx.f1Fallback,
      projects: [...PROJECTS],
      generatedAt: pin,
    }
    const first = runIngest(opts)
    const second = runIngest(opts)

    // Idempotent hashes + stable ordering
    for (const p of PROJECTS) {
      const a = first.flows[p]
      const b = second.flows[p]
      if (a.source_hash !== b.source_hash) {
        throw new Error(`source_hash drift on ${p}`)
      }
      if (JSON.stringify(a.nodes) !== JSON.stringify(b.nodes)) {
        throw new Error(`nodes not stable on ${p}`)
      }
      if (JSON.stringify(a.edges) !== JSON.stringify(b.edges)) {
        throw new Error(`edges not stable on ${p}`)
      }
      const v = validateFlow(a)
      if (!v.ok) throw new Error(`validate ${p}: ${JSON.stringify(v.issues)}`)
    }

    const rn = first.flows.rn
    if (!hasFlowPath(rn, 'Login', 'Home')) {
      throw new Error('RN Login→Home path missing in self-test')
    }

    // Duplicate edge rejection in buildFlow
    const dup = buildFlow(
      'rn',
      'self-test-dup',
      [
        { node_id: 'A', label_id: 'A' },
        { node_id: 'B', label_id: 'B' },
        { node_id: 'C', label_id: 'C' },
        { node_id: 'D', label_id: 'D' },
        { node_id: 'E', label_id: 'E' },
      ],
      [
        { from_node: 'A', to_node: 'B', edge_kind: 'nav' },
        { from_node: 'A', to_node: 'B', edge_kind: 'nav' },
        { from_node: 'B', to_node: 'C', edge_kind: 'nav' },
        { from_node: 'C', to_node: 'D', edge_kind: 'nav' },
        { from_node: 'D', to_node: 'E', edge_kind: 'nav' },
      ],
      [],
      { generatedAt: pin },
    )
    if (dup.edges.filter((e) => e.from_node === 'A' && e.to_node === 'B').length !== 1) {
      throw new Error('duplicate edges not collapsed')
    }

    const result = {
      ok: true,
      selfTest: true,
      base,
      projects: first.projects.map((p) => ({
        project_id: p.project_id,
        nodes: p.nodes,
        edges: p.edges,
        source_hash: p.source_hash,
      })),
      login_to_home: true,
      idempotent: true,
    }
    console.log(JSON.stringify(result, null, 2))
    return result
  } finally {
    try {
      fs.rmSync(base, { recursive: true, force: true })
    } catch {
      /* keep temp for debug */
    }
  }
}

// ─── main ────────────────────────────────────────────────────────────────────

export function main(argv = process.argv.slice(2)) {
  const opts = parseArgs(argv)
  if (opts.help) {
    printHelp()
    return { ok: true, help: true }
  }
  if (opts.selfTest) {
    return runSelfTest()
  }

  const result = runIngest(opts)
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        dryRun: result.dryRun,
        projects: result.projects,
      },
      null,
      2,
    ),
  )
  console.log('\n--- count node/edge per project ---')
  for (const s of result.projects) {
    console.log(
      `${s.project_id.padEnd(12)} nodes=${String(s.nodes).padStart(4)} edges=${String(s.edges).padStart(4)} mapped=${s.mapped} unmapped=${s.unmapped} features=${s.feature_ids} hash=${s.source_hash.slice(0, 12)}`,
    )
  }
  return result
}

const isMain =
  process.argv[1] &&
  pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url

if (isMain) {
  try {
    main()
  } catch (err) {
    console.error(
      JSON.stringify({
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      }),
    )
    process.exit(1)
  }
}
