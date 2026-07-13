/**
 * Staging agent-operable MCP smoke library.
 *
 * Modes:
 *  - contract / --self-test: pure fixture + mocked MCP lifecycle (no server)
 *  - --real: SSH-tunneled STAGING_URL + dual-principal bearers (ROOT + AGENT)
 *
 * Dual-principal (real mode, fail-closed):
 *  - STAGING_ROOT_BEARER_TOKEN (legacy fallback: STAGING_BEARER_TOKEN|STAGING_BEARER|CAIRN_MCP_BEARER)
 *    → initialize/tools/list (root set), publish_dispatch_plan, get_next, sync_accounts, list_audit
 *  - STAGING_AGENT_BEARER_TOKEN (required in --real)
 *    → initialize/tools/list (agent set), register_run, heartbeat_run, assigned reads, set_run_status
 *  - STAGING_AGENT_ID required in --real so ownRun matches principal.agentId
 *
 * tools/list is gated per role — never demand all MCP tools from a single token.
 * Never prints or persists credentials; errors name token refs only.
 *
 * Reuses qa/e2e/lib/control-plane-bootstrap.mjs MCP helpers + redaction.
 */
import crypto from 'node:crypto'
import {
  comparePinParity,
  createSyntheticRootPrincipal,
  isMcpToolProgrammaticOk,
  mcpInitialize,
  mcpJsonRpc,
  mcpToolsCall,
  probeRuntimePin,
  redactSecretsDeep,
  sanitizeMcpCallResult,
  ControlPlaneBootstrapError,
} from './control-plane-bootstrap.mjs'
import {
  assertFullSha,
  isFullSha,
  normalizeFullSha,
  resolveBoardId,
  resolveStagingUrl,
} from './env.mjs'
import {
  buildAccountSyncArgs,
  buildDispatchPlanArgs,
  buildRegisterRunArgs,
  buildSyntheticSmokeIds,
  computePlanHash,
  loadDispatchPlanSeed,
  loadStagingManifest,
  loadStagingPin,
  runFixtureContractSelfTests,
  validateStagingFixtureContract,
} from '../../fixtures/staging/contract.mjs'

export class StagingAgentSmokeError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'StagingAgentSmokeError'
    this.detail = detail
    this.code = detail.code ?? 'STAGING_AGENT_SMOKE_FAIL'
  }
}

/**
 * ROOT principal env candidates (preferred first).
 * STAGING_ROOT_BEARER_TOKEN is canonical; legacy STAGING_BEARER_TOKEN etc. fall back for root ops only.
 * Values never logged — only tokenRef names appear in errors/receipts.
 */
export const ROOT_BEARER_ENV_CANDIDATES = Object.freeze([
  'STAGING_ROOT_BEARER_TOKEN',
  'STAGING_BEARER_TOKEN',
  'STAGING_BEARER',
  'CAIRN_MCP_BEARER',
])

/** AGENT principal env candidates — required for --real dual-principal smoke. */
export const AGENT_BEARER_ENV_CANDIDATES = Object.freeze(['STAGING_AGENT_BEARER_TOKEN'])

/**
 * @deprecated Use ROOT_BEARER_ENV_CANDIDATES. Kept as alias for root resolution BC.
 * Does NOT include STAGING_AGENT_BEARER_TOKEN (agent is separate).
 */
export const BEARER_ENV_CANDIDATES = ROOT_BEARER_ENV_CANDIDATES

/**
 * Tools ROOT_ORCHESTRATOR (default scopes, no run:write) must list for smoke.
 * Intentionally omits register_run / heartbeat_run (AGENT evidence tools).
 */
export const ROOT_REQUIRED_MCP_TOOLS = Object.freeze([
  'publish_dispatch_plan',
  'get_next',
  'sync_accounts',
  'list_tasks',
  'get_rollup',
  'list_audit',
  'get_task_lifecycle',
])

/**
 * Tools AGENT (run:write + reads) must list for smoke.
 * Omits publish_dispatch_plan / sync_accounts / list_audit (ROOT-only scopes/roles).
 */
export const AGENT_REQUIRED_MCP_TOOLS = Object.freeze([
  'register_run',
  'heartbeat_run',
  'list_tasks',
  'get_rollup',
  'get_task_lifecycle',
])

function resolveBearerFromCandidates(env, candidates, explicitRef, roleLabel) {
  const list = explicitRef
    ? [explicitRef, ...candidates.filter((c) => c !== explicitRef)]
    : [...candidates]
  for (const name of list) {
    const val = env[name]
    if (typeof val === 'string' && val.trim().length > 0) {
      return {
        ok: true,
        tokenRef: name,
        bearer: val.trim(),
        roleLabel,
        meta: {
          tokenRef: name,
          roleLabel,
          present: true,
          secretByteLength: Buffer.byteLength(val.trim(), 'utf8'),
        },
      }
    }
  }
  return {
    ok: false,
    tokenRef: explicitRef || candidates[0],
    bearer: null,
    roleLabel,
    reason: `missing ${roleLabel} bearer — set one of ${list.join('|')} (value never logged)`,
    meta: { tokenRef: explicitRef || candidates[0], roleLabel, present: false },
  }
}

/**
 * Resolve ROOT principal bearer by env name. Never log the secret.
 * Prefers STAGING_ROOT_BEARER_TOKEN; falls back to legacy STAGING_BEARER_TOKEN etc.
 * STAGING_ROOT_BEARER_TOKEN_REF or STAGING_BEARER_TOKEN_REF overrides candidate order.
 */
export function resolveRootTokenRef(env = process.env) {
  const explicitRef =
    env.STAGING_ROOT_BEARER_TOKEN_REF?.trim() || env.STAGING_BEARER_TOKEN_REF?.trim()
  return resolveBearerFromCandidates(env, ROOT_BEARER_ENV_CANDIDATES, explicitRef, 'ROOT')
}

/**
 * Resolve AGENT principal bearer. Real mode requires this separately from ROOT.
 * STAGING_AGENT_BEARER_TOKEN_REF may override the env name.
 */
export function resolveAgentTokenRef(env = process.env) {
  const explicitRef = env.STAGING_AGENT_BEARER_TOKEN_REF?.trim()
  return resolveBearerFromCandidates(env, AGENT_BEARER_ENV_CANDIDATES, explicitRef, 'AGENT')
}

/**
 * Dual-principal resolution for real smoke.
 * @param {object} [opts]
 * @param {boolean} [opts.requireAgent=true] fail closed when agent bearer missing
 * @param {boolean} [opts.requireAgentId=true] fail closed when STAGING_AGENT_ID missing (ownRun)
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   reason?: string,
 *   root: object,
 *   agent: object,
 *   agentId: string|null,
 *   dual: boolean,
 *   meta: object
 * }}
 */
export function resolveDualPrincipalTokens(env = process.env, opts = {}) {
  const requireAgent = opts.requireAgent !== false
  const requireAgentId = opts.requireAgentId !== false
  const root = resolveRootTokenRef(env)
  const agent = resolveAgentTokenRef(env)
  const agentIdRaw = env.STAGING_AGENT_ID?.trim() || null

  if (!root.ok) {
    return {
      ok: false,
      code: 'MISSING_ROOT_BEARER',
      reason: root.reason,
      root,
      agent,
      agentId: agentIdRaw,
      dual: false,
      meta: { root: root.meta, agent: agent.meta, agentIdPresent: Boolean(agentIdRaw) },
    }
  }
  if (requireAgent && !agent.ok) {
    return {
      ok: false,
      code: 'MISSING_AGENT_BEARER',
      reason:
        agent.reason ||
        'missing STAGING_AGENT_BEARER_TOKEN — real dual-principal smoke fail-closed (value never logged)',
      root,
      agent,
      agentId: agentIdRaw,
      dual: false,
      meta: { root: root.meta, agent: agent.meta, agentIdPresent: Boolean(agentIdRaw) },
    }
  }
  if (requireAgent && requireAgentId && agent.ok && !agentIdRaw) {
    return {
      ok: false,
      code: 'MISSING_AGENT_ID',
      reason:
        'missing STAGING_AGENT_ID — must equal CAIRN AGENT principal agentId/actorId for ownRun (value is an id, not a secret)',
      root,
      agent,
      agentId: null,
      dual: Boolean(agent.ok),
      meta: { root: root.meta, agent: agent.meta, agentIdPresent: false },
    }
  }

  return {
    ok: true,
    root,
    agent,
    agentId: agentIdRaw,
    dual: Boolean(agent.ok && agent.bearer),
    meta: {
      root: root.meta,
      agent: agent.meta,
      agentIdPresent: Boolean(agentIdRaw),
      dual: Boolean(agent.ok && agent.bearer),
    },
  }
}

