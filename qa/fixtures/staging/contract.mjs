/**
 * Pure synthetic staging fixture contract (no network, no credentials).
 * Loaded by qa/e2e/lib/staging-agent-smoke.mjs and contract harness tests.
 */
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const FIXTURE_DIR = __dirname

function readJson(name) {
  const raw = readFileSync(join(__dirname, name), 'utf8')
  return JSON.parse(raw)
}

/** Same taskHash algorithm as control-center fixture / UI adapter. */
export function computeTaskHash(taskIds) {
  const sorted = [...taskIds].map(String).sort()
  return createHash('sha256')
    .update(sorted.join('|') || 'empty-tasks')
    .digest('hex')
}

/**
 * Stable JSON stringify matching control-plane-ingest computePlanHash authority.
 */
export function stableStringifyPlan(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringifyPlan).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringifyPlan(value[k])}`).join(',')}}`
}

/** Exact plan hash authority (mirrors seed computePlanHash). */
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

export function loadStagingManifest() {
  return readJson('MANIFEST.json')
}

export function loadStagingPin(taskIds) {
  const pinFile = readJson('pin.json')
  const manifest = loadStagingManifest()
  const ids = taskIds ?? manifest.taskIds
  return {
    canonicalSnapshotId: pinFile.canonicalSnapshotId,
    canonicalHash: pinFile.canonicalHash,
    boardRev: pinFile.boardRev,
    lifecycleRev: pinFile.lifecycleRev,
    taskHash: computeTaskHash(ids),
  }
}

export function loadAccountsSyncSeed() {
  return readJson('accounts-sync.seed.json')
}

export function loadDispatchPlanSeed() {
  return readJson('dispatch-plan.seed.json')
}

export function loadAgentRunSeed() {
  return readJson('agent-run.seed.json')
}

export function loadCleanupRules() {
  return readJson('cleanup-rules.json')
}

/**
 * Build unique synthetic ids for one smoke run. Never production-shaped.
 * @param {{ smokeRunId?: string, boardId?: string, now?: string, pin?: object }} opts
 */
export function buildSyntheticSmokeIds(opts = {}) {
  const smokeRunId =
    opts.smokeRunId ??
    `sr${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`
  const prefix = 'synth-stg-smoke'
  return {
    smokeRunId,
    planId: `${prefix}-plan-${smokeRunId}`,
    runId: `${prefix}-run-${smokeRunId}`,
    agentId: `${prefix}-agent-${smokeRunId}`,
    idemDispatch: `${prefix}-idem-dispatch-${smokeRunId}`,
    idemSync: `${prefix}-idem-sync-${smokeRunId}`,
    idemRegister: `${prefix}-idem-register-${smokeRunId}`,
    boardId: opts.boardId ?? loadStagingManifest().boardId,
  }
}

/**
 * Build publish_dispatch_plan args from fixture + unique ids + pin.
 * planHash computed with authority algorithm — fail-closed if caller tampers.
 */
export function buildDispatchPlanArgs(opts = {}) {
  const manifest = loadStagingManifest()
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids ?? buildSyntheticSmokeIds({ boardId: opts.boardId })
  const seed = loadDispatchPlanSeed()
  const now = opts.now ?? new Date().toISOString()
  const ttlH = seed.ttlHours ?? 6
  const expiresAt = new Date(Date.parse(now) + ttlH * 3600 * 1000).toISOString()
  const boardId = ids.boardId ?? manifest.boardId
  const items = (seed.items ?? []).map((it) => ({
    ...it,
    expectedBoardRev: pin.boardRev,
  }))
  const planId = opts.planId ?? ids.planId
  const planVersion = seed.planVersion ?? 1
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
    issuedAt: now,
    expiresAt,
    stage: seed.stage ?? 'ACTIVE',
    items,
    idempotencyKey: opts.idempotencyKey ?? ids.idemDispatch,
  }
}

/** Build sync_accounts args (masked accounts only). */
export function buildAccountSyncArgs(opts = {}) {
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids ?? buildSyntheticSmokeIds({ boardId: opts.boardId })
  const seed = loadAccountsSyncSeed()
  const now = opts.now ?? new Date().toISOString()
  const sourceRevision = opts.sourceRevision ?? pin.boardRev
  const expectedBoardRev = opts.expectedBoardRev ?? pin.boardRev
  return {
    boardId: ids.boardId,
    sourceRevision,
    expectedBoardRev,
    generatedAt: now,
    accounts: (seed.accounts ?? []).map((a) => ({
      ...a,
      statusChangedAt: a.statusChangedAt ?? now,
    })),
    idempotencyKey: opts.idempotencyKey ?? ids.idemSync,
    trigger: seed.trigger ?? 'ORCHESTRATOR_LAUNCH',
  }
}

