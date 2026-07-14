/**
 * MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1 — pure validators (no network).
 * Used by qa/e2e/flows/public-consumer-conformance.mjs and unit tests.
 */

export const CONTRACT_ID = 'MFS_PUBLIC_CONSUMER_SYNC_CONTRACT_V1'
export const OPENAPI_VERSION = 'MFS_PUBLIC_CONSUMER_SYNC_V1'
export const SCHEMA_VERSION = 'MFS_PUBLIC_SNAPSHOT_V1'
export const SERIALIZER_VERSION = 'PUBLIC_SNAPSHOT_V1'
export const RATE_LIMIT_POLICY = 'PUBLIC_SNAPSHOT_RATE_LIMIT_V1'
export const PUBLISH_SCHEMA = 'MFS_PUBLIC_CONSUMER_PUBLISH_V1'
export const CANONICAL_MASK_RE = /^acc_\*{3}[A-Za-z0-9]{4}$/
export const HEX64_RE = /^[a-f0-9]{64}$/i

/** Forbidden JSON keys at any depth (contract redaction allowlist inverse). */
export const FORBIDDEN_KEY_RE =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|rawIdentity|raw_identity|privateKey|clientSecret|bearer|x-cairn-token|credentials|tokens|secrets)$/i

const FORBIDDEN_NESTED = new Set([
  'comments',
  'comment',
  'ownercomments',
  'evidences',
  'evidence',
  'evidencebody',
  'privatedecision',
  'decisiontitle',
  'decisiontext',
  'env',
  'environment',
  'processenv',
  'rawidentity',
  'unmaskedidentity',
  'email',
  'phone',
])

/** Mock / placeholder markers that must not appear on live pin publish assets. */
export const MOCK_MARKERS = [
  'MOCK_LABEL',
  'MOCK —',
  'MOCK -',
  'status_cap',
  'LOCAL ONLY',
  'NOT SHIPPABLE',
  'preview desain',
]

export function normalizeEtag(value) {
  if (value == null) return ''
  const s = String(value).trim()
  if (s.startsWith('W/')) return normalizeEtag(s.slice(2))
  if (
    (s.startsWith('"') && s.endsWith('"')) ||
    (s.startsWith("'") && s.endsWith("'"))
  ) {
    return s.slice(1, -1)
  }
  return s
}

export function etagMatches(a, b) {
  return normalizeEtag(a) !== '' && normalizeEtag(a) === normalizeEtag(b)
}

export function isForbiddenKey(key) {
  if (FORBIDDEN_KEY_RE.test(key)) return true
  const normalized = String(key).replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (FORBIDDEN_NESTED.has(normalized)) return true
  if (/comment/i.test(key) && !/^decisionCount$/i.test(key)) return true
  if (/evidence/i.test(key) && !/prodReadyWithEvidence/i.test(key)) return true
  if (/secret|password|token|credential/i.test(key)) return true
  return false
}

/**
 * Walk object graph; return list of forbidden paths found.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function findForbiddenKeys(value, path = '') {
  const hits = []
  if (value == null || typeof value !== 'object') return hits
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findForbiddenKeys(v, `${path}[${i}]`)))
    return hits
  }
  for (const [k, v] of Object.entries(value)) {
    const child = path ? `${path}.${k}` : k
    if (isForbiddenKey(k)) hits.push(child)
    else hits.push(...findForbiddenKeys(v, child))
  }
  return hits
}

/**
 * Detect email-like or bearer-like secret substrings in string leaves.
 * Conservative: only clear patterns.
 * @param {unknown} value
 * @param {string} [path]
 * @returns {string[]}
 */
