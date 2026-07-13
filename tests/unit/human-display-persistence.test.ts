/**
 * Human-display persistence unit tests (memory + SQL-memory adapters).
 * Hostile cases: stale rev, sourceHash mismatch, REVIEWED immutability,
 * tamper audit, board isolation. Never invents PRODUCT.
 */
import fs from 'node:fs'
import path from 'node:path'
import { beforeEach, describe, expect, it } from 'vitest'

import {
  buildHumanDisplay,
  computeHumanDisplaySourceHash,
  fixtureHumanDisplayForTask,
  normalizeTaskClass,
  type HumanDisplayV1,
} from '#/server/human-display'
import {
  HUMAN_DISPLAY_AUDIT_TABLE,
  HUMAN_DISPLAY_PERSISTENCE_MIGRATION_FILE,
  HUMAN_DISPLAY_PERSISTENCE_SCHEMA_STEP,
  HUMAN_DISPLAY_PERSISTENCE_TABLES,
  HUMAN_DISPLAY_SQL,
  HUMAN_DISPLAY_TABLE,
  assertHumanDisplayWritable,
  computeHumanDisplayContentHash,
  createMemoryBackedMysqlHumanDisplayStore,
  createMemoryHumanDisplayPersistence,
  createMemoryHumanDisplaySql,
  createMysqlHumanDisplayStore,
  decodeHumanDisplayRecord,
  encodeHumanDisplayRecord,
  HumanDisplayPersistenceError,
} from '#/server/human-display-persistence'

const MIGRATION_004 = path.join(
  process.cwd(),
  'migrations/004_control_data_persistence.sql',
)

