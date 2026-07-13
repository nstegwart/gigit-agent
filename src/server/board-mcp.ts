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
  readOps,
  readProd,
  readTask,
  readTasks,
  replaceAccounts,
  replaceBoardSnapshot,
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
  authErrorEnvelope,
  authorizeToolCall,
  isToolListable,
  type AuthMechanismState,
  type Principal,
} from '#/server/rbac'
import {
  createMemoryPublicSnapshotStore,
  materializePublicSnapshot,
} from '#/server/public-snapshot'
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
  createMemoryRunRegistryStore,
  type RunRegistryDeps,
  type RunRegistryStore,
} from '#/server/run-registry'
import {
  createMemoryControlPlaneAtomicStore,
  createSystemClock,
  type ControlPlaneAtomicStore,
  type ControlPlaneClock,
} from '#/server/board-store'
import { createMemoryIdempotencyStorage, type IdempotencyStorage } from '#/server/idempotency'
import { createMemoryLockStore, type LockStore } from '#/server/locks'
import {
  evaluateCapacityPolicy,
  syncAccounts,
  getSharedAccountSyncStore,
  setSharedAccountSyncStore,
  type AccountSyncStore,
  type AccountSyncDeps,
} from '#/server/account-sync'
import {
  openDecisionV3,
  resolveDecisionV3,
  createMemoryDecisionV3Store,
  type DecisionV3Store,
  type DecisionV3Deps,
} from '#/server/decisions-v3'
import {
  dryRunReconcile,
  applyReconcile,
  claimReconcilerLeadership,
  createMemoryReconcilerStore,
  type ReconcilerStore,
  type ReconcilerDeps,
} from '#/server/reconciler'
import { loadPublicAggregation } from '#/routes/api.public-snapshot'
import { evaluateG5, G5_REQUIRED_DOMAINS } from '#/server/g5'
import type { PinnedRevisionTuple } from '#/lib/control-plane-types'

