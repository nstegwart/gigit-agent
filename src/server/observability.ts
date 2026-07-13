/**
 * Structured logs, payload redaction, V3 metrics, alert state, runbook metadata.
 * AC-OPS-02 / AC-OPS-03. No private payload in logs or metric labels.
 */

export const OBSERVABILITY_SCHEMA = 'MFS_OBSERVABILITY_V1' as const

/** Exact safe structured log fields (V3 OBSERVABILITY). */
export interface StructuredLogFields {
  timestamp: string
  requestId: string
  boardId: string | null
  actorRole: string | null
  actorId: string | null
  endpoint: string
  event: string
  result: string | null
  errorCode: string | null
  latencyMs: number | null
  boardRev: number | null
  lifecycleRev: number | null
  /** Free-form safe metadata — redacted before emit. */
  meta?: Record<string, unknown>
}

export type MetricCategory =
  | 'api_latency_ms'
  | 'api_error_rate'
  | 'auth_denies'
  | 'dispatch_plan_age_ms'
  | 'runner_registration_latency_ms'
  | 'heartbeat_lag_ms'
  | 'heartbeat_error'
  | 'stalled_runs'
  | 'claim_lock_conflict'
  | 'reconciler_actions'
  | 'reconciler_failures'
  | 'canonical_import_failures'
  | 'aggregation_duration_ms'
  | 'snapshot_freshness_ms'
  | 'snapshot_mismatch'
  | 'decision_backlog'
  | 'account_sync_freshness_ms'
  | 'duplicate_join_rejection'

/** Every V3 metric category (must stay complete for AC-OPS-03). */
export const V3_METRIC_CATEGORIES: ReadonlyArray<MetricCategory> = [
  'api_latency_ms',
  'api_error_rate',
  'auth_denies',
  'dispatch_plan_age_ms',
  'runner_registration_latency_ms',
  'heartbeat_lag_ms',
  'heartbeat_error',
  'stalled_runs',
  'claim_lock_conflict',
  'reconciler_actions',
  'reconciler_failures',
  'canonical_import_failures',
  'aggregation_duration_ms',
  'snapshot_freshness_ms',
  'snapshot_mismatch',
  'decision_backlog',
  'account_sync_freshness_ms',
  'duplicate_join_rejection',
] as const

export type AlertId =
  | 'UNHEALTHY_RELEASE_SCHEMA_MISMATCH'
  | 'PUBLIC_FRESHNESS_STALE'
  | 'REPEATED_IMPORT_RECONCILE_FAILURE'
  | 'LIVE_MCP_UNAUTHORIZED_EXPOSURE'
  | 'ACCOUNT_SYNC_STALE'
  | 'CLAIM_LOCK_ANOMALY'
  | 'ERROR_LATENCY_BUDGET_BREACH'

export const V3_ALERT_IDS: ReadonlyArray<AlertId> = [
  'UNHEALTHY_RELEASE_SCHEMA_MISMATCH',
  'PUBLIC_FRESHNESS_STALE',
  'REPEATED_IMPORT_RECONCILE_FAILURE',
  'LIVE_MCP_UNAUTHORIZED_EXPOSURE',
  'ACCOUNT_SYNC_STALE',
  'CLAIM_LOCK_ANOMALY',
  'ERROR_LATENCY_BUDGET_BREACH',
] as const

export type AlertSeverity = 'info' | 'warning' | 'critical'

export interface AlertState {
  alertId: AlertId
  active: boolean
  severity: AlertSeverity
  message: string
  since: string | null
  runbookId: string
  /** Safe context only — never tokens/private bodies. */
  context: Record<string, string | number | boolean | null>
}

export interface RunbookEntry {
  runbookId: string
  alertId: AlertId
  title: string
  steps: ReadonlyArray<string>
  ownerRole: string
}

