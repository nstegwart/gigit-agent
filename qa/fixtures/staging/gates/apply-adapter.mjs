/**
 * Pure staging gate apply adapter (no network, no DB, no credentials).
 *
 * Transforms qa/fixtures/staging/gates/** into product-API-shaped mutation
 * envelopes for authenticated MCP/domain tools. NEVER:
 *   - fabricates stage evidence receipt hashes
 *   - fabricates G5 PASS
 *   - emits raw SQL execution
 *   - points at seed-synthetic board wipe
 *
 * Live mutation is owned by qa/e2e/flows/staging-gates-apply.mjs + seed-gates
 * dual-gate + CAIRN_GATES_BIND_LIVE_PIN=1 + optional CAIRN_GATES_EXECUTE=1.
 */
import { createHash, randomBytes } from 'node:crypto'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { readFileSync } from 'node:fs'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const ID_PREFIX = 'synth-gate-'
export const ADAPTER_ID = 'staging-gates-apply-adapter-v1'
export const G5_WRITE_UNSUPPORTED_CODE = 'G5_WRITE_UNSUPPORTED'
export const FORBIDDEN_BYPASS_PATHS = Object.freeze([
  'deploy/staging/scripts/seed-synthetic.mjs',
  'qa/e2e/fixtures/seed/seed-isolated.mjs#replaceBoardScopedSyntheticRows',
  'raw-sql-board-wipe',
  'hand-insert-control_plane_stage_evidence_receipts',
])

/** Dual staging gates + live pin bind (apply path). */
export const REQUIRED_APPLY_ENV = Object.freeze({
  CAIRN_ENV: 'staging',
  CAIRN_DB_NAME: 'cairn_tm_v3_staging',
  CAIRN_STAGING_SEED_APPROVED: '1',
  CAIRN_GATES_APPLY: '1',
  CAIRN_GATES_BIND_LIVE_PIN: '1',
})

function readJson(rel) {
  return JSON.parse(readFileSync(join(__dirname, rel), 'utf8'))
}

export function loadValidDistinctSeed() {
  return readJson('distinct/valid-import.seed.json')
}

export function loadDistinctRejectSeeds() {
  const names = [
    'dup-dependency.seed.json',
    'dup-fc.seed.json',
    'dup-node.seed.json',
    'dup-task-id.seed.json',
  ]
  return names.map((n) => ({ name: n, ...readJson(join('distinct', n)) }))
}

export function loadClassificationMatrix() {
  return readJson('classification/matrix.json')
}

export function loadLifecycleValid() {
  return readJson('lifecycle/mapping-valid.json')
}

export function loadLifecycleNegatives() {
  return readJson('lifecycle/negatives.json')
}

export function loadG5Domains() {
  return readJson('g5/domains.json')
}

export function loadCapacityMatrix() {
  return readJson('capacity/matrix.json')
}

export function loadPriorityMatrix() {
  return readJson('priority/matrix.json')
}

export function loadReconcilerPacket() {
  return readJson('reconciler/dry-run-apply.json')
}

export function loadCleanupRules() {
  return readJson('cleanup-rules.json')
}

export function loadFixturePin() {
  return readJson('pin.json')
}

export function loadManifest() {
  return readJson('MANIFEST.json')
}

export function loadSeedPolicy() {
  return readJson('seed-policy.json')
}

/**
 * Check dual staging gates + live pin bind. Pure — does not mutate.
 * @param {NodeJS.ProcessEnv|Record<string,string|undefined>} env
 */
export function checkApplyGates(env = process.env) {
  const missing = []
  for (const [k, v] of Object.entries(REQUIRED_APPLY_ENV)) {
    if (env[k] !== v) missing.push(`${k}=${v}`)
  }
  const policy = loadSeedPolicy()
  if (policy.productionDerived === true) {
    missing.push('productionDerived must be false for gate pack')
  }
  if (policy.syntheticOnly !== true) {
    missing.push('syntheticOnly must be true')
  }
  return {
    ok: missing.length === 0,
    missing,
    code: missing.length === 0 ? null : 'CAIRN_GATES_APPLY_REFUSED',
    message:
      missing.length === 0
        ? null
        : `Gate apply refused — missing/incorrect: ${missing.join(', ')}. Default is non-mutating plan/self-test.`,
    requiresLivePin: true,
    forbiddenBypass: FORBIDDEN_BYPASS_PATHS,
  }
}

/**
 * Unique idempotency key per step. Never reuses fixture static keys alone.
 * @param {{ expectedSha?: string, packHash?: string, step: string, salt?: string }} opts
 */
export function buildIdempotencyKey(opts) {
  const step = String(opts.step || 'unknown').replace(/[^a-zA-Z0-9._:-]/g, '_')
  const sha = (opts.expectedSha || 'nosha').slice(0, 40)
  const pack = (opts.packHash || 'nopack').slice(0, 16)
  const salt =
    opts.salt ||
    randomBytes(8).toString('hex') ||
    `${Date.now().toString(36)}`
  return `gates-apply:${sha}:${pack}:${step}:${salt}`
}

/**
 * Deterministic key for pure tests (no random).
 */
export function buildDeterministicIdempotencyKey(opts) {
  const step = String(opts.step || 'unknown').replace(/[^a-zA-Z0-9._:-]/g, '_')
  const sha = (opts.expectedSha || 'deadbeef').slice(0, 40)
  const pack = (opts.packHash || 'cafebabe').slice(0, 16)
  const salt = opts.salt || 'deterministic-salt'
  return `gates-apply:${sha}:${pack}:${step}:${salt}`
}

/**
 * Map distinct seed packet → CanonicalSnapshotInput shape (definition only).
 * Strips any lifecycle fields if present. Rebinds snapshotId when live run id given.
 *
 * @param {object} seed - distinct/*.seed.json body or { input }
 * @param {{ snapshotId?: string, sourceCommitSha?: string, generatedAt?: string }} [opts]
 */
export function distinctSeedToCanonicalInput(seed, opts = {}) {
  const input = seed?.input ?? seed
  if (!input || typeof input !== 'object') {
    throw Object.assign(new Error('distinct seed missing input'), {
      code: 'GATES_DISTINCT_SEED_INVALID',
    })
  }
  const tasks = (input.tasks ?? []).map((t) => {
    const clean = { ...t }
    for (const k of [
      'lifecycleStage',
      'lifecycle_stage',
      'stageEvidence',
      'evidenceReceipt',
      'implementerRun',
      'lifecycleHistory',
      'g5Pass',
      'lifecycleRev',
    ]) {
      delete clean[k]
    }
    return clean
  })
  for (const t of tasks) {
    if (!String(t.id || '').startsWith(ID_PREFIX)) {
      throw Object.assign(
        new Error(`task id not prefix-scoped: ${t.id}`),
        { code: 'GATES_PREFIX_VIOLATION', taskId: t.id },
      )
    }
  }
  for (const p of input.projects ?? []) {
    if (!String(p.id || '').startsWith(ID_PREFIX)) {
      throw Object.assign(
        new Error(`project id not prefix-scoped: ${p.id}`),
        { code: 'GATES_PREFIX_VIOLATION', projectId: p.id },
      )
    }
  }

  return {
    boardId: input.boardId || loadManifest().boardId,
    snapshotId: opts.snapshotId || input.snapshotId || `${ID_PREFIX}snap-distinct-valid`,
    sourceRepoId: input.sourceRepoId || 'repo/gigit-gate',
    sourceCommitSha: opts.sourceCommitSha || input.sourceCommitSha,
    generatedAt: opts.generatedAt || input.generatedAt || '2026-07-13T08:00:00.000Z',
    producerVersion: 'staging-gates-apply-adapter',
    projects: input.projects ?? [],
    flows: input.flows ?? [],
    nodes: input.nodes ?? [],
    tasks,
    dependencies: input.dependencies ?? [],
    featureContractJoins: input.featureContractJoins ?? [],
    nodeJoins: input.nodeJoins ?? [],
    primaryOwnerships: input.primaryOwnerships ?? [],
    classifications: input.classifications ?? [],
    anchors: input.anchors ?? [],
    acceptancePaths: input.acceptancePaths ?? [],
  }
}

