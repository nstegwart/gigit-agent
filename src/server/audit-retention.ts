/**
 * BoardPolicy heartbeat sample / hot / sampled / rollup retention + compaction.
 * AC-OPS-04 / AC-OPS-05.
 * Heartbeat mutates hot state only — NOT immutable per-heartbeat audit.
 * Only material events are immutable audit rows.
 * If no production policy supplied: staging may use an explicit proposal;
 * production returns DECISION_HEARTBEAT_RETENTION_POLICY (never silent default).
 */

export const DECISION_HEARTBEAT_RETENTION_POLICY =
  'DECISION_HEARTBEAT_RETENTION_POLICY' as const

/**
 * Known retention environments. UNRESOLVED = missing/unknown identity (H3 fail-closed).
 * Never treat UNRESOLVED as LOCAL — that would invent staging-proposed policy.
 */
export type RetentionEnvironment =
  | 'LOCAL'
  | 'STAGING'
  | 'PRODUCTION'
  | 'TEST'
  | 'UNRESOLVED'

/** Explicit app-env tokens accepted on CAIRN_ENV / APP_ENV. */
const EXPLICIT_APP_ENV: Readonly<Record<string, Exclude<RetentionEnvironment, 'UNRESOLVED'>>> =
  {
    local: 'LOCAL',
    test: 'TEST',
    staging: 'STAGING',
    production: 'PRODUCTION',
    prod: 'PRODUCTION',
  }

/** How retention environment identity was derived (R4 source tracking). */
export type RetentionEnvSource =
  | 'CAIRN_ENV'
  | 'APP_ENV'
  | 'NODE_ENV_PRODUCTION'
  | 'NODE_ENV_TEST'
  | 'VITEST'
  | 'NONE'
  | 'UNKNOWN_APP_ENV'

/**
 * Full retention-env resolution (H3 + R4).
 * Prefer this when deciding whether staging-proposal is authorized.
 */
export interface RetentionEnvironmentDetails {
  environment: RetentionEnvironment
  source: RetentionEnvSource
  /** True when CAIRN_ENV/APP_ENV was an explicit known token. */
  explicitAppEnv: boolean
  /**
   * True when identity rests only on weak runner signals (NODE_ENV=test / VITEST)
   * without CAIRN_ENV/APP_ENV. Weak signals alone must not authorize staging proposal
   * in production-like runtimes (R4).
   */
  weakTestSignal: boolean
  /**
   * Production-like process: NODE_ENV=production, CAIRN_SERVER=1, or
   * CAIRN_ENV/APP_ENV ∈ {production,prod,staging}.
   */
  productionLike: boolean
}

/**
 * Production-like runtime for retention authorization (aligned with
 * isProductionOrServerEnv — kept here to avoid import cycles).
 */
export function isProductionLikeRetentionRuntime(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const nodeEnv = (env.NODE_ENV || '').toLowerCase().trim()
  if (nodeEnv === 'production') return true
  if ((env.CAIRN_SERVER || '').trim() === '1') return true
  const appEnv = (env.CAIRN_ENV || env.APP_ENV || '').toLowerCase().trim()
  return appEnv === 'production' || appEnv === 'prod' || appEnv === 'staging'
}

function isWeakTestRunnerSignal(env: NodeJS.ProcessEnv): boolean {
  const node = (env.NODE_ENV || '').toLowerCase().trim()
  if (node === 'test') return true
  const vitest = env.VITEST
  return vitest === 'true' || vitest === '1'
}

/**
 * Map process env → detailed RetentionEnvironment (H3 + R4 fail-closed).
 *
 * Prefer explicit CAIRN_ENV / APP_ENV ∈ {local,test,staging,production|prod}.
 * Fallbacks without inventing LOCAL:
 * - NODE_ENV=production → PRODUCTION
 * - NODE_ENV=test or VITEST → TEST only when NOT production-like (R4);
 *   production-like + weak test signals → UNRESOLVED (no silent TEST proposal)
 * - missing / unknown / bare development → UNRESOLVED
 *
 * Does NOT map bare NODE_ENV=development or empty env to LOCAL.
 */
