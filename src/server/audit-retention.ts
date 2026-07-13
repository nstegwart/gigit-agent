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

export type RetentionEnvironment = 'LOCAL' | 'STAGING' | 'PRODUCTION' | 'TEST'

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
  /** Explicit environment this policy is approved for. */
  approvedFor: ReadonlyArray<RetentionEnvironment>
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
 */
export function resolveRetentionPolicy(opts: {
  environment: RetentionEnvironment
  supplied?: BoardPolicyRetention | null
  allowStagingProposal?: boolean
}): RetentionPolicyResolveResult {
  const env = opts.environment
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

  // LOCAL/TEST may use the explicit staging proposal by default.
  if (env === 'LOCAL' || env === 'TEST') {
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