export interface McpAuthContext {
  principal: Principal | null
  mechanism: AuthMechanismState
  bearerPresent: boolean
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
 * In-process control-plane deps for V3 MCP writes.
 * Tests inject via setters. Missing capacity always fail-closed (BLOCKED/zero).
 * Durable external stores may replace these; absent capacity/config → Decision/blocker, not success stubs.
 */
let mcpRunDeps: RunRegistryDeps | null = null
/** Process-wide run registry store for default (non-injected) MCP run deps. */
let mcpRunStore: RunRegistryStore | null = null
let mcpDecisionStore: DecisionV3Store | null = null
let mcpReconcilerStore: ReconcilerStore | null = null
let mcpAtomic: ControlPlaneAtomicStore | null = null
let mcpLocks: LockStore | null = null
let mcpIdempotency: IdempotencyStorage | null = null
const publicSnapStore = createMemoryPublicSnapshotStore()

export function setMcpRunRegistryDeps(deps: RunRegistryDeps | null): void {
  mcpRunDeps = deps
}
/** Wire MCP publish/get_next to the process-wide shared plan store (same as board getNextFn). */
export function setMcpPlanStore(store: DispatchPlanStore | null): void {
  setSharedDispatchPlanStore(store)
}
/**
 * Wire MCP sync_accounts / capacity to the process-wide shared account-sync store
 * (same instance as control-center-ui-adapter readLatestAccountSyncSnapshot).
 */
export function setMcpAccountStore(store: AccountSyncStore | null): void {
  setSharedAccountSyncStore(store)
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
  mcpDecisionStore = null
  mcpReconcilerStore = null
  mcpAtomic = null
  mcpLocks = null
  mcpIdempotency = null
}

function systemClock(): ControlPlaneClock {
  return createSystemClock()
}

function sharedAtomic(seedBoardId?: string, boardRev = 0): ControlPlaneAtomicStore {
  if (mcpAtomic) return mcpAtomic
  mcpAtomic = createMemoryControlPlaneAtomicStore(
    seedBoardId
      ? [{ boardId: seedBoardId, boardRev, dispatchBlocked: false, dispatchBlockedReason: null }]
      : [],
  )
  return mcpAtomic
}

function sharedLocks(): LockStore {
  if (mcpLocks) return mcpLocks
  mcpLocks = createMemoryLockStore()
  return mcpLocks
}

function sharedIdempotency(): IdempotencyStorage {
  if (mcpIdempotency) return mcpIdempotency
  mcpIdempotency = createMemoryIdempotencyStorage()
  return mcpIdempotency
}

/**
 * Process-wide run registry store so register_run then heartbeat_run on the
 * default (non-injected) path see the same in-memory record.
 */
function sharedRunStore(): RunRegistryStore {
  if (mcpRunStore) return mcpRunStore
  mcpRunStore = createMemoryRunRegistryStore()
  return mcpRunStore
}

/** Sole plan store: shared with board.ts getNextFn / resolveSharedDispatchNext. */
function sharedPlanStore(): DispatchPlanStore {
  return getSharedDispatchPlanStore()
}

/**
 * Sole account-sync store: same process-wide instance as
 * getSharedAccountSyncStore / readLatestAccountSyncSnapshot (control-center UI).
 * Never creates a private MCP-only store — that split caused sourceRevision/generatedAt
 * parity failures (MCP write invisible to authenticated CC reads).
 */
function sharedAccountStore(): AccountSyncStore {
  return getSharedAccountSyncStore()
}

function sharedDecisionStore(): DecisionV3Store {
  if (mcpDecisionStore) return mcpDecisionStore
  mcpDecisionStore = createMemoryDecisionV3Store()
  return mcpDecisionStore
}

function sharedReconcilerStore(): ReconcilerStore {
  if (mcpReconcilerStore) return mcpReconcilerStore
  mcpReconcilerStore = createMemoryReconcilerStore()
  return mcpReconcilerStore
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
 * Default MCP run-registry deps. Cached process-wide so successive tool calls
 * (register_run → heartbeat_run) share the same store/deps. Injected deps via
 * setMcpRunRegistryDeps always take precedence when set.
 * Exported for unit tests of the non-injected path.
 */
export function defaultRunDeps(boardId?: string, boardRev = 0): RunRegistryDeps {
  if (mcpRunDeps) return mcpRunDeps
  const clock = systemClock()
  const atomic = sharedAtomic(boardId, boardRev)
  mcpRunDeps = {
    clock,
    runs: sharedRunStore(),
    locks: sharedLocks(),
    atomic,
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
 * Prefer domain err.code; never surface raw OS/DB/fs errno (EPERM, ENOENT, …),
 * paths, stacks, or untyped exception text as the wire code/message.
 *
 * Node libuv errno codes are `E` + letters without underscores (EPERM, ENOENT).
 * Domain codes are UPPER_SNAKE (STALE_REVISION, DATA_INTEGRITY, …) or a short
 * allowlist of single-token domain codes.
 */
const NODE_ERRNO_CODE_RE = /^E[A-Z]+$/
const SINGLE_TOKEN_DOMAIN_CODES = new Set([
  'FORBIDDEN',
  'BLOCKED',
  'CAPACITY',
  'CONFLICT',
  'UNAUTHORIZED',
])

function isStableDomainErrorCode(code: string): boolean {
  if (!code || NODE_ERRNO_CODE_RE.test(code)) return false
  if (!/^[A-Z][A-Z0-9_]*$/.test(code)) return false
  if (code.includes('_')) return true
  return SINGLE_TOKEN_DOMAIN_CODES.has(code)
}

function typedError(e: unknown): { ok: false; error: string; code: string; details?: unknown } {
  const err = e as { code?: string; message?: string; details?: unknown }
  const rawCode = typeof err?.code === 'string' ? err.code : ''
  if (rawCode && isStableDomainErrorCode(rawCode)) {
    return {
      ok: false,
      error: typeof err.message === 'string' && err.message.length > 0 ? err.message : rawCode,
      code: rawCode,
      ...(err.details !== undefined ? { details: err.details } : {}),
    }
  }
  // Unexpected internal/OS/DB/fs: stable class only — no errno, path, or raw message leak
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
 * Resolve pin from real board content hash + control-plane boardRev.
 * lifecycleRev: use a known current revision only when available; never invent non-zero.
 * Same pin identity is shared by every canonical/legacy read in a handler via this helper.
 */
async function resolveBoardPin(boardId: string): Promise<BoardPin> {
  const clock = systemClock()
  const generatedAt = clock.nowISO()
  const hash = await boardHash(boardId)
  let boardRev = 0
  try {
    const st = await sharedAtomic(boardId).getBoardState(boardId)
    boardRev = typeof st.boardRev === 'number' && Number.isFinite(st.boardRev) ? st.boardRev : 0
  } catch {
    boardRev = 0
  }
  // Durable lifecycle pin is not on the board-doc path yet — honest zero (never fabricate).
  const lifecycleRev = 0
  return {
    boardId,
    boardRev,
    lifecycleRev,
    canonicalSnapshotId: `pin-${boardId}-${hash.slice(0, 16)}`,
    canonicalHash: hash,
    generatedAt,
    freshnessAgeSeconds: 0,
    stale: false,
    staleReason: null,
  }
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


  // ---- boards ----
  secureTool(
    'list_boards',
    { title: 'List boards', description: 'List all boards (each board is its own scope).', inputSchema: {} },
    async () => jsonText({ boards: await listBoards() }),
  )
  secureTool(
    'create_board',
    { title: 'Create board', description: 'Create a new empty board.', inputSchema: { id: z.string(), name: z.string(), description: z.string().optional() } },
    async ({ id, name, description }) => {
      try {
        return jsonText({ ok: true, boards: await createBoard(id, name, description) })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )

  // ---- reads (pinned envelope; legacy top-level keys preserved) ----
  secureTool(
    'list_projects',
    { title: 'List projects', description: "List a board's projects with status, stage, progress.", inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const m = await modelOf(id)
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          projects: m.projects.map((p) => ({
            id: p.id,
            nama: p.nama,
            status: p.status,
            stage: p.stage ?? null,
            progress: p.progress,
            featureCount: p.features.length,
            activeAgents: p.activeAgents,
          })),
        }),
      )
    },
  )
  secureTool(
    'list_features',
    { title: 'List features', description: 'List features, optionally filtered by projectId and/or fase.', inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), status: z.string().optional() } },
    async ({ boardId, projectId, status }) => {
      const id = await bid(boardId)
      let features = (await modelOf(id)).features
      if (projectId) features = features.filter((f) => f.projectId === projectId)
      if (status) features = features.filter((f) => String(f.fase) === status)
      return jsonText(await pinnedEnvelopeFromBoard(id, { features: features.map(featureSummary) }))
    },
  )
  secureTool(
    'get_feature',
    { title: 'Get feature', description: 'A single feature incl checklist, runs, comments, design.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id: featureId }) => {
      const id = await bid(boardId)
      const f = (await modelOf(id)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}`, code: 'NOT_FOUND' })
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          feature: {
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
          },
        }),
      )
    },
  )
  secureTool(
    'list_runs',
    { title: 'List agent runs', description: 'List agent runs, optionally filtered by status.', inputSchema: { ...BOARD_ARG, status: z.string().optional() } },
    async ({ boardId, status }) => {
      const id = await bid(boardId)
      const runs = (await modelOf(id)).runs
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          runs: status ? runs.filter((r) => r.status === status) : runs,
        }),
      )
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

  // ---- writes ----
  secureTool(
    'toggle_task',
    { title: 'Toggle checklist task', description: 'Toggle (or set) a feature checklist task done flag.', inputSchema: { ...BOARD_ARG, featureId: z.string(), index: z.number().int(), done: z.boolean().optional() } },
    async ({ boardId, featureId, index, done }) => {
      const f = buildModel(await toggleTask(await bid(boardId), featureId, index, done)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: { ...featureSummary(f), checklist: f.checklist ?? [] } })
    },
  )
  secureTool(
    'set_feature_phase',
    { title: 'Set feature phase', description: "Set a feature's fase (phase).", inputSchema: { ...BOARD_ARG, featureId: z.string(), fase: z.string() } },
    async ({ boardId, featureId, fase }) => {
      const f = buildModel(await setFeaturePhase(await bid(boardId), featureId, fase)).featById[featureId]
      if (!f) return jsonText({ error: `feature not found: ${featureId}` })
      return jsonText({ feature: featureSummary(f) })
    },
  )
  secureTool(
    'upsert_run',
    { title: 'Register or update an agent run', description: 'The write path an agent uses to report itself. Call at launch, heartbeat, material transition, terminal verdict, and rotation. targetGate/evidencePath/verdict make the run productive on the agents board.', inputSchema: { ...BOARD_ARG, id: z.string(), agent: z.string().optional(), role: z.string().optional(), agentType: z.string().optional(), model: z.string().optional(), effort: z.string().optional(), task: z.string().optional(), feature: z.string().optional(), taskId: z.string().optional(), account: z.string().optional(), project: z.string().optional(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']).optional(), targetGate: z.string().optional(), evidencePath: z.string().optional(), verdict: z.string().optional(), note: z.string().optional() } },
    async ({ boardId, ...rest }) => {
      const patch: Parameters<typeof upsertRun>[1] = { id: rest.id }
      for (const k of ['agent', 'role', 'agentType', 'model', 'effort', 'task', 'feature', 'taskId', 'account', 'project', 'status', 'targetGate', 'evidencePath', 'verdict', 'note'] as const) {
        if (rest[k] !== undefined) (patch as Record<string, unknown>)[k] = rest[k]
      }
      const raw = await upsertRun(await bid(boardId), patch)
      return jsonText({ run: raw.runs?.find((r) => r.id === rest.id) ?? null })
    },
  )
  secureTool(
    'set_run_status',
    { title: 'Set run status', description: "Update an agent run's status.", inputSchema: { ...BOARD_ARG, id: z.string(), status: z.enum(['running', 'blocked', 'queued', 'done', 'failed']) } },
    async ({ boardId, id, status }) => {
      const raw = await setRunStatus(await bid(boardId), id, status)
      return jsonText({ run: raw.runs?.find((r) => r.id === id) ?? null })
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
  secureTool(
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
    async ({ boardId, projectId, ...patch }) => {
      try {
        const raw = await setProjectDesign(await bid(boardId), projectId, patch)
        const p = raw.projects.find((x) => x.id === projectId)
        const docs = p?.docs as Record<string, unknown> | undefined
        return jsonText({ ok: true, project: projectId, komponen: p?.komponen ?? [], arsitektur: docs?.arsitektur ?? null, baseline: docs?.baseline ?? null, pages: docs?.pages ?? null, design_foundation: p?.design_foundation ?? null, design_components: p?.design_components ?? null, design_pages: p?.design_pages ?? null })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
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
    async ({ boardId, projectId, ...komponen }) => {
      try {
        const raw = await addComponent(await bid(boardId), projectId, komponen)
        const p = raw.projects.find((x) => x.id === projectId)
        return jsonText({ ok: true, project: projectId, komponen: p?.komponen ?? [] })
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

  secureTool(
    'upsert_task',
    { title: 'Upsert a task', description: 'Create or update one first-class task (T-… id) with its full mapping. Merges into an existing task of the same id. Lifecycle state is preserved (use advance_task to move stage). Pass expectedRev (from get_task) for optimistic-lock safety against concurrent writers.', inputSchema: { ...BOARD_ARG, task: TASK_OBJ, expectedRev: z.number().int().optional() } },
    async ({ boardId, task, expectedRev }) => {
      try { return jsonText(await upsertTask(await bid(boardId), task as never, expectedRev)) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'delete_task',
    { title: 'Delete a task', description: 'Remove a first-class task by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try { return jsonText(await deleteTask(await bid(boardId), id)) } catch (e) { return asErr(e) }
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
  secureTool(
    'add_task_section',
    { title: 'Add a task section', description: 'Append one agent-defined content block ("menu") inside a task — any type/content. id auto-generated if omitted. Renders on the task detail immediately.', inputSchema: { ...BOARD_ARG, taskId: z.string(), section: SECTION_OBJ } },
    async ({ boardId, taskId, section }) => {
      try { return jsonText({ ok: true, sections: await addTaskSection(await bid(boardId), taskId, section as never) }) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'set_task_sections',
    { title: 'Set task sections', description: 'Replace ALL of a task\'s content blocks with this ordered list. Fully defines the task body.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sections: z.array(SECTION_OBJ) } },
    async ({ boardId, taskId, sections }) => {
      try { return jsonText({ ok: true, sections: await setTaskSections(await bid(boardId), taskId, sections as never) }) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'update_task_section',
    { title: 'Update a task section', description: 'Patch one section by id (title/content/collapsed/tone/…).', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string(), patch: SECTION_OBJ.partial() } },
    async ({ boardId, taskId, sectionId, patch }) => {
      try { return jsonText({ ok: true, sections: await updateTaskSection(await bid(boardId), taskId, sectionId, patch as never) }) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'remove_task_section',
    { title: 'Remove a task section', description: 'Delete one section by id.', inputSchema: { ...BOARD_ARG, taskId: z.string(), sectionId: z.string() } },
    async ({ boardId, taskId, sectionId }) => {
      try { return jsonText({ ok: true, sections: await removeTaskSection(await bid(boardId), taskId, sectionId) }) } catch (e) { return asErr(e) }
    },
  )

  secureTool(
    'upsert_feature',
    { title: 'Upsert a feature', description: 'Create or update one feature/feature-contract (checklist card). Merges into an existing feature of the same id.', inputSchema: { ...BOARD_ARG, feature: FEATURE_OBJ } },
    async ({ boardId, feature }) => {
      try { return jsonText(await upsertFeature(await bid(boardId), feature as never)) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'delete_feature',
    { title: 'Delete a feature', description: 'Remove a feature by id.', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      try { return jsonText(await deleteFeature(await bid(boardId), id)) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'set_prod',
    { title: 'Set production gates', description: 'Replace the board’s path-to-production gates (G0→G6) plus optional label/headline.', inputSchema: { ...BOARD_ARG, gates: z.array(GATE_OBJ), mockLabel: z.string().optional(), headline: z.string().optional() } },
    async ({ boardId, gates, mockLabel, headline }) => {
      try { return jsonText(await setProd(await bid(boardId), { gates: gates as never, mockLabel, headline })) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'set_guide',
    { title: 'Set board guide', description: 'Replace the board-specific guide sections.', inputSchema: { ...BOARD_ARG, sections: z.array(GUIDE_SEC) } },
    async ({ boardId, sections }) => {
      try { return jsonText(await setGuide(await bid(boardId), { sections })) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'replace_accounts',
    { title: 'Replace agent-account vault', description: 'Replace the ops agent-account vault (accounts + vault summary + alert).', inputSchema: { ...BOARD_ARG, ops: OPS_OBJ } },
    async ({ boardId, ops }) => {
      try { return jsonText(await replaceAccounts(await bid(boardId), ops as never)) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'get_board_hash',
    { title: 'Get board hash', description: 'Content hash of the 7 board collections — read it first, then pass as expectedHash to replace_board_snapshot for safe concurrent writes. Same pin identity as other canonical reads.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      try {
        const id = await bid(boardId)
        const pin = await resolveBoardPin(id)
        return jsonText(
          pinnedEnvelope(pin, {
            hash: pin.canonicalHash,
            boardId: id,
          }),
        )
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'replace_board_snapshot',
    {
      title: 'Replace board snapshot (bulk)',
      description:
        'Atomically replace whole collections in one transaction. Pass only the collections you want to sync — each provided array upserts new records and drops stale ones. Set dryRun:true to preview the before/after counts without writing. Pass expectedHash (from get_board_hash) to refuse the write if the board changed since you read it. Returns an audit receipt with before/after counts and the new hash.',
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
      },
    },
    async ({ boardId, dryRun, expectedHash, ...snap }) => {
      try {
        return jsonText(await replaceBoardSnapshot(await bid(boardId), snap as never, { dryRun, expectedHash }))
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
    { title: 'Get lifecycle rail', description: "This board's lifecycle stages + gate rules. Each board defines its own rail; read this before advance_task. Pinned envelope (legacy alias).", inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      try {
        const id = await bid(boardId)
        const lc = await readLifecycle(id)
        return jsonText(await pinnedEnvelopeFromBoard(id, { lifecycle: lc, ...lc }))
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'set_lifecycle',
    { title: 'Set lifecycle rail', description: "Fully (re)configure this board's lifecycle: ordered stages + gate rules. gated:true = reachable only via advance_task with a program-emitted receipt; verifierRole = must be passed by a run other than the implementer. allowSkip (default false) permits forward jumps; allowRegression (default true) permits moving back for repair. Each board owns its own rail.", inputSchema: { ...BOARD_ARG, stages: z.array(STAGE_OBJ).min(1), allowSkip: z.boolean().optional(), allowRegression: z.boolean().optional(), formulaVersion: z.string().optional() } },
    async ({ boardId, stages, allowSkip, allowRegression, formulaVersion }) => { try { return jsonText(await writeLifecycle(await bid(boardId), stages as never, { allowSkip, allowRegression, formulaVersion })) } catch (e) { return asErr(e) } },
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
  secureTool(
    'advance_task',
    {
      title: 'Advance task lifecycle',
      description:
        "Move a task to a stage on this board's rail. Gated stages REQUIRE a program-emitted receipt (evidence/commitSha/deployReceipt) — no manual ticking of FUNCTIONAL/PROD_READY/LIVE. A stage with a verifierRole is refused if byRunId equals the implementer (independent verification). Pass expectedRev (from get_task_lifecycle) to prevent a concurrent lost update. Every transition is written to the audit log.",
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
        expectedRev: z.number().int().optional(),
      },
    },
    async ({ boardId, id, ...inp }) => {
      try { return jsonText(await advanceTask(await bid(boardId), id, inp as never)) } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'get_rollup',
    { title: 'Get lifecycle rollup', description: 'Active task count per lifecycle stage, HOLD count (outside the active denominator), and per-project / per-feature rollup (each follows its most-behind active task). Pinned envelope (legacy alias of overview rollup).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      try {
        const id = await bid(boardId)
        const rollup = await computeRollup(id)
        return jsonText(await pinnedEnvelopeFromBoard(id, { rollup, ...rollup }))
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'list_audit',
    { title: 'List audit log', description: 'Recent audit entries (gate changes + mutations), newest first. Filter by taskId.', inputSchema: { ...BOARD_ARG, taskId: z.string().optional(), limit: z.number().int().optional() } },
    async ({ boardId, taskId, limit }) => {
      try {
        const id = await bid(boardId)
        const audit = await readAudit(id, { taskId, limit })
        return jsonText(await pinnedEnvelopeFromBoard(id, { audit }))
      } catch (e) {
        return asErr(e)
      }
    },
  )
  secureTool(
    'init_lifecycle',
    { title: 'Bulk-init task stages', description: "Set the lifecycle stage for a board's tasks in one atomic UPDATE (default = onlyUninitialized). stage defaults to the rail's first stage.", inputSchema: { ...BOARD_ARG, stage: z.string().optional(), onlyUninitialized: z.boolean().optional() } },
    async ({ boardId, stage, onlyUninitialized }) => { try { return jsonText(await initLifecycleStage(await bid(boardId), stage, onlyUninitialized ?? true)) } catch (e) { return asErr(e) } },
  )

  // ---- board / project / queue CRUD (full board management from MCP) ----
  secureTool(
    'update_board',
    { title: 'Update a board', description: "Rename a board, change its description, or set which views/tabs it shows.", inputSchema: { boardId: z.string(), name: z.string().optional(), description: z.string().optional(), views: z.array(z.string()).optional() } },
    async ({ boardId, ...patch }) => { try { return jsonText({ ok: true, boards: await updateBoard(boardId, patch) }) } catch (e) { return asErr(e) } },
  )
  secureTool(
    'delete_board',
    { title: 'Delete a board', description: 'Delete a board and ALL its data (docs, tasks, audit). Irreversible.', inputSchema: { boardId: z.string() } },
    async ({ boardId }) => { try { return jsonText({ ok: true, boards: await deleteBoard(boardId) }) } catch (e) { return asErr(e) } },
  )
  secureTool(
    'upsert_project',
    { title: 'Upsert a project', description: 'Create or update one project (merges by id). Any extra fields pass through.', inputSchema: { ...BOARD_ARG, project: z.object({ id: z.string(), nama: z.string(), status: z.string().optional() }).passthrough() } },
    async ({ boardId, project }) => {
      try {
        const raw = await upsertProject(await bid(boardId), project as never)
        const p = raw.projects.find((x) => x.id === (project as { id: string }).id)
        return jsonText({ ok: true, project: p ?? null, projects: raw.projects.map((x) => x.id) }) // full project incl. passthrough fields
      } catch (e) { return asErr(e) }
    },
  )
  secureTool(
    'delete_project',
    { title: 'Delete a project', description: 'Remove a project by id (its tasks stay; re-point or delete them separately).', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => { try { const raw = await deleteProject(await bid(boardId), id); return jsonText({ ok: true, projects: raw.projects.map((p) => p.id) }) } catch (e) { return asErr(e) } },
  )
  secureTool(
    'set_queue',
    { title: 'Set the work queue', description: 'Set the board queue (now / next feature ids + note).', inputSchema: { ...BOARD_ARG, now: z.array(z.string()).optional(), next: z.array(z.string()).optional(), catatan: z.string().optional() } },
    async ({ boardId, ...q }) => { try { const raw = await setQueue(await bid(boardId), q); return jsonText({ ok: true, queue: raw.queue ?? null }) } catch (e) { return asErr(e) } },
  )
  secureTool(
    'decide_decision',
    { title: 'Decide an open decision', description: 'Answer/close an open decision (unblocks the feature it gated).', inputSchema: { ...BOARD_ARG, id: z.string(), answer: z.string(), keputusan: z.string().optional(), decidedBy: z.string().optional() } },
    async ({ boardId, id, answer, keputusan, decidedBy }) => {
      try { const raw = await decideDecision(await bid(boardId), id, answer, keputusan, decidedBy ?? 'human'); return jsonText({ ok: true, decision: raw.decisions?.find((d) => d.id === id) ?? null }) } catch (e) { return asErr(e) }
    },
  )

  // ---- collaboration ----
  secureTool(
    'add_comment',
    { title: 'Add a comment', description: 'Leave a comment on a feature.', inputSchema: { ...BOARD_ARG, featureId: z.string(), author: z.string(), text: z.string().min(1), authorType: z.enum(['human', 'agent']).optional() } },
    async ({ boardId, featureId, author, text, authorType }) => {
      await addComment(await bid(boardId), featureId, author, authorType ?? 'agent', text)
      return jsonText({ ok: true, featureId })
    },
  )
  secureTool(
    'open_decision',
    { title: 'Open a decision', description: 'Raise a decision that needs a human (blocks the feature).', inputSchema: { ...BOARD_ARG, featureId: z.string(), question: z.string().min(1), options: z.array(z.object({ key: z.string(), label: z.string(), rekomendasi: z.boolean().optional() })).optional(), openedBy: z.string().optional() } },
    async ({ boardId, featureId, question, options, openedBy }) => {
      const raw = await openDecision(await bid(boardId), featureId, question, options, openedBy ?? 'agent')
      const d = raw.decisions?.find((x) => x.featureId === featureId && x.status === 'open')
      return jsonText({ ok: true, decision: d ?? null })
    },
  )
  secureTool(
    'set_blocked',
    { title: 'Set feature blocked', description: 'Mark a feature blocked with a reason.', inputSchema: { ...BOARD_ARG, featureId: z.string(), reason: z.string().min(1) } },
    async ({ boardId, featureId, reason }) => {
      await setBlocked(await bid(boardId), featureId, reason)
      return jsonText({ ok: true, featureId, reason })
    },
  )
  secureTool(
    'list_activity',
    { title: 'List activity', description: 'The board activity feed, newest first.', inputSchema: { ...BOARD_ARG, limit: z.number().int().optional() } },
    async ({ boardId, limit }) => {
      const id = await bid(boardId)
      const activity = (await modelOf(id)).activity.slice(0, limit ?? 30)
      return jsonText(await pinnedEnvelopeFromBoard(id, { activity }))
    },
  )

  // ---- adaptive views ----
  secureTool(
    'list_tasks',
    { title: 'List tasks', description: "List a board's first-class tasks (T-… ids) with lifecycle readiness fields (lifecycleStage, readinessPercent, nextGate, nextEvidence, assignedRunId).", inputSchema: { ...BOARD_ARG, projectId: z.string().optional(), scope: z.string().optional() } },
    async ({ boardId, projectId, scope }) => {
      const id0 = await bid(boardId)
      const [{ tasks: all }, cfg, m] = await Promise.all([readTasks(id0), readLifecycle(id0), modelOf(id0)])
      let tasks = all
      if (projectId) tasks = tasks.filter((t) => t.projectId === projectId)
      if (scope) tasks = tasks.filter((t) => t.scope === scope)
      const mapped = tasks.map((t) => ({
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
      }))
      return jsonText(await pinnedEnvelopeFromBoard(id0, { tasks: mapped }))
    },
  )
  secureTool(
    'get_task',
    { title: 'Get task', description: 'A single task incl checkpoints, deps, story, refs, PLUS lifecycle readiness (lifecycleStage, readinessPercent, nextGate, nextEvidence, assignedRunId, blockedReason, lastReceiptAt).', inputSchema: { ...BOARD_ARG, id: z.string() } },
    async ({ boardId, id }) => {
      const bd = await bid(boardId)
      const t = await readTask(bd, id)
      if (!t) return jsonText({ error: `task not found: ${id}`, code: 'NOT_FOUND' })
      const [cfg, lc, m] = await Promise.all([readLifecycle(bd), taskLifecycle(bd, id), modelOf(bd)])
      const stage = lc?.stage ?? null
      const hist =
        ((lc?.lifecycle as { history?: Array<{ ts?: string; blocker?: string | null }> } | null)?.history) ??
        []
      const last = hist[hist.length - 1]
      return jsonText(
        await pinnedEnvelopeFromBoard(bd, {
          task: {
            ...t,
            lifecycleStage: stage,
            readinessPercent: stageReadiness(cfg, stage),
            nextGate: nextStage(cfg, stage)?.key ?? null,
            nextEvidence: nextEvidence(cfg, stage),
            ...runInfo(m.runsByTask[id]),
            blockedReason: last?.blocker ?? null,
            lastReceiptAt: last?.ts ?? null,
            rev: lc?.rev ?? 0,
            derivedCheckpoints: deriveCheckpoints(stageReadiness(cfg, stage), t.checkpoints ?? []),
          },
        }),
      )
    },
  )
  secureTool(
    'list_accounts',
    { title: 'List agent accounts', description: 'The agent-account vault + accounts. Check before spawning workers. Masked fields only via ops store (never tokens).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const o = await readOps(id)
      // Strip secret-like keys from account objects before return (fail-closed redaction).
      const accounts = (o.accounts ?? []).map((a) => {
        const copy = { ...(a as unknown as Record<string, unknown>) }
        for (const k of Object.keys(copy)) {
          if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
            delete copy[k]
          }
        }
        return copy
      })
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          vault: o.vault,
          accounts,
          alert: o.alert ?? null,
        }),
      )
    },
  )
  secureTool(
    'get_prod',
    { title: 'Get production path', description: 'The path-to-production gates (G0→G6).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const prod = await readProd(id)
      return jsonText(await pinnedEnvelopeFromBoard(id, { prod, ...prod }))
    },
  )
  secureTool(
    'get_guide',
    { title: 'Get board guide', description: 'The board-specific guide + rules sections.', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const guide = await readGuide(id)
      return jsonText(await pinnedEnvelopeFromBoard(id, { guide, ...guide }))
    },
  )

  // ---- resource: the playbook ----

  // ---- Public snapshot (unauth allowlist) — same pinned aggregation as /api/public-snapshot ----
  secureTool(
    'get_public_snapshot',
    {
      title: 'Get public snapshot',
      description: 'Sanitized public board snapshot only (no private decisions/accounts/tokens).',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const existing = publicSnapStore.get(id)
      if (existing) {
        return jsonText({ ok: true, snapshot: existing.payload })
      }
      const agg = await loadPublicAggregation(id)
      if (!agg) {
        return jsonText({
          ok: false,
          error: 'public snapshot unavailable',
          code: 'STALE_OR_MISSING',
          stale: true,
        })
      }
      const mat = materializePublicSnapshot(agg)
      publicSnapStore.put(id, mat)
      return jsonText({ ok: true, snapshot: mat.payload })
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
    async ({ boardId }) => {
      const id = await bid(boardId)
      const [m, rollup, lc, planNext] = await Promise.all([
        modelOf(id),
        computeRollup(id),
        readLifecycle(id),
        selectNextFromActivePlan({ clock: systemClock(), plans: sharedPlanStore() }, id),
      ])
      const dispatchNext = projectDispatchNextFields(planNext)
      const legacyFeatureQueue = asLegacyFeatureQueue({
        now: m.queue.now.map((f) => f.id),
        next: m.queue.next.map((f) => f.id),
      })
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          projects: m.projects.length,
          features: m.features.length,
          runs: m.runs.length,
          // Control-plane NEXT only (active unexpired root-published plan)
          selectedForNextDispatch: dispatchNext.selectedForNextDispatch,
          next: dispatchNext.next,
          planId: dispatchNext.planId,
          blockedReason: dispatchNext.blockedReason,
          soleSource: dispatchNext.soleSource,
          // Legacy feature queue — not dispatch NEXT (C3 may remove visual label)
          legacyFeatureQueue,
          rollup,
          lifecycleStages: lc.stages?.length ?? 0,
        }),
      )
    },
  )
  secureTool(
    'get_work',
    {
      title: 'Get work view',
      description:
        'Tasks + control-plane NEXT membership/reason/rank + legacy feature queue (explicitly named).',
      inputSchema: { ...BOARD_ARG },
    },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const [{ tasks }, m, planNext] = await Promise.all([
        readTasks(id),
        modelOf(id),
        selectNextFromActivePlan({ clock: systemClock(), plans: sharedPlanStore() }, id),
      ])
      const dispatchNext = projectDispatchNextFields(planNext)
      const legacyFeatureQueue = asLegacyFeatureQueue({
        now: m.queue.now.map((f) => ({ id: f.id, nama: f.nama })),
        next: m.queue.next.map((f) => ({ id: f.id, nama: f.nama })),
      })
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          tasks: tasks.map((t) => ({ id: t.id, title: t.title, projectId: t.projectId ?? null })),
          selectedForNextDispatch: dispatchNext.selectedForNextDispatch,
          next: dispatchNext.next,
          planId: dispatchNext.planId,
          blockedReason: dispatchNext.blockedReason,
          soleSource: dispatchNext.soleSource,
          legacyFeatureQueue,
        }),
      )
    },
  )
  secureTool(
    'get_priority',
    { title: 'Get priority rollup', description: 'Priority portfolio surface (from rollup when present).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const rollup = await computeRollup(id)
      return jsonText(
        await pinnedEnvelopeFromBoard(id, {
          rollup,
          priority: (rollup as { priority?: unknown }).priority ?? null,
        }),
      )
    },
  )
  secureTool(
    'get_g5',
    { title: 'Get G5 domains', description: 'G5 read surface (g5Pass is read-only derived via evaluateG5).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const pin = await resolveBoardPin(id)
      // No durable G5 domain store on this edge yet → empty domain set → all required missing → g5Pass false.
      // Never invent domain PASS rows or client-writable g5Pass.
      const evaluation = evaluateG5([], pinToTuple(pin))
      return jsonText(
        pinnedEnvelope(pin, {
          g5Pass: evaluation.g5Pass,
          domainPassCount: evaluation.domainResults.filter((r) => r.pass).length,
          domainRequiredCount: G5_REQUIRED_DOMAINS.length,
          domainResults: evaluation.domainResults,
          missingDomains: evaluation.missingDomains,
        }),
      )
    },
  )
  secureTool(
    'list_decisions',
    { title: 'List decisions', description: 'Board decisions (authz: decision:read).', inputSchema: { ...BOARD_ARG } },
    async ({ boardId }) => {
      const id = await bid(boardId)
      const m = await modelOf(id)
      return jsonText(await pinnedEnvelopeFromBoard(id, { decisions: m.decisions ?? [] }))
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

  // ---- V3 control-plane writes (real C2B boundary calls; typed errors; no success stubs) ----
  secureTool(
    'publish_dispatch_plan',
    {
      title: 'Publish dispatch plan',
      description: 'ROOT_ORCHESTRATOR only. Sole NEXT source after publish.',
      inputSchema: {
        ...BOARD_ARG,
        planId: z.string(),
        planVersion: z.number().int(),
        planHash: z.string(),
        canonicalSnapshotId: z.string(),
        canonicalHash: z.string(),
        expectedBoardRev: z.number().int(),
        issuedAt: z.string(),
        expiresAt: z.string(),
        stage: z.string().optional(),
        items: z.array(z.record(z.string(), z.any())),
        idempotencyKey: z.string(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      const plans = sharedPlanStore()
      const clock = systemClock()
      const atomic = sharedAtomic(id, args.expectedBoardRev)
      const idempotency = sharedIdempotency()
      try {
        const result = await publishDispatchPlan(
          { clock, plans, atomic, idempotency },
          {
            boardId: id,
            planId: args.planId,
            planVersion: args.planVersion,
            planHash: args.planHash,
            canonicalSnapshotId: args.canonicalSnapshotId,
            canonicalHash: args.canonicalHash,
            expectedBoardRev: args.expectedBoardRev,
            issuedAt: args.issuedAt,
            expiresAt: args.expiresAt,
            stage: args.stage ?? 'ACTIVE',
            items: args.items as never,
            idempotencyKey: args.idempotencyKey,
            callerRole: 'ROOT_ORCHESTRATOR',
          },
        )
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
    'register_run',
    {
      title: 'Register run',
      description: 'AGENT register_run with provider assignment authorization before lock/claim.',
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
        idempotencyKey: z.string(),
        planId: z.string().optional(),
        planItemRank: z.number().int().optional(),
        maskedAccountRef: z.string().optional(),
        canonicalHash: z.string().optional(),
        collisionScopeLockIds: z.array(z.string()).optional(),
        initialState: z.enum(['QUEUED', 'RESERVED', 'STARTING', 'RUNNING']).optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      const deps = defaultRunDeps(id, args.expectedBoardRev)
      try {
        // Capacity always via getCapacity (or req) — no bypass; missing/stale → BLOCKED.
        const result = await registerRun(deps, {
          boardId: id,
          runId: args.runId,
          taskId: args.taskId,
          targetGate: args.targetGate,
          agentId: args.agentId,
          model: args.model,
          effort: args.effort,
          expectedEntityRev: args.expectedEntityRev,
          expectedBoardRev: args.expectedBoardRev,
          idempotencyKey: args.idempotencyKey,
          planId: args.planId,
          planItemRank: args.planItemRank,
          maskedAccountRef: args.maskedAccountRef,
          canonicalHash: args.canonicalHash,
          collisionScopeLockIds: args.collisionScopeLockIds,
          initialState: args.initialState,
        })
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
    'heartbeat_run',
    {
      title: 'Heartbeat run',
      description: 'Owning AGENT heartbeat with fencing.',
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
      const deps = defaultRunDeps(id, args.expectedBoardRev)
      try {
        const result = await heartbeatRun(deps, {
          boardId: id,
          runId: args.runId,
          agentId: args.agentId,
          fencingToken: args.fencingToken,
          heartbeatSequence: args.heartbeatSequence,
          expectedEntityRev: args.expectedEntityRev,
          expectedBoardRev: args.expectedBoardRev,
          materialProgressAt: args.materialProgressAt,
        })
        return jsonText({ ok: true, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
    'sync_accounts',
    {
      title: 'Sync accounts',
      description: 'ROOT account:sync — masked accounts only; never tokens.',
      inputSchema: {
        ...BOARD_ARG,
        sourceRevision: z.number().int(),
        expectedBoardRev: z.number().int().optional(),
        generatedAt: z.string().optional(),
        accounts: z.array(z.record(z.string(), z.any())),
        idempotencyKey: z.string(),
        trigger: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      // Strip secret-like fields before any boundary call; never echo them back.
      const sanitized = (args.accounts as Array<Record<string, unknown>>).map((a) => {
        const copy = { ...a }
        for (const k of Object.keys(copy)) {
          if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
            delete copy[k]
          }
        }
        return copy
      })
      try {
        const result = await syncAccounts(accountSyncDeps(), {
          boardId: id,
          sourceRevision: args.sourceRevision,
          generatedAt: args.generatedAt ?? new Date().toISOString(),
          expectedBoardRev: args.expectedBoardRev ?? 0,
          accounts: sanitized as never,
          trigger: (args.trigger as never) ?? 'ORCHESTRATOR_LAUNCH',
          idempotencyKey: args.idempotencyKey,
          callerRole: 'ROOT_ORCHESTRATOR',
          actorId: principal?.actorId ?? 'mcp-root',
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
  secureTool(
    'reconcile_dry_run',
    {
      title: 'Reconcile dry-run',
      description: 'ROOT reconcile:write dry-run.',
      inputSchema: {
        ...BOARD_ARG,
        leaderId: z.string().optional(),
        fencingToken: z.string().optional(),
        expectedBoardRev: z.number().int().optional(),
        maxActions: z.number().int().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      const runDeps = defaultRunDeps(id, args.expectedBoardRev ?? 0)
      const recDeps = reconcilerDeps(runDeps)
      const leaderId = args.leaderId ?? principal?.actorId ?? 'mcp-root'
      try {
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
          expectedBoardRev: args.expectedBoardRev,
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
  secureTool(
    'reconcile_apply',
    {
      title: 'Reconcile apply',
      description: 'ROOT reconcile:write apply with dryRunHash.',
      inputSchema: {
        ...BOARD_ARG,
        dryRunHash: z.string(),
        leaderId: z.string().optional(),
        fencingToken: z.string().optional(),
        expectedBoardRev: z.number().int().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      const runDeps = defaultRunDeps(id, args.expectedBoardRev ?? 0)
      const recDeps = reconcilerDeps(runDeps)
      const leaderId = args.leaderId ?? principal?.actorId ?? 'mcp-root'
      try {
        let fencingToken = args.fencingToken
        if (!fencingToken) {
          const claim = await claimReconcilerLeadership(recDeps, {
            boardId: id,
            leaderId,
            leaseMs: 60_000,
          })
          fencingToken = claim.fencingToken
        }
        const board = await recDeps.atomic.getBoardState(id)
        const result = await applyReconcile(recDeps, {
          boardId: id,
          leaderId,
          fencingToken,
          dryRunHash: args.dryRunHash,
          expectedBoardRev: args.expectedBoardRev ?? board.boardRev,
        })
        return jsonText({ ok: true, boardId: id, ...result })
      } catch (e) {
        return jsonText(typedError(e))
      }
    },
  )
  secureTool(
    'open_decision_v3',
    {
      title: 'Open decision V3',
      description: 'Request a Decision (AGENT/OWNER).',
      inputSchema: {
        ...BOARD_ARG,
        question: z.string(),
        title: z.string().optional(),
        type: z.string().optional(),
        severity: z.enum(['CRITICAL', 'HIGH', 'MEDIUM', 'LOW']).optional(),
        taskId: z.string().optional(),
        runId: z.string().optional(),
        blocking: z.boolean().optional(),
        expectedBoardRev: z.number().int().optional(),
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
        const board = await sharedAtomic(id).getBoardState(id)
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
          expectedBoardRev: args.expectedBoardRev ?? board.boardRev,
          actorId: principal?.actorId ?? 'mcp-agent',
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
  secureTool(
    'resolve_decision_v3',
    {
      title: 'Resolve decision V3',
      description: 'OWNER resolve only.',
      inputSchema: {
        ...BOARD_ARG,
        decisionId: z.string(),
        selectedOptionId: z.string().optional(),
        resolution: z.string().optional(),
        expectedRev: z.number().int().optional(),
        expectedBoardRev: z.number().int().optional(),
        comment: z.string().optional(),
      },
    },
    async (args) => {
      const id = await bid(args.boardId)
      try {
        const board = await sharedAtomic(id).getBoardState(id)
        const store = sharedDecisionStore()
        const existing = await store.get(id, args.decisionId)
        if (!existing) {
          return jsonText({
            ok: false,
            code: 'NOT_FOUND',
            error: `decision not found: ${args.decisionId}`,
          })
        }
        const selectedOptionId =
          args.selectedOptionId ??
          existing.options.find((o) => !o.declining)?.optionId ??
          existing.options[0]?.optionId
        if (!selectedOptionId) {
          return jsonText({ ok: false, code: 'INVALID_INPUT', error: 'no option to select' })
        }
        const rec = await resolveDecisionV3(decisionDeps(), {
          boardId: id,
          decisionId: args.decisionId,
          actorId: principal?.actorId ?? 'mcp-owner',
          selectedOptionId,
          comment: args.comment ?? args.resolution ?? null,
          expectedRev: args.expectedRev ?? existing.entityRev,
          expectedBoardRev: args.expectedBoardRev ?? board.boardRev,
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
  secureTool(
    'integration_lock',
    {
      title: 'Integration lock',
      description: 'INTEGRATOR path/checkpoint bounded lock (Grok-only integrator model).',
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
      const pathspecs: Array<string> =
        args.pathspecs ?? (args.pathspec ? [args.pathspec] : [])
      if (!pathspecs.length || !args.checkpointId || !args.rootAcceptanceId) {
        return jsonText({
          ok: false,
          code: 'INVALID_INPUT',
          error:
            'integration_lock requires rootAcceptanceId, checkpointId, and pathspec(s) — fail closed',
        })
      }
      try {
        const { acquireIntegrationLock } = await import('#/server/locks')
        const result = await acquireIntegrationLock(sharedLocks(), systemClock(), {
          boardId: id,
          repoId: args.repoId ?? id,
          trackingBranch: args.trackingBranch ?? 'main',
          runId: args.runId ?? `int-${Date.now()}`,
          agentId: principal?.actorId ?? 'mcp-integrator',
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
  // Public snapshot resource (unauth) — same pinned aggregation as get_public_snapshot /api/public-snapshot
  server.registerResource(
    'public-snapshot',
    'cairn://public-snapshot',
    { title: 'Public snapshot', description: 'Sanitized public snapshot resource (pinned materialization only).', mimeType: 'application/json' },
    async (uri) => {
      try {
        const id = await defaultBoardId()
        const existing = publicSnapStore.get(id)
        if (existing) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({ ok: true, snapshot: existing.payload }),
              },
            ],
          }
        }
        const agg = await loadPublicAggregation(id)
        if (!agg) {
          return {
            contents: [
              {
                uri: uri.href,
                mimeType: 'application/json',
                text: JSON.stringify({
                  ok: false,
                  code: 'STALE_OR_MISSING',
                  error: 'public snapshot unavailable',
                  stale: true,
                }),
              },
            ],
          }
        }
        const mat = materializePublicSnapshot(agg)
        publicSnapStore.put(id, mat)
        return {
          contents: [
            {
              uri: uri.href,
              mimeType: 'application/json',
              text: JSON.stringify({ ok: true, snapshot: mat.payload }),
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
                code: te.code === 'INTERNAL_ERROR' ? 'STALE_OR_MISSING' : te.code,
                error: te.code === 'INTERNAL_ERROR' ? 'public snapshot unavailable' : te.error,
                stale: true,
              }),
            },
          ],
        }
      }
    },
  )
}
