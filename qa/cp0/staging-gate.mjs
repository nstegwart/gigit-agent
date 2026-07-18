#!/usr/bin/env node
/**
 * Exact-SHA CP0 staging gate.
 *
 * `--plan` / `--dry-run` is read-only and never emits a staging PASS.
 * A PASS can only be computed from an explicit evidence JSON file.
 */
import { readFileSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { buildResolvedTarget } from '../evidence/validate-resolved-target.mjs'
import { captureEnvironmentTable } from '../evidence/capture-environment-table.mjs'
import { validateTerminalReceipt } from '../evidence/validate-terminal-receipt.mjs'

export const CP0_STAGING_GATE = 'CP0_EXACT_SHA_STAGING_GATE_V1'
/**
 * Historical CP0 control-plane baseline (migration 008 + CP0 tables).
 * This is the minimum schema for CP0 evidence — NOT the product schema latest.
 * Product manifest latest is SCHEMA_LATEST_VERSION (013). Do not relabel CP0-008
 * evidence as 013 proof; a host may be at 008 (CP0 only) or later (product).
 */
export const CP0_BASELINE_SCHEMA_VERSION = '008'
/** @deprecated Use CP0_BASELINE_SCHEMA_VERSION; kept as alias for historical imports. */
export const CP0_SCHEMA_VERSION = CP0_BASELINE_SCHEMA_VERSION
/** Current migration manifest tip (product schema latest). */
export const SCHEMA_LATEST_VERSION = '013'
/** CP0 minimum migration chain (000..008). Later versions are product expands. */
export const REQUIRED_MIGRATIONS = Object.freeze([
  '000',
  '001',
  '002',
  '003',
  '004',
  '005',
  '006',
  '007',
  '008',
])

export function validateGatePreflight({
  root = process.cwd(),
  resolvedTargetOptions = {},
  environmentOptions = {},
  terminalReceiptOptions = null,
  requireTerminalReceipt = false,
  expectedReleaseSha = null,
} = {}) {
  const resolvedTarget = buildResolvedTarget({
    root,
    ...resolvedTargetOptions,
  })
  const environmentTable = captureEnvironmentTable(environmentOptions)
  const resolvedHead = resolvedTarget.repo?.head ?? null
  const receiptExpectedReleaseSha =
    expectedReleaseSha ?? (fullSha(resolvedHead) ? resolvedHead : null)
  const terminalReceiptReport = terminalReceiptOptions
    ? validateTerminalReceipt({
        ...terminalReceiptOptions,
        root,
        expectedReleaseSha: receiptExpectedReleaseSha,
      })
    : null
  const terminalReceipt = terminalReceiptReport
    ? {
        schemaVersion: terminalReceiptReport.schemaVersion,
        verdict: terminalReceiptReport.verdict,
        errors: terminalReceiptReport.errors,
        warnings: terminalReceiptReport.warnings,
        status: terminalReceiptReport.status,
        claimsStagingPass: terminalReceiptReport.claimsStagingPass,
        releaseSha: terminalReceiptReport.releaseSha,
        expectedReleaseSha: terminalReceiptReport.expectedReleaseSha,
        releaseShaMatchesExpected:
          terminalReceiptReport.releaseShaMatchesExpected,
        receiptSha256: terminalReceiptReport.receiptSha256,
        pathExact: terminalReceiptReport.checks?.path_exact?.ok === true,
        terminalContractValid:
          terminalReceiptReport.checks?.terminal_contract?.ok === true,
        nonMutating: terminalReceiptReport.nonMutating,
      }
    : null
  const failures = []
  if (resolvedTarget.verdict !== 'PASS') {
    failures.push(
      ...resolvedTarget.errors.map((code) => `RESOLVED_TARGET_${code}`),
    )
  }
  if (environmentTable.verdict !== 'PASS') {
    failures.push(
      ...environmentTable.errors.map((code) => `ENVIRONMENT_TABLE_${code}`),
    )
  }
  if (expectedReleaseSha != null && !fullSha(expectedReleaseSha)) {
    failures.push('EXPECTED_RELEASE_SHA_INVALID')
  }
  if (
    fullSha(expectedReleaseSha) &&
    fullSha(resolvedHead) &&
    expectedReleaseSha !== resolvedHead
  ) {
    failures.push('EXPECTED_SHA_RESOLVED_HEAD_MISMATCH')
  }
  if (requireTerminalReceipt && !terminalReceipt) {
    failures.push('TERMINAL_RECEIPT_REQUIRED')
  }
  if (terminalReceipt?.verdict === 'FAIL') {
    failures.push(
      ...terminalReceipt.errors.map((code) => `TERMINAL_RECEIPT_${code}`),
    )
  }
  if (requireTerminalReceipt && terminalReceipt) {
    if (terminalReceipt.status !== 'DONE')
      failures.push('TERMINAL_RECEIPT_STATUS_NOT_DONE')
    if (terminalReceipt.claimsStagingPass !== true)
      failures.push('TERMINAL_RECEIPT_STAGING_PASS_REQUIRED')
  }
  return {
    gate: CP0_STAGING_GATE,
    ok: failures.length === 0,
    failures: [...new Set(failures)],
    resolvedTarget,
    environmentTable,
    terminalReceipt,
    stagingVerified: false,
    liveP0: false,
  }
}

function fullSha(value) {
  return typeof value === 'string' && /^[0-9a-f]{40}$/.test(value)
}

function gitRead(args, cwd = process.cwd()) {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) return null
  return result.stdout.trim()
}

