/**
 * C3-R2B pinned surface DOM attribute contract + primary roots binding.
 */
import { describe, it, expect } from 'vitest'
import { render, screen } from '@testing-library/react'
import {
  pinnedSurfaceDataAttrs,
  pinMetaFromEnvelope,
  PinnedSurface,
} from '#/components/control-center/PinnedSurface'
import { Overview } from '#/components/control-center/overview'
import { WorkScreen } from '#/components/control-center/work'
import { PriorityScreen } from '#/components/control-center/priority'
import { DecisionsScreen } from '#/components/control-center/decisions'
import type { DecisionItemView } from '#/components/control-center/decisions'

describe('pinnedSurfaceDataAttrs', () => {
  it('binds only envelope-derived values; omits missing; keeps zero revs', () => {
    expect(pinnedSurfaceDataAttrs(null)).toEqual({ 'data-pinned': 'false' })
    expect(
      pinnedSurfaceDataAttrs({
        canonicalSnapshotId: 'snap-a',
        canonicalHash: 'hash-a',
        boardRev: 0,
        lifecycleRev: 0,
      }),
    ).toEqual({
      'data-pinned': 'true',
      'data-canonical-snapshot-id': 'snap-a',
      'data-canonical-hash': 'hash-a',
      'data-board-rev': '0',
      'data-lifecycle-rev': '0',
    })
    expect(
      pinnedSurfaceDataAttrs({
        canonicalSnapshotId: '',
        canonicalHash: null,
        boardRev: null,
        lifecycleRev: 7,
      }),
    ).toEqual({
      'data-pinned': 'true',
      'data-lifecycle-rev': '7',
    })
  })

  it('pinMetaFromEnvelope copies envelope fields only', () => {
    expect(
      pinMetaFromEnvelope({
        canonicalSnapshotId: 's',
        canonicalHash: 'h',
        boardRev: 1,
        lifecycleRev: 2,
      }),
    ).toEqual({
      canonicalSnapshotId: 's',
      canonicalHash: 'h',
      boardRev: 1,
      lifecycleRev: 2,
    })
    expect(pinMetaFromEnvelope(null)).toBeNull()
  })

  it('PinnedSurface component stamps attrs', () => {
    render(
      <PinnedSurface
        pin={{
          canonicalSnapshotId: 'snap-x',
          canonicalHash: 'hash-x',
          boardRev: 9,
          lifecycleRev: 8,
        }}
      >
        body
      </PinnedSurface>,
    )
    const el = screen.getByTestId('pinned-surface')
    expect(el.getAttribute('data-canonical-snapshot-id')).toBe('snap-x')
    expect(el.getAttribute('data-canonical-hash')).toBe('hash-x')
    expect(el.getAttribute('data-board-rev')).toBe('9')
    expect(el.getAttribute('data-lifecycle-rev')).toBe('8')
  })
})

describe('primary surface roots bind pin attrs from props', () => {
  it('Overview root', () => {
    render(
      <Overview
        surfaceState="empty"
        pin={{
          canonicalSnapshotId: 'ov-snap',
          canonicalHash: 'ov-hash',
          boardRev: 11,
          lifecycleRev: 2,
        }}
        appSummary={null}
        decision={null}
        priority={null}
        global={null}
        buckets={null}
        ongoing={[]}
        lower={null}
      />,
    )
    const root = screen.getByTestId('control-center-overview')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('ov-snap')
    expect(root.getAttribute('data-canonical-hash')).toBe('ov-hash')
    expect(root.getAttribute('data-board-rev')).toBe('11')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('2')
  })

  it('WorkScreen root', () => {
    render(
      <WorkScreen
        state="empty"
        boardId="mfs-rebuild"
        activeBucket="DONE"
        staleOverlayActive={false}
        items={[]}
        page={{
          cursor: null,
          nextCursor: null,
          pageSize: 50,
          hasMore: false,
        }}
        pinned={{
          canonicalSnapshotId: 'w-snap',
          canonicalHash: 'w-hash',
          taskHash: 't',
          boardRev: 4,
          lifecycleRev: 1,
        }}
      />,
    )
    const root = screen.getByTestId('work-screen')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('w-snap')
    expect(root.getAttribute('data-canonical-hash')).toBe('w-hash')
    expect(root.getAttribute('data-board-rev')).toBe('4')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('1')
  })

  it('PriorityScreen root', () => {
    render(
      <PriorityScreen
        uiState="empty"
        pin={{
          boardId: 'mfs-rebuild',
          canonicalSnapshotId: 'p-snap',
          canonicalHash: 'p-hash',
          boardRev: 5,
          lifecycleRev: 3,
        }}
      />,
    )
    const root = screen.getByTestId('priority-screen')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('p-snap')
    expect(root.getAttribute('data-canonical-hash')).toBe('p-hash')
    expect(root.getAttribute('data-board-rev')).toBe('5')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('3')
  })

  it('DecisionsScreen root', () => {
    const emptyItem: DecisionItemView = {
      decisionId: 'x',
      title: 't',
      question: null,
      severity: 'LOW',
      blocking: false,
      status: 'OPEN',
      dueAt: null,
      createdAt: '2026-07-13T00:00:00.000Z',
      snoozedUntil: null,
      type: 'owner',
      evidence: [],
      options: [],
      recommendation: null,
      ownerId: null,
      resolverId: null,
      selectedOptionId: null,
      expectedRev: null,
      boardRev: null,
      entityRev: null,
      scopedApprovalId: null,
      auditIds: [],
      ownerActions: ['View decision'],
      partialFields: true,
    }
    render(
      <DecisionsScreen
        surfaceState="populated"
        boardId="mfs-rebuild"
        items={[emptyItem]}
        openCount={1}
        blockingCount={0}
        pageSize={50}
        nextCursor={null}
        pin={{
          boardId: 'mfs-rebuild',
          canonicalSnapshotId: 'd-snap',
          canonicalHash: 'd-hash',
          boardRev: 6,
          lifecycleRev: 0,
          stale: false,
          staleReason: null,
        }}
      />,
    )
    const root = screen.getByTestId('control-center-decisions')
    expect(root.getAttribute('data-canonical-snapshot-id')).toBe('d-snap')
    expect(root.getAttribute('data-canonical-hash')).toBe('d-hash')
    expect(root.getAttribute('data-board-rev')).toBe('6')
    expect(root.getAttribute('data-lifecycle-rev')).toBe('0')
  })
})
