// Cairn MCP endpoint — spec-compliant Streamable HTTP (MCP 2025-06-18) over the
// Web-standard Request/Response transport. Stateless + JSON responses.
//
// V3 auth (C2A / W15-01 / R5-05):
// - Bearer principals only (Authorization: Bearer / X-Cairn-Token). Cookies never elevate.
// - Unauthenticated: initialize/ping/notifications/initialized protocol-safe.
// - Unauth tools/list + resources/list|read: only sanitized public snapshot surface.
// - Unauth sensitive tools/call → HTTP 401 AUTHORIZATION_REQUIRED (valid JSON-RPC error).
// - Auth gate applies to ALL Streamable HTTP methods that can carry JSON-RPC or session
//   ops (POST/PUT/PATCH body, GET SSE / DELETE terminate with Mcp-Session-Id) — not POST-only.
// - Authenticated tools/list filtered by registerBoardTools(isToolListable); tools/call
//   rechecked via authorizeToolCall at gate + again inside secureTool handlers.
// - Legacy CAIRN_WRITE_TOKEN absent → fail-closed (no open write path); present → constrained
//   AGENT principal only (resolution lives in rbac.resolveBearerPrincipal).
// - Transport/session: fresh McpServer + transport per request; always closed in finally.
// - Handler failures return stable codes only — never raw exception messages/stacks.
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js'
import { createFileRoute } from '@tanstack/react-router'

import { registerBoardTools, resolveMcpRuntimeContext, type McpAuthContext } from '#/server/board-mcp'
import { envVar } from '#/server/db'
import { peekControlPlaneRuntimeContext } from '#/server/control-plane-runtime-context'
import {
  authorizeToolCall,
  extractBearerFromHeaders,
  getBearerAuthMechanismState,
  isPublicTool,
  resolveBearerPrincipal,
  type AuthErrorCode,
  type Principal,
} from '#/server/rbac'
import { resolvePublicSnapshotClientIp } from '#/routes/api.public-snapshot'

const SERVER_NAME = 'cairn-board'
const SERVER_VERSION = '1.3.0'

/** Exact public resource URI allowlist (no loose substring match). */
const PUBLIC_RESOURCE_URIS = new Set(['cairn://public-snapshot', 'public-snapshot'])

type RpcId = string | number | null

function firstRpcId(msgs: Array<Record<string, unknown>>): RpcId {
  for (const m of msgs) {
    if (m && 'id' in m && (typeof m.id === 'string' || typeof m.id === 'number' || m.id === null)) {
      return m.id as RpcId
    }
  }
  return null
}

/**
 * Safe JSON-RPC error Response. Never includes credentials, cookies, tokens,
 * exception messages, or stacks — stable codes only.
 */
function rpcError(
  status: number,
  code: AuthErrorCode | string,
  message?: string,
  id: RpcId = null,
  jsonRpcCode = -32001,
): Response {
  // Never pass through raw Error.message — message must be a stable code string.
  const safeMessage = message && /^[A-Z][A-Z0-9_]+$/.test(message) ? message : code
  return new Response(
    JSON.stringify({
      jsonrpc: '2.0',
      id,
      error: {
        code: jsonRpcCode,
        message: safeMessage,
        data: { code },
      },
    }),
    {
      status,
      headers: { 'content-type': 'application/json' },
    },
  )
}

function parseRpcMessages(body: string): Array<Record<string, unknown>> {
  if (!body || !body.trim()) return []
  try {
    const parsed = JSON.parse(body)
    return Array.isArray(parsed) ? parsed : [parsed]
  } catch {
    return []
  }
}

function isInitializeOnly(msgs: Array<Record<string, unknown>>): boolean {
  if (msgs.length === 0) return false
  return msgs.every(
    (m) =>
      m?.method === 'initialize' ||
      m?.method === 'notifications/initialized' ||
      m?.method === 'ping',
  )
}

function isToolsList(msgs: Array<Record<string, unknown>>): boolean {
  return msgs.some((m) => m?.method === 'tools/list')
}

function isResourcesList(msgs: Array<Record<string, unknown>>): boolean {
  return msgs.some((m) => m?.method === 'resources/list')
}

function toolsCallEntries(
  msgs: Array<Record<string, unknown>>,
): Array<{ name: string; args: Record<string, unknown>; id: RpcId }> {
  const out: Array<{ name: string; args: Record<string, unknown>; id: RpcId }> = []
  for (const m of msgs) {
    if (m?.method !== 'tools/call') continue
    const params = (m.params ?? {}) as { name?: string; arguments?: Record<string, unknown> }
    if (typeof params.name !== 'string') continue
    const id =
      typeof m.id === 'string' || typeof m.id === 'number' || m.id === null ? (m.id as RpcId) : null
    out.push({
      name: params.name,
      args: params.arguments && typeof params.arguments === 'object' ? params.arguments : {},
      id,
    })
  }
  return out
}

function resourceReadUris(msgs: Array<Record<string, unknown>>): Array<string> {
  const uris: Array<string> = []
  for (const m of msgs) {
    if (m?.method !== 'resources/read') continue
    const uri = (m.params as { uri?: string } | undefined)?.uri
    if (typeof uri === 'string') uris.push(uri)
  }
  return uris
}

