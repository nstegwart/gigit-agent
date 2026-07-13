/**
 * Isolated MySQL helpers for the deterministic control-center browser harness.
 * Never touches ambient cairn_taskmanager / production DBs by default name.
 */
import fs from 'node:fs'
import path from 'node:path'
import mysql from 'mysql2/promise'

const AMBIENT_FORBIDDEN = new Set([
  'cairn_taskmanager',
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
])

export function readEnvFileKey(key, fallback = undefined) {
  if (process.env[key]) return process.env[key]
  try {
    const t = fs.readFileSync(path.resolve(process.cwd(), '.env'), 'utf8')
    const line = t.split('\n').find((l) => l.trim().startsWith(`${key}=`))
    if (!line) return fallback
    return line
      .slice(line.indexOf('=') + 1)
      .trim()
      .replace(/^["']|["']$/g, '')
  } catch {
    return fallback
  }
}

export function resolveMysqlConfig() {
  return {
    host: readEnvFileKey('CAIRN_DB_HOST', '127.0.0.1'),
    port: Number(readEnvFileKey('CAIRN_DB_PORT', '3306')),
    user: readEnvFileKey('CAIRN_DB_USER', 'root'),
    password: readEnvFileKey('CAIRN_DB_PASSWORD', ''),
  }
}

/**
 * Unique disposable DB name. Pattern: cairn_tm_e2e_<slug>_<stamp>
 * Rejects ambient / system database names.
 */
export function makeIsolatedDbName(slug = 'r2d') {
  const envName = process.env.CAIRN_ISO_DB_NAME?.trim()
  if (envName) {
    assertSafeIsoDbName(envName)
    return envName
  }
  const stamp = new Date()
    .toISOString()
    .replace(/[-:TZ.]/g, '')
    .slice(0, 14)
  const pid = process.pid
  const name = `cairn_tm_e2e_${slug}_${stamp}_${pid}`.toLowerCase().replace(/[^a-z0-9_]/g, '_')
  assertSafeIsoDbName(name)
  return name
}

export function assertSafeIsoDbName(name) {
  if (!name || typeof name !== 'string') {
    throw new Error('FAIL-CLOSED iso-db: empty database name')
  }
  if (AMBIENT_FORBIDDEN.has(name.toLowerCase())) {
    throw new Error(`FAIL-CLOSED iso-db: refusing ambient/system database name "${name}"`)
  }
  if (!/^cairn_tm_(e2e|c3|iso|synth)_/i.test(name) && !process.env.CAIRN_ISO_DB_ALLOW_ANY) {
    throw new Error(
      `FAIL-CLOSED iso-db: name must start with cairn_tm_e2e_|c3_|iso_|synth_ (got "${name}")`,
    )
  }
  if (name.length > 64) {
    throw new Error(`FAIL-CLOSED iso-db: name too long (${name.length} > 64)`)
  }
}

export async function withRootConnection(fn) {
  const cfg = resolveMysqlConfig()
  const conn = await mysql.createConnection({ ...cfg, multipleStatements: true })
  try {
    return await fn(conn)
  } finally {
    await conn.end()
  }
}

export async function withDbConnection(database, fn) {
  const cfg = resolveMysqlConfig()
  assertSafeIsoDbName(database)
  const conn = await mysql.createConnection({ ...cfg, database, multipleStatements: true })
  try {
    return await fn(conn)
  } finally {
    await conn.end()
  }
}

/** DROP + CREATE empty utf8mb4 database. */
export async function recreateIsolatedDatabase(dbName) {
  assertSafeIsoDbName(dbName)
  await withRootConnection(async (root) => {
    await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
    await root.query(
      `CREATE DATABASE \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  })
  return dbName
}

/** DROP only the named isolated DB. Returns whether still present after drop. */
export async function dropIsolatedDatabase(dbName) {
  assertSafeIsoDbName(dbName)
  await withRootConnection(async (root) => {
    await root.query(`DROP DATABASE IF EXISTS \`${dbName}\``)
  })
  const still = await databaseExists(dbName)
  return { dropped: !still, stillPresent: still }
}

export async function databaseExists(dbName) {
  return withRootConnection(async (root) => {
    const [rows] = await root.query(
      'SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
      [dbName],
    )
    return (rows ?? []).length > 0
  })
}
