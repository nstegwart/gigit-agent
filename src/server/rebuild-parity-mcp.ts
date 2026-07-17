/**
 * MCP + service layer for rebuild parity reads (SPEC §3.F + addendum B).
 *
 * Tools:
 *   get_rebuild_parity  — latest rollup + short history + verdict breakdown + freshness
 *   get_feature_360     — FEAT-* 360 view (bars, tasks+verdicts, units by platform, docs)
 *   trace_blindspot     — term → STAGE1/STAGE2/L2 classification + related entities
 *
 * Graceful: if migration 009/010 tables are absent, tools return
 *   { available: false, reason: "REBUILD_DATA_TABLES_NOT_MIGRATED" }
 * and never throw ER_NO_SUCH_TABLE.
 *
 * Pattern mirrors domain-knowledge-mcp: pure handlers + injected secureTool/jsonText.
 */

import { z } from 'zod'
import type { RowDataPacket } from 'mysql2/promise'

import { db } from '#/server/db'
import {
  countByVerdict,
  DEFAULT_BOARD_ID,
  DEFAULT_TOTAL_N,
  getParityRollupHistory,
  getParityRollupLatest,
  type FeatureDirectoryRow,
  type FeatureUnitRow,
  type LineageSqlExecutor,
  type ParityRollupRow,
  type RebuildLineageRecord,
  type VerdictCountByLabel,
} from '#/server/rebuild-lineage-store'
import {
  listFeatureTaskMaps,
  listProductFeatures,
  type FeatureTaskMapRow,
  type ProductFeatureRow,
  type ProductFeatureSqlExecutor,
} from '#/server/product-features-store'

// ---------------------------------------------------------------------------
// Tool names (must match MCP_TOOL_SPECS in rbac.ts)
// ---------------------------------------------------------------------------

export const REBUILD_PARITY_MCP_TOOL_NAMES = [
  'get_rebuild_parity',
  'get_feature_360',
  'trace_blindspot',
] as const

export type RebuildParityMcpToolName = (typeof REBUILD_PARITY_MCP_TOOL_NAMES)[number]

export const get_rebuild_parity = 'get_rebuild_parity' as const
export const get_feature_360 = 'get_feature_360' as const
export const trace_blindspot = 'trace_blindspot' as const

export const REBUILD_DATA_TABLES_NOT_MIGRATED = 'REBUILD_DATA_TABLES_NOT_MIGRATED' as const

/** Probe tables from migrations 009 + 010. */
export const REBUILD_DATA_PROBE_TABLES = [
  'rebuild_lineage_records',
  'parity_rollups',
  'feature_units',
  'feature_directory',
  'product_features',
  'feature_task_map',
] as const

export type BlindspotClassification =
  | 'STAGE1_ROW_BLINDSPOT'
  | 'STAGE1_VARIANT_BLINDSPOT'
  | 'STAGE2_NOT_IMPLEMENTED'
  | 'STAGE2_PARTIAL'
  | 'L2_FALSE_POSITIVE_OR_REGRESSION'

// ---------------------------------------------------------------------------
// Input schemas (zod objects for MCP secureTool)
// ---------------------------------------------------------------------------

export const rebuildParityBoardArg = {
  boardId: z
    .string()
    .optional()
    .describe('Board id (default mfs-rebuild); scopes lineage rows'),
}

export const getRebuildParityInputSchema = {
  ...rebuildParityBoardArg,
  historyLimit: z
    .number()
    .int()
    .optional()
    .describe('Max historical rollup rows (default 12, max 50)'),
}

export const getFeature360InputSchema = {
  ...rebuildParityBoardArg,
  feature_id: z
    .string()
    .describe('Product feature id (FEAT-*), e.g. FEAT-MEDITATION'),
}

export const traceBlindspotInputSchema = {
  ...rebuildParityBoardArg,
  term: z
    .string()
    .describe('Feature term / legacy path / unit id / task fragment to trace'),
  limit: z
    .number()
    .int()
    .optional()
    .describe('Max related entities to return (default 20, max 100)'),
}

// ---------------------------------------------------------------------------
// Response shapes
// ---------------------------------------------------------------------------

export type UnavailablePayload = {
  available: false
  reason: typeof REBUILD_DATA_TABLES_NOT_MIGRATED
  tool: RebuildParityMcpToolName
}

export type RebuildParityPayload = {
  available: true
  boardId: string
  latest: {
    capturedAt: string
    mapped100: number
    partialN: number
    missingN: number
    pendingN: number
    l0N: number
    measuredN: number
    totalN: number
    mappedPct: number | null
    sourceFile: string | null
    sourceHash: string | null
  } | null
  history: Array<{
    capturedAt: string
    mapped100: number
    partialN: number
    missingN: number
    pendingN: number
    measuredN: number
    totalN: number
  }>
  verdictBreakdown: Array<{ verdict: string; count: number }>
  freshness: {
    capturedAt: string | null
    ageSeconds: number | null
    labelId: string
  }
  disclaimerId: string
}

