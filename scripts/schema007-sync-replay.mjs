#!/usr/bin/env node
import { createHash } from 'node:crypto'
import { readFile, readdir } from 'node:fs/promises'
import { basename, resolve } from 'node:path'

const args = new Set(process.argv.slice(2))
const applyRuns = args.has('--apply-runs')
const applyClassifications = args.has('--apply-classifications')
const applySyncStatus = args.has('--apply-sync-status')
const endpoint =
  process.env.CAIRN_MCP_URL || 'https://task-manager.mfsdev.net/mcp'
const boardId = process.env.CAIRN_BOARD_ID || 'mfs-rebuild'
const legacyToken = process.env.CAIRN_WRITE_TOKEN || ''
const rootToken = process.env.CAIRN_ROOT_WRITE_TOKEN || ''
const token = applyClassifications ? rootToken : legacyToken
const receiptDir = resolve(
  process.env.CAIRN_UNSYNCED_RECEIPT_DIR ||
    '/opt/mfs/orchestrator-runtime/INTENT_LOCK_PLANNING_REBUILD/.artifact',
)
const canonicalTasksPath = resolve(
  process.env.CAIRN_CANONICAL_TASKS ||
    '/opt/mfs/workspace/CONTRACT/data/tasks.json',
)

if (!token) {
  throw new Error(
    applyClassifications
      ? 'CAIRN_ROOT_WRITE_TOKEN is required for explicit ROOT/OWNER apply mode'
      : 'CAIRN_WRITE_TOKEN is required (value is never printed)',
  )
}
if (applySyncStatus && (!applyClassifications || !applyRuns)) {
  throw new Error(
    '--apply-sync-status requires --apply-classifications and --apply-runs',
  )
}

const sha256 = (value) => createHash('sha256').update(value).digest('hex')

async function mcp(name, input) {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-cairn-token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: `schema007-${name}-${Date.now()}`,
      method: 'tools/call',
      params: { name, arguments: input },
    }),
  })
  const body = await response.json()
  if (!response.ok || body.error) {
    throw new Error(
      `MCP_${name.toUpperCase()}_FAILED status=${response.status}`,
    )
  }
  const text = body?.result?.content?.[0]?.text
  const parsed = typeof text === 'string' ? JSON.parse(text) : body.result
  if (parsed?.ok === false) {
    const error = new Error(`${name} failed: ${parsed.code || 'UNKNOWN'}`)
    error.code = parsed.code || 'UNKNOWN'
    throw error
  }
  return parsed
}

async function listTools() {
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      accept: 'application/json, text/event-stream',
      'x-cairn-token': token,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: 'schema007-tools',
      method: 'tools/list',
      params: {},
    }),
  })
  const body = await response.json()
  if (!response.ok || body.error)
    throw new Error(`MCP_TOOLS_LIST_FAILED status=${response.status}`)
  return (body?.result?.tools || []).map((tool) => String(tool.name))
}

async function listAll(tool, key) {
  const out = []
  let cursor
  do {
    const page = await mcp(tool, {
      boardId,
      pageSize: 200,
      ...(cursor ? { cursor } : {}),
    })
    out.push(...(page?.data?.[key] || page?.[key] || page?.items || []))
    cursor = page.nextCursor || null
  } while (cursor)
  return out
}

function samePin(surfaces) {
  const tuples = surfaces.map((surface) =>
    [surface.boardRev, surface.lifecycleRev, surface.canonicalHash].join(':'),
  )
  return new Set(tuples).size === 1
}

function rowsFrom(surface, key) {
  const rows = surface?.data?.[key] ?? surface?.[key] ?? []
  return Array.isArray(rows) ? rows : []
}

function parseAuditDetail(row) {
  if (
    row?.detail &&
    typeof row.detail === 'object' &&
    !Array.isArray(row.detail)
  ) {
    return row.detail
  }
  if (typeof row?.detail === 'string') {
    try {
      const parsed = JSON.parse(row.detail)
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed))
        return parsed
    } catch {
      return {}
    }
  }
  return {}
}

function findClassificationAudit(rows, canonicalHash) {
  return rows.find((row) => {
    if (String(row?.action ?? '') !== 'CLASSIFICATION_SYNC') return false
    return String(parseAuditDetail(row).canonicalHash ?? '') === canonicalHash
  })
}

function classificationAuditId(row) {
  const eventId = parseAuditDetail(row).eventId
  return typeof eventId === 'string' && eventId ? eventId : null
}

