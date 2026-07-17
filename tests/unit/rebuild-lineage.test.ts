/**
 * W-DATA-1: migration 009 schema parse + memory store roundtrip + sync dry-run against real artifacts.
 * No real MySQL apply. No production DB connection.
 */
import fs from 'node:fs'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  applyMigrations,
  createMemoryMigrationExecutor,
  g0IdentityLifecycleMappingRows,
  loadMigrationManifest,
  planMigrations,
  splitSqlStatements,
} from '#/server/migrations'
import {
  applySyncPlan,
  buildSyncPlan,
  countByVerdict,
  createMemoryLineageExecutor,
  defaultSyncPaths,
  getLineageByTask,
  getParityRollupHistory,
  getParityRollupLatest,
  listFeatureDirectory,
  listFeatureUnits,
  parseMigration009Sql,
  recountVerdictsFromDir,
  upsertFeatureDirectory,
  upsertFeatureUnits,
  upsertLineageRecords,
  upsertParityRollups,
  type FeatureDirectoryRow,
  type FeatureUnitRow,
  type ParityRollupRow,
  type RebuildLineageRecord,
} from '#/server/rebuild-lineage-store'

const cwd = process.cwd()
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()
const WORKSPACE = '/opt/mfs/workspace'

describe('migration 009 schema + manifest', () => {
  it('manifest registers 009 as REVERSIBLE after 008', () => {
    const loaded = loadMigrationManifest(cwd)
    const versions = loaded.map((m) => m.version)
    expect(versions).toContain('009')
    // 010 (product features) may be registered after 009; W-DATA-1 only requires 009 present + REVERSIBLE.
    expect(versions.indexOf('009')).toBeGreaterThan(versions.indexOf('008'))
    const m009 = loaded.find((m) => m.version === '009')!
    expect(m009.filename).toBe('009_rebuild_lineage.sql')
    expect(m009.classification).toBe('REVERSIBLE')
    expect(m009.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(m009.statements.length).toBeGreaterThanOrEqual(4)
    expect(m009.sql).toMatch(/CREATE TABLE IF NOT EXISTS rebuild_lineage_records/i)
    expect(m009.sql).not.toMatch(/ALTER TABLE tasks/i)
    expect(m009.sql).not.toMatch(/DROP TABLE/i)
  })

  it('009 SQL columns and indexes match SPEC §2 (parse)', () => {
    const sqlPath = path.join(cwd, 'migrations/009_rebuild_lineage.sql')
    const sql = fs.readFileSync(sqlPath, 'utf8')
    const parsed = parseMigration009Sql(sql)
    expect(parsed.tables).toEqual([
      'rebuild_lineage_records',
      'parity_rollups',
      'feature_units',
      'feature_directory',
    ])

    const rlr = parsed.columnsByTable.rebuild_lineage_records!
    for (const col of [
      'board_id',
      'task_id',
      'disposition',
      'repository',
      'origin',
      'feature_contract_id',
      'parity_verdict',
      'acceptance_covered',
      'verifier_model',
      'verified_at',
      'stage1_json',
      'evidence_json',
      'gaps_json',
      'implementation_json',
      'source_hash',
      'synced_at',
    ]) {
      expect(rlr).toContain(col)
    }
    const rlrIdx = parsed.indexesByTable.rebuild_lineage_records!.join(' ')
    expect(rlrIdx).toMatch(/task_id/)
    expect(rlrIdx).toMatch(/feature_contract_id/)
    expect(rlrIdx).toMatch(/parity_verdict/)

    const pr = parsed.columnsByTable.parity_rollups!
    for (const col of [
      'id',
      'captured_at',
      'mapped_100',
      'partial_n',
      'missing_n',
      'pending_n',
      'l0_n',
      'measured_n',
      'total_n',
      'source_file',
      'raw_text',
    ]) {
      expect(pr).toContain(col)
    }
    expect(parsed.indexesByTable.parity_rollups!.join(' ')).toMatch(/captured_at/)

    const fu = parsed.columnsByTable.feature_units!
    for (const col of [
      'unit_id',
      'feature_contract_id',
      'unit_type',
      'identifier',
      'anchor',
      'notes',
      'coverage_status',
      'repo',
    ]) {
      expect(fu).toContain(col)
    }

    const fd = parsed.columnsByTable.feature_directory!
    for (const col of [
      'feature_contract_id',
      'judul_id',
      'domain_bisnis',
      'ringkasan_id',
      'doc_md',
      'delivery_status',
      'links_json',
      'source_hash',
    ]) {
      expect(fd).toContain(col)
    }

    // Idempotent statements only
    const stmts = splitSqlStatements(sql)
    expect(stmts.every((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))).toBe(true)
  })

  it('memory migration executor can plan/apply 009 after 008 history', async () => {
    const loaded = loadMigrationManifest(cwd)
    const through008 = loaded
      .filter((m) => m.version <= '008')
      .map((m) => ({
        version: m.version,
        filename: m.filename,
        sha256: m.sha256,
        classification: m.classification,
      }))
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through008,
      cwd,
      mode: 'plan',
    })
    expect(plan.status).toBe('READY')
    const item009 = plan.items.find((i) => i.version === '009')!
    expect(item009.action).toBe('APPLY')

    const exec = createMemoryMigrationExecutor(through008)
    const first = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(first.ok).toBe(true)
    expect(first.applied).toContain('009')
    expect(exec.statements.some((s) => /rebuild_lineage_records/i.test(s))).toBe(true)
    expect(exec.statements.some((s) => /parity_rollups/i.test(s))).toBe(true)
    expect(exec.statements.some((s) => /feature_units/i.test(s))).toBe(true)
    expect(exec.statements.some((s) => /feature_directory/i.test(s))).toBe(true)

    const second = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(second.ok).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.plan.status).toBe('IDEMPOTENT_NOOP')
  })
})

