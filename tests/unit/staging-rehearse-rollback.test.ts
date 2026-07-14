/**
 * Staging rollback rehearsal runner — non-mutating contract tests.
 *
 * Exercises fail-closed gates on deploy/staging/scripts/rehearse-rollback.sh
 * via dry-run / missing-input invocations. Does NOT docker-compose mutate,
 * does NOT SSH staging, does NOT edit existing deploy scripts.
 */
import { execFileSync, spawnSync } from 'node:child_process'
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
import { afterAll, describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'deploy/staging/scripts/rehearse-rollback.sh')
const STAGING_SCRIPTS = join(ROOT, 'deploy/staging/scripts')

const CURRENT =
  'b207830e50d6e0a98c58ea9c3d9c14a4a9019e1a'
const PREVIOUS =
  '34317016f46fa3bb197f3811eb84ee18d32e7da7'
const FRESH_APPROVAL = 'rehearse-test-20260714T043159Z-fresh01'

const tmpDirs: string[] = []

function makeMarker(extra = ''): string {
  const dir = mkdtempSync(join(tmpdir(), 'rehearse-marker-'))
  tmpDirs.push(dir)
  const path = join(dir, 'BACKUP_MARKER.txt')
  writeFileSync(
    path,
    [
      `created_at=20260714T034825Z`,
      `previous_sha=${PREVIOUS}`,
      `target_sha=${CURRENT}`,
      `rollback_sha=${PREVIOUS}`,
      `mode=app-only-no-db-mutate`,
      `no_db_mutate=1`,
      `schema=006`,
      `migration=006`,
      `volume=cairn-tm-v3-mysql-data`,
      `approval_id=deploy-approval-NOT-rehearse`,
      extra,
    ]
      .filter(Boolean)
      .join('\n') + '\n',
    { mode: 0o600 },
  )
  return path
}

function runRehearse(
  args: string[],
  env: NodeJS.ProcessEnv = {},
): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync('bash', [SCRIPT, ...args], {
    cwd: ROOT,
    env: {
      ...process.env,
      // Isolate from accidental host production/staging secrets
      CAIRN_ENV: 'staging',
      REHEARSE_DRY_RUN: '1',
      STAGING_ROLLBACK_MUTATION_APPROVED: '0',
      // schema pins for gate 4 without real .env
      CAIRN_SCHEMA_VERSION: '006',
      CAIRN_MIGRATION_LATEST: '006',
      ...env,
    },
    encoding: 'utf8',
  })
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  }
}

afterAll(() => {
  for (const d of tmpDirs) {
    rmSync(d, { recursive: true, force: true })
  }
})

describe('staging rehearse-rollback package layout', () => {
  it('ships unique runner under deploy/staging/scripts/rehearse-rollback.sh', () => {
    expect(existsSync(SCRIPT)).toBe(true)
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src.startsWith('#!/usr/bin/env bash')).toBe(true)
    expect(src).toMatch(/PRIOR_SHA|previous-sha|PREVIOUS_SHA/)
    expect(src).toMatch(/CURRENT_SHA|current-sha/)
    expect(src).toMatch(/BACKUP_MARKER|backup-marker/)
    expect(src).toMatch(/approval-id|STAGING_ROLLBACK_APPROVAL_ID/)
    expect(src).toMatch(/app-only|APP_ONLY|--no-deps/)
    expect(src).toMatch(/MYSQL_VOLUME|volume preserv|StartedAt/i)
    expect(src).toMatch(/greenfield/i)
    expect(src).toMatch(/production/i)
    expect(src).toMatch(/AC-ROLL-01/)
    expect(src).toMatch(/AC-ROLL-02/)
    expect(src).toMatch(/CLEANUP/)
    // Must not implement greenfield wipe as success path
    expect(src).toMatch(/FORBIDDEN|banned|refuse/i)
  })

  it('is executable', () => {
    chmodSync(SCRIPT, 0o755)
    // Node fs mode check: owner execute bit
    const st = execFileSync('bash', ['-c', `test -x '${SCRIPT}' && echo EXEC_OK`], {
      encoding: 'utf8',
    })
    expect(st.trim()).toBe('EXEC_OK')
  })

  it('does not replace existing rollback.sh / deploy.sh (sibling files remain)', () => {
    expect(existsSync(join(STAGING_SCRIPTS, 'rollback.sh'))).toBe(true)
    expect(existsSync(join(STAGING_SCRIPTS, 'deploy.sh'))).toBe(true)
    expect(existsSync(join(STAGING_SCRIPTS, 'common.sh'))).toBe(true)
  })
})

