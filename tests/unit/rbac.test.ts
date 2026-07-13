/**
 * C2A1 Auth/RBAC/CSRF unit suite.
 * Pure module proofs for five-role matrix, scopes, session maps, bearer fail-closed,
 * legacy token constraints, cookie/bearer separation, CSRF semantics.
 * Does not exercise live HTTP/MCP wiring (owned by C2A2).
 */
import { afterEach, describe, expect, it } from 'vitest'

import {
  assertBearerChannel,
  assertAgentOwnRun,
  assertIntegratorBounds,
  assertMcpToolCatalogIntegrity,
  assertNotOwnerEvidenceImpersonation,
  assertNotRootProductionApproval,
  authorizeToolCall,
  canAccessBoard,
  clampBearerPrincipal,
  defaultScopesForRole,
  deniesUnscopedBoardEnumeration,
  extractBearerFromHeaders,
  getBearerAuthMechanismState,
  getToolSpec,
  hasScope,
  intersectScopesWithRoleMaxima,
  isToolListable,
  isUnscopedBoardEnumerationTool,
  listHumanSafeToolCatalog,
  listHumanSafeToolNames,
  principalFromBearerRecord,
  principalFromSession,
  publicPrincipal,
  requireBoardAccess,
  requireRole,
  requireScope,
  resetBearerInjection,
  resolveBearerPrincipal,
  resolveToolAliasTarget,
  setBearerResolver,
  setBearerTokenRecords,
  ALL_READ_SCOPES,
  ALL_WRITE_SCOPES,
  CANONICAL_MCP_READ_TOOL_NAMES,
  MCP_TOOL_SPECS,
  UNSCOPED_BOARD_ENUMERATION_TOOLS,
  RbacError,
  type Principal,
  type Scope,
  type V3Role,
} from '#/server/rbac'
import {
  assertBrowserOrigin,
  assertBrowserWriteCsrf,
  clearNonceStore,
  C3_CSRF_TOKEN_CLIENT_WIRING,
  CSRF_DEV_DEFAULT_SECRET,
  deriveCsrfToken,
  isProductionLikeCsrfEnv,
  isSameOrigin,
  resolveCsrfSecret,
  setCsrfSecret,
  safeEqualHex,
} from '#/server/csrf'
import type { SessionUser } from '#/lib/types'

const HOST = 'localhost:3000'
const ORIGIN = 'http://localhost:3000'

function sessionAdmin(over: Partial<SessionUser> = {}): SessionUser {
  return { id: 'u-admin', username: 'admin', role: 'admin', boards: [], ...over }
}
function sessionMember(over: Partial<SessionUser> = {}): SessionUser {
  return {
    id: 'u-member',
    username: 'member',
    role: 'member',
    boards: ['mfs-rebuild'],
    ...over,
  }
}

function principal(role: V3Role, over: Partial<Principal> = {}): Principal {
  return {
    actorId: `actor-${role}`,
    role,
    scopes: defaultScopesForRole(role),
    channel: role === 'PUBLIC' ? 'public' : 'bearer',
    boards: [],
    ...over,
  }
}

afterEach(() => {
  resetBearerInjection()
  clearNonceStore()
  setCsrfSecret(null)
})

// ---------------------------------------------------------------------------
// Five roles + default scopes
// ---------------------------------------------------------------------------
describe('V3 roles and default scopes', () => {
  const roles: V3Role[] = [
    'OWNER',
    'ROOT_ORCHESTRATOR',
    'AGENT',
    'INTEGRATOR',
    'PUBLIC',
  ]

  it('defines exactly five additive V3 roles with defaultScopesForRole coverage', () => {
    // W3: cardinality + exhaustive forbid of extra role strings
    expect(roles).toHaveLength(5)
    expect(new Set(roles).size).toBe(5)
    for (const r of roles) {
      const scopes = defaultScopesForRole(r)
      expect(Array.isArray(scopes)).toBe(true)
    }
    // Unknown / sixth role must not be accepted by the typed matrix at runtime default
    expect(() => defaultScopesForRole('SUPERADMIN' as V3Role)).toThrow()
  })

  it('OWNER: sensitive read + decision/policy/lifecycle/import write; no dispatch/account:sync/integration/run:write', () => {
    const s = defaultScopesForRole('OWNER')
    for (const r of ALL_READ_SCOPES) expect(s).toContain(r)
    expect(s).toContain('decision:write')
    expect(s).toContain('policy:write')
    expect(s).toContain('lifecycle:write')
    expect(s).toContain('import:write')
    expect(s).not.toContain('dispatch:write')
    expect(s).not.toContain('account:sync')
    expect(s).not.toContain('integration:write')
    expect(s).not.toContain('run:write')
    expect(s).not.toContain('reconcile:write')
  })

  it('ROOT_ORCHESTRATOR: dispatch/lifecycle/reconcile/account:sync; no decision resolve-as-owner-only scopes extra policy', () => {
    const s = defaultScopesForRole('ROOT_ORCHESTRATOR')
    expect(s).toContain('dispatch:write')
    expect(s).toContain('lifecycle:write')
    expect(s).toContain('reconcile:write')
    expect(s).toContain('account:sync')
    expect(s).toContain('import:write')
    expect(s).toContain('account:read')
    expect(s).toContain('audit:read')
    expect(s).not.toContain('policy:write')
    expect(s).not.toContain('decision:write')
    expect(s).not.toContain('integration:write')
    expect(s).not.toContain('run:write')
    expect(s).not.toContain('evidence:read')
  })

  it('AGENT: run:write + bounded read; no dispatch/account/audit/evidence/raw sync', () => {
    const s = defaultScopesForRole('AGENT')
    expect(s).toContain('run:write')
    expect(s).toContain('decision:write')
    expect(s).toContain('board:read')
    expect(s).toContain('task:read')
    expect(s).toContain('run:read')
    expect(s).not.toContain('dispatch:write')
    expect(s).not.toContain('account:read')
    expect(s).not.toContain('account:sync')
    expect(s).not.toContain('audit:read')
    expect(s).not.toContain('evidence:read')
    expect(s).not.toContain('policy:write')
    expect(s).not.toContain('lifecycle:write')
  })

  it('INTEGRATOR: integration:write + board/task read only', () => {
    const s = defaultScopesForRole('INTEGRATOR')
    expect(s).toEqual(['board:read', 'task:read', 'integration:write'])
  })

  it('PUBLIC: empty scopes (public snapshot surface only)', () => {
    expect(defaultScopesForRole('PUBLIC')).toEqual([])
    expect(publicPrincipal().scopes).toEqual([])
    expect(publicPrincipal().role).toBe('PUBLIC')
    expect(publicPrincipal().channel).toBe('public')
  })

  it('ALL_READ_SCOPES and ALL_WRITE_SCOPES enumerate every contract scope', () => {
    expect(ALL_READ_SCOPES).toEqual([
      'board:read',
      'task:read',
      'run:read',
      'account:read',
      'decision:read',
      'evidence:read',
      'audit:read',
    ])
    expect(ALL_WRITE_SCOPES).toEqual([
      'dispatch:write',
      'lifecycle:write',
      'run:write',
      'decision:write',
      'import:write',
      'reconcile:write',
      'account:sync',
      'integration:write',
      'policy:write',
    ])
  })
})

