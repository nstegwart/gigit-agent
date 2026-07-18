/**
 * TM-IMPL-MIGRATION-GATE-012 — non-vacuous contract for ledgered path 000..012.
 * Covers: exact on-disk hashes, health table requirements, sequential production
 * one-step approval, and fail-closed rejection of skip / wrong hash / wrong
 * filename binding / stale dump / wrong DB.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  REQUIRED_TABLES_BY_MIGRATION,
  requiredTablesForAppliedVersions,
} from '#/routes/api.healthz'
import {
  MIGRATION_MANIFEST,
  applyMigrations,
  createMemoryMigrationExecutor,
  g0IdentityLifecycleMappingRows,
  loadMigrationManifest,
  manifestLatestVersion,
  planMigrations,
  sha256Hex,
  validateProductionMigrationAuthority,
  type ProductionMigrationAuthority,
} from '#/server/migrations'

const cwd = process.cwd()
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()

/** Exact on-disk SHA-256 pins for migrations/000..012 (recomputed from files). */
const EXPECTED_SHA256: Readonly<Record<string, string>> = {
  '000': 'f009035b13b2dbb9931e8e59b5e43c31f730dc564a1f41e9ee7dc514a409ac12',
  '001': '9a2853392d458afd2ea8359c15916f3b8f173e8aee9c044328ffef1e90b68d7b',
  '002': '27222d4688259d7ed6ae4de605b8dad64499c4160eabcc2411c549df3229da72',
  '003': 'cca909e4c5009d9dfde515a2792c96af82593f0f70e3e2bef565feac35d15e13',
  '004': '82205fde2300ecf9e8fa8c3591fabc6e2c963abc21b16a39386f595819dbbb48',
  '005': 'aefc61dd34a054b6f84278cf80d2db283efd5832b5804af21ad150d28651b27c',
  '006': '8cf35c2652ee25ec3e8ec7fd52cf5c4991ce81ee4ec87c52e33f100a8b56d97d',
  '007': 'd49f4c5767ae81f0abfc9f60982aebbcfb8fa5733c013ce8709cba7d2684f4c7',
  '008': '385ca63ed551622439a7e722a2017bc7452356c1f25035e15f6161f33fc73940',
  '009': '5af6145a49b6317cddf150f1188c0147db1ccac3187d039e9e07d1f04d39e639',
  '010': '1b7ff33cd40ee821f22f8952f91c6ad9d890560caad6a1c25c2f4d0efa3728d7',
  '011': '8ce2567ebb65ed3971dbabef995e5e5cfbb8724eb381a91557ce90420a620568',
  '012': 'ad6acb1631fc23287b4540ecc9326e9dc82702257fd5576d72d7e88dbcbc33db',
}

function historyThrough(version: string) {
  return loadMigrationManifest(cwd)
    .filter((m) => m.version <= version)
    .map((m) => ({
      version: m.version,
      filename: m.filename,
      sha256: m.sha256,
      classification: m.classification,
    }))
}

function makeAuthority(
  version: string,
  backupPath: string,
  overrides: Partial<ProductionMigrationAuthority> = {},
): ProductionMigrationAuthority {
  const migration = loadMigrationManifest(cwd).find((m) => m.version === version)!
  const base: ProductionMigrationAuthority = {
    releaseSha: 'a'.repeat(40),
    approvalId: `owner-one-step-${version}`,
    migrationVersion: version,
    migrationSha256: migration.sha256,
    targetHost: 'db.production.internal',
    targetDatabase: 'cairn_taskmanager',
    backupReceiptPath: backupPath,
    backupSha256: sha256Hex(fs.readFileSync(backupPath)),
    approvalBinding: '',
    maxBackupAgeHours: 24,
    ...overrides,
  }
  if (!overrides.approvalBinding) {
    base.approvalBinding = sha256Hex(
      [
        base.releaseSha,
        base.approvalId,
        base.migrationVersion,
        base.migrationSha256,
        base.targetHost,
        base.targetDatabase,
        base.backupSha256,
      ].join('\0'),
    )
  }
  return base
}