export function resolveRetentionEnvironmentDetails(
  env: NodeJS.ProcessEnv = process.env,
): RetentionEnvironmentDetails {
  const productionLike = isProductionLikeRetentionRuntime(env)
  const hasCairn = !!(env.CAIRN_ENV || '').trim()
  const appRaw = (env.CAIRN_ENV || env.APP_ENV || '').toLowerCase().trim()
  if (appRaw) {
    const mapped = EXPLICIT_APP_ENV[appRaw]
    if (mapped) {
      return {
        environment: mapped,
        source: hasCairn ? 'CAIRN_ENV' : 'APP_ENV',
        explicitAppEnv: true,
        weakTestSignal: false,
        productionLike,
      }
    }
    // Unknown CAIRN_ENV/APP_ENV value — never invent LOCAL.
    return {
      environment: 'UNRESOLVED',
      source: 'UNKNOWN_APP_ENV',
      explicitAppEnv: false,
      weakTestSignal: false,
      productionLike,
    }
  }

  const node = (env.NODE_ENV || '').toLowerCase().trim()
  if (node === 'production') {
    return {
      environment: 'PRODUCTION',
      source: 'NODE_ENV_PRODUCTION',
      explicitAppEnv: false,
      weakTestSignal: false,
      productionLike: true,
    }
  }

  if (isWeakTestRunnerSignal(env)) {
    const source: RetentionEnvSource =
      node === 'test' ? 'NODE_ENV_TEST' : 'VITEST'
    // R4: production-like runtime must not treat NODE_ENV=test/VITEST as TEST
    // (TEST previously auto-authorized staging-proposed retention).
    if (productionLike) {
      return {
        environment: 'UNRESOLVED',
        source,
        explicitAppEnv: false,
        weakTestSignal: true,
        productionLike: true,
      }
    }
    return {
      environment: 'TEST',
      source,
      explicitAppEnv: false,
      weakTestSignal: true,
      productionLike: false,
    }
  }

  // Missing or non-test/non-production (e.g. development, empty) → fail-closed.
  return {
    environment: 'UNRESOLVED',
    source: 'NONE',
    explicitAppEnv: false,
    weakTestSignal: false,
    productionLike,
  }
}

/**
 * Map process env → RetentionEnvironment (H3 + R4 fail-closed).
 * Convenience wrapper over resolveRetentionEnvironmentDetails.
 */
export function resolveRetentionEnvironment(
  env: NodeJS.ProcessEnv = process.env,
): RetentionEnvironment {
  return resolveRetentionEnvironmentDetails(env).environment
}

/**
 * Startup / Decision status helper: retention env must be explicit known identity.
 * Throws when UNRESOLVED so misconfigured processes do not boot with invented policy.
 * R4: production-like + bare NODE_ENV=test/VITEST also throws (UNRESOLVED).
 */
export function assertRetentionEnvironmentConfigured(
  env: NodeJS.ProcessEnv = process.env,
): Exclude<RetentionEnvironment, 'UNRESOLVED'> {
  const details = resolveRetentionEnvironmentDetails(env)
  if (details.environment === 'UNRESOLVED') {
    const cairn = (env.CAIRN_ENV || '').trim()
    const app = (env.APP_ENV || '').trim()
    const node = (env.NODE_ENV || '').trim()
    const vitest = (env.VITEST || '').trim()
    const weakHint = details.weakTestSignal
      ? ` R4: NODE_ENV=test/VITEST alone cannot authorize retention under production-like runtime (productionLike=true, source=${details.source}); set CAIRN_ENV=local|test|staging|production.`
      : ''
    throw new Error(
      `retention environment UNRESOLVED (fail-closed): set CAIRN_ENV or APP_ENV to ` +
        `local|test|staging|production (got CAIRN_ENV=${JSON.stringify(cairn)} ` +
        `APP_ENV=${JSON.stringify(app)} NODE_ENV=${JSON.stringify(node)} ` +
        `VITEST=${JSON.stringify(vitest)}). ` +
        `Missing/unknown non-test env must not invent LOCAL staging-proposal policy.` +
        weakHint,
    )
  }
  return details.environment
}

export type AuditEventClass = 'HEARTBEAT' | 'MATERIAL' | 'SAMPLED' | 'ROLLUP'

