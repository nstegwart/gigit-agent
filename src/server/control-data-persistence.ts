/**
 * MySQL repository foundation for control-plane durable data (F1).
 * Implements RevisionStore, IdempotencyStorage, DecisionV3Store, ImportStorage,
 * G5 domain store, and classification receipt store against 001+004 tables.
 *
 * Injectable SQL client (unit tests use createMemoryControlDataSql / memory facade).
 * No board-mcp wiring. Never last-write-wins on revisions. Never stores secrets.
 */
import { createHash, randomUUID } from 'node:crypto'
import type { Pool, PoolConnection, ResultSetHeader, RowDataPacket } from 'mysql2/promise'

import type {
  ClassificationReceipt,
  G5DomainId,
  G5DomainRecord,
  LifecycleStageKey,
  TaskClass,
  TaskClassificationRecord,
  TaskDisposition,
} from '#/lib/control-plane-types'
import {
  sanitizeClassificationRecordForPersistence,
  stripSelfAssertedMembershipFields,
} from '#/server/classification'
import type {
  RegisteredStageEvidence,
  StageEvidenceStore,
  StageReceipt,
} from '#/server/lifecycle-store'
import type {
  DecisionOptionV3,
  DecisionSeverity,
  DecisionV3Record,
  DecisionV3Status,
  DecisionV3Store,
} from '#/server/decisions-v3'
import type {
  IdempotencyRecord,
  IdempotencyStorage,
} from '#/server/idempotency'
import { isSecretObservabilityKey } from '#/server/observability'
import type {
  ImportBoardState,
  ImportStorage,
  PinnedSnapshotBundle,
} from '#/server/canonical-import'
import {
  CANONICALIZATION_ALGORITHM,
  CANONICAL_SNAPSHOT_SCHEMA,
  computeDistinctCounts,
  type CanonicalSnapshot,
  type CanonicalSnapshotPayload,
  type CanonicalSnapshotManifest,
} from '#/server/canonical-snapshot'
import {
  evaluateCas,
  type CasMutationRequest,
  type CasResult,
  type RevisionIdentity,
  type RevisionState,
  type RevisionStore,
} from '#/server/revisions'
import { db } from '#/server/db'

// =============================================================================
// SQL client contract (matches mysql2 pool/connection shape)
// =============================================================================

export type ControlDataQueryResult = [rows: unknown, fields: unknown]

export interface ControlDataQueryable {
  query(sql: string, params?: Array<unknown>): Promise<ControlDataQueryResult>
}

export interface ControlDataConnection extends ControlDataQueryable {
  beginTransaction(): Promise<void>
  commit(): Promise<void>
  rollback(): Promise<void>
  release(): void
}

export interface ControlDataSqlClient extends ControlDataQueryable {
  getConnection(): Promise<ControlDataConnection>
}

// =============================================================================
// Domain store interfaces
// =============================================================================

export interface G5DomainStore {
  list(boardId: string): Promise<Array<G5DomainRecord>>
  get(boardId: string, domainId: G5DomainId): Promise<G5DomainRecord | null>
  put(boardId: string, record: G5DomainRecord): Promise<void>
  putAll(boardId: string, records: ReadonlyArray<G5DomainRecord>): Promise<void>
}

export interface ClassificationDataStore {
  get(boardId: string, taskId: string): Promise<TaskClassificationRecord | null>
  list(boardId: string): Promise<Array<TaskClassificationRecord>>
  put(
    boardId: string,
    record: TaskClassificationRecord,
    pins?: { boardRev?: number | null; entityRev?: number | null; lifecycleRev?: number | null },
  ): Promise<void>
  putReceipt(boardId: string, receipt: ClassificationReceipt): Promise<void>
  getReceipt(boardId: string, receiptId: string): Promise<ClassificationReceipt | null>
  /**
   * Transactional complete-set publication used by ROOT classification sync.
   * Optional so memory/test stores remain compatible; production MySQL provides it.
   */
  replaceAll?(
    boardId: string,
    records: ReadonlyArray<TaskClassificationRecord>,
    pins: {
      expectedBoardRev: number
      expectedEntityRev: number
      outputBoardRev: number
      outputEntityRev: number
      lifecycleRev: number
      canonicalHash: string
      actorId: string
      auditId: string
      receiptSetHash: string
      issuedAt: string
    },
  ): Promise<{ boardRev: number; entityRev: number; auditId: string }>
}

/** Immutable material audit row for canonical import (board-isolated). */
export interface ImportAuditRecord {
  boardId: string
  auditId: string
  importId: string | null
  snapshotId: string | null
  event: string
  actorId: string | null
  payloadSha256: string | null
  canonicalHash: string | null
  boardRev: number | null
  lifecycleRev: number | null
  entityRev: number | null
  contentHash: string
  capturedAt: string
  /** Sanitized payload only — secrets / private decision text stripped. */
  payload: Record<string, unknown>
}

/** ImportStorage plus durable appendAudit + readback (MySQL foundation). */
export interface MysqlImportStorage extends ImportStorage {
  appendAudit(entry: Record<string, unknown>): Promise<void>
  listImportAudit(boardId: string): Promise<Array<ImportAuditRecord>>
  getImportAudit(boardId: string, auditId: string): Promise<ImportAuditRecord | null>
}

export interface ControlDataPersistence {
  revisions: RevisionStore
  idempotency: IdempotencyStorage
  decisions: DecisionV3Store
  imports: MysqlImportStorage
  g5: G5DomainStore
  classification: ClassificationDataStore
  /**
   * Immutable lifecycle stage-evidence receipt registry (program emit only).
   * advance_task resolves receiptId+hash here — never self-created on advance.
   */
  stageEvidence: StageEvidenceStore
  /** Optional pool close when this module owns the connection. */
  close?(): Promise<void>
}

export interface MysqlControlDataOptions {
  /** Injected client (tests / shared pool). Default: db() pool. */
  client?: ControlDataSqlClient
  /** When true and no client, do not create a real pool (tests must inject). */
  requireInjected?: boolean
}

// =============================================================================
// Helpers
// =============================================================================

function asRows<T extends RowDataPacket>(rows: unknown): Array<T> {
  return (Array.isArray(rows) ? rows : []) as Array<T>
}

function parseJson<T>(value: unknown, fallback: T): T {
  if (value == null) return fallback
  if (typeof value === 'string') {
    try {
      return JSON.parse(value) as T
    } catch {
      return fallback
    }
  }
  return value as T
}

function toMysqlDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  // DATETIME(3) friendly: YYYY-MM-DD HH:mm:ss.sss
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

function fromMysqlDateTime(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  const s = String(value)
  if (!s) return null
  // MySQL often returns "YYYY-MM-DD HH:mm:ss.sss"
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  const withZ = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const ms = Date.parse(withZ)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

function bool01(v: unknown): boolean {
  return v === true || v === 1 || v === '1'
}

function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null)
}

/** Stable domain error for control-data persistence integrity / lock failures. */
export type ControlDataPersistenceErrorCode =
  | 'DATA_INTEGRITY'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_INPUT'
  | 'STALE_REVISION'

export class ControlDataPersistenceError extends Error {
  readonly code: ControlDataPersistenceErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: ControlDataPersistenceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'ControlDataPersistenceError'
    this.code = code
    this.details = details
  }
}

/** Read MySQL GET_LOCK / numeric scalar from a single-row result. */
function firstNumericCell(rows: unknown, aliases: ReadonlyArray<string> = ['l', 'r']): number {
  const row = asRows<RowDataPacket>(rows)[0]
  if (!row || typeof row !== 'object') return 0
  for (const a of aliases) {
    if (a in row && row[a] != null) return Number(row[a])
  }
  // Unaliased GET_LOCK(?, 10) / RELEASE_LOCK(?) column names from some drivers.
  for (const key of Object.keys(row)) {
    if (/GET_LOCK|RELEASE_LOCK/i.test(key) && row[key] != null) return Number(row[key])
  }
  const vals = Object.values(row)
  if (vals.length === 1 && vals[0] != null) return Number(vals[0])
  return 0
}

/**
 * Insert-once immutability: existing row with same content hash → no-op.
 * Existing row with different hash/payload → IDEMPOTENCY_CONFLICT (no write).
 */
function assertImmutableReplay(opts: {
  kind: string
  key: string
  existingHash: string
  nextHash: string
  extra?: Record<string, unknown>
}): 'REPLAY' {
  if (opts.existingHash === opts.nextHash) return 'REPLAY'
  throw new ControlDataPersistenceError(
    'IDEMPOTENCY_CONFLICT',
    `${opts.kind} rewrite with different hash/payload forbidden`,
    {
      key: opts.key,
      existingHash: opts.existingHash,
      nextHash: opts.nextHash,
      ...opts.extra,
    },
  )
}

/** Marker for secret / credential / PII values in sanitized audit material. */
export const IMPORT_AUDIT_REDACTED = '[REDACTED]' as const
/** Marker for private decision / owner comment prose (not credentials). */
export const IMPORT_AUDIT_REDACTED_PRIVATE = '[REDACTED_PRIVATE]' as const

/** Max nesting for import-audit sanitizer. Exceeded → reject (never partial leak). */
const IMPORT_AUDIT_MAX_DEPTH = 12
/** Max nodes visited during recursive sanitization. Exceeded → reject. */
const IMPORT_AUDIT_MAX_NODES = 10_000

/**
 * Exact legacy private-decision keys retained for unit contracts.
 * Normalized matching (below) covers camel/snake/kebab/case variants beyond this set.
 */
const IMPORT_AUDIT_PRIVATE_TEXT_KEYS = new Set([
  'question',
  'agentRecommendation',
  'agent_recommendation',
  'comment',
  'comments',
  'privateDecision',
  'private_decision',
  'privateDecisionText',
  'private_decision_text',
  'decisionText',
  'decision_text',
  'decisionComment',
  'decision_comment',
  'decisionTitle',
  'decision_title',
  'ownerPrivateNotes',
  'owner_private_notes',
  'ownerComment',
  'owner_comment',
  'ownerComments',
  'owner_comments',
  'evidenceBody',
  'evidence_body',
])

/** Atomic tokens for private decision / owner prose (normalized key segments). */
const IMPORT_AUDIT_PRIVATE_TOKENS = new Set([
  'question',
  'comment',
  'comments',
  'ownercomment',
  'ownercomments',
  'ownerprivatenotes',
  'privatedecision',
  'privatedecisiontext',
  'decisiontext',
  'decisioncomment',
  'decisiontitle',
  'agentrecommendation',
  'evidencebody',
])

/** Atomic tokens for raw account identity / PII that must never persist in audit. */
const IMPORT_AUDIT_PII_TOKENS = new Set([
  'rawidentity',
  'unmaskedidentity',
  'email',
  'ssn',
  'phone',
  'phonenumber',
  'nationalid',
  'passport',
  'dob',
  'dateofbirth',
  'fullname',
  'fullname',
])

/**
 * Value-shape hints: PEM, Bearer, sk- keys, raw JWT, session= cookies.
 * Applied when the key was not already classified as secret/private/PII.
 */
const IMPORT_AUDIT_SECRET_VALUE_HINT =
  /-----BEGIN |Bearer\s+[A-Za-z0-9\-._~+/]+=*|sk-[A-Za-z0-9]{10,}|eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}|session=[^;\s]+/i

/** Split camelCase / snake_case / kebab-case into lowercase alphanumeric tokens. */
function importAuditKeyTokens(key: string): Array<string> {
  return key
    .replace(/([a-z0-9])([A-Z])/g, '$1_$2')
    .replace(/([A-Z]+)([A-Z][a-z])/g, '$1_$2')
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean)
}

/** Compact form of a key for exact-token PII/private checks (no separators). */
function importAuditNormalizedKey(key: string): string {
  return key.replace(/[^a-zA-Z0-9]/g, '').toLowerCase()
}

/**
 * True if a key names private decision / owner comment prose.
 * Covers exact legacy keys plus camel/snake/kebab variants via normalized tokens.
 */
export function isImportAuditPrivateTextKey(key: string): boolean {
  if (IMPORT_AUDIT_PRIVATE_TEXT_KEYS.has(key)) return true
  const norm = importAuditNormalizedKey(key)
  if (IMPORT_AUDIT_PRIVATE_TOKENS.has(norm)) return true
  // Segment-level: any token "comment(s)" / decision* private prose, except decisionCount.
  if (/^decisioncount$/i.test(norm)) return false
  const tokens = importAuditKeyTokens(key)
  for (const t of tokens) {
    if (t === 'comment' || t === 'comments') return true
    if (t === 'question') return true
    if (t.startsWith('decision') && t !== 'decisioncount') {
      if (
        t === 'decisiontext' ||
        t === 'decisioncomment' ||
        t === 'decisiontitle' ||
        tokens.includes('text') ||
        tokens.includes('comment') ||
        tokens.includes('title') ||
        tokens.includes('private')
      ) {
        return true
      }
    }
    if (t === 'evidence' || t === 'evidencebody') return true
    if (t === 'agentrecommendation' || (t === 'agent' && tokens.includes('recommendation'))) {
      return true
    }
  }
  if (/private.?decision|decision.?text|owner.?comment|evidence.?body|agent.?recommendation/i.test(key)) {
    return true
  }
  return false
}

/**
 * True if a key names raw account identity / PII fields.
 */
export function isImportAuditPiiKey(key: string): boolean {
  const norm = importAuditNormalizedKey(key)
  if (IMPORT_AUDIT_PII_TOKENS.has(norm)) return true
  const tokens = importAuditKeyTokens(key)
  for (const t of tokens) {
    if (IMPORT_AUDIT_PII_TOKENS.has(t)) return true
    if (t === 'raw' && tokens.includes('identity')) return true
    if (t === 'unmasked' && tokens.includes('identity')) return true
  }
  return false
}

/**
 * True if an import-audit key must never retain its raw value
 * (secrets via observability hardened key tokens + private prose + PII).
 */
