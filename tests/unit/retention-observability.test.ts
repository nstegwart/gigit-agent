import { describe, expect, it } from 'vitest'

import {
  DECISION_HEARTBEAT_RETENTION_POLICY,
  STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
  applyHeartbeat,
  compactRetention,
  createMemoryRetentionStore,
  planRetentionCompaction,
  resolveRetentionPolicy,
  type BoardPolicyRetention,
} from '#/server/audit-retention'
import {
  STAGING_RUNBOOKS,
  V3_ALERT_IDS,
  V3_METRIC_CATEGORIES,
  assertAllMetricCategoriesRegistered,
  buildStructuredLog,
  createMemoryAlertRegistry,
  createMemoryMetricsRegistry,
  createObservabilityFacade,
  evaluatePublicFreshnessAlert,
  evaluateReleaseSchemaAlert,
  redactForObservability,
  runbookForAlert,
} from '#/server/observability'

describe('AC-OPS-04 heartbeat is not immutable per-event audit', () => {
  it('updates hot state without immutable heartbeat audit', () => {
    const store = createMemoryRetentionStore()
    const policy = STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY
    const r1 = applyHeartbeat(
      {
        runId: 'run-1',
        boardId: 'b1',
        sequence: 1,
        atMs: 1000,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    expect(r1.immutableHeartbeatCreated).toBe(false)
    expect(r1.material).toBeNull()
    expect(r1.hot.heartbeatSequence).toBe(1)
    expect(store.getHot('run-1')?.status).toBe('RUNNING')

    // Pure heartbeats: no MATERIAL immutable rows
    for (let seq = 2; seq <= 9; seq++) {
      applyHeartbeat(
        {
          runId: 'run-1',
          boardId: 'b1',
          sequence: seq,
          atMs: 1000 + seq,
          status: 'RUNNING',
        },
        policy,
        store,
      )
    }
    const material = store.listAudit({ eventClass: 'MATERIAL', immutable: true })
    expect(material).toHaveLength(0)
  })

  it('samples on heartbeatSampleInterval without immutability', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 5,
    }
    for (let seq = 1; seq <= 10; seq++) {
      applyHeartbeat(
        {
          runId: 'run-1',
          boardId: 'b1',
          sequence: seq,
          atMs: seq * 1000,
          status: 'RUNNING',
        },
        policy,
        store,
      )
    }
    const sampled = store.listAudit({ eventClass: 'SAMPLED' })
    // sequences 5 and 10
    expect(sampled).toHaveLength(2)
    expect(sampled.every((s) => s.immutable === false)).toBe(true)
  })

  it('material progress creates immutable MATERIAL audit only', () => {
    const store = createMemoryRetentionStore()
    const r = applyHeartbeat(
      {
        runId: 'run-1',
        boardId: 'b1',
        sequence: 3,
        atMs: 3000,
        status: 'RUNNING',
        materialProgress: true,
      },
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      store,
    )
    expect(r.material?.immutable).toBe(true)
    expect(r.material?.eventClass).toBe('MATERIAL')
    expect(r.immutableHeartbeatCreated).toBe(false)
    expect(store.listAudit({ immutable: true })).toHaveLength(1)
  })
})

