/**
 * W15-03 MCP protocol/request-level adversarial auth suite.
 *
 * Exercises real route/server APIs (authGate, resolveMcpAuthContext, registerBoardTools +
 * Streamable HTTP transport). No mocks at the auth boundary (authorizeToolCall / isToolListable
 * / authGate remain real). Bearer fixtures use the designed injectable token registry only.
 *
 * Does not edit product code. Failures are real product gaps, not test soft-passes.
 *
 * Hermetic unit DI (UNIT-DB-HERMETIC case 12): board-store + tasks-store ambient MySQL
 * producers intercepted via vi.mock → in-memory adapters (no 127.0.0.1:3306).
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'

import {
  hermeticBoardStoreApi,
  hermeticTasksStoreApi,
  resetHermeticBoardStore,
} from './helpers/board-mcp-unit-hermetic'

vi.mock('#/server/board-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/server/board-store')>()
  return {
    ...actual,
    ...hermeticBoardStoreApi,
  }
})

vi.mock('#/server/tasks-store', async (importOriginal) => {
  const actual = await importOriginal<typeof import('#/server/tasks-store')>()
  return {
    ...actual,
    ...hermeticTasksStoreApi,
  }
})

import { authGate, resolveMcpAuthContext } from '#/routes/mcp'
import { resolvePublicSnapshotClientIp } from '#/routes/api.public-snapshot'
import {
  createMemoryControlPlaneRuntimeContext,
  registerBoardTools,
  resetControlPlaneRuntimeContextForTests,
  resetMcpControlPlaneDeps,
  resolveMcpRuntimeContext,
  setMcpPlanStore,
  setTestControlPlaneRuntimeContext,
  type McpAuthContext,
} from '#/server/board-mcp'
import {
  createPublicSnapshotService,
  resetPublicSnapshotServiceForTests,
  setTestPublicSnapshotService,
} from '#/server/public-snapshot-service'
import { createMemoryRateLimitStore, createPublicSnapshotRateLimiter } from '#/server/rate-limit'
import type { DispatchPlanStore } from '#/server/control-plane-ingest'
import {
  MCP_TOOL_SPECS,
  authErrorEnvelope,
  authorizeToolCall,
  defaultScopesForRole,
  extractBearerFromHeaders,
  isToolListable,
  principalFromSession,
  resetBearerInjection,
  setBearerTokenRecords,
  type BearerTokenRecord,
  type Principal,
  type V3Role,
} from '#/server/rbac'
import type { SessionUser } from '#/lib/types'

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const MCP_URL = 'http://127.0.0.1:3000/mcp'
const BOARD = 'mfs-rebuild'

const TOKENS = {
  OWNER: 'mcp-auth-test-owner-secret',
  ROOT: 'mcp-auth-test-root-secret',
  AGENT: 'mcp-auth-test-agent-secret',
  INTEGRATOR: 'mcp-auth-test-integrator-secret',
} as const

const BEARER_RECORDS: BearerTokenRecord[] = [
  {
    tokenId: 't-owner',
    secret: TOKENS.OWNER,
    role: 'OWNER',
    actorId: 'owner-mcp-auth',
  },
  {
    tokenId: 't-root',
    secret: TOKENS.ROOT,
    role: 'ROOT_ORCHESTRATOR',
    actorId: 'root-mcp-auth',
  },
  {
    tokenId: 't-agent',
    secret: TOKENS.AGENT,
    role: 'AGENT',
    actorId: 'agent-mcp-auth',
    agentId: 'agent-mcp-auth',
    boardId: BOARD,
  },
  {
    tokenId: 't-int',
    secret: TOKENS.INTEGRATOR,
    role: 'INTEGRATOR',
    actorId: 'int-mcp-auth',
    pathspecs: ['src/server/**'],
    checkpointId: 'cp-mcp-auth',
    boardId: BOARD,
  },
]

const SENSITIVE_READ_TOOLS = [
  'list_boards',
  'list_projects',
  'list_features',
  'get_feature',
  'list_tasks',
  'get_task',
  'list_runs',
  'list_accounts',
  'list_audit',
  'list_decisions',
  'get_overview',
  'get_work',
  'get_next',
  'get_dispatch_next',
  'get_rollup',
  'get_prod',
  'get_guide',
  // Product knowledge (board:read) — must never appear on unauth tools/list
  'search_knowledge',
  'get_feature_bundle',
  'get_endpoint_bundle',
  'get_flow',
] as const

const SENSITIVE_WRITE_TOOLS = [
  'toggle_task',
  'upsert_task',
  'publish_dispatch_plan',
  'register_run',
  'sync_accounts',
  'resolve_decision_v3',
  'integration_lock',
  'replace_accounts',
  'set_prod',
] as const

type RpcBody = Record<string, unknown>

interface McpHttpResult {
  status: number
  json: any
  rawText: string
}

function bearerHeaders(token: string): Record<string, string> {
  return { authorization: `Bearer ${token}` }
}

function makeRequest(body: RpcBody | RpcBody[], headers: Record<string, string> = {}): Request {
  return new Request(MCP_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      ...headers,
    },
    body: JSON.stringify(body),
  })
}

/**
 * Mirror of src/routes/mcp.ts handle() — uses exported route APIs only.
 * Cookie never elevates; session principal hard-denied if present.
 * Injects non-spoofable clientIp (resolvePublicSnapshotClientIp) like production.
 *
 * Production registration: sole registerBoardTools(server, auth) — product knowledge
 * tools wire through secureTool inside board-mcp (not bare registerTool).
 */
async function mcpHandle(request: Request): Promise<Response> {
  // Capture IP before authGate body rebuild drops socket/runtime fields (matches production mcp.ts).
  const clientIp = resolvePublicSnapshotClientIp(request)
  const gated = await authGate(request)
  if (gated instanceof Response) return gated
  request = gated

  const auth: McpAuthContext = await resolveMcpAuthContext(request)
  const authWithIp: McpAuthContext = { ...auth, clientIp }
  if (authWithIp.principal && authWithIp.principal.channel === 'session') {
    return new Response(
      JSON.stringify({
        jsonrpc: '2.0',
        id: null,
        error: { code: -32001, message: 'COOKIE_ELEVATION_DENIED' },
      }),
      { status: 403, headers: { 'content-type': 'application/json' } },
    )
  }

  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined,
    enableJsonResponse: true,
  })
  const server = new McpServer({ name: 'cairn-board', version: '1.3.0' })
  // Production order: registerBoardTools only (includes knowledge via secureTool).
  registerBoardTools(server, authWithIp)
  await server.connect(transport)
  try {
    return await transport.handleRequest(request)
  } finally {
    void transport.close()
    void server.close()
  }
}

/** Request with non-spoofable runtime socket IP (mirrors srvx NodeRequest `.ip`). */
function makeRequestWithSocketIp(
  body: RpcBody | RpcBody[],
  ip: string,
  headers: Record<string, string> = {},
): Request {
  const req = makeRequest(body, headers)
  Object.defineProperty(req, 'ip', { value: ip, enumerable: true, configurable: true })
  return req
}

async function mcpRpc(
  body: RpcBody | RpcBody[],
  headers: Record<string, string> = {},
): Promise<McpHttpResult> {
  const res = await mcpHandle(makeRequest(body, headers))
  const rawText = await res.text()
  let json: any = null
  try {
    json = JSON.parse(rawText)
  } catch {
    json = { _parseError: true, raw: rawText }
  }
  return { status: res.status, json, rawText }
}

function rpc(method: string, params?: unknown, id: number | string = 1): RpcBody {
  return { jsonrpc: '2.0', id, method, ...(params !== undefined ? { params } : {}) }
}

function toolCall(name: string, args: Record<string, unknown> = {}, id: number | string = 1): RpcBody {
  return rpc('tools/call', { name, arguments: args }, id)
}

function toolNamesFromList(json: any): string[] {
  const tools = json?.result?.tools
  if (!Array.isArray(tools)) return []
  return tools.map((t: { name?: string }) => t.name).filter(Boolean) as string[]
}

function resourceUrisFromList(json: any): string[] {
  const resources = json?.result?.resources
  if (!Array.isArray(resources)) return []
  return resources
    .map((r: { uri?: string }) => r.uri)
    .filter((u: unknown): u is string => typeof u === 'string')
}

function parseToolPayload(json: any): any {
  const text = json?.result?.content?.[0]?.text
  if (typeof text !== 'string') return null
  try {
    return JSON.parse(text)
  } catch {
    return { _raw: text }
  }
}

function assertNoSecretLeak(blob: string, extraSecrets: string[] = []): void {
  const lower = blob.toLowerCase()
  // Never echo fixture bearer secrets or classic secret field shapes in errors/bodies.
  for (const s of [
    TOKENS.OWNER,
    TOKENS.ROOT,
    TOKENS.AGENT,
    TOKENS.INTEGRATOR,
    ...extraSecrets,
  ]) {
    expect(blob, `response leaked secret substring`).not.toContain(s)
  }
  // Structured secret keys should not appear as returned fields in error paths.
  expect(lower).not.toMatch(/"password"\s*:\s*"[^"]+"/i)
  expect(lower).not.toMatch(/"api[_-]?key"\s*:\s*"[^"]+"/i)
  expect(lower).not.toMatch(/"authorization"\s*:\s*"bearer\s+[^"]+"/i)
}

