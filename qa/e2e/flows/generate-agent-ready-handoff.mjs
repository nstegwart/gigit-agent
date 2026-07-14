/**
 * Fail-closed AGENT READY handoff generator for MFS rebuild / task-manager.
 * (No shebang: Vitest/Vite parse fails on #! after client inject; run via `node …`.)
 *
 * Modes:
 *   --self-test | (default)  pure fixture evaluation (no network, no write)
 *   --query | --live         query authenticated pinned surfaces (read-only)
 *   --write                  write external Downloads path (requires approval)
 *   --approve-external-write must accompany --write (or HANDOFF_EXTERNAL_WRITE_APPROVED=1)
 *
 * Env (query/live):
 *   STAGING_URL | WEB_BASE     e.g. http://127.0.0.1:33211
 *   BOARD_ID                   default mfs-rebuild
 *   STAGING_ROOT_BEARER_TOKEN | STAGING_BEARER_TOKEN | STAGING_BEARER | CAIRN_MCP_BEARER
 *   HANDOFF_OUT_PATH           default /Users/user/Downloads/TASK_MANAGER_MFS_REBUILD_AGENT_READY.txt
 *   HANDOFF_EXTERNAL_WRITE_APPROVED=1  alternative to --approve-external-write
 *
 * Never prints credentials. Never mutates control-plane. Default = stdout only.
 * External Downloads write is opt-in and fail-closed without explicit approval.
 *
 * Status cap: LOCAL ONLY for self-test; live query proves surfaces but READY
 * only when non-SYNTH authorized plan + PRODUCT classification + productDenominator>0.
 */
