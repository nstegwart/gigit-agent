/**
 * Durable control-plane runtime context — process-singleton via global Symbol.
 *
 * Exposes injected MySQL control-data + runtime persistence (useNamedLock:true),
 * shared clock / idempotency / revision authority, MySQL ControlPlaneAtomicStore,
 * and one process-shared AccountSyncScheduler (SLA publish coordinator) with a
 * single unref'd autonomous tick loop per context (cleanup on reset).
 *
 * - Lazy init on first getControlPlaneRuntimeContext()
 * - Production / server: fail-closed when DB config or client unavailable (no silent memory)
 * - Tests: setTestControlPlaneRuntimeContext / resetControlPlaneRuntimeContextForTests only
 * - Default surface publisher: four product consumer service paths (MCP/API/UI/Ops)
 * - Autonomous tick loop: mandatory onError + onFatalError → STALE / usableCapacity=0
 *   + ACCOUNT_SYNC_LOOP_FATAL secondary path (never empty catch)
 *
 * Exposes getAccountSyncScheduler() for board-mcp trigger wiring.
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
import {
  createMemoryBackedMysqlHumanDisplayStore,
  createMemoryHumanDisplayStore,
  createMysqlHumanDisplayStore,
  type HumanDisplayStore,
} from './human-display-persistence'
import {
  createAccountSyncSchedulerFromAuthority,
  createAccountSyncSchedulerLoopOnError,
  createAccountSyncSchedulerLoopOnFatalError,
  createDurableAccountSyncSurfaceReaders,
  createIndependentAccountSyncSurfacePublisher,
  startAccountSyncSchedulerLoop,
  type AccountSyncLoopAlertEvent,
  type AccountSyncLoopFatalEvent,
  type AccountSyncScheduler,
  type AccountSyncSchedulerLoopHandle,
  type AccountSyncSurfacePublisher,
  type AccountSyncSurfaceReaders,
} from './account-sync-scheduler'
import {
  createMemoryMetricsRegistry,
  type MetricsRegistry,
} from './observability'

// ---------------------------------------------------------------------------
// Global symbol holder (survives HMR / multi-import identity)
// ---------------------------------------------------------------------------

export const CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL = Symbol.for(
  'cairn.controlPlaneRuntimeContext.v1',
)

export type ControlPlaneRuntimeContextMode = 'mysql' | 'memory' | 'test'

/**
 * Shared server context packet for control-plane durable stores.
 * One clock + one revision + one idempotency authority + one account-sync
 * SLA scheduler per process (scheduler state survives HTTP/MCP requests).
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
  /**
   * Versioned owner humanDisplay store (task/project/feature).
   * Missing/stale/unreviewed → CONTENT_REVIEW_REQUIRED via store.get resolve path.
   */
  humanDisplay: HumanDisplayStore
  /**
   * Process-shared account-sync SLA scheduler (enqueue/tick/flush).
   * Wired to runtime.accounts + atomic + idempotency + this.clock.
   * Per-board coalescing / deadlines live on this instance (in-process durable).
   * board-mcp consumes via getAccountSyncScheduler() — do not construct a second one.
   */
  accountSyncScheduler: AccountSyncScheduler
  /**
   * Unref timer loop handle (one per context). Null when autoStartLoop=false
   * (unit tests that drive tick() manually). Always stop via cleanup helpers.
   */
  accountSyncSchedulerLoop: AccountSyncSchedulerLoopHandle | null
}

interface ContextHolder {
  instance: ControlPlaneRuntimeContext | null
  /** Test-only override; takes precedence over lazy production instance. */
  testOverride: ControlPlaneRuntimeContext | null
  /** Active loop for the lazy production instance (stopped on reset). */
  productionLoop: AccountSyncSchedulerLoopHandle | null
}

type GlobalWithContext = typeof globalThis & {
  [CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]?: ContextHolder
}

function getHolder(): ContextHolder {
  const g = globalThis as GlobalWithContext
  let holder = g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL]
  if (!holder) {
    holder = { instance: null, testOverride: null, productionLoop: null }
    g[CONTROL_PLANE_RUNTIME_CONTEXT_SYMBOL] = holder
  }
  // Backward-compat for hot-reload holders missing productionLoop.
  if (!('productionLoop' in holder) || holder.productionLoop === undefined) {
    ;(holder as ContextHolder).productionLoop = null
  }
  return holder
}