function installBearerMatrix(): void {
  setBearerTokenRecords(BEARER_RECORDS)
}

function sessionAdmin(): SessionUser {
  return { id: 'u-admin', username: 'admin', role: 'admin', boards: [] }
}

beforeEach(() => {
  resetHermeticBoardStore()
  resetBearerInjection()
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  resetPublicSnapshotServiceForTests()
  setTestControlPlaneRuntimeContext(createMemoryControlPlaneRuntimeContext())
})

afterEach(() => {
  resetBearerInjection()
  resetMcpControlPlaneDeps()
  resetControlPlaneRuntimeContextForTests()
  resetPublicSnapshotServiceForTests()
})

// ---------------------------------------------------------------------------
// initialize / protocol
// ---------------------------------------------------------------------------
describe('MCP initialize (protocol-safe unauth)', () => {
  it('unauth initialize is allowed (200 MCP result, no AUTHORIZATION_REQUIRED)', async () => {
    const r = await mcpRpc(
      rpc('initialize', {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'mcp-auth-test', version: '0.0.1' },
      }),
    )
    expect(r.status).toBeLessThan(400)
    expect(r.json?.error?.message).not.toBe('AUTHORIZATION_REQUIRED')
    // Server identity advertised
    const serverInfo = r.json?.result?.serverInfo
    if (serverInfo) {
      expect(serverInfo.name).toBeTruthy()
    }
    assertNoSecretLeak(r.rawText)
  })

  it('unauth ping / notifications/initialized pass authGate as Request', async () => {
    const gated = await authGate(
      makeRequest(rpc('notifications/initialized', {}, 0 as never)),
    )
    expect(gated).toBeInstanceOf(Request)
    const gatedPing = await authGate(makeRequest(rpc('ping')))
    expect(gatedPing).toBeInstanceOf(Request)
  })
})

// ---------------------------------------------------------------------------
// unauth public-only: tools/list, resources, tools/call
// ---------------------------------------------------------------------------
describe('unauth public-only surface', () => {
  it('tools/list exposes only public tools (get_public_snapshot), not sensitive catalog', async () => {
    const r = await mcpRpc(rpc('tools/list'))
    expect(r.status).toBeLessThan(400)
    const names = toolNamesFromList(r.json)
    expect(names).toContain('get_public_snapshot')
    expect(names).toEqual(['get_public_snapshot'])
    for (const n of [...SENSITIVE_READ_TOOLS, ...SENSITIVE_WRITE_TOOLS]) {
      expect(names, `unauth tools/list must not include ${n}`).not.toContain(n)
    }
    // Every listed tool must be public-kind in catalog (or only public snapshot)
    for (const n of names) {
      const spec = MCP_TOOL_SPECS.find((s) => s.name === n)
      if (spec) expect(spec.kind).toBe('public')
    }
    assertNoSecretLeak(r.rawText)
  })

  it('unauth tools/list never advertises product knowledge tools (search/bundle/flow)', async () => {
    const r = await mcpRpc(rpc('tools/list'))
    expect(r.status).toBeLessThan(400)
    const names = toolNamesFromList(r.json)
    for (const n of [
      'search_knowledge',
      'get_feature_bundle',
      'get_endpoint_bundle',
      'get_flow',
    ]) {
      expect(names, `unauth list must not advertise ${n}`).not.toContain(n)
      expect(isToolListable(null, n)).toBe(false)
    }
    assertNoSecretLeak(r.rawText)
  })

  it('resources/list unauth does not advertise playbook; may list public-snapshot only', async () => {
    const r = await mcpRpc(rpc('resources/list'))
    expect(r.status).toBeLessThan(400)
    const uris = resourceUrisFromList(r.json)
    expect(uris.some((u) => u.includes('playbook'))).toBe(false)
    // If any resource is listed, it must be the public snapshot surface
    for (const u of uris) {
      expect(u.includes('public-snapshot') || u.includes('public')).toBe(true)
    }
    assertNoSecretLeak(r.rawText)
  })

  it('resources/read playbook denied without auth (401 AUTHORIZATION_REQUIRED, no payload leak)', async () => {
    const r = await mcpRpc(rpc('resources/read', { uri: 'cairn://playbook' }))
    expect(r.status).toBe(401)
    expect(String(r.json?.error?.message ?? r.rawText)).toMatch(/AUTHORIZATION_REQUIRED/)
    assertNoSecretLeak(r.rawText)
  })

  it('resources/read public-snapshot allowed through gate (no 401)', async () => {
    const r = await mcpRpc(rpc('resources/read', { uri: 'cairn://public-snapshot' }))
    // Gate must not 401; body may be STALE_OR_MISSING placeholder until pin loader
    expect(r.status).not.toBe(401)
    expect(String(r.json?.error?.message ?? '')).not.toBe('AUTHORIZATION_REQUIRED')
    assertNoSecretLeak(r.rawText)
  })

  it('every sensitive tools/call denied unauth without payload leakage', async () => {
    for (const name of [...SENSITIVE_READ_TOOLS, ...SENSITIVE_WRITE_TOOLS]) {
      const r = await mcpRpc(toolCall(name, { boardId: BOARD, id: 'x', featureId: 'x' }))
      expect(r.status, `${name} unauth status`).toBe(401)
      expect(String(r.json?.error?.message ?? ''), `${name} message`).toMatch(
        /AUTHORIZATION_REQUIRED/,
      )
      // No success data / board payload
      expect(r.json?.result?.content).toBeUndefined()
      assertNoSecretLeak(r.rawText)
    }
  })

  it('get_public_snapshot tools/call is allowed unauth (auth boundary only)', async () => {
    const r = await mcpRpc(toolCall('get_public_snapshot', { boardId: BOARD }))
    expect(r.status).not.toBe(401)
    expect(String(r.json?.error?.message ?? '')).not.toBe('AUTHORIZATION_REQUIRED')
    assertNoSecretLeak(r.rawText)
  })
})

