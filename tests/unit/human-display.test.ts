import { describe, expect, it } from 'vitest'

import {
  HUMAN_DISPLAY_REQUIRED_ART_BINDINGS,
  HUMAN_DISPLAY_REQUIRED_COPY_FIELDS,
  HUMAN_DISPLAY_SCHEMA_VERSION,
  HUMAN_DISPLAY_TITLE_FIXTURES,
  HUMAN_STATUS_BUCKETS,
  buildAllReadinessRails,
  buildContentReviewRequiredShell,
  buildHumanDisplay,
  buildMappingReadinessSentence,
  buildProductReadinessSentence,
  buildProgramReadinessSentence,
  buildStatusSentence,
  computeHumanDisplaySourceHash,
  evaluateHumanDisplay,
  fixtureHumanDisplayForTask,
  isExplicitProduct,
  lintHumanTitle,
  normalizeStatusBucket,
  normalizeTaskClass,
  resolveOwnerHumanDisplay,
  resolveTaxonomyLabel,
  type HumanDisplaySourceFacts,
  type HumanDisplayV1,
} from '#/server/human-display'

const BASE_FACTS: HumanDisplaySourceFacts = {
  entityKind: 'task',
  entityId: 'T-DEMO-1',
  technicalTitle: 'Parity something technical',
  objective: 'User can complete checkout',
  projectId: 'sales-rebuild',
  featureId: 'checkout',
  lifecycleStage: 'MAPPED',
  disposition: 'ACTIVE',
  taskClass: 'PRODUCT',
  dependencies: ['T-DEP-B', 'T-DEP-A'],
  evidenceRefs: ['ev-2', 'ev-1'],
  decisionIds: [],
  acceptance: 'Staging proves checkout price matches all surfaces',
  canonicalSnapshotId: 'snap-1',
  canonicalHash: 'canon-aaa',
  boardRev: 3,
  lifecycleRev: 2,
}

function reviewedDisplay(
  facts: HumanDisplaySourceFacts = BASE_FACTS,
  over: Partial<HumanDisplayV1> = {},
): HumanDisplayV1 {
  const base = buildHumanDisplay({
    entityKind: facts.entityKind,
    entityId: facts.entityId,
    title: 'Menampilkan harga checkout dengan benar',
    outcome: 'Pelanggan melihat harga yang benar di checkout.',
    why: 'Kesalahan harga merugikan pendapatan dan kepercayaan.',
    current: 'Pemetaan selesai; implementasi berjalan.',
    remaining: 'Uji staging dan bukti independen.',
    next: 'Kirim bukti FUNCTIONAL ke peninjau independen.',
    doneWhen: 'Bukti staging mengonfirmasi harga cocok di semua permukaan.',
    blocker: 'Tidak ada',
    ownerAction: 'Tidak ada tindakan yang diperlukan',
    sourceFacts: facts,
    reviewStatus: 'REVIEWED',
    reviewedAt: '2026-07-13T12:00:00.000Z',
    contentVersion: 2,
    parentFeatureTitle: 'Alur checkout premium',
    businessArea: 'Panel Sales dan Website',
    actor: 'Implementer',
    citations: [
      { field: 'title', path: 'task/T-DEMO-1', note: 'entity' },
      { field: 'outcome', path: 'task/T-DEMO-1.objective' },
    ],
    acceptanceLinks: [
      {
        id: 'AC-CHECKOUT-PRICE',
        path: 'task/T-DEMO-1.acceptance',
        summary: 'Bukti staging harga cocok',
      },
    ],
    missionQuestionLinks: [
      { questionId: 'Q1', field: 'outcome' },
      { questionId: 'Q2', field: 'why' },
      { questionId: 'Q3', field: 'current' },
    ],
  })
  return { ...base, ...over, sourceHash: over.sourceHash ?? base.sourceHash }
}

