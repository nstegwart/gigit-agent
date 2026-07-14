#!/usr/bin/env node
/**
 * Lock / reconcile conformance harness (staging-oriented, default dry).
 *
 * Modes:
 *   --self-test | (default)  product-engine memory suite via Vite SSR (no network)
 *   --plan                   emit ordered staging MCP step plan (no mutation)
 *   --cleanup                emit post-suite release plan for leftover locks (no mutation)
 *   --real | --apply         requires dual staging mutation gates; still plan-only
 *                            unless CAIRN_LOCK_RECONCILE_EXECUTE=1 (live MCP reserved;
 *                            this harness refuses live mutation unless execute is set —
 *                            default is always dry)
 *
 * Env for gated staging path (plan / refuse / future execute):
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_LOCK_RECONCILE_APPLY=1
 *   CAIRN_LOCK_RECONCILE_BIND_LIVE_PIN=1
 *   CAIRN_LOCK_RECONCILE_EXECUTE=1   # only then would live MCP run (still needs URL+bearer)
 *   STAGING_URL  STAGING_ROOT_BEARER_TOKEN  BOARD_ID  EXPECTED_SHA (optional)
 *
 * Covers:
 *   AC-LOCK-01 atomic overlapping cross-task rejection
 *   AC-LOCK-02 lease / fence / terminal release
 *   AC-LOCK-03 single live integrator per repoId+trackingBranch
 *   AC-LOCK-04 supersession pointer + fencing
 *   RECONCILE   revision-bound dryRunHash / apply / idempotent re-apply
 *   POST-SUITE-RELEASE  leftover collision+integration release (fence/rev/idempotent)
 *
 * Never prints credentials. Never mutates staging by default.
 * Do not edit README/shared helpers from this flow — self-contained.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

export const HARNESS_ID = 'lock-reconcile-smoke-v1'
export const BOARD_DEFAULT = 'mfs-rebuild'
export const CANON_HASH = 'canon-lock-reconcile-smoke-v1'
/** Prefix for all synth runs/repos created by this harness (cleanup scope). */
export const SYNTH_PREFIX = 'synth-lr-'

/** Scenario inventory — every row must produce a self-test check id. */
export const SCENARIO_MATRIX = Object.freeze([
  {
    id: 'AC-LOCK-01',
    name: 'atomic overlapping cross-task rejection',
    product: 'acquireCollisionLocks CLAIM_COLLISION under board lock',
    stagingTool: null,
  },
  {
    id: 'AC-LOCK-02',
    name: 'lease/fence/terminal release',
    product: 'renew fence + releaseCollisionLocks + terminateRun releases locks',
    stagingTool: 'terminate_run',
  },
  {
    id: 'AC-LOCK-03',
    name: 'single repo+branch integrator',
    product: 'acquireIntegrationLock INTEGRATION_LOCKED for second run',
    stagingTool: 'integration_lock',
  },
  {
    id: 'AC-LOCK-04',
    name: 'supersession pointer + fencing',
    product: 'supersedeCollisionLock SUPERSEDED + fencingVersion++',
    stagingTool: null,
  },
  {
    id: 'RECONCILE-DRY-APPLY',
    name: 'revision-bound dryRunHash/apply/idempotency',
    product: 'claim leadership → dryRunReconcile → applyReconcile → same-hash idempotent',
    stagingTool: 'reconcile_dry_run|reconcile_apply',
  },
])

export const REQUIRED_STAGING_ENV = Object.freeze({
  CAIRN_ENV: 'staging',
  CAIRN_DB_NAME: 'cairn_tm_v3_staging',
  CAIRN_STAGING_SEED_APPROVED: '1',
  CAIRN_LOCK_RECONCILE_APPLY: '1',
  CAIRN_LOCK_RECONCILE_BIND_LIVE_PIN: '1',
})

/**
 * Fail-closed staging mutation gate. Live mutation also needs EXECUTE=1 + URL + bearer.
 * @param {NodeJS.ProcessEnv | Record<string, string | undefined>} env
 */
export function checkStagingMutationGates(env = process.env) {
  const missing = []
  for (const [k, expected] of Object.entries(REQUIRED_STAGING_ENV)) {
    const got = env[k]
    if (got !== expected) missing.push(`${k}=${expected}`)
  }
  if (missing.length) {
    return {
      ok: false,
      code: 'CAIRN_LOCK_RECONCILE_GATES_REFUSED',
      missing,
      message: `staging lock/reconcile mutation refused — set exact dual gates: ${missing.join(', ')}`,
      executeAllowed: false,
    }
  }
  const execute = env.CAIRN_LOCK_RECONCILE_EXECUTE === '1'
  const hasUrl = typeof env.STAGING_URL === 'string' && env.STAGING_URL.trim().length > 0
  const bearerCandidates = [
    'STAGING_ROOT_BEARER_TOKEN',
    'STAGING_BEARER_TOKEN',
    'CAIRN_MCP_BEARER',
  ]
  const hasBearer = bearerCandidates.some(
    (n) => typeof env[n] === 'string' && env[n].trim().length > 0,
  )
  return {
    ok: true,
    code: 'CAIRN_LOCK_RECONCILE_GATES_OK',
    missing: [],
    message: execute
      ? hasUrl && hasBearer
        ? 'gates+execute+target present (live path reserved)'
        : 'EXECUTE=1 but STAGING_URL and/or ROOT bearer missing'
      : 'gates OK — default non-mutating plan (set CAIRN_LOCK_RECONCILE_EXECUTE=1 for live)',
    executeAllowed: execute && hasUrl && hasBearer,
    executeRequested: execute,
    hasUrl,
    hasBearer,
  }
}

