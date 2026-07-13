/**
 * Request / MCP observability integration facade (AC-OPS-02 / AC-OPS-03 foundation).
 *
 * Wraps createObservabilityFacade for future middleware wiring.
 * Produces sanitized structured logs, V3 metrics samples, and alert evaluations
 * with runbook IDs. No external provider dependency (memory sink only).
 *
 * Do not import this from routes yet — foundation only (OPS-OBS-WIRE step 1).
 */

import {
  STAGING_RUNBOOKS,
  V3_ALERT_IDS,
  V3_METRIC_CATEGORIES,
  buildStructuredLog,
  createMemoryAlertRegistry,
  createMemoryMetricsRegistry,
  createObservabilityFacade,
  evaluatePublicFreshnessAlert,
  evaluateReleaseSchemaAlert,
  redactForObservability,
  runbookForAlert,
  type AlertId,
  type AlertRegistry,
  type AlertSeverity,
  type AlertState,
  type MetricCategory,
  type MetricsRegistry,
  type ObservabilityFacade,
  type RunbookEntry,
  type StructuredLogFields,
} from '#/server/observability'

export const OBSERVABILITY_INTEGRATION_SCHEMA = 'MFS_OBSERVABILITY_INTEGRATION_V1' as const

export type ObservabilityChannel = 'http' | 'mcp' | 'internal'

export interface RequestObservationContext {
  requestId: string
  endpoint: string
  method?: string | null
  boardId?: string | null
  actorRole?: string | null
  actorId?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  channel?: ObservabilityChannel
  /** Free-form safe metadata; redacted before emit. */
  meta?: Record<string, unknown>
}

export interface McpObservationContext {
  requestId: string
  toolName: string
  boardId?: string | null
  actorRole?: string | null
  actorId?: string | null
  boardRev?: number | null
  lifecycleRev?: number | null
  meta?: Record<string, unknown>
}

export interface ObservationResult {
  result: 'ok' | 'error' | 'deny' | 'timeout'
  errorCode?: string | null
  latencyMs?: number | null
  /** Extra metric category observations for this call. */
  metrics?: ReadonlyArray<{ category: MetricCategory; value: number; labels?: Record<string, string> }>
}

export interface StructuredLogSink {
  emit(entry: StructuredLogFields): void
  snapshot(): ReadonlyArray<StructuredLogFields>
  clear(): void
}

export function createMemoryLogSink(): StructuredLogSink {
  const entries: Array<StructuredLogFields> = []
  return {
    emit(entry) {
      entries.push(entry)
    },
    snapshot: () => [...entries],
    clear() {
      entries.length = 0
    },
  }
}

export interface AlertEvaluationInput {
  nowIso: string
  releaseMatch?: boolean
  schemaMatch?: boolean
  publicSnapshotAgeMs?: number
  publicationIntervalMs?: number
  /** p95 latency ms for ERROR_LATENCY_BUDGET_BREACH. */
  p95LatencyMs?: number
  /** error rate 0..1 for ERROR_LATENCY_BUDGET_BREACH. */
  errorRate?: number
  latencyBudgetMs?: number
  errorRateBudget?: number
  /** consecutive import/reconcile failures. */
  repeatedImportReconcileFailures?: number
  importReconcileFailureThreshold?: number
  /** live MCP unauth exposure detected. */
  liveMcpUnauthorizedExposure?: boolean
  /** account sync age ms. */
  accountSyncAgeMs?: number
  accountSyncStaleThresholdMs?: number
  /** claim/lock anomaly flag. */
  claimLockAnomaly?: boolean
}

export interface AlertEvaluationResult {
  alertId: AlertId
  state: AlertState
  runbookId: string
  runbook: RunbookEntry | null
}

export interface ObservabilityIntegration {
  schema: typeof OBSERVABILITY_INTEGRATION_SCHEMA
  facade: ObservabilityFacade
  sink: StructuredLogSink
  metrics: MetricsRegistry
  alerts: AlertRegistry
  runbooks: ReadonlyArray<RunbookEntry>

  /** Begin HTTP/request observation; returns end() that logs + records latency. */
  beginRequest: (ctx: RequestObservationContext) => {
    end: (result: ObservationResult) => StructuredLogFields
  }

  /** Observe one MCP tool invocation (begin/end in one call after completion). */
  observeMcp: (
    ctx: McpObservationContext,
    result: ObservationResult,
  ) => StructuredLogFields

  /** Emit a sanitized structured log without timing. */
  log: (
    fields: Partial<StructuredLogFields> &
      Pick<StructuredLogFields, 'requestId' | 'endpoint' | 'event'>,
  ) => StructuredLogFields

