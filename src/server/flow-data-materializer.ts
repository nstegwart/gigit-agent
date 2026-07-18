/**
 * FlowDataBundle materializer — schema 009–012 → Alur wire shape.
 *
 * Honesty rules (normative):
 * - Source is MySQL XOR full file fallback — never field-merge revisions.
 * - MySQL gate: product_features + feature_task_map present and features non-empty.
 * - 009/011/012 optional layers → partial meta when any are missing.
 * - Never invent navigation edges (no edges array on FlowDataBundle).
 * - Premium on MySQL path is versioned curated constant (hashed), never spliced
 *   from static file fields onto mysql features.
 *
 * Server-only. No React. Injectable SQL executor for offline unit tests.
 * Does not connect to a live DB unless resolve is called without an injected executor.
 */

import { createHash } from 'node:crypto'
import { readFile, stat } from 'node:fs/promises'
import path from 'node:path'

import type {
  FlowApi,
  FlowDataBundle,
  FlowFeature,
  FlowPremiumStep,
  FlowProjectMeta,
  FlowProjectRollup,
  FlowTask,
} from '#/components/flow-ultimate/types'
import {
  CANON_UI_PROJECT_IDS,
  getCanonFlowProject,
  normalizeCanonProjectId,
  type CanonUiProjectId,
} from '#/lib/canon-flow-projects'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MATERIALIZER_VERSION = 1 as const
export const DEFAULT_FLOW_BOARD_ID = 'mfs-rebuild' as const
export const FLOW_STALE_SECONDS_DEFAULT = 604_800 // 7d

const REQUIRED_TABLES = ['product_features', 'feature_task_map'] as const

const PROBE_TABLES = [
  'product_features',
  'feature_task_map',
  'rebuild_lineage_records',
  'parity_rollups',
  'feature_units',
  'feature_directory',
  'app_flow_nodes',
  'app_flow_edges',
  'app_pages',
  'api_endpoints',
  'page_api_calls',
  'nav_edges',
  'knowledge_aliases',
] as const

/** Optional layers that, when any are missing, mark availability partial. */
const OPTIONAL_LAYER_TABLES = [
  'rebuild_lineage_records',
  'app_flow_nodes',
  'app_pages',
] as const

// ---------------------------------------------------------------------------
// Premium curated constant (v1) — narrative product data, not 009–012 rows.
// Hashed into mysql sourceHash. Never merged from data-bundle.json fields.
// ---------------------------------------------------------------------------