export function findSecretLikeStrings(value, path = '') {
  const hits = []
  if (typeof value === 'string') {
    if (/\bBearer\s+[A-Za-z0-9._\-+/=]{8,}\b/i.test(value)) {
      hits.push(`${path || '<root>'}:bearer-like`)
    }
    // emails only fail when not obviously synthetic demo domains used in docs
    if (/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/.test(value)) {
      hits.push(`${path || '<root>'}:email-like`)
    }
    return hits
  }
  if (value == null || typeof value !== 'object') return hits
  if (Array.isArray(value)) {
    value.forEach((v, i) => hits.push(...findSecretLikeStrings(v, `${path}[${i}]`)))
    return hits
  }
  for (const [k, v] of Object.entries(value)) {
    const child = path ? `${path}.${k}` : k
    hits.push(...findSecretLikeStrings(v, child))
  }
  return hits
}

/**
 * @param {unknown} pin
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validatePin(pin) {
  const errors = []
  if (!pin || typeof pin !== 'object' || Array.isArray(pin)) {
    return { ok: false, errors: ['pin missing or not object'] }
  }
  const p = /** @type {Record<string, unknown>} */ (pin)
  if (typeof p.canonicalSnapshotId !== 'string' || !p.canonicalSnapshotId.trim()) {
    errors.push('pin.canonicalSnapshotId missing/empty')
  }
  if (typeof p.canonicalHash !== 'string' || !p.canonicalHash.trim()) {
    errors.push('pin.canonicalHash missing/empty')
  }
  if (typeof p.boardRev !== 'number' || !Number.isInteger(p.boardRev)) {
    errors.push('pin.boardRev not integer')
  }
  if (typeof p.lifecycleRev !== 'number' || !Number.isInteger(p.lifecycleRev)) {
    errors.push('pin.lifecycleRev not integer')
  }
  if (p.serializerVersion !== SERIALIZER_VERSION) {
    errors.push(`pin.serializerVersion must be ${SERIALIZER_VERSION}`)
  }
  return { ok: errors.length === 0, errors }
}

/**
 * @param {unknown} payload
 * @param {{ boardId?: string }} [opts]
 * @returns {{ ok: boolean, errors: string[], checks: Record<string, boolean> }}
 */
