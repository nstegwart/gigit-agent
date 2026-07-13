/**
 * Durable control-plane runtime context — process-singleton via global Symbol.
 *
 * Exposes injected MySQL control-data + runtime persistence (useNamedLock:true),
 * shared clock / idempotency / revision authority, and MySQL ControlPlaneAtomicStore.
 *
 * - Lazy init on first getControlPlaneRuntimeContext()
 * - Production / server: fail-closed when DB config or client unavailable (no silent memory)
 * - Tests: setTestControlPlaneRuntimeContext / resetControlPlaneRuntimeContextForTests only
 *
 * Does NOT wire board-mcp (out of scope).
 */
import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import { createSystemClock } from './board-store'
import {
  createMemoryBackedControlDataPersistence,
  createMysqlControlDataPersistence,
  type ControlDataPersistence,
  type ControlDataSqlClient,
} from './control-data-persistence'
import {
  createMemoryControlPlaneRuntimePersistence,
  createMysqlControlPlaneRuntimePersistence,
  createMysqlPoolExecutor,
  type ControlPlaneRuntimePersistence,
  type SqlExecutor,
} from './control-plane-runtime-persistence'
import { configuredDbHost, db, envVar } from './db'
import type { IdempotencyStorage } from './idempotency'
import type { RevisionStore } from './revisions'
import {
  createMemoryAtomicSqlExecutor,
  createMysqlControlPlaneAtomicStore,
  createMysqlControlPlaneAtomicStoreStrict,
} from './mysql-control-plane-atomic'
import { createMemoryControlPlaneAtomicStore } from './board-store'

// ---------------------------------------------------------------------------
// Global symbol holder (survives HMR / multi-import identity)
// ---------------------------------------------------------------------------

export const CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL = Symbol.for(
  'cairn.controlPlaneRuntimeContext.v1',
)

export type ControlPlaneRuntimeContextMode = 'mysql' | 'memory' | 'test'

/**
 * Shared server context packet for control-plane durable stores.
 * One clock + one revision + one idempotency authority per process.
 */
export interface ControlPlaneRuntimeContext {
  mode: ControlPlaneRuntimeContextMode
  clock: ControlPlaneClock
  /** F1 control-data bundle (revisions, idempotency, decisions, imports, g5, classification). */
  controlData: ControlDataPersistence
  /** F2 runtime persistence bundle (plans, runs, locks, accounts, reconciler, retention). */
  runtime: ControlPlaneRuntimePersistence
  /** Board rev / dispatch block / material audit atomic store. */
  atomic: ControlPlaneAtomicStore
  /** Shared revision authority (same object as controlData.revisions). */
  revisions: RevisionStore
  /** Shared idempotency authority (same object as controlData.idempotency). */
  idempotency: IdempotencyStorage
}

interface ContextHolder {
  instance: ControlPlaneRuntimeContext | null
  /** Test-only override; takes precedence over lazy production instance. */
  testOverride: ControlPlaneRuntimeContext | null
}

type GlobalWithContext = typeof globalThis & {
  [CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]?: ContextHolder
}

function getHolder(): ContextHolder {
  const g = globalThis as GlobalWithContext
  let holder = g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]
  if (!holder) {
    holder = { instance: null, testOverride: null }
    g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL] = holder
  }
  return holder
}

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type ControlPlaneRuntimeContextErrorCode =
  | 'DB_UNAVAILABLE'
  | 'INVALID_INPUT'
  | 'NOT_CONFIGURED'

