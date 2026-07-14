#!/usr/bin/env node
/**
 * Authenticated MCP/API read-alias parity conformance harness (AC-API-01 + AC-API-04).
 *
 * Verifies that canonical reads and compatibility aliases share:
 *   - auth (same scopes / aliasOf target)
 *   - pinned envelope (TM_PINNED_ENVELOPE_V1 + method/requestedAs/contractVersion)
 *   - filters (resolve-then-validate; aliases use target allowlist)
 *   - cursor (createdAt,id DESC · default 50 · max 200)
 *   - no independent count/readiness recomputation (aliases are precomputed slices)
 *
 * Focus aliases (get_overview family):
 *   get_rollup → get_overview (slice: rollup)
 *   get_lifecycle → get_overview (slice: lifecycle)
 *   get_board_hash → get_overview (slice: boardHash)
 *
 * Also catalogs get_work / get_priority for full COMPATIBILITY_ALIAS_MAP coverage.
 *
 * Modes:
 *   default / --self-test | CONFORMANCE_MODE=fixture — offline pure checks (no network)
 *   --live | CONFORMANCE_MODE=live|both + WEB_BASE + bearer — read-only tools/call parity
 *
 * Env:
 *   WEB_BASE / STAGING_URL     — MCP base (live only)
 *   BOARD_ID                  — default mfs-rebuild
 *   CAIRN_MCP_BEARER / STAGING_ROOT_BEARER_TOKEN / STAGING_AGENT_BEARER_TOKEN — bearer
 *   STAGING_*_BEARER_TOKEN_REF — optional env-name holding bearer (never logged)
 *   HEADED                    — unused (HTTP-only)
 *   CONFORMANCE_MODE          — fixture | live | both (default: fixture)
 *
 * Exit 0 only if all selected checks pass. Never mutates. Never prints credentials.
 * Self-contained: no README / shared-lib edits required.
 */
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')

// ---------------------------------------------------------------------------
// Contract constants (must match src/server/mcp-canonical-reads.ts + cursor.ts)
// ---------------------------------------------------------------------------

export const HARNESS_ID = 'read-alias-parity-v1'
export const CONTRACT_ID = 'TM_MCP_READ_ALIAS_PARITY_V1'
export const TM_PINNED_ENVELOPE_V1 = 'TM_PINNED_ENVELOPE_V1'
export const MCP_READ_CONTRACT_VERSION = 'TM_MCP_READ_CONTRACT_V1'
export const MCP_READ_CURSOR_ORDER = 'createdAt DESC, id DESC'
export const DEFAULT_PAGE_SIZE = 50
export const MAX_PAGE_SIZE = 200
export const BOARD_DEFAULT = 'mfs-rebuild'

/** Envelope keys required by API_CONTRACT §3 (plus method metadata). */
export const PINNED_ENVELOPE_REQUIRED_KEYS = Object.freeze([
  'schemaVersion',
  'boardId',
  'canonicalSnapshotId',
  'canonicalHash',
  'boardRev',
  'lifecycleRev',
  'generatedAt',
  'freshnessAgeSeconds',
  'stale',
  'staleReason',
  'data',
  'nextCursor',
])

export const PINNED_ENVELOPE_META_KEYS = Object.freeze([
  'method',
  'requestedAs',
  'contractVersion',
])

/**
 * Shared pin identity keys that MUST match across alias and its canonical target.
 * Aliases must not invent independent pin truth.
 */
export const SHARED_PIN_KEYS = Object.freeze([
  'schemaVersion',
  'boardId',
  'canonicalSnapshotId',
  'canonicalHash',
  'boardRev',
  'lifecycleRev',
  'contractVersion',
])

/**
 * Versioned compatibility alias matrix (API_CONTRACT §2 / mcp-canonical-reads).
 * Primary AC-API-04 surface: get_rollup / get_lifecycle / get_board_hash.
 */
export const COMPATIBILITY_ALIAS_MATRIX = Object.freeze([
  {
    alias: 'get_rollup',
    resolvesTo: 'get_overview',
    slice: 'rollup',
    kind: 'get',
    scopes: Object.freeze(['board:read']),
    note: 'Legacy readiness/rollup surface; same pin as get_overview; no independent count recompute',
  },
  {
    alias: 'get_lifecycle',
    resolvesTo: 'get_overview',
    slice: 'lifecycle',
    kind: 'get',
    scopes: Object.freeze(['board:read']),
    note: 'Lifecycle rail projection; same pin as get_overview',
  },
  {
    alias: 'get_board_hash',
    resolvesTo: 'get_overview',
    slice: 'boardHash',
    kind: 'get',
    scopes: Object.freeze(['board:read']),
    note: 'Pin hash metadata only; same pin identity as all reads',
  },
  {
    alias: 'get_work',
    resolvesTo: 'list_work_items',
    slice: 'work',
    kind: 'list',
    scopes: Object.freeze(['board:read', 'task:read']),
    note: 'Legacy work view → list_work_items (cursor/filter parity)',
  },
  {
    alias: 'get_priority',
    resolvesTo: 'get_priority_portfolio',
    slice: 'priority',
    kind: 'get',
    scopes: Object.freeze(['board:read']),
    note: 'Legacy priority → get_priority_portfolio',
  },
])

/** Primary trio called out by the build task. */
export const PRIMARY_OVERVIEW_ALIASES = Object.freeze(
  COMPATIBILITY_ALIAS_MATRIX.filter((e) => e.resolvesTo === 'get_overview').map((e) => e.alias),
)

export const CANONICAL_LIST_METHODS = Object.freeze([
  'list_work_items',
  'list_projects',
  'list_features',
  'list_tasks',
  'list_runs',
  'list_accounts',
  'list_decisions',
  'list_activity',
  'list_audit',
])

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * @param {string} name
 * @returns {typeof COMPATIBILITY_ALIAS_MATRIX[number] | null}
 */
