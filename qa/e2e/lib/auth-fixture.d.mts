/**
 * Strict ambient types for qa/e2e/lib/auth-fixture.mjs (harness only).
 * Satisfies TS7016 for playwright.config.ts + tests/e2e/fixtures/* imports.
 */

export const SESSION_COOKIE_NAME: 'cairn_session'
export const AUTH_STORAGE_STATE_PATH: string
export const AUTH_FIXTURE_SKIP_DATA_TABLES: readonly string[]
export const AUTH_FIXTURE_OWNED_DB_PREFIX: string

export type McpPrincipalMeta = {
  role: string
  actorId?: string
  tokenId?: string
  boardId: string | null
  unbound: boolean
  hasSecret: boolean
  reused?: boolean
  secretByteLength?: number
  secretEncoding?: string
}

export type AuthRuntimeMeta = {
  mode?: 'isolated-clone' | 'skip-iso' | string
  runId?: string
  ownedDbPrefix?: string
  runtimeMetaPath?: string
  secretsSidecarPath?: string
  preparedAt?: string
  username?: string
  mcpPrincipalMeta?: McpPrincipalMeta
  boardId?: string | null
  isoDb?: string
  sourceDb?: string
  host?: string
  port?: number
  tableStats?: Record<string, { clonedRows: number; skippedData: boolean }>
  userCount?: number
  storageStatePath?: string
  dbName?: string | null
  note?: string
  cleanup?: AuthCleanupResult
  [key: string]: unknown
}

export type AuthCleanupResult = {
  cleanedAt: string
  dbDropped: boolean
  dbDropSkipped?: string | null
  storageErased: boolean
  storageStatePath?: string
  envScrubbed: string[]
  mode: string | null
  isoDb: string | null
  runId?: string
  runtimeMetaPath?: string
  secretsSidecarErased?: boolean
  dbDropError?: string
  storageEraseError?: string
}

export type AuthSecretsResult = {
  username: string
  hasPassword: true
  mcpPrincipalMeta: McpPrincipalMeta
  boardId: string | null
  runId: string
  runtimeMetaPath: string
  secretsSidecarPath: string
  storageStatePath: string
}

export type McpAuthFixture = {
  bearer: string
  principalsJson: string
  childEnv: { CAIRN_BEARER_PRINCIPALS_JSON: string }
  principalMeta: McpPrincipalMeta
  boardId: string | null
}

export type PrepareIsolatedAuthResult = AuthRuntimeMeta & {
  ok: true
  secretsApplied: true
  reused?: boolean
  clone?: {
    ok: true
    isoDb: string
    sourceDb: string
    host: string
    port: number
    tableStats: Record<string, { clonedRows: number; skippedData: boolean }>
    userCount: number
    note: string
  }
}

export type SeedSessionResult = {
  userId: string
  username: string
  tokenPresent: true
  storageStatePath: string
  dbName: string
  baseUrl: string
  method: 'product-schema-session-seed'
}

export function resolveAuthRunId(opts?: { runId?: string }): string
export function resolveAuthRuntimeMetaPath(opts?: {
  runId?: string
  metaPath?: string
}): string
export function resolveAuthSecretsSidecarPath(opts?: {
  runId?: string
  secretsPath?: string
}): string
export function resolveAuthStorageStatePath(opts?: {
  runId?: string
  storagePath?: string
}): string

/** @deprecated Prefer resolveAuthRuntimeMetaPath — exported as callable alias. */
export function AUTH_RUNTIME_META_PATH(opts?: {
  runId?: string
  metaPath?: string
}): string
/** @deprecated Prefer resolveAuthSecretsSidecarPath — exported as callable alias. */
export function AUTH_SECRETS_SIDECAR_PATH(opts?: {
  runId?: string
  secretsPath?: string
}): string
/** @deprecated Prefer resolveAuthStorageStatePath — exported as callable alias. */
export function AUTH_STORAGE_STATE_RESOLVER(opts?: {
  runId?: string
  storagePath?: string
}): string

export function generateE2ECredentials(opts?: {
  username?: string
  password?: string
}): { username: string; password: string }

export function generateMcpAuthFixture(opts?: {
  forceNew?: boolean
  boardId?: string
  actorId?: string
  tokenId?: string
}): McpAuthFixture

export function mcpAuthHeaders(bearer?: string): { Authorization: string }

export function loadSecretsSidecar(): boolean
export function writeSecretsSidecar(): string
export function eraseSecretsSidecar(): boolean
export function ensureAuthSecretsInEnv(opts?: {
  forceNew?: boolean
  runId?: string
  username?: string
  password?: string
  boardId?: string
  storagePath?: string
}): AuthSecretsResult

export function cloneAmbientBoardsToIsolatedDb(opts?: {
  sourceDbName?: string
  isoDbName?: string
  slug?: string
  skipDataTables?: string[]
}): Promise<{
  ok: true
  isoDb: string
  sourceDb: string
  host: string
  port: number
  tableStats: Record<string, { clonedRows: number; skippedData: boolean }>
  userCount: number
  note: string
}>

export function readRuntimeMeta(): AuthRuntimeMeta | null
export function isOwnedIsoDbForCleanup(
  meta: AuthRuntimeMeta | null | undefined,
  runId?: string,
): boolean

export function prepareIsolatedAuthFixture(opts?: {
  forceNew?: boolean
  skipIso?: boolean
  slug?: string
  isoDbName?: string
  sourceDbName?: string
  runId?: string
}): Promise<PrepareIsolatedAuthResult>

export function cleanupIsolatedAuthFixture(opts?: {
  keepDb?: boolean
  keepStorage?: boolean
  runId?: string
}): Promise<AuthCleanupResult>

export function seedProductAdminSessionAndStorageState(opts?: {
  dbName?: string
  outPath?: string
  baseUrl?: string
  username?: string
  password?: string
  force?: boolean
}): Promise<SeedSessionResult>

export const SENSITIVE_ENV_KEYS: readonly string[]
export function redactSecretsDeep<T>(value: T, secrets?: string[]): T
