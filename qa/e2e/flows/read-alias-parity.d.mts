/**
 * Strict ambient types for qa/e2e/flows/read-alias-parity.mjs (AC-API harness only).
 * Satisfies TS7016 for tests/unit/read-alias-parity-harness.test.ts.
 */

export const HARNESS_ID: 'read-alias-parity-v1'
export const CONTRACT_ID: 'TM_MCP_READ_ALIAS_PARITY_V1'
export const TM_PINNED_ENVELOPE_V1: 'TM_PINNED_ENVELOPE_V1'
export const MCP_READ_CONTRACT_VERSION: 'TM_MCP_READ_CONTRACT_V1'
export const MCP_READ_CURSOR_ORDER: 'createdAt DESC, id DESC'
export const DEFAULT_PAGE_SIZE: 50
export const MAX_PAGE_SIZE: 200
export const BOARD_DEFAULT: 'mfs-rebuild'

export const PINNED_ENVELOPE_REQUIRED_KEYS: readonly string[]
export const PINNED_ENVELOPE_META_KEYS: readonly string[]
export const SHARED_PIN_KEYS: readonly string[]

export type CompatibilityAliasEntry = {
  alias: string
  resolvesTo: string
  slice: string
  kind: 'get' | 'list' | string
  scopes: readonly string[]
  note: string
}

export const COMPATIBILITY_ALIAS_MATRIX: readonly CompatibilityAliasEntry[]
export const PRIMARY_OVERVIEW_ALIASES: readonly string[]
export const CANONICAL_LIST_METHODS: readonly string[]

export type CheckResult = {
  id: string
  ok: boolean
  detail?: string
}

export type ShapeCheckResult = {
  ok: boolean
  errors: string[]
}

export type FilterCheckResult = {
  ok: boolean
  filters?: Record<string, unknown>
  errors: string[]
}

export type AuthCheckResult = {
  ok: boolean
  errors: string[]
}

export type EnvelopeCheckResult = {
  ok: boolean
  errors: string[]
}

export type RecomputeCheckResult = {
  ok: boolean
  errors: string[]
  env?: Record<string, unknown>
}

export type FixturePin = {
  boardId: string
  canonicalSnapshotId: string
  canonicalHash: string
  boardRev: number
  lifecycleRev: number
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
  [key: string]: unknown
}

export type PinnedEnvelope = {
  schemaVersion: string
  boardId: unknown
  canonicalSnapshotId: unknown
  canonicalHash: unknown
  boardRev: unknown
  lifecycleRev: unknown
  generatedAt: unknown
  freshnessAgeSeconds: unknown
  stale: unknown
  staleReason: unknown
  data: unknown
  nextCursor: string | null
  method: string
  requestedAs: string
  contractVersion: string
  [key: string]: unknown
}

export type CursorPayload = {
  createdAt: string
  id: string
  boardRev: number
  snapshotRev?: string | null
  order?: 'DESC'
}

export type DecodedCursor = {
  createdAt: string
  id: string
  boardRev: number
  snapshotRev: string | null
  order: 'DESC'
}

export type ToolSpecLike = {
  name: string
  scopes?: string[]
  aliasOf?: string
  kind?: string
}

export type BearerRefResult =
  | { ok: true; tokenRef: string; bearer: string; reason?: undefined }
  | { ok: false; tokenRef: null; bearer: null; reason: string }

export type SummaryResult = {
  harness: string
  contract: string
  mode: string
  total: number
  passed: number
  failed: string[]
  residual_gaps: string
}

export function resolveAliasEntry(name: string): CompatibilityAliasEntry | null

export function resolveCanonicalMethod(
  name: string,
  matrix?: ReadonlyArray<{ alias: string; resolvesTo: string }>,
): string | null

export function resolvePageSize(pageSize: number | null | undefined): number

export function encodeCursorFixture(payload: CursorPayload): string
export function decodeCursorFixture(token: string): DecodedCursor

export function buildFixturePinnedEnvelope(
  pin: Record<string, unknown>,
  data: unknown,
  opts: { method: string; nextCursor?: string | null },
): PinnedEnvelope

export function assertPinnedEnvelopeShape(env: unknown): ShapeCheckResult

export function assertAuthParity(
  aliasSpec: ToolSpecLike | null | undefined,
  targetSpec: ToolSpecLike | null | undefined,
  expected: { alias: string; resolvesTo: string; scopes: readonly string[] },
): AuthCheckResult

export function assertEnvelopeParity(
  aliasEnv: Record<string, unknown>,
  canonicalEnv: Record<string, unknown>,
  entry: { alias: string; resolvesTo: string },
): EnvelopeCheckResult

export function validateSharedFilters(
  methodOrAlias: string,
  raw: Record<string, unknown>,
): FilterCheckResult

export function assertNoIndependentRecompute(
  pin: Record<string, unknown>,
  precomputed: Record<string, unknown>,
  methodOrAlias: string,
): RecomputeCheckResult

export function scopesEqual(a: readonly string[], b: readonly string[]): boolean

export function baseFixturePin(over?: Partial<Record<string, unknown>>): FixturePin

export function record(
  results: CheckResult[],
  id: string,
  ok: boolean,
  detail?: string,
): void

export function runSelfTest(opts?: { silent?: boolean }): CheckResult[]

export function resolveBearerRef(
  env?: NodeJS.ProcessEnv | Record<string, string | undefined>,
): BearerRefResult

export function parseToolPayload(json: unknown): unknown

export function mcpToolsCall(
  baseUrl: string,
  name: string,
  args: Record<string, unknown>,
  bearer: string,
): Promise<{
  status: number
  json: unknown
  rawText: string
  payload: unknown
}>

export function runLiveReadOnlyParity(cfg: {
  baseUrl: string
  boardId: string
  bearer: string
}): Promise<CheckResult[]>

export function summarize(results: CheckResult[], mode: string): SummaryResult

export function writeReceipt(summary: SummaryResult, results: CheckResult[]): string
