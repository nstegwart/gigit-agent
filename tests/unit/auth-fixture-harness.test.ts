/**
 * Auth fixture harness unit suite (repair-final):
 * - run-scoped meta/secrets paths do not collide across concurrent runIds
 * - cleanup ownership gate refuses foreign runId / non-owned prefix
 * - type surface / secret ignore rules (support evidence)
 *
 * No live MySQL / no product RBAC mutation. Pure fs + path logic.
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  AUTH_FIXTURE_OWNED_DB_PREFIX,
  AUTH_FIXTURE_SKIP_DATA_TABLES,
  ensureAuthSecretsInEnv,
  eraseSecretsSidecar,
  isOwnedIsoDbForCleanup,
  mcpAuthHeaders,
  resolveAuthRunId,
  resolveAuthRuntimeMetaPath,
  resolveAuthSecretsSidecarPath,
  writeSecretsSidecar,
} from '../../qa/e2e/lib/auth-fixture.mjs'

const ENV_KEYS = [
  'CAIRN_E2E_AUTH_RUN_ID',
  'CAIRN_E2E_AUTH_RUNTIME_META_PATH',
  'CAIRN_E2E_AUTH_SECRETS_PATH',
  'CAIRN_E2E_USERNAME',
  'CAIRN_E2E_PASSWORD',
  'CAIRN_MCP_BEARER',
  'CAIRN_BEARER_PRINCIPALS_JSON',
  'CAIRN_DB_NAME',
  'CAIRN_ISO_DB_NAME',
] as const

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

function clearAuthEnv() {
  for (const k of ENV_KEYS) {
    delete process.env[k]
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }
  clearAuthEnv()
})

afterEach(() => {
  // Erase any sidecars we wrote under tmp/run-scoped paths when env still set
  try {
    eraseSecretsSidecar()
  } catch {
    /* ignore */
  }
  clearAuthEnv()
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('run-scoped meta / secrets paths (concurrency)', () => {
  it('distinct runIds resolve to distinct meta + secrets paths', () => {
    clearAuthEnv()
    const aMeta = resolveAuthRuntimeMetaPath({ runId: 'runA_unit' })
    const aSec = resolveAuthSecretsSidecarPath({ runId: 'runA_unit' })
    clearAuthEnv()
    const bMeta = resolveAuthRuntimeMetaPath({ runId: 'runB_unit' })
    const bSec = resolveAuthSecretsSidecarPath({ runId: 'runB_unit' })

    expect(aMeta).toContain('e2e-auth-runtime-runA_unit.json')
    expect(bMeta).toContain('e2e-auth-runtime-runB_unit.json')
    expect(aMeta).not.toBe(bMeta)
    expect(aSec).not.toBe(bSec)
    expect(aSec).toContain('e2e-auth-secrets-runA_unit.json')
    expect(bSec).toContain('e2e-auth-secrets-runB_unit.json')
  })

  it('explicit meta/secrets path overrides pin env for sibling processes', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auth-fixture-unit-'))
    const meta = path.join(dir, 'meta-custom.json')
    const secrets = path.join(dir, 'secrets-custom.json')
    process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH = meta
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = secrets
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'pinned-run'

    expect(resolveAuthRuntimeMetaPath()).toBe(meta)
    expect(resolveAuthSecretsSidecarPath()).toBe(secrets)
    expect(resolveAuthRunId()).toBe('pinned-run')

    fs.rmSync(dir, { recursive: true, force: true })
  })

  it('ensureAuthSecretsInEnv writes mode-600 sidecar under run-scoped path only', () => {
    const runId = `unit_secrets_${Date.now().toString(36)}`
    process.env.CAIRN_E2E_AUTH_RUN_ID = runId
    const secrets = ensureAuthSecretsInEnv()
    expect(secrets.runId).toBe(runId)
    expect(secrets.secretsSidecarPath).toContain(`e2e-auth-secrets-${runId}.json`)
    expect(fs.existsSync(secrets.secretsSidecarPath)).toBe(true)
    const mode = fs.statSync(secrets.secretsSidecarPath).mode & 0o777
    expect(mode).toBe(0o600)
    // Never write the legacy shared fixed path
    const legacy = path.join(process.cwd(), '.artifact/e2e-auth-secrets.json')
    // If legacy exists from other runs, our write must not be that path
    expect(secrets.secretsSidecarPath).not.toBe(legacy)
    const erased = eraseSecretsSidecar()
    expect(erased).toBe(true)
    expect(fs.existsSync(secrets.secretsSidecarPath)).toBe(false)
  })

  it('two sequential ensure calls with different runIds do not share sidecar path', () => {
    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'par_1'
    const s1 = ensureAuthSecretsInEnv()
    const p1 = s1.secretsSidecarPath
    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'par_2'
    const s2 = ensureAuthSecretsInEnv()
    const p2 = s2.secretsSidecarPath
    expect(p1).not.toBe(p2)
    // cleanup both
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'par_1'
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = p1
    eraseSecretsSidecar()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'par_2'
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = p2
    eraseSecretsSidecar()
  })
})

