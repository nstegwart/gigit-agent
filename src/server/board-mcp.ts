// Real MCP board tools (async, MySQL-backed via board-store). Every board tool is
// boardId-scoped (default = the first board). Registered on the McpServer in mcp.ts.
// V3 C2A: tools/list filtered by principal; tools/call rechecks scope; public-only when unauth.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { buildModel } from '#/lib/model'
import { deriveCheckpoints, nextEvidence, nextStage, stageReadiness } from '#/lib/readiness'
import type { Feature } from '#/lib/types'
import { advanceTask, computeRollup, initLifecycleStage, readAudit, readLifecycle, writeLifecycle } from '#/server/lifecycle-store'
import { taskLifecycle } from '#/server/tasks-store'
import { decideDecision, deleteBoard, deleteProject, setQueue, updateBoard, upsertProject } from '#/server/board-store'
import {
  addComment,
  addComponent,
  addTaskSection,
  boardHash,
  createBoard,
  defaultBoardId,
  deleteFeature,
  deleteTask,
  removeTaskSection,
  setTaskSections,
  updateTaskSection,
  listBoards,
  openDecision,
  readBoard,
  readConventions,
  readGuide,
  readProd,
  readTask,
  readTasks,
  replaceAccounts,
  setBlocked,
  setFeaturePhase,
  setGuide,
  setProd,
  setProjectDesign,
  setRunStatus,
  toggleTask,
  upsertFeature,
  upsertTask,
  upsertRun,
} from '#/server/board-store'
import {
  assertAgentOwnRun,
  assertIntegratorBounds,
  authErrorEnvelope,
  authorizeToolCall,
  isToolListable,
  type AuthMechanismState,
  type Principal,
} from '#/server/rbac'
import {
  getSharedPublicSnapshotService,
  resetPublicSnapshotServiceForTests,
} from '#/server/public-snapshot-service'
import {
  getControlPlaneRuntimeContext,
  peekControlPlaneRuntimeContext,
  resetControlPlaneRuntimeContextForTests,
  setTestControlPlaneRuntimeContext,
  createMemoryControlPlaneRuntimeContext,
  type ControlPlaneRuntimeContext,
} from '#/server/control-plane-runtime-context'
import {
  buildPinnedReadEnvelope,
  paginateReadRows,
  validateReadFilters,
  type McpReadPin,
  McpReadContractError,
} from '#/server/mcp-canonical-reads'
import {
  selectNextFromActivePlan,
  publishDispatchPlan,
  getSharedDispatchPlanStore,
  setSharedDispatchPlanStore,
  projectDispatchNextFields,
  asLegacyFeatureQueue,
  type DispatchPlanStore,
} from '#/server/control-plane-ingest'
import {
  registerRun,
  heartbeatRun,
  type RunRegistryDeps,
  type RunRegistryStore,
} from '#/server/run-registry'
import {
  createSystemClock,
  type ControlPlaneAtomicStore,
  type ControlPlaneClock,
} from '#/server/board-store'
import {
  beginIdempotent,
  completeIdempotent,
  IdempotencyError,
  type IdempotencyStorage,
} from '#/server/idempotency'
import type { LockStore } from '#/server/locks'
import {
  evaluateCas,
  STALE_REVISION,
  type RevisionState,
} from '#/server/revisions'
import {
  evaluateCapacityPolicy,
  syncAccounts,
  getSharedAccountSyncStore,
  setSharedAccountSyncStore,
  type AccountSyncStore,
  type AccountSyncDeps,
  type AccountProviderKind,
  type MaskedAccountStatus,
  type SyncAccountsRequest,
  type SyncAccountsResult,
} from '#/server/account-sync'
import {
  openDecisionV3,
  resolveDecisionV3,
  type DecisionV3Store,
  type DecisionV3Deps,
} from '#/server/decisions-v3'
import {
  dryRunReconcile,
  applyReconcile,
  claimReconcilerLeadership,
  type ReconcilerStore,
  type ReconcilerDeps,
} from '#/server/reconciler'
import { evaluateG5, G5_REQUIRED_DOMAINS } from '#/server/g5'
import type { PinnedRevisionTuple } from '#/lib/control-plane-types'
import {
  applyImport,
  planImport,
  type ImportApplyResult,
  type ImportAuthContext,
  type ImportPlanResult,
} from '#/server/canonical-import'
import {
  produceCanonicalSnapshot,
  type CanonicalSnapshot,
  type CanonicalSnapshotInput,
} from '#/server/canonical-snapshot'
import {
  createCanonicalDefinitionReadAdapter,
  isPinComplete,
  isSyntheticCanonicalSnapshotId,
  loadPinnedDefinitionReadModel,
  tryLoadPinnedDefinitionReadModel,
  type CanonicalDefinitionProjection,
  type CanonicalDefinitionReadModel,
} from '#/server/canonical-read-model'
import { computeRollupV3, type RollupTaskInput } from '#/server/rollup-v3'
import type { RollupV3Result, TaskClassificationRecord } from '#/lib/control-plane-types'
import { createHash } from 'node:crypto'
import type { OpsData, WorkTask } from '#/lib/types'

export interface McpAuthContext {
  principal: Principal | null
  mechanism: AuthMechanismState
  bearerPresent: boolean
  /**
   * Non-spoofable client IP for PUBLIC_SNAPSHOT_RATE_LIMIT_V1 keying.
   * Must come from socket/runtime or trusted-edge injection — never raw XFF.
   * Required for unauth get_public_snapshot tool + resource (shared with HTTP).
   */
  clientIp?: string
}

function jsonText(value: unknown) {
  return { content: [{ type: 'text' as const, text: JSON.stringify(value, null, 2) }] }
}
/** §4: assignedRunId = only a queued/running assignment; a finished verifier moves to lastRunId/lastVerifierRunId. */
function runInfo(runs?: Array<{ id: string; status: string; role?: string; verdict?: string | null; updated?: string; started?: string }>) {
  const rs = runs ?? []
  const assigned = rs.find((r) => r.status === 'running' || r.status === 'queued')?.id ?? null
  const sorted = [...rs].sort((a, b) => (b.updated ?? b.started ?? '').localeCompare(a.updated ?? a.started ?? ''))
  const lastRunId = sorted[0]?.id ?? null
  const lastVerifierRunId = sorted.find((r) => r.status === 'done' && (!!r.verdict || /verif/i.test(r.role ?? '')))?.id ?? null
  return { assignedRunId: assigned, lastRunId, lastVerifierRunId }
}
const bid = async (boardId?: string) => boardId || (await defaultBoardId())
const modelOf = async (boardId?: string) => buildModel(await readBoard(await bid(boardId)))
const BOARD_ARG = { boardId: z.string().optional().describe('Board id (default = the first board)') }

function featureSummary(f: Feature) {
  return {
    id: f.id, nama: f.nama, fase: f.fase, phaseLabel: f.phaseLabel, blocked: f.blocked ?? null,
    isBlocked: f.isBlocked, projectId: f.projectId, taskDone: f.taskDone, taskTotal: f.taskTotal, pct: f.pct,
  }
}

/**
 * Control-plane deps for V3 MCP.
 *
 * Production/default: ONE durable context via getControlPlaneRuntimeContext()
 * (MySQL F1/F2/atomic). Memory is ONLY via explicit test injection
 * (setTestControlPlaneRuntimeContext / setMcp* injectors).
 * Missing capacity always fail-closed (BLOCKED/zero).
 */
let mcpRunDeps: RunRegistryDeps | null = null
/** Explicit test injectors — take precedence over durable context when set. */
let mcpRunStore: RunRegistryStore | null = null
let mcpDecisionStore: DecisionV3Store | null = null
let mcpReconcilerStore: ReconcilerStore | null = null
let mcpAtomic: ControlPlaneAtomicStore | null = null
let mcpLocks: LockStore | null = null
let mcpIdempotency: IdempotencyStorage | null = null
/** True when setMcpPlanStore / setMcpAccountStore installed an explicit override. */
let mcpPlanStoreExplicit = false
let mcpAccountStoreExplicit = false

/**
 * Resolve the single durable control-plane context for MCP default path.
 * Installs durable plans/accounts into process shared stores so board.ts
 * getNextFn / control-center readers see the same authority.
 */
export function resolveMcpRuntimeContext(): ControlPlaneRuntimeContext {
  const ctx = getControlPlaneRuntimeContext()
  if (!mcpPlanStoreExplicit) {
    setSharedDispatchPlanStore(ctx.runtime.plans)
  }
  if (!mcpAccountStoreExplicit) {
    setSharedAccountSyncStore(ctx.runtime.accounts)
  }
  return ctx
}

export function setMcpRunRegistryDeps(deps: RunRegistryDeps | null): void {
  mcpRunDeps = deps
}
/** Wire MCP publish/get_next to an explicit plan store (tests) or clear override. */
export function setMcpPlanStore(store: DispatchPlanStore | null): void {
  setSharedDispatchPlanStore(store)
  mcpPlanStoreExplicit = store != null
}
/**
 * Wire MCP sync_accounts / capacity to an explicit account-sync store (tests).
 */
export function setMcpAccountStore(store: AccountSyncStore | null): void {
  setSharedAccountSyncStore(store)
  mcpAccountStoreExplicit = store != null
}
export function setMcpDecisionStore(store: DecisionV3Store | null): void {
  mcpDecisionStore = store
}
export function setMcpReconcilerStore(store: ReconcilerStore | null): void {
  mcpReconcilerStore = store
}
export function setMcpAtomic(store: ControlPlaneAtomicStore | null): void {
  mcpAtomic = store
}
export function resetMcpControlPlaneDeps(): void {
  mcpRunDeps = null
  mcpRunStore = null
  setSharedDispatchPlanStore(null)
  setSharedAccountSyncStore(null)
  mcpPlanStoreExplicit = false
  mcpAccountStoreExplicit = false
  mcpDecisionStore = null
  mcpReconcilerStore = null
  mcpAtomic = null
  mcpLocks = null
  mcpIdempotency = null
  resetPublicSnapshotServiceForTests()
}

/** Re-export test helpers so MCP unit suites can inject memory durable context. */
export {
  setTestControlPlaneRuntimeContext,
  resetControlPlaneRuntimeContextForTests,
  createMemoryControlPlaneRuntimeContext,
}

function systemClock(): ControlPlaneClock {
  const peek = peekControlPlaneRuntimeContext()
  if (peek) return peek.clock
  return createSystemClock()
}

function sharedAtomic(_seedBoardId?: string, _boardRev = 0): ControlPlaneAtomicStore {
  if (mcpAtomic) return mcpAtomic
  return resolveMcpRuntimeContext().atomic
}

function sharedLocks(): LockStore {
  if (mcpLocks) return mcpLocks
  return resolveMcpRuntimeContext().runtime.locks
}

function sharedIdempotency(): IdempotencyStorage {
  if (mcpIdempotency) return mcpIdempotency
  return resolveMcpRuntimeContext().idempotency
}

/**
 * Process-wide run registry: durable context.runtime.runs (or explicit inject).
 * register_run then heartbeat_run share the same store.
 */
function sharedRunStore(): RunRegistryStore {
  if (mcpRunStore) return mcpRunStore
  return resolveMcpRuntimeContext().runtime.runs
}

/** Sole plan store: durable context (installed into process shared for board.ts). */
function sharedPlanStore(): DispatchPlanStore {
  if (mcpPlanStoreExplicit) return getSharedDispatchPlanStore()
  return resolveMcpRuntimeContext().runtime.plans
}

/**
 * Sole account-sync store: durable context.runtime.accounts
 * (same instance installed into getSharedAccountSyncStore for CC UI).
 */
function sharedAccountStore(): AccountSyncStore {
  if (mcpAccountStoreExplicit) return getSharedAccountSyncStore()
  return resolveMcpRuntimeContext().runtime.accounts
}

function sharedDecisionStore(): DecisionV3Store {
  if (mcpDecisionStore) return mcpDecisionStore
  return resolveMcpRuntimeContext().controlData.decisions
}

function sharedReconcilerStore(): ReconcilerStore {
  if (mcpReconcilerStore) return mcpReconcilerStore
  return resolveMcpRuntimeContext().runtime.reconciler
}

function sharedG5Store() {
  return resolveMcpRuntimeContext().controlData.g5
}

async function loadCapacityForBoard(boardId: string) {
  try {
    const snap = await sharedAccountStore().get(boardId)
    if (!snap) {
      // Missing capacity → BLOCKED/zero (fail closed)
      return evaluateCapacityPolicy({ accounts: [], forceZero: true })
    }
    if (snap.stale) {
      return evaluateCapacityPolicy({ accounts: snap.accounts, forceZero: true, health: undefined })
    }
    return (
      snap.capacity ??
      evaluateCapacityPolicy({ accounts: snap.accounts, forceZero: false })
    )
  } catch {
    return evaluateCapacityPolicy({ accounts: [], forceZero: true })
  }
}

/**
 * Default MCP run-registry deps from durable context (one clock + atomic + runs +
 * locks + idempotency). Cached process-wide when resolved; setMcpRunRegistryDeps wins.
 * Exported for unit tests of the non-injected path.
 */
export function defaultRunDeps(boardId?: string, boardRev = 0): RunRegistryDeps {
  void boardId
  void boardRev
  if (mcpRunDeps) return mcpRunDeps
  const ctx = resolveMcpRuntimeContext()
  mcpRunDeps = {
    clock: ctx.clock,
    runs: sharedRunStore(),
    locks: sharedLocks(),
    atomic: sharedAtomic(),
    idempotency: sharedIdempotency(),
    getCapacity: (id) => loadCapacityForBoard(id),
  }
  return mcpRunDeps
}

function accountSyncDeps(): AccountSyncDeps {
  return {
    clock: systemClock(),
    accounts: sharedAccountStore(),
    atomic: sharedAtomic(),
    idempotency: sharedIdempotency(),
  }
}

function decisionDeps(): DecisionV3Deps {
  return {
    clock: systemClock(),
    decisions: sharedDecisionStore(),
    atomic: sharedAtomic(),
  }
}

function reconcilerDeps(runDeps: RunRegistryDeps): ReconcilerDeps {
  return {
    clock: runDeps.clock,
    runs: runDeps.runs,
    locks: runDeps.locks,
    reconciler: sharedReconcilerStore(),
    atomic: runDeps.atomic,
  }
}

/**
 * Stable typed error envelope for MCP tools.
 * EXPLICIT safe domain-code allowlist only — never surface:
 * - Node errno (EPERM, ENOENT, …)
 * - MySQL ER_* codes/messages/details
 * - paths, stacks, or untyped exception text
 */
const NODE_ERRNO_CODE_RE = /^E[A-Z]+$/
const MYSQL_ER_CODE_RE = /^ER_[A-Z0-9_]+$/

/** Explicit allowlist of domain error codes safe to echo on the MCP wire. */
const SAFE_TYPED_ERROR_CODES = new Set([
  // auth / rbac
  'AUTHORIZATION_REQUIRED',
  'DECISION_AUTH_MECHANISM_REQUIRED',
  'FORBIDDEN_SCOPE',
  'FORBIDDEN_ROLE',
  'COOKIE_ELEVATION_DENIED',
  'OWN_RUN_ONLY',
  'OWNER_EVIDENCE_IMPERSONATION_DENIED',
  'ROOT_PRODUCTION_APPROVAL_DENIED',
  'INTEGRATOR_PATH_BOUNDED',
  'PUBLIC_ONLY',
  'FORBIDDEN',
  'UNAUTHORIZED',
  // domain generic
  'INVALID_INPUT',
  'NOT_FOUND',
  'INVALID_STATE',
  'DATA_INTEGRITY',
  'STALE_REVISION',
  'IMMUTABLE_AUDIT',
  'BLOCKED',
  'CAPACITY',
  'CONFLICT',
  'DISPATCH_BLOCKED',
  // run / locks
  'FENCED',
  'LEASE_EXPIRED',
  'RUN_NOT_REGISTERED',
  'CLAIM_COLLISION',
  'INTEGRATION_LOCKED',
  'AUTHOR_VERIFIER_CONFLICT',
  'LOCK_NOT_FOUND',
  'ACCOUNT_SYNC_STALE',
  // idempotency
  'IDEMPOTENCY_CONFLICT',
  'IDEMPOTENCY_IN_PROGRESS',
  'IDEMPOTENCY_KEY_REQUIRED',
  'IDEMPOTENCY_EXPIRED',
  // ingest / plan
  'PLAN_EXPIRED',
  'PLAN_SUPERSEDED',
  // decisions
  'AUTHORITY_BROADENING_FORBIDDEN',
  'SNOOZE_BLOCKED',
  // reconciler
  'NOT_LEADER',
  'DRY_RUN_HASH_MISMATCH',
  'BUDGET_EXCEEDED',
  // accounts
  'ACCOUNTS_ALL_FORBIDDEN',
  'FILLER_FORBIDDEN',
  // public / read contract
  'RATE_LIMITED',
  'STALE_OR_MISSING',
  'INVALID_FILTER',
  'UNKNOWN_METHOD',
  'MISSING_BOARD_ID',
  'MISSING_ENTITY_ID',
  'PAGE_SIZE_INVALID',
  'CURSOR_INVALID',
  'PIN_INCOMPLETE',
  'PIN_MISSING',
  'PIN_SYNTHETIC',
  'SNAPSHOT_MISSING',
  'HASH_MISMATCH',
  'SNAPSHOT_ID_MISMATCH',
  'REV_MISMATCH',
  'LIFECYCLE_REV_MISMATCH',
  'SCHEMA_INVALID',
  'PAYLOAD_INVALID',
  'DUPLICATE_ID',
  'OUT_OF_ORDER_PIN',
  'BOARD_MISMATCH',
  'DEFINITION_AUTHORITY_STALE',
  'CANONICAL_IMPORT_REQUIRED',
  'PIN_AUTHORITY_INCOMPLETE',
  'PAYLOAD_UNBOUNDED',
  'MATERIALIZATION_FAILED',
  // control-data / context
  'DB_UNAVAILABLE',
  'NOT_CONFIGURED',
])

function isSafeTypedErrorCode(code: string): boolean {
  if (!code || typeof code !== 'string') return false
  if (NODE_ERRNO_CODE_RE.test(code)) return false
  if (MYSQL_ER_CODE_RE.test(code)) return false
  if (code.startsWith('ER_')) return false
  return SAFE_TYPED_ERROR_CODES.has(code)
}

/** Strip any ER_* / errno-shaped values from details before wire echo. */
function sanitizeErrorDetails(details: unknown): unknown {
  if (details == null) return undefined
  if (typeof details !== 'object' || Array.isArray(details)) return undefined
  const out: Record<string, unknown> = {}
  for (const [k, v] of Object.entries(details as Record<string, unknown>)) {
    if (/er_|errno|sqlstate|sqlMessage|stack|path/i.test(k)) continue
    if (typeof v === 'string' && (MYSQL_ER_CODE_RE.test(v) || NODE_ERRNO_CODE_RE.test(v) || /\bER_[A-Z0-9_]+\b/.test(v))) {
      continue
    }
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean' || v === null) {
      out[k] = v
    }
  }
  return Object.keys(out).length ? out : undefined
}

/** @internal test export — production tools use typedError via secureTool catch. */
export function mcpTypedErrorForTests(e: unknown) {
  return typedError(e)
}

// ---------------------------------------------------------------------------
// Mutation envelope (AC-API-03) — required on every MCP write tool.
// No silent 0/default revisions. Auth scope still enforced by secureTool.
// ---------------------------------------------------------------------------

/** Canonical required envelope field names (aliases accepted at parse). */
export const MUTATION_ENVELOPE_REQUIRED_KEYS = [
  'entityExpectedRev',
  'expectedBoardRev',
  'canonicalHash',
  'idempotencyKey',
] as const

/**
 * Zod fields merged into every write tool inputSchema.
 * entityExpectedRev aliases: expectedEntityRev, expectedRev.
 * subject hash aliases: canonicalHash, subjectHash (at least one required at parse).
 */
export const MUTATION_ENVELOPE_ZOD = {
  entityExpectedRev: z.number().int().optional(),
  expectedEntityRev: z.number().int().optional(),
  expectedRev: z.number().int().optional(),
  expectedBoardRev: z.number().int(),
  canonicalHash: z.string().min(1).optional(),
  subjectHash: z.string().min(1).optional(),
  idempotencyKey: z.string().min(1),
} as const

export interface ParsedMutationEnvelope {
  entityExpectedRev: number
  expectedBoardRev: number
  subjectHash: string
  idempotencyKey: string
}

/** Module registry of write tool schema keys (rebuilt each registerBoardTools call). */
const writeToolSchemaRegistry = new Map<string, string[]>()

export function listRegisteredWriteToolSchemas(): Array<{ name: string; schemaKeys: string[] }> {
  return [...writeToolSchemaRegistry.entries()].map(([name, schemaKeys]) => ({
    name,
    schemaKeys: [...schemaKeys],
  }))
}

export function writeToolSchemaHasFullEnvelope(schemaKeys: readonly string[]): boolean {
  const keys = new Set(schemaKeys)
  const hasEntity =
    keys.has('entityExpectedRev') || keys.has('expectedEntityRev') || keys.has('expectedRev')
  const hasBoard = keys.has('expectedBoardRev')
  const hasHash = keys.has('canonicalHash') || keys.has('subjectHash')
  const hasIdem = keys.has('idempotencyKey')
  return hasEntity && hasBoard && hasHash && hasIdem
}

export class McpMutationError extends Error {
  readonly code: string
  readonly details: Record<string, unknown>
  constructor(code: string, message: string, details: Record<string, unknown> = {}) {
    super(message)
    this.name = 'McpMutationError'
    this.code = code
    this.details = details
  }
}

/**
 * Parse mutation envelope from tool args. NEVER defaults missing revs to 0.
 * Client may *send* 0 explicitly (honest zero); omission → INVALID_INPUT.
 */
export function parseMutationEnvelope(args: Record<string, unknown>): ParsedMutationEnvelope {
  const entityRaw =
    typeof args.entityExpectedRev === 'number'
      ? args.entityExpectedRev
      : typeof args.expectedEntityRev === 'number'
        ? args.expectedEntityRev
        : typeof args.expectedRev === 'number'
          ? args.expectedRev
          : null
  if (entityRaw == null || !Number.isInteger(entityRaw)) {
    throw new McpMutationError(
      'INVALID_INPUT',
      'entityExpectedRev (or expectedEntityRev/expectedRev) is required — no silent default',
    )
  }
  if (typeof args.expectedBoardRev !== 'number' || !Number.isInteger(args.expectedBoardRev)) {
    throw new McpMutationError(
      'INVALID_INPUT',
      'expectedBoardRev is required — no silent default',
    )
  }
  const subjectHash =
    (typeof args.canonicalHash === 'string' && args.canonicalHash.trim()) ||
    (typeof args.subjectHash === 'string' && args.subjectHash.trim()) ||
    ''
  if (!subjectHash) {
    throw new McpMutationError(
      'INVALID_INPUT',
      'canonicalHash or subjectHash is required (current subject/canonical hash)',
    )
  }
  if (typeof args.idempotencyKey !== 'string' || !args.idempotencyKey.trim()) {
    throw new McpMutationError('INVALID_INPUT', 'idempotencyKey is required', {
      code: 'IDEMPOTENCY_KEY_REQUIRED',
    })
  }
  return {
    entityExpectedRev: entityRaw,
    expectedBoardRev: args.expectedBoardRev,
    subjectHash,
    idempotencyKey: args.idempotencyKey.trim(),
  }
}

