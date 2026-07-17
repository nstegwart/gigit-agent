/**
 * Product-feature taxonomy store (FEAT-*) — ADDENDUM V1.1 §B.
 * Layer above FC contracts: product_features + feature_task_map.
 * Plan/dry-run helpers are pure (no DB). Apply path is host-gated by the sync CLI.
 * Does not touch pin/lifecycle/classification tables.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db } from './db'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'
import {
  defaultSyncPaths,
  loadFeatureContracts,
  type FeatureContractLoaded,
  type FeatureDirectoryRow,
  type FeatureUnitRow,
  type RebuildLineageRecord,
  type SyncPaths,
} from './rebuild-lineage-store'

// ---------------------------------------------------------------------------
// Types (mirror migration 010 columns)
// ---------------------------------------------------------------------------

export type JoinSource = 'fc' | 'node' | 'prefix' | 'keyword' | 'curated'

export const JOIN_CONFIDENCE: Record<JoinSource, number> = {
  fc: 1.0,
  curated: 1.0,
  node: 0.8,
  prefix: 0.6,
  keyword: 0.4,
}

export const STABLE_DOMAINS = [
  'Latihan & Program',
  'Kesehatan & Wellness',
  'Pembayaran & Langganan',
  'Konten & Media',
  'Akun & Profil',
  'Sosial & Komunitas',
  'Admin & Operasional',
  'Platform & Infrastruktur',
] as const

export interface ProductFeatureRow {
  featureId: string
  namaId: string
  domainBisnis: string
  ringkasanId: string | null
  platformJson: unknown
  capabilitiesJson: unknown
  fcRefsJson: unknown
  curated: boolean
}

export interface FeatureTaskMapRow {
  featureId: string
  taskId: string
  joinSource: JoinSource
  confidence: number
}

export interface ProductFeatureJoinHints {
  fcMulti?: boolean
  nodes?: Array<string>
  idIncludes?: Array<string>
  keywords?: Array<string>
}

export interface ProductFeatureSeedEntry {
  feature_id: string
  nama_id: string
  domain_bisnis: string
  ringkasan_id?: string | null
  platform_json?: unknown
  capabilities_json?: unknown
  fc_refs_json?: unknown
  curated?: boolean
  join?: {
    fc_multi?: boolean
    nodes?: Array<string>
    id_includes?: Array<string>
    keywords?: Array<string>
  }
}

export interface ProductFeatureSeedFile {
  version?: number
  draft?: boolean
  domains?: Array<string>
  features: Array<ProductFeatureSeedEntry>
  curated_maps?: Array<{
    feature_id: string
    task_id: string
    join_source?: JoinSource
    confidence?: number
  }>
}

export interface Feature360 {
  feature: ProductFeatureRow
  taskMaps: Array<FeatureTaskMapRow>
  taskIds: Array<string>
  lineage: Array<RebuildLineageRecord>
  units: Array<FeatureUnitRow>
  directory: Array<FeatureDirectoryRow>
  rollup: {
    mappingPct: number | null
    mappedTaskCount: number
    lineageCount: number
    parityMapped100: number
    parityTotal: number
    parityMappedPct: number | null
  }
}

export interface ProductFeatureSqlExecutor {
  query(sql: string, params?: Array<unknown>): Promise<[unknown, unknown?]>
}

export interface ProductFeatureSyncCounts {
  product_features: number
  feature_task_map: number
  feature_task_map_by_join_source: Record<string, number>
  unmapped_tasks: number
  meditation_check: {
    candidate_count: number
    mapped_to_feat_meditation: number
    unmapped_candidate_count: number
  }
  fc_covered: number
  fc_total: number
}

export interface ProductFeatureSyncPlan {
  counts: ProductFeatureSyncCounts
  features: Array<ProductFeatureRow>
  maps: Array<FeatureTaskMapRow>
  unmappedTaskIds: Array<string>
  durationMs: number
  mode: 'dry-run' | 'apply'
  seedPath: string
}

function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null)
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

function asStringArray(value: unknown): Array<string> {
  if (!value) return []
  if (Array.isArray(value)) return value.map(String).filter(Boolean)
  if (typeof value === 'string') {
    try {
      const p = JSON.parse(value) as unknown
      if (Array.isArray(p)) return p.map(String).filter(Boolean)
    } catch {
      return value ? [value] : []
    }
  }
  return []
}

function defaultExecutor(): ProductFeatureSqlExecutor {
  return {
    async query(sql, params) {
      return db().query(sql, params) as Promise<[unknown, unknown?]>
    },
  }
}

// ---------------------------------------------------------------------------
// Seed load + validation
// ---------------------------------------------------------------------------

export function defaultProductFeaturesSeedPath(cwd: string = process.cwd()): string {
  return path.join(cwd, 'data/product-features.seed.json')
}

export function loadProductFeaturesSeed(seedPath: string): ProductFeatureSeedFile {
  if (!fs.existsSync(seedPath)) {
    throw new Error(`PRODUCT_FEATURES_SEED_MISSING: ${seedPath}`)
  }
  const raw = JSON.parse(fs.readFileSync(seedPath, 'utf8')) as ProductFeatureSeedFile
  if (!Array.isArray(raw.features) || raw.features.length === 0) {
    throw new Error('PRODUCT_FEATURES_SEED_EMPTY')
  }
  return raw
}

/** Simple non-English heuristic: nama_id should look human id-ID (not pure EN title / FEAT id). */
export function namaIdLooksIndonesian(nama: string): boolean {
  const t = nama.trim()
  if (!t) return false
  // Reject pure SCREAMING_SNAKE / FEAT ids
  if (/^FEAT[-_A-Z0-9]+$/.test(t)) return false
  if (/^[A-Z0-9_]+$/.test(t) && !/\s/.test(t)) return false

  // Exact pure-English titles (denylist) — used only as negative gate in tests/seed
  const pureEn = new Set([
    'meditation',
    'meditation catalog',
    'fasting',
    'intermittent fasting',
    'workout',
    'workout program',
    'challenge',
    'checkout',
    'premium',
    'profile',
    'privacy',
    'support',
    'legal',
    'affiliate',
    'teams',
    'security',
    'baseline',
    'inventory',
    'paywall',
    'upgrade',
    'voucher',
    'promo',
    'content',
    'home',
    'shell',
    'catalog',
    'player',
    'session',
  ])
  if (pureEn.has(t.toLowerCase())) return false

  // Non-ASCII → accept
  if (/[^\x00-\x7F]/.test(t)) return true

  // Known Indonesian / human product tokens used in draft seed
  const idHints =
    /\b(dan|atau|untuk|dari|yang|dengan|ke|di|pelacak|program|latihan|meditasi|puasa|haid|pembayaran|anggota|akun|profil|konten|admin|portal|operasi|gerbang|bukti|keamanan|reseller|tim|poin|harga|voucher|promo|checkout|beranda|dukungan|legal|afiliasi|korporat|resep|rencana|relaksasi|pengingat|premium|matriks|kolaborasi|upgrade|paywall|landing|inventaris|baseline|profesional|tahan|terverifikasi|pengaturan|transaksi|shell|aplikasi|media|artikel|napas|intermiten|lencana|peringkat|dalam|web|member|sales|email|peran|siklus|sumber|lite|full|gratis|uji|coba|paket|ringkasan|bahasa|lokalitas|kebugaran|tubuh|tantangan|papan|terpandu|anggota|lanjutan|terverifikasi|pengaturan|pembelian)\b/i
  if (idHints.test(t)) return true

  // Multi-word human title with mixed loanwords (e.g. "Checkout Web") — weak accept
  if (/\s/.test(t) && /[A-Za-z]/.test(t)) return true
  return false
}