describe('cleanup ownership (teardown only drops owned prefix)', () => {
  it('isOwnedIsoDbForCleanup accepts matching runId + authfix prefix', () => {
    expect(
      isOwnedIsoDbForCleanup(
        {
          mode: 'isolated-clone',
          runId: 'r1',
          isoDb: `${AUTH_FIXTURE_OWNED_DB_PREFIX}_20260101_1`,
          ownedDbPrefix: AUTH_FIXTURE_OWNED_DB_PREFIX,
        },
        'r1',
      ),
    ).toBe(true)
  })

  it('isOwnedIsoDbForCleanup rejects foreign runId', () => {
    expect(
      isOwnedIsoDbForCleanup(
        {
          mode: 'isolated-clone',
          runId: 'peer-run',
          isoDb: `${AUTH_FIXTURE_OWNED_DB_PREFIX}_x`,
        },
        'self-run',
      ),
    ).toBe(false)
  })

  it('isOwnedIsoDbForCleanup rejects non-owned prefix (loginproto / ambient)', () => {
    expect(
      isOwnedIsoDbForCleanup(
        {
          mode: 'isolated-clone',
          runId: 'r1',
          isoDb: 'cairn_tm_e2e_loginproto_20260101_1',
        },
        'r1',
      ),
    ).toBe(false)
    expect(
      isOwnedIsoDbForCleanup(
        {
          mode: 'isolated-clone',
          runId: 'r1',
          isoDb: 'cairn_taskmanager',
        },
        'r1',
      ),
    ).toBe(false)
  })

  it('isOwnedIsoDbForCleanup rejects already-dropped and skip-iso', () => {
    expect(
      isOwnedIsoDbForCleanup(
        {
          mode: 'isolated-clone',
          runId: 'r1',
          isoDb: `${AUTH_FIXTURE_OWNED_DB_PREFIX}_x`,
          cleanup: { dbDropped: true } as never,
        },
        'r1',
      ),
    ).toBe(false)
    expect(
      isOwnedIsoDbForCleanup({ mode: 'skip-iso', runId: 'r1' }, 'r1'),
    ).toBe(false)
  })
})