  /** Evaluate known alert signals; activate/clear registry; return runbook-linked states. */
  evaluateAlerts: (input: AlertEvaluationInput) => ReadonlyArray<AlertEvaluationResult>

  /** Snapshot of emitted logs (sanitized). */
  logSnapshot: () => ReadonlyArray<StructuredLogFields>

  /** Self-test: emit sample log/metric/alert; returns pass + residual gaps. */
  selfTest: () => {
    ok: boolean
    metricCategoriesCovered: number
    alertsWithRunbooks: number
    residualGaps: ReadonlyArray<string>
  }
}

const DEFAULT_LATENCY_BUDGET_MS = 500
const DEFAULT_ERROR_RATE_BUDGET = 0.01
const DEFAULT_IMPORT_FAIL_THRESHOLD = 3
const DEFAULT_ACCOUNT_SYNC_STALE_MS = 15 * 60 * 1000

export function evaluateLatencyErrorBudgetAlert(opts: {
  p95LatencyMs: number
  errorRate: number
  latencyBudgetMs?: number
  errorRateBudget?: number
  nowIso: string
}): AlertState {
  const latencyBudget = opts.latencyBudgetMs ?? DEFAULT_LATENCY_BUDGET_MS
  const errorBudget = opts.errorRateBudget ?? DEFAULT_ERROR_RATE_BUDGET
  const active =
    opts.p95LatencyMs > latencyBudget || opts.errorRate > errorBudget
  return {
    alertId: 'ERROR_LATENCY_BUDGET_BREACH',
    active,
    severity: active ? 'critical' : 'info',
    message: active
      ? 'error or latency budget breach'
      : 'error and latency within budget',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-latency-budget',
    context: {
      p95LatencyMs: opts.p95LatencyMs,
      errorRate: opts.errorRate,
      latencyBudgetMs: latencyBudget,
      errorRateBudget: errorBudget,
    },
  }
}

export function evaluateRepeatedImportReconcileAlert(opts: {
  failureCount: number
  threshold?: number
  nowIso: string
}): AlertState {
  const threshold = opts.threshold ?? DEFAULT_IMPORT_FAIL_THRESHOLD
  const active = opts.failureCount >= threshold
  return {
    alertId: 'REPEATED_IMPORT_RECONCILE_FAILURE',
    active,
    severity: active ? 'critical' : 'info',
    message: active
      ? 'repeated import or reconcile failure'
      : 'import/reconcile failures within threshold',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-import-reconcile-failure',
    context: {
      failureCount: opts.failureCount,
      threshold,
    },
  }
}

export function evaluateLiveMcpUnauthorizedAlert(opts: {
  exposed: boolean
  nowIso: string
}): AlertState {
  const active = opts.exposed
  return {
    alertId: 'LIVE_MCP_UNAUTHORIZED_EXPOSURE',
    active,
    severity: active ? 'critical' : 'info',
    message: active
      ? 'live MCP unauthorized exposure detected'
      : 'live MCP unauthorized exposure not detected',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-mcp-unauthorized',
    context: { exposed: opts.exposed },
  }
}

export function evaluateAccountSyncStaleAlert(opts: {
  ageMs: number
  thresholdMs?: number
  nowIso: string
}): AlertState {
  const thresholdMs = opts.thresholdMs ?? DEFAULT_ACCOUNT_SYNC_STALE_MS
  const active = opts.ageMs > thresholdMs
  return {
    alertId: 'ACCOUNT_SYNC_STALE',
    active,
    severity: active ? 'warning' : 'info',
    message: active ? 'account sync stale' : 'account sync fresh',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-account-sync-stale',
    context: { ageMs: opts.ageMs, thresholdMs },
  }
}

export function evaluateClaimLockAnomalyAlert(opts: {
  anomaly: boolean
  nowIso: string
}): AlertState {
  const active = opts.anomaly
  return {
    alertId: 'CLAIM_LOCK_ANOMALY',
    active,
    severity: active ? 'warning' : 'info',
    message: active ? 'claim/lock anomaly' : 'claim/lock nominal',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-claim-lock-anomaly',
    context: { anomaly: opts.anomaly },
  }
}

function severityForResult(result: ObservationResult['result']): AlertSeverity {
  if (result === 'error' || result === 'timeout') return 'warning'
  if (result === 'deny') return 'info'
  return 'info'
}

// Keep TS happy if severity helper is used for future alert promotion.
void severityForResult

