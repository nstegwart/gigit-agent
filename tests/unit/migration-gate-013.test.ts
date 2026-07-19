/**
 * TM-AUTHOR-MIGRATION-013-CLASSIFICATION-TASK-ID-CS — non-vacuous contract for
 * ledgered path 000..013 (frozen under tip advance). Covers: exact on-disk
 * hashes (000-013 preserved), sequential production one-step 012→013,
 * fail-closed skip of 011/012, and adversarial case-distinct classification
 * task_id coexistence after 013. Product tip may be later (see migration-gate-014).
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

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
  splitSqlStatements,
  validateProductionMigrationAuthority,
  type ProductionMigrationAuthority,
} from '#/server/migrations'

const cwd = process.cwd()
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()

/** Exact on-disk SHA-256 pins for migrations/000..013 (000-012 must not drift). */
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
  '013': '96f6bc392d298f9ce72e86c6943f67c75776d7aad45cd2851d05abaeb414789d',
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

describe('manifest completeness 000..013 exact hashes (preserved under tip advance)', () => {
  it('pins exact on-disk SHA-256 for 000..013 and FORWARD_FIX 013 (tip may be later)', () => {
    // Tip advances past 013 (see migration-gate-014); this file freezes 000-013 hashes.
    expect(manifestLatestVersion() >= '013').toBe(true)
    expect(Object.keys(EXPECTED_SHA256)).toEqual([
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
      '013',
    ])
    const loaded = loadMigrationManifest(cwd)
    expect(loaded.length).toBeGreaterThanOrEqual(14)
    for (const version of Object.keys(EXPECTED_SHA256)) {
      const m = loaded.find((x) => x.version === version)!
      const disk = fs.readFileSync(path.join(cwd, m.relativePath))
      expect(m.sha256).toBe(sha256Hex(disk))
      expect(m.sha256).toBe(EXPECTED_SHA256[version])
    }
    // 000-012 hashes pinned exactly (no silent rewrite under 013 freeze)
    for (const v of Object.keys(EXPECTED_SHA256).filter((x) => x < '013')) {
      expect(EXPECTED_SHA256[v]).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(MIGRATION_MANIFEST.find((m) => m.version === '012')).toMatchObject({
      filename: '012_ultimate_map.sql',
      classification: 'REVERSIBLE',
    })
    expect(MIGRATION_MANIFEST.find((m) => m.version === '013')).toMatchObject({
      filename: '013_classification_task_id_case_sensitive.sql',
      classification: 'FORWARD_FIX_ONLY',
    })
  })

  it('offline plan orderedVersions includes 000..013 (and may continue past tip)', () => {
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      mode: 'plan',
    })
    expect(plan.status).toBe('READY')
    expect(plan.orderedVersions.slice(0, 14)).toEqual([
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
      '013',
    ])
  })

  it('013 SQL is MODIFY utf8mb4_bin only (no DROP/TRUNCATE/data rewrite)', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '013')!
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    expect(sql).toMatch(
      /ALTER TABLE control_plane_classification\s+MODIFY COLUMN task_id VARCHAR\(160\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/i,
    )
    expect(sql).toMatch(
      /ALTER TABLE control_plane_classification_receipts\s+MODIFY COLUMN task_id VARCHAR\(160\) CHARACTER SET utf8mb4 COLLATE utf8mb4_bin NOT NULL/i,
    )
    expect(sql).toMatch(/Precondition/i)
    expect(sql).toMatch(/FORWARD_FIX_ONLY/)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    expect(stmts).toHaveLength(2)
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
      expect(s).not.toMatch(/\bdelete\s+from\b/)
      expect(s).not.toMatch(/\bupdate\s+control_plane_classification\b/)
    }
  })
})

describe('health required tables through 013 (013 is ALTER-only)', () => {
  it('013 has no CREATE TABLE probe; 012 tables still required when history claims 012', () => {
    expect(REQUIRED_TABLES_BY_MIGRATION['013']).toBeUndefined()
    expect(REQUIRED_TABLES_BY_MIGRATION['012']).toEqual([
      'app_pages',
      'api_endpoints',
      'page_api_calls',
      'nav_edges',
      'knowledge_aliases',
    ])
    const tables = requiredTablesForAppliedVersions([
      '004',
      '005',
      '008',
      '009',
      '010',
      '011',
      '012',
      '013',
    ])
    for (const t of REQUIRED_TABLES_BY_MIGRATION['012']!) {
      expect(tables).toContain(t)
    }
    expect(tables).toContain('control_plane_classification_receipts')
  })
})

