/**
 * Authorized control-plane bootstrap for the deterministic harness (C3-R5H).
 *
 * - Per-run synthetic ROOT_ORCHESTRATOR bearer (Node crypto) — fixture-only.
 * - Inject CAIRN_BEARER_PRINCIPALS_JSON into the owned preview child env only.
 * - Real /mcp JSON-RPC tools/call with Authorization: Bearer (in-memory).
 * - Never persist/log bearer secrets; receipt objects are sanitized.
 * - Pin parity fail-closed before publish; bootstrap fail-closed on MCP errors.
 * - Does NOT use CAIRN_WRITE_TOKEN for elevation.
 */
import crypto from 'node:crypto'
import {
  buildAccountSyncSeed,
  buildDispatchPlanSeed,
  buildHarnessPin,
  DEFAULT_BOARD_ID,
} from '../fixtures/seed/control-center-fixture.mjs'

/** Stable error for harness fail-close (non-zero exit). */
export class ControlPlaneBootstrapError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ControlPlaneBootstrapError'
    this.detail = detail
    this.code = detail.code ?? 'CONTROL_PLANE_BOOTSTRAP_FAIL'
  }
}

/**
 * High-entropy per-run synthetic ROOT principal.
 * Secret exists only in returned object (memory). Never write to disk/logs.
 */
export function createSyntheticRootPrincipal(opts = {}) {
  const secret = crypto.randomBytes(32).toString('base64url')
  const actorId =
    opts.actorId ?? `synth-root-${crypto.randomBytes(4).toString('hex')}`
  const tokenId =
    opts.tokenId ?? `harness-root-${crypto.randomBytes(4).toString('hex')}`
  const boardId = opts.boardId ?? DEFAULT_BOARD_ID
  // Minimal record — server fills scopes via defaultScopesForRole(ROOT_ORCHESTRATOR)
  const record = {
    tokenId,
    secret,
    role: 'ROOT_ORCHESTRATOR',
    actorId,
    boardId,
    label: 'synthetic-harness-root',
  }
  return {
    bearer: secret,
    principalsJson: JSON.stringify([record]),
    actorId,
    tokenId,
    role: 'ROOT_ORCHESTRATOR',
    boardId,
    /** Public meta only — safe for receipts */
    principalMeta: {
      role: 'ROOT_ORCHESTRATOR',
      actorId,
      tokenId,
      boardId,
      hasSecret: true,
      secretByteLength: 32,
      secretEncoding: 'base64url',
    },
  }
}

/** Env keys that may carry bearer material — never log values. */
export const SENSITIVE_ENV_KEYS = Object.freeze([
  'CAIRN_BEARER_PRINCIPALS_JSON',
  'CAIRN_MCP_BEARER',
  'CAIRN_WRITE_TOKEN',
  'AUTHORIZATION',
])

/**
 * Redact known secrets + common credential field patterns from any JSON-able value.
 * Returns a deep clone; never mutates input.
 */
export function redactSecretsDeep(value, secrets = []) {
  const secretList = (secrets || []).filter((s) => typeof s === 'string' && s.length > 0)
  const scrubString = (s) => {
    let out = s
    for (const sec of secretList) {
      if (sec && out.includes(sec)) {
        out = out.split(sec).join('[REDACTED_BEARER]')
      }
    }
    return out
  }
  const walk = (v) => {
    if (v == null) return v
    if (typeof v === 'string') return scrubString(v)
    if (typeof v === 'number' || typeof v === 'boolean') return v
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        if (
          /authorization|bearer|token|secret|password|api[_-]?key|credential|CAIRN_BEARER|CAIRN_MCP_BEARER|CAIRN_WRITE_TOKEN/i.test(
            k,
          )
        ) {
          out[k] = '[REDACTED]'
          continue
        }
        out[k] = walk(val)
      }
      return out
    }
    return v
  }
  return walk(value)
}

/**
 * Sanitized MCP call shape for receipts/logs — never headers or token material.
 */
