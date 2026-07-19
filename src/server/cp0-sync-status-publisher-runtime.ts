/**
 * CP0 sync-status publisher runtime / scheduler (PACKET-P3D).
 *
 * Composes P2 one-tick core + P3A MySQL lock/pin/CAS + P3C dual-count measurers
 * into a fail-closed, env-default-OFF process-singleton loop.
 *
 * Hard bounds (this packet only):
 *   - measure → sink publish runtime (control_plane_sync_status via P3A)
 *   - NO outbox enqueue / writer / claimer / ACK / DEAD semantics
 *   - NO insert of outbox / residual rows
 *   - NEVER invent proven zeros or IN_SYNC without dual-proven zero measures
 *   - Outbox model remains BLOCKED_MODEL (investigation a239)
 *
 * Import has no side effects: no timers, no db(), no loops at module load.
 * Scheduler existence never implies readiness; health remains independent.
 */

import { classifyDbHost, db } from './db'
import {
  createCp0MysqlBacklogCountMeasurers,
  type Cp0BacklogCountSqlClient,
} from './cp0-sync-status-count-sources'
import {
  createDefaultCp0SyncStatusMeasureDeps,
} from './cp0-sync-status-measures'
import {
  CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS,
  createCp0SyncStatusPublisherDeps,
  runCp0SyncStatusPublisherTick,
  sanitizePublisherReason,
  type Cp0PublisherDecision,
  type Cp0PublisherReasonCode,
  type Cp0SyncStatusPublishResult,
  type Cp0SyncStatusPublisherDeps,
} from './cp0-sync-status-publisher'
import {
  createCp0SyncStatusPublisherMysqlDeps,
  type Cp0PublisherMysqlClient,
  type Cp0PublisherMysqlConnection,
} from './cp0-sync-status-publisher-mysql'

// ---------------------------------------------------------------------------
// Constants / env keys
// ---------------------------------------------------------------------------

/** Diagnostic schema id for runtime snapshot envelopes (no secrets). */
export const CP0_PUBLISHER_RUNTIME_SCHEMA = 'CP0_SYNC_STATUS_PUBLISHER_RUNTIME_V1' as const

/** Process-singleton holder key (HMR-safe via Symbol.for). */
export const CP0_PUBLISHER_RUNTIME_SYMBOL = Symbol.for(
  'cairn.cp0SyncStatusPublisherRuntime.v1',
)

/** Stable publisherId written into record_json by composed ticks. */
export const CP0_PUBLISHER_RUNTIME_PUBLISHER_ID = 'cp0-runtime' as const

/** Master enable flag (default OFF). */
export const CP0_PUBLISHER_ENV_ENABLE = 'CAIRN_CP0_SYNC_STATUS_PUBLISHER' as const
/** CSV board allowlist (empty ⇒ refuse start). */
export const CP0_PUBLISHER_ENV_BOARDS = 'CAIRN_CP0_SYNC_STATUS_PUBLISHER_BOARDS' as const
/** Base interval ms. */
export const CP0_PUBLISHER_ENV_INTERVAL_MS =
  'CAIRN_CP0_SYNC_STATUS_PUBLISHER_INTERVAL_MS' as const
/** Jitter amplitude ms. */
export const CP0_PUBLISHER_ENV_JITTER_MS =
  'CAIRN_CP0_SYNC_STATUS_PUBLISHER_JITTER_MS' as const
/** Per-board tick budget ms. */
export const CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS =
  'CAIRN_CP0_SYNC_STATUS_PUBLISHER_TICK_TIMEOUT_MS' as const
/** Parallel boards per process sweep. */
export const CP0_PUBLISHER_ENV_MAX_CONCURRENCY =
  'CAIRN_CP0_SYNC_STATUS_PUBLISHER_MAX_CONCURRENCY' as const
/** Production second gate (required when CAIRN_ENV is prod-like). */
export const CP0_PUBLISHER_ENV_ALLOW_PRODUCTION =
  'CAIRN_CP0_SYNC_STATUS_PUBLISHER_ALLOW_PRODUCTION' as const

export const CP0_PUBLISHER_INTERVAL_MS_MIN = 5_000 as const
export const CP0_PUBLISHER_INTERVAL_MS_MAX = 60_000 as const
export const CP0_PUBLISHER_JITTER_MS_DEFAULT = 3_000 as const
export const CP0_PUBLISHER_TICK_TIMEOUT_MS_DEFAULT = 15_000 as const
export const CP0_PUBLISHER_TICK_TIMEOUT_MS_MIN = 2_000 as const
export const CP0_PUBLISHER_TICK_TIMEOUT_MS_MAX = 30_000 as const
export const CP0_PUBLISHER_MAX_CONCURRENCY_DEFAULT = 1 as const
export const CP0_PUBLISHER_MAX_CONCURRENCY_MAX = 4 as const
export const CP0_PUBLISHER_BOARD_ID_MAX = 64 as const
/** Drain grace after tickTimeout when stopping. */
export const CP0_PUBLISHER_DRAIN_GRACE_MS = 1_000 as const