describe('staging rehearse-rollback fail-closed gates (non-mutating)', () => {
  it('refuses missing current/previous SHA', () => {
    const r = runRehearse([])
    expect(r.status).not.toBe(0)
    const combined = r.stdout + r.stderr
    expect(combined).toMatch(/CURRENT_SHA|current-sha|required/i)
  })

  it('refuses short SHA', () => {
    const marker = makeMarker()
    const r = runRehearse([
      '--current-sha',
      'b207830',
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      FRESH_APPROVAL,
      '--backup-marker',
      marker,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/40-char|full|hex/i)
  })

  it('refuses identical current and previous SHA', () => {
    const marker = makeMarker()
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      CURRENT,
      '--approval-id',
      FRESH_APPROVAL,
      '--backup-marker',
      marker,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/must differ|identical/i)
  })

  it('refuses missing approval id', () => {
    const marker = makeMarker()
    const r = runRehearse(
      [
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--backup-marker',
        marker,
      ],
      { STAGING_ROLLBACK_APPROVAL_ID: '' },
    )
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/approval/i)
  })

  it('refuses placeholder approval id', () => {
    const marker = makeMarker()
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      'REPLACE_ME',
      '--backup-marker',
      marker,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/placeholder|stale|REPLACE_ME/i)
  })

  it('refuses missing backup marker', () => {
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      FRESH_APPROVAL,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/BACKUP_MARKER|backup-marker/i)
  })

  it('refuses nonexistent backup marker path', () => {
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      FRESH_APPROVAL,
      '--backup-marker',
      '/tmp/does-not-exist-rehearse-marker-xyz.txt',
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/missing|not found|backup marker/i)
  })

  it('refuses reusing marker approval_id as rehearsal approval (must be fresh)', () => {
    const marker = makeMarker()
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      'deploy-approval-NOT-rehearse',
      '--backup-marker',
      marker,
    ])
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/FRESH|equals marker/i)
  })

  it('refuses greenfield / wipe / production flags', () => {
    const marker = makeMarker()
    for (const bad of [
      '--greenfield',
      '--wipe',
      '--stop-wipe-volume',
      '--production',
    ] as const) {
      const r = runRehearse([
        bad,
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--approval-id',
        FRESH_APPROVAL,
        '--backup-marker',
        marker,
      ])
      expect(r.status, bad).not.toBe(0)
      expect(r.stdout + r.stderr).toMatch(/FORBIDDEN|banned|greenfield|production|wipe/i)
    }
  })

  it('refuses production CAIRN_ENV context', () => {
    const marker = makeMarker()
    const r = runRehearse(
      [
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--approval-id',
        FRESH_APPROVAL,
        '--backup-marker',
        marker,
      ],
      { CAIRN_ENV: 'production' },
    )
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/production|forbidden/i)
  })

  it('refuses execute without STAGING_ROLLBACK_MUTATION_APPROVED=1', () => {
    const marker = makeMarker()
    const r = runRehearse(
      [
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--approval-id',
        FRESH_APPROVAL,
        '--backup-marker',
        marker,
        '--execute',
      ],
      {
        STAGING_ROLLBACK_MUTATION_APPROVED: '0',
        REHEARSE_DRY_RUN: '0',
      },
    )
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(
      /MUTATION_APPROVED|mutation refused|STAGING_ROLLBACK_MUTATION_APPROVED/i,
    )
  })

  it('dry-run preflight passes with full exact SHAs + fresh approval + marker', () => {
    const marker = makeMarker()
    const r = runRehearse([
      '--current-sha',
      CURRENT,
      '--previous-sha',
      PREVIOUS,
      '--approval-id',
      FRESH_APPROVAL,
      '--backup-marker',
      marker,
      '--dry-run',
    ])
    expect(r.status, r.stdout + r.stderr).toBe(0)
    const out = r.stdout + r.stderr
    expect(out).toMatch(/GATES_OK/)
    expect(out).toMatch(/REHEARSE_ROLLBACK_PLAN|REHEARSE_ROLLBACK_DRY_RUN_OK/)
    expect(out).toMatch(new RegExp(CURRENT))
    expect(out).toMatch(new RegExp(PREVIOUS))
    expect(out).toMatch(/BACKUP_MARKER_OK/)
    expect(out).toMatch(/SCHEMA_COMPAT/)
    expect(out).toMatch(/APP_ONLY|app-only|no-deps/i)
    expect(out).toMatch(/FORBIDDEN: production, greenfield/)
    // Must not claim live AC-ROLL proof on dry-run
    expect(out).not.toMatch(/AC-ROLL-01: PROVEN/)
    expect(out).not.toMatch(/REHEARSE_ROLLBACK_OK/)
  })

  it('fail-closed without schema pins unless SCHEMA_COMPATIBLE=1', () => {
    const marker = makeMarker()
    const r = runRehearse(
      [
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--approval-id',
        FRESH_APPROVAL,
        '--backup-marker',
        marker,
        '--dry-run',
      ],
      {
        CAIRN_SCHEMA_VERSION: '',
        CAIRN_MIGRATION_LATEST: '',
        SCHEMA_COMPATIBLE: '',
      },
    )
    expect(r.status).not.toBe(0)
    expect(r.stdout + r.stderr).toMatch(/schema/i)
  })

  it('accepts SCHEMA_COMPATIBLE=1 when pins absent (operator assert app-only class)', () => {
    const marker = makeMarker()
    const r = runRehearse(
      [
        '--current-sha',
        CURRENT,
        '--previous-sha',
        PREVIOUS,
        '--approval-id',
        FRESH_APPROVAL,
        '--backup-marker',
        marker,
        '--schema-compatible',
        '--dry-run',
      ],
      {
        CAIRN_SCHEMA_VERSION: '',
        CAIRN_MIGRATION_LATEST: '',
      },
    )
    expect(r.status, r.stdout + r.stderr).toBe(0)
    expect(r.stdout + r.stderr).toMatch(/SCHEMA_COMPATIBLE=1|GATES_OK/)
  })
})

