/**
 * Canonical MCP authenticated READ contract foundation (API_CONTRACT §2–§4).
 *
 * Pure / injectable only:
 * - exact canonical method names
 * - versioned compatibility alias map
 * - TM_PINNED_ENVELOPE_V1 builder
 * - cursor pagination (createdAt,id · default 50 · max 200)
 * - validated filters (fail-closed)
 * - bounded list payload
 *
 * NEVER recomputes counts, readiness, G5, priority, or NEXT.
 * Callers inject pre-aggregated `data` only. No board-mcp wiring here.
 */

import {
  DEFAULT_PAGE_SIZE,
  MAX_PAGE_SIZE,
  decodeCursor,
  encodeCursor,
  paginateDesc,
  resolvePage,
  resolvePageSize,
  type CursorPayload,
  type PageParams,
  CursorError,
} from '#/server/cursor'

// ---------------------------------------------------------------------------
// Schema / contract versions
// ---------------------------------------------------------------------------

export const TM_PINNED_ENVELOPE_V1 = 'TM_PINNED_ENVELOPE_V1' as const
export const MCP_READ_CONTRACT_VERSION = 'TM_MCP_READ_CONTRACT_V1' as const
export const MCP_READ_CURSOR_ORDER = 'createdAt DESC, id DESC' as const

export { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE, CursorError }

// ---------------------------------------------------------------------------
// Canonical methods (API_CONTRACT §2 — exact set)
// ---------------------------------------------------------------------------

/**
 * Canonical authenticated read methods. Order matches API_CONTRACT §2.
 * Pair forms (list_X / get_X) are both first-class.
 */
export const CANONICAL_READ_METHODS = [
  'get_overview',
  'list_work_items',
  'list_projects',
  'get_project',
  'list_features',
  'get_feature',
  'list_tasks',
  'get_task',
  'list_runs',
  'get_run',
  'list_accounts',
  'get_account',
  'list_decisions',
  'get_decision',
  'list_activity',
  'list_audit',
  'get_priority_portfolio',
  'get_g5',
  'get_prod',
  'get_guide',
] as const

export type CanonicalReadMethod = (typeof CANONICAL_READ_METHODS)[number]

export const CANONICAL_READ_METHOD_SET: ReadonlySet<string> = new Set(CANONICAL_READ_METHODS)

/** Methods that return a page of rows under `data` + `nextCursor`. */
export const CANONICAL_LIST_METHODS = [
  'list_work_items',
  'list_projects',
  'list_features',
  'list_tasks',
  'list_runs',
  'list_accounts',
  'list_decisions',
  'list_activity',
  'list_audit',
] as const satisfies ReadonlyArray<CanonicalReadMethod>

export type CanonicalListMethod = (typeof CANONICAL_LIST_METHODS)[number]

export const CANONICAL_LIST_METHOD_SET: ReadonlySet<string> = new Set(CANONICAL_LIST_METHODS)

/** Single-entity or aggregate methods (nextCursor always null). */
export const CANONICAL_GET_METHODS = [
  'get_overview',
  'get_project',
  'get_feature',
  'get_task',
  'get_run',
  'get_account',
  'get_decision',
  'get_priority_portfolio',
  'get_g5',
  'get_prod',
  'get_guide',
] as const satisfies ReadonlyArray<CanonicalReadMethod>

export type CanonicalGetMethod = (typeof CANONICAL_GET_METHODS)[number]

export function isCanonicalReadMethod(name: string): name is CanonicalReadMethod {
  return CANONICAL_READ_METHOD_SET.has(name)
}

export function isCanonicalListMethod(name: string): name is CanonicalListMethod {
  return CANONICAL_LIST_METHOD_SET.has(name)
}

// ---------------------------------------------------------------------------
// Compatibility aliases (API_CONTRACT §2 — versioned; MUST NOT recompute)
// ---------------------------------------------------------------------------

/**
 * Versioned compatibility aliases → canonical method that owns the aggregation.
 * Aliases share the same auth, pin, filters, cursor, and envelope contract.
 * Data is a precomputed slice of the canonical surface — never recomputed here.
 */