export type Feature360Bar = {
  key: 'pemetaan' | 'terbukti_pindah' | 'siap_produksi'
  labelId: string
  numerator: number
  denominator: number
  pct: number | null
  placeholder?: boolean
  flag?: string
}

export type Feature360Payload = {
  available: true
  feature_id: string
  nama_id: string
  domain_bisnis: string
  ringkasan_id: string | null
  bars: {
    pemetaan: Feature360Bar
    terbukti_pindah: Feature360Bar
    siap_produksi: Feature360Bar
  }
  tasks: Array<{
    task_id: string
    join_source: string
    confidence: number
    parity_verdict: string | null
    origin: string | null
    feature_contract_id: string | null
  }>
  units_by_platform: Record<string, Array<{
    unit_id: string
    unit_type: string | null
    identifier: string | null
    anchor: string | null
    coverage_status: string | null
    repo: string | null
    feature_contract_id: string | null
  }>>
  docs_refs: Array<{
    feature_contract_id: string
    judul_id: string | null
    delivery_status: string | null
    has_doc_md: boolean
  }>
  rollup: {
    taskCount: number
    lineageCount: number
    parityMapped100: number
    parityTotal: number
  }
}

export type TraceBlindspotMatch = {
  task_id: string
  classification: BlindspotClassification
  parity_verdict: string | null
  origin: string | null
  disposition: string | null
  feature_contract_id: string | null
  gaps: unknown
  evidence_sample: unknown
  stage1_origin: string | null
}

export type TraceBlindspotPayload = {
  available: true
  term: string
  boardId: string
  matchCount: number
  primary_classification: BlindspotClassification
  matches: Array<TraceBlindspotMatch>
  related_feature_ids: Array<string>
  note_id: string
}

export type RebuildParityToolResult =
  | UnavailablePayload
  | RebuildParityPayload
  | Feature360Payload
  | TraceBlindspotPayload
  | { available: false; reason: string; tool: RebuildParityMcpToolName; error?: string }

// ---------------------------------------------------------------------------
// Data access (injectable for unit tests / memory fixtures)
// ---------------------------------------------------------------------------

export interface RebuildParityDataAccess {
  /** true when 009/010 tables exist and are readable */
  tablesAvailable(): Promise<boolean>
  getLatestRollup(): Promise<ParityRollupRow | null>
  getRollupHistory(limit: number): Promise<Array<ParityRollupRow>>
  countVerdicts(boardId: string): Promise<Array<VerdictCountByLabel>>
  getProductFeature(featureId: string): Promise<ProductFeatureRow | null>
  listTaskMaps(featureId: string): Promise<Array<FeatureTaskMapRow>>
  listLineageForBoard(boardId: string): Promise<Array<RebuildLineageRecord>>
  listLineageByTaskIds(
    boardId: string,
    taskIds: ReadonlyArray<string>,
  ): Promise<Array<RebuildLineageRecord>>
  listUnitsByFcIds(fcIds: ReadonlyArray<string>): Promise<Array<FeatureUnitRow>>
  listDirectoryByFcIds(fcIds: ReadonlyArray<string>): Promise<Array<FeatureDirectoryRow>>
  /** Optional: map task_id → FEAT ids when feature_task_map present */
  listFeatureIdsForTasks(
    taskIds: ReadonlyArray<string>,
  ): Promise<Array<{ taskId: string; featureId: string }>>
}

