#!/usr/bin/env node
/**
 * Disposable staging/local SCALE fixture loader + cleanup harness (AC-PERF-01 inputs).
 *
 * Loads synthetic 1000 tasks / 200 runs / 20 masked accounts / 100 OPEN decisions
 * into an **isolated** DB + **isolated** board only.
 *
 * Defaults: dry-run / self-test. Never loads shared staging (`mfs-rebuild` board or
 * `cairn_tm_v3_staging` DB). Never production-derived. No commit/deploy.
 *
 * Usage (repo root):
 *   node qa/perf/scale-fixture-loader.mjs                 # dry-run plan (default)
 *   node qa/perf/scale-fixture-loader.mjs --self-test     # pure gate + count tests
 *   node qa/perf/scale-fixture-loader.mjs --dry-run       # prepare payload, no DB
 *   CAIRN_SCALE_LOAD_APPROVED=1 CAIRN_SCALE_LOAD_ALLOW_LOCAL=1 \\
 *     node qa/perf/scale-fixture-loader.mjs --disposable-proof
 *   CAIRN_SCALE_LOAD_APPROVED=1 CAIRN_SCALE_LOAD_ALLOW_LOCAL=1 \\
 *     node qa/perf/scale-fixture-loader.mjs --load
 *   CAIRN_SCALE_LOAD_APPROVED=1 CAIRN_SCALE_LOAD_ALLOW_LOCAL=1 \\
 *     node qa/perf/scale-fixture-loader.mjs --cleanup
 *
 * Env (load/cleanup/disposable-proof mutation paths):
 *   CAIRN_SCALE_LOAD_APPROVED=1   required for any DB mutation
 *   CAIRN_SCALE_LOAD_ALLOW_LOCAL=1  required when host is loopback (no auto-bypass,
 *                                 including --disposable-proof)
 *   BOARD_ID                      default mfs-rebuild-scale (shared mfs-rebuild refused)
 *   CAIRN_DB_HOST/PORT/USER/PASSWORD
 *   CAIRN_ISO_DB_NAME             optional fixed iso DB (must pass assertSafeIsoDbName)
 *   SCALE_FIXTURE_DIR             default qa/fixtures/staging/scale-1000
 *
 * Synthetic provenance only. Masked accounts only. Deterministic IDs. Idempotent
 * board-scoped replace. Rollback = board-scoped cleanup (+ optional DROP iso DB).
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
  databaseExists,
} from '../e2e/lib/db-iso.mjs'
import {
  generateScaleFixture,
  writeScaleFixture,
  SCALE_COUNTS,
} from '../fixtures/staging/scale-1000/generate.mjs'
import { evaluateStagingDataLoad } from '../fixtures/staging/provenance-gate.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(__dirname, '../..')

export const SCALE_LOADER_SCHEMA = 'MFS_SCALE_FIXTURE_LOADER_V1'
export const DEFAULT_SCALE_BOARD_ID = 'mfs-rebuild-scale'
export const SHARED_STAGING_BOARD_ID = 'mfs-rebuild'
export const SHARED_STAGING_DB_NAME = 'cairn_tm_v3_staging'
export const SEED_ACTOR = 'scale-fixture-loader'
export const DEFAULT_FIXTURE_DIR = path.join(
  ROOT,
  'qa/fixtures/staging/scale-1000',
)

const LOCAL_HOSTS = new Set(['localhost', '127.0.0.1', '::1', ''])
const PRODUCTION_MARKERS = [/prod/i, /production/i, /\.mfsdev\.net$/i]
const FORBIDDEN_BOARD_IDS = new Set([SHARED_STAGING_BOARD_ID, 'production', 'prod'])
const FORBIDDEN_DB_NAMES = new Set([
  SHARED_STAGING_DB_NAME,
  'cairn_taskmanager',
  'mysql',
  'information_schema',
  'performance_schema',
  'sys',
])

// ---------------------------------------------------------------------------
// CLI helpers
// ---------------------------------------------------------------------------

function argFlag(name) {
  return process.argv.includes(name)
}

function argValue(name) {
  const i = process.argv.indexOf(name)
  if (i >= 0 && process.argv[i + 1]) return process.argv[i + 1]
  return null
}

function sha256Hex(s) {
  return createHash('sha256').update(s, 'utf8').digest('hex')
}

function envTruthy(name) {
  const v = process.env[name]
  return v === '1' || v === 'true' || v === true || v === 1
}

// ---------------------------------------------------------------------------
// Gates (pure)
// ---------------------------------------------------------------------------

/**
 * Classify DB host for scale load authorization.
 * @returns {'LOCAL'|'STAGING_LABEL'|'PRODUCTION'|'UNKNOWN_REMOTE'}
 */
export function classifyScaleHost(host, opts = {}) {
  const h = String(host ?? '')
    .trim()
    .toLowerCase()
  if (LOCAL_HOSTS.has(h)) return 'LOCAL'
  if (
    PRODUCTION_MARKERS.some((re) => re.test(h)) ||
    h === 'task-manager.mfsdev.net'
  ) {
    return 'PRODUCTION'
  }
  const stagingLabels = new Set([
    'cairn-tm-v3-mysql',
    'cairn_tm_v3_staging',
    'tm-v3-staging',
    ...String(opts.stagingHostsCsv ?? process.env.CAIRN_STAGING_DB_HOSTS ?? '')
      .split(',')
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
  ])
  if (stagingLabels.has(h)) return 'STAGING_LABEL'
  return 'UNKNOWN_REMOTE'
}

/**
 * Fail-closed gate for any real load/cleanup mutation.
 * Shared staging board/DB always refused (task contract: do not load shared staging).
 *
 * @param {{
 *   approved?: string|boolean
 *   boardId?: string
 *   dbName?: string
 *   host?: string
 *   allowLocalHost?: boolean
 *   mode?: 'load'|'cleanup'|'disposable-proof'
 * }} opts
 */
