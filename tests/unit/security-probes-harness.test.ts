/**
 * Focused unit suite for qa/e2e/flows/security-probes.mjs
 *
 * LOCAL ONLY — pure evaluators + plan + self-test. No live target, no real tokens,
 * no authenticated mutation.
 */
import { describe, expect, it } from 'vitest'

import {
  DUMMY_BEARER_LITERAL,
  DUMMY_CAIRN_TOKEN_LITERAL,
  DUMMY_SESSION_COOKIE,
  HARNESS_ID,
  NEGATIVE_PACK_ID,
  PROBE_PLAN,
  collectKeys,
  evaluateCookieOnlyMcp,
  evaluateMalformedMcp,
  evaluateMethodPathNegative,
  evaluateWrongTokenHealthz,
  evaluateWrongTokenMcp,
  extractStableCode,
  hasMcpSuccessData,
  isSecretSafeReport,
  planSecurityProbes,
  probeResult,
  resolveBearer,
  sanitizeProbeDetail,
  selfTest,
  textHasLeakSignals,
} from '../../qa/e2e/flows/security-probes.mjs'

describe('security-probes harness identity', () => {
  it('exports stable harness + pack ids and dummy literals', () => {
    expect(HARNESS_ID).toBe('security-probes-v1')
    expect(NEGATIVE_PACK_ID).toBe('TM-SECURITY-PROBES-NEGATIVE-R1')
    expect(DUMMY_BEARER_LITERAL).toBe('not-a-valid-token')
    expect(DUMMY_CAIRN_TOKEN_LITERAL).toBe('not-a-valid-token')
    expect(DUMMY_SESSION_COOKIE).toMatch(/^cairn_session=security-probe-dummy-session-not-real$/)
  })

  it('PROBE_PLAN includes baseline unauth + negative pack without real tokens for negatives', () => {
    const ids = PROBE_PLAN.map((p) => p.id)
    expect(ids).toContain('AC-AUTH-healthz-unauth')
    expect(ids).toContain('AC-PUBLIC-snapshot-redacted')
    expect(ids).toContain('AC-AUTH-healthz-wrong-bearer-401')
    expect(ids).toContain('AC-AUTH-healthz-wrong-cairn-token-401')
    expect(ids).toContain('AC-AUTH-mcp-wrong-cairn-token-401')
    expect(ids).toContain('AC-AUTH-mcp-cookie-only-sensitive-401')
    expect(ids).toContain('AC-AUTH-mcp-malformed-json-fail-closed')
    expect(ids).toContain('AC-AUTH-mcp-session-get-unauth-401')
    expect(ids).toContain('AC-AUTH-mcp-put-tools-call-wrong-method-gated')

    for (const row of PROBE_PLAN.filter((p) => p.class === 'negative-readonly')) {
      expect(row.requiresRealToken, row.id).toBe(false)
    }
  })
})

describe('planSecurityProbes', () => {
  it('returns plan-only rows with expected negative coverage', () => {
    const plan = planSecurityProbes({ boardId: 'mfs-rebuild' })
    expect(plan.mode).toBe('plan')
    expect(plan.NOT_SHIPPABLE).toBeTruthy()
    expect(plan.negativeCount).toBeGreaterThanOrEqual(5)
    expect(plan.rows.every((r) => typeof r.id === 'string')).toBe(true)
    expect(plan.rows.filter((r) => r.class === 'negative-readonly').every((r) => !r.requiresRealToken)).toBe(
      true,
    )
  })

  it('can omit optional method/path matrix', () => {
    const plan = planSecurityProbes({ includeOptionalMatrix: false })
    expect(plan.rows.some((r) => r.id === 'AC-AUTH-mcp-session-get-unauth-401')).toBe(false)
    expect(plan.rows.some((r) => r.id === 'AC-AUTH-healthz-wrong-bearer-401')).toBe(true)
  })
})

describe('evaluateWrongTokenHealthz', () => {
  it('passes only on 401 without leak signals', () => {
    expect(
      evaluateWrongTokenHealthz({ status: 401, code: 'AUTHORIZATION_REQUIRED' }).pass,
    ).toBe(true)
    expect(evaluateWrongTokenHealthz({ status: 200 }).pass).toBe(false)
    expect(evaluateWrongTokenHealthz({ status: 503 }).pass).toBe(false)
    expect(evaluateWrongTokenHealthz({ status: 403 }).pass).toBe(false)
  })

  it('fail-closes on network/parse ambiguity and missing status', () => {
    const net = evaluateWrongTokenHealthz({ error: 'ECONNREFUSED' })
    expect(net.pass).toBe(false)
    expect(net.failClosed).toBe(true)
    expect(net.reason).toBe('network_or_parse_ambiguity')

    const miss = evaluateWrongTokenHealthz({ status: null })
    expect(miss.pass).toBe(false)
    expect(miss.failClosed).toBe(true)
    expect(miss.reason).toBe('missing_status')
  })

  it('rejects leak signals in response text', () => {
    const r = evaluateWrongTokenHealthz({
      status: 401,
      text: 'Bearer live-token-abcdefghijklmnop',
    })
    expect(r.pass).toBe(false)
    expect(r.leak).toBe(true)
  })
})

