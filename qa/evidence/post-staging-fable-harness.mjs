/**
 * Post-staging FABLE gate harness (C5).
 *
 * Contract: AGENT_TASK_ORCHESTRATOR.md "POST-STAGING FABLE GATE"
 *   - exact model claude-fable-5
 *   - exact effort xhigh
 *   - non-interactive JSON (-p / --print + --output-format json)
 *   - supply pack: screenshot manifest, mission→evidence (Q1–Q8), staging SHA/schema,
 *     revisions/hash, all responsive states, prior review finding ledger
 *   - verify post-staging FABLE **output** SHA-256
 *   - fail closed: BLOCKED_FABLE_UNAVAILABLE (no model/effort/substitute)
 *   - refuse FABLE execution until staging evidence precondition PASSes
 *
 * Design-input FABLE receipts (C0) must never be substituted for post-staging output.
 *
 * Pure-logic + optional process spawn. Unit tests inject spawn; default CLI does not
 * invoke FABLE unless --allow-execute is set AND staging evidence PASSes.
 */

import { createHash } from 'node:crypto'
import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve, dirname, isAbsolute } from 'node:path'
import { spawnSync } from 'node:child_process'
import { fileURLToPath, pathToFileURL } from 'node:url'

export const SCHEMA_VERSION = 'TM_POST_STAGING_FABLE_HARNESS_V1'

/** Exact model — substitution forbidden. */
export const FABLE_MODEL = 'claude-fable-5'

/** Exact effort — substitution forbidden. */
export const FABLE_EFFORT = 'xhigh'

/** Non-interactive JSON output format. */
export const FABLE_OUTPUT_FORMAT = 'json'

/** Terminal fail-close code when FABLE is unavailable (no substitute). */
export const BLOCKED_FABLE_UNAVAILABLE = 'BLOCKED_FABLE_UNAVAILABLE'

/** Refuse invoke when staging evidence pack is missing/incomplete. */
export const STAGING_EVIDENCE_REQUIRED = 'STAGING_EVIDENCE_REQUIRED'

/** Refuse when supply pack is incomplete. */
export const SUPPLY_PACK_INCOMPLETE = 'SUPPLY_PACK_INCOMPLETE'

/** Refuse when argv/model/effort would substitute. */
export const FABLE_SUBSTITUTION_FORBIDDEN = 'FABLE_SUBSTITUTION_FORBIDDEN'

/** Refuse when post-staging output hash does not match. */
export const FABLE_OUTPUT_HASH_MISMATCH = 'FABLE_OUTPUT_HASH_MISMATCH'

/** UI_CONTRACT §1 — exactly eight mission questions. */
export const MISSION_QUESTIONS = Object.freeze([
  'Q1',
  'Q2',
  'Q3',
  'Q4',
  'Q5',
  'Q6',
  'Q7',
  'Q8',
])

/** Required supply keys for the post-staging evidence bundle. */
export const REQUIRED_SUPPLY_KEYS = Object.freeze([
  'screenshotManifest',
  'missionEvidenceMap',
  'stagingSha',
  'stagingSchema',
  'revisionsHash',
  'responsiveStates',
  'priorReviewFindingLedger',
])

/** Default prior ledger path (file content is hashed into the pack). */
export const DEFAULT_PRIOR_LEDGER_PATH = 'docs/control-center/DESIGN_DECISIONS.md'

// ---------------------------------------------------------------------------
// Crypto / IO helpers
// ---------------------------------------------------------------------------

/**
 * @param {string | Buffer | Uint8Array} data
 * @returns {string} hex sha256
 */