export function validateProductFeaturesSeed(
  seed: ProductFeatureSeedFile,
  allFcIds: ReadonlyArray<string>,
): {
  ok: boolean
  featureCount: number
  uniqueIds: boolean
  allFcCovered: boolean
  missingFcIds: Array<string>
  duplicateIds: Array<string>
  nonIdNama: Array<string>
  domainErrors: Array<string>
} {
  const ids = seed.features.map((f) => f.feature_id)
  const idSet = new Set(ids)
  const duplicateIds = ids.filter((id, i) => ids.indexOf(id) !== i)
  const covered = new Set<string>()
  for (const f of seed.features) {
    for (const fc of asStringArray(f.fc_refs_json)) covered.add(fc)
  }
  const missingFcIds = allFcIds.filter((fc) => !covered.has(fc))
  const nonIdNama = seed.features
    .filter((f) => !namaIdLooksIndonesian(f.nama_id))
    .map((f) => `${f.feature_id}:${f.nama_id}`)
  const domainSet = new Set(seed.domains ?? [...STABLE_DOMAINS])
  const domainErrors = seed.features
    .filter((f) => !domainSet.has(f.domain_bisnis) && !STABLE_DOMAINS.includes(f.domain_bisnis as (typeof STABLE_DOMAINS)[number]))
    .map((f) => `${f.feature_id}:${f.domain_bisnis}`)

  const featureCount = seed.features.length
  const uniqueIds = idSet.size === ids.length
  const allFcCovered = missingFcIds.length === 0
  const ok =
    uniqueIds &&
    allFcCovered &&
    nonIdNama.length === 0 &&
    domainErrors.length === 0 &&
    featureCount >= 40 &&
    featureCount <= 90

  return {
    ok,
    featureCount,
    uniqueIds,
    allFcCovered,
    missingFcIds,
    duplicateIds: [...new Set(duplicateIds)],
    nonIdNama,
    domainErrors,
  }
}