function schemaKeysOf(inputSchema: Record<string, unknown> | object): string[] {
  return Object.keys(inputSchema as Record<string, unknown>)
}

function mergeMutationEnvelope(
  inputSchema: Record<string, unknown> | object,
): Record<string, unknown> {
  const base = { ...(inputSchema as Record<string, unknown>) }
  // Envelope fields are authoritative; do not let optional legacy expectedRev hide required board/idem.
  for (const [k, v] of Object.entries(MUTATION_ENVELOPE_ZOD)) {
    if (base[k] === undefined) base[k] = v
  }
  // Force expectedBoardRev / idempotencyKey required even if a prior optional shadow existed.
  base.expectedBoardRev = MUTATION_ENVELOPE_ZOD.expectedBoardRev
  base.idempotencyKey = MUTATION_ENVELOPE_ZOD.idempotencyKey
  return base
}

export interface MutationGateOpts {
  toolName: string
  boardId: string
  actorId: string
  entityType: string
  entityId: string
  /** When set, HOLD/EXCLUDE/UNCLASSIFIED classification is rejected. */
  taskId?: string | null
  /** Request body used for idempotency hash (secrets redacted). */
  requestBody: unknown
  /** When true, skip pin hash check (create_board before pin exists). Still requires client hash string. */
  skipPinHashCheck?: boolean
  /** When true, skip board-rev CAS (create_board). */
  skipBoardRevCheck?: boolean
  /**
   * dryRun / preview: still enforce envelope + board/pin checks under lock,
   * but MUST NOT compareAndSwap entity rev or bumpBoardRev.
   */
  dryRun?: boolean
}

/** Canonical catalog of every MCP write tool (must match MCP_TOOL_SPECS kind=write). */
export const REGISTERED_WRITE_TOOL_NAMES = [
  'create_board',
  'toggle_task',
  'set_feature_phase',
  'upsert_run',
  'set_run_status',
  'add_comment',
  'open_decision',
  'set_blocked',
  'set_project_design',
  'add_component',
  'upsert_task',
  'delete_task',
  'upsert_feature',
  'delete_feature',
  'set_prod',
  'set_guide',
  'replace_accounts',
  'replace_board_snapshot',
  'set_lifecycle',
  'advance_task',
  'add_task_section',
  'set_task_sections',
  'update_task_section',
  'remove_task_section',
  'init_lifecycle',
  'upsert_project',
  'delete_project',
  'update_board',
  'delete_board',
  'decide_decision',
  'set_queue',
  'publish_dispatch_plan',
  'register_run',
  'heartbeat_run',
  'sync_accounts',
  'reconcile_dry_run',
  'reconcile_apply',
  'open_decision_v3',
  'resolve_decision_v3',
  'integration_lock',
] as const

export type RegisteredWriteToolName = (typeof REGISTERED_WRITE_TOOL_NAMES)[number]

/**
 * Granular/legacy MCP writes that mutate task/project/feature definition graph
 * (board_docs / tasks membership). On pin-complete authority these must NOT
 * silently diverge the active pin — only replace_board_snapshot / applyImport CAS
 * may advance definition. Lifecycle/run/account/decision tools are NOT listed.
 */
export const DEFINITION_MUTATOR_TOOL_NAMES = [
  'toggle_task',
  'set_feature_phase',
  'set_project_design',
  'add_component',
  'upsert_task',
  'delete_task',
  'upsert_feature',
  'delete_feature',
  'set_prod',
  'set_guide',
  'add_task_section',
  'set_task_sections',
  'update_task_section',
  'remove_task_section',
  'upsert_project',
  'delete_project',
  'set_queue',
] as const

export type DefinitionMutatorToolName = (typeof DEFINITION_MUTATOR_TOOL_NAMES)[number]

const DEFINITION_MUTATOR_TOOL_SET = new Set<string>(DEFINITION_MUTATOR_TOOL_NAMES)

/**
 * Pin-complete dual-authority gate for definition mutators.
 * - Pin incomplete/missing → allow legacy path (caller marks stale/incomplete).
 * - Pin complete + snapshot mismatch → DEFINITION_AUTHORITY_STALE (no legacy write).
 * - Pin complete + valid pin → CANONICAL_IMPORT_REQUIRED (must use replace_board_snapshot).
 * - replace_board_snapshot is NOT in DEFINITION_MUTATOR_TOOL_NAMES (import CAS path).
 *
 * MUST be called before beginIdempotent so fail-closed rejects never open/consume
 * idempotency slots or advance revision.
 */
export async function assertGranularDefinitionMutationAllowed(
  toolName: string,
  boardId: string,
): Promise<void> {
  if (!DEFINITION_MUTATOR_TOOL_SET.has(toolName)) return

  let imports: ReturnType<typeof resolveMcpRuntimeContext>['controlData']['imports'] | null =
    null
  try {
    imports = resolveMcpRuntimeContext().controlData.imports
  } catch {
    // Runtime unavailable → legacy path (no pin authority to protect).
    return
  }

  const boardState = await imports.getBoardState(boardId)
  if (!boardState) return // PIN_MISSING — legacy compatibility
  if (!isPinComplete(boardState)) return // incomplete/synthetic — legacy + honesty

  // Pin complete: refuse granular definition writes that would diverge the pin.
  const loaded = await tryLoadPinnedDefinitionReadModel(imports, boardId)
  if (!loaded.ok) {
    throw new McpMutationError(
      'DEFINITION_AUTHORITY_STALE',
      `definition mutation via ${toolName} refused: pin-complete but snapshot/hash invalid (${loaded.code}); use replace_board_snapshot after pin repair`,
      {
        toolName,
        boardId,
        code: 'DEFINITION_AUTHORITY_STALE',
        pinCode: loaded.code,
        boardRev: boardState.boardRev,
        canonicalSnapshotId: boardState.canonicalSnapshotId,
      },
    )
  }

  throw new McpMutationError(
    'CANONICAL_IMPORT_REQUIRED',
    `definition mutation via ${toolName} forbidden while pin is complete; route through replace_board_snapshot / applyImport CAS`,
    {
      toolName,
      boardId,
      code: 'CANONICAL_IMPORT_REQUIRED',
      boardRev: boardState.boardRev,
      lifecycleRev: boardState.lifecycleRev,
      canonicalSnapshotId: boardState.canonicalSnapshotId,
      canonicalHash: boardState.canonicalHash ?? boardState.subjectHash,
    },
  )
}

/**
 * Mutation result carries the handler body plus optional idempotent-replay flag.
 * Constrained to object because replay merges `{ replayed: true }` onto the body.
 */
export type MutationGateResult<T extends object> = T & { replayed?: boolean }

/**
 * Build a typed gate result without `any` / `@ts-ignore`.
 * Fresh path returns body unchanged (no `replayed` key); replay path sets `replayed: true`.
 */
function toMutationGateResult<T extends object>(body: T, replayed?: true): MutationGateResult<T> {
  if (replayed === true) {
    return { ...body, replayed: true }
  }
  // T extends object ⇒ assignable to T & { replayed?: boolean } (optional flag absent).
  return body
}

/**
 * Durable mutation gate: idempotency + atomic board rev + pin subject hash +
 * entity CAS + HOLD/EXCLUDE/UNCLASSIFIED reject. Runs `mutate` only after all checks pass.
 * Replay returns prior response body without re-executing mutate.
 *
 * Generic `T` is constrained to `object` so the return type `T & { replayed?: boolean }`
 * is sound (unconstrained T made TS2322: Awaited<T> ↛ T & { replayed? }).
 */
export async function runMutationGate<T extends object>(
  opts: MutationGateOpts,
  mutate: () => Promise<T>,
): Promise<MutationGateResult<T>> {
  const argsEnvelope = parseMutationEnvelope(opts.requestBody as Record<string, unknown>)
  // Prefer explicit envelope from requestBody; opts may carry boardId only.
  const envelope = argsEnvelope
  const ctx = resolveMcpRuntimeContext()
  const idem = ctx.idempotency
  const atomic = ctx.atomic
  const revisions = ctx.revisions

  // Dual-authority: pin-complete definition mutators fail closed BEFORE idempotency
  // begin — never open/consume an idempotency slot or advance revision on reject.
  await assertGranularDefinitionMutationAllowed(opts.toolName, opts.boardId)

  const begin = await beginIdempotent(idem, {
    scope: {
      actorId: opts.actorId,
      boardId: opts.boardId,
      endpoint: opts.toolName,
      key: envelope.idempotencyKey,
    },
    requestBody: opts.requestBody,
    nowMs: ctx.clock.nowMs(),
  })

  if (begin.kind === 'REPLAY' && begin.record) {
    const prior = begin.record.responseBody
    if (prior === null || typeof prior !== 'object') {
      throw new McpMutationError(
        'DATA_INTEGRITY',
        'idempotent replay body is not an object',
        { toolName: opts.toolName, boardId: opts.boardId },
      )
    }
    return toMutationGateResult(prior as T, true)
  }

  try {
    // Explicit Promise<T> on the lock callback prevents Awaited<T> widening that
    // previously failed assignability to MutationGateResult<T> (TS2322 at return).
    const result: T = await atomic.withBoardLock(opts.boardId, async (): Promise<T> => {
      if (!opts.skipBoardRevCheck) {
        const board = await atomic.getBoardState(opts.boardId)
        if (board.boardRev !== envelope.expectedBoardRev) {
          throw new McpMutationError(
            STALE_REVISION,
            `board rev mismatch: expected ${envelope.expectedBoardRev}, current ${board.boardRev}`,
            {
              expectedBoardRev: envelope.expectedBoardRev,
              currentBoardRev: board.boardRev,
              boardId: opts.boardId,
            },
          )
        }
      }

      if (!opts.skipPinHashCheck) {
        const pin = await resolveBoardPin(opts.boardId)
        if (pin.canonicalHash !== envelope.subjectHash) {
          throw new McpMutationError(
            STALE_REVISION,
            `subject hash mismatch: expected ${envelope.subjectHash}, current ${pin.canonicalHash}`,
            {
              expectedSubjectHash: envelope.subjectHash,
              currentSubjectHash: pin.canonicalHash,
              boardId: opts.boardId,
            },
          )
        }
      }

      // HOLD / EXCLUDE / UNCLASSIFIED — fail closed when task subject is known
      if (opts.taskId) {
        const cls = await ctx.controlData.classification.get(opts.boardId, opts.taskId)
        const disposition = (cls?.disposition ?? 'UNCLASSIFIED').toUpperCase()
        const taskClass = (cls?.taskClass ?? 'UNCLASSIFIED').toUpperCase()
        if (disposition === 'HOLD' || disposition === 'EXCLUDE') {
          throw new McpMutationError(
            'BLOCKED',
            `mutation rejected: task ${opts.taskId} disposition is ${disposition}`,
            { taskId: opts.taskId, disposition, reason: 'HOLD_OR_EXCLUDE' },
          )
        }
        if (disposition === 'UNCLASSIFIED' || taskClass === 'UNCLASSIFIED') {
          throw new McpMutationError(
            'DATA_INTEGRITY',
            `mutation rejected: task ${opts.taskId} is UNCLASSIFIED`,
            { taskId: opts.taskId, disposition, taskClass, reason: 'UNCLASSIFIED' },
          )
        }
      }

      const board = await atomic.getBoardState(opts.boardId)
      const existing = await revisions.getEntity({
        boardId: opts.boardId,
        entityType: opts.entityType,
        entityId: opts.entityId,
      })
      // First entity write: revision store seeds subjectHash=null → expectedSubjectHash ''.
      // Board pin hash was already checked against envelope.subjectHash above.
      const current: RevisionState = existing
        ? { ...existing, boardRev: board.boardRev }
        : {
            boardId: opts.boardId,
            entityType: opts.entityType,
            entityId: opts.entityId,
            entityRev: 0,
            boardRev: board.boardRev,
            subjectHash: null,
          }
      const expectedEntitySubjectHash = current.subjectHash ?? ''
      const nextSubjectHash = envelope.subjectHash
      const cas = evaluateCas(current, {
        boardId: opts.boardId,
        entityType: opts.entityType,
        entityId: opts.entityId,
        entityExpectedRev: envelope.entityExpectedRev,
        expectedBoardRev: envelope.expectedBoardRev,
        expectedSubjectHash: expectedEntitySubjectHash,
        nextSubjectHash,
      })
      if (!cas.ok) {
        throw new McpMutationError(cas.code, cas.message, {
          ...cas.current,
        })
      }

      const body = await mutate()

      // dryRun / preview: never advance entity or board revision (AC write-gate).
      if (opts.dryRun) {
        return body
      }

      // Persist entity CAS. Board rev is advanced via atomic.bumpBoardRev (single authority).
      // Align revision store board map by using expectedBoardRev that matches atomic pre-bump.
      const casWrite = await revisions.compareAndSwap({
        boardId: opts.boardId,
        entityType: opts.entityType,
        entityId: opts.entityId,
        entityExpectedRev: envelope.entityExpectedRev,
        expectedBoardRev: envelope.expectedBoardRev,
        expectedSubjectHash: expectedEntitySubjectHash,
        nextSubjectHash,
      })
      if (!casWrite.ok) {
        throw new McpMutationError(casWrite.code, casWrite.message, { ...casWrite.current })
      }
      if (!opts.skipBoardRevCheck) {
        await atomic.bumpBoardRev(opts.boardId)
      }

      return body
    })

    await completeIdempotent(idem, begin.scopeHash, 200, result, begin.requestHash)
    return toMutationGateResult(result)
  } catch (e) {
    try {
      await idem.delete(begin.scopeHash)
    } catch {
      /* ignore cleanup */
    }
    if (e instanceof IdempotencyError) {
      throw new McpMutationError(e.code, e.message)
    }
    throw e
  }
}

/**
 * Schema-level envelope assert for V3 tools that already own domain CAS/idempotency.
 * Ensures missing fields never pass; optional pin hash check when boardId known.
 */
export async function assertMutationEnvelopeOrThrow(
  args: Record<string, unknown>,
  opts?: { boardId?: string; checkPinHash?: boolean },
): Promise<ParsedMutationEnvelope> {
  const env = parseMutationEnvelope(args)
  if (opts?.checkPinHash && opts.boardId) {
    const pin = await resolveBoardPin(opts.boardId)
    if (pin.canonicalHash !== env.subjectHash) {
      throw new McpMutationError(
        STALE_REVISION,
        `subject hash mismatch: expected ${env.subjectHash}, current ${pin.canonicalHash}`,
        {
          expectedSubjectHash: env.subjectHash,
          currentSubjectHash: pin.canonicalHash,
          boardId: opts.boardId,
        },
      )
    }
  }
  return env
}

/** Fail closed not-found — throws so runMutationGate never CAS/idempotency-completes. */
export function throwNotFound(message: string, details: Record<string, unknown> = {}): never {
  throw new McpMutationError('NOT_FOUND', message, details)
}

/**
 * AGENT own-run against *persisted* run owner (never request agentId spoof).
 * ROOT/OWNER/INTEGRATOR no-op here (OWNER is denied earlier by authorizeToolCall).
 */
export function authorizePersistedRunOwner(
  principal: Principal | null | undefined,
  persistedAgentId: string | null | undefined,
): void {
  if (!principal || principal.role !== 'AGENT') return
  assertAgentOwnRun(principal, persistedAgentId)
}

/** Attribution is always the authenticated principal — never request body fields. */
export function attributionFromPrincipal(principal: Principal | null | undefined): string {
  return principal?.actorId ?? principal?.agentId ?? 'mcp-actor'
}

/**
 * Enforce INTEGRATOR checkpoint/pathspec bounds (principal binding).
 * ROOT and other roles: no-op. Throws RbacError → typed INTEGRATOR_PATH_BOUNDED.
 */
export function enforceIntegratorLockBounds(
  principal: Principal | null | undefined,
  opts: { checkpointId?: string | null; pathspecs: ReadonlyArray<string> },
): void {
  if (!principal) return
  assertIntegratorBounds(principal, {
    checkpointId: opts.checkpointId ?? null,
    pathspec: opts.pathspecs[0] ?? null,
  })
  for (const ps of opts.pathspecs) {
    assertIntegratorBounds(principal, {
      checkpointId: opts.checkpointId ?? null,
      pathspec: ps,
    })
  }
}

/**
 * byRunId must be a registered legacy run (board runs doc) or V3 run registry row.
 * Fail closed: unknown run cannot advance lifecycle.
 */
export async function assertRegisteredRunOrThrow(
  boardId: string,
  byRunId: string,
): Promise<void> {
  const board = await readBoard(boardId)
  if ((board.runs ?? []).some((r) => r.id === byRunId)) return
  try {
    const listed = await defaultRunDeps(boardId).runs.list(boardId)
    if (listed.some((r) => r.runId === byRunId)) return
  } catch {
    /* fall through to throw */
  }
  throw new McpMutationError(
    'RUN_NOT_REGISTERED',
    `byRunId ${byRunId} is not a registered run on board ${boardId}`,
    { boardId, byRunId },
  )
}

/**
 * Resolve the *persisted* agent owner for advance_task authorization.
 * Legacy board.runs first; else V3 run registry agentId.
 * NEVER falls back to principal.agentId (that compared principal to itself).
 */
export async function resolveAdvanceTaskPersistedAgentId(
  boardId: string,
  byRunId: string,
): Promise<string | null> {
  const board = await readBoard(boardId)
  const legacy = (board.runs ?? []).find((r) => r.id === byRunId)
  if (legacy) return legacy.agent ?? null
  try {
    const v3 = await defaultRunDeps(boardId).runs.get(boardId, byRunId)
    if (v3) return v3.agentId ?? null
  } catch {
    /* fall through */
  }
  return null
}

const MASKED_STATUS_SET = new Set<string>([
  'ACTIVE',
  'OK',
  'LIMIT',
  'BAN',
  '403',
  'AUTH_EXPIRED',
  'quarantine',
  'REMOVED',
])

function mapLegacyProviderKind(raw: unknown): AccountProviderKind {
  if (typeof raw !== 'string') return 'OTHER'
  const u = raw.trim().toUpperCase()
  if (u === 'GROK' || u.includes('GROK')) return 'GROK'
  if (u === 'SPARK' || u.includes('SPARK')) return 'SPARK'
  if (u === 'SOL' || u.includes('SOL')) return 'SOL'
  return 'OTHER'
}

function mapLegacyAccountStatus(status: unknown, usable: unknown): MaskedAccountStatus {
  if (typeof status === 'string' && MASKED_STATUS_SET.has(status)) {
    return status as MaskedAccountStatus
  }
  if (usable === true) return 'OK'
  if (usable === false) return 'LIMIT'
  if (typeof status === 'string') {
    const u = status.toUpperCase()
    if (u.includes('BAN')) return 'BAN'
    if (u.includes('403') || u.includes('AUTH')) return 'AUTH_EXPIRED'
    if (u.includes('LIMIT') || u.includes('EXHAUST')) return 'LIMIT'
    if (u.includes('OK') || u.includes('ACTIVE') || u.includes('USABLE')) return 'OK'
  }
  return 'LIMIT'
}

function stripSecretFields<T extends Record<string, unknown>>(row: T): T {
  const copy = { ...row }
  for (const k of Object.keys(copy)) {
    if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
      delete copy[k]
    }
  }
  return copy
}

/**
 * Map legacy replace_accounts OPS_OBJ payload → durable sync_accounts account rows.
 * Fail-closed: missing id, secret-like masked id, and empty accounts rejected by caller.
 */
export function mapLegacyOpsAccountsToSync(
  ops: { accounts?: Array<Record<string, unknown>> } | null | undefined,
): SyncAccountsRequest['accounts'] {
  const rows = ops?.accounts
  if (!Array.isArray(rows)) {
    throw new McpMutationError('INVALID_INPUT', 'ops.accounts array required')
  }
  return rows.map((raw, idx) => {
    const clean = stripSecretFields({ ...raw })
    const id =
      (typeof clean.maskedAccountId === 'string' && clean.maskedAccountId.trim()) ||
      (typeof clean.id === 'string' && clean.id.trim()) ||
      ''
    if (!id) {
      throw new McpMutationError('INVALID_INPUT', `ops.accounts[${idx}] missing id/maskedAccountId`)
    }
    if (/token|password|secret/i.test(id)) {
      throw new McpMutationError('DATA_INTEGRITY', 'maskedAccountId must not look like a secret', {
        index: idx,
      })
    }
    const inUse =
      typeof clean.effectiveInUse === 'number'
        ? clean.effectiveInUse
        : typeof clean.slotsInUse === 'number'
          ? clean.slotsInUse
          : 0
    const cap =
      typeof clean.effectiveCap === 'number'
        ? clean.effectiveCap
        : typeof clean.slotsCapacity === 'number'
          ? clean.slotsCapacity
          : 0
    return {
      maskedAccountId: id,
      status: mapLegacyAccountStatus(clean.status, clean.usable),
      providerKind: mapLegacyProviderKind(clean.providerKind ?? clean.provider),
      effectiveInUse: Math.max(0, inUse),
      effectiveCap: Math.max(0, cap),
      physicalSlotsDisplay:
        typeof clean.physicalSlotsDisplay === 'string'
          ? clean.physicalSlotsDisplay
          : typeof clean.slotsInUse === 'number' && typeof clean.slotsCapacity === 'number'
            ? `${clean.slotsInUse}/${clean.slotsCapacity}`
            : null,
      adaptiveQuotaState:
        typeof clean.adaptiveQuotaState === 'string' ? clean.adaptiveQuotaState : null,
      reason: typeof clean.reason === 'string' ? clean.reason : null,
      statusChangedAt:
        typeof clean.statusChangedAt === 'string'
          ? clean.statusChangedAt
          : typeof clean.exhaustedAt === 'string'
            ? clean.exhaustedAt
            : null,
    }
  })
}

