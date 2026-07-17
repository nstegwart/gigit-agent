#!/usr/bin/env node
/**
 * Public snapshot materialize + ETag path (AC-PUBLIC-01/02/03).
 *
 * Modes:
 *   --self-test | --contract | (default when --self-test flag or no WEB live)
 *       Offline pure materialize / once-cache / ETag-304 / redaction / STALE_OR_MISSING.
 *       Uses real src/server/public-snapshot.ts via node --experimental-strip-types.
 *   --live
 *       Optional HTTP probe against WEB_BASE / STAGING_URL (not required for acceptance).
 *
 * Env (live only): WEB_BASE, BOARD_ID (default mfs-rebuild)
 * Exit 0 only when selected mode checks all pass. Never prints secrets.
 *
 * Acceptance:
 *   node qa/e2e/flows/public-snapshot.mjs --self-test
 */
import { createHash } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { spawnSync } from 'node:child_process'

import {
  etagMatches as fixtureEtagMatches,
  findForbiddenKeys,
  normalizeEtag,
  validatePublicSnapshotPayload,
  validateStaleOrMissingBody,
  SCHEMA_VERSION,
  SERIALIZER_VERSION,
} from '../../fixtures/public-consumer-sync/conformance-lib.mjs'
import { printOwnerTarget, resolveWebBase, resolveBoardId } from '../lib/env.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = join(__dirname, '../../..')
const PUBLIC_SNAPSHOT_TS = join(REPO_ROOT, 'src/server/public-snapshot.ts')

/** @typedef {{ id: string, ok: boolean, detail?: string }} Check */

/**
 * Re-exec under node --experimental-strip-types so we can import real TS materializer.
 * (This .mjs is plain ESM; strip-types is required for .ts imports.)
 */
function ensureStripTypes() {
  if (process.env.PUBLIC_SNAPSHOT_SELFTEST_CHILD === '1') return false
  const args = process.argv.slice(1) // script path + flags
  const r = spawnSync(
    process.execPath,
    ['--experimental-strip-types', ...args],
    {
      env: { ...process.env, PUBLIC_SNAPSHOT_SELFTEST_CHILD: '1' },
      stdio: 'inherit',
      cwd: REPO_ROOT,
    },
  )
  process.exit(r.status == null ? 1 : r.status)
  return true
}

function record(/** @type {Check[]} */ checks, id, ok, detail = '') {
  checks.push({ id, ok, detail })
  console.log(`[${ok ? 'PASS' : 'FAIL'}] ${id}${detail ? ` — ${detail}` : ''}`)
}

function buildFixtureAggregation() {
  const pin = {
    canonicalSnapshotId: 'snap-self-test-1',
    canonicalHash: 'canonhash_self_test_aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    boardRev: 42,
    lifecycleRev: 7,
    serializerVersion: SERIALIZER_VERSION,
  }
  return {
    boardId: 'board-self-test',
    pin,
    generatedAt: '2026-07-14T12:00:00.000Z',
    publishedAt: '2026-07-14T12:00:00.000Z',
    publicationIntervalMs: 60_000,
    nowMs: Date.parse('2026-07-14T12:00:10.000Z'),
    boardRollup: {
      trackedWorkDenominator: 3,
      productDenominator: 3,
      stageProdReady: 1,
      prodReadyWithEvidence: 1,
      unclassifiedCount: 0,
      rawTaskReadinessPercent: 33,
      boardReadinessPercent: 33,
      cappedBy: null,
    },
    completion: { complete: false, g5Pass: true },
    buckets: {
      DONE: 1,
      RECONCILIATION_PENDING: 0,
      ONGOING: 1,
      NEXT: 1,
      QUEUED: 0,
      BLOCKED: 0,
    },
    staleOverlays: { STALE_CLAIM: 0 },
    projects: [{ id: 'p1', name: 'Proj', status: 'ACTIVE' }],
    features: [{ id: 'f1', projectId: 'p1', name: 'Feat', phase: 'build' }],
    // tasks.length must equal primary bucket sum (counts_consistency contract).
    tasks: [
      { id: 't-done', title: 'Done task', bucket: 'DONE', readinessPercent: 100 },
      { id: 't-on', title: 'Ongoing task', bucket: 'ONGOING', readinessPercent: 40 },
      { id: 't-next', title: 'Next task', bucket: 'NEXT', readinessPercent: 10 },
    ],
    // Hostile residual identity — materializer must remask.
    runs: [
      {
        runId: 'run-1',
        status: 'RUNNING',
        taskId: 't-on',
        agentRole: 'implementer',
        accountRefMasked: 'acc_plaintextSECRET99',
        lastHeartbeatAt: '2026-07-14T11:59:00.000Z',
      },
    ],
    accounts: [
      {
        accountIdMasked: 'acc_rawIdentityLEAK12',
        status: 'ACTIVE',
        provider: 'grok',
        usable: true,
      },
    ],
    decisionCount: 2,
    g5: { g5Pass: true, domainPassCount: 9, domainRequiredCount: 9 },
    usableCapacity: 4,
    domainBlockers: [],
    forceStale: false,
  }
}

