import { afterEach, describe, expect, it } from 'vitest'

import {
  PUBLIC_SERIALIZER_VERSION,
  PUBLIC_SNAPSHOT_SCHEMA,
  PublicSnapshotError,
  computeFreshness,
  computePublicEtag,
  createMemoryPublicSnapshotStore,
  etagMatches,
  getOrMaterializePublicSnapshot,
  handlePublicSnapshotGet,
  maskAccountId,
  materializePublicSnapshot,
  normalizeEtagHeader,
  pinIdentity,
  publicSnapshotResultToResponse,
  sanitizePublicValue,
  sha256Hex,
  stableStringify,
  type PublicAggregationInput,
  type PublicSnapshotDeps,
  type PublicSnapshotPin,
} from '#/server/public-snapshot'
import {
  PUBLIC_SNAPSHOT_RATE_LIMIT_V1,
  consumeTokenBucket,
  createMemoryRateLimitStore,
  createPublicSnapshotRateLimiter,
  rateLimitExceededBody,
  rateLimitResponseHeaders,
  resolveClientIp,
  resolvePublicSnapshotRateLimitPolicy,
} from '#/server/rate-limit'
import {
  allowAllHealthGuard,
  buildHealthzPayload,
  denyAllHealthGuard,
  evaluateHealthStatus,
  handleHealthz,
  healthzResultToResponse,
  stripSecretsFromHealth,
  type HealthExpected,
  type HealthObserved,
  type HealthzDeps,
} from '#/server/health'
import {
  TRUSTED_CLIENT_IP,
  extractDirectRemoteAddress,
  extractTrustedEdgeClientIp,
  getPublicSnapshotDeps,
  loadPublicAggregation,
  publicSnapshotGetHandler,
  resolvePublicSnapshotClientIp,
  setPublicSnapshotDeps,
  setTrustedEdgeClientIpProvider,
} from '#/routes/api.public-snapshot'
import {
  getHealthzDeps,
  healthzAuthGuard,
  healthzGetHandler,
  setHealthzDeps,
} from '#/routes/api.healthz'

function basePin(over: Partial<PublicSnapshotPin> = {}): PublicSnapshotPin {
  return {
    canonicalSnapshotId: 'snap-1',
    canonicalHash: 'a'.repeat(64),
    boardRev: 10,
    lifecycleRev: 5,
    serializerVersion: PUBLIC_SERIALIZER_VERSION,
    ...over,
  }
}

function baseAggregation(
  over: Partial<PublicAggregationInput> = {},
): PublicAggregationInput {
  return {
    boardId: 'board-1',
    pin: basePin(),
    generatedAt: '2026-07-13T00:00:00.000Z',
    publishedAt: '2026-07-13T00:00:00.000Z',
    publicationIntervalMs: 60_000,
    nowMs: Date.parse('2026-07-13T00:00:30.000Z'),
    boardRollup: {
      trackedWorkDenominator: 4,
      productDenominator: 3,
      stageProdReady: 1,
      prodReadyWithEvidence: 1,
      unclassifiedCount: 0,
      rawTaskReadinessPercent: 45.0,
      boardReadinessPercent: 45.0,
      cappedBy: null,
    },
    completion: { complete: false, g5Pass: false },
    buckets: {
      DONE: 1,
      RECONCILIATION_PENDING: 0,
      ONGOING: 1,
      NEXT: 1,
      QUEUED: 1,
      BLOCKED: 0,
    },
    staleOverlays: { STALE_CLAIM: 0 },
    priorityRollup: {
      portfolioId: 'SALES_WEB_RELATED_BACKEND',
      membershipDenominator: 2,
      priorityClosureCapacity: 1,
      allClosureCapacity: 3,
      priorityCapacityShare: 0.33,
      majorityAllocationPass: false,
      frontierState: 'PRIORITY_FRONTIER_ACTIVE',
      reason: null,
    },
    projects: [{ id: 'p2', name: 'B' }, { id: 'p1', name: 'A' }],
    features: [{ id: 'f1', projectId: 'p1', name: 'Feat' }],
    tasks: [{ id: 't1', title: 'Task', bucket: 'ONGOING', readinessPercent: 45 }],
    runs: [
      {
        runId: 'run-1',
        status: 'RUNNING',
        taskId: 't1',
        accountRefMasked: 'acct-raw-xyz9',
      },
    ],
    accounts: [
      { accountIdMasked: 'real-account-ab12', status: 'ACTIVE', usable: true },
    ],
    decisionCount: 2,
    g5: { g5Pass: false, domainPassCount: 3, domainRequiredCount: 9 },
    ...over,
  }
}

describe('AC-PUBLIC-01 pinned materialization once (no recomputation)', () => {
  it('materializes deterministic payload with stable serializer version', () => {
    const a = materializePublicSnapshot(baseAggregation())
    const b = materializePublicSnapshot(baseAggregation())
    expect(a.payload.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
    expect(a.pin.serializerVersion).toBe(PUBLIC_SERIALIZER_VERSION)
    expect(a.etag).toBe(b.etag)
    expect(a.bodyJson).toBe(b.bodyJson)
    expect(a.etag).toMatch(/^[a-f0-9]{64}$/)
  })

  it('input array order does not change ETag (deterministic sort)', () => {
    const left = materializePublicSnapshot(
      baseAggregation({
        projects: [
          { id: 'p2', name: 'B' },
          { id: 'p1', name: 'A' },
        ],
      }),
    )
    const right = materializePublicSnapshot(
      baseAggregation({
        projects: [
          { id: 'p1', name: 'A' },
          { id: 'p2', name: 'B' },
        ],
      }),
    )
    expect(left.etag).toBe(right.etag)
    expect(left.payload.projects.map((p) => p.id)).toEqual(['p1', 'p2'])
  })

  it('getOrMaterialize returns same object for same pin (no recompute)', () => {
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const first = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input })
    // Mutate input summaries — cache must ignore recomputation for same pin
    const mutated = baseAggregation({
      decisionCount: 99,
      tasks: [{ id: 't-new', title: 'should not appear' }],
    })
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: mutated,
    })
    expect(second).toBe(first)
    expect(second.payload.decisionCount).toBe(2)
    expect(second.payload.tasks).toHaveLength(1)
  })

  it('pin change forces new materialization', () => {
    const store = createMemoryPublicSnapshotStore()
    const first = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation(),
    })
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({ pin: basePin({ boardRev: 11 }) }),
    })
    expect(second).not.toBe(first)
    expect(second.pin.boardRev).toBe(11)
    expect(pinIdentity(first.pin)).not.toBe(pinIdentity(second.pin))
  })

  it('rejects invalid pin / wrong serializer', () => {
    expect(() =>
      materializePublicSnapshot(
        baseAggregation({
          pin: basePin({ serializerVersion: 'NOPE' as typeof PUBLIC_SERIALIZER_VERSION }),
        }),
      ),
    ).toThrow(PublicSnapshotError)
  })
})

