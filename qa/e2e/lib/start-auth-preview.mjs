#!/usr/bin/env node
/**
 * webServer entry for Playwright IBILS auth fixture.
 *
 * Prepares iso DB + process-local secrets, then spawns `pnpm preview` with the
 * correct CAIRN_DB_NAME + CAIRN_BEARER_PRINCIPALS_JSON + CAIRN_CSRF_SECRET.
 * Playwright's webServer may start before globalSetup, so prepare MUST live here.
 *
 * FP-A: vite preview is production-like (NODE_ENV=production) and requires
 * CAIRN_CSRF_SECRET for mutators (collab-comment, feature-toggle, boards create).
 * When unset, mint an ephemeral secret into the preview child env only —
 * never log/print the value, never write it to the secrets sidecar.
 *
 * Usage: node qa/e2e/lib/start-auth-preview.mjs [--port 3210] [--host 127.0.0.1]
 *        [--cleanup-on-exit]
 *
 * Cleanup ownership:
 * - Playwright webServer (no flag): leave iso DB + sidecars for globalTeardown.
 * - Standalone / investigator (`--cleanup-on-exit`): on SIGTERM/SIGINT/child-exit/
 *   error, call cleanupIsolatedAuthFixture (includes eraseSecretsSidecar) exactly once.
 * - Never deletes peer runId sidecars (eraseSecretsSidecar resolves THIS run path only).
 */
import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  cleanupIsolatedAuthFixture,
  ensureAuthSecretsInEnv,
  ensureCsrfSecretInEnv,
  eraseSecretsSidecar,
  prepareIsolatedAuthFixture,
  resolveAuthRuntimeMetaPath,
  resolveAuthRunId,
  resolveAuthSecretsSidecarPath,
  writeSecretsSidecar,
} from './auth-fixture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

/**
 * Specs that mutate via CSRF under Playwright chromium webServer preview.
 * Documented for harness tests — not a runtime filter.
 */
export const CSRF_PREVIEW_MUTATOR_SPECS = Object.freeze([
  'collab-comment',
  'feature-toggle',
  'boards',
])

/**
 * @param {string[]} argv
 * @returns {{ port: number, host: string, cleanupOnExit: boolean }}
 */
export function parseArgs(argv) {
  const out = {
    port: Number(process.env.PORT || 3210),
    host: '127.0.0.1',
    cleanupOnExit: false,
  }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a === '--port') out.port = Number(argv[++i])
    else if (a === '--host') out.host = argv[++i]
    else if (a === '--cleanup-on-exit') out.cleanupOnExit = true
  }
  return out
}

/**
 * Build child env for `pnpm preview` after secrets + CSRF mint.
 * Pure helper for unit harness (no spawn). Never includes secret in return meta.
 *
 * @param {{ port: number|string, host?: string, baseEnv?: NodeJS.ProcessEnv }} opts
 * @returns {{ env: NodeJS.ProcessEnv, csrf: { configured: boolean, minted: boolean, source: string }, runId: string, metaPath: string, secretsPath: string }}
 */