describe('schema constants', () => {
  it('uses TM_HUMAN_DISPLAY_V1 and required copy + ART bindings from task contract', () => {
    expect(HUMAN_DISPLAY_SCHEMA_VERSION).toBe('TM_HUMAN_DISPLAY_V1')
    expect(HUMAN_DISPLAY_REQUIRED_COPY_FIELDS).toEqual([
      'title',
      'outcome',
      'why',
      'current',
      'remaining',
      'next',
      'doneWhen',
      'blocker',
      'ownerAction',
    ])
    expect(HUMAN_DISPLAY_REQUIRED_ART_BINDINGS).toEqual([
      'parentFeatureTitle',
      'businessArea',
      'actor',
    ])
  })
})

describe('never guess PRODUCT', () => {
  it('normalizeTaskClass fails closed to UNCLASSIFIED', () => {
    expect(normalizeTaskClass('PRODUCT')).toBe('PRODUCT')
    expect(normalizeTaskClass('CONTROL_PLANE')).toBe('CONTROL_PLANE')
    expect(normalizeTaskClass('UNCLASSIFIED')).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass(null)).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass(undefined)).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass('product')).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass('maybe product?')).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass('SALES_WEB_RELATED_BACKEND')).toBe('UNCLASSIFIED')
  })

  it('isExplicitProduct only true for exact PRODUCT', () => {
    expect(isExplicitProduct('PRODUCT')).toBe(true)
    expect(isExplicitProduct('CONTROL_PLANE')).toBe(false)
    expect(isExplicitProduct(null)).toBe(false)
    expect(isExplicitProduct('product')).toBe(false)
  })

  it('source hash stores UNCLASSIFIED when class missing — not PRODUCT', () => {
    const a = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 'T-1',
      taskClass: null,
    })
    const b = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 'T-1',
      taskClass: 'UNCLASSIFIED',
    })
    const product = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 'T-1',
      taskClass: 'PRODUCT',
    })
    expect(a).toBe(b)
    expect(a).not.toBe(product)
  })
})

describe('computeHumanDisplaySourceHash', () => {
  it('is deterministic and order-independent for arrays', () => {
    const h1 = computeHumanDisplaySourceHash(BASE_FACTS)
    const h2 = computeHumanDisplaySourceHash({
      ...BASE_FACTS,
      dependencies: ['T-DEP-A', 'T-DEP-B'],
      evidenceRefs: ['ev-1', 'ev-2'],
    })
    expect(h1).toBe(h2)
    expect(h1).toMatch(/^[a-f0-9]{64}$/)
  })

  it('changes when objective or stage changes', () => {
    const base = computeHumanDisplaySourceHash(BASE_FACTS)
    const changed = computeHumanDisplaySourceHash({
      ...BASE_FACTS,
      objective: 'Different objective',
    })
    const stage = computeHumanDisplaySourceHash({
      ...BASE_FACTS,
      lifecycleStage: 'BUILT',
    })
    expect(changed).not.toBe(base)
    expect(stage).not.toBe(base)
  })

  it('hashes project and feature entities separately', () => {
    const task = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 'same-id',
    })
    const project = computeHumanDisplaySourceHash({
      entityKind: 'project',
      entityId: 'same-id',
    })
    const feature = computeHumanDisplaySourceHash({
      entityKind: 'feature',
      entityId: 'same-id',
    })
    expect(new Set([task, project, feature]).size).toBe(3)
  })
})

