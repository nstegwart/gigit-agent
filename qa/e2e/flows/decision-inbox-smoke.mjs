#!/usr/bin/env node
/**
 * Decision inbox V3 conformance harness (staging-oriented, default dry self-test).
 *
 * Modes:
 *   --self-test | (default)  product-engine memory suite via Vite SSR (no network)
 *   --plan                   emit ordered staging MCP step plan (no mutation)
 *   --real | --apply         requires dual staging mutation gates; plan-only
 *                            unless CAIRN_DECISION_INBOX_EXECUTE=1 (live MCP reserved;
 *                            this harness refuses silent live mutation — default dry)
 *   --cleanup                emit cleanup plan for synth harness decision ids (no mutation)
 *
 * Env for gated staging path (plan / refuse / future execute):
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_DECISION_INBOX_APPLY=1
 *   CAIRN_DECISION_INBOX_BIND_LIVE_PIN=1
 *   CAIRN_DECISION_INBOX_EXECUTE=1   # only then would live MCP run (still needs URL+bearer)
 *   STAGING_URL  STAGING_ROOT_BEARER_TOKEN  BOARD_ID  EXPECTED_SHA (optional)
 *
 * Covers:
 *   AC-ORDER            deterministic inbox ordering
 *   AC-BLOCK-SNOOZE     blocking cannot hide via snooze; non-blocking can
 *   AC-ACK              OPEN → ACKNOWLEDGED (owner envelope)
 *   AC-RESOLVED         option select → RESOLVED (+ declining still RESOLVED)
 *   AC-REJECTED         request reject → REJECTED (not declining option)
 *   AC-EXPIRED          due/expiry flips OPEN → EXPIRED on list
 *   AC-SCOPED-APPROVAL  scopedApprovalId on resolve + audit detail
 *   AC-REV-CAS          expectedRev / boardRev / pin STALE_REVISION
 *   AC-IDEMPOTENCY      same-key REPLAY no double board bump; body conflict
 *   AC-OWNER-ONLY       resolve_decision_v3 OWNER-only (RBAC gate)
 *   AC-AUDIT            material audit readback (OPENED/RESOLVED/REJECTED/SNOOZED)
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

export const HARNESS_ID = 'decision-inbox-smoke-v1'
export const BOARD_DEFAULT = 'mfs-rebuild'
export const CANON_HASH = 'canon-decision-inbox-smoke-v1'
export const SYNTH_PREFIX = 'synth-di-'

/** Scenario inventory — every row must produce a self-test check id. */
export const SCENARIO_MATRIX = Object.freeze([
  {
    id: 'AC-ORDER',
    name: 'deterministic ordering',
    product: 'compareDecisionsV3: blocking → severity → dueAt → createdAt → id',
    stagingTool: 'list_decisions',
  },
  {
    id: 'AC-BLOCK-SNOOZE',
    name: 'blocking vs snooze hide',
    product: 'snoozeDecisionV3 SNOOZE_BLOCKED; non-blocking hidden until snoozedUntil',
    stagingTool: null,
  },
  {
    id: 'AC-ACK',
    name: 'acknowledge OPEN → ACKNOWLEDGED',
    product: 'acknowledgeDecisionV3 sets status+ownerId',
    stagingTool: null,
  },
  {
    id: 'AC-RESOLVED',
    name: 'resolve selected option → RESOLVED',
    product: 'resolveDecisionV3; declining option still RESOLVED',
    stagingTool: 'resolve_decision_v3',
  },
  {
    id: 'AC-REJECTED',
    name: 'reject request → REJECTED',
    product: 'rejectDecisionV3 (not declining option)',
    stagingTool: null,
  },
  {
    id: 'AC-EXPIRED',
    name: 'lazy expiry OPEN → EXPIRED',
    product: 'listDecisionsV3 advances past expiresAt',
    stagingTool: 'list_decisions',
  },
  {
    id: 'AC-SCOPED-APPROVAL',
    name: 'scoped approvalId on resolve + audit',
    product: 'scopedApprovalId persisted; DECISION_RESOLVED audit detail',
    stagingTool: 'resolve_decision_v3',
  },
  {
    id: 'AC-REV-CAS',
    name: 'expectedRev/boardRev/pin CAS',
    product: 'STALE_REVISION on wrong entityRev, boardRev, pin hash',
    stagingTool: 'resolve_decision_v3',
  },
  {
    id: 'AC-IDEMPOTENCY',
    name: 'idempotent REPLAY + body conflict',
    product: 'same key no double board bump; different body IDEMPOTENCY_CONFLICT',
    stagingTool: 'open_decision_v3',
  },
  {
    id: 'AC-OWNER-ONLY',
    name: 'owner-only resolution RBAC',
    product: 'authorizeToolCall resolve_decision_v3 OWNER ok; AGENT/ROOT denied',
    stagingTool: 'resolve_decision_v3',
  },
  {
    id: 'AC-AUDIT',
    name: 'audit readback for material decision events',
    product: 'atomic.listAudit DECISION_OPENED/RESOLVED/REJECTED/SNOOZED',
    stagingTool: 'list_audit',
  },
])