/** Build sanitized OpsData for compatibility response after durable sync. */
export function legacyOpsCompatibilityPayload(
  ops: Record<string, unknown>,
): OpsData {
  const vaultRaw =
    ops.vault && typeof ops.vault === 'object' && !Array.isArray(ops.vault)
      ? stripSecretFields({ ...(ops.vault as Record<string, unknown>) })
      : {}
  const accountsIn = Array.isArray(ops.accounts) ? ops.accounts : []
  const accounts = accountsIn.map((a) => {
    const row = stripSecretFields({ ...(a as Record<string, unknown>) })
    return {
      id: String(row.id ?? row.maskedAccountId ?? ''),
      label: String(row.label ?? row.id ?? row.maskedAccountId ?? ''),
      provider: typeof row.provider === 'string' ? row.provider : undefined,
      status: String(row.status ?? 'unknown'),
      usable: row.usable === true || row.status === 'OK' || row.status === 'ACTIVE',
      slotsInUse:
        typeof row.slotsInUse === 'number'
          ? row.slotsInUse
          : typeof row.effectiveInUse === 'number'
            ? row.effectiveInUse
            : 0,
      slotsCapacity:
        typeof row.slotsCapacity === 'number'
          ? row.slotsCapacity
          : typeof row.effectiveCap === 'number'
            ? row.effectiveCap
            : 0,
      reason: (row.reason as string | null | undefined) ?? null,
      exhaustedAt: (row.exhaustedAt as string | null | undefined) ?? null,
      detail: (row.detail as string | null | undefined) ?? null,
    }
  })
  const alert =
    ops.alert && typeof ops.alert === 'object' && !Array.isArray(ops.alert)
      ? (ops.alert as OpsData['alert'])
      : undefined
  return {
    vault: vaultRaw as OpsData['vault'],
    accounts,
    ...(alert !== undefined ? { alert } : {}),
  }
}

function hexCommitFromSeed(seed: string): string {
  return createHash('sha256').update(seed).digest('hex')
}

/**
 * Map replace_board_snapshot legacy collections → canonical snapshot (schema/hash/graph).
 * Reuses produceCanonicalSnapshot (no duplicated validation logic).
 */
export function buildCanonicalSnapshotFromReplaceBoardArgs(
  boardId: string,
  args: Record<string, unknown>,
  opts?: { snapshotId?: string; idempotencyKey?: string },
): CanonicalSnapshot {
  const projectsIn = Array.isArray(args.projects) ? (args.projects as Array<Record<string, unknown>>) : []
  const featuresIn = Array.isArray(args.features) ? (args.features as Array<Record<string, unknown>>) : []
  const tasksIn = Array.isArray(args.tasks) ? (args.tasks as Array<Record<string, unknown>>) : []

  const projects = projectsIn.map((p) => ({
    id: String(p.id),
    name: typeof p.name === 'string' ? p.name : typeof p.nama === 'string' ? p.nama : null,
    status: p.status,
    ...Object.fromEntries(
      Object.entries(p).filter(([k]) => !['id', 'name', 'nama', 'status'].includes(k)),
    ),
  }))

  const flows = featuresIn.map((f) => ({
    id: String(f.id),
    projectId: String(f.projectId ?? f.project ?? projects[0]?.id ?? 'unknown-project'),
    name: typeof f.name === 'string' ? f.name : typeof f.nama === 'string' ? f.nama : null,
    fase: f.fase,
  }))

  const tasks = tasksIn.map((t) => {
    const clean = stripSecretFields({ ...t })
    // Definition import must not carry lifecycle evidence fields.
    for (const k of ['lifecycleStage', 'stageEvidence', 'g5Pass', 'lifecycleHistory'] as const) {
      delete clean[k]
    }
    return {
      id: String(clean.id),
      title: typeof clean.title === 'string' ? clean.title : null,
      projectId:
        typeof clean.projectId === 'string'
          ? clean.projectId
          : typeof clean.project === 'string'
            ? clean.project
            : projects[0]?.id ?? null,
      featureContractId:
        typeof clean.featureContractId === 'string'
          ? clean.featureContractId
          : typeof clean.featureId === 'string'
            ? clean.featureId
            : null,
    }
  })

  const classifications = tasks.map((t) => ({
    taskId: t.id,
    taskClass: 'UNCLASSIFIED' as const,
    disposition: 'UNCLASSIFIED' as const,
  }))

  // Optional graph joins if caller already supplies V3-shaped arrays (passthrough).
  const dependencies = Array.isArray(args.dependencies)
    ? (args.dependencies as CanonicalSnapshotInput['dependencies'])
    : []
  const featureContractJoins = Array.isArray(args.featureContractJoins)
    ? (args.featureContractJoins as CanonicalSnapshotInput['featureContractJoins'])
    : tasks
        .filter((t) => t.featureContractId)
        .map((t) => ({ featureContractId: String(t.featureContractId), taskId: t.id }))
  const nodeJoins = Array.isArray(args.nodeJoins)
    ? (args.nodeJoins as CanonicalSnapshotInput['nodeJoins'])
    : []
  const nodes = Array.isArray(args.nodes)
    ? (args.nodes as CanonicalSnapshotInput['nodes'])
    : []
  const primaryOwnerships = Array.isArray(args.primaryOwnerships)
    ? (args.primaryOwnerships as CanonicalSnapshotInput['primaryOwnerships'])
    : []
  const anchors = Array.isArray(args.anchors)
    ? (args.anchors as CanonicalSnapshotInput['anchors'])
    : []
  const acceptancePaths = Array.isArray(args.acceptancePaths)
    ? (args.acceptancePaths as CanonicalSnapshotInput['acceptancePaths'])
    : []

  const seed =
    opts?.idempotencyKey ||
    opts?.snapshotId ||
    (typeof args.expectedHash === 'string' ? args.expectedHash : '') ||
    boardId
  const snapshotId =
    opts?.snapshotId ||
    (typeof args.snapshotId === 'string' && args.snapshotId.trim()
      ? args.snapshotId.trim()
      : `mcp-replace-${createHash('sha256').update(seed).digest('hex').slice(0, 24)}`)
  const commitSeed =
    (typeof args.sourceCommitSha === 'string' && args.sourceCommitSha) ||
    (typeof args.expectedHash === 'string' && args.expectedHash) ||
    seed

  const input: CanonicalSnapshotInput = {
    boardId,
    snapshotId,
    sourceRepoId:
      typeof args.sourceRepoId === 'string' && args.sourceRepoId.trim()
        ? args.sourceRepoId.trim()
        : 'mcp/replace_board_snapshot',
    sourceCommitSha: /^[a-f0-9]{7,64}$/i.test(String(commitSeed))
      ? String(commitSeed).toLowerCase()
      : hexCommitFromSeed(String(commitSeed)),
    generatedAt: new Date().toISOString(),
    producerVersion: 'board-mcp-replace_board_snapshot',
    projects,
    flows,
    nodes: nodes ?? [],
    tasks,
    dependencies: dependencies ?? [],
    featureContractJoins: featureContractJoins ?? [],
    nodeJoins: nodeJoins ?? [],
    primaryOwnerships: primaryOwnerships ?? [],
    classifications,
    anchors: anchors ?? [],
    acceptancePaths: acceptancePaths ?? [],
  }

  return produceCanonicalSnapshot(input)
}

function importAuthFromPrincipal(principal: Principal | null | undefined): ImportAuthContext {
  const scopes = principal?.scopes?.length
    ? [...principal.scopes]
    : principal?.role === 'ROOT_ORCHESTRATOR' || principal?.role === 'OWNER'
      ? ['import:write']
      : []
  // Always ensure import:write present for roles that authorize this tool (rbac already gated).
  if (
    (principal?.role === 'ROOT_ORCHESTRATOR' || principal?.role === 'OWNER') &&
    !scopes.includes('import:write')
  ) {
    scopes.push('import:write')
  }
  return {
    actorId: principal?.actorId ?? principal?.agentId ?? 'mcp-actor',
    scopes,
    role: principal?.role ?? null,
  }
}

/** Compatibility SnapshotReceipt-shaped response from plan/apply import. */
export function compatibilityReplaceBoardReceipt(opts: {
  boardId: string
  dryRun: boolean
  appliedCollections: string[]
  fromHash: string | null
  plan?: ImportPlanResult
  applied?: ImportApplyResult
  beforeCounts?: Record<string, number>
  afterCounts?: Record<string, number>
}): Record<string, unknown> {
  const canonicalHash =
    opts.applied?.canonicalHash ?? opts.plan?.canonicalHash ?? null
  return {
    ok: true as const,
    dryRun: opts.dryRun,
    boardId: opts.boardId,
    applied: opts.appliedCollections,
    before: opts.beforeCounts ?? {
      projects: 0,
      features: 0,
      tasks: 0,
      productionGates: 0,
      guideSections: 0,
      accounts: 0,
      runs: 0,
    },
    after: opts.afterCounts ?? {
      projects: 0,
      features: 0,
      tasks: 0,
      productionGates: 0,
      guideSections: 0,
      accounts: 0,
      runs: 0,
    },
    fromHash: opts.fromHash,
    toHash: opts.dryRun ? null : canonicalHash,
    // Provenance / import proof (non-breaking extras)
    ...(opts.plan
      ? {
          plan: {
            wouldApply: opts.plan.wouldApply,
            snapshotId: opts.plan.snapshotId,
            payloadSha256: opts.plan.payloadSha256,
            canonicalHash: opts.plan.canonicalHash,
            nextEntityRev: opts.plan.nextEntityRev,
            nextBoardRev: opts.plan.nextBoardRev,
            validation: opts.plan.validation,
          },
        }
      : {}),
    ...(opts.applied
      ? {
          import: {
            kind: opts.applied.kind,
            importId: opts.applied.importId,
            snapshotId: opts.applied.snapshotId,
            payloadSha256: opts.applied.payloadSha256,
            canonicalHash: opts.applied.canonicalHash,
            boardRev: opts.applied.boardRev,
            lifecycleRev: opts.applied.lifecycleRev,
            entityRev: opts.applied.entityRev,
            provenance: opts.applied.provenance,
            lifecycleEvidenceUnchanged: opts.applied.lifecycleEvidenceUnchanged,
            readback: opts.applied.readback,
          },
        }
      : {}),
  }
}

function appliedCollectionsFromReplaceArgs(args: Record<string, unknown>): string[] {
  const out: string[] = []
  if (args.projects !== undefined) out.push('projects')
  if (args.features !== undefined) out.push('features')
  if (args.tasks !== undefined) out.push('tasks')
  if (
    args.productionGates !== undefined ||
    args.prodMockLabel !== undefined ||
    args.prodHeadline !== undefined
  ) {
    out.push('productionGates')
  }
  if (args.guide !== undefined) out.push('guide')
  if (args.accounts !== undefined) out.push('accounts')
  if (args.runs !== undefined) out.push('runs')
  if (args.nodes !== undefined) out.push('nodes')
  if (args.dependencies !== undefined) out.push('dependencies')
  return out
}

function afterCountsFromSnapshot(snapshot: CanonicalSnapshot): Record<string, number> {
  return {
    projects: snapshot.payload.projects.length,
    features: snapshot.payload.flows.length,
    tasks: snapshot.payload.tasks.length,
    productionGates: 0,
    guideSections: 0,
    accounts: 0,
    runs: 0,
  }
}

/** Compatibility response for replace_accounts after durable sync. */
export function compatibilityReplaceAccountsResponse(
  ops: OpsData,
  sync: SyncAccountsResult,
): Record<string, unknown> {
  return {
    ...ops,
    ok: true as const,
    sourceRevision: sync.sourceRevision,
    acceptedCount: sync.acceptedCount,
    usableCapacity: sync.usableCapacity,
    stale: sync.stale,
    staleReason: sync.staleReason,
    boardRev: sync.boardRev,
    replayed: sync.replayed,
    dispatchMode: sync.capacity.dispatchMode,
  }
}

function typedError(e: unknown): { ok: false; error: string; code: string; details?: unknown } {
  if (e instanceof McpReadContractError) {
    return {
      ok: false,
      error: e.message,
      code: isSafeTypedErrorCode(e.code) ? e.code : 'MCP_HANDLER_ERROR',
      ...(sanitizeErrorDetails(e.details) !== undefined
        ? { details: sanitizeErrorDetails(e.details) }
        : {}),
    }
  }
  const err = e as { code?: string; message?: string; details?: unknown }
  const rawCode = typeof err?.code === 'string' ? err.code : ''
  if (rawCode && isSafeTypedErrorCode(rawCode)) {
    const msg =
      typeof err.message === 'string' &&
      err.message.length > 0 &&
      !MYSQL_ER_CODE_RE.test(err.message) &&
      !/\bER_[A-Z0-9_]+\b/.test(err.message)
        ? err.message
        : rawCode
    const details = sanitizeErrorDetails(err.details)
    return {
      ok: false,
      error: msg,
      code: rawCode,
      ...(details !== undefined ? { details } : {}),
    }
  }
  // Unexpected internal/OS/DB/fs (incl. ER_*): stable class only — no leak
  return {
    ok: false,
    error: 'MCP_HANDLER_ERROR',
    code: 'MCP_HANDLER_ERROR',
  }
}

/** Common pin identity for one board at call time (TM_PINNED_ENVELOPE_V1). */
export interface BoardPin {
  boardId: string
  boardRev: number
  lifecycleRev: number
  canonicalSnapshotId: string
  canonicalHash: string
  generatedAt: string
  freshnessAgeSeconds: number
  stale: boolean
  staleReason: string | null
}

/**
 * Resolve pin from durable board_revisions (via controlData.imports) + live boardHash fallback.
 * boardRev + lifecycleRev come from durable row when present — NEVER hardcode lifecycleRev=0
 * when a durable value exists. Honest zero only when row absent/unreadable.
 * Same pin identity is shared by every canonical/legacy read in a handler via this helper.
 */
async function resolveBoardPin(boardId: string): Promise<BoardPin> {
  const clock = systemClock()
  const generatedAt = clock.nowISO()
  const liveHash = await boardHash(boardId)

  let boardRev = 0
  let lifecycleRev = 0
  let durableSnapshotId: string | null = null
  let durableHash: string | null = null
  let hadDurableRow = false

  try {
    const ctx = resolveMcpRuntimeContext()
    const importState = await ctx.controlData.imports.getBoardState(boardId)
    if (importState) {
      hadDurableRow = true
      if (typeof importState.boardRev === 'number' && Number.isFinite(importState.boardRev) && importState.boardRev >= 0) {
        boardRev = importState.boardRev
      }
      if (
        typeof importState.lifecycleRev === 'number' &&
        Number.isFinite(importState.lifecycleRev) &&
        importState.lifecycleRev >= 0
      ) {
        lifecycleRev = importState.lifecycleRev
      }
      if (importState.canonicalSnapshotId && String(importState.canonicalSnapshotId).trim()) {
        durableSnapshotId = String(importState.canonicalSnapshotId).trim()
      }
      const h =
        (importState.canonicalHash && String(importState.canonicalHash).trim()) ||
        (importState.subjectHash && String(importState.subjectHash).trim()) ||
        null
      if (h) durableHash = h
    }
  } catch {
    // fall through to atomic + live hash
  }

  // Atomic boardRev if import path missing revs (still not inventing lifecycle).
  if (!hadDurableRow) {
    try {
      const st = await sharedAtomic(boardId).getBoardState(boardId)
      if (typeof st.boardRev === 'number' && Number.isFinite(st.boardRev)) {
        boardRev = st.boardRev
      }
    } catch {
      /* honest zero */
    }
  }

  const canonicalHash = durableHash ?? liveHash
  const canonicalSnapshotId =
    durableSnapshotId ?? `pin-${boardId}-${canonicalHash.slice(0, 16)}`

  return {
    boardId,
    boardRev,
    lifecycleRev,
    canonicalSnapshotId,
    canonicalHash,
    generatedAt,
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
  }
}

function boardPinToMcpReadPin(pin: BoardPin): McpReadPin {
  return {
    boardId: pin.boardId,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    generatedAt: pin.generatedAt,
    freshnessAgeSeconds: pin.freshnessAgeSeconds,
    stale: pin.stale,
    staleReason: pin.staleReason,
  }
}

// ---------------------------------------------------------------------------
// Canonical definition authority (single-authority read path)
// Pin-complete → sole definition from pinned snapshot. Lifecycle/run overlays
// left-join by task id only. Mismatch → fail closed (throw). No pin → legacy
// + honest PIN_AUTHORITY_INCOMPLETE stale (never invent non-zero pin success).
// ---------------------------------------------------------------------------

export type BoardDefinitionAuthority =
  | {
      mode: 'canonical'
      pin: BoardPin
      definition: CanonicalDefinitionReadModel
    }
  | {
      mode: 'legacy'
      pin: BoardPin
      authorityIncomplete: true
      incompleteCode: 'PIN_MISSING' | 'PIN_INCOMPLETE' | 'PIN_SYNTHETIC' | 'RUNTIME_UNAVAILABLE'
    }

/** Build BoardPin from validated definition pin fields (envelope must match loaded model). */
export function boardPinFromDefinitionPin(
  defPin: CanonicalDefinitionReadModel['pin'],
  generatedAt: string,
): BoardPin {
  return {
    boardId: defPin.boardId,
    boardRev: defPin.boardRev,
    lifecycleRev: defPin.lifecycleRev,
    canonicalSnapshotId: defPin.canonicalSnapshotId,
    canonicalHash: defPin.canonicalHash,
    generatedAt,
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
  }
}

/**
 * Resolve definition authority for list/get projects/features/tasks/work/overview.
 * Fail-closed when pin complete but snapshot/hash invalid (throws CanonicalReadModelError).
 * Legacy only when pin genuinely incomplete/missing — pin marked stale honestly.
 */
export async function resolveBoardDefinitionAuthority(
  boardId: string,
): Promise<BoardDefinitionAuthority> {
  const generatedAt = systemClock().nowISO()
  let imports: ReturnType<typeof resolveMcpRuntimeContext>['controlData']['imports'] | null =
    null
  try {
    imports = resolveMcpRuntimeContext().controlData.imports
  } catch {
    const pin = await resolveBoardPin(boardId)
    return {
      mode: 'legacy',
      pin: { ...pin, stale: true, staleReason: 'PIN_AUTHORITY_INCOMPLETE' },
      authorityIncomplete: true,
      incompleteCode: 'RUNTIME_UNAVAILABLE',
    }
  }

  const boardState = await imports.getBoardState(boardId)
  if (!boardState) {
    const pin = await resolveBoardPin(boardId)
    return {
      mode: 'legacy',
      pin: { ...pin, stale: true, staleReason: 'PIN_AUTHORITY_INCOMPLETE' },
      authorityIncomplete: true,
      incompleteCode: 'PIN_MISSING',
    }
  }

  if (!isPinComplete(boardState)) {
    const pin = await resolveBoardPin(boardId)
    const incompleteCode:
      | 'PIN_MISSING'
      | 'PIN_INCOMPLETE'
      | 'PIN_SYNTHETIC'
      | 'RUNTIME_UNAVAILABLE' = isSyntheticCanonicalSnapshotId(
      boardId,
      boardState.canonicalSnapshotId,
    )
      ? 'PIN_SYNTHETIC'
      : 'PIN_INCOMPLETE'
    return {
      mode: 'legacy',
      pin: {
        ...pin,
        boardRev: boardState.boardRev,
        lifecycleRev: boardState.lifecycleRev,
        stale: true,
        staleReason: 'PIN_AUTHORITY_INCOMPLETE',
      },
      authorityIncomplete: true,
      incompleteCode,
    }
  }

  // Pin complete: sole authority — throw on mismatch (never merge legacy definition).
  const definition = await loadPinnedDefinitionReadModel(imports, boardId)
  return {
    mode: 'canonical',
    pin: boardPinFromDefinitionPin(definition.pin, generatedAt),
    definition,
  }
}

/** Soft-load lifecycle WorkTask rows for left-join overlay (never definition authority). */
export async function loadLifecycleTaskOverlay(
  boardId: string,
): Promise<Map<string, WorkTask>> {
  try {
    const doc = await readTasks(boardId)
    const map = new Map<string, WorkTask>()
    for (const t of doc.tasks ?? []) {
      if (t?.id) map.set(t.id, t)
    }
    return map
  } catch {
    return new Map()
  }
}

/** Soft-load runs grouped by taskId (overlay only). */
export async function loadRunsByTaskOverlay(
  boardId: string,
): Promise<Record<string, Array<{ id: string; status: string; role?: string; verdict?: string | null; updated?: string; started?: string }>>> {
  const byTask: Record<
    string,
    Array<{ id: string; status: string; role?: string; verdict?: string | null; updated?: string; started?: string }>
  > = {}
  try {
    const rows = await sharedRunStore().list(boardId)
    for (const r of rows) {
      if (!r.taskId) continue
      const status =
        r.state === 'RUNNING' || r.state === 'STARTING' || r.state === 'RESERVED'
          ? 'running'
          : r.state === 'QUEUED'
            ? 'queued'
            : r.state === 'SUCCEEDED' || r.state === 'FAILED' || r.state === 'CANCELLED'
              ? 'done'
              : String(r.state ?? '').toLowerCase()
      ;(byTask[r.taskId] ??= []).push({
        id: r.runId,
        status,
        role: r.role ?? undefined,
        verdict: null,
        updated:
          r.heartbeatAtMs != null
            ? new Date(r.heartbeatAtMs).toISOString()
            : r.registeredAtMs != null
              ? new Date(r.registeredAtMs).toISOString()
              : undefined,
        started:
          r.registeredAtMs != null ? new Date(r.registeredAtMs).toISOString() : undefined,
      })
    }
  } catch {
    /* empty overlay */
  }
  return byTask
}

/** Soft-load lifecycle config for readiness display (overlay; fail → empty stages). */
async function loadLifecycleConfigSoft(boardId: string) {
  try {
    return await readLifecycle(boardId)
  } catch {
    return {
      stages: [] as Array<{ key: string; label: string; readiness?: number }>,
      allowSkip: false,
      allowRegression: true,
      formulaVersion: 'v1',
    }
  }
}

/**
 * Map canonical definition tasks → list_tasks rows with lifecycle/run left-join.
 * Never includes legacy-only task ids; never fabricates lifecycle stage.
 */
export function mapCanonicalTasksToListRows(
  projection: CanonicalDefinitionProjection,
  opts: {
    pinGeneratedAt: string
    cfg: Parameters<typeof stageReadiness>[0]
    lifecycleByTaskId: Map<string, WorkTask>
    runsByTask: Record<string, Array<{ id: string; status: string; role?: string; verdict?: string | null; updated?: string; started?: string }>>
  },
) {
  const depCountByTask = new Map<string, number>()
  for (const d of projection.dependencies) {
    depCountByTask.set(d.fromTaskId, (depCountByTask.get(d.fromTaskId) ?? 0) + 1)
  }
  // featureContractId from joins when task row omits it
  const fcByTask = new Map<string, string>()
  for (const j of projection.featureContractJoins) {
    if (!fcByTask.has(j.taskId)) fcByTask.set(j.taskId, j.featureContractId)
  }

  return projection.tasks.map((ct) => {
    const overlay = opts.lifecycleByTaskId.get(ct.id)
    const stage = overlay?.lifecycleStage ?? null
    const checkpoints = overlay?.checkpoints ?? []
    const featureContractId =
      (typeof ct.featureContractId === 'string' && ct.featureContractId) ||
      fcByTask.get(ct.id) ||
      overlay?.featureContractId ||
      null
    const readyPct = stageReadiness(opts.cfg, stage)
    const derived = deriveCheckpoints(readyPct, checkpoints)
    return {
      id: ct.id,
      title: (typeof ct.title === 'string' && ct.title) || overlay?.title || ct.id,
      projectId: ct.projectId ?? overlay?.projectId ?? null,
      featureId: featureContractId,
      featureContractId,
      phase: overlay?.phase ?? null,
      scope: overlay?.scope ?? null,
      lifecycleStage: stage,
      readinessPercent: readyPct,
      nextGate: nextStage(opts.cfg, stage)?.key ?? null,
      nextEvidence: nextEvidence(opts.cfg, stage),
      blockedReason: overlay?.blockedReason ?? null,
      lastReceiptAt: overlay?.lastReceiptAt ?? null,
      ...runInfo(opts.runsByTask[ct.id]),
      done: checkpoints.filter((c) => c.done).length,
      total: checkpoints.length,
      deps: depCountByTask.get(ct.id) ?? overlay?.dependencies?.length ?? 0,
      derivedDone: derived.done,
      createdAt: overlay?.updated ?? overlay?.lastReceiptAt ?? opts.pinGeneratedAt,
    }
  })
}