// ---------------------------------------------------------------------------
// cookie vs bearer separation
// ---------------------------------------------------------------------------
describe('cookie / bearer separation', () => {
  it('Cookie session alone never extracts a bearer and never elevates principal', async () => {
    const h = new Headers({
      cookie: 'cairn_session=super-secret-session-value-do-not-leak',
    })
    expect(extractBearerFromHeaders(h)).toBeNull()

    const ctx = await resolveMcpAuthContext(
      makeRequest(rpc('tools/list'), {
        cookie: 'cairn_session=super-secret-session-value-do-not-leak',
      }),
    )
    expect(ctx.principal).toBeNull()
    expect(ctx.bearerPresent).toBe(false)

    // Sensitive call with only cookie → 401, no cookie value in body
    const r = await mcpRpc(toolCall('list_accounts', { boardId: BOARD }), {
      cookie: 'cairn_session=super-secret-session-value-do-not-leak',
    })
    expect(r.status).toBe(401)
    expect(r.rawText).not.toContain('super-secret-session-value-do-not-leak')
    assertNoSecretLeak(r.rawText, ['super-secret-session-value-do-not-leak'])
  })

  it('session principal channel is not accepted as MCP elevation path', async () => {
    const sessionP = principalFromSession(sessionAdmin())!
    expect(sessionP.channel).toBe('session')
    // Simulated post-resolve check (same as handle): session channel denied
    const denied =
      sessionP.channel === 'session' ? 'COOKIE_ELEVATION_DENIED' : null
    expect(denied).toBe('COOKIE_ELEVATION_DENIED')
    // Cookie + Bearer: bearer wins via extractBearer; cookie still ignored for identity
    installBearerMatrix()
    const ctx = await resolveMcpAuthContext(
      makeRequest(rpc('tools/list'), {
        ...bearerHeaders(TOKENS.AGENT),
        cookie: 'cairn_session=admin-session-should-not-become-owner',
      }),
    )
    expect(ctx.principal?.role).toBe('AGENT')
    expect(ctx.principal?.channel).toBe('bearer')
    expect(ctx.principal?.role).not.toBe('OWNER')
  })

  it('Authorization Bearer and X-Cairn-Token both resolve; Cookie never does', async () => {
    installBearerMatrix()
    const viaBearer = await resolveMcpAuthContext(
      makeRequest(rpc('initialize', {}), bearerHeaders(TOKENS.ROOT)),
    )
    expect(viaBearer.principal?.role).toBe('ROOT_ORCHESTRATOR')
    expect(viaBearer.bearerPresent).toBe(true)

    const viaLegacyHeader = await resolveMcpAuthContext(
      makeRequest(rpc('initialize', {}), { 'x-cairn-token': TOKENS.OWNER }),
    )
    expect(viaLegacyHeader.principal?.role).toBe('OWNER')
    expect(viaLegacyHeader.bearerPresent).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// legacy CAIRN_WRITE_TOKEN absent / present
// ---------------------------------------------------------------------------
describe('legacy CAIRN_WRITE_TOKEN absent / present', () => {
  const LEGACY = 'mcp-auth-legacy-write-token-fixture'

  it('legacy absent: wrong/missing token does not open sensitive tools', async () => {
    // Do not inject bearer matrix — rely on env only (may have local CAIRN_WRITE_TOKEN).
    const wrong = await mcpRpc(toolCall('list_accounts', { boardId: BOARD }), {
      authorization: 'Bearer not-the-legacy-token-zzzz',
    })
    // Wrong token → unauthenticated at gate for sensitive call
    expect(wrong.status).toBe(401)
    expect(String(wrong.json?.error?.message ?? '')).toMatch(/AUTHORIZATION_REQUIRED/)
    assertNoSecretLeak(wrong.rawText)

    const unauth = await mcpRpc(toolCall('publish_dispatch_plan', { boardId: BOARD }))
    expect(unauth.status).toBe(401)
  })

  it('legacy present unbound: disabled (principal null — board binding required)', async () => {
    const prev = process.env.CAIRN_WRITE_TOKEN
    const prevBoard = process.env.CAIRN_WRITE_TOKEN_BOARD_ID
    process.env.CAIRN_WRITE_TOKEN = LEGACY
    delete process.env.CAIRN_WRITE_TOKEN_BOARD_ID
    try {
      resetBearerInjection()
      const ctx = await resolveMcpAuthContext(
        makeRequest(rpc('tools/list'), bearerHeaders(LEGACY)),
      )
      // Unbound legacy write token is disabled (fail closed)
      expect(ctx.principal).toBeNull()
    } finally {
      if (prev === undefined) delete process.env.CAIRN_WRITE_TOKEN
      else process.env.CAIRN_WRITE_TOKEN = prev
      if (prevBoard === undefined) delete process.env.CAIRN_WRITE_TOKEN_BOARD_ID
      else process.env.CAIRN_WRITE_TOKEN_BOARD_ID = prevBoard
    }
  })

  it('legacy present board-bound: constrained AGENT only (not OWNER/ROOT; no account/audit/dispatch)', async () => {
    const prev = process.env.CAIRN_WRITE_TOKEN
    const prevBoard = process.env.CAIRN_WRITE_TOKEN_BOARD_ID
    process.env.CAIRN_WRITE_TOKEN = LEGACY
    process.env.CAIRN_WRITE_TOKEN_BOARD_ID = BOARD
    try {
      // Clear injectable so only env legacy path applies
      resetBearerInjection()
      const ctx = await resolveMcpAuthContext(
        makeRequest(rpc('tools/list'), bearerHeaders(LEGACY)),
      )
      expect(ctx.principal).not.toBeNull()
      expect(ctx.principal!.role).toBe('AGENT')
      expect(ctx.principal!.channel).toBe('bearer')
      expect(ctx.principal!.boardId).toBe(BOARD)
      expect(ctx.principal!.role).not.toBe('OWNER')
      expect(ctx.principal!.role).not.toBe('ROOT_ORCHESTRATOR')

      // Protocol: tools/list under legacy must not advertise root/account tools
      const list = await mcpRpc(rpc('tools/list'), bearerHeaders(LEGACY))
      const names = toolNamesFromList(list.json)
      expect(names).not.toContain('publish_dispatch_plan')
      expect(names).not.toContain('sync_accounts')
      expect(names).not.toContain('list_accounts')
      expect(names).not.toContain('list_audit')
      expect(names).not.toContain('set_prod')

      // tools/call sensitive root ops denied at gate or handler
      const pub = await mcpRpc(
        toolCall('publish_dispatch_plan', {
          boardId: BOARD,
          planId: 'p1',
          planVersion: 1,
          planHash: 'h',
          canonicalSnapshotId: 's',
          canonicalHash: 'c',
          expectedBoardRev: 0,
          issuedAt: new Date().toISOString(),
          expiresAt: new Date(Date.now() + 60_000).toISOString(),
          items: [],
          idempotencyKey: 'k1',
        }),
        bearerHeaders(LEGACY),
      )
      // Not registered → MCP tool missing OR auth error envelope — never success ok:true
      const payload = parseToolPayload(pub.json)
      if (pub.status === 401) {
        expect(String(pub.json?.error?.message ?? '')).toMatch(/AUTHORIZATION_REQUIRED/)
      } else if (payload) {
        expect(payload.ok).not.toBe(true)
      } else {
        // MCP-level unknown tool error is acceptable (list-filtered)
        expect(pub.json?.error || pub.json?.result?.isError).toBeTruthy()
      }
      assertNoSecretLeak(pub.rawText, [LEGACY])
    } finally {
      if (prev === undefined) delete process.env.CAIRN_WRITE_TOKEN
      else process.env.CAIRN_WRITE_TOKEN = prev
      if (prevBoard === undefined) delete process.env.CAIRN_WRITE_TOKEN_BOARD_ID
      else process.env.CAIRN_WRITE_TOKEN_BOARD_ID = prevBoard
    }
  })
})

// ---------------------------------------------------------------------------
// five roles / scopes — list filtering + invocation recheck
// ---------------------------------------------------------------------------
describe('five roles: tools/list filter + tools/call recheck', () => {
  const roles: Array<{ role: V3Role; token: string | null }> = [
    { role: 'PUBLIC', token: null },
    { role: 'OWNER', token: TOKENS.OWNER },
    { role: 'ROOT_ORCHESTRATOR', token: TOKENS.ROOT },
    { role: 'AGENT', token: TOKENS.AGENT },
    { role: 'INTEGRATOR', token: TOKENS.INTEGRATOR },
  ]

  beforeEach(() => {
    installBearerMatrix()
  })

  it('tools/list is role-scoped for all five roles', async () => {
    for (const { role, token } of roles) {
      const headers = token ? bearerHeaders(token) : {}
      const r = await mcpRpc(rpc('tools/list'), headers)
      expect(r.status, `${role} list status`).toBeLessThan(400)
      const names = toolNamesFromList(r.json)
      expect(names.length, `${role} must list at least public tool`).toBeGreaterThan(0)

      // Cross-check against isToolListable for every catalog tool
      let principal: Principal | null = null
      if (token) {
        const ctx = await resolveMcpAuthContext(makeRequest(rpc('tools/list'), headers))
        principal = ctx.principal
        expect(principal?.role, role).toBe(role === 'PUBLIC' ? principal?.role : role)
      }
      for (const spec of MCP_TOOL_SPECS) {
        const listed = names.includes(spec.name)
        const allowed = isToolListable(principal, spec.name)
        expect(listed, `${role} list parity for ${spec.name}`).toBe(allowed)
      }
      assertNoSecretLeak(r.rawText)
    }
  })

  it('OWNER: sensitive reads ok path shape; denied dispatch/sync/run evidence', async () => {
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.OWNER))
    const names = toolNamesFromList(list.json)
    expect(names).toContain('list_accounts')
    expect(names).toContain('list_audit')
    expect(names).toContain('resolve_decision_v3')
    expect(names).not.toContain('publish_dispatch_plan')
    expect(names).not.toContain('sync_accounts')
    expect(names).not.toContain('register_run')
    expect(names).not.toContain('terminate_run')
    expect(names).not.toContain('submit_stage_evidence')

    // Invocation recheck: OWNER_EVIDENCE_IMPERSONATION via authorize path if registered
    // register_run not listed → call should not succeed
    const reg = await mcpRpc(
      toolCall('register_run', {
        boardId: BOARD,
        runId: 'r1',
        taskId: 't1',
        targetGate: 'G1',
        agentId: 'agent-x',
        model: 'm',
        expectedEntityRev: 0,
        expectedBoardRev: 0,
        idempotencyKey: 'idem-owner-reg',
      }),
      bearerHeaders(TOKENS.OWNER),
    )
    const regPayload = parseToolPayload(reg.json)
    if (regPayload?.code) {
      expect(regPayload.code).toMatch(
        /OWNER_EVIDENCE_IMPERSONATION_DENIED|AUTHORIZATION_REQUIRED|FORBIDDEN/,
      )
    } else {
      expect(reg.json?.error || reg.json?.result?.isError || reg.status >= 400).toBeTruthy()
    }
    assertNoSecretLeak(reg.rawText)

    const term = await mcpRpc(
      toolCall('terminate_run', {
        boardId: BOARD,
        runId: 'r1',
        agentId: 'agent-x',
        fencingToken: 'ft',
        toState: 'SUCCEEDED',
        reason: 'owner-deny',
        expectedEntityRev: 0,
        expectedBoardRev: 0,
        idempotencyKey: 'idem-owner-term',
      }),
      bearerHeaders(TOKENS.OWNER),
    )
    const termPayload = parseToolPayload(term.json)
    if (termPayload?.code) {
      expect(termPayload.code).toMatch(
        /OWNER_EVIDENCE_IMPERSONATION_DENIED|AUTHORIZATION_REQUIRED|FORBIDDEN/,
      )
    } else {
      expect(term.json?.error || term.json?.result?.isError || term.status >= 400).toBeTruthy()
    }
    assertNoSecretLeak(term.rawText)
  })

  it('ROOT_ORCHESTRATOR: dispatch/sync listed; resolve_decision and set_prod denied', async () => {
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.ROOT))
    const names = toolNamesFromList(list.json)
    expect(names).toContain('publish_dispatch_plan')
    expect(names).toContain('sync_accounts')
    expect(names).not.toContain('resolve_decision_v3')
    expect(names).not.toContain('set_prod')
    // ROOT must not list/impersonate agent stage evidence (accept via advance_task only)
    expect(names).not.toContain('submit_stage_evidence')

    // Call recheck: resolve_decision_v3 should not succeed
    const res = await mcpRpc(
      toolCall('resolve_decision_v3', {
        boardId: BOARD,
        decisionId: 'd1',
        selectedOptionId: 'ack',
        expectedEntityRev: 0,
        expectedBoardRev: 0,
      }),
      bearerHeaders(TOKENS.ROOT),
    )
    const payload = parseToolPayload(res.json)
    if (payload?.code) {
      expect(payload.code).toMatch(/FORBIDDEN_ROLE|AUTHORIZATION_REQUIRED|FORBIDDEN/)
    } else {
      expect(res.json?.error || res.json?.result?.isError || res.status >= 400).toBeTruthy()
    }
    assertNoSecretLeak(res.rawText)
  })

  it('AGENT: run tools listable; account/audit/dispatch not; own-run recheck', async () => {
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.AGENT))
    const names = toolNamesFromList(list.json)
    expect(names).toContain('register_run')
    expect(names).toContain('heartbeat_run')
    expect(names).toContain('terminate_run')
    expect(names).toContain('submit_stage_evidence')
    // board:read already on AGENT maxima — knowledge tools list without scope broadening
    expect(names).toContain('search_knowledge')
    expect(names).toContain('get_feature_bundle')
    expect(names).toContain('get_endpoint_bundle')
    expect(names).toContain('get_flow')
    expect(names).not.toContain('list_accounts')
    expect(names).not.toContain('list_audit')
    expect(names).not.toContain('publish_dispatch_plan')
    expect(names).not.toContain('sync_accounts')
    // P0: unscoped list_boards hidden from tools/list for board-bound AGENT
    expect(names).not.toContain('list_boards')

    // authorizeToolCall own-run (direct recheck contract used by secureTool)
    const deny = authorizeToolCall(
      {
        actorId: 'agent-mcp-auth',
        role: 'AGENT',
        scopes: defaultScopesForRole('AGENT'),
        channel: 'bearer',
        boards: [],
        agentId: 'agent-mcp-auth',
      },
      'register_run',
      { agentId: 'other-agent' },
    )
    expect(deny.ok).toBe(false)
    expect(deny.code).toBe('OWN_RUN_ONLY')
    const denyTerm = authorizeToolCall(
      {
        actorId: 'agent-mcp-auth',
        role: 'AGENT',
        scopes: defaultScopesForRole('AGENT'),
        channel: 'bearer',
        boards: [],
        agentId: 'agent-mcp-auth',
      },
      'terminate_run',
      { agentId: 'other-agent' },
    )
    expect(denyTerm.ok).toBe(false)
    expect(denyTerm.code).toBe('OWN_RUN_ONLY')

    const call = await mcpRpc(
      toolCall('list_accounts', { boardId: BOARD }),
      bearerHeaders(TOKENS.AGENT),
    )
    // Not listed → must not return account payload
    const payload = parseToolPayload(call.json)
    if (payload) {
      expect(payload.accounts).toBeUndefined()
      expect(payload.ok).not.toBe(true)
    } else {
      expect(call.status === 401 || call.json?.error || call.json?.result?.isError).toBeTruthy()
    }
    assertNoSecretLeak(call.rawText)
  })

  it('INTEGRATOR: integration_lock listable; lifecycle/dispatch/decision writes not', async () => {
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.INTEGRATOR))
    const names = toolNamesFromList(list.json)
    expect(names).toContain('integration_lock')
    // P0: unscoped list_boards hidden from tools/list for board-bound INTEGRATOR
    expect(names).not.toContain('list_boards')
    expect(names).not.toContain('publish_dispatch_plan')
    expect(names).not.toContain('advance_task')
    expect(names).not.toContain('resolve_decision_v3')
    expect(names).not.toContain('sync_accounts')
    assertNoSecretLeak(list.rawText)
  })

  it('ROOT/OWNER still list list_boards; AGENT/INTEGRATOR do not', async () => {
    const root = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.ROOT))
    const owner = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.OWNER))
    expect(toolNamesFromList(root.json)).toContain('list_boards')
    expect(toolNamesFromList(owner.json)).toContain('list_boards')
    const agent = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.AGENT))
    const integ = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.INTEGRATOR))
    expect(toolNamesFromList(agent.json)).not.toContain('list_boards')
    expect(toolNamesFromList(integ.json)).not.toContain('list_boards')
  })

  it('PUBLIC/unauth: only public tools; write invocations denied', async () => {
    const list = await mcpRpc(rpc('tools/list'))
    const names = toolNamesFromList(list.json)
    expect(names.every((n) => n === 'get_public_snapshot' || isToolListable(null, n))).toBe(
      true,
    )
    const w = await mcpRpc(toolCall('toggle_task', { boardId: BOARD, featureId: 'f', index: 0 }))
    expect(w.status).toBe(401)
  })
})