export type Cp0PublisherDisableReason =
  | 'ENV_OFF'
  | 'DISABLED_NO_BOARDS'
  | 'BLOCKED_PRODUCTION_GATE'
  | 'NOT_STARTED'
  | 'STOPPED'

export type Cp0PublisherRuntimePhase =
  | 'idle'
  | 'ticking'
  | 'draining'
  | 'stopped'
  | 'disabled'

// ---------------------------------------------------------------------------
// Snapshot (non-secret observability)
// ---------------------------------------------------------------------------

export type Cp0PublisherRuntimePinSnap = {
  boardRev: number
  lifecycleRev: number
  canonicalHash: string
}

export type Cp0PublisherRuntimeSnapshot = {
  schemaVersion: typeof CP0_PUBLISHER_RUNTIME_SCHEMA
  publisherEnabled: boolean
  publisherRunning: boolean
  disableReason: Cp0PublisherDisableReason | null
  phase: Cp0PublisherRuntimePhase
  boards: ReadonlyArray<string>
  intervalMs: number
  jitterMs: number
  tickTimeoutMs: number
  maxConcurrency: number
  lastTickStartedAt: string | null
  lastTickFinishedAt: string | null
  lastPublishAt: string | null
  lastPublishedBoardId: string | null
  lastDecision: Cp0PublisherDecision | null
  lastReasonCode: Cp0PublisherReasonCode | string | null
  lastEntityRev: number | null
  lastPin: Cp0PublisherRuntimePinSnap | null
  lastBoardId: string | null
  overlapSkipCount: number
  lockMissCount: number
  errorCount: number
  successCount: number
  boardTickCount: number
  sourcesReady: boolean | null
  /** Sanitized last error token (name/code only; never driver message/SQL/DSN). */
  lastErrorToken: string | null
}

// ---------------------------------------------------------------------------
// Config parse (fail-closed; deterministic clamps)
// ---------------------------------------------------------------------------

export type Cp0PublisherRuntimeConfig = {
  enabled: boolean
  disableReason: Cp0PublisherDisableReason | null
  boards: ReadonlyArray<string>
  intervalMs: number
  jitterMs: number
  tickTimeoutMs: number
  maxConcurrency: number
  allowProduction: boolean
  productionBlocked: boolean
}

function parseTruthyFlag(raw: unknown): boolean {
  if (raw == null) return false
  const s = String(raw).trim().toLowerCase()
  return s === '1' || s === 'true' || s === 'yes' || s === 'on'
}