export function isImportAuditSensitiveKey(key: string): boolean {
  if (isSecretObservabilityKey(key)) return true
  if (isImportAuditPrivateTextKey(key)) return true
  if (isImportAuditPiiKey(key)) return true
  // Extra compound aliases not always covered by observability token set alone.
  const norm = importAuditNormalizedKey(key)
  if (
    /clientsecret|access token|accesstoken|refreshtoken|apikey|privatekey|xauthtoken|xcairntoken/.test(
      norm.replace(/\s+/g, ''),
    )
  ) {
    return true
  }
  return false
}

function importAuditRedactMarker(key: string): string {
  if (isImportAuditPrivateTextKey(key)) return IMPORT_AUDIT_REDACTED_PRIVATE
  return IMPORT_AUDIT_REDACTED
}

function importAuditRedactStringValue(value: string): string {
  if (IMPORT_AUDIT_SECRET_VALUE_HINT.test(value)) return IMPORT_AUDIT_REDACTED
  return value
}

/**
 * Sanitize audit payload: fail-closed recursive redaction of secrets, private
 * decision text, raw identity/PII, and secret-shaped string values.
 * Cycle / depth / node-budget violations throw (never return uninspected subtrees).
 */
export function sanitizeImportAuditPayload(value: unknown): unknown {
  const seen = new WeakSet<object>()
  let nodes = 0

  const walk = (v: unknown, depth: number, path: string): unknown => {
    if (depth > IMPORT_AUDIT_MAX_DEPTH) {
      throw new ControlDataPersistenceError(
        'INVALID_INPUT',
        `import audit sanitizer nesting exceeds max depth ${IMPORT_AUDIT_MAX_DEPTH} at ${path || '(root)'}`,
        { path: path || '(root)', limit: IMPORT_AUDIT_MAX_DEPTH },
      )
    }
    if (v === null || v === undefined) return v
    if (typeof v === 'string') return importAuditRedactStringValue(v)
    if (typeof v !== 'object') return v

    if (seen.has(v as object)) {
      throw new ControlDataPersistenceError(
        'INVALID_INPUT',
        `import audit sanitizer refuses cyclic reference at ${path || '(root)'}`,
        { path: path || '(root)' },
      )
    }
    seen.add(v as object)

    nodes += 1
    if (nodes > IMPORT_AUDIT_MAX_NODES) {
      throw new ControlDataPersistenceError(
        'INVALID_INPUT',
        `import audit sanitizer exceeds max scan nodes ${IMPORT_AUDIT_MAX_NODES}`,
        { path: path || '(root)', limit: IMPORT_AUDIT_MAX_NODES },
      )
    }

    if (Array.isArray(v)) {
      return v.map((item, i) => walk(item, depth + 1, path ? `${path}[${i}]` : `[${i}]`))
    }

    const out: Record<string, unknown> = {}
    for (const [k, child] of Object.entries(v as Record<string, unknown>)) {
      const childPath = path ? `${path}.${k}` : k
      if (isImportAuditSensitiveKey(k)) {
        out[k] = importAuditRedactMarker(k)
        continue
      }
      out[k] = walk(child, depth + 1, childPath)
    }
    return out
  }

  return walk(value, 0, '')
}

function asOptionalString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

function asOptionalNumber(v: unknown): number | null {
  if (v == null || v === '') return null
  const n = Number(v)
  return Number.isFinite(n) ? n : null
}

function pickEntryField(
  entry: Record<string, unknown>,
  keys: ReadonlyArray<string>,
): unknown {
  for (const k of keys) {
    if (k in entry && entry[k] != null) return entry[k]
  }
  return undefined
}

/** Bound material fields extracted from a free-form appendAudit entry. */
export interface BoundImportAudit {
  boardId: string
  auditId: string
  importId: string | null
  snapshotId: string | null
  event: string
  actorId: string | null
  payloadSha256: string | null
  canonicalHash: string | null
  boardRev: number | null
  lifecycleRev: number | null
  entityRev: number | null
  capturedAt: string
  /** Sanitized material payload (no secrets / private decision text). */
  payload: Record<string, unknown>
  contentHash: string
}

/**
 * Bind + sanitize an appendAudit entry into durable material fields.
 * Derives stable audit_id when not supplied so exact replay is idempotent.
 */
export function bindImportAuditEntry(entry: Record<string, unknown>): BoundImportAudit {
  const sanitizedRoot = sanitizeImportAuditPayload(entry)
  const safe =
    sanitizedRoot && typeof sanitizedRoot === 'object' && !Array.isArray(sanitizedRoot)
      ? (sanitizedRoot as Record<string, unknown>)
      : {}

  const boardId = asOptionalString(
    pickEntryField(entry, ['boardId', 'board_id']) ?? pickEntryField(safe, ['boardId', 'board_id']),
  )
  if (!boardId) {
    throw new ControlDataPersistenceError(
      'INVALID_INPUT',
      'import audit requires boardId',
      {},
    )
  }

  const importId = asOptionalString(
    pickEntryField(entry, ['importId', 'import_id']) ??
      pickEntryField(safe, ['importId', 'import_id']),
  )
  const snapshotId = asOptionalString(
    pickEntryField(entry, ['snapshotId', 'snapshot_id']) ??
      pickEntryField(safe, ['snapshotId', 'snapshot_id']),
  )
  const event =
    asOptionalString(
      pickEntryField(entry, ['event', 'action', 'eventType', 'event_type']) ??
        pickEntryField(safe, ['event', 'action', 'eventType', 'event_type']),
    ) ?? 'canonical_import'
  const actorId = asOptionalString(
    pickEntryField(entry, ['actorId', 'actor', 'actor_id']) ??
      pickEntryField(safe, ['actorId', 'actor', 'actor_id']),
  )
  const payloadSha256 = asOptionalString(
    pickEntryField(entry, ['payloadSha256', 'payload_sha256']) ??
      pickEntryField(safe, ['payloadSha256', 'payload_sha256']),
  )
  const canonicalHash = asOptionalString(
    pickEntryField(entry, ['canonicalHash', 'canonical_hash']) ??
      pickEntryField(safe, ['canonicalHash', 'canonical_hash']),
  )
  const boardRev = asOptionalNumber(
    pickEntryField(entry, ['boardRev', 'board_rev']) ??
      pickEntryField(safe, ['boardRev', 'board_rev']),
  )
  const lifecycleRev = asOptionalNumber(
    pickEntryField(entry, ['lifecycleRev', 'lifecycle_rev']) ??
      pickEntryField(safe, ['lifecycleRev', 'lifecycle_rev']),
  )
  const entityRev = asOptionalNumber(
    pickEntryField(entry, ['entityRev', 'entity_rev']) ??
      pickEntryField(safe, ['entityRev', 'entity_rev']),
  )
  const capturedAtRaw =
    asOptionalString(
      pickEntryField(entry, ['capturedAt', 'ts', 'captured_at', 'appliedAt']) ??
        pickEntryField(safe, ['capturedAt', 'ts', 'captured_at', 'appliedAt']),
    ) ?? new Date().toISOString()
  // Normalize to ISO for stable content_hash across MySQL round-trips.
  const capturedMs = Date.parse(capturedAtRaw)
  const capturedAt = Number.isNaN(capturedMs)
    ? capturedAtRaw
    : new Date(capturedMs).toISOString()

  const providedAuditId = asOptionalString(
    pickEntryField(entry, ['auditId', 'audit_id', 'eventId', 'event_id']),
  )
  const auditId =
    providedAuditId ??
    createHash('sha256')
      .update(
        [boardId, importId ?? '', snapshotId ?? '', event, capturedAt].join('\n'),
        'utf8',
      )
      .digest('hex')

  // Material payload: only bound safe fields (never full raw entry).
  const payload: Record<string, unknown> = {
    boardId,
    importId,
    snapshotId,
    event,
    actorId,
    payloadSha256,
    canonicalHash,
    boardRev,
    lifecycleRev,
    entityRev,
    capturedAt,
  }
  // Allow non-secret extension keys from sanitized entry (e.g. schemaVersion).
  // Drop alias/material keys + any sensitive secret/private/PII key (even if redacted).
  const BOUND_ALIAS_DROP = new Set([
    'board_id',
    'import_id',
    'snapshot_id',
    'actor',
    'actor_id',
    'payload_sha256',
    'canonical_hash',
    'board_rev',
    'lifecycle_rev',
    'entity_rev',
    'captured_at',
    'ts',
    'action',
    'eventType',
    'event_type',
    'auditId',
    'audit_id',
    'eventId',
    'event_id',
  ])
  for (const [k, v] of Object.entries(safe)) {
    if (k in payload) continue
    if (BOUND_ALIAS_DROP.has(k)) continue
    if (isImportAuditSensitiveKey(k)) continue
    payload[k] = v
  }

  const contentHash = createHash('sha256')
    .update(
      JSON.stringify({
        boardId,
        auditId,
        importId,
        snapshotId,
        event,
        actorId,
        payloadSha256,
        canonicalHash,
        boardRev,
        lifecycleRev,
        entityRev,
        capturedAt,
        payload,
      }),
      'utf8',
    )
    .digest('hex')

  return {
    boardId,
    auditId,
    importId,
    snapshotId,
    event,
    actorId,
    payloadSha256,
    canonicalHash,
    boardRev,
    lifecycleRev,
    entityRev,
    capturedAt,
    payload,
    contentHash,
  }
}

function mapImportAuditRow(r: RowDataPacket): ImportAuditRecord {
  const payload = parseJson<Record<string, unknown>>(r.payload_json, {})
  return {
    boardId: String(r.board_id),
    auditId: String(r.audit_id),
    importId: r.import_id != null ? String(r.import_id) : null,
    snapshotId: r.snapshot_id != null ? String(r.snapshot_id) : null,
    event: String(r.event ?? ''),
    actorId: r.actor_id != null ? String(r.actor_id) : null,
    payloadSha256: r.payload_sha256 != null ? String(r.payload_sha256) : null,
    canonicalHash: r.canonical_hash != null ? String(r.canonical_hash) : null,
    boardRev: r.board_rev != null ? Number(r.board_rev) : null,
    lifecycleRev: r.lifecycle_rev != null ? Number(r.lifecycle_rev) : null,
    entityRev: r.entity_rev != null ? Number(r.entity_rev) : null,
    contentHash: String(r.content_hash ?? ''),
    capturedAt: fromMysqlDateTime(r.captured_at) ?? String(r.captured_at ?? ''),
    payload,
  }
}

async function withTx<T>(
  client: ControlDataSqlClient,
  fn: (conn: ControlDataConnection) => Promise<T>,
): Promise<T> {
  const conn = await client.getConnection()
  try {
    await conn.beginTransaction()
    const result = await fn(conn)
    await conn.commit()
    return result
  } catch (e) {
    try {
      await conn.rollback()
    } catch {
      /* ignore rollback errors */
    }
    throw e
  } finally {
    conn.release()
  }
}

// =============================================================================
// RevisionStore (board_revisions + entity_revisions)
// =============================================================================

export function createMysqlRevisionStore(client: ControlDataSqlClient): RevisionStore {
  return {
    async getBoardRev(boardId: string) {
      const [rows] = await client.query(
        'SELECT board_rev, subject_hash FROM board_revisions WHERE board_id=? LIMIT 1',
        [boardId],
      )
      const r = asRows<RowDataPacket>(rows)[0]
      if (!r) return { boardRev: 0, subjectHash: null as string | null }
      return {
        boardRev: Number(r.board_rev ?? 0),
        subjectHash: r.subject_hash != null ? String(r.subject_hash) : null,
      }
    },

    async getEntity(id: RevisionIdentity) {
      const [rows] = await client.query(
        `SELECT board_id, entity_type, entity_id, entity_rev, subject_hash
         FROM entity_revisions
         WHERE board_id=? AND entity_type=? AND entity_id=? LIMIT 1`,
        [id.boardId, id.entityType, id.entityId],
      )
      const ent = asRows<RowDataPacket>(rows)[0]
      const board = await this.getBoardRev(id.boardId)
      if (!ent) return null
      return {
        boardId: String(ent.board_id),
        entityType: String(ent.entity_type),
        entityId: String(ent.entity_id),
        entityRev: Number(ent.entity_rev ?? 0),
        boardRev: board.boardRev,
        subjectHash: ent.subject_hash != null ? String(ent.subject_hash) : null,
      } satisfies RevisionState
    },

    async compareAndSwap(req: CasMutationRequest): Promise<CasResult> {
      return withTx(client, async (conn) => {
        const [boardRows] = await conn.query(
          'SELECT board_rev, subject_hash FROM board_revisions WHERE board_id=? FOR UPDATE',
          [req.boardId],
        )
        const boardRow = asRows<RowDataPacket>(boardRows)[0]
        let board: { board_rev: number; subject_hash: string | null }
        if (!boardRow) {
          await conn.query(
            `INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash)
             VALUES (?, 0, 0, NULL)`,
            [req.boardId],
          )
          board = { board_rev: 0, subject_hash: null }
        } else {
          board = {
            board_rev: Number(boardRow.board_rev ?? 0),
            subject_hash: boardRow.subject_hash != null ? String(boardRow.subject_hash) : null,
          }
        }

        const [entRows] = await conn.query(
          `SELECT board_id, entity_type, entity_id, entity_rev, subject_hash
           FROM entity_revisions
           WHERE board_id=? AND entity_type=? AND entity_id=?
           FOR UPDATE`,
          [req.boardId, req.entityType, req.entityId],
        )
        const ent = asRows<RowDataPacket>(entRows)[0]
        const current: RevisionState = ent
          ? {
              boardId: String(ent.board_id),
              entityType: String(ent.entity_type),
              entityId: String(ent.entity_id),
              entityRev: Number(ent.entity_rev ?? 0),
              boardRev: Number(board.board_rev ?? 0),
              subjectHash: ent.subject_hash != null ? String(ent.subject_hash) : null,
            }
          : {
              boardId: req.boardId,
              entityType: req.entityType,
              entityId: req.entityId,
              entityRev: 0,
              boardRev: Number(board.board_rev ?? 0),
              subjectHash: null,
            }

        const result = evaluateCas(current, req)
        if (!result.ok) return result

        await conn.query(
          `INSERT INTO entity_revisions (board_id, entity_type, entity_id, entity_rev, subject_hash)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE entity_rev=VALUES(entity_rev), subject_hash=VALUES(subject_hash)`,
          [req.boardId, req.entityType, req.entityId, result.entityRev, result.subjectHash],
        )
        await conn.query(
          `INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash)
           VALUES (?, ?, 0, ?)
           ON DUPLICATE KEY UPDATE board_rev=VALUES(board_rev), subject_hash=VALUES(subject_hash)`,
          [req.boardId, result.boardRev, result.subjectHash],
        )
        return result
      })
    },
  }
}

