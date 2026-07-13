/**
 * Real MySQL MigrationSqlExecutor for staging/local apply (TM-P0).
 * Uses mysql2; reads/writes schema_migrations with checksum history.
 * Host authority: assertHostAllowed + classifyDbHost (LOCAL|STAGING apply only via runner).
 * No down migration. No production connection without CAIRN_ALLOW_REMOTE_DB=1.
 */
import type { Connection, Pool, PoolOptions, RowDataPacket } from 'mysql2/promise'
import mysql from 'mysql2/promise'

import {
  assertHostAllowed,
  classifyDbHost,
  envVar,
  migrationApplyAllowed,
  type DbHostClass,
} from './db'
import type { MigrationHistoryRow, MigrationSqlExecutor } from './migrations'

/** ER_NO_SUCH_TABLE — schema_migrations not yet created (pre-001). */
const ER_NO_SUCH_TABLE = 1146

export interface MysqlMigrationExecutorOptions {
  host?: string
  port?: number
  user?: string
  password?: string
  database?: string
  /** Actor label stored in schema_migrations.applied_by */
  appliedBy?: string
  /**
   * When true, query/recordApplied throw — use for dry-run/status read paths
   * that still need listApplied from live history.
   */
  readOnly?: boolean
  /**
   * Injected pool/connection (unit tests). Caller owns lifecycle unless
   * `ownsConnection` is true.
   */
  connection?: Pool | Connection
  /** When true, close() ends the injected connection/pool. */
  ownsConnection?: boolean
  /** Override host classification (tests). */
  hostClass?: DbHostClass
  /** Staging host allowlist override for classifyDbHost. */
  stagingHosts?: ReadonlyArray<string>
}

export interface MysqlMigrationExecutor extends MigrationSqlExecutor {
  readonly host: string
  readonly hostClass: DbHostClass
  readonly applyAllowed: boolean
  readonly database: string
  readonly readOnly: boolean
  /** End owned pool/connection. Safe to call multiple times. */
  close(): Promise<void>
  /** Connectivity probe (SELECT 1). Does not invent schema state. */
  ping(): Promise<void>
}

type Queryable = {
  query: (sql: string, params?: Array<unknown>) => Promise<[unknown, unknown]>
}

function env(key: string, fallback?: string): string | undefined {
  return envVar(key) ?? fallback
}

function isNoSuchTable(err: unknown): boolean {
  const e = err as { errno?: number; code?: string }
  return e.errno === ER_NO_SUCH_TABLE || e.code === 'ER_NO_SUCH_TABLE'
}

function mapHistoryRow(r: {
  version: string
  filename: string
  sha256: string
  classification: string
  applied_at?: Date | string | null
  dry_run?: number | boolean | null
}): MigrationHistoryRow {
  const appliedAt =
    r.applied_at instanceof Date
      ? r.applied_at.toISOString()
      : r.applied_at
        ? String(r.applied_at)
        : undefined
  const dryRun =
    r.dry_run === true || r.dry_run === 1
      ? true
      : r.dry_run === 0 || r.dry_run === false
        ? false
        : undefined
  return {
    version: String(r.version),
    filename: String(r.filename ?? ''),
    sha256: String(r.sha256 ?? ''),
    classification: String(r.classification ?? ''),
    appliedAt,
    dryRun,
  }
}

/**
 * Build pool options from env (CAIRN_DB_*) with optional overrides.
 * Does not open a connection.
 */
export function resolveMysqlMigrationConfig(opts: MysqlMigrationExecutorOptions = {}): {
  host: string
  port: number
  user: string
  password: string
  database: string
  hostClass: DbHostClass
  applyAllowed: boolean
  appliedBy: string
} {
  const host = (opts.host ?? env('CAIRN_DB_HOST', '127.0.0.1') ?? '127.0.0.1').trim()
  const port = opts.port ?? Number(env('CAIRN_DB_PORT', '3306') ?? 3306)
  const user = opts.user ?? env('CAIRN_DB_USER', 'root') ?? 'root'
  const password = opts.password ?? env('CAIRN_DB_PASSWORD', '') ?? ''
  const database = opts.database ?? env('CAIRN_DB_NAME', 'cairn_taskmanager') ?? 'cairn_taskmanager'
  // Fail-closed remote laptop guard (same as db.ts pool).
  assertHostAllowed(host)
  const hostClass = opts.hostClass ?? classifyDbHost(host, { stagingHosts: opts.stagingHosts })
  const applyAllowed = migrationApplyAllowed(hostClass)
  const appliedBy = opts.appliedBy ?? env('CAIRN_MIGRATION_APPLIED_BY', 'migrate-cli') ?? 'migrate-cli'
  return { host, port, user, password, database, hostClass, applyAllowed, appliedBy }
}

/**
 * Create a real MySQL migration executor.
 * Remote hosts require CAIRN_ALLOW_REMOTE_DB=1 (assertHostAllowed).
 * Apply authorization remains LOCAL|STAGING via migrationApplyAllowed (enforced by applyMigrations).
 */
