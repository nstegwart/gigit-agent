import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { describe, expect, it } from 'vitest'

const ROOT = process.cwd()
const SCRIPT = join(ROOT, 'qa/evidence/gate-vocabulary.mjs')

type Mod = {
  SCHEMA_VERSION: string
  LIVE_AWAITING: string
  STAGING_GATE: string
  APP_ONLY_PREAUTH_SUB_GATE: string
  reconcileGateVocabulary: (opts?: Record<string, unknown>) => {
    schemaVersion: string
    verdict: 'PASS' | 'FAIL'
    errors: string[]
    warnings: string[]
    production: { gateClosed: string; appWriteAuthority: string; reconciled: boolean } | null
    staging: { gateClosed: string; reconciled: boolean } | null
    liveAwaitingToken: string
    stagingVerifiedToken: string
    appOnlyPreAuthSubGate: string
  }
}

async function loadMod(): Promise<Mod> {
  const gate = (await import(pathToFileURL(SCRIPT).href)) as Mod
  const terminal = (await import(
    pathToFileURL(join(ROOT, 'qa/evidence/validate-terminal-receipt.mjs')).href
  )) as { LIVE_AWAITING: string; STAGING_GATE: string }
  return { ...gate, LIVE_AWAITING: terminal.LIVE_AWAITING, STAGING_GATE: terminal.STAGING_GATE }
}

describe('gate-vocabulary (AC-GATE-02/03)', () => {
  it('reconciles production AWAITING with app-only pre-auth sub-gate', async () => {
    const mod = await loadMod()
    const report = mod.reconcileGateVocabulary({
      observedAt: '2026-07-16T00:00:00.000Z',
    })
    expect(report.schemaVersion).toBe('TM_GATE_VOCABULARY_V1')
    expect(report.verdict).toBe('PASS')
    expect(report.errors).toEqual([])
    expect(report.production).toMatchObject({
      gateClosed: mod.LIVE_AWAITING,
      appWriteAuthority: mod.APP_ONLY_PREAUTH_SUB_GATE,
      reconciled: true,
    })
    expect(report.staging?.gateClosed).toBe('TASK_MANAGER_STAGING_VERIFIED_ONLY')
    expect(report.warnings).toContain('APP_ONLY_PREAUTH_RECONCILED_WITH_LIVE_AWAITING')
  })

  it('fails when production gateClosed conflates staging PASS', async () => {
    const mod = await loadMod()
    const envMod = (await import(
      pathToFileURL(join(ROOT, 'qa/evidence/capture-environment-table.mjs')).href
    )) as {
      DEFAULT_ENVIRONMENTS: Array<Record<string, unknown>>
      captureEnvironmentTable: (opts: Record<string, unknown>) => { verdict: string; observedAt: string }
    }
    const broken = envMod.DEFAULT_ENVIRONMENTS.map((row) =>
      row.id === 'production'
        ? { ...row, gateClosed: 'TASK_MANAGER_STAGING_VERIFIED' }
        : row,
    )
    const environmentTable = envMod.captureEnvironmentTable({
      observedAt: '2026-07-16T00:00:00.000Z',
      environments: broken,
    })
    const report = mod.reconcileGateVocabulary({ environmentTable })
    expect(report.verdict).toBe('FAIL')
    expect(report.errors).toEqual(
      expect.arrayContaining(['PRODUCTION_GATE_CLOSED_MISMATCH', 'PRODUCTION_FORBIDDEN_GATE_TASK_MANAGER_STAGING_VERIFIED']),
    )
  })
})