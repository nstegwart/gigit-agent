/**
 * MCP upsert_human_display / get_human_display unit coverage.
 * Insert / update / audit immutability / revision conflict / idempotency replay /
 * independent REVIEWED transition. Memory humanDisplay store via runtime context.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import {
  DEFINITION_MUTATOR_TOOL_NAMES,
  createMemoryControlPlaneRuntimeContext,
  listRegisteredWriteToolSchemas,
  parseHumanDisplayV1FromMcpArgs,
  registerBoardTools,
  REGISTERED_WRITE_TOOL_NAMES,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  resolveMcpRuntimeContext,
  setTestControlPlaneRuntimeContext,
  writeToolSchemaHasFullEnvelope,
  type McpAuthContext,
} from '#/server/board-mcp'
import {
  assertHumanDisplayWriteTransition,
  computeHumanDisplayContentHash,
  createMemoryHumanDisplayStore,
  HumanDisplayPersistenceError,
  resolveHumanDisplayPreviousAuthor,
} from '#/server/human-display-persistence'
import {
  buildHumanDisplay,
  computeHumanDisplaySourceHash,
  HUMAN_DISPLAY_SCHEMA_VERSION,
  type HumanDisplayV1,
} from '#/server/human-display'
import { defaultScopesForRole, isToolListable, type Principal } from '#/server/rbac'
import { seedBoardRevision } from '#/server/control-data-persistence'

const BOARD = 'hd-mcp-board'
const CANON = 'a'.repeat(64)
const ENTITY_ID = 'T-HD-MCP-1'

function rootPrincipal(actorId = 'root-hd-author'): Principal {
  return {
    role: 'ROOT_ORCHESTRATOR',
    actorId,
    channel: 'bearer',
    scopes: defaultScopesForRole('ROOT_ORCHESTRATOR'),
    boards: [],
  }
}

function ownerPrincipal(actorId = 'owner-hd-reviewer'): Principal {
  return {
    role: 'OWNER',
    actorId,
    channel: 'bearer',
    scopes: defaultScopesForRole('OWNER'),
    boards: [],
  }
}

function authFor(p: Principal): McpAuthContext {
  return { principal: p, mechanism: { kind: 'OK' }, bearerPresent: true }
}

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
}>

function toolHandler(server: McpServer, name: string): ToolHandler {
  const tools = (
    server as unknown as {
      _registeredTools: Record<string, { handler: ToolHandler }>
    }
  )._registeredTools
  const entry = tools[name]
  if (!entry?.handler) throw new Error(`tool not registered: ${name}`)
  return entry.handler
}

async function callToolJson(
  server: McpServer,
  name: string,
  args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
  const result = await toolHandler(server, name)(args)
  const text = result.content?.[0]?.text
  if (typeof text !== 'string') throw new Error(`no text from ${name}`)
  return JSON.parse(text) as Record<string, unknown>
}

function sampleDisplay(
  overrides: Partial<HumanDisplayV1> & {
    sourceFacts?: Parameters<typeof buildHumanDisplay>[0]['sourceFacts']
  } = {},
): HumanDisplayV1 {
  const { sourceFacts: sourceOver, ...rest } = overrides
  const sourceFacts = {
    entityKind: 'task' as const,
    entityId: ENTITY_ID,
    technicalTitle: '[FC-HD] technical',
    objective: 'Owner outcome',
    lifecycleStage: 'MAPPED',
    disposition: 'ACTIVE',
    taskClass: 'UNCLASSIFIED' as const,
    acceptance: 'Owner-readable copy',
    canonicalSnapshotId: 'snap-hd-1',
    canonicalHash: CANON,
    boardRev: 1,
    lifecycleRev: 0,
    ...(sourceOver ?? {}),
  }
  const built = buildHumanDisplay({
    entityKind: 'task',
    entityId: ENTITY_ID,
    title: 'Menampilkan salinan pemilik untuk entitas papan',
    outcome: 'Pemilik melihat salinan manusia yang jujur.',
    why: 'Judul teknis mentah tidak boleh menjadi teks utama.',
    current: 'Fakta sumber tersedia untuk peninjauan.',
    remaining: 'Tinjau dan set REVIEWED.',
    next: 'Minta peninjauan independen.',
    doneWhen: 'reviewStatus=REVIEWED dengan sourceHash cocok.',
    blocker: 'Tidak ada',
    ownerAction: 'Tidak ada tindakan yang diperlukan',
    reviewStatus: 'GENERATED_NEEDS_REVIEW',
    reviewedAt: null,
    contentVersion: 1,
    parentFeatureTitle: 'Fitur salinan pemilik',
    businessArea: 'Control plane owner UX',
    actor: 'Content author',
    citations: [
      { field: 'title', path: `task/${ENTITY_ID}`, note: 'entity' },
      { field: 'outcome', path: `task/${ENTITY_ID}.objective` },
    ],
    acceptanceLinks: [
      {
        id: 'AC-HD-MCP-1',
        path: `task/${ENTITY_ID}.acceptance`,
        summary: 'Owner-readable copy',
      },
    ],
    missionQuestionLinks: [
      { questionId: 'Q1', field: 'outcome' },
      { questionId: 'Q2', field: 'why' },
    ],
    sourceFacts,
  })
  return { ...built, ...rest }
}

function upsertArgs(
  display: HumanDisplayV1,
  over: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    boardId: BOARD,
    entityKind: display.entityKind,
    entityId: display.entityId,
    title: display.title,
    outcome: display.outcome,
    whyItMatters: display.why,
    currentState: display.current,
    remainingWork: display.remaining,
    nextAction: display.next,
    blockerSummary: display.blocker,
    doneWhen: display.doneWhen,
    ownerAction: display.ownerAction,
    parentFeatureTitle: display.parentFeatureTitle,
    businessArea: display.businessArea,
    actor: display.actor,
    sourceHash: display.sourceHash,
    locale: display.locale,
    reviewStatus: display.reviewStatus,
    reviewedAt: display.reviewedAt,
    contentVersion: display.contentVersion,
    schemaVersion: display.schemaVersion,
    snapshotId: display.snapshotId,
    boardRev: display.boardRev,
    lifecycleRev: display.lifecycleRev,
    displayCanonicalHash: display.canonicalHash ?? undefined,
    citations: display.citations,
    acceptanceLinks: display.acceptanceLinks,
    missionQuestionLinks: display.missionQuestionLinks,
    entityExpectedRev: 0,
    expectedBoardRev: 0,
    canonicalHash: CANON,
    idempotencyKey: 'idem-hd-default',
    ...over,
  }
}

async function seedBoard(boardRev = 0, subjectHash = CANON) {
  const ctx = resolveMcpRuntimeContext()
  const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
  if (sql) {
    await seedBoardRevision(sql, {
      boardId: BOARD,
      boardRev,
      lifecycleRev: 0,
      subjectHash,
      importEntityRev: 0,
      canonicalSnapshotId: 'snap-hd-1',
      canonicalHash: subjectHash,
    })
  }
  // Ensure atomic board state exists for board-rev CAS.
  try {
    await ctx.atomic.getBoardState(BOARD)
  } catch {
    /* memory atomic may auto-create */
  }
  // Seed atomic board rev if empty.
  const state = await ctx.atomic.getBoardState(BOARD)
  if (state.boardRev !== boardRev) {
    // bump until match or seed via memory map if available
    while ((await ctx.atomic.getBoardState(BOARD)).boardRev < boardRev) {
      await ctx.atomic.bumpBoardRev(BOARD)
    }
  }
}

beforeEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  const mem = createMemoryControlPlaneRuntimeContext({
    seedBoards: [
      {
        boardId: BOARD,
        boardRev: 0,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      },
    ],
    humanDisplay: createMemoryHumanDisplayStore(),
  })
  setTestControlPlaneRuntimeContext(mem)
})

afterEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
})

describe('upsert_human_display catalog', () => {
  it('is registered write with full mutation envelope; not a definition mutator', () => {
    expect(REGISTERED_WRITE_TOOL_NAMES).toContain('upsert_human_display')
    expect(REGISTERED_WRITE_TOOL_NAMES).toHaveLength(43)
    expect(DEFINITION_MUTATOR_TOOL_NAMES as readonly string[]).not.toContain(
      'upsert_human_display',
    )

    const server = new McpServer({ name: 'hd-cat', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal()))
    const writes = listRegisteredWriteToolSchemas()
    const row = writes.find((w) => w.name === 'upsert_human_display')
    expect(row).toBeTruthy()
    expect(writeToolSchemaHasFullEnvelope(row!.schemaKeys)).toBe(true)
    expect(row!.schemaKeys).toEqual(
      expect.arrayContaining([
        'entityKind',
        'entityId',
        'title',
        'outcome',
        'sourceHash',
        'entityExpectedRev',
        'expectedBoardRev',
        'canonicalHash',
        'idempotencyKey',
      ]),
    )
    expect(isToolListable(rootPrincipal(), 'upsert_human_display')).toBe(true)
    expect(isToolListable(ownerPrincipal(), 'upsert_human_display')).toBe(true)
    expect(isToolListable(null, 'upsert_human_display')).toBe(false)
  })
})

