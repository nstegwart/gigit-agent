/**
 * start-auth-preview --cleanup-on-exit harness (no-secret audit FAIL fix).
 *
 * Proves:
 * - parseArgs wires cleanupOnExit from --cleanup-on-exit (default false for Playwright)
 * - createAuthPreviewExitCleanup runs cleanupIsolatedAuthFixture exactly once
 * - SIGTERM / normal child-exit / error paths invoke the gate
 * - concurrent double-fire is idempotent (shared in-flight)
 * - cleanup-on-exit OFF is a no-op (Playwright globalTeardown ownership)
 * - cleanup log never carries secret values
 * - peer run sidecars are not deleted (THIS-run path only via eraseSecretsSidecar)
 *
 * Support evidence only (unit / harness) — LOCAL ONLY.
 */
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import {
  ensureAuthSecretsInEnv,
  eraseSecretsSidecar,
  resolveAuthSecretsSidecarPath,
  writeSecretsSidecar,
} from '../../qa/e2e/lib/auth-fixture.mjs'
import {
  createAuthPreviewExitCleanup,
  formatAuthPreviewCleanupLog,
  installAuthPreviewExitHandlers,
  parseArgs,
} from '../../qa/e2e/lib/start-auth-preview.mjs'

const ENV_KEYS = [
  'CAIRN_E2E_AUTH_RUN_ID',
  'CAIRN_E2E_AUTH_RUNTIME_META_PATH',
  'CAIRN_E2E_AUTH_SECRETS_PATH',
  'CAIRN_E2E_AUTH_STORAGE_PATH',
  'CAIRN_E2E_USERNAME',
  'CAIRN_E2E_PASSWORD',
  'CAIRN_MCP_BEARER',
  'CAIRN_BEARER_PRINCIPALS_JSON',
  'CAIRN_DB_NAME',
  'CAIRN_ISO_DB_NAME',
  'CAIRN_CSRF_SECRET',
] as const

const saved: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>> = {}

function clearAuthEnv() {
  for (const k of ENV_KEYS) {
    delete process.env[k]
  }
}

beforeEach(() => {
  for (const k of ENV_KEYS) {
    saved[k] = process.env[k]
  }
  clearAuthEnv()
})

