/**
 * Bounded preview-server lifecycle for the deterministic browser harness.
 * One owned process: start → wait health → (caller work) → stop in finally.
 * Never assumes a cross-command daemon; never kills PIDs it did not start
 * unless CAIRN_HARNESS_ALLOW_PORT_STEAL=1 (explicit).
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import path from 'node:path'

export function pickFreePort(preferred) {
  return new Promise((resolve, reject) => {
    const server = net.createServer()
    server.unref()
    server.on('error', reject)
    server.listen(preferred ?? 0, '127.0.0.1', () => {
      const addr = server.address()
      const port = typeof addr === 'object' && addr ? addr.port : 0
      server.close((err) => (err ? reject(err) : resolve(port)))
    })
  })
}

export async function waitForHttpOk(url, { timeoutMs = 90_000, intervalMs = 400 } = {}) {
  const start = Date.now()
  let lastErr = null
  while (Date.now() - start < timeoutMs) {
    try {
      const res = await fetch(url, { redirect: 'manual' })
      // 2xx/3xx (login redirect) counts as server up
      if (res.status >= 200 && res.status < 500) {
        return { ok: true, status: res.status, url, elapsedMs: Date.now() - start }
      }
      lastErr = `status ${res.status}`
    } catch (e) {
      lastErr = String(e?.message || e)
    }
    await new Promise((r) => setTimeout(r, intervalMs))
  }
  throw new Error(
    `waitForHttpOk timeout after ${timeoutMs}ms url=${url} last=${lastErr ?? 'none'}`,
  )
}

/**
 * Disposable harness public allowlist for owned-preview child env only.
 *
 * Product semantics stay fail-closed: empty/unset `CAIRN_PUBLIC_BOARD_IDS` deny all.
 * This helper never mutates `process.env` — inject via `startOwnedPreviewServer({ env })`.
 *
 * @param {string} boardId exact board id to allow (must be non-empty after trim)
 * @returns {{ CAIRN_PUBLIC_BOARD_IDS: string }}
 */
export function buildOwnedPreviewPublicAllowlistEnv(boardId) {
  const id = typeof boardId === 'string' ? boardId.trim() : ''
  if (!id) {
    throw new Error(
      'FAIL-CLOSED harness public allowlist: non-empty boardId required for CAIRN_PUBLIC_BOARD_IDS',
    )
  }
  // Exact single board — not a wildcard, not comma-joined fixtures.
  return { CAIRN_PUBLIC_BOARD_IDS: id }
}

/**
 * Pure membership check matching product `resolvePublicBoardAllowlist` parse rules
 * (comma/space/semicolon split; empty raw → deny all). Harness self-tests only.
 *
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined> | null | undefined} env
 * @param {string} boardId
 * @returns {boolean}
 */
export function publicAllowlistEnvAllows(env, boardId) {
  if (!boardId || typeof boardId !== 'string') return false
  const raw = String(env?.CAIRN_PUBLIC_BOARD_IDS ?? env?.CAIRN_PUBLIC_BOARDS ?? '').trim()
  if (!raw) return false
  const set = new Set(
    raw
      .split(/[,;\s]+/)
      .map((s) => s.trim())
      .filter(Boolean),
  )
  return set.has(boardId)
}

/**
 * Start `pnpm preview` (or CAIRN_HARNESS_SERVER_CMD) on a free port with env overrides.
 * Returns { pid, port, baseUrl, stop, logPath, child }.
 *
 * Child-only secrets (e.g. CAIRN_BEARER_PRINCIPALS_JSON) must be passed via opts.env.
 * This helper never logs env values. opts.redactEnvKeys is reserved for callers that
 * mirror env into receipts — values are never written here.
 */
export async function startOwnedPreviewServer(opts = {}) {
  const cwd = opts.cwd ?? process.cwd()
  const port = opts.port ?? (await pickFreePort(opts.preferredPort ?? 0))
  const host = opts.host ?? '127.0.0.1'
  const baseUrl = `http://${host}:${port}`
  const logDir = opts.logDir ?? path.join(cwd, 'qa/e2e/out/runtime')
  fs.mkdirSync(logDir, { recursive: true })
  const logPath = path.join(logDir, `preview-${port}.log`)
  const logFd = fs.openSync(logPath, 'w')

  // Child env only: caller may inject CAIRN_BEARER_PRINCIPALS_JSON for synthetic ROOT.
  // Do not elevate via CAIRN_WRITE_TOKEN. Never put secrets on the command line.
  const env = {
    ...process.env,
    ...(opts.env ?? {}),
    PORT: String(port),
    WEB_BASE: baseUrl,
  }
  // Track which sensitive keys were injected (names only — for cleanup receipts).
  const injectedEnvKeys = Object.keys(opts.env ?? {}).filter((k) =>
    /CAIRN_BEARER|CAIRN_MCP_BEARER|CAIRN_WRITE_TOKEN|PASSWORD|SECRET|TOKEN/i.test(k),
  )

  const cmd = opts.command ?? process.env.CAIRN_HARNESS_SERVER_CMD
  let child
  if (cmd) {
    child = spawn(cmd, {
      cwd,
      env,
      shell: true,
      stdio: ['ignore', logFd, logFd],
      detached: false,
    })
  } else {
    // vite preview production build — requires prior `pnpm build`
    child = spawn(
      'pnpm',
      ['preview', '--host', host, '--port', String(port), '--strictPort'],
      {
        cwd,
        env,
        stdio: ['ignore', logFd, logFd],
        detached: false,
      },
    )
  }

  const state = {
    pid: child.pid,
    port,
    host,
    baseUrl,
    logPath,
    startedAt: new Date().toISOString(),
    stopped: false,
    exitCode: null,
  }

  child.on('exit', (code) => {
    state.exitCode = code
  })

  const stop = async () => {
    if (state.stopped) return { already: true, pid: state.pid }
    state.stopped = true
    try {
      if (child.pid && !child.killed) {
        child.kill('SIGTERM')
        await new Promise((r) => setTimeout(r, 800))
        if (!child.killed && state.exitCode === null) {
          try {
            process.kill(child.pid, 'SIGKILL')
          } catch {
            /* already gone */
          }
        }
      }
    } finally {
      try {
        fs.closeSync(logFd)
      } catch {
        /* ignore */
      }
    }
    return { stopped: true, pid: state.pid, exitCode: state.exitCode }
  }

  const healthPath = opts.healthPath ?? '/'
  const health = await waitForHttpOk(`${baseUrl}${healthPath}`, {
    timeoutMs: opts.healthTimeoutMs ?? 90_000,
  })

  return {
    ...state,
    health,
    stop,
    child,
    /** Sensitive env key names injected into child only (values never returned). */
    injectedEnvKeys,
  }
}

/** True when nothing listens on 127.0.0.1:port (post-cleanup proof). */
export async function portIsFree(port, host = '127.0.0.1') {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host }, () => {
      socket.destroy()
      resolve(false)
    })
    socket.on('error', () => resolve(true))
    socket.setTimeout(500, () => {
      socket.destroy()
      resolve(true)
    })
  })
}
