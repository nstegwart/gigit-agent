/**
 * OBS-WIRE: routes import shared observability and emit redacted logs
 * without payload secrets (LOCAL ONLY — handler-level, no live server).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  createMemoryLogSink,
  createObservabilityIntegration,
  resetSharedObservabilityIntegration,
  setSharedObservabilityIntegrationForTests,
} from '#/server/observability-integration'
import { getHealthzDeps, healthzGetHandler, setHealthzDeps } from '#/routes/api.healthz'
import {
  publicSnapshotGetHandler,
  resetPublicSnapshotDeps,
  setPublicBoardAllowlistForTests,
  setPublicSnapshotDeps,
} from '#/routes/api.public-snapshot'
import { allowAllHealthGuard, denyAllHealthGuard } from '#/server/health'
import {
  PUBLIC_SERIALIZER_VERSION,
  createMemoryPublicSnapshotStore,
  type PublicAggregationInput,
} from '#/server/public-snapshot'
import { createPublicSnapshotRateLimiter } from '#/server/rate-limit'

const RAW_JWT =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4gRG9lIiwiaWF0IjoxNTE2MjM5MDIyfQ.SflKxwRJSMeKKF2QT4fwpMeJf36POk6yJV_adQssw5c'

function minimalPublicAgg(boardId: string): PublicAggregationInput {
  return {
    boardId,
    pin: {
      canonicalSnapshotId: 'snap-wire-1',
      canonicalHash: 'a'.repeat(64),
      boardRev: 4,
      lifecycleRev: 2,
      serializerVersion: PUBLIC_SERIALIZER_VERSION,
    },
    generatedAt: '2026-07-14T00:00:00.000Z',
    publishedAt: '2026-07-14T00:00:00.000Z',
    publicationIntervalMs: 60_000,
    nowMs: Date.parse('2026-07-14T00:00:30.000Z'),
    boardRollup: {
      trackedWorkDenominator: 1,
      productDenominator: 1,
      stageProdReady: 0,
      prodReadyWithEvidence: 0,
      unclassifiedCount: 0,
      rawTaskReadinessPercent: 10,
      boardReadinessPercent: 10,
      cappedBy: null,
    },
    completion: { complete: false, g5Pass: false },
    buckets: {
      DONE: 1,
      RECONCILIATION_PENDING: 0,
      ONGOING: 0,
      NEXT: 0,
      QUEUED: 0,
      BLOCKED: 0,
    },
    staleOverlays: {},
    priorityRollup: {
      portfolioId: 'TEST',
      membershipDenominator: 0,
      priorityClosureCapacity: 0,
      allClosureCapacity: 1,
      priorityCapacityShare: null,
      majorityAllocationPass: null,
      frontierState: 'NONE',
      reason: null,
    },
    projects: [],
    features: [],
    tasks: [],
    runs: [],
    accounts: [],
    decisionCount: 0,
    g5: { g5Pass: false, domainPassCount: 0, domainRequiredCount: 9 },
  }
}

describe('OBS-WIRE healthz + public-snapshot routes', () => {
  const originalHealthzDeps = getHealthzDeps()

  afterEach(() => {
    setSharedObservabilityIntegrationForTests(null)
    resetSharedObservabilityIntegration()
    resetPublicSnapshotDeps()
    setPublicBoardAllowlistForTests(null)
    setHealthzDeps(originalHealthzDeps)
  })

  it('healthz deny emits auth_denies + requestId header without secrets', async () => {
    const sink = createMemoryLogSink()
    const obs = createObservabilityIntegration({
      sink,
      nowIso: () => '2026-07-14T00:00:00.000Z',
      nowMs: () => 1000,
    })
    setSharedObservabilityIntegrationForTests(obs)
    setHealthzDeps({
      authGuard: denyAllHealthGuard(401, 'AUTHORIZATION_REQUIRED', 'authentication required'),
      loadExpected: async () => ({ deployedSha: 'a'.repeat(40), schemaVersion: '006' }),
      loadObserved: async () => ({
        deployedSha: 'a'.repeat(40),
        schemaVersion: '006',
        migration: {
          status: 'READY',
          appliedVersions: ['006'],
          expectedLatestVersion: '006',
          schemaVersion: '006',
        },
        snapshot: {
          canonicalSnapshotId: null,
          boardRev: null,
          lifecycleRev: null,
        },
        dependencies: [],
      }),
    })

    const res = await healthzGetHandler(
      new Request('http://127.0.0.1/api/healthz', {
        headers: {
          'x-request-id': 'obs-healthz-deny-001',
          authorization: `Bearer ${RAW_JWT}`,
          cookie: 'session=s%3Asecret-session.sig',
        },
      }),
    )
    expect(res.status).toBe(401)
    expect(res.headers.get('x-request-id')).toBe('obs-healthz-deny-001')
    const dumped = JSON.stringify(sink.snapshot())
    expect(dumped).not.toContain(RAW_JWT)
    expect(dumped).not.toContain('secret-session')
    expect(obs.metrics.sum('auth_denies')).toBe(1)
    expect(sink.snapshot().some((e) => e.endpoint === '/api/healthz' && e.result === 'deny')).toBe(
      true,
    )
  })

  it('healthz ok records latency + board/lifecycle rev', async () => {
    const sink = createMemoryLogSink()
    const obs = createObservabilityIntegration({
      sink,
      nowIso: () => '2026-07-14T00:00:00.000Z',
      nowMs: () => 2000,
    })
    setSharedObservabilityIntegrationForTests(obs)
    setHealthzDeps({
      authGuard: allowAllHealthGuard({ actorId: 'root-1', role: 'ROOT_ORCHESTRATOR' }),
      loadExpected: async () => ({
        deployedSha: 'b'.repeat(40),
        schemaVersion: '006',
      }),
      loadObserved: async () => ({
        deployedSha: 'b'.repeat(40),
        schemaVersion: '006',
        migration: {
          status: 'READY',
          appliedVersions: ['000', '001', '002', '003', '004', '005', '006'],
          expectedLatestVersion: '006',
          schemaVersion: '006',
        },
        snapshot: {
          canonicalSnapshotId: 'snap-ok',
          boardRev: 9,
          lifecycleRev: 5,
          canonicalHash: 'c'.repeat(64),
        },
        dependencies: [{ name: 'mysql', status: 'up' }],
      }),
    })

    const res = await healthzGetHandler(
      new Request('http://127.0.0.1/api/healthz', {
        headers: { 'x-request-id': 'obs-healthz-ok-001' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBe('obs-healthz-ok-001')
    const log = sink.snapshot().find((e) => e.endpoint === '/api/healthz')
    expect(log?.result).toBe('ok')
    expect(log?.boardRev).toBe(9)
    expect(log?.lifecycleRev).toBe(5)
    expect(log?.latencyMs).toBeGreaterThanOrEqual(0)
    expect(obs.metrics.count('api_latency_ms')).toBeGreaterThanOrEqual(1)
  })

  it('public-snapshot ok emits PUBLIC role log with pin revs; no body secrets', async () => {
    const sink = createMemoryLogSink()
    const obs = createObservabilityIntegration({
      sink,
      nowIso: () => '2026-07-14T00:00:00.000Z',
      nowMs: () => 3000,
    })
    setSharedObservabilityIntegrationForTests(obs)
    setPublicBoardAllowlistForTests(['wire-board'])
    const store = createMemoryPublicSnapshotStore()
    setPublicSnapshotDeps({
      store,
      loadAggregation: async (boardId) => minimalPublicAgg(boardId),
      rateLimiter: createPublicSnapshotRateLimiter({
        policy: { burst: 1000, sustainedPerMinute: 1000 },
      }),
      resolveIp: () => '127.0.0.1',
    })

    const res = await publicSnapshotGetHandler(
      new Request('http://127.0.0.1/api/public-snapshot?boardId=wire-board', {
        headers: { 'x-request-id': 'obs-public-ok-001' },
      }),
    )
    expect(res.status).toBe(200)
    expect(res.headers.get('x-request-id')).toBe('obs-public-ok-001')
    const log = sink.snapshot().find((e) => e.endpoint === '/api/public-snapshot')
    expect(log?.result).toBe('ok')
    expect(log?.actorRole).toBe('PUBLIC')
    expect(log?.boardId).toBe('wire-board')
    expect(log?.boardRev).toBe(4)
    expect(log?.lifecycleRev).toBe(2)
    const dumped = JSON.stringify(sink.snapshot())
    expect(dumped).not.toMatch(/password|Bearer eyJ/i)
  })
})