/**
 * Convert CanonicalSnapshotInput → replace_board_snapshot MCP args body
 * (projects/features/tasks + V3 joins). Envelope fields supplied separately.
 */
export function canonicalInputToReplaceBoardArgs(canonicalInput, opts = {}) {
  const features = (canonicalInput.flows ?? []).map((f) => ({
    id: f.id,
    projectId: f.projectId,
    name: f.name ?? f.id,
    fase: f.fase,
  }))
  return {
    boardId: canonicalInput.boardId,
    snapshotId: canonicalInput.snapshotId,
    sourceRepoId: canonicalInput.sourceRepoId,
    sourceCommitSha: canonicalInput.sourceCommitSha,
    dryRun: opts.dryRun === true,
    projects: (canonicalInput.projects ?? []).map((p) => ({
      id: p.id,
      nama: p.name ?? p.nama ?? p.id,
      name: p.name ?? p.nama ?? p.id,
      status: p.status ?? 'active',
    })),
    features,
    tasks: (canonicalInput.tasks ?? []).map((t) => ({
      id: t.id,
      title: t.title ?? null,
      projectId: t.projectId ?? null,
      featureContractId: t.featureContractId ?? null,
    })),
    nodes: canonicalInput.nodes ?? [],
    dependencies: canonicalInput.dependencies ?? [],
    featureContractJoins: canonicalInput.featureContractJoins ?? [],
    nodeJoins: canonicalInput.nodeJoins ?? [],
    primaryOwnerships: canonicalInput.primaryOwnerships ?? [],
    // classifications ride on snapshot produce path via MCP builder defaults;
    // adapter also exposes them for pure produceCanonicalSnapshot consumers.
    classifications: canonicalInput.classifications ?? [],
    anchors: canonicalInput.anchors ?? [],
    acceptancePaths: canonicalInput.acceptancePaths ?? [],
  }
}

/**
 * Additive merge: keep all live non-prefix entities; upsert seed prefix entities.
 * Rejects seed entities without prefix.
 *
 * @param {{ projects?: any[], features?: any[], tasks?: any[], flows?: any[] }} live
 * @param {{ projects?: any[], features?: any[], tasks?: any[], flows?: any[] }} seed
 * @param {string} [prefix]
 */
export function mergeAdditiveDefinition(live, seed, prefix = ID_PREFIX) {
  const idOf = (x) => String(x?.id ?? '')

  function mergeColl(liveArr, seedArr, label) {
    const liveList = Array.isArray(liveArr) ? liveArr : []
    const seedList = Array.isArray(seedArr) ? seedArr : []
    for (const s of seedList) {
      if (!idOf(s).startsWith(prefix)) {
        throw Object.assign(
          new Error(`${label} id not prefix-scoped: ${idOf(s)}`),
          { code: 'GATES_PREFIX_VIOLATION', collection: label, id: idOf(s) },
        )
      }
    }
    const seedIds = new Set(seedList.map(idOf))
    // Non-prefix live always kept; same-id prefix live replaced by seed
    const nonPrefix = liveList.filter((x) => !idOf(x).startsWith(prefix))
    const prefixLiveKept = liveList.filter(
      (x) => idOf(x).startsWith(prefix) && !seedIds.has(idOf(x)),
    )
    return [...nonPrefix, ...prefixLiveKept, ...seedList]
  }

  const seedFlows = seed.flows ?? seed.features ?? []
  const liveFlows = live.flows ?? live.features ?? []

  return {
    projects: mergeColl(live.projects, seed.projects, 'projects'),
    features: mergeColl(liveFlows, seedFlows, 'features'),
    flows: mergeColl(liveFlows, seedFlows, 'flows'),
    tasks: mergeColl(live.tasks, seed.tasks, 'tasks'),
    nodes: mergeColl(live.nodes, seed.nodes, 'nodes'),
  }
}

/**
 * Prove dryRun/apply is additive for synth-gate prefix:
 * - every non-prefix id present before remains after
 * - every new id is prefix-scoped
 * - no non-prefix id removed or mutated (by id set + optional fingerprint)
 *
 * @param {{ projects?: any[], features?: any[], tasks?: any[] }} before
 * @param {{ projects?: any[], features?: any[], tasks?: any[] }} after
 * @param {string} [prefix]
 */
export function proveAdditivePrefixUnchanged(before, after, prefix = ID_PREFIX) {
  const idOf = (x) => String(x?.id ?? '')
  const violations = []

  function check(label, beforeArr, afterArr) {
    const b = Array.isArray(beforeArr) ? beforeArr : []
    const a = Array.isArray(afterArr) ? afterArr : []
    const afterById = new Map(a.map((x) => [idOf(x), x]))
    const beforeIds = new Set(b.map(idOf))
    const afterIds = new Set(a.map(idOf))

    for (const x of b) {
      const id = idOf(x)
      if (id.startsWith(prefix)) continue
      if (!afterIds.has(id)) {
        violations.push({
          collection: label,
          kind: 'non_prefix_removed',
          id,
        })
      } else {
        // shallow structural fingerprint: id + sorted keys count + title/name
        const prev = stableEntityFingerprint(x)
        const next = stableEntityFingerprint(afterById.get(id))
        if (prev !== next) {
          violations.push({
            collection: label,
            kind: 'non_prefix_mutated',
            id,
            before: prev,
            after: next,
          })
        }
      }
    }

    for (const id of afterIds) {
      if (!beforeIds.has(id) && !id.startsWith(prefix)) {
        violations.push({
          collection: label,
          kind: 'non_prefix_added',
          id,
        })
      }
    }
  }

  check('projects', before.projects, after.projects)
  check('features', before.features ?? before.flows, after.features ?? after.flows)
  check('tasks', before.tasks, after.tasks)

  return {
    ok: violations.length === 0,
    violations,
    prefix,
    code: violations.length === 0 ? null : 'ADDITIVE_PREFIX_PROOF_FAILED',
  }
}

