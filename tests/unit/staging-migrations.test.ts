/**
 * Staging MySQL migration executor + CLI unit/integration tests (TM-P0).
 * Unit: memory/fakes + fail-closed authority.
 * Integration: disposable local MySQL when CAIRN_MIGRATE_IT=1 or default probe succeeds.
 */
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import mysql from 'mysql2/promise'

import {
  applyMigrations,
  createMemoryMigrationExecutor,
  dryRunMigrations,
  g0IdentityLifecycleMappingRows,
  loadMigrationManifest,
  manifestLatestVersion,
  migrationStatusAsync,
  planMigrations,
  readMigrationSchemaState,
  resolveAppliedHistory,
} from '#/server/migrations'
import {
  createMysqlMigrationExecutor,
  createMysqlMigrationReadOnlyExecutor,
  resolveMysqlMigrationConfig,
} from '#/server/mysql-migration-executor'
import {
  loadLifecycleMappingFromSpec,
  parseMigrateCliArgs,
  runMigrateCli,
} from '#/server/migrate-cli'
import { classifyDbHost, migrationApplyAllowed } from '#/server/db'

const cwd = process.cwd()
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()

/** Minimal pre-expand schema so 001 ALTER tasks/board_docs and 003 boards seed can run.
 * Collation must match migration tables (utf8mb4_unicode_ci) to avoid join/compare mix errors.
 */
