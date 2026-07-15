import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'
import { describe, expect, it } from 'vitest'

import {
  classifyDbHost,
  migrationApplyAllowed,
  type DbHostClass,
} from '#/server/db'
import {
  MIGRATION_MANIFEST,
  applyMigrations,
  assertManifestOrder,
  createMemoryMigrationExecutor,
  dryRunClassificationBackfill,
  dryRunMigrations,
  g0IdentityLifecycleMappingRows,
  loadMigrationManifest,
  migrationStatus,
  planMigrations,
  resolveMigrationLifecycleMapping,
  sha256Hex,
  splitSqlStatements,
  validateProductionMigrationAuthority,
  type ProductionMigrationAuthority,
} from '#/server/migrations'
import type { LifecycleMappingRow } from '#/server/lifecycle-store'

const cwd = process.cwd()

/** Explicit safe mapping evidence for memory apply tests (G0 identity nine). */
const SAFE_MAPPING = g0IdentityLifecycleMappingRows()

describe('migration manifest ordering + checksums', () => {
  it('has strictly ordered 000/001/002/003/004/005/006/007/008 entries', () => {
    assertManifestOrder(MIGRATION_MANIFEST)
    expect(MIGRATION_MANIFEST.map((m) => m.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(MIGRATION_MANIFEST.map((m) => m.classification)).toEqual([
      'REVERSIBLE',
      'REVERSIBLE',
      'EXPAND_CONTRACT_BACKWARD_COMPATIBLE',
      'FORWARD_FIX_ONLY',
      'REVERSIBLE',
      'REVERSIBLE',
      'REVERSIBLE',
      'REVERSIBLE',
      'REVERSIBLE',
    ])
  })

  it('loads on-disk SQL and computes stable SHA-256', () => {
    const loaded = loadMigrationManifest(cwd)
    expect(loaded).toHaveLength(9)
    for (const m of loaded) {
      const disk = fs.readFileSync(path.join(cwd, m.relativePath), 'utf8')
      expect(m.sha256).toBe(sha256Hex(disk))
      expect(m.sha256).toMatch(/^[a-f0-9]{64}$/)
      expect(m.statements.length).toBeGreaterThan(0)
    }
    // deterministic across reloads
    const again = loadMigrationManifest(cwd)
    expect(again.map((m) => m.sha256)).toEqual(loaded.map((m) => m.sha256))
  })

  it('baseline 000 SQL is IF NOT EXISTS only and includes core tables', () => {
    const sql = fs.readFileSync(
      path.join(cwd, 'migrations/000_baseline_core.sql'),
      'utf8',
    )
    expect(sql).toMatch(/schema_migrations/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS boards/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS tasks/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS board_docs/)
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS audit_log/)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
    }
  })

  it('expand SQL defaults UNCLASSIFIED and never PRODUCT', () => {
    const sql = fs.readFileSync(
      path.join(cwd, 'migrations/001_control_plane_expand.sql'),
      'utf8',
    )
    expect(sql).toMatch(/DEFAULT 'UNCLASSIFIED'/)
    expect(sql).not.toMatch(/DEFAULT 'PRODUCT'/)
    expect(sql).toMatch(/schema_migrations/)
    expect(sql).toMatch(/board_revisions/)
    expect(sql).toMatch(/entity_revisions/)
    expect(sql).toMatch(/control_plane_idempotency/)
    expect(sql).toMatch(/control_plane_evidence/)
    expect(sql).toMatch(/control_plane_g5/)
    expect(sql).toMatch(/control_plane_run_plans/)
    expect(sql).toMatch(/control_plane_snapshots/)
    // Executable statements only (comments may mention forbidden verbs as prohibitions)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
    }
  })

  it('backfill SQL never assigns PRODUCT', () => {
    const sql = fs.readFileSync(
      path.join(cwd, 'migrations/003_control_plane_backfill.sql'),
      'utf8',
    )
    expect(sql).not.toMatch(/task_class\s*=\s*'PRODUCT'/)
    expect(sql).toMatch(/UNCLASSIFIED/)
    expect(sql).toMatch(/MISSING_PROOF/)
  })

  it('006 stage_evidence_receipts SQL is additive IF NOT EXISTS only', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '006')!
    expect(entry.filename).toBe('006_stage_evidence_receipts.sql')
    expect(entry.classification).toBe('REVERSIBLE')
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    expect(sql).toMatch(
      /CREATE TABLE IF NOT EXISTS control_plane_stage_evidence_receipts/,
    )
    expect(sql).toMatch(/PRIMARY KEY \(board_id, receipt_id\)/)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    expect(stmts.length).toBeGreaterThan(0)
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
    }
    // Exactly one manifest entry for 006
    expect(MIGRATION_MANIFEST.filter((m) => m.version === '006')).toHaveLength(
      1,
    )
    expect(
      MIGRATION_MANIFEST.filter(
        (m) => m.filename === '006_stage_evidence_receipts.sql',
      ),
    ).toHaveLength(1)
  })

  it('007 globals_table SQL is additive IF NOT EXISTS only', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '007')!
    expect(entry.filename).toBe('007_globals_table.sql')
    expect(entry.classification).toBe('REVERSIBLE')
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    expect(sql).toMatch(/CREATE TABLE IF NOT EXISTS globals/)
    expect(sql).toMatch(/PRIMARY KEY \(k\)/)
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    expect(stmts.length).toBeGreaterThan(0)
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
    }
    // Exactly one manifest entry for 007
    expect(MIGRATION_MANIFEST.filter((m) => m.version === '007')).toHaveLength(
      1,
    )
    expect(
      MIGRATION_MANIFEST.filter((m) => m.filename === '007_globals_table.sql'),
    ).toHaveLength(1)
  })

  it('008 CP0 control-plane SQL is additive IF NOT EXISTS only', () => {
    const entry = MIGRATION_MANIFEST.find((m) => m.version === '008')!
    expect(entry.filename).toBe('008_cp0_control_plane.sql')
    expect(entry.classification).toBe('REVERSIBLE')
    const sql = fs.readFileSync(path.join(cwd, entry.relativePath), 'utf8')
    for (const table of [
      'control_plane_spawn_budgets',
      'control_plane_control_acks',
      'control_plane_account_probes',
      'control_plane_sync_status',
    ]) {
      expect(sql).toContain(`CREATE TABLE IF NOT EXISTS ${table}`)
    }
    const stmts = splitSqlStatements(sql).map((s) => s.toLowerCase())
    expect(stmts).toHaveLength(4)
    for (const s of stmts) {
      expect(s).not.toMatch(/\bdrop\s+table\b/)
      expect(s).not.toMatch(/\btruncate\b/)
      expect(s).not.toMatch(/\balter\s+table\b/)
    }
    expect(MIGRATION_MANIFEST.filter((m) => m.version === '008')).toHaveLength(
      1,
    )
  })

  it('splitSqlStatements strips comments and yields statements', () => {
    const stmts = splitSqlStatements(
      '-- c\nCREATE TABLE a (id INT);\n-- x\nALTER TABLE a ADD KEY k (id);',
    )
    expect(stmts).toEqual([
      'CREATE TABLE a (id INT)',
      'ALTER TABLE a ADD KEY k (id)',
    ])
  })
})