describe('evaluateWrongTokenMcp + cookie-only', () => {
  const denyBody = {
    jsonrpc: '2.0',
    id: 1,
    error: {
      code: -32001,
      message: 'AUTHORIZATION_REQUIRED',
      data: { code: 'AUTHORIZATION_REQUIRED' },
    },
  }

  it('wrong cairn/bearer sensitive call expects 401 and no success data', () => {
    const ok = evaluateWrongTokenMcp({ status: 401, body: denyBody })
    expect(ok.pass).toBe(true)
    expect(ok.code).toBe('AUTHORIZATION_REQUIRED')

    const elevated = evaluateWrongTokenMcp({
      status: 200,
      body: { jsonrpc: '2.0', result: { tools: [{ name: 'list_tasks' }] } },
    })
    expect(elevated.pass).toBe(false)
    expect(elevated.elevated).toBe(true)
  })

  it('cookie-only sensitive call must not elevate', () => {
    const ok = evaluateCookieOnlyMcp({ status: 401, body: denyBody })
    expect(ok.pass).toBe(true)
    expect(ok.cookieNeverElevates).toBe(true)

    const bad = evaluateCookieOnlyMcp({
      status: 200,
      body: {
        jsonrpc: '2.0',
        result: { content: [{ type: 'text', text: 'tasks' }] },
      },
    })
    expect(bad.pass).toBe(false)
    expect(bad.elevated).toBe(true)
  })

  it('fail-closes on network ambiguity', () => {
    const r = evaluateWrongTokenMcp({ error: 'fetch failed' })
    expect(r.pass).toBe(false)
    expect(r.failClosed).toBe(true)
    expect(r.reason).toBe('network_or_parse_ambiguity')
  })
})