describe('production sequential one-step approval 012→013', () => {
  it('applies only the exact next approved version (013) after 012 history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-013-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump for one-step 013\n')
    try {
      const authority = makeAuthority('013', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('012'))
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
      expect(result.applied).toEqual(['013'])
      expect(exec.history.map((h) => h.version)).toContain('013')
      expect(exec.history.map((h) => h.version).filter((v) => v === '013')).toHaveLength(1)
      // Statements include both MODIFY targets
      expect(
        exec.statements.some((s) =>
          /control_plane_classification[\s\S]*utf8mb4_bin/i.test(s),
        ),
      ).toBe(true)
      expect(
        exec.statements.some((s) =>
          /control_plane_classification_receipts[\s\S]*utf8mb4_bin/i.test(s),
        ),
      ).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects skip (approve 013 when next pending is 011)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-013-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('013', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('010'))
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

  it('rejects skip (approve 013 when next pending is 012)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-013-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('013', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('011'))
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
      expect(result.error).toMatch(/012/)
      expect(exec.statements).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects wrong migration hash for 013 authority binding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-013-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const migration = loadMigrationManifest(cwd).find((m) => m.version === '013')!
      const authority = makeAuthority('013', backup, {
        migrationSha256: 'b'.repeat(64),
      })
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

  it('LOCAL --through 013 after 012 applies only 013', async () => {
    const exec = createMemoryMigrationExecutor(historyThrough('012'))
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
      throughVersion: '013',
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual(['013'])
  })

  it('LOCAL --through 012 after 011 does not apply 013', async () => {
    const exec = createMemoryMigrationExecutor(historyThrough('011'))
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
      throughVersion: '012',
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual(['012'])
    expect(exec.history.map((h) => h.version)).not.toContain('013')
  })
})

// ---------------------------------------------------------------------------
// Adversarial: case-distinct task IDs coexist after 013 (MySQL when available)
// ---------------------------------------------------------------------------

const UPPER = 'T-AFFILIATE-ASSET-LIBRARY-PUBLISHING'
const LOWER = 'T-AFFILIATE-asset-library-publishing'
const BOARD = 'mfs-rebuild-adversarial-013'

type AdvCtx = {
  database: string
  host: string
  available: boolean
}

const adv: AdvCtx = {
  database: `cairn_mig_013_cs_${process.pid}_${Date.now()}`,
  host: '127.0.0.1',
  available: false,
}

async function openAdmin() {
  return mysql.createConnection({
    host: adv.host,
    port: 3306,
    user: process.env.CAIRN_DB_USER || 'root',
    password: process.env.CAIRN_DB_PASSWORD || '',
    multipleStatements: true,
    connectTimeout: 3000,
  })
}

async function probeMysql(): Promise<boolean> {
  if (process.env.CAIRN_MIGRATE_IT === '0') return false
  try {
    const conn = await openAdmin()
    await conn.query('SELECT 1')
    await conn.end()
    return true
  } catch {
    return false
  }
}

/** Minimal pre-013 classification tables (CI collation) + receipts. */
const PRE_013_DDL = `
CREATE TABLE control_plane_classification (
  board_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  classification_receipt_id VARCHAR(64) NULL,
  classification_receipt_hash CHAR(64) NULL,
  proof_source VARCHAR(160) NULL,
  board_rev BIGINT UNSIGNED NULL,
  entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  receipt_json JSON NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, task_id),
  KEY idx_class_task_class (board_id, task_class, disposition),
  KEY idx_class_receipt (board_id, classification_receipt_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE control_plane_classification_receipts (
  board_id VARCHAR(64) NOT NULL,
  receipt_id VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NOT NULL,
  receipt_hash CHAR(64) NOT NULL,
  task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
  membership_portfolio_id VARCHAR(160) NULL,
  membership_proof_hash CHAR(64) NULL,
  canonical_snapshot_id VARCHAR(64) NOT NULL,
  canonical_hash CHAR(64) NOT NULL,
  task_hash CHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL,
  lifecycle_rev BIGINT UNSIGNED NOT NULL,
  issued_at DATETIME(3) NOT NULL,
  expires_at DATETIME(3) NULL,
  receipt_json JSON NOT NULL,
  created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id, receipt_id),
  KEY idx_class_receipt_task (board_id, task_id),
  KEY idx_class_receipt_hash (board_id, receipt_hash)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE schema_migrations (
  version VARCHAR(64) NOT NULL,
  filename VARCHAR(255) NOT NULL,
  sha256 CHAR(64) NOT NULL,
  classification VARCHAR(64) NOT NULL,
  applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
  applied_by VARCHAR(160) NULL,
  dry_run TINYINT(1) NOT NULL DEFAULT 0,
  PRIMARY KEY (version),
  UNIQUE KEY uq_schema_migrations_filename (filename)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

describe('adversarial case-distinct classification task_id after 013', () => {
  beforeAll(async () => {
    adv.available = await probeMysql()
    if (!adv.available) return
    const conn = await openAdmin()
    try {
      await conn.query(
        `CREATE DATABASE \`${adv.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${adv.database}\``)
      await conn.query(PRE_013_DDL)
      // Seed lower overlay row + both receipt casings (archive already allows both)
      await conn.query(
        `INSERT INTO control_plane_classification
           (board_id, task_id, task_class, disposition, board_rev, entity_rev, receipt_json)
         VALUES (?, ?, 'PRODUCT', 'ACTIVE', 5845, 3, ?)`,
        [
          BOARD,
          LOWER,
          JSON.stringify({ taskId: UPPER, taskClass: 'PRODUCT', disposition: 'ACTIVE' }),
        ],
      )
      await conn.query(
        `INSERT INTO control_plane_classification_receipts
           (board_id, receipt_id, task_id, receipt_hash, task_class, disposition,
            canonical_snapshot_id, canonical_hash, task_hash, board_rev, lifecycle_rev,
            issued_at, receipt_json)
         VALUES
           (?, 'class-v3-lower', ?, REPEAT('a', 64), 'PRODUCT', 'ACTIVE',
            'snap', REPEAT('b', 64), REPEAT('c', 64), 5845, 1, NOW(3), ?),
           (?, 'class-v3-upper', ?, REPEAT('d', 64), 'PRODUCT', 'ACTIVE',
            'snap', REPEAT('e', 64), REPEAT('f', 64), 5845, 1, NOW(3), ?)`,
        [
          BOARD,
          LOWER,
          JSON.stringify({ taskId: LOWER }),
          BOARD,
          UPPER,
          JSON.stringify({ taskId: UPPER }),
        ],
      )
    } finally {
      await conn.end()
    }
  }, 30_000)

  afterAll(async () => {
    if (!adv.available) return
    const conn = await openAdmin()
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${adv.database}\``)
    } finally {
      await conn.end()
    }
  }, 15_000)

  it('pre-013 CI PK collapses case-distinct inserts; 013 enables coexistence + preserves rows', async () => {
    if (!adv.available) {
      console.warn('SKIP adversarial 013 MySQL: local MySQL not reachable')
      return
    }
    const conn = await mysql.createConnection({
      host: adv.host,
      port: 3306,
      user: process.env.CAIRN_DB_USER || 'root',
      password: process.env.CAIRN_DB_PASSWORD || '',
      database: adv.database,
      connectTimeout: 5000,
    })
    try {
      // Precondition: CI equality collapses UPPER vs lower
      const [eqRows] = await conn.query(
        `SELECT (? = ?) AS eq_ci, (BINARY ? = BINARY ?) AS eq_bin`,
        [UPPER, LOWER, UPPER, LOWER],
      )
      const eq = (eqRows as Array<{ eq_ci: number; eq_bin: number }>)[0]!
      expect(Number(eq.eq_ci)).toBe(1)
      expect(Number(eq.eq_bin)).toBe(0)

      // Pre-013: second casing cannot insert (duplicate PK under CI)
      await expect(
        conn.query(
          `INSERT INTO control_plane_classification
             (board_id, task_id, task_class, disposition, board_rev, entity_rev)
           VALUES (?, ?, 'PRODUCT', 'ACTIVE', 5845, 3)`,
          [BOARD, UPPER],
        ),
      ).rejects.toMatchObject({ errno: 1062 })

      // Apply 013 SQL statements only (table already present; history simulated)
      const m013 = loadMigrationManifest(cwd).find((m) => m.version === '013')!
      for (const stmt of m013.statements) {
        await conn.query(stmt)
      }
      await conn.query(
        `INSERT INTO schema_migrations (version, filename, sha256, classification, dry_run)
         VALUES (?, ?, ?, ?, 0)`,
        [m013.version, m013.filename, m013.sha256, m013.classification],
      )

      // Collation is binary
      const [colRows] = await conn.query(
        `SELECT TABLE_NAME AS t, COLUMN_NAME AS c, COLLATION_NAME AS coll
         FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND COLUMN_NAME = 'task_id'
           AND TABLE_NAME IN ('control_plane_classification', 'control_plane_classification_receipts')
         ORDER BY t`,
        [adv.database],
      )
      for (const row of colRows as Array<{ t: string; coll: string }>) {
        expect(row.coll).toBe('utf8mb4_bin')
      }

      // Prior lower row intact
      const [prior] = await conn.query(
        `SELECT task_id, task_class, disposition,
                JSON_UNQUOTE(JSON_EXTRACT(receipt_json, '$.taskId')) AS receipt_task_id
         FROM control_plane_classification WHERE board_id = ?`,
        [BOARD],
      )
      const priorRows = prior as Array<{
        task_id: string
        task_class: string
        disposition: string
        receipt_task_id: string
      }>
      expect(priorRows).toHaveLength(1)
      expect(priorRows[0]!.task_id).toBe(LOWER)
      expect(priorRows[0]!.task_class).toBe('PRODUCT')
      expect(priorRows[0]!.disposition).toBe('ACTIVE')
      expect(priorRows[0]!.receipt_task_id).toBe(UPPER)

      // Case-distinct UPPER now inserts alongside lower
      await conn.query(
        `INSERT INTO control_plane_classification
           (board_id, task_id, task_class, disposition, board_rev, entity_rev, receipt_json)
         VALUES (?, ?, 'PRODUCT', 'ACTIVE', 5845, 3, ?)`,
        [BOARD, UPPER, JSON.stringify({ taskId: UPPER, taskClass: 'PRODUCT' })],
      )

      const [both] = await conn.query(
        `SELECT task_id FROM control_plane_classification
         WHERE board_id = ? ORDER BY task_id COLLATE utf8mb4_bin`,
        [BOARD],
      )
      const ids = (both as Array<{ task_id: string }>).map((r) => r.task_id)
      expect(ids).toEqual([UPPER, LOWER].sort((a, b) => (a < b ? -1 : a > b ? 1 : 0)))
      // Binary-distinct count is 2
      const [counts] = await conn.query(
        `SELECT COUNT(*) AS n,
                COUNT(DISTINCT task_id) AS dist,
                COUNT(DISTINCT BINARY task_id) AS dist_bin
         FROM control_plane_classification WHERE board_id = ?`,
        [BOARD],
      )
      const c = (counts as Array<{ n: number; dist: number; dist_bin: number }>)[0]!
      expect(Number(c.n)).toBe(2)
      expect(Number(c.dist)).toBe(2)
      expect(Number(c.dist_bin)).toBe(2)

      // Receipt archive rows remain intact (both casings)
      const [receipts] = await conn.query(
        `SELECT receipt_id, task_id FROM control_plane_classification_receipts
         WHERE board_id = ? ORDER BY receipt_id`,
        [BOARD],
      )
      const recs = receipts as Array<{ receipt_id: string; task_id: string }>
      expect(recs).toHaveLength(2)
      expect(recs.map((r) => r.task_id).sort()).toEqual([LOWER, UPPER].sort())

      // Re-apply 013 statements is idempotent (no error)
      for (const stmt of m013.statements) {
        await conn.query(stmt)
      }
      const [still] = await conn.query(
        `SELECT COUNT(*) AS n FROM control_plane_classification WHERE board_id = ?`,
        [BOARD],
      )
      expect(Number((still as Array<{ n: number }>)[0]!.n)).toBe(2)
    } finally {
      await conn.end()
    }
  }, 60_000)

  it('unit contract: memory apply of 013 after 012 is exactly one next step', async () => {
    // Always-on layer (no MySQL): runner one-step + SQL payload integrity
    const loaded = loadMigrationManifest(cwd)
    const m012 = loaded.find((m) => m.version === '012')!
    const m013 = loaded.find((m) => m.version === '013')!
    expect(m012.sha256).toBe(EXPECTED_SHA256['012'])
    expect(m013.sha256).toBe(EXPECTED_SHA256['013'])
    expect(m013.statements).toHaveLength(2)

    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: historyThrough('012'),
      cwd,
    })
    expect(plan.status).toBe('READY')
    const pending = plan.items.filter((i) => i.action === 'APPLY')
    // After 012 the next apply is always 013; tip may continue (014+) after that.
    expect(pending[0]!.version).toBe('013')
    expect(pending.map((i) => i.version)).toContain('013')

    const skipPlan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: historyThrough('010'),
      cwd,
    })
    const skipPending = skipPlan.items.filter((i) => i.action === 'APPLY')
    expect(skipPending[0]!.version).toBe('011')
    expect(skipPending.map((i) => i.version)).toContain('012')
    expect(skipPending.map((i) => i.version)).toContain('013')
    // Tip may continue past 013; one-step 013 contract still holds for next=011 history
  })
})