describe('migration plan / dry-run / idempotent rerun', () => {
  it('plans APPLY for empty history on LOCAL', () => {
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
    })
    expect(plan.status).toBe('READY')
    expect(plan.applyAllowed).toBe(true)
    expect(plan.items.every((i) => i.action === 'APPLY')).toBe(true)
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
    ])
    expect(plan.items.filter((i) => i.version === '006')).toHaveLength(1)
    expect(plan.items.find((i) => i.version === '006')!.action).toBe('APPLY')
    expect(plan.items.filter((i) => i.version === '007')).toHaveLength(1)
    expect(plan.items.find((i) => i.version === '007')!.action).toBe('APPLY')
    expect(plan.items.filter((i) => i.version === '008')).toHaveLength(1)
    expect(plan.items.find((i) => i.version === '008')!.action).toBe('APPLY')
  })

  it('idempotent plan is NOOP when history matches checksums', () => {
    const loaded = loadMigrationManifest(cwd)
    const applied = loaded.map((m) => ({
      version: m.version,
      filename: m.filename,
      sha256: m.sha256,
      classification: m.classification,
    }))
    const plan = planMigrations({ host: '127.0.0.1', applied, cwd })
    expect(plan.status).toBe('IDEMPOTENT_NOOP')
    expect(plan.items.every((i) => i.action === 'SKIP_ALREADY_APPLIED')).toBe(
      true,
    )
  })

  it('detects checksum mismatch fail-closed', () => {
    const loaded = loadMigrationManifest(cwd)
    const applied = loaded.map((m, i) => ({
      version: m.version,
      filename: m.filename,
      sha256:
        i === 0
          ? createHash('sha256').update('tampered').digest('hex')
          : m.sha256,
      classification: m.classification,
    }))
    const plan = planMigrations({ host: '127.0.0.1', applied, cwd })
    expect(plan.status).toBe('CHECKSUM_MISMATCH')
    expect(plan.items[0]!.action).toBe('CHECKSUM_MISMATCH')
  })

  it('dry-run does not require a DB and returns READY', async () => {
    const plan = await dryRunMigrations({ host: '127.0.0.1', applied: [], cwd })
    expect(plan.status).toBe('READY')
    expect(plan.mode).toBe('dry-run')
  })

  it('apply via memory executor is ordered and idempotent on second run', async () => {
    const exec = createMemoryMigrationExecutor()
    const first = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(first.ok).toBe(true)
    expect(first.applied).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(first.mapping?.approved).toBe(true)
    expect(first.mapping?.identityCount).toBe(9)
    expect(exec.statements.length).toBeGreaterThan(10)
    expect(exec.history.map((h) => h.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    // 006/007/008 each appear exactly once in apply output + history
    expect(first.applied.filter((v) => v === '006')).toHaveLength(1)
    expect(exec.history.filter((h) => h.version === '006')).toHaveLength(1)
    expect(first.applied.filter((v) => v === '007')).toHaveLength(1)
    expect(exec.history.filter((h) => h.version === '007')).toHaveLength(1)
    expect(first.applied.filter((v) => v === '008')).toHaveLength(1)
    expect(exec.history.filter((h) => h.version === '008')).toHaveLength(1)

    const second = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: exec.history,
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(second.ok).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(second.plan.status).toBe('IDEMPOTENT_NOOP')
    expect(second.mapping?.approved).toBe(true)
  })

  it('plan/dry-run/status/apply include 008 exactly once; partial 000-007 then apply only 008', async () => {
    const loaded = loadMigrationManifest(cwd)
    expect(loaded.filter((m) => m.version === '008')).toHaveLength(1)
    const m008 = loaded.find((m) => m.version === '008')!
    expect(m008.filename).toBe('008_cp0_control_plane.sql')

    const through007 = loaded
      .filter((m) => m.version <= '007')
      .map((m) => ({
        version: m.version,
        filename: m.filename,
        sha256: m.sha256,
        classification: m.classification,
      }))
    expect(through007.map((h) => h.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
    ])

    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through007,
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
    ])
    expect(plan.items.filter((i) => i.version === '008')).toHaveLength(1)
    expect(plan.items.find((i) => i.version === '008')!.action).toBe('APPLY')
    expect(
      plan.items.filter((i) => i.action === 'APPLY').map((i) => i.version),
    ).toEqual(['008'])

    const dry = await dryRunMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through007,
      cwd,
    })
    expect(dry.status).toBe('READY')
    expect(dry.mode).toBe('dry-run')
    expect(dry.items.filter((i) => i.version === '008')).toHaveLength(1)
    expect(dry.items.find((i) => i.version === '008')!.action).toBe('APPLY')

    const status = migrationStatus({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: through007,
      cwd,
    })
    expect(status.mode).toBe('status')
    expect(status.status).toBe('READY')
    expect(status.items.filter((i) => i.version === '008')).toHaveLength(1)

    const exec = createMemoryMigrationExecutor(through007)
    const first = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(first.ok).toBe(true)
    expect(first.applied).toEqual(['008'])
    expect(first.skipped).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
    ])
    expect(exec.history.map((h) => h.version)).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(exec.history.filter((h) => h.version === '008')).toHaveLength(1)
    expect(exec.history.find((h) => h.version === '008')!.sha256).toBe(
      m008.sha256,
    )
    expect(
      exec.statements.some((s) => /control_plane_spawn_budgets/i.test(s)),
    ).toBe(true)

    const second = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(second.ok).toBe(true)
    expect(second.applied).toEqual([])
    expect(second.skipped).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(second.plan.status).toBe('IDEMPOTENT_NOOP')
  })

  it('migrationStatus mirrors plan mode', () => {
    const s = migrationStatus({ host: '127.0.0.1', applied: [], cwd })
    expect(s.mode).toBe('status')
    expect(s.status).toBe('READY')
  })
})