afterEach(() => {
  try {
    eraseSecretsSidecar()
  } catch {
    /* ignore */
  }
  clearAuthEnv()
  for (const k of ENV_KEYS) {
    const v = saved[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

describe('parseArgs --cleanup-on-exit', () => {
  it('defaults cleanupOnExit to false (Playwright webServer path)', () => {
    const a = parseArgs(['--port', '3210', '--host', '127.0.0.1'])
    expect(a.cleanupOnExit).toBe(false)
    expect(a.port).toBe(3210)
    expect(a.host).toBe('127.0.0.1')
  })

  it('sets cleanupOnExit true when flag present', () => {
    const a = parseArgs(['--host', '127.0.0.1', '--port', '32955', '--cleanup-on-exit'])
    expect(a.cleanupOnExit).toBe(true)
    expect(a.port).toBe(32955)
  })
})

describe('createAuthPreviewExitCleanup once-gate', () => {
  it('cleanup-on-exit OFF skips cleanup (no call) — Playwright-owned teardown', async () => {
    const cleanup = vi.fn(async () => ({ runId: 'x', secretsSidecarErased: true }))
    const gate = createAuthPreviewExitCleanup({
      cleanupOnExit: false,
      cleanup,
    })
    const r = await gate.runOnce('child-exit')
    expect(r.skipped).toBe(true)
    expect(r.reason).toBe('cleanup-on-exit-off')
    expect(r.performed).toBe(false)
    expect(cleanup).not.toHaveBeenCalled()
    expect(gate.hasStarted()).toBe(false)
  })

  it('normal exit path invokes cleanup exactly once', async () => {
    let calls = 0
    const cleanup = vi.fn(async () => {
      calls += 1
      return {
        runId: 'run_normal',
        secretsSidecarErased: true,
        envScrubbed: ['CAIRN_E2E_PASSWORD', 'CAIRN_MCP_BEARER', 'CAIRN_CSRF_SECRET'],
        dbDropped: false,
        dbDropSkipped: 'keepDb',
        storageErased: false,
      }
    })
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const r = await gate.runOnce('child-exit')
    expect(r.performed).toBe(true)
    expect(r.trigger).toBe('child-exit')
    expect(r.runId).toBe('run_normal')
    expect(r.secretsSidecarErased).toBe(true)
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(calls).toBe(1)

    // second call: idempotent (does not re-enter cleanup)
    const r2 = await gate.runOnce('child-exit-again')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(r2.runId).toBe('run_normal')
    expect(r2.trigger).toBe('child-exit') // first-wins receipt
  })

  it('SIGTERM path invokes cleanup once', async () => {
    const cleanup = vi.fn(async () => ({
      runId: 'run_sigterm',
      secretsSidecarErased: true,
      envScrubbed: ['CAIRN_E2E_PASSWORD'],
      dbDropped: false,
    }))
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const r = await gate.runOnce('SIGTERM')
    expect(r.performed).toBe(true)
    expect(r.trigger).toBe('SIGTERM')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })

  it('error path still erases sidecar when cleanup throws', async () => {
    const cleanup = vi.fn(async () => {
      throw new Error('simulated-cleanup-failure')
    })
    const eraseSidecar = vi.fn(() => true)
    const gate = createAuthPreviewExitCleanup({
      cleanupOnExit: true,
      cleanup,
      eraseSidecar,
    })
    const r = await gate.runOnce('error')
    expect(r.performed).toBe(true)
    expect(r.error).toContain('simulated-cleanup-failure')
    expect(r.secretsSidecarErased).toBe(true)
    expect(eraseSidecar).toHaveBeenCalledTimes(1)
  })

  it('concurrent double-fire shares one in-flight cleanup (idempotent)', async () => {
    let resolveCleanup!: (v: object) => void
    const cleanup = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          resolveCleanup = resolve
        }),
    )
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const p1 = gate.runOnce('SIGTERM')
    const p2 = gate.runOnce('child-exit')
    expect(cleanup).toHaveBeenCalledTimes(1)
    resolveCleanup({
      runId: 'run_race',
      secretsSidecarErased: true,
      envScrubbed: [],
      dbDropped: false,
    })
    const [a, b] = await Promise.all([p1, p2])
    expect(a).toBe(b)
    expect(a.runId).toBe('run_race')
    expect(cleanup).toHaveBeenCalledTimes(1)
  })
})

describe('installAuthPreviewExitHandlers signal + child-exit', () => {
  function makeFakeChild() {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
    return {
      killed: false,
      kill: vi.fn(function (this: { killed: boolean }, _sig?: string) {
        this.killed = true
      }),
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        handlers[ev] = handlers[ev] || []
        handlers[ev].push(cb)
      }),
      emit(ev: string, ...args: unknown[]) {
        for (const cb of handlers[ev] || []) cb(...args)
      },
    }
  }

  function makeFakeProcess() {
    const handlers: Record<string, Array<(...args: unknown[]) => void>> = {}
    return {
      on: vi.fn((ev: string, cb: (...args: unknown[]) => void) => {
        handlers[ev] = handlers[ev] || []
        handlers[ev].push(cb)
      }),
      emit(ev: string, ...args: unknown[]) {
        for (const cb of handlers[ev] || []) cb(...args)
      },
    }
  }

  it('SIGTERM stops child, runs cleanup once, exits 1', async () => {
    const cleanup = vi.fn(async () => ({
      runId: 'h_sig',
      secretsSidecarErased: true,
      envScrubbed: ['CAIRN_E2E_PASSWORD'],
      dbDropped: false,
    }))
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const child = makeFakeChild()
    const proc = makeFakeProcess()
    const logs: string[] = []
    const exits: number[] = []

    installAuthPreviewExitHandlers({
      child,
      exitCleanup: gate,
      processRef: proc,
      log: (line) => logs.push(line),
      exitFn: (code) => exits.push(code),
    })

    proc.emit('SIGTERM')
    // allow async finally
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exits[0]).toBe(1)
    expect(logs.some((l) => l.startsWith('AUTH_PREVIEW_CLEANUP'))).toBe(true)
    expect(logs.join('\n')).toContain('trigger=SIGTERM')
    expect(logs.join('\n')).toContain('secretsSidecarErased=yes')
  })

  it('normal child-exit runs cleanup once and exits with child code', async () => {
    const cleanup = vi.fn(async () => ({
      runId: 'h_exit',
      secretsSidecarErased: true,
      envScrubbed: [],
      dbDropped: false,
    }))
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const child = makeFakeChild()
    const proc = makeFakeProcess()
    const exits: number[] = []
    const logs: string[] = []

    installAuthPreviewExitHandlers({
      child,
      exitCleanup: gate,
      processRef: proc,
      log: (line) => logs.push(line),
      exitFn: (code) => exits.push(code),
    })

    child.emit('exit', 0, null)
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exits[0]).toBe(0)
    expect(logs.join('\n')).toContain('trigger=child-exit')
  })

  it('does not double-cleanup when SIGTERM then child-exit race', async () => {
    let resolveCleanup!: (v: object) => void
    const cleanup = vi.fn(
      () =>
        new Promise<object>((resolve) => {
          resolveCleanup = resolve
        }),
    )
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: true, cleanup })
    const child = makeFakeChild()
    const proc = makeFakeProcess()
    const exits: number[] = []

    installAuthPreviewExitHandlers({
      child,
      exitCleanup: gate,
      processRef: proc,
      log: () => {},
      exitFn: (code) => exits.push(code),
    })

    proc.emit('SIGTERM')
    child.emit('exit', 1, 'SIGTERM') // should be ignored (exiting already)
    expect(cleanup).toHaveBeenCalledTimes(1)
    resolveCleanup({
      runId: 'race',
      secretsSidecarErased: true,
      envScrubbed: [],
      dbDropped: false,
    })
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(cleanup).toHaveBeenCalledTimes(1)
    expect(exits[0]).toBe(1)
  })

  it('cleanup-on-exit OFF does not call cleanup on child-exit', async () => {
    const cleanup = vi.fn(async () => ({ runId: 'off' }))
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: false, cleanup })
    const child = makeFakeChild()
    const proc = makeFakeProcess()
    const exits: number[] = []

    installAuthPreviewExitHandlers({
      child,
      exitCleanup: gate,
      processRef: proc,
      log: () => {},
      exitFn: (code) => exits.push(code),
    })

    child.emit('exit', 0, null)
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(cleanup).not.toHaveBeenCalled()
    expect(exits[0]).toBe(0)
  })

  it('cleanup-on-exit OFF: SIGTERM only kills child; exit waits for child (Playwright)', async () => {
    const cleanup = vi.fn(async () => ({ runId: 'off_sig' }))
    const gate = createAuthPreviewExitCleanup({ cleanupOnExit: false, cleanup })
    const child = makeFakeChild()
    const proc = makeFakeProcess()
    const exits: number[] = []

    installAuthPreviewExitHandlers({
      child,
      exitCleanup: gate,
      processRef: proc,
      log: () => {},
      exitFn: (code) => exits.push(code),
    })

    proc.emit('SIGTERM')
    expect(child.kill).toHaveBeenCalledWith('SIGTERM')
    expect(exits.length).toBe(0) // must not exit before child
    expect(cleanup).not.toHaveBeenCalled()

    child.emit('exit', 0, 'SIGTERM')
    await vi.waitFor(() => expect(exits.length).toBe(1))
    expect(cleanup).not.toHaveBeenCalled()
    expect(exits[0]).toBe(1) // signal path → exit 1
  })
})

