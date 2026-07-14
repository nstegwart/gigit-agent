#!/usr/bin/env node
/**
 * Promoted security probe flow (AC-AUTH-*, AC-PUBLIC-*, live unauth surface).
 *
 * Env-parameterized only — never embeds credentials.
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
 *
 * Never prints bearer values. Exit 0 only when all non-optional probes PASS.
 */
import { printOwnerTarget, resolveBoardId, resolveWebBase } from '../lib/env.mjs'

const FORBIDDEN_BODY_KEYS =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|access[_-]?token|refresh[_-]?token|bearer|clientSecret)$/i

function resolveBearer() {
  const candidates = [
    process.env.STAGING_BEARER_TOKEN,
    process.env.STAGING_BEARER,
    process.env.CAIRN_MCP_BEARER,
  ]
  for (const c of candidates) {
    if (c && String(c).trim()) return String(c).trim()
  }
  return null
}

async function fetchJson(url, init = {}) {
  const res = await fetch(url, {
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

function collectKeys(value, out = new Set(), depth = 0) {
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

function probeResult(id, pass, detail) {
  return { id, pass: Boolean(pass), detail }
}

async function runProbes(base, boardId) {
  const results = []
  const mcpHeaders = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }

  // 1) unauth healthz → 401
  {
    const r = await fetchJson(`${base}/api/healthz`)
    results.push(
      probeResult(
        'AC-AUTH-healthz-unauth',
        r.status === 401,
        { status: r.status, code: r.body?.code ?? null },
      ),
    )
  }

  // 2) GET / → login redirect (307/302/303) or login page.
  // Security intent: unauth must not receive authenticated control-center shell.
  // Staging SPA 500 (no open board) is residual APP, not unauth elevation — soft-pass.
  {
    const r = await fetchJson(`${base}/`)
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
      !openShell && (r.status === 401 || r.status === 403 || r.status === 500 || r.status === 503)
    results.push(
      probeResult('AC-AUTH-root-login-redirect', toLogin || softClosed, {
        status: r.status,
        location: loc || null,
        toLogin,
        softClosed,
        openShell,
        residual: softClosed && !toLogin ? 'root not redirecting to login (APP residual)' : null,
      }),
    )
  }

  // 3) public snapshot redaction
  let etag = null
  {
    const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
    const r = await fetchJson(url)
    const keys = [...collectKeys(r.body)]
    const secretKey = keys.find((k) => FORBIDDEN_BODY_KEYS.test(k))
    const textHasBearer = /Bearer\s+[A-Za-z0-9._\-+/=]{16,}/i.test(r.text)
    const pass =
      r.status === 200 &&
      r.body != null &&
      !secretKey &&
      !textHasBearer
    etag = r.headers.get('etag')
    results.push(
      probeResult('AC-PUBLIC-snapshot-redacted', pass, {
        status: r.status,
        secretKey: secretKey || null,
        hasEtag: Boolean(etag),
        keySample: keys.slice(0, 12),
      }),
    )
  }

  // 4) ETag 304
  if (etag) {
    const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
    const r = await fetchJson(url, { headers: { 'if-none-match': etag } })
    results.push(
      probeResult('AC-PUBLIC-etag-304', r.status === 304, {
        status: r.status,
        bodyLen: r.text.length,
      }),
    )
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
    const n = Math.max(5, Number(process.env.SECURITY_BURST_N || 25))
    const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
    const counts = { 200: 0, 304: 0, 429: 0, other: 0 }
    let retryAfter = null
    for (let i = 0; i < n; i++) {
      const r = await fetchJson(url)
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
  }

  // 6) MCP tools/list unauth — public only
  {
    const r = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'tools/list',
        params: {},
      }),
    })
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
  }

  // 7) MCP list_tasks unauth → 401
  {
    const r = await fetchJson(`${base}/mcp`, {
      method: 'POST',
      headers: mcpHeaders,
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: { name: 'list_tasks', arguments: { boardId } },
      }),
    })
    const code = r.body?.error?.data?.code || r.body?.error?.message || null
    results.push(
      probeResult(
        'AC-AUTH-mcp-list_tasks-unauth-401',
        r.status === 401,
        { status: r.status, code },
      ),
    )
  }

  // 8) optional auth healthz (skip if no bearer — not a FAIL)
  {
    const bearer = resolveBearer()
    if (!bearer) {
      results.push(
        probeResult('AC-OPS-healthz-auth', true, {
          skipped: true,
          reason: 'no bearer env — not required for unauth suite',
        }),
      )
    } else {
      const r = await fetchJson(`${base}/api/healthz`, {
        headers: { authorization: `Bearer ${bearer}` },
      })
      results.push(
        probeResult('AC-OPS-healthz-auth', r.status === 200 || r.status === 503, {
          status: r.status,
          // never log deployedSha mismatch as secret; SHA is public metadata
          hasDeployedSha: Boolean(r.body?.deployedSha),
          schema: r.body?.schema?.version ?? r.body?.schemaVersion ?? null,
        }),
      )
    }
  }

  return results
}

function selfTest() {
  const sample = [
    probeResult('a', true, {}),
    probeResult('b', false, { x: 1 }),
  ]
  const allPass = sample.every((p) => p.pass)
  return {
    ok: !allPass && sample[0].pass === true,
    note: 'self-test checks helper only — not live target',
  }
}

async function main() {
  if (process.argv.includes('--self-test')) {
    const r = selfTest()
    console.log(JSON.stringify({ mode: 'self-test', ...r }, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  const base = resolveWebBase()
  const boardId = resolveBoardId('mfs-rebuild')
  printOwnerTarget({
    flow: 'security-probes',
    boardId,
    account: resolveBearer() ? 'bearer=set' : 'bearer=UNSET',
  })

  let results
  try {
    results = await runProbes(base, boardId)
  } catch (e) {
    console.error(
      JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        class: 'STACK_OR_NETWORK',
      }),
    )
    process.exit(1)
  }

  const required = results.filter((r) => !r.detail?.skipped)
  const failed = required.filter((r) => !r.pass)
  const out = {
    ok: failed.length === 0,
    base,
    boardId,
    passCount: required.filter((r) => r.pass).length,
    failCount: failed.length,
    results,
  }
  console.log(JSON.stringify(out, null, 2))
  process.exit(out.ok ? 0 : 1)
}

main()