// =============================================================================
// IdempotencyStorage (control_plane_idempotency)
// =============================================================================

type IdemRow = RowDataPacket & {
  scope_hash: string
  actor_id: string
  board_id: string
  endpoint: string
  idempotency_key: string
  request_hash: string
  response_status: number
  response_body_json: unknown
  run_id: string | null
  created_at: Date | string
  expires_at: Date | string
  in_progress?: number | boolean
}

function mapIdempotency(r: IdemRow): IdempotencyRecord {
  const createdAtMs = r.created_at instanceof Date ? r.created_at.getTime() : Date.parse(String(r.created_at))
  const expiresAtMs = r.expires_at instanceof Date ? r.expires_at.getTime() : Date.parse(String(r.expires_at))
  return {
    scopeHash: String(r.scope_hash),
    actorId: String(r.actor_id),
    boardId: String(r.board_id),
    endpoint: String(r.endpoint),
    key: String(r.idempotency_key),
    requestHash: String(r.request_hash),
    responseStatus: Number(r.response_status ?? 0),
    responseBody: parseJson(r.response_body_json, null),
    runId: r.run_id != null ? String(r.run_id) : null,
    createdAtMs: Number.isFinite(createdAtMs) ? createdAtMs : 0,
    expiresAtMs: Number.isFinite(expiresAtMs) ? expiresAtMs : 0,
    inProgress: bool01(r.in_progress) || Number(r.response_status ?? 0) === 0,
  }
}

