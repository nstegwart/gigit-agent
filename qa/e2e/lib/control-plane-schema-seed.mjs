#!/usr/bin/env node
/**
 * FP-C — Control-plane schema + seed for disposable local/isolated E2E only.
 *
 * - Applies product migrations 001,002,004,005 (plus 000/003/006 chain when needed)
 *   onto a SAFE iso DB only (cairn_tm_e2e_* / c3_ / iso_ / synth_).
 * - Seeds ≥1 control_plane_runs row + masked control_plane_account_snapshots via
 *   fixture-shaped product table contracts (same columns as runtime persistence /
 *   account-sync stores). Not ambient/staging/prod mutation.
 * - Idempotent: re-apply skips recorded schema_migrations; seed uses ODKU on PK.
 *
 * Never modifies production migration files or board-mcp.
 *
 * Usage:
 *   node qa/e2e/lib/control-plane-schema-seed.mjs --self-test
 *   node qa/e2e/lib/control-plane-schema-seed.mjs --disposable-proof
 *   # or import ensureFpCControlPlaneOnIsoDb from prepareIsolatedAuthFixture
 */
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import mysql from 'mysql2/promise'

import {
  assertSafeIsoDbName,
  dropIsolatedDatabase,
  makeIsolatedDbName,
  readEnvFileKey,
  resolveMysqlConfig,
  withDbConnection,
  withRootConnection,
} from './db-iso.mjs'
import { buildAccountSyncSeed, DEFAULT_BOARD_ID } from '../fixtures/seed/control-center-fixture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(__dirname, '../../..')
const MIGRATIONS_DIR = path.join(REPO_ROOT, 'migrations')

/** FP-C required set (investigation P2 / frontier packet). */
export const FP_C_REQUIRED_VERSIONS = Object.freeze(['001', '002', '004', '005'])

/**
 * Full greenfield chain (empty disposable DB). Includes 000 baseline + 003 backfill.
 */
export const FP_C_GREENFIELD_CHAIN_VERSIONS = Object.freeze([
  '000',
  '001',
  '002',
  '003',
  '004',
  '005',
  '006',
])

/**
 * Post-clone iso chain (ambient boards/tasks already present).
 * Skips 000 (baseline already cloned) and 003 (JOIN boards↔board_revisions can
 * hit utf8mb4_unicode_ci vs utf8mb4_0900_ai_ci collation mix on real ambient clones).
 * Required 001+002+004+005 + current tip 006.
 */
export const FP_C_CLONE_CHAIN_VERSIONS = Object.freeze([
  '001',
  '002',
  '004',
  '005',
  '006',
])

/** @deprecated use FP_C_CLONE_CHAIN_VERSIONS or FP_C_GREENFIELD_CHAIN_VERSIONS */
export const FP_C_CHAIN_VERSIONS = FP_C_CLONE_CHAIN_VERSIONS

const MIGRATION_FILES = Object.freeze({
  '000': '000_baseline_core.sql',
  '001': '001_control_plane_expand.sql',
  '002': '002_control_plane_indexes.sql',
  '003': '003_control_plane_backfill.sql',
  '004': '004_control_data_persistence.sql',
  '005': '005_control_plane_runtime_persistence.sql',
  '006': '006_stage_evidence_receipts.sql',
})

const MIGRATION_CLASS = Object.freeze({
  '000': 'REVERSIBLE',
  '001': 'REVERSIBLE',
  '002': 'EXPAND_CONTRACT_BACKWARD_COMPATIBLE',
  '003': 'FORWARD_FIX_ONLY',
  '004': 'REVERSIBLE',
  '005': 'REVERSIBLE',
  '006': 'REVERSIBLE',
})

const FIXTURE_RUN_ID = 'run_fp_c_e2e_seed_001'
const FIXTURE_AGENT_ID = 'agent_fp_c_e2e_seed'
const APPLIED_BY = 'fp-c-e2e-fixture'

export class ControlPlaneSchemaSeedError extends Error {
  constructor(message, detail = {}) {
    super(message)
    this.name = 'ControlPlaneSchemaSeedError'
    this.detail = detail
    this.code = detail.code ?? 'FP_C_SCHEMA_SEED_FAIL'
  }
}