function stopLoop(handle: AccountSyncSchedulerLoopHandle | null | undefined): void {
  if (handle && handle.isRunning()) handle.stop()
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
  /**
   * Optional multi-surface publisher for the attached AccountSyncScheduler.
   * Default: independent durable readers over runtime.accounts (MCP/API/UI/Ops).
   * Construction fails closed if any reader is absent.
   */
  surfacePublisher?: AccountSyncSurfacePublisher
  /** Optional independent surface readers (used when surfacePublisher omitted). */
  surfaceReaders?: AccountSyncSurfaceReaders
  /** Optional pre-built scheduler (tests). Default: wired from authority stores. */
  accountSyncScheduler?: AccountSyncScheduler
  /**
   * When true (default for production mysql build), start unref tick loop.
   * Unit tests usually set false and call tick() with a fake clock.
   * Production loop always supplies mandatory onError (never swallows tick rejection).
   */
  autoStartSchedulerLoop?: boolean
  /** Override loop interval (ms). */
  schedulerLoopIntervalMs?: number
  /**
   * Alert/audit callback for autonomous tick rejections (production loop).
   * Invoked after watched boards are marked ACCOUNT_SYNC_STALE / usableCapacity=0.
   */
  onAccountSyncLoopAlert?: (event: AccountSyncLoopAlertEvent) => void | Promise<void>
  /** Optional test override for loop onError (must still fail-closed boards). */
  accountSyncLoopOnError?: (err: unknown) => void | Promise<void>
  /**
   * Optional test override for secondary onFatalError (ACCOUNT_SYNC_LOOP_FATAL).
   * Production default: createAccountSyncSchedulerLoopOnFatalError + control-data audit.
   */
  accountSyncLoopOnFatalError?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  /** Durable alert when secondary fatal path fires. */
  onAccountSyncLoopFatal?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  /**
   * Runtime-owned metrics registry injected into FATAL emit / tertiary sink.
   * Default: process-local createMemoryMetricsRegistry() when omitted.
   */
  metrics?: MetricsRegistry
}

/**
 * Attach one AccountSyncScheduler to runtime authority pieces.
 * Same clock + accounts + atomic + idempotency as the rest of the context.
 * Default surface publisher: independent durable readers (not process Map echo).
 * Fails closed when readers cannot be constructed for all four surfaces.
 */
function attachAccountSyncScheduler(input: {
  clock: ControlPlaneClock
  accounts: ControlPlaneRuntimePersistence['accounts']
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
  surfacePublisher?: AccountSyncSurfacePublisher
  surfaceReaders?: AccountSyncSurfaceReaders
  accountSyncScheduler?: AccountSyncScheduler
}): AccountSyncScheduler {
  if (input.accountSyncScheduler) return input.accountSyncScheduler
  let surfacePublisher = input.surfacePublisher
  if (!surfacePublisher) {
    const readers =
      input.surfaceReaders ?? createDurableAccountSyncSurfaceReaders(input.accounts)
    // Fail closed: missing any of mcp/api/ui/ops aborts context construction.
    surfacePublisher = createIndependentAccountSyncSurfacePublisher({
      readers,
      recordShared: true,
    })
  }
  return createAccountSyncSchedulerFromAuthority({
    clock: input.clock,
    accounts: input.accounts,
    atomic: input.atomic,
    idempotency: input.idempotency,
    surfacePublisher,
    surfaceReaders: input.surfaceReaders,
  })
}

function maybeStartLoop(
  scheduler: AccountSyncScheduler,
  opts: {
    autoStart?: boolean
    intervalMs?: number
    /** Mandatory when autoStart; production fail-closed + alert. */
    onError?: (err: unknown) => void | Promise<void>
    /** Mandatory secondary when primary rejects. */
    onFatalError?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
    onAlert?: (event: AccountSyncLoopAlertEvent) => void | Promise<void>
    onFatalAlert?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
    appendAudit?: (entry: Record<string, unknown>) => void | Promise<void>
    nowMs?: () => number
    /** Runtime-owned metrics (FATAL emit + tertiary sink). */
    metrics?: MetricsRegistry
  },
): AccountSyncSchedulerLoopHandle | null {
  if (opts.autoStart === false) return null
  // Runtime owns the registry: inject provided or create process-local default.
  const metrics = opts.metrics ?? createMemoryMetricsRegistry(opts.nowMs)
  const onError =
    opts.onError ??
    createAccountSyncSchedulerLoopOnError({
      scheduler,
      onAlert: opts.onAlert,
      nowMs: opts.nowMs,
    })
  const onFatalError =
    opts.onFatalError ??
    createAccountSyncSchedulerLoopOnFatalError({
      scheduler,
      appendAudit: opts.appendAudit,
      onAlert: opts.onFatalAlert,
      nowMs: opts.nowMs,
      metrics,
    })
  return startAccountSyncSchedulerLoop(scheduler, {
    intervalMs: opts.intervalMs,
    unref: true,
    onError,
    onFatalError,
    metrics,
    appendAudit: opts.appendAudit,
  })
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
  const humanDisplay = createMysqlHumanDisplayStore(sqlExecutor)
  const clock = opts.clock ?? createSystemClock()
  const accountSyncScheduler = attachAccountSyncScheduler({
    clock,
    accounts: runtime.accounts,
    atomic,
    idempotency: controlData.idempotency,
    surfacePublisher: opts.surfacePublisher,
    surfaceReaders: opts.surfaceReaders,
    accountSyncScheduler: opts.accountSyncScheduler,
  })
  // Production/server default: start autonomous unref loop with mandatory
  // onError + onFatalError (STALE + ACCOUNT_SYNC_LOOP_FATAL; never empty swallow).
  const autoStart = opts.autoStartSchedulerLoop ?? true
  const accountSyncSchedulerLoop = maybeStartLoop(accountSyncScheduler, {
    autoStart,
    intervalMs: opts.schedulerLoopIntervalMs,
    onError: opts.accountSyncLoopOnError,
    onFatalError: opts.accountSyncLoopOnFatalError,
    onAlert: opts.onAccountSyncLoopAlert,
    onFatalAlert: opts.onAccountSyncLoopFatal,
    appendAudit: (entry) => controlData.imports.appendAudit(entry),
    nowMs: () => clock.nowMs(),
    metrics: opts.metrics,
  })

  return {
    mode: 'mysql',
    clock,
    controlData,
    runtime,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
    humanDisplay,
    accountSyncScheduler,
    accountSyncSchedulerLoop,
  }
}

