#!/usr/bin/env node
/**
 * webServer entry for Playwright IBILS auth fixture.
 *
 * Prepares iso DB + process-local secrets, then spawns `pnpm preview` with the
 * correct CAIRN_DB_NAME + CAIRN_BEARER_PRINCIPALS_JSON. Playwright's webServer
 * may start before globalSetup, so prepare MUST live in this process.
 *
 * Usage: node qa/e2e/lib/start-auth-preview.mjs [--port 3210] [--host 127.0.0.1]
 * Cleanup of iso DB remains globalTeardown's job (or --cleanup-on-exit).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  ensureAuthSecretsInEnv,
  prepareIsolatedAuthFixture,
  resolveAuthRuntimeMetaPath,
  resolveAuthRunId,
  resolveAuthSecretsSidecarPath,
  writeSecretsSidecar,
} from './auth-fixture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

function parseArgs(argv) {
  const out = { port: Number(process.env.PORT || 3210), host: '127.0.0.1' }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--cleanup-on-exit') out.cleanupOnExit = true
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  // Inherit CAIRN_E2E_AUTH_RUN_ID / meta path from Playwright parent when present.
  ensureAuthSecretsInEnv()
  const runId = resolveAuthRunId()
  const metaPath = resolveAuthRuntimeMetaPath()
  const secretsPath = resolveAuthSecretsSidecarPath()
  const prep = await prepareIsolatedAuthFixture({ slug: 'authfix' })
  if (!prep?.ok) {
    console.error('FAIL-CLOSED start-auth-preview: prepare failed', prep)
    process.exit(2)
  }
  // Sidecar so Playwright workers/globalSetup share the same secrets/DB name.
  writeSecretsSidecar()

  const env = {
    ...process.env,
    PORT: String(args.port),
    CAIRN_E2E_AUTH_RUN_ID: runId,
    CAIRN_E2E_AUTH_RUNTIME_META_PATH: metaPath,
    CAIRN_E2E_AUTH_SECRETS_PATH: secretsPath,
    CAIRN_DB_NAME: process.env.CAIRN_DB_NAME,
    CAIRN_ISO_DB_NAME: process.env.CAIRN_ISO_DB_NAME || process.env.CAIRN_DB_NAME,
    CAIRN_BEARER_PRINCIPALS_JSON: process.env.CAIRN_BEARER_PRINCIPALS_JSON,
    CAIRN_MCP_BEARER: process.env.CAIRN_MCP_BEARER,
    CAIRN_E2E_USERNAME: process.env.CAIRN_E2E_USERNAME,
    CAIRN_E2E_PASSWORD: process.env.CAIRN_E2E_PASSWORD,
  }

  console.log(
    [
      'AUTH_PREVIEW_START',
      `port=${args.port}`,
      `host=${args.host}`,
      `isoDb=${env.CAIRN_DB_NAME}`,
      `runId=${runId}`,
      `meta=${metaPath}`,
      `username=${env.CAIRN_E2E_USERNAME}`,
    ].join(' '),
  )

  const child = spawn(
    'pnpm',
    ['preview', '--host', args.host, '--port', String(args.port), '--strictPort'],
    {
      cwd: REPO_ROOT,
      env,
      stdio: 'inherit',
    },
  )

  const stop = (signal) => {
    if (!child.killed) {
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
  }
  process.on('SIGTERM', () => stop('SIGTERM'))
  process.on('SIGINT', () => stop('SIGINT'))

  child.on('exit', (code, signal) => {
    if (signal) process.exit(1)
    process.exit(code ?? 1)
  })
}

main().catch((e) => {
  console.error(String(e?.stack || e))
  process.exit(1)
})
