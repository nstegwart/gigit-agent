#!/usr/bin/env node
/**
 * MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1 — executable conformance.
 *
 * Modes:
 *   default / CONFORMANCE_MODE=fixture — offline fixtures only (no network)
 *   CONFORMANCE_MODE=live or WEB_BASE set with --live — HTTP ETag/304/429 probes
 *
 * Env:
 *   WEB_BASE   — TM base for LIVE (e.g. http://127.0.0.1:33211)
 *   BOARD_ID   — default mfs-rebuild
 *   HEADED     — unused (HTTP-only flow)
 *   CONFORMANCE_MODE — fixture | live | both (default: fixture)
 *
 * Exit 0 only if all selected checks pass. Never mutates consumer paths.
 */
import { readFileSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  CONTRACT_ID,
  etagMatches,
  normalizeEtag,
  shouldReturn304,
  validateAtomicPublishReceipt,
  validatePin,
  validatePublicSnapshotPayload,
  validateRateLimitedBody,
  validateStaleOrMissingBody,
} from '../../fixtures/public-consumer-sync/conformance-lib.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')
const FIXTURE_DIR = join(REPO_ROOT, 'qa/fixtures/public-consumer-sync')
const DOCS_DIR = join(REPO_ROOT, 'docs/control-center/public-consumer-sync')

function loadJson(name) {
  const p = join(FIXTURE_DIR, name)
  return JSON.parse(readFileSync(p, 'utf8'))
}

function resolveMode() {
  const raw = (process.env.CONFORMANCE_MODE || '').trim().toLowerCase()
  if (raw === 'live' || raw === 'both' || raw === 'fixture') return raw
  if (process.argv.includes('--live')) return 'both'
  return 'fixture'
}

function resolveWebBase() {
  const raw = process.env.WEB_BASE?.trim()
  if (raw) return raw.replace(/\/$/, '')
  return ''
}

function resolveBoardId() {
  return process.env.BOARD_ID?.trim() || 'mfs-rebuild'
}