describe('evaluateHumanDisplay fail-closed', () => {
  it('MISSING_DISPLAY → CONTENT_REVIEW_REQUIRED', () => {
    const liveHash = computeHumanDisplaySourceHash(BASE_FACTS)
    const ev = evaluateHumanDisplay(null, { liveSourceHash: liveHash })
    expect(ev.ok).toBe(false)
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(ev.releaseBlocker).toBe('CONTENT_REVIEW_REQUIRED')
    expect(ev.ownerPrimaryReady).toBe(false)
    expect(ev.reasons).toContain('MISSING_DISPLAY')
  })

  it('REVIEWED + matching sourceHash + ART bindings → ownerPrimaryReady', () => {
    const display = reviewedDisplay()
    const liveHash = computeHumanDisplaySourceHash(BASE_FACTS)
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: liveHash,
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canon-aaa',
      boardRev: 3,
      lifecycleRev: 2,
    })
    expect(ev.ok).toBe(true)
    expect(ev.effectiveReviewStatus).toBe('REVIEWED')
    expect(ev.releaseBlocker).toBeNull()
    expect(ev.ownerPrimaryReady).toBe(true)
    expect(ev.missingArtBindings).toEqual([])
    expect(ev.titleLintCodes).toEqual([])
  })

  it('missing ART bindings fail closed', () => {
    const display = reviewedDisplay(BASE_FACTS, {
      parentFeatureTitle: '',
      businessArea: '',
      actor: '',
    })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      canonicalSnapshotId: 'snap-1',
      boardRev: 3,
      lifecycleRev: 2,
    })
    expect(ev.ownerPrimaryReady).toBe(false)
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(ev.reasons).toEqual(
      expect.arrayContaining(['EMPTY_ART_BINDING']),
    )
    expect(ev.missingArtBindings).toEqual(
      expect.arrayContaining([
        'parentFeatureTitle',
        'businessArea',
        'actor',
      ]),
    )
  })

  it('missing citations/acceptance/mission links fail closed', () => {
    const display = reviewedDisplay(BASE_FACTS, {
      citations: [],
      acceptanceLinks: [],
      missionQuestionLinks: [],
    })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      boardRev: 3,
      lifecycleRev: 2,
      canonicalSnapshotId: 'snap-1',
    })
    expect(ev.reasons).toEqual(
      expect.arrayContaining([
        'MISSING_CITATIONS',
        'MISSING_ACCEPTANCE_LINKS',
        'MISSING_MISSION_QUESTION_LINKS',
      ]),
    )
    expect(ev.ownerPrimaryReady).toBe(false)
  })

  it('missing pin bindings (snapshot/boardRev/lifecycleRev) fail closed', () => {
    const display = reviewedDisplay(BASE_FACTS, {
      snapshotId: null,
      boardRev: null,
      lifecycleRev: null,
    })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
    })
    expect(ev.reasons).toEqual(
      expect.arrayContaining([
        'MISSING_SNAPSHOT_BINDING',
        'MISSING_BOARD_REV_BINDING',
        'MISSING_LIFECYCLE_REV_BINDING',
      ]),
    )
    expect(ev.ownerPrimaryReady).toBe(false)
  })

  it('title lint failure demotes REVIEWED', () => {
    const display = reviewedDisplay(BASE_FACTS, {
      title: 'T-BE-TECHNICAL-ONLY',
    })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      canonicalSnapshotId: 'snap-1',
      boardRev: 3,
      lifecycleRev: 2,
    })
    expect(ev.reasons).toContain('TITLE_LINT_FAILED')
    expect(ev.titleLintCodes.length).toBeGreaterThan(0)
    expect(ev.ownerPrimaryReady).toBe(false)
  })

  it('live canonicalHash without display binding fails closed', () => {
    const display = reviewedDisplay(BASE_FACTS, { canonicalHash: null })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canon-aaa',
      boardRev: 3,
      lifecycleRev: 2,
    })
    expect(ev.reasons).toContain('MISSING_CANONICAL_HASH_BINDING')
    expect(ev.ownerPrimaryReady).toBe(false)
  })

  it('stale sourceHash demotes REVIEWED → CONTENT_REVIEW_REQUIRED', () => {
    const display = reviewedDisplay()
    const liveHash = computeHumanDisplaySourceHash({
      ...BASE_FACTS,
      objective: 'changed after review',
    })
    const ev = evaluateHumanDisplay(display, { liveSourceHash: liveHash })
    expect(ev.ownerPrimaryReady).toBe(false)
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(ev.reasons).toContain('STALE_SOURCE_HASH')
    expect(ev.releaseBlocker).toBe('CONTENT_REVIEW_REQUIRED')
  })

  it('empty required fields fail closed', () => {
    const display = reviewedDisplay(BASE_FACTS, { title: '   ', why: '' })
    const liveHash = computeHumanDisplaySourceHash(BASE_FACTS)
    const ev = evaluateHumanDisplay(display, { liveSourceHash: liveHash })
    expect(ev.ok).toBe(false)
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(ev.missingFields).toEqual(expect.arrayContaining(['title', 'why']))
  })

  it('GENERATED_NEEDS_REVIEW never ownerPrimaryReady', () => {
    const display = buildHumanDisplay({
      entityKind: 'task',
      entityId: 'T-DEMO-1',
      title: 'Judul manusia',
      outcome: 'Hasil',
      why: 'Alasan',
      current: 'Sekarang',
      remaining: 'Sisa',
      next: 'Berikut',
      doneWhen: 'Selesai bila',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: BASE_FACTS,
      reviewStatus: 'GENERATED_NEEDS_REVIEW',
      parentFeatureTitle: 'Fitur demo',
      businessArea: 'Sales',
      actor: 'Implementer',
    })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      canonicalSnapshotId: 'snap-1',
      boardRev: 3,
      lifecycleRev: 2,
    })
    // Empty ART was filled; still GENERATED (not REVIEWED) → not owner primary.
    // If pin/ART incomplete, demotes to CONTENT_REVIEW_REQUIRED which is also fine
    // for "never ownerPrimaryReady".
    expect(ev.ownerPrimaryReady).toBe(false)
    expect(ev.releaseBlocker).toBe('CONTENT_REVIEW_REQUIRED')
    expect(
      ev.effectiveReviewStatus === 'GENERATED_NEEDS_REVIEW' ||
        ev.effectiveReviewStatus === 'CONTENT_REVIEW_REQUIRED',
    ).toBe(true)
  })

  it('REVIEWED without reviewedAt fails closed', () => {
    const display = reviewedDisplay(BASE_FACTS, { reviewedAt: null })
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
    })
    expect(ev.reasons).toContain('REVIEWED_WITHOUT_REVIEWED_AT')
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
  })

  it('preserves CONFLICT and BLOCKED_MISSING_SOURCE', () => {
    const conflict = reviewedDisplay(BASE_FACTS, {
      reviewStatus: 'CONFLICT',
      reviewedAt: null,
    })
    const blocked = reviewedDisplay(BASE_FACTS, {
      reviewStatus: 'BLOCKED_MISSING_SOURCE',
      reviewedAt: null,
    })
    expect(
      evaluateHumanDisplay(conflict, { liveSourceHash: conflict.sourceHash })
        .effectiveReviewStatus,
    ).toBe('CONFLICT')
    expect(
      evaluateHumanDisplay(blocked, { liveSourceHash: blocked.sourceHash })
        .effectiveReviewStatus,
    ).toBe('BLOCKED_MISSING_SOURCE')
  })

  it('stale boardRev demotes REVIEWED', () => {
    const display = reviewedDisplay()
    const ev = evaluateHumanDisplay(display, {
      liveSourceHash: display.sourceHash,
      boardRev: 99,
    })
    expect(ev.reasons).toContain('STALE_BOARD_REV')
    expect(ev.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
  })
})