describe('rebuild-lineage-store memory roundtrip', () => {
  it('upsert + getLineageByTask + countByVerdict', async () => {
    const mem = createMemoryLineageExecutor()
    const row: RebuildLineageRecord = {
      boardId: 'mfs-rebuild',
      taskId: 'T-TEST-LINEAGE-1',
      disposition: 'ACTIVE',
      repository: 'rebuild-backend',
      origin: 'existing',
      featureContractId: 'FC-TEST',
      parityVerdict: 'MAPPED_100',
      acceptanceCovered: '1/1',
      verifierModel: 'test',
      verifiedAt: '2026-07-17T00:00:00.000Z',
      stage1Json: { origin: 'existing' },
      evidenceJson: ['a.ts:1'],
      gapsJson: [],
      implementationJson: { has_real_output: true },
      sourceHash: 'a'.repeat(64),
      syncedAt: '2026-07-17T00:00:00.000Z',
    }
    await upsertLineageRecords([row], mem)
    const got = await getLineageByTask('mfs-rebuild', 'T-TEST-LINEAGE-1', mem)
    expect(got).not.toBeNull()
    expect(got!.taskId).toBe('T-TEST-LINEAGE-1')
    expect(got!.parityVerdict).toBe('MAPPED_100')
    expect(got!.featureContractId).toBe('FC-TEST')
    expect(got!.sourceHash).toBe('a'.repeat(64))

    // idempotent same hash
    await upsertLineageRecords([row], mem)
    expect(mem.lineage.size).toBe(1)

    // change hash updates
    await upsertLineageRecords([{ ...row, parityVerdict: 'PARTIAL', sourceHash: 'b'.repeat(64) }], mem)
    const got2 = await getLineageByTask('mfs-rebuild', 'T-TEST-LINEAGE-1', mem)
    expect(got2!.parityVerdict).toBe('PARTIAL')

    const counts = await countByVerdict('mfs-rebuild', mem)
    expect(counts.some((c) => c.verdict === 'PARTIAL' && c.count === 1)).toBe(true)
  })

  it('parity rollup latest + history + feature units/directory', async () => {
    const mem = createMemoryLineageExecutor()
    const r1: ParityRollupRow = {
      capturedAt: '2026-07-17T01:00:00.000Z',
      mapped100: 10,
      partialN: 2,
      missingN: 1,
      pendingN: 0,
      l0N: 0,
      measuredN: 13,
      totalN: 2501,
      sourceFile: 'reports/latest.txt',
      rawText: 'MAPPED_100=10',
      sourceHash: 'c'.repeat(64),
    }
    const r2: ParityRollupRow = {
      ...r1,
      capturedAt: '2026-07-17T02:00:00.000Z',
      mapped100: 11,
      sourceHash: 'd'.repeat(64),
    }
    expect(await upsertParityRollups([r1], mem)).toBe(1)
    expect(await upsertParityRollups([r1], mem)).toBe(0) // same source_hash skip
    expect(await upsertParityRollups([r2], mem)).toBe(1)

    const latest = await getParityRollupLatest(mem)
    expect(latest!.mapped100).toBe(11)
    const hist = await getParityRollupHistory({ limit: 10 }, mem)
    expect(hist.length).toBe(2)

    const unit: FeatureUnitRow = {
      unitId: 'FU-TEST-1',
      featureContractId: 'FC-TEST',
      unitType: 'rn_screen',
      identifier: 'MeditationScreen',
      anchor: 'legacy/rn-mfs81/src/screens/meditation/index.js:1',
      notes: 'test',
      coverageStatus: 'mapped_heuristic',
      repo: 'rn-mfs81',
      sourceHash: 'e'.repeat(64),
      syncedAt: '2026-07-17T00:00:00.000Z',
    }
    await upsertFeatureUnits([unit], mem)
    const units = await listFeatureUnits('FC-TEST', mem)
    expect(units).toHaveLength(1)
    expect(units[0]!.identifier).toBe('MeditationScreen')

    const dir: FeatureDirectoryRow = {
      featureContractId: 'FC-TEST',
      judulId: 'Meditasi',
      domainBisnis: 'Latihan & Kesehatan',
      ringkasanId: 'Fitur meditasi',
      docMd: '# Meditasi',
      deliveryStatus: 'not_started',
      linksJson: { md: 'x.md' },
      sourceHash: 'f'.repeat(64),
      syncedAt: '2026-07-17T00:00:00.000Z',
    }
    await upsertFeatureDirectory([dir], mem)
    const dirs = await listFeatureDirectory({}, mem)
    expect(dirs).toHaveLength(1)
    expect(dirs[0]!.judulId).toBe('Meditasi')
  })
})