export function resolveAliasEntry(name) {
  return COMPATIBILITY_ALIAS_MATRIX.find((e) => e.alias === name) ?? null
}

/**
 * Resolve tool/method name to canonical method (identity or alias).
 * Unknown → null (fail-closed).
 * @param {string} name
 * @param {ReadonlyArray<{alias:string,resolvesTo:string}>} [matrix]
 */
export function resolveCanonicalMethod(name, matrix = COMPATIBILITY_ALIAS_MATRIX) {
  if (typeof name !== 'string' || !name) return null
  const hit = matrix.find((e) => e.alias === name)
  if (hit) return hit.resolvesTo
  // Canonical identity: not an alias name
  if (matrix.some((e) => e.resolvesTo === name)) return name
  // Also treat known list/get names that are not alias targets as identity when listed
  if (CANONICAL_LIST_METHODS.includes(name)) return name
  // Common get_* that are not in alias targets
  const knownGets = [
    'get_overview',
    'get_project',
    'get_feature',
    'get_task',
    'get_run',
    'get_account',
    'get_decision',
    'get_priority_portfolio',
    'get_g5',
    'get_prod',
    'get_guide',
  ]
  if (knownGets.includes(name)) return name
  return null
}

/**
 * Fail-closed page size: default 50, max 200; reject oversized / non-positive.
 * Mirrors src/server/cursor.ts resolvePageSize.
 * @param {number|null|undefined} pageSize
 * @returns {number}
 */
export function resolvePageSize(pageSize) {
  if (pageSize === undefined || pageSize === null) return DEFAULT_PAGE_SIZE
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1) {
    const err = new Error(`pageSize must be integer 1..${MAX_PAGE_SIZE}`)
    err.code = 'PAGE_SIZE_INVALID'
    throw err
  }
  if (pageSize > MAX_PAGE_SIZE) {
    const err = new Error(`pageSize ${pageSize} exceeds maximum ${MAX_PAGE_SIZE}`)
    err.code = 'PAGE_SIZE_INVALID'
    throw err
  }
  return pageSize
}

/**
 * Minimal opaque cursor encode for fixture self-tests (createdAt,id · boardRev).
 * Same wire format as cursor.ts (v1.b64url.mac16).
 * @param {{createdAt:string,id:string,boardRev:number,snapshotRev?:string|null,order?:'DESC'}} payload
 */