describe('resolveOwnerHumanDisplay', () => {
  it('returns primary only when REVIEWED+fresh; always provides blockedShell', () => {
    const display = reviewedDisplay()
    const ok = resolveOwnerHumanDisplay(
      display,
      {
        liveSourceHash: display.sourceHash,
        canonicalSnapshotId: 'snap-1',
        boardRev: 3,
        lifecycleRev: 2,
      },
      { entityKind: 'task', entityId: 'T-DEMO-1' },
    )
    expect(ok.primary?.title).toBe(display.title)
    expect(ok.primary?.reviewStatus).toBe('REVIEWED')
    expect(ok.blockedShell.reviewStatus).toBe('CONTENT_REVIEW_REQUIRED')

    const stale = resolveOwnerHumanDisplay(
      display,
      { liveSourceHash: 'deadbeef'.repeat(8) },
      { entityKind: 'task', entityId: 'T-DEMO-1' },
    )
    expect(stale.primary).toBeNull()
    expect(stale.blockedShell.title).toContain('peninjauan')
    expect(stale.evaluation.releaseBlocker).toBe('CONTENT_REVIEW_REQUIRED')
  })

  it('never uses technical title as primary shell', () => {
    const shell = buildContentReviewRequiredShell({
      entityKind: 'task',
      entityId: 'T-NODE-FC-WEB',
      liveSourceHash: 'abc',
    })
    expect(shell.title.toLowerCase()).not.toContain('fc-')
    expect(shell.title).not.toBe('T-NODE-FC-WEB')
    expect(shell.locale).toBe('id-ID')
  })
})

