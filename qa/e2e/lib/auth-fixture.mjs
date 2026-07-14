/**
 * IBILS / AC-IBILS-01 auth fixture bootstrap (test/harness only).
 *
 * - Disposable isolated MySQL DB cloned from local ambient board data (no users/sessions).
 * - Zero users → product first-admin bootstrap via /login (auth.setup / auth-login).
 * - Process-local synthetic CAIRN_E2E_* credentials + MCP ROOT bearer (never committed).
 * - Cleanup: drop iso DB; erase gitignored storageState; scrub process env secrets.
 *
 * Never mutates ambient users/passwords. Refuses non-local clone hosts by default.
 */
import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

import { redactSecretsDeep, SENSITIVE_ENV_KEYS } from './control-plane-bootstrap.mjs'
import {
  assertSafeIsoDbName,
  dropIsolatedDatabase,
  makeIsolatedDbName,
  readEnvFileKey,
  recreateIsolatedDatabase,
  resolveMysqlConfig,
  withRootConnection,
} from './db-iso.mjs'

const scryptAsync = promisify(crypto.scrypt)

/** Match src/server/auth-store.ts hashPassword format. */
async function hashPasswordProduct(pw) {
  const salt = crypto.randomBytes(16)
  const dk = await scryptAsync(pw, salt, 64)
  return `scrypt$${salt.toString('hex')}$${dk.toString('hex')}`
}

/** Match src/server/auth.ts SESSION_COOKIE + auth-store SESSION_DAYS. */
export const SESSION_COOKIE_NAME = 'cairn_session'
const SESSION_DAYS = 30

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')

export const AUTH_STORAGE_STATE_PATH = path.join(
  REPO_ROOT,
  'qa/e2e/fixtures/storage/admin.json',
)

/**
 * Run-scoped identity for this Playwright process tree.
 * Propagated via CAIRN_E2E_AUTH_RUN_ID so webServer / globalSetup / workers / teardown
 * share one meta+secrets pair and cannot clobber a concurrent invocation.
 */
export function resolveAuthRunId(opts = {}) {
  const forced = opts.runId?.trim() || process.env.CAIRN_E2E_AUTH_RUN_ID?.trim()
  if (forced) {
    process.env.CAIRN_E2E_AUTH_RUN_ID = forced
    return forced
  }
  const id = `authfix_${Date.now().toString(36)}_${crypto.randomBytes(4).toString('hex')}`
  process.env.CAIRN_E2E_AUTH_RUN_ID = id
  return id
}

/**
 * Runtime meta only (no secrets). Run-scoped under .artifact/ (gitignored).
 * Override with CAIRN_E2E_AUTH_RUNTIME_META_PATH when an outer orchestrator owns the path.
 */
export function resolveAuthRuntimeMetaPath(opts = {}) {
  const override =
    opts.metaPath?.trim() || process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH?.trim()
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.resolve(REPO_ROOT, override)
    process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH = abs
    return abs
  }
  const runId = resolveAuthRunId(opts)
  const abs = path.join(REPO_ROOT, `.artifact/e2e-auth-runtime-${runId}.json`)
  process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH = abs
  return abs
}

/**
 * Process-local secrets sidecar (mode 600, run-scoped under .artifact/, never commit).
 * Bridges Playwright main/worker/webServer processes that do not share memory.
 * Override with CAIRN_E2E_AUTH_SECRETS_PATH.
 */
export function resolveAuthSecretsSidecarPath(opts = {}) {
  const override =
    opts.secretsPath?.trim() || process.env.CAIRN_E2E_AUTH_SECRETS_PATH?.trim()
  if (override) {
    const abs = path.isAbsolute(override) ? override : path.resolve(REPO_ROOT, override)
    process.env.CAIRN_E2E_AUTH_SECRETS_PATH = abs
    return abs
  }
  const runId = resolveAuthRunId(opts)
  const abs = path.join(REPO_ROOT, `.artifact/e2e-auth-secrets-${runId}.json`)
  process.env.CAIRN_E2E_AUTH_SECRETS_PATH = abs
  return abs
}

