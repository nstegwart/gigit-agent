#!/usr/bin/env node
/**
 * AC-GATE-02/03 vocabulary reconciliation.
 * Production live gate stays AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK;
 * app-only publication is a separate sub-authority (not staging PASS conflation).
 */
import { resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { captureEnvironmentTable } from './capture-environment-table.mjs'
import {
  LIVE_AWAITING,
  STAGING_GATE,
} from './validate-terminal-receipt.mjs'

export const SCHEMA_VERSION = 'TM_GATE_VOCABULARY_V1'

/** Owner-pre-authorized app-only deploy sub-gate (does not unlock live P0). */
export const APP_ONLY_PREAUTH_SUB_GATE = 'APP_ONLY_AFTER_EXACT_SHA_GATES'

/** Staging-only gate token — must never appear as production gateClosed. */
export const STAGING_ONLY_GATE = 'TASK_MANAGER_STAGING_VERIFIED_ONLY'

export const GATE_RULES = Object.freeze([
  {
    id: 'AC-GATE-01',
    summary: 'Staging PASS emits TASK_MANAGER_STAGING_VERIFIED only in terminal receipts',
    stagingGateClosed: STAGING_ONLY_GATE,
    terminalStagingToken: STAGING_GATE,
  },
  {
    id: 'AC-GATE-02',
    summary: 'Staging never emits live P0 PASS/unlock',
    forbiddenOnStaging: [LIVE_AWAITING, 'LIVE_P0_PASS', 'PROD_READY'],
  },
  {
    id: 'AC-GATE-03',
    summary:
      'Live production gateClosed remains AWAITING_PRODUCTION_APPROVAL_DEPLOY_READBACK; app-only pre-auth is sub-gate only',
    productionGateClosed: LIVE_AWAITING,
    productionAppWriteAuthority: APP_ONLY_PREAUTH_SUB_GATE,
    forbiddenOnProduction: [STAGING_GATE, STAGING_ONLY_GATE, 'TASK_MANAGER_STAGING_VERIFIED'],
  },
])

/**
 * @param {object} [opts]
 * @param {ReturnType<typeof captureEnvironmentTable>} [opts.environmentTable]
 */
export function reconcileGateVocabulary(opts = {}) {
  const environmentTable =
    opts.environmentTable ?? captureEnvironmentTable({ observedAt: opts.observedAt })
  const errors = []
  const warnings = []

  if (environmentTable.verdict !== 'PASS') {
    errors.push('ENVIRONMENT_TABLE_NOT_PASS')
    return {
      schemaVersion: SCHEMA_VERSION,
      observedAt: environmentTable.observedAt,
      environmentTableVerdict: environmentTable.verdict,
      rules: GATE_RULES,
      production: null,
      staging: null,
      errors,
      warnings,
      verdict: 'FAIL',
      nonMutating: true,
    }
  }

  const byId = Object.fromEntries(
    environmentTable.environments.map((row) => [row.id, row]),
  )
  const production = byId.production
  const staging = byId.staging

  if (!production) errors.push('PRODUCTION_ROW_MISSING')
  if (!staging) errors.push('STAGING_ROW_MISSING')

  const gate03 = GATE_RULES.find((r) => r.id === 'AC-GATE-03')
  const gate02 = GATE_RULES.find((r) => r.id === 'AC-GATE-02')
  const gate01 = GATE_RULES.find((r) => r.id === 'AC-GATE-01')

  if (production && gate03) {
    if (production.gateClosed !== gate03.productionGateClosed) {
      errors.push('PRODUCTION_GATE_CLOSED_MISMATCH')
    }
    if (production.appWriteAuthority !== gate03.productionAppWriteAuthority) {
      errors.push('PRODUCTION_APP_WRITE_AUTHORITY_MISMATCH')
    }
    for (const forbidden of gate03.forbiddenOnProduction ?? []) {
      if (
        production.gateClosed === forbidden ||
        production.appWriteAuthority === forbidden
      ) {
        errors.push(`PRODUCTION_FORBIDDEN_GATE_${forbidden}`)
      }
    }
  }

  if (staging && gate01 && staging.gateClosed !== gate01.stagingGateClosed) {
    errors.push('STAGING_GATE_CLOSED_MISMATCH')
  }

  if (staging && gate02) {
    for (const forbidden of gate02.forbiddenOnStaging ?? []) {
      if (staging.gateClosed === forbidden) {
        errors.push(`STAGING_FORBIDDEN_GATE_${forbidden}`)
      }
    }
  }

  // Document reconciliation: pre-auth sub-gate is explicit, not a gateClosed override.
  if (
    production?.gateClosed === LIVE_AWAITING &&
    production?.appWriteAuthority === APP_ONLY_PREAUTH_SUB_GATE
  ) {
    warnings.push('APP_ONLY_PREAUTH_RECONCILED_WITH_LIVE_AWAITING')
  }

  const uniqueErrors = [...new Set(errors)]
  return {
    schemaVersion: SCHEMA_VERSION,
    observedAt: environmentTable.observedAt,
    environmentTableVerdict: environmentTable.verdict,
    rules: GATE_RULES,
    production: production
      ? {
          gateClosed: production.gateClosed,
          appWriteAuthority: production.appWriteAuthority,
          reconciled: uniqueErrors.length === 0,
        }
      : null,
    staging: staging
      ? {
          gateClosed: staging.gateClosed,
          reconciled: !uniqueErrors.some((e) => e.startsWith('STAGING_')),
        }
      : null,
    liveAwaitingToken: LIVE_AWAITING,
    stagingVerifiedToken: STAGING_GATE,
    appOnlyPreAuthSubGate: APP_ONLY_PREAUTH_SUB_GATE,
    errors: uniqueErrors,
    warnings,
    verdict: uniqueErrors.length ? 'FAIL' : 'PASS',
    nonMutating: true,
  }
}

export function main(argv = process.argv.slice(2)) {
  if (argv.includes('--help') || argv.includes('-h')) {
    process.stdout.write(
      'Usage: node qa/evidence/gate-vocabulary.mjs [--observed-at ISO]\n',
    )
    return 0
  }
  const valueAfter = (flag) => {
    const index = argv.indexOf(flag)
    return index >= 0 ? argv[index + 1] : undefined
  }
  const report = reconcileGateVocabulary({
    observedAt: valueAfter('--observed-at'),
  })
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
  return report.verdict === 'PASS' ? 0 : 1
}

const isDirect =
  Boolean(process.argv[1]) &&
  resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))
if (isDirect) process.exitCode = main()