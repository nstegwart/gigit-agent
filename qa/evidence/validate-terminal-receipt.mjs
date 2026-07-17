#!/usr/bin/env node
/**
 * TM-P0 terminal receipt / schema validator (non-mutating).
 *
 * Spec anchors (AGENT_TASK_ORCHESTRATOR.md):
 *   - exact path :60-61
 *   - gate truth  :154-177
 *   - claim-audit :2629-2653
 *   - independent verifier :2706-2731
 *   - TERMINAL RECEIPT fields :2736-2767
 *   - forbidden: live P0 PASS, production deploy, secret copy, worktree :2769-2773
 *
 * Reads the receipt (+ cited evidence files) and prints a JSON report.
 * Never creates/edits the terminal PASS receipt, CONTRACT, or product source.
 * Fabricated / stale / missing PASS → FAIL with codes.
 *
 * Usage:
 *   node qa/evidence/validate-terminal-receipt.mjs
 *   node qa/evidence/validate-terminal-receipt.mjs --receipt <path>
 *   node qa/evidence/validate-terminal-receipt.mjs --receipt <path> --allow-non-canonical-path
 *   node qa/evidence/validate-terminal-receipt.mjs --self-test
 *
 * Exit 0 = schema PASS. Exit 1 = FAIL / MISSING. Exit 2 = usage error.
 */

import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import {
  dirname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path'
import { fileURLToPath } from 'node:url'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

/** Repo root when script lives at qa/evidence/*.mjs */
export const REPO_ROOT_DEFAULT = resolve(__dirname, '../..')

export const SCHEMA_VERSION = 'TM_P0_TERMINAL_RECEIPT_SCHEMA_V1'

/** Exact terminal receipt path (relative to authoritative source repo). */
export const EXACT_TERMINAL_RECEIPT_REL =
  '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/WORKER_RESULT_TM_P0_ULTIMATE_CONTROL_CENTER_V3.md'

export const EVIDENCE_ROOT_REL =
  '.artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/'

export const ALLOWED_STATUSES = Object.freeze([
  'NOT READY',
  'LOCAL ONLY',
  'FUNCTIONAL',
  'DONE',
  'BLOCKED',
])

export const STAGING_GATE = 'TASK_MANAGER_STAGING_VERIFIED'
export const LIVE_AWAITING = 'AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK'
export const LIVE_P0_TARGET = 'P0_TASK_MANAGER_MCP_PUBLIC_DASHBOARD_PASS'
export const STAGING_MACHINE_PAYLOAD_BEGIN =
  'BEGIN_TASK_MANAGER_STAGING_MACHINE_RECORD'
export const STAGING_MACHINE_PAYLOAD_END =
  'END_TASK_MANAGER_STAGING_MACHINE_RECORD'
export const CANONICAL_STAGING_MACHINE_RECORD =
  'TASK_MANAGER_STAGING_VERIFIED: program-emitted PASS'

/**
 * Required field markers from TERMINAL RECEIPT list (L2736-2767).
 * Each entry: id + regexes; ANY match counts as present.
 * @type {ReadonlyArray<{ id: string, patterns: RegExp[] }>}
 */
export const REQUIRED_FIELDS = Object.freeze([
  {
    id: 'status',
    patterns: [
      /^(?:status:\s*)?(?:NOT READY|LOCAL ONLY|FUNCTIONAL|DONE|BLOCKED)\s*$/im,
      /\bstatus\b/i,
    ],
  },
  {
    id: 'staging_gate_TASK_MANAGER_STAGING_VERIFIED',
    patterns: [/\bTASK_MANAGER_STAGING_VERIFIED\b/],
  },
  {
    id: 'live_P0_AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK',
    patterns: [/\bAWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK\b/],
  },
  {
    id: 'RESOLVED_TARGET_and_environment_table',
    patterns: [/\bRESOLVED_TARGET\b/, /environment\s+table/i],
  },
  {
    id: 'authoritative_repo_host_branch_upstream_SHA',
    patterns: [
      /authoritative\s+(repo|source)/i,
      /\b(branch|upstream|start\s*SHA|final\s*SHA|full\s*SHA)\b/i,
    ],
  },
  {
    id: 'allowed_changed_forbidden_path_proof',
    patterns: [
      /allowed\s*\/?\s*changed\s*\/?\s*forbidden/i,
      /forbiddenPathspecs?/i,
      /path\s*proof/i,
      /pathspecs?/i,
    ],
  },
  {
    id: 'portable_FABLE_review_delta_receipts_hashes',
    patterns: [
      /\bFABLE\b/,
      /portable.*(?:URI|receipt)/i,
      /01-task-manager-fable5/i,
    ],
  },
  {
    id: 'finding_ledger',
    patterns: [
      /finding\s+ledger/i,
      /advisory\s+finding/i,
      /ACCEPTED_PENDING_IMPLEMENTATION/,
    ],
  },
  {
    id: 'live_auth_observedAt_readback',
    patterns: [/live\s+auth/i, /observedAt/i, /auth.*readback/i],
  },
  {
    id: 'lifecycle_enum_mapping',
    patterns: [
      /lifecycle\s+enum/i,
      /lifecycle\s+mapping/i,
      /LIFECYCLE_MAPPING/,
    ],
  },
  {
    id: 'threat_model_RBAC',
    patterns: [/threat\s*model/i, /\bRBAC\b/],
  },
  {
    id: 'canonical_import_DISTINCT_lifecycle_G5_rollup',
    patterns: [/canonical\s+import/i, /\bDISTINCT\b/, /\bG5\b/, /rollup/i],
  },
  {
    id: 'dispatch_runner_account_conformance',
    patterns: [
      /dispatch.*(?:runner|account)/i,
      /account\s+conformance/i,
      /runner.*account/i,
      /accounts?-?sync/i,
    ],
  },
  {
    id: 'capacity_priority_fail_closed',
    patterns: [/capacity/i, /priority/i, /fail[- ]?closed/i],
  },
  {
    id: 'collision_integration_lock_evidence',
    patterns: [/collision/i, /integration\s+lock/i, /named\s+lock/i],
  },
  {
    id: 'migration_staging_data_reconciliation',
    patterns: [/migration/i, /staging[- ]data/i, /reconcil/i],
  },
  {
    id: 'health_log_metrics_alerts',
    patterns: [/healthz?|health\//i, /\bmetrics?\b/i, /\balerts?\b/i],
  },
  {
    id: 'UI_screenshots_accessibility',
    patterns: [/screenshot/i, /accessibility|\baxe\b|WCAG/i, /\bUI\b/],
  },
  {
    id: 'performance_freshness',
    patterns: [/performance|perf\b/i, /freshness/i],
  },
  {
    id: 'prior_SHA_rollback_current_SHA_recovery',
    patterns: [
      /prior[- ]?SHA|previous\s+SHA|rollback/i,
      /current[- ]?SHA\s+recovery|forward[- ]?fix/i,
    ],
  },
  {
    id: 'ibils_regression_or_blocker',
    patterns: [/\bibils\b/i, /regression/i],
  },
  {
    id: 'independent_verifier_receipt',
    patterns: [
      /independent\s+verifier/i,
      /gpt-5\.3-codex-spark|gpt-5\.6-sol|opposite-model/i,
    ],
  },
  {
    id: 'claim_audit_output',
    patterns: [/claim[- ]?audit/i],
  },
  {
    id: 'per_checkpoint_Grok_integration_receipts',
    patterns: [
      /per[- ]?checkpoint/i,
      /checkpoint\s+integration/i,
      /Grok\s+integration\s+receipt/i,
      /integration\s+receipt/i,
    ],
  },
  {
    id: 'known_residual_risks',
    patterns: [/residual[_\s-]?risk/i, /residual_gaps:/i, /known\s+residual/i],
  },
  {
    id: 'no_production_no_secret_no_worktree',
    patterns: [/no[- ]production/i, /no[- ]secret/i, /no[- ]worktree/i],
  },
])

/** Patterns that claim live P0 passed (forbidden on staging terminal). */
export const FORBIDDEN_LIVE_PASS_PATTERNS = Object.freeze([
  /\bP0_TASK_MANAGER_MCP_PUBLIC_DASHBOARD_PASS\s*[:=]\s*(?:(?:program[- ]?emitted|program[- ]?output|machine[- ]?emitted|tool[- ]?emitted)\s*(?:(?:verdict|result|status)\s*)?[:=]?\s*)?PASS\b/i,
  /\blive\s+P0\s+(?:(?:program[- ]?emitted|program[- ]?output|machine[- ]?emitted|tool[- ]?emitted)\s*(?:(?:verdict|result|status)\s*)?[:=]?\s*)?(?:PASS|PASSED|VERIFIED)\b/i,
  /\bLIVE\s+P0\s*[:=]\s*(?:(?:program[- ]?emitted|program[- ]?output|machine[- ]?emitted|tool[- ]?emitted)\s*(?:(?:verdict|result|status)\s*)?[:=]?\s*)?PASS\b/i,
  /\bmass\s+(?:refill|dispatch)\s+unlock(?:ed)?\b/i,
  /\bproduction\s+deploy(?:ed|ment)?\s*[:=]?\s*(?:(?:program[- ]?emitted|program[- ]?output|machine[- ]?emitted|tool[- ]?emitted)\s*(?:(?:verdict|result|status)\s*)?[:=]?\s*)?(?:PASS|PASSED|DONE|OK|true)\b/i,
  /\bproduction\s+deploy(?:ed|ment)?\s*[:=]?\s*(?:BEGIN_TASK_MANAGER_STAGING_MACHINE_RECORD\s*)?TASK_MANAGER_STAGING_VERIFIED:\s*program-emitted\s+PASS\b/i,
])

export const ATTRIBUTED_PASS_PATTERNS = Object.freeze([
  /\b(?:no|not|without)\b\s*(?:(?:any|a)\s+)?(?:manual(?:ly)?(?:\s+(?:asserted|entered|typed))?|hand[- ]?typed|operator[- ]?entered|fabricated|invented|assumed)\s+PASS(?:ED)?\b/gi,
])

function stagingMachinePayloadBlockPattern() {
  return /(^|\r?\n)BEGIN_TASK_MANAGER_STAGING_MACHINE_RECORD[\t ]*\r?\n([\s\S]*?)\r?\nEND_TASK_MANAGER_STAGING_MACHINE_RECORD[\t ]*(?=\r?\n|$)/g
}

export function normalizeStagingMachinePayload(payload) {
  return payload
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[\t ]+$/g, ''))
    .join('\n')
    .trim()
}