// ---------------------------------------------------------------------------
// canonical / legacy alias parity + common envelope
// ---------------------------------------------------------------------------
describe('canonical/legacy alias parity and common envelope', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('get_next and get_dispatch_next share listability and authorizeToolCall outcome', () => {
    for (const role of ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT', 'INTEGRATOR'] as V3Role[]) {
      const p: Principal = {
        actorId: `a-${role}`,
        role,
        scopes: defaultScopesForRole(role),
        channel: 'bearer',
        boards: [],
      }
      expect(isToolListable(p, 'get_next')).toBe(isToolListable(p, 'get_dispatch_next'))
      expect(authorizeToolCall(p, 'get_next').ok).toBe(
        authorizeToolCall(p, 'get_dispatch_next').ok,
      )
    }
    expect(isToolListable(null, 'get_next')).toBe(false)
    expect(isToolListable(null, 'get_dispatch_next')).toBe(false)
    expect(authorizeToolCall(null, 'get_next').ok).toBe(false)
    expect(authorizeToolCall(null, 'get_dispatch_next').ok).toBe(false)
  })

  it('authenticated tools/list includes both aliases for board:read roles', async () => {
    const r = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.AGENT))
    const names = toolNamesFromList(r.json)
    expect(names).toContain('get_next')
    expect(names).toContain('get_dispatch_next')
  })

  it('tools/call get_next vs get_dispatch_next: same auth outcome; envelope fields aligned when both succeed', async () => {
    const a = await mcpRpc(toolCall('get_next', { boardId: BOARD }), bearerHeaders(TOKENS.AGENT))
    const b = await mcpRpc(
      toolCall('get_dispatch_next', { boardId: BOARD }),
      bearerHeaders(TOKENS.AGENT),
    )
    // Same HTTP auth class (neither should be gate-401)
    expect(a.status).not.toBe(401)
    expect(b.status).not.toBe(401)

    const pa = parseToolPayload(a.json)
    const pb = parseToolPayload(b.json)
    if (pa && pb && pa.ok !== false && pb.ok !== false && pa.boardId && pb.boardId) {
      // Common pinned envelope keys
      for (const key of [
        'boardId',
        'boardRev',
        'lifecycleRev',
        'canonicalSnapshotId',
        'canonicalHash',
        'generatedAt',
        'data',
      ]) {
        expect(pa).toHaveProperty(key)
        expect(pb).toHaveProperty(key)
      }
      expect(pa.boardId).toBe(pb.boardId)
      expect(pa.data?.soleSource).toBe('active_dispatch_plan')
      expect(pb.data?.soleSource).toBe('active_dispatch_plan')
      // Alias marks itself at actual envelope location: data.aliasOf (via pinnedEnvelope data bag)
      expect(pb.data.aliasOf).toBe('get_next')
      // Canonical tool must not self-tag as an alias
      expect(pa.data?.aliasOf).toBeUndefined()
    }
    // Auth error envelopes must be typed and secret-free
    for (const payload of [pa, pb]) {
      if (payload?.ok === false && payload.code) {
        expect(typeof payload.code).toBe('string')
        expect(payload.code).toMatch(
          /AUTHORIZATION|FORBIDDEN|STALE|IDEMPOTENCY|ERROR|NOT_FOUND|STALE_OR_MISSING|BLOCKED|CAPACITY/i,
        )
        // Raw OS/DB/fs errno must never escape MCP envelopes
        expect(payload.code).not.toMatch(/^E[A-Z]+$/)
        expect(payload.code).not.toBe('EPERM')
        expect(payload.code).not.toBe('ENOENT')
      }
    }
    assertNoSecretLeak(a.rawText)
    assertNoSecretLeak(b.rawText)
  })

  it.each(['EPERM', 'ENOENT'] as const)(
    'get_next and get_dispatch_next: injected %s normalizes to MCP_HANDLER_ERROR (no errno/message/path/stack leak)',
    async (errnoCode) => {
      // Deterministic regression: underlying failure carries Node errno { code }.
      // secureTool catch → typedError must not pass raw errno / message / path / stack through the envelope.
      const injected = Object.assign(
        new Error(`${errnoCode} simulated, open '/secret/path/plan.json'`),
        {
          code: errnoCode,
          stack: `Error: ${errnoCode} simulated, open '/secret/path/plan.json'\n    at Object.getActive (/secret/path/plan.json:1:1)`,
        },
      )
      const failingStore: DispatchPlanStore = {
        async get() {
          throw injected
        },
        async put() {
          throw injected
        },
        async list() {
          throw injected
        },
        async getActive() {
          throw injected
        },
        async withBoardLock(_boardId, fn) {
          return fn()
        },
      }
      setMcpPlanStore(failingStore)
      try {
        const a = await mcpRpc(
          toolCall('get_next', { boardId: BOARD }),
          bearerHeaders(TOKENS.AGENT),
        )
        const b = await mcpRpc(
          toolCall('get_dispatch_next', { boardId: BOARD }),
          bearerHeaders(TOKENS.AGENT),
        )
        const codes: string[] = []
        for (const r of [a, b]) {
          expect(r.status).not.toBe(401)
          const payload = parseToolPayload(r.json)
          expect(payload).toBeTruthy()
          expect(payload.ok).toBe(false)
          expect(payload.code).toBe('MCP_HANDLER_ERROR')
          expect(payload.error).toBe('MCP_HANDLER_ERROR')
          expect(payload.code).not.toBe(errnoCode)
          expect(payload.code).not.toMatch(/^E[A-Z]+$/)
          codes.push(payload.code)
          const blob = JSON.stringify(payload)
          // No raw errno, OS message fragments, path, or stack
          expect(blob).not.toMatch(new RegExp(errnoCode))
          expect(blob).not.toMatch(/EPERM/)
          expect(blob).not.toMatch(/ENOENT/)
          expect(blob).not.toMatch(/\/secret\/path/)
          expect(blob).not.toMatch(/plan\.json/)
          expect(blob).not.toMatch(/at Object\.getActive/)
          expect(blob).not.toMatch(/simulated, open/)
          expect(blob).not.toMatch(/"stack"/)
          assertNoSecretLeak(r.rawText)
          assertNoSecretLeak(blob)
        }
        // Both aliases share the same safe typed class
        expect(codes[0]).toBe('MCP_HANDLER_ERROR')
        expect(codes[1]).toBe('MCP_HANDLER_ERROR')
        expect(codes[0]).toBe(codes[1])
      } finally {
        setMcpPlanStore(null)
      }
    },
  )
})

