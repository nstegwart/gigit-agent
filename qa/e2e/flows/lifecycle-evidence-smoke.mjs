#!/usr/bin/env node
/**
 * Lifecycle / stage-evidence conformance harness (staging-oriented, default dry).
 *
 * Modes:
 *   --self-test | (default)  product-engine memory suite via Vite SSR (no network)
 *   --plan                   emit ordered staging MCP step plan (no mutation)
 *   --cleanup                emit cleanup/terminalize plan for synth-le-* runs (no mutation)
 *   --real | --apply         requires dual staging mutation gates; still plan-only
 *                            unless CAIRN_LIFECYCLE_EVIDENCE_EXECUTE=1 (live MCP reserved;
 *                            this harness refuses live mutation unless execute is set —
 *                            default is always dry)
 *
 * Env for gated staging path (plan / refuse / future execute):
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_LIFECYCLE_EVIDENCE_APPLY=1
 *   CAIRN_LIFECYCLE_EVIDENCE_BIND_LIVE_PIN=1
 *   CAIRN_LIFECYCLE_EVIDENCE_EXECUTE=1   # only then would live MCP run (still needs URL+bearer)
 *   STAGING_URL  STAGING_ROOT_BEARER_TOKEN  BOARD_ID  EXPECTED_SHA (optional)
 *
 * Covers:
 *   AC-LIFE-NINE-STAGE-RAIL   identity nine-stage rail + allowSkip=false
 *   AC-LIFE-NO-SKIP           ordered no-skip INVALID_TRANSITION
 *   AC-LIFE-FRESH-REVS-HASH   fresh expectedRev / boardRev / hash CAS
 *   AC-LIFE-EXACT-RECEIPTS    full rail advance with registry-bound exact receipts
 *   AC-LIFE-INDEPENDENT-VERIFIER  opposite-agent verifier stage success
 *   AC-LIFE-LEASE-FENCE       registered-run lease / fence / unregistered rejects
 *   AC-LIFE-SELF-VERIFY       SELF_VERIFICATION reject
 *   AC-LIFE-MODEL-ROLE        INVALID_VERIFIER_ROLE + INVALID_MODEL_PAIRING
 *   AC-LIFE-G5-READONLY       derived g5Pass only (caller write ignored)
 *   CLEANUP-TERMINALIZE       deterministic register→terminate synth runs (self-test)
 *
 * Never prints credentials. Never mutates staging by default.
 * Do not edit README/shared helpers from this flow — self-contained.
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createServer } from 'vite'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

export const HARNESS_ID = 'lifecycle-evidence-smoke-v1'
export const BOARD_DEFAULT = 'mfs-rebuild'
export const CANON_HASH = 'canon-lifecycle-evidence-smoke-v1'
export const SNAP_ID = 'snap-lifecycle-evidence-smoke-v1'
export const TASK_HASH = 'task-hash-lifecycle-evidence-smoke-v1'
export const TASK_ID = 'synth-le-task-1'
/** Prefix for all synth runs/tasks created by this harness (cleanup scope). */
export const SYNTH_PREFIX = 'synth-le-'

/** Scenario inventory — every row must produce a self-test check id. */
export const SCENARIO_MATRIX = Object.freeze([
  {
    id: 'AC-LIFE-NINE-STAGE-RAIL',
    name: 'identity nine-stage rail + allowSkip=false',
    product: 'V3_LIFECYCLE_RAIL length 9 + V3_IDENTITY_LIFECYCLE_CONFIG.allowSkip false',
    stagingTool: 'set_lifecycle',
  },
  {
    id: 'AC-LIFE-NO-SKIP',
    name: 'ordered no-skip rail',
    product: 'advance skip MAPPING→MAPPED and BUILT→INTEGRATED → INVALID_TRANSITION',
    stagingTool: 'advance_task',
  },
  {
    id: 'AC-LIFE-FRESH-REVS-HASH',
    name: 'fresh expectedRev/boardRev/hash',
    product: 'stale entity/board rev + stale task/canonical hash reject',
    stagingTool: 'advance_task|submit_stage_evidence',
  },
  {
    id: 'AC-LIFE-EXACT-RECEIPTS',
    name: 'exact receipts full rail',
    product: 'submitStageEvidence program-hash + advance all nine stages with registry binding',
    stagingTool: 'submit_stage_evidence|advance_task',
  },
  {
    id: 'AC-LIFE-INDEPENDENT-VERIFIER',
    name: 'independent verifier stage',
    product: 'MAP_VERIFIED advances with mapping-verifier ≠ implementer agent/model/thread',
    stagingTool: 'advance_task',
  },
  {
    id: 'AC-LIFE-LEASE-FENCE',
    name: 'live registered lease/fence',
    product: 'RUN_NOT_REGISTERED + LEASE_EXPIRED + FENCED reject; valid registered advances',
    stagingTool: 'register_run|advance_task',
  },
  {
    id: 'AC-LIFE-SELF-VERIFY',
    name: 'self-verify reject',
    product: 'same run as author+verifier → SELF_VERIFICATION',
    stagingTool: 'advance_task',
  },
  {
    id: 'AC-LIFE-MODEL-ROLE',
    name: 'model/role rejects',
    product: 'INVALID_VERIFIER_ROLE + INVALID_MODEL_PAIRING (requireOppositeModel)',
    stagingTool: 'advance_task',
  },
  {
    id: 'AC-LIFE-G5-READONLY',
    name: 'derived g5 read-only',
    product: 'evaluateG5/deriveG5Pass; caller-written g5Pass never consulted',
    stagingTool: null,
  },
])

