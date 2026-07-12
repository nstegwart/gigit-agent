// Cairn MCP endpoint — spec-compliant Streamable HTTP (MCP 2025-06-18) over the
// Web-standard Request/Response transport. Stateless + JSON responses: every POST is
// handled independently (no session state to persist), so it works in SSR/serverless
// and any MCP client (Claude Desktop, Cursor, mcp-remote) can connect to /mcp.
//
// Tools/resources are registered in src/server/board-mcp.ts.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createFileRoute } from '@tanstack/react-router'

import { registerBoardTools } from '#/server/board-mcp'
import { envVar } from '#/server/db'

const SERVER_NAME = 'cairn-board'
const SERVER_VERSION = '1.2.0'

// Tools that mutate state — require a token when CAIRN_WRITE_TOKEN is configured.
const WRITE_TOOLS = new Set([
  'create_board', 'toggle_task', 'set_feature_phase', 'upsert_run', 'set_run_status',
  'add_comment', 'open_decision', 'set_blocked', 'set_project_design', 'add_component',
  'upsert_task', 'delete_task', 'upsert_feature', 'delete_feature', 'set_prod', 'set_guide',
  'replace_accounts', 'replace_board_snapshot', 'set_lifecycle', 'advance_task',
  'add_task_section', 'set_task_sections', 'update_task_section', 'remove_task_section',
  'init_lifecycle', 'upsert_project', 'delete_project', 'update_board', 'delete_board',
  'decide_decision', 'set_queue',
])
function rpcError(status: number, message: string): Response {
  return new Response(JSON.stringify({ jsonrpc: '2.0', id: null, error: { code: -32001, message } }), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}
/** Returns the request to forward (body preserved), or an error Response if a write is unauthorized. */
async function authGate(request: Request): Promise<Request | Response> {
  if (request.method !== 'POST') return request
  const token = envVar('CAIRN_WRITE_TOKEN')
  if (!token) return request // no token configured → open (dev)
  const body = await request.text()
  let isWrite = false
  try {
    const parsed = JSON.parse(body)
    const msgs = Array.isArray(parsed) ? parsed : [parsed]
    isWrite = msgs.some((m) => m?.method === 'tools/call' && WRITE_TOOLS.has(m?.params?.name))
  } catch {
    /* not JSON — let the transport reject it */
  }
  if (isWrite && request.headers.get('x-cairn-token') !== token) {
    return rpcError(401, 'write tools require a valid X-Cairn-Token header')
  }
  return new Request(request.url, { method: 'POST', headers: request.headers, body })
}

async function handle(request: Request): Promise<Response> {
  const gated = await authGate(request)
  if (gated instanceof Response) return gated
  request = gated
  // Fresh transport + server per request = fully stateless. Tool registration is cheap.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id
    enableJsonResponse: true, // return JSON, not an SSE stream
  })
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerBoardTools(server)
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    // stateless JSON response is fully buffered before return → safe to release.
    void transport.close()
    void server.close()
  }
}

export const Route = createFileRoute('/mcp')({
  server: {
    handlers: {
      POST: ({ request }) => handle(request),
      GET: ({ request }) => handle(request),
      DELETE: ({ request }) => handle(request),
    },
  },
})