function clampInt(n: number, min: number, max: number, fallback: number): number {
  if (!Number.isFinite(n) || !Number.isInteger(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

function parseIntEnv(
  env: NodeJS.ProcessEnv,
  key: string,
  fallback: number,
  min: number,
  max: number,
): number {
  const raw = env[key]
  if (raw == null || String(raw).trim() === '') return clampInt(fallback, min, max, fallback)
  const n = Number(String(raw).trim())
  if (!Number.isFinite(n)) return clampInt(fallback, min, max, fallback)
  return clampInt(Math.trunc(n), min, max, fallback)
}

/**
 * Validate a single board id for the allowlist.
 * Rejects empty, over-long, and control-character ids.
 */
export function isValidCp0PublisherBoardId(boardId: unknown): boardId is string {
  if (typeof boardId !== 'string' || boardId.length === 0) return false
  if (boardId.length > CP0_PUBLISHER_BOARD_ID_MAX) return false
  if (/[\u0000-\u001f\u007f]/.test(boardId)) return false
  return true
}

/**
 * Parse CSV board allowlist. Invalid tokens dropped.
 * Empty result after parse ⇒ fail-closed (no implicit all-boards).
 */
export function parseCp0PublisherBoardAllowlist(raw: unknown): string[] {
  if (raw == null) return []
  const text = String(raw)
  if (!text.trim()) return []
  const seen = new Set<string>()
  const out: string[] = []
  for (const part of text.split(',')) {
    const id = part.trim()
    if (!isValidCp0PublisherBoardId(id)) continue
    if (seen.has(id)) continue
    seen.add(id)
    out.push(id)
  }
  return out
}

/**
 * Production second gate: true when publish must not start without ALLOW_PRODUCTION.
 * Staging (CAIRN_ENV=staging) with NODE_ENV=production is NOT blocked.
 * Bare NODE_ENV=production alone is NOT treated as production publish license.
 */
export function isCp0PublisherProductionBlocked(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const cairnEnv = (env.CAIRN_ENV || env.APP_ENV || '').trim().toLowerCase()
  if (cairnEnv === 'production' || cairnEnv === 'prod') return true
  const host = (env.CAIRN_DB_HOST || '').trim()
  if (host) {
    try {
      if (classifyDbHost(host) === 'PRODUCTION') return true
    } catch {
      /* host classify must never throw into gate */
    }
  }
  return false
}

/** Master enable parse (1/true/yes/on, case-insensitive). Default OFF. */
export function isCp0PublisherMasterEnabled(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return parseTruthyFlag(env[CP0_PUBLISHER_ENV_ENABLE])
}

/**
 * Parse full runtime config from env. Pure; no timers / db / side effects.
 * enabled=true only when master ON, not production-blocked (or ALLOW_PRODUCTION),
 * and non-empty validated board allowlist.
 */
export function parseCp0PublisherRuntimeConfig(
  env: NodeJS.ProcessEnv = process.env,
): Cp0PublisherRuntimeConfig {
  const master = isCp0PublisherMasterEnabled(env)
  const allowProduction = parseTruthyFlag(env[CP0_PUBLISHER_ENV_ALLOW_PRODUCTION])
  const productionBlocked = isCp0PublisherProductionBlocked(env)
  const boards = parseCp0PublisherBoardAllowlist(env[CP0_PUBLISHER_ENV_BOARDS])

  const intervalMs = parseIntEnv(
    env,
    CP0_PUBLISHER_ENV_INTERVAL_MS,
    CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS,
    CP0_PUBLISHER_INTERVAL_MS_MIN,
    CP0_PUBLISHER_INTERVAL_MS_MAX,
  )
  const jitterCap = Math.floor(intervalMs / 2)
  const jitterMs = parseIntEnv(
    env,
    CP0_PUBLISHER_ENV_JITTER_MS,
    Math.min(CP0_PUBLISHER_JITTER_MS_DEFAULT, jitterCap),
    0,
    Math.max(0, jitterCap),
  )
  const tickTimeoutMs = parseIntEnv(
    env,
    CP0_PUBLISHER_ENV_TICK_TIMEOUT_MS,
    CP0_PUBLISHER_TICK_TIMEOUT_MS_DEFAULT,
    CP0_PUBLISHER_TICK_TIMEOUT_MS_MIN,
    CP0_PUBLISHER_TICK_TIMEOUT_MS_MAX,
  )
  const maxConcurrency = parseIntEnv(
    env,
    CP0_PUBLISHER_ENV_MAX_CONCURRENCY,
    CP0_PUBLISHER_MAX_CONCURRENCY_DEFAULT,
    1,
    CP0_PUBLISHER_MAX_CONCURRENCY_MAX,
  )

  let enabled = false
  let disableReason: Cp0PublisherDisableReason | null = 'ENV_OFF'

  if (!master) {
    enabled = false
    disableReason = 'ENV_OFF'
  } else if (productionBlocked && !allowProduction) {
    enabled = false
    disableReason = 'BLOCKED_PRODUCTION_GATE'
  } else if (boards.length === 0) {
    enabled = false
    disableReason = 'DISABLED_NO_BOARDS'
  } else {
    enabled = true
    disableReason = null
  }

  return {
    enabled,
    disableReason,
    boards,
    intervalMs,
    jitterMs,
    tickTimeoutMs,
    maxConcurrency,
    allowProduction,
    productionBlocked,
  }
}

// ---------------------------------------------------------------------------
// Error redaction (never invent zeros; never leak SQL/DSN/password)
// ---------------------------------------------------------------------------

/** Redact unknown throws to a short non-secret token. */
export function sanitizeCp0PublisherRuntimeError(err: unknown): string {
  if (err instanceof Error) {
    const maybe = err as Error & { code?: unknown; errno?: unknown }
    const parts: string[] = [(err.name || 'Error').slice(0, 64)]
    if (typeof maybe.code === 'string' && maybe.code) {
      parts.push(maybe.code.slice(0, 64))
    }
    if (typeof maybe.errno === 'number' && Number.isFinite(maybe.errno)) {
      parts.push(`errno=${maybe.errno}`)
    }
    return sanitizePublisherReason(parts.join(' '), 'Error')
  }
  return 'non-error-throw'
}

// ---------------------------------------------------------------------------
// Pool wrap (composition only — credentials never copied onto runtime object)
// ---------------------------------------------------------------------------

/**
 * Thin pool adapter for P3A + P3C inject clients.
 * Exposes only query + getConnection; never re-exports DSN/password.
 */
/** Minimal pool shape accepted by the adapter (mysql2 Pool is structurally compatible). */
export type Cp0PublisherPoolLike = {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  query: (sql: string, params?: any) => Promise<unknown>
  getConnection: () => Promise<{
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    query: (sql: string, params?: any) => Promise<unknown>
    release: () => void
  }>
}

export function wrapPoolAsCp0PublisherMysqlClient(
  pool: Cp0PublisherPoolLike,
): Cp0PublisherMysqlClient & Cp0BacklogCountSqlClient {
  if (pool == null || typeof pool !== 'object') {
    throw new Error('cp0_publisher_pool_required')
  }
  if (typeof pool.query !== 'function' || typeof pool.getConnection !== 'function') {
    throw new Error('cp0_publisher_pool_shape_invalid')
  }

  return {
    async query(sql: string, params?: ReadonlyArray<unknown>) {
      const result = await pool.query(
        sql,
        params as unknown as Parameters<Cp0PublisherPoolLike['query']>[1],
      )
      // mysql2 returns [rows, fields]; preserve tuple shape when present.
      if (Array.isArray(result)) {
        return result as [unknown, unknown?]
      }
      return [result, undefined] as [unknown, unknown?]
    },
    async getConnection(): Promise<Cp0PublisherMysqlConnection> {
      const conn = await pool.getConnection()
      return {
        async query(sql: string, params?: ReadonlyArray<unknown>) {
          const result = await conn.query(
            sql,
            params as unknown as Parameters<Cp0PublisherPoolLike['query']>[1],
          )
          if (Array.isArray(result)) {
            return result as [unknown, unknown?]
          }
          return [result, undefined] as [unknown, unknown?]
        },
        release() {
          conn.release()
        },
      }
    },
  }
}

/**
 * Compose P2 deps from an injected MySQL client + P3C count sources.
 * Pure composition: no scheduler start, no global install.
 */
export function composeCp0PublisherRuntimeDeps(input: {
  client: Cp0PublisherMysqlClient & Cp0BacklogCountSqlClient
  nowMs?: () => number
  publisherId?: string
  lockTimeoutSec?: number
}): Cp0SyncStatusPublisherDeps {
  const mysqlDeps = createCp0SyncStatusPublisherMysqlDeps(input.client, {
    lockTimeoutSec: input.lockTimeoutSec,
  })
  const measurers = createCp0MysqlBacklogCountMeasurers(input.client)
  const measureDeps = createDefaultCp0SyncStatusMeasureDeps(measurers)
  return createCp0SyncStatusPublisherDeps({
    nowMs: input.nowMs ?? (() => Date.now()),
    acquirePublisherLock: mysqlDeps.acquirePublisherLock,
    readCanonicalPin: mysqlDeps.readCanonicalPin,
    loadExistingRow: mysqlDeps.loadExistingRow,
    casPublish: mysqlDeps.casPublish,
    measureDeps,
    publisherId: input.publisherId ?? CP0_PUBLISHER_RUNTIME_PUBLISHER_ID,
  })
}

// ---------------------------------------------------------------------------
// Loop / handle
// ---------------------------------------------------------------------------

export type Cp0PublisherRuntimeHandle = {
  /** Bounded drain: clear timers, await in-flight sweep ≤ tickTimeout+grace. */
  stop: () => Promise<void>
  isRunning: () => boolean
  getSnapshot: () => Cp0PublisherRuntimeSnapshot
  /** Test/ops: run one sweep immediately (respects no-overlap). */
  runOnce: () => Promise<void>
}

export type StartCp0PublisherLoopOptions = {
  config: Cp0PublisherRuntimeConfig
  /** Board tick runner; default runCp0SyncStatusPublisherTick. */
  runTick?: (
    boardId: string,
    deps: Cp0SyncStatusPublisherDeps,
  ) => Promise<Cp0SyncStatusPublishResult>
  deps: Cp0SyncStatusPublisherDeps
  nowMs?: () => number
  /** Uniform [0,1) RNG for jitter; inject for deterministic tests. */
  random?: () => number
  /** setTimeout / clearTimeout inject (fake timers). */
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  /** When false, do not unref timers (rare; default true). */
  unref?: boolean
  /** Immediate first tick (default true per design). */
  immediateFirstTick?: boolean
  /** Optional structured log sink (must not receive secrets). */
  logLine?: (line: string) => void
  /** Optional SIGTERM/SIGINT registration when true (default false for unit tests). */
  installSignalHandlers?: boolean
}

type MutableSnap = {
  phase: Cp0PublisherRuntimePhase
  lastTickStartedAt: string | null
  lastTickFinishedAt: string | null
  lastPublishAt: string | null
  lastPublishedBoardId: string | null
  lastDecision: Cp0PublisherDecision | null
  lastReasonCode: Cp0PublisherReasonCode | string | null
  lastEntityRev: number | null
  lastPin: Cp0PublisherRuntimePinSnap | null
  lastBoardId: string | null
  overlapSkipCount: number
  lockMissCount: number
  errorCount: number
  successCount: number
  boardTickCount: number
  sourcesReady: boolean | null
  lastErrorToken: string | null
}

function emptyMutableSnap(): MutableSnap {
  return {
    phase: 'idle',
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastPublishAt: null,
    lastPublishedBoardId: null,
    lastDecision: null,
    lastReasonCode: null,
    lastEntityRev: null,
    lastPin: null,
    lastBoardId: null,
    overlapSkipCount: 0,
    lockMissCount: 0,
    errorCount: 0,
    successCount: 0,
    boardTickCount: 0,
    sourcesReady: null,
    lastErrorToken: null,
  }
}

function toIso(ms: number): string {
  return new Date(ms).toISOString()
}

function withTimeout<T>(
  ms: number,
  work: () => Promise<T>,
  setTimeoutFn: typeof setTimeout,
  clearTimeoutFn: typeof clearTimeout,
): Promise<T> {
  if (!Number.isFinite(ms) || ms <= 0) return work()
  return new Promise<T>((resolve, reject) => {
    let settled = false
    const timer = setTimeoutFn(() => {
      if (settled) return
      settled = true
      reject(Object.assign(new Error('TickTimeoutError'), { name: 'TickTimeoutError' }))
    }, ms)
    void work()
      .then((v) => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        resolve(v)
      })
      .catch((err) => {
        if (settled) return
        settled = true
        clearTimeoutFn(timer)
        reject(err)
      })
  })
}

async function mapPool<T, R>(
  items: ReadonlyArray<T>,
  concurrency: number,
  worker: (item: T) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.min(concurrency, items.length || 1))
  const results: R[] = new Array(items.length)
  let next = 0
  async function pump(): Promise<void> {
    while (next < items.length) {
      const i = next
      next += 1
      results[i] = await worker(items[i]!)
    }
  }
  const pumps: Promise<void>[] = []
  for (let i = 0; i < limit; i++) pumps.push(pump())
  await Promise.all(pumps)
  return results
}

function nextDelayMs(
  intervalMs: number,
  jitterMs: number,
  random: () => number,
): number {
  if (jitterMs <= 0) return intervalMs
  const r = random()
  const unit = Number.isFinite(r) ? Math.min(1, Math.max(0, r)) : 0.5
  // Uniform in [-jitterMs, +jitterMs]
  const delta = Math.floor((unit * 2 - 1) * jitterMs)
  return Math.max(1, intervalMs + delta)
}

/**
 * Start one in-process CP0 publisher loop (no global install).
 * Caller must ensure process-singleton via ensure* when wiring production.
 *
 * Overlap policy: if a sweep is still running when the next timer fires,
 * SKIP_OVERLAP (metric only) — never queue unbounded.
 */
export function startCp0SyncStatusPublisherLoop(
  opts: StartCp0PublisherLoopOptions,
): Cp0PublisherRuntimeHandle {
  const config = opts.config
  const nowMs = opts.nowMs ?? (() => Date.now())
  const random = opts.random ?? Math.random
  const setTimeoutFn = opts.setTimeoutFn ?? setTimeout
  const clearTimeoutFn = opts.clearTimeoutFn ?? clearTimeout
  const runTick = opts.runTick ?? runCp0SyncStatusPublisherTick
  const immediateFirst = opts.immediateFirstTick !== false
  const unref = opts.unref !== false

  const snap = emptyMutableSnap()
  let running = true
  let phase: Cp0PublisherRuntimePhase = 'idle'
  let ticking = false
  let inFlight: Promise<void> | null = null
  let timer: ReturnType<typeof setTimeout> | null = null
  let signalInstalled = false

  const onSignal = () => {
    void stopInternal()
  }

  function snapshot(): Cp0PublisherRuntimeSnapshot {
    return {
      schemaVersion: CP0_PUBLISHER_RUNTIME_SCHEMA,
      publisherEnabled: config.enabled,
      publisherRunning: running && phase !== 'stopped' && phase !== 'disabled',
      disableReason: config.enabled ? null : config.disableReason,
      phase,
      boards: [...config.boards],
      intervalMs: config.intervalMs,
      jitterMs: config.jitterMs,
      tickTimeoutMs: config.tickTimeoutMs,
      maxConcurrency: config.maxConcurrency,
      lastTickStartedAt: snap.lastTickStartedAt,
      lastTickFinishedAt: snap.lastTickFinishedAt,
      lastPublishAt: snap.lastPublishAt,
      lastPublishedBoardId: snap.lastPublishedBoardId,
      lastDecision: snap.lastDecision,
      lastReasonCode: snap.lastReasonCode,
      lastEntityRev: snap.lastEntityRev,
      lastPin: snap.lastPin,
      lastBoardId: snap.lastBoardId,
      overlapSkipCount: snap.overlapSkipCount,
      lockMissCount: snap.lockMissCount,
      errorCount: snap.errorCount,
      successCount: snap.successCount,
      boardTickCount: snap.boardTickCount,
      sourcesReady: snap.sourcesReady,
      lastErrorToken: snap.lastErrorToken,
    }
  }

  function clearTimer(): void {
    if (timer != null) {
      clearTimeoutFn(timer)
      timer = null
    }
  }

  function scheduleNext(): void {
    if (!running || phase === 'stopped' || phase === 'draining') return
    clearTimer()
    const delay = nextDelayMs(config.intervalMs, config.jitterMs, random)
    timer = setTimeoutFn(() => {
      timer = null
      void sweep('interval')
    }, delay)
    if (
      unref &&
      timer != null &&
      typeof (timer as { unref?: () => void }).unref === 'function'
    ) {
      ;(timer as { unref: () => void }).unref()
    }
  }

  async function tickOneBoard(boardId: string): Promise<void> {
    snap.boardTickCount += 1
    snap.lastBoardId = boardId
    try {
      const result = await withTimeout(
        config.tickTimeoutMs,
        () => runTick(boardId, opts.deps),
        setTimeoutFn,
        clearTimeoutFn,
      )
      recordResult(boardId, result)
    } catch (err) {
      snap.errorCount += 1
      snap.lastErrorToken = sanitizeCp0PublisherRuntimeError(err)
      snap.lastDecision = 'SKIP_ERROR'
      snap.lastReasonCode = 'PUBLISHER_ERROR'
      opts.logLine?.(
        JSON.stringify({
          kind: 'cp0_sync_publish_error',
          boardId,
          error: snap.lastErrorToken,
        }),
      )
    }
  }

  function recordResult(boardId: string, result: Cp0SyncStatusPublishResult): void {
    snap.lastDecision = result.decision
    snap.lastReasonCode = result.reasonCode
    if (result.decision === 'SKIP_LOCK_NOT_ACQUIRED') {
      snap.lockMissCount += 1
    }
    if (result.decision === 'SKIP_ERROR') {
      snap.errorCount += 1
      snap.lastErrorToken = sanitizePublisherReason(result.reason, 'PUBLISHER_ERROR')
    }
    if (result.published) {
      snap.successCount += 1
      snap.lastPublishAt = toIso(nowMs())
      snap.lastPublishedBoardId = boardId
      if (result.candidate) {
        snap.lastEntityRev = result.candidate.nextEntityRev
        snap.lastPin = {
          boardRev: result.candidate.board_rev,
          lifecycleRev: result.candidate.lifecycle_rev,
          canonicalHash: result.candidate.canonical_hash,
        }
      }
    } else if (result.candidate?.pinStable) {
      snap.lastPin = {
        boardRev: result.candidate.board_rev,
        lifecycleRev: result.candidate.lifecycle_rev,
        canonicalHash: result.candidate.canonical_hash,
      }
      snap.lastEntityRev = result.candidate.nextEntityRev
    }
    // sourcesReady: true only when dual proven on this board; false when unproven; null unknown
    if (result.combined) {
      if (result.combined.countsProven) {
        snap.sourcesReady = true
      } else if (
        result.combined.outbox.reasonCode === 'SOURCE_UNAVAILABLE' ||
        result.combined.legacy.reasonCode === 'SOURCE_UNAVAILABLE'
      ) {
        snap.sourcesReady = false
      } else if (snap.sourcesReady == null) {
        snap.sourcesReady = false
      }
    }
    opts.logLine?.(
      JSON.stringify({
        kind: result.published
          ? 'cp0_sync_publish_success'
          : result.decision === 'SKIP_LOCK_NOT_ACQUIRED'
            ? 'cp0_sync_publish_skip_lock'
            : result.decision === 'SKIP_ERROR'
              ? 'cp0_sync_publish_error'
              : 'cp0_sync_publish_skip',
        boardId,
        decision: result.decision,
        reasonCode: result.reasonCode,
        published: result.published,
        // Never include raw driver messages, SQL, or credentials.
      }),
    )
  }

  async function sweep(_cause: 'interval' | 'immediate' | 'manual'): Promise<void> {
    if (!running || phase === 'stopped' || phase === 'draining') return
    if (ticking) {
      snap.overlapSkipCount += 1
      opts.logLine?.(
        JSON.stringify({
          kind: 'cp0_sync_publish_skip_overlap',
          overlapSkipCount: snap.overlapSkipCount,
        }),
      )
      return
    }
    ticking = true
    phase = 'ticking'
    snap.phase = phase
    const started = nowMs()
    snap.lastTickStartedAt = toIso(started)

    const work = (async () => {
      try {
        await mapPool(
          config.boards,
          config.maxConcurrency,
          (boardId) => tickOneBoard(boardId),
        )
      } finally {
        const finished = nowMs()
        snap.lastTickFinishedAt = toIso(finished)
        ticking = false
        if (running && phase === 'ticking') {
          phase = 'idle'
          snap.phase = phase
        }
      }
    })()

    inFlight = work
    try {
      await work
    } finally {
      if (inFlight === work) inFlight = null
      // After a completed sweep: scheduleNext self-guards on stopped/draining.
      // (Do not compare phase here — TS control-flow pins 'ticking' across await.)
      if (running) {
        scheduleNext()
      }
    }
  }

  async function stopInternal(): Promise<void> {
    if (phase === 'stopped') return
    running = false
    phase = 'draining'
    snap.phase = phase
    clearTimer()
    if (signalInstalled && typeof process !== 'undefined' && process.off) {
      process.off('SIGTERM', onSignal)
      process.off('SIGINT', onSignal)
      signalInstalled = false
    }
    const pending = inFlight
    if (pending) {
      const cap = config.tickTimeoutMs + CP0_PUBLISHER_DRAIN_GRACE_MS
      try {
        await withTimeout(cap, () => pending, setTimeoutFn, clearTimeoutFn)
      } catch {
        /* bounded drain — do not hang shutdown */
      }
    }
    phase = 'stopped'
    snap.phase = phase
  }

  // Disabled config: return inert handle (no timers).
  if (!config.enabled || config.boards.length === 0) {
    phase = 'disabled'
    snap.phase = phase
    running = false
    return {
      stop: async () => {
        phase = 'stopped'
        snap.phase = phase
      },
      isRunning: () => false,
      getSnapshot: snapshot,
      runOnce: async () => {
        /* no-op when disabled */
      },
    }
  }

  if (opts.installSignalHandlers && typeof process !== 'undefined' && process.once) {
    process.once('SIGTERM', onSignal)
    process.once('SIGINT', onSignal)
    signalInstalled = true
  }

  phase = 'idle'
  snap.phase = phase

  if (immediateFirst) {
    // Immediate first tick (setTimeout 0 / void tick) — do not wait full interval.
    timer = setTimeoutFn(() => {
      timer = null
      void sweep('immediate')
    }, 0)
    if (
      unref &&
      timer != null &&
      typeof (timer as { unref?: () => void }).unref === 'function'
    ) {
      ;(timer as { unref: () => void }).unref()
    }
  } else {
    scheduleNext()
  }

  return {
    stop: stopInternal,
    isRunning: () => running && phase !== 'stopped' && phase !== 'disabled',
    getSnapshot: snapshot,
    runOnce: async () => {
      await sweep('manual')
    },
  }
}

// ---------------------------------------------------------------------------
// Process singleton (HMR-safe once-start)
// ---------------------------------------------------------------------------

type RuntimeHolder = {
  handle: Cp0PublisherRuntimeHandle | null
  /** Last disable reason observed when ensure refused to start. */
  lastDisableReason: Cp0PublisherDisableReason | null
  /** Last snapshot when disabled (for getSnapshot without handle). */
  disabledSnapshot: Cp0PublisherRuntimeSnapshot | null
}

type GlobalWithRuntime = typeof globalThis & {
  [CP0_PUBLISHER_RUNTIME_SYMBOL]?: RuntimeHolder
}

function getRuntimeHolder(): RuntimeHolder {
  const g = globalThis as GlobalWithRuntime
  let holder = g[CP0_PUBLISHER_RUNTIME_SYMBOL]
  if (!holder) {
    holder = {
      handle: null,
      lastDisableReason: 'NOT_STARTED',
      disabledSnapshot: null,
    }
    g[CP0_PUBLISHER_RUNTIME_SYMBOL] = holder
  }
  return holder
}

function disabledSnapshotFromConfig(
  config: Cp0PublisherRuntimeConfig,
): Cp0PublisherRuntimeSnapshot {
  return {
    schemaVersion: CP0_PUBLISHER_RUNTIME_SCHEMA,
    publisherEnabled: false,
    publisherRunning: false,
    disableReason: config.disableReason ?? 'ENV_OFF',
    phase: 'disabled',
    boards: [...config.boards],
    intervalMs: config.intervalMs,
    jitterMs: config.jitterMs,
    tickTimeoutMs: config.tickTimeoutMs,
    maxConcurrency: config.maxConcurrency,
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastPublishAt: null,
    lastPublishedBoardId: null,
    lastDecision: null,
    lastReasonCode: null,
    lastEntityRev: null,
    lastPin: null,
    lastBoardId: null,
    overlapSkipCount: 0,
    lockMissCount: 0,
    errorCount: 0,
    successCount: 0,
    boardTickCount: 0,
    sourcesReady: null,
    lastErrorToken: null,
  }
}

export type EnsureCp0PublisherRuntimeOptions = {
  env?: NodeJS.ProcessEnv
  /**
   * Injected deps (tests). When omitted and enabled, builds from poolFactory.
   */
  deps?: Cp0SyncStatusPublisherDeps
  /**
   * Pool factory (production). Called only when enabled and deps not injected.
   * Default: db() — never at module load; only when env enables start.
   */
  poolFactory?: () => Cp0PublisherPoolLike
  nowMs?: () => number
  random?: () => number
  setTimeoutFn?: typeof setTimeout
  clearTimeoutFn?: typeof clearTimeout
  runTick?: StartCp0PublisherLoopOptions['runTick']
  unref?: boolean
  immediateFirstTick?: boolean
  logLine?: (line: string) => void
  installSignalHandlers?: boolean
  /**
   * When false, do not start even if env ON (unit tests / memory context).
   * Default true — still fail-closed on env OFF / empty boards / prod gate.
   */
  autoStart?: boolean
}

/**
 * Ensure at most one process-wide CP0 publisher loop.
 * - Env OFF / empty boards / production gate → null handle, no timer.
 * - Second call returns existing handle (no double-start; HMR-safe).
 * - Import alone never starts anything.
 */
export function ensureCp0SyncStatusPublisherRuntime(
  opts: EnsureCp0PublisherRuntimeOptions = {},
): Cp0PublisherRuntimeHandle | null {
  const holder = getRuntimeHolder()
  if (holder.handle && holder.handle.isRunning()) {
    return holder.handle
  }
  // Stale stopped handle: clear so a re-ensure can start again (tests / restart).
  if (holder.handle && !holder.handle.isRunning()) {
    holder.handle = null
  }

  if (opts.autoStart === false) {
    const config = parseCp0PublisherRuntimeConfig(opts.env ?? process.env)
    holder.lastDisableReason = 'NOT_STARTED'
    holder.disabledSnapshot = disabledSnapshotFromConfig({
      ...config,
      enabled: false,
      disableReason: 'NOT_STARTED',
    })
    return null
  }

  const env = opts.env ?? process.env
  const config = parseCp0PublisherRuntimeConfig(env)

  if (!config.enabled) {
    holder.lastDisableReason = config.disableReason
    holder.disabledSnapshot = disabledSnapshotFromConfig(config)
    opts.logLine?.(
      JSON.stringify({
        kind: 'cp0_sync_publish_disabled',
        reason: config.disableReason,
        // boards length only — ids listed only when non-secret allowlist intentional
        boardCount: config.boards.length,
      }),
    )
    return null
  }

  let deps = opts.deps
  if (!deps) {
    // Default: shared process pool via db() — only reached when env enabled.
    // Import of db has no open-pool side effect; db() is lazy. Credentials
    // never copied onto the runtime handle or snapshot.
    const poolFactory =
      opts.poolFactory ?? (() => db() as unknown as Cp0PublisherPoolLike)
    const client = wrapPoolAsCp0PublisherMysqlClient(poolFactory())
    deps = composeCp0PublisherRuntimeDeps({
      client,
      nowMs: opts.nowMs,
      publisherId: CP0_PUBLISHER_RUNTIME_PUBLISHER_ID,
    })
  }

  const handle = startCp0SyncStatusPublisherLoop({
    config,
    deps,
    nowMs: opts.nowMs,
    random: opts.random,
    setTimeoutFn: opts.setTimeoutFn,
    clearTimeoutFn: opts.clearTimeoutFn,
    runTick: opts.runTick,
    unref: opts.unref,
    immediateFirstTick: opts.immediateFirstTick,
    logLine: opts.logLine,
    // Production path may install best-effort SIGTERM drain; tests default off.
    installSignalHandlers: opts.installSignalHandlers === true,
  })

  holder.handle = handle
  holder.lastDisableReason = null
  holder.disabledSnapshot = null
  return handle
}

/** Peek without starting. */
export function peekCp0SyncStatusPublisherRuntime(): Cp0PublisherRuntimeHandle | null {
  const holder = getRuntimeHolder()
  return holder.handle
}

/** Snapshot for ops/tests; never throws; never includes secrets. */
export function getCp0PublisherRuntimeSnapshot(): Cp0PublisherRuntimeSnapshot {
  const holder = getRuntimeHolder()
  if (holder.handle) return holder.handle.getSnapshot()
  if (holder.disabledSnapshot) return holder.disabledSnapshot
  return {
    schemaVersion: CP0_PUBLISHER_RUNTIME_SCHEMA,
    publisherEnabled: false,
    publisherRunning: false,
    disableReason: holder.lastDisableReason ?? 'NOT_STARTED',
    phase: 'disabled',
    boards: [],
    intervalMs: CP0_PUBLISHER_DEFAULT_PUBLISH_INTERVAL_MS,
    jitterMs: CP0_PUBLISHER_JITTER_MS_DEFAULT,
    tickTimeoutMs: CP0_PUBLISHER_TICK_TIMEOUT_MS_DEFAULT,
    maxConcurrency: CP0_PUBLISHER_MAX_CONCURRENCY_DEFAULT,
    lastTickStartedAt: null,
    lastTickFinishedAt: null,
    lastPublishAt: null,
    lastPublishedBoardId: null,
    lastDecision: null,
    lastReasonCode: null,
    lastEntityRev: null,
    lastPin: null,
    lastBoardId: null,
    overlapSkipCount: 0,
    lockMissCount: 0,
    errorCount: 0,
    successCount: 0,
    boardTickCount: 0,
    sourcesReady: null,
    lastErrorToken: null,
  }
}

/**
 * Test/process cleanup: stop loop and clear holder.
 * Does NOT close the shared db pool.
 */
export async function stopCp0SyncStatusPublisherRuntimeForTests(): Promise<void> {
  const holder = getRuntimeHolder()
  const h = holder.handle
  holder.handle = null
  holder.lastDisableReason = 'STOPPED'
  holder.disabledSnapshot = null
  if (h) {
    await h.stop()
  }
}

/**
 * Attach helper for control-plane runtime context (and other server composition).
 * Default OFF: returns null unless env enables and autoStart is true.
 * Standalone — safe to call when context wire is blocked by dirt.
 */
export function attachCp0SyncStatusPublisherRuntime(
  opts: EnsureCp0PublisherRuntimeOptions = {},
): Cp0PublisherRuntimeHandle | null {
  return ensureCp0SyncStatusPublisherRuntime(opts)
}

/**
 * Warm helper for authenticated server paths (healthz / MCP).
 * Best-effort: never throws into request path; never starts when env OFF.
 */
export function warmCp0SyncStatusPublisherRuntime(
  opts: EnsureCp0PublisherRuntimeOptions = {},
): void {
  try {
    ensureCp0SyncStatusPublisherRuntime(opts)
  } catch {
    /* fail closed — publisher warm must not break health/MCP */
  }
}