export interface BoardPolicyRetention {
  policyId: string
  policyVersion: string
  /** Sample every N heartbeats into sampled stream (hot state always updated). */
  heartbeatSampleInterval: number
  /** Hot-state retention window (ms). */
  hotStateRetentionMs: number
  /** Sampled heartbeat event retention (ms). */
  sampledEventRetentionMs: number
  /** Rollup retention (ms). */
  rollupRetentionMs: number
  /** Compaction interval (ms). */
  compactionIntervalMs: number
  /** Explicit environment this policy is approved for (never UNRESOLVED). */
  approvedFor: ReadonlyArray<Exclude<RetentionEnvironment, 'UNRESOLVED'>>
}

/** Explicit staging proposal — never auto-promoted to production. */
export const STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY: BoardPolicyRetention = {
  policyId: 'staging-proposed-heartbeat-retention-v1',
  policyVersion: '1.0.0',
  heartbeatSampleInterval: 10,
  hotStateRetentionMs: 24 * 60 * 60 * 1000,
  sampledEventRetentionMs: 7 * 24 * 60 * 60 * 1000,
  rollupRetentionMs: 30 * 24 * 60 * 60 * 1000,
  compactionIntervalMs: 60 * 60 * 1000,
  approvedFor: ['STAGING', 'LOCAL', 'TEST'],
}

export interface RetentionPolicyResolveResult {
  ok: boolean
  policy: BoardPolicyRetention | null
  decisionCode: typeof DECISION_HEARTBEAT_RETENTION_POLICY | null
  source: 'SUPPLIED' | 'STAGING_PROPOSAL' | 'BLOCKED'
  message: string
}

/**
 * Resolve retention policy for environment.
 * Production without explicit approved policy → DECISION_HEARTBEAT_RETENTION_POLICY.
 * Staging without policy may use STAGING_PROPOSED only when allowStagingProposal=true.
 * UNRESOLVED (missing/unknown non-test env) → BLOCKED — never invent LOCAL proposal (H3).
 *
 * R4 proposal gate for LOCAL/TEST without supplied policy:
 * - LOCAL: auto staging-proposal (LOCAL identity only exists via CAIRN_ENV=local or
 *   disposable unit tests that pass environment:'LOCAL' as the designed local path).
 * - TEST: auto staging-proposal ONLY when explicitAppEnv=true (CAIRN_ENV/APP_ENV=test)
 *   OR allowTestRetentionProposal=true (approved test-context capability) OR
 *   allowStagingProposal=true. Bare NODE_ENV=test / VITEST → environment TEST with
 *   weakTestSignal must NOT silently authorize proposal without one of those gates.
 */