describe('staging rehearse-rollback source safety invariants', () => {
  it('never wires greenfield teardown or down -v as success path', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    // Strip comments — banned phrases may appear in hard-ban docs; code must not invoke them.
    const codeOnly = src
      .split('\n')
      .filter((line) => !/^\s*#/.test(line))
      .join('\n')
    expect(codeOnly).not.toMatch(/compose\s+down\s+(-v|--volumes)/)
    expect(codeOnly).not.toMatch(/docker\s+volume\s+rm/)
    expect(codeOnly).not.toMatch(/MODE=greenfield|greenfield\)/)
    expect(src).toMatch(/--force-recreate\s+--no-deps/)
    expect(src).toMatch(/STAGING_ROLLBACK_MUTATION_APPROVED/)
  })

  it('requires both previous and current legs in plan text', () => {
    const src = readFileSync(SCRIPT, 'utf8')
    expect(src).toMatch(/pin RELEASE_SHA=PREVIOUS|PREVIOUS_SHA/)
    expect(src).toMatch(/pin RELEASE_SHA=CURRENT|CURRENT_SHA/)
    expect(src).toMatch(/health_smoke|PRIOR|CURRENT/)
    expect(src).toMatch(/assert_mysql_volume_preserved|MYSQL_VOLUME_PRESERVED/)
  })
})