function isNoSuchTable(err: unknown): boolean {
  const e = err as { errno?: number; code?: string; message?: string }
  if (e.errno === 1146 || e.code === 'ER_NO_SUCH_TABLE') return true
  const msg = String(e.message ?? '')
  return /doesn't exist|ER_NO_SUCH_TABLE|Unknown table/i.test(msg)
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

function mapLineageRow(r: RowDataPacket): RebuildLineageRecord {
  return {
    boardId: String(r.board_id),
    taskId: String(r.task_id),
    disposition: r.disposition != null ? String(r.disposition) : null,
    repository: r.repository != null ? String(r.repository) : null,
    origin: r.origin != null ? String(r.origin) : null,
    featureContractId: r.feature_contract_id != null ? String(r.feature_contract_id) : null,
    parityVerdict: r.parity_verdict != null ? String(r.parity_verdict) : null,
    acceptanceCovered: r.acceptance_covered != null ? String(r.acceptance_covered) : null,
    verifierModel: r.verifier_model != null ? String(r.verifier_model) : null,
    verifiedAt: r.verified_at != null ? String(r.verified_at) : null,
    stage1Json: parseJsonCell(r.stage1_json),
    evidenceJson: parseJsonCell(r.evidence_json),
    gapsJson: parseJsonCell(r.gaps_json),
    implementationJson: parseJsonCell(r.implementation_json),
    sourceHash: String(r.source_hash ?? ''),
    syncedAt: String(r.synced_at ?? ''),
  }
}

function mapUnitRow(r: RowDataPacket): FeatureUnitRow {
  return {
    unitId: String(r.unit_id),
    featureContractId: r.feature_contract_id != null ? String(r.feature_contract_id) : null,
    unitType: r.unit_type != null ? String(r.unit_type) : null,
    identifier: r.identifier != null ? String(r.identifier) : null,
    anchor: r.anchor != null ? String(r.anchor) : null,
    notes: r.notes != null ? String(r.notes) : null,
    coverageStatus: r.coverage_status != null ? String(r.coverage_status) : null,
    repo: r.repo != null ? String(r.repo) : null,
    sourceHash: r.source_hash != null ? String(r.source_hash) : null,
    syncedAt: r.synced_at != null ? String(r.synced_at) : null,
  }
}

function mapDirectoryRow(r: RowDataPacket): FeatureDirectoryRow {
  return {
    featureContractId: String(r.feature_contract_id),
    judulId: r.judul_id != null ? String(r.judul_id) : null,
    domainBisnis: r.domain_bisnis != null ? String(r.domain_bisnis) : null,
    ringkasanId: r.ringkasan_id != null ? String(r.ringkasan_id) : null,
    docMd: r.doc_md != null ? String(r.doc_md) : null,
    deliveryStatus: r.delivery_status != null ? String(r.delivery_status) : null,
    linksJson: parseJsonCell(r.links_json),
    sourceHash: String(r.source_hash ?? ''),
    syncedAt: r.synced_at != null ? String(r.synced_at) : null,
  }
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

function defaultLineageExecutor(): LineageSqlExecutor {
  return {
    async query(sql, params) {
      return db().query(sql, params) as Promise<[unknown, unknown?]>
    },
  }
}

function defaultProductExecutor(): ProductFeatureSqlExecutor {
  return {
    async query(sql, params) {
      return db().query(sql, params) as Promise<[unknown, unknown?]>
    },
  }
}

/**
 * Live MySQL data access. Probes 009/010 tables; list helpers catch missing table.
 */
export function createLiveRebuildParityDataAccess(opts: {
  lineageExecutor?: LineageSqlExecutor
  productExecutor?: ProductFeatureSqlExecutor
  sqlQuery?: (sql: string, params?: Array<unknown>) => Promise<[unknown, unknown?]>
} = {}): RebuildParityDataAccess {
  const lineageEx = opts.lineageExecutor ?? defaultLineageExecutor()
  const productEx = opts.productExecutor ?? defaultProductExecutor()
  const sqlQuery =
    opts.sqlQuery ??
    (async (sql: string, params: Array<unknown> = []) =>
      db().query(sql, params) as Promise<[unknown, unknown?]>)

  return {
    async tablesAvailable() {
      for (const table of REBUILD_DATA_PROBE_TABLES) {
        if (!/^[a-z0-9_]+$/i.test(table)) return false
        try {
          await sqlQuery(`SELECT 1 AS ok FROM \`${table}\` LIMIT 0`)
        } catch (e) {
          if (isNoSuchTable(e)) return false
          // Connectivity / other errors: treat as unavailable (honest, non-crash)
          return false
        }
      }
      return true
    },

    async getLatestRollup() {
      return getParityRollupLatest(lineageEx)
    },

    async getRollupHistory(limit: number) {
      return getParityRollupHistory({ limit }, lineageEx)
    },

    async countVerdicts(boardId: string) {
      return countByVerdict(boardId, lineageEx)
    },

    async getProductFeature(featureId: string) {
      const all = await listProductFeatures({}, productEx)
      return all.find((f) => f.featureId === featureId) ?? null
    },

    async listTaskMaps(featureId: string) {
      return listFeatureTaskMaps({ featureId }, productEx)
    },

    async listLineageForBoard(boardId: string) {
      const [rows] = await sqlQuery(
        `SELECT * FROM rebuild_lineage_records WHERE board_id = ?`,
        [boardId],
      )
      return ((rows as RowDataPacket[]) ?? []).map(mapLineageRow)
    },

    async listLineageByTaskIds(boardId: string, taskIds: ReadonlyArray<string>) {
      if (taskIds.length === 0) return []
      // Chunk to stay under max placeholder limits
      const out: Array<RebuildLineageRecord> = []
      const chunkSize = 200
      for (let i = 0; i < taskIds.length; i += chunkSize) {
        const chunk = taskIds.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        const [rows] = await sqlQuery(
          `SELECT * FROM rebuild_lineage_records WHERE board_id = ? AND task_id IN (${placeholders})`,
          [boardId, ...chunk],
        )
        out.push(...((rows as RowDataPacket[]) ?? []).map(mapLineageRow))
      }
      return out
    },

    async listUnitsByFcIds(fcIds: ReadonlyArray<string>) {
      if (fcIds.length === 0) return []
      const placeholders = fcIds.map(() => '?').join(',')
      const [rows] = await sqlQuery(
        `SELECT * FROM feature_units WHERE feature_contract_id IN (${placeholders}) ORDER BY unit_type ASC, identifier ASC`,
        [...fcIds],
      )
      return ((rows as RowDataPacket[]) ?? []).map(mapUnitRow)
    },

    async listDirectoryByFcIds(fcIds: ReadonlyArray<string>) {
      if (fcIds.length === 0) return []
      const placeholders = fcIds.map(() => '?').join(',')
      const [rows] = await sqlQuery(
        `SELECT * FROM feature_directory WHERE feature_contract_id IN (${placeholders}) ORDER BY judul_id ASC`,
        [...fcIds],
      )
      return ((rows as RowDataPacket[]) ?? []).map(mapDirectoryRow)
    },

    async listFeatureIdsForTasks(taskIds: ReadonlyArray<string>) {
      if (taskIds.length === 0) return []
      const out: Array<{ taskId: string; featureId: string }> = []
      const chunkSize = 200
      for (let i = 0; i < taskIds.length; i += chunkSize) {
        const chunk = taskIds.slice(i, i + chunkSize)
        const placeholders = chunk.map(() => '?').join(',')
        const [rows] = await sqlQuery(
          `SELECT feature_id, task_id FROM feature_task_map WHERE task_id IN (${placeholders})`,
          [...chunk],
        )
        for (const r of (rows as RowDataPacket[]) ?? []) {
          out.push({
            taskId: String(r.task_id),
            featureId: String(r.feature_id),
          })
        }
      }
      return out
    },
  }
}

// ---------------------------------------------------------------------------
// Memory fixture (unit tests — no MySQL)
// ---------------------------------------------------------------------------

export function createMemoryRebuildParityDataAccess(seed: {
  tablesPresent?: boolean
  rollups?: Array<ParityRollupRow>
  lineage?: Array<RebuildLineageRecord>
  features?: Array<ProductFeatureRow>
  maps?: Array<FeatureTaskMapRow>
  units?: Array<FeatureUnitRow>
  directory?: Array<FeatureDirectoryRow>
} = {}): RebuildParityDataAccess & {
  tablesPresent: boolean
  rollups: Array<ParityRollupRow>
  lineage: Array<RebuildLineageRecord>
  features: Array<ProductFeatureRow>
  maps: Array<FeatureTaskMapRow>
  units: Array<FeatureUnitRow>
  directory: Array<FeatureDirectoryRow>
} {
  const state = {
    tablesPresent: seed.tablesPresent ?? true,
    rollups: [...(seed.rollups ?? [])],
    lineage: [...(seed.lineage ?? [])],
    features: [...(seed.features ?? [])],
    maps: [...(seed.maps ?? [])],
    units: [...(seed.units ?? [])],
    directory: [...(seed.directory ?? [])],
  }

  return {
    ...state,
    async tablesAvailable() {
      return state.tablesPresent
    },
    async getLatestRollup() {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'parity_rollups' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const sorted = [...state.rollups].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
      )
      return sorted[0] ?? null
    },
    async getRollupHistory(limit: number) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'parity_rollups' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const sorted = [...state.rollups].sort((a, b) =>
        a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
      )
      return sorted.slice(0, limit)
    },
    async countVerdicts(boardId: string) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'rebuild_lineage_records' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const counts = new Map<string, number>()
      for (const r of state.lineage) {
        if (r.boardId !== boardId) continue
        const v = r.parityVerdict ?? 'NULL'
        counts.set(v, (counts.get(v) ?? 0) + 1)
      }
      return [...counts.entries()]
        .map(([verdict, count]) => ({ verdict, count }))
        .sort((a, b) => b.count - a.count)
    },
    async getProductFeature(featureId: string) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'product_features' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      return state.features.find((f) => f.featureId === featureId) ?? null
    },
    async listTaskMaps(featureId: string) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'feature_task_map' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      return state.maps.filter((m) => m.featureId === featureId)
    },
    async listLineageForBoard(boardId: string) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'rebuild_lineage_records' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      return state.lineage.filter((r) => r.boardId === boardId)
    },
    async listLineageByTaskIds(boardId: string, taskIds: ReadonlyArray<string>) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'rebuild_lineage_records' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const set = new Set(taskIds)
      return state.lineage.filter((r) => r.boardId === boardId && set.has(r.taskId))
    },
    async listUnitsByFcIds(fcIds: ReadonlyArray<string>) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'feature_units' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const set = new Set(fcIds)
      return state.units.filter((u) => u.featureContractId != null && set.has(u.featureContractId))
    },
    async listDirectoryByFcIds(fcIds: ReadonlyArray<string>) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'feature_directory' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const set = new Set(fcIds)
      return state.directory.filter((d) => set.has(d.featureContractId))
    },
    async listFeatureIdsForTasks(taskIds: ReadonlyArray<string>) {
      if (!state.tablesPresent) throw Object.assign(new Error("Table 'feature_task_map' doesn't exist"), { code: 'ER_NO_SUCH_TABLE', errno: 1146 })
      const set = new Set(taskIds)
      return state.maps
        .filter((m) => set.has(m.taskId))
        .map((m) => ({ taskId: m.taskId, featureId: m.featureId }))
    },
  }
}

