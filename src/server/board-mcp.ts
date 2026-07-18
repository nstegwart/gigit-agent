// Real MCP board tools (async, MySQL-backed via board-store). Every board tool is
// boardId-scoped (default = the first board). Registered on the McpServer in mcp.ts.
// V3 C2A: tools/list filtered by principal; tools/call rechecks scope; public-only when unauth.
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'

import { buildModel } from '#/lib/model'
import { deriveCheckpoints, nextEvidence, nextStage, stageReadiness } from '#/lib/readiness'
import type { Feature, OpsData, WorkTask  } from '#/lib/types'
import {
  advanceTaskV3,
  computeRollup,
  initLifecycleStage,
  LifecycleV3Error,
  readAudit,
  readLifecycle,
  submitStageEvidence,
  V3_LIFECYCLE_RAIL,
  writeLifecycle
  
  
  
  
  
  
  
  
  
} from '#/server/lifecycle-store'
import type {AdvanceV3Input, AdvanceV3Result, LifecycleBoardPin, LifecycleV3Storage, RegisteredRun, RegisteredStageEvidence, StageReceipt, SubmitStageEvidenceInput, TaskLifecycleV3State} from '#/server/lifecycle-store';
import { computeTaskHash, setTaskLifecycle, taskLifecycle, taskStageRows, writeAudit } from '#/server/tasks-store'
import { db, readDoc, writeDoc } from '#/server/db'
import type { LifecycleStageKey, PinnedRevisionTuple , RollupV3Result, TaskClassificationRecord  } from '#/lib/control-plane-types'
import { decideDecision, deleteBoard, deleteProject, setQueue, updateBoard, upsertProject,
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
  createSystemClock
  
  
 } from '#/server/board-store'
import {
  assertAgentOwnRun,
  assertIntegratorBounds,
  authErrorEnvelope,
  authorizeToolCall,
  isToolListable,
  listHumanSafeToolNames,
  RbacError
  
  
} from '#/server/rbac'
import type {AuthMechanismState, Principal} from '#/server/rbac';
import {
  buildCp0SyncStatusReadback,
  resolveCp0ReadBoardId,
  type Cp0SyncStatusRow,
} from '#/server/cp0-mcp-metadata'
export {
  buildCp0SyncStatusReadback,
  resolveCp0ReadBoardId,
} from '#/server/cp0-mcp-metadata'
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
  hasTestControlPlaneRuntimeContext
  
} from '#/server/control-plane-runtime-context'
import type {ControlPlaneRuntimeContext} from '#/server/control-plane-runtime-context';
import {
  buildPinnedReadEnvelope,
  paginateReadRows,
  validateReadFilters,
  
  McpReadContractError
} from '#/server/mcp-canonical-reads'
import type {McpReadPin} from '#/server/mcp-canonical-reads';
import {
  selectNextFromActivePlan,
  publishDispatchPlan,
  getSharedDispatchPlanStore,
  setSharedDispatchPlanStore,
  projectDispatchNextFields,
  asLegacyFeatureQueue
  
} from '#/server/control-plane-ingest'
import type {DispatchPlanStore} from '#/server/control-plane-ingest';
import {
  registerRun,
  heartbeatRun,
  terminateRun,
  AGENT_TERMINATE_TO_STATES,
  ROOT_TERMINATE_TO_STATES,
  CP0_CONTROL_PLANE_VERSION,
  type RunRegistryDeps,
  type RunRegistryRetentionAsyncBinding,
  type RunRegistryRetentionBinding,
  type RunRegistryStore,
  type TerminateToState,
} from '#/server/run-registry'
import {
  DECISION_HEARTBEAT_RETENTION_POLICY,
  resolveRetentionEnvironmentDetails,
  resolveRetentionPolicy
  
  
  
} from '#/server/audit-retention'
import type {BoardPolicyRetention, RetentionPolicyResolveResult, RetentionStore} from '#/server/audit-retention';
import type {ControlPlaneAtomicStore, ControlPlaneClock} from '#/server/board-store';
import {
  beginIdempotent,
  completeIdempotent,
  IdempotencyError
  
} from '#/server/idempotency'
import type {IdempotencyStorage} from '#/server/idempotency';
import {
  DEFAULT_HUMAN_LOCALE,
  HUMAN_DISPLAY_SCHEMA_VERSION
  
  
  
} from '#/server/human-display'
import type {HumanDisplayEntityKind, HumanDisplayReviewStatus, HumanDisplayV1} from '#/server/human-display';
import {
  assertHumanDisplayWriteTransition,
  HumanDisplayPersistenceError,
  resolveHumanDisplayPreviousAuthor
  
} from '#/server/human-display-persistence'
import type {HumanDisplayStore} from '#/server/human-display-persistence';
import type { LockStore } from '#/server/locks'
import {
  evaluateCas,
  STALE_REVISION
  
} from '#/server/revisions'
import type {RevisionState} from '#/server/revisions';
import {
  evaluateCapacityPolicy,
  getSharedAccountSyncStore,
  setSharedAccountSyncStore
  
  
  
  
  
  
} from '#/server/account-sync'
import type {AccountSyncStore, AccountSyncTrigger, AccountProviderKind, MaskedAccountStatus, SyncAccountsRequest, SyncAccountsResult} from '#/server/account-sync';
import { inferAccountSyncTriggerFromStatuses } from '#/server/account-sync-scheduler'
import { readMcpListAccountsService } from '#/server/account-surface-readers'
import {
  openDecisionV3,
  resolveDecisionV3
  
  
} from '#/server/decisions-v3'
import type {DecisionV3Store, DecisionV3Deps} from '#/server/decisions-v3';
import {
  dryRunReconcile,
  applyReconcile,
  claimReconcilerLeadership
  
  
} from '#/server/reconciler'
import type {ReconcilerStore, ReconcilerDeps} from '#/server/reconciler';
import { evaluateG5, G5_REQUIRED_DOMAINS } from '#/server/g5'
import {
  applyImport,
  planImport
  
  
  
} from '#/server/canonical-import'
import type {ImportApplyResult, ImportAuthContext, ImportPlanResult} from '#/server/canonical-import';
import {
  produceCanonicalSnapshot
  
  
} from '#/server/canonical-snapshot'
import type {CanonicalSnapshot, CanonicalSnapshotInput} from '#/server/canonical-snapshot';
import {
  createCanonicalDefinitionReadAdapter,
  isPinComplete,
  isSyntheticCanonicalSnapshotId,
  loadPinnedDefinitionReadModel,
  tryLoadPinnedDefinitionReadModel
  
  
} from '#/server/canonical-read-model'
import type {CanonicalDefinitionProjection, CanonicalDefinitionReadModel} from '#/server/canonical-read-model';
import { computeRollupV3  } from '#/server/rollup-v3'
import type {RollupTaskInput} from '#/server/rollup-v3';
import {
  sanitizeClassificationRecordForPersistence,
  stripSelfAssertedMembershipFields,
} from '#/server/classification'
import {
  buildClassificationSyncPlan,
  ClassificationSyncError,
  projectClassificationSyncAuditActivity,
} from '#/server/classification-sync'
import { createHash } from 'node:crypto'
import { registerDomainKnowledgeTools } from '#/server/domain-knowledge-mcp'
import { registerKnowledgeTools } from '#/server/knowledge-tools'
import { registerExportDocumentationTool } from '#/server/mcp-register-export-documentation'
import { registerRebuildParityTools } from '#/server/rebuild-parity-mcp'

// Stable aliases are exported from the live registration module so tests and
// clients cannot drift to a second spelling of the knowledge tool ids.
export {
  DOMAIN_KNOWLEDGE_MCP_TOOL_NAMES as DOMAIN_KNOWLEDGE_TOOLS_WIRED,
  search_knowledge,
  get_domain_overview,
  list_domain_features,
  get_feature_documentation,
  get_feature_flow,
  get_related_entities,
  get_change_history,
} from '#/server/domain-knowledge-mcp'

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

export const CP0_CONTROL_PLANE_CAPABILITIES = Object.freeze({
  version: CP0_CONTROL_PLANE_VERSION,
  hierarchy: ['L0', 'L1', 'L2'],
  acknowledgements: ['REGISTRATION', 'SPAWN_BUDGET', 'LEASE_RENEWAL', 'TERMINAL', 'RELEASE'],
  renewableLeaseSeconds: 60,
  maxL1: 20,
  maxActiveL2PerL1: 20,
  accountProbeMaxAgeSeconds: 300,
  mutationEnvelope: ['expectedBoardRev', 'entityExpectedRev', 'canonicalHash', 'idempotencyKey'],
})




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
/** True when mcpRunDeps was installed via setMcpRunRegistryDeps (not default cache). */
let mcpRunDepsInjected = false
/** Explicit test injectors — take precedence over durable context when set. */
let mcpRunStore: RunRegistryStore | null = null
let mcpDecisionStore: DecisionV3Store | null = null
let mcpReconcilerStore: ReconcilerStore | null = null
let mcpAtomic: ControlPlaneAtomicStore | null = null
let mcpLocks: LockStore | null = null
let mcpIdempotency: IdempotencyStorage | null = null
/**
 * Long-lived MCP sync retention binding (memory/test only; mutable compaction watermark).
 * Built only when resolveRetentionPolicy succeeds from an approved/versioned
 * BoardPolicy (or explicit LOCAL/TEST staging-proposal) AND a memory/test
 * domain RetentionStore can be bound. PRODUCTION without supplied policy stays
 * null (fail-closed — never invent production retention).
 * MySQL mode never binds this (M3/R1) — uses mcpRetentionAsyncBinding instead.
 */
let mcpRetentionBinding: RunRegistryRetentionBinding | null = null
/**
 * Long-lived MCP durable async retention binding (MySQL multi-instance).
 * Bound from ctx.runtime.retentionAsync after resolveRetentionPolicy ok.
 * Cluster-durable sample/material/compaction; no process-local Maps.
 */
let mcpRetentionAsyncBinding: RunRegistryRetentionAsyncBinding | null = null
/** Last resolveRetentionPolicy result for Decision-path / diagnostics. */
let mcpRetentionResolve: RetentionPolicyResolveResult | null = null
/** Explicit approved BoardPolicy (versioned) — required for PRODUCTION bind. */
let mcpSuppliedRetentionPolicy: BoardPolicyRetention | null = null
/** STAGING may use STAGING_PROPOSED only when explicitly allowed. */
let mcpAllowStagingProposal = false
/** Test override for advance_task V3 storage (null → durable board_docs path). */
let productLifecycleV3StorageFactory: ((boardId: string) => LifecycleV3Storage) | null = null
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
  mcpRunDepsInjected = deps != null
}

/**
 * Configure approved/versioned BoardPolicy for MCP default retention bind.
 * PRODUCTION requires a non-null supplied policy approved for PRODUCTION.
 * Clears defaultRunDeps cache so the next default path rebuilds binding.
 */
export function setMcpRetentionPolicyConfig(
  opts: {
    supplied?: BoardPolicyRetention | null
    allowStagingProposal?: boolean
  } | null,
): void {
  if (opts === null) {
    mcpSuppliedRetentionPolicy = null
    mcpAllowStagingProposal = false
  } else {
    if ('supplied' in opts) mcpSuppliedRetentionPolicy = opts.supplied ?? null
    if ('allowStagingProposal' in opts) {
      mcpAllowStagingProposal = !!opts.allowStagingProposal
    }
  }
  // Rebuild binding on next defaultRunDeps (preserve injection via setMcpRunRegistryDeps).
  if (mcpRunDeps && !isInjectedRunDeps(mcpRunDeps)) {
    mcpRunDeps = null
  }
  mcpRetentionBinding = null
  mcpRetentionAsyncBinding = null
  mcpRetentionResolve = null
}

/** Last resolveRetentionPolicy outcome from defaultRunDeps (null until first resolve). */
export function getMcpRetentionPolicyResolve(): RetentionPolicyResolveResult | null {
  return mcpRetentionResolve
}

/** Process-wide long-lived sync retention binding (memory/test; null when fail-closed). */
export function getMcpRetentionBinding(): RunRegistryRetentionBinding | null {
  return mcpRetentionBinding
}

/** Process-wide long-lived durable async retention binding (MySQL; null when fail-closed). */
export function getMcpRetentionAsyncBinding(): RunRegistryRetentionAsyncBinding | null {
  return mcpRetentionAsyncBinding
}

/**
 * Load durable retentionPolicy row for boardId and bind if resolveRetentionPolicy ok.
 * Does not invent: absent store row + PRODUCTION → fail-closed Decision path.
 */
export async function bindMcpRetentionPolicyFromStore(
  boardId: string,
): Promise<RetentionPolicyResolveResult> {
  const ctx = resolveMcpRuntimeContext()
  const stored = await ctx.runtime.retentionPolicy.get(boardId)
  setMcpRetentionPolicyConfig({
    supplied: stored,
    allowStagingProposal: mcpAllowStagingProposal,
  })
  // Force resolve + cache via default path (unless full deps were injected).
  defaultRunDeps(boardId, 0)
  return (
    mcpRetentionResolve ?? {
      ok: false,
      policy: null,
      decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
      source: 'BLOCKED',
      message: 'retention policy resolve not yet run',
    }
  )
}

/**
 * Fail-closed Decision path when heartbeat retention policy is absent/unapproved.
 * Opens exact DECISION_HEARTBEAT_RETENTION_POLICY — never invents production retention.
 * Returns opened=null when policy already resolved ok.
 */
export async function openMcpHeartbeatRetentionPolicyDecision(opts: {
  boardId: string
  actorId: string
  expectedBoardRev: number
  entityExpectedRev: number
  canonicalHash: string
  idempotencyKey: string
}): Promise<{
  opened: Awaited<ReturnType<typeof openDecisionV3>> | null
  resolve: RetentionPolicyResolveResult
}> {
  // Ensure resolve is current on default path.
  defaultRunDeps(opts.boardId, opts.expectedBoardRev)
  const details = resolveRetentionEnvironmentDetails()
  const ctx = peekControlPlaneRuntimeContext()
  const resolve =
    mcpRetentionResolve ??
    resolveRetentionPolicy({
      environment: details.environment,
      supplied: mcpSuppliedRetentionPolicy,
      allowStagingProposal: mcpAllowStagingProposal,
      explicitAppEnv: details.explicitAppEnv,
      allowTestRetentionProposal: ctx
        ? mcpAllowTestRetentionProposal(ctx, details)
        : false,
    })
  mcpRetentionResolve = resolve
  if (resolve.ok && resolve.policy) {
    return { opened: null, resolve }
  }
  const opened = await openDecisionV3(decisionDeps(), {
    boardId: opts.boardId,
    type: DECISION_HEARTBEAT_RETENTION_POLICY,
    severity: 'HIGH',
    title: 'Approve heartbeat retention BoardPolicy',
    question: resolve.message,
    evidence: [
      resolve.decisionCode ?? DECISION_HEARTBEAT_RETENTION_POLICY,
      `source=${resolve.source}`,
      `environment=${details.environment}`,
      `envSource=${details.source}`,
      `explicitAppEnv=${details.explicitAppEnv}`,
      `weakTestSignal=${details.weakTestSignal}`,
      `productionLike=${details.productionLike}`,
    ],
    options: [
      {
        optionId: 'supply-approved-policy',
        label:
          'Supply approved versioned BoardPolicy via retentionPolicy.put + setMcpRetentionPolicyConfig',
        declining: false,
        requestsProductionAuthority: false,
        requestsHoldAuthority: false,
        requestsProviderAuthority: false,
      },
      {
        optionId: 'validate-on-staging',
        label: 'Validate staging-proposed policy on STAGING first (allowStagingProposal)',
        declining: false,
        requestsProductionAuthority: false,
        requestsHoldAuthority: false,
        requestsProviderAuthority: false,
      },
      {
        optionId: 'defer-fail-closed',
        label: 'Defer — keep retention unbound (fail closed)',
        declining: true,
        requestsProductionAuthority: false,
        requestsHoldAuthority: false,
        requestsProviderAuthority: false,
      },
    ],
    blocking: false,
    actorId: opts.actorId,
    expectedBoardRev: opts.expectedBoardRev,
    entityExpectedRev: opts.entityExpectedRev,
    canonicalHash: opts.canonicalHash,
    idempotencyKey: opts.idempotencyKey,
  })
  return { opened, resolve }
}