describe('AC-PUBLIC-02 ETag SHA-256 and If-None-Match 304', () => {
  it('ETag equals SHA-256 of pin tuple + payload', () => {
    const snap = materializePublicSnapshot(baseAggregation())
    const { etag: _e, payloadSha256: _p, ...rest } = snap.payload
    const recomputed = computePublicEtag(snap.pin, rest)
    expect(recomputed).toBe(snap.etag)
    expect(snap.payload.payloadSha256).toBe(snap.etag)
  })

  it('normalizeEtagHeader strips W/ and quotes', () => {
    expect(normalizeEtagHeader('W/"abc"')).toBe('abc')
    expect(normalizeEtagHeader('"abc"')).toBe('abc')
    expect(etagMatches('"deadbeef"', 'deadbeef')).toBe(true)
    expect(etagMatches('W/"deadbeef", "other"', 'deadbeef')).toBe(true)
    expect(etagMatches('"nope"', 'deadbeef')).toBe(false)
  })

  it('handler returns 304 when If-None-Match matches', async () => {
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const snap = materializePublicSnapshot(input)
    store.put('board-1', snap)
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': `"${snap.etag}"` },
      }),
      {
        store,
        loadAggregation: async () => input,
      },
    )
    expect(result.kind).toBe('not_modified')
    expect(result.status).toBe(304)
    const res = publicSnapshotResultToResponse(result)
    expect(res.status).toBe(304)
    expect(await res.text()).toBe('')
  })

  it('handler returns 200 body with ETag when no match', async () => {
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      { store, loadAggregation: async () => input },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      expect(result.status).toBe(200)
      expect(result.headers.etag).toMatch(/^"[a-f0-9]{64}"$/)
      const body = JSON.parse(result.body)
      expect(body.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
      expect(body.etag).toBe(result.etag)
    }
  })
})

describe('AC-PUBLIC-03 redaction / allowlist / attack surface', () => {
  it('masks account ids and run account refs', () => {
    const snap = materializePublicSnapshot(baseAggregation())
    expect(snap.payload.accounts[0]?.accountIdMasked).toMatch(/^acc_\*\*\*/)
    expect(snap.payload.runs[0]?.accountRefMasked).toMatch(/^acc_\*\*\*/)
    expect(maskAccountId('abcdefgh')).toBe('acc_***efgh')
  })

  it('rejects forbidden secret fields in strict mode', () => {
    expect(() =>
      sanitizePublicValue({ boardId: 'b', token: 'sekrit' }, { mode: 'strict' }),
    ).toThrow(PublicSnapshotError)
    expect(() =>
      sanitizePublicValue({ nested: { accessToken: 'x' } }, { mode: 'strict' }),
    ).toThrow(/forbidden public field/)
  })

  it('redact mode drops secrets without throw', () => {
    const out = sanitizePublicValue(
      { boardId: 'b', password: 'x', ok: 1 },
      { mode: 'redact' },
    ) as Record<string, unknown>
    expect(out.password).toBeUndefined()
    expect(out.ok).toBe(1)
  })

  it('rejects comments / private decision / evidence / env keys', () => {
    for (const key of [
      'comments',
      'ownerComments',
      'decisionText',
      'privateDecision',
      'evidenceBody',
      'environment',
      'rawIdentity',
      'api_key',
      'refresh_token',
    ]) {
      expect(() => sanitizePublicValue({ [key]: 'leak' }, { mode: 'strict' })).toThrow(
        PublicSnapshotError,
      )
    }
  })

  it('public payload has decisionCount only — no decision titles', () => {
    const snap = materializePublicSnapshot(baseAggregation())
    const json = snap.bodyJson
    expect(json).toContain('"decisionCount":2')
    expect(json.toLowerCase()).not.toContain('decisiontitle')
    expect(json.toLowerCase()).not.toContain('password')
    expect(json.toLowerCase()).not.toContain('token')
  })

  it('fail-closed on aggregation board mismatch (no auth data leak)', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => baseAggregation({ boardId: 'other-board' }),
      },
    )
    expect(result.status).toBe(503)
    if (result.kind === 'error') {
      const body = JSON.parse(result.body)
      expect(body.code).toBe('AUTH_DATA_LEAK_BLOCKED')
      expect(result.body).not.toContain('token')
    }
  })

  it('fail-closed 503 when aggregation missing — no private fallback', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => null,
      },
    )
    expect(result.status).toBe(503)
    if (result.kind === 'error') {
      expect(JSON.parse(result.body).code).toBe('STALE_OR_MISSING')
    }
  })

  it('freshness stale when age > 2 publication intervals', () => {
    const snap = materializePublicSnapshot(
      baseAggregation({
        publishedAt: '2026-07-13T00:00:00.000Z',
        publicationIntervalMs: 60_000,
        nowMs: Date.parse('2026-07-13T00:03:00.000Z'), // 180s > 120s
      }),
    )
    expect(snap.payload.freshness.stale).toBe(true)
    expect(snap.payload.freshness.ageMs).toBe(180_000)
  })
})