export function createMysqlIdempotencyStorage(client: ControlDataSqlClient): IdempotencyStorage {
  return {
    async get(scopeHash: string) {
      const [rows] = await client.query(
        `SELECT scope_hash, actor_id, board_id, endpoint, idempotency_key, request_hash,
                response_status, response_body_json, run_id, created_at, expires_at, in_progress
         FROM control_plane_idempotency WHERE scope_hash=? LIMIT 1`,
        [scopeHash],
      )
      const r = asRows<IdemRow>(rows)[0]
      return r ? mapIdempotency(r) : null
    },

    async getByRunId(boardId: string, runId: string) {
      const [rows] = await client.query(
        `SELECT scope_hash, actor_id, board_id, endpoint, idempotency_key, request_hash,
                response_status, response_body_json, run_id, created_at, expires_at, in_progress
         FROM control_plane_idempotency WHERE board_id=? AND run_id=? LIMIT 1`,
        [boardId, runId],
      )
      const r = asRows<IdemRow>(rows)[0]
      return r ? mapIdempotency(r) : null
    },

    async putIfAbsent(record: IdempotencyRecord) {
      const createdAt = new Date(record.createdAtMs).toISOString().replace('T', ' ').replace('Z', '')
      const expiresAt = new Date(record.expiresAtMs).toISOString().replace('T', ' ').replace('Z', '')
      try {
        await client.query(
          `INSERT INTO control_plane_idempotency
             (scope_hash, actor_id, board_id, endpoint, idempotency_key, request_hash,
              response_status, response_body_json, run_id, created_at, expires_at, in_progress)
           VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
          [
            record.scopeHash,
            record.actorId,
            record.boardId,
            record.endpoint,
            record.key,
            record.requestHash,
            record.responseStatus,
            record.responseBody == null ? null : jsonParam(record.responseBody),
            record.runId ?? null,
            createdAt,
            expiresAt,
            record.inProgress ? 1 : 0,
          ],
        )
        return { inserted: true, record: { ...record } }
      } catch (e) {
        const err = e as { errno?: number; code?: string }
        // ER_DUP_ENTRY
        if (err.errno === 1062 || err.code === 'ER_DUP_ENTRY') {
          const existing =
            (await this.get(record.scopeHash)) ??
            (record.runId ? await this.getByRunId(record.boardId, record.runId) : null)
          if (existing) return { inserted: false, record: existing }
        }
        throw e
      }
    },

    async complete(scopeHash, patch) {
      await client.query(
        `UPDATE control_plane_idempotency
         SET response_status=?, response_body_json=?, request_hash=?, in_progress=?
         WHERE scope_hash=?`,
        [
          patch.responseStatus,
          patch.responseBody == null ? null : jsonParam(patch.responseBody),
          patch.requestHash,
          patch.inProgress === false ? 0 : patch.inProgress ? 1 : 0,
          scopeHash,
        ],
      )
    },

    async delete(scopeHash: string) {
      await client.query('DELETE FROM control_plane_idempotency WHERE scope_hash=?', [scopeHash])
    },
  }
}

// =============================================================================
// DecisionV3Store (control_plane_decisions)
// =============================================================================

type DecisionRow = RowDataPacket & Record<string, unknown>

function mapDecision(r: DecisionRow): DecisionV3Record {
  const fromJson = parseJson<Partial<DecisionV3Record> | null>(r.record_json, null)
  if (fromJson && fromJson.decisionId) {
    return {
      ...fromJson,
      decisionId: String(fromJson.decisionId),
      boardId: String(fromJson.boardId),
      options: Array.isArray(fromJson.options) ? fromJson.options : [],
      evidence: Array.isArray(fromJson.evidence) ? fromJson.evidence : [],
      auditIds: Array.isArray(fromJson.auditIds) ? fromJson.auditIds : [],
    } as DecisionV3Record
  }
  return {
    decisionId: String(r.decision_id),
    boardId: String(r.board_id),
    projectId: r.project_id != null ? String(r.project_id) : null,
    featureId: r.feature_id != null ? String(r.feature_id) : null,
    taskId: r.task_id != null ? String(r.task_id) : null,
    runId: r.run_id != null ? String(r.run_id) : null,
    type: String(r.type),
    severity: String(r.severity) as DecisionSeverity,
    title: String(r.title),
    question: String(r.question),
    evidence: parseJson<Array<string>>(r.evidence_json, []),
    options: parseJson<Array<DecisionOptionV3>>(r.options_json, []),
    agentRecommendation: r.agent_recommendation != null ? String(r.agent_recommendation) : null,
    blocking: bool01(r.blocking),
    dueAt: fromMysqlDateTime(r.due_at),
    dueAtMs: r.due_at_ms != null ? Number(r.due_at_ms) : null,
    createdAt: fromMysqlDateTime(r.created_at) ?? new Date(0).toISOString(),
    createdAtMs: Number(r.created_at_ms ?? 0),
    snoozedUntil: fromMysqlDateTime(r.snoozed_until),
    snoozedUntilMs: r.snoozed_until_ms != null ? Number(r.snoozed_until_ms) : null,
    status: String(r.status) as DecisionV3Status,
    ownerId: r.owner_id != null ? String(r.owner_id) : null,
    resolverId: r.resolver_id != null ? String(r.resolver_id) : null,
    selectedOptionId: r.selected_option_id != null ? String(r.selected_option_id) : null,
    comment: r.comment != null ? String(r.comment) : null,
    expectedRev: Number(r.expected_rev ?? 0),
    boardRev: Number(r.board_rev ?? 0),
    entityRev: Number(r.entity_rev ?? 1),
    scopedApprovalId: r.scoped_approval_id != null ? String(r.scoped_approval_id) : null,
    auditIds: parseJson<Array<string>>(r.audit_ids_json, []),
    expiresAt: fromMysqlDateTime(r.expires_at),
    expiresAtMs: r.expires_at_ms != null ? Number(r.expires_at_ms) : null,
  }
}

export function createMysqlDecisionV3Store(client: ControlDataSqlClient): DecisionV3Store {
  const chains = new Map<string, Promise<unknown>>()

  return {
    async get(boardId, decisionId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_decisions WHERE board_id=? AND decision_id=? LIMIT 1`,
        [boardId, decisionId],
      )
      const r = asRows<DecisionRow>(rows)[0]
      return r ? mapDecision(r) : null
    },

    async put(rec: DecisionV3Record) {
      await client.query(
        `INSERT INTO control_plane_decisions (
           board_id, decision_id, project_id, feature_id, task_id, run_id, type, severity,
           title, question, evidence_json, options_json, agent_recommendation, blocking,
           due_at, due_at_ms, created_at, created_at_ms, snoozed_until, snoozed_until_ms,
           status, owner_id, resolver_id, selected_option_id, comment,
           expected_rev, board_rev, entity_rev, scoped_approval_id, audit_ids_json,
           expires_at, expires_at_ms, record_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           project_id=VALUES(project_id), feature_id=VALUES(feature_id), task_id=VALUES(task_id),
           run_id=VALUES(run_id), type=VALUES(type), severity=VALUES(severity),
           title=VALUES(title), question=VALUES(question), evidence_json=VALUES(evidence_json),
           options_json=VALUES(options_json), agent_recommendation=VALUES(agent_recommendation),
           blocking=VALUES(blocking), due_at=VALUES(due_at), due_at_ms=VALUES(due_at_ms),
           snoozed_until=VALUES(snoozed_until), snoozed_until_ms=VALUES(snoozed_until_ms),
           status=VALUES(status), owner_id=VALUES(owner_id), resolver_id=VALUES(resolver_id),
           selected_option_id=VALUES(selected_option_id), comment=VALUES(comment),
           expected_rev=VALUES(expected_rev), board_rev=VALUES(board_rev), entity_rev=VALUES(entity_rev),
           scoped_approval_id=VALUES(scoped_approval_id), audit_ids_json=VALUES(audit_ids_json),
           expires_at=VALUES(expires_at), expires_at_ms=VALUES(expires_at_ms),
           record_json=VALUES(record_json)`,
        [
          rec.boardId,
          rec.decisionId,
          rec.projectId,
          rec.featureId,
          rec.taskId,
          rec.runId,
          rec.type,
          rec.severity,
          rec.title,
          rec.question,
          jsonParam(rec.evidence),
          jsonParam(rec.options),
          rec.agentRecommendation,
          rec.blocking ? 1 : 0,
          toMysqlDateTime(rec.dueAt),
          rec.dueAtMs,
          toMysqlDateTime(rec.createdAt) ?? toMysqlDateTime(new Date(rec.createdAtMs).toISOString()),
          rec.createdAtMs,
          toMysqlDateTime(rec.snoozedUntil),
          rec.snoozedUntilMs,
          rec.status,
          rec.ownerId,
          rec.resolverId,
          rec.selectedOptionId,
          rec.comment,
          rec.expectedRev,
          rec.boardRev,
          rec.entityRev,
          rec.scopedApprovalId,
          jsonParam(rec.auditIds),
          toMysqlDateTime(rec.expiresAt),
          rec.expiresAtMs,
          jsonParam(rec),
        ],
      )
    },

    async list(boardId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_decisions WHERE board_id=?`,
        [boardId],
      )
      return asRows<DecisionRow>(rows).map(mapDecision)
    },

    async withBoardLock(boardId, fn) {
      // Process-local chain + MySQL named lock on ONE pinned connection.
      // Fail closed: acquire must return 1; never execute unlocked.
      if (typeof client.getConnection !== 'function') {
        throw new ControlDataPersistenceError(
          'INVALID_INPUT',
          'withBoardLock requires connection-pinned ControlDataSqlClient.getConnection()',
          { boardId },
        )
      }
      const prev = chains.get(boardId) ?? Promise.resolve()
      let releaseChain!: () => void
      const gate = new Promise<void>((r) => {
        releaseChain = r
      })
      chains.set(boardId, prev.then(() => gate))
      await prev
      const lockName = `cairn_decision_${boardId}`.slice(0, 64)
      let conn: ControlDataConnection | null = null
      let acquired = false
      try {
        conn = await client.getConnection()
        const [acqRows] = await conn.query('SELECT GET_LOCK(?, 10) AS l', [lockName])
        acquired = firstNumericCell(acqRows, ['l']) === 1
        if (!acquired) {
          throw new ControlDataPersistenceError(
            'DATA_INTEGRITY',
            'failed to acquire decision board named lock',
            { boardId, lockName, acquire: firstNumericCell(acqRows, ['l']) },
          )
        }
        try {
          return await fn()
        } finally {
          // Same pinned connection as GET_LOCK — never use the pool here.
          try {
            await conn.query('SELECT RELEASE_LOCK(?) AS r', [lockName])
          } catch {
            /* release best-effort after critical section; acquire already held */
          }
          acquired = false
        }
      } finally {
        if (conn) {
          try {
            conn.release()
          } catch {
            /* ignore */
          }
        }
        releaseChain()
      }
    },
  }
}

// =============================================================================
// ImportStorage (board_revisions + control_plane_snapshots + control_plane_imports)
// =============================================================================

type BoardRevRow = RowDataPacket & {
  board_id: string
  board_rev: number
  lifecycle_rev: number
  subject_hash: string | null
  canonical_snapshot_id: string | null
  canonical_hash: string | null
  last_snapshot_id: string | null
  last_snapshot_generated_at: Date | string | null
  last_payload_sha256: string | null
  import_entity_rev: number
  dispatch_blocked?: number | boolean
  dispatch_blocked_reason?: string | null
}

function mapImportBoardState(r: BoardRevRow, lifecycleEvidenceByTask: Record<string, unknown> = {}): ImportBoardState {
  return {
    boardId: String(r.board_id),
    boardRev: Number(r.board_rev ?? 0),
    lifecycleRev: Number(r.lifecycle_rev ?? 0),
    lastSnapshotGeneratedAt: fromMysqlDateTime(r.last_snapshot_generated_at),
    lastSnapshotId: r.last_snapshot_id != null ? String(r.last_snapshot_id) : null,
    lastPayloadSha256: r.last_payload_sha256 != null ? String(r.last_payload_sha256) : null,
    canonicalSnapshotId: r.canonical_snapshot_id != null ? String(r.canonical_snapshot_id) : null,
    canonicalHash: r.canonical_hash != null ? String(r.canonical_hash) : null,
    entityRev: Number(r.import_entity_rev ?? 0),
    subjectHash: r.subject_hash != null ? String(r.subject_hash) : null,
    lifecycleEvidenceByTask,
  }
}

type SnapshotRegistryRow = RowDataPacket & {
  board_id: string
  snapshot_id: string
  schema_version: string
  source_repo_id: string | null
  source_commit_sha: string | null
  payload_sha256: string
  board_rev: number
  lifecycle_rev: number
  generated_at: Date | string | null
  producer_version: string | null
  payload_json: unknown
}

/**
 * Reconstruct a CanonicalSnapshot envelope from an immutable registry row.
 * distinctCounts are recomputed from payload (not stored on the row).
 */
export function reconstructSnapshotFromRegistryRow(
  r: SnapshotRegistryRow,
): { snapshot: CanonicalSnapshot; boardRev: number; lifecycleRev: number } {
  const payload = parseJson<CanonicalSnapshotPayload>(r.payload_json, {
    projects: [],
    flows: [],
    nodes: [],
    tasks: [],
    dependencies: [],
    featureContractJoins: [],
    nodeJoins: [],
    primaryOwnerships: [],
    classifications: [],
    anchors: [],
    acceptancePaths: [],
  })
  const generatedAt =
    fromMysqlDateTime(r.generated_at) ?? new Date(0).toISOString()
  const schemaVersion =
    r.schema_version === CANONICAL_SNAPSHOT_SCHEMA
      ? CANONICAL_SNAPSHOT_SCHEMA
      : (String(r.schema_version ?? '') as typeof CANONICAL_SNAPSHOT_SCHEMA)
  const manifest: CanonicalSnapshotManifest = {
    schemaVersion,
    boardId: String(r.board_id),
    snapshotId: String(r.snapshot_id),
    sourceRepoId: r.source_repo_id != null ? String(r.source_repo_id) : '',
    sourceCommitSha: r.source_commit_sha != null ? String(r.source_commit_sha) : '',
    generatedAt,
    canonicalizationAlgorithm: CANONICALIZATION_ALGORITHM,
    payloadSha256: String(r.payload_sha256 ?? ''),
    distinctCounts: computeDistinctCounts(payload),
    producerVersion: r.producer_version != null ? String(r.producer_version) : '',
  }
  return {
    snapshot: { manifest, payload },
    boardRev: Number(r.board_rev ?? 0),
    lifecycleRev: Number(r.lifecycle_rev ?? 0),
  }
}

export function createMysqlImportStorage(
  client: ControlDataSqlClient,
  opts: {
    /** Optional external lifecycle evidence reader — import must never write it. */
    readLifecycleEvidence?: (boardId: string) => Promise<Record<string, unknown>>
  } = {},
): MysqlImportStorage {
  return {
    async getBoardState(boardId) {
      const [rows] = await client.query(
        `SELECT board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id,
                canonical_hash, last_snapshot_id, last_snapshot_generated_at,
                last_payload_sha256, import_entity_rev
         FROM board_revisions WHERE board_id=? LIMIT 1`,
        [boardId],
      )
      const r = asRows<BoardRevRow>(rows)[0]
      if (!r) return null
      const evidence = opts.readLifecycleEvidence
        ? await opts.readLifecycleEvidence(boardId)
        : {}
      return mapImportBoardState(r, evidence)
    },

    async applySnapshot(args) {
      const { boardId, snapshot, nextEntityRev, nextBoardRev, canonicalHash, actorId, importId, appliedAt } =
        args
      const evidenceBefore = opts.readLifecycleEvidence
        ? await opts.readLifecycleEvidence(boardId)
        : {}

      return withTx(client, async (conn) => {
        const [curRows] = await conn.query(
          `SELECT board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id,
                  canonical_hash, last_snapshot_id, last_snapshot_generated_at,
                  last_payload_sha256, import_entity_rev
           FROM board_revisions WHERE board_id=? FOR UPDATE`,
          [boardId],
        )
        const cur = asRows<BoardRevRow>(curRows)[0]
        const lifecycleRev = cur ? Number(cur.lifecycle_rev ?? 0) : 0

        // Snapshot registry is insert-once provenance: same payload_sha256 may
        // idempotently replay; different hash/payload is DATA_INTEGRITY/conflict.
        const [existingSnapRows] = await conn.query(
          `SELECT payload_sha256 FROM control_plane_snapshots
           WHERE board_id=? AND snapshot_id=? LIMIT 1`,
          [boardId, snapshot.manifest.snapshotId],
        )
        const existingSnap = asRows<RowDataPacket>(existingSnapRows)[0]
        if (existingSnap) {
          assertImmutableReplay({
            kind: 'control_plane_snapshots',
            key: `${boardId}::${snapshot.manifest.snapshotId}`,
            existingHash: String(existingSnap.payload_sha256 ?? ''),
            nextHash: snapshot.manifest.payloadSha256,
          })
        } else {
          await conn.query(
            `INSERT INTO control_plane_snapshots (
               board_id, snapshot_id, schema_version, source_repo_id, source_commit_sha,
               payload_sha256, board_rev, lifecycle_rev, generated_at, producer_version, payload_json
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
            [
              boardId,
              snapshot.manifest.snapshotId,
              snapshot.manifest.schemaVersion,
              snapshot.manifest.sourceRepoId ?? null,
              snapshot.manifest.sourceCommitSha ?? null,
              snapshot.manifest.payloadSha256,
              nextBoardRev,
              lifecycleRev,
              toMysqlDateTime(snapshot.manifest.generatedAt) ?? toMysqlDateTime(appliedAt),
              snapshot.manifest.producerVersion ?? null,
              jsonParam(snapshot.payload),
            ],
          )
        }

        // Board / entity pins remain mutable CAS targets (not provenance archive).
        await conn.query(
          `INSERT INTO board_revisions (
             board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id,
             canonical_hash, last_snapshot_id, last_snapshot_generated_at,
             last_payload_sha256, import_entity_rev
           ) VALUES (?,?,?,?,?,?,?,?,?,?)
           ON DUPLICATE KEY UPDATE
             board_rev=VALUES(board_rev),
             subject_hash=VALUES(subject_hash),
             canonical_snapshot_id=VALUES(canonical_snapshot_id),
             canonical_hash=VALUES(canonical_hash),
             last_snapshot_id=VALUES(last_snapshot_id),
             last_snapshot_generated_at=VALUES(last_snapshot_generated_at),
             last_payload_sha256=VALUES(last_payload_sha256),
             import_entity_rev=VALUES(import_entity_rev)`,
          [
            boardId,
            nextBoardRev,
            lifecycleRev,
            canonicalHash,
            snapshot.manifest.snapshotId,
            canonicalHash,
            snapshot.manifest.snapshotId,
            toMysqlDateTime(snapshot.manifest.generatedAt),
            snapshot.manifest.payloadSha256,
            nextEntityRev,
          ],
        )

        // Entity pin for canonical_import subject
        await conn.query(
          `INSERT INTO entity_revisions (board_id, entity_type, entity_id, entity_rev, subject_hash)
           VALUES (?,?,?,?,?)
           ON DUPLICATE KEY UPDATE entity_rev=VALUES(entity_rev), subject_hash=VALUES(subject_hash)`,
          [boardId, 'canonical_import', boardId, nextEntityRev, canonicalHash],
        )

        // Import audit row is insert-once provenance (canonical_hash + payload_sha256).
        const [existingImportRows] = await conn.query(
          `SELECT payload_sha256, canonical_hash FROM control_plane_imports
           WHERE board_id=? AND import_id=? LIMIT 1`,
          [boardId, importId],
        )
        const existingImport = asRows<RowDataPacket>(existingImportRows)[0]
        if (existingImport) {
          const existingHash = String(
            existingImport.canonical_hash ?? existingImport.payload_sha256 ?? '',
          )
          const nextHash = canonicalHash || snapshot.manifest.payloadSha256
          assertImmutableReplay({
            kind: 'control_plane_imports',
            key: `${boardId}::${importId}`,
            existingHash,
            nextHash,
            extra: {
              existingPayloadSha256: existingImport.payload_sha256,
              nextPayloadSha256: snapshot.manifest.payloadSha256,
            },
          })
          if (
            String(existingImport.payload_sha256 ?? '') !== snapshot.manifest.payloadSha256
          ) {
            throw new ControlDataPersistenceError(
              'IDEMPOTENCY_CONFLICT',
              'control_plane_imports rewrite with different payload_sha256 forbidden',
              {
                key: `${boardId}::${importId}`,
                existingPayloadSha256: existingImport.payload_sha256,
                nextPayloadSha256: snapshot.manifest.payloadSha256,
              },
            )
          }
        } else {
          await conn.query(
            `INSERT INTO control_plane_imports (
               board_id, import_id, snapshot_id, status, actor_id, request_hash, dry_run,
               payload_sha256, canonical_hash, board_rev, lifecycle_rev, entity_rev, provenance_json
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
            [
              boardId,
              importId,
              snapshot.manifest.snapshotId,
              'APPLIED',
              actorId,
              null,
              0,
              snapshot.manifest.payloadSha256,
              canonicalHash,
              nextBoardRev,
              lifecycleRev,
              nextEntityRev,
              jsonParam({
                actorId,
                appliedAt,
                sourceRepoId: snapshot.manifest.sourceRepoId,
                sourceCommitSha: snapshot.manifest.sourceCommitSha,
                schemaVersion: snapshot.manifest.schemaVersion,
              }),
            ],
          )
        }

        // Lifecycle evidence must remain unchanged (read-only fingerprint; no writes).
        void evidenceBefore

        return {
          boardId,
          boardRev: nextBoardRev,
          lifecycleRev,
          lastSnapshotGeneratedAt: snapshot.manifest.generatedAt,
          lastSnapshotId: snapshot.manifest.snapshotId,
          lastPayloadSha256: snapshot.manifest.payloadSha256,
          canonicalSnapshotId: snapshot.manifest.snapshotId,
          canonicalHash,
          entityRev: nextEntityRev,
          subjectHash: canonicalHash,
          lifecycleEvidenceByTask: evidenceBefore,
        } satisfies ImportBoardState
      })
    },

    async getPinnedSnapshot(boardId): Promise<PinnedSnapshotBundle | null> {
      const [pinRows] = await client.query(
        `SELECT board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id,
                canonical_hash, last_snapshot_id, last_snapshot_generated_at,
                last_payload_sha256, import_entity_rev
         FROM board_revisions WHERE board_id=? LIMIT 1`,
        [boardId],
      )
      const pinRow = asRows<BoardRevRow>(pinRows)[0]
      if (!pinRow) return null

      const evidence = opts.readLifecycleEvidence
        ? await opts.readLifecycleEvidence(boardId)
        : {}
      const pin = mapImportBoardState(pinRow, evidence)

      const snapId =
        pin.canonicalSnapshotId != null && String(pin.canonicalSnapshotId).trim()
          ? String(pin.canonicalSnapshotId).trim()
          : null
      if (!snapId) {
        return {
          pin,
          snapshot: null,
          snapshotBoardRev: null,
          snapshotLifecycleRev: null,
        }
      }

      const [snapRows] = await client.query(
        `SELECT board_id, snapshot_id, schema_version, source_repo_id, source_commit_sha,
                payload_sha256, board_rev, lifecycle_rev, generated_at, producer_version, payload_json
         FROM control_plane_snapshots
         WHERE board_id=? AND snapshot_id=? LIMIT 1`,
        [boardId, snapId],
      )
      const snapRow = asRows<SnapshotRegistryRow>(snapRows)[0]
      if (!snapRow) {
        return {
          pin,
          snapshot: null,
          snapshotBoardRev: null,
          snapshotLifecycleRev: null,
        }
      }

      const reconstructed = reconstructSnapshotFromRegistryRow(snapRow)
      return {
        pin,
        snapshot: reconstructed.snapshot,
        snapshotBoardRev: reconstructed.boardRev,
        snapshotLifecycleRev: reconstructed.lifecycleRev,
      }
    },

    async appendAudit(entry) {
      // Immutable material audit: sanitize → bind → insert-once by (board, audit_id).
      // Exact same content_hash may idempotently replay; different hash = conflict.
      const bound = bindImportAuditEntry(entry && typeof entry === 'object' ? entry : {})

      const [existingRows] = await client.query(
        `SELECT content_hash FROM control_plane_import_audit
         WHERE board_id=? AND audit_id=? LIMIT 1`,
        [bound.boardId, bound.auditId],
      )
      const existing = asRows<RowDataPacket>(existingRows)[0]
      if (existing) {
        assertImmutableReplay({
          kind: 'control_plane_import_audit',
          key: `${bound.boardId}::${bound.auditId}`,
          existingHash: String(existing.content_hash ?? ''),
          nextHash: bound.contentHash,
          extra: {
            event: bound.event,
            importId: bound.importId,
            snapshotId: bound.snapshotId,
          },
        })
        return
      }

      await client.query(
        `INSERT INTO control_plane_import_audit (
           board_id, audit_id, import_id, snapshot_id, event, actor_id,
           payload_sha256, canonical_hash, board_rev, lifecycle_rev, entity_rev,
           content_hash, captured_at, payload_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          bound.boardId,
          bound.auditId,
          bound.importId,
          bound.snapshotId,
          bound.event,
          bound.actorId,
          bound.payloadSha256,
          bound.canonicalHash,
          bound.boardRev,
          bound.lifecycleRev,
          bound.entityRev,
          bound.contentHash,
          toMysqlDateTime(bound.capturedAt),
          jsonParam(bound.payload),
        ],
      )
    },

    async listImportAudit(boardId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_import_audit WHERE board_id=? ORDER BY captured_at ASC, audit_id ASC`,
        [boardId],
      )
      return asRows<RowDataPacket>(rows).map(mapImportAuditRow)
    },

    async getImportAudit(boardId, auditId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_import_audit WHERE board_id=? AND audit_id=? LIMIT 1`,
        [boardId, auditId],
      )
      const r = asRows<RowDataPacket>(rows)[0]
      return r ? mapImportAuditRow(r) : null
    },
  }
}

