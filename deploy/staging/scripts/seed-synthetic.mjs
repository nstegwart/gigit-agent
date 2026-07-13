#!/usr/bin/env node
/**
 * Staging synthetic DB seeder entrypoint (compose / ops).
 *
 * Loads the shared control-center fixture seeder and runs it in staging mode
 * against the exact DB name cairn_tm_v3_staging. Never DROP DATABASE.
 *
 * Required env (fail-closed):
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_DB_HOST in staging allowlist (e.g. cairn-tm-v3-mysql)
 *   CAIRN_DB_PORT / CAIRN_DB_USER / CAIRN_DB_PASSWORD
 *
 * Usage (from repo root or inside staging app container):
 *   node deploy/staging/scripts/seed-synthetic.mjs
 *   node deploy/staging/scripts/seed-synthetic.mjs --self-test
 *   node deploy/staging/scripts/seed-synthetic.mjs --disposable-proof
 *
 * Docker compose one-shot (documented in deploy/staging/README.md):
 *   sudo docker compose -f deploy/staging/docker-compose.yml --env-file deploy/staging/.env \
 *     run --rm -e CAIRN_STAGING_SEED_APPROVED=1 cairn-tm-v3-app \
 *     node deploy/staging/scripts/seed-synthetic.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

function resolveRepoRoot() {
  // deploy/staging/scripts → ../../../
  const fromScript = path.resolve(__dirname, '../../..')
  if (fs.existsSync(path.join(fromScript, 'package.json'))) return fromScript
  // Container WORKDIR /app with sources at /app
  if (fs.existsSync(path.join(process.cwd(), 'package.json'))) return process.cwd()
  return fromScript
}

const ROOT = resolveRepoRoot()
const SEED_MODULE = path.join(
  ROOT,
  'qa/e2e/fixtures/seed/seed-isolated.mjs',
)
const POLICY_PATH = path.join(ROOT, 'qa/fixtures/staging/seed-policy.json')

function argFlag(name) {
  return process.argv.includes(name)
}

function loadPolicy() {
  try {
    return JSON.parse(fs.readFileSync(POLICY_PATH, 'utf8'))
  } catch (e) {
    return { loadError: String(e?.message || e) }
  }
}

async function main() {
  if (!fs.existsSync(SEED_MODULE)) {
    console.error(
      JSON.stringify({
        ok: false,
        error: `seed module missing: ${SEED_MODULE}`,
        hint: 'Dockerfile must COPY qa/e2e/fixtures/seed + qa/e2e/lib + qa/fixtures/staging',
      }),
    )
    process.exit(2)
  }

  const seed = await import(pathToFileURL(SEED_MODULE).href)

  if (argFlag('--self-test')) {
    const r = seed.runSeedSelfTests()
    const policy = loadPolicy()
    const out = {
      mode: 'self-test',
      policyId: policy.policyId ?? null,
      databaseName: seed.STAGING_DB_NAME,
      ...r,
    }
    console.log(JSON.stringify(out, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--disposable-proof')) {
    const r = await seed.runDisposableUpsertProof()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  // Live staging path
  const policy = loadPolicy()
  if (policy.productionDerived === true) {
    console.error(
      JSON.stringify({
        ok: false,
        error: 'seed-policy.json marks productionDerived=true — refused',
      }),
    )
    process.exit(1)
  }

  const result = await seed.seedStagingSynthetic({
    provenancePath:
      process.env.CAIRN_SEED_PROVENANCE_PATH ||
      path.join(ROOT, 'qa/e2e/out/runtime/staging-seed-provenance.json'),
  })

  // Print only safe summary (seedStagingSynthetic already redacts mysql password)
  console.log(
    JSON.stringify(
      {
        ok: result.ok,
        mode: result.mode,
        dbName: result.dbName,
        hostClass: result.hostClass,
        boardId: result.boardId,
        tasks: result.tasks,
        taskHash: result.pin?.taskHash,
        boardRev: result.pin?.boardRev,
        idempotent: result.idempotent,
        readback: result.readback,
        syntheticOnly: result.syntheticOnly,
        provenancePath: result.provenancePath,
        policyId: policy.policyId ?? null,
      },
      null,
      2,
    ),
  )
}

main().catch((e) => {
  const code = e?.code === 'STAGING_SEED_REFUSED' ? 3 : 1
  console.error(
    JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      code: e?.code ?? null,
      hostClass: e?.hostClass ?? null,
    }),
  )
  process.exit(code)
})
