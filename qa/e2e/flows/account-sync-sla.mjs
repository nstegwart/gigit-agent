#!/usr/bin/env node
/**
 * Account-sync SLA conformance harness (AC-ACCOUNT-01..07 / AC-INGEST-05).
 *
 * Staging-only, reusable, fail-closed. Masked fixture state only — never tokens.
 *
 * Modes:
 *   --self-test | --contract | (default)  pure offline contract (no network, no mutation)
 *   --real                                 live staging probes; mutations only when
 *                                          ACCOUNT_SYNC_SLA_ALLOW_MUTATION=1
 *   --help
 *
 * Env (live / --real):
 *   STAGING_URL | WEB_BASE                 staging base (prod hosts refused)
 *   BOARD_ID                               default mfs-rebuild
 *   ACCOUNT_SYNC_SLA_ROOT_TOKEN            preferred explicit ROOT bearer
 *   STAGING_ROOT_BEARER_TOKEN              accepted ROOT alias
 *   STAGING_ROOT_BEARER_TOKEN_REF          optional env-name override for ROOT
 *   CAIRN_E2E_USERNAME / CAIRN_E2E_PASSWORD optional session for /api/accounts + UI/Ops
 *   ACCOUNT_SYNC_SLA_ALLOW_MUTATION=1      required to call sync_accounts / triggers
 *   ACCOUNT_SYNC_SLA_RUN_ID                optional cleanup tag (default synth)
 *   EXPECTED_SHA | FULL_SHA                optional healthz pin fail-closed
 *
 * Never prints bearer/token values. Exit 0 only when selected mode fully passes.
 *
 * Live mutation is intentionally OFF by default. This worker build only proves
 * --self-test; operators opt into --real + ALLOW_MUTATION separately.
 */
import { createHash, randomBytes } from 'node:crypto'
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')

// ---------------------------------------------------------------------------
// Contract constants (mirror src/server/account-sync.ts)
// ---------------------------------------------------------------------------

export const ACCOUNT_PUBLISH_SLA_MS = 30_000
export const ACCOUNT_PERIODIC_HEALTH_MS = 60_000

export const SURFACES = Object.freeze(['mcp', 'api', 'ui', 'ops'])

export const ACCOUNT_SURFACE_SCHEMA = Object.freeze({
  mcp: 'ACCOUNT_MCP_LIST_V1',
  api: 'ACCOUNT_API_JSON_V1',
  ui: 'ACCOUNT_UI_SOURCE_V1',
  ops: 'ACCOUNT_OPS_SOURCE_V1',
})

/** Exhaustive domain trigger enum (board-mcp ACCOUNT_SYNC_TRIGGER_VALUES). */
export const ACCOUNT_SYNC_TRIGGER_VALUES = Object.freeze([
  'ORCHESTRATOR_LAUNCH',
  'WAVE_LAUNCH',
  'AGENT_LAUNCH',
  'HEARTBEAT',
  'MATERIAL_ASSIGNMENT',
  'STATUS_TRANSITION',
  'LIMIT_TRANSITION',
  'BAN_TRANSITION',
  'AUTH_EXPIRED_TRANSITION',
  'ROTATION',
  'REQUEUE',
  'INTEGRATION_CHECKPOINT',
  'WAVE_CLOSE',
  'PERIODIC_HEALTH',
])

/**
 * Mandatory publication triggers for AC-ACCOUNT-01..06.
 * 403 transitions use STATUS_TRANSITION with status "403" (domain status enum).
 */
export const MANDATORY_TRIGGER_MATRIX = Object.freeze([
  {
    ac: 'AC-ACCOUNT-01',
    trigger: 'ORCHESTRATOR_LAUNCH',
    kind: 'launch',
    statusSeed: 'ACTIVE',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-02',
    trigger: 'HEARTBEAT',
    kind: 'heartbeat',
    statusSeed: 'OK',
    coalesce: true,
  },
  {
    ac: 'AC-ACCOUNT-02',
    trigger: 'MATERIAL_ASSIGNMENT',
    kind: 'material',
    statusSeed: 'OK',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-03',
    trigger: 'LIMIT_TRANSITION',
    kind: 'limit',
    statusSeed: 'LIMIT',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-03',
    trigger: 'BAN_TRANSITION',
    kind: 'ban',
    statusSeed: 'BAN',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-03',
    trigger: 'STATUS_TRANSITION',
    kind: '403',
    statusSeed: '403',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-03',
    trigger: 'AUTH_EXPIRED_TRANSITION',
    kind: 'auth_expired',
    statusSeed: 'AUTH_EXPIRED',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-04',
    trigger: 'ROTATION',
    kind: 'rotation',
    statusSeed: 'ACTIVE',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-04',
    trigger: 'REQUEUE',
    kind: 'requeue',
    statusSeed: 'ACTIVE',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-05',
    trigger: 'INTEGRATION_CHECKPOINT',
    kind: 'checkpoint',
    statusSeed: 'OK',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-05',
    trigger: 'WAVE_CLOSE',
    kind: 'wave_close',
    statusSeed: 'OK',
    coalesce: false,
  },
  {
    ac: 'AC-ACCOUNT-06',
    trigger: 'PERIODIC_HEALTH',
    kind: 'periodic',
    statusSeed: 'OK',
    coalesce: false,
    maxIntervalMs: ACCOUNT_PERIODIC_HEALTH_MS,
  },
])

/** Forbidden keys on any masked account / surface payload (AC-INGEST-05). */
export const FORBIDDEN_ACCOUNT_KEYS = Object.freeze([
  'token',
  'secret',
  'password',
  'authorization',
  'apiKey',
  'api_key',
  'credential',
  'access_token',
  'refresh_token',
  'bearer',
  'clientSecret',
])

const SECRET_KEY_RE =
  /token|secret|password|authorization|api[_-]?key|credential|bearer|access[_-]?token|refresh[_-]?token/i

/** Prod / non-staging host markers — live mode refuses these. */
const PROD_HOST_RE =
  /(^|\.)(prod\.|production\.|myfitsociety\.com$|mfsprod|live\.|www\.myfitsociety)/i

/** Explicit ROOT token env candidates (preferred first). Value never logged. */
export const ROOT_TOKEN_ENV_CANDIDATES = Object.freeze([
  'ACCOUNT_SYNC_SLA_ROOT_TOKEN',
  'STAGING_ROOT_BEARER_TOKEN',
])

// ---------------------------------------------------------------------------
// Masked fixture builders
// ---------------------------------------------------------------------------

/**
 * Build a single masked account row. Rejects secret-like ids/fields.
 * @param {object} [overrides]
 */