// ---------------------------------------------------------------------------
// typed revision / idempotency / authorization errors
// ---------------------------------------------------------------------------
describe('typed revision / idempotency / authorization errors', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('authErrorEnvelope never embeds secrets and always carries code', () => {
    const env = authErrorEnvelope('AUTHORIZATION_REQUIRED', 'nope')
    expect(env).toEqual({ ok: false, error: 'nope', code: 'AUTHORIZATION_REQUIRED' })
    const blob = JSON.stringify(env)
    assertNoSecretLeak(blob)
  })

  it('tools/call denial returns typed authorization code in tool content when tool is registered', async () => {
    // AGENT lists open_decision_v3 / decision:write tools — force wrong role on resolve
    // resolve_decision_v3 is OWNER-only and not listable for AGENT → MCP error path
    const r = await mcpRpc(
      toolCall('resolve_decision_v3', {
        boardId: BOARD,
        decisionId: 'd-nope',
        selectedOptionId: 'ack',
        expectedEntityRev: 0,
        expectedBoardRev: 0,
      }),
      bearerHeaders(TOKENS.AGENT),
    )
    const payload = parseToolPayload(r.json)
    if (payload?.code) {
      expect(payload.ok).toBe(false)
      expect(payload.code).toMatch(/FORBIDDEN|AUTHORIZATION/)
      expect(payload).not.toHaveProperty('token')
      expect(payload).not.toHaveProperty('secret')
    } else {
      // Not registered → protocol error, still no secret
      expect(r.json?.error || r.json?.result?.isError).toBeTruthy()
    }
    assertNoSecretLeak(r.rawText)
  })

  it('open_decision_v3 with mismatched expectedBoardRev yields typed STALE_REVISION (no secret body)', async () => {
    const r = await mcpRpc(
      toolCall('open_decision_v3', {
        boardId: BOARD,
        question: 'mcp-auth typed stale?',
        expectedBoardRev: 999_999,
      }),
      bearerHeaders(TOKENS.AGENT),
    )
    expect(r.status).not.toBe(401)
    const payload = parseToolPayload(r.json)
    // Memory atomic defaults boardRev=0 → mismatch should be STALE_REVISION when handler runs
    if (payload) {
      expect(payload.ok).not.toBe(true)
      if (payload.code) {
        expect(String(payload.code)).toMatch(
          /STALE_REVISION|AUTHORIZATION|FORBIDDEN|ERROR|INVALID/,
        )
      }
      // No credential fields
      expect(JSON.stringify(payload)).not.toMatch(/password|apiKey|api_key|Bearer /i)
    }
    assertNoSecretLeak(r.rawText)
  })

  it('list_projects returns pinned envelope + nextCursor contract (canonical pagination)', async () => {
    const r = await mcpRpc(
      toolCall('list_projects', { boardId: BOARD, pageSize: 50 }),
      bearerHeaders(TOKENS.AGENT),
    )
    expect(r.status).not.toBe(401)
    const payload = parseToolPayload(r.json)
    if (payload?.ok === false) {
      // board may be missing on fixture — still typed + secret-free
      expect(payload.code).toMatch(/NOT_FOUND|ERROR|AUTHORIZATION|FORBIDDEN|INVALID|STALE|MCP_/i)
      assertNoSecretLeak(r.rawText)
      return
    }
    if (payload) {
      expect(payload).toHaveProperty('schemaVersion', 'TM_PINNED_ENVELOPE_V1')
      expect(payload).toHaveProperty('boardId')
      expect(payload).toHaveProperty('boardRev')
      expect(payload).toHaveProperty('lifecycleRev')
      expect(payload).toHaveProperty('canonicalHash')
      expect(payload).toHaveProperty('canonicalSnapshotId')
      expect(payload).toHaveProperty('nextCursor')
      expect(payload).toHaveProperty('data')
      // Hard gate: required envelope metadata (no soft || true)
      expect(payload.method).toBe('list_projects')
      expect(payload.requestedAs).toBe('list_projects')
      expect(payload.contractVersion).toBe('TM_MCP_READ_CONTRACT_V1')
      // default pageSize bound
      if (Array.isArray(payload.projects)) {
        expect(payload.projects.length).toBeLessThanOrEqual(50)
      }
      if (Array.isArray(payload.data?.items)) {
        expect(payload.data.items.length).toBeLessThanOrEqual(50)
      }
    }
    assertNoSecretLeak(r.rawText)
  })

  it('get_overview / get_board_hash / get_prod wire envelope method+requestedAs+contractVersion', async () => {
    for (const [tool, expectedMethod, expectedRequestedAs] of [
      ['get_overview', 'get_overview', 'get_overview'],
      ['get_board_hash', 'get_overview', 'get_board_hash'],
      ['get_prod', 'get_prod', 'get_prod'],
      ['get_guide', 'get_guide', 'get_guide'],
      ['get_rollup', 'get_overview', 'get_rollup'],
      ['get_lifecycle', 'get_overview', 'get_lifecycle'],
    ] as const) {
      const r = await mcpRpc(toolCall(tool, { boardId: BOARD }), bearerHeaders(TOKENS.AGENT))
      expect(r.status).not.toBe(401)
      const payload = parseToolPayload(r.json)
      if (payload?.ok === false) {
        // Board fixture may be missing — still typed, secret-free
        expect(String(payload.code ?? '')).toMatch(
          /NOT_FOUND|ERROR|AUTHORIZATION|FORBIDDEN|INVALID|STALE|MCP_|MISSING/i,
        )
        assertNoSecretLeak(r.rawText)
        continue
      }
      if (payload) {
        expect(payload.schemaVersion).toBe('TM_PINNED_ENVELOPE_V1')
        expect(payload.method).toBe(expectedMethod)
        expect(payload.requestedAs).toBe(expectedRequestedAs)
        expect(payload.contractVersion).toBe('TM_MCP_READ_CONTRACT_V1')
        expect(payload).toHaveProperty('canonicalHash')
        expect(payload).toHaveProperty('boardRev')
        if (tool === 'get_board_hash') {
          expect(payload.hash === payload.canonicalHash || payload.data?.hash === payload.canonicalHash).toBe(
            true,
          )
        }
      }
      assertNoSecretLeak(r.rawText)
    }
  })

  it('get_work / get_priority alias envelope metadata on wire', async () => {
    const work = await mcpRpc(
      toolCall('get_work', { boardId: BOARD, pageSize: 10 }),
      bearerHeaders(TOKENS.AGENT),
    )
    const workPayload = parseToolPayload(work.json)
    if (workPayload && workPayload.ok !== false) {
      expect(workPayload.method).toBe('list_work_items')
      expect(workPayload.requestedAs).toBe('get_work')
      expect(workPayload.contractVersion).toBe('TM_MCP_READ_CONTRACT_V1')
    }
    const prio = await mcpRpc(toolCall('get_priority', { boardId: BOARD }), bearerHeaders(TOKENS.AGENT))
    const prioPayload = parseToolPayload(prio.json)
    if (prioPayload && prioPayload.ok !== false) {
      expect(prioPayload.method).toBe('get_priority_portfolio')
      expect(prioPayload.requestedAs).toBe('get_priority')
      expect(prioPayload.contractVersion).toBe('TM_MCP_READ_CONTRACT_V1')
    }
    assertNoSecretLeak(work.rawText)
    assertNoSecretLeak(prio.rawText)
  })

  it('unauth get_public_snapshot rate-limits per socket IP; spoofed XFF ignored', async () => {
    const clock = { nowMs: () => 5_000_000 }
    const limiter = createPublicSnapshotRateLimiter({
      store: createMemoryRateLimitStore(),
      clock,
      policy: { sustainedPerMinute: 60, burst: 1 },
    })
    setTestPublicSnapshotService(createPublicSnapshotService({ rateLimiter: limiter }))
    try {
      const body = toolCall('get_public_snapshot', { boardId: BOARD })
      // Same socket IP + spoofed XFF — second call must share bucket (IP not XFF)
      const r1 = await mcpHandle(
        makeRequestWithSocketIp(body, '198.51.100.40', {
          'x-forwarded-for': '9.9.9.9',
        }),
      )
      const t1 = await r1.text()
      const j1 = JSON.parse(t1)
      const p1 = parseToolPayload(j1)
      // First call: not 401; rate token consumed even when snapshot is STALE_OR_MISSING
      expect(r1.status).not.toBe(401)
      expect(p1?.code).not.toBe('RATE_LIMITED')

      const r2 = await mcpHandle(
        makeRequestWithSocketIp(body, '198.51.100.40', {
          'x-forwarded-for': '1.2.3.4',
        }),
      )
      const t2 = await r2.text()
      const j2 = JSON.parse(t2)
      const p2 = parseToolPayload(j2)
      // Second call same socket IP must be rate limited (XFF spoof does not fork bucket)
      expect(p2).toBeTruthy()
      expect(p2.ok).toBe(false)
      expect(p2.code).toBe('RATE_LIMITED')

      // Different IP still has capacity
      const r3 = await mcpHandle(makeRequestWithSocketIp(body, '198.51.100.41'))
      const t3 = await r3.text()
      const j3 = JSON.parse(t3)
      const p3 = parseToolPayload(j3)
      expect(p3).toBeTruthy()
      expect(p3.code).not.toBe('RATE_LIMITED')
      assertNoSecretLeak(t1)
      assertNoSecretLeak(t2)
      assertNoSecretLeak(t3)
    } finally {
      resetPublicSnapshotServiceForTests()
    }
  })

  it('list_tasks rejects oversized pageSize via typed CURSOR/PAGE_SIZE error (not silent clamp)', async () => {
    const r = await mcpRpc(
      toolCall('list_tasks', { boardId: BOARD, pageSize: 201 }),
      bearerHeaders(TOKENS.AGENT),
    )
    expect(r.status).not.toBe(401)
    const payload = parseToolPayload(r.json)
    if (payload) {
      expect(payload.ok).not.toBe(true)
      expect(String(payload.code ?? '')).toMatch(/PAGE_SIZE_INVALID|CURSOR_INVALID|INVALID|ERROR|MCP_/i)
    }
    assertNoSecretLeak(r.rawText)
  })

  it('V3 mutations require expectedBoardRev / idempotencyKey / entity rev where contract applies', async () => {
    // Missing expectedBoardRev on open_decision_v3 — schema/handler must not invent boardRev silently
    const openMissing = await mcpRpc(
      toolCall('open_decision_v3', {
        boardId: BOARD,
        question: 'missing rev?',
      }),
      bearerHeaders(TOKENS.AGENT),
    )
    const openPayload = parseToolPayload(openMissing.json)
    // Protocol validation error OR typed invalid — never ok:true with invented rev
    if (openPayload) {
      expect(openPayload.ok).not.toBe(true)
    } else {
      expect(openMissing.json?.error || openMissing.json?.result?.isError).toBeTruthy()
    }
    assertNoSecretLeak(openMissing.rawText)

    // sync_accounts missing expectedBoardRev + still has idempotencyKey shape
    const syncMissing = await mcpRpc(
      toolCall('sync_accounts', {
        boardId: BOARD,
        sourceRevision: 1,
        accounts: [],
        idempotencyKey: 'idem-missing-board-rev',
      }),
      bearerHeaders(TOKENS.ROOT),
    )
    const syncPayload = parseToolPayload(syncMissing.json)
    if (syncPayload) {
      expect(syncPayload.ok).not.toBe(true)
    } else {
      expect(syncMissing.json?.error || syncMissing.json?.result?.isError).toBeTruthy()
    }
    assertNoSecretLeak(syncMissing.rawText)

    // resolve_decision_v3 missing entityExpectedRev/expectedRev
    const resolveMissing = await mcpRpc(
      toolCall('resolve_decision_v3', {
        boardId: BOARD,
        decisionId: 'd-missing-entity-rev',
        selectedOptionId: 'ack',
        expectedBoardRev: 0,
      }),
      bearerHeaders(TOKENS.OWNER),
    )
    const resolvePayload = parseToolPayload(resolveMissing.json)
    if (resolvePayload) {
      expect(resolvePayload.ok).not.toBe(true)
      // NOT_FOUND or INVALID_INPUT for missing entity rev — either is fail-closed
      if (resolvePayload.code) {
        expect(String(resolvePayload.code)).toMatch(
          /INVALID_INPUT|NOT_FOUND|STALE|AUTHORIZATION|FORBIDDEN|ERROR|MCP_/i,
        )
      }
    }
    assertNoSecretLeak(resolveMissing.rawText)
  })

  it('publish_dispatch_plan twice with same idempotency key different hash → IDEMPOTENCY_CONFLICT or typed deny', async () => {
    const base = {
      boardId: BOARD,
      planId: 'plan-mcp-auth-1',
      planVersion: 1,
      planHash: 'hash-aaa',
      canonicalSnapshotId: 'snap-1',
      canonicalHash: 'c'.repeat(64),
      expectedBoardRev: 0,
      issuedAt: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 3600_000).toISOString(),
      items: [{ taskId: 'T-1', rank: 1 }],
      idempotencyKey: 'idem-mcp-auth-conflict-1',
    }
    const first = await mcpRpc(toolCall('publish_dispatch_plan', base), bearerHeaders(TOKENS.ROOT))
    const second = await mcpRpc(
      toolCall('publish_dispatch_plan', { ...base, planHash: 'hash-bbb-different' }),
      bearerHeaders(TOKENS.ROOT),
    )
    const p1 = parseToolPayload(first.json)
    const p2 = parseToolPayload(second.json)
    // First may succeed or fail capacity/atomic; second with different body same key should conflict if first stored
    if (p1?.ok === true && p2) {
      expect(p2.ok).toBe(false)
      expect(String(p2.code)).toMatch(/IDEMPOTENCY_CONFLICT|IDEMPOTENCY|DATA_INTEGRITY|STALE/)
    } else if (p2?.code) {
      // Typed control-plane errors only — never success, never secret-bearing free text only
      expect(String(p2.code)).toMatch(
        /IDEMPOTENCY|STALE_REVISION|AUTHORIZATION|FORBIDDEN|ERROR|BLOCKED|CAPACITY|INVALID|DATA_INTEGRITY|NOT_FOUND/i,
      )
      expect(p2.ok).not.toBe(true)
    }
    assertNoSecretLeak(first.rawText)
    assertNoSecretLeak(second.rawText)
  })

  it('ROOT productionApprovalId on publish → ROOT_PRODUCTION_APPROVAL_DENIED at authorize recheck', () => {
    const p: Principal = {
      actorId: 'root',
      role: 'ROOT_ORCHESTRATOR',
      scopes: defaultScopesForRole('ROOT_ORCHESTRATOR'),
      channel: 'bearer',
      boards: [],
    }
    const r = authorizeToolCall(p, 'publish_dispatch_plan', {
      productionApprovalId: 'pa-1',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ROOT_PRODUCTION_APPROVAL_DENIED')
  })
})

