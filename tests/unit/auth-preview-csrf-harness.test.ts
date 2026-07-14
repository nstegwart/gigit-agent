/**
 * FP-A HARNESS-csrf-preview focused suite.
 *
 * Proves collab-comment / feature-toggle / boards e2e preview child env receives
 * CAIRN_CSRF_SECRET configuration, that the secret is never sidecar-persisted or
 * logged, and that cleanup scrubs it.
 *
 * Support evidence only (unit / harness) — does not re-run full Playwright mutators.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  cleanupIsolatedAuthFixture,
  ensureAuthSecretsInEnv,
  ensureCsrfSecretInEnv,
  eraseSecretsSidecar,
  writeSecretsSidecar,
} from '../../qa/e2e/lib/auth-fixture.mjs'
import {
  buildAuthPreviewChildEnv,
  CSRF_PREVIEW_MUTATOR_SPECS,
  formatAuthPreviewStartLog,
} from '../../qa/e2e/lib/start-auth-preview.mjs'

const ENV_KEYS = [
  'CAIRN_E2E_AUTH_RUN_ID',
  'CAIRN_E2E_AUTH_RUNTIME_META_PATH',
  'CAIRN_E2E_AUTH_SECRETS_PATH',
  'CAIRN_E2E_AUTH_STORAGE_PATH',
  'CAIRN_E2E_USERNAME',
  'CAIRN_E2E_PASSWORD',
  'CAIRN_MCP_BEARER',
  'CAIRN_BEARER_PRINCIPALS_JSON',
  'CAIRN_DB_NAME',
  'CAIRN_ISO_DB_NAME',
  'CAIRN_CSRF_SECRET',
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

describe('FP-A ensureCsrfSecretInEnv', () => {
  it('mints ephemeral secret when unset (configured + min length)', () => {
    delete process.env.CAIRN_CSRF_SECRET
    const r = ensureCsrfSecretInEnv()
    expect(r.configured).toBe(true)
    expect(r.minted).toBe(true)
    expect(r.source).toBe('ephemeral')
    expect(r.secretCharLength).toBeGreaterThanOrEqual(32)
    const mintedSecret = String(process.env.CAIRN_CSRF_SECRET ?? '')
    expect(mintedSecret.trim().length).toBeGreaterThanOrEqual(32)
    // Result must never carry the secret value
    expect(JSON.stringify(r)).not.toContain(mintedSecret)
  })

  it('reuses existing env secret without overwrite', () => {
    process.env.CAIRN_CSRF_SECRET = 'owner-provided-csrf-secret-min-32-chars!!'
    const r = ensureCsrfSecretInEnv()
    expect(r.minted).toBe(false)
    expect(r.source).toBe('env')
    expect(process.env.CAIRN_CSRF_SECRET).toBe(
      'owner-provided-csrf-secret-min-32-chars!!',
    )
  })

  it('forceNew re-mints a different secret', () => {
    const first = ensureCsrfSecretInEnv()
    const a = process.env.CAIRN_CSRF_SECRET
    expect(first.minted).toBe(true)
    const second = ensureCsrfSecretInEnv({ forceNew: true })
    const b = process.env.CAIRN_CSRF_SECRET
    expect(second.minted).toBe(true)
    expect(b).not.toBe(a)
    expect(b?.length).toBeGreaterThanOrEqual(32)
  })
})

describe('FP-A buildAuthPreviewChildEnv for mutator specs', () => {
  it('names collab-comment, feature-toggle, boards as CSRF mutator consumers', () => {
    expect([...CSRF_PREVIEW_MUTATOR_SPECS].sort()).toEqual(
      ['boards', 'collab-comment', 'feature-toggle'].sort(),
    )
    // Spec files exist under tests/e2e (contract: preview harness covers these)
    for (const name of CSRF_PREVIEW_MUTATOR_SPECS) {
      const p = path.join(process.cwd(), `tests/e2e/${name}.spec.ts`)
      expect(fs.existsSync(p), p).toBe(true)
    }
  })

  it('preview child env receives CAIRN_CSRF_SECRET when previously unset', () => {
    process.env.CAIRN_E2E_AUTH_RUN_ID = `csrf_preview_${Date.now().toString(36)}`
    ensureAuthSecretsInEnv()
    // Sidecar write path (as start-auth-preview does) before mint
    const sidecarPath = writeSecretsSidecar()
    delete process.env.CAIRN_CSRF_SECRET

    const built = buildAuthPreviewChildEnv({ port: 3299 })
    expect(built.csrf.configured).toBe(true)
    expect(built.csrf.minted).toBe(true)
    expect(built.csrf.source).toBe('ephemeral')
    expect(built.env.CAIRN_CSRF_SECRET?.trim().length).toBeGreaterThanOrEqual(32)
    expect(built.env.PORT).toBe('3299')

    // Never persist CSRF to secrets sidecar
    const sidecarRaw = fs.readFileSync(sidecarPath, 'utf8')
    expect(sidecarRaw).not.toContain('CAIRN_CSRF_SECRET')
    expect(sidecarRaw).not.toContain(built.env.CAIRN_CSRF_SECRET)

    // Start log must advertise csrfConfigured without leaking secret
    const log = formatAuthPreviewStartLog({
      port: 3299,
      host: '127.0.0.1',
      isoDb: 'cairn_tm_e2e_authfix_unit',
      runId: built.runId,
      metaPath: built.metaPath,
      username: 'e2e_unit',
      csrf: built.csrf,
    })
    expect(log).toContain('AUTH_PREVIEW_START')
    expect(log).toContain('csrfConfigured=yes')
    expect(log).toContain('csrfSource=ephemeral')
    expect(log).toContain('csrfMutators=collab-comment,feature-toggle,boards')
    expect(log).not.toContain(built.env.CAIRN_CSRF_SECRET)
  })

  it('preserves pre-set CAIRN_CSRF_SECRET into child env (no weaken)', () => {
    process.env.CAIRN_E2E_AUTH_RUN_ID = `csrf_reuse_${Date.now().toString(36)}`
    ensureAuthSecretsInEnv()
    process.env.CAIRN_CSRF_SECRET = 'pre-set-csrf-secret-for-preview-min-32xx'
    const built = buildAuthPreviewChildEnv({ port: 3301 })
    expect(built.csrf.minted).toBe(false)
    expect(built.csrf.source).toBe('env')
    expect(built.env.CAIRN_CSRF_SECRET).toBe(
      'pre-set-csrf-secret-for-preview-min-32xx',
    )
  })
})

describe('FP-A cleanup scrubs CSRF secret', () => {
  it('cleanupIsolatedAuthFixture removes CAIRN_CSRF_SECRET from process.env', async () => {
    process.env.CAIRN_E2E_AUTH_RUN_ID = `csrf_scrub_${Date.now().toString(36)}`
    ensureAuthSecretsInEnv()
    ensureCsrfSecretInEnv()
    expect(process.env.CAIRN_CSRF_SECRET).toBeTruthy()

    const result = await cleanupIsolatedAuthFixture({ keepDb: true, keepStorage: true })
    expect(result.envScrubbed).toContain('CAIRN_CSRF_SECRET')
    expect(process.env.CAIRN_CSRF_SECRET).toBeUndefined()
  })
})

describe('FP-A start-auth-preview source contract', () => {
  it('start-auth-preview.mjs wires ensureCsrfSecretInEnv / buildAuthPreviewChildEnv', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'qa/e2e/lib/start-auth-preview.mjs'),
      'utf8',
    )
    expect(src).toContain('ensureCsrfSecretInEnv')
    expect(src).toContain('buildAuthPreviewChildEnv')
    expect(src).toContain('CAIRN_CSRF_SECRET')
    // Fail-closed if mint somehow leaves secret empty
    expect(src).toMatch(/CAIRN_CSRF_SECRET missing after ensureCsrfSecretInEnv/)
    // Never console.log the secret value
    expect(src).not.toMatch(/console\.log\([^)]*CAIRN_CSRF_SECRET[^)]*process\.env/)
    // no-secret audit: --cleanup-on-exit must be consumed (not parse-only dead code)
    expect(src).toContain('cleanupIsolatedAuthFixture')
    expect(src).toContain('createAuthPreviewExitCleanup')
    expect(src).toMatch(/cleanupOnExit:\s*args\.cleanupOnExit/)
  })
})