export const COMPATIBILITY_ALIAS_MAP = {
  get_rollup: {
    alias: 'get_rollup',
    resolvesTo: 'get_overview',
    slice: 'rollup',
    note: 'Legacy readiness/rollup surface; same pin as get_overview',
  },
  get_lifecycle: {
    alias: 'get_lifecycle',
    resolvesTo: 'get_overview',
    slice: 'lifecycle',
    note: 'Lifecycle rail projection; same pin as get_overview',
  },
  get_board_hash: {
    alias: 'get_board_hash',
    resolvesTo: 'get_overview',
    slice: 'boardHash',
    note: 'Pin hash metadata only; same pin identity as all reads',
  },
  get_work: {
    alias: 'get_work',
    resolvesTo: 'list_work_items',
    slice: 'work',
    note: 'Legacy work view → list_work_items',
  },
  get_priority: {
    alias: 'get_priority',
    resolvesTo: 'get_priority_portfolio',
    slice: 'priority',
    note: 'Legacy priority → get_priority_portfolio',
  },
} as const satisfies Record<
  string,
  {
    alias: string
    resolvesTo: CanonicalReadMethod
    slice: string
    note: string
  }
>

export type CompatibilityAliasName = keyof typeof COMPATIBILITY_ALIAS_MAP

export type CompatibilityAliasEntry = (typeof COMPATIBILITY_ALIAS_MAP)[CompatibilityAliasName]

export const COMPATIBILITY_ALIAS_NAMES = Object.keys(
  COMPATIBILITY_ALIAS_MAP,
) as CompatibilityAliasName[]

export function isCompatibilityAlias(name: string): name is CompatibilityAliasName {
  return Object.prototype.hasOwnProperty.call(COMPATIBILITY_ALIAS_MAP, name)
}

/**
 * Resolve a tool/method name to its canonical read method.
 * Canonical names resolve to themselves; aliases map via COMPATIBILITY_ALIAS_MAP.
 * Unknown → null (fail-closed).
 */
export function resolveCanonicalReadMethod(name: string): CanonicalReadMethod | null {
  if (isCanonicalReadMethod(name)) return name
  if (isCompatibilityAlias(name)) return COMPATIBILITY_ALIAS_MAP[name].resolvesTo
  return null
}

export function resolveCompatibilityAlias(name: string): CompatibilityAliasEntry | null {
  if (!isCompatibilityAlias(name)) return null
  return COMPATIBILITY_ALIAS_MAP[name]
}

/** All names that must share the pinned envelope contract (canonical + aliases). */
export function allPinnedReadMethodNames(): string[] {
  return [...CANONICAL_READ_METHODS, ...COMPATIBILITY_ALIAS_NAMES]
}

// ---------------------------------------------------------------------------
// Pin + envelope (API_CONTRACT §3)
// ---------------------------------------------------------------------------

export interface McpReadPin {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
}

/** Common authenticated read envelope — every canonical/alias read returns this shape. */
export interface McpPinnedReadEnvelope<T = unknown> {
  schemaVersion: typeof TM_PINNED_ENVELOPE_V1
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
  /** Pre-aggregated payload only — never recomputed in this module. */
  data: T
  nextCursor: string | null
  /** Which method this envelope was built for (canonical after alias resolve). */
  method: CanonicalReadMethod
  /** Original call name when an alias was used. */
  requestedAs: string
  /** Contract version marker for consumers. */
  contractVersion: typeof MCP_READ_CONTRACT_VERSION
}

export type McpReadFilterErrorCode =
  | 'INVALID_FILTER'
  | 'UNKNOWN_METHOD'
  | 'MISSING_BOARD_ID'
  | 'MISSING_ENTITY_ID'
  | 'PAGE_SIZE_INVALID'
  | 'CURSOR_INVALID'
  | 'PIN_INCOMPLETE'
  | 'PAYLOAD_UNBOUNDED'

export class McpReadContractError extends Error {
  readonly code: McpReadFilterErrorCode
  readonly details: Readonly<Record<string, unknown>>
  constructor(
    code: McpReadFilterErrorCode,
    message: string,
    details: Record<string, unknown> = {},
  ) {
    super(message)
    this.name = 'McpReadContractError'
    this.code = code
    this.details = details
  }
}

export function assertMcpReadPin(pin: McpReadPin): void {
  if (
    !pin ||
    typeof pin.boardId !== 'string' ||
    !pin.boardId.trim() ||
    typeof pin.canonicalSnapshotId !== 'string' ||
    !pin.canonicalSnapshotId.trim() ||
    typeof pin.canonicalHash !== 'string' ||
    !pin.canonicalHash.trim() ||
    typeof pin.boardRev !== 'number' ||
    !Number.isInteger(pin.boardRev) ||
    pin.boardRev < 0 ||
    typeof pin.lifecycleRev !== 'number' ||
    !Number.isInteger(pin.lifecycleRev) ||
    pin.lifecycleRev < 0 ||
    typeof pin.generatedAt !== 'string' ||
    !pin.generatedAt ||
    typeof pin.freshnessAgeSeconds !== 'number' ||
    !Number.isFinite(pin.freshnessAgeSeconds) ||
    pin.freshnessAgeSeconds < 0 ||
    typeof pin.stale !== 'boolean' ||
    !(pin.staleReason === null || typeof pin.staleReason === 'string')
  ) {
    throw new McpReadContractError('PIN_INCOMPLETE', 'MCP read pin is incomplete or invalid', {
      pin,
    })
  }
}