const BASE_DDL = `
CREATE TABLE IF NOT EXISTS boards (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  views JSON NULL,
  created_at VARCHAR(32) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS tasks (
  board_id VARCHAR(64) NOT NULL,
  id VARCHAR(160) NOT NULL,
  project_id VARCHAR(64) NULL,
  feature_contract_id VARCHAR(160) NULL,
  grp VARCHAR(191) NULL,
  phase VARCHAR(191) NULL,
  scope VARCHAR(64) NULL,
  title TEXT NULL,
  updated VARCHAR(40) NULL,
  summary JSON NULL,
  data JSON NULL,
  lifecycle_stage VARCHAR(64) NULL,
  implementer_run VARCHAR(160) NULL,
  rev INT NOT NULL DEFAULT 0,
  lifecycle JSON NULL,
  blocked_reason VARCHAR(400) NULL,
  last_receipt_at VARCHAR(40) NULL,
  PRIMARY KEY (board_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS board_docs (
  board_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (board_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS audit_log (
  id BIGINT NOT NULL AUTO_INCREMENT,
  board_id VARCHAR(64) NOT NULL,
  ts VARCHAR(40) NOT NULL,
  actor VARCHAR(160) NULL,
  action VARCHAR(64) NOT NULL,
  task_id VARCHAR(160) NULL,
  from_stage VARCHAR(64) NULL,
  to_stage VARCHAR(64) NULL,
  detail JSON NULL,
  PRIMARY KEY (id),
  KEY idx_board (board_id, id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

describe('mysql migration config + authority', () => {
  it('resolveMysqlMigrationConfig classifies localhost as LOCAL and allows apply', () => {
    const cfg = resolveMysqlMigrationConfig({ host: '127.0.0.1', database: 'cairn_taskmanager' })
    expect(cfg.hostClass).toBe('LOCAL')
    expect(cfg.applyAllowed).toBe(true)
    expect(migrationApplyAllowed(cfg.hostClass)).toBe(true)
  })

  it('resolveMysqlMigrationConfig refuses remote without CAIRN_ALLOW_REMOTE_DB', () => {
    const prev = process.env.CAIRN_ALLOW_REMOTE_DB
    delete process.env.CAIRN_ALLOW_REMOTE_DB
    try {
      expect(() => resolveMysqlMigrationConfig({ host: '10.0.0.9', database: 'x' })).toThrow(
        /Refusing to connect|remote/i,
      )
    } finally {
      if (prev === undefined) delete process.env.CAIRN_ALLOW_REMOTE_DB
      else process.env.CAIRN_ALLOW_REMOTE_DB = prev
    }
  })

  it('production/unknown remote host classes refuse apply (plan gate)', () => {
    expect(classifyDbHost('task-manager.mfsdev.net')).toBe('PRODUCTION')
    expect(migrationApplyAllowed('PRODUCTION')).toBe(false)
    expect(migrationApplyAllowed('UNKNOWN_REMOTE')).toBe(false)
    const plan = planMigrations({
      host: 'task-manager.mfsdev.net',
      hostClass: 'PRODUCTION',
      mode: 'apply',
      applied: [],
      cwd,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(plan.status).toBe('BLOCKED')
    expect(plan.applyAllowed).toBe(false)
  })

  it('read-only executor refuses query and omits recordApplied', async () => {
    // Fake connection that would throw if used for mutation paths after readOnly check
    const fake = {
      async query() {
        return [[{ ok: 1 }], []]
      },
      async end() {},
    }
    const exec = createMysqlMigrationExecutor({
      host: '127.0.0.1',
      database: 'cairn_taskmanager',
      readOnly: true,
      connection: fake as never,
      ownsConnection: false,
    })
    await expect(exec.query('SELECT 1')).rejects.toThrow(/read-only/i)
    expect(exec.recordApplied).toBeUndefined()
    await exec.close()
  })

  it('manifestLatestVersion is 006', () => {
    expect(manifestLatestVersion()).toBe('006')
  })

  it('manifest includes 004/005/006 after 003 with REVERSIBLE classification', () => {
    const loaded = loadMigrationManifest(cwd)
    expect(loaded.map((m) => m.version)).toEqual(['000', '001', '002', '003', '004', '005', '006'])
    expect(loaded.map((m) => m.filename)).toEqual([
      '000_baseline_core.sql',
      '001_control_plane_expand.sql',
      '002_control_plane_indexes.sql',
      '003_control_plane_backfill.sql',
      '004_control_data_persistence.sql',
      '005_control_plane_runtime_persistence.sql',
      '006_stage_evidence_receipts.sql',
    ])
    const m004 = loaded.find((m) => m.version === '004')!
    const m005 = loaded.find((m) => m.version === '005')!
    const m006 = loaded.find((m) => m.version === '006')!
    expect(m004.classification).toBe('REVERSIBLE')
    expect(m005.classification).toBe('REVERSIBLE')
    expect(m006.classification).toBe('REVERSIBLE')
    expect(m004.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(m005.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(m006.sha256).toMatch(/^[a-f0-9]{64}$/)
    expect(m004.statements.length).toBeGreaterThan(0)
    expect(m005.statements.length).toBeGreaterThan(0)
    expect(m006.statements.length).toBeGreaterThan(0)
    // 006 registered exactly once
    expect(loaded.filter((m) => m.version === '006')).toHaveLength(1)
  })
})

describe('migrate CLI parse + mapping loader', () => {
  it('parses plan/dry-run/apply/status flags', () => {
    expect(parseMigrateCliArgs(['plan', '--json']).command).toBe('plan')
    expect(parseMigrateCliArgs(['dry-run', '--host', '127.0.0.1']).host).toBe('127.0.0.1')
    expect(parseMigrateCliArgs(['apply', '--lifecycle-mapping', 'g0']).lifecycleMapping).toBe('g0')
    expect(parseMigrateCliArgs(['status', '--database', 'x']).database).toBe('x')
    expect(parseMigrateCliArgs(['--help']).command).toBe('help')
  })

  it('loadLifecycleMappingFromSpec g0 returns 9 IDENTITY rows', () => {
    const rows = loadLifecycleMappingFromSpec('g0', cwd)
    expect(Array.isArray(rows)).toBe(true)
    expect((rows as ReturnType<typeof g0IdentityLifecycleMappingRows>).length).toBe(9)
  })

  it('CLI apply without mapping fails closed (exit 1, no executor write needed)', async () => {
    const logs: Array<string> = []
    const result = await runMigrateCli(['apply'], {
      log: (s) => logs.push(s),
      logErr: (s) => logs.push(s),
      createExecutor: () => {
        throw new Error('should not create executor without mapping')
      },
    })
    expect(result.exitCode).toBe(1)
    expect(result.error).toMatch(/lifecycle mapping/i)
  })

  it('CLI apply refuses PRODUCTION host before SQL', async () => {
    const prevAllow = process.env.CAIRN_ALLOW_REMOTE_DB
    process.env.CAIRN_ALLOW_REMOTE_DB = '1'
    try {
      const result = await runMigrateCli(
        ['apply', '--host', 'task-manager.mfsdev.net', '--lifecycle-mapping', 'g0', '--json'],
        {
          log: () => {},
          logErr: () => {},
        },
      )
      expect(result.exitCode).toBe(1)
      expect(result.error ?? result.plan?.blockedReason ?? '').toMatch(/refused|PRODUCTION|hostClass/i)
    } finally {
      if (prevAllow === undefined) delete process.env.CAIRN_ALLOW_REMOTE_DB
      else process.env.CAIRN_ALLOW_REMOTE_DB = prevAllow
    }
  })

  it('offline plan works without MySQL', async () => {
    const result = await runMigrateCli(['plan', '--offline', '--json'], {
      log: () => {},
      logErr: () => {},
    })
    expect(result.exitCode).toBe(0)
    expect(result.plan?.status).toBe('READY')
    expect(result.plan?.orderedVersions).toEqual(['000', '001', '002', '003', '004', '005', '006'])
    expect(result.plan?.items.map((i) => i.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
    ])
    expect(result.plan?.items.every((i) => i.action === 'APPLY')).toBe(true)
    expect(result.plan?.items.filter((i) => i.version === '006')).toHaveLength(1)
  })

  it('help text documents plan range 000..006', async () => {
    const result = await runMigrateCli(['--help'], {
      log: () => {},
      logErr: () => {},
    })
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toMatch(/Plan migrations 000\.\.006/)
    expect(result.stdout).not.toMatch(/Plan migrations 001\.\.003/)
    expect(result.stdout).not.toMatch(/Plan migrations 000\.\.005[^.0-9]/)
  })
})

describe('resolveAppliedHistory + schema readback (memory)', () => {
  it('uses explicit applied over executor', async () => {
    const loaded = loadMigrationManifest(cwd)
    const explicit = [
      {
        version: loaded[0]!.version,
        filename: loaded[0]!.filename,
        sha256: loaded[0]!.sha256,
        classification: loaded[0]!.classification,
      },
    ]
    const history = await resolveAppliedHistory({
      applied: explicit,
      executor: {
        async query() {
          return null
        },
        async listApplied() {
          return []
        },
      },
    })
    expect(history).toHaveLength(1)
    expect(history[0]!.version).toBe('000')
  })

  it('readMigrationSchemaState returns UNKNOWN when history empty', async () => {
    const schema = await readMigrationSchemaState({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: {
        async query() {
          return null
        },
        async listApplied() {
          return []
        },
      },
    })
    expect(schema.status).toBe('UNKNOWN')
    expect(schema.schemaVersion).toBe('')
    expect(schema.expectedLatestVersion).toBe('006')
    expect(schema.appliedVersions).toEqual([])
  })

  it('readMigrationSchemaState reflects IDEMPOTENT_NOOP when fully applied', async () => {
    const loaded = loadMigrationManifest(cwd)
    const history = loaded.map((m) => ({
      version: m.version,
      filename: m.filename,
      sha256: m.sha256,
      classification: m.classification,
    }))
    const schema = await readMigrationSchemaState({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      applied: history,
      executor: {
        async query() {
          return null
        },
        async listApplied() {
          return history
        },
      },
    })
    expect(schema.status).toBe('IDEMPOTENT_NOOP')
    expect(schema.schemaVersion).toBe('006')
    expect(schema.appliedVersions).toEqual(['000', '001', '002', '003', '004', '005', '006'])
  })

  it('plan/apply/idempotency for 004+005+006 without real DB (memory executor)', async () => {
    const loaded = loadMigrationManifest(cwd)
    const through003 = loaded
      .filter((m) => m.version <= '003')
      .map((m) => ({
        version: m.version,
        filename: m.filename,
        sha256: m.sha256,
        classification: m.classification,
      }))

    const planPending = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through003,
      cwd,
      mode: 'plan',
    })
    expect(planPending.status).toBe('READY')
    expect(planPending.orderedVersions).toEqual(['000', '001', '002', '003', '004', '005', '006'])
    const byVersion = Object.fromEntries(planPending.items.map((i) => [i.version, i.action]))
    expect(byVersion['000']).toBe('SKIP_ALREADY_APPLIED')
    expect(byVersion['001']).toBe('SKIP_ALREADY_APPLIED')
    expect(byVersion['002']).toBe('SKIP_ALREADY_APPLIED')
    expect(byVersion['003']).toBe('SKIP_ALREADY_APPLIED')
    expect(byVersion['004']).toBe('APPLY')
    expect(byVersion['005']).toBe('APPLY')
    expect(byVersion['006']).toBe('APPLY')
    expect(planPending.items.filter((i) => i.version === '006')).toHaveLength(1)

    const exec = createMemoryMigrationExecutor(through003)
    const first = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(first.ok).toBe(true)
    expect(first.applied).toEqual(['004', '005', '006'])
    expect(first.skipped).toEqual(['000', '001', '002', '003'])
    expect(exec.history.map((h) => h.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
    ])
    for (const v of ['004', '005', '006'] as const) {
      const hist = exec.history.find((h) => h.version === v)!
      const man = loaded.find((m) => m.version === v)!
      expect(hist.sha256).toBe(man.sha256)
      expect(hist.classification).toBe('REVERSIBLE')
      expect(hist.filename).toBe(man.filename)
    }
    expect(exec.statements.length).toBeGreaterThan(0)
    expect(exec.statements.some((s) => /control_plane_stage_evidence_receipts/i.test(s))).toBe(true)

    const second = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(second.ok).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual(['000', '001', '002', '003', '004', '005', '006'])
    expect(second.plan.status).toBe('IDEMPOTENT_NOOP')
  })

  it('checksum mismatch surfaces via migrationStatusAsync', async () => {
    const loaded = loadMigrationManifest(cwd)
    const bad = loaded.map((m, i) => ({
      version: m.version,
      filename: m.filename,
      sha256: i === 0 ? createHash('sha256').update('tampered').digest('hex') : m.sha256,
      classification: m.classification,
    }))
    const plan = await migrationStatusAsync({
      host: '127.0.0.1',
      applied: bad,
      cwd,
    })
    expect(plan.status).toBe('CHECKSUM_MISMATCH')
  })
})

// ---------------------------------------------------------------------------
// Disposable local MySQL integration (skip when unreachable)
// ---------------------------------------------------------------------------

const EXPECTED_VERSIONS = ['000', '001', '002', '003', '004', '005', '006'] as const

type ItCtx = {
  /** Pre-existing BASE_DDL path (legacy tables present, empty schema_migrations). */
  baseDdlDatabase: string
  /** True empty greenfield database (no tables). */
  greenfieldDatabase: string
  /** Partial: control_plane tables present, tasks missing. */
  partialDatabase: string
  host: string
  available: boolean
}

const itCtx: ItCtx = {
  baseDdlDatabase: `cairn_migrate_base_${process.pid}_${Date.now()}`,
  greenfieldDatabase: `cairn_migrate_gf_${process.pid}_${Date.now()}`,
  partialDatabase: `cairn_migrate_partial_${process.pid}_${Date.now()}`,
  host: '127.0.0.1',
  available: false,
}

async function openAdminConn() {
  return mysql.createConnection({
    host: itCtx.host,
    port: 3306,
    user: process.env.CAIRN_DB_USER || 'root',
    password: process.env.CAIRN_DB_PASSWORD || '',
    multipleStatements: true,
    connectTimeout: 3000,
  })
}

async function probeLocalMysql(): Promise<boolean> {
  if (process.env.CAIRN_MIGRATE_IT === '0') return false
  try {
    const conn = await openAdminConn()
    await conn.query('SELECT 1')
    await conn.end()
    return true
  } catch {
    return false
  }
}

/**
 * Partial failed greenfield: some control-plane objects exist, baseline `tasks` missing.
 * board_revisions shape matches 001 so CREATE IF NOT EXISTS is a true no-op.
 */
const PARTIAL_CONTROL_PLANE_DDL = `
CREATE TABLE IF NOT EXISTS schema_migrations (
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
CREATE TABLE IF NOT EXISTS boards (
  id VARCHAR(64) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  views JSON NULL,
  created_at VARCHAR(32) NULL,
  PRIMARY KEY (id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS board_docs (
  board_id VARCHAR(64) NOT NULL,
  kind VARCHAR(32) NOT NULL,
  data JSON NOT NULL,
  PRIMARY KEY (board_id, kind)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
CREATE TABLE IF NOT EXISTS board_revisions (
  board_id VARCHAR(64) NOT NULL,
  board_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  lifecycle_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
  subject_hash CHAR(64) NULL,
  canonical_snapshot_id VARCHAR(64) NULL,
  updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
  PRIMARY KEY (board_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
`

describe('disposable local MySQL migration integration', () => {
  beforeAll(async () => {
    itCtx.available = await probeLocalMysql()
    if (!itCtx.available) return
    const conn = await openAdminConn()
    try {
      // Path A: pre-existing BASE_DDL (upgrade path) + seed rows
      await conn.query(
        `CREATE DATABASE \`${itCtx.baseDdlDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${itCtx.baseDdlDatabase}\``)
      await conn.query(BASE_DDL)
      await conn.query(
        `INSERT INTO boards (id, name, created_at) VALUES ('synth-board', 'Synthetic', '2026-01-01T00:00:00Z')`,
      )
      await conn.query(
        `INSERT INTO tasks (board_id, id, title, rev) VALUES ('synth-board', 't1', 'seed', 0)`,
      )

      // Path B: empty greenfield
      await conn.query(
        `CREATE DATABASE \`${itCtx.greenfieldDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )

      // Path C: partial — control_plane present, tasks missing
      await conn.query(
        `CREATE DATABASE \`${itCtx.partialDatabase}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
      await conn.query(`USE \`${itCtx.partialDatabase}\``)
      await conn.query(PARTIAL_CONTROL_PLANE_DDL)
      await conn.query(
        `INSERT INTO boards (id, name, created_at) VALUES ('partial-board', 'Partial', '2026-01-01T00:00:00Z')`,
      )
    } finally {
      await conn.end()
    }
  }, 30_000)

  afterAll(async () => {
    if (!itCtx.available) return
    const conn = await openAdminConn()
    try {
      await conn.query(`DROP DATABASE IF EXISTS \`${itCtx.baseDdlDatabase}\``)
      await conn.query(`DROP DATABASE IF EXISTS \`${itCtx.greenfieldDatabase}\``)
      await conn.query(`DROP DATABASE IF EXISTS \`${itCtx.partialDatabase}\``)
    } finally {
      await conn.end()
    }
  }, 30_000)

  it('empty greenfield: apply yields 000,001,002,003; second apply skips all', async () => {
    if (!itCtx.available) {
      console.warn('SKIP disposable MySQL integration: local MySQL not reachable')
      return
    }

    const exec = createMysqlMigrationExecutor({
      host: itCtx.host,
      database: itCtx.greenfieldDatabase,
      appliedBy: 'staging-migrations-greenfield',
    })
    try {
      await exec.ping()
      const empty = exec.listApplied ? await exec.listApplied() : []
      expect(empty).toEqual([])

      const first = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(first.ok).toBe(true)
      expect(first.applied).toEqual([...EXPECTED_VERSIONS])
      expect(first.skipped).toEqual([])

      const history = exec.listApplied ? await exec.listApplied() : []
      expect(history.map((h) => h.version)).toEqual([...EXPECTED_VERSIONS])
      const loaded = loadMigrationManifest(cwd)
      for (const h of history) {
        const m = loaded.find((x) => x.version === h.version)!
        expect(h.sha256).toBe(m.sha256)
      }

      // Prove core + expand + stage-evidence (006) tables exist after greenfield apply
      // createMysqlMigrationExecutor.query returns rows only (not [rows, fields])
      const tables = (await exec.query(
        `SELECT TABLE_NAME AS t FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY t`,
        [itCtx.greenfieldDatabase],
      )) as Array<{ t: string }>
      const names = tables.map((r) => r.t)
      expect(names).toEqual(
        expect.arrayContaining([
          'boards',
          'tasks',
          'board_docs',
          'audit_log',
          'schema_migrations',
          'control_plane_stage_evidence_receipts',
        ]),
      )

      // 006 history row checksum matches manifest
      const h006 = history.find((h) => h.version === '006')!
      const m006 = loaded.find((x) => x.version === '006')!
      expect(h006).toBeDefined()
      expect(h006.sha256).toBe(m006.sha256)
      expect(h006.filename).toBe('006_stage_evidence_receipts.sql')
      expect(h006.classification).toBe('REVERSIBLE')

      // Physical table probe (information_schema count) — history alone is insufficient
      const stageEv = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [itCtx.greenfieldDatabase],
      )) as Array<{ c: number }>
      expect(Number(stageEv[0]!.c)).toBe(1)

      const second = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(second.ok).toBe(true)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([...EXPECTED_VERSIONS])
      expect(second.plan.status).toBe('IDEMPOTENT_NOOP')

      // Re-apply no-op must not drop physical stage-evidence table
      const stageEvAfter = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [itCtx.greenfieldDatabase],
      )) as Array<{ c: number }>
      expect(Number(stageEvAfter[0]!.c)).toBe(1)
    } finally {
      await exec.close()
    }
  }, 60_000)

  it('pre-existing BASE_DDL path remains safe: apply 000-003, checksums, idempotent re-apply', async () => {
    if (!itCtx.available) {
      console.warn('SKIP disposable MySQL integration: local MySQL not reachable')
      return
    }

    const exec = createMysqlMigrationExecutor({
      host: itCtx.host,
      database: itCtx.baseDdlDatabase,
      appliedBy: 'staging-migrations-base-ddl',
    })
    try {
      await exec.ping()
      const empty = exec.listApplied ? await exec.listApplied() : []
      expect(empty).toEqual([])

      const ro = createMysqlMigrationReadOnlyExecutor({
        host: itCtx.host,
        database: itCtx.baseDdlDatabase,
      })
      try {
        const dry = await dryRunMigrations({
          host: itCtx.host,
          hostClass: 'LOCAL',
          cwd,
          executor: ro,
          lifecycleMapping: SAFE_MAPPING,
        })
        expect(dry.status).toBe('READY')
        expect(dry.orderedVersions).toEqual([...EXPECTED_VERSIONS])
      } finally {
        await ro.close()
      }

      const first = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(first.ok).toBe(true)
      expect(first.applied).toEqual([...EXPECTED_VERSIONS])
      expect(first.skipped).toEqual([])

      // Seed rows survived CREATE IF NOT EXISTS baseline + expand
      const taskRows = (await exec.query(
        `SELECT id, title FROM tasks WHERE board_id = ? AND id = ?`,
        ['synth-board', 't1'],
      )) as Array<{ id: string; title: string }>
      expect(taskRows).toHaveLength(1)
      expect(taskRows[0]!.title).toBe('seed')

      const history = exec.listApplied ? await exec.listApplied() : []
      expect(history.map((h) => h.version)).toEqual([...EXPECTED_VERSIONS])
      const loaded = loadMigrationManifest(cwd)
      for (const h of history) {
        const m = loaded.find((x) => x.version === h.version)!
        expect(h.sha256).toBe(m.sha256)
        expect(h.sha256).toMatch(/^[a-f0-9]{64}$/)
      }

      const schema = await readMigrationSchemaState({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
      })
      expect(schema.schemaVersion).toBe('006')
      expect(schema.status).toBe('IDEMPOTENT_NOOP')
      expect(schema.appliedVersions).toEqual([...EXPECTED_VERSIONS])
      expect(schema.expectedLatestVersion).toBe('006')

      // Physical control_plane_stage_evidence_receipts after 006 (history alone insufficient)
      const stageEv = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [itCtx.baseDdlDatabase],
      )) as Array<{ c: number }>
      expect(Number(stageEv[0]!.c)).toBe(1)
      const h006 = history.find((h) => h.version === '006')!
      const m006 = loaded.find((x) => x.version === '006')!
      expect(h006.sha256).toBe(m006.sha256)
      expect(h006.filename).toBe('006_stage_evidence_receipts.sql')

      const second = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(second.ok).toBe(true)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([...EXPECTED_VERSIONS])
      expect(second.plan.status).toBe('IDEMPOTENT_NOOP')
      // No-op re-apply keeps physical stage-evidence table
      const stageEvNoop = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [itCtx.baseDdlDatabase],
      )) as Array<{ c: number }>
      expect(Number(stageEvNoop[0]!.c)).toBe(1)

      // Fail-closed checksum mismatch
      await exec.query(
        `UPDATE schema_migrations SET sha256 = ? WHERE version = '001'`,
        [createHash('sha256').update('tampered-history').digest('hex')],
      )
      const mismatch = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(mismatch.ok).toBe(false)
      expect(mismatch.plan.status).toBe('CHECKSUM_MISMATCH')
      expect(mismatch.applied).toEqual([])
    } finally {
      await exec.close()
    }
  }, 60_000)

  it('partial state (control_plane present, tasks missing) recovers via 000-003', async () => {
    if (!itCtx.available) {
      console.warn('SKIP disposable MySQL integration: local MySQL not reachable')
      return
    }

    // Prove tasks is missing before apply; board_revisions (control-plane) present
    const probe = await openAdminConn()
    try {
      const [before] = (await probe.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'`,
        [itCtx.partialDatabase],
      )) as [Array<{ c: number }>, unknown]
      expect(Number(before[0]!.c)).toBe(0)
      const [cp] = (await probe.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'board_revisions'`,
        [itCtx.partialDatabase],
      )) as [Array<{ c: number }>, unknown]
      expect(Number(cp[0]!.c)).toBe(1)
    } finally {
      await probe.end()
    }

    const exec = createMysqlMigrationExecutor({
      host: itCtx.host,
      database: itCtx.partialDatabase,
      appliedBy: 'staging-migrations-partial',
    })
    try {
      await exec.ping()
      // schema_migrations table exists but has zero history rows
      const empty = exec.listApplied ? await exec.listApplied() : []
      expect(empty).toEqual([])

      const result = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(result.ok).toBe(true)
      expect(result.applied).toEqual([...EXPECTED_VERSIONS])
      expect(result.skipped).toEqual([])

      const after = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks'`,
        [itCtx.partialDatabase],
      )) as Array<{ c: number }>
      expect(Number(after[0]!.c)).toBe(1)

      // Expand column from 001 must exist on recovered tasks
      const cols = (await exec.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'tasks' AND COLUMN_NAME = 'task_class'`,
        [itCtx.partialDatabase],
      )) as Array<{ c: string }>
      expect(cols).toHaveLength(1)

      const history = exec.listApplied ? await exec.listApplied() : []
      expect(history.map((h) => h.version)).toEqual([...EXPECTED_VERSIONS])

      // 006 physical stage-evidence table on partial recovery path
      const stageEv = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [itCtx.partialDatabase],
      )) as Array<{ c: number }>
      expect(Number(stageEv[0]!.c)).toBe(1)

      const second = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(second.ok).toBe(true)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([...EXPECTED_VERSIONS])
    } finally {
      await exec.close()
    }
  }, 60_000)

  it('006 history corresponds to physical stage-evidence table + checksum + rerun no-op', async () => {
    if (!itCtx.available) {
      console.warn(
        'SKIP disposable MySQL integration (006 physical table): local MySQL not reachable — not claiming table proof',
      )
      return
    }

    // Dedicated path: empty DB → full apply → assert 006 ↔ physical table binding
    const dbName = `cairn_migrate_006phys_${process.pid}_${Date.now()}`
    const admin = await openAdminConn()
    try {
      await admin.query(
        `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
      )
    } finally {
      await admin.end()
    }

    const exec = createMysqlMigrationExecutor({
      host: itCtx.host,
      database: dbName,
      appliedBy: 'staging-migrations-006-physical',
    })
    try {
      await exec.ping()
      const first = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(first.ok).toBe(true)
      expect(first.applied).toEqual([...EXPECTED_VERSIONS])
      expect(first.applied).toContain('006')

      const history = exec.listApplied ? await exec.listApplied() : []
      expect(history.map((h) => h.version)).toEqual([...EXPECTED_VERSIONS])
      const loaded = loadMigrationManifest(cwd)
      const h006 = history.find((h) => h.version === '006')!
      const m006 = loaded.find((m) => m.version === '006')!
      expect(h006.sha256).toBe(m006.sha256)
      expect(h006.filename).toBe(m006.filename)
      expect(h006.classification).toBe('REVERSIBLE')

      // Physical table must exist — this is the gap closed by this repair
      const phys = (await exec.query(
        `SELECT TABLE_NAME AS t, TABLE_TYPE AS ty FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [dbName],
      )) as Array<{ t: string; ty: string }>
      expect(phys).toHaveLength(1)
      expect(phys[0]!.t).toBe('control_plane_stage_evidence_receipts')

      // Column shape smoke (primary key columns from 006 SQL)
      const cols = (await exec.query(
        `SELECT COLUMN_NAME AS c FROM information_schema.COLUMNS
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'
         ORDER BY ORDINAL_POSITION`,
        [dbName],
      )) as Array<{ c: string }>
      const colNames = cols.map((r) => r.c)
      expect(colNames).toEqual(
        expect.arrayContaining([
          'board_id',
          'receipt_id',
          'task_id',
          'to_stage',
          'receipt_hash',
          'emitting_run_id',
        ]),
      )

      // Rerun no-op
      const second = await applyMigrations({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
      })
      expect(second.ok).toBe(true)
      expect(second.applied).toEqual([])
      expect(second.skipped).toEqual([...EXPECTED_VERSIONS])
      expect(second.plan.status).toBe('IDEMPOTENT_NOOP')

      const physAfter = (await exec.query(
        `SELECT COUNT(*) AS c FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = ? AND TABLE_NAME = 'control_plane_stage_evidence_receipts'`,
        [dbName],
      )) as Array<{ c: number }>
      expect(Number(physAfter[0]!.c)).toBe(1)

      const schema = await readMigrationSchemaState({
        host: itCtx.host,
        hostClass: 'LOCAL',
        cwd,
        executor: exec,
      })
      expect(schema.schemaVersion).toBe('006')
      expect(schema.status).toBe('IDEMPOTENT_NOOP')
      expect(schema.appliedVersions).toContain('006')
    } finally {
      await exec.close()
      const cleanup = await openAdminConn()
      try {
        await cleanup.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
      } finally {
        await cleanup.end()
      }
    }
  }, 60_000)

  it('CLI status against disposable BASE_DDL DB reports schema readback', async () => {
    if (!itCtx.available) return
    // CHECKSUM_MISMATCH exit 2 after tamper in BASE_DDL test is still valid CLI behavior
    const result = await runMigrateCli(
      ['status', '--host', itCtx.host, '--database', itCtx.baseDdlDatabase, '--json'],
      { log: () => {}, logErr: () => {} },
    )
    expect([0, 2]).toContain(result.exitCode)
    expect(result.schema).toBeDefined()
    expect(result.schema!.expectedLatestVersion).toBe('006')
    if (result.schema!.status !== 'CHECKSUM_MISMATCH') {
      expect(result.schema!.appliedVersions.length).toBeGreaterThan(0)
    }
  }, 30_000)
})
