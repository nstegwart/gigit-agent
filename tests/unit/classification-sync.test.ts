import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'

import { applyImport } from '#/server/canonical-import'
import { evaluateClassification } from '#/server/classification'
import {
  buildClassificationSyncPlan,
  ClassificationSyncError,
  projectClassificationSyncAuditActivity,
} from '#/server/classification-sync'
import {
  buildCanonicalSnapshotFromReplaceBoardArgs,
  createMemoryControlPlaneRuntimeContext,
  listRegisteredWriteToolSchemas,
  registerBoardTools,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  resolveMcpRuntimeContext,
  setTestControlPlaneRuntimeContext,
  writeToolSchemaHasFullEnvelope,
} from '#/server/board-mcp'
import { seedBoardRevision } from '#/server/control-data-persistence'
import {
  authorizeToolCall,
  defaultScopesForRole,
  isToolListable,
} from '#/server/rbac'
import type { Principal } from '#/server/rbac'
import type { McpAuthContext } from '#/server/board-mcp'

const pin = {
  canonicalSnapshotId: 'contract-import-v3-20260714',
  canonicalHash:
    'e8e4fec6d0f3223e09a0181f8d5c3e5828bf048f095a009d41af913d1f70f182',
  boardRev: 2883,
  lifecycleRev: 1,
}

const MCP_BOARD = 'classification-sync-mcp'

type ToolHandler = (args: Record<string, unknown>) => Promise<{
  content: Array<{ type: string; text: string }>
}>

function callToolHandler(server: McpServer, name: string): ToolHandler {
  const tools = (
    server as unknown as {
      _registeredTools: Partial<Record<string, { handler: ToolHandler }>>
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
  const result = await callToolHandler(server, name)(args)
  const text = result.content[0].text
  if (typeof text !== 'string') throw new Error(`no text from ${name}`)
  return JSON.parse(text) as Record<string, unknown>
}

function principal(
  role: 'AGENT' | 'OWNER' | 'ROOT_ORCHESTRATOR',
  actorId: string,
): Principal {
  return {
    role,
    actorId,
    agentId: role === 'AGENT' ? actorId : undefined,
    channel: 'bearer',
    scopes: defaultScopesForRole(role),
    boards: [],
  }
}

function authFor(value: Principal): McpAuthContext {
  return { principal: value, mechanism: { kind: 'OK' }, bearerPresent: true }
}

async function installCanonicalFixture() {
  const ctx = resolveMcpRuntimeContext()
  const sql = (
    ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }
  ).sql
  expect(sql).toBeTruthy()
  await seedBoardRevision(sql!, {
    boardId: MCP_BOARD,
    boardRev: 0,
    lifecycleRev: 1,
    subjectHash: '',
    canonicalSnapshotId: null,
    canonicalHash: null,
  })
  const before = await ctx.controlData.imports.getBoardState(MCP_BOARD)
  expect(before).not.toBeNull()
  const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
    MCP_BOARD,
    {
      projects: [{ id: 'p-sync', nama: 'Sync', status: 'active' }],
      features: [
        {
          id: 'f-sync',
          nama: 'Sync feature',
          fase: 'build',
          projectId: 'p-sync',
        },
      ],
      tasks: [
        {
          id: 't-product',
          title: 'Product',
          projectId: 'p-sync',
          featureId: 'f-sync',
        },
        {
          id: 't-control',
          title: 'Control',
          projectId: 'p-sync',
          featureId: 'f-sync',
        },
      ],
    },
    {
      idempotencyKey: 'fixture-sync-import',
      snapshotId: 'fixture-sync-snapshot',
    },
  )
  const applied = await applyImport(
    ctx.controlData.imports,
    ctx.idempotency,
    null,
    {
      auth: {
        actorId: 'root-fixture',
        scopes: ['import:write'],
        role: 'ROOT_ORCHESTRATOR',
      },
      snapshot,
      entityExpectedRev: before!.entityRev,
      expectedBoardRev: before!.boardRev,
      expectedSubjectHash: before!.subjectHash ?? '',
      idempotencyKey: 'fixture-sync-import',
      dryRun: false,
    },
  )
  expect(applied.ok).toBe(true)
  return { ctx, applied }
}

beforeEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
})

afterEach(() => {
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
})

describe('schema-007 classification sync', () => {
  it('projects only sanitized classification-sync audit activity and fails malformed detail safe', () => {
    const fallbackTs = '2026-07-15T10:00:00.000Z'
    expect(
      projectClassificationSyncAuditActivity(
        [
          {
            action: 'CLASSIFICATION_SYNC',
            ts: '2026-07-15T10:01:00.000Z',
            detail: JSON.stringify({
              eventId: 'audit-classification-1',
              taskCount: 639,
              outputBoardRev: 2884,
              secret: 'must-not-project',
            }),
          },
          {
            action: 'CLASSIFICATION_SYNC',
            ts: '',
            detail: '{malformed-json',
          },
          {
            action: 'RUN_STARTED',
            ts: '2026-07-15T10:02:00.000Z',
            detail: {
              eventId: 'not-classification',
              taskCount: 99,
              outputBoardRev: 9999,
            },
          },
        ],
        fallbackTs,
      ),
    ).toEqual([
      {
        ts: '2026-07-15T10:01:00.000Z',
        kind: 'classification_sync',
        message: 'Published 639 task classifications',
        auditId: 'audit-classification-1',
        boardRev: 2884,
        taskCount: 639,
      },
      {
        ts: fallbackTs,
        kind: 'classification_sync',
        message: 'Published 0 task classifications',
        auditId: null,
        boardRev: 0,
        taskCount: 0,
      },
    ])
  })

  it('is hidden and denied for AGENT while ROOT/OWNER require import authority', () => {
    const agent: Principal = {
      actorId: 'agent-1',
      agentId: 'agent-1',
      role: 'AGENT',
      scopes: ['board:read', 'run:write'],
      channel: 'bearer',
      boards: ['mfs-rebuild'],
      boardId: 'mfs-rebuild',
    }
    const root: Principal = {
      actorId: 'root-1',
      role: 'ROOT_ORCHESTRATOR',
      scopes: ['board:read', 'import:write'],
      channel: 'bearer',
      boards: ['mfs-rebuild'],
      boardId: 'mfs-rebuild',
    }
    expect(isToolListable(agent, 'sync_task_classifications')).toBe(false)
    expect(
      authorizeToolCall(agent, 'sync_task_classifications', {
        boardId: 'mfs-rebuild',
      }),
    ).toMatchObject({
      ok: false,
      code: 'FORBIDDEN_SCOPE',
    })
    expect(isToolListable(root, 'sync_task_classifications')).toBe(true)
    expect(
      authorizeToolCall(root, 'sync_task_classifications', {
        boardId: 'mfs-rebuild',
      }),
    ).toMatchObject({
      ok: true,
    })
    const owner = principal('OWNER', 'owner-1')
    expect(isToolListable(owner, 'sync_task_classifications')).toBe(true)
    expect(
      authorizeToolCall(owner, 'sync_task_classifications', {
        boardId: 'mfs-rebuild',
      }),
    ).toMatchObject({ ok: true })

    const server = new McpServer({
      name: 'classification-sync-rbac',
      version: '0.0.0',
    })
    registerBoardTools(server, {
      principal: root,
      mechanism: { kind: 'OK' },
      bearerPresent: true,
    })
    const schema = listRegisteredWriteToolSchemas().find(
      (entry) => entry.name === 'sync_task_classifications',
    )
    expect(schema).toBeDefined()
    expect(writeToolSchemaHasFullEnvelope(schema!.schemaKeys)).toBe(true)
  })

  it('real MCP handler persists exact set, replays before stale CAS, and rejects changed or partial input', async () => {
    const { ctx, applied } = await installCanonicalFixture()
    const rootServer = new McpServer({
      name: 'classification-sync-real',
      version: '0.0.0',
    })
    registerBoardTools(
      rootServer,
      authFor(principal('ROOT_ORCHESTRATOR', 'root-sync-author')),
    )
    const args = {
      boardId: MCP_BOARD,
      items: [
        { taskId: 't-product', taskClass: 'PRODUCT', disposition: 'ACTIVE' },
        {
          taskId: 't-control',
          taskClass: 'CONTROL_PLANE',
          disposition: 'ACTIVE',
          controlPlaneTargetGate: 'CONTROL_PLANE_WORK_PENDING',
        },
      ],
      entityExpectedRev: 0,
      expectedBoardRev: applied.boardRev,
      canonicalHash: applied.canonicalHash,
      idempotencyKey: 'classification-sync-real-1',
    }
    const first = await callToolJson(
      rootServer,
      'sync_task_classifications',
      args,
    )
    expect(first).toMatchObject({
      ok: true,
      entityRev: 1,
      boardRev: applied.boardRev + 1,
      counts: { total: 2, product: 1, controlPlane: 1 },
    })
    expect(await ctx.controlData.classification.list(MCP_BOARD)).toHaveLength(2)
    expect(
      await ctx.controlData.classification.get(MCP_BOARD, 't-product'),
    ).toMatchObject({
      taskClass: 'PRODUCT',
      disposition: 'ACTIVE',
    })

    // Exact retry carries the original now-stale revisions. Idempotency replay must
    // return the committed response before live CAS checks and must not bump twice.
    const replay = await callToolJson(
      rootServer,
      'sync_task_classifications',
      args,
    )
    expect(replay).toMatchObject({
      ok: true,
      replayed: true,
      boardRev: first.boardRev,
      entityRev: first.entityRev,
    })
    const afterReplay = await ctx.controlData.imports.getBoardState(MCP_BOARD)
    expect(afterReplay?.boardRev).toBe(first.boardRev)

    const changedSameKey = await callToolJson(
      rootServer,
      'sync_task_classifications',
      {
        ...args,
        items: [...args.items].reverse(),
      },
    )
    expect(changedSameKey.ok).toBe(false)
    expect(String(changedSameKey.code)).toMatch(/IDEMPOTENCY_CONFLICT|CONFLICT/)

    const partial = await callToolJson(
      rootServer,
      'sync_task_classifications',
      {
        ...args,
        items: [args.items[0]],
        entityExpectedRev: first.entityRev,
        expectedBoardRev: first.boardRev,
        idempotencyKey: 'classification-sync-real-partial',
      },
    )
    expect(partial).toMatchObject({ ok: false, code: 'DATA_INTEGRITY' })
    expect(await ctx.controlData.classification.list(MCP_BOARD)).toHaveLength(2)

    const agentServer = new McpServer({
      name: 'classification-sync-agent',
      version: '0.0.0',
    })
    registerBoardTools(agentServer, authFor(principal('AGENT', 'agent-sync')))
    expect(() =>
      callToolHandler(agentServer, 'sync_task_classifications'),
    ).toThrow(/tool not registered/)
  })

  it('emits receipt-valid rows bound to the single post-write revision', () => {
    const plan = buildClassificationSyncPlan({
      pin,
      issuedAt: '2026-07-15T10:00:00.000Z',
      canonicalTaskIds: ['T-PRODUCT', 'T-CONTROL', 'T-HOLD'],
      items: [
        { taskId: 'T-PRODUCT', taskClass: 'PRODUCT', disposition: 'ACTIVE' },
        {
          taskId: 'T-CONTROL',
          taskClass: 'CONTROL_PLANE',
          disposition: 'ACTIVE',
        },
        { taskId: 'T-HOLD', taskClass: 'PRODUCT', disposition: 'HOLD' },
      ],
    })

    expect(plan.inputBoardRev).toBe(2883)
    expect(plan.outputBoardRev).toBe(2884)
    expect(plan.counts).toEqual({
      total: 3,
      product: 2,
      controlPlane: 1,
      active: 2,
      hold: 1,
      exclude: 0,
    })

    const product = plan.records.find(
      (record) => record.taskId === 'T-PRODUCT',
    )!
    expect(
      evaluateClassification(product, {
        ...pin,
        taskHash: pin.canonicalHash,
        boardRev: plan.outputBoardRev,
      }),
    ).toMatchObject({ valid: true, contributesToProductReadiness: true })
    expect(
      evaluateClassification(product, {
        ...pin,
        taskHash: pin.canonicalHash,
        boardRev: plan.outputBoardRev + 500,
      }),
    ).toMatchObject({ valid: true, contributesToProductReadiness: true })
    expect(
      evaluateClassification(product, {
        ...pin,
        taskHash: pin.canonicalHash,
      }),
    ).toMatchObject({ valid: false, reasons: ['STALE_BOARD_REV'] })
    expect(
      evaluateClassification(product, {
        ...pin,
        taskHash: 'f'.repeat(64),
        canonicalHash: 'f'.repeat(64),
        boardRev: plan.outputBoardRev + 1,
      }),
    ).toMatchObject({
      valid: false,
      reasons: expect.arrayContaining([
        'STALE_CANONICAL_HASH',
        'STALE_TASK_HASH',
      ]),
    })

    const control = plan.records.find(
      (record) => record.taskId === 'T-CONTROL',
    )!
    expect(control).toMatchObject({
      controlPlaneTargetGate: 'CONTROL_PLANE_WORK_PENDING',
      controlPlaneGateVerifiedPass: false,
      controlPlaneRootAccepted: false,
    })
  })

  it('is deterministic for the same sorted logical input', () => {
    const input = {
      pin,
      issuedAt: '2026-07-15T10:00:00.000Z',
      canonicalTaskIds: ['T-2', 'T-1'],
      items: [
        {
          taskId: 'T-2',
          taskClass: 'CONTROL_PLANE' as const,
          disposition: 'ACTIVE' as const,
        },
        {
          taskId: 'T-1',
          taskClass: 'PRODUCT' as const,
          disposition: 'ACTIVE' as const,
        },
      ],
    }
    const first = buildClassificationSyncPlan(input)
    const second = buildClassificationSyncPlan({
      ...input,
      items: [...input.items].reverse(),
      canonicalTaskIds: [...input.canonicalTaskIds].reverse(),
    })
    expect(second).toEqual(first)
  })

  it('refuses partial, duplicate, and unclassified batches', () => {
    const cases = [
      {
        canonicalTaskIds: ['T-1', 'T-2'],
        items: [
          {
            taskId: 'T-1',
            taskClass: 'PRODUCT' as const,
            disposition: 'ACTIVE' as const,
          },
        ],
        code: 'TASK_SET_MISMATCH',
      },
      {
        canonicalTaskIds: ['T-1'],
        items: [
          {
            taskId: 'T-1',
            taskClass: 'PRODUCT' as const,
            disposition: 'ACTIVE' as const,
          },
          {
            taskId: 'T-1',
            taskClass: 'PRODUCT' as const,
            disposition: 'ACTIVE' as const,
          },
        ],
        code: 'DUPLICATE_TASK_ID',
      },
      {
        canonicalTaskIds: ['T-1'],
        items: [
          {
            taskId: 'T-1',
            taskClass: 'UNCLASSIFIED' as const,
            disposition: 'ACTIVE' as const,
          },
        ],
        code: 'UNCLASSIFIED_FORBIDDEN',
      },
      {
        canonicalTaskIds: ['T-1'],
        items: [
          {
            taskId: 'T-1',
            taskClass: 'CONTROL_PLANE' as const,
            disposition: 'HOLD' as const,
          },
        ],
        code: 'CONTROL_PLANE_HOLD_FORBIDDEN',
      },
    ]

    for (const testCase of cases) {
      try {
        buildClassificationSyncPlan({
          pin,
          issuedAt: '2026-07-15T10:00:00.000Z',
          canonicalTaskIds: testCase.canonicalTaskIds,
          items: testCase.items,
        })
        throw new Error('expected classification sync to fail')
      } catch (error) {
        expect(error).toBeInstanceOf(ClassificationSyncError)
        expect((error as ClassificationSyncError).code).toBe(testCase.code)
      }
    }
  })
})
