/**
 * Pure synthetic fixture data for control-center browser harness (C3-R4F).
 * No production-derived data. Importable without MySQL for self-tests.
 *
 * Pin authority (seed / board_revisions / control_plane_snapshots / receipts):
 *   - boardRev, lifecycleRev, canonicalSnapshotId, canonicalHash from HARNESS_PIN
 *   - taskHash = sha256(sorted canonical task ids joined by '|') — same as
 *     src/server/control-center-ui-adapter.ts buildControlCenterAggregationFromSources
 *
 * Live residual (server adapter concurrent scope — not edited here):
 *   - adapter pin.canonicalHash currently derives from boardHash(content), which
 *     includes classification receipts → self-referential vs authority pin.
 *   - claimState is not yet mapped from WorkTask into rollup inputs (hardcoded
 *     undefined) → ONGOING / RECON primary buckets need that server map.
 * Fixture still plants claimState + full receipts so pin-authority + claim mapping
 * land without a second seed rewrite.
 */

import { createHash } from 'node:crypto'
import { REDACTION_CANARIES } from '../../lib/probe-fail-close.mjs'

export const DEFAULT_BOARD_ID = 'mfs-rebuild'

/** Fixed board/lifecycle revs + snapshot id (board_revisions / control_plane_snapshots). */
export const HARNESS_PIN_BASE = Object.freeze({
  canonicalSnapshotId: 'synth-c3-r2d-snap-001',
  /**
   * Authority content hash for seed pin (64 hex). Distinct from live boardHash
   * residual — see module header. Manifest/seed pin PRESENT uses this.
   */
  canonicalHash: 'a1b2c3d4e5f60718293a4b5c6d7e8f901234567890abcdef1234567890ab',
  boardRev: 7,
  lifecycleRev: 3,
})

/** Canonical overlay task ids — order here is display intent; taskHash sorts them. */
export const CANONICAL_TASK_IDS = Object.freeze([
  'task-done-1',
  'task-ongoing-1',
  'task-next-1',
  'task-queued-1',
  'task-blocked-1',
  'task-recon-1',
  'task-stale-1',
  'task-missing-proof-1',
])

/** Same algorithm as control-center-ui-adapter.ts (sha256 of sorted ids joined by '|'). */
export function computeTaskHash(taskIds = CANONICAL_TASK_IDS) {
  const sorted = [...taskIds].map(String).sort()
  return createHash('sha256')
    .update(sorted.join('|') || 'empty-tasks')
    .digest('hex')
}

/** Deterministic hex receipt hash (classification.ts RECEIPT_HASH_RE: 16–128 hex). */
export function computeReceiptHash(parts) {
  return createHash('sha256').update(String(parts)).digest('hex')
}

/**
 * Stable JSON stringify matching src/server/control-plane-ingest.ts::stableStringify.
 * Object keys sorted; arrays preserve order; null/primitives via JSON.stringify.
 */
