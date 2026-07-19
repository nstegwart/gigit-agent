#!/usr/bin/env node
/**
 * Promoted security probe flow (AC-AUTH-*, AC-PUBLIC-*, live unauth surface +
 * read-only negative pack R1).
 *
 * Env-parameterized only — never embeds credentials. Negatives use fixed
 * literal dummy tokens that are never real secrets and never required to match
 * a live principal.
 *
 * Env:
 *   WEB_BASE / STAGING_URL   base URL (default http://127.0.0.1:3210)
 *   BOARD_ID                 public board id (default mfs-rebuild)
 *   STAGING_BEARER_TOKEN | STAGING_BEARER | CAIRN_MCP_BEARER  optional auth healthz
 *   SECURITY_BURST_N         default 25 public-snapshot burst for rate limit
 *
 * Usage:
 *   WEB_BASE=http://127.0.0.1:33211 node qa/e2e/flows/security-probes.mjs
 *   node qa/e2e/flows/security-probes.mjs --self-test
 *   node qa/e2e/flows/security-probes.mjs --plan
 *
 * Output: status/code/sanitized booleans only — never dumps response bodies
 * that may contain secrets. Exit 0 only when all non-optional probes PASS.
 *
 * Never invokes write tools or authenticated mutations. Never requires a real
 * token for the negative pack.
 */
import { resolve as pathResolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { printOwnerTarget, resolveBoardId, resolveWebBase } from '../lib/env.mjs'

// ---------------------------------------------------------------------------
// Identity + dummy literals (not secrets; deliberately invalid)
// ---------------------------------------------------------------------------

export const HARNESS_ID = 'security-probes-v1'
export const NEGATIVE_PACK_ID = 'TM-SECURITY-PROBES-NEGATIVE-R1'

/** Literal dummy bearer — never a real credential; used only for 401 negatives. */
export const DUMMY_BEARER_LITERAL = 'not-a-valid-token'
/** Same class of invalid value for X-Cairn-Token header path. */
export const DUMMY_CAIRN_TOKEN_LITERAL = 'not-a-valid-token'
/** Synthetic cookie that must never elevate MCP. */
export const DUMMY_SESSION_COOKIE =
  'cairn_session=security-probe-dummy-session-not-real'

export const FORBIDDEN_BODY_KEYS =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|clientSecret)$/i

/** Patterns that indicate stack / secret leakage in probe text (reporting only). */
export const LEAK_PATTERNS = Object.freeze([
  /\bat\s+[\w.$]+\s+\([^)]+:\d+:\d+\)/,
  /\bBearer\s+[A-Za-z0-9._\-+/=]{16,}/i,
  /cairn_session=[A-Za-z0-9._\-+/=]{8,}/i,
  /-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i,
])

// ---------------------------------------------------------------------------
// Probe catalog (plan mode + live order)
// ---------------------------------------------------------------------------

/**
 * Planned probe rows (deterministic; no network).
 * `class`: baseline unauth | public | optional-auth | negative-readonly
 */
export const PROBE_PLAN = Object.freeze([
  {
    id: 'AC-AUTH-healthz-unauth',
    class: 'baseline-unauth',
    method: 'GET',
    path: '/api/healthz',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-root-login-redirect',
    class: 'baseline-unauth',
    method: 'GET',
    path: '/',
    expectStatus: 'login-or-soft-closed',
    requiresRealToken: false,
  },
  {
    id: 'AC-PUBLIC-snapshot-redacted',
    class: 'public',
    method: 'GET',
    path: '/api/public-snapshot',
    expectStatus: 200,
    requiresRealToken: false,
  },
  {
    id: 'AC-PUBLIC-etag-304',
    class: 'public',
    method: 'GET',
    path: '/api/public-snapshot',
    expectStatus: 304,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-rate-limit-burst',
    class: 'public',
    method: 'GET',
    path: '/api/public-snapshot',
    expectStatus: 429,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-tools-list-public-only',
    class: 'baseline-unauth',
    method: 'POST',
    path: '/mcp',
    expectStatus: 200,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-list_tasks-unauth-401',
    class: 'baseline-unauth',
    method: 'POST',
    path: '/mcp',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-OPS-healthz-auth',
    class: 'optional-auth',
    method: 'GET',
    path: '/api/healthz',
    expectStatus: '200|503',
    requiresRealToken: true,
    skipIfNoBearer: true,
  },
  // ---- Negative pack R1 (read-only; dummy literals only) ----
  {
    id: 'AC-AUTH-healthz-wrong-bearer-401',
    class: 'negative-readonly',
    method: 'GET',
    path: '/api/healthz',
    headerClass: 'Authorization: Bearer <dummy>',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-healthz-wrong-cairn-token-401',
    class: 'negative-readonly',
    method: 'GET',
    path: '/api/healthz',
    headerClass: 'X-Cairn-Token: <dummy>',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-wrong-cairn-token-401',
    class: 'negative-readonly',
    method: 'POST',
    path: '/mcp',
    headerClass: 'X-Cairn-Token: <dummy>',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-cookie-only-sensitive-401',
    class: 'negative-readonly',
    method: 'POST',
    path: '/mcp',
    headerClass: 'Cookie only (no bearer)',
    expectStatus: 401,
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-malformed-json-fail-closed',
    class: 'negative-readonly',
    method: 'POST',
    path: '/mcp',
    expectStatus: 'fail-closed-protocol',
    requiresRealToken: false,
  },
  {
    id: 'AC-AUTH-mcp-session-get-unauth-401',
    class: 'negative-readonly',
    method: 'GET',
    path: '/mcp',
    headerClass: 'Mcp-Session-Id without bearer',
    expectStatus: 401,
    requiresRealToken: false,
    optionalMatrix: true,
  },
  {
    id: 'AC-AUTH-mcp-put-tools-call-wrong-method-gated',
    class: 'negative-readonly',
    method: 'PUT',
    path: '/mcp',
    expectStatus: 'auth-or-method-fail-closed',
    requiresRealToken: false,
    optionalMatrix: true,
  },
])