function stableEntityFingerprint(entity) {
  if (!entity || typeof entity !== 'object') return String(entity)
  const keys = Object.keys(entity).sort()
  const pick = {}
  for (const k of keys) {
    if (k === 'updatedAt' || k === 'createdAt') continue
    const v = entity[k]
    if (v !== null && typeof v === 'object') {
      pick[k] = Array.isArray(v) ? v.length : Object.keys(v).length
    } else {
      pick[k] = v
    }
  }
  return JSON.stringify(pick)
}

/**
 * Classification matrix → task definition drafts (definition only; no receipt hashes).
 * Durable classification bind is product-owned; adapter only drafts task shells.
 */
export function classificationMatrixToTaskDrafts(matrix = loadClassificationMatrix()) {
  return (matrix.rows ?? []).map((row) => ({
    id: row.taskId,
    title: `gate-class ${row.taskClass}×${row.disposition}`,
    projectId: `${ID_PREFIX}p-class`,
    taskClass: row.taskClass,
    disposition: row.disposition,
    receiptMode: row.receiptMode,
    expect: row.expect,
    // Explicit: fixture receiptHashFor is NOT source-grounded — do not put hashes here.
    durableReceipt: null,
    note: 'evaluation-only draft; live durable bind needs product write + live pin',
  }))
}

/**
 * Rebind lifecycle valid packet fields from LIVE pin (never fixture boardRev=7).
 * Does NOT invent receiptHash — server emits that via submit_stage_evidence.
 *
 * @param {object} [lifePacket]
 * @param {{ boardRev: number, lifecycleRev: number, canonicalSnapshotId?: string, canonicalHash: string, taskHash: string }} livePin
 */
export function rebindLifecycleValidToLivePin(lifePacket, livePin) {
  const base = lifePacket || loadLifecycleValid()
  if (
    typeof livePin?.boardRev !== 'number' ||
    typeof livePin?.lifecycleRev !== 'number' ||
    !livePin?.canonicalHash ||
    !livePin?.taskHash
  ) {
    throw Object.assign(new Error('live pin incomplete for lifecycle rebind'), {
      code: 'GATES_LIVE_PIN_INCOMPLETE',
    })
  }
  return {
    packetId: base.packetId,
    ac: base.ac,
    case: base.case,
    expect: base.expect,
    task: {
      taskId: base.task.taskId,
      stage: base.task.stage,
      entityRev: base.task.entityRev ?? 0,
      boardRev: livePin.boardRev,
      lifecycleRev: livePin.lifecycleRev,
      taskHash: livePin.taskHash,
      canonicalSnapshotId: livePin.canonicalSnapshotId ?? base.task.canonicalSnapshotId,
      canonicalHash: livePin.canonicalHash,
    },
    authorRun: {
      ...base.authorRun,
      // run ids stay prefix-scoped; live register_run assigns authority
    },
    evidence: {
      toStage: base.evidence.toStage,
      fields: { ...base.evidence.fields },
      programmatic: true,
      // NO receiptHash — server-computed only
      receiptHash: undefined,
      receiptId: undefined,
    },
    residual_gaps: [],
  }
}

/**
 * Domain keys required by MCP `register_run` (board-mcp secureWriteTool inputSchema,
 * excluding mutation envelope keys filled by the driver).
 * Drift guard: tests assert these against src/server/board-mcp.ts.
 */
export const MCP_REGISTER_RUN_REQUIRED_DOMAIN_KEYS = Object.freeze([
  'boardId',
  'runId',
  'taskId',
  'targetGate',
  'agentId',
  'model',
])

/**
 * Domain keys required by MCP `advance_task` (excluding envelope).
 * `byRunId` must be the registered author run from register_run.
 */
export const MCP_ADVANCE_TASK_REQUIRED_DOMAIN_KEYS = Object.freeze([
  'boardId',
  'id',
  'toStage',
  'byRunId',
])

/**
 * Domain keys required by MCP `submit_stage_evidence` (excluding envelope).
 */
export const MCP_SUBMIT_STAGE_EVIDENCE_REQUIRED_DOMAIN_KEYS = Object.freeze([
  'boardId',
  'taskId',
  'toStage',
  'byRunId',
  'taskHash',
  'expectedLifecycleRev',
])

/**
 * Build register_run args (AGENT). Envelope filled by driver with live pin.
 * MUST include MCP-required `targetGate` (z.string() in board-mcp register_run).
 */
export function buildRegisterRunArgs(lifeRebound, opts = {}) {
  const run = lifeRebound.authorRun || {}
  const targetGate =
    opts.targetGate ||
    run.targetGate ||
    lifeRebound.evidence?.toStage ||
    lifeRebound.task?.stage ||
    'MAPPING'
  if (!targetGate || typeof targetGate !== 'string') {
    throw Object.assign(new Error('register_run requires targetGate (string)'), {
      code: 'GATES_REGISTER_TARGET_GATE_REQUIRED',
    })
  }
  const args = {
    boardId: opts.boardId || loadManifest().boardId,
    runId: opts.runId || run.runId,
    taskId: opts.taskId || lifeRebound.task.taskId,
    targetGate: String(targetGate),
    agentId: opts.agentId || run.agentId,
    model: opts.model || run.model,
  }
  // MCP register_run schema also lists expectedEntityRev as required; driver may
  // supply via opts or alias from mutation envelope (entityExpectedRev).
  if (opts.expectedEntityRev != null || opts.entityExpectedRev != null) {
    args.expectedEntityRev =
      opts.expectedEntityRev != null ? opts.expectedEntityRev : opts.entityExpectedRev
  }
  if (opts.effort != null || run.effort != null) {
    args.effort = opts.effort || run.effort
  }
  if (opts.initialState != null) {
    args.initialState = opts.initialState
  }
  return args
}

/**
 * Build submit_stage_evidence args. NEVER includes fabricated receiptHash.
 * Server sets programmatic=true + computes hash.
 */
export function buildSubmitStageEvidenceArgs(lifeRebound, opts = {}) {
  return {
    boardId: opts.boardId || loadManifest().boardId,
    taskId: lifeRebound.task.taskId,
    toStage: lifeRebound.evidence.toStage,
    byRunId: opts.byRunId || lifeRebound.authorRun.runId,
    fields: { ...lifeRebound.evidence.fields },
    taskHash: lifeRebound.task.taskHash,
    expectedLifecycleRev: lifeRebound.task.lifecycleRev,
    // receiptId optional — server may mint; if provided must be prefix-scoped
    ...(opts.receiptId
      ? { receiptId: opts.receiptId }
      : lifeRebound.evidence.fields?.mappingReceiptId
        ? { receiptId: lifeRebound.evidence.fields.mappingReceiptId }
        : {}),
  }
}

/**
 * Build advance_task args from SERVER-emitted receipt only.
 * MUST include MCP-required `byRunId` bound to the registered author run.
 * @param {{ receiptId: string, receiptHash: string }} serverReceipt
 * @param {{ boardId?: string, byRunId?: string, registeredRunId?: string }} [opts]
 */