export function assertScaleLoadAllowed(opts = {}) {
  const approvedRaw = opts.approved ?? process.env.CAIRN_SCALE_LOAD_APPROVED ?? ''
  const approved =
    approvedRaw === true ||
    approvedRaw === 1 ||
    String(approvedRaw).trim() === '1'
  const boardId = String(
    opts.boardId ?? process.env.BOARD_ID ?? DEFAULT_SCALE_BOARD_ID,
  ).trim()
  const dbName = String(opts.dbName ?? process.env.CAIRN_ISO_DB_NAME ?? '').trim()
  const host = String(
    opts.host ?? process.env.CAIRN_DB_HOST ?? resolveMysqlConfig().host,
  ).trim()
  const hostClass = classifyScaleHost(host, opts)

  if (!approved) {
    return {
      ok: false,
      code: 'APPROVAL_REQUIRED',
      reason:
        'FAIL-CLOSED scale-load: CAIRN_SCALE_LOAD_APPROVED=1 is required for DB mutation',
      hostClass,
      boardId,
      dbName: dbName || null,
    }
  }

  if (!boardId || FORBIDDEN_BOARD_IDS.has(boardId)) {
    return {
      ok: false,
      code: 'SHARED_OR_FORBIDDEN_BOARD',
      reason: `FAIL-CLOSED scale-load: boardId "${boardId || '(empty)'}" is shared/forbidden — use isolated board (default ${DEFAULT_SCALE_BOARD_ID})`,
      hostClass,
      boardId,
      dbName: dbName || null,
    }
  }

  if (dbName && FORBIDDEN_DB_NAMES.has(dbName)) {
    return {
      ok: false,
      code: 'SHARED_OR_FORBIDDEN_DB',
      reason: `FAIL-CLOSED scale-load: database "${dbName}" is shared/ambient/forbidden — use isolated cairn_tm_synth_* / cairn_tm_e2e_* name only`,
      hostClass,
      boardId,
      dbName,
    }
  }

  if (hostClass === 'PRODUCTION') {
    return {
      ok: false,
      code: 'PRODUCTION_HOST',
      reason: `FAIL-CLOSED scale-load: refusing PRODUCTION host "${host}"`,
      hostClass,
      boardId,
      dbName: dbName || null,
    }
  }

  if (hostClass === 'UNKNOWN_REMOTE') {
    return {
      ok: false,
      code: 'UNKNOWN_REMOTE_HOST',
      reason: `FAIL-CLOSED scale-load: host "${host}" is UNKNOWN_REMOTE — use LOCAL loopback disposable proof or known compose label`,
      hostClass,
      boardId,
      dbName: dbName || null,
    }
  }

  // Shared staging compose DNS is still refused for this harness (isolated only).
  if (hostClass === 'STAGING_LABEL') {
    return {
      ok: false,
      code: 'SHARED_STAGING_HOST',
      reason: `FAIL-CLOSED scale-load: host "${host}" is shared staging compose DNS — this harness is isolated-DB only (do not load shared staging)`,
      hostClass,
      boardId,
      dbName: dbName || null,
    }
  }

  if (hostClass === 'LOCAL') {
    const allowLocal =
      opts.allowLocalHost === true || envTruthy('CAIRN_SCALE_LOAD_ALLOW_LOCAL')
    if (!allowLocal) {
      return {
        ok: false,
        code: 'LOCAL_HOST_NOT_ALLOWED',
        reason:
          'FAIL-CLOSED scale-load: LOCAL host requires CAIRN_SCALE_LOAD_ALLOW_LOCAL=1 (disposable proof path)',
        hostClass,
        boardId,
        dbName: dbName || null,
      }
    }
  }

  // Provenance: synthetic only
  const provenance = evaluateStagingDataLoad({
    mode: 'SYNTHETIC',
    purpose: 'scale-fixture-loader-disposable',
    productionDerived: false,
  })
  if (!provenance.ok) {
    return {
      ok: false,
      code: provenance.code ?? 'PROVENANCE_REFUSED',
      reason: provenance.message ?? 'provenance gate refused',
      hostClass,
      boardId,
      dbName: dbName || null,
      provenance,
    }
  }

  return {
    ok: true,
    code: null,
    reason: null,
    hostClass,
    boardId,
    dbName: dbName || null,
    provenance,
  }
}

/**
 * Refuse production-derived / non-synthetic payloads before any write.
 * @param {object} payload
 */
export function assertSyntheticPayload(payload) {
  if (!payload || typeof payload !== 'object') {
    return { ok: false, code: 'EMPTY_PAYLOAD', reason: 'payload missing' }
  }
  if (payload.productionDerived === true) {
    return {
      ok: false,
      code: 'PRODUCTION_DERIVED',
      reason: 'productionDerived=true refused — synthetic only',
    }
  }
  if (payload.syntheticOnly === false) {
    return {
      ok: false,
      code: 'SYNTHETIC_ONLY_REQUIRED',
      reason: 'syntheticOnly must be true',
    }
  }
  const rows = [
    ...(payload.tasks ?? []),
    ...(payload.runs ?? []),
    ...(payload.accounts ?? []),
    ...(payload.decisions ?? []),
  ]
  for (const r of rows) {
    if (r && r.synthetic === false) {
      return {
        ok: false,
        code: 'NON_SYNTHETIC_ROW',
        reason: `row ${r.id ?? '?'} has synthetic=false`,
      }
    }
    // Secret-like fields forbidden
    const blob = JSON.stringify(r)
    if (/(password|secret|bearer|api[_-]?key|private_key)/i.test(blob)) {
      return {
        ok: false,
        code: 'SECRET_LIKE_FIELD',
        reason: `row ${r.id ?? '?'} contains secret-like field — refused`,
      }
    }
  }
  // Accounts must be masked only
  for (const a of payload.accounts ?? []) {
    if (a.email || a.token || a.password || a.rawAccountId) {
      return {
        ok: false,
        code: 'UNMASKED_ACCOUNT',
        reason: `account ${a.id} has unmasked identity fields`,
      }
    }
    if (!a.accountIdMasked && !a.maskedAccountId) {
      return {
        ok: false,
        code: 'MISSING_MASK',
        reason: `account ${a.id} missing accountIdMasked`,
      }
    }
  }
  return { ok: true, code: null, reason: null }
}

