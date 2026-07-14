/**
 * Staging data provenance gate (AC-DATA-01 / AC-DATA-02).
 *
 * Production-derived staging loads require dual authority:
 *   productionReadApprovalId + stagingLoadApprovalId
 * plus field allowlist, redactionPolicyVersion, purpose/expiry, a complete
 * export manifest, and a verifiable payload proof (body stream and/or
 * explicit payload-verification receipt bound to hash/count).
 * Absent either authority or payload proof → refuse prod-derived load;
 * callers must use synthetic fixtures only.
 *
 * Fail-closed: depth/size/cycle limits REJECT (never return uninspected raw).
 * Pure library — no DB / route wiring.
 */

import { createHash } from 'node:crypto'

export const STAGING_DATA_PROVENANCE_SCHEMA = 'MFS_STAGING_DATA_PROVENANCE_V1' as const

/** Max object/array nesting for scan/redact. Exceeded → reject, never raw return. */
export const PAYLOAD_SCAN_MAX_DEPTH = 12

/** Max nodes visited during recursive scan/redact. Exceeded → reject. */
export const PAYLOAD_SCAN_MAX_NODES = 10_000

/** Known redaction policy versions accepted by the gate. */
export const REDACTION_POLICY_VERSIONS = [
  'STAGING_REDACTION_V1',
  'STAGING_REDACTION_V1_STRICT',
] as const

export type RedactionPolicyVersion = (typeof REDACTION_POLICY_VERSIONS)[number]

export const DEFAULT_REDACTION_POLICY_VERSION: RedactionPolicyVersion =
  'STAGING_REDACTION_V1'

/**
 * Fields never permitted in production-derived staging loads (allowlist or payload).
 * Matches STAGING DATA PROVENANCE "Never copy" list.
 */
export const FORBIDDEN_PRODUCTION_EXPORT_FIELDS: ReadonlyArray<string> = [
  'token',
  'tokens',
  'secret',
  'secrets',
  'password',
  'passwd',
  'authorization',
  'cookie',
  'apiKey',
  'api_key',
  'accessToken',
  'access_token',
  'refreshToken',
  'refresh_token',
  'session',
  'sessionId',
  'session_id',
  'credential',
  'credentials',
  'privateKey',
  'private_key',
  'bearer',
  'rawIdentity',
  'raw_identity',
  'unmaskedIdentity',
  'decisionText',
  'decisionTitle',
  'privateDecision',
  'ownerComments',
  'owner_comments',
  'comments',
  'comment',
  'evidenceBody',
  'evidence_body',
  'productionCredentials',
  'production_credentials',
  'clientSecret',
  'client_secret',
] as const

const FORBIDDEN_FIELD_SET = new Set(
  FORBIDDEN_PRODUCTION_EXPORT_FIELDS.map((f) => f.toLowerCase()),
)

/** Default safe field allowlist for production-derived staging loads. */
export const DEFAULT_STAGING_FIELD_ALLOWLIST: ReadonlyArray<string> = [
  'id',
  'boardId',
  'taskId',
  'projectId',
  'featureId',
  'title',
  'status',
  'bucket',
  'phase',
  'readinessPercent',
  'boardRev',
  'lifecycleRev',
  'entityRev',
  'canonicalSnapshotId',
  'canonicalHash',
  'createdAt',
  'updatedAt',
  'classifiedAt',
  'priority',
  'kind',
  'role',
] as const

export type StagingLoadMode = 'SYNTHETIC' | 'PRODUCTION_DERIVED'