export const STAGING_RUNBOOKS: ReadonlyArray<RunbookEntry> = [
  {
    runbookId: 'rb-release-schema-mismatch',
    alertId: 'UNHEALTHY_RELEASE_SCHEMA_MISMATCH',
    title: 'Release or schema mismatch on /healthz',
    steps: [
      'Compare /healthz deployedSha to intended deploy SHA',
      'Compare schema.version to migration manifest latest',
      'Do not promote staging; redeploy matching artifact or roll forward migrations',
    ],
    ownerRole: 'ROOT_ORCHESTRATOR',
  },
  {
    runbookId: 'rb-public-freshness-stale',
    alertId: 'PUBLIC_FRESHNESS_STALE',
    title: 'Public snapshot freshness > 2 publication intervals',
    steps: [
      'Check aggregation publisher / materializer',
      'Inspect snapshot_freshness_ms metric',
      'Fail closed public surface until republish succeeds',
    ],
    ownerRole: 'ROOT_ORCHESTRATOR',
  },
  {
    runbookId: 'rb-import-reconcile-failure',
    alertId: 'REPEATED_IMPORT_RECONCILE_FAILURE',
    title: 'Repeated import or reconcile failure',
    steps: [
      'Inspect canonical_import_failures and reconciler_failures metrics',
      'Verify dryRunHash / revision pins',
      'Halt auto-apply; open Decision if data integrity',
    ],
    ownerRole: 'INTEGRATOR',
  },
  {
    runbookId: 'rb-mcp-unauthorized',
    alertId: 'LIVE_MCP_UNAUTHORIZED_EXPOSURE',
    title: 'Live MCP unauthorized exposure',
    steps: [
      'Confirm unauth cannot list/read sensitive tools',
      'Rotate tokens if exposure confirmed',
      'Public snapshot only for unauth path',
    ],
    ownerRole: 'OWNER',
  },
  {
    runbookId: 'rb-account-sync-stale',
    alertId: 'ACCOUNT_SYNC_STALE',
    title: 'Account sync stale',
    steps: [
      'Set usableCapacity=0 fail-closed',
      'Re-run authorized sync_accounts',
      'Confirm multi-surface revision/generatedAt parity',
    ],
    ownerRole: 'ROOT_ORCHESTRATOR',
  },
  {
    runbookId: 'rb-claim-lock-anomaly',
    alertId: 'CLAIM_LOCK_ANOMALY',
    title: 'Claim/lock anomaly',
    steps: [
      'Inspect claim_lock_conflict metric',
      'Verify fencing tokens and collisionScopeLockIds',
      'Release terminal locks only via authorized path',
    ],
    ownerRole: 'ROOT_ORCHESTRATOR',
  },
  {
    runbookId: 'rb-latency-budget',
    alertId: 'ERROR_LATENCY_BUDGET_BREACH',
    title: 'Error or latency budget breach',
    steps: [
      'Inspect api_latency_ms and api_error_rate',
      'Check dependency health on /healthz',
      'Throttle non-critical public load if needed',
    ],
    ownerRole: 'ROOT_ORCHESTRATOR',
  },
] as const

const SECRET_KEY_RE =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session|credential|rawIdentity|bearer)$/i

const SECRET_VALUE_HINT =
  /-----BEGIN |Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{10,}/i

/**
 * Recursive redaction for logs/metrics context.
 * Removes secret keys and scrubs secret-looking strings.
 */
export function redactForObservability(value: unknown): unknown {
  if (value === null || value === undefined) return value
  if (typeof value === 'string') {
    if (SECRET_VALUE_HINT.test(value)) return '[REDACTED]'
    return value
  }
  if (typeof value !== 'object') return value
  if (Array.isArray(value)) return value.map((v) => redactForObservability(v))
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    if (SECRET_KEY_RE.test(k) || /password|token|secret|credential/i.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    // Never log private decision text / comments / evidence bodies.
    if (/comment|evidenceBody|decisionText|decisionTitle|privateDecision/i.test(k)) {
      out[k] = '[REDACTED]'
      continue
    }
    out[k] = redactForObservability(v)
  }
  return out
}

export function buildStructuredLog(
  partial: Partial<StructuredLogFields> &
    Pick<StructuredLogFields, 'requestId' | 'endpoint' | 'event'>,
  nowIso?: () => string,
): StructuredLogFields {
  const raw: StructuredLogFields = {
    timestamp: partial.timestamp ?? (nowIso ? nowIso() : new Date().toISOString()),
    requestId: partial.requestId,
    boardId: partial.boardId ?? null,
    actorRole: partial.actorRole ?? null,
    actorId: partial.actorId ?? null,
    endpoint: partial.endpoint,
    event: partial.event,
    result: partial.result ?? null,
    errorCode: partial.errorCode ?? null,
    latencyMs: partial.latencyMs ?? null,
    boardRev: partial.boardRev ?? null,
    lifecycleRev: partial.lifecycleRev ?? null,
    meta: partial.meta,
  }
  const redacted = redactForObservability(raw) as StructuredLogFields
  return redacted
}

export interface MetricSample {
  category: MetricCategory
  value: number
  labels?: Record<string, string>
  atMs: number
}

export interface MetricsRegistry {
  observe(category: MetricCategory, value: number, labels?: Record<string, string>): void
  increment(category: MetricCategory, by?: number, labels?: Record<string, string>): void
  snapshot(): ReadonlyArray<MetricSample>
  sum(category: MetricCategory): number
  count(category: MetricCategory): number
  reset(): void
}

