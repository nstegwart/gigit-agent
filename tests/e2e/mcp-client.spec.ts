// Real MCP client conformance — connects to /mcp with the official SDK client
// (StreamableHTTPClientTransport), exactly like Claude Desktop / Cursor would, and
// exercises the full handshake + tools + resources. Proves Cairn is a real MCP server,
// not just a JSON endpoint.
//
// Auth: process-local CAIRN_MCP_BEARER from ensureAuthSecretsInEnv / secrets sidecar
// (run-scoped). Wired via transport requestInit — never logged.
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import { expect, test } from '@playwright/test'

import {
  loadSecretsSidecar,
  mcpAuthHeaders,
} from '../../qa/e2e/lib/auth-fixture.mjs'

function resolveMcpUrl(): string {
  const base = (
    process.env.WEB_BASE?.trim() ||
    `http://127.0.0.1:${process.env.PORT || 3210}`
  ).replace(/\/$/, '')
  return `${base}/mcp`
}

/**
 * Connect SDK transport with Bearer from process-local fixture.
 * Does not log the token (headers applied opaquely to requestInit).
 */
async function connect() {
  loadSecretsSidecar()
  const headers = mcpAuthHeaders()
  const client = new Client({ name: 'cairn-e2e', version: '1.0.0' })
  const transport = new StreamableHTTPClientTransport(new URL(resolveMcpUrl()), {
    requestInit: { headers },
  })
  await client.connect(transport)
  return { client, transport }
}

/** call a tool and JSON-parse its first text content block */
async function callJson(
  client: Client,
  name: string,
  args: Record<string, unknown> = {},
): Promise<Record<string, unknown>> {
  const res = (await client.callTool({ name, arguments: args })) as {
    content: Array<{ type: string; text?: string }>
  }
  return JSON.parse(res.content[0]?.text ?? '{}')
}

test('MCP client handshake + serverInfo', async () => {
  const { client, transport } = await connect()
  expect(client.getServerVersion()?.name).toBe('cairn-board')
  expect(client.getServerCapabilities()?.tools).toBeTruthy()
  await transport.close()
})

test('MCP client lists all board tools with schemas', async () => {
  const { client, transport } = await connect()
  const { tools } = await client.listTools()
  const names = tools.map((t) => t.name)
  for (const t of [
    'list_boards', 'list_projects', 'list_features', 'get_feature', 'list_queue',
    'toggle_task', 'upsert_run', 'get_conventions', 'get_workspace', 'open_decision',
    'list_tasks', 'get_task', 'list_accounts', 'get_prod', 'get_guide',
  ]) {
    expect(names, `tool ${t}`).toContain(t)
  }
  for (const t of tools) {
    expect(t.description, `${t.name} description`).toBeTruthy()
    expect(t.inputSchema, `${t.name} inputSchema`).toBeTruthy()
  }
  await transport.close()
})

test('MCP client calls tools (boardId-scoped) and reads the playbook resource', async () => {
  const { client, transport } = await connect()

  const boards = await callJson(client, 'list_boards')
  expect((boards.boards as Array<unknown>).length).toBeGreaterThanOrEqual(2)

  const feats = await callJson(client, 'list_features', { boardId: 'ibils', projectId: 'ibils-business' })
  expect((feats.features as Array<unknown>).length).toBe(16)

  const ws = await callJson(client, 'get_workspace', { boardId: 'ibils', featureId: 'f4-m2-produk' })
  expect(String(ws.branch)).toContain('feature/')
  expect(String(ws.worktree)).toContain('worktrees/')

  const tasks = await callJson(client, 'list_tasks', { boardId: 'mfs-rebuild' })
  expect((tasks.tasks as Array<unknown>).length).toBeGreaterThanOrEqual(40)

  const { resources } = await client.listResources()
  expect(resources.map((r) => r.uri)).toContain('cairn://playbook')
  const read = (await client.readResource({ uri: 'cairn://playbook' })) as {
    contents: Array<{ text?: string }>
  }
  expect(read.contents[0]?.text ?? '').toContain('branch')

  await transport.close()
})