/**
 * Legacy single-token resolver → ROOT candidates only (BC for harness / flow).
 * Prefer resolveRootTokenRef / resolveDualPrincipalTokens for new code.
 * STAGING_BEARER_TOKEN_REF overrides which env name is read among root candidates.
 * @returns {{ ok: true, tokenRef: string, bearer: string } | { ok: false, tokenRef: string|null, reason: string }}
 */
export function resolveAuthorizedTokenRef(env = process.env) {
  return resolveRootTokenRef(env)
}

export function resolveSmokeBoardId(env = process.env) {
  const manifest = loadStagingManifest()
  return resolveBoardId(manifest.boardId)
}

export function resolveExpectedSha(env = process.env, opts = {}) {
  const raw =
    env.EXPECTED_SHA?.trim() ||
    env.CAIRN_EXPECTED_SHA?.trim() ||
    env.FULL_SHA?.trim() ||
    env.CAIRN_DEPLOYED_SHA?.trim() ||
    ''
  if (raw) {
    const n = normalizeFullSha(raw)
    if (!n) {
      if (opts.require) {
        throw new StagingAgentSmokeError(
          `EXPECTED_SHA/FULL_SHA set but not 40-char hex (len=${raw.length})`,
          { code: 'INVALID_EXPECTED_SHA' },
        )
      }
      return null
    }
    return n
  }
  if (opts.require) {
    try {
      return assertFullSha()
    } catch (e) {
      throw new StagingAgentSmokeError(String(e.message || e), { code: 'MISSING_EXPECTED_SHA' })
    }
  }
  return null
}

export function resolveExpectedSchema(env = process.env) {
  const manifest = loadStagingManifest()
  return (
    env.SCHEMA_VERSION?.trim() ||
    env.CAIRN_SCHEMA_VERSION?.trim() ||
    manifest.schemaVersionExpected ||
    '003'
  )
}

/**
 * Create synthetic AGENT principal (for contract mocks / owned servers only).
 * Real staging uses resolveAuthorizedTokenRef — never invents server principals.
 */
export function createSyntheticAgentPrincipal(opts = {}) {
  const secret = crypto.randomBytes(32).toString('base64url')
  const agentId =
    opts.agentId ?? `synth-stg-smoke-agent-${crypto.randomBytes(4).toString('hex')}`
  const tokenId =
    opts.tokenId ?? `harness-agent-${crypto.randomBytes(4).toString('hex')}`
  const boardId = opts.boardId ?? loadStagingManifest().boardId
  const record = {
    tokenId,
    secret,
    role: 'AGENT',
    actorId: agentId,
    agentId,
    boardId,
    label: 'synthetic-staging-smoke-agent',
  }
  return {
    bearer: secret,
    principalsJson: JSON.stringify([record]),
    actorId: agentId,
    agentId,
    tokenId,
    role: 'AGENT',
    boardId,
    principalMeta: {
      role: 'AGENT',
      actorId: agentId,
      agentId,
      tokenId,
      boardId,
      hasSecret: true,
      secretByteLength: 32,
      secretEncoding: 'base64url',
    },
  }
}

function toolJsonOk(result) {
  return isMcpToolProgrammaticOk(result)
}

function isAuthDenied(result) {
  if (!result) return false
  if (result.httpStatus === 401 || result.httpStatus === 403) return true
  const code =
    result.toolJson?.code ||
    result.parsed?.error?.data?.code ||
    result.parsed?.error?.message ||
    ''
  return /AUTHORIZATION|UNAUTH|FORBIDDEN|401/i.test(String(code))
}

/**
 * Probe authenticated healthz and assert SHA/schema when expected provided.
 * Fail-closed on mismatch.
 */