describe('AC-AUTH-05 PUBLIC_SNAPSHOT_RATE_LIMIT_V1', () => {
  it('policy defaults are 60/min sustained burst 20', () => {
    const p = resolvePublicSnapshotRateLimitPolicy()
    expect(p.policyId).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
    expect(p.sustainedPerMinute).toBe(60)
    expect(p.burst).toBe(20)
  })

  it('allows burst of 20 then denies with Retry-After', () => {
    const store = createMemoryRateLimitStore()
    const clock = { nowMs: () => 1_000_000 }
    const policy = resolvePublicSnapshotRateLimitPolicy()
    let last = consumeTokenBucket({ key: 'ip:1.2.3.4', policy, store, clock })
    for (let i = 0; i < 19; i++) {
      last = consumeTokenBucket({ key: 'ip:1.2.3.4', policy, store, clock })
      expect(last.allowed).toBe(true)
    }
    // 20th already consumed in loop start + 19 = 20; next is 21st
    const denied = consumeTokenBucket({ key: 'ip:1.2.3.4', policy, store, clock })
    expect(denied.allowed).toBe(false)
    expect(denied.retryAfterSeconds).toBeGreaterThanOrEqual(1)
    expect(rateLimitResponseHeaders(denied)['retry-after']).toBeDefined()
    expect(rateLimitExceededBody(denied).code).toBe('RATE_LIMITED')
  })

  it('refills tokens over time (sustained 60/min ≈ 1/s)', () => {
    let now = 0
    const clock = { nowMs: () => now }
    const store = createMemoryRateLimitStore()
    const policy = resolvePublicSnapshotRateLimitPolicy()
    // Drain burst
    for (let i = 0; i < 20; i++) {
      consumeTokenBucket({ key: 'k', policy, store, clock })
    }
    expect(consumeTokenBucket({ key: 'k', policy, store, clock }).allowed).toBe(false)
    // Advance 2 seconds → ~2 tokens
    now = 2000
    const d1 = consumeTokenBucket({ key: 'k', policy, store, clock })
    expect(d1.allowed).toBe(true)
    const d2 = consumeTokenBucket({ key: 'k', policy, store, clock })
    expect(d2.allowed).toBe(true)
    expect(consumeTokenBucket({ key: 'k', policy, store, clock }).allowed).toBe(false)
  })

  it('never trusts unvalidated X-Forwarded-For for IP', () => {
    const headers = new Headers({
      'x-forwarded-for': '9.9.9.9',
      'x-real-ip': '8.8.8.8',
    })
    expect(
      resolveClientIp({
        headers,
        directRemoteAddress: '10.0.0.5',
        trustForwardingHeaders: true,
      }),
    ).toBe('10.0.0.5')
    expect(
      resolveClientIp({
        headers,
        trustedClientIp: '1.1.1.1',
      }),
    ).toBe('1.1.1.1')
    expect(resolveClientIp({ headers })).toBe('unknown')
  })

  it('handler returns 429 + Retry-After when limiter exhausted', async () => {
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 2, sustainedPerMinute: 60 },
    })
    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: () => '5.5.5.5',
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    expect((await handlePublicSnapshotGet(new Request(url), deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(new Request(url), deps)).status).toBe(200)
    const limited = await handlePublicSnapshotGet(new Request(url), deps)
    expect(limited.kind).toBe('rate_limited')
    expect(limited.status).toBe(429)
    if (limited.kind === 'rate_limited') {
      expect(limited.headers['retry-after']).toBeDefined()
      expect(JSON.parse(limited.body).policyId).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
    }
  })

  it('policy is configurable', () => {
    const p = resolvePublicSnapshotRateLimitPolicy({
      sustainedPerMinute: 30,
      burst: 5,
    })
    expect(p.sustainedPerMinute).toBe(30)
    expect(p.burst).toBe(5)
  })
})

describe('AC-OPS-01 /healthz auth guard + SHA/schema mismatch', () => {
  const expected: HealthExpected = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '003',
  }
  const healthyObserved: HealthObserved = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '003',
    migration: {
      status: 'READY',
      appliedVersions: ['001', '002', '003'],
      expectedLatestVersion: '003',
      schemaVersion: '003',
    },
    snapshot: {
      canonicalSnapshotId: 'snap-1',
      boardRev: 10,
      lifecycleRev: 5,
    },
    dependencies: [
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
    ],
    serviceName: 'cairn-task-manager',
  }

  it('fail-closed 401 when auth guard absent', async () => {
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: null,
      loadExpected: () => expected,
      loadObserved: () => healthyObserved,
    })
    expect(result.status).toBe(401)
    expect((result.payload as { code: string }).code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('fail-closed when guard denies', async () => {
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: denyAllHealthGuard(403, 'FORBIDDEN', 'nope'),
      loadExpected: () => expected,
      loadObserved: () => healthyObserved,
    })
    expect(result.status).toBe(403)
  })

  it('returns full health fields when authorized and matching', async () => {
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: allowAllHealthGuard({ actorId: 'owner-1', role: 'OWNER' }),
      loadExpected: () => expected,
      loadObserved: () => healthyObserved,
      nowIso: () => '2026-07-13T12:00:00.000Z',
    })
    expect(result.status).toBe(200)
    const p = result.payload as ReturnType<typeof buildHealthzPayload>
    expect(p.status).toBe('ok')
    expect(p.deployedSha).toBe(expected.deployedSha)
    expect(p.schema.version).toBe('003')
    expect(p.schema.match).toBe(true)
    expect(p.release.match).toBe(true)
    expect(p.canonicalSnapshotId).toBe('snap-1')
    expect(p.boardRev).toBe(10)
    expect(p.lifecycleRev).toBe(5)
    expect(p.migration.status).toBe('READY')
    expect(p.dependencies).toEqual([
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
    ])
  })

  it('unhealthy 503 on release SHA mismatch', async () => {
    const observed = {
      ...healthyObserved,
      deployedSha: '0000000000000000000000000000000000000000',
    }
    const evaled = evaluateHealthStatus(expected, observed)
    expect(evaled.status).toBe('unhealthy')
    expect(evaled.unhealthyReasons).toContain('RELEASE_SHA_MISMATCH')
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => observed,
    })
    expect(result.status).toBe(503)
    expect((result.payload as { status: string }).status).toBe('unhealthy')
  })

  it('unhealthy on schema mismatch', () => {
    const evaled = evaluateHealthStatus(expected, {
      ...healthyObserved,
      schemaVersion: '001',
    })
    expect(evaled.status).toBe('unhealthy')
    expect(evaled.schemaMatch).toBe(false)
    expect(evaled.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
  })

  it('does not leak secrets in health payload', () => {
    const dirty = stripSecretsFromHealth({
      status: 'ok',
      token: 'sekrit',
      password: 'x',
      nested: { apiKey: 'k', safe: 1 },
    }) as Record<string, unknown>
    expect(dirty.token).toBeUndefined()
    expect(dirty.password).toBeUndefined()
    expect((dirty.nested as Record<string, unknown>).apiKey).toBeUndefined()
    expect((dirty.nested as Record<string, unknown>).safe).toBe(1)
  })

  it('healthzResultToResponse produces JSON Response', async () => {
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => healthyObserved,
    })
    const res = healthzResultToResponse(result)
    expect(res.headers.get('content-type')).toMatch(/json/)
    const body = await res.json()
    expect(body.schemaVersion).toBe('MFS_HEALTHZ_V1')
  })
})