describe('AC-OPS-05 retention / compaction + DECISION policy', () => {
  it('PRODUCTION without policy returns DECISION_HEARTBEAT_RETENTION_POLICY', () => {
    const r = resolveRetentionPolicy({ environment: 'PRODUCTION' })
    expect(r.ok).toBe(false)
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
    expect(r.policy).toBeNull()
    expect(r.source).toBe('BLOCKED')
  })

  it('does not silently default production even with staging-only supplied policy', () => {
    const r = resolveRetentionPolicy({
      environment: 'PRODUCTION',
      supplied: STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
    })
    expect(r.ok).toBe(false)
    expect(r.decisionCode).toBe(DECISION_HEARTBEAT_RETENTION_POLICY)
  })

  it('staging requires explicit allowStagingProposal', () => {
    const blocked = resolveRetentionPolicy({ environment: 'STAGING' })
    expect(blocked.ok).toBe(false)
    const allowed = resolveRetentionPolicy({
      environment: 'STAGING',
      allowStagingProposal: true,
    })
    expect(allowed.ok).toBe(true)
    expect(allowed.source).toBe('STAGING_PROPOSAL')
    expect(allowed.policy?.policyId).toBe(
      STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY.policyId,
    )
  })

  it('LOCAL/TEST use explicit staging proposal', () => {
    expect(resolveRetentionPolicy({ environment: 'LOCAL' }).ok).toBe(true)
    expect(resolveRetentionPolicy({ environment: 'TEST' }).source).toBe(
      'STAGING_PROPOSAL',
    )
  })

  it('supplied production-approved policy is accepted', () => {
    const prodPolicy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      policyId: 'prod-retention-v1',
      approvedFor: ['PRODUCTION'],
    }
    const r = resolveRetentionPolicy({
      environment: 'PRODUCTION',
      supplied: prodPolicy,
    })
    expect(r.ok).toBe(true)
    expect(r.source).toBe('SUPPLIED')
  })

  it('compacts hot/sampled/rollup and retains material immutable', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      hotStateRetentionMs: 1000,
      sampledEventRetentionMs: 1000,
      rollupRetentionMs: 1000,
    }
    applyHeartbeat(
      {
        runId: 'old-run',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    applyHeartbeat(
      {
        runId: 'mat-run',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
        materialProgress: true,
      },
      policy,
      store,
    )
    store.appendAudit({
      id: 'rollup-old',
      boardId: 'b1',
      eventClass: 'ROLLUP',
      eventType: 'rollup',
      atMs: 0,
      immutable: false,
      payload: {},
    })

    const result = compactRetention({
      policy,
      store,
      nowMs: 5000,
      boardId: 'b1',
    })
    expect(result.deletedHot).toBeGreaterThanOrEqual(1)
    expect(result.deletedSampled).toBeGreaterThanOrEqual(1)
    expect(result.deletedRollup).toBe(1)
    expect(result.retainedMaterial).toBe(1)
    expect(store.listAudit({ immutable: true })).toHaveLength(1)
  })

  it('planRetentionCompaction is bounded and retains material', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      hotStateRetentionMs: 10,
      sampledEventRetentionMs: 10,
    }
    for (let i = 0; i < 5; i++) {
      applyHeartbeat(
        {
          runId: `r-${i}`,
          boardId: 'b1',
          sequence: 1,
          atMs: 0,
          status: 'RUNNING',
          materialProgress: i === 0,
        },
        { ...policy, heartbeatSampleInterval: 1 },
        store,
      )
    }
    const plan = planRetentionCompaction({
      policy,
      store,
      nowMs: 100_000,
      maxActionsPerRun: 3,
    })
    expect(plan.maxActionsPerRun).toBe(3)
    expect(plan.wouldRetainMaterial.length).toBeGreaterThanOrEqual(1)
    expect(
      plan.wouldDeleteHot.length + plan.wouldDeleteAudit.length,
    ).toBeLessThanOrEqual(3)
  })

  it('compaction is idempotent when re-run at same nowMs', () => {
    const store = createMemoryRetentionStore()
    const policy: BoardPolicyRetention = {
      ...STAGING_PROPOSED_HEARTBEAT_RETENTION_POLICY,
      heartbeatSampleInterval: 1,
      hotStateRetentionMs: 1,
      sampledEventRetentionMs: 1,
    }
    applyHeartbeat(
      {
        runId: 'r1',
        boardId: 'b1',
        sequence: 1,
        atMs: 0,
        status: 'RUNNING',
      },
      policy,
      store,
    )
    const a = compactRetention({ policy, store, nowMs: 10_000 })
    const b = compactRetention({ policy, store, nowMs: 10_000 })
    expect(a.deletedHot).toBe(1)
    expect(b.deletedHot).toBe(0)
    expect(b.deletedSampled).toBe(0)
  })
})

