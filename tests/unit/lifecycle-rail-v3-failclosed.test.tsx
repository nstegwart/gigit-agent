/**
 * LifecycleRail V3 fail-closed: no mutation without complete packet; exact payload when supplied.
 * Support evidence only (LOCAL ONLY / jsdom).
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'

import {
  ADVANCE_NEEDS_AGENT_REASON,
  LifecycleRail,
} from '#/components/LifecycleRail'
import type { AdvanceV3Packet } from '#/lib/board-query'
import type { LifecycleConfig } from '#/lib/types'

const mutate = vi.fn()

vi.mock('#/lib/board-query', async () => {
  const actual = await vi.importActual<typeof import('#/lib/board-query')>('#/lib/board-query')
  return {
    ...actual,
    useBoardId: () => 'board-test-1',
    useCanEdit: () => true,
    useLifecycle: (): LifecycleConfig => ({
      stages: [
        { key: 'MAPPING', label: 'Mapping', group: 'mapping', readiness: 10 },
        { key: 'MAPPED', label: 'Mapped', group: 'mapping', readiness: 20 },
        {
          key: 'MAP_VERIFIED',
          label: 'Map verified',
          group: 'mapping',
          gated: true,
          readiness: 30,
          verifierRole: 'verifier',
        },
      ],
    }),
    useTaskLifecycle: () => ({
      data: {
        stage: 'MAPPING',
        rev: 1,
        implementerRun: 'run-author-1',
        lifecycle: { history: [] },
      },
      isLoading: false,
      error: null,
    }),
    useAdvanceTask: () => ({
      mutate,
      isPending: false,
      isError: false,
      error: null,
    }),
  }
})

const TASK = 'task-rail-v3-1'
const CANON = 'a'.repeat(64)
const TASK_HASH = 'b'.repeat(64)

function validPacket(over: Partial<AdvanceV3Packet> = {}): AdvanceV3Packet {
  return {
    taskId: TASK,
    entityExpectedRev: 1,
    expectedBoardRev: 4,
    expectedLifecycleRev: 2,
    expectedTaskHash: TASK_HASH,
    canonicalHash: CANON,
    idempotencyKey: 'idem-rail-v3-1',
    byRunId: 'run-author-1',
    authorRunId: 'run-author-1',
    verifierRunId: 'run-verifier-1',
    receipt: {
      programmatic: true,
      receiptId: 'rcpt-mapped',
      fields: { mappingStructuralReceipt: 'ok' },
    },
    ...over,
  }
}

describe('LifecycleRail V3 fail-closed', () => {
  beforeEach(() => {
    mutate.mockReset()
  })

  it('without advancePacket: shows needs-agent reason + links; no mutation controls for non-gated stages', () => {
    render(<LifecycleRail taskId={TASK} />)

    expect(screen.getByTestId('lifecycle-advance-needs-agent')).toBeTruthy()
    expect(screen.getByTestId('lifecycle-advance-needs-agent-reason').textContent).toContain(
      ADVANCE_NEEDS_AGENT_REASON.slice(0, 40),
    )
    expect(screen.getByTestId('lifecycle-advance-agents-link').getAttribute('href')).toBe(
      '/b/board-test-1/agents',
    )
    expect(screen.getByTestId('lifecycle-advance-decisions-link').getAttribute('href')).toBe(
      '/b/board-test-1/decisions',
    )
    // No advance buttons — only detail/stage buttons
    expect(screen.queryByTestId('lifecycle-advance-MAPPED')).toBeNull()
    expect(screen.getByTestId('lifecycle-stage-MAPPED')).toBeTruthy()
    // Read display still present
    expect(screen.getByText('Ready-production')).toBeTruthy()
    expect(screen.getByText('MAPPING')).toBeTruthy()
  })

  it('without advancePacket: expanding a stage never calls mutate', () => {
    render(<LifecycleRail taskId={TASK} />)
    fireEvent.click(screen.getByTestId('lifecycle-stage-MAPPED'))
    expect(screen.getByTestId('lifecycle-stage-needs-agent-MAPPED')).toBeTruthy()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('with complete advancePacket: click sends exact V3 payload (no human fabrications)', () => {
    const packet = validPacket()
    render(<LifecycleRail taskId={TASK} advancePacket={packet} />)

    expect(screen.queryByTestId('lifecycle-advance-needs-agent')).toBeNull()
    const btn = screen.getByTestId('lifecycle-advance-MAPPED')
    fireEvent.click(btn)

    expect(mutate).toHaveBeenCalledTimes(1)
    const [payload] = mutate.mock.calls[0]
    expect(payload).toEqual({
      ...packet,
      toStage: 'MAPPED',
    })
    expect(payload.byRunId).not.toBe('human')
    expect(payload.entityExpectedRev).toBe(1)
    expect(payload.expectedBoardRev).toBe(4)
    expect(payload.expectedLifecycleRev).toBe(2)
    expect(payload.expectedTaskHash).toBe(TASK_HASH)
    expect(payload.canonicalHash).toBe(CANON)
    expect(payload.idempotencyKey).toBe('idem-rail-v3-1')
    expect(payload.authorRunId).toBe('run-author-1')
    expect(payload.verifierRunId).toBe('run-verifier-1')
    expect(payload.receipt.programmatic).toBe(true)
    expect(payload.toStage).toBe('MAPPED')
    // No legacy-only partial shape
    expect(payload).not.toEqual(
      expect.objectContaining({ byRunId: 'human', expectedRev: expect.anything() }),
    )
  })

  it('rejects packet for a different taskId (no mutation)', () => {
    render(
      <LifecycleRail taskId={TASK} advancePacket={validPacket({ taskId: 'other-task' })} />,
    )
    expect(screen.getByTestId('lifecycle-advance-needs-agent')).toBeTruthy()
    expect(screen.queryByTestId('lifecycle-advance-MAPPED')).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
  })

  it('rejects incomplete packet prop (legacy shape)', () => {
    render(
      <LifecycleRail
        taskId={TASK}
        advancePacket={
          { taskId: TASK, byRunId: 'human', expectedRev: 1 } as unknown as AdvanceV3Packet
        }
      />,
    )
    expect(screen.getByTestId('lifecycle-advance-needs-agent')).toBeTruthy()
    expect(screen.queryByTestId('lifecycle-advance-MAPPED')).toBeNull()
    expect(mutate).not.toHaveBeenCalled()
  })
})