describe('stable stringify helpers', () => {
  it('stableStringify sorts keys', () => {
    expect(stableStringify({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(sha256Hex('abc')).toMatch(/^[a-f0-9]{64}$/)
  })
})

describe('installed route deps (api.public-snapshot)', () => {
  const originalPublicDeps = getPublicSnapshotDeps()

  afterEach(() => {
    setPublicSnapshotDeps(originalPublicDeps)
  })

  it('default deps install loadPublicAggregation + rate limiter + store + resolveIp', () => {
    const deps = getPublicSnapshotDeps()
    expect(deps.loadAggregation).toBe(loadPublicAggregation)
    expect(deps.store).toBeDefined()
    expect(deps.rateLimiter).toBeDefined()
    expect(typeof deps.rateLimiter?.check).toBe('function')
    expect(typeof deps.resolveIp).toBe('function')
  })

  it('loadPublicAggregation returns null for missing board (fail-closed, no invent)', async () => {
    const agg = await loadPublicAggregation('board-does-not-exist-w15-05')
    expect(agg).toBeNull()
  })

  it('installed handler returns 503 STALE_OR_MISSING for missing board — no invented body', async () => {
    const res = await publicSnapshotGetHandler(
      new Request('http://local/api/public-snapshot?boardId=board-does-not-exist-w15-05'),
    )
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.code).toBe('STALE_OR_MISSING')
    expect(body.stale).toBe(true)
    // Must not invent a successful snapshot envelope
    expect(body.schemaVersion).toBeUndefined()
    expect(body.pin).toBeUndefined()
    expect(body.etag).toBeUndefined()
    expect(body.boardRollup).toBeUndefined()
    expect(JSON.stringify(body).toLowerCase()).not.toContain('password')
    expect(JSON.stringify(body).toLowerCase()).not.toContain('token')
  })

  it('setPublicSnapshotDeps swaps loader; restores isolation for subsequent tests', async () => {
    let calls = 0
    const fake: PublicSnapshotDeps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => {
        calls += 1
        return baseAggregation()
      },
      rateLimiter: undefined,
      resolveIp: () => '9.9.9.9',
    }
    setPublicSnapshotDeps(fake)
    const res = await publicSnapshotGetHandler(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
    )
    expect(res.status).toBe(200)
    expect(calls).toBe(1)
    const body = await res.json()
    expect(body.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
    expect(body.pin.serializerVersion).toBe(PUBLIC_SERIALIZER_VERSION)
  })

  it('loadPublicAggregation pin envelope uses content hash + non-invented rev/g5', async () => {
    // Prefer a real board when present; otherwise skip shape on null only.
    const probe = await loadPublicAggregation('ibils')
    if (!probe) {
      // Environment without data/boards — still proves fail-closed path exists
      expect(probe).toBeNull()
      return
    }
    expect(probe.boardId).toBe('ibils')
    expect(probe.pin.serializerVersion).toBe(PUBLIC_SERIALIZER_VERSION)
    expect(probe.pin.canonicalHash).toMatch(/^[a-f0-9]{64}$/)
    expect(probe.pin.canonicalSnapshotId).toMatch(/^pub-ibils-/)
    // Route does not invent integer revs from missing fields
    expect(probe.pin.boardRev).toBe(0)
    expect(probe.pin.lifecycleRev).toBe(0)
    // PublicG5Summary only — no invented domainPass / g5Pass green
    expect(probe.g5.g5Pass).toBe(false)
    expect(probe.g5.domainPassCount).toBe(0)
    expect(probe.g5.domainRequiredCount).toBe(9)
    expect(probe.completion.complete).toBe(false)
  })
})

describe('one loader invocation per pin + exact revision/hash envelope', () => {
  it('getOrMaterialize materializes once per pin identity', () => {
    const store = createMemoryPublicSnapshotStore()
    const pin = basePin()
    const input = baseAggregation({ pin })
    const first = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input })
    // Mutate aggregation numbers; same pin → identical object (no recompute)
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({
        pin,
        decisionCount: 999,
        boardRollup: {
          ...input.boardRollup,
          boardReadinessPercent: 1,
        },
      }),
    })
    expect(second).toBe(first)
    expect(second.payload.decisionCount).toBe(2)
    expect(pinIdentity(second.pin)).toBe(pinIdentity(pin))
  })

  it('handler: loadAggregation called once per request; materialize once per pin', async () => {
    let loadCalls = 0
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const deps = {
      store,
      loadAggregation: async () => {
        loadCalls += 1
        return input
      },
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    const r1 = await handlePublicSnapshotGet(new Request(url), deps)
    const r2 = await handlePublicSnapshotGet(new Request(url), deps)
    expect(loadCalls).toBe(2) // loader runs per request
    expect(r1.kind).toBe('ok')
    expect(r2.kind).toBe('ok')
    if (r1.kind === 'ok' && r2.kind === 'ok') {
      expect(r1.etag).toBe(r2.etag)
      expect(r1.body).toBe(r2.body)
    }
    // Same pin identity stored once
    const cached = store.get('board-1')
    expect(cached).not.toBeNull()
    expect(pinIdentity(cached!.pin)).toBe(pinIdentity(input.pin))
  })

  it('pin change forces second materialization with new etag', async () => {
    const store = createMemoryPublicSnapshotStore()
    let rev = 10
    const deps = {
      store,
      loadAggregation: async () =>
        baseAggregation({ pin: basePin({ boardRev: rev }) }),
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    const first = await handlePublicSnapshotGet(new Request(url), deps)
    rev = 11
    const second = await handlePublicSnapshotGet(new Request(url), deps)
    expect(first.kind).toBe('ok')
    expect(second.kind).toBe('ok')
    if (first.kind === 'ok' && second.kind === 'ok') {
      expect(first.etag).not.toBe(second.etag)
      const b1 = JSON.parse(first.body)
      const b2 = JSON.parse(second.body)
      expect(b1.pin.boardRev).toBe(10)
      expect(b2.pin.boardRev).toBe(11)
    }
  })

  it('exact revision/hash envelope on 200 body', async () => {
    const pin = basePin({
      canonicalSnapshotId: 'snap-exact-1',
      canonicalHash: 'b'.repeat(64),
      boardRev: 42,
      lifecycleRev: 7,
    })
    const input = baseAggregation({ pin })
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => input,
      },
    )
    expect(result.kind).toBe('ok')
    if (result.kind === 'ok') {
      const body = JSON.parse(result.body)
      expect(body.schemaVersion).toBe(PUBLIC_SNAPSHOT_SCHEMA)
      expect(body.boardId).toBe('board-1')
      expect(body.pin).toEqual({
        canonicalSnapshotId: 'snap-exact-1',
        canonicalHash: 'b'.repeat(64),
        boardRev: 42,
        lifecycleRev: 7,
        serializerVersion: PUBLIC_SERIALIZER_VERSION,
      })
      expect(body.etag).toBe(result.etag)
      expect(body.payloadSha256).toBe(result.etag)
      expect(body.etag).toMatch(/^[a-f0-9]{64}$/)
      // ETag recomputes from pin+payload without etag fields
      const { etag: _e, payloadSha256: _p, ...rest } = body
      expect(computePublicEtag(body.pin, rest)).toBe(body.etag)
    }
  })
})

