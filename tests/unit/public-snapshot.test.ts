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
  isCanonicalMaskedAccountId,
  maskAccountId,
  materializePublicSnapshot,
  normalizeEtagHeader,
  pinIdentity,
  publicContentFingerprint,
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
  isPublicBoardAllowed,
  loadPublicAggregation,
  publicSnapshotGetHandler,
  resetPublicSnapshotDeps,
  resolvePublicSnapshotClientIp,
  setPublicBoardAllowlistForTests,
  setPublicSnapshotDeps,
  setTrustedEdgeClientIpProvider,
} from '#/routes/api.public-snapshot'
import {
  createPublicSnapshotService,
  getSharedPublicSnapshotService,
  resetPublicSnapshotServiceForTests,
  setTestPublicSnapshotService,
} from '#/server/public-snapshot-service'
import {
  REQUIRED_TABLES_BY_MIGRATION,
  getHealthzDeps,
  healthzAuthGuard,
  healthzGetHandler,
  requiredTablesForAppliedVersions,
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

  it('getOrMaterialize returns same object for same pin+content (no recompute)', () => {
    const store = createMemoryPublicSnapshotStore()
    const input = baseAggregation()
    const first = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input })
    // Identical content again — cache hit
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation(),
    })
    expect(second).toBe(first)
    expect(second.payload.decisionCount).toBe(2)
    expect(second.contentFingerprint).toBe(publicContentFingerprint(input))
  })

  it('decisionCount/G5/lifecycle content change invalidates cache even when pin unchanged', () => {
    const store = createMemoryPublicSnapshotStore()
    const pin = basePin()
    const first = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({ pin, decisionCount: 2 }),
    })
    // Same pin, different decision count → must rematerialize (not boardHash-only identity)
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({ pin, decisionCount: 99 }),
    })
    expect(second).not.toBe(first)
    expect(second.payload.decisionCount).toBe(99)
    expect(second.etag).not.toBe(first.etag)
    expect(second.contentFingerprint).not.toBe(first.contentFingerprint)

    const g5Changed = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({
        pin,
        decisionCount: 99,
        g5: { g5Pass: true, domainPassCount: 9, domainRequiredCount: 9 },
      }),
    })
    expect(g5Changed.etag).not.toBe(second.etag)

    const lifecyclePin = basePin({ lifecycleRev: 99 })
    const lifeChanged = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({ pin: lifecyclePin, decisionCount: 99 }),
    })
    expect(lifeChanged.etag).not.toBe(second.etag)
    expect(lifeChanged.pin.lifecycleRev).toBe(99)
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
  it('masks account ids and run account refs with canonical pattern', () => {
    const snap = materializePublicSnapshot(baseAggregation())
    expect(snap.payload.accounts[0]?.accountIdMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(snap.payload.runs[0]?.accountRefMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(maskAccountId('abcdefgh')).toBe('acc_***efgh')
    expect(isCanonicalMaskedAccountId('acc_***efgh')).toBe(true)
    // acc_ prefix alone is NOT masking
    expect(isCanonicalMaskedAccountId('acc_plaintextSECRET99')).toBe(false)
    expect(maskAccountId('acc_plaintextSECRET99')).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(maskAccountId('acc_plaintextSECRET99')).not.toContain('plaintext')
    expect(maskAccountId('acc_plaintextSECRET99')).not.toContain('SECRET')
  })

  it('hostile acc_ residual identity is remasked on materialize', () => {
    const snap = materializePublicSnapshot(
      baseAggregation({
        accounts: [
          {
            accountIdMasked: 'acc_rawIdentityHOSTILE1',
            status: 'ACTIVE',
            usable: true,
          },
        ],
        runs: [
          {
            runId: 'run-h',
            status: 'RUNNING',
            accountRefMasked: 'acc_rawIdentityHOSTILE1',
          },
        ],
      }),
    )
    expect(snap.payload.accounts[0]?.accountIdMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(snap.payload.accounts[0]?.accountIdMasked).not.toContain('rawIdentity')
    expect(snap.payload.runs[0]?.accountRefMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(snap.bodyJson).not.toContain('rawIdentity')
    expect(snap.bodyJson).not.toContain('HOSTILE')
  })

  it('usable=false forced for BAN/403/AUTH_EXPIRED even if caller set usable true', () => {
    for (const status of ['BAN', '403', 'AUTH_EXPIRED', 'quarantine']) {
      const snap = materializePublicSnapshot(
        baseAggregation({
          accounts: [{ accountIdMasked: 'acc_***ab12', status, usable: true }],
        }),
      )
      expect(snap.payload.accounts[0]?.usable).toBe(false)
    }
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
    schemaVersion: '005',
  }
  const healthyObserved: HealthObserved = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '005',
    migration: {
      status: 'READY',
      appliedVersions: ['000', '001', '002', '003', '004', '005'],
      expectedLatestVersion: '005',
      schemaVersion: '005',
    },
    snapshot: {
      canonicalSnapshotId: 'snap-1',
      boardRev: 10,
      lifecycleRev: 5,
      canonicalHash: 'a'.repeat(64),
    },
    dependencies: [
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
      { name: 'schema-required-tables', status: 'up' },
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
    expect(p.schema.version).toBe('005')
    expect(p.schema.match).toBe(true)
    expect(p.release.match).toBe(true)
    expect(p.canonicalSnapshotId).toBe('snap-1')
    expect(p.canonicalHash).toBe('a'.repeat(64))
    expect(p.boardRev).toBe(10)
    expect(p.lifecycleRev).toBe(5)
    expect(p.migration.status).toBe('READY')
    expect(p.dependencies).toEqual([
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
      { name: 'schema-required-tables', status: 'up' },
    ])
  })

  it('surfaces null canonicalHash when pin hash unproven (never invents)', async () => {
    const noHash: HealthObserved = {
      ...healthyObserved,
      snapshot: {
        canonicalSnapshotId: 'snap-no-hash',
        boardRev: 1,
        lifecycleRev: 1,
        canonicalHash: null,
      },
    }
    const result = await handleHealthz(new Request('http://local/api/healthz'), {
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => noHash,
    })
    expect(result.status).toBe(200)
    const p = result.payload as ReturnType<typeof buildHealthzPayload>
    expect(p.canonicalSnapshotId).toBe('snap-no-hash')
    expect(p.canonicalHash).toBeNull()
    expect(Object.prototype.hasOwnProperty.call(p, 'canonicalHash')).toBe(true)
  })

  it('only 003 applied (prior-schema) => unhealthy vs latest expected 005', () => {
    const only003: HealthObserved = {
      ...healthyObserved,
      schemaVersion: '003',
      migration: {
        status: 'PENDING',
        appliedVersions: ['000', '001', '002', '003'],
        expectedLatestVersion: '005',
        schemaVersion: '003',
      },
      // Prior-schema: 004/005 tables not required yet for claimed history
      dependencies: [
        { name: 'mysql', status: 'up' },
        { name: 'mcp', status: 'up' },
      ],
    }
    const evaled = evaluateHealthStatus(expected, only003)
    expect(evaled.status).toBe('unhealthy')
    expect(evaled.schemaMatch).toBe(false)
    expect(evaled.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
  })

  it('history 005 but required table missing => unhealthy (schema unproven)', () => {
    // loadObserved clears schemaVersion when required 004/005 tables are missing.
    const missingTables: HealthObserved = {
      ...healthyObserved,
      schemaVersion: '',
      migration: {
        status: 'PENDING',
        appliedVersions: ['000', '001', '002', '003', '004', '005'],
        expectedLatestVersion: '005',
        schemaVersion: '',
      },
      dependencies: [
        { name: 'mysql', status: 'up' },
        { name: 'mcp', status: 'up' },
        {
          name: 'schema-required-tables',
          status: 'down',
          detail: 'missing:control_plane_dispatch_plans',
        },
      ],
    }
    const evaled = evaluateHealthStatus(expected, missingTables)
    expect(evaled.status).toBe('unhealthy')
    expect(evaled.schemaMatch).toBe(false)
    expect(evaled.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
    expect(evaled.unhealthyReasons).toContain('DEPENDENCY_DOWN:schema-required-tables')
  })

  it('all required (005 history + tables up) => healthy', () => {
    const evaled = evaluateHealthStatus(expected, healthyObserved)
    expect(evaled.status).toBe('ok')
    expect(evaled.schemaMatch).toBe(true)
    expect(evaled.releaseMatch).toBe(true)
    expect(evaled.unhealthyReasons).toEqual([])
  })

  it('requiredTablesForAppliedVersions covers 004/005/006 probes', () => {
    expect(requiredTablesForAppliedVersions(['000', '001', '002', '003'])).toEqual([])
    expect(requiredTablesForAppliedVersions(['000', '001', '002', '003', '004'])).toEqual([
      ...REQUIRED_TABLES_BY_MIGRATION['004'],
    ])
    expect(requiredTablesForAppliedVersions(['000', '001', '002', '003', '004', '005'])).toEqual([
      ...REQUIRED_TABLES_BY_MIGRATION['004'],
      ...REQUIRED_TABLES_BY_MIGRATION['005'],
    ])
    expect(
      requiredTablesForAppliedVersions(['000', '001', '002', '003', '004', '005', '006']),
    ).toEqual([
      ...REQUIRED_TABLES_BY_MIGRATION['004'],
      ...REQUIRED_TABLES_BY_MIGRATION['005'],
      ...REQUIRED_TABLES_BY_MIGRATION['006'],
    ])
    expect(REQUIRED_TABLES_BY_MIGRATION['006']).toEqual([
      'control_plane_stage_evidence_receipts',
    ])
  })

  // Current-latest schema 006: fail-closed when history claims 006 but stage-evidence table absent;
  // healthy only when required tables (incl. control_plane_stage_evidence_receipts) are up.
  const expected006: HealthExpected = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '006',
  }
  const healthy006: HealthObserved = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '006',
    migration: {
      status: 'READY',
      appliedVersions: ['000', '001', '002', '003', '004', '005', '006'],
      expectedLatestVersion: '006',
      schemaVersion: '006',
    },
    snapshot: {
      canonicalSnapshotId: 'snap-1',
      boardRev: 10,
      lifecycleRev: 5,
      canonicalHash: 'a'.repeat(64),
    },
    dependencies: [
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
      { name: 'schema-required-tables', status: 'up' },
    ],
    serviceName: 'cairn-task-manager',
  }

  it('history 006 but control_plane_stage_evidence_receipts missing => unhealthy (fail-closed)', () => {
    // loadObserved clears schemaVersion when required 006 table is missing.
    const missing006Table: HealthObserved = {
      ...healthy006,
      schemaVersion: '',
      migration: {
        status: 'PENDING',
        appliedVersions: ['000', '001', '002', '003', '004', '005', '006'],
        expectedLatestVersion: '006',
        schemaVersion: '',
      },
      dependencies: [
        { name: 'mysql', status: 'up' },
        { name: 'mcp', status: 'up' },
        {
          name: 'schema-required-tables',
          status: 'down',
          detail: 'missing:control_plane_stage_evidence_receipts',
        },
      ],
    }
    const evaled = evaluateHealthStatus(expected006, missing006Table)
    expect(evaled.status).toBe('unhealthy')
    expect(evaled.schemaMatch).toBe(false)
    expect(evaled.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
    expect(evaled.unhealthyReasons).toContain('DEPENDENCY_DOWN:schema-required-tables')
  })

  it('all required (006 history + stage-evidence table up) => healthy', () => {
    const evaled = evaluateHealthStatus(expected006, healthy006)
    expect(evaled.status).toBe('ok')
    expect(evaled.schemaMatch).toBe(true)
    expect(evaled.releaseMatch).toBe(true)
    expect(evaled.unhealthyReasons).toEqual([])
  })

  it('injected history 006 + stage-evidence table missing → 503 unhealthy', async () => {
    const prev = getHealthzDeps()
    try {
      setHealthzDeps({
        authGuard: allowAllHealthGuard(),
        loadExpected: () => expected006,
        loadObserved: () => ({
          ...healthy006,
          schemaVersion: '',
          migration: {
            status: 'PENDING',
            appliedVersions: ['000', '001', '002', '003', '004', '005', '006'],
            expectedLatestVersion: '006',
            schemaVersion: '',
          },
          dependencies: [
            { name: 'mysql', status: 'up' },
            {
              name: 'schema-required-tables',
              status: 'down',
              detail: 'missing:control_plane_stage_evidence_receipts',
            },
          ],
        }),
      })
      const res = await healthzGetHandler(new Request('http://local/api/healthz'))
      expect(res.status).toBe(503)
      const body = await res.json()
      expect(body.status).toBe('unhealthy')
      expect(body.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
      expect(body.unhealthyReasons).toContain('DEPENDENCY_DOWN:schema-required-tables')
      // Public payload maps deps to name+status only (detail is operator-side on observed).
      expect(
        body.dependencies?.some(
          (d: { name: string; status: string }) =>
            d.name === 'schema-required-tables' && d.status === 'down',
        ),
      ).toBe(true)
    } finally {
      setHealthzDeps(prev)
    }
  })

  it('injected all-required healthy 006 path → 200 ok', async () => {
    const prev = getHealthzDeps()
    try {
      setHealthzDeps({
        authGuard: allowAllHealthGuard(),
        loadExpected: () => expected006,
        loadObserved: () => healthy006,
      })
      const res = await healthzGetHandler(new Request('http://local/api/healthz'))
      expect(res.status).toBe(200)
      const body = await res.json()
      expect(body.status).toBe('ok')
      expect(body.schema.version).toBe('006')
      expect(body.schema.match).toBe(true)
      expect(body.migration.appliedVersions).toEqual([
        '000',
        '001',
        '002',
        '003',
        '004',
        '005',
        '006',
      ])
      expect(body.migration.expectedLatestVersion).toBe('006')
    } finally {
      setHealthzDeps(prev)
    }
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
  afterEach(() => {
    resetPublicSnapshotDeps()
    setPublicBoardAllowlistForTests(null)
    setTestPublicSnapshotService(null)
    resetPublicSnapshotServiceForTests()
  })

  it('default deps share MCP public-snapshot-service store + rate limiter', () => {
    resetPublicSnapshotServiceForTests()
    const shared = getSharedPublicSnapshotService()
    const deps = getPublicSnapshotDeps()
    expect(deps.loadAggregation).toBe(loadPublicAggregation)
    expect(deps.store).toBe(shared.store)
    expect(deps.rateLimiter).toBe(shared.rateLimiter)
    expect(typeof deps.resolveIp).toBe('function')
  })

  it('public board allowlist fail-closed when unset / board not listed', async () => {
    setPublicBoardAllowlistForTests([])
    expect(isPublicBoardAllowed('ibils')).toBe(false)
    expect(await loadPublicAggregation('ibils')).toBeNull()
    expect(await loadPublicAggregation('board-does-not-exist-w15-05')).toBeNull()

    setPublicBoardAllowlistForTests(['only-this-board'])
    expect(isPublicBoardAllowed('ibils')).toBe(false)
    expect(await loadPublicAggregation('ibils')).toBeNull()
  })

  it('loadPublicAggregation returns null for missing/disallowed board (fail-closed, no invent)', async () => {
    setPublicBoardAllowlistForTests(['board-does-not-exist-w15-05'])
    const agg = await loadPublicAggregation('board-does-not-exist-w15-05')
    // Board missing or sectionErrors/stale from control-center load → null
    expect(agg).toBeNull()
  })

  it('installed handler returns 503 STALE_OR_MISSING for missing board — no invented body', async () => {
    // Use default shared deps (real loadPublicAggregation) — disallowed board
    setPublicBoardAllowlistForTests([])
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

  it('API handler + MCP service share store: revision/hash/count/ETag parity', async () => {
    resetPublicSnapshotServiceForTests()
    const sharedStore = createMemoryPublicSnapshotStore()
    const sharedLimiter = createPublicSnapshotRateLimiter({
      policy: { burst: 100, sustainedPerMinute: 600 },
    })
    const svc = createPublicSnapshotService({
      store: sharedStore,
      rateLimiter: sharedLimiter,
    })
    setTestPublicSnapshotService(svc)

    const input = baseAggregation({
      pin: basePin({
        canonicalSnapshotId: 'snap-parity-1',
        canonicalHash: 'c'.repeat(64),
        boardRev: 7,
        lifecycleRev: 3,
      }),
      decisionCount: 5,
      g5: { g5Pass: true, domainPassCount: 9, domainRequiredCount: 9 },
    })

    // MCP service path
    const mcp = await svc.getPublicSnapshot({
      boardId: 'board-1',
      loadAggregation: async () => input,
      skipRateLimit: true,
    })
    expect(mcp.ok).toBe(true)
    if (!mcp.ok) throw new Error('mcp load failed')

    // HTTP path with same shared store + same aggregation
    setPublicSnapshotDeps({
      store: sharedStore,
      loadAggregation: async () => input,
      rateLimiter: sharedLimiter,
      resolveIp: () => '10.0.0.1',
    })
    const httpRes = await publicSnapshotGetHandler(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
    )
    expect(httpRes.status).toBe(200)
    const httpBody = await httpRes.json()

    expect(httpBody.etag).toBe(mcp.etag)
    expect(httpBody.pin).toEqual(mcp.pin)
    expect(httpBody.decisionCount).toBe(5)
    expect(httpBody.decisionCount).toBe(mcp.snapshot.decisionCount)
    expect(httpBody.g5).toEqual(mcp.snapshot.g5)
    expect(httpBody.pin.boardRev).toBe(7)
    expect(httpBody.pin.lifecycleRev).toBe(3)
    expect(httpBody.pin.canonicalHash).toBe('c'.repeat(64))
    // Second MCP call replays same materialization (shared store)
    const mcp2 = await svc.getPublicSnapshot({
      boardId: 'board-1',
      loadAggregation: async () => input,
      skipRateLimit: true,
    })
    expect(mcp2.ok).toBe(true)
    if (mcp2.ok) {
      expect(mcp2.replayed).toBe(true)
      expect(mcp2.etag).toBe(mcp.etag)
    }
  })

  it('shared store: payload change (decisionCount) invalidates pin-stable cache + ETag', async () => {
    const store = createMemoryPublicSnapshotStore()
    const pin = basePin({ boardRev: 1, lifecycleRev: 1 })
    const v1 = baseAggregation({ pin, decisionCount: 1 })
    const v2 = baseAggregation({ pin, decisionCount: 2 })

    setPublicSnapshotDeps({
      store,
      loadAggregation: async () => v1,
      resolveIp: () => '1.1.1.1',
    })
    const r1 = await publicSnapshotGetHandler(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
    )
    expect(r1.status).toBe(200)
    const b1 = await r1.json()

    setPublicSnapshotDeps({
      store,
      loadAggregation: async () => v2,
      resolveIp: () => '1.1.1.1',
    })
    const r2 = await publicSnapshotGetHandler(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
    )
    expect(r2.status).toBe(200)
    const b2 = await r2.json()
    expect(b2.decisionCount).toBe(2)
    expect(b2.etag).not.toBe(b1.etag)
    // 304 only matches new etag
    const r304 = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': `"${b2.etag}"` },
      }),
      {
        store,
        loadAggregation: async () => v2,
      },
    )
    expect(r304.status).toBe(304)
    const staleMatch = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': `"${b1.etag}"` },
      }),
      {
        store,
        loadAggregation: async () => v2,
      },
    )
    expect(staleMatch.status).toBe(200)
  })
})

describe('one loader invocation per pin + exact revision/hash envelope', () => {
  it('getOrMaterialize materializes once per pin+content identity', () => {
    const store = createMemoryPublicSnapshotStore()
    const pin = basePin()
    const input = baseAggregation({ pin })
    const first = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input })
    // Same pin + same content → cache hit
    const second = getOrMaterializePublicSnapshot({
      boardId: 'board-1',
      store,
      input: baseAggregation({ pin }),
    })
    expect(second).toBe(first)
    expect(second.payload.decisionCount).toBe(2)
    expect(pinIdentity(second.pin)).toBe(pinIdentity(pin))

    // Same pin + different decisionCount → new materialization + new ETag
    const third = getOrMaterializePublicSnapshot({
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
    expect(third).not.toBe(first)
    expect(third.payload.decisionCount).toBe(999)
    expect(third.etag).not.toBe(first.etag)
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

  it('HTTP + MCP unauth share the same public-snapshot:${ip} rate-limit key', async () => {
    // Repair contract: unauth MCP tool/resource pass clientKey = resolvePublicSnapshotClientIp
    // so service keys as public-snapshot:${ip} — identical to HTTP handlePublicSnapshotGet.
    const limiter = createPublicSnapshotRateLimiter({
      policy: { burst: 1, sustainedPerMinute: 60 },
    })
    const sharedIp = '203.0.113.88'
    const deps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => baseAggregation(),
      rateLimiter: limiter,
      resolveIp: resolvePublicSnapshotClientIp,
    }
    const httpReq = requestWithSocketIp(
      'http://local/api/public-snapshot?boardId=board-1',
      sharedIp,
    )
    expect(resolvePublicSnapshotClientIp(httpReq)).toBe(sharedIp)
    expect((await handlePublicSnapshotGet(httpReq, deps)).status).toBe(200)

    // MCP unauth uses the same raw IP as clientKey → public-snapshot:${ip}
    const svc = createPublicSnapshotService({ rateLimiter: limiter })
    const mcp = await svc.getPublicSnapshot({
      boardId: 'board-1',
      clientKey: sharedIp,
      loadAggregation: async () => baseAggregation(),
    })
    expect(mcp.ok).toBe(false)
    if (!mcp.ok) {
      expect(mcp.code).toBe('RATE_LIMITED')
    }
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
    schemaVersion: '005',
  }
  const healthyObserved: HealthObserved = {
    deployedSha: 'd01d6d0aba17cc0aec23f3e4f8ad26229eac249f',
    schemaVersion: '005',
    migration: {
      status: 'READY',
      appliedVersions: ['000', '001', '002', '003', '004', '005'],
      expectedLatestVersion: '005',
      schemaVersion: '005',
    },
    snapshot: {
      canonicalSnapshotId: 'snap-1',
      boardRev: 10,
      lifecycleRev: 5,
      canonicalHash: 'a'.repeat(64),
    },
    dependencies: [
      { name: 'mysql', status: 'up' },
      { name: 'mcp', status: 'up' },
      { name: 'schema-required-tables', status: 'up' },
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

  it('injected only-003 applied → 503 unhealthy (compat: prior latest not current)', async () => {
    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => ({
        ...healthyObserved,
        schemaVersion: '003',
        migration: {
          status: 'PENDING',
          appliedVersions: ['000', '001', '002', '003'],
          expectedLatestVersion: '005',
          schemaVersion: '003',
        },
      }),
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
    expect(body.migration.appliedVersions).toEqual(['000', '001', '002', '003'])
    expect(body.migration.expectedLatestVersion).toBe('005')
  })

  it('injected history 005 + required table missing (empty schema) → 503 unhealthy', async () => {
    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => ({
        ...healthyObserved,
        schemaVersion: '',
        migration: {
          status: 'PENDING',
          appliedVersions: ['000', '001', '002', '003', '004', '005'],
          expectedLatestVersion: '005',
          schemaVersion: '',
        },
        dependencies: [
          { name: 'mysql', status: 'up' },
          {
            name: 'schema-required-tables',
            status: 'down',
            detail: 'missing:control_plane_classification_receipts',
          },
        ],
      }),
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(503)
    const body = await res.json()
    expect(body.status).toBe('unhealthy')
    expect(body.unhealthyReasons).toContain('SCHEMA_VERSION_MISMATCH')
    expect(body.unhealthyReasons).toContain('DEPENDENCY_DOWN:schema-required-tables')
  })

  it('injected all-required healthy 005 path → 200 ok', async () => {
    setHealthzDeps({
      authGuard: allowAllHealthGuard(),
      loadExpected: () => expected,
      loadObserved: () => healthyObserved,
    })
    const res = await healthzGetHandler(new Request('http://local/api/healthz'))
    expect(res.status).toBe(200)
    const body = await res.json()
    expect(body.status).toBe('ok')
    expect(body.schema.version).toBe('005')
    expect(body.schema.match).toBe(true)
    expect(body.migration.appliedVersions).toEqual(['000', '001', '002', '003', '004', '005'])
    expect(body.migration.expectedLatestVersion).toBe('005')
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

describe('domain-blocker sanitized public truth (never 503 for business blockers)', () => {
  it('forceStale + domainBlockers → 200 with usableCapacity=0 and freshness.stale=true', async () => {
    const input = baseAggregation({
      forceStale: true,
      usableCapacity: 99, // must be forced to 0 by domain blockers
      domainBlockers: [
        { code: 'DATA_INTEGRITY', count: 2, reason: 'section:classification' },
        { code: 'ACCOUNT_SYNC_MISSING', count: 1, reason: 'accountSyncMeta.missing' },
        // Structural codes must be dropped from public DTO
        { code: 'SCHEMA_INVALID', count: 1, reason: 'should-drop' },
        { code: 'PIN_AUTHORITY_INCOMPLETE', count: 1, reason: 'should-drop' },
      ],
      nowMs: Date.parse('2026-07-13T00:00:10.000Z'), // young age — without forceStale would be fresh
      publicationIntervalMs: 60_000,
      publishedAt: '2026-07-13T00:00:00.000Z',
    })

    const snap = materializePublicSnapshot(input)
    expect(snap.payload.freshness.stale).toBe(true)
    expect(snap.payload.usableCapacity).toBe(0)
    expect(snap.payload.domainBlockers.map((b) => b.code).sort()).toEqual([
      'ACCOUNT_SYNC_MISSING',
      'DATA_INTEGRITY',
    ])
    expect(snap.payload.accounts.every((a) => a.usable === false)).toBe(true)

    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => input,
      },
    )
    expect(result.kind).toBe('ok')
    expect(result.status).toBe(200)
    if (result.kind === 'ok') {
      const body = JSON.parse(result.body)
      expect(body.freshness.stale).toBe(true)
      expect(body.usableCapacity).toBe(0)
      expect(body.domainBlockers.some((b: { code: string }) => b.code === 'DATA_INTEGRITY')).toBe(
        true,
      )
      expect(result.headers['x-snapshot-stale']).toBe('1')
      // No private decision/account identity
      expect(result.body).not.toContain('PRIVATE')
      expect(result.body).not.toContain('token')
      expect(result.body).not.toContain('password')
    }
  })

  it('structural load miss remains 503 STALE_OR_MISSING (negative structural)', async () => {
    const result = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-missing'),
      {
        store: createMemoryPublicSnapshotStore(),
        loadAggregation: async () => null,
      },
    )
    expect(result.status).toBe(503)
    if (result.kind === 'error') {
      const body = JSON.parse(result.body)
      expect(body.code).toBe('STALE_OR_MISSING')
      expect(body.usableCapacity).toBeUndefined()
      expect(body.domainBlockers).toBeUndefined()
      expect(body.schemaVersion).toBeUndefined()
    }
  })

  it('domain blocker change invalidates content fingerprint + ETag', () => {
    const pin = basePin()
    const clean = baseAggregation({ pin, forceStale: false, usableCapacity: 4, domainBlockers: [] })
    const blocked = baseAggregation({
      pin,
      forceStale: true,
      usableCapacity: 0,
      domainBlockers: [{ code: 'UNCLASSIFIED', count: 3, reason: 'rollup.unclassifiedCount' }],
    })
    const fpClean = publicContentFingerprint(clean)
    const fpBlocked = publicContentFingerprint(blocked)
    expect(fpClean).not.toBe(fpBlocked)

    const store = createMemoryPublicSnapshotStore()
    const a = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input: clean })
    const b = getOrMaterializePublicSnapshot({ boardId: 'board-1', store, input: blocked })
    expect(a.etag).not.toBe(b.etag)
    expect(b.payload.freshness.stale).toBe(true)
    expect(b.payload.usableCapacity).toBe(0)
  })

  it('ETag/304 still works for domain-blocker snapshot; redaction preserved', async () => {
    const input = baseAggregation({
      forceStale: true,
      usableCapacity: 0,
      domainBlockers: [{ code: 'DATA_INTEGRITY', count: 1, reason: 'section:classification' }],
      accounts: [
        {
          accountIdMasked: 'acc_plaintextHOSTILE99',
          status: 'ACTIVE',
          usable: true,
        },
      ],
      runs: [
        {
          runId: 'run-x',
          status: 'RUNNING',
          accountRefMasked: 'raw-secret-account-token',
        },
      ],
    })
    const store = createMemoryPublicSnapshotStore()
    const first = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      { store, loadAggregation: async () => input },
    )
    expect(first.status).toBe(200)
    if (first.kind !== 'ok') throw new Error('expected ok')
    const body = JSON.parse(first.body)
    // Hostile acc_ remasked; raw identity not present
    expect(body.accounts[0].accountIdMasked).toMatch(/^acc_\*{3}[A-Za-z0-9]{4}$/)
    expect(first.body).not.toContain('plaintextHOSTILE')
    expect(first.body).not.toContain('raw-secret-account-token')
    expect(body.accounts[0].usable).toBe(false)

    const etag = first.headers.etag
    const second = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1', {
        headers: { 'if-none-match': etag },
      }),
      { store, loadAggregation: async () => input },
    )
    expect(second.status).toBe(304)
    expect(second.kind).toBe('not_modified')
  })

  it('rate limit still 429 under domain-blocker load path (shared policy)', async () => {
    const limiter = createPublicSnapshotRateLimiter({
      // Tiny burst so second request fails immediately
      policy: { burst: 1, sustainedPerMinute: 1 },
    })
    const input = baseAggregation({
      forceStale: true,
      usableCapacity: 0,
      domainBlockers: [{ code: 'ACCOUNT_SYNC_STALE', count: 1, reason: 'sla' }],
    })
    const deps: PublicSnapshotDeps = {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => input,
      rateLimiter: limiter,
      resolveIp: () => '203.0.113.50',
    }
    const r1 = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      deps,
    )
    expect(r1.status).toBe(200)
    const r2 = await handlePublicSnapshotGet(
      new Request('http://local/api/public-snapshot?boardId=board-1'),
      deps,
    )
    expect(r2.status).toBe(429)
    if (r2.kind === 'rate_limited') {
      const body = JSON.parse(r2.body)
      expect(body.code).toBe('RATE_LIMITED')
      expect(r2.headers['retry-after']).toBeTruthy()
    }
  })
})