/**
 * Live path accessors (not frozen strings — parallel runs use distinct files).
 * Prefer resolveAuthRuntimeMetaPath / resolveAuthSecretsSidecarPath by name.
 */
export { resolveAuthRuntimeMetaPath as AUTH_RUNTIME_META_PATH }
export { resolveAuthSecretsSidecarPath as AUTH_SECRETS_SIDECAR_PATH }

/** Tables that must stay empty (product bootstrap creates first admin). */
export const AUTH_FIXTURE_SKIP_DATA_TABLES = Object.freeze([
  'users',
  'sessions',
  'user_boards',
])

/** Iso DB name prefix this fixture owns (teardown refuses other prefixes). */
export const AUTH_FIXTURE_OWNED_DB_PREFIX = 'cairn_tm_e2e_authfix'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])

/**
 * Process-local synthetic credentials (or reuse env if already set).
 * Never logs password.
 */
export function generateE2ECredentials(opts = {}) {
  const username =
    (opts.username ?? process.env.CAIRN_E2E_USERNAME)?.trim() ||
    `e2e_admin_${crypto.randomBytes(3).toString('hex')}`
  const password =
    opts.password ??
    process.env.CAIRN_E2E_PASSWORD ??
    `E2e!${crypto.randomBytes(12).toString('base64url')}`
  if (!username || !password) {
    throw new Error('FAIL-CLOSED auth-fixture: empty credentials after generation')
  }
  return { username, password }
}

/**
 * Process-local MCP ROOT principal for Playwright extraHTTPHeaders + child preview env.
 *
 * Default: **unbound** ROOT_ORCHESTRATOR (no boardId) so multi-board IBILS + mfs-rebuild
 * tools/call succeed. Bound ROOT (boardId set) would 403 cross-board — see rbac canAccessBoard.
 * Pass opts.boardId only when intentionally board-scoping the fixture.
 */
export function generateMcpAuthFixture(opts = {}) {
  const existingBearer = process.env.CAIRN_MCP_BEARER?.trim()
  const existingJson = process.env.CAIRN_BEARER_PRINCIPALS_JSON?.trim()
  if (existingBearer && existingJson && !opts.forceNew) {
    return {
      bearer: existingBearer,
      principalsJson: existingJson,
      childEnv: { CAIRN_BEARER_PRINCIPALS_JSON: existingJson },
      principalMeta: {
        role: 'ROOT_ORCHESTRATOR',
        reused: true,
        boardId: null,
        unbound: true,
        hasSecret: true,
      },
      boardId: null,
    }
  }

  // Unbound ROOT: do not use createSyntheticRootPrincipal default boardId binding.
  const secret = crypto.randomBytes(32).toString('base64url')
  const actorId = opts.actorId ?? `e2e-root-${crypto.randomBytes(4).toString('hex')}`
  const tokenId = opts.tokenId ?? `e2e-token-${crypto.randomBytes(4).toString('hex')}`
  const record = {
    tokenId,
    secret,
    role: 'ROOT_ORCHESTRATOR',
    actorId,
    label: 'synthetic-e2e-root-unbound',
  }
  // Optional explicit board bind only when caller requests it.
  if (opts.boardId != null && String(opts.boardId).trim()) {
    record.boardId = String(opts.boardId).trim()
  }
  const principalsJson = JSON.stringify([record])
  return {
    bearer: secret,
    principalsJson,
    childEnv: { CAIRN_BEARER_PRINCIPALS_JSON: principalsJson },
    principalMeta: {
      role: 'ROOT_ORCHESTRATOR',
      actorId,
      tokenId,
      boardId: record.boardId ?? null,
      unbound: !record.boardId,
      hasSecret: true,
      secretByteLength: 32,
      secretEncoding: 'base64url',
    },
    boardId: record.boardId ?? null,
  }
}

