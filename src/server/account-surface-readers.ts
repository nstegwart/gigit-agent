/**
 * Four actual product consumer service paths for account-sync readback.
 *
 * Surfaces (not an identical-store makeReader abstraction):
 *  - MCP  → list_accounts projection (masked + filters + pagination shape)
 *  - API  → authenticated JSON envelope (session-gated public entrypoint)
 *  - UI   → authenticated control-center account source (Cc read model)
 *  - Ops  → ops account source (capacity/stale/sourceRevision projection)
 *
 * Shared: loadPinnedAuthoritativeAccountSnapshot — one durable reload.
 * Each surface then runs its own serializer / authorization gate / projection
 * and returns sourceRevision + generatedAt + schema.
 *
 * Scheduler post-publish parity invokes these service readers (no HTTP self-calls).
 */
import {
  AccountSyncError,
  projectAccountSyncCcReadModel,
  readLatestAccountSyncSnapshot,
  surfacesHaveParity,
  type AccountSyncReadbackSurface,
  type AccountSyncSnapshot,
  type AccountSyncStore,
  type MaskedAccountRecord,
} from './account-sync'

// ---------------------------------------------------------------------------
// Schemas (stable wire identifiers — each surface has a distinct projection)
// ---------------------------------------------------------------------------

export const ACCOUNT_SURFACE_SCHEMA = {
  mcp: 'ACCOUNT_MCP_LIST_V1',
  api: 'ACCOUNT_API_JSON_V1',
  ui: 'ACCOUNT_UI_SOURCE_V1',
  ops: 'ACCOUNT_OPS_SOURCE_V1',
} as const

export type AccountSurfaceSchema =
  (typeof ACCOUNT_SURFACE_SCHEMA)[keyof typeof ACCOUNT_SURFACE_SCHEMA]

/** Identity returned by every surface service + scheduler reader. */
export interface AccountSurfaceIdentity {
  surface: AccountSyncReadbackSurface
  schema: AccountSurfaceSchema
  boardId: string
  sourceRevision: number
  generatedAt: string
}

/** Identity shape returned by product surface readers (scheduler parity contract). */
export interface ProductSurfaceReadIdentity {
  sourceRevision: number
  generatedAt: string
  schema: AccountSurfaceSchema
}

/**
 * Independent per-surface reader — each surface is a distinct service object
 * (not a single makeReader shared adapter).
 */
export interface ProductAccountSyncSurfaceReader {
  readAuthoritativeIdentity(
    boardId: string,
  ): Promise<ProductSurfaceReadIdentity | null>
}

export type ProductAccountSyncSurfaceReaders = Record<
  AccountSyncReadbackSurface,
  ProductAccountSyncSurfaceReader
>

// ---------------------------------------------------------------------------
// Auth gate (session for API/UI/Ops public entry; system for MCP/scheduler)
// ---------------------------------------------------------------------------

export type AccountSurfaceAuth =
  | { kind: 'system' }
  | {
      kind: 'session'
      user: { id: string; role: string; boards: ReadonlyArray<string> } | null
    }

export class AccountSurfaceAuthError extends Error {
  readonly status: number
  readonly code: string
  constructor(message: string, status = 401, code = 'AUTHORIZATION_REQUIRED') {
    super(message)
    this.name = 'AccountSurfaceAuthError'
    this.status = status
    this.code = code
  }
}

/**
 * Authorization for authenticated product surfaces.
 * - system: scheduler / MCP after secureTool (already authorized upstream)
 * - session: require signed-in user with board access (admin or allowlisted)
 */
export function assertAccountSurfaceAuthorized(
  surface: AccountSyncReadbackSurface,
  boardId: string,
  auth: AccountSurfaceAuth,
): void {
  if (auth.kind === 'system') return
  const user = auth.user
  if (!user) {
    throw new AccountSurfaceAuthError('not signed in', 401, 'AUTHORIZATION_REQUIRED')
  }
  const allowed = user.role === 'admin' || user.boards.includes(boardId)
  if (!allowed) {
    throw new AccountSurfaceAuthError('no access to this board', 403, 'FORBIDDEN_SCOPE')
  }
  // All four surfaces may be session-gated when used via browser/API entrypoints.
  void surface
}

// ---------------------------------------------------------------------------
// Shared pinned authoritative snapshot loader
// ---------------------------------------------------------------------------

/**
 * Single durable reload of the authoritative AccountSyncSnapshot for a board.
 * All four surface services call this first; they never invent capacity/identity.
 */
export async function loadPinnedAuthoritativeAccountSnapshot(
  boardId: string,
  store?: AccountSyncStore | null,
): Promise<AccountSyncSnapshot | null> {
  if (!boardId) return null
  return readLatestAccountSyncSnapshot(boardId, store)
}