describe('manifest completeness 000..012 + exact hashes', () => {
  it('registers ordered 000..012 with exact on-disk SHA-256 and REVERSIBLE 011/012', () => {
    expect(manifestLatestVersion()).toBe('012')
    expect(MIGRATION_MANIFEST.map((m) => m.version)).toEqual(Object.keys(EXPECTED_SHA256))
    const loaded = loadMigrationManifest(cwd)
    expect(loaded).toHaveLength(13)
    for (const m of loaded) {
      const disk = fs.readFileSync(path.join(cwd, m.relativePath))
      expect(m.sha256).toBe(sha256Hex(disk))
      expect(m.sha256).toBe(EXPECTED_SHA256[m.version])
    }
    expect(MIGRATION_MANIFEST.find((m) => m.version === '011')).toMatchObject({
      filename: '011_feature_flow_edges.sql',
      classification: 'REVERSIBLE',
    })
    expect(MIGRATION_MANIFEST.find((m) => m.version === '012')).toMatchObject({
      filename: '012_ultimate_map.sql',
      classification: 'REVERSIBLE',
    })
  })

  it('offline plan orderedVersions is 000..012', () => {
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      mode: 'plan',
    })
    expect(plan.status).toBe('READY')
    expect(plan.orderedVersions).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
      '009',
      '010',
      '011',
      '012',
    ])
  })
})

/** Extract CREATE TABLE IF NOT EXISTS names from a migration SQL file. */
function createTableNamesFromSql(sql: string): string[] {
  const names: string[] = []
  const re = /CREATE\s+TABLE\s+IF\s+NOT\s+EXISTS\s+`?([a-z0-9_]+)`?/gi
  let m: RegExpExecArray | null
  while ((m = re.exec(sql)) !== null) {
    names.push(m[1]!)
  }
  return names
}

describe('health required tables 005 + 009..012', () => {
  it('lists complete CREATE TABLE set for 005 (all 14 objects from migrations/005_*.sql)', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '005')!
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    const fromSql = createTableNamesFromSql(sql)
    expect(fromSql).toHaveLength(14)
    expect(REQUIRED_TABLES_BY_MIGRATION['005']).toEqual(fromSql)
    expect(REQUIRED_TABLES_BY_MIGRATION['005']).toEqual([
      'control_plane_dispatch_plans',
      'control_plane_dispatch_plan_items',
      'control_plane_runs',
      'control_plane_collision_locks',
      'control_plane_integration_locks',
      'control_plane_account_snapshots',
      'control_plane_account_readbacks',
      'control_plane_reconciler_leaders',
      'control_plane_reconciler_dryruns',
      'control_plane_reconciler_apply',
      'control_plane_reconciler_task_flags',
      'control_plane_retention_policies',
      'control_plane_retention_hot_state',
      'control_plane_retention_audit_sample',
    ])
  })

  it('lists complete CREATE TABLE sets for 009, 010, 011, 012', () => {
    expect(REQUIRED_TABLES_BY_MIGRATION['009']).toEqual([
      'rebuild_lineage_records',
      'parity_rollups',
      'feature_units',
      'feature_directory',
    ])
    expect(REQUIRED_TABLES_BY_MIGRATION['010']).toEqual([
      'product_features',
      'feature_task_map',
    ])
    expect(REQUIRED_TABLES_BY_MIGRATION['011']).toEqual([
      'app_flow_nodes',
      'app_flow_edges',
    ])
    expect(REQUIRED_TABLES_BY_MIGRATION['012']).toEqual([
      'app_pages',
      'api_endpoints',
      'page_api_calls',
      'nav_edges',
      'knowledge_aliases',
    ])
    // Every listed table appears in the corresponding SQL (no partial probe fiction).
    for (const version of ['009', '010', '011', '012'] as const) {
      const entry = MIGRATION_MANIFEST.find((m) => m.version === version)!
      const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
      for (const table of REQUIRED_TABLES_BY_MIGRATION[version]!) {
        expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
      }
    }
  })

  it('requiredTablesForAppliedVersions unions complete per-version sets through 012', () => {
    const tables = requiredTablesForAppliedVersions([
      '005',
      '008',
      '009',
      '010',
      '011',
      '012',
    ])
    expect(tables).toEqual(
      expect.arrayContaining([
        ...REQUIRED_TABLES_BY_MIGRATION['005']!,
        ...REQUIRED_TABLES_BY_MIGRATION['008']!,
        ...REQUIRED_TABLES_BY_MIGRATION['009']!,
        ...REQUIRED_TABLES_BY_MIGRATION['010']!,
        ...REQUIRED_TABLES_BY_MIGRATION['011']!,
        ...REQUIRED_TABLES_BY_MIGRATION['012']!,
      ]),
    )
    // No silent drop of 012 tables when history claims 012.
    for (const t of REQUIRED_TABLES_BY_MIGRATION['012']!) {
      expect(tables).toContain(t)
    }
    // 005 residual tables must be required when history claims 005.
    expect(tables).toContain('control_plane_retention_policies')
    expect(tables).toContain('control_plane_dispatch_plan_items')
  })
})