/**
 * Validate optional nextCursor against the pin revision.
 * - null/undefined → null
 * - empty / non-string → CURSOR_INVALID
 * - malformed / tampered → CURSOR_INVALID
 * - boardRev or snapshotRev mismatch → CURSOR_INVALID (stale/foreign; no passthrough)
 *
 * expectedSnapshotRev defaults to null (matches list producers that pin boardRev only).
 * Pass pin.canonicalSnapshotId when cursors are snapshot-bound.
 */
export function validateNextCursorForPin(
  nextCursor: unknown,
  pin: Pick<McpReadPin, 'boardRev'>,
  opts: { expectedSnapshotRev?: string | null } = {},
): string | null {
  if (nextCursor === undefined || nextCursor === null) return null
  if (typeof nextCursor !== 'string' || !nextCursor.trim()) {
    throw new McpReadContractError('CURSOR_INVALID', 'nextCursor must be a non-empty v1 opaque token or null', {
      nextCursor,
    })
  }
  const expectedBoardRev = pin.boardRev
  const expectedSnapshotRev = opts.expectedSnapshotRev ?? null
  try {
    // resolvePage enforces decode + boardRev/snapshotRev pin match (fail-closed).
    resolvePage({
      cursor: nextCursor,
      pageSize: DEFAULT_PAGE_SIZE,
      expectedBoardRev,
      expectedSnapshotRev,
    })
  } catch (e) {
    if (e instanceof CursorError) {
      throw new McpReadContractError('CURSOR_INVALID', e.message, {
        cursorCode: e.code,
        nextCursor,
        expectedBoardRev,
        expectedSnapshotRev,
      })
    }
    throw e
  }
  return nextCursor
}

/**
 * Build the common pinned envelope around precomputed `data`.
 * Pin fields always win. Does not recompute readiness/counts/G5/priority.
 * nextCursor is never passed through arbitrarily — validated against pin revision.
 */
export function buildPinnedReadEnvelope<T>(
  pin: McpReadPin,
  data: T,
  opts: {
    method: string
    nextCursor?: string | null
    /** When set, nextCursor snapshotRev must match (default null). */
    expectedSnapshotRev?: string | null
  },
): McpPinnedReadEnvelope<T> {
  assertMcpReadPin(pin)
  const requestedAs = opts.method
  const canonical = resolveCanonicalReadMethod(requestedAs)
  if (!canonical) {
    throw new McpReadContractError(
      'UNKNOWN_METHOD',
      `not a canonical read or compatibility alias: ${requestedAs}`,
      { method: requestedAs },
    )
  }
  // List methods may carry nextCursor; get methods force null (ignore hostile supply).
  const nextCursor = isCanonicalListMethod(canonical)
    ? validateNextCursorForPin(opts.nextCursor, pin, {
        expectedSnapshotRev: opts.expectedSnapshotRev ?? null,
      })
    : null
  const env: McpPinnedReadEnvelope<T> = {
    schemaVersion: TM_PINNED_ENVELOPE_V1,
    boardId: pin.boardId,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    generatedAt: pin.generatedAt,
    freshnessAgeSeconds: pin.freshnessAgeSeconds,
    stale: pin.stale,
    staleReason: pin.staleReason,
    data,
    nextCursor,
    method: canonical,
    requestedAs,
    contractVersion: MCP_READ_CONTRACT_VERSION,
  }
  // Typed self-check (not key-only) before return.
  assertPinnedEnvelopeShape(env)
  return env
}

// ---------------------------------------------------------------------------
// Primary buckets (list_work_items filter)
// ---------------------------------------------------------------------------

export const PRIMARY_BUCKETS = [
  'DONE',
  'RECONCILIATION_PENDING',
  'ONGOING',
  'NEXT',
  'QUEUED',
  'BLOCKED',
] as const

export type PrimaryBucketFilter = (typeof PRIMARY_BUCKETS)[number]

const PRIMARY_BUCKET_SET: ReadonlySet<string> = new Set(PRIMARY_BUCKETS)

// ---------------------------------------------------------------------------
// Common + per-method filter schemas (fail-closed validation)
// ---------------------------------------------------------------------------