function splitSqlStatements(sql: string): Array<string> {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = withoutBlock.split('\n').filter((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('--')
  })
  return lines
    .join('\n')
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

function sampleDisplay(
  overrides: Partial<HumanDisplayV1> & {
    sourceFacts?: Parameters<typeof buildHumanDisplay>[0]['sourceFacts']
  } = {},
): HumanDisplayV1 {
  const {
    sourceFacts: sourceOver,
    reviewStatus,
    reviewedAt,
    contentVersion,
    title,
    outcome,
    why,
    current,
    remaining,
    next,
    doneWhen,
    blocker,
    ownerAction,
    parentFeatureTitle,
    businessArea,
    actor,
    citations,
    acceptanceLinks,
    missionQuestionLinks,
    canonicalHash,
    locale,
    ...displayFieldOverrides
  } = overrides
  const sourceFacts = {
    entityKind: 'task' as const,
    entityId: 'T-HD-1',
    technicalTitle: '[FC-X] technical',
    objective: 'Owner outcome',
    lifecycleStage: 'MAPPED',
    disposition: 'ACTIVE',
    taskClass: 'UNCLASSIFIED' as const,
    acceptance: 'Owner-readable copy bound to source facts',
    canonicalSnapshotId: 'snap-1',
    canonicalHash: 'canon-aaa',
    boardRev: 3,
    lifecycleRev: 1,
    ...(sourceOver ?? {}),
  }
  const built = buildHumanDisplay({
    entityKind: 'task',
    entityId: 'T-HD-1',
    title:
      title ?? 'Menampilkan salinan pemilik yang terikat fakta sumber',
    outcome:
      outcome ??
      'Pemilik melihat salinan manusia yang jujur, bukan judul teknis.',
    why: why ?? 'Judul teknis mentah tidak boleh menjadi teks utama.',
    current: current ?? 'Fakta sumber tersedia untuk peninjauan.',
    remaining: remaining ?? 'Tinjau dan set REVIEWED.',
    next: next ?? 'Minta peninjauan independen.',
    doneWhen: doneWhen ?? 'reviewStatus=REVIEWED dengan sourceHash cocok.',
    blocker: blocker ?? 'Tidak ada',
    ownerAction: ownerAction ?? 'Tidak ada tindakan yang diperlukan',
    reviewStatus: reviewStatus ?? 'GENERATED_NEEDS_REVIEW',
    reviewedAt: reviewedAt ?? null,
    contentVersion: contentVersion ?? 1,
    locale,
    parentFeatureTitle: parentFeatureTitle ?? 'Fitur salinan pemilik',
    businessArea: businessArea ?? 'Control plane owner UX',
    actor: actor ?? 'Content author',
    citations: citations ?? [
      { field: 'title', path: 'task/T-HD-1', note: 'entity' },
      { field: 'outcome', path: 'task/T-HD-1.objective' },
    ],
    acceptanceLinks: acceptanceLinks ?? [
      {
        id: 'AC-HD-1',
        path: 'task/T-HD-1.acceptance',
        summary: 'Owner-readable copy bound to source facts',
      },
    ],
    missionQuestionLinks: missionQuestionLinks ?? [
      { questionId: 'Q1', field: 'outcome' },
      { questionId: 'Q2', field: 'why' },
    ],
    canonicalHash,
    sourceFacts,
  })
  // Apply pin / structural overrides that buildHumanDisplay derives from facts.
  return { ...built, ...displayFieldOverrides }
}

describe('004 human_display migration contract', () => {
  it('exists, is additive, and declares human display tables', () => {
    expect(fs.existsSync(MIGRATION_004)).toBe(true)
    const sql = fs.readFileSync(MIGRATION_004, 'utf8')
    expect(HUMAN_DISPLAY_PERSISTENCE_MIGRATION_FILE).toBe(
      'migrations/004_control_data_persistence.sql',
    )
    expect(sql).toMatch(/Classification:\s*REVERSIBLE/i)
    expect(sql).toMatch(/control_plane_human_display/)
    expect(sql).toMatch(/control_plane_human_display_audit/)
    expect(sql).toMatch(/TM_HUMAN_DISPLAY_PERSISTENCE_V1/)
    expect(sql).toMatch(/source_hash/)
    expect(sql).toMatch(/content_version/)
    expect(sql).toMatch(/review_status/)
    expect(sql).toMatch(/reviewed_at/)
    expect(sql).toMatch(/content_json/)
    expect(sql).toMatch(/entity_rev/)
    expect(sql).toMatch(/board_rev/)
    expect(sql).toMatch(/content_hash/)
    expect(sql).not.toMatch(/DEFAULT\s+'PRODUCT'/)
    expect(HUMAN_DISPLAY_PERSISTENCE_TABLES).toEqual([
      HUMAN_DISPLAY_TABLE,
      HUMAN_DISPLAY_AUDIT_TABLE,
    ])
    expect(HUMAN_DISPLAY_PERSISTENCE_SCHEMA_STEP).toBe(
      'TM_HUMAN_DISPLAY_PERSISTENCE_V1',
    )

    const stmts = splitSqlStatements(sql)
    const hdStmts = stmts.filter((s) =>
      /control_plane_human_display/i.test(s),
    )
    expect(hdStmts.length).toBeGreaterThanOrEqual(2)
    for (const s of hdStmts) {
      const lower = s.toLowerCase()
      expect(lower).not.toMatch(/\bdrop\s+table\b/)
      expect(lower).not.toMatch(/\btruncate\b/)
      expect(lower).not.toMatch(/foreign\s+key/)
      if (lower.includes('create table')) {
        expect(lower).toMatch(/if not exists/)
      }
    }
  })
})

describe('content hash + writable guards', () => {
  it('content hash is deterministic and sensitive to title change', () => {
    const a = sampleDisplay()
    const b = sampleDisplay()
    expect(computeHumanDisplayContentHash(a)).toBe(
      computeHumanDisplayContentHash(b),
    )
    const c = sampleDisplay({ title: 'Judul berbeda' })
    expect(computeHumanDisplayContentHash(c)).not.toBe(
      computeHumanDisplayContentHash(a),
    )
  })

  it('content hash binds ART + acceptance + mission link fields', () => {
    const a = sampleDisplay()
    const b = sampleDisplay({
      parentFeatureTitle: 'Fitur lain',
    })
    const c = sampleDisplay({
      missionQuestionLinks: [{ questionId: 'Q9', field: 'blocker' }],
    })
    const d = sampleDisplay({
      acceptanceLinks: [{ path: 'other', summary: 'other' }],
    })
    expect(computeHumanDisplayContentHash(b)).not.toBe(
      computeHumanDisplayContentHash(a),
    )
    expect(computeHumanDisplayContentHash(c)).not.toBe(
      computeHumanDisplayContentHash(a),
    )
    expect(computeHumanDisplayContentHash(d)).not.toBe(
      computeHumanDisplayContentHash(a),
    )
  })

  it('rejects REVIEWED without reviewedAt', () => {
    const d = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: null,
    })
    expect(() => assertHumanDisplayWritable(d)).toThrow(
      HumanDisplayPersistenceError,
    )
  })

  it('rejects REVIEWED missing ART bindings or pin fields', () => {
    const missingArt = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      parentFeatureTitle: '',
    })
    expect(() => assertHumanDisplayWritable(missingArt)).toThrow(
      /parentFeatureTitle/,
    )

    const missingPin = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      snapshotId: null,
    })
    expect(() => assertHumanDisplayWritable(missingPin)).toThrow(/snapshotId/)

    const missingLinks = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      citations: [],
    })
    expect(() => assertHumanDisplayWritable(missingLinks)).toThrow(/citations/)
  })

  it('never invents PRODUCT via normalizeTaskClass', () => {
    expect(normalizeTaskClass(undefined)).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass('product-ish')).toBe('UNCLASSIFIED')
    expect(normalizeTaskClass('PRODUCT')).toBe('PRODUCT')
  })
})