export function seedToProductFeatureRows(seed: ProductFeatureSeedFile): Array<ProductFeatureRow> {
  return seed.features.map((f) => ({
    featureId: f.feature_id,
    namaId: f.nama_id,
    domainBisnis: f.domain_bisnis,
    ringkasanId: f.ringkasan_id != null ? String(f.ringkasan_id) : null,
    platformJson: f.platform_json ?? null,
    capabilitiesJson: f.capabilities_json ?? null,
    fcRefsJson: f.fc_refs_json ?? [],
    curated: Boolean(f.curated),
  }))
}

// ---------------------------------------------------------------------------
// Layered join: curated > fc > node > prefix > keyword (curated overrides)
// Confidence: 1.0 fc/curated, 0.8 node, 0.6 prefix, 0.4 keyword
// ---------------------------------------------------------------------------

export interface TaskJoinInput {
  taskId: string
  featureContractId: string | null
  nodeIds: Array<string>
  /** Free-text blob for keyword (anchors, stage1 json, title, etc.) */
  searchBlob: string
}

function extractNodeIds(stage1: Record<string, unknown> | null | undefined, rec: Record<string, unknown>): Array<string> {
  const out: Array<string> = []
  const candidates = [
    stage1?.nodeIds,
    stage1?.node_ids,
    stage1?.nodes,
    rec.nodeIds,
    rec.node_ids,
  ]
  for (const c of candidates) {
    if (Array.isArray(c)) {
      for (const n of c) {
        if (typeof n === 'string') out.push(n)
        else if (n && typeof n === 'object' && (n as { id?: string }).id) {
          out.push(String((n as { id: string }).id))
        }
      }
    }
  }
  // Also scan covered units that look like node ids
  const units =
    (stage1?.covered_gap_units as unknown[]) ??
    (stage1?.covered_legacy_units as unknown[]) ??
    []
  for (const u of units) {
    if (typeof u === 'string' && /^[A-Z]{2,}-[A-Z0-9-]+$/i.test(u)) out.push(u)
  }
  return [...new Set(out)]
}

export function taskJoinInputFromLineageRaw(rec: Record<string, unknown>): TaskJoinInput {
  const taskId = String(rec.task_id ?? rec.taskId ?? '')
  const stage1 = (rec.stage1 ?? {}) as Record<string, unknown>
  const fc =
    (typeof stage1.featureContractId === 'string' && stage1.featureContractId) ||
    (typeof rec.featureContractId === 'string' && rec.featureContractId) ||
    (typeof rec.feature_contract_id === 'string' && rec.feature_contract_id) ||
    null
  const nodeIds = extractNodeIds(stage1, rec)
  const searchBlob = `${taskId}\n${stableJson(stage1)}\n${stableJson(rec.legacy_to_rebuild ?? {})}\n${stableJson(rec.implementation ?? {})}`.toLowerCase()
  return {
    taskId,
    featureContractId: fc,
    nodeIds,
    searchBlob,
  }
}

export function taskJoinInputFromLineageRecord(row: RebuildLineageRecord): TaskJoinInput {
  const stage1 = (row.stage1Json ?? {}) as Record<string, unknown>
  const nodeIds = extractNodeIds(stage1, {})
  const searchBlob =
    `${row.taskId}\n${stableJson(row.stage1Json)}\n${stableJson(row.evidenceJson)}\n${stableJson(row.implementationJson)}`.toLowerCase()
  return {
    taskId: row.taskId,
    featureContractId: row.featureContractId,
    nodeIds,
    searchBlob,
  }
}

interface CompiledFeature {
  row: ProductFeatureRow
  fcRefs: Array<string>
  fcMulti: boolean
  nodes: Set<string>
  idIncludes: Array<string>
  keywords: Array<string>
}

function compileFeatures(seed: ProductFeatureSeedFile): Array<CompiledFeature> {
  return seed.features.map((f) => {
    const join = f.join ?? {}
    return {
      row: {
        featureId: f.feature_id,
        namaId: f.nama_id,
        domainBisnis: f.domain_bisnis,
        ringkasanId: f.ringkasan_id != null ? String(f.ringkasan_id) : null,
        platformJson: f.platform_json ?? null,
        capabilitiesJson: f.capabilities_json ?? null,
        fcRefsJson: f.fc_refs_json ?? [],
        curated: Boolean(f.curated),
      },
      fcRefs: asStringArray(f.fc_refs_json),
      fcMulti: Boolean(join.fc_multi),
      nodes: new Set(join.nodes ?? []),
      idIncludes: (join.id_includes ?? []).map((s) => s.toUpperCase()),
      keywords: (join.keywords ?? []).map((s) => s.toLowerCase()),
    }
  })
}

