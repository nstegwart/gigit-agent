/**
 * Staging compose MySQL healthcheck contract (TM-P0).
 * Asserts mysql:8.4 portable mysqladmin ping + escaped $$ secret (no MariaDB helper).
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

const SYNTHETIC_ENV = [
  'RELEASE_SHA=0000000000000000000000000000000000000001',
  'MYSQL_ROOT_PASSWORD=local-dummy-root-NOT-FOR-PROD',
  'CAIRN_DB_USER=cairn_tm_v3',
  'CAIRN_DB_PASSWORD=local-dummy-app-NOT-FOR-PROD',
  'CAIRN_WRITE_TOKEN=local-dummy-write',
  'CAIRN_CSRF_SECRET=local-dummy-csrf-secret-min-32-chars-xx',
].join('\n') + '\n'

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

  it('docker compose config is valid; healthcheck keeps $MYSQL_ROOT_PASSWORD (not host-expanded)', () => {
    // env_file path: .env is relative to the compose file directory. Copy compose into a
    // temp project dir and place synthetic secrets there — never touch deploy/staging/.env.
    const dir = mkdtempSync(join(tmpdir(), 'cairn-compose-hc-'))
    const tempCompose = join(dir, 'docker-compose.yml')
    const tempEnv = join(dir, '.env')
    try {
      copyFileSync(COMPOSE, tempCompose)
      writeFileSync(tempEnv, SYNTHETIC_ENV)

      const out = execFileSync(
        'docker',
        ['compose', '-f', tempCompose, '--env-file', tempEnv, 'config', '--format', 'json'],
        {
          encoding: 'utf8',
          env: {
            ...process.env,
            // Host env must not leak into healthcheck test string.
            MYSQL_ROOT_PASSWORD: 'host-env-should-not-appear-in-healthcheck',
          },
        },
      )

      const cfg = JSON.parse(out) as {
        services: Record<
          string,
          {
            healthcheck?: { test?: string | string[] }
            depends_on?: Record<string, { condition?: string } | string>
            ports?: unknown
            image?: string
          }
        >
      }

      const mysql = cfg.services['cairn-tm-v3-mysql']
      const app = cfg.services['cairn-tm-v3-app']
      expect(mysql, 'mysql service present').toBeTruthy()
      expect(app, 'app service present').toBeTruthy()
      expect(mysql.image).toMatch(/mysql:8\.4/)

      const test = mysql.healthcheck?.test
      const testStr = Array.isArray(test) ? test.join(' ') : String(test ?? '')
      expect(testStr).toMatch(/mysqladmin/)
      expect(testStr).not.toMatch(/healthcheck\.sh/)
      // After Compose parse, $$ → $; container shell expands MYSQL_ROOT_PASSWORD.
      expect(testStr).toMatch(/\$MYSQL_ROOT_PASSWORD/)
      expect(testStr).not.toMatch(/local-dummy-root-NOT-FOR-PROD/)
      expect(testStr).not.toMatch(/host-env-should-not-appear-in-healthcheck/)

      const dep = app.depends_on?.['cairn-tm-v3-mysql']
      const cond =
        typeof dep === 'object' && dep !== null && 'condition' in dep
          ? dep.condition
          : undefined
      expect(cond).toBe('service_healthy')
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })
})