/** Headers for Playwright request / extraHTTPHeaders (Bearer only). */
export function mcpAuthHeaders(bearer = process.env.CAIRN_MCP_BEARER) {
  const token = typeof bearer === 'string' ? bearer.trim() : ''
  if (!token) {
    throw new Error(
      'FAIL-CLOSED mcp-auth: CAIRN_MCP_BEARER unset — run ensureAuthSecretsInEnv / globalSetup first',
    )
  }
  return {
    Authorization: `Bearer ${token}`,
  }
}

/**
 * Load secrets sidecar into process.env when present (worker/config bridge).
 * Returns true if sidecar was applied.
 */
export function loadSecretsSidecar() {
  const sidecarPath = resolveAuthSecretsSidecarPath()
  if (!fs.existsSync(sidecarPath)) return false
  try {
    const raw = JSON.parse(fs.readFileSync(sidecarPath, 'utf8'))
    if (raw.CAIRN_E2E_AUTH_RUN_ID) {
      process.env.CAIRN_E2E_AUTH_RUN_ID = raw.CAIRN_E2E_AUTH_RUN_ID
    }
    if (raw.CAIRN_E2E_AUTH_RUNTIME_META_PATH) {
      process.env.CAIRN_E2E_AUTH_RUNTIME_META_PATH = raw.CAIRN_E2E_AUTH_RUNTIME_META_PATH
    }
    if (raw.CAIRN_E2E_AUTH_SECRETS_PATH) {
      process.env.CAIRN_E2E_AUTH_SECRETS_PATH = raw.CAIRN_E2E_AUTH_SECRETS_PATH
    }
    if (raw.CAIRN_E2E_USERNAME) process.env.CAIRN_E2E_USERNAME = raw.CAIRN_E2E_USERNAME
    if (raw.CAIRN_E2E_PASSWORD) process.env.CAIRN_E2E_PASSWORD = raw.CAIRN_E2E_PASSWORD
    if (raw.CAIRN_MCP_BEARER) process.env.CAIRN_MCP_BEARER = raw.CAIRN_MCP_BEARER
    if (raw.CAIRN_BEARER_PRINCIPALS_JSON) {
      process.env.CAIRN_BEARER_PRINCIPALS_JSON = raw.CAIRN_BEARER_PRINCIPALS_JSON
    }
    if (raw.CAIRN_DB_NAME) process.env.CAIRN_DB_NAME = raw.CAIRN_DB_NAME
    if (raw.CAIRN_ISO_DB_NAME) process.env.CAIRN_ISO_DB_NAME = raw.CAIRN_ISO_DB_NAME
    return true
  } catch (e) {
    throw new Error(`FAIL-CLOSED auth-fixture: secrets sidecar unreadable: ${String(e)}`)
  }
}