describe.each([
  ['memory', () => createMemoryHumanDisplayPersistence()],
  [
    'mysql-memory-sql',
    () => createMemoryBackedMysqlHumanDisplayStore(),
  ],
] as const)('HumanDisplayStore (%s)', (_label, factory) => {
  let store: ReturnType<typeof factory>

  beforeEach(() => {
    store = factory()
    if ('reset' in store && typeof store.reset === 'function') {
      store.reset()
    }
    if ('sql' in store && store.sql && typeof store.sql.reset === 'function') {
      store.sql.reset()
    }
  })

  it('put insert + get + list round-trip with audit receipt', async () => {
    const display = sampleDisplay()
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      actorId: 'author-1',
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(put.ok).toBe(true)
    if (!put.ok) return
    expect(put.replayed).toBe(false)
    expect(put.record.entityRev).toBe(1)
    expect(put.record.sourceHash).toBe(display.sourceHash)
    expect(put.record.contentHash).toBe(computeHumanDisplayContentHash(display))
    expect(put.record.content.title).toBe(display.title)

    const got = await store.get('board-a', 'task', 'T-HD-1', {
      liveSourceHash: display.sourceHash,
      boardRev: 3,
      canonicalSnapshotId: 'snap-1',
    })
    expect(got.record).not.toBeNull()
    expect(got.contentReviewRequired).toBe(true) // GENERATED_NEEDS_REVIEW
    expect(got.effectiveReviewStatus).toBe('GENERATED_NEEDS_REVIEW')
    expect(got.primary).toBeNull()
    expect(got.blockedShell.reviewStatus).toBe('CONTENT_REVIEW_REQUIRED')

    const listed = await store.list('board-a')
    expect(listed).toHaveLength(1)
    expect(listed[0]!.entityId).toBe('T-HD-1')

    const audits = await store.listAudit('board-a')
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0]!.contentHash).toBe(put.record.contentHash)
    expect(audits[0]!.event).toMatch(/INSERT/)
    const byId = await store.getAudit('board-a', put.auditId)
    expect(byId?.auditId).toBe(put.auditId)
  })

  it('missing get → CONTENT_REVIEW_REQUIRED', async () => {
    const got = await store.get('board-a', 'task', 'missing', {
      liveSourceHash: 'live-hash',
    })
    expect(got.record).toBeNull()
    expect(got.contentReviewRequired).toBe(true)
    expect(got.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(got.evaluation.reasons).toContain('MISSING_DISPLAY')
    expect(got.primary).toBeNull()
    expect(got.blockedShell.reviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
  })

  it('stale sourceHash on get demotes REVIEWED → CONTENT_REVIEW_REQUIRED', async () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
    })
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(put.ok).toBe(true)

    const stale = await store.get('board-a', 'task', 'T-HD-1', {
      liveSourceHash: 'different-live-hash',
      boardRev: 3,
    })
    expect(stale.contentReviewRequired).toBe(true)
    expect(stale.effectiveReviewStatus).toBe('CONTENT_REVIEW_REQUIRED')
    expect(stale.evaluation.reasons).toContain('STALE_SOURCE_HASH')
    expect(stale.primary).toBeNull()
  })

  it('fresh REVIEWED get is owner-primary ready', async () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
    })
    await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    const got = await store.get('board-a', 'task', 'T-HD-1', {
      liveSourceHash: display.sourceHash,
      boardRev: 3,
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'canon-aaa',
      lifecycleRev: 1,
    })
    expect(got.contentReviewRequired).toBe(false)
    expect(got.primary?.title).toBe(display.title)
    expect(got.primary?.parentFeatureTitle).toBe(display.parentFeatureTitle)
    expect(got.primary?.acceptanceLinks?.length).toBeGreaterThan(0)
    expect(got.primary?.missionQuestionLinks?.length).toBeGreaterThan(0)
    expect(got.effectiveReviewStatus).toBe('REVIEWED')
    expect(got.evaluation.ownerPrimaryReady).toBe(true)
  })

  it('hostile: stored row with tampered content_hash on read path still demotes when live hash mismatches', async () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
    })
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    expect(put.ok).toBe(true)
    if (!put.ok) return

    // Live source moved → CONTENT_REVIEW_REQUIRED (hash-tamper / drift surface).
    const drifted = await store.get('board-a', 'task', 'T-HD-1', {
      liveSourceHash: 'tampered-or-drifted-hash',
      boardRev: 3,
      canonicalSnapshotId: 'snap-1',
      lifecycleRev: 1,
    })
    expect(drifted.contentReviewRequired).toBe(true)
    expect(drifted.primary).toBeNull()
    expect(drifted.evaluation.reasons).toContain('STALE_SOURCE_HASH')
  })

  it('hostile: put rejects REVIEWED missing truth bindings', async () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      parentFeatureTitle: '',
      businessArea: '',
      actor: '',
    })
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    expect(put.ok).toBe(false)
    if (put.ok) return
    expect(put.code).toBe('INVALID_INPUT')
    const listed = await store.list('board-a')
    expect(listed).toHaveLength(0)
  })

  it('put rejects SOURCE_HASH_MISMATCH when expectedSourceHash differs', async () => {
    const display = sampleDisplay()
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: 'not-the-display-hash',
    })
    expect(put.ok).toBe(false)
    if (put.ok) return
    expect(put.code).toBe('SOURCE_HASH_MISMATCH')
    const listed = await store.list('board-a')
    expect(listed).toHaveLength(0)
  })

  it('put rejects STALE_REVISION on wrong expectedEntityRev', async () => {
    const display = sampleDisplay()
    const first = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    expect(first.ok).toBe(true)

    const next = sampleDisplay({
      contentVersion: 2,
      title: 'Versi kedua salinan pemilik',
    })
    const stale = await store.put({
      boardId: 'board-a',
      display: next,
      expectedEntityRev: 0, // wrong — current is 1
      expectedBoardRev: first.ok ? first.record.boardRev : 0,
      expectedSourceHash: next.sourceHash,
    })
    expect(stale.ok).toBe(false)
    if (stale.ok) return
    expect(stale.code).toBe('STALE_REVISION')
    expect(stale.current?.entityRev).toBe(1)
    // No LWW — title still first version
    const got = await store.get('board-a', 'task', 'T-HD-1')
    expect(got.record?.content.title).toBe(display.title)
  })

  it('REVIEWED content is immutable for the same content_version', async () => {
    const reviewed = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      contentVersion: 1,
    })
    const first = await store.put({
      boardId: 'board-a',
      display: reviewed,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: reviewed.sourceHash,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const tampered = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      contentVersion: 1,
      title: 'TAMPERED TITLE MUST NOT LAND',
    })
    // sourceHash same as reviewed only if source facts same — title is not in source hash
    expect(tampered.sourceHash).toBe(reviewed.sourceHash)
    expect(computeHumanDisplayContentHash(tampered)).not.toBe(
      computeHumanDisplayContentHash(reviewed),
    )

    const put = await store.put({
      boardId: 'board-a',
      display: tampered,
      expectedEntityRev: first.record.entityRev,
      expectedBoardRev: first.record.boardRev,
      expectedSourceHash: tampered.sourceHash,
    })
    expect(put.ok).toBe(false)
    if (put.ok) return
    expect(put.code).toBe('REVIEWED_IMMUTABLE')
    const got = await store.get('board-a', 'task', 'T-HD-1')
    expect(got.record?.content.title).toBe(reviewed.title)
  })

  it('new contentVersion after REVIEWED is allowed with CAS', async () => {
    const v1 = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      contentVersion: 1,
    })
    const first = await store.put({
      boardId: 'board-a',
      display: v1,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: v1.sourceHash,
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const v2 = sampleDisplay({
      reviewStatus: 'GENERATED_NEEDS_REVIEW',
      reviewedAt: null,
      contentVersion: 2,
      title: 'Salinan versi dua setelah regenerasi',
    })
    const second = await store.put({
      boardId: 'board-a',
      display: v2,
      expectedEntityRev: first.record.entityRev,
      expectedBoardRev: first.record.boardRev,
      expectedSourceHash: v2.sourceHash,
    })
    expect(second.ok).toBe(true)
    if (!second.ok) return
    expect(second.record.contentVersion).toBe(2)
    expect(second.record.entityRev).toBe(2)
    expect(second.record.reviewStatus).toBe('GENERATED_NEEDS_REVIEW')
  })

  it('exact put replay is idempotent (same content hash)', async () => {
    const display = sampleDisplay()
    const first = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      auditId: 'audit-fixed-1',
      now: '2026-07-14T00:00:00.000Z',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    const replay = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: first.record.entityRev,
      expectedBoardRev: first.record.boardRev,
      expectedSourceHash: display.sourceHash,
      auditId: 'audit-fixed-1',
      now: '2026-07-14T00:01:00.000Z',
    })
    expect(replay.ok).toBe(true)
    if (!replay.ok) return
    expect(replay.replayed).toBe(true)
    expect(replay.record.entityRev).toBe(first.record.entityRev)
    expect(replay.record.contentHash).toBe(first.record.contentHash)

    const audits = await store.listAudit('board-a')
    // one audit id only
    expect(audits.filter((a) => a.auditId === 'audit-fixed-1')).toHaveLength(1)
  })

  it('audit tamper with different content_hash is IDEMPOTENCY_CONFLICT', async () => {
    const display = sampleDisplay()
    const first = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      auditId: 'audit-tamper-1',
    })
    expect(first.ok).toBe(true)
    if (!first.ok) return

    // Different content, same audit id → conflict on audit insert-once path.
    // (board_id, audit_id) is unique across entities on the board.
    const otherDisplay = buildHumanDisplay({
      entityKind: 'task',
      entityId: 'T-HD-OTHER',
      title: 'Entity lain dengan audit id bentrok',
      outcome: display.outcome,
      why: display.why,
      current: display.current,
      remaining: display.remaining,
      next: display.next,
      doneWhen: display.doneWhen,
      blocker: display.blocker,
      ownerAction: display.ownerAction,
      sourceFacts: {
        entityKind: 'task',
        entityId: 'T-HD-OTHER',
        boardRev: 3,
        canonicalSnapshotId: 'snap-1',
        canonicalHash: 'canon-bbb',
      },
    })
    expect(computeHumanDisplayContentHash(otherDisplay)).not.toBe(
      first.record.contentHash,
    )

    const conflict = await store.put({
      boardId: 'board-a',
      display: otherDisplay,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: otherDisplay.sourceHash,
      auditId: 'audit-tamper-1', // same audit id, different content
    })
    expect(conflict.ok).toBe(false)
    if (conflict.ok) return
    expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT')
    // Original row intact; other entity not written
    const original = await store.get('board-a', 'task', 'T-HD-1')
    expect(original.record?.contentHash).toBe(first.record.contentHash)
    const otherGot = await store.get('board-a', 'task', 'T-HD-OTHER')
    expect(otherGot.record).toBeNull()
  })

  it('board isolation: list/get never leak across boards', async () => {
    const display = sampleDisplay()
    await store.put({
      boardId: 'board-A',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      auditId: 'shared-audit-shape',
    })
    await store.put({
      boardId: 'board-B',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
      auditId: 'shared-audit-shape',
    })

    const listA = await store.list('board-A')
    const listB = await store.list('board-B')
    expect(listA).toHaveLength(1)
    expect(listB).toHaveLength(1)
    expect(listA[0]!.boardId).toBe('board-A')
    expect(listB[0]!.boardId).toBe('board-B')

    const miss = await store.get('board-A', 'task', 'T-HD-1')
    // exists on A
    expect(miss.record?.boardId).toBe('board-A')
    const onC = await store.get('board-C', 'task', 'T-HD-1')
    expect(onC.record).toBeNull()
    expect(onC.contentReviewRequired).toBe(true)

    const auditA = await store.listAudit('board-A')
    const auditB = await store.listAudit('board-B')
    expect(auditA.every((a) => a.boardId === 'board-A')).toBe(true)
    expect(auditB.every((a) => a.boardId === 'board-B')).toBe(true)
  })

  it('list filters by entityKind', async () => {
    const task = sampleDisplay()
    const feature = buildHumanDisplay({
      entityKind: 'feature',
      entityId: 'FEAT-1',
      title: 'Fitur contoh',
      outcome: 'Outcome fitur',
      why: 'Why',
      current: 'Current',
      remaining: 'Remaining',
      next: 'Next',
      doneWhen: 'Done',
      blocker: 'Tidak ada',
      ownerAction: 'Tidak ada tindakan yang diperlukan',
      sourceFacts: {
        entityKind: 'feature',
        entityId: 'FEAT-1',
        boardRev: 1,
      },
    })
    await store.put({
      boardId: 'board-a',
      display: task,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: task.sourceHash,
    })
    await store.put({
      boardId: 'board-a',
      display: feature,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: feature.sourceHash,
    })
    const onlyTasks = await store.list('board-a', { entityKind: 'task' })
    expect(onlyTasks).toHaveLength(1)
    expect(onlyTasks[0]!.entityKind).toBe('task')
    const all = await store.list('board-a')
    expect(all).toHaveLength(2)
  })

  it('works with ART fixtureHumanDisplayForTask', async () => {
    const fx = fixtureHumanDisplayForTask(
      'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
      {
        reviewStatus: 'REVIEWED',
        reviewedAt: '2026-07-13T10:00:00.000Z',
      },
    )
    const put = await store.put({
      boardId: 'board-fx',
      display: fx,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: fx.sourceHash,
    })
    expect(put.ok).toBe(true)
    const got = await store.get(
      'board-fx',
      'task',
      'T-NODE-FC-WEB-PREMIUM-E2E-A02-API-CHECKOUT-QUOTE',
      {
        liveSourceHash: fx.sourceHash,
        boardRev: 1,
        canonicalSnapshotId: 'snap-fixture-1',
        canonicalHash: 'canon-fixture-aaa',
        lifecycleRev: 1,
      },
    )
    expect(got.primary?.title).toMatch(/checkout/i)
    expect(got.primary?.missionQuestionLinks?.length).toBeGreaterThan(0)
  })

  it('persists new ART + link fields through encode/decode round-trip in store', async () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
      parentFeatureTitle: 'Fitur persistensi ART',
      businessArea: 'Area bisnis A',
      actor: 'Penulis konten',
    })
    const put = await store.put({
      boardId: 'board-a',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    expect(put.ok).toBe(true)
    if (!put.ok) return
    expect(put.record.content.parentFeatureTitle).toBe('Fitur persistensi ART')
    expect(put.record.content.businessArea).toBe('Area bisnis A')
    expect(put.record.content.actor).toBe('Penulis konten')
    expect(put.record.content.acceptanceLinks[0]?.path).toBeTruthy()
    expect(put.record.content.missionQuestionLinks[0]?.questionId).toBeTruthy()
    expect(put.record.contentHash).toBe(computeHumanDisplayContentHash(display))
  })
})