export class ControlPlaneRuntimeContextError extends Error {
  readonly code: ControlPlaneRuntimeContextErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: ControlPlaneRuntimeContextErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ControlPlaneRuntimeContextError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Env / fail-closed helpers
// ---------------------------------------------------------------------------

/**
 * Production-like server: NODE_ENV=production, or CAIRN_ENV/APP_ENV in
 * {production,prod,staging}, or CAIRN_SERVER=1.
 */
export function isProductionOrServerEnv(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = (env.NODE_ENV || '').toLowerCase()
  if (nodeEnv === 'production') return true
  if ((env.CAIRN_SERVER || '').trim() === '1') return true
  const appEnv = (env.CAIRN_ENV || env.APP_ENV || '').toLowerCase()
  return appEnv === 'production' || appEnv === 'prod' || appEnv === 'staging'
}

export interface DbConfigSnapshot {
  host: string
  port: string
  user: string | undefined
  database: string | undefined
  passwordPresent: boolean
}

/**
 * Read DB config without opening a pool.
 * When `env` is process.env (default), also consult .env via envVar/configuredDbHost.
 * When a *custom* env object is passed (tests / fail-closed probes), only that object is read —
 * no silent merge from the process .env file (so missing keys are actually missing).
 */
export function readDbConfigSnapshot(
  env: NodeJS.ProcessEnv = process.env,
  opts?: { allowEnvFileFallback?: boolean },
): DbConfigSnapshot {
  const allowFallback = opts?.allowEnvFileFallback ?? env === process.env
  const pick = (key: string): string | undefined => {
    const direct = env[key]?.trim()
    if (direct) return direct
    if (allowFallback) return envVar(key)?.trim() || undefined
    return undefined
  }
  return {
    host: pick('CAIRN_DB_HOST') || (allowFallback ? configuredDbHost() : '127.0.0.1'),
    port: pick('CAIRN_DB_PORT') || '3306',
    user: pick('CAIRN_DB_USER'),
    database: pick('CAIRN_DB_NAME') || (allowFallback ? 'cairn_taskmanager' : undefined),
    passwordPresent: Boolean(pick('CAIRN_DB_PASSWORD')?.length),
  }
}

/**
 * Fail-closed gate: production/server must have usable DB identity (user + database).
 * Returns null when OK; otherwise an error instance (does not throw).
 *
 * Custom `env` objects do not fall back to the process .env file (probe isolation).
 */
export function checkDbConfigForContext(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneRuntimeContextError | null {
  const snap = readDbConfigSnapshot(env, { allowEnvFileFallback: env === process.env })
  const missing: Array<string> = []
  if (!snap.user) missing.push('CAIRN_DB_USER')
  if (!snap.database) missing.push('CAIRN_DB_NAME')
  if (missing.length > 0) {
    return new ControlPlaneRuntimeContextError(
      'DB_UNAVAILABLE',
      `Control-plane runtime context requires DB config (${missing.join(', ')}); refusing silent memory fallback`,
      { missing, productionOrServer: isProductionOrServerEnv(env), host: snap.host },
    )
  }
  return null
}

// ---------------------------------------------------------------------------
// Builders
// ---------------------------------------------------------------------------

export interface BuildMysqlContextOptions {
  /** Injected pool-compatible client for control-data (tests / custom pool). */
  controlDataClient?: ControlDataSqlClient
  /** Injected SqlExecutor for runtime + atomic (tests / custom pool). */
  sqlExecutor?: SqlExecutor
  clock?: ControlPlaneClock
  env?: NodeJS.ProcessEnv
  /**
   * When true (default for production path), refuse build if DB config incomplete.
   * Unit tests that inject clients may set false.
   */
  requireDbConfig?: boolean
}

/**
 * Build a MySQL-backed context (not installed as the global singleton).
 * Runtime persistence always uses useNamedLock:true.
 */
export function buildMysqlControlPlaneRuntimeContext(
  opts: BuildMysqlContextOptions = {},
): ControlPlaneRuntimeContext {
  const env = opts.env ?? process.env
  const requireDbConfig = opts.requireDbConfig ?? isProductionOrServerEnv(env)

  if (requireDbConfig) {
    const cfgErr = checkDbConfigForContext(env)
    if (cfgErr) throw cfgErr
  }

  let sqlExecutor = opts.sqlExecutor
  let controlData: ControlDataPersistence

  if (opts.controlDataClient) {
    controlData = createMysqlControlDataPersistence({
      client: opts.controlDataClient,
      requireInjected: true,
    })
  } else {
    // Default pool — fail closed if pool construction throws.
    try {
      controlData = createMysqlControlDataPersistence({ client: undefined, requireInjected: false })
    } catch (e) {
      throw new ControlPlaneRuntimeContextError(
        'DB_UNAVAILABLE',
        `Failed to create MySQL control-data client: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e instanceof Error ? e.name : typeof e },
      )
    }
  }

  if (!sqlExecutor) {
    try {
      const pool = db()
      sqlExecutor = createMysqlPoolExecutor(pool)
    } catch (e) {
      throw new ControlPlaneRuntimeContextError(
        'DB_UNAVAILABLE',
        `Failed to create MySQL pool executor: ${e instanceof Error ? e.message : String(e)}`,
        { cause: e instanceof Error ? e.name : typeof e },
      )
    }
  }

  if (typeof sqlExecutor.getConnection !== 'function') {
    throw new ControlPlaneRuntimeContextError(
      'INVALID_INPUT',
      'MySQL runtime context requires SqlExecutor.getConnection() for useNamedLock:true',
      {},
    )
  }

  let runtime: ControlPlaneRuntimePersistence
  try {
    runtime = createMysqlControlPlaneRuntimePersistence(sqlExecutor, { useNamedLock: true })
  } catch (e) {
    throw new ControlPlaneRuntimeContextError(
      'INVALID_INPUT',
      `Failed to create runtime persistence (useNamedLock:true): ${e instanceof Error ? e.message : String(e)}`,
      { cause: e instanceof Error ? e.name : typeof e },
    )
  }

  const atomic = createMysqlControlPlaneAtomicStoreStrict(sqlExecutor)
  const clock = opts.clock ?? createSystemClock()

  return {
    mode: 'mysql',
    clock,
    controlData,
    runtime,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
  }
}

/**
 * Explicit in-process memory context for unit tests (not production).
 * Shares one memory atomic store + F1/F2 memory backends.
 */
export function createMemoryControlPlaneRuntimeContext(opts?: {
  clock?: ControlPlaneClock
  seedBoards?: Parameters<typeof createMemoryControlPlaneAtomicStore>[0]
}): ControlPlaneRuntimeContext {
  const controlData = createMemoryBackedControlDataPersistence()
  const runtime = createMemoryControlPlaneRuntimePersistence()
  const atomic = createMemoryControlPlaneAtomicStore(opts?.seedBoards ?? [])
  const clock = opts?.clock ?? createSystemClock()
  return {
    mode: 'memory',
    clock,
    controlData,
    runtime,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
  }
}

/**
 * Memory context that uses MySQL adapter code paths over in-memory SQL
 * (atomic + optional shared executor). Useful for restart / CAS adapter tests.
 */
export function createMemorySqlBackedControlPlaneRuntimeContext(opts?: {
  clock?: ControlPlaneClock
}): ControlPlaneRuntimeContext & {
  atomicExec: ReturnType<typeof createMemoryAtomicSqlExecutor>
} {
  const controlData = createMemoryBackedControlDataPersistence()
  const runtimeBundle = createMemoryControlPlaneRuntimePersistence()
  const atomicExec = createMemoryAtomicSqlExecutor()
  // Chain lock for pure unit (useNamedLock false); multi-process path tested separately.
  const atomic = createMysqlControlPlaneAtomicStore(atomicExec, { useNamedLock: false })
  const clock = opts?.clock ?? createSystemClock()
  return {
    mode: 'memory',
    clock,
    controlData,
    runtime: runtimeBundle,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
    atomicExec,
  }
}

// ---------------------------------------------------------------------------
// Lazy singleton API
// ---------------------------------------------------------------------------

/**
 * Get the process-singleton control-plane runtime context.
 * - Test override wins when set via setTestControlPlaneRuntimeContext
 * - Otherwise lazily builds MySQL context (fail-closed in production/server)
 */
export function getControlPlaneRuntimeContext(
  env: NodeJS.ProcessEnv = process.env,
): ControlPlaneRuntimeContext {
  const holder = getHolder()
  if (holder.testOverride) return holder.testOverride
  if (holder.instance) return holder.instance

  // Production/server: always require DB config before touching pool.
  if (isProductionOrServerEnv(env)) {
    const cfgErr = checkDbConfigForContext(env)
    if (cfgErr) throw cfgErr
  } else {
    // Non-prod without override: still require DB config for default MySQL path
    // (unit tests must inject via setTestControlPlaneRuntimeContext).
    const cfgErr = checkDbConfigForContext(env)
    if (cfgErr) {
      throw new ControlPlaneRuntimeContextError(
        'NOT_CONFIGURED',
        `${cfgErr.message}. In tests call setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext()).`,
        { ...cfgErr.details, code: cfgErr.code },
      )
    }
  }

  holder.instance = buildMysqlControlPlaneRuntimeContext({ env, requireDbConfig: true })
  return holder.instance
}

/**
 * Test-only: install a memory/injected context as the process singleton override.
 * Production code must never call this.
 */
export function setTestControlPlaneRuntimeContext(
  ctx: ControlPlaneRuntimeContext | null,
): void {
  const holder = getHolder()
  holder.testOverride = ctx
}

/**
 * Test-only: clear override + cached production instance so the next get() re-inits.
 */
export function resetControlPlaneRuntimeContextForTests(): void {
  const holder = getHolder()
  holder.testOverride = null
  holder.instance = null
}

/** True when a test override is installed. */
export function hasTestControlPlaneRuntimeContext(): boolean {
  return getHolder().testOverride != null
}

/** Peek without lazy-init (returns null if neither override nor instance exists). */
export function peekControlPlaneRuntimeContext(): ControlPlaneRuntimeContext | null {
  const holder = getHolder()
  return holder.testOverride ?? holder.instance
}