export function buildPlan({
  expectedSha,
  target = 'staging',
  cwd = process.cwd(),
}) {
  if (!fullSha(expectedSha))
    throw new Error('expected SHA must be lowercase full 40-hex')
  if (target !== 'staging')
    throw new Error('this gate accepts target=staging only')
  const head = gitRead(['rev-parse', 'HEAD'], cwd)
  const dirty = Boolean(gitRead(['status', '--porcelain'], cwd))
  const headMatches = head === expectedSha
  return {
    gate: CP0_STAGING_GATE,
    mode: 'PLAN_ONLY',
    target,
    expectedSha,
    observedHead: head,
    headMatches,
    dirty,
    stagingVerified: false,
    liveP0: false,
    checksRequired: [
      'authenticated health HTTP 200',
      'observed release SHA equals expected SHA',
      `CP0 baseline schema ≥${CP0_BASELINE_SCHEMA_VERSION} with migrations 000..008 applied (product latest pin ${SCHEMA_LATEST_VERSION})`,
      'canonical hash and board/lifecycle revisions present',
      'sync IN_SYNC with effective backlog zero',
      'CP0 tests, secret scan, typecheck and build PASS',
      'independent current-SHA verifier PASS',
      'valid DONE terminal receipt with TASK_MANAGER_STAGING_VERIFIED PASS',
      'actual prior-SHA rollback and current-SHA restore evidence',
    ],
  }
}

function add(failures, condition, code) {
  if (!condition) failures.push(code)
}

export function validateEvidence(evidence, expectedSha, target = 'staging') {
  const failures = []
  add(failures, fullSha(expectedSha), 'EXPECTED_SHA_INVALID')
  add(failures, evidence && typeof evidence === 'object', 'EVIDENCE_REQUIRED')
  if (!evidence || typeof evidence !== 'object') {
    return {
      gate: CP0_STAGING_GATE,
      ok: false,
      failures,
      stagingVerified: false,
    }
  }

  add(
    failures,
    target === 'staging' && evidence.target === target,
    'TARGET_MISMATCH',
  )
  add(
    failures,
    evidence.expectedSha === expectedSha,
    'EVIDENCE_EXPECTED_SHA_MISMATCH',
  )
  add(failures, evidence.observedSha === expectedSha, 'OBSERVED_SHA_MISMATCH')

  const health = evidence.health ?? {}
  add(failures, health.authenticated === true, 'HEALTH_AUTH_NOT_PROVEN')
  add(failures, health.httpStatus === 200, 'HEALTH_HTTP_NOT_200')
  add(failures, health.status === 'ok', 'HEALTH_NOT_OK')
  add(failures, health.deployedSha === expectedSha, 'HEALTH_SHA_MISMATCH')
  add(failures, health.release?.match === true, 'HEALTH_RELEASE_MATCH_FALSE')
  // CP0 baseline: applied chain must include 000..008; schema version may be 008
  // (historical CP0 proof) or later product tip (e.g. 013). Never require falsely
  // that CP0-only 008 evidence equals product-latest 013.
  const appliedVersions = health.migration?.appliedVersions ?? []
  const schemaVersion =
    typeof health.schema?.version === 'string' ? health.schema.version : ''
  add(
    failures,
    REQUIRED_MIGRATIONS.every((version) => appliedVersions.includes(version)),
    'MIGRATION_CHAIN_INCOMPLETE',
  )
  add(
    failures,
    /^\d{3}$/.test(schemaVersion) &&
      schemaVersion >= CP0_BASELINE_SCHEMA_VERSION,
    'SCHEMA_BELOW_CP0_BASELINE',
  )
  add(failures, health.schema?.match === true, 'SCHEMA_MATCH_FALSE')
  add(failures, health.migration?.status === 'READY', 'MIGRATIONS_NOT_READY')
  // expectedLatest must match observed schema pin for this evidence pack
  // (008 for historical CP0-only, 013 for product latest — not a free-form value).
  const expectedLatest = health.migration?.expectedLatestVersion
  add(
    failures,
    expectedLatest === schemaVersion &&
      (expectedLatest === CP0_BASELINE_SCHEMA_VERSION ||
        expectedLatest === SCHEMA_LATEST_VERSION ||
        (typeof expectedLatest === 'string' &&
          /^\d{3}$/.test(expectedLatest) &&
          expectedLatest >= CP0_BASELINE_SCHEMA_VERSION &&
          expectedLatest <= SCHEMA_LATEST_VERSION)),
    'MIGRATION_LATEST_SCHEMA_MISMATCH',
  )
  add(
    failures,
    /^[0-9a-f]{64}$/.test(health.canonicalHash ?? ''),
    'CANONICAL_HASH_MISSING',
  )
  add(
    failures,
    Number.isInteger(health.boardRev) && health.boardRev >= 0,
    'BOARD_REV_MISSING',
  )
  add(
    failures,
    Number.isInteger(health.lifecycleRev) && health.lifecycleRev >= 0,
    'LIFECYCLE_REV_MISSING',
  )
  add(failures, health.sync?.status === 'IN_SYNC', 'SYNC_NOT_IN_SYNC')
  add(failures, health.sync?.effectiveBacklog === 0, 'SYNC_BACKLOG_NONZERO')
  add(failures, health.sync?.zeroBacklogProven === true, 'SYNC_ZERO_NOT_PROVEN')
  add(
    failures,
    Array.isArray(health.dependencies) &&
      health.dependencies.length > 0 &&
      health.dependencies.every((dependency) => dependency.status === 'up'),
    'DEPENDENCY_HEALTH_NOT_PROVEN',
  )

  for (const check of ['cp0', 'secretScan', 'typecheck', 'build']) {
    add(
      failures,
      evidence.checks?.[check] === 'PASS',
      `CHECK_${check.toUpperCase()}_NOT_PASS`,
    )
  }

  const verdict = evidence.independentVerdict ?? {}
  add(failures, verdict.verdict === 'PASS', 'INDEPENDENT_VERDICT_NOT_PASS')
  add(failures, verdict.subjectSha === expectedSha, 'VERIFIER_SHA_MISMATCH')
  add(
    failures,
    Boolean(verdict.authorRunId) &&
      Boolean(verdict.verifierRunId) &&
      verdict.authorRunId !== verdict.verifierRunId,
    'AUTHOR_VERIFIER_NOT_DISTINCT',
  )

  const rollback = evidence.rollback ?? {}
  add(
    failures,
    fullSha(rollback.priorSha) && rollback.priorSha !== expectedSha,
    'PRIOR_SHA_INVALID',
  )
  add(
    failures,
    rollback.priorShaHealthProven === true,
    'PRIOR_SHA_ROLLBACK_NOT_PROVEN',
  )
  add(
    failures,
    rollback.restoredSha === expectedSha,
    'CURRENT_SHA_RESTORE_MISMATCH',
  )
  add(
    failures,
    rollback.currentShaHealthProven === true,
    'CURRENT_SHA_RESTORE_NOT_PROVEN',
  )

  return {
    gate: CP0_STAGING_GATE,
    ok: failures.length === 0,
    target,
    expectedSha,
    failures,
    stagingVerified: failures.length === 0,
    liveP0: false,
  }
}

