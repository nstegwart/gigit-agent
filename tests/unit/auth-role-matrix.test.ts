/**
 * Dedicated unit suite for AUTH_ROLE_MATRIX_V1 harness.
 * LOCAL ONLY — default path is --self-test / pure import; no live network.
 *
 * Cross-checks harness role/scope/rate-limit/CSRF contracts against product modules.
 */
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import path from 'node:path'
import { describe, expect, it } from 'vitest'

import {
  defaultScopesForRole,
  authorizeToolCall,
  publicPrincipal,
  type Principal,
  type V3Role,
} from '#/server/rbac'
import {
  PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS,
  PUBLIC_SNAPSHOT_RATE_LIMIT_V1,
  consumeTokenBucket,
  createMemoryRateLimitStore,
  resolvePublicSnapshotRateLimitPolicy,
} from '#/server/rate-limit'
import {
  CSRF_HEADER,
  assertBrowserWriteCsrf,
  clearNonceStore,
  setCsrfSecret,
} from '#/server/csrf'

const require = createRequire(import.meta.url)
const ROOT = process.cwd()

function pathToFileUrl(p: string) {
  const { pathToFileURL } = require('node:url') as typeof import('node:url')
  return pathToFileURL(p)
}

async function loadHarness() {
  const url = pathToFileUrl(path.join(ROOT, 'qa/e2e/flows/auth-role-matrix.mjs'))
  return import(url.href)
}

function principal(role: V3Role, over: Partial<Principal> = {}): Principal {
  return {
    actorId: `actor-${role}`,
    role,
    scopes: defaultScopesForRole(role),
    channel: role === 'PUBLIC' ? 'public' : 'bearer',
    boards: role === 'AGENT' || role === 'INTEGRATOR' ? ['mfs-rebuild'] : [],
    boardId: role === 'AGENT' || role === 'INTEGRATOR' ? 'mfs-rebuild' : null,
    agentId: role === 'AGENT' ? 'agent-synth-1' : null,
    pathspecs: role === 'INTEGRATOR' ? ['src/**'] : undefined,
    checkpointId: role === 'INTEGRATOR' ? 'cp-1' : null,
    ...over,
  }
}