export type ProvenanceRefusalCode =
  | 'MISSING_PRODUCTION_READ_APPROVAL'
  | 'MISSING_STAGING_LOAD_APPROVAL'
  | 'APPROVALS_NOT_DISTINCT'
  | 'MISSING_REDACTION_POLICY_VERSION'
  | 'UNKNOWN_REDACTION_POLICY_VERSION'
  | 'MISSING_FIELD_ALLOWLIST'
  | 'EMPTY_FIELD_ALLOWLIST'
  | 'FORBIDDEN_FIELD_IN_ALLOWLIST'
  | 'MISSING_EXPORT_MANIFEST'
  | 'INVALID_EXPORT_MANIFEST'
  | 'MANIFEST_APPROVAL_MISMATCH'
  | 'MANIFEST_ALLOWLIST_MISMATCH'
  | 'MANIFEST_REDACTION_MISMATCH'
  | 'MANIFEST_MISSING_REQUIRED_FIELD'
  | 'MANIFEST_SOURCE_NOT_PRODUCTION'
  | 'PURPOSE_EXPIRED'
  | 'MISSING_PURPOSE'
  | 'MISSING_EXPIRY'
  | 'PRODUCTION_DESTINATION_FORBIDDEN'
  | 'FORBIDDEN_PAYLOAD_FIELD'
  | 'PAYLOAD_HASH_MISMATCH'
  | 'MISSING_PAYLOAD_PROOF'
  | 'INVALID_PAYLOAD_VERIFICATION_RECEIPT'
  | 'PAYLOAD_SCAN_DEPTH_EXCEEDED'
  | 'PAYLOAD_SCAN_SIZE_EXCEEDED'
  | 'PAYLOAD_SCAN_CYCLIC'
  | 'PAYLOAD_SCAN_INVALID'
  | 'SYNTHETIC_ONLY_REQUIRED'

export type PayloadScanFailureCode =
  | 'PAYLOAD_SCAN_DEPTH_EXCEEDED'
  | 'PAYLOAD_SCAN_SIZE_EXCEEDED'
  | 'PAYLOAD_SCAN_CYCLIC'
  | 'PAYLOAD_SCAN_INVALID'

export interface StagingApprovals {
  productionReadApprovalId: string
  stagingLoadApprovalId: string
}

export interface ExportManifest {
  sourceEnvironment: string
  observedAt: string
  exportedAt: string
  sourceRevisionOrHash: string
  exportTool: string
  exportToolVersion: string
  fieldAllowlist: ReadonlyArray<string>
  redactionPolicyVersion: string
  recordCounts: Readonly<Record<string, number>>
  payloadHash: string
  destination: string
  approvals: StagingApprovals
  purpose?: string
  expiresAt?: string
}

/**
 * Explicit payload-verification receipt bound to manifest hash + record count.
 * Acceptable payload proof when the raw body stream is not presented in-process
 * (e.g. body already hashed by a trusted export tool in the same control plane).
 */
export interface PayloadVerificationReceipt {
  /** Must equal exportManifest.payloadHash (e.g. sha256:...). */
  payloadHash: string
  /**
   * Bound total record count — must equal the sum of
   * Object.values(exportManifest.recordCounts).
   */
  recordCount: number
  /** Only sha256 is accepted when provided. */
  algorithm?: 'sha256'
  /** Optional verifier identity / note (not trusted alone). */
  verifiedBy?: string
  verifiedAt?: string
}

export interface StagingLoadRequest {
  /** Caller-declared mode. PRODUCTION_DERIVED is gated; SYNTHETIC always allowed. */
  mode: StagingLoadMode
  /** Dual approvals — required for PRODUCTION_DERIVED. */
  productionReadApprovalId?: string | null
  stagingLoadApprovalId?: string | null
  /** Allowed export fields (must not include forbidden names). */
  fieldAllowlist?: ReadonlyArray<string> | null
  redactionPolicyVersion?: string | null
  purpose?: string | null
  /** ISO-8601 expiry; load refused after this instant. */
  expiresAt?: string | null
  /** Required for PRODUCTION_DERIVED. */
  exportManifest?: ExportManifest | null
  /**
   * Optional payload fields to scan for forbidden keys (top-level + nested keys).
   * When present, any forbidden key → FORBIDDEN_PAYLOAD_FIELD.
   * Depth/size/cycle failures reject (never silent skip).
   */
  payloadSample?: unknown
  /**
   * Verifiable payload body stream. When present, manifest.payloadHash must match.
   * JSON bodies are also scanned for forbidden fields (fail-closed).
   */
  payloadBody?: string | Uint8Array | null
  /**
   * Explicit payload-verification receipt bound to hash + record count.
   * Together with (or instead of) payloadBody, satisfies payload-proof requirement.
   */
  payloadVerificationReceipt?: PayloadVerificationReceipt | null
  /** Clock injection for expiry checks. */
  nowMs?: number
}