export interface CommonReadArgs {
  boardId: string
  cursor?: string | null
  pageSize?: number | null
}

export interface ListWorkItemsFilters extends CommonReadArgs {
  bucket?: PrimaryBucketFilter | null
  overlay?: string | null
  staleFamily?: boolean | null
  projectId?: string | null
  featureId?: string | null
}

export interface EntityGetFilters extends CommonReadArgs {
  /** Required entity id for get_* methods (projectId / featureId / taskId / …). */
  id: string
}

export interface ListTasksFilters extends CommonReadArgs {
  projectId?: string | null
  featureId?: string | null
  stage?: string | null
}

export interface ListRunsFilters extends CommonReadArgs {
  status?: string | null
  taskId?: string | null
}

export interface ListAccountsFilters extends CommonReadArgs {
  status?: string | null
  provider?: string | null
}

export interface ListDecisionsFilters extends CommonReadArgs {
  openOnly?: boolean | null
  blocking?: boolean | null
}

export type MethodFilterMap = {
  get_overview: CommonReadArgs
  list_work_items: ListWorkItemsFilters
  list_projects: CommonReadArgs
  get_project: EntityGetFilters
  list_features: CommonReadArgs
  get_feature: EntityGetFilters
  list_tasks: ListTasksFilters
  get_task: EntityGetFilters
  list_runs: ListRunsFilters
  get_run: EntityGetFilters
  list_accounts: ListAccountsFilters
  get_account: EntityGetFilters
  list_decisions: ListDecisionsFilters
  get_decision: EntityGetFilters
  list_activity: CommonReadArgs
  list_audit: CommonReadArgs
  get_priority_portfolio: CommonReadArgs
  get_g5: CommonReadArgs
  get_prod: CommonReadArgs
  get_guide: CommonReadArgs
}

function requireBoardId(raw: Record<string, unknown>): string {
  const boardId = raw.boardId
  if (typeof boardId !== 'string' || !boardId.trim()) {
    throw new McpReadContractError('MISSING_BOARD_ID', 'boardId is required', { boardId })
  }
  return boardId.trim()
}

function optionalString(raw: unknown, field: string): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string') {
    throw new McpReadContractError('INVALID_FILTER', `${field} must be a string or null`, {
      field,
      value: raw,
    })
  }
  return raw
}

function optionalBoolean(raw: unknown, field: string): boolean | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'boolean') {
    throw new McpReadContractError('INVALID_FILTER', `${field} must be a boolean or null`, {
      field,
      value: raw,
    })
  }
  return raw
}

function optionalPageSize(raw: unknown): number | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'number' || !Number.isInteger(raw)) {
    throw new McpReadContractError('PAGE_SIZE_INVALID', 'pageSize must be integer 1..200 or null', {
      pageSize: raw,
    })
  }
  // Fail-closed: reject oversized (prefer reject over clamp — cursor.ts / API_CONTRACT §4).
  try {
    resolvePageSize(raw)
  } catch (e) {
    if (e instanceof CursorError) {
      throw new McpReadContractError('PAGE_SIZE_INVALID', e.message, { pageSize: raw, cursorCode: e.code })
    }
    throw e
  }
  return raw
}

function optionalCursor(raw: unknown): string | null | undefined {
  if (raw === undefined) return undefined
  if (raw === null) return null
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new McpReadContractError('CURSOR_INVALID', 'cursor must be a non-empty string or null', {
      cursor: raw,
    })
  }
  return raw
}

function requireEntityId(raw: Record<string, unknown>, method: CanonicalGetMethod): string {
  // Accept method-specific keys or generic `id`.
  const candidates: Array<string | undefined> = [
    typeof raw.id === 'string' ? raw.id : undefined,
  ]
  switch (method) {
    case 'get_project':
      candidates.push(typeof raw.projectId === 'string' ? raw.projectId : undefined)
      break
    case 'get_feature':
      candidates.push(typeof raw.featureId === 'string' ? raw.featureId : undefined)
      break
    case 'get_task':
      candidates.push(typeof raw.taskId === 'string' ? raw.taskId : undefined)
      break
    case 'get_run':
      candidates.push(typeof raw.runId === 'string' ? raw.runId : undefined)
      break
    case 'get_account':
      candidates.push(typeof raw.accountId === 'string' ? raw.accountId : undefined)
      break
    case 'get_decision':
      candidates.push(typeof raw.decisionId === 'string' ? raw.decisionId : undefined)
      break
    default:
      break
  }
  const id = candidates.find((c) => typeof c === 'string' && c.trim().length > 0)?.trim()
  if (!id) {
    throw new McpReadContractError('MISSING_ENTITY_ID', `${method} requires an entity id`, {
      method,
    })
  }
  return id
}