// =============================================================================
// G5DomainStore (control_plane_g5)
// =============================================================================

type G5Row = RowDataPacket & Record<string, unknown>

function mapG5(r: G5Row): G5DomainRecord {
  const fromJson = parseJson<Partial<G5DomainRecord> | null>(r.record_json, null)
  if (fromJson && fromJson.domainId) {
    return {
      domainId: fromJson.domainId,
      scope: fromJson.scope ?? 'board',
      required: fromJson.required ?? bool01(r.required),
      status: fromJson.status ?? (String(r.status) as G5DomainRecord['status']),
      evidenceReceiptIds: fromJson.evidenceReceiptIds ?? parseJson(r.evidence_ids_json, []),
      evidenceReceiptHashes: fromJson.evidenceReceiptHashes ?? parseJson(r.evidence_hashes_json, []),
      verifierAgent: fromJson.verifierAgent ?? (r.verifier_agent != null ? String(r.verifier_agent) : null),
      verifierModel: fromJson.verifierModel ?? (r.verifier_model != null ? String(r.verifier_model) : null),
      verifierRunId: fromJson.verifierRunId ?? (r.verifier_run_id != null ? String(r.verifier_run_id) : null),
      authorRunId: fromJson.authorRunId ?? (r.author_run_id != null ? String(r.author_run_id) : null),
      subjectRevision: fromJson.subjectRevision ?? Number(r.subject_revision ?? r.board_rev ?? 0),
      subjectHash: fromJson.subjectHash ?? (r.subject_hash != null ? String(r.subject_hash) : ''),
      findings: fromJson.findings ?? (r.findings != null ? String(r.findings) : null),
      blocker: fromJson.blocker ?? (r.blocker != null ? String(r.blocker) : null),
      capturedAt: fromJson.capturedAt ?? fromMysqlDateTime(r.captured_at),
      expectedRev: fromJson.expectedRev ?? Number(r.expected_rev ?? r.board_rev ?? 0),
      boardRev: fromJson.boardRev ?? Number(r.board_rev ?? 0),
      subjectLifecycleRev: fromJson.subjectLifecycleRev ?? Number(r.lifecycle_rev ?? 0),
      programmaticEvidence: fromJson.programmaticEvidence ?? bool01(r.programmatic_evidence),
      independentVerifier: fromJson.independentVerifier ?? bool01(r.independent_verifier),
    }
  }
  return {
    domainId: String(r.domain) as G5DomainId,
    scope: r.scope != null ? String(r.scope) : 'board',
    required: bool01(r.required),
    status: String(r.status) as G5DomainRecord['status'],
    evidenceReceiptIds: parseJson(r.evidence_ids_json, []),
    evidenceReceiptHashes: parseJson(r.evidence_hashes_json, []),
    verifierAgent: r.verifier_agent != null ? String(r.verifier_agent) : null,
    verifierModel: r.verifier_model != null ? String(r.verifier_model) : null,
    verifierRunId: r.verifier_run_id != null ? String(r.verifier_run_id) : null,
    authorRunId: r.author_run_id != null ? String(r.author_run_id) : null,
    subjectRevision: Number(r.subject_revision ?? r.board_rev ?? 0),
    subjectHash: r.subject_hash != null ? String(r.subject_hash) : '',
    findings: r.findings != null ? String(r.findings) : null,
    blocker: r.blocker != null ? String(r.blocker) : null,
    capturedAt: fromMysqlDateTime(r.captured_at),
    expectedRev: Number(r.expected_rev ?? r.board_rev ?? 0),
    boardRev: Number(r.board_rev ?? 0),
    subjectLifecycleRev: Number(r.lifecycle_rev ?? 0),
    programmaticEvidence: bool01(r.programmatic_evidence),
    independentVerifier: bool01(r.independent_verifier),
  }
}

export function createMysqlG5DomainStore(client: ControlDataSqlClient): G5DomainStore {
  return {
    async list(boardId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_g5 WHERE board_id=?`,
        [boardId],
      )
      return asRows<G5Row>(rows).map(mapG5)
    },

    async get(boardId, domainId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_g5 WHERE board_id=? AND domain=? LIMIT 1`,
        [boardId, domainId],
      )
      const r = asRows<G5Row>(rows)[0]
      return r ? mapG5(r) : null
    },

    async put(boardId, record) {
      const evidenceId = record.evidenceReceiptIds[0] ?? null
      await client.query(
        `INSERT INTO control_plane_g5 (
           board_id, domain, status, required, evidence_id, subject_hash, board_rev, lifecycle_rev,
           scope, evidence_ids_json, evidence_hashes_json, verifier_agent, verifier_model,
           verifier_run_id, author_run_id, subject_revision, expected_rev, findings, blocker,
           captured_at, programmatic_evidence, independent_verifier, record_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           status=VALUES(status), required=VALUES(required), evidence_id=VALUES(evidence_id),
           subject_hash=VALUES(subject_hash), board_rev=VALUES(board_rev), lifecycle_rev=VALUES(lifecycle_rev),
           scope=VALUES(scope), evidence_ids_json=VALUES(evidence_ids_json),
           evidence_hashes_json=VALUES(evidence_hashes_json), verifier_agent=VALUES(verifier_agent),
           verifier_model=VALUES(verifier_model), verifier_run_id=VALUES(verifier_run_id),
           author_run_id=VALUES(author_run_id), subject_revision=VALUES(subject_revision),
           expected_rev=VALUES(expected_rev), findings=VALUES(findings), blocker=VALUES(blocker),
           captured_at=VALUES(captured_at), programmatic_evidence=VALUES(programmatic_evidence),
           independent_verifier=VALUES(independent_verifier), record_json=VALUES(record_json)`,
        [
          boardId,
          record.domainId,
          record.status,
          record.required ? 1 : 0,
          evidenceId,
          record.subjectHash,
          record.boardRev,
          record.subjectLifecycleRev,
          record.scope,
          jsonParam(record.evidenceReceiptIds),
          jsonParam(record.evidenceReceiptHashes),
          record.verifierAgent ?? null,
          record.verifierModel ?? null,
          record.verifierRunId ?? null,
          record.authorRunId ?? null,
          record.subjectRevision,
          record.expectedRev,
          record.findings ?? null,
          record.blocker ?? null,
          toMysqlDateTime(record.capturedAt),
          record.programmaticEvidence ? 1 : 0,
          record.independentVerifier ? 1 : 0,
          jsonParam(record),
        ],
      )
    },

    async putAll(boardId, records) {
      for (const rec of records) {
        await this.put(boardId, rec)
      }
    },
  }
}

// =============================================================================
// ClassificationDataStore
// =============================================================================

type ClassRow = RowDataPacket & Record<string, unknown>

function mapClassification(r: ClassRow): TaskClassificationRecord {
  const receipt = parseJson<ClassificationReceipt | null>(r.receipt_json, null)
  return {
    taskId: String(r.task_id),
    taskClass: String(r.task_class) as TaskClass,
    disposition: String(r.disposition) as TaskDisposition,
    receipt:
      receipt ??
      (r.classification_receipt_id && r.classification_receipt_hash
        ? {
            receiptId: String(r.classification_receipt_id),
            receiptHash: String(r.classification_receipt_hash),
            taskId: String(r.task_id),
            taskClass: String(r.task_class) as TaskClass,
            disposition: String(r.disposition) as TaskDisposition,
            canonicalSnapshotId: r.canonical_snapshot_id != null ? String(r.canonical_snapshot_id) : '',
            canonicalHash: r.canonical_hash != null ? String(r.canonical_hash) : '',
            taskHash: r.task_hash != null ? String(r.task_hash) : '',
            boardRev: Number(r.board_rev ?? 0),
            lifecycleRev: Number(r.lifecycle_rev ?? 0),
            issuedAt: fromMysqlDateTime(r.updated_at) ?? new Date(0).toISOString(),
          }
        : null),
    controlPlaneTargetGate:
      r.control_plane_target_gate != null ? String(r.control_plane_target_gate) : null,
    controlPlaneGateVerifiedPass:
      r.control_plane_gate_verified_pass == null
        ? undefined
        : bool01(r.control_plane_gate_verified_pass),
    controlPlaneRootAccepted:
      r.control_plane_root_accepted == null ? undefined : bool01(r.control_plane_root_accepted),
  }
}

function mapReceipt(r: RowDataPacket): ClassificationReceipt {
  const fromJson = parseJson<ClassificationReceipt | null>(r.receipt_json, null)
  if (fromJson && fromJson.receiptId) return fromJson
  return {
    receiptId: String(r.receipt_id),
    receiptHash: String(r.receipt_hash),
    taskId: String(r.task_id),
    taskClass: String(r.task_class) as TaskClass,
    disposition: String(r.disposition) as TaskDisposition,
    membershipPortfolioId:
      r.membership_portfolio_id != null ? String(r.membership_portfolio_id) : null,
    membershipProofHash: r.membership_proof_hash != null ? String(r.membership_proof_hash) : null,
    canonicalSnapshotId: String(r.canonical_snapshot_id),
    canonicalHash: String(r.canonical_hash),
    taskHash: String(r.task_hash),
    boardRev: Number(r.board_rev),
    lifecycleRev: Number(r.lifecycle_rev),
    issuedAt: fromMysqlDateTime(r.issued_at) ?? new Date(0).toISOString(),
    expiresAt: fromMysqlDateTime(r.expires_at),
  }
}

