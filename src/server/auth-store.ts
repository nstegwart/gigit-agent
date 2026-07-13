// Human accounts + sessions + per-board visibility. Server-only.
// Passwords: node scrypt (built-in, no native dep) stored as `scrypt$<saltHex>$<hashHex>`.
// Sessions: opaque random token in the `sessions` table (revocable), 30-day expiry.
import { randomBytes, randomUUID, scrypt as _scrypt, timingSafeEqual } from 'node:crypto'
import { promisify } from 'node:util'

import { db } from './db'
import type { Role, SessionUser, UserRow } from '#/lib/types'

const scrypt = promisify(_scrypt) as (pw: string, salt: Buffer, keylen: number) => Promise<Buffer>
const SESSION_DAYS = 30

async function hashPassword(pw: string): Promise<string> {
  const salt = randomBytes(16)
  const dk = await scrypt(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}
async function verifyPassword(pw: string, stored: string): Promise<boolean> {
  const [algo, saltHex, hashHex] = stored.split('$')
  if (algo !== 'scrypt' || !saltHex || !hashHex) return false
  const expected = Buffer.from(hashHex, 'hex')
  const dk = await scrypt(pw, Buffer.from(saltHex, 'hex'), expected.length)
  return dk.length === expected.length && timingSafeEqual(dk, expected)
}

// ---- schema (idempotent, ensured once per process) ----
let schemaReady: Promise<void> | null = null
async function buildAuthSchema(): Promise<void> {
  await db().query(`CREATE TABLE IF NOT EXISTS users (
    id CHAR(36) PRIMARY KEY,
    username VARCHAR(64) NOT NULL UNIQUE,
    password_hash VARCHAR(255) NOT NULL,
    role VARCHAR(16) NOT NULL DEFAULT 'member',
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
  ) CHARACTER SET utf8mb4`)
  await db().query(`CREATE TABLE IF NOT EXISTS user_boards (
    user_id CHAR(36) NOT NULL,
    board_id VARCHAR(64) NOT NULL,
    PRIMARY KEY (user_id, board_id),
    INDEX idx_ub_user (user_id)
  ) CHARACTER SET utf8mb4`)
  await db().query(`CREATE TABLE IF NOT EXISTS sessions (
    token CHAR(64) PRIMARY KEY,
    user_id CHAR(36) NOT NULL,
    created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at DATETIME NOT NULL,
    INDEX idx_sess_user (user_id)
  ) CHARACTER SET utf8mb4`)
}
function ensure(): Promise<void> {
  if (!schemaReady) schemaReady = buildAuthSchema()
  return schemaReady
}

// ---- bootstrap ----
export async function countUsers(): Promise<number> {
  await ensure()
  const [rows] = await db().query('SELECT COUNT(*) AS n FROM users')
  return Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
}

/** Named MySQL advisory lock key for first-admin bootstrap serialization. */
export const BOOTSTRAP_LOCK_NAME = 'cairn_first_admin_bootstrap' as const

/**
 * Injectable bootstrap deps for unit tests (concurrent race proofs without live DB).
 * Production path uses MySQL GET_LOCK + COUNT + INSERT on a pinned connection.
 */
export type AtomicBootstrapDeps = {
  acquireLock: () => Promise<boolean>
  releaseLock: () => Promise<void>
  countUsers: () => Promise<number>
  insertAdmin: (input: { username: string; password: string }) => Promise<UserRow>
}

export class BootstrapError extends Error {
  readonly code: 'SETUP_ALREADY_COMPLETE' | 'BOOTSTRAP_LOCK_TIMEOUT' | 'BOOTSTRAP_FAILED'
  constructor(
    code: 'SETUP_ALREADY_COMPLETE' | 'BOOTSTRAP_LOCK_TIMEOUT' | 'BOOTSTRAP_FAILED',
    message: string,
  ) {
    super(message)
    this.name = 'BootstrapError'
    this.code = code
  }
}

/**
 * Serialize first-admin creation: lock → re-check empty → insert once.
 * Concurrent callers: exactly one succeeds; others get SETUP_ALREADY_COMPLETE or lock timeout.
 */
export async function runAtomicFirstAdminBootstrap(
  input: { username: string; password: string },
  deps: AtomicBootstrapDeps,
): Promise<UserRow> {
  const got = await deps.acquireLock()
  if (!got) {
    throw new BootstrapError('BOOTSTRAP_LOCK_TIMEOUT', 'bootstrap lock unavailable — retry')
  }
  try {
    if ((await deps.countUsers()) > 0) {
      throw new BootstrapError(
        'SETUP_ALREADY_COMPLETE',
        'Setup already complete — ask an admin for an account',
      )
    }
    return await deps.insertAdmin({
      username: input.username,
      password: input.password,
    })
  } finally {
    await deps.releaseLock()
  }
}

/**
 * Production first-admin bootstrap: MySQL GET_LOCK + COUNT + createUser under the lock.
 * Fail closed if users already exist (including races).
 */
export async function createFirstAdminAtomic(input: {
  username: string
  password: string
}): Promise<UserRow> {
  await ensure()
  const conn = await db().getConnection()
  const lockName = BOOTSTRAP_LOCK_NAME
  try {
    return await runAtomicFirstAdminBootstrap(input, {
      acquireLock: async () => {
        const [rows] = await conn.query('SELECT GET_LOCK(?, 10) AS acquired', [lockName])
        const acquired = Number((rows as Array<{ acquired: number | null }>)[0]?.acquired)
        return acquired === 1
      },
      releaseLock: async () => {
        await conn.query('SELECT RELEASE_LOCK(?)', [lockName])
      },
      countUsers: async () => {
        const [rows] = await conn.query('SELECT COUNT(*) AS n FROM users')
        return Number((rows as Array<{ n: number }>)[0]?.n ?? 0)
      },
      insertAdmin: async (i) => {
        // Reuse createUser but it opens its own pool queries — OK under advisory lock
        // (lock is global per name, not transaction-scoped).
        return createUser({ username: i.username, password: i.password, role: 'admin' })
      },
    })
  } finally {
    conn.release()
  }
}

// ---- login throttle (process-local, bounded abuse protection) ----

export type LoginThrottlePolicy = {
  policyId: string
  /** Max failed attempts per key within the window before lockout. */
  maxFailures: number
  /** Sliding window for counting failures. */
  windowMs: number
  /** Lockout duration after maxFailures. */
  lockoutMs: number
}

export const LOGIN_THROTTLE_V1: LoginThrottlePolicy = {
  policyId: 'LOGIN_THROTTLE_V1',
  maxFailures: 10,
  windowMs: 15 * 60 * 1000,
  lockoutMs: 15 * 60 * 1000,
}

export type LoginThrottleDecision =
  | { allowed: true; remaining: number; policyId: string }
  | {
      allowed: false
      remaining: 0
      retryAfterSeconds: number
      policyId: string
      code: 'LOGIN_THROTTLED'
    }

type LoginThrottleState = {
  failures: number
  windowStartMs: number
  lockedUntilMs: number
}

const loginThrottleStore = new Map<string, LoginThrottleState>()

export function normalizeLoginThrottleKey(username: string): string {
  return `login:${username.trim().toLowerCase()}`
}

export function clearLoginThrottleStore(): void {
  loginThrottleStore.clear()
}

/**
 * Check whether a login attempt is allowed for this key (no mutation).
 * Call before authenticate; on failure call recordLoginFailure; on success clearLoginThrottleKey.
 */
export function checkLoginThrottle(
  username: string,
  nowMs = Date.now(),
  policy: LoginThrottlePolicy = LOGIN_THROTTLE_V1,
): LoginThrottleDecision {
  const key = normalizeLoginThrottleKey(username)
  const state = loginThrottleStore.get(key)
  if (!state) {
    return { allowed: true, remaining: policy.maxFailures, policyId: policy.policyId }
  }
  if (state.lockedUntilMs > nowMs) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntilMs - nowMs) / 1000)),
      policyId: policy.policyId,
      code: 'LOGIN_THROTTLED',
    }
  }
  // Window expired → treat as fresh
  if (nowMs - state.windowStartMs >= policy.windowMs) {
    return { allowed: true, remaining: policy.maxFailures, policyId: policy.policyId }
  }
  const remaining = Math.max(0, policy.maxFailures - state.failures)
  if (remaining <= 0) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(policy.lockoutMs / 1000)),
      policyId: policy.policyId,
      code: 'LOGIN_THROTTLED',
    }
  }
  return { allowed: true, remaining, policyId: policy.policyId }
}