export function sanitizeMcpCallResult(result, secrets = []) {
  const toolJson = result?.toolJson ?? null
  const code =
    toolJson?.code ??
    result?.parsed?.error?.data?.code ??
    result?.parsed?.error?.message ??
    null
  const okProgrammatic =
    Boolean(result?.ok) &&
    !toolJson?.error &&
    !toolJson?.code &&
    toolJson?.ok !== false &&
    !(result?.parsed?.error)

  return redactSecretsDeep(
    {
      httpStatus: result?.httpStatus ?? null,
      ok: okProgrammatic,
      toolOk: toolJson?.ok === true,
      code: typeof code === 'string' ? code : code != null ? String(code) : null,
      toolJson: toolJson
        ? {
            ok: toolJson.ok,
            code: toolJson.code ?? null,
            // allowlisted non-secret fields
            planId: toolJson.planId ?? null,
            planVersion: toolJson.planVersion ?? null,
            boardRev: toolJson.boardRev ?? null,
            sourceRevision: toolJson.sourceRevision ?? null,
            generatedAt: toolJson.generatedAt ?? null,
            acceptedCount: toolJson.acceptedCount ?? null,
            usableCapacity: toolJson.usableCapacity ?? null,
            dispatchMode: toolJson.dispatchMode ?? null,
            stale: toolJson.stale ?? null,
            replayed: toolJson.replayed ?? null,
            boardId: toolJson.boardId ?? null,
            selectedForNextDispatch: toolJson.selectedForNextDispatch ?? null,
            next: toolJson.next ?? null,
            soleSource: toolJson.soleSource ?? null,
            blockedReason: toolJson.blockedReason ?? null,
            message: toolJson.message ?? null,
            error: toolJson.error ?? null,
          }
        : null,
      rpcError: result?.parsed?.error
        ? {
            code: result.parsed.error.code ?? null,
            message: result.parsed.error.message ?? null,
            dataCode: result.parsed.error.data?.code ?? null,
          }
        : null,
      // truncated raw never includes Authorization; still scrub secrets
      rawSlice: typeof result?.raw === 'string' ? result.raw.slice(0, 800) : null,
    },
    secrets,
  )
}

/**
 * Compare runtime pin probe vs fixture authority pin.
 * Only fields present on authority are required; runtime null/mismatch → fail closed.
 * taskHash compared only when available on runtime.
 */
export function comparePinParity(runtimePin, authorityPin) {
  const fields = [
    'canonicalSnapshotId',
    'canonicalHash',
    'boardRev',
    'lifecycleRev',
    'taskHash',
  ]
  const mismatches = []
  const compared = []
  for (const f of fields) {
    const authVal = authorityPin?.[f]
    if (authVal === undefined || authVal === null) continue
    // taskHash optional on runtime probe
    if (f === 'taskHash' && (runtimePin?.[f] === undefined || runtimePin?.[f] === null)) {
      continue
    }
    // canonicalHash may be absent on healthz — only compare when runtime provides it
    if (f === 'canonicalHash' && (runtimePin?.[f] === undefined || runtimePin?.[f] === null)) {
      continue
    }
    compared.push(f)
    const runVal = runtimePin?.[f]
    if (runVal === undefined || runVal === null) {
      mismatches.push({ field: f, authority: authVal, runtime: null, reason: 'runtime_missing' })
      continue
    }
    // normalize numbers
    const a = typeof authVal === 'number' ? authVal : String(authVal)
    const r = typeof runVal === 'number' ? runVal : String(runVal)
    if (String(a) !== String(r)) {
      mismatches.push({ field: f, authority: authVal, runtime: runVal, reason: 'mismatch' })
    }
  }
  return {
    ok: mismatches.length === 0 && compared.length > 0,
    compared,
    mismatches,
    // if nothing compared, still fail closed — cannot prove parity
    detail:
      compared.length === 0
        ? 'no_comparable_pin_fields'
        : mismatches.length
          ? 'pin_parity_mismatch'
          : 'pin_parity_ok',
  }
}

/**
 * Assert pin parity or throw ControlPlaneBootstrapError (fail closed — no publish).
 */
export function assertPinParityOrThrow(runtimePin, authorityPin) {
  const parity = comparePinParity(runtimePin, authorityPin)
  if (!parity.ok) {
    throw new ControlPlaneBootstrapError(
      `HARNESS FAIL: control-plane pin parity ${parity.detail}`,
      {
        code: 'PIN_PARITY_MISMATCH',
        parity: redactSecretsDeep(parity),
        runtimePin: redactSecretsDeep({
          ok: runtimePin?.ok,
          httpStatus: runtimePin?.httpStatus,
          canonicalSnapshotId: runtimePin?.canonicalSnapshotId ?? null,
          canonicalHash: runtimePin?.canonicalHash ?? null,
          boardRev: runtimePin?.boardRev ?? null,
          lifecycleRev: runtimePin?.lifecycleRev ?? null,
          taskHash: runtimePin?.taskHash ?? null,
          error: runtimePin?.error ?? null,
        }),
        authorityPin: {
          canonicalSnapshotId: authorityPin?.canonicalSnapshotId ?? null,
          canonicalHash: authorityPin?.canonicalHash ?? null,
          boardRev: authorityPin?.boardRev ?? null,
          lifecycleRev: authorityPin?.lifecycleRev ?? null,
          taskHash: authorityPin?.taskHash ?? null,
        },
      },
    )
  }
  return parity
}