// ---------------------------------------------------------------------------
// Pure classification (port of .artifact/2026-07-16-lineage/trace-blindspot.py)
// Spec allowed labels only (§3.D).
// ---------------------------------------------------------------------------

export function classifyBlindspotFromRecord(
  rec: RebuildLineageRecord,
): BlindspotClassification {
  const v = (rec.parityVerdict ?? '').toUpperCase()
  const origin = (rec.origin ?? '').toLowerCase()
  const stage1 = (rec.stage1Json ?? {}) as Record<string, unknown>
  const stage1Origin = String(stage1.origin ?? origin ?? '').toLowerCase()

  if (v === 'MAPPED_100') {
    return 'L2_FALSE_POSITIVE_OR_REGRESSION'
  }
  if (v === 'PARTIAL') {
    return 'STAGE2_PARTIAL'
  }
  if (v === 'MISSING') {
    return 'STAGE2_NOT_IMPLEMENTED'
  }
  // Pending / L0 / unmeasured: firm-new inventory catch-up → stage1 variant blindspot
  if (
    origin.includes('firm-new') ||
    stage1Origin.includes('firm-new') ||
    origin === 'firm-new-blindspot'
  ) {
    if (
      v === 'PENDING_MEASURE' ||
      v === 'L0_ANCHORS_PRESENT' ||
      v === '' ||
      v === 'NULL' ||
      v === 'UNKNOWN'
    ) {
      return 'STAGE1_VARIANT_BLINDSPOT'
    }
  }
  // Existing mapped row not yet implemented / measured
  if (
    v === 'PENDING_MEASURE' ||
    v === 'L0_ANCHORS_PRESENT' ||
    v === '' ||
    v === 'NULL' ||
    v === 'UNKNOWN'
  ) {
    return 'STAGE2_NOT_IMPLEMENTED'
  }
  return 'STAGE2_NOT_IMPLEMENTED'
}