export function sha256Of(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {string} filePath
 * @returns {string}
 */
export function sha256File(filePath) {
  return sha256Of(readFileSync(filePath))
}

/**
 * @param {unknown} value
 * @returns {string}
 */
export function stableStringify(value) {
  return JSON.stringify(value, (_k, v) => {
    if (v && typeof v === 'object' && !Array.isArray(v)) {
      return Object.fromEntries(Object.keys(v).sort().map((k) => [k, v[k]]))
    }
    return v
  })
}

// ---------------------------------------------------------------------------
// Exact CLI argv (non-interactive JSON)
// ---------------------------------------------------------------------------

/**
 * Build the exact non-interactive claude-fable-5 xhigh JSON argv.
 * Never inserts fallback-model or alternate effort/model.
 *
 * @param {{
 *   prompt?: string,
 *   promptFile?: string,
 *   claudeBin?: string,
 *   extraArgs?: string[],
 * }} [opts]
 * @returns {string[]}
 */
export function buildExactFableArgv(opts = {}) {
  const bin = opts.claudeBin ?? 'claude'
  const argv = [
    bin,
    '-p',
    '--model',
    FABLE_MODEL,
    '--effort',
    FABLE_EFFORT,
    '--output-format',
    FABLE_OUTPUT_FORMAT,
  ]
  if (opts.promptFile) {
    // Prompt content is supplied via stdin by the runner when promptFile is set;
    // keep argv free of substituted model flags.
    argv.push('--input-format', 'text')
  }
  if (typeof opts.prompt === 'string' && opts.prompt.length > 0) {
    argv.push(opts.prompt)
  }
  if (Array.isArray(opts.extraArgs) && opts.extraArgs.length) {
    // Only allowlisted non-model flags; still validated by assertExactFableArgv.
    argv.push(...opts.extraArgs)
  }
  return argv
}

/**
 * Assert argv encodes exact model/effort/non-interactive JSON and no substitution.
 * @param {string[]} argv
 * @returns {{ ok: true } | { ok: false, code: string, reason: string, details?: unknown }}
 */
export function assertExactFableArgv(argv) {
  if (!Array.isArray(argv) || argv.length < 2) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: 'argv must be a non-empty array starting with claude binary',
    }
  }
  const flags = argv.slice(1)
  const hasPrint = flags.includes('-p') || flags.includes('--print')
  if (!hasPrint) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: 'missing non-interactive flag (-p/--print)',
    }
  }
  const modelIdx = flags.indexOf('--model')
  const effortIdx = flags.indexOf('--effort')
  const outIdx = flags.indexOf('--output-format')
  if (modelIdx < 0 || effortIdx < 0 || outIdx < 0) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: 'missing required --model / --effort / --output-format',
    }
  }
  const model = flags[modelIdx + 1]
  const effort = flags[effortIdx + 1]
  const outputFormat = flags[outIdx + 1]
  if (model !== FABLE_MODEL) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: `model must be exactly ${FABLE_MODEL}; got ${String(model)}`,
      details: { model },
    }
  }
  if (effort !== FABLE_EFFORT) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: `effort must be exactly ${FABLE_EFFORT}; got ${String(effort)}`,
      details: { effort },
    }
  }
  if (outputFormat !== FABLE_OUTPUT_FORMAT) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: `output-format must be exactly ${FABLE_OUTPUT_FORMAT}; got ${String(outputFormat)}`,
      details: { outputFormat },
    }
  }
  // Hard ban substitution vectors
  if (flags.includes('--fallback-model')) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: '--fallback-model is forbidden (no substitution)',
    }
  }
  const joined = flags.join(' ')
  const bannedModels = [
    'claude-opus',
    'claude-sonnet',
    'claude-haiku',
    'gpt-',
    'o3',
    'gemini',
  ]
  for (const b of bannedModels) {
    if (joined.includes(b) && !joined.includes(FABLE_MODEL)) {
      return {
        ok: false,
        code: FABLE_SUBSTITUTION_FORBIDDEN,
        reason: `banned model token present: ${b}`,
      }
    }
  }
  // Detect second --model that differs
  const modelFlags = []
  for (let i = 0; i < flags.length; i++) {
    if (flags[i] === '--model' && flags[i + 1]) modelFlags.push(flags[i + 1])
  }
  if (modelFlags.some((m) => m !== FABLE_MODEL)) {
    return {
      ok: false,
      code: FABLE_SUBSTITUTION_FORBIDDEN,
      reason: 'multiple/non-exact --model values',
      details: { modelFlags },
    }
  }
  return { ok: true }
}

// ---------------------------------------------------------------------------
// Staging evidence precondition (must PASS before FABLE execute)
// ---------------------------------------------------------------------------

/**
 * Staging evidence required before any post-staging FABLE invoke.
 *
 * Accepts either:
 * - a structured object with `status: 'PASS'` and `fullSha` + `schemaVersion`
 * - a path to a JSON file with the same fields
 * - object with `taskManagerStagingVerified: true` + pins
 *
 * @param {unknown} stagingEvidence
 * @param {{ readFileSync?: typeof readFileSync, existsSync?: typeof existsSync }} [io]
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   reason?: string,
 *   fullSha?: string,
 *   schemaVersion?: string,
 *   source?: string,
 * }}
 */