// ---------------------------------------------------------------------------
// Shared masking helpers (no tokens/secrets on any surface)
// ---------------------------------------------------------------------------

const SECRET_KEY_RE = /token|secret|password|authorization|api[_-]?key|credential/i

export function stripSecretLikeKeys<T extends Record<string, unknown>>(rec: T): T {
  const out = { ...rec } as Record<string, unknown>
  for (const k of Object.keys(out)) {
    if (SECRET_KEY_RE.test(k)) delete out[k]
  }
  return out as T
}

function maskAccountsForProjection(
  accounts: ReadonlyArray<MaskedAccountRecord>,
  generatedAt: string,
): Array<Record<string, unknown>> {
  return accounts.map((a) => {
    const copy = stripSecretLikeKeys({ ...(a as unknown as Record<string, unknown>) })
    const accountId = String(
      copy.maskedAccountId ?? copy.accountId ?? copy.id ?? 'unknown',
    )
    return {
      ...copy,
      id: accountId,
      accountId,
      status: copy.status,
      provider: copy.providerKind ?? copy.provider ?? null,
      createdAt: generatedAt,
    }
  })
}

// ---------------------------------------------------------------------------
// MCP list_accounts projection
// ---------------------------------------------------------------------------

export interface McpListAccountsFilters {
  status?: string
  provider?: string
  cursor?: string
  pageSize?: number
}

export interface McpListAccountsProjection extends AccountSurfaceIdentity {
  schema: typeof ACCOUNT_SURFACE_SCHEMA.mcp
  accounts: Array<Record<string, unknown>>
  items: Array<Record<string, unknown>>
  pageSize: number
  nextCursor: string | null
  stale: boolean
  capacity: AccountSyncSnapshot['capacity'] | null
  usableCapacity: number
  /** Current durable account-snapshot CAS revision for the next ROOT sync_accounts write. */
  entityRev: number
}

/**
 * Real MCP list_accounts serializer (masked rows + optional status/provider filters).
 * Returns the full filtered set; board-mcp applies pin-aware paginateReadRows.
 * Optional pageSize/cursor here only when `applySimplePage` is true (scheduler
 * identity path does not need paging — full set still carries sourceRevision).
 */
export function projectMcpListAccounts(
  snap: AccountSyncSnapshot | null | undefined,
  opts: {
    boardId: string
    filters?: McpListAccountsFilters
    /** When true, apply simple numeric cursor/pageSize slice (non-pin consumers). */
    applySimplePage?: boolean
  },
): McpListAccountsProjection | null {
  if (!snap) return null
  const generatedAt = snap.generatedAt
  let accounts = maskAccountsForProjection(snap.accounts, generatedAt)
  const status = opts.filters?.status
  const provider = opts.filters?.provider
  if (status) {
    accounts = accounts.filter((a) => String(a.status ?? '') === status)
  }
  if (provider) {
    accounts = accounts.filter((a) => String(a.provider ?? '') === provider)
  }
  accounts.sort(
    (a, b) =>
      String(b.createdAt).localeCompare(String(a.createdAt)) ||
      String(b.id).localeCompare(String(a.id)),
  )
  const pageSize = Math.min(
    200,
    Math.max(
      1,
      opts.filters?.pageSize && Number.isFinite(opts.filters.pageSize)
        ? Math.trunc(opts.filters.pageSize)
        : 50,
    ),
  )
  let slice = accounts
  let nextCursor: string | null = null
  if (opts.applySimplePage) {
    let start = 0
    if (opts.filters?.cursor) {
      const n = Number(opts.filters.cursor)
      if (Number.isFinite(n) && n >= 0) start = Math.trunc(n)
    }
    slice = accounts.slice(start, start + pageSize)
    nextCursor =
      start + pageSize < accounts.length ? String(start + pageSize) : null
  }
  return {
    surface: 'mcp',
    schema: ACCOUNT_SURFACE_SCHEMA.mcp,
    boardId: opts.boardId,
    sourceRevision: snap.sourceRevision,
    generatedAt: snap.generatedAt,
    accounts: slice,
    items: slice,
    pageSize,
    nextCursor,
    stale: snap.stale,
    capacity: snap.capacity ?? null,
    usableCapacity: snap.usableCapacity,
    entityRev: snap.entityRev,
  }
}

