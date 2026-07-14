/**
 * Shared env resolution for promoted qa/e2e flows (Node ESM).
 * Env: WEB_BASE, HEADED, CAIRN_E2E_USERNAME, CAIRN_E2E_PASSWORD, BOARD_ID, STAGING_URL, FULL_SHA
 *
 * FULL_SHA (C3-C6 / R4-P4): harness-owned runs must resolve a real 40-char Git SHA
 * (env FULL_SHA / GIT_SHA, else `git rev-parse HEAD`). Never emit UNKNOWN_SHA on a
 * claimed harness run — use resolveFullSha({ require: true }) / assertFullSha().
 */
import { execFileSync } from 'node:child_process'

export const DEFAULT_WEB_BASE = 'http://127.0.0.1:3210'

/** Full Git object id: exactly 40 hex chars. */
export const FULL_SHA_RE = /^[0-9a-f]{40}$/i

export function resolveWebBase() {
  const raw = process.env.WEB_BASE?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return DEFAULT_WEB_BASE
}

export function resolveHeaded() {
  const v = process.env.HEADED?.trim().toLowerCase()
  return v === '1' || v === 'true' || v === 'yes'
}

export function requireE2ECredentials() {
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  if (!username || !password) {
    throw new Error(
      'FAIL-CLOSED auth: CAIRN_E2E_USERNAME and CAIRN_E2E_PASSWORD are required (synthetic local/staging only).',
    )
  }
  return { username, password }
}

export function hasE2ECredentials() {
  const username = process.env.CAIRN_E2E_USERNAME?.trim() ?? ''
  const password = process.env.CAIRN_E2E_PASSWORD ?? ''
  return Boolean(username && password)
}

/** Soft probe — process-local MCP bearer for Playwright/request fixtures. */
export function hasMcpBearer() {
  return Boolean(process.env.CAIRN_MCP_BEARER?.trim())
}

/** Fail-closed MCP bearer (never print the value). */
export function requireMcpBearer() {
  const bearer = process.env.CAIRN_MCP_BEARER?.trim() ?? ''
  if (!bearer) {
    throw new Error(
      'FAIL-CLOSED mcp-auth: CAIRN_MCP_BEARER required (process-local synthetic from auth-fixture).',
    )
  }
  return bearer
}

export function resolveBoardId(defaultId = 'ibils') {
  return process.env.BOARD_ID?.trim() || defaultId
}

export function resolveStagingUrl() {
  const raw = process.env.STAGING_URL?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return resolveWebBase()
}

/**
 * Read `git rev-parse HEAD` from cwd (or opts.cwd). Returns null if unavailable.
 * @param {{ cwd?: string }} [opts]
 */
export function readGitHeadSha(opts = {}) {
  try {
    const sha = execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      cwd: opts.cwd || process.cwd(),
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return FULL_SHA_RE.test(sha) ? sha : null
  } catch {
    return null
  }
}

/**
 * Normalize a candidate SHA: must be full 40-char hex (reject short / dirty suffixes).
 * @param {string|null|undefined} raw
 * @returns {string|null}
 */
export function normalizeFullSha(raw) {
  if (raw == null) return null
  const s = String(raw).trim()
  // Reject dirty "abc…-dirty" and short SHAs
  if (!FULL_SHA_RE.test(s)) return null
  return s.toLowerCase()
}

/**
 * Resolve full Git SHA for manifests / harness receipts.
 *
 * Order: FULL_SHA env → GIT_SHA env → git rev-parse HEAD.
 *
 * @param {{ require?: boolean, cwd?: string }} [opts]
 *   - require=true (default false for piecewise tools): throw if unresolved —
 *     harness full runs MUST use require:true so UNKNOWN_SHA never appears.
 * @returns {string} 40-char lowercase hex, or 'UNKNOWN_SHA' only when require=false
 */
export function resolveFullSha(opts = {}) {
  const requireSha = opts.require === true
  // Prefer FULL_SHA, then GIT_SHA. If either is set but not full-hex, fail-closed
  // when require=true (do not silently fall through to a different SHA).
  const rawFull = process.env.FULL_SHA?.trim() || ''
  const rawGitEnv = process.env.GIT_SHA?.trim() || ''
  if (rawFull) {
    const n = normalizeFullSha(rawFull)
    if (n) return n
    if (requireSha) {
      throw new Error(
        `HARNESS FAIL: FULL_SHA is set but not a full 40-character hex Git SHA (got length=${rawFull.length}). UNKNOWN_SHA is forbidden on claimed runs.`,
      )
    }
  } else if (rawGitEnv) {
    const n = normalizeFullSha(rawGitEnv)
    if (n) return n
    if (requireSha) {
      throw new Error(
        `HARNESS FAIL: GIT_SHA is set but not a full 40-character hex Git SHA (got length=${rawGitEnv.length}).`,
      )
    }
  }

  const fromGit = readGitHeadSha({ cwd: opts.cwd })
  if (fromGit) return fromGit.toLowerCase()

  if (requireSha) {
    throw new Error(
      'HARNESS FAIL: could not resolve full 40-character Git SHA. Set FULL_SHA=$(git rev-parse HEAD) or run inside a git checkout. UNKNOWN_SHA is forbidden on claimed runs.',
    )
  }
  return 'UNKNOWN_SHA'
}

/**
 * Fail-closed SHA for harness-owned / claimed runs. Never returns UNKNOWN_SHA.
 * @param {{ cwd?: string }} [opts]
 */
export function assertFullSha(opts = {}) {
  return resolveFullSha({ ...opts, require: true })
}

/**
 * True iff value is a program-valid full SHA (not UNKNOWN_SHA / short / dirty).
 * @param {string|null|undefined} sha
 */
export function isFullSha(sha) {
  return Boolean(normalizeFullSha(sha))
}

export function resolveSchemaVersion() {
  return process.env.SCHEMA_VERSION?.trim() || 'TM_UI_CONTRACT_V1'
}

export function printOwnerTarget(extra = {}) {
  const line = {
    base_url: resolveWebBase(),
    port: new URL(resolveWebBase()).port || (resolveWebBase().startsWith('https') ? '443' : '80'),
    account: hasE2ECredentials() ? 'CAIRN_E2E_USERNAME=set' : 'CAIRN_E2E_USERNAME=UNSET',
    device: 'playwright-chromium',
    headed: resolveHeaded(),
    ...extra,
  }
  console.log(`OWNER_TARGET: ${JSON.stringify(line)}`)
  return line
}
