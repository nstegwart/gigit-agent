// E2E for the batch-2 additions to the /mcp JSON-RPC endpoint: agent-knowledge
// tools (get_conventions, get_workspace, get_design), collaboration tools
// (add_comment, open_decision, list_activity), and the cairn://playbook
// resource. Only non-mutating calls are exercised (tools/list + resources/list
// advertise the new names; tools/call is only exercised for the read-only
// get_conventions / get_workspace tools) — nothing here writes to
// data/plan.json or data/collab.json, so there is nothing to restore.
import { expect, test, type APIRequestContext } from '@playwright/test'

type ToolContent = { type: string; text: string }
type RpcResult = {
  jsonrpc?: string
  id?: number | string | null
  result?: {
    tools?: Array<{ name: string; description?: string }>
    resources?: Array<{ uri: string; name?: string; description?: string; mimeType?: string }>
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

test.describe('/mcp batch-2 tools', () => {
  test('tools/list advertises the batch-2 agent-knowledge and collab tools', async ({
    request,
  }) => {
    const body = await rpc(request, { jsonrpc: '2.0', id: 1, method: 'tools/list' })
    const tools = body.result?.tools
    expect(Array.isArray(tools)).toBe(true)

    const names = (tools ?? []).map((t) => t.name)
    for (const expected of [
      'get_conventions',
      'get_workspace',
      'get_design',
      'add_comment',
      'open_decision',
      'list_activity',
    ]) {
      expect(names, `tools/list should expose ${expected}`).toContain(expected)
    }
  })

  test('resources/list advertises the cairn://playbook resource', async ({ request }) => {
    const body = await rpc(request, { jsonrpc: '2.0', id: 1, method: 'resources/list' })
    const resources = body.result?.resources
    expect(Array.isArray(resources)).toBe(true)

    const uris = (resources ?? []).map((r) => r.uri)
    expect(uris, 'resources/list should expose cairn://playbook').toContain('cairn://playbook')
  })

  test('tools/call get_conventions returns usage steps', async ({ request }) => {
    const payload = await callTool<{ usage?: string[] }>(request, 'get_conventions')
    expect(Array.isArray(payload.usage)).toBe(true)
    expect(payload.usage?.length ?? 0).toBeGreaterThanOrEqual(1)
    for (const step of payload.usage ?? []) {
      expect(typeof step).toBe('string')
      expect(step.length).toBeGreaterThan(0)
    }
  })

  test('tools/call get_workspace returns a feature/ branch and a worktrees/ path', async ({
    request,
  }) => {
    const payload = await callTool<{
      featureId: string
      branch: string
      worktree: string
      repo?: string
    }>(request, 'get_workspace', { featureId: 'f4-m2-produk' })

    expect(payload.featureId).toBe('f4-m2-produk')
    expect(payload.branch).toContain('feature/')
    expect(payload.worktree).toContain('worktrees/')
  })
})