/** Persist current process secrets for sibling Playwright processes. Mode 600. */
export function writeSecretsSidecar() {
  const runId = resolveAuthRunId()
  const sidecarPath = resolveAuthSecretsSidecarPath()
  const metaPath = resolveAuthRuntimeMetaPath()
  fs.mkdirSync(path.dirname(sidecarPath), { recursive: true })
  const payload = {
    CAIRN_E2E_AUTH_RUN_ID: runId,
    CAIRN_E2E_AUTH_RUNTIME_META_PATH: metaPath,
    CAIRN_E2E_AUTH_SECRETS_PATH: sidecarPath,
    CAIRN_E2E_USERNAME: process.env.CAIRN_E2E_USERNAME ?? '',
    CAIRN_E2E_PASSWORD: process.env.CAIRN_E2E_PASSWORD ?? '',
    CAIRN_MCP_BEARER: process.env.CAIRN_MCP_BEARER ?? '',
    CAIRN_BEARER_PRINCIPALS_JSON: process.env.CAIRN_BEARER_PRINCIPALS_JSON ?? '',
    CAIRN_DB_NAME: process.env.CAIRN_DB_NAME ?? '',
    CAIRN_ISO_DB_NAME: process.env.CAIRN_ISO_DB_NAME ?? '',
    writtenAt: new Date().toISOString(),
  }
  fs.writeFileSync(sidecarPath, `${JSON.stringify(payload)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(sidecarPath, 0o600)
  } catch {
    /* best-effort */
  }
  return sidecarPath
}

export function eraseSecretsSidecar() {
  const sidecarPath = resolveAuthSecretsSidecarPath()
  if (fs.existsSync(sidecarPath)) {
    try {
      fs.unlinkSync(sidecarPath)
      return true
    } catch {
      return false
    }
  }
  return false
}

/**
 * Sync: ensure process.env has synthetic credentials + MCP bearer/principals.
 * Prefer existing sidecar (shared across Playwright processes) before generating.
 * Safe to call from playwright.config.ts load time.
 * Does NOT seed DB — call prepareIsolatedAuthFixture / start-auth-preview for that.
 */
export function ensureAuthSecretsInEnv(opts = {}) {
  // Pin run id + paths first so all sibling processes share one pair.
  const runId = resolveAuthRunId(opts)
  resolveAuthRuntimeMetaPath(opts)
  resolveAuthSecretsSidecarPath(opts)

  // Prefer sidecar so workers match webServer secrets (do not re-roll).
  if (!opts.forceNew) {
    loadSecretsSidecar()
  }

  const creds = generateE2ECredentials(opts)
  process.env.CAIRN_E2E_USERNAME = creds.username
  process.env.CAIRN_E2E_PASSWORD = creds.password

  const mcp = generateMcpAuthFixture(opts)
  process.env.CAIRN_MCP_BEARER = mcp.bearer
  process.env.CAIRN_BEARER_PRINCIPALS_JSON = mcp.principalsJson

  // Keep sidecar in sync when we (re)generate
  writeSecretsSidecar()

  return {
    username: creds.username,
    hasPassword: true,
    mcpPrincipalMeta: mcp.principalMeta,
    boardId: mcp.boardId,
    runId,
    runtimeMetaPath: resolveAuthRuntimeMetaPath(),
    secretsSidecarPath: resolveAuthSecretsSidecarPath(),
  }
}

function assertLocalCloneSource(host) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
  if (LOCAL_HOSTS.has(h)) return
  if (process.env.CAIRN_E2E_ALLOW_REMOTE_CLONE === '1') return
  throw new Error(
    `FAIL-CLOSED auth-fixture: refusing non-local CAIRN_DB_HOST "${host}" for board clone (set CAIRN_E2E_ALLOW_REMOTE_CLONE=1 only with owner approval)`,
  )
}

/**
 * Clone ambient local board data into a disposable iso DB with zero users.
 * Source DB name from env/.env CAIRN_DB_NAME (typically cairn_taskmanager).
 */
export async function cloneAmbientBoardsToIsolatedDb(opts = {}) {
  const cfg = resolveMysqlConfig()
  assertLocalCloneSource(cfg.host)

  const sourceDb =
    opts.sourceDbName?.trim() ||
    process.env.CAIRN_E2E_CLONE_SOURCE_DB?.trim() ||
    readEnvFileKey('CAIRN_DB_NAME', 'cairn_taskmanager')
  if (!sourceDb) {
    throw new Error('FAIL-CLOSED auth-fixture: source CAIRN_DB_NAME empty')
  }

  const isoDb =
    opts.isoDbName?.trim() ||
    process.env.CAIRN_ISO_DB_NAME?.trim() ||
    makeIsolatedDbName(opts.slug ?? 'authfix')
  assertSafeIsoDbName(isoDb)
  if (isoDb === sourceDb) {
    throw new Error(
      `FAIL-CLOSED auth-fixture: iso target must differ from source DB (${sourceDb})`,
    )
  }

  await recreateIsolatedDatabase(isoDb)

  const skip = new Set(
    (opts.skipDataTables ?? AUTH_FIXTURE_SKIP_DATA_TABLES).map((t) => String(t).toLowerCase()),
  )
  const tableStats = {}

  await withRootConnection(async (root) => {
    const [exists] = await root.query(
      'SELECT SCHEMA_NAME AS n FROM information_schema.SCHEMATA WHERE SCHEMA_NAME=?',
      [sourceDb],
    )
    if (!Array.isArray(exists) || exists.length === 0) {
      throw new Error(`FAIL-CLOSED auth-fixture: source database "${sourceDb}" does not exist`)
    }

    const [tableRows] = await root.query(
      `SELECT TABLE_NAME AS name FROM information_schema.TABLES
       WHERE TABLE_SCHEMA=? AND TABLE_TYPE='BASE TABLE'
       ORDER BY TABLE_NAME`,
      [sourceDb],
    )
    const tables = (Array.isArray(tableRows) ? tableRows : []).map((r) => r.name)
    if (tables.length === 0) {
      throw new Error(`FAIL-CLOSED auth-fixture: source "${sourceDb}" has no base tables`)
    }

    for (const table of tables) {
      if (!/^[A-Za-z0-9_]+$/.test(table)) {
        throw new Error(`FAIL-CLOSED auth-fixture: refusing unsafe table name "${table}"`)
      }
      await root.query(
        `CREATE TABLE \`${isoDb}\`.\`${table}\` LIKE \`${sourceDb}\`.\`${table}\``,
      )
      if (skip.has(table.toLowerCase())) {
        tableStats[table] = { clonedRows: 0, skippedData: true }
        continue
      }
      const [result] = await root.query(
        `INSERT INTO \`${isoDb}\`.\`${table}\` SELECT * FROM \`${sourceDb}\`.\`${table}\``,
      )
      const affected = Number(result?.affectedRows ?? 0)
      tableStats[table] = { clonedRows: affected, skippedData: false }
    }
  })

  let userCount = 0
  await withRootConnection(async (root) => {
    try {
      const [rows] = await root.query(`SELECT COUNT(*) AS n FROM \`${isoDb}\`.users`)
      userCount = Number(rows?.[0]?.n ?? 0)
    } catch {
      userCount = -1
    }
  })
  if (userCount !== 0) {
    throw new Error(
      `FAIL-CLOSED auth-fixture: expected 0 users in iso DB after clone, got ${userCount}`,
    )
  }

  return {
    ok: true,
    isoDb,
    sourceDb,
    host: cfg.host,
    port: cfg.port,
    tableStats,
    userCount,
    note: 'Board/task data cloned; users/sessions/user_boards empty for product bootstrap',
  }
}

