/**
 * Rebuild lineage store — additive layer for 2501 parity/lineage + feature directory.
 * SPEC: TM-KOMPAT-VISUAL V1 §2. Does not touch pin/lifecycle/classification tables.
 * Plan/dry-run helpers are pure (no DB). Apply path uses pool from db.ts and is
 * host-gated (LOCAL|STAGING only) by the sync CLI.
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { db } from './db'
import type { ResultSetHeader, RowDataPacket } from 'mysql2/promise'

// ---------------------------------------------------------------------------
// Types (mirror migration 009 columns)
// ---------------------------------------------------------------------------

export type LineageOrigin = 'existing' | 'firm-new-blindspot' | string

export interface RebuildLineageRecord {
  boardId: string
  taskId: string
  disposition: string | null
  repository: string | null
  origin: LineageOrigin | null
  featureContractId: string | null
  parityVerdict: string | null
  acceptanceCovered: string | null
  verifierModel: string | null
  verifiedAt: string | null
  stage1Json: unknown
  evidenceJson: unknown
  gapsJson: unknown
  implementationJson: unknown
  sourceHash: string
  syncedAt: string
}

export interface ParityRollupRow {
  id?: number
  capturedAt: string
  mapped100: number
  partialN: number
  missingN: number
  pendingN: number
  l0N: number
  measuredN: number
  totalN: number
  sourceFile: string | null
  rawText: string | null
  sourceHash: string | null
}

export interface FeatureUnitRow {
  unitId: string
  featureContractId: string | null
  unitType: string | null
  identifier: string | null
  anchor: string | null
  notes: string | null
  coverageStatus: string | null
  repo: string | null
  sourceHash: string | null
  syncedAt: string | null
}

export interface FeatureDirectoryRow {
  featureContractId: string
  judulId: string | null
  domainBisnis: string | null
  ringkasanId: string | null
  docMd: string | null
  deliveryStatus: string | null
  linksJson: unknown
  sourceHash: string
  syncedAt: string | null
}

export interface VerdictCountByLabel {
  verdict: string
  count: number
}

/** Injectable query surface (mysql2 pool or memory fake). */
export interface LineageSqlExecutor {
  query(sql: string, params?: Array<unknown>): Promise<[unknown, unknown?]>
}

export const UNCLASSIFIED_FLAG = 'belum terklasifikasi'
export const DEFAULT_BOARD_ID = 'mfs-rebuild'
export const DEFAULT_TOTAL_N = 2501

export function sha256Hex(content: string | Buffer): string {
  return createHash('sha256').update(content).digest('hex')
}