describe('assertHumanDisplayWriteTransition (independent review)', () => {
  it('allows GENERATED_NEEDS_REVIEW authoring; rejects same-actor REVIEWED', () => {
    const generated = sampleDisplay()
    expect(() =>
      assertHumanDisplayWriteTransition({
        display: generated,
        existing: null,
        actorId: 'author-1',
        actorRole: 'ROOT_ORCHESTRATOR',
        previousAuthor: null,
      }),
    ).not.toThrow()

    const reviewed = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-14T12:00:00.000Z',
    })
    expect(() =>
      assertHumanDisplayWriteTransition({
        display: reviewed,
        existing: null,
        actorId: 'author-1',
        actorRole: 'OWNER',
        previousAuthor: null,
      }),
    ).toThrow(HumanDisplayPersistenceError)

    const existingRecord = {
      boardId: BOARD,
      entityKind: 'task' as const,
      entityId: ENTITY_ID,
      contentVersion: 1,
      locale: 'id-ID',
      reviewStatus: 'GENERATED_NEEDS_REVIEW' as const,
      sourceHash: generated.sourceHash,
      reviewedAt: null,
      content: generated,
      entityRev: 1,
      boardRev: 1,
      schemaVersion: HUMAN_DISPLAY_SCHEMA_VERSION,
      contentHash: computeHumanDisplayContentHash(generated),
    }
    expect(() =>
      assertHumanDisplayWriteTransition({
        display: reviewed,
        existing: existingRecord,
        actorId: 'author-1',
        actorRole: 'OWNER',
        previousAuthor: { actorId: 'author-1', role: 'ROOT_ORCHESTRATOR' },
      }),
    ).toThrow(/reviewer actor must differ/)

    expect(() =>
      assertHumanDisplayWriteTransition({
        display: reviewed,
        existing: existingRecord,
        actorId: 'reviewer-2',
        actorRole: 'ROOT_ORCHESTRATOR',
        previousAuthor: { actorId: 'author-1', role: 'ROOT_ORCHESTRATOR' },
      }),
    ).toThrow(/reviewer role must differ/)

    expect(() =>
      assertHumanDisplayWriteTransition({
        display: reviewed,
        existing: existingRecord,
        actorId: 'reviewer-2',
        actorRole: 'OWNER',
        previousAuthor: { actorId: 'author-1', role: 'ROOT_ORCHESTRATOR' },
      }),
    ).not.toThrow()
  })
})