export const REQUIRED_STAGING_ENV = Object.freeze({
  CAIRN_ENV: 'staging',
  CAIRN_DB_NAME: 'cairn_tm_v3_staging',
  CAIRN_STAGING_SEED_APPROVED: '1',
  CAIRN_DECISION_INBOX_APPLY: '1',
  CAIRN_DECISION_INBOX_BIND_LIVE_PIN: '1',
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
      code: 'CAIRN_DECISION_INBOX_GATES_REFUSED',
      missing,
      message: `staging decision-inbox mutation refused — set exact dual gates: ${missing.join(', ')}`,
      executeAllowed: false,
    }
  }
  const execute = env.CAIRN_DECISION_INBOX_EXECUTE === '1'
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
    code: 'CAIRN_DECISION_INBOX_GATES_OK',
    missing: [],
    message: execute
      ? hasUrl && hasBearer
        ? 'gates+execute+target present (live path reserved)'
        : 'EXECUTE=1 but STAGING_URL and/or ROOT bearer missing'
      : 'gates OK — default non-mutating plan (set CAIRN_DECISION_INBOX_EXECUTE=1 for live)',
    executeAllowed: execute && hasUrl && hasBearer,
    executeRequested: execute,
    hasUrl,
    hasBearer,
  }
}

/**
 * Ordered staging MCP plan (args skeletons only — never invents revs/hashes).
 * @param {{ boardId?: string, expectedSha?: string }} [opts]
 */