export function buildAdvanceTaskArgs(lifeRebound, serverReceipt, opts = {}) {
  if (!serverReceipt?.receiptId || !serverReceipt?.receiptHash) {
    throw Object.assign(
      new Error('advance_task requires server-emitted receiptId+receiptHash'),
      { code: 'GATES_LIFECYCLE_RECEIPT_REQUIRED' },
    )
  }
  if (
    String(serverReceipt.receiptHash).startsWith(ID_PREFIX) ||
    String(serverReceipt.receiptHash).includes('hand')
  ) {
    throw Object.assign(
      new Error('refusing fabricated/hand-typed receiptHash for advance_task'),
      { code: 'GATES_LIFECYCLE_FABRICATED_HASH' },
    )
  }
  // byRunId MUST be the registered author run (register_run runId), not a free-form agent id.
  const byRunId =
    opts.byRunId ||
    opts.registeredRunId ||
    lifeRebound.authorRun?.runId ||
    null
  if (!byRunId || typeof byRunId !== 'string') {
    throw Object.assign(
      new Error('advance_task requires byRunId bound to registered author run'),
      { code: 'GATES_ADVANCE_BY_RUN_ID_REQUIRED' },
    )
  }
  const args = {
    boardId: opts.boardId || loadManifest().boardId,
    id: lifeRebound.task.taskId,
    toStage: lifeRebound.evidence.toStage,
    byRunId: String(byRunId),
    receipt: {
      receiptId: serverReceipt.receiptId,
      receiptHash: serverReceipt.receiptHash,
    },
  }
  if (typeof lifeRebound.task?.lifecycleRev === 'number') {
    args.expectedLifecycleRev = lifeRebound.task.lifecycleRev
  }
  if (lifeRebound.task?.taskHash) {
    args.expectedTaskHash = lifeRebound.task.taskHash
  }
  return args
}

/**
 * Healthz pin-shape contract (product HealthzPayload + common pin nests).
 * Fail-closed before plan-with-live-pin / execute: boardRev + lifecycleRev must be
 * finite numbers; deployedSha (or release.sha) non-empty string.
 *
 * Note: product buildHealthzPayload surfaces canonicalHash when observed (null when
 * unproven). This helper intentionally does not require hash — full live-pin
 * completeness is enforced by extractCompleteLivePin / STAGING_BIND_LIVE_PIN smoke.
 *
 * @param {object|null|undefined} body - parsed /api/healthz JSON
 * @returns {{ ok: boolean, code: string|null, missing: string[], pin: object|null, message: string|null }}
 */
export function validateHealthzPinShape(body) {
  const missing = []
  if (!body || typeof body !== 'object') {
    return {
      ok: false,
      code: 'HEALTHZ_PIN_SHAPE_INVALID',
      missing: ['body'],
      pin: null,
      message: 'healthz body missing or non-object',
    }
  }
  const boardRev =
    typeof body.boardRev === 'number'
      ? body.boardRev
      : typeof body.pin?.boardRev === 'number'
        ? body.pin.boardRev
        : null
  const lifecycleRev =
    typeof body.lifecycleRev === 'number'
      ? body.lifecycleRev
      : typeof body.pin?.lifecycleRev === 'number'
        ? body.pin.lifecycleRev
        : null
  const deployedSha =
    (typeof body.deployedSha === 'string' && body.deployedSha.trim()) ||
    (typeof body.release?.sha === 'string' && body.release.sha.trim()) ||
    null
  const schemaVersion =
    (typeof body.schema?.version === 'string' && body.schema.version) ||
    (typeof body.schemaVersion === 'string' && body.schemaVersion !== 'MFS_HEALTHZ_V1'
      ? body.schemaVersion
      : null) ||
    null
  const canonicalHash =
    (typeof body.canonicalHash === 'string' && body.canonicalHash.trim()) ||
    (typeof body.pin?.canonicalHash === 'string' && body.pin.canonicalHash.trim()) ||
    (typeof body.subjectHash === 'string' && body.subjectHash.trim()) ||
    null
  const canonicalSnapshotId =
    body.canonicalSnapshotId ?? body.pin?.canonicalSnapshotId ?? null
  const taskHash =
    (typeof body.taskHash === 'string' && body.taskHash.trim()) ||
    (typeof body.pin?.taskHash === 'string' && body.pin.taskHash.trim()) ||
    null

  if (boardRev == null || !Number.isFinite(boardRev)) missing.push('boardRev:number')
  if (lifecycleRev == null || !Number.isFinite(lifecycleRev)) missing.push('lifecycleRev:number')
  // deployedSha may be empty on misconfigured deploy — still require string field presence for live bind
  if (deployedSha == null) missing.push('deployedSha|release.sha:string')

  const pin = {
    source: 'healthz',
    boardRev,
    lifecycleRev,
    deployedSha,
    schemaVersion,
    canonicalHash,
    canonicalSnapshotId:
      canonicalSnapshotId == null ? null : String(canonicalSnapshotId),
    taskHash: taskHash || canonicalHash,
    entityRev:
      typeof body.entityRev === 'number'
        ? body.entityRev
        : typeof body.pin?.entityRev === 'number'
          ? body.pin.entityRev
          : 0,
    hasCanonicalHash: Boolean(canonicalHash),
  }

  if (missing.length > 0) {
    return {
      ok: false,
      code: 'HEALTHZ_PIN_SHAPE_INVALID',
      missing,
      pin,
      message: `healthz pin shape fail-closed: missing/invalid ${missing.join(', ')}`,
    }
  }
  return {
    ok: true,
    code: null,
    missing: [],
    pin,
    message: null,
  }
}

/**
 * Mutation CAS pin: boardRev + non-empty subject/canonical hash required.
 * Fail closed — never invent rev 0 or empty hash.
 *
 * @param {object|null|undefined} pin
 */
export function validateLivePinForMutation(pin) {
  const missing = []
  if (!pin || typeof pin !== 'object') {
    return {
      ok: false,
      code: 'GATES_LIVE_PIN_INCOMPLETE',
      missing: ['pin'],
      message: 'live pin object required for mutation',
    }
  }
  if (typeof pin.boardRev !== 'number' || !Number.isFinite(pin.boardRev)) {
    missing.push('boardRev:number')
  }
  if (typeof pin.lifecycleRev !== 'number' || !Number.isFinite(pin.lifecycleRev)) {
    missing.push('lifecycleRev:number')
  }
  const hash =
    (typeof pin.canonicalHash === 'string' && pin.canonicalHash.trim()) ||
    (typeof pin.subjectHash === 'string' && pin.subjectHash.trim()) ||
    ''
  if (!hash) missing.push('canonicalHash|subjectHash:nonempty')
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'GATES_LIVE_PIN_INCOMPLETE',
      missing,
      message: `live pin incomplete for mutation: ${missing.join(', ')}`,
    }
  }
  return { ok: true, code: null, missing: [], message: null }
}

/**
 * Parse required (non-optional) Zod field names from board-mcp.ts source for a tool.
 * Used by unit tests so schema drift fails the suite.
 *
 * @param {string} sourceText - full board-mcp.ts contents
 * @param {string} toolName - e.g. 'register_run' | 'advance_task'
 * @returns {string[]}
 */