export function validatePublicSnapshotPayload(payload, opts = {}) {
  const errors = []
  /** @type {Record<string, boolean>} */
  const checks = {
    schema_and_pin: false,
    freshness_shape: false,
    counts_consistency: false,
    redaction: false,
    etag_internal: false,
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return {
      ok: false,
      errors: ['payload not object'],
      checks,
    }
  }
  const body = /** @type {Record<string, unknown>} */ (payload)

  if (body.schemaVersion !== SCHEMA_VERSION) {
    errors.push(`schemaVersion must be ${SCHEMA_VERSION}`)
  }
  if (typeof body.boardId !== 'string' || !body.boardId) {
    errors.push('boardId missing')
  } else if (opts.boardId && body.boardId !== opts.boardId) {
    errors.push(`boardId mismatch: got ${body.boardId} expected ${opts.boardId}`)
  }

  const pinResult = validatePin(body.pin)
  if (!pinResult.ok) errors.push(...pinResult.errors)
  checks.schema_and_pin =
    body.schemaVersion === SCHEMA_VERSION &&
    typeof body.boardId === 'string' &&
    !!body.boardId &&
    pinResult.ok

  const fr = body.freshness
  if (!fr || typeof fr !== 'object') {
    errors.push('freshness missing')
  } else {
    const f = /** @type {Record<string, unknown>} */ (fr)
    for (const k of [
      'generatedAt',
      'publishedAt',
      'publicationIntervalMs',
      'stale',
      'ageMs',
    ]) {
      if (!(k in f)) errors.push(`freshness.${k} missing`)
    }
    if (typeof f.stale !== 'boolean') errors.push('freshness.stale not boolean')
    if (typeof f.publicationIntervalMs !== 'number' || f.publicationIntervalMs <= 0) {
      errors.push('freshness.publicationIntervalMs invalid')
    }
    if (typeof f.ageMs !== 'number' || f.ageMs < 0) {
      errors.push('freshness.ageMs invalid')
    }
  }
  checks.freshness_shape = !errors.some((e) => e.startsWith('freshness'))

  const buckets = body.buckets
  if (!buckets || typeof buckets !== 'object') {
    errors.push('buckets missing')
  } else {
    const b = /** @type {Record<string, unknown>} */ (buckets)
    for (const k of [
      'DONE',
      'RECONCILIATION_PENDING',
      'ONGOING',
      'NEXT',
      'QUEUED',
      'BLOCKED',
    ]) {
      if (typeof b[k] !== 'number' || !Number.isInteger(b[k]) || b[k] < 0) {
        errors.push(`buckets.${k} invalid`)
      }
    }
  }

  if (typeof body.usableCapacity !== 'number' || !Number.isInteger(body.usableCapacity) || body.usableCapacity < 0) {
    errors.push('usableCapacity invalid')
  }
  if (typeof body.decisionCount !== 'number' || !Number.isInteger(body.decisionCount) || body.decisionCount < 0) {
    errors.push('decisionCount invalid')
  }

  const tasks = Array.isArray(body.tasks) ? body.tasks : null
  const runs = Array.isArray(body.runs) ? body.runs : null
  const accounts = Array.isArray(body.accounts) ? body.accounts : null
  if (!tasks) errors.push('tasks not array')
  if (!runs) errors.push('runs not array')
  if (!accounts) errors.push('accounts not array')

  if (tasks && buckets && typeof buckets === 'object') {
    const b = /** @type {Record<string, number>} */ (buckets)
    const sum =
      (b.DONE ?? 0) +
      (b.RECONCILIATION_PENDING ?? 0) +
      (b.ONGOING ?? 0) +
      (b.NEXT ?? 0) +
      (b.QUEUED ?? 0) +
      (b.BLOCKED ?? 0)
    if (tasks.length !== sum) {
      errors.push(
        `counts_consistency: tasks.length=${tasks.length} != bucketSum=${sum}`,
      )
    }
  }

  if (accounts) {
    for (let i = 0; i < accounts.length; i++) {
      const a = /** @type {Record<string, unknown>} */ (accounts[i] || {})
      if (typeof a.accountIdMasked !== 'string' || !CANONICAL_MASK_RE.test(a.accountIdMasked)) {
        errors.push(`accounts[${i}].accountIdMasked not canonical mask`)
      }
    }
  }
  if (runs) {
    for (let i = 0; i < runs.length; i++) {
      const r = /** @type {Record<string, unknown>} */ (runs[i] || {})
      if (r.accountRefMasked != null && r.accountRefMasked !== '') {
        if (
          typeof r.accountRefMasked !== 'string' ||
          !CANONICAL_MASK_RE.test(r.accountRefMasked)
        ) {
          errors.push(`runs[${i}].accountRefMasked not canonical mask`)
        }
      }
    }
  }

  checks.counts_consistency = !errors.some((e) => e.startsWith('counts_consistency') || e.includes('usableCapacity') || e.includes('buckets.'))

  const forbidden = findForbiddenKeys(body)
  if (forbidden.length) {
    errors.push(`redaction forbidden keys: ${forbidden.join(', ')}`)
  }
  const secretLike = findSecretLikeStrings(body)
  if (secretLike.length) {
    errors.push(`redaction secret-like strings: ${secretLike.join(', ')}`)
  }
  checks.redaction = forbidden.length === 0 && secretLike.length === 0

  const etag = typeof body.etag === 'string' ? body.etag : ''
  const sha = typeof body.payloadSha256 === 'string' ? body.payloadSha256 : ''
  if (!HEX64_RE.test(etag)) errors.push('etag not 64-hex')
  if (!HEX64_RE.test(sha)) errors.push('payloadSha256 not 64-hex')
  if (etag && sha && normalizeEtag(etag).toLowerCase() !== sha.toLowerCase()) {
    errors.push('etag !== payloadSha256')
  }
  checks.etag_internal =
    HEX64_RE.test(etag) &&
    HEX64_RE.test(sha) &&
    normalizeEtag(etag).toLowerCase() === sha.toLowerCase()

  return { ok: errors.length === 0, errors, checks }
}

