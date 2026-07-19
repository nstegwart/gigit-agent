/**
 * TM-AUTHOR-MIGRATION-014-CP0-BACKLOG-SOURCES — non-vacuous contract for
 * ledgered path 000..014. Covers: exact on-disk hashes (000-013 preserved),
 * sequential production one-step 013→014, fail-closed skip from 010/011/012,
 * DDL exact tables/columns/status CHECKs/indexes, no UPDATE/DELETE/TRUNCATE,
 * no sink zeros / no backfill, health required tables, and optional disposable
 * MySQL apply when safely available.
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

/** Exact on-disk SHA-256 pins for migrations/000..014 (000-013 must not drift). */
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
  '014': '56d97d15e1d3047d7da6f78707ba16c11182f5c03791f5227c3d84f3c381ceb0',
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

describe('manifest completeness 000..014 + exact hashes', () => {
  it('registers ordered 000..014 with preserved 000-013 hashes and REVERSIBLE 014', () => {
    expect(manifestLatestVersion()).toBe('014')
    expect(MIGRATION_MANIFEST.map((m) => m.version)).toEqual(Object.keys(EXPECTED_SHA256))
    const loaded = loadMigrationManifest(cwd)
    expect(loaded).toHaveLength(15)
    for (const m of loaded) {
      const disk = fs.readFileSync(path.join(cwd, m.relativePath))
      expect(m.sha256).toBe(sha256Hex(disk))
      expect(m.sha256).toBe(EXPECTED_SHA256[m.version])
    }
    for (const v of Object.keys(EXPECTED_SHA256).filter((x) => x < '014')) {
      expect(EXPECTED_SHA256[v]).toMatch(/^[a-f0-9]{64}$/)
    }
    expect(MIGRATION_MANIFEST.find((m) => m.version === '013')).toMatchObject({
      filename: '013_classification_task_id_case_sensitive.sql',
      classification: 'FORWARD_FIX_ONLY',
    })
    expect(MIGRATION_MANIFEST.find((m) => m.version === '014')).toMatchObject({
      filename: '014_cp0_sync_backlog_sources.sql',
      classification: 'REVERSIBLE',
    })
  })

  it('offline plan orderedVersions is 000..014', () => {
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
      '013',
      '014',
    ])
  })

  it('014 SQL is additive CREATE only (no DROP/TRUNCATE/UPDATE/DELETE/sink zeros)', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '014')!
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS control_plane_sync_outbox/i)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS control_plane_legacy_residuals/i)
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*board_id\s*,\s*outbox_id\s*\)/i)
    expect(sql).toMatch(/PRIMARY KEY\s*\(\s*board_id\s*,\s*residual_id\s*\)/i)
    expect(sql).toMatch(/uq_cp0_outbox_idempotency/i)
    expect(sql).toMatch(/uq_cp0_legacy_idempotency/i)
    expect(sql).toMatch(/uq_cp0_legacy_receipt_hash/i)
    expect(sql).toMatch(/idx_cp0_outbox_status/i)
    expect(sql).toMatch(/idx_cp0_outbox_claim/i)
    expect(sql).toMatch(/idx_cp0_legacy_status/i)
    expect(sql).toMatch(
      /status IN\s*\(\s*'PENDING'\s*,\s*'IN_FLIGHT'\s*,\s*'ACKED'\s*,\s*'FAILED'\s*,\s*'DEAD'\s*\)/i,
    )
    expect(sql).toMatch(
      /status IN\s*\(\s*'UNREPLAYED'\s*,\s*'REPLAYING'\s*,\s*'REPLAYED'\s*,\s*'ABANDONED'\s*\)/i,
    )
    // Pin binding present on both tables
    expect(sql).toMatch(/board_rev BIGINT UNSIGNED NOT NULL/)
    expect(sql).toMatch(/lifecycle_rev BIGINT UNSIGNED NOT NULL/)
    expect(sql).toMatch(/canonical_hash CHAR\(64\) NOT NULL/)
    // Outbox timestamps + attempt/error metadata (bounded, no secrets)
    expect(sql).toMatch(/enqueued_at DATETIME\(3\)/)
    expect(sql).toMatch(/acked_at DATETIME\(3\) NULL/)
    expect(sql).toMatch(/next_attempt_at DATETIME\(3\) NULL/)
    expect(sql).toMatch(/attempt_count INT UNSIGNED NOT NULL DEFAULT 0/)
    expect(sql).toMatch(/last_error_code VARCHAR\(64\) NULL/)
    // Legacy residual timestamps + identity
    expect(sql).toMatch(/discovered_at DATETIME\(3\)/)
    expect(sql).toMatch(/replayed_at DATETIME\(3\) NULL/)
    expect(sql).toMatch(/receipt_hash CHAR\(64\) NOT NULL/)
    expect(sql).toMatch(/run_id VARCHAR\(160\) NULL/)
    // No destructive DML / sink zero invent (checked on executable statements)
    expect(sql).not.toMatch(/outbox_pending\s*=\s*0/i)
    expect(sql).not.toMatch(/legacy_unreplayed\s*=\s*0/i)
    expect(sql).not.toMatch(/effective_backlog\s*=\s*0/i)
    // Sink table name may appear in header comments as non-mutation reference only
    expect(sql).toMatch(/does NOT backfill/i)
    // Pending COUNT documentation (future measurer; not a zero claim)
    expect(sql).toMatch(/PENDING.*IN_FLIGHT.*FAILED/i)
    expect(sql).toMatch(/UNREPLAYED.*REPLAYING/i)
    expect(sql).toMatch(/REVERSIBLE/)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    expect(stmts).toHaveLength(2)
    for (const s of stmts) {
      expect(s).toMatch(/create table if not exists/)
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
      expect(s).not.toMatch(/\bdelete\s+from\b/)
      expect(s).not.toMatch(/\binsert\s+into\b/)
      // ON UPDATE CURRENT_TIMESTAMP is a column default clause, not DML UPDATE <table>
      expect(s).not.toMatch(/\bupdate\s+(?!current_timestamp)/)
    }
  })
})

