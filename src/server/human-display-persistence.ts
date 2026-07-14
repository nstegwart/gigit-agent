/**
 * Human-display persistence foundation (TM_HUMAN_DISPLAY_PERSISTENCE_V1).
 *
 * Consumes pure contract from human-display.ts. Durable board/entity-scoped
 * storage for versioned HumanDisplayV1 with CAS revisions, sourceHash binding,
 * REVIEWED immutability per content_version, fail-closed CONTENT_REVIEW_REQUIRED
 * on missing/stale reads, and insert-once audit receipts (exact-replay idempotent).
 *
 * Never invents PRODUCT. No board-mcp / UI / DB apply wiring.
 */
import { createHash } from 'node:crypto'

import {
  DEFAULT_HUMAN_LOCALE,
  HUMAN_DISPLAY_SCHEMA_VERSION,
  evaluateHumanDisplay,
  normalizeTaskClass,
  resolveOwnerHumanDisplay,
  type HumanDisplayEntityKind,
  type HumanDisplayEvaluation,
  type HumanDisplayLivePin,
  type HumanDisplayReviewStatus,
  type HumanDisplayV1,
} from '#/server/human-display'

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const HUMAN_DISPLAY_PERSISTENCE_MIGRATION_FILE =
  'migrations/004_control_data_persistence.sql' as const

export const HUMAN_DISPLAY_PERSISTENCE_SCHEMA_STEP =
  'TM_HUMAN_DISPLAY_PERSISTENCE_V1' as const

export const HUMAN_DISPLAY_TABLE = 'control_plane_human_display' as const
export const HUMAN_DISPLAY_AUDIT_TABLE =
  'control_plane_human_display_audit' as const

export const HUMAN_DISPLAY_PERSISTENCE_TABLES = [
  HUMAN_DISPLAY_TABLE,
  HUMAN_DISPLAY_AUDIT_TABLE,
] as const

// ---------------------------------------------------------------------------
// Errors
// ---------------------------------------------------------------------------

export type HumanDisplayPersistenceErrorCode =
  | 'STALE_REVISION'
  | 'SOURCE_HASH_MISMATCH'
  | 'REVIEWED_IMMUTABLE'
  | 'IDEMPOTENCY_CONFLICT'
  | 'INVALID_INPUT'
  | 'DATA_INTEGRITY'
  | 'CONTENT_REVIEW_REQUIRED'
  | 'TAMPER_DETECTED'
  | 'INDEPENDENT_REVIEW_REQUIRED'

export class HumanDisplayPersistenceError extends Error {
  readonly code: HumanDisplayPersistenceErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: HumanDisplayPersistenceErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'HumanDisplayPersistenceError'
    this.code = code
    this.details = details
  }
}

// ---------------------------------------------------------------------------
// Domain types
// ---------------------------------------------------------------------------

export interface HumanDisplayRecord {
  boardId: string
  entityKind: HumanDisplayEntityKind
  entityId: string
  contentVersion: number
  locale: string
  reviewStatus: HumanDisplayReviewStatus
  sourceHash: string
  reviewedAt: string | null
  content: HumanDisplayV1
  entityRev: number
  boardRev: number
  schemaVersion: string
  /** SHA-256 of canonical content payload (idempotency / tamper). */
  contentHash: string
  createdAt?: string | null
  updatedAt?: string | null
}

export interface HumanDisplayAuditRecord {
  boardId: string
  auditId: string
  entityKind: HumanDisplayEntityKind
  entityId: string
  contentVersion: number
  event: string
  actorId: string | null
  sourceHash: string
  contentHash: string
  reviewStatus: HumanDisplayReviewStatus
  entityRev: number | null
  boardRev: number | null
  capturedAt: string
  payload: Record<string, unknown>
}

export interface HumanDisplayPutRequest {
  boardId: string
  display: HumanDisplayV1
  /**
   * Expected current entity_rev (0 when no row exists).
   * Mismatch → STALE_REVISION (no LWW).
   */
  expectedEntityRev: number
  /**
   * Expected current board_rev pin on the stored row (0 when no row).
   * Mismatch → STALE_REVISION.
   */
  expectedBoardRev: number
  /**
   * Live/current source hash. Must equal display.sourceHash.
   * Mismatch → SOURCE_HASH_MISMATCH (stale binding rejected).
   */
  expectedSourceHash: string
  actorId?: string | null
  /** Principal role string for independent-review trail (audit payload). */
  actorRole?: string | null
  /** Optional stable audit id; derived from content hash when omitted. */
  auditId?: string | null
  /** Optional capture time (ISO). */
  now?: string | null
}

/**
 * Prior author trail for independent review (from audit or caller).
 */
export interface HumanDisplayAuthorTrail {
  actorId: string | null
  role: string | null
}

/**
 * MCP authoring/review transition policy (ART: different role independently reviews
 * before reviewStatus=REVIEWED). Authoring writes may only set GENERATED_NEEDS_REVIEW
 * (or non-REVIEWED fail-closed statuses). REVIEWED requires a separate call by a
 * different actor and different role than the prior author.
 *
 * assertHumanDisplayWritable only checks structural completeness — not this rule.
 */
export function assertHumanDisplayWriteTransition(opts: {
  display: HumanDisplayV1
  existing: HumanDisplayRecord | null
  actorId: string
  actorRole: string
  previousAuthor: HumanDisplayAuthorTrail | null
}): void {
  const status = opts.display.reviewStatus
  if (status === 'GENERATED_NEEDS_REVIEW') {
    return
  }
  if (
    status === 'BLOCKED_MISSING_SOURCE' ||
    status === 'CONFLICT' ||
    status === 'CONTENT_REVIEW_REQUIRED'
  ) {
    // Fail-closed authoring states (not owner-primary REVIEWED).
    return
  }
  if (status !== 'REVIEWED') {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      `unsupported reviewStatus for write: ${String(status)}`,
      { reviewStatus: status },
    )
  }

  // REVIEWED: independent review path only (never first insert as REVIEWED).
  if (!opts.existing) {
    throw new HumanDisplayPersistenceError(
      'INDEPENDENT_REVIEW_REQUIRED',
      'REVIEWED requires a prior authored humanDisplay row; author with GENERATED_NEEDS_REVIEW first',
      { entityKind: opts.display.entityKind, entityId: opts.display.entityId },
    )
  }
  const prevActor = opts.previousAuthor?.actorId?.trim() || null
  const prevRole = opts.previousAuthor?.role?.trim() || null
  if (!prevActor) {
    throw new HumanDisplayPersistenceError(
      'INDEPENDENT_REVIEW_REQUIRED',
      'REVIEWED requires prior author actor trail for independent review',
      { entityKind: opts.display.entityKind, entityId: opts.display.entityId },
    )
  }
  if (prevActor === opts.actorId) {
    throw new HumanDisplayPersistenceError(
      'INDEPENDENT_REVIEW_REQUIRED',
      'independent review required: reviewer actor must differ from author',
      {
        authorActorId: prevActor,
        reviewerActorId: opts.actorId,
      },
    )
  }
  if (prevRole && prevRole === opts.actorRole) {
    throw new HumanDisplayPersistenceError(
      'INDEPENDENT_REVIEW_REQUIRED',
      'independent review required: reviewer role must differ from author role (ART)',
      {
        authorRole: prevRole,
        reviewerRole: opts.actorRole,
      },
    )
  }
}