// ---------------------------------------------------------------------------
// Sensitive scope enforcement per role
// ---------------------------------------------------------------------------
describe('sensitive read/write scope enforcement', () => {
  const sensitiveReads: Scope[] = [
    'account:read',
    'audit:read',
    'evidence:read',
    'decision:read',
    'run:read',
  ]
  const sensitiveWrites: Scope[] = [
    'dispatch:write',
    'lifecycle:write',
    'run:write',
    'decision:write',
    'import:write',
    'reconcile:write',
    'account:sync',
    'integration:write',
    'policy:write',
  ]

  it('null principal fails closed on every sensitive scope', () => {
    for (const scope of [...sensitiveReads, ...sensitiveWrites]) {
      expect(() => requireScope(null, scope)).toThrow(RbacError)
      try {
        requireScope(null, scope)
      } catch (e) {
        expect(e).toBeInstanceOf(RbacError)
        expect((e as RbacError).code).toBe('AUTHORIZATION_REQUIRED')
        expect((e as RbacError).status).toBe(401)
      }
    }
  })

  it('PUBLIC cannot hold any sensitive read/write scope', () => {
    const p = publicPrincipal()
    for (const scope of [...sensitiveReads, ...sensitiveWrites, 'board:read' as Scope]) {
      expect(hasScope(p, scope)).toBe(false)
      expect(() => requireScope(p, scope)).toThrow(/missing scope/)
    }
  })

  it('AGENT denied account/audit/evidence/dispatch/sync/policy/reconcile', () => {
    const p = principal('AGENT')
    for (const scope of [
      'account:read',
      'audit:read',
      'evidence:read',
      'dispatch:write',
      'account:sync',
      'policy:write',
      'reconcile:write',
      'integration:write',
    ] as Scope[]) {
      expect(hasScope(p, scope)).toBe(false)
      expect(() => requireScope(p, scope)).toThrow(RbacError)
    }
    expect(() => requireScope(p, 'run:write')).not.toThrow()
  })

  it('OWNER denied dispatch:write and account:sync and integration:write', () => {
    const p = principal('OWNER')
    expect(() => requireScope(p, 'dispatch:write')).toThrow(RbacError)
    expect(() => requireScope(p, 'account:sync')).toThrow(RbacError)
    expect(() => requireScope(p, 'integration:write')).toThrow(RbacError)
    expect(() => requireScope(p, 'decision:write')).not.toThrow()
    expect(() => requireScope(p, 'account:read')).not.toThrow()
  })

  it('ROOT denied policy:write and decision:write and run:write', () => {
    const p = principal('ROOT_ORCHESTRATOR')
    expect(() => requireScope(p, 'policy:write')).toThrow(RbacError)
    expect(() => requireScope(p, 'decision:write')).toThrow(RbacError)
    expect(() => requireScope(p, 'run:write')).toThrow(RbacError)
    expect(() => requireScope(p, 'dispatch:write')).not.toThrow()
  })

  it('INTEGRATOR denied lifecycle/dispatch/run/decision write', () => {
    const p = principal('INTEGRATOR')
    for (const scope of [
      'lifecycle:write',
      'dispatch:write',
      'run:write',
      'decision:write',
      'account:sync',
    ] as Scope[]) {
      expect(() => requireScope(p, scope)).toThrow(RbacError)
    }
    expect(() => requireScope(p, 'integration:write')).not.toThrow()
  })

  it('requireRole fail-closed for wrong role', () => {
    const agent = principal('AGENT')
    expect(() => requireRole(agent, ['OWNER'])).toThrow(RbacError)
    try {
      requireRole(agent, ['OWNER', 'ROOT_ORCHESTRATOR'])
    } catch (e) {
      expect((e as RbacError).code).toBe('FORBIDDEN_ROLE')
    }
    expect(requireRole(agent, ['AGENT', 'ROOT_ORCHESTRATOR']).role).toBe('AGENT')
    expect(() => requireRole(null, ['OWNER'])).toThrow(/authentication required/)
  })
})

// ---------------------------------------------------------------------------
// Session mappings: admin→OWNER only; member→read allowlist only
// ---------------------------------------------------------------------------
describe('session → principal mapping', () => {
  it('admin maps ONLY to OWNER (never ROOT/AGENT/INTEGRATOR)', () => {
    const p = principalFromSession(sessionAdmin())
    expect(p).not.toBeNull()
    expect(p!.role).toBe('OWNER')
    expect(p!.legacyRole).toBe('admin')
    expect(p!.channel).toBe('session')
    expect(p!.actorId).toBe('u-admin')
    expect(p!.boards).toEqual([])
    expect(['ROOT_ORCHESTRATOR', 'AGENT', 'INTEGRATOR', 'PUBLIC']).not.toContain(p!.role)
    // OWNER scopes only
    expect(p!.scopes).toEqual(defaultScopesForRole('OWNER'))
    expect(hasScope(p, 'dispatch:write')).toBe(false)
    expect(hasScope(p, 'run:write')).toBe(false)
    expect(hasScope(p, 'account:sync')).toBe(false)
  })

  it('member maps to safe read-only allowlist (not root/agent/integrator/owner)', () => {
    const p = principalFromSession(sessionMember({ boards: ['mfs-rebuild', 'ibils'] }))
    expect(p).not.toBeNull()
    expect(p!.legacyRole).toBe('member')
    expect(p!.channel).toBe('session')
    expect(p!.boards).toEqual(['mfs-rebuild', 'ibils'])
    expect(p!.role).not.toBe('OWNER')
    expect(p!.role).not.toBe('ROOT_ORCHESTRATOR')
    expect(p!.role).not.toBe('AGENT')
    expect(p!.role).not.toBe('INTEGRATOR')
    expect(p!.scopes).toEqual(['board:read', 'task:read'])
    for (const w of ALL_WRITE_SCOPES) {
      expect(hasScope(p, w)).toBe(false)
    }
    expect(hasScope(p, 'account:read')).toBe(false)
    expect(hasScope(p, 'audit:read')).toBe(false)
    expect(hasScope(p, 'evidence:read')).toBe(false)
  })

  it('null/undefined session → null principal', () => {
    expect(principalFromSession(null)).toBeNull()
    expect(principalFromSession(undefined)).toBeNull()
  })

  it('board access: OWNER all; member allowlist only; true PUBLIC none', () => {
    const owner = principalFromSession(sessionAdmin())!
    const member = principalFromSession(sessionMember({ boards: ['mfs-rebuild'] }))!
    const pub = publicPrincipal()
    expect(canAccessBoard(owner, 'any-board')).toBe(true)
    expect(canAccessBoard(member, 'mfs-rebuild')).toBe(true)
    expect(canAccessBoard(member, 'other')).toBe(false)
    expect(canAccessBoard(pub, 'mfs-rebuild')).toBe(false)
    expect(() => requireBoardAccess(member, 'other')).toThrow(RbacError)
    expect(requireBoardAccess(member, 'mfs-rebuild').actorId).toBe('u-member')
  })

  it('OWNER cannot impersonate agent evidence; ROOT cannot grant production approval', () => {
    const owner = principal('OWNER')
    const root = principal('ROOT_ORCHESTRATOR')
    expect(() =>
      assertNotOwnerEvidenceImpersonation(owner, { asAgentEvidence: true }),
    ).toThrow(/OWNER cannot impersonate/)
    expect(() =>
      assertNotRootProductionApproval(root, { grantOwnerProductionApproval: true }),
    ).toThrow(/production approval/)
    expect(() =>
      assertNotRootProductionApproval(root, { productionApprovalId: 'pa-1' }),
    ).toThrow(RbacError)
  })

  it('AGENT own-run and INTEGRATOR path bounds', () => {
    const agent = principal('AGENT', { agentId: 'agent-a' })
    expect(() => assertAgentOwnRun(agent, 'agent-b')).toThrow(/OWN_RUN_ONLY|own assigned/)
    expect(() => assertAgentOwnRun(agent, 'agent-a')).not.toThrow()
    const integ = principal('INTEGRATOR', {
      pathspecs: ['src/server/**'],
      checkpointId: 'cp-1',
    })
    expect(() =>
      assertIntegratorBounds(integ, { pathspec: 'src/client/x.ts' }),
    ).toThrow(RbacError)
    expect(() =>
      assertIntegratorBounds(integ, { pathspec: 'src/server/rbac.ts', checkpointId: 'cp-1' }),
    ).not.toThrow()
  })
})