export function buildAuthPreviewChildEnv(opts = {}) {
  const base = opts.baseEnv ?? process.env
  const port = opts.port ?? base.PORT ?? 3210
  // Pin run paths from current process (caller should have ensureAuthSecretsInEnv first).
  const runId = resolveAuthRunId()
  const metaPath = resolveAuthRuntimeMetaPath()
  const secretsPath = resolveAuthSecretsSidecarPath()

  // Mint AFTER sidecar write path: secret stays process-only.
  const csrf = ensureCsrfSecretInEnv()

  const env = {
    ...base,
    PORT: String(port),
    CAIRN_E2E_AUTH_RUN_ID: runId,
    CAIRN_E2E_AUTH_RUNTIME_META_PATH: metaPath,
    CAIRN_E2E_AUTH_SECRETS_PATH: secretsPath,
    CAIRN_DB_NAME: base.CAIRN_DB_NAME ?? process.env.CAIRN_DB_NAME,
    CAIRN_ISO_DB_NAME:
      base.CAIRN_ISO_DB_NAME ||
      process.env.CAIRN_ISO_DB_NAME ||
      base.CAIRN_DB_NAME ||
      process.env.CAIRN_DB_NAME,
    CAIRN_BEARER_PRINCIPALS_JSON:
      base.CAIRN_BEARER_PRINCIPALS_JSON ?? process.env.CAIRN_BEARER_PRINCIPALS_JSON,
    CAIRN_MCP_BEARER: base.CAIRN_MCP_BEARER ?? process.env.CAIRN_MCP_BEARER,
    CAIRN_E2E_USERNAME: base.CAIRN_E2E_USERNAME ?? process.env.CAIRN_E2E_USERNAME,
    CAIRN_E2E_PASSWORD: base.CAIRN_E2E_PASSWORD ?? process.env.CAIRN_E2E_PASSWORD,
    // Production-like preview mutators (collab/toggle/boards) require this.
    CAIRN_CSRF_SECRET: process.env.CAIRN_CSRF_SECRET,
  }

  return {
    env,
    csrf: {
      configured: Boolean(env.CAIRN_CSRF_SECRET?.trim()),
      minted: csrf.minted,
      source: csrf.source,
    },
    runId,
    metaPath,
    secretsPath,
  }
}

/**
 * AUTH_PREVIEW_START line — names only, never secret values.
 */
export function formatAuthPreviewStartLog({ port, host, isoDb, runId, metaPath, username, csrf }) {
  return [
    'AUTH_PREVIEW_START',
    `port=${port}`,
    `host=${host}`,
    `isoDb=${isoDb}`,
    `runId=${runId}`,
    `meta=${metaPath}`,
    `username=${username}`,
    `csrfConfigured=${csrf?.configured ? 'yes' : 'no'}`,
    `csrfSource=${csrf?.source ?? 'none'}`,
    `csrfMutators=${CSRF_PREVIEW_MUTATOR_SPECS.join(',')}`,
  ].join(' ')
}

/**
 * AUTH_PREVIEW_CLEANUP line — names/flags only, never secret values.
 * @param {Record<string, unknown> | null | undefined} receipt
 */
export function formatAuthPreviewCleanupLog(receipt) {
  if (!receipt) return 'AUTH_PREVIEW_CLEANUP none'
  if (receipt.skipped) {
    return [
      'AUTH_PREVIEW_CLEANUP',
      `performed=no`,
      `skipped=${receipt.reason ?? 'skipped'}`,
      `trigger=${receipt.trigger ?? 'n/a'}`,
    ].join(' ')
  }
  const scrubbed = Array.isArray(receipt.envScrubbed)
    ? receipt.envScrubbed.join(',')
    : 'none'
  return [
    'AUTH_PREVIEW_CLEANUP',
    `performed=yes`,
    `trigger=${receipt.trigger ?? 'n/a'}`,
    `runId=${receipt.runId ?? 'n/a'}`,
    `secretsSidecarErased=${receipt.secretsSidecarErased ? 'yes' : 'no'}`,
    `dbDropped=${receipt.dbDropped ? 'yes' : 'no'}`,
    `dbDropSkipped=${receipt.dbDropSkipped ?? 'none'}`,
    `envScrubbed=${scrubbed || 'none'}`,
    receipt.error != null ? `error=${String(receipt.error)}` : null,
  ]
    .filter(Boolean)
    .join(' ')
}

/**
 * Exactly-once exit cleanup gate for `--cleanup-on-exit`.
 *
 * When cleanupOnExit is false (Playwright default), runOnce is a no-op so
 * globalTeardown remains the sole owner of fixture teardown.
 *
 * Concurrent callers share one in-flight promise (SIGTERM + child-exit race).
 *
 * @param {{
 *   cleanupOnExit?: boolean,
 *   cleanup?: (opts?: object) => Promise<object>,
 *   eraseSidecar?: () => boolean,
 *   keepDb?: boolean,
 *   keepStorage?: boolean,
 * }} [opts]
 */
