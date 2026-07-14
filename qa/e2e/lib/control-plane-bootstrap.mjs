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
  FORBIDDEN_PLACEHOLDER_CANONICAL_HASH,
  DEFAULT_BOARD_ID,
} from '../fixtures/seed/control-center-fixture.mjs'
import { materializeAuthorityPin } from '../fixtures/seed/seed-isolated.mjs'

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
 * Map dispatch/account seed → top-level entityExpectedRev for MCP mutation envelope.
 *
 * Product parseMutationEnvelope accepts entityExpectedRev | expectedEntityRev | expectedRev
 * at the **tool args top level** (not nested under items). Seed may place the value on:
 *   - seed.entityExpectedRev / seed.expectedEntityRev / seed.expectedRev
 *   - seed.items[0].expectedEntityRev / seed.items[0].entityExpectedRev (dispatch only)
 *
 * Honest zero (0) is VALID create semantics. Omission is NOT defaulted to 0 —
 * fail-closed so we never weaken the product validator with a silent invent.
 *
 * @param {object} seed
 * @param {{ label?: string, allowItems?: boolean }} [opts]
 * @returns {number}
 */
export function resolveEntityExpectedRevFromSeed(seed, opts = {}) {
  const label = opts.label ?? 'seed'
  const allowItems = opts.allowItems !== false
  const candidates = [
    seed?.entityExpectedRev,
    seed?.expectedEntityRev,
    seed?.expectedRev,
  ]
  if (allowItems && Array.isArray(seed?.items) && seed.items[0]) {
    candidates.push(seed.items[0].expectedEntityRev, seed.items[0].entityExpectedRev)
  }
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) {
      return c
    }
  }
  throw new ControlPlaneBootstrapError(
    `HARNESS FAIL: ${label} entityExpectedRev (or expectedEntityRev/expectedRev) is required — no silent default`,
    {
      code: 'MISSING_ENTITY_EXPECTED_REV',
      label,
      seen: {
        entityExpectedRev: seed?.entityExpectedRev ?? null,
        expectedEntityRev: seed?.expectedEntityRev ?? null,
        expectedRev: seed?.expectedRev ?? null,
        item0:
          Array.isArray(seed?.items) && seed.items[0]
            ? {
                expectedEntityRev: seed.items[0].expectedEntityRev ?? null,
                entityExpectedRev: seed.items[0].entityExpectedRev ?? null,
              }
            : null,
      },
    },
  )
}

/**
 * Resolve current subject/canonical hash for mutation envelope.
 *
 * Product parseMutationEnvelope requires canonicalHash | subjectHash (at least one).
 * Prefer seed fields, then pin fallback. NEVER invent placeholder or empty string.
 *
 * @param {object|null|undefined} seed
 * @param {object|null|undefined} pin
 * @param {{ label?: string }} [opts]
 * @returns {string}
 */
export function resolveSubjectHashFromSeed(seed, pin = null, opts = {}) {
  const label = opts.label ?? 'seed'
  const candidates = [
    seed?.canonicalHash,
    seed?.subjectHash,
    pin?.canonicalHash,
    pin?.subjectHash,
  ]
  for (const c of candidates) {
    if (typeof c === 'string') {
      const t = c.trim()
      if (
        t &&
        t.toLowerCase() !== FORBIDDEN_PLACEHOLDER_CANONICAL_HASH
      ) {
        return t
      }
    }
  }
  throw new ControlPlaneBootstrapError(
    `HARNESS FAIL: ${label} canonicalHash or subjectHash is required (current subject/canonical hash) — no silent default`,
    {
      code: 'MISSING_SUBJECT_HASH',
      label,
      seen: {
        seedCanonicalHash: seed?.canonicalHash ?? null,
        seedSubjectHash: seed?.subjectHash ?? null,
        pinCanonicalHash: pin?.canonicalHash ?? null,
        pinSubjectHash: pin?.subjectHash ?? null,
      },
    },
  )
}

/**
 * Resolve expectedBoardRev for mutation envelope. Honest zero is valid.
 * Omission is NOT defaulted.
 *
 * @param {object} seed
 * @param {{ label?: string, override?: number|null }} [opts]
 * @returns {number}
 */
export function resolveExpectedBoardRevFromSeed(seed, opts = {}) {
  const label = opts.label ?? 'seed'
  if (opts.override !== undefined && opts.override !== null) {
    const o = opts.override
    if (typeof o === 'number' && Number.isInteger(o) && o >= 0) return o
    throw new ControlPlaneBootstrapError(
      `HARNESS FAIL: ${label} expectedBoardRev override invalid — no silent default`,
      { code: 'INVALID_EXPECTED_BOARD_REV', label, override: o ?? null },
    )
  }
  const candidates = [seed?.expectedBoardRev, seed?.boardRev]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return c
  }
  throw new ControlPlaneBootstrapError(
    `HARNESS FAIL: ${label} expectedBoardRev is required — no silent default`,
    {
      code: 'MISSING_EXPECTED_BOARD_REV',
      label,
      seen: {
        expectedBoardRev: seed?.expectedBoardRev ?? null,
        boardRev: seed?.boardRev ?? null,
      },
    },
  )
}

