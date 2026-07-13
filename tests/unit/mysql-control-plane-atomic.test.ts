/**
 * MySQL ControlPlaneAtomicStore unit tests (memory SQL, no real DB).
 * Covers: restart durability, board isolation, CAS/stale, immutable audit, typed errors.
 */
import { beforeEach, describe, expect, it } from 'vitest'

import {
  ATOMIC_SQL,
  ControlPlaneAtomicError,
  createMemoryAtomicSqlExecutor,
  createMysqlControlPlaneAtomicStore,
  createMysqlControlPlaneAtomicStoreStrict,
} from '#/server/mysql-control-plane-atomic'

function sampleAudit(
  boardId: string,
  overrides: Partial<{
    eventId: string
    kind: 'PLAN_PUBLISHED' | 'ACCOUNT_SYNC' | 'DECISION_OPENED'
    atMs: number
    detail: Record<string, unknown>
  }> = {},
) {
  const atMs = overrides.atMs ?? Date.parse('2026-07-14T12:00:00.000Z')
  return {
    eventId: overrides.eventId,
    boardId,
    kind: overrides.kind ?? ('PLAN_PUBLISHED' as const),
    atMs,
    atISO: new Date(atMs).toISOString(),
    actorId: 'root',
    subjectType: 'dispatch_plan',
    subjectId: 'plan-1',
    detail: overrides.detail ?? { planHash: 'abc' },
    material: true as const,
  }
}