export function extractStagingMachinePayloads(body) {
  return [...body.matchAll(stagingMachinePayloadBlockPattern())].map(
    (match) => {
      const payload = match[2]
      const normalized = normalizeStagingMachinePayload(payload)
      return {
        payload,
        normalized,
        valid: normalized === CANONICAL_STAGING_MACHINE_RECORD,
      }
    },
  )
}

function maskAttributedPassClauses(body) {
  const machineMasked = body.replace(
    stagingMachinePayloadBlockPattern(),
    (block, _prefix, payload) => {
      if (
        normalizeStagingMachinePayload(payload) !==
        CANONICAL_STAGING_MACHINE_RECORD
      ) {
        return block
      }
      return block.replace(/\bPASS\b/, (token) => ' '.repeat(token.length))
    },
  )
  return ATTRIBUTED_PASS_PATTERNS.reduce(
    (masked, pattern) =>
      masked.replace(pattern, (clause) => clause.replace(/[^\r\n]/g, ' ')),
    machineMasked,
  )
}

export function detectManualOrFabricatedPass(body) {
  const masked = maskAttributedPassClauses(body)
  const hits = []
  for (const match of masked.matchAll(/\bPASS(?:ED)?\b/gi)) {
    const offset = match.index ?? 0
    const line = body.slice(0, offset).split(/\r?\n/u).length
    hits.push(`line:${line}:UNATTRIBUTED_PASS`)
  }
  return [...new Set(hits)]
}

const FULL_RELEASE_SHA_RE = /^[a-f0-9]{40}$/

export function extractReleaseSha(body) {
  const values = [...body.matchAll(/^release_sha\s*:\s*(.*?)\s*$/gim)].map(
    (match) => match[1].trim(),
  )
  const validValues = values.filter((value) => FULL_RELEASE_SHA_RE.test(value))
  return {
    values,
    validValues,
    releaseSha:
      values.length === 1 && validValues.length === 1 ? validValues[0] : null,
  }
}