/**
 * Resolve idempotencyKey for mutation envelope. Non-empty string required.
 *
 * @param {object} seed
 * @param {{ label?: string }} [opts]
 * @returns {string}
 */
export function resolveIdempotencyKeyFromSeed(seed, opts = {}) {
  const label = opts.label ?? 'seed'
  const key = typeof seed?.idempotencyKey === 'string' ? seed.idempotencyKey.trim() : ''
  if (!key) {
    throw new ControlPlaneBootstrapError(
      `HARNESS FAIL: ${label} idempotencyKey is required — no silent default`,
      {
        code: 'MISSING_IDEMPOTENCY_KEY',
        label,
        seen: { idempotencyKey: seed?.idempotencyKey ?? null },
      },
    )
  }
  return key
}

/**
 * Resolve sourceRevision for sync_accounts (exact preserve including 0).
 * Omission is NOT defaulted.
 *
 * @param {object} seed
 * @param {{ label?: string }} [opts]
 * @returns {number}
 */
export function resolveSourceRevisionFromSeed(seed, opts = {}) {
  const label = opts.label ?? 'accountSyncSeed'
  const c = seed?.sourceRevision
  if (typeof c === 'number' && Number.isInteger(c) && c >= 0) return c
  throw new ControlPlaneBootstrapError(
    `HARNESS FAIL: ${label} sourceRevision is required (non-negative integer) — no silent default`,
    {
      code: 'MISSING_SOURCE_REVISION',
      label,
      seen: { sourceRevision: seed?.sourceRevision ?? null },
    },
  )
}

/**
 * Build product-parity mutation envelope fields for MCP write tools.
 * Mirrors board-mcp parseMutationEnvelope required surface:
 *   entityExpectedRev | expectedEntityRev | expectedRev
 *   expectedBoardRev
 *   canonicalHash | subjectHash
 *   idempotencyKey
 *
 * Sends both hash aliases + entity aliases for wire clarity.
 * Never invents zeros or hashes.
 *
 * @param {object} seed
 * @param {{
 *   label?: string,
 *   pin?: object|null,
 *   allowItems?: boolean,
 *   expectedBoardRevOverride?: number|null,
 * }} [opts]
 * @returns {{
 *   entityExpectedRev: number,
 *   expectedEntityRev: number,
 *   expectedBoardRev: number,
 *   canonicalHash: string,
 *   subjectHash: string,
 *   idempotencyKey: string,
 * }}
 */
