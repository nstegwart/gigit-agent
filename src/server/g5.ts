// Pure G5 domain evaluation (C1). g5Pass is server-derived / read-only.
// Never accept caller-written g5Pass.

import type {
  G5DomainId,
  G5DomainRecord,
  G5Evaluation,
  PinnedRevisionTuple,
} from '#/lib/control-plane-types'
import { G5_REQUIRED_DOMAINS } from '#/lib/control-plane-types'

export { G5_REQUIRED_DOMAINS, G5_DOMAIN_LABELS } from '#/lib/control-plane-types'

function domainPass(
  record: G5DomainRecord,
  pin: PinnedRevisionTuple,
): { pass: boolean; reason: string | null } {
  if (!record.required) {
    // Non-required domains do not block g5Pass, but required set is exactly nine.
    return { pass: true, reason: null }
  }
  if (record.status !== 'PASS') {
    return { pass: false, reason: `status=${record.status}` }
  }
  if (!record.programmaticEvidence) {
    return { pass: false, reason: 'non_programmatic_evidence' }
  }
  if (!record.independentVerifier) {
    return { pass: false, reason: 'missing_independent_verifier' }
  }
  if (record.verifierRunId && record.authorRunId && record.verifierRunId === record.authorRunId) {
    return { pass: false, reason: 'self_verification' }
  }
  if (
    !record.evidenceReceiptIds.length ||
    !record.evidenceReceiptHashes.length ||
    record.evidenceReceiptIds.length !== record.evidenceReceiptHashes.length
  ) {
    return { pass: false, reason: 'missing_evidence_receipts' }
  }
  // Current subject revision/hash + board/lifecycle pin (AC-LIFE-05).
  if (record.boardRev !== pin.boardRev) {
    return { pass: false, reason: 'stale_board_rev' }
  }
  if (record.subjectLifecycleRev !== pin.lifecycleRev) {
    return { pass: false, reason: 'stale_lifecycle_rev' }
  }
  if (record.subjectHash !== pin.canonicalHash && record.subjectHash !== pin.taskHash) {
    // Subject hash must bind to either current canonical or task hash.
    return { pass: false, reason: 'stale_subject_hash' }
  }
  if (record.subjectRevision !== pin.boardRev && record.expectedRev !== pin.boardRev) {
    // expectedRev / subjectRevision must align with current board pin when provided.
    // Accept either field matching boardRev for fail-closed currency.
    if (record.expectedRev !== pin.boardRev) {
      return { pass: false, reason: 'stale_subject_revision' }
    }
  }
  return { pass: true, reason: null }
}

/**
 * Derive g5Pass (AC-LIFE-05). True only when all nine required domains are
 * current-revision, current-hash, programmatically evidenced PASS with
 * independent verifier. Any missing/stale/unverified/non-PASS → false.
 * Caller-written g5Pass is never consulted.
 */
export function evaluateG5(
  domains: ReadonlyArray<G5DomainRecord>,
  pin: PinnedRevisionTuple,
): G5Evaluation {
  const byId = new Map<G5DomainId, G5DomainRecord>()
  for (const d of domains) {
    // Last write wins for duplicates — still fail if required missing.
    byId.set(d.domainId, d)
  }

  const missingDomains: Array<G5DomainId> = []
  const domainResults: G5Evaluation['domainResults'] = []

  for (const id of G5_REQUIRED_DOMAINS) {
    const rec = byId.get(id)
    if (!rec) {
      missingDomains.push(id)
      domainResults.push({ domainId: id, pass: false, reason: 'missing_domain' })
      continue
    }
    // Required domains in the nine-set are always treated as required.
    const normalized: G5DomainRecord = { ...rec, required: true }
    const r = domainPass(normalized, pin)
    domainResults.push({ domainId: id, pass: r.pass, reason: r.reason })
  }

  const g5Pass =
    missingDomains.length === 0 && domainResults.every((r) => r.pass)

  return { g5Pass, domainResults, missingDomains }
}

/** Read-only g5Pass accessor — ignores any external g5Pass write. */
export function deriveG5Pass(
  domains: ReadonlyArray<G5DomainRecord>,
  pin: PinnedRevisionTuple,
): boolean {
  return evaluateG5(domains, pin).g5Pass
}

/** Build a PASS domain fixture helper for tests/synthetic — not a write path. */
export function makePassingDomain(
  domainId: G5DomainId,
  pin: PinnedRevisionTuple,
  overrides: Partial<G5DomainRecord> = {},
): G5DomainRecord {
  return {
    domainId,
    scope: 'board',
    required: true,
    status: 'PASS',
    evidenceReceiptIds: [`ev-${domainId}`],
    evidenceReceiptHashes: [`hash-${domainId}-aaaaaaaaaaaaaaaa`],
    verifierAgent: 'verifier-agent',
    verifierModel: 'verifier-model',
    verifierRunId: `run-v-${domainId}`,
    authorRunId: `run-a-${domainId}`,
    subjectRevision: pin.boardRev,
    subjectHash: pin.canonicalHash,
    findings: null,
    blocker: null,
    capturedAt: '2026-07-13T00:00:00.000Z',
    expectedRev: pin.boardRev,
    boardRev: pin.boardRev,
    subjectLifecycleRev: pin.lifecycleRev,
    programmaticEvidence: true,
    independentVerifier: true,
    ...overrides,
  }
}