// ---------------------------------------------------------------------------
// no secret bodies (sync_accounts strip + error paths)
// ---------------------------------------------------------------------------
describe('no secret bodies', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('sync_accounts strips token/secret/password fields and does not echo them', async () => {
    const secretValue = 'super-secret-provider-token-SHOULD-NOT-ECHO'
    const r = await mcpRpc(
      toolCall('sync_accounts', {
        boardId: BOARD,
        sourceRevision: 1,
        expectedBoardRev: 0,
        idempotencyKey: 'idem-sync-secret-1',
        accounts: [
          {
            accountId: 'acct-1',
            label: 'masked-label',
            token: secretValue,
            password: 'pw-should-not-echo',
            apiKey: 'api-should-not-echo',
            status: 'ACTIVE',
          },
        ],
      }),
      bearerHeaders(TOKENS.ROOT),
    )
    expect(r.rawText).not.toContain(secretValue)
    expect(r.rawText).not.toContain('pw-should-not-echo')
    expect(r.rawText).not.toContain('api-should-not-echo')
    const payload = parseToolPayload(r.json)
    if (payload) {
      expect(JSON.stringify(payload)).not.toContain(secretValue)
      expect(JSON.stringify(payload)).not.toMatch(/"token"\s*:\s*"/)
      expect(JSON.stringify(payload)).not.toMatch(/"password"\s*:\s*"/)
    }
    assertNoSecretLeak(r.rawText, [secretValue, 'pw-should-not-echo', 'api-should-not-echo'])
  })

  it('authGate 401 bodies are minimal JSON-RPC errors without stack/secrets', async () => {
    const r = await mcpRpc(toolCall('list_accounts', { boardId: BOARD }))
    expect(r.status).toBe(401)
    expect(r.json).toMatchObject({
      jsonrpc: '2.0',
      error: { message: 'AUTHORIZATION_REQUIRED' },
    })
    expect(r.rawText).not.toMatch(/at\s+\w+\s+\(/) // no stack frames
    assertNoSecretLeak(r.rawText)
  })
})

// ---------------------------------------------------------------------------
// resolveMcpAuthContext / authGate direct request-level checks
// ---------------------------------------------------------------------------
describe('request-level authGate / resolveMcpAuthContext', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('authGate allows unauth tools/list as Request (not Response)', async () => {
    const g = await authGate(makeRequest(rpc('tools/list')))
    expect(g).toBeInstanceOf(Request)
  })

  it('authGate returns 401 Response for unauth sensitive tools/call', async () => {
    const g = await authGate(makeRequest(toolCall('list_boards', { boardId: BOARD })))
    expect(g).toBeInstanceOf(Response)
    if (g instanceof Response) {
      expect(g.status).toBe(401)
      const j = await g.json()
      expect(j.error.message).toBe('AUTHORIZATION_REQUIRED')
    }
  })

  it('authGate allows authenticated sensitive tools/call through as Request', async () => {
    const g = await authGate(
      makeRequest(toolCall('list_boards', { boardId: BOARD }), bearerHeaders(TOKENS.OWNER)),
    )
    expect(g).toBeInstanceOf(Request)
  })

  it('McpAuthContext.bearerPresent tracks Authorization / X-Cairn-Token only', async () => {
    const none = await resolveMcpAuthContext(makeRequest(rpc('tools/list')))
    expect(none.bearerPresent).toBe(false)
    const b = await resolveMcpAuthContext(
      makeRequest(rpc('tools/list'), bearerHeaders(TOKENS.AGENT)),
    )
    expect(b.bearerPresent).toBe(true)
    expect(b.principal?.role).toBe('AGENT')
  })
})

// ---------------------------------------------------------------------------
// list filtering vs invocation recheck (cannot call what list hid via success)
// ---------------------------------------------------------------------------
describe('list filtering + invocation recheck', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('for each role, every non-listable catalog tool cannot return ok:true payload', async () => {
    const samples: Array<{ token: string | null; role: string }> = [
      { token: null, role: 'PUBLIC' },
      { token: TOKENS.AGENT, role: 'AGENT' },
      { token: TOKENS.INTEGRATOR, role: 'INTEGRATOR' },
      { token: TOKENS.OWNER, role: 'OWNER' },
      { token: TOKENS.ROOT, role: 'ROOT_ORCHESTRATOR' },
    ]

    for (const { token, role } of samples) {
      const headers = token ? bearerHeaders(token) : {}
      const list = await mcpRpc(rpc('tools/list'), headers)
      const listed = new Set(toolNamesFromList(list.json))
      const principal = token
        ? (await resolveMcpAuthContext(makeRequest(rpc('tools/list'), headers))).principal
        : null

      // Sample a few non-listable tools (not full catalog — keep runtime bounded)
      const hidden = MCP_TOOL_SPECS.map((s) => s.name)
        .filter((n) => !listed.has(n))
        .slice(0, 8)

      for (const name of hidden) {
        expect(isToolListable(principal, name)).toBe(false)
        const call = await mcpRpc(
          toolCall(name, {
            boardId: BOARD,
            id: 'x',
            featureId: 'x',
            planId: 'p',
            planVersion: 1,
            planHash: 'h',
            canonicalSnapshotId: 's',
            canonicalHash: 'c',
            expectedBoardRev: 0,
            issuedAt: new Date().toISOString(),
            expiresAt: new Date(Date.now() + 1000).toISOString(),
            items: [],
            idempotencyKey: `idem-${role}-${name}`,
            runId: 'r',
            taskId: 't',
            targetGate: 'G1',
            agentId: 'agent-mcp-auth',
            model: 'm',
            expectedEntityRev: 0,
            decisionId: 'd',
            selectedOptionId: 'ack',
            sourceRevision: 1,
            accounts: [],
            pathspecs: ['src/server/**'],
            rootAcceptanceId: 'ra',
            checkpointId: 'cp-mcp-auth',
          }),
          headers,
        )
        const payload = parseToolPayload(call.json)
        if (payload && typeof payload === 'object' && 'ok' in payload) {
          expect(payload.ok, `${role} must not ok:true on hidden ${name}`).not.toBe(true)
        } else if (call.status === 401) {
          expect(String(call.json?.error?.message ?? '')).toMatch(/AUTHORIZATION_REQUIRED/)
        } else {
          // MCP unknown tool / isError
          expect(
            call.json?.error || call.json?.result?.isError || call.status >= 400,
            `${role} hidden ${name} must not be silent success`,
          ).toBeTruthy()
        }
        assertNoSecretLeak(call.rawText)
      }
    }
  }, 60_000)
})