export function createMysqlMigrationExecutor(
  opts: MysqlMigrationExecutorOptions = {},
): MysqlMigrationExecutor {
  const cfg = resolveMysqlMigrationConfig(opts)
  const readOnly = opts.readOnly === true
  let closed = false
  let pool: Pool | null = null
  let injected: Pool | Connection | null = opts.connection ?? null
  const ownsConnection = opts.ownsConnection === true || !opts.connection

  const getQueryable = async (): Promise<Queryable> => {
    if (closed) throw new Error('MysqlMigrationExecutor is closed')
    if (injected) return injected as Queryable
    if (!pool) {
      const poolOpts: PoolOptions = {
        host: cfg.host,
        port: cfg.port,
        user: cfg.user,
        password: cfg.password,
        database: cfg.database,
        connectionLimit: 4,
        waitForConnections: true,
        queueLimit: 16,
        connectTimeout: 10_000,
        charset: 'utf8mb4',
        // Single statements only — multiStatements off to avoid accidental batching.
        multipleStatements: false,
      }
      pool = mysql.createPool(poolOpts)
      // Migration SQL 003 normalizes zero-date sentinels; MySQL 8 default sql_mode
      // includes NO_ZERO_DATE which rejects the comparison literal. Strip only those
      // flags so expand/backfill can run; keep other strictness.
      pool.on('connection', (conn) => {
        conn.query(
          `SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(
             CONCAT(',', REPLACE(@@SESSION.sql_mode, ' ', ''), ','),
             ',NO_ZERO_IN_DATE,', ','),
             ',NO_ZERO_DATE,', ','))`,
        )
      })
    }
    return pool
  }

  const listApplied = async (): Promise<Array<MigrationHistoryRow>> => {
    const q = await getQueryable()
    try {
      // Real applies only (dry_run=0). Order by version for plan/checksum.
      const [rows] = await q.query(
        `SELECT version, filename, sha256, classification, applied_at, dry_run
         FROM schema_migrations
         WHERE dry_run = 0
         ORDER BY version ASC`,
      )
      return (rows as Array<RowDataPacket>).map((r) =>
        mapHistoryRow(r as Parameters<typeof mapHistoryRow>[0]),
      )
    } catch (e) {
      if (isNoSuchTable(e)) return []
      throw e
    }
  }

  const close = async (): Promise<void> => {
    if (closed) return
    closed = true
    if (pool) {
      await pool.end()
      pool = null
    }
    if (ownsConnection && injected) {
      const c = injected as Pool & Connection
      if (typeof c.end === 'function') {
        await c.end()
      }
      injected = null
    }
  }

  const ping = async (): Promise<void> => {
    const q = await getQueryable()
    await q.query('SELECT 1 AS ok')
  }

  // Read-only: omit recordApplied so dryRunMigrations does not attempt history writes.
  // query still present but refuses mutation if accidentally called.
  if (readOnly) {
    return {
      host: cfg.host,
      hostClass: cfg.hostClass,
      applyAllowed: cfg.applyAllowed,
      database: cfg.database,
      readOnly: true,
      async query(): Promise<unknown> {
        throw new Error('MysqlMigrationExecutor is read-only; refuse SQL mutation')
      },
      listApplied,
      // recordApplied intentionally omitted
      ping,
      close,
    }
  }

  return {
    host: cfg.host,
    hostClass: cfg.hostClass,
    applyAllowed: cfg.applyAllowed,
    database: cfg.database,
    readOnly: false,

    async query(sql: string, params?: Array<unknown>): Promise<unknown> {
      const q = await getQueryable()
      const [result] = await q.query(sql, params)
      return result
    },

    listApplied,

    async recordApplied(row: MigrationHistoryRow): Promise<void> {
      const q = await getQueryable()
      const dryRun = row.dryRun === true ? 1 : 0
      // Idempotent upsert: same version re-record updates checksum metadata (apply path
      // only reaches here after plan said APPLY; dry-run rows use dry_run=1).
      await q.query(
        `INSERT INTO schema_migrations
           (version, filename, sha256, classification, applied_by, dry_run)
         VALUES (?, ?, ?, ?, ?, ?)
         ON DUPLICATE KEY UPDATE
           filename = VALUES(filename),
           sha256 = VALUES(sha256),
           classification = VALUES(classification),
           applied_by = VALUES(applied_by),
           dry_run = VALUES(dry_run),
           applied_at = CURRENT_TIMESTAMP(3)`,
        [row.version, row.filename, row.sha256, row.classification, cfg.appliedBy, dryRun],
      )
    },

    ping,
    close,
  }
}

/**
 * Read-only variant for plan/dry-run/status — listApplied + ping only.
 * Mutations throw. Safe default when CLI mode is not apply.
 */
export function createMysqlMigrationReadOnlyExecutor(
  opts: Omit<MysqlMigrationExecutorOptions, 'readOnly'> = {},
): MysqlMigrationExecutor {
  return createMysqlMigrationExecutor({ ...opts, readOnly: true })
}