/**
 * Layered join per addendum B:
 * (1) featureContractId → fc (skipped when FC claimed by multiple FEAT with fc_multi)
 * (2) nodeIds → node
 * (3) prefix/id_includes on task_id → prefix
 * (4) keyword on search blob → keyword
 * (5) curated override (applied last, wins)
 *
 * A task may map to multiple features (e.g. suite integration). Best join_source
 * per (feature, task) pair is kept (highest confidence, curated wins).
 */
export function buildFeatureTaskMaps(
  seed: ProductFeatureSeedFile,
  tasks: ReadonlyArray<TaskJoinInput>,
): Array<FeatureTaskMapRow> {
  const compiled = compileFeatures(seed)

  // FC → features that claim it (for exclusive vs multi)
  const fcClaimants = new Map<string, Array<CompiledFeature>>()
  for (const c of compiled) {
    for (const fc of c.fcRefs) {
      const list = fcClaimants.get(fc) ?? []
      list.push(c)
      fcClaimants.set(fc, list)
    }
  }

  // key featureId\0taskId → best row
  const best = new Map<string, FeatureTaskMapRow>()

  const put = (featureId: string, taskId: string, joinSource: JoinSource) => {
    const key = `${featureId}\0${taskId}`
    const confidence = JOIN_CONFIDENCE[joinSource]
    const prev = best.get(key)
    // curated always wins; else higher confidence wins; tie keeps earlier (higher layer)
    if (!prev) {
      best.set(key, { featureId, taskId, joinSource, confidence })
      return
    }
    if (joinSource === 'curated') {
      best.set(key, { featureId, taskId, joinSource, confidence })
      return
    }
    if (prev.joinSource === 'curated') return
    if (confidence > prev.confidence) {
      best.set(key, { featureId, taskId, joinSource, confidence })
    }
  }

  for (const task of tasks) {
    if (!task.taskId) continue
    const tidUpper = task.taskId.toUpperCase()
    const blob = task.searchBlob.toLowerCase()

    // (1) fc
    if (task.featureContractId) {
      const claimants = fcClaimants.get(task.featureContractId) ?? []
      const exclusive = claimants.filter((c) => !c.fcMulti)
      // Only exclusive (non-multi) claimants get pure fc join
      for (const c of exclusive) {
        put(c.row.featureId, task.taskId, 'fc')
      }
      // If exactly one multi claimant and no exclusive, still allow fc for that one
      if (exclusive.length === 0 && claimants.length === 1) {
        put(claimants[0]!.row.featureId, task.taskId, 'fc')
      }
    }

    // (2) node
    for (const c of compiled) {
      for (const n of task.nodeIds) {
        if (c.nodes.has(n)) {
          put(c.row.featureId, task.taskId, 'node')
          break
        }
      }
    }

    // (3) prefix / id_includes
    for (const c of compiled) {
      for (const inc of c.idIncludes) {
        if (inc && tidUpper.includes(inc)) {
          put(c.row.featureId, task.taskId, 'prefix')
          break
        }
      }
    }

    // (4) keyword
    for (const c of compiled) {
      for (const kw of c.keywords) {
        if (kw && blob.includes(kw)) {
          put(c.row.featureId, task.taskId, 'keyword')
          break
        }
      }
    }
  }

  // (5) curated overrides
  for (const cm of seed.curated_maps ?? []) {
    if (!cm.feature_id || !cm.task_id) continue
    put(cm.feature_id, cm.task_id, 'curated')
  }

  return [...best.values()].sort((a, b) =>
    a.featureId === b.featureId
      ? a.taskId.localeCompare(b.taskId)
      : a.featureId.localeCompare(b.featureId),
  )
}

export function listUnmappedTaskIds(
  allTaskIds: ReadonlyArray<string>,
  maps: ReadonlyArray<FeatureTaskMapRow>,
): Array<string> {
  const mapped = new Set(maps.map((m) => m.taskId))
  return allTaskIds.filter((id) => !mapped.has(id)).sort()
}

export function countMapsByJoinSource(maps: ReadonlyArray<FeatureTaskMapRow>): Record<string, number> {
  const out: Record<string, number> = { fc: 0, node: 0, prefix: 0, keyword: 0, curated: 0 }
  for (const m of maps) {
    out[m.joinSource] = (out[m.joinSource] ?? 0) + 1
  }
  return out
}