/**
 * Offline self-test: materialize once, cache replay, ETag/304, redaction, STALE_OR_MISSING.
 * @returns {Promise<{ ok: boolean, checks: Check[], passCount: number, failCount: number }>}
 */
export async function runPublicSnapshotSelfTest() {
  /** @type {Check[]} */
  const checks = []

  // Dynamic import of real materializer (strip-types child only).
  let mod
  try {
    mod = await import(pathToFileURL(PUBLIC_SNAPSHOT_TS).href)
  } catch (e) {
    record(
      checks,
      'import_public_snapshot_ts',
      false,
      e instanceof Error ? e.message : String(e),
    )
    return finalize(checks)
  }
  record(checks, 'import_public_snapshot_ts', true, PUBLIC_SNAPSHOT_TS)

  const {
    materializePublicSnapshot,
    getOrMaterializePublicSnapshot,
    createMemoryPublicSnapshotStore,
    etagMatches,
    handlePublicSnapshotGet,
    PUBLIC_SERIALIZER_VERSION,
    PUBLIC_SNAPSHOT_SCHEMA,
    pinIdentity,
  } = mod

  record(
    checks,
    'serializer_version',
    PUBLIC_SERIALIZER_VERSION === SERIALIZER_VERSION,
    String(PUBLIC_SERIALIZER_VERSION),
  )
  record(
    checks,
    'schema_version_const',
    PUBLIC_SNAPSHOT_SCHEMA === SCHEMA_VERSION,
    String(PUBLIC_SNAPSHOT_SCHEMA),
  )

  const input = buildFixtureAggregation()
  // Align fixture serializer with module constant.
  input.pin.serializerVersion = PUBLIC_SERIALIZER_VERSION

  // --- AC-PUBLIC-01: materialize once ---
  let snap
  try {
    snap = materializePublicSnapshot(input)
    record(
      checks,
      'materialize_once',
      typeof snap?.etag === 'string' && snap.etag.length === 64,
      `etag_len=${snap?.etag?.length}`,
    )
  } catch (e) {
    record(checks, 'materialize_once', false, e instanceof Error ? e.message : String(e))
    return finalize(checks)
  }

  record(
    checks,
    'payload_schema',
    snap.payload.schemaVersion === PUBLIC_SNAPSHOT_SCHEMA,
    snap.payload.schemaVersion,
  )
  record(
    checks,
    'payload_pin_identity',
    pinIdentity(snap.pin) === pinIdentity(input.pin),
    pinIdentity(snap.pin),
  )
  record(
    checks,
    'payload_decision_count_only',
    snap.payload.decisionCount === 2 &&
      !('comment' in snap.payload) &&
      !('decisions' in snap.payload),
    `decisionCount=${snap.payload.decisionCount}`,
  )

  // Cache: same pin+content → same object (no recompute)
  const store = createMemoryPublicSnapshotStore()
  const a = getOrMaterializePublicSnapshot({ boardId: input.boardId, store, input })
  const b = getOrMaterializePublicSnapshot({ boardId: input.boardId, store, input })
  record(checks, 'cache_same_object', a === b, a === b ? 'replayed_identity' : 'rematerialized')
  record(checks, 'cache_same_etag', a.etag === b.etag && a.etag === snap.etag)

  // Content change invalidates even with same pin
  const input2 = {
    ...input,
    decisionCount: 3,
  }
  const c = getOrMaterializePublicSnapshot({ boardId: input.boardId, store, input: input2 })
  record(
    checks,
    'content_fingerprint_invalidates',
    c !== a && c.etag !== a.etag,
    `etag_changed=${c.etag !== a.etag}`,
  )

  // --- AC-PUBLIC-02: ETag + 304 ---
  record(checks, 'etag_hex64', /^[a-f0-9]{64}$/i.test(a.etag), a.etag.slice(0, 16))
  record(checks, 'etag_matches_helper', etagMatches(`"${a.etag}"`, a.etag))
  record(checks, 'etag_matches_multi', etagMatches(`W/"${a.etag}", "other"`, a.etag))

  const res304 = await handlePublicSnapshotGet(
    new Request(`http://self-test/api/public-snapshot?boardId=${input.boardId}`, {
      headers: { 'if-none-match': `"${a.etag}"` },
    }),
    {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => input,
      resolveIp: () => '127.0.0.1',
    },
  )
  record(
    checks,
    'http_304_if_none_match',
    res304.kind === 'not_modified' && res304.status === 304 && res304.etag === a.etag,
    `kind=${res304.kind} status=${res304.status}`,
  )

  const res200 = await handlePublicSnapshotGet(
    new Request(`http://self-test/api/public-snapshot?boardId=${input.boardId}`),
    {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => input,
      resolveIp: () => '127.0.0.1',
    },
  )
  record(
    checks,
    'http_200_body',
    res200.kind === 'ok' && res200.status === 200 && typeof res200.body === 'string',
    `kind=${res200.kind} status=${res200.status}`,
  )
  if (res200.kind === 'ok') {
    let body
    try {
      body = JSON.parse(res200.body)
    } catch {
      body = null
    }
    const v = body ? validatePublicSnapshotPayload(body) : { ok: false, errors: ['parse'] }
    record(
      checks,
      'http_200_payload_contract',
      v.ok === true || (v.errors || []).length === 0,
      v.ok ? 'valid' : (v.errors || []).slice(0, 3).join(';'),
    )
    // Header etag matches body
    const hdrEtag = normalizeEtag(res200.headers?.etag || '')
    record(
      checks,
      'http_200_etag_header_matches_body',
      fixtureEtagMatches(hdrEtag, body?.etag) || hdrEtag === body?.etag,
      `hdr=${hdrEtag?.slice?.(0, 12)} body=${String(body?.etag || '').slice(0, 12)}`,
    )
  }

  // Missing aggregation → STALE_OR_MISSING fail-closed
  const resMiss = await handlePublicSnapshotGet(
    new Request('http://self-test/api/public-snapshot?boardId=missing-board'),
    {
      store: createMemoryPublicSnapshotStore(),
      loadAggregation: async () => null,
      resolveIp: () => '127.0.0.1',
    },
  )
  let missBody = null
  if (resMiss.kind === 'error') {
    try {
      missBody = JSON.parse(resMiss.body)
    } catch {
      missBody = null
    }
  }
  const staleVal = missBody ? validateStaleOrMissingBody(missBody) : { ok: false, errors: ['no body'] }
  record(
    checks,
    'http_503_stale_or_missing',
    resMiss.status === 503 &&
      missBody?.code === 'STALE_OR_MISSING' &&
      (staleVal.ok === true || missBody?.stale === true),
    `status=${resMiss.status} code=${missBody?.code}`,
  )
  record(
    checks,
    'stale_body_no_invented_snapshot',
    missBody != null &&
      missBody.schemaVersion == null &&
      missBody.pin == null &&
      missBody.etag == null &&
      missBody.boardRollup == null,
    'no pin/etag/boardRollup on 503',
  )

  // --- AC-PUBLIC-03: redaction ---
  const forbidden = findForbiddenKeys(snap.payload)
  record(
    checks,
    'redaction_no_forbidden_keys',
    forbidden.length === 0,
    forbidden.slice(0, 5).join(',') || 'clean',
  )
  const runMasked = snap.payload.runs?.[0]?.accountRefMasked
  const accMasked = snap.payload.accounts?.[0]?.accountIdMasked
  record(
    checks,
    'redaction_run_account_remask',
    typeof runMasked === 'string' &&
      /^acc_\*{3}[A-Za-z0-9]{4}$/.test(runMasked) &&
      !String(runMasked).includes('plaintext') &&
      !String(runMasked).includes('SECRET'),
    String(runMasked),
  )
  record(
    checks,
    'redaction_account_remask',
    typeof accMasked === 'string' &&
      /^acc_\*{3}[A-Za-z0-9]{4}$/.test(accMasked) &&
      !String(accMasked).includes('rawIdentity') &&
      !String(accMasked).includes('LEAK'),
    String(accMasked),
  )

  // Domain-blocker soft path still materializes (forceStale, usableCapacity=0)
  const softInput = {
    ...input,
    forceStale: true,
    usableCapacity: 9,
    domainBlockers: [{ code: 'DATA_INTEGRITY', count: 1, reason: 'section:classification' }],
  }
  const soft = materializePublicSnapshot(softInput)
  record(
    checks,
    'domain_blocker_soft_materialize',
    soft.payload.freshness.stale === true &&
      soft.payload.usableCapacity === 0 &&
      soft.payload.domainBlockers.some((b) => b.code === 'DATA_INTEGRITY'),
    `stale=${soft.payload.freshness.stale} cap=${soft.payload.usableCapacity}`,
  )

  // Deterministic etag for identical input
  const d1 = materializePublicSnapshot(input)
  const d2 = materializePublicSnapshot(input)
  record(checks, 'etag_deterministic', d1.etag === d2.etag && d1.bodyJson === d2.bodyJson)

  // Stable hash smoke (local pure)
  const h = createHash('sha256').update('public-snapshot-self-test').digest('hex')
  record(checks, 'sha256_available', h.length === 64)

  return finalize(checks)
}