function writeRuntimeMeta(meta) {
  const metaPath = resolveAuthRuntimeMetaPath()
  fs.mkdirSync(path.dirname(metaPath), { recursive: true })
  const safe = redactSecretsDeep(meta, [
    process.env.CAIRN_MCP_BEARER,
    process.env.CAIRN_E2E_PASSWORD,
    process.env.CAIRN_BEARER_PRINCIPALS_JSON,
  ].filter(Boolean))
  fs.writeFileSync(metaPath, `${JSON.stringify(safe, null, 2)}\n`, {
    mode: 0o600,
  })
  return metaPath
}

export function readRuntimeMeta() {
  const metaPath = resolveAuthRuntimeMetaPath()
  if (!fs.existsSync(metaPath)) return null
  try {
    return JSON.parse(fs.readFileSync(metaPath, 'utf8'))
  } catch {
    return null
  }
}

/**
 * Whether cleanup may DROP this iso DB.
 * Requires isolated-clone mode, safe name, matching runId (when present), and owned prefix.
 */
export function isOwnedIsoDbForCleanup(meta, runId = resolveAuthRunId()) {
  if (!meta || meta.mode !== 'isolated-clone') return false
  if (!meta.isoDb || typeof meta.isoDb !== 'string') return false
  if (meta.cleanup?.dbDropped === true) return false
  if (meta.runId && runId && meta.runId !== runId) return false
  try {
    assertSafeIsoDbName(meta.isoDb)
  } catch {
    return false
  }
  const iso = meta.isoDb.toLowerCase()
  const prefix = (meta.ownedDbPrefix || AUTH_FIXTURE_OWNED_DB_PREFIX).toLowerCase()
  if (!iso.startsWith(prefix) && !iso.startsWith('cairn_tm_e2e_authfix')) {
    return false
  }
  return true
}