/** Record a failed login; may engage lockout. */
export function recordLoginFailure(
  username: string,
  nowMs = Date.now(),
  policy: LoginThrottlePolicy = LOGIN_THROTTLE_V1,
): LoginThrottleDecision {
  const key = normalizeLoginThrottleKey(username)
  let state = loginThrottleStore.get(key)
  if (!state || nowMs - state.windowStartMs >= policy.windowMs) {
    state = { failures: 0, windowStartMs: nowMs, lockedUntilMs: 0 }
  }
  if (state.lockedUntilMs > nowMs) {
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil((state.lockedUntilMs - nowMs) / 1000)),
      policyId: policy.policyId,
      code: 'LOGIN_THROTTLED',
    }
  }
  state.failures += 1
  if (state.failures >= policy.maxFailures) {
    state.lockedUntilMs = nowMs + policy.lockoutMs
    loginThrottleStore.set(key, state)
    return {
      allowed: false,
      remaining: 0,
      retryAfterSeconds: Math.max(1, Math.ceil(policy.lockoutMs / 1000)),
      policyId: policy.policyId,
      code: 'LOGIN_THROTTLED',
    }
  }
  loginThrottleStore.set(key, state)
  return {
    allowed: true,
    remaining: Math.max(0, policy.maxFailures - state.failures),
    policyId: policy.policyId,
  }
}