export function recordMatchesTerm(rec: RebuildLineageRecord, termLower: string): boolean {
  if (!termLower) return false
  const hay = JSON.stringify({
    taskId: rec.taskId,
    disposition: rec.disposition,
    repository: rec.repository,
    origin: rec.origin,
    featureContractId: rec.featureContractId,
    parityVerdict: rec.parityVerdict,
    stage1Json: rec.stage1Json,
    evidenceJson: rec.evidenceJson,
    gapsJson: rec.gapsJson,
    implementationJson: rec.implementationJson,
  }).toLowerCase()
  return hay.includes(termLower)
}

function pct(n: number, d: number): number | null {
  if (d <= 0) return null
  return Math.round((n / d) * 1000) / 10
}

function freshnessLabelId(ageSeconds: number | null): string {
  if (ageSeconds == null) return 'belum ada pengukuran'
  if (ageSeconds < 60) return `diukur ulang ${ageSeconds} detik lalu`
  const mins = Math.floor(ageSeconds / 60)
  if (mins < 60) return `diukur ulang ${mins} menit lalu`
  const hours = Math.floor(mins / 60)
  if (hours < 48) return `diukur ulang ${hours} jam lalu`
  const days = Math.floor(hours / 24)
  return `diukur ulang ${days} hari lalu`
}

function platformKey(unit: FeatureUnitRow): string {
  const repo = (unit.repo ?? '').toLowerCase()
  const t = (unit.unitType ?? '').toLowerCase()
  if (repo.includes('rn') || t.includes('screen') || t.includes('rn')) return 'rn'
  if (repo.includes('web') || t.includes('route') || t.includes('page')) return 'web'
  if (repo.includes('admin')) return 'admin'
  if (t.includes('job') || t.includes('cron')) return 'jobs'
  if (repo.includes('backend') || repo.includes('api') || t.includes('api') || t.includes('service'))
    return 'backend'
  if (repo) return repo.slice(0, 32)
  if (t) return t
  return 'other'
}

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

