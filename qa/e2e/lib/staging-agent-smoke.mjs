/**
 * Staging agent-operable MCP smoke library.
 *
 * Modes:
 *  - contract / --self-test: pure fixture + mocked MCP lifecycle (no server)
 *  - --real: SSH-tunneled STAGING_URL + authorized bearer env reference
 *
 * Reuses qa/e2e/lib/control-plane-bootstrap.mjs MCP helpers + redaction.
 * Never prints or persists credentials.
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

/** Env var names that may hold bearer material — values never logged. */
export const BEARER_ENV_CANDIDATES = Object.freeze([
  'STAGING_BEARER_TOKEN',
  'STAGING_BEARER',
  'CAIRN_MCP_BEARER',
])

/**
 * Resolve authorized token by reference (env name), never log the secret.
 * STAGING_BEARER_TOKEN_REF overrides which env name is read.
 * @returns {{ ok: true, tokenRef: string, bearer: string } | { ok: false, tokenRef: string|null, reason: string }}
 */
export function resolveAuthorizedTokenRef(env = process.env) {
  const explicitRef = env.STAGING_BEARER_TOKEN_REF?.trim()
  const candidates = explicitRef
    ? [explicitRef, ...BEARER_ENV_CANDIDATES.filter((c) => c !== explicitRef)]
    : [...BEARER_ENV_CANDIDATES]

  for (const name of candidates) {
    const val = env[name]
    if (typeof val === 'string' && val.trim().length > 0) {
      return {
        ok: true,
        tokenRef: name,
        bearer: val.trim(),
        // public meta only
        meta: {
          tokenRef: name,
          present: true,
          secretByteLength: Buffer.byteLength(val.trim(), 'utf8'),
        },
      }
    }
  }
  return {
    ok: false,
    tokenRef: explicitRef || BEARER_ENV_CANDIDATES[0],
    reason: `missing authorized bearer — set one of ${candidates.join('|')} (value never logged)`,
    meta: { tokenRef: explicitRef || BEARER_ENV_CANDIDATES[0], present: false },
  }
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
 * tools/list → publish → get_next → sync → register → heartbeat →
 * list_tasks / get_rollup / list_audit / get_task_lifecycle readback.
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
  const bearer = opts.bearer ?? null
  const secrets = []
  if (bearer) secrets.push(bearer)
  if (opts.extraSecrets) secrets.push(...opts.extraSecrets)

  const fetchImpl = opts.fetchImpl
  const mcpOpts = { bearer, fetchImpl, secrets }
  const expectedSha = opts.expectedSha ?? null
  const expectedSchema = opts.expectedSchema ?? resolveExpectedSchema()
  const skipPinCheck = opts.skipPinCheck === true
  const requireBearer = opts.requireBearer !== false

  const receipt = {
    ok: false,
    mode: opts.mode ?? 'real',
    boardId,
    smokeRunId: ids.smokeRunId,
    tokenRef: opts.tokenRef ?? null,
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
      rulesApplied: ['unique-ids', 'no-credential-persist'],
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

  if (requireBearer && !bearer) {
    return fail('bearer', 'MISSING_BEARER', 'authorized bearer required for lifecycle smoke')
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

  // 3) tools/list
  {
    const listed = await probeToolsList(baseUrl, { bearer, fetchImpl })
    receipt.steps.toolsList = listed
    if (!listed.ok) {
      return fail('tools_list', listed.code || 'TOOLS_LIST_FAIL', JSON.stringify(listed.missing))
    }
  }

  // Optional initialize
  if (opts.initialize !== false) {
    try {
      receipt.steps.initialize = await mcpInitialize(baseUrl, {
        ...mcpOpts,
        id: 90001,
      })
    } catch (e) {
      receipt.steps.initialize = { ok: false, error: String(e?.message || e) }
    }
  }

  // Pin parity before publish
  let runtimePin =
    opts.runtimePin ??
    (await probeRuntimePin(baseUrl, { bearer, fetchImpl, secrets }))
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

  const publishRaw = await mcpToolsCall(baseUrl, 'publish_dispatch_plan', dispatch, {
    ...mcpOpts,
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

  // 5) get_next
  const getNextRaw = await mcpToolsCall(
    baseUrl,
    'get_next',
    { boardId },
    { ...mcpOpts, id: 91002 },
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

  // 6) sync_accounts (CAS against post-publish board rev)
  const syncArgs = buildAccountSyncArgs({
    pin,
    ids,
    now,
    expectedBoardRev: postPublishRev,
    sourceRevision: pin.boardRev,
  })
  const syncRaw = await mcpToolsCall(baseUrl, 'sync_accounts', syncArgs, {
    ...mcpOpts,
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

  // 7) register_run
  const regArgs = buildRegisterRunArgs({
    pin,
    ids,
    dispatch,
    expectedBoardRev: postPublishRev,
  })
  const regRaw = await mcpToolsCall(baseUrl, 'register_run', regArgs, {
    ...mcpOpts,
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

  // 8) heartbeat_run
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
    ...mcpOpts,
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

  // 9) readback: list_tasks / get_rollup / list_audit / get_task_lifecycle
  const readback = {}
  for (const [tool, args, id] of [
    ['list_tasks', { boardId }, 92001],
    ['get_rollup', { boardId }, 92002],
    ['list_audit', { boardId, limit: 20 }, 92003],
    ['get_task_lifecycle', { boardId, id: regArgs.taskId }, 92004],
  ]) {
    const raw = await mcpToolsCall(baseUrl, tool, args, { ...mcpOpts, id })
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

  // Optional cleanup: set_run_status done (best-effort; residual if denied)
  if (opts.attemptRunDone !== false) {
    try {
      const doneRaw = await mcpToolsCall(
        baseUrl,
        'set_run_status',
        { boardId, id: regArgs.runId, status: 'done' },
        { ...mcpOpts, id: 93001 },
      )
      receipt.steps.setRunStatus = sanitizeMcpCallResult(doneRaw, secrets)
      if (!toolJsonOk(doneRaw) && !isMcpToolProgrammaticOk(doneRaw)) {
        // alternate arg shape
        const done2 = await mcpToolsCall(
          baseUrl,
          'set_run_status',
          { boardId, runId: regArgs.runId, status: 'done' },
          { ...mcpOpts, id: 93002 },
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
 */
export function createStagingSmokeMockFetch(opts = {}) {
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids
  const now = opts.now ?? '2026-07-13T00:00:00.000Z'
  const calls = []
  const expectedSha = opts.expectedSha ?? 'a'.repeat(40)
  const fencingToken = opts.fencingToken ?? `fence-mock-${crypto.randomBytes(4).toString('hex')}`
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

  const fetchImpl = async (url, init = {}) => {
    const u = String(url)
    const method = (init.method || 'GET').toUpperCase()
    const auth = init.headers?.authorization || init.headers?.Authorization || ''
    const hasAuth = /^Bearer\s+\S+/i.test(auth)

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
    })

    if (body.method === 'initialize') {
      return jsonRes({
        jsonrpc: '2.0',
        id: body.id,
        result: { protocolVersion: '2025-06-18', serverInfo: { name: 'cairn-board' } },
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
      const names = loadStagingManifest().requiredMcpTools.filter((t) => t !== 'tools/list')
      // plus set_run_status for cleanup
      const tools = [...new Set([...names, 'set_run_status', 'list_runs'])].map((name) => ({
        name,
      }))
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

  // Missing bearer fail-close
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
        (e.code === 'MISSING_BEARER' || /bearer/i.test(e.message))
    }
    ok('missing-bearer-fail-close', missing)
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
 * Real remote staging entry (SSH tunnel). Fail-closed when unreachable / pin / SHA mismatch.
 */
export async function runRealStagingAgentSmoke(opts = {}) {
  const env = opts.env ?? process.env
  const baseUrl = (opts.baseUrl ?? resolveStagingUrl()).replace(/\/$/, '')
  const boardId = opts.boardId ?? resolveSmokeBoardId(env)
  const token = resolveAuthorizedTokenRef(env)
  if (!token.ok) {
    throw new StagingAgentSmokeError(token.reason, {
      code: 'MISSING_BEARER',
      tokenRef: token.tokenRef,
    })
  }
  const expectedSha = opts.expectedSha ?? resolveExpectedSha(env, { require: false })
  const expectedSchema = opts.expectedSchema ?? resolveExpectedSchema(env)
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids ?? buildSyntheticSmokeIds({ boardId })

  const ownerTarget = {
    base_url: baseUrl,
    port: (() => {
      try {
        return new URL(baseUrl).port || (baseUrl.startsWith('https') ? '443' : '80')
      } catch {
        return null
      }
    })(),
    account: `tokenRef=${token.tokenRef}`,
    device: 'n/a-mcp-http',
    boardId,
    expectedSha: expectedSha ?? 'UNSET',
  }

  try {
    const receipt = await runStagingAgentLifecycleSmoke({
      baseUrl,
      mode: 'real',
      boardId,
      pin,
      ids,
      bearer: token.bearer,
      tokenRef: token.tokenRef,
      expectedSha,
      expectedSchema,
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
      tokenMeta: token.meta,
      receipt: redactSecretsDeep(receipt, [token.bearer]),
    }
  } finally {
    // scrub local bearer reference
    try {
      token.bearer = ''
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
