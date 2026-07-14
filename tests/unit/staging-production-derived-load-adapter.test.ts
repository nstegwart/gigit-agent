import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REDACTION_POLICY_VERSION,
  DEFAULT_STAGING_FIELD_ALLOWLIST,
  buildExportManifest,
  computePayloadHash,
  type ExportManifest,
  type PayloadVerificationReceipt,
} from '#/server/staging-data-provenance'
import {
  STAGING_PD_LOAD_ADAPTER_ID,
  STAGING_PD_LOAD_ADAPTER_SCHEMA,
  STAGING_PD_LOAD_DECISION_NEED,
  assertStagingProductionDerivedLoadAuthorized,
  authorizeAndPrepareStagingProductionDerivedLoad,
} from '#/server/staging-production-derived-load-adapter'

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'
const NOW_MS = Date.parse('2026-07-14T04:31:22.000Z')
const BODY = JSON.stringify({ id: 't1', title: 'hello', boardId: 'mfs-rebuild' })

function validManifest(
  overrides: Partial<ExportManifest> = {},
): ExportManifest {
  const base = buildExportManifest({
    sourceEnvironment: 'production',
    observedAt: '2026-07-13T12:00:00.000Z',
    exportedAt: '2026-07-13T12:05:00.000Z',
    sourceRevisionOrHash: 'abc123deadbeef',
    exportTool: 'staging-export-cli',
    exportToolVersion: '1.0.0',
    fieldAllowlist: [...DEFAULT_STAGING_FIELD_ALLOWLIST],
    redactionPolicyVersion: DEFAULT_REDACTION_POLICY_VERSION,
    recordCounts: { tasks: 1, runs: 0 },
    payloadBody: BODY,
    destination: 'staging:cairn_tm_v3_staging',
    approvals: {
      productionReadApprovalId: 'prod-read-appr-001',
      stagingLoadApprovalId: 'staging-load-appr-002',
    },
    purpose: 'staging-parity-rehearsal',
    expiresAt: FUTURE,
  })
  return { ...base, ...overrides }
}

function validReceipt(
  overrides: Partial<PayloadVerificationReceipt> = {},
): PayloadVerificationReceipt {
  return {
    payloadHash: computePayloadHash(BODY),
    recordCount: 1,
    algorithm: 'sha256',
    ...overrides,
  }
}

function validInput(
  overrides: Partial<
    Parameters<typeof authorizeAndPrepareStagingProductionDerivedLoad>[0]
  > = {},
) {
  return {
    productionReadApprovalId: 'prod-read-appr-001',
    stagingLoadApprovalId: 'staging-load-appr-002',
    fieldAllowlist: [...DEFAULT_STAGING_FIELD_ALLOWLIST],
    redactionPolicyVersion: DEFAULT_REDACTION_POLICY_VERSION,
    purpose: 'staging-parity-rehearsal',
    expiresAt: FUTURE,
    exportManifest: validManifest(),
    payloadBody: BODY,
    nowMs: NOW_MS,
    ...overrides,
  }
}