function finalize(/** @type {Check[]} */ checks) {
  const passCount = checks.filter((c) => c.ok).length
  const failCount = checks.length - passCount
  return { ok: failCount === 0, checks, passCount, failCount }
}

async function runLiveProbe(base, boardId) {
  /** @type {Check[]} */
  const checks = []
  const url = `${base}/api/public-snapshot?boardId=${encodeURIComponent(boardId)}`
  let res
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (e) {
    record(checks, 'live_fetch', false, e instanceof Error ? e.message : String(e))
    return finalize(checks)
  }
  const text = await res.text()
  let body = null
  try {
    body = text ? JSON.parse(text) : null
  } catch {
    body = null
  }
  record(checks, 'live_http_status', res.status === 200 || res.status === 503, `status=${res.status}`)
  if (res.status === 200 && body) {
    const v = validatePublicSnapshotPayload(body)
    record(
      checks,
      'live_payload_contract',
      v.ok === true || (v.errors || []).length === 0,
      v.ok ? 'valid' : (v.errors || []).slice(0, 3).join(';'),
    )
    const etag = body.etag
    if (etag) {
      const r2 = await fetch(url, {
        headers: { accept: 'application/json', 'if-none-match': `"${etag}"` },
      })
      record(checks, 'live_304', r2.status === 304, `status=${r2.status}`)
    }
  } else if (res.status === 503 && body) {
    record(
      checks,
      'live_stale_or_missing_shape',
      body.code === 'STALE_OR_MISSING',
      `code=${body.code}`,
    )
  }
  return finalize(checks)
}

