/**
 * humanDisplay mass backfill + coverage emit unit tests.
 * Source-grounded, fail-closed, never invents PRODUCT, never auto-REVIEWED.
 */
import { describe, expect, it } from 'vitest'

import {
  HUMAN_DISPLAY_SCHEMA_VERSION,
  buildHumanDisplay,
  computeHumanDisplaySourceHash,
  type HumanDisplayV1,
} from '#/server/human-display'
import {
  HUMAN_DISPLAY_BACKFILL_SCHEMA_VERSION,
  buildEntitiesFromStagingFixture,
  buildSourceFactsForBackfill,
  planHumanDisplayBackfill,
  planHumanDisplayBackfillItem,
  runHumanDisplayBackfillDryRun,
  serializeBackfillPlan,
  type HumanDisplayBackfillEntity,
  type HumanDisplayBackfillPin,
} from '#/server/human-display-backfill'
import {
  HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION,
  HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION,
  classifyTitleDebt,
  emitHumanDisplayCoverage,
  recountContentDebt,
  type HumanDisplayCoverageEntityRow,
} from '#/server/human-display-coverage'

const PIN: HumanDisplayBackfillPin = {
  boardId: 'mfs-rebuild',
  canonicalSnapshotId: 'synth-c3-r2d-snap-001',
  canonicalHash:
    'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab',
  boardRev: 7,
  lifecycleRev: 3,
}

function entity(
  over: Partial<HumanDisplayBackfillEntity> &
    Pick<HumanDisplayBackfillEntity, 'entityId'>,
): HumanDisplayBackfillEntity {
  return {
    entityKind: 'task',
    technicalTitle: null,
    objective: 'Pelanggan menyelesaikan checkout dengan harga yang benar.',
    disposition: 'ACTIVE',
    taskClass: 'UNCLASSIFIED',
    classificationProofValid: false,
    ...over,
  }
}

describe('title debt classification (recomputed, not hard-coded)', () => {
  it('detects FC / Parity / Integration closure / API / E2E patterns', () => {
    expect(classifyTitleDebt('[FC-WEB-PREMIUM-E2E] Checkout quote')).toEqual(
      expect.arrayContaining(['fcNotation']),
    )
    expect(classifyTitleDebt('Parity refresh_token + revoke')).toContain(
      'parityFramed',
    )
    expect(classifyTitleDebt('Integration/closure: landing price variants')).toContain(
      'integrationClosure',
    )
    expect(classifyTitleDebt('API endpoint for checkout quote')).toContain(
      'apiPrimary',
    )
    expect(classifyTitleDebt('E2E flow premium checkout')).toContain('e2ePrimary')
  })

  it('returns empty for clean human titles', () => {
    expect(
      classifyTitleDebt('Menampilkan harga checkout dengan benar'),
    ).toEqual([])
  })
})