describe('staging PRODUCTION_DERIVED load adapter (AC-DATA-01 product contract)', () => {
  it('refuses without productionReadApprovalId (fail-closed before prepare)', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({ productionReadApprovalId: '' }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.adapterId).toBe(STAGING_PD_LOAD_ADAPTER_ID)
    expect(r.schema).toBe(STAGING_PD_LOAD_ADAPTER_SCHEMA)
    expect(r.code).toBe('MISSING_PRODUCTION_READ_APPROVAL')
    expect(r.fallback).toBe('USE_SYNTHETIC_FIXTURES')
  })

  it('refuses without stagingLoadApprovalId', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({ stagingLoadApprovalId: null as unknown as string }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('MISSING_STAGING_LOAD_APPROVAL')
  })

  it('refuses when dual approvals are not distinct', () => {
    const same = 'same-id'
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        productionReadApprovalId: same,
        stagingLoadApprovalId: same,
        exportManifest: validManifest({
          approvals: {
            productionReadApprovalId: same,
            stagingLoadApprovalId: same,
          },
        }),
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('APPROVALS_NOT_DISTINCT')
  })

  it('refuses missing export manifest / payload proof / expired purpose', () => {
    const noManifest = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({ exportManifest: null as unknown as ExportManifest }),
    )
    expect(noManifest.ok).toBe(false)
    if (!noManifest.ok) expect(noManifest.code).toBe('MISSING_EXPORT_MANIFEST')

    const noProof = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        payloadBody: null,
        payloadVerificationReceipt: null,
      }),
    )
    expect(noProof.ok).toBe(false)
    if (!noProof.ok) expect(noProof.code).toBe('MISSING_PAYLOAD_PROOF')

    const expired = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({ expiresAt: PAST }),
    )
    expect(expired.ok).toBe(false)
    if (!expired.ok) expect(expired.code).toBe('PURPOSE_EXPIRED')
  })

  it('refuses payload hash mismatch before any prepare', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({ payloadBody: JSON.stringify({ id: 'other' }) }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('PAYLOAD_HASH_MISMATCH')
  })

  it('refuses forbidden field in allowlist', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        fieldAllowlist: ['id', 'token'],
        exportManifest: validManifest({ fieldAllowlist: ['id', 'token'] }),
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('FORBIDDEN_FIELD_IN_ALLOWLIST')
  })

  it('authorizes plan-only load with dual approvals + hash proof (no execution)', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(validInput())
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.adapterId).toBe(STAGING_PD_LOAD_ADAPTER_ID)
    expect(r.prepared.execution).toBe('PLAN_ONLY_NOT_EXECUTED')
    expect(r.prepared.mode).toBe('PRODUCTION_DERIVED')
    expect(r.prepared.approvals.productionReadApprovalId).toBe(
      'prod-read-appr-001',
    )
    expect(r.prepared.approvals.stagingLoadApprovalId).toBe(
      'staging-load-appr-002',
    )
    expect(r.prepared.redactedRecords).toBeNull()
    expect(r.decisionNeed).toBe(STAGING_PD_LOAD_DECISION_NEED)
    expect(
      r.residualGaps.some((g) => g.includes('PLAN_ONLY_NOT_EXECUTED')),
    ).toBe(true)
    expect(r.residualGaps.some((g) => g.includes('DECISION_NEED'))).toBe(true)
  })

  it('authorizes with receipt-only payload proof', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        payloadBody: null,
        payloadVerificationReceipt: validReceipt(),
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.prepared.execution).toBe('PLAN_ONLY_NOT_EXECUTED')
  })

  it('projects + redacts records only after gate passes', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        records: [
          {
            id: 't1',
            title: 'hello',
            boardId: 'mfs-rebuild',
            extraDrop: 'gone',
          },
          {
            id: 't2',
            title: 'world',
            status: 'done',
          },
        ],
      }),
    )
    expect(r.ok).toBe(true)
    if (!r.ok) return
    expect(r.prepared.redactedRecords).toHaveLength(2)
    const first = r.prepared.redactedRecords![0]
    expect(first.id).toBe('t1')
    expect(first.title).toBe('hello')
    expect(first.extraDrop).toBeUndefined()
    expect(r.prepared.execution).toBe('PLAN_ONLY_NOT_EXECUTED')
  })

  it('refuses records that carry forbidden fields (projection fail-closed)', () => {
    const r = authorizeAndPrepareStagingProductionDerivedLoad(
      validInput({
        records: [{ id: 't1', title: 'ok', accessToken: 'leak' }],
      }),
    )
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('PROJECTION_FAILED')
    expect(r.fallback).toBe('USE_SYNTHETIC_FIXTURES')
  })

  it('assertStagingProductionDerivedLoadAuthorized throws on refuse', () => {
    expect(() =>
      assertStagingProductionDerivedLoadAuthorized(
        validInput({ productionReadApprovalId: '' }),
      ),
    ).toThrow(/productionReadApprovalId/i)

    const allowed = assertStagingProductionDerivedLoadAuthorized(validInput())
    expect(allowed.ok).toBe(true)
    expect(allowed.mode).toBe('PRODUCTION_DERIVED')
  })
})