export function stableStringifyPlan(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyPlan).join(',')}]`
  const obj = value
  const keys = Object.keys(obj).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyPlan(obj[k])}`).join(',')}}`
}

/**
 * Exact JS equivalent of src/server/control-plane-ingest.ts::computePlanHash.
 * Authority for publish_dispatch_plan planHash integrity — do not ad-hoc hash.
 */
export function computePlanHash(input) {
  const payload = {
    boardId: input.boardId,
    planId: input.planId,
    planVersion: input.planVersion,
    canonicalSnapshotId: input.canonicalSnapshotId,
    canonicalHash: input.canonicalHash,
    items: [...(input.items ?? [])]
      .sort((a, b) => a.rank - b.rank)
      .map((it) => ({
        rank: it.rank,
        taskId: it.taskId,
        targetGate: it.targetGate,
        role: it.role,
        selectionReason: it.selectionReason,
        priorityPortfolioId: it.priorityPortfolioId ?? null,
        dependencyProof: it.dependencyProof ?? null,
        collisionScopeLockIds: [...(it.collisionScopeLockIds ?? [])].sort(),
        expectedEntityRev: it.expectedEntityRev,
        expectedBoardRev: it.expectedBoardRev,
      })),
  }
  return createHash('sha256').update(stableStringifyPlan(payload)).digest('hex')
}

/**
 * Former ad-hoc planHash used by an older fixture (string receipt). Kept only so
 * self-tests can prove it diverges from server computePlanHash and must not be used.
 */
export function computeLegacyAdHocPlanHash(planId, planVersion, items, taskHash) {
  return computeReceiptHash(
    `plan|${planId}|${planVersion}|${(items ?? []).map((i) => i.taskId).join(',')}|${taskHash}`,
  )
}

export function buildHarnessPin(taskIds = CANONICAL_TASK_IDS) {
  return {
    ...HARNESS_PIN_BASE,
    taskHash: computeTaskHash(taskIds),
  }
}

/** Lazy HARNESS_PIN so importers always get computed taskHash. */
export const HARNESS_PIN = buildHarnessPin()

/** Re-export for seeders / harness public redaction probe. */
export { REDACTION_CANARIES }

/** ONGOING zero-click seeded identity (must be visible without extra click). */
export const SEEDED_ONGOING = Object.freeze({
  taskId: 'task-ongoing-1',
  runId: 'run-synth-ongoing',
  titleIncludes: 'SYNTH ONGOING',
  agentId: 'run-synth-ongoing',
  role: 'Worker',
  model: 'grok-4.5',
  effort: 'high',
  accountMasked: 'acc_***-001',
  targetGate: 'PROD_READY',
})

export const BOARD_VIEWS = [
  'board',
  'work',
  'priority',
  'projects',
  'features',
  'agents',
  'ops',
  'decisions',
  'evidence',
  'tasks',
  'map',
  'design',
  'log',
]

function makeReceipt(taskId, pin, now, opts = {}) {
  const taskClass = opts.taskClass ?? 'PRODUCT'
  const disposition = opts.disposition ?? 'ACTIVE'
  const receiptId = opts.receiptId ?? `rcpt-${taskId}`
  const body = {
    receiptId,
    receiptHash: computeReceiptHash(
      `rcpt|${taskId}|${taskClass}|${disposition}|${pin.taskHash}|${pin.boardRev}|${pin.lifecycleRev}`,
    ),
    taskId,
    taskClass,
    disposition,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    issuedAt: now,
    expiresAt: opts.expiresAt ?? null,
  }
  if (opts.membership) {
    body.membershipPortfolioId = 'SALES_WEB_RELATED_BACKEND'
    body.membershipProofHash = computeReceiptHash(
      `member|SALES_WEB_RELATED_BACKEND|${taskId}|${pin.taskHash}`,
    )
  }
  return body
}

function classifiedProduct(taskId, pin, now, extra = {}) {
  const receipt = makeReceipt(taskId, pin, now, {
    membership: extra.membership !== false,
    receiptId: extra.receiptId,
  })
  return {
    taskClass: 'PRODUCT',
    disposition: 'ACTIVE',
    receipt,
    controlPlaneTargetGate: extra.controlPlaneTargetGate ?? null,
    controlPlaneGateVerifiedPass: extra.controlPlaneGateVerifiedPass,
    controlPlaneRootAccepted: extra.controlPlaneRootAccepted,
  }
}

/**
 * Representative work overlays for DONE/ONGOING/NEXT/QUEUED/BLOCKED/RECON/STALE
 * + one deliberate UNCLASSIFIED (missing-proof).
 */
export function buildSyntheticTasks(now = new Date().toISOString(), pin = buildHarnessPin()) {
  const cls = (id, extra) => classifiedProduct(id, pin, now, extra)

  return [
    {
      id: 'task-done-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH DONE — positive PRODUCT classification',
      phase: 'done',
      lifecycle_stage: 'PROD_READY',
      data: {
        id: 'task-done-1',
        title: 'SYNTH DONE — positive PRODUCT classification',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'done',
        status: 'done',
        mappingPct: 100,
        lifecycleStage: 'PROD_READY',
        // Completed-task STALE exception: STALE claim stays DONE + STALE_CLAIM overlay
        claimState: 'STALE',
        dependencies: [],
        impacts: [],
        checkpoints: [{ id: 'cp-done', label: 'Shipped', done: true }],
        classification: cls('task-done-1'),
        page_routes: ['/checkout', '/checkout/success'],
        api_endpoints: ['POST /api/checkout', 'GET /api/orders/:id'],
        logic_rules: ['idempotent-payment-intent'],
        sales_table_fields: ['order_id', 'payment_status'],
        geo_variants: [{ id: 'geo-us', when: 'US', expect: 'USD pricing' }],
        provider_variants: [{ id: 'prov-cleeng', when: 'cleeng', expect: 'entitlement grant' }],
        side_effects_readback: ['webhook:order.paid', 'email:receipt'],
        evidence_path: 'qa/e2e/out/runtime/synth/done-evidence.md',
      },
    },
    {
      id: 'task-ongoing-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH ONGOING implementer work',
      phase: 'build',
      lifecycle_stage: 'IMPL_IN_PROGRESS',
      implementer_run: SEEDED_ONGOING.runId,
      data: {
        id: 'task-ongoing-1',
        title: 'SYNTH ONGOING implementer work',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'build',
        status: 'in_progress',
        lifecycleStage: 'IMPL_IN_PROGRESS',
        claimState: 'VALID_CURRENT',
        dependencies: [],
        impacts: [],
        checkpoints: [{ id: 'cp-on', label: 'Implementer active', done: false }],
        classification: cls('task-ongoing-1'),
        page_routes: ['/checkout'],
        api_endpoints: ['POST /api/checkout/intent'],
        evidence_path: 'qa/e2e/out/runtime/synth/ongoing-evidence.md',
      },
    },
    {
      id: 'task-next-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH NEXT candidate',
      phase: 'spec',
      lifecycle_stage: 'SPEC_READY',
      data: {
        id: 'task-next-1',
        title: 'SYNTH NEXT candidate',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'spec',
        status: 'todo',
        lifecycleStage: 'SPEC_READY',
        claimState: null,
        selectedForNextDispatch: true,
        dependencies: [],
        impacts: [],
        checkpoints: [],
        classification: cls('task-next-1'),
      },
    },
    {
      id: 'task-queued-1',
      project_id: 'proj-auth',
      feature_contract_id: 'feat-login',
      title: 'SYNTH QUEUED waiting capacity',
      phase: 'backlog',
      lifecycle_stage: 'BACKLOG',
      data: {
        id: 'task-queued-1',
        title: 'SYNTH QUEUED waiting capacity',
        projectId: 'proj-auth',
        featureContractId: 'feat-login',
        phase: 'backlog',
        status: 'todo',
        lifecycleStage: 'BACKLOG',
        claimState: null,
        dependencies: ['task-next-1'],
        impacts: [],
        checkpoints: [],
        classification: cls('task-queued-1'),
      },
    },
    {
      id: 'task-blocked-1',
      project_id: 'proj-auth',
      feature_contract_id: 'feat-login',
      title: 'SYNTH BLOCKED needs-human',
      phase: 'build',
      lifecycle_stage: 'IMPL_IN_PROGRESS',
      blocked_reason: 'SYNTH: waiting owner decision dec-v3-001',
      data: {
        id: 'task-blocked-1',
        title: 'SYNTH BLOCKED needs-human',
        projectId: 'proj-auth',
        featureContractId: 'feat-login',
        phase: 'build',
        status: 'blocked',
        lifecycleStage: 'IMPL_IN_PROGRESS',
        blockedReason: 'SYNTH: waiting owner decision dec-v3-001',
        blockers: ['dec-v3-001'],
        hasBlockingDecision: true,
        claimState: null,
        dependencies: [],
        impacts: [],
        checkpoints: [],
        classification: cls('task-blocked-1'),
      },
    },
    {
      id: 'task-recon-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH RECONCILIATION_PENDING',
      phase: 'qa',
      lifecycle_stage: 'QA_IN_PROGRESS',
      data: {
        id: 'task-recon-1',
        title: 'SYNTH RECONCILIATION_PENDING',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'qa',
        status: 'in_progress',
        lifecycleStage: 'QA_IN_PROGRESS',
        reconciliation: 'pending',
        // Incomplete + stale/orphan ownership → RECONCILIATION_PENDING (rule 4)
        claimState: 'ORPHAN',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        classification: cls('task-recon-1'),
      },
    },
    {
      id: 'task-stale-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH STALE deep-link fixture',
      phase: 'build',
      lifecycle_stage: 'IMPL_IN_PROGRESS',
      data: {
        id: 'task-stale-1',
        title: 'SYNTH STALE deep-link fixture',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'build',
        status: 'in_progress',
        lifecycleStage: 'IMPL_IN_PROGRESS',
        stale: true,
        staleReason: 'SYNTH: pin older than publication window',
        staleDataSource: true,
        claimState: 'STALE',
        dependencies: [],
        impacts: [],
        checkpoints: [],
        classification: cls('task-stale-1'),
      },
    },
    {
      id: 'task-missing-proof-1',
      project_id: 'proj-sales-web',
      feature_contract_id: 'feat-checkout',
      title: 'SYNTH missing-proof (DATA_INTEGRITY / UNCLASSIFIED)',
      phase: 'build',
      lifecycle_stage: 'IMPL_IN_PROGRESS',
      data: {
        id: 'task-missing-proof-1',
        title: 'SYNTH missing-proof (DATA_INTEGRITY / UNCLASSIFIED)',
        projectId: 'proj-sales-web',
        featureContractId: 'feat-checkout',
        phase: 'build',
        mappingPct: 80,
        status: 'in_progress',
        lifecycleStage: 'IMPL_IN_PROGRESS',
        // Deliberate: NO classification / receipt → exactly one BLOCKED:DATA_INTEGRITY repair row
        dependencies: [],
        impacts: [],
        checkpoints: [],
      },
    },
  ]
}

export function buildBoardDocs(now = new Date().toISOString(), pin = buildHarnessPin()) {
  const day = now.slice(0, 10)
  const dueOpen = new Date(Date.parse(now) + 3 * 24 * 3600 * 1000).toISOString()

  const plan = {
    fase_label: {
      backlog: 'Backlog',
      spec: 'Spec',
      design: 'Desain',
      'review-owner': 'Review Owner',
      build: 'Build',
      qa: 'QA',
      uat: 'UAT',
      done: 'Done',
    },
    fase_persen: {
      backlog: 0,
      spec: 15,
      design: 35,
      'review-owner': 45,
      build: 65,
      qa: 80,
      uat: 90,
      done: 100,
    },
    projects: [
      {
        id: 'proj-sales-web',
        nama: 'Sales Web Rebuild',
        fase: 'build',
        status: 'active',
      },
      {
        id: 'proj-auth',
        nama: 'Auth Platform',
        fase: 'qa',
        status: 'active',
      },
    ],
    features: [
      {
        id: 'feat-checkout',
        nama: 'Checkout Flow',
        projectId: 'proj-sales-web',
        fase: 'build',
        // open / fail / expired branches (contract-supported)
        branch: 'open',
        checklist: [
          { text: 'Wire payment intent', done: true },
          { text: 'Handle expired session branch', done: false },
          { text: 'Fail path: provider 402', done: false },
        ],
      },
      {
        id: 'feat-login',
        nama: 'Login Flow',
        projectId: 'proj-auth',
        fase: 'qa',
        branch: 'fail',
        checklist: [{ text: 'Password reset', done: true }],
      },
      {
        id: 'feat-session-expiry',
        nama: 'Session Expiry',
        projectId: 'proj-auth',
        fase: 'spec',
        branch: 'expired',
        checklist: [{ text: 'Expire idle sessions', done: false }],
      },
    ],
    // Rich DecisionV3-shaped records. mapLegacyDecisionToV3 today uses `teks` as
    // question + ignores options/recommendation — plant teks AND full V3 fields.
    // Private body embeds redaction canary — must never appear in public snapshot.
    decisions: [
      {
        id: 'dec-v3-001',
        decisionId: 'dec-v3-001',
        // Legacy open filter uses lowercase 'open'
        status: 'open',
        severity: 'blocking-human',
        blocking: true,
        type: 'owner',
        created: now,
        createdAt: now,
        dueAt: dueOpen,
        due: dueOpen,
        // mapLegacyDecisionToV3: teks → question
        teks: 'Should we allocate majority Grok capacity to SALES_WEB_RELATED_BACKEND this wave?',
        title: 'SYNTH DecisionV3 OPEN blocking-human capacity policy',
        question:
          'Should we allocate majority Grok capacity to SALES_WEB_RELATED_BACKEND this wave?',
        options: [
          {
            optionId: 'opt-a',
            id: 'opt-a',
            label: 'Approve majority Grok capacity',
            recommended: true,
            tradeoffs: 'Faster sales-web closure; reduces non-priority throughput',
          },
          {
            optionId: 'opt-b',
            id: 'opt-b',
            label: 'Defer one sprint',
            tradeoffs: 'Preserves spare capacity; delays checkout frontier',
          },
        ],
        agentRecommendation: 'Approve majority Grok capacity (opt-a) with 48h review',
        recommendation: 'Approve majority Grok capacity (opt-a) with 48h review',
        evidence: [
          'ev-synth-r2d-001',
          'qa/e2e/out/runtime/synth/decision-capacity.md',
        ],
        ownerId: 'owner-synth',
        resolverId: null,
        featureId: 'feat-login',
        projectId: 'proj-auth',
        taskId: 'task-blocked-1',
        entityRev: 1,
        expectedRev: pin.boardRev,
        boardRev: pin.boardRev,
        auditIds: ['audit-dec-001'],
        scopedApprovalId: null,
        body: `SYNTHETIC DecisionV3 fixture — not production. ${REDACTION_CANARIES.decisionBody}`,
        privateNote: REDACTION_CANARIES.decisionBody,
        comment: null,
        schema: 'DecisionV3',
      },
      {
        id: 'dec-v3-002',
        decisionId: 'dec-v3-002',
        status: 'ACKNOWLEDGED',
        severity: 'info',
        blocking: false,
        type: 'owner',
        created: now,
        createdAt: now,
        teks: 'SYNTH: acknowledge non-blocking ops note for auth platform',
        title: 'SYNTH DecisionV3 ACKNOWLEDGED non-blocking',
        question: 'SYNTH: acknowledge non-blocking ops note for auth platform',
        options: [
          {
            optionId: 'opt-ok',
            id: 'opt-ok',
            label: 'Noted',
            recommended: true,
            tradeoffs: 'No schedule impact',
          },
        ],
        agentRecommendation: 'Noted',
        ownerId: 'owner-synth',
        resolverId: 'owner-synth',
        featureId: 'feat-login',
        projectId: 'proj-auth',
        entityRev: 1,
        expectedRev: pin.boardRev,
        boardRev: pin.boardRev,
        auditIds: ['audit-dec-002'],
        body: 'SYNTH ACK fixture',
        schema: 'DecisionV3',
      },
      {
        id: 'dec-v3-003',
        decisionId: 'dec-v3-003',
        status: 'RESOLVED',
        severity: 'info',
        blocking: false,
        type: 'owner',
        created: now,
        createdAt: now,
        resolvedAt: now,
        teks: 'SYNTH: ship checkout open-branch mapping',
        title: 'SYNTH DecisionV3 RESOLVED historical',
        question: 'SYNTH: ship checkout open-branch mapping',
        options: [
          {
            optionId: 'opt-ship',
            id: 'opt-ship',
            label: 'Ship',
            recommended: true,
            tradeoffs: 'Locks mapping contract',
          },
        ],
        agentRecommendation: 'Ship',
        selectedOptionId: 'opt-ship',
        ownerId: 'owner-synth',
        resolverId: 'owner-synth',
        featureId: 'feat-checkout',
        projectId: 'proj-sales-web',
        entityRev: 2,
        expectedRev: pin.boardRev,
        boardRev: pin.boardRev,
        auditIds: ['audit-dec-003'],
        body: 'SYNTH RESOLVED fixture',
        schema: 'DecisionV3',
      },
    ],
    log: [
      { tanggal: day, teks: 'SYNTH C3-R4F seed: isolated control-center fixture' },
      { tanggal: day, teks: 'SYNTH: classified overlays + one deliberate missing-proof' },
      { tanggal: day, teks: 'SYNTH: dispatch plan + account-sync payloads ready for MCP bootstrap' },
    ],
    queue: {
      now: ['task-ongoing-1'],
      next: ['task-next-1'],
      queued: ['task-queued-1'],
    },
    docs: [],
    updated: day,
  }

  const runs = {
    runs: [
      {
        id: 'run-synth-ongoing',
        role: 'Worker',
        status: 'running',
        started: now,
        updated: now,
        heartbeatAt: now,
        materialProgressAt: now,
        model: 'grok-4.5',
        effort: 'high',
        task: 'task-ongoing-1',
        taskId: 'task-ongoing-1',
        agent: 'run-synth-ongoing',
        agentType: 'grok',
        title: 'SYNTH ongoing implementer',
        account: 'acc_synth_r2d_001',
        evidencePath: 'qa/e2e/out/runtime/synth/ongoing-evidence.md',
        claimState: 'VALID_CURRENT',
      },
      {
        id: 'run-synth-idle',
        role: 'Verifier',
        status: 'idle',
        started: now,
        updated: now,
        model: 'gpt-5.3-codex-spark',
        effort: 'medium',
        task: '',
        taskId: '',
        agent: 'run-synth-idle',
        agentType: 'codex',
        title: 'SYNTH idle verifier',
        account: 'acc_synth_r2d_002',
      },
    ],
  }

  // Accounts: public path must mask identity and strip credential-like fields.
  // Plant synthetic canaries in private fields supported by store boundary.
  const accounts = {
    vault: {
      [REDACTION_CANARIES.accountRawIdentity]: {
        password: REDACTION_CANARIES.accountPassword,
        token: REDACTION_CANARIES.accountToken,
      },
    },
    accounts: [
      {
        id: REDACTION_CANARIES.accountRawIdentity,
        status: 'ACTIVE',
        usable: true,
        cap: 3,
        inUse: 1,
        provider: 'grok',
        label: '***masked-healthy***',
        password: REDACTION_CANARIES.accountPassword,
        token: REDACTION_CANARIES.accountToken,
        secret: REDACTION_CANARIES.accountToken,
      },
      {
        id: 'synth-acc-quarantine-002',
        status: 'QUARANTINED',
        usable: false,
        cap: 2,
        inUse: 0,
        provider: 'spark',
        label: '***masked-quarantine***',
      },
    ],
    alert: null,
  }

  return {
    plan,
    runs,
    design: { projects: {}, features: {} },
    collab: {
      comments: {
        'dec-v3-001': [
          {
            id: 'cmt-canary-r3h-1',
            ts: now,
            actor: 'c3-r4f-seed',
            text: `Private decision comment ${REDACTION_CANARIES.commentText}`,
          },
        ],
      },
      activity: [
        {
          ts: now,
          actor: 'c3-r4f-seed',
          actorType: 'system',
          kind: 'note',
          text: 'Synthetic activity — not production',
        },
      ],
    },
    accounts,
    prod: { gates: [], headline: 'SYNTH prod gates', mockLabel: 'synthetic' },
    guide: { sections: [{ id: 'g1', title: 'SYNTH guide', body: 'Fixture only' }] },
  }
}

/**
 * Root-published active dispatch plan payload (for MCP publish_dispatch_plan bootstrap).
 * planHash MUST match server computePlanHash (boardId + plan identity + ranked items).
 */
export function buildDispatchPlanSeed(
  now = new Date().toISOString(),
  pin = buildHarnessPin(),
  boardId = DEFAULT_BOARD_ID,
) {
  const issuedAt = now
  const expiresAt = new Date(Date.parse(now) + 6 * 3600 * 1000).toISOString()
  const items = [
    {
      rank: 1,
      taskId: 'task-next-1',
      targetGate: 'SPEC_READY',
      role: 'Worker',
      selectionReason: 'SYNTH: root dispatch selected NEXT candidate for SALES_WEB frontier',
      priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      expectedEntityRev: 0,
      expectedBoardRev: pin.boardRev,
      collisionScopeLockIds: ['scope:task-next-1'],
      dependencyProof: { satisfied: true, refs: [] },
    },
  ]
  const planId = 'plan-synth-r4f-001'
  const planVersion = 1
  const planHash = computePlanHash({
    boardId,
    planId,
    planVersion,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    items,
  })
  return {
    boardId,
    planId,
    planVersion,
    planHash,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    expectedBoardRev: pin.boardRev,
    issuedAt,
    expiresAt,
    stage: 'ACTIVE',
    items,
    idempotencyKey: `idem-dispatch-${planId}-${pin.boardRev}`,
  }
}

/**
 * Authoritative masked account-sync payload (MCP sync_accounts).
 * Includes usable + fail-closed (quarantine) examples; no tokens.
 * Capacity packets deliberately sparse so majority PASS is not claimed without real packets.
 */
export function buildAccountSyncSeed(now = new Date().toISOString(), pin = buildHarnessPin()) {
  const generatedAt = now
  const sourceRevision = pin.boardRev
  return {
    sourceRevision,
    expectedBoardRev: pin.boardRev,
    generatedAt,
    trigger: 'ORCHESTRATOR_LAUNCH',
    idempotencyKey: `idem-accsync-${sourceRevision}-${pin.taskHash.slice(0, 12)}`,
    accounts: [
      {
        maskedAccountId: 'acc_synth_r2d_001',
        status: 'ACTIVE',
        providerKind: 'GROK',
        effectiveInUse: 1,
        effectiveCap: 3,
        physicalSlotsDisplay: '1/3',
        adaptiveQuotaState: 'healthy',
        reason: null,
        statusChangedAt: now,
      },
      {
        maskedAccountId: 'acc_synth_r2d_002',
        status: 'quarantine',
        providerKind: 'SPARK',
        effectiveInUse: 0,
        effectiveCap: 2,
        physicalSlotsDisplay: '0/2',
        adaptiveQuotaState: 'quarantined',
        reason: 'SYNTH: fail-closed quarantine example',
        statusChangedAt: now,
      },
    ],
    // For direct store injection (tests / authorized bootstrap only)
    snapshotShape: {
      boardId: DEFAULT_BOARD_ID,
      sourceRevision,
      generatedAt,
      generatedAtMs: Date.parse(generatedAt),
      accounts: [
        {
          maskedAccountId: 'acc_synth_r2d_001',
          status: 'ACTIVE',
          providerKind: 'GROK',
          effectiveInUse: 1,
          effectiveCap: 3,
          physicalSlotsDisplay: '1/3',
          adaptiveQuotaState: 'healthy',
          reason: null,
          statusChangedAt: now,
          tombstone: false,
        },
        {
          maskedAccountId: 'acc_synth_r2d_002',
          status: 'quarantine',
          providerKind: 'SPARK',
          effectiveInUse: 0,
          effectiveCap: 2,
          physicalSlotsDisplay: '0/2',
          adaptiveQuotaState: 'quarantined',
          reason: 'SYNTH: fail-closed quarantine example',
          statusChangedAt: now,
          tombstone: false,
        },
      ],
      readbackSurfaces: {
        mcp: { sourceRevision, generatedAt },
        api: { sourceRevision, generatedAt },
        ui: { sourceRevision, generatedAt },
        ops: { sourceRevision, generatedAt },
      },
      publishedAtMs: Date.parse(generatedAt),
      lastPeriodicHealthAtMs: Date.parse(generatedAt),
      stale: false,
      staleReason: null,
      usableCapacity: 2,
      entityRev: 1,
    },
  }
}

export function listRequiredOverlayTaskIds() {
  return [...CANONICAL_TASK_IDS]
}

/**
 * Pure scenario intent matrix for self-test (does not import server rollup).
 * Documents expected primary bucket given valid pin-matched classification +
 * claim mapping. Live residual rows named explicitly.
 */
export function buildScenarioMatrix(pin = buildHarnessPin()) {
  return [
    {
      id: 'task-done-1',
      scenario: 'DONE',
      expectedPrimary: 'DONE',
      requires: ['PRODUCT+ACTIVE receipt', 'lifecycleStage=PROD_READY'],
      residualIf: 'pin.canonicalHash mismatch → DATA_INTEGRITY',
    },
    {
      id: 'task-ongoing-1',
      scenario: 'ONGOING',
      expectedPrimary: 'ONGOING',
      requires: [
        'PRODUCT+ACTIVE receipt',
        'claimState=VALID_CURRENT',
        'runLiveness=RUNNING',
      ],
      residualIf: 'adapter claimState hardcoded undefined → may fall through to QUEUED',
    },
    {
      id: 'task-next-1',
      scenario: 'NEXT',
      expectedPrimary: 'NEXT',
      requires: ['PRODUCT+ACTIVE receipt', 'active dispatch plan selection'],
      residualIf: 'no MCP publish of dispatch plan → not selected',
    },
    {
      id: 'task-queued-1',
      scenario: 'QUEUED',
      expectedPrimary: 'QUEUED',
      requires: ['PRODUCT+ACTIVE receipt', 'eligible', 'not selected for NEXT'],
      residualIf: 'pin mismatch → DATA_INTEGRITY',
    },
    {
      id: 'task-blocked-1',
      scenario: 'BLOCKED',
      expectedPrimary: 'BLOCKED',
      requires: ['PRODUCT+ACTIVE receipt', 'hardBlocker or blocking decision'],
      residualIf: 'pin mismatch → DATA_INTEGRITY instead of HARD_BLOCKER',
    },
    {
      id: 'task-recon-1',
      scenario: 'RECONCILIATION_PENDING',
      expectedPrimary: 'RECONCILIATION_PENDING',
      requires: ['PRODUCT+ACTIVE receipt', 'claimState=ORPHAN/STALE/EXPIRED/FENCED'],
      residualIf: 'adapter claimState undefined → not RECON',
    },
    {
      id: 'task-stale-1',
      scenario: 'STALE',
      expectedPrimary: 'RECONCILIATION_PENDING',
      requires: ['PRODUCT+ACTIVE receipt', 'claimState=STALE', 'staleDataSource'],
      residualIf: 'adapter does not map staleDataSource/claimState',
    },
    {
      id: 'task-missing-proof-1',
      scenario: 'UNCLASSIFIED',
      expectedPrimary: 'BLOCKED',
      blockReason: 'DATA_INTEGRITY',
      requires: ['no classification receipt'],
      residualIf: 'none — deliberate single repair row',
    },
    {
      id: 'portfolio',
      scenario: 'SALES_WEB_RELATED_BACKEND',
      expectedPrimary: 'priority membership frontier',
      requires: ['membershipPortfolioId + membershipProofHash on classified receipts'],
      residualIf: 'zero capacity packets → majorityAllocationPass=false (fail-closed ok)',
    },
  ].map((row) => ({ ...row, pinTaskHash: pin.taskHash, pinBoardRev: pin.boardRev }))
}

/** Contract validation without DB. */
export function validateFixtureContract(tasks = buildSyntheticTasks(), docs = buildBoardDocs()) {
  const pin = buildHarnessPin(tasks.map((t) => t.id))
  const ids = new Set(tasks.map((t) => t.id))
  const missing = listRequiredOverlayTaskIds().filter((id) => !ids.has(id))
  const decisions = docs.plan?.decisions ?? []
  const errors = []
  if (missing.length) errors.push(`missing overlay tasks: ${missing.join(',')}`)
  if (decisions.length < 3) errors.push(`expected ≥3 DecisionV3 fixtures, got ${decisions.length}`)

  // Exactly one deliberate unclassified
  const classified = []
  const unclassified = []
  for (const t of tasks) {
    const c = t.data?.classification
    if (c?.taskClass && c?.disposition && c?.receipt) classified.push(t.id)
    else unclassified.push(t.id)
  }
  if (unclassified.length !== 1 || unclassified[0] !== 'task-missing-proof-1') {
    errors.push(
      `expected exactly one UNCLASSIFIED task-missing-proof-1, got [${unclassified.join(',')}]`,
    )
  }
  if (classified.length !== tasks.length - 1) {
    errors.push(`expected ${tasks.length - 1} classified tasks, got ${classified.length}`)
  }

  // Receipt pin + hex hash integrity
  const RECEIPT_HASH_RE = /^[a-f0-9]{16,128}$/i
  for (const t of tasks) {
    const r = t.data?.classification?.receipt
    if (!r) continue
    if (r.taskId !== t.id) errors.push(`${t.id}: receipt.taskId mismatch`)
    if (r.taskHash !== pin.taskHash) errors.push(`${t.id}: receipt.taskHash != computed taskHash`)
    if (r.boardRev !== pin.boardRev) errors.push(`${t.id}: receipt.boardRev mismatch`)
    if (r.lifecycleRev !== pin.lifecycleRev) errors.push(`${t.id}: receipt.lifecycleRev mismatch`)
    if (r.canonicalSnapshotId !== pin.canonicalSnapshotId) {
      errors.push(`${t.id}: receipt.canonicalSnapshotId mismatch`)
    }
    if (r.canonicalHash !== pin.canonicalHash) errors.push(`${t.id}: receipt.canonicalHash mismatch`)
    if (!RECEIPT_HASH_RE.test(r.receiptHash || '')) {
      errors.push(`${t.id}: receiptHash not hex16+ (got ${String(r.receiptHash).slice(0, 24)})`)
    }
    if (r.membershipPortfolioId === 'SALES_WEB_RELATED_BACKEND' && !r.membershipProofHash) {
      errors.push(`${t.id}: membership portfolio without membershipProofHash`)
    }
  }

  // DONE lifecycle
  const done = tasks.find((t) => t.id === 'task-done-1')
  if (done?.lifecycle_stage !== 'PROD_READY' && done?.data?.lifecycleStage !== 'PROD_READY') {
    errors.push('task-done-1 missing lifecycleStage PROD_READY')
  }

  // ONGOING claim + run
  const ongoing = tasks.find((t) => t.id === 'task-ongoing-1')
  if (ongoing?.data?.claimState !== 'VALID_CURRENT') {
    errors.push('task-ongoing-1 missing claimState VALID_CURRENT')
  }
  const runOk = (docs.runs?.runs ?? []).some(
    (r) => r.id === SEEDED_ONGOING.runId && (r.task === SEEDED_ONGOING.taskId || r.taskId === SEEDED_ONGOING.taskId),
  )
  if (!runOk) errors.push('missing SEEDED_ONGOING run fixture')

  // RECON / STALE claim markers
  if (tasks.find((t) => t.id === 'task-recon-1')?.data?.claimState !== 'ORPHAN') {
    errors.push('task-recon-1 missing claimState ORPHAN')
  }
  if (tasks.find((t) => t.id === 'task-stale-1')?.data?.claimState !== 'STALE') {
    errors.push('task-stale-1 missing claimState STALE')
  }

  // Decision question / teks
  const openDec = decisions.find((d) => d.id === 'dec-v3-001' || d.decisionId === 'dec-v3-001')
  if (!openDec?.teks && !openDec?.question) {
    errors.push('dec-v3-001 missing teks/question')
  }
  if (!openDec?.options?.length) errors.push('dec-v3-001 missing options')

  // Feature ids + branches
  const feats = docs.plan?.features ?? []
  for (const need of ['feat-checkout', 'feat-login']) {
    if (!feats.some((f) => f.id === need)) errors.push(`missing feature ${need}`)
  }
  const branches = new Set(feats.map((f) => f.branch).filter(Boolean))
  for (const b of ['open', 'fail', 'expired']) {
    if (!branches.has(b)) errors.push(`missing feature branch ${b}`)
  }

  // Feature context on done task
  const d = done?.data ?? {}
  for (const k of ['page_routes', 'api_endpoints', 'logic_rules', 'side_effects_readback']) {
    if (!Array.isArray(d[k]) || !d[k].length) errors.push(`task-done-1 missing ${k}`)
  }

  // Canaries MUST be planted in private decision/comment/account fields
  const privBlob = JSON.stringify({
    decisions,
    comments: docs.collab?.comments ?? {},
    accounts: docs.accounts ?? {},
  })
  for (const [label, value] of Object.entries({
    decisionBody: REDACTION_CANARIES.decisionBody,
    commentText: REDACTION_CANARIES.commentText,
    accountPassword: REDACTION_CANARIES.accountPassword,
    accountToken: REDACTION_CANARIES.accountToken,
    accountRawIdentity: REDACTION_CANARIES.accountRawIdentity,
  })) {
    if (!privBlob.includes(value)) errors.push(`missing redaction canary seed: ${label}`)
  }
  if (/sk_live_[A-Za-z0-9]{20,}|-----BEGIN (RSA )?PRIVATE KEY-----/.test(privBlob)) {
    errors.push('account fixture may contain real credential material')
  }

  const pinOk =
    pin.boardRev > 0 &&
    pin.lifecycleRev >= 0 &&
    pin.canonicalSnapshotId &&
    pin.canonicalHash?.length >= 32 &&
    pin.taskHash?.length === 64
  if (!pinOk) errors.push('HARNESS_PIN incomplete')

  // Dispatch + account sync seed shapes
  const dispatch = buildDispatchPlanSeed(undefined, pin)
  if (!dispatch.items?.some((i) => i.taskId === 'task-next-1')) {
    errors.push('dispatch plan missing task-next-1')
  }
  const expectedDispatchHash = computePlanHash({
    boardId: dispatch.boardId ?? DEFAULT_BOARD_ID,
    planId: dispatch.planId,
    planVersion: dispatch.planVersion,
    canonicalSnapshotId: dispatch.canonicalSnapshotId,
    canonicalHash: dispatch.canonicalHash,
    items: dispatch.items,
  })
  if (dispatch.planHash !== expectedDispatchHash) {
    errors.push('dispatch planHash does not match server computePlanHash contract')
  }
  const legacy = computeLegacyAdHocPlanHash(
    dispatch.planId,
    dispatch.planVersion,
    dispatch.items,
    pin.taskHash,
  )
  if (dispatch.planHash === legacy) {
    errors.push('dispatch planHash still uses legacy ad-hoc receipt string')
  }
  const acc = buildAccountSyncSeed(undefined, pin)
  if (acc.accounts.length < 2) errors.push('account sync seed needs usable + quarantine')
  if (!acc.snapshotShape.readbackSurfaces.mcp) errors.push('account sync missing readback parity shape')

  return {
    ok: errors.length === 0,
    errors,
    taskCount: tasks.length,
    decisionCount: decisions.length,
    classifiedCount: classified.length,
    unclassifiedCount: unclassified.length,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    canariesPlanted: errors.every((e) => !e.startsWith('missing redaction')),
    scenarios: buildScenarioMatrix(pin),
  }
}