export function resolveRetentionPolicy(opts: {
  environment: RetentionEnvironment
  supplied?: BoardPolicyRetention | null
  allowStagingProposal?: boolean
  /**
   * R4: approved test-context capability (internal harness / setTestControlPlaneRuntimeContext).
   * Required for TEST staging-proposal when identity is not from explicit CAIRN_ENV/APP_ENV=test.
   * Production MCP/HTTP paths must never set this from untrusted input.
   */
  allowTestRetentionProposal?: boolean
  /**
   * True when environment was resolved from explicit CAIRN_ENV/APP_ENV known token.
   * Enables TEST auto staging-proposal without a separate capability flag.
   */
  explicitAppEnv?: boolean
}): RetentionPolicyResolveResult {
  const env = opts.environment

  // H3: unresolved identity cannot auto-apply LOCAL staging-proposal (or any policy invent).
  if (env === 'UNRESOLVED') {
    return {
      ok: false,
      policy: null,
      decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
      source: 'BLOCKED',
      message:
        'retention environment UNRESOLVED: set CAIRN_ENV or APP_ENV to local|test|staging|production — missing/unknown non-test env cannot invent LOCAL staging-proposal; open DECISION_HEARTBEAT_RETENTION_POLICY',
    }
  }

  if (opts.supplied) {
    if (!opts.supplied.approvedFor.includes(env) && env === 'PRODUCTION') {
      return {
        ok: false,
        policy: null,
        decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
        source: 'BLOCKED',
        message:
          'supplied retention policy is not approved for PRODUCTION; open DECISION_HEARTBEAT_RETENTION_POLICY',
      }
    }
    if (!opts.supplied.approvedFor.includes(env) && env !== 'TEST' && env !== 'LOCAL') {
      return {
        ok: false,
        policy: null,
        decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
        source: 'BLOCKED',
        message: `supplied retention policy not approved for ${env}`,
      }
    }
    return {
      ok: true,
      policy: opts.supplied,
      decisionCode: null,
      source: 'SUPPLIED',
      message: 'using supplied BoardPolicy retention',
    }
  }

  if (env === 'PRODUCTION') {
    return {
      ok: false,
      policy: null,
      decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
      source: 'BLOCKED',
      message:
        'no production heartbeat retention policy supplied; create DECISION_HEARTBEAT_RETENTION_POLICY — do not invent production retention silently',
    }
  }

  // LOCAL: designed disposable/local path — staging proposal allowed (never UNRESOLVED).
  if (env === 'LOCAL') {
    return {
      ok: true,
      policy: STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      decisionCode: null,
      source: 'STAGING_PROPOSAL',
      message: 'using explicit staging-proposed heartbeat retention policy',
    }
  }

  // R4: TEST must not silently authorize staging proposal from NODE_ENV=test/VITEST alone.
  // Require explicit CAIRN_ENV/APP_ENV=test (explicitAppEnv) or approved test capability.
  if (env === 'TEST') {
    const authorized =
      opts.explicitAppEnv === true ||
      opts.allowTestRetentionProposal === true ||
      opts.allowStagingProposal === true
    if (!authorized) {
      return {
        ok: false,
        policy: null,
        decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
        source: 'BLOCKED',
        message:
          'TEST retention staging-proposal blocked (R4): NODE_ENV=test/VITEST alone must not authorize staging-proposed retention — set CAIRN_ENV=test|local, pass explicitAppEnv from resolveRetentionEnvironmentDetails, or allowTestRetentionProposal from approved test context; open DECISION_HEARTBEAT_RETENTION_POLICY',
      }
    }
    return {
      ok: true,
      policy: STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      decisionCode: null,
      source: 'STAGING_PROPOSAL',
      message: 'using explicit staging-proposed heartbeat retention policy',
    }
  }

  // STAGING requires explicit allowStagingProposal=true (never silent).
  if (env === 'STAGING') {
    if (!opts.allowStagingProposal) {
      return {
        ok: false,
        policy: null,
        decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
        source: 'BLOCKED',
        message:
          'staging retention requires explicit allowStagingProposal or supplied policy',
      }
    }
    return {
      ok: true,
      policy: STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      decisionCode: null,
      source: 'STAGING_PROPOSAL',
      message: 'using explicit staging-proposed heartbeat retention policy',
    }
  }

  return {
    ok: false,
    policy: null,
    decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
    source: 'BLOCKED',
    message: 'retention policy unresolved',
  }
}

export interface HotRunState {
  runId: string
  boardId: string
  lastHeartbeatAtMs: number
  heartbeatSequence: number
  status: string
  materialProgressAtMs: number | null
}

export interface AuditRecord {
  id: string
  boardId: string
  runId?: string | null
  eventClass: AuditEventClass
  eventType: string
  atMs: number
  /** Material events only may set immutable=true. */
  immutable: boolean
  payload: Record<string, unknown>
}

export interface HeartbeatInput {
  runId: string
  boardId: string
  sequence: number
  atMs: number
  status: string
  materialProgress?: boolean
  /** Optional safe fields only. */
  meta?: Record<string, unknown>
}

export interface HeartbeatApplyResult {
  hot: HotRunState
  /** Sampled audit row (not immutable). Null when not on sample interval. */
  sampled: AuditRecord | null
  /** Material immutable audit row when materialProgress=true. */
  material: AuditRecord | null
  /** Heartbeats never create immutable audit by themselves. */
  immutableHeartbeatCreated: false
}

export interface RetentionStore {
  getHot(runId: string): HotRunState | null
  putHot(state: HotRunState): void
  listHot(boardId?: string): Array<HotRunState>
  deleteHot(runId: string): void
  appendAudit(record: AuditRecord): void
  listAudit(filter?: {
    boardId?: string
    eventClass?: AuditEventClass
    immutable?: boolean
  }): Array<AuditRecord>
  deleteAudit(id: string): void
}

