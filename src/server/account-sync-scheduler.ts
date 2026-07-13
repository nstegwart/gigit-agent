/**
 * Deterministic account-sync SLA trigger scheduler + multi-surface publication
 * coordinator (AC-ACCOUNT-01..07 foundation).
 *
 * - Pull-based: callers invoke enqueue()/tick() with an injectable clock.
 * - Runtime attaches one safe unref setInterval loop per context via
 *   startAccountSyncSchedulerLoop() (cleanup/stop + test clock compatible).
 * - Default production surface publisher: four product consumer service paths
 *   (MCP list_accounts, authenticated API JSON, UI account source, Ops account source)
 *   — each reloads + projects via real serializers (not makeReader identical-store).
 * - Autonomous loop: mandatory onError + onFatalError; production marks
 *   ACCOUNT_SYNC_STALE + alert; secondary failure → ACCOUNT_SYNC_LOOP_FATAL.
 *
 * - Immediate publish: launch / material / status / LIMIT/BAN/403 / AUTH_EXPIRED /
 *   rotation / requeue / integration / wave close / periodic health
 * - HEARTBEAT: coalesce to newest; must publish within ACCOUNT_PUBLISH_SLA_MS (30s)
 * - Periodic health: auto-intent at least every ACCOUNT_PERIODIC_HEALTH_MS (60s)
 * - Surfaces MCP/API/UI/Ops must read back exact sourceRevision+generatedAt;
 *   miss/stale → evaluateAccountSyncFreshness → usableCapacity=0 + ACCOUNT_SYNC_STALE
 * - No secrets/tokens; never --accounts all; tombstone capacity via account-sync policy
 */
import type { ControlPlaneAtomicStore, ControlPlaneClock } from './board-store'
import type { IdempotencyStorage } from './idempotency'
import {
  ACCOUNT_PERIODIC_HEALTH_MS,
  ACCOUNT_PUBLISH_SLA_MS,
  ACCOUNT_SYNC_READBACK_SURFACES,
  AccountSyncError,
  evaluateAccountSyncFreshness,
  evaluateCapacityPolicy,
  isCoalescableAccountSyncTrigger,
  recordAccountReadback,
  surfacesHaveParity,
  syncAccounts,
  type AccountSyncDeps,
  type AccountSyncReadbackSurface,
  type AccountSyncSnapshot,
  type AccountSyncStore,
  type AccountSyncTrigger,
  type MaskedAccountRecord,
  type MaskedAccountStatus,
  type SyncAccountsRequest,
  type SyncAccountsResult,
} from './account-sync'
import {
  createProductAccountSyncSurfaceReaders,
  type AccountSurfaceSchema,
} from './account-surface-readers'
import { buildStructuredLog, type MetricsRegistry } from './observability'

// Re-export SLA constants + surface helpers for scheduler consumers.
export {
  ACCOUNT_PERIODIC_HEALTH_MS,
  ACCOUNT_PUBLISH_SLA_MS,
  ACCOUNT_SYNC_READBACK_SURFACES,
  isCoalescableAccountSyncTrigger,
  isImmediateAccountSyncTrigger,
  surfacesHaveParity,
} from './account-sync'
export type { AccountSyncReadbackSurface, AccountSyncTrigger } from './account-sync'

/** Intent queued for authority sync + multi-surface publication. */
export interface AccountSyncPublishIntent {
  boardId: string
  sourceRevision: number
  generatedAt: string
  /** Create=0 / update=current snapshot entityRev. */
  entityExpectedRev: number
  expectedBoardRev: number
  canonicalHash: string
  currentPinHash?: string | null
  accounts: SyncAccountsRequest['accounts']
  trigger: AccountSyncTrigger
  idempotencyKey: string
  callerRole: SyncAccountsRequest['callerRole']
  actorId?: string
  health?: SyncAccountsRequest['health']
  genuineReadyPacketCount?: number
  /** Forbidden; always rejected when true. */
  accountsAllFlag?: boolean
}

export interface AccountSyncSurfacePublishEnvelope {
  boardId: string
  sourceRevision: number
  generatedAt: string
  trigger: AccountSyncTrigger
  accounts: ReadonlyArray<MaskedAccountRecord>
  usableCapacity: number
  stale: boolean
  capacity: SyncAccountsResult['capacity']
}

/**
 * Injectable multi-surface publisher (MCP / API / UI / Ops).
 * Runtime wires real transports; unit tests inject memory publishers.
 * Must never carry secrets/tokens/raw identity — masked fields only.
 */
export interface AccountSyncSurfacePublisher {
  publish(
    surface: AccountSyncReadbackSurface,
    envelope: AccountSyncSurfacePublishEnvelope,
  ): Promise<{ sourceRevision: number; generatedAt: string }>
}

/**
 * Independent per-surface reader of the authoritative durable account snapshot.
 * Production adapters invoke real product service paths (MCP/API/UI/Ops serializers),
 * not a shared makeReader(_surface) store echo. All four must observe same identity.
 */
export interface AccountSyncSurfaceReader {
  readAuthoritativeIdentity(
    boardId: string,
  ): Promise<{
    sourceRevision: number
    generatedAt: string
    schema?: AccountSurfaceSchema | string
  } | null>
}

/** Required MCP/API/UI/Ops independent readers — construction fails if any absent. */
export type AccountSyncSurfaceReaders = Record<
  AccountSyncReadbackSurface,
  AccountSyncSurfaceReader
>

/** Alert/audit event emitted when the autonomous tick loop rejects (primary path). */
export interface AccountSyncLoopAlertEvent {
  kind: 'ACCOUNT_SYNC_LOOP_TICK_REJECTED'
  error: unknown
  boardIds: Array<string>
  atMs: number
  reason: 'ACCOUNT_SYNC_LOOP_TICK_REJECTED'
}

/**
 * Secondary / durable fatal when primary onError (failClosed) itself rejects,
 * or when the secondary handler is invoked after primary failure.
 * Emitted via control-data audit / structured log / metric path.
 */
export interface AccountSyncLoopFatalEvent {
  kind: 'ACCOUNT_SYNC_LOOP_FATAL'
  error: unknown
  /** Original tick rejection when known. */
  primaryError?: unknown
  boardIds: Array<string>
  atMs: number
  reason: 'ACCOUNT_SYNC_LOOP_FATAL'
  phase: 'PRIMARY_ON_ERROR' | 'SECONDARY_ON_FATAL' | 'TERTIARY_SINK'
}