/** Match product migrations.ts splitSqlStatements. */
export function splitSqlStatements(sql) {
  const withoutBlock = sql.replace(/\/\*[\s\S]*?\*\//g, '')
  const lines = withoutBlock.split('\n').filter((line) => {
    const t = line.trim()
    return t.length > 0 && !t.startsWith('--')
  })
  const joined = lines.join('\n')
  return joined
    .split(';')
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
}

export function sha256Hex(content) {
  return createHash('sha256').update(content).digest('hex')
}

export function loadMigrationFile(version) {
  const filename = MIGRATION_FILES[version]
  if (!filename) {
    throw new ControlPlaneSchemaSeedError(`Unknown migration version ${version}`, {
      code: 'UNKNOWN_MIGRATION',
      version,
    })
  }
  const abs = path.join(MIGRATIONS_DIR, filename)
  if (!fs.existsSync(abs)) {
    throw new ControlPlaneSchemaSeedError(`Migration file missing: ${filename}`, {
      code: 'MIGRATION_FILE_MISSING',
      filename,
    })
  }
  const sql = fs.readFileSync(abs, 'utf8')
  return {
    version,
    filename,
    relativePath: path.join('migrations', filename),
    classification: MIGRATION_CLASS[version] ?? 'REVERSIBLE',
    sha256: sha256Hex(sql),
    statements: splitSqlStatements(sql),
    abs,
  }
}

function isDuplicateExpandError(err) {
  const errno = err?.errno
  // 1060 duplicate column, 1061 duplicate key name, 1062 duplicate entry (rare on IF NOT EXISTS)
  // 1050 table already exists
  return errno === 1060 || errno === 1061 || errno === 1062 || errno === 1050
}

/**
 * Fail-closed: only disposable iso names. Never ambient/staging/prod names.
 */
export function assertFpCTargetDb(dbName) {
  const n = String(dbName ?? '')
    .trim()
    .toLowerCase()
  const forbidden = new Set([
    'cairn_taskmanager',
    'cairn_tm_v3_staging',
    'cairn_tm_v3_production',
    'mysql',
    'information_schema',
    'performance_schema',
    'sys',
  ])
  if (!n || forbidden.has(n) || /prod|production|staging/i.test(n)) {
    throw new ControlPlaneSchemaSeedError(
      `FAIL-CLOSED FP-C: refusing non-disposable DB name "${dbName}"`,
      { code: 'REFUSE_NON_ISO_DB', dbName },
    )
  }
  try {
    assertSafeIsoDbName(dbName)
  } catch (e) {
    throw new ControlPlaneSchemaSeedError(
      `FAIL-CLOSED FP-C: unsafe iso DB name "${dbName}": ${e?.message || e}`,
      { code: 'REFUSE_NON_ISO_DB', dbName },
    )
  }
  return dbName
}

async function listAppliedVersions(conn) {
  try {
    const [rows] = await conn.query(
      `SELECT version FROM schema_migrations WHERE dry_run = 0 ORDER BY version ASC`,
    )
    return (Array.isArray(rows) ? rows : []).map((r) => String(r.version))
  } catch (e) {
    if (e?.errno === 1146 || e?.code === 'ER_NO_SUCH_TABLE') return []
    throw e
  }
}

async function recordApplied(conn, m) {
  await conn.query(
    `INSERT INTO schema_migrations
       (version, filename, sha256, classification, applied_by, dry_run)
     VALUES (?, ?, ?, ?, ?, 0)
     ON DUPLICATE KEY UPDATE
       filename = VALUES(filename),
       sha256 = VALUES(sha256),
       classification = VALUES(classification),
       applied_by = VALUES(applied_by),
       dry_run = 0,
       applied_at = CURRENT_TIMESTAMP(3)`,
    [m.version, m.filename, m.sha256, m.classification, APPLIED_BY],
  )
}

/**
 * Apply FP-C migration chain to disposable iso DB. Idempotent via schema_migrations.
 * @returns {{ ok: true, dbName, applied: string[], skipped: string[], requiredPresent: boolean }}
 */
export async function applyControlPlaneSchemaToIsoDb(dbName, opts = {}) {
  assertFpCTargetDb(dbName)
  const versions = opts.versions ?? [...FP_C_CLONE_CHAIN_VERSIONS]
  const applied = []
  const skipped = []
  const errors = []

  await withDbConnection(dbName, async (conn) => {
    // Strip NO_ZERO_DATE for 003 backfill (product executor does the same).
    try {
      await conn.query(
        `SET SESSION sql_mode = TRIM(BOTH ',' FROM REPLACE(REPLACE(
           CONCAT(',', REPLACE(@@SESSION.sql_mode, ' ', ''), ','),
           ',NO_ZERO_IN_DATE,', ','),
           ',NO_ZERO_DATE,', ','))`,
      )
    } catch {
      /* best-effort */
    }

    let already = await listAppliedVersions(conn)

    for (const version of versions) {
      if (already.includes(version)) {
        skipped.push(version)
        continue
      }
      const m = loadMigrationFile(version)
      for (const stmt of m.statements) {
        try {
          await conn.query(stmt)
        } catch (e) {
          if (isDuplicateExpandError(e)) continue
          const msg = `Failed ${m.filename}: ${e?.message || e}`
          errors.push(msg)
          throw new ControlPlaneSchemaSeedError(msg, {
            code: 'MIGRATION_SQL_FAIL',
            version,
            filename: m.filename,
            errno: e?.errno,
          })
        }
      }
      // schema_migrations table exists after 000/001
      await recordApplied(conn, m)
      applied.push(version)
      already = await listAppliedVersions(conn)
    }
  })

  const finalApplied = await withDbConnection(dbName, (c) => listAppliedVersions(c))
  const requiredPresent = FP_C_REQUIRED_VERSIONS.every((v) => finalApplied.includes(v))
  if (!requiredPresent) {
    throw new ControlPlaneSchemaSeedError(
      `FP-C required migrations missing after apply: need ${FP_C_REQUIRED_VERSIONS.join(',')} have ${finalApplied.join(',')}`,
      { code: 'REQUIRED_MIGRATIONS_MISSING', finalApplied },
    )
  }

  // Presence probe for critical tables
  await withDbConnection(dbName, async (conn) => {
    for (const table of [
      'board_revisions',
      'control_plane_runs',
      'control_plane_account_snapshots',
    ]) {
      const [rows] = await conn.query(
        `SELECT 1 AS ok FROM information_schema.TABLES
         WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = ? LIMIT 1`,
        [table],
      )
      if (!Array.isArray(rows) || rows.length === 0) {
        throw new ControlPlaneSchemaSeedError(`Expected table missing after migrate: ${table}`, {
          code: 'TABLE_MISSING',
          table,
        })
      }
    }
  })

  return {
    ok: true,
    dbName,
    applied,
    skipped,
    finalApplied,
    requiredPresent: true,
    errors,
  }
}

function msToDatetime(ms) {
  if (ms == null || !Number.isFinite(ms)) return null
  return new Date(ms).toISOString().slice(0, 23).replace('T', ' ')
}

/**
 * Build masked account snapshot row matching product putAccountSnapshot shape.
 * Uses control-center fixture accounts (no tokens/secrets).
 */
export function buildFpCAccountSnapshotRecord(boardId, opts = {}) {
  const now = opts.now ?? new Date().toISOString()
  const nowMs = Date.parse(now)
  const pinBoardRev = opts.sourceRevision ?? 1
  const seed = buildAccountSyncSeed(now, {
    canonicalSnapshotId: 'fp-c-e2e-snap',
    canonicalHash: '0'.repeat(64),
    boardRev: pinBoardRev,
    lifecycleRev: 1,
    taskHash: 'f'.repeat(64),
  })
  const accounts = (seed.accounts ?? []).map((a) => ({
    maskedAccountId: a.maskedAccountId,
    status: a.status,
    providerKind: a.providerKind ?? 'GROK',
    effectiveInUse: a.effectiveInUse ?? 0,
    effectiveCap: a.effectiveCap ?? 1,
    physicalSlotsDisplay: a.physicalSlotsDisplay ?? null,
    adaptiveQuotaState: a.adaptiveQuotaState ?? null,
    reason: a.reason ?? null,
    statusChangedAt: a.statusChangedAt ?? now,
    tombstone: false,
  }))
  const capacity = {
    sparkLive: 0,
    sparkCap: 0,
    solLive: 0,
    solCap: 0,
    grokLive: accounts.filter((a) => a.providerKind === 'GROK' && a.status === 'ACTIVE').length,
    grokPerAccount: accounts
      .filter((a) => a.providerKind === 'GROK')
      .map((a) => ({
        maskedAccountId: a.maskedAccountId,
        inUse: a.effectiveInUse,
        cap: a.effectiveCap,
        healthy: a.status === 'ACTIVE',
      })),
    grokMajority: true,
    healthyGrokUsableCapacity: accounts
      .filter((a) => a.providerKind === 'GROK' && a.status === 'ACTIVE')
      .reduce((s, a) => s + Math.max(0, a.effectiveCap - a.effectiveInUse), 0),
    combinedLive: 0,
    combinedCap: 0,
    floorTarget: 0,
    floorMet: true,
    belowFloor: false,
    belowFloorReason: null,
    usableCapacity: Math.max(
      1,
      accounts
        .filter((a) => a.status === 'ACTIVE')
        .reduce((s, a) => s + Math.max(0, a.effectiveCap - a.effectiveInUse), 0),
    ),
    dispatchAllowed: true,
    dispatchMode: 'GROK_ONLY',
  }
  const readbackSurfaces = {
    mcp: { sourceRevision: pinBoardRev, generatedAt: now },
    api: { sourceRevision: pinBoardRev, generatedAt: now },
    ui: { sourceRevision: pinBoardRev, generatedAt: now },
    ops: { sourceRevision: pinBoardRev, generatedAt: now },
  }
  const snap = {
    boardId,
    sourceRevision: pinBoardRev,
    generatedAt: now,
    generatedAtMs: nowMs,
    accounts,
    readbackSurfaces,
    publishedAtMs: nowMs,
    lastPeriodicHealthAtMs: nowMs,
    stale: false,
    staleReason: null,
    usableCapacity: capacity.usableCapacity,
    capacity,
    entityRev: 1,
  }
  return snap
}

/**
 * Build one V3 run record matching product encodeRunRecord / putRun columns.
 */
export function buildFpCRunRecord(boardId, opts = {}) {
  const nowMs = opts.nowMs ?? Date.now()
  const runId = opts.runId ?? FIXTURE_RUN_ID
  const rec = {
    boardId,
    runId,
    state: opts.state ?? 'RUNNING',
    planId: opts.planId ?? 'plan_fp_c_e2e_001',
    planItemRank: opts.planItemRank ?? 1,
    taskId: opts.taskId ?? 'task-fp-c-seed-1',
    targetGate: opts.targetGate ?? 'SPEC_READY',
    role: opts.role ?? 'AGENT',
    agentId: opts.agentId ?? FIXTURE_AGENT_ID,
    model: opts.model ?? 'grok-4.5',
    effort: opts.effort ?? 'medium',
    maskedAccountRef: opts.maskedAccountRef ?? 'acc_synth_r2d_001',
    canonicalHash: opts.canonicalHash ?? null,
    collisionScopeLockIds: opts.collisionScopeLockIds ?? [],
    fencingToken: opts.fencingToken ?? `fence_fp_c_${runId}`,
    fencingVersion: 1,
    registeredAtMs: nowMs,
    heartbeatAtMs: nowMs,
    leaseExpiresAtMs: nowMs + 15 * 60 * 1000,
    materialProgressAtMs: nowMs,
    heartbeatSequence: 1,
    expectedEntityRev: 0,
    expectedBoardRev: opts.boardRev ?? 0,
    entityRev: 1,
    boardRev: opts.boardRev ?? 0,
    stalled: false,
    history: [
      {
        atMs: nowMs,
        atISO: new Date(nowMs).toISOString(),
        fromState: null,
        toState: 'RUNNING',
        reason: 'fp-c-e2e-fixture-seed',
        actorId: APPLIED_BY,
      },
    ],
    lastHeartbeatResponse: null,
    controllerRunId: null,
    parentRunId: null,
    idempotencyKey: opts.idempotencyKey ?? `idem-fp-c-${boardId}-${runId}`,
  }
  return rec
}

async function putRunRow(conn, rec) {
  const historyJson = JSON.stringify(rec.history)
  const locksJson = JSON.stringify(rec.collisionScopeLockIds)
  const recordJson = JSON.stringify(rec)
  await conn.query(
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
      rec.controllerRunId,
      rec.parentRunId,
      rec.idempotencyKey,
      recordJson,
    ],
  )
}

