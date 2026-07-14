/**
 * Staging PRODUCTION_DERIVED load adapter — AC-DATA-01 product contract.
 *
 * Single authorized product-side entry for production-derived staging loads.
 * Fail-closed: always runs `evaluateStagingDataLoad` (dual
 * productionReadApprovalId + stagingLoadApprovalId, allowlist, redaction
 * policy, purpose/expiry, export manifest, payload hash proof) BEFORE any
 * redaction/projection work.
 *
 * This adapter does NOT invent a production HTTP route and does NOT mutate
 * DB/staging. On allow it returns a PLAN_ONLY prepared payload + explicit
 * Decision need for the sanctioned load executor surface.
 *
 * Synthetic path remains `deploy/staging/scripts/seed-synthetic.mjs` +
 * `qa/fixtures/staging/provenance-gate.mjs` (SYNTHETIC only).
 */

import {
  evaluateStagingDataLoad,
  projectAllowlistedRecord,
  redactForStagingLoad,
  type ExportManifest,
  type PayloadVerificationReceipt,
  type ProvenanceRefusalCode,
  type RedactionPolicyVersion,
  type StagingApprovals,
  type StagingLoadAllowed,
  type StagingLoadRefused,
  type StagingLoadRequest,
  isKnownRedactionPolicyVersion,
} from '#/server/staging-data-provenance'

export const STAGING_PD_LOAD_ADAPTER_ID =
  'staging-production-derived-load-adapter-v1' as const

export const STAGING_PD_LOAD_ADAPTER_SCHEMA =
  'MFS_STAGING_PD_LOAD_ADAPTER_V1' as const

/** Explicit Decision the orchestrator/owner must take before any live load. */
export const STAGING_PD_LOAD_DECISION_NEED =
  'DECISION_NEED: no sanctioned PRODUCTION_DERIVED load executor/route is product-wired. Choose and authorize exactly one surface (MCP tool | deploy operator CLI | control-plane import path), then call authorizeAndPrepareStagingProductionDerivedLoad before any write. Do not invent an unapproved production route. Absent dual approvals → synthetic fixtures only (seed-synthetic).' as const

export type StagingProductionDerivedLoadInput = {
  productionReadApprovalId: string
  stagingLoadApprovalId: string
  fieldAllowlist: ReadonlyArray<string>
  redactionPolicyVersion: string
  purpose: string
  expiresAt: string
  exportManifest: ExportManifest
  payloadBody?: string | Uint8Array | null
  payloadVerificationReceipt?: PayloadVerificationReceipt | null
  /** Optional nested sample scanned by the gate (forbidden fields). */
  payloadSample?: unknown
  nowMs?: number
  /**
   * Optional records to redact + project after the gate passes.
   * Never loaded into DB by this adapter.
   */
  records?: ReadonlyArray<Record<string, unknown>>
}

export type StagingProductionDerivedPrepared = {
  mode: 'PRODUCTION_DERIVED'
  approvals: StagingApprovals
  fieldAllowlist: ReadonlyArray<string>
  redactionPolicyVersion: RedactionPolicyVersion
  purpose: string
  expiresAt: string
  exportManifest: ExportManifest
  /** Redacted+allowlisted records when input.records provided; else null. */
  redactedRecords: Array<Record<string, unknown>> | null
  /**
   * Hard contract: this adapter never executes a staging load.
   * Callers that write DB without a further authorized executor violate AC-DATA-01.
   */
  execution: 'PLAN_ONLY_NOT_EXECUTED'
}

export type StagingProductionDerivedLoadOk = {
  ok: true
  schema: typeof STAGING_PD_LOAD_ADAPTER_SCHEMA
  adapterId: typeof STAGING_PD_LOAD_ADAPTER_ID
  decision: StagingLoadAllowed
  prepared: StagingProductionDerivedPrepared
  residualGaps: ReadonlyArray<string>
  decisionNeed: typeof STAGING_PD_LOAD_DECISION_NEED
}

export type StagingProductionDerivedLoadRefused = {
  ok: false
  schema: typeof STAGING_PD_LOAD_ADAPTER_SCHEMA
  adapterId: typeof STAGING_PD_LOAD_ADAPTER_ID
  decision: StagingLoadRefused | null
  code: ProvenanceRefusalCode | 'REDACTION_FAILED' | 'PROJECTION_FAILED'
  message: string
  fallback: 'USE_SYNTHETIC_FIXTURES'
  details?: Record<string, string | number | boolean | null>
}

export type StagingProductionDerivedLoadResult =
  | StagingProductionDerivedLoadOk
  | StagingProductionDerivedLoadRefused

function toGateRequest(
  input: StagingProductionDerivedLoadInput,
): StagingLoadRequest {
  return {
    mode: 'PRODUCTION_DERIVED',
    productionReadApprovalId: input.productionReadApprovalId,
    stagingLoadApprovalId: input.stagingLoadApprovalId,
    fieldAllowlist: input.fieldAllowlist,
    redactionPolicyVersion: input.redactionPolicyVersion,
    purpose: input.purpose,
    expiresAt: input.expiresAt,
    exportManifest: input.exportManifest,
    payloadBody: input.payloadBody,
    payloadVerificationReceipt: input.payloadVerificationReceipt,
    payloadSample: input.payloadSample,
    nowMs: input.nowMs,
  }
}