export function encodeCursorFixture(payload) {
  if (payload.order && payload.order !== 'DESC') {
    const err = new Error('only DESC order is supported')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  if (!payload.createdAt || !payload.id) {
    const err = new Error('createdAt and id are required')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  if (!Number.isInteger(payload.boardRev) || payload.boardRev < 0) {
    const err = new Error('boardRev must be a non-negative integer')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  const body = JSON.stringify({
    createdAt: payload.createdAt,
    id: payload.id,
    boardRev: payload.boardRev,
    snapshotRev: payload.snapshotRev ?? null,
    order: 'DESC',
  })
  const mac = createHash('sha256').update(`cairn-cursor|${body}`).digest('hex').slice(0, 16)
  const b64 = Buffer.from(body, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '')
  return `v1.${b64}.${mac}`
}

/**
 * @param {string} token
 * @returns {{createdAt:string,id:string,boardRev:number,snapshotRev:string|null,order:'DESC'}}
 */
export function decodeCursorFixture(token) {
  if (typeof token !== 'string' || !token.startsWith('v1.')) {
    const err = new Error('cursor must be a v1 opaque token')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  const parts = token.split('.')
  if (parts.length !== 3) {
    const err = new Error('cursor format invalid')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  const [, encoded, mac] = parts
  const pad = encoded.length % 4 === 0 ? '' : '='.repeat(4 - (encoded.length % 4))
  const b64 = encoded.replace(/-/g, '+').replace(/_/g, '/') + pad
  const body = Buffer.from(b64, 'base64').toString('utf8')
  const expectMac = createHash('sha256').update(`cairn-cursor|${body}`).digest('hex').slice(0, 16)
  if (expectMac !== mac) {
    const err = new Error('cursor integrity check failed')
    err.code = 'CURSOR_TAMPERED'
    throw err
  }
  const p = JSON.parse(body)
  if (p.order !== 'DESC' || typeof p.createdAt !== 'string' || typeof p.id !== 'string') {
    const err = new Error('cursor payload invalid')
    err.code = 'CURSOR_INVALID'
    throw err
  }
  return {
    createdAt: p.createdAt,
    id: p.id,
    boardRev: p.boardRev,
    snapshotRev: p.snapshotRev ?? null,
    order: 'DESC',
  }
}

/**
 * Build a synthetic pinned envelope for fixture/self-test (mirrors buildPinnedReadEnvelope rules).
 * Does NOT recompute counts/readiness — `data` is injected as-is.
 * @param {Record<string, unknown>} pin
 * @param {unknown} data
 * @param {{method:string,nextCursor?:string|null}} opts
 */
export function buildFixturePinnedEnvelope(pin, data, opts) {
  const requestedAs = opts.method
  const method = resolveCanonicalMethod(requestedAs)
  if (!method) {
    const err = new Error(`not a canonical read or compatibility alias: ${requestedAs}`)
    err.code = 'UNKNOWN_METHOD'
    throw err
  }
  const isList = CANONICAL_LIST_METHODS.includes(method)
  const nextCursor = isList ? (opts.nextCursor ?? null) : null
  const env = {
    schemaVersion: TM_PINNED_ENVELOPE_V1,
    boardId: pin.boardId,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    generatedAt: pin.generatedAt,
    freshnessAgeSeconds: pin.freshnessAgeSeconds,
    stale: pin.stale,
    staleReason: pin.staleReason,
    data,
    nextCursor,
    method,
    requestedAs,
    contractVersion: MCP_READ_CONTRACT_VERSION,
  }
  const shape = assertPinnedEnvelopeShape(env)
  if (!shape.ok) {
    const err = new Error(shape.errors.join('; '))
    err.code = 'PIN_INCOMPLETE'
    throw err
  }
  return env
}

/**
 * Typed-ish envelope shape check (not key-presence alone).
 * @param {unknown} env
 * @returns {{ok:boolean,errors:string[]}}
 */
export function assertPinnedEnvelopeShape(env) {
  const errors = []
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    return { ok: false, errors: ['envelope must be an object'] }
  }
  const e = /** @type {Record<string, unknown>} */ (env)
  for (const key of PINNED_ENVELOPE_REQUIRED_KEYS) {
    if (!(key in e)) errors.push(`missing key: ${key}`)
  }
  if (e.schemaVersion !== TM_PINNED_ENVELOPE_V1) {
    errors.push(`schemaVersion must be ${TM_PINNED_ENVELOPE_V1}`)
  }
  if (typeof e.boardId !== 'string' || !e.boardId.trim()) errors.push('boardId invalid')
  if (typeof e.canonicalSnapshotId !== 'string' || !e.canonicalSnapshotId.trim()) {
    errors.push('canonicalSnapshotId invalid')
  }
  if (typeof e.canonicalHash !== 'string' || !e.canonicalHash.trim()) {
    errors.push('canonicalHash invalid')
  }
  if (typeof e.boardRev !== 'number' || !Number.isInteger(e.boardRev) || e.boardRev < 0) {
    errors.push('boardRev invalid')
  }
  if (
    typeof e.lifecycleRev !== 'number' ||
    !Number.isInteger(e.lifecycleRev) ||
    e.lifecycleRev < 0
  ) {
    errors.push('lifecycleRev invalid')
  }
  if (typeof e.generatedAt !== 'string' || !e.generatedAt) errors.push('generatedAt invalid')
  if (
    typeof e.freshnessAgeSeconds !== 'number' ||
    !Number.isFinite(e.freshnessAgeSeconds) ||
    e.freshnessAgeSeconds < 0
  ) {
    errors.push('freshnessAgeSeconds invalid')
  }
  if (typeof e.stale !== 'boolean') errors.push('stale must be boolean')
  if (!(e.staleReason === null || typeof e.staleReason === 'string')) {
    errors.push('staleReason must be string|null')
  }
  if (!('data' in e)) errors.push('data required')
  if (e.nextCursor !== null && e.nextCursor !== undefined) {
    if (typeof e.nextCursor !== 'string' || !e.nextCursor.trim()) {
      errors.push('nextCursor must be non-empty string or null')
    } else {
      try {
        const p = decodeCursorFixture(e.nextCursor)
        if (typeof e.boardRev === 'number' && p.boardRev !== e.boardRev) {
          errors.push(`cursor boardRev ${p.boardRev} != envelope boardRev ${e.boardRev}`)
        }
      } catch (err) {
        errors.push(`nextCursor decode: ${err instanceof Error ? err.message : String(err)}`)
      }
    }
  }
  if ('method' in e && e.method != null) {
    const resolved = resolveCanonicalMethod(/** @type {string} */ (e.method))
    // method field must be the CANONICAL name (not the alias)
    if (resolved !== e.method) {
      errors.push(`envelope method must be canonical, got ${String(e.method)}`)
    }
  }
  if ('contractVersion' in e && e.contractVersion != null) {
    if (e.contractVersion !== MCP_READ_CONTRACT_VERSION) {
      errors.push(`contractVersion must be ${MCP_READ_CONTRACT_VERSION}`)
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Auth parity: alias tool spec must share scopes of target and declare aliasOf.
 * @param {{name:string,scopes?:string[],aliasOf?:string,kind?:string}} aliasSpec
 * @param {{name:string,scopes?:string[],kind?:string}} targetSpec
 * @param {{alias:string,resolvesTo:string,scopes:readonly string[]}} expected
 * @returns {{ok:boolean,errors:string[]}}
 */
export function assertAuthParity(aliasSpec, targetSpec, expected) {
  const errors = []
  if (!aliasSpec) {
    errors.push(`missing alias tool spec for ${expected.alias}`)
    return { ok: false, errors }
  }
  if (!targetSpec) {
    errors.push(`missing target tool spec for ${expected.resolvesTo}`)
    return { ok: false, errors }
  }
  if (aliasSpec.aliasOf !== expected.resolvesTo) {
    errors.push(
      `${expected.alias}.aliasOf expected ${expected.resolvesTo}, got ${String(aliasSpec.aliasOf)}`,
    )
  }
  const aScopes = [...(aliasSpec.scopes ?? [])].sort()
  const tScopes = [...(targetSpec.scopes ?? [])].sort()
  const eScopes = [...expected.scopes].sort()
  if (JSON.stringify(aScopes) !== JSON.stringify(tScopes)) {
    errors.push(
      `${expected.alias} scopes [${aScopes}] != target ${expected.resolvesTo} scopes [${tScopes}]`,
    )
  }
  if (JSON.stringify(aScopes) !== JSON.stringify(eScopes)) {
    errors.push(`${expected.alias} scopes [${aScopes}] != expected [${eScopes}]`)
  }
  if (aliasSpec.kind && targetSpec.kind && aliasSpec.kind !== targetSpec.kind) {
    errors.push(`${expected.alias} kind ${aliasSpec.kind} != target kind ${targetSpec.kind}`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Pin/envelope parity between alias response and its canonical target.
 * @param {Record<string, unknown>} aliasEnv
 * @param {Record<string, unknown>} canonicalEnv
 * @param {{alias:string,resolvesTo:string}} entry
 * @returns {{ok:boolean,errors:string[]}}
 */
export function assertEnvelopeParity(aliasEnv, canonicalEnv, entry) {
  const errors = []
  const aShape = assertPinnedEnvelopeShape(aliasEnv)
  const cShape = assertPinnedEnvelopeShape(canonicalEnv)
  if (!aShape.ok) errors.push(...aShape.errors.map((e) => `alias: ${e}`))
  if (!cShape.ok) errors.push(...cShape.errors.map((e) => `canonical: ${e}`))
  if (errors.length) return { ok: false, errors }

  for (const key of SHARED_PIN_KEYS) {
    if (aliasEnv[key] !== canonicalEnv[key]) {
      errors.push(
        `pin key ${key} differs: alias=${JSON.stringify(aliasEnv[key])} canonical=${JSON.stringify(canonicalEnv[key])}`,
      )
    }
  }
  if (aliasEnv.method !== entry.resolvesTo) {
    errors.push(`alias method expected ${entry.resolvesTo}, got ${String(aliasEnv.method)}`)
  }
  if (aliasEnv.requestedAs !== entry.alias) {
    errors.push(`alias requestedAs expected ${entry.alias}, got ${String(aliasEnv.requestedAs)}`)
  }
  if (canonicalEnv.method !== entry.resolvesTo) {
    errors.push(
      `canonical method expected ${entry.resolvesTo}, got ${String(canonicalEnv.method)}`,
    )
  }
  if (canonicalEnv.requestedAs !== entry.resolvesTo) {
    errors.push(
      `canonical requestedAs expected ${entry.resolvesTo}, got ${String(canonicalEnv.requestedAs)}`,
    )
  }
  // Get aliases force nextCursor null (no independent list pagination)
  if (entry.resolvesTo === 'get_overview' || !CANONICAL_LIST_METHODS.includes(entry.resolvesTo)) {
    if (aliasEnv.nextCursor !== null && aliasEnv.nextCursor !== undefined) {
      // allow undefined from partial live payloads but prefer null
      if (aliasEnv.nextCursor !== null) {
        errors.push(`get-style alias nextCursor must be null, got ${String(aliasEnv.nextCursor)}`)
      }
    }
  }
  return { ok: errors.length === 0, errors }
}

/**
 * Filter contract: aliases resolve to target before allowlist validation.
 * Unknown keys for the *resolved* method are rejected.
 * get_overview family only allows boardId (+ optional cursor/pageSize which are ignored for gets).
 * @param {string} methodOrAlias
 * @param {Record<string, unknown>} raw
 * @returns {{ok:boolean,filters?:Record<string,unknown>,errors:string[]}}
 */
export function validateSharedFilters(methodOrAlias, raw) {
  const method = resolveCanonicalMethod(methodOrAlias)
  if (!method) {
    return { ok: false, errors: [`unknown read method: ${methodOrAlias}`] }
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, errors: ['filters must be an object'] }
  }
  const boardId = raw.boardId
  if (typeof boardId !== 'string' || !boardId.trim()) {
    return { ok: false, errors: ['boardId is required'] }
  }

  /** @type {Record<string, Set<string>>} */
  const ALLOWED = {
    get_overview: new Set(['boardId', 'cursor', 'pageSize']),
    list_work_items: new Set([
      'boardId',
      'cursor',
      'pageSize',
      'bucket',
      'overlay',
      'staleFamily',
      'projectId',
      'featureId',
    ]),
    get_priority_portfolio: new Set(['boardId', 'cursor', 'pageSize']),
    list_projects: new Set(['boardId', 'cursor', 'pageSize']),
    list_tasks: new Set(['boardId', 'cursor', 'pageSize', 'projectId', 'featureId', 'stage']),
    list_audit: new Set(['boardId', 'cursor', 'pageSize']),
    list_activity: new Set(['boardId', 'cursor', 'pageSize']),
  }
  const allowed = ALLOWED[method] ?? new Set(['boardId', 'cursor', 'pageSize'])
  const errors = []
  for (const key of Object.keys(raw)) {
    if (!allowed.has(key)) {
      errors.push(`unknown filter key for ${method}: ${key}`)
    }
  }
  if (errors.length) return { ok: false, errors }

  // pageSize fail-closed when present
  if ('pageSize' in raw && raw.pageSize !== undefined && raw.pageSize !== null) {
    try {
      resolvePageSize(/** @type {number} */ (raw.pageSize))
    } catch (e) {
      return {
        ok: false,
        errors: [e instanceof Error ? e.message : String(e)],
      }
    }
  }

  return {
    ok: true,
    filters: {
      boardId: boardId.trim(),
      cursor: raw.cursor ?? undefined,
      pageSize: raw.pageSize ?? undefined,
    },
    errors: [],
  }
}

/**
 * Prove envelope builder does not recompute counts: inject data, assert identity.
 * @param {Record<string, unknown>} pin
 * @param {Record<string, unknown>} precomputed
 * @param {string} methodOrAlias
 * @returns {{ok:boolean,errors:string[],env?:Record<string,unknown>}}
 */
export function assertNoIndependentRecompute(pin, precomputed, methodOrAlias) {
  const frozen = Object.freeze({ ...precomputed })
  const before = JSON.stringify(frozen)
  const env = buildFixturePinnedEnvelope(pin, frozen, { method: methodOrAlias })
  const after = JSON.stringify(env.data)
  const errors = []
  if (before !== after) {
    errors.push('envelope builder mutated or recomputed injected data')
  }
  // Must not invent competing readiness/count fields
  if (env.data && typeof env.data === 'object' && !Array.isArray(env.data)) {
    const d = /** @type {Record<string, unknown>} */ (env.data)
    for (const banned of ['recomputedCounts', 'independentReadiness', 'localOnlyCounts']) {
      if (banned in d && !(banned in frozen)) {
        errors.push(`builder invented field ${banned}`)
      }
    }
  }
  return { ok: errors.length === 0, errors, env }
}

/**
 * Compare two scope arrays as sets.
 * @param {readonly string[]} a
 * @param {readonly string[]} b
 */
export function scopesEqual(a, b) {
  const sa = [...a].sort()
  const sb = [...b].sort()
  return JSON.stringify(sa) === JSON.stringify(sb)
}

/**
 * Fixture pin for self-tests.
 * @param {Partial<Record<string, unknown>>} [over]
 */
export function baseFixturePin(over = {}) {
  return {
    boardId: 'mfs-rebuild',
    canonicalSnapshotId: 'pin-mfs-rebuild-alias-parity',
    canonicalHash: 'b'.repeat(64),
    boardRev: 42,
    lifecycleRev: 7,
    generatedAt: '2026-07-14T04:34:07.000Z',
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
    ...over,
  }
}

// ---------------------------------------------------------------------------
// Check runner
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, ok: boolean, detail?: string }} CheckResult
 */

/**
 * @param {CheckResult[]} results
 * @param {string} id
 * @param {boolean} ok
 * @param {string} [detail]
 */
export function record(results, id, ok, detail = '') {
  results.push({ id, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  // eslint-disable-next-line no-console
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ''}`)
}

/**
 * Full offline self-test suite. Returns results array (also logs PASS/FAIL).
 * Injectable for unit tests (no process.exit).
 * @param {{silent?: boolean}} [opts]
 * @returns {CheckResult[]}
 */
export function runSelfTest(opts = {}) {
  const results = /** @type {CheckResult[]} */ ([])
  const log = opts.silent
    ? () => {}
    : (id, ok, detail) => record(results, id, ok, detail)
  // when silent, still collect without console
  const put = (id, ok, detail = '') => {
    if (opts.silent) {
      results.push({ id, ok, detail })
    } else {
      log(id, ok, detail)
    }
  }

  // --- Matrix integrity ---
  put(
    'matrix_primary_trio',
    PRIMARY_OVERVIEW_ALIASES.length === 3 &&
      PRIMARY_OVERVIEW_ALIASES.includes('get_rollup') &&
      PRIMARY_OVERVIEW_ALIASES.includes('get_lifecycle') &&
      PRIMARY_OVERVIEW_ALIASES.includes('get_board_hash'),
    PRIMARY_OVERVIEW_ALIASES.join(','),
  )
  put(
    'matrix_no_dup_aliases',
    new Set(COMPATIBILITY_ALIAS_MATRIX.map((e) => e.alias)).size ===
      COMPATIBILITY_ALIAS_MATRIX.length,
  )
  put(
    'matrix_cursor_constants',
    DEFAULT_PAGE_SIZE === 50 &&
      MAX_PAGE_SIZE === 200 &&
      MCP_READ_CURSOR_ORDER === 'createdAt DESC, id DESC',
    `default=${DEFAULT_PAGE_SIZE} max=${MAX_PAGE_SIZE} order=${MCP_READ_CURSOR_ORDER}`,
  )

  // --- Auth parity (fixture tool specs mirroring rbac MCP_TOOL_SPECS) ---
  const fixtureToolSpecs = {
    get_overview: { name: 'get_overview', kind: 'read', scopes: ['board:read'] },
    list_work_items: {
      name: 'list_work_items',
      kind: 'read',
      scopes: ['board:read', 'task:read'],
    },
    get_priority_portfolio: {
      name: 'get_priority_portfolio',
      kind: 'read',
      scopes: ['board:read'],
    },
    get_rollup: {
      name: 'get_rollup',
      kind: 'read',
      scopes: ['board:read'],
      aliasOf: 'get_overview',
    },
    get_lifecycle: {
      name: 'get_lifecycle',
      kind: 'read',
      scopes: ['board:read'],
      aliasOf: 'get_overview',
    },
    get_board_hash: {
      name: 'get_board_hash',
      kind: 'read',
      scopes: ['board:read'],
      aliasOf: 'get_overview',
    },
    get_work: {
      name: 'get_work',
      kind: 'read',
      scopes: ['board:read', 'task:read'],
      aliasOf: 'list_work_items',
    },
    get_priority: {
      name: 'get_priority',
      kind: 'read',
      scopes: ['board:read'],
      aliasOf: 'get_priority_portfolio',
    },
  }
  for (const entry of COMPATIBILITY_ALIAS_MATRIX) {
    const r = assertAuthParity(
      fixtureToolSpecs[entry.alias],
      fixtureToolSpecs[entry.resolvesTo],
      entry,
    )
    put(`auth_parity:${entry.alias}`, r.ok, r.errors.join('; ') || `aliasOf=${entry.resolvesTo}`)
  }

  // Negative: diverging scopes fails
  const badAuth = assertAuthParity(
    { name: 'get_rollup', scopes: ['board:write'], aliasOf: 'get_overview' },
    fixtureToolSpecs.get_overview,
    COMPATIBILITY_ALIAS_MATRIX[0],
  )
  put('auth_parity_negative_scope_diverge', !badAuth.ok, badAuth.errors[0] || 'expected fail')

  // --- Pinned envelope + alias metadata ---
  const pin = baseFixturePin()
  const overviewData = Object.freeze({
    projects: 3,
    features: 12,
    runs: 2,
    rollup: { readinessPercent: 44, active: 5, hold: 1, formulaVersion: 'v3-canonical' },
    lifecycleStages: 9,
    soleSource: 'active_dispatch_plan',
  })
  const overviewEnv = buildFixturePinnedEnvelope(pin, overviewData, { method: 'get_overview' })
  put(
    'envelope_canonical_overview',
    overviewEnv.method === 'get_overview' &&
      overviewEnv.requestedAs === 'get_overview' &&
      overviewEnv.contractVersion === MCP_READ_CONTRACT_VERSION &&
      overviewEnv.schemaVersion === TM_PINNED_ENVELOPE_V1 &&
      overviewEnv.nextCursor === null,
    `method=${overviewEnv.method}`,
  )

  for (const entry of COMPATIBILITY_ALIAS_MATRIX.filter((e) => e.resolvesTo === 'get_overview')) {
    let sliceData
    if (entry.slice === 'rollup') {
      sliceData = { rollup: overviewData.rollup, ...overviewData.rollup }
    } else if (entry.slice === 'lifecycle') {
      sliceData = { lifecycle: { stages: 9 }, stages: 9 }
    } else if (entry.slice === 'boardHash') {
      sliceData = { hash: pin.canonicalHash, boardId: pin.boardId }
    } else {
      sliceData = {}
    }
    const aliasEnv = buildFixturePinnedEnvelope(pin, sliceData, { method: entry.alias })
    const parity = assertEnvelopeParity(aliasEnv, overviewEnv, entry)
    put(
      `envelope_parity:${entry.alias}`,
      parity.ok,
      parity.errors.join('; ') ||
        `method=${aliasEnv.method} requestedAs=${aliasEnv.requestedAs}`,
    )
    // Shared pin hash identity
    put(
      `shared_pin_hash:${entry.alias}`,
      aliasEnv.canonicalHash === overviewEnv.canonicalHash &&
        aliasEnv.boardRev === overviewEnv.boardRev &&
        aliasEnv.lifecycleRev === overviewEnv.lifecycleRev,
      `hash=${String(aliasEnv.canonicalHash).slice(0, 8)}… rev=${aliasEnv.boardRev}/${aliasEnv.lifecycleRev}`,
    )
  }

  // --- No independent recompute ---
  const pre = Object.freeze({
    readinessPercent: 12.5,
    counts: Object.freeze({ DONE: 1, NEXT: 2 }),
    source: 'precomputed',
  })
  for (const alias of PRIMARY_OVERVIEW_ALIASES) {
    const r = assertNoIndependentRecompute(pin, pre, alias)
    put(`no_recompute:${alias}`, r.ok, r.errors.join('; ') || 'data identity preserved')
  }

  // --- Filters: alias resolves to same allowlist as target ---
  for (const alias of PRIMARY_OVERVIEW_ALIASES) {
    const okBoard = validateSharedFilters(alias, { boardId: 'mfs-rebuild' })
    put(`filter_ok:${alias}`, okBoard.ok, okBoard.errors.join('; '))
    const badKey = validateSharedFilters(alias, { boardId: 'mfs-rebuild', inventCounts: true })
    put(
      `filter_reject_unknown:${alias}`,
      !badKey.ok && badKey.errors.some((e) => e.includes('inventCounts')),
      badKey.errors.join('; '),
    )
    // Same rejection as canonical
    const canBad = validateSharedFilters('get_overview', {
      boardId: 'mfs-rebuild',
      inventCounts: true,
    })
    put(
      `filter_alias_matches_canonical:${alias}`,
      !badKey.ok && !canBad.ok && badKey.errors[0] === canBad.errors[0],
      `alias=${badKey.errors[0]} can=${canBad.errors[0]}`,
    )
  }

  // list alias filter parity (get_work → list_work_items)
  const workOk = validateSharedFilters('get_work', {
    boardId: 'mfs-rebuild',
    bucket: 'NEXT',
    pageSize: 50,
  })
  put('filter_ok:get_work', workOk.ok, workOk.errors.join('; '))
  const workBad = validateSharedFilters('get_work', {
    boardId: 'mfs-rebuild',
    unknownFilter: 1,
  })
  put('filter_reject_unknown:get_work', !workBad.ok, workBad.errors.join('; '))

  // --- Cursor createdAt,id default50/max200 ---
  put('cursor_default_null', resolvePageSize(null) === 50 && resolvePageSize(undefined) === 50)
  put('cursor_explicit_50', resolvePageSize(50) === 50)
  put('cursor_max_200', resolvePageSize(200) === 200)
  let oversizeRejected = false
  try {
    resolvePageSize(201)
  } catch (e) {
    oversizeRejected = e instanceof Error && /** @type {{code?:string}} */ (e).code === 'PAGE_SIZE_INVALID'
  }
  put('cursor_reject_201', oversizeRejected)
  let zeroRejected = false
  try {
    resolvePageSize(0)
  } catch (e) {
    zeroRejected = e instanceof Error && /** @type {{code?:string}} */ (e).code === 'PAGE_SIZE_INVALID'
  }
  put('cursor_reject_0', zeroRejected)

  const token = encodeCursorFixture({
    createdAt: '2026-07-14T01:00:00.000Z',
    id: 'row-1',
    boardRev: pin.boardRev,
    snapshotRev: null,
    order: 'DESC',
  })
  const decoded = decodeCursorFixture(token)
  put(
    'cursor_roundtrip_createdAt_id',
    decoded.createdAt === '2026-07-14T01:00:00.000Z' &&
      decoded.id === 'row-1' &&
      decoded.boardRev === pin.boardRev &&
      decoded.order === 'DESC',
    `id=${decoded.id}`,
  )

  // List envelope may carry nextCursor; get aliases force null even if hostile supply
  const listEnv = buildFixturePinnedEnvelope(
    pin,
    { items: [], pageSize: 50 },
    { method: 'list_work_items', nextCursor: token },
  )
  put(
    'list_preserves_nextCursor',
    listEnv.nextCursor === token && listEnv.method === 'list_work_items',
  )
  const hostileGet = buildFixturePinnedEnvelope(pin, { hash: pin.canonicalHash }, {
    method: 'get_board_hash',
    nextCursor: token,
  })
  put(
    'get_alias_forces_nextCursor_null',
    hostileGet.nextCursor === null && hostileGet.requestedAs === 'get_board_hash',
  )

  // get_work list alias preserves cursor contract
  const workEnv = buildFixturePinnedEnvelope(
    pin,
    { items: [{ createdAt: '2026-07-14T01:00:00.000Z', id: 'w1' }], pageSize: 50 },
    { method: 'get_work', nextCursor: token },
  )
  put(
    'get_work_list_alias_cursor',
    workEnv.method === 'list_work_items' &&
      workEnv.requestedAs === 'get_work' &&
      workEnv.nextCursor === token,
    `method=${workEnv.method}`,
  )

  // --- Shape reject incomplete pin ---
  let pinRejected = false
  try {
    buildFixturePinnedEnvelope(baseFixturePin({ canonicalHash: '' }), {}, { method: 'get_rollup' })
  } catch {
    pinRejected = true
  }
  // empty hash may pass builder but fail shape — either way incomplete
  const emptyHashShape = assertPinnedEnvelopeShape({
    ...buildFixturePinnedEnvelope(pin, {}, { method: 'get_overview' }),
    canonicalHash: '',
  })
  put(
    'reject_incomplete_pin',
    pinRejected || !emptyHashShape.ok,
    emptyHashShape.errors.join('; '),
  )

  return results
}

// ---------------------------------------------------------------------------
// Live (read-only) optional suite
// ---------------------------------------------------------------------------

function resolveMode() {
  if (process.argv.includes('--self-test') || process.argv.includes('--fixture')) return 'fixture'
  if (process.argv.includes('--live')) return 'both'
  const raw = (process.env.CONFORMANCE_MODE || '').trim().toLowerCase()
  if (raw === 'live' || raw === 'both' || raw === 'fixture') return raw
  return 'fixture'
}

function resolveWebBase() {
  const raw = (process.env.WEB_BASE || process.env.STAGING_URL || '').trim()
  return raw ? raw.replace(/\/$/, '') : ''
}

function resolveBoardId() {
  return process.env.BOARD_ID?.trim() || BOARD_DEFAULT
}

/**
 * Resolve bearer without logging the value.
 * @returns {{ok:boolean,tokenRef:string|null,bearer:string|null,reason?:string}}
 */
export function resolveBearerRef(env = process.env) {
  const refs = [
    env.STAGING_ROOT_BEARER_TOKEN_REF,
    env.STAGING_AGENT_BEARER_TOKEN_REF,
    env.CAIRN_MCP_BEARER_REF,
  ].filter(Boolean)
  for (const name of refs) {
    const val = env[name]
    if (typeof val === 'string' && val.trim()) {
      return { ok: true, tokenRef: name, bearer: val.trim() }
    }
  }
  for (const name of [
    'CAIRN_MCP_BEARER',
    'STAGING_ROOT_BEARER_TOKEN',
    'STAGING_AGENT_BEARER_TOKEN',
    'STAGING_BEARER_TOKEN',
  ]) {
    const val = env[name]
    if (typeof val === 'string' && val.trim()) {
      return { ok: true, tokenRef: name, bearer: val.trim() }
    }
  }
  return {
    ok: false,
    tokenRef: null,
    bearer: null,
    reason: 'missing bearer — set CAIRN_MCP_BEARER or STAGING_*_BEARER_TOKEN(_REF)',
  }
}

/**
 * Parse MCP tools/call JSON-RPC tool payload from result content.
 * @param {unknown} json
 */
export function parseToolPayload(json) {
  if (!json || typeof json !== 'object') return null
  const j = /** @type {Record<string, unknown>} */ (json)
  if (j.error) return { ok: false, code: 'MCP_RPC_ERROR', error: j.error }
  const result = /** @type {Record<string, unknown>|undefined} */ (j.result)
  if (!result) return null
  const content = result.content
  if (Array.isArray(content)) {
    const text = content.find((c) => c && typeof c === 'object' && c.type === 'text')
    if (text && typeof text.text === 'string') {
      try {
        return JSON.parse(text.text)
      } catch {
        return { ok: false, code: 'PARSE_ERROR', raw: text.text.slice(0, 200) }
      }
    }
  }
  if (result.structuredContent && typeof result.structuredContent === 'object') {
    return result.structuredContent
  }
  return result
}

/**
 * @param {string} baseUrl
 * @param {string} name
 * @param {Record<string, unknown>} args
 * @param {string} bearer
 */
export async function mcpToolsCall(baseUrl, name, args, bearer) {
  const url = `${baseUrl.replace(/\/$/, '')}/api/mcp`
  const body = {
    jsonrpc: '2.0',
    id: Math.floor(Math.random() * 1e9),
    method: 'tools/call',
    params: { name, arguments: args },
  }
  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify(body),
  })
  const rawText = await res.text()
  let json = null
  try {
    json = JSON.parse(rawText)
  } catch {
    /* ignore */
  }
  return { status: res.status, json, rawText, payload: parseToolPayload(json) }
}

/**
 * Live read-only parity: call get_overview + primary aliases; compare pin + meta.
 * Never mutates. Skips cleanly if WEB_BASE/bearer missing.
 * @param {{baseUrl:string,boardId:string,bearer:string}} cfg
 * @returns {Promise<CheckResult[]>}
 */
export async function runLiveReadOnlyParity(cfg) {
  const results = /** @type {CheckResult[]} */ ([])
  const { baseUrl, boardId, bearer } = cfg

  const overview = await mcpToolsCall(baseUrl, 'get_overview', { boardId }, bearer)
  record(
    results,
    'live_get_overview_http',
    overview.status !== 401 && overview.status < 500,
    `status=${overview.status}`,
  )
  const ov = overview.payload
  if (!ov || ov.ok === false) {
    record(
      results,
      'live_get_overview_payload',
      false,
      `code=${ov?.code ?? 'null'} (board may be missing — residual)`,
    )
    // Still try aliases for auth-class parity (not 401)
    for (const alias of PRIMARY_OVERVIEW_ALIASES) {
      const r = await mcpToolsCall(baseUrl, alias, { boardId }, bearer)
      record(
        results,
        `live_auth_class:${alias}`,
        r.status !== 401,
        `status=${r.status} code=${r.payload?.code ?? 'n/a'}`,
      )
    }
    return results
  }

  const ovShape = assertPinnedEnvelopeShape(ov)
  record(results, 'live_overview_envelope', ovShape.ok, ovShape.errors.join('; '))

  for (const entry of COMPATIBILITY_ALIAS_MATRIX.filter((e) => e.resolvesTo === 'get_overview')) {
    const r = await mcpToolsCall(baseUrl, entry.alias, { boardId }, bearer)
    record(results, `live_auth_class:${entry.alias}`, r.status !== 401, `status=${r.status}`)
    const payload = r.payload
    if (!payload || payload.ok === false) {
      record(
        results,
        `live_envelope_parity:${entry.alias}`,
        false,
        `code=${payload?.code ?? 'null'}`,
      )
      continue
    }
    const parity = assertEnvelopeParity(payload, ov, entry)
    record(
      results,
      `live_envelope_parity:${entry.alias}`,
      parity.ok,
      parity.errors.join('; ') ||
        `method=${payload.method} requestedAs=${payload.requestedAs}`,
    )
    // board_hash slice: hash must equal pin
    if (entry.alias === 'get_board_hash') {
      const hash = payload.hash ?? payload.data?.hash
      record(
        results,
        'live_board_hash_matches_pin',
        hash === payload.canonicalHash && hash === ov.canonicalHash,
        `hash=${String(hash ?? '').slice(0, 12)}…`,
      )
    }
  }

  // Unauth must fail closed (401 or typed AUTHORIZATION)
  const unauth = await fetch(`${baseUrl.replace(/\/$/, '')}/api/mcp`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', accept: 'application/json, text/event-stream' },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 1,
      method: 'tools/call',
      params: { name: 'get_rollup', arguments: { boardId } },
    }),
  })
  record(
    results,
    'live_unauth_rejected',
    unauth.status === 401 || unauth.status === 403,
    `status=${unauth.status}`,
  )

  return results
}

function printOwnerTarget(extra = {}) {
  // eslint-disable-next-line no-console
  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: resolveWebBase() || 'fixture-only',
      port: 'n/a',
      account: 'bearer-ref-only',
      device: 'n/a',
      boardId: resolveBoardId(),
      contract: CONTRACT_ID,
      harness: HARNESS_ID,
      ...extra,
    })}`,
  )
}

/**
 * Summarize results for CLI / unit harness.
 * @param {CheckResult[]} results
 * @param {string} mode
 */
export function summarize(results, mode) {
  const failed = results.filter((r) => !r.ok)
  return {
    harness: HARNESS_ID,
    contract: CONTRACT_ID,
    mode,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.map((f) => f.id),
    residual_gaps:
      mode === 'fixture'
        ? 'LIVE HTTP/MCP not exercised; unit suite cross-checks real #/server modules'
        : failed.length
          ? failed.map((f) => f.id).join(',')
          : 'none',
  }
}

/**
 * Write a receipt under .artifact (no secrets).
 * @param {ReturnType<typeof summarize>} summary
 * @param {CheckResult[]} results
 */
export function writeReceipt(summary, results) {
  const dir = join(REPO_ROOT, '.artifact', 'read-alias-parity')
  mkdirSync(dir, { recursive: true })
  const path = join(dir, `receipt-${Date.now()}.json`)
  const body = JSON.stringify({ summary, results }, null, 2)
  if (/Bearer\s+[A-Za-z0-9._\-]+/i.test(body) || /"token"\s*:\s*"[^"]{8,}"/i.test(body)) {
    throw new Error('REFUSING to write receipt: bearer-like material detected')
  }
  writeFileSync(path, body, 'utf8')
  return path
}

async function main() {
  const mode = resolveMode()
  printOwnerTarget({ mode })
  // eslint-disable-next-line no-console
  console.log(`harness=${HARNESS_ID} contract=${CONTRACT_ID} mode=${mode}`)

  /** @type {CheckResult[]} */
  let results = []

  if (mode === 'fixture' || mode === 'both') {
    // eslint-disable-next-line no-console
    console.log('=== FIXTURE / self-test suite ===')
    results = results.concat(runSelfTest())
  }

  if (mode === 'live' || mode === 'both') {
    // eslint-disable-next-line no-console
    console.log('=== LIVE read-only suite ===')
    const base = resolveWebBase()
    const bearer = resolveBearerRef()
    if (!base) {
      record(results, 'live_prereq_web_base', false, 'WEB_BASE/STAGING_URL unset')
    } else if (!bearer.ok) {
      record(results, 'live_prereq_bearer', false, bearer.reason || 'missing bearer')
    } else {
      record(results, 'live_prereq', true, `base set; tokenRef=${bearer.tokenRef}`)
      const live = await runLiveReadOnlyParity({
        baseUrl: base,
        boardId: resolveBoardId(),
        bearer: /** @type {string} */ (bearer.bearer),
      })
      results = results.concat(live)
    }
  }

  const summary = summarize(results, mode)
  // eslint-disable-next-line no-console
  console.log(JSON.stringify(summary, null, 2))
  try {
    const receipt = writeReceipt(summary, results)
    // eslint-disable-next-line no-console
    console.log(`receipt=${receipt}`)
  } catch (e) {
    // eslint-disable-next-line no-console
    console.error(String(e instanceof Error ? e.message : e))
  }

  process.exitCode = summary.failed.length ? 1 : 0
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isMain) {
  main().catch((e) => {
    // eslint-disable-next-line no-console
    console.error(String(e?.stack || e))
    process.exitCode = 1
  })
}