/**
 * Resolve the most recent non-REVIEWED author trail for an entity from audit rows.
 * Used by MCP upsert_human_display before allowing REVIEWED.
 */
export function resolveHumanDisplayPreviousAuthor(
  audits: ReadonlyArray<HumanDisplayAuditRecord>,
  entityKind: string,
  entityId: string,
): HumanDisplayAuthorTrail | null {
  const relevant = audits
    .filter(
      (a) =>
        a.entityKind === entityKind &&
        a.entityId === entityId &&
        a.reviewStatus !== 'REVIEWED' &&
        (a.event === 'HUMAN_DISPLAY_PUT_INSERT' ||
          a.event === 'HUMAN_DISPLAY_PUT_UPDATE' ||
          a.event === 'HUMAN_DISPLAY_PUT_REPLAY'),
    )
    .slice()
    .sort((a, b) => {
      const t = b.capturedAt.localeCompare(a.capturedAt)
      if (t !== 0) return t
      return b.auditId.localeCompare(a.auditId)
    })
  const last = relevant[0]
  if (!last) return null
  const roleRaw = last.payload?.actorRole
  const role =
    typeof roleRaw === 'string' && roleRaw.trim() ? roleRaw.trim() : null
  return {
    actorId: last.actorId ?? null,
    role,
  }
}

export type HumanDisplayPutResult =
  | {
      ok: true
      record: HumanDisplayRecord
      replayed: boolean
      auditId: string
    }
  | {
      ok: false
      code: HumanDisplayPersistenceErrorCode
      message: string
      current: HumanDisplayRecord | null
      details: Readonly<Record<string, unknown>>
    }

export interface HumanDisplayGetResult {
  record: HumanDisplayRecord | null
  evaluation: HumanDisplayEvaluation
  /** Owner-primary payload only when REVIEWED + fresh. */
  primary: HumanDisplayV1 | null
  blockedShell: HumanDisplayV1
  effectiveReviewStatus: HumanDisplayReviewStatus
  /** True when missing or fail-closed demotion applies. */
  contentReviewRequired: boolean
}

export interface HumanDisplayListOptions {
  entityKind?: HumanDisplayEntityKind
  entityId?: string
}

export interface HumanDisplayStore {
  list(
    boardId: string,
    opts?: HumanDisplayListOptions,
  ): Promise<Array<HumanDisplayRecord>>
  get(
    boardId: string,
    entityKind: HumanDisplayEntityKind,
    entityId: string,
    live?: HumanDisplayLivePin | null,
  ): Promise<HumanDisplayGetResult>
  put(req: HumanDisplayPutRequest): Promise<HumanDisplayPutResult>
  listAudit(boardId: string): Promise<Array<HumanDisplayAuditRecord>>
  getAudit(
    boardId: string,
    auditId: string,
  ): Promise<HumanDisplayAuditRecord | null>
}

// ---------------------------------------------------------------------------
// SQL client (mysql2-compatible subset)
// ---------------------------------------------------------------------------

export interface HumanDisplaySqlExecuteResult<T = Record<string, unknown>> {
  rows: Array<T>
  affectedRows: number
}

export interface HumanDisplaySqlExecutor {
  execute<T = Record<string, unknown>>(
    sql: string,
    params?: ReadonlyArray<unknown>,
  ): Promise<HumanDisplaySqlExecuteResult<T>>
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value)
  }
  if (Array.isArray(value)) {
    return `[${value.map((v) => stableStringify(v)).join(',')}]`
  }
  const obj = value as Record<string, unknown>
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(obj[k])}`).join(',')}}`
}

/**
 * Canonical content hash for exact-replay / tamper detection.
 * Binds ALL material copy + ART binding + pin + link fields (not entity_rev / timestamps).
 */
export function computeHumanDisplayContentHash(display: HumanDisplayV1): string {
  const material = {
    schemaVersion: display.schemaVersion,
    locale: display.locale,
    title: display.title,
    outcome: display.outcome,
    why: display.why,
    current: display.current,
    remaining: display.remaining,
    next: display.next,
    doneWhen: display.doneWhen,
    blocker: display.blocker,
    ownerAction: display.ownerAction,
    reviewStatus: display.reviewStatus,
    sourceHash: display.sourceHash,
    reviewedAt: display.reviewedAt ?? null,
    contentVersion: display.contentVersion,
    entityKind: display.entityKind,
    entityId: display.entityId,
    parentFeatureTitle: display.parentFeatureTitle ?? null,
    businessArea: display.businessArea ?? null,
    actor: display.actor ?? null,
    snapshotId: display.snapshotId ?? null,
    boardRev: display.boardRev ?? null,
    lifecycleRev: display.lifecycleRev ?? null,
    canonicalHash: display.canonicalHash ?? null,
    citations: display.citations ?? null,
    acceptanceLinks: display.acceptanceLinks ?? null,
    missionQuestionLinks: display.missionQuestionLinks ?? null,
  }
  return createHash('sha256').update(stableStringify(material)).digest('hex')
}

function asNumber(v: unknown, fallback = 0): number {
  if (typeof v === 'number' && Number.isFinite(v)) return v
  if (typeof v === 'bigint') return Number(v)
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) {
    return Number(v)
  }
  return fallback
}

function asString(v: unknown, fallback = ''): string {
  if (v == null) return fallback
  return String(v)
}