describe('health required tables through 014', () => {
  it('014 probes both backlog source tables; 013 remains ALTER-only', () => {
    expect(REQUIRED_TABLES_BY_MIGRATION['013']).toBeUndefined()
    expect(REQUIRED_TABLES_BY_MIGRATION['014']).toEqual([
      'control_plane_sync_outbox',
      'control_plane_legacy_residuals',
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
      '014',
    ])
    expect(tables).toContain('control_plane_sync_outbox')
    expect(tables).toContain('control_plane_legacy_residuals')
    expect(tables).toContain('control_plane_sync_status')
    expect(tables).toContain('control_plane_classification_receipts')
  })
})

describe('production sequential one-step approval 013→014', () => {
  it('applies only the exact next approved version (014) after 013 history', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-014-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump for one-step 014\n')
    try {
      const authority = makeAuthority('014', backup)
      const exec = createMemoryMigrationExecutor(historyThrough('013'))
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
      expect(result.applied).toEqual(['014'])
      expect(exec.history.map((h) => h.version)).toContain('014')
      expect(exec.history.map((h) => h.version).filter((v) => v === '014')).toHaveLength(1)
      expect(
        exec.statements.some((s) => /control_plane_sync_outbox/i.test(s)),
      ).toBe(true)
      expect(
        exec.statements.some((s) => /control_plane_legacy_residuals/i.test(s)),
      ).toBe(true)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects skip (approve 014 when next pending is 011)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-014-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('014', backup)
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

  it('rejects skip (approve 014 when next pending is 012)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-014-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('014', backup)
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

  it('rejects skip (approve 014 when next pending is 013)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-014-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const authority = makeAuthority('014', backup)
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
      expect(result.ok).toBe(false)
      expect(result.applied).toEqual([])
      expect(result.error).toMatch(/one-step|skip|next pending/i)
      expect(result.error).toMatch(/013/)
      expect(exec.statements).toHaveLength(0)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })

  it('rejects wrong migration hash for 014 authority binding', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mig-gate-014-'))
    const backup = path.join(dir, 'dump.sql')
    fs.writeFileSync(backup, '-- fresh dump\n')
    try {
      const migration = loadMigrationManifest(cwd).find((m) => m.version === '014')!
      const authority = makeAuthority('014', backup, {
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

  it('LOCAL --through 014 after 013 applies only 014', async () => {
    const exec = createMemoryMigrationExecutor(historyThrough('013'))
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
      throughVersion: '014',
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual(['014'])
  })

  it('LOCAL --through 013 after 012 does not apply 014', async () => {
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
    expect(exec.history.map((h) => h.version)).not.toContain('014')
  })
})

// ---------------------------------------------------------------------------
// Optional disposable MySQL: apply 014 DDL and prove empty tables + CHECKs
// Empty tables are possible but do not claim proven zero until a real measurer.
// ---------------------------------------------------------------------------

type AdvCtx = {
  database: string
  host: string
  available: boolean
}

const adv: AdvCtx = {
  database: `cairn_mig_014_bl_${process.pid}_${Date.now()}`,
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

describe('adversarial 014 backlog source tables (MySQL when available)', () => {
  beforeAll(async () => {
    adv.available = await probeMysql()
    if (!adv.available) return
    const conn = await openAdmin()
    try {
      await conn.query(
        `CREATE DATABASE \`${adv.database}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${adv.database}\``)
      await conn.query(`
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
`)
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

  it('applies 014 DDL: empty tables, status CHECK, unique idempotency; no sink zero claim', async () => {
    if (!adv.available) {
      console.warn('SKIP adversarial 014 MySQL: local MySQL not reachable')
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
      const m014 = loadMigrationManifest(cwd).find((m) => m.version === '014')!
      expect(m014.sha256).toBe(EXPECTED_SHA256['014'])
      for (const stmt of m014.statements) {
        await conn.query(stmt)
      }
      await conn.query(
        `INSERT INTO schema_migrations (version, filename, sha256, classification, dry_run)
         VALUES (?, ?, ?, ?, 0)`,
        [m014.version, m014.filename, m014.sha256, m014.classification],
      )

      // Tables exist and are empty (possible empty ≠ proven zero measurer claim)
      for (const table of [
        'control_plane_sync_outbox',
        'control_plane_legacy_residuals',
      ] as const) {
        const [cnt] = await conn.query(
          `SELECT COUNT(*) AS n FROM \`${table}\``,
        )
        expect(Number((cnt as Array<{ n: number }>)[0]!.n)).toBe(0)
      }

      // Valid outbox row inserts
      await conn.query(
        `INSERT INTO control_plane_sync_outbox
           (board_id, outbox_id, status, idempotency_key, event_type, subject_hash,
            board_rev, lifecycle_rev, canonical_hash, record_json)
         VALUES (?, ?, 'PENDING', ?, 'BOARD_PIN', REPEAT('a', 64), 1, 1, REPEAT('b', 64), ?)`,
        ['board-a', 'ob-1', 'idem-1', JSON.stringify({ kind: 'test' })],
      )
      // Invalid status rejected by CHECK
      await expect(
        conn.query(
          `INSERT INTO control_plane_sync_outbox
             (board_id, outbox_id, status, idempotency_key, event_type, subject_hash,
              board_rev, lifecycle_rev, canonical_hash, record_json)
           VALUES ('board-a', 'ob-bad', 'OPEN', 'idem-bad', 'X', REPEAT('c', 64), 1, 1, REPEAT('d', 64), '{}')`,
        ),
      ).rejects.toBeTruthy()
      // Duplicate idempotency rejected
      await expect(
        conn.query(
          `INSERT INTO control_plane_sync_outbox
             (board_id, outbox_id, status, idempotency_key, event_type, subject_hash,
              board_rev, lifecycle_rev, canonical_hash, record_json)
           VALUES ('board-a', 'ob-2', 'PENDING', 'idem-1', 'X', REPEAT('e', 64), 1, 1, REPEAT('f', 64), '{}')`,
        ),
      ).rejects.toMatchObject({ errno: 1062 })

      // Legacy residual valid + CHECK + unique receipt_hash
      await conn.query(
        `INSERT INTO control_plane_legacy_residuals
           (board_id, residual_id, status, idempotency_key, receipt_hash,
            board_rev, lifecycle_rev, canonical_hash, record_json)
         VALUES (?, ?, 'UNREPLAYED', ?, REPEAT('1', 64), 1, 1, REPEAT('2', 64), ?)`,
        ['board-a', 'res-1', 'res-idem-1', JSON.stringify({ kind: 'residual' })],
      )
      await expect(
        conn.query(
          `INSERT INTO control_plane_legacy_residuals
             (board_id, residual_id, status, idempotency_key, receipt_hash,
              board_rev, lifecycle_rev, canonical_hash, record_json)
           VALUES ('board-a', 'res-bad', 'PENDING', 'res-bad', REPEAT('3', 64), 1, 1, REPEAT('4', 64), '{}')`,
        ),
      ).rejects.toBeTruthy()

      // Future pending COUNT shapes (not a proven-zero claim for product measures)
      const [outboxPending] = await conn.query(
        `SELECT COUNT(*) AS n FROM control_plane_sync_outbox
         WHERE board_id = ? AND status IN ('PENDING','IN_FLIGHT','FAILED')`,
        ['board-a'],
      )
      expect(Number((outboxPending as Array<{ n: number }>)[0]!.n)).toBe(1)
      const [legacyPending] = await conn.query(
        `SELECT COUNT(*) AS n FROM control_plane_legacy_residuals
         WHERE board_id = ? AND status IN ('UNREPLAYED','REPLAYING')`,
        ['board-a'],
      )
      expect(Number((legacyPending as Array<{ n: number }>)[0]!.n)).toBe(1)
      // ACKED / REPLAYED excluded from pending sets
      await conn.query(
        `INSERT INTO control_plane_sync_outbox
           (board_id, outbox_id, status, idempotency_key, event_type, subject_hash,
            board_rev, lifecycle_rev, canonical_hash, record_json)
         VALUES ('board-a', 'ob-ack', 'ACKED', 'idem-ack', 'X', REPEAT('g', 64), 1, 1, REPEAT('h', 64), '{}')`,
      )
      const [outboxAfterAck] = await conn.query(
        `SELECT COUNT(*) AS n FROM control_plane_sync_outbox
         WHERE board_id = ? AND status IN ('PENDING','IN_FLIGHT','FAILED')`,
        ['board-a'],
      )
      expect(Number((outboxAfterAck as Array<{ n: number }>)[0]!.n)).toBe(1)

      // Re-apply CREATE IF NOT EXISTS is idempotent
      for (const stmt of m014.statements) {
        await conn.query(stmt)
      }
    } finally {
      await conn.end()
    }
  }, 60_000)

  it('unit contract: memory apply of 014 after 013 is exactly one next step', async () => {
    const loaded = loadMigrationManifest(cwd)
    const m013 = loaded.find((m) => m.version === '013')!
    const m014 = loaded.find((m) => m.version === '014')!
    expect(m013.sha256).toBe(EXPECTED_SHA256['013'])
    expect(m014.sha256).toBe(EXPECTED_SHA256['014'])
    expect(m014.statements).toHaveLength(2)

    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: historyThrough('013'),
      cwd,
    })
    expect(plan.status).toBe('READY')
    const pending = plan.items.filter((i) => i.action === 'APPLY')
    expect(pending.map((i) => i.version)).toEqual(['014'])

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
    expect(skipPending.map((i) => i.version)).toContain('014')
  })
})