export function evaluateStagingEvidencePrecondition(stagingEvidence, io = {}) {
  const read = io.readFileSync ?? readFileSync
  const exists = io.existsSync ?? existsSync

  if (stagingEvidence == null || stagingEvidence === '') {
    return {
      ok: false,
      code: STAGING_EVIDENCE_REQUIRED,
      reason: 'staging evidence is missing; refuse FABLE invoke',
    }
  }

  let obj = stagingEvidence
  if (typeof stagingEvidence === 'string') {
    const p = stagingEvidence
    if (!exists(p)) {
      return {
        ok: false,
        code: STAGING_EVIDENCE_REQUIRED,
        reason: `staging evidence path does not exist: ${p}`,
      }
    }
    try {
      obj = JSON.parse(read(p, 'utf8'))
    } catch (err) {
      return {
        ok: false,
        code: STAGING_EVIDENCE_REQUIRED,
        reason: `staging evidence JSON parse failed: ${String(err?.message ?? err)}`,
      }
    }
  }

  if (typeof obj !== 'object' || obj == null || Array.isArray(obj)) {
    return {
      ok: false,
      code: STAGING_EVIDENCE_REQUIRED,
      reason: 'staging evidence must be a JSON object',
    }
  }

  const status = String(obj.status ?? obj.verdict ?? '').toUpperCase()
  const verifiedFlag =
    obj.taskManagerStagingVerified === true ||
    obj.TASK_MANAGER_STAGING_VERIFIED === true ||
    status === 'PASS' ||
    status === 'TASK_MANAGER_STAGING_VERIFIED'

  const fullSha = String(obj.fullSha ?? obj.sourceSha ?? obj.sha ?? '').trim()
  const schemaVersion = String(
    obj.schemaVersion ?? obj.schema ?? obj.dbSchemaVersion ?? '',
  ).trim()

  if (!verifiedFlag) {
    return {
      ok: false,
      code: STAGING_EVIDENCE_REQUIRED,
      reason:
        'staging evidence status is not PASS / TASK_MANAGER_STAGING_VERIFIED; refuse FABLE',
      fullSha: fullSha || undefined,
      schemaVersion: schemaVersion || undefined,
    }
  }
  if (!/^[0-9a-f]{7,64}$/i.test(fullSha)) {
    return {
      ok: false,
      code: STAGING_EVIDENCE_REQUIRED,
      reason: 'staging evidence missing valid fullSha/sourceSha',
    }
  }
  if (!schemaVersion) {
    return {
      ok: false,
      code: STAGING_EVIDENCE_REQUIRED,
      reason: 'staging evidence missing schemaVersion',
    }
  }

  return {
    ok: true,
    fullSha,
    schemaVersion,
    source: typeof stagingEvidence === 'string' ? stagingEvidence : 'inline',
  }
}

// ---------------------------------------------------------------------------
// Supply pack assembly
// ---------------------------------------------------------------------------

/**
 * Validate mission → evidence map covers Q1–Q8 with non-empty evidence refs.
 * @param {unknown} map
 * @returns {{ ok: boolean, missing: string[], empty: string[] }}
 */
export function validateMissionEvidenceMap(map) {
  const missing = []
  const empty = []
  if (map == null || typeof map !== 'object' || Array.isArray(map)) {
    return { ok: false, missing: [...MISSION_QUESTIONS], empty: [] }
  }
  for (const q of MISSION_QUESTIONS) {
    if (!(q in map)) {
      missing.push(q)
      continue
    }
    const v = map[q]
    const has =
      (typeof v === 'string' && v.trim().length > 0) ||
      (Array.isArray(v) && v.length > 0) ||
      (v && typeof v === 'object' && Object.keys(v).length > 0)
    if (!has) empty.push(q)
  }
  return { ok: missing.length === 0 && empty.length === 0, missing, empty }
}

/**
 * Validate responsive states list is non-empty array of non-empty strings.
 * @param {unknown} states
 */
export function validateResponsiveStates(states) {
  if (!Array.isArray(states) || states.length === 0) {
    return { ok: false, reason: 'responsiveStates must be a non-empty array' }
  }
  const bad = states.filter((s) => typeof s !== 'string' || !s.trim())
  if (bad.length) {
    return { ok: false, reason: 'responsiveStates entries must be non-empty strings' }
  }
  return { ok: true }
}

/**
 * Assemble the post-staging FABLE evidence bundle.
 * Does not invoke FABLE. Returns missing list when incomplete (fail-closed pack).
 *
 * @param {{
 *   screenshotManifest: unknown,
 *   missionEvidenceMap: Record<string, unknown>,
 *   stagingSha: string,
 *   stagingSchema: string,
 *   revisionsHash: string,
 *   responsiveStates: string[],
 *   priorReviewFindingLedger: unknown,
 *   meta?: Record<string, unknown>,
 * }} input
 * @returns {{
 *   ok: boolean,
 *   code?: string,
 *   missing?: string[],
 *   reasons?: string[],
 *   bundle?: object,
 *   bundleSha256?: string,
 * }}
 */