let activeDataAccess: RebuildParityDataAccess | null = null

/** Inject data access (tests). Pass null to restore live default. */
export function setRebuildParityDataAccessForTests(
  access: RebuildParityDataAccess | null,
): void {
  activeDataAccess = access
}

export function getRebuildParityDataAccess(): RebuildParityDataAccess {
  return activeDataAccess ?? createLiveRebuildParityDataAccess()
}

function unavailable(tool: RebuildParityMcpToolName): UnavailablePayload {
  return {
    available: false,
    reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
    tool,
  }
}

async function withAvailability<T>(
  tool: RebuildParityMcpToolName,
  fn: (access: RebuildParityDataAccess) => Promise<T>,
): Promise<T | UnavailablePayload> {
  const access = getRebuildParityDataAccess()
  try {
    const ok = await access.tablesAvailable()
    if (!ok) return unavailable(tool)
    return await fn(access)
  } catch (e) {
    if (isNoSuchTable(e)) return unavailable(tool)
    // Honest non-crash for unexpected store errors
    return {
      available: false,
      reason: REBUILD_DATA_TABLES_NOT_MIGRATED,
      tool,
      error: e instanceof Error ? e.message.slice(0, 200) : 'unknown',
    } as UnavailablePayload
  }
}

export async function handleGetRebuildParity(
  args: { boardId?: string; historyLimit?: number } = {},
): Promise<RebuildParityPayload | UnavailablePayload> {
  const boardId = (args.boardId ?? DEFAULT_BOARD_ID).trim() || DEFAULT_BOARD_ID
  const historyLimit = Math.min(Math.max(args.historyLimit ?? 12, 1), 50)

  return withAvailability(get_rebuild_parity, async (access) => {
    const latest = await access.getLatestRollup()
    const historyRows = await access.getRollupHistory(historyLimit)
    const verdictBreakdown = await access.countVerdicts(boardId)

    const capturedAt = latest?.capturedAt ?? null
    let ageSeconds: number | null = null
    if (capturedAt) {
      const t = new Date(capturedAt.includes('T') ? capturedAt : capturedAt.replace(' ', 'T') + 'Z')
      if (!Number.isNaN(t.getTime())) {
        ageSeconds = Math.max(0, Math.floor((Date.now() - t.getTime()) / 1000))
      }
    }

    const mapped100 = latest?.mapped100 ?? 0
    const totalN = latest?.totalN ?? DEFAULT_TOTAL_N

    const payload: RebuildParityPayload = {
      available: true,
      boardId,
      latest: latest
        ? {
            capturedAt: latest.capturedAt,
            mapped100: latest.mapped100,
            partialN: latest.partialN,
            missingN: latest.missingN,
            pendingN: latest.pendingN,
            l0N: latest.l0N,
            measuredN: latest.measuredN,
            totalN: latest.totalN,
            mappedPct: pct(mapped100, totalN),
            sourceFile: latest.sourceFile,
            sourceHash: latest.sourceHash,
          }
        : null,
      history: historyRows.map((r) => ({
        capturedAt: r.capturedAt,
        mapped100: r.mapped100,
        partialN: r.partialN,
        missingN: r.missingN,
        pendingN: r.pendingN,
        measuredN: r.measuredN,
        totalN: r.totalN,
      })),
      verdictBreakdown,
      freshness: {
        capturedAt,
        ageSeconds,
        labelId: freshnessLabelId(ageSeconds),
      },
      disclaimerId:
        'terbukti secara bukti kode (MAPPED_100), bukan berarti production-ready',
    }
    return payload
  })
}