/**
 * @param {unknown} body
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateRateLimitedBody(body) {
  const errors = []
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['429 body not object'] }
  }
  const b = /** @type {Record<string, unknown>} */ (body)
  if (b.code !== 'RATE_LIMITED') errors.push('code must be RATE_LIMITED')
  if (b.policyId !== RATE_LIMIT_POLICY) {
    errors.push(`policyId must be ${RATE_LIMIT_POLICY}`)
  }
  if (typeof b.error !== 'string' || !b.error) errors.push('error missing')
  if (typeof b.retryAfterSeconds !== 'number' || b.retryAfterSeconds < 0) {
    errors.push('retryAfterSeconds invalid')
  }
  return { ok: errors.length === 0, errors }
}

/**
 * @param {unknown} body
 * @returns {{ ok: boolean, errors: string[] }}
 */
export function validateStaleOrMissingBody(body) {
  const errors = []
  if (!body || typeof body !== 'object') {
    return { ok: false, errors: ['503 body not object'] }
  }
  const b = /** @type {Record<string, unknown>} */ (body)
  if (b.code !== 'STALE_OR_MISSING') errors.push('code must be STALE_OR_MISSING')
  if (b.stale !== true) errors.push('stale must be true')
  if (typeof b.error !== 'string' || !b.error) errors.push('error missing')
  return { ok: errors.length === 0, errors }
}

/**
 * Scan stringified publish asset / receipt for mock markers that block live publish.
 * @param {unknown} value
 * @returns {string[]}
 */
export function findMockMarkers(value) {
  const text = typeof value === 'string' ? value : JSON.stringify(value)
  const hits = []
  for (const m of MOCK_MARKERS) {
    if (text.includes(m)) hits.push(m)
  }
  return hits
}

/**
 * Atomic publish receipt gate.
 * @param {unknown} receipt
 * @returns {{ ok: boolean, errors: string[], mockHits: string[] }}
 */
export function validateAtomicPublishReceipt(receipt) {
  const errors = []
  if (!receipt || typeof receipt !== 'object') {
    return { ok: false, errors: ['receipt not object'], mockHits: [] }
  }
  const r = /** @type {Record<string, unknown>} */ (receipt)
  if (r.publish_schema !== PUBLISH_SCHEMA) {
    errors.push(`publish_schema must be ${PUBLISH_SCHEMA}`)
  }
  const source = /** @type {Record<string, unknown>} */ (r.source || {})
  if (source.api !== 'GET /api/public-snapshot') {
    errors.push('source.api must be GET /api/public-snapshot')
  }
  const pinResult = validatePin(source.pin)
  if (!pinResult.ok) errors.push(...pinResult.errors.map((e) => `source.${e}`))
  if (!source.etag) errors.push('source.etag missing')

  const publish = /** @type {Record<string, unknown>} */ (r.publish || {})
  if (publish.mode !== 'atomic_rename') {
    errors.push('publish.mode must be atomic_rename')
  }
  if (publish.noMockLabels !== true) {
    errors.push('publish.noMockLabels must be true')
  }

  const mockHits = findMockMarkers(receipt)
  // status_cap / LOCAL ONLY on a receipt that claims live publish is a fail
  if (mockHits.length) {
    errors.push(`mock markers present: ${mockHits.join(', ')}`)
  }

  return { ok: errors.length === 0, errors, mockHits }
}

/**
 * Simulate 304 decision used by sync worker.
 * @param {string} currentEtag
 * @param {string | null | undefined} ifNoneMatch
 */
export function shouldReturn304(currentEtag, ifNoneMatch) {
  if (!ifNoneMatch) return false
  return etagMatches(currentEtag, ifNoneMatch)
}