async function putAccountSnapshotRow(conn, snap) {
  const generatedAt = msToDatetime(snap.generatedAtMs) ?? snap.generatedAt.replace('T', ' ').slice(0, 23)
  await conn.query(
    `INSERT INTO control_plane_account_snapshots (
      board_id, source_revision, generated_at, generated_at_ms, published_at_ms,
      last_periodic_health_at_ms, stale, stale_reason, usable_capacity, entity_rev,
      accounts_json, capacity_json, readback_surfaces_json, record_json
    ) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)
    ON DUPLICATE KEY UPDATE
      source_revision=VALUES(source_revision), generated_at=VALUES(generated_at),
      generated_at_ms=VALUES(generated_at_ms), published_at_ms=VALUES(published_at_ms),
      last_periodic_health_at_ms=VALUES(last_periodic_health_at_ms), stale=VALUES(stale),
      stale_reason=VALUES(stale_reason), usable_capacity=VALUES(usable_capacity),
      entity_rev=VALUES(entity_rev), accounts_json=VALUES(accounts_json),
      capacity_json=VALUES(capacity_json), readback_surfaces_json=VALUES(readback_surfaces_json),
      record_json=VALUES(record_json)`,
    [
      snap.boardId,
      snap.sourceRevision,
      generatedAt,
      snap.generatedAtMs,
      snap.publishedAtMs,
      snap.lastPeriodicHealthAtMs,
      snap.stale ? 1 : 0,
      snap.staleReason,
      snap.usableCapacity,
      snap.entityRev,
      JSON.stringify(snap.accounts),
      JSON.stringify(snap.capacity),
      JSON.stringify(snap.readbackSurfaces),
      JSON.stringify(snap),
    ],
  )
  for (const surface of ['mcp', 'api', 'ui', 'ops']) {
    const rb = snap.readbackSurfaces?.[surface]
    if (!rb) continue
    await conn.query(
      `INSERT INTO control_plane_account_readbacks (
        board_id, surface, source_revision, generated_at, generated_at_ms, recorded_at_ms, entity_rev
      ) VALUES (?,?,?,?,?,?,?)
      ON DUPLICATE KEY UPDATE
        source_revision=VALUES(source_revision), generated_at=VALUES(generated_at),
        generated_at_ms=VALUES(generated_at_ms), recorded_at_ms=VALUES(recorded_at_ms),
        entity_rev=VALUES(entity_rev)`,
      [
        snap.boardId,
        surface,
        rb.sourceRevision,
        generatedAt,
        snap.generatedAtMs,
        Date.now(),
        snap.entityRev,
      ],
    )
  }
}