function classificationSyncReadback(rollup) {
  const controlPlane = rollup?.data?.controlPlane ?? rollup?.controlPlane ?? {}
  const sync = controlPlane?.classificationSync ?? {}
  const entityRev = Number(sync.entityRev ?? 0)
  return {
    entityRev,
    subjectHash: typeof sync.subjectHash === 'string' ? sync.subjectHash : null,
    unclassified:
      rollup?.data?.rollup?.unclassifiedCount ??
      rollup?.unclassifiedCount ??
      null,
  }
}

function normalizeReceipt(file, raw) {
  const runId = raw.run_id || raw.runId || null
  const receiptId = raw.receipt_id || raw.receiptId || basename(file, '.json')
  const packet = raw.packet || raw.role || receiptId
  const verdict =
    raw.verdict ||
    raw.authorVerdict ||
    raw.terminal ||
    raw.state ||
    'REPLAY_PENDING'
  const evidencePath =
    raw.artifactPath ||
    raw.verifierArtifact ||
    raw.evidencePath ||
    raw.verifier_artifact ||
    file
  const verdictText =
    typeof verdict === 'string' ? verdict : JSON.stringify(verdict)
  const status = /FAIL|BLOCK/i.test(verdictText)
    ? 'failed'
    : /PASS|INTEGRATED|DONE|SUCCEEDED/i.test(verdictText)
      ? 'done'
      : 'running'
  return {
    receiptId: String(receiptId),
    runId: runId ? String(runId) : null,
    packet: String(packet),
    role: String(raw.role || raw.packet || 'DEFERRED_RECEIPT_REPLAY'),
    verdict: verdictText.slice(0, 500),
    status,
    evidencePath: String(evidencePath),
    contentHash: sha256(JSON.stringify(raw)),
  }
}

async function loadReceipts() {
  const files = (await readdir(receiptDir))
    .filter((name) => /^UNSYNCED_RECEIPT_.*\.json$/.test(name))
    .sort()
  const rows = []
  for (const name of files) {
    const file = resolve(receiptDir, name)
    rows.push(normalizeReceipt(file, JSON.parse(await readFile(file, 'utf8'))))
  }
  return rows
}

function buildClassifications(tasks) {
  return tasks
    .map((task) => ({
      taskId: String(task.id),
      taskClass: task.projectId === 'automation' ? 'CONTROL_PLANE' : 'PRODUCT',
      disposition:
        task.scope === 'hold'
          ? 'HOLD'
          : task.scope === 'exclude'
            ? 'EXCLUDE'
            : 'ACTIVE',
      ...(task.projectId === 'automation'
        ? { controlPlaneTargetGate: 'CONTROL_PLANE_WORK_PENDING' }
        : {}),
    }))
    .sort((a, b) => a.taskId.localeCompare(b.taskId))
}

const [
  hash,
  rollup,
  lifecycle,
  next,
  activity,
  remoteTasks,
  remoteRuns,
  receipts,
  canonical,
] = await Promise.all([
  mcp('get_board_hash', { boardId }),
  mcp('get_rollup', { boardId }),
  mcp('get_lifecycle', { boardId }),
  mcp('get_next', { boardId }),
  mcp('list_activity', { boardId, pageSize: 20 }),
  listAll('list_tasks', 'tasks'),
  listAll('list_runs', 'runs'),
  loadReceipts(),
  readFile(canonicalTasksPath, 'utf8').then(JSON.parse),
])

const canonicalTasks = Array.isArray(canonical)
  ? canonical
  : canonical.tasks || []
const canonicalIds = canonicalTasks.map((task) => String(task.id)).sort()
const remoteIds = remoteTasks.map((task) => String(task.id)).sort()
const remoteIdSet = new Set(remoteIds)
const canonicalIdSet = new Set(canonicalIds)
const classifications = buildClassifications(canonicalTasks)
const classificationCounts = {
  total: classifications.length,
  product: classifications.filter((item) => item.taskClass === 'PRODUCT')
    .length,
  controlPlane: classifications.filter(
    (item) => item.taskClass === 'CONTROL_PLANE',
  ).length,
  active: classifications.filter((item) => item.disposition === 'ACTIVE')
    .length,
  hold: classifications.filter((item) => item.disposition === 'HOLD').length,
  exclude: classifications.filter((item) => item.disposition === 'EXCLUDE')
    .length,
}
const baselineOk =
  classificationCounts.total === 639 &&
  classificationCounts.product === 609 &&
  classificationCounts.controlPlane === 30 &&
  classificationCounts.active === 632 &&
  classificationCounts.hold === 7