/**
 * Parse MCP HTTP response body (JSON or SSE data: line).
 */
function parseMcpResponseText(text) {
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    const dataLine = text
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('data:'))
    if (dataLine) {
      try {
        parsed = JSON.parse(dataLine.replace(/^data:\s*/, ''))
      } catch {
        parsed = null
      }
    }
  }
  const contentText =
    parsed?.result?.content?.find?.((c) => c.type === 'text')?.text ??
    parsed?.result?.content?.[0]?.text ??
    null
  let toolJson = null
  if (typeof contentText === 'string') {
    try {
      toolJson = JSON.parse(contentText)
    } catch {
      toolJson = { raw: contentText }
    }
  }
  return { parsed, toolJson }
}

/**
 * Low-level POST /mcp. Bearer only in Authorization header (memory).
 * fetchImpl injectable for contract tests.
 */
export async function mcpJsonRpc(baseUrl, body, opts = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/mcp`
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
    ...(opts.headers ?? {}),
  }
  if (opts.bearer) {
    headers.authorization = `Bearer ${opts.bearer}`
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
  const { parsed, toolJson } = parseMcpResponseText(text)
  return {
    httpStatus: res.status,
    ok: res.ok,
    parsed,
    toolJson,
    raw: text.slice(0, 4000),
  }
}

/**
 * Bounded MCP protocol initialize (stateless servers accept tools/call without session,
 * but we still run the protocol-safe handshake when requested).
 */
export async function mcpInitialize(baseUrl, opts = {}) {
  const init = await mcpJsonRpc(
    baseUrl,
    {
      jsonrpc: '2.0',
      id: opts.id ?? 1,
      method: 'initialize',
      params: {
        protocolVersion: '2025-06-18',
        capabilities: {},
        clientInfo: { name: 'cairn-deterministic-harness', version: '1.0.0' },
      },
    },
    { ...opts, bearer: opts.bearer },
  )
  // notifications/initialized has no id
  try {
    await mcpJsonRpc(
      baseUrl,
      {
        jsonrpc: '2.0',
        method: 'notifications/initialized',
        params: {},
      },
      { ...opts, bearer: opts.bearer },
    )
  } catch {
    /* notification best-effort */
  }
  return sanitizeMcpCallResult(init, opts.secrets ?? (opts.bearer ? [opts.bearer] : []))
}

/**
 * JSON-RPC tools/call against /mcp.
 */
export async function mcpToolsCall(baseUrl, name, args, opts = {}) {
  const body = {
    jsonrpc: '2.0',
    id: opts.id ?? Date.now(),
    method: 'tools/call',
    params: { name, arguments: args },
  }
  return mcpJsonRpc(baseUrl, body, opts)
}

/**
 * Probe healthz pin fields (authenticated when bearer provided).
 * Never invents pin values.
 */
export async function probeRuntimePin(baseUrl, opts = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/healthz`
  const headers = {}
  if (opts.bearer) {
    headers.authorization = `Bearer ${opts.bearer}`
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  try {
    const res = await fetchImpl(url, { redirect: 'manual', headers })
    const text = await res.text()
    let body = null
    try {
      body = JSON.parse(text)
    } catch {
      body = null
    }
    const snap = body?.snapshot ?? body?.observed?.snapshot ?? body
    return redactSecretsDeep(
      {
        ok: res.ok,
        httpStatus: res.status,
        canonicalSnapshotId:
          snap?.canonicalSnapshotId ??
          body?.canonicalSnapshotId ??
          body?.pin?.canonicalSnapshotId ??
          null,
        canonicalHash:
          snap?.canonicalHash ?? body?.canonicalHash ?? body?.pin?.canonicalHash ?? null,
        boardRev: snap?.boardRev ?? body?.boardRev ?? body?.pin?.boardRev ?? null,
        lifecycleRev:
          snap?.lifecycleRev ?? body?.lifecycleRev ?? body?.pin?.lifecycleRev ?? null,
        taskHash: snap?.taskHash ?? body?.taskHash ?? body?.pin?.taskHash ?? null,
        rawSlice: text.slice(0, 1500),
      },
      opts.secrets ?? (opts.bearer ? [opts.bearer] : []),
    )
  } catch (e) {
    return { ok: false, error: String(e?.message || e) }
  }
}

/**
 * Build child-only env fragment for owned preview (never log the value).
 */
export function buildChildBearerEnv(principal) {
  if (!principal?.principalsJson) {
    throw new ControlPlaneBootstrapError('buildChildBearerEnv: principal.principalsJson required', {
      code: 'MISSING_PRINCIPAL',
    })
  }
  return {
    CAIRN_BEARER_PRINCIPALS_JSON: principal.principalsJson,
  }
}

/**
 * True when a tools/call result is programmatic success for publish/sync.
 */
export function isMcpToolProgrammaticOk(result) {
  if (!result?.ok) return false
  if (result.parsed?.error) return false
  const tj = result.toolJson
  if (!tj) return false
  if (tj.error || tj.code) return false
  if (tj.ok === false) return false
  // publish/sync return ok:true; get_next may omit ok
  if (tj.ok === true) return true
  // get_next shape: has soleSource / selectedForNextDispatch
  if (tj.selectedForNextDispatch != null || tj.soleSource != null) return true
  return false
}

/**
 * Publish synth dispatch plan + account sync after owned preview is up.
 * Fail-closed: throws ControlPlaneBootstrapError on pin mismatch / MCP auth / readback fail.
 * Receipt-safe: returned object never contains bearer.
 */
export async function bootstrapControlPlaneOnServer(opts = {}) {
  const baseUrl = opts.baseUrl
  if (!baseUrl) throw new Error('bootstrapControlPlaneOnServer: baseUrl required')
  const boardId = opts.boardId ?? DEFAULT_BOARD_ID
  const pin = opts.pin ?? buildHarnessPin()
  const now = opts.now ?? new Date().toISOString()
  const dispatch = opts.dispatchSeed ?? buildDispatchPlanSeed(now, pin)
  const accountSync = opts.accountSyncSeed ?? buildAccountSyncSeed(now, pin)
  const bearer = opts.bearer ?? null
  const secrets = bearer ? [bearer] : []
  const fetchImpl = opts.fetchImpl
  const requireBearer = opts.requireBearer !== false
  const failClosed = opts.failClosed !== false
  const skipPinCheck = opts.skipPinCheck === true

  if (requireBearer && !bearer) {
    const err = new ControlPlaneBootstrapError(
      'HARNESS FAIL: synthetic ROOT bearer required for MCP bootstrap (do not use CAIRN_WRITE_TOKEN)',
      { code: 'MISSING_BEARER' },
    )
    if (failClosed) throw err
    return {
      ok: false,
      boardId,
      pin: pinSlice(pin),
      residuals: [{ step: 'bearer', class: 'CONTROL_PLANE_BOOTSTRAP', detail: err.message }],
      principalMeta: opts.principalMeta ?? null,
    }
  }

  const mcpOpts = { bearer, fetchImpl, secrets, id: undefined }

  // Optional protocol init (bounded; does not replace auth on tools/call)
  let initialize = null
  if (opts.initialize !== false) {
    try {
      initialize = await mcpInitialize(baseUrl, { ...mcpOpts, id: 90001 })
    } catch (e) {
      initialize = { ok: false, error: String(e?.message || e) }
    }
  }

  // Pin probe + parity BEFORE any publish
  let runtimePin =
    opts.runtimePin ??
    (await probeRuntimePin(baseUrl, { bearer, fetchImpl, secrets }))
  let pinParity = null
  if (!skipPinCheck) {
    // Prefer explicit seed/runtime pin injection for tests; live path uses probe
    const authority = opts.authorityPin ?? pin
    pinParity = comparePinParity(runtimePin, authority)
    if (!pinParity.ok) {
      const err = new ControlPlaneBootstrapError(
        `HARNESS FAIL: control-plane pin parity ${pinParity.detail}`,
        {
          code: 'PIN_PARITY_MISMATCH',
          parity: pinParity,
          runtimePin: pinProbeSlice(runtimePin),
          authorityPin: pinSlice(authority),
        },
      )
      if (failClosed) throw err
      return sanitizeBootstrapResult({
        ok: false,
        boardId,
        pin: pinSlice(pin),
        runtimePin: pinProbeSlice(runtimePin),
        pinParity,
        initialize,
        residuals: [
          {
            step: 'pin_parity',
            class: 'CONTROL_PLANE_BOOTSTRAP',
            detail: pinParity.detail,
            mismatches: pinParity.mismatches,
          },
        ],
        principalMeta: opts.principalMeta ?? null,
      }, secrets)
    }
  }

  const results = {
    boardId,
    pin: pinSlice(pin),
    runtimePin: pinProbeSlice(runtimePin),
    pinParity,
    initialize,
    principalMeta: opts.principalMeta ?? null,
    publishDispatch: null,
    getNext: null,
    syncAccounts: null,
    planReadback: null,
    accountReadback: null,
    residuals: [],
  }

  // 1) publish_dispatch_plan — sole NEXT source
  const dispatchArgs = {
    boardId,
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    planHash: dispatch.planHash,
    canonicalSnapshotId: dispatch.canonicalSnapshotId,
    canonicalHash: dispatch.canonicalHash,
    expectedBoardRev: dispatch.expectedBoardRev,
    issuedAt: dispatch.issuedAt,
    expiresAt: dispatch.expiresAt,
    stage: dispatch.stage ?? 'ACTIVE',
    items: dispatch.items,
    idempotencyKey: dispatch.idempotencyKey,
  }
  const publishRaw = await mcpToolsCall(baseUrl, 'publish_dispatch_plan', dispatchArgs, {
    ...mcpOpts,
    id: 91001,
  })
  results.publishDispatch = sanitizeMcpCallResult(publishRaw, secrets)

  if (!isMcpToolProgrammaticOk(publishRaw)) {
    const detail =
      publishRaw.toolJson?.message ||
      publishRaw.toolJson?.error ||
      publishRaw.toolJson?.code ||
      publishRaw.parsed?.error?.message ||
      `http ${publishRaw.httpStatus}`
    results.residuals.push({
      step: 'publish_dispatch_plan',
      class: 'CONTROL_PLANE_BOOTSTRAP',
      detail: String(detail),
    })
    return failBootstrap(results, failClosed, secrets, 'publish_dispatch_plan', detail)
  }

  // 2) get_next readback — sole NEXT source with exact task/rank
  const getNextRaw = await mcpToolsCall(
    baseUrl,
    'get_next',
    { boardId },
    { ...mcpOpts, id: 91002 },
  )
  results.getNext = sanitizeMcpCallResult(getNextRaw, secrets)
  const nextItems =
    getNextRaw.toolJson?.selectedForNextDispatch ??
    getNextRaw.toolJson?.next ??
    null
  const nextArr = Array.isArray(nextItems)
    ? nextItems
    : nextItems
      ? [nextItems]
      : []
  const expectedTaskId = dispatch.items?.[0]?.taskId ?? 'task-next-1'
  const expectedRank = dispatch.items?.[0]?.rank ?? 1
  const match = nextArr.find(
    (it) =>
      it &&
      (it.taskId === expectedTaskId || it.id === expectedTaskId) &&
      (it.rank == null || Number(it.rank) === Number(expectedRank)),
  )
  const soleSourceOk =
    getNextRaw.toolJson?.soleSource === 'active_dispatch_plan' ||
    getNextRaw.toolJson?.soleSource === true ||
    getNextRaw.toolJson?.planId === dispatch.planId ||
    Boolean(match)

  results.planReadback = redactSecretsDeep(
    {
      ok: Boolean(match) && soleSourceOk,
      expectedTaskId,
      expectedRank,
      expectedPlanId: dispatch.planId,
      foundTaskId: match?.taskId ?? match?.id ?? null,
      foundRank: match?.rank ?? null,
      planId: getNextRaw.toolJson?.planId ?? null,
      soleSource: getNextRaw.toolJson?.soleSource ?? null,
      selectionReason: match?.selectionReason ?? match?.reason ?? null,
      itemCount: nextArr.length,
    },
    secrets,
  )

  if (!results.planReadback.ok) {
    const detail = `plan readback failed: expected task=${expectedTaskId} rank=${expectedRank} plan=${dispatch.planId}`
    results.residuals.push({
      step: 'get_next_readback',
      class: 'CONTROL_PLANE_BOOTSTRAP',
      detail,
    })
    return failBootstrap(results, failClosed, secrets, 'get_next_readback', detail)
  }

  // 3) sync_accounts — CAS against *current* board rev.
  // publish_dispatch_plan bumps boardRev (e.g. pin 7 → 8). Using the seed pin's
  // expectedBoardRev here fails with STALE_REVISION / "board rev mismatch".
  const publishedBoardRev = Number(publishRaw.toolJson?.boardRev)
  const syncExpectedBoardRev =
    Number.isFinite(publishedBoardRev) && publishedBoardRev >= 0
      ? publishedBoardRev
      : accountSync.expectedBoardRev
  const syncArgs = {
    boardId,
    sourceRevision: accountSync.sourceRevision,
    expectedBoardRev: syncExpectedBoardRev,
    generatedAt: accountSync.generatedAt,
    accounts: accountSync.accounts,
    idempotencyKey: accountSync.idempotencyKey,
    trigger: accountSync.trigger ?? 'ORCHESTRATOR_LAUNCH',
  }
  const syncRaw = await mcpToolsCall(baseUrl, 'sync_accounts', syncArgs, {
    ...mcpOpts,
    id: 91003,
  })
  results.syncAccounts = sanitizeMcpCallResult(syncRaw, secrets)

  if (!isMcpToolProgrammaticOk(syncRaw)) {
    const detail =
      syncRaw.toolJson?.message ||
      syncRaw.toolJson?.error ||
      syncRaw.toolJson?.code ||
      syncRaw.parsed?.error?.message ||
      `http ${syncRaw.httpStatus}`
    results.residuals.push({
      step: 'sync_accounts',
      class: 'CONTROL_PLANE_BOOTSTRAP',
      detail: String(detail),
    })
    return failBootstrap(results, failClosed, secrets, 'sync_accounts', detail)
  }

  // Account readback parity from MCP tool result (sourceRevision/generatedAt)
  const srcRev = syncRaw.toolJson?.sourceRevision
  const genAt = syncRaw.toolJson?.generatedAt ?? null
  const usable = syncRaw.toolJson?.usableCapacity
  const revOk = Number(srcRev) === Number(accountSync.sourceRevision)
  // generatedAt: when tool returns it, require exact parity; when omitted, accept publish-time seed
  const genOk =
    genAt == null || String(genAt) === String(accountSync.generatedAt)
  results.accountReadback = redactSecretsDeep(
    {
      ok: revOk && genOk,
      expectedSourceRevision: accountSync.sourceRevision,
      sourceRevision: srcRev ?? null,
      expectedGeneratedAt: accountSync.generatedAt,
      generatedAt: genAt ?? accountSync.generatedAt,
      usableCapacity: usable ?? null,
      acceptedCount: syncRaw.toolJson?.acceptedCount ?? null,
      dispatchMode: syncRaw.toolJson?.dispatchMode ?? null,
      stale: syncRaw.toolJson?.stale ?? null,
      maskedIdsOnly: true,
    },
    secrets,
  )

  if (!revOk) {
    const detail = `account sourceRevision parity fail: expected ${accountSync.sourceRevision} got ${srcRev}`
    results.residuals.push({
      step: 'account_readback',
      class: 'CONTROL_PLANE_BOOTSTRAP',
      detail,
    })
    results.accountReadback.ok = false
    return failBootstrap(results, failClosed, secrets, 'account_readback', detail)
  }
  if (!genOk) {
    const detail = `account generatedAt parity fail: expected ${accountSync.generatedAt} got ${genAt}`
    results.residuals.push({
      step: 'account_readback',
      class: 'CONTROL_PLANE_BOOTSTRAP',
      detail,
    })
    results.accountReadback.ok = false
    return failBootstrap(results, failClosed, secrets, 'account_readback', detail)
  }

  results.ok = results.residuals.length === 0
  return sanitizeBootstrapResult(results, secrets)
}

function pinSlice(pin) {
  return {
    canonicalSnapshotId: pin?.canonicalSnapshotId ?? null,
    canonicalHash: pin?.canonicalHash ?? null,
    taskHash: pin?.taskHash ?? null,
    boardRev: pin?.boardRev ?? null,
    lifecycleRev: pin?.lifecycleRev ?? null,
  }
}

function pinProbeSlice(p) {
  return {
    ok: p?.ok ?? null,
    httpStatus: p?.httpStatus ?? null,
    canonicalSnapshotId: p?.canonicalSnapshotId ?? null,
    canonicalHash: p?.canonicalHash ?? null,
    boardRev: p?.boardRev ?? null,
    lifecycleRev: p?.lifecycleRev ?? null,
    taskHash: p?.taskHash ?? null,
    error: p?.error ?? null,
  }
}

function sanitizeBootstrapResult(results, secrets) {
  return redactSecretsDeep(results, secrets)
}

function failBootstrap(results, failClosed, secrets, step, detail) {
  results.ok = false
  const sanitized = sanitizeBootstrapResult(results, secrets)
  if (failClosed) {
    throw new ControlPlaneBootstrapError(`HARNESS FAIL: control-plane bootstrap ${step}: ${detail}`, {
      code: 'CONTROL_PLANE_BOOTSTRAP_FAIL',
      step,
      detail: String(detail),
      result: sanitized,
    })
  }
  return sanitized
}

/**
 * Pure contract suite for self-tests / harness-contract (mockable fetch).
 * Does not start a server.
 */
export async function runBootstrapContractSelfTests() {
  const results = []
  const ok = (name, pass, detail) => {
    results.push({ name, pass, detail: detail ?? null })
  }

  // 1) synthetic principal shape (no secret in meta)
  const p = createSyntheticRootPrincipal({ boardId: 'mfs-rebuild' })
  ok(
    'synth-principal-role-root',
    p.role === 'ROOT_ORCHESTRATOR' && p.principalMeta.role === 'ROOT_ORCHESTRATOR',
  )
  ok('synth-bearer-high-entropy', typeof p.bearer === 'string' && p.bearer.length >= 32)
  ok(
    'synth-meta-no-secret',
    !JSON.stringify(p.principalMeta).includes(p.bearer) && p.principalMeta.hasSecret === true,
  )
  const childEnv = buildChildBearerEnv(p)
  ok(
    'child-env-has-principals-json',
    typeof childEnv.CAIRN_BEARER_PRINCIPALS_JSON === 'string' &&
      childEnv.CAIRN_BEARER_PRINCIPALS_JSON.includes('ROOT_ORCHESTRATOR'),
  )

  // 2) redaction
  const dirty = {
    authorization: `Bearer ${p.bearer}`,
    nested: { token: p.bearer, ok: true },
    message: `used ${p.bearer} once`,
  }
  const clean = redactSecretsDeep(dirty, [p.bearer])
  ok(
    'redact-bearer-absent',
    !JSON.stringify(clean).includes(p.bearer) &&
      clean.authorization === '[REDACTED]' &&
      clean.nested.token === '[REDACTED]',
  )

  // 3) sanitize mcp result
  const fakeMcp = {
    httpStatus: 200,
    ok: true,
    toolJson: { ok: true, planId: 'plan-x', sourceRevision: 7 },
    parsed: null,
    raw: `Bearer ${p.bearer}`,
  }
  const san = sanitizeMcpCallResult(fakeMcp, [p.bearer])
  ok('sanitize-shape-ok', san.ok === true && san.toolJson?.planId === 'plan-x')
  ok('sanitize-no-bearer', !JSON.stringify(san).includes(p.bearer))

  // 4) pin mismatch fail-closed
  const authPin = buildHarnessPin()
  const badRuntime = {
    ok: true,
    httpStatus: 200,
    canonicalSnapshotId: 'wrong-snap',
    boardRev: 1,
    lifecycleRev: 1,
  }
  const parity = comparePinParity(badRuntime, authPin)
  ok('pin-mismatch-detected', !parity.ok && parity.mismatches.length >= 1)
  let pinThrew = false
  try {
    assertPinParityOrThrow(badRuntime, authPin)
  } catch (e) {
    pinThrew = e instanceof ControlPlaneBootstrapError && e.code === 'PIN_PARITY_MISMATCH'
  }
  ok('pin-mismatch-throws', pinThrew)

  // pin match path
  const goodRuntime = {
    ok: true,
    httpStatus: 200,
    canonicalSnapshotId: authPin.canonicalSnapshotId,
    boardRev: authPin.boardRev,
    lifecycleRev: authPin.lifecycleRev,
    taskHash: authPin.taskHash,
  }
  ok('pin-match-ok', comparePinParity(goodRuntime, authPin).ok === true)

  // 5) missing bearer fail-closed
  let missingThrew = false
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      requireBearer: true,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      bearer: null,
    })
  } catch (e) {
    missingThrew = e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_BEARER'
  }
  ok('missing-bearer-fail-close', missingThrew)

  // 6) wrong/missing bearer denial (mock network → 401)
  const denyFetch = async () => ({
    ok: false,
    status: 401,
    text: async () =>
      JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        error: { code: -32001, message: 'AUTHORIZATION_REQUIRED', data: { code: 'AUTHORIZATION_REQUIRED' } },
      }),
  })
  let denyThrew = false
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: 'wrong-token-not-configured',
      requireBearer: true,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      fetchImpl: denyFetch,
      pin: authPin,
      runtimePin: goodRuntime,
    })
  } catch (e) {
    denyThrew =
      e instanceof ControlPlaneBootstrapError &&
      /publish_dispatch_plan|AUTHORIZATION/i.test(String(e.message))
  }
  ok('wrong-bearer-denied-fail-close', denyThrew)

  // 7) successful sanitized shape (mock full happy path)
  const calls = []
  const happyFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls.push(body.method === 'tools/call' ? body.params?.name : body.method)
    // never echo authorization in body
    if (body.method === 'initialize') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: { protocolVersion: '2025-06-18', serverInfo: { name: 'cairn-board' } },
          }),
      }
    }
    if (body.method === 'notifications/initialized') {
      return { ok: true, status: 200, text: async () => '' }
    }
    if (body.params?.name === 'publish_dispatch_plan') {
      // Simulate server bump: seed pin boardRev=7 → post-publish 8
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: true,
                    planId: 'plan-synth-r4f-001',
                    boardRev: authPin.boardRev + 1,
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.params?.name === 'get_next') {
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    planId: 'plan-synth-r4f-001',
                    soleSource: 'active_dispatch_plan',
                    selectedForNextDispatch: [
                      {
                        taskId: 'task-next-1',
                        rank: 1,
                        selectionReason: 'SYNTH: root dispatch selected NEXT candidate',
                      },
                    ],
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.params?.name === 'sync_accounts') {
      // Fail mock if bootstrap still sends pre-publish expectedBoardRev
      const args = body.params?.arguments ?? {}
      const wantRev = authPin.boardRev + 1
      if (Number(args.expectedBoardRev) !== wantRev) {
        return {
          ok: true,
          status: 200,
          text: async () =>
            JSON.stringify({
              jsonrpc: '2.0',
              id: body.id,
              result: {
                content: [
                  {
                    type: 'text',
                    text: JSON.stringify({
                      ok: false,
                      error: 'board rev mismatch',
                      code: 'STALE_REVISION',
                      details: {
                        expectedBoardRev: args.expectedBoardRev,
                        currentBoardRev: wantRev,
                      },
                    }),
                  },
                ],
              },
            }),
        }
      }
      return {
        ok: true,
        status: 200,
        text: async () =>
          JSON.stringify({
            jsonrpc: '2.0',
            id: body.id,
            result: {
              content: [
                {
                  type: 'text',
                  text: JSON.stringify({
                    ok: true,
                    sourceRevision: authPin.boardRev,
                    generatedAt: '2026-07-13T00:00:00.000Z',
                    acceptedCount: 2,
                    usableCapacity: 3,
                    dispatchMode: 'NORMAL',
                    stale: false,
                  }),
                },
              ],
            },
          }),
      }
    }
    return {
      ok: false,
      status: 500,
      text: async () => JSON.stringify({ error: 'unexpected' }),
    }
  }

  const happy = await bootstrapControlPlaneOnServer({
    baseUrl: 'http://127.0.0.1:9',
    bearer: p.bearer,
    requireBearer: true,
    failClosed: true,
    skipPinCheck: false,
    initialize: true,
    fetchImpl: happyFetch,
    pin: authPin,
    authorityPin: authPin,
    runtimePin: goodRuntime,
    now: '2026-07-13T00:00:00.000Z',
    principalMeta: p.principalMeta,
  })
  ok('happy-bootstrap-ok', happy.ok === true)
  ok(
    'happy-calls-order',
    calls.includes('publish_dispatch_plan') &&
      calls.includes('get_next') &&
      calls.includes('sync_accounts'),
  )
  ok(
    'happy-sanitized-no-bearer',
    !JSON.stringify(happy).includes(p.bearer) &&
      happy.publishDispatch?.toolOk === true &&
      happy.planReadback?.ok === true &&
      happy.accountReadback?.ok === true,
  )
  ok(
    'happy-plan-readback-task',
    happy.planReadback?.foundTaskId === 'task-next-1' &&
      happy.planReadback?.expectedPlanId === 'plan-synth-r4f-001',
  )
  ok(
    'happy-account-revision',
    Number(happy.accountReadback?.sourceRevision) === Number(authPin.boardRev),
  )

  // 8) pin mismatch aborts before publish (no tools/call)
  const calls2 = []
  const trackFetch = async (url, init) => {
    const body = JSON.parse(init.body)
    calls2.push(body.method === 'tools/call' ? body.params?.name : body.method)
    return {
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} }),
    }
  }
  let pinAbort = false
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: p.bearer,
      failClosed: true,
      initialize: false,
      fetchImpl: trackFetch,
      pin: authPin,
      authorityPin: authPin,
      runtimePin: badRuntime,
    })
  } catch (e) {
    pinAbort = e instanceof ControlPlaneBootstrapError && e.code === 'PIN_PARITY_MISMATCH'
  }
  ok('pin-mismatch-no-publish', pinAbort && !calls2.includes('publish_dispatch_plan'))

  const failCount = results.filter((r) => !r.pass).length
  return { results, failCount, ok: failCount === 0 }
}
