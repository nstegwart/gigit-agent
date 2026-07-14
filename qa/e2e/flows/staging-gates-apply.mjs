#!/usr/bin/env node
/**
 * Staging gate apply driver — product MCP only (no seed-synthetic / raw SQL).
 *
 * Modes:
 *   --self-test | (default)   pure apply-adapter self-tests (no network)
 *   --plan                    emit ordered apply step plan (no mutation)
 *   --apply | --real          requires dual gates + CAIRN_GATES_BIND_LIVE_PIN=1;
 *                             still plan-only unless CAIRN_GATES_EXECUTE=1
 *
 * Execute (CAIRN_GATES_EXECUTE=1):
 *   STAGING_URL, BOARD_ID, dual bearers (ROOT + AGENT), EXPECTED_SHA optional
 *   Sequence: live pin re-read → replace_board_snapshot dryRun + additive proof
 *             → apply → lifecycle register/submit/advance → capacity/reconciler
 *             → G5 fail-closed → prefix cleanup audit
 *
 * Never prints credentials. Never fabricates stage/G5 receipt hashes.
 *
 * See docs/control-center/STAGING_GATE_FIXTURES.md
 */
import { mkdirSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '../../..')
const ADAPTER = join(ROOT, 'qa/fixtures/staging/gates/apply-adapter.mjs')

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')))
  const apply = flags.has('--apply') || flags.has('--real')
  return {
    selfTest:
      flags.has('--self-test') ||
      (!flags.has('--plan') && !apply),
    plan: flags.has('--plan'),
    apply,
    fromSeedGates: flags.has('--from-seed-gates'),
    help: flags.has('--help') || flags.has('-h'),
  }
}

function printHelp() {
  console.log(`Usage:
  node qa/e2e/flows/staging-gates-apply.mjs --self-test
  node qa/e2e/flows/staging-gates-apply.mjs --plan
  node qa/e2e/flows/staging-gates-apply.mjs --apply   # dual gates + live pin; plan unless EXECUTE=1

Env (execute):
  CAIRN_ENV=staging CAIRN_DB_NAME=cairn_tm_v3_staging
  CAIRN_STAGING_SEED_APPROVED=1 CAIRN_GATES_APPLY=1 CAIRN_GATES_BIND_LIVE_PIN=1
  CAIRN_GATES_EXECUTE=1
  STAGING_URL  STAGING_ROOT_BEARER_TOKEN  STAGING_AGENT_BEARER_TOKEN  STAGING_AGENT_ID
  BOARD_ID (default mfs-rebuild)  EXPECTED_SHA (optional fail-closed)

See docs/control-center/STAGING_GATE_FIXTURES.md
`)
}

function writeReceipt(payload) {
  const outDir = join(ROOT, 'qa/e2e/out/runtime')
  try {
    mkdirSync(outDir, { recursive: true })
    const name = `staging-gates-apply-${payload.mode}-${Date.now()}.json`
    const path = join(outDir, name)
    const text = JSON.stringify(payload, null, 2)
    if (/Bearer\s+[A-Za-z0-9._\-+/=]{20,}/i.test(text) || /"secret"\s*:/i.test(text)) {
      throw new Error('REFUSING to write receipt: bearer-like material detected')
    }
    writeFileSync(path, text, { mode: 0o600 })
    return path
  } catch (e) {
    console.error('receipt write skipped:', String(e?.message || e))
    return null
  }
}

function ownerTargetLine(args, env = process.env) {
  return {
    base_url: args.apply ? env.STAGING_URL || null : 'mock://self-test',
    port: 'n/a',
    account: 'dual ROOT+AGENT (env refs only)',
    device: 'n/a',
    boardId: env.BOARD_ID || 'mfs-rebuild',
    schema: env.SCHEMA_VERSION || '006',
    expectedSha: env.EXPECTED_SHA || null,
    gatesExecute: env.CAIRN_GATES_EXECUTE === '1',
  }
}

/**
 * Resolve bearer by env name candidates — never log values.
 */
function resolveBearer(env, candidates, explicitRef) {
  const list = explicitRef
    ? [explicitRef, ...candidates.filter((c) => c !== explicitRef)]
    : [...candidates]
  for (const name of list) {
    const val = env[name]
    if (typeof val === 'string' && val.trim().length > 0) {
      return { ok: true, tokenRef: name, bearer: val.trim() }
    }
  }
  return {
    ok: false,
    tokenRef: list[0],
    bearer: null,
    reason: `missing bearer — set one of ${list.join('|')}`,
  }
}

async function loadAdapter() {
  return import(pathToFileURL(ADAPTER).href)
}

/**
 * Authenticated healthz pin probe (optional fetchImpl for tests).
 * Fail-closed on HTTP/JSON failure AND on invalid pin shape (boardRev/lifecycleRev).
 * Shape validation uses apply-adapter.validateHealthzPinShape.
 */
