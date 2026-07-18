/**
 * W-DATA-2: migration 010 schema parse + seed validation + memory store +
 * meditation mapping gate + product-feature sync dry-run (no real MySQL).
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
  applyProductFeatureSyncPlan,
  buildFeatureTaskMaps,
  buildProductFeatureSyncPlan,
  createMemoryProductFeaturesExecutor,
  defaultProductFeaturesSeedPath,
  getFeature360,
  JOIN_CONFIDENCE,
  listProductFeatures,
  listUnmappedTasks,
  loadProductFeaturesSeed,
  meditationCandidateTaskIds,
  meditationCheck,
  namaIdLooksIndonesian,
  parseMigration010Sql,
  seedToProductFeatureRows,
  taskJoinInputFromLineageRaw,
  upsertFeatureTaskMaps,
  upsertProductFeatures,
  validateProductFeaturesSeed,
  type TaskJoinInput,
} from '#/server/product-features-store'
import { loadFeatureContracts } from '#/server/rebuild-lineage-store'

const cwd = process.cwd()
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()
const WORKSPACE = '/opt/mfs/workspace'
const SEED_PATH = defaultProductFeaturesSeedPath(cwd)

describe('migration 010 schema + manifest', () => {
  it('manifest registers 010 as REVERSIBLE after 009', () => {
    const loaded = loadMigrationManifest(cwd)
    const versions = loaded.map((m) => m.version)
    expect(versions).toContain('009')
    expect(versions).toContain('010')
    // 010 remains registered after 009; product tip may advance past 010 (011/012).
    expect(versions.indexOf('010')).toBeGreaterThan(versions.indexOf('009'))
    const m010 = loaded.find((m) => m.version === '010')!
    expect(m010.filename).toBe('010_product_features.sql')
    expect(m010.classification).toBe('REVERSIBLE')
    expect(m010.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(m010.statements.length).toBeGreaterThanOrEqual(2)
    expect(m010.sql).toMatch(/CREATE TABLE IF NOT EXISTS product_features/i)
    expect(m010.sql).toMatch(/CREATE TABLE IF NOT EXISTS feature_task_map/i)
    expect(m010.sql).not.toMatch(/ALTER TABLE tasks/i)
    expect(m010.sql).not.toMatch(/DROP TABLE/i)
  })

  it('010 SQL columns and indexes match ADDENDUM V1.1 §B (parse)', () => {
    const sqlPath = path.join(cwd, 'migrations/010_product_features.sql')
    const sql = fs.readFileSync(sqlPath, 'utf8')
    const parsed = parseMigration010Sql(sql)
    expect(parsed.tables).toEqual(['product_features', 'feature_task_map'])

    const pf = parsed.columnsByTable.product_features!
    for (const col of [
      'feature_id',
      'nama_id',
      'domain_bisnis',
      'ringkasan_id',
      'platform_json',
      'capabilities_json',
      'fc_refs_json',
      'curated',
    ]) {
      expect(pf).toContain(col)
    }
    const pfIdx = parsed.indexesByTable.product_features!.join(' ')
    expect(pfIdx).toMatch(/feature_id|primary/i)

    const ftm = parsed.columnsByTable.feature_task_map!
    for (const col of ['feature_id', 'task_id', 'join_source', 'confidence']) {
      expect(ftm).toContain(col)
    }
    const ftmIdx = parsed.indexesByTable.feature_task_map!.join(' ')
    expect(ftmIdx).toMatch(/feature_id/)
    expect(ftmIdx).toMatch(/task_id/)
    expect(ftmIdx).toMatch(/join_source/)

    const stmts = splitSqlStatements(sql)
    expect(stmts.every((s) => /CREATE TABLE IF NOT EXISTS/i.test(s))).toBe(true)
  })

  it('memory migration executor can plan/apply 010 after 009 history', async () => {
    const loaded = loadMigrationManifest(cwd)
    const through009 = loaded
      .filter((m) => m.version <= '009')
      .map((m) => ({
        version: m.version,
        filename: m.filename,
        sha256: m.sha256,
        classification: m.classification,
      }))
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through009,
      cwd,
      mode: 'plan',
    })
    expect(plan.status).toBe('READY')
    const item010 = plan.items.find((i) => i.version === '010')!
    expect(item010.action).toBe('APPLY')

    const exec = createMemoryMigrationExecutor(through009)
    const first = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(first.ok).toBe(true)
    expect(first.applied).toContain('010')
    expect(exec.statements.some((s) => /product_features/i.test(s))).toBe(true)
    expect(exec.statements.some((s) => /feature_task_map/i.test(s))).toBe(true)

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

describe('product-features seed validation', () => {
  it('covers all FC contracts, unique ids, nama_id non-EN heuristic', () => {
    const seed = loadProductFeaturesSeed(SEED_PATH)
    const contracts = loadFeatureContracts(path.join(WORKSPACE, 'CONTRACT/feature-contracts'))
    const fcIds = contracts.map((c) => c.id).filter((id) => id.startsWith('FC-'))
    expect(fcIds.length).toBe(85)

    const v = validateProductFeaturesSeed(seed, fcIds)
    expect(v.missingFcIds).toEqual([])
    expect(v.duplicateIds).toEqual([])
    expect(v.nonIdNama).toEqual([])
    expect(v.domainErrors).toEqual([])
    expect(v.featureCount).toBeGreaterThanOrEqual(40)
    expect(v.featureCount).toBeLessThanOrEqual(90)
    expect(v.ok).toBe(true)

    const ids = seed.features.map((f) => f.feature_id)
    expect(ids).toContain('FEAT-MEDITATION')
    expect(ids).toContain('FEAT-PUASA')
    expect(ids).toContain('FEAT-SIKLUS-HAID')
    expect(ids).toContain('FEAT-WORKOUT')

    const med = seed.features.find((f) => f.feature_id === 'FEAT-MEDITATION')!
    expect(med.nama_id).toBe('Meditasi')
    expect(med.domain_bisnis).toBe('Kesehatan & Wellness')
    expect(med.curated).toBe(false)
    expect(namaIdLooksIndonesian(med.nama_id)).toBe(true)
    expect(namaIdLooksIndonesian('Meditation Catalog')).toBe(false)
  })
})

describe('layered join rules + meditation gate', () => {
  it('confidence table matches addendum B', () => {
    expect(JOIN_CONFIDENCE.fc).toBe(1.0)
    expect(JOIN_CONFIDENCE.curated).toBe(1.0)
    expect(JOIN_CONFIDENCE.node).toBe(0.8)
    expect(JOIN_CONFIDENCE.prefix).toBe(0.6)
    expect(JOIN_CONFIDENCE.keyword).toBe(0.4)
  })

  it('maps meditation candidates >= 60 to FEAT-MEDITATION (program-emitted lineage)', () => {
    const seed = loadProductFeaturesSeed(SEED_PATH)
    const lineagePath = path.join(WORKSPACE, '.artifact/2026-07-16-lineage/REBUILD_LINEAGE.jsonl')
    const tasks: Array<TaskJoinInput> = []
    for (const line of fs.readFileSync(lineagePath, 'utf8').split('\n')) {
      const t = line.trim()
      if (!t) continue
      tasks.push(taskJoinInputFromLineageRaw(JSON.parse(t) as Record<string, unknown>))
    }
    // Enrich nodes from contracts (same as sync plan)
    const contracts = loadFeatureContracts(path.join(WORKSPACE, 'CONTRACT/feature-contracts'))
    for (const c of contracts) {
      for (const n of (c.json.nodes as Array<Record<string, unknown>> | undefined) ?? []) {
        if (!n || typeof n !== 'object') continue
        const nodeId = n.id != null ? String(n.id) : null
        const taskId = n.task_id != null ? String(n.task_id) : null
        if (nodeId && taskId) {
          const task = tasks.find((x) => x.taskId === taskId)
          if (task && !task.nodeIds.includes(nodeId)) task.nodeIds.push(nodeId)
        }
      }
    }

    const maps = buildFeatureTaskMaps(seed, tasks)
    const candidates = meditationCandidateTaskIds(tasks)
    const check = meditationCheck(maps, candidates)

    // Program-emitted: paste-friendly expectations
    expect(candidates.length).toBeGreaterThanOrEqual(60)
    expect(check.mapped_to_feat_meditation).toBeGreaterThanOrEqual(60)
    expect(check.candidate_count).toBe(candidates.length)

    const medMaps = maps.filter((m) => m.featureId === 'FEAT-MEDITATION')
    expect(medMaps.some((m) => m.taskId === 'T-RN-WELL-MED')).toBe(true)
    expect(medMaps.some((m) => m.taskId === 'T-BE-DEP-MOD-MEDITATION-49D858')).toBe(true)
  })

  it('suite split: fasting/period not only meditation via exclusive nodes', () => {
    const seed = loadProductFeaturesSeed(SEED_PATH)
    const tasks: Array<TaskJoinInput> = [
      {
        taskId: 'T-RN-WELL-FAST',
        featureContractId: 'FC-RN-WELLNESS-SUITE',
        nodeIds: ['RN-A50-FASTING'],
        searchBlob: 'intermittent fasting puasa',
      },
      {
        taskId: 'T-RN-PERIOD',
        featureContractId: 'FC-RN-WELLNESS-SUITE',
        nodeIds: ['RN-A51-PERIOD'],
        searchBlob: 'period tracker haid',
      },
      {
        taskId: 'T-RN-WELL-MED',
        featureContractId: 'FC-RN-WELLNESS-SUITE',
        nodeIds: ['RN-P50-MEDITATION'],
        searchBlob: 'meditation meditasi',
      },
    ]
    const maps = buildFeatureTaskMaps(seed, tasks)
    const byTask = (id: string) => maps.filter((m) => m.taskId === id).map((m) => m.featureId)

    expect(byTask('T-RN-WELL-MED')).toContain('FEAT-MEDITATION')
    expect(byTask('T-RN-WELL-FAST')).toContain('FEAT-PUASA')
    expect(byTask('T-RN-PERIOD')).toContain('FEAT-SIKLUS-HAID')
  })
})

describe('product-features-store memory roundtrip', () => {
  it('upsert + listProductFeatures + getFeature360 + listUnmappedTasks', async () => {
    const mem = createMemoryProductFeaturesExecutor()
    const seed = loadProductFeaturesSeed(SEED_PATH)
    const features = seedToProductFeatureRows(seed).slice(0, 3)
    const n = await upsertProductFeatures(features, mem)
    expect(n).toBe(3)

    const listed = await listProductFeatures({}, mem)
    expect(listed.length).toBe(3)
    expect(listed.map((f) => f.featureId)).toContain(features[0]!.featureId)

    const maps = [
      {
        featureId: features[0]!.featureId,
        taskId: 'T-DEMO-1',
        joinSource: 'prefix' as const,
        confidence: 0.6,
      },
      {
        featureId: features[0]!.featureId,
        taskId: 'T-DEMO-2',
        joinSource: 'keyword' as const,
        confidence: 0.4,
      },
    ]
    await upsertFeatureTaskMaps(maps, mem)

    const f360 = await getFeature360(
      features[0]!.featureId,
      {
        lineage: [
          {
            boardId: 'mfs-rebuild',
            taskId: 'T-DEMO-1',
            disposition: 'ACTIVE',
            repository: null,
            origin: 'firm-new-blindspot',
            featureContractId: null,
            parityVerdict: 'MAPPED_100',
            acceptanceCovered: null,
            verifierModel: null,
            verifiedAt: null,
            stage1Json: {},
            evidenceJson: [],
            gapsJson: [],
            implementationJson: {},
            sourceHash: 'abc',
            syncedAt: new Date().toISOString(),
          },
        ],
      },
      mem,
    )
    expect(f360).not.toBeNull()
    expect(f360!.taskIds).toEqual(['T-DEMO-1', 'T-DEMO-2'])
    expect(f360!.rollup.parityMapped100).toBe(1)
    expect(f360!.rollup.parityTotal).toBe(1)

    const unmapped = await listUnmappedTasks(['T-DEMO-1', 'T-DEMO-2', 'T-DEMO-3'], mem)
    expect(unmapped).toEqual(['T-DEMO-3'])
  })
})

describe('product-feature sync plan dry-run (live artifacts)', () => {
  it('buildProductFeatureSyncPlan emits counts + meditation_check >= 60', () => {
    const plan = buildProductFeatureSyncPlan({
      cwd,
      workspaceRoot: WORKSPACE,
      mode: 'dry-run',
    })
    expect(plan.counts.product_features).toBeGreaterThanOrEqual(40)
    expect(plan.counts.product_features).toBeLessThanOrEqual(90)
    expect(plan.counts.feature_task_map).toBeGreaterThan(0)
    expect(plan.counts.fc_total).toBe(85)
    expect(plan.counts.fc_covered).toBe(85)
    expect(plan.counts.meditation_check.mapped_to_feat_meditation).toBeGreaterThanOrEqual(60)
    expect(plan.counts.unmapped_tasks).toBeGreaterThanOrEqual(0)
    expect(plan.counts.feature_task_map_by_join_source).toBeTruthy()

    // Memory apply roundtrip of plan
  })

  it('applyProductFeatureSyncPlan to memory executor', async () => {
    const plan = buildProductFeatureSyncPlan({
      cwd,
      workspaceRoot: WORKSPACE,
      mode: 'dry-run',
    })
    const mem = createMemoryProductFeaturesExecutor()
    const applied = await applyProductFeatureSyncPlan(plan, mem)
    expect(applied.applied.product_features).toBe(plan.features.length)
    expect(applied.applied.feature_task_map).toBe(plan.maps.length)
    const listed = await listProductFeatures({}, mem)
    expect(listed.length).toBe(plan.features.length)
  })
})