if (!baselineOk) {
  throw new Error(
    `CANONICAL_CLASSIFICATION_BASELINE_MISMATCH ${JSON.stringify(classificationCounts)}`,
  )
}

const remoteRunIds = new Set(
  remoteRuns.map((run) => String(run.runId || run.id)),
)
const replayQueue = receipts.filter(
  (receipt) => receipt.runId && !remoteRunIds.has(receipt.runId),
)
const nowMs = Date.now()
const staleRuns = remoteRuns
  .filter((run) => String(run.status).toLowerCase() === 'running')
  .filter((run) => {
    const observed = Date.parse(run.updatedAt || run.createdAt || '')
    return Number.isFinite(observed) && nowMs - observed > 15 * 60_000
  })
  .map((run) => ({
    runId: run.runId || run.id,
    observedAt: run.updatedAt || run.createdAt,
  }))

const report = {
  schemaVersion: 'TM_SCHEMA007_SYNC_REPLAY_PLAN_V1',
  mode: applyClassifications
    ? applyRuns
      ? 'APPLY_CLASSIFICATIONS_AND_RUN_TELEMETRY'
      : 'APPLY_CLASSIFICATIONS'
    : applyRuns
      ? 'APPLY_RUN_TELEMETRY_ONLY'
      : 'PLAN_ONLY',
  boardId,
  pin: {
    boardRev: hash.boardRev,
    lifecycleRev: hash.lifecycleRev,
    canonicalSnapshotId: hash.canonicalSnapshotId,
    canonicalHash: hash.canonicalHash,
  },
  parity: {
    readSurfacePinMatch: samePin([hash, rollup, lifecycle, next]),
    canonicalTaskCount: canonicalIds.length,
    remoteTaskCount: remoteIds.length,
    missingRemoteIds: canonicalIds.filter((id) => !remoteIdSet.has(id)),
    extraRemoteIds: remoteIds.filter((id) => !canonicalIdSet.has(id)),
  },
  classification: {
    counts: classificationCounts,
    remoteUnclassified:
      rollup?.data?.rollup?.unclassifiedCount ??
      rollup?.unclassifiedCount ??
      null,
    writer: 'sync_task_classifications',
    writerRequires: 'ROOT_OR_OWNER_IMPORT_WRITE',
    items: classifications,
  },
  replay: {
    localReceiptCount: receipts.length,
    alreadyVisibleRunCount: receipts.length - replayQueue.length,
    pendingRunTelemetryCount: replayQueue.length,
    pending: replayQueue,
  },
  stale: {
    staleRunningRuns: staleRuns,
    activityCount: (activity?.data?.activity || activity?.activity || [])
      .length,
    dispatchPlanId: next.planId || next?.data?.planId || null,
    dispatchBlockedReason:
      next.blockedReason || next?.data?.blockedReason || null,
    legacyQueueIsNotDispatchAuthority: true,
  },
  writes: [],
}