export async function readMcpListAccountsService(input: {
  boardId: string
  accounts: AccountSyncStore
  filters?: McpListAccountsFilters
  auth?: AccountSurfaceAuth
}): Promise<McpListAccountsProjection | null> {
  assertAccountSurfaceAuthorized(
    'mcp',
    input.boardId,
    input.auth ?? { kind: 'system' },
  )
  const snap = await loadPinnedAuthoritativeAccountSnapshot(
    input.boardId,
    input.accounts,
  )
  return projectMcpListAccounts(snap, {
    boardId: input.boardId,
    filters: input.filters,
  })
}

// ---------------------------------------------------------------------------
// Authenticated API JSON envelope
// ---------------------------------------------------------------------------

export interface AuthenticatedApiAccountsEnvelope extends AccountSurfaceIdentity {
  schema: typeof ACCOUNT_SURFACE_SCHEMA.api
  ok: true
  stale: boolean
  staleReason: string | null
  usableCapacity: number
  readbackParityOk: boolean
  accounts: Array<Record<string, unknown>>
  entityRev: number
}

/**
 * Authenticated API JSON serializer — distinct envelope from MCP pin shape.
 * Never includes tokens/secrets.
 */
export function projectAuthenticatedApiAccounts(
  snap: AccountSyncSnapshot | null | undefined,
  opts: { boardId: string },
): AuthenticatedApiAccountsEnvelope | null {
  if (!snap) return null
  const parity = surfacesHaveParity(
    snap.readbackSurfaces,
    snap.sourceRevision,
    snap.generatedAt,
  )
  return {
    surface: 'api',
    schema: ACCOUNT_SURFACE_SCHEMA.api,
    boardId: opts.boardId,
    sourceRevision: snap.sourceRevision,
    generatedAt: snap.generatedAt,
    ok: true,
    stale: snap.stale,
    staleReason: snap.staleReason,
    usableCapacity: snap.usableCapacity,
    readbackParityOk: parity,
    accounts: maskAccountsForProjection(snap.accounts, snap.generatedAt),
    entityRev: snap.entityRev,
  }
}

export async function readAuthenticatedApiAccountsService(input: {
  boardId: string
  accounts: AccountSyncStore
  auth: AccountSurfaceAuth
}): Promise<AuthenticatedApiAccountsEnvelope | null> {
  assertAccountSurfaceAuthorized('api', input.boardId, input.auth)
  const snap = await loadPinnedAuthoritativeAccountSnapshot(
    input.boardId,
    input.accounts,
  )
  return projectAuthenticatedApiAccounts(snap, { boardId: input.boardId })
}

// ---------------------------------------------------------------------------
// Authenticated UI account source (control-center)
// ---------------------------------------------------------------------------

export interface AuthenticatedUiAccountSource extends AccountSurfaceIdentity {
  schema: typeof ACCOUNT_SURFACE_SCHEMA.ui
  /** Projected CC read model (authoritative account source for UI). */
  readModel: NonNullable<ReturnType<typeof projectAccountSyncCcReadModel>>
  authoritative: true
  stale: boolean
  staleReason: string | null
  usableCapacity: number
  readbackParityOk: boolean
}

/**
 * UI account source — real control-center projection (projectAccountSyncCcReadModel).
 * Fail-closed callers treat null as ACCOUNT_SYNC_MISSING / usableCapacity=0.
 */
export function projectAuthenticatedUiAccountSource(
  snap: AccountSyncSnapshot | null | undefined,
  opts: { boardId: string },
): AuthenticatedUiAccountSource | null {
  const readModel = projectAccountSyncCcReadModel(snap)
  if (!readModel) return null
  return {
    surface: 'ui',
    schema: ACCOUNT_SURFACE_SCHEMA.ui,
    boardId: opts.boardId,
    sourceRevision: readModel.sourceRevision,
    generatedAt: readModel.generatedAt,
    readModel,
    authoritative: true,
    stale: readModel.stale,
    staleReason: readModel.staleReason,
    usableCapacity: readModel.usableCapacity,
    readbackParityOk: readModel.readbackParityOk,
  }
}

export async function readAuthenticatedUiAccountSourceService(input: {
  boardId: string
  accounts: AccountSyncStore
  auth?: AccountSurfaceAuth
}): Promise<AuthenticatedUiAccountSource | null> {
  assertAccountSurfaceAuthorized(
    'ui',
    input.boardId,
    input.auth ?? { kind: 'system' },
  )
  const snap = await loadPinnedAuthoritativeAccountSnapshot(
    input.boardId,
    input.accounts,
  )
  return projectAuthenticatedUiAccountSource(snap, { boardId: input.boardId })
}

// ---------------------------------------------------------------------------
// Ops account source
// ---------------------------------------------------------------------------

export interface OpsAccountSource extends AccountSurfaceIdentity {
  schema: typeof ACCOUNT_SURFACE_SCHEMA.ops
  accounts: Array<Record<string, unknown>>
  usableCapacity: number
  accountSyncStale: boolean
  staleReason: string | null
  readbackParityOk: boolean
  quarantineCount: number
}

