/**
 * Staging compose MySQL healthcheck + schema pin + liveness-vs-release contract (TM-P0).
 * Asserts mysql:8.4 portable mysqladmin ping + escaped $$ secret (no MariaDB helper).
 * Schema pins fail closed (no silent :-003). Docker health is liveness only (401|200|503);
 * 503 is never release PASS — release acceptance is authenticated /api/healthz 200.
 *
 * docker compose config runs against a temporary project directory copy so this
 * test never creates, renames, or overwrites deploy/staging/.env.
 */
import { execFileSync } from 'node:child_process'
import {
  copyFileSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const COMPOSE = join(ROOT, 'deploy/staging/docker-compose.yml')

/** Strip full-line YAML comments so prose may mention legacy helpers. */
function nonCommentSource(yml: string): string {
  return yml
    .split('\n')
    .filter((line) => !/^\s*#/.test(line))
    .join('\n')
}

const BASE_ENV_LINES = [
  'RELEASE_SHA=0000000000000000000000000000000000000001',
  'MYSQL_ROOT_PASSWORD=local-dummy-root-NOT-FOR-PROD',
  'CAIRN_DB_USER=cairn_tm_v3',
  'CAIRN_DB_PASSWORD=local-dummy-app-NOT-FOR-PROD',
  'CAIRN_WRITE_TOKEN=local-dummy-write',
  'CAIRN_CSRF_SECRET=local-dummy-csrf-secret-min-32-chars-xx',
]

/** Current-latest schema pins for schema006 deploy (must match env.staging.example). */
const SCHEMA_PINS_006 = ['CAIRN_SCHEMA_VERSION=006', 'CAIRN_MIGRATION_LATEST=006']

const SYNTHETIC_ENV = [...BASE_ENV_LINES, ...SCHEMA_PINS_006].join('\n') + '\n'
const SYNTHETIC_ENV_MISSING_PINS = BASE_ENV_LINES.join('\n') + '\n'

function runComposeConfig(
  envBody: string,
  extraEnv: Record<string, string | undefined> = {},
): { ok: true; out: string } | { ok: false; stderr: string; status: number | null } {
  const dir = mkdtempSync(join(tmpdir(), 'cairn-compose-hc-'))
  const tempCompose = join(dir, 'docker-compose.yml')
  const tempEnv = join(dir, '.env')
  try {
    copyFileSync(COMPOSE, tempCompose)
    writeFileSync(tempEnv, envBody)
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      // Host env must not leak into healthcheck test string or fill missing pins.
      MYSQL_ROOT_PASSWORD: 'host-env-should-not-appear-in-healthcheck',
      CAIRN_SCHEMA_VERSION: undefined,
      CAIRN_MIGRATION_LATEST: undefined,
      ...extraEnv,
    }
    // Explicitly delete so unset vars are truly absent (undefined still may inherit).
    delete env.CAIRN_SCHEMA_VERSION
    delete env.CAIRN_MIGRATION_LATEST
    for (const [k, v] of Object.entries(extraEnv)) {
      if (v === undefined) delete env[k]
      else env[k] = v
    }
    try {
      const out = execFileSync(
        'docker',
        ['compose', '-f', tempCompose, '--env-file', tempEnv, 'config', '--format', 'json'],
        {
          encoding: 'utf8',
          env,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      )
      return { ok: true, out }
    } catch (err) {
      const e = err as { status?: number | null; stderr?: string | Buffer; message?: string }
      const stderr =
        typeof e.stderr === 'string'
          ? e.stderr
          : Buffer.isBuffer(e.stderr)
            ? e.stderr.toString('utf8')
            : String(e.message ?? err)
      return { ok: false, stderr, status: e.status ?? null }
    }
  } finally {
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('staging mysql healthcheck compose contract', () => {
  it('source uses portable mysqladmin ping with $$MYSQL_ROOT_PASSWORD and no healthcheck.sh', () => {
    const yml = readFileSync(COMPOSE, 'utf8')
    const body = nonCommentSource(yml)
    expect(body, 'must not reference MariaDB-only healthcheck.sh in live config').not.toMatch(
      /healthcheck\.sh/,
    )
    expect(body).toMatch(/mysqladmin/)
    // Double-dollar must remain in source so host Compose does not interpolate the secret.
    expect(body).toMatch(/\$\$MYSQL_ROOT_PASSWORD/)
    expect(body).toMatch(/image:\s*mysql:8\.4/)
    expect(body).toMatch(/interval:\s*10s/)
    expect(body).toMatch(/timeout:\s*5s/)
    expect(body).toMatch(/retries:\s*12/)
    expect(body).toMatch(/start_period:\s*30s/)
    expect(body).toMatch(/condition:\s*service_healthy/)
    expect(body).toMatch(/127\.0\.0\.1:33211:3210/)
  })

  it('source fails closed on schema pins (required env, no silent :-003 default)', () => {
    const yml = readFileSync(COMPOSE, 'utf8')
    const body = nonCommentSource(yml)
    // Must not silently default schema/migration pins to stale 003 (or any :-N).
    expect(body).not.toMatch(/CAIRN_SCHEMA_VERSION:\$\{CAIRN_SCHEMA_VERSION:-[0-9]+\}/)
    expect(body).not.toMatch(/CAIRN_MIGRATION_LATEST:\$\{CAIRN_MIGRATION_LATEST:-[0-9]+\}/)
    expect(body).not.toMatch(/CAIRN_SCHEMA_VERSION:\$\{CAIRN_SCHEMA_VERSION:-\}/)
    expect(body).not.toMatch(/CAIRN_MIGRATION_LATEST:\$\{CAIRN_MIGRATION_LATEST:-\}/)
    // Fail-closed required-var form: ${VAR:?message}
    expect(body).toMatch(
      /CAIRN_SCHEMA_VERSION:\s*\$\{CAIRN_SCHEMA_VERSION:\?[^}]+\}/,
    )
    expect(body).toMatch(
      /CAIRN_MIGRATION_LATEST:\s*\$\{CAIRN_MIGRATION_LATEST:\?[^}]+\}/,
    )
  })

  it('app healthcheck is liveness-only (401|200|503) and never encodes 503 as release PASS', () => {
    const yml = readFileSync(COMPOSE, 'utf8')
    const body = nonCommentSource(yml)
    // Docker healthcheck accepts unauth 401 (auth gate), 200, and 503 (up but unhealthy).
    expect(body).toMatch(/r\.status===401\|\|r\.status===200\|\|r\.status===503/)
    // Full file (comments included) must document that 503 is not release PASS.
    expect(yml).toMatch(/503.*(?:not|NOT|never|NEVER).*(?:release|PASS|pass)/i)
    expect(yml).toMatch(/LIVENESS|liveness/)
    expect(yml).toMatch(/authenticated/i)
  })

  it('docker compose config is valid with pins 006; healthcheck keeps $MYSQL_ROOT_PASSWORD', () => {
    const result = runComposeConfig(SYNTHETIC_ENV, {
      MYSQL_ROOT_PASSWORD: 'host-env-should-not-appear-in-healthcheck',
    })
    expect(result.ok, result.ok ? '' : result.stderr).toBe(true)
    if (!result.ok) return

    const cfg = JSON.parse(result.out) as {
      services: Record<
        string,
        {
          healthcheck?: { test?: string | string[] }
          depends_on?: Record<string, { condition?: string } | string>
          ports?: unknown
          image?: string
          environment?: Record<string, string | null>
        }
      >
    }

    const mysql = cfg.services['cairn-tm-v3-mysql']
    const app = cfg.services['cairn-tm-v3-app']
    expect(mysql, 'mysql service present').toBeTruthy()
    expect(app, 'app service present').toBeTruthy()
    expect(mysql.image).toMatch(/mysql:8\.4/)

    // Schema pins resolve to current latest 006 (not stale 003).
    const env = app.environment ?? {}
    expect(env.CAIRN_SCHEMA_VERSION).toBe('006')
    expect(env.CAIRN_MIGRATION_LATEST).toBe('006')

    const test = mysql.healthcheck?.test
    const testStr = Array.isArray(test) ? test.join(' ') : String(test ?? '')
    expect(testStr).toMatch(/mysqladmin/)
    expect(testStr).not.toMatch(/healthcheck\.sh/)
    // After Compose parse, $$ → $; container shell expands MYSQL_ROOT_PASSWORD.
    expect(testStr).toMatch(/\$MYSQL_ROOT_PASSWORD/)
    expect(testStr).not.toMatch(/local-dummy-root-NOT-FOR-PROD/)
    expect(testStr).not.toMatch(/host-env-should-not-appear-in-healthcheck/)

    const appHc = app.healthcheck?.test
    const appHcStr = Array.isArray(appHc) ? appHc.join(' ') : String(appHc ?? '')
    // Liveness contract: 401|200|503 — not "503 means release ready".
    expect(appHcStr).toMatch(/401/)
    expect(appHcStr).toMatch(/200/)
    expect(appHcStr).toMatch(/503/)
    expect(appHcStr).toMatch(/healthz/)

    const dep = app.depends_on?.['cairn-tm-v3-mysql']
    const cond =
      typeof dep === 'object' && dep !== null && 'condition' in dep
        ? dep.condition
        : undefined
    expect(cond).toBe('service_healthy')
  })

  it('docker compose config fails closed when CAIRN_SCHEMA_VERSION / CAIRN_MIGRATION_LATEST absent', () => {
    const result = runComposeConfig(SYNTHETIC_ENV_MISSING_PINS)
    expect(result.ok).toBe(false)
    if (result.ok) return
    // Compose error must name the required pin variable(s).
    expect(result.stderr).toMatch(/CAIRN_SCHEMA_VERSION|CAIRN_MIGRATION_LATEST/)
    expect(result.status === null || result.status !== 0).toBe(true)
  })

  it('deploy/status scripts encode 503 as liveness-not-release-PASS (contract text)', () => {
    const deploy = readFileSync(join(ROOT, 'deploy/staging/scripts/deploy.sh'), 'utf8')
    const status = readFileSync(join(ROOT, 'deploy/staging/scripts/status.sh'), 'utf8')
    expect(deploy).toMatch(/503 is NOT release PASS/)
    expect(deploy).toMatch(/authenticated GET \/api\/healthz/)
    expect(deploy).toMatch(/HTTP 200/)
    expect(status).toMatch(/503_is_liveness_not_release_PASS|NOT release PASS/)
    expect(status).toMatch(/LIVENESS/)
    expect(status).toMatch(/authenticated/)
  })
})