/** Injectable authority write (defaults to syncAccounts). */
export type AccountSyncAuthorityPublisher = (
  req: SyncAccountsRequest,
) => Promise<SyncAccountsResult>

export interface AccountSyncSchedulerDeps {
  clock: ControlPlaneClock
  /** Store + atomic + idempotency used by default authority path and freshness. */
  accountSync: AccountSyncDeps
  /**
   * Optional authority publisher override (runtime wiring / tests).
   * Defaults to syncAccounts(accountSync, req).
   */
  authorityPublisher?: AccountSyncAuthorityPublisher
  /** Required surface fan-out. */
  surfacePublisher: AccountSyncSurfacePublisher
  /**
   * Boards watched for auto periodic health when no enqueue arrives.
   * Defaults to boards that have published at least once through this scheduler.
   */
  watchedBoards?: ReadonlyArray<string>
}

export type AccountSyncPublishKind =
  | 'PUBLISHED'
  | 'COALESCED'
  | 'SKIPPED'
  | 'STALE_FAIL_CLOSED'

export interface AccountSyncPublishOutcome {
  kind: AccountSyncPublishKind
  trigger: AccountSyncTrigger
  boardId: string
  result?: SyncAccountsResult
  surfaces?: Record<
    AccountSyncReadbackSurface,
    { sourceRevision: number; generatedAt: string } | null
  >
  parityOk?: boolean
  stale?: boolean
  staleReason?: string | null
  usableCapacity?: number
  coalescedCount?: number
  publishedAtMs?: number
  deadlineMs?: number | null
}

export interface AccountSyncTickResult {
  published: Array<AccountSyncPublishOutcome>
  freshness: Array<AccountSyncSnapshot | null>
  pendingHeartbeats: number
  nowMs: number
}

export interface AccountSyncSchedulerBoardState {
  lastPublishedAtMs: number | null
  lastPeriodicHealthAtMs: number | null
  lastIntent: AccountSyncPublishIntent | null
  lastIdentity: { sourceRevision: number; generatedAt: string } | null
  pendingHeartbeat: AccountSyncPublishIntent | null
  pendingHeartbeatFirstAtMs: number | null
  pendingHeartbeatDeadlineMs: number | null
  coalescedHeartbeatCount: number
  publishCount: number
}

export interface AccountSyncScheduler {
  /** Queue a trigger. HEARTBEAT may coalesce; all others publish immediately. */
  enqueue(intent: AccountSyncPublishIntent): Promise<AccountSyncPublishOutcome>
  /**
   * Deterministic step: flush due coalesced heartbeats, run periodic health
   * for watched boards, evaluate publication SLA / fail-closed.
   */
  tick(): Promise<AccountSyncTickResult>
  /** Force-publish any pending heartbeat for board (or all boards). */
  flush(boardId?: string): Promise<Array<AccountSyncPublishOutcome>>
  /** Inspect per-board scheduler state (test/ops). */
  getBoardState(boardId: string): AccountSyncSchedulerBoardState
  /** Boards known to the scheduler. */
  listBoards(): Array<string>
  /** Snapshot of all board states. */
  snapshot(): Record<string, AccountSyncSchedulerBoardState>
  /**
   * Force ACCOUNT_SYNC_STALE + usableCapacity=0 after a visible typed failure
   * (notify path / surface publish). Never silent.
   */
  failClosedStale(
    boardId: string,
    reason: string,
  ): Promise<AccountSyncSnapshot | null>
}

/** Handle for the unref timer loop started per runtime context. */
export interface AccountSyncSchedulerLoopHandle {
  /** Clear the timer; idempotent. */
  stop(): void
  isRunning(): boolean
  /** Interval used (ms). */
  intervalMs: number
}

/** Default autonomous tick interval (coarser than SLA; tick itself enforces 30s/60s). */
export const ACCOUNT_SYNC_SCHEDULER_LOOP_MS = 5_000

/**
 * Process-shared surface readback identity store (MCP/API/UI/Ops).
 * Not a throwaway echo — any surface can read back the exact last published
 * sourceRevision+generatedAt for a board.
 */
const SHARED_SURFACE_READBACK = new Map<
  string,
  Record<
    AccountSyncReadbackSurface,
    { sourceRevision: number; generatedAt: string; publishedAtMs: number } | null
  >
>()

function emptySharedSurfaces(): Record<
  AccountSyncReadbackSurface,
  { sourceRevision: number; generatedAt: string; publishedAtMs: number } | null
> {
  return { mcp: null, api: null, ui: null, ops: null }
}

/** Read process-shared surface identity (null when never published). */
export function readSharedAccountSyncSurface(
  boardId: string,
  surface: AccountSyncReadbackSurface,
): { sourceRevision: number; generatedAt: string; publishedAtMs: number } | null {
  return SHARED_SURFACE_READBACK.get(boardId)?.[surface] ?? null
}

/** Snapshot all shared surfaces for a board (test/ops). */
export function snapshotSharedAccountSyncSurfaces(
  boardId: string,
): Record<
  AccountSyncReadbackSurface,
  { sourceRevision: number; generatedAt: string; publishedAtMs: number } | null
> {
  const cur = SHARED_SURFACE_READBACK.get(boardId)
  return cur ? { ...cur } : emptySharedSurfaces()
}

/** Test-only: clear process-shared surface map. */
export function resetSharedAccountSyncSurfacesForTests(): void {
  SHARED_SURFACE_READBACK.clear()
}

/**
 * Build four product consumer surface readers from an AccountSyncStore.
 * Replaces the identical-store makeReader(_surface) abstraction: each surface
 * invokes its real MCP/API/UI/Ops service path (load + serializer + schema).
 */
export function createDurableAccountSyncSurfaceReaders(
  accounts: AccountSyncStore,
): AccountSyncSurfaceReaders {
  if (!accounts || typeof accounts.get !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'createDurableAccountSyncSurfaceReaders requires AccountSyncStore',
    )
  }
  // Product service paths — four distinct reader objects, real projections.
  const product = createProductAccountSyncSurfaceReaders(accounts)
  return {
    mcp: product.mcp,
    api: product.api,
    ui: product.ui,
    ops: product.ops,
  }
}