describe('production sequential one-step approval', () => {
  it('applies only the exact next approved version (008) leaving 009..012 pending', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump for one-step 008\n')
    try {
      const authority = makeAuthority('008', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('007'))
      const result = await applyMigrations({
        host: authority.targetHost,
        hostClass: 'PRODUCTION',
        database: authority.targetDatabase,
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
        productionAuthority: authority,
      })
      expect(result.ok).toBe(true)
      expect(result.applied).toEqual(['008'])
      expect(exec.history.map((h) => h.version)).not.toContain('009')
      expect(exec.history.map((h) => h.version)).not.toContain('012')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('applies one-step 011 after 010 history without advancing to 012', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump for one-step 011\n')
    try {
      const authority = makeAuthority('011', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('010'))
      const result = await applyMigrations({
        host: authority.targetHost,
        hostClass: 'PRODUCTION',
        database: authority.targetDatabase,
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
        productionAuthority: authority,
        throughVersion: '011',
      })
      expect(result.ok).toBe(true)
      expect(result.applied).toEqual(['011'])
      expect(exec.history.map((h) => h.version)).toContain('011')
      expect(exec.history.map((h) => h.version)).not.toContain('012')
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects skip (approve 010 when next pending is 008)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('010', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('007'))
      const result = await applyMigrations({
        host: authority.targetHost,
        hostClass: 'PRODUCTION',
        database: authority.targetDatabase,
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
        productionAuthority: authority,
      })
      expect(result.ok).toBe(false)
      expect(result.applied).toEqual([])
      expect(result.error).toMatch(/one-step|skip|next pending/i)
      expect(exec.statements).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects wrong migration hash (authority binding fails)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const migration = loadMigrationManifest(cwd).find((m) => m.version === '009')!
      const authority = makeAuthority('009', backup, {
        migrationSha256: 'b'.repeat(64),
      })
      // Recompute binding with wrong hash so binding itself can still match wrong hash...
      authority.approvalBinding = sha256Hex(
        [
          authority.releaseSha,
          authority.approvalId,
          authority.migrationVersion,
          authority.migrationSha256,
          authority.targetHost,
          authority.targetDatabase,
          authority.backupSha256,
        ].join('\0'),
      )
      expect(
        validateProductionMigrationAuthority(authority, {
          host: authority.targetHost,
          database: authority.targetDatabase,
          migration,
        }),
      ).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects wrong filename/version binding (authority version not matching migration entry)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const migration008 = loadMigrationManifest(cwd).find((m) => m.version === '008')!
      const authority = makeAuthority('009', backup)
      expect(
        validateProductionMigrationAuthority(authority, {
          host: authority.targetHost,
          database: authority.targetDatabase,
          migration: migration008,
        }),
      ).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects stale dump (mtime older than maxBackupAgeHours)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- stale dump\n')
    const old = Date.now() - 48 * 3600 * 1000
    fs.utimesSync(backup, new Date(old), new Date(old))
    try {
      const migration = loadMigrationManifest(cwd).find((m) => m.version === '008')!
      const authority = makeAuthority('008', backup, { maxBackupAgeHours: 24 })
      expect(
        validateProductionMigrationAuthority(authority, {
          host: authority.targetHost,
          database: authority.targetDatabase,
          migration,
          nowMs: Date.now(),
        }),
      ).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects wrong DB target host/database', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-012-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- dump\n')
    try {
      const migration = loadMigrationManifest(cwd).find((m) => m.version === '008')!
      const authority = makeAuthority('008', backup)
      expect(
        validateProductionMigrationAuthority(authority, {
          host: 'other-host.internal',
          database: authority.targetDatabase,
          migration,
        }),
      ).toBe(false)
      expect(
        validateProductionMigrationAuthority(authority, {
          host: authority.targetHost,
          database: 'wrong_db',
          migration,
        }),
      ).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('LOCAL --through applies only through the requested version', async () => {
    const exec = createMemoryMigrationExecutor(historyThrough('010'))
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
      throughVersion: '011',
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual(['011'])
    expect(exec.history.map((h) => h.version)).not.toContain('012')
  })
})