/**
 * Validate filters for a canonical method (or alias — resolved first).
 * Unknown keys for the method are rejected (fail-closed).
 * Returns a typed, trimmed filter object.
 */
export function validateReadFilters(
  methodOrAlias: string,
  raw: unknown,
): MethodFilterMap[CanonicalReadMethod] {
  const method = resolveCanonicalReadMethod(methodOrAlias)
  if (!method) {
    throw new McpReadContractError('UNKNOWN_METHOD', `unknown read method: ${methodOrAlias}`, {
      method: methodOrAlias,
    })
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new McpReadContractError('INVALID_FILTER', 'filters must be an object', { raw })
  }
  const args = raw as Record<string, unknown>
  const boardId = requireBoardId(args)
  const cursor = optionalCursor(args.cursor)
  const pageSize = optionalPageSize(args.pageSize)

  // Reject unknown top-level keys per method allowlist.
  const allowed = allowedFilterKeys(method)
  for (const key of Object.keys(args)) {
    if (!allowed.has(key)) {
      throw new McpReadContractError('INVALID_FILTER', `unknown filter key for ${method}: ${key}`, {
        method,
        key,
      })
    }
  }

  const base: CommonReadArgs = { boardId, cursor, pageSize }

  switch (method) {
    case 'list_work_items': {
      let bucket: PrimaryBucketFilter | null | undefined
      if (args.bucket === undefined) bucket = undefined
      else if (args.bucket === null) bucket = null
      else if (typeof args.bucket === 'string' && PRIMARY_BUCKET_SET.has(args.bucket)) {
        bucket = args.bucket as PrimaryBucketFilter
      } else {
        throw new McpReadContractError('INVALID_FILTER', 'bucket must be a PrimaryBucket or null', {
          bucket: args.bucket,
        })
      }
      return {
        ...base,
        bucket,
        overlay: optionalString(args.overlay, 'overlay'),
        staleFamily: optionalBoolean(args.staleFamily, 'staleFamily'),
        projectId: optionalString(args.projectId, 'projectId'),
        featureId: optionalString(args.featureId, 'featureId'),
      }
    }
    case 'list_tasks':
      return {
        ...base,
        projectId: optionalString(args.projectId, 'projectId'),
        featureId: optionalString(args.featureId, 'featureId'),
        stage: optionalString(args.stage, 'stage'),
      }
    case 'list_runs':
      return {
        ...base,
        status: optionalString(args.status, 'status'),
        taskId: optionalString(args.taskId, 'taskId'),
      }
    case 'list_accounts':
      return {
        ...base,
        status: optionalString(args.status, 'status'),
        provider: optionalString(args.provider, 'provider'),
      }
    case 'list_decisions':
      return {
        ...base,
        openOnly: optionalBoolean(args.openOnly, 'openOnly'),
        blocking: optionalBoolean(args.blocking, 'blocking'),
      }
    case 'get_project':
    case 'get_feature':
    case 'get_task':
    case 'get_run':
    case 'get_account':
    case 'get_decision':
      return { ...base, id: requireEntityId(args, method) }
    default:
      // get_overview, list_projects, list_features, list_activity, list_audit,
      // get_priority_portfolio, get_g5, get_prod, get_guide
      return base
  }
}

function allowedFilterKeys(method: CanonicalReadMethod): Set<string> {
  const common = ['boardId', 'cursor', 'pageSize']
  switch (method) {
    case 'list_work_items':
      return new Set([...common, 'bucket', 'overlay', 'staleFamily', 'projectId', 'featureId'])
    case 'list_tasks':
      return new Set([...common, 'projectId', 'featureId', 'stage'])
    case 'list_runs':
      return new Set([...common, 'status', 'taskId'])
    case 'list_accounts':
      return new Set([...common, 'status', 'provider'])
    case 'list_decisions':
      return new Set([...common, 'openOnly', 'blocking'])
    case 'get_project':
      return new Set([...common, 'id', 'projectId'])
    case 'get_feature':
      return new Set([...common, 'id', 'featureId'])
    case 'get_task':
      return new Set([...common, 'id', 'taskId'])
    case 'get_run':
      return new Set([...common, 'id', 'runId'])
    case 'get_account':
      return new Set([...common, 'id', 'accountId'])
    case 'get_decision':
      return new Set([...common, 'id', 'decisionId'])
    default:
      return new Set(common)
  }
}

