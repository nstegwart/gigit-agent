/**
 * Pinned public snapshot materialization (AC-PUBLIC-01..03).
 * Materialize once from one pinned aggregation tuple/payload — no recomputation.
 * Stable deterministic serializer version + ETag SHA-256; If-None-Match → 304.
 * Allowlist-only V3 public fields; recursive secret/private exclusion.
 * Fail-closed: errors never fall through sensitive authenticated data to public.
 */

import { createHash } from 'node:crypto'

export const PUBLIC_SERIALIZER_VERSION = 'PUBLIC_SNAPSHOT_V1' as const
export const PUBLIC_SNAPSHOT_SCHEMA = 'MFS_PUBLIC_SNAPSHOT_V1' as const

/** Fields forbidden at any depth in public materialization. */
const FORBIDDEN_KEY_RE =
  /^(password|passwd|token|secret|authorization|cookie|api[_-]?key|private[_-]?key|access[_-]?token|refresh[_-]?token|session[_-]?id|rawIdentity|raw_identity|privateKey|clientSecret|bearer|x-cairn-token)$/i

/** Normalized (lowercase alphanumeric) forbidden key segments. */
const FORBIDDEN_NESTED_SEGMENTS = new Set([
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
  'credentials',
  'tokens',
  'secrets',
  'clientsecret',
  'sessionid',
])

export interface PublicSnapshotPin {
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  serializerVersion: typeof PUBLIC_SERIALIZER_VERSION
}

export interface PublicBucketCounts {
  DONE: number
  RECONCILIATION_PENDING: number
  ONGOING: number
  NEXT: number
  QUEUED: number
  BLOCKED: number
}

export interface PublicStaleOverlayCounts {
  STALE_DATA_SOURCE?: number
  EXPIRED_STALLED_RUN?: number
  STALE_CLAIM?: number
  STALE_DISPATCH_PLAN?: number
  STALE_ACCOUNT_SYNC?: number
  BEYOND_STAGE_ONGOING?: number
  RECONCILIATION_DRILLDOWN?: number
  [k: string]: number | undefined
}

export interface PublicPriorityRollup {
  portfolioId: string
  membershipDenominator: number
  priorityClosureCapacity: number
  allClosureCapacity: number
  priorityCapacityShare: number | null
  majorityAllocationPass: boolean | null
  frontierState: string
  reason: string | null
}

export interface PublicProjectSummary {
  id: string
  name?: string | null
  status?: string | null
}

/** Linked task progress for a public feature (sanitized; never invents nodes). */
export interface PublicFeatureProgressNode {
  taskId: string
  /** Owner-facing primary title (reviewed or CONTENT_REVIEW shell). */
  title: string
  lifecycleStage?: string | null
  status?: string | null
  /** Source/technical title when owner primary is content-review shell. */
  technicalTitle?: string | null
  /** True when humanDisplay is missing/stale/unreviewed. */
  contentReviewRequired?: boolean
}

export interface PublicFeatureSummary {
  id: string
  projectId?: string | null
  name?: string | null
  phase?: string | null
  /** Linked task count when proven (0 when none). */
  taskCount?: number | null
  /** Lifecycle stage histogram among linked tasks. */
  stageCounts?: Record<string, number> | null
  /** Real progress nodes from featureContractId join — empty array when none. */
  progressNodes?: PublicFeatureProgressNode[] | null
}

export interface PublicTaskSummary {
  id: string
  projectId?: string | null
  title?: string | null
  bucket?: string | null
  readinessPercent?: number | null
  /**
   * Lifecycle stage string when proven (e.g. MAPPED, MAP_VERIFIED).
   * Null when unknown — never invents stage. Owner progress surface.
   */
  lifecycleStage?: string | null
}

/** Sanitized run summary — no tokens, no raw account identity. */
export interface PublicRunSummary {
  runId: string
  status: string
  taskId?: string | null
  agentRole?: string | null
  /** Masked account ref only (e.g. acc_***ab12). */
  accountRefMasked?: string | null
  lastHeartbeatAt?: string | null
}

/** Masked account summary — never tokens. */
export interface PublicAccountSummary {
  accountIdMasked: string
  status: string
  provider?: string | null
  usable?: boolean
}

