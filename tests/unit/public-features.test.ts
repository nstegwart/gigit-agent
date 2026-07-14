import { describe, expect, it } from 'vitest'
import {
  publicFeatureDetailHref,
  publicFeatureToRowView,
  publicFeaturesListHref,
  publicSnapshotToFeatureRows,
  pinViewFromPublicSnapshot,
  type PublicSnapshotPayload,
} from '#/lib/public-features'

describe('public-features helpers', () => {
  it('builds public list/detail hrefs with boardId', () => {
    expect(publicFeaturesListHref('mfs-rebuild')).toBe(
      '/public/features?boardId=mfs-rebuild',
    )
    expect(publicFeatureDetailHref('FC-AFF-MEMBER-REFERRAL', 'mfs-rebuild')).toBe(
      '/public/features/FC-AFF-MEMBER-REFERRAL?boardId=mfs-rebuild',
    )
  })

  it('maps public snapshot features to row views with progress nodes', () => {
    const snap: PublicSnapshotPayload = {
      boardId: 'mfs-rebuild',
      pin: {
        boardId: 'mfs-rebuild',
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'hash-1',
        boardRev: 3,
        lifecycleRev: 4,
        generatedAt: '2026-07-14T00:00:00.000Z',
      },
      freshness: { generatedAt: '2026-07-14T00:00:00.000Z', ageMs: 1000, stale: false },
      features: [
        {
          id: 'FC-AFF-MEMBER-REFERRAL',
          name: 'Member referral',
          projectId: 'affiliate-rebuild',
          phase: 'build',
          taskCount: 2,
          stageCounts: { MAPPED: 1, MAP_VERIFIED: 1 },
          progressNodes: [
            {
              taskId: 'T-AFF-1',
              title: 'Konten pemilik memerlukan peninjauan',
              technicalTitle: 'Integration closure X',
              contentReviewRequired: true,
              lifecycleStage: 'MAPPED',
              status: 'queued',
            },
            {
              taskId: 'T-AFF-2',
              title: 'Menampilkan harga checkout',
              contentReviewRequired: false,
              lifecycleStage: 'MAP_VERIFIED',
              status: 'active',
            },
          ],
        },
      ],
    }
    const rows = publicSnapshotToFeatureRows(snap, 'mfs-rebuild')
    expect(rows).toHaveLength(1)
    expect(rows[0]!.featureId).toBe('FC-AFF-MEMBER-REFERRAL')
    expect(rows[0]!.detailHref).toContain('/public/features/FC-AFF-MEMBER-REFERRAL')
    expect(rows[0]!.progressNodes).toHaveLength(2)
    expect(rows[0]!.progressNodes[0]!.contentReviewRequired).toBe(true)
    expect(rows[0]!.progressNodes[0]!.technicalTitle).toMatch(/Integration closure/)
    expect(rows[0]!.stageCounts.MAPPED).toBe(1)

    const pin = pinViewFromPublicSnapshot(snap, 'mfs-rebuild')
    expect(pin?.canonicalSnapshotId).toBe('snap-1')
    expect(pin?.boardRev).toBe(3)
    expect(pin?.stale).toBe(false)
  })

  it('returns null for feature rows without id (never invent)', () => {
    expect(publicFeatureToRowView({ name: 'x' }, 'mfs-rebuild')).toBeNull()
  })
})
