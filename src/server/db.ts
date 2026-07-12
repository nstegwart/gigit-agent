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

let pool: mysql.Pool | null = null
export function db(): mysql.Pool {
  if (!pool) {
    pool = mysql.createPool({
      host: env('CAIRN_DB_HOST'),
      port: Number(env('CAIRN_DB_PORT', '3306')),
      user: env('CAIRN_DB_USER'),
      password: env('CAIRN_DB_PASSWORD'),
      database: env('CAIRN_DB_NAME', 'cairn_taskmanager'),
      connectionLimit: 8,
      waitForConnections: true,
      charset: 'utf8mb4',
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