describe('AUTH_ROLE_MATRIX_V1 harness package', () => {
  it('exports stable contract id and five V3 roles', async () => {
    const h = await loadHarness()
    expect(h.CONTRACT_ID).toBe('AUTH_ROLE_MATRIX_V1')
    expect(h.V3_ROLES).toEqual([
      'PUBLIC',
      'OWNER',
      'ROOT_ORCHESTRATOR',
      'AGENT',
      'INTEGRATOR',
    ])
    expect(h.RATE_LIMIT_POLICY_ID).toBe('PUBLIC_SNAPSHOT_RATE_LIMIT_V1')
    expect(h.CSRF_HEADER).toBe('x-csrf-token')
    expect(h.CSRF_HEADER).toBe(CSRF_HEADER)
  })

  it('runAuthRoleMatrixSelfTests passes offline (exit contract)', async () => {
    const h = await loadHarness()
    const result = h.runAuthRoleMatrixSelfTests()
    expect(result.ok).toBe(true)
    expect(result.failCount).toBe(0)
    expect(result.passCount).toBeGreaterThan(40)
    expect(result.contractId).toBe('AUTH_ROLE_MATRIX_V1')
    expect(result.ownerTarget.mode).toBe('self-test')
    expect(result.ownerTarget.base_url).toBe('mock://self-test')
    expect(result.pin).toBeTruthy()
    expect(result.pin.canonicalHash).toMatch(/^[a-f0-9]{32,64}$/i)
    expect(result.failed).toEqual([])
  })

  it('CLI default --self-test exits 0 without live network', () => {
    const script = path.join(ROOT, 'qa/e2e/flows/auth-role-matrix.mjs')
    const r = spawnSync(process.execPath, [script, '--self-test'], {
      cwd: ROOT,
      encoding: 'utf8',
      env: {
        ...process.env,
        // ensure no accidental live base forces network
        WEB_BASE: '',
        STAGING_URL: '',
        STAGING_BEARER_TOKEN: '',
        STAGING_BEARER: '',
        CAIRN_MCP_BEARER: '',
      },
      timeout: 30_000,
    })
    expect(r.status).toBe(0)
    expect(r.stdout).toContain('OWNER_TARGET:')
    expect(r.stdout).toContain('"mode": "self-test"')
    expect(r.stdout).toContain('"ok": true')
    // never echo secrets
    expect(r.stdout).not.toMatch(/Bearer\s+[A-Za-z0-9._\-+/=]{16,}/i)
    expect(r.stdout).not.toMatch(/password\s*[:=]\s*['"]?[^'"\s]{4,}/i)
  })
})

describe('Harness role scopes align with product defaultScopesForRole', () => {
  it('matches product maxima for all five roles', async () => {
    const h = await loadHarness()
    const roles = h.V3_ROLES as V3Role[]
    for (const role of roles) {
      const product = defaultScopesForRole(role).slice().sort()
      const harness = [...h.ROLE_SCOPE_MATRIX[role]].sort()
      expect(harness).toEqual(product)
    }
  })

  it('ROLE_FORBIDDEN_SCOPES have no intersection with product maxima', async () => {
    const h = await loadHarness()
    for (const role of h.V3_ROLES as V3Role[]) {
      const product = new Set(defaultScopesForRole(role))
      for (const s of h.ROLE_FORBIDDEN_SCOPES[role]) {
        expect(product.has(s)).toBe(false)
      }
    }
  })
})

describe('Harness sensitive denials vs product authorizeToolCall', () => {
  it('unauth: public snapshot allow; sensitive list_tasks deny', async () => {
    const h = await loadHarness()
    expect(h.authorizeRoleToolSample(null, h.PUBLIC_ONLY_TOOL).ok).toBe(true)
    expect(authorizeToolCall(null, 'get_public_snapshot').ok).toBe(true)

    const sample = h.authorizeRoleToolSample(null, 'list_tasks')
    expect(sample.ok).toBe(false)
    expect(sample.code).toBe('AUTHORIZATION_REQUIRED')

    const product = authorizeToolCall(null, 'list_tasks', { boardId: 'mfs-rebuild' })
    expect(product.ok).toBe(false)
    expect(product.code).toBe('AUTHORIZATION_REQUIRED')
  })

  it('PUBLIC principal cannot list sensitive tools via product', () => {
    const pub = publicPrincipal()
    const r = authorizeToolCall(pub, 'list_tasks', { boardId: 'mfs-rebuild' })
    expect(r.ok).toBe(false)
  })

  it('OWNER denied agent evidence tools (product + harness)', async () => {
    const h = await loadHarness()
    const owner = principal('OWNER')
    for (const tool of ['register_run', 'heartbeat_run', 'terminate_run'] as const) {
      const hs = h.authorizeRoleToolSample('OWNER', tool)
      expect(hs.ok).toBe(false)
      expect(hs.code).toBe('OWNER_EVIDENCE_IMPERSONATION_DENIED')
      const pr = authorizeToolCall(owner, tool, {
        boardId: 'mfs-rebuild',
        agentId: 'agent-x',
      })
      expect(pr.ok).toBe(false)
      expect(pr.code).toBe('OWNER_EVIDENCE_IMPERSONATION_DENIED')
    }
  })

  it('ROOT may publish_dispatch_plan; OWNER may not', async () => {
    const h = await loadHarness()
    expect(h.authorizeRoleToolSample('ROOT_ORCHESTRATOR', 'publish_dispatch_plan').ok).toBe(
      true,
    )
    expect(h.authorizeRoleToolSample('OWNER', 'publish_dispatch_plan').ok).toBe(false)

    const root = principal('ROOT_ORCHESTRATOR')
    const owner = principal('OWNER')
    expect(authorizeToolCall(root, 'publish_dispatch_plan', { boardId: 'mfs-rebuild' }).ok).toBe(
      true,
    )
    expect(authorizeToolCall(owner, 'publish_dispatch_plan', { boardId: 'mfs-rebuild' }).ok).toBe(
      false,
    )
  })

  it('AGENT own-run allow / foreign deny', async () => {
    const h = await loadHarness()
    expect(h.authorizeRoleToolSample('AGENT', 'register_run', { ownRun: true }).ok).toBe(true)
    expect(
      h.authorizeRoleToolSample('AGENT', 'register_run', { ownRun: false }).code,
    ).toBe('OWN_RUN_ONLY')

    const agent = principal('AGENT', { agentId: 'agent-synth-1' })
    const own = authorizeToolCall(agent, 'register_run', {
      boardId: 'mfs-rebuild',
      agentId: 'agent-synth-1',
    })
    expect(own.ok).toBe(true)
    const foreign = authorizeToolCall(agent, 'register_run', {
      boardId: 'mfs-rebuild',
      agentId: 'other-agent',
    })
    expect(foreign.ok).toBe(false)
    expect(foreign.code).toBe('OWN_RUN_ONLY')
  })

  it('INTEGRATOR integration_lock allow; publish_dispatch deny', async () => {
    const h = await loadHarness()
    expect(h.authorizeRoleToolSample('INTEGRATOR', 'integration_lock').ok).toBe(true)
    expect(h.authorizeRoleToolSample('INTEGRATOR', 'publish_dispatch_plan').ok).toBe(false)

    const integ = principal('INTEGRATOR')
    expect(
      authorizeToolCall(integ, 'integration_lock', { boardId: 'mfs-rebuild' }).ok,
    ).toBe(true)
    expect(
      authorizeToolCall(integ, 'publish_dispatch_plan', { boardId: 'mfs-rebuild' }).ok,
    ).toBe(false)
  })
})

describe('CSRF browser-write contract (product + harness table)', () => {
  it('harness cases match CSRF_CONTRACT codes', async () => {
    const h = await loadHarness()
    expect(h.CSRF_CONTRACT.missingTokenCode).toBe('CSRF_TOKEN_MISSING')
    expect(h.CSRF_CONTRACT.sameOriginAloneInsufficient).toBe(true)
    for (const c of h.CSRF_CONTRACT.cases) {
      const r = h.evaluateCsrfCase(c)
      if (c.expect === 'TOKEN_PRESENT_SHAPE_OK' || c.expect === 'SKIP_CSRF_BEARER') {
        expect(r.ok).toBe(true)
        expect(r.code).toBe(c.expect)
      } else {
        expect(r.ok).toBe(false)
        expect(r.code).toBe(c.expect)
      }
    }
  })

  it('product assertBrowserWriteCsrf: missing token fail-closed; bearer path not required', () => {
    clearNonceStore()
    setCsrfSecret('unit-test-csrf-secret-not-for-prod')
    try {
      const missing = assertBrowserWriteCsrf({
        sessionToken: 'sess-unit-1',
        csrfHeader: null,
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        protocol: 'http',
      })
      expect(missing.ok).toBe(false)
      if (!missing.ok) {
        expect(missing.code).toBe('CSRF_TOKEN_MISSING')
      }

      const noSession = assertBrowserWriteCsrf({
        sessionToken: null,
        csrfHeader: 'deadbeef',
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        protocol: 'http',
      })
      expect(noSession.ok).toBe(false)
      if (!noSession.ok) {
        expect(noSession.code).toBe('CSRF_SESSION_REQUIRED')
      }
    } finally {
      clearNonceStore()
      setCsrfSecret(null)
    }
  })
})

describe('Rate limit 60/min burst20 bounded safe mode', () => {
  it('harness defaults match product PUBLIC_SNAPSHOT_RATE_LIMIT_V1', async () => {
    const h = await loadHarness()
    expect(h.RATE_LIMIT_DEFAULTS.policyId).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_V1)
    expect(h.RATE_LIMIT_DEFAULTS.sustainedPerMinute).toBe(60)
    expect(h.RATE_LIMIT_DEFAULTS.burst).toBe(20)
    const product = resolvePublicSnapshotRateLimitPolicy()
    expect(product.policyId).toBe(PUBLIC_SNAPSHOT_RATE_LIMIT_DEFAULTS.policyId)
    expect(product.sustainedPerMinute).toBe(60)
    expect(product.burst).toBe(20)
  })

  it('harness bounded self-test: allow 20 then deny 21st', async () => {
    const h = await loadHarness()
    const rl = h.runBoundedRateLimitSelfTest()
    expect(rl.ok).toBe(true)
    expect(rl.allowedCount).toBe(20)
    expect(rl.deniedCount).toBe(1)
    expect(rl.firstDenyAt).toBe(21)
    expect(rl.mode).toBe('bounded-safe-pure')
  })

  it('product consumeTokenBucket: burst 20 then deny (fixed clock)', () => {
    const store = createMemoryRateLimitStore()
    const policy = resolvePublicSnapshotRateLimitPolicy()
    const key = 'ip:unit-auth-role-matrix'
    const t0 = 1_700_000_000_000
    let allowed = 0
    let denied = 0
    for (let i = 0; i < 21; i++) {
      const d = consumeTokenBucket({
        key,
        policy,
        store,
        clock: { nowMs: () => t0 },
      })
      if (d.allowed) allowed++
      else denied++
    }
    expect(allowed).toBe(20)
    expect(denied).toBe(1)
  })
})

describe('Sanitize + pin', () => {
  it('sanitizeValue redacts secret keys and bearer inline', async () => {
    const h = await loadHarness()
    const clean = h.sanitizeValue({
      password: 'nope',
      authorization: 'Bearer abcdefghijklmnopqrstuvwxyz012345',
      fine: 1,
    })
    expect(clean.password).toBe('[REDACTED]')
    expect(clean.authorization).toBe('[REDACTED]')
    expect(clean.fine).toBe(1)
    const text = JSON.stringify(
      h.sanitizeValue({ note: 'Bearer abcdefghijklmnopqrstuvwxyz012345' }),
    )
    expect(h.assertNoSecretsInText(text).ok).toBe(true)
  })

  it('loadExactTargetPin returns complete staging pin', async () => {
    const h = await loadHarness()
    const pin = h.loadExactTargetPin()
    expect(pin.ok).toBe(true)
    if (pin.ok) {
      expect(pin.boardId).toBeTruthy()
      expect(pin.pin.canonicalSnapshotId).toBeTruthy()
      expect(pin.pin.canonicalHash).toMatch(/^[a-f0-9]{32,64}$/i)
      expect(typeof pin.pin.boardRev).toBe('number')
      expect(typeof pin.pin.lifecycleRev).toBe('number')
      expect(h.pinFingerprint(pin.pin)).toHaveLength(16)
    }
  })
})
