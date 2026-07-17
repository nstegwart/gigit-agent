import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'qa/evidence/capture-environment-table.mjs')

type Mod = {
  DEFAULT_ENVIRONMENTS: Array<Record<string, unknown>>
  redactSecrets: (value: unknown) => unknown
  classifyHost: (host: string) => string
  captureEnvironmentTable: (opts?: Record<string, unknown>) => {
    observedAt: string
    environments: Array<Record<string, unknown>>
    metadata: Record<string, unknown>
    classCoverage: Record<string, string>
    errors: string[]
    verdict: 'PASS' | 'FAIL'
    secretsRedacted: boolean
  }
}

async function loadMod(): Promise<Mod> {
  return (await import(pathToFileURL(SCRIPT).href)) as Mod
}

describe('capture-environment-table', () => {
  it('emits one timestamped local/staging/production authority row each', async () => {
    const mod = await loadMod()
    const report = mod.captureEnvironmentTable({
      observedAt: '2026-07-15T00:00:00.000Z',
    })
    expect(report.verdict).toBe('PASS')
    expect(report.observedAt).toBe('2026-07-15T00:00:00.000Z')
    expect(report.classCoverage).toEqual({
      local: 'LOCAL',
      staging: 'STAGING',
      production: 'PRODUCTION',
    })
    expect(report.environments).toHaveLength(3)
  })

  it('redacts secret keys, bearer values, and URL credentials recursively', async () => {
    const mod = await loadMod()
    const report = mod.captureEnvironmentTable({
      metadata: {
        token: 'raw-token',
        nested: { password: 'raw-password', safe: 'visible' },
        header: 'Bearer abc.def.ghi',
        dsn: 'mysql://user:password@127.0.0.1/db',
      },
    })
    expect(report.metadata).toEqual({
      token: '[REDACTED]',
      nested: { password: '[REDACTED]', safe: 'visible' },
      header: '[REDACTED]',
      dsn: 'mysql://[REDACTED]@127.0.0.1/db',
    })
    expect(JSON.stringify(report)).not.toContain('raw-token')
    expect(JSON.stringify(report)).not.toContain('raw-password')
    expect(report.secretsRedacted).toBe(true)
  })

  it('rejects missing/duplicate environments and wrong host classes', async () => {
    const mod = await loadMod()
    const report = mod.captureEnvironmentTable({
      environments: [
        mod.DEFAULT_ENVIRONMENTS[0],
        mod.DEFAULT_ENVIRONMENTS[0],
        { ...mod.DEFAULT_ENVIRONMENTS[2], hostClass: 'STAGING' },
      ],
    })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors).toEqual(
      expect.arrayContaining([
        'ENVIRONMENT_LOCAL_COUNT_INVALID',
        'ENVIRONMENT_STAGING_COUNT_INVALID',
        'ENVIRONMENT_PRODUCTION_HOST_CLASS_INVALID',
      ]),
    )
  })

  it('fails closed when environment authority dimensions collapse', async () => {
    const mod = await loadMod()
    const collapsed = mod.DEFAULT_ENVIRONMENTS.map((row, index) => ({
      ...row,
      id: ['local', 'staging', 'production'][index],
      hostClass: ['LOCAL', 'STAGING', 'PRODUCTION'][index],
      databaseClass: 'SAME',
      dataClass: 'SAME',
      appWriteAuthority: 'SAME',
      schemaWriteAuthority: 'SAME',
      boardSyncAuthority: 'SAME',
    }))
    const report = mod.captureEnvironmentTable({ environments: collapsed })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors).toContain('ENVIRONMENT_AUTHORITY_COLLAPSE')
  })

  it('fails closed when only board-sync authority collapses', async () => {
    const mod = await loadMod()
    const collapsed = mod.DEFAULT_ENVIRONMENTS.map((row) => ({
      ...row,
      boardSyncAuthority: 'SAME',
    }))
    const report = mod.captureEnvironmentTable({ environments: collapsed })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors).toContain('ENVIRONMENT_AUTHORITY_COLLAPSE')
  })

  it('rejects calendar-invalid ISO timestamps', async () => {
    const mod = await loadMod()
    const report = mod.captureEnvironmentTable({
      observedAt: '2026-02-30T00:00:00.000Z',
    })
    expect(report.errors).toContain('OBSERVED_AT_INVALID')
  })

  it('redacts common credential shapes regardless of neutral key names', async () => {
    const mod = await loadMod()
    const dummyShapes = {
      one: 'Basic dGVzdDp0ZXN0',
      two: 'https://example.invalid/x?access_token=dummy-value',
      three: '-----BEGIN PRIVATE KEY-----\nZHVtbXk=\n-----END PRIVATE KEY-----',
      four: 'eyJmaXh0dXJl.eyJmaXh0dXJl.c2lnbmF0dXJl',
      five: 'AKIAABCDEFGHIJKLMNOP',
      six: 'password=dummy-value',
    }
    const report = mod.captureEnvironmentTable({ metadata: dummyShapes })
    const serialized = JSON.stringify(report.metadata)
    for (const value of Object.values(dummyShapes)) {
      expect(serialized).not.toContain(value)
    }
    expect(
      Object.values(report.metadata).every(
        (value) => typeof value === 'string' && value.includes('[REDACTED]'),
      ),
    ).toBe(true)
    expect(report.secretsRedacted).toBe(true)
    expect(report.verdict).toBe('PASS')
  })

  it('classifies loopback, staging DNS, production, and unknown remote distinctly', async () => {
    const mod = await loadMod()
    expect(mod.classifyHost('127.0.0.1')).toBe('LOCAL')
    expect(mod.classifyHost('cairn-tm-v3-mysql')).toBe('STAGING')
    expect(mod.classifyHost('task-manager.mfsdev.net')).toBe('PRODUCTION')
    expect(mod.classifyHost('unclassified.example')).toBe('UNKNOWN_REMOTE')
  })

  it('CLI emits deterministic timestamped JSON without mutating state', () => {
    const stdout = execFileSync(
      process.execPath,
      [SCRIPT, '--observed-at', '2026-07-15T00:00:00.000Z'],
      { cwd: ROOT, encoding: 'utf8' },
    )
    const report = JSON.parse(stdout)
    expect(report.schemaVersion).toBe('TM_ENVIRONMENT_AUTHORITY_TABLE_V1')
    expect(report.observedAt).toBe('2026-07-15T00:00:00.000Z')
    expect(report.verdict).toBe('PASS')
    expect(report.nonMutating).toBe(true)
  })
})