export function assembleEvidenceBundle(input) {
  const missing = []
  const reasons = []

  if (input == null || typeof input !== 'object') {
    return {
      ok: false,
      code: SUPPLY_PACK_INCOMPLETE,
      missing: [...REQUIRED_SUPPLY_KEYS],
      reasons: ['input must be an object'],
    }
  }

  for (const key of REQUIRED_SUPPLY_KEYS) {
    if (input[key] == null || input[key] === '') {
      missing.push(key)
    }
  }

  const mission = validateMissionEvidenceMap(input.missionEvidenceMap)
  if (!mission.ok) {
    if (!missing.includes('missionEvidenceMap')) {
      // present but incomplete
      reasons.push(
        `missionEvidenceMap incomplete: missing=${mission.missing.join(',') || '-'} empty=${mission.empty.join(',') || '-'}`,
      )
    }
  }

  const resp = validateResponsiveStates(input.responsiveStates)
  if (!resp.ok && input.responsiveStates != null) {
    reasons.push(resp.reason)
  }

  if (typeof input.stagingSha === 'string' && input.stagingSha && !/^[0-9a-f]{7,64}$/i.test(input.stagingSha)) {
    reasons.push('stagingSha must be a git-like hex sha')
  }
  if (typeof input.stagingSchema === 'string' && input.stagingSchema && !String(input.stagingSchema).trim()) {
    reasons.push('stagingSchema empty')
  }
  if (typeof input.revisionsHash === 'string' && input.revisionsHash && !/^[0-9a-f]{8,128}$/i.test(input.revisionsHash)) {
    reasons.push('revisionsHash must be a hex hash')
  }

  // screenshotManifest: object or non-empty array or path string
  const sm = input.screenshotManifest
  if (sm != null) {
    const smOk =
      (typeof sm === 'string' && sm.trim().length > 0) ||
      (Array.isArray(sm) && sm.length > 0) ||
      (typeof sm === 'object' && !Array.isArray(sm) && Object.keys(sm).length > 0)
    if (!smOk) {
      reasons.push('screenshotManifest empty')
      if (!missing.includes('screenshotManifest')) missing.push('screenshotManifest')
    }
  }

  // ledger: path string, object, or non-empty string body
  const led = input.priorReviewFindingLedger
  if (led != null) {
    const ledOk =
      (typeof led === 'string' && led.trim().length > 0) ||
      (typeof led === 'object' && led != null && Object.keys(led).length > 0)
    if (!ledOk) {
      reasons.push('priorReviewFindingLedger empty')
      if (!missing.includes('priorReviewFindingLedger')) missing.push('priorReviewFindingLedger')
    }
  }

  if (missing.length || reasons.length || !mission.ok || !resp.ok) {
    return {
      ok: false,
      code: SUPPLY_PACK_INCOMPLETE,
      missing: [...new Set([...missing, ...(!mission.ok ? ['missionEvidenceMap'] : []), ...(!resp.ok ? ['responsiveStates'] : [])])],
      reasons,
    }
  }

  const bundle = {
    schemaVersion: SCHEMA_VERSION,
    gate: 'POST_STAGING_FABLE',
    model: FABLE_MODEL,
    effort: FABLE_EFFORT,
    outputFormat: FABLE_OUTPUT_FORMAT,
    nonInteractive: true,
    assembledAt: new Date().toISOString(),
    supply: {
      screenshotManifest: input.screenshotManifest,
      missionEvidenceMap: input.missionEvidenceMap,
      stagingSha: String(input.stagingSha),
      stagingSchema: String(input.stagingSchema),
      revisionsHash: String(input.revisionsHash),
      responsiveStates: [...input.responsiveStates],
      priorReviewFindingLedger: input.priorReviewFindingLedger,
    },
    meta: input.meta ?? {},
  }

  const bundleSha256 = sha256Of(stableStringify(bundle))
  return { ok: true, bundle: { ...bundle, bundleSha256 }, bundleSha256 }
}

/**
 * Load ledger file content (or pass-through object) for the pack.
 * @param {string | object} ledgerOrPath
 * @param {{ cwd?: string, readFileSync?: typeof readFileSync }} [opts]
 */
export function resolvePriorLedger(ledgerOrPath, opts = {}) {
  if (ledgerOrPath != null && typeof ledgerOrPath === 'object') {
    return { ok: true, ledger: ledgerOrPath, source: 'inline' }
  }
  if (typeof ledgerOrPath !== 'string' || !ledgerOrPath.trim()) {
    return { ok: false, reason: 'priorReviewFindingLedger path/object required' }
  }
  const cwd = opts.cwd ?? process.cwd()
  const abs = isAbsolute(ledgerOrPath) ? ledgerOrPath : resolve(cwd, ledgerOrPath)
  const read = opts.readFileSync ?? readFileSync
  try {
    const body = read(abs, 'utf8')
    const hash = sha256Of(body)
    return {
      ok: true,
      ledger: { path: abs, sha256: hash, bytes: Buffer.byteLength(body) },
      source: abs,
    }
  } catch (err) {
    return { ok: false, reason: `ledger read failed: ${String(err?.message ?? err)}` }
  }
}

// ---------------------------------------------------------------------------
// Output hash verification (post-staging FABLE program output only)
// ---------------------------------------------------------------------------