export interface PublicG5Summary {
  g5Pass: boolean
  domainPassCount: number
  domainRequiredCount: number
}

/**
 * Allowlisted business/domain blocker codes that may appear on a sanitized
 * public snapshot (pin-complete aggregation with domain issues).
 * Structural pin/schema/hash/load failures are NOT domain blockers — they 503.
 */
export const PUBLIC_DOMAIN_BLOCKER_CODES = [
  'DATA_INTEGRITY',
  'UNCLASSIFIED',
  'UNCLASSIFIED_TASK_CLASS',
  'UNCLASSIFIED_DISPOSITION',
  'ACCOUNT_SYNC_MISSING',
  'ACCOUNT_SYNC_STALE',
  'ACCOUNT_SYNC_PARITY_INVALID',
] as const

export type PublicDomainBlockerCode = (typeof PUBLIC_DOMAIN_BLOCKER_CODES)[number]

export const PUBLIC_DOMAIN_BLOCKER_CODE_SET: ReadonlySet<string> = new Set(
  PUBLIC_DOMAIN_BLOCKER_CODES,
)

export function isPublicDomainBlockerCode(code: string | null | undefined): boolean {
  if (code == null || code === '') return false
  return PUBLIC_DOMAIN_BLOCKER_CODE_SET.has(String(code).trim())
}

/** Explicit allowlisted domain blocker count/reason (no private identity). */
export interface PublicDomainBlocker {
  code: PublicDomainBlockerCode | string
  count: number
  /** Short public reason token/phrase — never secrets, comments, evidence bodies. */
  reason?: string | null
}

export interface PublicFreshness {
  generatedAt: string
  publishedAt: string
  /** Publication interval used for stale detection (ms). */
  publicationIntervalMs: number
  /** True when age > 2 * publicationIntervalMs (alert threshold) OR forceStale. */
  stale: boolean
  ageMs: number
}

/**
 * Allowlisted aggregation input — caller supplies already-aggregated public-safe
 * numbers/summaries. This module NEVER recomputes rollup from private board state.
 */
export interface PublicAggregationInput {
  boardId: string
  pin: PublicSnapshotPin
  generatedAt: string
  publishedAt?: string
  publicationIntervalMs?: number
  nowMs?: number
  boardRollup: {
    trackedWorkDenominator: number
    productDenominator: number
    stageProdReady: number
    prodReadyWithEvidence: number
    unclassifiedCount: number
    rawTaskReadinessPercent: number | null
    boardReadinessPercent: number | null
    cappedBy: string | null
    /**
     * Distinct task lifecycle stage histogram (MAPPED / MAP_VERIFIED / …).
     * Empty object when no proven stages — never invents MAP_VERIFIED.
     */
    lifecycleStageCounts?: Readonly<Record<string, number>>
  }
  completion: {
    complete: boolean
    g5Pass: boolean
  }
  buckets: PublicBucketCounts
  staleOverlays?: PublicStaleOverlayCounts
  priorityRollup?: PublicPriorityRollup | null
  projects?: ReadonlyArray<PublicProjectSummary>
  features?: ReadonlyArray<PublicFeatureSummary>
  tasks?: ReadonlyArray<PublicTaskSummary>
  runs?: ReadonlyArray<PublicRunSummary>
  accounts?: ReadonlyArray<PublicAccountSummary>
  /** Public decision COUNT only — never titles/text. */
  decisionCount: number
  g5: PublicG5Summary
  /**
   * Usable dispatch capacity. Domain blockers / missing account-sync force 0.
   * Default 0 when omitted (fail-closed public surface).
   */
  usableCapacity?: number
  /** Allowlisted business blockers (DATA_INTEGRITY / UNCLASSIFIED / ACCOUNT_SYNC_*). */
  domainBlockers?: ReadonlyArray<PublicDomainBlocker>
  /**
   * When true, force freshness.stale=true even if age is within the publication
   * interval (domain-blocker sanitized truth path).
   */
  forceStale?: boolean
}

