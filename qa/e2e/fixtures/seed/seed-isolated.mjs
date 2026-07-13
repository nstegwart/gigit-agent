#!/usr/bin/env node
/**
 * Isolated synthetic DB seed for deterministic control-center browser harness.
 * Creates unique DB + tables + mfs-rebuild fixtures + board_revisions pin.
 * Zero users (bootstrap via /login). Never copies ambient DB.
 *
 * Env:
 *   CAIRN_ISO_DB_NAME — optional fixed name (must pass assertSafeIsoDbName)
 *   CAIRN_DB_HOST/PORT/USER/PASSWORD — MySQL admin connection
 *   BOARD_ID — default mfs-rebuild
 *   CAIRN_SEED_PROVENANCE_PATH — where to write SYNTHETIC_PROVENANCE.json
 *
 * Usage:
 *   node qa/e2e/fixtures/seed/seed-isolated.mjs
 *   CAIRN_ISO_DB_NAME=cairn_tm_e2e_r2d_demo node qa/e2e/fixtures/seed/seed-isolated.mjs
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  makeIsolatedDbName,
  recreateIsolatedDatabase,
  resolveMysqlConfig,
  withDbConnection,
} from '../../lib/db-iso.mjs'
import {
  BOARD_VIEWS,
  DEFAULT_BOARD_ID,
  buildAccountSyncSeed,
  buildBoardDocs,
  buildDispatchPlanSeed,
  buildHarnessPin,
  buildSyntheticTasks,
  validateFixtureContract,
} from './control-center-fixture.mjs'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

export async function seedIsolatedControlCenter(options = {}) {
  const now = options.now ?? new Date().toISOString()
  const boardId =
    options.boardId ?? process.env.BOARD_ID?.trim() ?? DEFAULT_BOARD_ID
  const dbName = options.dbName ?? makeIsolatedDbName(options.slug ?? 'r4f')
  const tasks = options.tasks ?? buildSyntheticTasks(now)
  const pin = { ...buildHarnessPin(tasks.map((t) => t.id)), ...(options.pin ?? {}) }
  // Rebuild tasks bound to final pin when caller overrode pin fields
  const boundTasks =
    options.tasks ??
    buildSyntheticTasks(now, pin)
  const docs = options.docs ?? buildBoardDocs(now, pin)
  const dispatchSeed = options.dispatchSeed ?? buildDispatchPlanSeed(now, pin)
  const accountSyncSeed = options.accountSyncSeed ?? buildAccountSyncSeed(now, pin)

  const contract = validateFixtureContract(boundTasks, docs)
  if (!contract.ok) {
    throw new Error(`seed fixture contract failed: ${contract.errors.join('; ')}`)
  }

  await recreateIsolatedDatabase(dbName)

  return withDbConnection(dbName, async (db) => {
    await db.query(`CREATE TABLE boards (
      id VARCHAR(64) NOT NULL PRIMARY KEY,
      name VARCHAR(255) NOT NULL,
      description TEXT,
      views JSON NULL,
      created_at VARCHAR(32) NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await db.query(`CREATE TABLE board_docs (
      board_id VARCHAR(64) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      data JSON NOT NULL,
      PRIMARY KEY (board_id, kind)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await db.query(`CREATE TABLE globals (
      k VARCHAR(64) NOT NULL PRIMARY KEY,
      data JSON NOT NULL
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await db.query(`CREATE TABLE tasks (
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

    await db.query(`CREATE TABLE audit_log (
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

    // Control-plane pin authority (so harness manifest pins are PRESENT, not MISSING)
    await db.query(`CREATE TABLE board_revisions (
      board_id VARCHAR(64) NOT NULL,
      board_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
      lifecycle_rev BIGINT UNSIGNED NOT NULL DEFAULT 1,
      subject_hash CHAR(64) NULL,
      canonical_snapshot_id VARCHAR(64) NULL,
      updated_at DATETIME(3) NOT NULL DEFAULT CURRENT_TIMESTAMP(3) ON UPDATE CURRENT_TIMESTAMP(3),
      PRIMARY KEY (board_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4`)

    await db.query(`CREATE TABLE control_plane_snapshots (
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

    await db.query(`CREATE TABLE control_plane_evidence (
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

    await db.query(
      'INSERT INTO boards (id, name, description, views, created_at) VALUES (?,?,?,?,?)',
      [
        boardId,
        'MFS Rebuild (SYNTH C3-R4F)',
        'Synthetic isolated board for deterministic browser harness. Not production.',
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

    // Persist control-plane bootstrap payloads for harness MCP publish (authorized path).
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

    await db.query('INSERT INTO globals (k, data) VALUES (?,?)', [
      'conventions',
      JSON.stringify({ note: 'synthetic conventions for C3-R4F harness' }),
    ])

    for (const t of boundTasks) {
      const classification = t.data?.classification ?? null
      const summary = {
        checkpoints: t.data.checkpoints ?? [],
        dependencies: t.data.dependencies ?? [],
        impacts: t.data.impacts ?? [],
        mappingPct: t.data.mappingPct ?? null,
        status: t.data.status ?? null,
        // Persist classification on summary so light list path keeps V3 proof without full data
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
      const lifecycleStage =
        t.lifecycle_stage ?? t.data?.lifecycleStage ?? null
      const implementerRun = t.implementer_run ?? t.data?.implementerRun ?? null
      const blockedReason =
        t.blocked_reason ?? t.data?.blockedReason ?? null
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

    await db.query(
      `INSERT INTO board_revisions (board_id, board_rev, lifecycle_rev, subject_hash, canonical_snapshot_id)
       VALUES (?,?,?,?,?)`,
      [
        boardId,
        pin.boardRev,
        pin.lifecycleRev,
        pin.canonicalHash.slice(0, 64),
        pin.canonicalSnapshotId,
      ],
    )

    await db.query(
      `INSERT INTO control_plane_snapshots
        (board_id, snapshot_id, schema_version, payload_sha256, board_rev, lifecycle_rev, generated_at, producer_version, payload_json)
       VALUES (?,?,?,?,?,?,?,?,?)`,
      [
        boardId,
        pin.canonicalSnapshotId,
        'TM_UI_CONTRACT_V1',
        pin.canonicalHash.slice(0, 64),
        pin.boardRev,
        pin.lifecycleRev,
        now.slice(0, 23).replace('T', ' '),
        'c3-r4f-seed',
        JSON.stringify({
          synthetic: true,
          boardId,
          taskHash: pin.taskHash,
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
        }),
      ],
    )

    // Evidence for DONE positive classification + membership
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
        'c3-r4f-seed',
        'seed_created',
        null,
        JSON.stringify({
          synthetic: true,
          purpose: 'C3-R4F deterministic fixture truth',
          taskHash: pin.taskHash,
        }),
      ],
    )

    const [bc] = await db.query('SELECT COUNT(*) AS n FROM boards')
    const [tc] = await db.query('SELECT COUNT(*) AS n FROM tasks')
    const [dc] = await db.query('SELECT COUNT(*) AS n FROM board_docs')
    const [rc] = await db.query('SELECT COUNT(*) AS n FROM board_revisions')
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

    const provenance = {
      createdAt: now,
      isoDb: dbName,
      mysql: resolveMysqlConfig(),
      boardId,
      boards: Number(bc[0].n),
      tasks: Number(tc[0].n),
      boardDocs: Number(dc[0].n),
      boardRevisions: Number(rc[0].n),
      usersSeeded: 0,
      pin: {
        canonicalSnapshotId: pin.canonicalSnapshotId,
        canonicalHash: pin.canonicalHash,
        taskHash: pin.taskHash,
        boardRev: String(pin.boardRev),
        lifecycleRev: String(pin.lifecycleRev),
      },
      seedProof: {
        classifiedTasks: Number(classifiedRows[0].n),
        missingProofUnclassified: Number(missingRows[0].n) === 1,
        doneLifecycleStage: doneStage[0]?.s ?? null,
        dispatchPlanId: dispatchSeed.planId,
        accountSyncSourceRevision: accountSyncSeed.sourceRevision,
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
    }

    const provenancePath =
      options.provenancePath ||
      process.env.CAIRN_SEED_PROVENANCE_PATH ||
      path.join(__dirname, 'SYNTHETIC_PROVENANCE.latest.json')
    fs.mkdirSync(path.dirname(provenancePath), { recursive: true })
    fs.writeFileSync(provenancePath, JSON.stringify(provenance, null, 2), 'utf8')
    const safe = {
      ok: true,
      ...provenance,
      mysql: { host: provenance.mysql.host, port: provenance.mysql.port, user: provenance.mysql.user },
      provenancePath,
      contract: {
        ok: contract.ok,
        taskHash: contract.taskHash,
        classifiedCount: contract.classifiedCount,
        unclassifiedCount: contract.unclassifiedCount,
      },
    }
    return safe
  })
}

async function main() {
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