export function createMysqlClassificationStore(client: ControlDataSqlClient): ClassificationDataStore {
  return {
    async get(boardId, taskId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_classification WHERE board_id=? AND task_id=? LIMIT 1`,
        [boardId, taskId],
      )
      const r = asRows<ClassRow>(rows)[0]
      return r ? mapClassification(r) : null
    },

    async list(boardId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_classification WHERE board_id=?`,
        [boardId],
      )
      return asRows<ClassRow>(rows).map(mapClassification)
    },

    async put(boardId, record, pins = {}) {
      // Security R2: strip self-asserted sales/mfs product-line + hex at durable boundary.
      const sanitized = sanitizeClassificationRecordForPersistence(record)
      const receipt = sanitized.receipt
      await client.query(
        `INSERT INTO control_plane_classification (
           board_id, task_id, task_class, disposition,
           classification_receipt_id, classification_receipt_hash, proof_source,
           board_rev, entity_rev, receipt_json, canonical_snapshot_id, canonical_hash,
           task_hash, lifecycle_rev, control_plane_target_gate,
           control_plane_gate_verified_pass, control_plane_root_accepted
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
         ON DUPLICATE KEY UPDATE
           task_class=VALUES(task_class), disposition=VALUES(disposition),
           classification_receipt_id=VALUES(classification_receipt_id),
           classification_receipt_hash=VALUES(classification_receipt_hash),
           board_rev=VALUES(board_rev), entity_rev=VALUES(entity_rev),
           receipt_json=VALUES(receipt_json), canonical_snapshot_id=VALUES(canonical_snapshot_id),
           canonical_hash=VALUES(canonical_hash), task_hash=VALUES(task_hash),
           lifecycle_rev=VALUES(lifecycle_rev),
           control_plane_target_gate=VALUES(control_plane_target_gate),
           control_plane_gate_verified_pass=VALUES(control_plane_gate_verified_pass),
           control_plane_root_accepted=VALUES(control_plane_root_accepted)`,
        [
          boardId,
          sanitized.taskId,
          sanitized.taskClass,
          sanitized.disposition,
          receipt?.receiptId ?? null,
          receipt?.receiptHash ?? null,
          receipt?.membershipPortfolioId ?? null,
          pins.boardRev ?? receipt?.boardRev ?? null,
          pins.entityRev ?? 1,
          receipt ? jsonParam(receipt) : null,
          receipt?.canonicalSnapshotId ?? null,
          receipt?.canonicalHash ?? null,
          receipt?.taskHash ?? null,
          pins.lifecycleRev ?? receipt?.lifecycleRev ?? null,
          sanitized.controlPlaneTargetGate ?? null,
          sanitized.controlPlaneGateVerifiedPass == null
            ? null
            : sanitized.controlPlaneGateVerifiedPass
              ? 1
              : 0,
          sanitized.controlPlaneRootAccepted == null
            ? null
            : sanitized.controlPlaneRootAccepted
              ? 1
              : 0,
        ],
      )
      if (receipt) {
        await this.putReceipt(boardId, receipt)
      }
    },

    async putReceipt(boardId, receipt) {
      // Security R2: strip self-asserted direct membership before archive insert.
      const clean = stripSelfAssertedMembershipFields(receipt)
      // Insert-once archive: exact same receipt_hash may idempotently replay;
      // different hash/payload => IDEMPOTENCY_CONFLICT with no write.
      const existing = await this.getReceipt(boardId, clean.receiptId)
      if (existing) {
        assertImmutableReplay({
          kind: 'control_plane_classification_receipts',
          key: `${boardId}::${clean.receiptId}`,
          existingHash: existing.receiptHash,
          nextHash: clean.receiptHash,
          extra: {
            existingCanonicalHash: existing.canonicalHash,
            nextCanonicalHash: clean.canonicalHash,
          },
        })
        // Same receipt_hash: also reject silent payload drift on canonical pin.
        if (existing.canonicalHash !== clean.canonicalHash) {
          throw new ControlDataPersistenceError(
            'IDEMPOTENCY_CONFLICT',
            'classification receipt rewrite with different canonical_hash forbidden',
            {
              key: `${boardId}::${clean.receiptId}`,
              existingCanonicalHash: existing.canonicalHash,
              nextCanonicalHash: clean.canonicalHash,
            },
          )
        }
        return
      }
      await client.query(
        `INSERT INTO control_plane_classification_receipts (
           board_id, receipt_id, task_id, receipt_hash, task_class, disposition,
           membership_portfolio_id, membership_proof_hash, canonical_snapshot_id,
           canonical_hash, task_hash, board_rev, lifecycle_rev, issued_at, expires_at, receipt_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          boardId,
          clean.receiptId,
          clean.taskId,
          clean.receiptHash,
          clean.taskClass,
          clean.disposition,
          clean.membershipPortfolioId ?? null,
          clean.membershipProofHash ?? null,
          clean.canonicalSnapshotId,
          clean.canonicalHash,
          clean.taskHash,
          clean.boardRev,
          clean.lifecycleRev,
          toMysqlDateTime(clean.issuedAt),
          toMysqlDateTime(clean.expiresAt ?? null),
          jsonParam(clean),
        ],
      )
    },

    async getReceipt(boardId, receiptId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_classification_receipts
         WHERE board_id=? AND receipt_id=? LIMIT 1`,
        [boardId, receiptId],
      )
      const r = asRows<RowDataPacket>(rows)[0]
      return r ? mapReceipt(r) : null
    },

    async replaceAll(boardId, records, pins) {
      return withTx(client, async (conn) => {
        const [boardRows] = await conn.query(
          `SELECT board_rev, lifecycle_rev, canonical_hash
             FROM board_revisions WHERE board_id=? FOR UPDATE`,
          [boardId],
        )
        const board = asRows<RowDataPacket>(boardRows)[0]
        if (!board) {
          throw new ControlDataPersistenceError('DATA_INTEGRITY', 'classification board pin missing', {
            boardId,
          })
        }
        const currentBoardRev = Number(board.board_rev ?? 0)
        const currentLifecycleRev = Number(board.lifecycle_rev ?? 0)
        const currentCanonicalHash = String(board.canonical_hash ?? '')
        if (
          currentBoardRev !== pins.expectedBoardRev ||
          currentLifecycleRev !== pins.lifecycleRev ||
          currentCanonicalHash !== pins.canonicalHash ||
          pins.outputBoardRev !== pins.expectedBoardRev + 1
        ) {
          throw new ControlDataPersistenceError(
            'STALE_REVISION',
            'classification sync board pin changed',
            {
              boardId,
              currentBoardRev,
              currentLifecycleRev,
              currentCanonicalHash,
            },
          )
        }

        const [entityRows] = await conn.query(
          `SELECT entity_rev FROM entity_revisions
            WHERE board_id=? AND entity_type='classification_sync' AND entity_id=?
            FOR UPDATE`,
          [boardId, boardId],
        )
        const entity = asRows<RowDataPacket>(entityRows)[0]
        const currentEntityRev = Number(entity?.entity_rev ?? 0)
        if (
          currentEntityRev !== pins.expectedEntityRev ||
          pins.outputEntityRev !== pins.expectedEntityRev + 1
        ) {
          throw new ControlDataPersistenceError(
            'STALE_REVISION',
            'classification sync entity revision changed',
            { boardId, currentEntityRev },
          )
        }

        for (const record of records) {
          const sanitized = sanitizeClassificationRecordForPersistence(record)
          const receipt = sanitized.receipt
          if (!receipt) {
            throw new ControlDataPersistenceError(
              'INVALID_INPUT',
              'classification replacement requires a programmatic receipt for every row',
              { taskId: sanitized.taskId },
            )
          }

          const [existingRows] = await conn.query(
            `SELECT receipt_hash, canonical_hash
               FROM control_plane_classification_receipts
              WHERE board_id=? AND receipt_id=? LIMIT 1`,
            [boardId, receipt.receiptId],
          )
          const existing = asRows<RowDataPacket>(existingRows)[0]
          if (existing) {
            assertImmutableReplay({
              kind: 'control_plane_classification_receipts',
              key: `${boardId}::${receipt.receiptId}`,
              existingHash: String(existing.receipt_hash ?? ''),
              nextHash: receipt.receiptHash,
            })
            if (String(existing.canonical_hash ?? '') !== receipt.canonicalHash) {
              throw new ControlDataPersistenceError(
                'IDEMPOTENCY_CONFLICT',
                'classification receipt replay changed canonical_hash',
                { taskId: sanitized.taskId, receiptId: receipt.receiptId },
              )
            }
          } else {
            await conn.query(
              `INSERT INTO control_plane_classification_receipts (
                 board_id, receipt_id, task_id, receipt_hash, task_class, disposition,
                 membership_portfolio_id, membership_proof_hash, canonical_snapshot_id,
                 canonical_hash, task_hash, board_rev, lifecycle_rev, issued_at, expires_at,
                 receipt_json
               ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
              [
                boardId,
                receipt.receiptId,
                receipt.taskId,
                receipt.receiptHash,
                receipt.taskClass,
                receipt.disposition,
                receipt.membershipPortfolioId ?? null,
                receipt.membershipProofHash ?? null,
                receipt.canonicalSnapshotId,
                receipt.canonicalHash,
                receipt.taskHash,
                receipt.boardRev,
                receipt.lifecycleRev,
                toMysqlDateTime(receipt.issuedAt),
                toMysqlDateTime(receipt.expiresAt ?? null),
                jsonParam(receipt),
              ],
            )
          }

          await conn.query(
            `INSERT INTO control_plane_classification (
               board_id, task_id, task_class, disposition,
               classification_receipt_id, classification_receipt_hash, proof_source,
               board_rev, entity_rev, receipt_json, canonical_snapshot_id, canonical_hash,
               task_hash, lifecycle_rev, control_plane_target_gate,
               control_plane_gate_verified_pass, control_plane_root_accepted
             ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
             ON DUPLICATE KEY UPDATE
               task_class=VALUES(task_class), disposition=VALUES(disposition),
               classification_receipt_id=VALUES(classification_receipt_id),
               classification_receipt_hash=VALUES(classification_receipt_hash),
               board_rev=VALUES(board_rev), entity_rev=VALUES(entity_rev),
               receipt_json=VALUES(receipt_json), canonical_snapshot_id=VALUES(canonical_snapshot_id),
               canonical_hash=VALUES(canonical_hash), task_hash=VALUES(task_hash),
               lifecycle_rev=VALUES(lifecycle_rev),
               control_plane_target_gate=VALUES(control_plane_target_gate),
               control_plane_gate_verified_pass=VALUES(control_plane_gate_verified_pass),
               control_plane_root_accepted=VALUES(control_plane_root_accepted)`,
            [
              boardId,
              sanitized.taskId,
              sanitized.taskClass,
              sanitized.disposition,
              receipt.receiptId,
              receipt.receiptHash,
              receipt.membershipPortfolioId ?? null,
              pins.outputBoardRev,
              pins.outputEntityRev,
              jsonParam(receipt),
              receipt.canonicalSnapshotId,
              receipt.canonicalHash,
              receipt.taskHash,
              pins.lifecycleRev,
              sanitized.controlPlaneTargetGate ?? null,
              sanitized.controlPlaneGateVerifiedPass ? 1 : 0,
              sanitized.controlPlaneRootAccepted ? 1 : 0,
            ],
          )
        }

        // Exact-set materialization: current canonical tasks are all present in
        // `records`; remove overlay orphans while immutable receipt history remains.
        const taskIds = records.map((record) => record.taskId)
        if (taskIds.length === 0) {
          throw new ControlDataPersistenceError(
            'INVALID_INPUT',
            'classification replacement refuses an empty exact set',
          )
        }
        await conn.query(
          `DELETE FROM control_plane_classification
            WHERE board_id=? AND task_id NOT IN (${taskIds.map(() => '?').join(',')})`,
          [boardId, ...taskIds],
        )

        const auditDetail = {
          eventId: pins.auditId,
          schemaVersion: 'TM_CLASSIFICATION_SYNC_SCHEMA_007_V1',
          canonicalHash: pins.canonicalHash,
          inputBoardRev: pins.expectedBoardRev,
          outputBoardRev: pins.outputBoardRev,
          lifecycleRev: pins.lifecycleRev,
          taskCount: records.length,
          receiptSetHash: pins.receiptSetHash,
        }
        const [auditRows] = await conn.query(
          `SELECT detail FROM audit_log
            WHERE board_id=?
              AND JSON_UNQUOTE(JSON_EXTRACT(detail, '$.eventId'))=?
            LIMIT 1`,
          [boardId, pins.auditId],
        )
        const existingAudit = asRows<RowDataPacket>(auditRows)[0]
        if (existingAudit) {
          const existingDetail = parseJson<Record<string, unknown>>(existingAudit.detail, {})
          if (JSON.stringify(existingDetail) !== JSON.stringify(auditDetail)) {
            throw new ControlDataPersistenceError(
              'IDEMPOTENCY_CONFLICT',
              'classification audit event rewrite is forbidden',
              { boardId, auditId: pins.auditId },
            )
          }
        } else {
          await conn.query(
            `INSERT INTO audit_log
               (board_id, ts, actor, action, task_id, from_stage, to_stage, detail)
             VALUES (?,?,?,?,?,?,?,?)`,
            [
              boardId,
              toMysqlDateTime(pins.issuedAt),
              pins.actorId,
              'CLASSIFICATION_SYNC',
              null,
              null,
              null,
              jsonParam(auditDetail),
            ],
          )
        }

        await conn.query(
          `INSERT INTO entity_revisions
             (board_id, entity_type, entity_id, entity_rev, subject_hash)
           VALUES (?, 'classification_sync', ?, ?, ?)
           ON DUPLICATE KEY UPDATE
             entity_rev=VALUES(entity_rev), subject_hash=VALUES(subject_hash)`,
          [boardId, boardId, pins.outputEntityRev, pins.canonicalHash],
        )
        const [update] = await conn.query(
          `UPDATE board_revisions SET board_rev=?
            WHERE board_id=? AND board_rev=? AND lifecycle_rev=? AND canonical_hash=?`,
          [
            pins.outputBoardRev,
            boardId,
            pins.expectedBoardRev,
            pins.lifecycleRev,
            pins.canonicalHash,
          ],
        )
        const affected = Number(
          (update as { affectedRows?: number }).affectedRows ??
            (update as { rowsAffected?: number }).rowsAffected ??
            0,
        )
        if (affected !== 1) {
          throw new ControlDataPersistenceError(
            'STALE_REVISION',
            'classification sync board revision CAS failed',
            { boardId },
          )
        }
        return {
          boardRev: pins.outputBoardRev,
          entityRev: pins.outputEntityRev,
          auditId: pins.auditId,
        }
      })
    },
  }
}

// =============================================================================
// Stage evidence receipts (immutable program-emit registry)
// =============================================================================

function mapStageEvidenceRow(r: RowDataPacket): RegisteredStageEvidence {
  const fromJson = parseJson<RegisteredStageEvidence | null>(r.receipt_json, null)
  if (fromJson && fromJson.receipt?.receiptId) {
    return {
      boardId: String(fromJson.boardId ?? r.board_id),
      taskId: String(fromJson.taskId ?? r.task_id),
      toStage: (fromJson.toStage ?? r.to_stage) as LifecycleStageKey,
      emittingRunId: String(fromJson.emittingRunId ?? r.emitting_run_id),
      registeredAt: fromJson.registeredAt ?? fromMysqlDateTime(r.registered_at) ?? new Date(0).toISOString(),
      receipt: {
        ...fromJson.receipt,
        fields: { ...(fromJson.receipt.fields ?? {}) },
      },
    }
  }
  const fields = parseJson<Record<string, unknown>>(r.fields_json, {})
  const receipt: StageReceipt = {
    receiptId: String(r.receipt_id),
    receiptHash: String(r.receipt_hash),
    programmatic: bool01(r.programmatic),
    taskHash: String(r.task_hash),
    canonicalHash: String(r.canonical_hash),
    boardRev: Number(r.board_rev),
    lifecycleRev: Number(r.lifecycle_rev),
    fields,
    authorRunId: r.author_run_id != null ? String(r.author_run_id) : null,
    verifierRunId: r.verifier_run_id != null ? String(r.verifier_run_id) : null,
    verdict: r.verdict != null ? String(r.verdict) : null,
    issuedAt: fromMysqlDateTime(r.issued_at) ?? new Date(0).toISOString(),
  }
  return {
    boardId: String(r.board_id),
    taskId: String(r.task_id),
    toStage: String(r.to_stage) as LifecycleStageKey,
    receipt,
    emittingRunId: String(r.emitting_run_id),
    registeredAt: fromMysqlDateTime(r.registered_at) ?? new Date(0).toISOString(),
  }
}

export function createMysqlStageEvidenceStore(client: ControlDataSqlClient): StageEvidenceStore {
  return {
    async getStageEvidence(boardId, receiptId) {
      const [rows] = await client.query(
        `SELECT * FROM control_plane_stage_evidence_receipts
         WHERE board_id=? AND receipt_id=? LIMIT 1`,
        [boardId, receiptId],
      )
      const r = asRows<RowDataPacket>(rows)[0]
      return r ? mapStageEvidenceRow(r) : null
    },

    async putStageEvidence(entry) {
      const existing = await this.getStageEvidence(entry.boardId, entry.receipt.receiptId)
      if (existing) {
        assertImmutableReplay({
          kind: 'control_plane_stage_evidence_receipts',
          key: `${entry.boardId}::${entry.receipt.receiptId}`,
          existingHash: existing.receipt.receiptHash,
          nextHash: entry.receipt.receiptHash,
          extra: {
            existingStage: existing.toStage,
            nextStage: entry.toStage,
          },
        })
        return
      }
      const receipt = entry.receipt
      await client.query(
        `INSERT INTO control_plane_stage_evidence_receipts (
           board_id, receipt_id, task_id, to_stage, receipt_hash, emitting_run_id,
           programmatic, task_hash, canonical_hash, board_rev, lifecycle_rev,
           author_run_id, verifier_run_id, verdict, issued_at, registered_at,
           fields_json, receipt_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          entry.boardId,
          receipt.receiptId,
          entry.taskId,
          entry.toStage,
          receipt.receiptHash,
          entry.emittingRunId,
          receipt.programmatic ? 1 : 0,
          receipt.taskHash,
          receipt.canonicalHash,
          receipt.boardRev,
          receipt.lifecycleRev,
          receipt.authorRunId ?? null,
          receipt.verifierRunId ?? null,
          receipt.verdict ?? null,
          toMysqlDateTime(receipt.issuedAt),
          toMysqlDateTime(entry.registeredAt),
          jsonParam(receipt.fields),
          jsonParam(entry),
        ],
      )
    },
  }
}

// =============================================================================
// Factories
// =============================================================================

function poolAsClient(pool: Pool): ControlDataSqlClient {
  return {
    query: (sql, params) => pool.query(sql, params) as Promise<ControlDataQueryResult>,
    async getConnection() {
      const conn = await pool.getConnection()
      return wrapPoolConnection(conn)
    },
  }
}

function wrapPoolConnection(conn: PoolConnection): ControlDataConnection {
  return {
    query: (sql, params) => conn.query(sql, params) as Promise<ControlDataQueryResult>,
    beginTransaction: () => conn.beginTransaction(),
    commit: () => conn.commit(),
    rollback: () => conn.rollback(),
    release: () => conn.release(),
  }
}

/**
 * Wire all MySQL-backed control-data stores. Does not register MCP/board wiring.
 * Default client is the shared `db()` pool when not injected.
 */
export function createMysqlControlDataPersistence(
  opts: MysqlControlDataOptions = {},
): ControlDataPersistence {
  if (opts.requireInjected && !opts.client) {
    throw new Error('createMysqlControlDataPersistence: client required when requireInjected=true')
  }
  const client = opts.client ?? poolAsClient(db())
  return {
    revisions: createMysqlRevisionStore(client),
    idempotency: createMysqlIdempotencyStorage(client),
    decisions: createMysqlDecisionV3Store(client),
    imports: createMysqlImportStorage(client),
    g5: createMysqlG5DomainStore(client),
    classification: createMysqlClassificationStore(client),
    stageEvidence: createMysqlStageEvidenceStore(client),
  }
}

// =============================================================================
// In-memory SQL-shaped backend for unit tests (no real MySQL)
// =============================================================================

type MemRow = Record<string, unknown>

interface MemTables {
  board_revisions: Map<string, MemRow>
  entity_revisions: Map<string, MemRow>
  control_plane_idempotency: Map<string, MemRow>
  control_plane_decisions: Map<string, MemRow>
  control_plane_snapshots: Map<string, MemRow>
  control_plane_imports: Map<string, MemRow>
  control_plane_import_audit: Map<string, MemRow>
  control_plane_g5: Map<string, MemRow>
  control_plane_classification: Map<string, MemRow>
  control_plane_classification_receipts: Map<string, MemRow>
  control_plane_stage_evidence_receipts: Map<string, MemRow>
  audit_log: Map<string, MemRow>
}

function emptyTables(): MemTables {
  return {
    board_revisions: new Map(),
    entity_revisions: new Map(),
    control_plane_idempotency: new Map(),
    control_plane_decisions: new Map(),
    control_plane_snapshots: new Map(),
    control_plane_imports: new Map(),
    control_plane_import_audit: new Map(),
    control_plane_g5: new Map(),
    control_plane_classification: new Map(),
    control_plane_classification_receipts: new Map(),
    control_plane_stage_evidence_receipts: new Map(),
    audit_log: new Map(),
  }
}

function normalizeSql(sql: string): string {
  return sql.replace(/\s+/g, ' ').trim()
}

/**
 * Minimal in-memory SQL engine covering statements issued by this module.
 * Sufficient for unit tests without a real MySQL process.
 *
 * Named locks are connection-scoped (GET_LOCK + RELEASE_LOCK must share connectionId).
 */
export function createMemoryControlDataSql(): ControlDataSqlClient & {
  tables: MemTables
  reset(): void
  calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }>
  heldNamedLocks: Map<string, string>
} {
  const tables = emptyTables()
  let txDepth = 0
  const snapshots: Array<MemTables | null> = []
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }> = []
  const heldNamedLocks = new Map<string, string>()
  let connSeq = 0
  const POOL_ID = 'memory-pool'

  const cloneTables = (): MemTables => {
    const out = emptyTables()
    for (const key of Object.keys(tables) as Array<keyof MemTables>) {
      out[key] = new Map([...tables[key].entries()].map(([k, v]) => [k, { ...v }]))
    }
    return out
  }

  const restoreTables = (snap: MemTables) => {
    for (const key of Object.keys(tables) as Array<keyof MemTables>) {
      tables[key].clear()
      for (const [k, v] of snap[key]) tables[key].set(k, { ...v })
    }
  }

  const run = async (
    sql: string,
    params: Array<unknown> = [],
    connectionId: string = POOL_ID,
  ): Promise<ControlDataQueryResult> => {
    const s = normalizeSql(sql)
    const p = params
    calls.push({ sql, params: p, connectionId })

    // Named locks — connection-scoped (must acquire+release on same connectionId)
    if (/^SELECT GET_LOCK/i.test(s)) {
      const lockName = String(p[0] ?? '')
      const holder = heldNamedLocks.get(lockName)
      if (holder && holder !== connectionId) {
        return [[{ l: 0 }], []]
      }
      heldNamedLocks.set(lockName, connectionId)
      return [[{ l: 1 }], []]
    }
    if (/^SELECT RELEASE_LOCK/i.test(s)) {
      const lockName = String(p[0] ?? '')
      const holder = heldNamedLocks.get(lockName)
      if (!holder) {
        return [[{ r: 0 }], []]
      }
      if (holder !== connectionId) {
        // Wrong connection cannot release — proves pin requirement.
        return [[{ r: 0 }], []]
      }
      heldNamedLocks.delete(lockName)
      return [[{ r: 1 }], []]
    }

    // ---- board_revisions ----
    if (/^SELECT board_rev, subject_hash FROM board_revisions/i.test(s)) {
      const row = tables.board_revisions.get(String(p[0]))
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/FROM board_revisions WHERE board_id=\? (FOR UPDATE|LIMIT 1)/i.test(s) ||
        /FROM board_revisions WHERE board_id=\? LIMIT 1/i.test(s) ||
        /FROM board_revisions WHERE board_id=\? FOR UPDATE/i.test(s)) {
      const row = tables.board_revisions.get(String(p[0]))
      return [row ? [{ board_id: p[0], ...row } as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO board_revisions \(board_id, board_rev, lifecycle_rev, subject_hash\)/i.test(s)) {
      const boardId = String(p[0])
      const existing = tables.board_revisions.get(boardId)
      // Two call shapes from RevisionStore:
      // 1) first write missing board: VALUES (?, 0, 0, NULL) — 1 param
      // 2) CAS update: VALUES (?, ?, 0, ?) ON DUPLICATE — params [id, boardRev, subjectHash]
      if (/ON DUPLICATE KEY UPDATE/i.test(s)) {
        tables.board_revisions.set(boardId, {
          ...(existing ?? { lifecycle_rev: 0, import_entity_rev: 0 }),
          board_id: boardId,
          board_rev: p[1],
          // Preserve lifecycle_rev (SQL ON DUPLICATE does not touch it).
          lifecycle_rev: existing?.lifecycle_rev ?? 0,
          subject_hash: p[2] ?? null,
        })
      } else if (!existing) {
        tables.board_revisions.set(boardId, {
          board_id: boardId,
          board_rev: p.length > 1 ? (p[1] ?? 0) : 0,
          lifecycle_rev: p.length > 2 ? (p[2] ?? 0) : 0,
          subject_hash: p.length > 3 ? (p[3] ?? null) : null,
          import_entity_rev: 0,
        })
      }
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/^INSERT INTO board_revisions \(\s*board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id/i.test(s)) {
      const boardId = String(p[0])
      tables.board_revisions.set(boardId, {
        board_id: boardId,
        board_rev: p[1],
        lifecycle_rev: p[2],
        subject_hash: p[3],
        canonical_snapshot_id: p[4],
        canonical_hash: p[5],
        last_snapshot_id: p[6],
        last_snapshot_generated_at: p[7],
        last_payload_sha256: p[8],
        import_entity_rev: p[9],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/^UPDATE board_revisions SET board_rev=\? WHERE board_id=\?/i.test(s)) {
      const boardId = String(p[1])
      const row = tables.board_revisions.get(boardId)
      const matches =
        row &&
        Number(row.board_rev ?? 0) === Number(p[2]) &&
        Number(row.lifecycle_rev ?? 0) === Number(p[3]) &&
        String(row.canonical_hash ?? '') === String(p[4] ?? '')
      if (matches) {
        tables.board_revisions.set(boardId, { ...row, board_rev: p[0] })
      }
      return [{ affectedRows: matches ? 1 : 0 } as ResultSetHeader, []]
    }

    // ---- entity_revisions ----
    if (/^SELECT entity_rev FROM entity_revisions/i.test(s) && /entity_type='classification_sync'/i.test(s)) {
      const key = `${p[0]}::classification_sync::${p[1]}`
      const row = tables.entity_revisions.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO entity_revisions/i.test(s) && /'classification_sync'/i.test(s)) {
      const key = `${p[0]}::classification_sync::${p[1]}`
      tables.entity_revisions.set(key, {
        board_id: p[0],
        entity_type: 'classification_sync',
        entity_id: p[1],
        entity_rev: p[2],
        subject_hash: p[3],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/FROM entity_revisions/i.test(s) && /^SELECT/i.test(s)) {
      const key = `${p[0]}::${p[1]}::${p[2]}`
      const row = tables.entity_revisions.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO entity_revisions/i.test(s)) {
      const key = `${p[0]}::${p[1]}::${p[2]}`
      tables.entity_revisions.set(key, {
        board_id: p[0],
        entity_type: p[1],
        entity_id: p[2],
        entity_rev: p[3],
        subject_hash: p[4],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- idempotency ----
    if (/FROM control_plane_idempotency WHERE scope_hash=\?/i.test(s)) {
      const row = tables.control_plane_idempotency.get(String(p[0]))
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/FROM control_plane_idempotency WHERE board_id=\? AND run_id=\?/i.test(s)) {
      for (const row of tables.control_plane_idempotency.values()) {
        if (row.board_id === p[0] && row.run_id === p[1]) {
          return [[row as RowDataPacket], []]
        }
      }
      return [[], []]
    }
    if (/^INSERT INTO control_plane_idempotency/i.test(s)) {
      const scopeHash = String(p[0])
      if (tables.control_plane_idempotency.has(scopeHash)) {
        const err = new Error('Duplicate entry') as Error & { errno: number; code: string }
        err.errno = 1062
        err.code = 'ER_DUP_ENTRY'
        throw err
      }
      if (p[8] != null) {
        for (const row of tables.control_plane_idempotency.values()) {
          if (row.board_id === p[2] && row.run_id === p[8]) {
            const err = new Error('Duplicate entry') as Error & { errno: number; code: string }
            err.errno = 1062
            err.code = 'ER_DUP_ENTRY'
            throw err
          }
        }
      }
      tables.control_plane_idempotency.set(scopeHash, {
        scope_hash: p[0],
        actor_id: p[1],
        board_id: p[2],
        endpoint: p[3],
        idempotency_key: p[4],
        request_hash: p[5],
        response_status: p[6],
        response_body_json: p[7] == null ? null : parseJson(p[7], null),
        run_id: p[8],
        created_at: p[9],
        expires_at: p[10],
        in_progress: p[11],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/^UPDATE control_plane_idempotency/i.test(s)) {
      const row = tables.control_plane_idempotency.get(String(p[4]))
      if (row) {
        row.response_status = p[0]
        row.response_body_json = p[1] == null ? null : parseJson(p[1], null)
        row.request_hash = p[2]
        row.in_progress = p[3]
      }
      return [{ affectedRows: row ? 1 : 0 } as ResultSetHeader, []]
    }
    if (/^DELETE FROM control_plane_idempotency/i.test(s)) {
      tables.control_plane_idempotency.delete(String(p[0]))
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- decisions ----
    if (/FROM control_plane_decisions WHERE board_id=\? AND decision_id=\?/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_decisions.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/FROM control_plane_decisions WHERE board_id=\?$/i.test(s)) {
      const out: Array<RowDataPacket> = []
      for (const row of tables.control_plane_decisions.values()) {
        if (row.board_id === p[0]) out.push(row as RowDataPacket)
      }
      return [out, []]
    }
    if (/^INSERT INTO control_plane_decisions/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      tables.control_plane_decisions.set(key, {
        board_id: p[0],
        decision_id: p[1],
        project_id: p[2],
        feature_id: p[3],
        task_id: p[4],
        run_id: p[5],
        type: p[6],
        severity: p[7],
        title: p[8],
        question: p[9],
        evidence_json: parseJson(p[10], []),
        options_json: parseJson(p[11], []),
        agent_recommendation: p[12],
        blocking: p[13],
        due_at: p[14],
        due_at_ms: p[15],
        created_at: p[16],
        created_at_ms: p[17],
        snoozed_until: p[18],
        snoozed_until_ms: p[19],
        status: p[20],
        owner_id: p[21],
        resolver_id: p[22],
        selected_option_id: p[23],
        comment: p[24],
        expected_rev: p[25],
        board_rev: p[26],
        entity_rev: p[27],
        scoped_approval_id: p[28],
        audit_ids_json: parseJson(p[29], []),
        expires_at: p[30],
        expires_at_ms: p[31],
        record_json: parseJson(p[32], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- snapshots / imports ----
    if (
      /FROM control_plane_snapshots/i.test(s) &&
      /^SELECT/i.test(s) &&
      /snapshot_id=\?/i.test(s)
    ) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_snapshots.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO control_plane_snapshots/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const existing = tables.control_plane_snapshots.get(key)
      if (existing && /ON DUPLICATE KEY UPDATE/i.test(s)) {
        // Legacy LWW path must not silently rewrite different hashes in tests.
        // Real adapters no longer emit ON DUPLICATE for snapshots.
        tables.control_plane_snapshots.set(key, {
          ...existing,
          payload_sha256: p[5],
          board_rev: p[6],
          payload_json: parseJson(p[10], null),
        })
        return [{ affectedRows: 2 } as ResultSetHeader, []]
      }
      if (existing) {
        // Pure INSERT duplicate: refuse overwrite (mirrors unique PK).
        return [{ affectedRows: 0 } as ResultSetHeader, []]
      }
      tables.control_plane_snapshots.set(key, {
        board_id: p[0],
        snapshot_id: p[1],
        schema_version: p[2],
        source_repo_id: p[3],
        source_commit_sha: p[4],
        payload_sha256: p[5],
        board_rev: p[6],
        lifecycle_rev: p[7],
        generated_at: p[8],
        producer_version: p[9],
        payload_json: parseJson(p[10], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (
      /FROM control_plane_imports/i.test(s) &&
      /^SELECT/i.test(s) &&
      /import_id=\?/i.test(s)
    ) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_imports.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO control_plane_imports/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const existing = tables.control_plane_imports.get(key)
      if (existing && /ON DUPLICATE KEY UPDATE/i.test(s)) {
        tables.control_plane_imports.set(key, {
          ...existing,
          status: p[3],
          payload_sha256: p[7],
        })
        return [{ affectedRows: 2 } as ResultSetHeader, []]
      }
      if (existing) {
        return [{ affectedRows: 0 } as ResultSetHeader, []]
      }
      tables.control_plane_imports.set(key, {
        board_id: p[0],
        import_id: p[1],
        snapshot_id: p[2],
        status: p[3],
        actor_id: p[4],
        request_hash: p[5],
        dry_run: p[6],
        payload_sha256: p[7],
        canonical_hash: p[8],
        board_rev: p[9],
        lifecycle_rev: p[10],
        entity_rev: p[11],
        provenance_json: parseJson(p[12], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- import audit (immutable material) ----
    if (
      /FROM control_plane_import_audit/i.test(s) &&
      /^SELECT/i.test(s) &&
      /audit_id=\?/i.test(s)
    ) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_import_audit.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (
      /FROM control_plane_import_audit WHERE board_id=\?/i.test(s) &&
      /^SELECT/i.test(s) &&
      !/audit_id=\?/i.test(s)
    ) {
      const out: Array<RowDataPacket> = []
      for (const row of tables.control_plane_import_audit.values()) {
        if (row.board_id === p[0]) out.push(row as RowDataPacket)
      }
      out.sort((a, b) => {
        const ca = String(a.captured_at ?? '')
        const cb = String(b.captured_at ?? '')
        if (ca !== cb) return ca < cb ? -1 : 1
        return String(a.audit_id ?? '').localeCompare(String(b.audit_id ?? ''))
      })
      return [out, []]
    }
    if (/^INSERT INTO control_plane_import_audit/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const existing = tables.control_plane_import_audit.get(key)
      if (existing) {
        // Insert-once: memory engine does not rewrite (adapter must conflict before insert).
        return [{ affectedRows: 0 } as ResultSetHeader, []]
      }
      tables.control_plane_import_audit.set(key, {
        board_id: p[0],
        audit_id: p[1],
        import_id: p[2],
        snapshot_id: p[3],
        event: p[4],
        actor_id: p[5],
        payload_sha256: p[6],
        canonical_hash: p[7],
        board_rev: p[8],
        lifecycle_rev: p[9],
        entity_rev: p[10],
        content_hash: p[11],
        captured_at: p[12],
        payload_json: parseJson(p[13], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- g5 ----
    if (/FROM control_plane_g5 WHERE board_id=\? AND domain=\?/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_g5.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/FROM control_plane_g5 WHERE board_id=\?$/i.test(s)) {
      const out: Array<RowDataPacket> = []
      for (const row of tables.control_plane_g5.values()) {
        if (row.board_id === p[0]) out.push(row as RowDataPacket)
      }
      return [out, []]
    }
    if (/^INSERT INTO control_plane_g5/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      tables.control_plane_g5.set(key, {
        board_id: p[0],
        domain: p[1],
        status: p[2],
        required: p[3],
        evidence_id: p[4],
        subject_hash: p[5],
        board_rev: p[6],
        lifecycle_rev: p[7],
        scope: p[8],
        evidence_ids_json: parseJson(p[9], []),
        evidence_hashes_json: parseJson(p[10], []),
        verifier_agent: p[11],
        verifier_model: p[12],
        verifier_run_id: p[13],
        author_run_id: p[14],
        subject_revision: p[15],
        expected_rev: p[16],
        findings: p[17],
        blocker: p[18],
        captured_at: p[19],
        programmatic_evidence: p[20],
        independent_verifier: p[21],
        record_json: parseJson(p[22], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    // ---- classification ----
    if (/FROM control_plane_classification WHERE board_id=\? AND task_id=\?/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_classification.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/FROM control_plane_classification WHERE board_id=\?$/i.test(s)) {
      const out: Array<RowDataPacket> = []
      for (const row of tables.control_plane_classification.values()) {
        if (row.board_id === p[0]) out.push(row as RowDataPacket)
      }
      return [out, []]
    }
    if (/^INSERT INTO control_plane_classification \(/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      tables.control_plane_classification.set(key, {
        board_id: p[0],
        task_id: p[1],
        task_class: p[2],
        disposition: p[3],
        classification_receipt_id: p[4],
        classification_receipt_hash: p[5],
        proof_source: p[6],
        board_rev: p[7],
        entity_rev: p[8],
        receipt_json: parseJson(p[9], null),
        canonical_snapshot_id: p[10],
        canonical_hash: p[11],
        task_hash: p[12],
        lifecycle_rev: p[13],
        control_plane_target_gate: p[14],
        control_plane_gate_verified_pass: p[15],
        control_plane_root_accepted: p[16],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/^DELETE FROM control_plane_classification WHERE board_id=\? AND task_id NOT IN/i.test(s)) {
      const boardId = String(p[0])
      const keep = new Set(p.slice(1).map(String))
      let affectedRows = 0
      for (const [key, row] of tables.control_plane_classification) {
        if (String(row.board_id) === boardId && !keep.has(String(row.task_id))) {
          tables.control_plane_classification.delete(key)
          affectedRows += 1
        }
      }
      return [{ affectedRows } as ResultSetHeader, []]
    }
    if (/FROM control_plane_classification_receipts/i.test(s) && /^SELECT/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_classification_receipts.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO control_plane_classification_receipts/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const existing = tables.control_plane_classification_receipts.get(key)
      if (existing && /ON DUPLICATE KEY UPDATE/i.test(s)) {
        // Legacy LWW — adapters must not emit this path for receipts.
        tables.control_plane_classification_receipts.set(key, {
          ...existing,
          receipt_hash: p[3],
          receipt_json: parseJson(p[15], null),
        })
        return [{ affectedRows: 2 } as ResultSetHeader, []]
      }
      if (existing) {
        return [{ affectedRows: 0 } as ResultSetHeader, []]
      }
      tables.control_plane_classification_receipts.set(key, {
        board_id: p[0],
        receipt_id: p[1],
        task_id: p[2],
        receipt_hash: p[3],
        task_class: p[4],
        disposition: p[5],
        membership_portfolio_id: p[6],
        membership_proof_hash: p[7],
        canonical_snapshot_id: p[8],
        canonical_hash: p[9],
        task_hash: p[10],
        board_rev: p[11],
        lifecycle_rev: p[12],
        issued_at: p[13],
        expires_at: p[14],
        receipt_json: parseJson(p[15], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/^SELECT detail FROM audit_log/i.test(s)) {
      for (const row of tables.audit_log.values()) {
        const detail = parseJson<Record<string, unknown>>(row.detail, {})
        if (row.board_id === p[0] && detail.eventId === p[1]) {
          return [[{ detail: row.detail } as RowDataPacket], []]
        }
      }
      return [[], []]
    }
    if (/^INSERT INTO audit_log/i.test(s)) {
      const detail = parseJson<Record<string, unknown>>(p[7], {})
      const key = `${p[0]}::${String(detail.eventId ?? tables.audit_log.size + 1)}`
      tables.audit_log.set(key, {
        id: tables.audit_log.size + 1,
        board_id: p[0],
        ts: p[1],
        actor: p[2],
        action: p[3],
        task_id: p[4],
        from_stage: p[5],
        to_stage: p[6],
        detail: p[7],
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }
    if (/FROM control_plane_stage_evidence_receipts/i.test(s) && /^SELECT/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const row = tables.control_plane_stage_evidence_receipts.get(key)
      return [row ? [row as RowDataPacket] : [], []]
    }
    if (/^INSERT INTO control_plane_stage_evidence_receipts/i.test(s)) {
      const key = `${p[0]}::${p[1]}`
      const existing = tables.control_plane_stage_evidence_receipts.get(key)
      if (existing) {
        return [{ affectedRows: 0 } as ResultSetHeader, []]
      }
      tables.control_plane_stage_evidence_receipts.set(key, {
        board_id: p[0],
        receipt_id: p[1],
        task_id: p[2],
        to_stage: p[3],
        receipt_hash: p[4],
        emitting_run_id: p[5],
        programmatic: p[6],
        task_hash: p[7],
        canonical_hash: p[8],
        board_rev: p[9],
        lifecycle_rev: p[10],
        author_run_id: p[11],
        verifier_run_id: p[12],
        verdict: p[13],
        issued_at: p[14],
        registered_at: p[15],
        fields_json: parseJson(p[16], {}),
        receipt_json: parseJson(p[17], null),
      })
      return [{ affectedRows: 1 } as ResultSetHeader, []]
    }

    throw new Error(`createMemoryControlDataSql: unsupported SQL: ${s.slice(0, 160)}`)
  }

  const client: ControlDataSqlClient & {
    tables: MemTables
    reset(): void
    calls: Array<{ sql: string; params: ReadonlyArray<unknown>; connectionId: string }>
    heldNamedLocks: Map<string, string>
  } = {
    tables,
    calls,
    heldNamedLocks,
    reset() {
      for (const key of Object.keys(tables) as Array<keyof MemTables>) tables[key].clear()
      txDepth = 0
      snapshots.length = 0
      calls.length = 0
      heldNamedLocks.clear()
      connSeq = 0
    },
    query: (sql, params) => run(sql, params, POOL_ID),
    async getConnection() {
      const connectionId = `memory-conn-${++connSeq}`
      let released = false
      return {
        query: (sql, params) => run(sql, params, connectionId),
        async beginTransaction() {
          snapshots.push(cloneTables())
          txDepth += 1
        },
        async commit() {
          if (txDepth > 0) {
            txDepth -= 1
            snapshots.pop()
          }
        },
        async rollback() {
          if (txDepth > 0) {
            txDepth -= 1
            const snap = snapshots.pop()
            if (snap) restoreTables(snap)
          }
        },
        release() {
          released = true
          void released
        },
        // Expose for pin tests (not on ControlDataConnection type).
        connectionId,
      } as ControlDataConnection & { connectionId: string }
    },
  }
  return client
}

/** Convenience: MySQL adapters backed by the in-memory SQL engine (unit tests). */
export function createMemoryBackedControlDataPersistence(): ControlDataPersistence & {
  sql: ReturnType<typeof createMemoryControlDataSql>
} {
  const sql = createMemoryControlDataSql()
  const p = createMysqlControlDataPersistence({ client: sql, requireInjected: true })
  return { ...p, sql }
}

/** Seed a board revision row (test helper). */
export async function seedBoardRevision(
  client: ControlDataSqlClient,
  state: {
    boardId: string
    boardRev?: number
    lifecycleRev?: number
    subjectHash?: string | null
    canonicalSnapshotId?: string | null
    canonicalHash?: string | null
    importEntityRev?: number
  },
): Promise<void> {
  await client.query(
    `INSERT INTO board_revisions (
       board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id,
       canonical_hash, last_snapshot_id, last_snapshot_generated_at,
       last_payload_sha256, import_entity_rev
     ) VALUES (?,?,?,?,?,?,?,?,?,?)
     ON DUPLICATE KEY UPDATE
       board_rev=VALUES(board_rev),
       subject_hash=VALUES(subject_hash),
       canonical_snapshot_id=VALUES(canonical_snapshot_id),
       canonical_hash=VALUES(canonical_hash),
       last_snapshot_id=VALUES(last_snapshot_id),
       last_snapshot_generated_at=VALUES(last_snapshot_generated_at),
       last_payload_sha256=VALUES(last_payload_sha256),
       import_entity_rev=VALUES(import_entity_rev)`,
    [
      state.boardId,
      state.boardRev ?? 0,
      state.lifecycleRev ?? 0,
      state.subjectHash ?? null,
      state.canonicalSnapshotId ?? null,
      state.canonicalHash ?? null,
      state.canonicalSnapshotId ?? null,
      null,
      null,
      state.importEntityRev ?? 0,
    ],
  )
}

export function newDecisionId(): string {
  return `dec-${randomUUID()}`
}

// Re-export types used by consumers
export type { CanonicalSnapshot, ImportBoardState, RevisionState, CasResult }