export async function handleGetFeature360(
  args: { boardId?: string; feature_id?: string; featureId?: string } = {},
): Promise<Feature360Payload | UnavailablePayload | { available: false; reason: string; tool: typeof get_feature_360; error: string }> {
  const featureId = String(args.feature_id ?? args.featureId ?? '').trim()
  if (!featureId) {
    return {
      available: false,
      reason: 'INVALID_INPUT',
      tool: get_feature_360,
      error: 'feature_id is required',
    }
  }
  const boardId = (args.boardId ?? DEFAULT_BOARD_ID).trim() || DEFAULT_BOARD_ID

  return withAvailability(get_feature_360, async (access) => {
    const feature = await access.getProductFeature(featureId)
    if (!feature) {
      return {
        available: false,
        reason: 'FEATURE_NOT_FOUND',
        tool: get_feature_360,
        error: `No product feature ${featureId}`,
      }
    }

    const maps = await access.listTaskMaps(featureId)
    const taskIds = [...new Set(maps.map((m) => m.taskId))].sort()
    const lineage = await access.listLineageByTaskIds(boardId, taskIds)
    const byTask = new Map(lineage.map((r) => [r.taskId, r]))

    const fcRefs = asStringArray(feature.fcRefsJson)
    const units = await access.listUnitsByFcIds(fcRefs)
    const directory = await access.listDirectoryByFcIds(fcRefs)

    const parityMapped100 = lineage.filter((r) => r.parityVerdict === 'MAPPED_100').length
    const parityTotal = lineage.length
    const mappedTaskCount = taskIds.length

    // pemetaan: tasks joined to this feature / tasks with lineage for feature
    // When only maps exist, denominator = mapped set (100% mapped into taxonomy).
    const pemetaanDen = Math.max(mappedTaskCount, parityTotal, 1)
    const pemetaanNum = mappedTaskCount
    // terbukti_pindah: MAPPED_100 / lineage tasks for feature
    const terbuktiDen = Math.max(parityTotal, mappedTaskCount, 1)
    const terbuktiNum = parityMapped100

    const unitsByPlatform: Feature360Payload['units_by_platform'] = {}
    for (const u of units) {
      const key = platformKey(u)
      if (!unitsByPlatform[key]) unitsByPlatform[key] = []
      unitsByPlatform[key]!.push({
        unit_id: u.unitId,
        unit_type: u.unitType,
        identifier: u.identifier,
        anchor: u.anchor,
        coverage_status: u.coverageStatus,
        repo: u.repo,
        feature_contract_id: u.featureContractId,
      })
    }

    const payload: Feature360Payload = {
      available: true,
      feature_id: feature.featureId,
      nama_id: feature.namaId,
      domain_bisnis: feature.domainBisnis,
      ringkasan_id: feature.ringkasanId,
      bars: {
        pemetaan: {
          key: 'pemetaan',
          labelId: 'Pemetaan ke fitur',
          numerator: pemetaanNum,
          denominator: pemetaanDen,
          pct: pct(pemetaanNum, pemetaanDen),
        },
        terbukti_pindah: {
          key: 'terbukti_pindah',
          labelId: 'Terbukti pindah (MAPPED_100)',
          numerator: terbuktiNum,
          denominator: terbuktiDen,
          pct: pct(terbuktiNum, terbuktiDen),
        },
        siap_produksi: {
          key: 'siap_produksi',
          labelId: 'Siap produksi',
          numerator: 0,
          denominator: Math.max(mappedTaskCount, 1),
          pct: 0,
          placeholder: true,
          flag: 'PLACEHOLDER_SIAP_PRODUKSI_ZERO',
        },
      },
      tasks: maps.map((m) => {
        const lin = byTask.get(m.taskId)
        return {
          task_id: m.taskId,
          join_source: m.joinSource,
          confidence: m.confidence,
          parity_verdict: lin?.parityVerdict ?? null,
          origin: lin?.origin ?? null,
          feature_contract_id: lin?.featureContractId ?? null,
        }
      }),
      units_by_platform: unitsByPlatform,
      docs_refs: directory.map((d) => ({
        feature_contract_id: d.featureContractId,
        judul_id: d.judulId,
        delivery_status: d.deliveryStatus,
        has_doc_md: Boolean(d.docMd && String(d.docMd).trim()),
      })),
      rollup: {
        taskCount: mappedTaskCount,
        lineageCount: parityTotal,
        parityMapped100,
        parityTotal,
      },
    }
    return payload
  }) as Promise<
    | Feature360Payload
    | UnavailablePayload
    | { available: false; reason: string; tool: typeof get_feature_360; error: string }
  >
}