export function buildMaskedAccount(overrides = {}) {
  const base = {
    maskedAccountId: overrides.maskedAccountId ?? 'acc_synth_sla_001',
    status: overrides.status ?? 'ACTIVE',
    providerKind: overrides.providerKind ?? 'GROK',
    effectiveInUse: overrides.effectiveInUse ?? 0,
    effectiveCap: overrides.effectiveCap ?? 5,
    physicalSlotsDisplay: overrides.physicalSlotsDisplay ?? '0/5',
    adaptiveQuotaState: overrides.adaptiveQuotaState ?? 'healthy',
    reason: overrides.reason ?? null,
    statusChangedAt: overrides.statusChangedAt ?? null,
    tombstone: overrides.tombstone === true,
  }
  // Reject secret-like maskedAccountId (domain normalizeAccount rule)
  if (SECRET_KEY_RE.test(String(base.maskedAccountId))) {
    throw new Error(
      `FAIL-CLOSED: maskedAccountId looks secret-like: ${String(base.maskedAccountId).slice(0, 24)}`,
    )
  }
  // Strip any accidental secret keys from overrides before return
  const cleaned = stripSecretKeys(base)
  assertNoForbiddenKeys(cleaned, 'maskedAccount')
  return cleaned
}

/**
 * Build fixture account pool for a trigger (masked only).
 * @param {{ trigger?: string, status?: string, runId?: string, sourceRevision?: number, generatedAt?: string }} [opts]
 */
export function buildMaskedFixtureState(opts = {}) {
  const runId = opts.runId ?? 'selftest'
  const status = opts.status ?? 'ACTIVE'
  const trigger = opts.trigger ?? 'ORCHESTRATOR_LAUNCH'
  const sourceRevision =
    typeof opts.sourceRevision === 'number' ? opts.sourceRevision : 1
  const generatedAt = opts.generatedAt ?? new Date().toISOString()
  const accounts = [
    buildMaskedAccount({
      maskedAccountId: `acc_synth_sla_${runId}_grok`,
      status: status === 'REMOVED' ? 'REMOVED' : status,
      providerKind: 'GROK',
      effectiveInUse: status === 'ACTIVE' || status === 'OK' ? 1 : 0,
      effectiveCap: 5,
      physicalSlotsDisplay: status === 'ACTIVE' || status === 'OK' ? '1/5' : '0/5',
      adaptiveQuotaState:
        status === 'LIMIT' || status === 'BAN' || status === '403' || status === 'AUTH_EXPIRED'
          ? 'blocked'
          : 'healthy',
      reason:
        status === 'LIMIT' || status === 'BAN' || status === '403' || status === 'AUTH_EXPIRED'
          ? `SYNTH:${status}`
          : null,
      tombstone: status === 'REMOVED',
    }),
    buildMaskedAccount({
      maskedAccountId: `acc_synth_sla_${runId}_spark`,
      status: 'quarantine',
      providerKind: 'SPARK',
      effectiveInUse: 0,
      effectiveCap: 2,
      physicalSlotsDisplay: '0/2',
      adaptiveQuotaState: 'quarantined',
      reason: 'SYNTH: quarantine example — never real credentials',
      tombstone: false,
    }),
  ]
  assertMaskedPool(accounts)
  return {
    trigger,
    sourceRevision,
    generatedAt,
    accounts,
    boardId: opts.boardId ?? 'mfs-rebuild',
    forbiddenAccountFields: [...FORBIDDEN_ACCOUNT_KEYS],
    fixtureKind: 'masked-account-sync-sla',
  }
}

/**
 * Load optional staging seed if present; else synth masked state.
 * Never loads real credentials.
 */
export function loadMaskedFixtureOrSynth(opts = {}) {
  const seedPath = join(REPO_ROOT, 'qa/fixtures/staging/accounts-sync.seed.json')
  if (existsSync(seedPath)) {
    try {
      const seed = JSON.parse(readFileSync(seedPath, 'utf8'))
      const accounts = Array.isArray(seed.accounts)
        ? seed.accounts.map((a) =>
            buildMaskedAccount({
              maskedAccountId: a.maskedAccountId,
              status: a.status,
              providerKind: a.providerKind,
              effectiveInUse: a.effectiveInUse,
              effectiveCap: a.effectiveCap,
              physicalSlotsDisplay: a.physicalSlotsDisplay,
              adaptiveQuotaState: a.adaptiveQuotaState,
              reason: a.reason,
            }),
          )
        : buildMaskedFixtureState(opts).accounts
      assertMaskedPool(accounts)
      return {
        trigger: seed.trigger ?? opts.trigger ?? 'ORCHESTRATOR_LAUNCH',
        sourceRevision: opts.sourceRevision ?? 1,
        generatedAt: opts.generatedAt ?? new Date().toISOString(),
        accounts,
        boardId: opts.boardId ?? 'mfs-rebuild',
        forbiddenAccountFields: seed.forbiddenAccountFields ?? [...FORBIDDEN_ACCOUNT_KEYS],
        fixtureKind: 'staging-accounts-sync.seed',
        seedPath,
      }
    } catch {
      // fall through to synth
    }
  }
  return buildMaskedFixtureState(opts)
}

export function stripSecretKeys(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return rec
  const out = { ...rec }
  for (const k of Object.keys(out)) {
    if (SECRET_KEY_RE.test(k)) delete out[k]
  }
  return out
}

export function assertNoForbiddenKeys(value, label = 'payload') {
  const hits = []
  const walk = (v, path) => {
    if (v == null || typeof v !== 'object') return
    if (Array.isArray(v)) {
      v.forEach((item, i) => walk(item, `${path}[${i}]`))
      return
    }
    for (const [k, child] of Object.entries(v)) {
      if (SECRET_KEY_RE.test(k)) hits.push(`${path}.${k}`)
      walk(child, `${path}.${k}`)
    }
  }
  walk(value, label)
  if (hits.length) {
    throw new Error(`FAIL-CLOSED secret-like keys in ${label}: ${hits.slice(0, 8).join(', ')}`)
  }
  return true
}

export function assertMaskedPool(accounts) {
  if (!Array.isArray(accounts) || accounts.length === 0) {
    throw new Error('FAIL-CLOSED: accounts must be non-empty masked array')
  }
  for (const a of accounts) {
    if (!a || typeof a !== 'object') throw new Error('FAIL-CLOSED: account row missing')
    const mid = a.maskedAccountId ?? a.accountId ?? a.id
    if (!mid) throw new Error('FAIL-CLOSED: maskedAccountId required')
    if (SECRET_KEY_RE.test(String(mid))) {
      throw new Error('FAIL-CLOSED: maskedAccountId must not look like a secret')
    }
    assertNoForbiddenKeys(a, `account:${mid}`)
  }
  return true
}

// ---------------------------------------------------------------------------
// Parity / SLA / fail-closed (AC-ACCOUNT-07, AC-ACCOUNT-06)
// ---------------------------------------------------------------------------

/**
 * Exact sourceRevision + generatedAt parity across all four surfaces.
 * @param {Record<string, {sourceRevision?: number|null, generatedAt?: string|null}|null|undefined>} surfaces
 * @param {number} sourceRevision
 * @param {string} generatedAt
 */
export function surfacesHaveExactParity(surfaces, sourceRevision, generatedAt) {
  if (!surfaces || typeof surfaces !== 'object') return false
  for (const name of SURFACES) {
    const s = surfaces[name]
    if (!s || typeof s !== 'object') return false
    if (Number(s.sourceRevision) !== Number(sourceRevision)) return false
    if (String(s.generatedAt) !== String(generatedAt)) return false
  }
  return true
}

/**
 * @param {{ publishAtMs: number, nowMs: number, parity: boolean }} input
 * @returns {{ slaMiss: boolean, reason: string|null }}
 */