/**
 * Full prepare for Playwright globalSetup:
 * secrets in env + iso DB clone + CAIRN_DB_NAME pointing at iso.
 *
 * Skip iso with CAIRN_E2E_SKIP_ISO_AUTH=1 (requires pre-set CAIRN_E2E_* against an
 * already-bootstrapped local server — not the default green path).
 */
export async function prepareIsolatedAuthFixture(opts = {}) {
  const secrets = ensureAuthSecretsInEnv(opts)
  const runId = secrets.runId || resolveAuthRunId(opts)
  const metaPath = resolveAuthRuntimeMetaPath(opts)
  const skipIso =
    process.env.CAIRN_E2E_SKIP_ISO_AUTH === '1' ||
    process.env.CAIRN_E2E_SKIP_ISO_AUTH === 'true' ||
    opts.skipIso === true

  // Idempotent: if THIS run's meta already has a live iso (e.g. start-auth-preview), reuse.
  // Never read a shared fixed path — other workers' DBs stay untouched.
  if (!opts.forceNew && !skipIso) {
    const existing = readRuntimeMeta()
    if (
      existing?.mode === 'isolated-clone' &&
      existing?.isoDb &&
      existing?.cleanup?.dbDropped !== true &&
      (!existing.runId || existing.runId === runId)
    ) {
      process.env.CAIRN_DB_NAME = existing.isoDb
      process.env.CAIRN_ISO_DB_NAME = existing.isoDb
      loadSecretsSidecar()
      writeSecretsSidecar()
      return {
        ok: true,
        ...existing,
        secretsApplied: true,
        reused: true,
        runId,
        runtimeMetaPath: metaPath,
      }
    }
  }

  if (skipIso) {
    const meta = {
      mode: 'skip-iso',
      runId,
      runtimeMetaPath: metaPath,
      preparedAt: new Date().toISOString(),
      username: secrets.username,
      mcpPrincipalMeta: secrets.mcpPrincipalMeta,
      boardId: secrets.boardId,
      dbName: process.env.CAIRN_DB_NAME || readEnvFileKey('CAIRN_DB_NAME', null),
      note: 'CAIRN_E2E_SKIP_ISO_AUTH=1 — using ambient/external DB; bootstrap only works if user exists',
    }
    writeRuntimeMeta(meta)
    writeSecretsSidecar()
    return { ok: true, ...meta, secretsApplied: true }
  }

  const clone = await cloneAmbientBoardsToIsolatedDb({
    slug: opts.slug ?? 'authfix',
    isoDbName: opts.isoDbName,
    sourceDbName: opts.sourceDbName,
  })

  process.env.CAIRN_DB_NAME = clone.isoDb
  process.env.CAIRN_ISO_DB_NAME = clone.isoDb
  writeSecretsSidecar()

  const meta = {
    mode: 'isolated-clone',
    runId,
    ownedDbPrefix: AUTH_FIXTURE_OWNED_DB_PREFIX,
    runtimeMetaPath: metaPath,
    secretsSidecarPath: resolveAuthSecretsSidecarPath(),
    preparedAt: new Date().toISOString(),
    username: secrets.username,
    mcpPrincipalMeta: secrets.mcpPrincipalMeta,
    boardId: secrets.boardId,
    isoDb: clone.isoDb,
    sourceDb: clone.sourceDb,
    host: clone.host,
    port: clone.port,
    tableStats: clone.tableStats,
    userCount: clone.userCount,
    storageStatePath: AUTH_STORAGE_STATE_PATH,
    note: clone.note,
  }
  writeRuntimeMeta(meta)
  return { ok: true, ...meta, secretsApplied: true, clone }
}

