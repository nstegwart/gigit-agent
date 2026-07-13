/**
 * Owner HTTP lifecycle client — V3 packet fail-closed (board-query AdvancePayload).
 * Support evidence only (LOCAL ONLY). Does not exercise live HTTP+DB.
 */
import { describe, expect, it } from 'vitest'

import {
  isCompleteAdvanceV3Packet,
  toAdvancePayload,
  type AdvanceV3Packet,
} from '#/lib/board-query'

const TASK = 'task-client-v3-1'
const CANON = 'c'.repeat(64)
const TASK_HASH = 't'.repeat(64)

function validPacket(over: Partial<AdvanceV3Packet> = {}): AdvanceV3Packet {
  return {
    taskId: TASK,
    entityExpectedRev: 0,
    expectedBoardRev: 1,
    expectedLifecycleRev: 1,
    expectedTaskHash: TASK_HASH,
    canonicalHash: CANON,
    idempotencyKey: 'idem-client-v3-1',
    byRunId: 'run-author-1',
    authorRunId: 'run-author-1',
    verifierRunId: 'run-verifier-1',
    receipt: {
      programmatic: true,
      receiptId: 'rcpt-1',
      fields: { mappingStructuralReceipt: 'ok' },
    },
    ...over,
  }
}

describe('isCompleteAdvanceV3Packet', () => {
  it('accepts a full V3 packet with programmatic receipt and registered runs', () => {
    expect(isCompleteAdvanceV3Packet(validPacket())).toBe(true)
  })

  it('rejects legacy {byRunId:"human", expectedRev} shape', () => {
    expect(
      isCompleteAdvanceV3Packet({
        taskId: TASK,
        byRunId: 'human',
        expectedRev: 1,
      }),
    ).toBe(false)
  })

  it('rejects fabricated human/owner/ui run ids even with other fields', () => {
    for (const id of ['human', 'owner', 'ui', 'manual', 'Human']) {
      expect(isCompleteAdvanceV3Packet(validPacket({ byRunId: id }))).toBe(false)
      expect(isCompleteAdvanceV3Packet(validPacket({ authorRunId: id }))).toBe(false)
      expect(isCompleteAdvanceV3Packet(validPacket({ verifierRunId: id }))).toBe(false)
    }
  })

  it('rejects missing each required envelope field', () => {
    const keys = [
      'entityExpectedRev',
      'expectedBoardRev',
      'expectedLifecycleRev',
      'expectedTaskHash',
      'canonicalHash',
      'idempotencyKey',
      'byRunId',
      'authorRunId',
      'verifierRunId',
      'receipt',
    ] as const
    for (const k of keys) {
      const p = { ...validPacket() } as Record<string, unknown>
      delete p[k]
      expect(isCompleteAdvanceV3Packet(p), `missing ${k}`).toBe(false)
    }
  })

  it('rejects receipt without programmatic:true', () => {
    expect(
      isCompleteAdvanceV3Packet(
        validPacket({
          receipt: { programmatic: false as unknown as true, receiptId: 'x' },
        }),
      ),
    ).toBe(false)
    expect(
      isCompleteAdvanceV3Packet({
        ...validPacket(),
        receipt: { receiptId: 'x' } as AdvanceV3Packet['receipt'],
      }),
    ).toBe(false)
  })

  it('accepts entityExpectedRev via expectedEntityRev alias only when other required present', () => {
    const p = validPacket()
    const { entityExpectedRev: _drop, ...rest } = p
    expect(isCompleteAdvanceV3Packet({ ...rest, expectedEntityRev: 2 })).toBe(true)
    expect(isCompleteAdvanceV3Packet({ ...rest, expectedRev: 3 })).toBe(true)
  })
})

describe('toAdvancePayload', () => {
  it('merges toStage without inventing or dropping V3 fields', () => {
    const packet = validPacket({
      verdict: 'PASS',
      commitSha: 'abc123',
      evidence: { testReceipt: 'e2e' },
    })
    const payload = toAdvancePayload(packet, 'MAPPING')
    expect(payload).toEqual({
      ...packet,
      toStage: 'MAPPING',
    })
    expect(payload.entityExpectedRev).toBe(0)
    expect(payload.expectedBoardRev).toBe(1)
    expect(payload.expectedLifecycleRev).toBe(1)
    expect(payload.expectedTaskHash).toBe(TASK_HASH)
    expect(payload.canonicalHash).toBe(CANON)
    expect(payload.idempotencyKey).toBe('idem-client-v3-1')
    expect(payload.byRunId).toBe('run-author-1')
    expect(payload.authorRunId).toBe('run-author-1')
    expect(payload.verifierRunId).toBe('run-verifier-1')
    expect(payload.receipt.programmatic).toBe(true)
    expect(payload.toStage).toBe('MAPPING')
  })

  it('throws on incomplete packet (fail-closed)', () => {
    expect(() =>
      toAdvancePayload(
        { taskId: TASK, byRunId: 'human', expectedRev: 1 } as unknown as AdvanceV3Packet,
        'MAPPING',
      ),
    ).toThrow(/incomplete V3 advance packet/)
  })

  it('throws on empty toStage', () => {
    expect(() => toAdvancePayload(validPacket(), '')).toThrow(/toStage/)
  })
})