const PREMIUM_STEP_FEATURE_MAP: Record<number, string> = {
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

export const PREMIUM_FLOW_V1: {
  version: 1
  tag: 'curated:premium-v1'
  name: string
  desc: string
  steps: FlowPremiumStep[]
  premium_apis: FlowApi[]
} = {
  version: 1,
  tag: 'curated:premium-v1',
  name: 'Pembelian Premium',
  desc: 'Alur lintas-sistem: Sales set harga → Web tampil & checkout → webhook → tercatat di Sales & Affiliate.',
  steps: [
    {
      n: 1,
      proj: 'sales',
      title: 'Sales set paket & harga',
      kind: 'input',
      api: 'POST /api/admin/product-packages',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[1],
    },
    {
      n: 2,
      proj: 'backend',
      title: 'Simpan ke database',
      kind: 'db',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[2],
    },
    {
      n: 3,
      proj: 'web',
      title: '/premium — pricing muncul',
      kind: 'page',
      api: 'GET /api/web/v1/premium/packages',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[3],
    },
    {
      n: 4,
      proj: 'web',
      title: 'Questionnaire Premium',
      kind: 'page',
      api: 'POST /api/web/v1/questionnaire',
      st: 'warn',
      feature_id: PREMIUM_STEP_FEATURE_MAP[4],
    },
    {
      n: 5,
      proj: 'web',
      title: 'Package / Final Summary',
      kind: 'page',
      api: 'GET /api/web/v1/premium/summary',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[5],
    },
    {
      n: 6,
      proj: 'web',
      title: 'Checkout',
      kind: 'page',
      api: 'POST /api/web/v1/checkout',
      st: 'warn',
      feature_id: PREMIUM_STEP_FEATURE_MAP[6],
    },
    {
      n: 7,
      proj: 'backend',
      title: 'Webhook proses pembayaran',
      kind: 'webhook',
      api: 'POST /api/v1/webhook/payment-notification',
      st: 'warn',
      feature_id: PREMIUM_STEP_FEATURE_MAP[7],
    },
    {
      n: 8,
      proj: 'web',
      title: 'Halaman Success',
      kind: 'page',
      api: 'GET /api/web/v1/premium/status',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[8],
    },
    {
      n: 9,
      proj: 'sales',
      title: 'Ter-record di Sales',
      kind: 'record',
      api: 'GET /api/admin/transactions',
      st: 'ok',
      feature_id: PREMIUM_STEP_FEATURE_MAP[9],
    },
    {
      n: 10,
      proj: 'affiliate',
      title: 'Ter-record di Affiliate (jika via affiliate)',
      kind: 'record',
      api: 'GET /api/affiliate/referrals',
      st: 'warn',
      feature_id: PREMIUM_STEP_FEATURE_MAP[10],
    },
  ],
  premium_apis: [
    { method: 'POST', path: '/api/admin/product-packages', n: 1, proj: 'sales' },
    { method: 'GET', path: '/api/web/v1/premium/packages', n: 3, proj: 'web' },
    { method: 'POST', path: '/api/web/v1/questionnaire', n: 4, proj: 'web' },
    { method: 'GET', path: '/api/web/v1/premium/summary', n: 5, proj: 'web' },
    { method: 'POST', path: '/api/web/v1/checkout', n: 6, proj: 'web' },
    {
      method: 'POST',
      path: '/api/v1/webhook/payment-notification',
      n: 7,
      proj: 'backend',
    },
    { method: 'GET', path: '/api/web/v1/premium/status', n: 8, proj: 'web' },
    { method: 'GET', path: '/api/admin/transactions', n: 9, proj: 'sales' },
    { method: 'GET', path: '/api/affiliate/referrals', n: 10, proj: 'affiliate' },
  ],
}

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type FlowDataSqlExecutor = {
  query(sql: string, params?: Array<unknown>): Promise<[unknown, unknown?]>
}

export type FlowBundleMetaCode =
  | 'OK'
  | 'OK_PARTIAL'
  | 'FILE_FALLBACK'
  | 'FILE_FORCED'
  | 'EMPTY_MYSQL'
  | 'TABLES_MISSING'
  | 'DB_ERROR'
  | 'UNAVAILABLE'
  | 'MIXED_REVISION'
  | 'STALE_PIN'

export type FlowBundleMeta = {
  source: 'mysql' | 'file' | 'empty'
  sourceHash: string
  revision: number | null
  generatedAt: string
  boardId: string
  availability: 'available' | 'partial' | 'unavailable'
  tablesPresent: string[]
  freshness: {
    ageSeconds: number | null
    stale: boolean
    staleReason: string | null
  }
  code: FlowBundleMetaCode
  detail?: string
  /** Layers used on mysql path, e.g. ['010','009','011']. */
  layers?: string[]
  queryCount?: number
}

export type FlowBundleLoad = {
  bundle: FlowDataBundle
  meta: FlowBundleMeta
}

export type ResolveFlowDataBundleOpts = {
  boardId?: string
  preferMysql?: boolean
  /** Injectable SQL executor (unit tests). When absent, dynamic db() is used. */
  executor?: FlowDataSqlExecutor
  /** Absolute path override for file fallback. */
  filePath?: string
  /** Inject a whole-file bundle (skips disk). null = treat as missing. */
  fileBundle?: FlowDataBundle | null
  /** Injected "now" for freshness/generatedAt stability in tests. */
  now?: () => Date
  /** Override stale threshold (seconds). */
  staleSeconds?: number
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

type CacheEntry = {
  /** Full cache key including sourceHash (diagnostics / tests). */
  key: string
  /** Soft key for process-local hit without re-query (board + source mode + path). */
  softKey: string
  load: FlowBundleLoad
}

let cacheEntry: CacheEntry | null = null

export function resetFlowDataBundleCache(): void {
  cacheEntry = null
}

/** Test helper: current process-local cache key, or null. */
export function getFlowDataBundleCacheKey(): string | null {
  return cacheEntry?.key ?? null
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
    .replace(/(CAIRN_DB_PASSWORD|MYSQL_PWD|DATABASE_URL)\s*[=:]\s*\S+/gi, '$1=***')
    .replace(/mysql:\/\/[^:\s]+:[^@\s]+@/gi, 'mysql://***:***@')
    .replace(/\b(user|username)\s*[=:]\s*[^\s,;]+/gi, (m) => {
      // Keep generic "user=?" placeholders; scrub value-looking pairs only when password co-present already handled.
      if (/password/i.test(m)) return m
      return m
    })
    .replace(/Access denied for user '[^']+'/gi, "Access denied for user '***'")
}

function emptyRollup(): FlowProjectRollup {
  return { terbukti: 0, sebagian: 0, belum: 0 }
}

function projectLabel(id: CanonUiProjectId): string {
  return getCanonFlowProject(id).labelId
}

export function emptyFlowDataBundle(generatedAt: string): FlowDataBundle {
  return {
    projects: {
      version: MATERIALIZER_VERSION,
      generated_at: generatedAt,
      source: 'empty',
      projects: CANON_UI_PROJECT_IDS.map((id) => ({
        id,
        label: projectLabel(id),
        features: 0,
        tasks: 0,
        rollup: emptyRollup(),
        pct: 0,
        status: 'belum',
        generated_at: generatedAt,
      })),
    },
    premium: { name: 'Pembelian Premium', steps: [] },
    features: Object.fromEntries(CANON_UI_PROJECT_IDS.map((id) => [id, []])),
    tasks_by_feature: {},
    apis_by_feature: {},
  }
}

function parseJsonCell(value: unknown): unknown {
  if (value == null) return null
  if (typeof value === 'object') return value
  if (typeof value === 'string') {
    try {
      return JSON.parse(value)
    } catch {
      return value
    }
  }
  return value
}

function asRecord(value: unknown): Record<string, unknown> | null {
  const parsed = parseJsonCell(value)
  if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
    return parsed as Record<string, unknown>
  }
  return null
}

function asStringArray(value: unknown): string[] {
  const parsed = parseJsonCell(value)
  if (!parsed) return []
  if (Array.isArray(parsed)) return parsed.map(String).filter(Boolean)
  if (typeof parsed === 'string' && parsed) return [parsed]
  return []
}

function truthyFlag(v: unknown): boolean {
  return v === true || v === 1 || v === '1' || v === 'true'
}

/**
 * platform_json → UI project ids (stable order).
 * jobs:true folds into backend only (no sixth mode).
 * FEAT-AFFILIATE always includes affiliate.
 */
export function platformJsonToUiProjects(
  platformJson: unknown,
  featureId: string,
): CanonUiProjectId[] {
  const plat = asRecord(platformJson) ?? {}
  const set = new Set<CanonUiProjectId>()
  if (truthyFlag(plat.rn)) set.add('rn')
  if (truthyFlag(plat.web)) set.add('web-member')
  if (truthyFlag(plat.admin)) set.add('panel-sales')
  if (truthyFlag(plat.backend) || truthyFlag(plat.jobs)) set.add('backend')
  // platform key "affiliate" if ever set
  if (truthyFlag(plat.affiliate)) set.add('affiliate')
  if (featureId === 'FEAT-AFFILIATE') set.add('affiliate')
  return CANON_UI_PROJECT_IDS.filter((id) => set.has(id))
}

/**
 * Storage / app-flow / page project_id → UI id via canon map (strict normalize).
 * Unknown values return null (honest — no invented project).
 */
export function storageProjectIdToUi(projectId: string | null | undefined): CanonUiProjectId | null {
  if (projectId == null || projectId === '') return null
  const r = normalizeCanonProjectId(projectId)
  return r.ok ? r.id : null
}

/**
 * rebuild_lineage_records.repository → optional FlowTask.project (UI id).
 * Ordered heuristics; only the five canon UI ids.
 */
export function repositoryToUiProject(
  repository: string | null | undefined,
): CanonUiProjectId | undefined {
  if (!repository) return undefined
  const r = repository.toLowerCase()
  if (
    r.includes('rn-mfs') ||
    r.includes('react-native') ||
    r.includes('react_native') ||
    /(^|[/_.-])mobile([/_.-]|$)/.test(r)
  ) {
    return 'rn'
  }
  if (r.includes('mfs-web') || r.includes('web-member') || r.includes('web_member')) {
    return 'web-member'
  }
  if (r.includes('sales')) return 'panel-sales'
  if (r.includes('affiliate') || r.includes('afiliasi')) return 'affiliate'
  if (r.includes('backend') || r.includes('rebuild-backend')) return 'backend'
  return undefined
}

export type VerdictRollup = FlowProjectRollup & { status: string; pct: number }

export function rollupVerdicts(verdicts: Array<string | null | undefined>): VerdictRollup {
  const rollup = emptyRollup()
  for (const v of verdicts) {
    const up = (v ?? '').toUpperCase()
    if (up === 'MAPPED_100') rollup.terbukti++
    else if (up === 'MISSING') rollup.belum++
    else rollup.sebagian++ // PARTIAL, pending, unknown, empty
  }
  const total = rollup.terbukti + rollup.sebagian + rollup.belum
  if (total === 0) {
    return { ...rollup, status: 'sebagian', pct: 0 }
  }
  if (rollup.belum === total) {
    return { ...rollup, status: 'belum', pct: 0 }
  }
  if (rollup.terbukti === total) {
    return {
      ...rollup,
      status: 'terbukti',
      pct: 100,
    }
  }
  return {
    ...rollup,
    status: 'sebagian',
    pct: Math.round((100 * rollup.terbukti) / total),
  }
}

function extractTaskTitle(
  taskId: string,
  stage1Json: unknown,
  implementationJson: unknown,
): string {
  for (const cell of [stage1Json, implementationJson]) {
    const rec = asRecord(cell)
    if (!rec) continue
    for (const key of [
      'title',
      'judul_id',
      'judul',
      'name',
      'label',
      'task_title',
      'summary',
    ]) {
      const v = rec[key]
      if (typeof v === 'string' && v.trim()) return v.trim()
    }
  }
  return taskId
}

function premiumSig(): string {
  return sha256Hex(
    stableStringify({
      version: PREMIUM_FLOW_V1.version,
      tag: PREMIUM_FLOW_V1.tag,
      steps: PREMIUM_FLOW_V1.steps.map((s) => ({
        n: s.n,
        proj: s.proj,
        title: s.title,
        feature_id: s.feature_id,
        api: s.api,
      })),
      apis: PREMIUM_FLOW_V1.premium_apis,
    }),
  )
}

function defaultFilePath(): string {
  return path.join(process.cwd(), 'public', 'flow-data', 'data-bundle.json')
}

function rowN(rows: unknown): number {
  const arr = rows as Array<{ n?: number | string | bigint }>
  const n = arr?.[0]?.n
  if (typeof n === 'bigint') return Number(n)
  if (typeof n === 'number') return n
  if (typeof n === 'string') return Number(n) || 0
  return 0
}

function asRows<T extends Record<string, unknown>>(rows: unknown): T[] {
  return Array.isArray(rows) ? (rows as T[]) : []
}

// ---------------------------------------------------------------------------
// SQL materialize
// ---------------------------------------------------------------------------

export type MaterializeMysqlOpts = {
  boardId?: string
  executor: FlowDataSqlExecutor
  now?: () => Date
  staleSeconds?: number
}

export type MaterializeMysqlResult =
  | { ok: true; load: FlowBundleLoad }
  | {
      ok: false
      code: 'TABLES_MISSING' | 'EMPTY_MYSQL'
      tablesPresent: string[]
      detail?: string
      queryCount: number
    }

/**
 * Attempt pure MySQL materialization.
 * Gate fail → ok:false (TABLES_MISSING | EMPTY_MYSQL).
 * Throws on executor/query failure (caller maps to DB_ERROR + file fallback).
 */
export async function materializeFromMysql(
  opts: MaterializeMysqlOpts,
): Promise<MaterializeMysqlResult> {
  const boardId = (opts.boardId ?? DEFAULT_FLOW_BOARD_ID).trim() || DEFAULT_FLOW_BOARD_ID
  const now = opts.now ?? (() => new Date())
  const staleSeconds = opts.staleSeconds ?? FLOW_STALE_SECONDS_DEFAULT
  const exec = opts.executor
  let queryCount = 0

  const q = async <T extends Record<string, unknown>>(
    sql: string,
    params?: Array<unknown>,
  ): Promise<T[]> => {
    queryCount++
    const [rows] = await exec.query(sql, params)
    return asRows<T>(rows)
  }

  // Q0 probe
  const tableRows = await q<{ name: string }>(
    `SELECT TABLE_NAME AS name
     FROM information_schema.TABLES
     WHERE TABLE_SCHEMA = DATABASE()
       AND TABLE_NAME IN (${PROBE_TABLES.map(() => '?').join(',')})`,
    [...PROBE_TABLES],
  )
  const tablesPresent = tableRows
    .map((r) => String(r.name))
    .filter(Boolean)
    .sort()
  const tables = new Set(tablesPresent)

  for (const req of REQUIRED_TABLES) {
    if (!tables.has(req)) {
      return {
        ok: false,
        code: 'TABLES_MISSING',
        tablesPresent,
        detail: `missing required table: ${req}`,
        queryCount,
      }
    }
  }

  // Q1 gate counts
  const featureCountRows = await q<{ n: number }>('SELECT COUNT(*) AS n FROM product_features')
  const featureCount = rowN(featureCountRows)
  if (featureCount === 0) {
    return {
      ok: false,
      code: 'EMPTY_MYSQL',
      tablesPresent,
      detail: 'product_features COUNT = 0',
      queryCount,
    }
  }
  // feature_task_map must exist (required); ensures table is queryable in one bulk path
  await q<{ n: number }>('SELECT COUNT(*) AS n FROM feature_task_map')

  // Q2 features
  const featureRows = await q<{
    feature_id: string
    nama_id: string
    domain_bisnis?: string
    ringkasan_id?: string | null
    platform_json?: unknown
    capabilities_json?: unknown
    fc_refs_json?: unknown
    curated?: unknown
  }>(
    `SELECT feature_id, nama_id, domain_bisnis, ringkasan_id,
            platform_json, capabilities_json, fc_refs_json, curated
     FROM product_features
     ORDER BY feature_id`,
  )

  // Q3 maps
  const mapRows = await q<{
    feature_id: string
    task_id: string
    join_source?: string
    confidence?: number
  }>(
    `SELECT feature_id, task_id, join_source, confidence
     FROM feature_task_map
     ORDER BY feature_id, task_id`,
  )

  // Optional 009
  const lineageRows = tables.has('rebuild_lineage_records')
    ? await q<{
        board_id: string
        task_id: string
        repository?: string | null
        origin?: string | null
        feature_contract_id?: string | null
        parity_verdict?: string | null
        source_hash?: string | null
        synced_at?: string | Date | null
        stage1_json?: unknown
        implementation_json?: unknown
      }>(
        `SELECT board_id, task_id, repository, origin, feature_contract_id,
                parity_verdict, source_hash, synced_at,
                stage1_json, implementation_json
         FROM rebuild_lineage_records
         WHERE board_id = ?
         ORDER BY task_id`,
        [boardId],
      )
    : []

  const directoryRows = tables.has('feature_directory')
    ? await q<{
        feature_contract_id: string
        judul_id?: string | null
        domain_bisnis?: string | null
        ringkasan_id?: string | null
        doc_md?: string | null
        delivery_status?: string | null
        source_hash?: string | null
        synced_at?: string | Date | null
      }>(
        `SELECT feature_contract_id, judul_id, domain_bisnis, ringkasan_id,
                doc_md, delivery_status, source_hash, synced_at
         FROM feature_directory`,
      )
    : []

  const unitRows = tables.has('feature_units')
    ? await q<{
        unit_id: string
        feature_contract_id?: string | null
        unit_type?: string | null
        identifier?: string | null
        anchor?: string | null
        coverage_status?: string | null
        repo?: string | null
        source_hash?: string | null
      }>(
        `SELECT unit_id, feature_contract_id, unit_type, identifier, anchor,
                coverage_status, repo, source_hash
         FROM feature_units`,
      )
    : []

  const rollupRows = tables.has('parity_rollups')
    ? await q<{
        id: number | string | bigint
        captured_at: string | Date
        source_hash?: string | null
        mapped_100?: number
        partial_n?: number
        missing_n?: number
        total_n?: number
      }>(
        `SELECT id, captured_at, source_hash, mapped_100, partial_n, missing_n, total_n
         FROM parity_rollups
         ORDER BY captured_at DESC, id DESC
         LIMIT 1`,
      )
    : []
  const rollupRow = rollupRows[0] ?? null

  // Optional 011 (nodes only — never edges into bundle)
  const nodeRows = tables.has('app_flow_nodes')
    ? await q<{
        project_id: string
        node_id: string
        feature_id?: string | null
        label_id?: string | null
        kind?: string | null
        sort_order?: number
        source_ref?: string | null
        meta_json?: unknown
      }>(
        `SELECT project_id, node_id, feature_id, label_id, kind,
                sort_order, source_ref, meta_json
         FROM app_flow_nodes
         WHERE feature_id IS NOT NULL
         ORDER BY project_id, sort_order`,
      )
    : []

  // Optional 012
  const pageRows = tables.has('app_pages')
    ? await q<{
        id: string
        project_id: string
        label_id?: string | null
        route?: string | null
        area?: string | null
        feature_id?: string | null
        source_hash?: string | null
        extracted_at?: string | Date | null
      }>(
        `SELECT id, project_id, label_id, route, area, feature_id,
                source_hash, extracted_at
         FROM app_pages
         WHERE feature_id IS NOT NULL`,
      )
    : []

  const apiLinkRows =
    tables.has('page_api_calls') && tables.has('api_endpoints')
      ? await q<{
          id: string
          method: string
          path: string
          domain_id?: string | null
          repo?: string | null
          page_id: string
        }>(
          `SELECT e.id, e.method, e.path, e.domain_id, e.repo, c.page_id
           FROM page_api_calls c
           INNER JOIN api_endpoints e ON e.id = c.endpoint_id`,
        )
      : []

  // ---- Index ----
  const lineageByTask = new Map(
    lineageRows.map((r) => [String(r.task_id), r] as const),
  )
  const mapsByFeature = new Map<string, Array<{ task_id: string }>>()
  for (const m of mapRows) {
    const fid = String(m.feature_id)
    const list = mapsByFeature.get(fid) ?? []
    list.push({ task_id: String(m.task_id) })
    mapsByFeature.set(fid, list)
  }
  const dirByFc = new Map(
    directoryRows.map((r) => [String(r.feature_contract_id), r] as const),
  )

  // screens: pages + nodes + units
  const screensByFeature = new Map<string, string[]>()
  const pushScreen = (featureId: string, screen: string) => {
    if (!featureId || !screen) return
    const list = screensByFeature.get(featureId) ?? []
    if (!list.includes(screen)) list.push(screen)
    screensByFeature.set(featureId, list)
  }
  for (const p of pageRows) {
    const fid = p.feature_id ? String(p.feature_id) : ''
    if (p.route) pushScreen(fid, String(p.route))
  }
  for (const n of nodeRows) {
    const fid = n.feature_id ? String(n.feature_id) : ''
    if (!fid) continue
    const meta = asRecord(n.meta_json)
    const metaRoute =
      meta && typeof meta.route === 'string' ? meta.route : null
    if (metaRoute) pushScreen(fid, metaRoute)
    else if (n.label_id) pushScreen(fid, String(n.label_id))
    else if (n.source_ref) pushScreen(fid, String(n.source_ref))
  }
  // units keyed by fc_ref — attach after we know feature fc_refs
  const unitsByFc = new Map<string, typeof unitRows>()
  for (const u of unitRows) {
    const fc = u.feature_contract_id ? String(u.feature_contract_id) : ''
    if (!fc) continue
    const list = unitsByFc.get(fc) ?? []
    list.push(u)
    unitsByFc.set(fc, list)
  }

  // apis: page → feature, join endpoints
  const pageById = new Map(pageRows.map((p) => [String(p.id), p] as const))
  const apisByFeature = new Map<string, FlowApi[]>()
  for (const link of apiLinkRows) {
    const page = pageById.get(String(link.page_id))
    if (!page?.feature_id) continue
    const fid = String(page.feature_id)
    const proj = storageProjectIdToUi(String(page.project_id)) ?? undefined
    const api: FlowApi = {
      method: String(link.method),
      path: String(link.path),
      ...(proj ? { proj } : {}),
    }
    const list = apisByFeature.get(fid) ?? []
    // de-dupe method+path+proj
    const sig = `${api.method}\0${api.path}\0${api.proj ?? ''}`
    if (
      !list.some(
        (a) => `${a.method}\0${a.path}\0${a.proj ?? ''}` === sig,
      )
    ) {
      list.push(api)
    }
    apisByFeature.set(fid, list)
  }
  // stable sort apis
  for (const [fid, list] of apisByFeature) {
    list.sort((a, b) =>
      `${a.method} ${a.path}`.localeCompare(`${b.method} ${b.path}`),
    )
    apisByFeature.set(fid, list)
  }

  // ---- Build features / tasks ----
  const featuresByUi: Record<CanonUiProjectId, FlowFeature[]> = {
    rn: [],
    'web-member': [],
    'panel-sales': [],
    affiliate: [],
    backend: [],
  }
  const tasksByFeature: Record<string, FlowTask[]> = {}
  const apisOut: Record<string, FlowApi[]> = {}

  const featureIdsSorted: string[] = []
  const taskMapSigParts: string[] = []
  const platformSigParts: string[] = []

  for (const fr of featureRows) {
    const featureId = String(fr.feature_id)
    featureIdsSorted.push(featureId)
    const fcRefs = asStringArray(fr.fc_refs_json)
    const maps = mapsByFeature.get(featureId) ?? []
    const taskIds = [...new Set(maps.map((m) => m.task_id))].sort()

    // unit screens via fc_refs
    for (const fc of fcRefs) {
      const units = unitsByFc.get(fc) ?? []
      for (const u of units) {
        const ut = (u.unit_type ?? '').toLowerCase()
        if (
          ut === 'screen' ||
          ut === 'route' ||
          ut === 'page' ||
          ut.includes('screen') ||
          ut.includes('route')
        ) {
          if (u.identifier) pushScreen(featureId, String(u.identifier))
        }
      }
    }

    const screens = (screensByFeature.get(featureId) ?? []).slice().sort()
    const verdicts = taskIds.map(
      (tid) => lineageByTask.get(tid)?.parity_verdict ?? null,
    )
    const rolled = rollupVerdicts(verdicts)

    // directory enrichment via fc_refs (first non-null)
    let ringkasan =
      fr.ringkasan_id == null || fr.ringkasan_id === ''
        ? null
        : String(fr.ringkasan_id)
    let docMd: string | undefined
    for (const fc of fcRefs) {
      const dir = dirByFc.get(fc)
      if (!dir) continue
      if (!ringkasan && dir.ringkasan_id) ringkasan = String(dir.ringkasan_id)
      if (!docMd && dir.doc_md) docMd = String(dir.doc_md)
      if (ringkasan && docMd) break
    }

    const uiProjects = platformJsonToUiProjects(fr.platform_json, featureId)
    platformSigParts.push(`${featureId}|${uiProjects.join(',')}`)

    const feat: FlowFeature = {
      id: featureId,
      nama_id: String(fr.nama_id ?? featureId),
      ...(ringkasan ? { ringkasan_id: ringkasan } : {}),
      status: rolled.status,
      pct: rolled.pct,
      screens,
      ...(docMd ? { doc_md: docMd } : {}),
      task_ids: taskIds,
      rollup: {
        terbukti: rolled.terbukti,
        sebagian: rolled.sebagian,
        belum: rolled.belum,
      },
    }

    for (const ui of uiProjects) {
      featuresByUi[ui].push(feat)
    }

    // tasks_by_feature
    const tasks: FlowTask[] = taskIds.map((tid) => {
      const lin = lineageByTask.get(tid)
      const verdict = lin?.parity_verdict
        ? String(lin.parity_verdict)
        : 'PARTIAL'
      const project = repositoryToUiProject(
        lin?.repository == null ? null : String(lin.repository),
      )
      taskMapSigParts.push(`${featureId}|${tid}|${verdict}`)
      return {
        id: tid,
        judul_id: extractTaskTitle(
          tid,
          lin?.stage1_json,
          lin?.implementation_json,
        ),
        verdict,
        ...(project ? { project } : {}),
      }
    })
    tasksByFeature[featureId] = tasks

    const apis = apisByFeature.get(featureId)
    if (apis && apis.length > 0) {
      apisOut[featureId] = apis
    } else {
      apisOut[featureId] = []
    }
  }

  // stable feature order within each UI project
  for (const id of CANON_UI_PROJECT_IDS) {
    featuresByUi[id].sort((a, b) => a.id.localeCompare(b.id))
  }

  // projects meta rollup
  const generatedAt = now().toISOString()
  const projectMetas: FlowProjectMeta[] = CANON_UI_PROJECT_IDS.map((id) => {
    const feats = featuresByUi[id]
    const rollup = emptyRollup()
    const taskIdSet = new Set<string>()
    let pctSum = 0
    for (const f of feats) {
      if (f.rollup) {
        rollup.terbukti += f.rollup.terbukti
        rollup.sebagian += f.rollup.sebagian
        rollup.belum += f.rollup.belum
      }
      for (const tid of f.task_ids ?? []) taskIdSet.add(tid)
      pctSum += f.pct ?? 0
    }
    const taskTotal = rollup.terbukti + rollup.sebagian + rollup.belum
    let status = 'sebagian'
    let pct = 0
    if (taskTotal === 0) {
      status = feats.length === 0 ? 'belum' : 'sebagian'
      pct = 0
    } else if (rollup.belum === taskTotal) {
      status = 'belum'
      pct = 0
    } else if (rollup.terbukti === taskTotal) {
      status = 'terbukti'
      pct = 100
    } else {
      status = 'sebagian'
      pct = Math.round((100 * rollup.terbukti) / taskTotal)
    }
    // Prefer task-weighted; if no tasks, mean feature pct
    if (taskTotal === 0 && feats.length > 0) {
      pct = Math.round(pctSum / feats.length)
    }
    return {
      id,
      label: projectLabel(id),
      features: feats.length,
      tasks: taskIdSet.size,
      rollup,
      pct,
      status,
      generated_at: generatedAt,
    }
  })

  // layers / source tag
  const layers: string[] = ['010']
  if (tables.has('rebuild_lineage_records')) layers.push('009')
  if (tables.has('app_flow_nodes')) layers.push('011')
  if (tables.has('app_pages')) layers.push('012')
  const sourceTag = `mysql:${layers.join('+')}`

  const missingOptional = OPTIONAL_LAYER_TABLES.some((t) => !tables.has(t))
  const availability = missingOptional ? 'partial' : 'available'
  const code: FlowBundleMetaCode = missingOptional ? 'OK_PARTIAL' : 'OK'

  // freshness anchors
  let anchorMs: number | null = null
  for (const lin of lineageRows) {
    if (lin.synced_at) {
      const t = new Date(lin.synced_at).getTime()
      if (!Number.isNaN(t) && (anchorMs == null || t > anchorMs)) anchorMs = t
    }
  }
  for (const p of pageRows) {
    if (p.extracted_at) {
      const t = new Date(p.extracted_at).getTime()
      if (!Number.isNaN(t) && (anchorMs == null || t > anchorMs)) anchorMs = t
    }
  }
  if (rollupRow?.captured_at) {
    const t = new Date(rollupRow.captured_at).getTime()
    if (!Number.isNaN(t) && (anchorMs == null || t > anchorMs)) anchorMs = t
  }
  const nowMs = now().getTime()
  const ageSeconds =
    anchorMs == null ? null : Math.max(0, Math.floor((nowMs - anchorMs) / 1000))
  const stale = ageSeconds != null && ageSeconds > staleSeconds
  const staleReason = stale ? 'FLOW_LINEAGE_STALE' : null

  let lineageMaxSyncedAt: string | null = null
  if (anchorMs != null) lineageMaxSyncedAt = new Date(anchorMs).toISOString()

  let pagesMaxExtractedAt: string | null = null
  for (const p of pageRows) {
    if (!p.extracted_at) continue
    const iso = new Date(p.extracted_at).toISOString()
    if (!pagesMaxExtractedAt || iso > pagesMaxExtractedAt) {
      pagesMaxExtractedAt = iso
    }
  }

  taskMapSigParts.sort()
  platformSigParts.sort()
  featureIdsSorted.sort()

  const sourceHash = sha256Hex(
    stableStringify({
      materializerVersion: MATERIALIZER_VERSION,
      boardId,
      featureIds: featureIdsSorted,
      taskMapSig: taskMapSigParts,
      platformSig: platformSigParts,
      premiumSig: premiumSig(),
      tableSet: tablesPresent,
      lineageMaxSyncedAt,
      pagesMaxExtractedAt,
    }),
  )

  let revision: number | null = null
  if (rollupRow?.id != null) {
    const idNum = Number(rollupRow.id)
    revision = Number.isFinite(idNum) ? idNum : null
  }
  if (revision == null) {
    revision = MATERIALIZER_VERSION * 1_000_000 + featureIdsSorted.length
  }

  const bundle: FlowDataBundle = {
    projects: {
      version: MATERIALIZER_VERSION,
      generated_at: generatedAt,
      source: sourceTag,
      projects: projectMetas,
    },
    premium: {
      name: PREMIUM_FLOW_V1.name,
      desc: PREMIUM_FLOW_V1.desc,
      steps: PREMIUM_FLOW_V1.steps.map((s) => ({ ...s })),
    },
    features: featuresByUi,
    tasks_by_feature: tasksByFeature,
    apis_by_feature: apisOut,
    premium_apis: PREMIUM_FLOW_V1.premium_apis.map((a) => ({ ...a })),
  }

  // Honesty: no edges key
  if ('edges' in (bundle as object)) {
    delete (bundle as { edges?: unknown }).edges
  }

  const meta: FlowBundleMeta = {
    source: 'mysql',
    sourceHash,
    revision,
    generatedAt,
    boardId,
    availability,
    tablesPresent,
    freshness: {
      ageSeconds,
      stale,
      staleReason,
    },
    code,
    detail: `${sourceTag}; curated:${PREMIUM_FLOW_V1.tag}`,
    layers,
    queryCount,
  }

  return { ok: true, load: { bundle, meta } }
}

// ---------------------------------------------------------------------------
// File load + resolve (XOR)
// ---------------------------------------------------------------------------

async function loadFileBundleFromDisk(
  filePath: string,
): Promise<{ bundle: FlowDataBundle; fileHash: string; mtimeMs: number | null }> {
  const raw = await readFile(filePath, 'utf8')
  const bundle = JSON.parse(raw) as FlowDataBundle
  const fileHash = sha256Hex(raw)
  let mtimeMs: number | null = null
  try {
    const st = await stat(filePath)
    mtimeMs = st.mtimeMs
  } catch {
    mtimeMs = null
  }
  return { bundle, fileHash, mtimeMs }
}

function fileMeta(
  bundle: FlowDataBundle,
  opts: {
    boardId: string
    code: FlowBundleMetaCode
    detail?: string
    fileHash: string
    generatedAt: string
  },
): FlowBundleMeta {
  const gen =
    bundle.projects?.generated_at ??
    opts.generatedAt
  return {
    source: 'file',
    sourceHash: opts.fileHash,
    revision: null,
    generatedAt: gen,
    boardId: opts.boardId,
    availability: 'available',
    tablesPresent: [],
    freshness: {
      ageSeconds: null,
      stale: false,
      staleReason: null,
    },
    code: opts.code,
    detail: opts.detail,
  }
}

/**
 * Resolve FlowDataBundle: MySQL (if preferMysql + gate) XOR whole file.
 * Never field-merges. Caches by strict key including sourceHash.
 */
export async function resolveFlowDataBundle(
  opts: ResolveFlowDataBundleOpts = {},
): Promise<FlowBundleLoad> {
  const boardId =
    (opts.boardId ?? DEFAULT_FLOW_BOARD_ID).trim() || DEFAULT_FLOW_BOARD_ID
  const preferMysql = opts.preferMysql !== false
  const now = opts.now ?? (() => new Date())
  const filePath = opts.filePath ?? defaultFilePath()

  // Process-local soft cache: skip re-query when same board/mode/path until reset.
  // Full key still embeds tablesFingerprint + sourceHash after load.
  const softKey = preferMysql
    ? `flow|mysql|${boardId}`
    : `flow|file|${filePath}|forced=${opts.preferMysql === false ? 1 : 0}`
  if (cacheEntry?.softKey === softKey) {
    return cacheEntry.load
  }

  let mysqlFailCode: FlowBundleMetaCode | null = null
  let mysqlFailDetail: string | undefined
  let tablesPresent: string[] = []

  if (preferMysql) {
    try {
      const executor = opts.executor ?? (await createDefaultExecutor())
      const result = await materializeFromMysql({
        boardId,
        executor,
        now,
        staleSeconds: opts.staleSeconds,
      })
      if (result.ok) {
        const load = result.load
        const key = `flow|mysql|${boardId}|${load.meta.tablesPresent.join(',')}|${load.meta.sourceHash}`
        cacheEntry = { key, softKey, load }
        return load
      }
      mysqlFailCode = result.code
      mysqlFailDetail = result.detail
      tablesPresent = result.tablesPresent
    } catch (err) {
      mysqlFailCode = 'DB_ERROR'
      mysqlFailDetail = redactSecrets(
        err instanceof Error ? err.message : String(err),
      )
    }
  } else {
    mysqlFailCode = 'FILE_FORCED'
    mysqlFailDetail = 'preferMysql=false'
  }

  // File fallback (whole bundle only)
  try {
    let bundle: FlowDataBundle
    let fileHash: string

    if (opts.fileBundle !== undefined) {
      if (opts.fileBundle === null) {
        throw new Error('FILE_MISSING: injected fileBundle is null')
      }
      bundle = opts.fileBundle
      fileHash = sha256Hex(stableStringify(bundle))
    } else {
      const loaded = await loadFileBundleFromDisk(filePath)
      bundle = loaded.bundle
      fileHash = loaded.fileHash
    }

    const generatedAt = now().toISOString()
    const code: FlowBundleMetaCode =
      mysqlFailCode === 'FILE_FORCED'
        ? 'FILE_FORCED'
        : mysqlFailCode
          ? 'FILE_FALLBACK'
          : 'OK'

    // Ensure projects.source is file when we served file (preserve existing if present)
    if (!bundle.projects) {
      bundle = {
        ...bundle,
        projects: {
          version: MATERIALIZER_VERSION,
          generated_at: generatedAt,
          source: 'file',
          projects: [],
        },
      }
    }

    const load: FlowBundleLoad = {
      bundle,
      meta: {
        ...fileMeta(bundle, {
          boardId,
          code,
          detail: mysqlFailDetail
            ? redactSecrets(
                `fallback after ${mysqlFailCode}: ${mysqlFailDetail}`,
              )
            : 'file',
          fileHash,
          generatedAt,
        }),
        tablesPresent,
      },
    }

    const key = `flow|file|${filePath}|${fileHash}`
    // File fallback after mysql gate fail uses soft key that includes fail code so a later
    // successful mysql path (after reset) is not blocked; softKey already set above for prefer mode.
    const fileSoftKey =
      mysqlFailCode && mysqlFailCode !== 'FILE_FORCED'
        ? `flow|file-fallback|${boardId}|${mysqlFailCode}|${fileHash}`
        : softKey
    cacheEntry = { key, softKey: fileSoftKey, load }
    return load
  } catch (fileErr) {
    const generatedAt = now().toISOString()
    const detail = redactSecrets(
      [
        mysqlFailCode
          ? `mysql:${mysqlFailCode}${mysqlFailDetail ? `(${mysqlFailDetail})` : ''}`
          : null,
        `file:${fileErr instanceof Error ? fileErr.message : String(fileErr)}`,
      ]
        .filter(Boolean)
        .join('; '),
    )
    const bundle = emptyFlowDataBundle(generatedAt)
    const sourceHash = sha256Hex(
      stableStringify({
        materializerVersion: MATERIALIZER_VERSION,
        boardId,
        empty: true,
      }),
    )
    const load: FlowBundleLoad = {
      bundle,
      meta: {
        source: 'empty',
        sourceHash,
        revision: null,
        generatedAt,
        boardId,
        availability: 'unavailable',
        tablesPresent,
        freshness: {
          ageSeconds: null,
          stale: false,
          staleReason: null,
        },
        code: 'UNAVAILABLE',
        detail,
      },
    }
    cacheEntry = {
      key: `flow|empty|${boardId}|${sourceHash}`,
      softKey: `flow|empty|${boardId}`,
      load,
    }
    return load
  }
}

async function createDefaultExecutor(): Promise<FlowDataSqlExecutor> {
  // Dynamic import keeps unit tests free of a live pool when injecting executor.
  const { db } = await import('#/server/db')
  const pool = db()
  return {
    async query(sql, params) {
      return pool.query(sql, params) as Promise<[unknown, unknown?]>
    },
  }
}

/** Tables fingerprint helper for tests. */
export function fingerprintTables(tables: string[]): string {
  return [...tables].sort().join(',')
}