describe('no secret values in cleanup log + peer sidecar safety', () => {
  it('formatAuthPreviewCleanupLog never embeds secret values', () => {
    const secretPassword = 'super-secret-password-value-xyz'
    const secretBearer = 'Bearer_abcdefghijklmnopqrstuvwxyz0123456789'
    const receipt = {
      performed: true,
      skipped: false,
      trigger: 'SIGTERM',
      runId: 'run_nolog',
      secretsSidecarErased: true,
      envScrubbed: ['CAIRN_E2E_PASSWORD', 'CAIRN_MCP_BEARER', 'CAIRN_CSRF_SECRET'],
      dbDropped: false,
      dbDropSkipped: null,
    }
    const log = formatAuthPreviewCleanupLog(receipt)
    expect(log).toContain('AUTH_PREVIEW_CLEANUP')
    expect(log).toContain('envScrubbed=CAIRN_E2E_PASSWORD,CAIRN_MCP_BEARER,CAIRN_CSRF_SECRET')
    expect(log).not.toContain(secretPassword)
    expect(log).not.toContain(secretBearer)
    // never print raw secret material — only key names
    expect(log).not.toMatch(/password=/i)
    expect(log).not.toMatch(/Bearer /)
  })

  it('real eraseSecretsSidecar removes THIS run only; peer sidecar survives', async () => {
    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'cleanup_peer_A'
    ensureAuthSecretsInEnv()
    const pathA = writeSecretsSidecar()
    process.env.CAIRN_E2E_PASSWORD = 'password-for-run-A-not-in-log'
    process.env.CAIRN_MCP_BEARER = 'bearer-for-run-A-not-in-log'

    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'cleanup_peer_B'
    ensureAuthSecretsInEnv()
    const pathB = writeSecretsSidecar()
    expect(pathA).not.toBe(pathB)
    expect(fs.existsSync(pathA)).toBe(true)
    expect(fs.existsSync(pathB)).toBe(true)

    // Gate for A only
    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'cleanup_peer_A'
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = pathA
    // re-pin resolve
    expect(resolveAuthSecretsSidecarPath()).toBe(pathA)

    const gate = createAuthPreviewExitCleanup({
      cleanupOnExit: true,
      keepDb: true,
      keepStorage: true,
      // use real cleanup (calls eraseSecretsSidecar for THIS path)
    })
    const receipt = await gate.runOnce('child-exit')
    expect(receipt.performed).toBe(true)
    expect(receipt.secretsSidecarErased).toBe(true)
    expect(fs.existsSync(pathA)).toBe(false)
    expect(fs.existsSync(pathB)).toBe(true)

    // cleanup B
    clearAuthEnv()
    process.env.CAIRN_E2E_AUTH_RUN_ID = 'cleanup_peer_B'
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = pathB
    eraseSecretsSidecar()
    expect(fs.existsSync(pathB)).toBe(false)

    const log = formatAuthPreviewCleanupLog(receipt)
    expect(log).not.toContain('password-for-run-A-not-in-log')
    expect(log).not.toContain('bearer-for-run-A-not-in-log')
  })
})