export interface PublicSnapshotPayload {
  schemaVersion: typeof PUBLIC_SNAPSHOT_SCHEMA
  boardId: string
  pin: PublicSnapshotPin
  boardRollup: PublicAggregationInput['boardRollup']
  completion: PublicAggregationInput['completion']
  buckets: PublicBucketCounts
  staleOverlays: PublicStaleOverlayCounts
  priorityRollup: PublicPriorityRollup | null
  projects: Array<PublicProjectSummary>
  features: Array<PublicFeatureSummary>
  tasks: Array<PublicTaskSummary>
  runs: Array<PublicRunSummary>
  accounts: Array<PublicAccountSummary>
  decisionCount: number
  g5: PublicG5Summary
  /** Fail-closed usable capacity for public consumers (domain blockers → 0). */
  usableCapacity: number
  /** Explicit allowlisted domain blocker counts/reasons (never private fields). */
  domainBlockers: Array<PublicDomainBlocker>
  freshness: PublicFreshness
  etag: string
  payloadSha256: string
}

export interface MaterializedPublicSnapshot {
  /** Frozen once at materialization; identity of the pin+payload. */
  etag: string
  payload: PublicSnapshotPayload
  bodyJson: string
  pin: PublicSnapshotPin
  materializedAt: string
  /**
   * Content fingerprint of public fields (decisions/lifecycle/G5/counts/etc.).
   * Cache invalidation key — pin identity alone is insufficient when boardHash
   * is stable but decisions/G5/lifecycle counts change.
   */
  contentFingerprint: string
}

export type PublicSnapshotErrorCode =
  | 'INVALID_PIN'
  | 'FORBIDDEN_FIELD'
  | 'MATERIALIZATION_FAILED'
  | 'STALE_OR_MISSING'
  | 'AUTH_DATA_LEAK_BLOCKED'

