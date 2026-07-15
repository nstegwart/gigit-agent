import { execFile } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { promisify } from 'node:util'

import { afterEach, describe, expect, it } from 'vitest'

const execFileAsync = promisify(execFile)
const SCRIPT = resolve('scripts/schema007-sync-replay.mjs')
const CANONICAL_HASH = 'a'.repeat(64)

type MockState = {
  boardRev: number
  lifecycleRev: number
  classified: boolean
  classificationEntityRev: number
  auditId: string | null
  runs: Array<Record<string, unknown>>
  calls: Array<{ name: string; args: Record<string, unknown> }>
}

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()))
})

function canonicalTasks(): Array<Record<string, unknown>> {
  return Array.from({ length: 639 }, (_, index) => {
    const controlPlane = index < 30
    const hold = !controlPlane && index >= 632
    return {
      id: `TASK-${String(index + 1).padStart(3, '0')}`,
      projectId: controlPlane ? 'automation' : 'product',
      scope: hold ? 'hold' : 'active',
    }
  })
}

function pin(state: MockState) {
  return {
    boardRev: state.boardRev,
    lifecycleRev: state.lifecycleRev,
    canonicalSnapshotId: 'mock-snapshot',
    canonicalHash: CANONICAL_HASH,
  }
}

function responseFor(
  state: MockState,
  tasks: Array<Record<string, unknown>>,
  name: string,
  args: Record<string, unknown>,
): Record<string, unknown> {
  state.calls.push({ name, args })
  const currentPin = pin(state)
  if (name === 'get_board_hash') return { ok: true, ...currentPin }
  if (name === 'get_rollup') {
    return {
      ok: true,
      ...currentPin,
      data: {
        rollup: { unclassifiedCount: state.classified ? 0 : 639 },
        controlPlane: {
          classificationSync: {
            entityRev: state.classificationEntityRev,
            subjectHash: state.classified ? CANONICAL_HASH : null,
          },
        },
      },
    }
  }
  if (name === 'get_lifecycle')
    return { ok: true, ...currentPin, data: { lifecycle: [] } }
  if (name === 'get_next') {
    return {
      ok: true,
      ...currentPin,
      planId: null,
      blockedReason: 'NO_ACTIVE_PLAN',
    }
  }
  if (name === 'list_tasks')
    return { ok: true, ...currentPin, data: { tasks }, nextCursor: null }
  if (name === 'list_runs') {
    return {
      ok: true,
      ...currentPin,
      data: { runs: state.runs },
      nextCursor: null,
    }
  }
  if (name === 'list_audit') {
    const audit = state.auditId
      ? [
          {
            action: 'CLASSIFICATION_SYNC',
            detail: {
              eventId: state.auditId,
              canonicalHash: CANONICAL_HASH,
              outputBoardRev: state.boardRev,
              taskCount: 639,
            },
          },
        ]
      : []
    return { ok: true, ...currentPin, data: { audit }, nextCursor: null }
  }
  if (name === 'list_activity') {
    const activity = state.auditId
      ? [
          {
            kind: 'classification_sync',
            auditId: state.auditId,
            taskCount: 639,
          },
        ]
      : []
    return { ok: true, ...currentPin, data: { activity }, nextCursor: null }
  }
  if (name === 'sync_task_classifications') {
    state.boardRev += 1
    state.classificationEntityRev += 1
    state.classified = true
    state.auditId = `classification-sync-mock-${state.classificationEntityRev}`
    return {
      ok: true,
      ...pin(state),
      entityRev: state.classificationEntityRev,
      auditId: state.auditId,
      receiptSetHash: 'b'.repeat(64),
    }
  }
  if (name === 'upsert_run') {
    state.boardRev += 1
    const run = { id: args.id, runId: args.id, status: args.status }
    state.runs.push(run)
    return { ok: true, ...pin(state), run }
  }
  throw new Error(`unexpected MCP tool: ${name}`)
}