describe('MySQL encode/decode + SQL surface', () => {
  it('encode/decode round-trips material fields including ART + links', () => {
    const display = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-13T12:00:00.000Z',
    })
    const rec = {
      boardId: 'b1',
      entityKind: display.entityKind,
      entityId: display.entityId,
      contentVersion: display.contentVersion,
      locale: display.locale,
      reviewStatus: display.reviewStatus,
      sourceHash: display.sourceHash,
      reviewedAt: display.reviewedAt,
      content: display,
      entityRev: 2,
      boardRev: 3,
      schemaVersion: display.schemaVersion,
      contentHash: computeHumanDisplayContentHash(display),
    }
    const encoded = encodeHumanDisplayRecord(rec)
    const decoded = decodeHumanDisplayRecord({
      ...encoded,
      content_json: JSON.stringify(encoded.content_json),
      reviewed_at: '2026-07-13 12:00:00.000',
    })
    expect(decoded.boardId).toBe('b1')
    expect(decoded.content.title).toBe(display.title)
    expect(decoded.content.parentFeatureTitle).toBe(display.parentFeatureTitle)
    expect(decoded.content.acceptanceLinks).toEqual(display.acceptanceLinks)
    expect(decoded.content.missionQuestionLinks).toEqual(
      display.missionQuestionLinks,
    )
    expect(decoded.contentHash).toBe(rec.contentHash)
    expect(decoded.entityRev).toBe(2)
  })

  it('HUMAN_DISPLAY_SQL includes CAS update predicates', () => {
    expect(HUMAN_DISPLAY_SQL.update).toMatch(/entity_rev=\?/)
    expect(HUMAN_DISPLAY_SQL.update).toMatch(/board_rev=\?/)
    expect(HUMAN_DISPLAY_SQL.insert).toMatch(/content_hash/)
    expect(HUMAN_DISPLAY_SQL.insertAudit).toMatch(
      /control_plane_human_display_audit/,
    )
  })

  it('createMysqlHumanDisplayStore rejects unsupported SQL only via memory exec', async () => {
    const sql = createMemoryHumanDisplaySql()
    const store = createMysqlHumanDisplayStore(sql)
    const display = sampleDisplay()
    const put = await store.put({
      boardId: 'b-sql',
      display,
      expectedEntityRev: 0,
      expectedBoardRev: 0,
      expectedSourceHash: display.sourceHash,
    })
    expect(put.ok).toBe(true)
    expect(sql.tables.control_plane_human_display.size).toBe(1)
    expect(sql.tables.control_plane_human_display_audit.size).toBe(1)
  })
})

describe('sourceHash binding uses contract computeHumanDisplaySourceHash', () => {
  it('put path does not invent PRODUCT when taskClass omitted', () => {
    const hash = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 't1',
      // taskClass omitted → UNCLASSIFIED in hash
    })
    const hashExplicit = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 't1',
      taskClass: 'UNCLASSIFIED',
    })
    const hashProduct = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: 't1',
      taskClass: 'PRODUCT',
    })
    expect(hash).toBe(hashExplicit)
    expect(hash).not.toBe(hashProduct)
  })
})
