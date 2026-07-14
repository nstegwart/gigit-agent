/**
 * Seed-path provenance gate (JS) stays aligned with TS SYNTHETIC decision.
 */
import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

import { evaluateStagingDataLoad as evaluateTs } from '#/server/staging-data-provenance'

const ROOT = process.cwd()

describe('staging seed provenance gate (deploy seed path)', () => {
  it('JS gate SYNTHETIC matches TS evaluateStagingDataLoad ok', async () => {
    const gate = await import(
      pathToFileURL(join(ROOT, 'qa/fixtures/staging/provenance-gate.mjs')).href
    )
    const js = gate.evaluateStagingDataLoad({
      mode: 'SYNTHETIC',
      purpose: 'unit-test',
    })
    const ts = evaluateTs({
      mode: 'SYNTHETIC',
      purpose: 'unit-test',
    })
    expect(js.ok).toBe(true)
    expect(ts.ok).toBe(true)
    expect(js.mode).toBe('SYNTHETIC')
    expect(ts.mode).toBe('SYNTHETIC')
    expect(js.schema).toBe(ts.schema)
  })

  it('enforceSyntheticSeedProvenance accepts seed-policy.json', async () => {
    const gate = await import(
      pathToFileURL(join(ROOT, 'qa/fixtures/staging/provenance-gate.mjs')).href
    )
    const policy = JSON.parse(
      readFileSync(join(ROOT, 'qa/fixtures/staging/seed-policy.json'), 'utf8'),
    )
    const r = gate.enforceSyntheticSeedProvenance(policy)
    expect(r.ok).toBe(true)
    expect(r.decision?.mode).toBe('SYNTHETIC')
  })

  it('refuses productionDerived policy on synthetic seed path', async () => {
    const gate = await import(
      pathToFileURL(join(ROOT, 'qa/fixtures/staging/provenance-gate.mjs')).href
    )
    const r = gate.enforceSyntheticSeedProvenance({
      productionDerived: true,
      syntheticOnly: false,
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('PRODUCTION_DERIVED_POLICY')
  })

  it('PRODUCTION_DERIVED without dual approval refuses in JS gate', async () => {
    const gate = await import(
      pathToFileURL(join(ROOT, 'qa/fixtures/staging/provenance-gate.mjs')).href
    )
    const r = gate.evaluateStagingDataLoad({ mode: 'PRODUCTION_DERIVED' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('MISSING_PRODUCTION_READ_APPROVAL')
  })
})