// ---------------------------------------------------------------------------
// Bearer resolution: injectable, fail-closed, DECISION_AUTH
// ---------------------------------------------------------------------------
describe('bearer principal resolution', () => {
  it('missing config → DECISION_AUTH_MECHANISM_REQUIRED', () => {
    const state = getBearerAuthMechanismState({})
    expect(state.kind).toBe('DECISION_AUTH_MECHANISM_REQUIRED')
    if (state.kind === 'DECISION_AUTH_MECHANISM_REQUIRED') {
      expect(state.reason).toMatch(/no injectable|configured/i)
    }
  })

  it('resolve with no token + no config: principal null + DECISION_AUTH', async () => {
    const r = await resolveBearerPrincipal(null, {})
    expect(r.principal).toBeNull()
    expect(r.mechanism.kind).toBe('DECISION_AUTH_MECHANISM_REQUIRED')
  })

  it('resolve with wrong token + no config: principal null + DECISION_AUTH', async () => {
    const r = await resolveBearerPrincipal('not-a-token', {})
    expect(r.principal).toBeNull()
    expect(r.mechanism.kind).toBe('DECISION_AUTH_MECHANISM_REQUIRED')
  })

  it('legacy token ABSENT never opens anything (no open-when-absent path)', async () => {
    const r = await resolveBearerPrincipal(undefined, { envWriteToken: null })
    expect(r.principal).toBeNull()
    // No principal means sensitive authorizeToolCall fails
    const deny = authorizeToolCall(r.principal, 'list_accounts')
    expect(deny.ok).toBe(false)
    expect(deny.code).toBe('AUTHORIZATION_REQUIRED')
    const denyWrite = authorizeToolCall(r.principal, 'toggle_task')
    expect(denyWrite.ok).toBe(false)
  })

  it('legacy token PRESENT without board binding → disabled (principal null)', async () => {
    const secret = 'legacy-test-write-token-value'
    const r = await resolveBearerPrincipal(secret, { envWriteToken: secret })
    expect(r.principal).toBeNull()
    expect(r.mechanism.kind).toBe('OK')
  })

  it('legacy token PRESENT board-bound → constrained AGENT only (not owner/root/account/audit/evidence)', async () => {
    const secret = 'legacy-test-write-token-value'
    const r = await resolveBearerPrincipal(secret, {
      envWriteToken: secret,
      envWriteTokenBoardId: 'mfs-rebuild',
    })
    expect(r.principal).not.toBeNull()
    expect(r.principal!.role).toBe('AGENT')
    expect(r.principal!.channel).toBe('bearer')
    expect(r.principal!.boardId).toBe('mfs-rebuild')
    expect(r.principal!.boards).toEqual(['mfs-rebuild'])
    expect(r.principal!.role).not.toBe('OWNER')
    expect(r.principal!.role).not.toBe('ROOT_ORCHESTRATOR')
    for (const s of [
      'account:read',
      'audit:read',
      'evidence:read',
      'dispatch:write',
      'account:sync',
      'policy:write',
    ] as Scope[]) {
      expect(hasScope(r.principal, s)).toBe(false)
    }
    // Cannot publish dispatch or sync accounts
    expect(authorizeToolCall(r.principal, 'publish_dispatch_plan').ok).toBe(false)
    expect(authorizeToolCall(r.principal, 'sync_accounts').ok).toBe(false)
    expect(authorizeToolCall(r.principal, 'list_accounts').ok).toBe(false)
    expect(authorizeToolCall(r.principal, 'list_audit').ok).toBe(false)
    // Cross-board denied
    expect(canAccessBoard(r.principal, 'other-board')).toBe(false)
    expect(canAccessBoard(r.principal, 'mfs-rebuild')).toBe(true)
  })

  it('wrong legacy token does not authenticate even when env is set', async () => {
    const r = await resolveBearerPrincipal('wrong', { envWriteToken: 'right-token-xyz' })
    expect(r.principal).toBeNull()
    expect(r.mechanism.kind).toBe('OK') // config present
  })

  it('injectable records resolve ROLE matrix (OWNER/ROOT/AGENT/INTEGRATOR)', async () => {
    setBearerTokenRecords([
      {
        tokenId: 't-owner',
        secret: 'sec-owner',
        role: 'OWNER',
        actorId: 'owner-1',
      },
      {
        tokenId: 't-root',
        secret: 'sec-root',
        role: 'ROOT_ORCHESTRATOR',
        actorId: 'root-1',
      },
      {
        tokenId: 't-agent',
        secret: 'sec-agent',
        role: 'AGENT',
        actorId: 'agent-1',
        agentId: 'agent-1',
        boardId: 'mfs-rebuild',
      },
      {
        tokenId: 't-int',
        secret: 'sec-int',
        role: 'INTEGRATOR',
        actorId: 'int-1',
        pathspecs: ['src/**'],
        boardId: 'mfs-rebuild',
      },
    ])
    expect(getBearerAuthMechanismState({}).kind).toBe('OK')

    const owner = await resolveBearerPrincipal('sec-owner')
    expect(owner.principal?.role).toBe('OWNER')
    expect(owner.principal?.channel).toBe('bearer')

    const root = await resolveBearerPrincipal('sec-root')
    expect(root.principal?.role).toBe('ROOT_ORCHESTRATOR')
    expect(authorizeToolCall(root.principal, 'publish_dispatch_plan').ok).toBe(true)

    const agent = await resolveBearerPrincipal('sec-agent')
    expect(agent.principal?.role).toBe('AGENT')
    expect(agent.principal?.boardId).toBe('mfs-rebuild')
    expect(authorizeToolCall(agent.principal, 'publish_dispatch_plan').ok).toBe(false)

    const integ = await resolveBearerPrincipal('sec-int')
    expect(integ.principal?.role).toBe('INTEGRATOR')
    expect(authorizeToolCall(integ.principal, 'integration_lock').ok).toBe(true)
  })

  it('injectable resolver is used when set', async () => {
    setBearerResolver((tok) => {
      if (tok === 'resolver-tok') {
        return principal('ROOT_ORCHESTRATOR', { actorId: 'from-resolver', channel: 'bearer' })
      }
      return null
    })
    const hit = await resolveBearerPrincipal('resolver-tok')
    expect(hit.principal?.actorId).toBe('from-resolver')
    const miss = await resolveBearerPrincipal('other')
    expect(miss.principal).toBeNull()
  })

  it('envBearerJson malformed is ignored fail-closed (principal null + mechanism not OK)', async () => {
    // W10 / B3: malformed JSON must not report mechanism OK
    const malformed = '{not-json'
    expect(getBearerAuthMechanismState({ envBearerJson: malformed }).kind).toBe(
      'DECISION_AUTH_MECHANISM_REQUIRED',
    )
    const r = await resolveBearerPrincipal('x', { envBearerJson: malformed })
    expect(r.principal).toBeNull()
    expect(r.mechanism.kind).toBe('DECISION_AUTH_MECHANISM_REQUIRED')

    // Non-array JSON also dishonest if treated as OK
    expect(getBearerAuthMechanismState({ envBearerJson: '{"token":"x"}' }).kind).toBe(
      'DECISION_AUTH_MECHANISM_REQUIRED',
    )
    // Valid array with usable principal records → mechanism OK
    const valid = JSON.stringify([
      {
        tokenId: 't1',
        secret: 'sec-valid-json',
        role: 'AGENT',
        actorId: 'a1',
        agentId: 'a1',
        boardId: 'mfs-rebuild',
      },
    ])
    expect(getBearerAuthMechanismState({ envBearerJson: valid }).kind).toBe('OK')
    const hit = await resolveBearerPrincipal('sec-valid-json', { envBearerJson: valid })
    expect(hit.principal?.role).toBe('AGENT')
    expect(hit.principal?.boardId).toBe('mfs-rebuild')
    expect(hit.mechanism.kind).toBe('OK')
  })

  it('extractBearerFromHeaders: Authorization Bearer and X-Cairn-Token; never cookies', () => {
    const h1 = new Headers({ authorization: 'Bearer abc.def' })
    expect(extractBearerFromHeaders(h1)).toBe('abc.def')
    const h2 = new Headers({ 'x-cairn-token': 'legacy-tok' })
    expect(extractBearerFromHeaders(h2)).toBe('legacy-tok')
    const h3 = new Headers({ cookie: 'cairn_session=session-secret-value' })
    expect(extractBearerFromHeaders(h3)).toBeNull()
    const h4 = new Headers({})
    expect(extractBearerFromHeaders(h4)).toBeNull()
  })
})