describe('ETag/304 extended + stale/fresh transitions', () => {
  it('304 with weak ETag and multi-value If-None-Match', async () => {
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const snap = materializePublicSnapshot(input)
    store.put('board-1', snap)
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': `W/"other", W/"${snap.etag}"` },
      }),
      { store, loadAggregation: async () => input },
    )
    expect(result.kind).toBe('not_modified')
    expect(result.status).toBe(304)
    if (result.kind === 'not_modified') {
      expect(result.headers.etag).toBe(`"${snap.etag}"`)
      expect(result.headers['x-public-serializer']).toBe(PUBLIC_SERIALIZER_VERSION)
    }
  })

  it('mismatch If-None-Match returns 200 full body', async () => {
    const input = baseAggregation()
    const wrongEtag = '0'.repeat(64)
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': `"${wrongEtag}"` },
      }),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => input,
      },
    )
    expect(result.kind).toBe('ok')
    expect(result.status).toBe(200)
    if (result.kind === 'ok') {
      expect(result.etag).not.toBe(wrongEtag)
      expect(JSON.parse(result.body).etag).toBe(result.etag)
    }
  })

  it('fresh when age <= 2 * publicationIntervalMs; stale when greater', () => {
    const publishedAt = '2026-07-13T00:00:00.000Z'
    const interval = 60_000
    const publishedMs = Date.parse(publishedAt)

    const exactBoundary = computeFreshness({
      generatedAt: publishedAt,
      publishedAt,
      publicationIntervalMs: interval,
      nowMs: publishedMs + 2 * interval, // age === 2*interval → not stale (uses >)
    })
    expect(exactBoundary.stale).toBe(false)
    expect(exactBoundary.ageMs).toBe(120_000)

    const justOver = computeFreshness({
      generatedAt: publishedAt,
      publishedAt,
      publicationIntervalMs: interval,
      nowMs: publishedMs + 2 * interval + 1,
    })
    expect(justOver.stale).toBe(true)
    expect(justOver.ageMs).toBe(120_001)

    const freshYoung = computeFreshness({
      generatedAt: publishedAt,
      publishedAt,
      publicationIntervalMs: interval,
      nowMs: publishedMs + 30_000,
    })
    expect(freshYoung.stale).toBe(false)
  })

  it('handler exposes x-snapshot-stale 0/1 across fresh→stale', async () => {
    const store = createMemoryPublicSnapshotStore()
    let now = Date.parse('2026-07-13T00:00:30.000Z')
    const base = baseAggregation({
      publishedAt: '2026-07-13T00:00:00.000Z',
      publicationIntervalMs: 60_000,
      nowMs: now,
    })
    // First pin materialization at fresh age
    const fresh = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store,
        loadAggregation: async () => ({ ...base, nowMs: now }),
        nowMs: () => now,
      },
    )
    expect(fresh.kind).toBe('ok')
    if (fresh.kind === 'ok') {
      expect(fresh.headers['x-snapshot-stale']).toBe('0')
      expect(JSON.parse(fresh.body).freshness.stale).toBe(false)
    }

    // Pin change forces rematerialization at stale age
    now = Date.parse('2026-07-13T00:03:00.000Z')
    const staleInput = baseAggregation({
      pin: basePin({ boardRev: 99 }),
      publishedAt: '2026-07-13T00:00:00.000Z',
      publicationIntervalMs: 60_000,
      nowMs: now,
    })
    const stale = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store,
        loadAggregation: async () => staleInput,
        nowMs: () => now,
      },
    )
    expect(stale.kind).toBe('ok')
    if (stale.kind === 'ok') {
      expect(stale.headers['x-snapshot-stale']).toBe('1')
      const body = JSON.parse(stale.body)
      expect(body.freshness.stale).toBe(true)
      expect(body.freshness.ageMs).toBe(180_000)
    }
  })
})