if (applyClassifications) {
  const tools = await listTools()
  for (const required of [
    'sync_task_classifications',
    'list_audit',
    'list_activity',
  ]) {
    if (!tools.includes(required)) {
      throw new Error(`ROOT_OWNER_CAPABILITY_REQUIRED missing=${required}`)
    }
  }
  const [fresh, freshRollup] = await Promise.all([
    mcp('get_board_hash', { boardId }),
    mcp('get_rollup', { boardId }),
  ])
  const classificationState = classificationSyncReadback(freshRollup)
  const classificationEntityRev = classificationState.entityRev
  if (
    !Number.isSafeInteger(classificationEntityRev) ||
    classificationEntityRev < 0
  ) {
    throw new Error('CLASSIFICATION_ENTITY_REV_READBACK_REQUIRED')
  }
  const alreadyApplied =
    classificationEntityRev > 0 &&
    classificationState.subjectHash === fresh.canonicalHash &&
    classificationState.unclassified === 0
  const classificationIdempotency = sha256(
    JSON.stringify({
      boardId,
      canonicalHash: fresh.canonicalHash,
      lifecycleRev: fresh.lifecycleRev,
      expectedBoardRev: fresh.boardRev,
      entityExpectedRev: classificationEntityRev,
      classifications,
    }),
  )
  const write = alreadyApplied
    ? {
        boardRev: fresh.boardRev,
        entityRev: classificationEntityRev,
        auditId: null,
        receiptSetHash: null,
        noOp: true,
      }
    : await mcp('sync_task_classifications', {
        boardId,
        items: classifications,
        entityExpectedRev: classificationEntityRev,
        expectedBoardRev: fresh.boardRev,
        canonicalHash: fresh.canonicalHash,
        idempotencyKey: `schema007-classification-${classificationIdempotency.slice(0, 40)}`,
      })
  const [
    afterHash,
    afterRollup,
    afterLifecycle,
    afterAudit,
    afterActivity,
    afterTasks,
  ] = await Promise.all([
    mcp('get_board_hash', { boardId }),
    mcp('get_rollup', { boardId }),
    mcp('get_lifecycle', { boardId }),
    mcp('list_audit', { boardId, pageSize: 200 }),
    mcp('list_activity', { boardId, pageSize: 200 }),
    listAll('list_tasks', 'tasks'),
  ])
  const readbackPinsMatch = samePin([
    afterHash,
    afterRollup,
    afterLifecycle,
    afterAudit,
    afterActivity,
  ])
  const unclassified = classificationSyncReadback(afterRollup).unclassified
  const auditRows = rowsFrom(afterAudit, 'audit')
  const activityRows = rowsFrom(afterActivity, 'activity')
  const auditRow = findClassificationAudit(auditRows, afterHash.canonicalHash)
  const auditId = write.auditId ?? classificationAuditId(auditRow)
  const auditSeen = Boolean(auditRow && auditId)
  const activitySeen = activityRows.some(
    (row) => row?.kind === 'classification_sync' && row?.auditId === auditId,
  )
  const exactTaskSet =
    afterTasks.length === canonicalIds.length &&
    afterTasks.every((task) => canonicalIdSet.has(String(task.id)))
  if (
    !readbackPinsMatch ||
    unclassified !== 0 ||
    !auditSeen ||
    !activitySeen ||
    !exactTaskSet ||
    afterHash.boardRev !== write.boardRev
  ) {
    throw new Error(
      `CLASSIFICATION_READBACK_FAILED ${JSON.stringify({
        readbackPinsMatch,
        unclassified,
        auditSeen,
        activitySeen,
        exactTaskSet,
        writeBoardRev: write.boardRev,
        readbackBoardRev: afterHash.boardRev,
      })}`,
    )
  }
  report.writes.push({
    kind: 'classification_sync',
    ok: true,
    noOp: Boolean(write.noOp),
    boardRev: write.boardRev,
    entityRev: write.entityRev,
    auditId,
    receiptSetHash: write.receiptSetHash,
    readback: {
      unclassified,
      auditSeen,
      activitySeen,
      exactTaskSet,
      readbackPinsMatch,
    },
  })
}

if (applyRuns) {
  for (const receipt of replayQueue) {
    const fresh = await mcp('get_board_hash', { boardId })
    const write = await mcp('upsert_run', {
      boardId,
      id: receipt.runId,
      role: receipt.role,
      task: receipt.packet,
      status: receipt.status,
      targetGate: 'DEFERRED_RECEIPT_REPLAYED_TO_RUN_TELEMETRY',
      evidencePath: receipt.evidencePath,
      verdict: receipt.verdict,
      note: `receiptId=${receipt.receiptId}; contentHash=${receipt.contentHash}`,
      entityExpectedRev: 0,
      expectedBoardRev: fresh.boardRev,
      canonicalHash: fresh.canonicalHash,
      idempotencyKey: `schema007-replay-${receipt.contentHash.slice(0, 40)}`,
    })
    report.writes.push({
      kind: 'run_replay',
      runId: receipt.runId,
      ok: write?.run?.id === receipt.runId,
      boardRev: write?.boardRev ?? null,
    })
  }

  const [
    finalHash,
    finalRollup,
    finalLifecycle,
    finalAudit,
    finalActivity,
    finalTasks,
    finalRuns,
  ] = await Promise.all([
    mcp('get_board_hash', { boardId }),
    mcp('get_rollup', { boardId }),
    mcp('get_lifecycle', { boardId }),
    mcp('list_audit', { boardId, pageSize: 200 }),
    mcp('list_activity', { boardId, pageSize: 200 }),
    listAll('list_tasks', 'tasks'),
    listAll('list_runs', 'runs'),
  ])
  const finalPinsMatch = samePin([
    finalHash,
    finalRollup,
    finalLifecycle,
    finalAudit,
    finalActivity,
  ])
  const finalRunById = new Map(
    finalRuns.map((run) => [String(run.runId || run.id), run]),
  )
  const runReadbacks = replayQueue.map((receipt) => ({
    runId: receipt.runId,
    visible: finalRunById.has(String(receipt.runId)),
    status: finalRunById.get(String(receipt.runId))?.status ?? null,
  }))
  const allRunsVisible = runReadbacks.every((row) => row.visible)
  const finalExactTaskSet =
    finalTasks.length === canonicalIds.length &&
    finalTasks.every((task) => canonicalIdSet.has(String(task.id)))
  const finalClassificationState = classificationSyncReadback(finalRollup)
  const finalAuditRow = findClassificationAudit(
    rowsFrom(finalAudit, 'audit'),
    finalHash.canonicalHash,
  )
  const finalAuditId = classificationAuditId(finalAuditRow)
  const finalActivitySeen = rowsFrom(finalActivity, 'activity').some(
    (row) =>
      row?.kind === 'classification_sync' && row?.auditId === finalAuditId,
  )
  const classificationsStillValid =
    !applyClassifications ||
    (finalClassificationState.unclassified === 0 &&
      finalClassificationState.subjectHash === finalHash.canonicalHash &&
      finalExactTaskSet &&
      Boolean(finalAuditId) &&
      finalActivitySeen)
  if (!finalPinsMatch || !allRunsVisible || !classificationsStillValid) {
    throw new Error(
      `FINAL_REPLAY_READBACK_FAILED ${JSON.stringify({
        finalPinsMatch,
        allRunsVisible,
        classificationsStillValid,
        finalUnclassified: finalClassificationState.unclassified,
        finalExactTaskSet,
        finalAuditId,
        finalActivitySeen,
      })}`,
    )
  }
  report.finalReadback = {
    boardRev: finalHash.boardRev,
    lifecycleRev: finalHash.lifecycleRev,
    canonicalHash: finalHash.canonicalHash,
    pinsMatch: finalPinsMatch,
    runReadbacks,
    classificationsStillValid,
    unclassified: finalClassificationState.unclassified,
    exactTaskSet: finalExactTaskSet,
    classificationAuditId: finalAuditId,
    classificationActivitySeen: finalActivitySeen,
  }
}