// ---------------------------------------------------------------------------
// Pagination helpers (createdAt, id · default 50 · max 200)
// ---------------------------------------------------------------------------

export interface McpReadPageParams {
  cursor?: string | null
  pageSize?: number | null
  expectedBoardRev: number
  expectedSnapshotRev?: string | null
}

export interface McpReadPageResolved {
  pageSize: number
  cursor: CursorPayload | null
  boardRev: number
  snapshotRev: string | null
}

/**
 * Resolve page params for a list read against the pin revision.
 * Wraps cursor.ts (stable key createdAt,id; default 50; max 200; fail-closed oversize).
 */
export function resolveReadPagination(params: McpReadPageParams): McpReadPageResolved {
  try {
    return resolvePage({
      cursor: params.cursor,
      pageSize: params.pageSize,
      expectedBoardRev: params.expectedBoardRev,
      expectedSnapshotRev: params.expectedSnapshotRev,
    })
  } catch (e) {
    if (e instanceof CursorError) {
      const code: McpReadFilterErrorCode =
        e.code === 'PAGE_SIZE_INVALID' ? 'PAGE_SIZE_INVALID' : 'CURSOR_INVALID'
      throw new McpReadContractError(code, e.message, { cursorCode: e.code })
    }
    throw e
  }
}

/**
 * Paginate a pre-sorted DESC list (createdAt,id). Does not recompute row fields.
 * Input rows must already be ordered and carry createdAt + id.
 */
export function paginateReadRows<T extends { createdAt: string; id: string }>(
  rows: ReadonlyArray<T>,
  params: McpReadPageParams,
): { items: Array<T>; nextCursor: string | null; pageSize: number } {
  try {
    return paginateDesc(rows, params as PageParams)
  } catch (e) {
    if (e instanceof CursorError) {
      const code: McpReadFilterErrorCode =
        e.code === 'PAGE_SIZE_INVALID' ? 'PAGE_SIZE_INVALID' : 'CURSOR_INVALID'
      throw new McpReadContractError(code, e.message, { cursorCode: e.code })
    }
    throw e
  }
}

export function encodeReadCursor(payload: CursorPayload): string {
  try {
    return encodeCursor(payload)
  } catch (e) {
    if (e instanceof CursorError) {
      throw new McpReadContractError('CURSOR_INVALID', e.message, { cursorCode: e.code })
    }
    throw e
  }
}

// ---------------------------------------------------------------------------
// Bounded payload
// ---------------------------------------------------------------------------

/**
 * Fail-closed bound on list item arrays: length must be ≤ resolved pageSize
 * and ≤ MAX_PAGE_SIZE. Does not mutate; returns the same array when within bounds.
 * Never recomputes item contents.
 */
export function boundListPayload<T>(
  items: ReadonlyArray<T>,
  pageSize: number = DEFAULT_PAGE_SIZE,
): ReadonlyArray<T> {
  if (typeof pageSize !== 'number' || !Number.isInteger(pageSize) || pageSize < 1) {
    throw new McpReadContractError('PAGE_SIZE_INVALID', `pageSize must be integer 1..${MAX_PAGE_SIZE}`, {
      pageSize,
    })
  }
  if (pageSize > MAX_PAGE_SIZE) {
    throw new McpReadContractError(
      'PAGE_SIZE_INVALID',
      `pageSize ${pageSize} exceeds maximum ${MAX_PAGE_SIZE}`,
      { pageSize },
    )
  }
  if (items.length > pageSize) {
    throw new McpReadContractError(
      'PAYLOAD_UNBOUNDED',
      `list payload length ${items.length} exceeds pageSize ${pageSize}`,
      { length: items.length, pageSize },
    )
  }
  if (items.length > MAX_PAGE_SIZE) {
    throw new McpReadContractError(
      'PAYLOAD_UNBOUNDED',
      `list payload length ${items.length} exceeds MAX_PAGE_SIZE ${MAX_PAGE_SIZE}`,
      { length: items.length },
    )
  }
  return items
}

/**
 * Resolve and require a bounded pageSize (integer 1..MAX_PAGE_SIZE).
 * Rejects missing non-default when `requireExplicit` is true; otherwise defaults to 50.
 */
export function requireBoundedPageSize(pageSize?: number | null): number {
  try {
    return resolvePageSize(pageSize)
  } catch (e) {
    if (e instanceof CursorError) {
      throw new McpReadContractError('PAGE_SIZE_INVALID', e.message, {
        pageSize,
        cursorCode: e.code,
      })
    }
    throw e
  }
}