// ---------------------------------------------------------------------------
// Cookie vs bearer separation
// ---------------------------------------------------------------------------
describe('cookie / bearer separation', () => {
  it('session principal channel is session; assertBearerChannel denies it for MCP', () => {
    const sessionP = principalFromSession(sessionAdmin())!
    expect(sessionP.channel).toBe('session')
    expect(() => assertBearerChannel(sessionP)).toThrow(RbacError)
    try {
      assertBearerChannel(sessionP)
    } catch (e) {
      expect((e as RbacError).code).toBe('COOKIE_ELEVATION_DENIED')
      expect((e as RbacError).status).toBe(403)
    }
  })

  it('bearer principal passes assertBearerChannel', () => {
    const p = principal('AGENT', { channel: 'bearer' })
    expect(assertBearerChannel(p).channel).toBe('bearer')
  })

  it('null principal fails assertBearerChannel with AUTHORIZATION_REQUIRED', () => {
    // W1: must throw — not try/catch soft-pass
    expect(() => assertBearerChannel(null)).toThrow(RbacError)
    expect(() => assertBearerChannel(undefined)).toThrow(RbacError)
    try {
      assertBearerChannel(null)
      expect.unreachable('assertBearerChannel(null) must throw')
    } catch (e) {
      expect(e).toBeInstanceOf(RbacError)
      expect((e as RbacError).code).toBe('AUTHORIZATION_REQUIRED')
      expect((e as RbacError).status).toBe(401)
    }
  })

  it('member session cannot authorize sensitive MCP tools', () => {
    const m = principalFromSession(sessionMember())!
    expect(authorizeToolCall(m, 'list_accounts').ok).toBe(false)
    expect(authorizeToolCall(m, 'toggle_task').ok).toBe(false)
    expect(authorizeToolCall(m, 'list_boards').ok).toBe(true)
    expect(isToolListable(m, 'list_audit')).toBe(false)
    expect(isToolListable(m, 'list_boards')).toBe(true)
    expect(isToolListable(null, 'list_boards')).toBe(false)
    expect(isToolListable(null, 'get_public_snapshot')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// authorizeToolCall matrix samples (sensitive tools)
// ---------------------------------------------------------------------------
describe('authorizeToolCall role/tool matrix', () => {
  it('unauth denied for every non-public catalog tool', () => {
    for (const spec of MCP_TOOL_SPECS) {
      if (spec.kind === 'public') {
        expect(authorizeToolCall(null, spec.name).ok).toBe(true)
      } else {
        const r = authorizeToolCall(null, spec.name)
        expect(r.ok).toBe(false)
        expect(r.code).toBe('AUTHORIZATION_REQUIRED')
      }
    }
  })

  it('OWNER can resolve decisions; AGENT cannot; ROOT cannot', () => {
    expect(authorizeToolCall(principal('OWNER'), 'resolve_decision_v3').ok).toBe(true)
    expect(authorizeToolCall(principal('OWNER'), 'decide_decision').ok).toBe(true)
    expect(authorizeToolCall(principal('AGENT'), 'resolve_decision_v3').ok).toBe(false)
    expect(authorizeToolCall(principal('ROOT_ORCHESTRATOR'), 'resolve_decision_v3').ok).toBe(
      false,
    )
  })

  it('OWNER denied register_run / heartbeat_run / upsert_run / set_run_status / submit_stage_evidence (evidence impersonation)', () => {
    // W7 / W11 / B2: cover all agent-run evidence write tools, not only register_run
    const owner = principal('OWNER')
    for (const tool of [
      'register_run',
      'heartbeat_run',
      'upsert_run',
      'set_run_status',
      'submit_stage_evidence',
    ] as const) {
      const r = authorizeToolCall(owner, tool, { agentId: 'any-agent' })
      expect(r.ok, tool).toBe(false)
      expect(r.code, tool).toBe('OWNER_EVIDENCE_IMPERSONATION_DENIED')
    }
  })

  it('ROOT denied submit_stage_evidence (cannot impersonate agent evidence; accept via advance only)', () => {
    const root = principal('ROOT_ORCHESTRATOR')
    const r = authorizeToolCall(root, 'submit_stage_evidence', { agentId: 'any' })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('OWNER_EVIDENCE_IMPERSONATION_DENIED')
    expect(isToolListable(root, 'submit_stage_evidence')).toBe(false)
  })

  it('AGENT unbound agentId denied on ownRun tools (fail-closed, no soft-pass)', () => {
    // W8 / B1: authorizeToolCall path — missing principal.agentId must deny
    const unbound = principal('AGENT', { agentId: null })
    for (const tool of [
      'register_run',
      'heartbeat_run',
      'upsert_run',
      'set_run_status',
      'submit_stage_evidence',
    ] as const) {
      const foreign = authorizeToolCall(unbound, tool, { agentId: 'foreign-agent-99' })
      expect(foreign.ok, `${tool} foreign`).toBe(false)
      expect(foreign.code, `${tool} foreign`).toBe('OWN_RUN_ONLY')
      const noArg = authorizeToolCall(unbound, tool, {})
      expect(noArg.ok, `${tool} noArg`).toBe(false)
      expect(noArg.code, `${tool} noArg`).toBe('OWN_RUN_ONLY')
    }
    // Bound agent may act only on own id
    const bound = principal('AGENT', { agentId: 'agent-a' })
    expect(authorizeToolCall(bound, 'register_run', { agentId: 'agent-a' }).ok).toBe(true)
    expect(authorizeToolCall(bound, 'heartbeat_run', { agentId: 'agent-a' }).ok).toBe(true)
    expect(authorizeToolCall(bound, 'submit_stage_evidence', { agentId: 'agent-a' }).ok).toBe(true)
    expect(authorizeToolCall(bound, 'register_run', { agentId: 'agent-b' }).ok).toBe(false)
    expect(authorizeToolCall(bound, 'heartbeat_run', { agentId: 'agent-b' }).code).toBe('OWN_RUN_ONLY')
    expect(authorizeToolCall(bound, 'submit_stage_evidence', { agentId: 'agent-b' }).code).toBe(
      'OWN_RUN_ONLY',
    )
  })

  it('ROOT may upsert_run / set_run_status via lifecycle; AGENT needs binding', () => {
    const root = principal('ROOT_ORCHESTRATOR')
    expect(authorizeToolCall(root, 'upsert_run', { agentId: 'any' }).ok).toBe(true)
    expect(authorizeToolCall(root, 'set_run_status', { agentId: 'any' }).ok).toBe(true)
    const agent = principal('AGENT', { agentId: 'agent-a' })
    expect(authorizeToolCall(agent, 'upsert_run', { agentId: 'agent-a' }).ok).toBe(true)
    expect(authorizeToolCall(agent, 'set_run_status', { agentId: 'agent-b' }).ok).toBe(false)
  })

  it('ROOT denied when productionApprovalId present', () => {
    const r = authorizeToolCall(principal('ROOT_ORCHESTRATOR'), 'publish_dispatch_plan', {
      productionApprovalId: 'x',
    })
    expect(r.ok).toBe(false)
    expect(r.code).toBe('ROOT_PRODUCTION_APPROVAL_DENIED')
  })

  it('only ROOT lists/calls publish_dispatch_plan and sync_accounts', () => {
    const root = principal('ROOT_ORCHESTRATOR')
    const owner = principal('OWNER')
    const agent = principal('AGENT')
    expect(authorizeToolCall(root, 'publish_dispatch_plan').ok).toBe(true)
    expect(authorizeToolCall(owner, 'publish_dispatch_plan').ok).toBe(false)
    expect(authorizeToolCall(agent, 'sync_accounts').ok).toBe(false)
    expect(isToolListable(owner, 'publish_dispatch_plan')).toBe(false)
    expect(isToolListable(root, 'publish_dispatch_plan')).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// CSRF positive / negative / origin / session / replay
// ---------------------------------------------------------------------------
describe('CSRF / same-origin protection', () => {
  it('C3 client-token carry-forward constant is explicit and non-empty', () => {
    expect(C3_CSRF_TOKEN_CLIENT_WIRING).toMatch(/C3_CSRF_TOKEN_CLIENT_WIRING/)
    expect(C3_CSRF_TOKEN_CLIENT_WIRING).toMatch(/X-CSRF-Token/)
  })

  it('positive: valid session-bound token + same origin', () => {
    setCsrfSecret('test-csrf-secret')
    const session = 'session-token-aaa'
    const token = deriveCsrfToken(session)
    const r = assertBrowserWriteCsrf({
      sessionToken: session,
      csrfHeader: token,
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(r).toEqual({ ok: true, mode: 'token' })
  })

  it('default fail-closed: missing token rejected even with same-origin (token mandatory)', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: 'sess',
      csrfHeader: null,
      origin: ORIGIN,
      host: HOST,
      // omit allowSameOriginWithoutToken — default must require token
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_TOKEN_MISSING')
  })

  it('explicit interim: missing token allowed only when allowSameOriginWithoutToken=true', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: 'sess',
      csrfHeader: null,
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: true,
    })
    expect(r).toEqual({ ok: true, mode: 'same-origin-deferred' })
  })

  it('negative: missing token rejected when allowSameOriginWithoutToken=false', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: 'sess',
      csrfHeader: '',
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_TOKEN_MISSING')
  })

  it('negative: invalid token rejected (constant-time path)', () => {
    setCsrfSecret('test-csrf-secret')
    const session = 'session-token-bbb'
    const r = assertBrowserWriteCsrf({
      sessionToken: session,
      csrfHeader: '0'.repeat(64),
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_TOKEN_INVALID')
  })

  it('session mismatch: token derived for other session is invalid', () => {
    setCsrfSecret('test-csrf-secret')
    const tokenForA = deriveCsrfToken('session-A')
    const r = assertBrowserWriteCsrf({
      sessionToken: 'session-B',
      csrfHeader: tokenForA,
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_TOKEN_INVALID')
  })

  it('origin mismatch rejected even with valid token', () => {
    setCsrfSecret('test-csrf-secret')
    const session = 'sess-o'
    const token = deriveCsrfToken(session)
    const r = assertBrowserWriteCsrf({
      sessionToken: session,
      csrfHeader: token,
      origin: 'https://evil.example',
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_ORIGIN_MISMATCH')
  })

  it('origin missing rejected', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: 'sess',
      csrfHeader: null,
      origin: null,
      referer: null,
      host: HOST,
      allowSameOriginWithoutToken: true,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_ORIGIN_MISSING')
  })

  it('session required for CSRF', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: null,
      csrfHeader: 'x',
      origin: ORIGIN,
      host: HOST,
    })
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.code).toBe('CSRF_SESSION_REQUIRED')
  })

  it('replay: oneTime token second use → CSRF_REPLAY', () => {
    setCsrfSecret('test-csrf-secret')
    const session = 'sess-replay'
    const token = deriveCsrfToken(session)
    const input = {
      sessionToken: session,
      csrfHeader: token,
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false as const,
      oneTime: true,
    }
    const first = assertBrowserWriteCsrf(input)
    expect(first.ok).toBe(true)
    const second = assertBrowserWriteCsrf(input)
    expect(second.ok).toBe(false)
    if (!second.ok) expect(second.code).toBe('CSRF_REPLAY')
  })

  it('isSameOrigin: host:port exact match; cross-port fails', () => {
    expect(isSameOrigin({ origin: 'http://localhost:3000', host: 'localhost:3000' }).ok).toBe(
      true,
    )
    expect(isSameOrigin({ origin: 'http://localhost:3001', host: 'localhost:3000' }).ok).toBe(
      false,
    )
    expect(isSameOrigin({ referer: 'http://localhost:3000/path', host: 'localhost:3000' }).ok).toBe(
      true,
    )
  })

  it('isSameOrigin: scheme+host+port must match when protocol provided (B4/W9)', () => {
    // Cross-scheme accepted was the W15-10 break — https origin vs http request protocol
    expect(
      isSameOrigin({
        origin: 'https://localhost:3000',
        host: 'localhost:3000',
        protocol: 'http',
      }).ok,
    ).toBe(false)
    expect(
      isSameOrigin({
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        protocol: 'https',
      }).ok,
    ).toBe(false)
    expect(
      isSameOrigin({
        origin: 'http://localhost:3000',
        host: 'localhost:3000',
        protocol: 'http',
      }).ok,
    ).toBe(true)
    expect(
      isSameOrigin({
        origin: 'https://localhost:3000',
        host: 'localhost:3000',
        protocol: 'https:',
      }).ok,
    ).toBe(true)
    // Full CSRF path also rejects cross-scheme when protocol is known
    setCsrfSecret('test-csrf-secret')
    const session = 'sess-scheme'
    const token = deriveCsrfToken(session)
    const cross = assertBrowserWriteCsrf({
      sessionToken: session,
      csrfHeader: token,
      origin: 'https://localhost:3000',
      host: HOST,
      protocol: 'http',
      allowSameOriginWithoutToken: false,
    })
    expect(cross.ok).toBe(false)
    if (!cross.ok) expect(cross.code).toBe('CSRF_ORIGIN_MISMATCH')
  })

  it('production-like env without explicit CSRF secret fails closed; unit inject works', () => {
    setCsrfSecret(null)
    // Pure env classification
    expect(isProductionLikeCsrfEnv({ NODE_ENV: 'production' })).toBe(true)
    expect(isProductionLikeCsrfEnv({ NODE_ENV: 'test' })).toBe(false)
    expect(isProductionLikeCsrfEnv({ CAIRN_ENV: 'staging' })).toBe(true)
    expect(isProductionLikeCsrfEnv({ NODE_ENV: 'development' })).toBe(false)

    const prodMissing = resolveCsrfSecret({ NODE_ENV: 'production' })
    expect(prodMissing.ok).toBe(false)
    if (!prodMissing.ok) expect(prodMissing.code).toBe('CSRF_SECRET_REQUIRED')

    const prodWithEnv = resolveCsrfSecret({
      NODE_ENV: 'production',
      CAIRN_CSRF_SECRET: 'prod-explicit-secret',
    })
    expect(prodWithEnv.ok).toBe(true)
    if (prodWithEnv.ok) {
      expect(prodWithEnv.source).toBe('env')
      expect(prodWithEnv.secret).toBe('prod-explicit-secret')
    }
    // Clear env-cached secret from previous resolution
    setCsrfSecret(null)

    const localDefault = resolveCsrfSecret({ NODE_ENV: 'test' })
    expect(localDefault.ok).toBe(true)
    if (localDefault.ok) {
      expect(localDefault.source).toBe('dev-default')
      expect(localDefault.secret).toBe(CSRF_DEV_DEFAULT_SECRET)
    }
    setCsrfSecret(null)

    // Injected secret wins even under production-like classification for unit tests
    setCsrfSecret('unit-injected-secret')
    const injected = resolveCsrfSecret({ NODE_ENV: 'production' })
    expect(injected.ok).toBe(true)
    if (injected.ok) {
      expect(injected.source).toBe('injected')
      expect(injected.secret).toBe('unit-injected-secret')
    }

    // assertBrowserWriteCsrf fails closed when production-like and no secret (no inject, no env)
    setCsrfSecret(null)
    const prevNode = process.env.NODE_ENV
    const prevCsrf = process.env.CAIRN_CSRF_SECRET
    try {
      process.env.NODE_ENV = 'production'
      delete process.env.CAIRN_CSRF_SECRET
      const r = assertBrowserWriteCsrf({
        sessionToken: 'sess',
        csrfHeader: null,
        origin: ORIGIN,
        host: HOST,
        protocol: 'http',
        allowSameOriginWithoutToken: true,
      })
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.code).toBe('CSRF_SECRET_REQUIRED')
    } finally {
      process.env.NODE_ENV = prevNode
      if (prevCsrf === undefined) delete process.env.CAIRN_CSRF_SECRET
      else process.env.CAIRN_CSRF_SECRET = prevCsrf
      setCsrfSecret(null)
    }
  })

  it('safeEqualHex is length-sensitive and equal for identical', () => {
    expect(safeEqualHex('abcd', 'abcd')).toBe(true)
    expect(safeEqualHex('abcd', 'abce')).toBe(false)
    expect(safeEqualHex('abc', 'abcd')).toBe(false)
  })

  it('guard is never globally disabled: missing origin fails even with allowSameOriginWithoutToken', () => {
    const r = assertBrowserWriteCsrf({
      sessionToken: 's',
      csrfHeader: null,
      host: HOST,
      allowSameOriginWithoutToken: true,
    })
    expect(r.ok).toBe(false)
  })
})

// ---------------------------------------------------------------------------
// Existing auth regression (session mapping + board visibility semantics)
// ---------------------------------------------------------------------------
describe('existing auth regression (session semantics preserved)', () => {
  it('legacy admin still full board visibility via OWNER mapping', () => {
    const p = principalFromSession(sessionAdmin())!
    expect(canAccessBoard(p, 'mfs-rebuild')).toBe(true)
    expect(canAccessBoard(p, 'ibils')).toBe(true)
    expect(canAccessBoard(p, 'new-board')).toBe(true)
  })

  it('legacy member still restricted to boards[] allowlist and read-only scopes', () => {
    const p = principalFromSession(sessionMember({ boards: ['only-a'] }))!
    expect(canAccessBoard(p, 'only-a')).toBe(true)
    expect(canAccessBoard(p, 'only-b')).toBe(false)
    expect(p.scopes.every((s) => s.endsWith(':read'))).toBe(true)
  })

  it('does not rewrite shared Role type values — only maps at boundary', () => {
    const admin = sessionAdmin()
    const member = sessionMember()
    expect(admin.role).toBe('admin')
    expect(member.role).toBe('member')
    // Mapping is pure; original objects untouched
    principalFromSession(admin)
    principalFromSession(member)
    expect(admin.role).toBe('admin')
    expect(member.role).toBe('member')
  })
})

// ---------------------------------------------------------------------------
// Hostile fail-closed: custom scopes, cross-board, missing CSRF, board-bind
// ---------------------------------------------------------------------------
describe('hostile fail-closed: custom scopes / board binding / CSRF', () => {
  it('hostile custom scopes cannot elevate past role maxima (AGENT)', () => {
    const hostile: Scope[] = [
      'dispatch:write',
      'policy:write',
      'account:sync',
      'run:write',
      'board:read',
    ]
    const clamped = intersectScopesWithRoleMaxima('AGENT', hostile)
    expect(clamped).toContain('run:write')
    expect(clamped).toContain('board:read')
    expect(clamped).not.toContain('dispatch:write')
    expect(clamped).not.toContain('policy:write')
    expect(clamped).not.toContain('account:sync')
    // Only AGENT maxima that were also requested
    for (const s of clamped) {
      expect(defaultScopesForRole('AGENT')).toContain(s)
      expect(hostile).toContain(s)
    }
  })

  it('hostile custom scopes cannot elevate past role maxima (INTEGRATOR / OWNER)', () => {
    expect(intersectScopesWithRoleMaxima('INTEGRATOR', ['dispatch:write', 'integration:write'])).toEqual([
      'integration:write',
    ])
    // OWNER cannot gain dispatch via configured scopes
    const ownerClamped = intersectScopesWithRoleMaxima('OWNER', [
      'dispatch:write',
      'policy:write',
      'decision:write',
    ])
    expect(ownerClamped).toContain('policy:write')
    expect(ownerClamped).toContain('decision:write')
    expect(ownerClamped).not.toContain('dispatch:write')
  })

  it('bearer record with hostile scopes is clamped at resolve', async () => {
    setBearerTokenRecords([
      {
        tokenId: 'hostile-agent',
        secret: 'sec-hostile',
        role: 'AGENT',
        actorId: 'agent-h',
        agentId: 'agent-h',
        boardId: 'board-a',
        scopes: ['dispatch:write', 'policy:write', 'run:write', 'board:read'] as Scope[],
      },
    ])
    const r = await resolveBearerPrincipal('sec-hostile')
    expect(r.principal).not.toBeNull()
    expect(hasScope(r.principal, 'dispatch:write')).toBe(false)
    expect(hasScope(r.principal, 'policy:write')).toBe(false)
    expect(hasScope(r.principal, 'run:write')).toBe(true)
    expect(authorizeToolCall(r.principal, 'publish_dispatch_plan').ok).toBe(false)
  })

  it('AGENT/INTEGRATOR unbound board → principal null (fail closed)', async () => {
    setBearerTokenRecords([
      {
        tokenId: 'unbound-agent',
        secret: 'sec-unbound-a',
        role: 'AGENT',
        actorId: 'a-unbound',
        agentId: 'a-unbound',
        // no boardId
      },
      {
        tokenId: 'unbound-int',
        secret: 'sec-unbound-i',
        role: 'INTEGRATOR',
        actorId: 'i-unbound',
      },
    ])
    expect((await resolveBearerPrincipal('sec-unbound-a')).principal).toBeNull()
    expect((await resolveBearerPrincipal('sec-unbound-i')).principal).toBeNull()
    expect(principalFromBearerRecord({
      tokenId: 'x',
      secret: 's',
      role: 'AGENT',
      actorId: 'a',
    })).toBeNull()
  })

  it('cross-board: board-bound AGENT denied on foreign boardId', () => {
    const agent = principal('AGENT', {
      agentId: 'agent-a',
      boardId: 'board-a',
      boards: ['board-a'],
    })
    expect(canAccessBoard(agent, 'board-a')).toBe(true)
    expect(canAccessBoard(agent, 'board-b')).toBe(false)
    expect(
      authorizeToolCall(agent, 'list_tasks', { boardId: 'board-b' }).ok,
    ).toBe(false)
    expect(
      authorizeToolCall(agent, 'list_tasks', { boardId: 'board-a' }).ok,
    ).toBe(true)
    // Unbound AGENT denies all boards
    const unbound = principal('AGENT', { agentId: 'agent-a', boardId: null, boards: [] })
    expect(canAccessBoard(unbound, 'board-a')).toBe(false)
    expect(clampBearerPrincipal(unbound)).toBeNull()
  })

  it('ROOT unbound still has cross-board authority; OWNER always all boards', () => {
    const root = principal('ROOT_ORCHESTRATOR', { boards: [], boardId: null })
    expect(canAccessBoard(root, 'any-1')).toBe(true)
    expect(canAccessBoard(root, 'any-2')).toBe(true)
    const owner = principal('OWNER')
    expect(canAccessBoard(owner, 'z')).toBe(true)
  })

  // ---- P0 board-bound RBAC: unscoped list_boards + cross-board (repair) ----
  it('P0: board-bound AGENT denied unscoped list_boards (missing boardId)', () => {
    const agent = principal('AGENT', {
      agentId: 'agent-a',
      boardId: 'board-a',
      boards: ['board-a'],
    })
    // Verified defect: board scope used to run only when boardId present → list_boards open.
    const unscoped = authorizeToolCall(agent, 'list_boards', {})
    expect(unscoped.ok).toBe(false)
    expect(unscoped.code).toBe('FORBIDDEN_SCOPE')
    expect(unscoped.message).toMatch(/unscoped board enumeration|board-bound/)
    // Even with own boardId arg, list_boards is global enumeration — still denied.
    const withOwn = authorizeToolCall(agent, 'list_boards', { boardId: 'board-a' })
    expect(withOwn.ok).toBe(false)
    expect(withOwn.code).toBe('FORBIDDEN_SCOPE')
    // tools/list must also hide unscoped enumeration for board-bound principals
    expect(isToolListable(agent, 'list_boards')).toBe(false)
    expect(listHumanSafeToolNames(agent)).not.toContain('list_boards')
    expect(authorizeToolCall(agent, 'list_boards', {}).ok).toBe(false)
  })

  it('P0: board-bound INTEGRATOR denied unscoped list_boards', () => {
    const integ = principal('INTEGRATOR', {
      boardId: 'board-a',
      boards: ['board-a'],
      pathspecs: ['src/**'],
    })
    expect(authorizeToolCall(integ, 'list_boards', {}).ok).toBe(false)
    expect(authorizeToolCall(integ, 'list_boards', {}).code).toBe('FORBIDDEN_SCOPE')
    expect(isToolListable(integ, 'list_boards')).toBe(false)
    expect(listHumanSafeToolNames(integ)).not.toContain('list_boards')
    // Cross-board still denied on scoped tools
    expect(authorizeToolCall(integ, 'list_projects', { boardId: 'board-b' }).ok).toBe(false)
    expect(authorizeToolCall(integ, 'list_projects', { boardId: 'board-a' }).ok).toBe(true)
  })

  it('P0: OWNER/ROOT/member/public-snapshot preserve list_boards + public behavior', () => {
    expect(authorizeToolCall(principal('OWNER'), 'list_boards', {}).ok).toBe(true)
    expect(authorizeToolCall(principal('ROOT_ORCHESTRATOR'), 'list_boards', {}).ok).toBe(true)
    expect(isToolListable(principal('OWNER'), 'list_boards')).toBe(true)
    expect(isToolListable(principal('ROOT_ORCHESTRATOR'), 'list_boards')).toBe(true)
    // member session allowlist still may call list_boards (session surface)
    const member = principalFromSession(sessionMember({ boards: ['mfs-rebuild'] }))!
    expect(authorizeToolCall(member, 'list_boards', {}).ok).toBe(true)
    expect(isToolListable(member, 'list_boards')).toBe(true)
    // public snapshot remains open without auth
    expect(authorizeToolCall(null, 'get_public_snapshot').ok).toBe(true)
    expect(authorizeToolCall(publicPrincipal(), 'get_public_snapshot').ok).toBe(true)
    expect(isToolListable(null, 'get_public_snapshot')).toBe(true)
    // public cannot list_boards
    expect(authorizeToolCall(publicPrincipal(), 'list_boards').ok).toBe(false)
    expect(isToolListable(publicPrincipal(), 'list_boards')).toBe(false)
  })

  it('P0: board-bound AGENT/INTEGRATOR cross-board deny; empty boardId not a bypass', () => {
    const agent = principal('AGENT', {
      agentId: 'agent-a',
      boardId: 'board-a',
      boards: ['board-a'],
    })
    const foreign = authorizeToolCall(agent, 'get_overview', { boardId: 'board-b' })
    expect(foreign.ok).toBe(false)
    expect(foreign.code).toBe('FORBIDDEN_SCOPE')
    expect(foreign.message).toMatch(/no access to this board/)
    expect(authorizeToolCall(agent, 'get_overview', { boardId: 'board-a' }).ok).toBe(true)
    // Empty / whitespace boardId must not open unscoped path for board-bound principals
    expect(authorizeToolCall(agent, 'list_tasks', { boardId: '' }).ok).toBe(false)
    expect(authorizeToolCall(agent, 'list_tasks', { boardId: '   ' }).ok).toBe(false)
    // Adjacent catalog audit: create_board/delete_board remain role-gated (not agent)
    expect(authorizeToolCall(agent, 'create_board', { id: 'x', name: 'x' }).ok).toBe(false)
    expect(authorizeToolCall(agent, 'delete_board', { boardId: 'board-a' }).ok).toBe(false)
    expect(authorizeToolCall(agent, 'update_board', { boardId: 'board-a' }).ok).toBe(false)
    // Helper catalog is explicit and only list_boards today
    expect(UNSCOPED_BOARD_ENUMERATION_TOOLS).toEqual(['list_boards'])
    expect(isUnscopedBoardEnumerationTool('list_boards')).toBe(true)
    expect(isUnscopedBoardEnumerationTool('list_tasks')).toBe(false)
    expect(deniesUnscopedBoardEnumeration(agent)).toBe(true)
    expect(deniesUnscopedBoardEnumeration(principal('OWNER'))).toBe(false)
    expect(deniesUnscopedBoardEnumeration(principal('ROOT_ORCHESTRATOR'))).toBe(false)
  })

  it('P0: board-bound principal may still call board-scoped reads with matching boardId', () => {
    const agent = principal('AGENT', {
      agentId: 'agent-a',
      boardId: 'board-a',
      boards: ['board-a'],
    })
    for (const tool of [
      'list_projects',
      'list_features',
      'list_tasks',
      'get_overview',
      'list_work_items',
      'get_priority_portfolio',
    ] as const) {
      expect(authorizeToolCall(agent, tool, { boardId: 'board-a' }).ok, tool).toBe(true)
      expect(authorizeToolCall(agent, tool, { boardId: 'board-b' }).ok, tool).toBe(false)
    }
  })

  it('missing CSRF: same-origin alone insufficient (default deny)', () => {
    setCsrfSecret('test-csrf-secret')
    const missing = assertBrowserWriteCsrf({
      sessionToken: 'sess-csrf-miss',
      csrfHeader: undefined,
      origin: ORIGIN,
      host: HOST,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('CSRF_TOKEN_MISSING')

    const empty = assertBrowserWriteCsrf({
      sessionToken: 'sess-csrf-miss',
      csrfHeader: '   ',
      origin: ORIGIN,
      host: HOST,
      allowSameOriginWithoutToken: false,
    })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('CSRF_TOKEN_MISSING')
  })

  it('login/bootstrap origin helper rejects cross-origin and missing origin', () => {
    expect(
      assertBrowserOrigin({
        origin: ORIGIN,
        host: HOST,
        protocol: 'http',
      }).ok,
    ).toBe(true)
    expect(
      assertBrowserOrigin({
        origin: 'https://evil.example',
        host: HOST,
      }).ok,
    ).toBe(false)
    const missing = assertBrowserOrigin({
      origin: null,
      referer: null,
      host: HOST,
    })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('CSRF_ORIGIN_MISSING')
  })
})

// ---------------------------------------------------------------------------
// Canonical MCP catalog integrity + human-safe tools/list + least-privilege
// ---------------------------------------------------------------------------
describe('canonical MCP tool catalog (MCP_TOOL_SPECS)', () => {
  it('assertMcpToolCatalogIntegrity: all contract reads registered, no dups, aliases resolve', () => {
    expect(() => assertMcpToolCatalogIntegrity()).not.toThrow()
    const names = MCP_TOOL_SPECS.map((s) => s.name)
    expect(new Set(names).size).toBe(names.length)
    for (const required of CANONICAL_MCP_READ_TOOL_NAMES) {
      expect(names, required).toContain(required)
      expect(getToolSpec(required)).toBeDefined()
    }
    // Exact set of five previously-missing canonical tools
    for (const n of [
      'list_work_items',
      'get_priority_portfolio',
      'get_run',
      'get_account',
      'get_decision',
    ] as const) {
      expect(getToolSpec(n)).toBeDefined()
      expect(getToolSpec(n)!.kind).toBe('read')
    }
    expect(getToolSpec('get_project')).toBeDefined()
  })

  it('preserves get_dispatch_next alias of get_next (+ work/priority/overview aliases)', () => {
    expect(getToolSpec('get_dispatch_next')?.aliasOf).toBe('get_next')
    expect(resolveToolAliasTarget('get_dispatch_next')).toBe('get_next')
    expect(resolveToolAliasTarget('get_next')).toBe('get_next')
    expect(getToolSpec('get_work')?.aliasOf).toBe('list_work_items')
    expect(getToolSpec('get_priority')?.aliasOf).toBe('get_priority_portfolio')
    expect(getToolSpec('get_rollup')?.aliasOf).toBe('get_overview')
    expect(getToolSpec('get_lifecycle')?.aliasOf).toBe('get_overview')
    expect(getToolSpec('get_board_hash')?.aliasOf).toBe('get_overview')
    expect(resolveToolAliasTarget('invented_tool')).toBeNull()
  })

  it('least-privilege scopes for new canonical reads', () => {
    expect(getToolSpec('list_work_items')!.scopes).toEqual(
      expect.arrayContaining(['board:read', 'task:read']),
    )
    expect(getToolSpec('get_priority_portfolio')!.scopes).toEqual(['board:read'])
    expect(getToolSpec('get_run')!.scopes).toEqual(['run:read'])
    expect(getToolSpec('get_account')!.scopes).toEqual(['account:read'])
    expect(getToolSpec('get_decision')!.scopes).toEqual(['decision:read'])
    // Must not over-scope get_account to board:read alone (would leak to AGENT)
    expect(getToolSpec('get_account')!.scopes).not.toContain('board:read')
  })

  it('human-safe catalog: unauth only public; never invents unknown tools', () => {
    const unauth = listHumanSafeToolNames(null)
    expect(unauth).toEqual(['get_public_snapshot'])
    expect(listHumanSafeToolCatalog(null).every((s) => s.kind === 'public')).toBe(true)

    const pub = listHumanSafeToolNames(publicPrincipal())
    expect(pub).toEqual(['get_public_snapshot'])

    // Catalog only emits names present in MCP_TOOL_SPECS
    const ownerNames = listHumanSafeToolNames(principal('OWNER'))
    for (const n of ownerNames) {
      expect(getToolSpec(n)).toBeDefined()
    }
    expect(ownerNames).not.toContain('__internal_dump')
    expect(ownerNames).not.toContain('compute_my_own_rollup')
  })

  it('human-safe catalog lists exact canonical tools for authorized roles', () => {
    const owner = principal('OWNER')
    const names = listHumanSafeToolNames(owner)
    for (const n of [
      'list_work_items',
      'get_priority_portfolio',
      'get_run',
      'get_account',
      'get_decision',
      'get_dispatch_next',
      'get_next',
      'get_work',
      'get_priority',
    ]) {
      expect(names).toContain(n)
      expect(isToolListable(owner, n)).toBe(true)
      expect(authorizeToolCall(owner, n).ok).toBe(true)
    }
  })

  it('hostile tool-list: AGENT cannot list/call account tools; can list runs/work', () => {
    const agent = principal('AGENT', { agentId: 'a1', boardId: 'b1', boards: ['b1'] })
    expect(isToolListable(agent, 'get_account')).toBe(false)
    expect(isToolListable(agent, 'list_accounts')).toBe(false)
    expect(authorizeToolCall(agent, 'get_account').ok).toBe(false)
    expect(authorizeToolCall(agent, 'list_accounts').ok).toBe(false)

    expect(isToolListable(agent, 'get_run')).toBe(true)
    expect(isToolListable(agent, 'list_runs')).toBe(true)
    expect(isToolListable(agent, 'list_work_items')).toBe(true)
    expect(isToolListable(agent, 'get_priority_portfolio')).toBe(true)
    expect(isToolListable(agent, 'get_decision')).toBe(true)
    expect(authorizeToolCall(agent, 'get_run').ok).toBe(true)
    expect(authorizeToolCall(agent, 'list_work_items').ok).toBe(true)
    expect(authorizeToolCall(agent, 'get_decision').ok).toBe(true)

    const catalog = listHumanSafeToolNames(agent)
    expect(catalog).toContain('list_work_items')
    expect(catalog).toContain('get_run')
    expect(catalog).not.toContain('get_account')
    expect(catalog).not.toContain('list_accounts')
    expect(catalog).not.toContain('sync_accounts')
    expect(catalog).not.toContain('publish_dispatch_plan')
  })

  it('hostile tool-list: INTEGRATOR cannot list sensitive account/run/decision/audit', () => {
    const integ = principal('INTEGRATOR', { boardId: 'b1', boards: ['b1'] })
    for (const n of [
      'get_account',
      'list_accounts',
      'get_run',
      'list_runs',
      'get_decision',
      'list_decisions',
      'list_audit',
    ]) {
      expect(isToolListable(integ, n)).toBe(false)
      expect(authorizeToolCall(integ, n).ok).toBe(false)
    }
    // Board/task reads still listable
    expect(isToolListable(integ, 'list_work_items')).toBe(true)
    expect(isToolListable(integ, 'get_priority_portfolio')).toBe(true)
    expect(isToolListable(integ, 'list_projects')).toBe(true)
  })

  it('hostile tool-list: member session board/task only; no account/run/decision', () => {
    const m = principalFromSession(sessionMember())!
    expect(isToolListable(m, 'list_work_items')).toBe(true)
    expect(isToolListable(m, 'get_priority_portfolio')).toBe(true)
    expect(isToolListable(m, 'get_dispatch_next')).toBe(true)
    expect(isToolListable(m, 'get_account')).toBe(false)
    expect(isToolListable(m, 'get_run')).toBe(false)
    expect(isToolListable(m, 'get_decision')).toBe(false)
    expect(isToolListable(m, 'list_audit')).toBe(false)
    expect(authorizeToolCall(m, 'get_account').ok).toBe(false)
    expect(authorizeToolCall(m, 'list_work_items').ok).toBe(true)
  })

  it('get_dispatch_next and get_next share listability + authorize for every role', () => {
    for (const role of ['OWNER', 'ROOT_ORCHESTRATOR', 'AGENT', 'INTEGRATOR'] as V3Role[]) {
      const p = principal(role, {
        agentId: role === 'AGENT' ? 'a' : undefined,
        boardId: role === 'AGENT' || role === 'INTEGRATOR' ? 'b' : undefined,
        boards: role === 'AGENT' || role === 'INTEGRATOR' ? ['b'] : [],
      })
      expect(isToolListable(p, 'get_next')).toBe(isToolListable(p, 'get_dispatch_next'))
      expect(authorizeToolCall(p, 'get_next').ok).toBe(authorizeToolCall(p, 'get_dispatch_next').ok)
    }
    expect(isToolListable(null, 'get_dispatch_next')).toBe(false)
    expect(authorizeToolCall(null, 'get_dispatch_next').ok).toBe(false)
  })

  it('unknown tool names are never listable or authorized', () => {
    const owner = principal('OWNER')
    expect(isToolListable(owner, 'not_a_real_tool')).toBe(false)
    expect(authorizeToolCall(owner, 'not_a_real_tool').ok).toBe(false)
    expect(authorizeToolCall(owner, 'not_a_real_tool').code).toBe('AUTHORIZATION_REQUIRED')
    expect(listHumanSafeToolNames(owner)).not.toContain('not_a_real_tool')
  })
})


describe('INTEGRATOR missing bindings fail-closed', () => {
  it('denies INTEGRATOR without checkpoint/pathspec bindings', () => {
    const unbound: Principal = {
      role: 'INTEGRATOR',
      actorId: 'int-unbound',
      channel: 'bearer',
      scopes: defaultScopesForRole('INTEGRATOR'),
      boards: ['mfs-rebuild'],
    }
    expect(() => assertIntegratorBounds(unbound, { pathspec: 'src/x.ts', checkpointId: 'cp-1' })).toThrow(
      /missing checkpoint|missing pathspec/,
    )
    const noPath: Principal = {
      ...unbound,
      checkpointId: 'cp-1',
      pathspecs: [],
    }
    expect(() => assertIntegratorBounds(noPath, { pathspec: 'src/x.ts', checkpointId: 'cp-1' })).toThrow(
      /missing pathspec/,
    )
  })
})