describe('authority guards — production / unknown remote refuse apply', () => {
  const cases: Array<{ host: string; cls: DbHostClass }> = [
    { host: 'task-manager.mfsdev.net', cls: 'PRODUCTION' },
    { host: 'db.production.internal', cls: 'PRODUCTION' },
    { host: '10.0.0.5', cls: 'UNKNOWN_REMOTE' },
    { host: 'remote-mysql.example.com', cls: 'UNKNOWN_REMOTE' },
  ]

  for (const c of cases) {
    it(`refuses apply for ${c.host} (${c.cls})`, async () => {
      expect(classifyDbHost(c.host)).toBe(c.cls)
      expect(migrationApplyAllowed(c.cls)).toBe(false)
      const plan = planMigrations({
        host: c.host,
        hostClass: c.cls,
        mode: 'apply',
        applied: [],
        cwd,
      })
      expect(plan.status).toBe('BLOCKED')
      expect(plan.applyAllowed).toBe(false)
      const exec = createMemoryMigrationExecutor()
      const result = await applyMigrations({
        host: c.host,
        hostClass: c.cls,
        applied: [],
        cwd,
        executor: exec,
      })
      expect(result.ok).toBe(false)
      expect(result.applied).toEqual([])
      expect(exec.statements).toHaveLength(0)
      expect(result.error).toMatch(/refused|hostClass/i)
    })
  }

  it('allows LOCAL and STAGING classes', () => {
    expect(migrationApplyAllowed('LOCAL')).toBe(true)
    expect(migrationApplyAllowed('STAGING')).toBe(true)
    expect(classifyDbHost('127.0.0.1')).toBe('LOCAL')
    expect(classifyDbHost('localhost')).toBe('LOCAL')
    expect(classifyDbHost('tm-v3-staging')).toBe('STAGING')
  })

  it('allows only exact backup/release/artifact/db-bound production migration 008', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cp0-prod-auth-'))
    const backup = path.join(dir, 'schema007.sql')
    fs.writeFileSync(backup, '-- verified schema007 backup\n')
    try {
      const migration = loadMigrationManifest(cwd).find((item) => item.version === '008')!
      const base = {
        releaseSha: 'a'.repeat(40),
        approvalId: 'owner-cp0-008',
        migrationVersion: '008' as const,
        migrationSha256: migration.sha256,
        targetHost: 'db.production.internal',
        targetDatabase: 'cairn_taskmanager',
        backupReceiptPath: backup,
        backupSha256: sha256Hex(fs.readFileSync(backup)),
        approvalBinding: '',
        maxBackupAgeHours: 24,
      }
      const authority: ProductionMigrationAuthority = {
        ...base,
        approvalBinding: sha256Hex([
          base.releaseSha,
          base.approvalId,
          base.migrationVersion,
          base.migrationSha256,
          base.targetHost,
          base.targetDatabase,
          base.backupSha256,
        ].join('\0')),
      }
      expect(validateProductionMigrationAuthority(authority, {
        host: base.targetHost,
        database: base.targetDatabase,
        migration,
      })).toBe(true)
      const through007 = loadMigrationManifest(cwd)
        .filter((item) => item.version !== '008')
        .map((item) => ({
          version: item.version,
          filename: item.filename,
          sha256: item.sha256,
          classification: item.classification,
        }))
      const exec = createMemoryMigrationExecutor(through007)
      const result = await applyMigrations({
        host: base.targetHost,
        hostClass: 'PRODUCTION',
        database: base.targetDatabase,
        cwd,
        executor: exec,
        lifecycleMapping: SAFE_MAPPING,
        productionAuthority: authority,
      })
      expect(result.ok).toBe(true)
      expect(result.applied).toEqual(['008'])
      expect(validateProductionMigrationAuthority({ ...authority, targetHost: 'other' }, {
        host: base.targetHost,
        database: base.targetDatabase,
        migration,
      })).toBe(false)
      expect(validateProductionMigrationAuthority({ ...authority, migrationSha256: 'b'.repeat(64) }, {
        host: base.targetHost,
        database: base.targetDatabase,
        migration,
      })).toBe(false)
      expect(validateProductionMigrationAuthority({ ...authority, backupSha256: 'c'.repeat(64) }, {
        host: base.targetHost,
        database: base.targetDatabase,
        migration,
      })).toBe(false)
    } finally {
      fs.rmSync(dir, { recursive: true, force: true })
    }
  })
})

