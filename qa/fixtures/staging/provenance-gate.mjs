/**
 * Staging data provenance gate for pure Node seed paths (AC-DATA-01 / AC-DATA-02).
 *
 * Mirrors the SYNTHETIC / PRODUCTION_DERIVED decision surface of
 * `src/server/staging-data-provenance.ts#evaluateStagingDataLoad` so Docker
 * seed entrypoints can fail-closed without a TS runtime.
 *
 * Keep residual SYNTHETIC gaps honest: synthetic path does not exercise
 * production-derived dual-approval.
 */
export const STAGING_DATA_PROVENANCE_SCHEMA = 'MFS_STAGING_DATA_PROVENANCE_V1'

const REDACTION_POLICY_VERSIONS = new Set([
  'STAGING_REDACTION_V1',
  'STAGING_REDACTION_V1_STRICT',
])

function refuse(mode, code, message, detail = null) {
  return {
    ok: false,
    schema: STAGING_DATA_PROVENANCE_SCHEMA,
    mode,
    code,
    message,
    detail,
    residualGaps: ['load refused — fail closed'],
  }
}

/**
 * @param {{
 *   mode?: 'SYNTHETIC' | 'PRODUCTION_DERIVED'
 *   purpose?: string | null
 *   productionReadApprovalId?: string | null
 *   stagingLoadApprovalId?: string | null
 *   redactionPolicyVersion?: string | null
 *   fieldAllowlist?: string[] | null
 *   expiresAt?: string | null
 *   nowMs?: number
 *   productionDerived?: boolean
 * }} req
 */
export function evaluateStagingDataLoad(req = {}) {
  const mode =
    req.mode === 'PRODUCTION_DERIVED' || req.productionDerived === true
      ? 'PRODUCTION_DERIVED'
      : 'SYNTHETIC'

  if (mode === 'SYNTHETIC') {
    return {
      ok: true,
      schema: STAGING_DATA_PROVENANCE_SCHEMA,
      mode: 'SYNTHETIC',
      fieldAllowlist: [],
      redactionPolicyVersion: 'SYNTHETIC_NONE',
      purpose: req.purpose ?? 'synthetic-fixtures',
      expiresAt: null,
      exportManifest: null,
      residualGaps: [
        'synthetic path does not exercise production-derived dual-approval gate',
      ],
    }
  }

  const prodApproval = String(req.productionReadApprovalId ?? '').trim()
  const stagingApproval = String(req.stagingLoadApprovalId ?? '').trim()
  if (!prodApproval) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_PRODUCTION_READ_APPROVAL',
      'productionReadApprovalId is required for production-derived staging load',
    )
  }
  if (!stagingApproval) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_STAGING_LOAD_APPROVAL',
      'stagingLoadApprovalId is required for production-derived staging load',
    )
  }
  if (prodApproval === stagingApproval) {
    return refuse(
      'PRODUCTION_DERIVED',
      'APPROVALS_NOT_DISTINCT',
      'productionReadApprovalId and stagingLoadApprovalId must be distinct authorities',
      { productionReadApprovalId: prodApproval, stagingLoadApprovalId: stagingApproval },
    )
  }

  const redaction = String(req.redactionPolicyVersion ?? '').trim()
  if (!redaction) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_REDACTION_POLICY_VERSION',
      'redactionPolicyVersion is required for production-derived staging load',
    )
  }
  if (!REDACTION_POLICY_VERSIONS.has(redaction)) {
    return refuse(
      'PRODUCTION_DERIVED',
      'UNKNOWN_REDACTION_POLICY_VERSION',
      `unknown redactionPolicyVersion: ${redaction}`,
      { redactionPolicyVersion: redaction },
    )
  }

  if (req.fieldAllowlist == null) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_FIELD_ALLOWLIST',
      'fieldAllowlist is required for production-derived staging load',
    )
  }
  const allowlist = (req.fieldAllowlist || []).map((f) => String(f).trim()).filter(Boolean)
  if (allowlist.length === 0) {
    return refuse(
      'PRODUCTION_DERIVED',
      'EMPTY_FIELD_ALLOWLIST',
      'fieldAllowlist must contain at least one allowed field',
    )
  }

  if (!String(req.purpose ?? '').trim()) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_PURPOSE',
      'purpose is required for production-derived staging load',
    )
  }
  if (!String(req.expiresAt ?? '').trim()) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_EXPIRY',
      'expiresAt is required for production-derived staging load',
    )
  }
  const nowMs = req.nowMs ?? Date.now()
  const expiresMs = Date.parse(req.expiresAt)
  if (Number.isNaN(expiresMs) || expiresMs <= nowMs) {
    return refuse(
      'PRODUCTION_DERIVED',
      'PURPOSE_EXPIRED',
      `purpose/expiry not valid at evaluation time (expiresAt=${req.expiresAt})`,
    )
  }

  // Full dual-approval payload proof lives in TS library. Seed path refuses
  // incomplete PRODUCTION_DERIVED without export manifest / payload proof.
  if (!req.exportManifest || typeof req.exportManifest !== 'object') {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_EXPORT_MANIFEST',
      'exportManifest is required for production-derived staging load',
    )
  }

  return refuse(
    'PRODUCTION_DERIVED',
    'USE_TS_LIBRARY_FOR_FULL_PROOF',
    'production-derived loads must use src/server/staging-data-provenance evaluateStagingDataLoad with payload proof; seed path is synthetic-only',
  )
}

/**
 * Enforce seed-policy.json + evaluateStagingDataLoad for synthetic staging seed.
 * @param {Record<string, unknown>} policy
 */
export function enforceSyntheticSeedProvenance(policy = {}) {
  if (policy.productionDerived === true) {
    return {
      ok: false,
      code: 'PRODUCTION_DERIVED_POLICY',
      message: 'seed-policy.json marks productionDerived=true — refused on synthetic seed path',
      decision: null,
    }
  }
  if (policy.syntheticOnly === false) {
    return {
      ok: false,
      code: 'SYNTHETIC_ONLY_REQUIRED',
      message: 'seed-policy.json must be syntheticOnly for deploy seed path',
      decision: null,
    }
  }
  const decision = evaluateStagingDataLoad({
    mode: 'SYNTHETIC',
    purpose: policy.purpose ?? 'staging-synthetic-seed',
    productionDerived: false,
  })
  if (!decision.ok) {
    return {
      ok: false,
      code: decision.code ?? 'PROVENANCE_REFUSED',
      message: decision.message ?? 'provenance gate refused',
      decision,
    }
  }
  return { ok: true, code: null, message: null, decision }
}