/**
 * Seed ≥1 control_plane_run + masked account snapshot per board on iso DB.
 * Discovers boards from boards table; falls back to ibils + mfs-rebuild.
 */
export async function seedControlPlaneRunAndAccounts(dbName, opts = {}) {
  assertFpCTargetDb(dbName)
  const result = {
    ok: true,
    dbName,
    boards: [],
    runsSeeded: [],
    accountsSeeded: [],
  }

  await withDbConnection(dbName, async (conn) => {
    let boardIds = opts.boardIds
    if (!Array.isArray(boardIds) || boardIds.length === 0) {
      const [rows] = await conn.query(`SELECT id FROM boards ORDER BY id ASC`)
      boardIds = (Array.isArray(rows) ? rows : []).map((r) => String(r.id))
    }
    if (boardIds.length === 0) {
      boardIds = ['ibils', DEFAULT_BOARD_ID]
      // Ensure boards exist for seed targets when clone had none (edge)
      for (const id of boardIds) {
        await conn.query(
          `INSERT IGNORE INTO boards (id, name, description, views, created_at)
           VALUES (?,?,?,?,CURDATE())`,
          [id, id, `FP-C fixture board ${id}`, JSON.stringify(['map', 'table'])],
        )
      }
    }
    result.boards = boardIds

    for (const boardId of boardIds) {
      const run = buildFpCRunRecord(boardId, {
        runId: `${FIXTURE_RUN_ID}_${boardId}`.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 160),
      })
      await putRunRow(conn, run)
      result.runsSeeded.push({ boardId, runId: run.runId, state: run.state })

      const snap = buildFpCAccountSnapshotRecord(boardId)
      await putAccountSnapshotRow(conn, snap)
      result.accountsSeeded.push({
        boardId,
        sourceRevision: snap.sourceRevision,
        accountCount: snap.accounts.length,
        usableCapacity: snap.usableCapacity,
        maskedIds: snap.accounts.map((a) => a.maskedAccountId),
      })
    }

    // Prove rows readable
    for (const boardId of boardIds) {
      const [runRows] = await conn.query(
        `SELECT run_id, state FROM control_plane_runs WHERE board_id=? LIMIT 5`,
        [boardId],
      )
      const [accRows] = await conn.query(
        `SELECT source_revision, usable_capacity,
                JSON_LENGTH(accounts_json) AS account_count
         FROM control_plane_account_snapshots WHERE board_id=? LIMIT 1`,
        [boardId],
      )
      if (!Array.isArray(runRows) || runRows.length < 1) {
        throw new ControlPlaneSchemaSeedError(`Seed readback: no runs for board ${boardId}`, {
          code: 'SEED_RUN_READBACK_EMPTY',
          boardId,
        })
      }
      if (!Array.isArray(accRows) || accRows.length < 1) {
        throw new ControlPlaneSchemaSeedError(
          `Seed readback: no account snapshot for board ${boardId}`,
          { code: 'SEED_ACCOUNT_READBACK_EMPTY', boardId },
        )
      }
    }
  })

  return result
}