export function createAuthPreviewExitCleanup(opts = {}) {
  const cleanupOnExit = Boolean(opts.cleanupOnExit)
  const cleanup = opts.cleanup ?? cleanupIsolatedAuthFixture
  const eraseSidecar = opts.eraseSidecar ?? eraseSecretsSidecar
  let started = false
  /** @type {Promise<object> | null} */
  let inFlight = null
  /** @type {object | null} */
  let receipt = null
  let callCount = 0

  /**
   * @param {string} [trigger]
   * @returns {Promise<object>}
   */
  async function runOnce(trigger = 'exit') {
    callCount += 1
    if (!cleanupOnExit) {
      const skipped = {
        performed: false,
        skipped: true,
        reason: 'cleanup-on-exit-off',
        trigger,
        callCount,
      }
      // Do not pin receipt on skipped-off path so a later enable isn't expected;
      // flag is fixed at construction time.
      receipt = skipped
      return skipped
    }
    if (started && inFlight) {
      return inFlight
    }
    started = true
    inFlight = (async () => {
      try {
        const result = await cleanup({
          keepDb: opts.keepDb,
          keepStorage: opts.keepStorage,
        })
        // cleanupIsolatedAuthFixture already calls eraseSecretsSidecar; second call is idempotent.
        receipt = {
          performed: true,
          skipped: false,
          trigger,
          runId: result?.runId,
          secretsSidecarErased: Boolean(result?.secretsSidecarErased),
          envScrubbed: Array.isArray(result?.envScrubbed) ? result.envScrubbed : [],
          dbDropped: Boolean(result?.dbDropped),
          dbDropSkipped: result?.dbDropSkipped ?? null,
          storageErased: Boolean(result?.storageErased),
          callCount,
        }
        return receipt
      } catch (e) {
        let erased = false
        try {
          erased = Boolean(eraseSidecar())
        } catch {
          erased = false
        }
        receipt = {
          performed: true,
          skipped: false,
          trigger,
          error: String(e?.message || e),
          secretsSidecarErased: erased,
          envScrubbed: [],
          dbDropped: false,
          dbDropSkipped: null,
          callCount,
        }
        return receipt
      }
    })()
    return inFlight
  }

  return {
    cleanupOnExit,
    runOnce,
    hasStarted: () => started,
    getReceipt: () => receipt,
    getCallCount: () => callCount,
  }
}

/**
 * Install SIGTERM/SIGINT/child-exit handlers that run exit cleanup exactly once
 * when enabled. Pure-ish helper for unit tests (inject child + process + cleanup).
 *
 * @param {{
 *   child: { killed?: boolean, kill: (signal?: string) => void, on: (ev: string, cb: Function) => void },
 *   exitCleanup: ReturnType<typeof createAuthPreviewExitCleanup>,
 *   processRef?: NodeJS.Process,
 *   log?: (line: string) => void,
 *   exitFn?: (code: number) => void,
 * }} deps
 */