export class PublicSnapshotError extends Error {
  readonly code: PublicSnapshotErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: PublicSnapshotErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'PublicSnapshotError'
    this.code = code
    this.details = details
  }
}

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map((v) => stableStringify(v)).join(',')}]`
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

export function sha256Hex(input: string): string {
  return createHash('sha256').update(input).digest('hex')
}

function assertPin(pin: PublicSnapshotPin): void {
  if (
    !pin ||
    typeof pin.canonicalSnapshotId !== 'string' ||
    !pin.canonicalSnapshotId ||
    typeof pin.canonicalHash !== 'string' ||
    !pin.canonicalHash ||
    typeof pin.boardRev !== 'number' ||
    !Number.isInteger(pin.boardRev) ||
    typeof pin.lifecycleRev !== 'number' ||
    !Number.isInteger(pin.lifecycleRev) ||
    pin.serializerVersion !== PUBLIC_SERIALIZER_VERSION
  ) {
    throw new PublicSnapshotError('INVALID_PIN', 'public snapshot pin incomplete or wrong serializer', {
      pin,
    })
  }
}

function isForbiddenKey(key: string): boolean {
  if (FORBIDDEN_KEY_RE.test(key)) return true
  const normalized = key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
  if (FORBIDDEN_NESTED_SEGMENTS.has(normalized)) return true
  // Common private decision/comment/evidence patterns
  if (/comment/i.test(key) && !/^decisionCount$/i.test(key)) return true
  if (/evidence/i.test(key) && !/prodReadyWithEvidence/i.test(key)) return true
  if (/secret|password|token|credential/i.test(key)) return true
  return false
}

/**
 * Recursive allowlist walk: drop/forbid secret and private keys.
 * Throws on forbidden keys when mode = 'strict' (materialization path).
 */
export function sanitizePublicValue(
  value: unknown,
  opts?: { mode?: 'strict' | 'redact'; path?: string },
): unknown {
  const mode = opts?.mode ?? 'strict'
  const path = opts?.path ?? ''
  if (value === null || typeof value !== 'object') return value
  if (Array.isArray(value)) {
    return value.map((v, i) => sanitizePublicValue(v, { mode, path: `${path}[${i}]` }))
  }
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    const childPath = path ? `${path}.${k}` : k
    if (isForbiddenKey(k)) {
      if (mode === 'strict') {
        throw new PublicSnapshotError('FORBIDDEN_FIELD', `forbidden public field: ${childPath}`, {
          path: childPath,
          key: k,
        })
      }
      continue
    }
    out[k] = sanitizePublicValue(v, { mode, path: childPath })
  }
  return out
}

/**
 * Canonical public account mask: `acc_***` + exactly 4 alphanumeric tail chars.
 * Leading `acc_` alone is NOT masking (hostile `acc_plaintextSECRET` must remask).
 */
export const CANONICAL_MASKED_ACCOUNT_RE = /^acc_\*{3}[A-Za-z0-9]{4}$/

export function isCanonicalMaskedAccountId(value: string): boolean {
  return CANONICAL_MASKED_ACCOUNT_RE.test(value)
}

/**
 * Always produce a canonical masked id. `acc_` prefix is not trusted as already-masked.
 */
export function maskAccountId(raw: string): string {
  if (isCanonicalMaskedAccountId(raw)) return raw
  if (!raw) return 'acc_****'
  // Last 4 alphanumeric of the full string (handles hostile acc_ prefixes and hyphens).
  const alnum = String(raw).replace(/[^A-Za-z0-9]/g, '')
  if (alnum.length < 4) return 'acc_****'
  return `acc_***${alnum.slice(-4)}`
}

/** Alias: force-mask any residual identity. */
export function ensureMaskedAccountId(raw: string): string {
  return maskAccountId(String(raw ?? ''))
}

export function maskAccountRef(raw: string | null | undefined): string | null {
  if (raw == null || raw === '') return null
  return maskAccountId(String(raw))
}

/**
 * Public account usable=false when status is BAN/403/AUTH_EXPIRED/quarantine/tombstone/LIMIT
 * or when account-sync authority is stale/absent/parity-invalid (caller supplies syncBlocked).
 */
export function isPublicAccountStatusUnusable(status: string | null | undefined): boolean {
  if (status == null || status === '') return true
  const s = String(status).trim()
  const upper = s.toUpperCase()
  if (
    upper === 'BAN' ||
    upper === '403' ||
    upper === 'AUTH_EXPIRED' ||
    upper === 'REMOVED' ||
    upper === 'LIMIT' ||
    upper === 'TOMBSTONE' ||
    upper === 'QUARANTINE' ||
    upper === 'QUARANTINED'
  ) {
    return true
  }
  if (s === 'quarantine') return true
  return false
}

/**
 * Fingerprint of public payload identity excluding wall-clock freshness fields.
 * Used for cache invalidation when pin tuple is unchanged but decisions/G5/counts change.
 */
export function publicContentFingerprint(input: PublicAggregationInput): string {
  const body = {
    boardId: input.boardId,
    pin: {
      canonicalSnapshotId: input.pin.canonicalSnapshotId,
      canonicalHash: input.pin.canonicalHash,
      boardRev: input.pin.boardRev,
      lifecycleRev: input.pin.lifecycleRev,
      serializerVersion: input.pin.serializerVersion,
    },
    boardRollup: input.boardRollup,
    completion: input.completion,
    buckets: input.buckets,
    staleOverlays: input.staleOverlays ?? {},
    priorityRollup: input.priorityRollup ?? null,
    projects: input.projects ?? [],
    features: input.features ?? [],
    tasks: input.tasks ?? [],
    runs: input.runs ?? [],
    accounts: input.accounts ?? [],
    decisionCount: input.decisionCount,
    g5: input.g5,
    usableCapacity: Math.max(0, Math.floor(input.usableCapacity ?? 0)),
    domainBlockers: normalizeDomainBlockers(input.domainBlockers),
    forceStale: Boolean(input.forceStale),
  }
  return sha256Hex(stableStringify(body))
}

/**
 * Sanitize + sort domain blockers to allowlisted codes only.
 * Drops unknown codes (structural codes must not leak into public DTO as soft blockers).
 */
export function normalizeDomainBlockers(
  blockers: ReadonlyArray<PublicDomainBlocker> | null | undefined,
): Array<PublicDomainBlocker> {
  if (!blockers || blockers.length === 0) return []
  const byCode = new Map<string, PublicDomainBlocker>()
  for (const b of blockers) {
    const code = String(b?.code ?? '').trim()
    if (!isPublicDomainBlockerCode(code)) continue
    const count = Math.max(0, Math.floor(Number(b.count) || 0))
    if (count <= 0) continue
    const reason =
      b.reason == null || b.reason === ''
        ? null
        : String(b.reason).slice(0, 240).replace(/[\u0000-\u001f]/g, ' ')
    const prev = byCode.get(code)
    if (prev) {
      byCode.set(code, {
        code,
        count: prev.count + count,
        reason: prev.reason ?? reason,
      })
    } else {
      byCode.set(code, { code, count, reason })
    }
  }
  return [...byCode.values()].sort((a, b) =>
    a.code < b.code ? -1 : a.code > b.code ? 1 : 0,
  )
}

function sortById<T extends { id: string }>(arr: ReadonlyArray<T>): Array<T> {
  return [...arr].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
}

function sortByRunId(arr: ReadonlyArray<PublicRunSummary>): Array<PublicRunSummary> {
  return [...arr].sort((a, b) =>
    a.runId < b.runId ? -1 : a.runId > b.runId ? 1 : 0,
  )
}

function sortByAccount(
  arr: ReadonlyArray<PublicAccountSummary>,
): Array<PublicAccountSummary> {
  return [...arr].sort((a, b) =>
    a.accountIdMasked < b.accountIdMasked
      ? -1
      : a.accountIdMasked > b.accountIdMasked
        ? 1
        : 0,
  )
}

export function computeFreshness(opts: {
  generatedAt: string
  publishedAt: string
  publicationIntervalMs: number
  nowMs: number
}): PublicFreshness {
  const publishedMs = Date.parse(opts.publishedAt)
  const ageMs = Number.isFinite(publishedMs) ? Math.max(0, opts.nowMs - publishedMs) : Number.MAX_SAFE_INTEGER
  const stale = ageMs > 2 * opts.publicationIntervalMs
  return {
    generatedAt: opts.generatedAt,
    publishedAt: opts.publishedAt,
    publicationIntervalMs: opts.publicationIntervalMs,
    stale,
    ageMs,
  }
}

/**
 * Compute ETag = SHA-256(pinned revision tuple + payload without etag/payloadSha256).
 */
export function computePublicEtag(
  pin: PublicSnapshotPin,
  payloadWithoutEtag: Omit<PublicSnapshotPayload, 'etag' | 'payloadSha256'>,
): string {
  const tuple = {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    serializerVersion: pin.serializerVersion,
  }
  const canonical = stableStringify({ pin: tuple, payload: payloadWithoutEtag })
  return sha256Hex(canonical)
}

/**
 * Materialize public output ONCE from a single pinned aggregation.
 * Does not recompute rollup; only serializes/sanitizes/hashes the provided input.
 */
export function materializePublicSnapshot(input: PublicAggregationInput): MaterializedPublicSnapshot {
  try {
    assertPin(input.pin)
    if (!input.boardId) {
      throw new PublicSnapshotError('INVALID_PIN', 'boardId required')
    }

    const publicationIntervalMs = input.publicationIntervalMs ?? 60_000
    const publishedAt = input.publishedAt ?? input.generatedAt
    const nowMs = input.nowMs ?? Date.now()
    const freshness = computeFreshness({
      generatedAt: input.generatedAt,
      publishedAt,
      publicationIntervalMs,
      nowMs,
    })
    // Domain-blocker sanitized truth: force stale=true (still 200, never 503).
    if (input.forceStale) {
      freshness.stale = true
    }

    const domainBlockers = normalizeDomainBlockers(input.domainBlockers)
    // Fail-closed: any domain blocker or omitted capacity → usableCapacity=0.
    let usableCapacity = Math.max(0, Math.floor(input.usableCapacity ?? 0))
    if (domainBlockers.length > 0 || input.forceStale) {
      usableCapacity = 0
    }

    const projects = sortById(
      (input.projects ?? []).map((p) => ({
        id: p.id,
        name: p.name ?? null,
        status: p.status ?? null,
      })),
    )
    const features = sortById(
      (input.features ?? []).map((f) => {
        const progressNodes = Array.isArray(f.progressNodes)
          ? f.progressNodes.map((n) => ({
              taskId: n.taskId,
              title: typeof n.title === 'string' && n.title.trim() ? n.title : n.taskId,
              lifecycleStage:
                typeof n.lifecycleStage === 'string' && n.lifecycleStage.length > 0
                  ? n.lifecycleStage
                  : null,
              status:
                typeof n.status === 'string' && n.status.length > 0 ? n.status : null,
              technicalTitle:
                typeof n.technicalTitle === 'string' && n.technicalTitle.trim()
                  ? n.technicalTitle.trim()
                  : null,
              contentReviewRequired: n.contentReviewRequired === true,
            }))
          : null
        const stageCounts =
          f.stageCounts && typeof f.stageCounts === 'object' && !Array.isArray(f.stageCounts)
            ? { ...f.stageCounts }
            : null
        const taskCount =
          typeof f.taskCount === 'number' && Number.isFinite(f.taskCount)
            ? Math.max(0, Math.floor(f.taskCount))
            : progressNodes
              ? progressNodes.length
              : null
        return {
          id: f.id,
          projectId: f.projectId ?? null,
          name: f.name ?? null,
          phase: f.phase ?? null,
          taskCount,
          stageCounts,
          progressNodes,
        }
      }),
    )
    const tasks = sortById(
      (input.tasks ?? []).map((t) => ({
        id: t.id,
        projectId: t.projectId ?? null,
        title: t.title ?? null,
        bucket: t.bucket ?? null,
        readinessPercent: t.readinessPercent ?? null,
        lifecycleStage:
          typeof t.lifecycleStage === 'string' && t.lifecycleStage.length > 0
            ? t.lifecycleStage
            : null,
      })),
    )
    const runs = sortByRunId(
      (input.runs ?? []).map((r) => ({
        runId: r.runId,
        status: r.status,
        taskId: r.taskId ?? null,
        agentRole: r.agentRole ?? null,
        // Always remask — `acc_` prefix is not sufficient proof of masking.
        accountRefMasked: maskAccountRef(r.accountRefMasked ?? null),
        lastHeartbeatAt: r.lastHeartbeatAt ?? null,
      })),
    )
    const accounts = sortByAccount(
      (input.accounts ?? []).map((a) => {
        const status = a.status
        const forcedUnusable = isPublicAccountStatusUnusable(status)
        return {
          accountIdMasked: ensureMaskedAccountId(a.accountIdMasked),
          status,
          provider: a.provider ?? null,
          // Caller may set usable=false for sync parity; never promote unusable statuses.
          // Domain blockers also force all accounts unusable on public surface.
          usable:
            domainBlockers.length > 0 || input.forceStale
              ? false
              : forcedUnusable
                ? false
                : Boolean(a.usable),
        }
      }),
    )

    const draft: Omit<PublicSnapshotPayload, 'etag' | 'payloadSha256'> = {
      schemaVersion: PUBLIC_SNAPSHOT_SCHEMA,
      boardId: input.boardId,
      pin: { ...input.pin },
      boardRollup: { ...input.boardRollup },
      completion: { ...input.completion },
      buckets: { ...input.buckets },
      staleOverlays: { ...(input.staleOverlays ?? {}) },
      priorityRollup: input.priorityRollup ? { ...input.priorityRollup } : null,
      projects,
      features,
      tasks,
      runs,
      accounts,
      decisionCount: Math.max(0, Math.floor(input.decisionCount)),
      g5: { ...input.g5 },
      usableCapacity,
      domainBlockers,
      freshness,
    }

    // Strict sanitize — reject forbidden private fields if they slipped in.
    const sanitized = sanitizePublicValue(draft, { mode: 'strict' }) as typeof draft

    const etag = computePublicEtag(input.pin, sanitized)
    const payload: PublicSnapshotPayload = {
      ...sanitized,
      etag,
      payloadSha256: etag,
    }
    const bodyJson = stableStringify(payload)
    const contentFingerprint = publicContentFingerprint(input)

    return {
      etag,
      payload,
      bodyJson,
      pin: { ...input.pin },
      materializedAt: publishedAt,
      contentFingerprint,
    }
  } catch (err) {
    if (err instanceof PublicSnapshotError) throw err
    // Fail-closed: never return partial/sensitive data on unexpected errors.
    throw new PublicSnapshotError(
      'MATERIALIZATION_FAILED',
      err instanceof Error ? err.message : 'materialization failed',
      { failClosed: true },
    )
  }
}

/**
 * In-memory once-materialized store keyed by pin identity.
 * Re-reads return the same object; no recomputation of payload.
 */
export interface PublicSnapshotStore {
  get(boardId: string): MaterializedPublicSnapshot | null
  put(boardId: string, snap: MaterializedPublicSnapshot): void
  clear(boardId?: string): void
}

export function createMemoryPublicSnapshotStore(): PublicSnapshotStore {
  const map = new Map<string, MaterializedPublicSnapshot>()
  return {
    get: (boardId) => map.get(boardId) ?? null,
    put: (boardId, snap) => {
      map.set(boardId, snap)
    },
    clear: (boardId) => {
      if (boardId) map.delete(boardId)
      else map.clear()
    },
  }
}

export function pinIdentity(pin: PublicSnapshotPin): string {
  return `${pin.canonicalSnapshotId}|${pin.canonicalHash}|${pin.boardRev}|${pin.lifecycleRev}|${pin.serializerVersion}`
}

/**
 * Full materialization cache identity: pin + public content fingerprint.
 * Decisions/lifecycle/G5/count changes invalidate even when boardHash/pin tuple is stable.
 */
export function materializationCacheIdentity(input: PublicAggregationInput): string {
  return `${pinIdentity(input.pin)}|${publicContentFingerprint(input)}`
}

/**
 * Materialize if missing, pin changed, OR public content fingerprint changed.
 * Same pin+content → return cached (no recompute). Pin alone is not enough.
 */
export function getOrMaterializePublicSnapshot(opts: {
  boardId: string
  store: PublicSnapshotStore
  input: PublicAggregationInput
}): MaterializedPublicSnapshot {
  const existing = opts.store.get(opts.boardId)
  const nextFp = publicContentFingerprint(opts.input)
  if (
    existing &&
    existing.payload.boardId === opts.boardId &&
    pinIdentity(existing.pin) === pinIdentity(opts.input.pin) &&
    existing.contentFingerprint === nextFp
  ) {
    return existing
  }
  const snap = materializePublicSnapshot(opts.input)
  opts.store.put(opts.boardId, snap)
  return snap
}

/** Normalize ETag header values (strip W/ and quotes). */
export function normalizeEtagHeader(value: string | null | undefined): string | null {
  if (value == null) return null
  let v = value.trim()
  if (v.startsWith('W/')) v = v.slice(2).trim()
  if (v.startsWith('"') && v.endsWith('"')) v = v.slice(1, -1)
  return v || null
}

export function etagMatches(
  ifNoneMatch: string | null | undefined,
  etag: string,
): boolean {
  if (!ifNoneMatch) return false
  // Support multi-value If-None-Match
  const parts = ifNoneMatch.split(',').map((p) => normalizeEtagHeader(p))
  if (parts.includes('*')) return true
  const want = normalizeEtagHeader(etag) ?? etag
  return parts.some((p) => p === want || p === etag)
}

export type PublicSnapshotHandlerResult =
  | { kind: 'ok'; status: 200; body: string; etag: string; headers: Record<string, string> }
  | { kind: 'not_modified'; status: 304; etag: string; headers: Record<string, string> }
  | { kind: 'rate_limited'; status: 429; body: string; headers: Record<string, string> }
  | { kind: 'error'; status: number; body: string; headers: Record<string, string> }

export interface PublicSnapshotDeps {
  store: PublicSnapshotStore
  /** Provides the pinned aggregation for a board — injected (C2B owns real store). */
  loadAggregation: (boardId: string) => Promise<PublicAggregationInput | null>
  rateLimiter?: {
    check: (key: string) => {
      allowed: boolean
      remaining: number
      limit: number
      retryAfterSeconds?: number
      policyId: string
      key: string
    }
  }
  resolveIp?: (request: Request) => string
  nowMs?: () => number
}

/**
 * Core public snapshot GET handler — injectable, no server boot required.
 * Fail-closed on missing aggregation / materialization errors (503, empty public body).
 */
export async function handlePublicSnapshotGet(
  request: Request,
  deps: PublicSnapshotDeps,
): Promise<PublicSnapshotHandlerResult> {
  const safeHeaders = (extra: Record<string, string> = {}) => ({
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'public, max-age=0, must-revalidate',
    ...extra,
  })

  try {
    const url = new URL(request.url)
    const boardId = url.searchParams.get('boardId') ?? url.searchParams.get('board') ?? ''
    if (!boardId) {
      return {
        kind: 'error',
        status: 400,
        body: JSON.stringify({ error: 'boardId required', code: 'INVALID_INPUT' }),
        headers: safeHeaders(),
      }
    }

    const ip = deps.resolveIp ? deps.resolveIp(request) : 'unknown'
    if (deps.rateLimiter) {
      const decision = deps.rateLimiter.check(`public-snapshot:${ip}`)
      if (!decision.allowed) {
        const retry = decision.retryAfterSeconds ?? 1
        return {
          kind: 'rate_limited',
          status: 429,
          body: JSON.stringify({
            error: 'public snapshot rate limit exceeded',
            code: 'RATE_LIMITED',
            policyId: decision.policyId,
            retryAfterSeconds: retry,
          }),
          headers: safeHeaders({
            'retry-after': String(retry),
            'x-ratelimit-limit': String(decision.limit),
            'x-ratelimit-remaining': '0',
            'x-ratelimit-policy': decision.policyId,
          }),
        }
      }
    }

    const aggregation = await deps.loadAggregation(boardId)
    if (!aggregation) {
      // Fail-closed: no sensitive fallback.
      return {
        kind: 'error',
        status: 503,
        body: JSON.stringify({
          error: 'public snapshot unavailable',
          code: 'STALE_OR_MISSING',
          stale: true,
        }),
        headers: safeHeaders(),
      }
    }

    // Ensure boardId matches request (never leak other board aggregation).
    if (aggregation.boardId !== boardId) {
      return {
        kind: 'error',
        status: 503,
        body: JSON.stringify({
          error: 'public snapshot unavailable',
          code: 'AUTH_DATA_LEAK_BLOCKED',
        }),
        headers: safeHeaders(),
      }
    }

    if (deps.nowMs) {
      aggregation.nowMs = deps.nowMs()
    }

    const snap = getOrMaterializePublicSnapshot({
      boardId,
      store: deps.store,
      input: aggregation,
    })

    const ifNoneMatch = request.headers.get('if-none-match')
    if (etagMatches(ifNoneMatch, snap.etag)) {
      return {
        kind: 'not_modified',
        status: 304,
        etag: snap.etag,
        headers: {
          etag: `"${snap.etag}"`,
          'cache-control': 'public, max-age=0, must-revalidate',
          'x-public-serializer': PUBLIC_SERIALIZER_VERSION,
        },
      }
    }

    return {
      kind: 'ok',
      status: 200,
      body: snap.bodyJson,
      etag: snap.etag,
      headers: safeHeaders({
        etag: `"${snap.etag}"`,
        'x-public-serializer': PUBLIC_SERIALIZER_VERSION,
        'x-snapshot-stale': snap.payload.freshness.stale ? '1' : '0',
      }),
    }
  } catch (err) {
    // Fail-closed — never emit private payload on error.
    const code =
      err instanceof PublicSnapshotError ? err.code : 'MATERIALIZATION_FAILED'
    return {
      kind: 'error',
      status: 503,
      body: JSON.stringify({
        error: 'public snapshot unavailable',
        code,
        failClosed: true,
      }),
      headers: safeHeaders(),
    }
  }
}

/** Convert handler result to a Web Response. */
export function publicSnapshotResultToResponse(
  result: PublicSnapshotHandlerResult,
): Response {
  if (result.kind === 'not_modified') {
    return new Response(null, { status: 304, headers: result.headers })
  }
  return new Response(result.body, { status: result.status, headers: result.headers })
}