/**
 * Full FP-C ensure: schema chain + run/account seed on iso. Idempotent.
 */
export async function ensureFpCControlPlaneOnIsoDb(dbName, opts = {}) {
  assertFpCTargetDb(dbName)
  const schema = await applyControlPlaneSchemaToIsoDb(dbName, opts)
  const seed = await seedControlPlaneRunAndAccounts(dbName, opts)
  return {
    ok: true,
    dbName,
    schema,
    seed,
    requiredVersions: [...FP_C_REQUIRED_VERSIONS],
    chainVersions: [...(opts.versions ?? FP_C_CLONE_CHAIN_VERSIONS)],
  }
}

/**
 * Pure self-tests (no MySQL).
 */
export function runFpCSchemaSeedSelfTests() {
  const results = []
  const ok = (name, pass, detail) => results.push({ name, pass: Boolean(pass), detail: detail ?? null })

  const m001 = loadMigrationFile('001')
  ok('load-001', m001.statements.length > 0 && m001.sha256.length === 64)
  const m005 = loadMigrationFile('005')
  ok(
    'load-005-has-runs-table',
    m005.statements.some((s) => /control_plane_runs/i.test(s)),
  )
  ok(
    'load-005-has-account-snapshots',
    m005.statements.some((s) => /control_plane_account_snapshots/i.test(s)),
  )

  let refused = false
  try {
    assertFpCTargetDb('cairn_taskmanager')
  } catch (e) {
    refused = e instanceof ControlPlaneSchemaSeedError
  }
  ok('refuse-ambient', refused)

  let refuseStaging = false
  try {
    assertFpCTargetDb('cairn_tm_v3_staging')
  } catch (e) {
    refuseStaging = e instanceof ControlPlaneSchemaSeedError
  }
  ok('refuse-staging', refuseStaging)

  const run = buildFpCRunRecord('ibils')
  ok('run-shape', run.runId && run.state === 'RUNNING' && run.agentId && run.taskId)
  const snap = buildFpCAccountSnapshotRecord('mfs-rebuild')
  ok(
    'account-shape-masked',
    snap.accounts.length >= 1 &&
      snap.accounts.every((a) => a.maskedAccountId && !('token' in a) && !('secret' in a)),
  )
  ok('required-versions-set', FP_C_REQUIRED_VERSIONS.join(',') === '001,002,004,005')

  const allPass = results.every((r) => r.pass)
  return { ok: allPass, results }
}