describe('start-auth-preview source contract (cleanup wiring)', () => {
  it('wires cleanupOnExit to cleanupIsolatedAuthFixture / eraseSecretsSidecar', () => {
    const src = fs.readFileSync(
      path.join(process.cwd(), 'qa/e2e/lib/start-auth-preview.mjs'),
      'utf8',
    )
    expect(src).toContain('cleanupIsolatedAuthFixture')
    expect(src).toContain('eraseSecretsSidecar')
    expect(src).toContain('createAuthPreviewExitCleanup')
    expect(src).toContain('installAuthPreviewExitHandlers')
    expect(src).toContain('--cleanup-on-exit')
    expect(src).toContain('cleanupOnExit')
    // Must actually consume the flag (not dead parse-only)
    expect(src).toMatch(/createAuthPreviewExitCleanup\(\s*\{\s*cleanupOnExit:\s*args\.cleanupOnExit/)
    // Never console.log secret env values
    expect(src).not.toMatch(/console\.log\([^)]*CAIRN_E2E_PASSWORD/)
    expect(src).not.toMatch(/console\.log\([^)]*CAIRN_MCP_BEARER/)
    expect(src).not.toMatch(/console\.log\([^)]*CAIRN_CSRF_SECRET[^)]*process\.env/)
  })

  it('Playwright config still omits --cleanup-on-exit (globalTeardown ownership)', () => {
    const cfg = fs.readFileSync(path.join(process.cwd(), 'playwright.config.ts'), 'utf8')
    expect(cfg).toContain('start-auth-preview.mjs')
    expect(cfg).not.toContain('--cleanup-on-exit')
    expect(cfg).toContain('globalTeardown')
  })
})