export async function probeHealthzShaSchema(baseUrl, opts = {}) {
  const bearer = opts.bearer ?? null
  const secrets = bearer ? [bearer] : []
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/healthz`
  const headers = {}
  if (bearer) headers.authorization = `Bearer ${bearer}`

  let res
  try {
    res = await fetchImpl(url, { redirect: 'manual', headers })
  } catch (e) {
    return {
      ok: false,
      code: 'HEALTHZ_UNREACHABLE',
      error: String(e?.message || e),
      httpStatus: null,
    }
  }
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }

  const deployedSha =
    body?.deployedSha ?? body?.release?.sha ?? body?.observed?.deployedSha ?? null
  const healthSchema = body?.schemaVersion ?? null
  const schemaVersion =
    body?.schema?.version ??
    body?.migration?.schemaVersion ??
    body?.observed?.schemaVersion ??
    null
  const releaseMatch = body?.release?.match
  const schemaMatch = body?.schema?.match

  const expectedSha = opts.expectedSha ?? null
  const expectedSchema = opts.expectedSchema ?? null
  const expectedHealthSchema = opts.expectedHealthSchema ?? 'MFS_HEALTHZ_V1'

  const mismatches = []
  if (expectedSha && isFullSha(expectedSha)) {
    if (!deployedSha || String(deployedSha).toLowerCase() !== expectedSha.toLowerCase()) {
      mismatches.push({
        field: 'deployedSha',
        expected: expectedSha,
        got: deployedSha,
      })
    }
  }
  if (expectedSchema && schemaVersion && String(schemaVersion) !== String(expectedSchema)) {
    mismatches.push({
      field: 'schemaVersion',
      expected: expectedSchema,
      got: schemaVersion,
    })
  }
  if (healthSchema && expectedHealthSchema && healthSchema !== expectedHealthSchema) {
    mismatches.push({
      field: 'healthzSchema',
      expected: expectedHealthSchema,
      got: healthSchema,
    })
  }

  const out = redactSecretsDeep(
    {
      ok: res.ok && mismatches.length === 0,
      httpStatus: res.status,
      status: body?.status ?? null,
      healthSchema,
      deployedSha,
      schemaVersion,
      releaseMatch: releaseMatch ?? null,
      schemaMatch: schemaMatch ?? null,
      boardRev: body?.boardRev ?? null,
      lifecycleRev: body?.lifecycleRev ?? null,
      canonicalSnapshotId: body?.canonicalSnapshotId ?? null,
      unhealthyReasons: body?.unhealthyReasons ?? null,
      mismatches,
      code: mismatches.length
        ? 'HEALTH_PIN_MISMATCH'
        : res.ok
          ? null
          : `HTTP_${res.status}`,
      rawSlice: text.slice(0, 1200),
    },
    secrets,
  )
  return out
}

/**
 * Unauthenticated denial probe for sensitive MCP tools.
 */
export async function probeUnauthSensitiveDenial(baseUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl
  const boardId = opts.boardId ?? loadStagingManifest().boardId
  const tools = opts.tools ?? loadStagingManifest().sensitiveWriteTools
  const results = []
  for (let i = 0; i < tools.length; i++) {
    const name = tools[i]
    const raw = await mcpToolsCall(
      baseUrl,
      name,
      { boardId },
      { fetchImpl, bearer: null, id: 80000 + i },
    )
    const denied = isAuthDenied(raw) || !toolJsonOk(raw)
    results.push(
      redactSecretsDeep({
        tool: name,
        httpStatus: raw.httpStatus,
        denied,
        code:
          raw.toolJson?.code ??
          raw.parsed?.error?.data?.code ??
          raw.parsed?.error?.message ??
          null,
      }),
    )
  }
  const allDenied = results.every((r) => r.denied)
  return {
    ok: allDenied,
    results,
    code: allDenied ? null : 'SENSITIVE_UNAUTH_NOT_DENIED',
  }
}

/**
 * tools/list and assert required tool names present.
 */
export async function probeToolsList(baseUrl, opts = {}) {
  const bearer = opts.bearer
  const secrets = bearer ? [bearer] : []
  const raw = await mcpJsonRpc(
    baseUrl,
    { jsonrpc: '2.0', id: opts.id ?? 70001, method: 'tools/list' },
    { bearer, fetchImpl: opts.fetchImpl, secrets },
  )
  const tools = raw.parsed?.result?.tools ?? []
  const names = tools.map((t) => t.name).filter(Boolean)
  const required = (opts.requiredTools ?? loadStagingManifest().requiredMcpTools).filter(
    (t) => t !== 'tools/list',
  )
  const missing = required.filter((r) => !names.includes(r))
  return redactSecretsDeep(
    {
      ok: raw.ok && missing.length === 0,
      httpStatus: raw.httpStatus,
      toolCount: names.length,
      namesSample: names.slice(0, 40),
      missing,
      code: missing.length ? 'TOOLS_LIST_MISSING' : null,
    },
    secrets,
  )
}

/**
 * Full agent lifecycle smoke (real or mocked fetch).
 * Steps: health unauth → health auth SHA/schema → unauth sensitive deny →
 * tools/list (per role when dual) → publish → get_next → sync → register → heartbeat →
 * list_tasks / get_rollup / list_audit / get_task_lifecycle readback.
 *
 * Dual principal (opts.agentBearer set, or opts.dualPrincipal):
 *  - rootBearer/bearer: ROOT ops (publish, get_next, sync, list_audit, root tools/list)
 *  - agentBearer: AGENT ops (register, heartbeat, agent tools/list, agent reads, set_run_status)
 * Single bearer (self-test / legacy mock): all steps use opts.bearer.
 */
export async function runStagingAgentLifecycleSmoke(opts = {}) {
  const baseUrl = opts.baseUrl
  if (!baseUrl) {
    throw new StagingAgentSmokeError('baseUrl required', { code: 'MISSING_BASE_URL' })
  }
  const failClosed = opts.failClosed !== false
  const boardId = opts.boardId ?? resolveSmokeBoardId()
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids ?? buildSyntheticSmokeIds({ boardId })
  const now = opts.now ?? new Date().toISOString()
  // Dual-principal: prefer explicit root/agent; legacy single opts.bearer = root for all steps
  const rootBearer = opts.rootBearer ?? opts.bearer ?? null
  const agentBearer = opts.agentBearer ?? null
  const dualPrincipal = Boolean(opts.dualPrincipal || (rootBearer && agentBearer))
  const bearer = rootBearer // legacy alias used for health / pin probes
  const secrets = []
  if (rootBearer) secrets.push(rootBearer)
  if (agentBearer) secrets.push(agentBearer)
  if (opts.extraSecrets) secrets.push(...opts.extraSecrets)

  const fetchImpl = opts.fetchImpl
  const rootMcpOpts = { bearer: rootBearer, fetchImpl, secrets }
  const agentMcpOpts = {
    bearer: agentBearer || rootBearer,
    fetchImpl,
    secrets,
  }
  // When dual: agent ops MUST use agent bearer (never fall back to root for evidence tools)
  const agentOpsOpts = dualPrincipal
    ? { bearer: agentBearer, fetchImpl, secrets }
    : agentMcpOpts
  const expectedSha = opts.expectedSha ?? null
  const expectedSchema = opts.expectedSchema ?? resolveExpectedSchema()
  const skipPinCheck = opts.skipPinCheck === true
  const requireBearer = opts.requireBearer !== false
  // Real mode always requires AGENT principal (fail-closed). Self-test may use single mock bearer.
  const requireAgentBearer =
    opts.requireAgentBearer === true ||
    (opts.mode === 'real' && opts.requireDualPrincipal !== false)

  const receipt = {
    ok: false,
    mode: opts.mode ?? 'real',
    boardId,
    smokeRunId: ids.smokeRunId,
    tokenRef: opts.tokenRef ?? opts.rootTokenRef ?? null,
    rootTokenRef: opts.rootTokenRef ?? opts.tokenRef ?? null,
    agentTokenRef: opts.agentTokenRef ?? null,
    dualPrincipal,
    principalMeta: opts.principalMeta ?? null,
    ids: {
      planId: ids.planId,
      runId: ids.runId,
      agentId: ids.agentId,
      // no secrets
    },
    pin: {
      canonicalSnapshotId: pin.canonicalSnapshotId,
      boardRev: pin.boardRev,
      lifecycleRev: pin.lifecycleRev,
      taskHash: pin.taskHash,
      // hash present for parity; not a secret
      canonicalHash: pin.canonicalHash,
    },
    steps: {},
    residuals: [],
    cleanup: {
      rulesApplied: ['unique-ids', 'no-credential-persist', dualPrincipal ? 'dual-principal' : 'single-bearer'],
      reconcile: null,
    },
  }

  const fail = (step, code, detail) => {
    receipt.ok = false
    receipt.residuals.push({ step, code, detail: String(detail) })
    if (failClosed) {
      throw new StagingAgentSmokeError(`STAGING SMOKE FAIL [${step}]: ${detail}`, {
        code,
        step,
        detail: String(detail),
        receipt: redactSecretsDeep(receipt, secrets),
      })
    }
    return redactSecretsDeep(receipt, secrets)
  }

  if (requireBearer && !rootBearer) {
    return fail(
      'bearer',
      'MISSING_ROOT_BEARER',
      'authorized ROOT bearer required (token ref STAGING_ROOT_BEARER_TOKEN|STAGING_BEARER_TOKEN; value never logged)',
    )
  }
  if (requireAgentBearer && !agentBearer) {
    return fail(
      'bearer',
      'MISSING_AGENT_BEARER',
      'STAGING_AGENT_BEARER_TOKEN required for dual-principal real smoke (value never logged)',
    )
  }

  // 0) unauth health → expect 401 (or unreachable)
  {
    const unauth = await probeHealthzShaSchema(baseUrl, {
      bearer: null,
      fetchImpl,
      expectedSha: null,
    })
    if (unauth.code === 'HEALTHZ_UNREACHABLE' || unauth.httpStatus == null) {
      receipt.steps.healthzUnauth = {
        httpStatus: unauth.httpStatus,
        denied: false,
        code: 'HEALTHZ_UNREACHABLE',
        error: unauth.error ?? null,
      }
      return fail(
        'healthz_unauth',
        'HEALTHZ_UNREACHABLE',
        unauth.error || `unreachable ${baseUrl}`,
      )
    }
    const denied = unauth.httpStatus === 401 || unauth.httpStatus === 403
    receipt.steps.healthzUnauth = {
      httpStatus: unauth.httpStatus,
      denied,
      code: unauth.code,
    }
    if (!denied && opts.requireUnauthHealthDenial !== false) {
      // Some local stacks may differ; real staging must deny
      if (opts.mode === 'real' || opts.requireUnauthHealthDenial === true) {
        return fail(
          'healthz_unauth',
          'HEALTHZ_UNAUTH_NOT_DENIED',
          `expected 401, got ${unauth.httpStatus}`,
        )
      }
    }
  }

  // 1) auth health SHA/schema
  {
    const health = await probeHealthzShaSchema(baseUrl, {
      bearer,
      fetchImpl,
      expectedSha,
      expectedSchema,
      expectedHealthSchema: loadStagingManifest().healthzSchema,
    })
    receipt.steps.healthzAuth = redactSecretsDeep(
      {
        ok: health.ok,
        httpStatus: health.httpStatus,
        status: health.status,
        deployedSha: health.deployedSha,
        schemaVersion: health.schemaVersion,
        healthSchema: health.healthSchema,
        releaseMatch: health.releaseMatch,
        schemaMatch: health.schemaMatch,
        boardRev: health.boardRev,
        mismatches: health.mismatches,
        code: health.code,
      },
      secrets,
    )
    if (health.httpStatus === 0 || health.code === 'HEALTHZ_UNREACHABLE') {
      return fail('healthz_auth', 'HEALTHZ_UNREACHABLE', health.error || 'unreachable')
    }
    if (expectedSha && health.mismatches?.some((m) => m.field === 'deployedSha')) {
      return fail(
        'healthz_sha',
        'RELEASE_SHA_MISMATCH',
        JSON.stringify(health.mismatches),
      )
    }
    if (health.mismatches?.some((m) => m.field === 'schemaVersion' || m.field === 'healthzSchema')) {
      return fail(
        'healthz_schema',
        'SCHEMA_VERSION_MISMATCH',
        JSON.stringify(health.mismatches),
      )
    }
  }

  // 2) unauth sensitive MCP denial
  {
    const deny = await probeUnauthSensitiveDenial(baseUrl, {
      boardId,
      fetchImpl,
    })
    receipt.steps.unauthSensitive = deny
    if (!deny.ok) {
      return fail(
        'unauth_sensitive',
        'SENSITIVE_UNAUTH_NOT_DENIED',
        JSON.stringify(deny.results),
      )
    }
  }

  // 3) tools/list — per role when dual; single-token legacy demands full MANIFEST set
  {
    if (dualPrincipal) {
      const rootRequired =
        opts.rootRequiredTools ?? ROOT_REQUIRED_MCP_TOOLS
      const agentRequired =
        opts.agentRequiredTools ?? AGENT_REQUIRED_MCP_TOOLS
      const rootListed = await probeToolsList(baseUrl, {
        bearer: rootBearer,
        fetchImpl,
        requiredTools: rootRequired,
        id: 70001,
      })
      const agentListed = await probeToolsList(baseUrl, {
        bearer: agentBearer,
        fetchImpl,
        requiredTools: agentRequired,
        id: 70002,
      })
      // Also initialize each principal (tools/list gate already exercised; init is handshake)
      receipt.steps.toolsListRoot = rootListed
      receipt.steps.toolsListAgent = agentListed
      receipt.steps.toolsList = {
        ok: rootListed.ok && agentListed.ok,
        dualPrincipal: true,
        root: {
          ok: rootListed.ok,
          toolCount: rootListed.toolCount,
          missing: rootListed.missing,
          code: rootListed.code,
          tokenRef: opts.rootTokenRef ?? receipt.rootTokenRef,
        },
        agent: {
          ok: agentListed.ok,
          toolCount: agentListed.toolCount,
          missing: agentListed.missing,
          code: agentListed.code,
          tokenRef: opts.agentTokenRef ?? receipt.agentTokenRef,
        },
      }
      if (!rootListed.ok) {
        return fail(
          'tools_list_root',
          rootListed.code || 'TOOLS_LIST_ROOT_MISSING',
          JSON.stringify({
            tokenRef: opts.rootTokenRef ?? 'ROOT',
            missing: rootListed.missing,
          }),
        )
      }
      if (!agentListed.ok) {
        return fail(
          'tools_list_agent',
          agentListed.code || 'TOOLS_LIST_AGENT_MISSING',
          JSON.stringify({
            tokenRef: opts.agentTokenRef ?? 'AGENT',
            missing: agentListed.missing,
          }),
        )
      }
    } else {
      const listed = await probeToolsList(baseUrl, {
        bearer: rootBearer,
        fetchImpl,
        requiredTools: opts.requiredTools,
      })
      receipt.steps.toolsList = listed
      if (!listed.ok) {
        return fail('tools_list', listed.code || 'TOOLS_LIST_FAIL', JSON.stringify(listed.missing))
      }
    }
  }

  // Optional initialize (ROOT; AGENT init when dual)
  if (opts.initialize !== false) {
    try {
      receipt.steps.initialize = await mcpInitialize(baseUrl, {
        ...rootMcpOpts,
        id: 90001,
      })
    } catch (e) {
      receipt.steps.initialize = { ok: false, error: String(e?.message || e) }
    }
    if (dualPrincipal && agentBearer) {
      try {
        receipt.steps.initializeAgent = await mcpInitialize(baseUrl, {
          ...agentOpsOpts,
          id: 90002,
        })
      } catch (e) {
        receipt.steps.initializeAgent = { ok: false, error: String(e?.message || e) }
      }
    }
  }

  // Pin parity before publish
  let runtimePin =
    opts.runtimePin ??
    (await probeRuntimePin(baseUrl, { bearer: rootBearer, fetchImpl, secrets }))
  receipt.steps.runtimePin = redactSecretsDeep(
    {
      ok: runtimePin?.ok ?? null,
      httpStatus: runtimePin?.httpStatus ?? null,
      boardRev: runtimePin?.boardRev ?? null,
      lifecycleRev: runtimePin?.lifecycleRev ?? null,
      canonicalSnapshotId: runtimePin?.canonicalSnapshotId ?? null,
      taskHash: runtimePin?.taskHash ?? null,
    },
    secrets,
  )

  if (!skipPinCheck) {
    const authority = opts.authorityPin ?? pin
    // When runtime lacks pin fields (health-only), compare only present authority fields that runtime has
    const parity = comparePinParity(runtimePin, authority)
    receipt.steps.pinParity = parity
    // Soft: if runtime provides zero comparable fields, residual note but continue only when allowWeakPin
    if (!parity.ok) {
      if (opts.allowWeakPin && parity.compared?.length === 0) {
        receipt.residuals.push({
          step: 'pin_parity',
          code: 'PIN_UNOBSERVED',
          detail: 'runtime pin fields absent; continued under allowWeakPin',
        })
      } else {
        return fail('pin_parity', 'PIN_PARITY_MISMATCH', parity.detail || 'pin mismatch')
      }
    }
  }

  // 4) publish_dispatch_plan
  const dispatch = opts.dispatch ?? buildDispatchPlanArgs({ pin, ids, now, boardId })
  // If runtime boardRev observed and allowLiveRev, bind expectedBoardRev to live
  if (opts.bindLiveBoardRev && Number.isFinite(Number(runtimePin?.boardRev))) {
    dispatch.expectedBoardRev = Number(runtimePin.boardRev)
    for (const it of dispatch.items) {
      it.expectedBoardRev = Number(runtimePin.boardRev)
    }
    // recompute planHash if board-bound fields in items changed expectedBoardRev
    dispatch.planHash = computePlanHash({
      boardId: dispatch.boardId,
      planId: dispatch.planId,
      planVersion: dispatch.planVersion,
      canonicalSnapshotId: dispatch.canonicalSnapshotId,
      canonicalHash: dispatch.canonicalHash,
      items: dispatch.items,
    })
  }

  // 4) publish_dispatch_plan — ROOT only
  const publishRaw = await mcpToolsCall(baseUrl, 'publish_dispatch_plan', dispatch, {
    ...rootMcpOpts,
    id: 91001,
  })
  receipt.steps.publishDispatch = sanitizeMcpCallResult(publishRaw, secrets)
  if (!toolJsonOk(publishRaw)) {
    const detail =
      publishRaw.toolJson?.message ||
      publishRaw.toolJson?.code ||
      publishRaw.parsed?.error?.message ||
      `http ${publishRaw.httpStatus}`
    return fail('publish_dispatch_plan', 'PUBLISH_FAIL', detail)
  }

  const publishedBoardRev = Number(publishRaw.toolJson?.boardRev)
  const postPublishRev =
    Number.isFinite(publishedBoardRev) && publishedBoardRev >= 0
      ? publishedBoardRev
      : dispatch.expectedBoardRev

  // 5) get_next — ROOT (board:read; least-privilege would allow agent, prefer root for dispatch path)
  const getNextRaw = await mcpToolsCall(
    baseUrl,
    'get_next',
    { boardId },
    { ...rootMcpOpts, id: 91002 },
  )
  receipt.steps.getNext = sanitizeMcpCallResult(getNextRaw, secrets)
  const nextItems =
    getNextRaw.toolJson?.selectedForNextDispatch ?? getNextRaw.toolJson?.next ?? null
  const nextArr = Array.isArray(nextItems) ? nextItems : nextItems ? [nextItems] : []
  const expectedTaskId = dispatch.items?.[0]?.taskId
  const match = nextArr.find(
    (it) => it && (it.taskId === expectedTaskId || it.id === expectedTaskId),
  )
  receipt.steps.planReadback = redactSecretsDeep(
    {
      ok: Boolean(match),
      expectedTaskId,
      foundTaskId: match?.taskId ?? match?.id ?? null,
      planId: getNextRaw.toolJson?.planId ?? null,
      soleSource: getNextRaw.toolJson?.soleSource ?? null,
      itemCount: nextArr.length,
    },
    secrets,
  )
  if (!receipt.steps.planReadback.ok) {
    return fail(
      'get_next',
      'GET_NEXT_READBACK_FAIL',
      `expected task ${expectedTaskId} in selectedForNextDispatch`,
    )
  }

  // 6) sync_accounts — ROOT only
  const syncArgs = buildAccountSyncArgs({
    pin,
    ids,
    now,
    expectedBoardRev: postPublishRev,
    sourceRevision: pin.boardRev,
  })
  const syncRaw = await mcpToolsCall(baseUrl, 'sync_accounts', syncArgs, {
    ...rootMcpOpts,
    id: 91003,
  })
  receipt.steps.syncAccounts = sanitizeMcpCallResult(syncRaw, secrets)
  if (!toolJsonOk(syncRaw)) {
    const detail =
      syncRaw.toolJson?.message ||
      syncRaw.toolJson?.code ||
      syncRaw.parsed?.error?.message ||
      `http ${syncRaw.httpStatus}`
    return fail('sync_accounts', 'SYNC_FAIL', detail)
  }

  // 7) register_run — AGENT principal (ownRun matches ids.agentId / STAGING_AGENT_ID)
  const regArgs = buildRegisterRunArgs({
    pin,
    ids,
    dispatch,
    expectedBoardRev: postPublishRev,
  })
  const regRaw = await mcpToolsCall(baseUrl, 'register_run', regArgs, {
    ...agentOpsOpts,
    id: 91004,
  })
  receipt.steps.registerRun = sanitizeMcpCallResult(regRaw, secrets)
  // extend sanitize: capture fencingToken meta without dumping full body secrets
  const fencingToken =
    regRaw.toolJson?.fencingToken ?? regRaw.toolJson?.run?.fencingToken ?? null
  const regEntityRev =
    regRaw.toolJson?.entityRev ?? regRaw.toolJson?.run?.entityRev ?? 1
  // Avoid key names matching redactSecretsDeep /token/ (would redact booleans).
  receipt.steps.registerRunMeta = redactSecretsDeep(
    {
      ok: toolJsonOk(regRaw),
      runId: regArgs.runId,
      agentId: regArgs.agentId,
      principal: dualPrincipal ? 'AGENT' : 'SINGLE',
      hasFence: Boolean(fencingToken),
      entityRev: regEntityRev,
      boardRev: regRaw.toolJson?.boardRev ?? postPublishRev,
    },
    secrets,
  )
  if (!toolJsonOk(regRaw)) {
    const detail =
      regRaw.toolJson?.message ||
      regRaw.toolJson?.code ||
      regRaw.parsed?.error?.message ||
      `http ${regRaw.httpStatus}`
    return fail('register_run', 'REGISTER_FAIL', detail)
  }

  // 8) heartbeat_run — AGENT principal
  if (!fencingToken && opts.requireFencing !== false) {
    receipt.cleanup.reconcile = 'RECONCILE_RUN_NO_FENCE'
    return fail('heartbeat_run', 'MISSING_FENCING_TOKEN', 'register_run returned no fencingToken')
  }
  const hbArgs = {
    boardId,
    runId: regArgs.runId,
    agentId: regArgs.agentId,
    fencingToken: fencingToken || 'fence-contract-placeholder',
    heartbeatSequence: 1,
    expectedEntityRev: Number(regEntityRev) || 1,
    expectedBoardRev: postPublishRev,
    materialProgressAt: now,
  }
  const hbRaw = await mcpToolsCall(baseUrl, 'heartbeat_run', hbArgs, {
    ...agentOpsOpts,
    id: 91005,
  })
  receipt.steps.heartbeatRun = sanitizeMcpCallResult(hbRaw, secrets)
  if (!toolJsonOk(hbRaw)) {
    receipt.cleanup.reconcile = 'HEARTBEAT_DENIED_AFTER_REGISTER'
    const detail =
      hbRaw.toolJson?.message ||
      hbRaw.toolJson?.code ||
      hbRaw.parsed?.error?.message ||
      `http ${hbRaw.httpStatus}`
    return fail('heartbeat_run', 'HEARTBEAT_FAIL', detail)
  }

  // 9) readback — least-privilege: agent for task/board reads; ROOT for list_audit (audit:read)
  const readback = {}
  const readbackPlan = [
    ['list_tasks', { boardId }, 92001, 'agent'],
    ['get_rollup', { boardId }, 92002, 'agent'],
    ['list_audit', { boardId, limit: 20 }, 92003, 'root'],
    ['get_task_lifecycle', { boardId, id: regArgs.taskId }, 92004, 'agent'],
  ]
  for (const [tool, args, id, role] of readbackPlan) {
    const callOpts = role === 'root' || !dualPrincipal ? rootMcpOpts : agentOpsOpts
    const raw = await mcpToolsCall(baseUrl, tool, args, { ...callOpts, id })
    const san = sanitizeMcpCallResult(raw, secrets)
    const ok =
      raw.ok &&
      !raw.parsed?.error &&
      san.toolJson?.error == null &&
      (raw.httpStatus === 200 || raw.httpStatus === 0 || raw.ok)
    readback[tool] = {
      ok: Boolean(ok || (raw.ok && raw.toolJson != null)),
      httpStatus: raw.httpStatus,
      code: san.code,
      hasToolJson: Boolean(raw.toolJson),
      principal: dualPrincipal ? (role === 'root' ? 'ROOT' : 'AGENT') : 'SINGLE',
    }
  }
  receipt.steps.readback = readback
  const readbackFail = Object.entries(readback).filter(([, v]) => !v.ok)
  if (readbackFail.length) {
    return fail(
      'readback',
      'READBACK_FAIL',
      readbackFail.map(([k]) => k).join(','),
    )
  }

  // Optional cleanup: set_run_status done via AGENT when dual (ownRun); else single bearer
  if (opts.attemptRunDone !== false) {
    try {
      const doneRaw = await mcpToolsCall(
        baseUrl,
        'set_run_status',
        { boardId, id: regArgs.runId, status: 'done' },
        { ...agentOpsOpts, id: 93001 },
      )
      receipt.steps.setRunStatus = sanitizeMcpCallResult(doneRaw, secrets)
      if (!toolJsonOk(doneRaw) && !isMcpToolProgrammaticOk(doneRaw)) {
        // alternate arg shape
        const done2 = await mcpToolsCall(
          baseUrl,
          'set_run_status',
          { boardId, runId: regArgs.runId, status: 'done' },
          { ...agentOpsOpts, id: 93002 },
        )
        receipt.steps.setRunStatus = sanitizeMcpCallResult(done2, secrets)
        if (!toolJsonOk(done2)) {
          receipt.cleanup.reconcile = 'RECONCILE_RUN_STATUS_NOT_SET'
          receipt.residuals.push({
            step: 'set_run_status',
            code: 'CLEANUP_BEST_EFFORT',
            detail: 'run left for operator reconcile; synthetic id only',
          })
        }
      }
    } catch (e) {
      receipt.cleanup.reconcile = 'RECONCILE_RUN_STATUS_ERROR'
      receipt.residuals.push({
        step: 'set_run_status',
        code: 'CLEANUP_BEST_EFFORT',
        detail: String(e?.message || e),
      })
    }
  }

  receipt.ok =
    receipt.residuals.filter((r) => r.code !== 'CLEANUP_BEST_EFFORT' && r.code !== 'PIN_UNOBSERVED')
      .length === 0
  return redactSecretsDeep(receipt, secrets)
}

/**
 * Mock fetch implementing full MCP lifecycle for --self-test / contract mode.
 * Dual-principal: pass rootBearer + agentBearer to split tools/list per role (RBAC-faithful).
 */
export function createStagingSmokeMockFetch(opts = {}) {
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids
  const now = opts.now ?? '2026-07-13T00:00:00.000Z'
  const calls = []
  const expectedSha = opts.expectedSha ?? 'a'.repeat(40)
  const fencingToken = opts.fencingToken ?? `fence-mock-${crypto.randomBytes(4).toString('hex')}`
  const dualRootBearer = opts.rootBearer ?? null
  const dualAgentBearer = opts.agentBearer ?? null
  const dualMock = Boolean(dualRootBearer && dualAgentBearer)
  let boardRev = pin.boardRev
  // Derive NEXT task id from canonical dispatch-plan fixture (not a stale hardcode).
  const nextTaskId =
    opts.nextTaskId ??
    loadDispatchPlanSeed()?.items?.[0]?.taskId ??
    'task-next-1'

  const jsonRes = (body, status = 200) => ({
    ok: status >= 200 && status < 300,
    status,
    text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
  })

  const toolText = (id, obj) =>
    jsonRes({
      jsonrpc: '2.0',
      id,
      result: { content: [{ type: 'text', text: JSON.stringify(obj) }] },
    })

  const extractBearer = (authHeader) => {
    const m = String(authHeader || '').match(/^Bearer\s+(\S+)/i)
    return m ? m[1] : null
  }

  /** Role for dual mock: which principal presented the bearer. */
  const resolveMockRole = (authHeader) => {
    if (!dualMock) return 'single'
    const tok = extractBearer(authHeader)
    if (tok && tok === dualAgentBearer) return 'agent'
    if (tok && tok === dualRootBearer) return 'root'
    return 'unknown'
  }

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method || 'GET').toUpperCase()
    const auth = init.headers?.authorization || init.headers?.Authorization || ''
    const hasAuth = /^Bearer\s+\S+/i.test(auth)
    const mockRole = resolveMockRole(auth)

    if (u.includes('/api/healthz')) {
      if (!hasAuth) {
        return jsonRes({ error: 'authentication required', code: 'AUTHORIZATION_REQUIRED' }, 401)
      }
      return jsonRes({
        schemaVersion: 'MFS_HEALTHZ_V1',
        status: 'ok',
        service: 'cairn-task-manager',
        deployedSha: expectedSha,
        schema: { version: '003', match: true },
        release: { sha: expectedSha, match: true },
        migration: {
          status: 'READY',
          appliedVersions: ['000', '001', '002', '003'],
          expectedLatestVersion: '003',
          schemaVersion: '003',
        },
        canonicalSnapshotId: pin.canonicalSnapshotId,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        dependencies: [{ name: 'mysql', status: 'up' }],
        unhealthyReasons: [],
        checkedAt: now,
      })
    }

    if (!u.includes('/mcp')) {
      return jsonRes({ error: 'not found' }, 404)
    }

    const body = init.body ? JSON.parse(init.body) : {}
    calls.push({
      method: body.method,
      name: body.params?.name ?? null,
      hasAuth,
      mockRole,
    })

    if (body.method === 'initialize') {
      return jsonRes({
        jsonrpc: '2.0',
        id: body.id,
        result: {
          protocolVersion: '2025-06-18',
          serverInfo: { name: 'cairn-board', mockRole },
        },
      })
    }
    if (body.method === 'notifications/initialized') {
      return jsonRes('')
    }
    if (body.method === 'tools/list') {
      if (!hasAuth && opts.requireAuthForList) {
        return jsonRes(
          {
            jsonrpc: '2.0',
            id: body.id,
            error: { code: -32001, message: 'AUTHORIZATION_REQUIRED' },
          },
          401,
        )
      }
      // Dual mock: RBAC-faithful split (ROOT no register/heartbeat; AGENT no publish/sync/audit)
      let names
      if (dualMock && mockRole === 'root') {
        names = [...ROOT_REQUIRED_MCP_TOOLS, 'set_run_status', 'list_runs', 'upsert_run']
      } else if (dualMock && mockRole === 'agent') {
        names = [...AGENT_REQUIRED_MCP_TOOLS, 'set_run_status', 'list_runs', 'get_next']
      } else {
        names = loadStagingManifest().requiredMcpTools.filter((t) => t !== 'tools/list')
        names = [...new Set([...names, 'set_run_status', 'list_runs'])]
      }
      const tools = [...new Set(names)].map((name) => ({ name }))
      return jsonRes({ jsonrpc: '2.0', id: body.id, result: { tools } })
    }

    if (body.method === 'tools/call') {
      const name = body.params?.name
      const args = body.params?.arguments ?? {}

      // Sensitive writes without auth → deny
      const sensitive = loadStagingManifest().sensitiveWriteTools
      if (sensitive.includes(name) && !hasAuth) {
        return jsonRes(
          {
            jsonrpc: '2.0',
            id: body.id,
            error: {
              code: -32001,
              message: 'AUTHORIZATION_REQUIRED',
              data: { code: 'AUTHORIZATION_REQUIRED' },
            },
          },
          401,
        )
      }

      // Dual mock RBAC: deny role-wrong tool calls (mirrors real listability/auth)
      if (dualMock) {
        const rootOnly = ['publish_dispatch_plan', 'sync_accounts', 'list_audit']
        const agentOnly = ['register_run', 'heartbeat_run']
        if (rootOnly.includes(name) && mockRole !== 'root') {
          return toolText(body.id, {
            ok: false,
            code: 'FORBIDDEN_ROLE',
            message: `${name} requires ROOT principal`,
          })
        }
        if (agentOnly.includes(name) && mockRole !== 'agent') {
          return toolText(body.id, {
            ok: false,
            code: 'AUTHORIZATION_REQUIRED',
            message: `${name} requires AGENT principal (run:write)`,
          })
        }
        if (
          agentOnly.includes(name) &&
          mockRole === 'agent' &&
          ids?.agentId &&
          args.agentId &&
          args.agentId !== ids.agentId
        ) {
          return toolText(body.id, {
            ok: false,
            code: 'OWN_RUN_ONLY',
            message: 'AGENT own assigned run only',
          })
        }
      }

      if (name === 'publish_dispatch_plan') {
        if (Number(args.expectedBoardRev) !== Number(pin.boardRev)) {
          return toolText(body.id, {
            ok: false,
            code: 'STALE_REVISION',
            message: 'board rev mismatch',
          })
        }
        if (args.planHash && args.canonicalHash !== pin.canonicalHash) {
          return toolText(body.id, {
            ok: false,
            code: 'HASH_MISMATCH',
            message: 'canonicalHash mismatch',
          })
        }
        boardRev = pin.boardRev + 1
        return toolText(body.id, {
          ok: true,
          planId: args.planId,
          planVersion: args.planVersion,
          boardRev,
        })
      }
      if (name === 'get_next') {
        return toolText(body.id, {
          planId: ids?.planId ?? args.planId,
          soleSource: 'active_dispatch_plan',
          selectedForNextDispatch: [
            {
              taskId: nextTaskId,
              rank: 1,
              selectionReason: 'SYNTH staging mock',
            },
          ],
        })
      }
      if (name === 'sync_accounts') {
        if (Number(args.expectedBoardRev) !== boardRev) {
          return toolText(body.id, {
            ok: false,
            code: 'STALE_REVISION',
            message: 'board rev mismatch',
          })
        }
        return toolText(body.id, {
          ok: true,
          sourceRevision: args.sourceRevision,
          generatedAt: args.generatedAt,
          acceptedCount: (args.accounts ?? []).length,
          usableCapacity: 3,
          dispatchMode: 'NORMAL',
          stale: false,
        })
      }
      if (name === 'register_run') {
        return toolText(body.id, {
          ok: true,
          runId: args.runId,
          agentId: args.agentId,
          state: 'RUNNING',
          fencingToken,
          entityRev: 1,
          boardRev,
        })
      }
      if (name === 'heartbeat_run') {
        if (args.fencingToken !== fencingToken) {
          return toolText(body.id, {
            ok: false,
            code: 'FENCING_MISMATCH',
            message: 'fencing token mismatch',
          })
        }
        return toolText(body.id, {
          ok: true,
          runId: args.runId,
          heartbeatSequence: args.heartbeatSequence,
          entityRev: 2,
        })
      }
      if (name === 'list_tasks') {
        return toolText(body.id, {
          ok: true,
          tasks: [{ id: nextTaskId, lifecycleStage: 'SPEC_READY' }],
        })
      }
      if (name === 'get_rollup') {
        return toolText(body.id, {
          formulaVersion: 1,
          readinessPercent: 10,
          counts: { active: 1 },
        })
      }
      if (name === 'list_audit') {
        return toolText(body.id, {
          ok: true,
          entries: [{ kind: 'RUN_REGISTERED', subjectId: ids?.runId }],
        })
      }
      if (name === 'get_task_lifecycle') {
        return toolText(body.id, {
          id: args.id,
          stage: 'SPEC_READY',
          rev: 0,
        })
      }
      if (name === 'set_run_status') {
        return toolText(body.id, { ok: true, status: 'done' })
      }
      return toolText(body.id, { ok: false, code: 'UNKNOWN_TOOL', message: name })
    }

    return jsonRes({ error: 'unexpected' }, 500)
  }

  return { fetchImpl, calls, getBoardRev: () => boardRev, fencingToken }
}

/**
 * Full self-test: fixture contract + mocked lifecycle + fail-closed cases.
 */
export async function runStagingAgentSmokeSelfTests() {
  const results = []
  const ok = (name, pass, detail = null) => results.push({ name, pass, detail })

  // Fixture layer
  const fixture = runFixtureContractSelfTests()
  ok('fixture-contract', fixture.ok, fixture.failCount ? `${fixture.failCount} fails` : null)
  for (const r of fixture.results) {
    ok(`fixture:${r.name}`, r.pass, r.detail)
  }

  const pin = loadStagingPin()
  const ids = buildSyntheticSmokeIds({ smokeRunId: 'selftest01', boardId: 'mfs-rebuild' })
  const expectedSha = 'b'.repeat(40)
  const root = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
  const secrets = [root.bearer]

  // Token ref resolution
  const missingTok = resolveAuthorizedTokenRef({})
  ok('token-ref-missing', missingTok.ok === false && missingTok.meta.present === false)
  const presentTok = resolveAuthorizedTokenRef({ STAGING_BEARER_TOKEN: 'x'.repeat(40) })
  ok(
    'token-ref-present-meta-only',
    presentTok.ok &&
      presentTok.tokenRef === 'STAGING_BEARER_TOKEN' &&
      presentTok.meta.present === true &&
      !JSON.stringify(presentTok.meta).includes('x'.repeat(40)),
  )
  // destroy local
  presentTok.bearer = ''

  // Happy mock lifecycle
  const { fetchImpl, calls, fencingToken } = createStagingSmokeMockFetch({
    pin,
    ids,
    expectedSha,
  })
  let happy
  try {
    happy = await runStagingAgentLifecycleSmoke({
      baseUrl: 'http://127.0.0.1:9',
      mode: 'self-test',
      boardId: 'mfs-rebuild',
      pin,
      ids,
      bearer: root.bearer,
      tokenRef: 'SYNTH_ROOT_SELF_TEST',
      principalMeta: root.principalMeta,
      expectedSha,
      expectedSchema: '003',
      fetchImpl,
      runtimePin: {
        ok: true,
        httpStatus: 200,
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        taskHash: pin.taskHash,
      },
      skipPinCheck: false,
      now: '2026-07-13T00:00:00.000Z',
      failClosed: true,
    })
    ok('happy-lifecycle-ok', happy.ok === true)
    ok('happy-bearer-redacted', !JSON.stringify(happy).includes(root.bearer))
    ok(
      'happy-steps-order',
      calls.some((c) => c.name === 'publish_dispatch_plan') &&
        calls.some((c) => c.name === 'get_next') &&
        calls.some((c) => c.name === 'sync_accounts') &&
        calls.some((c) => c.name === 'register_run') &&
        calls.some((c) => c.name === 'heartbeat_run'),
    )
    ok(
      'happy-readback',
      happy.steps?.readback?.list_tasks?.ok && happy.steps?.readback?.get_rollup?.ok,
    )
    ok(
      'happy-unique-ids',
      happy.smokeRunId === 'selftest01' && String(happy.ids?.runId).includes('selftest01'),
    )
    ok('happy-register-fence-meta', happy.steps?.registerRunMeta?.hasFence === true)
    void fencingToken
  } catch (e) {
    ok('happy-lifecycle-ok', false, String(e?.message || e))
  }

  // Pin mismatch fail-closed before publish
  {
    const { fetchImpl: f2, calls: c2 } = createStagingSmokeMockFetch({ pin, ids, expectedSha })
    let threw = false
    try {
      await runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        pin,
        ids,
        bearer: root.bearer,
        expectedSha,
        fetchImpl: f2,
        runtimePin: {
          ok: true,
          httpStatus: 200,
          canonicalSnapshotId: 'wrong-snap',
          boardRev: 99,
          lifecycleRev: 1,
        },
        failClosed: true,
        initialize: false,
      })
    } catch (e) {
      threw =
        e instanceof StagingAgentSmokeError &&
        (e.code === 'PIN_PARITY_MISMATCH' || /pin/i.test(e.message))
    }
    ok('pin-mismatch-fail-close', threw)
    // unauth sensitive probe may call publish_dispatch_plan without auth; authorized publish must not run
    ok(
      'pin-mismatch-no-auth-publish',
      threw && !c2.some((c) => c.name === 'publish_dispatch_plan' && c.hasAuth),
    )
  }

  // SHA mismatch fail-closed
  {
    const { fetchImpl: f3 } = createStagingSmokeMockFetch({
      pin,
      ids,
      expectedSha: 'c'.repeat(40),
    })
    let shaThrew = false
    try {
      await runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        pin,
        ids,
        bearer: root.bearer,
        expectedSha: 'd'.repeat(40),
        fetchImpl: f3,
        skipPinCheck: true,
        failClosed: true,
        initialize: false,
      })
    } catch (e) {
      shaThrew =
        e instanceof StagingAgentSmokeError &&
        (e.code === 'RELEASE_SHA_MISMATCH' || /RELEASE_SHA|healthz_sha/i.test(e.message))
    }
    ok('sha-mismatch-fail-close', shaThrew)
  }

  // Unauth sensitive denied (mock)
  {
    const { fetchImpl: f4 } = createStagingSmokeMockFetch({ pin, ids, expectedSha })
    const deny = await probeUnauthSensitiveDenial('http://127.0.0.1:9', {
      fetchImpl: f4,
      boardId: 'mfs-rebuild',
    })
    ok('unauth-sensitive-denied', deny.ok === true)
  }

  // Missing ROOT bearer fail-close
  {
    let missing = false
    try {
      await runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        bearer: null,
        requireBearer: true,
        failClosed: true,
        skipPinCheck: true,
        initialize: false,
        fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
      })
    } catch (e) {
      missing =
        e instanceof StagingAgentSmokeError &&
        (e.code === 'MISSING_BEARER' ||
          e.code === 'MISSING_ROOT_BEARER' ||
          /bearer/i.test(e.message))
    }
    ok('missing-bearer-fail-close', missing)
  }

  // Dual-principal token resolution contract
  {
    const secretRoot = `root-sec-${'r'.repeat(24)}`
    const secretAgent = `agent-sec-${'a'.repeat(24)}`
    const preferRoot = resolveRootTokenRef({
      STAGING_ROOT_BEARER_TOKEN: secretRoot,
      STAGING_BEARER_TOKEN: 'legacy-should-not-win',
    })
    ok(
      'root-token-prefers-STAGING_ROOT_BEARER_TOKEN',
      preferRoot.ok &&
        preferRoot.tokenRef === 'STAGING_ROOT_BEARER_TOKEN' &&
        !JSON.stringify(preferRoot.meta).includes(secretRoot),
    )
    preferRoot.bearer = ''

    const legacyRoot = resolveRootTokenRef({ STAGING_BEARER_TOKEN: secretRoot })
    ok(
      'root-token-legacy-fallback-STAGING_BEARER_TOKEN',
      legacyRoot.ok && legacyRoot.tokenRef === 'STAGING_BEARER_TOKEN',
    )
    legacyRoot.bearer = ''

    const missingAgent = resolveDualPrincipalTokens(
      { STAGING_ROOT_BEARER_TOKEN: secretRoot },
      { requireAgent: true, requireAgentId: true },
    )
    ok(
      'dual-missing-agent-fail-closed',
      missingAgent.ok === false && missingAgent.code === 'MISSING_AGENT_BEARER',
    )

    const missingAgentId = resolveDualPrincipalTokens(
      {
        STAGING_ROOT_BEARER_TOKEN: secretRoot,
        STAGING_AGENT_BEARER_TOKEN: secretAgent,
      },
      { requireAgent: true, requireAgentId: true },
    )
    ok(
      'dual-missing-agent-id-fail-closed',
      missingAgentId.ok === false && missingAgentId.code === 'MISSING_AGENT_ID',
    )

    const dualOk = resolveDualPrincipalTokens(
      {
        STAGING_ROOT_BEARER_TOKEN: secretRoot,
        STAGING_AGENT_BEARER_TOKEN: secretAgent,
        STAGING_AGENT_ID: 'agent-principal-1',
      },
      { requireAgent: true, requireAgentId: true },
    )
    ok(
      'dual-resolve-ok-meta-no-secrets',
      dualOk.ok === true &&
        dualOk.root.tokenRef === 'STAGING_ROOT_BEARER_TOKEN' &&
        dualOk.agent.tokenRef === 'STAGING_AGENT_BEARER_TOKEN' &&
        dualOk.agentId === 'agent-principal-1' &&
        !JSON.stringify(dualOk.meta).includes(secretRoot) &&
        !JSON.stringify(dualOk.meta).includes(secretAgent),
    )
    if (dualOk.root) dualOk.root.bearer = ''
    if (dualOk.agent) dualOk.agent.bearer = ''
  }

  // Dual-principal happy mock lifecycle (ROOT tools ≠ AGENT tools; ops use correct token)
  {
    const dualIds = buildSyntheticSmokeIds({
      smokeRunId: 'dualtest01',
      boardId: 'mfs-rebuild',
    })
    const agent = createSyntheticAgentPrincipal({
      boardId: 'mfs-rebuild',
      agentId: dualIds.agentId,
    })
    const dualSecrets = [root.bearer, agent.bearer]
    const {
      fetchImpl: dualFetch,
      calls: dualCalls,
    } = createStagingSmokeMockFetch({
      pin,
      ids: dualIds,
      expectedSha,
      rootBearer: root.bearer,
      agentBearer: agent.bearer,
    })
    let dualHappy
    try {
      dualHappy = await runStagingAgentLifecycleSmoke({
        baseUrl: 'http://127.0.0.1:9',
        mode: 'self-test',
        boardId: 'mfs-rebuild',
        pin,
        ids: dualIds,
        rootBearer: root.bearer,
        agentBearer: agent.bearer,
        dualPrincipal: true,
        rootTokenRef: 'SYNTH_ROOT_SELF_TEST',
        agentTokenRef: 'SYNTH_AGENT_SELF_TEST',
        expectedSha,
        expectedSchema: '003',
        fetchImpl: dualFetch,
        runtimePin: {
          ok: true,
          httpStatus: 200,
          canonicalSnapshotId: pin.canonicalSnapshotId,
          canonicalHash: pin.canonicalHash,
          boardRev: pin.boardRev,
          lifecycleRev: pin.lifecycleRev,
          taskHash: pin.taskHash,
        },
        skipPinCheck: false,
        now: '2026-07-13T00:00:00.000Z',
        failClosed: true,
        requireAgentBearer: true,
      })
      ok('dual-happy-lifecycle-ok', dualHappy.ok === true && dualHappy.dualPrincipal === true)
      ok(
        'dual-happy-no-secret-leak',
        !JSON.stringify(dualHappy).includes(root.bearer) &&
          !JSON.stringify(dualHappy).includes(agent.bearer),
      )
      ok(
        'dual-root-tools-gate',
        dualHappy.steps?.toolsListRoot?.ok === true &&
          (dualHappy.steps?.toolsListRoot?.missing ?? []).length === 0 &&
          ['publish_dispatch_plan', 'get_next', 'sync_accounts'].every(
            (t) => ROOT_REQUIRED_MCP_TOOLS.includes(t),
          ),
      )
      ok(
        'dual-agent-tools-gate',
        dualHappy.steps?.toolsListAgent?.ok === true &&
          (dualHappy.steps?.toolsListAgent?.missing ?? []).length === 0 &&
          ['register_run', 'heartbeat_run'].every((t) =>
            AGENT_REQUIRED_MCP_TOOLS.includes(t),
          ),
      )
      // Ops token roles from mock call log (authorized calls only; unauth probes share tool names)
      const roleFor = (name) =>
        dualCalls.find((c) => c.name === name && c.hasAuth)?.mockRole
      ok(
        'dual-ops-correct-token',
        roleFor('publish_dispatch_plan') === 'root' &&
          roleFor('get_next') === 'root' &&
          roleFor('sync_accounts') === 'root' &&
          roleFor('register_run') === 'agent' &&
          roleFor('heartbeat_run') === 'agent',
      )
      ok(
        'dual-register-own-agentId',
        dualHappy.steps?.registerRunMeta?.agentId === dualIds.agentId &&
          dualHappy.steps?.registerRunMeta?.principal === 'AGENT',
      )
    } catch (e) {
      ok('dual-happy-lifecycle-ok', false, String(e?.message || e))
    }
    // Real-mode without agent bearer must fail closed
    {
      let agentMissing = false
      try {
        await runStagingAgentLifecycleSmoke({
          baseUrl: 'http://127.0.0.1:9',
          mode: 'real',
          bearer: root.bearer,
          agentBearer: null,
          requireBearer: true,
          failClosed: true,
          skipPinCheck: true,
          initialize: false,
          fetchImpl: async () => ({ ok: false, status: 500, text: async () => '' }),
        })
      } catch (e) {
        agentMissing =
          e instanceof StagingAgentSmokeError &&
          (e.code === 'MISSING_AGENT_BEARER' || /STAGING_AGENT_BEARER/i.test(e.message))
      }
      ok('real-mode-missing-agent-fail-closed', agentMissing)
    }
    agent.bearer = ''
    dualSecrets.length = 0
  }

  // Redaction of secrets in sanitize path
  {
    const dirty = sanitizeMcpCallResult(
      {
        httpStatus: 200,
        ok: true,
        toolJson: { ok: true, planId: 'p1' },
        parsed: null,
        raw: `Bearer ${root.bearer}`,
      },
      secrets,
    )
    ok('sanitize-no-bearer', !JSON.stringify(dirty).includes(root.bearer))
  }

  // Reuse control-plane root principal meta safety
  ok(
    'root-meta-no-secret',
    !JSON.stringify(root.principalMeta).includes(root.bearer),
  )

  // wipe secrets from local scope intent
  root.bearer = ''
  secrets.length = 0

  const failCount = results.filter((r) => !r.pass).length
  return {
    results,
    failCount,
    ok: failCount === 0,
    fixtureOk: fixture.ok,
  }
}

/**
 * Real remote staging entry (SSH tunnel). Dual-principal fail-closed.
 * Requires STAGING_ROOT_BEARER_TOKEN (or legacy STAGING_BEARER_TOKEN) + STAGING_AGENT_BEARER_TOKEN + STAGING_AGENT_ID.
 */
export async function runRealStagingAgentSmoke(opts = {}) {
  const env = opts.env ?? process.env
  const baseUrl = (opts.baseUrl ?? resolveStagingUrl()).replace(/\/$/, '')
  const boardId = opts.boardId ?? resolveSmokeBoardId(env)

  const dual = resolveDualPrincipalTokens(env, {
    requireAgent: opts.requireAgent !== false,
    requireAgentId: opts.requireAgentId !== false,
  })
  if (!dual.ok) {
    throw new StagingAgentSmokeError(dual.reason || 'dual principal resolution failed', {
      code: dual.code || 'MISSING_BEARER',
      tokenRef: dual.root?.tokenRef ?? null,
      agentTokenRef: dual.agent?.tokenRef ?? null,
      meta: dual.meta,
    })
  }

  const expectedSha = opts.expectedSha ?? resolveExpectedSha(env, { require: false })
  const expectedSchema = opts.expectedSchema ?? resolveExpectedSchema(env)
  const pin = opts.pin ?? loadStagingPin()
  const baseIds = opts.ids ?? buildSyntheticSmokeIds({ boardId })
  // ownRun: register_run.agentId must match AGENT principal agentId/actorId
  const ids = {
    ...baseIds,
    agentId: dual.agentId || baseIds.agentId,
  }

  const ownerTarget = {
    base_url: baseUrl,
    port: (() => {
      try {
        return new URL(baseUrl).port || (baseUrl.startsWith('https') ? '443' : '80')
      } catch {
        return null
      }
    })(),
    account: `rootTokenRef=${dual.root.tokenRef};agentTokenRef=${dual.agent.tokenRef};agentId=${dual.agentId}`,
    device: 'n/a-mcp-http',
    boardId,
    expectedSha: expectedSha ?? 'UNSET',
    dualPrincipal: true,
  }

  const secrets = []
  if (dual.root?.bearer) secrets.push(dual.root.bearer)
  if (dual.agent?.bearer) secrets.push(dual.agent.bearer)

  try {
    const receipt = await runStagingAgentLifecycleSmoke({
      baseUrl,
      mode: 'real',
      boardId,
      pin,
      ids,
      rootBearer: dual.root.bearer,
      agentBearer: dual.agent.bearer,
      dualPrincipal: true,
      rootTokenRef: dual.root.tokenRef,
      agentTokenRef: dual.agent.tokenRef,
      tokenRef: dual.root.tokenRef,
      principalMeta: dual.meta,
      expectedSha,
      expectedSchema,
      requireAgentBearer: true,
      requireUnauthHealthDenial: true,
      // Real staging may not expose full pin on healthz — allow weak only when env set
      allowWeakPin: env.STAGING_ALLOW_WEAK_PIN === '1',
      bindLiveBoardRev: env.STAGING_BIND_LIVE_BOARD_REV === '1',
      failClosed: true,
      initialize: true,
      attemptRunDone: true,
    })
    return {
      ok: receipt.ok,
      ownerTarget,
      tokenMeta: dual.meta,
      receipt: redactSecretsDeep(receipt, secrets),
    }
  } finally {
    // scrub local bearer references (never leave secrets in returned dual handles)
    try {
      if (dual.root) dual.root.bearer = ''
    } catch {
      /* ignore */
    }
    try {
      if (dual.agent) dual.agent.bearer = ''
    } catch {
      /* ignore */
    }
  }
}

export {
  loadStagingManifest,
  loadStagingPin,
  validateStagingFixtureContract,
  buildSyntheticSmokeIds,
  buildDispatchPlanArgs,
  buildAccountSyncArgs,
  buildRegisterRunArgs,
  runFixtureContractSelfTests,
}