export function meditationCandidateTaskIds(tasks: ReadonlyArray<TaskJoinInput>): Array<string> {
  const re = /meditat|meditasi/i
  return tasks
    .filter((t) => re.test(t.taskId) || re.test(t.searchBlob))
    .map((t) => t.taskId)
}

export function meditationCheck(
  maps: ReadonlyArray<FeatureTaskMapRow>,
  candidateTaskIds: ReadonlyArray<string>,
  featureId = 'FEAT-MEDITATION',
): ProductFeatureSyncCounts['meditation_check'] {
  const mappedSet = new Set(
    maps.filter((m) => m.featureId === featureId).map((m) => m.taskId),
  )
  let mapped = 0
  for (const id of candidateTaskIds) {
    if (mappedSet.has(id)) mapped++
  }
  return {
    candidate_count: candidateTaskIds.length,
    mapped_to_feat_meditation: mapped,
    unmapped_candidate_count: candidateTaskIds.length - mapped,
  }
}

// ---------------------------------------------------------------------------
// Upsert / read
// ---------------------------------------------------------------------------

const FEATURE_UPSERT_SQL = `
INSERT INTO product_features (
  feature_id, nama_id, domain_bisnis, ringkasan_id,
  platform_json, capabilities_json, fc_refs_json, curated
) VALUES (?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?)
ON DUPLICATE KEY UPDATE
  nama_id = VALUES(nama_id),
  domain_bisnis = VALUES(domain_bisnis),
  ringkasan_id = VALUES(ringkasan_id),
  platform_json = VALUES(platform_json),
  capabilities_json = VALUES(capabilities_json),
  fc_refs_json = VALUES(fc_refs_json),
  curated = VALUES(curated)
`