/** True when deps object was installed via setMcpRunRegistryDeps (not default cache rebuild). */
function isInjectedRunDeps(_deps: RunRegistryDeps): boolean {
  return mcpRunDepsInjected
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
  mcpRunDepsInjected = false
  mcpRunStore = null
  mcpRetentionBinding = null
  mcpRetentionAsyncBinding = null
  mcpRetentionResolve = null
  mcpSuppliedRetentionPolicy = null
  mcpAllowStagingProposal = false
  setSharedDispatchPlanStore(null)
  setSharedAccountSyncStore(null)
  mcpPlanStoreExplicit = false
  mcpAccountStoreExplicit = false
  mcpDecisionStore = null
  mcpReconcilerStore = null
  mcpAtomic = null
  mcpLocks = null
  mcpIdempotency = null
  productLifecycleV3StorageFactory = null
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
 * Domain RetentionStore for heartbeat apply/compaction (memory/test only).
 * - memory/test: bind in-process sync runtime.retention (same process authority).
 * - mysql / non-memory: never invent process-local memory (multi-instance diverge).
 *   Durable path is runtime.retentionAsync via RunRegistryDeps.retentionAsync.
 */
function sharedDomainRetentionStore(
  ctx: ControlPlaneRuntimeContext,
): RetentionStore | null {
  if (ctx.mode === 'memory' || ctx.mode === 'test') {
    return ctx.runtime.retention
  }
  // MySQL (and any other non-memory mode): refuse process-local memory.
  return null
}

function hasDurableRetentionAsyncStore(ctx: ControlPlaneRuntimeContext): boolean {
  const asyncStore = ctx.runtime.retentionAsync
  return (
    asyncStore != null &&
    typeof asyncStore.putHot === 'function' &&
    typeof asyncStore.appendAudit === 'function' &&
    typeof asyncStore.listAudit === 'function' &&
    typeof asyncStore.deleteHot === 'function'
  )
}

/**
 * Explicit R1/M3 blocker when policy resolved but durable retention unavailable.
 * Surfaces on Decision/diagnostics path — never silently skip with process-local invent.
 */
export const RETENTION_DURABLE_STORE_UNBOUND =
  'RETENTION_DURABLE_STORE_UNBOUND' as const

/**
 * R4: approved disposable test context may authorize TEST staging-proposal when
 * identity came from weak NODE_ENV=test/VITEST signals. Never true for production-like
 * runtimes or mysql serve mode without explicit CAIRN_ENV.
 */
function mcpAllowTestRetentionProposal(
  ctx: ControlPlaneRuntimeContext,
  details: ReturnType<typeof resolveRetentionEnvironmentDetails>,
): boolean {
  if (details.productionLike) return false
  if (details.explicitAppEnv) return false // explicit path uses explicitAppEnv gate instead
  if (ctx.mode !== 'memory' && ctx.mode !== 'test') return false
  return hasTestControlPlaneRuntimeContext()
}

/**
 * Resolve long-lived retention bindings via resolveRetentionPolicy only.
 * Never invents PRODUCTION policy — absent/unapproved → both null + Decision path.
 * - memory/test: sync `retention` from runtime.retention (process authority OK).
 * - mysql: durable `retentionAsync` from runtime.retentionAsync (cluster-durable);
 *   sync retention always null (no process-memory fallback).
 * - mysql without retentionAsync → fail-closed RETENTION_DURABLE_STORE_UNBOUND.
 * R4: passes explicitAppEnv + allowTestRetentionProposal — never silent TEST proposal.
 */
function resolveMcpRetentionBindings(ctx: ControlPlaneRuntimeContext): {
  retention: RunRegistryRetentionBinding | null
  retentionAsync: RunRegistryRetentionAsyncBinding | null
} {
  const details = resolveRetentionEnvironmentDetails()
  const resolved = resolveRetentionPolicy({
    environment: details.environment,
    supplied: mcpSuppliedRetentionPolicy,
    allowStagingProposal: mcpAllowStagingProposal,
    explicitAppEnv: details.explicitAppEnv,
    allowTestRetentionProposal: mcpAllowTestRetentionProposal(ctx, details),
  })
  if (!resolved.ok || !resolved.policy) {
    mcpRetentionResolve = resolved
    mcpRetentionBinding = null
    mcpRetentionAsyncBinding = null
    return { retention: null, retentionAsync: null }
  }

  // MySQL / non-memory: durable async only (R1/M3 — close process-memory dual-model).
  if (ctx.mode !== 'memory' && ctx.mode !== 'test') {
    mcpRetentionBinding = null
    if (!hasDurableRetentionAsyncStore(ctx)) {
      mcpRetentionResolve = {
        ok: false,
        policy: null,
        decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
        source: 'BLOCKED',
        message:
          `${RETENTION_DURABLE_STORE_UNBOUND}: mode=${ctx.mode} durable ` +
          `retentionAsync unavailable — fail closed (no process-local invent; ` +
          `heartbeat domain sample/material/compaction refused)`,
      }
      mcpRetentionAsyncBinding = null
      return { retention: null, retentionAsync: null }
    }
    mcpRetentionResolve = resolved
    // Reuse long-lived binding when policy identity unchanged.
    // Prefer durable compaction watermark in store (omit process lastCompactionAtMs authority).
    if (
      mcpRetentionAsyncBinding &&
      mcpRetentionAsyncBinding.policy.policyId === resolved.policy.policyId &&
      mcpRetentionAsyncBinding.policy.policyVersion === resolved.policy.policyVersion &&
      mcpRetentionAsyncBinding.store === ctx.runtime.retentionAsync
    ) {
      mcpRetentionAsyncBinding.policy = resolved.policy
      return { retention: null, retentionAsync: mcpRetentionAsyncBinding }
    }
    mcpRetentionAsyncBinding = {
      store: ctx.runtime.retentionAsync,
      policy: resolved.policy,
      // No process-local lastCompactionAtMs — durable watermark in store wins (multi-instance).
    }
    return { retention: null, retentionAsync: mcpRetentionAsyncBinding }
  }

  // memory/test: sync domain RetentionStore only.
  mcpRetentionAsyncBinding = null
  const store = sharedDomainRetentionStore(ctx)
  if (!store) {
    mcpRetentionResolve = {
      ok: false,
      policy: null,
      decisionCode: DECISION_HEARTBEAT_RETENTION_POLICY,
      source: 'BLOCKED',
      message:
        `${RETENTION_DURABLE_STORE_UNBOUND}: mode=${ctx.mode} memory/test ` +
        `runtime.retention unavailable — fail closed`,
    }
    mcpRetentionBinding = null
    return { retention: null, retentionAsync: null }
  }
  mcpRetentionResolve = resolved
  // Reuse long-lived mutable binding when policy identity unchanged (compaction watermark).
  if (
    mcpRetentionBinding &&
    mcpRetentionBinding.policy.policyId === resolved.policy.policyId &&
    mcpRetentionBinding.policy.policyVersion === resolved.policy.policyVersion
  ) {
    mcpRetentionBinding.policy = resolved.policy
    return { retention: mcpRetentionBinding, retentionAsync: null }
  }
  mcpRetentionBinding = {
    store,
    policy: resolved.policy,
    lastCompactionAtMs: 0,
  }
  return { retention: mcpRetentionBinding, retentionAsync: null }
}

/**
 * Default MCP run-registry deps from durable context (one clock + atomic + runs +
 * locks + idempotency + optional retention / retentionAsync binding). Cached
 * process-wide when resolved; setMcpRunRegistryDeps wins.
 * Retention binds only after resolveRetentionPolicy succeeds (approved BoardPolicy
 * or explicit LOCAL/TEST staging-proposal):
 * - memory/test → sync `retention`
 * - mysql → durable `retentionAsync` (cluster-durable sample/material/compaction)
 * UNRESOLVED env or MySQL durable-store unbound → both null (H3/R1 fail-closed).
 * PRODUCTION without supplied policy → both null.
 * Exported for unit tests of the non-injected path.
 */
export function defaultRunDeps(boardId?: string, boardRev = 0): RunRegistryDeps {
  void boardId
  void boardRev
  if (mcpRunDeps) return mcpRunDeps
  const ctx = resolveMcpRuntimeContext()
  const { retention, retentionAsync } = resolveMcpRetentionBindings(ctx)
  mcpRunDepsInjected = false
  // R3: production MCP deps never carry testCapacityInjection. Capacity only via getCapacity.
  mcpRunDeps = {
    clock: ctx.clock,
    runs: sharedRunStore(),
    locks: sharedLocks(),
    atomic: sharedAtomic(),
    idempotency: sharedIdempotency(),
    getCapacity: (id) => loadCapacityForBoard(id),
    retention,
    retentionAsync,
    // Explicit omit — do not accept request-forwarded inject capability.
    testCapacityInjection: undefined,
  }
  return mcpRunDeps
}

function decisionDeps(): DecisionV3Deps {
  return {
    clock: systemClock(),
    decisions: sharedDecisionStore(),
    atomic: sharedAtomic(),
    idempotency: sharedIdempotency(),
  }
}

function reconcilerDeps(runDeps: RunRegistryDeps): ReconcilerDeps {
  return {
    clock: runDeps.clock,
    runs: runDeps.runs,
    locks: runDeps.locks,
    reconciler: sharedReconcilerStore(),
    atomic: runDeps.atomic,
    idempotency: runDeps.idempotency,
  }
}

/**
 * Notify shared account-sync scheduler of a trigger (register/heartbeat/integration/…).
 * Uses peek (no lazy-init) so isolated unit tests without runtime context stay clean.
 * Never enqueues secrets — masked accounts only from durable snapshot.
 *
 * entityExpectedRev = **current account snapshot entityRev** (never run/lock entity rev).
 * expectedBoardRev = **post-mutation board rev** from atomic (never pre-bump envelope).
 * Failures are NOT swallowed: fail-closed stale usableCapacity=0 + typed result.
 */
export type AccountSchedulerNotifyResult =
  | { ok: true; kind: string; trigger: AccountSyncTrigger }
  | { ok: false; code: string; message: string; trigger: AccountSyncTrigger; failClosed: true }

export async function notifyAccountSchedulerTrigger(
  boardId: string,
  trigger: AccountSyncTrigger,
  opts: {
    /** Post-mutation board rev when known; else loaded from atomic. */
    expectedBoardRev?: number
    canonicalHash: string
    idempotencyKey: string
    actorId: string
  },
): Promise<AccountSchedulerNotifyResult> {
  const { peekAccountSyncScheduler } = await import('#/server/control-plane-runtime-context')
  const sched = peekAccountSyncScheduler()
  if (!sched) {
    return {
      ok: false,
      code: 'ACCOUNT_SYNC_SCHEDULER_MISSING',
      message: 'account sync scheduler not installed on runtime context',
      trigger,
      failClosed: true,
    }
  }
  try {
    const snap = await sharedAccountStore().get(boardId)
    if (!snap) {
      // No snapshot yet — nothing to publish; not a failure of the primary mutation.
      return { ok: true, kind: 'SKIPPED_NO_SNAPSHOT', trigger }
    }
    const board = await sharedAtomic().getBoardState(boardId)
    const expectedBoardRev =
      typeof opts.expectedBoardRev === 'number' ? opts.expectedBoardRev : board.boardRev
    // CAS against **account** entity rev (never run/lock entityRev).
    const entityExpectedRev = snap.entityRev
    // Masked-only: never pass through unknown secret-like fields.
    const accounts = snap.accounts.map((a) => ({
      maskedAccountId: a.maskedAccountId,
      status: a.status,
      providerKind: a.providerKind,
      effectiveInUse: a.effectiveInUse,
      effectiveCap: a.effectiveCap,
      physicalSlotsDisplay: a.physicalSlotsDisplay,
      adaptiveQuotaState: a.adaptiveQuotaState,
      reason: a.reason,
      statusChangedAt: a.statusChangedAt,
      expiresAt: a.expiresAt,
      quotaRemaining: a.quotaRemaining,
      quotaVerdict: a.quotaVerdict,
      chatVerdict: a.chatVerdict,
      probedAt: a.probedAt,
      probeAgeSeconds: a.probeAgeSeconds,
      adaptiveCap: a.adaptiveCap,
      quarantineReason: a.quarantineReason,
    }))
    const out = await sched.enqueue({
      boardId,
      sourceRevision: snap.sourceRevision + 1,
      generatedAt: new Date().toISOString(),
      entityExpectedRev,
      expectedBoardRev,
      canonicalHash: opts.canonicalHash,
      currentPinHash: opts.canonicalHash,
      accounts,
      trigger,
      idempotencyKey: opts.idempotencyKey,
      callerRole: 'ROOT_ORCHESTRATOR',
      actorId: opts.actorId,
    })
    return { ok: true, kind: out.kind, trigger }
  } catch (e) {
    const message = e instanceof Error ? e.message : String(e)
    const code =
      e && typeof e === 'object' && 'code' in e && typeof (e).code === 'string'
        ? String((e as { code: string }).code)
        : 'ACCOUNT_SYNC_NOTIFY_FAILED'
    try {
      await sched.failClosedStale(boardId, `NOTIFY_FAILED:${code}`)
    } catch {
      /* still surface typed failure below */
    }
    return { ok: false, code, message, trigger, failClosed: true }
  }
}

/**
 * Exhaustive account-sync trigger enum (MCP sync_accounts schema + domain).
 * WAVE_CLOSE is accepted on the ROOT callable path — not an external-only gap.
 */
export const ACCOUNT_SYNC_TRIGGER_VALUES = [
  'ORCHESTRATOR_LAUNCH',
  'WAVE_LAUNCH',
  'AGENT_LAUNCH',
  'HEARTBEAT',
  'MATERIAL_ASSIGNMENT',
  'STATUS_TRANSITION',
  'LIMIT_TRANSITION',
  'BAN_TRANSITION',
  'AUTH_EXPIRED_TRANSITION',
  'ROTATION',
  'REQUEUE',
  'INTEGRATION_CHECKPOINT',
  'WAVE_CLOSE',
  'PERIODIC_HEALTH',
] as const satisfies ReadonlyArray<AccountSyncTrigger>

export type AccountSyncTriggerValue = (typeof ACCOUNT_SYNC_TRIGGER_VALUES)[number]

/** Zod enum for sync_accounts.trigger (exact closed set). */
export const ACCOUNT_SYNC_TRIGGER_Z = z.enum(
  ACCOUNT_SYNC_TRIGGER_VALUES as unknown as [
    AccountSyncTriggerValue,
    ...AccountSyncTriggerValue[],
  ],
)

/**
 * External-adapter triggers with no in-repo callable surface.
 * Empty: WAVE_CLOSE is accepted via ROOT sync_accounts trigger enum.
 */
export const ACCOUNT_SYNC_EXTERNAL_ADAPTER_TRIGGERS =
  [] as const satisfies ReadonlyArray<AccountSyncTrigger>

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
  'ACCOUNT_SYNC_SCHEDULER_MISSING',
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
  // lifecycle V3 rail
  'INVALID_TRANSITION',
  'MISSING_EVIDENCE',
  'STALE_HASH',
  'SELF_VERIFICATION',
  'INVALID_VERIFIER_ROLE',
  'INVALID_MODEL_PAIRING',
  'INVALID_THREAD',
  'UNKNOWN_STAGE',
  'TASK_NOT_FOUND',
  // control-data / context
  'DB_UNAVAILABLE',
  'NOT_CONFIGURED',
  // humanDisplay persistence
  'INDEPENDENT_REVIEW_REQUIRED',
  'SOURCE_HASH_MISMATCH',
  'REVIEWED_IMMUTABLE',
  'CONTENT_REVIEW_REQUIRED',
  'TAMPER_DETECTED',
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
  return Object.keys(inputSchema)
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
  'sync_task_classifications',
  'set_lifecycle',
  'advance_task',
  'submit_stage_evidence',
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
  'terminate_run',
  'sync_accounts',
  'reconcile_dry_run',
  'reconcile_apply',
  'open_decision_v3',
  'resolve_decision_v3',
  'integration_lock',
  'upsert_human_display',
] as const

export type RegisteredWriteToolName = (typeof REGISTERED_WRITE_TOOL_NAMES)[number]

/**
 * Granular/legacy MCP writes that mutate task/project/feature definition graph
 * (board_docs / tasks membership). On pin-complete authority these must NOT
 * silently diverge the active pin — only replace_board_snapshot / applyImport CAS
 * may advance definition. Lifecycle/run/account/decision tools are NOT listed.
 *
 * upsert_human_display is intentionally excluded: it persists owner-facing copy
 * (control_plane_human_display), not the task/project/feature/board_docs definition
 * graph. Pin-complete definition authority still applies via mutation envelope
 * boardRev + canonicalHash binding (domain-owned CAS), not CANONICAL_IMPORT_REQUIRED.
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

/** Durable board + lifecycle pin after a successful lifecycle advance. */
export type AdvancePinBump = { boardRev: number; lifecycleRev: number }

/**
 * Packet A: lifecycle pin authority is board_revisions.lifecycle_rev.
 * Prefer atomic.bumpBoardAndLifecycleRev (MySQL + memory). Fail closed if absent.
 */
async function bumpBoardAndLifecycleRevOrThrow(
  atomic: ControlPlaneAtomicStore,
  boardId: string,
): Promise<AdvancePinBump> {
  if (typeof atomic.bumpBoardAndLifecycleRev === 'function') {
    return atomic.bumpBoardAndLifecycleRev(boardId)
  }
  throw new McpMutationError(
    'DATA_INTEGRITY',
    'advance_task requires atomic.bumpBoardAndLifecycleRev (lifecycle pin authority)',
    { boardId },
  )
}

/**
 * Align advance_task response pin fields to the durable bump result so response
 * equals immediate resolveBoardPin / get_board_hash re-read (SQL authority).
 */