/**
 * Ordered staging MCP plan (args skeletons only — never invents dryRunHash / fencing).
 * @param {{ boardId?: string, expectedSha?: string }} [opts]
 */
export function buildStagingLockReconcilePlan(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  return {
    harnessId: HARNESS_ID,
    boardId,
    expectedSha: opts.expectedSha ?? null,
    residual_gaps: [
      'live_staging_not_exercised_in_plan_mode',
      'mcp_has_no_supersede_collision_tool',
      'mcp_has_no_release_integration_list_locks',
    ],
    steps: [
      {
        id: 'healthz_pin',
        tool: 'healthz',
        purpose: 'bind live pin boardRev/lifecycleRev/canonicalHash/deployedSha',
        mutates: false,
      },
      {
        id: 'register_run_a',
        tool: 'register_run',
        purpose: 'AUTHOR run with collisionScopeLockIds for path A',
        mutates: true,
        note: 'full mutation envelope from live pin; capture fencingToken',
      },
      {
        id: 'register_run_overlap_reject',
        tool: 'register_run',
        purpose: 'AC-LOCK-01 second task overlapping path → CLAIM_COLLISION',
        mutates: false,
        expectCode: 'CLAIM_COLLISION',
      },
      {
        id: 'heartbeat_fence_negative',
        tool: 'heartbeat_run',
        purpose: 'AC-LOCK-02 wrong fencingToken → FENCED',
        mutates: false,
        expectCode: 'FENCED',
      },
      {
        id: 'terminate_release',
        tool: 'terminate_run',
        purpose: 'AC-LOCK-02 terminal release fail-closed releases collision locks',
        mutates: true,
      },
      {
        id: 'integration_lock_first',
        tool: 'integration_lock',
        purpose: 'AC-LOCK-03 first integrator HELD for repo+trackingBranch',
        mutates: true,
      },
      {
        id: 'integration_lock_second_reject',
        tool: 'integration_lock',
        purpose: 'AC-LOCK-03 second integrator → INTEGRATION_LOCKED',
        mutates: false,
        expectCode: 'INTEGRATION_LOCKED',
      },
      {
        id: 'reconcile_dry_run',
        tool: 'reconcile_dry_run',
        purpose: 'capture dryRunHash under leader fence; no board rev bump',
        mutates: false,
        note: 'dryRunHash MUST come from server response — never invent',
      },
      {
        id: 'reconcile_apply',
        tool: 'reconcile_apply',
        purpose: 'apply exact dryRunHash; board rev bump once',
        mutates: true,
      },
      {
        id: 'reconcile_apply_idempotent',
        tool: 'reconcile_apply',
        purpose: 'same dryRunHash re-apply → idempotent / already-applied',
        mutates: false,
      },
      {
        id: 'post_suite_cleanup',
        tool: 'terminate_run|operator_cleanup',
        purpose:
          'post-suite release leftover collision + integration locks for synth-lr-* (fence + entityRev)',
        mutates: true,
        note: 'plan-only unless EXECUTE + operator driver; see buildCleanupPlan()',
      },
    ],
    scenarios: SCENARIO_MATRIX.map((s) => ({ id: s.id, name: s.name, stagingTool: s.stagingTool })),
  }
}

/**
 * Post-suite release plan for leftover integration/collision locks (never auto-executes).
 * Covers fence CAS, entityRev bump on release, and idempotent re-release fail-closed.
 * @param {{ boardId?: string }} [opts]
 */
export function buildCleanupPlan(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  return {
    harnessId: HARNESS_ID,
    boardId,
    mode: 'cleanup-plan',
    stagingMutation: false,
    runIdPrefix: SYNTH_PREFIX,
    residual_gaps: [
      'cleanup_not_auto_executed',
      'mcp_has_no_release_integration_list_locks',
      'requires_staging_gates_plus_operator_driver',
    ],
    steps: [
      {
        id: 'list_held_collision',
        tool: 'operator_list_locks|healthz',
        purpose: `inventory HELD collision locks with runId starting with ${SYNTH_PREFIX}`,
        mutates: false,
        note: 'MCP list_locks absent — operator/domain path or terminate_run preferred',
      },
      {
        id: 'list_held_integration',
        tool: 'operator_list_locks|healthz',
        purpose: `inventory HELD integration locks for ${SYNTH_PREFIX}* repos/runs`,
        mutates: false,
      },
      {
        id: 'fence_reject_collision_release',
        tool: 'operator_release_collision',
        purpose: 'wrong fencingToken → FENCED (no release)',
        mutates: false,
        expectCode: 'FENCED',
      },
      {
        id: 'release_collision_held',
        tool: 'terminate_run|operator_release_collision',
        purpose:
          'release HELD collision locks with live fencingToken; entityRev++ per lock',
        mutates: true,
        note: 'prefer terminate_run when run still live; else domain releaseCollisionLocks',
      },
      {
        id: 'release_integration_held',
        tool: 'operator_release_integration',
        purpose:
          'release HELD integration lock with live fencingToken (repoId+trackingBranch+runId); entityRev++',
        mutates: true,
        note: 'MCP release_integration absent — domain releaseIntegrationLock under operator driver',
      },
      {
        id: 'idempotent_rerelease',
        tool: 'operator_release_collision|operator_release_integration',
        purpose:
          'second release: collision → empty (no HELD); integration → remains RELEASED or LOCK_NOT_FOUND',
        mutates: false,
        note: 'product releaseIntegrationLock re-applies RELEASED when row still matches run+fence',
      },
      {
        id: 'verify_zero_held_synth',
        tool: 'operator_list_locks',
        purpose: `confirm zero HELD collision/integration locks for ${SYNTH_PREFIX}*`,
        mutates: false,
      },
    ],
  }
}