describe('upsert_human_display MCP tool', () => {
  it('insert + get_human_display round-trip with audit receipt', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const server = new McpServer({ name: 'hd-insert', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal('root-hd-author')))

    const res = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(display, { idempotencyKey: 'idem-hd-insert-1' }),
    )
    expect(res.ok).toBe(true)
    expect(res.entityRev).toBe(1)
    expect(res.reviewStatus).toBe('GENERATED_NEEDS_REVIEW')
    expect(res.replayed).toBe(false)
    expect(res.auditId).toBeTruthy()
    expect(res.contentHash).toBe(computeHumanDisplayContentHash(display))
    expect(res.boardRev).toBe(1) // live board bumped

    const got = await callToolJson(server, 'get_human_display', {
      boardId: BOARD,
      entityKind: 'task',
      entityId: ENTITY_ID,
      liveSourceHash: display.sourceHash,
    })
    expect(got.ok).toBe(true)
    expect(got.contentReviewRequired).toBe(true) // not REVIEWED yet
    expect((got.record as { entityId: string } | null)?.entityId).toBe(ENTITY_ID)
    expect(got.effectiveReviewStatus).toBe('GENERATED_NEEDS_REVIEW')

    const store = resolveMcpRuntimeContext().humanDisplay
    const audits = await store.listAudit(BOARD)
    expect(audits.length).toBeGreaterThanOrEqual(1)
    expect(audits[0]!.event).toMatch(/INSERT/)
    expect(audits[0]!.actorId).toBe('root-hd-author')
    expect(audits[0]!.payload.actorRole).toBe('ROOT_ORCHESTRATOR')
  })

  it('update bumps entity_rev; audit immutability rejects different content same audit id', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const server = new McpServer({ name: 'hd-update', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal('root-hd-author')))

    const first = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(display, {
        idempotencyKey: 'idem-hd-up-1',
        expectedBoardRev: 0,
        entityExpectedRev: 0,
      }),
    )
    expect(first.ok).toBe(true)
    expect(first.entityRev).toBe(1)

    const updated = sampleDisplay({
      title: 'Judul pemilik yang diperbarui setelah umpan balik',
      contentVersion: 2,
    })
    // sourceHash changes with content? No - sourceHash is from source facts; title is prose.
    // Keep same sourceHash unless source facts change.
    const second = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(updated, {
        idempotencyKey: 'idem-hd-up-2',
        expectedBoardRev: first.boardRev as number,
        entityExpectedRev: 1,
        title: updated.title,
        contentVersion: 2,
        sourceHash: display.sourceHash, // same facts
      }),
    )
    expect(second.ok).toBe(true)
    expect(second.entityRev).toBe(2)
    expect(second.replayed).toBe(false)

    // Domain audit immutability: force same auditId with different contentHash via store
    const store = resolveMcpRuntimeContext().humanDisplay
    const audits = await store.listAudit(BOARD)
    const insertAudit = audits.find((a) => a.event === 'HUMAN_DISPLAY_PUT_INSERT')
    expect(insertAudit).toBeTruthy()
    const conflict = await store.put({
      boardId: BOARD,
      display: sampleDisplay({
        title: 'Tamper content for audit conflict path',
        contentVersion: 99,
      }),
      expectedEntityRev: 2,
      expectedBoardRev: (second.boardRevPin as number) ?? 1,
      expectedSourceHash: display.sourceHash,
      actorId: 'tamper',
      auditId: insertAudit!.auditId,
    })
    expect(conflict.ok).toBe(false)
    if (!conflict.ok) {
      expect(conflict.code).toBe('IDEMPOTENCY_CONFLICT')
    }
  })

  it('revision conflict: stale entityExpectedRev rejected', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const server = new McpServer({ name: 'hd-stale', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal()))

    const first = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(display, { idempotencyKey: 'idem-hd-stale-1' }),
    )
    expect(first.ok).toBe(true)

    const stale = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(display, {
        idempotencyKey: 'idem-hd-stale-2',
        entityExpectedRev: 0, // stale — current is 1
        expectedBoardRev: first.boardRev as number,
        title: 'Should not apply',
      }),
    )
    expect(stale.ok).toBe(false)
    expect(String(stale.code)).toMatch(/STALE_REVISION/)
  })

  it('idempotency: exact key/request replay; changed body conflict', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const server = new McpServer({ name: 'hd-idem', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal()))
    const args = upsertArgs(display, { idempotencyKey: 'idem-hd-exact-1' })

    const first = await callToolJson(server, 'upsert_human_display', args)
    expect(first.ok).toBe(true)
    expect(first.replayed).toBe(false)
    expect(first.entityRev).toBe(1)

    const second = await callToolJson(server, 'upsert_human_display', args)
    expect(second.ok).toBe(true)
    expect(second.replayed).toBe(true)
    expect(second.entityRev).toBe(first.entityRev)
    expect(second.contentHash).toBe(first.contentHash)

    const conflict = await callToolJson(server, 'upsert_human_display', {
      ...args,
      title: 'Changed body same idempotency key',
    })
    expect(conflict.ok).toBe(false)
    expect(String(conflict.code)).toMatch(/IDEMPOTENCY_CONFLICT|CONFLICT/)
  })

  it('independent review: same actor cannot set REVIEWED; different role can', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const authorServer = new McpServer({ name: 'hd-auth', version: '0.0.0' })
    registerBoardTools(authorServer, authFor(rootPrincipal('root-hd-author')))

    const authored = await callToolJson(
      authorServer,
      'upsert_human_display',
      upsertArgs(display, { idempotencyKey: 'idem-hd-rev-1' }),
    )
    expect(authored.ok).toBe(true)

    // Same ROOT actor tries REVIEWED → reject
    const selfReview = sampleDisplay({
      reviewStatus: 'REVIEWED',
      reviewedAt: '2026-07-14T15:00:00.000Z',
    })
    const denied = await callToolJson(
      authorServer,
      'upsert_human_display',
      upsertArgs(selfReview, {
        idempotencyKey: 'idem-hd-rev-2',
        entityExpectedRev: 1,
        expectedBoardRev: authored.boardRev as number,
        reviewStatus: 'REVIEWED',
        reviewedAt: '2026-07-14T15:00:00.000Z',
      }),
    )
    expect(denied.ok).toBe(false)
    expect(String(denied.code)).toMatch(/INDEPENDENT_REVIEW_REQUIRED/)

    // OWNER different actor → allowed
    const ownerServer = new McpServer({ name: 'hd-own', version: '0.0.0' })
    registerBoardTools(ownerServer, authFor(ownerPrincipal('owner-hd-reviewer')))
    const approved = await callToolJson(
      ownerServer,
      'upsert_human_display',
      upsertArgs(selfReview, {
        idempotencyKey: 'idem-hd-rev-3',
        entityExpectedRev: 1,
        expectedBoardRev: authored.boardRev as number,
        reviewStatus: 'REVIEWED',
        reviewedAt: '2026-07-14T15:00:00.000Z',
      }),
    )
    expect(approved.ok).toBe(true)
    expect(approved.reviewStatus).toBe('REVIEWED')
    expect(approved.entityRev).toBe(2)

    const got = await callToolJson(ownerServer, 'get_human_display', {
      boardId: BOARD,
      entityKind: 'task',
      entityId: ENTITY_ID,
      liveSourceHash: display.sourceHash,
    })
    expect(got.ok).toBe(true)
    expect(got.effectiveReviewStatus).toBe('REVIEWED')
    expect(got.contentReviewRequired).toBe(false)
    expect((got.primary as { title: string } | null)?.title).toBe(selfReview.title)
  })

  it('stale board pin hash rejected before write', async () => {
    await seedBoard(0, CANON)
    const display = sampleDisplay()
    const server = new McpServer({ name: 'hd-pin', version: '0.0.0' })
    registerBoardTools(server, authFor(rootPrincipal()))
    const bad = await callToolJson(
      server,
      'upsert_human_display',
      upsertArgs(display, {
        idempotencyKey: 'idem-hd-pin-1',
        canonicalHash: 'b'.repeat(64),
      }),
    )
    expect(bad.ok).toBe(false)
    expect(String(bad.code)).toMatch(/STALE_REVISION/)
  })
})