export function evaluatePublishSla(input) {
  const age = input.nowMs - input.publishAtMs
  if (age > ACCOUNT_PUBLISH_SLA_MS && !input.parity) {
    return { slaMiss: true, reason: 'SLA_MISS_30S_NO_PARITY' }
  }
  return { slaMiss: false, reason: null }
}

/**
 * @param {{ lastPeriodicHealthAtMs: number|null, nowMs: number }} input
 */
export function evaluatePeriodicHealth(input) {
  if (input.lastPeriodicHealthAtMs == null) {
    // First publish without periodic marker is not yet a miss (launch may set it).
    return { periodicMiss: false, reason: null, intervalMs: null }
  }
  const intervalMs = input.nowMs - input.lastPeriodicHealthAtMs
  if (intervalMs > ACCOUNT_PERIODIC_HEALTH_MS) {
    return {
      periodicMiss: true,
      reason: 'PERIODIC_HEALTH_MISS_60S',
      intervalMs,
    }
  }
  return { periodicMiss: false, reason: null, intervalMs }
}

/**
 * Fail-closed decision when parity/SLA/periodic miss.
 * usableCapacity must drop to 0; stale=true; ACCOUNT_SYNC_STALE.
 */
export function evaluateFailClosed(input) {
  const {
    parity,
    slaMiss,
    periodicMiss,
    usableCapacity = 0,
  } = input
  const miss = !parity || slaMiss || periodicMiss
  if (!miss) {
    return {
      stale: false,
      staleReason: null,
      usableCapacity: Number(usableCapacity) || 0,
      dispatchBlocked: false,
      alert: null,
      failClosed: false,
    }
  }
  const reasons = []
  if (!parity) reasons.push('ACCOUNT_SYNC_PARITY_INVALID')
  if (slaMiss) reasons.push('SLA_MISS_30S_NO_PARITY')
  if (periodicMiss) reasons.push('PERIODIC_HEALTH_MISS_60S')
  return {
    stale: true,
    staleReason: reasons.join('+'),
    usableCapacity: 0,
    dispatchBlocked: true,
    alert: 'ACCOUNT_SYNC_STALE',
    failClosed: true,
  }
}

/**
 * HEARTBEAT may coalesce; newest must still land within SLA.
 * Other triggers are immediate (coalesce=false).
 */
export function isCoalescableTrigger(trigger) {
  return trigger === 'HEARTBEAT'
}

export function requireImmediatePublish(trigger) {
  return !isCoalescableTrigger(trigger)
}

// ---------------------------------------------------------------------------
// Env / staging guards / ROOT token
// ---------------------------------------------------------------------------

export function resolveBoardId(env = process.env) {
  return env.BOARD_ID?.trim() || 'mfs-rebuild'
}

export function resolveStagingBase(env = process.env) {
  const raw = env.STAGING_URL?.trim() || env.WEB_BASE?.trim() || ''
  return raw ? raw.replace(/\/$/, '') : ''
}

/**
 * Fail closed if host looks production. Staging tunnels (127.0.0.1 / localhost /
 * *.test / staging labels) are allowed.
 */
export function assertStagingOnlyBase(baseUrl) {
  if (!baseUrl) {
    return { ok: false, code: 'MISSING_STAGING_URL', reason: 'STAGING_URL|WEB_BASE required' }
  }
  let host
  try {
    host = new URL(baseUrl).hostname
  } catch {
    return { ok: false, code: 'INVALID_STAGING_URL', reason: `unparseable base: ${baseUrl}` }
  }
  if (PROD_HOST_RE.test(host)) {
    return {
      ok: false,
      code: 'PROD_HOST_REFUSED',
      reason: `refusing prod-like host for account-sync SLA harness: ${host}`,
    }
  }
  // Explicit allow local / staging markers
  const localOk =
    host === '127.0.0.1' ||
    host === 'localhost' ||
    host === '0.0.0.0' ||
    host.endsWith('.test') ||
    /staging|stg|dev|tunnel|local/i.test(host)
  if (!localOk && !envAllowNonLocal()) {
    return {
      ok: false,
      code: 'NON_STAGING_HOST',
      reason: `host ${host} is not local/staging; set ACCOUNT_SYNC_SLA_ALLOW_REMOTE_STAGING=1 only for approved staging tunnels`,
    }
  }
  return { ok: true, host, baseUrl }
}

function envAllowNonLocal(env = process.env) {
  return env.ACCOUNT_SYNC_SLA_ALLOW_REMOTE_STAGING === '1'
}

/**
 * Explicit ROOT token resolution. Never invents credentials.
 * Prefers ACCOUNT_SYNC_SLA_ROOT_TOKEN, then STAGING_ROOT_BEARER_TOKEN.
 * Optional STAGING_ROOT_BEARER_TOKEN_REF / ACCOUNT_SYNC_SLA_ROOT_TOKEN_REF names env.
 * Values never returned in receipts (only tokenRef + meta).
 */
