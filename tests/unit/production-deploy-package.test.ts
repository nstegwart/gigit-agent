/**
 * Production PM2 release package — unit + self-test wiring.
 * Asserts fail-closed approval, nginx :3210 upstream, env keys-without-values,
 * migrate authority, rollback classification, and package layout.
 * Does NOT deploy or contact production.
 */
import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const PROD = join(ROOT, 'deploy/production')
const SCRIPTS = join(PROD, 'scripts')
const GATES = join(PROD, 'lib/gates.mjs')
const RUNBOOK = join(ROOT, 'docs/runbook-production.md')

const SCRIPT_NAMES = [
  'common.sh',
  'preflight.sh',
  'build-install.sh',
  'migrate-plan.sh',
  'migrate-apply.sh',
  'pm2-atomic.sh',
  'health-readback.sh',
  'rollback.sh',
  'release.sh',
] as const

describe('production deploy package layout', () => {
  it('ships required files under deploy/production/**', () => {
    expect(existsSync(join(PROD, 'README.md'))).toBe(true)
    expect(existsSync(join(PROD, 'env.production.example'))).toBe(true)
    expect(existsSync(GATES)).toBe(true)
    expect(existsSync(join(PROD, 'selftest/selftest.sh'))).toBe(true)
    expect(existsSync(join(PROD, 'selftest/selftest.mjs'))).toBe(true)
    expect(existsSync(RUNBOOK)).toBe(true)
    for (const name of SCRIPT_NAMES) {
      expect(existsSync(join(SCRIPTS, name)), name).toBe(true)
    }
  })

  it('runbook pins production PM2 contract (not staging docker)', () => {
    const md = readFileSync(RUNBOOK, 'utf8')
    expect(md).toMatch(/127\.0\.0\.1:3210/)
    expect(md).toMatch(/APPROVED_FULL_SHA/)
    expect(md).toMatch(/PRODUCTION_APPROVAL_ID/)
    expect(md).toMatch(/BACKUP_RECEIPT/)
    expect(md).toMatch(/DB_FORWARD_FIX_ONLY/)
    expect(md).toMatch(/cairn-taskmanager/)
    expect(md).toMatch(/PRODUCTION_MUTATION_APPROVED/)
    expect(md).toMatch(/DEFAULT-ON|defaults to `1`|defaults to 1/i)
    expect(md).toMatch(/MIGRATE_ENTRYPOINT_MISSING|migrate entrypoint/i)
    expect(md).toMatch(/lowercase/)
    expect(md).not.toMatch(/127\.0\.0\.1:33211/)
  })

  it('env example documents fail-closed approval keys without real secrets', () => {
    const env = readFileSync(join(PROD, 'env.production.example'), 'utf8')
    expect(env).toMatch(/APPROVED_FULL_SHA=/)
    expect(env).toMatch(/PRODUCTION_APPROVAL_ID=/)
    expect(env).toMatch(/BACKUP_RECEIPT=/)
    expect(env).toMatch(/MIGRATE_APPLY_APPROVED/)
    expect(env).toMatch(/PRODUCTION_MUTATION_APPROVED/)
    expect(env).toMatch(/lowercase/)
    expect(env).not.toMatch(/password\s*=\s*[^\s#]{8,}/i)
  })

  it('common.sh defaults dry-run on and gates mutation opt-in', () => {
    const common = readFileSync(join(SCRIPTS, 'common.sh'), 'utf8')
    expect(common).toMatch(/PRODUCTION_DRY_RUN="\$\{PRODUCTION_DRY_RUN:-1\}"/)
    expect(common).toMatch(/require_mutation_opt_in/)
    expect(common).toMatch(/PRODUCTION_MUTATION_APPROVED/)
    expect(common).toMatch(/resolve_migrate_entrypoint/)
    expect(common).toMatch(/MIGRATE_ENTRYPOINT_MISSING/)
  })

  it('pm2-atomic requires pm2 only on mutation branch', () => {
    const src = readFileSync(join(SCRIPTS, 'pm2-atomic.sh'), 'utf8')
    // require_cmd pm2 must appear after maybe_dry_run / inside else branch
    const dryIdx = src.indexOf('maybe_dry_run "pm2-atomic"')
    const pm2Idx = src.indexOf('require_cmd pm2')
    expect(dryIdx).toBeGreaterThan(-1)
    expect(pm2Idx).toBeGreaterThan(dryIdx)
  })
})

describe('production gates.mjs', () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  let gates: any
  const tmpDirs: string[] = []

  beforeAll(async () => {
    gates = await import(pathToFileURL(GATES).href)
  })

  afterAll(() => {
    for (const d of tmpDirs) {
      rmSync(d, { recursive: true, force: true })
    }
  })

  it('PROD_CONTRACT matches investigation upstream 3210', () => {
    expect(gates.PROD_CONTRACT.listenPort).toBe(3210)
    expect(gates.PROD_CONTRACT.nginxUpstream).toBe('http://127.0.0.1:3210')
    expect(gates.PROD_CONTRACT.appName).toBe('cairn-taskmanager')
    expect(gates.PROD_CONTRACT.appPathDefault).toBe(
      '/home/gian.devx/cairn-taskmanager',
    )
    expect(gates.PROD_CONTRACT.approvalEnvKeys).toEqual([
      'APPROVED_FULL_SHA',
      'PRODUCTION_APPROVAL_ID',
      'BACKUP_RECEIPT',
    ])
  })

  it('requireApprovalBundle fails closed when any key absent', () => {
    const r = gates.requireApprovalBundle({})
    expect(r.ok).toBe(false)
    expect(r.code).toBe('MISSING_APPROVAL_BUNDLE')
    expect(r.missing).toContain('APPROVED_FULL_SHA')
    expect(r.missing).toContain('PRODUCTION_APPROVAL_ID')
    expect(r.missing).toContain('BACKUP_RECEIPT')
  })

  it('requireApprovalBundle rejects short SHA', () => {
    const r = gates.requireApprovalBundle({
      APPROVED_FULL_SHA: 'abc123',
      PRODUCTION_APPROVAL_ID: 'ticket',
      BACKUP_RECEIPT: '/tmp/x',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_APPROVED_FULL_SHA')
  })

  it('assertFullSha enforces canonical lowercase (rejects uppercase)', () => {
    const lower = 'c'.repeat(40)
    expect(gates.assertFullSha(lower).ok).toBe(true)
    expect(gates.assertFullSha(lower).sha).toBe(lower)
    const upper = 'C'.repeat(40)
    const r = gates.assertFullSha(upper)
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_APPROVED_FULL_SHA')
    expect(r.message).toMatch(/lowercase/i)
    const mixed = 'Ab' + 'c'.repeat(38)
    expect(gates.assertFullSha(mixed).ok).toBe(false)
  })

  it('requireApprovalBundle rejects uppercase full SHA', () => {
    const r = gates.requireApprovalBundle({
      APPROVED_FULL_SHA: 'A'.repeat(40),
      PRODUCTION_APPROVAL_ID: 'owner-1',
      BACKUP_RECEIPT: '/tmp/receipt',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('INVALID_APPROVED_FULL_SHA')
  })

  it('requireApprovalBundle accepts full bundle', () => {
    const sha = 'c'.repeat(40)
    const r = gates.requireApprovalBundle({
      APPROVED_FULL_SHA: sha,
      PRODUCTION_APPROVAL_ID: 'owner-1',
      BACKUP_RECEIPT: '/tmp/receipt',
    })
    expect(r.ok).toBe(true)
    expect(r.approvedFullSha).toBe(sha)
  })

  it('listEnvKeysOnly never returns values', () => {
    const keys = gates.listEnvKeysOnly(
      'CAIRN_DB_PASSWORD=super-secret-value\nCAIRN_DB_HOST=db.example\n',
    )
    expect(keys).toEqual(['CAIRN_DB_PASSWORD', 'CAIRN_DB_HOST'])
    expect(keys.join(' ')).not.toMatch(/super-secret/)
  })

  it('assertEnvKeysPresent requires production CAIRN keys', () => {
    const missing = gates.assertEnvKeysPresent(['CAIRN_DB_HOST'])
    expect(missing.ok).toBe(false)
    const ok = gates.assertEnvKeysPresent([...gates.PROD_CONTRACT.envKeysRequired])
    expect(ok.ok).toBe(true)
  })

  it('parseNginxUpstream requires 127.0.0.1:3210', () => {
    const ok = gates.parseNginxUpstream(
      'location / { proxy_pass http://127.0.0.1:3210; }',
    )
    expect(ok.ok).toBe(true)
    const bad = gates.parseNginxUpstream(
      'location / { proxy_pass http://127.0.0.1:3000; }',
    )
    expect(bad.ok).toBe(false)
    expect(bad.code).toBe('NGINX_UPSTREAM_MISMATCH')
  })

  it('assertBackupAuthority requires non-empty file', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-ut-'))
    tmpDirs.push(dir)
    const path = join(dir, 'dump.sql')
    expect(gates.assertBackupAuthority({ receiptPath: path }).ok).toBe(false)
    writeFileSync(path, '-- dump\n')
    const r = gates.assertBackupAuthority({ receiptPath: path })
    expect(r.ok).toBe(true)
    expect(r.fingerprint16).toMatch(/^[0-9a-f]{16}$/)
  })

  it('requireMigrateApplyAuthority needs MIGRATE_APPLY_APPROVED + dump', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-ut-mig-'))
    tmpDirs.push(dir)
    const path = join(dir, 'dump.sql')
    writeFileSync(path, '/* fresh dump */\n')
    const sha = 'd'.repeat(40)
    const base = {
      APPROVED_FULL_SHA: sha,
      PRODUCTION_APPROVAL_ID: 'mig-1',
      BACKUP_RECEIPT: path,
    }
    expect(gates.requireMigrateApplyAuthority(base).ok).toBe(false)
    expect(
      gates.requireMigrateApplyAuthority({
        ...base,
        MIGRATE_APPLY_APPROVED: '1',
      }).ok,
    ).toBe(true)
  })

  it('classifyRollback covers app-only / forward-fix / dump restore', () => {
    const sha = 'e'.repeat(40)
    expect(
      gates.classifyRollback({ priorFullSha: sha, schemaMoved: false }).class,
    ).toBe('APP_ONLY_PRIOR_SHA')
    expect(
      gates.classifyRollback({
        priorFullSha: sha,
        schemaMoved: true,
        hasDbDump: false,
      }).class,
    ).toBe('DB_FORWARD_FIX_ONLY')
    expect(
      gates.classifyRollback({
        priorFullSha: sha,
        schemaMoved: true,
        hasDbDump: true,
        dumpRestorable: true,
      }).class,
    ).toBe('APP_PLUS_DB_RESTORE')
  })

  it('classifyHealthReadback separates liveness from release PASS', () => {
    const sha = 'f'.repeat(40)
    const live = gates.classifyHealthReadback({ loopbackStatus: 401 })
    expect(live.liveness).toBe(true)
    expect(live.releasePass).toBe(false)
    const pass = gates.classifyHealthReadback({
      loopbackStatus: 200,
      loopbackBody: { deployedSha: sha },
      approvedFullSha: sha,
    })
    expect(pass.releasePass).toBe(true)
  })

  it('preflightGitHostPath flags HEAD !== approved', () => {
    const a = '1'.repeat(40)
    const b = '2'.repeat(40)
    const r = gates.preflightGitHostPath({
      appPath: '/home/gian.devx/cairn-taskmanager',
      approvedFullSha: a,
      headSha: b,
    })
    expect(r.ok).toBe(false)
    expect(r.errors.some((e: { code: string }) => e.code === 'HEAD_NOT_APPROVED_SHA')).toBe(
      true,
    )
  })
})

describe('production package shell/node self-tests', () => {
  it('node selftest exits 0', () => {
    const out = execFileSync('node', [join(PROD, 'selftest/selftest.mjs')], {
      encoding: 'utf8',
      cwd: ROOT,
    })
    expect(out).toMatch(/SELFTEST_OK/)
  })

  it('shell selftest exits 0', () => {
    const script = join(PROD, 'selftest/selftest.sh')
    chmodSync(script, 0o755)
    for (const name of SCRIPT_NAMES) {
      if (name === 'common.sh') continue
      chmodSync(join(SCRIPTS, name), 0o755)
    }
    const out = execFileSync('bash', [script], {
      encoding: 'utf8',
      cwd: ROOT,
      env: { ...process.env },
    })
    expect(out).toMatch(/SELFTEST_OK/)
  }, 60_000)

  it('preflight fails closed without approval env (exit != 0)', () => {
    const env = { ...process.env }
    delete env.APPROVED_FULL_SHA
    delete env.PRODUCTION_APPROVAL_ID
    delete env.BACKUP_RECEIPT
    let status: number | null = 0
    let stderr = ''
    try {
      execFileSync('bash', [join(SCRIPTS, 'preflight.sh')], {
        encoding: 'utf8',
        cwd: ROOT,
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: string; stdout?: string }
      status = err.status ?? 1
      stderr = `${err.stderr || ''}${err.stdout || ''}`
    }
    expect(status).not.toBe(0)
    expect(stderr).toMatch(/APPROVED_FULL_SHA|approval|MISSING|ERROR/i)
  })

  it('pm2-atomic dry-run succeeds without pm2 binary (default dry-run)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-ut-pm2-'))
    const receipt = join(dir, 'receipt.txt')
    writeFileSync(receipt, 'ut-backup-receipt\n')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim()
    const out = execFileSync('bash', [join(SCRIPTS, 'pm2-atomic.sh')], {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        APPROVED_FULL_SHA: sha,
        PRODUCTION_APPROVAL_ID: 'ut-dry-pm2',
        BACKUP_RECEIPT: receipt,
        PREFLIGHT_REQUIRE_HEAD_MATCH: '0',
        // leave PRODUCTION_DRY_RUN unset → default 1
      },
    })
    expect(out).toMatch(/PM2_ATOMIC_OK/)
    expect(out).toMatch(/dry_run=1|DRY_RUN/)
    expect(out).not.toMatch(/missing required command: pm2/i)
    rmSync(dir, { recursive: true, force: true })
  })

  it('mutation without PRODUCTION_MUTATION_APPROVED fails when DRY_RUN=0', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-ut-mut-'))
    const receipt = join(dir, 'receipt.txt')
    writeFileSync(receipt, 'ut-backup-receipt\n')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim()
    let status: number | null = 0
    let combined = ''
    try {
      execFileSync('bash', [join(SCRIPTS, 'pm2-atomic.sh')], {
        encoding: 'utf8',
        cwd: ROOT,
        env: {
          ...process.env,
          APPROVED_FULL_SHA: sha,
          PRODUCTION_APPROVAL_ID: 'ut-mut',
          BACKUP_RECEIPT: receipt,
          PRODUCTION_DRY_RUN: '0',
          PRODUCTION_MUTATION_APPROVED: '0',
          PREFLIGHT_REQUIRE_HEAD_MATCH: '0',
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
    } catch (e: unknown) {
      const err = e as { status?: number; stderr?: string; stdout?: string }
      status = err.status ?? 1
      combined = `${err.stderr || ''}${err.stdout || ''}`
    }
    expect(status).not.toBe(0)
    expect(combined).toMatch(/mutation refuse|PRODUCTION_MUTATION_APPROVED/i)
    rmSync(dir, { recursive: true, force: true })
  })

  it('migrate-plan dry-run validates proven entrypoint (not unproven fallback)', () => {
    const dir = mkdtempSync(join(tmpdir(), 'prod-ut-migplan-'))
    const receipt = join(dir, 'receipt.txt')
    writeFileSync(receipt, 'ut-backup-receipt\n')
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: ROOT,
    }).trim()
    const out = execFileSync('bash', [join(SCRIPTS, 'migrate-plan.sh')], {
      encoding: 'utf8',
      cwd: ROOT,
      env: {
        ...process.env,
        APPROVED_FULL_SHA: sha,
        PRODUCTION_APPROVAL_ID: 'ut-migplan',
        BACKUP_RECEIPT: receipt,
        // default dry-run
      },
    })
    expect(out).toMatch(/MIGRATE_ENTRYPOINT_OK/)
    expect(out).toMatch(/MIGRATE_PLAN_OK/)
    expect(out).toMatch(/DRY_RUN_CMD:/)
    rmSync(dir, { recursive: true, force: true })
  })
})