/**
 * Assert all four independent readers are present; throw fail-closed otherwise.
 * Production construction must call this (or createIndependent… which does).
 */
export function assertAccountSyncSurfaceReadersComplete(
  readers: Partial<AccountSyncSurfaceReaders> | null | undefined,
): asserts readers is AccountSyncSurfaceReaders {
  if (!readers || typeof readers !== 'object') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'account sync surface readers missing (mcp/api/ui/ops required)',
    )
  }
  for (const surface of ACCOUNT_SYNC_READBACK_SURFACES) {
    const r = readers[surface]
    if (!r || typeof r.readAuthoritativeIdentity !== 'function') {
      throw new AccountSyncError(
        'INVALID_INPUT',
        `account sync surface reader absent or invalid for ${surface}`,
        { surface },
      )
    }
  }
}

/**
 * Independent multi-surface publisher: each surface reloads the authoritative
 * durable account snapshot via its own reader and returns that identity.
 * Never label-echoes envelope.sourceRevision/generatedAt without a reload.
 * Construction fails closed if any of the four readers is absent.
 */
export function createIndependentAccountSyncSurfacePublisher(opts: {
  readers: AccountSyncSurfaceReaders
  /**
   * When true (default), observed identity must match the publish envelope
   * (same sourceRevision + generatedAt). Mismatch → typed DATA_INTEGRITY.
   */
  requireEnvelopeMatch?: boolean
  /** Optional process-shared side channel for ops/tests. */
  recordShared?: boolean
  nowMs?: () => number
  log?: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
}): AccountSyncSurfacePublisher & {
  log: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
  readers: AccountSyncSurfaceReaders
} {
  assertAccountSyncSurfaceReadersComplete(opts.readers)
  // Defensive copy of reader refs so callers cannot drop a surface later.
  const readers: AccountSyncSurfaceReaders = {
    mcp: opts.readers.mcp,
    api: opts.readers.api,
    ui: opts.readers.ui,
    ops: opts.readers.ops,
  }
  const requireMatch = opts.requireEnvelopeMatch !== false
  const recordShared = opts.recordShared !== false
  const log =
    opts.log ??
    ([] as Array<{
      surface: AccountSyncReadbackSurface
      envelope: AccountSyncSurfacePublishEnvelope
    }>)
  return {
    log,
    readers,
    async publish(surface, envelope) {
      const reader = readers[surface]
      if (!reader || typeof reader.readAuthoritativeIdentity !== 'function') {
        throw new AccountSyncError(
          'INVALID_INPUT',
          `account sync surface reader absent for ${surface}`,
          { surface },
        )
      }
      log.push({
        surface,
        envelope: { ...envelope, accounts: envelope.accounts.map((a) => ({ ...a })) },
      })
      const observed = await reader.readAuthoritativeIdentity(envelope.boardId)
      if (!observed) {
        throw new AccountSyncError(
          'DATA_INTEGRITY',
          `surface ${surface} independent read returned no durable account snapshot`,
          { surface, boardId: envelope.boardId },
        )
      }
      if (
        requireMatch &&
        (observed.sourceRevision !== envelope.sourceRevision ||
          observed.generatedAt !== envelope.generatedAt)
      ) {
        throw new AccountSyncError(
          'DATA_INTEGRITY',
          `surface ${surface} independent read identity mismatch vs publish envelope`,
          {
            surface,
            boardId: envelope.boardId,
            observed,
            envelope: {
              sourceRevision: envelope.sourceRevision,
              generatedAt: envelope.generatedAt,
            },
          },
        )
      }
      if (recordShared) {
        const publishedAtMs = opts.nowMs?.() ?? Date.now()
        let board = SHARED_SURFACE_READBACK.get(envelope.boardId)
        if (!board) {
          board = emptySharedSurfaces()
          SHARED_SURFACE_READBACK.set(envelope.boardId, board)
        }
        board[surface] = {
          sourceRevision: observed.sourceRevision,
          generatedAt: observed.generatedAt,
          publishedAtMs,
        }
      }
      return {
        sourceRevision: observed.sourceRevision,
        generatedAt: observed.generatedAt,
      }
    },
  }
}

/**
 * Production default surface publisher: four independent durable readers over
 * the authoritative AccountSyncStore (not process Map label-echo).
 */
export function createSharedDurableAccountSyncSurfacePublisher(opts: {
  accounts: AccountSyncStore
  nowMs?: () => number
  log?: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
  requireEnvelopeMatch?: boolean
}): AccountSyncSurfacePublisher & {
  log: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
  readers: AccountSyncSurfaceReaders
} {
  if (!opts?.accounts) {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'createSharedDurableAccountSyncSurfacePublisher requires accounts store (no label-echo default)',
    )
  }
  return createIndependentAccountSyncSurfacePublisher({
    readers: createDurableAccountSyncSurfaceReaders(opts.accounts),
    nowMs: opts.nowMs,
    log: opts.log,
    requireEnvelopeMatch: opts.requireEnvelopeMatch,
    recordShared: true,
  })
}

/**
 * Process-local durable sink for ACCOUNT_SYNC_LOOP_FATAL (log + metric + audit buffer).
 * Used when primary onError rejects and/or secondary onFatalError rejects.
 * Never an empty catch(() => {}) — always records a structured event.
 */
const ACCOUNT_SYNC_LOOP_FATAL_SINK: Array<{
  atMs: number
  event: AccountSyncLoopFatalEvent
  structured: ReturnType<typeof buildStructuredLog>
}> = []

/** Test/ops: drain fatal sink (does not clear process metrics). */
export function drainAccountSyncLoopFatalSinkForTests(): Array<{
  atMs: number
  event: AccountSyncLoopFatalEvent
  structured: ReturnType<typeof buildStructuredLog>
}> {
  const out = [...ACCOUNT_SYNC_LOOP_FATAL_SINK]
  ACCOUNT_SYNC_LOOP_FATAL_SINK.length = 0
  return out
}

export function peekAccountSyncLoopFatalSink(): ReadonlyArray<{
  atMs: number
  event: AccountSyncLoopFatalEvent
  structured: ReturnType<typeof buildStructuredLog>
}> {
  return ACCOUNT_SYNC_LOOP_FATAL_SINK
}

/** Metric labels for ACCOUNT_SYNC_LOOP_FATAL (api_error_rate). */
export const ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS = {
  endpoint: 'account-sync-scheduler',
  event: 'ACCOUNT_SYNC_LOOP_FATAL',
} as const