describe('sync dry-run against real artifacts (program-emitted)', () => {
  it(
    'buildSyncPlan counts > 0 and verdict recount matches file count',
    () => {
      const paths = defaultSyncPaths(WORKSPACE)
      expect(fs.existsSync(paths.lineageJsonl)).toBe(true)
      expect(fs.existsSync(paths.verdictsDir)).toBe(true)
      expect(fs.existsSync(paths.featureContractsDir)).toBe(true)
      expect(fs.existsSync(paths.rnInventory)).toBe(true)

      const live = recountVerdictsFromDir(paths.verdictsDir)
      const plan = buildSyncPlan(paths, 'dry-run')

      expect(plan.counts.rebuild_lineage_records).toBeGreaterThan(0)
      expect(plan.counts.feature_units).toBeGreaterThan(0)
      expect(plan.counts.feature_directory).toBeGreaterThan(0)
      expect(plan.counts.parity_rollups).toBe(1)
      expect(plan.counts.verdict_files).toBe(live.files)
      expect(plan.counts.verdict_files).toBeGreaterThan(0)

      // program-emitted: sum of verdict recount == number of verdict files
      const recountSum = Object.entries(plan.counts.verdict_recount)
        .filter(([k]) => k !== 'PARSE_ERROR')
        .reduce((a, [, n]) => a + n, 0)
      const parseErr = plan.counts.verdict_recount.PARSE_ERROR ?? 0
      expect(recountSum + parseErr).toBe(plan.counts.verdict_files)
      expect(recountSum).toBe(live.files - (live.byVerdict.PARSE_ERROR ?? 0))

      // origin split present
      expect(plan.counts.origin_existing + plan.counts.origin_firm_new).toBe(
        plan.counts.rebuild_lineage_records,
      )

      // unclassified remain visible (flag path), not dropped
      expect(plan.counts.lineage_unclassified).toBeGreaterThanOrEqual(0)
      const unclass = plan.lineage.filter((r) => !r.featureContractId)
      for (const r of unclass.slice(0, 3)) {
        const s1 = r.stage1Json as { classification_flag?: string }
        expect(s1.classification_flag).toBe('belum terklasifikasi')
      }
    },
    120_000,
  )

  it(
    'applySyncPlan into memory executor preserves counts',
    async () => {
      const paths = defaultSyncPaths(WORKSPACE)
      const full = buildSyncPlan(paths, 'dry-run')
      const slice = {
        ...full,
        lineage: full.lineage.slice(0, 25),
        units: full.units.slice(0, 25),
        directory: full.directory.slice(0, 10),
        rollups: full.rollups,
      }
      const mem = createMemoryLineageExecutor()
      const applied = await applySyncPlan(slice, mem)
      expect(applied.applied.rebuild_lineage_records).toBe(25)
      expect(applied.applied.feature_units).toBe(25)
      expect(applied.applied.feature_directory).toBe(10)
      expect(applied.applied.parity_rollups).toBe(1)

      const sample = slice.lineage[0]!
      const got = await getLineageByTask(sample.boardId, sample.taskId, mem)
      expect(got?.taskId).toBe(sample.taskId)
      expect(got?.sourceHash).toBe(sample.sourceHash)
    },
    120_000,
  )
})