export async function upsertProductFeatures(
  rows: ReadonlyArray<ProductFeatureRow>,
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<number> {
  let n = 0
  for (const r of rows) {
    await executor.query(FEATURE_UPSERT_SQL, [
      r.featureId,
      r.namaId,
      r.domainBisnis,
      r.ringkasanId,
      stableJson(r.platformJson),
      stableJson(r.capabilitiesJson),
      stableJson(r.fcRefsJson),
      r.curated ? 1 : 0,
    ])
    n++
  }
  return n
}

const MAP_UPSERT_SQL = `
INSERT INTO feature_task_map (
  feature_id, task_id, join_source, confidence
) VALUES (?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  join_source = VALUES(join_source),
  confidence = VALUES(confidence)
`

export async function upsertFeatureTaskMaps(
  rows: ReadonlyArray<FeatureTaskMapRow>,
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<number> {
  let n = 0
  for (const r of rows) {
    await executor.query(MAP_UPSERT_SQL, [
      r.featureId,
      r.taskId,
      r.joinSource,
      r.confidence,
    ])
    n++
  }
  return n
}

function mapFeatureRow(r: RowDataPacket): ProductFeatureRow {
  return {
    featureId: String(r.feature_id),
    namaId: String(r.nama_id ?? ''),
    domainBisnis: String(r.domain_bisnis ?? ''),
    ringkasanId: r.ringkasan_id != null ? String(r.ringkasan_id) : null,
    platformJson: parseJsonCell(r.platform_json),
    capabilitiesJson: parseJsonCell(r.capabilities_json),
    fcRefsJson: parseJsonCell(r.fc_refs_json),
    curated: Boolean(Number(r.curated ?? 0)),
  }
}

function mapTaskMapRow(r: RowDataPacket): FeatureTaskMapRow {
  return {
    featureId: String(r.feature_id),
    taskId: String(r.task_id),
    joinSource: String(r.join_source) as JoinSource,
    confidence: Number(r.confidence ?? 0),
  }
}

export async function listProductFeatures(
  opts: { domainBisnis?: string } = {},
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<Array<ProductFeatureRow>> {
  if (opts.domainBisnis) {
    const [rows] = await executor.query(
      `SELECT * FROM product_features WHERE domain_bisnis = ? ORDER BY nama_id ASC`,
      [opts.domainBisnis],
    )
    return ((rows as RowDataPacket[]) ?? []).map(mapFeatureRow)
  }
  const [rows] = await executor.query(
    `SELECT * FROM product_features ORDER BY domain_bisnis ASC, nama_id ASC`,
  )
  return ((rows as RowDataPacket[]) ?? []).map(mapFeatureRow)
}

export async function listFeatureTaskMaps(
  opts: { featureId?: string; taskId?: string } = {},
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<Array<FeatureTaskMapRow>> {
  if (opts.featureId && opts.taskId) {
    const [rows] = await executor.query(
      `SELECT * FROM feature_task_map WHERE feature_id = ? AND task_id = ?`,
      [opts.featureId, opts.taskId],
    )
    return ((rows as RowDataPacket[]) ?? []).map(mapTaskMapRow)
  }
  if (opts.featureId) {
    const [rows] = await executor.query(
      `SELECT * FROM feature_task_map WHERE feature_id = ? ORDER BY task_id ASC`,
      [opts.featureId],
    )
    return ((rows as RowDataPacket[]) ?? []).map(mapTaskMapRow)
  }
  if (opts.taskId) {
    const [rows] = await executor.query(
      `SELECT * FROM feature_task_map WHERE task_id = ? ORDER BY feature_id ASC`,
      [opts.taskId],
    )
    return ((rows as RowDataPacket[]) ?? []).map(mapTaskMapRow)
  }
  const [rows] = await executor.query(
    `SELECT * FROM feature_task_map ORDER BY feature_id ASC, task_id ASC`,
  )
  return ((rows as RowDataPacket[]) ?? []).map(mapTaskMapRow)
}

/**
 * Unmapped tasks: task ids present in the provided universe that have no feature_task_map row.
 * When executor-only, pass allTaskIds from lineage plan.
 */
export async function listUnmappedTasks(
  allTaskIds: ReadonlyArray<string>,
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<Array<string>> {
  const maps = await listFeatureTaskMaps({}, executor)
  return listUnmappedTaskIds(allTaskIds, maps)
}

/**
 * Feature 360: product feature + task maps + optional lineage/units/directory joins.
 * Lineage/units/directory are supplied by caller (from memory or rebuild-lineage-store reads)
 * to keep this module free of cross-table SQL when tables may not exist yet.
 */
export async function getFeature360(
  featureId: string,
  opts: {
    lineage?: ReadonlyArray<RebuildLineageRecord>
    units?: ReadonlyArray<FeatureUnitRow>
    directory?: ReadonlyArray<FeatureDirectoryRow>
  } = {},
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<Feature360 | null> {
  const features = await listProductFeatures({}, executor)
  const feature = features.find((f) => f.featureId === featureId)
  if (!feature) return null

  const taskMaps = await listFeatureTaskMaps({ featureId }, executor)
  const taskIdSet = new Set(taskMaps.map((m) => m.taskId))
  const taskIds = [...taskIdSet].sort()

  const lineage = (opts.lineage ?? []).filter((r) => taskIdSet.has(r.taskId))
  const fcRefs = asStringArray(feature.fcRefsJson)
  const units = (opts.units ?? []).filter(
    (u) => u.featureContractId != null && fcRefs.includes(u.featureContractId),
  )
  const directory = (opts.directory ?? []).filter((d) => fcRefs.includes(d.featureContractId))

  const parityMapped100 = lineage.filter((r) => r.parityVerdict === 'MAPPED_100').length
  const parityTotal = lineage.length
  const mappedTaskCount = taskIds.length
  // mapping_pct: tasks with a feature map / tasks known for feature (same set once mapped)
  const mappingPct = mappedTaskCount > 0 ? 100 : null
  const parityMappedPct =
    parityTotal > 0 ? Math.round((parityMapped100 / parityTotal) * 1000) / 10 : null

  return {
    feature,
    taskMaps,
    taskIds,
    lineage,
    units,
    directory,
    rollup: {
      mappingPct,
      mappedTaskCount,
      lineageCount: parityTotal,
      parityMapped100,
      parityTotal,
      parityMappedPct,
    },
  }
}

// ---------------------------------------------------------------------------
// Memory executor (unit tests — no real MySQL)
// ---------------------------------------------------------------------------

export function createMemoryProductFeaturesExecutor(): ProductFeatureSqlExecutor & {
  features: Map<string, ProductFeatureRow>
  maps: Map<string, FeatureTaskMapRow>
  statements: Array<{ sql: string; params?: Array<unknown> }>
} {
  const features = new Map<string, ProductFeatureRow>()
  const maps = new Map<string, FeatureTaskMapRow>()
  const statements: Array<{ sql: string; params?: Array<unknown> }> = []
  const mapKey = (f: string, t: string) => `${f}\0${t}`

  return {
    features,
    maps,
    statements,
    async query(sql: string, params: Array<unknown> = []) {
      statements.push({ sql, params })
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase()

      if (s.startsWith('INSERT INTO PRODUCT_FEATURES')) {
        const [
          featureId,
          namaId,
          domainBisnis,
          ringkasanId,
          platformJson,
          capabilitiesJson,
          fcRefsJson,
          curated,
        ] = params
        features.set(String(featureId), {
          featureId: String(featureId),
          namaId: String(namaId ?? ''),
          domainBisnis: String(domainBisnis ?? ''),
          ringkasanId: ringkasanId != null ? String(ringkasanId) : null,
          platformJson:
            typeof platformJson === 'string' ? JSON.parse(platformJson) : platformJson,
          capabilitiesJson:
            typeof capabilitiesJson === 'string'
              ? JSON.parse(capabilitiesJson)
              : capabilitiesJson,
          fcRefsJson: typeof fcRefsJson === 'string' ? JSON.parse(fcRefsJson) : fcRefsJson,
          curated: Boolean(Number(curated ?? 0)),
        })
        return [{ affectedRows: 1 } as ResultSetHeader]
      }

      if (s.startsWith('INSERT INTO FEATURE_TASK_MAP')) {
        const [featureId, taskId, joinSource, confidence] = params
        maps.set(mapKey(String(featureId), String(taskId)), {
          featureId: String(featureId),
          taskId: String(taskId),
          joinSource: String(joinSource) as JoinSource,
          confidence: Number(confidence ?? 0),
        })
        return [{ affectedRows: 1 } as ResultSetHeader]
      }

      if (s.startsWith('SELECT * FROM PRODUCT_FEATURES')) {
        let list = [...features.values()]
        if (s.includes('WHERE DOMAIN_BISNIS')) {
          const [dom] = params
          list = list.filter((f) => f.domainBisnis === String(dom))
        }
        list.sort((a, b) =>
          a.domainBisnis === b.domainBisnis
            ? a.namaId.localeCompare(b.namaId)
            : a.domainBisnis.localeCompare(b.domainBisnis),
        )
        return [
          list.map((f) => ({
            feature_id: f.featureId,
            nama_id: f.namaId,
            domain_bisnis: f.domainBisnis,
            ringkasan_id: f.ringkasanId,
            platform_json: f.platformJson,
            capabilities_json: f.capabilitiesJson,
            fc_refs_json: f.fcRefsJson,
            curated: f.curated ? 1 : 0,
          })),
        ]
      }

      if (s.startsWith('SELECT * FROM FEATURE_TASK_MAP')) {
        let list = [...maps.values()]
        if (s.includes('WHERE FEATURE_ID = ? AND TASK_ID = ?')) {
          const [featureId, taskId] = params
          list = list.filter(
            (m) => m.featureId === String(featureId) && m.taskId === String(taskId),
          )
        } else if (s.includes('WHERE FEATURE_ID = ?')) {
          const [featureId] = params
          list = list.filter((m) => m.featureId === String(featureId))
        } else if (s.includes('WHERE TASK_ID = ?')) {
          const [taskId] = params
          list = list.filter((m) => m.taskId === String(taskId))
        }
        list.sort((a, b) =>
          a.featureId === b.featureId
            ? a.taskId.localeCompare(b.taskId)
            : a.featureId.localeCompare(b.featureId),
        )
        return [
          list.map((m) => ({
            feature_id: m.featureId,
            task_id: m.taskId,
            join_source: m.joinSource,
            confidence: m.confidence,
          })),
        ]
      }

      throw new Error(`memory product-features executor: unsupported SQL: ${sql.slice(0, 120)}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Pure sync planning (seed + lineage artifacts → rows). No DB.
// ---------------------------------------------------------------------------

export function buildProductFeatureSyncPlan(
  opts: {
    seedPath?: string
    workspaceRoot?: string
    syncPaths?: SyncPaths
    mode?: 'dry-run' | 'apply'
    cwd?: string
  } = {},
): ProductFeatureSyncPlan {
  const t0 = Date.now()
  const mode = opts.mode ?? 'dry-run'
  const cwd = opts.cwd ?? process.cwd()
  const seedPath = opts.seedPath ?? defaultProductFeaturesSeedPath(cwd)
  const paths = opts.syncPaths ?? defaultSyncPaths(opts.workspaceRoot ?? '/opt/mfs/workspace')

  const seed = loadProductFeaturesSeed(seedPath)
  const contracts: Array<FeatureContractLoaded> = loadFeatureContracts(paths.featureContractsDir)
  const allFcIds = contracts.map((c) => c.id).filter((id) => id.startsWith('FC-'))
  const validation = validateProductFeaturesSeed(seed, allFcIds)
  if (!validation.ok) {
    throw new Error(
      `PRODUCT_FEATURES_SEED_INVALID: missingFc=${validation.missingFcIds.length} dupes=${validation.duplicateIds.length} nonIdNama=${validation.nonIdNama.length} domains=${validation.domainErrors.length} count=${validation.featureCount}`,
    )
  }

  if (!fs.existsSync(paths.lineageJsonl)) {
    throw new Error(`LINEAGE_MISSING: ${paths.lineageJsonl}`)
  }

  const tasks: Array<TaskJoinInput> = []
  for (const line of fs.readFileSync(paths.lineageJsonl, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    const rec = JSON.parse(t) as Record<string, unknown>
    tasks.push(taskJoinInputFromLineageRaw(rec))
  }

  // Enrich nodeIds from feature contracts (task_id on nodes → node id)
  const taskToNodes = new Map<string, Array<string>>()
  for (const c of contracts) {
    for (const n of (c.json.nodes as Array<Record<string, unknown>> | undefined) ?? []) {
      if (!n || typeof n !== 'object') continue
      const nodeId = n.id != null ? String(n.id) : null
      const taskId = n.task_id != null ? String(n.task_id) : null
      if (nodeId && taskId) {
        const list = taskToNodes.get(taskId) ?? []
        list.push(nodeId)
        taskToNodes.set(taskId, list)
      }
    }
  }
  for (const task of tasks) {
    const extra = taskToNodes.get(task.taskId)
    if (extra?.length) {
      task.nodeIds = [...new Set([...task.nodeIds, ...extra])]
    }
  }

  const features = seedToProductFeatureRows(seed)
  const maps = buildFeatureTaskMaps(seed, tasks)
  const allTaskIds = tasks.map((t) => t.taskId)
  const unmappedTaskIds = listUnmappedTaskIds(allTaskIds, maps)
  const candidates = meditationCandidateTaskIds(tasks)
  const med = meditationCheck(maps, candidates)

  const counts: ProductFeatureSyncCounts = {
    product_features: features.length,
    feature_task_map: maps.length,
    feature_task_map_by_join_source: countMapsByJoinSource(maps),
    unmapped_tasks: unmappedTaskIds.length,
    meditation_check: med,
    fc_covered: allFcIds.length - validation.missingFcIds.length,
    fc_total: allFcIds.length,
  }

  return {
    counts,
    features,
    maps,
    unmappedTaskIds,
    durationMs: Date.now() - t0,
    mode,
    seedPath,
  }
}

export async function applyProductFeatureSyncPlan(
  plan: ProductFeatureSyncPlan,
  executor: ProductFeatureSqlExecutor = defaultExecutor(),
): Promise<{ applied: ProductFeatureSyncCounts; durationMs: number }> {
  const t0 = Date.now()
  const nFeat = await upsertProductFeatures(plan.features, executor)
  const nMaps = await upsertFeatureTaskMaps(plan.maps, executor)
  return {
    applied: {
      ...plan.counts,
      product_features: nFeat,
      feature_task_map: nMaps,
    },
    durationMs: Date.now() - t0,
  }
}

/** Parse 010 SQL for schema tests (column/index presence). */
export function parseMigration010Sql(sql: string): {
  tables: Array<string>
  columnsByTable: Record<string, Array<string>>
  indexesByTable: Record<string, Array<string>>
} {
  const tables: Array<string> = []
  const columnsByTable: Record<string, Array<string>> = {}
  const indexesByTable: Record<string, Array<string>> = {}
  const tableRe =
    /CREATE TABLE IF NOT EXISTS\s+([a-z0-9_]+)\s*\(([\s\S]*?)\)\s*ENGINE=/gi
  let m: RegExpExecArray | null
  while ((m = tableRe.exec(sql)) !== null) {
    const name = m[1]!
    const body = m[2]!
    tables.push(name)
    const cols: Array<string> = []
    const idxs: Array<string> = []
    for (const line of body.split('\n')) {
      const t = line.trim().replace(/,$/, '')
      if (!t || t.startsWith('--')) continue
      const col = t.match(/^([a-z_][a-z0-9_]*)\s+/i)
      if (col && !/^(PRIMARY|KEY|UNIQUE|CONSTRAINT)$/i.test(col[1]!)) {
        cols.push(col[1]!.toLowerCase())
      }
      const idx = t.match(/^(?:PRIMARY KEY|UNIQUE KEY|KEY)\s+(?:([a-z0-9_]+)\s+)?\(([^)]+)\)/i)
      if (idx) {
        idxs.push((idx[1] ?? 'PRIMARY').toLowerCase())
        for (const part of idx[2]!.split(',')) {
          idxs.push(part.trim().replace(/[`'"]/g, '').toLowerCase())
        }
      }
    }
    columnsByTable[name] = cols
    indexesByTable[name] = idxs
  }
  return { tables, columnsByTable, indexesByTable }
}

export { sha256Hex }