/**
 * Verify SHA-256 of post-staging FABLE output bytes.
 * Design-input receipt paths must not be passed as if they were post-staging output
 * without an explicit allowDesignInputSubstitution=false default (always false).
 *
 * @param {{
 *   outputPath?: string,
 *   outputContent?: string | Buffer,
 *   expectedSha256: string,
 *   forbidPaths?: string[],
 *   readFileSync?: typeof readFileSync,
 *   existsSync?: typeof existsSync,
 * }} opts
 */
export function verifyPostStagingFableOutputHash(opts) {
  const expected = String(opts.expectedSha256 ?? '')
    .trim()
    .toLowerCase()
  if (!/^[0-9a-f]{64}$/.test(expected)) {
    return {
      ok: false,
      code: FABLE_OUTPUT_HASH_MISMATCH,
      reason: 'expectedSha256 must be 64-char hex',
    }
  }

  const forbid = opts.forbidPaths ?? [
    '01-task-manager-fable5-xhigh-review.json',
    '01-task-manager-fable5-xhigh-delta-review.json',
  ]
  if (opts.outputPath) {
    const base = opts.outputPath.replace(/\\/g, '/')
    for (const f of forbid) {
      if (base.endsWith(f) || base.includes(`/input/${f}`) || base.includes(`/input\\${f}`)) {
        return {
          ok: false,
          code: FABLE_SUBSTITUTION_FORBIDDEN,
          reason:
            'design-input FABLE receipt path cannot substitute for post-staging FABLE output',
          path: opts.outputPath,
        }
      }
    }
  }

  let bytes
  if (opts.outputContent != null) {
    bytes = Buffer.isBuffer(opts.outputContent)
      ? opts.outputContent
      : Buffer.from(String(opts.outputContent))
  } else if (opts.outputPath) {
    const exists = opts.existsSync ?? existsSync
    const read = opts.readFileSync ?? readFileSync
    if (!exists(opts.outputPath)) {
      return {
        ok: false,
        code: FABLE_OUTPUT_HASH_MISMATCH,
        reason: `output path missing: ${opts.outputPath}`,
      }
    }
    bytes = read(opts.outputPath)
  } else {
    return {
      ok: false,
      code: FABLE_OUTPUT_HASH_MISMATCH,
      reason: 'outputPath or outputContent required',
    }
  }

  const actual = sha256Of(bytes)
  if (actual !== expected) {
    return {
      ok: false,
      code: FABLE_OUTPUT_HASH_MISMATCH,
      reason: 'post-staging FABLE output hash mismatch',
      expectedSha256: expected,
      actualSha256: actual,
    }
  }
  return {
    ok: true,
    expectedSha256: expected,
    actualSha256: actual,
    bytes: bytes.length,
  }
}

// ---------------------------------------------------------------------------
// FABLE availability / process result → BLOCKED_FABLE_UNAVAILABLE
// ---------------------------------------------------------------------------

/**
 * Classify spawn/availability failure as BLOCKED_FABLE_UNAVAILABLE (no substitute).
 * @param {{
 *   error?: NodeJS.ErrnoException | Error | null,
 *   status?: number | null,
 *   signal?: string | null,
 *   stdout?: string,
 *   stderr?: string,
 *   argv?: string[],
 *   binaryExists?: boolean | null,
 * }} result
 */
export function evaluateFableProcessResult(result) {
  const argvCheck =
    result.argv != null ? assertExactFableArgv(result.argv) : { ok: true }
  if (!argvCheck.ok) {
    return {
      ok: false,
      code: argvCheck.code,
      reason: argvCheck.reason,
      details: argvCheck.details,
      substitute: false,
    }
  }

  if (result.binaryExists === false) {
    return {
      ok: false,
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: 'claude binary not found; FABLE unavailable; do not substitute',
      substitute: false,
    }
  }

  const err = result.error
  if (err) {
    const code = /** @type {NodeJS.ErrnoException} */ (err).code
    if (code === 'ENOENT' || /not found|ENOENT/i.test(String(err.message))) {
      return {
        ok: false,
        code: BLOCKED_FABLE_UNAVAILABLE,
        reason: `claude spawn failed (${code ?? 'error'}): ${err.message}; do not substitute`,
        substitute: false,
      }
    }
    return {
      ok: false,
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: `FABLE process error: ${err.message}; do not substitute`,
      substitute: false,
    }
  }

  const status = result.status
  const stderr = String(result.stderr ?? '')
  const stdout = String(result.stdout ?? '')
  const combined = `${stderr}\n${stdout}`

  // Model / auth / capacity unavailability signatures — still BLOCKED, never substitute.
  const unavailableSig =
    /model[_\s-]?not[_\s-]?found|unknown model|not available|unavailable|could not resolve model|invalid model|authentication|not authorized|overloaded|capacity|rate limit/i

  if (status !== 0 && status != null) {
    if (unavailableSig.test(combined) || status === 127) {
      return {
        ok: false,
        code: BLOCKED_FABLE_UNAVAILABLE,
        reason: `FABLE exit ${status}: unavailable signature; do not substitute`,
        status,
        stderrTail: stderr.slice(-500),
        substitute: false,
      }
    }
    // Non-zero without clear unavailability still fail-closes the gate (no silent PASS).
    return {
      ok: false,
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: `FABLE exit ${status}: treat as unavailable for gate; do not substitute`,
      status,
      stderrTail: stderr.slice(-500),
      substitute: false,
    }
  }

  if (!stdout.trim()) {
    return {
      ok: false,
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: 'FABLE produced empty stdout; do not substitute',
      substitute: false,
    }
  }

  // Optional: require JSON parse for output-format json
  let parsed = null
  try {
    parsed = JSON.parse(stdout)
  } catch {
    return {
      ok: false,
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: 'FABLE stdout is not valid JSON; do not substitute',
      substitute: false,
    }
  }

  return {
    ok: true,
    code: 'FABLE_OUTPUT_RECEIVED',
    stdout,
    parsed,
    status: status ?? 0,
    substitute: false,
  }
}