// ---------------------------------------------------------------------------
// Pure helpers (export for unit / self-test)
// ---------------------------------------------------------------------------

export function resolveBearer(env = process.env) {
  const candidates = [
    env.STAGING_BEARER_TOKEN,
    env.STAGING_BEARER,
    env.CAIRN_MCP_BEARER,
  ]
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim()
  }
  return null
}

export function probeResult(id, pass, detail) {
  return { id, pass: Boolean(pass), detail: sanitizeProbeDetail(detail) }
}

/**
 * Strip secret-like material from probe detail objects.
 * Keeps status/code/boolean/count fields only; never echoes Authorization,
 * Cookie, or raw response bodies.
 * @param {unknown} detail
 * @returns {Record<string, unknown> | null}
 */
export function sanitizeProbeDetail(detail) {
  if (detail == null) return null
  if (typeof detail !== 'object' || Array.isArray(detail)) {
    return { value: redactScalar(detail) }
  }
  /** @type {Record<string, unknown>} */
  const out = {}
  for (const [k, v] of Object.entries(detail)) {
    if (FORBIDDEN_BODY_KEYS.test(k)) {
      out[k] = '[redacted]'
      continue
    }
    if (
      /^(authorization|cookie|set-cookie|rawText|bodyText|body|headers|requestHeaders)$/i.test(
        k,
      )
    ) {
      out[k] = '[redacted]'
      continue
    }
    if (typeof v === 'string') {
      out[k] = redactScalar(v)
    } else if (typeof v === 'number' || typeof v === 'boolean' || v == null) {
      out[k] = v
    } else if (Array.isArray(v)) {
      out[k] = v.slice(0, 24).map((item) =>
        typeof item === 'string' || typeof item === 'number' || typeof item === 'boolean'
          ? redactScalar(item)
          : typeof item === 'object' && item != null
            ? sanitizeProbeDetail(item)
            : '[omitted]',
      )
    } else if (typeof v === 'object') {
      out[k] = sanitizeProbeDetail(v)
    } else {
      out[k] = '[omitted]'
    }
  }
  return out
}

function redactScalar(v) {
  if (typeof v !== 'string') return v
  let s = v
  s = s.replace(/Bearer\s+[A-Za-z0-9._\-+/=]+/gi, 'Bearer [redacted]')
  s = s.replace(/cairn_session=[^;\s]+/gi, 'cairn_session=[redacted]')
  if (s.length > 240) s = `${s.slice(0, 240)}…`
  return s
}

/**
 * Detect stack frames / bearer-like / private-key material in text.
 * @param {string | null | undefined} text
 */
export function textHasLeakSignals(text) {
  if (!text || typeof text !== 'string') return false
  return LEAK_PATTERNS.some((re) => re.test(text))
}

/**
 * Collect object keys (depth-limited) for redaction checks.
 * @param {unknown} value
 * @param {Set<string>} [out]
 * @param {number} [depth]
 */
export function collectKeys(value, out = new Set(), depth = 0) {
  if (depth > 8 || value == null) return out
  if (Array.isArray(value)) {
    for (const v of value) collectKeys(v, out, depth + 1)
    return out
  }
  if (typeof value === 'object') {
    for (const [k, v] of Object.entries(value)) {
      out.add(k)
      collectKeys(v, out, depth + 1)
    }
  }
  return out
}

/**
 * Stable error code from health/MCP JSON bodies without echoing free text.
 * @param {unknown} body
 * @returns {string | null}
 */
export function extractStableCode(body) {
  if (!body || typeof body !== 'object') return null
  const b = /** @type {Record<string, unknown>} */ (body)
  if (typeof b.code === 'string' && /^[A-Z][A-Z0-9_]+$/.test(b.code)) return b.code
  const err = b.error
  if (err && typeof err === 'object') {
    const e = /** @type {Record<string, unknown>} */ (err)
    const data = e.data
    if (data && typeof data === 'object') {
      const c = /** @type {Record<string, unknown>} */ (data).code
      if (typeof c === 'string' && /^[A-Z][A-Z0-9_]+$/.test(c)) return c
    }
    if (typeof e.message === 'string' && /^[A-Z][A-Z0-9_]+$/.test(e.message)) {
      return e.message
    }
  }
  return null
}

/**
 * True when body looks like a successful MCP tools payload (data elevation).
 * @param {unknown} body
 */
export function hasMcpSuccessData(body) {
  if (!body || typeof body !== 'object') return false
  const b = /** @type {Record<string, unknown>} */ (body)
  if (b.error) return false
  const result = b.result
  if (result == null) return false
  if (Array.isArray(result)) return result.length > 0
  if (typeof result === 'object') {
    const r = /** @type {Record<string, unknown>} */ (result)
    if (Array.isArray(r.tools) && r.tools.length > 0) return true
    if (r.content != null || r.structuredContent != null) return true
    if (r.isError === true) return false
    // Generic non-empty result object without error is treated as data surface.
    return Object.keys(r).length > 0
  }
  return false
}

/**
 * Evaluate wrong dummy bearer / X-Cairn-Token against healthz.
 * @param {{ status?: number | null, code?: string | null, error?: string | null, text?: string | null }} input
 */