/**
 * Build a list envelope from already-paginated, precomputed items.
 * Enforces bound + pin + method contract. No aggregation math.
 * nextCursor validated against pin (no arbitrary passthrough); pageSize bounded.
 */
export function buildListReadEnvelope<T extends { createdAt: string; id: string } | unknown>(
  pin: McpReadPin,
  methodOrAlias: string,
  items: ReadonlyArray<T>,
  opts: {
    nextCursor?: string | null
    pageSize?: number | null
    expectedSnapshotRev?: string | null
  } = {},
): McpPinnedReadEnvelope<{ items: ReadonlyArray<T>; pageSize: number }> {
  const method = resolveCanonicalReadMethod(methodOrAlias)
  if (!method || !isCanonicalListMethod(method)) {
    throw new McpReadContractError(
      'UNKNOWN_METHOD',
      `list envelope requires a list method, got: ${methodOrAlias}`,
      { method: methodOrAlias },
    )
  }
  const pageSize = requireBoundedPageSize(opts.pageSize)
  const bounded = boundListPayload(items, pageSize)
  return buildPinnedReadEnvelope(
    pin,
    { items: bounded, pageSize },
    {
      method: methodOrAlias,
      nextCursor: opts.nextCursor ?? null,
      expectedSnapshotRev: opts.expectedSnapshotRev ?? null,
    },
  )
}

// ---------------------------------------------------------------------------
// Contract introspection (for tests / board-mcp wiring later)
// ---------------------------------------------------------------------------

export interface McpReadMethodSpec {
  name: CanonicalReadMethod
  kind: 'list' | 'get'
  /** True: cursor/pageSize meaningful. */
  supportsCursor: boolean
  defaultPageSize: number
  maxPageSize: number
  cursorOrder: typeof MCP_READ_CURSOR_ORDER
  envelopeSchema: typeof TM_PINNED_ENVELOPE_V1
  /** Aliases that resolve to this method. */
  aliases: CompatibilityAliasName[]
}

export function getCanonicalReadMethodSpec(name: CanonicalReadMethod): McpReadMethodSpec {
  const aliases = COMPATIBILITY_ALIAS_NAMES.filter(
    (a) => COMPATIBILITY_ALIAS_MAP[a].resolvesTo === name,
  )
  const kind: 'list' | 'get' = isCanonicalListMethod(name) ? 'list' : 'get'
  return {
    name,
    kind,
    supportsCursor: kind === 'list',
    defaultPageSize: DEFAULT_PAGE_SIZE,
    maxPageSize: MAX_PAGE_SIZE,
    cursorOrder: MCP_READ_CURSOR_ORDER,
    envelopeSchema: TM_PINNED_ENVELOPE_V1,
    aliases,
  }
}

export function listAllCanonicalReadMethodSpecs(): McpReadMethodSpec[] {
  return CANONICAL_READ_METHODS.map(getCanonicalReadMethodSpec)
}

/**
 * Envelope field names required by API_CONTRACT §3.
 * Used by tests to pin the contract surface.
 */
export const PINNED_ENVELOPE_REQUIRED_KEYS = [
  'schemaVersion',
  'boardId',
  'canonicalSnapshotId',
  'canonicalHash',
  'boardRev',
  'lifecycleRev',
  'generatedAt',
  'freshnessAgeSeconds',
  'stale',
  'staleReason',
  'data',
  'nextCursor',
] as const

/**
 * Typed validation of a pinned envelope (not key-presence alone).
 * Rejects wrong types, empty ids, negative revs, bad schemaVersion, and
 * nextCursor that fails opaque decode + revision pin match.
 */