export const REQUIRED_STAGING_ENV = Object.freeze({
  CAIRN_ENV: 'staging',
  CAIRN_DB_NAME: 'cairn_tm_v3_staging',
  CAIRN_STAGING_SEED_APPROVED: '1',
  CAIRN_LIFECYCLE_EVIDENCE_APPLY: '1',
  CAIRN_LIFECYCLE_EVIDENCE_BIND_LIVE_PIN: '1',
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
      code: 'CAIRN_LIFECYCLE_EVIDENCE_GATES_REFUSED',
      missing,
      message: `staging lifecycle/evidence mutation refused — set exact dual gates: ${missing.join(', ')}`,
      executeAllowed: false,
    }
  }
  const execute = env.CAIRN_LIFECYCLE_EVIDENCE_EXECUTE === '1'
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
    code: 'CAIRN_LIFECYCLE_EVIDENCE_GATES_OK',
    missing: [],
    message: execute
      ? hasUrl && hasBearer
        ? 'gates+execute+target present (live path reserved)'
        : 'EXECUTE=1 but STAGING_URL and/or ROOT bearer missing'
      : 'gates OK — default non-mutating plan (set CAIRN_LIFECYCLE_EVIDENCE_EXECUTE=1 for live)',
    executeAllowed: execute && hasUrl && hasBearer,
    executeRequested: execute,
    hasUrl,
    hasBearer,
  }
}

/**
 * Ordered staging MCP plan (args skeletons only — never invents receiptHash).
 * @param {{ boardId?: string, expectedSha?: string }} [opts]
 */
export function buildStagingLifecycleEvidencePlan(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  return {
    harnessId: HARNESS_ID,
    boardId,
    expectedSha: opts.expectedSha ?? null,
    residual_gaps: [
      'live_staging_not_exercised_in_plan_mode',
      'g5_write_unsupported_by_design',
      'live_mcp_driver_not_auto_executed',
    ],
    steps: [
      {
        id: 'healthz_pin',
        tool: 'healthz',
        purpose: 'bind live pin boardRev/lifecycleRev/canonicalHash/deployedSha',
        mutates: false,
      },
      {
        id: 'register_run_author',
        tool: 'register_run',
        purpose: 'AUTHOR run with targetGate + fresh pin envelope; capture fencingToken/lease',
        mutates: true,
        note: 'full mutation envelope from live pin',
      },
      {
        id: 'submit_stage_evidence_mapping',
        tool: 'submit_stage_evidence',
        purpose: 'program-emit receipt for MAPPING; server computes receiptHash',
        mutates: true,
        note: 'never hand-insert schema006 receipts; never invent receiptHash',
      },
      {
        id: 'advance_mapping',
        tool: 'advance_task',
        purpose: 'advance to MAPPING with byRunId + exact receiptId+receiptHash',
        mutates: true,
      },
      {
        id: 'advance_skip_reject',
        tool: 'advance_task',
        purpose: 'AC-LIFE-NO-SKIP skip stages → INVALID_TRANSITION',
        mutates: false,
        expectCode: 'INVALID_TRANSITION',
      },
      {
        id: 'stale_rev_reject',
        tool: 'advance_task',
        purpose: 'AC-LIFE-FRESH-REVS-HASH stale expectedBoardRev → STALE_REVISION',
        mutates: false,
        expectCode: 'STALE_REVISION',
      },
      {
        id: 'register_run_verifier',
        tool: 'register_run',
        purpose: 'independent verifier run (role=mapping-verifier, opposite model)',
        mutates: true,
      },
      {
        id: 'self_verify_reject',
        tool: 'advance_task',
        purpose: 'AC-LIFE-SELF-VERIFY same author/verifier → SELF_VERIFICATION',
        mutates: false,
        expectCode: 'SELF_VERIFICATION',
      },
      {
        id: 'wrong_role_reject',
        tool: 'advance_task',
        purpose: 'AC-LIFE-MODEL-ROLE wrong verifier role → INVALID_VERIFIER_ROLE',
        mutates: false,
        expectCode: 'INVALID_VERIFIER_ROLE',
      },
      {
        id: 'fenced_lease_reject',
        tool: 'advance_task',
        purpose: 'AC-LIFE-LEASE-FENCE fenced or expired run → FENCED / LEASE_EXPIRED',
        mutates: false,
        expectCode: 'FENCED|LEASE_EXPIRED',
      },
      {
        id: 'ordered_rail_advance',
        tool: 'submit_stage_evidence|advance_task',
        purpose: 'walk remaining ordered stages with exact receipts + fresh revs',
        mutates: true,
      },
      {
        id: 'g5_read_only',
        tool: 'get_rollup|healthz',
        purpose: 'AC-LIFE-G5-READONLY derived g5Pass only; no G5 write tool',
        mutates: false,
      },
      {
        id: 'cleanup_terminalize_synth',
        tool: 'terminate_run|operator_cleanup',
        purpose: `terminalize only ${SYNTH_PREFIX}* harness runs; release any collision scopes`,
        mutates: true,
        note: 'plan-only unless EXECUTE + operator driver; see buildCleanupPlan()',
      },
    ],
    scenarios: SCENARIO_MATRIX.map((s) => ({
      id: s.id,
      name: s.name,
      stagingTool: s.stagingTool,
    })),
  }
}

