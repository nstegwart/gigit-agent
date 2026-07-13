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
  const dbName = String(
    opts.dbName ?? process.env.CAIRN_DB_NAME ?? '',
  ).trim()
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
}

/**
 * Produce a real MFS_CANONICAL_TASK_SNAPSHOT_V1 envelope from synthetic seed tasks.
 * TM_UI_CONTRACT_V1 stubs must NEVER be written as control_plane_snapshots —
 * that schema is UI harness only and must not be treated as pin-complete canonical.
 *
 * Definition-only payload (no lifecycle stage/evidence fields on tasks).
 * Hash = sha256(stable-sorted JSON of payload) matching server produceCanonicalSnapshot.
 *
 * @returns {{ schemaVersion: string, manifest: object, payload: object, payloadSha256: string }}
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
    const featureId = t.feature_contract_id ? String(t.feature_contract_id) : null
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
    const f = a.fromTaskId < b.fromTaskId ? -1 : a.fromTaskId > b.fromTaskId ? 1 : 0
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
 * Delete only board-scoped rows for the synthetic board, then insert fresh fixture.
 * Does NOT DROP DATABASE, does NOT truncate unrelated boards/tables, does NOT
 * touch schema_migrations.
 */
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
  await db.query('DELETE FROM control_plane_evidence WHERE board_id=?', [boardId])
  await db.query('DELETE FROM control_plane_snapshots WHERE board_id=?', [boardId])
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
    await db.query('INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
      boardId,
      kind,
      JSON.stringify(data),
    ])
  }

  await db.query('INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
    boardId,
    'synth_dispatch_plan',
    JSON.stringify(dispatchSeed),
  ])
  await db.query('INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)', [
    boardId,
    'synth_account_sync',
    JSON.stringify(accountSyncSeed),
  ])

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
            classificationReceiptHash: classification.receipt?.receiptHash ?? null,
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
    throw new Error('seed refused TM_UI_CONTRACT_V1 as control_plane snapshot (not canonical complete)')
  }

  // subject_hash must equal server canonicalSubjectHash(snapshot) for pin-complete load.
  // Prefer produced canonicalHash over fixture pin.canonicalHash (harness residual).
  const pinSubjectHash = canonical.canonicalHash

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
}

/** Programmatic readback: counts + pin + taskHash. No secrets. */
export async function readbackSeedProof(db, boardId) {
  const [bc] = await db.query('SELECT COUNT(*) AS n FROM boards WHERE id=?', [boardId])
  const [tc] = await db.query('SELECT COUNT(*) AS n FROM tasks WHERE board_id=?', [boardId])
  const [dc] = await db.query('SELECT COUNT(*) AS n FROM board_docs WHERE board_id=?', [
    boardId,
  ])
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
      doneLifecycleStage: doneStage[0]?.s ?? null,
    },
    schemaMigrationsPresent,
  }
}