function parseMode(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  if (flags.has('--live')) return 'live'
  if (flags.has('--self-test') || flags.has('--contract') || flags.has('--help')) {
    if (flags.has('--help')) return 'help'
    return 'self-test'
  }
  // Default: self-test (acceptance-safe offline). Live is opt-in.
  return 'self-test'
}

async function main() {
  const mode = parseMode(process.argv.slice(2))
  if (mode === 'help') {
    console.log(`Usage:
  node qa/e2e/flows/public-snapshot.mjs --self-test   # default; offline materialize+ETag
  node qa/e2e/flows/public-snapshot.mjs --live        # HTTP probe WEB_BASE/STAGING_URL
`)
    process.exit(0)
  }

  // Parent re-exec with strip-types for TS import.
  if (ensureStripTypes()) return

  if (mode === 'live') {
    const base = (process.env.STAGING_URL || process.env.WEB_BASE || '').trim().replace(/\/$/, '') ||
      resolveWebBase()
    const boardId = resolveBoardId('mfs-rebuild')
    printOwnerTarget({
      flow: 'public-snapshot',
      mode: 'live',
      base_url: base,
      boardId,
      account: 'unauth-public',
      device: 'curl-fetch',
    })
    const result = await runLiveProbe(base, boardId)
    console.log(
      JSON.stringify(
        {
          mode: 'live',
          ok: result.ok,
          passCount: result.passCount,
          failCount: result.failCount,
          failed: result.checks.filter((c) => !c.ok).map((c) => c.id),
        },
        null,
        2,
      ),
    )
    process.exitCode = result.ok ? 0 : 1
    return
  }

  // self-test
  printOwnerTarget({
    flow: 'public-snapshot',
    mode: 'self-test',
    base_url: 'mock://self-test',
    port: null,
    account: 'SYNTH_SELF_TEST',
    device: 'n/a-public-snapshot',
    boardId: 'board-self-test',
  })

  const result = await runPublicSnapshotSelfTest()
  console.log(
    JSON.stringify(
      {
        mode: 'self-test',
        ok: result.ok,
        passCount: result.passCount,
        failCount: result.failCount,
        failed: result.checks.filter((c) => !c.ok).map((c) => c.id),
        ac: ['AC-PUBLIC-01', 'AC-PUBLIC-02', 'AC-PUBLIC-03'],
      },
      null,
      2,
    ),
  )
  process.exitCode = result.ok ? 0 : 1
}

main().catch((e) => {
  console.error(String(e?.stack || e))
  process.exitCode = 1
})