export interface StagingLoadAllowed {
  ok: true
  schema: typeof STAGING_DATA_PROVENANCE_SCHEMA
  mode: StagingLoadMode
  /** Present only when mode === PRODUCTION_DERIVED and gate passed. */
  approvals?: StagingApprovals
  fieldAllowlist: ReadonlyArray<string>
  redactionPolicyVersion: RedactionPolicyVersion | 'SYNTHETIC_NONE'
  purpose: string | null
  expiresAt: string | null
  exportManifest: ExportManifest | null
  residualGaps: ReadonlyArray<string>
}

export interface StagingLoadRefused {
  ok: false
  schema: typeof STAGING_DATA_PROVENANCE_SCHEMA
  mode: StagingLoadMode
  code: ProvenanceRefusalCode
  message: string
  /** Guidance: always synthetic when dual authority absent. */
  fallback: 'USE_SYNTHETIC_FIXTURES'
  details?: Record<string, string | number | boolean | null>
}

export type StagingLoadDecision = StagingLoadAllowed | StagingLoadRefused

export type PayloadFieldScanResult =
  | { ok: true; paths: Array<string> }
  | {
      ok: false
      code: PayloadScanFailureCode
      message: string
      path?: string
    }

export type RedactForStagingResult =
  | { ok: true; value: unknown }
  | {
      ok: false
      code: PayloadScanFailureCode
      message: string
      path?: string
    }

function isNonEmptyString(v: unknown): v is string {
  return typeof v === 'string' && v.trim().length > 0
}

function normalizeField(name: string): string {
  return name.trim()
}

function sumRecordCounts(
  recordCounts: Readonly<Record<string, number>>,
): number {
  let sum = 0
  for (const v of Object.values(recordCounts)) {
    if (typeof v !== 'number' || !Number.isFinite(v) || v < 0) {
      return Number.NaN
    }
    sum += v
  }
  return sum
}

export function isForbiddenExportField(field: string): boolean {
  const n = field.toLowerCase().replace(/[^a-z0-9]/g, '')
  if (FORBIDDEN_FIELD_SET.has(field.toLowerCase())) return true
  // Segment match against normalized forbidden names
  for (const forbidden of FORBIDDEN_PRODUCTION_EXPORT_FIELDS) {
    const fn = forbidden.toLowerCase().replace(/[^a-z0-9]/g, '')
    if (fn.length > 0 && n === fn) return true
  }
  // Heuristic: secret-ish key names (mixed casing covered via /i)
  if (
    /password|passwd|token|secret|credential|rawidentity|decisiontext|ownercomment|evidencebody|privatekey|apikey|bearer/i.test(
      field,
    )
  ) {
    return true
  }
  return false
}

export function findForbiddenFieldsInAllowlist(
  allowlist: ReadonlyArray<string>,
): Array<string> {
  return allowlist.filter((f) => isForbiddenExportField(f))
}

/**
 * Walk object keys; return forbidden field paths found.
 * Fail-closed: depth > PAYLOAD_SCAN_MAX_DEPTH, node budget, or cycles → ok:false
 * (never silently returns uninspected subtrees).
 */