describe('mysql-control-plane-atomic', () => {
  let exec: ReturnType<typeof createMemoryAtomicSqlExecutor>
  let store: ReturnType<typeof createMysqlControlPlaneAtomicStore>

  beforeEach(() => {
    exec = createMemoryAtomicSqlExecutor()
    store = createMysqlControlPlaneAtomicStore(exec, { useNamedLock: false })
  })

  it('getBoardState returns zero defaults for unknown board without insert', async () => {
    const st = await store.getBoardState('board-missing')
    expect(st).toEqual({
      boardId: 'board-missing',
      boardRev: 0,
      dispatchBlocked: false,
      dispatchBlockedReason: null,
    })
    expect(exec.boards.size).toBe(0)
  })

  it('bumpBoardRev is monotonic and durable across store instances (restart)', async () => {
    const r1 = await store.bumpBoardRev('board-a')
    const r2 = await store.bumpBoardRev('board-a')
    expect(r1).toBe(1)
    expect(r2).toBe(2)

    // "Restart": new store over same durable executor tables
    const store2 = createMysqlControlPlaneAtomicStore(exec, { useNamedLock: false })
    const st = await store2.getBoardState('board-a')
    expect(st.boardRev).toBe(2)
    const r3 = await store2.bumpBoardRev('board-a')
    expect(r3).toBe(3)
  })

  it('setBoardState persists dispatch block and survives restart', async () => {
    await store.bumpBoardRev('board-a')
    await store.setBoardState({
      boardId: 'board-a',
      boardRev: 1,
      dispatchBlocked: true,
      dispatchBlockedReason: 'ACCOUNT_SYNC_STALE: miss SLA',
    })

    const store2 = createMysqlControlPlaneAtomicStore(exec, { useNamedLock: false })
    const st = await store2.getBoardState('board-a')
    expect(st.dispatchBlocked).toBe(true)
    expect(st.dispatchBlockedReason).toBe('ACCOUNT_SYNC_STALE: miss SLA')
    expect(st.boardRev).toBe(1)
  })

  it('setBoardState CAS rejects stale lower boardRev', async () => {
    await store.bumpBoardRev('board-a')
    await store.bumpBoardRev('board-a')
    const st = await store.getBoardState('board-a')
    expect(st.boardRev).toBe(2)

    await expect(
      store.setBoardState({
        boardId: 'board-a',
        boardRev: 1,
        dispatchBlocked: true,
        dispatchBlockedReason: 'stale-writer',
      }),
    ).rejects.toMatchObject({
      name: 'ControlPlaneAtomicError',
      code: 'STALE_REVISION',
    })

    const after = await store.getBoardState('board-a')
    expect(after.boardRev).toBe(2)
    expect(after.dispatchBlocked).toBe(false)
  })

  it('casBumpBoardRev succeeds only on matching expected rev', async () => {
    await store.bumpBoardRev('board-b') // → 1
    const next = await store.casBumpBoardRev('board-b', 1)
    expect(next).toBe(2)

    await expect(store.casBumpBoardRev('board-b', 1)).rejects.toMatchObject({
      code: 'STALE_REVISION',
    })
    expect((await store.getBoardState('board-b')).boardRev).toBe(2)
  })

  it('board isolation: audits and state do not leak across boardIds', async () => {
    await store.bumpBoardRev('board-a')
    await store.bumpBoardRev('board-b')
    await store.bumpBoardRev('board-b')
    await store.setBoardState({
      boardId: 'board-a',
      boardRev: 1,
      dispatchBlocked: true,
      dispatchBlockedReason: 'A-block',
    })
    await store.appendAudit(sampleAudit('board-a', { eventId: 'ev-a' }))
    await store.appendAudit(sampleAudit('board-b', { eventId: 'ev-b', kind: 'ACCOUNT_SYNC' }))

    const a = await store.getBoardState('board-a')
    const b = await store.getBoardState('board-b')
    expect(a.boardRev).toBe(1)
    expect(a.dispatchBlocked).toBe(true)
    expect(b.boardRev).toBe(2)
    expect(b.dispatchBlocked).toBe(false)

    const aAudit = await store.listAudit('board-a')
    const bAudit = await store.listAudit('board-b')
    expect(aAudit.map((e) => e.eventId)).toEqual(['ev-a'])
    expect(bAudit.map((e) => e.eventId)).toEqual(['ev-b'])
    expect(aAudit.every((e) => e.boardId === 'board-a')).toBe(true)
    expect(bAudit.every((e) => e.boardId === 'board-b')).toBe(true)
  })

  it('appendAudit is immutable: same eventId+payload replays; different payload throws', async () => {
    const ev = sampleAudit('board-a', { eventId: 'ev-1' })
    const first = await store.appendAudit(ev)
    expect(first.eventId).toBe('ev-1')
    expect(first.material).toBe(true)

    const replay = await store.appendAudit(ev)
    expect(replay.eventId).toBe('ev-1')
    expect(replay.detail).toEqual(ev.detail)

    await expect(
      store.appendAudit({
        ...ev,
        detail: { planHash: 'DIFFERENT' },
      }),
    ).rejects.toMatchObject({
      code: 'IMMUTABLE_AUDIT',
    })

    const listed = await store.listAudit('board-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.detail).toEqual({ planHash: 'abc' })
  })

  it('audit survives restart via shared executor tables', async () => {
    await store.appendAudit(sampleAudit('board-a', { eventId: 'ev-restart' }))
    const store2 = createMysqlControlPlaneAtomicStore(exec, { useNamedLock: false })
    const listed = await store2.listAudit('board-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.eventId).toBe('ev-restart')
    expect(listed[0]!.kind).toBe('PLAN_PUBLISHED')
  })

  it('withBoardLock serializes concurrent critical sections per board', async () => {
    const order: Array<string> = []
    const p1 = store.withBoardLock('board-lock', async () => {
      order.push('a-start')
      await new Promise((r) => setTimeout(r, 20))
      order.push('a-end')
      return 1
    })
    const p2 = store.withBoardLock('board-lock', async () => {
      order.push('b-start')
      order.push('b-end')
      return 2
    })
    const [r1, r2] = await Promise.all([p1, p2])
    expect(r1).toBe(1)
    expect(r2).toBe(2)
    expect(order).toEqual(['a-start', 'a-end', 'b-start', 'b-end'])
  })

  it('typed errors: invalid input surfaces ControlPlaneAtomicError codes', async () => {
    await expect(store.getBoardState('')).rejects.toMatchObject({
      code: 'INVALID_INPUT',
    })
    await expect(
      store.setBoardState({
        boardId: 'x',
        boardRev: -1,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    await expect(
      store.appendAudit({
        boardId: 'x',
        // @ts-expect-error intentional invalid kind
        kind: 'NOT_A_KIND',
        atMs: 1,
        atISO: 't',
        actorId: null,
        subjectType: 's',
        subjectId: 's',
        detail: {},
        material: true,
      }),
    ).rejects.toMatchObject({ code: 'INVALID_INPUT' })
    expect(new ControlPlaneAtomicError('DATA_INTEGRITY', 'x')).toBeInstanceOf(Error)
  })

  it('strict factory requires getConnection; useNamedLock:true without it fails', () => {
    const bare: { execute: typeof exec.execute } = { execute: exec.execute.bind(exec) }
    expect(() => createMysqlControlPlaneAtomicStoreStrict(bare as never)).toThrow(
      ControlPlaneAtomicError,
    )
    expect(() =>
      createMysqlControlPlaneAtomicStore(bare as never, { useNamedLock: true }),
    ).toThrow(/getConnection/)
  })

  it('strict factory with getConnection works for bump + audit', async () => {
    const strict = createMysqlControlPlaneAtomicStoreStrict(exec)
    const rev = await strict.bumpBoardRev('board-strict')
    expect(rev).toBe(1)
    const ev = await strict.appendAudit(sampleAudit('board-strict', { eventId: 'ev-strict' }))
    expect(ev.eventId).toBe('ev-strict')
  })

  it('ATOMIC_SQL covers board CAS and audit insert shapes', () => {
    expect(ATOMIC_SQL.casSetBoardState).toMatch(/WHERE board_id=\? AND board_rev=\?/)
    expect(ATOMIC_SQL.casBumpBoardRev).toMatch(/board_rev = board_rev \+ 1/)
    expect(ATOMIC_SQL.appendAudit).toMatch(/INSERT INTO audit_log/)
    expect(ATOMIC_SQL.listAudit).toMatch(/WHERE board_id=\?/)
  })
})