describe('60/min burst20 429 (default policy through handler)', () => {
  it('default burst 20 then 429 on 21st request for same IP', async () => {
    const limiter = createPublicSnapshotRateLimiter() // defaults 60/min burst 20
    const policy = resolvePublicSnapshotRateLimitPolicy()
    expect(policy.sustainedPerMinute).toBe(60)
    expect(policy.burst).toBe(20)

    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: () => '7.7.7.7',
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    const statuses: number[] = []
    for (let i = 0; i < 20; i++) {
      statuses.push((await handlePublicSnapshotGet(new Request(url), deps)).status)
    }
    expect(statuses.every((s) => s === 200)).toBe(true)
    const limited = await handlePublicSnapshotGet(new Request(url), deps)
    expect(limited.kind).toBe('rate_limited')
    expect(limited.status).toBe(429)
    if (limited.kind === 'rate_limited') {
      expect(limited.headers['retry-after']).toBeDefined()
      expect(limited.headers['x-ratelimit-policy']).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
      const body = JSON.parse(limited.body)
      expect(body.code).toBe('RATE_LIMITED')
      expect(body.policyId).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
    }
  })

  it('different IPs have independent buckets', async () => {
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 1, sustainedPerMinute: 60 },
    })
    const mk = (ip: string) => ({
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: () => ip,
    })
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    expect((await handlePublicSnapshotGet(new Request(url), mk('1.1.1.1'))).status).toBe(200)
    expect((await handlePublicSnapshotGet(new Request(url), mk('1.1.1.1'))).status).toBe(429)
    expect((await handlePublicSnapshotGet(new Request(url), mk('2.2.2.2'))).status).toBe(200)
  })
})

/** Attach non-spoofable runtime socket IP the way srvx NodeRequest exposes `.ip`. */
function requestWithSocketIp(
  url: string,
  ip: string | null | undefined,
  init?: RequestInit,
): Request {
  const req = new Request(url, init)
  if (ip != null) {
    Object.defineProperty(req, 'ip', { value: ip, enumerable: true, configurable: true })
  }
  return req
}

