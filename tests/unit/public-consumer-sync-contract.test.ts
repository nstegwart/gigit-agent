/**
 * Unit gates for MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1 fixtures + validators.
 * Support evidence only (LOCAL ONLY) — does not prove consumer deploy.
 */
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

import {
  CANONICAL_MASK_RE,
  CONTRACT_ID,
  OPENAPI_VERSION,
  SCHEMA_VERSION,
  SERIALIZER_VERSION,
  etagMatches,
  findForbiddenKeys,
  findMockMarkers,
  normalizeEtag,
  shouldReturn304,
  validateAtomicPublishReceipt,
  validatePin,
  validatePublicSnapshotPayload,
  validateRateLimitedBody,
  validateStaleOrMissingBody,
} from '../../qa/fixtures/public-consumer-sync/conformance-lib.mjs'

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '../..')
const FIX = join(ROOT, 'qa/fixtures/public-consumer-sync')
const DOCS = join(ROOT, 'docs/control-center/public-consumer-sync')

function load(name: string) {
  return JSON.parse(readFileSync(join(FIX, name), 'utf8'))
}

describe('MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1 package', () => {
  it('exports stable contract identifiers', () => {
    expect(CONTRACT_ID).toBe('MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1')
    expect(OPENAPI_VERSION).toBe('MFS_PUBLIC_CONSUMER_SYNC_V1')
    expect(SCHEMA_VERSION).toBe('MFS_PUBLIC_SNAPSHOT_V1')
    expect(SERIALIZER_VERSION).toBe('PUBLIC_SNAPSHOT_V1')
  })

  it('ships versioned OpenAPI + worker packet with unresolved authority', () => {
    const openapi = readFileSync(
      join(DOCS, 'MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml'),
      'utf8',
    )
    expect(openapi).toContain('version: MFS_PUBLIC_CONSUMER_SYNC_V1')
    expect(openapi).toContain('/api/public-snapshot')
    expect(openapi).toContain('PUBLIC_SNAPSHOT_RATE_LIMIT_V1')
    expect(openapi).toContain('AtomicPublishReceipt')

    const packet = readFileSync(
      join(DOCS, 'MFS_PUBLIC_CONSUMER_WORKER_PACKET.md'),
      'utf8',
    )
    expect(packet).toMatch(/UNRESOLVED/)
    expect(packet).toMatch(/EXCLUDED/)
    expect(packet).toContain('/opt/mfs/workspace/CONTRACT')
    expect(packet).toContain('/var/www/contract')
    expect(packet).toMatch(/rollback/i)
    expect(packet).toMatch(/no-secret/i)
  })

  it('validates golden snapshot pin, freshness, counts, redaction', () => {
    const golden = load('golden-public-snapshot-200.json')
    const expected = load('expected-pin.json')
    const result = validatePublicSnapshotPayload(golden, {
      boardId: expected.boardId,
    })
    expect(result.errors).toEqual([])
    expect(result.ok).toBe(true)
    expect(result.checks.schema_and_pin).toBe(true)
    expect(result.checks.freshness_shape).toBe(true)
    expect(result.checks.counts_consistency).toBe(true)
    expect(result.checks.redaction).toBe(true)
    expect(result.checks.etag_internal).toBe(true)
    expect(golden.pin).toEqual(expected.pin)
    expect(golden.pin.canonicalHash).toMatch(/^[a-f0-9]{64}$/i)
    expect(golden.pin.boardRev).toBe(125)
    expect(golden.pin.lifecycleRev).toBe(3)
    expect(golden.tasks).toHaveLength(8)
    expect(golden.usableCapacity).toBe(0)
  })

  it('rejects incomplete pin and hostile leak payloads', () => {
    const bad = load('invalid-pin-snapshot.json')
    expect(validatePin(bad.pin).ok).toBe(false)
    expect(validatePublicSnapshotPayload(bad).checks.schema_and_pin).toBe(false)

    const hostile = load('hostile-leak-snapshot.json')
    const hv = validatePublicSnapshotPayload(hostile)
    expect(hv.ok).toBe(false)
    expect(hv.checks.redaction).toBe(false)
    expect(findForbiddenKeys(hostile).length).toBeGreaterThan(0)
  })

  it('validates 429 and 503 error bodies', () => {
    expect(validateRateLimitedBody(load('rate-limited-429.json')).ok).toBe(true)
    expect(validateStaleOrMissingBody(load('stale-or-missing-503.json')).ok).toBe(
      true,
    )
    expect(validateRateLimitedBody({ code: 'OTHER' }).ok).toBe(false)
  })

  it('implements ETag/304 matching helpers', () => {
    const etag = 'b8b57d0ffc805cb1048970715017626435dad86c92ebfa9efda2fd59447c81fb'
    expect(normalizeEtag(`"${etag}"`)).toBe(etag)
    expect(etagMatches(etag, `"${etag}"`)).toBe(true)
    expect(shouldReturn304(etag, `"${etag}"`)).toBe(true)
    expect(shouldReturn304(etag, undefined)).toBe(false)
  })

  it('accepts atomic publish receipt and rejects mock-labelled publish', () => {
    const good = load('atomic-publish-receipt.example.json')
    const g = validateAtomicPublishReceipt(good)
    expect(g.errors).toEqual([])
    expect(g.ok).toBe(true)
    expect(good.publish.noMockLabels).toBe(true)
    expect(good.publish.mode).toBe('atomic_rename')
    expect(good.source.pin.serializerVersion).toBe(SERIALIZER_VERSION)

    const mock = load('publish-with-mock-labels.json')
    const m = validateAtomicPublishReceipt(mock)
    expect(m.ok).toBe(false)
    expect(m.mockHits.length).toBeGreaterThan(0)
    expect(findMockMarkers(mock)).toEqual(expect.arrayContaining(['MOCK_LABEL']))
  })

  it('enforces canonical account mask regex', () => {
    expect(CANONICAL_MASK_RE.test('acc_***l001')).toBe(true)
    expect(CANONICAL_MASK_RE.test('acc_plaintextSECRET')).toBe(false)
    expect(CANONICAL_MASK_RE.test('acc_***')).toBe(false)
  })

  it('conformance manifest indexes all fixture files', () => {
    const manifest = load('conformance-manifest.json')
    expect(manifest.contractId).toBe(CONTRACT_ID)
    for (const rel of Object.values(manifest.fixtures) as string[]) {
      const text = readFileSync(join(FIX, rel), 'utf8')
      expect(text.length).toBeGreaterThan(2)
    }
  })
})