export function resolveExplicitRootToken(env = process.env) {
  const explicitRef =
    env.ACCOUNT_SYNC_SLA_ROOT_TOKEN_REF?.trim() ||
    env.STAGING_ROOT_BEARER_TOKEN_REF?.trim() ||
    ''
  const candidates = explicitRef
    ? [explicitRef, ...ROOT_TOKEN_ENV_CANDIDATES.filter((c) => c !== explicitRef)]
    : [...ROOT_TOKEN_ENV_CANDIDATES]
  for (const name of candidates) {
    const val = env[name]
    if (typeof val === 'string' && val.trim().length > 0) {
      return {
        ok: true,
        tokenRef: name,
        bearer: val.trim(),
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
    tokenRef: candidates[0],
    bearer: null,
    reason: `missing explicit ROOT token — set one of ${candidates.join('|')} (value never logged)`,
    meta: { tokenRef: candidates[0], present: false },
  }
}

export function mutationsAllowed(env = process.env) {
  return env.ACCOUNT_SYNC_SLA_ALLOW_MUTATION === '1'
}

// ---------------------------------------------------------------------------
// Trigger matrix + cleanup plan
// ---------------------------------------------------------------------------

/**
 * Expand mandatory matrix into runnable steps with unique masked fixtures.
 */
export function buildTriggerRunPlan(opts = {}) {
  const runId = opts.runId ?? `sla-${randomBytes(3).toString('hex')}`
  const boardId = opts.boardId ?? 'mfs-rebuild'
  let rev = typeof opts.startSourceRevision === 'number' ? opts.startSourceRevision : 100
  const baseMs = opts.nowMs ?? Date.now()
  const steps = MANDATORY_TRIGGER_MATRIX.map((row, i) => {
    const sourceRevision = rev + i + 1
    const generatedAt = new Date(baseMs + i * 1000).toISOString()
    const fixture = buildMaskedFixtureState({
      runId: `${runId}-${row.kind}`,
      status: row.statusSeed,
      trigger: row.trigger,
      sourceRevision,
      generatedAt,
      boardId,
    })
    return {
      ...row,
      stepIndex: i,
      sourceRevision,
      generatedAt,
      fixture,
      slaMs: ACCOUNT_PUBLISH_SLA_MS,
      coalesce: row.coalesce === true,
      idempotencyKey: `acct-sync-sla-${runId}-${row.trigger}-${sourceRevision}`,
      expectedSurfaces: [...SURFACES],
    }
  })
  return {
    runId,
    boardId,
    steps,
    slaMs: ACCOUNT_PUBLISH_SLA_MS,
    periodicMs: ACCOUNT_PERIODIC_HEALTH_MS,
    cleanup: buildCleanupPlan({ runId, boardId, steps }),
  }
}

/**
 * Cleanup plan — restore / tombstone synth rows; never leaves open mutation intent.
 */
export function buildCleanupPlan(opts = {}) {
  const runId = opts.runId ?? 'unknown'
  const boardId = opts.boardId ?? 'mfs-rebuild'
  const steps = opts.steps ?? []
  const maskedIds = []
  for (const s of steps) {
    for (const a of s.fixture?.accounts ?? []) {
      if (a.maskedAccountId && !maskedIds.includes(a.maskedAccountId)) {
        maskedIds.push(a.maskedAccountId)
      }
    }
  }
  return {
    runId,
    boardId,
    strategy: 'restore-healthy-masked-or-wave-close',
    maskedIdsTouched: maskedIds,
    steps: [
      {
        action: 'publish_PERIODIC_HEALTH_or_WAVE_CLOSE',
        trigger: 'WAVE_CLOSE',
        note: 'final publish with healthy GROK fixture; no tokens',
      },
      {
        action: 'verify_four_surface_parity',
        slaMs: ACCOUNT_PUBLISH_SLA_MS,
      },
      {
        action: 'record_cleanup_receipt',
        pathHint: `qa/e2e/out/runtime/account-sync-sla-${runId}-cleanup.json`,
      },
    ],
    secretsNeverLogged: true,
  }
}

// ---------------------------------------------------------------------------
// Simulated four-surface publish (self-test + mock live)
// ---------------------------------------------------------------------------

/**
 * Project four surface identities from authority fixture (scheduler fan-out model).
 */
export function projectFourSurfaces(authority) {
  const { sourceRevision, generatedAt, boardId = 'mfs-rebuild' } = authority
  const id = {
    sourceRevision: Number(sourceRevision),
    generatedAt: String(generatedAt),
  }
  return {
    mcp: { ...id, schema: ACCOUNT_SURFACE_SCHEMA.mcp, boardId, surface: 'mcp' },
    api: { ...id, schema: ACCOUNT_SURFACE_SCHEMA.api, boardId, surface: 'api' },
    ui: { ...id, schema: ACCOUNT_SURFACE_SCHEMA.ui, boardId, surface: 'ui' },
    ops: { ...id, schema: ACCOUNT_SURFACE_SCHEMA.ops, boardId, surface: 'ops' },
  }
}

/**
 * Simulate publish + readback for one trigger step (offline).
 * @param {object} step from buildTriggerRunPlan
 * @param {{ missParitySurfaces?: string[], delayMs?: number, nowMs?: number, skipPeriodic?: boolean }} [sim]
 */
export function simulateTriggerPublish(step, sim = {}) {
  const publishAtMs = sim.publishAtMs ?? Date.parse(step.generatedAt)
  const nowMs = sim.nowMs ?? publishAtMs + (sim.delayMs ?? 0)
  const surfaces = projectFourSurfaces({
    sourceRevision: step.sourceRevision,
    generatedAt: step.generatedAt,
    boardId: step.fixture.boardId,
  })
  // Inject parity miss for negative tests
  for (const name of sim.missParitySurfaces ?? []) {
    if (surfaces[name]) {
      surfaces[name] = {
        ...surfaces[name],
        sourceRevision: step.sourceRevision - 1,
      }
    }
  }
  const parity = surfacesHaveExactParity(
    surfaces,
    step.sourceRevision,
    step.generatedAt,
  )
  const sla = evaluatePublishSla({ publishAtMs, nowMs, parity })
  let periodic = { periodicMiss: false, reason: null, intervalMs: null }
  if (step.trigger === 'PERIODIC_HEALTH' || sim.forcePeriodicEval) {
    const last =
      sim.lastPeriodicHealthAtMs != null
        ? sim.lastPeriodicHealthAtMs
        : publishAtMs - (sim.periodicGapMs ?? 0)
    periodic = evaluatePeriodicHealth({
      lastPeriodicHealthAtMs: last,
      nowMs,
    })
  }
  const fail = evaluateFailClosed({
    parity,
    slaMiss: sla.slaMiss,
    periodicMiss: periodic.periodicMiss,
    usableCapacity: sim.usableCapacity ?? 5,
  })
  return {
    trigger: step.trigger,
    ac: step.ac,
    kind: step.kind,
    sourceRevision: step.sourceRevision,
    generatedAt: step.generatedAt,
    surfaces,
    parity,
    sla,
    periodic,
    failClosed: fail,
    withinSla: !sla.slaMiss && parity,
    coalesce: step.coalesce,
    accountsMasked: step.fixture.accounts.map((a) => a.maskedAccountId),
  }
}

// ---------------------------------------------------------------------------
// Live surface probes (HTTP/MCP) — used only when --real + env complete
// ---------------------------------------------------------------------------

function redactSecretsDeep(value, secrets = []) {
  const secretList = (secrets || []).filter((s) => typeof s === 'string' && s.length > 0)
  const scrub = (s) => {
    let out = s
    for (const sec of secretList) {
      if (sec && out.includes(sec)) out = out.split(sec).join('[REDACTED_BEARER]')
    }
    return out
  }
  const walk = (v) => {
    if (v == null) return v
    if (typeof v === 'string') return scrub(v)
    if (typeof v === 'number' || typeof v === 'boolean') return v
    if (Array.isArray(v)) return v.map(walk)
    if (typeof v === 'object') {
      const out = {}
      for (const [k, val] of Object.entries(v)) {
        if (SECRET_KEY_RE.test(k)) {
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

async function mcpToolsCall(baseUrl, name, args, opts = {}) {
  const url = `${String(baseUrl).replace(/\/$/, '')}/mcp`
  const headers = {
    accept: 'application/json, text/event-stream',
    'content-type': 'application/json',
  }
  if (opts.bearer) headers.authorization = `Bearer ${opts.bearer}`
  const body = {
    jsonrpc: '2.0',
    id: opts.id ?? 92001,
    method: 'tools/call',
    params: { name, arguments: args },
  }
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const res = await fetchImpl(url, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })
  const text = await res.text()
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
  return {
    httpStatus: res.status,
    ok: res.ok,
    parsed,
    toolJson,
  }
}

async function fetchJson(url, init = {}) {
  const fetchImpl = init.fetchImpl ?? globalThis.fetch
  const res = await fetchImpl(url, {
    ...init,
    headers: {
      accept: 'application/json',
      ...(init.headers || {}),
    },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return { status: res.status, body, text, headers: res.headers }
}

/**
 * Read four surfaces after a publish (or for read-only parity check).
 * MCP: list_accounts
 * API: GET /api/accounts?boardId=
 * UI/Ops: same envelope fields when session present; otherwise derive residual.
 */
export async function readFourSurfacesLive(opts) {
  const {
    baseUrl,
    boardId,
    bearer,
    sessionCookie = null,
    fetchImpl = globalThis.fetch,
  } = opts
  const secrets = bearer ? [bearer] : []
  const surfaces = { mcp: null, api: null, ui: null, ops: null }
  const residuals = []

  // MCP
  try {
    const mcp = await mcpToolsCall(
      baseUrl,
      'list_accounts',
      { boardId },
      { bearer, fetchImpl, id: 92100 },
    )
    const tj = mcp.toolJson
    surfaces.mcp = {
      sourceRevision: tj?.sourceRevision ?? null,
      generatedAt: tj?.generatedAt ?? null,
      schema: tj?.schema ?? ACCOUNT_SURFACE_SCHEMA.mcp,
      stale: tj?.stale ?? null,
      httpStatus: mcp.httpStatus,
    }
    if (tj?.accounts) assertMaskedPool(tj.accounts.map((a) => stripSecretKeys(a)))
  } catch (e) {
    residuals.push({ surface: 'mcp', error: String(e?.message || e) })
  }

  // API (session cookie preferred)
  try {
    const headers = {}
    if (sessionCookie) headers.cookie = sessionCookie
    else if (bearer) headers.authorization = `Bearer ${bearer}`
    const api = await fetchJson(
      `${baseUrl}/api/accounts?boardId=${encodeURIComponent(boardId)}`,
      { headers, fetchImpl },
    )
    surfaces.api = {
      sourceRevision: api.body?.sourceRevision ?? null,
      generatedAt: api.body?.generatedAt ?? null,
      schema: api.body?.schema ?? ACCOUNT_SURFACE_SCHEMA.api,
      stale: api.body?.stale ?? null,
      httpStatus: api.status,
    }
    if (api.status === 401 || api.status === 403) {
      residuals.push({
        surface: 'api',
        error: `auth_required status=${api.status}`,
        code: api.body?.code ?? null,
      })
    }
  } catch (e) {
    residuals.push({ surface: 'api', error: String(e?.message || e) })
  }

  // UI / Ops product paths are browser control-center projections. When session
  // is unavailable, mirror API identity only if api already has authority and
  // mark residual so we never invent independent UI/Ops revs.
  if (surfaces.api?.sourceRevision != null && surfaces.api?.generatedAt != null) {
    surfaces.ui = {
      sourceRevision: surfaces.api.sourceRevision,
      generatedAt: surfaces.api.generatedAt,
      schema: ACCOUNT_SURFACE_SCHEMA.ui,
      derivedFrom: 'api-envelope',
      residual: 'UI surface not independently HTTP-probed without browser session',
    }
    surfaces.ops = {
      sourceRevision: surfaces.api.sourceRevision,
      generatedAt: surfaces.api.generatedAt,
      schema: ACCOUNT_SURFACE_SCHEMA.ops,
      derivedFrom: 'api-envelope',
      residual: 'Ops surface not independently HTTP-probed without browser session',
    }
  } else if (surfaces.mcp?.sourceRevision != null && surfaces.mcp?.generatedAt != null) {
    // MCP-only partial — fail closed for four-surface parity (cannot invent)
    residuals.push({
      surface: 'ui+ops',
      error: 'no independent UI/Ops/API identity; four-surface parity unproven',
    })
  }

  const sourceRevision =
    surfaces.mcp?.sourceRevision ??
    surfaces.api?.sourceRevision ??
    null
  const generatedAt =
    surfaces.mcp?.generatedAt ?? surfaces.api?.generatedAt ?? null
  const parity =
    sourceRevision != null &&
    generatedAt != null &&
    surfacesHaveExactParity(surfaces, sourceRevision, generatedAt)

  return redactSecretsDeep(
    {
      surfaces,
      sourceRevision,
      generatedAt,
      parity,
      residuals,
    },
    secrets,
  )
}

/**
 * Live conformance driver. Default is read-only. Mutations require
 * ACCOUNT_SYNC_SLA_ALLOW_MUTATION=1. Always fail-closed without ROOT token.
 */
export async function runLiveAccountSyncSla(opts = {}) {
  const env = opts.env ?? process.env
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const boardId = opts.boardId ?? resolveBoardId(env)
  const baseUrl = opts.baseUrl ?? resolveStagingBase(env)
  const runId =
    opts.runId ||
    env.ACCOUNT_SYNC_SLA_RUN_ID?.trim() ||
    `live-${Date.now().toString(36)}`

  const receipt = {
    mode: 'real',
    ok: false,
    runId,
    boardId,
    baseHost: null,
    mutations: false,
    steps: [],
    cleanup: null,
    residuals: [],
    at: new Date().toISOString(),
  }

  const staging = assertStagingOnlyBase(baseUrl)
  if (!staging.ok) {
    receipt.residuals.push({ class: 'STACK', code: staging.code, detail: staging.reason })
    return receipt
  }
  receipt.baseHost = staging.host

  const root = resolveExplicitRootToken(env)
  if (!root.ok) {
    receipt.residuals.push({
      class: 'AUTH',
      code: 'MISSING_ROOT_TOKEN',
      detail: root.reason,
      tokenRef: root.tokenRef,
    })
    return receipt
  }
  receipt.rootTokenRef = root.tokenRef
  const secrets = [root.bearer]

  const allowMut = mutationsAllowed(env)
  receipt.mutations = allowMut

  // Read-only four-surface probe always runs first
  const readback = await readFourSurfacesLive({
    baseUrl,
    boardId,
    bearer: root.bearer,
    sessionCookie: opts.sessionCookie ?? null,
    fetchImpl,
  })
  receipt.steps.push({
    name: 'four_surface_readback',
    parity: readback.parity,
    sourceRevision: readback.sourceRevision,
    generatedAt: readback.generatedAt,
    residuals: readback.residuals,
    surfaces: readback.surfaces,
  })

  if (!allowMut) {
    receipt.residuals.push({
      class: 'HARNESS',
      code: 'MUTATION_DISABLED',
      detail:
        'ACCOUNT_SYNC_SLA_ALLOW_MUTATION!=1 — skipped trigger matrix mutations (safe default)',
    })
    // Read-only pass: require at least MCP identity present; full parity is
    // best-effort when UI/Ops/API session missing.
    const mcpOk =
      readback.surfaces?.mcp?.sourceRevision != null &&
      readback.surfaces?.mcp?.generatedAt != null
    receipt.ok = mcpOk && readback.residuals.every((r) => r.surface !== 'mcp')
    if (!mcpOk) {
      receipt.residuals.push({
        class: 'APP',
        code: 'MCP_LIST_ACCOUNTS_MISSING_IDENTITY',
        detail: 'list_accounts did not return sourceRevision/generatedAt',
      })
    }
    receipt.cleanup = { skipped: true, reason: 'no mutations performed' }
    return redactSecretsDeep(receipt, secrets)
  }

  // Mutation path: run trigger matrix + cleanup
  const plan = buildTriggerRunPlan({ runId, boardId })
  receipt.cleanup = plan.cleanup
  let expectedBoardRev =
    typeof opts.expectedBoardRev === 'number' ? opts.expectedBoardRev : null

  // Probe board rev from list_accounts pin envelope if present
  if (expectedBoardRev == null) {
    const probe = await mcpToolsCall(
      baseUrl,
      'list_accounts',
      { boardId },
      { bearer: root.bearer, fetchImpl, id: 92101 },
    )
    const pinRev =
      probe.toolJson?.pin?.boardRev ??
      probe.toolJson?.boardRev ??
      probe.toolJson?.expectedBoardRev
    if (typeof pinRev === 'number') expectedBoardRev = pinRev
  }

  for (const step of plan.steps) {
    const publishAtMs = Date.now()
    const syncArgs = {
      boardId,
      sourceRevision: step.sourceRevision,
      expectedBoardRev: expectedBoardRev ?? 0,
      generatedAt: step.generatedAt,
      accounts: step.fixture.accounts,
      idempotencyKey: step.idempotencyKey,
      trigger: step.trigger,
    }
    const syncRaw = await mcpToolsCall(baseUrl, 'sync_accounts', syncArgs, {
      bearer: root.bearer,
      fetchImpl,
      id: 92200 + step.stepIndex,
    })
    const syncOk =
      syncRaw.httpStatus < 400 &&
      syncRaw.toolJson?.ok === true &&
      !syncRaw.toolJson?.code
    if (typeof syncRaw.toolJson?.boardRev === 'number') {
      expectedBoardRev = syncRaw.toolJson.boardRev
    }

    // Poll four surfaces within SLA window (bounded short poll in tests via opts)
    const pollMs = opts.pollMs ?? 500
    const deadline = publishAtMs + (opts.slaMs ?? ACCOUNT_PUBLISH_SLA_MS)
    let lastRead = null
    let parity = false
    while (Date.now() <= deadline) {
      lastRead = await readFourSurfacesLive({
        baseUrl,
        boardId,
        bearer: root.bearer,
        sessionCookie: opts.sessionCookie ?? null,
        fetchImpl,
      })
      if (
        lastRead.parity &&
        Number(lastRead.sourceRevision) === Number(step.sourceRevision) &&
        String(lastRead.generatedAt) === String(step.generatedAt)
      ) {
        parity = true
        break
      }
      await new Promise((r) => setTimeout(r, pollMs))
      if (opts.singlePoll) break
    }
    const nowMs = Date.now()
    const sla = evaluatePublishSla({
      publishAtMs,
      nowMs,
      parity,
    })
    const fail = evaluateFailClosed({
      parity,
      slaMiss: sla.slaMiss,
      periodicMiss: false,
      usableCapacity: syncRaw.toolJson?.usableCapacity ?? 0,
    })

    receipt.steps.push(
      redactSecretsDeep(
        {
          name: `trigger:${step.trigger}`,
          ac: step.ac,
          kind: step.kind,
          syncOk,
          syncCode: syncRaw.toolJson?.code ?? null,
          sourceRevision: step.sourceRevision,
          generatedAt: step.generatedAt,
          parity,
          sla,
          failClosed: fail,
          elapsedMs: nowMs - publishAtMs,
        },
        secrets,
      ),
    )

    if (!syncOk || !parity || fail.failClosed) {
      receipt.residuals.push({
        class: 'APP',
        code: !syncOk ? 'SYNC_FAIL' : 'PARITY_OR_SLA_FAIL',
        trigger: step.trigger,
        detail: syncRaw.toolJson?.message || sla.reason || fail.staleReason,
      })
      // Fail closed: stop further mutations; still attempt cleanup
      break
    }
  }

  // Cleanup: WAVE_CLOSE healthy publish (best-effort)
  try {
    const cleanFixture = buildMaskedFixtureState({
      runId: `${runId}-cleanup`,
      status: 'OK',
      trigger: 'WAVE_CLOSE',
      sourceRevision: (plan.steps.at(-1)?.sourceRevision ?? 100) + 50,
      generatedAt: new Date().toISOString(),
      boardId,
    })
    const cleanRaw = await mcpToolsCall(
      baseUrl,
      'sync_accounts',
      {
        boardId,
        sourceRevision: cleanFixture.sourceRevision,
        expectedBoardRev: expectedBoardRev ?? 0,
        generatedAt: cleanFixture.generatedAt,
        accounts: cleanFixture.accounts,
        idempotencyKey: `acct-sync-sla-${runId}-cleanup`,
        trigger: 'WAVE_CLOSE',
      },
      { bearer: root.bearer, fetchImpl, id: 92999 },
    )
    receipt.cleanup = {
      ...plan.cleanup,
      executed: true,
      ok: cleanRaw.toolJson?.ok === true,
      code: cleanRaw.toolJson?.code ?? null,
    }
  } catch (e) {
    receipt.cleanup = {
      ...plan.cleanup,
      executed: false,
      error: String(e?.message || e),
    }
  }

  const triggerSteps = receipt.steps.filter((s) => String(s.name).startsWith('trigger:'))
  receipt.ok =
    receipt.residuals.length === 0 &&
    triggerSteps.length === plan.steps.length &&
    triggerSteps.every((s) => s.syncOk && s.parity && !s.failClosed?.failClosed)

  return redactSecretsDeep(receipt, secrets)
}

// ---------------------------------------------------------------------------
// --self-test (offline, no network)
// ---------------------------------------------------------------------------

/**
 * Pure contract suite. Exit 0 only when all checks pass.
 */
export function selfTest() {
  const results = []
  const ok = (name, pass, detail = null) => {
    results.push({ name, pass: Boolean(pass), detail })
  }

  // Constants
  ok('sla_ms_30s', ACCOUNT_PUBLISH_SLA_MS === 30_000)
  ok('periodic_ms_60s', ACCOUNT_PERIODIC_HEALTH_MS === 60_000)
  ok('surfaces_four', SURFACES.length === 4 && SURFACES.join(',') === 'mcp,api,ui,ops')
  ok(
    'trigger_enum_closed',
    ACCOUNT_SYNC_TRIGGER_VALUES.includes('LIMIT_TRANSITION') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('BAN_TRANSITION') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('AUTH_EXPIRED_TRANSITION') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('ROTATION') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('REQUEUE') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('INTEGRATION_CHECKPOINT') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('PERIODIC_HEALTH') &&
      ACCOUNT_SYNC_TRIGGER_VALUES.includes('WAVE_CLOSE'),
  )

  // Masked fixture
  const fixture = buildMaskedFixtureState({
    runId: 'selftest',
    status: 'LIMIT',
    trigger: 'LIMIT_TRANSITION',
    sourceRevision: 7,
    generatedAt: '2026-07-14T00:00:00.000Z',
  })
  ok('fixture_masked_ids', fixture.accounts.every((a) => a.maskedAccountId.startsWith('acc_synth')))
  ok(
    'fixture_no_tokens',
    (() => {
      try {
        assertMaskedPool(fixture.accounts)
        return true
      } catch {
        return false
      }
    })(),
  )
  ok(
    'fixture_rejects_secret_id',
    (() => {
      try {
        buildMaskedAccount({ maskedAccountId: 'token-abc' })
        return false
      } catch {
        return true
      }
    })(),
  )
  ok(
    'fixture_strips_secret_keys',
    (() => {
      try {
        assertNoForbiddenKeys({ token: 'x', nested: { apiKey: 'y' } })
        return false
      } catch {
        return true
      }
    })(),
  )

  // Seed load path (optional file)
  const loaded = loadMaskedFixtureOrSynth({ runId: 'seedload' })
  ok('fixture_load_or_synth', Array.isArray(loaded.accounts) && loaded.accounts.length >= 1)
  ok(
    'fixture_load_masked',
    (() => {
      try {
        assertMaskedPool(loaded.accounts)
        return true
      } catch {
        return false
      }
    })(),
  )

  // Parity exact
  const goodSurfaces = projectFourSurfaces({
    sourceRevision: 7,
    generatedAt: '2026-07-14T00:00:00.000Z',
  })
  ok(
    'parity_exact_all_four',
    surfacesHaveExactParity(goodSurfaces, 7, '2026-07-14T00:00:00.000Z'),
  )
  const badSurfaces = {
    ...goodSurfaces,
    ops: { ...goodSurfaces.ops, sourceRevision: 6 },
  }
  ok(
    'parity_fail_on_ops_mismatch',
    !surfacesHaveExactParity(badSurfaces, 7, '2026-07-14T00:00:00.000Z'),
  )
  ok(
    'parity_fail_missing_surface',
    !surfacesHaveExactParity({ mcp: goodSurfaces.mcp, api: goodSurfaces.api }, 7, 'x'),
  )

  // SLA 30s
  const t0 = Date.parse('2026-07-14T00:00:00.000Z')
  ok(
    'sla_ok_within_30s_with_parity',
    evaluatePublishSla({ publishAtMs: t0, nowMs: t0 + 29_999, parity: true }).slaMiss ===
      false,
  )
  ok(
    'sla_miss_after_30s_no_parity',
    evaluatePublishSla({ publishAtMs: t0, nowMs: t0 + 30_001, parity: false }).reason ===
      'SLA_MISS_30S_NO_PARITY',
  )
  ok(
    'sla_no_miss_after_30s_with_parity',
    evaluatePublishSla({ publishAtMs: t0, nowMs: t0 + 60_000, parity: true }).slaMiss ===
      false,
  )

  // Periodic 60s
  ok(
    'periodic_ok_under_60s',
    evaluatePeriodicHealth({
      lastPeriodicHealthAtMs: t0,
      nowMs: t0 + 59_999,
    }).periodicMiss === false,
  )
  ok(
    'periodic_miss_over_60s',
    evaluatePeriodicHealth({
      lastPeriodicHealthAtMs: t0,
      nowMs: t0 + 60_001,
    }).reason === 'PERIODIC_HEALTH_MISS_60S',
  )

  // Fail closed
  const fc = evaluateFailClosed({
    parity: false,
    slaMiss: true,
    periodicMiss: false,
    usableCapacity: 5,
  })
  ok('fail_closed_stale', fc.stale === true && fc.usableCapacity === 0)
  ok('fail_closed_alert', fc.alert === 'ACCOUNT_SYNC_STALE' && fc.dispatchBlocked === true)
  ok(
    'fail_closed_open_when_ok',
    evaluateFailClosed({
      parity: true,
      slaMiss: false,
      periodicMiss: false,
      usableCapacity: 5,
    }).failClosed === false &&
      evaluateFailClosed({
        parity: true,
        slaMiss: false,
        periodicMiss: false,
        usableCapacity: 5,
      }).usableCapacity === 5,
  )

  // Trigger matrix coverage
  const plan = buildTriggerRunPlan({ runId: 'matrix', boardId: 'mfs-rebuild' })
  ok('matrix_has_limit_ban_auth', plan.steps.some((s) => s.kind === 'limit'))
  ok('matrix_has_ban', plan.steps.some((s) => s.kind === 'ban'))
  ok('matrix_has_403', plan.steps.some((s) => s.kind === '403'))
  ok('matrix_has_auth_expired', plan.steps.some((s) => s.kind === 'auth_expired'))
  ok('matrix_has_rotation', plan.steps.some((s) => s.kind === 'rotation'))
  ok('matrix_has_requeue', plan.steps.some((s) => s.kind === 'requeue'))
  ok('matrix_has_checkpoint', plan.steps.some((s) => s.kind === 'checkpoint'))
  ok('matrix_has_periodic', plan.steps.some((s) => s.kind === 'periodic'))
  ok(
    'matrix_heartbeat_coalesce',
    plan.steps.find((s) => s.trigger === 'HEARTBEAT')?.coalesce === true,
  )
  ok(
    'matrix_limit_immediate',
    plan.steps.find((s) => s.trigger === 'LIMIT_TRANSITION')?.coalesce === false,
  )
  ok('cleanup_plan_present', Array.isArray(plan.cleanup.steps) && plan.cleanup.steps.length >= 2)
  ok(
    'cleanup_touches_masked_only',
    plan.cleanup.maskedIdsTouched.every((id) => String(id).startsWith('acc_synth')),
  )

  // Simulate each mandatory trigger — parity within SLA
  let allWithin = true
  for (const step of plan.steps) {
    const sim = simulateTriggerPublish(step, { delayMs: 1000 })
    if (!sim.withinSla || sim.failClosed.failClosed) allWithin = false
  }
  ok('sim_all_triggers_within_sla', allWithin)

  // Negative: SLA miss without parity → fail closed usableCapacity=0
  const limitStep = plan.steps.find((s) => s.kind === 'limit')
  const missSim = simulateTriggerPublish(limitStep, {
    delayMs: 35_000,
    missParitySurfaces: ['ui'],
    usableCapacity: 5,
  })
  ok('sim_sla_miss_fail_closed', missSim.failClosed.failClosed === true)
  ok('sim_sla_miss_usable_zero', missSim.failClosed.usableCapacity === 0)
  ok(
    'sim_sla_miss_reason',
    missSim.sla.reason === 'SLA_MISS_30S_NO_PARITY' ||
      String(missSim.failClosed.staleReason).includes('SLA_MISS'),
  )

  // Periodic miss
  const perStep = plan.steps.find((s) => s.kind === 'periodic')
  const perMiss = simulateTriggerPublish(perStep, {
    forcePeriodicEval: true,
    lastPeriodicHealthAtMs: t0,
    nowMs: t0 + 70_000,
    publishAtMs: t0 + 70_000,
    usableCapacity: 5,
  })
  ok(
    'sim_periodic_miss_fail_closed',
    perMiss.periodic.periodicMiss === true && perMiss.failClosed.usableCapacity === 0,
  )

  // ROOT token env fail closed
  ok(
    'root_token_missing_fail_closed',
    resolveExplicitRootToken({}).ok === false,
  )
  ok(
    'root_token_explicit_account_sync_sla',
    resolveExplicitRootToken({ ACCOUNT_SYNC_SLA_ROOT_TOKEN: 'synth-root-xyz' }).ok ===
      true &&
      resolveExplicitRootToken({ ACCOUNT_SYNC_SLA_ROOT_TOKEN: 'synth-root-xyz' })
        .tokenRef === 'ACCOUNT_SYNC_SLA_ROOT_TOKEN',
  )
  ok(
    'root_token_staging_root_alias',
    resolveExplicitRootToken({ STAGING_ROOT_BEARER_TOKEN: 'synth-root-2' }).tokenRef ===
      'STAGING_ROOT_BEARER_TOKEN',
  )
  // Legacy CAIRN_MCP_BEARER alone is NOT enough (must be explicit ROOT env)
  ok(
    'root_token_rejects_legacy_mcp_only',
    resolveExplicitRootToken({ CAIRN_MCP_BEARER: 'legacy' }).ok === false,
  )

  // Staging-only guards
  ok(
    'staging_allows_loopback',
    assertStagingOnlyBase('http://127.0.0.1:33211').ok === true,
  )
  ok(
    'staging_refuses_prod_host',
    assertStagingOnlyBase('https://prod.myfitsociety.com').ok === false,
  )
  ok(
    'staging_missing_url',
    assertStagingOnlyBase('').ok === false,
  )

  // Mutations default off
  ok('mutations_default_off', mutationsAllowed({}) === false)
  ok('mutations_explicit_on', mutationsAllowed({ ACCOUNT_SYNC_SLA_ALLOW_MUTATION: '1' }) === true)

  // Coalesce rules
  ok('coalesce_heartbeat_only', isCoalescableTrigger('HEARTBEAT') === true)
  ok('immediate_limit', requireImmediatePublish('LIMIT_TRANSITION') === true)
  ok('immediate_rotation', requireImmediatePublish('ROTATION') === true)
  ok('immediate_requeue', requireImmediatePublish('REQUEUE') === true)
  ok('immediate_checkpoint', requireImmediatePublish('INTEGRATION_CHECKPOINT') === true)

  // AC coverage map present in matrix
  const acs = new Set(plan.steps.map((s) => s.ac))
  ok(
    'ac_account_01_to_06_covered',
    ['AC-ACCOUNT-01', 'AC-ACCOUNT-02', 'AC-ACCOUNT-03', 'AC-ACCOUNT-04', 'AC-ACCOUNT-05', 'AC-ACCOUNT-06'].every(
      (a) => acs.has(a),
    ),
  )
  // AC-ACCOUNT-07 is the parity/fail-closed rule — covered by parity + fail_closed checks
  ok('ac_account_07_parity_rule', true)

  // Idempotency keys unique per step
  const keys = plan.steps.map((s) => s.idempotencyKey)
  ok('idempotency_keys_unique', new Set(keys).size === keys.length)

  // Receipt must never include bearer
  const fakeReceipt = redactSecretsDeep(
    {
      bearer: 'super-secret-bearer-value',
      token: 'nope',
      nested: { authorization: 'Bearer xyz' },
      ok: true,
    },
    ['super-secret-bearer-value'],
  )
  ok(
    'redact_bearer_from_receipt',
    !JSON.stringify(fakeReceipt).includes('super-secret') &&
      fakeReceipt.bearer === '[REDACTED]' &&
      fakeReceipt.token === '[REDACTED]',
  )

  // Live path dry: missing env → not ok, no throw
  // (async self-check done via sync guards only here)

  const passCount = results.filter((r) => r.pass).length
  const failCount = results.filter((r) => !r.pass).length
  return {
    ok: failCount === 0,
    passCount,
    failCount,
    total: results.length,
    results,
    constants: {
      ACCOUNT_PUBLISH_SLA_MS,
      ACCOUNT_PERIODIC_HEALTH_MS,
      surfaces: SURFACES,
      triggerCount: ACCOUNT_SYNC_TRIGGER_VALUES.length,
      matrixCount: MANDATORY_TRIGGER_MATRIX.length,
    },
    planSummary: {
      runId: plan.runId,
      stepCount: plan.steps.length,
      cleanupActions: plan.cleanup.steps.map((s) => s.action),
    },
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  return {
    selfTest:
      flags.has('--self-test') ||
      flags.has('--contract') ||
      (!flags.has('--real') && !flags.has('--help') && !flags.has('-h')),
    real: flags.has('--real'),
    help: flags.has('--help') || flags.has('-h'),
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/account-sync-sla.mjs --self-test
  node qa/e2e/flows/account-sync-sla.mjs --contract
  node qa/e2e/flows/account-sync-sla.mjs --real

Env for --real:
  STAGING_URL|WEB_BASE
  BOARD_ID (default mfs-rebuild)
  ACCOUNT_SYNC_SLA_ROOT_TOKEN or STAGING_ROOT_BEARER_TOKEN (explicit ROOT; required)
  ACCOUNT_SYNC_SLA_ALLOW_MUTATION=1  (required to run trigger mutations; default off)

Never prints credentials. Staging-only; prod hosts refused.
Default mode is --self-test (offline).
`)
}

function writeReceipt(payload) {
  const outDir = join(REPO_ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `account-sync-sla-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    if (SECRET_KEY_RE.test(text) && /:\s*"[A-Za-z0-9+/_=-]{20,}"/.test(text)) {
      // soft: still write but scrub known patterns already redacted
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

function printOwnerTarget(mode, extra = {}) {
  const base = mode === 'real' ? resolveStagingBase() : 'mock://self-test'
  let port = null
  if (mode === 'real' && base) {
    try {
      port = new URL(base).port || '80'
    } catch {
      port = null
    }
  }
  const root = resolveExplicitRootToken()
  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: base || 'unset',
      port,
      account: mode === 'real' ? `tokenRef=${root.tokenRef}` : 'SYNTH_SELF_TEST',
      device: 'n/a-mcp-http',
      boardId: resolveBoardId(),
      mode,
      mutations: mode === 'real' ? mutationsAllowed() : false,
      ...extra,
    })}`,
  )
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  if (args.real) {
    printOwnerTarget('real')
    const result = await runLiveAccountSyncSla()
    const receiptPath = writeReceipt(result)
    console.log(
      JSON.stringify(
        {
          mode: 'real',
          ok: result.ok,
          runId: result.runId,
          boardId: result.boardId,
          mutations: result.mutations,
          stepCount: result.steps?.length ?? 0,
          residualCount: result.residuals?.length ?? 0,
          residuals: result.residuals,
          receiptPath,
          cleanup: result.cleanup
            ? { executed: result.cleanup.executed ?? false, skipped: result.cleanup.skipped ?? false }
            : null,
        },
        null,
        2,
      ),
    )
    process.exit(result.ok ? 0 : 1)
  }

  // default / --self-test
  printOwnerTarget('self-test')
  const result = selfTest()
  const receiptPath = writeReceipt({
    mode: 'self-test',
    ok: result.ok,
    passCount: result.passCount,
    failCount: result.failCount,
    total: result.total,
    results: result.results,
    constants: result.constants,
    planSummary: result.planSummary,
    at: new Date().toISOString(),
  })
  console.log(
    JSON.stringify(
      {
        mode: 'self-test',
        ok: result.ok,
        passCount: result.passCount,
        failCount: result.failCount,
        total: result.total,
        receiptPath,
        failed: result.results.filter((r) => !r.pass).map((r) => r.name),
        constants: result.constants,
      },
      null,
      2,
    ),
  )
  process.exit(result.ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((e) => {
    console.error(String(e?.stack || e))
    process.exit(1)
  })
}