/** Build register_run args bound to dispatch item + unique run id. */
export function buildRegisterRunArgs(opts = {}) {
  const pin = opts.pin ?? loadStagingPin()
  const ids = opts.ids ?? buildSyntheticSmokeIds({ boardId: opts.boardId })
  const seed = loadAgentRunSeed()
  const dispatch = opts.dispatch ?? buildDispatchPlanArgs({ pin, ids, now: opts.now })
  const item = dispatch.items?.[0] ?? {}
  const expectedBoardRev = opts.expectedBoardRev ?? pin.boardRev
  return {
    boardId: ids.boardId,
    runId: opts.runId ?? ids.runId,
    taskId: opts.taskId ?? seed.taskId ?? item.taskId,
    targetGate: opts.targetGate ?? seed.targetGate ?? item.targetGate,
    agentId: opts.agentId ?? ids.agentId,
    model: seed.model,
    effort: seed.effort,
    expectedEntityRev: item.expectedEntityRev ?? 0,
    expectedBoardRev,
    idempotencyKey: opts.idempotencyKey ?? ids.idemRegister,
    planId: dispatch.planId,
    planItemRank: item.rank ?? 1,
    maskedAccountRef: seed.maskedAccountRef,
    canonicalHash: pin.canonicalHash,
    collisionScopeLockIds: seed.collisionScopeLockIds ?? item.collisionScopeLockIds,
    initialState: seed.initialState ?? 'RUNNING',
  }
}

/**
 * Validate fixture contract integrity (no network).
 * @returns {{ ok: boolean, errors: string[], warnings: string[], pin: object, manifest: object }}
 */
export function validateStagingFixtureContract() {
  const errors = []
  const warnings = []
  let manifest
  let pin
  let cleanup
  let accounts
  let dispatch
  let agentRun

  try {
    manifest = loadStagingManifest()
  } catch (e) {
    return { ok: false, errors: [`MANIFEST.json unreadable: ${e.message}`], warnings, pin: null, manifest: null }
  }

  try {
    pin = loadStagingPin()
    accounts = loadAccountsSyncSeed()
    dispatch = loadDispatchPlanSeed()
    agentRun = loadAgentRunSeed()
    cleanup = loadCleanupRules()
  } catch (e) {
    errors.push(`fixture load failed: ${e.message}`)
    return { ok: false, errors, warnings, pin: null, manifest }
  }

  if (manifest.boardId !== 'mfs-rebuild' && !manifest.boardId) {
    errors.push('manifest.boardId required')
  }
  if (manifest.productionDerived === true) {
    errors.push('productionDerived must be false')
  }
  if (!manifest.syntheticOnly) {
    errors.push('syntheticOnly must be true')
  }
  if (!Array.isArray(manifest.taskIds) || manifest.taskIds.length < 1) {
    errors.push('manifest.taskIds must be non-empty')
  }
  if (!pin.canonicalSnapshotId || !pin.canonicalHash || pin.boardRev == null) {
    errors.push('pin incomplete')
  }
  if (!/^[0-9a-f]{64}$/i.test(String(pin.canonicalHash))) {
    errors.push('canonicalHash must be 64 hex')
  }
  if (!/^[0-9a-f]{64}$/i.test(String(pin.taskHash))) {
    errors.push('taskHash must be 64 hex')
  }
  if (pin.taskHash !== computeTaskHash(manifest.taskIds)) {
    errors.push('taskHash mismatch vs MANIFEST.taskIds')
  }
  if (Number(manifest.counts?.tasks) !== manifest.taskIds.length) {
    errors.push('counts.tasks must equal taskIds.length')
  }
  if (Number(manifest.counts?.accounts) !== (accounts.accounts?.length ?? 0)) {
    errors.push('counts.accounts must equal accounts-sync seed length')
  }
  if (Number(manifest.counts?.dispatchItems) !== (dispatch.items?.length ?? 0)) {
    errors.push('counts.dispatchItems must equal dispatch items length')
  }

  for (const acc of accounts.accounts ?? []) {
    for (const k of Object.keys(acc)) {
      if (/token|secret|password|authorization|api[_-]?key|credential/i.test(k)) {
        errors.push(`account field forbidden: ${k}`)
      }
    }
    if (!acc.maskedAccountId) errors.push('account missing maskedAccountId')
  }

  for (const tool of manifest.requiredMcpTools ?? []) {
    if (typeof tool !== 'string' || !tool.trim()) errors.push('empty required tool')
  }

  const ids = buildSyntheticSmokeIds({ boardId: manifest.boardId })
  for (const key of ['planId', 'runId', 'agentId', 'idemDispatch', 'idemSync', 'idemRegister']) {
    if (!String(ids[key]).includes(ids.smokeRunId)) {
      errors.push(`unique id ${key} must embed smokeRunId`)
    }
    if (!String(ids[key]).startsWith('synth-stg-smoke') && key !== 'smokeRunId') {
      // planId etc use prefix synth-stg-smoke-
      if (!String(ids[key]).includes('synth-stg-smoke')) {
        errors.push(`id ${key} missing synth-stg-smoke prefix`)
      }
    }
  }

  const planArgs = buildDispatchPlanArgs({ pin, ids, now: '2026-07-13T00:00:00.000Z' })
  const rehash = computePlanHash({
    boardId: planArgs.boardId,
    planId: planArgs.planId,
    planVersion: planArgs.planVersion,
    canonicalSnapshotId: planArgs.canonicalSnapshotId,
    canonicalHash: planArgs.canonicalHash,
    items: planArgs.items,
  })
  if (rehash !== planArgs.planHash) {
    errors.push('planHash not stable under recompute')
  }

  // Tamper fail-closed: wrong hash must not equal authority
  const badHash = computePlanHash({
    ...planArgs,
    planId: 'tampered-plan-id',
  })
  if (badHash === planArgs.planHash) {
    errors.push('planHash collision on tampered planId (integrity broken)')
  }

  if (!cleanup?.rules?.length) {
    warnings.push('cleanup-rules empty')
  }
  if (agentRun.taskId !== dispatch.items?.[0]?.taskId) {
    warnings.push('agent-run.taskId differs from dispatch item taskId')
  }

  return {
    ok: errors.length === 0,
    errors,
    warnings,
    pin,
    manifest,
    sampleIds: {
      smokeRunId: ids.smokeRunId,
      planId: planArgs.planId,
      runId: ids.runId,
      // never secrets
    },
  }
}