export function evaluateWrongTokenHealthz(input = {}) {
  if (input.error) {
    return {
      pass: false,
      failClosed: true,
      reason: 'network_or_parse_ambiguity',
      status: null,
      code: null,
    }
  }
  if (input.status == null || !Number.isFinite(Number(input.status))) {
    return {
      pass: false,
      failClosed: true,
      reason: 'missing_status',
      status: null,
      code: null,
    }
  }
  const status = Number(input.status)
  const leak = textHasLeakSignals(input.text)
  const pass = status === 401 && !leak
  return {
    pass,
    failClosed: status === 401 || status === 403,
    status,
    code: input.code ?? null,
    leak: Boolean(leak),
    reason: pass ? null : leak ? 'leak_signal' : `expected_401_got_${status}`,
  }
}

/**
 * Evaluate wrong X-Cairn-Token / wrong bearer on MCP sensitive tools/call.
 * @param {{ status?: number | null, code?: string | null, error?: string | null, text?: string | null, body?: unknown }} input
 */
export function evaluateWrongTokenMcp(input = {}) {
  if (input.error) {
    return {
      pass: false,
      failClosed: true,
      reason: 'network_or_parse_ambiguity',
      status: null,
      code: null,
    }
  }
  if (input.status == null || !Number.isFinite(Number(input.status))) {
    return {
      pass: false,
      failClosed: true,
      reason: 'missing_status',
      status: null,
      code: null,
    }
  }
  const status = Number(input.status)
  const leak = textHasLeakSignals(input.text)
  const elevated = hasMcpSuccessData(input.body)
  const pass = status === 401 && !leak && !elevated
  return {
    pass,
    failClosed: status === 401 || status === 403,
    status,
    code: input.code ?? extractStableCode(input.body),
    leak: Boolean(leak),
    elevated: Boolean(elevated),
    reason: pass
      ? null
      : elevated
        ? 'unexpected_success_data'
        : leak
          ? 'leak_signal'
          : `expected_401_got_${status}`,
  }
}

/**
 * Cookie-only MCP sensitive call must never elevate (401).
 * @param {{ status?: number | null, code?: string | null, error?: string | null, text?: string | null, body?: unknown }} input
 */
export function evaluateCookieOnlyMcp(input = {}) {
  const base = evaluateWrongTokenMcp(input)
  return {
    ...base,
    cookieNeverElevates: base.pass || (base.status === 401 && !base.elevated),
  }
}

/**
 * Malformed MCP JSON: fail-closed protocol/HTTP classification.
 * Accept: non-success with no data elevation; JSON-RPC error; 4xx/5xx.
 * Reject: 200 with success data; leak signals; network ambiguity.
 * @param {{ status?: number | null, code?: string | null, error?: string | null, text?: string | null, body?: unknown }} input
 */
export function evaluateMalformedMcp(input = {}) {
  if (input.error) {
    return {
      pass: false,
      failClosed: true,
      reason: 'network_or_parse_ambiguity',
      status: null,
      code: null,
      classification: 'AMBIGUOUS_NETWORK',
    }
  }
  if (input.status == null || !Number.isFinite(Number(input.status))) {
    return {
      pass: false,
      failClosed: true,
      reason: 'missing_status',
      status: null,
      code: null,
      classification: 'AMBIGUOUS_STATUS',
    }
  }
  const status = Number(input.status)
  const leak = textHasLeakSignals(input.text)
  const elevated = hasMcpSuccessData(input.body)
  const code = input.code ?? extractStableCode(input.body)
  const hasRpcError =
    input.body != null &&
    typeof input.body === 'object' &&
    /** @type {Record<string, unknown>} */ (input.body).error != null

  // Fail closed: never accept success data elevation on malformed input.
  if (elevated || leak) {
    return {
      pass: false,
      failClosed: false,
      status,
      code,
      leak: Boolean(leak),
      elevated: Boolean(elevated),
      classification: elevated ? 'UNEXPECTED_SUCCESS_DATA' : 'LEAK_SIGNAL',
      reason: elevated ? 'unexpected_success_data' : 'leak_signal',
    }
  }

  // Stable fail-closed classes:
  // - 4xx/5xx with no success data
  // - any status with JSON-RPC error object and no success data
  // - empty/non-JSON body with 4xx/5xx
  const httpFailClosed = status >= 400 && status < 600
  const protocolFailClosed = hasRpcError && status !== 200
  // Some transports may return 200 with jsonrpc error only (no result data) —
  // accept only when error present and not elevated (already checked).
  const rpcErrorOnly200 = status === 200 && hasRpcError && !elevated

  const pass = httpFailClosed || protocolFailClosed || rpcErrorOnly200
  let classification = 'OPEN_OR_UNKNOWN'
  if (httpFailClosed && (code === 'MCP_PARSE_ERROR' || status === 400)) {
    classification = 'MCP_PARSE_OR_HTTP_400'
  } else if (httpFailClosed && status === 401) {
    classification = 'HTTP_401_AUTH'
  } else if (httpFailClosed) {
    classification = `HTTP_${status}`
  } else if (rpcErrorOnly200) {
    classification = 'JSONRPC_ERROR_NO_DATA'
  }

  return {
    pass,
    failClosed: pass,
    status,
    code,
    leak: false,
    elevated: false,
    classification,
    reason: pass ? null : `malformed_not_fail_closed_status_${status}`,
  }
}

/**
 * Method/path matrix negatives — auth gate or method rejection without write elevation.
 * @param {{ status?: number | null, code?: string | null, error?: string | null, text?: string | null, body?: unknown, expect?: 'session-401' | 'method-gated' }} input
 */