describe('planHumanDisplayBackfillItem fail-closed', () => {
  it('BLOCKED_MISSING_SOURCE when objective and userStory absent', () => {
    const item = planHumanDisplayBackfillItem(
      entity({
        entityId: 'task-missing-1',
        objective: null,
        userStory: null,
        technicalTitle: '[FC-X] something',
      }),
      PIN,
    )
    expect(item.action).toBe('WOULD_BLOCK_MISSING_SOURCE')
    expect(item.reviewStatus).toBe('BLOCKED_MISSING_SOURCE')
    expect(item.omissionReason).toBe('MISSING_OBJECTIVE')
    expect(item.display).not.toBeNull()
    expect(item.display!.title).not.toMatch(/^\[?FC-/i)
    expect(item.display!.schemaVersion).toBe(HUMAN_DISPLAY_SCHEMA_VERSION)
  })

  it('CONFLICT when conflictingSources disagree (never silent choose)', () => {
    const item = planHumanDisplayBackfillItem(
      entity({
        entityId: 'task-conflict-1',
        conflictingSources: [
          { path: 'task/a.objective', value: 'Outcome A' },
          { path: 'task/a.userStory', value: 'Outcome B' },
        ],
      }),
      PIN,
    )
    expect(item.action).toBe('WOULD_CONFLICT')
    expect(item.reviewStatus).toBe('CONFLICT')
    expect(item.omissionReason).toBe('CONFLICTING_SOURCES')
    expect(item.display!.citations.some((c) => c.field === 'conflict')).toBe(
      true,
    )
  })

  it('never invents PRODUCT without classificationProofValid', () => {
    const item = planHumanDisplayBackfillItem(
      entity({
        entityId: 'task-prod-guess',
        taskClass: 'PRODUCT',
        classificationProofValid: false,
        priority: 'P0',
      }),
      PIN,
    )
    expect(item.taskClass).toBe('UNCLASSIFIED')
    expect(item.isP0ActiveProduct).toBe(false)
    expect(item.reasons).toContain('PRODUCT_WITHOUT_PROOF')
  })

  it('accepts explicit PRODUCT with proof and marks P0 portfolio', () => {
    const item = planHumanDisplayBackfillItem(
      entity({
        entityId: 'task-p0-1',
        taskClass: 'PRODUCT',
        classificationProofValid: true,
        priority: 'P0',
        disposition: 'ACTIVE',
        humanCopy: {
          title: 'Menampilkan harga checkout dengan benar',
          outcome: 'Pelanggan melihat harga yang benar.',
        },
      }),
      PIN,
    )
    expect(item.taskClass).toBe('PRODUCT')
    expect(item.isP0ActiveProduct).toBe(true)
    expect(item.action).toBe('WOULD_WRITE')
    expect(item.reviewStatus).toBe('GENERATED_NEEDS_REVIEW')
    // Never auto-REVIEWED
    expect(item.display!.reviewStatus).toBe('GENERATED_NEEDS_REVIEW')
    expect(item.display!.reviewedAt).toBeNull()
  })

  it('binds pin (snapshot / boardRev / lifecycleRev) into sourceHash', () => {
    const e = entity({ entityId: 'task-pin-1' })
    const facts = buildSourceFactsForBackfill(e, PIN)
    const hash = computeHumanDisplaySourceHash(facts)
    const item = planHumanDisplayBackfillItem(e, PIN)
    expect(item.sourceHash).toBe(hash)
    expect(item.display!.snapshotId).toBe(PIN.canonicalSnapshotId)
    expect(item.display!.boardRev).toBe(PIN.boardRev)
    expect(item.display!.lifecycleRev).toBe(PIN.lifecycleRev)
  })

  it('skips fresh REVIEWED existing display', () => {
    const e = entity({
      entityId: 'task-reviewed-1',
      humanCopy: {
        title: 'Menampilkan harga checkout dengan benar',
        outcome: 'Pelanggan melihat harga yang benar di checkout.',
      },
      parentFeatureTitle: 'Checkout premium',
      businessArea: 'Panel Sales',
      actor: 'Reviewer',
      acceptance: 'Staging proves price match',
    })
    const facts = buildSourceFactsForBackfill(e, PIN)
    const existing: HumanDisplayV1 = buildHumanDisplay({
      entityKind: 'task',
      entityId: e.entityId,
      title: 'Menampilkan harga checkout dengan benar',
      outcome: 'Pelanggan melihat harga yang benar di checkout.',
      why: 'Kesalahan harga merugikan pendapatan.',
      current: 'Pemetaan selesai.',
      remaining: 'Bukti independen.',
      next: 'Tinjau ulang setelah perubahan.',
      doneWhen: 'Staging proves price match',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: facts,
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      parentFeatureTitle: 'Checkout premium',
      businessArea: 'Panel Sales',
      actor: 'Reviewer',
      citations: [
        { field: 'title', path: 'task/task-reviewed-1' },
        { field: 'outcome', path: 'task/task-reviewed-1.objective' },
      ],
      acceptanceLinks: [
        { path: 'task/task-reviewed-1.acceptance', summary: 'ok' },
      ],
      missionQuestionLinks: [
        { questionId: 'Q1', field: 'outcome' },
        { questionId: 'Q2', field: 'why' },
        { questionId: 'Q3', field: 'current' },
      ],
    })
    const item = planHumanDisplayBackfillItem(e, PIN, { display: existing })
    expect(item.action).toBe('WOULD_SKIP_FRESH_REVIEWED')
    expect(item.reviewStatus).toBe('REVIEWED')
  })

  it('demotes stale REVIEWED when pin/sourceHash drifts', () => {
    const e = entity({ entityId: 'task-stale-1' })
    const oldPin = { ...PIN, boardRev: 1 }
    const oldFacts = buildSourceFactsForBackfill(e, oldPin)
    const existing: HumanDisplayV1 = buildHumanDisplay({
      entityKind: 'task',
      entityId: e.entityId,
      title: 'Menampilkan harga checkout dengan benar',
      outcome: 'Pelanggan melihat harga yang benar.',
      why: 'Dampak pendapatan.',
      current: 'Selesai dipetakan.',
      remaining: 'Tidak ada',
      next: 'Pertahankan',
      doneWhen: 'ok',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: oldFacts,
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-01T00:00:00.000Z',
      parentFeatureTitle: 'Checkout',
      businessArea: 'Sales',
      actor: 'Reviewer',
      citations: [{ field: 'title', path: 'task/task-stale-1' }],
      acceptanceLinks: [{ path: 'a', summary: 's' }],
      missionQuestionLinks: [{ questionId: 'Q1', field: 'outcome' }],
    })
    const item = planHumanDisplayBackfillItem(e, PIN, { display: existing })
    expect(item.action).toBe('WOULD_DEMOTE_STALE')
    expect(item.reviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(item.omissionReason).toBe('STALE_REVIEWED')
  })

  it('never uses technical FC title as primary copy', () => {
    const item = planHumanDisplayBackfillItem(
      entity({
        entityId: 'task-fc-title',
        technicalTitle: '[FC-WEB] Checkout quote API',
        objective: 'Pelanggan melihat rincian harga checkout yang benar.',
        humanCopy: null,
      }),
      PIN,
    )
    expect(item.display!.title).not.toMatch(/FC-/i)
    expect(item.display!.title).not.toMatch(/^API\b/i)
  })
})

describe('planHumanDisplayBackfill mass + coverage', () => {
  it('emits coverage with byReviewStatus and contentDebt', () => {
    const entities: Array<HumanDisplayBackfillEntity> = [
      entity({
        entityId: 't-ok',
        objective: 'Hasil A',
        technicalTitle: 'Parity something',
      }),
      entity({
        entityId: 't-missing',
        objective: null,
        userStory: null,
        technicalTitle: '[FC-1] x',
      }),
      entity({
        entityId: 't-conflict',
        conflictingSources: [
          { path: 'a', value: '1' },
          { path: 'b', value: '2' },
        ],
      }),
      entity({
        entityId: 't-p0',
        taskClass: 'PRODUCT',
        classificationProofValid: true,
        priority: 'P0',
        technicalTitle: 'E2E flow checkout',
        humanCopy: {
          title: 'Menyelesaikan alur checkout ujung ke ujung',
          outcome: 'Checkout lulus di staging.',
        },
      }),
    ]
    const plan = planHumanDisplayBackfill({
      pin: PIN,
      entities,
      dryRun: true,
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(plan.schemaVersion).toBe(HUMAN_DISPLAY_BACKFILL_SCHEMA_VERSION)
    expect(plan.totals.entities).toBe(4)
    expect(plan.totals.wouldWrite).toBeGreaterThanOrEqual(2)
    expect(plan.totals.wouldBlock).toBe(1)
    expect(plan.totals.wouldConflict).toBe(1)

    const cov = plan.coverage
    expect(cov.schemaVersion).toBe(HUMAN_DISPLAY_COVERAGE_SCHEMA_VERSION)
    expect(cov.byReviewStatus).toBeDefined()
    expect(cov.contentDebt).toBeDefined()
    expect(cov.contentDebt.schemaVersion).toBe(
      HUMAN_DISPLAY_CONTENT_DEBT_SCHEMA_VERSION,
    )
    expect(cov.byReviewStatus.BLOCKED_MISSING_SOURCE).toBe(1)
    expect(cov.byReviewStatus.CONFLICT).toBe(1)
    expect(cov.byReviewStatus.GENERATED_NEEDS_REVIEW).toBeGreaterThanOrEqual(2)
    // content debt recount from technical titles
    expect(cov.contentDebt.titleDebt.parityFramed).toBeGreaterThanOrEqual(1)
    expect(cov.contentDebt.titleDebt.fcNotation).toBeGreaterThanOrEqual(1)
    expect(cov.contentDebt.titleDebt.e2ePrimary).toBeGreaterThanOrEqual(1)
    // P0 denominator recomputed (1), not hard-coded 316
    expect(cov.p0Coverage.total).toBe(1)
    expect(cov.p0Coverage.independentlyReviewed).toBe(0)
    expect(cov.p0Coverage.ratio).toBe('0/1')
    expect(cov.p0Coverage.releaseBlocked).toBe(true)
    expect(cov.p0Coverage.pass).toBe(false)
  })

  it('does not hard-code 639 or 316 as live truth', () => {
    const plan = runHumanDisplayBackfillDryRun({
      pin: PIN,
      entities: [entity({ entityId: 'only-one', objective: 'x' })],
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(plan.coverage.contentDebt.totalTasks).toBe(1)
    expect(plan.coverage.p0Coverage.total).toBe(0)
    expect(plan.coverage.contentDebt.historicalBaselineNote).toMatch(/316/)
    // live totals must equal input size
    expect(plan.coverage.totals.entities).toBe(1)
  })

  it('serializeBackfillPlan is JSON-safe and includes coverage keys', () => {
    const plan = runHumanDisplayBackfillDryRun({
      pin: PIN,
      entities: [entity({ entityId: 's1', objective: 'Hasil' })],
    })
    const ser = serializeBackfillPlan(plan)
    const json = JSON.stringify(ser)
    const parsed = JSON.parse(json) as {
      coverage: { byReviewStatus: unknown; contentDebt: unknown }
    }
    expect(parsed.coverage.byReviewStatus).toBeDefined()
    expect(parsed.coverage.contentDebt).toBeDefined()
  })
})

describe('buildEntitiesFromStagingFixture', () => {
  it('builds tasks from MANIFEST + taxonomy projects, pin from pin.json', () => {
    const { pin, entities } = buildEntitiesFromStagingFixture({
      manifest: {
        boardId: 'mfs-rebuild',
        taskIds: [
          'task-done-1',
          'task-ongoing-1',
          'task-next-1',
          'task-queued-1',
          'task-blocked-1',
          'task-recon-1',
          'task-stale-1',
          'task-missing-proof-1',
        ],
        pin: {
          canonicalSnapshotId: 'from-manifest',
          boardRev: 1,
          lifecycleRev: 1,
        },
      },
      pinFile: {
        canonicalSnapshotId: 'synth-c3-r2d-snap-001',
        canonicalHash: PIN.canonicalHash,
        boardRev: 7,
        lifecycleRev: 3,
      },
      includeTaxonomyProjects: true,
    })
    expect(pin.canonicalSnapshotId).toBe('synth-c3-r2d-snap-001')
    expect(pin.boardRev).toBe(7)
    const tasks = entities.filter((e) => e.entityKind === 'task')
    const projects = entities.filter((e) => e.entityKind === 'project')
    expect(tasks).toHaveLength(8)
    expect(projects.length).toBeGreaterThanOrEqual(4)
    // MANIFEST tasks without overrides → missing objective
    expect(tasks.every((t) => !t.objective)).toBe(true)
  })

  it('merges entity overrides by kind+id', () => {
    const { entities } = buildEntitiesFromStagingFixture({
      manifest: {
        boardId: 'mfs-rebuild',
        taskIds: ['task-done-1'],
      },
      pinFile: PIN,
      entityOverrides: [
        entity({
          entityId: 'task-done-1',
          objective: 'Pekerjaan selesai terbukti independen.',
          humanCopy: {
            title: 'Menyelesaikan pekerjaan dengan bukti independen',
            outcome: 'Item selesai dan terbukti.',
          },
        }),
      ],
      includeTaxonomyProjects: false,
    })
    expect(entities).toHaveLength(1)
    expect(entities[0]!.objective).toMatch(/selesai/)
  })
})

describe('recountContentDebt / emitHumanDisplayCoverage', () => {
  it('aggregates byReviewStatus including MISSING_DISPLAY', () => {
    const rows: Array<HumanDisplayCoverageEntityRow> = [
      {
        entityKind: 'task',
        entityId: 'a',
        missingDisplay: true,
        technicalTitle: '[FC-1] a',
      },
      {
        entityKind: 'task',
        entityId: 'b',
        effectiveReviewStatus: 'REVIEWED',
        locale: 'id-ID',
        priority: 'P0',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        isP0ActiveProduct: true,
      },
      {
        entityKind: 'task',
        entityId: 'c',
        effectiveReviewStatus: 'GENERATED_NEEDS_REVIEW',
        locale: 'id-ID',
        priority: 'P0',
        taskClass: 'PRODUCT',
        disposition: 'ACTIVE',
        isP0ActiveProduct: true,
        technicalTitle: 'Parity foo',
      },
    ]
    const debt = recountContentDebt(rows)
    expect(debt.totalTasks).toBe(3)
    expect(debt.byEffectiveStatus.MISSING_DISPLAY).toBe(1)
    expect(debt.byEffectiveStatus.REVIEWED).toBe(1)
    expect(debt.p0ActiveProduct.total).toBe(2)
    expect(debt.p0ActiveProduct.independentlyReviewed).toBe(1)
    expect(debt.p0ActiveProduct.ratio).toBe('1/2')
    expect(debt.p0ActiveProduct.pass).toBe(false)
    expect(debt.titleDebt.fcNotation).toBe(1)
    expect(debt.titleDebt.parityFramed).toBe(1)

    const report = emitHumanDisplayCoverage({
      pin: {
        boardId: PIN.boardId,
        canonicalSnapshotId: PIN.canonicalSnapshotId,
        canonicalHash: PIN.canonicalHash,
        boardRev: PIN.boardRev,
        lifecycleRev: PIN.lifecycleRev,
      },
      rows,
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(report.byReviewStatus.MISSING_DISPLAY).toBe(1)
    expect(report.contentDebt.p0ActiveProduct.ratio).toBe('1/2')
    expect(report.generatedAt).toBe('2026-07-14T00:00:00.000Z')
  })
})

describe('HOLD / EXCLUDE / CONTROL_PLANE included (no silent omission)', () => {
  it('plans every disposition and control-plane entity', () => {
    const entities: Array<HumanDisplayBackfillEntity> = [
      entity({
        entityId: 'hold-1',
        disposition: 'HOLD',
        objective: 'Ditahan sampai keputusan pemilik.',
      }),
      entity({
        entityId: 'exclude-1',
        disposition: 'EXCLUDE',
        objective: 'Dikeluarkan dari portofolio aktif.',
      }),
      entity({
        entityId: 'cp-1',
        taskClass: 'CONTROL_PLANE',
        classificationProofValid: true,
        objective: 'Operasi control plane terpantau.',
      }),
      {
        entityKind: 'feature',
        entityId: 'feat-1',
        objective: 'Fitur checkout premium siap digunakan.',
        parentFeatureTitle: 'Checkout premium',
        businessArea: 'Panel Sales',
      },
    ]
    const plan = planHumanDisplayBackfill({
      pin: PIN,
      entities,
      dryRun: true,
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(plan.totals.entities).toBe(4)
    expect(plan.items.map((i) => i.entityId).sort()).toEqual([
      'cp-1',
      'exclude-1',
      'feat-1',
      'hold-1',
    ])
    // All have a planned display (no disappearance)
    expect(plan.items.every((i) => i.display != null)).toBe(true)
  })
})