export function createMemoryRetentionStore(): RetentionStore {
  const hot = new Map<string, HotRunState>()
  const audit: Array<AuditRecord> = []
  return {
    getHot: (runId) => hot.get(runId) ?? null,
    putHot: (state) => {
      hot.set(state.runId, state)
    },
    listHot: (boardId) =>
      [...hot.values()].filter((h) => (boardId ? h.boardId === boardId : true)),
    deleteHot: (runId) => {
      hot.delete(runId)
    },
    appendAudit: (record) => {
      audit.push(record)
    },
    listAudit: (filter) =>
      audit.filter((r) => {
        if (filter?.boardId && r.boardId !== filter.boardId) return false
        if (filter?.eventClass && r.eventClass !== filter.eventClass) return false
        if (filter?.immutable != null && r.immutable !== filter.immutable) return false
        return true
      }),
    deleteAudit: (id) => {
      const idx = audit.findIndex((r) => r.id === id)
      if (idx >= 0) audit.splice(idx, 1)
    },
  }
}

let _seq = 0
function nextId(prefix: string): string {
  _seq += 1
  return `${prefix}-${_seq}`
}

/**
 * Apply heartbeat: always updates hot state; samples periodically;
 * material events only when materialProgress is true.
 * NEVER writes immutable audit for pure heartbeats (AC-OPS-04).
 */
export function applyHeartbeat(
  input: HeartbeatInput,
  policy: BoardPolicyRetention,
  store: RetentionStore,
): HeartbeatApplyResult {
  const prev = store.getHot(input.runId)
  const hot: HotRunState = {
    runId: input.runId,
    boardId: input.boardId,
    lastHeartbeatAtMs: input.atMs,
    heartbeatSequence: input.sequence,
    status: input.status,
    materialProgressAtMs: input.materialProgress
      ? input.atMs
      : (prev?.materialProgressAtMs ?? null),
  }
  store.putHot(hot)

  let sampled: AuditRecord | null = null
  const sampleEvery = Math.max(1, policy.heartbeatSampleInterval)
  if (input.sequence % sampleEvery === 0) {
    sampled = {
      id: nextId('sample'),
      boardId: input.boardId,
      runId: input.runId,
      eventClass: 'SAMPLED',
      eventType: 'heartbeat_sample',
      atMs: input.atMs,
      immutable: false,
      payload: {
        sequence: input.sequence,
        status: input.status,
      },
    }
    store.appendAudit(sampled)
  }

  let material: AuditRecord | null = null
  if (input.materialProgress) {
    material = {
      id: nextId('material'),
      boardId: input.boardId,
      runId: input.runId,
      eventClass: 'MATERIAL',
      eventType: 'material_progress',
      atMs: input.atMs,
      immutable: true,
      payload: {
        sequence: input.sequence,
        status: input.status,
      },
    }
    store.appendAudit(material)
  }

  return {
    hot,
    sampled,
    material,
    immutableHeartbeatCreated: false,
  }
}

export interface CompactionResult {
  deletedHot: number
  deletedSampled: number
  deletedRollup: number
  retainedMaterial: number
  atMs: number
}

/**
 * Compact hot/sampled/rollup by retention windows.
 * Never deletes immutable MATERIAL audit rows (AC-OPS-04/05).
 */
export function compactRetention(opts: {
  policy: BoardPolicyRetention
  store: RetentionStore
  nowMs: number
  boardId?: string
}): CompactionResult {
  const { policy, store, nowMs, boardId } = opts
  let deletedHot = 0
  let deletedSampled = 0
  let deletedRollup = 0

  for (const h of store.listHot(boardId)) {
    if (nowMs - h.lastHeartbeatAtMs > policy.hotStateRetentionMs) {
      store.deleteHot(h.runId)
      deletedHot += 1
    }
  }

  const audits = store.listAudit(boardId ? { boardId } : undefined)
  let retainedMaterial = 0
  for (const a of audits) {
    if (a.immutable && a.eventClass === 'MATERIAL') {
      retainedMaterial += 1
      continue
    }
    if (a.eventClass === 'SAMPLED' || a.eventClass === 'HEARTBEAT') {
      if (nowMs - a.atMs > policy.sampledEventRetentionMs) {
        store.deleteAudit(a.id)
        deletedSampled += 1
      }
    } else if (a.eventClass === 'ROLLUP') {
      if (nowMs - a.atMs > policy.rollupRetentionMs) {
        store.deleteAudit(a.id)
        deletedRollup += 1
      }
    }
  }

  return {
    deletedHot,
    deletedSampled,
    deletedRollup,
    retainedMaterial,
    atMs: nowMs,
  }
}