export function installAuthPreviewExitHandlers(deps) {
  const {
    child,
    exitCleanup,
    processRef = process,
    log = (line) => console.log(line),
    exitFn = (code) => process.exit(code),
  } = deps

  let exiting = false

  const performExitCleanup = async (trigger) => {
    const receipt = await exitCleanup.runOnce(trigger)
    if (exitCleanup.cleanupOnExit && receipt && !receipt.skipped) {
      log(formatAuthPreviewCleanupLog(receipt))
    }
    return receipt
  }

  const stopChild = (signal) => {
    if (!child.killed) {
      try {
        child.kill(signal)
      } catch {
        /* ignore */
      }
    }
  }

  const shutdownFromSignal = (signal) => {
    if (exiting) return
    // Always forward signal to preview child.
    stopChild(signal)
    if (!exitCleanup.cleanupOnExit) {
      // Playwright path: do NOT exit here — wait for child 'exit' so webServer
      // teardown stays child-driven (globalTeardown owns fixture cleanup).
      return
    }
    // Standalone --cleanup-on-exit: scrub THIS run's secrets/DB exactly once,
    // then exit (child-exit handler becomes a no-op via `exiting`).
    exiting = true
    void performExitCleanup(signal).finally(() => {
      exitFn(1)
    })
  }

  processRef.on('SIGTERM', () => shutdownFromSignal('SIGTERM'))
  processRef.on('SIGINT', () => shutdownFromSignal('SIGINT'))

  child.on('exit', (code, signal) => {
    if (exiting) return
    exiting = true
    const trigger = signal ? `child-signal-${signal}` : 'child-exit'
    void performExitCleanup(trigger).finally(() => {
      if (signal) exitFn(1)
      else exitFn(code ?? 1)
    })
  })

  return {
    performExitCleanup,
    isExiting: () => exiting,
    stopChild,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const exitCleanup = createAuthPreviewExitCleanup({ cleanupOnExit: args.cleanupOnExit })

  const performExitCleanup = async (trigger) => {
    const receipt = await exitCleanup.runOnce(trigger)
    if (args.cleanupOnExit && receipt && !receipt.skipped) {
      console.log(formatAuthPreviewCleanupLog(receipt))
    }
    return receipt
  }

  try {
    // Inherit CAIRN_E2E_AUTH_RUN_ID / meta path from Playwright parent when present.
    ensureAuthSecretsInEnv()
    const prep = await prepareIsolatedAuthFixture({ slug: 'authfix' })
    if (!prep?.ok) {
      console.error('FAIL-CLOSED start-auth-preview: prepare failed', prep)
      await performExitCleanup('prepare-failed')
      process.exit(2)
    }
    // Sidecar so Playwright workers/globalSetup share the same secrets/DB name.
    // Intentionally BEFORE CSRF mint — CAIRN_CSRF_SECRET must never land on disk.
    writeSecretsSidecar()

    const built = buildAuthPreviewChildEnv({ port: args.port, host: args.host })
    const env = built.env

    if (!built.csrf.configured) {
      console.error(
        'FAIL-CLOSED start-auth-preview: CAIRN_CSRF_SECRET missing after ensureCsrfSecretInEnv',
      )
      await performExitCleanup('csrf-missing')
      process.exit(2)
    }

    console.log(
      formatAuthPreviewStartLog({
        port: args.port,
        host: args.host,
        isoDb: env.CAIRN_DB_NAME,
        runId: built.runId,
        metaPath: built.metaPath,
        username: env.CAIRN_E2E_USERNAME,
        csrf: built.csrf,
      }),
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

    installAuthPreviewExitHandlers({
      child,
      exitCleanup,
      // process + console.log + process.exit defaults
    })
  } catch (e) {
    console.error(String(e?.stack || e))
    await performExitCleanup('error')
    process.exit(1)
  }
}

// Only run when executed as the webServer entrypoint — not when unit tests import helpers.
const isDirectRun =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isDirectRun) {
  main().catch(async (e) => {
    console.error(String(e?.stack || e))
    // Best-effort: if flag was passed, still try to scrub THIS run's sidecar.
    // parseArgs is pure; safe if main never constructed the gate.
    try {
      const args = parseArgs(process.argv.slice(2))
      if (args.cleanupOnExit) {
        const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true })
        const receipt = await gate.runOnce('unhandled-error')
        if (receipt && !receipt.skipped) {
          console.log(formatAuthPreviewCleanupLog(receipt))
        }
      }
    } catch {
      /* ignore secondary cleanup errors */
    }
    process.exit(1)
  })
}