import { writeFileSync, mkdirSync } from 'node:fs'
import { dirname, join, resolve as pathResolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')

/** Owner-authorized external handoff path (write only with dual approval). */
export const DEFAULT_EXTERNAL_HANDOFF_PATH =
  '/Users/user/Downloads/TASK_MANAGER_MFS_REBUILD_AGENT_READY.txt'

export const GENERATOR_ID = 'generate-agent-ready-handoff.v1'

/** Terminal readiness labels for the handoff text (not worker WORKER_RESULT statuses). */
export const HANDOFF_STATUS = Object.freeze({
  READY: 'READY',
  NOT_READY: 'NOT READY',
})

/** Machine refuse codes (fail-closed). */
export const REFUSE_CODE = Object.freeze({
  PRODUCT_DENOMINATOR_ZERO: 'PRODUCT_DENOMINATOR_ZERO',
  SYNTH_PLAN_OR_TASK: 'SYNTH_PLAN_OR_TASK',
  UNCLASSIFIED: 'UNCLASSIFIED',
  STALE_PIN: 'STALE_PIN',
  PIN_SYNTHETIC: 'PIN_SYNTHETIC',
  NO_REAL_NEXT: 'NO_REAL_NEXT',
  NO_AUTHORIZED_PLAN: 'NO_AUTHORIZED_PLAN',
  QUERY_FAILED: 'QUERY_FAILED',
  EXTERNAL_WRITE_DENIED: 'EXTERNAL_WRITE_DENIED',
})

// ---------------------------------------------------------------------------
// Pure helpers (export for unit tests)
// ---------------------------------------------------------------------------

/**
 * True when task/plan/pin identity is synthetic (must never authorize product start).
 * @param {string|null|undefined} value
 */
export function isSyntheticIdentity(value) {
  if (value == null) return false
  const s = String(value).trim()
  if (!s) return false
  if (/^task-next-\d+$/i.test(s)) return true
  if (/synth/i.test(s)) return true
  if (/^synthetic[-_]/i.test(s)) return true
  return false
}

/**
 * @param {string|null|undefined} reason
 */
export function selectionReasonIsSynth(reason) {
  if (reason == null) return false
  return /\bSYNTH\b/i.test(String(reason)) || /synthetic/i.test(String(reason))
}

/**
 * @param {unknown} item selectedForNextDispatch membership item
 */
export function isSynthNextItem(item) {
  if (!item || typeof item !== 'object') return true
  const o = /** @type {Record<string, unknown>} */ (item)
  if (isSyntheticIdentity(o.taskId)) return true
  if (isSyntheticIdentity(o.planId)) return true
  if (selectionReasonIsSynth(/** @type {string} */ (o.selectionReason))) return true
  return false
}

/**
 * @param {unknown} classification get_task.classification or overview row
 */
export function isUnclassified(classification) {
  if (classification == null || typeof classification !== 'object') return true
  const c = /** @type {Record<string, unknown>} */ (classification)
  const taskClass = String(c.taskClass ?? c.class ?? 'UNCLASSIFIED').toUpperCase()
  const disposition = String(c.disposition ?? taskClass).toUpperCase()
  return taskClass === 'UNCLASSIFIED' || disposition === 'UNCLASSIFIED'
}

/**
 * @param {unknown} classification
 */
export function isProductClassified(classification) {
  if (classification == null || typeof classification !== 'object') return false
  if (isUnclassified(classification)) return false
  const c = /** @type {Record<string, unknown>} */ (classification)
  const taskClass = String(c.taskClass ?? c.class ?? '').toUpperCase()
  return taskClass === 'PRODUCT'
}

/**
 * Detect synthetic pin authority (snapshot id / hash label).
 * @param {{ canonicalSnapshotId?: string|null, canonicalHash?: string|null }} pin
 */
export function isSyntheticPin(pin) {
  if (!pin) return true
  if (isSyntheticIdentity(pin.canonicalSnapshotId)) return true
  if (isSyntheticIdentity(pin.canonicalHash)) return true
  return false
}

/**
 * Stale / incomplete pin vs plan membership expectedBoardRev.
 * @param {object} input
 */
export function isStalePinOrPlan(input) {
  const pin = input?.pin ?? {}
  const nextItem = input?.nextItem ?? null
  const nowMs = input?.nowMs ?? Date.now()

  const boardRev = Number(pin.boardRev)
  const lifecycleRev = Number(pin.lifecycleRev)
  const hash = pin.canonicalHash
  const snap = pin.canonicalSnapshotId

  if (
    !Number.isFinite(boardRev) ||
    boardRev < 0 ||
    !Number.isFinite(lifecycleRev) ||
    lifecycleRev < 0 ||
    typeof hash !== 'string' ||
    !hash.trim() ||
    typeof snap !== 'string' ||
    !snap.trim()
  ) {
    return { stale: true, reason: 'INCOMPLETE_PIN' }
  }

  if (nextItem && typeof nextItem === 'object') {
    const expectedBoardRev = Number(nextItem.expectedBoardRev)
    if (Number.isFinite(expectedBoardRev) && expectedBoardRev !== boardRev) {
      return {
        stale: true,
        reason: 'PLAN_BOARD_REV_MISMATCH',
        expectedBoardRev,
        liveBoardRev: boardRev,
      }
    }
  }

  if (input?.planExpiresAt) {
    const expMs = Date.parse(String(input.planExpiresAt))
    if (Number.isFinite(expMs) && expMs <= nowMs) {
      return { stale: true, reason: 'PLAN_EXPIRED', planExpiresAt: input.planExpiresAt }
    }
  }

  if (input?.healthOk === false) {
    return { stale: true, reason: 'HEALTH_NOT_OK' }
  }

  return { stale: false }
}

/**
 * Normalize selected NEXT list from get_next / get_overview shapes.
 * @param {unknown} nextPayload
 * @returns {Array<Record<string, unknown>>}
 */
export function extractSelectedNext(nextPayload) {
  if (!nextPayload || typeof nextPayload !== 'object') return []
  const p = /** @type {Record<string, unknown>} */ (nextPayload)
  const direct = p.selectedForNextDispatch
  if (Array.isArray(direct)) return direct.filter((x) => x && typeof x === 'object')
  const nested = p.next && typeof p.next === 'object' ? /** @type {Record<string, unknown>} */ (p.next) : null
  if (nested && Array.isArray(nested.membership)) {
    return nested.membership.filter((x) => x && typeof x === 'object')
  }
  if (nested && Array.isArray(nested.selectedForNextDispatch)) {
    return nested.selectedForNextDispatch.filter((x) => x && typeof x === 'object')
  }
  return []
}

/**
 * @param {unknown} overview
 * @returns {number|null}
 */
export function extractProductDenominator(overview) {
  if (!overview || typeof overview !== 'object') return null
  const o = /** @type {Record<string, unknown>} */ (overview)
  const candidates = [
    o.productDenominator,
    o.boardRollup && typeof o.boardRollup === 'object'
      ? /** @type {Record<string, unknown>} */ (o.boardRollup).productDenominator
      : null,
    o.rollup && typeof o.rollup === 'object'
      ? /** @type {Record<string, unknown>} */ (o.rollup).productDenominator
      : null,
    o.v3 && typeof o.v3 === 'object'
      ? /** @type {Record<string, unknown>} */ (o.v3).productDenominator
      : null,
    o.data && typeof o.data === 'object'
      ? /** @type {Record<string, unknown>} */ (o.data).productDenominator
      : null,
  ]
  for (const c of candidates) {
    if (typeof c === 'number' && Number.isFinite(c)) return c
    if (typeof c === 'string' && c.trim() !== '' && Number.isFinite(Number(c))) return Number(c)
  }
  return null
}

/**
 * Core fail-closed readiness evaluation over already-fetched pinned surfaces.
 *
 * @param {{
 *   boardId?: string,
 *   pin?: Record<string, unknown>|null,
 *   overview?: Record<string, unknown>|null,
 *   next?: Record<string, unknown>|null,
 *   task?: Record<string, unknown>|null,
 *   health?: Record<string, unknown>|null,
 *   nowMs?: number,
 *   planExpiresAt?: string|null,
 * }} surfaces
 * @returns {{
 *   status: 'READY'|'NOT READY',
 *   ready: boolean,
 *   refuseCodes: string[],
 *   reasons: string[],
 *   selected: Record<string, unknown>|null,
 *   productDenominator: number|null,
 *   planId: string|null,
 *   soleSource: string|null,
 *   boardId: string,
 *   pin: Record<string, unknown>|null,
 *   agentContract: object|null,
 * }}
 */
export function evaluateAgentReadySurfaces(surfaces = {}) {
  const boardId = String(surfaces.boardId || 'mfs-rebuild')
  const pin = surfaces.pin && typeof surfaces.pin === 'object' ? surfaces.pin : null
  const overview =
    surfaces.overview && typeof surfaces.overview === 'object' ? surfaces.overview : null
  const next = surfaces.next && typeof surfaces.next === 'object' ? surfaces.next : null
  const task = surfaces.task && typeof surfaces.task === 'object' ? surfaces.task : null
  const health = surfaces.health && typeof surfaces.health === 'object' ? surfaces.health : null
  const nowMs = surfaces.nowMs ?? Date.now()

  /** @type {string[]} */
  const refuseCodes = []
  /** @type {string[]} */
  const reasons = []

  const productDenominator = extractProductDenominator(overview)
  const selectedList = extractSelectedNext(next)
  const blockedReason =
    next && typeof next.blockedReason === 'string' && next.blockedReason
      ? next.blockedReason
      : next?.next &&
          typeof next.next === 'object' &&
          /** @type {Record<string, unknown>} */ (next.next).blockedReason
        ? String(/** @type {Record<string, unknown>} */ (next.next).blockedReason)
        : null
  const planId =
    (next && typeof next.planId === 'string' && next.planId) ||
    (selectedList[0] && typeof selectedList[0].planId === 'string'
      ? String(selectedList[0].planId)
      : null)
  const soleSource =
    (next && typeof next.soleSource === 'string' && next.soleSource) ||
    (next?.next &&
    typeof next.next === 'object' &&
    typeof /** @type {Record<string, unknown>} */ (next.next).soleSource === 'string'
      ? String(/** @type {Record<string, unknown>} */ (next.next).soleSource)
      : null)

  // 1) pin synthetic
  if (!pin || isSyntheticPin(pin)) {
    refuseCodes.push(REFUSE_CODE.PIN_SYNTHETIC)
    reasons.push('pin authority is missing or synthetic (snapshot/hash id)')
  }

  // 2) productDenominator
  if (productDenominator == null) {
    refuseCodes.push(REFUSE_CODE.PRODUCT_DENOMINATOR_ZERO)
    reasons.push('productDenominator missing from overview/rollup (fail-closed as zero)')
  } else if (productDenominator === 0) {
    refuseCodes.push(REFUSE_CODE.PRODUCT_DENOMINATOR_ZERO)
    reasons.push('productDenominator=0 — no PRODUCT scope; readiness must not authorize start')
  }

  // 3) real NEXT
  if (!selectedList.length) {
    refuseCodes.push(REFUSE_CODE.NO_REAL_NEXT)
    reasons.push(
      blockedReason
        ? `no selectedForNextDispatch (blockedReason=${blockedReason})`
        : 'no selectedForNextDispatch membership',
    )
  }

  // 4) authorized plan source
  if (!planId || soleSource !== 'active_dispatch_plan') {
    refuseCodes.push(REFUSE_CODE.NO_AUTHORIZED_PLAN)
    reasons.push(
      !planId
        ? 'missing planId from active dispatch plan'
        : `soleSource=${soleSource ?? 'null'} (required active_dispatch_plan)`,
    )
  }

  const selected = selectedList[0] ?? null

  // 5) SYNTH refuse
  if (selected && isSynthNextItem(selected)) {
    refuseCodes.push(REFUSE_CODE.SYNTH_PLAN_OR_TASK)
    reasons.push(
      `selected NEXT is SYNTH (taskId=${selected.taskId ?? '?'} planId=${selected.planId ?? planId ?? '?'} reason=${selected.selectionReason ?? '?'})`,
    )
  }
  if (planId && isSyntheticIdentity(planId)) {
    if (!refuseCodes.includes(REFUSE_CODE.SYNTH_PLAN_OR_TASK)) {
      refuseCodes.push(REFUSE_CODE.SYNTH_PLAN_OR_TASK)
    }
    reasons.push(`planId is synthetic: ${planId}`)
  }

  // 6) classification
  const classification =
    (task && typeof task.classification === 'object' && task.classification) ||
    (task && typeof task.taskClass === 'string'
      ? { taskClass: task.taskClass, disposition: task.disposition ?? task.taskClass }
      : null) ||
    (selected && selected.classification && typeof selected.classification === 'object'
      ? selected.classification
      : null)

  // When we have a selected item, classification must be PRODUCT (missing → UNCLASSIFIED)
  if (selected) {
    if (isUnclassified(classification)) {
      refuseCodes.push(REFUSE_CODE.UNCLASSIFIED)
      reasons.push(
        `selected task ${selected.taskId ?? '?'} is UNCLASSIFIED or missing classification`,
      )
    } else if (!isProductClassified(classification)) {
      refuseCodes.push(REFUSE_CODE.UNCLASSIFIED)
      reasons.push(
        `selected task ${selected.taskId ?? '?'} taskClass=${/** @type {Record<string, unknown>} */ (classification || {}).taskClass ?? '?'} is not PRODUCT`,
      )
    }
  }

  // 7) stale
  const healthOk =
    health == null
      ? undefined
      : health.ok === true ||
        health.status === 'ok' ||
        health.status === 'healthy' ||
        (typeof health.status === 'string' && health.status.toLowerCase() === 'ok')
  const stale = isStalePinOrPlan({
    pin,
    nextItem: selected,
    nowMs,
    planExpiresAt: surfaces.planExpiresAt ?? null,
    healthOk: health == null ? undefined : Boolean(healthOk),
  })
  if (stale.stale) {
    refuseCodes.push(REFUSE_CODE.STALE_PIN)
    reasons.push(`stale/incomplete pin or plan: ${stale.reason}`)
  }

  // De-dupe codes while preserving order
  const uniqueCodes = [...new Set(refuseCodes)]
  const ready = uniqueCodes.length === 0 && selected != null

  /** @type {object|null} */
  let agentContract = null
  if (ready && selected) {
    agentContract = {
      boardId,
      planId,
      planVersion: selected.planVersion ?? null,
      planHash: selected.planHash ?? null,
      taskId: selected.taskId,
      targetGate: selected.targetGate ?? null,
      role: selected.role ?? null,
      rank: selected.rank ?? null,
      selectionReason: selected.selectionReason ?? null,
      priorityPortfolioId: selected.priorityPortfolioId ?? null,
      collisionScopeLockIds: Array.isArray(selected.collisionScopeLockIds)
        ? selected.collisionScopeLockIds
        : [],
      expectedEntityRev: selected.expectedEntityRev ?? null,
      expectedBoardRev: selected.expectedBoardRev ?? pin?.boardRev ?? null,
      soleSource: 'active_dispatch_plan',
      productDenominator,
      pin: {
        canonicalSnapshotId: pin?.canonicalSnapshotId ?? null,
        canonicalHash: pin?.canonicalHash ?? null,
        boardRev: pin?.boardRev ?? null,
        lifecycleRev: pin?.lifecycleRev ?? null,
      },
      classification: {
        taskClass: /** @type {Record<string, unknown>} */ (classification || {}).taskClass ?? null,
        disposition:
          /** @type {Record<string, unknown>} */ (classification || {}).disposition ?? null,
      },
      health: health
        ? {
            status: health.status ?? (health.ok ? 'ok' : 'unknown'),
            deployedSha: health.deployedSha ?? health.release?.sha ?? null,
            schemaVersion:
              health.schema?.version ?? health.schemaVersion ?? health.schema_version ?? null,
          }
        : null,
      loop: [
        'get_board_hash',
        'get_next',
        'get_task',
        'register_run (fresh envelope + collisionScopeLockIds from plan)',
        'heartbeat_run <=15s',
        'submit_stage_evidence (only with valid classification + receipt)',
        'terminate_run SUCCEEDED|FAILED|CANCELLED',
      ],
      bans: [
        'Do not fabricate NEXT outside active_dispatch_plan',
        'Do not advance UNCLASSIFIED/SYNTH tasks',
        'Do not publish_dispatch_plan as AGENT (ROOT only)',
        'Do not touch production without separate approval',
        'Do not print bearer/tokens/env secrets',
      ],
    }
  }

  return {
    status: ready ? HANDOFF_STATUS.READY : HANDOFF_STATUS.NOT_READY,
    ready,
    refuseCodes: uniqueCodes,
    reasons,
    selected,
    productDenominator,
    planId,
    soleSource,
    boardId,
    pin,
    agentContract,
  }
}

/**
 * Render human-readable handoff text (stdout / optional external write).
 * Never embeds secrets.
 * @param {ReturnType<typeof evaluateAgentReadySurfaces>} evaluation
 * @param {{ generatedAt?: string, mode?: string, sourceNote?: string }} [meta]
 */
export function renderHandoffText(evaluation, meta = {}) {
  const generatedAt = meta.generatedAt ?? new Date().toISOString()
  const mode = meta.mode ?? 'unknown'
  const lines = []

  lines.push('# TASK MANAGER — MFS REBUILD AGENT READY HANDOFF')
  lines.push(`# generator: ${GENERATOR_ID}`)
  lines.push(`# generatedAt: ${generatedAt}`)
  lines.push(`# mode: ${mode}`)
  if (meta.sourceNote) lines.push(`# source: ${meta.sourceNote}`)
  lines.push('# Jangan print/copy token atau isi env.')
  lines.push('')
  lines.push(`STATUS: ${evaluation.status}`)
  lines.push(`boardId: ${evaluation.boardId}`)
  lines.push(
    `productDenominator: ${evaluation.productDenominator == null ? 'missing' : evaluation.productDenominator}`,
  )
  lines.push(`planId: ${evaluation.planId ?? 'null'}`)
  lines.push(`soleSource: ${evaluation.soleSource ?? 'null'}`)
  lines.push('')

  if (!evaluation.ready) {
    lines.push('## NOT READY — FAIL-CLOSED (do not start product work)')
    lines.push('Refuse codes:')
    for (const c of evaluation.refuseCodes) {
      lines.push(`- ${c}`)
    }
    lines.push('')
    lines.push('Reasons:')
    for (const r of evaluation.reasons) {
      lines.push(`- ${r}`)
    }
    lines.push('')
    lines.push('Rules:')
    lines.push('- JANGAN mulai mengubah source MFS berdasarkan task SYNTH / task-next-* / UNCLASSIFIED.')
    lines.push('- Connect/verify control-plane boleh; product work menunggu ROOT plan non-SYNTH + PRODUCT class.')
    lines.push('- productDenominator=0 ⇒ readiness never authorizes start.')
    lines.push('- Stale pin / missing real NEXT ⇒ re-query; never invent plan membership.')
    lines.push('')
    lines.push('Checklist before any product mutation:')
    lines.push('[ ] authenticated healthz + pin complete (non-synth)')
    lines.push('[ ] get_overview productDenominator > 0')
    lines.push('[ ] get_next soleSource=active_dispatch_plan with non-SYNTH taskId')
    lines.push('[ ] get_task classification PRODUCT (not UNCLASSIFIED)')
    lines.push('[ ] plan expectedBoardRev matches live boardRev')
    lines.push('[ ] then register_run → heartbeat → evidence → terminate')
    lines.push('')
    lines.push('# end')
    return lines.join('\n') + '\n'
  }

  const c = evaluation.agentContract
  lines.push('## READY — authorized non-SYNTH start packet')
  lines.push('Anda BOLEH mulai kerja produk HANYA untuk item plan di bawah (active_dispatch_plan).')
  lines.push('')
  lines.push('SELECTED TASK / GATE / AGENT CONTRACT')
  lines.push(`- taskId: ${c.taskId}`)
  lines.push(`- targetGate: ${c.targetGate}`)
  lines.push(`- role: ${c.role}`)
  lines.push(`- rank: ${c.rank}`)
  lines.push(`- planId: ${c.planId}`)
  lines.push(`- planVersion: ${c.planVersion}`)
  lines.push(`- planHash: ${c.planHash}`)
  lines.push(`- selectionReason: ${c.selectionReason}`)
  lines.push(`- priorityPortfolioId: ${c.priorityPortfolioId}`)
  lines.push(`- expectedEntityRev: ${c.expectedEntityRev}`)
  lines.push(`- expectedBoardRev: ${c.expectedBoardRev}`)
  lines.push(
    `- collisionScopeLockIds: ${JSON.stringify(c.collisionScopeLockIds)}`,
  )
  lines.push(
    `- classification: ${c.classification.taskClass}/${c.classification.disposition}`,
  )
  lines.push(`- productDenominator: ${c.productDenominator}`)
  lines.push(
    `- pin: snap=${c.pin.canonicalSnapshotId} boardRev=${c.pin.boardRev} lifecycleRev=${c.pin.lifecycleRev}`,
  )
  lines.push(
    `- pin.canonicalHash: ${c.pin.canonicalHash}`,
  )
  if (c.health) {
    lines.push(
      `- health: status=${c.health.status} sha=${c.health.deployedSha ?? 'n/a'} schema=${c.health.schemaVersion ?? 'n/a'}`,
    )
  }
  lines.push('')
  lines.push('LOOP')
  for (const step of c.loop) lines.push(`- ${step}`)
  lines.push('')
  lines.push('BANS')
  for (const ban of c.bans) lines.push(`- ${ban}`)
  lines.push('')
  lines.push('STALE HANDLING')
  lines.push('- Before every mutation: reread boardRev / entityRev / canonicalHash.')
  lines.push('- STALE_REVISION → reread and rebuild request; never replay stale body.')
  lines.push('- Same idempotency key + same body may replay; changed body = IDEMPOTENCY_CONFLICT.')
  lines.push('')
  lines.push('# end')
  return lines.join('\n') + '\n'
}

// ---------------------------------------------------------------------------
// Self-test fixtures (inline — no extra fixture files required)
// ---------------------------------------------------------------------------

export function buildSelfTestFixtures(nowMs = Date.now()) {
  const livePin = {
    canonicalSnapshotId: 'canonical-mfs-rebuild-prod-snap-001',
    canonicalHash: 'a'.repeat(64),
    boardRev: 42,
    lifecycleRev: 9,
  }

  const synthPin = {
    canonicalSnapshotId: 'synth-c3-r2d-snap-001',
    canonicalHash: 'b'.repeat(64),
    boardRev: 7,
    lifecycleRev: 1,
  }

  const productTask = {
    taskId: 'T-AFF-001',
    classification: { taskClass: 'PRODUCT', disposition: 'ACTIVE' },
  }

  const unclassifiedTask = {
    taskId: 'T-AFF-001',
    classification: { taskClass: 'UNCLASSIFIED', disposition: 'UNCLASSIFIED' },
  }

  const realNextItem = {
    rank: 1,
    taskId: 'T-AFF-001',
    targetGate: 'SPEC_READY',
    role: 'Worker',
    selectionReason: 'ROOT frontier: real MFS affiliation work',
    priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
    planId: 'plan-mfs-real-001',
    planVersion: 3,
    planHash: 'c'.repeat(64),
    expectedEntityRev: 2,
    expectedBoardRev: 42,
    collisionScopeLockIds: ['scope:T-AFF-001'],
  }

  const synthNextItem = {
    rank: 1,
    taskId: 'task-next-1',
    targetGate: 'SPEC_READY',
    role: 'Worker',
    selectionReason: 'SYNTH: root dispatch selected NEXT candidate',
    priorityPortfolioId: 'SALES_WEB_RELATED_BACKEND',
    planId: 'plan-synth-stg-smoke-1',
    planVersion: 1,
    planHash: 'd'.repeat(64),
    expectedEntityRev: 0,
    expectedBoardRev: 7,
    collisionScopeLockIds: ['scope:task-next-1'],
  }

  return {
    /** Authorized READY path */
    ready: {
      boardId: 'mfs-rebuild',
      pin: livePin,
      overview: { productDenominator: 3, boardRollup: { productDenominator: 3 } },
      next: {
        selectedForNextDispatch: [realNextItem],
        planId: realNextItem.planId,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      task: productTask,
      health: { ok: true, status: 'ok', deployedSha: 'e'.repeat(40), schema: { version: '006' } },
      nowMs,
    },
    productDenominator0: {
      boardId: 'mfs-rebuild',
      pin: livePin,
      overview: { productDenominator: 0 },
      next: {
        selectedForNextDispatch: [realNextItem],
        planId: realNextItem.planId,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      task: productTask,
      health: { ok: true, status: 'ok' },
      nowMs,
    },
    synthNext: {
      boardId: 'mfs-rebuild',
      pin: synthPin,
      overview: { productDenominator: 0 },
      next: {
        selectedForNextDispatch: [synthNextItem],
        planId: synthNextItem.planId,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      task: {
        taskId: 'task-next-1',
        classification: { taskClass: 'UNCLASSIFIED', disposition: 'UNCLASSIFIED' },
      },
      health: { ok: true, status: 'ok' },
      nowMs,
    },
    unclassified: {
      boardId: 'mfs-rebuild',
      pin: livePin,
      overview: { productDenominator: 2 },
      next: {
        selectedForNextDispatch: [realNextItem],
        planId: realNextItem.planId,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      task: unclassifiedTask,
      health: { ok: true, status: 'ok' },
      nowMs,
    },
    noNext: {
      boardId: 'mfs-rebuild',
      pin: livePin,
      overview: { productDenominator: 2 },
      next: {
        selectedForNextDispatch: [],
        planId: null,
        blockedReason: 'NO_ACTIVE_PLAN',
        soleSource: 'active_dispatch_plan',
      },
      task: null,
      health: { ok: true, status: 'ok' },
      nowMs,
    },
    stale: {
      boardId: 'mfs-rebuild',
      pin: { ...livePin, boardRev: 99 },
      overview: { productDenominator: 2 },
      next: {
        selectedForNextDispatch: [{ ...realNextItem, expectedBoardRev: 42 }],
        planId: realNextItem.planId,
        blockedReason: null,
        soleSource: 'active_dispatch_plan',
      },
      task: productTask,
      health: { ok: true, status: 'ok' },
      nowMs,
    },
  }
}

/**
 * Run pure self-tests. Returns { ok, results[] }.
 */
export function runSelfTests() {
  const fixtures = buildSelfTestFixtures()
  /** @type {Array<{ id: string, ok: boolean, detail?: string }>} */
  const results = []

  function check(id, ok, detail = '') {
    results.push({ id, ok, detail })
  }

  // READY
  {
    const e = evaluateAgentReadySurfaces(fixtures.ready)
    check('ready_status', e.ready === true && e.status === HANDOFF_STATUS.READY, e.refuseCodes.join(','))
    check('ready_task', e.agentContract?.taskId === 'T-AFF-001')
    check('ready_gate', e.agentContract?.targetGate === 'SPEC_READY')
    check('ready_no_refuse', e.refuseCodes.length === 0)
    const text = renderHandoffText(e, { mode: 'self-test' })
    check('ready_text_status', text.includes('STATUS: READY'))
    check('ready_text_task', text.includes('T-AFF-001'))
    check('ready_text_no_secret_keys', !/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text))
  }

  // productDenominator0
  {
    const e = evaluateAgentReadySurfaces(fixtures.productDenominator0)
    check('denom0_not_ready', e.ready === false && e.status === HANDOFF_STATUS.NOT_READY)
    check(
      'denom0_code',
      e.refuseCodes.includes(REFUSE_CODE.PRODUCT_DENOMINATOR_ZERO),
      e.refuseCodes.join(','),
    )
  }

  // SYNTH
  {
    const e = evaluateAgentReadySurfaces(fixtures.synthNext)
    check('synth_not_ready', e.ready === false)
    check('synth_code', e.refuseCodes.includes(REFUSE_CODE.SYNTH_PLAN_OR_TASK), e.refuseCodes.join(','))
    check('synth_pin', e.refuseCodes.includes(REFUSE_CODE.PIN_SYNTHETIC), e.refuseCodes.join(','))
    const text = renderHandoffText(e, { mode: 'self-test' })
    check('synth_text_not_ready', text.includes('STATUS: NOT READY'))
    check('synth_text_no_start_packet_task_as_ready', !text.includes('STATUS: READY'))
  }

  // UNCLASSIFIED
  {
    const e = evaluateAgentReadySurfaces(fixtures.unclassified)
    check('unclass_not_ready', e.ready === false)
    check('unclass_code', e.refuseCodes.includes(REFUSE_CODE.UNCLASSIFIED), e.refuseCodes.join(','))
  }

  // no NEXT
  {
    const e = evaluateAgentReadySurfaces(fixtures.noNext)
    check('nonext_not_ready', e.ready === false)
    check('nonext_code', e.refuseCodes.includes(REFUSE_CODE.NO_REAL_NEXT), e.refuseCodes.join(','))
  }

  // stale
  {
    const e = evaluateAgentReadySurfaces(fixtures.stale)
    check('stale_not_ready', e.ready === false)
    check('stale_code', e.refuseCodes.includes(REFUSE_CODE.STALE_PIN), e.refuseCodes.join(','))
  }

  // external write gate pure
  {
    const denied = assertExternalWriteAllowed({
      write: true,
      approve: false,
      outPath: DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: {},
    })
    check('write_denied_without_approve', denied.ok === false && denied.code === REFUSE_CODE.EXTERNAL_WRITE_DENIED)

    const allowed = assertExternalWriteAllowed({
      write: true,
      approve: true,
      outPath: DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: {},
    })
    check('write_allowed_with_approve', allowed.ok === true)

    const noWrite = assertExternalWriteAllowed({
      write: false,
      approve: true,
      outPath: DEFAULT_EXTERNAL_HANDOFF_PATH,
      env: {},
    })
    check('write_flag_required', noWrite.ok === false)
  }

  // identity helpers
  check('id_task_next', isSyntheticIdentity('task-next-1') === true)
  check('id_real_task', isSyntheticIdentity('T-AFF-001') === false)
  check('id_synth_plan', isSyntheticIdentity('plan-synth-stg-smoke-1') === true)

  const ok = results.every((r) => r.ok)
  return { ok, results }
}

/**
 * External write requires BOTH --write and explicit approval.
 * Path must resolve to the owner Downloads handoff (or HANDOFF_OUT_PATH override
 * that still ends with TASK_MANAGER_MFS_REBUILD_AGENT_READY.txt).
 *
 * @param {{ write: boolean, approve: boolean, outPath: string, env?: NodeJS.ProcessEnv }} opts
 */
export function assertExternalWriteAllowed(opts) {
  const env = opts.env ?? process.env
  const approve =
    opts.approve === true ||
    env.HANDOFF_EXTERNAL_WRITE_APPROVED === '1' ||
    env.HANDOFF_EXTERNAL_WRITE_APPROVED === 'true'
  if (!opts.write) {
    return {
      ok: false,
      code: REFUSE_CODE.EXTERNAL_WRITE_DENIED,
      reason: 'external write requires --write (default is stdout only)',
    }
  }
  if (!approve) {
    return {
      ok: false,
      code: REFUSE_CODE.EXTERNAL_WRITE_DENIED,
      reason:
        'external write requires --approve-external-write or HANDOFF_EXTERNAL_WRITE_APPROVED=1',
    }
  }
  const resolved = pathResolve(opts.outPath)
  const allowedDefault = pathResolve(DEFAULT_EXTERNAL_HANDOFF_PATH)
  const baseName = resolved.split(/[/\\]/).pop()
  if (resolved !== allowedDefault && baseName !== 'TASK_MANAGER_MFS_REBUILD_AGENT_READY.txt') {
    return {
      ok: false,
      code: REFUSE_CODE.EXTERNAL_WRITE_DENIED,
      reason: `refusing path outside owner handoff contract: ${resolved}`,
    }
  }
  return { ok: true, path: resolved }
}

// ---------------------------------------------------------------------------
// Live/query (read-only) — imports existing bootstrap helpers (no helper edits)
// ---------------------------------------------------------------------------

async function loadBootstrap() {
  const url = pathToFileURL(join(ROOT, 'qa/e2e/lib/control-plane-bootstrap.mjs')).href
  return import(url)
}

async function loadSmokeLib() {
  const url = pathToFileURL(join(ROOT, 'qa/e2e/lib/staging-agent-smoke.mjs')).href
  return import(url)
}

async function loadEnvLib() {
  const url = pathToFileURL(join(ROOT, 'qa/e2e/lib/env.mjs')).href
  return import(url)
}

/**
 * Query authenticated pinned surfaces (read-only). Never mutates.
 * @param {{ baseUrl: string, boardId: string, bearer: string, fetchImpl?: typeof fetch }} opts
 */
export async function queryPinnedSurfaces(opts) {
  const { mcpToolsCall, probeRuntimePin, isMcpToolProgrammaticOk } = await loadBootstrap()
  const baseUrl = String(opts.baseUrl).replace(/\/$/, '')
  const boardId = opts.boardId
  const bearer = opts.bearer
  const fetchImpl = opts.fetchImpl
  const secrets = bearer ? [bearer] : []

  const healthPin = await probeRuntimePin(baseUrl, { bearer, fetchImpl, secrets })

  const boardHash = await mcpToolsCall(
    baseUrl,
    'get_board_hash',
    { boardId },
    { bearer, fetchImpl, secrets },
  )
  const overview = await mcpToolsCall(
    baseUrl,
    'get_overview',
    { boardId },
    { bearer, fetchImpl, secrets },
  )
  const next = await mcpToolsCall(baseUrl, 'get_next', { boardId }, { bearer, fetchImpl, secrets })

  const nextJson = next.toolJson && typeof next.toolJson === 'object' ? next.toolJson : null
  const selected = extractSelectedNext(nextJson)
  const taskId = selected[0]?.taskId ? String(selected[0].taskId) : null

  let task = null
  let taskCall = null
  if (taskId) {
    taskCall = await mcpToolsCall(
      baseUrl,
      'get_task',
      { boardId, taskId },
      { bearer, fetchImpl, secrets },
    )
    task = taskCall.toolJson && typeof taskCall.toolJson === 'object' ? taskCall.toolJson : null
    // unwrap common envelopes
    if (task?.task && typeof task.task === 'object') task = task.task
    if (task?.data && typeof task.data === 'object' && task.data.taskId) task = task.data
  }

  const overviewJson =
    overview.toolJson && typeof overview.toolJson === 'object' ? overview.toolJson : null

  const pin = {
    canonicalSnapshotId:
      healthPin.canonicalSnapshotId ??
      overviewJson?.pin?.canonicalSnapshotId ??
      overviewJson?.canonicalSnapshotId ??
      boardHash.toolJson?.canonicalSnapshotId ??
      null,
    canonicalHash:
      healthPin.canonicalHash ??
      overviewJson?.pin?.canonicalHash ??
      overviewJson?.canonicalHash ??
      boardHash.toolJson?.canonicalHash ??
      boardHash.toolJson?.hash ??
      null,
    boardRev:
      healthPin.boardRev ??
      overviewJson?.pin?.boardRev ??
      overviewJson?.boardRev ??
      boardHash.toolJson?.boardRev ??
      null,
    lifecycleRev:
      healthPin.lifecycleRev ??
      overviewJson?.pin?.lifecycleRev ??
      overviewJson?.lifecycleRev ??
      null,
  }

  const health = {
    ok: healthPin.ok === true,
    status: healthPin.ok ? 'ok' : 'error',
    httpStatus: healthPin.httpStatus ?? null,
    deployedSha: null,
    schema: null,
    rawSlice: healthPin.rawSlice ?? null,
  }

  // Optional health body fields if present in rawSlice JSON
  if (healthPin.rawSlice) {
    try {
      const body = JSON.parse(healthPin.rawSlice)
      health.deployedSha =
        body?.deployedSha ?? body?.release?.sha ?? body?.observed?.deployedSha ?? null
      health.schema = body?.schema ?? null
      health.schemaVersion = body?.schema?.version ?? body?.schemaVersion ?? null
      if (body?.status) health.status = body.status
    } catch {
      /* ignore */
    }
  }

  const callsOk = {
    boardHash: isMcpToolProgrammaticOk(boardHash) || boardHash.ok,
    overview: isMcpToolProgrammaticOk(overview) || overview.ok,
    next: isMcpToolProgrammaticOk(next) || next.ok,
    task: taskId ? isMcpToolProgrammaticOk(taskCall) || taskCall?.ok : true,
  }

  return {
    boardId,
    pin,
    overview: overviewJson,
    next: nextJson,
    task,
    health,
    callsOk,
    queryErrors: [
      !callsOk.boardHash ? 'get_board_hash failed' : null,
      !callsOk.overview ? 'get_overview failed' : null,
      !callsOk.next ? 'get_next failed' : null,
      taskId && !callsOk.task ? `get_task failed for ${taskId}` : null,
    ].filter(Boolean),
  }
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const getVal = (name) => {
    const i = argv.indexOf(name)
    if (i >= 0 && argv[i + 1] && !argv[i + 1].startsWith('--')) return argv[i + 1]
    return null
  }
  const hasQuery = flags.has('--query') || flags.has('--live')
  const hasWrite = flags.has('--write')
  const hasSelf =
    flags.has('--self-test') ||
    flags.has('--contract') ||
    (!hasQuery && !hasWrite && !flags.has('--help') && !flags.has('-h'))
  return {
    selfTest: hasSelf || (!hasQuery && !hasWrite),
    query: hasQuery,
    write: hasWrite,
    approveExternalWrite: flags.has('--approve-external-write'),
    help: flags.has('--help') || flags.has('-h'),
    outPath: getVal('--out') || process.env.HANDOFF_OUT_PATH || DEFAULT_EXTERNAL_HANDOFF_PATH,
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/generate-agent-ready-handoff.mjs --self-test
  node qa/e2e/flows/generate-agent-ready-handoff.mjs --query
  node qa/e2e/flows/generate-agent-ready-handoff.mjs --query --write --approve-external-write

Fail-closed: refuses SYNTH / UNCLASSIFIED / productDenominator=0 / stale / no real NEXT.
Default output: stdout only. External Downloads write requires --write + --approve-external-write
(or HANDOFF_EXTERNAL_WRITE_APPROVED=1). Credentials never printed.
`)
}

function writeRuntimeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `agent-ready-handoff-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text) || /"bearer"\s*:/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parseArgs(argv)
  if (args.help) {
    printHelp()
    return { exitCode: 0, mode: 'help' }
  }

  if (args.selfTest && !args.query) {
    console.log(
      `OWNER_TARGET: ${JSON.stringify({
        base_url: 'mock://self-test',
        port: 'n/a',
        account: 'SYNTH_SELF_TEST',
        device: 'n/a-handoff-generator',
        boardId: 'mfs-rebuild',
        generator: GENERATOR_ID,
      })}`,
    )
    const suite = runSelfTests()
    for (const r of suite.results) {
      console.log(`[${r.ok ? 'PASS' : 'FAIL'}] ${r.id}${r.detail ? ` — ${r.detail}` : ''}`)
    }
    // Emit sample NOT READY + READY texts (stdout) as contract proof
    const fixtures = buildSelfTestFixtures()
    const notReadyEval = evaluateAgentReadySurfaces(fixtures.synthNext)
    const readyEval = evaluateAgentReadySurfaces(fixtures.ready)
    console.log('\n--- sample NOT READY (synth fixture) ---')
    console.log(renderHandoffText(notReadyEval, { mode: 'self-test', sourceNote: 'fixture:synthNext' }))
    console.log('--- sample READY (authorized non-SYNTH fixture) ---')
    console.log(renderHandoffText(readyEval, { mode: 'self-test', sourceNote: 'fixture:ready' }))

    const receipt = writeRuntimeReceipt({
      ok: suite.ok,
      mode: 'self-test',
      generator: GENERATOR_ID,
      passCount: suite.results.filter((r) => r.ok).length,
      failCount: suite.results.filter((r) => !r.ok).length,
      results: suite.results,
      externalWrite: 'not-attempted',
    })
    console.log(
      JSON.stringify(
        {
          ok: suite.ok,
          mode: 'self-test',
          passCount: suite.results.filter((r) => r.ok).length,
          failCount: suite.results.filter((r) => !r.ok).length,
          receipt,
        },
        null,
        2,
      ),
    )
    return { exitCode: suite.ok ? 0 : 1, mode: 'self-test', suite }
  }

  // Query path (optionally + write)
  const envLib = await loadEnvLib()
  const smoke = await loadSmokeLib()
  const baseUrl = envLib.resolveStagingUrl()
  const boardId = envLib.resolveBoardId('mfs-rebuild')
  const token = smoke.resolveAuthorizedTokenRef(env)

  console.log(
    `OWNER_TARGET: ${JSON.stringify({
      base_url: baseUrl,
      port: 'n/a',
      account: token.meta?.tokenRef ? `env:${token.meta.tokenRef}` : 'missing-bearer',
      device: 'n/a-handoff-generator',
      boardId,
      generator: GENERATOR_ID,
      mode: 'query',
    })}`,
  )

  if (!token.ok || !token.bearer) {
    const text = renderHandoffText(
      {
        status: HANDOFF_STATUS.NOT_READY,
        ready: false,
        refuseCodes: [REFUSE_CODE.QUERY_FAILED],
        reasons: [token.reason || 'missing authorized bearer for pinned query'],
        selected: null,
        productDenominator: null,
        planId: null,
        soleSource: null,
        boardId,
        pin: null,
        agentContract: null,
      },
      { mode: 'query', sourceNote: 'auth-missing' },
    )
    console.log(text)
    const receipt = writeRuntimeReceipt({
      ok: false,
      mode: 'query',
      generator: GENERATOR_ID,
      error: 'MISSING_BEARER',
      externalWrite: 'not-attempted',
    })
    return { exitCode: 1, mode: 'query', receipt, text }
  }

  let surfaces
  try {
    surfaces = await queryPinnedSurfaces({
      baseUrl,
      boardId,
      bearer: token.bearer,
    })
  } catch (e) {
    const msg = String(e?.message || e)
    const text = renderHandoffText(
      {
        status: HANDOFF_STATUS.NOT_READY,
        ready: false,
        refuseCodes: [REFUSE_CODE.QUERY_FAILED],
        reasons: [`query threw: ${msg}`],
        selected: null,
        productDenominator: null,
        planId: null,
        soleSource: null,
        boardId,
        pin: null,
        agentContract: null,
      },
      { mode: 'query', sourceNote: 'query-error' },
    )
    console.log(text)
    return { exitCode: 1, mode: 'query', error: msg, text }
  }

  if (surfaces.queryErrors?.length) {
    // still evaluate what we got (fail-closed), but include query errors
    surfaces.health = surfaces.health || { ok: false }
  }

  const evaluation = evaluateAgentReadySurfaces(surfaces)
  if (surfaces.queryErrors?.length) {
    evaluation.ready = false
    evaluation.status = HANDOFF_STATUS.NOT_READY
    if (!evaluation.refuseCodes.includes(REFUSE_CODE.QUERY_FAILED)) {
      evaluation.refuseCodes.push(REFUSE_CODE.QUERY_FAILED)
    }
    for (const qe of surfaces.queryErrors) evaluation.reasons.push(qe)
  }

  const text = renderHandoffText(evaluation, {
    mode: 'query',
    sourceNote: `STAGING_URL board=${boardId}`,
  })
  console.log(text)

  /** @type {string|null} */
  let writtenPath = null
  if (args.write) {
    const gate = assertExternalWriteAllowed({
      write: true,
      approve: args.approveExternalWrite,
      outPath: args.outPath,
      env,
    })
    if (!gate.ok) {
      console.error(`EXTERNAL_WRITE_DENIED: ${gate.reason}`)
      writeRuntimeReceipt({
        ok: false,
        mode: 'query+write-denied',
        generator: GENERATOR_ID,
        evaluation: {
          status: evaluation.status,
          ready: evaluation.ready,
          refuseCodes: evaluation.refuseCodes,
          reasons: evaluation.reasons,
          productDenominator: evaluation.productDenominator,
          planId: evaluation.planId,
          selectedTaskId: evaluation.selected?.taskId ?? null,
        },
        externalWrite: gate,
      })
      return { exitCode: 1, mode: 'query', evaluation, text, writeDenied: gate }
    }
    writeFileSync(gate.path, text, { encoding: 'utf8', mode: 0o644 })
    writtenPath = gate.path
    console.log(`WROTE: ${writtenPath} bytes=${Buffer.byteLength(text, 'utf8')}`)
  } else {
    console.log('EXTERNAL_WRITE: skipped (stdout only; pass --write --approve-external-write to write Downloads)')
  }

  const receipt = writeRuntimeReceipt({
    ok: true,
    mode: args.write ? 'query+write' : 'query',
    generator: GENERATOR_ID,
    evaluation: {
      status: evaluation.status,
      ready: evaluation.ready,
      refuseCodes: evaluation.refuseCodes,
      reasons: evaluation.reasons,
      productDenominator: evaluation.productDenominator,
      planId: evaluation.planId,
      selectedTaskId: evaluation.selected?.taskId ?? null,
      soleSource: evaluation.soleSource,
    },
    pin: evaluation.pin,
    writtenPath,
    // never store bearer
    tokenRef: token.meta?.tokenRef ?? null,
  })

  // Exit 0 for successful query+render even when NOT READY (honest fail-closed is success).
  // Exit 1 only on query/auth/write failures.
  return {
    exitCode: 0,
    mode: args.write ? 'query+write' : 'query',
    evaluation,
    text,
    writtenPath,
    receipt,
  }
}

const isMain =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === pathResolve(process.argv[1])

if (isMain) {
  main()
    .then((r) => {
      process.exit(typeof r?.exitCode === 'number' ? r.exitCode : 0)
    })
    .catch((e) => {
      console.error('FATAL:', String(e?.stack || e))
      process.exit(2)
    })
}
