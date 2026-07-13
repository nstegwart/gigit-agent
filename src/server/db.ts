// MySQL connection pool for Cairn. Server-only. Credentials from env (CAIRN_DB_*),
// with a tiny .env fallback so local `pnpm dev` works without exporting vars.
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

function fromEnvFile(key: string): string | undefined {
  try {
    const txt = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8')
    const line = txt.split('\n').find((l) => l.trim().startsWith(key + '='))
    return line?.slice(line.indexOf('=') + 1).trim().replace(/^["']|["']$/g, '')
  } catch {
    return undefined
  }
}
const env = (key: string, fallback?: string) => process.env[key] ?? fromEnvFile(key) ?? fallback
/** Read a config value from process.env with a .env fallback (server-only). */
export const envVar = (key: string): string | undefined => env(key)

let pool: mysql.Pool | null = null
export function db(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env('CAIRN_DB_HOST'),
      port: Number(env('CAIRN_DB_PORT', '3306')),
      user: env('CAIRN_DB_USER'),
      password: env('CAIRN_DB_PASSWORD'),
      database: env('CAIRN_DB_NAME', 'cairn_taskmanager'),
      connectionLimit: 16,
      waitForConnections: true,
      // Bounded queue: when the DB wedges, requests fail fast instead of piling up
      // until nginx 504s the whole app (outage 2026-07-13 — DB disk full, every
      // commit blocked, all 8 pooled connections held by writes stuck ~30 min).
      queueLimit: 64,
      connectTimeout: 10_000,
      maxIdle: 8,
      idleTimeout: 60_000,
      enableKeepAlive: true,
      keepAliveInitialDelay: 10_000,
      charset: 'utf8mb4',
    })
    pool.on('connection', (conn) => {
      // Server-side ceilings so one pathological statement can't hold a connection forever.
      conn.query('SET SESSION max_execution_time=15000, innodb_lock_wait_timeout=10')
    })
  }
  return pool
}

/** Read a board's JSON doc of a given kind (plan/runs/design/collab/tasks/accounts). */
export async function readDoc<T>(boardId: string, kind: string, fallback: T): Promise<T> {
  const [rows] = await db().query('SELECT data FROM board_docs WHERE board_id=? AND kind=?', [boardId, kind])
  const r = (rows as Array<{ data: unknown }>)[0]
  return r ? (r.data as T) : fallback
}
export async function writeDoc(boardId: string, kind: string, data: unknown): Promise<void> {
  await db().query('REPLACE INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
    boardId,
    kind,
    JSON.stringify(data),
  ])
}
/** Write several docs for a board in ONE transaction — all commit or none. */
export async function writeDocsTx(boardId: string, docs: Record<string, unknown>): Promise<void> {
  const conn = await db().getConnection()
  try {
    await conn.beginTransaction()
    for (const [kind, data] of Object.entries(docs)) {
      await conn.query('REPLACE INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
        boardId,
        kind,
        JSON.stringify(data),
      ])
    }
    await conn.commit()
  } catch (e) {
    await conn.rollback()
    throw e
  } finally {
    conn.release()
  }
}
export async function readGlobal<T>(key: string, fallback: T): Promise<T> {
  const [rows] = await db().query('SELECT data FROM globals WHERE k=?', [key])
  const r = (rows as Array<{ data: unknown }>)[0]
  return r ? (r.data as T) : fallback
}