describe('buildStatusSentence (all buckets)', () => {
  it('covers DONE/ONGOING/NEXT/QUEUED/BLOCKED/RECONCILIATION_PENDING/HOLD/EXCLUDE', () => {
    for (const bucket of HUMAN_STATUS_BUCKETS) {
      const r = buildStatusSentence({
        bucket,
        gate: 'FUNCTIONAL',
        outcome: 'checkout aman',
        time: '2026-07-13 10:00',
        independentRole: 'verifier',
        role: 'implementer',
        relativeTime: '5 menit lalu',
        nextAction: 'kirim bukti',
        condition: 'dependensi selesai',
        priorityReason: 'P0 sales',
        dispatchReason: 'P0 sales',
        dispatchRank: 1,
        dispatchBoardRev: 3,
        dispatchLifecycleRev: 2,
        queueReason: 'kapasitas penuh',
        cause: 'keputusan terbuka',
        unblockRole: 'owner',
        unblockAction: 'menjawab keputusan',
        impact: 'panel sales tertunda',
        excludeReason: 'di luar cakupan gelombang',
        claimValid: true,
        leaseValid: true,
        heartbeatFresh: true,
      })
      expect(r.bucket).toBe(bucket)
      expect(r.contentReviewRequired).toBe(false)
      expect(r.sentence.length).toBeGreaterThan(20)
      // Never naked enum alone
      expect(r.sentence).not.toBe(bucket)
    }
  })

  it('DONE sentence is id-ID and includes gate/outcome', () => {
    const r = buildStatusSentence({
      bucket: 'DONE',
      gate: 'MAP_VERIFIED',
      outcome: 'peta checkout',
      time: '13 Jul 2026',
      independentRole: 'peninjau independen',
      laterReadinessNote: 'Kesiapan produk staging masih diperlukan.',
    })
    expect(r.sentence).toContain('Selesai untuk MAP_VERIFIED')
    expect(r.sentence).toContain('peta checkout')
    expect(r.sentence).toContain('Kesiapan produk staging masih diperlukan')
    expect(r.contentReviewRequired).toBe(false)
  })

  it('stale claim never ONGOING — demotes to RECONCILIATION_PENDING', () => {
    const r = buildStatusSentence({
      bucket: 'ONGOING',
      role: 'agent-x',
      time: 'kemarin',
      claimOrLeaseInvalid: true,
    })
    expect(r.bucket).toBe('RECONCILIATION_PENDING')
    expect(r.demotedFromOngoing).toBe(true)
    expect(r.sentence).toContain('Sedang dicocokkan')
    expect(r.contentReviewRequired).toBe(false)
  })

  it('ONGOING without valid claim+lease+heartbeat → CONTENT_REVIEW_REQUIRED', () => {
    const r = buildStatusSentence({
      bucket: 'ONGOING',
      role: 'agent-x',
      time: 'kemarin',
      relativeTime: '5 m',
      nextAction: 'lanjut',
      // claimValid/leaseValid/heartbeatFresh omitted
    })
    expect(r.bucket).toBe('CONTENT_REVIEW_REQUIRED')
    expect(r.contentReviewRequired).toBe(true)
    expect(r.missingTruth).toEqual(
      expect.arrayContaining(['claimValid', 'leaseValid', 'heartbeatFresh']),
    )
    expect(r.sentence).toContain('memerlukan peninjauan konten')
    // Never fabricates "Sedang dikerjakan oleh pelaksana"
    expect(r.sentence).not.toContain('pelaksana')
  })

  it('NEXT without dispatch reason/rank/revisions → CONTENT_REVIEW_REQUIRED', () => {
    const r = buildStatusSentence({
      bucket: 'NEXT',
      condition: 'dependensi selesai',
      // no priorityReason / rank / revs
    })
    expect(r.bucket).toBe('CONTENT_REVIEW_REQUIRED')
    expect(r.contentReviewRequired).toBe(true)
    expect(r.missingTruth).toEqual(
      expect.arrayContaining([
        'dispatchReason',
        'dispatchRank',
        'dispatchBoardRev',
        'dispatchLifecycleRev',
      ]),
    )
    expect(r.sentence).not.toContain('urutan prioritas program')
  })

  it('QUEUED without capacity reason → CONTENT_REVIEW_REQUIRED', () => {
    const r = buildStatusSentence({ bucket: 'QUEUED' })
    expect(r.bucket).toBe('CONTENT_REVIEW_REQUIRED')
    expect(r.missingTruth).toContain('queueReason')
    expect(r.sentence).not.toContain('kapasitas atau urutan antrean')
  })

  it('BLOCKED without blocker+unblocker → CONTENT_REVIEW_REQUIRED', () => {
    const r = buildStatusSentence({ bucket: 'BLOCKED' })
    expect(r.bucket).toBe('CONTENT_REVIEW_REQUIRED')
    expect(r.missingTruth).toEqual(
      expect.arrayContaining(['cause', 'unblockRole', 'unblockAction', 'impact']),
    )
    expect(r.sentence).not.toContain('pihak yang bertanggung jawab')
  })

  it('normalizes RECONCILIATION alias to RECONCILIATION_PENDING', () => {
    expect(normalizeStatusBucket('RECONCILIATION')).toBe('RECONCILIATION_PENDING')
    expect(normalizeStatusBucket('reconciliation_pending')).toBe(
      'RECONCILIATION_PENDING',
    )
    const r = buildStatusSentence({ bucket: 'RECONCILIATION' })
    expect(r.bucket).toBe('RECONCILIATION_PENDING')
  })

  it('unknown bucket returns UNKNOWN sentence, not invented DONE', () => {
    const r = buildStatusSentence({ bucket: 'MAGIC' })
    expect(r.bucket).toBe('UNKNOWN')
    expect(r.contentReviewRequired).toBe(true)
    expect(r.sentence).toContain('belum dapat dijelaskan')
  })
})

