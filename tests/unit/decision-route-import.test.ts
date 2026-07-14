/**
 * decisions-owner-fns import + prepareDecisionOwnerEnvelope with mocked runtime.
 * Proves server-fn module exports and pin-hash + stable idempotency emission without HTTP.
 * (Helpers live in #/server/decisions-owner-fns — not re-exported from client routes.)
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const boardHashMock = vi.fn(async (_boardId: string) => 'live-board-hash-fallback')
const getBoardStateMock = vi.fn(async (_boardId: string) => ({
  boardId: 'mfs-rebuild',
  boardRev: 4,
  lifecycleRev: 1,
  canonicalHash: 'durable-pin-hash-v1',
  subjectHash: 'durable-pin-hash-v1',
  canonicalSnapshotId: 'snap-1',
}))

vi.mock('#/server/board-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/server/board-store')>()
  return {
    ...actual,
    boardHash: (boardId: string) => boardHashMock(boardId),
  }
})

vi.mock('#/server/control-plane-runtime-context', () => ({
  getControlPlaneRuntimeContext: () => ({
    clock: { nowMs: () => 0, nowISO: () => '2026-07-13T00:00:00.000Z' },
    controlData: {
      decisions: {},
      imports: { getBoardState: getBoardStateMock },
      idempotency: {},
    },
    atomic: {},
    idempotency: {},
  }),
}))

describe('decisions-owner-fns prepareDecisionOwnerEnvelope', () => {
  beforeEach(() => {
    getBoardStateMock.mockClear()
    boardHashMock.mockClear()
    getBoardStateMock.mockResolvedValue({
      boardId: 'mfs-rebuild',
      boardRev: 4,
      lifecycleRev: 1,
      canonicalHash: 'durable-pin-hash-v1',
      subjectHash: 'durable-pin-hash-v1',
      canonicalSnapshotId: 'snap-1',
    })
  })
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('imports prepare + decisionDeps from runtime; owner fns from decisions-owner-fns', async () => {
    const runtime = await import('#/server/decisions-owner-runtime')
    const fns = await import('#/server/decisions-owner-fns')
    expect(typeof runtime.prepareDecisionOwnerEnvelope).toBe('function')
    expect(typeof runtime.decisionDeps).toBe('function')
    expect(typeof runtime.resolveCurrentDecisionPinHash).toBe('function')
    expect(typeof fns.acknowledgeDecisionOwnerFn).toBe('function')
    expect(typeof fns.resolveDecisionOwnerFn).toBe('function')
    expect(typeof fns.rejectDecisionOwnerFn).toBe('function')
    expect(typeof fns.snoozeDecisionOwnerFn).toBe('function')
    expect('prepareDecisionOwnerEnvelope' in fns).toBe(false)
    expect('decisionDeps' in fns).toBe(false)
  })

  it('route layout does not re-export server fns or runtime helpers', async () => {
    const mod = await import('#/routes/b.$boardId.decisions')
    expect('acknowledgeDecisionOwnerFn' in mod).toBe(false)
    expect('prepareDecisionOwnerEnvelope' in mod).toBe(false)
    expect('decisionDeps' in mod).toBe(false)
    expect('resolveCurrentDecisionPinHash' in mod).toBe(false)
  })

  it('prepareDecisionOwnerEnvelope resolves current pin + emits unique stable keys', async () => {
    const { prepareDecisionOwnerEnvelope } = await import('#/server/decisions-owner-runtime')

    const ack = await prepareDecisionOwnerEnvelope({
      action: 'acknowledge',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-9',
      expectedRev: 2,
      expectedBoardRev: 4,
      canonicalHash: 'durable-pin-hash-v1',
    })
    expect(ack.currentPinHash).toBe('durable-pin-hash-v1')
    expect(ack.canonicalHash).toBe('durable-pin-hash-v1')
    expect(ack.idempotencyKey).toContain('acknowledge')
    expect(ack.idempotencyKey).toContain('dec-9')
    expect(getBoardStateMock).toHaveBeenCalledWith('mfs-rebuild')

    const res = await prepareDecisionOwnerEnvelope({
      action: 'resolve',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-9',
      expectedRev: 2,
      expectedBoardRev: 4,
      canonicalHash: 'durable-pin-hash-v1',
      selectedOptionId: 'yes',
    })
    expect(res.idempotencyKey).not.toBe(ack.idempotencyKey)
    expect(res.idempotencyKey).toContain('resolve')
    expect(res.idempotencyKey).toContain('yes')

    // Same inputs → same key (stable retry)
    const ack2 = await prepareDecisionOwnerEnvelope({
      action: 'acknowledge',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-9',
      expectedRev: 2,
      expectedBoardRev: 4,
      canonicalHash: 'durable-pin-hash-v1',
    })
    expect(ack2.idempotencyKey).toBe(ack.idempotencyKey)

    // Explicit client key preserved
    const custom = await prepareDecisionOwnerEnvelope({
      action: 'reject',
      boardId: 'mfs-rebuild',
      decisionId: 'dec-9',
      expectedRev: 2,
      expectedBoardRev: 4,
      idempotencyKey: 'client-supplied-key-xyz',
    })
    expect(custom.idempotencyKey).toBe('client-supplied-key-xyz')
    // No client hash → bind to current pin
    expect(custom.canonicalHash).toBe('durable-pin-hash-v1')
  })

  it('resolveCurrentDecisionPinHash falls back to boardHash when import pin absent', async () => {
    getBoardStateMock.mockResolvedValueOnce(null as never)
    const { resolveCurrentDecisionPinHash } = await import('#/server/decisions-owner-runtime')
    const h = await resolveCurrentDecisionPinHash('mfs-rebuild')
    expect(h).toBe('live-board-hash-fallback')
    expect(boardHashMock).toHaveBeenCalledWith('mfs-rebuild')
  })

  it('decisionDeps includes idempotency (typecheck regression fix)', async () => {
    const { decisionDeps } = await import('#/server/decisions-owner-runtime')
    const d = decisionDeps()
    expect(d).toHaveProperty('idempotency')
    expect(d).toHaveProperty('decisions')
    expect(d).toHaveProperty('atomic')
    expect(d).toHaveProperty('clock')
  })
})
