import { describe, expect, it } from 'vitest'

import {
  OBSERVABILITY_INTEGRATION_SCHEMA,
  STAGING_RUNBOOKS,
  V3_ALERT_IDS,
  V3_METRIC_CATEGORIES,
  createMemoryLogSink,
  createObservabilityIntegration,
  evaluateAccountSyncStaleAlert,
  evaluateClaimLockAnomalyAlert,
  evaluateLatencyErrorBudgetAlert,
  evaluateLiveMcpUnauthorizedAlert,
  evaluateRepeatedImportReconcileAlert,
  runbookForAlert,
} from '#/server/observability-integration'

describe('OPS-OBS-WIRE foundation — integration facade', () => {
  it('exports schema and creates memory-only integration', () => {
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-13T19:17:07.000Z',
      nowMs: () => 1_000_000,
    })
    expect(obs.schema).toBe(OBSERVABILITY_INTEGRATION_SCHEMA)
    expect(obs.runbooks).toBe(STAGING_RUNBOOKS)
    expect(obs.facade.runbooks.length).toBe(V3_ALERT_IDS.length)
  })

  it('beginRequest emits sanitized structured log + latency metric', () => {
    const sink = createMemoryLogSink()
    let t = 1000
    const obs = createObservabilityIntegration({
      sink,
      nowIso: () => '2026-07-13T19:17:07.000Z',
      nowMs: () => {
        t += 25
        return t
      },
    })
    const handle = obs.beginRequest({
      requestId: 'req-1',
      endpoint: '/api/public-snapshot',
      method: 'GET',
      boardId: 'b1',
      actorRole: 'PUBLIC',
      actorId: null,
      channel: 'http',
      meta: { token: 'leak-me', route: 'public' },
    })
    const log = handle.end({ result: 'ok' })
    expect(log.requestId).toBe('req-1')
    expect(log.endpoint).toBe('/api/public-snapshot')
    expect(log.event).toBe('request')
    expect(log.result).toBe('ok')
    expect(log.latencyMs).toBeGreaterThanOrEqual(0)
    expect(log.meta?.token).toBe('[REDACTED]')
    expect(log.meta?.route).toBe('public')
    expect(JSON.stringify(log)).not.toContain('leak-me')
    expect(obs.metrics.count('api_latency_ms')).toBe(1)
    expect(sink.snapshot()).toHaveLength(1)
  })

  it('records auth_denies and api_error_rate from results', () => {
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-13T19:17:07.000Z',
      nowMs: () => 5000,
    })
    obs.beginRequest({
      requestId: 'r-deny',
      endpoint: '/api/x',
    }).end({ result: 'deny', errorCode: 'UNAUTHORIZED', latencyMs: 3 })
    obs.beginRequest({
      requestId: 'r-err',
      endpoint: '/api/y',
    }).end({ result: 'error', errorCode: 'INTERNAL', latencyMs: 9 })
    expect(obs.metrics.sum('auth_denies')).toBe(1)
    expect(obs.metrics.sum('api_error_rate')).toBe(1)
  })

  it('observeMcp logs mcp:tool endpoint and redacts secrets', () => {
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-13T19:17:07.000Z',
    })
    const log = obs.observeMcp(
      {
        requestId: 'mcp-1',
        toolName: 'register_runner',
        actorRole: 'AGENT',
        actorId: 'agent-9',
        meta: { password: 'p', authorization: 'Bearer abc', ok: true },
      },
      { result: 'ok', latencyMs: 15 },
    )
    expect(log.endpoint).toBe('mcp:register_runner')
    expect(log.event).toBe('mcp_tool')
    expect(log.actorRole).toBe('AGENT')
    expect(log.meta?.password).toBe('[REDACTED]')
    expect(log.meta?.authorization).toBe('[REDACTED]')
    expect(log.meta?.ok).toBe(true)
    expect(obs.metrics.count('api_latency_ms')).toBe(1)
  })

  it('evaluateAlerts activates states with runbook IDs for all V3 alerts', () => {
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-13T19:17:07.000Z',
    })
    const evals = obs.evaluateAlerts({
      nowIso: '2026-07-13T19:17:07.000Z',
      releaseMatch: false,
      schemaMatch: true,
      publicSnapshotAgeMs: 200_000,
      publicationIntervalMs: 60_000,
      p95LatencyMs: 900,
      errorRate: 0.05,
      repeatedImportReconcileFailures: 5,
      liveMcpUnauthorizedExposure: true,
      accountSyncAgeMs: 99_999_999,
      claimLockAnomaly: true,
    })
    expect(evals.length).toBe(V3_ALERT_IDS.length)
    for (const e of evals) {
      expect(e.state.active).toBe(true)
      expect(e.runbookId).toBeTruthy()
      expect(e.runbook).not.toBeNull()
      expect(e.runbook?.runbookId).toBe(e.runbookId)
      expect(e.runbook?.steps.length).toBeGreaterThan(0)
      expect(obs.alerts.get(e.alertId)?.active).toBe(true)
    }
    // runbook lookup parity
    for (const id of V3_ALERT_IDS) {
      expect(runbookForAlert(id)?.alertId).toBe(id)
    }
  })

  it('evaluateAlerts clears-to-inactive when signals healthy', () => {
    const obs = createObservabilityIntegration()
    const evals = obs.evaluateAlerts({
      nowIso: '2026-07-13T19:17:07.000Z',
      releaseMatch: true,
      schemaMatch: true,
      publicSnapshotAgeMs: 1_000,
      publicationIntervalMs: 60_000,
      p95LatencyMs: 10,
      errorRate: 0,
      repeatedImportReconcileFailures: 0,
      liveMcpUnauthorizedExposure: false,
      accountSyncAgeMs: 100,
      claimLockAnomaly: false,
    })
    expect(evals.every((e) => e.state.active === false)).toBe(true)
    expect(obs.alerts.listActive()).toHaveLength(0)
  })

  it('standalone alert evaluators cover remaining IDs', () => {
    const nowIso = '2026-07-13T19:17:07.000Z'
    expect(
      evaluateLatencyErrorBudgetAlert({
        p95LatencyMs: 1000,
        errorRate: 0,
        nowIso,
      }).active,
    ).toBe(true)
    expect(
      evaluateLatencyErrorBudgetAlert({
        p95LatencyMs: 10,
        errorRate: 0.5,
        nowIso,
      }).active,
    ).toBe(true)
    expect(
      evaluateLatencyErrorBudgetAlert({
        p95LatencyMs: 10,
        errorRate: 0,
        nowIso,
      }).active,
    ).toBe(false)

    expect(
      evaluateRepeatedImportReconcileAlert({ failureCount: 3, nowIso }).active,
    ).toBe(true)
    expect(
      evaluateRepeatedImportReconcileAlert({ failureCount: 1, nowIso }).active,
    ).toBe(false)

    expect(evaluateLiveMcpUnauthorizedAlert({ exposed: true, nowIso }).active).toBe(
      true,
    )
    expect(
      evaluateAccountSyncStaleAlert({ ageMs: 10 ** 9, nowIso }).active,
    ).toBe(true)
    expect(evaluateClaimLockAnomalyAlert({ anomaly: true, nowIso }).active).toBe(
      true,
    )
  })

  it('selfTest passes without secret leakage and covers metric/alert surface', () => {
    const obs = createObservabilityIntegration()
    const r = obs.selfTest()
    expect(r.ok).toBe(true)
    expect(r.metricCategoriesCovered).toBe(V3_METRIC_CATEGORIES.length)
    expect(r.alertsWithRunbooks).toBe(V3_ALERT_IDS.length)
    expect(r.residualGaps.some((g) => /not wired/i.test(g))).toBe(true)
  })

  it('log helper redacts via shared facade path', () => {
    const obs = createObservabilityIntegration({
      nowIso: () => '2026-07-13T00:00:00.000Z',
    })
    const log = obs.log({
      requestId: 'x',
      endpoint: '/internal',
      event: 'probe',
      meta: { apiKey: 'k', board: 'b' },
    })
    expect(log.meta?.apiKey).toBe('[REDACTED]')
    expect(log.meta?.board).toBe('b')
    expect(obs.logSnapshot()).toHaveLength(1)
  })

  it('beginRequest/observeMcp fail-closed on cookieHeader/authHeader JWT+session', () => {
    const RAW_JWT =
      'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'
    const RAW_SESSION_COOKIE =
      'session=s%3Araw-session-secret-value-DO-NOT-LOG.signature; Path=/; HttpOnly'

    const sink = createMemoryLogSink()
    const obs = createObservabilityIntegration({
      sink,
      nowIso: () => '2026-07-13T19:17:07.000Z',
      nowMs: () => 2000,
    })

    const httpLog = obs
      .beginRequest({
        requestId: 'req-hdr',
        endpoint: '/api/public-snapshot',
        method: 'GET',
        boardId: 'b1',
        actorRole: 'PUBLIC',
        channel: 'http',
        meta: {
          cookieHeader: RAW_SESSION_COOKIE,
          authHeader: `Bearer ${RAW_JWT}`,
          route: 'public',
        },
      })
      .end({ result: 'ok' })

    expect(httpLog.requestId).toBe('req-hdr')
    expect(httpLog.endpoint).toBe('/api/public-snapshot')
    expect(httpLog.event).toBe('request')
    expect(httpLog.result).toBe('ok')
    expect(httpLog.boardId).toBe('b1')
    expect(httpLog.meta?.route).toBe('public')
    expect(httpLog.meta?.cookieHeader).toBe('[REDACTED]')
    expect(httpLog.meta?.authHeader).toBe('[REDACTED]')
    expect(obs.metrics.count('api_latency_ms')).toBe(1)

    const mcpLog = obs.observeMcp(
      {
        requestId: 'mcp-hdr',
        toolName: 'register_runner',
        actorRole: 'AGENT',
        meta: {
          Cookie: RAW_SESSION_COOKIE,
          Authorization: `Bearer ${RAW_JWT}`,
          ok: true,
        },
      },
      { result: 'ok', latencyMs: 4 },
    )
    expect(mcpLog.endpoint).toBe('mcp:register_runner')
    expect(mcpLog.meta?.Cookie).toBe('[REDACTED]')
    expect(mcpLog.meta?.Authorization).toBe('[REDACTED]')
    expect(mcpLog.meta?.ok).toBe(true)

    const dumped = JSON.stringify(sink.snapshot())
    expect(dumped).not.toContain(RAW_JWT)
    expect(dumped).not.toContain('raw-session-secret-value-DO-NOT-LOG')
    expect(dumped).not.toContain(RAW_SESSION_COOKIE)
  })
})