function alignAdvanceResponsePin(body: object, next: AdvancePinBump): void {
  const b = body as Record<string, unknown>
  if ('boardRev' in b) b.boardRev = next.boardRev
  if ('lifecycleRev' in b) b.lifecycleRev = next.lifecycleRev
  if (b.pin && typeof b.pin === 'object' && !Array.isArray(b.pin)) {
    const pin = b.pin as Record<string, unknown>
    pin.boardRev = next.boardRev
    pin.lifecycleRev = next.lifecycleRev
  }
  if (b.readback && typeof b.readback === 'object' && !Array.isArray(b.readback)) {
    const rb = b.readback as Record<string, unknown>
    if ('boardRev' in rb) rb.boardRev = next.boardRev
    if ('lifecycleRev' in rb) rb.lifecycleRev = next.lifecycleRev
  }
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
          let currentLifecycleRev: number | undefined
          try {
            if (typeof atomic.getBoardPinRevs === 'function') {
              currentLifecycleRev = (await atomic.getBoardPinRevs(opts.boardId)).lifecycleRev
            } else {
              const pin = await resolveBoardPin(opts.boardId)
              currentLifecycleRev = pin.lifecycleRev
            }
          } catch {
            currentLifecycleRev = undefined
          }
          throw new McpMutationError(
            STALE_REVISION,
            `board rev mismatch: expected ${envelope.expectedBoardRev}, current ${board.boardRev}`,
            {
              expectedBoardRev: envelope.expectedBoardRev,
              currentBoardRev: board.boardRev,
              ...(currentLifecycleRev !== undefined ? { currentLifecycleRev } : {}),
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
      // Lifecycle stage advance (advance_task only): also +1 lifecycle_rev under same lock
      // so board_revisions.lifecycle_rev is durable pin authority (Packet A / D1).
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
        if (opts.toolName === 'advance_task') {
          const nextPin = await bumpBoardAndLifecycleRevOrThrow(atomic, opts.boardId)
          // Response pin must equal durable pin authority (same numbers as get_board_hash re-read).
          alignAdvanceResponsePin(body, nextPin)
        } else {
          await atomic.bumpBoardRev(opts.boardId)
        }
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
 * Ensures missing fields never pass. When boardId is provided, pin hash is checked
 * by default (checkPinHash defaults true) so "current canonical hash" is runtime-enforced.
 */
export async function assertMutationEnvelopeOrThrow(
  args: Record<string, unknown>,
  opts?: { boardId?: string; checkPinHash?: boolean },
): Promise<ParsedMutationEnvelope & { currentPinHash?: string }> {
  const env = parseMutationEnvelope(args)
  const boardId = opts?.boardId
  const checkPin = boardId != null && opts?.checkPinHash !== false
  if (checkPin && boardId) {
    const pin = await resolveBoardPin(boardId)
    if (pin.canonicalHash !== env.subjectHash) {
      throw new McpMutationError(
        STALE_REVISION,
        `subject hash mismatch: expected ${env.subjectHash}, current ${pin.canonicalHash}`,
        {
          expectedSubjectHash: env.subjectHash,
          currentSubjectHash: pin.canonicalHash,
          boardId,
        },
      )
    }
    return { ...env, currentPinHash: pin.canonicalHash }
  }
  return env
}

/** Fail closed not-found — throws so runMutationGate never CAS/idempotency-completes. */
export function throwNotFound(message: string, details: Record<string, unknown> = {}): never {
  throw new McpMutationError('NOT_FOUND', message, details)
}

const HUMAN_DISPLAY_ENTITY_KINDS = ['task', 'project', 'feature'] as const
const HUMAN_DISPLAY_REVIEW_STATUSES_MCP = [
  'REVIEWED',
  'GENERATED_NEEDS_REVIEW',
  'BLOCKED_MISSING_SOURCE',
  'CONFLICT',
  'CONTENT_REVIEW_REQUIRED',
] as const

function nonEmptyString(v: unknown, field: string): string {
  if (typeof v !== 'string' || !v.trim()) {
    throw new McpMutationError('INVALID_INPUT', `${field} is required (non-empty string)`)
  }
  return v.trim()
}

function optionalStringField(v: unknown): string | null {
  if (v == null) return null
  if (typeof v !== 'string') return null
  const t = v.trim()
  return t.length ? t : null
}

/**
 * Build HumanDisplayV1 from MCP upsert_human_display args.
 * Accepts compact field names (why/current/…) and ART brief aliases
 * (whyItMatters/currentState/remainingWork/nextAction/blockerSummary).
 */
export function parseHumanDisplayV1FromMcpArgs(
  args: Record<string, unknown>,
): HumanDisplayV1 {
  const entityKindRaw = nonEmptyString(args.entityKind, 'entityKind')
  if (!(HUMAN_DISPLAY_ENTITY_KINDS as readonly string[]).includes(entityKindRaw)) {
    throw new McpMutationError(
      'INVALID_INPUT',
      `entityKind must be one of: ${HUMAN_DISPLAY_ENTITY_KINDS.join(', ')}`,
      { entityKind: entityKindRaw },
    )
  }
  const entityKind = entityKindRaw as HumanDisplayEntityKind
  const entityId = nonEmptyString(args.entityId, 'entityId')

  const reviewStatusRaw =
    typeof args.reviewStatus === 'string' && args.reviewStatus.trim()
      ? args.reviewStatus.trim()
      : 'GENERATED_NEEDS_REVIEW'
  if (!(HUMAN_DISPLAY_REVIEW_STATUSES_MCP as readonly string[]).includes(reviewStatusRaw)) {
    throw new McpMutationError(
      'INVALID_INPUT',
      `invalid reviewStatus: ${reviewStatusRaw}`,
      { reviewStatus: reviewStatusRaw },
    )
  }
  const reviewStatus = reviewStatusRaw as HumanDisplayReviewStatus

  const why = nonEmptyString(
    args.why ?? args.whyItMatters,
    'why / whyItMatters',
  )
  const current = nonEmptyString(
    args.current ?? args.currentState,
    'current / currentState',
  )
  const remaining = nonEmptyString(
    args.remaining ?? args.remainingWork,
    'remaining / remainingWork',
  )
  const next = nonEmptyString(args.next ?? args.nextAction, 'next / nextAction')
  const blocker = nonEmptyString(
    args.blocker ?? args.blockerSummary,
    'blocker / blockerSummary',
  )

  const schemaVersion =
    typeof args.schemaVersion === 'string' && args.schemaVersion.trim()
      ? args.schemaVersion.trim()
      : HUMAN_DISPLAY_SCHEMA_VERSION
  if (schemaVersion !== HUMAN_DISPLAY_SCHEMA_VERSION) {
    throw new McpMutationError(
      'INVALID_INPUT',
      `invalid schemaVersion: ${schemaVersion}`,
      { schemaVersion },
    )
  }

  const contentVersion =
    typeof args.contentVersion === 'number' && Number.isFinite(args.contentVersion)
      ? args.contentVersion
      : 1

  const boardRev =
    typeof args.boardRev === 'number' && Number.isFinite(args.boardRev)
      ? args.boardRev
      : null
  const lifecycleRev =
    typeof args.lifecycleRev === 'number' && Number.isFinite(args.lifecycleRev)
      ? args.lifecycleRev
      : null

  const citations = Array.isArray(args.citations)
    ? (args.citations as HumanDisplayV1['citations']).map((c) => ({ ...c }))
    : []
  const acceptanceLinks = Array.isArray(args.acceptanceLinks)
    ? (args.acceptanceLinks as HumanDisplayV1['acceptanceLinks']).map((c) => ({ ...c }))
    : []
  const missionQuestionLinks = Array.isArray(args.missionQuestionLinks)
    ? (args.missionQuestionLinks as HumanDisplayV1['missionQuestionLinks']).map((c) => ({
        ...c,
      }))
    : []

  return {
    schemaVersion: HUMAN_DISPLAY_SCHEMA_VERSION,
    locale:
      typeof args.locale === 'string' && args.locale.trim()
        ? args.locale.trim()
        : DEFAULT_HUMAN_LOCALE,
    title: nonEmptyString(args.title, 'title'),
    outcome: nonEmptyString(args.outcome, 'outcome'),
    why,
    current,
    remaining,
    next,
    doneWhen: nonEmptyString(args.doneWhen, 'doneWhen'),
    blocker,
    ownerAction: nonEmptyString(args.ownerAction, 'ownerAction'),
    reviewStatus,
    sourceHash: nonEmptyString(args.sourceHash, 'sourceHash'),
    reviewedAt: optionalStringField(args.reviewedAt),
    contentVersion,
    entityKind,
    entityId,
    parentFeatureTitle:
      typeof args.parentFeatureTitle === 'string' ? args.parentFeatureTitle : '',
    businessArea: typeof args.businessArea === 'string' ? args.businessArea : '',
    actor: typeof args.actor === 'string' ? args.actor : '',
    snapshotId: optionalStringField(args.snapshotId),
    boardRev,
    lifecycleRev,
    // Optional pin binding on the display payload — not the mutation envelope hash.
    canonicalHash: optionalStringField(
      args.displayCanonicalHash ?? args.contentCanonicalHash ?? args.pinCanonicalHash,
    ),
    citations,
    acceptanceLinks,
    missionQuestionLinks,
  }
}

function mapHumanDisplayPersistenceError(e: unknown): never {
  if (e instanceof HumanDisplayPersistenceError) {
    throw new McpMutationError(e.code, e.message, { ...e.details })
  }
  throw e
}

function sharedHumanDisplayStore(): HumanDisplayStore {
  return resolveMcpRuntimeContext().humanDisplay
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
 * INTEGRATOR: request checkpoint + non-empty pathspecs required (fail closed; empty pathspecs
 * used to soft-pass via assertIntegratorBounds with pathspec=null).
 */
export function enforceIntegratorLockBounds(
  principal: Principal | null | undefined,
  opts: { checkpointId?: string | null; pathspecs: ReadonlyArray<string> },
): void {
  if (!principal) return
  if (principal.role === 'INTEGRATOR') {
    const pathspecs = (opts.pathspecs ?? [])
      .map((p) => String(p ?? '').trim())
      .filter((p) => p.length > 0)
    const checkpointId =
      typeof opts.checkpointId === 'string' && opts.checkpointId.trim()
        ? opts.checkpointId.trim()
        : null
    if (!checkpointId || pathspecs.length === 0) {
      throw new RbacError(
        'INTEGRATOR_PATH_BOUNDED',
        'integrator lock requires checkpointId and non-empty pathspec(s) — fail closed',
        403,
        { checkpointId, pathspecCount: pathspecs.length },
      )
    }
    // Principal binding presence + each request pathspec must be inside binding.
    for (const ps of pathspecs) {
      assertIntegratorBounds(principal, { checkpointId, pathspec: ps })
    }
    return
  }
  // Non-INTEGRATOR (ROOT etc.): still validate provided pathspecs against no-op bounds helper.
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

// ---------------------------------------------------------------------------
// Lifecycle V3 product wiring (AC-LIFE-03/04) — ordered rail, no skip, receipts
// ---------------------------------------------------------------------------

/** Board-doc kind for V3 pin rev overlay (boardRev/lifecycleRev after advances). */
export const LIFECYCLE_V3_PIN_DOC = 'lifecycle_v3_pin'

/** Board-doc kind for V3 task state map (stage receipts + history). */
export const LIFECYCLE_V3_TASKS_DOC = 'lifecycle_v3_tasks'

const V3_STAGE_SET = new Set<string>(V3_LIFECYCLE_RAIL as ReadonlyArray<string>)

export function isV3LifecycleStageKey(s: string): s is LifecycleStageKey {
  return V3_STAGE_SET.has(s)
}

/** Map LifecycleV3Error → McpMutationError so MCP typedError surfaces domain codes. */
export function mapLifecycleV3Error(e: unknown): never {
  if (e instanceof LifecycleV3Error) {
    throw new McpMutationError(e.code, e.message, { ...e.details })
  }
  throw e
}

/**
 * Compatibility alias response — emitted ONLY after a valid V3 transition.
 * Keeps legacy shape (ok/taskId/fromStage/stage/rev/implementer) + V3 pin/readback.
 */
export function toLegacyAdvanceCompatibilityResponse(
  v3: AdvanceV3Result,
): {
  ok: true
  taskId: string
  fromStage: string | null
  stage: string
  rev: number
  implementer: string | null
  boardRev: number
  lifecycleRev: number
  entityRev: number
  taskHash: string
  canonicalHash: string
  canonicalSnapshotId: string
  receipt: StageReceipt
  pin: AdvanceV3Result['pin']
  readback: AdvanceV3Result['readback']
  engine: 'advanceTaskV3'
} {
  return {
    ok: true,
    taskId: v3.taskId,
    fromStage: v3.fromStage,
    stage: v3.stage,
    rev: v3.entityRev,
    implementer: v3.receipt.authorRunId ?? null,
    boardRev: v3.boardRev,
    lifecycleRev: v3.lifecycleRev,
    entityRev: v3.entityRev,
    taskHash: v3.taskHash,
    canonicalHash: v3.canonicalHash,
    canonicalSnapshotId: v3.canonicalSnapshotId,
    receipt: v3.receipt,
    pin: v3.pin,
    readback: v3.readback,
    engine: 'advanceTaskV3',
  }
}

/**
 * Extract receiptId+receiptHash ONLY from advance args.
 * NEVER computes hash, NEVER accepts programmatic self-promotion, NEVER builds
 * a stage receipt body from the advance request — registry is sole authority.
 */
export function parseAdvanceReceiptRef(args: Record<string, unknown>): {
  receiptId: string
  receiptHash: string
} {
  const raw = args.receipt
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    const r = raw as Record<string, unknown>
    const receiptId = typeof r.receiptId === 'string' ? r.receiptId.trim() : ''
    const receiptHash = typeof r.receiptHash === 'string' ? r.receiptHash.trim() : ''
    if (!receiptId || !receiptHash) {
      throw new McpMutationError(
        'MISSING_EVIDENCE',
        'advance_task requires receipt.receiptId + receipt.receiptHash of a program-registered stage evidence receipt (server never computes hash on advance)',
        { receiptId, receiptHashPresent: Boolean(receiptHash) },
      )
    }
    return { receiptId, receiptHash }
  }
  // Top-level receiptId/receiptHash (no body)
  const receiptId =
    typeof args.receiptId === 'string'
      ? args.receiptId.trim()
      : typeof args.evidence === 'object' &&
          args.evidence &&
          typeof (args.evidence as { receiptId?: unknown }).receiptId === 'string'
        ? String((args.evidence as { receiptId: string }).receiptId).trim()
        : ''
  const receiptHash =
    typeof args.receiptHash === 'string'
      ? args.receiptHash.trim()
      : typeof args.evidence === 'object' &&
          args.evidence &&
          typeof (args.evidence as { receiptHash?: unknown }).receiptHash === 'string'
        ? String((args.evidence as { receiptHash: string }).receiptHash).trim()
        : ''
  if (!receiptId || !receiptHash) {
    throw new McpMutationError(
      'MISSING_EVIDENCE',
      'advance_task accepts only registered receiptId+receiptHash — no self-created receipt body, no hash computation on advance',
      { receiptId, receiptHashPresent: Boolean(receiptHash) },
    )
  }
  return { receiptId, receiptHash }
}

/**
 * @deprecated Use parseAdvanceReceiptRef — advance never builds receipts.
 * Kept for tests that still import the name; always throws MISSING_EVIDENCE
 * unless both receiptId and receiptHash are present (no hash computation).
 */
export function parseAdvanceStageReceipt(
  args: Record<string, unknown>,
  _opts?: {
    taskHash: string
    canonicalHash: string
    boardRev: number
    lifecycleRev: number
  },
): StageReceipt {
  const ref = parseAdvanceReceiptRef(args)
  // Stub only — advanceTaskV3 replaces with registry authority.
  return {
    receiptId: ref.receiptId,
    receiptHash: ref.receiptHash,
    programmatic: true,
    taskHash: '',
    canonicalHash: '',
    boardRev: 0,
    lifecycleRev: 0,
    fields: {},
    authorRunId: null,
    verifierRunId: null,
    verdict: null,
    issuedAt: new Date(0).toISOString(),
  }
}

export function buildAdvanceTaskV3Input(
  boardId: string,
  args: Record<string, unknown>,
  envelope: ParsedMutationEnvelope,
  pin: LifecycleBoardPin,
  taskHash: string,
): AdvanceV3Input {
  const toStageRaw = String(args.toStage ?? '')
  if (!isV3LifecycleStageKey(toStageRaw)) {
    throw new McpMutationError(
      'UNKNOWN_STAGE',
      `unknown V3 stage: ${toStageRaw}. Rail: ${V3_LIFECYCLE_RAIL.join(' → ')}`,
      { toStage: toStageRaw },
    )
  }
  const expectedLifecycleRev =
    typeof args.expectedLifecycleRev === 'number' && Number.isInteger(args.expectedLifecycleRev)
      ? args.expectedLifecycleRev
      : pin.lifecycleRev
  const expectedTaskHash =
    typeof args.expectedTaskHash === 'string' && args.expectedTaskHash.trim()
      ? args.expectedTaskHash.trim()
      : taskHash
  // Only receiptId+hash — never compute or accept a full receipt body from advance.
  const receipt = parseAdvanceStageReceipt(args)
  return {
    boardId,
    taskId: String(args.id ?? ''),
    toStage: toStageRaw,
    byRunId: String(args.byRunId ?? ''),
    entityExpectedRev: envelope.entityExpectedRev,
    expectedBoardRev: envelope.expectedBoardRev,
    expectedLifecycleRev,
    expectedTaskHash,
    expectedCanonicalHash: envelope.subjectHash,
    receipt,
    productionApprovalId:
      typeof args.productionApprovalId === 'string' ? args.productionApprovalId : null,
    requireOppositeModel: args.requireOppositeModel !== false,
  }
}

/**
 * Program-emit stage evidence (authenticated domain path).
 * Server sets programmatic=true and computes receiptHash; immutable registry put.
 * MCP: `submit_stage_evidence` (AGENT own-run only; ROOT accepts via advance_task).
 * Never inserts before run/pin/task-hash/entity-rev checks (see submitStageEvidence).
 */
export async function submitStageEvidenceProduct(
  boardId: string,
  inp: Omit<SubmitStageEvidenceInput, 'boardId'>,
): Promise<RegisteredStageEvidence & { created: boolean }> {
  const storage = createProductLifecycleV3Storage(boardId)
  try {
    return await submitStageEvidence(storage, { ...inp, boardId })
  } catch (e) {
    mapLifecycleV3Error(e)
  }
}

/**
 * Comment attribution is authenticated principal only.
 * Request author / authorType spoof fields are ignored by the MCP handler.
 */
export function commentAttributionFromPrincipal(
  principal: Principal | null | undefined,
): { author: string; authorType: 'human' | 'agent' } {
  return {
    author: attributionFromPrincipal(principal),
    authorType:
      principal?.role === 'OWNER' || principal?.channel === 'session' ? 'human' : 'agent',
  }
}

/** Injectable product storage factory (unit tests). Null → durable board_docs + tasks + runs. */
export function setProductLifecycleV3StorageFactory(
  factory: ((boardId: string) => LifecycleV3Storage) | null,
): void {
  productLifecycleV3StorageFactory = factory
}

export function createProductLifecycleV3Storage(boardId: string): LifecycleV3Storage {
  if (productLifecycleV3StorageFactory) return productLifecycleV3StorageFactory(boardId)
  return createDurableLifecycleV3Storage(boardId)
}

function mapRunRecordToRegistered(run: {
  runId: string
  agentId: string
  model: string
  role: string
  leaseExpiresAtMs?: number | null
  state?: string
  controllerRunId?: string | null
  parentRunId?: string | null
}): RegisteredRun {
  const terminalFenced =
    run.state === 'SUPERSEDED' || run.state === 'STALE' || run.state === 'CANCELLED'
  const expiresAt =
    run.leaseExpiresAtMs != null && Number.isFinite(run.leaseExpiresAtMs)
      ? new Date(run.leaseExpiresAtMs).toISOString()
      : '2099-01-01T00:00:00.000Z'
  return {
    runId: run.runId,
    agentId: run.agentId,
    model: run.model || 'unknown',
    role: run.role || 'implementer',
    threadId: run.controllerRunId || run.parentRunId || run.runId,
    expiresAt,
    fenced: terminalFenced,
    registered: true,
  }
}

/**
 * Clone a V3 lifecycle state (history/stageReceipts shallow-copied for isolation).
 */
export function cloneTaskLifecycleV3State(t: TaskLifecycleV3State): TaskLifecycleV3State {
  return {
    ...t,
    history: [...(t.history ?? [])],
    stageReceipts: { ...(t.stageReceipts ?? {}) },
  }
}

/**
 * Insert-if-absent a durable lifecycle_v3_tasks record under a per-board MySQL
 * advisory lock. Never overwrites an existing V3 record (preserves MAP_VERIFIED
 * entityRev/history). Concurrent readers that lose the lock re-read after.
 */
export async function persistDurableLifecycleV3IfAbsent(
  boardId: string,
  taskId: string,
  synthesized: TaskLifecycleV3State,
): Promise<TaskLifecycleV3State> {
  const lockName = `cairn_lc_v3_${boardId}`.slice(0, 64)
  const conn = await db().getConnection()
  try {
    const [acqRows] = await conn.query('SELECT GET_LOCK(?, 10) AS l', [lockName])
    const got = Number((acqRows as Array<{ l: number | null }>)[0]?.l)
    if (got !== 1) {
      // Lock unavailable: prefer any concurrent durable write, else ephemeral.
      try {
        const doc = await readDoc<{ tasks: Record<string, TaskLifecycleV3State> }>(
          boardId,
          LIFECYCLE_V3_TASKS_DOC,
          { tasks: {} },
        )
        if (doc?.tasks?.[taskId]) return cloneTaskLifecycleV3State(doc.tasks[taskId])
      } catch {
        /* fall through */
      }
      return cloneTaskLifecycleV3State(synthesized)
    }
    try {
      const [rows] = await conn.query(
        'SELECT data FROM board_docs WHERE board_id=? AND kind=?',
        [boardId, LIFECYCLE_V3_TASKS_DOC],
      )
      const raw = (rows as Array<{ data: unknown }>)[0]?.data
      const tasks: Record<string, TaskLifecycleV3State> =
        raw && typeof raw === 'object' && raw !== null && 'tasks' in (raw)
          ? { ...((raw as { tasks: Record<string, TaskLifecycleV3State> }).tasks ?? {}) }
          : {}
      if (tasks[taskId]) {
        return cloneTaskLifecycleV3State(tasks[taskId])
      }
      tasks[taskId] = {
        ...synthesized,
        history: [...synthesized.history],
        stageReceipts: { ...synthesized.stageReceipts },
      }
      await conn.query('REPLACE INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
        boardId,
        LIFECYCLE_V3_TASKS_DOC,
        JSON.stringify({ tasks }),
      ])
      return cloneTaskLifecycleV3State(tasks[taskId])
    } finally {
      await conn.query('SELECT RELEASE_LOCK(?) AS r', [lockName])
    }
  } finally {
    conn.release()
  }
}

/**
 * Bulk ensure every tasks-table row has a durable V3 lifecycle record.
 * Insert-if-absent only — never mutates existing MAP_VERIFIED / advanced rows.
 */
export async function backfillDurableLifecycleV3Records(
  boardId: string,
): Promise<{ total: number; already: number; created: number; missing: number }> {
  const storage = createDurableLifecycleV3Storage(boardId)
  const rows = await taskStageRows(boardId)
  let already = 0
  let created = 0
  let missing = 0
  let priorDoc: { tasks: Record<string, TaskLifecycleV3State> } = { tasks: {} }
  try {
    priorDoc = await readDoc(boardId, LIFECYCLE_V3_TASKS_DOC, { tasks: {} })
  } catch {
    priorDoc = { tasks: {} }
  }
  for (const r of rows) {
    if (priorDoc.tasks?.[r.id]) {
      already++
      continue
    }
    const state = await storage.getTask(boardId, r.id)
    if (!state) {
      missing++
      continue
    }
    // getTask lazy-persists; confirm
    const after = await readDoc<{ tasks: Record<string, TaskLifecycleV3State> }>(
      boardId,
      LIFECYCLE_V3_TASKS_DOC,
      { tasks: {} },
    )
    if (after?.tasks?.[r.id]) created++
    else missing++
  }
  return { total: rows.length, already, created, missing }
}

/**
 * Durable LifecycleV3Storage: pin overlay + task V3 state in board_docs,
 * stage column via setTaskLifecycle, runs via V3 registry (+ legacy board.runs),
 * immutable audit via writeAudit, stage evidence via controlData.stageEvidence
 * (fallback board_docs archive when control-data unavailable).
 *
 * CRITICAL: getTask MUST return a durable entityRev. Synthesizing from legacy
 * tasks.rev without persisting caused entityRev to flip 2↔0 between calls
 * (canonical import wrote tasks rows but not lifecycle_v3_tasks), so
 * advance_task / submit_stage_evidence always hit STALE_REVISION with boardRev
 * stable. Fix: lazy insert-if-absent durable V3 record on first touch; V3
 * entityRev starts at 0 (independent of legacy tasks.rev).
 *
 * CRITICAL (pin dual-authority): getBoardPin CAS boardRev/lifecycleRev MUST
 * match get_board_hash / resolveBoardPin (board_revisions atomic). Preferring
 * lifecycle_v3_pin overlay for CAS stuck the pin at the last advance watermark
 * while upsert_run kept bumping atomic boardRev → permanent STALE_REVISION
 * (expected N, current 43). Overlay is still written on saveTask as a watermark
 * only — not CAS authority.
 */
export function createDurableLifecycleV3Storage(boardId: string): LifecycleV3Storage {
  type TasksDoc = { tasks: Record<string, TaskLifecycleV3State> }
  type EvidenceDoc = { byReceiptId: Record<string, RegisteredStageEvidence> }
  const EVIDENCE_DOC = 'lifecycle_v3_stage_evidence'

  async function loadTasksDoc(): Promise<TasksDoc> {
    try {
      const doc = await readDoc<TasksDoc>(boardId, LIFECYCLE_V3_TASKS_DOC, { tasks: {} })
      return doc?.tasks ? doc : { tasks: {} }
    } catch {
      return { tasks: {} }
    }
  }

  async function stageEvidenceStore() {
    try {
      return resolveMcpRuntimeContext().controlData.stageEvidence
    } catch {
      return null
    }
  }

  function cloneState(t: TaskLifecycleV3State): TaskLifecycleV3State {
    return cloneTaskLifecycleV3State(t)
  }

  /**
   * Bootstrap V3 state from legacy tasks row / dual-write lifecycle JSON, then
   * persist durable lifecycle_v3_tasks insert-if-absent so entityRev is stable.
   */
  async function bootstrapAndPersistV3(
    taskId: string,
    pin: LifecycleBoardPin,
  ): Promise<TaskLifecycleV3State | null> {
    const row = await taskLifecycle(boardId, taskId)
    if (!row) return null

    let synthesized: TaskLifecycleV3State
    const lc = row.lifecycle as Record<string, unknown> | null
    if (lc && lc.v3 === true && typeof lc.taskId === 'string') {
      // Prefer embedded V3 snapshot (from a prior dual-write) but still durable-ize it.
      synthesized = {
        ...(lc as unknown as TaskLifecycleV3State),
        history: Array.isArray(lc.history)
          ? [...(lc.history as TaskLifecycleV3State['history'])]
          : [],
        stageReceipts:
          lc.stageReceipts && typeof lc.stageReceipts === 'object'
            ? { ...(lc.stageReceipts as TaskLifecycleV3State['stageReceipts']) }
            : {},
        // Pin revs always current (overlay may have advanced since dual-write).
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
      }
      // entityRev from embedded v3 is authoritative when present; never substitute tasks.rev.
      if (typeof synthesized.entityRev !== 'number' || !Number.isFinite(synthesized.entityRev)) {
        synthesized.entityRev = 0
      }
    } else {
      const stage =
        row.stage && isV3LifecycleStageKey(row.stage) ? (row.stage) : null
      let taskHash = `${boardId}:${taskId}:v0`
      try {
        const full = await readTask(boardId, taskId)
        if (full) {
          taskHash = computeTaskHash({
            id: full.id,
            title: full.title,
            projectId: full.projectId,
            featureContractId: full.featureContractId,
            objective: full.objective,
            checkpoints: full.checkpoints,
            dependencies: full.dependencies,
          })
        }
      } catch {
        /* keep fallback hash */
      }
      // V3 entityRev is independent of legacy tasks.rev (which dual-writes and
      // list overlays bump). Untouched imported tasks start at entityRev=0 so
      // clients can CAS with entityExpectedRev=0 deterministically.
      synthesized = {
        taskId,
        stage,
        entityRev: 0,
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        taskHash,
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        implementerRunId: row.implementerRun ?? null,
        implementerAgentId: null,
        implementerModel: null,
        implementerThreadId: null,
        history: [],
        stageReceipts: {},
        blockedReason: null,
      }
    }

    return persistDurableLifecycleV3IfAbsent(boardId, taskId, synthesized)
  }

  return {
    async getBoardPin(bid) {
      if (bid !== boardId) return null
      // Single authority with get_board_hash: board_revisions via resolveBoardPin.
      // Do NOT prefer lifecycle_v3_pin overlay for CAS — it lags every non-lifecycle
      // board write (upsert_run etc.) and creates dual-authority STALE forever.
      const base = await resolveBoardPin(boardId)
      return {
        boardId,
        boardRev: base.boardRev,
        lifecycleRev: base.lifecycleRev,
        canonicalSnapshotId: base.canonicalSnapshotId,
        canonicalHash: base.canonicalHash,
      }
    },

    async getTask(bid, taskId) {
      if (bid !== boardId) return null
      const pin = await this.getBoardPin(boardId)
      if (!pin) return null
      const doc = await loadTasksDoc()
      if (doc.tasks[taskId]) {
        // Align pin fields on every read. entityRev/stage/history are durable
        // authority; boardRev/lifecycleRev/canonical* track the live board pin so
        // advance_task CAS does not STALE after unrelated board writes (upsert_run)
        // bump boardRev while the task entity is untouched.
        const t = cloneState(doc.tasks[taskId])
        t.boardRev = pin.boardRev
        t.lifecycleRev = pin.lifecycleRev
        t.canonicalSnapshotId = pin.canonicalSnapshotId
        t.canonicalHash = pin.canonicalHash
        return t
      }
      // No durable V3 record — bootstrap from legacy and PERSIST (lazy backfill).
      try {
        return await bootstrapAndPersistV3(taskId, pin)
      } catch {
        return null
      }
    },

    async getRun(bid, runId) {
      if (bid !== boardId) return null
      try {
        const v3 = await defaultRunDeps(boardId).runs.get(boardId, runId)
        if (v3) {
          return mapRunRecordToRegistered({
            runId: v3.runId,
            agentId: v3.agentId,
            model: v3.model,
            role: v3.role,
            leaseExpiresAtMs: v3.leaseExpiresAtMs,
            state: v3.state,
            controllerRunId: v3.controllerRunId,
            parentRunId: v3.parentRunId,
          })
        }
      } catch {
        /* fall through to legacy */
      }
      try {
        const board = await readBoard(boardId)
        const legacy = (board.runs ?? []).find((r) => r.id === runId)
        if (legacy) {
          return {
            runId: legacy.id,
            agentId: legacy.agent ?? legacy.id,
            model: typeof (legacy as { model?: string }).model === 'string'
              ? String((legacy as { model?: string }).model)
              : 'legacy',
            role: legacy.role ?? 'implementer',
            threadId: legacy.id,
            expiresAt: '2099-01-01T00:00:00.000Z',
            fenced: false,
            registered: true,
          }
        }
      } catch {
        /* missing */
      }
      return null
    },

    async saveTask(bid, state, nextBoard) {
      if (bid !== boardId) {
        throw new LifecycleV3Error('TASK_NOT_FOUND', 'board mismatch', { boardId: bid })
      }
      // Serialize with the same advisory lock as lazy-persist so concurrent
      // insert-if-absent cannot clobber an advance write (or vice versa).
      const lockName = `cairn_lc_v3_${boardId}`.slice(0, 64)
      const conn = await db().getConnection()
      try {
        const [acqRows] = await conn.query('SELECT GET_LOCK(?, 10) AS l', [lockName])
        const got = Number((acqRows as Array<{ l: number | null }>)[0]?.l)
        if (got !== 1) {
          throw new LifecycleV3Error(
            'STALE_REVISION',
            'lifecycle_v3_tasks board lock unavailable — retry',
            { boardId, taskId: state.taskId },
          )
        }
        try {
          const [rows] = await conn.query(
            'SELECT data FROM board_docs WHERE board_id=? AND kind=?',
            [boardId, LIFECYCLE_V3_TASKS_DOC],
          )
          const raw = (rows as Array<{ data: unknown }>)[0]?.data
          const tasks: Record<string, TaskLifecycleV3State> =
            raw && typeof raw === 'object' && raw !== null && 'tasks' in (raw)
              ? { ...((raw as { tasks: Record<string, TaskLifecycleV3State> }).tasks ?? {}) }
              : {}
          tasks[state.taskId] = {
            ...state,
            history: [...state.history],
            stageReceipts: { ...state.stageReceipts },
            boardRev: nextBoard.boardRev,
            lifecycleRev: nextBoard.lifecycleRev,
          }
          await conn.query('REPLACE INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
            boardId,
            LIFECYCLE_V3_TASKS_DOC,
            JSON.stringify({ tasks }),
          ])
          await conn.query('REPLACE INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
            boardId,
            LIFECYCLE_V3_PIN_DOC,
            JSON.stringify({
              boardRev: nextBoard.boardRev,
              lifecycleRev: nextBoard.lifecycleRev,
            }),
          ])
        } finally {
          await conn.query('SELECT RELEASE_LOCK(?) AS r', [lockName])
        }
      } finally {
        conn.release()
      }
      // Dual-write stage column for list_tasks / rollup overlay (legacy consumers).
      // CAS against CURRENT legacy tasks.rev — never equate V3 entityRev with tasks.rev
      // (imports/overlays bump tasks.rev independently of V3 entity lifecycle).
      const lastEntry = state.history[state.history.length - 1]
      let legacyExpected: number | undefined
      try {
        const row = await taskLifecycle(boardId, state.taskId)
        if (row) legacyExpected = row.rev
      } catch {
        legacyExpected = undefined
      }
      await setTaskLifecycle(boardId, state.taskId, {
        stage: state.stage ?? 'MAPPING',
        implementerRun: state.implementerRunId,
        history: {
          v3: true,
          ...state,
          history: state.history,
          stageReceipts: state.stageReceipts,
        },
        blockedReason: state.blockedReason,
        lastReceiptAt: lastEntry?.ts ?? new Date().toISOString(),
        expectedRev: legacyExpected,
      })
    },

    async appendAudit(entry) {
      await writeAudit(boardId, {
        ts: String(entry.ts ?? new Date().toISOString()),
        actor: entry.actor != null ? String(entry.actor) : null,
        action: String(entry.action ?? 'advance_v3'),
        taskId: entry.taskId != null ? String(entry.taskId) : null,
        fromStage: entry.fromStage != null ? String(entry.fromStage) : null,
        toStage: entry.toStage != null ? String(entry.toStage) : null,
        detail: entry,
      })
    },

    async getStageEvidence(bid, receiptId) {
      if (bid !== boardId) return null
      const store = await stageEvidenceStore()
      if (store) {
        try {
          return await store.getStageEvidence(boardId, receiptId)
        } catch {
          /* fall through to board_docs */
        }
      }
      try {
        const doc = await readDoc<EvidenceDoc>(boardId, EVIDENCE_DOC, { byReceiptId: {} })
        const e = doc?.byReceiptId?.[receiptId]
        return e
          ? { ...e, receipt: { ...e.receipt, fields: { ...e.receipt.fields } } }
          : null
      } catch {
        return null
      }
    },

    async putStageEvidence(entry) {
      if (entry.boardId !== boardId) {
        throw new LifecycleV3Error('TASK_NOT_FOUND', 'board mismatch on stage evidence')
      }
      const store = await stageEvidenceStore()
      if (store) {
        await store.putStageEvidence(entry)
        return
      }
      // board_docs fallback (immutable insert-once)
      const doc = await readDoc<EvidenceDoc>(boardId, EVIDENCE_DOC, { byReceiptId: {} })
      const existing = doc.byReceiptId[entry.receipt.receiptId]
      if (existing && existing.receipt.receiptHash !== entry.receipt.receiptHash) {
        throw new LifecycleV3Error(
          'STALE_HASH',
          'stage evidence receiptId already registered with different hash (immutable)',
          {
            receiptId: entry.receipt.receiptId,
            existing: existing.receipt.receiptHash,
            next: entry.receipt.receiptHash,
          },
        )
      }
      if (!existing) {
        await writeDoc(boardId, EVIDENCE_DOC, {
          byReceiptId: {
            ...doc.byReceiptId,
            [entry.receipt.receiptId]: {
              ...entry,
              receipt: { ...entry.receipt, fields: { ...entry.receipt.fields } },
            },
          },
        })
      }
    },
  }
}

/**
 * Product advance: always V3 ordered rail. No legacy advanceTask path.
 * Returns compatibility alias only after a valid V3 transition.
 */
export async function advanceTaskProduct(
  boardId: string,
  args: Record<string, unknown>,
  envelope: ParsedMutationEnvelope,
): Promise<ReturnType<typeof toLegacyAdvanceCompatibilityResponse>> {
  const storage = createProductLifecycleV3Storage(boardId)
  const pin = await storage.getBoardPin(boardId)
  if (!pin) {
    throw new McpMutationError('TASK_NOT_FOUND', `board not found: ${boardId}`, { boardId })
  }
  const taskId = String(args.id ?? '')
  if (!taskId) {
    throw new McpMutationError('INVALID_INPUT', 'advance_task requires id (task id)')
  }
  const existing = await storage.getTask(boardId, taskId)
  const taskHash =
    typeof args.expectedTaskHash === 'string' && args.expectedTaskHash.trim()
      ? args.expectedTaskHash.trim()
      : existing?.taskHash ?? `${boardId}:${taskId}:v0`
  const inp = buildAdvanceTaskV3Input(boardId, args, envelope, pin, taskHash)
  try {
    const result = await advanceTaskV3(storage, inp)
    return toLegacyAdvanceCompatibilityResponse(result)
  } catch (e) {
    mapLifecycleV3Error(e)
  }
}

/**
 * V3 safety for set_lifecycle / init_lifecycle — legacy compatibility cannot bypass.
 * - set_lifecycle: refuse allowSkip=true on ANY board (never persist stage-skip)
 * - set_lifecycle pin-complete: refuse non-identity stage keys
 * - init_lifecycle pin-complete: refuse ALL seeding (MAPPING needs advance_task receipts)
 * - init_lifecycle non-pin-complete: only first MAPPING on truly empty lifecycle
 * Incomplete/missing pin with partial canonical authority fails closed (no silent legacy).
 */
export async function assertLifecycleEvidenceBypassForbidden(
  toolName: 'set_lifecycle' | 'init_lifecycle',
  boardId: string,
  args: Record<string, unknown>,
): Promise<void> {
  // Universal: allowSkip=true is never legal — pure-legacy early-return used to skip this.
  if (toolName === 'set_lifecycle' && args.allowSkip === true) {
    throw new McpMutationError(
      'INVALID_TRANSITION',
      'set_lifecycle cannot set allowSkip=true on any board (ordered V3 evidence required; legacy rail skip denied)',
      { boardId, toolName, code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN' },
    )
  }

  let boardState: Awaited<
    ReturnType<ReturnType<typeof resolveMcpRuntimeContext>['controlData']['imports']['getBoardState']>
  > = null
  let importReadable = true
  try {
    boardState = await resolveMcpRuntimeContext().controlData.imports.getBoardState(boardId)
  } catch {
    importReadable = false
  }

  const hasPartialCanonical =
    !!boardState &&
    !!(
      (boardState.canonicalSnapshotId && String(boardState.canonicalSnapshotId).trim()) ||
      (boardState.canonicalHash && String(boardState.canonicalHash).trim()) ||
      (boardState.subjectHash && String(boardState.subjectHash).trim())
    )
  const pinComplete = !!boardState && isPinComplete(boardState)

  // Incomplete/missing pin with partial canonical fields OR unreadable import on a
  // board that was expected to be canonical-bound: fail closed (no silent legacy bypass).
  if (!importReadable || (!pinComplete && hasPartialCanonical)) {
    throw new McpMutationError(
      'INVALID_TRANSITION',
      `${toolName} refused: incomplete/missing pin cannot silently enable legacy evidence bypass for canonical boards`,
      { boardId, toolName, code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN' },
    )
  }

  // Pure-legacy (no import row) and non-pin-complete without partial pin: still enforce
  // init_lifecycle empty-MAPPING-only; set_lifecycle allowSkip already checked above.
  if (!pinComplete) {
    if (toolName === 'init_lifecycle') {
      await assertInitLifecycleEmptyMappingOnly(boardId, args)
    }
    return
  }

  if (toolName === 'set_lifecycle') {
    const stages = Array.isArray(args.stages) ? args.stages : []
    const keys = stages
      .map((s) => (s && typeof s === 'object' ? String((s as { key?: string }).key ?? '') : ''))
      .filter(Boolean)
    if (keys.length > 0) {
      const expected = [...V3_LIFECYCLE_RAIL]
      const mismatch =
        keys.length !== expected.length || keys.some((k, i) => k !== expected[i])
      if (mismatch) {
        throw new McpMutationError(
          'INVALID_TRANSITION',
          'set_lifecycle on pin-complete board must keep V3 identity nine-stage ordered rail; use advance_task for stage movement',
          {
            boardId,
            toolName,
            code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN',
            expected: expected.join(','),
            got: keys.join(','),
          },
        )
      }
    }
  }

  if (toolName === 'init_lifecycle') {
    // Pin-complete: cannot seed even MAPPING without a valid V3 programmatic receipt
    // path (advance_task). init_lifecycle is always a bypass on pin-complete boards.
    throw new McpMutationError(
      'INVALID_TRANSITION',
      'init_lifecycle forbidden on pin-complete board — even MAPPING requires a valid V3 programmatic receipt via advance_task',
      {
        boardId,
        toolName,
        stage: typeof args.stage === 'string' ? args.stage : V3_LIFECYCLE_RAIL[0],
        code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN',
      },
    )
  }
}

/**
 * Non-pin-complete boards: init_lifecycle may only seed first stage MAPPING when
 * every task is still uninitialized (truly empty lifecycle). Fresh envelope is
 * enforced by runMutationGate (entityExpectedRev + expectedBoardRev + hash + idem).
 */
export async function assertInitLifecycleEmptyMappingOnly(
  boardId: string,
  args: Record<string, unknown>,
): Promise<void> {
  const mapping = V3_LIFECYCLE_RAIL[0]
  const stageRaw = args.stage
  const stage =
    typeof stageRaw === 'string' && stageRaw.trim() ? stageRaw.trim() : mapping
  if (stage !== mapping) {
    throw new McpMutationError(
      'INVALID_TRANSITION',
      `init_lifecycle only allows first stage ${mapping} on truly empty lifecycle; got ${stage}`,
      {
        boardId,
        toolName: 'init_lifecycle',
        stage,
        expected: mapping,
        code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN',
      },
    )
  }
  if (args.onlyUninitialized === false) {
    throw new McpMutationError(
      'INVALID_TRANSITION',
      'init_lifecycle requires onlyUninitialized=true (cannot overwrite assigned stages)',
      {
        boardId,
        toolName: 'init_lifecycle',
        stage,
        code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN',
      },
    )
  }
  const { taskStageRows } = await import('#/server/tasks-store')
  const rows = await taskStageRows(boardId)
  const assigned = rows.filter((r) => r.stage != null && String(r.stage).trim() !== '')
  if (assigned.length > 0) {
    throw new McpMutationError(
      'INVALID_TRANSITION',
      `init_lifecycle only on truly empty lifecycle; ${assigned.length} task(s) already have stages`,
      {
        boardId,
        toolName: 'init_lifecycle',
        stage,
        assignedCount: assigned.length,
        code: 'LIFECYCLE_EVIDENCE_BYPASS_FORBIDDEN',
      },
    )
  }
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
      expiresAt: typeof clean.expiresAt === 'string' ? clean.expiresAt : null,
      quotaRemaining:
        typeof clean.quotaRemaining === 'number' ? clean.quotaRemaining : null,
      quotaVerdict:
        clean.quotaVerdict === 'PASS' ||
        clean.quotaVerdict === 'FAIL' ||
        clean.quotaVerdict === 'SKIP' ||
        clean.quotaVerdict === 'UNKNOWN'
          ? clean.quotaVerdict
          : 'UNKNOWN',
      chatVerdict:
        clean.chatVerdict === 'PASS' ||
        clean.chatVerdict === 'FAIL' ||
        clean.chatVerdict === 'SKIP' ||
        clean.chatVerdict === 'UNKNOWN'
          ? clean.chatVerdict
          : 'UNKNOWN',
      probedAt: typeof clean.probedAt === 'string' ? clean.probedAt : null,
      probeAgeSeconds:
        typeof clean.probeAgeSeconds === 'number' ? clean.probeAgeSeconds : null,
      adaptiveCap:
        typeof clean.adaptiveCap === 'number'
          ? Math.min(20, Math.max(0, clean.adaptiveCap))
          : Math.min(20, Math.max(0, cap)),
      quarantineReason:
        typeof clean.quarantineReason === 'string' ? clean.quarantineReason : null,
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
    vault: vaultRaw,
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

  // Live board_docs hash is fallback when durable pin hash is absent.
  // Soft-fail only when durable hash already authority (memory unit harness without MySQL).
  // Without durable hash, rethrow so fail-closed callers still see DB/unavailable errors.
  let liveHash = ''
  try {
    liveHash = await boardHash(boardId)
  } catch (e) {
    if (!durableHash) throw e
    liveHash = ''
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
 * Pin-table probe failures that must degrade to the same legacy path as a missing row
 * (PIN_MISSING + PIN_AUTHORITY_INCOMPLETE), not MCP_HANDLER_ERROR / DATA_INTEGRITY.
 * Strict allowlist — other MySQL / programming errors rethrow.
 */
export function isPinProbeUnreadable(err: unknown): boolean {
  const e = err as { code?: string | number; errno?: number; sqlState?: string; message?: string }
  const code = e?.code != null ? String(e.code) : ''
  const errno = typeof e.errno === 'number' ? e.errno : typeof e.code === 'number' ? e.code : NaN
  // MySQL ER_NO_SUCH_TABLE (1146) / sqlState 42S02 — board_revisions (or pin probe table) absent.
  if (code === 'ER_NO_SUCH_TABLE' || errno === 1146) return true
  if (e.sqlState === '42S02' && /board_revisions/i.test(String(e.message ?? ''))) return true
  return false
}

/** Pool/connection death on pin probe → RUNTIME_UNAVAILABLE (honest incomplete, not invent pin). */
function isPinProbeRuntimeUnavailable(err: unknown): boolean {
  const e = err as { code?: string; errno?: number; message?: string }
  const code = e?.code != null ? String(e.code) : ''
  if (
    code === 'ECONNREFUSED' ||
    code === 'ECONNRESET' ||
    code === 'ETIMEDOUT' ||
    code === 'PROTOCOL_CONNECTION_LOST' ||
    code === 'ER_ACCESS_DENIED_ERROR' ||
    code === 'DB_UNAVAILABLE'
  ) {
    return true
  }
  // mysql2 pool closed / no connection
  if (/Pool is closed|Cannot enqueue Query after|server closed the connection/i.test(String(e.message ?? ''))) {
    return true
  }
  return false
}

/**
 * Resolve definition authority for list/get projects/features/tasks/work/overview.
 * Fail-closed when pin complete but snapshot/hash invalid (throws CanonicalReadModelError).
 * Legacy only when pin genuinely incomplete/missing — pin marked stale honestly.
 * Missing board_revisions table (ER_NO_SUCH_TABLE) ≡ missing row (PIN_MISSING), not uncaught throw.
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

  let boardState: Awaited<ReturnType<typeof imports.getBoardState>>
  try {
    boardState = await imports.getBoardState(boardId)
  } catch (e) {
    // Probe only — do not wrap loadPinnedDefinitionReadModel (pin-complete stays fail-closed).
    if (isPinProbeUnreadable(e)) {
      const pin = await resolveBoardPin(boardId)
      return {
        mode: 'legacy',
        pin: { ...pin, stale: true, staleReason: 'PIN_AUTHORITY_INCOMPLETE' },
        authorityIncomplete: true,
        incompleteCode: 'PIN_MISSING',
      }
    }
    if (isPinProbeRuntimeUnavailable(e)) {
      const pin = await resolveBoardPin(boardId)
      return {
        mode: 'legacy',
        pin: { ...pin, stale: true, staleReason: 'PIN_AUTHORITY_INCOMPLETE' },
        authorityIncomplete: true,
        incompleteCode: 'RUNTIME_UNAVAILABLE',
      }
    }
    throw e
  }
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

/**
 * Soft-load durable Lifecycle V3 task states (board_docs lifecycle_v3_tasks).
 * Read-only — never bootstraps/persists. Same durable map advance_task mutates.
 */
export async function loadDurableLifecycleV3TaskStates(
  boardId: string,
): Promise<Map<string, TaskLifecycleV3State>> {
  try {
    const doc = await readDoc<{ tasks?: Record<string, TaskLifecycleV3State> }>(
      boardId,
      LIFECYCLE_V3_TASKS_DOC,
      { tasks: {} },
    )
    const map = new Map<string, TaskLifecycleV3State>()
    const tasks = doc?.tasks ?? {}
    for (const [id, st] of Object.entries(tasks)) {
      if (id && st && typeof st === 'object') map.set(id, st)
    }
    return map
  } catch {
    return new Map()
  }
}

/**
 * Prefer durable V3 stage over legacy tasks.lifecycle_stage so list_tasks /
 * rollup / work surfaces match advance_task / getTask V3 authority.
 * When no V3 record exists, legacy stage is left unchanged.
 */
export function applyDurableV3StageOverlay(
  lifecycleByTaskId: Map<string, WorkTask>,
  v3ByTaskId: ReadonlyMap<string, TaskLifecycleV3State>,
): Map<string, WorkTask> {
  for (const [taskId, v3] of v3ByTaskId) {
    if (!v3 || typeof v3 !== 'object') continue
    // V3 stage is authoritative when a durable record exists (including null).
    const stage = (v3.stage as string | null | undefined) ?? null
    const hist = Array.isArray(v3.history) ? v3.history : []
    const last = hist.length ? hist[hist.length - 1] : undefined
    const lastReceiptAt =
      (last && typeof last.ts === 'string' && last.ts) || null
    const blockedReason =
      v3.blockedReason != null
        ? String(v3.blockedReason)
        : last && 'blocker' in last && last.blocker != null
          ? String(last.blocker)
          : null

    const existing = lifecycleByTaskId.get(taskId)
    if (existing) {
      lifecycleByTaskId.set(taskId, {
        ...existing,
        lifecycleStage: stage,
        blockedReason: blockedReason ?? existing.blockedReason ?? null,
        lastReceiptAt: lastReceiptAt ?? existing.lastReceiptAt ?? null,
      })
    } else {
      // Minimal stub so definition-only left-join still surfaces V3 stage.
      lifecycleByTaskId.set(taskId, {
        id: taskId,
        title: taskId,
        dependencies: [],
        impacts: [],
        checkpoints: [],
        lifecycleStage: stage,
        blockedReason,
        lastReceiptAt,
      })
    }
  }
  return lifecycleByTaskId
}

/**
 * Soft-load lifecycle WorkTask rows for left-join overlay (never definition authority).
 * Stage authority: durable lifecycle_v3_tasks when present, else legacy tasks.lifecycle_stage.
 * Matches advance_task / createDurableLifecycleV3Storage.getTask stage source of truth.
 */
export async function loadLifecycleTaskOverlay(
  boardId: string,
): Promise<Map<string, WorkTask>> {
  const map = new Map<string, WorkTask>()
  try {
    const doc = await readTasks(boardId)
    for (const t of doc.tasks ?? []) {
      if (t?.id) map.set(t.id, t)
    }
  } catch {
    /* empty legacy overlay */
  }
  try {
    const v3 = await loadDurableLifecycleV3TaskStates(boardId)
    if (v3.size > 0) applyDurableV3StageOverlay(map, v3)
  } catch {
    /* keep legacy stages */
  }
  return map
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
    nextCursor: (extra.nextCursor) ?? null,
    cursor: (extra.cursor) ?? null,
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
    boardRev: typeof extra.boardRev === 'number' ? (extra.boardRev) : pin.boardRev,
    lifecycleRev:
      typeof extra.lifecycleRev === 'number' ? (extra.lifecycleRev) : pin.lifecycleRev,
    canonicalSnapshotId:
      typeof extra.canonicalSnapshotId === 'string'
        ? (extra.canonicalSnapshotId)
        : pin.canonicalSnapshotId,
    canonicalHash:
      typeof extra.canonicalHash === 'string' ? (extra.canonicalHash) : pin.canonicalHash,
    stale: typeof extra.stale === 'boolean' ? (extra.stale) : pin.stale,
    staleReason:
      extra.staleReason === null || typeof extra.staleReason === 'string'
        ? (extra.staleReason)
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
    try {
      server.registerTool(name, meta as any, async (args: any) => {
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
    } catch (e) {
      // Duplicate name (e.g. domain-knowledge after product knowledge) — keep first handler.
      if (e instanceof Error && /already registered/i.test(e.message)) return
      throw e
    }
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

  // Knowledge and documentation are authenticated board reads. Keep their
  // registration beside secureTool so tools/list and tools/call share the
  // exact same RBAC filter as the rest of the production MCP catalog.
  // Product knowledge FIRST so search_knowledge uses flow-data corpus handlers;
  // domain-knowledge then skips the duplicate name via secureTool already-registered.
  registerKnowledgeTools({ secureTool: secureTool as never, jsonText })
  registerDomainKnowledgeTools({ secureTool: secureTool as never, jsonText })
  registerExportDocumentationTool({ secureTool: secureTool as never, jsonText })
  registerRebuildParityTools({ secureTool: secureTool as never, jsonText })


  // ---- boards ----
  secureTool(
    'list_boards',
    { title: 'List boards', description: 'List all boards (each board is its own scope).', inputSchema: {} },
    async () => jsonText({ boards: await listBoards() }),
  )
  secureTool(
    'get_capabilities',
    {
      title: 'Get authenticated CP0 capabilities',
      description:
        'Identity-safe capability names available to the current board-bound principal. Missing sensitive scopes remain omitted.',
      inputSchema: { ...BOARD_ARG },
    },
    async (args) => {
      const id = resolveCp0ReadBoardId(args.boardId, principal)
      if (!id) throw new RbacError('FORBIDDEN_SCOPE', 'boardId required for CP0 metadata read')
      const pin = boardPinToMcpReadPin(await resolveBoardPin(id))
      return jsonText({
        ok: true,
        authenticated: principal != null,
        role: principal?.role ?? null,
        capabilities: listHumanSafeToolNames(principal),
        boardRev: pin.boardRev,
        lifecycleRev: pin.lifecycleRev,
        canonicalHash: pin.canonicalHash,
        observedAt: pin.generatedAt,
        stale: pin.stale,
      })
    },
  )
  secureTool(
    'get_sync_status',
    {
      title: 'Get fail-closed CP0 sync status',
      description:
        'Pinned sync/backlog readback. Missing migration-008 state remains explicit UNKNOWN and never becomes zero.',
      inputSchema: { ...BOARD_ARG },
    },
    async (args) => {
      const id = resolveCp0ReadBoardId(args.boardId, principal)
      if (!id) throw new RbacError('FORBIDDEN_SCOPE', 'boardId required for CP0 metadata read')
      const pin = boardPinToMcpReadPin(await resolveBoardPin(id))
      let row: Cp0SyncStatusRow | null = null
      let schemaAvailable = true
      try {
        const [rows] = await db().query(
          `SELECT status, outbox_pending, legacy_unreplayed, effective_backlog,
                  board_rev, lifecycle_rev, canonical_hash, last_ack_revision,
                  freshness_at, entity_rev
             FROM control_plane_sync_status
            WHERE board_id=?
            LIMIT 1`,
          [id],
        )
        row = (rows as Array<Cp0SyncStatusRow>)[0] ?? null
      } catch {
        // App-only compatibility on schema 007: absence is an explicit unknown,
        // never a fabricated empty outbox.
        schemaAvailable = false
      }
      return jsonText({
        ...buildCp0SyncStatusReadback(row, pin),
        schemaAvailable,
      })
    },
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
      type ListRunRow = {
        id: string
        runId: string
        createdAt: string
        status: string | null
        taskId: string | null
        agentId: string | null
        model: string | null
        role: string | null
        planId: string | null
        fencingToken: string | null
        entityRev: number | null
        boardRev: number | null
        stalled: boolean
        source: 'durable_registry' | 'legacy_board_runs'
        verdict?: string | null
        evidencePath?: string | null
        targetGate?: string | null
        controlPlaneVersion?: string | null
        hierarchyLevel?: string | null
        controllerRunId?: string | null
        parentRunId?: string | null
        spawnBudgetMax?: number
        spawnAuthorizationId?: string | null
        registrationAck?: unknown
        budgetAck?: unknown
      }
      const mapped: ListRunRow[] = rows.map((r) => ({
        id: r.runId,
        runId: r.runId,
        createdAt:
          r.registeredAtMs != null ? new Date(r.registeredAtMs).toISOString() : pin.generatedAt,
        status: r.state,
        taskId: r.taskId,
        agentId: r.agentId,
        model: r.model,
        role: r.role,
        planId: r.planId,
        fencingToken: r.fencingToken,
        entityRev: r.entityRev,
        boardRev: r.boardRev,
        stalled: r.stalled,
        source: 'durable_registry' as const,
        controlPlaneVersion: r.controlPlaneVersion ?? 'LEGACY_V3',
        hierarchyLevel: r.hierarchyLevel ?? null,
        controllerRunId: r.controllerRunId,
        parentRunId: r.parentRunId,
        spawnBudgetMax: r.spawnBudgetMax ?? 0,
        spawnAuthorizationId: r.spawnAuthorizationId ?? null,
        registrationAck: r.registrationAck ?? null,
        budgetAck: r.budgetAck ?? null,
      }))
      // Dual-read: fleet still writes via upsert_run → board_docs.runs while
      // register_run/list_runs used control_plane_runs. Merge legacy rows so
      // Agents/MCP surfaces are not empty when the durable registry is unpopulated.
      try {
        const board = await readBoard(id)
        const durableIds = new Set(mapped.map((m) => m.runId))
        for (const r of board.runs ?? []) {
          if (!r?.id || durableIds.has(r.id)) continue
          const legacyStatus = r.status ?? null
          if (status) {
            const want = String(status)
            const got = String(legacyStatus ?? '')
            if (got !== want && got.toUpperCase() !== want.toUpperCase()) continue
          }
          const legacyTask = r.taskId ?? r.task ?? null
          if (taskId && legacyTask !== taskId) continue
          mapped.push({
            id: r.id,
            runId: r.id,
            createdAt: r.started || r.updated || pin.generatedAt,
            status: legacyStatus,
            taskId: legacyTask,
            agentId: r.agent ?? null,
            model: r.model ?? null,
            role: r.role ?? null,
            planId: null,
            fencingToken: null,
            entityRev: null,
            boardRev: pin.boardRev,
            stalled: false,
            verdict: (r as { verdict?: string | null }).verdict ?? null,
            evidencePath: r.evidencePath ?? null,
            targetGate: (r as { targetGate?: string | null }).targetGate ?? null,
            source: 'legacy_board_runs' as const,
          })
          durableIds.add(r.id)
        }
      } catch {
        // Legacy board read failure must not break durable list_runs.
      }
      mapped.sort(
        (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
      )
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
            // Security R2: strip self-asserted sales/mfs membership on MCP upsert_task.
            // Membership is server-derived from project/repo/feature allowlist at pin.
            const taskIn = args.task as WorkTask & {
              classification?: TaskClassificationRecord | null
              classificationReceipt?: import('#/lib/control-plane-types').ClassificationReceipt | null
            }
            const task = { ...taskIn } as typeof taskIn
            if (task.classification && typeof task.classification === 'object') {
              task.classification = sanitizeClassificationRecordForPersistence({
                taskId: String(task.id ?? ''),
                taskClass: (task.classification.taskClass ?? 'UNCLASSIFIED'),
                disposition: (task.classification.disposition ??
                  'UNCLASSIFIED'),
                receipt: task.classification.receipt ?? null,
                controlPlaneTargetGate: task.classification.controlPlaneTargetGate,
                controlPlaneGateVerifiedPass: task.classification.controlPlaneGateVerifiedPass,
                controlPlaneRootAccepted: task.classification.controlPlaneRootAccepted,
              })
            }
            if (task.classificationReceipt && typeof task.classificationReceipt === 'object') {
              task.classificationReceipt = stripSelfAssertedMembershipFields(
                task.classificationReceipt,
              )
            }
            return await upsertTask(id, task, env.entityExpectedRev)
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
        const mapped = mapLegacyOpsAccountsToSync(opsRaw)
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
        const statusList = mapped.map((a) => a.status)
        const trigger = inferAccountSyncTriggerFromStatuses(statusList, 'ORCHESTRATOR_LAUNCH')
        const baseReq = {
          boardId,
          sourceRevision,
          generatedAt,
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          accounts: mapped,
          trigger,
          idempotencyKey: env.idempotencyKey,
          callerRole: 'ROOT_ORCHESTRATOR' as const,
          actorId: actorIdOf(),
        }
        // Shared scheduler required — same fail-closed rule as sync_accounts.
        // Never fall back to raw syncAccounts (unverified parity / null readbackSurfaces).
        const { peekAccountSyncScheduler } = await import('#/server/control-plane-runtime-context')
        const sched = peekAccountSyncScheduler()
        if (!sched) {
          throw new McpMutationError(
            'ACCOUNT_SYNC_SCHEDULER_MISSING',
            'account sync scheduler not installed on runtime context — refuse unverified parity publish',
            { boardId, trigger, failClosed: true },
          )
        }
        const out = await sched.enqueue({
          ...baseReq,
          accounts: mapped,
        })
        if (!out.result) {
          throw new McpMutationError(
            'ACCOUNT_SYNC_STALE',
            `replace_accounts scheduler enqueue did not publish (${out.kind})`,
            { kind: out.kind, trigger, boardId },
          )
        }
        const syncResult = out.result
        // Compatibility vault doc for legacy ops readers (after durable authority succeeds).
        const compatOps = legacyOpsCompatibilityPayload(opsRaw)
        await replaceAccounts(boardId, compatOps)
        return jsonText({
          ...compatibilityReplaceAccountsResponse(compatOps, syncResult),
          trigger,
        })
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

  secureWriteTool(
    'sync_task_classifications',
    {
      title: 'Publish complete V3 task classifications',
      description:
        'ROOT/OWNER-only schema-007-compatible complete-set classification publication. The server generates pin-bound receipts for the single post-write board revision; partial, duplicate, extra, missing, or UNCLASSIFIED batches fail closed.',
      inputSchema: {
        ...BOARD_ARG,
        items: z
          .array(
            z.object({
              taskId: z.string().min(1),
              taskClass: z.enum(['PRODUCT', 'CONTROL_PLANE']),
              disposition: z.enum(['ACTIVE', 'HOLD', 'EXCLUDE']),
              controlPlaneTargetGate: z.string().min(1).optional(),
            }),
          )
          .min(1)
          // Complete-set boards exceed 2k tasks (e.g. 2501); headroom for growth.
          .max(10_000),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        const parsedEnvelope = parseMutationEnvelope(args)
        const ctx = resolveMcpRuntimeContext()
        const begin = await beginIdempotent(ctx.idempotency, {
          scope: {
            actorId: actorIdOf(),
            boardId,
            endpoint: 'sync_task_classifications',
            key: parsedEnvelope.idempotencyKey,
          },
          requestBody: args,
          nowMs: ctx.clock.nowMs(),
        })
        if (begin.kind === 'REPLAY' && begin.record) {
          return jsonText({
            ...(begin.record.responseBody as Record<string, unknown>),
            replayed: true,
          })
        }
        try {
          const envelope = await assertMutationEnvelopeOrThrow(args, {
            boardId,
            checkPinHash: true,
          })
          const authority = await resolveBoardDefinitionAuthority(boardId)
          if (authority.mode !== 'canonical') {
            throw new McpMutationError(
              'DATA_INTEGRITY',
              'classification sync requires a complete canonical definition pin',
              { boardId, mode: authority.mode },
            )
          }
          const plan = buildClassificationSyncPlan({
            items: args.items,
            canonicalTaskIds: authority.definition.projection.distinctTaskIds,
            pin: authority.pin,
            issuedAt: systemClock().nowISO(),
          })
          const receiptSetHash = createHash('sha256')
            .update(plan.records.map((record) => record.receipt?.receiptHash ?? '').join('\n'))
            .digest('hex')
          const auditId = `classification-sync-${receiptSetHash.slice(0, 40)}`
          const store = ctx.controlData.classification
          if (typeof store.replaceAll !== 'function') {
            throw new McpMutationError(
              'DATA_INTEGRITY',
              'durable transactional classification replacement is unavailable',
              { boardId },
            )
          }
          const persisted = await store.replaceAll(boardId, plan.records, {
            expectedBoardRev: envelope.expectedBoardRev,
            expectedEntityRev: envelope.entityExpectedRev,
            outputBoardRev: plan.outputBoardRev,
            outputEntityRev: envelope.entityExpectedRev + 1,
            lifecycleRev: plan.lifecycleRev,
            canonicalHash: plan.canonicalHash,
            actorId: actorIdOf(),
            auditId,
            receiptSetHash,
            issuedAt: plan.records[0]?.receipt?.issuedAt ?? systemClock().nowISO(),
          })
          const result = {
            ok: true as const,
            schemaVersion: plan.schemaVersion,
            boardId,
            inputBoardRev: plan.inputBoardRev,
            boardRev: persisted.boardRev,
            entityRev: persisted.entityRev,
            lifecycleRev: plan.lifecycleRev,
            canonicalSnapshotId: plan.canonicalSnapshotId,
            canonicalHash: plan.canonicalHash,
            counts: plan.counts,
            receiptSetHash,
            auditId: persisted.auditId,
            readbackRequired: [
              'get_rollup',
              'list_tasks',
              'get_lifecycle',
              'list_audit',
              'list_activity',
              'get_board_hash',
            ],
          }
          await completeIdempotent(
            ctx.idempotency,
            begin.scopeHash,
            200,
            result,
            begin.requestHash,
          )
          return jsonText(result)
        } catch (error) {
          try {
            await ctx.idempotency.delete(begin.scopeHash)
          } catch {
            // Preserve the primary typed failure; a retry remains fail-closed.
          }
          throw error
        }
      } catch (error) {
        if (error instanceof ClassificationSyncError) {
          return jsonText(
            typedError(
              new McpMutationError('DATA_INTEGRITY', error.message, {
                classificationCode: error.code,
                ...error.details,
              }),
            ),
          )
        }
        return asErr(error)
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
    {
      title: 'Set lifecycle rail',
      description:
        "Fully (re)configure this board's lifecycle: ordered stages + gate rules. gated:true = reachable only via advance_task with a program-emitted receipt; verifierRole = must be passed by a run other than the implementer. allowSkip is always forced false (legacy rail skip denied on every board). allowRegression (default true) permits moving back for repair. Pin-complete boards must keep the V3 identity nine-stage rail (ordered evidence via advance_task only). Requires fresh mutation envelope.",
      inputSchema: {
        ...BOARD_ARG,
        stages: z.array(STAGE_OBJ).min(1),
        allowSkip: z.boolean().optional(),
        allowRegression: z.boolean().optional(),
        formulaVersion: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        await assertLifecycleEvidenceBypassForbidden('set_lifecycle', boardId, args as Record<string, unknown>)
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
            // Domain hard-forces allowSkip=false; never pass true through.
            await writeLifecycle(boardId, args.stages as never, {
              allowSkip: false,
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
    {
      title: 'Get task lifecycle',
      description:
        'Current stage, rev (for optimistic lock), implementer run, and stage history for one task. Stage authority matches advance_task (durable V3 when present). Pinned envelope.',
      inputSchema: { ...BOARD_ARG, id: z.string() },
    },
    async ({ boardId, id }) => {
      try {
        const bid0 = await bid(boardId)
        const lc = await taskLifecycle(bid0, id)
        if (!lc) return jsonText({ error: `task not found: ${id}`, code: 'NOT_FOUND' })
        // Prefer durable V3 stage (same map advance mutates). Keep legacy rev for
        // dual-write CAS; entityRev lives on V3 and is not this field.
        let stage = lc.stage
        let implementerRun = lc.implementerRun
        let lifecycle = lc.lifecycle
        try {
          const v3Map = await loadDurableLifecycleV3TaskStates(bid0)
          const v3 = v3Map.get(id)
          if (v3) {
            stage = (v3.stage) ?? null
            if (v3.implementerRunId != null) implementerRun = v3.implementerRunId
            // JSON clone keeps TaskLifecycleRow.lifecycle (Json) assignable.
            lifecycle = JSON.parse(
              JSON.stringify({
                v3: true,
                ...v3,
                history: [...(v3.history ?? [])],
                stageReceipts: { ...(v3.stageReceipts ?? {}) },
              }),
            ) as typeof lc.lifecycle
          }
        } catch {
          /* legacy only */
        }
        const merged = {
          stage,
          rev: lc.rev,
          implementerRun,
          lifecycle,
        }
        return jsonText(
          await pinnedEnvelopeFromBoard(bid0, { taskLifecycle: merged, ...merged }),
        )
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
        "Move a task one ordered V3 stage (allowSkip=false). Requires registered unexpired unfenced byRunId, fresh entityExpectedRev + expectedBoardRev + expectedLifecycleRev, current task/canonical hashes, and a stage-specific programmatic receipt. Verifier stages enforce author≠verifier (run/agent/model/thread). Compatibility alias response only after a valid V3 transition. Immutable audit + readback pin on success.",
      inputSchema: {
        ...BOARD_ARG,
        id: z.string(),
        toStage: z.string(),
        byRunId: z.string().describe('run/agent id performing the transition (required)'),
        role: z.string().optional(),
        evidence: z.record(z.string(), z.any()).optional(),
        receipt: z.record(z.string(), z.any()).optional(),
        verdict: z.string().optional(),
        commitSha: z.string().optional(),
        deployReceipt: z.string().optional(),
        blocker: z.string().optional(),
        expectedLifecycleRev: z.number().int().optional(),
        expectedTaskHash: z.string().optional(),
        productionApprovalId: z.string().optional(),
        authorRunId: z.string().optional(),
        verifierRunId: z.string().optional(),
        requireOppositeModel: z.boolean().optional(),
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
            // Product path: advanceTaskV3 ordered rail only (no legacy advanceTask).
            return await advanceTaskProduct(boardId, { ...args, boardId } as Record<string, unknown>, env)
          },
        )
        return jsonText(result)
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureWriteTool(
    'submit_stage_evidence',
    {
      title: 'Submit stage evidence',
      description:
        'AGENT program-emits immutable stage evidence for its own registered unexpired unfenced run. Server sets programmatic=true and computes receiptHash; binds task/stage/hashes/revs. Full mutation envelope required (entityExpectedRev + expectedBoardRev + canonicalHash|subjectHash + idempotencyKey). Validates current pin/task hash/lifecycle/entity rev BEFORE insert. Exact key/request replay is idempotent (no double bump/duplicate); changed body → conflict; stale rev/hash rejected. Immutable receipt create/update is domain put (exact hash replay / conflict). Advance accepts only registered receiptId+receiptHash. ROOT/OWNER cannot impersonate agent evidence.',
      inputSchema: {
        ...BOARD_ARG,
        taskId: z.string(),
        toStage: z.string(),
        byRunId: z.string().describe('registered unexpired unfenced run that emits this receipt'),
        fields: z.record(z.string(), z.any()).optional(),
        taskHash: z.string(),
        expectedLifecycleRev: z.number().int(),
        receiptId: z.string().optional(),
        authorRunId: z.string().optional(),
        verifierRunId: z.string().optional(),
        verdict: z.string().optional(),
        /** Optional; AGENT own-run catalog check uses principal.agentId when omitted */
        agentId: z.string().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        // Domain-owned CAS/idempotency (like sync_accounts): entityExpectedRev is the
        // *task* entity rev, not a stage_evidence revision-store row — so runMutationGate
        // entity CAS cannot be used without dual-meaning the same field.
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId,
          checkPinHash: true,
        })
        const byRunId = String(args.byRunId ?? '')
        if (!byRunId) {
          throw new McpMutationError('INVALID_INPUT', 'submit_stage_evidence requires byRunId')
        }
        // Pre-idempotency: missing/foreign run must not open slots or bump board.
        const storage = createProductLifecycleV3Storage(boardId)
        const run = await storage.getRun(boardId, byRunId)
        if (!run || !run.registered) {
          throw new McpMutationError(
            'RUN_NOT_REGISTERED',
            `byRunId ${byRunId} is not a registered run on board ${boardId}`,
            { boardId, byRunId },
          )
        }
        if (principal?.role === 'AGENT') {
          authorizePersistedRunOwner(principal, run.agentId)
        }
        const toStageRaw = String(args.toStage ?? '')
        if (!isV3LifecycleStageKey(toStageRaw)) {
          throw new McpMutationError(
            'UNKNOWN_STAGE',
            `unknown V3 stage: ${toStageRaw}. Rail: ${V3_LIFECYCLE_RAIL.join(' → ')}`,
            { toStage: toStageRaw },
          )
        }
        const taskHash = String(args.taskHash ?? '').trim()
        if (!taskHash) {
          throw new McpMutationError('INVALID_INPUT', 'submit_stage_evidence requires taskHash')
        }
        const taskId = String(args.taskId ?? '')
        if (!taskId) {
          throw new McpMutationError('INVALID_INPUT', 'submit_stage_evidence requires taskId')
        }
        const expectedLifecycleRev =
          typeof args.expectedLifecycleRev === 'number' && Number.isInteger(args.expectedLifecycleRev)
            ? args.expectedLifecycleRev
            : env.expectedBoardRev
        const receiptId =
          typeof args.receiptId === 'string' && args.receiptId.trim()
            ? args.receiptId.trim()
            : undefined

        const ctx = resolveMcpRuntimeContext()
        const requestBody = { ...args, boardId }
        const begin = await beginIdempotent(ctx.idempotency, {
          scope: {
            actorId: actorIdOf(),
            boardId,
            endpoint: 'submit_stage_evidence',
            key: env.idempotencyKey,
          },
          requestBody,
          nowMs: ctx.clock.nowMs(),
        })
        if (begin.kind === 'REPLAY' && begin.record) {
          const prior = begin.record.responseBody
          if (prior === null || typeof prior !== 'object') {
            throw new McpMutationError(
              'DATA_INTEGRITY',
              'idempotent replay body is not an object',
              { toolName: 'submit_stage_evidence', boardId },
            )
          }
          return jsonText({ ...(prior as Record<string, unknown>), replayed: true })
        }

        try {
          const body = await ctx.atomic.withBoardLock(boardId, async () => {
            const board = await ctx.atomic.getBoardState(boardId)
            if (board.boardRev !== env.expectedBoardRev) {
              throw new McpMutationError(
                STALE_REVISION,
                `board rev mismatch: expected ${env.expectedBoardRev}, current ${board.boardRev}`,
                {
                  expectedBoardRev: env.expectedBoardRev,
                  currentBoardRev: board.boardRev,
                  boardId,
                },
              )
            }
            // Domain validates product pin + task entity/hash and inserts only after checks.
            // Board rev is CAS-checked but NOT advanced here: stage evidence is an immutable
            // registry receipt bound to the current pin; advance_task owns board/lifecycle rev
            // progression. Exact key/request replay (outer idem) returns prior body without
            // re-insert; same receiptId+hash domain replay sets created:false (no duplicate).
            const entry = await submitStageEvidenceProduct(boardId, {
              taskId,
              toStage: toStageRaw,
              byRunId,
              fields: (args.fields as Record<string, unknown> | undefined) ?? {},
              taskHash,
              canonicalHash: env.subjectHash,
              boardRev: env.expectedBoardRev,
              lifecycleRev: expectedLifecycleRev,
              entityExpectedRev: env.entityExpectedRev,
              receiptId,
              authorRunId: typeof args.authorRunId === 'string' ? args.authorRunId : null,
              verifierRunId: typeof args.verifierRunId === 'string' ? args.verifierRunId : null,
              verdict: typeof args.verdict === 'string' ? args.verdict : null,
            })
            return {
              ok: true as const,
              boardId,
              taskId: entry.taskId,
              toStage: entry.toStage,
              receiptId: entry.receipt.receiptId,
              receiptHash: entry.receipt.receiptHash,
              programmatic: entry.receipt.programmatic,
              emittingRunId: entry.emittingRunId,
              registeredAt: entry.registeredAt,
              created: entry.created,
              boardRev: board.boardRev,
              boundBoardRev: entry.receipt.boardRev,
              lifecycleRev: entry.receipt.lifecycleRev,
              taskHash: entry.receipt.taskHash,
              canonicalHash: entry.receipt.canonicalHash,
              entityExpectedRev: env.entityExpectedRev,
              idempotencyKey: env.idempotencyKey,
            }
          })
          await completeIdempotent(ctx.idempotency, begin.scopeHash, 200, body, begin.requestHash)
          return jsonText(body)
        } catch (e) {
          try {
            await ctx.idempotency.delete(begin.scopeHash)
          } catch {
            /* ignore cleanup */
          }
          if (e instanceof IdempotencyError) {
            throw new McpMutationError(e.code, e.message)
          }
          throw e
        }
      } catch (e) {
        return jsonText(typedError(e))
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
        const [accountSnapshot, durableRuns, boardState, classificationSyncRevision] = await Promise.all([
          sharedAccountStore().get(id),
          sharedRunStore().list(id),
          sharedAtomic().getBoardState(id),
          resolveMcpRuntimeContext().revisions.getEntity({
            boardId: id,
            entityType: 'classification_sync',
            entityId: id,
          }),
        ])
        const controlPlane = {
          capabilities: CP0_CONTROL_PLANE_CAPABILITIES,
          hierarchy: {
            l0: durableRuns.filter((r) => r.hierarchyLevel === 'L0').length,
            l1: durableRuns.filter((r) => r.hierarchyLevel === 'L1' && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'SUPERSEDED'].includes(r.state)).length,
            l2: durableRuns.filter((r) => r.hierarchyLevel === 'L2' && !['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'SUPERSEDED'].includes(r.state)).length,
          },
          sync: {
            status: boardState.dispatchBlocked ? 'TASK_MANAGER_SYNC_BLOCKED' : accountSnapshot?.stale ? 'STALE' : 'READBACK_REQUIRED',
            sourceRevision: accountSnapshot?.sourceRevision ?? null,
            generatedAt: accountSnapshot?.generatedAt ?? null,
            readbackSurfaces: accountSnapshot?.readbackSurfaces ?? null,
            effectiveBacklog: null,
            zeroBacklogProven: false,
            blocker: boardState.dispatchBlockedReason ?? null,
          },
          classificationSync: {
            entityRev: classificationSyncRevision?.entityRev ?? 0,
            subjectHash: classificationSyncRevision?.subjectHash ?? null,
          },
        }
        const data = { rollup, ...rollup, controlPlane }
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
    {
      title: 'Bulk-init task stages',
      description:
        "Bulk-seed task stages only for first stage MAPPING on a truly empty lifecycle (all tasks uninitialized), with onlyUninitialized=true and a fresh mutation envelope. Later stages require advance_task receipts. Pin-complete canonical boards forbid init_lifecycle entirely (MAPPING still needs V3 programmatic path). Legacy compatibility cannot bypass V3 safety.",
      inputSchema: {
        ...BOARD_ARG,
        stage: z.string().optional(),
        onlyUninitialized: z.boolean().optional(),
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        await assertLifecycleEvidenceBypassForbidden('init_lifecycle', boardId, args as Record<string, unknown>)
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
        'Leave a comment on a feature. Author attribution is the authenticated principal (request author/authorType are ignored).',
      inputSchema: {
        ...BOARD_ARG,
        featureId: z.string(),
        /** @deprecated ignored — attribution is authenticated principal only */
        author: z.string().optional(),
        text: z.string().min(1),
        /** @deprecated ignored — authorType is authenticated principal only */
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
            // Principal attribution only — never request author / authorType spoof.
            const { author, authorType } = commentAttributionFromPrincipal(principal)
            await addComment(boardId, args.featureId, author, authorType, args.text)
            return {
              ok: true as const,
              featureId: args.featureId,
              author,
              authorType,
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
      const [model, durableAudit] = await Promise.all([
        modelOf(id),
        readAudit(id, { limit: 200 }),
      ])
      const classificationActivity = projectClassificationSyncAuditActivity(
        durableAudit,
        pin.generatedAt,
      )
      const activity = [...model.activity, ...classificationActivity]
      const mapped = activity.map((a, idx) => {
        const ts = a.ts || pin.generatedAt
        const subjectId =
          ('featureId' in a && typeof a.featureId === 'string' ? a.featureId : null) ??
          ('projectId' in a && typeof a.projectId === 'string' ? a.projectId : null) ??
          ('auditId' in a && typeof a.auditId === 'string' ? a.auditId : null) ??
          idx
        return {
          ...a,
          id: `${ts}#${a.kind ?? 'event'}#${subjectId}`,
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
        // No-pin path: still overlay durable V3 stages so list matches advance authority.
        const [lifecycleByTaskId, cfg, m] = await Promise.all([
          loadLifecycleTaskOverlay(id0),
          readLifecycle(id0),
          modelOf(id0),
        ])
        let tasks = [...lifecycleByTaskId.values()]
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
        mapped = tasks.map((t) => {
          const st = t.lifecycleStage ?? null
          return {
            id: t.id,
            title: t.title,
            projectId: t.projectId ?? null,
            phase: t.phase ?? null,
            scope: t.scope ?? null,
            lifecycleStage: st,
            readinessPercent: stageReadiness(cfg, st),
            nextGate: nextStage(cfg, st)?.key ?? null,
            nextEvidence: nextEvidence(cfg, st),
            blockedReason: t.blockedReason ?? null,
            lastReceiptAt: t.lastReceiptAt ?? null,
            ...runInfo(m.runsByTask[t.id]),
            done: (t.checkpoints ?? []).filter((c) => c.done).length,
            total: (t.checkpoints ?? []).length,
            deps: (t.dependencies ?? []).length,
            derivedDone: deriveCheckpoints(stageReadiness(cfg, st), t.checkpoints ?? []).done,
            createdAt: t.updated ?? t.lastReceiptAt ?? pin.generatedAt,
          }
        })
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
        // lifecycleByTaskId already prefers durable V3 stage (loadLifecycleTaskOverlay).
        const overlay = lifecycleByTaskId.get(taskId)
        let stage = overlay?.lifecycleStage ?? null
        let rev = 0
        let blockedReason = overlay?.blockedReason ?? null
        let lastReceiptAt = overlay?.lastReceiptAt ?? null
        try {
          const lc = await taskLifecycle(bd, taskId)
          if (lc) {
            // Legacy rev for dual-write CAS; stage only if overlay had no V3/legacy value.
            rev = lc.rev ?? 0
            if (stage == null && lc.stage != null) stage = lc.stage
            const hist =
              (
                lc.lifecycle as {
                  history?: Array<{ ts?: string; blocker?: string | null }>
                } | null
              )?.history ?? []
            const last = hist[hist.length - 1]
            if (blockedReason == null && last?.blocker != null) blockedReason = last.blocker
            if (lastReceiptAt == null && last?.ts) lastReceiptAt = last.ts
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
      const [cfg, lc, m, v3Map] = await Promise.all([
        readLifecycle(bd),
        taskLifecycle(bd, taskId),
        modelOf(bd),
        loadDurableLifecycleV3TaskStates(bd),
      ])
      const v3 = v3Map.get(taskId)
      // Durable V3 stage wins when present (same as advance / list overlay).
      const stage =
        v3 != null ? ((v3.stage as string | null | undefined) ?? null) : (lc?.stage ?? null)
      const hist =
        v3 && Array.isArray(v3.history)
          ? v3.history
          : ((lc?.lifecycle as { history?: Array<{ ts?: string; blocker?: string | null }> } | null)
              ?.history ?? [])
      const last = hist[hist.length - 1] as { ts?: string; blocker?: string | null } | undefined
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
      description:
        'Durable account-sync snapshot (masked only; never tokens), including the current account entityRev required for ROOT sync_accounts CAS. Cursor/pageSize filters.',
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
      // Real product MCP list_accounts service path (not raw store get + ad-hoc map).
      const statusFilter =
        'status' in filters && filters.status != null ? String(filters.status) : undefined
      const providerFilter =
        'provider' in filters && filters.provider != null
          ? String(filters.provider)
          : undefined
      const cursorFilter =
        filters.cursor != null && filters.cursor !== ''
          ? String(filters.cursor)
          : undefined
      const pageSizeFilter =
        typeof filters.pageSize === 'number' && Number.isFinite(filters.pageSize)
          ? filters.pageSize
          : undefined
      const projected = await readMcpListAccountsService({
        boardId: id,
        accounts: sharedAccountStore(),
        filters: {
          status: statusFilter,
          provider: providerFilter,
          cursor: cursorFilter,
          pageSize: pageSizeFilter,
        },
        auth: { kind: 'system' }, // secureTool already authorized account:read
      })
      const rows = (projected?.accounts ?? []) as Array<{ createdAt: string; id: string }>
      // Prefer pin-aware pagination when service did not consume board pin cursor.
      const page = paginateReadRows(rows, {
        cursor: cursorFilter,
        pageSize: pageSizeFilter,
        expectedBoardRev: pin.boardRev,
      })
      const env = buildPinnedReadEnvelope(
        boardPinToMcpReadPin(pin),
        {
          accounts: page.items,
          items: page.items,
          pageSize: page.pageSize,
          sourceRevision: projected?.sourceRevision ?? null,
          generatedAt: projected?.generatedAt ?? null,
          schema: projected?.schema ?? null,
          stale: projected?.stale ?? true,
          capacity: projected?.capacity ?? null,
          entityRev: projected?.entityRev ?? null,
        },
        { method: 'list_accounts', nextCursor: page.nextCursor },
      )
      return jsonText({
        ...env,
        accounts: page.items,
        // Compatibility top-level for runtime clients; identical to data.entityRev.
        entityRev: projected?.entityRev ?? null,
      })
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
      const [lifecycleByTaskId, m] = await Promise.all([
        loadLifecycleTaskOverlay(id),
        modelOf(id),
      ])
      rows = [...lifecycleByTaskId.values()].map((t) => ({
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
        // Pin hash required: plan.canonicalHash must match current pin.
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
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
            entityExpectedRev: env.entityExpectedRev,
            expectedBoardRev: env.expectedBoardRev,
            currentPinHash: env.currentPinHash ?? env.subjectHash,
            issuedAt: args.issuedAt,
            expiresAt: args.expiresAt,
            stage: args.stage ?? 'ACTIVE',
            items: args.items as never,
            idempotencyKey: env.idempotencyKey,
            callerRole: 'ROOT_ORCHESTRATOR',
          },
        )
        const boardAfter = await sharedAtomic().getBoardState(id)
        const notify = await notifyAccountSchedulerTrigger(id, 'WAVE_LAUNCH', {
          expectedBoardRev: boardAfter.boardRev,
          canonicalHash: args.canonicalHash ?? env.subjectHash,
          idempotencyKey: `acct-sched-wave-launch-${env.idempotencyKey}`,
          actorId: actorIdOf(),
        })
        return jsonText({ ok: true, ...result, accountSyncNotify: notify })
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
        controlPlaneVersion: z.literal(CP0_CONTROL_PLANE_VERSION).optional(),
        hierarchyLevel: z.enum(['L0', 'L1', 'L2']).optional(),
        controllerRunId: z.string().optional(),
        parentRunId: z.string().optional(),
        spawnBudgetMax: z.number().int().min(0).max(20).optional(),
        spawnAuthorizationId: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
        // AGENT: never trust request agentId — attribution from principal.
        const agentId =
          principal?.role === 'AGENT'
            ? (principal.agentId ?? '')
            : String(args.agentId ?? actorIdOf())
        if (principal?.role === 'AGENT') {
          authorizePersistedRunOwner(principal, agentId)
        }
        const deps = defaultRunDeps(id, env.expectedBoardRev)
        const canonicalHash = args.canonicalHash ?? args.subjectHash ?? env.subjectHash
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
          canonicalHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          collisionScopeLockIds: args.collisionScopeLockIds,
          initialState: args.initialState,
          actorRole: principal?.role ?? 'AGENT',
          controlPlaneVersion: args.controlPlaneVersion,
          hierarchyLevel: args.hierarchyLevel,
          controllerRunId: args.controllerRunId,
          parentRunId: args.parentRunId,
          spawnBudgetMax: args.spawnBudgetMax,
          spawnAuthorizationId: args.spawnAuthorizationId,
        })
        const notify = await notifyAccountSchedulerTrigger(id, 'AGENT_LAUNCH', {
          expectedBoardRev: result.boardRev,
          canonicalHash,
          idempotencyKey: `acct-sched-register-${env.idempotencyKey}`,
          actorId: agentId,
        })
        return jsonText({
          ok: true,
          ...result,
          accountSyncNotify: notify,
        })
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
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
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
          idempotencyKey: env.idempotencyKey,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
        })
        const notify = await notifyAccountSchedulerTrigger(id, 'HEARTBEAT', {
          expectedBoardRev: result.boardRev,
          canonicalHash: env.subjectHash,
          idempotencyKey: `acct-sched-hb-${env.idempotencyKey}`,
          actorId: agentId,
        })
        let materialNotify: AccountSchedulerNotifyResult | null = null
        if (typeof args.materialProgressAt === 'string' && args.materialProgressAt.trim()) {
          materialNotify = await notifyAccountSchedulerTrigger(id, 'MATERIAL_ASSIGNMENT', {
            expectedBoardRev: result.boardRev,
            canonicalHash: env.subjectHash,
            idempotencyKey: `acct-sched-material-${env.idempotencyKey}`,
            actorId: agentId,
          })
        }
        return jsonText({
          ok: true,
          ...result,
          accountSyncNotify: notify,
          ...(materialNotify ? { materialAccountSyncNotify: materialNotify } : {}),
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureWriteTool(
    'terminate_run',
    {
      title: 'Terminate run',
      description:
        'V3 run terminal (SUCCEEDED|FAILED|CANCELLED; ROOT may also STALE|SUPERSEDED). Releases collision locks fail-closed. Full mutation envelope + fencingToken + reason required. AGENT agentId is authenticated principal / persisted owner only — not a substitute for set_run_status (legacy board runs doc).',
      inputSchema: {
        ...BOARD_ARG,
        runId: z.string(),
        agentId: z.string().optional(),
        fencingToken: z.string().min(1),
        toState: z.enum(['SUCCEEDED', 'FAILED', 'CANCELLED', 'STALE', 'SUPERSEDED']),
        reason: z.string().min(1),
        expectedEntityRev: z.number().int(),
        expectedBoardRev: z.number().int(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
        const deps = defaultRunDeps(id, env.expectedBoardRev)
        const existing = await deps.runs.get(id, args.runId)
        if (!existing) {
          throwNotFound(`run not found: ${args.runId}`, { runId: args.runId, boardId: id })
        }
        // AGENT: never trust request agentId — persisted owner + principal only.
        authorizePersistedRunOwner(principal, existing.agentId ?? null)
        const agentId =
          principal?.role === 'AGENT'
            ? (principal.agentId ?? existing.agentId)
            : String(args.agentId ?? existing.agentId)

        const toState = args.toState as TerminateToState
        const allowedToStates: ReadonlyArray<string> =
          principal?.role === 'ROOT_ORCHESTRATOR'
            ? ROOT_TERMINATE_TO_STATES
            : AGENT_TERMINATE_TO_STATES
        if (!allowedToStates.includes(toState)) {
          throw new McpMutationError(
            'INVALID_INPUT',
            `toState ${toState} not allowed for role ${principal?.role ?? 'unknown'} (AGENT: SUCCEEDED|FAILED|CANCELLED; ROOT may also STALE|SUPERSEDED)`,
            { toState, role: principal?.role ?? null },
          )
        }

        const result = await terminateRun(deps, {
          boardId: id,
          runId: args.runId,
          agentId,
          fencingToken: args.fencingToken,
          toState,
          reason: args.reason,
          expectedEntityRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          idempotencyKey: env.idempotencyKey,
        })
        const historyTail =
          result.history.length > 0 ? result.history[result.history.length - 1] : null
        return jsonText({
          ok: true,
          runId: result.runId,
          state: result.state,
          entityRev: result.entityRev,
          boardRev: result.boardRev,
          fencingToken: result.fencingToken,
          historyTail,
          replayed: result.replayed,
          terminalAck: result.terminalAck ?? null,
          releaseAck: result.releaseAck ?? null,
        })
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
        'ROOT account:sync — masked accounts only; never tokens. Full mutation envelope required. Actor from principal. trigger is exact enum (includes WAVE_CLOSE).',
      inputSchema: {
        ...BOARD_ARG,
        sourceRevision: z.number().int(),
        expectedBoardRev: z.number().int(),
        generatedAt: z.string().optional(),
        accounts: z.array(z.record(z.string(), z.any())),
        idempotencyKey: z.string().min(1),
        trigger: ACCOUNT_SYNC_TRIGGER_Z.optional(),
        genuineReadyPacketCount: z.number().int().min(0).optional(),
        health: z
          .object({
            cpuPercent: z.number(),
            memAvailableGiB: z.number().optional(),
            observedWorkerRssP95MiB: z.number().optional(),
            cpuOver95Samples: z.number().int().optional(),
            hostLoad1m: z.number().optional(),
            pidCount: z.number().int().optional(),
            acceptedTerminalYieldPercent: z.number().optional(),
            missingHeartbeatPercent: z.number().optional(),
            infrastructureFailurePercent: z.number().optional(),
            collisionDetected: z.boolean().optional(),
          })
          .optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
        const sanitized = (args.accounts as Array<Record<string, unknown>>).map((a) => {
          const copy = { ...a }
          for (const k of Object.keys(copy)) {
            if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
              delete copy[k]
            }
          }
          return copy
        })
        const statusList = sanitized.map((a) => String((a as { status?: unknown }).status ?? ''))
        const inferred = inferAccountSyncTriggerFromStatuses(statusList, 'ORCHESTRATOR_LAUNCH')
        // Schema is exact enum; still validate closed set before domain cast.
        let trigger: AccountSyncTrigger = inferred
        if (typeof args.trigger === 'string' && args.trigger) {
          const parsed = ACCOUNT_SYNC_TRIGGER_Z.safeParse(args.trigger)
          if (!parsed.success) {
            throw new McpMutationError(
              'INVALID_INPUT',
              `sync_accounts.trigger must be one of: ${ACCOUNT_SYNC_TRIGGER_VALUES.join(', ')}`,
              { trigger: args.trigger },
            )
          }
          trigger = parsed.data
        }
        const baseReq = {
          boardId: id,
          sourceRevision: args.sourceRevision,
          generatedAt: args.generatedAt ?? new Date().toISOString(),
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          accounts: sanitized as never,
          trigger,
          idempotencyKey: env.idempotencyKey,
          callerRole: 'ROOT_ORCHESTRATOR' as const,
          actorId: actorIdOf(),
          genuineReadyPacketCount: args.genuineReadyPacketCount,
          health: args.health,
        }
        // Shared scheduler is required for multi-surface publication + SLA parity.
        // Never fall back to raw syncAccounts (that resets readbackSurfaces to null
        // and publishes unverified parity as if surfaces had caught up).
        const { peekAccountSyncScheduler } = await import('#/server/control-plane-runtime-context')
        const sched = peekAccountSyncScheduler()
        if (!sched) {
          throw new McpMutationError(
            'ACCOUNT_SYNC_SCHEDULER_MISSING',
            'account sync scheduler not installed on runtime context — refuse unverified parity publish',
            { boardId: id, trigger, failClosed: true },
          )
        }
        const out = await sched.enqueue({
          ...baseReq,
          accounts: sanitized as never,
        })
        if (!out.result) {
          throw new McpMutationError(
            'ACCOUNT_SYNC_STALE',
            `scheduler enqueue did not publish (${out.kind})`,
            { kind: out.kind, trigger, boardId: id },
          )
        }
        const result = out.result
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
          trigger,
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
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
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
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          idempotencyKey: env.idempotencyKey,
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
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
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
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          idempotencyKey: env.idempotencyKey,
        })
        const boardAfter = await sharedAtomic().getBoardState(id)
        let requeueNotify: AccountSchedulerNotifyResult | null = null
        const requeueCount =
          result && typeof result === 'object' && 'counts' in result
            ? Number((result as { counts?: { REQUEUE?: number } }).counts?.REQUEUE ?? 0)
            : 0
        if (requeueCount > 0) {
          requeueNotify = await notifyAccountSchedulerTrigger(id, 'REQUEUE', {
            expectedBoardRev: boardAfter.boardRev,
            canonicalHash: env.subjectHash,
            idempotencyKey: `acct-sched-requeue-${env.idempotencyKey}`,
            actorId: leaderId,
          })
        }
        return jsonText({
          ok: true,
          boardId: id,
          ...result,
          ...(requeueNotify ? { accountSyncNotify: requeueNotify } : {}),
        })
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
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
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
          entityExpectedRev: env.entityExpectedRev,
          expectedBoardRev: env.expectedBoardRev,
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          idempotencyKey: env.idempotencyKey,
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
        // Envelope first (fail closed on missing fields) + current pin hash.
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
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
          canonicalHash: env.subjectHash,
          currentPinHash: env.currentPinHash ?? env.subjectHash,
          idempotencyKey: env.idempotencyKey,
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
        action: z.enum(['ACQUIRE_OR_RENEW', 'RELEASE']).optional(),
        pathspec: z.string().optional(),
        pathspecs: z.array(z.string()).optional(),
        checkpointId: z.string().optional(),
        rootAcceptanceId: z.string().optional(),
        repoId: z.string().optional(),
        trackingBranch: z.string().optional(),
        runId: z.string().optional(),
        integratorModel: z.string().optional(),
        fencingToken: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId: id,
          checkPinHash: true,
        })
        if (args.action === 'RELEASE') {
          if (!args.repoId || !args.trackingBranch || !args.runId || !args.fencingToken) {
            throw new McpMutationError(
              'INVALID_INPUT',
              'integration_lock RELEASE requires repoId, trackingBranch, runId, and fencingToken',
            )
          }
          const existing = await sharedLocks().getIntegration(id, args.repoId, args.trackingBranch)
          if (!existing) throwNotFound('integration lock not found', { repoId: args.repoId })
          enforceIntegratorLockBounds(principal, {
            checkpointId: existing.checkpointId,
            pathspecs: existing.pathspecs,
          })
          const begin = await beginIdempotent(sharedIdempotency(), {
            scope: { actorId: actorIdOf(), boardId: id, endpoint: 'integration_lock_release', key: env.idempotencyKey },
            requestBody: {
              repoId: args.repoId,
              trackingBranch: args.trackingBranch,
              runId: args.runId,
              fencingToken: args.fencingToken,
              expectedBoardRev: env.expectedBoardRev,
              entityExpectedRev: env.entityExpectedRev,
              canonicalHash: env.subjectHash,
            },
            nowMs: systemClock().nowMs(),
          })
          if (begin.kind === 'REPLAY' && begin.record) return jsonText(begin.record.responseBody)
          const { releaseIntegrationLock } = await import('#/server/locks')
          const released = await releaseIntegrationLock(sharedLocks(), systemClock(), {
            boardId: id,
            repoId: args.repoId,
            trackingBranch: args.trackingBranch,
            runId: args.runId,
            fencingToken: args.fencingToken,
          })
          const boardRev = await sharedAtomic().bumpBoardRev(id)
          const ack = {
            version: CP0_CONTROL_PLANE_VERSION,
            ackType: 'RELEASE',
            ackId: `ack-${createHash('sha256').update(`release\0${released.lockId}\0${released.entityRev}\0${boardRev}`).digest('hex').slice(0, 32)}`,
            lockId: released.lockId,
            entityRev: released.entityRev,
            boardRev,
          }
          const body = { ok: true, action: 'RELEASE', released, releaseAck: ack, replayed: false }
          await completeIdempotent(sharedIdempotency(), begin.scopeHash, 200, body, begin.requestHash)
          return jsonText(body)
        }
        const pathspecs: Array<string> =
          args.pathspecs ?? (args.pathspec ? [args.pathspec] : [])
        if (!pathspecs.length || !args.checkpointId || !args.rootAcceptanceId) {
          throw new McpMutationError(
            'INVALID_INPUT',
            'integration_lock requires rootAcceptanceId, checkpointId, and pathspec(s) — fail closed',
          )
        }
        // Principal checkpoint/pathspec bounds (INTEGRATOR fail-closed; missing bindings denied).
        enforceIntegratorLockBounds(principal, {
          checkpointId: args.checkpointId,
          pathspecs,
        })
        const { acquireIntegrationLock } = await import('#/server/locks')
        const result = await acquireIntegrationLock(
          sharedLocks(),
          systemClock(),
          {
            boardId: id,
            repoId: args.repoId ?? id,
            trackingBranch: args.trackingBranch ?? 'main',
            runId: args.runId ?? `int-${Date.now()}`,
            agentId: actorIdOf(),
            integratorModel: args.integratorModel ?? 'grok-4.5',
            rootAcceptanceId: args.rootAcceptanceId,
            checkpointId: args.checkpointId,
            pathspecs,
            entityExpectedRev: env.entityExpectedRev,
            expectedBoardRev: env.expectedBoardRev,
            canonicalHash: env.subjectHash,
            currentPinHash: env.currentPinHash ?? env.subjectHash,
            idempotencyKey: env.idempotencyKey,
          },
          { atomic: sharedAtomic(), idempotency: sharedIdempotency() },
        )
        // Post-mutation board rev (never pre-bump env.expectedBoardRev).
        const boardAfter = await sharedAtomic().getBoardState(id)
        const notify = await notifyAccountSchedulerTrigger(id, 'INTEGRATION_CHECKPOINT', {
          expectedBoardRev: boardAfter.boardRev,
          canonicalHash: env.subjectHash,
          idempotencyKey: `acct-sched-int-${env.idempotencyKey}`,
          actorId: actorIdOf(),
        })
        return jsonText({
          ok: true,
          boardId: id,
          pathspecs,
          locked: true,
          fencingToken: result.fencingToken,
          lockId: result.lockId,
          state: result.state,
          entityRev: result.entityRev,
          boardRev: boardAfter.boardRev,
          accountSyncNotify: notify,
        })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )


  // ---- owner humanDisplay (persistence + MCP authoring / independent review) ----
  const HUMAN_DISPLAY_COPY_SCHEMA = {
    title: z.string(),
    outcome: z.string(),
    why: z.string().optional(),
    whyItMatters: z.string().optional(),
    current: z.string().optional(),
    currentState: z.string().optional(),
    remaining: z.string().optional(),
    remainingWork: z.string().optional(),
    next: z.string().optional(),
    nextAction: z.string().optional(),
    blocker: z.string().optional(),
    blockerSummary: z.string().optional(),
    doneWhen: z.string(),
    ownerAction: z.string(),
    parentFeatureTitle: z.string().optional(),
    businessArea: z.string().optional(),
    actor: z.string().optional(),
    sourceHash: z.string(),
    locale: z.string().optional(),
    reviewStatus: z
      .enum([
        'REVIEWED',
        'GENERATED_NEEDS_REVIEW',
        'BLOCKED_MISSING_SOURCE',
        'CONFLICT',
        'CONTENT_REVIEW_REQUIRED',
      ])
      .optional(),
    reviewedAt: z.string().nullable().optional(),
    contentVersion: z.number().int().optional(),
    schemaVersion: z.string().optional(),
    snapshotId: z.string().nullable().optional(),
    boardRev: z.number().int().nullable().optional(),
    lifecycleRev: z.number().int().nullable().optional(),
    displayCanonicalHash: z.string().optional(),
    contentCanonicalHash: z.string().optional(),
    pinCanonicalHash: z.string().optional(),
    citations: z
      .array(
        z.object({
          field: z.string(),
          path: z.string(),
          note: z.string().optional(),
        }),
      )
      .optional(),
    acceptanceLinks: z
      .array(
        z.object({
          id: z.string().optional(),
          path: z.string(),
          summary: z.string().optional(),
        }),
      )
      .optional(),
    missionQuestionLinks: z
      .array(
        z.object({
          questionId: z.string(),
          field: z.string().optional(),
          note: z.string().optional(),
        }),
      )
      .optional(),
  } as const

  secureWriteTool(
    'upsert_human_display',
    {
      title: 'Upsert owner humanDisplay',
      description:
        'Author or independently review versioned owner-facing humanDisplay for a task/project/feature. Authoring writes may only set reviewStatus=GENERATED_NEEDS_REVIEW (or fail-closed non-REVIEWED statuses). Transition to REVIEWED requires a separate call by a different actor and different role than the author (ART independent review). Domain-owned CAS: entityExpectedRev is humanDisplay entity_rev (0 when absent); expectedBoardRev + canonicalHash bind the live board pin. Writes control_plane_human_display + immutable audit. Not a definition-graph mutator.',
      inputSchema: {
        ...BOARD_ARG,
        entityKind: z.enum(['task', 'project', 'feature']),
        entityId: z.string(),
        ...HUMAN_DISPLAY_COPY_SCHEMA,
      },
    },
    async (args) => {
      const boardId = await bid(args.boardId)
      try {
        // Domain-owned CAS/idempotency (like submit_stage_evidence): humanDisplay
        // entity_rev lives on control_plane_human_display, not the generic revisions store.
        const env = await assertMutationEnvelopeOrThrow(args as Record<string, unknown>, {
          boardId,
          checkPinHash: true,
        })
        const display = parseHumanDisplayV1FromMcpArgs(args as Record<string, unknown>)
        const actorId = actorIdOf()
        const actorRole = principal?.role ?? 'UNKNOWN'
        const store = sharedHumanDisplayStore()
        const ctx = resolveMcpRuntimeContext()
        const requestBody = { ...args, boardId }
        const begin = await beginIdempotent(ctx.idempotency, {
          scope: {
            actorId,
            boardId,
            endpoint: 'upsert_human_display',
            key: env.idempotencyKey,
          },
          requestBody,
          nowMs: ctx.clock.nowMs(),
        })
        if (begin.kind === 'REPLAY' && begin.record) {
          const prior = begin.record.responseBody
          if (prior === null || typeof prior !== 'object') {
            throw new McpMutationError(
              'DATA_INTEGRITY',
              'idempotent replay body is not an object',
              { toolName: 'upsert_human_display', boardId },
            )
          }
          return jsonText({ ...(prior as Record<string, unknown>), replayed: true })
        }

        try {
          const body = await ctx.atomic.withBoardLock(boardId, async () => {
            const board = await ctx.atomic.getBoardState(boardId)
            if (board.boardRev !== env.expectedBoardRev) {
              throw new McpMutationError(
                STALE_REVISION,
                `board rev mismatch: expected ${env.expectedBoardRev}, current ${board.boardRev}`,
                {
                  expectedBoardRev: env.expectedBoardRev,
                  currentBoardRev: board.boardRev,
                  boardId,
                },
              )
            }

            const existingGet = await store.get(boardId, display.entityKind, display.entityId)
            const existing = existingGet.record
            const audits = await store.listAudit(boardId)
            const previousAuthor = resolveHumanDisplayPreviousAuthor(
              audits,
              display.entityKind,
              display.entityId,
            )
            try {
              assertHumanDisplayWriteTransition({
                display,
                existing,
                actorId,
                actorRole,
                previousAuthor,
              })
            } catch (e) {
              mapHumanDisplayPersistenceError(e)
            }

            // HD row board_rev pin CAS (0 when no row) — distinct from live board rev above.
            const expectedHdBoardRev = existing?.boardRev ?? 0
            const put = await store.put({
              boardId,
              display,
              expectedEntityRev: env.entityExpectedRev,
              expectedBoardRev: expectedHdBoardRev,
              expectedSourceHash: display.sourceHash,
              actorId,
              actorRole,
            })
            if (!put.ok) {
              throw new McpMutationError(put.code, put.message, {
                ...put.details,
                currentEntityRev: put.current?.entityRev ?? null,
                currentBoardRevPin: put.current?.boardRev ?? null,
              })
            }

            // Advance live board rev only on non-replay durable write (surface freshness).
            if (!put.replayed) {
              await ctx.atomic.bumpBoardRev(boardId)
            }
            const boardAfter = await ctx.atomic.getBoardState(boardId)
            return {
              ok: true as const,
              boardId,
              entityKind: put.record.entityKind,
              entityId: put.record.entityId,
              contentVersion: put.record.contentVersion,
              reviewStatus: put.record.reviewStatus,
              sourceHash: put.record.sourceHash,
              contentHash: put.record.contentHash,
              entityRev: put.record.entityRev,
              boardRevPin: put.record.boardRev,
              boardRev: boardAfter.boardRev,
              auditId: put.auditId,
              replayed: put.replayed,
              record: put.record,
            }
          })
          await completeIdempotent(ctx.idempotency, begin.scopeHash, 200, body, begin.requestHash)
          return jsonText(body)
        } catch (e) {
          try {
            await ctx.idempotency.delete(begin.scopeHash)
          } catch {
            /* ignore cleanup */
          }
          if (e instanceof IdempotencyError) {
            throw new McpMutationError(e.code, e.message)
          }
          if (e instanceof HumanDisplayPersistenceError) {
            throw new McpMutationError(e.code, e.message, { ...e.details })
          }
          throw e
        }
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )

  secureTool(
    'get_human_display',
    {
      title: 'Get owner humanDisplay',
      description:
        'Read versioned owner humanDisplay for one entity (task/project/feature). Missing/stale/unreviewed fails closed to CONTENT_REVIEW_REQUIRED (no technical title as owner primary). Optional liveSourceHash / pin fields for freshness evaluation.',
      inputSchema: {
        ...BOARD_ARG,
        entityKind: z.enum(['task', 'project', 'feature']),
        entityId: z.string(),
        liveSourceHash: z.string().optional(),
      },
    },
    async (rawArgs) => {
      try {
        const boardId = await bid(rawArgs.boardId as string | undefined)
        const entityKindRaw = String(rawArgs.entityKind ?? '')
        if (!(HUMAN_DISPLAY_ENTITY_KINDS as readonly string[]).includes(entityKindRaw)) {
          throw new McpMutationError(
            'INVALID_INPUT',
            `entityKind must be one of: ${HUMAN_DISPLAY_ENTITY_KINDS.join(', ')}`,
          )
        }
        const entityKind = entityKindRaw as HumanDisplayEntityKind
        const entityId = nonEmptyString(rawArgs.entityId, 'entityId')
        const store = sharedHumanDisplayStore()
        const liveSourceHash =
          typeof rawArgs.liveSourceHash === 'string' && rawArgs.liveSourceHash.trim()
            ? rawArgs.liveSourceHash.trim()
            : null
        // When liveSourceHash is supplied, evaluate freshness against it only.
        // Full pin bindings are on the stored record; do not demote with a mismatched
        // live board pin boardRev/snapshot from envelope when caller only asked hash.
        const got = await store.get(
          boardId,
          entityKind,
          entityId,
          liveSourceHash ? { liveSourceHash } : null,
        )
        const data = {
          ok: true as const,
          boardId,
          entityKind,
          entityId,
          record: got.record,
          evaluation: got.evaluation,
          primary: got.primary,
          blockedShell: got.blockedShell,
          effectiveReviewStatus: got.effectiveReviewStatus,
          contentReviewRequired: got.contentReviewRequired,
        }
        return jsonText(await pinnedEnvelopeFromBoard(boardId, data))
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