/**
 * Explicit in-process memory context for unit tests (not production).
 * Shares one memory atomic store + F1/F2 memory backends.
 */
export function createMemoryControlPlaneRuntimeContext(opts?: {
  clock?: ControlPlaneClock
  seedBoards?: Parameters<typeof createMemoryControlPlaneAtomicStore>[0]
  /** Optional pre-built humanDisplay store (tests). Default: pure memory store. */
  humanDisplay?: HumanDisplayStore
  /** Optional multi-surface publisher for attached scheduler (tests). */
  surfacePublisher?: AccountSyncSurfacePublisher
  surfaceReaders?: AccountSyncSurfaceReaders
  /** Optional pre-built scheduler (tests). Default: wired from memory authority. */
  accountSyncScheduler?: AccountSyncScheduler
  /**
   * Default false for memory/unit contexts (tests drive tick() with fake clock).
   * Set true to exercise the unref loop in process (mandatory onError supplied).
   */
  autoStartSchedulerLoop?: boolean
  schedulerLoopIntervalMs?: number
  onAccountSyncLoopAlert?: (event: AccountSyncLoopAlertEvent) => void | Promise<void>
  accountSyncLoopOnError?: (err: unknown) => void | Promise<void>
  accountSyncLoopOnFatalError?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  onAccountSyncLoopFatal?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  /** Runtime-owned metrics for FATAL emit / tertiary sink. */
  metrics?: MetricsRegistry
}): ControlPlaneRuntimeContext {
  const controlData = createMemoryBackedControlDataPersistence()
  const runtime = createMemoryControlPlaneRuntimePersistence()
  const atomic = createMemoryControlPlaneAtomicStore(opts?.seedBoards ?? [])
  const humanDisplay = opts?.humanDisplay ?? createMemoryHumanDisplayStore()
  const clock = opts?.clock ?? createSystemClock()
  const accountSyncScheduler = attachAccountSyncScheduler({
    clock,
    accounts: runtime.accounts,
    atomic,
    idempotency: controlData.idempotency,
    surfacePublisher: opts?.surfacePublisher,
    surfaceReaders: opts?.surfaceReaders,
    accountSyncScheduler: opts?.accountSyncScheduler,
  })
  const accountSyncSchedulerLoop = maybeStartLoop(accountSyncScheduler, {
    autoStart: opts?.autoStartSchedulerLoop === true,
    intervalMs: opts?.schedulerLoopIntervalMs,
    onError: opts?.accountSyncLoopOnError,
    onFatalError: opts?.accountSyncLoopOnFatalError,
    onAlert: opts?.onAccountSyncLoopAlert,
    onFatalAlert: opts?.onAccountSyncLoopFatal,
    appendAudit: (entry) => controlData.imports.appendAudit(entry),
    nowMs: () => clock.nowMs(),
    metrics: opts?.metrics,
  })
  return {
    mode: 'memory',
    clock,
    controlData,
    runtime,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
    humanDisplay,
    accountSyncScheduler,
    accountSyncSchedulerLoop,
  }
}

/**
 * Memory context that uses MySQL adapter code paths over in-memory SQL
 * (atomic + optional shared executor). Useful for restart / CAS adapter tests.
 */
