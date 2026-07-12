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

const SERVER_NAME = 'cairn-board'
const SERVER_VERSION = '1.1.0'

async function handle(request: Request): Promise<Response> {
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