/**
 * Authorize a production-derived staging load and prepare redacted payload.
 * Fail-closed: gate runs first; on refuse nothing is prepared.
 * On allow: PLAN_ONLY — no DB/HTTP execution.
 */
export function authorizeAndPrepareStagingProductionDerivedLoad(
  input: StagingProductionDerivedLoadInput,
): StagingProductionDerivedLoadResult {
  // 1) Dual-approval + allowlist + redaction + purpose/expiry + manifest + hash
  //    validation — fail closed before any load/redaction work.
  const decision = evaluateStagingDataLoad(toGateRequest(input))
  if (!decision.ok) {
    return {
      ok: false,
      schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
      adapterId: STAGING_PD_LOAD_ADAPTER_ID,
      decision,
      code: decision.code,
      message: decision.message,
      fallback: 'USE_SYNTHETIC_FIXTURES',
      details: decision.details,
    }
  }

  if (decision.mode !== 'PRODUCTION_DERIVED' || !decision.approvals) {
    return {
      ok: false,
      schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
      adapterId: STAGING_PD_LOAD_ADAPTER_ID,
      decision: null,
      code: 'SYNTHETIC_ONLY_REQUIRED',
      message:
        'adapter only authorizes PRODUCTION_DERIVED mode; use synthetic seed path for SYNTHETIC',
      fallback: 'USE_SYNTHETIC_FIXTURES',
    }
  }

  if (!isKnownRedactionPolicyVersion(decision.redactionPolicyVersion)) {
    // Defensive: gate already validated; keep fail-closed.
    return {
      ok: false,
      schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
      adapterId: STAGING_PD_LOAD_ADAPTER_ID,
      decision: null,
      code: 'UNKNOWN_REDACTION_POLICY_VERSION',
      message: `adapter refused unknown redactionPolicyVersion: ${String(decision.redactionPolicyVersion)}`,
      fallback: 'USE_SYNTHETIC_FIXTURES',
    }
  }

  const redactionPolicyVersion = decision.redactionPolicyVersion
  const fieldAllowlist = decision.fieldAllowlist
  let redactedRecords: Array<Record<string, unknown>> | null = null

  // 2) Optional record projection + redaction AFTER gate (never before).
  if (input.records != null) {
    redactedRecords = []
    for (let i = 0; i < input.records.length; i++) {
      const record = input.records[i]
      const projected = projectAllowlistedRecord(record, fieldAllowlist)
      if (!projected.ok) {
        return {
          ok: false,
          schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
          adapterId: STAGING_PD_LOAD_ADAPTER_ID,
          decision: null,
          code: 'PROJECTION_FAILED',
          message: `record[${i}] projection refused: forbidden fields present (${projected.forbidden.join(', ')})`,
          fallback: 'USE_SYNTHETIC_FIXTURES',
          details: { recordIndex: i, forbiddenCount: projected.forbidden.length },
        }
      }
      const redacted = redactForStagingLoad(projected.projected, {
        redactionPolicyVersion,
        fieldAllowlist,
      })
      if (!redacted.ok) {
        return {
          ok: false,
          schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
          adapterId: STAGING_PD_LOAD_ADAPTER_ID,
          decision: null,
          code: 'REDACTION_FAILED',
          message: `record[${i}] redaction refused: ${redacted.message}`,
          fallback: 'USE_SYNTHETIC_FIXTURES',
          details: {
            recordIndex: i,
            scanCode: redacted.code,
            path: redacted.path ?? null,
          },
        }
      }
      redactedRecords.push(redacted.value as Record<string, unknown>)
    }
  }

  const residualGaps: Array<string> = [
    'adapter returns PLAN_ONLY_NOT_EXECUTED — no staging DB write, no HTTP route, no production export performed',
    STAGING_PD_LOAD_DECISION_NEED,
    ...decision.residualGaps,
  ]

  return {
    ok: true,
    schema: STAGING_PD_LOAD_ADAPTER_SCHEMA,
    adapterId: STAGING_PD_LOAD_ADAPTER_ID,
    decision,
    prepared: {
      mode: 'PRODUCTION_DERIVED',
      approvals: decision.approvals,
      fieldAllowlist,
      redactionPolicyVersion,
      purpose: decision.purpose ?? input.purpose,
      expiresAt: decision.expiresAt ?? input.expiresAt,
      exportManifest: decision.exportManifest as ExportManifest,
      redactedRecords,
      execution: 'PLAN_ONLY_NOT_EXECUTED',
    },
    residualGaps,
    decisionNeed: STAGING_PD_LOAD_DECISION_NEED,
  }
}

/**
 * Hard assert: throw if gate refuses. Use at the top of any future load
 * executor. Never catches and continues.
 */
export function assertStagingProductionDerivedLoadAuthorized(
  input: StagingProductionDerivedLoadInput,
): StagingLoadAllowed {
  const result = authorizeAndPrepareStagingProductionDerivedLoad(input)
  if (!result.ok) {
    const err = new Error(result.message) as Error & {
      code: string
      fallback: 'USE_SYNTHETIC_FIXTURES'
      adapterId: typeof STAGING_PD_LOAD_ADAPTER_ID
    }
    err.code = result.code
    err.fallback = 'USE_SYNTHETIC_FIXTURES'
    err.adapterId = STAGING_PD_LOAD_ADAPTER_ID
    throw err
  }
  return result.decision
}
