// E2E for the /mcp JSON-RPC endpoint — the real MCP board tools an AI client
// (Claude/Cursor) uses to drive Cairn. Verifies tools/list advertises the read
// tools and tools/call returns board data as MCP text content.
// Read-only: every request here uses the read tools (list_projects / list_features
// / get_feature / list_runs), so nothing mutates data/plan.json — nothing to restore.
import { expect, test, type APIRequestContext } from '@playwright/test'

type ToolContent = { type: string; text: string }
type RpcResult = {
  jsonrpc?: string
  id?: number | string | null
  result?: {
    tools?: Array<{ name: string; description?: string }>
    content?: ToolContent[]
    isError?: boolean
  }
  error?: { code: number; message: string }
}

async function rpc(
  request: APIRequestContext,
  body: Record<string, unknown>,
): Promise<RpcResult> {
  const res = await request.post('/mcp', { headers: { accept: 'application/json, text/event-stream' }, data: body })
  expect(res.ok(), `POST /mcp failed: ${res.status()}`).toBeTruthy()
  return (await res.json()) as RpcResult
}

/** Call a tool and return the parsed JSON payload of its first text content block. */
async function callTool<T = unknown>(
  request: APIRequestContext,
  name: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  const body = await rpc(request, {
    jsonrpc: '2.0',
    id: 1,
    method: 'tools/call',
    params: { name, arguments: args },
  })
  const text = body.result?.content?.[0]?.text
  expect(text, `${name} returned no text content`).toBeTruthy()
  return JSON.parse(text as string) as T
}

test.describe('/mcp board tools', () => {
  test('tools/list advertises the read tools (and not addTodo)', async ({ request }) => {
    const body = await rpc(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = body.result?.tools
    expect(Array.isArray(tools)).toBe(true)

    const names = (tools ?? []).map((t) => t.name)
    for (const expected of ['list_projects', 'list_features', 'get_feature', 'list_runs']) {
      expect(names, `tools/list should expose ${expected}`).toContain(expected)
    }
    // The prototype's placeholder tool must be gone.
    expect(names).not.toContain('addTodo')
  })

  test('tools/call list_projects returns a JSON list of projects', async ({ request }) => {
    const payload = await callTool<{ projects: Array<{ id: string; nama: string }> }>(
      request,
      'list_projects',
    )
    expect(Array.isArray(payload.projects)).toBe(true)
    expect(payload.projects.length).toBeGreaterThanOrEqual(1)

    const first = payload.projects[0]
    expect(first.id).toBeTruthy()
    expect(first.nama).toBeTruthy()
    // Shape from featureCount/progress fields (not a raw array).
    expect(payload.projects[0]).toHaveProperty('status')
  })

  test('tools/call list_features returns features', async ({ request }) => {
    const payload = await callTool<{
      features: Array<{ id: string; nama: string; fase: string; projectId: string }>
    }>(request, 'list_features')
    expect(Array.isArray(payload.features)).toBe(true)
    expect(payload.features.length).toBeGreaterThanOrEqual(1)

    const f = payload.features[0]
    expect(f.id).toBeTruthy()
    expect(f.nama).toBeTruthy()
    expect(f).toHaveProperty('fase')
    expect(f).toHaveProperty('taskTotal')
  })

  test('list_features filtered by projectId only returns that project', async ({ request }) => {
    const all = await callTool<{ features: Array<{ id: string; projectId: string }> }>(
      request,
      'list_features',
    )
    const projectId = all.features[0]?.projectId
    expect(projectId, 'need at least one feature with a projectId').toBeTruthy()

    const scoped = await callTool<{ features: Array<{ projectId: string }> }>(
      request,
      'list_features',
      { projectId },
    )
    expect(scoped.features.length).toBeGreaterThanOrEqual(1)
    for (const feat of scoped.features) {
      expect(feat.projectId).toBe(projectId)
    }
  })

  test('tools/call get_feature returns a single feature with its checklist', async ({
    request,
  }) => {
    const list = await callTool<{ features: Array<{ id: string }> }>(request, 'list_features')
    const id = list.features[0]?.id
    expect(id, 'need at least one feature id').toBeTruthy()

    const payload = await callTool<{
      feature: { id: string; nama: string; checklist: unknown[]; runs: unknown[] }
    }>(request, 'get_feature', { id })
    expect(payload.feature).toBeTruthy()
    expect(payload.feature.id).toBe(id)
    expect(payload.feature.nama).toBeTruthy()
    expect(Array.isArray(payload.feature.checklist)).toBe(true)
    expect(Array.isArray(payload.feature.runs)).toBe(true)
  })

  test('tools/call list_runs returns agent runs', async ({ request }) => {
    const payload = await callTool<{
      runs: Array<{ id: string; agent: string; status: string }>
    }>(request, 'list_runs')
    expect(Array.isArray(payload.runs)).toBe(true)
    expect(payload.runs.length).toBeGreaterThanOrEqual(1)

    const run = payload.runs[0]
    expect(run.id).toBeTruthy()
    expect(run).toHaveProperty('status')
    expect(run).toHaveProperty('agent')
  })

  test('list_runs filtered by status only returns that status', async ({ request }) => {
    const all = await callTool<{ runs: Array<{ status: string }> }>(request, 'list_runs')
    const status = all.runs[0]?.status
    expect(status, 'need at least one run with a status').toBeTruthy()

    const scoped = await callTool<{ runs: Array<{ status: string }> }>(request, 'list_runs', {
      status,
    })
    for (const run of scoped.runs) {
      expect(run.status).toBe(status)
    }
  })
})