export function assertPinnedEnvelopeShape(env: McpPinnedReadEnvelope<unknown>): void {
  if (!env || typeof env !== 'object' || Array.isArray(env)) {
    throw new McpReadContractError('PIN_INCOMPLETE', 'envelope must be an object', { env })
  }
  for (const key of PINNED_ENVELOPE_REQUIRED_KEYS) {
    if (!(key in env)) {
      throw new McpReadContractError('PIN_INCOMPLETE', `envelope missing key: ${key}`, { key })
    }
  }
  if (env.schemaVersion !== TM_PINNED_ENVELOPE_V1) {
    throw new McpReadContractError('PIN_INCOMPLETE', 'schemaVersion must be TM_PINNED_ENVELOPE_V1', {
      schemaVersion: env.schemaVersion,
    })
  }
  if (typeof env.boardId !== 'string' || !env.boardId.trim()) {
    throw new McpReadContractError('PIN_INCOMPLETE', 'envelope boardId must be a non-empty string', {
      boardId: env.boardId,
    })
  }
  if (typeof env.canonicalSnapshotId !== 'string' || !env.canonicalSnapshotId.trim()) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope canonicalSnapshotId must be a non-empty string',
      { canonicalSnapshotId: env.canonicalSnapshotId },
    )
  }
  if (typeof env.canonicalHash !== 'string' || !env.canonicalHash.trim()) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope canonicalHash must be a non-empty string',
      { canonicalHash: env.canonicalHash },
    )
  }
  if (typeof env.boardRev !== 'number' || !Number.isInteger(env.boardRev) || env.boardRev < 0) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope boardRev must be a non-negative integer',
      { boardRev: env.boardRev },
    )
  }
  if (
    typeof env.lifecycleRev !== 'number' ||
    !Number.isInteger(env.lifecycleRev) ||
    env.lifecycleRev < 0
  ) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope lifecycleRev must be a non-negative integer',
      { lifecycleRev: env.lifecycleRev },
    )
  }
  if (typeof env.generatedAt !== 'string' || !env.generatedAt) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope generatedAt must be a non-empty string',
      { generatedAt: env.generatedAt },
    )
  }
  if (
    typeof env.freshnessAgeSeconds !== 'number' ||
    !Number.isFinite(env.freshnessAgeSeconds) ||
    env.freshnessAgeSeconds < 0
  ) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope freshnessAgeSeconds must be a finite number >= 0',
      { freshnessAgeSeconds: env.freshnessAgeSeconds },
    )
  }
  if (typeof env.stale !== 'boolean') {
    throw new McpReadContractError('PIN_INCOMPLETE', 'envelope stale must be boolean', {
      stale: env.stale,
    })
  }
  if (!(env.staleReason === null || typeof env.staleReason === 'string')) {
    throw new McpReadContractError(
      'PIN_INCOMPLETE',
      'envelope staleReason must be string or null',
      { staleReason: env.staleReason },
    )
  }
  if (!('data' in env)) {
    throw new McpReadContractError('PIN_INCOMPLETE', 'envelope data is required', {})
  }
  // nextCursor: null or opaque token with matching boardRev.
  // Snapshot pin is NOT re-asserted here (envelope may carry snapshot-bound or
  // boardRev-only cursors). Full snapshot pin is enforced at build time via
  // validateNextCursorForPin(..., { expectedSnapshotRev }).
  if (env.nextCursor !== null) {
    if (typeof env.nextCursor !== 'string' || !env.nextCursor.trim()) {
      throw new McpReadContractError(
        'CURSOR_INVALID',
        'envelope nextCursor must be a non-empty v1 opaque token or null',
        { nextCursor: env.nextCursor },
      )
    }
    let payload: CursorPayload
    try {
      payload = decodeCursor(env.nextCursor)
    } catch (e) {
      if (e instanceof CursorError) {
        throw new McpReadContractError('CURSOR_INVALID', e.message, {
          cursorCode: e.code,
          nextCursor: env.nextCursor,
        })
      }
      throw e
    }
    if (payload.boardRev !== env.boardRev) {
      throw new McpReadContractError(
        'CURSOR_INVALID',
        `cursor boardRev ${payload.boardRev} != envelope boardRev ${env.boardRev}`,
        {
          cursorCode: 'CURSOR_REVISION_MISMATCH',
          cursorBoardRev: payload.boardRev,
          envelopeBoardRev: env.boardRev,
        },
      )
    }
  }
  // Optional metadata fields when present (builders always set them).
  if ('method' in env && env.method != null) {
    if (typeof env.method !== 'string' || !isCanonicalReadMethod(env.method)) {
      throw new McpReadContractError('UNKNOWN_METHOD', 'envelope method must be a canonical read', {
        method: env.method,
      })
    }
  }
  if ('contractVersion' in env && env.contractVersion != null) {
    if (env.contractVersion !== MCP_READ_CONTRACT_VERSION) {
      throw new McpReadContractError(
        'PIN_INCOMPLETE',
        'envelope contractVersion must be TM_MCP_READ_CONTRACT_V1',
        { contractVersion: env.contractVersion },
      )
    }
  }
}

/**
 * Decode nextCursor without revision pin (inspection / tests).
 * Still fail-closed on malformed/tampered tokens.
 */
export function decodeReadCursor(token: string): CursorPayload {
  try {
    return decodeCursor(token)
  } catch (e) {
    if (e instanceof CursorError) {
      throw new McpReadContractError('CURSOR_INVALID', e.message, { cursorCode: e.code })
    }
    throw e
  }
}