/**
 * Cleanup / terminalization plan for synth harness runs (never auto-executes).
 * Operator must terminate only SYNTH_PREFIX* runIds after any live plan execution.
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
    taskIdPrefix: SYNTH_PREFIX,
    residual_gaps: [
      'cleanup_not_auto_executed',
      'requires_staging_gates_plus_operator_driver',
    ],
    steps: [
      {
        id: 'list_synth_runs',
        tool: 'list_runs|healthz',
        purpose: `filter runId starting with ${SYNTH_PREFIX}`,
        mutates: false,
      },
      {
        id: 'terminalize_synth_runs',
        tool: 'terminate_run',
        purpose:
          'terminate non-terminal synth runs with live fencingToken (toState CANCELLED or SUCCEEDED)',
        mutates: true,
        note: 'fresh expectedBoardRev + fencingToken from list/healthz; never invent fence',
      },
      {
        id: 'release_synth_collision_if_any',
        tool: 'terminate_run|operator_cleanup',
        purpose:
          'fail-closed release of any leftover collision locks for synth runs (terminal path preferred)',
        mutates: true,
      },
      {
        id: 'verify_no_live_synth',
        tool: 'list_runs',
        purpose: `confirm zero non-terminal ${SYNTH_PREFIX}* runs remain`,
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
    execute: env.CAIRN_LIFECYCLE_EVIDENCE_EXECUTE === '1',
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
  node qa/e2e/flows/lifecycle-evidence-smoke.mjs --self-test
  node qa/e2e/flows/lifecycle-evidence-smoke.mjs --plan
  node qa/e2e/flows/lifecycle-evidence-smoke.mjs --cleanup
  node qa/e2e/flows/lifecycle-evidence-smoke.mjs --real   # dual gates; plan unless EXECUTE=1

Env (gated real):
  CAIRN_ENV=staging CAIRN_DB_NAME=cairn_tm_v3_staging
  CAIRN_STAGING_SEED_APPROVED=1 CAIRN_LIFECYCLE_EVIDENCE_APPLY=1
  CAIRN_LIFECYCLE_EVIDENCE_BIND_LIVE_PIN=1
  CAIRN_LIFECYCLE_EVIDENCE_EXECUTE=1  # required for any live MCP mutation
  STAGING_URL STAGING_ROOT_BEARER_TOKEN BOARD_ID EXPECTED_SHA

Default is dry self-test against product engines (memory). No live mutation without EXECUTE.
Cleanup is plan-only; operator terminalizes ${SYNTH_PREFIX}* runs after any live synth.
`)
}

export function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `lifecycle-evidence-smoke-${payload.mode || 'run'}-${Date.now()}.json`
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
 * Load product TypeScript modules via Vite SSR (same pattern as lock-reconcile-smoke).
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

const VERIFIER_STAGES = new Set([
  'MAP_VERIFIED',
  'FUNCTIONAL',
  'STAGING_PROVEN',
  'PROD_READY',
  'LIVE_VERIFIED',
])

const STAGE_FIELDS = Object.freeze({
  MAPPING: {},
  MAPPED: { mappingStructuralReceipt: 'map-struct-le-1' },
  MAP_VERIFIED: { mappingReceipt: 'map-le-1', verifierVerdict: 'PASS' },
  BUILT: {
    implementationReceipt: 'impl-le-1',
    intendedChangedPaths: ['src/server/lifecycle-store.ts'],
  },
  FUNCTIONAL: {
    runtimePositive: 'pos',
    runtimeNegative: 'neg',
    runtimeRegression: 'reg',
    verifierVerdict: 'PASS',
  },
  INTEGRATED: {
    integrateReceipt: 'int-le-1',
    repo: 'gigit-project-orchestration',
    trackingBranch: 'main',
    fullSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    shortSha: 'e04b7e6',
    pathspecs: ['src/server/lifecycle-store.ts'],
    push: 'OK',
  },
  STAGING_PROVEN: {
    stagingApi: 'ok',
    stagingUi: 'ok',
    stagingDb: 'ok',
    stagingReadback: 'ok',
    deployedSha: 'e04b7e62b38c57bf216412f9dfc0d34cb98d1d11',
    verifierVerdict: 'PASS',
  },
  PROD_READY: { g5EvidenceComplete: true, verifierVerdict: 'PASS' },
  LIVE_VERIFIED: {
    productionApprovalId: 'owner-prod-appr-le-1',
    deployReceipt: 'deploy-le-1',
    liveReadback: 'live-ok',
    verifierVerdict: 'PASS',
  },
})

/**
 * Product-engine dry self-test (memory lifecycle + g5). Exercises AC-LIFE-* matrix.
 * @param {{ boardId?: string, taskId?: string }} [opts]
 */