function parseArgs(argv) {
  const opts = {
    target: 'staging',
    plan: false,
    expectedSha: '',
    evidence: '',
    terminalReceipt: '',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--plan' || arg === '--dry-run') opts.plan = true
    else if (arg === '--expected-sha') opts.expectedSha = argv[++i] ?? ''
    else if (arg === '--target') opts.target = argv[++i] ?? ''
    else if (arg === '--evidence') opts.evidence = argv[++i] ?? ''
    else if (arg === '--terminal-receipt')
      opts.terminalReceipt = argv[++i] ?? ''
    else if (arg === '--help' || arg === '-h') opts.help = true
    else throw new Error(`unknown argument: ${arg}`)
  }
  return opts
}

export function main(argv) {
  let opts
  try {
    opts = parseArgs(argv)
  } catch (error) {
    console.error(`STAGING_GATE_ERROR ${error.message}`)
    return 2
  }
  if (opts.help) {
    console.log(
      'Usage: staging-gate.mjs --expected-sha <full-sha> --target staging (--plan|--evidence <json> --terminal-receipt <md>)',
    )
    return 0
  }
  try {
    const preflight = validateGatePreflight({
      root: process.cwd(),
      terminalReceiptOptions: opts.terminalReceipt
        ? { receiptPath: opts.terminalReceipt }
        : null,
      requireTerminalReceipt: !opts.plan,
      expectedReleaseSha: opts.expectedSha,
    })
    if (!preflight.ok) {
      console.log(JSON.stringify(preflight, null, 2))
      return 2
    }
    if (opts.plan) {
      const plan = buildPlan(opts)
      console.log(JSON.stringify(plan, null, 2))
      return plan.headMatches ? 0 : 2
    }
    if (!opts.evidence)
      throw new Error('choose --plan or provide --evidence <json>')
    const evidence = JSON.parse(readFileSync(opts.evidence, 'utf8'))
    const result = validateEvidence(evidence, opts.expectedSha, opts.target)
    console.log(JSON.stringify(result, null, 2))
    return result.ok ? 0 : 2
  } catch (error) {
    console.error(`STAGING_GATE_ERROR ${error.message}`)
    return 2
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2))
}