/** Clear throttle state after successful login. */
export function clearLoginThrottleKey(username: string): void {
  loginThrottleStore.delete(normalizeLoginThrottleKey(username))
}

// ---- users ----
async function boardsOf(userId: string): Promise<Array<string>> {
  const [rows] = await db().query('SELECT board_id FROM user_boards WHERE user_id=?', [userId])
  return (rows as Array<{ board_id: string }>).map((r) => r.board_id)
}

export async function createUser(input: {
  username: string
  password: string
  role: Role
  boards?: Array<string>
}): Promise<UserRow> {
  await ensure()
  const username = input.username.trim()
  if (!username) throw new Error('username required')
  if (!input.password || input.password.length < 6) throw new Error('password must be at least 6 characters')
  const id = randomUUID()
  const hash = await hashPassword(input.password)
  try {
    await db().query('INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)', [id, username, hash, input.role])
  } catch (e) {
    if ((e as { code?: string }).code === 'ER_DUP_ENTRY') throw new Error(`username "${username}" is taken`)
    throw e
  }
  await setUserBoards(id, input.role === 'admin' ? [] : input.boards ?? [])
  return { id, username, role: input.role, boards: input.role === 'admin' ? [] : input.boards ?? [] }
}

export async function listUsers(): Promise<Array<UserRow>> {
  await ensure()
  const [rows] = await db().query('SELECT id, username, role, created_at FROM users ORDER BY created_at ASC')
  const users = rows as Array<{ id: string; username: string; role: Role; created_at: string }>
  return Promise.all(
    users.map(async (u) => ({ id: u.id, username: u.username, role: u.role, boards: await boardsOf(u.id), createdAt: u.created_at })),
  )
}

/** Replace a user's board allowlist (admins ignore it — they see all). */
export async function setUserBoards(userId: string, boards: Array<string>): Promise<void> {
  await ensure()
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    await conn.query('DELETE FROM user_boards WHERE user_id=?', [userId])
    for (const b of [...new Set(boards)].filter(Boolean)) {
      await conn.query('INSERT INTO user_boards (user_id, board_id) VALUES (?,?)', [userId, b])
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}

export async function setUserRole(userId: string, role: Role): Promise<void> {
  await ensure()
  await db().query('UPDATE users SET role=? WHERE id=?', [role, userId])
  if (role === 'admin') await db().query('DELETE FROM user_boards WHERE user_id=?', [userId])
}

export async function resetPassword(userId: string, password: string): Promise<void> {
  await ensure()
  if (!password || password.length < 6) throw new Error('password must be at least 6 characters')
  await db().query('UPDATE users SET password_hash=? WHERE id=?', [await hashPassword(password), userId])
  await db().query('DELETE FROM sessions WHERE user_id=?', [userId]) // force re-login
}

export async function deleteUser(userId: string): Promise<void> {
  await ensure()
  await db().query('DELETE FROM user_boards WHERE user_id=?', [userId])
  await db().query('DELETE FROM sessions WHERE user_id=?', [userId])
  await db().query('DELETE FROM users WHERE id=?', [userId])
}

// ---- sessions ----
export async function authenticate(username: string, password: string): Promise<{ token: string; user: SessionUser } | null> {
  await ensure()
  const [rows] = await db().query('SELECT id, username, password_hash, role FROM users WHERE username=?', [username.trim()])
  const u = (rows as Array<{ id: string; username: string; password_hash: string; role: Role }>)[0]
  if (!u) return null
  if (!(await verifyPassword(password, u.password_hash))) return null
  const token = randomBytes(32).toString('hex')
  await db().query('INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL ? DAY))', [token, u.id, SESSION_DAYS])
  const boards = u.role === 'admin' ? [] : await boardsOf(u.id)
  return { token, user: { id: u.id, username: u.username, role: u.role, boards } }
}

export async function sessionUser(token: string | undefined | null): Promise<SessionUser | null> {
  if (!token) return null
  await ensure()
  const [rows] = await db().query(
    `SELECT u.id, u.username, u.role FROM sessions s JOIN users u ON u.id=s.user_id WHERE s.token=? AND s.expires_at > NOW()`,
    [token],
  )
  const u = (rows as Array<{ id: string; username: string; role: Role }>)[0]
  if (!u) return null
  const boards = u.role === 'admin' ? [] : await boardsOf(u.id)
  return { id: u.id, username: u.username, role: u.role, boards }
}

export async function destroySession(token: string | undefined | null): Promise<void> {
  if (!token) return
  await ensure()
  await db().query('DELETE FROM sessions WHERE token=?', [token])
}

export { SESSION_DAYS }