export function buildStagingDecisionInboxPlan(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  return {
    harnessId: HARNESS_ID,
    boardId,
    expectedSha: opts.expectedSha ?? null,
    residual_gaps: [
      'live_staging_not_exercised_in_plan_mode',
      'mcp_ack_snooze_reject_may_be_owner_serverfn_not_mcp',
      'cleanup_requires_explicit_operator_or_--cleanup_plan',
    ],
    cleanup: {
      decisionIdPrefix: SYNTH_PREFIX,
      note: 'After live run, cancel/expire only synth-di-* decisions created by this harness; never touch production-derived rows',
    },
    steps: [
      {
        id: 'healthz_pin',
        tool: 'healthz',
        purpose: 'bind live pin boardRev/lifecycleRev/canonicalHash/deployedSha',
        mutates: false,
      },
      {
        id: 'list_decisions_baseline',
        tool: 'list_decisions',
        purpose: 'AC-ORDER baseline ordering before synth open',
        mutates: false,
      },
      {
        id: 'open_blocking_critical',
        tool: 'open_decision_v3',
        purpose: 'open synth blocking CRITICAL for order + block tests',
        mutates: true,
        note: 'entityExpectedRev=0; expectedBoardRev+canonicalHash from live pin; decisionId synth-di-*',
      },
      {
        id: 'open_nonblocking_low',
        tool: 'open_decision_v3',
        purpose: 'open non-blocking LOW for snooze/hide path',
        mutates: true,
      },
      {
        id: 'open_expiring',
        tool: 'open_decision_v3',
        purpose: 'open with short expiresAt for AC-EXPIRED (or wait + list)',
        mutates: true,
      },
      {
        id: 'list_decisions_order',
        tool: 'list_decisions',
        purpose: 'AC-ORDER assert blocking CRITICAL sorts before non-blocking',
        mutates: false,
      },
      {
        id: 'resolve_stale_rev_negative',
        tool: 'resolve_decision_v3',
        purpose: 'AC-REV-CAS wrong expectedRev → STALE_REVISION',
        mutates: false,
        expectCode: 'STALE_REVISION',
      },
      {
        id: 'resolve_owner_ok',
        tool: 'resolve_decision_v3',
        purpose: 'AC-RESOLVED + AC-SCOPED-APPROVAL + AC-OWNER-ONLY (OWNER bearer)',
        mutates: true,
        note: 'scopedApprovalId must be staging-scoped approval id only',
      },
      {
        id: 'resolve_non_owner_negative',
        tool: 'resolve_decision_v3',
        purpose: 'AC-OWNER-ONLY AGENT/ROOT bearer → FORBIDDEN_ROLE',
        mutates: false,
        expectCode: 'FORBIDDEN_ROLE',
      },
      {
        id: 'open_idempotent_replay',
        tool: 'open_decision_v3',
        purpose: 'AC-IDEMPOTENCY same key+body REPLAY no extra board bump',
        mutates: false,
      },
      {
        id: 'list_audit_readback',
        tool: 'list_audit',
        purpose: 'AC-AUDIT material DECISION_* events for synth subjects',
        mutates: false,
      },
      {
        id: 'cleanup_synth',
        tool: 'operator_cleanup',
        purpose: 'remove or terminal-state only synth-di-* harness decisions',
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
 * Cleanup plan for synth harness rows (never auto-executes).
 * @param {{ boardId?: string }} [opts]
 */
export function buildCleanupPlan(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  return {
    harnessId: HARNESS_ID,
    boardId,
    mode: 'cleanup-plan',
    stagingMutation: false,
    decisionIdPrefix: SYNTH_PREFIX,
    residual_gaps: [
      'cleanup_not_auto_executed',
      'requires_staging_gates_plus_operator_driver',
    ],
    steps: [
      {
        id: 'list_synth_decisions',
        tool: 'list_decisions',
        purpose: `filter decisionId starting with ${SYNTH_PREFIX}`,
        mutates: false,
      },
      {
        id: 'terminal_or_cancel_synth',
        tool: 'operator_cleanup',
        purpose: 'cancel/expire only synth harness decisions; never non-synth rows',
        mutates: true,
      },
      {
        id: 'audit_verify_cleanup',
        tool: 'list_audit',
        purpose: 'confirm no leftover open synth-di-* decisions',
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
    account: args.real ? 'ROOT/OWNER bearer env-ref only' : 'n/a-memory',
    device: 'n/a',
    boardId: env.BOARD_ID || BOARD_DEFAULT,
    schema: env.SCHEMA_VERSION || '006',
    expectedSha: env.EXPECTED_SHA || null,
    execute: env.CAIRN_DECISION_INBOX_EXECUTE === '1',
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
  node qa/e2e/flows/decision-inbox-smoke.mjs --self-test
  node qa/e2e/flows/decision-inbox-smoke.mjs --plan
  node qa/e2e/flows/decision-inbox-smoke.mjs --cleanup
  node qa/e2e/flows/decision-inbox-smoke.mjs --real   # dual gates; plan unless EXECUTE=1

Env (gated real):
  CAIRN_ENV=staging CAIRN_DB_NAME=cairn_tm_v3_staging
  CAIRN_STAGING_SEED_APPROVED=1 CAIRN_DECISION_INBOX_APPLY=1
  CAIRN_DECISION_INBOX_BIND_LIVE_PIN=1
  CAIRN_DECISION_INBOX_EXECUTE=1  # required for any live MCP mutation
  STAGING_URL STAGING_ROOT_BEARER_TOKEN BOARD_ID EXPECTED_SHA

Default is dry self-test against product engines (memory). No live mutation without EXECUTE.
Cleanup is plan-only; operator executes terminalization of ${SYNTH_PREFIX}* decisions.
`)
}

export function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `decision-inbox-smoke-${payload.mode || 'run'}-${Date.now()}.json`
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

function opt(optionId, label, extra = {}) {
  return { optionId, label, declining: false, ...extra }
}

/**
 * Product-engine dry self-test (memory stores). Exercises full SCENARIO_MATRIX.
 * @param {{ boardId?: string }} [opts]
 */
export async function runDecisionInboxSelfTests(opts = {}) {
  const boardId = opts.boardId || BOARD_DEFAULT
  /** @type {Check[]} */
  const checks = []
  const loader = await createProductLoader()
  try {
    const boardStore = await loader.load('server/board-store.ts')
    const idem = await loader.load('server/idempotency.ts')
    const decMod = await loader.load('server/decisions-v3.ts')
    const rbacMod = await loader.load('server/rbac.ts')

    const {
      createFakeClock,
      createMemoryControlPlaneAtomicStore,
    } = boardStore
    const { createMemoryIdempotencyStorage } = idem
    const {
      acknowledgeDecisionV3,
      compareDecisionsV3,
      createMemoryDecisionV3Store,
      listDecisionsV3,
      openDecisionV3,
      rejectDecisionV3,
      resolveDecisionV3,
      snoozeDecisionV3,
    } = decMod
    const { authorizeToolCall, principalFromSession } = rbacMod

    const clock = createFakeClock(Date.parse('2026-07-13T10:00:00.000Z'))
    const decisions = createMemoryDecisionV3Store()
    const atomic = createMemoryControlPlaneAtomicStore([
      {
        boardId,
        boardRev: 0,
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      },
    ])
    const idempotency = createMemoryIdempotencyStorage()
    const deps = { clock, decisions, atomic, idempotency }

    const pin = CANON_HASH
    let keySeq = 0
    const uniqKey = (p) => {
      keySeq += 1
      return `${p}-${keySeq}`
    }

    const openBase = (over) =>
      openDecisionV3(deps, {
        boardId,
        type: over.type ?? 'harness_choice',
        severity: over.severity ?? 'LOW',
        title: over.title ?? `synth ${over.decisionId}`,
        question: 'q?',
        options: [opt('o1', 'yes'), opt('o2', 'no', { declining: true })],
        blocking: over.blocking ?? false,
        entityExpectedRev: 0,
        expectedBoardRev: over.expectedBoardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('open'),
        actorId: 'synth-agent',
        decisionId: over.decisionId,
        expiresAt: over.expiresAt ?? null,
        dueAt: over.dueAt ?? null,
      })

    // ---- AC-ORDER ----
    try {
      const baseRow = {
        boardId,
        projectId: null,
        featureId: null,
        taskId: null,
        runId: null,
        type: 't',
        title: 't',
        question: 'q',
        evidence: [],
        options: [],
        agentRecommendation: null,
        snoozedUntil: null,
        snoozedUntilMs: null,
        status: 'OPEN',
        ownerId: null,
        resolverId: null,
        selectedOptionId: null,
        comment: null,
        expectedRev: 0,
        boardRev: 1,
        entityRev: 1,
        scopedApprovalId: null,
        auditIds: [],
        expiresAt: null,
        expiresAtMs: null,
        dueAt: null,
        dueAtMs: null,
        createdAt: '2026-07-13T10:00:00.000Z',
        createdAtMs: 0,
      }
      const rows = [
        { ...baseRow, decisionId: 'D-low', severity: 'LOW', blocking: false, createdAtMs: 100 },
        {
          ...baseRow,
          decisionId: 'D-block-med',
          severity: 'MEDIUM',
          blocking: true,
          createdAtMs: 50,
        },
        {
          ...baseRow,
          decisionId: 'D-high-due-late',
          severity: 'HIGH',
          blocking: false,
          dueAt: '2026-07-14T00:00:00.000Z',
          dueAtMs: 2000,
          createdAtMs: 10,
        },
        {
          ...baseRow,
          decisionId: 'D-high-due-early',
          severity: 'HIGH',
          blocking: false,
          dueAt: '2026-07-13T12:00:00.000Z',
          dueAtMs: 1000,
          createdAtMs: 10,
        },
        {
          ...baseRow,
          decisionId: 'D-crit',
          severity: 'CRITICAL',
          blocking: false,
          createdAtMs: 1,
        },
        {
          ...baseRow,
          decisionId: 'D-high-null-due',
          severity: 'HIGH',
          blocking: false,
          dueAtMs: null,
          createdAtMs: 5,
        },
      ]
      const sorted = [...rows].sort(compareDecisionsV3).map((d) => d.decisionId)
      const orderOk =
        sorted[0] === 'D-block-med' &&
        sorted[1] === 'D-crit' &&
        sorted.indexOf('D-high-due-early') < sorted.indexOf('D-high-due-late') &&
        sorted.indexOf('D-high-due-late') < sorted.indexOf('D-high-null-due') &&
        sorted[sorted.length - 1] === 'D-low'
      checks.push({
        id: 'AC-ORDER',
        ok: orderOk,
        detail: `sorted=${sorted.join(',')}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-ORDER',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-BLOCK-SNOOZE ----
    try {
      const board0 = await atomic.getBoardState(boardId)
      const nonBlock = await openBase({
        decisionId: `${SYNTH_PREFIX}nb-snooze`,
        expectedBoardRev: board0.boardRev,
        blocking: false,
        severity: 'LOW',
      })
      const board1 = await atomic.getBoardState(boardId)
      const block = await openBase({
        decisionId: `${SYNTH_PREFIX}block-snooze`,
        expectedBoardRev: board1.boardRev,
        blocking: true,
        severity: 'HIGH',
      })
      const until = '2026-07-13T12:00:00.000Z'
      // CAS board rev must be current (later opens bump board after earlier open snapshots).
      const boardForSnooze = await atomic.getBoardState(boardId)
      const snoozed = await snoozeDecisionV3(deps, {
        boardId,
        decisionId: nonBlock.decisionId,
        actorId: 'owner',
        expectedRev: nonBlock.entityRev,
        expectedBoardRev: boardForSnooze.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('snooze-nb'),
        snoozedUntil: until,
      })
      let blockSnoozeCode = null
      try {
        const boardForBlockSnooze = await atomic.getBoardState(boardId)
        await snoozeDecisionV3(deps, {
          boardId,
          decisionId: block.decisionId,
          actorId: 'owner',
          expectedRev: block.entityRev,
          expectedBoardRev: boardForBlockSnooze.boardRev,
          canonicalHash: pin,
          currentPinHash: pin,
          idempotencyKey: uniqKey('snooze-b'),
          snoozedUntil: until,
        })
      } catch (e) {
        blockSnoozeCode = e?.code ?? null
      }
      const listed = await listDecisionsV3(deps, boardId)
      const ids = listed.map((d) => d.decisionId)
      const nbHidden = !ids.includes(nonBlock.decisionId)
      const blockVisible = ids.includes(block.decisionId)
      checks.push({
        id: 'AC-BLOCK-SNOOZE',
        ok:
          blockSnoozeCode === 'SNOOZE_BLOCKED' &&
          snoozed.snoozedUntil === until &&
          nbHidden &&
          blockVisible,
        detail: `blockSnooze=${blockSnoozeCode} nbHidden=${nbHidden} blockVisible=${blockVisible} snoozedUntil=${snoozed.snoozedUntil}`,
        code: blockSnoozeCode ?? undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-BLOCK-SNOOZE',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-ACK ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}ack`,
        expectedBoardRev: board.boardRev,
      })
      const ack = await acknowledgeDecisionV3(deps, {
        boardId,
        decisionId: open.decisionId,
        actorId: 'owner-ack',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('ack'),
      })
      checks.push({
        id: 'AC-ACK',
        ok: ack.status === 'ACKNOWLEDGED' && ack.ownerId === 'owner-ack' && ack.entityRev === open.entityRev + 1,
        detail: `status=${ack.status} ownerId=${ack.ownerId} entityRev=${ack.entityRev}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-ACK',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-RESOLVED (incl. declining option still RESOLVED) ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}resolve`,
        expectedBoardRev: board.boardRev,
      })
      const resolved = await resolveDecisionV3(deps, {
        boardId,
        decisionId: open.decisionId,
        actorId: 'owner-resolve',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('resolve'),
        selectedOptionId: 'o1',
        comment: 'harness resolve',
      })
      const board2 = await atomic.getBoardState(boardId)
      const openDecline = await openBase({
        decisionId: `${SYNTH_PREFIX}resolve-decline`,
        expectedBoardRev: board2.boardRev,
      })
      const declined = await resolveDecisionV3(deps, {
        boardId,
        decisionId: openDecline.decisionId,
        actorId: 'owner-resolve',
        expectedRev: openDecline.entityRev,
        expectedBoardRev: openDecline.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('resolve-decline'),
        selectedOptionId: 'o2',
      })
      checks.push({
        id: 'AC-RESOLVED',
        ok:
          resolved.status === 'RESOLVED' &&
          resolved.selectedOptionId === 'o1' &&
          resolved.resolverId === 'owner-resolve' &&
          declined.status === 'RESOLVED' &&
          declined.selectedOptionId === 'o2',
        detail: `resolved=${resolved.status}/${resolved.selectedOptionId} declined=${declined.status}/${declined.selectedOptionId}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-RESOLVED',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-REJECTED ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}reject`,
        expectedBoardRev: board.boardRev,
      })
      const rejected = await rejectDecisionV3(deps, {
        boardId,
        decisionId: open.decisionId,
        actorId: 'owner-reject',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('reject'),
        comment: 'harness reject request',
      })
      checks.push({
        id: 'AC-REJECTED',
        ok:
          rejected.status === 'REJECTED' &&
          rejected.selectedOptionId === null &&
          rejected.resolverId === 'owner-reject',
        detail: `status=${rejected.status} selected=${rejected.selectedOptionId} resolver=${rejected.resolverId}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-REJECTED',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-EXPIRED ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}expire`,
        expectedBoardRev: board.boardRev,
        expiresAt: '2026-07-13T10:05:00.000Z',
      })
      clock.advance(6 * 60_000)
      const listedTerm = await listDecisionsV3(deps, boardId, { includeTerminal: true })
      const row = listedTerm.find((x) => x.decisionId === open.decisionId)
      const openOnly = await listDecisionsV3(deps, boardId)
      const hiddenFromOpen = !openOnly.find((x) => x.decisionId === open.decisionId)
      checks.push({
        id: 'AC-EXPIRED',
        ok: row?.status === 'EXPIRED' && hiddenFromOpen,
        detail: `status=${row?.status} hiddenFromOpen=${hiddenFromOpen}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-EXPIRED',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-SCOPED-APPROVAL ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}scoped-appr`,
        expectedBoardRev: board.boardRev,
      })
      const approvalId = 'appr-staging-di-001'
      const resolved = await resolveDecisionV3(deps, {
        boardId,
        decisionId: open.decisionId,
        actorId: 'owner-appr',
        expectedRev: open.entityRev,
        expectedBoardRev: open.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: uniqKey('resolve-appr'),
        selectedOptionId: 'o1',
        scopedApprovalId: approvalId,
      })
      const audit = await atomic.listAudit(boardId)
      const resolveEvt = audit.find(
        (a) =>
          a.kind === 'DECISION_RESOLVED' &&
          a.subjectId === open.decisionId &&
          a.detail?.scopedApprovalId === approvalId,
      )
      checks.push({
        id: 'AC-SCOPED-APPROVAL',
        ok: resolved.scopedApprovalId === approvalId && !!resolveEvt,
        detail: `scopedApprovalId=${resolved.scopedApprovalId} auditHit=${!!resolveEvt}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-SCOPED-APPROVAL',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-REV-CAS ----
    try {
      const board = await atomic.getBoardState(boardId)
      const open = await openBase({
        decisionId: `${SYNTH_PREFIX}rev-cas`,
        expectedBoardRev: board.boardRev,
      })
      let staleEntity = null
      try {
        await acknowledgeDecisionV3(deps, {
          boardId,
          decisionId: open.decisionId,
          actorId: 'owner',
          expectedRev: open.entityRev + 99,
          expectedBoardRev: open.boardRev,
          canonicalHash: pin,
          currentPinHash: pin,
          idempotencyKey: uniqKey('ack-stale-ent'),
        })
      } catch (e) {
        staleEntity = e?.code ?? null
      }
      let staleBoard = null
      try {
        await acknowledgeDecisionV3(deps, {
          boardId,
          decisionId: open.decisionId,
          actorId: 'owner',
          expectedRev: open.entityRev,
          expectedBoardRev: open.boardRev + 99,
          canonicalHash: pin,
          currentPinHash: pin,
          idempotencyKey: uniqKey('ack-stale-br'),
        })
      } catch (e) {
        staleBoard = e?.code ?? null
      }
      let stalePin = null
      try {
        await acknowledgeDecisionV3(deps, {
          boardId,
          decisionId: open.decisionId,
          actorId: 'owner',
          expectedRev: open.entityRev,
          expectedBoardRev: open.boardRev,
          canonicalHash: pin,
          currentPinHash: 'wrong-pin-hash',
          idempotencyKey: uniqKey('ack-stale-pin'),
        })
      } catch (e) {
        stalePin = e?.code ?? null
      }
      const stillOpen = await decisions.get(boardId, open.decisionId)
      checks.push({
        id: 'AC-REV-CAS',
        ok:
          staleEntity === 'STALE_REVISION' &&
          staleBoard === 'STALE_REVISION' &&
          stalePin === 'STALE_REVISION' &&
          stillOpen?.status === 'OPEN' &&
          stillOpen?.entityRev === open.entityRev,
        detail: `entity=${staleEntity} board=${staleBoard} pin=${stalePin} status=${stillOpen?.status} entityRev=${stillOpen?.entityRev}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-REV-CAS',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-IDEMPOTENCY ----
    try {
      const boardBefore = await atomic.getBoardState(boardId)
      const openKey = uniqKey('open-idem')
      const openBody = {
        boardId,
        decisionId: `${SYNTH_PREFIX}idem-open`,
        type: 'harness_choice',
        severity: 'MEDIUM',
        title: 'idem open',
        question: 'q?',
        options: [opt('o1', 'yes'), opt('o2', 'no')],
        blocking: false,
        entityExpectedRev: 0,
        expectedBoardRev: boardBefore.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: openKey,
        actorId: 'synth-agent',
      }
      const first = await openDecisionV3(deps, openBody)
      const boardAfterFirst = await atomic.getBoardState(boardId)
      const replay = await openDecisionV3(deps, openBody)
      const boardAfterReplay = await atomic.getBoardState(boardId)
      let conflictCode = null
      try {
        await openDecisionV3(deps, {
          ...openBody,
          title: 'idem open DIFFERENT BODY',
        })
      } catch (e) {
        conflictCode = e?.code ?? null
      }
      // owner ack idempotency
      const ackKey = uniqKey('ack-idem')
      const ack1 = await acknowledgeDecisionV3(deps, {
        boardId,
        decisionId: first.decisionId,
        actorId: 'owner-idem',
        expectedRev: first.entityRev,
        expectedBoardRev: first.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: ackKey,
      })
      const boardAfterAck = await atomic.getBoardState(boardId)
      const ackReplay = await acknowledgeDecisionV3(deps, {
        boardId,
        decisionId: first.decisionId,
        actorId: 'owner-idem',
        expectedRev: first.entityRev,
        expectedBoardRev: first.boardRev,
        canonicalHash: pin,
        currentPinHash: pin,
        idempotencyKey: ackKey,
      })
      const boardAfterAckReplay = await atomic.getBoardState(boardId)
      checks.push({
        id: 'AC-IDEMPOTENCY',
        ok:
          first.decisionId === replay.decisionId &&
          boardAfterReplay.boardRev === boardAfterFirst.boardRev &&
          conflictCode === 'IDEMPOTENCY_CONFLICT' &&
          ack1.status === 'ACKNOWLEDGED' &&
          ackReplay.status === 'ACKNOWLEDGED' &&
          boardAfterAckReplay.boardRev === boardAfterAck.boardRev,
        detail: `openReplayNoBump=${boardAfterReplay.boardRev === boardAfterFirst.boardRev} conflict=${conflictCode} ackReplayNoBump=${boardAfterAckReplay.boardRev === boardAfterAck.boardRev}`,
        code: conflictCode ?? undefined,
      })
    } catch (e) {
      checks.push({
        id: 'AC-IDEMPOTENCY',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-OWNER-ONLY (RBAC gate on resolve_decision_v3) ----
    try {
      const owner = principalFromSession({
        id: 'u-owner',
        username: 'owner',
        role: 'admin',
        boards: [],
      })
      const member = principalFromSession({
        id: 'u-member',
        username: 'member',
        role: 'member',
        boards: [boardId],
      })
      // bearer-style principals for AGENT / ROOT
      const agent = {
        actorId: 'agent-1',
        role: 'AGENT',
        channel: 'bearer',
        scopes: rbacMod.defaultScopesForRole('AGENT'),
        boards: [boardId],
        agentId: 'agent-1',
      }
      const root = {
        actorId: 'root-1',
        role: 'ROOT_ORCHESTRATOR',
        channel: 'bearer',
        scopes: rbacMod.defaultScopesForRole('ROOT_ORCHESTRATOR'),
        boards: [],
      }
      const ownerOk = authorizeToolCall(owner, 'resolve_decision_v3', { boardId }).ok === true
      const agentDenied = authorizeToolCall(agent, 'resolve_decision_v3', { boardId })
      const rootDenied = authorizeToolCall(root, 'resolve_decision_v3', { boardId })
      const memberDenied = authorizeToolCall(member, 'resolve_decision_v3', { boardId })
      const ownerOpenOk = authorizeToolCall(owner, 'open_decision_v3', { boardId }).ok === true
      checks.push({
        id: 'AC-OWNER-ONLY',
        ok:
          ownerOk &&
          ownerOpenOk &&
          agentDenied.ok === false &&
          (agentDenied.code === 'FORBIDDEN_ROLE' || agentDenied.code === 'FORBIDDEN_SCOPE') &&
          rootDenied.ok === false &&
          memberDenied.ok === false,
        detail: `owner=${ownerOk} agent=${agentDenied.code} root=${rootDenied.code} member=${memberDenied.code} openOwner=${ownerOpenOk}`,
        code: agentDenied.code,
      })
    } catch (e) {
      checks.push({
        id: 'AC-OWNER-ONLY',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // ---- AC-AUDIT ----
    try {
      const audit = await atomic.listAudit(boardId)
      const kinds = new Set(audit.map((a) => a.kind))
      const hasOpened = kinds.has('DECISION_OPENED')
      const hasResolved = kinds.has('DECISION_RESOLVED')
      const hasRejected = kinds.has('DECISION_REJECTED')
      const hasSnoozed = kinds.has('DECISION_SNOOZED')
      const synthSubjects = audit.filter(
        (a) =>
          typeof a.subjectId === 'string' &&
          a.subjectId.startsWith(SYNTH_PREFIX) &&
          a.subjectType === 'decision',
      )
      checks.push({
        id: 'AC-AUDIT',
        ok:
          hasOpened &&
          hasResolved &&
          hasRejected &&
          hasSnoozed &&
          synthSubjects.length >= 4,
        detail: `opened=${hasOpened} resolved=${hasResolved} rejected=${hasRejected} snoozed=${hasSnoozed} synthSubjects=${synthSubjects.length}`,
      })
    } catch (e) {
      checks.push({
        id: 'AC-AUDIT',
        ok: false,
        detail: String(e?.message || e),
        code: e?.code,
      })
    }

    // Inventory completeness
    const expectedIds = SCENARIO_MATRIX.map((s) => s.id)
    const gotIds = checks.map((c) => c.id)
    const inventoryOk =
      expectedIds.every((id) => gotIds.includes(id)) && checks.length === expectedIds.length
    checks.push({
      id: 'SCENARIO-INVENTORY',
      ok: inventoryOk,
      detail: `expected=${expectedIds.join(',')} got=${gotIds.join(',')}`,
    })

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
      residual_gaps: [
        'live_staging_mcp_not_exercised_self_test_only',
        'mcp_ack_snooze_reject_may_be_owner_serverfn_not_mcp',
        'cleanup_not_auto_executed',
      ],
    }
  } finally {
    await loader.close()
  }
}

/**
 * Real/staging path: gates + plan only unless EXECUTE + target; live MCP is
 * intentionally not auto-mutated — returns refuse when execute without full target,
 * or plan when gates ok without execute. Cleanup remains plan-only.
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

  const plan = buildStagingDecisionInboxPlan({
    boardId: env.BOARD_ID || BOARD_DEFAULT,
    expectedSha: env.EXPECTED_SHA || undefined,
  })

  if (!gate.executeRequested) {
    return {
      ok: true,
      mode: 'apply-plan',
      code: 'DECISION_INBOX_PLAN',
      stagingMutation: false,
      message:
        'Gates + live-pin bind OK. Default non-mutating plan. Set CAIRN_DECISION_INBOX_EXECUTE=1 + STAGING_URL + ROOT bearer for live MCP (not run by default). Always run cleanup plan after any live synth open.',
      plan,
      cleanup: buildCleanupPlan({ boardId: env.BOARD_ID || BOARD_DEFAULT }),
      residual_gaps: plan.residual_gaps,
    }
  }

  if (!gate.executeAllowed) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'DECISION_INBOX_EXECUTE_TARGET_MISSING',
      message: gate.message,
      stagingMutation: false,
      residual_gaps: ['execute_without_url_or_bearer'],
      plan,
    }
  }

  return {
    ok: false,
    mode: 'apply-refused',
    code: 'DECISION_INBOX_LIVE_MCP_NOT_AUTO_EXECUTED',
    message:
      'EXECUTE gates satisfied, but this harness intentionally does not auto-mutate staging. Use plan steps with an operator-owned MCP driver, or extend this flow with explicit live client under separate approval. Cleanup of synth-di-* remains mandatory after any live open.',
    stagingMutation: false,
    residual_gaps: ['live_mcp_driver_not_auto_executed', 'cleanup_required_after_live'],
    plan,
    cleanup: buildCleanupPlan({ boardId: env.BOARD_ID || BOARD_DEFAULT }),
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
    const plan = buildStagingDecisionInboxPlan({
      boardId: process.env.BOARD_ID || BOARD_DEFAULT,
      expectedSha: process.env.EXPECTED_SHA || undefined,
    })
    const payload = {
      ok: true,
      mode: 'plan',
      stagingMutation: false,
      harnessId: HARNESS_ID,
      plan,
      cleanup: buildCleanupPlan({ boardId: process.env.BOARD_ID || BOARD_DEFAULT }),
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
  const self = await runDecisionInboxSelfTests()
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
        code: e?.code ?? 'DECISION_INBOX_SMOKE_FATAL',
      }),
    )
    process.exit(2)
  })
}