describe('AC-OPS-02 structured log redaction', () => {
  it('buildStructuredLog includes exact safe fields', () => {
    const log = buildStructuredLog({
      requestId: 'req-1',
      endpoint: '/api/public-snapshot',
      event: 'get',
      boardId: 'b1',
      actorRole: 'PUBLIC',
      actorId: null,
      result: 'ok',
      errorCode: null,
      latencyMs: 12,
      boardRev: 10,
      lifecycleRev: 5,
    })
    expect(log.timestamp).toBeTruthy()
    expect(log.requestId).toBe('req-1')
    expect(log.boardId).toBe('b1')
    expect(log.actorRole).toBe('PUBLIC')
    expect(log.endpoint).toBe('/api/public-snapshot')
    expect(log.event).toBe('get')
    expect(log.result).toBe('ok')
    expect(log.latencyMs).toBe(12)
    expect(log.boardRev).toBe(10)
    expect(log.lifecycleRev).toBe(5)
  })

  it('redacts secrets, tokens, comments, evidence, private decision text', () => {
    const redacted = redactForObservability({
      token: 'super-secret',
      password: 'p',
      apiKey: 'k',
      authorization: 'Bearer abc',
      comments: 'private owner note',
      decisionText: 'should not log',
      evidenceBody: 'blob',
      safe: 'ok',
      nested: { refreshToken: 'r', count: 1 },
    }) as Record<string, unknown>
    expect(redacted.token).toBe('[REDACTED]')
    expect(redacted.password).toBe('[REDACTED]')
    expect(redacted.apiKey).toBe('[REDACTED]')
    expect(redacted.comments).toBe('[REDACTED]')
    expect(redacted.decisionText).toBe('[REDACTED]')
    expect(redacted.evidenceBody).toBe('[REDACTED]')
    expect(redacted.safe).toBe('ok')
    expect((redacted.nested as Record<string, unknown>).refreshToken).toBe(
      '[REDACTED]',
    )
    expect((redacted.nested as Record<string, unknown>).count).toBe(1)
  })

  it('redacts secret-looking string values', () => {
    expect(redactForObservability('Bearer abcdefghijklmnop')).toBe('[REDACTED]')
    expect(redactForObservability('sk-abcdefghijklmnop')).toBe('[REDACTED]')
  })

  it('log meta is redacted', () => {
    const log = buildStructuredLog({
      requestId: 'r',
      endpoint: '/x',
      event: 'e',
      meta: { token: 'leak', board: 'b1' },
    })
    expect(log.meta?.token).toBe('[REDACTED]')
    expect(log.meta?.board).toBe('b1')
  })
})

describe('AC-OPS-03 metrics / alerts / runbook', () => {
  it('registers every V3 metric category', () => {
    const metrics = createMemoryMetricsRegistry(() => 1000)
    for (const cat of V3_METRIC_CATEGORIES) {
      metrics.observe(cat, 1)
    }
    const check = assertAllMetricCategoriesRegistered(
      metrics.snapshot().map((s) => s.category),
    )
    expect(check.ok).toBe(true)
    expect(check.missing).toEqual([])
    expect(V3_METRIC_CATEGORIES.length).toBeGreaterThanOrEqual(18)
  })

  it('metrics sum/count and never keep secret labels', () => {
    const metrics = createMemoryMetricsRegistry()
    metrics.increment('auth_denies', 2, { token: 'x', reason: 'missing' })
    metrics.observe('api_latency_ms', 40, { route: 'public-snapshot' })
    expect(metrics.sum('auth_denies')).toBe(2)
    expect(metrics.count('api_latency_ms')).toBe(1)
    const sample = metrics.snapshot().find((s) => s.category === 'auth_denies')
    expect(sample?.labels?.token).toBeUndefined()
    expect(sample?.labels?.reason).toBe('missing')
  })

  it('has alert ids + runbook metadata for each V3 alert', () => {
    expect(V3_ALERT_IDS.length).toBe(7)
    for (const id of V3_ALERT_IDS) {
      const rb = runbookForAlert(id)
      expect(rb).not.toBeNull()
      expect(rb?.steps.length).toBeGreaterThan(0)
      expect(rb?.runbookId).toBeTruthy()
    }
    expect(STAGING_RUNBOOKS.length).toBe(V3_ALERT_IDS.length)
  })

  it('public freshness alert activates above 2 intervals', () => {
    const active = evaluatePublicFreshnessAlert({
      ageMs: 121_000,
      publicationIntervalMs: 60_000,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    expect(active.active).toBe(true)
    expect(active.severity).toBe('critical')
    expect(active.runbookId).toBe('rb-public-freshness-stale')

    const ok = evaluatePublicFreshnessAlert({
      ageMs: 30_000,
      publicationIntervalMs: 60_000,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    expect(ok.active).toBe(false)
  })

  it('release/schema alert and registry', () => {
    const alerts = createMemoryAlertRegistry()
    const a = evaluateReleaseSchemaAlert({
      releaseMatch: false,
      schemaMatch: true,
      nowIso: '2026-07-13T00:00:00.000Z',
    })
    alerts.set(a)
    expect(alerts.listActive()).toHaveLength(1)
    expect(alerts.get('UNHEALTHY_RELEASE_SCHEMA_MISMATCH')?.active).toBe(true)
    alerts.clear('UNHEALTHY_RELEASE_SCHEMA_MISMATCH')
    expect(alerts.listActive()).toHaveLength(0)
  })

  it('observability facade wires log/metrics/alerts/runbooks', () => {
    const fac = createObservabilityFacade()
    const log = fac.log({
      requestId: '1',
      endpoint: '/api/healthz',
      event: 'health',
      result: 'ok',
    })
    expect(log.endpoint).toBe('/api/healthz')
    fac.metrics.increment('auth_denies')
    expect(fac.metrics.sum('auth_denies')).toBe(1)
    expect(fac.runbooks.length).toBeGreaterThan(0)
  })
})