/**
 * Production wiring helper for run-registry heartbeat path (AC-OPS-04/05).
 * Always applies hot/sample/material domain update; runs compaction only when
 * the policy compactionInterval has elapsed since lastCompactionAtMs.
 * Does NOT invent a policy — caller must supply an already-resolved BoardPolicy.
 */
export function applyHeartbeatWithOptionalCompaction(opts: {
  input: HeartbeatInput
  policy: BoardPolicyRetention
  store: RetentionStore
  lastCompactionAtMs: number
}): {
  apply: HeartbeatApplyResult
  compaction: CompactionResult | null
  nextLastCompactionAtMs: number
} {
  const apply = applyHeartbeat(opts.input, opts.policy, opts.store)
  const interval = Math.max(1, opts.policy.compactionIntervalMs)
  if (opts.input.atMs - opts.lastCompactionAtMs < interval) {
    return {
      apply,
      compaction: null,
      nextLastCompactionAtMs: opts.lastCompactionAtMs,
    }
  }
  const compaction = compactRetention({
    policy: opts.policy,
    store: opts.store,
    nowMs: opts.input.atMs,
    boardId: opts.input.boardId,
  })
  return {
    apply,
    compaction,
    nextLastCompactionAtMs: opts.input.atMs,
  }
}

/**
 * Bounded reconciler-style dry-run for retention compaction (AC-OPS-05 partial).
 * maxActions caps deletions considered; idempotent when re-run with same clock.
 */
export function planRetentionCompaction(opts: {
  policy: BoardPolicyRetention
  store: RetentionStore
  nowMs: number
  boardId?: string
  maxActionsPerRun?: number
}): {
  wouldDeleteHot: Array<string>
  wouldDeleteAudit: Array<string>
  wouldRetainMaterial: Array<string>
  truncated: boolean
  maxActionsPerRun: number
} {
  const max = opts.maxActionsPerRun ?? 100
  const wouldDeleteHot: Array<string> = []
  const wouldDeleteAudit: Array<string> = []
  const wouldRetainMaterial: Array<string> = []

  for (const h of opts.store.listHot(opts.boardId)) {
    if (opts.nowMs - h.lastHeartbeatAtMs > opts.policy.hotStateRetentionMs) {
      wouldDeleteHot.push(h.runId)
    }
  }
  for (const a of opts.store.listAudit(opts.boardId ? { boardId: opts.boardId } : undefined)) {
    if (a.immutable && a.eventClass === 'MATERIAL') {
      wouldRetainMaterial.push(a.id)
      continue
    }
    if (
      (a.eventClass === 'SAMPLED' || a.eventClass === 'HEARTBEAT') &&
      opts.nowMs - a.atMs > opts.policy.sampledEventRetentionMs
    ) {
      wouldDeleteAudit.push(a.id)
    } else if (
      a.eventClass === 'ROLLUP' &&
      opts.nowMs - a.atMs > opts.policy.rollupRetentionMs
    ) {
      wouldDeleteAudit.push(a.id)
    }
  }

  const total = wouldDeleteHot.length + wouldDeleteAudit.length
  const truncated = total > max
  return {
    wouldDeleteHot: wouldDeleteHot.slice(0, max),
    wouldDeleteAudit: wouldDeleteAudit.slice(0, Math.max(0, max - wouldDeleteHot.slice(0, max).length)),
    wouldRetainMaterial,
    truncated,
    maxActionsPerRun: max,
  }
}

// ---------------------------------------------------------------------------
// Durable async retention (MySQL retentionAsync / multi-instance)
// ---------------------------------------------------------------------------

/**
 * Async store shape matching createMysqlRetentionAsyncStore.
 * boardId is explicit on every call (MySQL tables are board-scoped).
 * No process-local Maps — callers must bind a durable executor.
 */
export interface RetentionAsyncStore {
  getHot(boardId: string, runId: string): Promise<HotRunState | null>
  putHot(state: HotRunState): Promise<void>
  listHot(boardId: string): Promise<Array<HotRunState>>
  deleteHot(boardId: string, runId: string): Promise<void>
  appendAudit(record: AuditRecord): Promise<void>
  listAudit(
    boardId: string,
    filter?: { eventClass?: AuditEventClass; immutable?: boolean },
  ): Promise<Array<AuditRecord>>
  deleteAudit(boardId: string, auditId: string): Promise<void>
}