describe('backfill fail-closed contract', () => {
  it('missing proof remains UNCLASSIFIED and never invents PRODUCT', () => {
    const result = dryRunClassificationBackfill([
      { taskId: 't1', classificationProofValid: false },
      { taskId: 't2', taskClass: 'PRODUCT', classificationProofValid: false },
    ])
    expect(result.wouldWrite.every((w) => w.taskClass === 'UNCLASSIFIED')).toBe(
      true,
    )
    expect(result.wouldWrite.find((w) => w.taskId === 't2')!.reason).toMatch(
      /PRODUCT without proof/,
    )
    expect(result.issues.some((i) => i.code === 'MISSING_PROOF')).toBe(true)
  })

  it('rejects duplicate FC joins', () => {
    const result = dryRunClassificationBackfill([
      {
        taskId: 'a',
        featureContractId: 'fc1',
        classificationProofValid: true,
        taskClass: 'CONTROL_PLANE',
        disposition: 'ACTIVE',
      },
      {
        taskId: 'b',
        featureContractId: 'fc1',
        classificationProofValid: true,
        taskClass: 'CONTROL_PLANE',
        disposition: 'ACTIVE',
      },
    ])
    expect(result.rejected).toBe(true)
    expect(result.ok).toBe(false)
    expect(result.issues.some((i) => i.code === 'DUPLICATE_FC_JOIN')).toBe(true)
  })

  it('rejects duplicate node joins', () => {
    const result = dryRunClassificationBackfill([
      { taskId: 'a', nodeId: 'n1', classificationProofValid: true },
      { taskId: 'b', nodeId: 'n1', classificationProofValid: true },
    ])
    expect(result.issues.some((i) => i.code === 'DUPLICATE_NODE_JOIN')).toBe(
      true,
    )
    expect(result.rejected).toBe(true)
  })

  it('rejects conflicting ownership', () => {
    // same task appears with two owners in input stream
    const result = dryRunClassificationBackfill([
      { taskId: 't1', ownerId: 'alice', classificationProofValid: true },
      { taskId: 't1', ownerId: 'bob', classificationProofValid: true },
    ])
    expect(result.issues.some((i) => i.code === 'CONFLICTING_OWNERSHIP')).toBe(
      true,
    )
    expect(result.rejected).toBe(true)
  })

  it('rejects dependency cycles', () => {
    const result = dryRunClassificationBackfill([
      { taskId: 'a', dependencies: ['b'], classificationProofValid: true },
      { taskId: 'b', dependencies: ['c'], classificationProofValid: true },
      { taskId: 'c', dependencies: ['a'], classificationProofValid: true },
    ])
    expect(result.issues.some((i) => i.code === 'DEPENDENCY_CYCLE')).toBe(true)
    expect(result.rejected).toBe(true)
  })

  it('rejects stale data rows', () => {
    const result = dryRunClassificationBackfill([
      {
        taskId: 'old',
        stale: true,
        classificationProofValid: true,
        taskClass: 'CONTROL_PLANE',
        disposition: 'ACTIVE',
      },
    ])
    expect(result.issues.some((i) => i.code === 'STALE_DATA')).toBe(true)
    expect(result.rejected).toBe(true)
  })

  it('accepts clean proof-valid CONTROL_PLANE without structural issues', () => {
    const result = dryRunClassificationBackfill([
      {
        taskId: 'ok1',
        featureContractId: 'fc-a',
        nodeId: 'n-a',
        ownerId: 'alice',
        dependencies: ['ok2'],
        classificationProofValid: true,
        taskClass: 'CONTROL_PLANE',
        disposition: 'ACTIVE',
      },
      {
        taskId: 'ok2',
        featureContractId: 'fc-b',
        nodeId: 'n-b',
        ownerId: 'bob',
        dependencies: [],
        classificationProofValid: true,
        taskClass: 'CONTROL_PLANE',
        disposition: 'ACTIVE',
      },
    ])
    expect(result.ok).toBe(true)
    expect(result.rejected).toBe(false)
    expect(result.wouldWrite).toHaveLength(2)
    expect(result.wouldWrite[0]!.taskClass).toBe('CONTROL_PLANE')
  })
})