describe('R5-04 per-client PUBLIC_SNAPSHOT_RATE_LIMIT_V1 IP wiring', () => {
  afterEach(() => {
    setTrustedEdgeClientIpProvider(null)
  })

  it('extractDirectRemoteAddress reads request.ip (socket) and never XFF headers', () => {
    const spoofed = requestWithSocketIp(
      'http://local/api/public-snapshot?boardId=board-1',
      '10.0.0.7',
      {
        headers: {
          'x-forwarded-for': '9.9.9.9, 1.1.1.1',
          'x-real-ip': '8.8.8.8',
          forwarded: 'for=7.7.7.7',
          'cf-connecting-ip': '6.6.6.6',
        },
      },
    )
    expect(extractDirectRemoteAddress(spoofed)).toBe('10.0.0.7')
    expect(resolvePublicSnapshotClientIp(spoofed)).toBe('10.0.0.7')

    const bare = new Request('http://local/api/public-snapshot?boardId=board-1', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    })
    expect(extractDirectRemoteAddress(bare)).toBeNull()
    // Missing socket identity → bounded anonymous key, not the spoofed XFF
    expect(resolvePublicSnapshotClientIp(bare)).toBe('unknown')
  })

  it('spoofed X-Forwarded-For never becomes client identity even when socket missing', () => {
    const req = new Request('http://local/api/public-snapshot?boardId=board-1', {
      headers: {
        'x-forwarded-for': '203.0.113.9',
        'x-real-ip': '203.0.113.8',
      },
    })
    expect(extractDirectRemoteAddress(req)).toBeNull()
    expect(extractTrustedEdgeClientIp(req)).toBeNull()
    expect(resolvePublicSnapshotClientIp(req)).toBe('unknown')
    expect(resolvePublicSnapshotClientIp(req)).not.toBe('203.0.113.9')
  })

  it('trusted-edge Symbol injection is preferred; raw XFF still ignored', () => {
    const req = requestWithSocketIp(
      'http://local/api/public-snapshot?boardId=board-1',
      '10.0.0.1',
      { headers: { 'x-forwarded-for': '9.9.9.9' } },
    )
    Object.defineProperty(req, TRUSTED_CLIENT_IP, {
      value: '198.51.100.10',
      enumerable: false,
      configurable: true,
    })
    expect(extractTrustedEdgeClientIp(req)).toBe('198.51.100.10')
    // trusted edge wins over socket (validated edge path)
    expect(resolvePublicSnapshotClientIp(req)).toBe('198.51.100.10')
  })

  it('setTrustedEdgeClientIpProvider injects validated edge IP without reading XFF', () => {
    setTrustedEdgeClientIpProvider(() => '203.0.113.50')
    const req = new Request('http://local/api/public-snapshot?boardId=board-1', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    })
    expect(resolvePublicSnapshotClientIp(req)).toBe('203.0.113.50')
    setTrustedEdgeClientIpProvider(null)
    expect(resolvePublicSnapshotClientIp(req)).toBe('unknown')
  })

  it('distinct socket IPs have independent rate-limit buckets (do not collapse)', async () => {
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 1, sustainedPerMinute: 60 },
    })
    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: resolvePublicSnapshotClientIp,
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    const ipA = requestWithSocketIp(url, '1.1.1.1')
    const ipB = requestWithSocketIp(url, '2.2.2.2')

    expect((await handlePublicSnapshotGet(ipA, deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(ipA, deps)).status).toBe(429)
    // Different client still allowed — not shared with A
    expect((await handlePublicSnapshotGet(ipB, deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(ipB, deps)).status).toBe(429)
  })

  it('anonymous unknown bucket is bounded and does not collapse known socket clients', async () => {
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 1, sustainedPerMinute: 60 },
    })
    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: resolvePublicSnapshotClientIp,
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    // Exhaust anonymous bucket (missing socket + no trusted edge)
    const anon = new Request(url, { headers: { 'x-forwarded-for': '9.9.9.9' } })
    expect(resolvePublicSnapshotClientIp(anon)).toBe('unknown')
    expect((await handlePublicSnapshotGet(anon, deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(anon, deps)).status).toBe(429)

    // Known client with socket IP still has its own capacity
    const known = requestWithSocketIp(url, '198.51.100.20')
    expect(resolvePublicSnapshotClientIp(known)).toBe('198.51.100.20')
    expect((await handlePublicSnapshotGet(known, deps)).status).toBe(200)
  })

  it('installed default resolveIp uses socket/runtime address (not always unknown)', () => {
    const deps = getPublicSnapshotDeps()
    expect(deps.resolveIp).toBe(resolvePublicSnapshotClientIp)
    const withSocket = requestWithSocketIp(
      'http://local/api/public-snapshot?boardId=board-1',
      '172.16.0.9',
      { headers: { 'x-forwarded-for': '9.9.9.9' } },
    )
    expect(deps.resolveIp!(withSocket)).toBe('172.16.0.9')
    const noSocket = new Request('http://local/api/public-snapshot?boardId=board-1', {
      headers: { 'x-forwarded-for': '9.9.9.9' },
    })
    expect(deps.resolveIp!(noSocket)).toBe('unknown')
  })

  it('burst then refill still works for a socket-keyed client', async () => {
    let now = 0
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 2, sustainedPerMinute: 60 },
      clock: { nowMs: () => now },
    })
    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: resolvePublicSnapshotClientIp,
    }
    const url = 'http://local/api/public-snapshot?boardId=board-1'
    const mk = () => requestWithSocketIp(url, '10.10.10.10')

    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(429)

    // ~1 token/sec sustained → advance 2s for 2 tokens
    now = 2000
    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(200)
    expect((await handlePublicSnapshotGet(mk(), deps)).status).toBe(429)
  })

  it('extractDirectRemoteAddress prefers socket.remoteAddress when .ip absent', () => {
    const req = new Request('http://local/api/public-snapshot?boardId=board-1')
    Object.defineProperty(req, 'socket', {
      value: { remoteAddress: '192.0.2.44' },
      enumerable: true,
      configurable: true,
    })
    expect(extractDirectRemoteAddress(req)).toBe('192.0.2.44')
    expect(resolvePublicSnapshotClientIp(req)).toBe('192.0.2.44')
  })
})

describe('recursive redaction attacks', () => {
  it('strict mode rejects deep nested secret keys', () => {
    expect(() =>
      sanitizePublicValue(
        { a: { b: { c: { accessToken: 'leak' } } } },
        { mode: 'strict' },
      ),
    ).toThrow(/forbidden public field/)
    expect(() =>
      sanitizePublicValue(
        { items: [{ id: 1, nested: { refresh_token: 'x' } }] },
        { mode: 'strict' },
      ),
    ).toThrow(PublicSnapshotError)
    expect(() =>
      sanitizePublicValue({ ownerComments: 'nope' }, { mode: 'strict' }),
    ).toThrow(PublicSnapshotError)
  })

  it('redact mode strips secrets at arbitrary depth and in arrays', () => {
    const out = sanitizePublicValue(
      {
        boardId: 'b',
        layer: {
          password: 'p',
          safe: true,
          list: [{ token: 't', n: 1 }, { api_key: 'k', n: 2 }, { n: 3 }],
        },
        environment: { NODE_ENV: 'prod' },
      },
      { mode: 'redact' },
    ) as Record<string, unknown>
    const layer = out.layer as Record<string, unknown>
    expect(layer.password).toBeUndefined()
    expect(layer.safe).toBe(true)
    expect(out.environment).toBeUndefined()
    const list = layer.list as Array<Record<string, unknown>>
    expect(list[0]?.token).toBeUndefined()
    expect(list[0]?.n).toBe(1)
    expect(list[1]?.api_key).toBeUndefined()
    expect(list[1]?.n).toBe(2)
    expect(list[2]).toEqual({ n: 3 })
  })

  it('materialization fails closed when forbidden field slips into rollup', () => {
    expect(() =>
      materializePublicSnapshot(
        baseAggregation({
          boardRollup: {
            ...baseAggregation().boardRollup,
            // sneak a forbidden key via index signature cast path
            ...({ secretToken: 'nope' } as object),
          } as PublicAggregationInput['boardRollup'],
        }),
      ),
    ).toThrow(PublicSnapshotError)
  })

  it('public body never contains recursive secret substrings after materialize', () => {
    const snap = materializePublicSnapshot(baseAggregation())
    const lower = snap.bodyJson.toLowerCase()
    for (const bad of [
      'password',
      'accesstoken',
      'refresh_token',
      'authorization',
      'clientsecret',
      'decisiontext',
      'ownercomments',
      'evidencebody',
      'rawidentity',
    ]) {
      expect(lower).not.toContain(bad)
    }
  })
})