/**
 * @param {{ selfTest?: boolean, plan?: boolean, real?: boolean, cleanup?: boolean }} args
 * @param {NodeJS.ProcessEnv} [env]
 */
export function ownerTargetLine(args, env = process.env) {
  return {
    base_url: args.real ? env.STAGING_URL || null : 'mock://self-test',
    port: 'n/a',
    account: args.real ? 'ROOT bearer env-ref only' : 'n/a-memory',
    device: 'n/a',
    boardId: env.BOARD_ID || BOARD_DEFAULT,
    schema: env.SCHEMA_VERSION || '006',
    expectedSha: env.EXPECTED_SHA || null,
    execute: env.CAIRN_LOCK_RECONCILE_EXECUTE === '1',
    harnessId: HARNESS_ID,
  }
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const real = flags.has('--real') || flags.has('--apply')
  return {
    selfTest:
      flags.has('--self-test') ||
      flags.has('--contract') ||
      (!flags.has('--plan') && !real && !flags.has('--cleanup')),
    plan: flags.has('--plan'),
    real,
    cleanup: flags.has('--cleanup'),
    help: flags.has('--help') || flags.has('-h'),
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/lock-reconcile-smoke.mjs --self-test
  node qa/e2e/flows/lock-reconcile-smoke.mjs --plan
  node qa/e2e/flows/lock-reconcile-smoke.mjs --cleanup
  node qa/e2e/flows/lock-reconcile-smoke.mjs --real   # dual gates; plan unless EXECUTE=1

Env (gated real):
  CAIRN_ENV=staging CAIRN_DB_NAME=cairn_tm_v3_staging
  CAIRN_STAGING_SEED_APPROVED=1 CAIRN_LOCK_RECONCILE_APPLY=1
  CAIRN_LOCK_RECONCILE_BIND_LIVE_PIN=1
  CAIRN_LOCK_RECONCILE_EXECUTE=1  # required for any live MCP mutation
  STAGING_URL STAGING_ROOT_BEARER_TOKEN BOARD_ID EXPECTED_SHA

Default is dry self-test against product engines (memory). No live mutation without EXECUTE.
Cleanup is plan-only; operator releases leftover ${SYNTH_PREFIX}* collision/integration locks.
`)
}

export function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `lock-reconcile-smoke-${payload.mode || 'run'}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text) || /"secret"\s*:/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

/** @typedef {{ id: string, ok: boolean, detail?: string, code?: string }} Check */

/**
 * Load product TypeScript modules via Vite SSR (same pattern as migrate-runner.mjs).
 * @returns {Promise<{ close: () => Promise<void>, load: (rel: string) => Promise<any> }>}
 */
export async function createProductLoader() {
  const server = await createServer({
    server: { middlewareMode: true },
    appType: 'custom',
    configFile: false,
    root: ROOT,
    logLevel: 'error',
    resolve: {
      alias: [{ find: /^#\//, replacement: `${ROOT}/src/` }],
    },
  })
  return {
    async load(relFromSrc) {
      const path = relFromSrc.startsWith('/')
        ? relFromSrc
        : `/src/${relFromSrc.replace(/^\.\//, '')}`
      return server.ssrLoadModule(path)
    },
    async close() {
      await server.close()
    },
  }
}

function openCapacity() {
  return {
    dispatchMode: 'OPEN',
    dispatchAllowed: true,
    usableCapacity: 100,
    nonGrokAssignmentAllowed: true,
    grokAssignmentAllowed: true,
    limitingReasons: [],
    // M2: dispatchAllowed requires complete family remainings (fail closed without these).
    sparkUsableCapacity: 10,
    solUsableCapacity: 10,
    otherUsableCapacity: 10,
    healthyGrokUsableCapacity: 70,
    failSafeActions: [],
  }
}

/**
 * Product-engine dry self-test (memory stores). Exercises AC-LOCK-01..04 + reconcile.
 * @param {{ boardId?: string }} [opts]
 */
export async function runLockReconcileSelfTests(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  /** @type {Check[]} */
  const checks = []
  const loader = await createProductLoader()
  try {
    const boardStore = await loader.load('server/board-store.ts')
    const idem = await loader.load('server/idempotency.ts')
    const locksMod = await loader.load('server/locks.ts')
    const recMod = await loader.load('server/reconciler.ts')
    const runMod = await loader.load('server/run-registry.ts')

    const {
      createFakeClock,
      createMemoryControlPlaneAtomicStore,
    } = boardStore
    const { createMemoryIdempotencyStorage } = idem
    const {
      acquireCollisionLocks,
      acquireIntegrationLock,
      renewCollisionLocks,
      releaseCollisionLocks,
      releaseIntegrationLock,
      supersedeCollisionLock,
      createMemoryLockStore,
    } = locksMod
    const {
      claimReconcilerLeadership,
      dryRunReconcile,
      applyReconcile,
      createMemoryReconcilerStore,
      tasksWithReconciliationPending,
    } = recMod
    const {
      registerRun,
      terminateRun,
      createMemoryRunRegistryStore,
    } = runMod

    const clock = createFakeClock(Date.parse('2026-07-13T10:00:00.000Z'))
    const locks = createMemoryLockStore()
    const runs = createMemoryRunRegistryStore()
    const atomic = createMemoryControlPlaneAtomicStore([
      {
        boardId,
        boardRev: 0,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      },
    ])
    const idempotency = createMemoryIdempotencyStorage()
    const reconciler = createMemoryReconcilerStore()
    const runDeps = {
      clock,
      runs,
      locks,
      atomic,
      idempotency,
      getCapacity: async () => openCapacity(),
    }
    const recDeps = { clock, runs, locks, reconciler, atomic, idempotency }
    const gate = { atomic, idempotency }
    /** Always re-read live board rev (integration create + reconcile apply bump). */
    async function currentBoardRev() {
      const b = await atomic.getBoardState(boardId)
      return b.boardRev
    }

    // ---- AC-LOCK-01 ----
    try {
      await acquireCollisionLocks(locks, clock, {
        boardId,
        taskId: 'synth-lr-T1',
        runId: 'synth-lr-run-1',
        agentId: 'synth-lr-a1',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:synth-lr:src/**'],
      })
      let rejected = false
      let code = null
      try {
        await acquireCollisionLocks(locks, clock, {
          boardId,
          taskId: 'synth-lr-T2',
          runId: 'synth-lr-run-2',
          agentId: 'synth-lr-a2',
          role: 'AUTHOR',
          collisionScopeLockIds: ['repo:synth-lr:src/foo.ts'],
        })
      } catch (e) {
        rejected = true
        code = e?.code ?? null
      }
      const heldAfter = locks
        .snapshot()
        .collision.filter((l) => l.state === 'HELD' && l.runId === 'synth-lr-run-2')
      checks.push({
        id: 'AC-LOCK-01',
        ok: rejected && code === 'CLAIM_COLLISION' && heldAfter.length === 0,
        detail: `code=${code} secondHeld=${heldAfter.length}`,
        code: code ?? undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LOCK-01',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LOCK-02 lease/fence/terminal ----
    try {
      const acq = await acquireCollisionLocks(locks, clock, {
        boardId,
        taskId: 'synth-lr-T-lease',
        runId: 'synth-lr-run-lease',
        agentId: 'synth-lr-a-lease',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:synth-lr:lease/**', 'resources:synth-lr-x'],
        leaseMs: 60_000,
      })
      let fenceDenied = false
      try {
        await renewCollisionLocks(locks, clock, {
          boardId,
          runId: 'synth-lr-run-lease',
          fencingToken: 'wrong-fence',
        })
      } catch (e) {
        fenceDenied = e?.code === 'FENCED'
      }
      const renewed = await renewCollisionLocks(locks, clock, {
        boardId,
        runId: 'synth-lr-run-lease',
        fencingToken: acq.fencingToken,
        leaseMs: 60_000,
      })
      let releaseFenceDenied = false
      try {
        await releaseCollisionLocks(locks, clock, {
          boardId,
          runId: 'synth-lr-run-lease',
          fencingToken: 'wrong',
        })
      } catch (e) {
        releaseFenceDenied = e?.code === 'FENCED'
      }
      const released = await releaseCollisionLocks(locks, clock, {
        boardId,
        runId: 'synth-lr-run-lease',
        fencingToken: acq.fencingToken,
      })
      // Terminal path: register with scopes → terminate → locks released
      const revTerm = await currentBoardRev()
      // Capacity via getCapacity (family remainings); request-body capacity ignored (R3).
      const reg = await registerRun(runDeps, {
        boardId,
        runId: 'synth-lr-term-1',
        taskId: 'synth-lr-T-term',
        targetGate: 'FUNCTIONAL',
        agentId: 'synth-lr-agent-term',
        model: 'grok-4.5',
        expectedEntityRev: 0,
        expectedBoardRev: revTerm,
        canonicalHash: CANON_HASH,
        idempotencyKey: 'synth-lr-reg-term-1',
        initialState: 'RUNNING',
        collisionScopeLockIds: ['repo:synth-lr:term/**'],
      })
      const heldBeforeTerm = locks
        .snapshot()
        .collision.filter(
          (l) => l.state === 'HELD' && l.runId === 'synth-lr-term-1',
        )
      const term = await terminateRun(runDeps, {
        boardId,
        runId: 'synth-lr-term-1',
        agentId: 'synth-lr-agent-term',
        fencingToken: reg.fencingToken,
        toState: 'SUCCEEDED',
        reason: 'lock-reconcile-smoke-terminal',
      })
      const heldAfterTerm = locks
        .snapshot()
        .collision.filter(
          (l) => l.state === 'HELD' && l.runId === 'synth-lr-term-1',
        )
      checks.push({
        id: 'AC-LOCK-02',
        ok:
          fenceDenied &&
          releaseFenceDenied &&
          renewed.length === 2 &&
          released.every((l) => l.state === 'RELEASED') &&
          heldBeforeTerm.length >= 1 &&
          term.state === 'SUCCEEDED' &&
          heldAfterTerm.length === 0,
        detail: `fenceDenied=${fenceDenied} releaseFenceDenied=${releaseFenceDenied} renewed=${renewed.length} released=${released.length} heldBeforeTerm=${heldBeforeTerm.length} term=${term.state} heldAfterTerm=${heldAfterTerm.length}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LOCK-02',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LOCK-03 single integrator ----
    try {
      const revInt0 = await currentBoardRev()
      await acquireIntegrationLock(
        locks,
        clock,
        {
          boardId,
          repoId: 'synth-lr-repo',
          trackingBranch: 'feature/synth-lr',
          runId: 'synth-lr-int-1',
          agentId: 'synth-lr-integrator-1',
          integratorModel: 'grok-4.5',
          rootAcceptanceId: 'synth-lr-ra-1',
          checkpointId: 'synth-lr-cp-1',
          pathspecs: ['src/**'],
          entityExpectedRev: 0,
          expectedBoardRev: revInt0,
          canonicalHash: CANON_HASH,
          idempotencyKey: 'synth-lr-ilk-1',
        },
        gate,
      )
      // Create bumps board rev once — second acquire must bind live rev to reach INTEGRATION_LOCKED.
      const revInt1 = await currentBoardRev()
      let locked = false
      let code = null
      try {
        await acquireIntegrationLock(
          locks,
          clock,
          {
            boardId,
            repoId: 'synth-lr-repo',
            trackingBranch: 'feature/synth-lr',
            runId: 'synth-lr-int-2',
            agentId: 'synth-lr-integrator-2',
            integratorModel: 'grok-4.5',
            rootAcceptanceId: 'synth-lr-ra-2',
            checkpointId: 'synth-lr-cp-2',
            pathspecs: ['src/**'],
            entityExpectedRev: 0,
            expectedBoardRev: revInt1,
            canonicalHash: CANON_HASH,
            idempotencyKey: 'synth-lr-ilk-2',
          },
          gate,
        )
      } catch (e) {
        locked = true
        code = e?.code ?? null
      }
      const heldInt = locks
        .snapshot()
        .integration.filter(
          (l) =>
            l.state === 'HELD' &&
            l.repoId === 'synth-lr-repo' &&
            l.trackingBranch === 'feature/synth-lr',
        )
      checks.push({
        id: 'AC-LOCK-03',
        ok: locked && code === 'INTEGRATION_LOCKED' && heldInt.length === 1,
        detail: `code=${code} heldIntegrators=${heldInt.length} boardRevAfterCreate=${revInt1}`,
        code: code ?? undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LOCK-03',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LOCK-04 supersession ----
    try {
      const acq = await acquireCollisionLocks(locks, clock, {
        boardId,
        taskId: 'synth-lr-T-sup',
        runId: 'synth-lr-run-old',
        agentId: 'synth-lr-a-old',
        role: 'AUTHOR',
        collisionScopeLockIds: ['repo:synth-lr:only/**'],
      })
      const { previous, next } = await supersedeCollisionLock(locks, clock, {
        boardId,
        scopeId: 'repo:synth-lr:only/**',
        expectedFencingToken: acq.fencingToken,
        newRunId: 'synth-lr-run-new',
        newTaskId: 'synth-lr-T-sup',
        newAgentId: 'synth-lr-a-new',
        newRole: 'AUTHOR',
      })
      let staleFenceDenied = false
      try {
        await supersedeCollisionLock(locks, clock, {
          boardId,
          scopeId: 'repo:synth-lr:only/**',
          expectedFencingToken: acq.fencingToken,
          newRunId: 'synth-lr-run-x',
          newTaskId: 'synth-lr-T-sup',
          newAgentId: 'synth-lr-a-x',
          newRole: 'AUTHOR',
        })
      } catch (e) {
        staleFenceDenied = e?.code === 'FENCED'
      }
      checks.push({
        id: 'AC-LOCK-04',
        ok:
          previous.state === 'SUPERSEDED' &&
          previous.supersededByLockId === next.lockId &&
          next.supersedesLockId === previous.lockId &&
          next.fencingVersion === previous.fencingVersion + 1 &&
          staleFenceDenied,
        detail: `prev=${previous.state} nextFenceV=${next.fencingVersion} staleFenceDenied=${staleFenceDenied}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LOCK-04',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- RECONCILE dry/apply/idempotency ----
    try {
      const revReg = await currentBoardRev()
      await registerRun(runDeps, {
        boardId,
        runId: 'synth-lr-run-rec',
        taskId: 'synth-lr-T-REC',
        targetGate: 'FUNCTIONAL',
        agentId: 'synth-lr-agent-rec',
        model: 'grok-4.5',
        expectedEntityRev: 0,
        expectedBoardRev: revReg,
        canonicalHash: CANON_HASH,
        idempotencyKey: 'synth-lr-reg-rec',
        initialState: 'RUNNING',
      })
      // Expire lease past stall grace so dry-run classifies STALE
      clock.advance(60_000 + 30_000 + 1)

      const boardBefore = await atomic.getBoardState(boardId)
      const leader = await claimReconcilerLeadership(recDeps, {
        boardId,
        leaderId: 'synth-lr-leader-1',
      })
      const dry = await dryRunReconcile(recDeps, {
        entityExpectedRev: 0,
        canonicalHash: CANON_HASH,
        idempotencyKey: 'synth-lr-dry-1',
        boardId,
        leaderId: 'synth-lr-leader-1',
        fencingToken: leader.fencingToken,
        expectedBoardRev: boardBefore.boardRev,
        maxActions: 100,
      })
      const boardAfterDry = await atomic.getBoardState(boardId)
      const dryNoBump = boardAfterDry.boardRev === boardBefore.boardRev
      const pending = tasksWithReconciliationPending(dry.items)
      const hasHash = typeof dry.dryRunHash === 'string' && dry.dryRunHash.length > 0

      const apply1 = await applyReconcile(recDeps, {
        entityExpectedRev: 0,
        canonicalHash: CANON_HASH,
        idempotencyKey: 'synth-lr-apply-1',
        boardId,
        leaderId: 'synth-lr-leader-1',
        fencingToken: leader.fencingToken,
        dryRunHash: dry.dryRunHash,
        expectedBoardRev: boardAfterDry.boardRev,
      })
      const boardAfterApply = await atomic.getBoardState(boardId)
      const applyBump = boardAfterApply.boardRev === boardAfterDry.boardRev + 1

      const apply2 = await applyReconcile(recDeps, {
        entityExpectedRev: 0,
        canonicalHash: CANON_HASH,
        idempotencyKey: 'synth-lr-apply-2',
        boardId,
        leaderId: 'synth-lr-leader-1',
        fencingToken: leader.fencingToken,
        dryRunHash: dry.dryRunHash,
        expectedBoardRev: apply1.boardRev,
      })
      const boardAfterIdem = await atomic.getBoardState(boardId)
      const idempotent =
        apply2.idempotentReplay === true &&
        boardAfterIdem.boardRev === boardAfterApply.boardRev

      const runAfter = await runs.get(boardId, 'synth-lr-run-rec')
      const markedStale = runAfter?.state === 'STALE'

      // Wrong hash reject
      let hashMismatch = false
      try {
        await applyReconcile(recDeps, {
          entityExpectedRev: 0,
          canonicalHash: CANON_HASH,
          idempotencyKey: 'synth-lr-apply-bad-hash',
          boardId,
          leaderId: 'synth-lr-leader-1',
          fencingToken: leader.fencingToken,
          dryRunHash: 'deadbeef-not-a-real-dry-hash',
          expectedBoardRev: boardAfterIdem.boardRev,
        })
      } catch (e) {
        hashMismatch =
          e?.code === 'DRY_RUN_HASH_MISMATCH' || e?.code === 'STALE_REVISION'
      }

      checks.push({
        id: 'RECONCILE-DRY-APPLY',
        ok:
          hasHash &&
          dryNoBump &&
          apply1.applied === true &&
          apply1.idempotentReplay === false &&
          applyBump &&
          idempotent &&
          (pending.includes('synth-lr-T-REC') || markedStale) &&
          hashMismatch,
        detail: `hash=${hasHash} dryNoBump=${dryNoBump} apply1=${apply1.applied} applyBump=${applyBump} idempotent=${idempotent} pending=${JSON.stringify(pending)} state=${runAfter?.state} hashMismatch=${hashMismatch}`,
      })
    } catch (e) {
      checks.push({
        id: 'RECONCILE-DRY-APPLY',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // Inventory completeness (scenario matrix only — before post-suite/extra checks)
    const expectedIds = SCENARIO_MATRIX.map((s) => s.id)
    const gotIds = checks.map((c) => c.id)
    const inventoryOk =
      expectedIds.every((id) => gotIds.includes(id)) &&
      checks.length === expectedIds.length
    checks.push({
      id: 'SCENARIO-INVENTORY',
      ok: inventoryOk,
      detail: `expected=${expectedIds.join(',')} got=${gotIds.join(',')}`,
    })

    // ---- POST-SUITE-RELEASE: dedicated leftovers + fence/rev/idempotent release ----
    // Prior AC checks may leave EXPIRED rows after reconcile clock.advance + markExpiredLocks;
    // cleanup path acquires fresh HELD locks then releases them deterministically.
    try {
      const postCollRunId = `${SYNTH_PREFIX}post-suite-coll`
      const postIntRunId = `${SYNTH_PREFIX}post-suite-int`
      const postRepo = `${SYNTH_PREFIX}post-suite-repo`
      const postBranch = 'feature/synth-lr-post-suite'

      const acqColl = await acquireCollisionLocks(locks, clock, {
        boardId,
        taskId: `${SYNTH_PREFIX}T-post-suite`,
        runId: postCollRunId,
        agentId: `${SYNTH_PREFIX}a-post-suite`,
        role: 'AUTHOR',
        collisionScopeLockIds: [`repo:${SYNTH_PREFIX}post-suite/**`],
        leaseMs: 120_000,
      })
      const revInt = await currentBoardRev()
      const acqInt = await acquireIntegrationLock(
        locks,
        clock,
        {
          boardId,
          repoId: postRepo,
          trackingBranch: postBranch,
          runId: postIntRunId,
          agentId: `${SYNTH_PREFIX}integrator-post`,
          integratorModel: 'grok-4.5',
          rootAcceptanceId: `${SYNTH_PREFIX}ra-post`,
          checkpointId: `${SYNTH_PREFIX}cp-post`,
          pathspecs: ['src/**'],
          entityExpectedRev: 0,
          expectedBoardRev: revInt,
          canonicalHash: CANON_HASH,
          idempotencyKey: `${SYNTH_PREFIX}ilk-post-suite`,
        },
        gate,
      )

      const snapBefore = locks.snapshot()
      const heldCollBefore = snapBefore.collision.filter(
        (l) => l.state === 'HELD' && l.runId === postCollRunId,
      )
      const heldIntBefore = snapBefore.integration.filter(
        (l) => l.state === 'HELD' && l.runId === postIntRunId,
      )
      const hadLeftovers = heldCollBefore.length >= 1 && heldIntBefore.length >= 1

      let fenceDenied = false
      try {
        await releaseCollisionLocks(locks, clock, {
          boardId,
          runId: postCollRunId,
          fencingToken: 'wrong-post-suite-fence',
        })
      } catch (e) {
        fenceDenied = e?.code === 'FENCED'
      }

      const collPrevRevs = new Map(
        heldCollBefore.map((l) => [l.lockId, l.entityRev]),
      )
      const releasedColl = await releaseCollisionLocks(locks, clock, {
        boardId,
        runId: postCollRunId,
        fencingToken: acqColl.fencingToken,
      })
      let entityRevBumped =
        releasedColl.length >= 1 &&
        releasedColl.every(
          (r) =>
            r.state === 'RELEASED' &&
            r.entityRev === (collPrevRevs.get(r.lockId) ?? -1) + 1,
        )

      const intPrevRev = heldIntBefore[0]?.entityRev ?? 0
      const releasedInt = await releaseIntegrationLock(locks, clock, {
        boardId,
        repoId: postRepo,
        trackingBranch: postBranch,
        runId: postIntRunId,
        fencingToken: acqInt.fencingToken,
      })
      if (
        releasedInt.state !== 'RELEASED' ||
        releasedInt.entityRev !== intPrevRev + 1
      ) {
        entityRevBumped = false
      }

      const snapAfter = locks.snapshot()
      const heldCollAfter = snapAfter.collision.filter(
        (l) =>
          l.state === 'HELD' &&
          (l.runId === postCollRunId || l.runId === postIntRunId),
      )
      const heldIntAfter = snapAfter.integration.filter(
        (l) =>
          l.state === 'HELD' &&
          (l.runId === postCollRunId || l.runId === postIntRunId),
      )

      // Collision re-release with no HELD rows → empty array (idempotent no-op)
      const reColl = await releaseCollisionLocks(locks, clock, {
        boardId,
        runId: postCollRunId,
        fencingToken: acqColl.fencingToken,
      })
      const idempotentColl = Array.isArray(reColl) && reColl.length === 0

      // Integration re-release: product re-applies RELEASED (entityRev++) when row still
      // matches runId+fence — fail-closed only on wrong fence / wrong run.
      // Collision re-release is empty-array no-op when no HELD remain.
      let idempotentInt = false
      try {
        const againInt = await releaseIntegrationLock(locks, clock, {
          boardId,
          repoId: postRepo,
          trackingBranch: postBranch,
          runId: postIntRunId,
          fencingToken: acqInt.fencingToken,
        })
        idempotentInt = againInt.state === 'RELEASED'
      } catch (e) {
        idempotentInt = e?.code === 'LOCK_NOT_FOUND'
      }

      const cleanupPlan = buildCleanupPlan({ boardId })
      const planHasPostSuite = cleanupPlan.steps.some(
        (s) => s.id === 'release_integration_held',
      )

      checks.push({
        id: 'POST-SUITE-RELEASE',
        ok:
          hadLeftovers &&
          fenceDenied &&
          releasedColl.length >= 1 &&
          releasedInt.state === 'RELEASED' &&
          heldCollAfter.length === 0 &&
          heldIntAfter.length === 0 &&
          entityRevBumped &&
          idempotentColl &&
          idempotentInt &&
          planHasPostSuite &&
          cleanupPlan.stagingMutation === false,
        detail: `leftoversColl=${heldCollBefore.length} leftoversInt=${heldIntBefore.length} fenceDenied=${fenceDenied} collReleased=${releasedColl.length} intState=${releasedInt.state} heldAfterColl=${heldCollAfter.length} heldAfterInt=${heldIntAfter.length} revBump=${entityRevBumped} idemColl=${idempotentColl} idemInt=${idempotentInt}`,
      })
    } catch (e) {
      checks.push({
        id: 'POST-SUITE-RELEASE',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // Gate helper self-check (refuse without env)
    const gateRefuse = checkStagingMutationGates({})
    const gateAccept = checkStagingMutationGates({ ...REQUIRED_STAGING_ENV })
    checks.push({
      id: 'STAGING-GATES',
      ok:
        gateRefuse.ok === false &&
        gateAccept.ok === true &&
        gateAccept.executeAllowed === false,
      detail: `refuse=${gateRefuse.code} accept=${gateAccept.code} executeAllowed=${gateAccept.executeAllowed}`,
    })

    const failures = checks.filter((c) => !c.ok)
    return {
      ok: failures.length === 0,
      harnessId: HARNESS_ID,
      mode: 'self-test',
      stagingMutation: false,
      checkCount: checks.length,
      passCount: checks.filter((c) => c.ok).length,
      failures,
      checks,
      cleanup: buildCleanupPlan({ boardId }),
      residual_gaps: [
        'live_staging_mcp_not_exercised_self_test_only',
        'mcp_has_no_supersede_collision_tool',
        'mcp_has_no_release_integration_list_locks',
        'RELEASE_LOCKS_reconciler_action_dead_code_path',
        'cleanup_not_auto_executed',
      ],
    }
  } finally {
    await loader.close()
  }
}

/**
 * Real/staging path: gates + plan only unless EXECUTE + target; live MCP is
 * intentionally not implemented as silent mutation — returns BLOCKED-style refuse
 * when execute requested without full target, or plan when gates ok without execute.
 * Cleanup remains plan-only (operator releases leftover synth locks).
 * @param {NodeJS.ProcessEnv} env
 */
export function runGatedStagingPath(env = process.env) {
  const gate = checkStagingMutationGates(env)
  if (!gate.ok) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: gate.code,
      message: gate.message,
      missing: gate.missing,
      stagingMutation: false,
      residual_gaps: ['gates_not_satisfied'],
    }
  }

  const plan = buildStagingLockReconcilePlan({
    boardId: env.BOARD_ID || BOARD_DEFAULT,
    expectedSha: env.EXPECTED_SHA || undefined,
  })
  const cleanup = buildCleanupPlan({
    boardId: env.BOARD_ID || BOARD_DEFAULT,
  })

  if (!gate.executeRequested) {
    return {
      ok: true,
      mode: 'apply-plan',
      code: 'LOCK_RECONCILE_PLAN',
      stagingMutation: false,
      message:
        'Gates + live-pin bind OK. Default non-mutating plan. Set CAIRN_LOCK_RECONCILE_EXECUTE=1 + STAGING_URL + ROOT bearer for live MCP (not run by default). Always run post-suite cleanup after any live lock acquire.',
      plan,
      cleanup,
      residual_gaps: plan.residual_gaps,
    }
  }

  if (!gate.executeAllowed) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'LOCK_RECONCILE_EXECUTE_TARGET_MISSING',
      message: gate.message,
      stagingMutation: false,
      residual_gaps: ['execute_without_url_or_bearer'],
      plan,
      cleanup,
    }
  }

  // Explicit refuse of live mutation implementation here: harness documents the
  // sequence but does not auto-fire MCP against staging without a dedicated
  // operator-owned driver. Prevents accidental mutation from this smoke entry.
  return {
    ok: false,
    mode: 'apply-refused',
    code: 'LOCK_RECONCILE_LIVE_MCP_NOT_AUTO_EXECUTED',
    message:
      'EXECUTE gates satisfied, but this harness intentionally does not auto-mutate staging. Use plan steps with an operator-owned MCP driver, or extend this flow with explicit live client under separate approval. Post-suite release of synth-lr-* collision/integration locks remains mandatory after any live acquire.',
    stagingMutation: false,
    residual_gaps: ['live_mcp_driver_not_auto_executed', 'cleanup_required_after_live'],
    plan,
    cleanup,
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const target = ownerTargetLine(args)
  console.log(`OWNER_TARGET: ${JSON.stringify(target)}`)

  if (args.cleanup) {
    const cleanup = buildCleanupPlan({
      boardId: process.env.BOARD_ID || BOARD_DEFAULT,
    })
    const payload = {
      ok: true,
      mode: 'cleanup-plan',
      stagingMutation: false,
      harnessId: HARNESS_ID,
      cleanup,
      residual_gaps: cleanup.residual_gaps,
    }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(0)
  }

  if (args.plan) {
    const plan = buildStagingLockReconcilePlan({
      boardId: process.env.BOARD_ID || BOARD_DEFAULT,
      expectedSha: process.env.EXPECTED_SHA || undefined,
    })
    const payload = {
      ok: true,
      mode: 'plan',
      stagingMutation: false,
      harnessId: HARNESS_ID,
      plan,
      cleanup: buildCleanupPlan({
        boardId: process.env.BOARD_ID || BOARD_DEFAULT,
      }),
      residual_gaps: plan.residual_gaps,
    }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(0)
  }

  if (args.real) {
    const result = runGatedStagingPath(process.env)
    const receipt = writeReceipt(result)
    console.log(JSON.stringify({ ...result, receipt }, null, 2))
    process.exit(result.ok ? 0 : 3)
  }

  // default self-test
  const self = await runLockReconcileSelfTests()
  const payload = {
    ...self,
    residual_gaps: self.ok
      ? self.residual_gaps
      : [...self.residual_gaps, 'self_test_failed'],
  }
  const receipt = writeReceipt(payload)
  console.log(JSON.stringify({ ...payload, receipt }, null, 2))
  process.exit(payload.ok ? 0 : 1)
}

function isExecutedAsMain() {
  if (!process.argv[1]) return false
  try {
    return fileURLToPath(import.meta.url) === resolve(process.argv[1])
  } catch {
    return false
  }
}

// Only auto-run CLI when this file is the process entrypoint (not when unit-imported).
if (isExecutedAsMain()) {
  main().catch((e) => {
    console.error(
      JSON.stringify({
        ok: false,
        error: String(e?.message || e),
        code: e?.code ?? 'LOCK_RECONCILE_SMOKE_FATAL',
      }),
    )
    process.exit(2)
  })
}