/** Map canonical projects → list_projects rows (definition only; no fabricated progress). */
export function mapCanonicalProjectsToListRows(
  projection: CanonicalDefinitionProjection,
  pinGeneratedAt: string,
) {
  const flowCountByProject = new Map<string, number>()
  for (const f of projection.flows) {
    flowCountByProject.set(f.projectId, (flowCountByProject.get(f.projectId) ?? 0) + 1)
  }
  return projection.projects.map((p) => ({
    id: p.id,
    nama: (typeof p.name === 'string' && p.name) || p.id,
    status: typeof p.status === 'string' ? p.status : null,
    stage: typeof p.stage === 'string' ? p.stage : null,
    progress: typeof p.progress === 'number' ? p.progress : 0,
    featureCount: flowCountByProject.get(p.id) ?? 0,
    activeAgents: 0,
    createdAt: pinGeneratedAt,
  }))
}

/** Map canonical flows → list_features rows (flows = feature contracts). */
export function mapCanonicalFlowsToFeatureRows(
  projection: CanonicalDefinitionProjection,
  pinGeneratedAt: string,
) {
  const taskCountByFlow = new Map<string, number>()
  for (const j of projection.featureContractJoins) {
    taskCountByFlow.set(
      j.featureContractId,
      (taskCountByFlow.get(j.featureContractId) ?? 0) + 1,
    )
  }
  // Also count tasks that reference featureContractId directly
  for (const t of projection.tasks) {
    if (typeof t.featureContractId === 'string' && t.featureContractId) {
      if (!taskCountByFlow.has(t.featureContractId)) {
        taskCountByFlow.set(t.featureContractId, 0)
      }
    }
  }
  return projection.flows.map((f) => {
    const taskTotal = taskCountByFlow.get(f.id) ?? 0
    return {
      id: f.id,
      nama: (typeof f.name === 'string' && f.name) || f.id,
      fase: typeof f.fase === 'string' ? f.fase : 'backlog',
      phaseLabel: typeof f.fase === 'string' ? String(f.fase) : 'backlog',
      blocked: null as string | null,
      isBlocked: false,
      projectId: f.projectId,
      taskDone: 0,
      taskTotal,
      pct: null as number | null,
      createdAt: pinGeneratedAt,
    }
  })
}

/** Work-item rows from canonical tasks (definition membership only). */
export function mapCanonicalTasksToWorkRows(
  projection: CanonicalDefinitionProjection,
  opts: {
    pinGeneratedAt: string
    lifecycleByTaskId: Map<string, WorkTask>
    /** Primary bucket from V3 rollup assignment (preferred over overlay bucket). */
    bucketByTaskId?: ReadonlyMap<string, string | null>
  },
) {
  const fcByTask = new Map<string, string>()
  for (const j of projection.featureContractJoins) {
    if (!fcByTask.has(j.taskId)) fcByTask.set(j.taskId, j.featureContractId)
  }
  return projection.tasks.map((ct) => {
    const overlay = opts.lifecycleByTaskId.get(ct.id)
    const featureId =
      (typeof ct.featureContractId === 'string' && ct.featureContractId) ||
      fcByTask.get(ct.id) ||
      overlay?.featureContractId ||
      null
    const rollupBucket = opts.bucketByTaskId?.get(ct.id)
    return {
      id: ct.id,
      title: (typeof ct.title === 'string' && ct.title) || overlay?.title || ct.id,
      projectId: ct.projectId ?? overlay?.projectId ?? null,
      featureId,
      lifecycleStage: overlay?.lifecycleStage ?? null,
      bucket:
        rollupBucket !== undefined
          ? rollupBucket
          : ((overlay as { bucket?: string | null } | undefined)?.bucket ?? null),
      overlay: (overlay as { overlay?: string | null } | undefined)?.overlay ?? null,
      staleFamily: !!(overlay as { staleFamily?: boolean } | undefined)?.staleFamily,
      createdAt: overlay?.updated ?? overlay?.lastReceiptAt ?? opts.pinGeneratedAt,
    }
  })
}

/** Fail-closed UNCLASSIFIED classification when store/projection row is missing/invalid. */
export function unclassifiedClassificationForTask(taskId: string): TaskClassificationRecord {
  return {
    taskId,
    taskClass: 'UNCLASSIFIED',
    disposition: 'UNCLASSIFIED',
    receipt: null,
  }
}

/**
 * Build V3 rollup task inputs over DISTINCT canonical definition task IDs only.
 * Left-joins lifecycle + classification by task id; never includes legacy-only rows.
 * Missing classification → honest UNCLASSIFIED (→ DATA_INTEGRITY via computeRollupV3).
 * Missing lifecycle stage → null (never fabricated).
 */
export function buildCanonicalRollupTaskInputs(
  projection: CanonicalDefinitionProjection,
  opts: {
    lifecycleByTaskId?: ReadonlyMap<string, WorkTask>
    classificationByTaskId?: ReadonlyMap<string, TaskClassificationRecord>
  } = {},
): RollupTaskInput[] {
  const life = opts.lifecycleByTaskId ?? new Map()
  const classById = opts.classificationByTaskId ?? new Map()
  // Snapshot classification is soft seed only when store missing — still needs receipt.
  const snapClassById = new Map<string, TaskClassificationRecord>()
  for (const c of projection.classifications) {
    if (!c?.taskId) continue
    const taskClass = c.taskClass
    const disposition = c.disposition
    if (
      !taskClass ||
      !disposition ||
      taskClass === 'UNCLASSIFIED' ||
      disposition === 'UNCLASSIFIED' ||
      !c.receiptId
    ) {
      snapClassById.set(c.taskId, unclassifiedClassificationForTask(c.taskId))
    } else {
      // Without a pin-bound receipt body, keep UNCLASSIFIED (never invent PRODUCT).
      snapClassById.set(c.taskId, unclassifiedClassificationForTask(c.taskId))
    }
  }

  // DISTINCT definition membership — prefer projection.distinctTaskIds, fall back to tasks.
  const distinctIds =
    projection.distinctTaskIds.length > 0
      ? projection.distinctTaskIds
      : [...new Set(projection.tasks.map((t) => t.id))].sort((a, b) =>
          a < b ? -1 : a > b ? 1 : 0,
        )

  const seen = new Set<string>()
  const inputs: RollupTaskInput[] = []
  for (const taskId of distinctIds) {
    if (!taskId || seen.has(taskId)) continue
    seen.add(taskId)
    const overlay = life.get(taskId)
    const cls =
      classById.get(taskId) ??
      snapClassById.get(taskId) ??
      unclassifiedClassificationForTask(taskId)
    // Normalize classification taskId; missing/invalid → UNCLASSIFIED.
    const classification: TaskClassificationRecord =
      !cls.taskClass ||
      !cls.disposition ||
      cls.taskClass === 'UNCLASSIFIED' ||
      cls.disposition === 'UNCLASSIFIED' ||
      !cls.receipt
        ? unclassifiedClassificationForTask(taskId)
        : { ...cls, taskId }
    inputs.push({
      taskId,
      classification,
      lifecycleStage: overlay?.lifecycleStage ?? null,
      evidence: null,
      p0Blocker: classification.taskClass === 'UNCLASSIFIED',
    })
  }
  return inputs
}

/**
 * Pure V3 rollup over DISTINCT canonical definition task IDs + left-join overlays.
 * Pin fields must match the loaded definition pin (caller responsibility).
 */
export function computeCanonicalDefinitionRollup(
  pin: BoardPin,
  projection: CanonicalDefinitionProjection,
  opts: {
    lifecycleByTaskId?: ReadonlyMap<string, WorkTask>
    classificationByTaskId?: ReadonlyMap<string, TaskClassificationRecord>
    now?: string
  } = {},
): RollupV3Result {
  const tuple = pinToTuple(pin)
  const tasks = buildCanonicalRollupTaskInputs(projection, {
    lifecycleByTaskId: opts.lifecycleByTaskId,
    classificationByTaskId: opts.classificationByTaskId,
  })
  // Denominator is DISTINCT definition task IDs (tasks array). Do not pass
  // featureContractJoins/nodeJoins here: importer may pair one FC with many tasks,
  // and computeRollupV3.assertDistinctJoins treats FC id as unique (would throw
  // DUPLICATE_FC_JOIN and empty the overview). Dependency/ownership integrity
  // remains the importer's job at apply time.
  return computeRollupV3({
    pin: tuple,
    tasks,
    g5Domains: [],
    now: opts.now ?? pin.generatedAt,
  })
}

/** Soft-load durable classification map for left-join (never definition authority). */
export async function loadClassificationOverlay(
  boardId: string,
): Promise<Map<string, TaskClassificationRecord>> {
  const map = new Map<string, TaskClassificationRecord>()
  try {
    const rows = await resolveMcpRuntimeContext().controlData.classification.list(boardId)
    for (const r of rows) {
      if (r?.taskId) map.set(r.taskId, r)
    }
  } catch {
    /* empty overlay — missing rows fail UNCLASSIFIED at rollup join */
  }
  return map
}

/**
 * Compatibility lifecycle-shaped rollup summary derived from DISTINCT definition
 * left-join (not lifecycle-table orphans). Used for get_overview / get_rollup
 * clients that still read counts/readinessPercent/active/hold.
 */
export function legacyShapedRollupFromCanonical(
  v3: RollupV3Result,
  projection: CanonicalDefinitionProjection,
  lifecycleByTaskId: ReadonlyMap<string, WorkTask>,
  cfg: { stages: Array<{ key: string; readiness?: number; milestone?: boolean }>; formulaVersion?: string },
): Record<string, unknown> {
  const order = cfg.stages.map((s) => s.key)
  const readiness: Record<string, number> = {}
  const n = order.length
  cfg.stages.forEach((s, i) => {
    readiness[s.key] =
      s.readiness ?? (n > 1 ? Math.round((i / (n - 1)) * 100) : 100)
  })
  const counts: Record<string, number> = {}
  for (const k of order) counts[k] = 0

  let hold = 0
  let active = 0
  let uninitialized = 0
  let sumReadiness = 0
  const milestoneStage =
    cfg.stages.find((s) => s.milestone) ??
    cfg.stages.find((s) => (readiness[s.key] ?? 0) >= 100) ??
    cfg.stages[n - 1]
  const milestone = milestoneStage?.key ?? null
  const milestoneIdx = milestone ? order.indexOf(milestone) : -1
  let atMilestone = 0
  let liveVerified = 0

  // DISTINCT definition membership only — never lifecycle orphans.
  const distinctIds =
    projection.distinctTaskIds.length > 0
      ? projection.distinctTaskIds
      : projection.tasks.map((t) => t.id)

  for (const taskId of distinctIds) {
    const overlay = lifecycleByTaskId.get(taskId)
    const scope = (overlay?.scope ?? '').toUpperCase()
    if (scope === 'HOLD') {
      hold++
      continue
    }
    active++
    const stage = overlay?.lifecycleStage ?? null
    const idx = stage == null ? -1 : order.indexOf(stage)
    const ready = stage && stage in readiness ? readiness[stage] : 0
    sumReadiness += ready
    if (milestoneIdx >= 0 && idx >= milestoneIdx) atMilestone++
    if (milestoneIdx >= 0 && idx > milestoneIdx) liveVerified++
    if (idx < 0) uninitialized++
    else counts[stage as string] = (counts[stage as string] ?? 0) + 1
  }

  return {
    formulaVersion: cfg.formulaVersion ?? 'v3-canonical',
    readyStage: milestone,
    stages: cfg.stages,
    counts,
    readiness,
    readinessPercent: active ? Math.round(sumReadiness / active) : 0,
    milestone,
    atMilestone,
    prodReady: atMilestone,
    liveVerified,
    uninitialized,
    hold,
    active,
    // V3 bucket coverage bound to same DISTINCT definition set
    buckets: { ...v3.buckets },
    overlays: { ...v3.overlays },
    trackedWorkDenominator: v3.trackedWorkDenominator,
    productDenominator: v3.productDenominator,
    unclassifiedCount: v3.unclassifiedCount,
    boardReadinessPercent: v3.boardReadinessPercent,
    rawTaskReadinessPercent: v3.rawTaskReadinessPercent,
    complete: v3.complete,
    g5Pass: v3.g5Pass,
    hasP0OrDataIntegrityBlocker: v3.hasP0OrDataIntegrityBlocker,
    distinctDefinitionTaskCount: distinctIds.length,
    note: 'canonical_definition_distinct_left_join',
  }
}

/** @internal test helper — adapter surface over current ImportStorage. */
export function createMcpCanonicalDefinitionAdapter() {
  const storage = resolveMcpRuntimeContext().controlData.imports
  return createCanonicalDefinitionReadAdapter(storage)
}

function pinToTuple(pin: BoardPin): PinnedRevisionTuple {
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.canonicalHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
  }
}

/**
 * Common pinned envelope for ALL authenticated canonical reads + legacy aliases.
 * Pin fields always win over data keys. Data is nested under `data` (contract) and
 * also flattened to the top level so legacy clients that read `projects`/`tasks` keep working.
 */
function pinnedEnvelope(pin: BoardPin, data: unknown, extra: Record<string, unknown> = {}) {
  const env = {
    schemaVersion: 'TM_PINNED_ENVELOPE_V1' as const,
    boardId: pin.boardId,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    generatedAt: pin.generatedAt,
    freshnessAgeSeconds: pin.freshnessAgeSeconds,
    stale: pin.stale,
    staleReason: pin.staleReason,
    nextCursor: (extra.nextCursor as unknown) ?? null,
    cursor: (extra.cursor as unknown) ?? null,
    freshness:
      extra.freshness ??
      ({ ageSeconds: pin.freshnessAgeSeconds, stale: pin.stale, reason: pin.staleReason } as const),
    data,
  }
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    // Legacy flatten: resource fields at top level; pin/envelope fields take precedence.
    return { ...(data as Record<string, unknown>), ...env, data }
  }
  return env
}

async function pinnedEnvelopeFromBoard(
  boardId: string,
  data: unknown,
  extra: Record<string, unknown> = {},
) {
  const pin = await resolveBoardPin(boardId)
  // Allow callers to override pin fields only when they hold a fresher known pin (never invent success).
  const merged: BoardPin = {
    ...pin,
    boardRev: typeof extra.boardRev === 'number' ? (extra.boardRev as number) : pin.boardRev,
    lifecycleRev:
      typeof extra.lifecycleRev === 'number' ? (extra.lifecycleRev as number) : pin.lifecycleRev,
    canonicalSnapshotId:
      typeof extra.canonicalSnapshotId === 'string'
        ? (extra.canonicalSnapshotId as string)
        : pin.canonicalSnapshotId,
    canonicalHash:
      typeof extra.canonicalHash === 'string' ? (extra.canonicalHash as string) : pin.canonicalHash,
    stale: typeof extra.stale === 'boolean' ? (extra.stale as boolean) : pin.stale,
    staleReason:
      extra.staleReason === null || typeof extra.staleReason === 'string'
        ? (extra.staleReason as string | null)
        : pin.staleReason,
  }
  return pinnedEnvelope(merged, data, extra)
}