export function buildMutationEnvelopeFromSeed(seed, opts = {}) {
  const label = opts.label ?? 'seed'
  const entityExpectedRev = resolveEntityExpectedRevFromSeed(seed, {
    label,
    allowItems: opts.allowItems,
  })
  const expectedBoardRev = resolveExpectedBoardRevFromSeed(seed, {
    label,
    override: opts.expectedBoardRevOverride,
  })
  const subjectHash = resolveSubjectHashFromSeed(seed, opts.pin ?? null, { label })
  const idempotencyKey = resolveIdempotencyKeyFromSeed(seed, { label })
  return {
    entityExpectedRev,
    expectedEntityRev: entityExpectedRev,
    expectedBoardRev,
    canonicalHash: subjectHash,
    subjectHash,
    idempotencyKey,
  }
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
  // Full mutation envelope: entityExpectedRev (0 valid), expectedBoardRev,
  // canonicalHash|subjectHash, idempotencyKey. Never invent omitted fields.
  let dispatchEnvelope
  try {
    dispatchEnvelope = buildMutationEnvelopeFromSeed(dispatch, {
      label: 'dispatchSeed',
      pin,
      allowItems: true,
    })
  } catch (e) {
    if (e instanceof ControlPlaneBootstrapError) {
      results.residuals.push({
        step: 'publish_dispatch_plan',
        class: 'CONTROL_PLANE_BOOTSTRAP',
        detail: e.message,
      })
      return failBootstrap(results, failClosed, secrets, 'publish_dispatch_plan', e.message)
    }
    throw e
  }
  const dispatchArgs = {
    boardId,
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    planHash: dispatch.planHash,
    canonicalSnapshotId: dispatch.canonicalSnapshotId ?? pin?.canonicalSnapshotId,
    // Product aliases all accepted; envelope sends both hash + entity aliases.
    ...dispatchEnvelope,
    issuedAt: dispatch.issuedAt,
    expiresAt: dispatch.expiresAt,
    stage: dispatch.stage ?? 'ACTIVE',
    items: dispatch.items,
  }
  // Surface mapped envelope on receipt (not a secret)
  results.dispatchEntityExpectedRev = dispatchEnvelope.entityExpectedRev
  results.dispatchExpectedBoardRev = dispatchEnvelope.expectedBoardRev
  results.dispatchSubjectHash = dispatchEnvelope.subjectHash
  results.dispatchIdempotencyKey = dispatchEnvelope.idempotencyKey
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

  // 3) sync_accounts — full mutation envelope + exact sourceRevision.
  // publish_dispatch_plan bumps boardRev (e.g. pin 7 → 8). Using the seed pin's
  // expectedBoardRev here fails with STALE_REVISION / "board rev mismatch".
  // Authority canonicalHash/subjectHash still required (product pin check).
  const publishedBoardRev = Number(publishRaw.toolJson?.boardRev)
  const boardRevOverride =
    Number.isFinite(publishedBoardRev) && publishedBoardRev >= 0
      ? publishedBoardRev
      : null
  let syncEnvelope
  let syncSourceRevision
  try {
    syncEnvelope = buildMutationEnvelopeFromSeed(accountSync, {
      label: 'accountSyncSeed',
      pin,
      allowItems: false,
      expectedBoardRevOverride: boardRevOverride,
    })
    syncSourceRevision = resolveSourceRevisionFromSeed(accountSync, {
      label: 'accountSyncSeed',
    })
  } catch (e) {
    if (e instanceof ControlPlaneBootstrapError) {
      results.residuals.push({
        step: 'sync_accounts',
        class: 'CONTROL_PLANE_BOOTSTRAP',
        detail: e.message,
      })
      return failBootstrap(results, failClosed, secrets, 'sync_accounts', e.message)
    }
    throw e
  }
  const syncArgs = {
    boardId,
    sourceRevision: syncSourceRevision,
    ...syncEnvelope,
    generatedAt: accountSync.generatedAt,
    accounts: accountSync.accounts,
    trigger: accountSync.trigger ?? 'ORCHESTRATOR_LAUNCH',
  }
  results.syncEntityExpectedRev = syncEnvelope.entityExpectedRev
  results.syncExpectedBoardRev = syncEnvelope.expectedBoardRev
  results.syncSubjectHash = syncEnvelope.subjectHash
  results.syncIdempotencyKey = syncEnvelope.idempotencyKey
  results.syncSourceRevision = syncSourceRevision
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

  // 4) pin mismatch fail-closed (materialized authority — real hash, never placeholder)
  const authPin = materializeAuthorityPin({ boardId: DEFAULT_BOARD_ID }).pin
  ok(
    'authority-hash-not-placeholder',
    /^[0-9a-f]{64}$/i.test(authPin.canonicalHash) &&
      authPin.canonicalHash !== FORBIDDEN_PLACEHOLDER_CANONICAL_HASH,
    authPin.canonicalHash?.slice(0, 16),
  )
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

  // Cross-pin reject: runtime hash ≠ authority hash must fail closed
  const hashMismatchRuntime = {
    ok: true,
    httpStatus: 200,
    canonicalSnapshotId: authPin.canonicalSnapshotId,
    canonicalHash: 'f'.repeat(64),
    boardRev: authPin.boardRev,
    lifecycleRev: authPin.lifecycleRev,
    taskHash: authPin.taskHash,
  }
  const hashParity = comparePinParity(hashMismatchRuntime, authPin)
  ok(
    'cross-pin-hash-reject',
    !hashParity.ok &&
      hashParity.mismatches.some((m) => m.field === 'canonicalHash'),
    JSON.stringify(hashParity.mismatches),
  )
  let hashThrew = false
  try {
    assertPinParityOrThrow(hashMismatchRuntime, authPin)
  } catch (e) {
    hashThrew = e instanceof ControlPlaneBootstrapError && e.code === 'PIN_PARITY_MISMATCH'
  }
  ok('cross-pin-hash-throws', hashThrew)

  // Placeholder authority still rejected when runtime has real hash
  const placeholderAuth = {
    ...authPin,
    canonicalHash: FORBIDDEN_PLACEHOLDER_CANONICAL_HASH,
  }
  const placeholderParity = comparePinParity(
    {
      ok: true,
      httpStatus: 200,
      canonicalSnapshotId: authPin.canonicalSnapshotId,
      canonicalHash: authPin.canonicalHash,
      boardRev: authPin.boardRev,
      lifecycleRev: authPin.lifecycleRev,
    },
    placeholderAuth,
  )
  ok(
    'placeholder-authority-vs-runtime-reject',
    !placeholderParity.ok &&
      placeholderParity.mismatches.some((m) => m.field === 'canonicalHash'),
  )

  // pin match path (including authority hash)
  const goodRuntime = {
    ok: true,
    httpStatus: 200,
    canonicalSnapshotId: authPin.canonicalSnapshotId,
    canonicalHash: authPin.canonicalHash,
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

  // 6b) resolveEntityExpectedRevFromSeed — exact 0 valid; omission fail-closed; items map
  ok(
    'entity-rev-explicit-zero-valid',
    resolveEntityExpectedRevFromSeed({ entityExpectedRev: 0 }) === 0,
  )
  ok(
    'entity-rev-nonzero-preserved',
    resolveEntityExpectedRevFromSeed({ expectedEntityRev: 4 }) === 4,
  )
  ok(
    'entity-rev-from-dispatch-item',
    resolveEntityExpectedRevFromSeed({
      items: [{ expectedEntityRev: 0, taskId: 'task-next-1' }],
    }) === 0,
  )
  let missingRevThrew = false
  try {
    resolveEntityExpectedRevFromSeed({ planId: 'x', items: [{ taskId: 't' }] })
  } catch (e) {
    missingRevThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_ENTITY_EXPECTED_REV'
  }
  ok('entity-rev-missing-fail-closed', missingRevThrew)
  let missingAccountRevThrew = false
  try {
    resolveEntityExpectedRevFromSeed({ sourceRevision: 7 }, { allowItems: false, label: 'account' })
  } catch (e) {
    missingAccountRevThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_ENTITY_EXPECTED_REV'
  }
  ok('account-entity-rev-missing-fail-closed', missingAccountRevThrew)

  // 6c) Full mutation envelope matrix — required fields, zero preserve, rejects
  // Product MUTATION_ENVELOPE_REQUIRED: entityExpectedRev, expectedBoardRev,
  // canonicalHash|subjectHash, idempotencyKey (+ sourceRevision on sync_accounts).
  ok(
    'hash-from-seed-canonical',
    resolveSubjectHashFromSeed({ canonicalHash: authPin.canonicalHash }, null) ===
      authPin.canonicalHash,
  )
  ok(
    'hash-from-seed-subject-alias',
    resolveSubjectHashFromSeed({ subjectHash: authPin.canonicalHash }, null) ===
      authPin.canonicalHash,
  )
  ok(
    'hash-from-pin-fallback',
    resolveSubjectHashFromSeed({}, authPin) === authPin.canonicalHash,
  )
  let missingHashThrew = false
  try {
    resolveSubjectHashFromSeed({ entityExpectedRev: 0 }, { boardRev: 7 })
  } catch (e) {
    missingHashThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_SUBJECT_HASH'
  }
  ok('hash-missing-fail-closed', missingHashThrew)
  let placeholderHashThrew = false
  try {
    resolveSubjectHashFromSeed(
      { canonicalHash: FORBIDDEN_PLACEHOLDER_CANONICAL_HASH },
      { canonicalHash: FORBIDDEN_PLACEHOLDER_CANONICAL_HASH },
    )
  } catch (e) {
    placeholderHashThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_SUBJECT_HASH'
  }
  ok('hash-placeholder-rejected', placeholderHashThrew)

  ok(
    'board-rev-explicit-zero-valid',
    resolveExpectedBoardRevFromSeed({ expectedBoardRev: 0 }) === 0,
  )
  ok(
    'board-rev-nonzero-preserved',
    resolveExpectedBoardRevFromSeed({ expectedBoardRev: 8 }) === 8,
  )
  ok(
    'board-rev-override-post-publish',
    resolveExpectedBoardRevFromSeed({ expectedBoardRev: 7 }, { override: 8 }) === 8,
  )
  let missingBoardRevThrew = false
  try {
    resolveExpectedBoardRevFromSeed({ entityExpectedRev: 0 })
  } catch (e) {
    missingBoardRevThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_EXPECTED_BOARD_REV'
  }
  ok('board-rev-missing-fail-closed', missingBoardRevThrew)

  ok(
    'idempotency-key-required',
    resolveIdempotencyKeyFromSeed({ idempotencyKey: 'idem-x' }) === 'idem-x',
  )
  let missingIdemThrew = false
  try {
    resolveIdempotencyKeyFromSeed({ entityExpectedRev: 0 })
  } catch (e) {
    missingIdemThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_IDEMPOTENCY_KEY'
  }
  ok('idempotency-missing-fail-closed', missingIdemThrew)

  ok(
    'source-revision-zero-preserved',
    resolveSourceRevisionFromSeed({ sourceRevision: 0 }) === 0,
  )
  ok(
    'source-revision-nonzero-preserved',
    resolveSourceRevisionFromSeed({ sourceRevision: 7 }) === 7,
  )
  let missingSrcRevThrew = false
  try {
    resolveSourceRevisionFromSeed({})
  } catch (e) {
    missingSrcRevThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_SOURCE_REVISION'
  }
  ok('source-revision-missing-fail-closed', missingSrcRevThrew)

  // Full envelope builder — zeros + hashes + keys
  const env0 = buildMutationEnvelopeFromSeed(
    {
      entityExpectedRev: 0,
      expectedBoardRev: 0,
      canonicalHash: authPin.canonicalHash,
      idempotencyKey: 'idem-env-0',
    },
    { label: 'env0' },
  )
  ok(
    'envelope-zero-revs-preserved',
    env0.entityExpectedRev === 0 &&
      env0.expectedEntityRev === 0 &&
      env0.expectedBoardRev === 0 &&
      env0.canonicalHash === authPin.canonicalHash &&
      env0.subjectHash === authPin.canonicalHash &&
      env0.idempotencyKey === 'idem-env-0',
    JSON.stringify(env0),
  )
  let envelopeMissingHashThrew = false
  try {
    buildMutationEnvelopeFromSeed(
      {
        entityExpectedRev: 0,
        expectedBoardRev: 7,
        idempotencyKey: 'idem-no-hash',
      },
      { label: 'no-hash', pin: null },
    )
  } catch (e) {
    envelopeMissingHashThrew =
      e instanceof ControlPlaneBootstrapError && e.code === 'MISSING_SUBJECT_HASH'
  }
  ok('envelope-missing-hash-fail-closed', envelopeMissingHashThrew)

  // Fixture seed wires explicit 0 at top-level + items + authority hashes
  const seedDispatch = buildDispatchPlanSeed('2026-07-13T00:00:00.000Z', authPin)
  const seedAccount = buildAccountSyncSeed('2026-07-13T00:00:00.000Z', authPin)
  ok(
    'fixture-dispatch-entityExpectedRev-zero',
    seedDispatch.entityExpectedRev === 0 &&
      seedDispatch.items?.[0]?.expectedEntityRev === 0 &&
      resolveEntityExpectedRevFromSeed(seedDispatch) === 0,
  )
  ok(
    'fixture-account-entityExpectedRev-zero',
    seedAccount.entityExpectedRev === 0 &&
      resolveEntityExpectedRevFromSeed(seedAccount, { allowItems: false }) === 0,
  )
  ok(
    'fixture-dispatch-authority-hash',
    seedDispatch.canonicalHash === authPin.canonicalHash &&
      seedDispatch.subjectHash === authPin.canonicalHash,
    String(seedDispatch.canonicalHash)?.slice(0, 16),
  )
  ok(
    'fixture-account-authority-hash',
    seedAccount.canonicalHash === authPin.canonicalHash &&
      seedAccount.subjectHash === authPin.canonicalHash,
    String(seedAccount.canonicalHash)?.slice(0, 16),
  )
  ok(
    'fixture-account-sourceRevision-exact',
    seedAccount.sourceRevision === authPin.boardRev,
    String(seedAccount.sourceRevision),
  )
  const dispatchEnv = buildMutationEnvelopeFromSeed(seedDispatch, {
    label: 'dispatchSeed',
    pin: authPin,
    allowItems: true,
  })
  const accountEnv = buildMutationEnvelopeFromSeed(seedAccount, {
    label: 'accountSyncSeed',
    pin: authPin,
    allowItems: false,
    expectedBoardRevOverride: authPin.boardRev + 1,
  })
  ok(
    'fixture-dispatch-envelope-complete',
    dispatchEnv.entityExpectedRev === 0 &&
      dispatchEnv.expectedBoardRev === authPin.boardRev &&
      dispatchEnv.canonicalHash === authPin.canonicalHash &&
      typeof dispatchEnv.idempotencyKey === 'string' &&
      dispatchEnv.idempotencyKey.length > 0,
  )
  ok(
    'fixture-account-envelope-post-publish-boardRev',
    accountEnv.entityExpectedRev === 0 &&
      accountEnv.expectedBoardRev === authPin.boardRev + 1 &&
      accountEnv.subjectHash === authPin.canonicalHash,
    JSON.stringify({
      entityExpectedRev: accountEnv.entityExpectedRev,
      expectedBoardRev: accountEnv.expectedBoardRev,
    }),
  )

  // 7) successful sanitized shape (mock full happy path)
  const calls = []
  const capturedPublishArgs = []
  const capturedSyncArgs = []
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
      const args = body.params?.arguments ?? {}
      capturedPublishArgs.push(args)
      // Fail mock if top-level entityExpectedRev omitted (product rejects)
      if (
        typeof args.entityExpectedRev !== 'number' &&
        typeof args.expectedEntityRev !== 'number'
      ) {
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
                      code: 'INVALID_INPUT',
                      message:
                        'entityExpectedRev (or expectedEntityRev/expectedRev) is required — no silent default',
                    }),
                  },
                ],
              },
            }),
        }
      }
      // Product parseMutationEnvelope: canonicalHash|subjectHash required
      const pubHash =
        (typeof args.canonicalHash === 'string' && args.canonicalHash.trim()) ||
        (typeof args.subjectHash === 'string' && args.subjectHash.trim()) ||
        ''
      if (!pubHash) {
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
                      code: 'INVALID_INPUT',
                      message:
                        'canonicalHash or subjectHash is required (current subject/canonical hash)',
                    }),
                  },
                ],
              },
            }),
        }
      }
      if (typeof args.expectedBoardRev !== 'number' || !args.idempotencyKey) {
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
                      code: 'INVALID_INPUT',
                      message: 'expectedBoardRev and idempotencyKey required',
                    }),
                  },
                ],
              },
            }),
        }
      }
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
      // or omits required envelope hash / sourceRevision (product rejects).
      const args = body.params?.arguments ?? {}
      capturedSyncArgs.push(args)
      if (
        typeof args.entityExpectedRev !== 'number' &&
        typeof args.expectedEntityRev !== 'number'
      ) {
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
                      code: 'INVALID_INPUT',
                      message:
                        'entityExpectedRev (or expectedEntityRev/expectedRev) is required — no silent default',
                    }),
                  },
                ],
              },
            }),
        }
      }
      const syncHash =
        (typeof args.canonicalHash === 'string' && args.canonicalHash.trim()) ||
        (typeof args.subjectHash === 'string' && args.subjectHash.trim()) ||
        ''
      if (!syncHash) {
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
                      code: 'INVALID_INPUT',
                      message:
                        'canonicalHash or subjectHash is required (current subject/canonical hash)',
                    }),
                  },
                ],
              },
            }),
        }
      }
      if (syncHash !== authPin.canonicalHash) {
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
                      code: 'STALE_REVISION',
                      message: `subject hash mismatch: expected ${syncHash}, current ${authPin.canonicalHash}`,
                      details: {
                        expectedSubjectHash: syncHash,
                        currentSubjectHash: authPin.canonicalHash,
                      },
                    }),
                  },
                ],
              },
            }),
        }
      }
      if (typeof args.sourceRevision !== 'number' || !Number.isInteger(args.sourceRevision)) {
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
                      code: 'INVALID_INPUT',
                      message: 'sourceRevision must be non-negative integer',
                    }),
                  },
                ],
              },
            }),
        }
      }
      if (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim()) {
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
                      code: 'INVALID_INPUT',
                      message: 'idempotencyKey is required',
                    }),
                  },
                ],
              },
            }),
        }
      }
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
    'happy-publish-entityExpectedRev-zero',
    capturedPublishArgs[0]?.entityExpectedRev === 0 &&
      capturedPublishArgs[0]?.expectedEntityRev === 0,
    JSON.stringify(capturedPublishArgs[0] && {
      entityExpectedRev: capturedPublishArgs[0].entityExpectedRev,
      expectedEntityRev: capturedPublishArgs[0].expectedEntityRev,
    }),
  )
  ok(
    'happy-publish-full-envelope',
    capturedPublishArgs[0]?.entityExpectedRev === 0 &&
      Number(capturedPublishArgs[0]?.expectedBoardRev) === Number(authPin.boardRev) &&
      capturedPublishArgs[0]?.canonicalHash === authPin.canonicalHash &&
      capturedPublishArgs[0]?.subjectHash === authPin.canonicalHash &&
      typeof capturedPublishArgs[0]?.idempotencyKey === 'string' &&
      capturedPublishArgs[0].idempotencyKey.length > 0,
    JSON.stringify({
      entityExpectedRev: capturedPublishArgs[0]?.entityExpectedRev,
      expectedBoardRev: capturedPublishArgs[0]?.expectedBoardRev,
      hash: String(capturedPublishArgs[0]?.canonicalHash ?? '').slice(0, 16),
      idem: capturedPublishArgs[0]?.idempotencyKey ?? null,
    }),
  )
  ok(
    'happy-sync-entityExpectedRev-zero',
    capturedSyncArgs[0]?.entityExpectedRev === 0,
    String(capturedSyncArgs[0]?.entityExpectedRev),
  )
  ok(
    'happy-sync-full-envelope-post-publish',
    capturedSyncArgs[0]?.entityExpectedRev === 0 &&
      Number(capturedSyncArgs[0]?.expectedBoardRev) === Number(authPin.boardRev) + 1 &&
      capturedSyncArgs[0]?.canonicalHash === authPin.canonicalHash &&
      capturedSyncArgs[0]?.subjectHash === authPin.canonicalHash &&
      Number(capturedSyncArgs[0]?.sourceRevision) === Number(authPin.boardRev) &&
      typeof capturedSyncArgs[0]?.idempotencyKey === 'string' &&
      capturedSyncArgs[0].idempotencyKey.length > 0,
    JSON.stringify({
      entityExpectedRev: capturedSyncArgs[0]?.entityExpectedRev,
      expectedBoardRev: capturedSyncArgs[0]?.expectedBoardRev,
      sourceRevision: capturedSyncArgs[0]?.sourceRevision,
      hash: String(capturedSyncArgs[0]?.canonicalHash ?? '').slice(0, 16),
    }),
  )
  ok(
    'happy-receipt-envelope-fields',
    happy.dispatchEntityExpectedRev === 0 &&
      happy.syncEntityExpectedRev === 0 &&
      happy.syncExpectedBoardRev === authPin.boardRev + 1 &&
      happy.syncSubjectHash === authPin.canonicalHash &&
      happy.syncSourceRevision === authPin.boardRev,
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

  // 7b) dispatch seed that only has item expectedEntityRev (no top-level) still maps
  const itemOnlyDispatch = {
    ...seedDispatch,
    entityExpectedRev: undefined,
    expectedEntityRev: undefined,
    expectedRev: undefined,
  }
  // remove top-level if still present from spread
  delete itemOnlyDispatch.entityExpectedRev
  delete itemOnlyDispatch.expectedEntityRev
  delete itemOnlyDispatch.expectedRev
  const itemOnlyCalls = []
  const itemOnlyFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'tools/call' && body.params?.name === 'publish_dispatch_plan') {
      itemOnlyCalls.push(body.params.arguments)
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
                    planId: seedDispatch.planId,
                    boardRev: authPin.boardRev + 1,
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'get_next') {
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
                    planId: seedDispatch.planId,
                    soleSource: 'active_dispatch_plan',
                    selectedForNextDispatch: [{ taskId: 'task-next-1', rank: 1 }],
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'sync_accounts') {
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
                  }),
                },
              ],
            },
          }),
      }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  const itemOnlyBoot = await bootstrapControlPlaneOnServer({
    baseUrl: 'http://127.0.0.1:9',
    bearer: p.bearer,
    requireBearer: true,
    failClosed: true,
    skipPinCheck: true,
    initialize: false,
    fetchImpl: itemOnlyFetch,
    pin: authPin,
    dispatchSeed: itemOnlyDispatch,
    accountSyncSeed: seedAccount,
    now: '2026-07-13T00:00:00.000Z',
  })
  ok(
    'item-only-expectedEntityRev-mapped-to-envelope',
    itemOnlyBoot.ok === true &&
      itemOnlyCalls[0]?.entityExpectedRev === 0 &&
      itemOnlyBoot.dispatchEntityExpectedRev === 0,
    JSON.stringify(itemOnlyCalls[0] && { entityExpectedRev: itemOnlyCalls[0].entityExpectedRev }),
  )

  // 7c) missing entityExpectedRev fail-closed before MCP invents nothing
  let omitRevThrew = false
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: p.bearer,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      fetchImpl: async () => {
        throw new Error('network should not be reached')
      },
      pin: authPin,
      dispatchSeed: {
        planId: 'x',
        planVersion: 1,
        planHash: 'a'.repeat(64),
        canonicalSnapshotId: authPin.canonicalSnapshotId,
        canonicalHash: authPin.canonicalHash,
        expectedBoardRev: authPin.boardRev,
        issuedAt: '2026-07-13T00:00:00.000Z',
        expiresAt: '2026-07-13T06:00:00.000Z',
        items: [{ rank: 1, taskId: 'task-next-1' }],
        idempotencyKey: 'idem-omit-rev',
      },
      accountSyncSeed: seedAccount,
    })
  } catch (e) {
    omitRevThrew =
      e instanceof ControlPlaneBootstrapError &&
      (e.code === 'CONTROL_PLANE_BOOTSTRAP_FAIL' || e.code === 'MISSING_ENTITY_EXPECTED_REV') &&
      /entityExpectedRev/i.test(String(e.message))
  }
  ok('missing-entityExpectedRev-no-network-fail-closed', omitRevThrew)

  // 7d) missing subject/canonical hash on account seed + blank pin → fail-closed
  // before sync_accounts network (publish may still run with seedDispatch hash).
  let omitHashThrew = false
  let syncNetworkReached = false
  const omitHashFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'tools/call' && body.params?.name === 'sync_accounts') {
      syncNetworkReached = true
      throw new Error('sync network should not be reached when hash omitted')
    }
    if (body.method === 'tools/call' && body.params?.name === 'publish_dispatch_plan') {
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
                    planId: seedDispatch.planId,
                    boardRev: authPin.boardRev + 1,
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'get_next') {
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
                    planId: seedDispatch.planId,
                    soleSource: 'active_dispatch_plan',
                    selectedForNextDispatch: [{ taskId: 'task-next-1', rank: 1 }],
                  }),
                },
              ],
            },
          }),
      }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: p.bearer,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      fetchImpl: omitHashFetch,
      // blank pin so pin fallback cannot supply hash for account sync
      pin: { ...authPin, canonicalHash: null, subjectHash: null },
      dispatchSeed: seedDispatch,
      accountSyncSeed: {
        sourceRevision: 0,
        entityExpectedRev: 0,
        expectedBoardRev: 0,
        generatedAt: '2026-07-13T00:00:00.000Z',
        accounts: seedAccount.accounts,
        idempotencyKey: 'idem-omit-hash',
        // intentionally omit canonicalHash/subjectHash
      },
    })
  } catch (e) {
    omitHashThrew =
      e instanceof ControlPlaneBootstrapError &&
      (e.code === 'MISSING_SUBJECT_HASH' ||
        e.code === 'CONTROL_PLANE_BOOTSTRAP_FAIL') &&
      /canonicalHash|subjectHash/i.test(String(e.message))
  }
  ok(
    'missing-subjectHash-no-network-fail-closed',
    omitHashThrew && !syncNetworkReached,
    `threw=${omitHashThrew} syncNet=${syncNetworkReached}`,
  )

  // 7e) account seed without hash but pin provides fallback — still must fail if pin also blank
  // (already covered). Pin fallback path: account seed omits hash, pin has hash → wire ok via mock.
  const pinFallbackSyncCalls = []
  const pinFallbackFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'tools/call' && body.params?.name === 'publish_dispatch_plan') {
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
                    planId: seedDispatch.planId,
                    boardRev: authPin.boardRev + 1,
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'get_next') {
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
                    planId: seedDispatch.planId,
                    soleSource: 'active_dispatch_plan',
                    selectedForNextDispatch: [{ taskId: 'task-next-1', rank: 1 }],
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'sync_accounts') {
      pinFallbackSyncCalls.push(body.params.arguments)
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
                    sourceRevision: 0,
                    generatedAt: '2026-07-13T00:00:00.000Z',
                    acceptedCount: 2,
                  }),
                },
              ],
            },
          }),
      }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  const pinFallbackBoot = await bootstrapControlPlaneOnServer({
    baseUrl: 'http://127.0.0.1:9',
    bearer: p.bearer,
    requireBearer: true,
    failClosed: true,
    skipPinCheck: true,
    initialize: false,
    fetchImpl: pinFallbackFetch,
    pin: authPin,
    dispatchSeed: seedDispatch,
    accountSyncSeed: {
      sourceRevision: 0,
      entityExpectedRev: 0,
      expectedBoardRev: authPin.boardRev,
      generatedAt: '2026-07-13T00:00:00.000Z',
      accounts: seedAccount.accounts,
      idempotencyKey: 'idem-pin-fallback-hash',
      // omit hash — pin must supply
    },
    now: '2026-07-13T00:00:00.000Z',
  })
  ok(
    'pin-fallback-hash-on-sync-wire',
    pinFallbackBoot.ok === true &&
      pinFallbackSyncCalls[0]?.canonicalHash === authPin.canonicalHash &&
      pinFallbackSyncCalls[0]?.subjectHash === authPin.canonicalHash &&
      pinFallbackSyncCalls[0]?.sourceRevision === 0 &&
      pinFallbackSyncCalls[0]?.entityExpectedRev === 0 &&
      Number(pinFallbackSyncCalls[0]?.expectedBoardRev) === authPin.boardRev + 1,
    JSON.stringify(pinFallbackSyncCalls[0] && {
      hash: String(pinFallbackSyncCalls[0].canonicalHash ?? '').slice(0, 16),
      sourceRevision: pinFallbackSyncCalls[0].sourceRevision,
      expectedBoardRev: pinFallbackSyncCalls[0].expectedBoardRev,
      entityExpectedRev: pinFallbackSyncCalls[0].entityExpectedRev,
    }),
  )

  // 7f) stale board rev / hash mismatch on wire → product-shaped reject fail-closed
  let staleBoardThrew = false
  const staleBoardFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'tools/call' && body.params?.name === 'publish_dispatch_plan') {
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
                    planId: seedDispatch.planId,
                    // Deliberately return same boardRev (no bump) so if harness
                    // used seed expectedBoardRev it might pass — we force mismatch
                    // by returning boardRev that differs from seed AND from override path.
                    boardRev: authPin.boardRev + 99,
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'get_next') {
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
                    planId: seedDispatch.planId,
                    soleSource: 'active_dispatch_plan',
                    selectedForNextDispatch: [{ taskId: 'task-next-1', rank: 1 }],
                  }),
                },
              ],
            },
          }),
      }
    }
    if (body.method === 'tools/call' && body.params?.name === 'sync_accounts') {
      const args = body.params.arguments ?? {}
      // Simulate product STALE_REVISION if expectedBoardRev is wrong relative to
      // a "current" board of authPin.boardRev+1 (harness will send +99 from publish).
      if (Number(args.expectedBoardRev) !== authPin.boardRev + 1) {
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
                      code: 'STALE_REVISION',
                      error: 'board rev mismatch',
                      details: {
                        expectedBoardRev: args.expectedBoardRev,
                        currentBoardRev: authPin.boardRev + 1,
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
                  text: JSON.stringify({ ok: true, sourceRevision: authPin.boardRev }),
                },
              ],
            },
          }),
      }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: p.bearer,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      fetchImpl: staleBoardFetch,
      pin: authPin,
      dispatchSeed: seedDispatch,
      accountSyncSeed: seedAccount,
    })
  } catch (e) {
    staleBoardThrew =
      e instanceof ControlPlaneBootstrapError &&
      /STALE_REVISION|board rev mismatch|sync_accounts/i.test(String(e.message))
  }
  ok('stale-boardRev-after-publish-reject', staleBoardThrew)

  // Hash mismatch: seed/pin hash wrong vs product current → STALE_REVISION
  let hashMismatchThrew = false
  const wrongHash = 'a'.repeat(64)
  const hashMismatchFetch = async (_url, init) => {
    const body = JSON.parse(init.body)
    if (body.method === 'tools/call' && body.params?.name === 'publish_dispatch_plan') {
      const args = body.params.arguments ?? {}
      const h =
        (typeof args.canonicalHash === 'string' && args.canonicalHash.trim()) ||
        (typeof args.subjectHash === 'string' && args.subjectHash.trim()) ||
        ''
      if (h && h !== authPin.canonicalHash) {
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
                      code: 'STALE_REVISION',
                      message: `subject hash mismatch: expected ${h}, current ${authPin.canonicalHash}`,
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
                    planId: seedDispatch.planId,
                    boardRev: authPin.boardRev + 1,
                  }),
                },
              ],
            },
          }),
      }
    }
    return { ok: true, status: 200, text: async () => '' }
  }
  try {
    await bootstrapControlPlaneOnServer({
      baseUrl: 'http://127.0.0.1:9',
      bearer: p.bearer,
      failClosed: true,
      skipPinCheck: true,
      initialize: false,
      fetchImpl: hashMismatchFetch,
      pin: { ...authPin, canonicalHash: wrongHash, subjectHash: wrongHash },
      dispatchSeed: {
        ...seedDispatch,
        canonicalHash: wrongHash,
        subjectHash: wrongHash,
      },
      accountSyncSeed: seedAccount,
    })
  } catch (e) {
    hashMismatchThrew =
      e instanceof ControlPlaneBootstrapError &&
      /STALE_REVISION|subject hash mismatch|publish_dispatch_plan/i.test(String(e.message))
  }
  ok('stale-hash-mismatch-reject', hashMismatchThrew)

  // Bootstrap does NOT call register_run / heartbeat_run (audit: N/A for this path)
  ok(
    'bootstrap-no-register-heartbeat-tools',
    !calls.includes('register_run') && !calls.includes('heartbeat_run'),
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
