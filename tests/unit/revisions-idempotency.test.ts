import { describe, expect, it } from 'vitest'

import {
  CursorError,
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  compareCreatedAtIdDesc,
  decodeCursor,
  encodeCursor,
  isAfterCursorDesc,
  paginateDesc,
  resolvePage,
  resolvePageSize,
} from '#/server/cursor'
import {
  IDEMPOTENCY_CONFLICT,
  IDEMPOTENCY_TTL_MS,
  IdempotencyError,
  beginIdempotent,
  completeIdempotent,
  createMemoryIdempotencyStorage,
  redactSecrets,
  requestHashOf,
  scopeHashOf,
} from '#/server/idempotency'
import {
  STALE_REVISION,
  createMemoryRevisionStore,
  evaluateCas,
  subjectHashOf,
  type RevisionState,
} from '#/server/revisions'

describe('revisions CAS + STALE_REVISION metadata', () => {
  const base: RevisionState = {
    boardId: 'mfs-rebuild',
    entityType: 'task',
    entityId: 't-1',
    entityRev: 3,
    boardRev: 10,
    subjectHash: subjectHashOf({ title: 'a' }),
  }

  it('succeeds when entity+board rev and subject hash match', () => {
    const nextHash = subjectHashOf({ title: 'b' })
    const result = evaluateCas(base, {
      boardId: 'mfs-rebuild',
      entityType: 'task',
      entityId: 't-1',
      entityExpectedRev: 3,
      expectedBoardRev: 10,
      expectedSubjectHash: base.subjectHash!,
      nextSubjectHash: nextHash,
    })
    expect(result.ok).toBe(true)
    if (result.ok) {
      expect(result.entityRev).toBe(4)
      expect(result.boardRev).toBe(11)
      expect(result.subjectHash).toBe(nextHash)
    }
  })

  it('returns STALE_REVISION with safe current metadata on entity rev mismatch', () => {
    const result = evaluateCas(base, {
      boardId: 'mfs-rebuild',
      entityType: 'task',
      entityId: 't-1',
      entityExpectedRev: 2,
      expectedBoardRev: 10,
      expectedSubjectHash: base.subjectHash!,
      nextSubjectHash: subjectHashOf({ title: 'x' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(STALE_REVISION)
      expect(result.current.entityRev).toBe(3)
      expect(result.current.boardRev).toBe(10)
      expect(result.current.subjectHash).toBe(base.subjectHash)
      expect(result.current.entityId).toBe('t-1')
    }
  })

  it('returns STALE_REVISION on board rev mismatch (no last-write-wins)', () => {
    const result = evaluateCas(base, {
      boardId: 'mfs-rebuild',
      entityType: 'task',
      entityId: 't-1',
      entityExpectedRev: 3,
      expectedBoardRev: 9,
      expectedSubjectHash: base.subjectHash!,
      nextSubjectHash: subjectHashOf({ title: 'x' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) {
      expect(result.code).toBe(STALE_REVISION)
      expect(result.current.boardRev).toBe(10)
    }
  })

  it('returns STALE_REVISION on subject hash mismatch', () => {
    const result = evaluateCas(base, {
      boardId: 'mfs-rebuild',
      entityType: 'task',
      entityId: 't-1',
      entityExpectedRev: 3,
      expectedBoardRev: 10,
      expectedSubjectHash: 'deadbeef',
      nextSubjectHash: subjectHashOf({ title: 'x' }),
    })
    expect(result.ok).toBe(false)
    if (!result.ok) expect(result.code).toBe(STALE_REVISION)
  })

  it('memory store CAS is atomic under concurrent writers (one wins, one stale)', async () => {
    const store = createMemoryRevisionStore([base])
    const nextA = subjectHashOf({ title: 'A' })
    const nextB = subjectHashOf({ title: 'B' })
    const req = {
      boardId: 'mfs-rebuild',
      entityType: 'task',
      entityId: 't-1',
      entityExpectedRev: 3,
      expectedBoardRev: 10,
      expectedSubjectHash: base.subjectHash!,
    }
    const [r1, r2] = await Promise.all([
      store.compareAndSwap({ ...req, nextSubjectHash: nextA }),
      store.compareAndSwap({ ...req, nextSubjectHash: nextB }),
    ])
    const oks = [r1, r2].filter((r) => r.ok)
    const stales = [r1, r2].filter((r) => !r.ok)
    expect(oks).toHaveLength(1)
    expect(stales).toHaveLength(1)
    if (!stales[0]!.ok) {
      expect(stales[0]!.code).toBe(STALE_REVISION)
      expect(stales[0]!.current.entityRev).toBe(4)
    }
    const cur = await store.getEntity({ boardId: 'mfs-rebuild', entityType: 'task', entityId: 't-1' })
    expect(cur?.entityRev).toBe(4)
    expect(cur?.boardRev).toBe(11)
  })

  it('subjectHashOf is deterministic for key order', () => {
    expect(subjectHashOf({ a: 1, b: 2 })).toBe(subjectHashOf({ b: 2, a: 1 }))
  })
})

describe('cursor encode/decode/boundaries/order/tamper/revision pin', () => {
  it('defaults page size 50 and max 200 (fail-closed oversize)', () => {
    expect(resolvePageSize(undefined)).toBe(DEFAULT_PAGE_SIZE)
    expect(resolvePageSize(null)).toBe(50)
    expect(resolvePageSize(1)).toBe(1)
    expect(resolvePageSize(200)).toBe(MAX_PAGE_SIZE)
    expect(() => resolvePageSize(201)).toThrow(CursorError)
    try {
      resolvePageSize(201)
    } catch (e) {
      expect((e as CursorError).code).toBe('PAGE_SIZE_INVALID')
    }
    expect(() => resolvePageSize(0)).toThrow(CursorError)
    expect(() => resolvePageSize(-1)).toThrow(CursorError)
  })

  it('encode/decode round-trip is deterministic', () => {
    const payload = {
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 'task-9',
      boardRev: 7,
      snapshotRev: 'snap-1',
      order: 'DESC' as const,
    }
    const a = encodeCursor(payload)
    const b = encodeCursor(payload)
    expect(a).toBe(b)
    expect(decodeCursor(a)).toEqual(payload)
  })

  it('detects tampered cursor body', () => {
    const token = encodeCursor({
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 't1',
      boardRev: 1,
      order: 'DESC',
    })
    const parts = token.split('.')
    // flip a character in body
    const body = parts[1]!
    const flipped = (body[0] === 'A' ? 'B' : 'A') + body.slice(1)
    const bad = `${parts[0]}.${flipped}.${parts[2]}`
    expect(() => decodeCursor(bad)).toThrow(CursorError)
    try {
      decodeCursor(bad)
    } catch (e) {
      expect((e as CursorError).code).toBe('CURSOR_TAMPERED')
    }
  })

  it('enforces pinned boardRev / snapshotRev', () => {
    const token = encodeCursor({
      createdAt: '2026-07-13T08:00:00.000Z',
      id: 't1',
      boardRev: 5,
      snapshotRev: 's1',
      order: 'DESC',
    })
    expect(() => resolvePage({ cursor: token, expectedBoardRev: 6, expectedSnapshotRev: 's1' })).toThrow(
      CursorError,
    )
    try {
      resolvePage({ cursor: token, expectedBoardRev: 6, expectedSnapshotRev: 's1' })
    } catch (e) {
      expect((e as CursorError).code).toBe('CURSOR_REVISION_MISMATCH')
    }
    expect(() => resolvePage({ cursor: token, expectedBoardRev: 5, expectedSnapshotRev: 's2' })).toThrow(
      CursorError,
    )
    const ok = resolvePage({ cursor: token, expectedBoardRev: 5, expectedSnapshotRev: 's1', pageSize: 10 })
    expect(ok.pageSize).toBe(10)
    expect(ok.cursor?.id).toBe('t1')
  })

  it('DESC compare and after-cursor boundaries are stable', () => {
    const newer = { createdAt: '2026-07-13T10:00:00.000Z', id: 'b' }
    const older = { createdAt: '2026-07-13T09:00:00.000Z', id: 'a' }
    expect(compareCreatedAtIdDesc(newer, older)).toBeLessThan(0)
    expect(isAfterCursorDesc(older, newer)).toBe(true)
    expect(isAfterCursorDesc(newer, older)).toBe(false)

    // same createdAt → id DESC
    const a = { createdAt: '2026-07-13T10:00:00.000Z', id: 'a' }
    const b = { createdAt: '2026-07-13T10:00:00.000Z', id: 'b' }
    expect(compareCreatedAtIdDesc(b, a)).toBeLessThan(0)
  })

  it('paginateDesc walks pages with opaque nextCursor', () => {
    const rows = [
      { createdAt: '2026-07-13T05:00:00.000Z', id: 'e', title: 'e' },
      { createdAt: '2026-07-13T04:00:00.000Z', id: 'd', title: 'd' },
      { createdAt: '2026-07-13T03:00:00.000Z', id: 'c', title: 'c' },
      { createdAt: '2026-07-13T02:00:00.000Z', id: 'b', title: 'b' },
      { createdAt: '2026-07-13T01:00:00.000Z', id: 'a', title: 'a' },
    ]
    const p1 = paginateDesc(rows, { expectedBoardRev: 1, pageSize: 2 })
    expect(p1.items.map((r) => r.id)).toEqual(['e', 'd'])
    expect(p1.nextCursor).toBeTruthy()
    const p2 = paginateDesc(rows, { expectedBoardRev: 1, pageSize: 2, cursor: p1.nextCursor })
    expect(p2.items.map((r) => r.id)).toEqual(['c', 'b'])
    const p3 = paginateDesc(rows, { expectedBoardRev: 1, pageSize: 2, cursor: p2.nextCursor })
    expect(p3.items.map((r) => r.id)).toEqual(['a'])
    expect(p3.nextCursor).toBeNull()
  })
})

describe('idempotency replay / conflict / TTL / scope / concurrency', () => {
  it('scope hash is actor+board+endpoint+key', () => {
    const a = scopeHashOf({ actorId: 'u1', boardId: 'b1', endpoint: 'mutate', key: 'k1' })
    const b = scopeHashOf({ actorId: 'u1', boardId: 'b1', endpoint: 'mutate', key: 'k1' })
    const c = scopeHashOf({ actorId: 'u2', boardId: 'b1', endpoint: 'mutate', key: 'k1' })
    expect(a).toBe(b)
    expect(a).not.toBe(c)
  })

  it('redacts secrets from request hash inputs', () => {
    const red = redactSecrets({ password: 'x', token: 'y', title: 'ok' }) as Record<string, unknown>
    expect(red.password).toBe('[REDACTED]')
    expect(red.token).toBe('[REDACTED]')
    expect(red.title).toBe('ok')
    expect(requestHashOf({ password: 'a' })).toBe(requestHashOf({ password: 'b' }))
  })

  it('replays exact status/body for same key+hash', async () => {
    const storage = createMemoryIdempotencyStorage()
    const scope = { actorId: 'agent-1', boardId: 'mfs', endpoint: 'lifecycle.advance', key: 'idem-1' }
    const body = { stage: 'BUILT', title: 'x' }
    const begin1 = await beginIdempotent(storage, { scope, requestBody: body })
    expect(begin1.kind).toBe('EXECUTE')
    await completeIdempotent(storage, begin1.scopeHash, 200, { ok: true, stage: 'BUILT' }, begin1.requestHash)

    const begin2 = await beginIdempotent(storage, { scope, requestBody: body })
    expect(begin2.kind).toBe('REPLAY')
    expect(begin2.record?.responseStatus).toBe(200)
    expect(begin2.record?.responseBody).toEqual({ ok: true, stage: 'BUILT' })
  })

  it('returns 409 IDEMPOTENCY_CONFLICT for different hash same key', async () => {
    const storage = createMemoryIdempotencyStorage()
    const scope = { actorId: 'agent-1', boardId: 'mfs', endpoint: 'lifecycle.advance', key: 'idem-2' }
    const begin1 = await beginIdempotent(storage, { scope, requestBody: { stage: 'BUILT' } })
    await completeIdempotent(storage, begin1.scopeHash, 200, { ok: true }, begin1.requestHash)

    await expect(
      beginIdempotent(storage, { scope, requestBody: { stage: 'FUNCTIONAL' } }),
    ).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT, httpStatus: 409 })
  })

  it('TTL 24h: expired records allow re-execute', async () => {
    expect(IDEMPOTENCY_TTL_MS).toBe(24 * 60 * 60 * 1000)
    const storage = createMemoryIdempotencyStorage()
    const scope = { actorId: 'a', boardId: 'b', endpoint: 'e', key: 'k-ttl' }
    const t0 = 1_000_000
    const begin1 = await beginIdempotent(storage, {
      scope,
      requestBody: { n: 1 },
      nowMs: t0,
    })
    await completeIdempotent(storage, begin1.scopeHash, 200, { ok: true }, begin1.requestHash)

    const afterTtl = t0 + IDEMPOTENCY_TTL_MS + 1
    const begin2 = await beginIdempotent(storage, {
      scope,
      requestBody: { n: 2 },
      nowMs: afterTtl,
    })
    expect(begin2.kind).toBe('EXECUTE')
  })

  it('unique runId conflicts across scopes', async () => {
    const storage = createMemoryIdempotencyStorage()
    const begin1 = await beginIdempotent(storage, {
      scope: { actorId: 'a1', boardId: 'b', endpoint: 'register_run', key: 'k1' },
      requestBody: { runId: 'run-1' },
      runId: 'run-1',
    })
    await completeIdempotent(storage, begin1.scopeHash, 201, { runId: 'run-1' }, begin1.requestHash)

    await expect(
      beginIdempotent(storage, {
        scope: { actorId: 'a2', boardId: 'b', endpoint: 'register_run', key: 'k2' },
        requestBody: { runId: 'run-1' },
        runId: 'run-1',
      }),
    ).rejects.toMatchObject({ code: IDEMPOTENCY_CONFLICT })
  })

  it('concurrent begin for same key: one EXECUTE path wins, other REPLAY or IN_PROGRESS', async () => {
    const storage = createMemoryIdempotencyStorage()
    const scope = { actorId: 'a', boardId: 'b', endpoint: 'e', key: 'concurrent' }
    const body = { x: 1 }
    const results = await Promise.allSettled([
      beginIdempotent(storage, { scope, requestBody: body }),
      beginIdempotent(storage, { scope, requestBody: body }),
    ])
    const fulfilled = results.filter((r) => r.status === 'fulfilled') as Array<
      PromiseFulfilledResult<Awaited<ReturnType<typeof beginIdempotent>>>
    >
    const rejected = results.filter((r) => r.status === 'rejected')
    // At least one executes; the other is either REPLAY (if completed — not here) or IN_PROGRESS error
    const executes = fulfilled.filter((r) => r.value.kind === 'EXECUTE')
    expect(executes.length).toBeGreaterThanOrEqual(1)
    if (rejected.length) {
      expect((rejected[0] as PromiseRejectedResult).reason).toBeInstanceOf(IdempotencyError)
    }
    if (executes.length === 2) {
      // both got EXECUTE only if putIfAbsent raced incorrectly — must not happen
      expect(executes).toHaveLength(1)
    }
    // complete the winner and ensure replay works
    const winner = executes[0]!.value
    await completeIdempotent(storage, winner.scopeHash, 200, { ok: true }, winner.requestHash)
    const replay = await beginIdempotent(storage, { scope, requestBody: body })
    expect(replay.kind).toBe('REPLAY')
  })

  it('requires idempotency key', async () => {
    const storage = createMemoryIdempotencyStorage()
    await expect(
      beginIdempotent(storage, {
        scope: { actorId: 'a', boardId: 'b', endpoint: 'e', key: '' },
        requestBody: {},
      }),
    ).rejects.toMatchObject({ code: 'IDEMPOTENCY_KEY_REQUIRED' })
  })
})