// ---------------------------------------------------------------------------
// Gate runner (pack → optional execute → hash)
// ---------------------------------------------------------------------------

/**
 * Full post-staging FABLE gate.
 *
 * @param {{
 *   stagingEvidence: unknown,
 *   supply: Parameters<typeof assembleEvidenceBundle>[0],
 *   allowExecute?: boolean,
 *   prompt?: string,
 *   outputPath?: string,
 *   expectedOutputSha256?: string,
 *   claudeBin?: string,
 *   spawnSync?: typeof spawnSync,
 *   whichBinary?: (bin: string) => boolean,
 *   writeFileSync?: typeof writeFileSync,
 *   mkdirSync?: typeof mkdirSync,
 * }} opts
 */
export function runPostStagingFableGate(opts) {
  const staging = evaluateStagingEvidencePrecondition(opts.stagingEvidence)
  if (!staging.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: staging.code ?? STAGING_EVIDENCE_REQUIRED,
      reason: staging.reason,
      fableInvoked: false,
      substitute: false,
    }
  }

  // Pin supply staging fields from precondition when caller omits them
  const supply = {
    ...opts.supply,
    stagingSha: opts.supply?.stagingSha ?? staging.fullSha,
    stagingSchema: opts.supply?.stagingSchema ?? staging.schemaVersion,
  }

  const pack = assembleEvidenceBundle(supply)
  if (!pack.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: pack.code ?? SUPPLY_PACK_INCOMPLETE,
      missing: pack.missing,
      reasons: pack.reasons,
      fableInvoked: false,
      substitute: false,
    }
  }

  const argv = buildExactFableArgv({
    prompt:
      opts.prompt ??
      buildDefaultPostStagingPrompt({
        bundleSha256: pack.bundleSha256,
        stagingSha: supply.stagingSha,
        stagingSchema: supply.stagingSchema,
      }),
    claudeBin: opts.claudeBin ?? 'claude',
  })
  const argvOk = assertExactFableArgv(argv)
  if (!argvOk.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: argvOk.code,
      reason: argvOk.reason,
      fableInvoked: false,
      substitute: false,
    }
  }

  if (!opts.allowExecute) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'READY_TO_INVOKE',
      code: 'STAGING_AND_SUPPLY_OK_EXECUTE_NOT_REQUESTED',
      fableInvoked: false,
      substitute: false,
      model: FABLE_MODEL,
      effort: FABLE_EFFORT,
      outputFormat: FABLE_OUTPUT_FORMAT,
      nonInteractive: true,
      argv,
      bundleSha256: pack.bundleSha256,
      bundle: pack.bundle,
      staging: {
        fullSha: staging.fullSha,
        schemaVersion: staging.schemaVersion,
        source: staging.source,
      },
      note: 'FABLE not executed (allowExecute=false). Staging precondition + supply pack OK.',
    }
  }

  const which =
    opts.whichBinary ??
    ((bin) => {
      if (bin.includes('/') || bin.includes('\\')) return existsSync(bin)
      const r = spawnSync('which', [bin], { encoding: 'utf8' })
      return r.status === 0 && Boolean(r.stdout?.trim())
    })
  const bin = opts.claudeBin ?? 'claude'
  const binaryExists = which(bin)
  if (!binaryExists) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: BLOCKED_FABLE_UNAVAILABLE,
      reason: `claude binary unavailable (${bin}); do not substitute`,
      fableInvoked: false,
      substitute: false,
      argv,
      bundleSha256: pack.bundleSha256,
    }
  }

  const spawn = opts.spawnSync ?? spawnSync
  const [cmd, ...args] = argv
  let spawned
  try {
    spawned = spawn(cmd, args, {
      encoding: 'utf8',
      maxBuffer: 32 * 1024 * 1024,
      env: process.env,
    })
  } catch (error) {
    const classified = evaluateFableProcessResult({
      error: /** @type {Error} */ (error),
      argv,
      binaryExists: true,
    })
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: classified.code,
      reason: classified.reason,
      fableInvoked: true,
      substitute: false,
      argv,
      bundleSha256: pack.bundleSha256,
    }
  }

  const classified = evaluateFableProcessResult({
    error: spawned.error,
    status: spawned.status,
    signal: spawned.signal,
    stdout: spawned.stdout,
    stderr: spawned.stderr,
    argv,
    binaryExists: true,
  })

  if (!classified.ok) {
    return {
      schemaVersion: SCHEMA_VERSION,
      status: 'BLOCKED',
      code: classified.code,
      reason: classified.reason,
      statusCode: classified.status,
      stderrTail: classified.stderrTail,
      fableInvoked: true,
      substitute: false,
      argv,
      bundleSha256: pack.bundleSha256,
    }
  }

  const stdout = classified.stdout
  const outputSha256 = sha256Of(stdout)
  let wrotePath = null
  if (opts.outputPath) {
    const write = opts.writeFileSync ?? writeFileSync
    const mkdir = opts.mkdirSync ?? mkdirSync
    mkdir(dirname(opts.outputPath), { recursive: true })
    write(opts.outputPath, stdout)
    wrotePath = opts.outputPath
  }

  let hashVerify = {
    ok: true,
    actualSha256: outputSha256,
    expectedSha256: opts.expectedOutputSha256 ?? outputSha256,
  }
  if (opts.expectedOutputSha256) {
    hashVerify = verifyPostStagingFableOutputHash({
      outputContent: stdout,
      expectedSha256: opts.expectedOutputSha256,
    })
    if (!hashVerify.ok) {
      return {
        schemaVersion: SCHEMA_VERSION,
        status: 'BLOCKED',
        code: hashVerify.code,
        reason: hashVerify.reason,
        fableInvoked: true,
        substitute: false,
        argv,
        bundleSha256: pack.bundleSha256,
        outputPath: wrotePath,
        outputSha256,
        expectedOutputSha256: opts.expectedOutputSha256,
      }
    }
  }

  return {
    schemaVersion: SCHEMA_VERSION,
    status: 'FABLE_OUTPUT_OK',
    code: 'FABLE_OUTPUT_RECEIVED',
    fableInvoked: true,
    substitute: false,
    model: FABLE_MODEL,
    effort: FABLE_EFFORT,
    outputFormat: FABLE_OUTPUT_FORMAT,
    nonInteractive: true,
    argv,
    bundleSha256: pack.bundleSha256,
    outputPath: wrotePath,
    outputSha256,
    hashVerify,
    staging: {
      fullSha: staging.fullSha,
      schemaVersion: staging.schemaVersion,
      source: staging.source,
    },
  }
}