async function startMock(alreadyClassified = false) {
  const tasks = canonicalTasks()
  const state: MockState = {
    boardRev: 20,
    lifecycleRev: 1,
    classified: alreadyClassified,
    classificationEntityRev: alreadyClassified ? 1 : 0,
    auditId: alreadyClassified ? 'classification-sync-existing' : null,
    runs: [],
    calls: [],
  }
  const server = createServer(async (request, response) => {
    const chunks: Buffer[] = []
    for await (const chunk of request) chunks.push(Buffer.from(chunk))
    const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
      id: string
      method: string
      params?: { name?: string; arguments?: Record<string, unknown> }
    }
    let result: Record<string, unknown>
    if (body.method === 'tools/list') {
      result = {
        tools: [
          'sync_task_classifications',
          'list_audit',
          'list_activity',
          'upsert_run',
        ].map((name) => ({ name })),
      }
    } else {
      const name = String(body.params?.name ?? '')
      const payload = responseFor(
        state,
        tasks,
        name,
        body.params?.arguments ?? {},
      )
      result = { content: [{ type: 'text', text: JSON.stringify(payload) }] }
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }))
  })
  await new Promise<void>((resolveListen) =>
    server.listen(0, '127.0.0.1', resolveListen),
  )
  const address = server.address()
  if (!address || typeof address === 'string')
    throw new Error('mock server address unavailable')
  cleanups.push(
    () =>
      new Promise<void>((resolveClose) => server.close(() => resolveClose())),
  )
  return { state, endpoint: `http://127.0.0.1:${address.port}/mcp`, tasks }
}

async function fixtureFiles(
  tasks: Array<Record<string, unknown>>,
  withReceipt = false,
) {
  const directory = await mkdtemp(join(tmpdir(), 'schema007-replay-'))
  const receiptDir = join(directory, 'receipts')
  await import('node:fs/promises').then(({ mkdir }) => mkdir(receiptDir))
  const canonicalPath = join(directory, 'tasks.json')
  await writeFile(canonicalPath, JSON.stringify(tasks))
  if (withReceipt) {
    await writeFile(
      join(receiptDir, 'UNSYNCED_RECEIPT_mock.json'),
      JSON.stringify({
        receiptId: 'receipt-mock-1',
        runId: 'run-mock-1',
        role: 'verifier',
        packet: 'mock replay',
        verdict: 'PASS',
        evidencePath: '/safe/mock/evidence.json',
      }),
    )
  }
  cleanups.push(() => rm(directory, { recursive: true, force: true }))
  return { receiptDir, canonicalPath }
}

async function runReplay(
  endpoint: string,
  files: Awaited<ReturnType<typeof fixtureFiles>>,
  args: string[],
) {
  const { stdout } = await execFileAsync('node', [SCRIPT, ...args], {
    env: {
      ...process.env,
      CAIRN_MCP_URL: endpoint,
      CAIRN_BOARD_ID: 'mfs-rebuild',
      CAIRN_WRITE_TOKEN: 'test-agent-token',
      CAIRN_ROOT_WRITE_TOKEN: 'test-root-token',
      CAIRN_UNSYNCED_RECEIPT_DIR: files.receiptDir,
      CAIRN_CANONICAL_TASKS: files.canonicalPath,
    },
    maxBuffer: 5 * 1024 * 1024,
  })
  return JSON.parse(stdout) as Record<string, unknown>
}

describe('schema007 sync replay executable', () => {
  it('reapply of an already-published canonical set is a readback-only no-op', async () => {
    const mock = await startMock(false)
    const files = await fixtureFiles(mock.tasks)
    const first = await runReplay(mock.endpoint, files, [
      '--apply-classifications',
    ])
    expect((first.writes as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: 'classification_sync',
      ok: true,
      noOp: false,
    })
    const afterFirstBoardRev = mock.state.boardRev

    const second = await runReplay(mock.endpoint, files, [
      '--apply-classifications',
    ])
    expect((second.writes as Array<Record<string, unknown>>)[0]).toMatchObject({
      kind: 'classification_sync',
      ok: true,
      noOp: true,
    })
    expect(
      mock.state.calls.filter(
        (call) => call.name === 'sync_task_classifications',
      ),
    ).toHaveLength(1)
    expect(mock.state.boardRev).toBe(afterFirstBoardRev)
  })

  it('combined mode performs final classification and per-run readback after replay writes', async () => {
    const mock = await startMock(false)
    const files = await fixtureFiles(mock.tasks, true)
    const report = await runReplay(mock.endpoint, files, [
      '--apply-classifications',
      '--apply-runs',
    ])
    expect(report.finalReadback).toMatchObject({
      boardRev: 22,
      pinsMatch: true,
      classificationsStillValid: true,
      unclassified: 0,
      exactTaskSet: true,
      classificationActivitySeen: true,
      runReadbacks: [{ runId: 'run-mock-1', visible: true, status: 'done' }],
    })
    const lastRunWrite = mock.state.calls
      .map((call) => call.name)
      .lastIndexOf('upsert_run')
    expect(lastRunWrite).toBeGreaterThanOrEqual(0)
    expect(
      mock.state.calls.slice(lastRunWrite + 1).map((call) => call.name),
    ).toEqual(
      expect.arrayContaining([
        'get_board_hash',
        'get_rollup',
        'get_lifecycle',
        'list_audit',
        'list_activity',
        'list_tasks',
        'list_runs',
      ]),
    )
  })
})