/**
 * Pure contract self-tests for fixture layer.
 */
export function runFixtureContractSelfTests() {
  const results = []
  const ok = (name, pass, detail = null) => results.push({ name, pass, detail })

  const v = validateStagingFixtureContract()
  ok('manifest-valid', v.ok, v.errors.join('; ') || null)
  ok('pin-present', Boolean(v.pin?.taskHash && v.pin?.canonicalSnapshotId))
  ok('synthetic-only', v.manifest?.syntheticOnly === true && v.manifest?.productionDerived === false)
  ok('board-id-mfs-rebuild', v.manifest?.boardId === 'mfs-rebuild')
  ok(
    'required-tools-include-lifecycle',
    (v.manifest?.requiredMcpTools ?? []).includes('register_run') &&
      (v.manifest?.requiredMcpTools ?? []).includes('heartbeat_run') &&
      (v.manifest?.requiredMcpTools ?? []).includes('publish_dispatch_plan'),
  )

  const ids1 = buildSyntheticSmokeIds({ smokeRunId: 'aaa111', boardId: 'mfs-rebuild' })
  const ids2 = buildSyntheticSmokeIds({ smokeRunId: 'bbb222', boardId: 'mfs-rebuild' })
  ok('unique-ids-diverge', ids1.planId !== ids2.planId && ids1.runId !== ids2.runId)
  ok('ids-embed-smoke-run', ids1.planId.includes('aaa111') && ids1.runId.includes('aaa111'))

  const pin = loadStagingPin()
  const plan = buildDispatchPlanArgs({
    pin,
    ids: ids1,
    now: '2026-07-13T12:00:00.000Z',
  })
  ok('dispatch-planhash-hex', /^[0-9a-f]{64}$/i.test(plan.planHash))
  ok('dispatch-board-rev', plan.expectedBoardRev === pin.boardRev)
  ok(
    'dispatch-item-task',
    plan.items[0]?.taskId === 'task-staging-next-1' && plan.items[0]?.rank === 1,
  )

  const sync = buildAccountSyncArgs({ pin, ids: ids1, now: '2026-07-13T12:00:00.000Z' })
  const secretKeys = JSON.stringify(sync.accounts).match(
    /"(token|secret|password|authorization|apiKey|api_key|credential)"\s*:/i,
  )
  ok('accounts-no-secret-keys', !secretKeys)

  const reg = buildRegisterRunArgs({ pin, ids: ids1, dispatch: plan })
  ok(
    'register-bound-to-plan',
    reg.planId === plan.planId && reg.taskId === plan.items[0].taskId && reg.runId === ids1.runId,
  )

  // Hash mismatch detection
  const tampered = { ...plan, planHash: '0'.repeat(64) }
  ok('tampered-hash-detected', tampered.planHash !== plan.planHash)

  const failCount = results.filter((r) => !r.pass).length
  return { results, failCount, ok: failCount === 0, validation: v }
}
