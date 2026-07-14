#!/usr/bin/env node
/**
 * Staging gate fixture seeder entrypoint (ops / local).
 *
 * Default mode is pure self-test — NO staging mutation, NO DB connection.
 * Emits deterministic JSON manifests + cleanup plans for the reversible
 * synthetic gate pack under qa/fixtures/staging/gates/**.
 *
 * Live apply is hard-gated and intentionally refuses unless ALL of:
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_GATES_APPLY=1
 *   CAIRN_GATES_BIND_LIVE_PIN=1
 *
 * Even with dual gates + live pin bind, default --apply is PLAN-ONLY (no network
 * mutation). Execute path requires CAIRN_GATES_EXECUTE=1 and delegates to
 * qa/e2e/flows/staging-gates-apply.mjs which uses authenticated product MCP only.
 *
 * Execute rails (driver-enforced, fail-closed):
 *   - healthz pin-shape validation before any mutation (boardRev/lifecycleRev)
 *   - register_run must send MCP-required targetGate
 *   - advance_task must send byRunId bound to the registered author run
 *   - no fabricated stage/G5 receipt hashes; additive synth-gate- prefix only
 *
 * NEVER uses seed-synthetic board wipe / raw SQL receipt inserts.
 *
 * Usage (repo root):
 *   node deploy/staging/scripts/seed-gates.mjs
 *   node deploy/staging/scripts/seed-gates.mjs --self-test
 *   node deploy/staging/scripts/seed-gates.mjs --manifest
 *   node deploy/staging/scripts/seed-gates.mjs --cleanup
 *   node deploy/staging/scripts/seed-gates.mjs --apply   # plan after dual gates; no mutate default
 *   node deploy/staging/scripts/seed-gates.mjs --apply-adapter-self-test
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveRepoRoot() {
  const fromScript = path.resolve(__dirname, '../../..')
  if (fs.existsSync(path.join(fromScript, 'package.json'))) return fromScript
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd()
  return fromScript
}

const ROOT = resolveRepoRoot()
const CONTRACT = path.join(ROOT, 'qa/fixtures/staging/gates/contract.mjs')
const APPLY_ADAPTER = path.join(ROOT, 'qa/fixtures/staging/gates/apply-adapter.mjs')
const APPLY_DRIVER = path.join(ROOT, 'qa/e2e/flows/staging-gates-apply.mjs')
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

async function loadApplyAdapter() {
  if (!fs.existsSync(APPLY_ADAPTER)) {
    throw Object.assign(new Error(`apply adapter missing: ${APPLY_ADAPTER}`), {
      code: 'GATES_APPLY_ADAPTER_MISSING',
    })
  }
  return import(pathToFileURL(APPLY_ADAPTER).href)
}

/**
 * Dual staging env + policy gates (without live pin — pin checked separately).
 */
function refuseLiveApplyBase(policy) {
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

  if (argFlag('--apply-adapter-self-test')) {
    const adapter = await loadApplyAdapter()
    const self = adapter.runApplyAdapterSelfTests()
    console.log(
      JSON.stringify(
        {
          mode: 'apply-adapter-self-test',
          stagingMutation: false,
          ...self,
        },
        null,
        2,
      ),
    )
    process.exit(self.ok ? 0 : 1)
  }

  if (argFlag('--apply')) {
    const gate = refuseLiveApplyBase(policy)
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

    // Dual env gates OK — require live pin bind (never use fixture boardRev=7 as CAS).
    if (process.env.CAIRN_GATES_BIND_LIVE_PIN !== '1') {
      console.error(
        JSON.stringify({
          ok: false,
          mode: 'apply-refused',
          code: 'CAIRN_GATES_LIVE_PIN_REQUIRED',
          message:
            'CAIRN_GATES_BIND_LIVE_PIN=1 required for apply. Fixture pin.json boardRev is self-test only; live CAS must re-read boardRev/lifecycleRev/canonicalHash before each mutation.',
          missing: ['CAIRN_GATES_BIND_LIVE_PIN=1'],
          forbiddenBypass: [
            'deploy/staging/scripts/seed-synthetic.mjs',
            'raw-sql-board-wipe',
            'fixture-pin-boardRev-7-as-live-cas',
          ],
        }),
      )
      process.exit(3)
    }

    const adapter = await loadApplyAdapter()
    const packManifest = contract.buildDeterministicPackManifest()
    const applyPlan = adapter.buildApplyStepPlan({
      expectedSha: process.env.EXPECTED_SHA || undefined,
      packHash: packManifest.packHash,
      boardId: policy.boardId || packManifest.boardId,
    })

    const wantExecute = process.env.CAIRN_GATES_EXECUTE === '1'
    if (!wantExecute) {
      // Default: non-mutating plan emission (safe for CI / operator dry review).
      console.log(
        JSON.stringify(
          {
            ok: true,
            mode: 'apply-plan',
            code: 'GATES_APPLY_PLAN',
            stagingMutation: false,
            message:
              'Dual gates + live-pin bind satisfied. Default --apply is plan-only (no staging mutation). Set CAIRN_GATES_EXECUTE=1 and run via staging-gates-apply.mjs with STAGING_URL + dual bearers to execute authenticated MCP steps.',
            refuse: {
              seedSynthetic: true,
              rawSqlWipe: true,
              fabricateStageReceipts: true,
              fabricateG5Pass: true,
            },
            adapterId: adapter.ADAPTER_ID,
            plan: applyPlan,
            residual_gaps: applyPlan.residual_gaps,
            driver: 'qa/e2e/flows/staging-gates-apply.mjs',
            cleanupPlan: adapter.buildPrefixCleanupPlan({
              boardId: policy.boardId || packManifest.boardId,
            }),
          },
          null,
          2,
        ),
      )
      process.exit(0)
    }

    // Execute path: delegate to promoted driver (never seed-synthetic).
    if (!fs.existsSync(APPLY_DRIVER)) {
      console.error(
        JSON.stringify({
          ok: false,
          mode: 'apply-execute-missing-driver',
          code: 'GATES_APPLY_DRIVER_MISSING',
          message: `Apply driver missing: ${APPLY_DRIVER}`,
        }),
      )
      process.exit(2)
    }

    const child = spawnSync(
      process.execPath,
      [APPLY_DRIVER, '--apply', '--from-seed-gates'],
      {
        cwd: ROOT,
        env: process.env,
        encoding: 'utf8',
        maxBuffer: 16 * 1024 * 1024,
      },
    )
    if (child.stdout) process.stdout.write(child.stdout)
    if (child.stderr) process.stderr.write(child.stderr)
    process.exit(child.status == null ? 2 : child.status)
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