describe('readiness rails are separate from workBucket', () => {
  it('mapping / product / program produce distinct rails', () => {
    const rails = buildAllReadinessRails({
      mapping: { lifecycleStage: 'MAP_VERIFIED' },
      product: { lifecycleStage: 'BUILT', taskWeight: 45, evidenceComplete: false },
      program: {
        g5Pass: false,
        boardReadinessPercent: 42.5,
        productDenominator: 10,
        cappedBy: 'G5',
      },
    })
    expect(rails.mapping.rail).toBe('mapping')
    expect(rails.product.rail).toBe('product')
    expect(rails.program.rail).toBe('program')
    expect(rails.mapping.code).toBe('MAP_VERIFIED')
    expect(rails.product.sentence).toContain('BUILT')
    expect(rails.product.sentence).toContain('Bucket kerja bukan persen')
    expect(rails.program.sentence).toContain('42.5%')
    expect(rails.program.sentence).toContain('tidak berarti program global 100%')
  })

  it('QUEUED task can still be MAP_VERIFIED on mapping rail', () => {
    const mapping = buildMappingReadinessSentence({ lifecycleStage: 'MAP_VERIFIED' })
    const status = buildStatusSentence({
      bucket: 'QUEUED',
      queueReason: 'menunggu kapasitas',
    })
    expect(mapping.code).toBe('MAP_VERIFIED')
    expect(status.bucket).toBe('QUEUED')
    expect(status.contentReviewRequired).toBe(false)
    expect(status.sentence).not.toContain('MAP_VERIFIED')
  })

  it('empty product denominator never implies program 100%', () => {
    const p = buildProgramReadinessSentence({
      productDenominator: 0,
      boardReadinessPercent: 100,
      g5Pass: true,
    })
    expect(p.code).toBe('EMPTY_PRODUCT_SCOPE')
    expect(p.sentence).not.toMatch(/\b100%\b/)
  })

  it('product rail does not invent PROD_READY from missing stage', () => {
    const p = buildProductReadinessSentence({ taskWeight: 10 })
    expect(p.code).toBe('WEIGHT_ONLY')
    expect(p.sentence).toContain('tidak mengarang PROD_READY')
  })
})