export function createMemoryMetricsRegistry(clock?: () => number): MetricsRegistry {
  const samples: Array<MetricSample> = []
  const now = clock ?? (() => Date.now())
  const safeLabels = (labels?: Record<string, string>): Record<string, string> | undefined => {
    if (!labels) return undefined
    const out: Record<string, string> = {}
    for (const [k, v] of Object.entries(labels)) {
      if (SECRET_KEY_RE.test(k)) continue
      out[k] = SECRET_VALUE_HINT.test(v) ? '[REDACTED]' : v
    }
    return out
  }
  return {
    observe(category, value, labels) {
      samples.push({ category, value, labels: safeLabels(labels), atMs: now() })
    },
    increment(category, by = 1, labels) {
      samples.push({ category, value: by, labels: safeLabels(labels), atMs: now() })
    },
    snapshot: () => [...samples],
    sum(category) {
      return samples.filter((s) => s.category === category).reduce((a, s) => a + s.value, 0)
    },
    count(category) {
      return samples.filter((s) => s.category === category).length
    },
    reset() {
      samples.length = 0
    },
  }
}

export function assertAllMetricCategoriesRegistered(
  observed: ReadonlyArray<MetricCategory>,
): { ok: boolean; missing: Array<MetricCategory> } {
  const set = new Set(observed)
  const missing = V3_METRIC_CATEGORIES.filter((c) => !set.has(c))
  return { ok: missing.length === 0, missing: [...missing] }
}

export interface AlertRegistry {
  set(alert: AlertState): void
  get(alertId: AlertId): AlertState | null
  listActive(): Array<AlertState>
  clear(alertId: AlertId): void
  all(): Array<AlertState>
}

export function createMemoryAlertRegistry(): AlertRegistry {
  const map = new Map<AlertId, AlertState>()
  return {
    set(alert) {
      const safe = redactForObservability(alert) as AlertState
      map.set(alert.alertId, safe)
    },
    get: (id) => map.get(id) ?? null,
    listActive: () => [...map.values()].filter((a) => a.active),
    clear(id) {
      const cur = map.get(id)
      if (cur) map.set(id, { ...cur, active: false })
    },
    all: () => [...map.values()],
  }
}

export function runbookForAlert(alertId: AlertId): RunbookEntry | null {
  return STAGING_RUNBOOKS.find((r) => r.alertId === alertId) ?? null
}

export function evaluatePublicFreshnessAlert(opts: {
  ageMs: number
  publicationIntervalMs: number
  nowIso: string
}): AlertState {
  const active = opts.ageMs > 2 * opts.publicationIntervalMs
  return {
    alertId: 'PUBLIC_FRESHNESS_STALE',
    active,
    severity: active ? 'critical' : 'info',
    message: active
      ? 'public snapshot freshness exceeds 2 publication intervals'
      : 'public snapshot freshness within budget',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-public-freshness-stale',
    context: {
      ageMs: opts.ageMs,
      publicationIntervalMs: opts.publicationIntervalMs,
      thresholdMs: 2 * opts.publicationIntervalMs,
    },
  }
}

export function evaluateReleaseSchemaAlert(opts: {
  releaseMatch: boolean
  schemaMatch: boolean
  nowIso: string
}): AlertState {
  const active = !opts.releaseMatch || !opts.schemaMatch
  return {
    alertId: 'UNHEALTHY_RELEASE_SCHEMA_MISMATCH',
    active,
    severity: active ? 'critical' : 'info',
    message: active ? 'release SHA or schema version mismatch' : 'release and schema match',
    since: active ? opts.nowIso : null,
    runbookId: 'rb-release-schema-mismatch',
    context: {
      releaseMatch: opts.releaseMatch,
      schemaMatch: opts.schemaMatch,
    },
  }
}

export interface ObservabilityFacade {
  log: (fields: Partial<StructuredLogFields> & Pick<StructuredLogFields, 'requestId' | 'endpoint' | 'event'>) => StructuredLogFields
  metrics: MetricsRegistry
  alerts: AlertRegistry
  runbooks: ReadonlyArray<RunbookEntry>
}

export function createObservabilityFacade(opts?: {
  metrics?: MetricsRegistry
  alerts?: AlertRegistry
  nowIso?: () => string
}): ObservabilityFacade {
  const metrics = opts?.metrics ?? createMemoryMetricsRegistry()
  const alerts = opts?.alerts ?? createMemoryAlertRegistry()
  return {
    log: (fields) => buildStructuredLog(fields, opts?.nowIso),
    metrics,
    alerts,
    runbooks: STAGING_RUNBOOKS,
  }
}