const HEX64_RE = /\b([a-f0-9]{64})\b/gi
const PATHISH_RE =
  /(?:^|[\s`"'(|])((?:\.\/)?(?:\.artifact|qa|tests|src|docs|migrations|deploy|WORKER_RESULT|fixture)[A-Za-z0-9_./@+-]*\.(?:md|json|png|txt|log|mjs|ts|tsx|sql|gz|sha256))\b/g

/**
 * @param {string | Buffer} data
 * @returns {string}
 */
export function sha256Hex(data) {
  return createHash('sha256').update(data).digest('hex')
}

/**
 * @param {string} root
 * @param {string} p
 * @returns {string}
 */
export function resolveUnderRoot(root, p) {
  if (isAbsolute(p)) return normalize(p)
  return resolve(root, p)
}

/**
 * @param {string} root
 * @param {string} candidate
 * @returns {{ abs: string, rel: string, exists: boolean }}
 */
export function resolveEvidencePath(root, candidate) {
  let raw = candidate.trim().replace(/^file:\/\//, '')
  raw = raw.replace(/[),.;:]+$/, '')
  const abs = isAbsolute(raw) ? normalize(raw) : resolve(root, raw)
  const rel = relative(root, abs)
  return {
    abs,
    rel,
    exists: existsSync(abs) && statSync(abs).isFile(),
  }
}

/**
 * @param {string} body
 * @returns {string | null}
 */
export function extractStatus(body) {
  const final = body.match(
    /^final_status:\s*(NOT READY|LOCAL ONLY|FUNCTIONAL|DONE|BLOCKED)\s*$/im,
  )
  if (final) return final[1]
  const m = body.match(
    /^(?:status:\s*)(NOT READY|LOCAL ONLY|FUNCTIONAL|DONE|BLOCKED)\s*$/im,
  )
  if (m) return m[1]
  const m2 = body.match(/^(NOT READY|LOCAL ONLY|FUNCTIONAL|DONE|BLOCKED)\s*$/m)
  return m2 ? m2[1] : null
}

/** Extract the compact WORKER_CONTRACT terminal fields. */
export function extractTerminalContract(body) {
  const runIds = [...body.matchAll(/^run_id:\s*(\S[^\r\n]*)$/gm)].map((match) =>
    match[1].trim(),
  )
  const finalStatuses = [
    ...body.matchAll(
      /^final_status:\s*(NOT READY|LOCAL ONLY|FUNCTIONAL|DONE|BLOCKED)\s*$/gm,
    ),
  ].map((match) => match[1])
  const residual =
    body.match(/^residual_gaps:\s*(\S[^\r\n]*)$/m)?.[1]?.trim() ?? null
  const runIdValid =
    runIds.length === 1 &&
    !/[<>]|\b(?:TBD|UNKNOWN|PLACEHOLDER|N\/A)\b/i.test(runIds[0])
  const uncertainty =
    /^UNCERTAINTY:\s*\S.+$/m.test(body) ||
    /^UNCERTAINTY:\s*\r?\n\s*-\s*\S.+$/m.test(body)
  const evidenceSection = /^(?:#{1,6}\s*)?evidence:\s*$/im.test(body)
  const commandEvidence = /^\s*-?\s*command:\s*\S.+$/im.test(body)
  const exitCodeEvidence = /^\s*(?:-?\s*)?exit_code:\s*\d+\s*$/im.test(body)
  const filesSection = /^(?:#{1,6}\s*)?files_touched:\s*(?:\S.*)?$/im.test(body)
  const filesEvidence =
    /^(?:#{1,6}\s*)?files_touched:\s*\S.+$/im.test(body) ||
    /^(?:#{1,6}\s*)?files_touched:\s*\r?\n\s*-\s*\S.+$/im.test(body)
  const finalLine =
    body.replace(/\r\n/g, '\n').trimEnd().split('\n').at(-1) ?? ''
  const endExact = finalLine === 'WORKER_RESULT_END'
  const manualPassHits = detectManualOrFabricatedPass(body)
  return {
    runIds,
    runIdValid,
    finalStatuses,
    residual,
    uncertainty,
    evidenceSection,
    commandEvidence,
    exitCodeEvidence,
    filesSection,
    filesEvidence,
    endExact,
    manualPassHits,
  }
}

/**
 * @param {string} body
 * @param {string | null} status
 * @returns {boolean}
 */
export function claimsStagingVerifiedPass(body, _status) {
  return countStagingMachinePassRecords(body) > 0
}

function countStagingMachinePassRecords(body) {
  return extractStagingMachinePayloads(body).filter((payload) => payload.valid)
    .length
}

/**
 * Extract hash-bound evidence pointers (path + expected sha256 near each other).
 * @param {string} body
 * @returns {Array<{ path: string, sha256: string, line: number }>}
 */
export function extractHashBoundPointers(body) {
  const lines = body.split(/\r?\n/)
  /** @type {Array<{ path: string, sha256: string, line: number }>} */
  const out = []
  const seen = new Set()

  for (let i = 0; i < lines.length; i++) {
    const window = [lines[i], lines[i + 1] ?? '', lines[i - 1] ?? ''].join('\n')
    const hashes = [...window.matchAll(HEX64_RE)].map((m) => m[1].toLowerCase())
    if (!hashes.length) continue

    const paths = new Set()
    for (const chunk of [lines[i], lines[i + 1] ?? '', lines[i - 1] ?? '']) {
      for (const m of chunk.matchAll(PATHISH_RE)) {
        paths.add(m[1])
      }
      const absMatches = chunk.matchAll(
        /(\/(?:Users|home|opt|var|tmp|private)\/[A-Za-z0-9_./@+-]+\.(?:md|json|png|txt|log|mjs|ts|tsx|sql|gz|sha256))/g,
      )
      for (const m of absMatches) paths.add(m[1])
    }

    for (const p of paths) {
      for (const h of hashes) {
        const key = `${p}|${h}`
        if (seen.has(key)) continue
        if (p.toLowerCase().includes(h)) continue
        seen.add(key)
        out.push({ path: p, sha256: h, line: i + 1 })
      }
    }
  }
  return out
}

/**
 * @param {string} body
 * @returns {string[]}
 */
export function extractCheckpointReceiptPaths(body) {
  const paths = new Set()
  for (const m of body.matchAll(
    /((?:WORKER_RESULT_|C\d|checkpoint|integration)[A-Za-z0-9_./@+-]*\.(?:md|json))/gi,
  )) {
    paths.add(m[1])
  }
  return [...paths]
}

/**
 * @param {string} body
 * @returns {{ mentioned: boolean, paths: string[], models: string[] }}
 */
export function extractIndependentVerifier(body) {
  const mentioned =
    /independent\s+verifier/i.test(body) ||
    /root[- ]dispatched\s+verifier/i.test(body) ||
    /opposite[- ]model/i.test(body)
  const paths = []
  for (const m of body.matchAll(
    /((?:SPARK_|SOL_|WORKER_RESULT_.*(?:SPARK|SOL|VERIFIER|INDEPENDENT)[A-Za-z0-9_./@+-]*)\.(?:md|json))/gi,
  )) {
    paths.push(m[1])
  }
  for (const m of body.matchAll(PATHISH_RE)) {
    if (/verifier|spark|sol|independent/i.test(m[1])) paths.push(m[1])
  }
  const models = []
  if (/gpt-5\.3-codex-spark/i.test(body)) models.push('gpt-5.3-codex-spark')
  if (/gpt-5\.6-sol/i.test(body)) models.push('gpt-5.6-sol')
  return { mentioned, paths: [...new Set(paths)], models }
}

/**
 * @param {string} body
 * @returns {{ mentioned: boolean, hasProgramOutput: boolean, hasSelfTest: boolean, paths: string[] }}
 */
export function extractClaimAudit(body) {
  const mentioned = /claim[- ]?audit/i.test(body)
  const hasProgramOutput =
    /program[- ]output/i.test(body) ||
    /claim-audit\.mjs/i.test(body) ||
    /--claim\b/.test(body) ||
    /--program-output\b/.test(body) ||
    /claim[- ]?audit[^\n]{0,80}exit\s*(?:code\s*)?[:=]?\s*\d+/i.test(body)
  const hasSelfTest = /--self-test|self[- ]test/i.test(body)
  const paths = []
  for (const m of body.matchAll(
    /([A-Za-z0-9_./@+-]*(?:claim[-_]?audit|program[-_]?output)[A-Za-z0-9_./@+-]*\.(?:md|json|log|txt|mjs))/gi,
  )) {
    paths.push(m[1])
  }
  return {
    mentioned,
    hasProgramOutput,
    hasSelfTest,
    paths: [...new Set(paths)],
  }
}

/**
 * @param {string} body
 * @returns {{ ok: boolean, missing: string[] }}
 */
export function checkNoProdSecretWorktree(body) {
  const hasTriple =
    /no[- ]production/i.test(body) &&
    /no[- ]secret/i.test(body) &&
    /no[- ]worktree/i.test(body)
  if (hasTriple) return { ok: true, missing: [] }

  const missing = []
  if (
    !/no[- ]production/i.test(body) &&
    !/productionDeploymentApproved\s*[:=]\s*false/i.test(body)
  ) {
    missing.push('no-production')
  }
  if (
    !/no[- ]secret/i.test(body) &&
    !/do not copy.*secret|Cairn secret/i.test(body)
  ) {
    missing.push('no-secret')
  }
  if (!/no[- ]worktree/i.test(body) && !/\bworktree\b/i.test(body)) {
    missing.push('no-worktree')
  }
  return { ok: missing.length === 0, missing }
}

/**
 * @param {string} body
 * @returns {{ id: string, present: boolean }[]}
 */
export function checkRequiredFields(body) {
  return REQUIRED_FIELDS.map((field) => ({
    id: field.id,
    present: field.patterns.some((re) => re.test(body)),
  }))
}

/**
 * Core validation (filesystem reads only; never writes product/terminal PASS).
 *
 * @param {object} opts
 * @param {string} [opts.root]
 * @param {string} [opts.receiptPath]
 * @param {string} [opts.body]
 * @param {boolean} [opts.allowNonCanonicalPath]
 * @param {boolean} [opts.requireFileExists]
 * @param {string} [opts.expectedReleaseSha]
 * @returns {object}
 */
export function validateTerminalReceipt(opts = {}) {
  const root = resolve(opts.root ?? REPO_ROOT_DEFAULT)
  const allowNonCanonicalPath = Boolean(opts.allowNonCanonicalPath)
  const requireFileExists = opts.requireFileExists !== false

  const exactAbs = resolve(root, EXACT_TERMINAL_RECEIPT_REL)
  const receiptInput = opts.receiptPath
    ? resolveUnderRoot(root, opts.receiptPath)
    : exactAbs

  /** @type {string[]} */
  const errors = []
  /** @type {string[]} */
  const warnings = []
  /** @type {Record<string, unknown>} */
  const checks = {}

  const receiptRel = relative(root, receiptInput)
  const pathExact =
    normalize(receiptInput) === normalize(exactAbs) ||
    normalize(receiptRel) === normalize(EXACT_TERMINAL_RECEIPT_REL)
  checks.path_exact = {
    ok: pathExact || allowNonCanonicalPath,
    expected: EXACT_TERMINAL_RECEIPT_REL,
    actual: receiptRel.startsWith('..') ? receiptInput : receiptRel,
    allowNonCanonicalPath,
  }
  if (!pathExact && !allowNonCanonicalPath) {
    errors.push('PATH_NOT_EXACT')
  }

  let body = opts.body
  const fileExists = existsSync(receiptInput) && statSync(receiptInput).isFile()
  checks.file_exists = { ok: fileExists || body != null, path: receiptInput }

  if (!fileExists && body == null) {
    if (requireFileExists) errors.push('PATH_MISSING')
    return finalizeReport({
      root,
      receiptPath: receiptInput,
      receiptRel: pathExact ? EXACT_TERMINAL_RECEIPT_REL : receiptRel,
      body: null,
      status: null,
      checks,
      errors,
      warnings,
      fields: REQUIRED_FIELDS.map((f) => ({ id: f.id, present: false })),
      hashPointers: [],
      claimAudit: null,
      independentVerifier: null,
      noProd: null,
      claimsStagingPass: false,
    })
  }

  if (body == null) {
    body = readFileSync(receiptInput, 'utf8')
  }

  const status = extractStatus(body)
  checks.status = {
    ok: status != null && ALLOWED_STATUSES.includes(status),
    value: status,
    allowed: [...ALLOWED_STATUSES],
  }
  if (!checks.status.ok) errors.push('STATUS_INVALID_OR_MISSING')

  const terminalContract = extractTerminalContract(body)
  checks.terminal_contract = {
    ok:
      terminalContract.runIdValid &&
      terminalContract.finalStatuses.length === 1 &&
      terminalContract.residual != null &&
      terminalContract.uncertainty &&
      terminalContract.evidenceSection &&
      terminalContract.commandEvidence &&
      terminalContract.exitCodeEvidence &&
      terminalContract.filesSection &&
      terminalContract.filesEvidence &&
      terminalContract.endExact &&
      terminalContract.manualPassHits.length === 0,
    ...terminalContract,
  }
  if (!terminalContract.runIdValid) errors.push('RUN_ID_EXACTLY_ONE_REQUIRED')
  if (terminalContract.finalStatuses.length !== 1) {
    errors.push('FINAL_STATUS_EXACTLY_ONE_REQUIRED')
  }
  if (terminalContract.residual == null) errors.push('RESIDUAL_GAPS_MISSING')
  if (!terminalContract.uncertainty) errors.push('UNCERTAINTY_SECTION_MISSING')
  if (
    !terminalContract.evidenceSection ||
    !terminalContract.commandEvidence ||
    !terminalContract.exitCodeEvidence
  ) {
    errors.push('PROGRAM_EVIDENCE_MISSING')
  }
  if (!terminalContract.filesSection || !terminalContract.filesEvidence) {
    errors.push('FILES_TOUCHED_MISSING')
  }
  if (terminalContract.manualPassHits.length)
    errors.push('MANUAL_OR_FABRICATED_PASS')

  const fields = checkRequiredFields(body)
  const missingFields = fields.filter((f) => !f.present).map((f) => f.id)
  checks.required_fields = {
    ok: missingFields.length === 0,
    missing: missingFields,
    presentCount: fields.filter((f) => f.present).length,
    requiredCount: fields.length,
  }
  if (missingFields.length) errors.push('MISSING_REQUIRED_FIELDS')

  const hasStagingGate = /\bTASK_MANAGER_STAGING_VERIFIED\b/.test(body)
  const hasLiveAwaiting =
    /\bAWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK\b/.test(body)
  checks.staging_gate_present = { ok: hasStagingGate }
  checks.live_awaiting_present = { ok: hasLiveAwaiting }
  if (!hasStagingGate) errors.push('STAGING_GATE_TOKEN_MISSING')
  if (!hasLiveAwaiting) errors.push('LIVE_AWAITING_TOKEN_MISSING')

  const forbiddenHits = FORBIDDEN_LIVE_PASS_PATTERNS.filter((re) =>
    re.test(body),
  ).map((re) => re.source)
  checks.no_live_p0_pass = {
    ok: forbiddenHits.length === 0,
    hits: forbiddenHits,
  }
  if (forbiddenHits.length) errors.push('LIVE_P0_PASS_FORBIDDEN')

  const stagingMachinePayloads = extractStagingMachinePayloads(body)
  const stagingMachineRecordCount = stagingMachinePayloads.filter(
    (payload) => payload.valid,
  ).length
  const invalidStagingMachinePayloadCount = stagingMachinePayloads.filter(
    (payload) => !payload.valid,
  ).length
  const stagingMachinePayloadMarkersPresent =
    body.includes(STAGING_MACHINE_PAYLOAD_BEGIN) ||
    body.includes(STAGING_MACHINE_PAYLOAD_END)
  const stagingMachinePayloadBeginCount =
    body.split(STAGING_MACHINE_PAYLOAD_BEGIN).length - 1
  const stagingMachinePayloadEndCount =
    body.split(STAGING_MACHINE_PAYLOAD_END).length - 1
  const stagingMachinePayloadMarkersBalanced =
    stagingMachinePayloadBeginCount === stagingMachinePayloads.length &&
    stagingMachinePayloadEndCount === stagingMachinePayloads.length
  const claimsStagingPass = stagingMachineRecordCount > 0
  checks.staging_pass_claim = {
    claims: claimsStagingPass,
    machineRecordCount: stagingMachineRecordCount,
    payloadCount: stagingMachinePayloads.length,
    invalidPayloadCount: invalidStagingMachinePayloadCount,
    beginMarkerCount: stagingMachinePayloadBeginCount,
    endMarkerCount: stagingMachinePayloadEndCount,
    markersBalanced: stagingMachinePayloadMarkersBalanced,
  }
  if (stagingMachineRecordCount > 1) {
    errors.push('STAGING_MACHINE_RECORD_DUPLICATE')
  }
  if (
    invalidStagingMachinePayloadCount > 0 ||
    (stagingMachinePayloadMarkersPresent &&
      (!stagingMachinePayloadMarkersBalanced ||
        stagingMachinePayloads.length === 0))
  ) {
    errors.push('STAGING_MACHINE_PAYLOAD_INVALID')
  }
  if (claimsStagingPass && !hasLiveAwaiting) {
    errors.push('STAGING_PASS_WITHOUT_LIVE_AWAITING')
  }

  const release = extractReleaseSha(body)
  const expectedReleaseSha = opts.expectedReleaseSha ?? null
  const expectedReleaseShaValid =
    expectedReleaseSha == null || FULL_RELEASE_SHA_RE.test(expectedReleaseSha)
  const releaseShaMatchesExpected =
    release.releaseSha != null && expectedReleaseSha != null
      ? release.releaseSha === expectedReleaseSha
      : null
  checks.release_sha = {
    ok:
      !claimsStagingPass ||
      (release.values.length === 1 &&
        release.validValues.length === 1 &&
        expectedReleaseSha != null &&
        expectedReleaseShaValid &&
        releaseShaMatchesExpected === true),
    required: claimsStagingPass,
    fieldCount: release.values.length,
    validCount: release.validValues.length,
    value: release.releaseSha,
    expected: expectedReleaseShaValid ? expectedReleaseSha : null,
    matchesExpected: releaseShaMatchesExpected,
  }
  if (!expectedReleaseShaValid) errors.push('EXPECTED_RELEASE_SHA_INVALID')
  if (claimsStagingPass) {
    if (expectedReleaseSha == null) errors.push('EXPECTED_RELEASE_SHA_REQUIRED')
    if (release.values.length === 0) errors.push('RELEASE_SHA_MISSING')
    if (release.values.length > 1) errors.push('RELEASE_SHA_DUPLICATE')
    if (release.validValues.length !== release.values.length) {
      errors.push('RELEASE_SHA_INVALID')
    }
    if (releaseShaMatchesExpected === false) {
      errors.push('RELEASE_SHA_MISMATCH')
    }
  }

  const hashPointers = extractHashBoundPointers(body)
  const hashResults = hashPointers.map((ptr) => {
    const resolved = resolveEvidencePath(root, ptr.path)
    let actual = null
    let match = false
    let class_ = 'MISSING_FILE'
    if (resolved.exists) {
      actual = sha256Hex(readFileSync(resolved.abs))
      match = actual === ptr.sha256.toLowerCase()
      class_ = match ? 'OK' : 'STALE_HASH'
    }
    return {
      ...ptr,
      resolved: resolved.rel.startsWith('..') ? resolved.abs : resolved.rel,
      exists: resolved.exists,
      actualSha256: actual,
      match,
      class: class_,
    }
  })
  const staleHashes = hashResults.filter((r) => r.class === 'STALE_HASH')
  const missingHashFiles = hashResults.filter((r) => r.class === 'MISSING_FILE')
  checks.hash_bound_evidence = {
    ok:
      staleHashes.length === 0 &&
      !(claimsStagingPass && missingHashFiles.length > 0),
    pointerCount: hashResults.length,
    staleCount: staleHashes.length,
    missingFileCount: missingHashFiles.length,
    pointers: hashResults,
  }
  if (staleHashes.length) errors.push('STALE_HASH')
  if (claimsStagingPass && missingHashFiles.length) {
    errors.push('HASH_TARGET_MISSING')
  }
  if (claimsStagingPass && hashResults.length === 0) {
    errors.push('HASH_BOUND_EVIDENCE_MISSING')
  }
  if (!claimsStagingPass && hashResults.length === 0) {
    warnings.push('NO_HASH_BOUND_POINTERS_PARSED')
  }

  const checkpointPaths = extractCheckpointReceiptPaths(body)
  const checkpointHasKeyword =
    /per[- ]?checkpoint|checkpoint\s+integration|Grok\s+integration\s+receipt/i.test(
      body,
    )
  checks.checkpoint_receipts = {
    ok: checkpointHasKeyword,
    mentioned: checkpointHasKeyword,
    paths: checkpointPaths,
  }
  if (!checkpointHasKeyword) errors.push('CHECKPOINT_RECEIPTS_MISSING')

  const independentVerifier = extractIndependentVerifier(body)
  checks.independent_verifier = {
    ok: independentVerifier.mentioned,
    ...independentVerifier,
  }
  if (!independentVerifier.mentioned)
    errors.push('INDEPENDENT_VERIFIER_MISSING')

  const claimAudit = extractClaimAudit(body)
  checks.claim_audit = {
    ok:
      claimAudit.mentioned &&
      (!claimsStagingPass || claimAudit.hasProgramOutput),
    ...claimAudit,
  }
  if (!claimAudit.mentioned) errors.push('CLAIM_AUDIT_MISSING')
  if (claimsStagingPass && !claimAudit.hasProgramOutput) {
    errors.push('CLAIM_AUDIT_PROGRAM_OUTPUT_MISSING')
  }

  const noProd = checkNoProdSecretWorktree(body)
  checks.no_production_no_secret_no_worktree = noProd
  if (!noProd.ok) errors.push('NO_PROD_SECRET_WORKTREE_STATEMENT_INCOMPLETE')

  if (claimsStagingPass) {
    const criticalMissing = []
    if (!claimAudit.hasProgramOutput)
      criticalMissing.push('claim-audit-program-output')
    if (!independentVerifier.mentioned)
      criticalMissing.push('independent-verifier')
    if (!checkpointHasKeyword) criticalMissing.push('checkpoint-receipts')
    if (!hasLiveAwaiting) criticalMissing.push('live-awaiting')
    if (staleHashes.length) criticalMissing.push('stale-hash')
    if (hashResults.length === 0) criticalMissing.push('hash-bound-evidence')
    if (missingFields.length) criticalMissing.push('required-fields')
    checks.fabricated_pass = {
      ok: criticalMissing.length === 0,
      criticalMissing,
    }
    if (criticalMissing.length) errors.push('FABRICATED_OR_INCOMPLETE_PASS')
  } else {
    checks.fabricated_pass = {
      ok: true,
      criticalMissing: [],
      claimsStagingPass: false,
    }
  }

  if (/\bstatus\s*[:=]\s*PASS\b/i.test(body) && status == null) {
    errors.push('INVALID_PASS_STATUS_TOKEN')
  }

  if (!terminalContract.endExact) {
    warnings.push('MISSING_WORKER_RESULT_END')
    errors.push('MISSING_WORKER_RESULT_END')
  }

  return finalizeReport({
    root,
    receiptPath: receiptInput,
    receiptRel: pathExact ? EXACT_TERMINAL_RECEIPT_REL : receiptRel,
    body,
    status,
    checks,
    errors: [...new Set(errors)],
    warnings: [...new Set(warnings)],
    fields,
    hashPointers: hashResults,
    claimAudit,
    independentVerifier,
    noProd,
    claimsStagingPass,
    terminalContract,
    releaseSha: release.releaseSha,
    expectedReleaseSha: expectedReleaseShaValid ? expectedReleaseSha : null,
    releaseShaMatchesExpected,
  })
}

/**
 * @param {object} args
 * @returns {object}
 */
function finalizeReport(args) {
  const uniqueErrors = [...new Set(args.errors)]
  const verdict = uniqueErrors.length === 0 ? 'PASS' : 'FAIL'
  const bodySha = args.body != null ? sha256Hex(args.body) : null
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAt: new Date().toISOString(),
    nonMutating: true,
    exactTerminalReceiptRel: EXACT_TERMINAL_RECEIPT_REL,
    receiptPath: args.receiptPath,
    receiptRel: args.receiptRel,
    receiptSha256: bodySha,
    status: args.status,
    claimsStagingPass: args.claimsStagingPass,
    releaseSha: args.releaseSha ?? null,
    expectedReleaseSha: args.expectedReleaseSha ?? null,
    releaseShaMatchesExpected: args.releaseShaMatchesExpected ?? null,
    checks: args.checks,
    fields: args.fields,
    hashBoundPointers: args.hashPointers,
    claimAudit: args.claimAudit,
    independentVerifier: args.independentVerifier,
    noProductionNoSecretNoWorktree: args.noProd,
    terminalContract: args.terminalContract ?? null,
    errors: uniqueErrors,
    warnings: args.warnings,
    verdict,
    doesNotEmitTerminalPassReceipt: true,
    doesNotEditContract: true,
  }
}

/**
 * Build a structurally complete fixture body. Does NOT write the real terminal path.
 * @param {object} [opts]
 * @returns {string}
 */
export function buildFixtureReceipt(opts = {}) {
  const status = opts.status ?? 'LOCAL ONLY'
  const claimStagingPass = Boolean(opts.claimStagingPass)
  const omit = new Set(opts.omitFields ?? [])
  const pointers = opts.pointers ?? []
  const lines = [
    '# WORKER_RESULT TM-P0 terminal receipt fixture',
    `status: ${status}`,
    `final_status: ${status}`,
    'run_id: fixture-validate-terminal-receipt',
    '',
  ]

  if (opts.releaseSha !== undefined) {
    lines.push(`release_sha: ${opts.releaseSha}`)
  }

  if (!omit.has('staging_gate_TASK_MANAGER_STAGING_VERIFIED')) {
    if (claimStagingPass) {
      lines.push(`gate closed: ${STAGING_GATE}`)
      lines.push(STAGING_MACHINE_PAYLOAD_BEGIN)
      lines.push(CANONICAL_STAGING_MACHINE_RECORD)
      lines.push(STAGING_MACHINE_PAYLOAD_END)
    } else {
      lines.push(`${STAGING_GATE}: not yet emitted (fixture)`)
    }
  }
  if (!omit.has('live_P0_AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK')) {
    lines.push(`live P0 ${LIVE_P0_TARGET}: ${LIVE_AWAITING}`)
  }
  if (opts.liveP0Pass) {
    lines.push(`${LIVE_P0_TARGET}: PASS`)
    lines.push('live P0 PASS')
  }

  if (!omit.has('RESOLVED_TARGET_and_environment_table')) {
    lines.push(
      'RESOLVED_TARGET and environment table: see RESOLVED_TARGET.json',
    )
  }
  if (!omit.has('authoritative_repo_host_branch_upstream_SHA')) {
    lines.push(
      'authoritative repo/host/branch/upstream/start SHA/final SHA: fixture-repo main origin/main',
    )
  }
  if (!omit.has('allowed_changed_forbidden_path_proof')) {
    lines.push(
      'allowed/changed/forbidden path proof: forbiddenPathspecs listed in RESOLVED_TARGET',
    )
  }
  if (!omit.has('portable_FABLE_review_delta_receipts_hashes')) {
    lines.push(
      'portable raw FABLE review+delta receipt URIs, preserved hashes, advisory',
    )
    lines.push(
      'FABLE input: .artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/input/01-task-manager-fable5-xhigh-review.json',
    )
  }
  if (!omit.has('finding_ledger')) {
    lines.push('finding ledger: ACCEPTED_PENDING_IMPLEMENTATION items tracked')
  }
  if (!omit.has('live_auth_observedAt_readback')) {
    lines.push('live auth observedAt/readback: observedAt=fixture')
  }
  if (!omit.has('lifecycle_enum_mapping')) {
    lines.push('lifecycle enum mapping: LIFECYCLE_MAPPING_V1')
  }
  if (!omit.has('threat_model_RBAC')) {
    lines.push('threat model/RBAC: OWNER/ROOT/AGENT/INTEGRATOR/PUBLIC')
  }
  if (!omit.has('canonical_import_DISTINCT_lifecycle_G5_rollup')) {
    lines.push(
      'canonical import, DISTINCT readiness fields, ordered lifecycle receipts, derived G5, and rollup evidence',
    )
  }
  if (!omit.has('dispatch_runner_account_conformance')) {
    lines.push('dispatch/runner/account conformance: accounts-sync checked')
  }
  if (!omit.has('capacity_priority_fail_closed')) {
    lines.push('full capacity/priority fail-closed evidence')
  }
  if (!omit.has('collision_integration_lock_evidence')) {
    lines.push('collision/integration lock evidence: named lock')
  }
  if (!omit.has('migration_staging_data_reconciliation')) {
    lines.push('migration/staging-data/reconciliation evidence')
  }
  if (!omit.has('health_log_metrics_alerts')) {
    lines.push('health/log/metrics/alerts evidence: healthz ok')
  }
  if (!omit.has('UI_screenshots_accessibility')) {
    lines.push('UI/screenshots/accessibility: axe + screenshot manifest')
  }
  if (!omit.has('performance_freshness')) {
    lines.push('performance/freshness budgets')
  }
  if (!omit.has('prior_SHA_rollback_current_SHA_recovery')) {
    lines.push('actual prior-SHA rollback/current-SHA recovery')
  }
  if (!omit.has('ibils_regression_or_blocker')) {
    lines.push('ibils regression or exact blocker: residual open')
  }
  if (!omit.has('independent_verifier_receipt')) {
    lines.push(
      'independent verifier receipt: root-dispatched gpt-5.3-codex-spark opposite-model',
    )
    lines.push(
      'path: .artifact/evidence/TM-P0-ULTIMATE-CONTROL-CENTER-V3/SPARK_INDEPENDENT_VERDICT.md',
    )
  }
  if (!omit.has('claim_audit_output')) {
    if (claimStagingPass) {
      lines.push(
        'claim-audit output: node CONTRACT/qa/claim-audit.mjs --claim <terminal> --program-output <out>',
      )
      lines.push(
        'claim-audit program-output path: .artifact/claim-audit-program-output.json exit 0',
      )
      lines.push('AC-CLAIM-01 self-test exit 0; AC-CLAIM-02 exit 0')
    } else {
      lines.push('claim-audit output: not run (fixture; CONTRACT absent)')
    }
  }
  if (!omit.has('per_checkpoint_Grok_integration_receipts')) {
    lines.push(
      'immediate per-checkpoint Grok integration receipts: WORKER_RESULT_TM-P0-C0-INTEGRATOR.md',
    )
    lines.push('checkpoint integration receipt path listed above')
  }
  if (!omit.has('known_residual_risks')) {
    lines.push('known residual risks')
    lines.push('residual_gaps: fixture only')
  }
  if (!omit.has('no_production_no_secret_no_worktree')) {
    lines.push('no-production/no-secret/no-worktree statement: affirmed')
  }

  lines.push('')
  lines.push('evidence:')
  lines.push(
    '- command: node qa/evidence/validate-terminal-receipt.mjs --self-test',
  )
  lines.push('  exit_code: 0')
  lines.push('  artifact_path: .artifact/fixture-program-output.json')
  lines.push('files_touched:')
  lines.push('- qa/evidence/validate-terminal-receipt.mjs')
  lines.push('UNCERTAINTY:')
  lines.push('- fixture evidence only; no staging or production claim')

  lines.push('')
  lines.push('## Hash-bound evidence pointers')
  for (const p of pointers) {
    lines.push(`- path: ${p.path}`)
    lines.push(`  sha256: ${p.sha256}`)
  }

  if (opts.includeEnd !== false) {
    lines.push('')
    lines.push('WORKER_RESULT_END')
  }
  return `${lines.join('\n')}\n`
}

/**
 * Built-in self-test: never writes the real terminal PASS receipt.
 * @param {string} root
 * @returns {number}
 */
export function runSelfTest(root) {
  const dir = mkdtempSync(join(tmpdir(), 'tm-term-receipt-'))
  /** @type {string[]} */
  const failures = []

  try {
    const evidenceFile = join(dir, 'evidence-blob.json')
    const evidenceBody = JSON.stringify({ ok: true, fixture: 'hash-bound' })
    writeFileSync(evidenceFile, evidenceBody)
    const evidenceHash = sha256Hex(evidenceBody)

    const goodLocal = buildFixtureReceipt({
      status: 'LOCAL ONLY',
      claimStagingPass: false,
      pointers: [{ path: evidenceFile, sha256: evidenceHash }],
    })
    const r1 = validateTerminalReceipt({
      root,
      receiptPath: EXACT_TERMINAL_RECEIPT_REL,
      body: goodLocal,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    if (r1.verdict !== 'PASS') {
      failures.push(`good-local expected PASS, got ${r1.errors.join(',')}`)
    }

    const missing = buildFixtureReceipt({
      omitFields: ['claim_audit_output', 'independent_verifier_receipt'],
    })
    const r2 = validateTerminalReceipt({
      root,
      body: missing,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    if (r2.verdict === 'PASS') failures.push('missing-fields should FAIL')
    if (
      !r2.errors.includes('MISSING_REQUIRED_FIELDS') &&
      !r2.errors.includes('CLAIM_AUDIT_MISSING') &&
      !r2.errors.includes('INDEPENDENT_VERIFIER_MISSING')
    ) {
      failures.push(`missing-fields errors unexpected: ${r2.errors.join(',')}`)
    }

    const livePass = buildFixtureReceipt({ liveP0Pass: true })
    const r3 = validateTerminalReceipt({
      root,
      body: livePass,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    if (!r3.errors.includes('LIVE_P0_PASS_FORBIDDEN')) {
      failures.push('live-p0-pass should emit LIVE_P0_PASS_FORBIDDEN')
    }

    const fabricated = buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
      omitFields: ['claim_audit_output'],
      pointers: [],
    })
    const r4 = validateTerminalReceipt({
      root,
      body: fabricated,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    if (
      !r4.errors.includes('FABRICATED_OR_INCOMPLETE_PASS') &&
      !r4.errors.includes('CLAIM_AUDIT_PROGRAM_OUTPUT_MISSING')
    ) {
      failures.push(`fabricated-pass errors unexpected: ${r4.errors.join(',')}`)
    }

    writeFileSync(join(dir, 'stale-target.json'), '{"v":1}')
    const staleBody = buildFixtureReceipt({
      pointers: [
        {
          path: join(dir, 'stale-target.json'),
          sha256: '0'.repeat(64),
        },
      ],
    })
    const r5 = validateTerminalReceipt({
      root,
      body: staleBody,
      allowNonCanonicalPath: true,
      requireFileExists: false,
    })
    if (!r5.errors.includes('STALE_HASH')) {
      failures.push(
        `stale-hash expected STALE_HASH, got ${r5.errors.join(',')}`,
      )
    }

    const r6 = validateTerminalReceipt({
      root: dir,
      allowNonCanonicalPath: false,
      requireFileExists: true,
    })
    if (
      !r6.errors.includes('PATH_MISSING') &&
      !r6.errors.includes('PATH_NOT_EXACT')
    ) {
      failures.push(
        `missing-file expected PATH_MISSING, got ${r6.errors.join(',')}`,
      )
    }

    mkdirSync(join(dir, EVIDENCE_ROOT_REL), { recursive: true })
    const blobRel = 'fixture-evidence.json'
    const blobAbs = join(dir, blobRel)
    writeFileSync(blobAbs, '{"staging":true}')
    const blobHash = sha256Hex(readFileSync(blobAbs))
    const fullPass = buildFixtureReceipt({
      status: 'DONE',
      claimStagingPass: true,
      releaseSha: '1'.repeat(40),
      pointers: [{ path: blobRel, sha256: blobHash }],
    })
    const receiptAbs = join(dir, EXACT_TERMINAL_RECEIPT_REL)
    const r7 = validateTerminalReceipt({
      root: dir,
      receiptPath: receiptAbs,
      body: fullPass,
      allowNonCanonicalPath: false,
      requireFileExists: false,
      expectedReleaseSha: '1'.repeat(40),
    })
    if (r7.verdict !== 'PASS') {
      failures.push(
        `full-staging-pass fixture expected PASS, got ${r7.errors.join(',')}`,
      )
    }

    // Ensure self-test did not create/mutate the real terminal receipt with fixture marker
    const realTerminal = resolve(root, EXACT_TERMINAL_RECEIPT_REL)
    if (existsSync(realTerminal)) {
      const realBody = readFileSync(realTerminal, 'utf8')
      if (realBody.includes('fixture-validate-terminal-receipt')) {
        failures.push('self-test mutated real terminal receipt path')
      }
    }

    const report = {
      schemaVersion: SCHEMA_VERSION,
      mode: 'self-test',
      nonMutating: true,
      failures,
      verdict: failures.length ? 'FAIL' : 'PASS',
      cases: {
        goodLocal: r1.verdict,
        missingFields: r2.verdict,
        liveP0Pass: r3.verdict,
        fabricatedPass: r4.verdict,
        staleHash: r5.verdict,
        pathMissing: r6.verdict,
        fullStagingPass: r7.verdict,
      },
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
    return failures.length ? 1 : 0
  } finally {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {string[]} [argv]
 * @param {{ root?: string }} [env]
 * @returns {number}
 */
export function main(argv = process.argv.slice(2), env = {}) {
  const root = env.root ?? REPO_ROOT_DEFAULT

  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      [
        'Usage: node qa/evidence/validate-terminal-receipt.mjs [options]',
        '',
        'Options:',
        '  --receipt <path>              Receipt to validate (default: exact TM-P0 path)',
        '  --allow-non-canonical-path    Skip exact-path check (fixtures/unit tests)',
        '  --self-test                   Run built-in positive/negative fixture checks',
        '  --help                        This help',
        '',
        'Non-mutating: never writes the terminal PASS receipt or CONTRACT.',
        '',
      ].join('\n'),
    )
    return 0
  }

  if (argv.includes('--self-test')) {
    return runSelfTest(root)
  }

  let receiptPath = EXACT_TERMINAL_RECEIPT_REL
  const rIdx = argv.indexOf('--receipt')
  if (rIdx >= 0) {
    if (!argv[rIdx + 1]) {
      process.stderr.write('--receipt requires a path\n')
      return 2
    }
    receiptPath = argv[rIdx + 1]
  }

  const allowNonCanonicalPath = argv.includes('--allow-non-canonical-path')
  const report = validateTerminalReceipt({
    root,
    receiptPath,
    allowNonCanonicalPath,
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.verdict === 'PASS' ? 0 : 1
}

const isDirect =
  Boolean(process.argv[1]) && resolve(process.argv[1]) === resolve(__filename)

if (isDirect) {
  process.exit(main(process.argv.slice(2)))
}
