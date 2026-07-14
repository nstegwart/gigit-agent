#!/usr/bin/env node
/**
 * Staging gate fixture seeder entrypoint (ops / local).
 *
 * Default mode is pure self-test — NO staging mutation, NO DB connection.
 * Emits deterministic JSON manifests + cleanup plans for the reversible
 * synthetic gate pack under qa/fixtures/staging/gates/**.
 *
 * Live apply is hard-gated and intentionally refuses unless BOTH:
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_GATES_APPLY=1
 * Even then, this build only documents the apply path; it does not implement
 * destructive SQL — operators re-use seed-synthetic / import APIs.
 *
 * Usage (repo root):
 *   node deploy/staging/scripts/seed-gates.mjs
 *   node deploy/staging/scripts/seed-gates.mjs --self-test
 *   node deploy/staging/scripts/seed-gates.mjs --manifest
 *   node deploy/staging/scripts/seed-gates.mjs --cleanup
 *   node deploy/staging/scripts/seed-gates.mjs --apply   # refuses without dual env gates
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveRepoRoot() {
  const fromScript = path.resolve(__dirname, '../../..')
  if (fs.existsSync(path.join(fromScript, 'package.json'))) return fromScript
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd()
  return fromScript
}

const ROOT = resolveRepoRoot()
const CONTRACT = path.join(ROOT, 'qa/fixtures/staging/gates/contract.mjs')
const POLICY = path.join(ROOT, 'qa/fixtures/staging/gates/seed-policy.json')

function argFlag(name) {
  return process.argv.includes(name)
}

function loadPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY, 'utf8'))
  } catch (e) {
    return { loadError: String(e?.message || e) }
  }
}

async function loadContract() {
  if (!fs.existsSync(CONTRACT)) {
    throw Object.assign(new Error(`gate contract missing: ${CONTRACT}`), {
      code: 'GATES_CONTRACT_MISSING',
    })
  }
  return import(pathToFileURL(CONTRACT).href)
}

function refuseLiveApply(policy) {
  const env = process.env
  const missing = []
  const required = policy.requiredEnvForLiveApply ?? {
    CAIRN_ENV: 'staging',
    CAIRN_DB_NAME: 'cairn_tm_v3_staging',
    CAIRN_STAGING_SEED_APPROVED: '1',
    CAIRN_GATES_APPLY: '1',
  }
  for (const [k, v] of Object.entries(required)) {
    if (env[k] !== v) missing.push(`${k}=${v}`)
  }
  if (policy.productionDerived === true) {
    missing.push('productionDerived must be false for gate pack')
  }
  if (policy.syntheticOnly !== true) {
    missing.push('syntheticOnly must be true')
  }
  return {
    ok: missing.length === 0,
    missing,
    message:
      missing.length === 0
        ? null
        : `CAIRN_GATES_APPLY refused — missing/incorrect: ${missing.join(', ')}. Gate pack default is self-test only (no staging mutation).`,
  }
}

async function main() {
  const policy = loadPolicy()
  if (policy.loadError) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `seed-policy load failed: ${policy.loadError}`,
        code: 'SEED_POLICY_LOAD_ERROR',
      }),
    )
    process.exit(2)
  }

  const contract = await loadContract()

  if (argFlag('--manifest')) {
    const m = contract.buildDeterministicPackManifest()
    console.log(JSON.stringify({ ok: true, mode: 'manifest', manifest: m }, null, 2))
    process.exit(0)
  }

  if (argFlag('--cleanup')) {
    const plan = contract.buildCleanupPlan()
    console.log(JSON.stringify({ ok: true, mode: 'cleanup-plan', plan }, null, 2))
    process.exit(0)
  }

  if (argFlag('--apply')) {
    const gate = refuseLiveApply(policy)
    if (!gate.ok) {
      console.error(
        JSON.stringify({
          ok: false,
          mode: 'apply-refused',
          code: 'CAIRN_GATES_APPLY_REFUSED',
          message: gate.message,
          missing: gate.missing,
          hint: 'Use --self-test / --manifest / --cleanup. Live mutation is out of scope for default gate pack runs.',
        }),
      )
      process.exit(3)
    }
    // Dual gates present — still do not mutate in this script; point to reuse APIs.
    console.log(
      JSON.stringify({
        ok: false,
        mode: 'apply-not-implemented',
        code: 'GATES_APPLY_DELEGATED',
        message:
          'Live gate apply is delegated to existing seed/import APIs (seed-synthetic.mjs + canonical import). This script remains plan/self-test only to avoid accidental staging mutation.',
        reuse: {
          seedSynthetic: 'deploy/staging/scripts/seed-synthetic.mjs',
          importApi: 'src/server/canonical-import.ts',
          fixtures: 'qa/fixtures/staging/gates/**',
        },
        cleanupPlan: contract.buildCleanupPlan(),
      }, null, 2),
    )
    process.exit(4)
  }

  // default: --self-test
  const self = contract.runGateContractSelfTests()
  const out = {
    mode: 'self-test',
    policyId: policy.policyId ?? null,
    syntheticOnly: policy.syntheticOnly === true,
    productionDerived: policy.productionDerived === false ? false : policy.productionDerived,
    stagingMutation: false,
    ...self,
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      code: e?.code ?? 'SEED_GATES_FATAL',
    }),
  )
  process.exit(2)
})