async function probeLivePin(baseUrl, bearer, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const validateShape = opts.validateHealthzPinShape
  const url = `${String(baseUrl).replace(/\/$/, '')}/api/healthz`
  const res = await fetchImpl(url, {
    headers: bearer ? { authorization: `Bearer ${bearer}` } : {},
  })
  const text = await res.text()
  let body = null
  try {
    body = JSON.parse(text)
  } catch {
    body = null
  }
  if (!res.ok || !body) {
    return {
      ok: false,
      code: 'HEALTHZ_PROBE_FAILED',
      httpStatus: res.status,
      message: 'healthz probe failed or non-JSON',
    }
  }
  if (typeof validateShape === 'function') {
    const shape = validateShape(body)
    if (!shape.ok) {
      return {
        ok: false,
        code: shape.code || 'HEALTHZ_PIN_SHAPE_INVALID',
        httpStatus: res.status,
        message: shape.message,
        missing: shape.missing,
        rawKeys: Object.keys(body).slice(0, 40),
      }
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
  const canonicalHash =
    (typeof body.canonicalHash === 'string' && body.canonicalHash) ||
    (typeof body.pin?.canonicalHash === 'string' && body.pin.canonicalHash) ||
    (typeof body.subjectHash === 'string' && body.subjectHash) ||
    null
  return {
    ok: true,
    source: 'live',
    deployedSha: body.deployedSha ?? body.release?.sha ?? null,
    schemaVersion: body.schema?.version ?? body.schemaVersion ?? null,
    schemaMatch: body.schema?.match ?? null,
    boardRev,
    lifecycleRev,
    canonicalHash,
    canonicalSnapshotId: body.canonicalSnapshotId ?? body.pin?.canonicalSnapshotId ?? null,
    taskHash: body.taskHash ?? body.pin?.taskHash ?? canonicalHash,
    entityRev: body.entityRev ?? body.pin?.entityRev ?? 0,
    rawKeys: Object.keys(body).slice(0, 40),
  }
}

/**
 * MCP tools/call helper — secrets stay in memory.
 */
async function mcpToolsCall(baseUrl, name, args, bearer, opts = {}) {
  const fetchImpl = opts.fetchImpl ?? globalThis.fetch
  const url = `${String(baseUrl).replace(/\/$/, '')}/mcp`
  const res = await fetchImpl(url, {
    method: 'POST',
    headers: {
      accept: 'application/json, text/event-stream',
      'content-type': 'application/json',
      authorization: `Bearer ${bearer}`,
    },
    body: JSON.stringify({
      jsonrpc: '2.0',
      id: opts.id ?? Date.now(),
      method: 'tools/call',
      params: { name, arguments: args },
    }),
  })
  const text = await res.text()
  let parsed = null
  try {
    parsed = JSON.parse(text)
  } catch {
    // SSE-ish: try last JSON object
    const m = text.match(/\{[\s\S]*\}\s*$/)
    if (m) {
      try {
        parsed = JSON.parse(m[0])
      } catch {
        parsed = null
      }
    }
  }
  let toolJson = null
  const content = parsed?.result?.content
  if (Array.isArray(content)) {
    const t = content.find((c) => c?.type === 'text')?.text
    if (typeof t === 'string') {
      try {
        toolJson = JSON.parse(t)
      } catch {
        toolJson = { text: t.slice(0, 500) }
      }
    }
  }
  return {
    httpStatus: res.status,
    ok: res.ok,
    parsed,
    toolJson,
    isError: parsed?.result?.isError === true || toolJson?.ok === false,
  }
}

/**
 * Extract list of {id} from list_tasks / overview-ish tool results for additive proof.
 */
function extractDefinitionSnapshot(toolJson) {
  const tasks = []
  const projects = []
  const features = []
  const data = toolJson?.data ?? toolJson
  const taskList = data?.tasks ?? data?.items ?? toolJson?.tasks ?? []
  if (Array.isArray(taskList)) {
    for (const t of taskList) {
      if (t && t.id) tasks.push({ id: String(t.id), title: t.title ?? t.nama ?? null })
    }
  }
  const projList = data?.projects ?? toolJson?.projects ?? []
  if (Array.isArray(projList)) {
    for (const p of projList) {
      if (p && p.id) projects.push({ id: String(p.id), name: p.name ?? p.nama ?? null })
    }
  }
  const featList = data?.features ?? data?.flows ?? toolJson?.features ?? []
  if (Array.isArray(featList)) {
    for (const f of featList) {
      if (f && f.id) features.push({ id: String(f.id), projectId: f.projectId ?? null })
    }
  }
  return { projects, features, tasks }
}

/**
 * Execute authenticated apply sequence. Fail closed on missing tools/proof.
 */
async function executeLiveApply(adapter, env = process.env) {
  const stepsLog = []
  const residual_gaps = []

  const gate = adapter.checkApplyGates(env)
  if (!gate.ok) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: gate.code || 'CAIRN_GATES_APPLY_REFUSED',
      message: gate.message,
      missing: gate.missing,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['gates_not_satisfied'],
    }
  }

  const baseUrl = env.STAGING_URL?.trim()
  if (!baseUrl) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'STAGING_URL_REQUIRED',
      message: 'STAGING_URL required for CAIRN_GATES_EXECUTE=1',
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['missing_staging_url'],
    }
  }

  const root = resolveBearer(
    env,
    ['STAGING_ROOT_BEARER_TOKEN', 'STAGING_BEARER_TOKEN', 'STAGING_BEARER', 'CAIRN_MCP_BEARER'],
    env.STAGING_ROOT_BEARER_TOKEN_REF?.trim(),
  )
  const agent = resolveBearer(
    env,
    ['STAGING_AGENT_BEARER_TOKEN'],
    env.STAGING_AGENT_BEARER_TOKEN_REF?.trim(),
  )
  if (!root.ok) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'MISSING_ROOT_BEARER',
      message: root.reason,
      tokenRef: root.tokenRef,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['missing_root_bearer'],
    }
  }
  if (!agent.ok) {
    return {
      ok: false,
      mode: 'apply-refused',
      code: 'MISSING_AGENT_BEARER',
      message: agent.reason,
      tokenRef: agent.tokenRef,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['missing_agent_bearer'],
    }
  }

  const boardId = env.BOARD_ID || 'mfs-rebuild'
  const expectedSha = env.EXPECTED_SHA || null

  // 1) Live pin re-read — healthz pin-shape fail-closed BEFORE any plan/execute mutation
  const pinProbe = await probeLivePin(baseUrl, root.bearer, {
    validateHealthzPinShape: adapter.validateHealthzPinShape,
  })
  stepsLog.push({
    step: 'preflight_live_pin',
    ok: pinProbe.ok,
    code: pinProbe.code || null,
    boardRev: pinProbe.boardRev,
    lifecycleRev: pinProbe.lifecycleRev,
    deployedSha: pinProbe.deployedSha,
    missing: pinProbe.missing || null,
  })
  if (!pinProbe.ok) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: pinProbe.code,
      message: pinProbe.message,
      stagingMutation: false,
      stepsLog,
      residual_gaps: [
        pinProbe.code === 'HEALTHZ_PIN_SHAPE_INVALID'
          ? 'healthz_pin_shape_invalid'
          : 'live_pin_unreadable',
      ],
    }
  }
  if (expectedSha && pinProbe.deployedSha && pinProbe.deployedSha !== expectedSha) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: 'DEPLOYED_SHA_MISMATCH',
      message: `EXPECTED_SHA ${expectedSha} != deployed ${pinProbe.deployedSha}`,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['deploy_sha_mismatch'],
    }
  }

  let livePin = {
    source: 'live',
    boardRev: pinProbe.boardRev,
    lifecycleRev: pinProbe.lifecycleRev,
    canonicalHash: pinProbe.canonicalHash,
    canonicalSnapshotId: pinProbe.canonicalSnapshotId,
    taskHash: pinProbe.taskHash || pinProbe.canonicalHash,
    entityRev: pinProbe.entityRev ?? 0,
  }

  // Product healthz may omit canonicalHash even when control-plane pin exists.
  // Fill subject hash via get_overview before any mutation (fail closed if still missing).
  if (!livePin.canonicalHash) {
    const overview = await mcpToolsCall(
      baseUrl,
      'get_overview',
      { boardId },
      root.bearer,
    )
    const ov = overview.toolJson?.data ?? overview.toolJson ?? {}
    const hash =
      ov.canonicalHash ||
      ov.pin?.canonicalHash ||
      ov.subjectHash ||
      ov.hash ||
      null
    const br =
      typeof ov.boardRev === 'number'
        ? ov.boardRev
        : typeof ov.pin?.boardRev === 'number'
          ? ov.pin.boardRev
          : livePin.boardRev
    const lr =
      typeof ov.lifecycleRev === 'number'
        ? ov.lifecycleRev
        : typeof ov.pin?.lifecycleRev === 'number'
          ? ov.pin.lifecycleRev
          : livePin.lifecycleRev
    if (hash) {
      livePin = {
        ...livePin,
        boardRev: br,
        lifecycleRev: lr,
        canonicalHash: String(hash),
        taskHash: livePin.taskHash || String(hash),
        source: 'live+get_overview',
      }
    }
    stepsLog.push({
      step: 'preflight_pin_hash_fill',
      ok: Boolean(hash),
      source: 'get_overview',
      hasCanonicalHash: Boolean(hash),
    })
  }

  const mutPin = adapter.validateLivePinForMutation(livePin)
  if (!mutPin.ok) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: mutPin.code || 'GATES_LIVE_PIN_INCOMPLETE',
      message: mutPin.message,
      missing: mutPin.missing,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['live_pin_incomplete_for_mutation'],
    }
  }

  // 2) Before snapshot for additive proof (list_tasks)
  const listBefore = await mcpToolsCall(
    baseUrl,
    'list_tasks',
    { boardId },
    root.bearer,
  )
  const beforeSnap = extractDefinitionSnapshot(listBefore.toolJson || {})
  stepsLog.push({
    step: 'readback_before',
    ok: listBefore.ok && !listBefore.isError,
    taskCount: beforeSnap.tasks.length,
  })

  // 3) Build definition payload (prefix-only seed)
  const seed = adapter.loadValidDistinctSeed()
  const canon = adapter.distinctSeedToCanonicalInput(seed, {
    snapshotId: `${adapter.ID_PREFIX}snap-${(pinProbe.deployedSha || 'live').slice(0, 12)}`,
    sourceCommitSha:
      pinProbe.deployedSha && /^[a-f0-9]{7,64}$/i.test(pinProbe.deployedSha)
        ? pinProbe.deployedSha.toLowerCase()
        : seed.input.sourceCommitSha,
  })
  // Additive merge: seed tasks only onto live non-prefix entities
  const merged = adapter.mergeAdditiveDefinition(beforeSnap, {
    projects: canon.projects,
    features: canon.flows,
    tasks: canon.tasks,
  })
  const proofPre = adapter.proveAdditivePrefixUnchanged(beforeSnap, merged)
  stepsLog.push({
    step: 'additive_proof_pre',
    ok: proofPre.ok,
    violations: proofPre.violations,
  })
  if (!proofPre.ok) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: 'ADDITIVE_PREFIX_PROOF_FAILED',
      message: 'Refusing apply: additive prefix proof failed before dryRun',
      proof: proofPre,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['additive_proof_failed'],
    }
  }

  const packHash = 'live'
  const dryKey = adapter.buildIdempotencyKey({
    expectedSha: pinProbe.deployedSha || 'nosha',
    packHash,
    step: 'definition_dry_run',
  })
  const dryEnvelope = adapter.buildMutationEnvelopeSkeleton(livePin, dryKey)
  const replaceBase = adapter.canonicalInputToReplaceBoardArgs(
    {
      ...canon,
      projects: merged.projects.filter((p) => String(p.id).startsWith(adapter.ID_PREFIX)),
      flows: (canon.flows || []).filter((f) => String(f.id).startsWith(adapter.ID_PREFIX)),
      tasks: merged.tasks.filter((t) => String(t.id).startsWith(adapter.ID_PREFIX)),
    },
    { dryRun: true },
  )
  // Prefer full merged collections when MCP replace is full-snapshot semantics —
  // proof already established non-prefix preserved in merged model. Driver sends
  // merged projects/features/tasks so non-prefix are present in payload.
  const replaceMerged = {
    ...replaceBase,
    projects: merged.projects.map((p) => ({
      id: p.id,
      nama: p.name ?? p.nama ?? p.id,
      name: p.name ?? p.nama ?? p.id,
      status: p.status ?? 'active',
    })),
    features: (merged.features || []).map((f) => ({
      id: f.id,
      projectId: f.projectId,
      name: f.name ?? f.id,
    })),
    tasks: merged.tasks.map((t) => ({
      id: t.id,
      title: t.title ?? null,
      projectId: t.projectId ?? null,
    })),
    dryRun: true,
    boardId,
    entityExpectedRev: dryEnvelope.entityExpectedRev,
    expectedBoardRev: dryEnvelope.expectedBoardRev,
    subjectHash: dryEnvelope.subjectHash,
    canonicalHash: dryEnvelope.canonicalHash,
    idempotencyKey: dryEnvelope.idempotencyKey,
  }

  const dryRes = await mcpToolsCall(
    baseUrl,
    'replace_board_snapshot',
    replaceMerged,
    root.bearer,
  )
  stepsLog.push({
    step: 'definition_dry_run',
    ok: dryRes.ok && !dryRes.isError && dryRes.toolJson?.ok !== false,
    httpStatus: dryRes.httpStatus,
    code: dryRes.toolJson?.code || null,
  })
  if (!dryRes.ok || dryRes.isError || dryRes.toolJson?.ok === false) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: dryRes.toolJson?.code || 'DEFINITION_DRY_RUN_FAILED',
      message: dryRes.toolJson?.error || 'replace_board_snapshot dryRun failed',
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['definition_dry_run_failed'],
    }
  }

  // Re-read pin before apply (shape-validated)
  const pin2 = await probeLivePin(baseUrl, root.bearer, {
    validateHealthzPinShape: adapter.validateHealthzPinShape,
  })
  if (pin2.ok && pin2.boardRev != null) {
    livePin = {
      ...livePin,
      boardRev: pin2.boardRev,
      lifecycleRev: pin2.lifecycleRev ?? livePin.lifecycleRev,
      canonicalHash: pin2.canonicalHash || livePin.canonicalHash,
      taskHash: pin2.taskHash || livePin.taskHash,
      entityRev: pin2.entityRev ?? livePin.entityRev,
    }
  }
  const mutPin2 = adapter.validateLivePinForMutation(livePin)
  if (!mutPin2.ok) {
    return {
      ok: false,
      mode: 'apply-blocked',
      code: mutPin2.code || 'GATES_LIVE_PIN_INCOMPLETE',
      message: mutPin2.message,
      stagingMutation: false,
      stepsLog,
      residual_gaps: ['live_pin_incomplete_before_definition_apply'],
    }
  }

  const applyKey = adapter.buildIdempotencyKey({
    expectedSha: pinProbe.deployedSha || 'nosha',
    packHash,
    step: 'definition_apply',
  })
  const applyEnvelope = adapter.buildMutationEnvelopeSkeleton(livePin, applyKey)
  const applyArgs = {
    ...replaceMerged,
    dryRun: false,
    entityExpectedRev: applyEnvelope.entityExpectedRev,
    expectedBoardRev: applyEnvelope.expectedBoardRev,
    subjectHash: applyEnvelope.subjectHash,
    canonicalHash: applyEnvelope.canonicalHash,
    idempotencyKey: applyEnvelope.idempotencyKey,
  }
  const applyRes = await mcpToolsCall(
    baseUrl,
    'replace_board_snapshot',
    applyArgs,
    root.bearer,
  )
  const applyOk = applyRes.ok && !applyRes.isError && applyRes.toolJson?.ok !== false
  stepsLog.push({
    step: 'definition_apply',
    ok: applyOk,
    httpStatus: applyRes.httpStatus,
    code: applyRes.toolJson?.code || null,
    boardRev: applyRes.toolJson?.import?.boardRev ?? null,
  })

  // Post-apply additive readback
  const listAfter = await mcpToolsCall(baseUrl, 'list_tasks', { boardId }, root.bearer)
  const afterSnap = extractDefinitionSnapshot(listAfter.toolJson || {})
  const proofPost = adapter.proveAdditivePrefixUnchanged(beforeSnap, afterSnap)
  stepsLog.push({
    step: 'additive_proof_post',
    ok: proofPost.ok,
    violations: proofPost.violations,
  })
  if (!proofPost.ok) {
    residual_gaps.push('post_apply_non_prefix_drift')
  }

  // 4) Lifecycle via AGENT register → submit_stage_evidence → advance_task
  let lifecycleOk = false
  if (applyOk) {
    const pin3 = await probeLivePin(baseUrl, root.bearer, {
      validateHealthzPinShape: adapter.validateHealthzPinShape,
    })
    if (pin3.ok) {
      livePin = {
        ...livePin,
        boardRev: pin3.boardRev ?? livePin.boardRev,
        lifecycleRev: pin3.lifecycleRev ?? livePin.lifecycleRev,
        canonicalHash: pin3.canonicalHash || livePin.canonicalHash,
        taskHash: pin3.taskHash || livePin.taskHash,
      }
    }
    // Ensure lifecycle task exists in definition — distinct seed may not include life task.
    // If missing, residual gap (life task must be in definition for advance).
    const lifeIds = afterSnap.tasks.map((t) => t.id)
    const lifePacket = adapter.loadLifecycleValid()
    if (!lifeIds.includes(lifePacket.task.taskId)) {
      residual_gaps.push('lifecycle_task_not_in_definition_import')
      stepsLog.push({
        step: 'lifecycle_skipped',
        ok: false,
        code: 'LIFECYCLE_TASK_MISSING',
        message: `task ${lifePacket.task.taskId} not present after definition import`,
      })
    } else {
      try {
        const rebound = adapter.rebindLifecycleValidToLivePin(lifePacket, {
          ...livePin,
          taskHash: livePin.taskHash || livePin.canonicalHash,
        })
        // MCP register_run requires targetGate (domain) + expectedEntityRev alias
        const regArgsBase = adapter.buildRegisterRunArgs(rebound, {
          boardId,
          agentId: env.STAGING_AGENT_ID?.trim() || rebound.authorRun.agentId,
          expectedEntityRev: livePin.entityRev ?? 0,
        })
        const registeredRunId = regArgsBase.runId
        const regKey = adapter.buildIdempotencyKey({
          expectedSha: pinProbe.deployedSha || 'nosha',
          packHash,
          step: 'lifecycle_register_author',
        })
        const regEnv = adapter.buildMutationEnvelopeSkeleton(livePin, regKey)
        const regRes = await mcpToolsCall(
          baseUrl,
          'register_run',
          {
            ...regArgsBase,
            // board-mcp register_run Zod requires expectedEntityRev; envelope also accepts entityExpectedRev
            expectedEntityRev: regEnv.entityExpectedRev,
            entityExpectedRev: regEnv.entityExpectedRev,
            expectedBoardRev: regEnv.expectedBoardRev,
            subjectHash: regEnv.subjectHash,
            canonicalHash: regEnv.canonicalHash,
            idempotencyKey: regEnv.idempotencyKey,
          },
          agent.bearer,
        )
        stepsLog.push({
          step: 'lifecycle_register_author',
          ok: regRes.ok && !regRes.isError,
          code: regRes.toolJson?.code || null,
          hasTargetGate: Boolean(regArgsBase.targetGate),
          registeredRunId,
        })

        // re-read pin
        const pin4 = await probeLivePin(baseUrl, root.bearer, {
          validateHealthzPinShape: adapter.validateHealthzPinShape,
        })
        if (pin4.ok) {
          livePin = {
            ...livePin,
            boardRev: pin4.boardRev ?? livePin.boardRev,
            lifecycleRev: pin4.lifecycleRev ?? livePin.lifecycleRev,
            canonicalHash: pin4.canonicalHash || livePin.canonicalHash,
            taskHash: pin4.taskHash || livePin.taskHash,
          }
        }
        const rebound2 = adapter.rebindLifecycleValidToLivePin(lifePacket, {
          ...livePin,
          taskHash: livePin.taskHash || livePin.canonicalHash,
        })
        // byRunId bound to the registered author run id from register_run
        const subBase = adapter.buildSubmitStageEvidenceArgs(rebound2, {
          boardId,
          byRunId: registeredRunId,
        })
        const subKey = adapter.buildIdempotencyKey({
          expectedSha: pinProbe.deployedSha || 'nosha',
          packHash,
          step: 'lifecycle_submit_stage_evidence',
        })
        const subEnv = adapter.buildMutationEnvelopeSkeleton(livePin, subKey)
        const subRes = await mcpToolsCall(
          baseUrl,
          'submit_stage_evidence',
          {
            ...subBase,
            entityExpectedRev: subEnv.entityExpectedRev,
            expectedBoardRev: subEnv.expectedBoardRev,
            subjectHash: subEnv.subjectHash,
            canonicalHash: subEnv.canonicalHash,
            idempotencyKey: subEnv.idempotencyKey,
          },
          agent.bearer,
        )
        const receiptId =
          subRes.toolJson?.receiptId ||
          subRes.toolJson?.receipt?.receiptId ||
          subRes.toolJson?.data?.receiptId
        const receiptHash =
          subRes.toolJson?.receiptHash ||
          subRes.toolJson?.receipt?.receiptHash ||
          subRes.toolJson?.data?.receiptHash
        stepsLog.push({
          step: 'lifecycle_submit_stage_evidence',
          ok: subRes.ok && !subRes.isError && Boolean(receiptId && receiptHash),
          hasServerReceipt: Boolean(receiptId && receiptHash),
          byRunId: registeredRunId,
          code: subRes.toolJson?.code || null,
        })

        if (receiptId && receiptHash) {
          const pin5 = await probeLivePin(baseUrl, root.bearer, {
            validateHealthzPinShape: adapter.validateHealthzPinShape,
          })
          if (pin5.ok) {
            livePin = {
              ...livePin,
              boardRev: pin5.boardRev ?? livePin.boardRev,
              lifecycleRev: pin5.lifecycleRev ?? livePin.lifecycleRev,
              canonicalHash: pin5.canonicalHash || livePin.canonicalHash,
            }
          }
          const advBase = adapter.buildAdvanceTaskArgs(
            rebound2,
            { receiptId, receiptHash },
            {
              boardId,
              byRunId: registeredRunId,
              registeredRunId,
            },
          )
          const advKey = adapter.buildIdempotencyKey({
            expectedSha: pinProbe.deployedSha || 'nosha',
            packHash,
            step: 'lifecycle_advance_task',
          })
          const advEnv = adapter.buildMutationEnvelopeSkeleton(livePin, advKey)
          const advRes = await mcpToolsCall(
            baseUrl,
            'advance_task',
            {
              ...advBase,
              entityExpectedRev: advEnv.entityExpectedRev,
              expectedBoardRev: advEnv.expectedBoardRev,
              subjectHash: advEnv.subjectHash,
              canonicalHash: advEnv.canonicalHash,
              idempotencyKey: advEnv.idempotencyKey,
            },
            agent.bearer,
          )
          lifecycleOk = advRes.ok && !advRes.isError && advRes.toolJson?.ok !== false
          stepsLog.push({
            step: 'lifecycle_advance_task',
            ok: lifecycleOk,
            byRunId: advBase.byRunId,
            code: advRes.toolJson?.code || null,
          })
        } else {
          residual_gaps.push('lifecycle_no_server_receipt')
        }
      } catch (e) {
        stepsLog.push({
          step: 'lifecycle_error',
          ok: false,
          code: e?.code || 'LIFECYCLE_EXCEPTION',
          message: String(e?.message || e),
        })
        residual_gaps.push('lifecycle_exception')
      }
    }
  } else {
    residual_gaps.push('definition_apply_failed_skip_lifecycle')
  }

  // 5) G5 — fail closed (read only)
  const g5plan = adapter.buildG5WritePlan()
  const g5Read = await mcpToolsCall(baseUrl, 'get_g5', { boardId }, root.bearer)
  stepsLog.push({
    step: 'g5_write',
    ok: false,
    supported: false,
    code: g5plan.code,
    readOk: g5Read.ok && !g5Read.isError,
    message: g5plan.message,
  })
  residual_gaps.push('g5_durable_write_unsupported')

  // 6) Reconciler dry → apply hash bind (best-effort; leadership may block)
  try {
    const pinR = await probeLivePin(baseUrl, root.bearer, {
      validateHealthzPinShape: adapter.validateHealthzPinShape,
    })
    if (pinR.ok) {
      livePin = {
        ...livePin,
        boardRev: pinR.boardRev ?? livePin.boardRev,
        lifecycleRev: pinR.lifecycleRev ?? livePin.lifecycleRev,
        canonicalHash: pinR.canonicalHash || livePin.canonicalHash,
      }
    }
    const reconKey = adapter.buildIdempotencyKey({
      expectedSha: pinProbe.deployedSha || 'nosha',
      packHash,
      step: 'reconcile_dry_run',
    })
    const reconEnv = adapter.buildMutationEnvelopeSkeleton(livePin, reconKey)
    const dryRec = await mcpToolsCall(
      baseUrl,
      'reconcile_dry_run',
      {
        boardId,
        maxActions: 100,
        entityExpectedRev: reconEnv.entityExpectedRev,
        expectedBoardRev: reconEnv.expectedBoardRev,
        subjectHash: reconEnv.subjectHash,
        canonicalHash: reconEnv.canonicalHash,
        idempotencyKey: reconEnv.idempotencyKey,
      },
      root.bearer,
    )
    const dryRunHash =
      dryRec.toolJson?.dryRunHash || dryRec.toolJson?.hash || dryRec.toolJson?.data?.dryRunHash
    stepsLog.push({
      step: 'reconcile_dry_run',
      ok: dryRec.ok && !dryRec.isError && Boolean(dryRunHash),
      hasHash: Boolean(dryRunHash),
      code: dryRec.toolJson?.code || null,
    })
    if (dryRunHash) {
      const pinR2 = await probeLivePin(baseUrl, root.bearer, {
        validateHealthzPinShape: adapter.validateHealthzPinShape,
      })
      if (pinR2.ok) {
        livePin = {
          ...livePin,
          boardRev: pinR2.boardRev ?? livePin.boardRev,
          canonicalHash: pinR2.canonicalHash || livePin.canonicalHash,
        }
      }
      const applyRecKey = adapter.buildIdempotencyKey({
        expectedSha: pinProbe.deployedSha || 'nosha',
        packHash,
        step: 'reconcile_apply',
      })
      const applyRecEnv = adapter.buildMutationEnvelopeSkeleton(livePin, applyRecKey)
      const bind = adapter.reconcileDryApplyBinding(
        { dryRunHash },
        { dryRunHash },
      )
      const applyRec = await mcpToolsCall(
        baseUrl,
        'reconcile_apply',
        {
          boardId,
          dryRunHash,
          entityExpectedRev: applyRecEnv.entityExpectedRev,
          expectedBoardRev: applyRecEnv.expectedBoardRev,
          subjectHash: applyRecEnv.subjectHash,
          canonicalHash: applyRecEnv.canonicalHash,
          idempotencyKey: applyRecEnv.idempotencyKey,
        },
        root.bearer,
      )
      stepsLog.push({
        step: 'reconcile_apply',
        ok: applyRec.ok && !applyRec.isError,
        bindOk: bind.ok,
        code: applyRec.toolJson?.code || null,
      })
    } else {
      residual_gaps.push('reconciler_dry_hash_missing')
    }
  } catch (e) {
    stepsLog.push({
      step: 'reconciler_error',
      ok: false,
      message: String(e?.message || e),
    })
    residual_gaps.push('reconciler_exception')
  }

  // 7) Cleanup audit structure (plan-level; executor may be partial on staging)
  const cleanupPlan = adapter.buildPrefixCleanupPlan({ boardId })
  const audit = adapter.buildCleanupAuditReadback(beforeSnap, afterSnap)
  stepsLog.push({
    step: 'cleanup_audit_structure',
    ok: audit.nonPrefixPreserved,
    nonPrefixPreserved: audit.nonPrefixPreserved,
    cleanupSteps: cleanupPlan.steps.length,
    note: 'Prefix cleanup execution is operator-gated; structure+proof emitted',
  })

  const criticalOk = applyOk && proofPost.ok
  return {
    ok: criticalOk,
    mode: 'apply-execute',
    code: criticalOk ? 'GATES_APPLY_EXECUTED' : 'GATES_APPLY_PARTIAL',
    stagingMutation: true,
    boardId,
    livePin: {
      boardRev: livePin.boardRev,
      lifecycleRev: livePin.lifecycleRev,
      deployedSha: pinProbe.deployedSha,
    },
    lifecycleOk,
    g5: { supported: false, code: g5plan.code },
    additiveProofPost: proofPost,
    stepsLog,
    residual_gaps: residual_gaps.length
      ? residual_gaps
      : criticalOk
        ? ['g5_durable_write_unsupported']
        : residual_gaps,
    refuse: {
      seedSynthetic: true,
      rawSqlWipe: true,
      fabricateStageReceipts: true,
      fabricateG5Pass: true,
    },
  }
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  if (args.help) {
    printHelp()
    process.exit(0)
  }

  const adapter = await loadAdapter()
  const target = ownerTargetLine(args)
  console.log(`OWNER_TARGET: ${JSON.stringify(target)}`)

  if (args.plan) {
    const plan = adapter.buildApplyStepPlan({
      expectedSha: process.env.EXPECTED_SHA || undefined,
    })
    const payload = {
      ok: true,
      mode: 'plan',
      stagingMutation: false,
      plan,
      residual_gaps: plan.residual_gaps,
    }
    const receipt = writeReceipt(payload)
    console.log(JSON.stringify({ ...payload, receipt }, null, 2))
    process.exit(0)
  }

  if (args.apply) {
    const gate = adapter.checkApplyGates(process.env)
    if (!gate.ok) {
      const payload = {
        ok: false,
        mode: 'apply-refused',
        code: gate.code || 'CAIRN_GATES_APPLY_REFUSED',
        message: gate.message,
        missing: gate.missing,
        stagingMutation: false,
        residual_gaps: ['gates_not_satisfied'],
      }
      const receipt = writeReceipt(payload)
      console.log(JSON.stringify({ ...payload, receipt }, null, 2))
      process.exit(3)
    }

    if (process.env.CAIRN_GATES_EXECUTE !== '1') {
      const plan = adapter.buildApplyStepPlan({
        expectedSha: process.env.EXPECTED_SHA || undefined,
      })
      const payload = {
        ok: true,
        mode: 'apply-plan',
        code: 'GATES_APPLY_PLAN',
        stagingMutation: false,
        message:
          'Gates + live-pin bind OK. Default non-mutating plan. Set CAIRN_GATES_EXECUTE=1 for authenticated MCP execute.',
        plan,
        residual_gaps: plan.residual_gaps,
        fromSeedGates: args.fromSeedGates,
      }
      const receipt = writeReceipt(payload)
      console.log(JSON.stringify({ ...payload, receipt }, null, 2))
      process.exit(0)
    }

    const result = await executeLiveApply(adapter, process.env)
    const receipt = writeReceipt(result)
    console.log(JSON.stringify({ ...result, receipt }, null, 2))
    process.exit(result.ok ? 0 : 1)
  }

  // self-test
  const self = adapter.runApplyAdapterSelfTests()
  const payload = {
    ok: self.ok,
    mode: 'self-test',
    stagingMutation: false,
    adapterId: self.adapterId,
    checkCount: self.checkCount,
    passCount: self.passCount,
    failures: self.failures,
    residual_gaps: self.ok
      ? ['live_staging_not_exercised_self_test_only']
      : ['adapter_self_test_failed'],
  }
  const receipt = writeReceipt(payload)
  console.log(JSON.stringify({ ...payload, receipt }, null, 2))
  process.exit(payload.ok ? 0 : 1)
}

main().catch((e) => {
  console.error(
    JSON.stringify({
      ok: false,
      error: String(e?.message || e),
      code: e?.code ?? 'STAGING_GATES_APPLY_FATAL',
    }),
  )
  process.exit(2)
})