export async function handleTraceBlindspot(
  args: { boardId?: string; term?: string; limit?: number } = {},
): Promise<TraceBlindspotPayload | UnavailablePayload | { available: false; reason: string; tool: typeof trace_blindspot; error: string }> {
  const term = String(args.term ?? '').trim()
  if (!term) {
    return {
      available: false,
      reason: 'INVALID_INPUT',
      tool: trace_blindspot,
      error: 'term is required',
    }
  }
  const boardId = (args.boardId ?? DEFAULT_BOARD_ID).trim() || DEFAULT_BOARD_ID
  const limit = Math.min(Math.max(args.limit ?? 20, 1), 100)
  const termLower = term.toLowerCase()

  return withAvailability(trace_blindspot, async (access) => {
    const all = await access.listLineageForBoard(boardId)
    const matches = all.filter((r) => recordMatchesTerm(r, termLower))

    if (matches.length === 0) {
      const payload: TraceBlindspotPayload = {
        available: true,
        term,
        boardId,
        matchCount: 0,
        primary_classification: 'STAGE1_ROW_BLINDSPOT',
        matches: [],
        related_feature_ids: [],
        note_id:
          'fitur/term ini TIDAK ADA di denominator lineage (inventory Stage-1 kelewat)',
      }
      return payload
    }

    const classified: Array<TraceBlindspotMatch> = matches.slice(0, limit).map((r) => {
      const stage1 = (r.stage1Json ?? {}) as Record<string, unknown>
      const evidence = r.evidenceJson
      const evidenceSample = Array.isArray(evidence) ? evidence.slice(0, 2) : evidence
      const gaps = r.gapsJson
      return {
        task_id: r.taskId,
        classification: classifyBlindspotFromRecord(r),
        parity_verdict: r.parityVerdict,
        origin: r.origin,
        disposition: r.disposition,
        feature_contract_id: r.featureContractId,
        gaps: Array.isArray(gaps) ? gaps.slice(0, 3) : gaps,
        evidence_sample: evidenceSample,
        stage1_origin: stage1.origin != null ? String(stage1.origin) : null,
      }
    })

    // Primary = first match classification (stable order by task_id)
    classified.sort((a, b) => a.task_id.localeCompare(b.task_id))
    const primary = classified[0]!.classification

    const related = await access.listFeatureIdsForTasks(matches.map((m) => m.taskId))
    const related_feature_ids = [...new Set(related.map((r) => r.featureId))].sort()

    const payload: TraceBlindspotPayload = {
      available: true,
      term,
      boardId,
      matchCount: matches.length,
      primary_classification: primary,
      matches: classified,
      related_feature_ids,
      note_id: 'klasifikasi dari parity_verdict + origin (port trace-blindspot.py → store)',
    }
    return payload
  }) as Promise<
    | TraceBlindspotPayload
    | UnavailablePayload
    | { available: false; reason: string; tool: typeof trace_blindspot; error: string }
  >
}

// ---------------------------------------------------------------------------
// MCP registration
// ---------------------------------------------------------------------------

export type RebuildParityRegisterDeps = {
  secureTool: (
    name: string,
    meta: {
      title: string
      description: string
      inputSchema: Record<string, unknown> | object
    },
    handler: (args: Record<string, unknown>) => Promise<unknown> | unknown,
  ) => void
  jsonText: (value: unknown) => unknown
}

/**
 * Register rebuild parity MCP read tools via injected secureTool.
 * Call from board-mcp `registerBoardTools` next to registerDomainKnowledgeTools.
 */
export function registerRebuildParityTools(deps: RebuildParityRegisterDeps): void {
  const { secureTool, jsonText } = deps

  secureTool(
    get_rebuild_parity,
    {
      title: 'Get rebuild parity rollup',
      description:
        'Latest rebuild parity rollup (MAPPED_100/PARTIAL/MISSING/PENDING) + short history + ' +
        'per-verdict breakdown + freshness. Graceful when 009/010 tables are not migrated.',
      inputSchema: getRebuildParityInputSchema,
    },
    async (args) =>
      jsonText(
        await handleGetRebuildParity({
          boardId: args.boardId as string | undefined,
          historyLimit: args.historyLimit as number | undefined,
        }),
      ),
  )

  secureTool(
    get_feature_360,
    {
      title: 'Get product feature 360',
      description:
        'FEAT-* 360 view: nama_id, domain, progress bars (pemetaan / terbukti_pindah / ' +
        'siap_produksi placeholder), tasks+verdicts, units by platform, docs refs. ' +
        'Graceful when rebuild data tables are not migrated.',
      inputSchema: getFeature360InputSchema,
    },
    async (args) =>
      jsonText(
        await handleGetFeature360({
          boardId: args.boardId as string | undefined,
          feature_id: args.feature_id as string | undefined,
          featureId: args.featureId as string | undefined,
        }),
      ),
  )

  secureTool(
    trace_blindspot,
    {
      title: 'Trace rebuild blindspot',
      description:
        'Trace a term/anchor/unit to root-cause classification: STAGE1_ROW_BLINDSPOT, ' +
        'STAGE1_VARIANT_BLINDSPOT, STAGE2_NOT_IMPLEMENTED, STAGE2_PARTIAL, ' +
        'L2_FALSE_POSITIVE_OR_REGRESSION + related tasks/features. Store-backed port of trace-blindspot.py.',
      inputSchema: traceBlindspotInputSchema,
    },
    async (args) =>
      jsonText(
        await handleTraceBlindspot({
          boardId: args.boardId as string | undefined,
          term: args.term as string | undefined,
          limit: args.limit as number | undefined,
        }),
      ),
  )
}

export function listRebuildParityToolNames(): readonly RebuildParityMcpToolName[] {
  return REBUILD_PARITY_MCP_TOOL_NAMES
}