/**
 * Emit structured ACCOUNT_SYNC_LOOP_FATAL through log + metric + in-process audit buffer.
 * Optional control-data appendAudit when provided (runtime wiring).
 * Optional MetricsRegistry increments api_error_rate with scheduler fatal labels.
 * Capacity fail-closed is the caller's duty (primary handler / keep boards stale).
 */
export function emitAccountSyncLoopFatal(
  event: AccountSyncLoopFatalEvent,
  opts?: {
    appendAudit?: (entry: Record<string, unknown>) => void | Promise<void>
    logLine?: (line: string) => void
    /** Runtime-injected metrics registry (failure counter). */
    metrics?: MetricsRegistry
  },
): AccountSyncLoopFatalEvent {
  const structured = buildStructuredLog({
    requestId: `account-sync-loop-fatal:${event.atMs}`,
    endpoint: 'account-sync-scheduler-loop',
    event: 'ACCOUNT_SYNC_LOOP_FATAL',
    result: 'error',
    errorCode: 'ACCOUNT_SYNC_LOOP_FATAL',
    boardId: event.boardIds[0] ?? null,
    meta: {
      kind: event.kind,
      reason: event.reason,
      phase: event.phase,
      boardIds: event.boardIds.join(','),
      primaryError:
        event.primaryError instanceof Error
          ? event.primaryError.message
          : event.primaryError != null
            ? String(event.primaryError)
            : null,
      error:
        event.error instanceof Error ? event.error.message : String(event.error),
    },
  })
  ACCOUNT_SYNC_LOOP_FATAL_SINK.push({ atMs: event.atMs, event, structured })
  const line = JSON.stringify(structured)
  if (opts?.logLine) {
    opts.logLine(line)
  } else if (typeof console !== 'undefined' && typeof console.error === 'function') {
    console.error(line)
  }
  // Semantically valid failure metric — never silent on FATAL emission.
  if (opts?.metrics) {
    opts.metrics.increment('api_error_rate', 1, {
      endpoint: ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.endpoint,
      event: ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.event,
      phase: event.phase,
    })
  }
  if (opts?.appendAudit) {
    void Promise.resolve(
      opts.appendAudit({
        kind: 'ACCOUNT_SYNC_LOOP_FATAL',
        reason: event.reason,
        phase: event.phase,
        // boardId required by control-data bindImportAuditEntry (fail-closed without it).
        boardId: event.boardIds[0] ?? 'account-sync-scheduler',
        boardIds: event.boardIds,
        atMs: event.atMs,
        errorCode: 'ACCOUNT_SYNC_LOOP_FATAL',
        event: 'ACCOUNT_SYNC_LOOP_FATAL',
      }),
    ).catch((auditErr) => {
      // Audit path failure still records to sink — never empty swallow of the FATAL itself.
      ACCOUNT_SYNC_LOOP_FATAL_SINK.push({
        atMs: Date.now(),
        event: {
          ...event,
          phase: 'TERTIARY_SINK',
          error: auditErr,
          primaryError: event.error,
        },
        structured: buildStructuredLog({
          requestId: `account-sync-loop-fatal-audit:${Date.now()}`,
          endpoint: 'account-sync-scheduler-loop',
          event: 'ACCOUNT_SYNC_LOOP_FATAL_AUDIT_FAILED',
          result: 'error',
          errorCode: 'ACCOUNT_SYNC_LOOP_FATAL',
        }),
      })
      if (opts?.metrics) {
        opts.metrics.increment('api_error_rate', 1, {
          endpoint: ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.endpoint,
          event: ACCOUNT_SYNC_LOOP_FATAL_METRIC_LABELS.event,
          phase: 'TERTIARY_SINK',
        })
      }
    })
  }
  return event
}

/**
 * Production onError for the autonomous tick loop: mark every watched board
 * ACCOUNT_SYNC_STALE + usableCapacity=0, then invoke optional alert/audit.
 * Never a silent no-op.
 */
export function createAccountSyncSchedulerLoopOnError(input: {
  scheduler: AccountSyncScheduler
  /** Alert/audit callback — receives exact rejection context after fail-closed. */
  onAlert?: (event: AccountSyncLoopAlertEvent) => void | Promise<void>
  nowMs?: () => number
}): (err: unknown) => Promise<void> {
  if (!input.scheduler || typeof input.scheduler.failClosedStale !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'createAccountSyncSchedulerLoopOnError requires scheduler with failClosedStale',
    )
  }
  return async (err: unknown) => {
    const boardIds = input.scheduler.listBoards()
    const reason = 'ACCOUNT_SYNC_LOOP_TICK_REJECTED'
    for (const boardId of boardIds) {
      await input.scheduler.failClosedStale(boardId, reason)
    }
    const event: AccountSyncLoopAlertEvent = {
      kind: 'ACCOUNT_SYNC_LOOP_TICK_REJECTED',
      error: err,
      boardIds: [...boardIds],
      atMs: input.nowMs?.() ?? Date.now(),
      reason,
    }
    if (input.onAlert) {
      await input.onAlert(event)
    }
  }
}

/**
 * Mandatory secondary handler factory: durable ACCOUNT_SYNC_LOOP_FATAL emission
 * when primary onError rejects. Re-applies failClosedStale per board; collects
 * rejections, emits structured fatal (+ metric), then throws so the start-loop
 * tertiary sink records the failure (never empty-swallow continue).
 */