export function findForbiddenPayloadFields(
  value: unknown,
): PayloadFieldScanResult {
  const paths: Array<string> = []
  const seen = new WeakSet<object>()
  let nodes = 0

  const walk = (
    v: unknown,
    path: string,
    depth: number,
  ): PayloadFieldScanResult | null => {
    if (depth > PAYLOAD_SCAN_MAX_DEPTH) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_DEPTH_EXCEEDED',
        message: `payload nesting exceeds max depth ${PAYLOAD_SCAN_MAX_DEPTH} at ${path || '(root)'}`,
        path: path || undefined,
      }
    }
    if (v === null || v === undefined) return null
    if (typeof v !== 'object') return null

    // Non-plain / non-array objects (Date, Map, Promise, etc.) are not JSON-export
    // shapes — reject rather than skip uninspected structure.
    if (!Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        return {
          ok: false,
          code: 'PAYLOAD_SCAN_INVALID',
          message: `payload contains non-JSON object type at ${path || '(root)'}: ${Object.prototype.toString.call(v)}`,
          path: path || undefined,
        }
      }
    }

    if (seen.has(v)) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_CYCLIC',
        message: `payload contains cyclic reference at ${path || '(root)'}`,
        path: path || undefined,
      }
    }
    seen.add(v)

    nodes += 1
    if (nodes > PAYLOAD_SCAN_MAX_NODES) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_SIZE_EXCEEDED',
        message: `payload exceeds max scan nodes ${PAYLOAD_SCAN_MAX_NODES}`,
        path: path || undefined,
      }
    }

    if (Array.isArray(v)) {
      for (let i = 0; i < v.length; i++) {
        const childPath = path ? `${path}[${i}]` : `[${i}]`
        const err = walk(v[i], childPath, depth + 1)
        if (err) return err
      }
      return null
    }

    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const p = path ? `${path}.${k}` : k
      if (isForbiddenExportField(k)) paths.push(p)
      const err = walk(child, p, depth + 1)
      if (err) return err
    }
    return null
  }

  try {
    const err = walk(value, '', 0)
    if (err) return err
    return { ok: true, paths }
  } catch (e) {
    return {
      ok: false,
      code: 'PAYLOAD_SCAN_INVALID',
      message: `payload scan failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

export function isKnownRedactionPolicyVersion(
  v: string,
): v is RedactionPolicyVersion {
  return (REDACTION_POLICY_VERSIONS as ReadonlyArray<string>).includes(v)
}

export function computePayloadHash(body: string | Uint8Array): string {
  const h = createHash('sha256')
  h.update(typeof body === 'string' ? body : Buffer.from(body))
  return `sha256:${h.digest('hex')}`
}

function refuse(
  mode: StagingLoadMode,
  code: ProvenanceRefusalCode,
  message: string,
  details?: StagingLoadRefused['details'],
): StagingLoadRefused {
  return {
    ok: false,
    schema: STAGING_DATA_PROVENANCE_SCHEMA,
    mode,
    code,
    message,
    fallback: 'USE_SYNTHETIC_FIXTURES',
    details,
  }
}

function refuseScanFailure(
  scan: Extract<PayloadFieldScanResult, { ok: false }>,
): StagingLoadRefused {
  return refuse('PRODUCTION_DERIVED', scan.code, scan.message, {
    path: scan.path ?? null,
  })
}

function validateExportManifestShape(
  m: ExportManifest,
): { ok: true } | { ok: false; code: ProvenanceRefusalCode; message: string; field?: string } {
  const requiredString: Array<keyof ExportManifest> = [
    'sourceEnvironment',
    'observedAt',
    'exportedAt',
    'sourceRevisionOrHash',
    'exportTool',
    'exportToolVersion',
    'redactionPolicyVersion',
    'payloadHash',
    'destination',
  ]
  for (const key of requiredString) {
    const v = m[key]
    if (!isNonEmptyString(v)) {
      return {
        ok: false,
        code: 'MANIFEST_MISSING_REQUIRED_FIELD',
        message: `export manifest missing required field: ${String(key)}`,
        field: String(key),
      }
    }
  }
  if (!Array.isArray(m.fieldAllowlist) || m.fieldAllowlist.length === 0) {
    return {
      ok: false,
      code: 'MANIFEST_MISSING_REQUIRED_FIELD',
      message: 'export manifest fieldAllowlist must be a non-empty array',
      field: 'fieldAllowlist',
    }
  }
  if (!m.recordCounts || typeof m.recordCounts !== 'object' || Array.isArray(m.recordCounts)) {
    return {
      ok: false,
      code: 'MANIFEST_MISSING_REQUIRED_FIELD',
      message: 'export manifest recordCounts must be an object',
      field: 'recordCounts',
    }
  }
  if (
    !m.approvals ||
    !isNonEmptyString(m.approvals.productionReadApprovalId) ||
    !isNonEmptyString(m.approvals.stagingLoadApprovalId)
  ) {
    return {
      ok: false,
      code: 'MANIFEST_MISSING_REQUIRED_FIELD',
      message: 'export manifest approvals must include both approval IDs',
      field: 'approvals',
    }
  }
  return { ok: true }
}

function hasPayloadBody(
  body: StagingLoadRequest['payloadBody'],
): body is string | Uint8Array {
  return body != null && (typeof body === 'string' || body instanceof Uint8Array)
}

/**
 * Evaluate whether a staging data load is permitted.
 * SYNTHETIC mode always allowed (AC-DATA-02 default path).
 * PRODUCTION_DERIVED requires full dual-approval + manifest + payload proof (AC-DATA-01).
 */
export function evaluateStagingDataLoad(req: StagingLoadRequest): StagingLoadDecision {
  if (req.mode === 'SYNTHETIC') {
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

  // ---- PRODUCTION_DERIVED ----
  const prodApproval = req.productionReadApprovalId?.trim() ?? ''
  const stagingApproval = req.stagingLoadApprovalId?.trim() ?? ''

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

  const redaction = req.redactionPolicyVersion?.trim() ?? ''
  if (!redaction) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_REDACTION_POLICY_VERSION',
      'redactionPolicyVersion is required for production-derived staging load',
    )
  }
  if (!isKnownRedactionPolicyVersion(redaction)) {
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
  const allowlist = req.fieldAllowlist.map(normalizeField).filter((f) => f.length > 0)
  if (allowlist.length === 0) {
    return refuse(
      'PRODUCTION_DERIVED',
      'EMPTY_FIELD_ALLOWLIST',
      'fieldAllowlist must contain at least one allowed field',
    )
  }
  const forbiddenInAllowlist = findForbiddenFieldsInAllowlist(allowlist)
  if (forbiddenInAllowlist.length > 0) {
    return refuse(
      'PRODUCTION_DERIVED',
      'FORBIDDEN_FIELD_IN_ALLOWLIST',
      `fieldAllowlist includes forbidden fields: ${forbiddenInAllowlist.join(', ')}`,
      { forbiddenCount: forbiddenInAllowlist.length },
    )
  }

  if (!isNonEmptyString(req.purpose)) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_PURPOSE',
      'purpose is required for production-derived staging load',
    )
  }
  if (!isNonEmptyString(req.expiresAt)) {
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
      { expiresAt: req.expiresAt, nowMs },
    )
  }

  if (req.exportManifest == null) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_EXPORT_MANIFEST',
      'export manifest is required for production-derived staging load',
    )
  }

  const manifestCheck = validateExportManifestShape(req.exportManifest)
  if (!manifestCheck.ok) {
    return refuse('PRODUCTION_DERIVED', manifestCheck.code, manifestCheck.message, {
      field: manifestCheck.field ?? null,
    })
  }

  const manifest = req.exportManifest
  const srcEnv = manifest.sourceEnvironment.toLowerCase()
  if (!/prod|production/.test(srcEnv)) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MANIFEST_SOURCE_NOT_PRODUCTION',
      `export manifest sourceEnvironment must indicate production (got: ${manifest.sourceEnvironment})`,
      { sourceEnvironment: manifest.sourceEnvironment },
    )
  }

  const dest = manifest.destination.toLowerCase()
  if (/prod|production/.test(dest) && !/staging|synthetic|local|test/.test(dest)) {
    return refuse(
      'PRODUCTION_DERIVED',
      'PRODUCTION_DESTINATION_FORBIDDEN',
      `export destination must not be production (got: ${manifest.destination})`,
      { destination: manifest.destination },
    )
  }

  if (
    manifest.approvals.productionReadApprovalId.trim() !== prodApproval ||
    manifest.approvals.stagingLoadApprovalId.trim() !== stagingApproval
  ) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MANIFEST_APPROVAL_MISMATCH',
      'export manifest approvals do not match request dual-approval IDs',
    )
  }

  if (manifest.redactionPolicyVersion.trim() !== redaction) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MANIFEST_REDACTION_MISMATCH',
      'export manifest redactionPolicyVersion does not match request',
      {
        request: redaction,
        manifest: manifest.redactionPolicyVersion,
      },
    )
  }

  const manifestAllow = new Set(manifest.fieldAllowlist.map((f) => f.trim()))
  const requestAllow = new Set(allowlist)
  const allowMismatch =
    manifestAllow.size !== requestAllow.size ||
    [...requestAllow].some((f) => !manifestAllow.has(f))
  if (allowMismatch) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MANIFEST_ALLOWLIST_MISMATCH',
      'export manifest fieldAllowlist does not match request fieldAllowlist',
    )
  }

  const forbiddenInManifest = findForbiddenFieldsInAllowlist(manifest.fieldAllowlist)
  if (forbiddenInManifest.length > 0) {
    return refuse(
      'PRODUCTION_DERIVED',
      'FORBIDDEN_FIELD_IN_ALLOWLIST',
      `manifest fieldAllowlist includes forbidden fields: ${forbiddenInManifest.join(', ')}`,
    )
  }

  // ---- Payload proof (fail-closed): body stream and/or verification receipt ----
  const bodyPresent = hasPayloadBody(req.payloadBody)
  const receipt = req.payloadVerificationReceipt
  const receiptPresent = receipt != null

  if (!bodyPresent && !receiptPresent) {
    return refuse(
      'PRODUCTION_DERIVED',
      'MISSING_PAYLOAD_PROOF',
      'production-derived load requires payloadBody (verifiable body stream) or payloadVerificationReceipt bound to payloadHash and recordCount',
    )
  }

  if (receiptPresent) {
    if (!isNonEmptyString(receipt.payloadHash)) {
      return refuse(
        'PRODUCTION_DERIVED',
        'INVALID_PAYLOAD_VERIFICATION_RECEIPT',
        'payloadVerificationReceipt.payloadHash must be a non-empty string',
      )
    }
    if (
      typeof receipt.recordCount !== 'number' ||
      !Number.isFinite(receipt.recordCount) ||
      receipt.recordCount < 0 ||
      !Number.isInteger(receipt.recordCount)
    ) {
      return refuse(
        'PRODUCTION_DERIVED',
        'INVALID_PAYLOAD_VERIFICATION_RECEIPT',
        'payloadVerificationReceipt.recordCount must be a non-negative integer',
      )
    }
    if (receipt.algorithm != null && receipt.algorithm !== 'sha256') {
      return refuse(
        'PRODUCTION_DERIVED',
        'INVALID_PAYLOAD_VERIFICATION_RECEIPT',
        `payloadVerificationReceipt.algorithm must be sha256 when set (got: ${String(receipt.algorithm)})`,
      )
    }
    if (receipt.payloadHash.trim() !== manifest.payloadHash.trim()) {
      return refuse(
        'PRODUCTION_DERIVED',
        'PAYLOAD_HASH_MISMATCH',
        'payloadVerificationReceipt.payloadHash does not match export manifest payloadHash',
        {
          expected: manifest.payloadHash,
          actual: receipt.payloadHash,
        },
      )
    }
    const expectedCount = sumRecordCounts(manifest.recordCounts)
    if (Number.isNaN(expectedCount)) {
      return refuse(
        'PRODUCTION_DERIVED',
        'INVALID_EXPORT_MANIFEST',
        'export manifest recordCounts must contain non-negative finite numbers',
        { field: 'recordCounts' },
      )
    }
    if (receipt.recordCount !== expectedCount) {
      return refuse(
        'PRODUCTION_DERIVED',
        'INVALID_PAYLOAD_VERIFICATION_RECEIPT',
        'payloadVerificationReceipt.recordCount does not match sum of export manifest recordCounts',
        {
          receiptRecordCount: receipt.recordCount,
          manifestRecordCountSum: expectedCount,
        },
      )
    }
  }

  if (bodyPresent) {
    // Narrow for tsc: hasPayloadBody is a type predicate but req.payloadBody stays optional.
    const payloadBody: string | Uint8Array = req.payloadBody as string | Uint8Array
    const expected = computePayloadHash(payloadBody)
    if (manifest.payloadHash.trim() !== expected) {
      return refuse(
        'PRODUCTION_DERIVED',
        'PAYLOAD_HASH_MISMATCH',
        'export manifest payloadHash does not match provided payload body',
        { expected, actual: manifest.payloadHash },
      )
    }

    // When body is UTF-8 JSON, scan for forbidden keys (fail-closed on depth/cycle).
    if (typeof payloadBody === 'string') {
      const trimmed = payloadBody.trim()
      if (
        trimmed.length > 0 &&
        (trimmed.startsWith('{') || trimmed.startsWith('['))
      ) {
        try {
          const parsed: unknown = JSON.parse(payloadBody)
          const bodyScan = findForbiddenPayloadFields(parsed)
          if (!bodyScan.ok) return refuseScanFailure(bodyScan)
          if (bodyScan.paths.length > 0) {
            return refuse(
              'PRODUCTION_DERIVED',
              'FORBIDDEN_PAYLOAD_FIELD',
              `payload body contains forbidden fields: ${bodyScan.paths.slice(0, 8).join(', ')}`,
              { forbiddenFieldCount: bodyScan.paths.length },
            )
          }
        } catch {
          return refuse(
            'PRODUCTION_DERIVED',
            'PAYLOAD_SCAN_INVALID',
            'payloadBody looks like JSON but failed to parse; refuse rather than skip field scan',
          )
        }
      }
    }
  }

  if (req.payloadSample !== undefined) {
    const sampleScan = findForbiddenPayloadFields(req.payloadSample)
    if (!sampleScan.ok) return refuseScanFailure(sampleScan)
    if (sampleScan.paths.length > 0) {
      return refuse(
        'PRODUCTION_DERIVED',
        'FORBIDDEN_PAYLOAD_FIELD',
        `payload contains forbidden fields: ${sampleScan.paths.slice(0, 8).join(', ')}`,
        { forbiddenFieldCount: sampleScan.paths.length },
      )
    }
  }

  const residualGaps: Array<string> = [
    // Product entry: authorizeAndPrepareStagingProductionDerivedLoad
    // (staging-production-derived-load-adapter). This library does not load data.
    'gate is library-only; product surfaces must call via staging-production-derived-load-adapter before any load; HTTP/MCP/deploy executor not in this module',
  ]
  if (!bodyPresent && receiptPresent) {
    residualGaps.push(
      'payload proof via receipt only — in-process forbidden-field scan of raw body not performed',
    )
  }

  return {
    ok: true,
    schema: STAGING_DATA_PROVENANCE_SCHEMA,
    mode: 'PRODUCTION_DERIVED',
    approvals: {
      productionReadApprovalId: prodApproval,
      stagingLoadApprovalId: stagingApproval,
    },
    fieldAllowlist: allowlist,
    redactionPolicyVersion: redaction,
    purpose: req.purpose,
    expiresAt: req.expiresAt,
    exportManifest: manifest,
    residualGaps,
  }
}

/**
 * Project a record onto the field allowlist and strip forbidden keys.
 * Fail-closed: unknown keys dropped; forbidden keys never pass.
 */
export function projectAllowlistedRecord(
  record: Record<string, unknown>,
  fieldAllowlist: ReadonlyArray<string>,
): { ok: true; projected: Record<string, unknown> } | { ok: false; code: ProvenanceRefusalCode; forbidden: Array<string> } {
  const forbiddenPresent = Object.keys(record).filter((k) => isForbiddenExportField(k))
  if (forbiddenPresent.length > 0) {
    return {
      ok: false,
      code: 'FORBIDDEN_PAYLOAD_FIELD',
      forbidden: forbiddenPresent,
    }
  }
  const allow = new Set(fieldAllowlist)
  const projected: Record<string, unknown> = {}
  for (const key of fieldAllowlist) {
    if (Object.prototype.hasOwnProperty.call(record, key) && allow.has(key)) {
      projected[key] = record[key]
    }
  }
  return { ok: true, projected }
}

/**
 * Apply redaction to a production-export candidate under a policy version.
 * Removes forbidden keys recursively; non-allowlisted top-level keys dropped when allowlist provided.
 * Fail-closed: depth/size/cycle → ok:false (never returns uninspected raw subtree).
 */
export function redactForStagingLoad(
  value: unknown,
  opts: {
    redactionPolicyVersion: RedactionPolicyVersion
    fieldAllowlist?: ReadonlyArray<string>
  },
): RedactForStagingResult {
  // Policy version currently selects strictness only; both strip forbidden keys.
  const strict = opts.redactionPolicyVersion === 'STAGING_REDACTION_V1_STRICT'
  const allow = opts.fieldAllowlist ? new Set(opts.fieldAllowlist) : null
  const seen = new WeakSet<object>()
  let nodes = 0

  const walk = (
    v: unknown,
    depth: number,
    isTopLevel: boolean,
    path: string,
  ): RedactForStagingResult => {
    if (depth > PAYLOAD_SCAN_MAX_DEPTH) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_DEPTH_EXCEEDED',
        message: `redaction nesting exceeds max depth ${PAYLOAD_SCAN_MAX_DEPTH} at ${path || '(root)'}`,
        path: path || undefined,
      }
    }
    if (v === null || v === undefined) return { ok: true, value: v }
    if (typeof v === 'string') {
      if (/-----BEGIN |Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{10,}/i.test(v)) {
        return { ok: true, value: '[REDACTED]' }
      }
      return { ok: true, value: v }
    }
    if (typeof v !== 'object') return { ok: true, value: v }

    if (!Array.isArray(v)) {
      const proto = Object.getPrototypeOf(v)
      if (proto !== Object.prototype && proto !== null) {
        return {
          ok: false,
          code: 'PAYLOAD_SCAN_INVALID',
          message: `redaction refuses non-JSON object type at ${path || '(root)'}: ${Object.prototype.toString.call(v)}`,
          path: path || undefined,
        }
      }
    }

    if (seen.has(v)) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_CYCLIC',
        message: `redaction refuses cyclic reference at ${path || '(root)'}`,
        path: path || undefined,
      }
    }
    seen.add(v)

    nodes += 1
    if (nodes > PAYLOAD_SCAN_MAX_NODES) {
      return {
        ok: false,
        code: 'PAYLOAD_SCAN_SIZE_EXCEEDED',
        message: `redaction exceeds max scan nodes ${PAYLOAD_SCAN_MAX_NODES}`,
        path: path || undefined,
      }
    }

    if (Array.isArray(v)) {
      const out: Array<unknown> = []
      for (let i = 0; i < v.length; i++) {
        const childPath = path ? `${path}[${i}]` : `[${i}]`
        const child = walk(v[i], depth + 1, false, childPath)
        if (!child.ok) return child
        out.push(child.value)
      }
      return { ok: true, value: out }
    }

    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k
      if (isForbiddenExportField(k)) {
        if (strict) continue // drop entirely
        out[k] = '[REDACTED]'
        continue
      }
      if (isTopLevel && allow && !allow.has(k)) continue
      const walked = walk(child, depth + 1, false, childPath)
      if (!walked.ok) return walked
      out[k] = walked.value
    }
    return { ok: true, value: out }
  }

  try {
    return walk(value, 0, true, '')
  } catch (e) {
    return {
      ok: false,
      code: 'PAYLOAD_SCAN_INVALID',
      message: `redaction failed: ${e instanceof Error ? e.message : String(e)}`,
    }
  }
}

/**
 * Build a minimal valid export manifest for tests / dry-run tooling.
 * Does not grant load authority by itself — evaluateStagingDataLoad still required.
 */
export function buildExportManifest(
  partial: Omit<ExportManifest, 'payloadHash'> & {
    payloadHash?: string
    payloadBody?: string | Uint8Array
  },
): ExportManifest {
  const payloadHash =
    partial.payloadHash ??
    (partial.payloadBody != null
      ? computePayloadHash(partial.payloadBody)
      : computePayloadHash(''))
  return {
    sourceEnvironment: partial.sourceEnvironment,
    observedAt: partial.observedAt,
    exportedAt: partial.exportedAt,
    sourceRevisionOrHash: partial.sourceRevisionOrHash,
    exportTool: partial.exportTool,
    exportToolVersion: partial.exportToolVersion,
    fieldAllowlist: partial.fieldAllowlist,
    redactionPolicyVersion: partial.redactionPolicyVersion,
    recordCounts: partial.recordCounts,
    payloadHash,
    destination: partial.destination,
    approvals: partial.approvals,
    purpose: partial.purpose,
    expiresAt: partial.expiresAt,
  }
}

/** Convenience: refuse production-derived unless both IDs present (short form). */
export function hasDualApprovals(
  productionReadApprovalId: string | null | undefined,
  stagingLoadApprovalId: string | null | undefined,
): boolean {
  return (
    isNonEmptyString(productionReadApprovalId) &&
    isNonEmptyString(stagingLoadApprovalId) &&
    productionReadApprovalId!.trim() !== stagingLoadApprovalId!.trim()
  )
}