/**
 * Ops account source — capacity / stale / sourceRevision projection used by Ops surface.
 * Distinct from UI Cc read model (ops fields + quarantine count).
 */
export function projectOpsAccountSource(
  snap: AccountSyncSnapshot | null | undefined,
  opts: { boardId: string },
): OpsAccountSource | null {
  if (!snap) return null
  const parity = surfacesHaveParity(
    snap.readbackSurfaces,
    snap.sourceRevision,
    snap.generatedAt,
  )
  const accounts = maskAccountsForProjection(snap.accounts, snap.generatedAt)
  const quarantineCount = snap.accounts.filter(
    (a) =>
      a.tombstone ||
      a.status === 'REMOVED' ||
      a.status === 'BAN' ||
      a.status === '403' ||
      a.status === 'AUTH_EXPIRED' ||
      a.status === 'quarantine',
  ).length
  const accountSyncStale = snap.stale || !parity
  return {
    surface: 'ops',
    schema: ACCOUNT_SURFACE_SCHEMA.ops,
    boardId: opts.boardId,
    sourceRevision: snap.sourceRevision,
    generatedAt: snap.generatedAt,
    accounts,
    usableCapacity: accountSyncStale ? 0 : snap.usableCapacity,
    accountSyncStale,
    staleReason: accountSyncStale
      ? snap.staleReason ?? (!parity ? 'ACCOUNT_SYNC_PARITY_INVALID' : null)
      : snap.staleReason,
    readbackParityOk: parity,
    quarantineCount,
  }
}

export async function readOpsAccountSourceService(input: {
  boardId: string
  accounts: AccountSyncStore
  auth?: AccountSurfaceAuth
}): Promise<OpsAccountSource | null> {
  assertAccountSurfaceAuthorized(
    'ops',
    input.boardId,
    input.auth ?? { kind: 'system' },
  )
  const snap = await loadPinnedAuthoritativeAccountSnapshot(
    input.boardId,
    input.accounts,
  )
  return projectOpsAccountSource(snap, { boardId: input.boardId })
}

// ---------------------------------------------------------------------------
// Product surface readers for scheduler post-publish parity
// ---------------------------------------------------------------------------

/**
 * Four independent product service readers. Each invoke is a full service path:
 * load pinned snapshot → surface-specific project → return identity (+ schema).
 * Not a single makeReader(_surface) shared echo adapter.
 */
export function createProductAccountSyncSurfaceReaders(
  accounts: AccountSyncStore,
): ProductAccountSyncSurfaceReaders {
  if (!accounts || typeof accounts.get !== 'function') {
    throw new AccountSyncError(
      'INVALID_INPUT',
      'createProductAccountSyncSurfaceReaders requires AccountSyncStore',
    )
  }

  const mcp: ProductAccountSyncSurfaceReader = {
    async readAuthoritativeIdentity(boardId) {
      const r = await readMcpListAccountsService({
        boardId,
        accounts,
        auth: { kind: 'system' },
      })
      if (!r) return null
      return {
        sourceRevision: r.sourceRevision,
        generatedAt: r.generatedAt,
        schema: r.schema,
      }
    },
  }

  const api: ProductAccountSyncSurfaceReader = {
    async readAuthoritativeIdentity(boardId) {
      // System path for scheduler parity (no HTTP). Public entrypoint enforces session.
      const r = await readAuthenticatedApiAccountsService({
        boardId,
        accounts,
        auth: { kind: 'system' },
      })
      if (!r) return null
      return {
        sourceRevision: r.sourceRevision,
        generatedAt: r.generatedAt,
        schema: r.schema,
      }
    },
  }

  const ui: ProductAccountSyncSurfaceReader = {
    async readAuthoritativeIdentity(boardId) {
      const r = await readAuthenticatedUiAccountSourceService({
        boardId,
        accounts,
        auth: { kind: 'system' },
      })
      if (!r) return null
      return {
        sourceRevision: r.sourceRevision,
        generatedAt: r.generatedAt,
        schema: r.schema,
      }
    },
  }

  const ops: ProductAccountSyncSurfaceReader = {
    async readAuthoritativeIdentity(boardId) {
      const r = await readOpsAccountSourceService({
        boardId,
        accounts,
        auth: { kind: 'system' },
      })
      if (!r) return null
      return {
        sourceRevision: r.sourceRevision,
        generatedAt: r.generatedAt,
        schema: r.schema,
      }
    },
  }

  // Distinct object identities (not one shared adapter).
  return { mcp, api, ui, ops }
}