/** Durable compaction watermark eventType (ROLLUP, never MATERIAL-immutable ordinary HB). */
export const RETENTION_COMPACTION_WATERMARK_EVENT = 'retention_compaction' as const

/** Deterministic sample audit id — multi-instance / retry safe. */
export function retentionSampleAuditId(
  boardId: string,
  runId: string,
  sequence: number,
): string {
  return `sample:${boardId}:${runId}:${sequence}`
}

/** Deterministic material audit id — multi-instance / retry safe. */
export function retentionMaterialAuditId(
  boardId: string,
  runId: string,
  sequence: number,
): string {
  return `material:${boardId}:${runId}:${sequence}`
}

function isCompactionWatermark(record: AuditRecord): boolean {
  return (
    record.eventClass === 'ROLLUP' &&
    record.eventType === RETENTION_COMPACTION_WATERMARK_EVENT
  )
}

/**
 * Read durable last-compaction watermark for a board (max atMs of watermark rows).
 * Prefer this over process-local lastCompactionAtMs for multi-instance MySQL.
 */
export async function readDurableCompactionWatermarkMs(
  store: RetentionAsyncStore,
  boardId: string,
): Promise<number> {
  const rows = await store.listAudit(boardId, { eventClass: 'ROLLUP' })
  let max = 0
  for (const r of rows) {
    if (isCompactionWatermark(r) && r.atMs > max) max = r.atMs
  }
  return max
}

/**
 * Async heartbeat apply against durable RetentionAsyncStore (AC-OPS-04).
 * Always updates hot; samples on interval (immutable:false); MATERIAL only when
 * materialProgress; NEVER immutable ordinary heartbeat.
 * Uses deterministic audit ids for multi-instance/idempotent safety.
 */
export async function applyHeartbeatAsync(
  input: HeartbeatInput,
  policy: BoardPolicyRetention,
  store: RetentionAsyncStore,
): Promise<HeartbeatApplyResult> {
  const prev = await store.getHot(input.boardId, input.runId)
  const hot: HotRunState = {
    runId: input.runId,
    boardId: input.boardId,
    lastHeartbeatAtMs: input.atMs,
    heartbeatSequence: input.sequence,
    status: input.status,
    materialProgressAtMs: input.materialProgress
      ? input.atMs
      : (prev?.materialProgressAtMs ?? null),
  }
  await store.putHot(hot)

  let sampled: AuditRecord | null = null
  const sampleEvery = Math.max(1, policy.heartbeatSampleInterval)
  if (input.sequence % sampleEvery === 0) {
    sampled = {
      id: retentionSampleAuditId(input.boardId, input.runId, input.sequence),
      boardId: input.boardId,
      runId: input.runId,
      eventClass: 'SAMPLED',
      eventType: 'heartbeat_sample',
      atMs: input.atMs,
      immutable: false,
      payload: {
        sequence: input.sequence,
        status: input.status,
      },
    }
    try {
      await store.appendAudit(sampled)
    } catch (e) {
      // Idempotent retry: same deterministic id may already exist.
      const msg = e instanceof Error ? e.message : String(e)
      if (!/Duplicate|ER_DUP_ENTRY|1062/i.test(msg)) throw e
    }
  }

  let material: AuditRecord | null = null
  if (input.materialProgress) {
    material = {
      id: retentionMaterialAuditId(input.boardId, input.runId, input.sequence),
      boardId: input.boardId,
      runId: input.runId,
      eventClass: 'MATERIAL',
      eventType: 'material_progress',
      atMs: input.atMs,
      immutable: true,
      payload: {
        sequence: input.sequence,
        status: input.status,
      },
    }
    try {
      await store.appendAudit(material)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      if (!/Duplicate|ER_DUP_ENTRY|1062/i.test(msg)) throw e
    }
  }

  return {
    hot,
    sampled,
    material,
    immutableHeartbeatCreated: false,
  }
}

/**
 * Async compact: durable hot/sampled/rollup windows; never deletes MATERIAL immutable
 * or compaction watermarks. Bounded by maxActionsPerRun (default 100).
 * Idempotent when re-run at same nowMs after work is done.
 */