// ---------------------------------------------------------------------------
// Payload prepare (deterministic, pure)
// ---------------------------------------------------------------------------

/**
 * Map fixture run status → control_plane_runs.state.
 */
export function mapRunState(status) {
  const s = String(status ?? '').toLowerCase()
  if (s === 'done' || s === 'succeeded') return 'SUCCEEDED'
  if (s === 'stalled' || s === 'stale') return 'STALE'
  if (s === 'failed') return 'FAILED'
  if (s === 'cancelled') return 'CANCELLED'
  if (s === 'reserved') return 'RESERVED'
  if (s === 'queued') return 'QUEUED'
  return 'RUNNING'
}

/**
 * Prepare scale load payload from generator (or on-disk dir).
 * Forces **100 OPEN** decisions (AC-PERF open-decisions contract).
 * Deterministic IDs via generateScaleFixture.
 *
 * @param {{
 *   boardId?: string
 *   fixtureDir?: string
 *   nowIso?: string
 *   useOnDisk?: boolean
 *   counts?: Partial<typeof SCALE_COUNTS>
 * }} opts
 */
export function prepareScalePayload(opts = {}) {
  const boardId = String(opts.boardId ?? process.env.BOARD_ID ?? DEFAULT_SCALE_BOARD_ID).trim()
  const nowIso = opts.nowIso || '2026-07-14T00:00:00.000Z'
  const fixtureDir =
    opts.fixtureDir ||
    process.env.SCALE_FIXTURE_DIR?.trim() ||
    process.env.PERF_SCALE_FIXTURE_DIR?.trim() ||
    DEFAULT_FIXTURE_DIR

  let generated = generateScaleFixture({
    boardId,
    nowIso,
    counts: opts.counts,
  })

  // Optional: prefer on-disk counts verification but always re-bind boardId + OPEN decisions.
  if (opts.useOnDisk && fs.existsSync(path.join(fixtureDir, 'manifest.json'))) {
    const manifest = JSON.parse(
      fs.readFileSync(path.join(fixtureDir, 'manifest.json'), 'utf8'),
    )
    const readJsonl = (name) => {
      const p = path.join(fixtureDir, name)
      if (!fs.existsSync(p)) return []
      return fs
        .readFileSync(p, 'utf8')
        .split('\n')
        .map((l) => l.trim())
        .filter(Boolean)
        .map((l) => JSON.parse(l))
    }
    const diskTasks = readJsonl('tasks.jsonl')
    const diskRuns = readJsonl('runs.jsonl')
    const diskAccounts = readJsonl('accounts.jsonl')
    const diskDecisions = readJsonl('decisions.jsonl')
    if (
      diskTasks.length === SCALE_COUNTS.tasks &&
      diskRuns.length === SCALE_COUNTS.runs &&
      diskAccounts.length === SCALE_COUNTS.accounts &&
      diskDecisions.length === SCALE_COUNTS.decisions
    ) {
      generated = {
        manifest: { ...manifest, boardId, generatedAt: nowIso },
        tasks: diskTasks.map((t) => ({ ...t, boardId, synthetic: true })),
        runs: diskRuns.map((r) => ({ ...r, boardId, synthetic: true })),
        accounts: diskAccounts.map((a) => ({ ...a, boardId, synthetic: true })),
        decisions: diskDecisions.map((d) => ({ ...d, boardId, synthetic: true })),
        taskHash: generateScaleFixture({ boardId, nowIso }).taskHash,
      }
      // Recompute taskHash from actual task ids for determinism with disk
      const taskIds = generated.tasks.map((t) => t.id).sort()
      generated.taskHash = sha256Hex(taskIds.join('\n'))
      generated.manifest.pin = {
        ...(generated.manifest.pin || {}),
        canonicalSnapshotId: `scale-snap-${generated.taskHash.slice(0, 16)}`,
        canonicalHash: generated.taskHash,
        taskHash: generated.taskHash,
        boardRev: generated.manifest.pin?.boardRev ?? 1,
        lifecycleRev: generated.manifest.pin?.lifecycleRev ?? 1,
      }
    }
  }

  // Force OPEN decisions (product DecisionV3 status)
  const decisions = (generated.decisions ?? []).map((d) => ({
    ...d,
    boardId,
    status: 'OPEN',
    type: d.type || 'SCALE_PERF',
    severity: d.severity || 'MEDIUM',
    title: d.title || `SYNTH scale decision ${d.id}`,
    question: d.question || `SYNTH open decision ${d.id} — scale fixture only`,
    synthetic: true,
  }))

  const tasks = (generated.tasks ?? []).map((t) => ({
    ...t,
    boardId,
    synthetic: true,
  }))
  const runs = (generated.runs ?? []).map((r) => ({
    ...r,
    boardId,
    state: mapRunState(r.status),
    synthetic: true,
  }))
  const accounts = (generated.accounts ?? []).map((a) => ({
    ...a,
    boardId,
    accountIdMasked: a.accountIdMasked || a.maskedAccountId || `acct_****${a.id}`,
    accountRefMasked: a.accountRefMasked || `ref_****${a.id}`,
    maskedAccountId: a.accountIdMasked || a.maskedAccountId || `acct_****${a.id}`,
    synthetic: true,
  }))

  const openCount = decisions.filter((d) => d.status === 'OPEN').length
  const counts = {
    tasks: tasks.length,
    runs: runs.length,
    accounts: accounts.length,
    decisions: decisions.length,
    openDecisions: openCount,
  }

  const expected = {
    tasks: SCALE_COUNTS.tasks,
    runs: SCALE_COUNTS.runs,
    accounts: SCALE_COUNTS.accounts,
    decisions: SCALE_COUNTS.decisions,
    openDecisions: SCALE_COUNTS.decisions, // all open
  }

  const taskIds = tasks.map((t) => t.id).sort()
  const taskHash = sha256Hex(taskIds.join('\n'))
  const pin = {
    canonicalSnapshotId: `scale-snap-${taskHash.slice(0, 16)}`,
    canonicalHash: taskHash,
    taskHash,
    boardRev: 1,
    lifecycleRev: 1,
  }

  const payload = {
    schema: SCALE_LOADER_SCHEMA,
    syntheticOnly: true,
    productionDerived: false,
    boardId,
    generatedAt: nowIso,
    actor: SEED_ACTOR,
    counts,
    expected,
    pin,
    tasks,
    runs,
    accounts,
    decisions,
    taskHash,
    residualGaps: [
      'loader does not claim live p95 / 20rps proof by itself',
      'default path is dry-run/self-test; DB load requires CAIRN_SCALE_LOAD_APPROVED=1',
      'shared staging board/DB refused by design',
    ],
  }

  const synth = assertSyntheticPayload(payload)
  const countsOk =
    counts.tasks === expected.tasks &&
    counts.runs === expected.runs &&
    counts.accounts === expected.accounts &&
    counts.decisions === expected.decisions &&
    counts.openDecisions === expected.openDecisions

  return {
    ok: synth.ok && countsOk && boardId === payload.boardId && !FORBIDDEN_BOARD_IDS.has(boardId),
    payload,
    synth,
    countsOk,
    counts,
    expected,
    boardId,
    fixtureDir,
  }
}