function printOwnerTarget(extra = {}) {
  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: resolveWebBase() || 'fixture-only',
      port: 'n/a',
      account: 'n/a-public',
      device: 'n/a',
      boardId: resolveBoardId(),
      contract: CONTRACT_ID,
      ...extra,
    })}`,
  )
}

/**
 * @typedef {{ id: string, ok: boolean, detail?: string }} CheckResult
 */

/** @type {CheckResult[]} */
const results = []

function record(id, ok, detail = '') {
  results.push({ id, ok, detail })
  const mark = ok ? 'PASS' : 'FAIL'
  console.log(`[${mark}] ${id}${detail ? ` — ${detail}` : ''}`)
}

function runFixtureSuite() {
  console.log('=== FIXTURE suite ===')

  // Docs present
  for (const rel of [
    'MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1.md',
    'MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml',
    'MFS_PUBLIC_CONSUMER_WORKER_PACKET.md',
  ]) {
    const p = join(DOCS_DIR, rel)
    record(`docs_present:${rel}`, existsSync(p), p)
  }

  const openapi = readFileSync(
    join(DOCS_DIR, 'MFS_PUBLIC_CONSUMER_SYNC_V1.openapi.yaml'),
    'utf8',
  )
  record(
    'openapi_version_line',
    openapi.includes('version: MFS_PUBLIC_CONSUMER_SYNC_V1'),
    'info.version MFS_PUBLIC_CONSUMER_SYNC_V1',
  )

  const golden = loadJson('golden-public-snapshot-200.json')
  const expectedPin = loadJson('expected-pin.json')
  const v = validatePublicSnapshotPayload(golden, { boardId: expectedPin.boardId })
  record('schema_and_pin', v.checks.schema_and_pin, v.errors.filter((e) => e.includes('pin') || e.includes('schema')).join('; '))
  record('freshness_shape', v.checks.freshness_shape, v.errors.filter((e) => e.startsWith('freshness')).join('; '))
  record('counts_consistency', v.checks.counts_consistency && !v.errors.some((e) => e.startsWith('counts_consistency')), v.errors.filter((e) => e.startsWith('counts_consistency')).join('; '))
  record('redaction_golden', v.checks.redaction, v.errors.filter((e) => e.startsWith('redaction')).join('; '))
  record('etag_internal', v.checks.etag_internal, v.errors.filter((e) => e.includes('etag') || e.includes('payloadSha256')).join('; '))
  record('golden_payload_ok', v.ok, v.errors.join('; '))

  // Pin lock against expected fixture pin (frozen synth; compare by field, not key order)
  const pinFields = [
    'canonicalSnapshotId',
    'canonicalHash',
    'boardRev',
    'lifecycleRev',
    'serializerVersion',
  ]
  const pinEq =
    golden.schemaVersion === expectedPin.schemaVersion &&
    golden.boardId === expectedPin.boardId &&
    pinFields.every((k) => golden.pin?.[k] === expectedPin.pin?.[k])
  record(
    'pinned_canonical_fields',
    pinEq,
    `boardRev=${golden.pin.boardRev} lifecycleRev=${golden.pin.lifecycleRev} hash=${String(golden.pin.canonicalHash).slice(0, 12)}…`,
  )

  // ETag / 304 decision logic (offline)
  const etag = golden.etag
  record(
    'etag_304_decision',
    shouldReturn304(etag, `"${etag}"`) === true &&
      shouldReturn304(etag, null) === false &&
      etagMatches(etag, `"${etag}"`),
    `etag=${etag.slice(0, 12)}…`,
  )

  const rl = loadJson('rate-limited-429.json')
  const rlv = validateRateLimitedBody(rl)
  record('rate_limit_429_body', rlv.ok, rlv.errors.join('; '))

  const st = loadJson('stale-or-missing-503.json')
  const stv = validateStaleOrMissingBody(st)
  record('stale_or_missing_503_body', stv.ok, stv.errors.join('; '))

  const badPin = loadJson('invalid-pin-snapshot.json')
  const badPinV = validatePublicSnapshotPayload(badPin)
  record(
    'invalid_pin_rejected',
    !badPinV.checks.schema_and_pin && !validatePin(badPin.pin).ok,
    badPinV.errors.slice(0, 3).join('; '),
  )

  const hostile = loadJson('hostile-leak-snapshot.json')
  const hv = validatePublicSnapshotPayload(hostile)
  record(
    'hostile_redaction_rejected',
    !hv.ok && !hv.checks.redaction,
    hv.errors.slice(0, 4).join('; '),
  )

  const goodPub = loadJson('atomic-publish-receipt.example.json')
  const gpv = validateAtomicPublishReceipt(goodPub)
  record('atomic_publish_ok', gpv.ok, gpv.errors.join('; '))

  const mockPub = loadJson('publish-with-mock-labels.json')
  const mpv = validateAtomicPublishReceipt(mockPub)
  record(
    'atomic_publish_mock_rejected',
    !mpv.ok && mpv.mockHits.length > 0,
    `mockHits=${mpv.mockHits.join(',')}`,
  )

  // Worker packet authority language present
  const packet = readFileSync(
    join(DOCS_DIR, 'MFS_PUBLIC_CONSUMER_WORKER_PACKET.md'),
    'utf8',
  )
  record(
    'worker_packet_unresolved_authority',
    packet.includes('UNRESOLVED') &&
      packet.includes('EXCLUDED') &&
      packet.includes('/opt/mfs/workspace/CONTRACT') &&
      packet.includes('/var/www/contract') &&
      packet.includes('no-secret'),
    'source/serve/deploy unresolved + no-secret section',
  )
  record(
    'worker_packet_rollback',
    /rollback/i.test(packet) && packet.includes('.prev'),
    'rollback strategy documented',
  )
}

async function liveGet(base, boardId, headers = {}) {
  const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
  const res = await fetch(url, {
    headers: { accept: 'application/json', ...headers },
  })
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  return {
    url,
    status: res.status,
    headers: {
      etag: res.headers.get('etag'),
      serializer: res.headers.get('x-public-serializer'),
      retryAfter: res.headers.get('retry-after'),
      rateLimitPolicy: res.headers.get('x-ratelimit-policy'),
      rateLimitLimit: res.headers.get('x-ratelimit-limit'),
      snapshotStale: res.headers.get('x-snapshot-stale'),
    },
    body,
    text,
  }
}

async function runLiveSuite() {
  console.log('=== LIVE suite ===')
  const base = resolveWebBase()
  const boardId = resolveBoardId()
  if (!base) {
    record('live_skipped_no_WEB_BASE', false, 'WEB_BASE required for LIVE')
    return
  }

  printOwnerTarget({ mode: 'live', flow: 'public-consumer-conformance' })

  let first
  try {
    first = await liveGet(base, boardId)
  } catch (e) {
    record('live_fetch_200', false, String(e?.stack || e))
    return
  }

  if (first.status === 503) {
    const stv = validateStaleOrMissingBody(first.body)
    record(
      'live_503_shape',
      stv.ok,
      `status=503 ${stv.errors.join('; ') || JSON.stringify(first.body)}`,
    )
    record(
      'live_200_payload',
      false,
      'got 503 STALE_OR_MISSING — cannot prove pin/304 on this target',
    )
    return
  }

  if (first.status === 429) {
    const rlv = validateRateLimitedBody(first.body)
    record('live_immediate_429', rlv.ok, 'rate limited before first 200; cool down and retry')
    return
  }

  if (first.status !== 200 || !first.body) {
    record(
      'live_fetch_200',
      false,
      `status=${first.status} bodyKeys=${first.body ? Object.keys(first.body) : []}`,
    )
    return
  }

  record('live_fetch_200', true, `url=${first.url}`)
  const v = validatePublicSnapshotPayload(first.body, { boardId })
  record('live_schema_and_pin', v.checks.schema_and_pin, v.errors.slice(0, 5).join('; '))
  record('live_freshness', v.checks.freshness_shape, '')
  record('live_counts', v.checks.counts_consistency, '')
  record('live_redaction', v.checks.redaction, v.errors.filter((e) => e.startsWith('redaction')).join('; '))
  record(
    'live_header_etag_match',
    etagMatches(first.headers.etag, first.body.etag),
    `hdr=${first.headers.etag} body=${first.body.etag}`,
  )
  record(
    'live_serializer_header',
    first.headers.serializer === 'PUBLIC_SNAPSHOT_V1',
    String(first.headers.serializer),
  )

  // 304
  const etag = normalizeEtag(first.headers.etag || first.body.etag)
  try {
    const second = await liveGet(base, boardId, {
      'If-None-Match': `"${etag}"`,
    })
    record(
      'live_etag_304',
      second.status === 304 && (!second.text || second.text.length === 0),
      `status=${second.status} len=${second.text?.length ?? 0}`,
    )
  } catch (e) {
    record('live_etag_304', false, String(e?.stack || e))
  }

  // Optional gentle rate-limit probe: only if LIVE_RATE_LIMIT=1 (avoid flapping shared staging)
  if (process.env.LIVE_RATE_LIMIT === '1') {
    const codes = []
    for (let i = 0; i < 30; i++) {
      try {
        const r = await liveGet(base, boardId)
        codes.push(r.status)
        if (r.status === 429) {
          const rlv = validateRateLimitedBody(r.body)
          record(
            'live_rate_limit_429',
            rlv.ok &&
              (r.headers.rateLimitPolicy === 'PUBLIC_SNAPSHOT_RATE_LIMIT_V1' ||
                r.body?.policyId === 'PUBLIC_SNAPSHOT_RATE_LIMIT_V1'),
            `after ${i + 1} reqs; retry-after=${r.headers.retryAfter}`,
          )
          break
        }
      } catch (e) {
        record('live_rate_limit_429', false, String(e))
        break
      }
    }
    if (!codes.includes(429)) {
      record(
        'live_rate_limit_429',
        false,
        `no 429 in 30 GETs codes=${codes.slice(-5).join(',')}`,
      )
    }
  } else {
    console.log(
      '[SKIP] live_rate_limit_429 — set LIVE_RATE_LIMIT=1 to burst-probe shared staging',
    )
  }
}

async function main() {
  const mode = resolveMode()
  printOwnerTarget({ mode })
  console.log(`contract=${CONTRACT_ID} mode=${mode} fixtureDir=${FIXTURE_DIR}`)

  if (mode === 'fixture' || mode === 'both') {
    runFixtureSuite()
  }
  if (mode === 'live' || mode === 'both') {
    await runLiveSuite()
  }

  const failed = results.filter((r) => !r.ok)
  console.log(
    JSON.stringify(
      {
        contract: CONTRACT_ID,
        mode,
        total: results.length,
        passed: results.length - failed.length,
        failed: failed.map((f) => f.id),
        residual_gaps:
          mode === 'fixture'
            ? 'LIVE HTTP not exercised; consumer publish still EXCLUDED'
            : 'consumer path mutation still EXCLUDED from this flow',
      },
      null,
      2,
    ),
  )

  process.exitCode = failed.length ? 1 : 0
}

main().catch((e) => {
  console.error(String(e?.stack || e))
  process.exitCode = 1
})