/**
 * Public snapshot URI only — exact allowlist + strict path-suffix forms.
 * Rejects loose substring matches (e.g. evil-public-snapshot-exfil).
 */
function isPublicResourceUri(uri: string): boolean {
  const u = uri.trim().toLowerCase()
  if (PUBLIC_RESOURCE_URIS.has(u)) return true
  if (u.startsWith('cairn://')) {
    const path = u.slice('cairn://'.length)
    return path === 'public-snapshot' || path.endsWith('/public-snapshot')
  }
  return false
}

function hasCookieHeader(headers: Headers): boolean {
  const c = headers.get('cookie')
  return !!c && c.trim().length > 0
}

function isBodyCarryingMethod(method: string): boolean {
  return method === 'POST' || method === 'PUT' || method === 'PATCH'
}

/** True when headers suggest a JSON-RPC body may be present on non-POST methods. */
function hasJsonBodyHint(headers: Headers): boolean {
  const ct = (headers.get('content-type') ?? '').toLowerCase()
  if (ct.includes('application/json') || ct.includes('+json')) return true
  const cl = headers.get('content-length')
  if (cl != null && cl !== '' && cl !== '0') return true
  const te = (headers.get('transfer-encoding') ?? '').toLowerCase()
  if (te.includes('chunked')) return true
  return false
}

/** GET SSE / DELETE terminate carrying Mcp-Session-Id = session channel operation. */
function isSessionOperation(request: Request): boolean {
  const method = request.method.toUpperCase()
  if (method !== 'GET' && method !== 'DELETE') return false
  const sid = request.headers.get('mcp-session-id')
  return !!sid && sid.trim().length > 0
}

function rebuildRequest(request: Request, body: string): Request {
  const method = request.method.toUpperCase()
  // GET/HEAD must not carry a body under Fetch rules.
  if (method === 'GET' || method === 'HEAD') {
    return new Request(request.url, {
      method: request.method,
      headers: request.headers,
    })
  }
  return new Request(request.url, {
    method: request.method,
    headers: request.headers,
    body,
  })
}

/**
 * Resolve MCP principal from bearer only — cookies never elevate MCP.
 * Session cookie identity is intentionally never consulted here.
 */
export async function resolveMcpAuthContext(request: Request): Promise<McpAuthContext> {
  // Explicit non-use of Cookie for principal elevation.
  void hasCookieHeader(request.headers)

  const raw = extractBearerFromHeaders(request.headers)
  const envWriteToken = envVar('CAIRN_WRITE_TOKEN') ?? null
  const envBearerJson = envVar('CAIRN_BEARER_PRINCIPALS_JSON') ?? null
  const { principal, mechanism } = await resolveBearerPrincipal(raw, {
    envWriteToken,
    envBearerJson,
  })

  // Defensive: never accept a session-channel principal on the MCP path.
  if (principal && principal.channel === 'session') {
    return {
      principal: null,
      mechanism: { kind: 'OK' },
      bearerPresent: !!raw,
    }
  }

  return {
    principal,
    mechanism,
    bearerPresent: !!raw,
  }
}

/**
 * Authorize JSON-RPC message batch for tools/call + resources/read.
 * Shared by all HTTP methods that can carry a body (not POST-only).
 */
function authorizeRpcMessages(
  msgs: Array<Record<string, unknown>>,
  ctx: McpAuthContext,
  cookiePresent: boolean,
): Response | null {
  const rpcId = firstRpcId(msgs)

  // Protocol negotiation always allowed without auth (MCP handshake).
  if (isInitializeOnly(msgs)) {
    return null
  }

  const calls = toolsCallEntries(msgs)
  const listing = isToolsList(msgs)
  const resourceListing = isResourcesList(msgs)
  const readUris = resourceReadUris(msgs)

  // ---- Unauthenticated path (no bearer principal) ----
  if (!ctx.principal) {
    // Cookie present without bearer must never elevate; sensitive ops stay denied.
    void cookiePresent

    for (const call of calls) {
      if (!isPublicTool(call.name)) {
        // Fail-closed when mechanism inadequate (legacy token absent / no bearer config).
        void ctx.mechanism
        return rpcError(401, 'AUTHORIZATION_REQUIRED', 'AUTHORIZATION_REQUIRED', call.id ?? rpcId)
      }
      // Public tool call without principal is allowed (handler uses public surface).
    }

    // resources/read — only public-snapshot URI
    for (const uri of readUris) {
      if (!isPublicResourceUri(uri)) {
        return rpcError(401, 'AUTHORIZATION_REQUIRED', 'AUTHORIZATION_REQUIRED', rpcId)
      }
    }

    // tools/list + resources/list: allowed; registerBoardTools registers only public tools/resources.
    void listing
    void resourceListing
    return null
  }

  // ---- Authenticated path (bearer principal only) ----
  for (const call of calls) {
    const gate = authorizeToolCall(ctx.principal, call.name, call.args)
    if (!gate.ok) {
      const code = gate.code ?? 'AUTHORIZATION_REQUIRED'
      const status =
        code === 'AUTHORIZATION_REQUIRED'
          ? 401
          : code === 'COOKIE_ELEVATION_DENIED'
            ? 403
            : 403
      // gate.message may be free-text — only echo stable codes
      const safeMsg =
        gate.message && /^[A-Z][A-Z0-9_]+$/.test(gate.message) ? gate.message : code
      return rpcError(status, code, safeMsg, call.id ?? rpcId)
    }
  }

  // Authenticated resources/read: non-public still requires board:read principal;
  // coarse gate — deny PUBLIC role reading non-public URIs.
  if (ctx.principal.role === 'PUBLIC' && ctx.principal.legacyRole !== 'member') {
    for (const uri of readUris) {
      if (!isPublicResourceUri(uri)) {
        return rpcError(403, 'PUBLIC_ONLY', 'PUBLIC_ONLY', rpcId)
      }
    }
  }

  void ctx.mechanism
  return null
}