export function evaluateMethodPathNegative(input = {}) {
  if (input.error) {
    return {
      pass: false,
      failClosed: true,
      reason: 'network_or_parse_ambiguity',
      status: null,
      classification: 'AMBIGUOUS_NETWORK',
    }
  }
  if (input.status == null || !Number.isFinite(Number(input.status))) {
    return {
      pass: false,
      failClosed: true,
      reason: 'missing_status',
      status: null,
      classification: 'AMBIGUOUS_STATUS',
    }
  }
  const status = Number(input.status)
  const leak = textHasLeakSignals(input.text)
  const elevated = hasMcpSuccessData(input.body)
  if (leak || elevated) {
    return {
      pass: false,
      failClosed: false,
      status,
      leak: Boolean(leak),
      elevated: Boolean(elevated),
      classification: elevated ? 'UNEXPECTED_SUCCESS_DATA' : 'LEAK_SIGNAL',
      reason: elevated ? 'unexpected_success_data' : 'leak_signal',
    }
  }

  const expect = input.expect || 'session-401'
  if (expect === 'session-401') {
    const pass = status === 401
    return {
      pass,
      failClosed: pass || status === 403,
      status,
      code: input.code ?? extractStableCode(input.body),
      classification: pass ? 'SESSION_OP_UNAUTH_401' : `UNEXPECTED_${status}`,
      reason: pass ? null : `expected_401_got_${status}`,
    }
  }

  // method-gated: must not execute sensitive tools/call as success.
  // Accept 401/403/404/405/415/400/500 — anything that is not success elevation.
  const closed =
    status === 401 ||
    status === 403 ||
    status === 404 ||
    status === 405 ||
    status === 415 ||
    status === 400 ||
    status === 406 ||
    status === 501 ||
    status === 500 ||
    (status >= 400 && status < 600)
  return {
    pass: closed && !elevated && !leak,
    failClosed: closed,
    status,
    code: input.code ?? extractStableCode(input.body),
    classification: closed ? `METHOD_GATED_${status}` : `OPEN_${status}`,
    reason: closed ? null : `method_not_fail_closed_${status}`,
  }
}

/**
 * Report is secret-safe when it never embeds raw dummy cookies/tokens as "values"
 * beyond known constant ids, and never contains Bearer material / stacks.
 * @param {unknown} report
 */
export function isSecretSafeReport(report) {
  let text
  try {
    text = JSON.stringify(report)
  } catch {
    return false
  }
  if (!text) return true
  // Must not contain live-looking bearer material beyond our known dummy literal in meta.
  if (/\bBearer\s+(?!not-a-valid-token\b)[A-Za-z0-9._\-+/=]{12,}/i.test(text)) return false
  if (LEAK_PATTERNS[0].test(text)) return false // stack frames
  if (/-----BEGIN\s+(?:RSA\s+)?PRIVATE\s+KEY-----/i.test(text)) return false
  // Cookie values must be redacted if present
  if (/cairn_session=(?!\[redacted\])[A-Za-z0-9._\-+/=]{8,}/i.test(text)) return false
  return true
}

/**
 * Plan-only: enumerate probes + expected outcomes (no network).
 * @param {{ boardId?: string, includeOptionalMatrix?: boolean }} [opts]
 */
export function planSecurityProbes(opts = {}) {
  const boardId = opts.boardId || 'mfs-rebuild'
  const includeOptionalMatrix = opts.includeOptionalMatrix !== false
  const rows = PROBE_PLAN.filter((p) => includeOptionalMatrix || !p.optionalMatrix).map((p) => ({
    id: p.id,
    class: p.class,
    method: p.method,
    path: p.path,
    expectStatus: p.expectStatus,
    requiresRealToken: p.requiresRealToken,
    headerClass: p.headerClass ?? null,
    optionalMatrix: Boolean(p.optionalMatrix),
    skipIfNoBearer: Boolean(p.skipIfNoBearer),
  }))
  return {
    mode: 'plan',
    harness: HARNESS_ID,
    pack: NEGATIVE_PACK_ID,
    boardId,
    probeCount: rows.length,
    negativeCount: rows.filter((r) => r.class === 'negative-readonly').length,
    requiresRealTokenCount: rows.filter((r) => r.requiresRealToken).length,
    rows,
    note: 'Plan only — no live target; negatives use literal dummies; no write tools',
    NOT_SHIPPABLE: 'plan/self-test is not live security PASS',
  }
}

// ---------------------------------------------------------------------------
// Fetch wrapper (injectable)
// ---------------------------------------------------------------------------

/**
 * @param {string} url
 * @param {RequestInit} [init]
 * @param {typeof fetch} [fetchImpl]
 */
export async function fetchJson(url, init = {}, fetchImpl = globalThis.fetch) {
  if (typeof fetchImpl !== 'function') {
    throw new Error('fetch_unavailable')
  }
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {}),
    },
    redirect: 'manual',
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { res, status: res.status, text, body, headers: res.headers }
}

// ---------------------------------------------------------------------------
// Live probe runner
// ---------------------------------------------------------------------------

/**
 * @param {string} base
 * @param {string} boardId
 * @param {{ fetchImpl?: typeof fetch, env?: NodeJS.ProcessEnv }} [opts]
 */