export function createAccountSyncSchedulerLoopOnFatalError(input: {
  scheduler: AccountSyncScheduler
  appendAudit?: (entry: Record<string, unknown>) => void | Promise<void>
  logLine?: (line: string) => void
  onAlert?: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
  nowMs?: () => number
  /** Runtime-injected metrics; incremented on FATAL emit. */
  metrics?: MetricsRegistry
}): (event: AccountSyncLoopFatalEvent) => Promise<void> {
  if (!input.scheduler || typeof input.scheduler.failClosedStale !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'createAccountSyncSchedulerLoopOnFatalError requires scheduler with failClosedStale',
    )
  }
  return async (event: AccountSyncLoopFatalEvent) => {
    // Keep capacity fail-closed even when primary partially failed.
    const boardIds =
      event.boardIds.length > 0 ? event.boardIds : input.scheduler.listBoards()
    const failClosedFailures: Array<{ boardId: string; error: unknown }> = []
    for (const boardId of boardIds) {
      try {
        await input.scheduler.failClosedStale(boardId, 'ACCOUNT_SYNC_LOOP_FATAL')
      } catch (failClosedErr) {
        // Collect — do not swallow; emit then throw so tertiary sink records.
        failClosedFailures.push({ boardId, error: failClosedErr })
      }
    }
    const atMs = event.atMs || (input.nowMs?.() ?? Date.now())
    const aggregateFailClosedError =
      failClosedFailures.length === 0
        ? null
        : new Error(
            `failClosedStale rejected during ACCOUNT_SYNC_LOOP_FATAL (${failClosedFailures.length}): ${failClosedFailures
              .map(
                (f) =>
                  `${f.boardId}:${f.error instanceof Error ? f.error.message : String(f.error)}`,
              )
              .join('; ')}`,
          )
    const full: AccountSyncLoopFatalEvent = {
      ...event,
      boardIds: [...boardIds],
      atMs,
      kind: 'ACCOUNT_SYNC_LOOP_FATAL',
      reason: 'ACCOUNT_SYNC_LOOP_FATAL',
      // Prefer original secondary error; surface failClosed rejections as error when present.
      error: aggregateFailClosedError ?? event.error,
      primaryError: event.primaryError ?? event.error,
      phase: event.phase ?? 'SECONDARY_ON_FATAL',
    }
    emitAccountSyncLoopFatal(full, {
      appendAudit: input.appendAudit,
      logLine: input.logLine,
      metrics: input.metrics,
    })
    if (input.onAlert) {
      await input.onAlert(full)
    }
    // Propagate failClosedStale rejection → startAccountSyncSchedulerLoop tertiary sink.
    if (aggregateFailClosedError) {
      throw aggregateFailClosedError
    }
  }
}

/**
 * Start one unref'd setInterval that calls scheduler.tick().
 * Safe for Node server processes (does not keep process alive alone).
 * **onError (primary) + onFatalError (secondary) are mandatory** —
 * tick rejections and failClosed handler rejections must never be empty-swallowed.
 * Production: createAccountSyncSchedulerLoopOnError + createAccountSyncSchedulerLoopOnFatalError.
 */
export function startAccountSyncSchedulerLoop(
  scheduler: AccountSyncScheduler,
  opts: {
    intervalMs?: number
    /** When false, do not unref (rare; default true). */
    unref?: boolean
    /**
     * Mandatory primary handler for tick rejections.
     * Production: createAccountSyncSchedulerLoopOnError (marks ACCOUNT_SYNC_STALE).
     */
    onError: (err: unknown) => void | Promise<void>
    /**
     * Mandatory secondary handler when primary onError rejects.
     * Production: createAccountSyncSchedulerLoopOnFatalError (ACCOUNT_SYNC_LOOP_FATAL).
     */
    onFatalError: (event: AccountSyncLoopFatalEvent) => void | Promise<void>
    /** Runtime-injected metrics for tertiary sink + FATAL emission path. */
    metrics?: MetricsRegistry
    logLine?: (line: string) => void
    appendAudit?: (entry: Record<string, unknown>) => void | Promise<void>
  },
): AccountSyncSchedulerLoopHandle {
  if (!opts || typeof opts.onError !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'startAccountSyncSchedulerLoop requires onError (tick rejections must not be swallowed)',
    )
  }
  if (typeof opts.onFatalError !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'startAccountSyncSchedulerLoop requires onFatalError (secondary fatal path mandatory)',
    )
  }
  const intervalMs = opts.intervalMs ?? ACCOUNT_SYNC_SCHEDULER_LOOP_MS
  let running = true
  const timer = setInterval(() => {
    if (!running) return
    void scheduler.tick().catch((err) => {
      // Primary: fail-closed + alert. Never empty catch.
      void Promise.resolve(opts.onError(err)).catch((primaryHandlerErr) => {
        const fatalEvent: AccountSyncLoopFatalEvent = {
          kind: 'ACCOUNT_SYNC_LOOP_FATAL',
          error: primaryHandlerErr,
          primaryError: err,
          boardIds: typeof scheduler.listBoards === 'function' ? scheduler.listBoards() : [],
          atMs: Date.now(),
          reason: 'ACCOUNT_SYNC_LOOP_FATAL',
          phase: 'PRIMARY_ON_ERROR',
        }
        // Secondary: durable ACCOUNT_SYNC_LOOP_FATAL. If it also rejects, tertiary sink.
        void Promise.resolve(opts.onFatalError(fatalEvent)).catch((secondaryErr) => {
          emitAccountSyncLoopFatal(
            {
              kind: 'ACCOUNT_SYNC_LOOP_FATAL',
              error: secondaryErr,
              primaryError: primaryHandlerErr,
              boardIds: fatalEvent.boardIds,
              atMs: Date.now(),
              reason: 'ACCOUNT_SYNC_LOOP_FATAL',
              phase: 'TERTIARY_SINK',
            },
            {
              metrics: opts.metrics,
              logLine: opts.logLine,
              appendAudit: opts.appendAudit,
            },
          )
        })
      })
    })
  }, intervalMs)
  if (opts.unref !== false && typeof timer.unref === 'function') {
    timer.unref()
  }
  return {
    intervalMs,
    stop() {
      if (!running) return
      running = false
      clearInterval(timer)
    },
    isRunning() {
      return running
    },
  }
}

/**
 * Infer account-sync trigger from masked status transitions (sync/replace path).
 * 403 uses STATUS_TRANSITION (no dedicated 403_* enum).
 */
export function inferAccountSyncTriggerFromStatuses(
  statuses: ReadonlyArray<MaskedAccountStatus | string>,
  fallback: AccountSyncTrigger = 'STATUS_TRANSITION',
): AccountSyncTrigger {
  const set = new Set(statuses.map((s) => String(s).toUpperCase()))
  if (set.has('BAN')) return 'BAN_TRANSITION'
  if (set.has('AUTH_EXPIRED')) return 'AUTH_EXPIRED_TRANSITION'
  if (set.has('LIMIT') || set.has('403')) return 'LIMIT_TRANSITION'
  return fallback
}

function emptySurfaces(): Record<
  AccountSyncReadbackSurface,
  { sourceRevision: number; generatedAt: string } | null
> {
  return { mcp: null, api: null, ui: null, ops: null }
}