export async function compactRetentionAsync(opts: {
  policy: BoardPolicyRetention
  store: RetentionAsyncStore
  nowMs: number
  boardId: string
  maxActionsPerRun?: number
}): Promise<CompactionResult & { truncated: boolean; maxActionsPerRun: number }> {
  const { policy, store, nowMs, boardId } = opts
  const max = opts.maxActionsPerRun ?? 100
  let deletedHot = 0
  let deletedSampled = 0
  let deletedRollup = 0
  let actions = 0
  let truncated = false

  for (const h of await store.listHot(boardId)) {
    if (actions >= max) {
      truncated = true
      break
    }
    if (nowMs - h.lastHeartbeatAtMs > policy.hotStateRetentionMs) {
      await store.deleteHot(boardId, h.runId)
      deletedHot += 1
      actions += 1
    }
  }

  const audits = await store.listAudit(boardId)
  // Always count material retainers (even when action budget truncates deletes).
  let retainedMaterial = 0
  for (const a of audits) {
    if (a.immutable && a.eventClass === 'MATERIAL') retainedMaterial += 1
  }
  for (const a of audits) {
    if (a.immutable && a.eventClass === 'MATERIAL') continue
    if (isCompactionWatermark(a)) {
      // Durable multi-instance watermark — never compact away.
      continue
    }
    if (actions >= max) {
      truncated = true
      break
    }
    if (a.eventClass === 'SAMPLED' || a.eventClass === 'HEARTBEAT') {
      if (nowMs - a.atMs > policy.sampledEventRetentionMs) {
        await store.deleteAudit(boardId, a.id)
        deletedSampled += 1
        actions += 1
      }
    } else if (a.eventClass === 'ROLLUP') {
      if (nowMs - a.atMs > policy.rollupRetentionMs) {
        await store.deleteAudit(boardId, a.id)
        deletedRollup += 1
        actions += 1
      }
    }
  }

  // Persist durable watermark so other instances observe compaction time.
  const watermark: AuditRecord = {
    id: `compaction-wm:${boardId}:${nowMs}`,
    boardId,
    runId: null,
    eventClass: 'ROLLUP',
    eventType: RETENTION_COMPACTION_WATERMARK_EVENT,
    atMs: nowMs,
    immutable: false,
    payload: {
      deletedHot,
      deletedSampled,
      deletedRollup,
      retainedMaterial,
      truncated,
      maxActionsPerRun: max,
    },
  }
  try {
    await store.appendAudit(watermark)
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e)
    if (!/Duplicate|ER_DUP_ENTRY|1062/i.test(msg)) throw e
  }

  return {
    deletedHot,
    deletedSampled,
    deletedRollup,
    retainedMaterial,
    atMs: nowMs,
    truncated,
    maxActionsPerRun: max,
  }
}

/**
 * Durable async apply + optional bounded compaction for heartbeatRun MySQL path.
 * Compaction interval uses durable watermark (not process memory) so multi-instance
 * is safe; compaction itself is idempotent.
 */
export async function applyHeartbeatWithOptionalCompactionAsync(opts: {
  input: HeartbeatInput
  policy: BoardPolicyRetention
  store: RetentionAsyncStore
  /** Optional process hint; durable watermark wins when higher. */
  lastCompactionAtMs?: number
  maxCompactionActions?: number
}): Promise<{
  apply: HeartbeatApplyResult
  compaction: (CompactionResult & { truncated: boolean; maxActionsPerRun: number }) | null
  nextLastCompactionAtMs: number
}> {
  const apply = await applyHeartbeatAsync(opts.input, opts.policy, opts.store)
  const durableWm = await readDurableCompactionWatermarkMs(
    opts.store,
    opts.input.boardId,
  )
  const lastCompactionAtMs = Math.max(opts.lastCompactionAtMs ?? 0, durableWm)
  const interval = Math.max(1, opts.policy.compactionIntervalMs)
  if (opts.input.atMs - lastCompactionAtMs < interval) {
    return {
      apply,
      compaction: null,
      nextLastCompactionAtMs: lastCompactionAtMs,
    }
  }
  const compaction = await compactRetentionAsync({
    policy: opts.policy,
    store: opts.store,
    nowMs: opts.input.atMs,
    boardId: opts.input.boardId,
    maxActionsPerRun: opts.maxCompactionActions,
  })
  return {
    apply,
    compaction,
    nextLastCompactionAtMs: opts.input.atMs,
  }
}