describe('lifecycle mapping guard wired into migration plan/apply (AC-LIFE-02)', () => {
  it('G0 identity rows are representable and approve plan + apply', async () => {
    const rows = g0IdentityLifecycleMappingRows()
    expect(rows).toHaveLength(9)
    expect(
      rows.every((r) => r.type === 'IDENTITY' && r.canonical === r.live),
    ).toBe(true)

    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      lifecycleMapping: rows,
    })
    expect(plan.status).toBe('READY')
    expect(plan.mapping?.approved).toBe(true)
    expect(plan.mapping?.decisionCode).toBeNull()
    expect(plan.mapping?.blockingDecisionRequired).toBe(false)
    expect(plan.mapping?.identityCount).toBe(9)
    expect(plan.mapping?.ambiguousStateIds).toEqual([])

    const exec = createMemoryMigrationExecutor()
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: {
        schemaVersion: 'LIFECYCLE_MAPPING_V1',
        mapping: [...rows],
      },
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(result.mapping?.approved).toBe(true)
    expect(exec.statements.length).toBeGreaterThan(0)
    expect(exec.history).toHaveLength(9)
  })

  it('apply missing mapping → DECISION_LIFECYCLE_MAPPING_REQUIRED, zero SQL/history', async () => {
    const exec = createMemoryMigrationExecutor()
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      // lifecycleMapping intentionally omitted
    })
    expect(result.ok).toBe(false)
    expect(result.plan.status).toBe('BLOCKED')
    expect(result.mapping?.decisionCode).toBe(
      'DECISION_LIFECYCLE_MAPPING_REQUIRED',
    )
    expect(result.mapping?.approved).toBe(false)
    expect(result.mapping?.blockingDecisionRequired).toBe(true)
    expect(result.mapping?.ambiguousStateIds).toEqual([])
    expect(result.error).toMatch(/DECISION_LIFECYCLE_MAPPING_REQUIRED/)
    expect(result.applied).toEqual([])
    expect(exec.statements).toHaveLength(0)
    expect(exec.history).toHaveLength(0)
  })

  it('apply null mapping → DECISION_LIFECYCLE_MAPPING_REQUIRED, zero SQL/history', async () => {
    const exec = createMemoryMigrationExecutor()
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: null,
    })
    expect(result.ok).toBe(false)
    expect(result.mapping?.decisionCode).toBe(
      'DECISION_LIFECYCLE_MAPPING_REQUIRED',
    )
    expect(exec.statements).toHaveLength(0)
    expect(exec.history).toHaveLength(0)
  })

  it('plan without mapping remains inspectable (mapping null)', () => {
    const plan = planMigrations({ host: '127.0.0.1', applied: [], cwd })
    expect(plan.status).toBe('READY')
    expect(plan.mapping).toBeNull()
  })

  async function expectBlockedMappingCase(args: {
    rows: ReadonlyArray<LifecycleMappingRow>
    decisionCode: string
    ambiguousStateIds: ReadonlyArray<string>
  }) {
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      lifecycleMapping: args.rows,
    })
    expect(plan.status).toBe('BLOCKED')
    expect(plan.mapping?.approved).toBe(false)
    expect(plan.mapping?.decisionCode).toBe(args.decisionCode)
    expect(plan.mapping?.ambiguousStateIds).toEqual([...args.ambiguousStateIds])
    expect(plan.items.every((i) => i.action === 'BLOCKED')).toBe(true)

    const dry = await dryRunMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      lifecycleMapping: args.rows,
    })
    expect(dry.status).toBe('BLOCKED')
    expect(dry.mapping?.decisionCode).toBe(args.decisionCode)
    expect(dry.mapping?.ambiguousStateIds).toEqual([...args.ambiguousStateIds])

    const exec = createMemoryMigrationExecutor()
    const apply = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: args.rows,
    })
    expect(apply.ok).toBe(false)
    expect(apply.mapping?.decisionCode).toBe(args.decisionCode)
    expect(apply.mapping?.ambiguousStateIds).toEqual([
      ...args.ambiguousStateIds,
    ])
    expect(apply.applied).toEqual([])
    expect(exec.statements).toHaveLength(0)
    expect(exec.history).toHaveLength(0)
  }

  it('SPLIT blocks plan/dry-run/apply with DECISION_LIFECYCLE_SPLIT + state ids; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [{ live: 'DOING', type: 'SPLIT', ambiguity: 'BUILT|FUNCTIONAL' }],
      decisionCode: 'DECISION_LIFECYCLE_SPLIT',
      ambiguousStateIds: ['DOING'],
    })
  })

  it('MERGE blocks with DECISION_LIFECYCLE_MERGE + exact state ids; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [
        { live: 'BUILT_A', type: 'MERGE' },
        { live: 'BUILT_B', type: 'MERGE' },
      ],
      decisionCode: 'DECISION_LIFECYCLE_MERGE',
      ambiguousStateIds: ['BUILT_A', 'BUILT_B'],
    })
  })

  it('UNMAPPED blocks with DECISION_LIFECYCLE_UNMAPPED; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [{ live: 'MYSTERY', type: 'UNMAPPED' }],
      decisionCode: 'DECISION_LIFECYCLE_UNMAPPED',
      ambiguousStateIds: ['MYSTERY'],
    })
  })

  it('malformed empty mapping blocks with DECISION_LIFECYCLE_MAPPING_MALFORMED; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [],
      decisionCode: 'DECISION_LIFECYCLE_MAPPING_MALFORMED',
      ambiguousStateIds: [],
    })
  })

  it('duplicate live keys block with DECISION_LIFECYCLE_MAPPING_MALFORMED; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [
        { live: 'MAPPING', type: 'IDENTITY', canonical: 'MAPPING' },
        { live: 'MAPPING', type: 'RENAME', canonical: 'MAPPED' },
      ],
      decisionCode: 'DECISION_LIFECYCLE_MAPPING_MALFORMED',
      ambiguousStateIds: ['MAPPING'],
    })
  })

  it('mixed SPLIT+UNMAPPED uses DECISION_LIFECYCLE_MAPPING_AMBIGUITY; zero SQL', async () => {
    await expectBlockedMappingCase({
      rows: [
        { live: 'A', type: 'IDENTITY', canonical: 'A' },
        { live: 'B', type: 'SPLIT' },
        { live: 'C', type: 'UNMAPPED' },
      ],
      decisionCode: 'DECISION_LIFECYCLE_MAPPING_AMBIGUITY',
      ambiguousStateIds: ['B', 'C'],
    })
  })

  it('RENAME-only approved mapping may apply (no ad-hoc rewrite)', async () => {
    const rows: LifecycleMappingRow[] = [
      { live: 'REVIEW', canonical: 'FUNCTIONAL', type: 'RENAME' },
      { live: 'DONE', canonical: 'PROD_READY', type: 'RENAME' },
    ]
    const plan = planMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      lifecycleMapping: rows,
    })
    expect(plan.status).toBe('READY')
    expect(plan.mapping?.approved).toBe(true)
    expect(plan.mapping?.renameCount).toBe(2)

    const exec = createMemoryMigrationExecutor()
    const result = await applyMigrations({
      host: '127.0.0.1',
      hostClass: 'LOCAL',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: rows,
    })
    expect(result.ok).toBe(true)
    expect(result.applied).toEqual([
      '000',
      '001',
      '002',
      '003',
      '004',
      '005',
      '006',
      '007',
      '008',
    ])
    expect(exec.statements.length).toBeGreaterThan(0)
  })

  it('resolveMigrationLifecycleMapping apply-missing is deterministic', () => {
    const r = resolveMigrationLifecycleMapping(undefined, 'apply')
    expect(r.blocked).toBe(true)
    expect(r.mapping?.decisionCode).toBe('DECISION_LIFECYCLE_MAPPING_REQUIRED')
    const planMode = resolveMigrationLifecycleMapping(undefined, 'plan')
    expect(planMode.blocked).toBe(false)
    expect(planMode.mapping).toBeNull()
  })

  it('host authority still refuse apply with zero statements even when mapping approved', async () => {
    const exec = createMemoryMigrationExecutor()
    const result = await applyMigrations({
      host: 'task-manager.mfsdev.net',
      hostClass: 'PRODUCTION',
      applied: [],
      cwd,
      executor: exec,
      lifecycleMapping: SAFE_MAPPING,
    })
    expect(result.ok).toBe(false)
    expect(result.plan.status).toBe('BLOCKED')
    expect(result.error).toMatch(/refused|hostClass/i)
    expect(exec.statements).toHaveLength(0)
    expect(exec.history).toHaveLength(0)
  })
})