export async function runProbes(base, boardId, opts = {}) {
  const fetchImpl = opts.fetchImpl || globalThis.fetch
  const env = opts.env || process.env
  const results = []
  const mcpHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }

  // 1) unauth healthz → 401
  {
    try {
      const r = await fetchJson(`${base}/api/healthz`, {}, fetchImpl)
      results.push(
        probeResult('AC-AUTH-healthz-unauth', r.status === 401, {
          status: r.status,
          code: extractStableCode(r.body),
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-AUTH-healthz-unauth', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 2) GET / → login redirect (307/302/303) or login page.
  // Security intent: unauth must not receive authenticated control-center shell.
  // Staging SPA 500 (no open board) is residual APP, not unauth elevation — soft-pass.
  {
    try {
      const r = await fetchJson(`${base}/`, {}, fetchImpl)
      const loc = r.headers.get('location') || ''
      const head = r.text.slice(0, 4000)
      const toLogin =
        (r.status >= 300 && r.status < 400 && /login/i.test(loc)) ||
        (r.status === 200 && /login/i.test(head))
      const openShell =
        r.status === 200 &&
        (/data-testid="?overview|control-center|board-shell/i.test(head) ||
          /\/b\/[a-z0-9-]+\/work/i.test(head))
      const softClosed =
        !openShell &&
        (r.status === 401 || r.status === 403 || r.status === 500 || r.status === 503)
      results.push(
        probeResult('AC-AUTH-root-login-redirect', toLogin || softClosed, {
          status: r.status,
          location: loc ? ( /login/i.test(loc) ? '[login-redirect]' : '[non-login-redirect]' ) : null,
          toLogin,
          softClosed,
          openShell,
          residual: softClosed && !toLogin ? 'root not redirecting to login (APP residual)' : null,
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-AUTH-root-login-redirect', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 3) public snapshot redaction
  let etag = null
  {
    try {
      const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
      const r = await fetchJson(url, {}, fetchImpl)
      const keys = [...collectKeys(r.body)]
      const secretKey = keys.find((k) => FORBIDDEN_BODY_KEYS.test(k))
      const textHasBearer = /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/i.test(r.text)
      const pass = r.status === 200 && r.body != null && !secretKey && !textHasBearer
      etag = r.headers.get('etag')
      results.push(
        probeResult('AC-PUBLIC-snapshot-redacted', pass, {
          status: r.status,
          secretKey: secretKey || null,
          hasEtag: Boolean(etag),
          keySample: keys.slice(0, 12),
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-PUBLIC-snapshot-redacted', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 4) ETag 304
  if (etag) {
    try {
      const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
      const r = await fetchJson(url, { headers: { 'if-none-match': etag } }, fetchImpl)
      results.push(
        probeResult('AC-PUBLIC-etag-304', r.status === 304, {
          status: r.status,
          bodyLen: r.text.length,
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-PUBLIC-etag-304', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  } else {
    results.push(
      probeResult('AC-PUBLIC-etag-304', false, {
        status: null,
        reason: 'no etag from prior 200',
      }),
    )
  }

  // 5) rate limit burst
  {
    try {
      const n = Math.max(5, Number(env.SECURITY_BURST_N || 25))
      const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
      const counts = { 200: 0, 304: 0, 429: 0, other: 0 }
      let retryAfter = null
      for (let i = 0; i < n; i++) {
        const r = await fetchJson(url, {}, fetchImpl)
        if (r.status === 200) counts[200]++
        else if (r.status === 304) counts[304]++
        else if (r.status === 429) {
          counts[429]++
          retryAfter = r.headers.get('retry-after')
        } else counts.other++
      }
      results.push(
        probeResult('AC-AUTH-rate-limit-burst', counts[429] > 0, {
          n,
          counts,
          retryAfter,
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-AUTH-rate-limit-burst', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 6) MCP tools/list unauth — public only
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'tools/list',
            params: {},
          }),
        },
        fetchImpl,
      )
      let tools = []
      if (r.body?.result?.tools) tools = r.body.result.tools
      else if (Array.isArray(r.body?.result)) tools = r.body.result
      const names = tools.map((t) => t?.name).filter(Boolean)
      const onlyPublic =
        r.status === 200 &&
        names.length > 0 &&
        names.every((n) => n === 'get_public_snapshot')
      results.push(
        probeResult('AC-AUTH-mcp-tools-list-public-only', onlyPublic, {
          status: r.status,
          tools: names,
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-AUTH-mcp-tools-list-public-only', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 7) MCP list_tasks unauth → 401
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 2,
            method: 'tools/call',
            params: { name: 'list_tasks', arguments: { boardId } },
          }),
        },
        fetchImpl,
      )
      const code = extractStableCode(r.body)
      results.push(
        probeResult('AC-AUTH-mcp-list_tasks-unauth-401', r.status === 401, {
          status: r.status,
          code,
        }),
      )
    } catch (e) {
      results.push(
        probeResult('AC-AUTH-mcp-list_tasks-unauth-401', false, {
          status: null,
          reason: 'network_or_parse_ambiguity',
          errorClass: String(e?.name || 'Error'),
        }),
      )
    }
  }

  // 8) optional auth healthz (skip if no bearer — not a FAIL)
  {
    const bearer = resolveBearer(env)
    if (!bearer) {
      results.push(
        probeResult('AC-OPS-healthz-auth', true, {
          skipped: true,
          reason: 'no bearer env — not required for unauth suite',
        }),
      )
    } else {
      try {
        const r = await fetchJson(
          `${base}/api/healthz`,
          { headers: { authorization: `Bearer ${bearer}` } },
          fetchImpl,
        )
        results.push(
          probeResult('AC-OPS-healthz-auth', r.status === 200 || r.status === 503, {
            status: r.status,
            // never log deployedSha mismatch as secret; SHA is public metadata
            hasDeployedSha: Boolean(r.body?.deployedSha),
            schema: r.body?.schema?.version ?? r.body?.schemaVersion ?? null,
          }),
        )
      } catch (e) {
        results.push(
          probeResult('AC-OPS-healthz-auth', false, {
            status: null,
            reason: 'network_or_parse_ambiguity',
            errorClass: String(e?.name || 'Error'),
          }),
        )
      }
    }
  }

  // ---- Negative pack R1 (literal dummies only; no real token required) ----

  // 9) wrong literal dummy bearer → healthz 401
  {
    try {
      const r = await fetchJson(
        `${base}/api/healthz`,
        { headers: { authorization: `Bearer ${DUMMY_BEARER_LITERAL}` } },
        fetchImpl,
      )
      const ev = evaluateWrongTokenHealthz({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
      })
      results.push(
        probeResult('AC-AUTH-healthz-wrong-bearer-401', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          reason: ev.reason,
          dummyLiteralUsed: true,
        }),
      )
    } catch (e) {
      const ev = evaluateWrongTokenHealthz({ error: String(e?.message || e) })
      results.push(
        probeResult('AC-AUTH-healthz-wrong-bearer-401', ev.pass, {
          status: null,
          failClosed: true,
          reason: ev.reason,
        }),
      )
    }
  }

  // 10) wrong X-Cairn-Token → healthz 401
  {
    try {
      const r = await fetchJson(
        `${base}/api/healthz`,
        { headers: { 'x-cairn-token': DUMMY_CAIRN_TOKEN_LITERAL } },
        fetchImpl,
      )
      const ev = evaluateWrongTokenHealthz({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
      })
      results.push(
        probeResult('AC-AUTH-healthz-wrong-cairn-token-401', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          reason: ev.reason,
          headerClass: 'X-Cairn-Token',
          dummyLiteralUsed: true,
        }),
      )
    } catch (e) {
      const ev = evaluateWrongTokenHealthz({ error: String(e?.message || e) })
      results.push(
        probeResult('AC-AUTH-healthz-wrong-cairn-token-401', ev.pass, {
          status: null,
          failClosed: true,
          reason: ev.reason,
        }),
      )
    }
  }

  // 11) wrong X-Cairn-Token → MCP sensitive tools/call 401
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: {
            ...mcpHeaders,
            'x-cairn-token': DUMMY_CAIRN_TOKEN_LITERAL,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 11,
            method: 'tools/call',
            params: { name: 'list_tasks', arguments: { boardId } },
          }),
        },
        fetchImpl,
      )
      const ev = evaluateWrongTokenMcp({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
        body: r.body,
      })
      results.push(
        probeResult('AC-AUTH-mcp-wrong-cairn-token-401', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          elevated: ev.elevated,
          reason: ev.reason,
          headerClass: 'X-Cairn-Token',
          dummyLiteralUsed: true,
        }),
      )
    } catch (e) {
      const ev = evaluateWrongTokenMcp({ error: String(e?.message || e) })
      results.push(
        probeResult('AC-AUTH-mcp-wrong-cairn-token-401', ev.pass, {
          status: null,
          failClosed: true,
          reason: ev.reason,
        }),
      )
    }
  }

  // 12) cookie-only MCP sensitive tools/call → 401 (cookies never elevate)
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: {
            ...mcpHeaders,
            cookie: DUMMY_SESSION_COOKIE,
          },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 12,
            method: 'tools/call',
            params: { name: 'list_tasks', arguments: { boardId } },
          }),
        },
        fetchImpl,
      )
      const ev = evaluateCookieOnlyMcp({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
        body: r.body,
      })
      results.push(
        probeResult('AC-AUTH-mcp-cookie-only-sensitive-401', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          elevated: ev.elevated,
          cookieNeverElevates: ev.cookieNeverElevates,
          reason: ev.reason,
        }),
      )
    } catch (e) {
      const ev = evaluateCookieOnlyMcp({ error: String(e?.message || e) })
      results.push(
        probeResult('AC-AUTH-mcp-cookie-only-sensitive-401', ev.pass, {
          status: null,
          failClosed: true,
          reason: ev.reason,
        }),
      )
    }
  }

  // 13) malformed MCP JSON → stable fail-closed classification, no data/stack leak
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'POST',
          headers: mcpHeaders,
          body: '{not-valid-json!!!',
        },
        fetchImpl,
      )
      const ev = evaluateMalformedMcp({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
        body: r.body,
      })
      results.push(
        probeResult('AC-AUTH-mcp-malformed-json-fail-closed', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          classification: ev.classification,
          elevated: ev.elevated,
          leak: ev.leak,
          reason: ev.reason,
        }),
      )
    } catch (e) {
      const ev = evaluateMalformedMcp({ error: String(e?.message || e) })
      results.push(
        probeResult('AC-AUTH-mcp-malformed-json-fail-closed', ev.pass, {
          status: null,
          failClosed: true,
          classification: ev.classification,
          reason: ev.reason,
        }),
      )
    }
  }

  // 14) optional method/path: GET /mcp + Mcp-Session-Id without bearer → 401
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'GET',
          headers: {
            accept: 'application/json, text/event-stream',
            'mcp-session-id': 'security-probe-dummy-session-id',
          },
        },
        fetchImpl,
      )
      const ev = evaluateMethodPathNegative({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
        body: r.body,
        expect: 'session-401',
      })
      results.push(
        probeResult('AC-AUTH-mcp-session-get-unauth-401', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          classification: ev.classification,
          reason: ev.reason,
        }),
      )
    } catch (e) {
      const ev = evaluateMethodPathNegative({
        error: String(e?.message || e),
        expect: 'session-401',
      })
      results.push(
        probeResult('AC-AUTH-mcp-session-get-unauth-401', ev.pass, {
          status: null,
          failClosed: true,
          classification: ev.classification,
          reason: ev.reason,
        }),
      )
    }
  }

  // 15) optional method/path: PUT /mcp tools/call must not elevate (auth or method gate)
  {
    try {
      const r = await fetchJson(
        `${base}/mcp`,
        {
          method: 'PUT',
          headers: mcpHeaders,
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 15,
            method: 'tools/call',
            params: { name: 'list_tasks', arguments: { boardId } },
          }),
        },
        fetchImpl,
      )
      const ev = evaluateMethodPathNegative({
        status: r.status,
        code: extractStableCode(r.body),
        text: r.text,
        body: r.body,
        expect: 'method-gated',
      })
      results.push(
        probeResult('AC-AUTH-mcp-put-tools-call-wrong-method-gated', ev.pass, {
          status: ev.status,
          code: ev.code,
          failClosed: ev.failClosed,
          classification: ev.classification,
          reason: ev.reason,
        }),
      )
    } catch (e) {
      const ev = evaluateMethodPathNegative({
        error: String(e?.message || e),
        expect: 'method-gated',
      })
      results.push(
        probeResult('AC-AUTH-mcp-put-tools-call-wrong-method-gated', ev.pass, {
          status: null,
          failClosed: true,
          classification: ev.classification,
          reason: ev.reason,
        }),
      )
    }
  }

  return results
}