function cloneIntent(intent: AccountSyncPublishIntent): AccountSyncPublishIntent {
  return {
    ...intent,
    accounts: intent.accounts.map((a) => ({ ...a })),
  }
}

function assertNoAccountsAll(intent: AccountSyncPublishIntent): void {
  if (intent.accountsAllFlag) {
    throw new AccountSyncError(
      'ACCOUNTS_ALL_FORBIDDEN',
      'never use --accounts all',
    )
  }
}

function assertNoSecretLikeFields(intent: AccountSyncPublishIntent): void {
  for (const a of intent.accounts) {
    if (a.maskedAccountId && /token|password|secret/i.test(a.maskedAccountId)) {
      throw new AccountSyncError(
        'DATA_INTEGRITY',
        'maskedAccountId must not look like a secret',
      )
    }
    if (a.reason && /token|password|secret|bearer\s/i.test(a.reason)) {
      throw new AccountSyncError(
        'DATA_INTEGRITY',
        'account reason must not contain secrets/tokens',
      )
    }
  }
  if (/token|password|secret/i.test(intent.idempotencyKey)) {
    throw new AccountSyncError(
      'DATA_INTEGRITY',
      'idempotencyKey must not look like a secret',
    )
  }
}

function intentToRequest(intent: AccountSyncPublishIntent): SyncAccountsRequest {
  return {
    boardId: intent.boardId,
    sourceRevision: intent.sourceRevision,
    generatedAt: intent.generatedAt,
    entityExpectedRev: intent.entityExpectedRev,
    expectedBoardRev: intent.expectedBoardRev,
    canonicalHash: intent.canonicalHash,
    currentPinHash: intent.currentPinHash,
    accounts: intent.accounts,
    trigger: intent.trigger,
    idempotencyKey: intent.idempotencyKey,
    callerRole: intent.callerRole,
    actorId: intent.actorId,
    health: intent.health,
    genuineReadyPacketCount: intent.genuineReadyPacketCount,
    accountsAllFlag: intent.accountsAllFlag,
  }
}

function defaultBoardState(): AccountSyncSchedulerBoardState {
  return {
    lastPublishedAtMs: null,
    lastPeriodicHealthAtMs: null,
    lastIntent: null,
    lastIdentity: null,
    pendingHeartbeat: null,
    pendingHeartbeatFirstAtMs: null,
    pendingHeartbeatDeadlineMs: null,
    coalescedHeartbeatCount: 0,
    publishCount: 0,
  }
}

/**
 * Build a scheduler from the durable runtime authority pieces
 * (clock + AccountSyncStore + atomic + idempotency).
 * Used by control-plane-runtime-context so one shared instance is attached
 * per process context; board-mcp later consumes via narrow getter.
 */
export function createAccountSyncSchedulerFromAuthority(input: {
  clock: ControlPlaneClock
  accounts: AccountSyncStore
  atomic: ControlPlaneAtomicStore
  idempotency: IdempotencyStorage
  surfacePublisher?: AccountSyncSurfacePublisher
  /**
   * Optional independent readers. When surfacePublisher is omitted, production
   * default builds independent durable readers from `accounts` (fail-closed if
   * any surface reader cannot be constructed).
   */
  surfaceReaders?: AccountSyncSurfaceReaders
  authorityPublisher?: AccountSyncAuthorityPublisher
  watchedBoards?: ReadonlyArray<string>
}): AccountSyncScheduler {
  const accountSync: AccountSyncDeps = {
    clock: input.clock,
    accounts: input.accounts,
    atomic: input.atomic,
    idempotency: input.idempotency,
  }
  let surfacePublisher = input.surfacePublisher
  if (!surfacePublisher) {
    const readers =
      input.surfaceReaders ?? createDurableAccountSyncSurfaceReaders(input.accounts)
    assertAccountSyncSurfaceReadersComplete(readers)
    surfacePublisher = createIndependentAccountSyncSurfacePublisher({
      readers,
      recordShared: true,
    })
  }
  return createAccountSyncScheduler({
    clock: input.clock,
    accountSync,
    surfacePublisher,
    authorityPublisher: input.authorityPublisher,
    watchedBoards: input.watchedBoards,
  })
}

/**
 * Create a deterministic, injectable account-sync SLA scheduler.
 * No background timers — runtime wires clock + tick loop later.
 */
