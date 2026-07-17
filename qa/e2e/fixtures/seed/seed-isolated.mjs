#!/usr/bin/env node
/**
 * Synthetic control-center DB seed.
 *
 * Modes:
 *   isolated (default CLI) — DROP+CREATE unique disposable DB; local harness only.
 *   staging              — idempotent upsert into exact DB cairn_tm_v3_staging only;
 *                          never DROP DATABASE; board-scoped replace for mfs-rebuild.
 *
 * Env (isolated):
 *   CAIRN_ISO_DB_NAME — optional fixed name (must pass assertSafeIsoDbName)
 *   CAIRN_DB_HOST/PORT/USER/PASSWORD — MySQL admin connection
 *   BOARD_ID — default mfs-rebuild
 *   CAIRN_SEED_PROVENANCE_PATH — where to write SYNTHETIC_PROVENANCE.json
 *
 * Env (staging — all required for live staging seed):
 *   CAIRN_ENV=staging
 *   CAIRN_DB_NAME=cairn_tm_v3_staging  (exact)
 *   CAIRN_STAGING_SEED_APPROVED=1
 *   CAIRN_DB_HOST in allowed staging hosts (CAIRN_STAGING_DB_HOSTS + known labels)
 *   CAIRN_DB_PORT/USER/PASSWORD
 *
 * Usage:
 *   node qa/e2e/fixtures/seed/seed-isolated.mjs
 *   node qa/e2e/fixtures/seed/seed-isolated.mjs --self-test
 *   node qa/e2e/fixtures/seed/seed-isolated.mjs --disposable-proof
 *   CAIRN_ENV=staging CAIRN_STAGING_SEED_APPROVED=1 … node qa/e2e/fixtures/seed/seed-isolated.mjs --staging
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

import {
  makeIsolatedDbName,
  recreateIsolatedDatabase,
  resolveMysqlConfig,
  withDbConnection,
  dropIsolatedDatabase,
  assertSafeIsoDbName,
} from '../../lib/db-iso.mjs'
import {
  BOARD_VIEWS,
  DEFAULT_BOARD_ID,
  FORBIDDEN_PLACEHOLDER_CANONICAL_HASH,
  SEEDED_ONGOING,
  bindAuthorityCanonicalHash,
  buildAccountSyncSeed,
  buildBoardDocs,
  buildDispatchPlanSeed,
  buildHarnessPin,
  buildSyntheticTasks,
  computeTaskHash,
  stableStringifyPlan,
  validateFixtureContract,
  CANONICAL_TASK_IDS,
} from './control-center-fixture.mjs'
// buildAccountSyncSeed / buildDispatchPlanSeed used by self-tests for entityExpectedRev wire
import {
  FP_C_GREENFIELD_CHAIN_VERSIONS,
  applyControlPlaneSchemaToIsoDb,
  buildFpCRunRecord,
  loadMigrationFile,
} from '../../lib/control-plane-schema-seed.mjs'

/**
 * Tables healthz probes when 004/005/006 are in schema_migrations history.
 * Must exist after real migration apply — ledger-only stamp is not enough.
 * Mirrors src/routes/api.healthz.ts REQUIRED_TABLES_BY_MIGRATION.
 */
export const HEALTHZ_REQUIRED_TABLES_004_006 = Object.freeze([
  'control_plane_classification_receipts',
  'control_plane_decisions',
  'control_plane_dispatch_plans',
  'control_plane_runs',
  'control_plane_collision_locks',
  'control_plane_stage_evidence_receipts',
])

/** Real definition schema — never store TM_UI_CONTRACT_V1 as a control_plane snapshot. */
export const CANONICAL_TASK_SNAPSHOT_SCHEMA = 'MFS_CANONICAL_TASK_SNAPSHOT_V1'
/** UI contract is for harness/screenshot manifests only — not pin/canonical complete. */
export const UI_CONTRACT_SCHEMA = 'TM_UI_CONTRACT_V1'
export const CANONICALIZATION_ALGORITHM = 'stable-sorted-json-sha256-v1'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

/** Exact staging database name (RESOLVED_TARGET). Never invent alternatives. */
export const STAGING_DB_NAME = 'cairn_tm_v3_staging'

/** Seed actor / provenance markers (no secrets). */
export const SEED_ACTOR_ISOLATED = 'c3-r4f-seed'
export const SEED_ACTOR_STAGING = 'staging-synthetic-seed'

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])
const PRODUCTION_MARKERS = [/prod/i, /production/i, /\.mfsdev\.net$/i]
const KNOWN_STAGING_HOST_LABELS = Object.freeze([
  'cairn-tm-v3-mysql',
  'cairn_tm_v3_staging',
  'tm-v3-staging',
])

// ---------------------------------------------------------------------------
// Host / staging gates (pure — unit-testable without MySQL)
// ---------------------------------------------------------------------------

/**
 * Classify DB host for seed authorization.
 * Mirrors server classifyDbHost shape without importing src/**.
 * @returns {'LOCAL'|'STAGING'|'PRODUCTION'|'UNKNOWN_REMOTE'}
 */
export function classifySeedHost(host, opts = {}) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
  if (LOCAL_HOSTS.has(h)) return 'LOCAL'

  const envList = String(
    opts.stagingHostsCsv ?? process.env.CAIRN_STAGING_DB_HOSTS ?? '',
  )
    .split(',')
    .map((s) => s.trim().toLowerCase())
    .filter(Boolean)
  const staging = new Set([
    ...envList,
    ...KNOWN_STAGING_HOST_LABELS,
    ...(opts.stagingHosts ?? []).map((s) => String(s).trim().toLowerCase()),
  ])
  if (staging.has(h)) return 'STAGING'

  if (
    PRODUCTION_MARKERS.some((re) => re.test(h)) ||
    h === 'task-manager.mfsdev.net'
  ) {
    return 'PRODUCTION'
  }
  return 'UNKNOWN_REMOTE'
}

/**
 * Fail-closed staging seed gate.
 * @param {{ env?: string, dbName?: string, host?: string, approved?: string|boolean, allowLocalHost?: boolean }} opts
 * @returns {{ ok: true, hostClass: string } | { ok: false, reason: string, hostClass?: string }}
 */
export function assertStagingSeedAllowed(opts = {}) {
  const envName = String(opts.env ?? process.env.CAIRN_ENV ?? '')
    .trim()
    .toLowerCase()
  const dbName = String(opts.dbName ?? process.env.CAIRN_DB_NAME ?? '').trim()
  const host = String(
    opts.host ?? process.env.CAIRN_DB_HOST ?? resolveMysqlConfig().host,
  ).trim()
  const approvedRaw =
    opts.approved ?? process.env.CAIRN_STAGING_SEED_APPROVED ?? ''
  const approved =
    approvedRaw === true ||
    approvedRaw === 1 ||
    String(approvedRaw).trim() === '1'

  if (envName !== 'staging') {
    return {
      ok: false,
      reason: `FAIL-CLOSED staging-seed: CAIRN_ENV must be "staging" (got "${envName || '(empty)'}")`,
    }
  }
  if (dbName !== STAGING_DB_NAME) {
    return {
      ok: false,
      reason: `FAIL-CLOSED staging-seed: CAIRN_DB_NAME must be exactly "${STAGING_DB_NAME}" (got "${dbName || '(empty)'}")`,
    }
  }
  if (!approved) {
    return {
      ok: false,
      reason:
        'FAIL-CLOSED staging-seed: CAIRN_STAGING_SEED_APPROVED=1 is required (explicit operator approval)',
    }
  }

  const hostClass = classifySeedHost(host, opts)
  // Staging compose DNS is STAGING. Loopback is only allowed when operator
  // explicitly sets CAIRN_STAGING_SEED_ALLOW_LOCAL=1 (laptop tunnel to staging
  // mysql is NOT the normal path — compose runs seed inside the network).
  if (hostClass === 'PRODUCTION') {
    return {
      ok: false,
      hostClass,
      reason: `FAIL-CLOSED staging-seed: refusing PRODUCTION host "${host}"`,
    }
  }
  if (hostClass === 'UNKNOWN_REMOTE') {
    return {
      ok: false,
      hostClass,
      reason: `FAIL-CLOSED staging-seed: host "${host}" is UNKNOWN_REMOTE — list it in CAIRN_STAGING_DB_HOSTS or use known staging labels (${KNOWN_STAGING_HOST_LABELS.join(', ')})`,
    }
  }
  if (hostClass === 'LOCAL') {
    const allowLocal =
      opts.allowLocalHost === true ||
      process.env.CAIRN_STAGING_SEED_ALLOW_LOCAL === '1'
    if (!allowLocal) {
      return {
        ok: false,
        hostClass,
        reason: `FAIL-CLOSED staging-seed: LOCAL host "${host}" refused for staging mode (set CAIRN_STAGING_SEED_ALLOW_LOCAL=1 only for controlled local disposable proof of the staging gate path)`,
      }
    }
  }
  if (hostClass !== 'STAGING' && hostClass !== 'LOCAL') {
    return {
      ok: false,
      hostClass,
      reason: `FAIL-CLOSED staging-seed: host class ${hostClass} not allowed`,
    }
  }
  return { ok: true, hostClass }
}

// ---------------------------------------------------------------------------
// Schema + upsert (shared by isolated + staging)
// ---------------------------------------------------------------------------