function asOptionalString(v: unknown): string | null {
  if (v == null) return null
  const s = String(v).trim()
  return s.length > 0 ? s : null
}

export function parseJsonCell(value: unknown): unknown {
  if (value == null) return null
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(value)) {
    try {
      return JSON.parse(value.toString('utf8'))
    } catch {
      return null
    }
  }
  if (typeof value === 'string') {
    const t = value.trim()
    if (!t || t === 'null') return null
    try {
      return JSON.parse(t)
    } catch {
      return null
    }
  }
  return value
}

export function jsonParam(value: unknown): string {
  return JSON.stringify(value ?? null)
}

function toMysqlDateTime(iso: string | null | undefined): string | null {
  if (!iso) return null
  const ms = Date.parse(iso)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString().replace('T', ' ').replace('Z', '')
}

function fromMysqlDateTime(value: unknown): string | null {
  if (value == null) return null
  if (value instanceof Date) return value.toISOString()
  const s = String(value)
  if (!s) return null
  const normalized = s.includes('T') ? s : s.replace(' ', 'T')
  const withZ = /Z$|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}Z`
  const ms = Date.parse(withZ)
  if (Number.isNaN(ms)) return null
  return new Date(ms).toISOString()
}

function isEntityKind(v: unknown): v is HumanDisplayEntityKind {
  return v === 'task' || v === 'project' || v === 'feature'
}

function isReviewStatus(v: unknown): v is HumanDisplayReviewStatus {
  return (
    v === 'REVIEWED' ||
    v === 'GENERATED_NEEDS_REVIEW' ||
    v === 'BLOCKED_MISSING_SOURCE' ||
    v === 'CONFLICT' ||
    v === 'CONTENT_REVIEW_REQUIRED'
  )
}

/**
 * Fail-closed structural validation before durable write.
 * Never invents PRODUCT — only rejects invalid / incomplete payloads.
 */
export function assertHumanDisplayWritable(display: HumanDisplayV1): void {
  if (!display || typeof display !== 'object') {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'humanDisplay payload required',
    )
  }
  if (display.schemaVersion !== HUMAN_DISPLAY_SCHEMA_VERSION) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      `invalid schemaVersion: ${String(display.schemaVersion)}`,
      { schemaVersion: display.schemaVersion },
    )
  }
  if (!isEntityKind(display.entityKind)) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      `invalid entityKind: ${String(display.entityKind)}`,
    )
  }
  if (!display.entityId || !String(display.entityId).trim()) {
    throw new HumanDisplayPersistenceError('INVALID_INPUT', 'entityId required')
  }
  if (!isReviewStatus(display.reviewStatus)) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      `invalid reviewStatus: ${String(display.reviewStatus)}`,
    )
  }
  if (!display.sourceHash || !String(display.sourceHash).trim()) {
    throw new HumanDisplayPersistenceError('INVALID_INPUT', 'sourceHash required')
  }
  if (
    typeof display.contentVersion !== 'number' ||
    !Number.isFinite(display.contentVersion) ||
    display.contentVersion < 1
  ) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'contentVersion must be a positive number',
      { contentVersion: display.contentVersion },
    )
  }
  if (display.reviewStatus === 'REVIEWED') {
    if (!display.reviewedAt || !String(display.reviewedAt).trim()) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires reviewedAt',
      )
    }
    // REVIEWED requires full ART bindings + pin + link projections (fail-closed).
    for (const field of [
      'parentFeatureTitle',
      'businessArea',
      'actor',
    ] as const) {
      const val = display[field]
      if (val == null || !String(val).trim()) {
        throw new HumanDisplayPersistenceError(
          'INVALID_INPUT',
          `REVIEWED requires non-empty ${field}`,
          { field },
        )
      }
    }
    if (!display.snapshotId || !String(display.snapshotId).trim()) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires non-null snapshotId binding',
      )
    }
    if (display.boardRev == null || !Number.isFinite(display.boardRev)) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires non-null boardRev binding',
      )
    }
    if (display.lifecycleRev == null || !Number.isFinite(display.lifecycleRev)) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires non-null lifecycleRev binding',
      )
    }
    if (!Array.isArray(display.citations) || display.citations.length === 0) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires citations',
      )
    }
    if (
      !Array.isArray(display.acceptanceLinks) ||
      display.acceptanceLinks.length === 0
    ) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires acceptanceLinks',
      )
    }
    if (
      !Array.isArray(display.missionQuestionLinks) ||
      display.missionQuestionLinks.length === 0
    ) {
      throw new HumanDisplayPersistenceError(
        'INVALID_INPUT',
        'REVIEWED requires missionQuestionLinks',
      )
    }
  }
  // Always store link arrays as arrays (normalize empty).
  if (display.citations != null && !Array.isArray(display.citations)) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'citations must be an array',
    )
  }
  if (display.acceptanceLinks != null && !Array.isArray(display.acceptanceLinks)) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'acceptanceLinks must be an array',
    )
  }
  if (
    display.missionQuestionLinks != null &&
    !Array.isArray(display.missionQuestionLinks)
  ) {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'missionQuestionLinks must be an array',
    )
  }
  // Guardrail: never accept free-text PRODUCT coercion via accidental extras.
  const extra = (display as unknown as { taskClass?: unknown }).taskClass
  if (extra != null && normalizeTaskClass(extra as never) === 'PRODUCT' && extra !== 'PRODUCT') {
    throw new HumanDisplayPersistenceError(
      'INVALID_INPUT',
      'never invent PRODUCT classification',
      { taskClass: extra },
    )
  }
}

export function deriveHumanDisplayAuditId(opts: {
  boardId: string
  entityKind: string
  entityId: string
  contentVersion: number
  contentHash: string
}): string {
  return createHash('sha256')
    .update(
      [
        opts.boardId,
        opts.entityKind,
        opts.entityId,
        String(opts.contentVersion),
        opts.contentHash,
      ].join('::'),
    )
    .digest('hex')
    .slice(0, 32)
}

function recordKey(
  boardId: string,
  entityKind: string,
  entityId: string,
): string {
  return `${boardId}::${entityKind}::${entityId}`
}

function cloneDisplay(display: HumanDisplayV1): HumanDisplayV1 {
  return {
    ...display,
    citations: Array.isArray(display.citations)
      ? display.citations.map((c) => ({ ...c }))
      : [],
    acceptanceLinks: Array.isArray(display.acceptanceLinks)
      ? display.acceptanceLinks.map((c) => ({ ...c }))
      : [],
    missionQuestionLinks: Array.isArray(display.missionQuestionLinks)
      ? display.missionQuestionLinks.map((c) => ({ ...c }))
      : [],
  }
}

function toRecord(
  boardId: string,
  display: HumanDisplayV1,
  entityRev: number,
  boardRev: number,
  contentHash: string,
  timestamps?: { createdAt?: string | null; updatedAt?: string | null },
): HumanDisplayRecord {
  return {
    boardId,
    entityKind: display.entityKind,
    entityId: display.entityId,
    contentVersion: display.contentVersion,
    locale: display.locale || DEFAULT_HUMAN_LOCALE,
    reviewStatus: display.reviewStatus,
    sourceHash: display.sourceHash,
    reviewedAt: display.reviewedAt ?? null,
    content: cloneDisplay(display),
    entityRev,
    boardRev,
    schemaVersion: display.schemaVersion,
    contentHash,
    createdAt: timestamps?.createdAt ?? null,
    updatedAt: timestamps?.updatedAt ?? null,
  }
}

function defaultLivePin(sourceHash: string): HumanDisplayLivePin {
  return { liveSourceHash: sourceHash }
}

function buildGetResult(
  record: HumanDisplayRecord | null,
  entityKind: HumanDisplayEntityKind,
  entityId: string,
  live: HumanDisplayLivePin | null | undefined,
): HumanDisplayGetResult {
  const pin: HumanDisplayLivePin =
    live ??
    (record
      ? defaultLivePin(record.sourceHash)
      : defaultLivePin(''))

  const display = record?.content ?? null
  const resolved = resolveOwnerHumanDisplay(display, pin, {
    entityKind,
    entityId,
  })
  const contentReviewRequired =
    resolved.evaluation.releaseBlocker === 'CONTENT_REVIEW_REQUIRED' ||
    resolved.primary == null

  return {
    record,
    evaluation: resolved.evaluation,
    primary: resolved.primary,
    blockedShell: resolved.blockedShell,
    effectiveReviewStatus: resolved.evaluation.effectiveReviewStatus,
    contentReviewRequired,
  }
}

// ---------------------------------------------------------------------------
// Encode / decode (MySQL row shape)
// ---------------------------------------------------------------------------

export function encodeHumanDisplayRecord(rec: HumanDisplayRecord): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    entity_kind: rec.entityKind,
    entity_id: rec.entityId,
    content_version: rec.contentVersion,
    locale: rec.locale,
    review_status: rec.reviewStatus,
    source_hash: rec.sourceHash,
    reviewed_at: toMysqlDateTime(rec.reviewedAt),
    content_json: rec.content,
    entity_rev: rec.entityRev,
    board_rev: rec.boardRev,
    schema_version: rec.schemaVersion,
    content_hash: rec.contentHash,
  }
}

export function decodeHumanDisplayRecord(row: Record<string, unknown>): HumanDisplayRecord {
  const contentRaw = parseJsonCell(row.content_json)
  const content =
    contentRaw && typeof contentRaw === 'object' && !Array.isArray(contentRaw)
      ? (contentRaw as HumanDisplayV1)
      : null
  if (!content) {
    throw new HumanDisplayPersistenceError(
      'DATA_INTEGRITY',
      'human display row missing content_json',
      { boardId: row.board_id, entityId: row.entity_id },
    )
  }
  return {
    boardId: asString(row.board_id),
    entityKind: asString(row.entity_kind) as HumanDisplayEntityKind,
    entityId: asString(row.entity_id),
    contentVersion: asNumber(row.content_version, 1),
    locale: asString(row.locale, DEFAULT_HUMAN_LOCALE),
    reviewStatus: asString(row.review_status) as HumanDisplayReviewStatus,
    sourceHash: asString(row.source_hash),
    reviewedAt: fromMysqlDateTime(row.reviewed_at),
    content: cloneDisplay(content),
    entityRev: asNumber(row.entity_rev, 0),
    boardRev: asNumber(row.board_rev, 0),
    schemaVersion: asString(row.schema_version, HUMAN_DISPLAY_SCHEMA_VERSION),
    contentHash: asString(row.content_hash),
    createdAt: fromMysqlDateTime(row.created_at),
    updatedAt: fromMysqlDateTime(row.updated_at),
  }
}

export function encodeHumanDisplayAudit(
  rec: HumanDisplayAuditRecord,
): Record<string, unknown> {
  return {
    board_id: rec.boardId,
    audit_id: rec.auditId,
    entity_kind: rec.entityKind,
    entity_id: rec.entityId,
    content_version: rec.contentVersion,
    event: rec.event,
    actor_id: rec.actorId,
    source_hash: rec.sourceHash,
    content_hash: rec.contentHash,
    review_status: rec.reviewStatus,
    entity_rev: rec.entityRev,
    board_rev: rec.boardRev,
    captured_at: toMysqlDateTime(rec.capturedAt),
    payload_json: rec.payload,
  }
}

export function decodeHumanDisplayAudit(
  row: Record<string, unknown>,
): HumanDisplayAuditRecord {
  const payloadRaw = parseJsonCell(row.payload_json)
  const payload =
    payloadRaw && typeof payloadRaw === 'object' && !Array.isArray(payloadRaw)
      ? (payloadRaw as Record<string, unknown>)
      : {}
  return {
    boardId: asString(row.board_id),
    auditId: asString(row.audit_id),
    entityKind: asString(row.entity_kind) as HumanDisplayEntityKind,
    entityId: asString(row.entity_id),
    contentVersion: asNumber(row.content_version, 1),
    event: asString(row.event),
    actorId: asOptionalString(row.actor_id),
    sourceHash: asString(row.source_hash),
    contentHash: asString(row.content_hash),
    reviewStatus: asString(row.review_status) as HumanDisplayReviewStatus,
    entityRev: row.entity_rev == null ? null : asNumber(row.entity_rev),
    boardRev: row.board_rev == null ? null : asNumber(row.board_rev),
    capturedAt: fromMysqlDateTime(row.captured_at) ?? new Date(0).toISOString(),
    payload,
  }
}

// ---------------------------------------------------------------------------
// Put core (shared by memory + mysql)
// ---------------------------------------------------------------------------

function failPut(
  code: HumanDisplayPersistenceErrorCode,
  message: string,
  current: HumanDisplayRecord | null,
  details: Record<string, unknown> = {},
): HumanDisplayPutResult {
  return { ok: false, code, message, current, details }
}

function applyPutLogic(opts: {
  existing: HumanDisplayRecord | null
  req: HumanDisplayPutRequest
}): {
  result?: HumanDisplayPutResult
  next?: HumanDisplayRecord
  audit?: HumanDisplayAuditRecord
  replayed?: boolean
} {
  const { existing, req } = opts
  const { boardId, display } = req

  if (!boardId || !String(boardId).trim()) {
    return {
      result: failPut('INVALID_INPUT', 'boardId required', existing),
    }
  }

  try {
    assertHumanDisplayWritable(display)
  } catch (e) {
    if (e instanceof HumanDisplayPersistenceError) {
      return {
        result: failPut(e.code, e.message, existing, { ...e.details }),
      }
    }
    throw e
  }

  if (display.sourceHash !== req.expectedSourceHash) {
    return {
      result: failPut(
        'SOURCE_HASH_MISMATCH',
        'display.sourceHash does not match expectedSourceHash (stale binding)',
        existing,
        {
          displaySourceHash: display.sourceHash,
          expectedSourceHash: req.expectedSourceHash,
        },
      ),
    }
  }

  const contentHash = computeHumanDisplayContentHash(display)
  const nowIso = req.now ?? new Date().toISOString()
  const auditId =
    (req.auditId && String(req.auditId).trim()) ||
    deriveHumanDisplayAuditId({
      boardId,
      entityKind: display.entityKind,
      entityId: display.entityId,
      contentVersion: display.contentVersion,
      contentHash,
    })

  // Exact-replay path: same identity + same content hash → no mutation.
  if (
    existing &&
    existing.contentHash === contentHash &&
    existing.entityKind === display.entityKind &&
    existing.entityId === display.entityId &&
    existing.contentVersion === display.contentVersion &&
    existing.sourceHash === display.sourceHash &&
    existing.reviewStatus === display.reviewStatus
  ) {
    // Still require CAS match so concurrent writers cannot "replay" past a move.
    if (
      existing.entityRev !== req.expectedEntityRev ||
      existing.boardRev !== req.expectedBoardRev
    ) {
      return {
        result: failPut(
          'STALE_REVISION',
          `stale revision on exact-replay (entity_rev got ${req.expectedEntityRev} want ${existing.entityRev}; board_rev got ${req.expectedBoardRev} want ${existing.boardRev})`,
          existing,
          {
            expectedEntityRev: req.expectedEntityRev,
            currentEntityRev: existing.entityRev,
            expectedBoardRev: req.expectedBoardRev,
            currentBoardRev: existing.boardRev,
          },
        ),
      }
    }
    const audit: HumanDisplayAuditRecord = {
      boardId,
      auditId,
      entityKind: display.entityKind,
      entityId: display.entityId,
      contentVersion: display.contentVersion,
      event: 'HUMAN_DISPLAY_PUT_REPLAY',
      actorId: req.actorId ?? null,
      sourceHash: display.sourceHash,
      contentHash,
      reviewStatus: display.reviewStatus,
      entityRev: existing.entityRev,
      boardRev: existing.boardRev,
      capturedAt: nowIso,
      payload: {
        replayed: true,
        contentVersion: display.contentVersion,
        reviewStatus: display.reviewStatus,
        ...(req.actorRole != null && String(req.actorRole).trim()
          ? { actorRole: String(req.actorRole).trim() }
          : {}),
      },
    }
    return { next: existing, audit, replayed: true }
  }

  // CAS against expected revisions
  const curEntityRev = existing?.entityRev ?? 0
  const curBoardRev = existing?.boardRev ?? 0
  if (
    curEntityRev !== req.expectedEntityRev ||
    curBoardRev !== req.expectedBoardRev
  ) {
    return {
      result: failPut(
        'STALE_REVISION',
        `stale revision (entity_rev got ${req.expectedEntityRev} want ${curEntityRev}; board_rev got ${req.expectedBoardRev} want ${curBoardRev})`,
        existing,
        {
          expectedEntityRev: req.expectedEntityRev,
          currentEntityRev: curEntityRev,
          expectedBoardRev: req.expectedBoardRev,
          currentBoardRev: curBoardRev,
        },
      ),
    }
  }

  // REVIEWED content is immutable for the same content_version
  if (
    existing &&
    existing.reviewStatus === 'REVIEWED' &&
    existing.contentVersion === display.contentVersion
  ) {
    if (existing.contentHash !== contentHash) {
      return {
        result: failPut(
          'REVIEWED_IMMUTABLE',
          `REVIEWED content_version ${existing.contentVersion} is immutable; bump contentVersion for new copy`,
          existing,
          {
            contentVersion: existing.contentVersion,
            existingContentHash: existing.contentHash,
            nextContentHash: contentHash,
          },
        ),
      }
    }
  }

  // Same content_version with different hash (non-REVIEWED): allow only when
  // entity CAS matched (above). Tamper of audit receipts handled separately.

  const nextEntityRev = curEntityRev + 1
  // board_rev pin: prefer display.boardRev when present; else keep expected pin.
  const nextBoardRev =
    display.boardRev != null && Number.isFinite(display.boardRev)
      ? Number(display.boardRev)
      : req.expectedBoardRev

  const next = toRecord(boardId, display, nextEntityRev, nextBoardRev, contentHash, {
    createdAt: existing?.createdAt ?? nowIso,
    updatedAt: nowIso,
  })

  const audit: HumanDisplayAuditRecord = {
    boardId,
    auditId,
    entityKind: display.entityKind,
    entityId: display.entityId,
    contentVersion: display.contentVersion,
    event: existing ? 'HUMAN_DISPLAY_PUT_UPDATE' : 'HUMAN_DISPLAY_PUT_INSERT',
    actorId: req.actorId ?? null,
    sourceHash: display.sourceHash,
    contentHash,
    reviewStatus: display.reviewStatus,
    entityRev: nextEntityRev,
    boardRev: nextBoardRev,
    capturedAt: nowIso,
    payload: {
      replayed: false,
      previousEntityRev: curEntityRev,
      previousContentVersion: existing?.contentVersion ?? null,
      previousReviewStatus: existing?.reviewStatus ?? null,
      contentVersion: display.contentVersion,
      reviewStatus: display.reviewStatus,
      ...(req.actorRole != null && String(req.actorRole).trim()
        ? { actorRole: String(req.actorRole).trim() }
        : {}),
    },
  }

  return { next, audit, replayed: false }
}

/**
 * Insert-once audit: same content_hash → REPLAY; different → IDEMPOTENCY_CONFLICT.
 */
export function assertAuditImmutableReplay(opts: {
  existingHash: string
  nextHash: string
  auditId: string
  boardId: string
}): 'REPLAY' {
  if (opts.existingHash === opts.nextHash) return 'REPLAY'
  throw new HumanDisplayPersistenceError(
    'IDEMPOTENCY_CONFLICT',
    'human display audit rewrite with different content_hash forbidden',
    {
      auditId: opts.auditId,
      boardId: opts.boardId,
      existingHash: opts.existingHash,
      nextHash: opts.nextHash,
    },
  )
}

// ---------------------------------------------------------------------------
// Memory adapter
// ---------------------------------------------------------------------------

export function createMemoryHumanDisplayStore(): HumanDisplayStore & {
  rows: Map<string, HumanDisplayRecord>
  audits: Map<string, HumanDisplayAuditRecord>
  reset(): void
} {
  const rows = new Map<string, HumanDisplayRecord>()
  const audits = new Map<string, HumanDisplayAuditRecord>()

  const store: HumanDisplayStore & {
    rows: Map<string, HumanDisplayRecord>
    audits: Map<string, HumanDisplayAuditRecord>
    reset(): void
  } = {
    rows,
    audits,
    reset() {
      rows.clear()
      audits.clear()
    },

    async list(boardId, opts = {}) {
      const out: Array<HumanDisplayRecord> = []
      for (const rec of rows.values()) {
        if (rec.boardId !== boardId) continue
        if (opts.entityKind && rec.entityKind !== opts.entityKind) continue
        if (opts.entityId && rec.entityId !== opts.entityId) continue
        out.push({
          ...rec,
          content: cloneDisplay(rec.content),
        })
      }
      out.sort((a, b) => {
        const k = a.entityKind.localeCompare(b.entityKind)
        if (k !== 0) return k
        return a.entityId.localeCompare(b.entityId)
      })
      return out
    },

    async get(boardId, entityKind, entityId, live) {
      const key = recordKey(boardId, entityKind, entityId)
      const rec = rows.get(key) ?? null
      return buildGetResult(
        rec
          ? { ...rec, content: cloneDisplay(rec.content) }
          : null,
        entityKind,
        entityId,
        live,
      )
    },

    async put(req) {
      const key = recordKey(
        req.boardId,
        req.display.entityKind,
        req.display.entityId,
      )
      const existing = rows.get(key) ?? null
      const applied = applyPutLogic({ existing, req })
      if (applied.result) return applied.result
      if (!applied.next || !applied.audit) {
        return failPut(
          'DATA_INTEGRITY',
          'put logic produced no next record',
          existing,
        )
      }

      // Audit insert-once
      const auditKey = `${applied.audit.boardId}::${applied.audit.auditId}`
      const existingAudit = audits.get(auditKey)
      if (existingAudit) {
        try {
          assertAuditImmutableReplay({
            existingHash: existingAudit.contentHash,
            nextHash: applied.audit.contentHash,
            auditId: applied.audit.auditId,
            boardId: applied.audit.boardId,
          })
        } catch (e) {
          if (e instanceof HumanDisplayPersistenceError) {
            return failPut(e.code, e.message, existing, { ...e.details })
          }
          throw e
        }
      } else {
        audits.set(auditKey, { ...applied.audit, payload: { ...applied.audit.payload } })
      }

      if (!applied.replayed) {
        rows.set(key, {
          ...applied.next,
          content: cloneDisplay(applied.next.content),
        })
      }

      return {
        ok: true,
        record: {
          ...applied.next,
          content: cloneDisplay(applied.next.content),
        },
        replayed: applied.replayed === true,
        auditId: applied.audit.auditId,
      }
    },

    async listAudit(boardId) {
      const out: Array<HumanDisplayAuditRecord> = []
      for (const a of audits.values()) {
        if (a.boardId !== boardId) continue
        out.push({ ...a, payload: { ...a.payload } })
      }
      out.sort((a, b) => {
        const t = a.capturedAt.localeCompare(b.capturedAt)
        if (t !== 0) return t
        return a.auditId.localeCompare(b.auditId)
      })
      return out
    },

    async getAudit(boardId, auditId) {
      const a = audits.get(`${boardId}::${auditId}`)
      return a ? { ...a, payload: { ...a.payload } } : null
    },
  }

  return store
}

// ---------------------------------------------------------------------------
// MySQL adapter
// ---------------------------------------------------------------------------

export const HUMAN_DISPLAY_SQL = {
  list: `SELECT * FROM control_plane_human_display WHERE board_id=? ORDER BY entity_kind ASC, entity_id ASC`,
  listByKind: `SELECT * FROM control_plane_human_display WHERE board_id=? AND entity_kind=? ORDER BY entity_id ASC`,
  listByEntity: `SELECT * FROM control_plane_human_display WHERE board_id=? AND entity_kind=? AND entity_id=? LIMIT 1`,
  get: `SELECT * FROM control_plane_human_display WHERE board_id=? AND entity_kind=? AND entity_id=? LIMIT 1`,
  insert: `INSERT INTO control_plane_human_display (
    board_id, entity_kind, entity_id, content_version, locale, review_status,
    source_hash, reviewed_at, content_json, entity_rev, board_rev,
    schema_version, content_hash
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
  update: `UPDATE control_plane_human_display SET
    content_version=?, locale=?, review_status=?, source_hash=?, reviewed_at=?,
    content_json=?, entity_rev=?, board_rev=?, schema_version=?, content_hash=?
  WHERE board_id=? AND entity_kind=? AND entity_id=? AND entity_rev=? AND board_rev=?`,
  getAudit: `SELECT * FROM control_plane_human_display_audit WHERE board_id=? AND audit_id=? LIMIT 1`,
  listAudit: `SELECT * FROM control_plane_human_display_audit WHERE board_id=? ORDER BY captured_at ASC, audit_id ASC`,
  insertAudit: `INSERT INTO control_plane_human_display_audit (
    board_id, audit_id, entity_kind, entity_id, content_version, event, actor_id,
    source_hash, content_hash, review_status, entity_rev, board_rev, captured_at, payload_json
  ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
} as const

export function createMysqlHumanDisplayStore(
  exec: HumanDisplaySqlExecutor,
): HumanDisplayStore {
  async function load(
    boardId: string,
    entityKind: HumanDisplayEntityKind,
    entityId: string,
  ): Promise<HumanDisplayRecord | null> {
    const res = await exec.execute(HUMAN_DISPLAY_SQL.get, [
      boardId,
      entityKind,
      entityId,
    ])
    const row = res.rows[0]
    return row ? decodeHumanDisplayRecord(row) : null
  }

  async function writeAudit(audit: HumanDisplayAuditRecord): Promise<void> {
    const existing = await exec.execute(HUMAN_DISPLAY_SQL.getAudit, [
      audit.boardId,
      audit.auditId,
    ])
    const row = existing.rows[0]
    if (row) {
      const prev = decodeHumanDisplayAudit(row)
      assertAuditImmutableReplay({
        existingHash: prev.contentHash,
        nextHash: audit.contentHash,
        auditId: audit.auditId,
        boardId: audit.boardId,
      })
      return
    }
    const e = encodeHumanDisplayAudit(audit)
    await exec.execute(HUMAN_DISPLAY_SQL.insertAudit, [
      e.board_id,
      e.audit_id,
      e.entity_kind,
      e.entity_id,
      e.content_version,
      e.event,
      e.actor_id,
      e.source_hash,
      e.content_hash,
      e.review_status,
      e.entity_rev,
      e.board_rev,
      e.captured_at,
      jsonParam(e.payload_json),
    ])
  }

  return {
    async list(boardId, opts = {}) {
      let res: HumanDisplaySqlExecuteResult
      if (opts.entityKind && opts.entityId) {
        res = await exec.execute(HUMAN_DISPLAY_SQL.listByEntity, [
          boardId,
          opts.entityKind,
          opts.entityId,
        ])
      } else if (opts.entityKind) {
        res = await exec.execute(HUMAN_DISPLAY_SQL.listByKind, [
          boardId,
          opts.entityKind,
        ])
      } else {
        res = await exec.execute(HUMAN_DISPLAY_SQL.list, [boardId])
      }
      return res.rows.map((r) => decodeHumanDisplayRecord(r))
    },

    async get(boardId, entityKind, entityId, live) {
      const rec = await load(boardId, entityKind, entityId)
      return buildGetResult(rec, entityKind, entityId, live)
    },

    async put(req) {
      const existing = await load(
        req.boardId,
        req.display.entityKind,
        req.display.entityId,
      )
      const applied = applyPutLogic({ existing, req })
      if (applied.result) return applied.result
      if (!applied.next || !applied.audit) {
        return failPut(
          'DATA_INTEGRITY',
          'put logic produced no next record',
          existing,
        )
      }

      try {
        await writeAudit(applied.audit)
      } catch (e) {
        if (e instanceof HumanDisplayPersistenceError) {
          return failPut(e.code, e.message, existing, { ...e.details })
        }
        throw e
      }

      if (!applied.replayed) {
        const e = encodeHumanDisplayRecord(applied.next)
        if (!existing) {
          await exec.execute(HUMAN_DISPLAY_SQL.insert, [
            e.board_id,
            e.entity_kind,
            e.entity_id,
            e.content_version,
            e.locale,
            e.review_status,
            e.source_hash,
            e.reviewed_at,
            jsonParam(e.content_json),
            e.entity_rev,
            e.board_rev,
            e.schema_version,
            e.content_hash,
          ])
        } else {
          const upd = await exec.execute(HUMAN_DISPLAY_SQL.update, [
            e.content_version,
            e.locale,
            e.review_status,
            e.source_hash,
            e.reviewed_at,
            jsonParam(e.content_json),
            e.entity_rev,
            e.board_rev,
            e.schema_version,
            e.content_hash,
            e.board_id,
            e.entity_kind,
            e.entity_id,
            existing.entityRev,
            existing.boardRev,
          ])
          if (upd.affectedRows !== 1) {
            // Concurrent writer won the race — re-read and surface STALE.
            const current = await load(
              req.boardId,
              req.display.entityKind,
              req.display.entityId,
            )
            return failPut(
              'STALE_REVISION',
              'concurrent update lost CAS race (affectedRows!=1)',
              current,
              { affectedRows: upd.affectedRows },
            )
          }
        }
      }

      const stored =
        (await load(
          req.boardId,
          req.display.entityKind,
          req.display.entityId,
        )) ?? applied.next

      return {
        ok: true,
        record: stored,
        replayed: applied.replayed === true,
        auditId: applied.audit.auditId,
      }
    },

    async listAudit(boardId) {
      const res = await exec.execute(HUMAN_DISPLAY_SQL.listAudit, [boardId])
      return res.rows.map((r) => decodeHumanDisplayAudit(r))
    },

    async getAudit(boardId, auditId) {
      const res = await exec.execute(HUMAN_DISPLAY_SQL.getAudit, [
        boardId,
        auditId,
      ])
      const row = res.rows[0]
      return row ? decodeHumanDisplayAudit(row) : null
    },
  }
}

/**
 * Minimal in-memory SQL executor covering statements issued by
 * createMysqlHumanDisplayStore (unit tests without real MySQL).
 */
export function createMemoryHumanDisplaySql(): HumanDisplaySqlExecutor & {
  tables: {
    control_plane_human_display: Map<string, Record<string, unknown>>
    control_plane_human_display_audit: Map<string, Record<string, unknown>>
  }
  calls: Array<{ sql: string; params: ReadonlyArray<unknown> }>
  reset(): void
} {
  const tables = {
    control_plane_human_display: new Map<string, Record<string, unknown>>(),
    control_plane_human_display_audit: new Map<string, Record<string, unknown>>(),
  }
  const calls: Array<{ sql: string; params: ReadonlyArray<unknown> }> = []

  const normalize = (sql: string) => sql.replace(/\s+/g, ' ').trim()

  return {
    tables,
    calls,
    reset() {
      tables.control_plane_human_display.clear()
      tables.control_plane_human_display_audit.clear()
      calls.length = 0
    },
    async execute<T = Record<string, unknown>>(
      sql: string,
      params: ReadonlyArray<unknown> = [],
    ): Promise<HumanDisplaySqlExecuteResult<T>> {
      const s = normalize(sql)
      const p = [...params]
      calls.push({ sql, params: p })

      if (/^SELECT \* FROM control_plane_human_display WHERE board_id=\? AND entity_kind=\? AND entity_id=\? LIMIT 1/i.test(s)) {
        const key = `${p[0]}::${p[1]}::${p[2]}`
        const row = tables.control_plane_human_display.get(key)
        return { rows: (row ? [row] : []) as Array<T>, affectedRows: row ? 1 : 0 }
      }
      if (/^SELECT \* FROM control_plane_human_display WHERE board_id=\? AND entity_kind=\? ORDER BY entity_id ASC/i.test(s)) {
        const rows = [...tables.control_plane_human_display.values()]
          .filter((r) => r.board_id === p[0] && r.entity_kind === p[1])
          .sort((a, b) => String(a.entity_id).localeCompare(String(b.entity_id)))
        return { rows: rows as Array<T>, affectedRows: rows.length }
      }
      if (/^SELECT \* FROM control_plane_human_display WHERE board_id=\? ORDER BY entity_kind ASC, entity_id ASC/i.test(s)) {
        const rows = [...tables.control_plane_human_display.values()]
          .filter((r) => r.board_id === p[0])
          .sort((a, b) => {
            const k = String(a.entity_kind).localeCompare(String(b.entity_kind))
            if (k !== 0) return k
            return String(a.entity_id).localeCompare(String(b.entity_id))
          })
        return { rows: rows as Array<T>, affectedRows: rows.length }
      }
      if (/^INSERT INTO control_plane_human_display \(/i.test(s)) {
        const key = `${p[0]}::${p[1]}::${p[2]}`
        if (tables.control_plane_human_display.has(key)) {
          const err = new Error('Duplicate entry') as Error & {
            errno: number
            code: string
          }
          err.errno = 1062
          err.code = 'ER_DUP_ENTRY'
          throw err
        }
        tables.control_plane_human_display.set(key, {
          board_id: p[0],
          entity_kind: p[1],
          entity_id: p[2],
          content_version: p[3],
          locale: p[4],
          review_status: p[5],
          source_hash: p[6],
          reviewed_at: p[7],
          content_json: parseJsonCell(p[8]),
          entity_rev: p[9],
          board_rev: p[10],
          schema_version: p[11],
          content_hash: p[12],
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString(),
        })
        return { rows: [] as Array<T>, affectedRows: 1 }
      }
      if (/^UPDATE control_plane_human_display SET/i.test(s)) {
        // params: content_version, locale, review_status, source_hash, reviewed_at,
        // content_json, entity_rev, board_rev, schema_version, content_hash,
        // board_id, entity_kind, entity_id, entity_rev_cas, board_rev_cas
        const key = `${p[10]}::${p[11]}::${p[12]}`
        const row = tables.control_plane_human_display.get(key)
        if (!row) return { rows: [] as Array<T>, affectedRows: 0 }
        if (
          asNumber(row.entity_rev) !== asNumber(p[13]) ||
          asNumber(row.board_rev) !== asNumber(p[14])
        ) {
          return { rows: [] as Array<T>, affectedRows: 0 }
        }
        row.content_version = p[0]
        row.locale = p[1]
        row.review_status = p[2]
        row.source_hash = p[3]
        row.reviewed_at = p[4]
        row.content_json = parseJsonCell(p[5])
        row.entity_rev = p[6]
        row.board_rev = p[7]
        row.schema_version = p[8]
        row.content_hash = p[9]
        row.updated_at = new Date().toISOString()
        return { rows: [] as Array<T>, affectedRows: 1 }
      }
      if (/^SELECT \* FROM control_plane_human_display_audit WHERE board_id=\? AND audit_id=\? LIMIT 1/i.test(s)) {
        const key = `${p[0]}::${p[1]}`
        const row = tables.control_plane_human_display_audit.get(key)
        return { rows: (row ? [row] : []) as Array<T>, affectedRows: row ? 1 : 0 }
      }
      if (/^SELECT \* FROM control_plane_human_display_audit WHERE board_id=\? ORDER BY captured_at ASC, audit_id ASC/i.test(s)) {
        const rows = [...tables.control_plane_human_display_audit.values()]
          .filter((r) => r.board_id === p[0])
          .sort((a, b) => {
            const t = String(a.captured_at).localeCompare(String(b.captured_at))
            if (t !== 0) return t
            return String(a.audit_id).localeCompare(String(b.audit_id))
          })
        return { rows: rows as Array<T>, affectedRows: rows.length }
      }
      if (/^INSERT INTO control_plane_human_display_audit \(/i.test(s)) {
        const key = `${p[0]}::${p[1]}`
        if (tables.control_plane_human_display_audit.has(key)) {
          const err = new Error('Duplicate entry') as Error & {
            errno: number
            code: string
          }
          err.errno = 1062
          err.code = 'ER_DUP_ENTRY'
          throw err
        }
        tables.control_plane_human_display_audit.set(key, {
          board_id: p[0],
          audit_id: p[1],
          entity_kind: p[2],
          entity_id: p[3],
          content_version: p[4],
          event: p[5],
          actor_id: p[6],
          source_hash: p[7],
          content_hash: p[8],
          review_status: p[9],
          entity_rev: p[10],
          board_rev: p[11],
          captured_at: p[12],
          payload_json: parseJsonCell(p[13]),
          created_at: new Date().toISOString(),
        })
        return { rows: [] as Array<T>, affectedRows: 1 }
      }

      throw new Error(
        `createMemoryHumanDisplaySql: unsupported SQL: ${s.slice(0, 160)}`,
      )
    },
  }
}

export function createMemoryBackedMysqlHumanDisplayStore(): HumanDisplayStore & {
  sql: ReturnType<typeof createMemoryHumanDisplaySql>
} {
  const sql = createMemoryHumanDisplaySql()
  const store = createMysqlHumanDisplayStore(sql)
  return Object.assign(store, { sql })
}

/** Convenience: pure memory facade (no SQL). */
export function createMemoryHumanDisplayPersistence(): HumanDisplayStore & {
  rows: Map<string, HumanDisplayRecord>
  audits: Map<string, HumanDisplayAuditRecord>
  reset(): void
} {
  return createMemoryHumanDisplayStore()
}

// re-export evaluate for consumers that only import persistence
export { evaluateHumanDisplay, resolveOwnerHumanDisplay, normalizeTaskClass }