/**
 * Pre-transport gate for unauthorized / non-public patterns.
 * Applies to ALL Streamable HTTP methods (POST/GET/DELETE/…) — not POST-only —
 * so a future non-POST tools/call path cannot bypass bearer authorization.
 * Fine-grained scope recheck also runs inside board-mcp secureTool handlers.
 *
 * Cookie session headers are ignored for elevation (bearer only).
 * Legacy CAIRN_WRITE_TOKEN absent does NOT open sensitive tools (fail-closed).
 */
export async function authGate(request: Request): Promise<Request | Response> {
  const method = request.method.toUpperCase()
  const ctx = await resolveMcpAuthContext(request)
  const cookiePresent = hasCookieHeader(request.headers)

  // Session channel operations (GET SSE / DELETE terminate with Mcp-Session-Id)
  // require a bearer principal. Stateless mode never issues session ids; this
  // hardens future stateful session transport so unauth cannot bind session ops.
  if (isSessionOperation(request) && !ctx.principal) {
    return rpcError(401, 'AUTHORIZATION_REQUIRED', 'AUTHORIZATION_REQUIRED')
  }

  // Parse JSON-RPC body for any method that can carry tools/call — not POST-only.
  // Body-carrying methods always parse; other methods parse when body hints present.
  const shouldParseBody = isBodyCarryingMethod(method) || hasJsonBodyHint(request.headers)

  if (!shouldParseBody) {
    // GET/DELETE without body / session id: transport-level only (no tools/call surface).
    // Unauth protocol negotiation remains POST initialize/ping (handled above when body present).
    void cookiePresent
    return request
  }

  let body: string
  try {
    body = await request.text()
  } catch {
    return rpcError(400, 'MCP_PARSE_ERROR', 'MCP_PARSE_ERROR')
  }

  const msgs = parseRpcMessages(body)
  const denied = authorizeRpcMessages(msgs, ctx, cookiePresent)
  if (denied) return denied

  return rebuildRequest(request, body)
}

async function handle(request: Request): Promise<Response> {
  // Capture non-spoofable IP BEFORE authGate rebuilds the Request (body clone drops .ip / socket).
  // Never raw XFF — resolvePublicSnapshotClientIp uses socket/runtime or trusted-edge only.
  const clientIp = resolvePublicSnapshotClientIp(request)

  let gated: Request | Response
  try {
    gated = await authGate(request)
  } catch {
    // Never echo raw gate errors
    return rpcError(500, 'MCP_HANDLER_ERROR', 'MCP_HANDLER_ERROR', null, -32603)
  }
  if (gated instanceof Response) return gated
  request = gated

  const auth = await resolveMcpAuthContext(request)
  const authWithIp: McpAuthContext = { ...auth, clientIp }

  // Cookie elevation hard-deny (defensive; resolve already strips session channel).
  if (authWithIp.principal && authWithIp.principal.channel === 'session') {
    return rpcError(403, 'COOKIE_ELEVATION_DENIED', 'COOKIE_ELEVATION_DENIED')
  }

  // Production/default: warm one durable control-plane context before tools register.
  // Memory only via explicit test injection (setTestControlPlaneRuntimeContext).
  // Failures stay fail-closed inside tool handlers; do not open unauth sensitive surface.
  if (authWithIp.principal && !peekControlPlaneRuntimeContext()) {
    try {
      resolveMcpRuntimeContext()
    } catch {
      // Leave unresolved — authenticated tools that need durable stores return typed errors.
    }
  }

  // Fresh transport + server per request = fully stateless. Tool registration is cheap.
  const transport = new WebStandardStreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no Mcp-Session-Id
    enableJsonResponse: true, // return JSON, not an SSE stream
  })
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION })
  registerBoardTools(server, authWithIp)
  try {
    await server.connect(transport)
    try {
      return await transport.handleRequest(request)
    } catch {
      // Never echo raw transport/handler Error.message or stacks
      return rpcError(500, 'MCP_HANDLER_ERROR', 'MCP_HANDLER_ERROR', null, -32603)
    }
  } finally {
    // Stateless JSON response is fully buffered before return → safe to release.
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

export type { Principal }
export { getBearerAuthMechanismState }