/** CREATE TABLE IF NOT EXISTS for baseline control-center tables. Never DROP DATABASE. */
export async function ensureBaselineTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS boards (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    views JSON NULL,
    created_at VARCHAR(32) NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS board_docs (
    board_id VARCHAR(64) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    data JSON NOT NULL,
    PRIMARY KEY (board_id, kind)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS globals (
    k VARCHAR(64) NOT NULL PRIMARY KEY,
    data JSON NOT NULL
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS tasks (
    board_id VARCHAR(64) NOT NULL,
    id VARCHAR(160) NOT NULL,
    project_id VARCHAR(64) NULL,
    feature_contract_id VARCHAR(160) NULL,
    grp VARCHAR(191) NULL,
    phase VARCHAR(191) NULL,
    scope VARCHAR(64) NULL,
    title TEXT NULL,
    updated VARCHAR(40) NULL,
    summary JSON NULL,
    data JSON NULL,
    lifecycle_stage VARCHAR(64) NULL,
    implementer_run VARCHAR(160) NULL,
    rev INT NOT NULL DEFAULT 0,
    lifecycle JSON NULL,
    blocked_reason VARCHAR(400) NULL,
    last_receipt_at VARCHAR(40) NULL,
    PRIMARY KEY (board_id, id),
    KEY idx_bp (board_id, project_id),
    KEY idx_bf (board_id, feature_contract_id),
    KEY idx_stage (board_id, lifecycle_stage)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS audit_log (
    id BIGINT AUTO_INCREMENT PRIMARY KEY,
    board_id VARCHAR(64) NOT NULL,
    ts VARCHAR(40) NOT NULL,
    actor VARCHAR(160) NULL,
    action VARCHAR(64) NOT NULL,
    task_id VARCHAR(160) NULL,
    from_stage VARCHAR(64) NULL,
    to_stage VARCHAR(64) NULL,
    detail JSON NULL,
    KEY idx_board (board_id, id),
    KEY idx_task (board_id, task_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS board_revisions (
    board_id VARCHAR(64) NOT NULL,
    board_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    lifecycle_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    subject_hash CHAR(64) NULL,
    canonical_snapshot_id VARCHAR(64) NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_snapshots (
    board_id VARCHAR(64) NOT NULL,
    snapshot_id VARCHAR(64) NOT NULL,
    schema_version VARCHAR(64) NOT NULL,
    source_repo_id VARCHAR(160) NULL,
    source_commit_sha CHAR(64) NULL,
    payload_sha256 CHAR(64) NOT NULL,
    board_rev BIGINT UNSIGNED NOT NULL,
    lifecycle_rev BIGINT UNSIGNED NOT NULL,
    generated_at DATETIME(3) NOT NULL,
    producer_version VARCHAR(64) NULL,
    payload_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, snapshot_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Existing product classification authority (001 + 004 shape). This is an
  // IF-NOT-EXISTS compatibility create for disposable/staging seed setup, not a
  // migration or schema variant.
  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_classification (
    board_id VARCHAR(64) NOT NULL,
    task_id VARCHAR(160) NOT NULL,
    task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
    disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
    classification_receipt_id VARCHAR(64) NULL,
    classification_receipt_hash CHAR(64) NULL,
    proof_source VARCHAR(160) NULL,
    board_rev BIGINT UNSIGNED NULL,
    entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    receipt_json JSON NULL,
    canonical_snapshot_id VARCHAR(64) NULL,
    canonical_hash CHAR(64) NULL,
    task_hash CHAR(64) NULL,
    lifecycle_rev BIGINT UNSIGNED NULL,
    control_plane_target_gate VARCHAR(160) NULL,
    control_plane_gate_verified_pass TINYINT(1) NULL,
    control_plane_root_accepted TINYINT(1) NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, task_id),
    KEY idx_class_task_class (board_id, task_class, disposition),
    KEY idx_class_receipt (board_id, classification_receipt_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_classification_receipts (
    board_id VARCHAR(64) NOT NULL,
    receipt_id VARCHAR(64) NOT NULL,
    task_id VARCHAR(160) NOT NULL,
    receipt_hash CHAR(64) NOT NULL,
    task_class VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
    disposition VARCHAR(32) NOT NULL DEFAULT 'UNCLASSIFIED',
    membership_portfolio_id VARCHAR(160) NULL,
    membership_proof_hash CHAR(64) NULL,
    canonical_snapshot_id VARCHAR(64) NOT NULL,
    canonical_hash CHAR(64) NOT NULL,
    task_hash CHAR(64) NOT NULL,
    board_rev BIGINT UNSIGNED NOT NULL,
    lifecycle_rev BIGINT UNSIGNED NOT NULL,
    issued_at DATETIME(3) NOT NULL,
    expires_at DATETIME(3) NULL,
    receipt_json JSON NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, receipt_id),
    KEY idx_class_receipt_task (board_id, task_id),
    KEY idx_class_receipt_hash (board_id, receipt_hash)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_evidence (
    board_id VARCHAR(64) NOT NULL,
    evidence_id VARCHAR(64) NOT NULL,
    entity_type VARCHAR(64) NOT NULL,
    entity_id VARCHAR(160) NOT NULL,
    domain VARCHAR(64) NULL,
    stage_key VARCHAR(64) NULL,
    receipt_kind VARCHAR(64) NOT NULL,
    subject_hash CHAR(64) NOT NULL,
    subject_entity_rev BIGINT UNSIGNED NULL,
    subject_board_rev BIGINT UNSIGNED NULL,
    verifier_agent_id VARCHAR(160) NULL,
    verifier_model VARCHAR(160) NULL,
    verifier_run_id VARCHAR(160) NULL,
    verdict VARCHAR(32) NOT NULL,
    findings_json JSON NULL,
    captured_at DATETIME(3) NOT NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, evidence_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  // Product V3 durable run registry (migration 005 shape). Required so disposable
  // ensure+replace can plant RUNNING ownership without legacy dual-read.
  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_runs (
    board_id VARCHAR(64) NOT NULL,
    run_id VARCHAR(160) NOT NULL,
    state VARCHAR(32) NOT NULL,
    plan_id VARCHAR(64) NULL,
    plan_item_rank INT UNSIGNED NULL,
    task_id VARCHAR(160) NOT NULL,
    target_gate VARCHAR(160) NOT NULL,
    role VARCHAR(64) NOT NULL,
    agent_id VARCHAR(160) NOT NULL,
    model VARCHAR(160) NOT NULL,
    effort VARCHAR(64) NOT NULL DEFAULT '',
    masked_account_ref VARCHAR(160) NULL,
    canonical_hash CHAR(64) NULL,
    collision_scope_lock_ids_json JSON NULL,
    fencing_token VARCHAR(160) NULL,
    fencing_version INT UNSIGNED NOT NULL DEFAULT 0,
    registered_at_ms BIGINT NULL,
    heartbeat_at_ms BIGINT NULL,
    lease_expires_at_ms BIGINT NULL,
    material_progress_at_ms BIGINT NULL,
    heartbeat_sequence BIGINT UNSIGNED NOT NULL DEFAULT 0,
    expected_entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
    expected_board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
    entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
    stalled TINYINT(1) NOT NULL DEFAULT 0,
    history_json JSON NULL,
    last_heartbeat_response_json JSON NULL,
    controller_run_id VARCHAR(160) NULL,
    parent_run_id VARCHAR(160) NULL,
    idempotency_key VARCHAR(191) NULL,
    subject_hash CHAR(64) NULL,
    record_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, run_id),
    KEY idx_runs_state (board_id, state, lease_expires_at_ms),
    KEY idx_runs_task (board_id, task_id),
    KEY idx_runs_agent (board_id, agent_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

/**
 * Produce a real MFS_CANONICAL_TASK_SNAPSHOT_V1 envelope from synthetic seed tasks.
 * TM_UI_CONTRACT_V1 stubs must NEVER be written as control_plane_snapshots —
 * that schema is UI harness only and must not be treated as pin-complete canonical.
 *
 * Definition-only payload (no lifecycle stage/evidence fields on tasks).
 * Hash = sha256(stable-sorted JSON of payload) matching server produceCanonicalSnapshot.
 * Authority pin hash = server canonicalSubjectHash:
 *   sha256(stableStringify({ snapshotId, payloadSha256, boardId }))
 *
 * @returns {{ schemaVersion: string, manifest: object, payload: object, payloadSha256: string, canonicalHash: string }}
 */
export function produceSyntheticCanonicalSnapshot({
  boardId,
  pin,
  boundTasks,
  now,
  producerVersion,
}) {
  const projectIds = new Set()
  const featureIds = new Set()
  const tasks = []
  const classifications = []
  const featureContractJoins = []
  const primaryOwnerships = []
  const dependencies = []
  const acceptancePaths = []

  for (const t of boundTasks ?? []) {
    const id = String(t.id)
    const projectId = t.project_id ? String(t.project_id) : null
    const featureId = t.feature_contract_id
      ? String(t.feature_contract_id)
      : null
    if (projectId) projectIds.add(projectId)
    if (featureId) featureIds.add(featureId)

    // Definition-only task row — strip lifecycle fields so schema validation accepts.
    tasks.push({
      id,
      projectId,
      featureContractId: featureId,
      title: t.title ?? null,
      objective: null,
    })

    const cls = t.data?.classification
    if (cls && cls.taskClass && cls.disposition) {
      const taskClass = String(cls.taskClass)
      const disposition = String(cls.disposition)
      // Only emit valid V3 class/disposition pairs; skip incomplete (UNCLASSIFIED path).
      if (
        (taskClass === 'PRODUCT' ||
          taskClass === 'CONTROL_PLANE' ||
          taskClass === 'UNCLASSIFIED') &&
        (disposition === 'ACTIVE' ||
          disposition === 'HOLD' ||
          disposition === 'EXCLUDE' ||
          disposition === 'UNCLASSIFIED')
      ) {
        classifications.push({
          taskId: id,
          taskClass,
          disposition,
          membershipPortfolioId: cls.receipt?.membershipPortfolioId ?? null,
          membershipProofHash: cls.receipt?.membershipProofHash ?? null,
          receiptId: cls.receipt?.receiptId ?? null,
          receiptHash: cls.receipt?.receiptHash ?? null,
        })
      }
    }

    if (featureId) {
      featureContractJoins.push({ featureContractId: featureId, taskId: id })
    }
    primaryOwnerships.push({
      taskId: id,
      ownerId: `owner-synth-${projectId ?? 'board'}`,
    })

    const deps = Array.isArray(t.data?.dependencies) ? t.data.dependencies : []
    for (const dep of deps) {
      if (dep) dependencies.push({ fromTaskId: String(dep), toTaskId: id })
    }

    if (t.data?.evidence_path) {
      acceptancePaths.push({
        id: `ap-${id}`,
        taskId: id,
        path: String(t.data.evidence_path),
        kind: 'evidence_path',
      })
    }
  }

  const projects = [...projectIds].sort().map((id) => ({ id, name: id }))
  // One synthetic flow + node per project (required graph skeleton).
  const flows = projects.map((p) => ({
    id: `flow-${p.id}`,
    projectId: p.id,
    name: `Flow ${p.id}`,
  }))
  const nodes = flows.map((f) => ({
    id: `node-${f.id}`,
    flowId: f.id,
    projectId: f.projectId,
    name: `Node ${f.id}`,
  }))
  const nodeJoins = tasks
    .filter((t) => t.projectId)
    .map((t) => ({
      nodeId: `node-flow-${t.projectId}`,
      taskId: t.id,
    }))

  const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)
  const byTaskId = (a, b) =>
    a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  const byDep = (a, b) => {
    const f =
      a.fromTaskId < b.fromTaskId ? -1 : a.fromTaskId > b.fromTaskId ? 1 : 0
    if (f !== 0) return f
    return a.toTaskId < b.toTaskId ? -1 : a.toTaskId > b.toTaskId ? 1 : 0
  }
  const byFc = (a, b) => {
    const f =
      a.featureContractId < b.featureContractId
        ? -1
        : a.featureContractId > b.featureContractId
          ? 1
          : 0
    if (f !== 0) return f
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  }
  const byNode = (a, b) => {
    const n = a.nodeId < b.nodeId ? -1 : a.nodeId > b.nodeId ? 1 : 0
    if (n !== 0) return n
    return a.taskId < b.taskId ? -1 : a.taskId > b.taskId ? 1 : 0
  }

  const payload = {
    projects: [...projects].sort(byId),
    flows: [...flows].sort(byId),
    nodes: [...nodes].sort(byId),
    tasks: [...tasks].sort(byId),
    dependencies: [...dependencies].sort(byDep),
    featureContractJoins: [...featureContractJoins].sort(byFc),
    nodeJoins: [...nodeJoins].sort(byNode),
    primaryOwnerships: [...primaryOwnerships].sort(byTaskId),
    classifications: [...classifications].sort(byTaskId),
    anchors: [],
    acceptancePaths: [...acceptancePaths].sort(byId),
  }

  const payloadSha256 = createHash('sha256')
    .update(stableStringifyPlan(payload))
    .digest('hex')

  // Pin subject hash = server canonicalSubjectHash(snapshot)
  // sha256(stableStringify({ snapshotId, payloadSha256, boardId }))
  const canonicalHash = createHash('sha256')
    .update(
      stableStringifyPlan({
        snapshotId: pin.canonicalSnapshotId,
        payloadSha256,
        boardId,
      }),
    )
    .digest('hex')

  const generatedAt = now ?? new Date(0).toISOString()
  const manifest = {
    schemaVersion: CANONICAL_TASK_SNAPSHOT_SCHEMA,
    boardId,
    snapshotId: pin.canonicalSnapshotId,
    sourceRepoId: 'synthetic/control-center-seed',
    // Hex commit stand-in (7–64 chars); not a real git SHA for synthetic seed.
    sourceCommitSha: payloadSha256.slice(0, 40),
    generatedAt,
    canonicalizationAlgorithm: CANONICALIZATION_ALGORITHM,
    payloadSha256,
    distinctCounts: {
      projects: payload.projects.length,
      flows: payload.flows.length,
      nodes: payload.nodes.length,
      tasks: payload.tasks.length,
      dependencies: payload.dependencies.length,
      featureContractJoins: payload.featureContractJoins.length,
      nodeJoins: payload.nodeJoins.length,
      classifications: payload.classifications.length,
      anchors: 0,
      acceptancePaths: payload.acceptancePaths.length,
      primaryOwnerships: payload.primaryOwnerships.length,
    },
    producerVersion: producerVersion ?? 'seed-isolated-canonical-v1',
    // Honest seed marker (manifest extension; not part of payload hash).
    syntheticSeed: true,
    uiContractSchema: UI_CONTRACT_SCHEMA,
    note: 'TM_UI_CONTRACT_V1 is harness-only; pin authority uses MFS_CANONICAL_TASK_SNAPSHOT_V1',
  }

  return {
    schemaVersion: CANONICAL_TASK_SNAPSHOT_SCHEMA,
    manifest,
    payload,
    payloadSha256,
    /** Use as board_revisions.subject_hash / pin.canonicalHash for loadable pin. */
    canonicalHash,
  }
}

/**
 * Guard: never treat TM_UI_CONTRACT_V1 (or any non-canonical schema) as pin-complete.
 * Used by self-tests and as documentation for loaders.
 */
export function isCanonicalCompleteSchema(schemaVersion) {
  return String(schemaVersion ?? '').trim() === CANONICAL_TASK_SNAPSHOT_SCHEMA
}

/**
 * After board content is known, compute the exact authority hash the runtime
 * healthz/subject_hash path uses, then rebind tasks/docs/dispatch/account so
 * snapshot + taskHash + boardRev + lifecycleRev + canonicalHash stay coherent.
 *
 * Pure (no MySQL). Does not weaken comparePinParity — returns the hash that
 * must match runtime board_revisions.subject_hash.
 *
 * @returns {{
 *   pin: object,
 *   boundTasks: object[],
 *   docs: object,
 *   dispatchSeed: object,
 *   accountSyncSeed: object,
 *   canonical: object,
 *   payloadSha256: string,
 * }}
 */
export function materializeAuthorityPin(options = {}) {
  const now = options.now ?? new Date().toISOString()
  const boardId = options.boardId ?? DEFAULT_BOARD_ID
  const producerVersion =
    options.producerVersion ?? 'seed-isolated-canonical-v1'
  const taskIds =
    options.taskIds ??
    (Array.isArray(options.tasks)
      ? options.tasks.map((t) => t.id)
      : CANONICAL_TASK_IDS)

  // Pass 1: build content with pre-materialization pin identity (hash may be null).
  const pinIdentity = buildHarnessPin(taskIds, {
    ...(options.pinBase ?? {}),
    canonicalHash: null,
  })
  const tasksPass1 = options.tasks ?? buildSyntheticTasks(now, pinIdentity)

  const canonicalPass1 = produceSyntheticCanonicalSnapshot({
    boardId,
    pin: pinIdentity,
    boundTasks: tasksPass1,
    now,
    producerVersion,
  })
  const pin = bindAuthorityCanonicalHash(
    pinIdentity,
    canonicalPass1.canonicalHash,
  )

  // Pass 2: rebind all pin-bearing fixture rows to the authority hash.
  const boundTasks = buildSyntheticTasks(now, pin)
  const docs = options.docs ?? buildBoardDocs(now, pin)
  const dispatchSeed = options.dispatchSeed ?? buildDispatchPlanSeed(now, pin)
  const accountSyncSeed =
    options.accountSyncSeed ?? buildAccountSyncSeed(now, pin)

  // Stability: content hash must not depend on pin.canonicalHash (definition payload).
  const canonical = produceSyntheticCanonicalSnapshot({
    boardId,
    pin,
    boundTasks,
    now,
    producerVersion,
  })
  if (canonical.canonicalHash !== pin.canonicalHash) {
    throw new Error(
      `materializeAuthorityPin: hash unstable after rebind ` +
        `(pass1=${pin.canonicalHash.slice(0, 12)} pass2=${canonical.canonicalHash.slice(0, 12)})`,
    )
  }
  if (pin.canonicalHash === FORBIDDEN_PLACEHOLDER_CANONICAL_HASH) {
    throw new Error(
      'materializeAuthorityPin: authority is still forbidden placeholder',
    )
  }

  return {
    pin,
    boundTasks,
    docs,
    dispatchSeed,
    accountSyncSeed,
    canonical,
    payloadSha256: canonical.payloadSha256,
    boardId,
    now,
  }
}

/**
 * LEDger-only stamp of schema_migrations 000..006 (checksums from on-disk files).
 *
 * Prefer {@link applyProductMigrations000Through006} / applyControlPlaneSchemaToIsoDb
 * for greenfield disposable DBs — healthz clears schema.version when 004/005/006
 * history is present but required CREATE TABLE objects are missing.
 *
 * Kept for staging board-scoped seed (ambient already has tables) and pure ledger
 * refresh. Idempotent: ON DUPLICATE KEY UPDATE. Never touches ambient non-iso DBs
 * (caller must already be on disposable/iso connection).
 *
 * @returns {{ ok: true, applied: string[], skipped: string[], finalVersions: string[] }}
 */
export async function seedSchemaMigrationsThrough006(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
    version VARCHAR(64) NOT NULL,
    filename VARCHAR(255) NOT NULL,
    sha256 CHAR(64) NOT NULL,
    classification VARCHAR(64) NOT NULL,
    applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    applied_by VARCHAR(160) NULL,
    dry_run TINYINT(1) NOT NULL DEFAULT 0,
    PRIMARY KEY (version),
    UNIQUE KEY uq_schema_migrations_filename (filename)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci`)

  let already = []
  try {
    const [rows] = await db.query(
      `SELECT version FROM schema_migrations WHERE dry_run = 0 ORDER BY version ASC`,
    )
    already = (Array.isArray(rows) ? rows : []).map((r) => String(r.version))
  } catch {
    already = []
  }

  const applied = []
  const skipped = []
  const versions = [...FP_C_GREENFIELD_CHAIN_VERSIONS]
  for (const version of versions) {
    if (already.includes(version)) {
      skipped.push(version)
      // Still refresh checksum/classification so ledger matches product files.
    }
    const m = loadMigrationFile(version)
    await db.query(
      `INSERT INTO schema_migrations
         (version, filename, sha256, classification, applied_by, dry_run)
       VALUES (?, ?, ?, ?, ?, 0)
       ON DUPLICATE KEY UPDATE
         filename = VALUES(filename),
         sha256 = VALUES(sha256),
         classification = VALUES(classification),
         applied_by = VALUES(applied_by),
         dry_run = 0`,
      [
        m.version,
        m.filename,
        m.sha256,
        m.classification,
        'seed-isolated-schema-006',
      ],
    )
    if (!already.includes(version)) applied.push(version)
  }

  const [finalRows] = await db.query(
    `SELECT version FROM schema_migrations WHERE dry_run = 0 ORDER BY version ASC`,
  )
  const finalVersions = (Array.isArray(finalRows) ? finalRows : []).map((r) =>
    String(r.version),
  )
  const tip = finalVersions[finalVersions.length - 1] ?? ''
  if (tip !== '006') {
    throw new Error(
      `seedSchemaMigrationsThrough006: expected tip 006, got ${tip || '(empty)'} ` +
        `versions=[${finalVersions.join(',')}]`,
    )
  }
  for (const need of versions) {
    if (!finalVersions.includes(need)) {
      throw new Error(
        `seedSchemaMigrationsThrough006: missing version ${need} after seed`,
      )
    }
  }
  return { ok: true, applied, skipped, finalVersions }
}

/**
 * Apply product migration SQL 000..006 on a disposable iso DB via repository
 * migration API (control-plane-schema-seed applyControlPlaneSchemaToIsoDb).
 * Creates required tables (not ledger-only). Idempotent via schema_migrations.
 *
 * @param {string} dbName
 * @returns {Promise<{ ok: true, dbName: string, applied: string[], skipped: string[], finalApplied: string[], requiredTables: string[], missingRequiredTables: string[] }>}
 */
export async function applyProductMigrations000Through006(dbName) {
  assertSafeIsoDbName(dbName)
  const schema = await applyControlPlaneSchemaToIsoDb(dbName, {
    versions: [...FP_C_GREENFIELD_CHAIN_VERSIONS],
  })
  const missingRequiredTables = []
  await withDbConnection(dbName, async (conn) => {
    for (const table of HEALTHZ_REQUIRED_TABLES_004_006) {
      const [rows] = await conn.query(
        `SELECT 1 AS ok FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
        [table],
      )
      if (!Array.isArray(rows) || rows.length === 0) {
        missingRequiredTables.push(table)
      }
    }
  })
  if (missingRequiredTables.length > 0) {
    throw new Error(
      `applyProductMigrations000Through006: required tables missing after migrate: ` +
        missingRequiredTables.join(','),
    )
  }
  const tip = schema.finalApplied[schema.finalApplied.length - 1] ?? ''
  if (tip !== '006') {
    throw new Error(
      `applyProductMigrations000Through006: expected tip 006, got ${tip || '(empty)'} ` +
        `versions=[${schema.finalApplied.join(',')}]`,
    )
  }
  return {
    ok: true,
    dbName,
    applied: schema.applied,
    skipped: schema.skipped,
    finalApplied: schema.finalApplied,
    requiredTables: [...HEALTHZ_REQUIRED_TABLES_004_006],
    missingRequiredTables,
  }
}

/**
 * Delete only board-scoped rows for the synthetic board, then insert fresh fixture.
 * Does NOT DROP DATABASE, does NOT truncate unrelated boards/tables, does NOT
 * wipe schema_migrations (ledger seeded separately via real migrate / seedSchemaMigrationsThrough006).
 */
/**
 * Product-shaped durable RUNNING row for SEEDED_ONGOING (task-ongoing-1).
 * Must satisfy deriveClaimStateFromRunRecord → VALID_CURRENT + runLiveness RUNNING
 * so Rule 6 ONGOING works when product ownership is durable-only (no dual-read).
 */
export function buildSeededOngoingDurableRunRecord(ctx) {
  const boardId = ctx.boardId
  const nowMs =
    (typeof ctx.now === 'string' ? Date.parse(ctx.now) : Number(ctx.nowMs)) ||
    Date.now()
  const boardRev = Number(ctx.pin?.boardRev ?? 0) || 0
  const planId =
    ctx.dispatchSeed?.planId ??
    ctx.dispatchSeed?.items?.[0]?.planId ??
    'plan-synth-r2d-001'
  const rec = buildFpCRunRecord(boardId, {
    nowMs,
    runId: SEEDED_ONGOING.runId,
    taskId: SEEDED_ONGOING.taskId,
    state: 'RUNNING',
    planId,
    planItemRank: 1,
    targetGate: SEEDED_ONGOING.targetGate,
    role: SEEDED_ONGOING.role,
    agentId: SEEDED_ONGOING.agentId,
    model: SEEDED_ONGOING.model,
    effort: SEEDED_ONGOING.effort,
    maskedAccountRef: 'acc_synth_r2d_001',
    canonicalHash: ctx.pin?.canonicalHash ?? null,
    fencingToken: `fence_synth_${SEEDED_ONGOING.runId}`,
    boardRev,
    idempotencyKey: `idem-synth-ongoing-${boardId}-${SEEDED_ONGOING.runId}`,
  })
  // Fresh lease + distinct material progress (not heartbeat mirror) for PRODUCTIVE ages.
  rec.registeredAtMs = nowMs
  rec.heartbeatAtMs = nowMs
  rec.materialProgressAtMs = nowMs
  rec.leaseExpiresAtMs = nowMs + 30 * 60 * 1000
  rec.stalled = false
  rec.fencingVersion = 1
  rec.history = [
    {
      atMs: nowMs,
      atISO: new Date(nowMs).toISOString(),
      fromState: null,
      toState: 'RUNNING',
      reason: 'synth-ongoing-durable-seed',
      actorId: ctx.actor ?? SEED_ACTOR_ISOLATED,
    },
  ]
  return rec
}

/** Insert product control_plane_runs columns + full record_json (decodeRunRecord path). */
async function insertDurableRunRow(db, rec) {
  const historyJson = JSON.stringify(rec.history)
  const locksJson = JSON.stringify(rec.collisionScopeLockIds ?? [])
  const recordJson = JSON.stringify(rec)
  await db.query(
    `INSERT INTO control_plane_runs (
      board_id, run_id, state, plan_id, plan_item_rank, task_id, target_gate, role,
      agent_id, model, effort, masked_account_ref, canonical_hash,
      collision_scope_lock_ids_json, fencing_token, fencing_version,
      registered_at_ms, heartbeat_at_ms, lease_expires_at_ms, material_progress_at_ms,
      heartbeat_sequence, expected_entity_rev, expected_board_rev, entity_rev, board_rev,
      stalled, history_json, last_heartbeat_response_json, controller_run_id, parent_run_id,
      idempotency_key, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      state=VALUES(state), plan_id=VALUES(plan_id), plan_item_rank=VALUES(plan_item_rank),
      task_id=VALUES(task_id), target_gate=VALUES(target_gate), role=VALUES(role),
      agent_id=VALUES(agent_id), model=VALUES(model), effort=VALUES(effort),
      masked_account_ref=VALUES(masked_account_ref),
      collision_scope_lock_ids_json=VALUES(collision_scope_lock_ids_json),
      fencing_token=VALUES(fencing_token), fencing_version=VALUES(fencing_version),
      registered_at_ms=VALUES(registered_at_ms), heartbeat_at_ms=VALUES(heartbeat_at_ms),
      lease_expires_at_ms=VALUES(lease_expires_at_ms),
      material_progress_at_ms=VALUES(material_progress_at_ms),
      heartbeat_sequence=VALUES(heartbeat_sequence),
      entity_rev=VALUES(entity_rev), board_rev=VALUES(board_rev), stalled=VALUES(stalled),
      history_json=VALUES(history_json), record_json=VALUES(record_json),
      idempotency_key=VALUES(idempotency_key)`,
    [
      rec.boardId,
      rec.runId,
      rec.state,
      rec.planId,
      rec.planItemRank,
      rec.taskId,
      rec.targetGate,
      rec.role,
      rec.agentId,
      rec.model,
      rec.effort,
      rec.maskedAccountRef,
      rec.canonicalHash,
      locksJson,
      rec.fencingToken,
      rec.fencingVersion,
      rec.registeredAtMs,
      rec.heartbeatAtMs,
      rec.leaseExpiresAtMs,
      rec.materialProgressAtMs,
      rec.heartbeatSequence,
      rec.expectedEntityRev,
      rec.expectedBoardRev,
      rec.entityRev,
      rec.boardRev,
      rec.stalled ? 1 : 0,
      historyJson,
      null,
      rec.controllerRunId ?? null,
      rec.parentRunId ?? null,
      rec.idempotencyKey,
      recordJson,
    ],
  )
}

function toMysqlDateTime(value) {
  if (value == null || value === '') return null
  const ms = Date.parse(String(value))
  if (Number.isNaN(ms)) {
    throw new Error(`invalid classification receipt datetime: ${String(value)}`)
  }
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ')
}

/**
 * Persist the synthetic fixture's proven classifications into the product runtime
 * authority. The canonical pin binding deliberately survives later volatile board
 * revisions (dispatch/account bootstrap) while remaining invalid before publication.
 * The one fixture without a receipt is intentionally omitted and therefore remains
 * fail-closed UNCLASSIFIED at the durable left join.
 */
export async function persistDurableClassificationAuthority(db, ctx) {
  const { boardId, boundTasks, pin, actor } = ctx
  const boardRev = Number(pin.boardRev)
  const lifecycleRev = Number(pin.lifecycleRev)
  if (!Number.isSafeInteger(boardRev) || boardRev < 1) {
    throw new Error(
      `durable classification seed requires positive boardRev (got ${pin.boardRev})`,
    )
  }
  if (!Number.isSafeInteger(lifecycleRev) || lifecycleRev < 0) {
    throw new Error(
      `durable classification seed requires non-negative lifecycleRev (got ${pin.lifecycleRev})`,
    )
  }

  const records = []
  for (const task of boundTasks) {
    const source = task.data?.classification
    const sourceReceipt = source?.receipt
    if (!source || !sourceReceipt) continue

    const receipt = {
      ...sourceReceipt,
      taskId: task.id,
      taskClass: source.taskClass,
      disposition: source.disposition,
      canonicalSnapshotId: pin.canonicalSnapshotId,
      canonicalHash: pin.canonicalHash,
      taskHash: pin.taskHash,
      boardRev,
      lifecycleRev,
      bindingMode: 'CANONICAL_PIN',
      canonicalBoardRev: boardRev - 1,
    }
    records.push({ taskId: task.id, source, receipt })
  }

  // Exact current-set cleanup. Immutable receipt history is retained and replayed
  // only when its receipt hash + canonical pin are identical.
  await db.query('DELETE FROM control_plane_classification WHERE board_id=?', [
    boardId,
  ])

  for (const { taskId, source, receipt } of records) {
    const [existingRows] = await db.query(
      `SELECT receipt_hash, canonical_snapshot_id, canonical_hash, task_hash
       FROM control_plane_classification_receipts
       WHERE board_id=? AND receipt_id=? LIMIT 1`,
      [boardId, receipt.receiptId],
    )
    const existing = existingRows?.[0] ?? null
    if (existing) {
      const replayMatches =
        String(existing.receipt_hash) === receipt.receiptHash &&
        String(existing.canonical_snapshot_id) ===
          receipt.canonicalSnapshotId &&
        String(existing.canonical_hash) === receipt.canonicalHash &&
        String(existing.task_hash) === receipt.taskHash
      if (!replayMatches) {
        throw new Error(
          `durable classification receipt replay conflict for ${taskId}/${receipt.receiptId}`,
        )
      }
    } else {
      await db.query(
        `INSERT INTO control_plane_classification_receipts (
           board_id, receipt_id, task_id, receipt_hash, task_class, disposition,
           membership_portfolio_id, membership_proof_hash, canonical_snapshot_id,
           canonical_hash, task_hash, board_rev, lifecycle_rev, issued_at, expires_at,
           receipt_json
         ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [
          boardId,
          receipt.receiptId,
          taskId,
          receipt.receiptHash,
          source.taskClass,
          source.disposition,
          receipt.membershipPortfolioId ?? null,
          receipt.membershipProofHash ?? null,
          receipt.canonicalSnapshotId,
          receipt.canonicalHash,
          receipt.taskHash,
          receipt.boardRev,
          receipt.lifecycleRev,
          toMysqlDateTime(receipt.issuedAt),
          toMysqlDateTime(receipt.expiresAt),
          JSON.stringify(receipt),
        ],
      )
    }

    await db.query(
      `INSERT INTO control_plane_classification (
         board_id, task_id, task_class, disposition,
         classification_receipt_id, classification_receipt_hash, proof_source,
         board_rev, entity_rev, receipt_json, canonical_snapshot_id, canonical_hash,
         task_hash, lifecycle_rev, control_plane_target_gate,
         control_plane_gate_verified_pass, control_plane_root_accepted
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)
       ON DUPLICATE KEY UPDATE
         task_class=VALUES(task_class), disposition=VALUES(disposition),
         classification_receipt_id=VALUES(classification_receipt_id),
         classification_receipt_hash=VALUES(classification_receipt_hash),
         proof_source=VALUES(proof_source), board_rev=VALUES(board_rev),
         entity_rev=VALUES(entity_rev), receipt_json=VALUES(receipt_json),
         canonical_snapshot_id=VALUES(canonical_snapshot_id),
         canonical_hash=VALUES(canonical_hash), task_hash=VALUES(task_hash),
         lifecycle_rev=VALUES(lifecycle_rev),
         control_plane_target_gate=VALUES(control_plane_target_gate),
         control_plane_gate_verified_pass=VALUES(control_plane_gate_verified_pass),
         control_plane_root_accepted=VALUES(control_plane_root_accepted)`,
      [
        boardId,
        taskId,
        source.taskClass,
        source.disposition,
        receipt.receiptId,
        receipt.receiptHash,
        actor,
        receipt.boardRev,
        1,
        JSON.stringify(receipt),
        receipt.canonicalSnapshotId,
        receipt.canonicalHash,
        receipt.taskHash,
        receipt.lifecycleRev,
        source.controlPlaneTargetGate ?? null,
        source.controlPlaneGateVerifiedPass == null
          ? null
          : source.controlPlaneGateVerifiedPass
            ? 1
            : 0,
        source.controlPlaneRootAccepted == null
          ? null
          : source.controlPlaneRootAccepted
            ? 1
            : 0,
      ],
    )
  }

  return {
    classifiedCount: records.length,
    unclassifiedCount: boundTasks.length - records.length,
    taskIds: records.map((record) => record.taskId).sort(),
  }
}

export async function replaceBoardScopedSyntheticRows(db, ctx) {
  const {
    boardId,
    now,
    pin,
    boundTasks,
    docs,
    dispatchSeed,
    accountSyncSeed,
    actor,
    boardName,
    boardDescription,
    producerVersion,
  } = ctx

  // Board-scoped wipe (mfs-rebuild only). Order respects FKs if any exist later.
  // Durable runs cleared so ONGOING ownership comes only from product registry seed
  // (never legacy board_docs dual-read).
  await db.query('DELETE FROM control_plane_runs WHERE board_id=?', [boardId])
  await db.query('DELETE FROM control_plane_classification WHERE board_id=?', [
    boardId,
  ])
  await db.query('DELETE FROM control_plane_evidence WHERE board_id=?', [
    boardId,
  ])
  await db.query('DELETE FROM control_plane_snapshots WHERE board_id=?', [
    boardId,
  ])
  await db.query('DELETE FROM board_revisions WHERE board_id=?', [boardId])
  await db.query('DELETE FROM audit_log WHERE board_id=?', [boardId])
  await db.query('DELETE FROM tasks WHERE board_id=?', [boardId])
  await db.query('DELETE FROM board_docs WHERE board_id=?', [boardId])
  await db.query('DELETE FROM boards WHERE id=?', [boardId])

  await db.query(
    'INSERT INTO boards (id, name, description, views, created_at) VALUES (?,?,?,?,?)',
    [
      boardId,
      boardName,
      boardDescription,
      JSON.stringify(BOARD_VIEWS),
      now.slice(0, 10),
    ],
  )

  for (const [kind, data] of Object.entries(docs)) {
    await db.query(
      'INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)',
      [boardId, kind, JSON.stringify(data)],
    )
  }

  await db.query(
    'INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)',
    [boardId, 'synth_dispatch_plan', JSON.stringify(dispatchSeed)],
  )
  await db.query(
    'INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)',
    [boardId, 'synth_account_sync', JSON.stringify(accountSyncSeed)],
  )

  // Synthetic conventions only — keyed row, not a full globals wipe.
  await db.query(
    `INSERT INTO globals (k, data) VALUES (?,?)
     ON DUPLICATE KEY UPDATE data=VALUES(data)`,
    [
      'conventions',
      JSON.stringify({
        note: 'synthetic conventions for control-center seed',
        synthetic: true,
        provenance: actor,
      }),
    ],
  )

  for (const t of boundTasks) {
    const classification = t.data?.classification ?? null
    const summary = {
      checkpoints: t.data.checkpoints ?? [],
      dependencies: t.data.dependencies ?? [],
      impacts: t.data.impacts ?? [],
      mappingPct: t.data.mappingPct ?? null,
      status: t.data.status ?? null,
      ...(classification
        ? {
            classification,
            classificationReceipt: classification.receipt ?? null,
            taskClass: classification.taskClass ?? null,
            disposition: classification.disposition ?? null,
            classificationReceiptId: classification.receipt?.receiptId ?? null,
            classificationReceiptHash:
              classification.receipt?.receiptHash ?? null,
          }
        : {}),
    }
    const lifecycleStage = t.lifecycle_stage ?? t.data?.lifecycleStage ?? null
    const implementerRun = t.implementer_run ?? t.data?.implementerRun ?? null
    const blockedReason = t.blocked_reason ?? t.data?.blockedReason ?? null
    await db.query(
      `INSERT INTO tasks (
         board_id, id, project_id, feature_contract_id, phase, title, updated,
         summary, data, rev, lifecycle_stage, implementer_run, blocked_reason, last_receipt_at
       ) VALUES (?,?,?,?,?,?,?,?,?,0,?,?,?,?)`,
      [
        boardId,
        t.id,
        t.project_id ?? null,
        t.feature_contract_id ?? null,
        t.phase ?? null,
        t.title,
        now,
        JSON.stringify(summary),
        JSON.stringify(t.data),
        lifecycleStage,
        implementerRun,
        blockedReason,
        classification?.receipt?.issuedAt ?? null,
      ],
    )
  }

  // Real MFS_CANONICAL_TASK_SNAPSHOT_V1 — never TM_UI_CONTRACT_V1 as pin authority.
  // TM_UI_CONTRACT_V1 is screenshot/harness schema only; treating it as complete was a
  // false pin that caused SCHEMA_INVALID / mismatch on definition load.
  const canonical = produceSyntheticCanonicalSnapshot({
    boardId,
    pin,
    boundTasks,
    now,
    producerVersion: producerVersion ?? 'seed-isolated-canonical-v1',
  })
  if (!isCanonicalCompleteSchema(canonical.schemaVersion)) {
    throw new Error(
      `seed refused non-canonical schema for control_plane_snapshots: ${canonical.schemaVersion}`,
    )
  }
  if (canonical.schemaVersion === UI_CONTRACT_SCHEMA) {
    throw new Error(
      'seed refused TM_UI_CONTRACT_V1 as control_plane snapshot (not canonical complete)',
    )
  }

  // subject_hash must equal server canonicalSubjectHash(snapshot) for pin-complete load.
  // Authority pin MUST already carry the materialized hash (materializeAuthorityPin).
  const pinSubjectHash = canonical.canonicalHash
  if (!pin?.canonicalHash || pin.canonicalHash !== pinSubjectHash) {
    throw new Error(
      `replaceBoardScopedSyntheticRows: pin.canonicalHash must equal produced ` +
        `canonicalSubjectHash (pin=${String(pin?.canonicalHash).slice(0, 16)} ` +
        `produced=${pinSubjectHash.slice(0, 16)}) — call materializeAuthorityPin first`,
    )
  }
  if (pinSubjectHash === FORBIDDEN_PLACEHOLDER_CANONICAL_HASH) {
    throw new Error(
      'replaceBoardScopedSyntheticRows: refusing forbidden placeholder as subject_hash',
    )
  }

  await db.query(
    `INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id)
     VALUES (?,?,?,?,?)`,
    [
      boardId,
      pin.boardRev,
      pin.lifecycleRev,
      pinSubjectHash,
      pin.canonicalSnapshotId,
    ],
  )

  await db.query(
    `INSERT INTO control_plane_snapshots
      (board_id, snapshot_id, schema_version, source_repo_id, source_commit_sha, payload_sha256, board_rev, lifecycle_rev, generated_at, producer_version, payload_json)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      boardId,
      pin.canonicalSnapshotId,
      CANONICAL_TASK_SNAPSHOT_SCHEMA,
      canonical.manifest.sourceRepoId,
      canonical.manifest.sourceCommitSha,
      canonical.payloadSha256,
      pin.boardRev,
      pin.lifecycleRev,
      now.slice(0, 23).replace('T', ' '),
      canonical.manifest.producerVersion,
      // payload_json = definition payload only (server reconstructSnapshotFromRegistryRow).
      // Manifest fields live in columns; never store TM_UI_CONTRACT_V1 as schema_version.
      JSON.stringify(canonical.payload),
    ],
  )

  await persistDurableClassificationAuthority(db, ctx)

  await db.query(
    `INSERT INTO control_plane_evidence
      (board_id, evidence_id, entity_type, entity_id, receipt_kind, subject_hash, subject_board_rev, verdict, findings_json, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?)`,
    [
      boardId,
      'ev-synth-r2d-001',
      'task',
      'task-done-1',
      'classification_receipt',
      pin.taskHash.slice(0, 64),
      pin.boardRev,
      'PASS',
      JSON.stringify({
        synthetic: true,
        note: 'positive classification evidence',
        membershipPortfolioId: 'SALES_WEB_RELATED_BACKEND',
      }),
      now.slice(0, 23).replace('T', ' '),
    ],
  )
  await db.query(
    `INSERT INTO control_plane_evidence
      (board_id, evidence_id, entity_type, entity_id, domain, stage_key, receipt_kind, subject_hash, subject_board_rev, verifier_agent_id, verifier_model, verifier_run_id, verdict, findings_json, captured_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
    [
      boardId,
      'ev-synth-r2d-stage-done',
      'task',
      'task-done-1',
      'lifecycle',
      'PROD_READY',
      'stage_evidence',
      pin.taskHash.slice(0, 64),
      pin.boardRev,
      'run-synth-idle',
      'gpt-5.3-codex-spark',
      'run-synth-idle',
      'PASS',
      JSON.stringify({ synthetic: true, independentVerifier: true }),
      now.slice(0, 23).replace('T', ' '),
    ],
  )

  await db.query(
    `INSERT INTO audit_log (board_id, ts, actor, action, task_id, detail) VALUES (?,?,?,?,?,?)`,
    [
      boardId,
      now,
      actor,
      'seed_created',
      null,
      JSON.stringify({
        synthetic: true,
        purpose: 'synthetic control-center fixture seed',
        taskHash: pin.taskHash,
        boardRev: pin.boardRev,
      }),
    ],
  )

  // Durable V3 ownership for Overview ONGOING (product control_plane_runs only).
  // board_docs kind=runs may still exist for residual diagnostics — never relied on here.
  const ongoingRun = buildSeededOngoingDurableRunRecord({
    boardId,
    now,
    pin,
    dispatchSeed,
    actor,
  })
  await insertDurableRunRow(db, ongoingRun)
}

/** Programmatic readback: counts + pin + taskHash. No secrets. */
export async function readbackSeedProof(db, boardId) {
  const [bc] = await db.query('SELECT COUNT(*) AS n FROM boards WHERE id=?', [
    boardId,
  ])
  const [tc] = await db.query(
    'SELECT COUNT(*) AS n FROM tasks WHERE board_id=?',
    [boardId],
  )
  const [dc] = await db.query(
    'SELECT COUNT(*) AS n FROM board_docs WHERE board_id=?',
    [boardId],
  )
  const [rc] = await db.query(
    'SELECT COUNT(*) AS n FROM board_revisions WHERE board_id=?',
    [boardId],
  )
  const [revRows] = await db.query(
    `SELECT board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id
     FROM board_revisions WHERE board_id=?`,
    [boardId],
  )
  const [taskIdRows] = await db.query(
    'SELECT id FROM tasks WHERE board_id=? ORDER BY id',
    [boardId],
  )
  const taskIds = (taskIdRows ?? []).map((r) => r.id)
  const taskHash = computeTaskHash(taskIds)
  const [classifiedRows] = await db.query(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE board_id=? AND JSON_EXTRACT(summary, '$.classification.receipt.receiptId') IS NOT NULL`,
    [boardId],
  )
  const [missingRows] = await db.query(
    `SELECT COUNT(*) AS n FROM tasks
     WHERE board_id=? AND id='task-missing-proof-1'
       AND JSON_EXTRACT(summary, '$.classification') IS NULL`,
    [boardId],
  )
  const [doneStage] = await db.query(
    `SELECT lifecycle_stage AS s FROM tasks WHERE board_id=? AND id='task-done-1'`,
    [boardId],
  )
  const [durableClassificationRows] = await db.query(
    `SELECT task_id, task_class, disposition, classification_receipt_id,
            classification_receipt_hash, board_rev, receipt_json,
            canonical_snapshot_id, canonical_hash, task_hash, lifecycle_rev
     FROM control_plane_classification
     WHERE board_id=? ORDER BY task_id`,
    [boardId],
  )
  const durableClassifications = (durableClassificationRows ?? []).map(
    (row) => {
      let receipt = null
      try {
        receipt =
          typeof row.receipt_json === 'string'
            ? JSON.parse(row.receipt_json)
            : row.receipt_json
      } catch {
        receipt = null
      }
      return {
        taskId: row.task_id,
        taskClass: row.task_class,
        disposition: row.disposition,
        receiptId: row.classification_receipt_id,
        receiptHash: row.classification_receipt_hash,
        boardRev: Number(row.board_rev),
        canonicalSnapshotId: row.canonical_snapshot_id,
        canonicalHash: row.canonical_hash,
        taskHash: row.task_hash,
        lifecycleRev: Number(row.lifecycle_rev),
        receipt,
      }
    },
  )
  const durableCanonicalPinCount = durableClassifications.filter(
    (record) =>
      record.receipt?.bindingMode === 'CANONICAL_PIN' &&
      Number(record.receipt?.canonicalBoardRev) + 1 ===
        Number(record.receipt?.boardRev),
  ).length

  // Durable ONGOING run readback (product control_plane_runs — not board_docs).
  let durableOngoingRunning = 0
  let durableOngoingRun = null
  try {
    const [runCount] = await db.query(
      `SELECT COUNT(*) AS n FROM control_plane_runs
       WHERE board_id=? AND task_id=? AND state='RUNNING'`,
      [boardId, SEEDED_ONGOING.taskId],
    )
    durableOngoingRunning = Number(runCount[0]?.n ?? 0)
    const [runRows] = await db.query(
      `SELECT run_id, state, agent_id, role, model, effort, masked_account_ref,
              fencing_token, fencing_version, lease_expires_at_ms, registered_at_ms,
              heartbeat_at_ms, material_progress_at_ms, stalled, record_json
       FROM control_plane_runs
       WHERE board_id=? AND task_id=? AND run_id=?
       LIMIT 1`,
      [boardId, SEEDED_ONGOING.taskId, SEEDED_ONGOING.runId],
    )
    durableOngoingRun = runRows?.[0] ?? null
  } catch {
    durableOngoingRunning = 0
    durableOngoingRun = null
  }

  const durableRecord =
    durableOngoingRun?.record_json != null
      ? typeof durableOngoingRun.record_json === 'string'
        ? (() => {
            try {
              return JSON.parse(durableOngoingRun.record_json)
            } catch {
              return null
            }
          })()
        : durableOngoingRun.record_json
      : null

  // Presence of schema_migrations (must remain if migrations already applied).
  let schemaMigrationsPresent = null
  try {
    const [sm] = await db.query(
      `SELECT COUNT(*) AS n FROM information_schema.tables
       WHERE table_schema = DATABASE() AND table_name = 'schema_migrations'`,
    )
    schemaMigrationsPresent = Number(sm[0]?.n) === 1
  } catch {
    schemaMigrationsPresent = null
  }

  const rev = revRows?.[0] ?? null
  return {
    boardId,
    boards: Number(bc[0].n),
    tasks: Number(tc[0].n),
    boardDocs: Number(dc[0].n),
    boardRevisions: Number(rc[0].n),
    taskIds,
    taskHash,
    pin: rev
      ? {
          boardRev: String(rev.board_rev),
          lifecycleRev: String(rev.lifecycle_rev),
          subjectHash: rev.subject_hash,
          canonicalSnapshotId: rev.canonical_snapshot_id,
        }
      : null,
    seedProof: {
      classifiedTasks: Number(classifiedRows[0].n),
      missingProofUnclassified: Number(missingRows[0].n) === 1,
      durableClassifiedTasks: durableClassifications.length,
      durableCanonicalPinCount,
      durableClassificationTaskIds: durableClassifications.map(
        (record) => record.taskId,
      ),
      doneLifecycleStage: doneStage[0]?.s ?? null,
      durableOngoingRunningCount: durableOngoingRunning,
      durableOngoingRunId: durableOngoingRun?.run_id ?? null,
      durableOngoingState: durableOngoingRun?.state ?? null,
      durableOngoingHasFence: Boolean(durableOngoingRun?.fencing_token),
      durableOngoingHasLease:
        durableOngoingRun?.lease_expires_at_ms != null &&
        Number(durableOngoingRun.lease_expires_at_ms) > 0,
      durableOngoingHasAgent: Boolean(durableOngoingRun?.agent_id),
      durableOngoingHasRecordJson: Boolean(
        durableRecord && durableRecord.runId === SEEDED_ONGOING.runId,
      ),
      durableOngoingFreshTimes: Boolean(
        durableOngoingRun?.registered_at_ms != null &&
        durableOngoingRun?.heartbeat_at_ms != null &&
        durableOngoingRun?.material_progress_at_ms != null,
      ),
    },
    durableClassifications,
    schemaMigrationsPresent,
  }
}

function assertDurableClassificationSeedProof(readback, ctx, label) {
  const expectedTaskIds = ctx.boundTasks
    .filter((task) => task.data?.classification?.receipt)
    .map((task) => task.id)
    .sort()
  const actualTaskIds = [
    ...(readback.seedProof?.durableClassificationTaskIds ?? []),
  ].sort()
  const expectedClassified = Number(ctx.contract.classifiedCount)
  const expectedUnclassified = Number(ctx.contract.unclassifiedCount)
  const actualUnclassified = Number(readback.tasks) - actualTaskIds.length
  const valid =
    actualTaskIds.length === expectedClassified &&
    Number(readback.seedProof?.durableCanonicalPinCount) ===
      expectedClassified &&
    actualUnclassified === expectedUnclassified &&
    JSON.stringify(actualTaskIds) === JSON.stringify(expectedTaskIds)
  if (!valid) {
    throw new Error(
      `${label}: durable classification authority mismatch: ` +
        JSON.stringify({
          expectedTaskIds,
          actualTaskIds,
          expectedClassified,
          actualClassified: actualTaskIds.length,
          expectedUnclassified,
          actualUnclassified,
          durableCanonicalPinCount:
            readback.seedProof?.durableCanonicalPinCount ?? null,
        }),
    )
  }
}

function buildSeedContext(options = {}) {
  const now = options.now ?? new Date().toISOString()
  const boardId =
    options.boardId ?? process.env.BOARD_ID?.trim() ?? DEFAULT_BOARD_ID
  const producerVersion = options.producerVersion ?? 'c3-r4f-seed'

  // Materialize authority hash first so pin/tasks/docs/dispatch/account stay coherent.
  // Callers may pass a fully materialized pin (with real 64-hex) to skip recompute path
  // only when boundTasks/docs/dispatch are also supplied together.
  let pin
  let boundTasks
  let docs
  let dispatchSeed
  let accountSyncSeed
  let materializeMeta = null

  const pinOverride = options.pin ?? null
  const hasMaterializedOverride =
    pinOverride &&
    typeof pinOverride.canonicalHash === 'string' &&
    /^[0-9a-f]{64}$/i.test(pinOverride.canonicalHash) &&
    pinOverride.canonicalHash.toLowerCase() !==
      FORBIDDEN_PLACEHOLDER_CANONICAL_HASH

  if (
    hasMaterializedOverride &&
    options.tasks &&
    options.docs &&
    options.dispatchSeed &&
    options.accountSyncSeed
  ) {
    pin = { ...buildHarnessPin(options.tasks.map((t) => t.id)), ...pinOverride }
    boundTasks = options.tasks
    docs = options.docs
    dispatchSeed = options.dispatchSeed
    accountSyncSeed = options.accountSyncSeed
  } else {
    const mat = materializeAuthorityPin({
      boardId,
      now,
      producerVersion,
      tasks: options.tasks,
      pinBase: pinOverride
        ? {
            boardRev: pinOverride.boardRev,
            lifecycleRev: pinOverride.lifecycleRev,
            canonicalSnapshotId: pinOverride.canonicalSnapshotId,
          }
        : undefined,
      docs: options.docs,
      dispatchSeed: options.dispatchSeed,
      accountSyncSeed: options.accountSyncSeed,
    })
    pin = mat.pin
    boundTasks = mat.boundTasks
    docs = mat.docs
    dispatchSeed = mat.dispatchSeed
    accountSyncSeed = mat.accountSyncSeed
    materializeMeta = {
      payloadSha256: mat.payloadSha256,
      canonicalHash: mat.pin.canonicalHash,
    }
  }

  const contract = validateFixtureContract(boundTasks, docs, pin)
  if (!contract.ok) {
    throw new Error(
      `seed fixture contract failed: ${contract.errors.join('; ')}`,
    )
  }
  if (
    !pin.canonicalHash ||
    pin.canonicalHash === FORBIDDEN_PLACEHOLDER_CANONICAL_HASH
  ) {
    throw new Error(
      'seed fixture pin.canonicalHash missing or forbidden placeholder',
    )
  }
  return {
    now,
    boardId,
    pin,
    boundTasks,
    docs,
    dispatchSeed,
    accountSyncSeed,
    contract,
    materializeMeta,
    actor: options.actor ?? SEED_ACTOR_ISOLATED,
    boardName: options.boardName ?? 'MFS Rebuild (SYNTH C3-R4F)',
    boardDescription:
      options.boardDescription ??
      'Synthetic isolated board for deterministic browser harness. Not production.',
    producerVersion,
  }
}

function safeMysqlMeta() {
  const m = resolveMysqlConfig()
  return { host: m.host, port: m.port, user: m.user }
}

function writeProvenance(provenance, options = {}) {
  const provenancePath =
    options.provenancePath ||
    process.env.CAIRN_SEED_PROVENANCE_PATH ||
    path.join(__dirname, 'SYNTHETIC_PROVENANCE.latest.json')
  fs.mkdirSync(path.dirname(provenancePath), { recursive: true })
  // Never write password/token fields.
  const safe = {
    ...provenance,
    mysql: provenance.mysql
      ? {
          host: provenance.mysql.host,
          port: provenance.mysql.port,
          user: provenance.mysql.user,
        }
      : safeMysqlMeta(),
  }
  fs.writeFileSync(provenancePath, JSON.stringify(safe, null, 2), 'utf8')
  return provenancePath
}

// ---------------------------------------------------------------------------
// Isolated mode (DROP+CREATE disposable DB)
// ---------------------------------------------------------------------------

export async function seedIsolatedControlCenter(options = {}) {
  const ctx = buildSeedContext({
    ...options,
    actor: options.actor ?? SEED_ACTOR_ISOLATED,
    producerVersion: options.producerVersion ?? 'c3-r4f-seed',
  })
  const dbName = options.dbName ?? makeIsolatedDbName(options.slug ?? 'r4f')

  await recreateIsolatedDatabase(dbName)

  // Real product migrations 000–006 (CREATE tables + ledger) — NOT ledger-only stamp.
  // healthz requires schema-required-tables for 004/005/006 before schema.version=006.
  const schemaApply = await applyProductMigrations000Through006(dbName)

  return withDbConnection(dbName, async (db) => {
    // IF NOT EXISTS safety for any seed-only columns beyond migration baseline.
    await ensureBaselineTables(db)
    await replaceBoardScopedSyntheticRows(db, ctx)
    const readback = await readbackSeedProof(db, ctx.boardId)
    assertDurableClassificationSeedProof(
      readback,
      ctx,
      'seedIsolatedControlCenter',
    )

    // Fail-closed: subject_hash must equal materialized authority (parity source).
    if (
      !readback.pin?.subjectHash ||
      readback.pin.subjectHash !== ctx.pin.canonicalHash
    ) {
      throw new Error(
        `seedIsolatedControlCenter: subject_hash/readback pin mismatch ` +
          `subject=${String(readback.pin?.subjectHash).slice(0, 16)} ` +
          `authority=${String(ctx.pin.canonicalHash).slice(0, 16)}`,
      )
    }

    // Fail-closed: durable RUNNING ownership for task-ongoing-1 must exist.
    if (
      !readback.seedProof?.durableOngoingRunningCount ||
      readback.seedProof.durableOngoingRunId !== SEEDED_ONGOING.runId ||
      !readback.seedProof.durableOngoingHasFence ||
      !readback.seedProof.durableOngoingHasLease ||
      !readback.seedProof.durableOngoingHasAgent ||
      !readback.seedProof.durableOngoingHasRecordJson ||
      !readback.seedProof.durableOngoingFreshTimes
    ) {
      throw new Error(
        `seedIsolatedControlCenter: durable control_plane_runs RUNNING seed missing/incomplete ` +
          `for ${SEEDED_ONGOING.taskId} (${SEEDED_ONGOING.runId}): ` +
          JSON.stringify(readback.seedProof ?? {}),
      )
    }

    const provenance = {
      mode: 'isolated',
      createdAt: ctx.now,
      isoDb: dbName,
      mysql: safeMysqlMeta(),
      boardId: ctx.boardId,
      boards: readback.boards,
      tasks: readback.tasks,
      boardDocs: readback.boardDocs,
      boardRevisions: readback.boardRevisions,
      usersSeeded: 0,
      // Authority pin for comparePinParity — numbers preserved for MCP CAS.
      pin: {
        canonicalSnapshotId: ctx.pin.canonicalSnapshotId,
        canonicalHash: ctx.pin.canonicalHash,
        taskHash: ctx.pin.taskHash,
        boardRev: ctx.pin.boardRev,
        lifecycleRev: ctx.pin.lifecycleRev,
      },
      schemaMigrations: {
        tip:
          schemaApply.finalApplied[schemaApply.finalApplied.length - 1] ?? null,
        versions: schemaApply.finalApplied,
        appliedThisRun: schemaApply.applied,
        skippedThisRun: schemaApply.skipped,
        mode: 'product-migrations-000-006',
        requiredTablesPresent: schemaApply.missingRequiredTables.length === 0,
        requiredTables: schemaApply.requiredTables,
      },
      dispatchSeed: {
        planId: ctx.dispatchSeed.planId,
        entityExpectedRev:
          ctx.dispatchSeed.entityExpectedRev ??
          ctx.dispatchSeed.items?.[0]?.expectedEntityRev ??
          null,
        expectedBoardRev: ctx.dispatchSeed.expectedBoardRev ?? null,
      },
      seedProof: {
        ...readback.seedProof,
        dispatchPlanId: ctx.dispatchSeed.planId,
        accountSyncSourceRevision: ctx.accountSyncSeed.sourceRevision,
        readbackTaskHash: readback.taskHash,
        subjectHashMatchesAuthority: true,
      },
      note: 'Zero users — first admin via /login bootstrap. Synthetic only. No ambient DB copy. Authority canonicalHash is content-derived (not placeholder).',
      positiveExamples: [
        'task-done-1 PRODUCT+ACTIVE + PROD_READY',
        'task-ongoing-1 durable control_plane_runs RUNNING + VALID_CURRENT (deriveDurableOwnership; not board_docs dual-read)',
        'task-next-1 dispatch plan rank 1',
        'task-missing-proof-1 sole UNCLASSIFIED',
      ],
      overlays: [
        'DONE',
        'ONGOING',
        'NEXT',
        'QUEUED',
        'BLOCKED',
        'RECON',
        'STALE',
        'missing-proof',
      ],
      controlPlaneBootstrap: {
        dispatchPlanKind: 'synth_dispatch_plan',
        accountSyncKind: 'synth_account_sync',
        note: 'Harness must publish via authorized MCP after preview start (in-memory stores).',
      },
      syntheticOnly: true,
      productionDerived: false,
    }

    const provenancePath = writeProvenance(provenance, options)
    return {
      ok: true,
      ...provenance,
      provenancePath,
      readback,
      dispatchSeed: ctx.dispatchSeed,
      accountSyncSeed: ctx.accountSyncSeed,
      contract: {
        ok: ctx.contract.ok,
        taskHash: ctx.contract.taskHash,
        classifiedCount: ctx.contract.classifiedCount,
        unclassifiedCount: ctx.contract.unclassifiedCount,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Staging mode (no DROP DATABASE; gated; board-scoped upsert)
// ---------------------------------------------------------------------------

/**
 * Open a connection to a named DB without iso-name guard (staging DB name is fixed).
 * Never logs password.
 */
async function withNamedDbConnection(database, fn) {
  const cfg = resolveMysqlConfig()
  const conn = await mysql.createConnection({
    ...cfg,
    database,
    multipleStatements: true,
  })
  try {
    return await fn(conn)
  } finally {
    await conn.end()
  }
}

/**
 * Ensure the staging database schema exists (CREATE DATABASE IF NOT EXISTS only).
 * Never DROP DATABASE.
 */
export async function ensureStagingDatabaseExists(dbName = STAGING_DB_NAME) {
  if (dbName !== STAGING_DB_NAME) {
    throw new Error(
      `FAIL-CLOSED: ensureStagingDatabaseExists refuses non-staging name "${dbName}"`,
    )
  }
  const cfg = resolveMysqlConfig()
  const root = await mysql.createConnection({
    ...cfg,
    multipleStatements: true,
  })
  try {
    await root.query(
      `CREATE DATABASE IF NOT EXISTS \`${dbName}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  } finally {
    await root.end()
  }
  return dbName
}

/**
 * Idempotent synthetic seed for cairn_tm_v3_staging.
 * Requires assertStagingSeedAllowed() to pass.
 */
export async function seedStagingSynthetic(options = {}) {
  const gate = assertStagingSeedAllowed({
    env: options.env,
    dbName: options.dbName ?? process.env.CAIRN_DB_NAME,
    host: options.host,
    approved: options.approved,
    allowLocalHost: options.allowLocalHost,
    stagingHostsCsv: options.stagingHostsCsv,
    stagingHosts: options.stagingHosts,
  })
  if (!gate.ok) {
    const err = new Error(gate.reason)
    err.code = 'STAGING_SEED_REFUSED'
    err.hostClass = gate.hostClass
    throw err
  }

  const dbName = STAGING_DB_NAME
  const ctx = buildSeedContext({
    ...options,
    boardId: options.boardId ?? DEFAULT_BOARD_ID,
    actor: SEED_ACTOR_STAGING,
    boardName: options.boardName ?? 'MFS Rebuild (SYNTH STAGING)',
    boardDescription:
      options.boardDescription ??
      'Synthetic staging board (mfs-rebuild). Not production. Idempotent board-scoped seed.',
    producerVersion: options.producerVersion ?? 'staging-synthetic-seed',
  })

  if (
    ctx.boardId !== DEFAULT_BOARD_ID &&
    options.allowNonDefaultBoard !== true
  ) {
    throw new Error(
      `FAIL-CLOSED staging-seed: boardId must be "${DEFAULT_BOARD_ID}" (got "${ctx.boardId}")`,
    )
  }

  // Never DROP DATABASE. Create schema if missing (fresh volume).
  await ensureStagingDatabaseExists(dbName)

  return withNamedDbConnection(dbName, async (db) => {
    await ensureBaselineTables(db)
    // Idempotent ledger seed — does not wipe existing history; ODKU only.
    const schemaSeed = await seedSchemaMigrationsThrough006(db)
    await replaceBoardScopedSyntheticRows(db, ctx)
    const readback = await readbackSeedProof(db, ctx.boardId)
    assertDurableClassificationSeedProof(readback, ctx, 'seedStagingSynthetic')

    // Idempotency check: second replace in-process optional via options.verifyIdempotent
    let idempotent = null
    if (options.verifyIdempotent !== false) {
      const schemaSeed2 = await seedSchemaMigrationsThrough006(db)
      await replaceBoardScopedSyntheticRows(db, ctx)
      const readback2 = await readbackSeedProof(db, ctx.boardId)
      assertDurableClassificationSeedProof(
        readback2,
        ctx,
        'seedStagingSynthetic:idempotent',
      )
      idempotent = {
        tasksMatch: readback2.tasks === readback.tasks,
        taskHashMatch: readback2.taskHash === readback.taskHash,
        pinBoardRevMatch: readback2.pin?.boardRev === readback.pin?.boardRev,
        snapshotMatch:
          readback2.pin?.canonicalSnapshotId ===
          readback.pin?.canonicalSnapshotId,
        subjectHashMatch:
          readback2.pin?.subjectHash === readback.pin?.subjectHash,
        schemaTipMatch:
          schemaSeed2.finalVersions[schemaSeed2.finalVersions.length - 1] ===
          schemaSeed.finalVersions[schemaSeed.finalVersions.length - 1],
        schemaSecondSkippedAll: schemaSeed2.applied.length === 0,
        tasks: readback2.tasks,
        taskHash: readback2.taskHash,
      }
      if (
        !idempotent.tasksMatch ||
        !idempotent.taskHashMatch ||
        !idempotent.pinBoardRevMatch ||
        !idempotent.subjectHashMatch
      ) {
        throw new Error(
          `staging-seed idempotent readback mismatch: ${JSON.stringify(idempotent)}`,
        )
      }
    }

    const expectedTaskHash = computeTaskHash(CANONICAL_TASK_IDS)
    if (readback.taskHash !== expectedTaskHash) {
      throw new Error(
        `staging-seed taskHash mismatch: got ${readback.taskHash} expected ${expectedTaskHash}`,
      )
    }
    if (readback.tasks !== CANONICAL_TASK_IDS.length) {
      throw new Error(
        `staging-seed task count mismatch: got ${readback.tasks} expected ${CANONICAL_TASK_IDS.length}`,
      )
    }
    if (String(readback.pin?.boardRev) !== String(ctx.pin.boardRev)) {
      throw new Error(
        `staging-seed boardRev mismatch: got ${readback.pin?.boardRev} expected ${ctx.pin.boardRev}`,
      )
    }
    if (readback.pin?.subjectHash !== ctx.pin.canonicalHash) {
      throw new Error(
        `staging-seed subject_hash mismatch: got ${readback.pin?.subjectHash} expected ${ctx.pin.canonicalHash}`,
      )
    }
    if (
      !readback.seedProof?.durableOngoingRunningCount ||
      readback.seedProof.durableOngoingRunId !== SEEDED_ONGOING.runId ||
      !readback.seedProof.durableOngoingHasFence ||
      !readback.seedProof.durableOngoingHasLease ||
      !readback.seedProof.durableOngoingHasAgent ||
      !readback.seedProof.durableOngoingHasRecordJson ||
      !readback.seedProof.durableOngoingFreshTimes
    ) {
      throw new Error(
        `staging-seed durable control_plane_runs RUNNING incomplete for ${SEEDED_ONGOING.taskId}: ` +
          JSON.stringify(readback.seedProof ?? {}),
      )
    }

    const provenance = {
      mode: 'staging',
      createdAt: ctx.now,
      dbName,
      hostClass: gate.hostClass,
      mysql: safeMysqlMeta(),
      boardId: ctx.boardId,
      boards: readback.boards,
      tasks: readback.tasks,
      boardDocs: readback.boardDocs,
      boardRevisions: readback.boardRevisions,
      usersSeeded: 0,
      pin: {
        canonicalSnapshotId: ctx.pin.canonicalSnapshotId,
        canonicalHash: ctx.pin.canonicalHash,
        taskHash: ctx.pin.taskHash,
        boardRev: ctx.pin.boardRev,
        lifecycleRev: ctx.pin.lifecycleRev,
      },
      schemaMigrations: {
        tip:
          schemaSeed.finalVersions[schemaSeed.finalVersions.length - 1] ?? null,
        versions: schemaSeed.finalVersions,
      },
      readback: {
        taskHash: readback.taskHash,
        tasks: readback.tasks,
        pin: readback.pin,
        seedProof: readback.seedProof,
        schemaMigrationsPresent: readback.schemaMigrationsPresent,
      },
      idempotent,
      syntheticOnly: true,
      productionDerived: false,
      note: 'Board-scoped upsert only. No DROP DATABASE. Migration history preserved when present. Synthetic only. Authority hash content-derived.',
    }

    const provenancePath = writeProvenance(provenance, options)
    return {
      ok: true,
      ...provenance,
      provenancePath,
      contract: {
        ok: ctx.contract.ok,
        taskHash: ctx.contract.taskHash,
        classifiedCount: ctx.contract.classifiedCount,
        unclassifiedCount: ctx.contract.unclassifiedCount,
      },
    }
  })
}

// ---------------------------------------------------------------------------
// Self-test (pure) + disposable MySQL proof (iso DB, never ambient)
// ---------------------------------------------------------------------------

/** Pure contract/gate tests — no MySQL. */
export function runSeedSelfTests() {
  const results = []
  const ok = (name, pass, detail = null) => results.push({ name, pass, detail })

  // Fixture contract (materialized authority pin)
  const now = '2026-07-13T12:00:00.000Z'
  const mat = materializeAuthorityPin({
    boardId: DEFAULT_BOARD_ID,
    now,
    producerVersion: 'seed-self-test',
  })
  const pin = mat.pin
  const tasks = mat.boundTasks
  const docs = mat.docs
  const contract = validateFixtureContract(tasks, docs, pin)
  ok('fixture-contract', contract.ok, contract.errors?.join('; ') || null)
  ok(
    'canonical-task-count',
    tasks.length === CANONICAL_TASK_IDS.length,
    String(tasks.length),
  )
  ok(
    'task-hash-hex',
    /^[0-9a-f]{64}$/i.test(pin.taskHash),
    pin.taskHash?.slice(0, 12),
  )
  ok(
    'authority-hash-hex-not-placeholder',
    /^[0-9a-f]{64}$/i.test(pin.canonicalHash) &&
      pin.canonicalHash !== FORBIDDEN_PLACEHOLDER_CANONICAL_HASH,
    pin.canonicalHash?.slice(0, 16),
  )
  ok('board-id-default', DEFAULT_BOARD_ID === 'mfs-rebuild')
  ok(
    'pre-materialize-pin-has-null-hash',
    buildHarnessPin().canonicalHash == null,
    String(buildHarnessPin().canonicalHash),
  )

  // Seed hardening: real MFS_CANONICAL_TASK_SNAPSHOT_V1, never TM_UI as complete.
  const synthCanon = produceSyntheticCanonicalSnapshot({
    boardId: DEFAULT_BOARD_ID,
    pin,
    boundTasks: tasks,
    now,
    producerVersion: 'seed-self-test',
  })
  ok(
    'canonical-schema-is-mfs-v1',
    synthCanon.schemaVersion === CANONICAL_TASK_SNAPSHOT_SCHEMA,
    synthCanon.schemaVersion,
  )
  ok(
    'tm-ui-contract-never-canonical-complete',
    !isCanonicalCompleteSchema(UI_CONTRACT_SCHEMA),
    UI_CONTRACT_SCHEMA,
  )
  ok(
    'canonical-payload-sha256-hex',
    /^[0-9a-f]{64}$/i.test(synthCanon.payloadSha256),
    synthCanon.payloadSha256?.slice(0, 12),
  )
  ok(
    'canonical-subject-hash-matches-pin',
    synthCanon.canonicalHash === pin.canonicalHash,
    synthCanon.canonicalHash?.slice(0, 16),
  )
  ok(
    'canonical-payload-has-tasks',
    Array.isArray(synthCanon.payload.tasks) &&
      synthCanon.payload.tasks.length === tasks.length,
    String(synthCanon.payload.tasks?.length),
  )
  ok(
    'canonical-no-lifecycle-on-tasks',
    synthCanon.payload.tasks.every(
      (t) => t.lifecycleStage == null && t.lifecycle_stage == null,
    ),
    'lifecycle-free',
  )

  // Content change → hash change (fail-closed pin identity)
  const alteredTasks = tasks.map((t) =>
    t.id === 'task-done-1'
      ? { ...t, title: `${t.title} [MUTATED-FOR-HASH]` }
      : t,
  )
  const alteredCanon = produceSyntheticCanonicalSnapshot({
    boardId: DEFAULT_BOARD_ID,
    pin,
    boundTasks: alteredTasks,
    now,
    producerVersion: 'seed-self-test',
  })
  ok(
    'content-change-changes-payload-and-subject-hash',
    alteredCanon.payloadSha256 !== synthCanon.payloadSha256 &&
      alteredCanon.canonicalHash !== pin.canonicalHash,
    `base=${pin.canonicalHash.slice(0, 12)} alt=${alteredCanon.canonicalHash.slice(0, 12)}`,
  )

  // Cross-pin reject: bindAuthorityCanonicalHash refuses placeholder
  let placeholderRejected = false
  try {
    bindAuthorityCanonicalHash(pin, FORBIDDEN_PLACEHOLDER_CANONICAL_HASH)
  } catch {
    placeholderRejected = true
  }
  ok('cross-pin-placeholder-rejected', placeholderRejected)

  // Cross-pin reject: wrong authority hash fails contract vs receipts
  const wrongPin = {
    ...pin,
    canonicalHash: 'e'.repeat(64),
  }
  const wrongContract = validateFixtureContract(tasks, docs, wrongPin)
  ok(
    'cross-pin-receipt-mismatch-detected',
    !wrongContract.ok &&
      wrongContract.errors.some((e) => /canonicalHash mismatch/i.test(e)),
    wrongContract.errors?.slice(0, 2).join('; '),
  )

  // Schema chain tip constant (pure — loadMigrationFile for 006)
  try {
    const m006 = loadMigrationFile('006')
    ok(
      'schema-006-file-loadable',
      m006.version === '006' &&
        /^[0-9a-f]{64}$/i.test(m006.sha256) &&
        m006.filename.includes('006'),
      m006.filename,
    )
    ok(
      'schema-greenfield-chain-through-006',
      FP_C_GREENFIELD_CHAIN_VERSIONS[
        FP_C_GREENFIELD_CHAIN_VERSIONS.length - 1
      ] === '006' && FP_C_GREENFIELD_CHAIN_VERSIONS.includes('000'),
      FP_C_GREENFIELD_CHAIN_VERSIONS.join(','),
    )
    ok(
      'healthz-required-tables-004-006-named',
      HEALTHZ_REQUIRED_TABLES_004_006.length === 6 &&
        HEALTHZ_REQUIRED_TABLES_004_006.includes(
          'control_plane_dispatch_plans',
        ) &&
        HEALTHZ_REQUIRED_TABLES_004_006.includes(
          'control_plane_stage_evidence_receipts',
        ),
      HEALTHZ_REQUIRED_TABLES_004_006.join(','),
    )
  } catch (e) {
    ok('schema-006-file-loadable', false, String(e?.message || e))
    ok('schema-greenfield-chain-through-006', false, String(e?.message || e))
    ok('healthz-required-tables-004-006-named', false, String(e?.message || e))
  }

  // Dispatch/account seeds expose explicit entityExpectedRev 0 (create) for MCP envelope
  const dispatchSeed = mat.dispatchSeed ?? buildDispatchPlanSeed(now, pin)
  ok(
    'dispatch-seed-entityExpectedRev-explicit-zero',
    dispatchSeed.entityExpectedRev === 0 &&
      dispatchSeed.expectedEntityRev === 0 &&
      dispatchSeed.items?.[0]?.expectedEntityRev === 0,
    JSON.stringify({
      top: dispatchSeed.entityExpectedRev,
      alias: dispatchSeed.expectedEntityRev,
      item: dispatchSeed.items?.[0]?.expectedEntityRev,
    }),
  )
  const accountSeed = mat.accountSyncSeed ?? buildAccountSyncSeed(now, pin)
  ok(
    'account-seed-entityExpectedRev-explicit-zero',
    accountSeed.entityExpectedRev === 0 && accountSeed.expectedEntityRev === 0,
    String(accountSeed.entityExpectedRev),
  )

  // Gate: missing approval
  const g1 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: 'cairn-tm-v3-mysql',
    approved: '0',
  })
  ok('gate-refuse-unapproved', !g1.ok && /APPROVED/.test(g1.reason), g1.reason)

  // Gate: wrong env
  const g2 = assertStagingSeedAllowed({
    env: 'production',
    dbName: STAGING_DB_NAME,
    host: 'cairn-tm-v3-mysql',
    approved: '1',
  })
  ok('gate-refuse-prod-env', !g2.ok && /CAIRN_ENV/.test(g2.reason), g2.reason)

  // Gate: wrong DB
  const g3 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: 'cairn_taskmanager',
    host: 'cairn-tm-v3-mysql',
    approved: '1',
  })
  ok(
    'gate-refuse-wrong-db',
    !g3.ok && /CAIRN_DB_NAME/.test(g3.reason),
    g3.reason,
  )

  // Gate: production host
  const g4 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: 'db.prod.mfsdev.net',
    approved: '1',
  })
  ok(
    'gate-refuse-prod-host',
    !g4.ok && g4.hostClass === 'PRODUCTION',
    g4.reason,
  )

  // Gate: unknown remote
  const g5 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: 'evil.example.com',
    approved: '1',
  })
  ok(
    'gate-refuse-unknown-remote',
    !g5.ok && g5.hostClass === 'UNKNOWN_REMOTE',
    g5.reason,
  )

  // Gate: staging compose host OK
  const g6 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: 'cairn-tm-v3-mysql',
    approved: '1',
  })
  ok('gate-allow-compose-host', g6.ok && g6.hostClass === 'STAGING', g6.reason)

  // Gate: local refused without allow flag
  const g7 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: '127.0.0.1',
    approved: '1',
    allowLocalHost: false,
  })
  ok('gate-refuse-local-default', !g7.ok, g7.reason)

  // Gate: local allowed with flag
  const g8 = assertStagingSeedAllowed({
    env: 'staging',
    dbName: STAGING_DB_NAME,
    host: '127.0.0.1',
    approved: '1',
    allowLocalHost: true,
  })
  ok('gate-allow-local-flag', g8.ok && g8.hostClass === 'LOCAL', g8.reason)

  // Host classifier
  ok('class-local', classifySeedHost('localhost') === 'LOCAL')
  ok('class-staging-label', classifySeedHost('cairn-tm-v3-mysql') === 'STAGING')
  ok(
    'class-prod',
    classifySeedHost('api.production.mfsdev.net') === 'PRODUCTION',
  )
  ok('class-unknown', classifySeedHost('10.0.0.5') === 'UNKNOWN_REMOTE')

  // Constants
  ok('staging-db-name', STAGING_DB_NAME === 'cairn_tm_v3_staging')
  ok(
    'no-drop-in-ensure-sql',
    !/DROP\s+DATABASE/i.test(ensureBaselineTables.toString()),
  )
  ok(
    'replace-is-board-scoped',
    /DELETE FROM tasks WHERE board_id=\?/.test(
      replaceBoardScopedSyntheticRows.toString(),
    ),
  )
  const replaceSrc = replaceBoardScopedSyntheticRows.toString()
  ok(
    'replace-clears-control-plane-runs',
    /DELETE FROM control_plane_runs WHERE board_id=\?/.test(replaceSrc),
  )
  ok(
    'replace-inserts-control-plane-runs',
    /INSERT INTO control_plane_runs/.test(replaceSrc) ||
      /insertDurableRunRow/.test(replaceSrc),
  )
  ok(
    'replace-no-legacy-dual-read-flag',
    !/enableLegacyDualRead|legacyDualRead|DUAL_READ/.test(replaceSrc),
  )

  // Product-shaped durable ongoing record for deriveDurableOwnership VALID_CURRENT+RUNNING.
  const ongoingRec = buildSeededOngoingDurableRunRecord({
    boardId: DEFAULT_BOARD_ID,
    now,
    pin,
    dispatchSeed: mat.dispatchSeed ?? buildDispatchPlanSeed(now, pin),
    actor: SEED_ACTOR_ISOLATED,
  })
  ok(
    'durable-ongoing-ids',
    ongoingRec.runId === SEEDED_ONGOING.runId &&
      ongoingRec.taskId === SEEDED_ONGOING.taskId &&
      ongoingRec.state === 'RUNNING' &&
      ongoingRec.stalled === false,
    `${ongoingRec.runId}/${ongoingRec.taskId}/${ongoingRec.state}`,
  )
  ok(
    'durable-ongoing-lease-fence-agent',
    Boolean(ongoingRec.agentId) &&
      Boolean(ongoingRec.fencingToken) &&
      ongoingRec.fencingVersion === 1 &&
      ongoingRec.leaseExpiresAtMs != null &&
      ongoingRec.leaseExpiresAtMs > ongoingRec.registeredAtMs,
    `agent=${ongoingRec.agentId} fence=${ongoingRec.fencingToken} lease=${ongoingRec.leaseExpiresAtMs}`,
  )
  ok(
    'durable-ongoing-zero-click-fields',
    ongoingRec.role === SEEDED_ONGOING.role &&
      ongoingRec.model === SEEDED_ONGOING.model &&
      ongoingRec.effort === SEEDED_ONGOING.effort &&
      ongoingRec.targetGate === SEEDED_ONGOING.targetGate &&
      Boolean(ongoingRec.maskedAccountRef) &&
      ongoingRec.registeredAtMs != null &&
      ongoingRec.heartbeatAtMs != null &&
      ongoingRec.materialProgressAtMs != null,
    JSON.stringify({
      role: ongoingRec.role,
      model: ongoingRec.model,
      effort: ongoingRec.effort,
      gate: ongoingRec.targetGate,
      mask: ongoingRec.maskedAccountRef,
    }),
  )
  ok(
    'durable-ongoing-full-record-json-shape',
    ongoingRec.boardId === DEFAULT_BOARD_ID &&
      Array.isArray(ongoingRec.history) &&
      ongoingRec.history[0]?.toState === 'RUNNING',
    String(ongoingRec.history?.[0]?.reason),
  )
  ok(
    'baseline-creates-control-plane-runs',
    /CREATE TABLE IF NOT EXISTS control_plane_runs/.test(
      ensureBaselineTables.toString(),
    ),
  )

  const failCount = results.filter((r) => !r.pass).length
  return { ok: failCount === 0, failCount, results }
}

/**
 * Disposable local MySQL proof of ensure+replace+idempotent readback.
 * Uses cairn_tm_e2e_* name only — never cairn_taskmanager / production.
 * Does not require staging gate (tests shared upsert path).
 */
export async function runDisposableUpsertProof(options = {}) {
  const dbName = options.dbName ?? makeIsolatedDbName(options.slug ?? 'stgseed')
  assertSafeIsoDbName(dbName)
  const ctx = buildSeedContext({
    ...options,
    actor: SEED_ACTOR_STAGING,
    boardName: 'MFS Rebuild (DISPOSABLE PROOF)',
    boardDescription:
      'Disposable local proof of staging upsert path. Not production.',
    producerVersion: 'disposable-staging-upsert-proof',
  })

  // Plant a fake sibling board + schema_migrations to prove non-touch.
  await recreateIsolatedDatabase(dbName)
  try {
    return await withDbConnection(dbName, async (db) => {
      await ensureBaselineTables(db)
      await db.query(
        `CREATE TABLE IF NOT EXISTS schema_migrations (
          version VARCHAR(32) NOT NULL PRIMARY KEY,
          filename VARCHAR(255) NOT NULL,
          sha256 CHAR(64) NULL,
          applied_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3)
        ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`,
      )
      await db.query(
        `INSERT INTO schema_migrations (version, filename, sha256) VALUES (?,?,?)`,
        ['001', '001_baseline.sql', 'a'.repeat(64)],
      )
      await db.query(
        `INSERT INTO boards (id, name, description, views, created_at) VALUES (?,?,?,?,?)`,
        [
          'unrelated-board',
          'Must Survive Seed',
          'Sibling board — seeder must not delete',
          JSON.stringify(['board']),
          '2026-01-01',
        ],
      )
      await db.query(
        `INSERT INTO tasks (board_id, id, title, updated, summary, data, rev)
         VALUES (?,?,?,?,?,?,0)`,
        [
          'unrelated-board',
          'keep-me',
          'unrelated',
          ctx.now,
          JSON.stringify({}),
          JSON.stringify({ syntheticSibling: true }),
        ],
      )

      await replaceBoardScopedSyntheticRows(db, ctx)
      const r1 = await readbackSeedProof(db, ctx.boardId)
      assertDurableClassificationSeedProof(
        r1,
        ctx,
        'runDisposableUpsertProof:first',
      )
      await replaceBoardScopedSyntheticRows(db, ctx)
      const r2 = await readbackSeedProof(db, ctx.boardId)
      assertDurableClassificationSeedProof(
        r2,
        ctx,
        'runDisposableUpsertProof:second',
      )

      const [siblingBoards] = await db.query(
        `SELECT COUNT(*) AS n FROM boards WHERE id='unrelated-board'`,
      )
      const [siblingTasks] = await db.query(
        `SELECT COUNT(*) AS n FROM tasks WHERE board_id='unrelated-board'`,
      )
      const [mig] = await db.query(
        `SELECT version, filename FROM schema_migrations WHERE version='001'`,
      )
      const [runRows] = await db.query(
        `SELECT run_id, state, agent_id, fencing_token, lease_expires_at_ms, record_json
         FROM control_plane_runs WHERE board_id=? AND task_id=?`,
        [ctx.boardId, SEEDED_ONGOING.taskId],
      )

      const durableOk =
        r1.seedProof?.durableOngoingRunningCount >= 1 &&
        r1.seedProof?.durableOngoingRunId === SEEDED_ONGOING.runId &&
        r1.seedProof?.durableOngoingState === 'RUNNING' &&
        r1.seedProof?.durableOngoingHasFence === true &&
        r1.seedProof?.durableOngoingHasLease === true &&
        r1.seedProof?.durableOngoingHasAgent === true &&
        r1.seedProof?.durableOngoingHasRecordJson === true &&
        r1.seedProof?.durableOngoingFreshTimes === true &&
        r2.seedProof?.durableOngoingRunId === SEEDED_ONGOING.runId &&
        Array.isArray(runRows) &&
        runRows.length === 1 &&
        runRows[0].run_id === SEEDED_ONGOING.runId &&
        runRows[0].state === 'RUNNING'

      const proof = {
        ok: true,
        mode: 'disposable-upsert-proof',
        dbName,
        mysql: safeMysqlMeta(),
        first: {
          tasks: r1.tasks,
          taskHash: r1.taskHash,
          pin: r1.pin,
          seedProof: r1.seedProof,
        },
        second: {
          tasks: r2.tasks,
          taskHash: r2.taskHash,
          pin: r2.pin,
          seedProof: r2.seedProof,
        },
        idempotent: {
          tasksMatch: r1.tasks === r2.tasks,
          taskHashMatch: r1.taskHash === r2.taskHash,
          pinMatch: r1.pin?.canonicalSnapshotId === r2.pin?.canonicalSnapshotId,
          durableOngoingMatch:
            r1.seedProof?.durableOngoingRunId ===
              r2.seedProof?.durableOngoingRunId &&
            r1.seedProof?.durableOngoingRunningCount ===
              r2.seedProof?.durableOngoingRunningCount,
        },
        durableOngoing: {
          ok: durableOk,
          runId: r1.seedProof?.durableOngoingRunId ?? null,
          state: r1.seedProof?.durableOngoingState ?? null,
          count: r1.seedProof?.durableOngoingRunningCount ?? 0,
        },
        preserved: {
          unrelatedBoard: Number(siblingBoards[0].n) === 1,
          unrelatedTask: Number(siblingTasks[0].n) === 1,
          schemaMigration001: mig?.[0]?.version === '001',
        },
        syntheticOnly: true,
      }

      proof.ok =
        proof.idempotent.tasksMatch &&
        proof.idempotent.taskHashMatch &&
        proof.idempotent.pinMatch &&
        proof.idempotent.durableOngoingMatch &&
        proof.durableOngoing.ok &&
        proof.preserved.unrelatedBoard &&
        proof.preserved.unrelatedTask &&
        proof.preserved.schemaMigration001 &&
        r1.tasks === CANONICAL_TASK_IDS.length &&
        r1.taskHash === computeTaskHash(CANONICAL_TASK_IDS)

      return proof
    })
  } finally {
    if (options.keepDb !== true) {
      try {
        await dropIsolatedDatabase(dbName)
      } catch {
        /* best-effort cleanup */
      }
    }
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function argFlag(name) {
  return process.argv.includes(name)
}

async function main() {
  if (argFlag('--self-test')) {
    const r = runSeedSelfTests()
    console.log(JSON.stringify({ mode: 'self-test', ...r }, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--disposable-proof')) {
    const r = await runDisposableUpsertProof()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--staging')) {
    const result = await seedStagingSynthetic()
    console.log(JSON.stringify(result, null, 2))
    return
  }

  const result = await seedIsolatedControlCenter()
  console.log(JSON.stringify(result, null, 2))
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))

if (isMain) {
  main().catch((e) => {
    console.error(String(e?.stack || e))
    process.exit(1)
  })
}