if (applySyncStatus) {
  const final = report.finalReadback
  if (
    !final?.pinsMatch ||
    !final?.classificationsStillValid ||
    final?.unclassified !== 0 ||
    !final?.exactTaskSet ||
    !final?.runReadbacks?.every((row) => row.visible)
  ) {
    throw new Error('SYNC_STATUS_ZERO_REQUIRES_FINAL_REPLAY_PARITY')
  }
  const mysql = await import('mysql2/promise')
  const connection = await mysql.createConnection({
    host: process.env.CAIRN_DB_HOST,
    port: Number(process.env.CAIRN_DB_PORT || 3306),
    user: process.env.CAIRN_DB_USER,
    password: process.env.CAIRN_DB_PASSWORD,
    database: process.env.CAIRN_DB_NAME,
    connectTimeout: 10_000,
  })
  try {
    const record = {
      schemaVersion: 'CP0_SYNC_STATUS_V1',
      status: 'IN_SYNC',
      outboxPending: 0,
      legacyUnreplayed: 0,
      effectiveBacklog: 0,
      boardRev: final.boardRev,
      lifecycleRev: final.lifecycleRev,
      canonicalHash: final.canonicalHash,
    }
    await connection.execute(
      `INSERT INTO control_plane_sync_status
       (board_id, status, outbox_pending, legacy_unreplayed, effective_backlog,
        board_rev, lifecycle_rev, canonical_hash, last_ack_revision,
        freshness_at, entity_rev, record_json)
       VALUES (?, 'IN_SYNC', 0, 0, 0, ?, ?, ?, ?, NOW(3), 1, ?)
       ON DUPLICATE KEY UPDATE
         status=VALUES(status), outbox_pending=0, legacy_unreplayed=0,
         effective_backlog=0, board_rev=VALUES(board_rev),
         lifecycle_rev=VALUES(lifecycle_rev), canonical_hash=VALUES(canonical_hash),
         last_ack_revision=VALUES(last_ack_revision), freshness_at=NOW(3),
         entity_rev=entity_rev+1, record_json=VALUES(record_json)`,
      [
        boardId,
        final.boardRev,
        final.lifecycleRev,
        final.canonicalHash,
        final.boardRev,
        JSON.stringify(record),
      ],
    )
  } finally {
    await connection.end()
  }
  const sync = await mcp('get_sync_status', { boardId })
  if (
    sync?.status !== 'IN_SYNC' ||
    sync?.effectiveBacklog !== 0 ||
    sync?.zeroBacklogProven !== true ||
    sync?.parity !== true
  ) {
    throw new Error('SYNC_STATUS_READBACK_FAILED')
  }
  report.syncStatus = sync
}

process.stdout.write(`${JSON.stringify(report, null, 2)}\n`)