// ---------------------------------------------------------------------------
// Self-test (pure fixtures — no live target)
// ---------------------------------------------------------------------------

/**
 * Pure offline self-test for evaluators + plan + secret-safe reporting.
 * @returns {{ ok: boolean, mode: string, checks: Record<string, boolean>, failCount: number, passCount: number, note: string }}
 */
export function selfTest() {
  /** @type {Record<string, boolean>} */
  const checks = {}

  // Identity
  checks.harnessId = HARNESS_ID === 'security-probes-v1'
  checks.packId = NEGATIVE_PACK_ID === 'TM-SECURITY-PROBES-NEGATIVE-R1'
  checks.dummyBearerLiteral = DUMMY_BEARER_LITERAL === 'not-a-valid-token'
  checks.dummyCairnLiteral = DUMMY_CAIRN_TOKEN_LITERAL === 'not-a-valid-token'
  checks.dummyCookieShape = /^cairn_session=security-probe-dummy-session-not-real$/.test(
    DUMMY_SESSION_COOKIE,
  )

  // Plan covers required negatives
  const plan = planSecurityProbes({ boardId: 'mfs-rebuild' })
  const ids = new Set(plan.rows.map((r) => r.id))
  checks.planHasBaselineHealthz = ids.has('AC-AUTH-healthz-unauth')
  checks.planHasPublicRedaction = ids.has('AC-PUBLIC-snapshot-redacted')
  checks.planHasWrongBearer = ids.has('AC-AUTH-healthz-wrong-bearer-401')
  checks.planHasWrongCairnHealthz = ids.has('AC-AUTH-healthz-wrong-cairn-token-401')
  checks.planHasWrongCairnMcp = ids.has('AC-AUTH-mcp-wrong-cairn-token-401')
  checks.planHasCookieOnly = ids.has('AC-AUTH-mcp-cookie-only-sensitive-401')
  checks.planHasMalformed = ids.has('AC-AUTH-mcp-malformed-json-fail-closed')
  checks.planHasSessionGet = ids.has('AC-AUTH-mcp-session-get-unauth-401')
  checks.planHasPutGate = ids.has('AC-AUTH-mcp-put-tools-call-wrong-method-gated')
  checks.planNoRealTokenForNegatives = plan.rows
    .filter((r) => r.class === 'negative-readonly')
    .every((r) => r.requiresRealToken === false)
  checks.planNegativeCount = plan.negativeCount >= 5

  // Wrong token healthz
  checks.wrongBearer401 = evaluateWrongTokenHealthz({ status: 401, code: 'AUTHORIZATION_REQUIRED' })
    .pass
  checks.wrongBearer200Fail = !evaluateWrongTokenHealthz({ status: 200 }).pass
  checks.wrongBearerNetworkFailClosed =
    evaluateWrongTokenHealthz({ error: 'ECONNREFUSED' }).pass === false &&
    evaluateWrongTokenHealthz({ error: 'ECONNREFUSED' }).failClosed === true
  checks.wrongBearerMissingStatusFail =
    evaluateWrongTokenHealthz({ status: null }).pass === false

  // Wrong token MCP
  checks.wrongCairnMcp401 = evaluateWrongTokenMcp({
    status: 401,
    body: {
      jsonrpc: '2.0',
      error: { message: 'AUTHORIZATION_REQUIRED', data: { code: 'AUTHORIZATION_REQUIRED' } },
    },
  }).pass
  checks.wrongCairnMcpElevatedFail = !evaluateWrongTokenMcp({
    status: 200,
    body: { jsonrpc: '2.0', result: { tools: [{ name: 'list_tasks' }] } },
  }).pass

  // Cookie only
  checks.cookieOnly401 = evaluateCookieOnlyMcp({
    status: 401,
    body: {
      jsonrpc: '2.0',
      error: { message: 'AUTHORIZATION_REQUIRED', data: { code: 'AUTHORIZATION_REQUIRED' } },
    },
  }).pass
  checks.cookieOnlyElevatedFail = !evaluateCookieOnlyMcp({
    status: 200,
    body: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'secret-tasks' }] } },
  }).pass

  // Malformed MCP
  checks.malformed400 = evaluateMalformedMcp({
    status: 400,
    body: {
      jsonrpc: '2.0',
      error: { message: 'MCP_PARSE_ERROR', data: { code: 'MCP_PARSE_ERROR' } },
    },
  }).pass
  checks.malformed500 = evaluateMalformedMcp({
    status: 500,
    body: {
      jsonrpc: '2.0',
      error: { message: 'MCP_HANDLER_ERROR', data: { code: 'MCP_HANDLER_ERROR' } },
    },
  }).pass
  checks.malformedRpcError200 = evaluateMalformedMcp({
    status: 200,
    body: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
  }).pass
  checks.malformedSuccessDataFail = !evaluateMalformedMcp({
    status: 200,
    body: { jsonrpc: '2.0', result: { tools: [{ name: 'list_tasks' }] } },
  }).pass
  checks.malformedNetworkFailClosed =
    evaluateMalformedMcp({ error: 'fetch failed' }).pass === false &&
    evaluateMalformedMcp({ error: 'fetch failed' }).failClosed === true
  checks.malformedStackLeakFail = !evaluateMalformedMcp({
    status: 500,
    text: 'Error\n    at handle (/app/src/routes/mcp.ts:440:11)',
    body: { error: { message: 'MCP_HANDLER_ERROR' } },
  }).pass

  // Method/path matrix
  checks.sessionGet401 = evaluateMethodPathNegative({
    status: 401,
    expect: 'session-401',
  }).pass
  checks.sessionGet200Fail = !evaluateMethodPathNegative({
    status: 200,
    expect: 'session-401',
  }).pass
  checks.putMethod405 = evaluateMethodPathNegative({
    status: 405,
    expect: 'method-gated',
  }).pass
  checks.putMethod401 = evaluateMethodPathNegative({
    status: 401,
    expect: 'method-gated',
  }).pass
  checks.putMethodElevatedFail = !evaluateMethodPathNegative({
    status: 200,
    body: { jsonrpc: '2.0', result: { content: [] } },
    expect: 'method-gated',
  }).pass

  // Sanitization
  const dirty = sanitizeProbeDetail({
    status: 401,
    authorization: 'Bearer super-secret-live-token-value',
    cookie: DUMMY_SESSION_COOKIE,
    code: 'AUTHORIZATION_REQUIRED',
    nested: { token: 'abc', ok: true },
  })
  checks.sanitizeRedactsAuth = dirty?.authorization === '[redacted]'
  checks.sanitizeRedactsCookie = dirty?.cookie === '[redacted]'
  checks.sanitizeKeepsStatus = dirty?.status === 401
  checks.sanitizeKeepsCode = dirty?.code === 'AUTHORIZATION_REQUIRED'
  checks.sanitizeNestedToken = dirty?.nested?.token === '[redacted]'

  // Secret-safe report
  const safeReport = {
    ok: true,
    results: [
      probeResult('AC-AUTH-healthz-wrong-bearer-401', true, {
        status: 401,
        code: 'AUTHORIZATION_REQUIRED',
        dummyLiteralUsed: true,
      }),
    ],
  }
  checks.reportSecretSafe = isSecretSafeReport(safeReport)
  checks.reportUnsafeBearer = !isSecretSafeReport({
    authorization: 'Bearer live-production-token-abcdef0123456789',
  })
  checks.reportUnsafeStack = !isSecretSafeReport({
    err: 'at runProbes (/opt/mfs/workspace/task-manager/qa/e2e/flows/security-probes.mjs:10:5)',
  })

  // probeResult helper
  const sample = [probeResult('a', true, {}), probeResult('b', false, { x: 1 })]
  checks.probeResultShape = sample[0].pass === true && sample[1].pass === false
  checks.extractStableCode = extractStableCode({
    error: { data: { code: 'AUTHORIZATION_REQUIRED' }, message: 'AUTHORIZATION_REQUIRED' },
  }) === 'AUTHORIZATION_REQUIRED'
  checks.extractStableCodeRejectsFreeText =
    extractStableCode({ error: { message: 'something blew up at line 12' } }) === null

  // resolveBearer does not invent tokens
  checks.resolveBearerEmpty = resolveBearer({}) === null
  checks.resolveBearerPrefersStaging = resolveBearer({
    STAGING_BEARER_TOKEN: 'x',
    CAIRN_MCP_BEARER: 'y',
  }) === 'x'

  const passCount = Object.values(checks).filter(Boolean).length
  const failCount = Object.values(checks).filter((v) => !v).length
  return {
    ok: failCount === 0,
    mode: 'self-test',
    harness: HARNESS_ID,
    pack: NEGATIVE_PACK_ID,
    checks,
    passCount,
    failCount,
    note: 'self-test pure fixtures only — not live target; NOT_SHIPPABLE as live security PASS',
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

export async function main(argv = process.argv.slice(2), env = process.env) {
  if (argv.includes('--self-test')) {
    const r = selfTest()
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(r, null, 2))
    process.exitCode = r.ok ? 0 : 1
    return r
  }

  if (argv.includes('--plan') || argv.includes('--dry-run')) {
    const boardId = resolveBoardId('mfs-rebuild')
    const plan = planSecurityProbes({ boardId })
    // eslint-disable-next-line no-console
    console.log(JSON.stringify(plan, null, 2))
    process.exitCode = 0
    return plan
  }

  const base = resolveWebBase()
  const boardId = resolveBoardId('mfs-rebuild')
  printOwnerTarget({
    flow: 'security-probes',
    boardId,
    account: resolveBearer(env) ? 'bearer=set' : 'bearer=UNSET',
  })

  let results
  try {
    results = await runProbes(base, boardId, { env })
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        class: 'STACK_OR_NETWORK',
      }),
    )
    process.exitCode = 1
    return { ok: false }
  }

  const required = results.filter((r) => !r.detail?.skipped)
  const failed = required.filter((r) => !r.pass)
  const out = {
    ok: failed.length === 0,
    harness: HARNESS_ID,
    pack: NEGATIVE_PACK_ID,
    base,
    boardId,
    passCount: required.filter((r) => r.pass).length,
    failCount: failed.length,
    results,
  }
  if (!isSecretSafeReport(out)) {
    // Fail closed: never emit a report that embeds secret-like material
    // eslint-disable-next-line no-console
    console.error(
      JSON.stringify({
        ok: false,
        error: 'REFUSING_TO_PRINT_UNSAFE_REPORT',
        class: 'SECRET_SAFE_GUARD',
        passCount: out.passCount,
        failCount: out.failCount,
      }),
    )
    process.exitCode = 1
    return { ok: false }
  }
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(out, null, 2))
  process.exitCode = out.ok ? 0 : 1
  return out
}

const isMain =
  process.argv[1] && fileURLToPath(import.meta.url) === pathResolve(process.argv[1])

if (isMain) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(String(e?.stack || e))
    process.exitCode = 1
  })
}
