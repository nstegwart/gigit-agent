/**
 * Strict ambient types for qa/e2e/lib/control-plane-schema-seed.mjs (FP-C harness only).
 * Satisfies TS7016 for tests/e2e/fixtures/fp-c-schema-seed.contract.harness.spec.ts.
 */

export const FP_C_REQUIRED_VERSIONS: readonly ['001', '002', '004', '005']

export const FP_C_GREENFIELD_CHAIN_VERSIONS: readonly [
  '000',
  '001',
  '002',
  '003',
  '004',
  '005',
  '006',
]

export const FP_C_CLONE_CHAIN_VERSIONS: readonly [
  '001',
  '002',
  '004',
  '005',
  '006',
]

/** @deprecated use FP_C_CLONE_CHAIN_VERSIONS or FP_C_GREENFIELD_CHAIN_VERSIONS */
export const FP_C_CHAIN_VERSIONS: typeof FP_C_CLONE_CHAIN_VERSIONS

export class ControlPlaneSchemaSeedError extends Error {
  name: 'ControlPlaneSchemaSeedError'
  detail: Record<string, unknown>
  code: string
  constructor(message: string, detail?: Record<string, unknown>)
}

export function splitSqlStatements(sql: string): string[]
export function sha256Hex(content: string | Buffer): string

export type MigrationFile = {
  version: string
  filename: string
  relativePath: string
  classification: string
  sha256: string
  statements: string[]
  abs: string
}

export function loadMigrationFile(version: string): MigrationFile

/** Fail-closed: only disposable iso names. */
export function assertFpCTargetDb(dbName: string | null | undefined): string

export type ApplyControlPlaneSchemaResult = {
  ok: true
  dbName: string
  applied: string[]
  skipped: string[]
  finalApplied: string[]
  requiredPresent: true
  errors: string[]
}

export type ApplySchemaOpts = {
  versions?: readonly string[] | string[]
  boardIds?: string[]
}

export function applyControlPlaneSchemaToIsoDb(
  dbName: string,
  opts?: ApplySchemaOpts,
): Promise<ApplyControlPlaneSchemaResult>

export type FpCAccount = {
  maskedAccountId: string
  status: string
  providerKind: string
  effectiveInUse: number
  effectiveCap: number
  physicalSlotsDisplay: unknown
  adaptiveQuotaState: unknown
  reason: string | null
  statusChangedAt: string
  tombstone: boolean
  [key: string]: unknown
}

export type FpCAccountSnapshot = {
  boardId: string
  sourceRevision: number
  generatedAt: string
  generatedAtMs: number
  accounts: FpCAccount[]
  readbackSurfaces: Record<string, { sourceRevision: number; generatedAt: string }>
  publishedAtMs: number
  lastPeriodicHealthAtMs: number
  stale: boolean
  staleReason: string | null
  usableCapacity: number
  capacity: Record<string, unknown>
  entityRev: number
}

export function buildFpCAccountSnapshotRecord(
  boardId: string,
  opts?: { now?: string; sourceRevision?: number },
): FpCAccountSnapshot

export type FpCRunRecord = {
  boardId: string
  runId: string
  state: string
  planId: string
  planItemRank: number
  taskId: string
  targetGate: string
  role: string
  agentId: string
  model: string
  effort: string
  maskedAccountRef: string
  canonicalHash: string | null
  collisionScopeLockIds: unknown[]
  fencingToken: string
  fencingVersion: number
  registeredAtMs: number
  heartbeatAtMs: number
  leaseExpiresAtMs: number
  materialProgressAtMs: number
  heartbeatSequence: number
  expectedEntityRev: number
  expectedBoardRev: number
  entityRev: number
  boardRev: number
  stalled: boolean
  history: Array<Record<string, unknown>>
  lastHeartbeatResponse: unknown
  controllerRunId: string | null
  parentRunId: string | null
  idempotencyKey: string
}

export function buildFpCRunRecord(
  boardId: string,
  opts?: {
    nowMs?: number
    runId?: string
    state?: string
    planId?: string
    planItemRank?: number
    taskId?: string
    targetGate?: string
    role?: string
    agentId?: string
    model?: string
    effort?: string
    maskedAccountRef?: string
    canonicalHash?: string | null
    collisionScopeLockIds?: unknown[]
    fencingToken?: string
    boardRev?: number
    idempotencyKey?: string
  },
): FpCRunRecord

export type SeedControlPlaneResult = {
  ok: true
  dbName: string
  boards: string[]
  runsSeeded: Array<{ boardId: string; runId: string; state: string }>
  accountsSeeded: Array<{
    boardId: string
    sourceRevision: number
    accountCount: number
    usableCapacity: number
    maskedIds: string[]
  }>
}

export function seedControlPlaneRunAndAccounts(
  dbName: string,
  opts?: ApplySchemaOpts,
): Promise<SeedControlPlaneResult>

export type EnsureFpCResult = {
  ok: true
  dbName: string
  schema: ApplyControlPlaneSchemaResult
  seed: SeedControlPlaneResult
  requiredVersions: string[]
  chainVersions: string[]
}

export function ensureFpCControlPlaneOnIsoDb(
  dbName: string,
  opts?: ApplySchemaOpts,
): Promise<EnsureFpCResult>

export type SelfTestResult = {
  ok: boolean
  results: Array<{ name: string; pass: boolean; detail: unknown }>
}

export function runFpCSchemaSeedSelfTests(): SelfTestResult

export type DisposableFpCProofResult = {
  ok: boolean
  isoDb: string
  host: string
  first: {
    applied: string[]
    skipped: string[]
    runsSeeded: SeedControlPlaneResult['runsSeeded']
    accountsSeeded: SeedControlPlaneResult['accountsSeeded']
  }
  second: {
    applied: string[]
    skipped: string[]
    runsSeeded: number
    accountsSeeded: number
  }
  secondSkippedAll: boolean
  counts: {
    runs: Array<{ board_id: string; n: number | string }>
    accounts: Array<{ board_id: string; source_revision: number; n: number | string }>
    migrations: string[]
  }
  dropped: boolean
  keep: boolean
}

export function runDisposableFpCProof(opts?: {
  isoDbName?: string
  slug?: string
  boardIds?: string[]
  versions?: readonly string[] | string[]
  keepDb?: boolean
}): Promise<DisposableFpCProofResult>
