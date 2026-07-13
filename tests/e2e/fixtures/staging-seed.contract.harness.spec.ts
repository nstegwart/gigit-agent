/**
 * Staging synthetic DB seeder — contract harness (no ambient/production DB).
 * Project: harness-contract (*.contract.harness.spec.ts)
 *
 * Live staging: node deploy/staging/scripts/seed-synthetic.mjs
 * Disposable MySQL proof: node qa/e2e/fixtures/seed/seed-isolated.mjs --disposable-proof
 */
import { expect, test } from '@playwright/test'
import { createRequire } from 'node:module'
import path from 'node:path'
import fs from 'node:fs'

const ROOT = process.cwd()
const require = createRequire(import.meta.url)

function pathToFileUrl(p: string) {
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  return pathToFileURL(p)
}

async function loadSeed() {
  const url = pathToFileUrl(path.join(ROOT, 'qa/e2e/fixtures/seed/seed-isolated.mjs'))
  return import(url.href)
}

function loadSeedPolicy() {
  const p = path.join(ROOT, 'qa/fixtures/staging/seed-policy.json')
  return JSON.parse(fs.readFileSync(p, 'utf8'))
}

test.describe('staging synthetic DB seeder contract (no server)', () => {
  test('seed-policy.json is synthetic-only and refuses DROP DATABASE', async () => {
    const policy = loadSeedPolicy()
    expect(policy.syntheticOnly).toBe(true)
    expect(policy.productionDerived).toBe(false)
    expect(policy.dropDatabase).toBe(false)
    expect(policy.databaseName).toBe('cairn_tm_v3_staging')
    expect(policy.boardId).toBe('mfs-rebuild')
    expect(policy.requiredEnv.CAIRN_ENV).toBe('staging')
    expect(policy.requiredEnv.CAIRN_STAGING_SEED_APPROVED).toBe('1')
  })

  test('Dockerfile copies seeder + fixture sources', async () => {
    const dockerfile = fs.readFileSync(
      path.join(ROOT, 'deploy/staging/Dockerfile'),
      'utf8',
    )
    expect(dockerfile).toMatch(/qa\/e2e\/fixtures\/seed/)
    expect(dockerfile).toMatch(/qa\/fixtures\/staging/)
    expect(dockerfile).toMatch(/deploy\/staging\/scripts/)
    expect(dockerfile).toMatch(/qa\/e2e\/lib/)
  })

  test('seed-synthetic.mjs wrapper exists and points at shared seeder', async () => {
    const wrapper = path.join(ROOT, 'deploy/staging/scripts/seed-synthetic.mjs')
    expect(fs.existsSync(wrapper)).toBe(true)
    const text = fs.readFileSync(wrapper, 'utf8')
    expect(text).toMatch(/seed-isolated\.mjs/)
    expect(text).toMatch(/seedStagingSynthetic|runSeedSelfTests/)
    // Docs may say "Never DROP DATABASE"; executable SQL DROP must not appear.
    expect(text).not.toMatch(/DROP\s+DATABASE\s+IF\s+EXISTS/i)
    expect(text).toMatch(/Never DROP DATABASE/i)
  })

  test('pure seed self-tests pass (gates + fixture contract)', async () => {
    const seed = await loadSeed()
    const r = seed.runSeedSelfTests()
    const failed = r.results.filter((x: { pass: boolean; name: string }) => !x.pass)
    expect(r.ok, failed.map((f: { name: string }) => f.name).join(', ')).toBe(true)
    expect(r.failCount).toBe(0)
    expect(seed.STAGING_DB_NAME).toBe('cairn_tm_v3_staging')
  })

  test('staging gate refuses production host and wrong DB name', async () => {
    const seed = await loadSeed()
    const prod = seed.assertStagingSeedAllowed({
      env: 'staging',
      dbName: 'cairn_tm_v3_staging',
      host: 'db.production.mfsdev.net',
      approved: '1',
    })
    expect(prod.ok).toBe(false)
    expect(prod.hostClass).toBe('PRODUCTION')

    const wrongDb = seed.assertStagingSeedAllowed({
      env: 'staging',
      dbName: 'cairn_taskmanager',
      host: 'cairn-tm-v3-mysql',
      approved: '1',
    })
    expect(wrongDb.ok).toBe(false)
    expect(String(wrongDb.reason)).toMatch(/CAIRN_DB_NAME/)
  })

  test('staging gate allows compose DNS host when approved', async () => {
    const seed = await loadSeed()
    const ok = seed.assertStagingSeedAllowed({
      env: 'staging',
      dbName: 'cairn_tm_v3_staging',
      host: 'cairn-tm-v3-mysql',
      approved: '1',
    })
    expect(ok.ok).toBe(true)
    expect(ok.hostClass).toBe('STAGING')
  })
})