/**
 * @param {{ bundleSha256: string, stagingSha: string, stagingSchema: string }} pins
 */
export function buildDefaultPostStagingPrompt(pins) {
  return [
    'POST-STAGING FABLE GATE critique.',
    `Exact model required: ${FABLE_MODEL}. Exact effort required: ${FABLE_EFFORT}.`,
    'Respond as structured JSON only.',
    `Evidence bundle SHA-256: ${pins.bundleSha256}`,
    `Staging fullSha: ${pins.stagingSha}`,
    `Staging schema: ${pins.stagingSchema}`,
    'Use supplied screenshot manifest, mission Q1–Q8 evidence map, revisions/hash,',
    'responsive states, and prior review finding ledger.',
    'Do not treat design-input FABLE as post-staging PASS.',
  ].join(' ')
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function printJson(obj) {
  process.stdout.write(`${JSON.stringify(obj, null, 2)}\n`)
}

function loadJsonArg(value, label) {
  if (value == null) throw new Error(`${label} required`)
  if (existsSync(value)) {
    return JSON.parse(readFileSync(value, 'utf8'))
  }
  return JSON.parse(value)
}

function parseArgs(argv) {
  const out = { _: [] }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]
    if (a.startsWith('--')) {
      const key = a.slice(2)
      const next = argv[i + 1]
      if (next != null && !next.startsWith('--')) {
        out[key] = next
        i++
      } else {
        out[key] = true
      }
    } else {
      out._.push(a)
    }
  }
  return out
}