describe('parseHumanDisplayV1FromMcpArgs', () => {
  it('maps ART aliases and defaults schema/locale/reviewStatus', () => {
    const sourceHash = computeHumanDisplaySourceHash({
      entityKind: 'task',
      entityId: ENTITY_ID,
      technicalTitle: 't',
      objective: 'o',
      lifecycleStage: 'MAPPED',
      disposition: 'ACTIVE',
      taskClass: 'UNCLASSIFIED',
      acceptance: 'a',
      canonicalSnapshotId: 'snap',
      canonicalHash: CANON,
      boardRev: 1,
      lifecycleRev: 0,
    })
    const d = parseHumanDisplayV1FromMcpArgs({
      entityKind: 'task',
      entityId: ENTITY_ID,
      title: 'Judul pemilik',
      outcome: 'Hasil',
      whyItMatters: 'Mengapa',
      currentState: 'Saat ini',
      remainingWork: 'Sisa',
      nextAction: 'Berikutnya',
      blockerSummary: 'Tidak ada',
      doneWhen: 'Selesai',
      ownerAction: 'Tindakan',
      sourceHash,
    })
    expect(d.schemaVersion).toBe(HUMAN_DISPLAY_SCHEMA_VERSION)
    expect(d.locale).toBe('id-ID')
    expect(d.reviewStatus).toBe('GENERATED_NEEDS_REVIEW')
    expect(d.why).toBe('Mengapa')
    expect(d.current).toBe('Saat ini')
    expect(d.remaining).toBe('Sisa')
    expect(d.next).toBe('Berikutnya')
    expect(d.blocker).toBe('Tidak ada')
  })
})

describe('resolveHumanDisplayPreviousAuthor', () => {
  it('picks latest non-REVIEWED author trail', () => {
    const trail = resolveHumanDisplayPreviousAuthor(
      [
        {
          boardId: BOARD,
          auditId: 'a1',
          entityKind: 'task',
          entityId: ENTITY_ID,
          contentVersion: 1,
          event: 'HUMAN_DISPLAY_PUT_INSERT',
          actorId: 'author-1',
          sourceHash: 's',
          contentHash: 'c1',
          reviewStatus: 'GENERATED_NEEDS_REVIEW',
          entityRev: 1,
          boardRev: 1,
          capturedAt: '2026-07-14T10:00:00.000Z',
          payload: { actorRole: 'AGENT' },
        },
        {
          boardId: BOARD,
          auditId: 'a2',
          entityKind: 'task',
          entityId: ENTITY_ID,
          contentVersion: 1,
          event: 'HUMAN_DISPLAY_PUT_UPDATE',
          actorId: 'reviewer',
          sourceHash: 's',
          contentHash: 'c2',
          reviewStatus: 'REVIEWED',
          entityRev: 2,
          boardRev: 1,
          capturedAt: '2026-07-14T11:00:00.000Z',
          payload: { actorRole: 'OWNER' },
        },
      ],
      'task',
      ENTITY_ID,
    )
    expect(trail).toEqual({ actorId: 'author-1', role: 'AGENT' })
  })
})
