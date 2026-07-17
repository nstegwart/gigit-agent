/**
 * Pure staging gate fixture contract (no network, no DB, no credentials).
 * Loads deterministic JSON packets under qa/fixtures/staging/gates/** and exposes
 * builders + self-tests for classification / distinct / lifecycle / G5 / capacity /
 * priority / reconciler manifests + cleanup plan.
 */
import { createHash } from 'node:crypto'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))

export const GATES_DIR = __dirname
export const ID_PREFIX = 'synth-gate-'
export const FIXTURE_ID = 'staging-gate-fixtures-v1'

function readJson(relPath) {
  const raw = readFileSync(join(__dirname, relPath), 'utf8')
  return JSON.parse(raw)
}

export function loadManifest() {
  return readJson('MANIFEST.json')
}

export function loadPin() {
  return readJson('pin.json')
}

export function loadSeedPolicy() {
  return readJson('seed-policy.json')
}

export function loadCleanupRules() {
  return readJson('cleanup-rules.json')
}

export function loadClassificationMatrix() {
  return readJson('classification/matrix.json')
}

export function loadDistinctSeeds() {
  const dir = join(__dirname, 'distinct')
  return readdirSync(dir)
    .filter((n) => n.endsWith('.seed.json'))
    .sort()
    .map((n) => ({ name: n, ...readJson(join('distinct', n)) }))
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

/** Stable pin tuple for pure evaluation (includes taskHash). */
export function pinTuple(overrides = {}) {
  const pin = loadPin()
  return {
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    ...overrides,
  }
}

function receiptHashFor(taskId) {
  return createHash('sha256').update(`rcpt|${taskId}`).digest('hex').slice(0, 24)
}

/**
 * Materialize a classification row + receipt modes from matrix definition.
 * Pure — does not call product code.
 */
export function buildClassificationRecord(row, pin = pinTuple()) {
  const baseReceipt = {
    receiptId: `${ID_PREFIX}rcpt-${row.taskId.replace(ID_PREFIX, '')}`,
    receiptHash: receiptHashFor(row.taskId),
    taskId: row.taskId,
    taskClass: row.taskClass,
    disposition: row.disposition,
    canonicalSnapshotId: pin.canonicalSnapshotId,
    canonicalHash: pin.canonicalHash,
    taskHash: pin.taskHash,
    boardRev: pin.boardRev,
    lifecycleRev: pin.lifecycleRev,
    issuedAt: '2026-07-13T00:00:00.000Z',
  }

  let receipt = null
  switch (row.receiptMode) {
    case 'missing':
      receipt = null
      break
    case 'stale_board_rev':
      receipt = { ...baseReceipt, boardRev: pin.boardRev - 1 }
      break
    case 'stale_lifecycle_rev':
      receipt = { ...baseReceipt, lifecycleRev: pin.lifecycleRev - 1 }
      break
    case 'stale_hash':
      receipt = { ...baseReceipt, canonicalHash: 'deadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeefdeadbeef' }
      break
    case 'expired':
      receipt = { ...baseReceipt, expiresAt: '2020-01-01T00:00:00.000Z' }
      break
    case 'current':
    default:
      receipt = baseReceipt
  }

  return {
    taskId: row.taskId,
    taskClass: row.taskClass,
    disposition: row.disposition,
    receipt,
    controlPlaneTargetGate: row.controlPlaneTargetGate ?? null,
    controlPlaneGateVerifiedPass: row.controlPlaneGateVerifiedPass ?? false,
    controlPlaneRootAccepted: row.controlPlaneRootAccepted ?? false,
  }
}

export function buildAllClassificationRecords(pin = pinTuple()) {
  const matrix = loadClassificationMatrix()
  return matrix.rows.map((row) => ({
    row,
    record: buildClassificationRecord(row, pin),
    expect: row.expect,
  }))
}

/** Build G5 domain records for a scenario (pure). */
export function buildG5DomainsForScenario(scenario, pin = pinTuple()) {
  const g5 = loadG5Domains()
  if (scenario.empty) return []

  const domains = g5.requiredDomains
  const out = []
  for (const domainId of domains) {
    let status = scenario.statusForAll
    if (scenario.mixed?.overrides?.[domainId]) {
      status = scenario.mixed.overrides[domainId]
    } else if (scenario.mixed?.defaultStatus) {
      status = scenario.mixed.defaultStatus
    }
    const authorRunId = `${ID_PREFIX}run-a-${domainId}`
    const verifierRunId = scenario.selfVerify
      ? authorRunId
      : `${ID_PREFIX}run-v-${domainId}`
    const boardRev = scenario.staleBoardRev ? pin.boardRev - 1 : pin.boardRev
    const programmatic =
      scenario.programmaticEvidence === true && status === 'PASS'
        ? true
        : Boolean(scenario.programmaticEvidence) && status !== 'NOT_STARTED'
          ? Boolean(scenario.programmaticEvidence)
          : Boolean(scenario.programmaticEvidence)

    out.push({
      domainId,
      scope: 'board',
      required: true,
      status,
      evidenceReceiptIds:
        status === 'PASS' && programmatic ? [`${ID_PREFIX}ev-${domainId}`] : [],
      evidenceReceiptHashes:
        status === 'PASS' && programmatic
          ? [`${ID_PREFIX}hash-${domainId}-aaaaaaaaaaaaaaaa`]
          : [],
      verifierAgent: 'synth-gate-verifier',
      verifierModel: 'verifier-model',
      verifierRunId: status === 'PASS' ? verifierRunId : null,
      authorRunId: status === 'PASS' ? authorRunId : null,
      subjectRevision: boardRev,
      subjectHash: pin.canonicalHash,
      findings: null,
      blocker: status === 'NOT_STARTED' ? 'not_started' : null,
      capturedAt: '2026-07-13T00:00:00.000Z',
      expectedRev: boardRev,
      boardRev,
      subjectLifecycleRev: pin.lifecycleRev,
      programmaticEvidence: Boolean(scenario.programmaticEvidence) && status === 'PASS'
        ? Boolean(scenario.programmaticEvidence)
        : Boolean(scenario.programmaticEvidence) && status === 'PASS',
      independentVerifier: Boolean(scenario.independentVerifier),
    })
  }

  // Normalize programmaticEvidence for PASS scenarios from fixture flags
  for (const d of out) {
    if (d.status === 'PASS') {
      d.programmaticEvidence = Boolean(scenario.programmaticEvidence)
      if (d.programmaticEvidence && d.evidenceReceiptIds.length === 0) {
        d.evidenceReceiptIds = [`${ID_PREFIX}ev-${d.domainId}`]
        d.evidenceReceiptHashes = [`${ID_PREFIX}hash-${d.domainId}-aaaaaaaaaaaaaaaa`]
      }
      if (!d.programmaticEvidence) {
        d.evidenceReceiptIds = d.evidenceReceiptIds.length
          ? d.evidenceReceiptIds
          : [`${ID_PREFIX}hand-${d.domainId}`]
        d.evidenceReceiptHashes = d.evidenceReceiptHashes.length
          ? d.evidenceReceiptHashes
          : [`${ID_PREFIX}handhash-${d.domainId}`]
      }
    } else {
      d.programmaticEvidence = Boolean(scenario.programmaticEvidence)
    }
  }
  return out
}

/** Deterministic full pack manifest (JSON-serializable). */
export function buildDeterministicPackManifest() {
  const manifest = loadManifest()
  const pin = loadPin()
  const classification = loadClassificationMatrix()
  const distinct = loadDistinctSeeds()
  const lifeValid = loadLifecycleValid()
  const lifeNeg = loadLifecycleNegatives()
  const g5 = loadG5Domains()
  const capacity = loadCapacityMatrix()
  const priority = loadPriorityMatrix()
  const reconciler = loadReconcilerPacket()
  const cleanup = loadCleanupRules()

  const body = {
    fixtureId: manifest.fixtureId,
    version: manifest.version,
    boardId: manifest.boardId,
    schemaVersionExpected: manifest.schemaVersionExpected,
    syntheticOnly: true,
    productionDerived: false,
    pin,
    packets: {
      classification: {
        packetId: classification.packetId,
        rowCount: classification.rows.length,
        taskIds: classification.rows.map((r) => r.taskId).sort(),
      },
      distinct: {
        seeds: distinct.map((d) => ({
          packetId: d.packetId,
          name: d.name,
          expectOk: d.expect.ok,
          rejectCode: d.expect.rejectCode,
        })),
      },
      lifecycle: {
        valid: { packetId: lifeValid.packetId, toStage: lifeValid.expect.toStage },
        negatives: {
          packetId: lifeNeg.packetId,
          cases: lifeNeg.cases.map((c) => ({
            id: c.id,
            kind: c.kind,
            expectErrorCode: c.expectErrorCode,
          })),
        },
      },
      g5: {
        packetId: g5.packetId,
        requiredDomains: g5.requiredDomains,
        scenarioIds: g5.scenarios.map((s) => s.id),
      },
      capacity: {
        packetId: capacity.packetId,
        scenarioIds: capacity.scenarios.map((s) => s.id),
      },
      priority: {
        packetId: priority.packetId,
        scenarioIds: priority.scenarios.map((s) => s.id),
      },
      reconciler: {
        packetId: reconciler.packetId,
        scenarioIds: reconciler.scenarios.map((s) => s.id),
      },
    },
    cleanup: {
      idPrefix: cleanup.idPrefix,
      rules: cleanup.rules.map((r) => r.id),
      plan: cleanup.cleanupPlanTemplate,
    },
  }

  const stable = stableStringify(body)
  const packHash = createHash('sha256').update(stable).digest('hex')
  return { ...body, packHash, generatedBy: 'qa/fixtures/staging/gates/contract.mjs' }
}

/** Deterministic cleanup plan JSON (no SQL execution). */
export function buildCleanupPlan(boardId = loadManifest().boardId) {
  const rules = loadCleanupRules()
  const classRows = loadClassificationMatrix().rows.map((r) => r.taskId)
  const lifeTask = loadLifecycleValid().task.taskId
  const reconRuns =
    loadReconcilerPacket().scenarios
      .find((s) => s.id === 'dry_run_apply_idempotent')
      ?.runs?.map((r) => r.runId) ?? []

  return {
    mode: 'plan-only',
    boardId,
    idPrefix: rules.idPrefix,
    generatedAt: '1970-01-01T00:00:00.000Z', // fixed for determinism in self-tests
    deterministic: true,
    steps: [
      { action: 'DELETE_RUNS', match: { boardId, runIdPrefix: ID_PREFIX }, ids: reconRuns },
      {
        action: 'DELETE_STAGE_EVIDENCE',
        match: { boardId, receiptIdPrefix: ID_PREFIX },
      },
      {
        action: 'DELETE_G5_DOMAIN_EVIDENCE',
        match: { boardId, evidencePrefix: ID_PREFIX },
      },
      {
        action: 'DELETE_CLASSIFICATION',
        match: { boardId, taskIds: classRows },
      },
      {
        action: 'DELETE_TASKS',
        match: { boardId, taskIds: [...classRows, lifeTask].sort() },
      },
      {
        action: 'CLEAR_RECONCILER_HASHES',
        match: { boardId, onlyIfPacketScoped: true },
      },
    ],
    forbidden: ['DROP DATABASE', 'production host mutation', 'print secrets'],
    note: 'Plan only — seed-gates.mjs never executes cleanup SQL without CAIRN_GATES_APPLY=1',
  }
}

export function stableStringify(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value)
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`
  const keys = Object.keys(value).sort()
  return `{${keys.map((k) => `${JSON.stringify(k)}:${stableStringify(value[k])}`).join(',')}}`
}

function listFixtureFiles(dir = __dirname, acc = []) {
  for (const name of readdirSync(dir).sort()) {
    const p = join(dir, name)
    const st = statSync(p)
    if (st.isDirectory()) listFixtureFiles(p, acc)
    else if (/\.(json|mjs|md)$/.test(name)) acc.push(relative(__dirname, p))
  }
  return acc
}

/**
 * Pure self-tests — no product imports (so Node can run without TS path aliases).
 * Product engine checks live in tests/unit/staging-gates*.test.ts.
 */
export function runGateContractSelfTests() {
  const failures = []
  const checks = []

  function ok(name, cond, detail = null) {
    checks.push({ name, ok: Boolean(cond), detail })
    if (!cond) failures.push({ name, detail })
  }

  const manifest = loadManifest()
  ok('manifest.fixtureId', manifest.fixtureId === FIXTURE_ID)
  ok('manifest.syntheticOnly', manifest.syntheticOnly === true)
  ok('manifest.productionDerived_false', manifest.productionDerived === false)
  ok('manifest.schema_008', manifest.schemaVersionExpected === '008')
  ok('manifest.idPrefix', manifest.idPrefix === ID_PREFIX)
  ok(
    'manifest.packets',
    Array.isArray(manifest.packets) &&
      manifest.packets.includes('classification') &&
      manifest.packets.includes('g5') &&
      manifest.packets.includes('reconciler'),
  )

  const pin = pinTuple()
  ok('pin.boardRev', pin.boardRev === 7)
  ok('pin.lifecycleRev', pin.lifecycleRev === 3)
  ok('pin.canonicalHash_len', typeof pin.canonicalHash === 'string' && pin.canonicalHash.length >= 32)

  const policy = loadSeedPolicy()
  ok('policy.defaultMode_self-test', policy.defaultMode === 'self-test')
  ok('policy.syntheticOnly', policy.syntheticOnly === true)
  ok('policy.no_drop', policy.dropDatabase === false)
  ok(
    'policy.live_apply_requires_dual_gate',
    policy.requiredEnvForLiveApply?.CAIRN_STAGING_SEED_APPROVED === '1' &&
      policy.requiredEnvForLiveApply?.CAIRN_GATES_APPLY === '1',
  )

  // Classification matrix completeness — full class × disposition grid (3×4)
  const classMatrix = loadClassificationMatrix()
  const classEnums = ['PRODUCT', 'CONTROL_PLANE', 'UNCLASSIFIED']
  const dispEnums = ['ACTIVE', 'HOLD', 'EXCLUDE', 'UNCLASSIFIED']
  const classPairs = new Set(
    classMatrix.rows.map((r) => `${r.taskClass}×${r.disposition}`),
  )
  for (const c of classEnums) {
    for (const d of dispEnums) {
      ok(`class.cross_product.${c}×${d}`, classPairs.has(`${c}×${d}`))
    }
  }
  ok('class.has_CONTROL_PLANE×HOLD', classPairs.has('CONTROL_PLANE×HOLD'))
  ok('class.has_UNCLASSIFIED×UNCLASSIFIED', classPairs.has('UNCLASSIFIED×UNCLASSIFIED'))
  ok(
    'class.has_stale_or_missing',
    classMatrix.rows.some((r) => r.receiptMode === 'stale_board_rev') &&
      classMatrix.rows.some((r) => r.receiptMode === 'missing'),
  )
  ok(
    'class.ids_prefixed',
    classMatrix.rows.every((r) => r.taskId.startsWith(ID_PREFIX)),
  )
  ok(
    'class.uc_uc_data_integrity',
    classMatrix.rows.some(
      (r) =>
        r.taskClass === 'UNCLASSIFIED' &&
        r.disposition === 'UNCLASSIFIED' &&
        r.expect?.blockReason === 'DATA_INTEGRITY' &&
        r.expect?.isClassificationRepair === true,
    ),
  )
  ok(
    'class.cp_hold_outside_tracked',
    classMatrix.rows.some(
      (r) =>
        r.taskClass === 'CONTROL_PLANE' &&
        r.disposition === 'HOLD' &&
        r.expect?.isOutsideTrackedWork === true &&
        r.expect?.isFullyClassifiedValid === true,
    ),
  )

  // Distinct seeds
  const distinct = loadDistinctSeeds()
  ok('distinct.count_ge_4', distinct.length >= 4)
  const codes = new Set(distinct.map((d) => d.expect.rejectCode).filter(Boolean))
  ok('distinct.dup_fc', codes.has('DUPLICATE_FC_JOIN'))
  ok('distinct.dup_node', codes.has('DUPLICATE_NODE_JOIN'))
  ok('distinct.dup_dep', codes.has('DUPLICATE_DEPENDENCY_JOIN'))
  ok('distinct.dup_id', codes.has('DUPLICATE_ID'))
  ok('distinct.has_valid', distinct.some((d) => d.expect.ok === true))

  // Lifecycle
  const lifeValid = loadLifecycleValid()
  ok('life.valid_MAPPING', lifeValid.expect.toStage === 'MAPPING' && lifeValid.expect.ok === true)
  const lifeNeg = loadLifecycleNegatives()
  const negKinds = new Set(lifeNeg.cases.map((c) => c.kind))
  const negIds = new Set(lifeNeg.cases.map((c) => c.id))
  ok('life.neg_skip', negKinds.has('skip'))
  ok('life.neg_stale', negKinds.has('stale'))
  ok('life.neg_self_verify', negKinds.has('self-verify'))
  ok('life.neg_fence', negKinds.has('fence'))
  ok('life.neg_stale_lifecycle_rev', negIds.has('stale_lifecycle_rev'))
  ok('life.neg_stale_entity_rev', negIds.has('stale_entity_rev'))
  ok('life.neg_missing_evidence_fields', negIds.has('missing_evidence_fields'))
  ok(
    'life.neg_codes',
    lifeNeg.cases.some((c) => c.expectErrorCode === 'INVALID_TRANSITION') &&
      lifeNeg.cases.some((c) => c.expectErrorCode === 'STALE_REVISION') &&
      lifeNeg.cases.some((c) => c.expectErrorCode === 'SELF_VERIFICATION') &&
      lifeNeg.cases.some((c) => c.expectErrorCode === 'FENCED') &&
      lifeNeg.cases.some((c) => c.expectErrorCode === 'MISSING_EVIDENCE'),
  )

  // G5 nine domains
  const g5 = loadG5Domains()
  ok('g5.nine_domains', g5.requiredDomains.length === 9)
  ok(
    'g5.statuses_honest',
    g5.allowedStatusesFromFixtures.every((s) =>
      ['NOT_STARTED', 'IN_PROGRESS', 'PASS'].includes(s),
    ),
  )
  ok(
    'g5.has_not_started_in_progress_pass',
    g5.scenarios.some((s) => s.id === 'all_not_started') &&
      g5.scenarios.some((s) => s.id === 'all_in_progress') &&
      g5.scenarios.some((s) => s.id === 'nine_pass_programmatic') &&
      g5.scenarios.some((s) => s.id === 'nine_pass_handtyped'),
  )
  const passProg = buildG5DomainsForScenario(
    g5.scenarios.find((s) => s.id === 'nine_pass_programmatic'),
    pin,
  )
  ok('g5.pass_prog_len_9', passProg.length === 9)
  ok(
    'g5.pass_prog_flags',
    passProg.every((d) => d.status === 'PASS' && d.programmaticEvidence === true),
  )
  const hand = buildG5DomainsForScenario(
    g5.scenarios.find((s) => s.id === 'nine_pass_handtyped'),
    pin,
  )
  ok(
    'g5.handtyped_not_programmatic',
    hand.every((d) => d.status === 'PASS' && d.programmaticEvidence === false),
  )

  // Capacity / priority
  const cap = loadCapacityMatrix()
  const capIds = new Set(cap.scenarios.map((s) => s.id))
  ok('cap.zero', capIds.has('zero_capacity_stale'))
  ok('cap.floor', capIds.has('below_floor'))
  ok('cap.majority', capIds.has('majority_open'))
  ok('cap.fail_safe', capIds.has('fail_safe'))

  const pri = loadPriorityMatrix()
  const priIds = new Set(pri.scenarios.map((s) => s.id))
  ok('pri.no_frontier', priIds.has('no_frontier'))
  ok('pri.zero', priIds.has('zero_capacity'))
  ok('pri.majority', priIds.has('majority'))
  ok('pri.fail_safe', priIds.has('fail_safe_non_majority'))

  // Reconciler
  const rec = loadReconcilerPacket()
  const recHappy = rec.scenarios.find((s) => s.id === 'dry_run_apply_idempotent')
  ok('rec.idempotent_scenario', Boolean(recHappy))
  ok('rec.maxActions_100', recHappy?.expect?.maxActions === 100)
  ok(
    'rec.wrongHashCode',
    recHappy?.expect?.wrongHashCode === 'DRY_RUN_HASH_MISMATCH',
  )
  ok('rec.notLeaderCode', recHappy?.expect?.notLeaderCode === 'NOT_LEADER')

  // Deterministic expected outputs (not empty placeholder)
  const expectedClass = readJson('expected/classification-cross-product.json')
  const expectedLife = readJson('expected/lifecycle-negatives.json')
  const expectedRec = readJson('expected/reconciler-negatives.json')
  ok(
    'expected.class.cells_12',
    Array.isArray(expectedClass.requiredCells) &&
      expectedClass.requiredCells.length === 12,
  )
  ok(
    'expected.class.matches_matrix',
    expectedClass.requiredCells.every((cell) => classPairs.has(cell)),
  )
  ok(
    'expected.life.case_ids',
    Array.isArray(expectedLife.cases) &&
      expectedLife.cases.some((c) => c.id === 'stale_lifecycle_rev') &&
      expectedLife.cases.some((c) => c.id === 'stale_entity_rev') &&
      expectedLife.cases.some((c) => c.id === 'missing_evidence_fields'),
  )
  ok(
    'expected.life.codes_match_fixture',
    expectedLife.cases.every((ec) => {
      const fc = lifeNeg.cases.find((c) => c.id === ec.id)
      return fc && fc.expectErrorCode === ec.expectErrorCode
    }),
  )
  ok(
    'expected.rec.codes',
    expectedRec.wrongHashCode === 'DRY_RUN_HASH_MISMATCH' &&
      expectedRec.notLeaderCode === 'NOT_LEADER',
  )

  // Deterministic pack hash stability
  const m1 = buildDeterministicPackManifest()
  const m2 = buildDeterministicPackManifest()
  ok('packHash.stable', m1.packHash === m2.packHash && m1.packHash.length === 64)

  const cleanup = buildCleanupPlan()
  ok('cleanup.plan_only', cleanup.mode === 'plan-only')
  ok('cleanup.prefix', cleanup.idPrefix === ID_PREFIX)
  ok('cleanup.no_drop', cleanup.forbidden.includes('DROP DATABASE'))
  ok('cleanup.deterministic_timestamp', cleanup.generatedAt === '1970-01-01T00:00:00.000Z')

  // Files exist inventory
  const files = listFixtureFiles()
  ok('files.has_contract', files.includes('contract.mjs'))
  ok('files.has_manifest', files.includes('MANIFEST.json'))
  ok('files.has_expected_class', files.includes('expected/classification-cross-product.json'))
  ok('files.has_expected_life', files.includes('expected/lifecycle-negatives.json'))
  ok('files.has_expected_rec', files.includes('expected/reconciler-negatives.json'))
  ok('files.min_count', files.length >= 18)

  return {
    ok: failures.length === 0,
    fixtureId: FIXTURE_ID,
    checks,
    failures,
    packHash: m1.packHash,
    fileCount: files.length,
    files,
  }
}

/** True when this module is the node CLI entrypoint. */
export function isContractCliMain() {
  try {
    const self = fileURLToPath(import.meta.url)
    const arg = process.argv[1]
    if (!arg) return false
    const absArg = arg.startsWith('/') ? arg : join(process.cwd(), arg)
    return self === absArg || absArg.endsWith('/qa/fixtures/staging/gates/contract.mjs')
  } catch {
    return false
  }
}

export function runContractCli(argv = process.argv.slice(2)) {
  const mode = argv.includes('--manifest')
    ? 'manifest'
    : argv.includes('--cleanup')
      ? 'cleanup'
      : 'self-test'
  if (mode === 'manifest') {
    console.log(JSON.stringify(buildDeterministicPackManifest(), null, 2))
    return 0
  }
  if (mode === 'cleanup') {
    console.log(JSON.stringify(buildCleanupPlan(), null, 2))
    return 0
  }
  const r = runGateContractSelfTests()
  console.log(JSON.stringify(r, null, 2))
  return r.ok ? 0 : 1
}

if (isContractCliMain()) {
  process.exit(runContractCli())
}