function buildSeedContext(options = {}) {
  const now = options.now ?? new Date().toISOString()
  const boardId =
    options.boardId ?? process.env.BOARD_ID?.trim() ?? DEFAULT_BOARD_ID
  const tasks = options.tasks ?? buildSyntheticTasks(now)
  const pin = { ...buildHarnessPin(tasks.map((t) => t.id)), ...(options.pin ?? {}) }
  const boundTasks = options.tasks ?? buildSyntheticTasks(now, pin)
  const docs = options.docs ?? buildBoardDocs(now, pin)
  const dispatchSeed = options.dispatchSeed ?? buildDispatchPlanSeed(now, pin)
  const accountSyncSeed = options.accountSyncSeed ?? buildAccountSyncSeed(now, pin)
  const contract = validateFixtureContract(boundTasks, docs)
  if (!contract.ok) {
    throw new Error(`seed fixture contract failed: ${contract.errors.join('; ')}`)
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
    actor: options.actor ?? SEED_ACTOR_ISOLATED,
    boardName: options.boardName ?? 'MFS Rebuild (SYNTH C3-R4F)',
    boardDescription:
      options.boardDescription ??
      'Synthetic isolated board for deterministic browser harness. Not production.',
    producerVersion: options.producerVersion ?? 'c3-r4f-seed',
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

  return withDbConnection(dbName, async (db) => {
    await ensureBaselineTables(db)
    await replaceBoardScopedSyntheticRows(db, ctx)
    const readback = await readbackSeedProof(db, ctx.boardId)

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
      pin: {
        canonicalSnapshotId: ctx.pin.canonicalSnapshotId,
        canonicalHash: ctx.pin.canonicalHash,
        taskHash: ctx.pin.taskHash,
        boardRev: String(ctx.pin.boardRev),
        lifecycleRev: String(ctx.pin.lifecycleRev),
      },
      seedProof: {
        ...readback.seedProof,
        dispatchPlanId: ctx.dispatchSeed.planId,
        accountSyncSourceRevision: ctx.accountSyncSeed.sourceRevision,
        readbackTaskHash: readback.taskHash,
      },
      note: 'Zero users — first admin via /login bootstrap. Synthetic only. No ambient DB copy.',
      positiveExamples: [
        'task-done-1 PRODUCT+ACTIVE + PROD_READY',
        'task-ongoing-1 claim VALID_CURRENT + run running',
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
  const root = await mysql.createConnection({ ...cfg, multipleStatements: true })
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

  if (ctx.boardId !== DEFAULT_BOARD_ID && options.allowNonDefaultBoard !== true) {
    throw new Error(
      `FAIL-CLOSED staging-seed: boardId must be "${DEFAULT_BOARD_ID}" (got "${ctx.boardId}")`,
    )
  }

  // Never DROP DATABASE. Create schema if missing (fresh volume).
  await ensureStagingDatabaseExists(dbName)

  return withNamedDbConnection(dbName, async (db) => {
    await ensureBaselineTables(db)
    await replaceBoardScopedSyntheticRows(db, ctx)
    const readback = await readbackSeedProof(db, ctx.boardId)

    // Idempotency check: second replace in-process optional via options.verifyIdempotent
    let idempotent = null
    if (options.verifyIdempotent !== false) {
      await replaceBoardScopedSyntheticRows(db, ctx)
      const readback2 = await readbackSeedProof(db, ctx.boardId)
      idempotent = {
        tasksMatch: readback2.tasks === readback.tasks,
        taskHashMatch: readback2.taskHash === readback.taskHash,
        pinBoardRevMatch: readback2.pin?.boardRev === readback.pin?.boardRev,
        snapshotMatch:
          readback2.pin?.canonicalSnapshotId === readback.pin?.canonicalSnapshotId,
        tasks: readback2.tasks,
        taskHash: readback2.taskHash,
      }
      if (
        !idempotent.tasksMatch ||
        !idempotent.taskHashMatch ||
        !idempotent.pinBoardRevMatch
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
        boardRev: String(ctx.pin.boardRev),
        lifecycleRev: String(ctx.pin.lifecycleRev),
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
      note: 'Board-scoped upsert only. No DROP DATABASE. Migration history preserved when present. Synthetic only.',
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

  // Fixture contract
  const now = '2026-07-13T12:00:00.000Z'
  const pin = buildHarnessPin()
  const tasks = buildSyntheticTasks(now, pin)
  const docs = buildBoardDocs(now, pin)
  const contract = validateFixtureContract(tasks, docs)
  ok('fixture-contract', contract.ok, contract.errors?.join('; ') || null)
  ok('canonical-task-count', tasks.length === CANONICAL_TASK_IDS.length, String(tasks.length))
  ok(
    'task-hash-hex',
    /^[0-9a-f]{64}$/i.test(pin.taskHash),
    pin.taskHash?.slice(0, 12),
  )
  ok('board-id-default', DEFAULT_BOARD_ID === 'mfs-rebuild')

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
    'canonical-payload-has-tasks',
    Array.isArray(synthCanon.payload.tasks) && synthCanon.payload.tasks.length === tasks.length,
    String(synthCanon.payload.tasks?.length),
  )
  ok(
    'canonical-no-lifecycle-on-tasks',
    synthCanon.payload.tasks.every(
      (t) => t.lifecycleStage == null && t.lifecycle_stage == null,
    ),
    'lifecycle-free',
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
  ok('gate-refuse-wrong-db', !g3.ok && /CAIRN_DB_NAME/.test(g3.reason), g3.reason)

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
  ok('class-prod', classifySeedHost('api.production.mfsdev.net') === 'PRODUCTION')
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
    boardDescription: 'Disposable local proof of staging upsert path. Not production.',
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
      await replaceBoardScopedSyntheticRows(db, ctx)
      const r2 = await readbackSeedProof(db, ctx.boardId)

      const [siblingBoards] = await db.query(
        `SELECT COUNT(*) AS n FROM boards WHERE id='unrelated-board'`,
      )
      const [siblingTasks] = await db.query(
        `SELECT COUNT(*) AS n FROM tasks WHERE board_id='unrelated-board'`,
      )
      const [mig] = await db.query(
        `SELECT version, filename FROM schema_migrations WHERE version='001'`,
      )

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
        },
        idempotent: {
          tasksMatch: r1.tasks === r2.tasks,
          taskHashMatch: r1.taskHash === r2.taskHash,
          pinMatch: r1.pin?.canonicalSnapshotId === r2.pin?.canonicalSnapshotId,
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