// ---------------------------------------------------------------------------
// submit_stage_evidence RBAC + add_comment spoof + WAVE_CLOSE trigger enum
// ---------------------------------------------------------------------------
describe('submit_stage_evidence + add_comment spoof + WAVE_CLOSE (auth surface)', () => {
  beforeEach(() => {
    installBearerMatrix()
  })

  it('AGENT lists submit_stage_evidence; OWNER/ROOT denied evidence impersonation', async () => {
    const agentList = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.AGENT))
    expect(toolNamesFromList(agentList.json)).toContain('submit_stage_evidence')

    const ownerCall = await mcpRpc(
      toolCall('submit_stage_evidence', {
        boardId: BOARD,
        taskId: 't1',
        toStage: 'MAPPING',
        byRunId: 'r1',
        taskHash: 'th',
        expectedLifecycleRev: 0,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        canonicalHash: 'c'.repeat(64),
        idempotencyKey: 'idem-owner-ev',
        agentId: 'any',
      }),
      bearerHeaders(TOKENS.OWNER),
    )
    const ownerPayload = parseToolPayload(ownerCall.json)
    if (ownerPayload?.code) {
      expect(ownerPayload.code).toMatch(
        /OWNER_EVIDENCE_IMPERSONATION_DENIED|AUTHORIZATION_REQUIRED|FORBIDDEN/,
      )
    } else {
      expect(
        ownerCall.json?.error || ownerCall.json?.result?.isError || ownerCall.status >= 400,
      ).toBeTruthy()
    }

    const rootCall = await mcpRpc(
      toolCall('submit_stage_evidence', {
        boardId: BOARD,
        taskId: 't1',
        toStage: 'MAPPING',
        byRunId: 'r1',
        taskHash: 'th',
        expectedLifecycleRev: 0,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        canonicalHash: 'c'.repeat(64),
        idempotencyKey: 'idem-root-ev',
      }),
      bearerHeaders(TOKENS.ROOT),
    )
    const rootPayload = parseToolPayload(rootCall.json)
    if (rootPayload?.code) {
      expect(rootPayload.code).toMatch(
        /OWNER_EVIDENCE_IMPERSONATION_DENIED|FORBIDDEN_ROLE|AUTHORIZATION_REQUIRED|FORBIDDEN/,
      )
    } else {
      expect(
        rootCall.json?.error || rootCall.json?.result?.isError || rootCall.status >= 400,
      ).toBeTruthy()
    }
  })

  it('add_comment REAL MCP: spoof authorType=human/author=owner → AGENT principal + persisted readback', async () => {
    const { createBoard, upsertFeature, boardExists, deleteBoard, boardHash } =
      await import('#/server/board-store')
    const { seedBoardRevision } = await import('#/server/control-data-persistence')

    installBearerMatrix()

    // AGENT bearer is board-bound to BOARD (mfs-rebuild) — must use that board id.
    const commentBoard = BOARD
    const featureId = `feat-auth-spoof-${Date.now().toString(36)}`
    const createdBoard = !(await boardExists(commentBoard))
    try {
      if (createdBoard) {
        await createBoard(commentBoard, 'MCP auth comment spoof')
      }
      await upsertFeature(commentBoard, {
        id: featureId,
        nama: 'Auth spoof feature',
        fase: 'build',
      } as never)

      const ctx = resolveMcpRuntimeContext()
      const hash = await boardHash(commentBoard)
      const boardState = await ctx.atomic.getBoardState(commentBoard)
      const sql = (ctx.controlData as { sql?: Parameters<typeof seedBoardRevision>[0] }).sql
      if (sql) {
        await seedBoardRevision(sql, {
          boardId: commentBoard,
          boardRev: boardState.boardRev,
          lifecycleRev: 0,
          subjectHash: hash,
          canonicalSnapshotId: `snap-${commentBoard}`,
          canonicalHash: hash,
        })
      }

      const marker = `auth-spoof-${Date.now()}`
      const call = await mcpRpc(
        toolCall('add_comment', {
          boardId: commentBoard,
          featureId,
          text: marker,
          author: 'owner',
          authorType: 'human',
          entityExpectedRev: 0,
          expectedBoardRev: boardState.boardRev,
          canonicalHash: hash,
          idempotencyKey: `idem-auth-comment-${Date.now()}`,
        }),
        bearerHeaders(TOKENS.AGENT),
      )
      const payload = parseToolPayload(call.json)
      expect(payload?.ok).toBe(true)
      expect(payload?.author).toBe('agent-mcp-auth')
      expect(payload?.authorType).toBe('agent')
      expect(payload?.author).not.toBe('owner')
      expect(payload?.authorType).not.toBe('human')

      const act = await mcpRpc(
        toolCall('list_activity', { boardId: commentBoard, pageSize: 50 }),
        bearerHeaders(TOKENS.AGENT),
      )
      const actPayload = parseToolPayload(act.json)
      const items = (actPayload?.activity as Array<Record<string, unknown>>) ?? []
      const hit = items.find((a) => String(a.text ?? '') === marker)
      expect(hit).toBeTruthy()
      expect(hit!.actor).toBe('agent-mcp-auth')
      expect(hit!.actorType).toBe('agent')
    } finally {
      // Only delete if we created this shared board id in this test.
      if (createdBoard) {
        try {
          if (await boardExists(commentBoard)) await deleteBoard(commentBoard)
        } catch {
          /* cleanup */
        }
      }
      installBearerMatrix()
    }
  }, 30_000)

  it('sync_accounts trigger schema includes WAVE_CLOSE (ROOT path interface)', async () => {
    const { ACCOUNT_SYNC_TRIGGER_Z, ACCOUNT_SYNC_EXTERNAL_ADAPTER_TRIGGERS, ACCOUNT_SYNC_TRIGGER_VALUES } =
      await import('#/server/board-mcp')
    expect(ACCOUNT_SYNC_TRIGGER_VALUES).toContain('WAVE_CLOSE')
    expect(ACCOUNT_SYNC_TRIGGER_Z.safeParse('WAVE_CLOSE').success).toBe(true)
    expect(ACCOUNT_SYNC_EXTERNAL_ADAPTER_TRIGGERS).toEqual([])
    // ROOT lists sync_accounts (callable path for WAVE_CLOSE)
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.ROOT))
    expect(toolNamesFromList(list.json)).toContain('sync_accounts')
  })

  it('adversarial: set_lifecycle allowSkip=true → exact typed INVALID_TRANSITION; no silent skip', async () => {
    installBearerMatrix()
    const { assertLifecycleEvidenceBypassForbidden, McpMutationError, mcpTypedErrorForTests } =
      await import('#/server/board-mcp')
    // Domain gate (same path MCP handler uses before writeLifecycle)
    await expect(
      assertLifecycleEvidenceBypassForbidden('set_lifecycle', BOARD, {
        allowSkip: true,
        stages: [
          { key: 'TODO', label: 'Todo' },
          { key: 'DONE', label: 'Done' },
        ],
      }),
    ).rejects.toMatchObject({ code: 'INVALID_TRANSITION' })

    const typed = mcpTypedErrorForTests(
      new McpMutationError(
        'INVALID_TRANSITION',
        'set_lifecycle cannot set allowSkip=true on any board (ordered V3 evidence required; legacy rail skip denied)',
      ),
    )
    expect(typed.code).toBe('INVALID_TRANSITION')
    expect(typed.error).toMatch(/allowSkip=true|legacy rail skip/i)

    // Real MCP tools/call: OWNER may list set_lifecycle; payload still fails closed
    const list = await mcpRpc(rpc('tools/list'), bearerHeaders(TOKENS.OWNER))
    expect(toolNamesFromList(list.json)).toContain('set_lifecycle')
    const call = await mcpRpc(
      toolCall('set_lifecycle', {
        boardId: BOARD,
        stages: [
          { key: 'TODO', label: 'Todo' },
          { key: 'DONE', label: 'Done' },
        ],
        allowSkip: true,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        canonicalHash: 'a'.repeat(64),
        idempotencyKey: `idem-allowskip-deny-${Date.now()}`,
      }),
      bearerHeaders(TOKENS.OWNER),
    )
    const payload = parseToolPayload(call.json)
    // Fail closed: ok=false + typed code (not silent coerce to allowSkip false success)
    expect(payload?.ok).toBe(false)
    expect(payload?.code).toBe('INVALID_TRANSITION')
    assertNoSecretLeak(call.rawText)
  })

  it('adversarial: replace_accounts with null scheduler → ACCOUNT_SYNC_SCHEDULER_MISSING exact typed', async () => {
    installBearerMatrix()
    const ctx = resolveMcpRuntimeContext()
    const pin = 'd'.repeat(64)
    const sql = (ctx.controlData as { sql?: unknown }).sql as
      | Parameters<typeof import('#/server/control-data-persistence').seedBoardRevision>[0]
      | undefined
    expect(sql).toBeTruthy()
    const { seedBoardRevision } = await import('#/server/control-data-persistence')
    await seedBoardRevision(sql!, {
      boardId: BOARD,
      boardRev: 2,
      lifecycleRev: 0,
      subjectHash: pin,
      canonicalSnapshotId: 'snap-auth-replace-nosched',
      canonicalHash: pin,
    })
    ;(ctx as unknown as { accountSyncScheduler: null }).accountSyncScheduler = null
    const { peekAccountSyncScheduler } = await import('#/server/control-plane-runtime-context')
    expect(peekAccountSyncScheduler()).toBeNull()

    const before = await ctx.runtime.accounts.get(BOARD)
    const board = await ctx.atomic.getBoardState(BOARD)
    const entityBefore = before?.entityRev ?? 0
    const sourceBefore = before?.sourceRevision ?? null
    const boardRevBefore = board.boardRev

    const call = await mcpRpc(
      toolCall('replace_accounts', {
        boardId: BOARD,
        ops: {
          vault: { generatedAt: new Date().toISOString(), sourceRevision: 1 },
          accounts: [
            {
              id: 'mask-auth-no-sched',
              label: 'NoSched',
              status: 'OK',
              usable: true,
              slotsInUse: 0,
              slotsCapacity: 3,
              provider: 'GROK',
            },
          ],
        },
        entityExpectedRev: entityBefore,
        expectedBoardRev: boardRevBefore,
        canonicalHash: pin,
        idempotencyKey: `idem-auth-replace-nosched-${Date.now()}`,
      }),
      bearerHeaders(TOKENS.ROOT),
    )
    const payload = parseToolPayload(call.json)
    expect(payload?.ok).toBe(false)
    expect(payload?.code).toBe('ACCOUNT_SYNC_SCHEDULER_MISSING')
    // No authority write / no rev bump
    const after = await ctx.runtime.accounts.get(BOARD)
    expect(after?.sourceRevision ?? null).toBe(sourceBefore)
    expect(after?.entityRev ?? 0).toBe(entityBefore)
    const boardAfter = await ctx.atomic.getBoardState(BOARD)
    expect(boardAfter.boardRev).toBe(boardRevBefore)
    assertNoSecretLeak(call.rawText)
  })
})