export async function runLifecycleEvidenceSelfTests(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  const taskId = opts.taskId || TASK_ID
  /** @type {Check[]} */
  const checks = []
  const loader = await createProductLoader()
  try {
    const life = await loader.load('server/lifecycle-store.ts')
    const g5mod = await loader.load('server/g5.ts')
    const types = await loader.load('lib/control-plane-types.ts')

    const {
      V3_LIFECYCLE_RAIL,
      V3_IDENTITY_LIFECYCLE_CONFIG,
      advanceTaskV3,
      computeStageReceiptHash,
      createMemoryLifecycleV3Storage,
      submitStageEvidence,
      LifecycleV3Error,
    } = life
    const { evaluateG5, deriveG5Pass, makePassingDomain } = g5mod
    const { G5_REQUIRED_DOMAINS } = types

    function run(over) {
      return {
        agentId: `agent-${over.runId}`,
        model: 'grok-4.5',
        threadId: `thread-${over.runId}`,
        expiresAt: '2099-01-01T00:00:00.000Z',
        fenced: false,
        registered: true,
        ...over,
      }
    }

    function baseTask(stage = null, over = {}) {
      return {
        taskId,
        stage,
        entityRev: 0,
        boardRev: 1,
        lifecycleRev: 1,
        taskHash: TASK_HASH,
        canonicalSnapshotId: SNAP_ID,
        canonicalHash: CANON_HASH,
        implementerRunId: null,
        implementerAgentId: null,
        implementerModel: null,
        implementerThreadId: null,
        history: [],
        stageReceipts: {},
        blockedReason: null,
        ...over,
      }
    }

    function storageFor(task, runs, boardRev = 1, lifecycleRev = 1) {
      return createMemoryLifecycleV3Storage({
        pin: {
          boardId,
          boardRev,
          lifecycleRev,
          canonicalSnapshotId: SNAP_ID,
          canonicalHash: CANON_HASH,
        },
        tasks: [task],
        runs,
      })
    }

    function makeReceipt(stage, fields, optsR = {}) {
      const partial = {
        receiptId: optsR.receiptId ?? `rcpt-${stage}-le`,
        programmatic: optsR.programmatic ?? true,
        taskHash: optsR.taskHash ?? TASK_HASH,
        canonicalHash: optsR.canonicalHash ?? CANON_HASH,
        boardRev: optsR.boardRev ?? 1,
        lifecycleRev: optsR.lifecycleRev ?? 1,
        fields,
        authorRunId: optsR.authorRunId ?? null,
        verifierRunId: optsR.verifierRunId ?? null,
        verdict: optsR.verdict ?? null,
        issuedAt: optsR.issuedAt ?? '2026-07-13T10:00:00.000Z',
      }
      return { ...partial, receiptHash: computeStageReceiptHash(partial) }
    }

    async function advanceWithEvidence(store, inp) {
      await store.putStageEvidence({
        boardId: inp.boardId,
        taskId: inp.taskId,
        toStage: inp.toStage,
        receipt: inp.receipt,
        emittingRunId: inp.byRunId,
        registeredAt: inp.receipt.issuedAt,
      })
      return advanceTaskV3(store, inp)
    }

    async function codeOf(fn) {
      try {
        await fn()
        return null
      } catch (e) {
        return e?.code ?? e?.name ?? String(e?.message || e)
      }
    }

    // ---- AC-LIFE-NINE-STAGE-RAIL ----
    try {
      const rail = [...V3_LIFECYCLE_RAIL]
      const expected = [
        'MAPPING',
        'MAPPED',
        'MAP_VERIFIED',
        'BUILT',
        'FUNCTIONAL',
        'INTEGRATED',
        'STAGING_PROVEN',
        'PROD_READY',
        'LIVE_VERIFIED',
      ]
      const ok =
        rail.length === 9 &&
        JSON.stringify(rail) === JSON.stringify(expected) &&
        V3_IDENTITY_LIFECYCLE_CONFIG.allowSkip === false &&
        V3_IDENTITY_LIFECYCLE_CONFIG.stages.map((s) => s.key).join(',') ===
          expected.join(',')
      checks.push({
        id: 'AC-LIFE-NINE-STAGE-RAIL',
        ok,
        detail: `railLen=${rail.length} allowSkip=${V3_IDENTITY_LIFECYCLE_CONFIG.allowSkip} rail=${rail.join(',')}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-NINE-STAGE-RAIL',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-NO-SKIP ----
    try {
      const author = run({ runId: 'le-run-a-skip', role: 'implementer' })
      const storeSkip = storageFor(baseTask(null), [author])
      const code1 = await codeOf(() =>
        advanceWithEvidence(storeSkip, {
          boardId,
          taskId,
          toStage: 'MAPPED',
          byRunId: author.runId,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPED', STAGE_FIELDS.MAPPED, {
            authorRunId: author.runId,
          }),
        }),
      )
      const storeMid = storageFor(
        {
          ...baseTask('BUILT', {
            entityRev: 4,
            implementerRunId: author.runId,
            implementerAgentId: author.agentId,
            implementerModel: author.model,
            implementerThreadId: author.threadId,
          }),
        },
        [author],
      )
      const code2 = await codeOf(() =>
        advanceWithEvidence(storeMid, {
          boardId,
          taskId,
          toStage: 'INTEGRATED',
          byRunId: author.runId,
          entityExpectedRev: 4,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('INTEGRATED', STAGE_FIELDS.INTEGRATED, {
            authorRunId: author.runId,
          }),
        }),
      )
      checks.push({
        id: 'AC-LIFE-NO-SKIP',
        ok: code1 === 'INVALID_TRANSITION' && code2 === 'INVALID_TRANSITION',
        detail: `skipFromNull=${code1} skipMid=${code2}`,
        code: code1 || code2 || undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-NO-SKIP',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-FRESH-REVS-HASH ----
    try {
      const author = run({ runId: 'le-run-a-fresh', role: 'implementer' })
      const store = storageFor(baseTask('MAPPING', { entityRev: 1 }), [author])
      const receiptOk = makeReceipt('MAPPED', STAGE_FIELDS.MAPPED, {
        authorRunId: author.runId,
      })
      const staleEntity = await codeOf(() =>
        advanceWithEvidence(store, {
          boardId,
          taskId,
          toStage: 'MAPPED',
          byRunId: author.runId,
          entityExpectedRev: 99,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: receiptOk,
        }),
      )
      const store2 = storageFor(baseTask('MAPPING', { entityRev: 1 }), [author])
      const staleBoard = await codeOf(() =>
        advanceWithEvidence(store2, {
          boardId,
          taskId,
          toStage: 'MAPPED',
          byRunId: author.runId,
          entityExpectedRev: 1,
          expectedBoardRev: 0,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPED', STAGE_FIELDS.MAPPED, {
            authorRunId: author.runId,
            receiptId: 'rcpt-stale-board',
          }),
        }),
      )
      const store3 = storageFor(baseTask('MAPPING', { entityRev: 1 }), [author])
      const staleHash = await codeOf(() =>
        advanceWithEvidence(store3, {
          boardId,
          taskId,
          toStage: 'MAPPED',
          byRunId: author.runId,
          entityExpectedRev: 1,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: 'wrong-task-hash',
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPED', STAGE_FIELDS.MAPPED, {
            authorRunId: author.runId,
            taskHash: 'wrong-task-hash',
            receiptId: 'rcpt-stale-hash',
          }),
        }),
      )
      // submit path also CAS on board rev
      const store4 = storageFor(baseTask('MAPPING', { entityRev: 1 }), [author])
      const submitStale = await codeOf(() =>
        submitStageEvidence(store4, {
          boardId,
          taskId,
          toStage: 'MAPPED',
          byRunId: author.runId,
          fields: STAGE_FIELDS.MAPPED,
          taskHash: TASK_HASH,
          canonicalHash: CANON_HASH,
          boardRev: 0,
          lifecycleRev: 1,
          entityExpectedRev: 1,
          receiptId: 'rcpt-submit-stale',
        }),
      )
      checks.push({
        id: 'AC-LIFE-FRESH-REVS-HASH',
        ok:
          staleEntity === 'STALE_REVISION' &&
          staleBoard === 'STALE_REVISION' &&
          staleHash === 'STALE_HASH' &&
          submitStale === 'STALE_REVISION',
        detail: `entity=${staleEntity} board=${staleBoard} hash=${staleHash} submit=${submitStale}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-FRESH-REVS-HASH',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-EXACT-RECEIPTS (full nine-stage rail) ----
    try {
      let task = baseTask(null)
      const author = run({
        runId: 'le-run-author',
        role: 'implementer',
        agentId: 'agent-a',
        model: 'grok-4.5',
        threadId: 'th-a',
      })
      const mappingVerifier = run({
        runId: 'le-run-map-v',
        role: 'mapping-verifier',
        agentId: 'agent-mv',
        model: 'claude-opus',
        threadId: 'th-mv',
      })
      const funcVerifier = run({
        runId: 'le-run-func-v',
        role: 'functional-verifier',
        agentId: 'agent-fv',
        model: 'claude-opus',
        threadId: 'th-fv',
      })
      const stagingVerifier = run({
        runId: 'le-run-stg-v',
        role: 'staging-verifier',
        agentId: 'agent-sv',
        model: 'claude-opus',
        threadId: 'th-sv',
      })
      const prodVerifier = run({
        runId: 'le-run-prod-v',
        role: 'product-readiness-verifier',
        agentId: 'agent-pv',
        model: 'claude-opus',
        threadId: 'th-pv',
      })
      const liveVerifier = run({
        runId: 'le-run-live-v',
        role: 'live-verifier',
        agentId: 'agent-lv',
        model: 'claude-opus',
        threadId: 'th-lv',
      })
      const runs = [
        author,
        mappingVerifier,
        funcVerifier,
        stagingVerifier,
        prodVerifier,
        liveVerifier,
      ]

      let boardRev = 1
      let lifecycleRev = 1
      let entityRev = 0
      let stagesOk = 0
      let lastHashOk = true
      let firstProgramHash = null

      for (const stage of V3_LIFECYCLE_RAIL) {
        const store = storageFor(task, runs, boardRev, lifecycleRev)
        const isVer = VERIFIER_STAGES.has(stage)
        const byRunId = isVer
          ? stage === 'MAP_VERIFIED'
            ? mappingVerifier.runId
            : stage === 'FUNCTIONAL'
              ? funcVerifier.runId
              : stage === 'STAGING_PROVEN'
                ? stagingVerifier.runId
                : stage === 'PROD_READY'
                  ? prodVerifier.runId
                  : liveVerifier.runId
          : author.runId

        // Prefer program-emit path (server hash) for first stage; put+hash for rest
        let receipt
        if (stage === 'MAPPING') {
          const registered = await submitStageEvidence(store, {
            boardId,
            taskId,
            toStage: stage,
            byRunId,
            fields: STAGE_FIELDS[stage],
            taskHash: TASK_HASH,
            canonicalHash: CANON_HASH,
            boardRev,
            lifecycleRev,
            entityExpectedRev: entityRev,
            receiptId: `rcpt-submit-${stage}`,
            authorRunId: author.runId,
            now: '2026-07-13T12:00:00.000Z',
          })
          receipt = registered.receipt
          firstProgramHash = receipt.receiptHash
          if (!registered.created || receipt.programmatic !== true || receipt.receiptHash.length !== 64) {
            lastHashOk = false
          }
          // exact hash must match pure compute
          const recomputed = computeStageReceiptHash({
            receiptId: receipt.receiptId,
            programmatic: receipt.programmatic,
            taskHash: receipt.taskHash,
            canonicalHash: receipt.canonicalHash,
            boardRev: receipt.boardRev,
            lifecycleRev: receipt.lifecycleRev,
            fields: receipt.fields,
            authorRunId: receipt.authorRunId,
            verifierRunId: receipt.verifierRunId,
            verdict: receipt.verdict,
            issuedAt: receipt.issuedAt,
          })
          if (recomputed !== receipt.receiptHash) lastHashOk = false
        } else {
          receipt = makeReceipt(stage, STAGE_FIELDS[stage], {
            boardRev,
            lifecycleRev,
            authorRunId: author.runId,
            verifierRunId: isVer ? byRunId : null,
            verdict: isVer ? 'PASS' : null,
            receiptId: `rcpt-exact-${stage}`,
          })
          await store.putStageEvidence({
            boardId,
            taskId,
            toStage: stage,
            receipt,
            emittingRunId: byRunId,
            registeredAt: receipt.issuedAt,
          })
        }

        const result = await advanceTaskV3(store, {
          boardId,
          taskId,
          toStage: stage,
          byRunId,
          entityExpectedRev: entityRev,
          expectedBoardRev: boardRev,
          expectedLifecycleRev: lifecycleRev,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt,
          productionApprovalId:
            stage === 'LIVE_VERIFIED' ? 'owner-prod-appr-le-1' : null,
          now: '2026-07-13T12:00:00.000Z',
        })

        if (
          result.ok &&
          result.stage === stage &&
          result.receipt.receiptHash === receipt.receiptHash &&
          result.readback.boardRev === boardRev + 1 &&
          result.readback.lifecycleRev === lifecycleRev + 1
        ) {
          stagesOk += 1
        }

        boardRev = result.boardRev
        lifecycleRev = result.lifecycleRev
        entityRev = result.entityRev
        task = (await store.getTask(boardId, taskId))
      }

      checks.push({
        id: 'AC-LIFE-EXACT-RECEIPTS',
        ok:
          stagesOk === 9 &&
          lastHashOk &&
          task?.stage === 'LIVE_VERIFIED' &&
          task?.history?.length === 9 &&
          Object.keys(task.stageReceipts || {}).length === 9 &&
          typeof firstProgramHash === 'string' &&
          firstProgramHash.length === 64,
        detail: `stagesOk=${stagesOk}/9 final=${task?.stage} history=${task?.history?.length} receipts=${Object.keys(task?.stageReceipts || {}).length} programHashLen=${firstProgramHash?.length ?? 0}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-EXACT-RECEIPTS',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-INDEPENDENT-VERIFIER ----
    try {
      const author = run({
        runId: 'le-run-a-iv',
        role: 'implementer',
        agentId: 'a-iv',
        model: 'm1',
        threadId: 't1',
      })
      const verifier = run({
        runId: 'le-run-v-iv',
        role: 'mapping-verifier',
        agentId: 'v-iv',
        model: 'm2',
        threadId: 't2',
      })
      const task = {
        ...baseTask('MAPPED', {
          entityRev: 1,
          implementerRunId: author.runId,
          implementerAgentId: author.agentId,
          implementerModel: author.model,
          implementerThreadId: author.threadId,
        }),
      }
      const store = storageFor(task, [author, verifier])
      const receipt = makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
        authorRunId: author.runId,
        verifierRunId: verifier.runId,
        verdict: 'PASS',
      })
      const result = await advanceWithEvidence(store, {
        boardId,
        taskId,
        toStage: 'MAP_VERIFIED',
        byRunId: verifier.runId,
        entityExpectedRev: 1,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON_HASH,
        receipt,
      })
      checks.push({
        id: 'AC-LIFE-INDEPENDENT-VERIFIER',
        ok:
          result.ok === true &&
          result.stage === 'MAP_VERIFIED' &&
          result.receipt.verifierRunId === verifier.runId &&
          result.receipt.authorRunId === author.runId &&
          author.runId !== verifier.runId &&
          author.agentId !== verifier.agentId &&
          author.model !== verifier.model &&
          author.threadId !== verifier.threadId,
        detail: `stage=${result.stage} author=${result.receipt.authorRunId} verifier=${result.receipt.verifierRunId}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-INDEPENDENT-VERIFIER',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-LEASE-FENCE ----
    try {
      // valid registered advance
      const valid = run({ runId: 'le-run-valid', role: 'implementer' })
      const storeValid = storageFor(baseTask(null), [valid])
      const okAdvance = await advanceWithEvidence(storeValid, {
        boardId,
        taskId,
        toStage: 'MAPPING',
        byRunId: valid.runId,
        entityExpectedRev: 0,
        expectedBoardRev: 1,
        expectedLifecycleRev: 1,
        expectedTaskHash: TASK_HASH,
        expectedCanonicalHash: CANON_HASH,
        receipt: makeReceipt('MAPPING', {}, {
          authorRunId: valid.runId,
          receiptId: 'rcpt-lease-valid',
        }),
      })

      const unreg = run({
        runId: 'le-run-unreg',
        role: 'implementer',
        registered: false,
      })
      const storeUnreg = storageFor(baseTask(null), [unreg])
      const codeUnreg = await codeOf(() =>
        advanceWithEvidence(storeUnreg, {
          boardId,
          taskId,
          toStage: 'MAPPING',
          byRunId: unreg.runId,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPING', {}, { receiptId: 'rcpt-unreg' }),
        }),
      )

      const expired = run({
        runId: 'le-run-exp',
        role: 'implementer',
        expiresAt: '2020-01-01T00:00:00.000Z',
      })
      const storeExp = storageFor(baseTask(null), [expired])
      const codeLease = await codeOf(() =>
        advanceWithEvidence(storeExp, {
          boardId,
          taskId,
          toStage: 'MAPPING',
          byRunId: expired.runId,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPING', {}, { receiptId: 'rcpt-exp' }),
          now: '2026-07-13T00:00:00.000Z',
        }),
      )

      const fenced = run({
        runId: 'le-run-fenced',
        role: 'implementer',
        fenced: true,
      })
      const storeFenced = storageFor(baseTask(null), [fenced])
      const codeFence = await codeOf(() =>
        advanceWithEvidence(storeFenced, {
          boardId,
          taskId,
          toStage: 'MAPPING',
          byRunId: fenced.runId,
          entityExpectedRev: 0,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAPPING', {}, { receiptId: 'rcpt-fenced' }),
        }),
      )

      checks.push({
        id: 'AC-LIFE-LEASE-FENCE',
        ok:
          okAdvance.ok === true &&
          okAdvance.stage === 'MAPPING' &&
          codeUnreg === 'RUN_NOT_REGISTERED' &&
          codeLease === 'LEASE_EXPIRED' &&
          codeFence === 'FENCED',
        detail: `valid=${okAdvance.stage} unreg=${codeUnreg} lease=${codeLease} fence=${codeFence}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-LEASE-FENCE',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-SELF-VERIFY ----
    try {
      const author = run({
        runId: 'le-run-self',
        role: 'implementer',
        agentId: 'same',
        model: 'm1',
        threadId: 't1',
      })
      const task = {
        ...baseTask('MAPPED', {
          entityRev: 1,
          implementerRunId: author.runId,
          implementerAgentId: author.agentId,
          implementerModel: author.model,
          implementerThreadId: author.threadId,
        }),
      }
      const store = storageFor(task, [author])
      const code = await codeOf(() =>
        advanceWithEvidence(store, {
          boardId,
          taskId,
          toStage: 'MAP_VERIFIED',
          byRunId: author.runId,
          entityExpectedRev: 1,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
            authorRunId: author.runId,
            verifierRunId: author.runId,
            verdict: 'PASS',
          }),
        }),
      )
      checks.push({
        id: 'AC-LIFE-SELF-VERIFY',
        ok: code === 'SELF_VERIFICATION',
        detail: `code=${code}`,
        code: code ?? undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-SELF-VERIFY',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-MODEL-ROLE ----
    try {
      const author = run({
        runId: 'le-run-a-mr',
        role: 'implementer',
        agentId: 'a',
        model: 'same-model',
        threadId: 't1',
      })
      const badRole = run({
        runId: 'le-run-bad-role',
        role: 'implementer',
        agentId: 'b',
        model: 'm2',
        threadId: 't2',
      })
      const sameModel = run({
        runId: 'le-run-same-model',
        role: 'mapping-verifier',
        agentId: 'c',
        model: 'same-model',
        threadId: 't3',
      })
      const taskBase = {
        ...baseTask('MAPPED', {
          entityRev: 1,
          implementerRunId: author.runId,
          implementerAgentId: author.agentId,
          implementerModel: author.model,
          implementerThreadId: author.threadId,
        }),
      }
      const storeRole = storageFor(taskBase, [author, badRole])
      const codeRole = await codeOf(() =>
        advanceWithEvidence(storeRole, {
          boardId,
          taskId,
          toStage: 'MAP_VERIFIED',
          byRunId: badRole.runId,
          entityExpectedRev: 1,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
            authorRunId: author.runId,
            verifierRunId: badRole.runId,
            verdict: 'PASS',
            receiptId: 'rcpt-bad-role',
          }),
        }),
      )
      const storeModel = storageFor(taskBase, [author, sameModel])
      const codeModel = await codeOf(() =>
        advanceWithEvidence(storeModel, {
          boardId,
          taskId,
          toStage: 'MAP_VERIFIED',
          byRunId: sameModel.runId,
          entityExpectedRev: 1,
          expectedBoardRev: 1,
          expectedLifecycleRev: 1,
          expectedTaskHash: TASK_HASH,
          expectedCanonicalHash: CANON_HASH,
          receipt: makeReceipt('MAP_VERIFIED', STAGE_FIELDS.MAP_VERIFIED, {
            authorRunId: author.runId,
            verifierRunId: sameModel.runId,
            verdict: 'PASS',
            receiptId: 'rcpt-same-model',
          }),
          requireOppositeModel: true,
        }),
      )
      checks.push({
        id: 'AC-LIFE-MODEL-ROLE',
        ok:
          codeRole === 'INVALID_VERIFIER_ROLE' &&
          codeModel === 'INVALID_MODEL_PAIRING',
        detail: `role=${codeRole} model=${codeModel}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-MODEL-ROLE',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-LIFE-G5-READONLY ----
    try {
      const pin = {
        canonicalSnapshotId: SNAP_ID,
        canonicalHash: CANON_HASH,
        taskHash: TASK_HASH,
        boardRev: 7,
        lifecycleRev: 3,
      }
      const domains = G5_REQUIRED_DOMAINS.map((id) => makePassingDomain(id, pin))
      const pass = evaluateG5(domains, pin)
      const derived = deriveG5Pass(domains, pin)

      // Caller-written g5Pass on a domain record must never be consulted.
      // evaluateG5 only reads domain status/evidence/pin fields.
      const poisoned = domains.map((d, i) =>
        i === 0
          ? {
              ...d,
              status: 'FAIL',
              g5Pass: true, // fabricant write — must not force pass
            }
          : d,
      )
      const poisonedEval = evaluateG5(poisoned, pin)
      const poisonedDerived = deriveG5Pass(poisoned, pin)

      // Missing domain → fail
      const missing = evaluateG5(domains.slice(0, 8), pin)

      // Stale board rev → fail
      const staleDom = domains.map((d) =>
        d.domainId === 'security' ? { ...d, boardRev: pin.boardRev - 1 } : d,
      )
      const staleEval = evaluateG5(staleDom, pin)

      // No write export on g5 module (read-only surface)
      const writeNames = Object.keys(g5mod).filter((k) =>
        /write|upsert|mutate|setG5|putG5/i.test(k),
      )

      checks.push({
        id: 'AC-LIFE-G5-READONLY',
        ok:
          pass.g5Pass === true &&
          derived === true &&
          poisonedEval.g5Pass === false &&
          poisonedDerived === false &&
          missing.g5Pass === false &&
          missing.missingDomains.length === 1 &&
          staleEval.g5Pass === false &&
          writeNames.length === 0 &&
          G5_REQUIRED_DOMAINS.length === 9 &&
          typeof LifecycleV3Error === 'function',
        detail: `pass=${pass.g5Pass} derived=${derived} poisoned=${poisonedEval.g5Pass} missing=${missing.g5Pass} stale=${staleEval.g5Pass} writeExports=${writeNames.join('|') || 'none'} domains=${G5_REQUIRED_DOMAINS.length}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-LIFE-G5-READONLY',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // Inventory completeness
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

    // ---- CLEANUP-TERMINALIZE (deterministic register → terminate) ----
    try {
      const boardStore = await loader.load('server/board-store.ts')
      const idem = await loader.load('server/idempotency.ts')
      const locksMod = await loader.load('server/locks.ts')
      const runMod = await loader.load('server/run-registry.ts')
      const {
        createFakeClock,
        createMemoryControlPlaneAtomicStore,
      } = boardStore
      const { createMemoryIdempotencyStorage } = idem
      const { createMemoryLockStore } = locksMod
      const {
        registerRun,
        terminateRun,
        createMemoryRunRegistryStore,
      } = runMod

      const clock = createFakeClock(Date.parse('2026-07-13T12:00:00.000Z'))
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
      const capacity = {
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
      const runDeps = {
        clock,
        runs,
        locks,
        atomic,
        idempotency,
        getCapacity: async () => capacity,
      }
      const runId = `${SYNTH_PREFIX}cleanup-term-1`
      const agentId = `${SYNTH_PREFIX}agent-cleanup`
      const board0 = await atomic.getBoardState(boardId)
      // Capacity authorized via getCapacity (complete family remainings); request-body capacity ignored (R3).
      const reg = await registerRun(runDeps, {
        boardId,
        runId,
        taskId: `${SYNTH_PREFIX}task-cleanup`,
        targetGate: 'FUNCTIONAL',
        agentId,
        model: 'grok-4.5',
        expectedEntityRev: 0,
        expectedBoardRev: board0.boardRev,
        canonicalHash: CANON_HASH,
        idempotencyKey: `${SYNTH_PREFIX}reg-cleanup-1`,
        initialState: 'RUNNING',
        collisionScopeLockIds: [`repo:${SYNTH_PREFIX}cleanup/**`],
      })
      const heldBefore = locks
        .snapshot()
        .collision.filter((l) => l.state === 'HELD' && l.runId === runId)
      let fenceDenied = false
      try {
        await terminateRun(runDeps, {
          boardId,
          runId,
          agentId,
          fencingToken: 'wrong-fence-cleanup',
          toState: 'CANCELLED',
          reason: 'lifecycle-evidence-smoke-cleanup-fence',
        })
      } catch (e) {
        fenceDenied = e?.code === 'FENCED'
      }
      const term = await terminateRun(runDeps, {
        boardId,
        runId,
        agentId,
        fencingToken: reg.fencingToken,
        toState: 'CANCELLED',
        reason: 'lifecycle-evidence-smoke-cleanup-terminalize',
      })
      const heldAfter = locks
        .snapshot()
        .collision.filter((l) => l.state === 'HELD' && l.runId === runId)
      const after = await runs.get(boardId, runId)
      const cleanupPlan = buildCleanupPlan({ boardId })
      const planHasTerminalize = cleanupPlan.steps.some(
        (s) => s.id === 'terminalize_synth_runs',
      )
      checks.push({
        id: 'CLEANUP-TERMINALIZE',
        ok:
          heldBefore.length >= 1 &&
          fenceDenied &&
          term.state === 'CANCELLED' &&
          after?.state === 'CANCELLED' &&
          heldAfter.length === 0 &&
          planHasTerminalize &&
          cleanupPlan.runIdPrefix === SYNTH_PREFIX &&
          cleanupPlan.stagingMutation === false,
        detail: `heldBefore=${heldBefore.length} fenceDenied=${fenceDenied} term=${term.state} heldAfter=${heldAfter.length} planSteps=${cleanupPlan.steps.length}`,
      })
    } catch (e) {
      checks.push({
        id: 'CLEANUP-TERMINALIZE',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // Gate helper self-check
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
        'g5_write_unsupported_by_design',
        'live_mcp_driver_not_auto_executed',
        'cleanup_not_auto_executed',
      ],
    }
  } finally {
    await loader.close()
  }
}

/**
 * Real/staging path: gates + plan only unless EXECUTE + target; live MCP is
 * intentionally not auto-executed — returns refuse when execute requested
 * without full target, or plan when gates ok without execute.
 * Cleanup remains plan-only (operator terminalizes synth-le-* runs).
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

  const plan = buildStagingLifecycleEvidencePlan({
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
      code: 'LIFECYCLE_EVIDENCE_PLAN',
      stagingMutation: false,
      message:
        'Gates + live-pin bind OK. Default non-mutating plan. Set CAIRN_LIFECYCLE_EVIDENCE_EXECUTE=1 + STAGING_URL + ROOT bearer for live MCP (not run by default). Always run cleanup plan after any live synth register/advance.',
      plan,
      cleanup,
      residual_gaps: plan.residual_gaps,
    }
  }

  if (!gate.executeAllowed) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'LIFECYCLE_EVIDENCE_EXECUTE_TARGET_MISSING',
      message: gate.message,
      stagingMutation: false,
      residual_gaps: ['execute_without_url_or_bearer'],
      plan,
      cleanup,
    }
  }

  return {
    ok: false,
    mode: 'apply-refused',
    code: 'LIFECYCLE_EVIDENCE_LIVE_MCP_NOT_AUTO_EXECUTED',
    message:
      'EXECUTE gates satisfied, but this harness intentionally does not auto-mutate staging. Use plan steps with an operator-owned MCP driver, or extend this flow with explicit live client under separate approval. Cleanup/terminalize of synth-le-* remains mandatory after any live register.',
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
    const plan = buildStagingLifecycleEvidencePlan({
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

  // default / --self-test
  const self = await runLifecycleEvidenceSelfTests()
  const receipt = writeReceipt(self)
  console.log(
    JSON.stringify(
      {
        ok: self.ok,
        mode: self.mode,
        harnessId: self.harnessId,
        stagingMutation: self.stagingMutation,
        checkCount: self.checkCount,
        passCount: self.passCount,
        failures: self.failures,
        residual_gaps: self.residual_gaps,
        cleanup: self.cleanup,
        receipt,
      },
      null,
      2,
    ),
  )
  process.exit(self.ok ? 0 : 1)
}

const isDirect =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === process.argv[1]

if (isDirect) {
  main().catch((e) => {
    console.error(String(e?.stack || e))
    process.exit(2)
  })
}