function stableJson(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function nowIso(): string {
  return new Date().toISOString()
}

function toMysqlDatetime(iso: string | null | undefined): string | null {
  if (!iso) return null
  // Accept ISO or already-mysql; store DATETIME(3) as 'YYYY-MM-DD HH:mm:ss.sss'
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return null
  return d.toISOString().replace('T', ' ').replace('Z', '')
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

function defaultExecutor(): LineageSqlExecutor {
  return {
    async query(sql, params) {
      return db().query(sql, params) as Promise<[unknown, unknown?]>
    },
  }
}

// ---------------------------------------------------------------------------
// Row mappers
// ---------------------------------------------------------------------------

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

function mapRollupRow(r: RowDataPacket): ParityRollupRow {
  return {
    id: r.id != null ? Number(r.id) : undefined,
    capturedAt: String(r.captured_at ?? ''),
    mapped100: Number(r.mapped_100 ?? 0),
    partialN: Number(r.partial_n ?? 0),
    missingN: Number(r.missing_n ?? 0),
    pendingN: Number(r.pending_n ?? 0),
    l0N: Number(r.l0_n ?? 0),
    measuredN: Number(r.measured_n ?? 0),
    totalN: Number(r.total_n ?? DEFAULT_TOTAL_N),
    sourceFile: r.source_file != null ? String(r.source_file) : null,
    rawText: r.raw_text != null ? String(r.raw_text) : null,
    sourceHash: r.source_hash != null ? String(r.source_hash) : null,
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

// ---------------------------------------------------------------------------
// Upsert batch
// ---------------------------------------------------------------------------

const LINEAGE_UPSERT_SQL = `
INSERT INTO rebuild_lineage_records (
  board_id, task_id, disposition, repository, origin, feature_contract_id,
  parity_verdict, acceptance_covered, verifier_model, verified_at,
  stage1_json, evidence_json, gaps_json, implementation_json,
  source_hash, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), CAST(? AS JSON), ?, ?)
ON DUPLICATE KEY UPDATE
  disposition = IF(source_hash = VALUES(source_hash), disposition, VALUES(disposition)),
  repository = IF(source_hash = VALUES(source_hash), repository, VALUES(repository)),
  origin = IF(source_hash = VALUES(source_hash), origin, VALUES(origin)),
  feature_contract_id = IF(source_hash = VALUES(source_hash), feature_contract_id, VALUES(feature_contract_id)),
  parity_verdict = IF(source_hash = VALUES(source_hash), parity_verdict, VALUES(parity_verdict)),
  acceptance_covered = IF(source_hash = VALUES(source_hash), acceptance_covered, VALUES(acceptance_covered)),
  verifier_model = IF(source_hash = VALUES(source_hash), verifier_model, VALUES(verifier_model)),
  verified_at = IF(source_hash = VALUES(source_hash), verified_at, VALUES(verified_at)),
  stage1_json = IF(source_hash = VALUES(source_hash), stage1_json, VALUES(stage1_json)),
  evidence_json = IF(source_hash = VALUES(source_hash), evidence_json, VALUES(evidence_json)),
  gaps_json = IF(source_hash = VALUES(source_hash), gaps_json, VALUES(gaps_json)),
  implementation_json = IF(source_hash = VALUES(source_hash), implementation_json, VALUES(implementation_json)),
  source_hash = IF(source_hash = VALUES(source_hash), source_hash, VALUES(source_hash)),
  synced_at = IF(source_hash = VALUES(source_hash), synced_at, VALUES(synced_at))
`

export async function upsertLineageRecords(
  rows: ReadonlyArray<RebuildLineageRecord>,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<number> {
  let n = 0
  for (const r of rows) {
    await executor.query(LINEAGE_UPSERT_SQL, [
      r.boardId,
      r.taskId,
      r.disposition,
      r.repository,
      r.origin,
      r.featureContractId,
      r.parityVerdict,
      r.acceptanceCovered,
      r.verifierModel,
      toMysqlDatetime(r.verifiedAt),
      stableJson(r.stage1Json),
      stableJson(r.evidenceJson),
      stableJson(r.gapsJson),
      stableJson(r.implementationJson),
      r.sourceHash,
      toMysqlDatetime(r.syncedAt) ?? toMysqlDatetime(nowIso()),
    ])
    n++
  }
  return n
}

const ROLLUP_INSERT_SQL = `
INSERT INTO parity_rollups (
  captured_at, mapped_100, partial_n, missing_n, pending_n, l0_n,
  measured_n, total_n, source_file, raw_text, source_hash
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
`

export async function upsertParityRollups(
  rows: ReadonlyArray<ParityRollupRow>,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<number> {
  // Historical: always insert new snapshot rows; skip when identical source_hash already present.
  let n = 0
  for (const r of rows) {
    if (r.sourceHash) {
      const [existing] = await executor.query(
        `SELECT id FROM parity_rollups WHERE source_hash = ? LIMIT 1`,
        [r.sourceHash],
      )
      if (Array.isArray(existing) && existing.length > 0) continue
    }
    await executor.query(ROLLUP_INSERT_SQL, [
      toMysqlDatetime(r.capturedAt) ?? toMysqlDatetime(nowIso()),
      r.mapped100,
      r.partialN,
      r.missingN,
      r.pendingN,
      r.l0N,
      r.measuredN,
      r.totalN,
      r.sourceFile,
      r.rawText,
      r.sourceHash,
    ])
    n++
  }
  return n
}

const UNIT_UPSERT_SQL = `
INSERT INTO feature_units (
  unit_id, feature_contract_id, unit_type, identifier, anchor, notes,
  coverage_status, repo, source_hash, synced_at
) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
ON DUPLICATE KEY UPDATE
  feature_contract_id = IF(source_hash = VALUES(source_hash), feature_contract_id, VALUES(feature_contract_id)),
  unit_type = IF(source_hash = VALUES(source_hash), unit_type, VALUES(unit_type)),
  identifier = IF(source_hash = VALUES(source_hash), identifier, VALUES(identifier)),
  anchor = IF(source_hash = VALUES(source_hash), anchor, VALUES(anchor)),
  notes = IF(source_hash = VALUES(source_hash), notes, VALUES(notes)),
  coverage_status = IF(source_hash = VALUES(source_hash), coverage_status, VALUES(coverage_status)),
  repo = IF(source_hash = VALUES(source_hash), repo, VALUES(repo)),
  source_hash = IF(source_hash = VALUES(source_hash), source_hash, VALUES(source_hash)),
  synced_at = IF(source_hash = VALUES(source_hash), synced_at, VALUES(synced_at))
`

export async function upsertFeatureUnits(
  rows: ReadonlyArray<FeatureUnitRow>,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<number> {
  let n = 0
  for (const r of rows) {
    await executor.query(UNIT_UPSERT_SQL, [
      r.unitId,
      r.featureContractId,
      r.unitType,
      r.identifier,
      r.anchor,
      r.notes,
      r.coverageStatus,
      r.repo,
      r.sourceHash,
      toMysqlDatetime(r.syncedAt) ?? toMysqlDatetime(nowIso()),
    ])
    n++
  }
  return n
}

const DIRECTORY_UPSERT_SQL = `
INSERT INTO feature_directory (
  feature_contract_id, judul_id, domain_bisnis, ringkasan_id, doc_md,
  delivery_status, links_json, source_hash, synced_at
) VALUES (?, ?, ?, ?, ?, ?, CAST(? AS JSON), ?, ?)
ON DUPLICATE KEY UPDATE
  judul_id = IF(source_hash = VALUES(source_hash), judul_id, VALUES(judul_id)),
  domain_bisnis = IF(source_hash = VALUES(source_hash), domain_bisnis, VALUES(domain_bisnis)),
  ringkasan_id = IF(source_hash = VALUES(source_hash), ringkasan_id, VALUES(ringkasan_id)),
  doc_md = IF(source_hash = VALUES(source_hash), doc_md, VALUES(doc_md)),
  delivery_status = IF(source_hash = VALUES(source_hash), delivery_status, VALUES(delivery_status)),
  links_json = IF(source_hash = VALUES(source_hash), links_json, VALUES(links_json)),
  source_hash = IF(source_hash = VALUES(source_hash), source_hash, VALUES(source_hash)),
  synced_at = IF(source_hash = VALUES(source_hash), synced_at, VALUES(synced_at))
`

export async function upsertFeatureDirectory(
  rows: ReadonlyArray<FeatureDirectoryRow>,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<number> {
  let n = 0
  for (const r of rows) {
    await executor.query(DIRECTORY_UPSERT_SQL, [
      r.featureContractId,
      r.judulId,
      r.domainBisnis,
      r.ringkasanId,
      r.docMd,
      r.deliveryStatus,
      stableJson(r.linksJson),
      r.sourceHash,
      toMysqlDatetime(r.syncedAt) ?? toMysqlDatetime(nowIso()),
    ])
    n++
  }
  return n
}

// ---------------------------------------------------------------------------
// Reads
// ---------------------------------------------------------------------------

export async function getLineageByTask(
  boardId: string,
  taskId: string,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<RebuildLineageRecord | null> {
  const [rows] = await executor.query(
    `SELECT * FROM rebuild_lineage_records WHERE board_id = ? AND task_id = ? LIMIT 1`,
    [boardId, taskId],
  )
  const list = rows as RowDataPacket[]
  if (!list?.length) return null
  return mapLineageRow(list[0]!)
}

export async function getParityRollupLatest(
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<ParityRollupRow | null> {
  const [rows] = await executor.query(
    `SELECT * FROM parity_rollups ORDER BY captured_at DESC, id DESC LIMIT 1`,
  )
  const list = rows as RowDataPacket[]
  if (!list?.length) return null
  return mapRollupRow(list[0]!)
}

export async function getParityRollupHistory(
  opts: { limit?: number } = {},
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<Array<ParityRollupRow>> {
  const limit = Math.min(Math.max(opts.limit ?? 50, 1), 500)
  const [rows] = await executor.query(
    `SELECT * FROM parity_rollups ORDER BY captured_at DESC, id DESC LIMIT ?`,
    [limit],
  )
  return ((rows as RowDataPacket[]) ?? []).map(mapRollupRow)
}

export async function listFeatureDirectory(
  opts: { domainBisnis?: string } = {},
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<Array<FeatureDirectoryRow>> {
  if (opts.domainBisnis) {
    const [rows] = await executor.query(
      `SELECT * FROM feature_directory WHERE domain_bisnis = ? ORDER BY judul_id ASC`,
      [opts.domainBisnis],
    )
    return ((rows as RowDataPacket[]) ?? []).map(mapDirectoryRow)
  }
  const [rows] = await executor.query(
    `SELECT * FROM feature_directory ORDER BY domain_bisnis ASC, judul_id ASC`,
  )
  return ((rows as RowDataPacket[]) ?? []).map(mapDirectoryRow)
}

export async function listFeatureUnits(
  featureContractId: string,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<Array<FeatureUnitRow>> {
  const [rows] = await executor.query(
    `SELECT * FROM feature_units WHERE feature_contract_id = ? ORDER BY unit_type ASC, identifier ASC`,
    [featureContractId],
  )
  return ((rows as RowDataPacket[]) ?? []).map(mapUnitRow)
}

export async function countByVerdict(
  boardId: string,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<Array<VerdictCountByLabel>> {
  const [rows] = await executor.query(
    `SELECT parity_verdict AS verdict, COUNT(*) AS cnt
     FROM rebuild_lineage_records
     WHERE board_id = ?
     GROUP BY parity_verdict
     ORDER BY cnt DESC`,
    [boardId],
  )
  return ((rows as RowDataPacket[]) ?? []).map((r) => ({
    verdict: r.verdict != null ? String(r.verdict) : 'NULL',
    count: Number(r.cnt ?? 0),
  }))
}

// ---------------------------------------------------------------------------
// Memory executor (unit tests — no real MySQL)
// ---------------------------------------------------------------------------

export function createMemoryLineageExecutor(): LineageSqlExecutor & {
  lineage: Map<string, RebuildLineageRecord>
  rollups: Array<ParityRollupRow>
  units: Map<string, FeatureUnitRow>
  directory: Map<string, FeatureDirectoryRow>
  statements: Array<{ sql: string; params?: Array<unknown> }>
} {
  const lineage = new Map<string, RebuildLineageRecord>()
  const rollups: Array<ParityRollupRow> = []
  const units = new Map<string, FeatureUnitRow>()
  const directory = new Map<string, FeatureDirectoryRow>()
  const statements: Array<{ sql: string; params?: Array<unknown> }> = []
  let rollupSeq = 1

  const key = (boardId: string, taskId: string) => `${boardId}\0${taskId}`

  return {
    lineage,
    rollups,
    units,
    directory,
    statements,
    async query(sql: string, params: Array<unknown> = []) {
      statements.push({ sql, params })
      const s = sql.replace(/\s+/g, ' ').trim().toUpperCase()

      if (s.startsWith('INSERT INTO REBUILD_LINEAGE_RECORDS')) {
        const [
          boardId,
          taskId,
          disposition,
          repository,
          origin,
          featureContractId,
          parityVerdict,
          acceptanceCovered,
          verifierModel,
          verifiedAt,
          stage1Json,
          evidenceJson,
          gapsJson,
          implementationJson,
          sourceHash,
          syncedAt,
        ] = params
        const k = key(String(boardId), String(taskId))
        const prev = lineage.get(k)
        if (prev && prev.sourceHash === String(sourceHash)) {
          return [{ affectedRows: 0 } as ResultSetHeader]
        }
        lineage.set(k, {
          boardId: String(boardId),
          taskId: String(taskId),
          disposition: disposition != null ? String(disposition) : null,
          repository: repository != null ? String(repository) : null,
          origin: origin != null ? String(origin) : null,
          featureContractId: featureContractId != null ? String(featureContractId) : null,
          parityVerdict: parityVerdict != null ? String(parityVerdict) : null,
          acceptanceCovered: acceptanceCovered != null ? String(acceptanceCovered) : null,
          verifierModel: verifierModel != null ? String(verifierModel) : null,
          verifiedAt: verifiedAt != null ? String(verifiedAt) : null,
          stage1Json: typeof stage1Json === 'string' ? JSON.parse(stage1Json) : stage1Json,
          evidenceJson: typeof evidenceJson === 'string' ? JSON.parse(evidenceJson) : evidenceJson,
          gapsJson: typeof gapsJson === 'string' ? JSON.parse(gapsJson) : gapsJson,
          implementationJson:
            typeof implementationJson === 'string'
              ? JSON.parse(implementationJson)
              : implementationJson,
          sourceHash: String(sourceHash),
          syncedAt: String(syncedAt ?? nowIso()),
        })
        return [{ affectedRows: 1 } as ResultSetHeader]
      }

      if (s.startsWith('SELECT * FROM REBUILD_LINEAGE_RECORDS WHERE BOARD_ID')) {
        const [boardId, taskId] = params
        const row = lineage.get(key(String(boardId), String(taskId)))
        if (!row) return [[]]
        return [
          [
            {
              board_id: row.boardId,
              task_id: row.taskId,
              disposition: row.disposition,
              repository: row.repository,
              origin: row.origin,
              feature_contract_id: row.featureContractId,
              parity_verdict: row.parityVerdict,
              acceptance_covered: row.acceptanceCovered,
              verifier_model: row.verifierModel,
              verified_at: row.verifiedAt,
              stage1_json: row.stage1Json,
              evidence_json: row.evidenceJson,
              gaps_json: row.gapsJson,
              implementation_json: row.implementationJson,
              source_hash: row.sourceHash,
              synced_at: row.syncedAt,
            },
          ],
        ]
      }

      if (s.startsWith('INSERT INTO PARITY_ROLLUPS')) {
        const [
          capturedAt,
          mapped100,
          partialN,
          missingN,
          pendingN,
          l0N,
          measuredN,
          totalN,
          sourceFile,
          rawText,
          sourceHash,
        ] = params
        rollups.push({
          id: rollupSeq++,
          capturedAt: String(capturedAt),
          mapped100: Number(mapped100),
          partialN: Number(partialN),
          missingN: Number(missingN),
          pendingN: Number(pendingN),
          l0N: Number(l0N),
          measuredN: Number(measuredN),
          totalN: Number(totalN),
          sourceFile: sourceFile != null ? String(sourceFile) : null,
          rawText: rawText != null ? String(rawText) : null,
          sourceHash: sourceHash != null ? String(sourceHash) : null,
        })
        return [{ affectedRows: 1, insertId: rollupSeq - 1 } as ResultSetHeader]
      }

      if (s.startsWith('SELECT ID FROM PARITY_ROLLUPS WHERE SOURCE_HASH')) {
        const [hash] = params
        const hit = rollups.filter((r) => r.sourceHash === String(hash))
        return [hit.map((r) => ({ id: r.id }))]
      }

      if (s.startsWith('SELECT * FROM PARITY_ROLLUPS ORDER BY CAPTURED_AT DESC')) {
        const sorted = [...rollups].sort((a, b) =>
          a.capturedAt < b.capturedAt ? 1 : a.capturedAt > b.capturedAt ? -1 : 0,
        )
        if (s.includes('LIMIT ?')) {
          const limit = Number(params[0] ?? 50)
          const slice = sorted.slice(0, limit)
          return [
            slice.map((r) => ({
              id: r.id,
              captured_at: r.capturedAt,
              mapped_100: r.mapped100,
              partial_n: r.partialN,
              missing_n: r.missingN,
              pending_n: r.pendingN,
              l0_n: r.l0N,
              measured_n: r.measuredN,
              total_n: r.totalN,
              source_file: r.sourceFile,
              raw_text: r.rawText,
              source_hash: r.sourceHash,
            })),
          ]
        }
        // LIMIT 1 latest
        const top = sorted[0]
        if (!top) return [[]]
        return [
          [
            {
              id: top.id,
              captured_at: top.capturedAt,
              mapped_100: top.mapped100,
              partial_n: top.partialN,
              missing_n: top.missingN,
              pending_n: top.pendingN,
              l0_n: top.l0N,
              measured_n: top.measuredN,
              total_n: top.totalN,
              source_file: top.sourceFile,
              raw_text: top.rawText,
              source_hash: top.sourceHash,
            },
          ],
        ]
      }

      if (s.startsWith('INSERT INTO FEATURE_UNITS')) {
        const [
          unitId,
          featureContractId,
          unitType,
          identifier,
          anchor,
          notes,
          coverageStatus,
          repo,
          sourceHash,
          syncedAt,
        ] = params
        const prev = units.get(String(unitId))
        if (prev && prev.sourceHash === String(sourceHash)) {
          return [{ affectedRows: 0 } as ResultSetHeader]
        }
        units.set(String(unitId), {
          unitId: String(unitId),
          featureContractId: featureContractId != null ? String(featureContractId) : null,
          unitType: unitType != null ? String(unitType) : null,
          identifier: identifier != null ? String(identifier) : null,
          anchor: anchor != null ? String(anchor) : null,
          notes: notes != null ? String(notes) : null,
          coverageStatus: coverageStatus != null ? String(coverageStatus) : null,
          repo: repo != null ? String(repo) : null,
          sourceHash: sourceHash != null ? String(sourceHash) : null,
          syncedAt: syncedAt != null ? String(syncedAt) : null,
        })
        return [{ affectedRows: 1 } as ResultSetHeader]
      }

      if (s.startsWith('SELECT * FROM FEATURE_UNITS WHERE FEATURE_CONTRACT_ID')) {
        const [fcId] = params
        const list = [...units.values()].filter((u) => u.featureContractId === String(fcId))
        return [
          list.map((u) => ({
            unit_id: u.unitId,
            feature_contract_id: u.featureContractId,
            unit_type: u.unitType,
            identifier: u.identifier,
            anchor: u.anchor,
            notes: u.notes,
            coverage_status: u.coverageStatus,
            repo: u.repo,
            source_hash: u.sourceHash,
            synced_at: u.syncedAt,
          })),
        ]
      }

      if (s.startsWith('INSERT INTO FEATURE_DIRECTORY')) {
        const [
          featureContractId,
          judulId,
          domainBisnis,
          ringkasanId,
          docMd,
          deliveryStatus,
          linksJson,
          sourceHash,
          syncedAt,
        ] = params
        const prev = directory.get(String(featureContractId))
        if (prev && prev.sourceHash === String(sourceHash)) {
          return [{ affectedRows: 0 } as ResultSetHeader]
        }
        directory.set(String(featureContractId), {
          featureContractId: String(featureContractId),
          judulId: judulId != null ? String(judulId) : null,
          domainBisnis: domainBisnis != null ? String(domainBisnis) : null,
          ringkasanId: ringkasanId != null ? String(ringkasanId) : null,
          docMd: docMd != null ? String(docMd) : null,
          deliveryStatus: deliveryStatus != null ? String(deliveryStatus) : null,
          linksJson: typeof linksJson === 'string' ? JSON.parse(linksJson) : linksJson,
          sourceHash: String(sourceHash),
          syncedAt: syncedAt != null ? String(syncedAt) : null,
        })
        return [{ affectedRows: 1 } as ResultSetHeader]
      }

      if (s.startsWith('SELECT * FROM FEATURE_DIRECTORY')) {
        let list = [...directory.values()]
        if (s.includes('WHERE DOMAIN_BISNIS')) {
          const [dom] = params
          list = list.filter((d) => d.domainBisnis === String(dom))
        }
        return [
          list.map((d) => ({
            feature_contract_id: d.featureContractId,
            judul_id: d.judulId,
            domain_bisnis: d.domainBisnis,
            ringkasan_id: d.ringkasanId,
            doc_md: d.docMd,
            delivery_status: d.deliveryStatus,
            links_json: d.linksJson,
            source_hash: d.sourceHash,
            synced_at: d.syncedAt,
          })),
        ]
      }

      if (s.startsWith('SELECT PARITY_VERDICT AS VERDICT')) {
        const [boardId] = params
        const counts = new Map<string, number>()
        for (const r of lineage.values()) {
          if (r.boardId !== String(boardId)) continue
          const v = r.parityVerdict ?? 'NULL'
          counts.set(v, (counts.get(v) ?? 0) + 1)
        }
        return [
          [...counts.entries()]
            .map(([verdict, cnt]) => ({ verdict, cnt }))
            .sort((a, b) => b.cnt - a.cnt),
        ]
      }

      throw new Error(`memory lineage executor: unsupported SQL: ${sql.slice(0, 120)}`)
    },
  }
}

// ---------------------------------------------------------------------------
// Pure sync planning (artifact → rows). No DB.
// ---------------------------------------------------------------------------

export interface SyncPaths {
  workspaceRoot: string
  lineageJsonl: string
  verdictsDir: string
  latestReport: string
  featureContractsDir: string
  rnInventory: string
  boardId?: string
}

export interface SyncPlanCounts {
  rebuild_lineage_records: number
  parity_rollups: number
  feature_units: number
  feature_directory: number
  verdict_files: number
  verdict_recount: Record<string, number>
  lineage_unclassified: number
  lineage_with_fc: number
  origin_existing: number
  origin_firm_new: number
}

export interface SyncPlan {
  counts: SyncPlanCounts
  lineage: Array<RebuildLineageRecord>
  rollups: Array<ParityRollupRow>
  units: Array<FeatureUnitRow>
  directory: Array<FeatureDirectoryRow>
  durationMs: number
  mode: 'dry-run' | 'apply'
}

export function defaultSyncPaths(workspaceRoot = '/opt/mfs/workspace'): SyncPaths {
  return {
    workspaceRoot,
    lineageJsonl: path.join(workspaceRoot, '.artifact/2026-07-16-lineage/REBUILD_LINEAGE.jsonl'),
    verdictsDir: path.join(
      workspaceRoot,
      '.artifact/2026-07-16-stage2/pipeline/l2verify/verdicts',
    ),
    latestReport: path.join(
      workspaceRoot,
      '.artifact/2026-07-16-stage2/pipeline/reports/latest.txt',
    ),
    featureContractsDir: path.join(workspaceRoot, 'CONTRACT/feature-contracts'),
    rnInventory: path.join(
      workspaceRoot,
      '.artifact/2026-07-15-fable-l0/SOL-COV/inventory/rn_xcut/rn_inventory.json',
    ),
    boardId: DEFAULT_BOARD_ID,
  }
}

/**
 * Resolve sync input paths with optional env overrides (path-B remote bundle).
 * Env keys (all optional): SYNC_WORKSPACE_ROOT, SYNC_LINEAGE_JSONL, SYNC_VERDICTS_DIR,
 * SYNC_LATEST_REPORT, SYNC_FEATURE_CONTRACTS_DIR, SYNC_RN_INVENTORY.
 */
export function resolveSyncPathsFromEnv(
  env: NodeJS.ProcessEnv | Record<string, string | undefined> = process.env,
  fallbackWorkspaceRoot = '/opt/mfs/workspace',
): SyncPaths {
  const workspaceRoot = String(env.SYNC_WORKSPACE_ROOT || fallbackWorkspaceRoot).trim() || fallbackWorkspaceRoot
  const base = defaultSyncPaths(workspaceRoot)
  const pick = (key: string, fallback: string): string => {
    const v = env[key]
    return v !== undefined && String(v).trim() !== '' ? String(v).trim() : fallback
  }
  return {
    workspaceRoot,
    lineageJsonl: pick('SYNC_LINEAGE_JSONL', base.lineageJsonl),
    verdictsDir: pick('SYNC_VERDICTS_DIR', base.verdictsDir),
    latestReport: pick('SYNC_LATEST_REPORT', base.latestReport),
    featureContractsDir: pick('SYNC_FEATURE_CONTRACTS_DIR', base.featureContractsDir),
    rnInventory: pick('SYNC_RN_INVENTORY', base.rnInventory),
    boardId: base.boardId,
  }
}

/** Result of the production sync fail-closed authority gate. */
export type ProductionSyncGateResult =
  | {
      ok: true
      approvalId: string
      backupReceipt: string
      targetHost: string
      targetDatabase: string
    }
  | {
      ok: false
      code: string
      message: string
      missing?: Array<string>
    }

/**
 * Fail-closed production apply authority for rebuild data sync.
 * Requires PRODUCTION_MUTATION_APPROVED=1, PRODUCTION_APPROVAL_ID, BACKUP_RECEIPT
 * (existing non-empty file), and SYNC_TARGET_HOST/SYNC_TARGET_DATABASE exact match
 * against the live connection binding. Never prints secrets.
 */
export function assertProductionSyncAuthority(
  input: {
    env?: NodeJS.ProcessEnv | Record<string, string | undefined>
    actualHost: string
    actualDatabase: string
    backupStat?: (receiptPath: string) => { isFile: boolean; size: number } | null
  },
): ProductionSyncGateResult {
  const env = input.env ?? process.env
  const missing: Array<string> = []

  if (String(env.PRODUCTION_MUTATION_APPROVED ?? '').trim() !== '1') {
    missing.push('PRODUCTION_MUTATION_APPROVED=1')
  }
  const approvalId = String(env.PRODUCTION_APPROVAL_ID ?? '').trim()
  if (approvalId.length < 4) {
    missing.push('PRODUCTION_APPROVAL_ID')
  }
  const backupReceipt = String(env.BACKUP_RECEIPT ?? '').trim()
  if (!backupReceipt) {
    missing.push('BACKUP_RECEIPT')
  }
  const targetHost = String(env.SYNC_TARGET_HOST ?? '').trim()
  if (!targetHost) {
    missing.push('SYNC_TARGET_HOST')
  }
  const targetDatabase = String(env.SYNC_TARGET_DATABASE ?? '').trim()
  if (!targetDatabase) {
    missing.push('SYNC_TARGET_DATABASE')
  }

  if (missing.length) {
    return {
      ok: false,
      code: 'MISSING_PRODUCTION_SYNC_BUNDLE',
      message: `APPLY_PRODUCTION_REFUSED: missing required env: ${missing.join(', ')}`,
      missing,
    }
  }

  const actualHost = String(input.actualHost ?? '').trim()
  const actualDatabase = String(input.actualDatabase ?? '').trim()
  if (targetHost !== actualHost) {
    return {
      ok: false,
      code: 'SYNC_TARGET_HOST_MISMATCH',
      message: `APPLY_PRODUCTION_REFUSED: SYNC_TARGET_HOST does not match actual CAIRN_DB_HOST binding (expected exact match; values withheld)`,
    }
  }
  if (targetDatabase !== actualDatabase) {
    return {
      ok: false,
      code: 'SYNC_TARGET_DATABASE_MISMATCH',
      message: `APPLY_PRODUCTION_REFUSED: SYNC_TARGET_DATABASE does not match actual CAIRN_DB_NAME binding (expected exact match; values withheld)`,
    }
  }

  const statFn =
    input.backupStat ??
    ((p: string) => {
      try {
        const st = fs.statSync(p)
        return { isFile: st.isFile(), size: st.size }
      } catch {
        return null
      }
    })
  const st = statFn(backupReceipt)
  if (!st || !st.isFile || st.size <= 0) {
    return {
      ok: false,
      code: 'BACKUP_RECEIPT_NOT_FOUND',
      message: `APPLY_PRODUCTION_REFUSED: BACKUP_RECEIPT path missing, not a file, or empty`,
    }
  }

  return {
    ok: true,
    approvalId,
    backupReceipt,
    targetHost,
    targetDatabase,
  }
}

/** Live recount from verdicts/*.json — never PARITY_LEDGER.json. */
export function recountVerdictsFromDir(verdictsDir: string): {
  files: number
  byVerdict: Record<string, number>
  byTask: Map<string, { verdict: string; evidence: unknown; gaps: unknown; acceptance_covered: unknown; raw: Record<string, unknown> }>
} {
  const byVerdict: Record<string, number> = {}
  const byTask = new Map<
    string,
    { verdict: string; evidence: unknown; gaps: unknown; acceptance_covered: unknown; raw: Record<string, unknown> }
  >()
  if (!fs.existsSync(verdictsDir)) {
    return { files: 0, byVerdict, byTask }
  }
  const names = fs.readdirSync(verdictsDir).filter((f) => f.endsWith('.json'))
  for (const name of names) {
    const abs = path.join(verdictsDir, name)
    let rawText = fs.readFileSync(abs, 'utf8')
    const brace = rawText.indexOf('{')
    if (brace > 0) rawText = rawText.slice(brace)
    let d: Record<string, unknown>
    try {
      d = JSON.parse(rawText) as Record<string, unknown>
    } catch {
      byVerdict.PARSE_ERROR = (byVerdict.PARSE_ERROR ?? 0) + 1
      continue
    }
    const task = String(d.task ?? d.task_id ?? name.replace(/\.json$/, ''))
    const verdict = String(d.verdict ?? 'UNKNOWN')
    byVerdict[verdict] = (byVerdict[verdict] ?? 0) + 1
    byTask.set(task, {
      verdict,
      evidence: d.evidence ?? [],
      gaps: d.gaps ?? [],
      acceptance_covered: d.acceptance_covered ?? null,
      raw: d,
    })
  }
  return { files: names.length, byVerdict, byTask }
}

export function parseLatestReport(rawText: string, sourceFile: string): ParityRollupRow {
  // Prefer PARITY (grok) line: MAPPED_100=N PARTIAL=N MISSING=N ... keukur X/Y
  const parityLine =
    rawText
      .split('\n')
      .find((l) => /PARITY\s*\(/i.test(l) || /MAPPED_100\s*=/i.test(l)) ?? rawText
  const num = (re: RegExp): number => {
    const m = parityLine.match(re) ?? rawText.match(re)
    return m ? Number(m[1]) : 0
  }
  const mapped100 = num(/MAPPED_100\s*=\s*(\d+)/i)
  const partialN = num(/PARTIAL\s*=\s*(\d+)/i)
  const missingN = num(/MISSING\s*=\s*(\d+)/i)
  // pending: PENDING_MEASURE or "lain=N" or keukur remainder
  let pendingN = num(/PENDING_MEASURE['":\s=]+(\d+)/i)
  if (!pendingN) pendingN = num(/PENDING[_\s]*MEASURE\s*=\s*(\d+)/i)
  let l0N = num(/L0_ANCHORS_PRESENT['":\s=]+(\d+)/i)
  const measuredMatch = rawText.match(/keukur\s+(\d+)\s*\/\s*(\d+)/i)
  const measuredN = measuredMatch ? Number(measuredMatch[1]) : mapped100 + partialN + missingN
  const totalN = measuredMatch ? Number(measuredMatch[2]) : DEFAULT_TOTAL_N
  if (!pendingN) {
    // derive residual when not explicit
    const known = mapped100 + partialN + missingN + l0N
    pendingN = Math.max(0, totalN - known)
  }
  const tsMatch = rawText.match(/(\d{2}:\d{2}:\d{2}Z)/) ?? rawText.match(/(\d{4}-\d{2}-\d{2}T[^\s]+)/)
  const capturedAt = tsMatch
    ? new Date(
        tsMatch[1]!.includes('T')
          ? tsMatch[1]!
          : `1970-01-01T${tsMatch[1]}`,
      ).toISOString()
    : nowIso()
  // Prefer wall-clock from cycle header if present
  const cycle = rawText.match(/CYCLE\s+(\d{2}:\d{2}:\d{2}Z)/i)
  const captured = cycle
    ? new Date().toISOString().slice(0, 11) + cycle[1]!.replace('Z', '.000Z')
    : capturedAt
  const sourceHash = sha256Hex(rawText)
  return {
    capturedAt: captured,
    mapped100,
    partialN,
    missingN,
    pendingN,
    l0N,
    measuredN,
    totalN,
    sourceFile,
    rawText,
    sourceHash,
  }
}

function domainFromProjectId(projectId: string | null | undefined, fcId: string): string {
  const p = (projectId ?? '').toLowerCase()
  const id = fcId.toUpperCase()
  if (p.includes('sales') || id.includes('-SALES') || id.startsWith('FC-SALES') || id.includes('PANEL-SALES'))
    return 'Sales'
  if (p.includes('aff') || id.includes('-AFF') || id.startsWith('FC-AFF')) return 'Affiliate'
  if (p.includes('rn') || p.includes('mobile') || id.includes('-RN') || id.startsWith('FC-RN'))
    return 'React Native'
  if (p.includes('web') || id.includes('-WEB') || id.startsWith('FC-WEB')) return 'Web Publik/Member'
  if (p.includes('admin') || id.includes('-ADMIN') || id.startsWith('FC-ADMIN')) return 'Admin'
  if (p.includes('pay') || id.includes('PAY') || id.includes('XENDIT') || id.includes('CLEENG'))
    return 'Pembayaran'
  if (p.includes('backend') || p === 'be' || id.startsWith('FC-BE')) return 'Backend'
  if (p) return p
  return 'Lainnya'
}

function extractPathTokens(anchors: unknown): Array<string> {
  const out: Array<string> = []
  if (!anchors) return out
  const list = Array.isArray(anchors) ? anchors : [anchors]
  for (const a of list) {
    if (typeof a === 'string') {
      out.push(a.split(':')[0] ?? a)
      continue
    }
    if (a && typeof a === 'object') {
      const o = a as Record<string, unknown>
      const file = o.file ?? o.path ?? o.anchor ?? o['anchor_path:line']
      if (typeof file === 'string') out.push(file.split(':')[0] ?? file)
      const repo = o.repo
      if (typeof repo === 'string' && typeof file === 'string') {
        out.push(`${repo}/${file}`.replace(/\/+/g, '/'))
      }
    }
  }
  return out
}

const PATH_NOISE = new Set([
  'legacy',
  'app',
  'src',
  'http',
  'https',
  'controllers',
  'models',
  'services',
  'routes',
  'api',
  'index',
  'components',
  'screens',
  'hooks',
  'utils',
  'lib',
  'php',
  'js',
  'ts',
  'tsx',
  'jsx',
])

/** Extract significant path tokens for O(1) FC matching (no multi-MB string scan). */
function pathTokensFrom(paths: ReadonlyArray<string>): Array<string> {
  const out: Array<string> = []
  for (const p of paths) {
    const base = path.basename(p).toLowerCase()
    const noExt = base.replace(/\.[a-z0-9]+$/i, '')
    if (noExt.length >= 4 && !PATH_NOISE.has(noExt)) out.push(noExt)
    const segs = p
      .toLowerCase()
      .split(/[\\/]/)
      .map((s) => s.replace(/\.[a-z0-9]+$/i, ''))
      .filter((s) => s.length >= 4 && !PATH_NOISE.has(s))
    for (const seg of segs.slice(-4)) out.push(seg)
  }
  return out
}

function buildContractTokenIndex(
  contracts: ReadonlyArray<FeatureContractLoaded>,
): Array<{ id: string; tokens: Set<string> }> {
  return contracts.map((c) => {
    const tokens = new Set<string>()
    // Prefer structured fields over full blob scan
    const structured = [
      c.id,
      c.title,
      c.oneLinerId ?? '',
      c.projectId ?? '',
      ...c.nodeIds,
      ...extractPathTokens(
        (c.json.nodes as Array<Record<string, unknown>> | undefined)?.flatMap((n) =>
          n && typeof n === 'object'
            ? [
                ...((n.legacy_anchors as unknown[]) ?? []),
                ...((n.rebuild_anchors as unknown[]) ?? []),
              ]
            : [],
        ) ?? [],
      ),
    ]
    for (const s of structured) {
      for (const tok of pathTokensFrom([String(s)])) tokens.add(tok)
      const lower = String(s).toLowerCase()
      if (lower.length >= 4) tokens.add(lower)
    }
    // Sample basename-like tokens from searchBlob without full includes loops:
    // only path-looking substrings ending in common extensions.
    const pathHits = c.searchBlob.match(
      /[a-z0-9_./-]{6,}\.(?:php|js|ts|tsx|jsx|vue|py|java)/g,
    )
    if (pathHits) {
      for (const hit of pathHits.slice(0, 80)) {
        for (const tok of pathTokensFrom([hit])) tokens.add(tok)
      }
    }
    return { id: c.id, tokens }
  })
}

function pathHeuristicScoreTokens(
  pathToks: ReadonlyArray<string>,
  fcTokens: Set<string>,
): number {
  if (!pathToks.length || !fcTokens.size) return 0
  let score = 0
  const seen = new Set<string>()
  for (const t of pathToks) {
    if (seen.has(t)) continue
    seen.add(t)
    if (fcTokens.has(t)) score += 3
  }
  return score
}

function bestFeatureByPath(
  paths: ReadonlyArray<string>,
  index: ReadonlyArray<{ id: string; tokens: Set<string> }>,
  minScore = 4,
): { id: string; score: number } | null {
  const toks = pathTokensFrom(paths)
  if (!toks.length) return null
  let best: { id: string; score: number } | null = null
  for (const c of index) {
    const score = pathHeuristicScoreTokens(toks, c.tokens)
    if (score >= minScore && (!best || score > best.score)) best = { id: c.id, score }
  }
  return best
}

export interface FeatureContractLoaded {
  id: string
  title: string
  projectId: string | null
  objective: string | null
  oneLinerId: string | null
  deliveryStatus: string | null
  docMd: string
  json: Record<string, unknown>
  searchBlob: string
  nodeIds: Array<string>
}

export function loadFeatureContracts(dir: string): Array<FeatureContractLoaded> {
  if (!fs.existsSync(dir)) return []
  const files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'))
  const out: Array<FeatureContractLoaded> = []
  for (const f of files) {
    const abs = path.join(dir, f)
    let json: Record<string, unknown>
    try {
      json = JSON.parse(fs.readFileSync(abs, 'utf8')) as Record<string, unknown>
    } catch {
      continue
    }
    const id = String(json.id ?? f.replace(/\.json$/, ''))
    const mdPath = path.join(dir, `${id}.md`)
    const docMd = fs.existsSync(mdPath) ? fs.readFileSync(mdPath, 'utf8') : ''
    const nodeIds: Array<string> = []
    for (const n of (json.nodes as Array<unknown>) ?? []) {
      if (typeof n === 'string') nodeIds.push(n)
      else if (n && typeof n === 'object' && (n as { id?: string }).id) {
        nodeIds.push(String((n as { id: string }).id))
      }
    }
    const searchBlob = `${JSON.stringify(json)}\n${docMd}`.toLowerCase()
    out.push({
      id,
      title: String(json.title ?? id),
      projectId: json.projectId != null ? String(json.projectId) : null,
      objective: json.objective != null ? String(json.objective) : null,
      oneLinerId: json.one_liner_id != null ? String(json.one_liner_id) : null,
      deliveryStatus: json.delivery_status != null ? String(json.delivery_status) : null,
      docMd,
      json,
      searchBlob,
      nodeIds,
    })
  }
  return out
}

/** Map covered unit / node id → FC from contracts + existing lineage rows. */
export function buildUnitToFeatureMap(
  contracts: ReadonlyArray<FeatureContractLoaded>,
  lineageRaw: ReadonlyArray<Record<string, unknown>>,
): Map<string, string> {
  const map = new Map<string, string>()
  for (const c of contracts) {
    for (const n of c.nodeIds) map.set(n, c.id)
    map.set(c.id, c.id)
  }
  for (const rec of lineageRaw) {
    const stage1 = (rec.stage1 ?? {}) as Record<string, unknown>
    const fc = stage1.featureContractId
    if (typeof fc !== 'string' || !fc) continue
    const units =
      (stage1.covered_gap_units as Array<unknown>) ??
      (stage1.covered_legacy_units as Array<unknown>) ??
      []
    for (const u of units) {
      if (typeof u === 'string' && u && !map.has(u)) map.set(u, fc)
    }
  }
  return map
}

export function resolveFeatureContractId(input: {
  stage1: Record<string, unknown>
  contracts: ReadonlyArray<FeatureContractLoaded>
  unitToFc: Map<string, string>
  contractIndex?: ReadonlyArray<{ id: string; tokens: Set<string> }>
}): { featureContractId: string | null; classificationFlag: string | null; method: string } {
  const explicit = input.stage1.featureContractId
  if (typeof explicit === 'string' && explicit.trim()) {
    return { featureContractId: explicit.trim(), classificationFlag: null, method: 'stage1.featureContractId' }
  }
  const units = (
    (input.stage1.covered_gap_units as Array<unknown>) ??
    (input.stage1.covered_legacy_units as Array<unknown>) ??
    []
  ).filter((u): u is string => typeof u === 'string')
  for (const u of units) {
    const hit = input.unitToFc.get(u)
    if (hit) return { featureContractId: hit, classificationFlag: null, method: 'covered_unit→FC' }
  }
  // Path heuristic against prebuilt FC token index (fast)
  const paths = extractPathTokens(input.stage1.legacy_anchors)
  const index = input.contractIndex ?? buildContractTokenIndex(input.contracts)
  const best = bestFeatureByPath(paths, index, 4)
  if (best) {
    return {
      featureContractId: best.id,
      classificationFlag: null,
      method: `path_heuristic score=${best.score}`,
    }
  }
  return {
    featureContractId: null,
    classificationFlag: UNCLASSIFIED_FLAG,
    method: 'unmapped',
  }
}

export function stableUnitId(repo: string, unitType: string, identifier: string, anchor: string): string {
  const h = sha256Hex(`${repo}\0${unitType}\0${identifier}\0${anchor}`).slice(0, 20).toUpperCase()
  return `FU-${h}`
}

export function buildSyncPlan(paths: SyncPaths, mode: 'dry-run' | 'apply' = 'dry-run'): SyncPlan {
  const t0 = Date.now()
  const boardId = paths.boardId ?? DEFAULT_BOARD_ID
  const syncedAt = nowIso()

  if (!fs.existsSync(paths.lineageJsonl)) {
    throw new Error(`LINEAGE_MISSING: ${paths.lineageJsonl}`)
  }

  const lineageRaw: Array<Record<string, unknown>> = []
  for (const line of fs.readFileSync(paths.lineageJsonl, 'utf8').split('\n')) {
    const t = line.trim()
    if (!t) continue
    lineageRaw.push(JSON.parse(t) as Record<string, unknown>)
  }

  const verdicts = recountVerdictsFromDir(paths.verdictsDir)
  const contracts = loadFeatureContracts(paths.featureContractsDir)
  const unitToFc = buildUnitToFeatureMap(contracts, lineageRaw)
  const contractIndex = buildContractTokenIndex(contracts)

  const lineage: Array<RebuildLineageRecord> = []
  let unclassified = 0
  let withFc = 0
  let originExisting = 0
  let originFirmNew = 0

  for (const rec of lineageRaw) {
    const taskId = String(rec.task_id ?? '')
    if (!taskId) continue
    const stage1 = (rec.stage1 ?? {}) as Record<string, unknown>
    const l2r = (rec.legacy_to_rebuild ?? {}) as Record<string, unknown>
    const impl = rec.implementation ?? {}
    const origin = stage1.origin != null ? String(stage1.origin) : null
    if (origin === 'existing') originExisting++
    else if (origin === 'firm-new-blindspot') originFirmNew++

    const resolved = resolveFeatureContractId({
      stage1,
      contracts,
      unitToFc,
      contractIndex,
    })
    if (resolved.featureContractId) withFc++
    else unclassified++

    // Live verdict recount overrides stale lineage parity when a verdict file exists.
    const live = verdicts.byTask.get(taskId)
    const parityVerdict = live?.verdict ?? (l2r.parity_verdict != null ? String(l2r.parity_verdict) : null)
    const evidence = live?.evidence ?? l2r.evidence ?? []
    const gaps = live?.gaps ?? l2r.gaps ?? []
    const acceptance = live?.acceptance_covered ?? l2r.acceptance_covered ?? null

    const stage1Out = {
      ...stage1,
      covered_gap_units:
        stage1.covered_gap_units ?? stage1.covered_legacy_units ?? [],
      classification_flag: resolved.classificationFlag,
      fc_resolve_method: resolved.method,
    }

    const sourceHash = sha256Hex(
      stableJson({
        taskId,
        disposition: rec.disposition,
        repository: rec.repository,
        stage1: stage1Out,
        parityVerdict,
        evidence,
        gaps,
        acceptance,
        impl,
        featureContractId: resolved.featureContractId,
      }),
    )

    lineage.push({
      boardId,
      taskId,
      disposition: rec.disposition != null ? String(rec.disposition) : null,
      repository: rec.repository != null ? String(rec.repository) : null,
      origin,
      featureContractId: resolved.featureContractId,
      parityVerdict,
      acceptanceCovered: acceptance != null ? String(acceptance) : null,
      verifierModel: l2r.verifier_model != null ? String(l2r.verifier_model) : live ? 'l2verify-file' : null,
      verifiedAt: l2r.verified_at != null ? String(l2r.verified_at) : null,
      stage1Json: stage1Out,
      evidenceJson: evidence,
      gapsJson: gaps,
      implementationJson: impl,
      sourceHash,
      syncedAt,
    })
  }

  // Rollup from live recount + latest.txt snapshot text
  let rollupFromReport: ParityRollupRow | null = null
  if (fs.existsSync(paths.latestReport)) {
    const raw = fs.readFileSync(paths.latestReport, 'utf8')
    rollupFromReport = parseLatestReport(raw, paths.latestReport)
  }
  // Prefer live verdict file counts for MAPPED/PARTIAL/MISSING; fill pending from lineage residual.
  const liveMapped = verdicts.byVerdict.MAPPED_100 ?? 0
  const livePartial = verdicts.byVerdict.PARTIAL ?? 0
  const liveMissing = verdicts.byVerdict.MISSING ?? 0
  const liveMeasured = liveMapped + livePartial + liveMissing
  // Count lineage pending/L0 not covered by verdict files
  let pendingN = 0
  let l0N = 0
  for (const r of lineage) {
    const v = r.parityVerdict
    if (v === 'PENDING_MEASURE') pendingN++
    else if (v === 'L0_ANCHORS_PRESENT') l0N++
  }
  const rollup: ParityRollupRow = {
    capturedAt: syncedAt,
    mapped100: liveMapped || rollupFromReport?.mapped100 || 0,
    partialN: livePartial || rollupFromReport?.partialN || 0,
    missingN: liveMissing || rollupFromReport?.missingN || 0,
    pendingN: pendingN || rollupFromReport?.pendingN || 0,
    l0N: l0N || rollupFromReport?.l0N || 0,
    measuredN: liveMeasured || rollupFromReport?.measuredN || 0,
    totalN: lineage.length || rollupFromReport?.totalN || DEFAULT_TOTAL_N,
    sourceFile: paths.latestReport,
    rawText: rollupFromReport?.rawText ?? null,
    sourceHash: sha256Hex(
      stableJson({
        live: verdicts.byVerdict,
        files: verdicts.files,
        reportHash: rollupFromReport?.sourceHash ?? null,
        total: lineage.length,
      }),
    ),
  }

  // Feature directory
  const directory: Array<FeatureDirectoryRow> = contracts.map((c) => {
    const links = {
      json: `CONTRACT/feature-contracts/${c.id}.json`,
      md: c.docMd ? `CONTRACT/feature-contracts/${c.id}.md` : null,
      integration_task_id: c.json.integration_task_id ?? null,
    }
    const sourceHash = sha256Hex(stableJson({ id: c.id, json: c.json, md: c.docMd }))
    return {
      featureContractId: c.id,
      judulId: c.title || c.oneLinerId || c.id,
      domainBisnis: domainFromProjectId(c.projectId, c.id),
      ringkasanId: c.objective || c.oneLinerId || null,
      docMd: c.docMd || null,
      deliveryStatus: c.deliveryStatus,
      linksJson: links,
      sourceHash,
      syncedAt,
    }
  })

  // Feature units from rn_inventory (+ optional FC via path heuristic token index)
  const units: Array<FeatureUnitRow> = []
  if (fs.existsSync(paths.rnInventory)) {
    const inv = JSON.parse(fs.readFileSync(paths.rnInventory, 'utf8')) as Array<
      Record<string, unknown>
    >
    for (const u of inv) {
      const repo = String(u.repo ?? 'rn-mfs81')
      const unitType = String(u.unit_type ?? 'unknown')
      const identifier = String(u.identifier ?? '')
      const anchor = String(u['anchor_path:line'] ?? u.anchor ?? '')
      const unitId = stableUnitId(repo, unitType, identifier, anchor)
      const pathsForUnit = [anchor.split(':')[0] ?? '', identifier]
      const best = bestFeatureByPath(pathsForUnit, contractIndex, 4)
      const fcId = best?.id ?? null
      const notes = u.notes != null ? String(u.notes) : null
      const coverageStatus = fcId ? 'mapped_heuristic' : UNCLASSIFIED_FLAG
      const sourceHash = sha256Hex(
        stableJson({ repo, unitType, identifier, anchor, fcId, notes }),
      )
      units.push({
        unitId,
        featureContractId: fcId,
        unitType,
        identifier,
        anchor,
        notes,
        coverageStatus,
        repo,
        sourceHash,
        syncedAt,
      })
    }
  }

  const counts: SyncPlanCounts = {
    rebuild_lineage_records: lineage.length,
    parity_rollups: 1,
    feature_units: units.length,
    feature_directory: directory.length,
    verdict_files: verdicts.files,
    verdict_recount: verdicts.byVerdict,
    lineage_unclassified: unclassified,
    lineage_with_fc: withFc,
    origin_existing: originExisting,
    origin_firm_new: originFirmNew,
  }

  return {
    counts,
    lineage,
    rollups: [rollup],
    units,
    directory,
    durationMs: Date.now() - t0,
    mode,
  }
}

export async function applySyncPlan(
  plan: SyncPlan,
  executor: LineageSqlExecutor = defaultExecutor(),
): Promise<{
  applied: SyncPlanCounts
  durationMs: number
}> {
  const t0 = Date.now()
  const nLineage = await upsertLineageRecords(plan.lineage, executor)
  const nRollups = await upsertParityRollups(plan.rollups, executor)
  const nUnits = await upsertFeatureUnits(plan.units, executor)
  const nDir = await upsertFeatureDirectory(plan.directory, executor)
  return {
    applied: {
      ...plan.counts,
      rebuild_lineage_records: nLineage,
      parity_rollups: nRollups,
      feature_units: nUnits,
      feature_directory: nDir,
    },
    durationMs: Date.now() - t0,
  }
}

/** Parse 009 SQL for schema tests (column/index presence). */
export function parseMigration009Sql(sql: string): {
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

