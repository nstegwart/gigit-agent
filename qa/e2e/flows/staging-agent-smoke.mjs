#!/usr/bin/env node
/**
 * Staging agent MCP smoke — promoted durable flow.
 *
 * Modes:
 *   --self-test | --contract   pure fixture + mocked MCP lifecycle (no server)
 *   --real                     SSH-tunneled STAGING_URL + authorized bearer env ref
 *   (default)                  --self-test
 *
 * Env (real mode):
 *   STAGING_URL                 e.g. http://127.0.0.1:33211
 *   BOARD_ID                    default mfs-rebuild (from fixture MANIFEST)
 *   STAGING_BEARER_TOKEN_REF    env NAME holding bearer (optional; default candidates)
 *   STAGING_BEARER_TOKEN | STAGING_BEARER | CAIRN_MCP_BEARER
 *   EXPECTED_SHA | FULL_SHA     fail-closed vs healthz.deployedSha when set
 *   SCHEMA_VERSION              default from MANIFEST (005)
 *   STAGING_ALLOW_WEAK_PIN=1    only if healthz lacks pin fields (not for SHA)
 *   STAGING_BIND_LIVE_BOARD_REV=1  rebind expectedBoardRev from runtime pin
 *
 * Never prints credentials. Exit 0 only when selected mode fully passes.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  resolveStagingUrl,
  resolveBoardId,
} from '../lib/env.mjs'
import {
  loadStagingManifest,
  resolveAuthorizedTokenRef,
  resolveExpectedSha,
  resolveExpectedSchema,
  resolveSmokeBoardId,
  runRealStagingAgentSmoke,
  runStagingAgentSmokeSelfTests,
} from '../lib/staging-agent-smoke.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  return {
    selfTest: flags.has('--self-test') || flags.has('--contract') || flags.size === 0,
    real: flags.has('--real'),
    help: flags.has('--help') || flags.has('-h'),
    // if both, real wins when explicitly requested; self-test alone is default
    onlySelfTest: (flags.has('--self-test') || flags.has('--contract')) && !flags.has('--real'),
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/staging-agent-smoke.mjs --self-test
  node qa/e2e/flows/staging-agent-smoke.mjs --contract
  node qa/e2e/flows/staging-agent-smoke.mjs --real

Env for --real: STAGING_URL, BOARD_ID, STAGING_BEARER_TOKEN (or aliases), EXPECTED_SHA
Credentials are never printed. See qa/fixtures/staging/MANIFEST.json.
`)
}

function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `staging-agent-smoke-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    // scrub any accidental secret keys
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

  const manifest = loadStagingManifest()
  const mode = args.real && !args.onlySelfTest ? 'real' : 'self-test'

  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: mode === 'real' ? resolveStagingUrl() : 'mock://self-test',
      port: mode === 'real' ? (() => {
        try {
          return new URL(resolveStagingUrl()).port || '80'
        } catch {
          return null
        }
      })() : null,
      account: mode === 'real' ? `tokenRef=${resolveAuthorizedTokenRef().tokenRef}` : 'SYNTH_SELF_TEST',
      device: 'n/a-mcp-http',
      boardId: resolveSmokeBoardId(),
      fixtureId: manifest.fixtureId,
      mode,
    })}`,
  )

  if (mode === 'self-test') {
    const result = await runStagingAgentSmokeSelfTests()
    const receiptPath = writeReceipt({
      mode: 'self-test',
      ok: result.ok,
      failCount: result.failCount,
      results: result.results,
      fixtureId: manifest.fixtureId,
      at: new Date().toISOString(),
    })
    console.log(
      JSON.stringify(
        {
          mode: 'self-test',
          ok: result.ok,
          failCount: result.failCount,
          passCount: result.results.filter((r) => r.pass).length,
          total: result.results.length,
          receiptPath,
          failed: result.results.filter((r) => !r.pass).map((r) => r.name),
        },
        null,
        2,
      ),
    )
    process.exit(result.ok ? 0 : 1)
  }

  // real mode
  const tokenProbe = resolveAuthorizedTokenRef()
  if (!tokenProbe.ok) {
    console.error(
      JSON.stringify({
        mode: 'real',
        ok: false,
        code: 'MISSING_BEARER',
        tokenRef: tokenProbe.tokenRef,
        reason: tokenProbe.reason,
      }),
    )
    process.exit(2)
  }
  // drop value immediately from probe used for presence
  tokenProbe.bearer = ''

  try {
    const out = await runRealStagingAgentSmoke({})
    const receiptPath = writeReceipt({
      mode: 'real',
      ok: out.ok,
      ownerTarget: out.ownerTarget,
      tokenMeta: out.tokenMeta,
      receipt: out.receipt,
      at: new Date().toISOString(),
    })
    console.log(
      JSON.stringify(
        {
          mode: 'real',
          ok: out.ok,
          ownerTarget: out.ownerTarget,
          tokenMeta: out.tokenMeta,
          smokeRunId: out.receipt?.smokeRunId,
          residuals: out.receipt?.residuals ?? [],
          steps: Object.keys(out.receipt?.steps ?? {}),
          receiptPath,
        },
        null,
        2,
      ),
    )
    process.exit(out.ok ? 0 : 1)
  } catch (e) {
    const code = e?.code || e?.detail?.code || 'REAL_SMOKE_FAIL'
    const msg = String(e?.message || e)
    // never echo bearer
    console.error(
      JSON.stringify({
        mode: 'real',
        ok: false,
        code,
        error: msg.replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]'),
        tokenRef: resolveAuthorizedTokenRef().tokenRef,
        boardId: resolveBoardId(manifest.boardId),
        expectedSha: resolveExpectedSha(process.env, { require: false }),
        expectedSchema: resolveExpectedSchema(),
      }),
    )
    process.exit(1)
  }
}

main().catch((e) => {
  console.error(String(e?.stack || e?.message || e))
  process.exit(1)
})