export function extractMcpToolRequiredKeysFromSource(sourceText, toolName) {
  if (typeof sourceText !== 'string' || !toolName) return []
  // Match secureWriteTool('name', { ... inputSchema: { ... }, }, handler)
  // or secureTool( same )
  const nameRe = new RegExp(
    `secure(?:Write)?Tool\\(\\s*['"]${toolName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}['"]`,
  )
  const nameMatch = nameRe.exec(sourceText)
  if (!nameMatch) return []
  const from = nameMatch.index
  const schemaIdx = sourceText.indexOf('inputSchema:', from)
  if (schemaIdx < 0 || schemaIdx - from > 2500) return []
  const braceStart = sourceText.indexOf('{', schemaIdx)
  if (braceStart < 0) return []
  let depth = 0
  let end = -1
  for (let i = braceStart; i < sourceText.length && i < braceStart + 8000; i++) {
    const ch = sourceText[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end < 0) return []
  const block = sourceText.slice(braceStart + 1, end)
  const keys = []
  // field: z....  — skip if .optional() appears before next top-level comma/newline field
  const fieldRe = /^\s*([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)(?=,\s*(?:\/\/[^\n]*\n\s*)?[A-Za-z_][A-Za-z0-9_]*\s*:|$)/gm
  let m
  while ((m = fieldRe.exec(block)) !== null) {
    const key = m[1]
    const expr = m[2]
    if (key === 'BOARD_ARG' || key.startsWith('...')) continue
    // spread BOARD_ARG contributes boardId as required
    if (/\.optional\s*\(/.test(expr)) continue
    // nested z.object / z.record still count as required if not optional-wrapped
    keys.push(key)
  }
  // BOARD_ARG spread always means boardId required
  if (/\.\.\.\s*BOARD_ARG/.test(block) && !keys.includes('boardId')) {
    keys.unshift('boardId')
  }
  return keys
}

/**
 * Assert adapter-built domain args cover MCP required domain keys for a tool.
 * @param {string} toolName
 * @param {Record<string, unknown>} args
 * @param {string[]} requiredKeys
 */
export function assertMcpDomainArgsCompatible(toolName, args, requiredKeys) {
  const missing = (requiredKeys || []).filter(
    (k) => args == null || args[k] === undefined || args[k] === null || args[k] === '',
  )
  return {
    ok: missing.length === 0,
    toolName,
    missing,
    present: Object.keys(args || {}),
    code: missing.length === 0 ? null : 'MCP_DOMAIN_ARGS_INCOMPATIBLE',
    message:
      missing.length === 0
        ? null
        : `${toolName} domain args missing required keys: ${missing.join(', ')}`,
  }
}

/**
 * G5 write is unsupported via public MCP. Fail closed — never fabricate PASS.
 */
export function buildG5WritePlan() {
  const g5 = loadG5Domains()
  return {
    packetId: g5.packetId,
    supported: false,
    code: G5_WRITE_UNSUPPORTED_CODE,
    message:
      'No public MCP write tool for G5 domain PASS. get_g5 is read-only. Fail closed — do not fabricate PASS or SQL-insert domain evidence.',
    allowedActions: ['get_g5'],
    forbiddenActions: [
      'fabricate_g5_pass',
      'sql_insert_control_plane_g5',
      'hand_typed_pass_receipt',
    ],
    requiredDomains: g5.requiredDomains,
    residual_gaps: ['g5_durable_write_surface_missing'],
  }
}

/**
 * Capacity/priority → sync_accounts scenario drafts (definition of args only).
 */
export function capacityScenarioToSyncArgs(scenario, opts = {}) {
  const boardId = opts.boardId || loadManifest().boardId
  return {
    boardId,
    scenarioId: scenario.id,
    accounts: scenario.input?.accounts ?? [],
    forceZero: scenario.input?.forceZero === true,
    genuineReadyPacketCount: scenario.input?.genuineReadyPacketCount,
    health: scenario.input?.health,
    expect: scenario.expect,
    note: 'Driver must re-read live boardRev before each sync_accounts and chain expectedBoardRev',
  }
}

/**
 * Reconciler dry→apply plan (args skeletons). Hash must come from live dry-run.
 */
export function buildReconcilerApplyPlan(packet = loadReconcilerPacket()) {
  const scenario = (packet.scenarios ?? []).find((s) => s.id === 'dry_run_apply_idempotent')
  return {
    packetId: packet.packetId,
    boardId: packet.boardId,
    maxActions: scenario?.maxActions ?? 100,
    timeBudgetMs: scenario?.timeBudgetMs ?? 5000,
    steps: [
      {
        id: 'reconcile_dry_run',
        tool: 'reconcile_dry_run',
        capture: ['dryRunHash'],
      },
      {
        id: 'reconcile_apply',
        tool: 'reconcile_apply',
        requires: ['dryRunHash'],
        note: 'bind live dryRunHash; never fixture hash',
      },
      {
        id: 'reconcile_apply_idempotent_replay',
        tool: 'reconcile_apply',
        requires: ['dryRunHash'],
        expectIdempotent: true,
      },
      {
        id: 'reconcile_wrong_hash_negative',
        tool: 'reconcile_apply',
        dryRunHash: '0000000000000000000000000000000000000000000000000000000000000000',
        expectErrorCode: scenario?.expect?.wrongHashCode || 'DRY_RUN_HASH_MISMATCH',
      },
    ],
    residual_gaps: [],
  }
}

/**
 * Prefix-scoped cleanup plan with before/after audit slots (plan only — no SQL exec).
 */
export function buildPrefixCleanupPlan(opts = {}) {
  const rules = loadCleanupRules()
  const boardId = opts.boardId || loadManifest().boardId
  const classIds = (loadClassificationMatrix().rows ?? []).map((r) => r.taskId)
  const lifeTask = loadLifecycleValid().task.taskId
  const distinctTasks = (loadValidDistinctSeed().input?.tasks ?? []).map((t) => t.id)
  const reconRuns =
    loadReconcilerPacket().scenarios?.find((s) => s.id === 'dry_run_apply_idempotent')?.runs?.map(
      (r) => r.runId,
    ) ?? []

  return {
    mode: 'plan-only',
    boardId,
    idPrefix: rules.idPrefix || ID_PREFIX,
    preserveNonPrefix: true,
    never: ['DROP DATABASE', 'seed-synthetic full board wipe', 'print secrets'],
    steps: [
      { action: 'READBACK_BEFORE', match: { boardId, idPrefix: ID_PREFIX } },
      { action: 'DELETE_RUNS', match: { boardId, runIdPrefix: ID_PREFIX }, ids: reconRuns },
      { action: 'DELETE_STAGE_EVIDENCE', match: { boardId, receiptIdPrefix: ID_PREFIX } },
      { action: 'DELETE_G5_DOMAIN_EVIDENCE', match: { boardId, evidencePrefix: ID_PREFIX } },
      {
        action: 'DELETE_CLASSIFICATION',
        match: { boardId, taskIds: classIds },
      },
      {
        action: 'DELETE_TASKS',
        match: {
          boardId,
          taskIds: [...new Set([...classIds, lifeTask, ...distinctTasks])].sort(),
        },
      },
      {
        action: 'CLEAR_RECONCILER_HASHES',
        match: { boardId, onlyIfPacketScoped: true },
      },
      { action: 'READBACK_AFTER', match: { boardId, idPrefix: ID_PREFIX } },
      {
        action: 'AUDIT_NON_PREFIX_PRESERVED',
        match: { boardId },
        note: 'Compare non-prefix task/project/feature ids before vs after; must be identical',
      },
    ],
    sqlLiteral: false,
    note: 'Plan only — executor must use product APIs / prefix-scoped deletes; never raw board wipe',
  }
}

/**
 * Emit before/after/audit readback structure for cleanup (pure fill-in).
 */
export function buildCleanupAuditReadback(beforeSnapshot, afterSnapshot, prefix = ID_PREFIX) {
  const idOf = (x) => String(x?.id ?? '')
  const nonPrefix = (arr) =>
    (Array.isArray(arr) ? arr : [])
      .map(idOf)
      .filter((id) => id && !id.startsWith(prefix))
      .sort()

  const beforeNP = {
    projects: nonPrefix(beforeSnapshot?.projects),
    features: nonPrefix(beforeSnapshot?.features ?? beforeSnapshot?.flows),
    tasks: nonPrefix(beforeSnapshot?.tasks),
  }
  const afterNP = {
    projects: nonPrefix(afterSnapshot?.projects),
    features: nonPrefix(afterSnapshot?.features ?? afterSnapshot?.flows),
    tasks: nonPrefix(afterSnapshot?.tasks),
  }
  const proof = proveAdditivePrefixUnchanged(
    {
      projects: (beforeSnapshot?.projects ?? []).filter((x) => !idOf(x).startsWith(prefix)),
      features: (beforeSnapshot?.features ?? beforeSnapshot?.flows ?? []).filter(
        (x) => !idOf(x).startsWith(prefix),
      ),
      tasks: (beforeSnapshot?.tasks ?? []).filter((x) => !idOf(x).startsWith(prefix)),
    },
    {
      projects: (afterSnapshot?.projects ?? []).filter((x) => !idOf(x).startsWith(prefix)),
      features: (afterSnapshot?.features ?? afterSnapshot?.flows ?? []).filter(
        (x) => !idOf(x).startsWith(prefix),
      ),
      tasks: (afterSnapshot?.tasks ?? []).filter((x) => !idOf(x).startsWith(prefix)),
    },
    prefix,
  )
  // For cleanup, non-prefix sets must match exactly (no synth left as non-prefix).
  const setsEqual =
    JSON.stringify(beforeNP) === JSON.stringify(afterNP) && proof.ok

  return {
    before: beforeNP,
    after: afterNP,
    nonPrefixPreserved: setsEqual,
    proof,
    code: setsEqual ? null : 'CLEANUP_NON_PREFIX_DRIFT',
  }
}

/**
 * Mutation envelope skeleton — values MUST be filled from live pin re-read.
 * Fixture pin.json boardRev=7 is NEVER used as live CAS.
 */
export function buildMutationEnvelopeSkeleton(livePin, idempotencyKey) {
  if (!livePin || typeof livePin.boardRev !== 'number') {
    throw Object.assign(new Error('live pin required for mutation envelope'), {
      code: 'GATES_LIVE_PIN_REQUIRED',
    })
  }
  return {
    entityExpectedRev:
      typeof livePin.entityRev === 'number' ? livePin.entityRev : livePin.entityExpectedRev ?? 0,
    expectedBoardRev: livePin.boardRev,
    subjectHash: livePin.canonicalHash || livePin.subjectHash,
    canonicalHash: livePin.canonicalHash || livePin.subjectHash,
    idempotencyKey,
    // diagnostics only
    _pinSource: livePin.source || 'live',
    _forbidFixtureBoardRev7: livePin.boardRev === 7 && livePin.source === 'fixture',
  }
}

/**
 * Full ordered apply step plan (pure). Each step names the product tool.
 * Default execute=false → plan-only.
 *
 * @param {{
 *   livePin?: object,
 *   expectedSha?: string,
 *   packHash?: string,
 *   boardId?: string,
 *   salt?: string,
 *   includeRejectProbes?: boolean,
 * }} [opts]
 */
export function buildApplyStepPlan(opts = {}) {
  const boardId = opts.boardId || loadManifest().boardId
  const keyOpts = {
    expectedSha: opts.expectedSha || 'UNKNOWN_SHA',
    packHash: opts.packHash || 'UNKNOWN_PACK',
    salt: opts.salt || 'plan',
  }
  const distinctSeed = loadValidDistinctSeed()
  const canonical = distinctSeedToCanonicalInput(distinctSeed, {
    snapshotId: `${ID_PREFIX}snap-${(opts.expectedSha || 'local').slice(0, 12)}`,
    sourceCommitSha: opts.expectedSha && /^[a-f0-9]{7,64}$/i.test(opts.expectedSha)
      ? opts.expectedSha.toLowerCase()
      : distinctSeed.input.sourceCommitSha,
  })
  const replaceArgs = canonicalInputToReplaceBoardArgs(canonical, { dryRun: true })
  const classDrafts = classificationMatrixToTaskDrafts()
  const g5 = buildG5WritePlan()
  const recon = buildReconcilerApplyPlan()
  const cleanup = buildPrefixCleanupPlan({ boardId })
  const capacity = loadCapacityMatrix()
  const lifeFixture = loadLifecycleValid()

  const steps = []

  steps.push({
    id: 'preflight_live_pin',
    tool: 'healthz+get_overview',
    mutate: false,
    required: true,
    note: 'Re-read deployedSha, schema 006, boardRev, lifecycleRev, canonicalHash, taskHash',
  })

  steps.push({
    id: 'prefix_cleanup_prior',
    tool: 'prefix_cleanup_executor',
    mutate: true,
    required: false,
    plan: cleanup,
    note: 'Prefix-scoped only; preserve non-prefix; before/after audit',
  })

  steps.push({
    id: 'definition_dry_run',
    tool: 'replace_board_snapshot',
    mutate: false,
    dryRun: true,
    args: replaceArgs,
    idempotencyKey: buildDeterministicIdempotencyKey({ ...keyOpts, step: 'definition_dry_run' }),
    requireAdditiveProof: true,
    note: 'dryRun planImport only; prove additive synth-gate prefix before apply',
  })

  steps.push({
    id: 'definition_apply',
    tool: 'replace_board_snapshot',
    mutate: true,
    dryRun: false,
    args: { ...replaceArgs, dryRun: false },
    idempotencyKey: buildDeterministicIdempotencyKey({ ...keyOpts, step: 'definition_apply' }),
    dependsOn: ['definition_dry_run'],
    requireAdditiveProof: true,
    reReadLivePinBefore: true,
    note: 'apply only if additive proof ok; live CAS envelope',
  })

  steps.push({
    id: 'classification_drafts',
    tool: 'evaluateClassification|product_task_upsert',
    mutate: false,
    drafts: classDrafts,
    note: 'Pure evaluation drafts; durable bind needs product path without fixture receipt hashes',
  })

  steps.push({
    id: 'lifecycle_register_author',
    tool: 'register_run',
    mutate: true,
    role: 'AGENT',
    reReadLivePinBefore: true,
    packet: lifeFixture.packetId,
    note: 'Register live author run; do not use fixture boardRev',
  })

  steps.push({
    id: 'lifecycle_submit_stage_evidence',
    tool: 'submit_stage_evidence',
    mutate: true,
    role: 'AGENT',
    reReadLivePinBefore: true,
    dependsOn: ['lifecycle_register_author', 'definition_apply'],
    note: 'Server emits receiptHash; never hand-type',
  })

  steps.push({
    id: 'lifecycle_advance_task',
    tool: 'advance_task',
    mutate: true,
    role: 'AGENT|ROOT',
    reReadLivePinBefore: true,
    dependsOn: ['lifecycle_submit_stage_evidence'],
    note: 'advance with registered receiptId+receiptHash only',
  })

  steps.push({
    id: 'lifecycle_negatives',
    tool: 'submit_stage_evidence|advance_task',
    mutate: true,
    expectReject: true,
    note: 'Expected-reject probes only; do not persist failing state as seeded',
  })

  for (const sc of capacity.scenarios ?? []) {
    steps.push({
      id: `capacity_${sc.id}`,
      tool: 'sync_accounts',
      mutate: true,
      reReadLivePinBefore: true,
      args: capacityScenarioToSyncArgs(sc, { boardId }),
    })
  }

  steps.push({
    id: 'reconciler_sequence',
    tool: 'reconcile_dry_run|reconcile_apply',
    mutate: true,
    reReadLivePinBefore: true,
    plan: recon,
  })

  steps.push({
    id: 'g5_write',
    tool: 'get_g5',
    mutate: false,
    supported: false,
    code: g5.code,
    plan: g5,
    failClosed: true,
    note: g5.message,
  })

  steps.push({
    id: 'readback',
    tool: 'list_tasks|get_g5|list_audit|healthz',
    mutate: false,
    note: 'Prove synth-gate-* present; non-prefix preserved; no fabricated g5Pass',
  })

  steps.push({
    id: 'cleanup_rollback',
    tool: 'prefix_cleanup_executor',
    mutate: true,
    plan: cleanup,
    note: 'Prefix-scoped cleanup with before/after/audit readback',
  })

  const residual_gaps = [
    g5.supported ? null : 'g5_durable_write_unsupported',
    'live_staging_execute_requires_CAIRN_GATES_EXECUTE=1_and_bearers',
    'classification_durable_bind_partial',
  ].filter(Boolean)

  return {
    adapterId: ADAPTER_ID,
    mode: 'apply-plan',
    stagingMutation: false,
    boardId,
    idPrefix: ID_PREFIX,
    livePinBound: Boolean(opts.livePin && opts.livePin.source === 'live'),
    livePin: opts.livePin
      ? {
          boardRev: opts.livePin.boardRev,
          lifecycleRev: opts.livePin.lifecycleRev,
          canonicalHash: opts.livePin.canonicalHash,
          taskHash: opts.livePin.taskHash,
          source: opts.livePin.source || 'provided',
        }
      : null,
    fixturePinForbiddenAsLiveCas: true,
    forbiddenBypass: FORBIDDEN_BYPASS_PATHS,
    steps,
    residual_gaps,
    g5: g5,
    cleanup,
  }
}

/**
 * Reconcile dryRunHash vs apply binding (pure check).
 */
export function reconcileDryApplyBinding(dryResult, applyArgs) {
  const dryHash = dryResult?.dryRunHash || dryResult?.hash
  const applyHash = applyArgs?.dryRunHash
  if (!dryHash || !applyHash) {
    return {
      ok: false,
      code: 'RECONCILE_HASH_MISSING',
      message: 'dryRunHash and apply dryRunHash both required',
    }
  }
  if (dryHash !== applyHash) {
    return {
      ok: false,
      code: 'DRY_RUN_HASH_MISMATCH',
      message: `dryRunHash mismatch: dry=${dryHash.slice(0, 12)}… apply=${applyHash.slice(0, 12)}…`,
    }
  }
  return { ok: true, dryRunHash: dryHash }
}

/**
 * Pure self-tests for the adapter (no product TS imports).
 */
export function runApplyAdapterSelfTests() {
  const failures = []
  const checks = []
  function ok(name, cond, detail = null) {
    checks.push({ name, ok: Boolean(cond), detail })
    if (!cond) failures.push({ name, detail })
  }

  ok('adapter_id', ADAPTER_ID === 'staging-gates-apply-adapter-v1')
  ok('prefix', ID_PREFIX === 'synth-gate-')
  ok(
    'forbidden_includes_seed_synthetic',
    FORBIDDEN_BYPASS_PATHS.some((p) => p.includes('seed-synthetic')),
  )

  // gates check pure
  const refused = checkApplyGates({})
  ok('gates_refuse_empty', refused.ok === false && refused.missing.length >= 5)
  const full = checkApplyGates({ ...REQUIRED_APPLY_ENV })
  ok('gates_accept_full', full.ok === true)

  // distinct → canonical
  const seed = loadValidDistinctSeed()
  const canon = distinctSeedToCanonicalInput(seed)
  ok('canon_board', canon.boardId === 'mfs-rebuild')
  ok(
    'canon_tasks_prefixed',
    canon.tasks.every((t) => t.id.startsWith(ID_PREFIX)),
  )
  ok('canon_no_lifecycle_on_tasks', canon.tasks.every((t) => t.g5Pass == null))

  // additive merge + proof
  const live = {
    projects: [
      { id: 'live-p-1', name: 'Live' },
      { id: `${ID_PREFIX}p-old`, name: 'Old gate' },
    ],
    features: [{ id: 'live-f-1', projectId: 'live-p-1' }],
    tasks: [
      { id: 'task-next-1', title: 'Live task' },
      { id: `${ID_PREFIX}t-old`, title: 'Old' },
    ],
  }
  const seedDef = {
    projects: canon.projects,
    features: canon.flows,
    tasks: canon.tasks,
  }
  const merged = mergeAdditiveDefinition(live, seedDef)
  ok(
    'merge_keeps_live_project',
    merged.projects.some((p) => p.id === 'live-p-1'),
  )
  ok(
    'merge_adds_gate_tasks',
    merged.tasks.some((t) => t.id === 'synth-gate-t-1'),
  )
  ok(
    'merge_keeps_live_task',
    merged.tasks.some((t) => t.id === 'task-next-1'),
  )

  const proofOk = proveAdditivePrefixUnchanged(live, merged)
  ok('additive_proof_pass', proofOk.ok === true, proofOk.violations)

  const wiped = { projects: [], features: [], tasks: [{ id: 'synth-gate-only', title: 'x' }] }
  const proofFail = proveAdditivePrefixUnchanged(live, wiped)
  ok('additive_proof_detects_wipe', proofFail.ok === false)

  // lifecycle rebind
  const livePin = {
    boardRev: 150,
    lifecycleRev: 3,
    canonicalHash: 'abc'.padEnd(64, '0'),
    taskHash: 'def'.padEnd(64, '0'),
    canonicalSnapshotId: 'live-snap',
    source: 'live',
  }
  const rebound = rebindLifecycleValidToLivePin(null, livePin)
  ok('life_rebind_boardRev', rebound.task.boardRev === 150)
  ok('life_rebind_no_fixture_7', rebound.task.boardRev !== 7 || livePin.boardRev === 7)
  ok('life_no_receipt_hash', rebound.evidence.receiptHash === undefined)

  let advanceThrew = false
  try {
    buildAdvanceTaskArgs(rebound, { receiptId: 'x', receiptHash: `${ID_PREFIX}handhash` })
  } catch (e) {
    advanceThrew = e?.code === 'GATES_LIFECYCLE_FABRICATED_HASH'
  }
  ok('advance_refuses_fabricated_hash', advanceThrew)

  const serverRcpt = {
    receiptId: 'rcpt-server-1',
    receiptHash: 'a'.repeat(64),
  }
  const adv = buildAdvanceTaskArgs(rebound, serverRcpt)
  ok('advance_ok_server', adv.receipt.receiptHash === serverRcpt.receiptHash)
  ok(
    'advance_has_byRunId_bound_author',
    adv.byRunId === rebound.authorRun.runId && typeof adv.byRunId === 'string',
  )

  // register_run must include MCP-required targetGate
  const regArgs = buildRegisterRunArgs(rebound)
  ok('register_has_targetGate', typeof regArgs.targetGate === 'string' && regArgs.targetGate.length > 0)
  ok('register_has_runId', regArgs.runId === rebound.authorRun.runId)
  ok('register_has_taskId', regArgs.taskId === rebound.task.taskId)
  const regCompat = assertMcpDomainArgsCompatible(
    'register_run',
    regArgs,
    MCP_REGISTER_RUN_REQUIRED_DOMAIN_KEYS,
  )
  ok('register_mcp_domain_compat', regCompat.ok, regCompat.missing)
  const advCompat = assertMcpDomainArgsCompatible(
    'advance_task',
    adv,
    MCP_ADVANCE_TASK_REQUIRED_DOMAIN_KEYS,
  )
  ok('advance_mcp_domain_compat', advCompat.ok, advCompat.missing)

  // advance byRunId override binds to registered run id
  const advBound = buildAdvanceTaskArgs(rebound, serverRcpt, {
    byRunId: rebound.authorRun.runId,
    registeredRunId: rebound.authorRun.runId,
  })
  ok('advance_byRunId_equals_registered', advBound.byRunId === rebound.authorRun.runId)

  // healthz pin-shape fail-closed
  const hzBad = validateHealthzPinShape({})
  ok('healthz_shape_refuse_empty', hzBad.ok === false && hzBad.code === 'HEALTHZ_PIN_SHAPE_INVALID')
  const hzOk = validateHealthzPinShape({
    deployedSha: 'abc'.padEnd(40, '0'),
    boardRev: 12,
    lifecycleRev: 3,
    schema: { version: '006', match: true },
    release: { sha: 'abc'.padEnd(40, '0'), match: true },
    canonicalSnapshotId: 'snap-1',
  })
  ok('healthz_shape_accept_minimal', hzOk.ok === true && hzOk.pin.boardRev === 12)
  const mutPinBad = validateLivePinForMutation({ boardRev: 1, lifecycleRev: 2 })
  ok(
    'mutation_pin_refuse_no_hash',
    mutPinBad.ok === false && mutPinBad.code === 'GATES_LIVE_PIN_INCOMPLETE',
  )
  const mutPinOk = validateLivePinForMutation({
    boardRev: 1,
    lifecycleRev: 2,
    canonicalHash: 'c'.repeat(64),
  })
  ok('mutation_pin_accept', mutPinOk.ok === true)

  // G5 fail closed
  const g5 = buildG5WritePlan()
  ok('g5_unsupported', g5.supported === false && g5.code === G5_WRITE_UNSUPPORTED_CODE)

  // idempotency keys unique per step
  const k1 = buildDeterministicIdempotencyKey({
    expectedSha: 'a'.repeat(40),
    packHash: 'b'.repeat(64),
    step: 'definition_apply',
  })
  const k2 = buildDeterministicIdempotencyKey({
    expectedSha: 'a'.repeat(40),
    packHash: 'b'.repeat(64),
    step: 'lifecycle_advance_task',
  })
  ok('idem_unique_steps', k1 !== k2 && k1.startsWith('gates-apply:'))

  // cleanup audit
  const audit = buildCleanupAuditReadback(live, {
    projects: [{ id: 'live-p-1', name: 'Live' }],
    features: [{ id: 'live-f-1', projectId: 'live-p-1' }],
    tasks: [{ id: 'task-next-1', title: 'Live task' }],
  })
  ok('cleanup_preserves_non_prefix', audit.nonPrefixPreserved === true)

  const plan = buildApplyStepPlan({
    expectedSha: 'a'.repeat(40),
    packHash: 'c'.repeat(64),
    livePin,
  })
  ok('plan_has_definition_dry', plan.steps.some((s) => s.id === 'definition_dry_run'))
  ok('plan_g5_fail_closed', plan.steps.some((s) => s.id === 'g5_write' && s.failClosed))
  ok('plan_forbids_bypass', plan.forbiddenBypass.includes(FORBIDDEN_BYPASS_PATHS[0]))
  ok('plan_residual_g5', plan.residual_gaps.includes('g5_durable_write_unsupported'))
  ok('plan_default_no_mutation_flag', plan.stagingMutation === false)

  // dry/apply hash reconcile
  const recOk = reconcileDryApplyBinding(
    { dryRunHash: 'h'.repeat(64) },
    { dryRunHash: 'h'.repeat(64) },
  )
  ok('reconcile_hash_match', recOk.ok)
  const recBad = reconcileDryApplyBinding(
    { dryRunHash: 'h'.repeat(64) },
    { dryRunHash: 'i'.repeat(64) },
  )
  ok('reconcile_hash_mismatch', recBad.ok === false && recBad.code === 'DRY_RUN_HASH_MISMATCH')

  // envelope refuses missing pin
  let envThrew = false
  try {
    buildMutationEnvelopeSkeleton(null, 'k')
  } catch (e) {
    envThrew = e?.code === 'GATES_LIVE_PIN_REQUIRED'
  }
  ok('envelope_requires_live_pin', envThrew)

  return {
    ok: failures.length === 0,
    adapterId: ADAPTER_ID,
    checkCount: checks.length,
    passCount: checks.filter((c) => c.ok).length,
    failures,
    checks,
  }
}

// CLI when executed directly
const thisFile = fileURLToPath(import.meta.url)
const invoked = process.argv[1] ? join(process.argv[1]) : ''
if (invoked && (invoked === thisFile || invoked.endsWith('apply-adapter.mjs'))) {
  if (process.argv.includes('--plan')) {
    const plan = buildApplyStepPlan({})
    console.log(JSON.stringify({ ok: true, mode: 'plan', plan }, null, 2))
    process.exit(0)
  }
  const self = runApplyAdapterSelfTests()
  console.log(JSON.stringify({ mode: 'self-test', ...self }, null, 2))
  process.exit(self.ok ? 0 : 1)
}
