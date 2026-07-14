#!/usr/bin/env node
/**
 * Staging gate fixture flow — promoted durable entrypoint.
 *
 * Modes:
 *   --self-test | --contract | (default)  pure fixture contract (no server, no DB)
 *   --manifest                            emit deterministic pack JSON
 *   --cleanup                             emit reversible cleanup plan JSON
 *   --real                                refuses unless STAGING_URL + dual gates;
 *                                         still does NOT mutate (read-only probe stub)
 *
 * Env (real, optional future):
 *   STAGING_URL, BOARD_ID, STAGING_BEARER_TOKEN (never printed)
 *   EXPECTED_SHA, SCHEMA_VERSION (default 006)
 *
 * Never prints credentials. Exit 0 only when selected mode fully passes.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')
const CONTRACT = join(ROOT, 'qa/fixtures/staging/gates/contract.mjs')

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  return {
    selfTest:
      flags.has('--self-test') ||
      flags.has('--contract') ||
      (!flags.has('--manifest') && !flags.has('--cleanup') && !flags.has('--real')),
    manifest: flags.has('--manifest'),
    cleanup: flags.has('--cleanup'),
    real: flags.has('--real'),
    help: flags.has('--help') || flags.has('-h'),
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/staging-gates.mjs --self-test
  node qa/e2e/flows/staging-gates.mjs --contract
  node qa/e2e/flows/staging-gates.mjs --manifest
  node qa/e2e/flows/staging-gates.mjs --cleanup
  node qa/e2e/flows/staging-gates.mjs --real   # refuses mutation; probe-only stub

See docs/control-center/STAGING_GATE_FIXTURES.md
`)
}

function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `staging-gates-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const contract = await import(pathToFileURL(CONTRACT).href)
  const manifest = contract.loadManifest()

  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: args.real ? process.env.STAGING_URL || null : 'mock://self-test',
      port: 'n/a',
      account: 'synthetic-staging-only',
      device: 'n/a',
      boardId: manifest.boardId,
      schema: manifest.schemaVersionExpected,
    })}`,
  )

  if (args.manifest) {
    const m = contract.buildDeterministicPackManifest()
    const payload = { ok: true, mode: 'manifest', manifest: m }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(0)
  }

  if (args.cleanup) {
    const plan = contract.buildCleanupPlan()
    const payload = { ok: true, mode: 'cleanup-plan', plan }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(0)
  }

  if (args.real) {
    // Real mode is a fail-closed stub: gate pack must not mutate staging from this flow.
    const payload = {
      ok: false,
      mode: 'real',
      code: 'STAGING_GATES_REAL_NO_MUTATE',
      message:
        'staging-gates --real is read-only/refused by design in this pack. Run --self-test for local proof. Staging mutation requires operator-approved seed-gates dual env + import APIs.',
      stagingMutation: false,
      residual_gaps: 'no live staging exercise in this flow',
    }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(5)
  }

  // self-test
  const self = contract.runGateContractSelfTests()
  const payload = {
    ok: self.ok,
    mode: 'self-test',
    fixtureId: self.fixtureId,
    packHash: self.packHash,
    fileCount: self.fileCount,
    failures: self.failures,
    checkCount: self.checks?.length ?? 0,
    passCount: (self.checks ?? []).filter((c) => c.ok).length,
    stagingMutation: false,
  }
  const receipt = writeReceipt(payload)
  console.log(JSON.stringify({ ...payload, receipt }, null, 2))
  process.exit(payload.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      code: e?.code ?? 'STAGING_GATES_FLOW_FATAL',
    }),
  )
  process.exit(2)
})