describe('taxonomy labels', () => {
  it('resolves ART domain and project labels', () => {
    expect(resolveTaxonomyLabel('domain', 'SALES_WEB_RELATED_BACKEND')).toEqual({
      label: 'Prioritas Utama — Panel Sales, Website, dan Backend Terkait',
      known: true,
    })
    expect(resolveTaxonomyLabel('project', 'sales-rebuild')).toEqual({
      label: 'Panel Sales',
      known: true,
    })
    expect(resolveTaxonomyLabel('project', 'affiliate-rebuild').label).toBe(
      'Portal Affiliate',
    )
  })

  it('does not invent labels for unknown ids or features without title', () => {
    expect(resolveTaxonomyLabel('project', 'unknown-proj')).toEqual({
      label: null,
      known: false,
    })
    expect(resolveTaxonomyLabel('feature', 'FC-WEB-X')).toEqual({
      label: null,
      known: false,
    })
    expect(
      resolveTaxonomyLabel('feature', 'FC-WEB-X', {
        featureTitle: 'Checkout premium',
      }),
    ).toEqual({ label: 'Checkout premium', known: true })
  })
})

describe('lintHumanTitle quality floor', () => {
  it('rejects technical debt prefixes', () => {
    expect(lintHumanTitle('T-BE-ID-REFRESH-REVOKE').ok).toBe(false)
    expect(lintHumanTitle('[FC-WEB] Checkout').codes).toContain('STARTS_WITH_FC')
    expect(lintHumanTitle('Parity refresh_token').codes).toContain(
      'STARTS_WITH_PARITY',
    )
    expect(lintHumanTitle('Integration closure FC-X').codes).toContain(
      'STARTS_WITH_INTEGRATION_CLOSURE',
    )
  })

  it('accepts ART quality-floor human titles; known debt technical titles fail', () => {
    for (const fx of HUMAN_DISPLAY_TITLE_FIXTURES) {
      expect(lintHumanTitle(fx.title).ok).toBe(true)
    }
    // Technical titles with debt prefixes fail lint (quality floor).
    expect(
      lintHumanTitle(
        '[FC-WEB-PREMIUM-E2E] Checkout quote / create pending invoice',
      ).ok,
    ).toBe(false)
    expect(lintHumanTitle('Integration/closure: landing price variants').ok).toBe(
      false,
    )
    expect(lintHumanTitle('Parity refresh_token + revoke').ok).toBe(false)
    // Free-form technical titles without debt prefixes are not auto-approved as
    // human primary — lint only enforces the documented start-token ban list.
    expect(lintHumanTitle('Money tail expired/unpaid').ok).toBe(true)
  })
})