/**
 * Drop iso DB (if isolated mode), erase storageState, scrub secret env keys.
 * Safe to call when nothing was prepared.
 */
export async function cleanupIsolatedAuthFixture(opts = {}) {
  const runId = resolveAuthRunId(opts)
  const metaPath = resolveAuthRuntimeMetaPath(opts)
  const meta = readRuntimeMeta() || {}
  const keepDb =
    opts.keepDb === true ||
    process.env.CAIRN_E2E_KEEP_ISO_DB === '1' ||
    process.env.CAIRN_E2E_KEEP_ISO_DB === 'true'
  const keepStorage =
    opts.keepStorage === true ||
    process.env.CAIRN_E2E_KEEP_STORAGE === '1'

  const result = {
    cleanedAt: new Date().toISOString(),
    dbDropped: false,
    dbDropSkipped: null,
    storageErased: false,
    envScrubbed: [],
    mode: meta.mode ?? null,
    isoDb: meta.isoDb ?? process.env.CAIRN_ISO_DB_NAME ?? null,
    runId,
    runtimeMetaPath: metaPath,
  }

  // Only DROP the iso DB owned by THIS run's meta — never a peer worker's DB.
  if (!keepDb && meta.mode === 'isolated-clone' && meta.isoDb) {
    if (!isOwnedIsoDbForCleanup(meta, runId)) {
      result.dbDropSkipped =
        meta.runId && meta.runId !== runId
          ? `runId-mismatch meta=${meta.runId} self=${runId}`
          : `not-owned-prefix isoDb=${meta.isoDb}`
    } else {
      try {
        assertSafeIsoDbName(meta.isoDb)
        await dropIsolatedDatabase(meta.isoDb)
        result.dbDropped = true
      } catch (e) {
        result.dbDropError = String(e?.message || e)
      }
    }
  }

  if (!keepStorage && fs.existsSync(AUTH_STORAGE_STATE_PATH)) {
    try {
      fs.unlinkSync(AUTH_STORAGE_STATE_PATH)
      result.storageErased = true
    } catch (e) {
      result.storageEraseError = String(e?.message || e)
    }
  }

  // Scrub process-local secrets (names only in result)
  const scrubKeys = [
    'CAIRN_E2E_PASSWORD',
    'CAIRN_MCP_BEARER',
    'CAIRN_BEARER_PRINCIPALS_JSON',
    ...SENSITIVE_ENV_KEYS,
  ]
  for (const k of new Set(scrubKeys)) {
    if (process.env[k] != null) {
      delete process.env[k]
      result.envScrubbed.push(k)
    }
  }

  result.secretsSidecarErased = eraseSecretsSidecar()

  // Update meta with cleanup receipt (still no secrets)
  writeRuntimeMeta({ ...meta, cleanup: result })
  return result
}

/**
 * Product-schema first-admin + session seed (iso DB only).
 * Used when browser login UI cannot hydrate (APP client JS residual).
 * Mirrors createFirstAdminAtomic + authenticate session insert — no ambient user mutation.
 *
 * @returns {{ userId: string, username: string, token: string, storageStatePath: string }}
 */