export function createObservabilityIntegration(opts?: {
  metrics?: MetricsRegistry
  alerts?: AlertRegistry
  sink?: StructuredLogSink
  nowIso?: () => string
  nowMs?: () => number
}): ObservabilityIntegration {
  const sink = opts?.sink ?? createMemoryLogSink()
  const metrics = opts?.metrics ?? createMemoryMetricsRegistry(opts?.nowMs)
  const alerts = opts?.alerts ?? createMemoryAlertRegistry()
  const nowIso = opts?.nowIso ?? (() => new Date().toISOString())
  const nowMs = opts?.nowMs ?? (() => Date.now())
  const facade = createObservabilityFacade({ metrics, alerts, nowIso })

  const emitLog = (
    fields: Partial<StructuredLogFields> &
      Pick<StructuredLogFields, 'requestId' | 'endpoint' | 'event'>,
  ): StructuredLogFields => {
    const entry = buildStructuredLog(fields, nowIso)
    sink.emit(entry)
    return entry
  }

  const applyMetrics = (result: ObservationResult, labels?: Record<string, string>) => {
    if (result.latencyMs != null) {
      metrics.observe('api_latency_ms', result.latencyMs, labels)
    }
    if (result.result === 'error' || result.result === 'timeout') {
      metrics.increment('api_error_rate', 1, labels)
    }
    if (result.result === 'deny') {
      metrics.increment('auth_denies', 1, labels)
    }
    if (result.metrics) {
      for (const m of result.metrics) {
        metrics.observe(m.category, m.value, m.labels)
      }
    }
  }

  return {
    schema: OBSERVABILITY_INTEGRATION_SCHEMA,
    facade,
    sink,
    metrics,
    alerts,
    runbooks: STAGING_RUNBOOKS,

    beginRequest(ctx) {
      const startedAt = nowMs()
      const channel = ctx.channel ?? 'http'
      return {
        end(result) {
          const latencyMs =
            result.latencyMs != null ? result.latencyMs : Math.max(0, nowMs() - startedAt)
          const labels = {
            channel,
            endpoint: ctx.endpoint,
            ...(ctx.method ? { method: ctx.method } : {}),
          }
          applyMetrics({ ...result, latencyMs }, labels)
          return emitLog({
            requestId: ctx.requestId,
            endpoint: ctx.endpoint,
            event: 'request',
            boardId: ctx.boardId ?? null,
            actorRole: ctx.actorRole ?? null,
            actorId: ctx.actorId ?? null,
            boardRev: ctx.boardRev ?? null,
            lifecycleRev: ctx.lifecycleRev ?? null,
            result: result.result,
            errorCode: result.errorCode ?? null,
            latencyMs,
            meta: redactForObservability({
              channel,
              method: ctx.method ?? null,
              ...(ctx.meta ?? {}),
            }) as Record<string, unknown>,
          })
        },
      }
    },

    observeMcp(ctx, result) {
      const labels = { channel: 'mcp', tool: ctx.toolName }
      applyMetrics(result, labels)
      if (result.result === 'deny') {
        // auth_denies already incremented in applyMetrics
      }
      return emitLog({
        requestId: ctx.requestId,
        endpoint: `mcp:${ctx.toolName}`,
        event: 'mcp_tool',
        boardId: ctx.boardId ?? null,
        actorRole: ctx.actorRole ?? null,
        actorId: ctx.actorId ?? null,
        boardRev: ctx.boardRev ?? null,
        lifecycleRev: ctx.lifecycleRev ?? null,
        result: result.result,
        errorCode: result.errorCode ?? null,
        latencyMs: result.latencyMs ?? null,
        meta: redactForObservability({
          channel: 'mcp',
          toolName: ctx.toolName,
          ...(ctx.meta ?? {}),
        }) as Record<string, unknown>,
      })
    },

    log: emitLog,

    evaluateAlerts(input) {
      const results: Array<AlertEvaluationResult> = []

      const push = (state: AlertState) => {
        const runbook = runbookForAlert(state.alertId)
        const withRunbook: AlertState = {
          ...state,
          runbookId: state.runbookId || runbook?.runbookId || `rb-unknown-${state.alertId}`,
        }
        // Always set so self-tests / dashboards see latest evaluation.
        alerts.set(withRunbook)
        results.push({
          alertId: withRunbook.alertId,
          state: withRunbook,
          runbookId: withRunbook.runbookId,
          runbook,
        })
      }

      if (input.releaseMatch !== undefined || input.schemaMatch !== undefined) {
        push(
          evaluateReleaseSchemaAlert({
            releaseMatch: input.releaseMatch ?? true,
            schemaMatch: input.schemaMatch ?? true,
            nowIso: input.nowIso,
          }),
        )
      }

      if (
        input.publicSnapshotAgeMs !== undefined &&
        input.publicationIntervalMs !== undefined
      ) {
        push(
          evaluatePublicFreshnessAlert({
            ageMs: input.publicSnapshotAgeMs,
            publicationIntervalMs: input.publicationIntervalMs,
            nowIso: input.nowIso,
          }),
        )
      }

      if (input.p95LatencyMs !== undefined && input.errorRate !== undefined) {
        push(
          evaluateLatencyErrorBudgetAlert({
            p95LatencyMs: input.p95LatencyMs,
            errorRate: input.errorRate,
            latencyBudgetMs: input.latencyBudgetMs,
            errorRateBudget: input.errorRateBudget,
            nowIso: input.nowIso,
          }),
        )
      }

      if (input.repeatedImportReconcileFailures !== undefined) {
        push(
          evaluateRepeatedImportReconcileAlert({
            failureCount: input.repeatedImportReconcileFailures,
            threshold: input.importReconcileFailureThreshold,
            nowIso: input.nowIso,
          }),
        )
      }

      if (input.liveMcpUnauthorizedExposure !== undefined) {
        push(
          evaluateLiveMcpUnauthorizedAlert({
            exposed: input.liveMcpUnauthorizedExposure,
            nowIso: input.nowIso,
          }),
        )
      }

      if (input.accountSyncAgeMs !== undefined) {
        push(
          evaluateAccountSyncStaleAlert({
            ageMs: input.accountSyncAgeMs,
            thresholdMs: input.accountSyncStaleThresholdMs,
            nowIso: input.nowIso,
          }),
        )
      }

      if (input.claimLockAnomaly !== undefined) {
        push(
          evaluateClaimLockAnomalyAlert({
            anomaly: input.claimLockAnomaly,
            nowIso: input.nowIso,
          }),
        )
      }

      return results
    },

    logSnapshot: () => sink.snapshot(),

    selfTest() {
      const obs = createObservabilityIntegration({
        nowIso: () => '2026-07-13T19:17:07.000Z',
        nowMs: () => 1_000_000,
      })
      const req = obs.beginRequest({
        requestId: 'self-test-req',
        endpoint: '/api/healthz',
        method: 'GET',
        actorRole: 'ROOT_ORCHESTRATOR',
        actorId: 'self-test',
        channel: 'http',
        meta: { token: 'should-redact', safe: true },
      })
      const log = req.end({ result: 'ok', latencyMs: 12 })
      obs.observeMcp(
        {
          requestId: 'self-test-mcp',
          toolName: 'list_tools',
          actorRole: 'AGENT',
          actorId: 'agent-1',
          meta: { password: 'x' },
        },
        { result: 'ok', latencyMs: 5 },
      )
      for (const cat of V3_METRIC_CATEGORIES) {
        obs.metrics.observe(cat, 1, { source: 'self-test' })
      }
      const evals = obs.evaluateAlerts({
        nowIso: '2026-07-13T19:17:07.000Z',
        releaseMatch: true,
        schemaMatch: true,
        publicSnapshotAgeMs: 10_000,
        publicationIntervalMs: 60_000,
        p95LatencyMs: 40,
        errorRate: 0,
        repeatedImportReconcileFailures: 0,
        liveMcpUnauthorizedExposure: false,
        accountSyncAgeMs: 1000,
        claimLockAnomaly: false,
      })
      const alertsWithRunbooks = evals.filter(
        (e) => e.runbookId.length > 0 && e.runbook != null,
      ).length
      const secretLeak =
        JSON.stringify(log).includes('should-redact') ||
        obs.logSnapshot().some((e) => JSON.stringify(e).includes('should-redact'))
      const residualGaps: Array<string> = [
        'not wired into HTTP/MCP middleware routes (foundation only)',
        'no external metrics/log provider (memory sink)',
        'no staging live alert drill',
      ]
      const ok =
        !secretLeak &&
        log.result === 'ok' &&
        obs.metrics.count('api_latency_ms') >= 1 &&
        alertsWithRunbooks === V3_ALERT_IDS.length &&
        obs.runbooks.length === V3_ALERT_IDS.length
      return {
        ok,
        metricCategoriesCovered: V3_METRIC_CATEGORIES.length,
        alertsWithRunbooks,
        residualGaps,
      }
    },
  }
}

/** Re-export runbook lookup for middleware callers without reaching into core. */
export { runbookForAlert, V3_ALERT_IDS, V3_METRIC_CATEGORIES, STAGING_RUNBOOKS }