export function createAccountSyncScheduler(
  deps: AccountSyncSchedulerDeps,
): AccountSyncScheduler {
  const boards = new Map<string, AccountSyncSchedulerBoardState>()
  const extraWatched = new Set(deps.watchedBoards ?? [])

  const authority: AccountSyncAuthorityPublisher =
    deps.authorityPublisher ??
    ((req) => syncAccounts(deps.accountSync, req))

  function ensureBoard(boardId: string): AccountSyncSchedulerBoardState {
    let s = boards.get(boardId)
    if (!s) {
      s = defaultBoardState()
      boards.set(boardId, s)
    }
    return s
  }

  function clearPendingHeartbeat(st: AccountSyncSchedulerBoardState): void {
    st.pendingHeartbeat = null
    st.pendingHeartbeatFirstAtMs = null
    st.pendingHeartbeatDeadlineMs = null
  }

  async function publishNow(
    intent: AccountSyncPublishIntent,
  ): Promise<AccountSyncPublishOutcome> {
    assertNoAccountsAll(intent)
    assertNoSecretLikeFields(intent)

    const st = ensureBoard(intent.boardId)
    const now = deps.clock.nowMs()

    let result: SyncAccountsResult
    try {
      result = await authority(intentToRequest(intent))
    } catch (e) {
      // Fail closed: authority failure → freshness re-eval + usableCapacity=0 path.
      await evaluateAccountSyncFreshness(deps.accountSync, intent.boardId)
      throw e
    }

    const snapAfter = await deps.accountSync.accounts.get(intent.boardId)
    const accountsForSurfaces: ReadonlyArray<MaskedAccountRecord> =
      snapAfter?.accounts ??
      intent.accounts.map((a) => ({
        maskedAccountId: a.maskedAccountId,
        status: a.status,
        providerKind: a.providerKind ?? 'OTHER',
        effectiveInUse: Math.max(0, a.effectiveInUse),
        effectiveCap: Math.max(0, a.effectiveCap),
        physicalSlotsDisplay: a.physicalSlotsDisplay ?? null,
        adaptiveQuotaState: a.adaptiveQuotaState ?? null,
        reason: a.reason ?? null,
        statusChangedAt: a.statusChangedAt ?? null,
        tombstone: a.status === 'REMOVED',
      }))

    const envelope: AccountSyncSurfacePublishEnvelope = {
      boardId: intent.boardId,
      sourceRevision: result.sourceRevision,
      generatedAt: result.generatedAt,
      trigger: intent.trigger,
      accounts: accountsForSurfaces,
      usableCapacity: result.usableCapacity,
      stale: result.stale,
      capacity: result.capacity,
    }

    // Defense: surface envelope must never include secret-like strings.
    const serialized = JSON.stringify(envelope)
    if (/("password"|"token"|"secret"|"authorization")\s*:/i.test(serialized)) {
      throw new AccountSyncError(
        'DATA_INTEGRITY',
        'surface publication envelope must not contain secrets/tokens',
      )
    }

    const surfaces = emptySurfaces()
    try {
      for (const surface of ACCOUNT_SYNC_READBACK_SURFACES) {
        const observed = await deps.surfacePublisher.publish(surface, envelope)
        surfaces[surface] = {
          sourceRevision: observed.sourceRevision,
          generatedAt: observed.generatedAt,
        }
        await recordAccountReadback(deps.accountSync, {
          boardId: intent.boardId,
          surface,
          sourceRevision: observed.sourceRevision,
          generatedAt: observed.generatedAt,
        })
      }
    } catch (e) {
      // Surface publish failure is visible typed failure + fail-closed stale.
      await forceStaleUsableZero(intent.boardId, 'SURFACE_PUBLISH_FAILED')
      if (e instanceof AccountSyncError) throw e
      throw new AccountSyncError(
        'DATA_INTEGRITY',
        `surface publication failed: ${e instanceof Error ? e.message : String(e)}`,
        { boardId: intent.boardId, cause: e instanceof Error ? e.name : typeof e },
      )
    }

    const parityOk = surfacesHaveParity(
      surfaces,
      result.sourceRevision,
      result.generatedAt,
    )

    // SLA / periodic fail-closed evaluation after surface fan-out.
    const freshness = await evaluateAccountSyncFreshness(
      deps.accountSync,
      intent.boardId,
    )

    st.lastPublishedAtMs = now
    st.lastIntent = cloneIntent(intent)
    st.lastIdentity = {
      sourceRevision: result.sourceRevision,
      generatedAt: result.generatedAt,
    }
    st.publishCount += 1
    if (intent.trigger === 'PERIODIC_HEALTH') {
      st.lastPeriodicHealthAtMs = now
    } else if (st.lastPeriodicHealthAtMs == null) {
      // First non-periodic publish still arms the 60s periodic clock from now
      // so boards do not sit forever without a health checkpoint.
      st.lastPeriodicHealthAtMs = now
    }
    clearPendingHeartbeat(st)
    // Keep coalesced count as historical for the last window; reset after publish.
    st.coalescedHeartbeatCount = 0

    const stale = freshness?.stale ?? result.stale
    const staleReason = freshness?.staleReason ?? result.staleReason
    const usableCapacity = freshness?.usableCapacity ?? result.usableCapacity

    return {
      kind: stale && !parityOk ? 'STALE_FAIL_CLOSED' : 'PUBLISHED',
      trigger: intent.trigger,
      boardId: intent.boardId,
      result,
      surfaces,
      parityOk,
      stale,
      staleReason,
      usableCapacity,
      publishedAtMs: now,
      deadlineMs: null,
    }
  }

  async function forceStaleUsableZero(
    boardId: string,
    reason: string,
  ): Promise<AccountSyncSnapshot | null> {
    const snap = await deps.accountSync.accounts.get(boardId)
    if (!snap) return null
    const capacity = evaluateCapacityPolicy({
      accounts: snap.accounts,
      forceZero: true,
    })
    const next: AccountSyncSnapshot = {
      ...snap,
      stale: true,
      staleReason: reason,
      usableCapacity: 0,
      capacity: {
        ...capacity,
        usableCapacity: 0,
        dispatchMode: 'BLOCKED',
        dispatchAllowed: false,
        limitingReasons: [
          ...new Set([...(capacity.limitingReasons ?? []), 'ACCOUNT_SYNC_STALE', reason]),
        ],
      },
      entityRev: snap.entityRev + 1,
    }
    await deps.accountSync.accounts.put(next)
    const board = await deps.accountSync.atomic.getBoardState(boardId)
    await deps.accountSync.atomic.setBoardState({
      ...board,
      dispatchBlocked: true,
      dispatchBlockedReason: `ACCOUNT_SYNC_STALE: ${reason}`,
    })
    return next
  }

  async function enqueue(
    intent: AccountSyncPublishIntent,
  ): Promise<AccountSyncPublishOutcome> {
    assertNoAccountsAll(intent)
    assertNoSecretLikeFields(intent)

    const st = ensureBoard(intent.boardId)
    const now = deps.clock.nowMs()

    if (isCoalescableAccountSyncTrigger(intent.trigger)) {
      if (!st.pendingHeartbeat) {
        st.pendingHeartbeat = cloneIntent(intent)
        st.pendingHeartbeatFirstAtMs = now
        st.pendingHeartbeatDeadlineMs = now + ACCOUNT_PUBLISH_SLA_MS
        st.coalescedHeartbeatCount = 0
        return {
          kind: 'COALESCED',
          trigger: intent.trigger,
          boardId: intent.boardId,
          coalescedCount: 0,
          deadlineMs: st.pendingHeartbeatDeadlineMs,
        }
      }
      // Replace with newest; deadline stays from first pending (newest still within window).
      st.pendingHeartbeat = cloneIntent(intent)
      st.coalescedHeartbeatCount += 1
      return {
        kind: 'COALESCED',
        trigger: intent.trigger,
        boardId: intent.boardId,
        coalescedCount: st.coalescedHeartbeatCount,
        deadlineMs: st.pendingHeartbeatDeadlineMs,
      }
    }

    // Immediate trigger supersedes any pending heartbeat for this board
    // (newest authoritative transition must not remain server-local).
    clearPendingHeartbeat(st)
    st.coalescedHeartbeatCount = 0
    return publishNow(intent)
  }

  async function flushDueHeartbeats(
    now: number,
  ): Promise<Array<AccountSyncPublishOutcome>> {
    const out: Array<AccountSyncPublishOutcome> = []
    for (const [boardId, st] of boards) {
      if (!st.pendingHeartbeat || st.pendingHeartbeatDeadlineMs == null) continue
      if (now < st.pendingHeartbeatDeadlineMs) continue
      const intent = st.pendingHeartbeat
      clearPendingHeartbeat(st)
      out.push(await publishNow(intent))
      void boardId
    }
    return out
  }

  async function runPeriodicHealth(
    now: number,
  ): Promise<Array<AccountSyncPublishOutcome>> {
    const out: Array<AccountSyncPublishOutcome> = []
    const candidates = new Set<string>([
      ...boards.keys(),
      ...extraWatched,
    ])

    for (const boardId of candidates) {
      const st = ensureBoard(boardId)
      // Skip if a heartbeat is already pending — tick will flush it; periodic
      // can wait until after newest heartbeat publishes (still within 30s SLA).
      if (st.pendingHeartbeat) continue
      if (!st.lastIntent) continue

      const lastPeriodic = st.lastPeriodicHealthAtMs
      if (lastPeriodic != null && now - lastPeriodic < ACCOUNT_PERIODIC_HEALTH_MS) {
        continue
      }
      // Also skip if we published anything very recently and it was PERIODIC
      // (publishNow already updated lastPeriodicHealthAtMs).

      const board = await deps.accountSync.atomic.getBoardState(boardId)
      const base = st.lastIntent
      // CAS against current durable snapshot entityRev (not the stale create-time 0 from lastIntent).
      const currentSnap = await deps.accountSync.accounts.get(boardId)
      const periodicIntent: AccountSyncPublishIntent = {
        ...cloneIntent(base),
        trigger: 'PERIODIC_HEALTH',
        sourceRevision: base.sourceRevision + 1,
        generatedAt: deps.clock.nowISO(),
        entityExpectedRev: currentSnap?.entityRev ?? 0,
        expectedBoardRev: board.boardRev,
        idempotencyKey: `periodic-health:${boardId}:${now}`,
      }
      out.push(await publishNow(periodicIntent))
    }
    return out
  }

  async function evaluateAllFreshness(): Promise<Array<AccountSyncSnapshot | null>> {
    const out: Array<AccountSyncSnapshot | null> = []
    for (const boardId of boards.keys()) {
      out.push(await evaluateAccountSyncFreshness(deps.accountSync, boardId))
    }
    for (const boardId of extraWatched) {
      if (!boards.has(boardId)) {
        out.push(await evaluateAccountSyncFreshness(deps.accountSync, boardId))
      }
    }
    return out
  }

  async function tick(): Promise<AccountSyncTickResult> {
    const now = deps.clock.nowMs()
    const published: Array<AccountSyncPublishOutcome> = []
    published.push(...(await flushDueHeartbeats(now)))
    published.push(...(await runPeriodicHealth(now)))
    const freshness = await evaluateAllFreshness()
    let pendingHeartbeats = 0
    for (const st of boards.values()) {
      if (st.pendingHeartbeat) pendingHeartbeats += 1
    }
    return { published, freshness, pendingHeartbeats, nowMs: now }
  }

  async function flush(boardId?: string): Promise<Array<AccountSyncPublishOutcome>> {
    const out: Array<AccountSyncPublishOutcome> = []
    const ids = boardId ? [boardId] : [...boards.keys()]
    for (const id of ids) {
      const st = boards.get(id)
      if (!st?.pendingHeartbeat) continue
      const intent = st.pendingHeartbeat
      clearPendingHeartbeat(st)
      out.push(await publishNow(intent))
    }
    return out
  }

  function getBoardState(boardId: string): AccountSyncSchedulerBoardState {
    const st = ensureBoard(boardId)
    return {
      ...st,
      lastIntent: st.lastIntent ? cloneIntent(st.lastIntent) : null,
      pendingHeartbeat: st.pendingHeartbeat ? cloneIntent(st.pendingHeartbeat) : null,
      lastIdentity: st.lastIdentity ? { ...st.lastIdentity } : null,
    }
  }

  function listBoards(): Array<string> {
    return [...new Set([...boards.keys(), ...extraWatched])]
  }

  function snapshot(): Record<string, AccountSyncSchedulerBoardState> {
    const out: Record<string, AccountSyncSchedulerBoardState> = {}
    for (const id of listBoards()) {
      out[id] = getBoardState(id)
    }
    return out
  }

  return {
    enqueue,
    tick,
    flush,
    getBoardState,
    listBoards,
    snapshot,
    failClosedStale: forceStaleUsableZero,
  }
}