export function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const cmd = args._[0] ?? 'help'

  if (cmd === 'help' || args.help) {
    printJson({
      schemaVersion: SCHEMA_VERSION,
      commands: {
        'print-argv': 'Print exact claude-fable-5 xhigh non-interactive JSON argv',
        'check-argv': 'Validate an argv JSON array is exact (no substitution)',
        pack: 'Assemble evidence bundle (requires supply JSON path --supply)',
        'check-staging': 'Evaluate staging evidence precondition (--staging path|json)',
        'verify-output': 'Verify post-staging FABLE output hash (--output --expected-sha)',
        gate: 'Run full gate: staging+pack; execute only with --allow-execute',
      },
      constants: {
        FABLE_MODEL,
        FABLE_EFFORT,
        FABLE_OUTPUT_FORMAT,
        BLOCKED_FABLE_UNAVAILABLE,
        STAGING_EVIDENCE_REQUIRED,
        REQUIRED_SUPPLY_KEYS,
        MISSION_QUESTIONS,
      },
      note: 'Default gate does not invoke FABLE. --allow-execute requires staging PASS.',
    })
    return 0
  }

  if (cmd === 'print-argv') {
    const argvExact = buildExactFableArgv({
      prompt: args.prompt,
      claudeBin: args.bin,
    })
    printJson({ ok: true, argv: argvExact, assert: assertExactFableArgv(argvExact) })
    return 0
  }

  if (cmd === 'check-argv') {
    const raw = args.argv ?? args._[1]
    const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw
    const result = assertExactFableArgv(parsed)
    printJson(result)
    return result.ok ? 0 : 2
  }

  if (cmd === 'check-staging') {
    const staging = args.staging ?? args._[1]
    const result = evaluateStagingEvidencePrecondition(staging)
    printJson(result)
    return result.ok ? 0 : 2
  }

  if (cmd === 'pack') {
    const supplyPath = args.supply ?? args._[1]
    if (!supplyPath) {
      printJson({ ok: false, code: SUPPLY_PACK_INCOMPLETE, reason: '--supply required' })
      return 2
    }
    const supply = loadJsonArg(supplyPath, 'supply')
    if (args.ledger) {
      const led = resolvePriorLedger(args.ledger)
      if (!led.ok) {
        printJson({ ok: false, code: SUPPLY_PACK_INCOMPLETE, reason: led.reason })
        return 2
      }
      supply.priorReviewFindingLedger = led.ledger
    }
    const pack = assembleEvidenceBundle(supply)
    if (pack.ok && args.out) {
      mkdirSync(dirname(args.out), { recursive: true })
      writeFileSync(args.out, `${JSON.stringify(pack.bundle, null, 2)}\n`)
    }
    printJson(pack)
    return pack.ok ? 0 : 2
  }

  if (cmd === 'verify-output') {
    const result = verifyPostStagingFableOutputHash({
      outputPath: args.output ?? args._[1],
      expectedSha256: args['expected-sha'] ?? args.expected ?? args._[2],
    })
    printJson(result)
    return result.ok ? 0 : 2
  }

  if (cmd === 'gate') {
    const staging = args.staging
    const supplyPath = args.supply
    if (!staging || !supplyPath) {
      printJson({
        ok: false,
        code: STAGING_EVIDENCE_REQUIRED,
        reason: 'gate requires --staging and --supply',
      })
      return 2
    }
    const supply = loadJsonArg(supplyPath, 'supply')
    if (args.ledger) {
      const led = resolvePriorLedger(args.ledger)
      if (!led.ok) {
        printJson({ ok: false, code: SUPPLY_PACK_INCOMPLETE, reason: led.reason })
        return 2
      }
      supply.priorReviewFindingLedger = led.ledger
    }
    const result = runPostStagingFableGate({
      stagingEvidence: staging,
      supply,
      allowExecute: args['allow-execute'] === true || args['allow-execute'] === 'true',
      prompt: args.prompt,
      outputPath: args.out,
      expectedOutputSha256: args['expected-sha'],
      claudeBin: args.bin,
    })
    printJson(result)
    if (result.status === 'READY_TO_INVOKE' || result.status === 'FABLE_OUTPUT_OK') return 0
    return 2
  }

  printJson({ ok: false, reason: `unknown command: ${cmd}` })
  return 2
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === resolve(process.argv[1])

if (isMain) {
  process.exit(main())
}

// Named re-export surface for tests / importers
export default {
  SCHEMA_VERSION,
  FABLE_MODEL,
  FABLE_EFFORT,
  FABLE_OUTPUT_FORMAT,
  BLOCKED_FABLE_UNAVAILABLE,
  STAGING_EVIDENCE_REQUIRED,
  SUPPLY_PACK_INCOMPLETE,
  FABLE_SUBSTITUTION_FORBIDDEN,
  FABLE_OUTPUT_HASH_MISMATCH,
  MISSION_QUESTIONS,
  REQUIRED_SUPPLY_KEYS,
  DEFAULT_PRIOR_LEDGER_PATH,
  sha256Of,
  sha256File,
  buildExactFableArgv,
  assertExactFableArgv,
  evaluateStagingEvidencePrecondition,
  validateMissionEvidenceMap,
  assembleEvidenceBundle,
  resolvePriorLedger,
  verifyPostStagingFableOutputHash,
  evaluateFableProcessResult,
  runPostStagingFableGate,
  buildDefaultPostStagingPrompt,
  main,
}