// ---------------------------------------------------------------------------
// Schema + board-scoped load/cleanup (MySQL)
// ---------------------------------------------------------------------------

/** CREATE TABLE IF NOT EXISTS for scale entities. Never DROP DATABASE here. */
export async function ensureScaleTables(db) {
  await db.query(`CREATE TABLE IF NOT EXISTS boards (
    id VARCHAR(64) NOT NULL PRIMARY KEY,
    name VARCHAR(255) NOT NULL,
    description TEXT,
    views JSON NULL,
    created_at VARCHAR(32) NULL
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
    KEY idx_bp (board_id, project_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS board_docs (
    board_id VARCHAR(64) NOT NULL,
    kind VARCHAR(32) NOT NULL,
    data JSON NOT NULL,
    PRIMARY KEY (board_id, kind)
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
    KEY idx_board (board_id, id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

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
    KEY idx_runs_state (board_id, state),
    KEY idx_runs_task (board_id, task_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_account_snapshots (
    board_id VARCHAR(64) NOT NULL,
    source_revision BIGINT UNSIGNED NOT NULL,
    generated_at DATETIME(3) NOT NULL,
    generated_at_ms BIGINT NOT NULL,
    published_at_ms BIGINT NOT NULL,
    last_periodic_health_at_ms BIGINT NULL,
    stale TINYINT(1) NOT NULL DEFAULT 0,
    stale_reason VARCHAR(160) NULL,
    usable_capacity INT NOT NULL DEFAULT 0,
    entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    subject_hash CHAR(64) NULL,
    accounts_json JSON NOT NULL,
    capacity_json JSON NULL,
    readback_surfaces_json JSON NULL,
    record_json JSON NULL,
    created_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3),
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

  await db.query(`CREATE TABLE IF NOT EXISTS control_plane_decisions (
    board_id VARCHAR(64) NOT NULL,
    decision_id VARCHAR(64) NOT NULL,
    project_id VARCHAR(64) NULL,
    feature_id VARCHAR(160) NULL,
    task_id VARCHAR(160) NULL,
    run_id VARCHAR(160) NULL,
    type VARCHAR(64) NOT NULL,
    severity VARCHAR(16) NOT NULL,
    title VARCHAR(400) NOT NULL,
    question TEXT NOT NULL,
    evidence_json JSON NULL,
    options_json JSON NOT NULL,
    agent_recommendation TEXT NULL,
    blocking TINYINT(1) NOT NULL DEFAULT 0,
    due_at DATETIME(3) NULL,
    due_at_ms BIGINT NULL,
    created_at DATETIME(3) NOT NULL,
    created_at_ms BIGINT NOT NULL,
    snoozed_until DATETIME(3) NULL,
    snoozed_until_ms BIGINT NULL,
    status VARCHAR(32) NOT NULL,
    owner_id VARCHAR(160) NULL,
    resolver_id VARCHAR(160) NULL,
    selected_option_id VARCHAR(64) NULL,
    comment TEXT NULL,
    expected_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
    board_rev BIGINT UNSIGNED NOT NULL DEFAULT 0,
    entity_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
    scoped_approval_id VARCHAR(64) NULL,
    audit_ids_json JSON NULL,
    expires_at DATETIME(3) NULL,
    expires_at_ms BIGINT NULL,
    record_json JSON NULL,
    updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
    PRIMARY KEY (board_id, decision_id),
    KEY idx_decisions_status (board_id, status)
  ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)
}

/**
 * Delete only board-scoped scale rows. Never DROP DATABASE. Never touch other boards.
 */
export async function cleanupBoardScopedScale(db, boardId) {
  if (FORBIDDEN_BOARD_IDS.has(boardId)) {
    throw new Error(`cleanup refused forbidden boardId ${boardId}`)
  }
  await db.query('DELETE FROM control_plane_decisions WHERE board_id=?', [boardId])
  await db.query('DELETE FROM control_plane_account_snapshots WHERE board_id=?', [boardId])
  await db.query('DELETE FROM control_plane_runs WHERE board_id=?', [boardId])
  await db.query('DELETE FROM board_revisions WHERE board_id=?', [boardId])
  await db.query('DELETE FROM audit_log WHERE board_id=?', [boardId])
  await db.query('DELETE FROM board_docs WHERE board_id=?', [boardId])
  await db.query('DELETE FROM tasks WHERE board_id=?', [boardId])
  await db.query('DELETE FROM boards WHERE id=?', [boardId])
  return { ok: true, boardId, action: 'cleanup' }
}

/**
 * Idempotent board-scoped replace of scale fixture.
 */
export async function loadBoardScopedScale(db, payload) {
  const synth = assertSyntheticPayload(payload)
  if (!synth.ok) {
    throw new Error(`load refused: ${synth.code} ${synth.reason}`)
  }
  const boardId = payload.boardId
  if (FORBIDDEN_BOARD_IDS.has(boardId)) {
    throw new Error(`load refused forbidden boardId ${boardId}`)
  }

  await ensureScaleTables(db)
  await cleanupBoardScopedScale(db, boardId)

  const now = payload.generatedAt || new Date().toISOString()
  const nowMs = Date.parse(now) || Date.now()
  const pin = payload.pin

  await db.query(
    'INSERT INTO boards (id, name, description, views, created_at) VALUES (?,?,?,?,?)',
    [
      boardId,
      `Scale board ${boardId} (SYNTH)`,
      'Disposable AC-PERF-01 scale fixture — synthetic only',
      JSON.stringify([{ id: 'work', label: 'Work' }]),
      now.slice(0, 10),
    ],
  )

  // Batch insert tasks
  for (const t of payload.tasks) {
    const summary = {
      bucket: t.bucket ?? null,
      readinessPercent: t.readinessPercent ?? null,
      synthetic: true,
    }
    const data = {
      bucket: t.bucket ?? null,
      readinessPercent: t.readinessPercent ?? null,
      synthetic: true,
      scaleFixture: true,
    }
    await db.query(
      `INSERT INTO tasks (
         board_id, id, title, updated, summary, data, rev, lifecycle_stage
       ) VALUES (?,?,?,?,?,?,0,?)`,
      [
        boardId,
        t.id,
        t.title,
        now,
        JSON.stringify(summary),
        JSON.stringify(data),
        t.bucket === 'DONE' ? 'PROD_READY' : null,
      ],
    )
  }

  // Runs
  for (const r of payload.runs) {
    const state = r.state || mapRunState(r.status)
    await db.query(
      `INSERT INTO control_plane_runs (
         board_id, run_id, state, task_id, target_gate, role, agent_id, model,
         effort, masked_account_ref, board_rev, entity_rev, stalled, record_json,
         registered_at_ms, heartbeat_at_ms
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        boardId,
        r.id,
        state,
        r.taskId,
        'SCALE_PERF',
        'IMPLEMENTER',
        r.agentId,
        'synth-scale-model',
        '',
        null,
        pin.boardRev,
        1,
        state === 'STALE' ? 1 : 0,
        JSON.stringify({ synthetic: true, scaleFixture: true, status: r.status }),
        nowMs,
        nowMs,
      ],
    )
  }

  // Accounts snapshot (masked only, one board row)
  const accountsJson = payload.accounts.map((a) => ({
    maskedAccountId: a.accountIdMasked || a.maskedAccountId,
    accountRefMasked: a.accountRefMasked,
    status: a.status || 'ACTIVE',
    synthetic: true,
  }))
  await db.query(
    `INSERT INTO control_plane_account_snapshots (
       board_id, source_revision, generated_at, generated_at_ms, published_at_ms,
       stale, usable_capacity, entity_rev, accounts_json, capacity_json, record_json
     ) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      boardId,
      1,
      now.slice(0, 23).replace('T', ' '),
      nowMs,
      nowMs,
      0,
      accountsJson.filter((a) => a.status === 'ACTIVE').length,
      1,
      JSON.stringify(accountsJson),
      JSON.stringify({ usable: accountsJson.length, synthetic: true }),
      JSON.stringify({ synthetic: true, scaleFixture: true, accountCount: accountsJson.length }),
    ],
  )

  // Decisions — all OPEN
  for (const d of payload.decisions) {
    await db.query(
      `INSERT INTO control_plane_decisions (
         board_id, decision_id, type, severity, title, question,
         options_json, blocking, created_at, created_at_ms, status,
         board_rev, entity_rev, record_json
       ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
      [
        boardId,
        d.id,
        d.type || 'SCALE_PERF',
        d.severity || 'MEDIUM',
        d.title,
        d.question,
        JSON.stringify([
          { id: 'opt-a', label: 'SYNTH option A' },
          { id: 'opt-b', label: 'SYNTH option B' },
        ]),
        0,
        now.slice(0, 23).replace('T', ' '),
        nowMs,
        'OPEN',
        pin.boardRev,
        1,
        JSON.stringify({ synthetic: true, scaleFixture: true }),
      ],
    )
  }

  await db.query(
    `INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id)
     VALUES (?,?,?,?,?)`,
    [boardId, pin.boardRev, pin.lifecycleRev, pin.taskHash, pin.canonicalSnapshotId],
  )

  await db.query(
    'INSERT INTO board_docs (board_id, kind, data) VALUES (?,?,?)',
    [
      boardId,
      'scale_manifest',
      JSON.stringify({
        schema: SCALE_LOADER_SCHEMA,
        syntheticOnly: true,
        counts: payload.counts,
        pin,
        actor: payload.actor,
      }),
    ],
  )

  await db.query(
    `INSERT INTO audit_log (board_id, ts, actor, action, task_id, detail) VALUES (?,?,?,?,?,?)`,
    [
      boardId,
      now,
      SEED_ACTOR,
      'scale_fixture_loaded',
      null,
      JSON.stringify({
        synthetic: true,
        counts: payload.counts,
        taskHash: pin.taskHash,
        boardRev: pin.boardRev,
      }),
    ],
  )

  return readbackScaleProof(db, boardId)
}

/** Programmatic readback: counts + open decisions + taskHash. No secrets. */
export async function readbackScaleProof(db, boardId) {
  const [tc] = await db.query('SELECT COUNT(*) AS n FROM tasks WHERE board_id=?', [boardId])
  const [rc] = await db.query(
    'SELECT COUNT(*) AS n FROM control_plane_runs WHERE board_id=?',
    [boardId],
  )
  const [ac] = await db.query(
    'SELECT accounts_json FROM control_plane_account_snapshots WHERE board_id=?',
    [boardId],
  )
  let accountCount = 0
  if (ac?.[0]?.accounts_json) {
    const raw = ac[0].accounts_json
    const arr = typeof raw === 'string' ? JSON.parse(raw) : raw
    accountCount = Array.isArray(arr) ? arr.length : 0
  }
  const [dc] = await db.query(
    'SELECT COUNT(*) AS n FROM control_plane_decisions WHERE board_id=?',
    [boardId],
  )
  const [openDc] = await db.query(
    `SELECT COUNT(*) AS n FROM control_plane_decisions WHERE board_id=? AND status='OPEN'`,
    [boardId],
  )
  const [taskIdRows] = await db.query(
    'SELECT id FROM tasks WHERE board_id=? ORDER BY id',
    [boardId],
  )
  const taskIds = (taskIdRows ?? []).map((r) => r.id)
  const taskHash = sha256Hex(taskIds.join('\n'))
  const [rev] = await db.query(
    'SELECT board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id FROM board_revisions WHERE board_id=?',
    [boardId],
  )

  const counts = {
    tasks: Number(tc[0]?.n ?? 0),
    runs: Number(rc[0]?.n ?? 0),
    accounts: accountCount,
    decisions: Number(dc[0]?.n ?? 0),
    openDecisions: Number(openDc[0]?.n ?? 0),
  }

  const matches =
    counts.tasks === SCALE_COUNTS.tasks &&
    counts.runs === SCALE_COUNTS.runs &&
    counts.accounts === SCALE_COUNTS.accounts &&
    counts.decisions === SCALE_COUNTS.decisions &&
    counts.openDecisions === SCALE_COUNTS.decisions

  return {
    ok: matches,
    boardId,
    counts,
    expected: {
      ...SCALE_COUNTS,
      openDecisions: SCALE_COUNTS.decisions,
    },
    taskHash,
    pin: rev?.[0]
      ? {
          boardRev: Number(rev[0].board_rev),
          lifecycleRev: Number(rev[0].lifecycle_rev),
          subjectHash: rev[0].subject_hash,
          canonicalSnapshotId: rev[0].canonical_snapshot_id,
        }
      : null,
  }
}

// ---------------------------------------------------------------------------
// High-level operations
// ---------------------------------------------------------------------------

export function dryRunScaleLoad(opts = {}) {
  const prepared = prepareScalePayload(opts)
  const gate = assertScaleLoadAllowed({
    approved: false, // dry never needs approval; report what gate would require
    boardId: prepared.boardId,
    ...opts.gate,
  })
  return {
    mode: 'dry-run',
    schema: SCALE_LOADER_SCHEMA,
    ok: prepared.ok,
    wouldMutate: false,
    prepared: {
      ok: prepared.ok,
      boardId: prepared.boardId,
      counts: prepared.counts,
      expected: prepared.expected,
      countsOk: prepared.countsOk,
      synthOk: prepared.synth.ok,
      taskHash: prepared.payload.taskHash,
      pin: prepared.payload.pin,
      residualGaps: prepared.payload.residualGaps,
    },
    loadGateWithoutApproval: gate,
    note: 'No DB connection opened. Pass CAIRN_SCALE_LOAD_APPROVED=1 + --load/--disposable-proof for real isolated load.',
  }
}

/**
 * Load into a fresh isolated DB. Always creates iso DB; never shared staging.
 */
export async function loadScaleIsolated(opts = {}) {
  const gate = assertScaleLoadAllowed({
    approved: opts.approved ?? process.env.CAIRN_SCALE_LOAD_APPROVED,
    boardId: opts.boardId ?? process.env.BOARD_ID ?? DEFAULT_SCALE_BOARD_ID,
    dbName: opts.dbName,
    host: opts.host,
    allowLocalHost: opts.allowLocalHost,
  })
  if (!gate.ok) {
    return {
      mode: 'load',
      ok: false,
      refused: true,
      gate,
    }
  }

  const prepared = prepareScalePayload({
    boardId: gate.boardId,
    nowIso: opts.nowIso,
    useOnDisk: opts.useOnDisk,
    counts: opts.counts,
  })
  if (!prepared.ok) {
    return {
      mode: 'load',
      ok: false,
      refused: false,
      prepared,
      error: 'prepareScalePayload failed counts or synthetic gate',
    }
  }

  const dbName =
    opts.dbName ||
    process.env.CAIRN_ISO_DB_NAME?.trim() ||
    makeIsolatedDbName('scale')
  assertSafeIsoDbName(dbName)
  if (FORBIDDEN_DB_NAMES.has(dbName)) {
    return {
      mode: 'load',
      ok: false,
      refused: true,
      gate: { ok: false, code: 'SHARED_OR_FORBIDDEN_DB', reason: `db ${dbName} forbidden` },
    }
  }

  await recreateIsolatedDatabase(dbName)

  let first
  let second
  await withDbConnection(dbName, async (db) => {
    first = await loadBoardScopedScale(db, prepared.payload)
    // Idempotent second load
    second = await loadBoardScopedScale(db, prepared.payload)
  })

  const idempotent =
    first.ok &&
    second.ok &&
    first.counts.tasks === second.counts.tasks &&
    first.taskHash === second.taskHash &&
    first.counts.openDecisions === second.counts.openDecisions

  return {
    mode: 'load',
    ok: Boolean(first?.ok && idempotent),
    refused: false,
    gate,
    dbName,
    boardId: gate.boardId,
    first,
    second,
    idempotent,
    syntheticOnly: true,
    productionDerived: false,
  }
}

/**
 * Cleanup board-scoped rows on an existing iso DB, or drop the iso DB entirely.
 */
export async function cleanupScaleIsolated(opts = {}) {
  const gate = assertScaleLoadAllowed({
    approved: opts.approved ?? process.env.CAIRN_SCALE_LOAD_APPROVED,
    boardId: opts.boardId ?? process.env.BOARD_ID ?? DEFAULT_SCALE_BOARD_ID,
    dbName: opts.dbName ?? process.env.CAIRN_ISO_DB_NAME,
    host: opts.host,
    allowLocalHost: opts.allowLocalHost,
  })
  if (!gate.ok) {
    return { mode: 'cleanup', ok: false, refused: true, gate }
  }

  const dbName = opts.dbName || process.env.CAIRN_ISO_DB_NAME?.trim()
  if (!dbName) {
    return {
      mode: 'cleanup',
      ok: false,
      refused: false,
      error: 'CAIRN_ISO_DB_NAME or opts.dbName required for cleanup',
    }
  }
  assertSafeIsoDbName(dbName)
  if (FORBIDDEN_DB_NAMES.has(dbName)) {
    return {
      mode: 'cleanup',
      ok: false,
      refused: true,
      gate: { ok: false, code: 'SHARED_OR_FORBIDDEN_DB', reason: `db ${dbName} forbidden` },
    }
  }

  const exists = await databaseExists(dbName)
  if (!exists) {
    return { mode: 'cleanup', ok: true, dbName, alreadyGone: true }
  }

  if (opts.dropDatabase === true) {
    const drop = await dropIsolatedDatabase(dbName)
    return {
      mode: 'cleanup',
      ok: drop.dropped,
      dbName,
      drop,
      boardId: gate.boardId,
    }
  }

  let readback
  await withDbConnection(dbName, async (db) => {
    await cleanupBoardScopedScale(db, gate.boardId)
    readback = await readbackScaleProof(db, gate.boardId)
  })

  const empty =
    readback.counts.tasks === 0 &&
    readback.counts.runs === 0 &&
    readback.counts.decisions === 0

  return {
    mode: 'cleanup',
    ok: empty,
    dbName,
    boardId: gate.boardId,
    readback,
    empty,
  }
}

/**
 * Full disposable proof: iso load → idempotent → cleanup → drop DB.
 * Ambient DBs untouched.
 * Same gates as --load: CAIRN_SCALE_LOAD_APPROVED=1 + explicit
 * CAIRN_SCALE_LOAD_ALLOW_LOCAL=1 (or opts.allowLocalHost) for loopback — no auto-bypass.
 */
export async function runDisposableScaleProof(opts = {}) {
  const allowLocal =
    opts.allowLocalHost === true || envTruthy('CAIRN_SCALE_LOAD_ALLOW_LOCAL')
  const loadResult = await loadScaleIsolated({
    ...opts,
    allowLocalHost: allowLocal,
  })
  if (!loadResult.ok) {
    return {
      mode: 'disposable-proof',
      ok: false,
      load: loadResult,
    }
  }

  const cleanup = await cleanupScaleIsolated({
    ...opts,
    dbName: loadResult.dbName,
    boardId: loadResult.boardId,
    allowLocalHost: allowLocal,
    dropDatabase: true,
  })

  const gone = !(await databaseExists(loadResult.dbName))

  return {
    mode: 'disposable-proof',
    ok: Boolean(loadResult.ok && cleanup.ok && gone),
    load: loadResult,
    cleanup,
    dbDropped: gone,
    syntheticOnly: true,
    residualGaps: [
      'does not claim live p95 / 20rps / shared staging load',
    ],
  }
}

// ---------------------------------------------------------------------------
// Self-test (pure — no MySQL)
// ---------------------------------------------------------------------------

export function runScaleLoaderSelfTests() {
  const results = []
  const check = (name, pass, detail = null) => {
    results.push({ name, pass: Boolean(pass), detail })
  }

  // 1) prepare counts + open decisions
  const prep = prepareScalePayload({ boardId: DEFAULT_SCALE_BOARD_ID })
  check('prepare.ok', prep.ok)
  check('prepare.tasks.1000', prep.counts.tasks === 1000, prep.counts)
  check('prepare.runs.200', prep.counts.runs === 200, prep.counts)
  check('prepare.accounts.20', prep.counts.accounts === 20, prep.counts)
  check('prepare.decisions.100', prep.counts.decisions === 100, prep.counts)
  check(
    'prepare.openDecisions.100',
    prep.counts.openDecisions === 100,
    prep.counts,
  )
  check('prepare.syntheticOnly', prep.payload.syntheticOnly === true)
  check('prepare.productionDerived.false', prep.payload.productionDerived === false)
  check('prepare.board.isolated', prep.boardId === DEFAULT_SCALE_BOARD_ID)

  // 2) deterministic IDs
  const prep2 = prepareScalePayload({ boardId: DEFAULT_SCALE_BOARD_ID })
  check(
    'prepare.deterministic.taskHash',
    prep.payload.taskHash === prep2.payload.taskHash,
    { a: prep.payload.taskHash, b: prep2.payload.taskHash },
  )
  check(
    'prepare.deterministic.firstTask',
    prep.payload.tasks[0]?.id === 'scale-task-0001',
  )
  check(
    'prepare.deterministic.firstRun',
    prep.payload.runs[0]?.id === 'scale-run-0001',
  )

  // 3) synthetic gate
  const bad = assertSyntheticPayload({
    syntheticOnly: true,
    productionDerived: false,
    accounts: [{ id: 'x', email: 'a@b.com', accountIdMasked: 'm' }],
    tasks: [],
    runs: [],
    decisions: [],
  })
  check('synth.refuse.unmasked', bad.ok === false && bad.code === 'UNMASKED_ACCOUNT')

  const prod = assertSyntheticPayload({
    syntheticOnly: false,
    productionDerived: true,
    tasks: [],
    runs: [],
    accounts: [],
    decisions: [],
  })
  check(
    'synth.refuse.productionDerived',
    prod.ok === false && prod.code === 'PRODUCTION_DERIVED',
  )

  // 4) approval gate
  const unapproved = assertScaleLoadAllowed({
    approved: false,
    boardId: DEFAULT_SCALE_BOARD_ID,
    host: '127.0.0.1',
    allowLocalHost: true,
  })
  check(
    'gate.refuse.unapproved',
    unapproved.ok === false && unapproved.code === 'APPROVAL_REQUIRED',
  )

  const sharedBoard = assertScaleLoadAllowed({
    approved: '1',
    boardId: SHARED_STAGING_BOARD_ID,
    host: '127.0.0.1',
    allowLocalHost: true,
  })
  check(
    'gate.refuse.sharedBoard',
    sharedBoard.ok === false && sharedBoard.code === 'SHARED_OR_FORBIDDEN_BOARD',
  )

  const sharedDb = assertScaleLoadAllowed({
    approved: '1',
    boardId: DEFAULT_SCALE_BOARD_ID,
    dbName: SHARED_STAGING_DB_NAME,
    host: '127.0.0.1',
    allowLocalHost: true,
  })
  check(
    'gate.refuse.sharedDb',
    sharedDb.ok === false && sharedDb.code === 'SHARED_OR_FORBIDDEN_DB',
  )

  const prodHost = assertScaleLoadAllowed({
    approved: '1',
    boardId: DEFAULT_SCALE_BOARD_ID,
    host: 'db.production.mfsdev.net',
    allowLocalHost: true,
  })
  check(
    'gate.refuse.prodHost',
    prodHost.ok === false && prodHost.code === 'PRODUCTION_HOST',
  )

  const stagingHost = assertScaleLoadAllowed({
    approved: '1',
    boardId: DEFAULT_SCALE_BOARD_ID,
    host: 'cairn-tm-v3-mysql',
  })
  check(
    'gate.refuse.sharedStagingHost',
    stagingHost.ok === false && stagingHost.code === 'SHARED_STAGING_HOST',
  )

  const localNoAllow = assertScaleLoadAllowed({
    approved: '1',
    boardId: DEFAULT_SCALE_BOARD_ID,
    host: '127.0.0.1',
    allowLocalHost: false,
    dbName: 'cairn_tm_synth_scale_selftest',
  })
  check(
    'gate.refuse.localWithoutAllow',
    localNoAllow.ok === false && localNoAllow.code === 'LOCAL_HOST_NOT_ALLOWED',
    localNoAllow,
  )

  const localOk = assertScaleLoadAllowed({
    approved: '1',
    boardId: DEFAULT_SCALE_BOARD_ID,
    host: '127.0.0.1',
    allowLocalHost: true,
    dbName: 'cairn_tm_synth_scale_selftest',
  })
  check('gate.allow.localDisposable', localOk.ok === true, localOk)

  // 5) mapRunState
  check('mapRun.done', mapRunState('done') === 'SUCCEEDED')
  check('mapRun.stalled', mapRunState('stalled') === 'STALE')
  check('mapRun.running', mapRunState('running') === 'RUNNING')

  // 6) dry-run default does not mutate
  const dry = dryRunScaleLoad({ boardId: DEFAULT_SCALE_BOARD_ID })
  check('dry.ok', dry.ok)
  check('dry.wouldMutate.false', dry.wouldMutate === false)
  check('dry.counts.tasks', dry.prepared.counts.tasks === 1000)

  // 7) accounts masked
  const masked = prep.payload.accounts.every(
    (a) =>
      a.accountIdMasked &&
      a.accountIdMasked.includes('****') &&
      !a.email &&
      !a.token,
  )
  check('accounts.masked', masked)

  // 8) decisions all OPEN
  check(
    'decisions.allOpen',
    prep.payload.decisions.every((d) => d.status === 'OPEN'),
  )

  // 9) SCALE_COUNTS export stable
  check(
    'SCALE_COUNTS',
    SCALE_COUNTS.tasks === 1000 &&
      SCALE_COUNTS.runs === 200 &&
      SCALE_COUNTS.accounts === 20 &&
      SCALE_COUNTS.decisions === 100,
  )

  // 10) writeScaleFixture round-trip optional in tmp is out of pure self-test —
  //     just ensure import is callable
  check('writeScaleFixture.fn', typeof writeScaleFixture === 'function')
  check('generateScaleFixture.fn', typeof generateScaleFixture === 'function')

  const failCount = results.filter((r) => !r.pass).length
  return {
    mode: 'self-test',
    ok: failCount === 0,
    failCount,
    passCount: results.length - failCount,
    results,
    schema: SCALE_LOADER_SCHEMA,
  }
}

// ---------------------------------------------------------------------------
// main
// ---------------------------------------------------------------------------

async function main() {
  if (argFlag('--self-test')) {
    const r = runScaleLoaderSelfTests()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--disposable-proof')) {
    const r = await runDisposableScaleProof({
      boardId: argValue('--board') || process.env.BOARD_ID || DEFAULT_SCALE_BOARD_ID,
      useOnDisk: argFlag('--use-disk'),
      allowLocalHost: envTruthy('CAIRN_SCALE_LOAD_ALLOW_LOCAL'),
    })
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--load')) {
    const r = await loadScaleIsolated({
      boardId: argValue('--board') || process.env.BOARD_ID || DEFAULT_SCALE_BOARD_ID,
      useOnDisk: argFlag('--use-disk'),
      allowLocalHost: envTruthy('CAIRN_SCALE_LOAD_ALLOW_LOCAL'),
    })
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  if (argFlag('--cleanup')) {
    const r = await cleanupScaleIsolated({
      boardId: argValue('--board') || process.env.BOARD_ID || DEFAULT_SCALE_BOARD_ID,
      dbName: argValue('--db') || process.env.CAIRN_ISO_DB_NAME,
      dropDatabase: argFlag('--drop-db'),
      allowLocalHost: envTruthy('CAIRN_SCALE_LOAD_ALLOW_LOCAL'),
    })
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }

  // Default: dry-run (no DB)
  const r = dryRunScaleLoad({
    boardId: argValue('--board') || process.env.BOARD_ID || DEFAULT_SCALE_BOARD_ID,
    useOnDisk: argFlag('--use-disk'),
  })
  console.log(JSON.stringify(r, null, 2))
  process.exit(r.ok ? 0 : 1)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))
if (isMain) {
  main().catch((err) => {
    console.error(
      JSON.stringify(
        {
          ok: false,
          error: String(err?.message || err),
          stack: err?.stack?.split('\n').slice(0, 6),
        },
        null,
        2,
      ),
    )
    process.exit(2)
  })
}