export function createMemorySqlBackedControlPlaneRuntimeContext(opts?: {
  clock?: ControlPlaneClock
  surfacePublisher?: AccountSyncSurfacePublisher
  surfaceReaders?: AccountSyncSurfaceReaders
  accountSyncScheduler?: AccountSyncScheduler
  autoStartSchedulerLoop?: boolean
  schedulerLoopIntervalMs?: number
  onAccountSyncLoopAlert?: (event: AccountSyncLoopAlertEvent) => void | Promise<void>
  accountSyncLoopOnError?: (err: unknown) => void | Promise<void>
  accountSyncLoopOnFatalError?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  onAccountSyncLoopFatal?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  /** Runtime-owned metrics for FATAL emit / tertiary sink. */
  metrics?: MetricsRegistry
}): ControlPlaneRuntimeContext & {
  atomicExec: ReturnType<typeof createMemoryAtomicSqlExecutor>
} {
  const controlData = createMemoryBackedControlDataPersistence()
  const runtimeBundle = createMemoryControlPlaneRuntimePersistence()
  const atomicExec = createMemoryAtomicSqlExecutor()
  // Chain lock for pure unit (useNamedLock false); multi-process path tested separately.
  const atomic = createMysqlControlPlaneAtomicStore(atomicExec, { useNamedLock: false })
  // MySQL humanDisplay adapter over in-memory HD SQL (tables distinct from atomic).
  const humanDisplay = createMemoryBackedMysqlHumanDisplayStore()
  const clock = opts?.clock ?? createSystemClock()
  const accountSyncScheduler = attachAccountSyncScheduler({
    clock,
    accounts: runtimeBundle.accounts,
    atomic,
    idempotency: controlData.idempotency,
    surfacePublisher: opts?.surfacePublisher,
    surfaceReaders: opts?.surfaceReaders,
    accountSyncScheduler: opts?.accountSyncScheduler,
  })
  const accountSyncSchedulerLoop = maybeStartLoop(accountSyncScheduler, {
    autoStart: opts?.autoStartSchedulerLoop === true,
    intervalMs: opts?.schedulerLoopIntervalMs,
    onError: opts?.accountSyncLoopOnError,
    onFatalError: opts?.accountSyncLoopOnFatalError,
    onAlert: opts?.onAccountSyncLoopAlert,
    onFatalAlert: opts?.onAccountSyncLoopFatal,
    appendAudit: (entry) => controlData.imports.appendAudit(entry),
    nowMs: () => clock.nowMs(),
    metrics: opts?.metrics,
  })
  return {
    mode: 'memory',
    clock,
    controlData,
    runtime: runtimeBundle,
    atomic,
    revisions: controlData.revisions,
    idempotency: controlData.idempotency,
    humanDisplay,
    accountSyncScheduler,
    accountSyncSchedulerLoop,
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

  holder.instance = buildMysqlControlPlaneRuntimeContext({
    env,
    requireDbConfig: true,
    autoStartSchedulerLoop: true,
  })
  holder.productionLoop = holder.instance.accountSyncSchedulerLoop
  return holder.instance
}

/**
 * Test-only: install a memory/injected context as the process singleton override.
 * Production code must never call this.
 * Stops any prior production loop; does not auto-start the override's loop
 * (caller opts via createMemoryControlPlaneRuntimeContext autoStartSchedulerLoop).
 */
export function setTestControlPlaneRuntimeContext(
  ctx: ControlPlaneRuntimeContext | null,
): void {
  const holder = getHolder()
  stopLoop(holder.productionLoop)
  holder.productionLoop = null
  // If replacing a previous override that had a loop, stop it.
  stopLoop(holder.testOverride?.accountSyncSchedulerLoop)
  holder.testOverride = ctx
}

/**
 * Test-only: clear override + cached production instance so the next get() re-inits.
 * Stops every scheduler loop started by this holder.
 */
export function resetControlPlaneRuntimeContextForTests(): void {
  const holder = getHolder()
  stopLoop(holder.testOverride?.accountSyncSchedulerLoop)
  stopLoop(holder.instance?.accountSyncSchedulerLoop)
  stopLoop(holder.productionLoop)
  holder.testOverride = null
  holder.instance = null
  holder.productionLoop = null
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

/**
 * Narrow getter for the process-shared AccountSyncScheduler.
 * board-mcp (and other request handlers) must use this instead of constructing
 * a new scheduler — so coalesced heartbeats / deadlines survive across requests.
 */
export function getAccountSyncScheduler(
  env: NodeJS.ProcessEnv = process.env,
): AccountSyncScheduler {
  return getControlPlaneRuntimeContext(env).accountSyncScheduler
}

/**
 * Peek scheduler without lazy-init (null when no context is installed).
 */
export function peekAccountSyncScheduler(): AccountSyncScheduler | null {
  return peekControlPlaneRuntimeContext()?.accountSyncScheduler ?? null
}