export function registerBoardTools(server: McpServer, auth: McpAuthContext = { principal: null, mechanism: { kind: 'DECISION_AUTH_MECHANISM_REQUIRED', reason: 'default' }, bearerPresent: false }): void {
  const principal = auth.principal
  writeToolSchemaRegistry.clear()

  function secureTool(
    name: string,
    meta: { title: string; description: string; inputSchema: Record<string, unknown> | object },
    handler: (args: any) => Promise<ReturnType<typeof jsonText>> | ReturnType<typeof jsonText>,
  ): void {
    if (!isToolListable(principal, name)) return
    server.registerTool(name as any, meta as any, async (args: any) => {
      const gate = authorizeToolCall(principal, name, (args ?? {}) as Record<string, unknown>)
      if (!gate.ok) {
        return jsonText(authErrorEnvelope(gate.code ?? 'AUTHORIZATION_REQUIRED', gate.message))
      }
      // ROOT-only ops when mechanism missing should already have principal from bearer;
      // if DECISION_AUTH and somehow listed, deny non-public.
      if (!principal && name !== 'get_public_snapshot') {
        return jsonText(authErrorEnvelope('AUTHORIZATION_REQUIRED'))
      }
      try {
        return await handler(args ?? {})
      } catch (e) {
        return jsonText(typedError(e))
      }
    })
  }

  /**
   * Write tools: merge full mutation envelope into schema, record for tests,
   * authorize via secureTool. Handler still must call runMutationGate (legacy)
   * or assertMutationEnvelopeOrThrow (V3 domain-owned CAS).
   */
  function secureWriteTool(
    name: string,
    meta: { title: string; description: string; inputSchema: Record<string, unknown> | object },
    handler: (args: any) => Promise<ReturnType<typeof jsonText>> | ReturnType<typeof jsonText>,
  ): void {
    const inputSchema = mergeMutationEnvelope(meta.inputSchema)
    const keys = schemaKeysOf(inputSchema)
    writeToolSchemaRegistry.set(name, keys)
    const desc =
      meta.description.includes('entityExpectedRev') || meta.description.includes('idempotencyKey')
        ? meta.description
        : `${meta.description} Requires mutation envelope: entityExpectedRev, expectedBoardRev, canonicalHash|subjectHash, idempotencyKey (no silent defaults).`
    secureTool(name, { ...meta, description: desc, inputSchema }, handler)
  }

  const actorIdOf = () => principal?.actorId ?? principal?.agentId ?? 'mcp-actor'


  // ---- boards ----
  secureTool(
    'list_boards',
    { title: 'List boards', description: 'List all boards (each board is its own scope).', inputSchema: {} },
    async () => jsonText({ boards: await listBoards() }),
  )
  secureWriteTool(
    'create_board',
    { title: 'Create board', description: 'Create a new empty board.', inputSchema: { id: z.string(), name: z.string(), description: z.string().optional() } },
    async (args) => {
      try {
        const { id, name, description } = args
        const result = await runMutationGate(
          {
            toolName: 'create_board',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'board',
            entityId: id,
            requestBody: args,
            skipPinHashCheck: true,
            skipBoardRevCheck: true,
          },
          async () => ({ ok: true as const, boards: await createBoard(id, name, description) }),
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )

  // ---- reads (canonical validateReadFilters + TM_PINNED_ENVELOPE_V1 + cursor) ----
  secureTool(
    'list_projects',
    {
      title: 'List projects',
      description:
        "List a board's projects with status, stage, progress. Cursor pagination (createdAt,id DESC; default 50; max 200).",
      inputSchema: {
        ...BOARD_ARG,
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_projects', {
        boardId: id,
        cursor: rawArgs.cursor,
        pageSize: rawArgs.pageSize,
      })
      const authz = await resolveBoardDefinitionAuthority(id)
      const pin = authz.pin
      let mapped: Array<{
        id: string
        nama: string
        status: string | null
        stage: string | null
        progress: number
        featureCount: number
        activeAgents: number
        createdAt: string
      }>
      if (authz.mode === 'canonical') {
        mapped = mapCanonicalProjectsToListRows(authz.definition.projection, pin.generatedAt)
      } else {
        const m = await modelOf(id)
        mapped = m.projects.map((p) => ({
          id: p.id,
          nama: p.nama,
          status: p.status,
          stage: p.stage ?? null,
          progress: p.progress,
          featureCount: p.features.length,
          activeAgents: p.activeAgents,
          // Stable cursor key: projects lack stored createdAt — pin time + id sort.
          createdAt: pin.generatedAt,
        }))
      }
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { projects: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_projects', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, projects: page.items })
    },
  )
  secureTool(
    'get_project',
    {
      title: 'Get project',
      description: 'Exact project rollup by id/projectId (pinned envelope).',
      inputSchema: {
        ...BOARD_ARG,
        id: z.string().optional(),
        projectId: z.string().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_project', { ...rawArgs, boardId: id })
      const projectId = (filters as { id: string }).id
      const authz = await resolveBoardDefinitionAuthority(id)
      const pin = authz.pin
      if (authz.mode === 'canonical') {
        const proj = authz.definition.projection.projects.find((p) => p.id === projectId)
        if (!proj) {
          return jsonText({ ok: false, error: `project not found: ${projectId}`, code: 'NOT_FOUND' })
        }
        const flows = mapCanonicalFlowsToFeatureRows(authz.definition.projection, pin.generatedAt).filter(
          (f) => f.projectId === projectId,
        )
        const project = {
          id: proj.id,
          nama: (typeof proj.name === 'string' && proj.name) || proj.id,
          status: typeof proj.status === 'string' ? proj.status : null,
          stage: typeof proj.stage === 'string' ? proj.stage : null,
          progress: typeof proj.progress === 'number' ? proj.progress : 0,
          featureCount: flows.length,
          activeAgents: 0,
          design: [],
          features: flows,
          createdAt: pin.generatedAt,
        }
        const env = buildPinnedReadEnvelope(
          boardPinToMcpReadPin(pin),
          { project },
          { method: 'get_project', nextCursor: null },
        )
        return jsonText({ ...env, project })
      }
      const m = await modelOf(id)
      const p = m.projById[projectId]
      if (!p) return jsonText({ ok: false, error: `project not found: ${projectId}`, code: 'NOT_FOUND' })
      const project = {
        id: p.id,
        nama: p.nama,
        status: p.status,
        stage: p.stage ?? null,
        progress: p.progress,
        featureCount: p.features.length,
        activeAgents: p.activeAgents,
        design: p.design,
        features: p.features.map((f) => featureSummary(f)),
        createdAt: pin.generatedAt,
      }
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { project },
        { method: 'get_project', nextCursor: null },
      )
      return jsonText({ ...env, project })
    },
  )
  secureTool(
    'list_features',
    {
      title: 'List features',
      description:
        'List features with cursor/pageSize (createdAt,id DESC; default 50; max 200). Compatibility filters: projectId, status (fase).',
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string().optional(),
        status: z.string().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      // Canonical allowlist is boardId/cursor/pageSize only; projectId/status are compatibility filters.
      const filters = validateReadFilters('list_features', {
        boardId: id,
        cursor: rawArgs.cursor,
        pageSize: rawArgs.pageSize,
      })
      const authz = await resolveBoardDefinitionAuthority(id)
      const pin = authz.pin
      let mapped: Array<ReturnType<typeof featureSummary> & { createdAt: string }>
      if (authz.mode === 'canonical') {
        let features = mapCanonicalFlowsToFeatureRows(authz.definition.projection, pin.generatedAt)
        if (typeof rawArgs.projectId === 'string' && rawArgs.projectId) {
          features = features.filter((f) => f.projectId === rawArgs.projectId)
        }
        if (typeof rawArgs.status === 'string' && rawArgs.status) {
          features = features.filter((f) => String(f.fase) === rawArgs.status)
        }
        mapped = features.map((f) => ({
          id: f.id,
          nama: f.nama,
          fase: f.fase,
          phaseLabel: f.phaseLabel,
          blocked: f.blocked,
          isBlocked: f.isBlocked,
          projectId: f.projectId,
          taskDone: f.taskDone,
          taskTotal: f.taskTotal,
          pct: f.pct,
          createdAt: f.createdAt,
        }))
      } else {
        let features = (await modelOf(id)).features
        if (typeof rawArgs.projectId === 'string' && rawArgs.projectId) {
          features = features.filter((f) => f.projectId === rawArgs.projectId)
        }
        if (typeof rawArgs.status === 'string' && rawArgs.status) {
          features = features.filter((f) => String(f.fase) === rawArgs.status)
        }
        mapped = features.map((f) => ({
          ...featureSummary(f),
          createdAt: f.updated ?? pin.generatedAt,
        }))
      }
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { features: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_features', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, features: page.items })
    },
  )
  secureTool(
    'get_feature',
    {
      title: 'Get feature',
      description: 'Exact feature by id/featureId incl checklist, runs, comments, design (pinned envelope).',
      inputSchema: {
        ...BOARD_ARG,
        id: z.string().optional(),
        featureId: z.string().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_feature', { ...rawArgs, boardId: id })
      const featureId = (filters as { id: string }).id
      const authz = await resolveBoardDefinitionAuthority(id)
      const pin = authz.pin
      if (authz.mode === 'canonical') {
        const flow = authz.definition.projection.flows.find((f) => f.id === featureId)
        if (!flow) {
          return jsonText({ ok: false, error: `feature not found: ${featureId}`, code: 'NOT_FOUND' })
        }
        const row = mapCanonicalFlowsToFeatureRows(authz.definition.projection, pin.generatedAt).find(
          (f) => f.id === featureId,
        )!
        const feature = {
          ...row,
          kelompok: null,
          track: null,
          tier: null,
          impact: [],
          catatan: null,
          deps: [],
          links: [],
          branch: null,
          bucket: null,
          parked: false,
          updated: null,
          checklist: [],
          runs: [],
          comments: [],
          design: [],
          createdAt: pin.generatedAt,
        }
        const env = buildPinnedReadEnvelope(
          boardPinToMcpReadPin(pin),
          { feature },
          { method: 'get_feature', nextCursor: null },
        )
        return jsonText({ ...env, feature })
      }
      const f = (await modelOf(id)).featById[featureId]
      if (!f) return jsonText({ ok: false, error: `feature not found: ${featureId}`, code: 'NOT_FOUND' })
      const feature = {
        ...featureSummary(f),
        kelompok: f.kelompok ?? null,
        track: f.track ?? null,
        tier: f.tier ?? null,
        impact: f.impact ?? [],
        catatan: f.catatan ?? null,
        deps: f.deps ?? [],
        links: f.links ?? [],
        branch: f.branch ?? null,
        bucket: f.bucket ?? null,
        parked: f.parked,
        updated: f.updated ?? null,
        checklist: f.checklist ?? [],
        runs: f.runs,
        comments: f.comments,
        design: f.design,
        createdAt: f.updated ?? pin.generatedAt,
      }
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { feature },
        { method: 'get_feature', nextCursor: null },
      )
      return jsonText({ ...env, feature })
    },
  )
  secureTool(
    'list_runs',
    {
      title: 'List agent runs',
      description: 'List durable control-plane runs (cursor/pageSize). Status/taskId filters.',
      inputSchema: {
        ...BOARD_ARG,
        status: z.string().optional(),
        taskId: z.string().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_runs', { ...rawArgs, boardId: id })
      const pin = await resolveBoardPin(id)
      let rows = await sharedRunStore().list(id)
      const status = 'status' in filters ? filters.status : undefined
      const taskId = 'taskId' in filters ? filters.taskId : undefined
      if (status) rows = rows.filter((r) => r.state === status || (r as { status?: string }).status === status)
      if (taskId) rows = rows.filter((r) => r.taskId === taskId)
      const mapped = rows.map((r) => ({
        id: r.runId,
        runId: r.runId,
        createdAt: r.registeredAtMs != null ? new Date(r.registeredAtMs).toISOString() : pin.generatedAt,
        status: r.state,
        taskId: r.taskId,
        agentId: r.agentId,
        model: r.model,
        planId: r.planId,
        fencingToken: r.fencingToken,
        entityRev: r.entityRev,
        boardRev: r.boardRev,
        stalled: r.stalled,
      }))
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { runs: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_runs', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, runs: page.items })
    },
  )
  secureTool(
    'get_run',
    {
      title: 'Get run',
      description: 'Single durable run by runId (control-plane registry).',
      inputSchema: { ...BOARD_ARG, id: z.string().optional(), runId: z.string().optional() },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_run', { ...rawArgs, boardId: id })
      const runId = (filters as { id: string }).id
      const pin = await resolveBoardPin(id)
      const rec = await sharedRunStore().get(id, runId)
      if (!rec) return jsonText({ ok: false, error: `run not found: ${runId}`, code: 'NOT_FOUND' })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { run: rec },
        { method: 'get_run', nextCursor: null },
      )
      return jsonText({ ...env, run: rec })
    },
  )
  secureTool(
    'list_queue',
    {
      title: 'List legacy feature queue',
      description:
        'LEGACY feature queue (now / next feature ids + catatan). NOT control-plane dispatch NEXT — use get_next / selectedForNextDispatch.',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const m = await modelOf(id)
      const legacyFeatureQueue = asLegacyFeatureQueue({
        now: m.queue.now.map((f) => ({ id: f.id, nama: f.nama })),
        next: m.queue.next.map((f) => ({ id: f.id, nama: f.nama })),
        catatan: m.queue.catatan ?? null,
      })
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          legacyFeatureQueue,
          // legacy flat keys retained for old clients; tagged so C3 can drop the visual "Next" label
          queueKind: 'legacy_feature_queue' as const,
          now: legacyFeatureQueue.now,
          next: legacyFeatureQueue.next,
          catatan: legacyFeatureQueue.catatan,
          soleSourceNote: 'dispatch NEXT is get_next / selectedForNextDispatch only',
        }),
      )
    },
  )

  // ---- writes (legacy compatibility — full mutation envelope + durable gate) ----
  secureWriteTool(
    'toggle_task',
    { title: 'Toggle checklist task', description: 'Toggle (or set) a feature checklist task done flag.', inputSchema: { ...BOARD_ARG, featureId: z.string(), index: z.number().int(), done: z.boolean().optional() } },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'toggle_task',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.featureId,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const before = buildModel(await readBoard(id)).featById[args.featureId]
            if (!before) throwNotFound(`feature not found: ${args.featureId}`, { featureId: args.featureId })
            const f = buildModel(await toggleTask(id, args.featureId, args.index, args.done)).featById[
              args.featureId
            ]
            if (!f) throwNotFound(`feature not found: ${args.featureId}`, { featureId: args.featureId })
            return { feature: { ...featureSummary(f), checklist: f.checklist ?? [] } }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'set_feature_phase',
    { title: 'Set feature phase', description: "Set a feature's fase (phase).", inputSchema: { ...BOARD_ARG, featureId: z.string(), fase: z.string() } },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_feature_phase',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.featureId,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const before = buildModel(await readBoard(id)).featById[args.featureId]
            if (!before) throwNotFound(`feature not found: ${args.featureId}`, { featureId: args.featureId })
            const f = buildModel(await setFeaturePhase(id, args.featureId, args.fase)).featById[
              args.featureId
            ]
            if (!f) throwNotFound(`feature not found: ${args.featureId}`, { featureId: args.featureId })
            return { feature: featureSummary(f) }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'upsert_run',
    { title: 'Register or update an agent run', description: 'The write path an agent uses to report itself. Call at launch, heartbeat, material transition, terminal verdict, and rotation. targetGate/evidencePath/verdict make the run productive on the agents board.', inputSchema: { ...BOARD_ARG, id: z.string(), agent: z.string().optional(), role: z.string().optional(), agentType: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), task: z.string().optional(), feature: z.string().optional(), taskId: z.string().optional(), account: z.string().optional(), project: z.string().optional(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']).optional(), targetGate: z.string().optional(), evidencePath: z.string().optional(), verdict: z.string().optional(), note: z.string().optional() } },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        // Authorize against *persisted* run owner, not request agentId/agent spoof.
        const boardSnap = await readBoard(id)
        const existing = (boardSnap.runs ?? []).find((r) => r.id === args.id) ?? null
        if (existing) {
          authorizePersistedRunOwner(principal, existing.agent ?? null)
        } else if (principal?.role === 'AGENT') {
          // Create: principal must be bound; ownership is forced to principal below.
          authorizePersistedRunOwner(principal, principal.agentId)
        }
        const result = await runMutationGate(
          {
            toolName: 'upsert_run',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'run',
            entityId: args.id,
            taskId: typeof args.taskId === 'string' ? args.taskId : null,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const patch: Parameters<typeof upsertRun>[1] = { id: args.id }
            for (const k of [
              'agent',
              'role',
              'agentType',
              'model',
              'effort',
              'task',
              'feature',
              'taskId',
              'account',
              'project',
              'status',
              'targetGate',
              'evidencePath',
              'verdict',
              'note',
            ] as const) {
              if (args[k] !== undefined) (patch as Record<string, unknown>)[k] = args[k]
            }
            // Attribution from authenticated principal only — never trust request agent for AGENT.
            if (principal?.role === 'AGENT' && principal.agentId) {
              patch.agent = principal.agentId
            } else if (principal?.role === 'ROOT_ORCHESTRATOR' || principal?.role === 'OWNER') {
              // Keep request agent when present; else attribute to principal actor.
              if (patch.agent === undefined) patch.agent = actorIdOf()
            }
            const raw = await upsertRun(id, patch)
            return { run: raw.runs?.find((r) => r.id === args.id) ?? null }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'set_run_status',
    { title: 'Set run status', description: "Update an agent run's status.", inputSchema: { ...BOARD_ARG, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) } },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const boardSnap = await readBoard(id)
        const existing = (boardSnap.runs ?? []).find((r) => r.id === args.id) ?? null
        if (!existing) {
          // Not-found BEFORE gate → does not consume idempotency/revision.
          throwNotFound(`run not found: ${args.id}`, { runId: args.id, boardId: id })
        }
        authorizePersistedRunOwner(principal, existing.agent ?? null)
        const result = await runMutationGate(
          {
            toolName: 'set_run_status',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'run',
            entityId: args.id,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const raw = await setRunStatus(id, args.id, args.status)
            return { run: raw.runs?.find((r) => r.id === args.id) ?? null }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )

  // ---- agent knowledge ----
  secureTool(
    'get_conventions',
    { title: 'Get conventions', description: 'The Cairn playbook. Read after connecting.', inputSchema: {} },
    async () => jsonText(await readConventions()),
  )
  secureTool(
    'get_workspace',
    { title: 'Get feature workspace', description: 'Canonical branch + git worktree path + repo for a feature.', inputSchema: { ...BOARD_ARG, featureId: z.string() } },
    async ({ boardId, featureId }) => {
      const f = (await modelOf(boardId)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      const conv = await readConventions()
      const repo = (f.projectId && conv.repos?.[f.projectId]) || '<repo>'
      const slug = f.branch ? f.branch.replace(/^(feature|fix|chore)\//, '') : featureId
      return jsonText({ featureId, project: f.projectId, repo, branch: f.branch ?? `feature/${slug}`, worktree: `worktrees/${repo}--${slug}`, steps: conv.usage ?? [] })
    },
  )
  secureTool(
    'get_design',
    { title: 'Get system design', description: 'Architecture / design links for a project or feature.', inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), featureId: z.string().optional() } },
    async ({ boardId, projectId, featureId }) => {
      const m = await modelOf(boardId)
      if (featureId) {
        const f = m.featById[featureId]
        if (!f) return jsonText({ error: `feature not found: ${featureId}` })
        return jsonText({ feature: featureId, design: f.design, links: f.links ?? [] })
      }
      const p = projectId ? m.projById[projectId] : null
      if (!p) return jsonText({ error: 'pass projectId or featureId' })
      const docs = p.docs as Record<string, unknown> | undefined
      return jsonText({ project: p.id, komponen: p.komponen ?? [], arsitektur: docs?.arsitektur ?? null, baseline: docs?.baseline ?? null, pages: docs?.pages ?? null, design: p.design, design_foundation: p.design_foundation ?? null, design_components: p.design_components ?? null, design_pages: p.design_pages ?? null })
    },
  )
  secureWriteTool(
    'set_project_design',
    {
      title: 'Upload system design',
      description:
        "Upload/replace a project's system design: component catalog (komponen), architecture note (arsitektur), baseline bullets, design-system links (foundation/components/pages URLs), and the all-pages catalog (pages). Only the fields you pass are changed.",
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string(),
        arsitektur: z.string().optional().describe('Architecture / system-design prose'),
        baseline: z.array(z.string()).optional().describe('Baseline / foundation bullets'),
        komponen: z
          .array(z.object({ nama: z.string(), jenis: z.string().optional(), stack: z.string().optional(), status: z.string().optional(), ket: z.string().optional() }).passthrough())
          .optional()
          .describe('Full component catalog (replaces existing)'),
        foundationUrl: z.string().optional().describe('Design-system foundation page URL'),
        componentsUrl: z.string().optional().describe('Design-system components page URL'),
        pagesUrl: z.string().optional().describe('Design-system pages/screens page URL'),
        pages: z
          .array(z.object({ nama: z.string(), route: z.string().optional(), status: z.string().optional(), ket: z.string().optional() }).passthrough())
          .optional()
          .describe('All-pages catalog (replaces existing)'),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      const { projectId, boardId: _b, entityExpectedRev: _e, expectedEntityRev: _ee, expectedRev: _er, expectedBoardRev: _br, canonicalHash: _ch, subjectHash: _sh, idempotencyKey: _ik, ...patch } = args
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_project_design',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'project',
            entityId: projectId,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const raw = await setProjectDesign(id, projectId, patch)
            const p = raw.projects.find((x) => x.id === projectId)
            const docs = p?.docs as Record<string, unknown> | undefined
            return {
              ok: true as const,
              project: projectId,
              komponen: p?.komponen ?? [],
              arsitektur: docs?.arsitektur ?? null,
              baseline: docs?.baseline ?? null,
              pages: docs?.pages ?? null,
              design_foundation: p?.design_foundation ?? null,
              design_components: p?.design_components ?? null,
              design_pages: p?.design_pages ?? null,
            }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'add_component',
    {
      title: 'Add a component',
      description: "Append one entry to a project's component catalog (komponen).",
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string(),
        nama: z.string(),
        jenis: z.string().optional(),
        stack: z.string().optional(),
        status: z.string().optional(),
        ket: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'add_component',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'project',
            entityId: args.projectId,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const { projectId, nama, jenis, stack, status, ket } = args
            const raw = await addComponent(id, projectId, { nama, jenis, stack, status, ket })
            const p = raw.projects.find((x) => x.id === projectId)
            return { ok: true as const, project: projectId, komponen: p?.komponen ?? [] }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )

  // ---- write suite: upsert/delete task & feature, set prod/guide/accounts, bulk snapshot ----
  const TASK_OBJ = z.object({ id: z.string(), title: z.string() }).passthrough()
  const FEATURE_OBJ = z.object({ id: z.string(), nama: z.string(), fase: z.string() }).passthrough()
  const GATE_OBJ = z.object({ id: z.string(), title: z.string() }).passthrough()
  const GUIDE_SEC = z.object({ title: z.string(), body: z.string() })
  const ACCOUNT_OBJ = z.object({ id: z.string(), label: z.string(), status: z.string(), usable: z.boolean() }).passthrough()
  const OPS_OBJ = z.object({ vault: z.record(z.string(), z.any()).optional(), accounts: z.array(ACCOUNT_OBJ), alert: z.record(z.string(), z.any()).optional() }).passthrough()
  const asErr = (e: unknown) => jsonText(typedError(e))

  secureWriteTool(
    'upsert_task',
    { title: 'Upsert a task', description: 'Create or update one first-class task (T-… id) with its full mapping. Merges into an existing task of the same id. Lifecycle state is preserved (use advance_task to move stage). Pass entityExpectedRev/expectedRev for optimistic-lock safety against concurrent writers.', inputSchema: { ...BOARD_ARG, task: TASK_OBJ } },
    async (args) => {
      const id = await bid(args.boardId)
      const taskId = String((args.task as { id?: string })?.id ?? '')
      try {
        const result = await runMutationGate(
          {
            toolName: 'upsert_task',
            boardId: id,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: taskId || id,
            // Definition upsert may create/repair rows — classification gate only when id present and not create-only path
            taskId: null,
            requestBody: { ...args, boardId: id },
          },
          async () => {
            const env = parseMutationEnvelope({ ...args, boardId: id })
            return await upsertTask(id, args.task as never, env.entityExpectedRev)
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'delete_task',
    { title: 'Delete a task', description: 'Remove a first-class task by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'delete_task',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.id,
            taskId: args.id,
            requestBody: { ...args, boardId },
          },
          async () => await deleteTask(boardId, args.id),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )

  // ---- agent-defined task sections (add ANY content block/"menu" inside a task) ----
  const SECTION_OBJ = z.object({
    id: z.string().optional(),
    type: z.string().describe('text | callout | fields | list | checklist | table | chips | anchors | variants | links | badges (or any custom type — falls back to raw JSON)'),
    title: z.string().optional(),
    collapsed: z.boolean().optional(),
    tone: z.string().optional(),
    body: z.string().optional(),
    fields: z.array(z.object({ k: z.string(), v: z.string() })).optional(),
    items: z.array(z.string()).optional(),
    checklist: z.array(z.object({ id: z.string().optional(), label: z.string(), done: z.boolean().optional() })).optional(),
    columns: z.array(z.string()).optional(),
    rows: z.array(z.array(z.string())).optional(),
    chips: z.array(z.string()).optional(),
    anchors: z.array(z.object({ repo: z.string().optional(), file: z.string().optional(), line: z.union([z.string(), z.number()]).optional(), symbol: z.string().optional(), fact: z.string().optional() })).optional(),
    variants: z.array(z.object({ id: z.string().optional(), when: z.string().optional(), expect: z.string().optional() })).optional(),
    links: z.array(z.object({ label: z.string().optional(), url: z.string() })).optional(),
  }).passthrough()
  secureWriteTool(
    'add_task_section',
    { title: 'Add a task section', description: 'Append one agent-defined content block ("menu") inside a task — any type/content. id auto-generated if omitted. Renders on the task detail immediately.', inputSchema: { ...BOARD_ARG, taskId: z.string(), section: SECTION_OBJ } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'add_task_section',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.taskId,
            taskId: args.taskId,
            requestBody: { ...args, boardId },
          },
          async () => ({
            ok: true as const,
            sections: await addTaskSection(boardId, args.taskId, args.section as never),
          }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'set_task_sections',
    { title: 'Set task sections', description: 'Replace ALL of a task\'s content blocks with this ordered list. Fully defines the task body.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sections: z.array(SECTION_OBJ) } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_task_sections',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.taskId,
            taskId: args.taskId,
            requestBody: { ...args, boardId },
          },
          async () => ({
            ok: true as const,
            sections: await setTaskSections(boardId, args.taskId, args.sections as never),
          }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'update_task_section',
    { title: 'Update a task section', description: 'Patch one section by id (title/content/collapsed/tone/…).', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string(), patch: SECTION_OBJ.partial() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'update_task_section',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.taskId,
            taskId: args.taskId,
            requestBody: { ...args, boardId },
          },
          async () => ({
            ok: true as const,
            sections: await updateTaskSection(boardId, args.taskId, args.sectionId, args.patch as never),
          }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'remove_task_section',
    { title: 'Remove a task section', description: 'Delete one section by id.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'remove_task_section',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.taskId,
            taskId: args.taskId,
            requestBody: { ...args, boardId },
          },
          async () => ({
            ok: true as const,
            sections: await removeTaskSection(boardId, args.taskId, args.sectionId),
          }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )

  secureWriteTool(
    'upsert_feature',
    { title: 'Upsert a feature', description: 'Create or update one feature/feature-contract (checklist card). Merges into an existing feature of the same id.', inputSchema: { ...BOARD_ARG, feature: FEATURE_OBJ } },
    async (args) => {
      const boardId = await bid(args.boardId)
      const featureId = String((args.feature as { id?: string })?.id ?? '')
      try {
        const result = await runMutationGate(
          {
            toolName: 'upsert_feature',
            boardId,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: featureId || boardId,
            requestBody: { ...args, boardId },
          },
          async () => await upsertFeature(boardId, args.feature as never),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'delete_feature',
    { title: 'Delete a feature', description: 'Remove a feature by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'delete_feature',
            boardId,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.id,
            requestBody: { ...args, boardId },
          },
          async () => await deleteFeature(boardId, args.id),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'set_prod',
    { title: 'Set production gates', description: 'Replace the board’s path-to-production gates (G0→G6) plus optional label/headline.', inputSchema: { ...BOARD_ARG, gates: z.array(GATE_OBJ), mockLabel: z.string().optional(), headline: z.string().optional() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_prod',
            boardId,
            actorId: actorIdOf(),
            entityType: 'board',
            entityId: boardId,
            requestBody: { ...args, boardId },
          },
          async () =>
            await setProd(boardId, {
              gates: args.gates as never,
              mockLabel: args.mockLabel,
              headline: args.headline,
            }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'set_guide',
    { title: 'Set board guide', description: 'Replace the board-specific guide sections.', inputSchema: { ...BOARD_ARG, sections: z.array(GUIDE_SEC) } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_guide',
            boardId,
            actorId: actorIdOf(),
            entityType: 'board',
            entityId: boardId,
            requestBody: { ...args, boardId },
          },
          async () => await setGuide(boardId, { sections: args.sections }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'replace_accounts',
    {
      title: 'Replace agent-account vault',
      description:
        'Replace the ops agent-account vault via durable account-sync ingestion (same fail-closed + same-revision parity rules as sync_accounts). Legacy OPS payload is mapped to masked accounts; tokens/secrets stripped. Compatibility response includes vault accounts plus sync readback fields.',
      inputSchema: { ...BOARD_ARG, ops: OPS_OBJ },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        // Domain owns CAS/idempotency/boardRev (same as sync_accounts) — no double-bump via runMutationGate.
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId,
          checkPinHash: true,
        })
        const opsRaw = (args.ops ?? {}) as Record<string, unknown>
        const mapped = mapLegacyOpsAccountsToSync(opsRaw as { accounts?: Array<Record<string, unknown>> })
        if (mapped.length === 0) {
          throw new McpMutationError('INVALID_INPUT', 'ops.accounts must be non-empty for replace_accounts')
        }
        const vault =
          opsRaw.vault && typeof opsRaw.vault === 'object'
            ? (opsRaw.vault as Record<string, unknown>)
            : {}
        const generatedAt =
          typeof vault.generatedAt === 'string' && vault.generatedAt.trim()
            ? vault.generatedAt
            : new Date().toISOString()
        const sourceRevision =
          typeof vault.sourceRevision === 'number' && Number.isInteger(vault.sourceRevision)
            ? vault.sourceRevision
            : typeof opsRaw.sourceRevision === 'number' && Number.isInteger(opsRaw.sourceRevision)
              ? opsRaw.sourceRevision
              : env.entityExpectedRev + 1
        const syncResult = await syncAccounts(accountSyncDeps(), {
          boardId,
          sourceRevision,
          generatedAt,
          expectedBoardRev: env.expectedBoardRev,
          accounts: mapped,
          trigger: 'ORCHESTRATOR_LAUNCH',
          idempotencyKey: env.idempotencyKey,
          callerRole: 'ROOT_ORCHESTRATOR',
          actorId: actorIdOf(),
        })
        // Compatibility vault doc for legacy ops readers (after durable authority succeeds).
        const compatOps = legacyOpsCompatibilityPayload(opsRaw)
        await replaceAccounts(boardId, compatOps)
        return jsonText(compatibilityReplaceAccountsResponse(compatOps, syncResult))
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'get_board_hash',
    { title: 'Get board hash', description: 'Content hash of the 7 board collections — read it first, then pass as expectedHash to replace_board_snapshot for safe concurrent writes. Same pin identity as other canonical reads. Compatibility alias of get_overview (hash slice).', inputSchema: { ...BOARD_ARG } },
    async (rawArgs) => {
      try {
        const id = await bid(rawArgs.boardId)
        validateReadFilters('get_board_hash', { boardId: id })
        const pin = await resolveBoardPin(id)
        const data = { hash: pin.canonicalHash, boardId: id }
        const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
          method: 'get_board_hash',
          nextCursor: null,
        })
        return jsonText({ ...env, ...data })
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'replace_board_snapshot',
    {
      title: 'Replace board snapshot (bulk)',
      description:
        'Bulk definition import via canonical planImport/applyImport (schema/hash/distinct/ref/cycle/idempotency/revision/provenance). dryRun:true runs planImport only — no mutate, no rev advance. Valid apply returns a compatibility SnapshotReceipt-shaped body plus import provenance. Pass expectedHash / mutation envelope subject hash for pin safety.',
      inputSchema: {
        ...BOARD_ARG,
        projects: z.array(z.object({ id: z.string(), nama: z.string(), status: z.string() }).passthrough()).optional(),
        features: z.array(FEATURE_OBJ).optional(),
        tasks: z.array(TASK_OBJ).optional(),
        productionGates: z.array(GATE_OBJ).optional(),
        prodMockLabel: z.string().optional(),
        prodHeadline: z.string().optional(),
        guide: z.array(GUIDE_SEC).optional(),
        accounts: OPS_OBJ.optional(),
        runs: z.array(z.object({ id: z.string() }).passthrough()).optional(),
        dryRun: z.boolean().optional().describe('Preview counts, do not write'),
        expectedHash: z.string().optional().describe('From get_board_hash — write refused on mismatch'),
        snapshotId: z.string().optional(),
        sourceRepoId: z.string().optional(),
        sourceCommitSha: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      const isDry = args.dryRun === true
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId,
          checkPinHash: true,
        })
        // Optional legacy expectedHash vs live board content hash (compatibility guard).
        if (typeof args.expectedHash === 'string' && args.expectedHash.trim()) {
          const live = await boardHash(boardId)
          if (args.expectedHash !== live) {
            throw new McpMutationError(
              'STALE_REVISION',
              `hash mismatch: board changed since read (expected ${args.expectedHash}, current ${live}). Re-read get_board_hash and retry.`,
              { expectedHash: args.expectedHash, currentHash: live, boardId },
            )
          }
        }
        const snapshot = buildCanonicalSnapshotFromReplaceBoardArgs(
          boardId,
          args as Record<string, unknown>,
          { idempotencyKey: env.idempotencyKey },
        )
        const ctx = resolveMcpRuntimeContext()
        const storage = ctx.controlData.imports
        const auth = importAuthFromPrincipal(principal)
        const appliedCollections = appliedCollectionsFromReplaceArgs(args as Record<string, unknown>)
        const afterCounts = afterCountsFromSnapshot(snapshot)
        const fromHash =
          (typeof args.expectedHash === 'string' && args.expectedHash) || env.subjectHash

        if (isDry) {
          // plan only — no mutate, no rev advance
          const plan = await planImport(storage, {
            auth,
            snapshot,
            entityExpectedRev: env.entityExpectedRev,
            expectedBoardRev: env.expectedBoardRev,
            expectedSubjectHash: env.subjectHash,
          })
          return jsonText(
            compatibilityReplaceBoardReceipt({
              boardId,
              dryRun: true,
              appliedCollections,
              fromHash,
              plan,
              afterCounts,
            }),
          )
        }

        // applyImport owns idempotency + CAS + provenance (revisionStore null → CAS on import board state)
        const applied = await applyImport(storage, ctx.idempotency, null, {
          auth,
          snapshot,
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          expectedSubjectHash: env.subjectHash,
          idempotencyKey: env.idempotencyKey,
          dryRun: false,
        })
        return jsonText(
          compatibilityReplaceBoardReceipt({
            boardId,
            dryRun: false,
            appliedCollections,
            fromHash,
            applied,
            afterCounts,
          }),
        )
      } catch (e) {
        return asErr(e)
      }
    },
  )

  // ---- lifecycle engine (per-board configurable rail + evidence-gated transitions) ----
  const STAGE_OBJ = z.object({
    key: z.string(), label: z.string(), color: z.string().optional(), group: z.string().optional(),
    gated: z.boolean().optional(), requiresEvidence: z.array(z.string()).optional(), verifierRole: z.string().optional(),
    readiness: z.number().optional().describe('0–100 ready-to-production % this stage represents (drives rollups)'),
    milestone: z.boolean().optional().describe('mark the "ready-production" gate rollups count toward'),
  })
  secureTool(
    'get_lifecycle',
    { title: 'Get lifecycle rail', description: "This board's lifecycle stages + gate rules. Each board defines its own rail; read this before advance_task. Compatibility alias of get_overview (lifecycle slice).", inputSchema: { ...BOARD_ARG } },
    async (rawArgs) => {
      try {
        const id = await bid(rawArgs.boardId)
        validateReadFilters('get_lifecycle', { boardId: id })
        const pin = await resolveBoardPin(id)
        const lc = await readLifecycle(id)
        const data = { lifecycle: lc, ...lc }
        const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
          method: 'get_lifecycle',
          nextCursor: null,
        })
        return jsonText({ ...env, ...data })
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'set_lifecycle',
    { title: 'Set lifecycle rail', description: "Fully (re)configure this board's lifecycle: ordered stages + gate rules. gated:true = reachable only via advance_task with a program-emitted receipt; verifierRole = must be passed by a run other than the implementer. allowSkip (default false) permits forward jumps; allowRegression (default true) permits moving back for repair. Each board owns its own rail.", inputSchema: { ...BOARD_ARG, stages: z.array(STAGE_OBJ).min(1), allowSkip: z.boolean().optional(), allowRegression: z.boolean().optional(), formulaVersion: z.string().optional() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_lifecycle',
            boardId,
            actorId: actorIdOf(),
            entityType: 'lifecycle',
            entityId: boardId,
            requestBody: { ...args, boardId },
          },
          async () =>
            await writeLifecycle(boardId, args.stages as never, {
              allowSkip: args.allowSkip,
              allowRegression: args.allowRegression,
              formulaVersion: args.formulaVersion,
            }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'get_task_lifecycle',
    { title: 'Get task lifecycle', description: 'Current stage, rev (for optimistic lock), implementer run, and stage history for one task. Pinned envelope.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try {
        const bid0 = await bid(boardId)
        const lc = await taskLifecycle(bid0, id)
        if (!lc) return jsonText({ error: `task not found: ${id}`, code: 'NOT_FOUND' })
        return jsonText(await pinnedEnvelopeFromBoard(bid0, { taskLifecycle: lc, ...lc }))
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'advance_task',
    {
      title: 'Advance task lifecycle',
      description:
        "Move a task to a stage on this board's rail. Gated stages REQUIRE a program-emitted receipt (evidence/commitSha/deployReceipt) — no manual ticking of FUNCTIONAL/PROD_READY/LIVE. A stage with a verifierRole is refused if byRunId equals the implementer (independent verification). Pass entityExpectedRev/expectedRev (from get_task_lifecycle) to prevent a concurrent lost update. Every transition is written to the audit log. byRunId must be a registered run; ordered stages / no skips enforced by the lifecycle engine.",
      inputSchema: {
        ...BOARD_ARG,
        id: z.string(),
        toStage: z.string(),
        byRunId: z.string().describe('run/agent id performing the transition (required)'),
        role: z.string().optional(),
        evidence: z.record(z.string(), z.any()).optional(),
        verdict: z.string().optional(),
        commitSha: z.string().optional(),
        deployReceipt: z.string().optional(),
        blocker: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        // Registered-run gate BEFORE mutation gate so missing run never consumes idempotency/rev.
        await assertRegisteredRunOrThrow(boardId, args.byRunId)
        // AGENT may only advance via own registered run ownership (legacy board.runs OR V3 agentId).
        // Never authorize principal against itself for V3-only byRunId.
        if (principal?.role === 'AGENT') {
          const persistedAgentId = await resolveAdvanceTaskPersistedAgentId(boardId, args.byRunId)
          if (persistedAgentId == null) {
            throw new McpMutationError(
              'RUN_NOT_REGISTERED',
              `byRunId ${args.byRunId} has no resolvable persisted owner on board ${boardId}`,
              { boardId, byRunId: args.byRunId },
            )
          }
          authorizePersistedRunOwner(principal, persistedAgentId)
        }
        const result = await runMutationGate(
          {
            toolName: 'advance_task',
            boardId,
            actorId: actorIdOf(),
            entityType: 'task',
            entityId: args.id,
            taskId: args.id,
            requestBody: { ...args, boardId },
          },
          async () => {
            const env = parseMutationEnvelope({ ...args, boardId })
            const {
              id: taskId,
              toStage,
              byRunId,
              role,
              evidence,
              verdict,
              commitSha,
              deployReceipt,
              blocker,
            } = args
            // Domain enforces ordered stages, evidence gates, no skips (allowSkip=false default).
            return await advanceTask(boardId, taskId, {
              toStage,
              byRunId,
              role,
              evidence,
              verdict,
              commitSha,
              deployReceipt,
              blocker,
              expectedRev: env.entityExpectedRev,
            } as never)
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'get_rollup',
    { title: 'Get lifecycle rollup', description: 'Active task count per lifecycle stage, HOLD count (outside the active denominator), and per-project / per-feature rollup (each follows its most-behind active task). Compatibility alias of get_overview (rollup slice).', inputSchema: { ...BOARD_ARG } },
    async (rawArgs) => {
      try {
        const id = await bid(rawArgs.boardId)
        validateReadFilters('get_rollup', { boardId: id })
        const authz = await resolveBoardDefinitionAuthority(id)
        const pin = authz.pin
        let rollup: Record<string, unknown>
        if (authz.mode === 'canonical') {
          const [lifecycleByTaskId, classificationByTaskId, cfg] = await Promise.all([
            loadLifecycleTaskOverlay(id),
            loadClassificationOverlay(id),
            loadLifecycleConfigSoft(id),
          ])
          const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
            lifecycleByTaskId,
            classificationByTaskId,
            now: pin.generatedAt,
          })
          rollup = legacyShapedRollupFromCanonical(
            v3,
            authz.definition.projection,
            lifecycleByTaskId,
            cfg,
          )
        } else {
          // No-pin / incomplete: legacy lifecycle-table rollup (stale honesty on pin).
          rollup = (await computeRollup(id)) as unknown as Record<string, unknown>
        }
        const data = { rollup, ...rollup }
        const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
          method: 'get_rollup',
          nextCursor: null,
        })
        return jsonText({ ...env, ...data })
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'list_audit',
    {
      title: 'List audit log',
      description:
        'Audit entries (gate changes + mutations), newest first. Cursor pagination (createdAt,id DESC; default 50; max 200). Compatibility filter: taskId.',
      inputSchema: {
        ...BOARD_ARG,
        taskId: z.string().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
        // legacy alias for pageSize (not passed to validateReadFilters)
        limit: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_audit', {
        boardId: id,
        cursor: rawArgs.cursor,
        pageSize: rawArgs.pageSize ?? rawArgs.limit,
      })
      const pin = await resolveBoardPin(id)
      // Fetch a bounded durable window; cursor paginates within it (max store window 500).
      const taskId = typeof rawArgs.taskId === 'string' ? rawArgs.taskId : undefined
      const rows = await readAudit(id, { taskId, limit: 500 })
      const mapped = rows.map((r, idx) => {
        const ts = String(r.ts ?? pin.generatedAt)
        const task = r.task_id != null ? String(r.task_id) : ''
        const action = r.action != null ? String(r.action) : 'audit'
        return {
          ...r,
          id: `${ts}#${action}#${task}#${idx}`,
          createdAt: ts,
          taskId: task || null,
        }
      })
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { audit: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_audit', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, audit: page.items })
    },
  )
  secureWriteTool(
    'init_lifecycle',
    { title: 'Bulk-init task stages', description: "Set the lifecycle stage for a board's tasks in one atomic UPDATE (default = onlyUninitialized). stage defaults to the rail's first stage.", inputSchema: { ...BOARD_ARG, stage: z.string().optional(), onlyUninitialized: z.boolean().optional() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'init_lifecycle',
            boardId,
            actorId: actorIdOf(),
            entityType: 'lifecycle',
            entityId: boardId,
            requestBody: { ...args, boardId },
          },
          async () => await initLifecycleStage(boardId, args.stage, args.onlyUninitialized ?? true),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )

  // ---- board / project / queue CRUD (full board management from MCP) ----
  secureWriteTool(
    'update_board',
    { title: 'Update a board', description: "Rename a board, change its description, or set which views/tabs it shows.", inputSchema: { boardId: z.string(), name: z.string().optional(), description: z.string().optional(), views: z.array(z.string()).optional() } },
    async (args) => {
      try {
        const result = await runMutationGate(
          {
            toolName: 'update_board',
            boardId: args.boardId,
            actorId: actorIdOf(),
            entityType: 'board',
            entityId: args.boardId,
            requestBody: args,
          },
          async () => {
            const { boardId, name, description, views } = args
            return { ok: true as const, boards: await updateBoard(boardId, { name, description, views }) }
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'delete_board',
    {
      title: 'Delete a board',
      description:
        'Delete a board and ALL its data (docs, tasks, audit). Irreversible. Requires matching canonicalHash/subjectHash against current pin (no skip).',
      inputSchema: { boardId: z.string() },
    },
    async (args) => {
      try {
        // Pin/canonical hash is validated inside runMutationGate (skipPinHashCheck intentionally off).
        const result = await runMutationGate(
          {
            toolName: 'delete_board',
            boardId: args.boardId,
            actorId: actorIdOf(),
            entityType: 'board',
            entityId: args.boardId,
            requestBody: args,
          },
          async () => ({ ok: true as const, boards: await deleteBoard(args.boardId) }),
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'upsert_project',
    { title: 'Upsert a project', description: 'Create or update one project (merges by id). Any extra fields pass through.', inputSchema: { ...BOARD_ARG, project: z.object({ id: z.string(), nama: z.string(), status: z.string().optional() }).passthrough() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      const projectId = String((args.project as { id?: string })?.id ?? '')
      try {
        const result = await runMutationGate(
          {
            toolName: 'upsert_project',
            boardId,
            actorId: actorIdOf(),
            entityType: 'project',
            entityId: projectId || boardId,
            requestBody: { ...args, boardId },
          },
          async () => {
            const raw = await upsertProject(boardId, args.project as never)
            const p = raw.projects.find((x) => x.id === (args.project as { id: string }).id)
            return { ok: true as const, project: p ?? null, projects: raw.projects.map((x) => x.id) }
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'delete_project',
    { title: 'Delete a project', description: 'Remove a project by id (its tasks stay; re-point or delete them separately).', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'delete_project',
            boardId,
            actorId: actorIdOf(),
            entityType: 'project',
            entityId: args.id,
            requestBody: { ...args, boardId },
          },
          async () => {
            const raw = await deleteProject(boardId, args.id)
            return { ok: true as const, projects: raw.projects.map((p) => p.id) }
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'set_queue',
    { title: 'Set the work queue', description: 'Set the board queue (now / next feature ids + note).', inputSchema: { ...BOARD_ARG, now: z.array(z.string()).optional(), next: z.array(z.string()).optional(), catatan: z.string().optional() } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_queue',
            boardId,
            actorId: actorIdOf(),
            entityType: 'queue',
            entityId: boardId,
            requestBody: { ...args, boardId },
          },
          async () => {
            const raw = await setQueue(boardId, {
              now: args.now,
              next: args.next,
              catatan: args.catatan,
            })
            return { ok: true as const, queue: raw.queue ?? null }
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'decide_decision',
    {
      title: 'Decide an open decision',
      description:
        'Answer/close an open decision (unblocks the feature it gated). Attribution is the authenticated principal (request decidedBy is ignored).',
      inputSchema: {
        ...BOARD_ARG,
        id: z.string(),
        answer: z.string(),
        keputusan: z.string().optional(),
        /** @deprecated ignored — attribution is authenticated principal only */
        decidedBy: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'decide_decision',
            boardId,
            actorId: actorIdOf(),
            entityType: 'decision',
            entityId: args.id,
            requestBody: { ...args, boardId },
          },
          async () => {
            const raw = await decideDecision(
              boardId,
              args.id,
              args.answer,
              args.keputusan,
              actorIdOf(), // never request decidedBy
            )
            return { ok: true as const, decision: raw.decisions?.find((d) => d.id === args.id) ?? null }
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )

  // ---- collaboration ----
  secureWriteTool(
    'add_comment',
    {
      title: 'Add a comment',
      description:
        'Leave a comment on a feature. Author attribution is the authenticated principal (request author is ignored).',
      inputSchema: {
        ...BOARD_ARG,
        featureId: z.string(),
        /** @deprecated ignored — attribution is authenticated principal only */
        author: z.string().optional(),
        text: z.string().min(1),
        authorType: z.enum(['human', 'agent']).optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'add_comment',
            boardId,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.featureId,
            requestBody: { ...args, boardId },
          },
          async () => {
            const authorType =
              args.authorType ??
              (principal?.role === 'OWNER' || principal?.channel === 'session' ? 'human' : 'agent')
            await addComment(
              boardId,
              args.featureId,
              actorIdOf(), // never request author
              authorType,
              args.text,
            )
            return { ok: true as const, featureId: args.featureId }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'open_decision',
    {
      title: 'Open a decision',
      description:
        'Raise a decision that needs a human (blocks the feature). Attribution is the authenticated principal (request openedBy is ignored).',
      inputSchema: {
        ...BOARD_ARG,
        featureId: z.string(),
        question: z.string().min(1),
        options: z
          .array(
            z.object({
              key: z.string(),
              label: z.string(),
              rekomendasi: z.boolean().optional(),
            }),
          )
          .optional(),
        /** @deprecated ignored — attribution is authenticated principal only */
        openedBy: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'open_decision',
            boardId,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.featureId,
            requestBody: { ...args, boardId },
          },
          async () => {
            const raw = await openDecision(
              boardId,
              args.featureId,
              args.question,
              args.options,
              actorIdOf(), // never request openedBy
            )
            const d = raw.decisions?.find((x) => x.featureId === args.featureId && x.status === 'open')
            return { ok: true as const, decision: d ?? null }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'set_blocked',
    { title: 'Set feature blocked', description: 'Mark a feature blocked with a reason.', inputSchema: { ...BOARD_ARG, featureId: z.string(), reason: z.string().min(1) } },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const result = await runMutationGate(
          {
            toolName: 'set_blocked',
            boardId,
            actorId: actorIdOf(),
            entityType: 'feature',
            entityId: args.featureId,
            requestBody: { ...args, boardId },
          },
          async () => {
            await setBlocked(boardId, args.featureId, args.reason)
            return { ok: true as const, featureId: args.featureId, reason: args.reason }
          },
        )
        return jsonText(result)
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
    'list_activity',
    {
      title: 'List activity',
      description:
        'Board activity feed, newest first. Cursor pagination (createdAt,id DESC; default 50; max 200).',
      inputSchema: {
        ...BOARD_ARG,
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
        // legacy alias for pageSize
        limit: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_activity', {
        boardId: id,
        cursor: rawArgs.cursor,
        pageSize: rawArgs.pageSize ?? rawArgs.limit,
      })
      const pin = await resolveBoardPin(id)
      const activity = (await modelOf(id)).activity
      const mapped = activity.map((a, idx) => {
        const ts = a.ts || pin.generatedAt
        return {
          ...a,
          id: `${ts}#${a.kind ?? 'event'}#${a.featureId ?? a.projectId ?? idx}`,
          createdAt: ts,
        }
      })
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { activity: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_activity', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, activity: page.items })
    },
  )

  // ---- adaptive views ----
  secureTool(
    'list_tasks',
    {
      title: 'List tasks',
      description:
        "List first-class tasks with lifecycle readiness. Cursor pagination (createdAt,id DESC; default 50; max 200). Filters: projectId, featureId, stage; compatibility: scope.",
      inputSchema: {
        ...BOARD_ARG,
        projectId: z.string().optional(),
        featureId: z.string().optional(),
        stage: z.string().optional(),
        scope: z.string().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id0 = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_tasks', {
        boardId: id0,
        cursor: rawArgs.cursor,
        pageSize: rawArgs.pageSize,
        projectId: rawArgs.projectId,
        featureId: rawArgs.featureId,
        stage: rawArgs.stage,
      })
      const authz = await resolveBoardDefinitionAuthority(id0)
      const pin = authz.pin
      const projectId = 'projectId' in filters ? filters.projectId : undefined
      const featureId = 'featureId' in filters ? filters.featureId : undefined
      const stage = 'stage' in filters ? filters.stage : undefined

      let mapped: Array<Record<string, unknown> & { createdAt: string; id: string }>
      if (authz.mode === 'canonical') {
        const [cfg, lifecycleByTaskId, runsByTask] = await Promise.all([
          loadLifecycleConfigSoft(id0),
          loadLifecycleTaskOverlay(id0),
          loadRunsByTaskOverlay(id0),
        ])
        let rows = mapCanonicalTasksToListRows(authz.definition.projection, {
          pinGeneratedAt: pin.generatedAt,
          cfg,
          lifecycleByTaskId,
          runsByTask,
        })
        if (projectId) rows = rows.filter((t) => t.projectId === projectId)
        if (featureId) {
          rows = rows.filter(
            (t) => t.featureId === featureId || t.featureContractId === featureId,
          )
        }
        if (stage) {
          rows = rows.filter((t) => t.lifecycleStage === stage)
        }
        if (typeof rawArgs.scope === 'string' && rawArgs.scope) {
          rows = rows.filter((t) => t.scope === rawArgs.scope)
        }
        mapped = rows
      } else {
        const [{ tasks: all }, cfg, m] = await Promise.all([
          readTasks(id0),
          readLifecycle(id0),
          modelOf(id0),
        ])
        let tasks = all
        if (projectId) tasks = tasks.filter((t) => t.projectId === projectId)
        if (featureId) {
          tasks = tasks.filter(
            (t) =>
              (t as { featureId?: string | null }).featureId === featureId ||
              (t as { featureContractId?: string | null }).featureContractId === featureId,
          )
        }
        if (stage) {
          tasks = tasks.filter(
            (t) => t.lifecycleStage === stage || (t as { stage?: string | null }).stage === stage,
          )
        }
        // Compatibility: legacy `scope` filter (not in canonical allowlist — applied after validate).
        if (typeof rawArgs.scope === 'string' && rawArgs.scope) {
          tasks = tasks.filter((t) => t.scope === rawArgs.scope)
        }
        mapped = tasks.map((t) => ({
          id: t.id,
          title: t.title,
          projectId: t.projectId ?? null,
          phase: t.phase ?? null,
          scope: t.scope ?? null,
          lifecycleStage: t.lifecycleStage ?? null,
          readinessPercent: stageReadiness(cfg, t.lifecycleStage),
          nextGate: nextStage(cfg, t.lifecycleStage)?.key ?? null,
          nextEvidence: nextEvidence(cfg, t.lifecycleStage),
          blockedReason: t.blockedReason ?? null,
          lastReceiptAt: t.lastReceiptAt ?? null,
          ...runInfo(m.runsByTask[t.id]),
          done: t.checkpoints.filter((c) => c.done).length,
          total: t.checkpoints.length,
          deps: t.dependencies.length,
          derivedDone: deriveCheckpoints(stageReadiness(cfg, t.lifecycleStage), t.checkpoints).done,
          createdAt: t.updated ?? t.lastReceiptAt ?? pin.generatedAt,
        }))
      }
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { tasks: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_tasks', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, tasks: page.items })
    },
  )
  secureTool(
    'get_task',
    {
      title: 'Get task',
      description:
        'Exact task by id/taskId incl checkpoints, deps, story, refs + lifecycle readiness (pinned envelope).',
      inputSchema: {
        ...BOARD_ARG,
        id: z.string().optional(),
        taskId: z.string().optional(),
      },
    },
    async (rawArgs) => {
      const bd = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_task', { ...rawArgs, boardId: bd })
      const taskId = (filters as { id: string }).id
      const authz = await resolveBoardDefinitionAuthority(bd)
      const pin = authz.pin

      if (authz.mode === 'canonical') {
        const ct = authz.definition.projection.tasks.find((t) => t.id === taskId)
        if (!ct) {
          return jsonText({ ok: false, error: `task not found: ${taskId}`, code: 'NOT_FOUND' })
        }
        const [cfg, lifecycleByTaskId, runsByTask] = await Promise.all([
          loadLifecycleConfigSoft(bd),
          loadLifecycleTaskOverlay(bd),
          loadRunsByTaskOverlay(bd),
        ])
        const overlay = lifecycleByTaskId.get(taskId)
        let stage = overlay?.lifecycleStage ?? null
        let rev = 0
        let blockedReason = overlay?.blockedReason ?? null
        let lastReceiptAt = overlay?.lastReceiptAt ?? null
        try {
          const lc = await taskLifecycle(bd, taskId)
          if (lc) {
            stage = lc.stage ?? stage
            rev = lc.rev ?? 0
            const hist =
              (
                lc.lifecycle as {
                  history?: Array<{ ts?: string; blocker?: string | null }>
                } | null
              )?.history ?? []
            const last = hist[hist.length - 1]
            if (last?.blocker != null) blockedReason = last.blocker
            if (last?.ts) lastReceiptAt = last.ts
          }
        } catch {
          /* overlay only */
        }
        const checkpoints = overlay?.checkpoints ?? []
        const readyPct = stageReadiness(cfg, stage)
        const fc =
          (typeof ct.featureContractId === 'string' && ct.featureContractId) ||
          authz.definition.projection.featureContractJoins.find((j) => j.taskId === taskId)
            ?.featureContractId ||
          overlay?.featureContractId ||
          null
        const deps = authz.definition.projection.dependencies
          .filter((d) => d.fromTaskId === taskId)
          .map((d) => d.toTaskId)
        const task = {
          id: ct.id,
          title: (typeof ct.title === 'string' && ct.title) || overlay?.title || ct.id,
          projectId: ct.projectId ?? overlay?.projectId ?? null,
          featureContractId: fc,
          objective: ct.objective ?? overlay?.objective ?? null,
          dependencies: deps.length ? deps : overlay?.dependencies ?? [],
          impacts: overlay?.impacts ?? [],
          checkpoints,
          lifecycleStage: stage,
          readinessPercent: readyPct,
          nextGate: nextStage(cfg, stage)?.key ?? null,
          nextEvidence: nextEvidence(cfg, stage),
          ...runInfo(runsByTask[taskId]),
          blockedReason,
          lastReceiptAt,
          rev,
          derivedCheckpoints: deriveCheckpoints(readyPct, checkpoints),
          createdAt: overlay?.updated ?? lastReceiptAt ?? pin.generatedAt,
        }
        const env = buildPinnedReadEnvelope(
          boardPinToMcpReadPin(pin),
          { task },
          { method: 'get_task', nextCursor: null },
        )
        return jsonText({ ...env, task })
      }

      const t = await readTask(bd, taskId)
      if (!t) return jsonText({ ok: false, error: `task not found: ${taskId}`, code: 'NOT_FOUND' })
      const [cfg, lc, m] = await Promise.all([readLifecycle(bd), taskLifecycle(bd, taskId), modelOf(bd)])
      const stage = lc?.stage ?? null
      const hist =
        ((lc?.lifecycle as { history?: Array<{ ts?: string; blocker?: string | null }> } | null)?.history) ??
        []
      const last = hist[hist.length - 1]
      const task = {
        ...t,
        lifecycleStage: stage,
        readinessPercent: stageReadiness(cfg, stage),
        nextGate: nextStage(cfg, stage)?.key ?? null,
        nextEvidence: nextEvidence(cfg, stage),
        ...runInfo(m.runsByTask[taskId]),
        blockedReason: last?.blocker ?? null,
        lastReceiptAt: last?.ts ?? null,
        rev: lc?.rev ?? 0,
        derivedCheckpoints: deriveCheckpoints(stageReadiness(cfg, stage), t.checkpoints ?? []),
        createdAt: t.updated ?? last?.ts ?? pin.generatedAt,
      }
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { task },
        { method: 'get_task', nextCursor: null },
      )
      return jsonText({ ...env, task })
    },
  )
  secureTool(
    'list_accounts',
    {
      title: 'List agent accounts',
      description: 'Durable account-sync snapshot (masked only; never tokens). Cursor/pageSize filters.',
      inputSchema: {
        ...BOARD_ARG,
        status: z.string().optional(),
        provider: z.string().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_accounts', { ...rawArgs, boardId: id })
      const pin = await resolveBoardPin(id)
      const snap = await sharedAccountStore().get(id)
      let accounts = (snap?.accounts ?? []).map((a) => {
        const copy = { ...(a as unknown as Record<string, unknown>) }
        for (const k of Object.keys(copy)) {
          if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
            delete copy[k]
          }
        }
        const accountId = String(copy.maskedAccountId ?? copy.accountId ?? copy.id ?? 'unknown')
        return {
          ...copy,
          id: accountId,
          accountId,
          status: copy.status,
          provider: copy.providerKind ?? copy.provider ?? null,
          createdAt: String(snap?.generatedAt ?? pin.generatedAt),
        }
      })
      const status = 'status' in filters ? filters.status : undefined
      const provider = 'provider' in filters ? filters.provider : undefined
      if (status) accounts = accounts.filter((a) => String(a.status ?? '') === status)
      if (provider) {
        accounts = accounts.filter((a) => String(a.provider ?? '') === provider)
      }
      accounts.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)) || String(b.id).localeCompare(String(a.id)))
      const page = paginateReadRows(
        accounts as Array<{ createdAt: string; id: string }>,
        {
          cursor: filters.cursor,
          pageSize: filters.pageSize,
          expectedBoardRev: pin.boardRev,
        },
      )
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        {
          accounts: page.items,
          items: page.items,
          pageSize: page.pageSize,
          sourceRevision: snap?.sourceRevision ?? null,
          stale: snap?.stale ?? true,
          capacity: snap?.capacity ?? null,
        },
        { method: 'list_accounts', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, accounts: page.items })
    },
  )
  secureTool(
    'get_account',
    {
      title: 'Get account',
      description: 'Single masked account from durable account-sync snapshot.',
      inputSchema: { ...BOARD_ARG, id: z.string().optional(), accountId: z.string().optional() },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_account', { ...rawArgs, boardId: id })
      const accountId = (filters as { id: string }).id
      const pin = await resolveBoardPin(id)
      const snap = await sharedAccountStore().get(id)
      const found = (snap?.accounts ?? []).find((a) => {
        const rec = a as unknown as Record<string, unknown>
        const keys = [rec.maskedAccountId, rec.accountId, rec.id, rec.maskedAccountRef]
        return keys.some((k) => k != null && String(k) === accountId)
      })
      if (!found) return jsonText({ ok: false, error: `account not found: ${accountId}`, code: 'NOT_FOUND' })
      const copy = { ...(found as unknown as Record<string, unknown>) }
      for (const k of Object.keys(copy)) {
        if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) delete copy[k]
      }
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { account: copy },
        { method: 'get_account', nextCursor: null },
      )
      return jsonText({ ...env, account: copy })
    },
  )
  secureTool(
    'get_prod',
    { title: 'Get production path', description: 'The path-to-production gates (G0→G6).', inputSchema: { ...BOARD_ARG } },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      validateReadFilters('get_prod', { boardId: id })
      const pin = await resolveBoardPin(id)
      const prod = await readProd(id)
      const data = { prod, ...prod }
      const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
        method: 'get_prod',
        nextCursor: null,
      })
      return jsonText({ ...env, ...data })
    },
  )
  secureTool(
    'get_guide',
    { title: 'Get board guide', description: 'The board-specific guide + rules sections.', inputSchema: { ...BOARD_ARG } },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      validateReadFilters('get_guide', { boardId: id })
      const pin = await resolveBoardPin(id)
      const guide = await readGuide(id)
      const data = { guide, ...guide }
      const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
        method: 'get_guide',
        nextCursor: null,
      })
      return jsonText({ ...env, ...data })
    },
  )

  // ---- resource: the playbook ----

  /**
   * PUBLIC_SNAPSHOT_RATE_LIMIT_V1 client key.
   * Unauth tool + resource share the same IP key as HTTP /api/public-snapshot
   * (`public-snapshot:${ip}` after service prefix) so cross-surface cannot double-spend.
   * Authenticated public tool keeps actor isolation.
   * Never reads raw XFF — only auth.clientIp from resolvePublicSnapshotClientIp.
   */
  function publicSnapshotRateClientKey(): string {
    if (principal?.actorId) return `mcp:${principal.actorId}`
    return auth.clientIp ?? 'unknown'
  }

  // ---- Public snapshot (unauth allowlist) — same pinned aggregation as /api/public-snapshot ----
  secureTool(
    'get_public_snapshot',
    {
      title: 'Get public snapshot',
      description: 'Sanitized public board snapshot only (shared materialization store + 60/min burst20).',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const svc = getSharedPublicSnapshotService()
      const result = await svc.getPublicSnapshot({
        boardId: id,
        clientKey: publicSnapshotRateClientKey(),
      })
      if (!result.ok) {
        return jsonText({
          ok: false,
          error: result.error,
          code: result.code,
          ...(result.stale ? { stale: true } : {}),
          ...(result.retryAfterSeconds != null ? { retryAfterSeconds: result.retryAfterSeconds } : {}),
          ...(result.policyId ? { policyId: result.policyId } : {}),
        })
      }
      return jsonText({
        ok: true,
        snapshot: result.snapshot,
        etag: result.etag,
        pin: result.pin,
        replayed: result.replayed,
      })
    },
  )

  // ---- Canonical authenticated reads (pinned envelope; no competing readiness truth) ----
  secureTool(
    'get_overview',
    {
      title: 'Get board overview',
      description:
        'Pinned envelope: rollup + control-plane NEXT (active plan) + legacy feature queue (explicitly named).',
      inputSchema: { ...BOARD_ARG },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      validateReadFilters('get_overview', { boardId: id })
      const authz = await resolveBoardDefinitionAuthority(id)
      const pin = authz.pin
      const planNext = await selectNextFromActivePlan(
        { clock: systemClock(), plans: sharedPlanStore() },
        id,
      )
      const dispatchNext = projectDispatchNextFields(planNext)

      let projectsCount: number
      let featuresCount: number
      let runsCount: number
      let legacyFeatureQueue: ReturnType<typeof asLegacyFeatureQueue>
      let rollup: Awaited<ReturnType<typeof computeRollup>> | Record<string, unknown>
      let lifecycleStages: number

      if (authz.mode === 'canonical') {
        projectsCount = authz.definition.projection.projects.length
        featuresCount = authz.definition.projection.flows.length
        try {
          runsCount = (await sharedRunStore().list(id)).length
        } catch {
          runsCount = 0
        }
        // No legacy board queue under pin-complete definition authority.
        legacyFeatureQueue = asLegacyFeatureQueue({ now: [], next: [] })
        const cfg = await loadLifecycleConfigSoft(id)
        lifecycleStages = cfg.stages?.length ?? 0
        // DISTINCT definition task IDs only + left-join lifecycle/classification.
        // Never inflates from lifecycle-table legacy orphans.
        const [lifecycleByTaskId, classificationByTaskId] = await Promise.all([
          loadLifecycleTaskOverlay(id),
          loadClassificationOverlay(id),
        ])
        try {
          const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
            lifecycleByTaskId,
            classificationByTaskId,
            now: pin.generatedAt,
          })
          rollup = legacyShapedRollupFromCanonical(
            v3,
            authz.definition.projection,
            lifecycleByTaskId,
            cfg,
          )
        } catch (e) {
          rollup = {
            formulaVersion: 'v3-canonical',
            counts: {},
            readinessPercent: 0,
            active: 0,
            hold: 0,
            buckets: {},
            unclassifiedCount: 0,
            note: 'canonical_rollup_unavailable',
            error: e instanceof Error ? e.message : 'canonical rollup failed',
          }
        }
      } else {
        const [m, rollupRes, lc] = await Promise.all([
          modelOf(id),
          computeRollup(id),
          readLifecycle(id),
        ])
        projectsCount = m.projects.length
        featuresCount = m.features.length
        runsCount = m.runs.length
        legacyFeatureQueue = asLegacyFeatureQueue({
          now: m.queue.now.map((f) => f.id),
          next: m.queue.next.map((f) => f.id),
        })
        rollup = rollupRes
        lifecycleStages = lc.stages?.length ?? 0
      }

      const data = {
        projects: projectsCount,
        features: featuresCount,
        runs: runsCount,
        // Control-plane NEXT only (active unexpired root-published plan)
        selectedForNextDispatch: dispatchNext.selectedForNextDispatch,
        next: dispatchNext.next,
        planId: dispatchNext.planId,
        blockedReason: dispatchNext.blockedReason,
        soleSource: dispatchNext.soleSource,
        // Legacy feature queue — not dispatch NEXT (C3 may remove visual label)
        legacyFeatureQueue,
        rollup,
        lifecycleStages,
      }
      const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
        method: 'get_overview',
        nextCursor: null,
      })
      return jsonText({ ...env, ...data })
    },
  )

  const WORK_READ_INPUT = {
    ...BOARD_ARG,
    bucket: z.string().optional(),
    overlay: z.string().optional(),
    staleFamily: z.boolean().optional(),
    projectId: z.string().optional(),
    featureId: z.string().optional(),
    cursor: z.string().optional(),
    pageSize: z.number().int().optional(),
  }

  /** Shared list_work_items / get_work handler — one pin/filter/cursor path (prevents drift). */
  async function handleListWorkItemsRead(
    rawArgs: Record<string, unknown>,
    requestedAs: 'list_work_items' | 'get_work',
  ) {
    const id = await bid(rawArgs.boardId as string | undefined)
    const filters = validateReadFilters(requestedAs, { ...rawArgs, boardId: id })
    const authz = await resolveBoardDefinitionAuthority(id)
    const pin = authz.pin
    const planNext = await selectNextFromActivePlan(
      { clock: systemClock(), plans: sharedPlanStore() },
      id,
    )
    const dispatchNext = projectDispatchNextFields(planNext)

    let rows: Array<{
      id: string
      title: string
      projectId: string | null
      featureId: string | null
      lifecycleStage: string | null
      bucket: string | null
      overlay: string | null
      staleFamily: boolean
      createdAt: string
    }>
    let legacyFeatureQueue: ReturnType<typeof asLegacyFeatureQueue>

    if (authz.mode === 'canonical') {
      const [lifecycleByTaskId, classificationByTaskId] = await Promise.all([
        loadLifecycleTaskOverlay(id),
        loadClassificationOverlay(id),
      ])
      // Bucket coverage from V3 rollup over DISTINCT definition IDs only.
      const bucketByTaskId = new Map<string, string | null>()
      try {
        const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
          lifecycleByTaskId,
          classificationByTaskId,
          now: pin.generatedAt,
        })
        for (const a of v3.assignments) {
          bucketByTaskId.set(a.taskId, a.primary ?? null)
        }
      } catch {
        // Soft: still return definition membership rows without bucket labels.
      }
      rows = mapCanonicalTasksToWorkRows(authz.definition.projection, {
        pinGeneratedAt: pin.generatedAt,
        lifecycleByTaskId,
        bucketByTaskId,
      })
      legacyFeatureQueue = asLegacyFeatureQueue({ now: [], next: [] })
    } else {
      const [{ tasks }, m] = await Promise.all([readTasks(id), modelOf(id)])
      rows = tasks.map((t) => ({
        id: t.id,
        title: t.title,
        projectId: t.projectId ?? null,
        featureId:
          (t as { featureId?: string | null }).featureId ??
          (t as { featureContractId?: string | null }).featureContractId ??
          null,
        lifecycleStage: t.lifecycleStage ?? null,
        bucket: (t as { bucket?: string | null }).bucket ?? null,
        overlay: (t as { overlay?: string | null }).overlay ?? null,
        staleFamily: !!(t as { staleFamily?: boolean }).staleFamily,
        createdAt: t.updated ?? t.lastReceiptAt ?? pin.generatedAt,
      }))
      legacyFeatureQueue = asLegacyFeatureQueue({
        now: m.queue.now.map((f) => ({ id: f.id, nama: f.nama })),
        next: m.queue.next.map((f) => ({ id: f.id, nama: f.nama })),
      })
    }

    const bucket = 'bucket' in filters ? filters.bucket : undefined
    const overlay = 'overlay' in filters ? filters.overlay : undefined
    const staleFamily = 'staleFamily' in filters ? filters.staleFamily : undefined
    const projectId = 'projectId' in filters ? filters.projectId : undefined
    const featureId = 'featureId' in filters ? filters.featureId : undefined
    if (bucket) rows = rows.filter((r) => String(r.bucket ?? '') === bucket)
    if (overlay) rows = rows.filter((r) => String(r.overlay ?? '') === overlay)
    if (staleFamily === true) rows = rows.filter((r) => r.staleFamily)
    if (staleFamily === false) rows = rows.filter((r) => !r.staleFamily)
    if (projectId) rows = rows.filter((r) => r.projectId === projectId)
    if (featureId) rows = rows.filter((r) => r.featureId === featureId)
    rows.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    const page = paginateReadRows(rows, {
      cursor: filters.cursor,
      pageSize: filters.pageSize,
      expectedBoardRev: pin.boardRev,
    })
    const data =
      requestedAs === 'get_work'
        ? {
            work: page.items,
            items: page.items,
            tasks: page.items,
            pageSize: page.pageSize,
            selectedForNextDispatch: dispatchNext.selectedForNextDispatch,
            next: dispatchNext.next,
            planId: dispatchNext.planId,
            blockedReason: dispatchNext.blockedReason,
            soleSource: dispatchNext.soleSource,
            legacyFeatureQueue,
          }
        : {
            work: page.items,
            items: page.items,
            pageSize: page.pageSize,
            selectedForNextDispatch: dispatchNext.selectedForNextDispatch,
            next: dispatchNext.next,
            planId: dispatchNext.planId,
            blockedReason: dispatchNext.blockedReason,
            soleSource: dispatchNext.soleSource,
            legacyFeatureQueue,
          }
    const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
      method: requestedAs,
      nextCursor: page.nextCursor,
    })
    if (requestedAs === 'get_work') {
      return jsonText({ ...env, work: page.items, tasks: page.items })
    }
    return jsonText({ ...env, work: page.items, items: page.items })
  }

  secureTool(
    'list_work_items',
    {
      title: 'List work items',
      description:
        'Canonical work list with cursor pagination (createdAt,id DESC; default 50; max 200). Filters: bucket, overlay, staleFamily, projectId, featureId.',
      inputSchema: WORK_READ_INPUT,
    },
    async (rawArgs) => handleListWorkItemsRead(rawArgs as Record<string, unknown>, 'list_work_items'),
  )
  secureTool(
    'get_work',
    {
      title: 'Get work view',
      description:
        'Compatibility alias of list_work_items — same auth/pin/filter schema (no independent recompute).',
      inputSchema: WORK_READ_INPUT,
    },
    async (rawArgs) => handleListWorkItemsRead(rawArgs as Record<string, unknown>, 'get_work'),
  )

  /** Shared get_priority_portfolio / get_priority — one pin/filter path. */
  async function handlePriorityPortfolioRead(
    rawArgs: Record<string, unknown>,
    requestedAs: 'get_priority_portfolio' | 'get_priority',
  ) {
    const id = await bid(rawArgs.boardId as string | undefined)
    validateReadFilters(requestedAs, {
      boardId: id,
      cursor: rawArgs.cursor,
      pageSize: rawArgs.pageSize,
    })
    const authz = await resolveBoardDefinitionAuthority(id)
    const pin = authz.pin
    let rollup: Record<string, unknown>
    if (authz.mode === 'canonical') {
      const [lifecycleByTaskId, classificationByTaskId, cfg] = await Promise.all([
        loadLifecycleTaskOverlay(id),
        loadClassificationOverlay(id),
        loadLifecycleConfigSoft(id),
      ])
      const v3 = computeCanonicalDefinitionRollup(pin, authz.definition.projection, {
        lifecycleByTaskId,
        classificationByTaskId,
        now: pin.generatedAt,
      })
      rollup = legacyShapedRollupFromCanonical(
        v3,
        authz.definition.projection,
        lifecycleByTaskId,
        cfg,
      )
    } else {
      rollup = (await computeRollup(id)) as unknown as Record<string, unknown>
    }
    const data = {
      rollup,
      priority: (rollup as { priority?: unknown }).priority ?? null,
    }
    const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
      method: requestedAs,
      nextCursor: null,
    })
    return jsonText({ ...env, ...data })
  }

  secureTool(
    'get_priority_portfolio',
    {
      title: 'Get priority portfolio',
      description: 'Canonical priority portfolio surface (SALES_WEB_RELATED_BACKEND truth when present).',
      inputSchema: { ...BOARD_ARG },
    },
    async (rawArgs) =>
      handlePriorityPortfolioRead(rawArgs as Record<string, unknown>, 'get_priority_portfolio'),
  )
  secureTool(
    'get_priority',
    {
      title: 'Get priority rollup',
      description: 'Compatibility alias of get_priority_portfolio — same auth/pin (no independent recompute).',
      inputSchema: { ...BOARD_ARG },
    },
    async (rawArgs) => handlePriorityPortfolioRead(rawArgs as Record<string, unknown>, 'get_priority'),
  )
  secureTool(
    'get_g5',
    {
      title: 'Get G5 domains',
      description: 'G5 read surface from durable G5 domain store (g5Pass is read-only derived via evaluateG5).',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const pin = await resolveBoardPin(id)
      // Durable G5 domains from controlData.g5 — empty list → all required missing → g5Pass false.
      // Never invent domain PASS rows or client-writable g5Pass.
      let domains: Awaited<ReturnType<ReturnType<typeof sharedG5Store>['list']>> = []
      try {
        domains = await sharedG5Store().list(id)
      } catch {
        domains = []
      }
      const evaluation = evaluateG5(domains, pinToTuple(pin))
      const data = {
        g5Pass: evaluation.g5Pass,
        domainPassCount: evaluation.domainResults.filter((r) => r.pass).length,
        domainRequiredCount: G5_REQUIRED_DOMAINS.length,
        domainResults: evaluation.domainResults,
        missingDomains: evaluation.missingDomains,
        domains,
      }
      const env = buildPinnedReadEnvelope(boardPinToMcpReadPin(pin), data, {
        method: 'get_g5',
        nextCursor: null,
      })
      return jsonText({ ...env, ...data })
    },
  )
  secureTool(
    'list_decisions',
    {
      title: 'List decisions',
      description: 'Durable Decision V3 list (authz: decision:read). Cursor/pageSize + openOnly/blocking filters.',
      inputSchema: {
        ...BOARD_ARG,
        openOnly: z.boolean().optional(),
        blocking: z.boolean().optional(),
        cursor: z.string().optional(),
        pageSize: z.number().int().optional(),
      },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('list_decisions', { ...rawArgs, boardId: id })
      const pin = await resolveBoardPin(id)
      let rows = await sharedDecisionStore().list(id)
      const openOnly = 'openOnly' in filters ? filters.openOnly : undefined
      const blocking = 'blocking' in filters ? filters.blocking : undefined
      if (openOnly === true) {
        rows = rows.filter((d) => d.status === 'OPEN' || d.status === 'ACKNOWLEDGED')
      }
      if (blocking === true) rows = rows.filter((d) => d.blocking)
      if (blocking === false) rows = rows.filter((d) => !d.blocking)
      const mapped = rows.map((d) => ({
        id: d.decisionId,
        decisionId: d.decisionId,
        createdAt: d.createdAt,
        status: d.status,
        blocking: d.blocking,
        title: d.title,
        question: d.question,
        severity: d.severity,
        taskId: d.taskId,
        runId: d.runId,
        boardRev: d.boardRev,
      }))
      mapped.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
      const page = paginateReadRows(mapped, {
        cursor: filters.cursor,
        pageSize: filters.pageSize,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { decisions: page.items, items: page.items, pageSize: page.pageSize },
        { method: 'list_decisions', nextCursor: page.nextCursor },
      )
      return jsonText({ ...env, decisions: page.items })
    },
  )
  secureTool(
    'get_decision',
    {
      title: 'Get decision',
      description: 'Single durable Decision V3 record.',
      inputSchema: { ...BOARD_ARG, id: z.string().optional(), decisionId: z.string().optional() },
    },
    async (rawArgs) => {
      const id = await bid(rawArgs.boardId)
      const filters = validateReadFilters('get_decision', { ...rawArgs, boardId: id })
      const decisionId = (filters as { id: string }).id
      const pin = await resolveBoardPin(id)
      const rec = await sharedDecisionStore().get(id, decisionId)
      if (!rec) return jsonText({ ok: false, error: `decision not found: ${decisionId}`, code: 'NOT_FOUND' })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        { decision: rec },
        { method: 'get_decision', nextCursor: null },
      )
      return jsonText({ ...env, decision: rec })
    },
  )

  async function nextFromActivePlan(id: string, aliasOf?: string) {
    const plans = sharedPlanStore()
    const clock = systemClock()
    const next = await selectNextFromActivePlan({ clock, plans }, id)
    const projected = projectDispatchNextFields(next)
    return pinnedEnvelopeFromBoard(id, {
      selectedForNextDispatch: projected.selectedForNextDispatch,
      next: projected.next,
      planId: projected.planId,
      blockedReason: projected.blockedReason,
      soleSource: projected.soleSource,
      ...(aliasOf ? { aliasOf } : {}),
    })
  }

  secureTool(
    'get_next',
    {
      title: 'Get NEXT from active dispatch plan',
      description: 'Sole NEXT source = active dispatch plan selection. No heuristic.',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => jsonText(await nextFromActivePlan(await bid(boardId))),
  )
  secureTool(
    'get_dispatch_next',
    {
      title: 'Get NEXT (alias)',
      description: 'Alias of get_next — same authorization and envelope.',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => jsonText(await nextFromActivePlan(await bid(boardId), 'get_next')),
  )

  // ---- V3 control-plane writes (secureWriteTool = full envelope + auth gate + registry) ----
  // Domain owns CAS/idempotency; assertMutationEnvelopeOrThrow enforces AC-API-03 fields first.
  secureWriteTool(
    'publish_dispatch_plan',
    {
      title: 'Publish dispatch plan',
      description:
        'ROOT_ORCHESTRATOR only. Sole NEXT source after publish. Full mutation envelope required (entityExpectedRev, expectedBoardRev, canonicalHash|subjectHash, idempotencyKey).',
      inputSchema: {
        ...BOARD_ARG,
        planId: z.string(),
        planVersion: z.number().int(),
        planHash: z.string(),
        canonicalSnapshotId: z.string().min(1),
        canonicalHash: z.string().min(1),
        expectedBoardRev: z.number().int(),
        issuedAt: z.string(),
        expiresAt: z.string(),
        stage: z.string().optional(),
        items: z.array(z.record(z.string(), z.any())),
        idempotencyKey: z.string().min(1),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: false, // plan binds its own subject via canonicalHash arg
        })
        const plans = sharedPlanStore()
        const clock = systemClock()
        const atomic = sharedAtomic(id, env.expectedBoardRev)
        const idempotency = sharedIdempotency()
        const result = await publishDispatchPlan(
          { clock, plans, atomic, idempotency },
          {
            boardId: id,
            planId: args.planId,
            planVersion: args.planVersion,
            planHash: args.planHash,
            canonicalSnapshotId: args.canonicalSnapshotId,
            canonicalHash: args.canonicalHash ?? env.subjectHash,
            expectedBoardRev: env.expectedBoardRev,
            issuedAt: args.issuedAt,
            expiresAt: args.expiresAt,
            stage: args.stage ?? 'ACTIVE',
            items: args.items as never,
            idempotencyKey: env.idempotencyKey,
            callerRole: 'ROOT_ORCHESTRATOR',
          },
        )
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'register_run',
    {
      title: 'Register run',
      description:
        'AGENT register_run with provider assignment authorization before lock/claim. Full mutation envelope required. AGENT agentId is authenticated principal only.',
      inputSchema: {
        ...BOARD_ARG,
        runId: z.string(),
        taskId: z.string(),
        targetGate: z.string(),
        agentId: z.string(),
        model: z.string(),
        effort: z.string().optional(),
        expectedEntityRev: z.number().int(),
        expectedBoardRev: z.number().int(),
        idempotencyKey: z.string().min(1),
        planId: z.string().optional(),
        planItemRank: z.number().int().optional(),
        maskedAccountRef: z.string().optional(),
        canonicalHash: z.string().optional(),
        subjectHash: z.string().optional(),
        collisionScopeLockIds: z.array(z.string()).optional(),
        initialState: z.enum(['QUEUED', 'RESERVED', 'STARTING', 'RUNNING']).optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        // AGENT: never trust request agentId — attribution from principal.
        const agentId =
          principal?.role === 'AGENT'
            ? (principal.agentId ?? '')
            : String(args.agentId ?? actorIdOf())
        if (principal?.role === 'AGENT') {
          authorizePersistedRunOwner(principal, agentId)
        }
        const deps = defaultRunDeps(id, env.expectedBoardRev)
        const result = await registerRun(deps, {
          boardId: id,
          runId: args.runId,
          taskId: args.taskId,
          targetGate: args.targetGate,
          agentId,
          model: args.model,
          effort: args.effort,
          expectedEntityRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          idempotencyKey: env.idempotencyKey,
          planId: args.planId,
          planItemRank: args.planItemRank,
          maskedAccountRef: args.maskedAccountRef,
          canonicalHash: args.canonicalHash ?? args.subjectHash ?? env.subjectHash,
          collisionScopeLockIds: args.collisionScopeLockIds,
          initialState: args.initialState,
        })
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'heartbeat_run',
    {
      title: 'Heartbeat run',
      description:
        'Owning AGENT heartbeat with fencing. Full mutation envelope required. Agent id from principal / persisted run owner.',
      inputSchema: {
        ...BOARD_ARG,
        runId: z.string(),
        agentId: z.string(),
        fencingToken: z.string(),
        heartbeatSequence: z.number().int(),
        expectedEntityRev: z.number().int(),
        expectedBoardRev: z.number().int(),
        materialProgressAt: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const deps = defaultRunDeps(id, env.expectedBoardRev)
        // Authorize against persisted V3 run owner, not request agentId spoof.
        const existing = await deps.runs.get(id, args.runId)
        if (!existing) {
          throwNotFound(`run not found: ${args.runId}`, { runId: args.runId, boardId: id })
        }
        authorizePersistedRunOwner(principal, existing.agentId ?? null)
        const agentId =
          principal?.role === 'AGENT'
            ? (principal.agentId ?? existing.agentId)
            : String(args.agentId ?? existing.agentId)
        const result = await heartbeatRun(deps, {
          boardId: id,
          runId: args.runId,
          agentId,
          fencingToken: args.fencingToken,
          heartbeatSequence: args.heartbeatSequence,
          expectedEntityRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          materialProgressAt: args.materialProgressAt,
        })
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'sync_accounts',
    {
      title: 'Sync accounts',
      description:
        'ROOT account:sync — masked accounts only; never tokens. Full mutation envelope required. Actor from principal.',
      inputSchema: {
        ...BOARD_ARG,
        sourceRevision: z.number().int(),
        expectedBoardRev: z.number().int(),
        generatedAt: z.string().optional(),
        accounts: z.array(z.record(z.string(), z.any())),
        idempotencyKey: z.string().min(1),
        trigger: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const sanitized = (args.accounts as Array<Record<string, unknown>>).map((a) => {
          const copy = { ...a }
          for (const k of Object.keys(copy)) {
            if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
              delete copy[k]
            }
          }
          return copy
        })
        const result = await syncAccounts(accountSyncDeps(), {
          boardId: id,
          sourceRevision: args.sourceRevision,
          generatedAt: args.generatedAt ?? new Date().toISOString(),
          expectedBoardRev: env.expectedBoardRev,
          accounts: sanitized as never,
          trigger: (args.trigger as never) ?? 'ORCHESTRATOR_LAUNCH',
          idempotencyKey: env.idempotencyKey,
          callerRole: 'ROOT_ORCHESTRATOR',
          actorId: actorIdOf(),
        })
        return jsonText({
          ok: true,
          boardId: id,
          sourceRevision: result.sourceRevision,
          acceptedCount: result.acceptedCount,
          usableCapacity: result.usableCapacity,
          dispatchMode: result.capacity.dispatchMode,
          stale: result.stale,
          boardRev: result.boardRev,
          replayed: result.replayed,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'reconcile_dry_run',
    {
      title: 'Reconcile dry-run',
      description:
        'ROOT reconcile:write dry-run. Full mutation envelope required. Leader id from principal (request leaderId ignored for attribution).',
      inputSchema: {
        ...BOARD_ARG,
        leaderId: z.string().optional(),
        fencingToken: z.string().optional(),
        expectedBoardRev: z.number().int(),
        maxActions: z.number().int().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const runDeps = defaultRunDeps(id, env.expectedBoardRev)
        const recDeps = reconcilerDeps(runDeps)
        // Attribution from principal — never request leaderId spoof for identity.
        const leaderId = actorIdOf()
        let fencingToken = args.fencingToken
        if (!fencingToken) {
          const claim = await claimReconcilerLeadership(recDeps, {
            boardId: id,
            leaderId,
            leaseMs: 60_000,
          })
          fencingToken = claim.fencingToken
        }
        const result = await dryRunReconcile(recDeps, {
          boardId: id,
          leaderId,
          fencingToken,
          expectedBoardRev: env.expectedBoardRev,
          maxActions: args.maxActions,
        })
        return jsonText({
          ok: true,
          boardId: id,
          dryRun: true,
          dryRunId: result.dryRunId,
          dryRunHash: result.dryRunHash,
          boardRev: result.boardRev,
          counts: result.counts,
          items: result.items,
          nextCursor: result.nextCursor,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'reconcile_apply',
    {
      title: 'Reconcile apply',
      description:
        'ROOT reconcile:write apply with dryRunHash. Full mutation envelope required. Leader from principal.',
      inputSchema: {
        ...BOARD_ARG,
        dryRunHash: z.string().min(1),
        leaderId: z.string().optional(),
        fencingToken: z.string().optional(),
        expectedBoardRev: z.number().int(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const runDeps = defaultRunDeps(id, env.expectedBoardRev)
        const recDeps = reconcilerDeps(runDeps)
        const leaderId = actorIdOf()
        let fencingToken = args.fencingToken
        if (!fencingToken) {
          const claim = await claimReconcilerLeadership(recDeps, {
            boardId: id,
            leaderId,
            leaseMs: 60_000,
          })
          fencingToken = claim.fencingToken
        }
        const result = await applyReconcile(recDeps, {
          boardId: id,
          leaderId,
          fencingToken,
          dryRunHash: args.dryRunHash,
          expectedBoardRev: env.expectedBoardRev,
        })
        return jsonText({ ok: true, boardId: id, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'open_decision_v3',
    {
      title: 'Open decision V3',
      description:
        'Request a Decision (AGENT/OWNER). Full mutation envelope required. Actor from principal.',
      inputSchema: {
        ...BOARD_ARG,
        question: z.string(),
        title: z.string().optional(),
        type: z.string().optional(),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
        taskId: z.string().optional(),
        runId: z.string().optional(),
        blocking: z.boolean().optional(),
        expectedBoardRev: z.number().int(),
        options: z
          .array(
            z.object({
              optionId: z.string(),
              label: z.string(),
              declining: z.boolean().optional(),
            }),
          )
          .optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const options =
          args.options?.map((o: { optionId: string; label: string; declining?: boolean }) => ({
            optionId: o.optionId,
            label: o.label,
            declining: !!o.declining,
            requestsProductionAuthority: false,
            requestsHoldAuthority: false,
            requestsProviderAuthority: false,
          })) ?? [
            {
              optionId: 'ack',
              label: 'Acknowledge',
              declining: false,
              requestsProductionAuthority: false,
              requestsHoldAuthority: false,
              requestsProviderAuthority: false,
            },
          ]
        const rec = await openDecisionV3(decisionDeps(), {
          boardId: id,
          type: args.type ?? 'AGENT_REQUEST',
          severity: args.severity ?? 'MEDIUM',
          title: args.title ?? args.question.slice(0, 120),
          question: args.question,
          options,
          blocking: args.blocking ?? false,
          taskId: args.taskId ?? null,
          runId: args.runId ?? null,
          expectedBoardRev: env.expectedBoardRev,
          actorId: actorIdOf(),
        })
        return jsonText({
          ok: true,
          boardId: id,
          decisionId: rec.decisionId,
          status: rec.status,
          entityRev: rec.entityRev,
          boardRev: rec.boardRev,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'resolve_decision_v3',
    {
      title: 'Resolve decision V3',
      description:
        'OWNER resolve only. Full mutation envelope required (entityExpectedRev/expectedRev + expectedBoardRev + hash + idempotencyKey). Actor from principal. Not-found does not consume revision.',
      inputSchema: {
        ...BOARD_ARG,
        decisionId: z.string(),
        selectedOptionId: z.string().optional(),
        resolution: z.string().optional(),
        entityExpectedRev: z.number().int().optional(),
        expectedRev: z.number().int().optional(),
        expectedBoardRev: z.number().int(),
        comment: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        // Envelope first (fail closed on missing fields).
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const store = sharedDecisionStore()
        const existing = await store.get(id, args.decisionId)
        // Not-found BEFORE domain mutation — no revision/idempotency consumption at domain layer.
        if (!existing) {
          throwNotFound(`decision not found: ${args.decisionId}`, {
            decisionId: args.decisionId,
            boardId: id,
          })
        }
        const selectedOptionId =
          args.selectedOptionId ??
          existing.options.find((o) => !o.declining)?.optionId ??
          existing.options[0]?.optionId
        if (!selectedOptionId) {
          throw new McpMutationError('INVALID_INPUT', 'no option to select', {
            decisionId: args.decisionId,
          })
        }
        const rec = await resolveDecisionV3(decisionDeps(), {
          boardId: id,
          decisionId: args.decisionId,
          actorId: actorIdOf(),
          selectedOptionId,
          comment: args.comment ?? args.resolution ?? null,
          expectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
        })
        return jsonText({
          ok: true,
          boardId: id,
          decisionId: rec.decisionId,
          status: rec.status,
          selectedOptionId: rec.selectedOptionId,
          entityRev: rec.entityRev,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'integration_lock',
    {
      title: 'Integration lock',
      description:
        'INTEGRATOR path/checkpoint bounded lock (Grok-only integrator model). Full mutation envelope required. Principal checkpoint/pathspec bounds enforced.',
      inputSchema: {
        ...BOARD_ARG,
        pathspec: z.string().optional(),
        pathspecs: z.array(z.string()).optional(),
        checkpointId: z.string().optional(),
        rootAcceptanceId: z.string().optional(),
        repoId: z.string().optional(),
        trackingBranch: z.string().optional(),
        runId: z.string().optional(),
        integratorModel: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        await assertMutationEnvelopeOrThrow(args as Record<string, unknown>)
        const pathspecs: Array<string> =
          args.pathspecs ?? (args.pathspec ? [args.pathspec] : [])
        if (!pathspecs.length || !args.checkpointId || !args.rootAcceptanceId) {
          throw new McpMutationError(
            'INVALID_INPUT',
            'integration_lock requires rootAcceptanceId, checkpointId, and pathspec(s) — fail closed',
          )
        }
        // Principal checkpoint/pathspec bounds (INTEGRATOR fail-closed).
        enforceIntegratorLockBounds(principal, {
          checkpointId: args.checkpointId,
          pathspecs,
        })
        const { acquireIntegrationLock } = await import('#/server/locks')
        const result = await acquireIntegrationLock(sharedLocks(), systemClock(), {
          boardId: id,
          repoId: args.repoId ?? id,
          trackingBranch: args.trackingBranch ?? 'main',
          runId: args.runId ?? `int-${Date.now()}`,
          agentId: actorIdOf(),
          integratorModel: args.integratorModel ?? 'grok-4.5',
          rootAcceptanceId: args.rootAcceptanceId,
          checkpointId: args.checkpointId,
          pathspecs,
        })
        return jsonText({
          ok: true,
          boardId: id,
          pathspecs,
          locked: true,
          fencingToken: result.fencingToken,
          lockId: result.lockId,
          state: result.state,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )


  // playbook resource — requires board:read principal (not listed unauth)
  if (principal && isToolListable(principal, 'get_conventions')) {
    server.registerResource(
      'playbook',
      'cairn://playbook',
      { title: 'Cairn playbook', description: 'How to use Cairn + workspace conventions (branch/worktree/usage).', mimeType: 'text/markdown' },
      async (uri) => {
        const c = await readConventions()
        const md = [
          `# ${c.brand ?? 'Cairn'} — agent playbook`, '',
          '## Branch naming', ...Object.entries(c.branch ?? {}).map(([k, v]) => `- ${k}: \`${v}\``), '',
          '## Worktree', `- \`${c.worktree?.path ?? ''}\` — ${c.worktree?.note ?? ''}`, '',
          '## How to use Cairn', ...(c.usage ?? []).map((s, i) => `${i + 1}. ${s}`), '',
          `## Deploy\n${c.deploy ?? ''}`, `\n## Status grades\n${(c.status_grades ?? []).join(' · ')}`,
        ].join('\n')
        return { contents: [{ uri: uri.href, mimeType: 'text/markdown', text: md }] }
      },
    )
  }
  // Public snapshot resource (unauth) — SAME shared service + same unauth IP key as get_public_snapshot tool
  server.registerResource(
    'public-snapshot',
    'cairn://public-snapshot',
    { title: 'Public snapshot', description: 'Sanitized public snapshot resource (shared materialization + rate limit).', mimeType: 'application/json' },
    async (uri) => {
      try {
        const id = await defaultBoardId()
        const svc = getSharedPublicSnapshotService()
        const result = await svc.getPublicSnapshot({
          boardId: id,
          clientKey: publicSnapshotRateClientKey(),
        })
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify(
                result.ok
                  ? {
                      ok: true,
                      snapshot: result.snapshot,
                      etag: result.etag,
                      pin: result.pin,
                      replayed: result.replayed,
                    }
                  : {
                      ok: false,
                      code: result.code,
                      error: result.error,
                      stale: result.stale ?? true,
                      ...(result.retryAfterSeconds != null
                        ? { retryAfterSeconds: result.retryAfterSeconds }
                        : {}),
                    },
              ),
            },
          ],
        }
      } catch (e) {
        const te = typedError(e)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({
                ok: false,
                code: te.code === 'MCP_HANDLER_ERROR' ? 'STALE_OR_MISSING' : te.code,
                error: te.code === 'MCP_HANDLER_ERROR' ? 'public snapshot unavailable' : te.error,
                stale: true,
              }),
            },
          ],
        }
      }
    },
  )
}