/**
 * Disposable MySQL proof: create iso, apply twice (idempotent), seed twice, verify counts, drop.
 * Does not touch ambient data beyond optional clone of structure (not used here — empty greenfield + 000).
 */
export async function runDisposableFpCProof(opts = {}) {
  const isoDb =
    opts.isoDbName?.trim() ||
    makeIsolatedDbName(opts.slug ?? 'fpc')
  assertFpCTargetDb(isoDb)

  const cfg = resolveMysqlConfig()
  // Greenfield: create empty DB then apply full chain including 000
  await withRootConnection(async (root) => {
    await root.query(`DROP DATABASE IF EXISTS \`${isoDb}\``)
    await root.query(
      `CREATE DATABASE \`${isoDb}\` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`,
    )
  })

  const greenfieldOpts = {
    boardIds: opts.boardIds ?? ['ibils', 'mfs-rebuild'],
    versions: opts.versions ?? [...FP_C_GREENFIELD_CHAIN_VERSIONS],
  }
  const first = await ensureFpCControlPlaneOnIsoDb(isoDb, greenfieldOpts)
  const second = await ensureFpCControlPlaneOnIsoDb(isoDb, greenfieldOpts)

  // Second pass must skip all migrations (already applied)
  const secondSkippedAll =
    second.schema.applied.length === 0 &&
    FP_C_REQUIRED_VERSIONS.every((v) => second.schema.skipped.includes(v) || second.schema.finalApplied.includes(v))

  const counts = await withDbConnection(isoDb, async (conn) => {
    const [runs] = await conn.query(
      `SELECT board_id, COUNT(*) AS n FROM control_plane_runs GROUP BY board_id`,
    )
    const [acc] = await conn.query(
      `SELECT board_id, source_revision, JSON_LENGTH(accounts_json) AS n
       FROM control_plane_account_snapshots`,
    )
    const [mig] = await conn.query(
      `SELECT version FROM schema_migrations WHERE dry_run=0 ORDER BY version`,
    )
    return {
      runs: Array.isArray(runs) ? runs : [],
      accounts: Array.isArray(acc) ? acc : [],
      migrations: (Array.isArray(mig) ? mig : []).map((r) => String(r.version)),
    }
  })

  const keep = opts.keepDb === true || process.env.CAIRN_E2E_KEEP_ISO_DB === '1'
  let dropped = false
  if (!keep) {
    await dropIsolatedDatabase(isoDb)
    dropped = true
  }

  const ok =
    first.ok &&
    second.ok &&
    secondSkippedAll &&
    counts.runs.length >= 1 &&
    counts.accounts.length >= 1 &&
    FP_C_REQUIRED_VERSIONS.every((v) => counts.migrations.includes(v))

  return {
    ok,
    isoDb,
    host: cfg.host,
    first: {
      applied: first.schema.applied,
      skipped: first.schema.skipped,
      runsSeeded: first.seed.runsSeeded,
      accountsSeeded: first.seed.accountsSeeded,
    },
    second: {
      applied: second.schema.applied,
      skipped: second.schema.skipped,
      runsSeeded: second.seed.runsSeeded.length,
      accountsSeeded: second.seed.accountsSeeded.length,
    },
    secondSkippedAll,
    counts,
    dropped,
    keep,
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
async function main(argv) {
  if (argv.includes('--self-test')) {
    const r = runFpCSchemaSeedSelfTests()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  if (argv.includes('--disposable-proof')) {
    const r = await runDisposableFpCProof()
    console.log(JSON.stringify(r, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  if (argv.includes('--help') || argv.includes('-h') || argv.length === 0) {
    console.log(`FP-C control-plane schema+seed (iso only)
  --self-test          pure unit checks
  --disposable-proof   create iso, migrate×2, seed×2, drop
  --ensure --db NAME   apply+seed existing iso DB
`)
    process.exit(0)
  }
  if (argv.includes('--ensure')) {
    const i = argv.indexOf('--db')
    const db = i >= 0 ? argv[i + 1] : process.env.CAIRN_ISO_DB_NAME || process.env.CAIRN_DB_NAME
    if (!db) {
      console.error('FAIL-CLOSED: --ensure requires --db or CAIRN_ISO_DB_NAME')
      process.exit(2)
    }
    const r = await ensureFpCControlPlaneOnIsoDb(db)
    console.log(JSON.stringify({ ok: r.ok, dbName: r.dbName, schema: r.schema, seed: r.seed }, null, 2))
    process.exit(r.ok ? 0 : 1)
  }
  console.error('Unknown args. Use --help')
  process.exit(2)
}

const isMain =
  process.argv[1] &&
  path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)

if (isMain) {
  main(process.argv.slice(2)).catch((e) => {
    console.error(String(e?.stack || e))
    process.exit(1)
  })
}