describe('fixtures for task/project/feature', () => {
  it('builds fixture task displays with bound sourceHash', () => {
    const hd = fixtureHumanDisplayForTask(
      'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
      {
        reviewStatus: 'REVIEWED',
        reviewedAt: '2026-07-13T15:00:00.000Z',
        sourceFacts: {
          entityKind: 'task',
          entityId: 'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
          taskClass: 'PRODUCT',
        },
      },
    )
    expect(hd.schemaVersion).toBe('TM_HUMAN_DISPLAY_V1')
    expect(hd.locale).toBe('id-ID')
    expect(hd.entityKind).toBe('task')
    expect(hd.title).toContain('checkout')
    expect(hd.sourceHash).toMatch(/^[a-f0-9]{64}$/)
    expect(lintHumanTitle(hd.title).ok).toBe(true)

    const rebuilt = fixtureHumanDisplayForTask(
      'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
      {
        sourceFacts: {
          entityKind: 'task',
          entityId: 'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
          taskClass: 'PRODUCT',
        },
      },
    )
    expect(
      evaluateHumanDisplay(
        {
          ...rebuilt,
          reviewStatus: 'REVIEWED',
          reviewedAt: '2026-07-13T15:00:00.000Z',
        },
        { liveSourceHash: rebuilt.sourceHash },
      ).ownerPrimaryReady,
    ).toBe(true)
    expect(hd.sourceHash).toBe(rebuilt.sourceHash)
  })

  it('builds project and feature humanDisplay without inventing PRODUCT', () => {
    const project = buildHumanDisplay({
      entityKind: 'project',
      entityId: 'sales-rebuild',
      title: 'Panel Sales',
      outcome: 'Operator Sales mengelola paket, promo, dan transaksi dengan benar.',
      why: 'Panel Sales adalah permukaan utama pendapatan harian.',
      current: 'Proyek aktif di portofolio prioritas.',
      remaining: 'Menyelesaikan fitur yang masih terbuka.',
      next: 'Prioritaskan fitur checkout dan harga.',
      doneWhen: 'Semua fitur prioritas proyek lolos bukti staging.',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: {
        entityKind: 'project',
        entityId: 'sales-rebuild',
        // deliberately omit taskClass — projects are not PRODUCT tasks
      },
      reviewStatus: 'GENERATED_NEEDS_REVIEW',
      parentFeatureTitle: 'N/A project root',
      businessArea: 'Panel Sales',
      actor: 'Owner program',
    })
    expect(project.entityKind).toBe('project')
    expect(normalizeTaskClass(undefined)).toBe('UNCLASSIFIED')
    expect(project.citations.length).toBeGreaterThan(0)
    expect(project.acceptanceLinks.length).toBeGreaterThan(0)
    expect(project.missionQuestionLinks.length).toBeGreaterThan(0)

    const feature = buildHumanDisplay({
      entityKind: 'feature',
      entityId: 'FC-WEB-PREMIUM-E2E',
      title: 'Alur premium hingga checkout',
      outcome: 'Pengguna premium menyelesaikan pembelian tanpa error harga.',
      why: 'Langganan premium adalah sumber pendapatan berulang.',
      current: 'Beberapa node masih MAPPED.',
      remaining: 'Selesaikan node API quote dan invoice.',
      next: 'Kerjakan node checkout quote.',
      doneWhen: 'Semua node fitur LIVE_VERIFIED dengan bukti.',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: {
        entityKind: 'feature',
        entityId: 'FC-WEB-PREMIUM-E2E',
        featureContractId: 'FC-WEB-PREMIUM-E2E',
      },
      parentFeatureTitle: 'Alur premium hingga checkout',
      businessArea: 'Website publik',
      actor: 'Feature owner',
    })
    expect(feature.entityKind).toBe('feature')
    expect(feature.sourceHash).not.toBe(project.sourceHash)
  })
})

describe('hostile missing-truth / pin integrity', () => {
  it('empty display shell never exposes technical id as primary title', () => {
    const shell = buildContentReviewRequiredShell({
      entityKind: 'task',
      entityId: 'T-TECH-123',
      liveSourceHash: 'dead',
      reasons: ['MISSING_DISPLAY'],
    })
    expect(shell.parentFeatureTitle).toBeTruthy()
    expect(shell.citations.length).toBeGreaterThan(0)
    expect(shell.acceptanceLinks.length).toBeGreaterThan(0)
    expect(shell.missionQuestionLinks.length).toBeGreaterThan(0)
    expect(shell.title).not.toContain('T-TECH-123')
  })

  it('resolveOwner with incomplete ART never returns primary', () => {
    const incomplete = reviewedDisplay(BASE_FACTS, {
      parentFeatureTitle: '',
      citations: [],
    })
    const r = resolveOwnerHumanDisplay(
      incomplete,
      {
        liveSourceHash: incomplete.sourceHash,
        canonicalSnapshotId: 'snap-1',
        boardRev: 3,
        lifecycleRev: 2,
      },
      { entityKind: 'task', entityId: 'T-DEMO-1' },
    )
    expect(r.primary).toBeNull()
    expect(r.evaluation.releaseBlocker).toBe('CONTENT_REVIEW_REQUIRED')
  })
})