describe('load failure 503 and no invented fallback', () => {
  it('loadAggregation null → 503 STALE_OR_MISSING without snapshot fields', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => null,
      },
    )
    expect(result.status).toBe(503)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      const body = JSON.parse(result.body)
      expect(body.code).toBe('STALE_OR_MISSING')
      expect(body.schemaVersion).toBeUndefined()
      expect(body.g5).toBeUndefined()
      expect(body.buckets).toBeUndefined()
      expect(body.pin).toBeUndefined()
    }
  })

  it('loadAggregation throw → 503 failClosed, no private stack/token leak', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => {
          throw new Error('db down token=sekrit-should-not-leak')
        },
      },
    )
    expect(result.status).toBe(503)
    expect(result.kind).toBe('error')
    if (result.kind === 'error') {
      const body = JSON.parse(result.body)
      expect(body.failClosed).toBe(true)
      expect(body.error).toBe('public snapshot unavailable')
      expect(result.body).not.toContain('sekrit')
      expect(result.body).not.toContain('db down')
      expect(body.schemaVersion).toBeUndefined()
    }
  })

  it('materialization PublicSnapshotError → 503 with code, empty of private payload', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () =>
          baseAggregation({
            pin: basePin({ serializerVersion: 'WRONG' as typeof PUBLIC_SERIALIZER_VERSION }),
          }),
      },
    )
    expect(result.status).toBe(503)
    if (result.kind === 'error') {
      const body = JSON.parse(result.body)
      expect(body.code).toBe('INVALID_PIN')
      expect(body.failClosed).toBe(true)
      expect(body.boardRollup).toBeUndefined()
    }
  })

  it('missing boardId → 400 INVALID_INPUT (not invented default board)', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => baseAggregation(),
      },
    )
    expect(result.status).toBe(400)
    if (result.kind === 'error') {
      expect(JSON.parse(result.body).code).toBe('INVALID_INPUT')
    }
  })
})

describe('health route auth/mismatch via public exports (no product edit)', () => {
  const originalHealthDeps = getHealthzDeps()

  afterEach(() => {
    setHealthzDeps(originalHealthDeps)
  })

  const expected: HealthExpected = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '003',
  }
  const healthyObserved: HealthObserved = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '003',
    migration: {
      status: 'READY',
      appliedVersions: ['001', '002', '003'],
      expectedLatestVersion: '003',
      schemaVersion: '003',
    },
    snapshot: {
      canonicalSnapshotId: 'snap-1',
      boardRev: 10,
      lifecycleRev: 5,
    },
    dependencies: [
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
    ],
    serviceName: 'cairn-task-manager',
  }

  it('installed healthz deps wire authGuard (= healthzAuthGuard export)', () => {
    const deps = getHealthzDeps()
    expect(deps.authGuard).toBe(healthzAuthGuard)
    expect(typeof deps.loadExpected).toBe('function')
    expect(typeof deps.loadObserved).toBe('function')
  })

  it('healthzAuthGuard without credentials → 401 AUTHORIZATION_REQUIRED', async () => {
    const guard = await healthzAuthGuard(new Request('http://local/api/healthz'))
    expect(guard.ok).toBe(false)
    if (!guard.ok) {
      expect(guard.status).toBe(401)
      expect(guard.code).toBe('AUTHORIZATION_REQUIRED')
    }
  })

  it('healthzGetHandler unauthenticated → 401 JSON', async () => {
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(401)
    const body = await res.json()
    expect(body.code).toBe('AUTHORIZATION_REQUIRED')
    expect(body.deployedSha).toBeUndefined()
  })

  it('invalid bearer via installed guard → 401', async () => {
    const guard = await healthzAuthGuard(
      new Request('http://local/api/healthz', {
        headers: { authorization: 'Bearer totally-invalid-token-w15' },
      }),
    )
    expect(guard.ok).toBe(false)
    if (!guard.ok) {
      expect(guard.status).toBe(401)
      expect(guard.code).toBe('AUTHORIZATION_REQUIRED')
    }
  })

  it('injected allowAll + SHA mismatch through route handler → 503 unhealthy', async () => {
    const deps: HealthzDeps = {
      authGuard: allowAllHealthGuard({ actorId: 't', role: 'OWNER' }),
      loadExpected: () => expected,
      loadObserved: () => ({
        ...healthyObserved,
        deployedSha: '0000000000000000000000000000000000000000',
      }),
    }
    setHealthzDeps(deps)
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.unhealthyReasons).toContain('RELEASE_SHA_MISMATCH')
    expect(body.release.match).toBe(false)
  })

  it('injected allowAll + schema mismatch → 503', async () => {
    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => ({ ...healthyObserved, schemaVersion: '001' }),
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.schema.match).toBe(false)
    expect(body.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
  })

  it('dependency down degrades but not unhealthy when release/schema match', async () => {
    const evaled = evaluateHealthStatus(expected, {
      ...healthyObserved,
      dependencies: [{ name: 'mysql', status: 'down' }],
    })
    expect(evaled.status).toBe('degraded')
    expect(evaled.unhealthyReasons).toContain('DEPENDENCY_DOWN:mysql')

    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => ({
        ...healthyObserved,
        dependencies: [{ name: 'mysql', status: 'down' }],
      }),
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('degraded')
  })

  it('loadObserved throw via deps → 503 HEALTH_UNAVAILABLE (fail-closed)', async () => {
    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: async () => {
        throw new Error('secret=should-not-appear')
      },
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(503)
    const text = await res.text()
    expect(text).not.toContain('should-not-appear')
    expect(JSON.parse(text).code).toBe('HEALTH_UNAVAILABLE')
  })
})
