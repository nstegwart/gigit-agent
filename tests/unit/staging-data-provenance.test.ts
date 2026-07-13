import { describe, expect, it } from 'vitest'

import {
  DEFAULT_REDACTION_POLICY_VERSION,
  DEFAULT_STAGING_FIELD_ALLOWLIST,
  FORBIDDEN_PRODUCTION_EXPORT_FIELDS,
  PAYLOAD_SCAN_MAX_DEPTH,
  STAGING_DATA_PROVENANCE_SCHEMA,
  buildExportManifest,
  computePayloadHash,
  evaluateStagingDataLoad,
  findForbiddenFieldsInAllowlist,
  findForbiddenPayloadFields,
  hasDualApprovals,
  isForbiddenExportField,
  projectAllowlistedRecord,
  redactForStagingLoad,
  type ExportManifest,
  type PayloadVerificationReceipt,
} from '#/server/staging-data-provenance'

const FUTURE = '2099-01-01T00:00:00.000Z'
const PAST = '2000-01-01T00:00:00.000Z'
const NOW_MS = Date.parse('2026-07-13T19:17:07.000Z')

function validManifest(
  overrides: Partial<ExportManifest> = {},
): ExportManifest {
  const body = JSON.stringify({ id: 't1', title: 'hello' })
  const base = buildExportManifest({
    sourceEnvironment: 'production',
    observedAt: '2026-07-13T12:00:00.000Z',
    exportedAt: '2026-07-13T12:05:00.000Z',
    sourceRevisionOrHash: 'abc123deadbeef',
    exportTool: 'staging-export-cli',
    exportToolVersion: '1.0.0',
    fieldAllowlist: [...DEFAULT_STAGING_FIELD_ALLOWLIST],
    redactionPolicyVersion: DEFAULT_REDACTION_POLICY_VERSION,
    recordCounts: { tasks: 2, runs: 0 },
    payloadBody: body,
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
  const body = JSON.stringify({ id: 't1', title: 'hello' })
  return {
    payloadHash: computePayloadHash(body),
    recordCount: 2, // tasks:2 + runs:0
    algorithm: 'sha256',
    ...overrides,
  }
}

function validProductionRequest(
  overrides: Partial<Parameters<typeof evaluateStagingDataLoad>[0]> = {},
) {
  return evaluateStagingDataLoad({
    mode: 'PRODUCTION_DERIVED',
    productionReadApprovalId: 'prod-read-appr-001',
    stagingLoadApprovalId: 'staging-load-appr-002',
    fieldAllowlist: [...DEFAULT_STAGING_FIELD_ALLOWLIST],
    redactionPolicyVersion: DEFAULT_REDACTION_POLICY_VERSION,
    purpose: 'staging-parity-rehearsal',
    expiresAt: FUTURE,
    exportManifest: validManifest(),
    payloadBody: JSON.stringify({ id: 't1', title: 'hello' }),
    nowMs: NOW_MS,
    ...overrides,
  })
}

/** Build nested object of exact depth (depth 0 = leaf value at root). */
function nestDepth(depth: number, leaf: Record<string, unknown>): unknown {
  let cur: unknown = leaf
  for (let i = 0; i < depth; i++) {
    cur = { child: cur }
  }
  return cur
}

describe('AC-DATA-02 synthetic path', () => {
  it('allows SYNTHETIC mode without approvals or manifest', () => {
    const d = evaluateStagingDataLoad({ mode: 'SYNTHETIC' })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.schema).toBe(STAGING_DATA_PROVENANCE_SCHEMA)
    expect(d.mode).toBe('SYNTHETIC')
    expect(d.exportManifest).toBeNull()
    expect(d.redactionPolicyVersion).toBe('SYNTHETIC_NONE')
  })
})

describe('AC-DATA-01 dual-approval gate', () => {
  it('refuses production-derived without productionReadApprovalId', () => {
    const d = validProductionRequest({ productionReadApprovalId: null })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_PRODUCTION_READ_APPROVAL')
    expect(d.fallback).toBe('USE_SYNTHETIC_FIXTURES')
  })

  it('refuses production-derived without stagingLoadApprovalId', () => {
    const d = validProductionRequest({ stagingLoadApprovalId: '' })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_STAGING_LOAD_APPROVAL')
  })

  it('refuses when both approval IDs are identical', () => {
    const same = 'same-approval-id'
    const d = validProductionRequest({
      productionReadApprovalId: same,
      stagingLoadApprovalId: same,
      exportManifest: validManifest({
        approvals: {
          productionReadApprovalId: same,
          stagingLoadApprovalId: same,
        },
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('APPROVALS_NOT_DISTINCT')
  })

  it('refuses without redactionPolicyVersion', () => {
    const d = validProductionRequest({ redactionPolicyVersion: null })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_REDACTION_POLICY_VERSION')
  })

  it('refuses unknown redactionPolicyVersion', () => {
    const d = validProductionRequest({ redactionPolicyVersion: 'NOPE_V9' })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('UNKNOWN_REDACTION_POLICY_VERSION')
  })

  it('refuses missing / empty field allowlist', () => {
    const missing = validProductionRequest({ fieldAllowlist: null })
    expect(missing.ok).toBe(false)
    if (!missing.ok) expect(missing.code).toBe('MISSING_FIELD_ALLOWLIST')

    const empty = validProductionRequest({ fieldAllowlist: [] })
    expect(empty.ok).toBe(false)
    if (!empty.ok) expect(empty.code).toBe('EMPTY_FIELD_ALLOWLIST')
  })

  it('refuses allowlist containing forbidden fields (tokens/secrets/PII)', () => {
    const d = validProductionRequest({
      fieldAllowlist: ['id', 'token', 'decisionText'],
      exportManifest: validManifest({
        fieldAllowlist: ['id', 'token', 'decisionText'],
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('FORBIDDEN_FIELD_IN_ALLOWLIST')
  })

  it('refuses without export manifest', () => {
    const d = validProductionRequest({ exportManifest: null })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_EXPORT_MANIFEST')
  })

  it('refuses incomplete export manifest', () => {
    const d = validProductionRequest({
      exportManifest: validManifest({ sourceRevisionOrHash: '' }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MANIFEST_MISSING_REQUIRED_FIELD')
  })

  it('refuses manifest approval mismatch', () => {
    const d = validProductionRequest({
      exportManifest: validManifest({
        approvals: {
          productionReadApprovalId: 'other-prod',
          stagingLoadApprovalId: 'staging-load-appr-002',
        },
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MANIFEST_APPROVAL_MISMATCH')
  })

  it('refuses manifest allowlist / redaction mismatch', () => {
    const allow = validProductionRequest({
      exportManifest: validManifest({
        fieldAllowlist: ['id', 'title'],
      }),
    })
    expect(allow.ok).toBe(false)
    if (!allow.ok) expect(allow.code).toBe('MANIFEST_ALLOWLIST_MISMATCH')

    const redaction = validProductionRequest({
      exportManifest: validManifest({
        redactionPolicyVersion: 'STAGING_REDACTION_V1_STRICT',
      }),
    })
    expect(redaction.ok).toBe(false)
    if (!redaction.ok) expect(redaction.code).toBe('MANIFEST_REDACTION_MISMATCH')
  })

  it('refuses expired purpose', () => {
    const d = validProductionRequest({ expiresAt: PAST })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PURPOSE_EXPIRED')
  })

  it('refuses missing purpose/expiry', () => {
    const p = validProductionRequest({ purpose: null })
    expect(p.ok).toBe(false)
    if (!p.ok) expect(p.code).toBe('MISSING_PURPOSE')

    const e = validProductionRequest({ expiresAt: null })
    expect(e.ok).toBe(false)
    if (!e.ok) expect(e.code).toBe('MISSING_EXPIRY')
  })

  it('refuses production destination', () => {
    const d = validProductionRequest({
      exportManifest: validManifest({ destination: 'production-db-primary' }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PRODUCTION_DESTINATION_FORBIDDEN')
  })

  it('refuses payload with forbidden fields', () => {
    const d = validProductionRequest({
      payloadSample: {
        id: 't1',
        nested: { token: 'secret-value', title: 'x' },
      },
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('FORBIDDEN_PAYLOAD_FIELD')
  })

  it('refuses payload hash mismatch', () => {
    const d = validProductionRequest({
      payloadBody: JSON.stringify({ id: 'different' }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_HASH_MISMATCH')
  })

  it('allows fully authorized production-derived load', () => {
    const body = JSON.stringify({ id: 't1', title: 'hello' })
    const d = validProductionRequest({
      payloadBody: body,
      payloadSample: { id: 't1', title: 'hello', boardId: 'b1' },
    })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.mode).toBe('PRODUCTION_DERIVED')
    expect(d.approvals?.productionReadApprovalId).toBe('prod-read-appr-001')
    expect(d.approvals?.stagingLoadApprovalId).toBe('staging-load-appr-002')
    expect(d.redactionPolicyVersion).toBe(DEFAULT_REDACTION_POLICY_VERSION)
    expect(d.exportManifest?.payloadHash).toBe(computePayloadHash(body))
    expect(d.fieldAllowlist.length).toBeGreaterThan(0)
    expect(d.residualGaps.length).toBeGreaterThan(0)
  })
})

describe('F4 fail-closed payload proof', () => {
  it('refuses when both payloadBody and payloadVerificationReceipt are omitted', () => {
    const d = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: null,
      payloadSample: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_PAYLOAD_PROOF')
    expect(d.fallback).toBe('USE_SYNTHETIC_FIXTURES')
  })

  it('refuses when payloadBody is undefined and receipt absent (legacy bypass)', () => {
    const d = validProductionRequest({
      payloadBody: undefined,
      payloadVerificationReceipt: undefined,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_PAYLOAD_PROOF')
  })

  it('refuses payloadSample alone without body or receipt (not verifiable proof)', () => {
    const d = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: null,
      payloadSample: { id: 't1', title: 'hello' },
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('MISSING_PAYLOAD_PROOF')
  })

  it('allows production-derived with valid payloadVerificationReceipt only', () => {
    const d = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: validReceipt(),
    })
    expect(d.ok).toBe(true)
    if (!d.ok) return
    expect(d.mode).toBe('PRODUCTION_DERIVED')
    expect(
      d.residualGaps.some((g) => g.includes('receipt only')),
    ).toBe(true)
  })

  it('refuses invalid receipt (hash mismatch)', () => {
    const d = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: validReceipt({
        payloadHash: 'sha256:deadbeef',
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_HASH_MISMATCH')
  })

  it('refuses invalid receipt (recordCount mismatch)', () => {
    const d = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: validReceipt({ recordCount: 99 }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('INVALID_PAYLOAD_VERIFICATION_RECEIPT')
  })

  it('refuses invalid receipt (missing hash / bad count / bad algorithm)', () => {
    const missingHash = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: {
        payloadHash: '',
        recordCount: 2,
      },
    })
    expect(missingHash.ok).toBe(false)
    if (!missingHash.ok) {
      expect(missingHash.code).toBe('INVALID_PAYLOAD_VERIFICATION_RECEIPT')
    }

    const badCount = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: validReceipt({
        recordCount: 1.5 as unknown as number,
      }),
    })
    // 1.5 is not integer → invalid
    expect(badCount.ok).toBe(false)
    if (!badCount.ok) {
      expect(badCount.code).toBe('INVALID_PAYLOAD_VERIFICATION_RECEIPT')
    }

    const badAlgo = validProductionRequest({
      payloadBody: null,
      payloadVerificationReceipt: validReceipt({
        algorithm: 'md5' as 'sha256',
      }),
    })
    expect(badAlgo.ok).toBe(false)
    if (!badAlgo.ok) {
      expect(badAlgo.code).toBe('INVALID_PAYLOAD_VERIFICATION_RECEIPT')
    }
  })

  it('refuses JSON payloadBody containing forbidden fields (body scan)', () => {
    const toxic = JSON.stringify({ id: 't1', accessToken: 'leak-me' })
    const d = validProductionRequest({
      payloadBody: toxic,
      exportManifest: validManifest({
        payloadHash: computePayloadHash(toxic),
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('FORBIDDEN_PAYLOAD_FIELD')
  })

  it('refuses deep nesting in payloadSample (never silent skip)', () => {
    // depth of nesting > PAYLOAD_SCAN_MAX_DEPTH must reject
    const deep = nestDepth(PAYLOAD_SCAN_MAX_DEPTH + 2, {
      token: 'hidden-deep-secret',
    })
    const d = validProductionRequest({
      payloadSample: deep,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_SCAN_DEPTH_EXCEEDED')
  })

  it('refuses deep nesting via JSON payloadBody', () => {
    const deep = nestDepth(PAYLOAD_SCAN_MAX_DEPTH + 2, { id: 'ok' })
    const body = JSON.stringify(deep)
    const d = validProductionRequest({
      payloadBody: body,
      exportManifest: validManifest({
        payloadHash: computePayloadHash(body),
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_SCAN_DEPTH_EXCEEDED')
  })

  it('refuses cyclic payloadSample', () => {
    const cyclic: Record<string, unknown> = { id: '1' }
    cyclic.self = cyclic
    const d = validProductionRequest({
      payloadSample: cyclic,
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_SCAN_CYCLIC')
  })

  it('refuses non-JSON object types in payloadSample (Date)', () => {
    const d = validProductionRequest({
      payloadSample: { id: '1', when: new Date('2026-01-01') },
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_SCAN_INVALID')
  })

  it('refuses malformed JSON-looking payloadBody rather than skipping scan', () => {
    const bad = '{ not valid json'
    const d = validProductionRequest({
      payloadBody: bad,
      exportManifest: validManifest({
        payloadHash: computePayloadHash(bad),
      }),
    })
    expect(d.ok).toBe(false)
    if (d.ok) return
    expect(d.code).toBe('PAYLOAD_SCAN_INVALID')
  })
})

describe('field allowlist / redaction helpers', () => {
  it('flags every documented never-copy field as forbidden', () => {
    for (const f of FORBIDDEN_PRODUCTION_EXPORT_FIELDS) {
      expect(isForbiddenExportField(f)).toBe(true)
    }
    expect(isForbiddenExportField('title')).toBe(false)
    expect(isForbiddenExportField('boardId')).toBe(false)
  })

  it('flags mixed-casing forbidden field names', () => {
    expect(isForbiddenExportField('Token')).toBe(true)
    expect(isForbiddenExportField('ACCESS_TOKEN')).toBe(true)
    expect(isForbiddenExportField('AccessToken')).toBe(true)
    expect(isForbiddenExportField('OWNER_COMMENTS')).toBe(true)
    expect(isForbiddenExportField('DecisionText')).toBe(true)
    expect(isForbiddenExportField('RawIdentity')).toBe(true)
    expect(isForbiddenExportField('private_key')).toBe(true)
  })

  it('findForbiddenFieldsInAllowlist returns only bad fields', () => {
    expect(
      findForbiddenFieldsInAllowlist(['id', 'password', 'title', 'rawIdentity']),
    ).toEqual(['password', 'rawIdentity'])
  })

  it('findForbiddenPayloadFields walks nested objects', () => {
    const hits = findForbiddenPayloadFields({
      id: 1,
      owner: { comments: 'private', name: 'ok' },
    })
    expect(hits.ok).toBe(true)
    if (!hits.ok) return
    expect(hits.paths).toContain('owner.comments')
  })

  it('findForbiddenPayloadFields walks arrays', () => {
    const hits = findForbiddenPayloadFields({
      items: [{ id: 1 }, { token: 'x' }, { nested: [{ decisionText: 'secret' }] }],
    })
    expect(hits.ok).toBe(true)
    if (!hits.ok) return
    expect(hits.paths).toContain('items[1].token')
    expect(hits.paths).toContain('items[2].nested[0].decisionText')
  })

  it('findForbiddenPayloadFields detects mixed-casing keys in tree', () => {
    const hits = findForbiddenPayloadFields({
      meta: { Access_Token: 'abc', title: 'ok' },
    })
    expect(hits.ok).toBe(true)
    if (!hits.ok) return
    expect(hits.paths.some((p) => /access.?token/i.test(p))).toBe(true)
  })

  it('findForbiddenPayloadFields fails closed on deep nesting', () => {
    const deep = nestDepth(PAYLOAD_SCAN_MAX_DEPTH + 1, { id: 1 })
    const hits = findForbiddenPayloadFields(deep)
    expect(hits.ok).toBe(false)
    if (hits.ok) return
    expect(hits.code).toBe('PAYLOAD_SCAN_DEPTH_EXCEEDED')
  })

  it('findForbiddenPayloadFields fails closed on cycles', () => {
    const a: Record<string, unknown> = { id: 1 }
    const b: Record<string, unknown> = { id: 2, a }
    a.b = b
    const hits = findForbiddenPayloadFields(a)
    expect(hits.ok).toBe(false)
    if (hits.ok) return
    expect(hits.code).toBe('PAYLOAD_SCAN_CYCLIC')
  })

  it('findForbiddenPayloadFields fails closed on non-JSON types', () => {
    const hits = findForbiddenPayloadFields({ d: new Date() })
    expect(hits.ok).toBe(false)
    if (hits.ok) return
    expect(hits.code).toBe('PAYLOAD_SCAN_INVALID')
  })

  it('projectAllowlistedRecord drops non-allowlisted and refuses forbidden', () => {
    const ok = projectAllowlistedRecord(
      { id: '1', title: 't', extra: 'drop-me' },
      ['id', 'title'],
    )
    expect(ok.ok).toBe(true)
    if (ok.ok) {
      expect(ok.projected).toEqual({ id: '1', title: 't' })
      expect(ok.projected.extra).toBeUndefined()
    }

    const bad = projectAllowlistedRecord({ id: '1', token: 'x' }, ['id'])
    expect(bad.ok).toBe(false)
    if (!bad.ok) expect(bad.code).toBe('FORBIDDEN_PAYLOAD_FIELD')
  })

  it('redactForStagingLoad redacts or drops forbidden keys by policy', () => {
    const input = {
      id: '1',
      title: 'ok',
      token: 'secret',
      nested: { password: 'p', count: 2 },
      dropped: 'nope',
    }
    const v1 = redactForStagingLoad(input, {
      redactionPolicyVersion: 'STAGING_REDACTION_V1',
      fieldAllowlist: ['id', 'title', 'token', 'nested'],
    })
    expect(v1.ok).toBe(true)
    if (!v1.ok) return
    const v1v = v1.value as Record<string, unknown>
    expect(v1v.id).toBe('1')
    expect(v1v.title).toBe('ok')
    expect(v1v.token).toBe('[REDACTED]')
    expect((v1v.nested as Record<string, unknown>).password).toBe('[REDACTED]')
    expect((v1v.nested as Record<string, unknown>).count).toBe(2)
    expect(v1v.dropped).toBeUndefined()

    const strict = redactForStagingLoad(input, {
      redactionPolicyVersion: 'STAGING_REDACTION_V1_STRICT',
      fieldAllowlist: ['id', 'title', 'token', 'nested'],
    })
    expect(strict.ok).toBe(true)
    if (!strict.ok) return
    const sv = strict.value as Record<string, unknown>
    expect(sv.token).toBeUndefined()
    expect((sv.nested as Record<string, unknown>).password).toBeUndefined()
  })

  it('redactForStagingLoad never returns raw deep subtree (rejects)', () => {
    const deep = nestDepth(PAYLOAD_SCAN_MAX_DEPTH + 2, {
      token: 'must-not-leak',
      decisionText: 'private',
    })
    const r = redactForStagingLoad(deep, {
      redactionPolicyVersion: 'STAGING_REDACTION_V1',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('PAYLOAD_SCAN_DEPTH_EXCEEDED')
    // ensure no accidental raw leak via value field
    expect('value' in r).toBe(false)
  })

  it('redactForStagingLoad redacts secrets in arrays and mixed casing', () => {
    const input = {
      id: '1',
      rows: [
        { Title: 'a', Token: 't1' },
        { title: 'b', ownerComments: 'private note' },
      ],
    }
    const r = redactForStagingLoad(input, {
      redactionPolicyVersion: 'STAGING_REDACTION_V1',
      fieldAllowlist: ['id', 'rows'],
    })
    expect(r.ok).toBe(true)
    if (!r.ok) return
    const v = r.value as {
      id: string
      rows: Array<Record<string, unknown>>
    }
    expect(v.rows[0].Token).toBe('[REDACTED]')
    expect(v.rows[1].ownerComments).toBe('[REDACTED]')
    expect(JSON.stringify(r.value)).not.toContain('private note')
    expect(JSON.stringify(r.value)).not.toContain('t1')
  })

  it('redactForStagingLoad fails closed on cycles', () => {
    const cyclic: Record<string, unknown> = { id: '1' }
    cyclic.self = cyclic
    const r = redactForStagingLoad(cyclic, {
      redactionPolicyVersion: 'STAGING_REDACTION_V1',
    })
    expect(r.ok).toBe(false)
    if (r.ok) return
    expect(r.code).toBe('PAYLOAD_SCAN_CYCLIC')
  })

  it('hasDualApprovals requires distinct non-empty IDs', () => {
    expect(hasDualApprovals('a', 'b')).toBe(true)
    expect(hasDualApprovals('a', 'a')).toBe(false)
    expect(hasDualApprovals(null, 'b')).toBe(false)
    expect(hasDualApprovals('a', '')).toBe(false)
  })

  it('computePayloadHash is stable sha256 prefix', () => {
    const h = computePayloadHash('hello')
    expect(h.startsWith('sha256:')).toBe(true)
    expect(h).toBe(computePayloadHash('hello'))
    expect(h).not.toBe(computePayloadHash('hello!'))
  })
})
