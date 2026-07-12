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