export async function seedProductAdminSessionAndStorageState(opts = {}) {
  loadSecretsSidecar()
  const creds = generateE2ECredentials(opts)
  const dbName =
    opts.dbName?.trim() ||
    process.env.CAIRN_DB_NAME?.trim() ||
    process.env.CAIRN_ISO_DB_NAME?.trim() ||
    readRuntimeMeta()?.isoDb
  if (!dbName) {
    throw new Error('FAIL-CLOSED auth-fixture: no iso CAIRN_DB_NAME for session seed')
  }
  assertSafeIsoDbName(dbName)

  const cfg = resolveMysqlConfig()
  assertLocalCloneSource(cfg.host)

  const userId = crypto.randomUUID()
  const token = crypto.randomBytes(32).toString('hex') // 64 hex chars — matches sessions.token CHAR(64)
  const passwordHash = await hashPasswordProduct(creds.password)
  const outPath = opts.outPath || AUTH_STORAGE_STATE_PATH
  const baseUrl = (opts.baseUrl || process.env.WEB_BASE || 'http://127.0.0.1:3210').replace(
    /\/$/,
    '',
  )
  const origin = new URL(baseUrl)

  const conn = await mysql.createConnection({
    ...cfg,
    database: dbName,
    multipleStatements: true,
  })
  try {
    // Ensure auth tables exist (product ensure() does this; clone may already have them)
    await conn.query(`CREATE TABLE IF NOT EXISTS users (
      id CHAR(36) PRIMARY KEY,
      username VARCHAR(64) NOT NULL UNIQUE,
      password_hash VARCHAR(255) NOT NULL,
      role VARCHAR(16) NOT NULL DEFAULT 'member',
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) CHARACTER SET utf8mb4`)
    await conn.query(`CREATE TABLE IF NOT EXISTS sessions (
      token CHAR(64) PRIMARY KEY,
      user_id CHAR(36) NOT NULL,
      created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL,
      INDEX idx_sess_user (user_id)
    ) CHARACTER SET utf8mb4`)
    await conn.query(`CREATE TABLE IF NOT EXISTS user_boards (
      user_id CHAR(36) NOT NULL,
      board_id VARCHAR(64) NOT NULL,
      PRIMARY KEY (user_id, board_id)
    ) CHARACTER SET utf8mb4`)

    const [uc] = await conn.query('SELECT COUNT(*) AS n FROM users')
    const userCount = Number(uc?.[0]?.n ?? 0)
    if (userCount > 0) {
      // Reuse: delete fixture sessions only; fail if non-fixture users exist without force
      if (opts.force !== true) {
        throw new Error(
          `FAIL-CLOSED auth-fixture: iso DB already has ${userCount} users — refuse session seed without force`,
        )
      }
      await conn.query('DELETE FROM sessions')
      await conn.query('DELETE FROM user_boards')
      await conn.query('DELETE FROM users')
    }

    await conn.query(
      'INSERT INTO users (id, username, password_hash, role) VALUES (?,?,?,?)',
      [userId, creds.username, passwordHash, 'admin'],
    )
    await conn.query(
      'INSERT INTO sessions (token, user_id, expires_at) VALUES (?,?,DATE_ADD(NOW(), INTERVAL ? DAY))',
      [token, userId, SESSION_DAYS],
    )
  } finally {
    await conn.end()
  }

  // Playwright storageState shape
  const storageState = {
    cookies: [
      {
        name: SESSION_COOKIE_NAME,
        value: token,
        domain: origin.hostname,
        path: '/',
        expires: Math.floor(Date.now() / 1000) + SESSION_DAYS * 24 * 60 * 60,
        httpOnly: true,
        secure: origin.protocol === 'https:',
        sameSite: 'Lax',
      },
    ],
    origins: [],
  }
  fs.mkdirSync(path.dirname(outPath), { recursive: true })
  fs.writeFileSync(outPath, `${JSON.stringify(storageState, null, 2)}\n`, { mode: 0o600 })
  try {
    fs.chmodSync(outPath, 0o600)
  } catch {
    /* best-effort */
  }

  process.env.CAIRN_E2E_USERNAME = creds.username
  process.env.CAIRN_E2E_PASSWORD = creds.password
  writeSecretsSidecar()

  return {
    userId,
    username: creds.username,
    tokenPresent: true,
    storageStatePath: outPath,
    dbName,
    baseUrl,
    method: 'product-schema-session-seed',
  }
}

export { SENSITIVE_ENV_KEYS, redactSecretsDeep }
