/**
 * Auth fail-closed unit suite: login throttle abuse + concurrent atomic bootstrap.
 * Pure helpers only (no live HTTP / no DB for these proofs).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  BootstrapError,
  LOGIN_THROTTLE_V1,
  checkLoginThrottle,
  clearLoginThrottleKey,
  clearLoginThrottleStore,
  recordLoginFailure,
  runAtomicFirstAdminBootstrap,
  type AtomicBootstrapDeps,
} from '#/server/auth-store'
import type { UserRow } from '#/lib/types'

afterEach(() => {
  clearLoginThrottleStore()
})

// ---------------------------------------------------------------------------
// Login abuse throttle
// ---------------------------------------------------------------------------
describe('login throttle (LOGIN_THROTTLE_V1)', () => {
  const policy = {
    ...LOGIN_THROTTLE_V1,
    maxFailures: 5,
    windowMs: 60_000,
    lockoutMs: 120_000,
  }

  it('allows attempts under maxFailures', () => {
    const t0 = 1_000_000
    expect(checkLoginThrottle('alice', t0, policy).allowed).toBe(true)
    for (let i = 0; i < 4; i++) {
      const d = recordLoginFailure('alice', t0 + i, policy)
      expect(d.allowed).toBe(true)
      expect(d.remaining).toBe(policy.maxFailures - (i + 1))
    }
    expect(checkLoginThrottle('alice', t0 + 10, policy).allowed).toBe(true)
  })

  it('locks after maxFailures and reports LOGIN_THROTTLED', () => {
    const t0 = 2_000_000
    for (let i = 0; i < policy.maxFailures; i++) {
      recordLoginFailure('bob', t0 + i, policy)
    }
    const blocked = checkLoginThrottle('bob', t0 + 100, policy)
    expect(blocked.allowed).toBe(false)
    if (!blocked.allowed) {
      expect(blocked.code).toBe('LOGIN_THROTTLED')
      expect(blocked.retryAfterSeconds).toBeGreaterThan(0)
    }
    // Further failures while locked stay blocked
    const again = recordLoginFailure('bob', t0 + 200, policy)
    expect(again.allowed).toBe(false)
  })

  it('keys are case-insensitive / trimmed; success clears key', () => {
    const t0 = 3_000_000
    recordLoginFailure('  Eve  ', t0, policy)
    expect(checkLoginThrottle('eve', t0 + 1, policy).remaining).toBe(policy.maxFailures - 1)
    clearLoginThrottleKey('EVE')
    expect(checkLoginThrottle('eve', t0 + 2, policy).remaining).toBe(policy.maxFailures)
  })

  it('window expiry resets failure count', () => {
    const t0 = 4_000_000
    for (let i = 0; i < policy.maxFailures; i++) {
      recordLoginFailure('carol', t0 + i, policy)
    }
    expect(checkLoginThrottle('carol', t0 + 10, policy).allowed).toBe(false)
    // After window + lockout past lock
    const after = t0 + policy.lockoutMs + policy.windowMs + 1
    expect(checkLoginThrottle('carol', after, policy).allowed).toBe(true)
  })

  it('hostile rapid-fire abuse is bounded (no unbounded retries after lock)', () => {
    const t0 = 5_000_000
    let lockedAt = -1
    for (let i = 0; i < 50; i++) {
      const d = recordLoginFailure('attacker', t0 + i, policy)
      if (!d.allowed && lockedAt < 0) lockedAt = i
    }
    expect(lockedAt).toBe(policy.maxFailures - 1)
    const late = checkLoginThrottle('attacker', t0 + 1000, policy)
    expect(late.allowed).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Concurrent atomic first-admin bootstrap
// ---------------------------------------------------------------------------
describe('atomic first-admin bootstrap', () => {
  function makeDeps(opts?: {
    initialCount?: number
    lockDelayMs?: number
  }): AtomicBootstrapDeps & { created: UserRow[]; lockHeld: boolean } {
    let count = opts?.initialCount ?? 0
    let lockHeld = false
    const created: UserRow[] = []
    const waiters: Array<() => void> = []

    const deps: AtomicBootstrapDeps & { created: UserRow[]; lockHeld: boolean } = {
      created,
      get lockHeld() {
        return lockHeld
      },
      acquireLock: async () => {
        if (lockHeld) {
          // Wait until released (simulates GET_LOCK queue with timeout fail-fast for tests)
          await new Promise<void>((resolve) => waiters.push(resolve))
        }
        lockHeld = true
        if (opts?.lockDelayMs) {
          await new Promise((r) => setTimeout(r, opts.lockDelayMs))
        }
        return true
      },
      releaseLock: async () => {
        lockHeld = false
        const w = waiters.shift()
        if (w) w()
      },
      countUsers: async () => count,
      insertAdmin: async (input) => {
        // Re-check under lock (mirrors production path)
        if (count > 0) {
          throw new BootstrapError(
            'SETUP_ALREADY_COMPLETE',
            'Setup already complete — ask an admin for an account',
          )
        }
        const row: UserRow = {
          id: `admin-${created.length + 1}`,
          username: input.username,
          role: 'admin',
          boards: [],
        }
        created.push(row)
        count = 1
        return row
      },
    }
    return deps
  }

  it('single bootstrap succeeds when empty', async () => {
    const deps = makeDeps()
    const user = await runAtomicFirstAdminBootstrap(
      { username: 'root', password: 'secret1' },
      deps,
    )
    expect(user.username).toBe('root')
    expect(user.role).toBe('admin')
    expect(deps.created).toHaveLength(1)
  })

  it('second bootstrap after first → SETUP_ALREADY_COMPLETE', async () => {
    const deps = makeDeps()
    await runAtomicFirstAdminBootstrap({ username: 'a', password: 'secret1' }, deps)
    await expect(
      runAtomicFirstAdminBootstrap({ username: 'b', password: 'secret2' }, deps),
    ).rejects.toMatchObject({ code: 'SETUP_ALREADY_COMPLETE' })
    expect(deps.created).toHaveLength(1)
  })

  it('concurrent bootstrap: exactly one admin created', async () => {
    const deps = makeDeps()
    const results = await Promise.allSettled([
      runAtomicFirstAdminBootstrap({ username: 'racer-1', password: 'secret1' }, deps),
      runAtomicFirstAdminBootstrap({ username: 'racer-2', password: 'secret2' }, deps),
      runAtomicFirstAdminBootstrap({ username: 'racer-3', password: 'secret3' }, deps),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled')
    const rejected = results.filter((r) => r.status === 'rejected')
    expect(fulfilled).toHaveLength(1)
    expect(rejected).toHaveLength(2)
    expect(deps.created).toHaveLength(1)
    for (const r of rejected) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(BootstrapError)
      expect((r as PromiseRejectedResult).reason.code).toBe('SETUP_ALREADY_COMPLETE')
    }
  })

  it('lock timeout surfaces BOOTSTRAP_LOCK_TIMEOUT', async () => {
    const deps: AtomicBootstrapDeps = {
      acquireLock: async () => false,
      releaseLock: async () => {},
      countUsers: async () => 0,
      insertAdmin: async () => {
        throw new Error('should not insert')
      },
    }
    await expect(
      runAtomicFirstAdminBootstrap({ username: 'x', password: 'secret1' }, deps),
    ).rejects.toMatchObject({ code: 'BOOTSTRAP_LOCK_TIMEOUT' })
  })
})