/**
 * In-memory surface publisher that echoes exact sourceRevision/generatedAt.
 * Useful for unit tests and as a default until runtime wires real transports.
 */
export function createMemoryAccountSyncSurfacePublisher(opts?: {
  /** When set, that surface returns mismatched identity (parity fail tests). */
  mismatch?: Partial<
    Record<AccountSyncReadbackSurface, { sourceRevision: number; generatedAt: string }>
  >
  /** Surfaces that throw / skip (missing publication). */
  omit?: ReadonlyArray<AccountSyncReadbackSurface>
  /** Capture all publish calls for assertions. */
  log?: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
}): AccountSyncSurfacePublisher & {
  log: Array<{ surface: AccountSyncReadbackSurface; envelope: AccountSyncSurfacePublishEnvelope }>
} {
  const log =
    opts?.log ??
    ([] as Array<{
      surface: AccountSyncReadbackSurface
      envelope: AccountSyncSurfacePublishEnvelope
    }>)
  const omit = new Set(opts?.omit ?? [])
  return {
    log,
    async publish(surface, envelope) {
      if (omit.has(surface)) {
        throw new AccountSyncError(
          'DATA_INTEGRITY',
          `surface ${surface} publication missing`,
          { surface },
        )
      }
      log.push({ surface, envelope: { ...envelope, accounts: envelope.accounts.map((a) => ({ ...a })) } })
      const mismatched = opts?.mismatch?.[surface]
      if (mismatched) {
        return {
          sourceRevision: mismatched.sourceRevision,
          generatedAt: mismatched.generatedAt,
        }
      }
      return {
        sourceRevision: envelope.sourceRevision,
        generatedAt: envelope.generatedAt,
      }
    },
  }
}