describe('evaluateMalformedMcp', () => {
  it('accepts stable 400/500 protocol failures without data', () => {
    expect(
      evaluateMalformedMcp({
        status: 400,
        body: {
          jsonrpc: '2.0',
          error: { message: 'MCP_PARSE_ERROR', data: { code: 'MCP_PARSE_ERROR' } },
        },
      }).pass,
    ).toBe(true)

    expect(
      evaluateMalformedMcp({
        status: 500,
        body: {
          jsonrpc: '2.0',
          error: { message: 'MCP_HANDLER_ERROR', data: { code: 'MCP_HANDLER_ERROR' } },
        },
      }).pass,
    ).toBe(true)
  })

  it('accepts 200 only when JSON-RPC error is present and no success data', () => {
    expect(
      evaluateMalformedMcp({
        status: 200,
        body: { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' } },
      }).pass,
    ).toBe(true)

    expect(
      evaluateMalformedMcp({
        status: 200,
        body: { jsonrpc: '2.0', result: { tools: [{ name: 'list_tasks' }] } },
      }).pass,
    ).toBe(false)
  })

  it('fail-closes on network ambiguity and stack leak', () => {
    const net = evaluateMalformedMcp({ error: 'TypeError: fetch failed' })
    expect(net.pass).toBe(false)
    expect(net.failClosed).toBe(true)
    expect(net.classification).toBe('AMBIGUOUS_NETWORK')

    const stack = evaluateMalformedMcp({
      status: 500,
      text: 'Error\n    at handle (/app/src/routes/mcp.ts:440:11)',
      body: { error: { message: 'MCP_HANDLER_ERROR' } },
    })
    expect(stack.pass).toBe(false)
    expect(stack.classification).toBe('LEAK_SIGNAL')
  })
})

describe('evaluateMethodPathNegative', () => {
  it('session GET without bearer expects 401', () => {
    expect(
      evaluateMethodPathNegative({ status: 401, expect: 'session-401' }).pass,
    ).toBe(true)
    expect(
      evaluateMethodPathNegative({ status: 200, expect: 'session-401' }).pass,
    ).toBe(false)
  })

  it('wrong method is gated without success elevation', () => {
    for (const status of [401, 403, 404, 405, 400, 415, 500]) {
      expect(
        evaluateMethodPathNegative({ status, expect: 'method-gated' }).pass,
        `status ${status}`,
      ).toBe(true)
    }
    expect(
      evaluateMethodPathNegative({
        status: 200,
        body: { jsonrpc: '2.0', result: { content: [{ type: 'text', text: 'x' }] } },
        expect: 'method-gated',
      }).pass,
    ).toBe(false)
  })
})

describe('secret-safe reporting', () => {
  it('sanitizeProbeDetail redacts auth/cookie/token keys and keeps status/code', () => {
    const s = sanitizeProbeDetail({
      status: 401,
      code: 'AUTHORIZATION_REQUIRED',
      authorization: 'Bearer super-secret-live-token-value',
      cookie: DUMMY_SESSION_COOKIE,
      nested: { token: 'should-redact', ok: true },
    })
    expect(s).toMatchObject({
      status: 401,
      code: 'AUTHORIZATION_REQUIRED',
      authorization: '[redacted]',
      cookie: '[redacted]',
    })
    expect((s as { nested: { token: string; ok: boolean } }).nested.token).toBe('[redacted]')
    expect((s as { nested: { ok: boolean } }).nested.ok).toBe(true)
  })

  it('probeResult always sanitizes detail', () => {
    const p = probeResult('x', true, {
      status: 401,
      authorization: 'Bearer abcdefghijklmnop',
    })
    expect(p.detail?.authorization).toBe('[redacted]')
    expect(p.detail?.status).toBe(401)
  })

  it('isSecretSafeReport rejects bearer-like and stack material', () => {
    expect(
      isSecretSafeReport({
        results: [probeResult('a', true, { status: 401, code: 'AUTHORIZATION_REQUIRED' })],
      }),
    ).toBe(true)
    expect(
      isSecretSafeReport({
        authorization: 'Bearer live-production-token-abcdef0123456789',
      }),
    ).toBe(false)
    expect(
      isSecretSafeReport({
        err: 'at runProbes (/opt/mfs/workspace/task-manager/qa/e2e/flows/security-probes.mjs:10:5)',
      }),
    ).toBe(false)
  })

  it('textHasLeakSignals detects stacks and bearer material', () => {
    expect(textHasLeakSignals('at handle (/app/src/routes/mcp.ts:1:1)')).toBe(true)
    expect(textHasLeakSignals('Bearer abcdefghijklmnopqr')).toBe(true)
    expect(textHasLeakSignals('{"code":"AUTHORIZATION_REQUIRED"}')).toBe(false)
  })
})

describe('helpers', () => {
  it('extractStableCode only accepts CODE_SHAPE messages', () => {
    expect(
      extractStableCode({
        error: { data: { code: 'AUTHORIZATION_REQUIRED' }, message: 'AUTHORIZATION_REQUIRED' },
      }),
    ).toBe('AUTHORIZATION_REQUIRED')
    expect(extractStableCode({ error: { message: 'boom at line 12' } })).toBeNull()
    expect(extractStableCode({ code: 'AUTHORIZATION_REQUIRED' })).toBe('AUTHORIZATION_REQUIRED')
  })

  it('hasMcpSuccessData detects tool/result elevation', () => {
    expect(hasMcpSuccessData({ result: { tools: [{ name: 'x' }] } })).toBe(true)
    expect(
      hasMcpSuccessData({
        error: { message: 'AUTHORIZATION_REQUIRED' },
        result: undefined,
      }),
    ).toBe(false)
    expect(
      hasMcpSuccessData({
        error: { message: 'AUTHORIZATION_REQUIRED' },
      }),
    ).toBe(false)
  })

  it('collectKeys walks nested objects', () => {
    const keys = [...collectKeys({ a: 1, b: { password: 'x', c: 2 } })]
    expect(keys).toEqual(expect.arrayContaining(['a', 'b', 'password', 'c']))
  })

  it('resolveBearer never invents tokens', () => {
    expect(resolveBearer({})).toBeNull()
    expect(resolveBearer({ STAGING_BEARER_TOKEN: '  tok  ' })).toBe('tok')
    expect(
      resolveBearer({ CAIRN_MCP_BEARER: 'mcp', STAGING_BEARER: 'stg' }),
    ).toBe('stg')
  })
})

describe('selfTest offline suite', () => {
  it('passes pure self-test without network', () => {
    const r = selfTest()
    if (!r.ok) {
      const failed = Object.entries(r.checks)
        .filter(([, v]) => !v)
        .map(([k]) => k)
      expect(failed).toEqual([])
    }
    expect(r.ok).toBe(true)
    expect(r.failCount).toBe(0)
    expect(r.passCount).toBeGreaterThan(20)
    expect(r.mode).toBe('self-test')
    expect(r.note).toMatch(/not live target/i)
  })
})