describe('type / contract surface', () => {
  it('exports stable skip-data tables and owned prefix', () => {
    expect([...AUTH_FIXTURE_SKIP_DATA_TABLES].sort()).toEqual(
      ['sessions', 'user_boards', 'users'].sort(),
    )
    expect(AUTH_FIXTURE_OWNED_DB_PREFIX).toBe('cairn_tm_e2e_authfix')
  })

  it('mcpAuthHeaders fail-closed without bearer and never embed static secret', () => {
    delete process.env.CAIRN_MCP_BEARER
    expect(() => mcpAuthHeaders()).toThrow(/CAIRN_MCP_BEARER/)
    process.env.CAIRN_MCP_BEARER = 'unit-test-bearer-token'
    const h = mcpAuthHeaders()
    expect(h.Authorization).toBe('Bearer unit-test-bearer-token')
    // Source of headers is env only — no hard-coded product secret constant
    expect(h.Authorization).not.toMatch(/mcp-auth-test/)
  })

  it('auth-fixture.d.mts exists next to mjs (TS7016 bridge for .mjs imports)', () => {
    // moduleResolution bundler resolves auth-fixture.mjs → auth-fixture.d.mts (not .d.ts)
    const dts = path.join(process.cwd(), 'qa/e2e/lib/auth-fixture.d.mts')
    const mjs = path.join(process.cwd(), 'qa/e2e/lib/auth-fixture.mjs')
    expect(fs.existsSync(mjs)).toBe(true)
    expect(fs.existsSync(dts)).toBe(true)
    const text = fs.readFileSync(dts, 'utf8')
    expect(text).toContain('ensureAuthSecretsInEnv')
    expect(text).toContain('isOwnedIsoDbForCleanup')
    expect(text).toContain('resolveAuthRuntimeMetaPath')
  })
})

describe('gitignore exact secret rules', () => {
  it('root .gitignore lists secret sidecars, runtime meta, and storageState', () => {
    const gi = fs.readFileSync(path.join(process.cwd(), '.gitignore'), 'utf8')
    expect(gi).toContain('.artifact/e2e-auth-secrets.json')
    expect(gi).toContain('.artifact/e2e-auth-secrets-*.json')
    expect(gi).toContain('.artifact/e2e-auth-runtime.json')
    expect(gi).toContain('.artifact/e2e-auth-runtime-*.json')
    expect(gi).toContain('qa/e2e/fixtures/storage/admin.json')
  })

  it('git check-ignore accepts representative secret/meta paths', async () => {
    const { execFileSync } = await import('node:child_process')
    const samples = [
      '.artifact/e2e-auth-secrets.json',
      '.artifact/e2e-auth-secrets-runX.json',
      '.artifact/e2e-auth-runtime.json',
      '.artifact/e2e-auth-runtime-runX.json',
      'qa/e2e/fixtures/storage/admin.json',
    ]
    for (const s of samples) {
      const out = execFileSync('git', ['check-ignore', '-v', s], {
        cwd: process.cwd(),
        encoding: 'utf8',
      }).trim()
      expect(out.length, `check-ignore ${s}`).toBeGreaterThan(0)
    }
  })
})

describe('writeSecretsSidecar propagates run path pins', () => {
  it('sidecar JSON includes runId + meta/secrets path keys (no password log)', () => {
    const runId = `unit_pin_${Date.now().toString(36)}`
    process.env.CAIRN_E2E_AUTH_RUN_ID = runId
    process.env.CAIRN_E2E_USERNAME = 'e2e_unit'
    process.env.CAIRN_E2E_PASSWORD = 'unit-secret-pw'
    process.env.CAIRN_MCP_BEARER = 'unit-bearer'
    process.env.CAIRN_BEARER_PRINCIPALS_JSON = '[]'
    const p = writeSecretsSidecar()
    const raw = JSON.parse(fs.readFileSync(p, 'utf8')) as Record<string, string>
    expect(raw.CAIRN_E2E_AUTH_RUN_ID).toBe(runId)
    expect(raw.CAIRN_E2E_AUTH_RUNTIME_META_PATH).toContain(`e2e-auth-runtime-${runId}.json`)
    expect(raw.CAIRN_E2E_AUTH_SECRETS_PATH).toBe(p)
    expect(raw.CAIRN_E2E_PASSWORD).toBe('unit-secret-pw')
    eraseSecretsSidecar()
  })
})
